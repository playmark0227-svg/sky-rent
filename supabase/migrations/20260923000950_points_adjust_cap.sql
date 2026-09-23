-- =====================================================================
-- ポイント手動調整の上限
--   ポイントは 10pt で ¥1,000 クーポンに自動交換されるため、手動調整に上限が無いと
--   「クーポン発行」の金額上限を迂回して、実質的に金券を無制限に作れてしまう。
--   1回の調整は ±100pt まで (必要ならそれ以上は複数回・監査ログに残る)。
--   ※ 000900 の拠点チェック付きの定義を引き継ぐ
-- =====================================================================
create or replace function public.admin_adjust_points(p_user uuid, p_delta int, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_bal int;
begin
  perform public.require_perm('members.write');
  if not public.staff_can_member(p_user) then perform public.fail('FORBIDDEN', 'location'); end if;
  if p_delta is null or p_delta = 0 then perform public.fail('INVALID_DELTA'); end if;
  if abs(p_delta) > 100 then perform public.fail('INVALID_DELTA', '1回の調整は100ポイントまでです'); end if;
  if coalesce(btrim(p_reason), '') = '' then perform public.fail('VALIDATION', '理由を入力してください'); end if;
  perform 1 from public.members where user_id = p_user for update;
  if not found then perform public.fail('NOT_FOUND'); end if;
  v_bal := public.member_point_balance(p_user);
  if v_bal + p_delta < 0 then p_delta := -v_bal; end if;
  if p_delta <> 0 then
    insert into public.point_ledger (user_id, delta, reason, created_by)
      values (p_user, p_delta, left(p_reason, 200), auth.uid());
  end if;
  if p_delta > 0 then update public.members set last_use_at = now() where user_id = p_user; end if;
  perform public.issue_coupons_if_needed(p_user);
  return public.member_point_balance(p_user);
end $$;
revoke execute on function public.admin_adjust_points(uuid, int, text) from public, anon;
grant execute on function public.admin_adjust_points(uuid, int, text) to authenticated;
