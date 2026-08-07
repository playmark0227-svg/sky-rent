/**
 * グロースレンタカー - 料金計算エンジン
 *
 * 要件定義書 7章「料金計算ロジックの拡張性」準拠。
 * 対応する料金体系:
 *   - 時間貸し (priceHour) : 24時間未満の利用で、日貸しより安くなる場合に自動適用
 *   - 日貸し   (priceDay)  : 基本 (1日単位・切り上げ)
 *   - 週割引   (priceWeek) : 7日以上で自動適用 (端数は日割り。ただし週料金を超えない)
 *   - 月割引   (priceMonth): 30日以上で自動適用 (同上)
 *   - ハイシーズン料金     : sky-rent.high-season の期間に重なる日数分だけ加算 (%)
 *   - オプション           : per_day (日数×単価) / per_rental (1回固定)
 *   - クーポン割引         : 合計から額面を控除 (下限 0)
 *
 * 新しい料金体系 (長期割引・会員ランク別など) は rules 配列に関数を追加するだけで拡張可能。
 */
(function () {
  'use strict';
  const DAY = 86400000;
  const HOUR = 3600000;

  function yen(n) { return '¥' + Math.round(n).toLocaleString(); }

  // 期間 → {hours, days} (最低 1時間 / 1日)
  function duration(start, end) {
    const ms = Math.max(0, new Date(end) - new Date(start));
    const hours = Math.max(1, Math.ceil(ms / HOUR));
    const days = Math.max(1, Math.ceil(ms / DAY));
    return { ms: ms, hours: hours, days: days };
  }

  // ===== 基本料金 (1台/1点あたり) =====
  function baseCharge(asset, start, end) {
    const d = duration(start, end);
    const pH = Number(asset.priceHour) || 0;
    const pD = Number(asset.priceDay) || 0;
    const pW = Number(asset.priceWeek) || 0;
    const pM = Number(asset.priceMonth) || 0;

    // 月貸し
    if (d.days >= 30 && pM) {
      const months = Math.floor(d.days / 30);
      const rest = d.days % 30;
      const amount = Math.min(pM * months + rest * pD, pM * (months + 1));
      return { amount: amount, label: '基本料金 (月割 ' + d.days + '日)', days: d.days, hours: d.hours, plan: 'monthly' };
    }
    // 週貸し
    if (d.days >= 7 && pW) {
      const weeks = Math.floor(d.days / 7);
      const rest = d.days % 7;
      const amount = Math.min(pW * weeks + rest * pD, pW * (weeks + 1));
      return { amount: amount, label: '基本料金 (週割 ' + d.days + '日)', days: d.days, hours: d.hours, plan: 'weekly' };
    }
    // 時間貸し (24h未満のみ・日貸しより安い場合)
    if (d.hours < 24 && pH) {
      const hourly = pH * d.hours;
      if (hourly < pD || !pD) {
        return { amount: hourly, label: '基本料金 (時間貸し ' + d.hours + '時間)', days: d.days, hours: d.hours, plan: 'hourly' };
      }
    }
    // 日貸し
    return { amount: pD * d.days, label: '基本料金 (' + d.days + '日)', days: d.days, hours: d.hours, plan: 'daily' };
  }

  // ===== ハイシーズン加算 =====
  // seasons: [{name, start, end, rate}] rate=% (例 20)。期間に重なる日数割合で基本料金に加算。
  function seasonSurcharge(base, start, end, seasons) {
    if (!seasons || !seasons.length || !base.amount) return null;
    const s = new Date(start), e = new Date(end);
    let surcharge = 0;
    const names = [];
    seasons.forEach(season => {
      if (!season.start || !season.end) return;
      const ss = new Date(season.start + (String(season.start).length <= 10 ? 'T00:00:00' : ''));
      const se = new Date(season.end + (String(season.end).length <= 10 ? 'T23:59:59' : ''));
      const from = Math.max(s.getTime(), ss.getTime());
      const to = Math.min(e.getTime(), se.getTime());
      if (to <= from) return;
      const overlapDays = Math.ceil((to - from) / DAY);
      const rate = Number(season.rate) || 20;
      surcharge += Math.round(base.amount / base.days * overlapDays * rate / 100);
      names.push(season.name || 'ハイシーズン');
    });
    if (!surcharge) return null;
    return { amount: surcharge, label: 'ハイシーズン加算 (' + names.join('・') + ')' };
  }

  // ===== オプション料金 =====
  function optionCharges(options, days) {
    return (options || []).map(o => {
      const isPerDay = o.priceType !== 'per_rental';
      const amount = isPerDay ? (Number(o.price) || 0) * days : (Number(o.price) || 0);
      return {
        amount: amount,
        label: o.name + (isPerDay ? ' (' + yen(o.price) + ' × ' + days + '日)' : ' (1回)'),
        optionId: o.optionId
      };
    });
  }

  /**
   * 総合計算
   * @param {object} p {asset, start, end, quantity, options: [option objects], coupon: {amount}|null, seasons: []}
   * @returns {object} {lines: [{label, amount}], days, hours, plan, subtotal, discount, total}
   */
  function calculate(p) {
    const qty = Number(p.quantity) || 1;
    const base = baseCharge(p.asset, p.start, p.end);
    const lines = [];

    lines.push({
      label: base.label + (qty > 1 ? ' × ' + qty + '点' : ''),
      amount: base.amount * qty
    });

    const season = seasonSurcharge(base, p.start, p.end, p.seasons || readSeasons());
    if (season) lines.push({ label: season.label, amount: season.amount * qty });

    optionCharges(p.options, base.days).forEach(l => lines.push(l));

    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    let discount = 0;
    if (p.coupon && p.coupon.amount) {
      discount = Math.min(Number(p.coupon.amount) || 0, subtotal);
      lines.push({ label: 'クーポン割引', amount: -discount });
    }
    const total = subtotal - discount;

    return {
      lines: lines,
      days: base.days, hours: base.hours, plan: base.plan,
      subtotal: subtotal, discount: discount, total: total
    };
  }

  // 管理画面のハイシーズン管理 (sky-rent.high-season) を自動参照
  function readSeasons() {
    try {
      const raw = localStorage.getItem('sky-rent.high-season');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  window.SkyRentPricing = { calculate: calculate, baseCharge: baseCharge, duration: duration, yen: yen };
})();
