// =====================================================================
// worker — 送信キュー (メール・Google カレンダー同期) の処理 (実装契約書 §2.3)
//   POST /worker  {limit?, refIds?}
//   認証: x-worker-secret: WORKER_SECRET  または  Authorization: Bearer <service_role key>
//   定期起動 (pg_cron / 外部 cron) から1分ごとに呼ぶ想定。api / admin からは関数を直接呼ぶ。
// =====================================================================
import { ApiError, handle, readJson, subPath } from '../_shared/http.ts';
import { env, isServiceRole } from '../_shared/db.ts';
import { timingSafeEqual } from '../_shared/tokens.ts';
import { releaseStuck, runWorker } from '../_shared/worker-core.ts';

function authorized(req: Request): boolean {
  const secret = env().WORKER_SECRET;
  const given = req.headers.get('x-worker-secret') || '';
  if (secret && secret.length >= 16 && given && timingSafeEqual(given, secret)) return true;
  return isServiceRole(req);
}

Deno.serve((req) =>
  handle(req, async (req) => {
    const path = subPath(req, 'worker');
    if (path !== '/') throw new ApiError('NOT_FOUND', 404, 'ご指定の機能が見つかりませんでした。');
    if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 405);
    if (!authorized(req)) throw new ApiError('UNAUTHENTICATED', 401, 'ワーカーの起動には認証が必要です。');
    const b = await readJson(req);
    const refIds = Array.isArray(b.refIds) ? b.refIds.filter((x: unknown) => typeof x === 'string') : undefined;
    const released = refIds && refIds.length ? 0 : await releaseStuck();
    const out = await runWorker({ limit: b.limit, refIds });
    return { ok: true, released, processed: out.processed, results: out.results };
  })
);
