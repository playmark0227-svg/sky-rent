// =====================================================================
// メール送信 (Resend: POST {RESEND_API_BASE}/emails)
//   RESEND_API_KEY 未設定 → skipped (送らない)
//   宛先不正・4xx          → failed (再試行しない: retryable = false)
//   429・5xx・通信断       → failed (指数バックオフで再試行: retryable = true)
// =====================================================================
import { env } from './db.ts';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /** 同じ送信の二重実行を Resend 側で防ぐキー (outbox の id から作る) */
  idempotencyKey?: string;
};

export type MailResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'skipped'; error: string }
  | { status: 'failed'; error: string; retryable: boolean };

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);
}

/** エラー文に含まれうるメールアドレスを伏せる (ログ・DB に残すため) */
export function maskEmails(s: string): string {
  return String(s || '').replace(/[^\s@<>"',;:()]+@[^\s@<>"',;:()]+/g, '***@***');
}

/** 件名・ヘッダに使う文字列から改行・制御文字を除く */
export function oneLine(s: string, max = 200): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const TIMEOUT_MS = 10000;

export async function sendMail(m: MailMessage): Promise<MailResult> {
  const e = env();
  if (!e.RESEND_API_KEY) return { status: 'skipped', error: 'メール送信サービス未設定' };
  const to = String(m.to || '').trim();
  if (!isValidEmail(to)) return { status: 'failed', error: '宛先のメールアドレスが正しくありません', retryable: false };

  const body: Record<string, unknown> = {
    from: e.MAIL_FROM,
    to: [to],
    subject: oneLine(m.subject, 250),
    text: m.text
  };
  if (m.replyTo && isValidEmail(m.replyTo)) body.reply_to = m.replyTo;

  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + e.RESEND_API_KEY,
    'Content-Type': 'application/json'
  };
  if (m.idempotencyKey) headers['Idempotency-Key'] = m.idempotencyKey.slice(0, 256);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(e.RESEND_API_BASE + '/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      status: 'failed',
      error: aborted ? 'メール送信サービスが応答しませんでした (タイムアウト)' : 'メール送信サービスに接続できませんでした',
      retryable: true
    };
  } finally {
    clearTimeout(timer);
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok) {
    return { status: 'sent', providerId: payload && typeof payload.id === 'string' ? payload.id : null };
  }
  const detail = payload && (payload.message || payload.name) ? String(payload.name || '') + ' ' + String(payload.message || '') : '';
  const error = maskEmails(('送信失敗 (HTTP ' + res.status + ')' + (detail ? ': ' + detail.trim() : '')).slice(0, 500));
  // 429 (送信数の上限) と 5xx は時間をおけば送れる見込みがある
  const retryable = res.status === 429 || res.status >= 500;
  return { status: 'failed', error, retryable };
}
