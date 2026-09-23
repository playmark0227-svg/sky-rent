// =====================================================================
// カタログ・設定・料金計算 (サーバー側)
//   料金は必ず DB のカタログと app_settings.pricing_rules から計算する
//   (クライアントから送られた金額・単価は信用しない)。
// =====================================================================
import './pricing-core.js';
import { ApiError } from './http.ts';
import { adminClient } from './db.ts';
import { pgToApiError } from './errors.ts';

// deno-lint-ignore no-explicit-any
export const Core: any = (globalThis as any).SkyRentPricingCore;

export type AssetRow = {
  id: string; category_id: string; location_id: string; name: string; name_en: string;
  price_hour: number | null; price_day: number; custom_fields: Record<string, unknown>; active: boolean;
  capacity: number | null; image: string; photo: string;
};
export type CategoryRow = { id: string; name: string; type: string; active: boolean };
export type LocationRow = {
  id: string; name: string; address: string; tel: string; hours: string; holiday: string; active: boolean;
};
export type OptionRow = {
  id: string; name: string; price: number; price_short: number | null; price_type: string;
  category_ids: string[] | null; kind: string; exclusive_group: string | null; active: boolean;
  extra?: Record<string, unknown>;
};
export type LegalDoc = { id: string; version: string; title: string; url: string };
export type Bundle = { asset: AssetRow; category: CategoryRow; location: LocationRow };

/** ISO 文字列 (タイムゾーン無しは日本時間) → UTC の ISO。不正なら null */
export function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Core.toMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 設定をまとめて読む (無いキーは結果に含まれない) */
export async function loadSettings(keys: string[]): Promise<Record<string, any>> {
  const { data, error } = await adminClient().from('app_settings').select('key, value').in('key', keys);
  if (error) throw pgToApiError(error);
  const out: Record<string, any> = {};
  for (const r of data || []) out[r.key] = r.value;
  return out;
}

export async function loadPricingRules(): Promise<any> {
  const s = await loadSettings(['pricing_rules']);
  const r = s.pricing_rules;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : Core.DEFAULT_RULES;
}

/** 公開中 (active) の法務文書 */
export async function loadActiveLegal(): Promise<LegalDoc[]> {
  const { data, error } = await adminClient().from('legal_documents')
    .select('id, version, title, url').eq('active', true).order('id');
  if (error) throw pgToApiError(error);
  return (data || []) as LegalDoc[];
}

/** 車両 + カテゴリ + 拠点 (無ければ null。有効かどうかは呼び出し側で判定) */
export async function loadAssetBundle(assetId: string): Promise<Bundle | null> {
  const db = adminClient();
  const { data: asset, error } = await db.from('assets')
    .select('id, category_id, location_id, name, name_en, price_hour, price_day, custom_fields, active, capacity, image, photo')
    .eq('id', assetId).maybeSingle();
  if (error) throw pgToApiError(error);
  if (!asset) return null;
  const [c, l] = await Promise.all([
    db.from('categories').select('id, name, type, active').eq('id', asset.category_id).maybeSingle(),
    db.from('locations').select('id, name, address, tel, hours, holiday, active').eq('id', asset.location_id).maybeSingle()
  ]);
  if (c.error) throw pgToApiError(c.error);
  if (l.error) throw pgToApiError(l.error);
  if (!c.data || !l.data) return null;
  return { asset: asset as AssetRow, category: c.data as CategoryRow, location: l.data as LocationRow };
}

export async function loadOptionsByIds(ids: string[]): Promise<OptionRow[]> {
  if (!ids.length) return [];
  const { data, error } = await adminClient().from('options')
    .select('id, name, price, price_short, price_type, category_ids, kind, exclusive_group, active, extra')
    .in('id', ids);
  if (error) throw pgToApiError(error);
  return (data || []) as OptionRow[];
}

export function coreAsset(a: AssetRow) {
  return {
    id: a.id, categoryId: a.category_id, priceHour: a.price_hour, priceDay: a.price_day,
    customFields: a.custom_fields || {}
  };
}

export function coreOption(o: OptionRow) {
  return {
    id: o.id, name: o.name, price: o.price, priceShort: o.price_short, priceType: o.price_type,
    categoryIds: o.category_ids, exclusiveGroup: o.exclusive_group
  };
}

/** pricing-core の errors → API のエラーコード */
export function quoteErrorCode(errors: string[]): string {
  const e = errors[0];
  if (e === 'OPTION_NOT_APPLICABLE') return 'OPTION_INVALID';
  if (e === 'INVALID_ASSET') return 'ASSET_UNAVAILABLE';
  return e || 'VALIDATION';
}

export type QuoteInput = {
  assetId: string;
  start: string; // ISO (UTC)
  end: string;
  optionIds: string[];
  discountType: string | null;
  coupon: { id: string; amount: number } | null;
};

export type QuoteResult = {
  quote: any;
  bundle: Bundle;
  options: OptionRow[];
  rules: any;
};

/**
 * サーバー側の見積。車両が無い・停止中 / オプションが無効 / 割引の種類が不明 はここで例外。
 * 料金ルール上の不備 (期間・補償の重複・割引条件) は quote.errors に入る (呼び出し側で判断)。
 */
export async function serverQuote(p: QuoteInput): Promise<QuoteResult> {
  const [bundle, options, rules] = await Promise.all([
    loadAssetBundle(p.assetId),
    loadOptionsByIds(p.optionIds),
    loadPricingRules()
  ]);
  if (!bundle) {
    throw new ApiError('NOT_FOUND', 404, 'ご指定の車両が見つかりませんでした。車両を選び直してください。',
      { fields: { assetId: '車両が見つかりません。' } });
  }
  if (!bundle.asset.active || !bundle.category.active || !bundle.location.active) {
    throw new ApiError('ASSET_UNAVAILABLE', 409);
  }
  const byId = new Map(options.map((o) => [o.id, o]));
  for (const id of p.optionIds) {
    const o = byId.get(id);
    if (!o || !o.active || (Array.isArray(o.category_ids) && o.category_ids.length &&
      !o.category_ids.includes(bundle.asset.category_id))) {
      throw new ApiError('OPTION_INVALID', 400, undefined, { fields: { optionIds: 'この車両では選べないオプションが含まれています。' } });
    }
  }
  if (p.discountType) {
    const d = rules && rules.discounts ? rules.discounts : Core.DEFAULT_RULES.discounts;
    if (!Object.prototype.hasOwnProperty.call(d, p.discountType)) {
      throw new ApiError('VALIDATION', 400, undefined, { fields: { discountType: '割引の種類が正しくありません。' } });
    }
  }
  const ordered = p.optionIds.map((id) => byId.get(id)!) as OptionRow[];
  const quote = Core.quote({
    asset: coreAsset(bundle.asset),
    start: p.start,
    end: p.end,
    options: ordered.map(coreOption),
    discountType: p.discountType || null,
    coupon: p.coupon ? { id: p.coupon.id, amount: p.coupon.amount } : null,
    rules
  });
  return { quote, bundle, options: ordered, rules };
}

/** キャンセル料 (base は予約時の price.base。無ければ合計) */
export function cancellationFor(
  r: { status: string; start_at: string; price?: any; total?: number; category_id: string },
  asset: AssetRow | null,
  rules: any,
  now: Date
) {
  const base = r.price && Number.isFinite(Number(r.price.base)) ? Number(r.price.base) : Number(r.total || 0);
  const cancellable = r.status === 'confirmed' && Date.parse(r.start_at) > now.getTime();
  const fee = Core.cancellationFee({
    asset: asset ? coreAsset(asset) : { categoryId: r.category_id, customFields: {} },
    category: { id: r.category_id },
    start: r.start_at,
    cancelAt: now.toISOString(),
    base,
    rules
  });
  return { cancellable, fee: fee.fee as number, pct: fee.pct as number, label: fee.label as string, base, cls: fee.cls, busy: fee.busy };
}
