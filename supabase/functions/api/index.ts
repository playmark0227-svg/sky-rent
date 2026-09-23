// =====================================================================
// api — 公開サイト・会員向け (実装契約書 §2.1)
//   GET  /api/availability?from&to     空き状況 (車両の埋まり・受け渡し時刻・担当者の予定あり時間帯)
//   POST /api/quote                    見積 (サーバーのカタログ・料金ルールで計算)
//   POST /api/reservations             予約確定
//   POST /api/reservations/lookup      予約照会 (照会キー / 会員本人)
//   POST /api/reservations/cancel      お客様によるキャンセル
//   POST /api/inquiries                お問い合わせ
//   POST /api/me/close                 会員の退会
// 金額・在庫・同意・担当者の空きはすべてサーバーで確認する (クライアントの値は信用しない)。
// =====================================================================
import { ApiError, handle, readJson, subPath, validationError } from '../_shared/http.ts';
import { adminClient, type Caller, env, getCaller, isServiceRole } from '../_shared/db.ts';
import { pgToApiError, withPgRetry } from '../_shared/errors.ts';
import {
  type AssetRow,
  cancellationFor,
  type LegalDoc,
  loadActiveLegal,
  loadAssetBundle,
  loadPricingRules,
  type OptionRow,
  quoteErrorCode,
  serverQuote,
  toIso
} from '../_shared/catalog.ts';
import { canonicalJson, ensureGuestTokenHash, lookupUrl, sha256hex, verifyGuestToken } from '../_shared/tokens.ts';
import { allowByValue, limitByIp, limitByValue, mailboxKey, phoneKey } from '../_shared/ratelimit.ts';
import { emailStatusOf, runWorker } from '../_shared/worker-core.ts';
import { INQUIRY_TOPICS, TEMPLATES as MAIL_TEMPLATES } from '../_shared/mail-templates.ts';
import { checkStaffForReservation, getStaffAvailability, handoverMinutesFor } from '../_shared/staff-calendar.ts';
import { isValidEmail } from '../_shared/mail.ts';

const HOUR = 3600000;
const DAY = 86400000;
const MAX_AVAILABILITY_DAYS = 120;
const WORKER_WAIT_MS = 8000;
const ACTIVE_STATUSES = ['confirmed', 'in_use'];
const RESERVATION_CONSENTS = ['clause', 'cancel', 'privacy'];
const INQUIRY_CONSENTS = ['privacy'];

// ---------------------------------------------------------------------
// 予約の悪用 (偽の連絡先で車両を長期間押さえる・予約確定メールを第三者へ送り付ける) を抑える上限。
//   ゲスト (ログインしていない予約) はメールアドレス・電話番号の所有を確認していないため厳しめ。
//   会員はメールアドレスを確認済みのアカウントなので緩め。
//   service_role の呼び出し (運用スクリプト・自動テスト) は対象外 (IP 単位のレート制限と同じ扱い)。
// ---------------------------------------------------------------------
/** ゲストが1件で予約できる最長の期間 (日)。これより長いご利用は会員ログインかお問い合わせで */
const GUEST_MAX_PERIOD_DAYS = 31;
/** 同時に持てる有効な予約 (確定・貸出中で、まだ返却時刻の前) の件数と、その残りの合計日数 */
const HOLD_LIMITS = {
  guest: { count: 3, days: 31 }, // 同じメールアドレス (受信箱) または同じ電話番号ごと
  member: { count: 10, days: 279 } // 会員ごと (93日 × 3台)
};
/** 同じ受信箱への予約確定メール (= 予約の作成) は 1日この件数まで */
const RESERVE_MAIL_PER_DAY = 5;
/** 同じ受信箱へのお問い合わせ自動返信は 1日この件数まで (超えた分も受け付けるが、自動返信は送らない) */
const INQUIRY_REPLY_PER_DAY = 3;

const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;
const RES_ID_RE = /^R\d{1,12}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------
// 入力の小物
// ---------------------------------------------------------------------
function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max + 1);
}

/** 全角数字・記号を半角に (電話番号用) */
function normalizePhone(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐－―ー−]/g, '-').replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[＋]/g, '+')
    .replace(/\s+/g, ' ').trim();
}

function validPhone(p: string): boolean {
  if (!/^[0-9+\-() ]{10,20}$/.test(p)) return false;
  const digits = p.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

/** 氏名・会社名に URL を書かせない (確認メールを使った迷惑メールの送り付け対策) */
function hasUrl(s: string): boolean {
  return /(https?:|:\/\/|www\.)/i.test(s);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function uniqStrings(v: unknown, max: number): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !ASSET_ID_RE.test(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

function methodOnly(req: Request, method: string) {
  if (req.method !== method) throw new ApiError('METHOD_NOT_ALLOWED', 405);
}

/** 期間の検証 (開始 < 終了)。ISO (UTC) で返す */
function parsePeriod(start: unknown, end: unknown, fields: Record<string, string>) {
  const s = toIso(start);
  const e = toIso(end);
  if (!s) fields.start = '貸出日時を正しく指定してください。';
  if (!e) fields.end = '返却日時を正しく指定してください。';
  if (s && e && Date.parse(e) <= Date.parse(s)) fields.end = '返却日時は貸出日時より後にしてください。';
  return { start: s || '', end: e || '' };
}

// ---------------------------------------------------------------------
// 会員・クーポン
// ---------------------------------------------------------------------
type MemberRow = { user_id: string; status: string; invoice_allowed: boolean; email: string };

async function activeMember(caller: Caller | null): Promise<MemberRow | null> {
  if (!caller) return null;
  const { data, error } = await adminClient().from('members')
    .select('user_id, status, invoice_allowed, email').eq('user_id', caller.user.id).maybeSingle();
  if (error) throw pgToApiError(error);
  return data && data.status === 'active' ? (data as MemberRow) : null;
}

/** ログイン会員本人の未使用・期限内のクーポンだけを認める */
async function memberCoupon(caller: Caller | null, member: MemberRow | null, couponId: string | null) {
  if (!couponId) return null;
  if (!caller) throw new ApiError('UNAUTHENTICATED', 401, 'クーポンを使うにはログインが必要です。ログインしてから、もう一度お試しください。');
  if (!member || !UUID_RE.test(couponId)) throw new ApiError('COUPON_INVALID', 409);
  const { data, error } = await adminClient().from('coupons')
    .select('id, user_id, amount, used_at, expires_at').eq('id', couponId).maybeSingle();
  if (error) throw pgToApiError(error);
  if (!data || data.user_id !== member.user_id || data.used_at ||
    (data.expires_at && Date.parse(data.expires_at) < Date.now())) {
    throw new ApiError('COUPON_INVALID', 409);
  }
  return { id: data.id as string, amount: data.amount as number };
}

// ---------------------------------------------------------------------
// 同意
// ---------------------------------------------------------------------
async function requireConsent(consent: any, required: string[]) {
  const active = await loadActiveLegal();
  const docs: Array<{ id?: unknown; version?: unknown }> = consent && Array.isArray(consent.documents) ? consent.documents : [];
  const needed = active.filter((d) => required.includes(d.id));
  const missing = needed.filter((a) => !docs.some((d) => d && d.id === a.id && String(d.version) === a.version));
  if (missing.length) {
    throw new ApiError('CONSENT_REQUIRED', 400, undefined, {
      documents: needed.map((d: LegalDoc) => ({ id: d.id, version: d.version, title: d.title, url: d.url })),
      missing: missing.map((d) => d.id)
    });
  }
  const clientAt = consent && typeof consent.agreedAt === 'string' ? toIso(consent.agreedAt) : null;
  return {
    documents: needed.map((d) => ({ id: d.id, version: d.version })),
    agreedAt: new Date().toISOString(),
    clientAgreedAt: clientAt
  };
}

// ---------------------------------------------------------------------
// 空き状況 (DB)
// ---------------------------------------------------------------------
async function vehicleFree(assetId: string, start: string, end: string): Promise<boolean> {
  const { data, error } = await adminClient().from('reservations').select('id')
    .eq('asset_id', assetId).in('status', ACTIVE_STATUSES).lt('start_at', end).gt('end_at', start).limit(1);
  if (error) throw pgToApiError(error);
  return !(data && data.length);
}

/** 同じ拠点で受け渡し時刻が近い有効予約があるか (create_reservation_tx と同じ判定) */
async function handoverClash(locationId: string, start: string, end: string, minutes: number): Promise<boolean> {
  if (!(minutes > 0)) return false;
  const m = minutes * 60000;
  const s = Date.parse(start);
  const e = Date.parse(end);
  const { data, error } = await adminClient().from('reservations').select('start_at, end_at')
    .eq('location_id', locationId).eq('kind', 'rental').in('status', ACTIVE_STATUSES)
    .lt('start_at', new Date(Math.max(s, e) + m).toISOString())
    .gt('end_at', new Date(Math.min(s, e) - m).toISOString())
    .limit(1000);
  if (error) throw pgToApiError(error);
  return (data || []).some((r: { start_at: string; end_at: string }) =>
    [Date.parse(r.start_at), Date.parse(r.end_at)].some((t) => Math.abs(t - s) < m || Math.abs(t - e) < m));
}

async function pageAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; from < 50000; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw pgToApiError(error);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// 予約の上限 (偽の連絡先で車両を押さえ続けることへの対策)
// ---------------------------------------------------------------------
/** ゲストの1件あたりの期間 (会員・service_role は DB の上限 93日のまま) */
function checkGuestPeriod(start: string, end: string) {
  if (Date.parse(end) - Date.parse(start) > GUEST_MAX_PERIOD_DAYS * DAY) {
    throw new ApiError('PERIOD_TOO_LONG', 400,
      'ログインせずにWebで予約できる期間は最長' + GUEST_MAX_PERIOD_DAYS + '日です。それより長いご利用は、会員登録・ログインのうえご予約いただくか、' +
      '公式LINEまたはお問い合わせフォームからご相談ください。',
      { fields: { end: 'ログインせずに予約できる期間は最長' + GUEST_MAX_PERIOD_DAYS + '日です。' } });
  }
}

type HoldRow = { start_at: string; end_at: string; customer_email?: string; customer_phone?: string };

/**
 * 同じ人 (会員は会員ID、ゲストは同じ受信箱のメールアドレスか同じ電話番号) が持っている有効な予約
 * (確定・貸出中で、まだ返却時刻の前) の件数と残りの日数に、今回の予約を足して上限を超えるなら断る。
 */
async function enforceHoldLimits(member: MemberRow | null, customer: { email: string; phone: string }, start: string, end: string) {
  const db = adminClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let rows: HoldRow[];
  if (member) {
    rows = await pageAll<HoldRow>((a, b) => db.from('reservations').select('start_at, end_at')
      .eq('user_id', member.user_id).eq('kind', 'rental').in('status', ACTIVE_STATUSES).gt('end_at', nowIso)
      .order('id', { ascending: true }).range(a, b));
  } else {
    // 連絡先の書き方の違い (大文字・+サブアドレス・ハイフンの有無・+81) でそろえて比べる
    const mk = mailboxKey(customer.email);
    const pk = phoneKey(customer.phone);
    const all = await pageAll<HoldRow>((a, b) => db.from('reservations').select('start_at, end_at, customer_email, customer_phone')
      .eq('kind', 'rental').in('status', ACTIVE_STATUSES).gt('end_at', nowIso)
      .order('id', { ascending: true }).range(a, b));
    rows = all.filter((r) => mailboxKey(r.customer_email || '') === mk || (!!pk && phoneKey(r.customer_phone || '') === pk));
  }
  const lim = member ? HOLD_LIMITS.member : HOLD_LIMITS.guest;
  const heldMs = rows.reduce((sum, r) => sum + Math.max(0, Date.parse(r.end_at) - Math.max(Date.parse(r.start_at), nowMs)), 0);
  const newMs = Math.max(0, Date.parse(end) - Date.parse(start));
  if (rows.length + 1 > lim.count || heldMs + newMs > lim.days * DAY) {
    const message = member
      ? '会員1名あたり、Webでお持ちいただけるご予約は' + lim.count + '件・合計' + lim.days + '日分までです。' +
        'さらにご予約が必要な場合は、公式LINEまたはお問い合わせフォームからご相談ください。'
      : 'ログインせずにWeb予約できるのは、同じメールアドレス・電話番号で' + lim.count + '件・合計' + lim.days + '日分までです。' +
        'さらにご予約いただく場合は、会員登録・ログインのうえご予約いただくか、公式LINEまたはお問い合わせフォームからご相談ください。';
    throw new ApiError('RESERVATION_LIMIT', 409, message, { limit: { count: lim.count, days: lim.days } });
  }
}

// ---------------------------------------------------------------------
// ワーカーの同期実行 (最大 8 秒待つ。終わらなければ裏で続ける)
// ---------------------------------------------------------------------
function inBackground(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(p);
}

/**
 * この予約・問い合わせの送信キュー (メールと Google カレンダーへの書き込み) を同期実行する。
 * メールとカレンダーは並行して処理し、合わせて最大 8 秒待つ。終わらなければ裏で続ける
 * (それでも終わらなかったものは定期起動の worker が処理する)。
 */
async function drainOutbox(refId: string): Promise<void> {
  const quiet = (p: Promise<unknown>) => p.then(() => 'done' as const).catch(() => {
    console.error(JSON.stringify({ level: 'error', code: 'WORKER_SYNC_FAILED' }));
    return 'done' as const;
  });
  const work = Promise.all([
    quiet(runWorker({ refIds: [refId], limit: 20, templates: [...MAIL_TEMPLATES] })),
    quiet(runWorker({ refIds: [refId], limit: 5, templates: ['gcal_sync'] }))
  ]).then(() => 'done' as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), WORKER_WAIT_MS);
  });
  const r = await Promise.race([work, timeout]);
  clearTimeout(timer);
  if (r === 'timeout') inBackground(work);
}

async function latestEmailStatus(refId: string, template: string): Promise<'sent' | 'queued' | 'skipped' | 'failed'> {
  const { data, error } = await adminClient().from('outbox').select('status')
    .eq('ref_id', refId).eq('template', template).order('id', { ascending: false }).limit(1);
  if (error || !data || !data.length) return 'skipped';
  return emailStatusOf(data[0].status);
}

function shopEmails(): string[] {
  return env().shopEmails.filter((a) => isValidEmail(a));
}

// ---------------------------------------------------------------------
// 1. 空き状況
// ---------------------------------------------------------------------
async function availability(req: Request, url: URL) {
  methodOnly(req, 'GET');
  const fields: Record<string, string> = {};
  const from = toIso(url.searchParams.get('from'));
  const to = toIso(url.searchParams.get('to'));
  if (!from) fields.from = '開始日時を指定してください。';
  if (!to) fields.to = '終了日時を指定してください。';
  if (from && to) {
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0) fields.to = '終了日時は開始日時より後にしてください。';
    else if (span > MAX_AVAILABILITY_DAYS * DAY + HOUR) fields.to = '一度に確認できる期間は' + MAX_AVAILABILITY_DAYS + '日までです。';
  }
  if (Object.keys(fields).length) throw validationError(fields);
  await limitByIp(req, 'availability', 300, 600);

  const db = adminClient();
  const [busyRows, handoverRows, staffRaw] = await Promise.all([
    pageAll<{ asset_id: string; start_at: string; end_at: string }>((a, b) =>
      db.rpc('public_busy_ranges', { p_from: from, p_to: to }).range(a, b)),
    pageAll<{ location_id: string; start_at: string; end_at: string }>((a, b) =>
      db.from('reservations').select('location_id, start_at, end_at')
        .eq('kind', 'rental').in('status', ACTIVE_STATUSES)
        .lt('start_at', to!).gt('end_at', from!)
        .order('start_at', { ascending: true }).range(a, b)),
    getStaffAvailability({ from: from!, to: to! }).catch(() => null)
  ]);

  const handovers: Record<string, string[]> = {};
  for (const r of handoverRows) {
    const list = handovers[r.location_id] = handovers[r.location_id] || [];
    list.push(new Date(r.start_at).toISOString(), new Date(r.end_at).toISOString());
  }

  let staff: Record<string, unknown>;
  if (staffRaw) {
    const locations: Record<string, unknown> = {};
    for (const [locId, loc] of Object.entries(staffRaw.locations || {})) {
      // カレンダーID (担当者のメールアドレス) や予定の件名は返さない。時間帯だけ
      locations[locId] = {
        configured: !!loc.configured,
        // 読めないカレンダーがある (共有されていない・接続失敗)。画面で「担当者の予定を確認できません」と案内する
        unavailable: !!(loc as { unavailable?: boolean }).unavailable,
        busy: (loc.busy || []).map((b) => ({ start: b.start, end: b.end })),
        calendars: (loc.calendars || []).map((c) => ({ busy: (c.busy || []).map((b) => ({ start: b.start, end: b.end })) }))
      };
    }
    staff = {
      enabled: !!staffRaw.enabled,
      mode: staffRaw.mode,
      handoverMinutes: staffRaw.handoverMinutes,
      oneHandoverAtATime: !!staffRaw.oneHandoverAtATime,
      locations
    };
  } else {
    staff = { enabled: false, mode: 'handover', handoverMinutes: 0, oneHandoverAtATime: false, locations: {}, error: 'CALENDAR_UNAVAILABLE' };
  }

  return {
    ok: true,
    from,
    to,
    busy: busyRows.map((b) => ({
      assetId: b.asset_id,
      start: new Date(b.start_at).toISOString(),
      end: new Date(b.end_at).toISOString()
    })),
    handovers,
    staff
  };
}

// ---------------------------------------------------------------------
// 2. 見積
// ---------------------------------------------------------------------
function parseQuoteInput(b: any, fields: Record<string, string>) {
  const assetId = str(b.assetId, 40);
  if (!ASSET_ID_RE.test(assetId)) fields.assetId = '車両を選択してください。';
  const period = parsePeriod(b.start, b.end, fields);
  const optionIds = uniqStrings(b.optionIds, 20);
  if (optionIds === null) fields.optionIds = 'オプションの指定が正しくありません。';
  const discountType = b.discountType === null || b.discountType === undefined || b.discountType === '' ? null : str(b.discountType, 40);
  if (discountType !== null && !/^[a-z_]{1,40}$/.test(discountType)) fields.discountType = '割引の種類が正しくありません。';
  const couponId = b.couponId === null || b.couponId === undefined || b.couponId === '' ? null : str(b.couponId, 40);
  return { assetId, start: period.start, end: period.end, optionIds: optionIds || [], discountType, couponId };
}

async function quoteHandler(req: Request) {
  methodOnly(req, 'POST');
  const b = await readJson(req);
  const fields: Record<string, string> = {};
  const p = parseQuoteInput(b, fields);
  if (Object.keys(fields).length) throw validationError(fields);
  await limitByIp(req, 'quote', 300, 600);

  const caller = await getCaller(req);
  const member = await activeMember(caller);
  const coupon = await memberCoupon(caller, member, p.couponId);
  const { quote, bundle } = await serverQuote({ ...p, coupon });

  const reasons: string[] = [];
  let vehicle = true;
  let staffOk = true;
  let handover = true;
  if (quote.ok) {
    const locId = bundle.asset.location_id;
    const [free, minutes] = await Promise.all([
      vehicleFree(bundle.asset.id, p.start, p.end),
      handoverMinutesFor(locId)
    ]);
    vehicle = free;
    if (!free) reasons.push('AVAILABILITY_CONFLICT');
    const [clash, st] = await Promise.all([
      handoverClash(locId, p.start, p.end, minutes),
      checkStaffForReservation({ locationId: locId, start: p.start, end: p.end })
        .catch(() => ({ ok: false as const, code: 'CALENDAR_UNAVAILABLE' as const, message: '' }))
    ]);
    if (clash) {
      handover = false;
      reasons.push('HANDOVER_CONFLICT');
    }
    if (!st.ok) {
      staffOk = false;
      reasons.push(st.code);
    }
  }
  return { ok: true, quote, availability: { vehicle, staff: staffOk, handover, reasons } };
}

// ---------------------------------------------------------------------
// 3. 予約確定
// ---------------------------------------------------------------------
type ResRow = {
  id: string; asset_id: string; start_at: string; end_at: string; total: number; price: any;
  status: string; payment_method: string; request_hash?: string | null; guest_token_hash?: string | null;
};

async function createdResponse(r: ResRow, replay: boolean) {
  // 照会キーのハッシュを保存 (予約番号は確定後に決まるため。値は予約番号から決まるので何度実行しても同じ)
  const token = await ensureGuestTokenHash(r.id);
  await drainOutbox(r.id);
  const email = { status: await latestEmailStatus(r.id, 'reservation_confirmed') };
  return {
    ok: true,
    replay,
    reservation: {
      id: r.id,
      assetId: r.asset_id,
      start: new Date(r.start_at).toISOString(),
      end: new Date(r.end_at).toISOString(),
      total: r.total,
      price: r.price,
      status: r.status,
      paymentMethod: r.payment_method
    },
    guestToken: token,
    lookupUrl: lookupUrl(r.id, token),
    email
  };
}

async function reservationHandler(req: Request) {
  methodOnly(req, 'POST');
  const b = await readJson(req);

  // --- 入力の検証 ---
  const fields: Record<string, string> = {};
  const idempotencyKey = str(b.idempotencyKey, 100);
  if (!KEY_RE.test(idempotencyKey)) fields.idempotencyKey = '送信キーが正しくありません。画面を再読み込みしてください。';
  const q = parseQuoteInput(b, fields);
  const c = b.customer && typeof b.customer === 'object' ? b.customer : {};
  const customer = {
    name: str(c.name, 100),
    kana: str(c.kana, 100),
    email: str(c.email, 254),
    phone: normalizePhone(c.phone),
    company: str(c.company, 200)
  };
  if (!customer.name) fields.name = 'お名前を入力してください。';
  else if (customer.name.length > 100) fields.name = 'お名前は100文字以内で入力してください。';
  else if (hasUrl(customer.name)) fields.name = 'お名前にURLは入力できません。';
  if (customer.kana.length > 100) fields.kana = 'フリガナは100文字以内で入力してください。';
  else if (hasUrl(customer.kana)) fields.kana = 'フリガナにURLは入力できません。';
  if (!isValidEmail(customer.email)) fields.email = 'メールアドレスを正しく入力してください。';
  if (!validPhone(customer.phone)) fields.phone = '電話番号を正しく入力してください (半角数字とハイフン)。';
  if (customer.company.length > 200) fields.company = '会社名は200文字以内で入力してください。';
  else if (hasUrl(customer.company)) fields.company = '会社名にURLは入力できません。';
  const paymentMethod = b.paymentMethod === undefined || b.paymentMethod === null ? 'onsite' : b.paymentMethod;
  if (paymentMethod !== 'onsite' && paymentMethod !== 'invoice') fields.paymentMethod = 'お支払い方法を選択してください。';
  if (b.licenseConfirmed !== true) fields.licenseConfirmed = '運転される方全員が有効な運転免許証をお持ちであることを確認し、チェックしてください。';
  const note = str(b.note, 2000);
  if (note.length > 2000) fields.note = 'ご要望は2000文字以内で入力してください。';
  if (!isInt(b.expectedTotal) || b.expectedTotal < 0) fields.expectedTotal = '表示された料金を確認できませんでした。画面を再読み込みしてください。';
  if (Object.keys(fields).length) throw validationError(fields);

  // --- レート制限 (IP ハッシュ 10回/10分) ---
  await limitByIp(req, 'reserve', 10, 600);

  const caller = await getCaller(req);
  const member = await activeMember(caller);

  // --- 冪等: 同じキーで確定済みなら最初の結果を返す ---
  const requestHash = await sha256hex(canonicalJson({
    assetId: q.assetId, start: q.start, end: q.end, optionIds: [...q.optionIds].sort(),
    discountType: q.discountType, couponId: q.couponId, customer, paymentMethod, note,
    userId: member ? member.user_id : null
  }));
  {
    const { data: prev, error } = await adminClient().from('reservations')
      .select('id, asset_id, start_at, end_at, total, price, status, payment_method, request_hash')
      .eq('idempotency_key', idempotencyKey).maybeSingle();
    if (error) throw pgToApiError(error);
    if (prev) {
      if (prev.request_hash !== requestHash) throw new ApiError('IDEMPOTENCY_KEY_REUSED', 409);
      return await createdResponse(prev as ResRow, true);
    }
  }

  // --- ゲストの1件あたりの期間 (長期の押さえは会員ログインかお問い合わせで) ---
  const trusted = isServiceRole(req);
  if (!member && !trusted) checkGuestPeriod(q.start, q.end);

  // --- 会員の資格 (クーポン・請求書払い) ---
  const coupon = await memberCoupon(caller, member, q.couponId);
  if (paymentMethod === 'invoice' && !(member && member.invoice_allowed)) {
    throw new ApiError('INVOICE_NOT_ALLOWED', 403, undefined, { fields: { paymentMethod: '請求書払いはご利用いただけません。' } });
  }

  // --- サーバーで見積 → 表示金額と照合 ---
  const { quote, bundle, options, rules } = await serverQuote({ ...q, coupon });
  if (!quote.ok) {
    const code = quoteErrorCode(quote.errors);
    throw new ApiError(code, undefined, undefined, { quote });
  }
  if (quote.total !== b.expectedTotal) throw new ApiError('PRICE_CHANGED', 409, undefined, { quote });

  // --- 必須の同意 (貸渡約款・キャンセル規定・プライバシーポリシーの公開中の版) ---
  const consent = await requireConsent(b.consent, RESERVATION_CONSENTS);

  // --- 同じ人が持てる予約の件数・日数 (偽の連絡先で全車両を押さえ続けることへの対策) ---
  if (!trusted) await enforceHoldLimits(member, customer, q.start, q.end);

  // --- 車両の空き (先に軽く確認。最終判定は DB の排他制約) ---
  if (!(await vehicleFree(bundle.asset.id, q.start, q.end))) throw new ApiError('AVAILABILITY_CONFLICT', 409);

  // --- 受け渡し担当者の予定 (Google カレンダーへ直接問い合わせ) ---
  const locId = bundle.asset.location_id;
  const staff = await checkStaffForReservation({ locationId: locId, start: q.start, end: q.end });
  if (!staff.ok) throw new ApiError(staff.code, undefined, staff.message || undefined);
  const handoverMinutes = await handoverMinutesFor(locId);

  // --- 予約確定メールの送り付け対策: 同じ受信箱宛ての予約は 1日 RESERVE_MAIL_PER_DAY 件まで
  //     (IP を特定できない・偽装された場合でも効く。確定の直前に数えるので、入力不備や料金の食い違いは数えない) ---
  await limitByValue(req, 'reserve-mail', mailboxKey(customer.email), RESERVE_MAIL_PER_DAY, 86400);

  // --- 確定 (在庫・クーポン・受け渡し重複は DB がロックして検証) ---
  const emails = [
    { template: 'reservation_confirmed', to: customer.email, payload: {} },
    ...shopEmails().map((to) => ({ template: 'reservation_new_shop', to, payload: {} }))
  ];
  const price = {
    base: quote.base,
    lines: quote.lines,
    subtotal: quote.subtotal,
    discount: quote.discount,
    couponDiscount: quote.couponDiscount,
    total: quote.total,
    hours: quote.hours,
    days: quote.days,
    plan: quote.plan,
    busy: quote.busy,
    rulesVersion: quote.rulesVersion ?? (rules && rules.version) ?? null
  };
  const { data, error } = await withPgRetry(() => adminClient().rpc('create_reservation_tx', {
    p: {
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      asset_id: bundle.asset.id,
      start_at: q.start,
      end_at: q.end,
      user_id: member ? member.user_id : null,
      customer,
      payment_method: paymentMethod,
      license_confirmed: true,
      option_ids: options.map((o: OptionRow) => o.id),
      options: options.map((o: OptionRow) => ({
        optionId: o.id, name: o.name, price: o.price, priceShort: o.price_short, priceType: o.price_type
      })),
      price,
      total: quote.total,
      discount_type: q.discountType,
      coupon_id: coupon ? coupon.id : null,
      coupon_amount: coupon ? coupon.amount : null,
      note,
      consent,
      handover_minutes: handoverMinutes,
      emails
    }
  }));
  if (error) throw pgToApiError(error);
  const r = (data && data.reservation) as ResRow;
  if (!r || !r.id) throw new ApiError('INTERNAL', 500);
  return await createdResponse(r, !!data.replay);
}

// ---------------------------------------------------------------------
// 4・5. 照会・キャンセル
// ---------------------------------------------------------------------
type GuestAuth = { tokenHash: string | null; userId: string | null };

async function guestAuth(req: Request, id: string, token: unknown): Promise<GuestAuth> {
  if (typeof token === 'string' && token.trim()) {
    const hash = await verifyGuestToken(id, token);
    if (!hash) throw new ApiError('NOT_FOUND', 404);
    return { tokenHash: hash, userId: null };
  }
  const caller = await getCaller(req);
  if (!caller) throw new ApiError('UNAUTHENTICATED', 401, 'ご予約の照会には、予約確定メールのURLを開くか、会員ログインが必要です。');
  return { tokenHash: null, userId: caller.user.id };
}

async function loadGuestReservation(id: string, auth: GuestAuth) {
  const { data, error } = await adminClient().rpc('get_reservation_for_guest', {
    p_id: id, p_token_hash: auth.tokenHash, p_user: auth.userId
  });
  if (error) throw pgToApiError(error);
  if (!data) throw new ApiError('NOT_FOUND', 404);
  return data;
}

async function safeReservation(r: any) {
  const bundle = await loadAssetBundle(r.asset_id);
  return {
    reservation: {
      id: r.id,
      reservationId: r.id,
      assetId: r.asset_id,
      assetName: bundle ? bundle.asset.name : '',
      categoryId: r.category_id,
      locationId: r.location_id,
      locationName: bundle ? bundle.location.name : '',
      locationAddress: bundle ? bundle.location.address : '',
      start: new Date(r.start_at).toISOString(),
      end: new Date(r.end_at).toISOString(),
      status: r.status,
      total: r.total,
      price: r.price,
      options: r.options || [],
      optionIds: r.option_ids || [],
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      discountType: r.discount_type,
      customerName: r.customer_name,
      isMember: !!r.user_id,
      createdAt: r.created_at,
      cancelFee: r.cancel_fee ?? null,
      cancelledAt: r.cancelled_at ?? null
    },
    asset: bundle ? bundle.asset : null
  };
}

function parseLookup(b: any) {
  const id = str(b.id, 20).toUpperCase();
  if (!RES_ID_RE.test(id)) throw validationError({ id: '予約番号を正しく入力してください (例: R00012)。' });
  return id;
}

async function lookupHandler(req: Request) {
  methodOnly(req, 'POST');
  const b = await readJson(req);
  const id = parseLookup(b);
  await limitByIp(req, 'lookup', 30, 600);
  const auth = await guestAuth(req, id, b.token);
  const r = await loadGuestReservation(id, auth);
  const [{ reservation, asset }, rules] = await Promise.all([safeReservation(r), loadPricingRules()]);
  const cn = cancellationFor(r, asset as AssetRow | null, rules, new Date());
  return {
    ok: true,
    reservation,
    cancellation: { cancellable: cn.cancellable, fee: cn.cancellable ? cn.fee : 0, pct: cn.pct, label: cn.label }
  };
}

async function cancelHandler(req: Request) {
  methodOnly(req, 'POST');
  const b = await readJson(req);
  const id = parseLookup(b);
  if (!isInt(b.expectedFee) || b.expectedFee < 0) {
    throw validationError({ expectedFee: 'キャンセル料を確認できませんでした。画面を再読み込みしてください。' });
  }
  await limitByIp(req, 'cancel', 10, 600);
  const auth = await guestAuth(req, id, b.token);
  const r = await loadGuestReservation(id, auth);
  const [{ asset }, rules] = await Promise.all([safeReservation(r), loadPricingRules()]);
  const now = new Date();
  const cn = cancellationFor(r, asset as AssetRow | null, rules, now);
  const cancellation = { cancellable: cn.cancellable, fee: cn.cancellable ? cn.fee : 0, pct: cn.pct, label: cn.label };
  if (!cn.cancellable) throw new ApiError('NOT_CANCELLABLE', 409, undefined, { cancellation });
  if (cn.fee !== b.expectedFee) throw new ApiError('PRICE_CHANGED', 409, 'キャンセル料が変わりました。新しい金額をご確認のうえ、もう一度お手続きください。', { cancellation });

  const payload = { reservation_id: id, by: 'customer', cancel_fee: cn.fee, pct: cn.pct, label: cn.label };
  const emails = [
    { template: 'reservation_cancelled', to: r.customer_email, payload },
    ...shopEmails().map((to) => ({ template: 'reservation_cancelled_shop', to, payload }))
  ].filter((e) => isValidEmail(e.to));
  const { data, error } = await withPgRetry(() => adminClient().rpc('cancel_reservation_tx', {
    p_id: id, p_token_hash: auth.tokenHash, p_user: auth.userId, p_fee: cn.fee, p_emails: emails
  }));
  if (error) throw pgToApiError(error);
  await drainOutbox(id);
  const email = { status: await latestEmailStatus(id, 'reservation_cancelled') };
  const { reservation } = await safeReservation(data);
  return { ok: true, reservation, cancellation: { fee: cn.fee, pct: cn.pct, label: cn.label }, email };
}

// ---------------------------------------------------------------------
// 6. お問い合わせ
// ---------------------------------------------------------------------
async function inquiryHandler(req: Request) {
  methodOnly(req, 'POST');
  const b = await readJson(req);

  // ハニーポット (人には見えない欄)。入力があればボットとみなし、受け付けたふりをして保存しない
  if (b.website !== undefined && b.website !== null && String(b.website).trim() !== '') {
    const fake = 'C' + String(Math.floor(10000 + Math.random() * 90000));
    return { ok: true, id: fake, email: { status: 'sent' } };
  }

  const fields: Record<string, string> = {};
  const name = str(b.name, 100);
  const company = str(b.company, 200);
  const email = str(b.email, 254);
  const tel = normalizePhone(b.tel);
  const topic = str(b.topic, 60);
  const body = typeof b.body === 'string' ? b.body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  const reservationId = str(b.reservationId, 20).toUpperCase();
  const idempotencyKey = b.idempotencyKey === undefined || b.idempotencyKey === null || b.idempotencyKey === '' ? null : str(b.idempotencyKey, 100);
  if (!name) fields.name = 'お名前を入力してください。';
  else if (name.length > 100) fields.name = 'お名前は100文字以内で入力してください。';
  else if (hasUrl(name)) fields.name = 'お名前にURLは入力できません。';
  if (company.length > 200) fields.company = '会社名は200文字以内で入力してください。';
  else if (hasUrl(company)) fields.company = '会社名にURLは入力できません。';
  if (!isValidEmail(email)) fields.email = 'メールアドレスを正しく入力してください。';
  if (tel && !validPhone(tel)) fields.tel = '電話番号を正しく入力してください (半角数字とハイフン)。';
  // 種類は決まった選択肢だけ (自由な文字列は自動返信に載って第三者へ届くため受け付けない)
  if (!topic) fields.topic = 'お問い合わせの種類を選択してください。';
  else if (!INQUIRY_TOPICS.includes(topic)) fields.topic = 'お問い合わせの種類を一覧から選択してください。';
  if (!body) fields.body = 'お問い合わせ内容を入力してください。';
  else if (body.length > 5000) fields.body = 'お問い合わせ内容は5000文字以内で入力してください。';
  if (reservationId && !RES_ID_RE.test(reservationId)) fields.reservationId = '予約番号を正しく入力してください (例: R00012)。';
  if (idempotencyKey !== null && !KEY_RE.test(idempotencyKey)) fields.idempotencyKey = '送信キーが正しくありません。画面を再読み込みしてください。';
  if (Object.keys(fields).length) throw validationError(fields);

  // レート制限: IP 5回/10分、同じメールアドレス (受信箱) 10回/日
  await limitByIp(req, 'inquiry', 5, 600);
  await limitByValue(req, 'inquiry-mail', mailboxKey(email), 10, 86400);

  const consent = await requireConsent(b.consent, INQUIRY_CONSENTS);
  const caller = await getCaller(req);
  const member = await activeMember(caller);

  // 自動返信は、宛先の所有を確認していないアドレスに届くため、同じ受信箱へは 1日 INQUIRY_REPLY_PER_DAY 通まで。
  // 超えた分もお問い合わせは受け付けて店舗には通知する (email.status は skipped)
  const autoReply = await allowByValue(req, 'inquiry-reply', mailboxKey(email), INQUIRY_REPLY_PER_DAY, 86400);
  const emails = [
    ...(autoReply ? [{ template: 'inquiry_received', to: email, payload: {} }] : []),
    ...shopEmails().map((to) => ({ template: 'inquiry_new_shop', to, payload: {} }))
  ];
  const submit = () => withPgRetry(() => adminClient().rpc('submit_inquiry_tx', {
    p: {
      idempotency_key: idempotencyKey,
      name, company, email, tel, topic, body,
      reservation_id: reservationId || null,
      user_id: member ? member.user_id : null,
      consent,
      emails
    }
  }));
  let { data, error } = await submit();
  // 同じ送信キーの同時送信 (二重クリック) は、先に保存された方を返す
  if (error && error.code === '23505' && idempotencyKey) ({ data, error } = await submit());
  if (error) throw pgToApiError(error);
  const id = String(data && data.id || '');
  if (!id) throw new ApiError('INTERNAL', 500);
  await drainOutbox(id);
  return { ok: true, id, replay: !!(data && data.replay), email: { status: await latestEmailStatus(id, 'inquiry_received') } };
}

// ---------------------------------------------------------------------
// 7. 退会
// ---------------------------------------------------------------------
async function closeHandler(req: Request) {
  methodOnly(req, 'POST');
  const caller = await getCaller(req);
  if (!caller) throw new ApiError('UNAUTHENTICATED', 401);
  const b = await readJson(req);
  if (b.confirm !== true) throw validationError({ confirm: '退会の確認にチェックしてください。' });
  const db = adminClient();
  const [m, s] = await Promise.all([
    db.from('members').select('user_id, status').eq('user_id', caller.user.id).maybeSingle(),
    db.from('staff').select('user_id').eq('user_id', caller.user.id).maybeSingle()
  ]);
  if (m.error) throw pgToApiError(m.error);
  if (s.error) throw pgToApiError(s.error);
  if (s.data) throw new ApiError('FORBIDDEN', 403, 'スタッフのアカウントはここでは退会できません。管理者にご連絡ください。');
  if (!m.data) throw new ApiError('NOT_FOUND', 404, '会員情報が見つかりませんでした。');
  const { error } = await db.rpc('member_close_account', { p_user: caller.user.id });
  if (error) throw pgToApiError(error);
  // ログインできないようにする (soft delete。予約・請求の記録は業務上保持)
  const del = await db.auth.admin.deleteUser(caller.user.id, true);
  if (del.error) {
    console.error(JSON.stringify({ level: 'error', code: 'AUTH_DELETE_FAILED', status: del.error.status }));
    throw new ApiError('INTERNAL', 500, '退会の手続きを完了できませんでした。時間をおいて、もう一度お試しください。');
  }
  // soft delete で auth 側のメールアドレスが書き換わり、トリガーで members.email に写るため、もう一度消す
  const again = await db.rpc('member_close_account', { p_user: caller.user.id });
  if (again.error) throw pgToApiError(again.error);
  return { ok: true };
}

// ---------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------
Deno.serve((req) =>
  handle(req, async (req, ctx) => {
    const path = subPath(req, 'api');
    switch (path) {
      case '/':
        return { ok: true, service: 'api' };
      case '/availability':
        return await availability(req, ctx.url);
      case '/quote':
        return await quoteHandler(req);
      case '/reservations':
        return await reservationHandler(req);
      case '/reservations/lookup':
        return await lookupHandler(req);
      case '/reservations/cancel':
        return await cancelHandler(req);
      case '/inquiries':
        return await inquiryHandler(req);
      case '/me/close':
        return await closeHandler(req);
      default:
        throw new ApiError('NOT_FOUND', 404, 'ご指定の機能が見つかりませんでした。');
    }
  })
);
