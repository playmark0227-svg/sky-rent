-- =====================================================================
-- 家電レンタル (車を借りずに家電だけを借りる) と、家電の在庫
--
--   * 家電レンタルは categories.type = 'item' のカテゴリ (seed の cat-appliance) と、
--     その「受け取り窓口」のアセット (seed の A001。家電そのものではない) で受け付ける。
--     借りる家電は装備オプション (OP001〜OP011) をこのアセットの予約で選ぶ。
--     車両の予約に付けるオプションとしての提供はこれまでどおり。
--
--   * 家電の在庫 (options.stock。null = 数えない) は、車両の予約のオプションと家電だけの予約で共用する。
--     使用数 = 期間内に「同時に貸し出している数」の最大値。数えるのは有効 (confirmed / in_use) な
--     貸出 (kind = 'rental') の予約で、選んだオプション + そのセットの中身 (extra.includes) に
--     その家電を含むもの。在庫を超える予約は OPTION_SOLD_OUT (detail = 売り切れの id をカンマ区切り。
--     家電セットを選んだ場合はセット自身の id も含む)。
--     予約の作成・日時変更では、車両のアドバイザリロック ('asset:' || id) の後に、関係する在庫ありの
--     家電ごとのアドバイザリロック ('option:' || id) を id の昇順で取ってから数える (デッドロック防止)。
--
--   * 車両の「同じ時間に重ならない」排他制約は家電レンタルには掛けない (窓口アセットには同じ時間に
--     何件でも予約が入る。止めるのは家電の在庫)。そのため reservations.is_item (カテゴリの種類から
--     トリガーで決める) を持ち、制約の条件に入れる。空き表示 (public_busy_ranges) にも出さない。
--
--   * 家電レンタルのアセットには貸出停止枠を作れない (家電ごとの在庫はオプション管理で変える)。
--   * 家電レンタルの予約は家電 (オプション) を1つ以上選ぶのが必須 (ITEM_REQUIRED)。
--
--   関数は最後に定義したマイグレーションを引き継ぐ:
--     create_reservation_tx    … 000700 (アドバイザリロック付き)
--     admin_create_reservation / admin_update_reservation … 000900 (拠点の権限の検査付き)
--     public_busy_ranges       … 000300
--     member_reservations      … 000500
--   (create or replace で置き換えた関数は、元の実行権限がそのまま残る)
--   カテゴリ・アセット・在庫数・料金ルール・法務文書の行は supabase/seed.sql で入れる。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 家電の在庫数 (null = 在庫を数えない)
-- ---------------------------------------------------------------------
alter table public.options
  add column stock int check (stock is null or stock >= 0);

-- ---------------------------------------------------------------------
-- 2. 予約が家電レンタル (categories.type = 'item') か
--    予約のカテゴリから決める (直接書き換えてもトリガーで正しい値に戻す)
-- ---------------------------------------------------------------------
alter table public.reservations
  add column is_item boolean not null default false;

create or replace function public.reservations_set_is_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.is_item := coalesce((select c.type = 'item' from public.categories c where c.id = new.category_id), false);
  return new;
end $$;

-- 既存の予約の埋め戻し (家電レンタルのカテゴリがまだ無ければ 0 件)
update public.reservations r
   set is_item = true
  from public.categories c
 where c.id = r.category_id and c.type = 'item' and not r.is_item;

create trigger reservations_set_is_item
  before insert or update of category_id, asset_id, is_item on public.reservations
  for each row execute function public.reservations_set_is_item();

-- カテゴリの種類 (車両 / 物品) を管理画面で変えたら、そのカテゴリの予約の is_item も合わせる。
--   物品 → 車両に変えるとき、同じ時間に重なる有効な予約があれば変えられない (排他制約で検出)
create or replace function public.categories_sync_is_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    update public.reservations r set is_item = (new.type = 'item')
     where r.category_id = new.id and r.is_item is distinct from (new.type = 'item');
  exception when exclusion_violation then
    perform public.fail('VALIDATION', 'このカテゴリには同じ時間に重なる予約があるため、車両レンタルに変えられません。');
  end;
  return new;
end $$;

create trigger categories_sync_is_item
  after update of type on public.categories
  for each row when (old.type is distinct from new.type)
  execute function public.categories_sync_is_item();

-- ---------------------------------------------------------------------
-- 3. 車両の重なり禁止は家電レンタルに掛けない
-- ---------------------------------------------------------------------
alter table public.reservations drop constraint reservations_no_overlap;
-- 同じ車両の有効な予約・貸出停止枠は時間が重ならない (DBが最後の砦)。家電レンタルは在庫で止める
alter table public.reservations
  add constraint reservations_no_overlap exclude using gist (asset_id with =, period with &&)
  where (status in ('confirmed', 'in_use') and not is_item);

-- 家電の使用数を数えるための索引 (オプション付きの有効な貸出だけ)
create index reservations_option_period_idx on public.reservations using gist (period)
  where status in ('confirmed', 'in_use') and kind = 'rental' and cardinality(option_ids) > 0;

-- ---------------------------------------------------------------------
-- 4. 在庫の判定 (Edge Function と、security definer の RPC の中から呼ぶ。service_role のみ実行可)
-- ---------------------------------------------------------------------

-- 選んだオプション + セットの中身 (extra.includes が配列のときだけ)。重複なし・id 順
create or replace function public.options_expand(p_option_ids text[]) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s.x order by s.x), '{}')
  from (
    select unnest(coalesce(p_option_ids, '{}')) as x
    union all
    select jsonb_array_elements_text(o.extra -> 'includes')
      from public.options o
     where o.id = any (coalesce(p_option_ids, '{}'))
       and jsonb_typeof(o.extra -> 'includes') = 'array'
  ) s
$$;

-- 家電 p_option_id の、期間 p_period 内の同時貸出数の最大値 (p_exclude の予約は数えない)
--   同時最大は「期間の開始時点」と「期間内に始まる各予約の開始時点」で数えた件数の最大
create or replace function public.option_usage(p_option_id text, p_period tstzrange, p_exclude text default null)
returns int
language sql stable security definer set search_path = '' as $$
  with holders as (
    -- その家電自身と、その家電を中身に含むセット (家電セット)
    select array[p_option_id] || coalesce(array(
             select o.id from public.options o
              where jsonb_typeof(o.extra -> 'includes') = 'array'
                and (o.extra -> 'includes') ? p_option_id), '{}') as ids
  ), cand as (
    select r.period
      from public.reservations r, holders h
     where r.status in ('confirmed', 'in_use') and r.kind = 'rental'
       and cardinality(r.option_ids) > 0
       and r.period && p_period
       and (p_exclude is null or r.id <> p_exclude)
       and r.option_ids && h.ids
  ), pts as (
    select lower(p_period) as t
    union
    select lower(c.period) from cand c where lower(c.period) > lower(p_period)
  )
  select coalesce(max(n.cnt), 0)::int
  from pts p
  cross join lateral (select count(*) as cnt from cand c where c.period @> p.t) n
$$;

-- 予約時の判定: 選んだ家電 (セットは中身に展開) のうち、在庫を超えるものの id (id 順)。
--   家電セットを選んでいて中身が売り切れなら、セット自身の id も含める。空配列なら予約できる
create or replace function public.option_sold_out(p_option_ids text[], p_period tstzrange, p_exclude text default null)
returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_out text[] := '{}';
  o record;
begin
  if p_period is null or isempty(p_period) or coalesce(cardinality(p_option_ids), 0) = 0 then return v_out; end if;
  for o in select x.id, x.stock from public.options x
            where x.id = any (public.options_expand(p_option_ids)) and x.stock is not null
            order by x.id loop
    if public.option_usage(o.id, p_period, p_exclude) + 1 > o.stock then
      v_out := v_out || o.id;
    end if;
  end loop;
  if cardinality(v_out) = 0 then return v_out; end if;
  select coalesce(array_agg(distinct z.x order by z.x), '{}') into v_out
  from (
    select unnest(v_out) as x
    union all
    select s.id from public.options s
     where s.id = any (p_option_ids)
       and jsonb_typeof(s.extra -> 'includes') = 'array'
       and exists (select 1 from jsonb_array_elements_text(s.extra -> 'includes') i(v) where i.v = any (v_out))
  ) z;
  return v_out;
end $$;

-- 見積用: その期間に貸し出せない (残り0) 有効なオプションの id (id 順)。
--   家電セットは中身のどれかが残り0なら含める
create or replace function public.unavailable_option_ids(p_start timestamptz, p_end timestamptz, p_exclude text default null)
returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_period tstzrange;
  v_out text[] := '{}';
  o record;
begin
  if p_start is null or p_end is null or p_end <= p_start then perform public.fail('INVALID_PERIOD'); end if;
  v_period := tstzrange(p_start, p_end, '[)');
  for o in select x.id from public.options x
            where x.active and (x.stock is not null or jsonb_typeof(x.extra -> 'includes') = 'array')
            order by x.id loop
    if cardinality(public.option_sold_out(array[o.id], v_period, p_exclude)) > 0 then
      v_out := v_out || o.id;
    end if;
  end loop;
  return v_out;
end $$;

-- 関係する在庫ありの家電のアドバイザリロックを id の昇順で取る (車両のロックの後に呼ぶ)
create or replace function public.lock_option_stock(p_option_ids text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  for v in select o.id from public.options o
            where o.id = any (public.options_expand(p_option_ids)) and o.stock is not null
            order by o.id loop
    perform pg_advisory_xact_lock(hashtext('option:' || v));
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. 公開: 空き状況 (000300 を引き継ぐ)。家電レンタルの予約は返さない (家電は在庫で判定する)
-- ---------------------------------------------------------------------
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
      and not r.is_item
      and r.period && tstzrange(p_from, p_to, '[)')
    order by r.asset_id, r.start_at;
end $$;

-- ---------------------------------------------------------------------
-- 6. 会員の予約一覧 (000500 を引き継ぐ)。家電レンタルかどうか (is_item) を足す
-- ---------------------------------------------------------------------
create or replace function public.member_reservations() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'asset_id', r.asset_id, 'category_id', r.category_id,
    'location_id', r.location_id, 'start_at', r.start_at, 'end_at', r.end_at, 'status', r.status,
    'user_id', r.user_id, 'customer_name', r.customer_name, 'customer_kana', r.customer_kana,
    'customer_email', r.customer_email, 'customer_phone', r.customer_phone, 'company', r.company,
    'license_confirmed', r.license_confirmed, 'payment_method', r.payment_method,
    'payment_status', r.payment_status, 'option_ids', r.option_ids, 'options', r.options,
    'price', r.price, 'total', r.total, 'discount_type', r.discount_type, 'coupon_id', r.coupon_id,
    'invoice_id', r.invoice_id, 'point_granted', r.point_granted, 'note', r.note,
    'cancel_fee', r.cancel_fee, 'cancelled_at', r.cancelled_at, 'cancelled_by', r.cancelled_by,
    'version', r.version, 'created_at', r.created_at, 'is_item', r.is_item
  ) order by r.start_at desc), '[]'::jsonb)
  from public.reservations r
  where auth.uid() is not null and r.user_id = auth.uid() and r.kind = 'rental'
$$;

-- ---------------------------------------------------------------------
-- 7. 予約の確定 (000700 を引き継ぐ)
--    + 家電レンタルは家電を1つ以上 (ITEM_REQUIRED)
--    + 車両のロックの後に家電のロックを取り、在庫を確認 (OPTION_SOLD_OUT)
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
  v_cat_type text;
  v_sold  text[];
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
  select c.type into v_cat_type from public.categories c where c.id = v_asset.category_id and c.active;
  if not found then perform public.fail('ASSET_UNAVAILABLE'); end if;

  -- オプションはこの車両のカテゴリで有効なものだけ
  select x into v_bad from unnest(v_opts) x
   where not exists (select 1 from public.options o
                      where o.id = x and o.active
                        and (o.category_ids is null or v_asset.category_id = any (o.category_ids)))
   limit 1;
  if v_bad is not null then perform public.fail('OPTION_INVALID', v_bad); end if;
  -- 家電レンタルは、借りる家電 (オプション) を1つ以上
  if v_cat_type = 'item' and cardinality(v_opts) = 0 then perform public.fail('ITEM_REQUIRED'); end if;

  -- 家電の在庫 (車両の予約のオプションと家電だけの予約で共用)。家電ごとのロックを id 順に取ってから数える
  if cardinality(v_opts) > 0 then
    perform public.lock_option_stock(v_opts);
    v_sold := public.option_sold_out(v_opts, tstzrange(v_start, v_end, '[)'));
    if cardinality(v_sold) > 0 then perform public.fail('OPTION_SOLD_OUT', array_to_string(v_sold, ',')); end if;
  end if;

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

  -- 受け渡しの同時刻重複 (担当者は同時に2件の受け渡しができない。家電レンタルの店頭での受け渡しも数える)
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

-- ---------------------------------------------------------------------
-- 8. 予約の更新 (000900 を引き継ぐ)
--    + 車両と家電レンタルの間の付け替えは不可
--    + 日時の変更・取消からの戻しでは、車両のロック → 家電のロックの後に在庫を確認 (自分自身は数えない)
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
  v_after_status text;
  v_sold text[];
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
  -- 車両の予約 (貸出停止枠を含む) と家電レンタルの予約の間では付け替えない
  if v_asset.id <> v.asset_id
     and coalesce((select c.type = 'item' from public.categories c where c.id = v_asset.category_id), false) <> v.is_item then
    perform public.fail('VALIDATION', '車両の予約と家電レンタルの予約の間では付け替えできません。');
  end if;

  -- 日時・車両の変更や、取消・無断キャンセルからの戻しで有効な予約になるときは、
  -- 車両のロック → 家電のロック (id 順) を取ってから家電の在庫を確認する (自分自身は数えない)
  v_after_status := coalesce(v_new_status, v.status);
  if v.kind = 'rental' and v_after_status in ('confirmed', 'in_use')
     and (tstzrange(v_start, v_end, '[)') is distinct from v.period
          or v_asset.id <> v.asset_id
          or v.status not in ('confirmed', 'in_use')) then
    perform pg_advisory_xact_lock(hashtext('asset:' || v_asset.id));
    if cardinality(v.option_ids) > 0 then
      perform public.lock_option_stock(v.option_ids);
      v_sold := public.option_sold_out(v.option_ids, tstzrange(v_start, v_end, '[)'), v.id);
      if cardinality(v_sold) > 0 then perform public.fail('OPTION_SOLD_OUT', array_to_string(v_sold, ',')); end if;
    end if;
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

-- ---------------------------------------------------------------------
-- 9. スタッフによる予約登録 (000900 を引き継ぐ)
--    + 家電レンタルのアセットには貸出停止枠を作れない (VALIDATION)
--    + 家電レンタルは家電を1つ以上 (ITEM_REQUIRED)
--    + 車両のロック → 家電のロックの後に在庫を確認 (OPTION_SOLD_OUT)
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
  v_opts text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'option_ids', '[]'::jsonb))), '{}');
  v_is_item boolean;
  v_sold text[];
begin
  if v_kind = 'block' then perform public.require_perm('blocks.write');
  else perform public.require_perm('reservations.write'); end if;
  v_user := nullif(p ->> 'user_id', '')::uuid;

  select * into v_asset from public.assets where id = p ->> 'asset_id';
  if not found then perform public.fail('ASSET_UNAVAILABLE'); end if;
  if not public.staff_can_location(v_asset.location_id) then perform public.fail('FORBIDDEN', 'location'); end if;
  if v_user is not null and not public.staff_can_member(v_user) then perform public.fail('FORBIDDEN', 'location'); end if;
  if v_start is null or v_end is null or v_end <= v_start then perform public.fail('INVALID_PERIOD'); end if;

  v_is_item := coalesce((select c.type = 'item' from public.categories c where c.id = v_asset.category_id), false);
  if v_is_item and v_kind = 'block' then
    perform public.fail('VALIDATION', '家電レンタルには貸出停止枠を作れません。家電ごとの在庫はオプション管理で変えてください。');
  end if;
  if v_is_item and v_kind = 'rental' and cardinality(v_opts) = 0 then perform public.fail('ITEM_REQUIRED'); end if;

  -- 同じ車両への同時登録を直列化 → 家電の在庫 (家電ごとのロックを id 順に取ってから数える)
  perform pg_advisory_xact_lock(hashtext('asset:' || v_asset.id));
  if v_kind = 'rental' and cardinality(v_opts) > 0 then
    perform public.lock_option_stock(v_opts);
    v_sold := public.option_sold_out(v_opts, tstzrange(v_start, v_end, '[)'));
    if cardinality(v_sold) > 0 then perform public.fail('OPTION_SOLD_OUT', array_to_string(v_sold, ',')); end if;
  end if;

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
      v_opts,
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
-- 10. 実行権限
--   新しい関数は既定で PUBLIC / anon / authenticated も実行できてしまうので剥がす。
--   在庫の判定は Edge Function (service_role) と、security definer の RPC の中からだけ使う。
-- ---------------------------------------------------------------------
revoke execute on function public.reservations_set_is_item() from public, anon, authenticated;
revoke execute on function public.categories_sync_is_item() from public, anon, authenticated;
revoke execute on function public.options_expand(text[]) from public, anon, authenticated;
revoke execute on function public.option_usage(text, tstzrange, text) from public, anon, authenticated;
revoke execute on function public.option_sold_out(text[], tstzrange, text) from public, anon, authenticated;
revoke execute on function public.unavailable_option_ids(timestamptz, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.lock_option_stock(text[]) from public, anon, authenticated;
grant execute on function public.options_expand(text[]) to service_role;
grant execute on function public.option_usage(text, tstzrange, text) to service_role;
grant execute on function public.option_sold_out(text[], tstzrange, text) to service_role;
grant execute on function public.unavailable_option_ids(timestamptz, timestamptz, text) to service_role;
grant execute on function public.lock_option_stock(text[]) to service_role;
