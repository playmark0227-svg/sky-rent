// =====================================================================
// レート制限 (DB の hit_rate_limit を使う固定ウィンドウ)
//   キーは IP やメールアドレスを HMAC したもの (元の値は保存しない)。
//   service_role のキーで呼ばれた場合 (サーバー間・運用スクリプト・自動テスト) は制限しない。
//
// 利用者の IP の決め方 (clientIp):
//   1. CLIENT_IP_HEADER が設定されていれば、そのヘッダだけを使う
//   2. 未設定なら x-forwarded-for を右端から見て、最初の公開アドレス
//   cf-connecting-ip・x-real-ip・x-forwarded-for の左側は、手前の中継が上書きしない限り利用者が自由に書けるので
//   既定では使わない (中継が上書きすると確かめたヘッダだけを CLIENT_IP_HEADER で明示する。例: cf-connecting-ip)。
//   本番でどのヘッダに IP が入るかは supabase/functions/.env.example の CLIENT_IP_HEADER の説明に沿って確認する。
//
// 利用者の IP を特定できない (社内網・ループバックのアドレスしか無い・IP でない値) とき:
//   - ローカル開発 (SITE_URL が localhost / 127.0.0.1): 数えない (全員が同じ枠になり、開発・自動テストが止まるため)
//   - それ以外 (本番): 「特定できない」共有の枠で、通常の 10 倍の上限まで数える
//     (内部アドレスを名乗れば制限が外れる、ということにしない)
// =====================================================================
import { ApiError } from './http.ts';
import { adminClient, isServiceRole } from './db.ts';
import { anonymize } from './tokens.ts';

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * ヘッダの1項目を IP アドレスの標準形にする。IP でなければ '' (ホスト名・'unknown'・壊れた値)。
 *   '1.2.3.4:5678' / '[2001:db8::1]:443' のポートと IPv6 のゾーン (%eth0) は外す。
 *   IPv6 は省略形にそろえ、IPv4 射影 (::ffff:1.2.3.4) は IPv4 として扱う (書き方を変えて別の枠にさせない)。
 */
export function normalizeIp(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 64) return '';
  let m = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (m) s = m[1];
  else if ((m = /^([\d.]+):\d{1,5}$/.exec(s))) s = m[1];
  s = s.replace(/%[0-9a-z._~-]+$/, '');
  const v4 = V4_RE.exec(s);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? parts.join('.') : '';
  }
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return '';
  let host: string;
  try {
    host = new URL('http://[' + s + ']/').hostname.slice(1, -1);
  } catch {
    return '';
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return host;
}

/** 社内網・ループバックなど、利用者の IP ではありえないアドレス (IP でない値は false) */
export function isPrivateIp(raw: string): boolean {
  const s = normalizeIp(raw);
  if (!s) return false;
  const v4 = V4_RE.exec(s);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (s === '::' || s === '::1') return true;
  const first = s.startsWith('::') ? 0 : parseInt(s.split(':')[0], 16);
  return (first & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
    (first & 0xffc0) === 0xfe80; // fe80::/10 (リンクローカル)
}

/**
 * カンマ区切りのアドレス一覧を右端から見て、最初の公開アドレスを返す。
 *   右側ほど手前の中継サーバーが付けた値 (利用者は左側しか書けない)。社内網のアドレスは中継の内部なので読み飛ばす。
 *   公開アドレスの前に IP でない値があれば、それより左 (利用者が書いた値かもしれない) には進まず 'unknown'。
 *   社内網のアドレスしか無ければ、その右端 (= limitByIp では「IP を特定できない」扱い)。
 */
function rightmostPublic(value: string | null): string {
  const items = String(value || '').split(',');
  let fallback = '';
  for (let i = items.length - 1; i >= 0; i--) {
    const raw = items[i].trim();
    if (!raw) continue;
    const ip = normalizeIp(raw);
    if (!ip) return fallback || 'unknown';
    if (!isPrivateIp(ip)) return ip;
    if (!fallback) fallback = ip;
  }
  return fallback || 'unknown';
}

function forcedHeader(): string {
  return (Deno.env.get('CLIENT_IP_HEADER') || '').trim().toLowerCase();
}

/**
 * ローカル開発環境か (SITE_URL が localhost・ループバックを指す)。
 * SITE_URL が無い・読めないときは本番として扱う (制限を外す側に倒さない)。
 */
export function isLocalDev(): boolean {
  const raw = (Deno.env.get('SITE_URL') || '').trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** 呼び出し元の IP と、どのヘッダから取ったか */
export function clientIpInfo(req: Request): { ip: string; source: string } {
  const h = req.headers;
  const forced = forcedHeader();
  if (forced) return { ip: rightmostPublic(h.get(forced)), source: forced };
  // cf-connecting-ip は既定では使わない (利用者が送った値がそのまま届く構成では、毎回変えて枠を増やせるため)
  return { ip: rightmostPublic(h.get('x-forwarded-for')), source: 'x-forwarded-for' };
}

/** 呼び出し元の IP (取れなければ 'unknown') */
export function clientIp(req: Request): string {
  return clientIpInfo(req).ip;
}

/**
 * レート制限の枠を決める値。IPv4 はアドレスそのもの、IPv6 は先頭 64 ビット
 * (1 回線に /64 が丸ごと割り当てられるため、末尾を変えて枠を増やせないようにする)。
 */
export function rateKeyOf(ip: string): string {
  const s = normalizeIp(ip);
  if (!s || V4_RE.test(s)) return s;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':') + '::/64';
}

/** ログ用に IP を伏せる (IPv4 は先頭2つ、IPv6 は先頭2ブロックだけ残す) */
function maskIp(raw: string): string {
  const s = normalizeIp(raw);
  if (!s) return '(IP以外)';
  const kind = isPrivateIp(s) ? '内部' : '公開';
  const v4 = V4_RE.exec(s);
  const shown = v4 ? v4[1] + '.' + v4[2] + '.*.*' : s.split(':').slice(0, 2).join(':') + ':*';
  return shown + ' (' + kind + ')';
}

/**
 * CLIENT_IP_DEBUG=1 のときだけ、候補のヘッダと採用した値をログに出す (本番でどのヘッダに IP が入るかの確認用)。
 * アドレスは伏せて出す (個人を特定できる形ではログに残さない)。
 */
function debugLog(req: Request, name: string, picked: { ip: string; source: string }) {
  const flag = (Deno.env.get('CLIENT_IP_DEBUG') || '').trim().toLowerCase();
  if (flag !== '1' && flag !== 'true') return;
  const names = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'];
  const forced = forcedHeader();
  if (forced && !names.includes(forced)) names.push(forced);
  const headers: Record<string, string[] | null> = {};
  for (const n of names) {
    const v = req.headers.get(n);
    headers[n] = v === null ? null : v.split(',').map((x) => x.trim()).filter(Boolean).map(maskIp);
  }
  console.log(JSON.stringify({
    level: 'info', msg: 'client-ip', limit: name, source: picked.source,
    picked: picked.ip === 'unknown' ? 'unknown' : maskIp(picked.ip), clientIpHeader: forced || null, headers
  }));
}

/**
 * 1回数え、上限以内なら true を返す。
 * DB に接続できないときは、受付を止めないよう true (ログに警告)。
 */
export async function tryHit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await adminClient().rpc('hit_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });
  if (error) {
    console.error(JSON.stringify({ level: 'warn', code: 'RATE_LIMIT_UNAVAILABLE', errCode: error.code }));
    return true;
  }
  return data !== false;
}

/** 1回数える。上限を超えていれば RATE_LIMITED を投げる */
export async function hitLimit(bucket: string, limit: number, windowSeconds: number): Promise<void> {
  if (!(await tryHit(bucket, limit, windowSeconds))) throw new ApiError('RATE_LIMITED', 429);
}

/** 利用者の IP を特定できないときの共有の枠は、通常の上限の何倍まで認めるか */
export const UNIDENTIFIED_FACTOR = 10;

let warnedHeaderUnset = false;
let warnedUnidentified = false;

/** 本番で CLIENT_IP_HEADER が未設定なら、1度だけ警告する (x-forwarded-for の右端を信頼している状態) */
function warnConfigOnce() {
  if (warnedHeaderUnset || forcedHeader() || isLocalDev()) return;
  warnedHeaderUnset = true;
  console.warn(JSON.stringify({
    level: 'warn', code: 'CLIENT_IP_HEADER_UNSET',
    msg: 'CLIENT_IP_HEADER が未設定です。x-forwarded-for の右端の公開アドレスを利用者の IP として使っています。' +
      ' 本番の中継が上書きするヘッダを確認して設定してください (.env.example の手順)。'
  }));
}

/**
 * IP 単位の制限。
 *   - service_role の呼び出し (サーバー間・運用スクリプト・自動テスト) は数えない
 *   - 利用者の IP を特定できない (社内網・ループバックのアドレスしか無い・IP でない値) とき:
 *       ローカル開発では数えない。本番では「特定できない」共有の枠で、上限の UNIDENTIFIED_FACTOR 倍まで数える
 *       (x-forwarded-for に内部アドレスを書けば制限が外れる、ということにしない)
 */
export async function limitByIp(req: Request, name: string, limit: number, windowSeconds: number): Promise<void> {
  if (isServiceRole(req)) return;
  warnConfigOnce();
  const picked = clientIpInfo(req);
  debugLog(req, name, picked);
  const ip = picked.ip;
  if (ip === 'unknown' || isPrivateIp(ip)) {
    if (isLocalDev()) return;
    if (!warnedUnidentified) {
      warnedUnidentified = true;
      console.warn(JSON.stringify({ level: 'warn', code: 'CLIENT_IP_UNIDENTIFIED', limit: name, source: picked.source }));
    }
    await hitLimit(name + ':ip:unidentified', limit * UNIDENTIFIED_FACTOR, windowSeconds);
    return;
  }
  const key = await anonymize('ip', rateKeyOf(ip));
  await hitLimit(name + ':ip:' + key, limit, windowSeconds);
}

/**
 * メールアドレスを「同じ受信箱」単位にそろえる (レート制限・上限のキー用。保存・送信には使わない)。
 *   小文字化し、+以降 (サブアドレス) を外す。Gmail はローカル部の . も無視されるので外す。
 *   (victim+1@…, victim+2@… のように書き換えて、同じ人に何通も送れないようにする)
 */
export function mailboxKey(email: string): string {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return s;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

/** 電話番号を数字だけにそろえる (+81 は国内の 0 始まりにする)。上限のキー用 */
export function phoneKey(phone: string): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('81') && d.length >= 11) d = '0' + d.slice(2);
  return d;
}

/** 任意の値 (メールアドレス等) 単位の制限 */
export async function limitByValue(req: Request, name: string, value: string, limit: number, windowSeconds: number): Promise<void> {
  if (!(await allowByValue(req, name, value, limit, windowSeconds))) throw new ApiError('RATE_LIMITED', 429);
}

/** 任意の値単位で1回数え、上限以内なら true (超えていても例外にしない。自動返信を止めるときなどに使う) */
export async function allowByValue(req: Request, name: string, value: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (isServiceRole(req)) return true;
  const key = await anonymize(name, String(value || '').trim().toLowerCase());
  return await tryHit(name + ':v:' + key, limit, windowSeconds);
}
