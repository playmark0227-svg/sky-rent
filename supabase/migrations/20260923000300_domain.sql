-- =====================================================================
-- 業務ロジック (RPC / トリガー)
--
--   公開 (anon 可)        : public_catalog, public_busy_ranges
--   Edge Function 専用     : create_reservation_tx, cancel_reservation_tx,
--   (service_role のみ)      get_reservation_for_guest, submit_inquiry_tx,
--                            member_close_account, hit_rate_limit,
--                            outbox_claim, outbox_mark
--   会員                   : member_update_profile
--   スタッフ (AAL2 + 権限) : admin_* 関数
--
-- エラーは message にコード文字列を入れて raise する (Edge Function / 画面側で日本語化)
--   AVAILABILITY_CONFLICT / IDEMPOTENCY_KEY_REUSED / COUPON_INVALID / FORBIDDEN / ...
-- =====================================================================

-- ---------------------------------------------------------------------
-- 共通: エラー送出
-- ---------------------------------------------------------------------
create or replace function public.fail(p_code text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end $$;

create or replace function public.require_perm(p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_perm(p_perm) then
    perform public.fail('FORBIDDEN', p_perm);
  end if;
end $$;

create or replace function public.setting(p_key text, p_default jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select value from public.app_settings where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------------
-- 監査ログ (トリガー)。連絡先は差分に残さない
-- ---------------------------------------------------------------------
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_diff jsonb := '{}'::jsonb;
  k text;
  v_id text;
  masked text[] := array['email', 'phone', 'customer_email', 'customer_phone', 'tel',
                         'guest_token_hash', 'request_hash', 'idempotency_key', 'body'];
begin
  if current_setting('skyrent.internal', true) = 'gcal' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if k not in ('updated_at', 'version', 'start_at', 'end_at')
         and (v_old -> k) is distinct from (v_new -> k) then
        v_diff := v_diff || jsonb_build_object(k, case when k = any (masked) then to_jsonb('***'::text) else v_new -> k end);
      end if;
    end loop;
    if v_diff = '{}'::jsonb then return new; end if;
  elsif tg_op = 'INSERT' then
    v_diff := v_new;
    foreach k in array masked loop v_diff := v_diff - k; end loop;
  else
    v_diff := jsonb_build_object('deleted', true);
  end if;

  v_id := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'user_id', v_old ->> 'user_id',
                   v_new ->> 'key', v_old ->> 'key',
                   (v_new ->> 'collection') || '/' || (v_new ->> 'id'));

  insert into public.audit_log (actor, actor_role, action, table_name, row_id, diff)
  values (auth.uid(), coalesce(public.staff_role(), auth.role(), 'system'),
          lower(tg_op), tg_table_name, v_id, v_diff);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['locations', 'categories', 'assets', 'options', 'app_settings',
                           'app_collections', 'members', 'staff', 'invoices', 'reservations',
                           'coupons', 'point_ledger', 'inquiries', 'legal_documents']
  loop
    execute format('create trigger %I_audit after insert or update or delete on public.%I
                    for each row execute function public.audit_row()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 公開: カタログ (個人情報・管理用項目を含まない)
-- ---------------------------------------------------------------------
create or replace function public.public_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort, c.id)
                            from public.categories c where c.active), '[]'::jsonb),
    'locations',  coalesce((select jsonb_agg(to_jsonb(l) order by l.sort, l.id)
                            from public.locations l where l.active), '[]'::jsonb),
    'assets',     coalesce((select jsonb_agg(to_jsonb(a) - 'plate' - 'shaken_date' - 'maintenance_date' - 'extra'
                                             order by a.sort, a.id)
                            from public.assets a
                            join public.categories c on c.id = a.category_id and c.active
                            where a.active), '[]'::jsonb),
    'options',    coalesce((select jsonb_agg(to_jsonb(o) - 'extra' order by o.sort, o.id)
                            from public.options o where o.active), '[]'::jsonb),
    'settings',   coalesce((select jsonb_object_agg(s.key, s.value)
                            from public.app_settings s where public.is_public_setting(s.key)), '{}'::jsonb),
    'collections', coalesce((select jsonb_object_agg(x.collection, x.items) from (
                              select ac.collection, jsonb_agg(ac.data order by ac.sort, ac.id) as items
                              from public.app_collections ac
                              where public.is_public_collection(ac.collection)
                              group by ac.collection) x), '{}'::jsonb),
    'legal',      coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'version', d.version, 'title', d.title,
                                                                'url', d.url, 'effectiveAt', d.effective_at) order by d.id)
                            from public.legal_documents d where d.active), '[]'::jsonb),
    'serverTime', to_jsonb(now())
  )
$$;

-- 公開: 空き状況の判定に使う「埋まっている時間帯」だけを返す (誰の予約かは返さない)
create or replace function public.public_busy_ranges(p_from timestamptz, p_to timestamptz)
returns table (asset_id text, start_at timestamptz, end_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to <= p_from then
    perform public.fail('INVALID_RANGE');
  end if;
  if p_to - p_from > interval '400 days' then
    perform public.fail('RANGE_TOO_LONG');
  end if;
  return query
    select r.asset_id, r.start_at, r.end_at
    from public.reservations r
    where r.status in ('confirmed', 'in_use')
      and r.period && tstzrange(p_from, p_to, '[)')
    order by r.asset_id, r.start_at;
end $$;

-- ---------------------------------------------------------------------
-- ポイント・クーポン
-- ---------------------------------------------------------------------
create or replace function public.member_point_balance(p_user uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(delta), 0)::int from public.point_ledger where user_id = p_user
$$;

-- しきい値に達していればクーポンを発行し、ポイントを消費する
create or replace function public.issue_coupons_if_needed(p_user uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  cfg jsonb := public.setting('points', '{"pointPerUse":1,"couponThreshold":10,"couponAmount":1000,"expiryMonths":12}');
  v_threshold int := greatest(1, coalesce((cfg ->> 'couponThreshold')::int, 10));
  v_amount int := greatest(1, coalesce((cfg ->> 'couponAmount')::int, 1000));
  v_issued int := 0;
  v_coupon uuid;
  v_email text;
  v_name text;
begin
  -- 同じ会員への同時発行を直列化
  perform 1 from public.members where user_id = p_user for update;
  select email, name into v_email, v_name from public.members where user_id = p_user;
  while public.member_point_balance(p_user) >= v_threshold loop
    insert into public.point_ledger (user_id, delta, reason)
      values (p_user, -v_threshold, 'クーポン (¥' || to_char(v_amount, 'FM999,999,999') || ') に交換');
    insert into public.coupons (user_id, amount, reason)
      values (p_user, v_amount, 'ポイント' || v_threshold || 'pt 到達特典')
      returning id into v_coupon;
    if coalesce(v_email, '') <> '' then
      insert into public.outbox (template, to_email, payload, ref_type, ref_id)
      values ('coupon_issued', v_email,
              jsonb_build_object('name', v_name, 'amount', v_amount, 'threshold', v_threshold),
              'coupon', v_coupon::text);
    end if;
    v_issued := v_issued + 1;
  end loop;
  return v_issued;
end $$;

-- 返却でポイント付与 (BEFORE で付与済みフラグ、AFTER で台帳へ)
create or replace function public.reservations_before_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'returned' and old.status is distinct from 'returned'
     and new.user_id is not null and not new.point_granted and new.kind = 'rental' then
    new.point_granted := true;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;
  return new;
end $$;
create trigger reservations_before_status before update of status on public.reservations
  for each row execute function public.reservations_before_status();

create or replace function public.reservations_after_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cfg jsonb := public.setting('points', '{"pointPerUse":1}');
  v_pt int := greatest(0, coalesce((cfg ->> 'pointPerUse')::int, 1));
begin
  if new.status = 'returned' and old.status is distinct from 'returned'
     and new.user_id is not null and new.point_granted and not old.point_granted then
    if v_pt > 0 then
      insert into public.point_ledger (user_id, delta, reason, reservation_id)
        values (new.user_id, v_pt, '予約 ' || new.id || ' ご返却', new.id)
        on conflict do nothing;
    end if;
    update public.members set last_use_at = now() where user_id = new.user_id;
    perform public.issue_coupons_if_needed(new.user_id);
  end if;
  -- 取消時は使用したクーポンを戻す
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.coupon_id is not null then
    update public.coupons set used_at = null, used_reservation_id = null
      where id = new.coupon_id and used_reservation_id = new.id;
  end if;
  return new;
end $$;
create trigger reservations_after_status after update of status on public.reservations
  for each row execute function public.reservations_after_status();

-- 最終利用から expiryMonths ヶ月でポイント失効 (日次ジョブから呼ぶ)
create or replace function public.expire_points() returns int
language plpgsql security definer set search_path = '' as $$
declare
  cfg jsonb := public.setting('points', '{"expiryMonths":12}');
  v_months int := greatest(1, coalesce((cfg ->> 'expiryMonths')::int, 12));
  r record;
  n int := 0;
begin
  for r in
    select m.user_id, public.member_point_balance(m.user_id) as bal
    from public.members m
    where m.last_use_at is not null
      and m.last_use_at < now() - make_interval(months => v_months)
  loop
    if r.bal > 0 then
      insert into public.point_ledger (user_id, delta, reason)
        values (r.user_id, -r.bal, '有効期限切れによる失効');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 予約の確定 (Edge Function から service_role で呼ぶ)
--   p: {
--     idempotency_key, request_hash, asset_id, start_at, end_at, user_id?,
--     customer: {name, kana, email, phone, company}, payment_method, license_confirmed,
--     option_ids[], options[], price{...}, total, discount_type?, coupon_id?, coupon_amount?,
--     note, consent{...}, guest_token_hash, emails:[{template,to,payload}]
--   }
--   料金は Edge Function が料金ルールから計算した値。ここでは在庫・資格・クーポンを
--   ロックして検証し、1トランザクションで保存する。
-- ---------------------------------------------------------------------
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

-- ゲスト照会 (予約番号 + 照会キー) / 会員本人
create or replace function public.get_reservation_for_guest(p_id text, p_token_hash text, p_user uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.reservations;
begin
  select * into v from public.reservations
   where id = p_id and kind = 'rental'
     and ((p_token_hash is not null and guest_token_hash = p_token_hash)
          or (p_user is not null and user_id = p_user));
  if not found then perform public.fail('NOT_FOUND'); end if;
  return to_jsonb(v) - 'guest_token_hash' - 'request_hash' - 'idempotency_key' - 'staff_note' - 'created_by';
end $$;

-- お客様によるキャンセル。キャンセル料は Edge Function が料金ルールから計算して渡す
create or replace function public.cancel_reservation_tx(
  p_id text, p_token_hash text, p_user uuid, p_fee int, p_emails jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.reservations; e jsonb;
begin
  select * into v from public.reservations
   where id = p_id and kind = 'rental'
     and ((p_token_hash is not null and guest_token_hash = p_token_hash)
          or (p_user is not null and user_id = p_user))
   for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if v.status <> 'confirmed' then perform public.fail('NOT_CANCELLABLE', v.status); end if;
  if v.start_at <= now() then perform public.fail('NOT_CANCELLABLE', 'started'); end if;

  update public.reservations
     set status = 'cancelled', cancel_fee = greatest(0, coalesce(p_fee, 0)),
         cancelled_at = now(), cancelled_by = 'customer'
   where id = p_id
   returning * into v;

  for e in select * from jsonb_array_elements(coalesce(p_emails, '[]'::jsonb)) loop
    if coalesce(e ->> 'to', '') <> '' then
      insert into public.outbox (template, to_email, payload, ref_type, ref_id)
      values (e ->> 'template', e ->> 'to', coalesce(e -> 'payload', '{}'::jsonb), 'reservation', v.id);
    end if;
  end loop;
  return to_jsonb(v) - 'guest_token_hash' - 'request_hash' - 'idempotency_key' - 'staff_note' - 'created_by';
end $$;

-- ---------------------------------------------------------------------
-- 問い合わせ受付 (Edge Function から)
-- ---------------------------------------------------------------------
create or replace function public.submit_inquiry_tx(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.inquiries; e jsonb;
begin
  select * into v from public.inquiries where idempotency_key = p ->> 'idempotency_key';
  if found then return jsonb_build_object('replay', true, 'id', v.id); end if;

  insert into public.inquiries (name, company, email, tel, topic, body, reservation_id, user_id, consent, idempotency_key)
  values (p ->> 'name', coalesce(p ->> 'company', ''), p ->> 'email', coalesce(p ->> 'tel', ''),
          p ->> 'topic', p ->> 'body', nullif(p ->> 'reservation_id', ''),
          nullif(p ->> 'user_id', '')::uuid, coalesce(p -> 'consent', '{}'::jsonb),
          nullif(p ->> 'idempotency_key', ''))
  returning * into v;

  for e in select * from jsonb_array_elements(coalesce(p -> 'emails', '[]'::jsonb)) loop
    if coalesce(e ->> 'to', '') <> '' then
      insert into public.outbox (template, to_email, payload, ref_type, ref_id)
      values (e ->> 'template', e ->> 'to',
              coalesce(e -> 'payload', '{}'::jsonb) || jsonb_build_object('inquiry_id', v.id),
              'inquiry', v.id);
    end if;
  end loop;
  return jsonb_build_object('replay', false, 'id', v.id);
end $$;

-- ---------------------------------------------------------------------
-- 会員本人
-- ---------------------------------------------------------------------
create or replace function public.member_update_profile(p_patch jsonb) returns public.members
language plpgsql security definer set search_path = '' as $$
declare v public.members;
begin
  if auth.uid() is null then perform public.fail('UNAUTHENTICATED'); end if;
  update public.members m set
    name             = coalesce(left(p_patch ->> 'name', 100), m.name),
    name_kana        = coalesce(left(p_patch ->> 'name_kana', 100), m.name_kana),
    phone            = coalesce(left(p_patch ->> 'phone', 30), m.phone),
    company          = coalesce(left(p_patch ->> 'company', 200), m.company),
    marketing_opt_in = coalesce((p_patch ->> 'marketing_opt_in')::boolean, m.marketing_opt_in)
  where m.user_id = auth.uid() and m.status = 'active'
  returning * into v;
  if not found then perform public.fail('NOT_FOUND'); end if;
  return v;
end $$;

-- 退会: 連絡先を消して closed にする (予約・請求の記録は業務上保持)
create or replace function public.member_close_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.members set
    name = '退会済み会員', name_kana = '', phone = '', company = '', email = '',
    marketing_opt_in = false, status = 'closed'
  where user_id = p_user;
  delete from public.coupons where user_id = p_user and used_at is null;
end $$;

-- ---------------------------------------------------------------------
-- スタッフ操作
-- ---------------------------------------------------------------------
-- 予約の更新 (状態遷移・連絡先・メモ・日時/車両変更・入金状態)
--   p_version が現在の version と違えば VERSION_CONFLICT (他の人が先に更新した)
create or replace function public.admin_update_reservation(p_id text, p_patch jsonb, p_version int default null)
returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v public.reservations;
  v_new_status text := p_patch ->> 'status';
  v_only_payment boolean;
  v_start timestamptz;
  v_end timestamptz;
  v_asset public.assets;
begin
  select * into v from public.reservations where id = p_id for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if not public.staff_can_location(v.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  if p_version is not null and p_version <> v.version then perform public.fail('VERSION_CONFLICT'); end if;

  v_only_payment := (select coalesce(bool_and(k = 'payment_status'), false) from jsonb_object_keys(p_patch) k);
  if v_only_payment then
    if not (public.has_perm('payments.write') or public.has_perm('reservations.write')) then
      perform public.fail('FORBIDDEN', 'payments.write');
    end if;
  elsif v.kind = 'block' then
    perform public.require_perm('blocks.write');
  else
    perform public.require_perm('reservations.write');
  end if;

  if v_new_status is not null and v_new_status <> v.status then
    if not (
      (v.status = 'confirmed' and v_new_status in ('in_use', 'cancelled', 'no_show')) or
      (v.status = 'in_use'    and v_new_status in ('returned', 'confirmed')) or
      (v.status = 'no_show'   and v_new_status in ('confirmed', 'cancelled')) or
      (v.status = 'cancelled' and v_new_status = 'confirmed' and public.has_perm('settings.write'))
    ) then
      perform public.fail('INVALID_TRANSITION', v.status || '->' || v_new_status);
    end if;
  end if;

  v_start := coalesce((p_patch ->> 'start')::timestamptz, v.start_at);
  v_end   := coalesce((p_patch ->> 'end')::timestamptz, v.end_at);
  if v_end <= v_start then perform public.fail('INVALID_PERIOD'); end if;
  if p_patch ? 'asset_id' and p_patch ->> 'asset_id' <> v.asset_id then
    select * into v_asset from public.assets where id = p_patch ->> 'asset_id';
    if not found then perform public.fail('ASSET_UNAVAILABLE'); end if;
  else
    select * into v_asset from public.assets where id = v.asset_id;
  end if;

  begin
    update public.reservations r set
      status         = coalesce(v_new_status, r.status),
      payment_status = coalesce(p_patch ->> 'payment_status', r.payment_status),
      period         = tstzrange(v_start, v_end, '[)'),
      asset_id       = v_asset.id,
      category_id    = v_asset.category_id,
      location_id    = v_asset.location_id,
      customer_name  = coalesce(left(p_patch ->> 'customer_name', 100), r.customer_name),
      customer_kana  = coalesce(left(p_patch ->> 'customer_kana', 100), r.customer_kana),
      customer_email = coalesce(left(p_patch ->> 'customer_email', 254), r.customer_email),
      customer_phone = coalesce(left(p_patch ->> 'customer_phone', 30), r.customer_phone),
      company        = coalesce(left(p_patch ->> 'company', 200), r.company),
      note           = coalesce(left(p_patch ->> 'note', 2000), r.note),
      staff_note     = coalesce(left(p_patch ->> 'staff_note', 4000), r.staff_note),
      total          = coalesce((p_patch ->> 'total')::int, r.total),
      price          = coalesce(p_patch -> 'price', r.price),
      cancel_fee     = case when v_new_status = 'cancelled' then coalesce((p_patch ->> 'cancel_fee')::int, r.cancel_fee, 0)
                            else coalesce((p_patch ->> 'cancel_fee')::int, r.cancel_fee) end,
      cancelled_by   = case when v_new_status = 'cancelled' then 'staff' else r.cancelled_by end,
      cancelled_at   = case when v_new_status = 'confirmed' then null else r.cancelled_at end
    where r.id = p_id
    returning * into v;
  exception when exclusion_violation then
    perform public.fail('AVAILABILITY_CONFLICT');
  end;

  if v_new_status = 'cancelled' and v.kind = 'rental' and coalesce((p_patch ->> 'notify')::boolean, true)
     and v.customer_email <> '' then
    insert into public.outbox (template, to_email, payload, ref_type, ref_id)
    values ('reservation_cancelled', v.customer_email,
            jsonb_build_object('reservation_id', v.id, 'name', v.customer_name, 'cancel_fee', v.cancel_fee,
                               'by', 'staff', 'start_at', v.start_at, 'end_at', v.end_at, 'asset_id', v.asset_id),
            'reservation', v.id);
  end if;
  return v;
end $$;

-- スタッフによる予約登録 (電話・来店) / 整備・車検などの貸出停止枠
create or replace function public.admin_create_reservation(p jsonb) returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v public.reservations;
  v_asset public.assets;
  v_kind text := coalesce(p ->> 'kind', 'rental');
  v_start timestamptz := (p ->> 'start_at')::timestamptz;
  v_end timestamptz := (p ->> 'end_at')::timestamptz;
begin
  if v_kind = 'block' then perform public.require_perm('blocks.write');
  else perform public.require_perm('reservations.write'); end if;

  select * into v_asset from public.assets where id = p ->> 'asset_id';
  if not found then perform public.fail('ASSET_UNAVAILABLE'); end if;
  if not public.staff_can_location(v_asset.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  if v_start is null or v_end is null or v_end <= v_start then perform public.fail('INVALID_PERIOD'); end if;

  begin
    insert into public.reservations (
      kind, asset_id, category_id, location_id, period, status, user_id,
      customer_name, customer_kana, customer_email, customer_phone, company,
      license_confirmed, payment_method, option_ids, options, price, total, note, staff_note,
      source, created_by)
    values (
      v_kind, v_asset.id, v_asset.category_id, v_asset.location_id, tstzrange(v_start, v_end, '[)'),
      'confirmed', nullif(p ->> 'user_id', '')::uuid,
      coalesce(p ->> 'customer_name', ''), coalesce(p ->> 'customer_kana', ''),
      coalesce(p ->> 'customer_email', ''), coalesce(p ->> 'customer_phone', ''), coalesce(p ->> 'company', ''),
      coalesce((p ->> 'license_confirmed')::boolean, false),
      coalesce(p ->> 'payment_method', 'onsite'),
      coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'option_ids', '[]'::jsonb))), '{}'),
      coalesce(p -> 'options', '[]'::jsonb), coalesce(p -> 'price', '{}'::jsonb),
      coalesce((p ->> 'total')::int, 0),
      coalesce(p ->> 'note', ''), coalesce(p ->> 'staff_note', ''),
      'staff', auth.uid())
    returning * into v;
  exception when exclusion_violation then
    perform public.fail('AVAILABILITY_CONFLICT');
  end;

  if v_kind = 'rental' and coalesce((p ->> 'notify')::boolean, false) and v.customer_email <> '' then
    insert into public.outbox (template, to_email, payload, ref_type, ref_id)
    values ('reservation_confirmed', v.customer_email,
            coalesce(p -> 'email_payload', '{}'::jsonb) || jsonb_build_object('reservation_id', v.id),
            'reservation', v.id);
  end if;
  return v;
end $$;

create or replace function public.admin_delete_block(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.reservations;
begin
  perform public.require_perm('blocks.write');
  select * into v from public.reservations where id = p_id and kind = 'block' for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if not public.staff_can_location(v.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  update public.reservations set status = 'cancelled', cancelled_by = 'staff' where id = p_id;
end $$;

create or replace function public.admin_update_member(p_user uuid, p_patch jsonb) returns public.members
language plpgsql security definer set search_path = '' as $$
declare v public.members;
begin
  perform public.require_perm('members.write');
  if p_patch ? 'invoice_allowed' then perform public.require_perm('invoices.write'); end if;
  update public.members m set
    name            = coalesce(left(p_patch ->> 'name', 100), m.name),
    name_kana       = coalesce(left(p_patch ->> 'name_kana', 100), m.name_kana),
    phone           = coalesce(left(p_patch ->> 'phone', 30), m.phone),
    company         = coalesce(left(p_patch ->> 'company', 200), m.company),
    is_corporate    = coalesce((p_patch ->> 'is_corporate')::boolean, m.is_corporate),
    invoice_allowed = coalesce((p_patch ->> 'invoice_allowed')::boolean, m.invoice_allowed)
  where m.user_id = p_user
  returning * into v;
  if not found then perform public.fail('NOT_FOUND'); end if;
  return v;
end $$;

create or replace function public.admin_adjust_points(p_user uuid, p_delta int, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_bal int;
begin
  perform public.require_perm('members.write');
  if p_delta = 0 then perform public.fail('INVALID_DELTA'); end if;
  perform 1 from public.members where user_id = p_user for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  v_bal := public.member_point_balance(p_user);
  if v_bal + p_delta < 0 then p_delta := -v_bal; end if;
  if p_delta <> 0 then
    insert into public.point_ledger (user_id, delta, reason, created_by)
      values (p_user, p_delta, left(coalesce(nullif(p_reason, ''), '管理者操作'), 200), auth.uid());
  end if;
  if p_delta > 0 then update public.members set last_use_at = now() where user_id = p_user; end if;
  perform public.issue_coupons_if_needed(p_user);
  return public.member_point_balance(p_user);
end $$;

create or replace function public.admin_issue_coupon(p_user uuid, p_amount int, p_reason text) returns public.coupons
language plpgsql security definer set search_path = '' as $$
declare v public.coupons; m public.members;
begin
  perform public.require_perm('members.write');
  if p_amount is null or p_amount <= 0 or p_amount > 100000 then perform public.fail('INVALID_AMOUNT'); end if;
  select * into m from public.members where user_id = p_user;
  if not found then perform public.fail('NOT_FOUND'); end if;
  insert into public.coupons (user_id, amount, reason, created_by)
    values (p_user, p_amount, left(coalesce(nullif(p_reason, ''), '管理者発行'), 200), auth.uid())
    returning * into v;
  if m.email <> '' then
    insert into public.outbox (template, to_email, payload, ref_type, ref_id)
    values ('coupon_issued', m.email, jsonb_build_object('name', m.name, 'amount', p_amount, 'reason', v.reason),
            'coupon', v.id::text);
  end if;
  return v;
end $$;

create or replace function public.admin_create_invoice(
  p_user uuid, p_reservation_ids text[], p_company text, p_address text, p_case_name text, p_due_date date)
returns public.invoices
language plpgsql security definer set search_path = '' as $$
declare
  v public.invoices;
  m public.members;
  v_amount int;
  v_count int;
begin
  perform public.require_perm('invoices.write');
  select * into m from public.members where user_id = p_user;
  if not found then perform public.fail('NOT_FOUND', 'member'); end if;
  if not m.invoice_allowed then perform public.fail('INVOICE_NOT_ALLOWED'); end if;
  if p_reservation_ids is null or cardinality(p_reservation_ids) = 0 then perform public.fail('NO_RESERVATIONS'); end if;

  -- 対象予約をロックし、この会員の・未請求・未取消のものだけであることを確認
  select count(*), coalesce(sum(total), 0) into v_count, v_amount
  from (select total from public.reservations
         where id = any (p_reservation_ids) and user_id = p_user and invoice_id is null
           and status not in ('cancelled') and kind = 'rental'
         for update) t;
  if v_count <> cardinality(p_reservation_ids) then perform public.fail('RESERVATIONS_NOT_INVOICEABLE'); end if;

  insert into public.invoices (user_id, company, address, case_name, reservation_ids, amount, due_date, created_by)
  values (p_user, coalesce(nullif(p_company, ''), m.company, m.name), coalesce(p_address, ''),
          coalesce(nullif(p_case_name, ''), 'レンタル料金 一式'), p_reservation_ids, v_amount,
          coalesce(p_due_date, (now() + interval '1 month')::date), auth.uid())
  returning * into v;
  update public.reservations set invoice_id = v.id where id = any (p_reservation_ids);
  return v;
end $$;

create or replace function public.admin_set_invoice_status(p_id text, p_status text) returns public.invoices
language plpgsql security definer set search_path = '' as $$
declare v public.invoices;
begin
  perform public.require_perm('invoices.write');
  if p_status not in ('unpaid', 'paid', 'void') then perform public.fail('INVALID_STATUS'); end if;
  update public.invoices
     set status = p_status, paid_at = case when p_status = 'paid' then coalesce(paid_at, now()) else null end
   where id = p_id
   returning * into v;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if p_status = 'void' then
    update public.reservations set invoice_id = null where invoice_id = p_id;
  else
    update public.reservations set payment_status = case when p_status = 'paid' then 'paid' else 'unpaid' end
     where invoice_id = p_id;
  end if;
  return v;
end $$;

create or replace function public.admin_update_inquiry(p_id text, p_patch jsonb) returns public.inquiries
language plpgsql security definer set search_path = '' as $$
declare v public.inquiries;
begin
  perform public.require_perm('inquiries.write');
  update public.inquiries i set
    status      = coalesce(p_patch ->> 'status', i.status),
    staff_note  = coalesce(left(p_patch ->> 'staff_note', 4000), i.staff_note),
    assigned_to = case when p_patch ? 'assigned_to' then nullif(p_patch ->> 'assigned_to', '')::uuid else i.assigned_to end
  where i.id = p_id
  returning * into v;
  if not found then perform public.fail('NOT_FOUND'); end if;
  return v;
end $$;

create or replace function public.admin_retry_outbox(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.has_perm('outbox.read') and (public.has_perm('reservations.write') or public.has_perm('settings.write'))) then
    perform public.fail('FORBIDDEN');
  end if;
  update public.outbox set status = 'pending', next_attempt_at = now(), last_error = null
   where id = p_id and status in ('failed', 'skipped');
end $$;

-- スタッフの役割・拠点・有効/無効 (最後の管理者は外せない)
create or replace function public.admin_update_staff(p_user uuid, p_patch jsonb) returns public.staff
language plpgsql security definer set search_path = '' as $$
declare v public.staff;
begin
  perform public.require_perm('staff.write');
  update public.staff s set
    name         = coalesce(left(p_patch ->> 'name', 100), s.name),
    role         = coalesce(p_patch ->> 'role', s.role),
    active       = coalesce((p_patch ->> 'active')::boolean, s.active),
    location_ids = case when p_patch ? 'location_ids'
                        then case when jsonb_typeof(p_patch -> 'location_ids') = 'array'
                                  then array(select jsonb_array_elements_text(p_patch -> 'location_ids'))
                                  else null end
                        else s.location_ids end
  where s.user_id = p_user
  returning * into v;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if not exists (select 1 from public.staff where role = 'admin' and active) then
    perform public.fail('LAST_ADMIN');
  end if;
  return v;
end $$;

-- 管理画面トップの「最近の動き」 (監査ログから日本語の一文を作る)
create or replace function public.admin_recent_activity(p_limit int default 50)
returns table (at timestamptz, type text, message text, ref_id text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_perm('read');
  return query
    select a.at,
      case a.table_name when 'reservations' then case when a.action = 'insert' then 'reservation' else 'status' end
                        when 'members' then 'member' when 'coupons' then 'coupon'
                        when 'invoices' then 'invoice' when 'inquiries' then 'inquiry' else a.table_name end,
      case
        when a.table_name = 'reservations' and a.action = 'insert' and a.diff ->> 'kind' = 'block'
          then '貸出停止枠 ' || a.row_id || ' を登録しました'
        when a.table_name = 'reservations' and a.action = 'insert'
          then '新規予約 ' || a.row_id || ' (' || coalesce(a.diff ->> 'customer_name', '') || ' 様) を受け付けました'
        when a.table_name = 'reservations' and a.diff ? 'status'
          then '予約 ' || a.row_id || ' の状態を「' ||
               case a.diff ->> 'status' when 'confirmed' then '確定' when 'in_use' then '貸出中'
                 when 'returned' then '返却済' when 'cancelled' then 'キャンセル' when 'no_show' then '無断キャンセル'
                 else a.diff ->> 'status' end || '」に変更しました'
        when a.table_name = 'members' and a.action = 'insert'
          then '新規会員登録: ' || coalesce(a.diff ->> 'name', '') || ' 様'
        when a.table_name = 'coupons' and a.action = 'insert'
          then '¥' || coalesce(a.diff ->> 'amount', '') || ' クーポンを発行しました'
        when a.table_name = 'invoices' and a.action = 'insert'
          then '請求書 ' || a.row_id || ' を発行しました'
        when a.table_name = 'inquiries' and a.action = 'insert'
          then 'お問い合わせ ' || a.row_id || ' を受け付けました'
        else null
      end,
      a.row_id
    from public.audit_log a
    where a.table_name in ('reservations', 'members', 'coupons', 'invoices', 'inquiries')
      and (a.action = 'insert' or (a.table_name = 'reservations' and a.diff ? 'status'))
      and (a.table_name <> 'reservations'
           or exists (select 1 from public.reservations r where r.id = a.row_id and public.staff_can_location(r.location_id)))
    order by a.at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end $$;

-- ---------------------------------------------------------------------
-- メール送信キュー (Edge Function のワーカーが使う)
-- ---------------------------------------------------------------------
create or replace function public.outbox_claim(p_limit int default 20) returns setof public.outbox
language plpgsql security definer set search_path = '' as $$
begin
  return query
    update public.outbox o set status = 'sending', attempts = o.attempts + 1
    where o.id in (
      select id from public.outbox
       where status in ('pending', 'failed') and next_attempt_at <= now() and attempts < 8
       order by id
       for update skip locked
       limit greatest(1, least(p_limit, 100)))
    returning o.*;
end $$;

create or replace function public.outbox_mark(
  p_id bigint, p_status text, p_error text default null, p_provider_id text default null,
  p_subject text default null, p_body text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.outbox set
    status = p_status,
    last_error = left(p_error, 1000),
    provider_message_id = coalesce(p_provider_id, provider_message_id),
    subject = coalesce(p_subject, subject),
    body_text = coalesce(p_body, body_text),
    sent_at = case when p_status = 'sent' then now() else sent_at end,
    -- 失敗は指数バックオフ (1, 2, 4, 8 ... 分)
    next_attempt_at = case when p_status = 'failed'
                           then now() + make_interval(mins => power(2, least(attempts, 10))::int)
                           else next_attempt_at end
  where id = p_id;
end $$;

-- 送信中のまま止まったもの (ワーカー異常終了) を戻す
create or replace function public.outbox_release_stuck() returns int
language sql security definer set search_path = '' as $$
  with x as (
    update public.outbox set status = 'failed', last_error = coalesce(last_error, '送信処理が中断されました')
     where status = 'sending' and next_attempt_at < now() - interval '10 minutes'
    returning 1)
  select count(*)::int from x
$$;

-- ---------------------------------------------------------------------
-- レート制限 (固定ウィンドウ)
-- ---------------------------------------------------------------------
create or replace function public.hit_rate_limit(p_bucket text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into public.rate_limits (bucket, window_start, hits) values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return v_hits <= p_limit;
end $$;

-- ---------------------------------------------------------------------
-- 実行権限
--   既定では関数は PUBLIC 実行可能なので、まず全部剥がしてから必要なものだけ付ける
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.public_catalog() to anon, authenticated;
grant execute on function public.public_busy_ranges(timestamptz, timestamptz) to anon, authenticated;

-- RLS ポリシーから呼ばれるヘルパー
grant execute on function public.jwt_aal() to anon, authenticated;
grant execute on function public.staff_role() to authenticated;
grant execute on function public.role_has_perm(text, text) to authenticated;
grant execute on function public.has_perm(text) to authenticated;
grant execute on function public.staff_can_location(text) to authenticated;
grant execute on function public.is_public_setting(text) to anon, authenticated;
grant execute on function public.is_public_collection(text) to anon, authenticated;
grant execute on function public.is_content_collection(text) to anon, authenticated;

grant execute on function public.member_update_profile(jsonb) to authenticated;

grant execute on function public.admin_update_reservation(text, jsonb, int) to authenticated;
grant execute on function public.admin_create_reservation(jsonb) to authenticated;
grant execute on function public.admin_delete_block(text) to authenticated;
grant execute on function public.admin_update_member(uuid, jsonb) to authenticated;
grant execute on function public.admin_adjust_points(uuid, int, text) to authenticated;
grant execute on function public.admin_issue_coupon(uuid, int, text) to authenticated;
grant execute on function public.admin_create_invoice(uuid, text[], text, text, text, date) to authenticated;
grant execute on function public.admin_set_invoice_status(text, text) to authenticated;
grant execute on function public.admin_update_inquiry(text, jsonb) to authenticated;
grant execute on function public.admin_retry_outbox(bigint) to authenticated;
grant execute on function public.admin_update_staff(uuid, jsonb) to authenticated;
grant execute on function public.admin_recent_activity(int) to authenticated;

-- 以下は service_role (Edge Function) 専用
grant execute on all functions in schema public to service_role;
