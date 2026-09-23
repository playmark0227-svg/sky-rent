// =====================================================================
// admin — スタッフ向け Edge Function (実装契約書 §2.2)
//
//   POST /admin/members/invite   (members.write)  会員を招待 (パスワードは本人がメールのリンクから設定)
//   POST /admin/staff/invite     (staff.write)    スタッフを招待 + staff 行を作成 (既存ユーザーなら staff 行だけ)
//   POST /admin/staff/list       (staff.write)    スタッフ一覧 + 最終ログイン・二段階認証の有無
//   POST /admin/staff/reset-mfa  (staff.write)    他のスタッフの二段階認証 (認証アプリ) の登録を消す。監査ログに記録
//   POST /admin/outbox/process   (outbox.read)    メール送信・カレンダー同期のワーカーを 1 回実行 ({refIds?, limit?})
//   GET  /admin/calendar/status  (settings.write) 担当者カレンダーの共有状態
//   POST /admin/calendar/test    (settings.write) 1 カレンダーの共有状態 + 今後 7 日の予定あり時間帯の件数
//
// 認証: Authorization の JWT を検証し、AAL2 (二段階認証済み) + has_perm を関数内で確認する (requirePerm)。
// ログに個人情報 (メールアドレス・氏名) を出さない。
// =====================================================================
import { ApiError, handle, readJson, subPath } from '../_shared/http.ts';
import { adminClient, env, requirePerm, type Caller } from '../_shared/db.ts';
import { pgToApiError } from '../_shared/errors.ts';
import { runWorker } from '../_shared/worker-core.ts';
import { isConfigured, loadServiceAccount, serviceAccountEmail } from '../_shared/google.ts';
import { loadCalendarSettings, probeCalendar } from '../_shared/staff-calendar.ts';

const ROLES = ['admin', 'store_staff', 'accounting', 'maintenance', 'viewer'];
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const LOCATION_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------
// 入力の検証
// ---------------------------------------------------------------------
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

function invalid(fields: Record<string, string>): never {
  throw new ApiError('VALIDATION', 400, undefined, { fields });
}

function checkLen(fields: Record<string, string>, name: string, v: string, max: number, label: string) {
  if (v.length > max) fields[name] = label + 'は' + max + '文字以内で入力してください';
}

function normalizeEmail(v: unknown, fields: Record<string, string>): string {
  const email = str(v).toLowerCase();
  if (!email) fields.email = 'メールアドレスを入力してください';
  else if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'メールアドレスの形式が正しくありません';
  return email;
}

// ---------------------------------------------------------------------
// Auth ユーザー
// ---------------------------------------------------------------------
/** メールアドレスから既存の Auth ユーザーを探す (無ければ null) */
async function findUserByEmail(email: string): Promise<{ id: string; email?: string; confirmed: boolean } | null> {
  const auth = adminClient().auth.admin;
  const target = email.toLowerCase();
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await auth.listUsers({ page, perPage: 1000 });
    if (error) throw new ApiError('INTERNAL', 500);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return { id: hit.id, email: hit.email, confirmed: !!(hit.email_confirmed_at || hit.last_sign_in_at) };
    if (users.length < 1000) break;
  }
  return null;
}

function isEmailExists(err: unknown): boolean {
  const e = err as { code?: string; status?: number; message?: string } | null;
  if (!e) return false;
  return e.code === 'email_exists' || e.code === 'user_already_exists' ||
    (e.status === 422 && /already been registered|already exists/i.test(String(e.message || '')));
}

async function hasPerm(caller: Caller, perm: string): Promise<boolean> {
  const { data, error } = await caller.client.rpc('has_perm', { p_perm: perm });
  if (error) throw pgToApiError(error);
  return data === true;
}

function staffOut(row: Json) {
  return {
    userId: row.user_id, name: row.name || '', email: row.email || '', role: row.role,
    locationIds: row.location_ids == null ? null : row.location_ids, active: row.active !== false,
    createdAt: row.created_at || null, updatedAt: row.updated_at || null
  };
}

// ---------------------------------------------------------------------
// 1. 会員の招待
// ---------------------------------------------------------------------
async function inviteMember(req: Request) {
  const caller = await requirePerm(req, 'members.write');
  const b = await readJson(req);
  const fields: Record<string, string> = {};
  const email = normalizeEmail(b.email, fields);
  const name = str(b.name), kana = str(b.name_kana ?? b.nameKana), phone = str(b.phone), company = str(b.company);
  const invoiceAllowed = b.invoiceAllowed === true || b.invoice_allowed === true;
  checkLen(fields, 'name', name, 100, 'お名前');
  checkLen(fields, 'name_kana', kana, 100, 'フリガナ');
  checkLen(fields, 'phone', phone, 30, '電話番号');
  checkLen(fields, 'company', company, 200, '会社名');
  if (phone && !/^[0-9+\-() ]{6,30}$/.test(phone)) fields.phone = '電話番号は数字とハイフンで入力してください';
  if (Object.keys(fields).length) invalid(fields);

  // 請求書払いの許可は経理権限 (invoices.write) が必要。招待メールを送る前に確認する
  if (invoiceAllowed && !(await hasPerm(caller, 'invoices.write'))) {
    throw new ApiError('FORBIDDEN', 403, '請求書払いを許可する権限がありません。「請求書払いを許可」を外して招待するか、管理者に依頼してください。');
  }

  // 既に使われているアドレスは招待しない (メール確認前の招待中・登録中なら招待メールを送り直す)
  const existing = await findUserByEmail(email);
  if (existing && existing.confirmed) {
    throw new ApiError('CONFLICT', 409, 'このメールアドレスは既に登録されています。会員一覧をご確認ください。');
  }
  const { data, error } = await adminClient().auth.admin.inviteUserByEmail(email, {
    data: { account_type: 'member', name, name_kana: kana, phone, company, invited: true },
    redirectTo: env().SITE_URL + 'mypage.html'
  });
  if (error) {
    if (isEmailExists(error)) {
      throw new ApiError('CONFLICT', 409, 'このメールアドレスは既に登録されています。会員一覧をご確認ください。');
    }
    console.error(JSON.stringify({ level: 'error', msg: 'admin: 会員の招待に失敗', code: (error as { code?: string }).code, status: (error as { status?: number }).status }));
    throw new ApiError('INTERNAL', 500, '招待メールを送信できませんでした。時間をおいてもう一度お試しください。');
  }
  const userId = data.user?.id || null;
  if (userId && invoiceAllowed) {
    const r = await caller.client.rpc('admin_update_member', { p_user: userId, p_patch: { invoice_allowed: true } });
    if (r.error) throw pgToApiError(r.error);
  }
  return { ok: true, userId, email, invited: true, resent: !!existing };
}

// ---------------------------------------------------------------------
// 2. スタッフの招待
// ---------------------------------------------------------------------
async function inviteStaff(req: Request) {
  await requirePerm(req, 'staff.write');
  const b = await readJson(req);
  const fields: Record<string, string> = {};
  const email = normalizeEmail(b.email, fields);
  const name = str(b.name);
  const role = str(b.role);
  checkLen(fields, 'name', name, 100, 'お名前');
  if (!name) fields.name = 'お名前を入力してください';
  if (!ROLES.includes(role)) fields.role = '役割を選択してください';
  const rawLocs = b.locationIds !== undefined ? b.locationIds : b.location_ids;
  let locationIds: string[] | null = null;
  if (rawLocs !== undefined && rawLocs !== null) {
    if (!Array.isArray(rawLocs) || rawLocs.length > 50 || rawLocs.some((x) => typeof x !== 'string' || !LOCATION_RE.test(x))) {
      fields.locationIds = '担当拠点の指定が正しくありません';
    } else {
      locationIds = [...new Set(rawLocs as string[])];
      if (!locationIds.length) fields.locationIds = '担当拠点を1つ以上選ぶか、「全拠点」を選んでください';
    }
  }
  if (Object.keys(fields).length) invalid(fields);

  const db = adminClient();
  if (locationIds) {
    const { data, error } = await db.from('locations').select('id').in('id', locationIds);
    if (error) throw pgToApiError(error);
    if ((data || []).length !== locationIds.length) invalid({ locationIds: '存在しない拠点が含まれています' });
  }

  let userId: string | null = null;
  let invited = false;
  const existing = await findUserByEmail(email);
  if (existing) {
    userId = existing.id;
  } else {
    const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
      data: { account_type: 'staff', name },
      redirectTo: env().SITE_URL + 'manage/login.html'
    });
    if (error) {
      if (isEmailExists(error)) {
        const again = await findUserByEmail(email);
        if (!again) throw new ApiError('INTERNAL', 500);
        userId = again.id;
      } else {
        console.error(JSON.stringify({ level: 'error', msg: 'admin: スタッフの招待に失敗', code: (error as { code?: string }).code, status: (error as { status?: number }).status }));
        throw new ApiError('INTERNAL', 500, '招待メールを送信できませんでした。時間をおいてもう一度お試しください。');
      }
    } else {
      userId = data.user?.id || null;
      invited = true;
    }
  }
  if (!userId) throw new ApiError('INTERNAL', 500);

  const { data: row, error: insErr } = await db.from('staff')
    .insert({ user_id: userId, name, email, role, location_ids: locationIds, active: true })
    .select('*').single();
  if (insErr) {
    if (invited) {
      // staff 行を作れなかった招待は取り消す (リンクだけ届いて使えない状態を残さない)
      try { await db.auth.admin.deleteUser(userId); } catch (_e) { /* ログのみ */ }
    }
    if ((insErr as { code?: string }).code === '23505') {
      throw new ApiError('CONFLICT', 409, 'このメールアドレスは既にスタッフとして登録されています。スタッフ一覧から役割を変更してください。');
    }
    throw pgToApiError(insErr);
  }
  return { ok: true, userId, invited, staff: staffOut(row as Json) };
}

// ---------------------------------------------------------------------
// 3. スタッフ一覧
// ---------------------------------------------------------------------
async function listStaff(req: Request) {
  const caller = await requirePerm(req, 'staff.write');
  const { data, error } = await caller.client.from('staff')
    .select('user_id, name, email, role, location_ids, active, created_at, updated_at')
    .order('created_at', { ascending: true });
  if (error) throw pgToApiError(error);
  const auth = adminClient().auth.admin;
  const rows = (data || []) as Json[];
  const staff = await Promise.all(rows.map(async (row) => {
    const out: Json = staffOut(row);
    const id = String(row.user_id);
    const [u, f] = await Promise.all([
      auth.getUserById(id).catch(() => null),
      auth.mfa.listFactors({ userId: id }).catch(() => null)
    ]);
    const user = u && !u.error ? u.data.user : null;
    const factors = (f && !f.error && f.data ? (f.data.factors || []) : ((user as unknown as { factors?: Json[] })?.factors || [])) as Json[];
    out.lastSignInAt = user?.last_sign_in_at || null;
    out.emailConfirmed = !!(user?.email_confirmed_at);
    out.invitedAt = (user as unknown as { invited_at?: string })?.invited_at || null;
    out.mfaEnabled = factors.some((x) => x.factor_type === 'totp' && x.status === 'verified');
    return out;
  }));
  return { ok: true, staff };
}

// ---------------------------------------------------------------------
// 3b. 二段階認証のリセット (スマートフォンの紛失・機種変更で認証アプリを使えなくなったスタッフ向け)
//     対象の TOTP などの登録 (factor) をすべて消す。対象は次回ログイン時に登録し直す。
//     自分自身は対象外 (乗っ取られたセッションから二段階認証を外させない)。監査ログに1行残す。
// ---------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function resetStaffMfa(req: Request) {
  const caller = await requirePerm(req, 'staff.write');
  const b = await readJson(req);
  const userId = str(b.userId ?? b.user_id).toLowerCase();
  if (!UUID_RE.test(userId)) invalid({ userId: 'リセットするスタッフを選んでください' });
  if (userId === String(caller.user.id).toLowerCase()) {
    throw new ApiError('FORBIDDEN', 403, 'ご自身の二段階認証はリセットできません。別の管理者に依頼してください。');
  }

  const db = adminClient();
  const { data: rows, error } = await db.from('staff').select('user_id, role').in('user_id', [userId, caller.user.id]);
  if (error) throw pgToApiError(error);
  const target = (rows || []).find((r: Json) => String(r.user_id) === userId);
  if (!target) throw new ApiError('NOT_FOUND', 404, '対象のスタッフが見つかりませんでした。スタッフ一覧を再読み込みしてください。');
  const me = (rows || []).find((r: Json) => String(r.user_id) === String(caller.user.id));

  const auth = db.auth.admin;
  const { data: list, error: listErr } = await auth.mfa.listFactors({ userId });
  if (listErr) {
    console.error(JSON.stringify({ level: 'error', msg: 'admin: 二段階認証の一覧を取得できません', code: (listErr as { code?: string }).code, status: (listErr as { status?: number }).status }));
    throw new ApiError('INTERNAL', 500, '二段階認証の登録状況を確認できませんでした。時間をおいてもう一度お試しください。');
  }
  const factors = ((list && list.factors) || []) as unknown as Json[];
  const removedFactors: { type: string; status: string }[] = [];
  let failed = false;
  for (const f of factors) {
    const { error: delErr } = await auth.mfa.deleteFactor({ id: String(f.id), userId });
    // 同時に別の管理者が消した (もう無い) ものは、消えているので続ける
    if (delErr && (delErr as { status?: number }).status === 404) continue;
    if (delErr) {
      failed = true;
      console.error(JSON.stringify({ level: 'error', msg: 'admin: 二段階認証を削除できません', code: (delErr as { code?: string }).code, status: (delErr as { status?: number }).status }));
      break;
    }
    removedFactors.push({ type: String(f.factor_type || ''), status: String(f.status || '') });
  }

  // 監査ログ (追記のみの表。service_role で直接書く。途中で失敗した場合も、消した分は記録する)
  const { error: auditErr } = await db.from('audit_log').insert({
    actor: caller.user.id,
    actor_role: me ? String(me.role) : 'staff',
    action: 'mfa_reset',
    table_name: 'staff',
    row_id: userId,
    diff: { removed: removedFactors.length, factors: removedFactors, complete: !failed }
  });
  if (auditErr) {
    console.error(JSON.stringify({ level: 'error', msg: 'admin: 監査ログに記録できません', code: auditErr.code }));
  }
  if (failed) {
    throw new ApiError('INTERNAL', 500, '二段階認証のリセットを完了できませんでした。時間をおいてもう一度お試しください。');
  }
  return { ok: true, removed: removedFactors.length };
}

// ---------------------------------------------------------------------
// 4. ワーカー (メール送信・カレンダー同期) を 1 回実行
//    {limit?: 1〜50 (既定 20), refIds?: [予約番号・受付番号...]} refIds を渡すとそのジョブだけを処理する
// ---------------------------------------------------------------------
async function processOutbox(req: Request) {
  await requirePerm(req, 'outbox.read');
  const b = await readJson(req);
  const limit = Math.min(50, Math.max(1, Number.isFinite(Number(b.limit)) ? Math.floor(Number(b.limit)) : 20));
  let refIds: string[] | undefined;
  if (b.refIds !== undefined && b.refIds !== null) {
    // 長さの上限は worker-core (64 文字) と同じ。超えた値を黙って捨てると、指定なし (= 全件の処理) になってしまうため
    if (!Array.isArray(b.refIds) || b.refIds.length > 50 ||
        b.refIds.some((x: unknown) => typeof x !== 'string' || !x.trim() || x.length > 64)) {
      invalid({ refIds: '対象の指定が正しくありません' });
    }
    refIds = [...new Set((b.refIds as string[]).map((x) => x.trim()))];
    // 空の一覧は「対象なし」(全件の処理にはしない)
    if (!refIds.length) return { ok: true, processed: 0, results: [] };
  }
  const r = await runWorker(refIds ? { limit, refIds } : { limit });
  return { ok: true, processed: r.processed, results: r.results };
}

// ---------------------------------------------------------------------
// 5. / 6. Google カレンダーの共有状態
// ---------------------------------------------------------------------
async function calendarStatus(req: Request) {
  await requirePerm(req, 'settings.write');
  const cfg = await loadCalendarSettings();
  const configured = isConfigured();
  const { data: locRows, error } = await adminClient().from('locations').select('id').order('sort').order('id');
  if (error) throw pgToApiError(error);
  const locIds = [...new Set([...(locRows || []).map((l: Json) => String(l.id)), ...Object.keys(cfg.locations)])];
  const locations: Record<string, { calendarId: string; access: string; error?: string }[]> = {};
  await Promise.all(locIds.map(async (id) => {
    const ids = (cfg.locations[id] || { calendarIds: [] }).calendarIds;
    locations[id] = await Promise.all(ids.map(async (calendarId) => {
      const r = await probeCalendar(calendarId, 1);
      const item: { calendarId: string; access: string; error?: string } = { calendarId, access: r.access };
      if (r.error) item.error = r.error;
      return item;
    }));
  }));
  const out: Json = {
    ok: true,
    configured,
    serviceAccountEmail: serviceAccountEmail(),
    enabled: cfg.enabled,
    mode: cfg.mode,
    locations
  };
  if (!configured) out.error = loadServiceAccount().error || 'Google 連携が未設定です';
  return out;
}

async function calendarTest(req: Request) {
  await requirePerm(req, 'settings.write');
  const b = await readJson(req);
  const calendarId = str(b.calendarId);
  if (!calendarId || calendarId.length > 254 || /[\s<>"]/.test(calendarId)) {
    invalid({ calendarId: 'カレンダー ID を正しく入力してください (例: staff@example.com)' });
  }
  const days = 7;
  const from = Date.now(), to = from + days * 86_400_000;
  const r = await probeCalendar(calendarId, days);
  const out: Json = {
    ok: true,
    configured: isConfigured(),
    serviceAccountEmail: serviceAccountEmail(),
    calendarId,
    access: r.access,
    busyCount: r.access === 'none' ? 0 : r.busy.length,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString()
  };
  if (r.error) out.error = r.error;
  return out;
}

// ---------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------
const ROUTES: Record<string, { methods: string[]; fn: (req: Request) => Promise<unknown> }> = {
  '/members/invite': { methods: ['POST'], fn: inviteMember },
  '/staff/invite': { methods: ['POST'], fn: inviteStaff },
  '/staff/list': { methods: ['POST', 'GET'], fn: listStaff },
  '/staff/reset-mfa': { methods: ['POST'], fn: resetStaffMfa },
  '/outbox/process': { methods: ['POST'], fn: processOutbox },
  '/calendar/status': { methods: ['GET', 'POST'], fn: calendarStatus },
  '/calendar/test': { methods: ['POST'], fn: calendarTest }
};

Deno.serve((req) => handle(req, async (r) => {
  const path = subPath(r, 'admin');
  const route = ROUTES[path];
  if (!route) throw new ApiError('NOT_FOUND', 404, 'ご指定の操作は見つかりませんでした。');
  if (!route.methods.includes(r.method)) throw new ApiError('METHOD_NOT_ALLOWED', 405);
  return await route.fn(r);
}));
