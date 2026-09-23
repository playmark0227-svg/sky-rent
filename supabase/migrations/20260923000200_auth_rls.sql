-- =====================================================================
-- 認証まわりのヘルパー / Auth 連携トリガー / 行レベルセキュリティ (RLS)
--
-- 方針
--   * スタッフ権限は「staff テーブルに active で登録」かつ
--     「二段階認証 (TOTP) を通過した AAL2 セッション」のときだけ有効。
--     パスワードだけのログイン (AAL1) では管理データを一切読めない。
--   * 会員は自分の行だけを読める。更新は RPC 経由 (列を限定するため)。
--   * 匿名 (anon) はテーブルを直接読めない。公開カタログと空き枠は
--     security definer の RPC だけが、個人情報を含まない形で返す。
-- =====================================================================

-- ---------------------------------------------------------------------
-- ヘルパー
-- ---------------------------------------------------------------------
create or replace function public.jwt_aal() returns text
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '')
$$;

-- AAL2 で有効なスタッフなら役割名、そうでなければ null
create or replace function public.staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select s.role
  from public.staff s
  where s.user_id = auth.uid()
    and s.active
    and public.jwt_aal() = 'aal2'
$$;

-- 役割 × 権限の対応表 (変更はここ1か所)
create or replace function public.role_has_perm(p_role text, p_perm text) returns boolean
language sql immutable set search_path = '' as $$
  select case p_role
    when 'admin' then true
    when 'store_staff' then p_perm = any (array[
      'read', 'reservations.write', 'members.write', 'inquiries.write',
      'content.write', 'outbox.read', 'blocks.write'])
    when 'accounting' then p_perm = any (array[
      'read', 'invoices.write', 'payments.write', 'outbox.read'])
    when 'maintenance' then p_perm = any (array[
      'read', 'catalog.write', 'blocks.write'])
    when 'viewer' then p_perm = 'read'
    else false
  end
$$;

create or replace function public.has_perm(p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.role_has_perm(public.staff_role(), p_perm), false)
$$;

-- 拠点スコープ (location_ids が null のスタッフは全拠点)
create or replace function public.staff_can_location(p_location text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active
      and public.jwt_aal() = 'aal2'
      and (s.location_ids is null or p_location = any (s.location_ids))
  )
$$;

-- 公開してよい設定キー / 汎用一覧
create or replace function public.is_public_setting(p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select p_key = any (array['site', 'seo', 'ga', 'content', 'points', 'pricing_rules'])
$$;
create or replace function public.is_public_collection(p_collection text) returns boolean
language sql immutable set search_path = '' as $$
  select p_collection = any (array['notices', 'faq', 'holidays', 'custom-pages'])
$$;
-- 汎用一覧のうち「コンテンツ」扱い (store_staff も編集可)
create or replace function public.is_content_collection(p_collection text) returns boolean
language sql immutable set search_path = '' as $$
  select p_collection = any (array['notices', 'faq', 'custom-pages'])
$$;

-- ---------------------------------------------------------------------
-- updated_at / version の自動更新
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['locations', 'categories', 'assets', 'options', 'app_settings',
                           'app_collections', 'members', 'staff', 'invoices', 'inquiries']
  loop
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

create or replace function public.reservations_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- カレンダー予定IDの保存 (内部処理) では版を進めない
  if current_setting('skyrent.internal', true) = 'gcal' then return new; end if;
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;
create trigger reservations_touch before update on public.reservations
  for each row execute function public.reservations_touch();

-- ---------------------------------------------------------------------
-- Auth 連携: 会員登録時に members 行を作る / メール確認で過去のゲスト予約を紐付ける
--   会員登録は signUp の user_metadata に account_type = 'member' を入れる。
--   スタッフは管理者の招待 (Edge Function) で作るので members 行は作らない。
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  if md ->> 'account_type' = 'member' then
    insert into public.members (user_id, email, name, name_kana, phone, company,
                                is_corporate, marketing_opt_in, consent)
    values (
      new.id,
      coalesce(new.email, ''),
      left(coalesce(md ->> 'name', ''), 100),
      left(coalesce(md ->> 'name_kana', ''), 100),
      left(coalesce(md ->> 'phone', ''), 30),
      left(coalesce(md ->> 'company', ''), 200),
      coalesce(md ->> 'company', '') <> '',
      coalesce((md ->> 'marketing_opt_in')::boolean, false),
      coalesce(md -> 'consent', '{}'::jsonb)
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.handle_auth_user_updated() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- メールアドレス変更を会員・スタッフへ反映
  if new.email is distinct from old.email then
    update public.members set email = coalesce(new.email, '') where user_id = new.id;
    update public.staff   set email = coalesce(new.email, '') where user_id = new.id;
  end if;
  -- メール所有が確認できた時点で、同じアドレスの過去のゲスト予約を会員に紐付ける
  if new.email_confirmed_at is not null
     and (old.email_confirmed_at is null or new.email is distinct from old.email)
     and exists (select 1 from public.members m where m.user_id = new.id) then
    update public.reservations r
       set user_id = new.id
     where r.user_id is null
       and r.kind = 'rental'
       and lower(r.customer_email) = lower(new.email);
  end if;
  return new;
end $$;

create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.handle_auth_user_updated();

-- ---------------------------------------------------------------------
-- RLS 有効化
-- ---------------------------------------------------------------------
alter table public.locations        enable row level security;
alter table public.categories       enable row level security;
alter table public.assets           enable row level security;
alter table public.options          enable row level security;
alter table public.app_settings     enable row level security;
alter table public.app_collections  enable row level security;
alter table public.legal_documents  enable row level security;
alter table public.members          enable row level security;
alter table public.staff            enable row level security;
alter table public.invoices         enable row level security;
alter table public.reservations     enable row level security;
alter table public.point_ledger     enable row level security;
alter table public.coupons          enable row level security;
alter table public.inquiries        enable row level security;
alter table public.outbox           enable row level security;
alter table public.audit_log        enable row level security;
alter table public.rate_limits      enable row level security;

-- 直接書き込みさせない表は、権限そのものを剥がしておく (RLS の書き忘れ対策)
revoke all on public.members, public.invoices, public.reservations, public.point_ledger,
              public.coupons, public.inquiries, public.outbox, public.audit_log,
              public.rate_limits, public.staff
  from anon, authenticated;
grant select on public.members, public.invoices, public.reservations, public.point_ledger,
                public.coupons, public.inquiries, public.outbox, public.audit_log, public.staff
  to authenticated;
revoke all on public.member_points from anon;
grant select on public.member_points to authenticated;

-- カタログ・設定: anon は直接触れない (公開は RPC 経由)。スタッフは権限に応じて書く
revoke all on public.locations, public.categories, public.assets, public.options,
              public.app_settings, public.app_collections, public.legal_documents
  from anon;
revoke insert, update, delete, truncate on public.legal_documents from authenticated;

-- ---- カタログ ----
create policy catalog_read_locations  on public.locations  for select to authenticated using (public.has_perm('read'));
create policy catalog_read_categories on public.categories for select to authenticated using (public.has_perm('read'));
create policy catalog_read_assets     on public.assets     for select to authenticated using (public.has_perm('read'));
create policy catalog_read_options    on public.options    for select to authenticated using (public.has_perm('read'));

create policy catalog_write_locations  on public.locations  for all to authenticated
  using (public.has_perm('catalog.write')) with check (public.has_perm('catalog.write'));
create policy catalog_write_categories on public.categories for all to authenticated
  using (public.has_perm('catalog.write')) with check (public.has_perm('catalog.write'));
create policy catalog_write_assets     on public.assets     for all to authenticated
  using (public.has_perm('catalog.write')) with check (public.has_perm('catalog.write'));
create policy catalog_write_options    on public.options    for all to authenticated
  using (public.has_perm('catalog.write')) with check (public.has_perm('catalog.write'));

-- ---- 設定・汎用一覧 ----
create policy settings_read on public.app_settings for select to authenticated
  using (public.is_public_setting(key) or public.has_perm('read'));
create policy settings_write on public.app_settings for all to authenticated
  using (public.has_perm('settings.write')) with check (public.has_perm('settings.write'));

create policy collections_read on public.app_collections for select to authenticated
  using (public.is_public_collection(collection) or public.has_perm('read'));
create policy collections_write on public.app_collections for all to authenticated
  using (public.has_perm('settings.write')
         or (public.is_content_collection(collection) and public.has_perm('content.write')))
  with check (public.has_perm('settings.write')
         or (public.is_content_collection(collection) and public.has_perm('content.write')));

create policy legal_read on public.legal_documents for select to authenticated using (true);

-- ---- 会員 ----
create policy members_self_read on public.members for select to authenticated
  using (user_id = auth.uid() or public.has_perm('read'));

create policy points_read on public.point_ledger for select to authenticated
  using (user_id = auth.uid() or public.has_perm('read'));
create policy coupons_read on public.coupons for select to authenticated
  using (user_id = auth.uid() or public.has_perm('read'));
create policy invoices_read on public.invoices for select to authenticated
  using (user_id = auth.uid() or public.has_perm('read'));

-- ---- 予約: 本人 / 担当拠点のスタッフ ----
create policy reservations_read on public.reservations for select to authenticated
  using (
    (user_id = auth.uid() and kind = 'rental')
    or (public.has_perm('read') and public.staff_can_location(location_id))
  );

-- ---- スタッフ: 自分の行 / 管理者は全員 ----
create policy staff_read on public.staff for select to authenticated
  using (user_id = auth.uid() or public.has_perm('staff.write'));

-- ---- 問い合わせ・メール・監査 ----
create policy inquiries_read on public.inquiries for select to authenticated
  using (public.has_perm('read'));
create policy outbox_read on public.outbox for select to authenticated
  using (public.has_perm('outbox.read'));
create policy audit_read on public.audit_log for select to authenticated
  using (public.has_perm('audit.read'));

-- rate_limits はポリシーなし = service_role 以外は一切アクセス不可
