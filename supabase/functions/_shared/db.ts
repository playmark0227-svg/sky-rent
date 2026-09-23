// =====================================================================
// 環境変数・Supabase クライアント・呼び出し元の識別
// =====================================================================
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.117.0';
import { ApiError } from './http.ts';
import { pgToApiError } from './errors.ts';

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SITE_URL: string; // 末尾は必ず '/'
  ALLOWED_ORIGINS: string;
  GUEST_TOKEN_SECRET: string;
  WORKER_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_API_BASE: string;
  MAIL_FROM: string;
  SHOP_NOTIFY_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_API_BASE: string;
  GOOGLE_TOKEN_URL: string;
  IP_HASH_SALT: string;
  /** ALLOWED_ORIGINS を分解したもの */
  allowedOrigins: string[];
  /** SHOP_NOTIFY_EMAIL を分解したもの */
  shopEmails: string[];
};

function get(name: string, def = ''): string {
  const v = Deno.env.get(name);
  return v === undefined || v === null || v.trim() === '' ? def : v.trim();
}

/** 契約書 §2 の環境変数 (既定値込み) */
export function env(): Env {
  let site = get('SITE_URL', 'http://127.0.0.1:8901/');
  if (!site.endsWith('/')) site += '/';
  const allowed = get('ALLOWED_ORIGINS');
  const shop = get('SHOP_NOTIFY_EMAIL');
  return {
    SUPABASE_URL: get('SUPABASE_URL', 'http://127.0.0.1:54321'),
    SUPABASE_ANON_KEY: get('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: get('SUPABASE_SERVICE_ROLE_KEY'),
    SITE_URL: site,
    ALLOWED_ORIGINS: allowed,
    GUEST_TOKEN_SECRET: get('GUEST_TOKEN_SECRET'),
    WORKER_SECRET: get('WORKER_SECRET'),
    RESEND_API_KEY: get('RESEND_API_KEY'),
    RESEND_API_BASE: get('RESEND_API_BASE', 'https://api.resend.com').replace(/\/+$/, ''),
    MAIL_FROM: get('MAIL_FROM', 'グロースレンタカー <noreply@example.com>'),
    SHOP_NOTIFY_EMAIL: shop,
    GOOGLE_SERVICE_ACCOUNT_JSON: get('GOOGLE_SERVICE_ACCOUNT_JSON'),
    GOOGLE_API_BASE: get('GOOGLE_API_BASE', 'https://www.googleapis.com').replace(/\/+$/, ''),
    GOOGLE_TOKEN_URL: get('GOOGLE_TOKEN_URL'),
    IP_HASH_SALT: get('IP_HASH_SALT'),
    allowedOrigins: allowed.split(',').map((s) => s.trim()).filter(Boolean),
    shopEmails: shop.split(',').map((s) => s.trim()).filter(Boolean)
  };
}

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

let _admin: SupabaseClient | null = null;

/** service_role のクライアント (RLS を通らない。サーバー内だけで使う) */
export function adminClient(): SupabaseClient {
  if (!_admin) {
    const e = env();
    _admin = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: NO_SESSION });
  }
  return _admin;
}

/** 呼び出し元の JWT を付けた anon クライアント (RLS・auth.uid() が効く) */
export function userClient(accessToken: string): SupabaseClient {
  const e = env();
  return createClient(e.SUPABASE_URL, e.SUPABASE_ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { Authorization: 'Bearer ' + accessToken } }
  });
}

export function bearerToken(req: Request): string {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** JWT の payload を (検証せずに) 読む。検証は auth.getUser で行うこと */
export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(b64urlDecode(part));
  } catch {
    return null;
  }
}

export type Caller = { user: User; aal: string; client: SupabaseClient; token: string };

/**
 * Authorization の JWT を auth.getUser で検証し、ログイン中のユーザーを返す。
 * 無い・無効・anon / service_role キーなら null。
 */
export async function getCaller(req: Request): Promise<Caller | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const payload = jwtPayload(token);
  // anon / service_role のキーはユーザーではない
  if (!payload || !payload.sub) return null;
  const e = env();
  if (token === e.SUPABASE_ANON_KEY || token === e.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const { data, error } = await adminClient().auth.getUser(token);
    if (error || !data?.user) return null;
    const aal = typeof payload.aal === 'string' ? payload.aal : 'aal1';
    return { user: data.user, aal, client: userClient(token), token };
  } catch {
    return null;
  }
}

/** service_role のキーで呼ばれたか (worker 起動など) */
export function isServiceRole(req: Request): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  const e = env();
  if (e.SUPABASE_SERVICE_ROLE_KEY && token === e.SUPABASE_SERVICE_ROLE_KEY) return true;
  const internal = Deno.env.get('SUPABASE_INTERNAL_SECRET_KEY');
  if (internal && token === internal) return true;
  return false;
}

/**
 * スタッフ権限の確認。未ログイン 401・AAL1 や権限なしは 403。
 * has_perm は呼び出し元のクライアントで呼ぶ (DB 側で AAL2 と staff を判定)。
 */
export async function requirePerm(req: Request, perm: string): Promise<Caller> {
  const caller = await getCaller(req);
  if (!caller) throw new ApiError('UNAUTHENTICATED', 401);
  if (caller.aal !== 'aal2') {
    throw new ApiError('FORBIDDEN', 403, '二段階認証を完了してから操作してください。');
  }
  const { data, error } = await caller.client.rpc('has_perm', { p_perm: perm });
  if (error) throw pgToApiError(error);
  if (data !== true) throw new ApiError('FORBIDDEN', 403);
  return caller;
}
