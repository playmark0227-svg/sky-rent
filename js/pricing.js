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
 *                         cancelAt 省略時は現在時刻、base 省略時は cancellationBase(p)。
 *   cancellationBase(p) … キャンセル料の元になる「利用料金」。p = {reservation} | {quote, asset}
 *                         車両 = 基本料金 (予約の料金内訳の base → 期間から再計算 → 24時間料金)
 *                         家電レンタル = 借りる家電 (オプション) の料金の合計 (基本料金は 0 なので base は使わない)
 *   rules()             … 現在の料金ルール (SkyRentStore の settings.pricing_rules → 無ければ DEFAULT_RULES の複製)。
 *   yen(n)              … '¥1,100' 形式の表示
 *
 * 料金ルールは SkyRentStore.read('settings.pricing_rules') (本番は backend が app_settings から読み込む)。
 * 数量は常に1台・1点として計算する (quantity は互換のために受け取るだけ)。
 * 料金エンジンに渡す asset には categoryType ('vehicle' | 'item') を補う (カテゴリの type から。家電レンタルは 'item')。
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
  // カテゴリの type → 'item' (家電レンタル) | 'vehicle'。カテゴリが分からなければ車両
  function categoryTypeOfId(categoryId) {
    const S = store();
    const cat = categoryId != null && S && typeof S.getCategory === 'function' ? S.getCategory(categoryId) : null;
    return cat && cat.type === 'item' ? 'item' : 'vehicle';
  }
  // 料金エンジンに渡す asset (categoryType が無ければカテゴリから補う。store の値は書き換えない)
  function withCategoryType(asset) {
    if (!asset || typeof asset !== 'object' || asset.categoryType === 'item' || asset.categoryType === 'vehicle') return asset;
    return Object.assign({}, asset, { categoryType: categoryTypeOfId(asset.categoryId != null ? asset.categoryId : asset.category_id) });
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
      asset: withCategoryType(p.asset || findAsset(p.assetId)),
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

  // 料金内訳 (Quote の lines / 予約の price.lines・price.breakdown) のうち、オプションの行の合計。内訳が無ければ null
  //   (計算は SkyRentPricingCore.cancellationBase と同じ。サーバーのキャンセル料もこれを使う)
  function optionLinesTotal(price) {
    if (!price || typeof price !== 'object' || !(Array.isArray(price.lines) || Array.isArray(price.breakdown))) return null;
    const c = core();
    if (typeof c.cancellationBase === 'function') return c.cancellationBase({ price: price, categoryType: 'item' });
    const lines = Array.isArray(price.lines) ? price.lines : price.breakdown;
    return lines.reduce(function (s, l) { return s + (l && l.code === 'option' ? Math.max(0, Number(l.amount) || 0) : 0); }, 0);
  }

  // p から asset・カテゴリ ID・期間を引く (cancellationFee / cancellationBase 共通)
  function cancelContext(p) {
    const r = p.reservation || null;
    const asset = p.asset || findAsset(p.assetId != null ? p.assetId : (r ? r.assetId : null));
    let category = p.category || null;
    if (category && category.id == null && category.categoryId != null) category = { id: category.categoryId };
    if (!category) {
      const catId = asset && asset.categoryId != null ? asset.categoryId : (r ? r.categoryId : null);
      if (catId != null) category = { id: catId };
    }
    let type = asset && (asset.categoryType === 'item' || asset.categoryType === 'vehicle') ? asset.categoryType : null;
    if (!type) type = categoryTypeOfId(category ? category.id : null);
    return {
      r: r, asset: asset, category: category, item: type === 'item',
      start: p.start != null ? p.start : (r ? r.start : null),
      end: p.end != null ? p.end : (r ? r.end : null),
      rules: p.rules || currentRules()
    };
  }

  /** キャンセル料の元になる「利用料金」 (車両 = 基本料金 / 家電レンタル = 借りる家電の料金の合計) */
  function cancellationBase(p) {
    p = p || {};
    const x = cancelContext(p);
    const r = x.r, asset = x.asset;
    const snapPrice = p.quote || (r && r.price && typeof r.price === 'object' ? r.price : null);
    if (x.item) {
      // 家電レンタル: 予約の料金内訳 (または見積) のオプションの行 → 選んだ家電から再計算 → 合計
      const fromLines = optionLinesTotal(snapPrice);
      if (fromLines != null) return fromLines;
      const ids = r ? (Array.isArray(r.optionIds) ? r.optionIds : (r.options || []).map(function (o) { return o && (o.optionId || o.id); })) : [];
      if (asset && x.start != null && x.end != null && ids.length) {
        const q = core().quote({ asset: withCategoryType(asset), start: x.start, end: x.end, options: findOptions(ids), rules: x.rules });
        const t = optionLinesTotal(q);
        if (t != null) return t;
      }
      return Math.max(0, Number((snapPrice && snapPrice.total) || (r && r.total)) || 0);
    }
    // 車両: 予約時の基本料金 → 期間から再計算 → 24時間料金
    const snap = snapPrice ? Number(snapPrice.base) : NaN;
    if (isFinite(snap) && snap >= 0) return snap;
    if (asset && x.start != null && x.end != null) {
      const q = core().quote({ asset: withCategoryType(asset), start: x.start, end: x.end, rules: x.rules });
      return q.ok ? q.base : (Number(asset.priceDay) || 0);
    }
    return asset ? (Number(asset.priceDay) || 0) : 0;
  }

  /** キャンセル料 (予約データから足りない値を補って SkyRentPricingCore.cancellationFee を呼ぶ) */
  function cancellationFee(p) {
    p = p || {};
    const x = cancelContext(p);
    const asset = x.asset, start = x.start, category = x.category, R = x.rules;

    let base = p.base != null && p.base !== '' ? Number(p.base) : NaN;
    if (!isFinite(base)) base = cancellationBase(p);

    return core().cancellationFee({
      asset: withCategoryType(asset) || {},
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
    cancellationBase: cancellationBase,
    rules: rules,
    yen: yen,
    duration: duration,
    baseCharge: baseCharge
  };
})();
