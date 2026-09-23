// =====================================================================
// 照会キー・ハッシュ・HMAC (WebCrypto)
//   ゲスト照会キー: token = base64url(HMAC-SHA256(GUEST_TOKEN_SECRET, 'guest:' + reservationId))
//   DB には sha256hex(token) だけを保存する (平文トークンは保存しない)。
// =====================================================================
import { ApiError } from './http.ts';
import { adminClient, env } from './db.ts';
import { pgToApiError, withPgRetry } from './errors.ts';

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function toB64url(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacRaw(secret: string, message: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(await hmacRaw(secret, message));
}

export async function sha256hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** 長さが違っても処理時間が変わらない比較 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** 照会キー用の秘密鍵 (未設定・短すぎは設定ミスとして INTERNAL) */
export function guestSecret(): string {
  const s = env().GUEST_TOKEN_SECRET;
  if (!s || s.length < 32) {
    console.error(JSON.stringify({ level: 'error', code: 'CONFIG', message: 'GUEST_TOKEN_SECRET が未設定か短すぎます' }));
    throw new ApiError('INTERNAL', 500);
  }
  return s;
}

/** 予約番号からゲスト照会キーを作る (メール送信時も同じ式で再生成する) */
export async function guestToken(reservationId: string): Promise<string> {
  return toB64url(await hmacRaw(guestSecret(), 'guest:' + reservationId));
}

/** DB に保存する照会キーのハッシュ */
export async function guestTokenHash(reservationId: string): Promise<string> {
  return sha256hex(await guestToken(reservationId));
}

/**
 * 利用者が持ってきた照会キーを検証し、正しければ DB 照合用のハッシュを返す。違えば null。
 * (HMAC を再計算して比べるので、DB が漏れてもキーは作れない)
 */
export async function verifyGuestToken(reservationId: string, token: string): Promise<string | null> {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const expected = await guestToken(reservationId);
  if (!timingSafeEqual(expected, token.trim())) return null;
  return sha256hex(expected);
}

/** 照会URL (トークンは # 以降にだけ置く) */
export function lookupUrl(reservationId: string, token: string): string {
  return env().SITE_URL + 'mypage.html#lookup=' + encodeURIComponent(reservationId) + '.' + token;
}

/** キーの順序に依存しない JSON (リクエストの同一性確認用) */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** IP アドレスなどを、保存しても元に戻せない形にする (レート制限のキー用) */
export async function anonymize(kind: string, value: string): Promise<string> {
  const e = env();
  const salt = e.IP_HASH_SALT || e.GUEST_TOKEN_SECRET;
  if (!salt) {
    // 秘密が無い環境でも動くようにする (ハッシュのみ)
    return (await sha256hex(kind + ':' + value)).slice(0, 32);
  }
  return (await hmacHex(salt, kind + ':' + value)).slice(0, 32);
}

/**
 * 予約にゲスト照会キーのハッシュを保存する。
 *   予約番号は create_reservation_tx の中で採番されるため、確定後に保存する。
 *   値は予約番号から一意に決まるので、api と worker のどちらが先に実行しても同じ結果になる
 *   (まだ空のときだけ書く)。
 */
export async function ensureGuestTokenHash(reservationId: string): Promise<string> {
  const token = await guestToken(reservationId);
  const hash = await sha256hex(token);
  const { error } = await withPgRetry(() =>
    adminClient().from('reservations').update({ guest_token_hash: hash })
      .eq('id', reservationId).is('guest_token_hash', null)
  );
  if (error) throw pgToApiError(error);
  return token;
}
