-- =====================================================================
-- 会員が読める予約の列を限定する
--   RLS は行を絞れても列は絞れない。会員が予約表を直接 select できると、
--   スタッフのメモ (staff_note)・カレンダー予定ID・登録経路まで読めてしまうため、
--   会員の読み取りは列を限定した RPC に一本化し、予約表の直接読み取りはスタッフだけにする。
-- =====================================================================
drop policy if exists reservations_read on public.reservations;
create policy reservations_read on public.reservations for select to authenticated
  using (public.has_perm('read') and public.staff_can_location(location_id));

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
    'version', r.version, 'created_at', r.created_at
  ) order by r.start_at desc), '[]'::jsonb)
  from public.reservations r
  where auth.uid() is not null and r.user_id = auth.uid() and r.kind = 'rental'
$$;
revoke execute on function public.member_reservations() from public, anon;
grant execute on function public.member_reservations() to authenticated;
