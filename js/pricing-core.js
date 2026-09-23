/**
 * グロースレンタカー - 料金計算コア (SkyRentPricingCore)
 *
 * 実装契約書 docs/production/implementation-v1.md §1 準拠。
 * 「レンタカー 総合料金表 (2026年6月改定版)」の計算を、ブラウザとサーバー (Edge Function) で
 * 同じコードで行うための1ファイル。
 *
 *   - ブラウザ: <script src="js/pricing-core.js"> (classic script)
 *   - Deno    : import '../_shared/pricing-core.js' (副作用 import。export は無い)
 *   どちらでも globalThis.SkyRentPricingCore が設定される。
 *
 * 正本は js/pricing-core.js。supabase/functions/_shared/pricing-core.js は
 * `node scripts/sync-shared.mjs` で作るコピー (直接編集しない。tests/pricing.test.mjs で一致を検査)。
 *
 * 約束:
 *   - 全関数が純関数 (現在時刻・乱数・ストレージを内部で使わない)。
 *   - 時刻は常に日本時間 (UTC+9 固定。日本に夏時間は無い) で扱う。実行環境の TZ・ロケールに依存しない
 *     (ローカル時刻の Date API や数値のロケール整形を使わない)。
 *   - タイムゾーン表記の無い日時文字列 ('2026-09-24T10:00'、'2026-09-24') は日本時間として解釈する。
 *   - 金額はすべて税込・円の整数。
 */
(function (root) {
  'use strict';

  const HOUR = 3600000;
  const DAY = 86400000;
  const JST_OFFSET = 9 * HOUR;

  // ===================================================================
  // 既定の料金ルール — supabase/seed.sql の app_settings.pricing_rules と同じ内容
  // (値を変えるときは seed.sql と両方を直す。tests/pricing.test.mjs で一致を検査)
  // ===================================================================
  const DEFAULT_RULES = deepFreeze({
    version: '2026-06',
    timezone: 'Asia/Tokyo',
    shortHoursMax: 6,
    weekendHolidayFee: 330,
    nightFee: 1100,
    nightStartHour: 20,
    nightEndHour: 8,
    busyFee: 550,
    busyPeriods: [
      { name: 'ゴールデンウィーク', from: '04-26', to: '05-05' },
      { name: '年末年始', from: '12-29', to: '01-03' }
    ],
    extraHolidays: [],
    discounts: {
      student:        { label: '学生割引',         amount: 1100, minHours: 24, proof: '学生証' },
      corporate:      { label: '法人割引',         amount: 1100, minHours: 24, proof: '社員証・法人名でのご予約' },
      dual_residence: { label: '二地域居住者割引', amount: 1100, minHours: 24, proof: '二地域居住者限定特別価格チラシ' },
      shusei_club:    { label: '守成クラブ会員割引', amount: 3000, minHours: 24, proof: '守成クラブ会員であることが分かるもの', categoryIds: ['cat-kitchen'] }
    },
    cancellation: {
      classOf: { 'コンパクト': 'compact', '軽トラック': 'compact', 'SUV': 'large', 'ミニバン': 'large' },
      categoryClass: { 'cat-kitchen': 'kitchen' },
      normal: {
        compact: [{ minDays: 3, pct: 0 }, { minDays: 1, pct: 30 }, { minDays: 0, pct: 50 }],
        large:   [{ minDays: 3, pct: 0 }, { minDays: 1, pct: 30 }, { minDays: 0, pct: 50 }],
        kitchen: [{ minDays: 14, pct: 0 }, { minDays: 3, pct: 50 }, { minDays: 0, pct: 100 }]
      },
      busy: {
        compact: [{ minDays: 7, pct: 0 }, { minDays: 1, pct: 30 }, { minDays: 0, pct: 50 }],
        large:   [{ minDays: 7, pct: 0 }, { minDays: 1, pct: 30 }, { minDays: 0, pct: 50 }],
        kitchen: [{ minDays: 14, pct: 0 }, { minDays: 7, pct: 20 }, { minDays: 3, pct: 30 }, { minDays: 1, pct: 50 }, { minDays: 0, pct: 100 }]
      },
      noShowPct: 100
    },
    noc: {
      compact: { drivable: 30000, notDrivable: 60000 },
      large:   { drivable: 30000, notDrivable: 60000 },
      kitchen: { drivable: 60000, notDrivable: 150000 }
    }
  });

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }

  // 渡されたルールに無い項目は既定値で補う (上位キー単位)
  function mergeRules(rules) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return DEFAULT_RULES;
    return Object.assign({}, DEFAULT_RULES, rules);
  }

  // ===================================================================
  // 小物
  // ===================================================================
  // 数値化 (null・空文字・数値でないものは null)
  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  // 正の数だけ採用 (0・未設定は「その料金なし」)
  function positive(v) {
    const n = num(v);
    return n != null && n > 0 ? n : null;
  }
  // camelCase / snake_case のどちらの行でも読めるようにする
  function pick(o, camel, snake) {
    if (!o) return undefined;
    return o[camel] !== undefined ? o[camel] : o[snake];
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pushUnique(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  // ===================================================================
  // 日時 (日本時間固定)
  // ===================================================================
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  // ISO 文字列 / Date / ミリ秒 → エポックミリ秒 (不正なら NaN)
  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string') return NaN;
    const m = ISO_RE.exec(v.trim());
    if (!m) return NaN; // ISO 8601 以外は受け付けない (解釈が実行環境に依存するため)
    const y = +m[1], mo = +m[2], d = +m[3];
    const hh = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, ss = m[6] ? +m[6] : 0;
    const frac = m[7] ? Math.floor(Number('0.' + m[7]) * 1000) : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || hh > 23 || mi > 59 || ss > 59) return NaN;
    let offsetMin = 9 * 60; // タイムゾーン表記なし → 日本時間
    const z = m[8];
    if (z) {
      if (z.toUpperCase() === 'Z') offsetMin = 0;
      else {
        const digits = z.slice(1).replace(':', '');
        const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2, 4) : 0;
        if (oh > 23 || om > 59) return NaN;
        offsetMin = (z[0] === '-' ? -1 : 1) * (oh * 60 + om);
      }
    }
    return Date.UTC(y, mo - 1, d, hh, mi, ss, frac) - offsetMin * 60000;
  }

  // 日本時間の暦日の通し番号 (1970-01-01 = 0)
  function dayIndex(ms) { return Math.floor((ms + JST_OFFSET) / DAY); }
  function ymdOfIndex(i) {
    const d = new Date(i * DAY);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function dowOfIndex(i) { return new Date(i * DAY).getUTCDay(); }

  /** 日時 → 日本時間の各部 {y, m, d, hh, mm, dow(0=日), ymd:'YYYY-MM-DD'}。不正なら null */
  function jstParts(isoOrDate) {
    const t = toMs(isoOrDate);
    if (!isFinite(t)) return null;
    const d = new Date(t + JST_OFFSET);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    return {
      y: y, m: m, d: dd,
      hh: d.getUTCHours(), mm: d.getUTCMinutes(),
      dow: d.getUTCDay(),
      ymd: y + '-' + pad2(m) + '-' + pad2(dd)
    };
  }

  /** 利用時間 (時間単位・端数切り上げ・最低1) */
  function hoursBetween(start, end) {
    const ms = toMs(end) - toMs(start);
    if (!(ms > 0)) return 1;
    return Math.max(1, Math.ceil(ms / HOUR));
  }

  // ===================================================================
  // 祝日 (国民の祝日に関する法律。春分・秋分は 1980〜2099 年の簡易式)
  // ===================================================================
  const holidayCache = {};

  function nthMonday(y, month, n) {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  }
  function vernalEquinoxDay(y) {
    return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  }
  function autumnalEquinoxDay(y) {
    return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  }

  // その年の祝日表 {'YYYY-MM-DD': 名称}
  function buildHolidays(y) {
    const named = {}; // 国民の祝日 (振替休日・国民の休日を除く)
    function add(m, d, name) { named[y + '-' + pad2(m) + '-' + pad2(d)] = name; }

    add(1, 1, '元日');
    add(1, y >= 2000 ? nthMonday(y, 1, 2) : 15, '成人の日');
    if (y >= 1967) add(2, 11, '建国記念の日');
    if (y >= 2020) add(2, 23, '天皇誕生日');
    add(3, vernalEquinoxDay(y), '春分の日');
    add(4, 29, y >= 2007 ? '昭和の日' : (y >= 1989 ? 'みどりの日' : '天皇誕生日'));
    add(5, 3, '憲法記念日');
    if (y >= 2007) add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    if (y === 2020) add(7, 23, '海の日');
    else if (y === 2021) add(7, 22, '海の日');
    else if (y >= 2003) add(7, nthMonday(y, 7, 3), '海の日');
    else if (y >= 1996) add(7, 20, '海の日');
    if (y === 2020) add(8, 10, '山の日');
    else if (y === 2021) add(8, 8, '山の日');
    else if (y >= 2016) add(8, 11, '山の日');
    if (y >= 2003) add(9, nthMonday(y, 9, 3), '敬老の日');
    else if (y >= 1966) add(9, 15, '敬老の日');
    add(9, autumnalEquinoxDay(y), '秋分の日');
    if (y === 2020) add(7, 24, 'スポーツの日');
    else if (y === 2021) add(7, 23, 'スポーツの日');
    else if (y >= 2000) add(10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
    else if (y >= 1966) add(10, 10, '体育の日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');
    if (y >= 1989 && y <= 2018) add(12, 23, '天皇誕生日');
    if (y === 2019) { add(5, 1, '天皇の即位の日'); add(10, 22, '即位礼正殿の儀'); }

    const out = Object.assign({}, named);
    const idxs = Object.keys(named).sort().map(function (k) { return Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / DAY; });

    // 振替休日: 祝日が日曜なら、その後の最も近い「国民の祝日でない日」(2006年までは翌日のみ)
    if (y >= 1973) {
      idxs.forEach(function (i) {
        if (dowOfIndex(i) !== 0) return;
        let j = i + 1;
        if (y >= 2007) { while (named[ymdOfIndex(j)]) j++; }
        else if (named[ymdOfIndex(j)]) return;
        out[ymdOfIndex(j)] = '振替休日';
      });
    }
    // 国民の休日: 前日と翌日が国民の祝日である日 (国民の祝日でない日に限る)
    if (y >= 1986) {
      idxs.forEach(function (i) {
        const mid = ymdOfIndex(i + 1);
        if (named[mid] || out[mid] || !named[ymdOfIndex(i + 2)]) return;
        if (y < 2007 && dowOfIndex(i + 1) === 0) return;
        out[mid] = '国民の休日';
      });
    }
    return out;
  }

  // 'YYYY-MM-DD' はそのまま、日時なら日本時間の日付へ
  function normYmd(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const p = jstParts(v);
    return p ? p.ymd : null;
  }

  /** 祝日名 (振替休日・国民の休日を含む)。祝日でなければ null */
  function holidayName(ymd) {
    const k = normYmd(ymd);
    if (!k) return null;
    const y = +k.slice(0, 4);
    const table = holidayCache[y] || (holidayCache[y] = buildHolidays(y));
    return table[k] || null;
  }

  /** 祝日か (rules.extraHolidays = ['YYYY-MM-DD' | {date, name}] も祝日扱い) */
  function isJapaneseHoliday(ymd, rules) {
    const k = normYmd(ymd);
    if (!k) return false;
    if (holidayName(k)) return true;
    const extra = (rules || DEFAULT_RULES).extraHolidays;
    if (!Array.isArray(extra)) return false;
    return extra.some(function (e) {
      const d = typeof e === 'string' ? e : (e && (e.date || e.ymd));
      return d === k;
    });
  }

  // ===================================================================
  // 繁忙期 (MM-DD の範囲。from > to は年またぎ)
  // ===================================================================
  function normMd(v) {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
    return m ? pad2(+m[1]) + '-' + pad2(+m[2]) : null;
  }
  function busyPeriodOf(ymd, R) {
    const md = ymd.slice(5);
    const list = Array.isArray(R.busyPeriods) ? R.busyPeriods : [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const from = p && normMd(p.from), to = p && normMd(p.to);
      if (!from || !to) continue;
      const inside = from <= to ? (md >= from && md <= to) : (md >= from || md <= to);
      if (inside) return p;
    }
    return null;
  }

  // ===================================================================
  // 見積
  // ===================================================================
  /**
   * @param {object} input {asset, start, end, options, discountType, coupon, rules}
   * @returns {object} Quote {ok, errors, hours, days, plan, lines:[{code,label,amount}], base,
   *                          subtotal, discount, couponDiscount, total, busy, rulesVersion}
   *   errors: INVALID_PERIOD (期間不正) / INVALID_ASSET (車両・料金なし) / OPTION_CONFLICT (同じ補償の重複) /
   *           OPTION_NOT_APPLICABLE (この車両に付けられないオプション) / DISCOUNT_NOT_APPLICABLE (割引の条件外)
   */
  function quote(input) {
    input = input || {};
    const R = mergeRules(input.rules);
    const errors = [];
    const result = {
      ok: false, errors: errors,
      hours: 0, days: 0, plan: null,
      lines: [],
      base: 0, subtotal: 0, discount: 0, couponDiscount: 0, total: 0,
      busy: false, rulesVersion: R.version != null ? R.version : null
    };

    const asset = input.asset || null;
    const pH = positive(pick(asset, 'priceHour', 'price_hour'));
    const pD = positive(pick(asset, 'priceDay', 'price_day'));
    const catIdRaw = pick(asset, 'categoryId', 'category_id');
    const catId = catIdRaw != null ? String(catIdRaw) : null;
    const startMs = toMs(input.start), endMs = toMs(input.end);

    if (!asset || (pH == null && pD == null)) errors.push('INVALID_ASSET');
    if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) errors.push('INVALID_PERIOD');
    if (errors.length) return result;

    const lines = result.lines;
    const h = hoursBetween(startMs, endMs);
    const n = Math.floor(h / 24);   // 24時間の単位数
    const r = h % 24;               // 端数の時間

    // 1. 基本料金
    let base, plan;
    if (h < 24) {
      const hourly = pH != null ? h * pH : null;
      if (hourly != null && (pD == null || hourly < pD)) {
        base = hourly; plan = 'hourly';
        lines.push({ code: 'base', label: '基本料金 (' + h + '時間)', amount: base });
      } else {
        base = pD; plan = 'daily';
        lines.push({ code: 'base', label: '基本料金 (24時間料金)', amount: base });
      }
    } else {
      plan = 'daily';
      const dayUnit = pD != null ? pD : 24 * pH;
      const extHourly = pH != null ? r * pH : null;
      const ext = r === 0 ? 0 : (extHourly != null ? Math.min(extHourly, dayUnit) : dayUnit);
      base = n * dayUnit + ext;
      lines.push({ code: 'base', label: '基本料金 (24時間 × ' + n + ')', amount: n * dayUnit });
      if (r > 0) {
        const capped = extHourly == null || extHourly > dayUnit;
        lines.push({ code: 'extension', label: '延長料金 (' + r + '時間' + (capped ? '・24時間料金' : '') + ')', amount: ext });
      }
    }
    result.base = base;

    // 2. オプション
    const shortMax = num(R.shortHoursMax) != null ? num(R.shortHoursMax) : 0;
    const seen = {}, groups = {};
    (Array.isArray(input.options) ? input.options : []).forEach(function (o) {
      if (!o) return;
      const idRaw = pick(o, 'id', 'optionId');
      const id = idRaw != null ? String(idRaw) : null;
      if (id != null) {
        if (seen[id]) return; // 同じオプションの重複指定は1つとして扱う
        seen[id] = true;
      }
      const cats = pick(o, 'categoryIds', 'category_ids');
      if (catId != null && Array.isArray(cats) && cats.length && cats.map(String).indexOf(catId) < 0) {
        pushUnique(errors, 'OPTION_NOT_APPLICABLE');
      }
      const group = pick(o, 'exclusiveGroup', 'exclusive_group');
      if (group) {
        groups[group] = (groups[group] || 0) + 1;
        if (groups[group] >= 2) pushUnique(errors, 'OPTION_CONFLICT');
      }
      const name = String(o.name || 'オプション');
      const price = Math.max(0, num(o.price) || 0);
      const priceShort = num(pick(o, 'priceShort', 'price_short'));
      let amount, label;
      if (pick(o, 'priceType', 'price_type') === 'per_rental') {
        amount = price;
        label = name + ' (1回)';
      } else {
        const useShort = r > 0 && r <= shortMax && priceShort != null;
        amount = n * price + (r === 0 ? 0 : (useShort ? priceShort : price));
        if (n === 0) label = name + (useShort ? ' (' + h + '時間・短時間料金)' : ' (24時間まで)');
        else label = name + ' (24時間 × ' + n + (r > 0 ? ' + ' + r + '時間' + (useShort ? '・短時間料金' : '') : '') + ')';
      }
      lines.push({ code: 'option', optionId: id, label: label, amount: amount });
    });

    // 3・4. 繁忙期割増 / 土日祝割増 (利用期間が触れる暦日 = 開始日〜終了時刻の1ms前の日)
    //   367日あれば全ての月日と曜日を一巡するので、それ以上は調べない
    const d0 = dayIndex(startMs), d1 = Math.min(dayIndex(endMs - 1), d0 + 366);
    let busyPeriod = null, weekend = false;
    for (let i = d0; i <= d1 && !(busyPeriod && weekend); i++) {
      const ymd = ymdOfIndex(i);
      if (!busyPeriod) busyPeriod = busyPeriodOf(ymd, R);
      if (!weekend) {
        const dow = dowOfIndex(i);
        weekend = dow === 0 || dow === 6 || isJapaneseHoliday(ymd, R);
      }
    }
    result.busy = !!busyPeriod;
    const busyFee = Math.max(0, num(R.busyFee) || 0);
    const weekendFee = Math.max(0, num(R.weekendHolidayFee) || 0);
    if (busyPeriod) {
      if (busyFee > 0) lines.push({ code: 'busy', label: '繁忙期割増' + (busyPeriod.name ? ' (' + busyPeriod.name + ')' : ''), amount: busyFee });
    } else if (weekend && weekendFee > 0) {
      lines.push({ code: 'weekend', label: '土日祝割増', amount: weekendFee }); // 繁忙期のときは付けない
    }

    // 5. 夜間料金 (貸出・返却の時刻それぞれ)
    const ns = num(R.nightStartHour), ne = num(R.nightEndHour);
    function isNight(hh) {
      if (ns == null || ne == null) return false;
      return ns > ne ? (hh >= ns || hh < ne) : (hh >= ns && hh < ne);
    }
    const nightPickup = isNight(jstParts(startMs).hh);
    const nightReturn = isNight(jstParts(endMs).hh);
    const nightCount = (nightPickup ? 1 : 0) + (nightReturn ? 1 : 0);
    const nightFee = Math.max(0, num(R.nightFee) || 0);
    if (nightCount && nightFee > 0) {
      const when = nightCount === 2 ? '貸出・返却 2回' : (nightPickup ? '貸出時' : '返却時');
      lines.push({ code: 'night', label: '夜間料金 (' + when + ')', amount: nightFee * nightCount });
    }

    const subtotal = lines.reduce(function (s, l) { return s + l.amount; }, 0);

    // 6. 割引 (1つだけ。基本料金から)
    let discount = 0;
    const type = input.discountType;
    if (type) {
      const discounts = R.discounts || {};
      const d = Object.prototype.hasOwnProperty.call(discounts, type) ? discounts[type] : null;
      const minHours = d ? (num(d.minHours) || 0) : 0;
      const cats = d && Array.isArray(d.categoryIds) && d.categoryIds.length ? d.categoryIds.map(String) : null;
      const applicable = !!d && h >= minHours && (!cats || (catId != null && cats.indexOf(catId) >= 0));
      if (!applicable) {
        pushUnique(errors, 'DISCOUNT_NOT_APPLICABLE');
      } else {
        discount = Math.min(Math.max(0, Math.floor(num(d.amount) || 0)), base);
        if (discount > 0) lines.push({ code: 'discount', label: d.label || '割引', amount: -discount });
      }
    }

    // 7. クーポン (0円未満にしない)
    let couponDiscount = 0;
    const coupon = input.coupon;
    const couponAmount = coupon ? Math.floor(num(coupon.amount) || 0) : 0;
    if (couponAmount > 0) {
      couponDiscount = Math.max(0, Math.min(couponAmount, subtotal - discount));
      if (couponDiscount > 0) lines.push({ code: 'coupon', label: 'クーポン割引', amount: -couponDiscount });
    }

    // 8. 合計
    result.hours = h;
    result.days = Math.ceil(h / 24);
    result.plan = plan;
    result.subtotal = subtotal;
    result.discount = discount;
    result.couponDiscount = couponDiscount;
    result.total = subtotal - discount - couponDiscount;
    result.ok = errors.length === 0;
    return result;
  }

  // ===================================================================
  // キャンセル料
  // ===================================================================
  function whenLabel(daysBefore) {
    if (daysBefore <= 0) return '当日';
    if (daysBefore === 1) return '前日';
    if (daysBefore === 2) return '前々日';
    return daysBefore + '日前';
  }

  /**
   * @param {object} input {asset, category:{id}, start, cancelAt, base, noShow?, rules}
   * @returns {object} Fee {cls, busy, daysBefore, pct, fee, label}
   *   daysBefore = 貸出日 − 取消日 (日本時間の暦日差。当日 0 / 前日 1 / 前々日 2。貸出日を過ぎていれば負)
   */
  function cancellationFee(input) {
    input = input || {};
    const R = mergeRules(input.rules);
    const C = R.cancellation || {};
    const asset = input.asset || {};
    const category = input.category || null;
    const catRaw = category ? pick(category, 'id', 'categoryId') : pick(asset, 'categoryId', 'category_id');
    const catId = catRaw != null ? String(catRaw) : null;
    const fields = pick(asset, 'customFields', 'custom_fields') || {};
    const cls = (C.categoryClass && catId != null && C.categoryClass[catId]) ||
      (C.classOf && fields.bodyType != null && C.classOf[fields.bodyType]) || 'compact';

    const startMs = toMs(input.start), cancelMs = toMs(input.cancelAt);
    if (!isFinite(startMs) || !isFinite(cancelMs)) {
      throw new RangeError('cancellationFee: start と cancelAt には有効な日時を指定してください');
    }
    const startDay = dayIndex(startMs);
    const daysBefore = startDay - dayIndex(cancelMs);
    const busy = !!busyPeriodOf(ymdOfIndex(startDay), R);

    const tiers = (((C[busy ? 'busy' : 'normal'] || {})[cls]) || []).slice()
      .sort(function (a, b) { return (num(b.minDays) || 0) - (num(a.minDays) || 0); });
    const d = Math.max(0, daysBefore);
    let tier = null;
    for (let i = 0; i < tiers.length; i++) {
      if (d >= (num(tiers[i].minDays) || 0)) { tier = tiers[i]; break; }
    }
    if (!tier && tiers.length) tier = tiers[tiers.length - 1];

    let pct, label;
    if (input.noShow) {
      pct = num(C.noShowPct) != null ? num(C.noShowPct) : 100;
      label = '無断キャンセル (' + pct + '%)';
    } else {
      pct = tier ? (num(tier.pct) || 0) : 0;
      if (pct === 0) {
        const minDays = tier ? (num(tier.minDays) || 0) : 0;
        label = minDays > 0 ? minDays + '日前までは無料' : '無料';
      } else {
        label = whenLabel(d) + ' (' + pct + '%)';
      }
    }
    const base = Math.max(0, num(input.base) || 0);
    return {
      cls: cls, busy: busy, daysBefore: daysBefore, pct: pct,
      fee: Math.floor(base * pct / 100),
      label: label
    };
  }

  // 画面の <input type="datetime-local"> の値 ('YYYY-MM-DDTHH:MM') は、端末のタイムゾーンに関係なく
  // 日本時間として扱う (貸出・返却は北海道の店舗で行うため)。
  function fromJstInput(v) {
    const ms = toMs(v);
    return isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  function toJstInput(v) {
    const ms = toMs(v);
    if (!isFinite(ms)) return '';
    const p = jstParts(ms);
    const z = n => String(n).padStart(2, '0');
    return p.y + '-' + z(p.m) + '-' + z(p.d) + 'T' + z(p.hh) + ':' + z(p.mm);
  }

  root.SkyRentPricingCore = {
    DEFAULT_RULES: DEFAULT_RULES,
    quote: quote,
    cancellationFee: cancellationFee,
    isJapaneseHoliday: isJapaneseHoliday,
    holidayName: holidayName,
    jstParts: jstParts,
    hoursBetween: hoursBetween,
    toMs: toMs,
    fromJstInput: fromJstInput,
    toJstInput: toJstInput
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
