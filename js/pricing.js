/**
 * グロースレンタカー - 料金計算 (画面向けアダプタ)
 *
 * 計算そのものは js/pricing-core.js (SkyRentPricingCore) が行う。サーバー (Edge Function) と同じコード。
 * このファイルは、既存画面が使ってきた SkyRentPricing.calculate() の形を保つための薄い変換層
 * (実装契約書 docs/production/implementation-v1.md §1「js/pricing.js」)。
 *
 *   calculate({asset, start, end, quantity, options, coupon, discountType})
 *       → {lines:[{label, amount, code, optionId?}], days, hours, plan, subtotal, discount, total,
 *          ok, errors, quote}
 *         discount = 割引 + クーポン (total = subtotal − discount)。quote は SkyRentPricingCore の Quote。
 *   quote(p)            … SkyRentPricingCore.quote に料金ルールを補って呼ぶ (Quote をそのまま返す)。
 *                         p.options の代わりに p.optionIds、p.asset の代わりに p.assetId でも可 (store から引く)。
 *   cancellationFee(p)  … キャンセル料 {cls, busy, daysBefore, pct, fee, label}。
 *                         p = {reservation | asset/assetId + start (+ end), cancelAt?, base?, noShow?, category?, rules?}
 *                         cancelAt 省略時は現在時刻、base 省略時は予約の料金内訳 → 期間から再計算 → 24時間料金。
 *   rules()             … 現在の料金ルール (SkyRentStore の settings.pricing_rules → 無ければ DEFAULT_RULES の複製)。
 *   yen(n)              … '¥1,100' 形式の表示
 *
 * 料金ルールは SkyRentStore.read('settings.pricing_rules') (本番は backend が app_settings から読み込む)。
 * 取り扱いは車両のみのため数量は常に1台として計算する (quantity は互換のために受け取るだけ)。
 */
(function () {
  'use strict';

  function core() {
    const c = window.SkyRentPricingCore;
    if (!c) throw new Error('js/pricing-core.js が読み込まれていません (pricing.js より先に読み込んでください)');
    return c;
  }
  function store() { return window.SkyRentStore || null; }

  function yen(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-¥' : '¥') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 計算に使うルール (読み取り専用で使う)
  function currentRules() {
    const S = store();
    try {
      const r = S && typeof S.read === 'function' ? S.read('settings.pricing_rules', null) : null;
      if (r && typeof r === 'object' && !Array.isArray(r)) return r;
    } catch (e) { /* 読めなければ既定値 */ }
    return core().DEFAULT_RULES;
  }
  // 画面へ渡す用 (既定値は凍結されているので複製して返す)
  function rules() {
    const r = currentRules();
    return r === core().DEFAULT_RULES ? JSON.parse(JSON.stringify(r)) : r;
  }

  function findAsset(id) {
    const S = store();
    return id != null && S && typeof S.getAsset === 'function' ? (S.getAsset(id) || null) : null;
  }
  function findOptions(ids) {
    const S = store();
    if (!Array.isArray(ids) || !S || typeof S.list !== 'function') return [];
    const all = S.list('options') || [];
    return ids.map(function (id) {
      return all.find(function (o) { return String(o.optionId) === String(id); });
    }).filter(Boolean);
  }

  function coreInput(p) {
    p = p || {};
    const c = p.coupon;
    const couponAmount = c ? Number(c.amount) : 0;
    return {
      asset: p.asset || findAsset(p.assetId),
      start: p.start,
      end: p.end,
      options: Array.isArray(p.options) ? p.options : findOptions(p.optionIds),
      discountType: p.discountType || null,
      coupon: couponAmount > 0 ? { id: c.id != null ? c.id : (c.couponId != null ? c.couponId : null), amount: couponAmount } : null,
      rules: p.rules || currentRules()
    };
  }

  function quote(p) { return core().quote(coreInput(p)); }

  /** 旧形式の料金計算 (detail.html / booking.html など既存画面用) */
  function calculate(p) {
    const q = quote(p);
    return {
      lines: q.lines.map(function (l) {
        const o = { label: l.label, amount: l.amount, code: l.code };
        if (l.optionId != null) o.optionId = l.optionId;
        return o;
      }),
      days: q.days, hours: q.hours, plan: q.plan,
      subtotal: q.subtotal,
      discount: q.discount + q.couponDiscount,
      total: q.total,
      ok: q.ok, errors: q.errors.slice(),
      quote: q
    };
  }

  /** キャンセル料 (予約データから足りない値を補って SkyRentPricingCore.cancellationFee を呼ぶ) */
  function cancellationFee(p) {
    p = p || {};
    const r = p.reservation || null;
    const asset = p.asset || findAsset(p.assetId != null ? p.assetId : (r ? r.assetId : null));
    const start = p.start != null ? p.start : (r ? r.start : null);
    const end = p.end != null ? p.end : (r ? r.end : null);
    const R = p.rules || currentRules();

    let category = p.category || null;
    if (category && category.id == null && category.categoryId != null) category = { id: category.categoryId };
    if (!category) {
      const catId = asset && asset.categoryId != null ? asset.categoryId : (r ? r.categoryId : null);
      if (catId != null) category = { id: catId };
    }

    let base = p.base != null && p.base !== '' ? Number(p.base) : NaN;
    if (!isFinite(base)) {
      const snap = r && r.price && typeof r.price === 'object' ? Number(r.price.base) : NaN;
      if (isFinite(snap) && snap >= 0) base = snap;
      else if (asset && start != null && end != null) {
        const q = core().quote({ asset: asset, start: start, end: end, rules: R });
        base = q.ok ? q.base : (Number(asset.priceDay) || 0);
      } else base = asset ? (Number(asset.priceDay) || 0) : 0;
    }

    return core().cancellationFee({
      asset: asset || {},
      category: category,
      start: start,
      cancelAt: p.cancelAt != null ? p.cancelAt : new Date(),
      base: base,
      noShow: !!p.noShow,
      rules: R
    });
  }

  // ===== 互換用 (旧 API) =====
  function duration(start, end) {
    const hours = core().hoursBetween(start, end);
    return { hours: hours, days: Math.ceil(hours / 24) };
  }
  function baseCharge(asset, start, end) {
    const q = quote({ asset: asset, start: start, end: end });
    const first = q.lines[0];
    return { amount: q.base, label: first ? first.label : '基本料金', days: q.days, hours: q.hours, plan: q.plan };
  }

  window.SkyRentPricing = {
    calculate: calculate,
    quote: quote,
    cancellationFee: cancellationFee,
    rules: rules,
    yen: yen,
    duration: duration,
    baseCharge: baseCharge
  };
})();
