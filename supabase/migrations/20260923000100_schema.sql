-- =====================================================================
-- グロースレンタカー 本番スキーマ v1 — テーブル・制約
--
-- 設計の要点
--   * 予約期間は tstzrange の半開区間 [貸出, 返却)。同じ車両の有効な予約
--     (confirmed / in_use) が重なると、排他制約でDBが拒否する。
--     「検索したら空いていたので INSERT」だけに頼らない。
--   * 会員・スタッフの資格情報は Supabase Auth (auth.users) だけが持つ。
--     業務テーブルにパスワードを置かない。
--   * 料金はサーバー (Edge Function) が料金ルールから再計算した値だけを保存する。
--   * 免許番号は予約時に保存しない (当日店頭で確認)。
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- 採番
-- ---------------------------------------------------------------------
create sequence public.reservation_no_seq;
create sequence public.member_no_seq;
create sequence public.invoice_no_seq;
create sequence public.inquiry_no_seq;

-- ---------------------------------------------------------------------
-- 拠点・カテゴリ・車両・オプション (カタログ)
-- ---------------------------------------------------------------------
create table public.locations (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name        text not null,
  name_en     text not null default '',
  tel         text not null default '',
  address     text not null default '',
  hours       text not null default '',
  holiday     text not null default '',
  sort        int  not null default 99,
  active      boolean not null default true,
  extra       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table public.categories (
  id                text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name              text not null,
  name_en           text not null default '',
  type              text not null default 'vehicle' check (type in ('vehicle', 'item')),
  icon              text not null default '',
  description       text not null default '',
  sort              int  not null default 99,
  active            boolean not null default true,
  custom_field_defs jsonb not null default '[]'::jsonb,
  extra             jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);

create table public.assets (
  id               text primary key check (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$'),
  category_id      text not null references public.categories(id) on update cascade,
  location_id      text not null references public.locations(id) on update cascade,
  name             text not null,
  name_en          text not null default '',
  plate            text not null default '',          -- 管理用。公開カタログには出さない
  capacity         int check (capacity is null or capacity between 1 and 99),
  price_hour       int check (price_hour  is null or price_hour  >= 0),
  price_day        int not null check (price_day >= 0),
  price_week       int check (price_week  is null or price_week  >= 0),
  price_month      int check (price_month is null or price_month >= 0),
  stock            int not null default 1 check (stock = 1),  -- 物理車両1台 = 1行
  required_license text not null default '',
  image            text not null default '',
  photo            text not null default '',
  active           boolean not null default true,
  shaken_date      date,
  maintenance_date date,
  custom_fields    jsonb not null default '{}'::jsonb,
  sort             int  not null default 99,
  extra            jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);
create index assets_category_idx on public.assets(category_id);
create index assets_location_idx on public.assets(location_id);

create table public.options (
  id              text primary key check (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$'),
  name            text not null,
  price           int  not null check (price >= 0),               -- 24時間あたり (per_day) / 1回 (per_rental)
  price_short     int  check (price_short is null or price_short >= 0), -- 短時間 (1〜6時間) の料金
  price_type      text not null default 'per_day' check (price_type in ('per_day', 'per_rental')),
  category_ids    text[],                                          -- null = 全カテゴリ共通
  kind            text not null default 'cover' check (kind in ('cover', 'other')),
  exclusive_group text,                                            -- 同じグループは1つだけ選択可 (例: 'cover')
  active          boolean not null default true,
  sort            int  not null default 99,
  extra           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 設定 (料金ルール・ポイント設定・サイト設定など) と、管理画面の汎用一覧
-- ---------------------------------------------------------------------
create table public.app_settings (
  key         text primary key check (key ~ '^[a-z0-9_.-]{1,60}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table public.app_collections (
  collection  text not null check (collection ~ '^[a-z0-9_.-]{1,60}$'),
  id          text not null check (length(id) between 1 and 80),
  data        jsonb not null,
  sort        int  not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (collection, id)
);

-- 公開中の法務文書 (予約・会員登録・問い合わせの同意で版を固定する)
create table public.legal_documents (
  id           text not null,
  version      text not null,
  title        text not null,
  url          text not null,
  effective_at date not null,
  active       boolean not null default true,
  primary key (id, version)
);
create unique index legal_documents_one_active on public.legal_documents(id) where active;

-- ---------------------------------------------------------------------
-- 会員・スタッフ (資格情報は auth.users のみ)
-- ---------------------------------------------------------------------
create table public.members (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  member_no        text not null unique default ('M' || lpad(nextval('public.member_no_seq')::text, 5, '0')),
  email            text not null,
  name             text not null default '',
  name_kana        text not null default '',
  phone            text not null default '',
  company          text not null default '',
  is_corporate     boolean not null default false,
  invoice_allowed  boolean not null default false,
  marketing_opt_in boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'closed')),
  consent          jsonb not null default '{}'::jsonb,
  last_use_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index members_email_idx on public.members(lower(email));

create table public.staff (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  name         text not null default '',
  email        text not null default '',
  role         text not null check (role in ('admin', 'store_staff', 'accounting', 'maintenance', 'viewer')),
  location_ids text[],            -- null = 全拠点
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 請求書
-- ---------------------------------------------------------------------
create table public.invoices (
  id              text primary key default ('INV-' || lpad(nextval('public.invoice_no_seq')::text, 4, '0')),
  user_id         uuid not null references public.members(user_id),
  company         text not null default '',
  address         text not null default '',
  case_name       text not null default 'レンタル料金 一式',
  reservation_ids text[] not null check (cardinality(reservation_ids) > 0),
  amount          int  not null check (amount >= 0),
  status          text not null default 'unpaid' check (status in ('unpaid', 'paid', 'void')),
  issued_at       timestamptz not null default now(),
  due_date        date,
  paid_at         timestamptz,
  created_by      uuid,
  updated_at      timestamptz not null default now()
);
create index invoices_user_idx on public.invoices(user_id);

-- ---------------------------------------------------------------------
-- 予約 (kind = 'block' は整備・車検などの貸出停止枠)
-- ---------------------------------------------------------------------
create table public.reservations (
  id                text primary key default ('R' || lpad(nextval('public.reservation_no_seq')::text, 5, '0')),
  kind              text not null default 'rental' check (kind in ('rental', 'block')),
  asset_id          text not null references public.assets(id) on update cascade,
  category_id       text not null references public.categories(id) on update cascade,
  location_id       text not null references public.locations(id) on update cascade,
  period            tstzrange not null,
  start_at          timestamptz generated always as (lower(period)) stored,
  end_at            timestamptz generated always as (upper(period)) stored,
  status            text not null default 'confirmed'
                    check (status in ('confirmed', 'in_use', 'returned', 'cancelled', 'no_show')),
  user_id           uuid references public.members(user_id) on delete set null,
  customer_name     text not null default '',
  customer_kana     text not null default '',
  customer_email    text not null default '',
  customer_phone    text not null default '',
  company           text not null default '',
  license_confirmed boolean not null default false,
  payment_method    text not null default 'onsite' check (payment_method in ('onsite', 'invoice')),
  payment_status    text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'refunded')),
  option_ids        text[] not null default '{}',
  options           jsonb not null default '[]'::jsonb,   -- 予約時点のオプション名・単価スナップショット
  price             jsonb not null default '{}'::jsonb,   -- 予約時点の料金内訳スナップショット
  total             int  not null default 0 check (total >= 0),
  discount_type     text,
  coupon_id         uuid,
  invoice_id        text references public.invoices(id) on delete set null,
  point_granted     boolean not null default false,
  note              text not null default '' check (length(note) <= 2000),
  staff_note        text not null default '' check (length(staff_note) <= 4000),
  cancel_fee        int check (cancel_fee is null or cancel_fee >= 0),
  cancelled_at      timestamptz,
  cancelled_by      text check (cancelled_by is null or cancelled_by in ('customer', 'staff')),
  guest_token_hash  text,
  consent           jsonb not null default '{}'::jsonb,
  idempotency_key   text unique,
  request_hash      text,
  source            text not null default 'web' check (source in ('web', 'staff', 'import')),
  version           int  not null default 1,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint reservations_period_valid check (
    not isempty(period) and lower(period) is not null and upper(period) is not null
    and lower_inc(period) and not upper_inc(period)
  ),
  constraint reservations_rental_has_customer check (
    kind = 'block' or (customer_name <> '' and customer_email <> '' and customer_phone <> '')
  ),
  -- 同じ車両の有効な予約・貸出停止枠は時間が重ならない (DBが最後の砦)
  constraint reservations_no_overlap exclude using gist (asset_id with =, period with &&)
    where (status in ('confirmed', 'in_use'))
);
create index reservations_user_idx     on public.reservations(user_id);
create index reservations_start_idx    on public.reservations(start_at);
create index reservations_location_idx on public.reservations(location_id);
create index reservations_email_idx    on public.reservations(lower(customer_email));

-- ---------------------------------------------------------------------
-- ポイント台帳・クーポン (残高は台帳の合計。行の上書きで残高を持たない)
-- ---------------------------------------------------------------------
create table public.point_ledger (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.members(user_id) on delete cascade,
  delta          int  not null check (delta <> 0),
  reason         text not null default '',
  reservation_id text references public.reservations(id) on delete set null,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index point_ledger_user_idx on public.point_ledger(user_id);
-- 返却によるポイント付与は1予約につき1回だけ
create unique index point_ledger_return_grant_once
  on public.point_ledger(reservation_id) where delta > 0 and reservation_id is not null;

create table public.coupons (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.members(user_id) on delete cascade,
  amount              int  not null check (amount > 0),
  reason              text not null default '',
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz,
  used_at             timestamptz,
  used_reservation_id text references public.reservations(id) on delete set null,
  created_by          uuid
);
create index coupons_user_idx on public.coupons(user_id);
alter table public.reservations
  add constraint reservations_coupon_fk foreign key (coupon_id) references public.coupons(id) on delete set null;

create view public.member_points with (security_invoker = true) as
  select m.user_id, coalesce(sum(l.delta), 0)::int as points
  from public.members m
  left join public.point_ledger l on l.user_id = m.user_id
  group by m.user_id;

-- ---------------------------------------------------------------------
-- 問い合わせ
-- ---------------------------------------------------------------------
create table public.inquiries (
  id              text primary key default ('C' || lpad(nextval('public.inquiry_no_seq')::text, 5, '0')),
  name            text not null check (length(name) between 1 and 100),
  company         text not null default '' check (length(company) <= 200),
  email           text not null check (length(email) between 3 and 254),
  tel             text not null default '' check (length(tel) <= 30),
  topic           text not null check (length(topic) between 1 and 60),
  body            text not null check (length(body) between 1 and 5000),
  reservation_id  text,
  user_id         uuid references public.members(user_id) on delete set null,
  status          text not null default 'new' check (status in ('new', 'in_progress', 'closed')),
  staff_note      text not null default '' check (length(staff_note) <= 4000),
  assigned_to     uuid,
  consent         jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index inquiries_status_idx on public.inquiries(status, created_at desc);

-- ---------------------------------------------------------------------
-- メール送信キュー (業務処理と同じトランザクションで積み、非同期に送る)
--   件名・本文は送信時に Edge Function のテンプレートで payload から組み立てる
-- ---------------------------------------------------------------------
create table public.outbox (
  id                  bigint generated always as identity primary key,
  template            text not null,
  to_email            text not null,
  payload             jsonb not null default '{}'::jsonb,
  subject             text,
  body_text           text,
  ref_type            text,
  ref_id              text,
  status              text not null default 'pending'
                      check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts            int  not null default 0,
  next_attempt_at     timestamptz not null default now(),
  last_error          text,
  provider_message_id text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);
create index outbox_due_idx on public.outbox(next_attempt_at) where status in ('pending', 'failed');
create index outbox_ref_idx on public.outbox(ref_type, ref_id);

-- ---------------------------------------------------------------------
-- 監査ログ (追記のみ。利用者・管理者とも更新・削除不可)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_role  text,
  action      text not null,
  table_name  text,
  row_id      text,
  diff        jsonb
);
create index audit_log_at_idx  on public.audit_log(at desc);
create index audit_log_row_idx on public.audit_log(table_name, row_id);

-- ---------------------------------------------------------------------
-- レート制限 (Edge Function からのみ使用)
-- ---------------------------------------------------------------------
create table public.rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  hits          int not null default 0,
  primary key (bucket, window_start)
);
