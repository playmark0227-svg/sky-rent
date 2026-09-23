-- =====================================================================
-- 管理画面からの再送で試行回数を戻す
--   outbox_claim は attempts < 8 の行しか取り出さないため、上限まで失敗した行は
--   画面で「再送」を押しても処理されなかった。再送時に attempts を 0 に戻す。
-- =====================================================================
create or replace function public.admin_retry_outbox(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.has_perm('outbox.read') and (public.has_perm('reservations.write') or public.has_perm('settings.write'))) then
    perform public.fail('FORBIDDEN');
  end if;
  update public.outbox
     set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
   where id = p_id and status in ('failed', 'skipped');
  if not found then perform public.fail('NOT_FOUND'); end if;
end $$;
revoke execute on function public.admin_retry_outbox(bigint) from public, anon;
grant execute on function public.admin_retry_outbox(bigint) to authenticated;
