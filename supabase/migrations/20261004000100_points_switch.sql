-- =====================================================================
-- ポイント制度の on/off (settings の points.enabled)
--   2026-10 から一旦停止: enabled が true のときだけ、返却でポイントを付け、しきい値でクーポンを発行する。
--   未設定 (enabled が無い) も「使わない」として扱う。もう一度始めるときは管理画面のポイント設定で有効にする。
--   予約サイトは同じ設定 (公開設定 points) を読んで、ポイント・クーポンの案内を出さない。
-- =====================================================================

create or replace function public.points_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((public.setting('points', '{}'::jsonb) ->> 'enabled')::boolean, false)
$$;
revoke execute on function public.points_enabled() from public, anon;
grant execute on function public.points_enabled() to authenticated, service_role;

-- しきい値に達していればクーポンを発行し、ポイントを消費する (ポイント制度を使っている間だけ)
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
  if not public.points_enabled() then return 0; end if;
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

-- 返却でポイント付与 (BEFORE で付与済みフラグ、AFTER で台帳へ)。ポイント制度を使っていない間は付けない
create or replace function public.reservations_before_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'returned' and old.status is distinct from 'returned'
     and new.user_id is not null and not new.point_granted and new.kind = 'rental'
     and public.points_enabled() then
    new.point_granted := true;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;
  return new;
end $$;

create or replace function public.reservations_after_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cfg jsonb := public.setting('points', '{"pointPerUse":1}');
  v_pt int := greatest(0, coalesce((cfg ->> 'pointPerUse')::int, 1));
begin
  if new.status = 'returned' and old.status is distinct from 'returned' and new.user_id is not null then
    -- 最終利用日 (ポイント失効の基準) はポイント制度の有無にかかわらず記録する
    update public.members set last_use_at = now() where user_id = new.user_id;
    if new.point_granted and not old.point_granted then
      if v_pt > 0 then
        insert into public.point_ledger (user_id, delta, reason, reservation_id)
          values (new.user_id, v_pt, '予約 ' || new.id || ' ご返却', new.id)
          on conflict do nothing;
      end if;
      perform public.issue_coupons_if_needed(new.user_id);
    end if;
  end if;
  -- 取消時は使用したクーポンを戻す
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.coupon_id is not null then
    update public.coupons set used_at = null, used_reservation_id = null
      where id = new.coupon_id and used_reservation_id = new.id;
  end if;
  return new;
end $$;
