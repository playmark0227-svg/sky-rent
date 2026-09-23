-- =====================================================================
-- セキュリティ修正: 拠点限定スタッフの封じ込め
--
-- db-1  admin_update_reservation で車両を付け替えるとき、付け替え先の車両の拠点を
--       検査していなかった。拠点限定スタッフが自拠点の予約を他拠点の車両へ移し、
--       他拠点の車両を任意の期間押さえられた (他拠点の予約を妨害できた)。
--       → 付け替え先の拠点も担当範囲であることを必須にする。
--
-- db-3  予約だけが拠点で絞られ、会員・請求・問い合わせ (と、それに連なるポイント・
--       クーポン・メール送信記録・最近の動き) は全拠点ぶん読めた。他拠点だけで
--       取引した顧客の氏名・連絡先・住所が、拠点限定スタッフに見えていた。
--       → 顧客データを「どの拠点の顧客か」で絞る。
--
-- 顧客データの拠点の決め方 (全拠点スタッフ = location_ids が null は、これまでどおり全件)
--   会員        : その会員の予約 (貸出) の拠点。担当拠点で1件でも取引があれば見える。
--                 どの拠点とも取引がない会員 (登録直後など) は拠点に属さないので全スタッフに見える
--                 (電話予約で会員を選ぶ・招待直後に設定するため)。
--   ポイント・クーポン : 持ち主の会員と同じ
--   請求書      : 対象予約の拠点。担当拠点の予約を1件でも含めば見える。
--                 発行・状態変更は、対象予約がすべて担当拠点のときだけ。
--   問い合わせ  : 1. 実在する予約番号が書かれていれば、その予約の拠点
--                 2. 会員からなら、その会員と同じ
--                 3. それ以外は、同じメールアドレスのゲスト予約の拠点
--                 どれにも当たらない一般の問い合わせは拠点に属さないので全スタッフに見える。
--   メール送信記録 : 元になった予約・問い合わせ・クーポンと同じ (元が消えていれば全拠点スタッフだけ)
--
-- 書き込み RPC (会員の編集・ポイント・クーポン・請求書・問い合わせ・再送・予約への会員の紐付け) にも
-- 同じ検査を入れ、見えない顧客は FORBIDDEN (detail = location) にする。
-- =====================================================================

-- ---------------------------------------------------------------------
-- ヘルパー (RLS ポリシーと RPC から使う)
--   どれも「AAL2 で有効なスタッフ」でなければ false。
--   任意の値を渡して顧客の有無を探れないよう、問い合わせ・送信記録は行の ID だけを受け取る。
-- ---------------------------------------------------------------------

-- 全拠点を担当するスタッフか (location_ids が null)
create or replace function public.staff_all_locations() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active
      and public.jwt_aal() = 'aal2'
      and s.location_ids is null
  )
$$;

-- 会員 (と、その会員のポイント・クーポン) を扱えるか
create or replace function public.staff_can_member(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active
      and public.jwt_aal() = 'aal2'
      and (
        s.location_ids is null
        -- 担当拠点で取引がある
        or exists (select 1 from public.reservations r
                    where r.user_id = p_user and r.kind = 'rental'
                      and r.location_id = any (s.location_ids))
        -- どの拠点とも取引がない (拠点に属さない)
        or not exists (select 1 from public.reservations r
                        where r.user_id = p_user and r.kind = 'rental')
      )
  )
$$;

-- 請求書を読めるか (対象予約のどれかが担当拠点)
create or replace function public.staff_can_invoice(p_reservation_ids text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active
      and public.jwt_aal() = 'aal2'
      and (
        s.location_ids is null
        or exists (select 1 from public.reservations r
                    where r.id = any (p_reservation_ids)
                      and r.location_id = any (s.location_ids))
      )
  )
$$;

-- 予約の一覧がすべて担当拠点か (請求書の発行・状態変更用)
create or replace function public.staff_can_all_reservations(p_reservation_ids text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.staff_role() is not null
     and not exists (select 1 from public.reservations r
                      where r.id = any (p_reservation_ids)
                        and not public.staff_can_location(r.location_id))
$$;

-- 問い合わせを扱えるか
create or replace function public.staff_can_inquiry(p_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  q public.inquiries;
  v_loc text;
begin
  if public.staff_role() is null then return false; end if;
  if public.staff_all_locations() then return true; end if;
  select * into q from public.inquiries where id = p_id;
  if not found then return false; end if;

  -- 1. 実在する予約番号が書かれていれば、その予約の拠点
  if q.reservation_id is not null then
    select r.location_id into v_loc from public.reservations r where r.id = q.reservation_id;
    if found then return public.staff_can_location(v_loc); end if;
  end if;
  -- 2. 会員からの問い合わせは、その会員の取引拠点
  if q.user_id is not null then return public.staff_can_member(q.user_id); end if;
  -- 3. ゲスト: 同じメールアドレスの予約の拠点 (どこでも取引がなければ拠点に属さない)
  if coalesce(q.email, '') = '' then return true; end if;
  return exists (select 1 from public.reservations r
                  where r.kind = 'rental' and lower(r.customer_email) = lower(q.email)
                    and public.staff_can_location(r.location_id))
      or not exists (select 1 from public.reservations r
                      where r.kind = 'rental' and lower(r.customer_email) = lower(q.email));
end $$;

-- メール送信記録を扱えるか (元になった予約・問い合わせ・クーポンに従う)
create or replace function public.staff_can_outbox(p_id bigint) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  o public.outbox;
  v_loc text;
  v_user uuid;
begin
  if public.staff_role() is null then return false; end if;
  if public.staff_all_locations() then return true; end if;
  select * into o from public.outbox where id = p_id;
  if not found then return false; end if;

  if o.ref_type = 'reservation' then
    select r.location_id into v_loc from public.reservations r where r.id = o.ref_id;
    return found and public.staff_can_location(v_loc);
  elsif o.ref_type = 'inquiry' then
    return public.staff_can_inquiry(o.ref_id);
  elsif o.ref_type = 'coupon' then
    if coalesce(o.ref_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    select c.user_id into v_user from public.coupons c where c.id = o.ref_id::uuid;
    return found and public.staff_can_member(v_user);
  end if;
  -- 予約・問い合わせ・クーポンに紐付かない送信 (拠点に属さない)
  return true;
end $$;

-- 会員の予約から拠点を引くための索引 (RLS で行ごとに使う)
create index if not exists reservations_user_location_idx
  on public.reservations (user_id, location_id) where kind = 'rental';

-- ---------------------------------------------------------------------
-- RLS: 顧客データを拠点で絞る
--   (select ...) で囲んだものは 1 文につき 1 回だけ評価される (全拠点スタッフは行ごとの検査を省く)
-- ---------------------------------------------------------------------
drop policy if exists members_self_read on public.members;
create policy members_self_read on public.members for select to authenticated
  using (user_id = auth.uid()
         or ((select public.has_perm('read'))
             and ((select public.staff_all_locations()) or public.staff_can_member(user_id))));

drop policy if exists points_read on public.point_ledger;
create policy points_read on public.point_ledger for select to authenticated
  using (user_id = auth.uid()
         or ((select public.has_perm('read'))
             and ((select public.staff_all_locations()) or public.staff_can_member(user_id))));

drop policy if exists coupons_read on public.coupons;
create policy coupons_read on public.coupons for select to authenticated
  using (user_id = auth.uid()
         or ((select public.has_perm('read'))
             and ((select public.staff_all_locations()) or public.staff_can_member(user_id))));

drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated
  using (user_id = auth.uid()
         or ((select public.has_perm('read'))
             and ((select public.staff_all_locations()) or public.staff_can_invoice(reservation_ids))));

drop policy if exists inquiries_read on public.inquiries;
create policy inquiries_read on public.inquiries for select to authenticated
  using ((select public.has_perm('read'))
         and ((select public.staff_all_locations()) or public.staff_can_inquiry(id)));

drop policy if exists outbox_read on public.outbox;
create policy outbox_read on public.outbox for select to authenticated
  using ((select public.has_perm('outbox.read'))
         and ((select public.staff_all_locations()) or public.staff_can_outbox(id)));

-- ---------------------------------------------------------------------
-- db-1: 予約の更新。車両の付け替え先の拠点も担当範囲であることを確認する
-- ---------------------------------------------------------------------
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
  -- 付け替え先の車両の拠点も担当範囲であること
  --   (拠点限定スタッフが他拠点の車両を押さえたり、予約を他拠点へ移したりできないように)
  if not public.staff_can_location(v_asset.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;

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

-- ---------------------------------------------------------------------
-- スタッフによる予約登録: 紐付ける会員も扱える範囲であること
--   (見えない会員を予約に紐付けて、その会員を自拠点の顧客にしてしまうのを防ぐ)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_reservation(p jsonb) returns public.reservations
language plpgsql security definer set search_path = '' as $$
declare
  v public.reservations;
  v_asset public.assets;
  v_kind text := coalesce(p ->> 'kind', 'rental');
  v_start timestamptz := (p ->> 'start_at')::timestamptz;
  v_end timestamptz := (p ->> 'end_at')::timestamptz;
  v_user uuid;
begin
  if v_kind = 'block' then perform public.require_perm('blocks.write');
  else perform public.require_perm('reservations.write'); end if;
  v_user := nullif(p ->> 'user_id', '')::uuid;

  select * into v_asset from public.assets where id = p ->> 'asset_id';
  if not found then perform public.fail('ASSET_UNAVAILABLE'); end if;
  if not public.staff_can_location(v_asset.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  if v_user is not null and not public.staff_can_member(v_user) then perform public.fail('FORBIDDEN', 'location'); end if;
  if v_start is null or v_end is null or v_end <= v_start then perform public.fail('INVALID_PERIOD'); end if;

  begin
    insert into public.reservations (
      kind, asset_id, category_id, location_id, period, status, user_id,
      customer_name, customer_kana, customer_email, customer_phone, company,
      license_confirmed, payment_method, option_ids, options, price, total, note, staff_note,
      source, created_by)
    values (
      v_kind, v_asset.id, v_asset.category_id, v_asset.location_id, tstzrange(v_start, v_end, '[)'),
      'confirmed', v_user,
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

-- ---------------------------------------------------------------------
-- 会員・ポイント・クーポン
-- ---------------------------------------------------------------------
create or replace function public.admin_update_member(p_user uuid, p_patch jsonb) returns public.members
language plpgsql security definer set search_path = '' as $$
declare v public.members;
begin
  perform public.require_perm('members.write');
  if p_patch ? 'invoice_allowed' then perform public.require_perm('invoices.write'); end if;
  if not public.staff_can_member(p_user) then perform public.fail('FORBIDDEN', 'location'); end if;
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
  if not public.staff_can_member(p_user) then perform public.fail('FORBIDDEN', 'location'); end if;
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
  if not public.staff_can_member(p_user) then perform public.fail('FORBIDDEN', 'location'); end if;
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

-- ---------------------------------------------------------------------
-- 請求書: 発行・状態変更は、対象予約がすべて担当拠点のときだけ
-- ---------------------------------------------------------------------
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
  if not public.staff_can_member(p_user) then perform public.fail('FORBIDDEN', 'location'); end if;
  select * into m from public.members where user_id = p_user;
  if not found then perform public.fail('NOT_FOUND', 'member'); end if;
  if not m.invoice_allowed then perform public.fail('INVOICE_NOT_ALLOWED'); end if;
  if p_reservation_ids is null or cardinality(p_reservation_ids) = 0 then perform public.fail('NO_RESERVATIONS'); end if;
  if not public.staff_can_all_reservations(p_reservation_ids) then perform public.fail('FORBIDDEN', 'location'); end if;

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
  select * into v from public.invoices where id = p_id for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if not public.staff_can_all_reservations(v.reservation_ids) then perform public.fail('FORBIDDEN', 'location'); end if;
  update public.invoices
     set status = p_status, paid_at = case when p_status = 'paid' then coalesce(paid_at, now()) else null end
   where id = p_id
   returning * into v;
  if p_status = 'void' then
    update public.reservations set invoice_id = null where invoice_id = p_id;
  else
    update public.reservations set payment_status = case when p_status = 'paid' then 'paid' else 'unpaid' end
     where invoice_id = p_id;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 問い合わせ・メール再送
-- ---------------------------------------------------------------------
create or replace function public.admin_update_inquiry(p_id text, p_patch jsonb) returns public.inquiries
language plpgsql security definer set search_path = '' as $$
declare v public.inquiries;
begin
  perform public.require_perm('inquiries.write');
  perform 1 from public.inquiries where id = p_id for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if not public.staff_can_inquiry(p_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  update public.inquiries i set
    status      = coalesce(p_patch ->> 'status', i.status),
    staff_note  = coalesce(left(p_patch ->> 'staff_note', 4000), i.staff_note),
    assigned_to = case when p_patch ? 'assigned_to' then nullif(p_patch ->> 'assigned_to', '')::uuid else i.assigned_to end
  where i.id = p_id
  returning * into v;
  return v;
end $$;

create or replace function public.admin_retry_outbox(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.has_perm('outbox.read') and (public.has_perm('reservations.write') or public.has_perm('settings.write'))) then
    perform public.fail('FORBIDDEN');
  end if;
  if exists (select 1 from public.outbox where id = p_id) and not public.staff_can_outbox(p_id) then
    perform public.fail('FORBIDDEN', 'location');
  end if;
  update public.outbox
     set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
   where id = p_id and status in ('failed', 'skipped');
  if not found then perform public.fail('NOT_FOUND'); end if;
end $$;

-- ---------------------------------------------------------------------
-- 管理画面トップの「最近の動き」: 会員・クーポン・請求書・問い合わせも拠点で絞る
-- ---------------------------------------------------------------------
create or replace function public.admin_recent_activity(p_limit int default 50)
returns table (at timestamptz, type text, message text, ref_id text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_all boolean;
begin
  perform public.require_perm('read');
  v_all := public.staff_all_locations();
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
      and case a.table_name
            when 'reservations' then
              exists (select 1 from public.reservations r where r.id = a.row_id and public.staff_can_location(r.location_id))
            when 'members' then
              v_all or (a.diff ? 'user_id' and public.staff_can_member((a.diff ->> 'user_id')::uuid)
                        and exists (select 1 from public.members m where m.user_id = (a.diff ->> 'user_id')::uuid))
            when 'coupons' then
              v_all or (a.diff ? 'user_id' and public.staff_can_member((a.diff ->> 'user_id')::uuid))
            when 'invoices' then
              v_all or exists (select 1 from public.invoices i where i.id = a.row_id and public.staff_can_invoice(i.reservation_ids))
            when 'inquiries' then
              v_all or public.staff_can_inquiry(a.row_id)
            else false
          end
    order by a.at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end $$;

-- ---------------------------------------------------------------------
-- 実行権限
--   新しい関数は既定で anon / PUBLIC も実行できてしまうので剥がす。
--   ヘルパーは RLS ポリシーから呼ばれるため authenticated に付ける。
--   (create or replace で置き換えた既存の関数は、元の権限がそのまま残る)
-- ---------------------------------------------------------------------
revoke execute on function public.staff_all_locations() from public, anon;
revoke execute on function public.staff_can_member(uuid) from public, anon;
revoke execute on function public.staff_can_invoice(text[]) from public, anon;
revoke execute on function public.staff_can_all_reservations(text[]) from public, anon;
revoke execute on function public.staff_can_inquiry(text) from public, anon;
revoke execute on function public.staff_can_outbox(bigint) from public, anon;
grant execute on function public.staff_all_locations() to authenticated, service_role;
grant execute on function public.staff_can_member(uuid) to authenticated, service_role;
grant execute on function public.staff_can_invoice(text[]) to authenticated, service_role;
grant execute on function public.staff_can_all_reservations(text[]) to authenticated, service_role;
grant execute on function public.staff_can_inquiry(text) to authenticated, service_role;
grant execute on function public.staff_can_outbox(bigint) to authenticated, service_role;
