-- =====================================================================
-- DB の権限 (RLS) と業務ロジックの自動テスト (pgTAP)
--   実行: supabase test db
--   すべて1トランザクション内で行い、最後に rollback するので DB は汚れない。
-- =====================================================================
begin;
select * from no_plan();

-- 既存データ・他の作業と衝突しないよう、テストの予約はすべて 300 日先に置く
select set_config('t.base', (now() + interval '300 days')::text, true);

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
-- 匿名 (anon)
-- ---------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok('select count(*) from public.reservations', '42501', null, '匿名は予約を読めない');
select throws_ok('select count(*) from public.members', '42501', null, '匿名は会員を読めない');
select throws_ok('select count(*) from public.inquiries', '42501', null, '匿名は問い合わせを読めない');
select throws_ok('select count(*) from public.assets', '42501', null, '匿名は車両表を直接読めない (カタログRPC経由のみ)');
select is(jsonb_array_length(public.public_catalog() -> 'assets'), 6, '匿名でも公開カタログは読める');
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
select is((public.admin_create_reservation(jsonb_build_object('kind', 'block', 'asset_id', 'V005',
  'start_at', current_setting('t.base')::timestamptz + interval '10 days', 'end_at', current_setting('t.base')::timestamptz + interval '12 days', 'staff_note', '車検'))).kind,
  'block', '整備・車検の貸出停止枠を登録できる');
select throws_ok(
  $$select public.admin_create_reservation(jsonb_build_object(
    'asset_id', 'V005', 'customer_name', '電話予約', 'customer_email', 'tel@example.com', 'customer_phone', '0',
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

select * from finish();
rollback;
