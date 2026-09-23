// =====================================================================
// HTTP 共通処理 (api / admin / worker で共用)
//   ApiError   … 契約書 §2 のエラーコードを持つ例外
//   handle     … CORS・OPTIONS・例外→JSON 変換・requestId を一括で処理
//   json       … CORS ヘッダ付きの JSON レスポンス
//   readJson   … 本文を JSON として読む (壊れていれば VALIDATION)
// ログには requestId・code・パスだけを出す (個人情報・トークンは出さない)。
// =====================================================================

/** 契約書 §2 の code → HTTP ステータス (DB の RPC が返す個別コードも含む) */
export const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION: 400,
  CONSENT_REQUIRED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  INVALID_PERIOD: 400,
  START_IN_PAST: 400,
  PERIOD_TOO_LONG: 400,
  START_TOO_FAR: 400,
  INVALID_RANGE: 400,
  RANGE_TOO_LONG: 400,
  OPTION_INVALID: 400,
  OPTION_CONFLICT: 400,
  DISCOUNT_NOT_APPLICABLE: 400,
  INVALID_STATUS: 400,
  INVALID_DELTA: 400,
  INVALID_AMOUNT: 400,
  NO_RESERVATIONS: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVOICE_NOT_ALLOWED: 403,
  MEMBER_NOT_ACTIVE: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  AVAILABILITY_CONFLICT: 409,
  STAFF_UNAVAILABLE: 409,
  HANDOVER_CONFLICT: 409,
  PRICE_CHANGED: 409,
  COUPON_INVALID: 409,
  NOT_CANCELLABLE: 409,
  RESERVATION_LIMIT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  ASSET_UNAVAILABLE: 409,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  LAST_ADMIN: 409,
  RESERVATIONS_NOT_INVOICEABLE: 409,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  CALENDAR_UNAVAILABLE: 503
};

/** お客様向けの既定メッセージ (日本語。js/backend.js の MESSAGES と同じ趣旨) */
export const DEFAULT_MESSAGES: Record<string, string> = {
  VALIDATION: '入力内容に不備があります。表示された項目をご確認ください。',
  CONSENT_REQUIRED: '規約などへの同意が必要です。最新の内容をご確認のうえ、同意の欄にチェックしてください。',
  IDEMPOTENCY_KEY_REQUIRED: '送信内容を確認できませんでした。画面を再読み込みして、もう一度お試しください。',
  INVALID_PERIOD: '貸出日時と返却日時をご確認ください (返却は貸出より後の日時にしてください)。',
  START_IN_PAST: '過去の日時は予約できません。貸出日時をご確認ください。',
  PERIOD_TOO_LONG: 'Webで予約できる期間は最長93日です。それより長いご利用は、公式LINEまたはお問い合わせフォームからご相談ください。',
  START_TOO_FAR: 'ご予約は400日先まで受け付けています。貸出日をご確認ください。',
  INVALID_RANGE: '期間の指定が正しくありません。',
  RANGE_TOO_LONG: '指定された期間が長すぎます。期間を短くしてください。',
  OPTION_INVALID: '選択されたオプションはこの車両ではご利用いただけません。オプションを選び直してください。',
  OPTION_CONFLICT: '同時に選べない補償が選ばれています。どちらか1つにしてください。',
  DISCOUNT_NOT_APPLICABLE: '選択された割引はこのご予約には適用できません (利用時間・車種の条件をご確認ください)。',
  INVALID_STATUS: '状態の指定が正しくありません。',
  INVALID_DELTA: '増減するポイント数を入力してください。',
  INVALID_AMOUNT: '金額が正しくありません。1円〜100,000円の範囲で入力してください。',
  NO_RESERVATIONS: '請求対象の予約を選択してください。',
  UNAUTHENTICATED: 'ログインが必要です。ログインしてから、もう一度お試しください。',
  FORBIDDEN: 'この操作を行う権限がありません。必要な場合は管理者にお問い合わせください。',
  INVOICE_NOT_ALLOWED: '請求書払いはご利用いただけません。お支払い方法を「当日店頭でのお支払い」に変更してください。',
  MEMBER_NOT_ACTIVE: '会員情報を確認できませんでした。ログインし直してから、もう一度お試しください。',
  NOT_FOUND: 'お探しの情報が見つかりませんでした。予約番号などをご確認ください。',
  METHOD_NOT_ALLOWED: 'この操作には対応していません。',
  AVAILABILITY_CONFLICT: '申し訳ありません。ご希望の期間は他のご予約と重なっているため予約できません。日時または車両を変更してください。',
  STAFF_UNAVAILABLE: 'ご希望の時間は受け渡し担当者の予定が埋まっています。別の日時をお選びください。',
  HANDOVER_CONFLICT: 'ご希望の時間は同じ店舗で別のお客様の受け渡しがあります。時間を少しずらしてお選びください。',
  PRICE_CHANGED: '料金が変わりました。新しい金額をご確認のうえ、もう一度確定してください。',
  COUPON_INVALID: 'このクーポンはご利用いただけません (使用済み・期限切れなど)。クーポンを外して、もう一度お試しください。',
  NOT_CANCELLABLE: 'このご予約はWebではキャンセルできません (貸出開始後・キャンセル済みなど)。お手数ですが公式LINEまたはお問い合わせフォームからご連絡ください。',
  IDEMPOTENCY_KEY_REUSED: '同じ操作が別の内容で送信されました。画面を再読み込みして、最初からやり直してください。',
  RESERVATION_LIMIT: 'Webでお持ちいただけるご予約の件数・日数の上限に達しています。さらにご予約が必要な場合は、公式LINEまたはお問い合わせフォームからご相談ください。',
  ASSET_UNAVAILABLE: 'この車両は現在ご予約いただけません。別の車両をお選びください。',
  VERSION_CONFLICT: '他のスタッフが先にこのデータを更新しました。画面を再読み込みして、最新の内容を確認してください。',
  INVALID_TRANSITION: 'この予約は、選択した状態には変更できません。現在の状態をご確認ください。',
  LAST_ADMIN: '最後の管理者は無効化・役割変更できません。先に別の管理者を追加してください。',
  RESERVATIONS_NOT_INVOICEABLE: '選択した予約の中に、この会員のものではない・請求済み・キャンセル済みの予約があります。選択を見直してください。',
  CONFLICT: '他の操作と重なりました。画面を再読み込みしてから、もう一度お試しください。',
  PAYLOAD_TOO_LARGE: '送信内容が大きすぎます。内容を短くして、もう一度お試しください。',
  RATE_LIMITED: '短時間に操作が集中したため、受付を一時的に止めています。しばらく待ってから、もう一度お試しください。',
  INTERNAL: 'システムでエラーが発生しました。時間をおいて、もう一度お試しください。',
  CALENDAR_UNAVAILABLE: '担当者の予定を確認できないため、ただいまWeb予約を受け付けられません。時間をおいてお試しいただくか、公式LINEまたはお問い合わせフォームからご相談ください。'
};

export class ApiError extends Error {
  code: string;
  status: number;
  extra: Record<string, unknown> | undefined;
  constructor(code: string, status?: number, message?: string, extra?: Record<string, unknown>) {
    super(message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.INTERNAL);
    this.name = 'ApiError';
    this.code = code;
    this.status = status || STATUS_BY_CODE[code] || 500;
    this.extra = extra;
  }
}

/** 入力不備 (fields: {項目名: 'メッセージ'}) */
export function validationError(fields: Record<string, string>, message?: string): ApiError {
  return new ApiError('VALIDATION', 400, message, { fields });
}

// ---------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------
function allowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') || '';
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** Origin ヘッダが許可されているか (Origin 無し = サーバー間呼び出しは許可) */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const list = allowedOrigins();
  if (!list.length || list.includes('*')) return true;
  return list.includes(origin.replace(/\/+$/, ''));
}

export function corsHeaders(req: Request): Record<string, string> {
  const list = allowedOrigins();
  const origin = req.headers.get('origin');
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-worker-secret, x-request-id',
    'Access-Control-Expose-Headers': 'x-request-id',
    'Access-Control-Max-Age': '600'
  };
  if (!list.length || list.includes('*')) {
    h['Access-Control-Allow-Origin'] = '*';
  } else {
    h['Vary'] = 'Origin';
    if (origin && list.includes(origin.replace(/\/+$/, ''))) h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

// ---------------------------------------------------------------------
// requestId (リクエストごと)
// ---------------------------------------------------------------------
const REQ_IDS = new WeakMap<Request, string>();

export function requestIdOf(req: Request): string {
  let id = REQ_IDS.get(req);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    REQ_IDS.set(req, id);
  }
  return id;
}

// ---------------------------------------------------------------------
// レスポンス
// ---------------------------------------------------------------------
export function json(req: Request, body: unknown, status = 200): Response {
  const headers: Record<string, string> = {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'x-request-id': requestIdOf(req)
  };
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(req: Request, err: ApiError): Response {
  const body: Record<string, unknown> = {
    ok: false,
    code: err.code,
    message: err.message,
    requestId: requestIdOf(req)
  };
  if (err.extra) {
    for (const [k, v] of Object.entries(err.extra)) {
      if (!(k in body)) body[k] = v;
    }
  }
  return json(req, body, err.status);
}

const MAX_BODY_BYTES = 64 * 1024;

/** 本文を JSON として読む。空なら {}。壊れていれば VALIDATION。 */
export async function readJson(req: Request): Promise<any> {
  let text = '';
  try {
    text = await req.text();
  } catch {
    throw new ApiError('VALIDATION', 400, '送信内容を読み取れませんでした。もう一度お試しください。');
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 413);
  }
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ApiError('VALIDATION', 400, '送信内容の形式が正しくありません。画面を再読み込みして、もう一度お試しください。');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ApiError('VALIDATION', 400, '送信内容の形式が正しくありません。画面を再読み込みして、もう一度お試しください。');
  }
  return v;
}

/**
 * 関数名より後ろのパス。'/api/quote' や '/functions/v1/api/quote' → '/quote'。
 * 関数名だけなら '/'。末尾のスラッシュは除く。
 */
export function subPath(req: Request, fnName: string): string {
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = segs.indexOf(fnName);
  const rest = i >= 0 ? segs.slice(i + 1) : segs;
  return '/' + rest.join('/');
}

export type HandlerContext = { requestId: string; url: URL };

function logError(req: Request, code: string, status: number, err?: unknown) {
  const url = new URL(req.url);
  const entry: Record<string, unknown> = {
    level: status >= 500 ? 'error' : 'warn',
    requestId: requestIdOf(req),
    method: req.method,
    path: url.pathname,
    code,
    status
  };
  // 内部エラーは種類と発生箇所だけ (メッセージには個人情報が入りうるので出さない)
  if (status >= 500 && err && typeof err === 'object') {
    const e = err as { name?: string; code?: string; stack?: string; cause?: { code?: string } };
    entry.errName = e.name || 'Error';
    const c = (e.cause && typeof e.cause.code === 'string' && e.cause.code) || (typeof e.code === 'string' && e.code);
    if (c) entry.errCode = c;
    if (e.stack) {
      const at = e.stack.split('\n').slice(1, 4).map((s) => s.trim()).join(' | ');
      entry.at = at.slice(0, 400);
    }
  }
  console.error(JSON.stringify(entry));
}

/**
 * CORS・OPTIONS・例外変換・requestId をまとめて処理する。
 * fn は Response か、JSON にするオブジェクトを返す。
 */
export async function handle(
  req: Request,
  fn: (req: Request, ctx: HandlerContext) => Promise<Response | unknown> | Response | unknown
): Promise<Response> {
  const requestId = requestIdOf(req);
  if (req.method === 'OPTIONS') {
    if (!originAllowed(req)) {
      return new Response(null, { status: 403, headers: { Vary: 'Origin', 'x-request-id': requestId } });
    }
    return new Response(null, { status: 204, headers: { ...corsHeaders(req), 'x-request-id': requestId } });
  }
  if (!originAllowed(req)) {
    logError(req, 'FORBIDDEN', 403);
    return errorResponse(req, new ApiError('FORBIDDEN', 403, '許可されていない接続元からのアクセスです。'));
  }
  try {
    const out = await fn(req, { requestId, url: new URL(req.url) });
    if (out instanceof Response) {
      // CORS ヘッダが無ければ付ける
      const h = new Headers(out.headers);
      for (const [k, v] of Object.entries(corsHeaders(req))) {
        if (!h.has(k)) h.set(k, v);
      }
      if (!h.has('x-request-id')) h.set('x-request-id', requestId);
      return new Response(out.body, { status: out.status, headers: h });
    }
    return json(req, out ?? { ok: true });
  } catch (err) {
    if (err instanceof ApiError) {
      logError(req, err.code, err.status, err.status >= 500 ? err : undefined);
      return errorResponse(req, err);
    }
    logError(req, 'INTERNAL', 500, err);
    return errorResponse(req, new ApiError('INTERNAL', 500));
  }
}
