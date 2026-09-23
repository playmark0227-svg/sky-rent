// =====================================================================
// 送信キュー (outbox) のワーカー
//   runWorker({limit})          … outbox_claim で期限の来たジョブを取り出して処理 (定期起動・管理画面)
//   runWorker({refIds:[...]})   … 指定した予約番号・問い合わせ番号のジョブだけを処理 (予約直後の同期送信)
//   template === 'gcal_sync' は staff-calendar.ts の processGcalJob に委譲、それ以外はメール。
//   結果は outbox_mark で記録する。件名・本文も保存するが、照会キーは伏せ字にして保存する。
// =====================================================================
import { adminClient, env } from './db.ts';
import { pgToApiError } from './errors.ts';
import { processGcalJob } from './staff-calendar.ts';
import { maskEmails, sendMail } from './mail.ts';
import {
  DEFAULT_SITE,
  isCustomerTemplate,
  isTemplate,
  type MailContext,
  renderMail,
  type SiteInfo,
  TemplateError
} from './mail-templates.ts';
import { ensureGuestTokenHash, guestToken, lookupUrl, sha256hex } from './tokens.ts';
import { Core, loadSettings } from './catalog.ts';

export type OutboxRow = {
  id: number;
  template: string;
  to_email: string;
  payload: Record<string, any> | null;
  ref_type: string | null;
  ref_id: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error?: string | null;
  created_at?: string;
};

export type WorkerResult = { id: number; template: string; status: 'sent' | 'skipped' | 'failed'; error?: string };

/** outbox_claim が拾う試行回数の上限 (migrations と同じ値) */
export const MAX_ATTEMPTS = 8;
/** 再試行しない失敗 (宛先不正・4xx など) の next_attempt_at。管理画面の「再送」で now に戻せる */
export const NO_RETRY_AT = '2999-12-31T00:00:00.000Z';

const MASKED_LOOKUP = '(照会用URLはお客様宛てのメールにのみ記載しています)';

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function priority(t: string): number {
  if (t === 'gcal_sync') return 2;
  return isCustomerTemplate(t) ? 0 : 1;
}

// ---------------------------------------------------------------------
// 取り出し
// ---------------------------------------------------------------------
async function claimGeneral(limit: number): Promise<OutboxRow[]> {
  const db = adminClient();
  const { data, error } = await db.rpc('outbox_claim', { p_limit: limit });
  if (error) throw pgToApiError(error);
  const rows = (data || []) as OutboxRow[];
  if (rows.length) {
    // 取り出した時刻を記録 (outbox_release_stuck が処理中のジョブを「止まった」と誤判定しないように)
    await db.from('outbox').update({ next_attempt_at: new Date().toISOString() })
      .in('id', rows.map((r) => r.id)).eq('status', 'sending');
  }
  return rows;
}

/** 指定した ref_id のジョブだけを取り出す (status と attempts を条件にした更新で、他のワーカーと取り合わない) */
async function claimByRefs(refIds: string[], limit: number, templates: string[]): Promise<OutboxRow[]> {
  const db = adminClient();
  const nowIso = new Date().toISOString();
  let q = db.from('outbox')
    .select('id, status, attempts')
    .in('ref_id', refIds)
    .in('status', ['pending', 'failed'])
    .lte('next_attempt_at', nowIso)
    .lt('attempts', MAX_ATTEMPTS);
  if (templates.length) q = q.in('template', templates);
  const { data, error } = await q.order('id', { ascending: true }).limit(limit);
  if (error) throw pgToApiError(error);
  const claimed = await Promise.all((data || []).map(async (row: { id: number; status: string; attempts: number }) => {
    const { data: upd, error: e2 } = await db.from('outbox')
      .update({ status: 'sending', attempts: row.attempts + 1, next_attempt_at: nowIso })
      .eq('id', row.id).eq('status', row.status).eq('attempts', row.attempts)
      .select('*');
    if (e2 || !upd || !upd.length) return null;
    return upd[0] as OutboxRow;
  }));
  return claimed.filter((r): r is OutboxRow => r !== null);
}

// ---------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------
async function mark(
  job: OutboxRow,
  status: 'sent' | 'skipped' | 'failed',
  opts: { error?: string | null; providerId?: string | null; subject?: string | null; body?: string | null; noRetry?: boolean } = {}
) {
  const db = adminClient();
  const { error } = await db.rpc('outbox_mark', {
    p_id: job.id,
    p_status: status,
    p_error: opts.error ? maskEmails(opts.error).slice(0, 1000) : null,
    p_provider_id: opts.providerId ?? null,
    p_subject: opts.subject ?? null,
    p_body: opts.body ?? null
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', code: 'OUTBOX_MARK_FAILED', outboxId: job.id, errCode: error.code }));
    return;
  }
  if (status === 'failed' && opts.noRetry) {
    await db.from('outbox').update({ next_attempt_at: NO_RETRY_AT }).eq('id', job.id).eq('status', 'failed');
  }
}

// ---------------------------------------------------------------------
// メールの材料を DB から読む
// ---------------------------------------------------------------------
type Shared = { settings?: Promise<{ rules: any; site: SiteInfo }> };

function sharedSettings(shared: Shared) {
  if (!shared.settings) {
    shared.settings = loadSettings(['pricing_rules', 'site']).then((s) => {
      const site = s.site && typeof s.site === 'object' ? s.site : {};
      return {
        rules: s.pricing_rules && typeof s.pricing_rules === 'object' ? s.pricing_rules : Core.DEFAULT_RULES,
        site: {
          shopName: site.shopName || DEFAULT_SITE.shopName,
          company: site.company || DEFAULT_SITE.company,
          line: site.line || DEFAULT_SITE.line,
          email: site.email || DEFAULT_SITE.email,
          hours: site.hours || DEFAULT_SITE.hours
        }
      };
    });
  }
  return shared.settings;
}

const RES_COLS = 'id, kind, status, start_at, end_at, asset_id, category_id, location_id, customer_name, user_id, ' +
  'payment_method, options, price, total, discount_type, company, note, cancel_fee, cancelled_by, source, guest_token_hash';

type Loaded = { ctx: MailContext; realLookupUrl: string | null; replyTo: string | null; skip?: string };

async function loadContext(job: OutboxRow, shared: Shared): Promise<Loaded> {
  const db = adminClient();
  const payload = (job.payload && typeof job.payload === 'object') ? job.payload : {};
  const { rules, site } = await sharedSettings(shared);
  const ctx: MailContext = { siteUrl: env().SITE_URL, site, rules, payload };
  let realLookupUrl: string | null = null;
  let replyTo: string | null = isCustomerTemplate(job.template) ? site.email : null;
  let skip: string | undefined;

  if (job.template.startsWith('reservation_')) {
    const id = String(payload.reservation_id || (job.ref_type === 'reservation' ? job.ref_id : '') || '');
    if (!id) throw new TemplateError('予約番号が無いため、メールを作れませんでした');
    const { data: r0, error } = await db.from('reservations').select(RES_COLS).eq('id', id).maybeSingle();
    // deno-lint-ignore no-explicit-any
    const r: any = r0;
    if (error) throw new TemplateError('予約を読み込めませんでした', true);
    if (!r) throw new TemplateError('予約 ' + id + ' が見つからないため、メールを作れませんでした');
    const [a, l] = await Promise.all([
      db.from('assets').select('id, name, category_id, custom_fields').eq('id', r.asset_id).maybeSingle(),
      db.from('locations').select('id, name, address, tel, hours').eq('id', r.location_id).maybeSingle()
    ]);
    if (a.error || l.error) throw new TemplateError('車両・店舗を読み込めませんでした', true);
    ctx.reservation = r;
    ctx.asset = a.data;
    ctx.location = l.data;
    if (job.template === 'reservation_confirmed') {
      if (r.status === 'cancelled' || r.status === 'no_show') {
        skip = '予約が取り消し済みのため、確定メールは送信しませんでした';
      }
      // 照会キーは送信時に同じ式で作り直す (DB のハッシュと一致するときだけ載せる)
      if (r.guest_token_hash) {
        const token = await guestToken(r.id);
        if ((await sha256hex(token)) === r.guest_token_hash) realLookupUrl = lookupUrl(r.id, token);
      } else if (r.source === 'web') {
        // Web 予約の確定直後 (api がハッシュを保存する前) にこのジョブを拾った場合
        try {
          realLookupUrl = lookupUrl(r.id, await ensureGuestTokenHash(r.id));
        } catch (_e) {
          throw new TemplateError('照会キーを保存できませんでした', true);
        }
      }
    }
    delete r.guest_token_hash;
  } else if (job.template.startsWith('inquiry_')) {
    const id = String(payload.inquiry_id || (job.ref_type === 'inquiry' ? job.ref_id : '') || '');
    if (!id) throw new TemplateError('受付番号が無いため、メールを作れませんでした');
    const { data: q, error } = await db.from('inquiries')
      .select('id, name, topic, body, company, email, reservation_id, created_at, user_id').eq('id', id).maybeSingle();
    if (error) throw new TemplateError('お問い合わせを読み込めませんでした', true);
    if (!q) throw new TemplateError('お問い合わせ ' + id + ' が見つからないため、メールを作れませんでした');
    if (job.template === 'inquiry_new_shop') replyTo = q.email || null;
    delete (q as Record<string, unknown>).email;
    ctx.inquiry = q;
  } else if (job.template === 'coupon_issued') {
    if (job.ref_type === 'coupon' && job.ref_id && /^[0-9a-f-]{36}$/i.test(job.ref_id)) {
      const { data: c } = await db.from('coupons').select('amount, reason, expires_at, used_at').eq('id', job.ref_id).maybeSingle();
      if (c) ctx.coupon = { amount: c.amount, reason: c.reason, expires_at: c.expires_at };
    }
  }
  return { ctx, realLookupUrl, replyTo, skip };
}

// ---------------------------------------------------------------------
// 1件の処理
// ---------------------------------------------------------------------
async function processMail(job: OutboxRow, shared: Shared): Promise<WorkerResult> {
  const base = { id: job.id, template: job.template };
  if (!isTemplate(job.template)) {
    const error = '未対応のテンプレートです';
    await mark(job, 'failed', { error, noRetry: true });
    return { ...base, status: 'failed', error };
  }
  let loaded: Loaded;
  let real: { subject: string; text: string };
  let stored: { subject: string; text: string };
  try {
    loaded = await loadContext(job, shared);
    real = renderMail(job.template, { ...loaded.ctx, lookupUrl: loaded.realLookupUrl });
    stored = loaded.realLookupUrl ? renderMail(job.template, { ...loaded.ctx, lookupUrl: MASKED_LOOKUP }) : real;
  } catch (e) {
    const te = e instanceof TemplateError ? e : new TemplateError('メールの作成中にエラーが発生しました', true);
    await mark(job, 'failed', { error: te.message, noRetry: !te.retryable });
    return { ...base, status: 'failed', error: te.message };
  }
  if (loaded.skip) {
    await mark(job, 'skipped', { error: loaded.skip, subject: stored.subject, body: stored.text });
    return { ...base, status: 'skipped', error: loaded.skip };
  }
  const res = await sendMail({
    to: job.to_email,
    subject: real.subject,
    text: real.text,
    replyTo: loaded.replyTo || undefined,
    idempotencyKey: 'skyrent-outbox-' + job.id
  });
  if (res.status === 'sent') {
    await mark(job, 'sent', { providerId: res.providerId, subject: stored.subject, body: stored.text });
    return { ...base, status: 'sent' };
  }
  if (res.status === 'skipped') {
    await mark(job, 'skipped', { error: res.error, subject: stored.subject, body: stored.text });
    return { ...base, status: 'skipped', error: res.error };
  }
  await mark(job, 'failed', { error: res.error, subject: stored.subject, body: stored.text, noRetry: !res.retryable });
  return { ...base, status: 'failed', error: maskEmails(res.error) };
}

async function processGcal(job: OutboxRow): Promise<WorkerResult> {
  const base = { id: job.id, template: job.template };
  let r: { status: 'sent' | 'skipped' | 'failed'; error?: string };
  try {
    r = await processGcalJob(job);
  } catch (_e) {
    r = { status: 'failed', error: 'カレンダー同期中にエラーが発生しました' };
  }
  const status = r && (r.status === 'sent' || r.status === 'skipped' || r.status === 'failed') ? r.status : 'failed';
  const error = r && r.error ? maskEmails(String(r.error)).slice(0, 500) : undefined;
  await mark(job, status, { error: error ?? null });
  return error ? { ...base, status, error } : { ...base, status };
}

async function processOne(job: OutboxRow, shared: Shared): Promise<WorkerResult> {
  try {
    if (job.template === 'gcal_sync') return await processGcal(job);
    return await processMail(job, shared);
  } catch (_e) {
    const error = 'ワーカーの処理中にエラーが発生しました';
    console.error(JSON.stringify({ level: 'error', code: 'WORKER_JOB_FAILED', outboxId: job.id, template: job.template }));
    await mark(job, 'failed', { error }).catch(() => {});
    return { id: job.id, template: job.template, status: 'failed', error };
  }
}

// ---------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------
/**
 * @param p.limit     1回に処理する最大件数 (既定 20)
 * @param p.refIds    指定すると、その予約番号・受付番号のジョブだけを処理する
 * @param p.templates refIds と一緒に指定すると、そのテンプレートのジョブだけを処理する
 *                    (予約直後はメールだけを待ち、カレンダー同期は裏で行う、などに使う)
 */
export async function runWorker(
  p: { limit?: number; refIds?: string[]; templates?: string[] } = {}
): Promise<{ processed: number; results: WorkerResult[] }> {
  const limit = clampInt(p.limit, 1, 100, 20);
  const refIds = Array.isArray(p.refIds)
    ? p.refIds.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 50)
    : [];
  const templates = Array.isArray(p.templates) ? p.templates.filter((x) => typeof x === 'string').slice(0, 20) : [];
  const jobs = refIds.length ? await claimByRefs(refIds, limit, templates) : await claimGeneral(limit);
  jobs.sort((a, b) => priority(a.template) - priority(b.template) || a.id - b.id);
  const shared: Shared = {};
  const results = await mapLimit(jobs, 4, (job) => processOne(job, shared));
  return { processed: results.length, results };
}

/** 送信中のまま止まったジョブを失敗扱いに戻す (定期起動のワーカーから) */
export async function releaseStuck(): Promise<number> {
  const { data, error } = await adminClient().rpc('outbox_release_stuck');
  if (error) return 0;
  return Number(data) || 0;
}

/** outbox の状態 → API の email.status */
export function emailStatusOf(status: string | null | undefined): 'sent' | 'queued' | 'skipped' | 'failed' {
  if (status === 'sent') return 'sent';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed') return 'failed';
  return 'queued';
}
