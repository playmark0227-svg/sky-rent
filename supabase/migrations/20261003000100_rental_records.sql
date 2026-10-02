-- =====================================================================
-- 貸渡証の内容 (= 貸渡簿の1行) を保存する
--   * 予約1件につき1行 (id = 予約番号 = 貸渡番号)。管理画面の予約一覧・予約表から編集し、
--     貸渡証の印刷 (帳票) と貸渡簿 (一覧・印刷・ダウンロード) はこの行を使う。
--   * 貸渡簿の記載事項: 利用者の氏名 (法人は名称)・住所 / 運転者の氏名・住所・運転免許の種類と番号 /
--     登録番号 (ナンバー) / 貸渡日時と時間 / 貸渡事務所・返還事務所 / 運行区間 (行先)・利用人数 /
--     使用目的 (マイクロバスのみ) / 走行キロ数 (貸出時・返却時のメーター) / 事故に関する事項
--   * 読めるのは担当拠点のスタッフだけ (会員・ゲストは読めない)。書き込みは admin_save_rental_record だけ。
--   * 運転免許の番号・生年月日は個人情報なので、変更履歴 (audit_log) には値を残さない。
-- =====================================================================

create table public.rental_records (
  id              text primary key references public.reservations(id) on delete cascade,
  issued_on       date,                                    -- 発行日 (貸渡証)
  -- 借受人 (利用者)
  renter_name     text not null default '' check (length(renter_name) <= 100),
  renter_address  text not null default '' check (length(renter_address) <= 200),
  renter_phone    text not null default '' check (length(renter_phone) <= 30),
  -- 運転者 (借受人と同じなら driver_same = true で、名前・住所は借受人の値を使う)
  driver_same     boolean not null default true,
  driver_name     text not null default '' check (length(driver_name) <= 100),
  driver_address  text not null default '' check (length(driver_address) <= 200),
  license_no      text not null default '' check (length(license_no) <= 30),
  license_type    text not null default '' check (length(license_type) <= 50),
  license_expiry  date,
  birth_date      date,
  intl_license    text not null default '' check (length(intl_license) <= 100),   -- 国際免許証 (番号・発行国など)
  -- 車両
  vehicle_name    text not null default '' check (length(vehicle_name) <= 100),
  plate           text not null default '' check (length(plate) <= 30),           -- 登録番号 (ナンバー)
  -- 貸渡しの内容 (実際の貸出・返却の日時。予約と違えば直す)
  start_at        timestamptz,
  end_at          timestamptz,
  passengers      int check (passengers is null or passengers between 1 and 99),
  destination     text not null default '' check (length(destination) <= 200),   -- 運行区間または行先
  purpose         text not null default '' check (length(purpose) <= 200),       -- 使用目的 (マイクロバスの場合)
  pickup_office   text not null default '' check (length(pickup_office) <= 100), -- 貸渡事務所
  return_office   text not null default '' check (length(return_office) <= 100), -- 返還事務所
  pickup_place    text not null default '' check (length(pickup_place) <= 200),  -- 迎え場所
  dropoff_place   text not null default '' check (length(dropoff_place) <= 200), -- 送り場所
  odometer_out    int check (odometer_out is null or odometer_out between 0 and 9999999),  -- 貸出時メーター (km)
  odometer_in     int check (odometer_in  is null or odometer_in  between 0 and 9999999),  -- 返却時メーター (km)
  distance_km     int generated always as (odometer_in - odometer_out) stored,             -- 走行キロ数
  accident        boolean not null default false,
  accident_note   text not null default '' check (length(accident_note) <= 2000),
  -- オプション・料金 (貸渡証に載せる内容。予約の控えから作り、必要なら直す)
  cover           text not null default '' check (length(cover) <= 200),        -- 補償制度
  options_text    text not null default '' check (length(options_text) <= 1000),
  rental_items    text not null default '' check (length(rental_items) <= 1000), -- 貸出品
  service         text not null default '' check (length(service) <= 500),
  base_fee        int check (base_fee is null or base_fee >= 0),
  option_fee      int check (option_fee is null or option_fee >= 0),
  total           int check (total is null or total >= 0),
  payment         text not null default '' check (length(payment) <= 100),
  remarks         text not null default '' check (length(remarks) <= 2000),
  version         int  not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  constraint rental_records_period_valid check (start_at is null or end_at is null or end_at > start_at),
  constraint rental_records_odometer_order check (odometer_out is null or odometer_in is null or odometer_in >= odometer_out)
);
create index rental_records_start_idx on public.rental_records (start_at);

alter table public.rental_records enable row level security;
revoke all on public.rental_records from anon, authenticated;
grant select on public.rental_records to authenticated;

-- 担当拠点のスタッフだけが読める (書き込みは RPC だけ)
create policy rental_records_read on public.rental_records for select to authenticated
  using (
    public.has_perm('read') and exists (
      select 1 from public.reservations r where r.id = rental_records.id and public.staff_can_location(r.location_id))
  );

-- 変更履歴: 運転免許の番号・生年月日は値を残さない (audit_row の伏せ字の対象に足す)
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_diff jsonb := '{}'::jsonb;
  k text;
  v_id text;
  masked text[] := array['email', 'phone', 'customer_email', 'customer_phone', 'tel',
                         'guest_token_hash', 'request_hash', 'idempotency_key', 'body',
                         'license_no', 'birth_date', 'intl_license', 'renter_phone'];
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

create trigger rental_records_audit after insert or update or delete on public.rental_records
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------
-- 保存 (新規・更新とも)。p は画面の項目 (snake_case)。無い項目は今の値のまま (新規は空)
--   p_version: 画面で読んだときの版。保存済みの行と違えば VERSION_CONFLICT (他のスタッフが先に保存)
-- ---------------------------------------------------------------------
create or replace function public.admin_save_rental_record(p_id text, p jsonb, p_version int default null)
returns public.rental_records
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.reservations;
  v_cur public.rental_records;
  v_row public.rental_records;
  v_txt text;
  k text;
  v_int int;
begin
  perform public.require_perm('reservations.write');
  select * into v_res from public.reservations where id = p_id;
  if not found then perform public.fail('NOT_FOUND'); end if;
  if not public.staff_can_location(v_res.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  if v_res.kind <> 'rental' then perform public.fail('VALIDATION', '貸出停止枠には貸渡証を作れません。'); end if;
  if p is null or jsonb_typeof(p) <> 'object' then perform public.fail('VALIDATION'); end if;

  select * into v_cur from public.rental_records where id = p_id for update;
  if found and p_version is not null and p_version <> v_cur.version then perform public.fail('VERSION_CONFLICT'); end if;
  if not found then
    v_cur := null;
    v_cur.id := p_id;
    v_cur.driver_same := true;
    v_cur.accident := false;
    v_cur.version := 0;
  end if;

  -- 数値・日付は形を確かめてから入れる (文字の長さは表の check 制約で止める)
  foreach k in array array['passengers', 'odometer_out', 'odometer_in', 'base_fee', 'option_fee', 'total'] loop
    if p ? k and p ->> k is not null and p ->> k <> '' and (p ->> k) !~ '^[0-9]{1,9}$' then
      perform public.fail('VALIDATION', k);
    end if;
  end loop;
  foreach k in array array['issued_on', 'license_expiry', 'birth_date'] loop
    if p ? k and coalesce(p ->> k, '') <> '' and (p ->> k) !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.fail('VALIDATION', k);
    end if;
  end loop;

  v_row := v_cur;
  if p ? 'issued_on'      then v_row.issued_on      := nullif(p ->> 'issued_on', '')::date; end if;
  if p ? 'renter_name'    then v_row.renter_name    := btrim(coalesce(p ->> 'renter_name', '')); end if;
  if p ? 'renter_address' then v_row.renter_address := btrim(coalesce(p ->> 'renter_address', '')); end if;
  if p ? 'renter_phone'   then v_row.renter_phone   := btrim(coalesce(p ->> 'renter_phone', '')); end if;
  if p ? 'driver_same'    then v_row.driver_same    := coalesce((p ->> 'driver_same')::boolean, true); end if;
  if p ? 'driver_name'    then v_row.driver_name    := btrim(coalesce(p ->> 'driver_name', '')); end if;
  if p ? 'driver_address' then v_row.driver_address := btrim(coalesce(p ->> 'driver_address', '')); end if;
  if p ? 'license_no'     then v_row.license_no     := btrim(coalesce(p ->> 'license_no', '')); end if;
  if p ? 'license_type'   then v_row.license_type   := btrim(coalesce(p ->> 'license_type', '')); end if;
  if p ? 'license_expiry' then v_row.license_expiry := nullif(p ->> 'license_expiry', '')::date; end if;
  if p ? 'birth_date'     then v_row.birth_date     := nullif(p ->> 'birth_date', '')::date; end if;
  if p ? 'intl_license'   then v_row.intl_license   := btrim(coalesce(p ->> 'intl_license', '')); end if;
  if p ? 'vehicle_name'   then v_row.vehicle_name   := btrim(coalesce(p ->> 'vehicle_name', '')); end if;
  if p ? 'plate'          then v_row.plate          := btrim(coalesce(p ->> 'plate', '')); end if;
  if p ? 'start_at'       then v_row.start_at       := nullif(p ->> 'start_at', '')::timestamptz; end if;
  if p ? 'end_at'         then v_row.end_at         := nullif(p ->> 'end_at', '')::timestamptz; end if;
  if p ? 'passengers'     then v_row.passengers     := nullif(p ->> 'passengers', '')::int; end if;
  if p ? 'destination'    then v_row.destination    := btrim(coalesce(p ->> 'destination', '')); end if;
  if p ? 'purpose'        then v_row.purpose        := btrim(coalesce(p ->> 'purpose', '')); end if;
  if p ? 'pickup_office'  then v_row.pickup_office  := btrim(coalesce(p ->> 'pickup_office', '')); end if;
  if p ? 'return_office'  then v_row.return_office  := btrim(coalesce(p ->> 'return_office', '')); end if;
  if p ? 'pickup_place'   then v_row.pickup_place   := btrim(coalesce(p ->> 'pickup_place', '')); end if;
  if p ? 'dropoff_place'  then v_row.dropoff_place  := btrim(coalesce(p ->> 'dropoff_place', '')); end if;
  if p ? 'odometer_out'   then v_row.odometer_out   := nullif(p ->> 'odometer_out', '')::int; end if;
  if p ? 'odometer_in'    then v_row.odometer_in    := nullif(p ->> 'odometer_in', '')::int; end if;
  if p ? 'accident'       then v_row.accident       := coalesce((p ->> 'accident')::boolean, false); end if;
  if p ? 'accident_note'  then v_row.accident_note  := btrim(coalesce(p ->> 'accident_note', '')); end if;
  if p ? 'cover'          then v_row.cover          := btrim(coalesce(p ->> 'cover', '')); end if;
  if p ? 'options_text'   then v_row.options_text   := btrim(coalesce(p ->> 'options_text', '')); end if;
  if p ? 'rental_items'   then v_row.rental_items   := btrim(coalesce(p ->> 'rental_items', '')); end if;
  if p ? 'service'        then v_row.service        := btrim(coalesce(p ->> 'service', '')); end if;
  if p ? 'base_fee'       then v_row.base_fee       := nullif(p ->> 'base_fee', '')::int; end if;
  if p ? 'option_fee'     then v_row.option_fee     := nullif(p ->> 'option_fee', '')::int; end if;
  if p ? 'total'          then v_row.total          := nullif(p ->> 'total', '')::int; end if;
  if p ? 'payment'        then v_row.payment        := btrim(coalesce(p ->> 'payment', '')); end if;
  if p ? 'remarks'        then v_row.remarks        := btrim(coalesce(p ->> 'remarks', '')); end if;

  if v_row.odometer_out is not null and v_row.odometer_in is not null and v_row.odometer_in < v_row.odometer_out then
    perform public.fail('VALIDATION', '返却時メーターは貸出時メーター以上の値にしてください。');
  end if;
  if v_row.start_at is not null and v_row.end_at is not null and v_row.end_at <= v_row.start_at then
    perform public.fail('INVALID_PERIOD');
  end if;

  begin
    insert into public.rental_records as t (
      id, issued_on, renter_name, renter_address, renter_phone, driver_same, driver_name, driver_address,
      license_no, license_type, license_expiry, birth_date, intl_license, vehicle_name, plate,
      start_at, end_at, passengers, destination, purpose, pickup_office, return_office, pickup_place, dropoff_place,
      odometer_out, odometer_in, accident, accident_note, cover, options_text, rental_items, service,
      base_fee, option_fee, total, payment, remarks, version, updated_by)
    values (
      v_row.id, v_row.issued_on, coalesce(v_row.renter_name, ''), coalesce(v_row.renter_address, ''), coalesce(v_row.renter_phone, ''),
      coalesce(v_row.driver_same, true), coalesce(v_row.driver_name, ''), coalesce(v_row.driver_address, ''),
      coalesce(v_row.license_no, ''), coalesce(v_row.license_type, ''), v_row.license_expiry, v_row.birth_date, coalesce(v_row.intl_license, ''),
      coalesce(v_row.vehicle_name, ''), coalesce(v_row.plate, ''),
      v_row.start_at, v_row.end_at, v_row.passengers, coalesce(v_row.destination, ''), coalesce(v_row.purpose, ''),
      coalesce(v_row.pickup_office, ''), coalesce(v_row.return_office, ''), coalesce(v_row.pickup_place, ''), coalesce(v_row.dropoff_place, ''),
      v_row.odometer_out, v_row.odometer_in, coalesce(v_row.accident, false), coalesce(v_row.accident_note, ''),
      coalesce(v_row.cover, ''), coalesce(v_row.options_text, ''), coalesce(v_row.rental_items, ''), coalesce(v_row.service, ''),
      v_row.base_fee, v_row.option_fee, v_row.total, coalesce(v_row.payment, ''), coalesce(v_row.remarks, ''), 1, auth.uid())
    on conflict (id) do update set
      issued_on = excluded.issued_on, renter_name = excluded.renter_name, renter_address = excluded.renter_address,
      renter_phone = excluded.renter_phone, driver_same = excluded.driver_same, driver_name = excluded.driver_name,
      driver_address = excluded.driver_address, license_no = excluded.license_no, license_type = excluded.license_type,
      license_expiry = excluded.license_expiry, birth_date = excluded.birth_date, intl_license = excluded.intl_license,
      vehicle_name = excluded.vehicle_name, plate = excluded.plate, start_at = excluded.start_at, end_at = excluded.end_at,
      passengers = excluded.passengers, destination = excluded.destination, purpose = excluded.purpose,
      pickup_office = excluded.pickup_office, return_office = excluded.return_office, pickup_place = excluded.pickup_place,
      dropoff_place = excluded.dropoff_place, odometer_out = excluded.odometer_out, odometer_in = excluded.odometer_in,
      accident = excluded.accident, accident_note = excluded.accident_note, cover = excluded.cover,
      options_text = excluded.options_text, rental_items = excluded.rental_items, service = excluded.service,
      base_fee = excluded.base_fee, option_fee = excluded.option_fee, total = excluded.total, payment = excluded.payment,
      remarks = excluded.remarks, version = t.version + 1, updated_at = now(), updated_by = auth.uid()
    returning * into v_row;
  exception when check_violation then
    perform public.fail('VALIDATION', '入力できる文字数や値の範囲を超えている項目があります。');
  end;
  return v_row;
end $$;

revoke execute on function public.admin_save_rental_record(text, jsonb, int) from public, anon;
grant execute on function public.admin_save_rental_record(text, jsonb, int) to authenticated;
