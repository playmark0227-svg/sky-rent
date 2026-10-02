// =====================================================================
// DB (RPC) のエラー → 契約書 §2 のエラーコード
//   public.fail(code, detail) は errcode P0001・message = コード文字列で raise する。
//   既知のコードはそのまま (HTTP ステータスは http.ts の表)、それ以外は INTERNAL。
// =====================================================================
import { ApiError, STATUS_BY_CODE } from './http.ts';

/** 入力欄に結び付けて表示したいコード */
const FIELD_OF: Record<string, Record<string, string>> = {
  INVALID_PERIOD: { end: '返却日時は貸出日時より後にしてください。' },
  START_IN_PAST: { start: '過去の日時は選べません。' },
  PERIOD_TOO_LONG: { end: 'Webで予約できる期間は最長93日です。' },
  START_TOO_FAR: { start: 'ご予約は400日先まで受け付けています。' },
  OPTION_INVALID: { optionIds: 'この車両では選べないオプションが含まれています。' },
  OPTION_CONFLICT: { optionIds: '同時に選べないオプションが選ばれています。' },
  DISCOUNT_NOT_APPLICABLE: { discountType: 'この割引は適用できません。' },
  ITEM_REQUIRED: { optionIds: 'お借りになる家電を1つ以上お選びください。' },
  OPTION_SOLD_OUT: { optionIds: 'ご希望の日時は貸し出し中の家電があります。' }
};

const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;

/**
 * OPTION_SOLD_OUT の details (売り切れの家電の id。家電セットを選んだ場合はセット自身の id も)。
 * DB は detail にカンマ区切りで入れる。配列でも受け付ける (Edge Function で先に確認したとき)。
 */
export function soldOutDetails(v: unknown): { optionIds: string[] } {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
  const optionIds: string[] = [];
  for (const x of raw) {
    const id = String(x ?? '').trim();
    if (OPTION_ID_RE.test(id) && !optionIds.includes(id)) optionIds.push(id);
  }
  return { optionIds };
}

/** 在庫切れ (OPTION_SOLD_OUT) の ApiError。details.optionIds と fields.optionIds を付ける */
export function soldOutError(optionIds: unknown): ApiError {
  return new ApiError('OPTION_SOLD_OUT', STATUS_BY_CODE.OPTION_SOLD_OUT, undefined, {
    details: soldOutDetails(optionIds),
    fields: fieldsOfCode('OPTION_SOLD_OUT')
  });
}

/**
 * コードに結び付く入力欄のメッセージ (無ければ undefined)。
 * DB が返したときも、料金計算 (pricing-core の errors) で見つかったときも、同じ code なら同じ fields を返すために使う。
 */
export function fieldsOfCode(code: string): Record<string, string> | undefined {
  const f = FIELD_OF[code];
  return f ? { ...f } : undefined;
}

/** DB 側の別名 → 契約書のコード */
const ALIASES: Record<string, string> = {
  STALE: 'VERSION_CONFLICT',
  RESERVATION_NOT_FOUND: 'NOT_FOUND'
};

type PgLike = { code?: string; message?: string; details?: string; hint?: string } | null | undefined;

/** RPC エラーを ApiError に変換する。ApiError が渡されたらそのまま返す。 */
export function pgToApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as PgLike;
  const msg = String(e?.message || '').trim();
  const pgCode = String(e?.code || '');
  const head = msg.split(/[\s:]/)[0] || '';
  const code = ALIASES[head] || head;
  if (pgCode === 'P0001' && code === 'OPTION_SOLD_OUT') return soldOutError(e?.details);
  if (pgCode === 'P0001' && code && code !== 'INTERNAL' && STATUS_BY_CODE[code]) {
    const fields = fieldsOfCode(code);
    return new ApiError(code, STATUS_BY_CODE[code], undefined, fields ? { fields } : undefined);
  }
  // 排他制約 (期間の重なり)
  if (pgCode === '23P01') return new ApiError('AVAILABILITY_CONFLICT', 409);
  // 一意制約違反
  if (pgCode === '23505') return new ApiError('CONFLICT', 409);
  // 権限
  if (pgCode === '42501') return new ApiError('FORBIDDEN', 403);
  // 入力値の型不正・制約違反
  if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22008' || pgCode === '23514' || pgCode === '22001') {
    return new ApiError('VALIDATION', 400);
  }
  const wrapped = new ApiError('INTERNAL', 500);
  // ログ用に元の種類だけ残す (メッセージは残さない)
  (wrapped as unknown as { cause: unknown }).cause = { code: pgCode || 'unknown' };
  return wrapped;
}

/**
 * やり直せば通る DB エラー (デッドロック・直列化失敗・ロック待ちの打ち切り)。
 * 同じ車両に同時に予約が来ると、排他制約の確認どうしが待ち合ってデッドロックになることがある。
 */
export function isTransientPgError(err: unknown): boolean {
  const code = String((err as PgLike)?.code || '');
  return code === '40P01' || code === '40001' || code === '55P03';
}

/** RPC / 更新を、一時的な DB エラーのときだけ数回やり直す (トランザクションは丸ごと戻っているので安全) */
export async function withPgRetry<T>(
  fn: () => PromiseLike<{ data: T; error: any }>,
  attempts = 4
): Promise<{ data: T; error: any }> {
  let res = await fn();
  for (let i = 1; i < attempts && res.error && isTransientPgError(res.error); i++) {
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 120) * i));
    res = await fn();
  }
  return res;
}

/** supabase-js の {data, error} を受け取り、error なら ApiError を投げる */
export function unwrap<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw pgToApiError(res.error);
  return res.data;
}
