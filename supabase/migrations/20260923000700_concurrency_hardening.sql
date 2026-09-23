-- =====================================================================
-- 同時予約・送信キューの堅牢化
--   * create_reservation_tx: 車両ごとのアドバイザリロックで同時予約を直列化する。
--     排他制約 (GiST) の検査どうしが同時に走るとデッドロック (40P01) になることがあるため。
--     (API 側のやり直しは保険として残す)
--   * outbox_claim: 取り出した時刻を next_attempt_at に記録する。古い pending を取り出した直後に
--     outbox_release_stuck が「止まったジョブ」と誤判定しないようにするため。
-- =====================================================================

create or replace function public.create_reservation_tx(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key   text := p ->> 'idempotency_key';
  v_hash  text := p ->> 'request_hash';
  v_user  uuid := nullif(p ->> 'user_id', '')::uuid;
  v_start timestamptz := (p ->> 'start_at')::timestamptz;
  v_end   timestamptz := (p ->> 'end_at')::timestamptz;
  v_asset public.assets;
  v_res   public.reservations;
  v_prev  public.reservations;
  v_coupon_id uuid := nullif(p ->> 'coupon_id', '')::uuid;
  v_coupon public.coupons;
  v_opts  text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'option_ids', '[]'::jsonb))), '{}');
  v_bad   text;
  e jsonb;
begin
  if coalesce(length(v_key), 0) < 16 then perform public.fail('IDEMPOTENCY_KEY_REQUIRED'); end if;

  -- 同じキーで既に確定していれば、最初の結果を返す (二重送信対策)
  select * into v_prev from public.reservations where idempotency_key = v_key;
  if found then
    if v_prev.request_hash is distinct from v_hash then perform public.fail('IDEMPOTENCY_KEY_REUSED'); end if;
    return jsonb_build_object('replay', true, 'reservation', to_jsonb(v_prev) - 'guest_token_hash' - 'request_hash');
  end if;

  if v_start is null or v_end is null or v_end <= v_start then perform public.fail('INVALID_PERIOD'); end if;
  if v_start < now() - interval '10 minutes' then perform public.fail('START_IN_PAST'); end if;
  if v_end - v_start > interval '93 days' then perform public.fail('PERIOD_TOO_LONG'); end if;
  if v_start > now() + interval '400 days' then perform public.fail('START_TOO_FAR'); end if;

  -- 同じ車両への同時予約を直列化する (排他制約の検査どうしのデッドロックを防ぐ)
  perform pg_advisory_xact_lock(hashtext('asset:' || coalesce(p ->> 'asset_id', '')));
  select * into v_asset from public.assets where id = p ->> 'asset_id' for share;
  if not found or not v_asset.active then perform public.fail('ASSET_UNAVAILABLE'); end if;
  if not exists (select 1 from public.categories c where c.id = v_asset.category_id and c.active) then
    perform public.fail('ASSET_UNAVAILABLE');
  end if;

  -- オプションはこの車両のカテゴリで有効なものだけ
  select x into v_bad from unnest(v_opts) x
   where not exists (select 1 from public.options o
                      where o.id = x and o.active
                        and (o.category_ids is null or v_asset.category_id = any (o.category_ids)))
   limit 1;
  if v_bad is not null then perform public.fail('OPTION_INVALID', v_bad); end if;

  if v_user is not null and not exists (select 1 from public.members m where m.user_id = v_user and m.status = 'active') then
    perform public.fail('MEMBER_NOT_ACTIVE');
  end if;
  if coalesce(p ->> 'payment_method', 'onsite') = 'invoice'
     and not exists (select 1 from public.members m where m.user_id = v_user and m.invoice_allowed and m.status = 'active') then
    perform public.fail('INVOICE_NOT_ALLOWED');
  end if;

  if v_coupon_id is not null then
    select * into v_coupon from public.coupons where id = v_coupon_id for update;
    if not found or v_user is null or v_coupon.user_id <> v_user or v_coupon.used_at is not null
       or (v_coupon.expires_at is not null and v_coupon.expires_at < now())
       or v_coupon.amount <> coalesce((p ->> 'coupon_amount')::int, -1) then
      perform public.fail('COUPON_INVALID');
    end if;
  end if;

  -- 受け渡しの同時刻重複 (担当者は同時に2件の受け渡しができない)
  --   handover_minutes > 0 のとき、同じ拠点で貸出・返却の時刻が近すぎる予約があれば拒否。
  --   拠点ごとのアドバイザリロックで、同時に来た予約を直列化する。
  if coalesce((p ->> 'handover_minutes')::int, 0) > 0 then
    perform pg_advisory_xact_lock(hashtext('handover:' || v_asset.location_id));
    if exists (
      select 1 from public.reservations r
       where r.location_id = v_asset.location_id and r.kind = 'rental'
         and r.status in ('confirmed', 'in_use')
         and exists (
           select 1
             from unnest(array[r.start_at, r.end_at]) other_t,
                  unnest(array[v_start, v_end]) my_t
            where abs(extract(epoch from (other_t - my_t))) < (p ->> 'handover_minutes')::int * 60)
    ) then
      perform public.fail('HANDOVER_CONFLICT');
    end if;
  end if;

  begin
    insert into public.reservations (
      kind, asset_id, category_id, location_id, period, status, user_id,
      customer_name, customer_kana, customer_email, customer_phone, company,
      license_confirmed, payment_method, option_ids, options, price, total,
      discount_type, coupon_id, note, consent, guest_token_hash,
      idempotency_key, request_hash, source, created_by)
    values (
      'rental', v_asset.id, v_asset.category_id, v_asset.location_id,
      tstzrange(v_start, v_end, '[)'), 'confirmed', v_user,
      left(coalesce(p #>> '{customer,name}', ''), 100),
      left(coalesce(p #>> '{customer,kana}', ''), 100),
      left(coalesce(p #>> '{customer,email}', ''), 254),
      left(coalesce(p #>> '{customer,phone}', ''), 30),
      left(coalesce(p #>> '{customer,company}', ''), 200),
      coalesce((p ->> 'license_confirmed')::boolean, false),
      coalesce(p ->> 'payment_method', 'onsite'),
      v_opts, coalesce(p -> 'options', '[]'::jsonb), coalesce(p -> 'price', '{}'::jsonb),
      coalesce((p ->> 'total')::int, 0),
      nullif(p ->> 'discount_type', ''), v_coupon_id,
      left(coalesce(p ->> 'note', ''), 2000), coalesce(p -> 'consent', '{}'::jsonb),
      nullif(p ->> 'guest_token_hash', ''), v_key, v_hash, 'web', v_user)
    returning * into v_res;
  exception
    when exclusion_violation then
      perform public.fail('AVAILABILITY_CONFLICT');
    when unique_violation then
      -- 同じキーの同時送信
      select * into v_prev from public.reservations where idempotency_key = v_key;
      if found and v_prev.request_hash is not distinct from v_hash then
        return jsonb_build_object('replay', true, 'reservation', to_jsonb(v_prev) - 'guest_token_hash' - 'request_hash');
      end if;
      perform public.fail('IDEMPOTENCY_KEY_REUSED');
  end;

  if v_coupon_id is not null then
    update public.coupons set used_at = now(), used_reservation_id = v_res.id where id = v_coupon_id;
  end if;

  for e in select * from jsonb_array_elements(coalesce(p -> 'emails', '[]'::jsonb)) loop
    if coalesce(e ->> 'to', '') <> '' then
      insert into public.outbox (template, to_email, payload, ref_type, ref_id)
      values (e ->> 'template', e ->> 'to',
              coalesce(e -> 'payload', '{}'::jsonb) || jsonb_build_object('reservation_id', v_res.id),
              'reservation', v_res.id);
    end if;
  end loop;

  return jsonb_build_object('replay', false, 'reservation', to_jsonb(v_res) - 'guest_token_hash' - 'request_hash');
end $$;

create or replace function public.outbox_claim(p_limit int default 20) returns setof public.outbox
language plpgsql security definer set search_path = '' as $$
begin
  return query
    update public.outbox o set status = 'sending', attempts = o.attempts + 1, next_attempt_at = now()
    where o.id in (
      select id from public.outbox
       where status in ('pending', 'failed') and next_attempt_at <= now() and attempts < 8
       order by id
       for update skip locked
       limit greatest(1, least(p_limit, 100)))
    returning o.*;
end $$;

revoke execute on function public.create_reservation_tx(jsonb) from public, anon, authenticated;
revoke execute on function public.outbox_claim(int) from public, anon, authenticated;
grant execute on function public.create_reservation_tx(jsonb) to service_role;
grant execute on function public.outbox_claim(int) to service_role;
