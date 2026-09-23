// =====================================================================
// Google Calendar API クライアント (サービスアカウント認証)
//   実装契約書 docs/production/implementation-v1.md §3
//
//   * 鍵: 環境変数 GOOGLE_SERVICE_ACCOUNT_JSON (鍵 JSON そのまま、または base64)
//   * 認証: RS256 の JWT を WebCrypto で署名 → GOOGLE_TOKEN_URL (無ければ鍵の token_uri) で
//     アクセストークンを取得し、期限の少し前まで使い回す
//   * API の場所: GOOGLE_API_BASE (既定 https://www.googleapis.com)。テストではモックに差し替える
//   * 鍵が無い・壊れているときは「未設定」として扱い、モジュールの読み込みで落とさない
//     (API を呼んだときだけ GoogleError(code 'NOT_CONFIGURED') を投げる)
//   * 個人情報・鍵・トークンはログに出さない
// =====================================================================

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const DEFAULT_API_BASE = 'https://www.googleapis.com';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 6000;
const RETRY_DELAYS_MS = [250, 700];          // 429 / 5xx / 通信失敗の短い再試行 (最大 2 回)
const TOKEN_REFRESH_MARGIN_MS = 120_000;     // 期限の 2 分前に取り直す
const FREEBUSY_MAX_RANGE_MS = 60 * 86_400_000; // freeBusy は長い期間を嫌うので 60 日ごとに分ける

export type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string;
  tokenUri: string;
};

export type GoogleEventTime = { dateTime?: string; date?: string; timeZone?: string };
export type GoogleEvent = {
  id: string;
  status?: string;
  eventType?: string;
  summary?: string;
  description?: string;
  transparency?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  [k: string]: unknown;
};
export type FreeBusyResult = Record<string, { busy: { start: string; end: string }[]; errors?: { reason?: string }[] }>;

/** Google API の失敗。status 0 は通信失敗、code 'NOT_CONFIGURED' は鍵が未設定 */
export class GoogleError extends Error {
  status: number;
  reason: string;
  code: string;
  constructor(status: number, reason: string, message?: string, code?: string) {
    super(message || ('Google API error ' + status + (reason ? ' (' + reason + ')' : '')));
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason || '';
    this.code = code || (status === 0 ? 'NETWORK' : 'HTTP_' + status);
  }
  get notConfigured() { return this.code === 'NOT_CONFIGURED'; }
  get notFoundOrForbidden() { return this.status === 403 || this.status === 404; }
}

// ---------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------
function envGet(name: string): string {
  try { return (Deno.env.get(name) || '').trim(); } catch (_e) { return ''; }
}

export function apiBase(): string {
  return (envGet('GOOGLE_API_BASE') || DEFAULT_API_BASE).replace(/\/+$/, '');
}

let saCacheRaw: string | null = null;
let saCache: { sa: ServiceAccount | null; error: string | null } = { sa: null, error: null };

function decodeBase64Utf8(s: string): string {
  const norm = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '==='.slice((norm.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 鍵を読み込む。未設定・不正なら sa = null と理由 (日本語) を返す。例外は投げない */
export function loadServiceAccount(): { sa: ServiceAccount | null; error: string | null } {
  const raw = envGet('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (raw === saCacheRaw) return saCache;
  saCacheRaw = raw;
  if (!raw) {
    saCache = { sa: null, error: 'Google のサービスアカウント鍵が設定されていません' };
    return saCache;
  }
  try {
    const text = raw.startsWith('{') ? raw : decodeBase64Utf8(raw);
    const j = JSON.parse(text);
    const clientEmail = String(j.client_email || '');
    const privateKey = String(j.private_key || '').replace(/\\n/g, '\n');
    if (!clientEmail || !privateKey.includes('PRIVATE KEY')) {
      saCache = { sa: null, error: 'サービスアカウント鍵に client_email / private_key がありません' };
    } else {
      saCache = {
        sa: {
          clientEmail,
          privateKey,
          privateKeyId: String(j.private_key_id || ''),
          tokenUri: String(j.token_uri || DEFAULT_TOKEN_URL)
        },
        error: null
      };
    }
  } catch (_e) {
    saCache = { sa: null, error: 'サービスアカウント鍵を読み取れません (JSON または base64 の JSON を設定してください)' };
  }
  if (saCache.error) console.warn('[google] ' + saCache.error);
  return saCache;
}

export function isConfigured(): boolean {
  return !!loadServiceAccount().sa;
}

export function serviceAccountEmail(): string | null {
  const sa = loadServiceAccount().sa;
  return sa ? sa.clientEmail : null;
}

function tokenUrl(sa: ServiceAccount): string {
  return envGet('GOOGLE_TOKEN_URL') || sa.tokenUri || DEFAULT_TOKEN_URL;
}

// ---------------------------------------------------------------------
// JWT (RS256) 署名とアクセストークン
// ---------------------------------------------------------------------
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}

let keyCache: { pem: string; key: CryptoKey } | null = null;

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (keyCache && keyCache.pem === pem) return keyCache.key;
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new GoogleError(0, 'invalidKey', 'PKCS#1 形式の鍵には対応していません (Google の鍵 JSON の private_key を使ってください)', 'NOT_CONFIGURED');
  }
  try {
    const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
    const bin = atob(body);
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    keyCache = { pem, key };
    return key;
  } catch (_e) {
    throw new GoogleError(0, 'invalidKey', 'サービスアカウント鍵の private_key を読み込めません', 'NOT_CONFIGURED');
  }
}

/** サービスアカウントの署名付き JWT (assertion) を作る */
export async function signAssertion(sa: ServiceAccount, aud: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (sa.privateKeyId) header.kid = sa.privateKeyId;
  const claims = { iss: sa.clientEmail, scope: CALENDAR_SCOPE, aud, iat: nowSec, exp: nowSec + 3600 };
  const input = b64urlJson(header) + '.' + b64urlJson(claims);
  const key = await importPrivateKey(sa.privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  return input + '.' + b64url(sig);
}

let tokenCache: { token: string; expiresAt: number; email: string } | null = null;
let tokenInflight: Promise<string> | null = null;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
}

async function requestToken(sa: ServiceAccount): Promise<string> {
  const url = tokenUrl(sa);
  let lastErr: GoogleError | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let res: Response;
    try {
      const assertion = await signAssertion(sa, url);
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
      });
    } catch (e) {
      if (e instanceof GoogleError) throw e;
      lastErr = new GoogleError(0, 'network', 'Google の認証サーバーに接続できません');
      continue;
    }
    let j: Record<string, unknown> = {};
    try { j = await res.json(); } catch (_e) { j = {}; }
    if (res.ok && typeof j.access_token === 'string') {
      const ttl = Math.max(60, Number(j.expires_in) || 3600) * 1000;
      tokenCache = { token: j.access_token, expiresAt: Date.now() + ttl, email: sa.clientEmail };
      return j.access_token;
    }
    lastErr = new GoogleError(res.status, String(j.error || ''), 'Google のアクセストークンを取得できません (' + res.status + ' ' + String(j.error || '') + ')', 'TOKEN');
    if (!(res.status === 429 || res.status >= 500)) break;
  }
  throw lastErr || new GoogleError(0, 'network', 'Google のアクセストークンを取得できません');
}

/** アクセストークン (期限の少し前まで再利用) */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const { sa, error } = loadServiceAccount();
  if (!sa) throw new GoogleError(0, 'notConfigured', error || 'Google 連携が未設定です', 'NOT_CONFIGURED');
  if (!forceRefresh && tokenCache && tokenCache.email === sa.clientEmail && tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return tokenCache.token;
  }
  if (!tokenInflight) {
    tokenInflight = requestToken(sa).finally(() => { tokenInflight = null; });
  }
  return await tokenInflight;
}

/** テスト用: トークン・鍵のキャッシュを捨てる */
export function _resetGoogleCaches() {
  tokenCache = null; tokenInflight = null; keyCache = null; saCacheRaw = null;
}

// ---------------------------------------------------------------------
// API 呼び出し (429 / 5xx / 通信失敗は短く再試行、401 はトークンを取り直して 1 回だけ再試行)
// ---------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function gfetch(method: string, path: string, opts: { query?: Record<string, string | string[] | undefined>; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const u = new URL(apiBase() + path);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else u.searchParams.set(k, v);
  }
  let refreshed = false;
  let lastErr: GoogleError | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const token = await getAccessToken(false);
    const headers: Record<string, string> = { authorization: 'Bearer ' + token, accept: 'application/json' };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(u.toString(), init);
    } catch (_e) {
      lastErr = new GoogleError(0, 'network', 'Google カレンダーに接続できません');
      continue;
    }
    // deno-lint-ignore no-explicit-any
    let json: any = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch (_e) { json = null; } }
    if (res.ok) return { status: res.status, json };
    const reason = String(json?.error?.errors?.[0]?.reason || json?.error?.status || '');
    lastErr = new GoogleError(res.status, reason, 'Google カレンダー API エラー (' + res.status + (reason ? ' ' + reason : '') + ')');
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      tokenCache = null;
      attempt--; // 401 の取り直しは再試行回数に数えない
      continue;
    }
    // 403 のうち利用上限 (rateLimitExceeded など) は再試行する
    const rateLimited403 = res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason);
    if (!(res.status === 429 || res.status >= 500 || rateLimited403)) break;
  }
  throw lastErr || new GoogleError(0, 'network', 'Google カレンダーに接続できません');
}

function calPath(calendarId: string) {
  return '/calendar/v3/calendars/' + encodeURIComponent(calendarId);
}

/** 予定の一覧 (繰り返し予定は展開。nextPageToken をたどって全件)。timeMin / timeMax は省略可 */
export async function listEvents(calendarId: string, timeMin: string | undefined, timeMax: string | undefined, opts: {
  privateExtendedProperty?: string[]; fields?: string; showDeleted?: boolean; maxPages?: number;
} = {}): Promise<GoogleEvent[]> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  const maxPages = opts.maxPages || 20;
  for (let page = 0; page < maxPages; page++) {
    const { json } = await gfetch('GET', calPath(calendarId) + '/events', {
      query: {
        timeMin, timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
        showDeleted: opts.showDeleted ? 'true' : undefined,
        privateExtendedProperty: opts.privateExtendedProperty,
        fields: opts.fields,
        pageToken
      }
    });
    for (const it of (json?.items || [])) items.push(it);
    pageToken = json?.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return items;
}

/** freeBusy (予定ありの時間帯だけ。長い期間は 60 日ごとに分けて問い合わせる) */
export async function freeBusy(calendarIds: string[], timeMin: string, timeMax: string): Promise<FreeBusyResult> {
  const out: FreeBusyResult = {};
  for (const id of calendarIds) out[id] = { busy: [] };
  if (!calendarIds.length) return out;
  const startMs = Date.parse(timeMin), endMs = Date.parse(timeMax);
  for (let s = startMs; s < endMs; s += FREEBUSY_MAX_RANGE_MS) {
    const e = Math.min(endMs, s + FREEBUSY_MAX_RANGE_MS);
    const { json } = await gfetch('POST', '/calendar/v3/freeBusy', {
      body: {
        timeMin: new Date(s).toISOString(),
        timeMax: new Date(e).toISOString(),
        timeZone: 'Asia/Tokyo',
        items: calendarIds.map((id) => ({ id }))
      }
    });
    const cals = json?.calendars || {};
    for (const id of calendarIds) {
      const c = cals[id];
      if (!c) { out[id].errors = [{ reason: 'notFound' }]; continue; }
      if (Array.isArray(c.errors) && c.errors.length) out[id].errors = c.errors;
      for (const b of (c.busy || [])) out[id].busy.push({ start: String(b.start), end: String(b.end) });
    }
  }
  return out;
}

export async function getCalendar(calendarId: string): Promise<Record<string, unknown>> {
  const { json } = await gfetch('GET', calPath(calendarId));
  return json || {};
}

export async function getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
  const { json } = await gfetch('GET', calPath(calendarId) + '/events/' + encodeURIComponent(eventId));
  return json;
}

export async function insertEvent(calendarId: string, event: Record<string, unknown>): Promise<GoogleEvent> {
  const { json } = await gfetch('POST', calPath(calendarId) + '/events', { body: event, query: { sendUpdates: 'none' } });
  return json;
}

/** 予定の置き換え (PUT)。消えている予定は GoogleError 404 / 410 */
export async function updateEvent(calendarId: string, eventId: string, event: Record<string, unknown>): Promise<GoogleEvent> {
  const { json } = await gfetch('PUT', calPath(calendarId) + '/events/' + encodeURIComponent(eventId), { body: event, query: { sendUpdates: 'none' } });
  return json;
}

/** 予定の削除。既に無い (404 / 410) ときは {deleted:false} を返す (成功扱い) */
export async function deleteEvent(calendarId: string, eventId: string): Promise<{ deleted: boolean }> {
  try {
    await gfetch('DELETE', calPath(calendarId) + '/events/' + encodeURIComponent(eventId), { query: { sendUpdates: 'none' } });
    return { deleted: true };
  } catch (e) {
    if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return { deleted: false };
    throw e;
  }
}
