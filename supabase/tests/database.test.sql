-- =====================================================================
-- DB の権限 (RLS) と業務ロジックの自動テスト (pgTAP)
--   実行: supabase test db
--   すべて1トランザクション内で行い、最後に rollback するので DB は汚れない。
-- =====================================================================
begin;
select * from no_plan();

-- 既存データ・他の作業と衝突しないよう、テストの予約はすべて 300 日先に置く
select set_config('t.base', (now() + interval '300 days')::text, true);

-- 拠点ごとの権限を確かめるため、2つ目の拠点 (釧路) を作り、V002 をそこへ置く。
--   本番の初期データは北見本店のみ (2026-10 に釧路店を廃止)。この準備はテストの取引の中だけで、最後に rollback する
insert into public.locations (id, name, name_en, address, hours, holiday, sort)
  values ('loc-kushiro', '釧路店', 'Kushiro', '北海道釧路市', '9:00-18:00', 'なし', 2);
update public.assets set location_id = 'loc-kushiro' where id = 'V002';

-- ---------------------------------------------------------------------
-- 準備 (postgres 権限): 会員2名 + スタッフ4名 + 予約
-- ---------------------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_user_meta_data, email_confirmed_at) values
  ('11111111-1111-1111-1111-111111111111', 'member-a@example.com', 'authenticated', 'authenticated',
   '{"account_type":"member","name":"会員A","phone":"09011112222"}', now()),
  ('22222222-2222-2222-2222-222222222222', 'member-b@example.com', 'authenticated', 'authenticated',
   '{"account_type":"member","name":"会員B"}', now()),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@example.test', 'authenticated', 'authenticated', '{}', now()),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'viewer@example.test', 'authenticated', 'authenticated', '{}', now()),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'kushiro@example.test', 'authenticated', 'authenticated', '{}', now()),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'account@example.test', 'authenticated', 'authenticated', '{}', now());

insert into public.staff (user_id, name, role, location_ids) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '管理者', 'admin', null),
  ('aaaaaaaa-0000-0000-0000-000000000002', '閲覧者', 'viewer', null),
  ('aaaaaaaa-0000-0000-0000-000000000003', '釧路スタッフ', 'store_staff', '{loc-kushiro}'),
  ('aaaaaaaa-0000-0000-0000-000000000004', '経理', 'accounting', null);

-- 既存環境の管理者 (初期セットアップで作ったもの等) はこのテストの間だけ無効化する (最後に rollback)
update public.staff set active = false where user_id not in (
  'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
  'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004');

select is((select count(*)::int from public.members where created_at = now()), 2, '会員登録 (account_type=member) だけ members 行ができる');

-- 予約: 会員A (北見 V003) / 会員B (北見 V001) / ゲスト (釧路 V002)
select set_config('t.ra', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-member-a-000001', 'request_hash', 'ha', 'asset_id', 'V003',
  'user_id', '11111111-1111-1111-1111-111111111111',
  'start_at', current_setting('t.base')::timestamptz + interval '3 days', 'end_at', current_setting('t.base')::timestamptz + interval '4 days',
  'customer', jsonb_build_object('name', '会員A', 'email', 'member-a@example.com', 'phone', '09011112222'),
  'total', 17000, 'guest_token_hash', 'hash-a')) #>> '{reservation,id}'), false);
select set_config('t.rb', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-member-b-000001', 'request_hash', 'hb', 'asset_id', 'V001',
  'user_id', '22222222-2222-2222-2222-222222222222',
  'start_at', current_setting('t.base')::timestamptz + interval '5 days', 'end_at', current_setting('t.base')::timestamptz + interval '6 days',
  'customer', jsonb_build_object('name', '会員B', 'email', 'member-b@example.com', 'phone', '09000000000'),
  'total', 7700)) #>> '{reservation,id}'), false);
select set_config('t.rk', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-guest-kushiro-01', 'request_hash', 'hk', 'asset_id', 'V002',
  'start_at', current_setting('t.base')::timestamptz + interval '2 days', 'end_at', current_setting('t.base')::timestamptz + interval '3 days',
  'customer', jsonb_build_object('name', 'ゲスト 太郎', 'email', 'guest-c@example.com', 'phone', '08000000000'),
  'total', 7700, 'guest_token_hash', 'hash-k',
  'emails', jsonb_build_array(jsonb_build_object('template', 'reservation_confirmed', 'to', 'guest-c@example.com',
                                                 'payload', jsonb_build_object('name', 'ゲスト 太郎'))))) #>> '{reservation,id}'), false);

select ok(current_setting('t.ra') like 'R%', '予約番号は R + 連番');
select is((select count(*)::int from public.outbox where ref_id = current_setting('t.rk') and template = 'reservation_confirmed'),
          1, '予約と同じトランザクションで確認メールがキューに入る');
select is((select payload ->> 'reservation_id' from public.outbox where ref_id = current_setting('t.rk') limit 1),
          current_setting('t.rk'), 'メール payload に予約番号が補われる');

-- ---------------------------------------------------------------------
-- 二重予約・冪等性・受け渡し重複
-- ---------------------------------------------------------------------
select throws_ok(
  format($$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-overlap-000001', 'request_hash', 'x', 'asset_id', 'V003',
    'start_at', %L::timestamptz, 'end_at', %L::timestamptz,
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
    current_setting('t.base')::timestamptz + interval '3 days 12 hours', current_setting('t.base')::timestamptz + interval '5 days'),
  'P0001', 'AVAILABILITY_CONFLICT', '同じ車両で時間が重なる予約はDBが拒否する');

select lives_ok(
  format($$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-adjacent-00001', 'request_hash', 'x', 'asset_id', 'V003',
    'start_at', %L::timestamptz, 'end_at', %L::timestamptz,
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
    current_setting('t.base')::timestamptz + interval '4 days', current_setting('t.base')::timestamptz + interval '4 days 5 hours'),
  '返却時刻ちょうどから次の予約を入れられる (半開区間)');

select is((public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-member-a-000001', 'request_hash', 'ha', 'asset_id', 'V003',
  'start_at', current_setting('t.base')::timestamptz + interval '3 days', 'end_at', current_setting('t.base')::timestamptz + interval '4 days',
  'customer', jsonb_build_object('name', '会員A', 'email', 'member-a@example.com', 'phone', '0'), 'total', 17000)) ->> 'replay'),
  'true', '同じ冪等キー・同じ内容の再送は最初の予約を返す');

select throws_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-member-a-000001', 'request_hash', 'DIFFERENT', 'asset_id', 'V003',
    'start_at', current_setting('t.base')::timestamptz + interval '3 days', 'end_at', current_setting('t.base')::timestamptz + interval '4 days',
    'customer', jsonb_build_object('name', 'A', 'email', 'a@example.com', 'phone', '0'), 'total', 1))$$,
  'P0001', 'IDEMPOTENCY_KEY_REUSED', '同じ冪等キーで内容が違えば拒否');

-- 北見 V003 の貸出 (now+3days) の 10分後に、同じ北見の別車両 V004 を貸出 → 受け渡しが重なる
select throws_ok(
  format($$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-handover-00001', 'request_hash', 'x', 'asset_id', 'V004', 'handover_minutes', 30,
    'start_at', %L::timestamptz, 'end_at', %L::timestamptz,
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
    current_setting('t.base')::timestamptz + interval '3 days 10 minutes', current_setting('t.base')::timestamptz + interval '3 days 5 hours'),
  'P0001', 'HANDOVER_CONFLICT', '同じ拠点で受け渡し時刻が30分以内に重なる予約は拒否 (設定時)');
select lives_ok(
  format($$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-handover-00002', 'request_hash', 'x', 'asset_id', 'V004', 'handover_minutes', 30,
    'start_at', %L::timestamptz, 'end_at', %L::timestamptz,
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
    current_setting('t.base')::timestamptz + interval '3 days 40 minutes', current_setting('t.base')::timestamptz + interval '3 days 5 hours'),
  '受け渡し時刻が30分以上離れていれば予約できる');

select throws_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-option-bad-001', 'request_hash', 'x', 'asset_id', 'V001', 'option_ids', jsonb_build_array('OP201'),
    'start_at', current_setting('t.base')::timestamptz + interval '20 days', 'end_at', current_setting('t.base')::timestamptz + interval '21 days',
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
  'P0001', 'OPTION_INVALID', 'キッチンカー用の補償をレンタカーに付けられない');

select throws_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-invoice-guest-1', 'request_hash', 'x', 'asset_id', 'V001', 'payment_method', 'invoice',
    'start_at', current_setting('t.base')::timestamptz + interval '20 days', 'end_at', current_setting('t.base')::timestamptz + interval '21 days',
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
  'P0001', 'INVOICE_NOT_ALLOWED', '請求書払いは許可された会員だけ');

-- ---------------------------------------------------------------------
-- 装備オプション (総合料金表 2026年6月改定版)・法務文書の版
-- ---------------------------------------------------------------------
select is((select count(*)::int from public.options), 15, 'オプションは補償4 + 装備11');
select results_eq(
  $$select id, name, price, price_short, price_type, category_ids, kind, exclusive_group, active, sort, extra ->> 'description'
      from public.options where kind = 'other' order by sort$$,
  $$values ('OP001', 'ポータブル冷蔵冷凍庫',       3300,  null::int, 'per_day', null::text[], 'other', null::text, true, 11, 'アイリスオーヤマ IPD-4A-B'),
           ('OP002', '電子レンジ',                 2200,  null, 'per_day', null, 'other', null, true, 12, 'パナソニック NE-FL1C-W'),
           ('OP003', 'サーキュレーター',           1100,  null, 'per_day', null, 'other', null, true, 13, 'アイリスオーヤマ KCF-SDC15T-EC-W'),
           ('OP004', 'ポータブル電源',             3300,  null, 'per_day', null, 'other', null, true, 14, 'Jackery JE-1800A'),
           ('OP005', 'ドラムリール',               1100,  null, 'per_day', null, 'other', null, true, 15, '日動工業 NR-304D-S'),
           ('OP006', 'カセットコンロ',             1100,  null, 'per_day', null, 'other', null, true, 16, '岩谷産業 CB-ODX1-BK'),
           ('OP007', 'カセットボンベ',             1100,  null, 'per_day', null, 'other', null, true, 17, '岩谷産業 CB-250-OR'),
           ('OP008', '炊飯器',                     2200,  null, 'per_day', null, 'other', null, true, 18, 'タイガー魔法瓶 JPV-Y180KV'),
           ('OP009', '電気ケトル',                 1100,  null, 'per_day', null, 'other', null, true, 19, '象印マホービン CK-VB15 BM'),
           ('OP010', '家電セット (上記9点まとめ)', 11000, null, 'per_day', null, 'other', null, true, 20, 'ポータブル冷蔵冷凍庫〜電気ケトルの9点をまとめたセット'),
           ('OP011', '集客セット',                 1100,  null, 'per_day', null, 'other', null, true, 21, 'ホワイトボード・マグネット・ペン')$$,
  '装備オプション11品目: 全車共通・24時間ごと (短時間料金なし)・補償の後に並ぶ');
select is((select extra -> 'includes' from public.options where id = 'OP010'),
  '["OP001","OP002","OP003","OP004","OP005","OP006","OP007","OP008","OP009"]'::jsonb, '家電セットは含まれる9品目を extra.includes に持つ');
select is((select count(*)::int from public.options where extra ? 'includes'), 1, 'includes を持つのは家電セットだけ');
select col_default_is('public', 'options', 'kind', 'other'::text, '種類を指定せずに追加したオプションは装備 (other) になる (補償は料金表の4件だけ)');

select lives_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-equipment-00001', 'request_hash', 'x', 'asset_id', 'V001', 'option_ids', jsonb_build_array('OP101', 'OP010', 'OP011'),
    'start_at', current_setting('t.base')::timestamptz + interval '70 days', 'end_at', current_setting('t.base')::timestamptz + interval '71 days',
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
  '装備オプションはレンタカーに付けられる (補償と一緒でもよい)');
-- (家電の在庫は各1。上の家電セットと重ならない日にする)
select lives_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-equipment-00002', 'request_hash', 'x', 'asset_id', 'K001', 'option_ids', jsonb_build_array('OP201', 'OP001', 'OP004'),
    'start_at', current_setting('t.base')::timestamptz + interval '72 days', 'end_at', current_setting('t.base')::timestamptz + interval '73 days',
    'customer', jsonb_build_object('name', 'X', 'email', 'x@example.com', 'phone', '0'), 'total', 1))$$,
  '装備オプションはキッチンカーにも付けられる');

select results_eq(
  $$select id, version, effective_at from public.legal_documents where active order by id$$,
  $$values ('cancel', '2026-10', '2026-10-01'::date), ('clause', '2026-10', '2026-10-01'::date),
           ('item_clause', '2026-10', '2026-10-01'::date),
           ('law', '2026-10', '2026-10-01'::date), ('privacy', '2026-08', '2026-08-01'::date)$$,
  '法務文書: キャンセル規定は 2026-10 版 (家電レンタルの段階を追加)・物品レンタル規約 (家電レンタルの同意) を追加・貸渡約款は 2026-10 版 (改訂)。プライバシーポリシーは据え置き');
select results_eq(
  $$select title, url from public.legal_documents where id = 'item_clause' and active$$,
  $$values ('物品レンタル規約', 'item-terms.html')$$,
  '物品レンタル規約のページ');

-- 公開カタログに出してよい extra の項目は説明と includes (配列のときだけ) — 社内用の項目を足しても出ない
update public.options set extra = extra || '{"memo":"社内メモ","supplier":"仕入れ先"}'::jsonb where id = 'OP001';
update public.options set extra = extra || '{"includes":"OP001"}'::jsonb where id = 'OP011';

-- ---------------------------------------------------------------------
-- 匿名 (anon)
-- ---------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select is((select jsonb_agg(o ->> 'id') from jsonb_array_elements(public.public_catalog() -> 'options') o),
  '["OP101","OP102","OP201","OP202","OP001","OP002","OP003","OP004","OP005","OP006","OP007","OP008","OP009","OP010","OP011"]'::jsonb,
  '公開カタログのオプションは15件、補償が先・装備が後 (sort 順)');
select is((select o -> 'extra' -> 'includes' from jsonb_array_elements(public.public_catalog() -> 'options') o where o ->> 'id' = 'OP010'),
  '["OP001","OP002","OP003","OP004","OP005","OP006","OP007","OP008","OP009"]'::jsonb, '公開カタログは家電セットの includes を返す');
select is((select o -> 'extra' from jsonb_array_elements(public.public_catalog() -> 'options') o where o ->> 'id' = 'OP011'),
  '{"description":"ホワイトボード・マグネット・ペン"}'::jsonb, '配列でない includes は公開カタログに出さない');
select is((select jsonb_agg(distinct k order by k) from jsonb_array_elements(public.public_catalog() -> 'options') o, jsonb_object_keys(o -> 'extra') k),
  '["description","includes"]'::jsonb, '公開カタログのオプションの extra は説明と includes だけ (社内用の項目は出さない)');
select is((select jsonb_agg(k order by k) from jsonb_object_keys(public.public_catalog() -> 'options' -> 0) k),
  '["active","category_ids","exclusive_group","extra","id","kind","name","price","price_short","price_type","sort","stock","updated_at"]'::jsonb,
  '公開カタログのオプションの列は在庫数 (stock) だけ増えた');
select throws_ok('select count(*) from public.reservations', '42501', null, '匿名は予約を読めない');
select throws_ok('select count(*) from public.members', '42501', null, '匿名は会員を読めない');
select throws_ok('select count(*) from public.inquiries', '42501', null, '匿名は問い合わせを読めない');
select throws_ok('select count(*) from public.assets', '42501', null, '匿名は車両表を直接読めない (カタログRPC経由のみ)');
select is(jsonb_array_length(public.public_catalog() -> 'assets'), 6, '匿名でも公開カタログは読める (車両5台 + 家電レンタルの受け取り窓口)');
select ok(not ((public.public_catalog() -> 'assets' -> 0) ? 'plate'), '公開カタログにナンバーを含めない');
select ok(not ((public.public_catalog() -> 'settings') ? 'calendar'), '公開カタログにカレンダー設定 (担当者のカレンダーID) を含めない');
select ok(not ((public.public_catalog() -> 'settings') ? 'billing'), '公開カタログに振込先を含めない');
select ok((select count(*) from public.public_busy_ranges(current_setting('t.base')::timestamptz, current_setting('t.base')::timestamptz + interval '30 days')) >= 3, '匿名でも埋まり時間帯は読める');
select throws_ok($$select public.create_reservation_tx('{}'::jsonb)$$, '42501', null, '匿名は予約確定関数を直接呼べない');
select throws_ok($$select public.admin_adjust_points('11111111-1111-1111-1111-111111111111', 100, 'x')$$, '42501', null, '匿名は管理関数を呼べない');
reset role;

-- ---------------------------------------------------------------------
-- 会員A
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.reservations), 0, '会員は予約表を直接読めない (スタッフのメモを見せないため)');
select is(jsonb_array_length(public.member_reservations()), 1, '会員は専用関数で自分の予約だけ読める');
select is(public.member_reservations() -> 0 ->> 'id', current_setting('t.ra'), '読める予約は本人のもの');
select ok(not ((public.member_reservations() -> 0) ? 'staff_note'), '会員にはスタッフのメモを返さない');
select is((select count(*)::int from public.members), 1, '会員は自分の会員情報だけ見える');
select is((select count(*)::int from public.staff), 0, '会員はスタッフ表を見られない');
select is((select count(*)::int from public.locations), 0, '会員はカタログ表を直接読めない (RPC経由)');
select throws_ok($$update public.members set invoice_allowed = true$$, '42501', null, '会員は会員表を直接更新できない');
select is((public.member_update_profile('{"name":"会員A改","invoice_allowed":true}'::jsonb)).name, '会員A改', 'プロフィールは RPC で更新できる');
select is((select invoice_allowed from public.members), false, 'RPC でも請求書払いの許可は自分で変えられない');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"status":"cancelled"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'FORBIDDEN', '会員は管理用の予約更新を使えない');
select throws_ok($$insert into public.app_settings (key, value) values ('seo', '{}')$$, '42501', null, '会員は設定を書けない');
reset role;

-- ---------------------------------------------------------------------
-- スタッフ: 二段階認証 (AAL2) 前は何も見えない
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1"}';
select is(public.staff_role(), null, 'パスワードだけ (AAL1) の管理者は権限なし');
select is((select count(*)::int from public.reservations), 0, 'AAL1 の管理者は予約を読めない');
select is((select count(*)::int from public.staff), 1, 'AAL1 でも自分のスタッフ行は読める (二段階認証へ進むため)');
reset role;

-- ---------------------------------------------------------------------
-- 管理者 (AAL2)
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select is(public.staff_role(), 'admin', 'AAL2 の管理者は admin');
select ok((select count(*) from public.reservations where created_at = now()) >= 5, '管理者は全予約を読める');
select ok((select count(*) from public.staff) >= 4, '管理者は全スタッフを読める');

select is((public.admin_update_reservation(current_setting('t.ra'), '{"status":"in_use"}'::jsonb)).status, 'in_use', '確定 → 貸出中');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"staff_note":"x"}'::jsonb, 1)$$, current_setting('t.ra')),
  'P0001', 'VERSION_CONFLICT', '古い版で更新すると VERSION_CONFLICT');
select is((public.admin_update_reservation(current_setting('t.ra'), '{"status":"returned"}'::jsonb)).status, 'returned', '貸出中 → 返却済');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"status":"confirmed"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'INVALID_TRANSITION', '返却済からは戻せない');
select is((select coalesce(sum(delta), 0)::int from public.point_ledger where user_id = '11111111-1111-1111-1111-111111111111'),
  1, '返却で会員に 1pt 付与');
select ok((select point_granted from public.reservations where id = current_setting('t.ra')), '付与済みフラグが立つ');

-- 9pt 追加 → 合計 10pt → ¥1,000 クーポン自動発行・ポイント消費
select is(public.admin_adjust_points('11111111-1111-1111-1111-111111111111', 9, 'キャンペーン'), 0, '10pt に達するとクーポンに交換され残高 0');
select is((select count(*)::int from public.coupons where user_id = '11111111-1111-1111-1111-111111111111' and amount = 1000),
  1, '¥1,000 クーポンが1枚発行される');
select is((select count(*)::int from public.outbox where template = 'coupon_issued' and to_email = 'member-a@example.com'),
  1, 'クーポン発行メールがキューに入る');

-- 請求書: 許可なし → 拒否、許可後 → 発行
select throws_ok($$select public.admin_create_invoice('22222222-2222-2222-2222-222222222222', array[current_setting('t.rb')], '', '', '', null)$$,
  'P0001', 'INVOICE_NOT_ALLOWED', '請求書払い未許可の会員には請求書を発行できない');
select is((public.admin_update_member('22222222-2222-2222-2222-222222222222', '{"invoice_allowed":true}'::jsonb)).invoice_allowed,
  true, '管理者は請求書払いを許可できる');
select is((public.admin_create_invoice('22222222-2222-2222-2222-222222222222', array[current_setting('t.rb')], '会員B商店', '北見市', '', null)).amount,
  7700, '請求額は対象予約の合計');
select throws_ok($$select public.admin_create_invoice('22222222-2222-2222-2222-222222222222', array[current_setting('t.rb')], '', '', '', null)$$,
  'P0001', 'RESERVATIONS_NOT_INVOICEABLE', '請求済みの予約は二重に請求できない');
select throws_ok($$select public.admin_create_invoice('22222222-2222-2222-2222-222222222222', array[current_setting('t.ra')], '', '', '', null)$$,
  'P0001', 'RESERVATIONS_NOT_INVOICEABLE', '他の会員の予約は請求に含められない');

-- 貸出停止枠 (整備)
select is((public.admin_create_reservation(jsonb_build_object('kind', 'block', 'asset_id', 'V004',
  'start_at', current_setting('t.base')::timestamptz + interval '10 days', 'end_at', current_setting('t.base')::timestamptz + interval '12 days', 'staff_note', '車検'))).kind,
  'block', '整備・車検の貸出停止枠を登録できる');
select throws_ok(
  $$select public.admin_create_reservation(jsonb_build_object(
    'asset_id', 'V004', 'customer_name', '電話予約', 'customer_email', 'tel@example.com', 'customer_phone', '0',
    'start_at', current_setting('t.base')::timestamptz + interval '11 days',
    'end_at', current_setting('t.base')::timestamptz + interval '11 days 3 hours'))$$,
  'P0001', 'AVAILABILITY_CONFLICT', '貸出停止枠と重なる予約は (スタッフ登録でも) 入らない');
select throws_ok($$select public.create_reservation_tx('{}'::jsonb)$$, '42501', null, 'スタッフでも予約確定関数 (Edge Function 専用) は直接呼べない');

-- 最後の管理者は無効化できない
select throws_ok($$select public.admin_update_staff('aaaaaaaa-0000-0000-0000-000000000001', '{"active":false}'::jsonb)$$,
  'P0001', 'LAST_ADMIN', '最後の管理者は外せない');
select ok((select count(*) from public.admin_recent_activity(20) where message like '新規予約%') >= 1, '最近の動きに新規予約が出る');
reset role;

-- ---------------------------------------------------------------------
-- 閲覧者 / 拠点限定スタッフ / 経理
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated","aal":"aal2"}';
select ok((select count(*) from public.reservations where created_at = now()) >= 5, '閲覧者は読める');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"staff_note":"x"}'::jsonb)$$, current_setting('t.rb')),
  'P0001', 'FORBIDDEN', '閲覧者は予約を変更できない');
select throws_ok($$insert into public.locations (id, name) values ('loc-test', 'テスト')$$, '42501', null, '閲覧者はカタログを書けない');
select is((select count(*)::int from public.staff), 1, '閲覧者は他のスタッフを見られない');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000003","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.reservations where location_id = 'loc-kitami'), 0, '釧路限定スタッフには北見の予約が見えない');
select is((select count(*)::int from public.reservations where location_id = 'loc-kushiro' and created_at = now()), 1, '釧路の予約は見える');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"staff_note":"x"}'::jsonb)$$, current_setting('t.rb')),
  'P0001', 'FORBIDDEN', '他拠点の予約は変更できない');
select is((public.admin_update_reservation(current_setting('t.rk'), '{"staff_note":"鍵は2番"}'::jsonb)).staff_note, '鍵は2番', '担当拠点の予約は変更できる');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000004","role":"authenticated","aal":"aal2"}';
select is((public.admin_update_reservation(current_setting('t.rk'), '{"payment_status":"paid"}'::jsonb)).payment_status, 'paid', '経理は入金状態を変えられる');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"status":"cancelled"}'::jsonb)$$, current_setting('t.rk')),
  'P0001', 'FORBIDDEN', '経理は予約状態を変えられない');
select is((select count(*)::int from public.audit_log), 0, '経理は監査ログを読めない (管理者のみ)');
reset role;

-- ---------------------------------------------------------------------
-- ゲスト照会・取消 (service_role 相当 = postgres)
-- ---------------------------------------------------------------------
select is((public.get_reservation_for_guest(current_setting('t.rk'), 'hash-k')) ->> 'id', current_setting('t.rk'), '照会キーが合えば予約を返す');
select ok(not (public.get_reservation_for_guest(current_setting('t.rk'), 'hash-k') ? 'guest_token_hash'), '照会結果に照会キーのハッシュを含めない');
select throws_ok(format($$select public.get_reservation_for_guest(%L, 'wrong')$$, current_setting('t.rk')),
  'P0001', 'NOT_FOUND', '照会キーが違えば見つからない扱い');

-- 会員Aの新しい予約にクーポンを使い、取り消すとクーポンが戻る
select set_config('t.coupon', (select id::text from public.coupons where user_id = '11111111-1111-1111-1111-111111111111' limit 1), false);
select set_config('t.rc', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-coupon-use-0001', 'request_hash', 'hc', 'asset_id', 'V001',
  'user_id', '11111111-1111-1111-1111-111111111111', 'coupon_id', current_setting('t.coupon'), 'coupon_amount', 1000,
  'start_at', current_setting('t.base')::timestamptz + interval '30 days', 'end_at', current_setting('t.base')::timestamptz + interval '31 days',
  'customer', jsonb_build_object('name', '会員A', 'email', 'member-a@example.com', 'phone', '0'),
  'total', 6700)) #>> '{reservation,id}'), false);
select ok((select used_at is not null from public.coupons where id = current_setting('t.coupon')::uuid), 'クーポンは予約で使用済みになる');
select throws_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-coupon-reuse-01', 'request_hash', 'x', 'asset_id', 'V004',
    'user_id', '11111111-1111-1111-1111-111111111111', 'coupon_id', current_setting('t.coupon'), 'coupon_amount', 1000,
    'start_at', current_setting('t.base')::timestamptz + interval '40 days', 'end_at', current_setting('t.base')::timestamptz + interval '41 days',
    'customer', jsonb_build_object('name', 'A', 'email', 'a@example.com', 'phone', '0'), 'total', 1))$$,
  'P0001', 'COUPON_INVALID', '使用済みクーポンは使えない');
select throws_ok(
  $$select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-coupon-other-01', 'request_hash', 'x', 'asset_id', 'V004',
    'user_id', '22222222-2222-2222-2222-222222222222', 'coupon_id', current_setting('t.coupon'), 'coupon_amount', 1000,
    'start_at', current_setting('t.base')::timestamptz + interval '50 days', 'end_at', current_setting('t.base')::timestamptz + interval '51 days',
    'customer', jsonb_build_object('name', 'B', 'email', 'b@example.com', 'phone', '0'), 'total', 1))$$,
  'P0001', 'COUPON_INVALID', '他人のクーポンは使えない');
select is((public.cancel_reservation_tx(current_setting('t.rc'), null, '11111111-1111-1111-1111-111111111111', 0, '[]'::jsonb)) ->> 'status',
  'cancelled', '会員本人は予約を取り消せる');
select ok((select used_at is null from public.coupons where id = current_setting('t.coupon')::uuid), '取消でクーポンが戻る');
select throws_ok(format($$select public.cancel_reservation_tx(%L, null, '22222222-2222-2222-2222-222222222222', 0)$$, current_setting('t.ra')),
  'P0001', 'NOT_FOUND', '他人の予約は取り消せない');

-- ---------------------------------------------------------------------
-- メール確認で過去のゲスト予約を紐付ける
-- ---------------------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_user_meta_data)
values ('33333333-3333-3333-3333-333333333333', 'guest-c@example.com', 'authenticated', 'authenticated',
        '{"account_type":"member","name":"ゲスト 太郎"}');
select is((select user_id from public.reservations where id = current_setting('t.rk')), null, 'メール未確認のうちは紐付けない');
update auth.users set email_confirmed_at = now() where id = '33333333-3333-3333-3333-333333333333';
select is((select user_id from public.reservations where id = current_setting('t.rk')),
  '33333333-3333-3333-3333-333333333333'::uuid, 'メール確認後に同じアドレスのゲスト予約が会員に紐付く');

-- ---------------------------------------------------------------------
-- 監査ログ・キュー・レート制限・ポイント失効・カレンダー同期
-- ---------------------------------------------------------------------
select ok((select count(*) from public.audit_log where table_name = 'reservations' and row_id = current_setting('t.ra')) >= 3,
  '予約の作成・状態変更が監査ログに残る');
select ok(not exists (select 1 from public.audit_log
                       where (diff ? 'customer_email' and diff ->> 'customer_email' <> '***')
                          or (diff ? 'customer_phone' and diff ->> 'customer_phone' <> '***')
                          or (diff ? 'guest_token_hash' and diff ->> 'guest_token_hash' <> '***')),
  '監査ログに連絡先・照会キーを残さない (変更があっても *** で記録)');
select ok((select actor_role from public.audit_log where table_name = 'reservations' and row_id = current_setting('t.ra')
           and diff ? 'status' order by id desc limit 1) = 'admin', '監査ログに操作者の役割が残る');

select ok((select count(*) from public.outbox_claim(5)) >= 1, 'キューから送信対象を取り出せる');
select ok((select count(*) from public.outbox where status = 'sending') >= 1, '取り出したものは送信中 (sending) になる');
select lives_ok($$select public.outbox_mark((select min(id) from public.outbox where status = 'sending'), 'failed', 'テスト失敗')$$, '失敗を記録できる');
select ok((select next_attempt_at > now() from public.outbox where last_error = 'テスト失敗'), '失敗は時間を空けて再試行');

select ok(public.hit_rate_limit('test:ip', 2, 600), 'レート制限 1回目 OK');
select ok(public.hit_rate_limit('test:ip', 2, 600), 'レート制限 2回目 OK');
select ok(not public.hit_rate_limit('test:ip', 2, 600), 'レート制限 3回目は拒否');

update public.members set last_use_at = now() - interval '13 months' where user_id = '22222222-2222-2222-2222-222222222222';
insert into public.point_ledger (user_id, delta, reason) values ('22222222-2222-2222-2222-222222222222', 4, 'テスト');
select ok(public.expire_points() >= 1, 'ポイント失効ジョブが動く');
select is(public.member_point_balance('22222222-2222-2222-2222-222222222222'), 0, '最終利用から12ヶ月超でポイント失効');

update public.app_settings set value = value || '{"enabled":true,"writeEvents":true}'::jsonb where key = 'calendar';
select set_config('t.rg', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-gcal-000000001', 'request_hash', 'hg', 'asset_id', 'K001',
  'start_at', current_setting('t.base')::timestamptz + interval '60 days', 'end_at', current_setting('t.base')::timestamptz + interval '61 days',
  'customer', jsonb_build_object('name', 'G', 'email', 'g@example.com', 'phone', '0'), 'total', 22000)) #>> '{reservation,id}'), false);
select is((select count(*)::int from public.outbox where template = 'gcal_sync' and ref_id = current_setting('t.rg')), 1,
  'カレンダー連携が有効なら予約でカレンダー同期ジョブが積まれる');
select lives_ok(format($$select public.set_reservation_gcal_events(%L, '{"pickup":{"eventId":"e1"}}'::jsonb)$$, current_setting('t.rg')),
  'カレンダー予定IDを保存できる');
select is((select version from public.reservations where id = current_setting('t.rg')), 1, '予定IDの保存では版が進まない');
select is((select count(*)::int from public.outbox where template = 'gcal_sync' and ref_id = current_setting('t.rg')), 1,
  '予定IDの保存で同期ジョブが再発火しない');

-- =====================================================================
-- セキュリティ修正 (20260923000900_security_fixes)
--   db-1: 車両の付け替えで他拠点へ予約を移せない
--   db-3: 拠点限定スタッフに他拠点だけの顧客 (会員・請求・問い合わせ・ポイント・クーポン・送信記録) を見せない
-- =====================================================================
insert into auth.users (id, email, aud, role, raw_user_meta_data, email_confirmed_at) values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'kitami@example.test', 'authenticated', 'authenticated', '{}', now()),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'account-kitami@example.test', 'authenticated', 'authenticated', '{}', now()),
  ('44444444-4444-4444-4444-444444444444', 'kushiro-only@example.com', 'authenticated', 'authenticated',
   '{"account_type":"member","name":"釧路限定会員","phone":"09044445555","company":"釧路限定商事"}', now()),
  ('55555555-5555-5555-5555-555555555555', 'no-rental@example.com', 'authenticated', 'authenticated',
   '{"account_type":"member","name":"取引なし会員"}', now());
insert into public.staff (user_id, name, role, location_ids) values
  ('aaaaaaaa-0000-0000-0000-000000000005', '北見スタッフ', 'store_staff', '{loc-kitami}'),
  ('aaaaaaaa-0000-0000-0000-000000000006', '北見経理', 'accounting', '{loc-kitami}');
update public.members set invoice_allowed = true where user_id = '44444444-4444-4444-4444-444444444444';

-- 釧路だけで取引した会員の予約 (確認メール付き) / 北見のゲスト予約 (付け替え用) /
-- 会員B (北見の顧客) の釧路の予約 / 釧路のゲスト予約
select set_config('t.rq', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-sec-kushiro-only1', 'request_hash', 'x', 'asset_id', 'V002',
  'user_id', '44444444-4444-4444-4444-444444444444',
  'start_at', current_setting('t.base')::timestamptz + interval '80 days', 'end_at', current_setting('t.base')::timestamptz + interval '81 days',
  'customer', jsonb_build_object('name', '釧路限定会員', 'email', 'kushiro-only@example.com', 'phone', '09044445555'),
  'total', 12345,
  'emails', jsonb_build_array(jsonb_build_object('template', 'reservation_confirmed', 'to', 'kushiro-only@example.com',
                                                 'payload', jsonb_build_object('name', '釧路限定会員'))))) #>> '{reservation,id}'), false);
select set_config('t.rx', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-sec-kitami-move01', 'request_hash', 'x', 'asset_id', 'V001',
  'start_at', current_setting('t.base')::timestamptz + interval '90 days', 'end_at', current_setting('t.base')::timestamptz + interval '91 days',
  'customer', jsonb_build_object('name', '北見ゲスト', 'email', 'kitami-guest@example.com', 'phone', '0'), 'total', 1)) #>> '{reservation,id}'), false);
select set_config('t.rbk', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-sec-member-b-ksr', 'request_hash', 'x', 'asset_id', 'V002',
  'user_id', '22222222-2222-2222-2222-222222222222',
  'start_at', current_setting('t.base')::timestamptz + interval '95 days', 'end_at', current_setting('t.base')::timestamptz + interval '96 days',
  'customer', jsonb_build_object('name', '会員B', 'email', 'member-b@example.com', 'phone', '0'), 'total', 5000)) #>> '{reservation,id}'), false);
select set_config('t.rgk', (public.create_reservation_tx(jsonb_build_object(
  'idempotency_key', 'k-sec-kushiro-guest', 'request_hash', 'x', 'asset_id', 'V002',
  'start_at', current_setting('t.base')::timestamptz + interval '97 days', 'end_at', current_setting('t.base')::timestamptz + interval '98 days',
  'customer', jsonb_build_object('name', '釧路ゲスト', 'email', 'kushiro-guest@example.com', 'phone', '0'), 'total', 1)) #>> '{reservation,id}'), false);

-- 釧路限定会員の請求書・クーポン・ポイント
with ins as (
  insert into public.invoices (user_id, company, address, reservation_ids, amount)
  values ('44444444-4444-4444-4444-444444444444', '釧路限定商事', '釧路市テスト1-2-3', array[current_setting('t.rq')], 12345)
  returning id)
select set_config('t.invk', (select id from ins), false);
insert into public.coupons (user_id, amount, reason) values ('44444444-4444-4444-4444-444444444444', 500, 'テスト');
insert into public.point_ledger (user_id, delta, reason) values ('44444444-4444-4444-4444-444444444444', 3, 'テスト');

-- 問い合わせ: q1 釧路の予約番号付き / q2 釧路限定会員から / q3 釧路ゲストのアドレスから /
--             q4 どこにも取引のない一般の問い合わせ / q5 北見の予約番号付き
select set_config('t.q1', (public.submit_inquiry_tx(jsonb_build_object('name', '釧路限定会員', 'email', 'kushiro-only@example.com',
  'topic', '予約', 'body', 'q1', 'reservation_id', current_setting('t.rq'))) ->> 'id'), false);
select set_config('t.q2', (public.submit_inquiry_tx(jsonb_build_object('name', '釧路限定会員', 'email', 'other@example.com',
  'topic', '会員', 'body', 'q2', 'user_id', '44444444-4444-4444-4444-444444444444')) ->> 'id'), false);
select set_config('t.q3', (public.submit_inquiry_tx(jsonb_build_object('name', '釧路ゲスト', 'email', 'KUSHIRO-GUEST@example.com',
  'topic', 'その他', 'body', 'q3')) ->> 'id'), false);
select set_config('t.q4', (public.submit_inquiry_tx(jsonb_build_object('name', '見込み客', 'email', 'prospect@example.com',
  'topic', 'その他', 'body', 'q4')) ->> 'id'), false);
select set_config('t.q5', (public.submit_inquiry_tx(jsonb_build_object('name', '会員B', 'email', 'member-b@example.com',
  'topic', '予約', 'body', 'q5', 'reservation_id', current_setting('t.rb'))) ->> 'id'), false);
select set_config('t.obk', (select min(id)::text from public.outbox where ref_type = 'reservation' and ref_id = current_setting('t.rq')), false);
select ok(current_setting('t.obk') <> '', '準備: 釧路の予約の確認メールがキューにある');

-- ---- 北見限定スタッフ (AAL2) ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000005","role":"authenticated","aal":"aal2"}';
-- db-1
select throws_ok(format($$select public.admin_update_reservation(%L, jsonb_build_object('asset_id', 'V002',
    'start', %L::timestamptz, 'end', %L::timestamptz))$$, current_setting('t.rx'),
    current_setting('t.base')::timestamptz + interval '92 days', current_setting('t.base')::timestamptz + interval '93 days'),
  'P0001', 'FORBIDDEN', 'db-1: 拠点限定スタッフは自拠点の予約を他拠点の車両へ付け替えられない');
select is((select location_id || '/' || asset_id from public.reservations where id = current_setting('t.rx')), 'loc-kitami/V001',
  'db-1: 拒否された付け替えで予約の拠点・車両は変わらない');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"asset_id":"V002","staff_note":"x"}'::jsonb)$$, current_setting('t.rx')),
  'P0001', 'FORBIDDEN', 'db-1: 期間を変えずに他拠点の車両へ付け替えるのも拒否');
select is((public.admin_update_reservation(current_setting('t.rx'), '{"asset_id":"V004"}'::jsonb)).location_id, 'loc-kitami',
  'db-1: 担当拠点内の車両への付け替えはできる');
select is((public.admin_update_reservation(current_setting('t.rx'), '{"staff_note":"確認済み"}'::jsonb)).staff_note, '確認済み',
  'db-1: 車両を変えない更新はこれまでどおりできる');
select throws_ok($$select public.admin_create_reservation(jsonb_build_object('asset_id', 'V003',
    'user_id', '44444444-4444-4444-4444-444444444444', 'customer_name', 'x',
    'start_at', current_setting('t.base')::timestamptz + interval '85 days',
    'end_at', current_setting('t.base')::timestamptz + interval '86 days'))$$,
  'P0001', 'FORBIDDEN', 'db-3: 見えない会員を自拠点の予約に紐付けられない');
-- db-3: 読み取り
select is((select count(*)::int from public.members where user_id = '44444444-4444-4444-4444-444444444444'), 0,
  'db-3: 他拠点だけで取引した会員は見えない');
select is((select count(*)::int from public.members where user_id = '11111111-1111-1111-1111-111111111111'), 1,
  'db-3: 担当拠点で取引のある会員は見える');
select is((select count(*)::int from public.members where user_id = '22222222-2222-2222-2222-222222222222'), 1,
  'db-3: 担当拠点と他拠点の両方で取引のある会員は見える');
select is((select count(*)::int from public.members where user_id = '55555555-5555-5555-5555-555555555555'), 1,
  'db-3: どの拠点とも取引のない会員は見える (電話予約で選ぶため)');
select is((select count(*)::int from public.member_points where user_id = '44444444-4444-4444-4444-444444444444'), 0,
  'db-3: 見えない会員のポイント残高も見えない');
select is((select count(*)::int from public.invoices where id = current_setting('t.invk')), 0,
  'db-3: 他拠点の予約だけの請求書は見えない');
select is((select count(*)::int from public.invoices where user_id = '22222222-2222-2222-2222-222222222222'), 1,
  'db-3: 担当拠点の予約の請求書は見える');
select is((select count(*)::int from public.inquiries where id in (current_setting('t.q1'), current_setting('t.q2'), current_setting('t.q3'))), 0,
  'db-3: 他拠点の予約番号付き・他拠点だけの会員から・他拠点だけのゲストからの問い合わせは見えない');
select is((select count(*)::int from public.inquiries where id in (current_setting('t.q4'), current_setting('t.q5'))), 2,
  'db-3: 一般の問い合わせと担当拠点の予約の問い合わせは見える');
select is((select count(*)::int from public.coupons where user_id = '44444444-4444-4444-4444-444444444444'), 0,
  'db-3: 見えない会員のクーポンは見えない');
select is((select count(*)::int from public.point_ledger where user_id = '44444444-4444-4444-4444-444444444444'), 0,
  'db-3: 見えない会員のポイント履歴は見えない');
select is((select count(*)::int from public.outbox where ref_id in (current_setting('t.rq'), current_setting('t.q1'))), 0,
  'db-3: 他拠点の顧客へのメール送信記録は見えない');
select is((select count(*)::int from public.outbox where template = 'coupon_issued' and to_email = 'member-a@example.com'), 1,
  'db-3: 担当拠点の顧客へのメール送信記録は見える');
select is((select count(*)::int from public.admin_recent_activity(200)
            where message like '%釧路限定会員%' or ref_id in (current_setting('t.invk'), current_setting('t.q1'),
                                                               current_setting('t.q2'), current_setting('t.q3'))), 0,
  'db-3: 最近の動きに他拠点だけの顧客の登録・請求書・問い合わせが出ない');
select is((select count(*)::int from public.admin_recent_activity(200) where ref_id = current_setting('t.q4')), 1,
  'db-3: 最近の動きに一般の問い合わせは出る');
-- db-3: 書き込み
select throws_ok($$select public.admin_update_member('44444444-4444-4444-4444-444444444444', '{"name":"改ざん"}'::jsonb)$$,
  'P0001', 'FORBIDDEN', 'db-3: 見えない会員は編集できない');
select throws_ok($$select public.admin_adjust_points('44444444-4444-4444-4444-444444444444', 5, 'x')$$,
  'P0001', 'FORBIDDEN', 'db-3: 見えない会員のポイントは変えられない');
select throws_ok($$select public.admin_issue_coupon('44444444-4444-4444-4444-444444444444', 500, 'x')$$,
  'P0001', 'FORBIDDEN', 'db-3: 見えない会員にクーポンを発行できない');
select throws_ok(format($$select public.admin_update_inquiry(%L, '{"staff_note":"x"}'::jsonb)$$, current_setting('t.q1')),
  'P0001', 'FORBIDDEN', 'db-3: 見えない問い合わせは更新できない');
select throws_ok(format($$select public.admin_retry_outbox(%s)$$, current_setting('t.obk')),
  'P0001', 'FORBIDDEN', 'db-3: 他拠点の顧客へのメールは再送できない');
select is((public.admin_update_member('55555555-5555-5555-5555-555555555555', '{"phone":"0120000000"}'::jsonb)).phone, '0120000000',
  'db-3: 取引のない会員は編集できる (招待直後の設定など)');
select is((public.admin_update_inquiry(current_setting('t.q4'), '{"status":"in_progress"}'::jsonb)).status, 'in_progress',
  'db-3: 一般の問い合わせは対応できる');
reset role;
select is((select name from public.members where user_id = '44444444-4444-4444-4444-444444444444'), '釧路限定会員',
  'db-3: 拒否された編集で会員情報は変わらない');

-- ---- 北見限定の経理 (AAL2) ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(format($$select public.admin_set_invoice_status(%L, 'paid')$$, current_setting('t.invk')),
  'P0001', 'FORBIDDEN', 'db-3: 他拠点の予約の請求書は状態を変えられない');
select throws_ok($$select public.admin_create_invoice('22222222-2222-2222-2222-222222222222', array[current_setting('t.rbk')], '', '', '', null)$$,
  'P0001', 'FORBIDDEN', 'db-3: 他拠点の予約を含む請求書は発行できない');
reset role;

-- ---- 釧路限定スタッフ (AAL2) からは逆に見える ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000003","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.members where user_id = '44444444-4444-4444-4444-444444444444'), 1,
  'db-3: 取引拠点のスタッフには会員が見える');
select is((select count(*)::int from public.invoices where id = current_setting('t.invk')), 1,
  'db-3: 取引拠点のスタッフには請求書が見える');
select is((select count(*)::int from public.inquiries where id in (current_setting('t.q1'), current_setting('t.q2'), current_setting('t.q3'), current_setting('t.q4'))), 4,
  'db-3: 取引拠点のスタッフには問い合わせが見える');
select is((select count(*)::int from public.inquiries where id = current_setting('t.q5')), 0,
  'db-3: 他拠点の予約番号付きの問い合わせは見えない (釧路側)');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"asset_id":"V001"}'::jsonb)$$, current_setting('t.rq')),
  'P0001', 'FORBIDDEN', 'db-1: 釧路限定スタッフも北見の車両へは付け替えられない');
reset role;

-- ---- 全拠点の管理者 (AAL2) はこれまでどおり ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.inquiries where id in (current_setting('t.q1'), current_setting('t.q2'), current_setting('t.q3'),
                                                                  current_setting('t.q4'), current_setting('t.q5'))), 5,
  '管理者はすべての問い合わせを読める');
select is((select count(*)::int from public.members where user_id = '44444444-4444-4444-4444-444444444444'), 1, '管理者はすべての会員を読める');
select ok((select count(*) from public.admin_recent_activity(200) where message like '新規会員登録: 釧路限定会員%') = 1,
  '管理者の最近の動きには全拠点の会員登録が出る');
select is((public.admin_update_reservation(current_setting('t.rx'), '{"asset_id":"V002"}'::jsonb)).location_id, 'loc-kushiro',
  '全拠点の管理者は予約を他拠点の車両へ付け替えられる');
reset role;

-- ---- 会員本人は自分の行を読める (拠点の絞り込みの影響を受けない) ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.members), 1, '会員は自分の会員情報を読める');
select is((select count(*)::int from public.invoices), 1, '会員は自分の請求書を読める');
select is((select count(*)::int from public.inquiries), 0, '会員は問い合わせ表を読めない');
reset role;

-- ---- 追加したヘルパーは匿名から呼べない ----
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select public.staff_can_member('44444444-4444-4444-4444-444444444444')$$, '42501', null, '匿名は拠点判定ヘルパーを呼べない');
reset role;

-- ポイント手動調整の上限 (クーポン自動交換による金券の大量発行を防ぐ)
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.admin_adjust_points('22222222-2222-2222-2222-222222222222', 5000, '大量付与')$$,
  'P0001', 'INVALID_DELTA', '1回のポイント調整は±100ptまで');
select throws_ok($$select public.admin_adjust_points('22222222-2222-2222-2222-222222222222', 5, '')$$,
  'P0001', 'VALIDATION', 'ポイント調整には理由が必須');
reset role;

-- =====================================================================
-- 家電レンタル (家電だけのレンタル) と家電の在庫 (20261002000100_item_rental)
--   ここの予約は 120 日先 (上のテストの 300 日先・結合テストの 150〜390 日先と重ならない)
-- =====================================================================
select set_config('t.ib', (date_trunc('hour', now()) + interval '120 days')::text, true);
-- 予約を作る (service_role 相当 = postgres)。返り値は予約の行 (jsonb)
create function pg_temp.res_at(p_key text, p_asset text, p_opts text[], p_from interval, p_to interval) returns jsonb
language sql as $$
  select public.create_reservation_tx(jsonb_build_object(
    'idempotency_key', 'k-item-' || p_key || '-0000000', 'request_hash', 'x', 'asset_id', p_asset,
    'option_ids', to_jsonb(p_opts),
    'start_at', current_setting('t.ib')::timestamptz + p_from, 'end_at', current_setting('t.ib')::timestamptz + p_to,
    'customer', jsonb_build_object('name', '家電 ' || p_key, 'email', 'item-' || p_key || '@example.com', 'phone', '0'),
    'total', 1)) -> 'reservation'
$$;
create function pg_temp.ib(p interval) returns timestamptz language sql as $$
  select current_setting('t.ib')::timestamptz + p
$$;

-- ---- カタログ・料金ルール (seed) ----
select results_eq(
  $$select id, name, name_en, type, icon, sort, custom_field_defs, active from public.categories where id = 'cat-appliance'$$,
  $$values ('cat-appliance', '家電レンタル', 'Appliance Rental', 'item', '🔌', 3, '[]'::jsonb, true)$$,
  '家電レンタルのカテゴリ (物品レンタル)');
select results_eq(
  $$select id, category_id, location_id, name, name_en, capacity, price_hour, price_day, image, sort, active from public.assets where id = 'A001'$$,
  $$values ('A001', 'cat-appliance', 'loc-kitami', '家電レンタル（北見本店）', 'Appliance Rental (Kitami)', null::int, null::int, 0, '🔌', 7, true)$$,
  '家電レンタルの受け取り窓口 A001 (北見本店・基本料金 0)');
select results_eq(
  $$select id, stock from public.options order by sort, id$$,
  $$values ('OP101', null::int), ('OP102', null), ('OP201', null), ('OP202', null),
           ('OP001', 1), ('OP002', 1), ('OP003', 1), ('OP004', 1), ('OP005', 1), ('OP006', 1),
           ('OP007', 1), ('OP008', 1), ('OP009', 1), ('OP010', null), ('OP011', 1)$$,
  '在庫: 装備は各1・家電セットは中の9品目の在庫を使う (null)・補償は数えない (null)');
select is((select value ->> 'version' from public.app_settings where key = 'pricing_rules'), '2026-10', '料金ルールは 2026-10 版');
select is((select value #> '{cancellation,categoryClass,cat-appliance}' from public.app_settings where key = 'pricing_rules'),
  '"item"'::jsonb, 'キャンセル料: 家電レンタルの区分は item');
select is((select jsonb_build_array(value #> '{cancellation,normal,item}', value #> '{cancellation,busy,item}', value -> 'itemSurcharges')
             from public.app_settings where key = 'pricing_rules'),
  '[[{"minDays":3,"pct":0},{"minDays":1,"pct":30},{"minDays":0,"pct":50}],[{"minDays":7,"pct":0},{"minDays":1,"pct":30},{"minDays":0,"pct":50}],false]'::jsonb,
  'キャンセル料の段階はコンパクトカーと同じ割合・家電レンタルに割増はかけない');
select ok(exists (select 1 from jsonb_array_elements(public.public_catalog() -> 'assets') a where a ->> 'id' = 'A001'),
  '公開カタログに家電レンタルの受け取り窓口が出る');

-- ---- is_item の自動設定・窓口には同じ時間に何件でも入る ----
select set_config('t.i1', pg_temp.res_at('i1', 'A001', array['OP002'], '0 hours', '24 hours') ->> 'id', true);
select set_config('t.i2', pg_temp.res_at('i2', 'A001', array['OP008'], '0 hours', '24 hours') ->> 'id', true);
select ok((select is_item from public.reservations where id = current_setting('t.i1')), 'is_item: 家電レンタルのカテゴリの予約は true (トリガー)');
select ok(not (select is_item from public.reservations where id = current_setting('t.ra')), 'is_item: 車両の予約は false');
update public.reservations set is_item = false where id = current_setting('t.i1');
select ok((select is_item from public.reservations where id = current_setting('t.i1')), 'is_item: 直接書き換えてもカテゴリから正しい値に戻る');
select is((select count(*)::int from public.reservations
            where asset_id = 'A001' and status = 'confirmed' and period @> pg_temp.ib('1 hour')), 2,
  '受け取り窓口 A001 には同じ時間に2件の予約が入る (車両の重なり禁止を掛けない)');
select throws_ok($$select pg_temp.res_at('i0', 'A001', array[]::text[], '30 hours', '31 hours')$$,
  'P0001', 'ITEM_REQUIRED', '家電レンタルは家電 (オプション) を1つ以上選ぶ');
select throws_ok($$select pg_temp.res_at('ic', 'A001', array['OP101'], '30 hours', '31 hours')$$,
  'P0001', 'OPTION_INVALID', '補償 (車両専用) は家電レンタルに付けられない');

-- ---- 在庫1の家電が重なると OPTION_SOLD_OUT ----
select throws_ok($$select pg_temp.res_at('i3', 'A001', array['OP002'], '12 hours', '36 hours')$$,
  'P0001', 'OPTION_SOLD_OUT', '在庫1の電子レンジが貸出中の時間には、家電だけの予約を入れられない');
select is(public.option_sold_out(array['OP002', 'OP003'], tstzrange(pg_temp.ib('12 hours'), pg_temp.ib('36 hours'))),
  array['OP002'], '在庫の判定: 売り切れの家電の id だけを返す (空いている家電は含めない)');
select is(public.option_sold_out(array['OP003'], tstzrange(pg_temp.ib('12 hours'), pg_temp.ib('36 hours'))),
  '{}'::text[], '在庫の判定: 空いていれば空配列');
-- 車両の予約のオプション × 家電だけの予約 (同じ在庫を使う)
select throws_ok($$select pg_temp.res_at('v1', 'V003', array['OP008'], '20 hours', '30 hours')$$,
  'P0001', 'OPTION_SOLD_OUT', '家電だけの予約で貸出中の炊飯器は、車両の予約のオプションにも付けられない');
select set_config('t.v2', pg_temp.res_at('v2', 'V003', array['OP004'], '48 hours', '72 hours') ->> 'id', true);
select ok(current_setting('t.v2') like 'R%', '車両の予約にポータブル電源を付けられる');
select throws_ok($$select pg_temp.res_at('i4', 'A001', array['OP004'], '60 hours', '62 hours')$$,
  'P0001', 'OPTION_SOLD_OUT', '車両の予約のオプションで貸出中のポータブル電源は、家電だけの予約でも借りられない');
-- 家電セット × 中の品目
select throws_ok($$select pg_temp.res_at('i5', 'A001', array['OP010'], '6 hours', '8 hours')$$,
  'P0001', 'OPTION_SOLD_OUT', '中の品目 (電子レンジ・炊飯器) が貸出中なら家電セットは借りられない');
select is(public.option_sold_out(array['OP010'], tstzrange(pg_temp.ib('6 hours'), pg_temp.ib('8 hours'))),
  array['OP002', 'OP008', 'OP010'], '家電セットを選んだときは、売り切れの中の品目とセット自身の id を返す');
select set_config('t.i6', pg_temp.res_at('i6', 'A001', array['OP010'], '100 hours', '124 hours') ->> 'id', true);
select throws_ok($$select pg_temp.res_at('i7', 'V001', array['OP005'], '110 hours', '112 hours')$$,
  'P0001', 'OPTION_SOLD_OUT', '家電セットを貸出中なら、中の品目 (ドラムリール) は単品でも借りられない (車両のオプションでも)');
select lives_ok($$select pg_temp.res_at('i7b', 'V001', array['OP011'], '110 hours', '112 hours')$$,
  'セットに含まれない家電 (集客セット) は借りられる');
-- 重ならない時間なら通る (半開区間: 返却時刻ちょうどから)
select set_config('t.i8', pg_temp.res_at('i8', 'A001', array['OP002'], '24 hours', '30 hours') ->> 'id', true);
select ok(current_setting('t.i8') like 'R%', '返却時刻ちょうどからなら同じ家電を借りられる');

-- ---- 在庫2なら同時に2台まで (同時に貸し出している数の最大で数える) ----
update public.options set stock = 2 where id = 'OP003';
select lives_ok($$select pg_temp.res_at('s1', 'A001', array['OP003'], '200 hours', '210 hours')$$, '在庫2: 1台目');
select lives_ok($$select pg_temp.res_at('s2', 'A001', array['OP003'], '220 hours', '230 hours')$$, '在庫2: 別の時間の1台');
select lives_ok($$select pg_temp.res_at('s3', 'A001', array['OP003'], '205 hours', '225 hours')$$,
  '在庫2: 重なる予約が2件あっても、同時に貸し出すのが最大2台なら借りられる');
select throws_ok($$select pg_temp.res_at('s4', 'A001', array['OP003'], '206 hours', '207 hours')$$,
  'P0001', 'OPTION_SOLD_OUT', '在庫2: 同時に2台貸し出している時間には3台目を借りられない');
select lives_ok($$select pg_temp.res_at('s5', 'A001', array['OP003'], '211 hours', '219 hours')$$,
  '在庫2: 1台だけ貸し出している時間なら借りられる');
update public.options set stock = null where id = 'OP003';
select lives_ok($$select pg_temp.res_at('s6', 'A001', array['OP003'], '206 hours', '207 hours')$$,
  '在庫を数えない (null) 家電は何台でも借りられる');
update public.options set stock = 1 where id = 'OP003';

-- ---- 日時変更 (admin_update_reservation)・キャンセル済み・スタッフの登録 ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select is((public.admin_update_reservation(current_setting('t.i1'),
            jsonb_build_object('start', pg_temp.ib('1 hour'), 'end', pg_temp.ib('23 hours')))).start_at,
  pg_temp.ib('1 hour'), '日時変更: 自分自身は数えない (元の時間と重なる時間へ動かせる)');
select throws_ok(format($$select public.admin_update_reservation(%L, jsonb_build_object('start', %L::timestamptz, 'end', %L::timestamptz))$$,
    current_setting('t.i8'), pg_temp.ib('20 hours'), pg_temp.ib('30 hours')),
  'P0001', 'OPTION_SOLD_OUT', '日時変更でも在庫を確認する (電子レンジが貸出中の時間へは動かせない)');
select is((select start_at from public.reservations where id = current_setting('t.i8')), pg_temp.ib('24 hours'),
  '在庫切れで断られた日時変更では予約は変わらない');
select is((public.admin_update_reservation(current_setting('t.i8'), '{"staff_note":"確認済み"}'::jsonb)).staff_note, '確認済み',
  '日時を変えない更新では在庫を確認しない');
select is((public.admin_update_reservation(current_setting('t.i1'), '{"status":"cancelled","notify":false}'::jsonb)).status, 'cancelled',
  '家電レンタルの予約を取り消せる');
reset role;
select set_config('t.i9', pg_temp.res_at('i9', 'A001', array['OP002'], '2 hours', '4 hours') ->> 'id', true);
select ok(current_setting('t.i9') like 'R%', 'キャンセル済みの予約の家電は数えない (同じ時間に借りられる)');
select is(public.unavailable_option_ids(pg_temp.ib('2 hours'), pg_temp.ib('3 hours')),
  array['OP002', 'OP008', 'OP010'], '見積用: その期間に貸し出せない家電 (家電セットは中身のどれかが残り0なら含める)');
select is(public.unavailable_option_ids(pg_temp.ib('2 hours'), pg_temp.ib('3 hours'), current_setting('t.i9')),
  array['OP008', 'OP010'], '見積用: 指定した予約 (変更中の自分) は数えない');
select is(public.unavailable_option_ids(pg_temp.ib('300 hours'), pg_temp.ib('301 hours')), '{}'::text[],
  '見積用: 何も貸し出していない時間は空配列');
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok(format($$select public.admin_update_reservation(%L, '{"status":"confirmed"}'::jsonb)$$, current_setting('t.i1')),
  'P0001', 'OPTION_SOLD_OUT', 'キャンセルからの戻しでも在庫を確認する (同じ時間に別の予約が電子レンジを借りている)');
select throws_ok($$select public.admin_create_reservation(jsonb_build_object('kind', 'block', 'asset_id', 'A001',
    'start_at', pg_temp.ib('400 hours'), 'end_at', pg_temp.ib('410 hours'), 'staff_note', '棚卸し'))$$,
  'P0001', 'VALIDATION', '家電レンタルには貸出停止枠を作れない (家電ごとの在庫はオプション管理で変える)');
select throws_ok($$select public.admin_create_reservation(jsonb_build_object('asset_id', 'A001', 'option_ids', jsonb_build_array('OP008'),
    'customer_name', '電話予約', 'customer_email', 'tel@example.com', 'customer_phone', '0',
    'start_at', pg_temp.ib('1 hour'), 'end_at', pg_temp.ib('2 hours')))$$,
  'P0001', 'OPTION_SOLD_OUT', 'スタッフの予約登録でも在庫を確認する');
select throws_ok($$select public.admin_create_reservation(jsonb_build_object('asset_id', 'A001',
    'customer_name', '電話予約', 'customer_email', 'tel@example.com', 'customer_phone', '0',
    'start_at', pg_temp.ib('1 hour'), 'end_at', pg_temp.ib('2 hours')))$$,
  'P0001', 'ITEM_REQUIRED', 'スタッフの登録でも家電レンタルは家電を1つ以上');
select is((public.admin_create_reservation(jsonb_build_object('asset_id', 'A001', 'option_ids', jsonb_build_array('OP009'),
    'customer_name', '電話予約', 'customer_email', 'tel@example.com', 'customer_phone', '0',
    'start_at', pg_temp.ib('1 hour'), 'end_at', pg_temp.ib('2 hours')))).is_item,
  true, 'スタッフも家電レンタルの予約を登録できる (同じ時間でも別の家電なら入る)');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"asset_id":"A001"}'::jsonb)$$, current_setting('t.v2')),
  'P0001', 'VALIDATION', '車両の予約を家電レンタルの窓口へ付け替えられない');
select throws_ok(format($$select public.admin_update_reservation(%L, '{"asset_id":"V004"}'::jsonb)$$, current_setting('t.i8')),
  'P0001', 'VALIDATION', '家電レンタルの予約を車両へ付け替えられない');
-- 在庫の判定関数はスタッフでも直接呼べない (Edge Function と RPC の中からだけ)
select throws_ok($$select public.option_sold_out(array['OP002'], tstzrange(now(), now() + interval '1 day'))$$,
  '42501', null, 'ログイン中のスタッフも在庫の判定関数 (option_sold_out) を直接呼べない');
select throws_ok($$select public.unavailable_option_ids(now(), now() + interval '1 day')$$,
  '42501', null, 'ログイン中のスタッフも在庫の判定関数 (unavailable_option_ids) を直接呼べない');
reset role;

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select public.option_sold_out(array['OP002'], tstzrange(now(), now() + interval '1 day'))$$,
  '42501', null, '匿名は在庫の判定関数 (option_sold_out) を呼べない');
select throws_ok($$select public.unavailable_option_ids(now(), now() + interval '1 day')$$,
  '42501', null, '匿名は在庫の判定関数 (unavailable_option_ids) を呼べない');
select is((select count(*)::int from public.public_busy_ranges(pg_temp.ib('-1 day'), pg_temp.ib('15 days')) where asset_id = 'A001'), 0,
  '空き表示 (public_busy_ranges) に家電レンタルの予約は出ない');
select ok((select count(*) from public.public_busy_ranges(pg_temp.ib('-1 day'), pg_temp.ib('15 days')) where asset_id = 'V003') >= 1,
  '空き表示に車両の予約はこれまでどおり出る');
reset role;

-- ---- 車両の重なり禁止は従来どおり・カテゴリの種類の変更 ----
select throws_ok($$select pg_temp.res_at('vv', 'V003', array[]::text[], '50 hours', '51 hours')$$,
  'P0001', 'AVAILABILITY_CONFLICT', '車両の重なり禁止は従来どおり (家電の在庫とは別)');
select ok((select pg_get_constraintdef(oid) from pg_constraint where conname = 'reservations_no_overlap') like '%NOT is_item%',
  '重なり禁止の排他制約は家電レンタルの予約を除く');
select throws_ok($$update public.categories set type = 'vehicle' where id = 'cat-appliance'$$,
  'P0001', 'VALIDATION', '同じ時間に重なる予約がある家電レンタルのカテゴリは、車両レンタルに変えられない');
select is((select type from public.categories where id = 'cat-appliance'), 'item', '断られた変更でカテゴリの種類は変わらない');

-- ---- 会員の予約一覧に is_item ----
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","aal":"aal1"}';
select ok((public.member_reservations() -> 0) ? 'is_item', '会員の予約一覧に家電レンタルかどうか (is_item) が入る');
reset role;

-- =====================================================================
-- 貸渡証 (= 貸渡簿の1行): rental_records と admin_save_rental_record
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select is((public.admin_save_rental_record(current_setting('t.ra'), jsonb_build_object(
  'renter_name', '会員A', 'renter_address', '北海道北見市テスト1-1', 'license_type', '普通', 'license_no', '123456789012',
  'birth_date', '1990-04-01', 'plate', '北見300 わ 1234', 'passengers', '2', 'destination', '北見市内', 'odometer_out', '15000'))).version,
  1, '貸渡証: 管理者は保存できる (版 1)');
select is((public.admin_save_rental_record(current_setting('t.ra'), '{"odometer_in":"15420","accident":false}'::jsonb, 1)).distance_km,
  420, '貸渡証: 返却時メーターを足すと走行キロ数 (420 km) が出る・ほかの項目はそのまま');
select is((select renter_name || '/' || license_no from public.rental_records where id = current_setting('t.ra')), '会員A/123456789012',
  '貸渡証: 一部の項目だけの保存で、ほかの項目は消えない');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"remarks":"x"}'::jsonb, 1)$$, current_setting('t.ra')),
  'P0001', 'VERSION_CONFLICT', '貸渡証: 古い版のまま保存すると VERSION_CONFLICT');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"odometer_in":"14000"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'VALIDATION', '貸渡証: 返却時メーターが貸出時メーターより小さいと保存できない');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"passengers":"abc"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'VALIDATION', '貸渡証: 数字の欄に数字以外は入らない');
select throws_ok(format($$select public.admin_save_rental_record(%L, jsonb_build_object('renter_name', repeat('あ', 101)))$$, current_setting('t.ra')),
  'P0001', 'VALIDATION', '貸渡証: 文字数の上限を超えると保存できない');
select throws_ok($$select public.admin_save_rental_record('R99999999', '{}'::jsonb)$$, 'P0001', 'NOT_FOUND', '貸渡証: 無い予約には作れない');
select is((select count(*)::int from public.rental_records where id = current_setting('t.ra')), 1, '貸渡証: 担当拠点のスタッフは読める');
reset role;
-- 変更履歴に運転免許の番号・生年月日の値を残さない
select ok(not exists (select 1 from public.audit_log where table_name = 'rental_records'
                       and (diff ->> 'license_no' = '123456789012' or diff ->> 'birth_date' = '1990-04-01')),
  '貸渡証: 変更履歴に運転免許の番号・生年月日を残さない');
select ok(exists (select 1 from public.audit_log where table_name = 'rental_records' and row_id = current_setting('t.ra')),
  '貸渡証: 変更履歴 (audit_log) に残る');

-- 閲覧のみのスタッフは読めるが保存できない
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.rental_records where id = current_setting('t.ra')), 1, '貸渡証: 閲覧のみのスタッフも読める');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"remarks":"x"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'FORBIDDEN', '貸渡証: 閲覧のみのスタッフは保存できない');
reset role;
-- 他の拠点の担当 (釧路限定) は、北見の予約の貸渡証を読めず、保存もできない
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000003","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.rental_records where id = current_setting('t.ra')), 0, '貸渡証: 他の拠点の担当は読めない');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"remarks":"x"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'FORBIDDEN', '貸渡証: 他の拠点の担当は保存できない');
reset role;
-- 二段階認証の前 (AAL1) の管理者は保存できない
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"remarks":"x"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'FORBIDDEN', '貸渡証: 二段階認証の前は保存できない');
reset role;
-- 会員・匿名は読めない
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.rental_records), 0, '貸渡証: 会員 (自分の予約でも) は読めない');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{"remarks":"x"}'::jsonb)$$, current_setting('t.ra')),
  'P0001', 'FORBIDDEN', '貸渡証: 会員は保存できない');
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok('select count(*) from public.rental_records', '42501', null, '貸渡証: 匿名は読めない');
select throws_ok(format($$select public.admin_save_rental_record(%L, '{}'::jsonb)$$, current_setting('t.ra')), '42501', null, '貸渡証: 匿名は保存の関数を呼べない');
reset role;
-- 予約を消すと貸渡証も消える (外部キー)
select is((select confdeltype from pg_constraint where conname = 'rental_records_id_fkey')::text, 'c', '貸渡証: 予約を消すと一緒に消える');

select * from finish();
rollback;
