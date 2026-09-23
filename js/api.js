/**
 * グロースレンタカー - API クライアント
 *
 * 画面向けの参照・集計ヘルパー。データは js/store.js (SkyRentStore) から読む。
 *   デモモード … store は localStorage
 *   本番モード … store は js/backend.js がサーバー (Supabase) から読み込んだメモリ上のデータ。
 *                予約の確定・見積・問い合わせなどサーバー処理は SkyRentBackend を使う。
 *
 * 旧管理画面との互換のため、旧フィールド名 (vehicleId / vehicleName /
 * pricePerDay / class) のエイリアスを返す。
 */
(function () {
  'use strict';
  const config = window.SKY_RENT_CONFIG || {};
  // 本番 (Supabase) に接続しているか
  const isConfigured = !!(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
  const S = window.SkyRentStore;

  // アセット → 旧フィールド互換形
  function legacyAsset(a) {
    const cat = S.getCategory(a.categoryId);
    return Object.assign({}, a, {
      vehicleId: a.assetId,
      class: cat ? cat.name : '',
      categoryName: cat ? cat.name : '',
      categoryType: cat ? cat.type : 'vehicle',
      pricePerDay: a.priceDay
    });
  }

  function delay(val, ms) {
    return new Promise(resolve => setTimeout(() => resolve(val), ms == null ? 120 : ms));
  }

  // ===== 日時 (日本時間) =====
  // 集計の「今日」「今月」「日付」は、端末のタイムゾーンに関係なく日本時間で数える (店舗は北海道)。
  // new Date('YYYY-MM-DDT00:00:00') や setHours / getMonth は端末の時刻で解釈されるので使わない。
  // 解釈は料金計算と同じ SkyRentPricingCore.toMs / jstParts、画面の入力形式は SkyRentBackend.jst に任せる
  // (このファイルは backend.js より先に読み込まれるので、呼ばれた時点で探す)。
  const DAY = 86400000;
  const JST_OFFSET = 9 * 3600000;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 日時 (ISO / 'YYYY-MM-DD' / 'YYYY-MM-DDTHH:MM' (日本時間) / Date / ミリ秒) → エポックミリ秒。不正なら NaN
  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string' || !v.trim()) return NaN;
    const core = window.SkyRentPricingCore;
    if (core && typeof core.toMs === 'function') {
      const t = core.toMs(v.trim());
      if (isFinite(t)) return t;
    }
    // 'YYYY/M/D H:MM' など ISO 以外の書き方
    const B = window.SkyRentBackend;
    if (B && B.jst && typeof B.jst.fromInput === 'function') {
      const iso = B.jst.fromInput(v);
      return iso ? Date.parse(iso) : NaN;
    }
    // 料金エンジンも backend も無いときの代替 (タイムゾーン表記なし = 日本時間)
    const s = v.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - JST_OFFSET;
    return Date.parse(s);  // タイムゾーン付きの文字列
  }
  // 日本時間の暦日 {y, m, d, ymd}。不正なら null
  function jstParts(v) {
    const t = toMs(v);
    if (!isFinite(t)) return null;
    const core = window.SkyRentPricingCore;
    if (core && typeof core.jstParts === 'function') {
      const p = core.jstParts(t);
      if (p) return p;
    }
    const d = new Date(t + JST_OFFSET);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    return { y: y, m: m, d: dd, ymd: y + '-' + pad2(m) + '-' + pad2(dd) };
  }
  // 日本時間の年月日 → その日の 0:00 (日本時間) のミリ秒。月日のあふれは繰り上げ・繰り下げる
  function jstDayStart(y, m, d) { return Date.UTC(y, m - 1, d) - JST_OFFSET; }
  // 'YYYY-MM-DD' (日本時間の日付) → その日の 0:00 のミリ秒。日付以外の日時はその日 (日本時間) の 0:00
  function dayStartOf(v) {
    const p = jstParts(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() + 'T00:00' : v);
    return p ? jstDayStart(p.y, p.m, p.d) : NaN;
  }
  // 今日 (日本時間) 'YYYY-MM-DD'
  function todayYmd(now) { return jstParts(now).ymd; }
  // 日本時間 'YYYY/MM/DD'
  function fmtDate(v) {
    const p = jstParts(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() + 'T00:00' : v);
    return p ? p.y + '/' + pad2(p.m) + '/' + pad2(p.d) : '';
  }
  // ダッシュボードの出発・帰着・未処理に数えない状態 (キャンセル・無断キャンセル)
  function isInactive(r) { return r.status === 'cancelled' || r.status === 'no_show'; }

  // ===== 公開 API =====
  const api = {
    isConfigured: isConfigured,

    // ---- 参照系 ----
    listCategories: () => delay(S.categories()),
    listLocations: () => delay(S.locations()),
    listVehicles: (filter) => delay(S.assets(Object.assign({ activeOnly: true }, filter || {})).map(legacyAsset)),
    listAssets: (filter) => delay(S.assets(filter || {}).map(legacyAsset)),
    getAsset: (id) => delay(legacyAsset(S.getAsset(id) || {})),
    listOptions: (categoryId) => delay(S.optionsForCategory(categoryId)),

    // ---- 検索・空き状況 ----
    search: (params) => delay(S.searchAvailable(params).map(a => Object.assign(legacyAsset(a), { availability: a.availability }))),
    checkAvailability: (start, end) => delay(
      S.assets({ activeOnly: true }).map(a => {
        const av = S.availability(a.assetId, start, end, 1);
        return {
          vehicleId: a.assetId, assetId: a.assetId,
          available: av.ok, remaining: av.remaining, stock: av.stock,
          conflictReason: av.ok ? '' : av.reason
        };
      })
    ),

    // ---- 予約 ----
    createReservation: (payload) => {
      try {
        const r = S.createReservation(payload);
        return delay({
          reservationId: r.reservationId,
          vehicleName: r.assetName, assetName: r.assetName,
          start: r.start, end: r.end,
          total: r.price.total,
          calendarEventId: isConfigured ? null : 'local-demo'
        }, 300);
      } catch (e) { return Promise.reject(e); }
    },
    listReservations: (from, to) => {
      let arr = S.list('reservations').slice();
      const f = from ? toMs(from) : NaN, t = to ? toMs(to) : NaN;
      if (isFinite(f)) arr = arr.filter(r => toMs(r.end) >= f);
      if (isFinite(t)) arr = arr.filter(r => toMs(r.start) <= t);
      arr.sort((a, b) => (toMs(b.start) || 0) - (toMs(a.start) || 0));
      return delay(arr);
    },
    updateReservation: (id, updates) => delay(S.updateReservation(id, updates)),

    // ---- ダッシュボード ----
    // dateStr: 'YYYY-MM-DD' (日本時間の日付。省略時は今日)。「今月」の売上・車検の残り日数は今日 (日本時間) 基準
    getDashboard: (dateStr, locationId) => {
      const now = Date.now();
      const given = dateStr ? jstParts(/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).trim()) ? String(dateStr).trim() + 'T00:00' : dateStr) : null;
      const today = given ? given.ymd : todayYmd(now);
      const target = dayStartOf(today);           // その日の 0:00 (日本時間)
      const dayEnd = target + DAY;                // 翌日の 0:00 (含まない)
      let reservations = S.list('reservations');
      if (locationId) reservations = reservations.filter(r => r.locationId === locationId);

      const inRange = (d, from, to) => { const x = toMs(d); return x >= from && x < to; };
      const inDay = d => inRange(d, target, dayEnd);
      const active = reservations.filter(r => !isInactive(r));

      // 過去1週間の新規予約数 (日本時間の日ごと)
      const weekly = [];
      for (let i = 6; i >= 0; i--) {
        const d = target - i * DAY;
        const p = jstParts(d);
        const cnt = reservations.filter(r => inRange(r.createdAt || r.start, d, d + DAY)).length;
        weekly.push({ date: p.m + '/' + p.d, count: cnt });
      }

      // 拠点別サマリー
      const byLocation = S.locations().map(loc => {
        const rs = active.filter(r => r.locationId === loc.locationId);
        return {
          locationId: loc.locationId, name: loc.name,
          departures: rs.filter(r => inDay(r.start)).length,
          returns: rs.filter(r => inDay(r.end)).length,
          inUse: rs.filter(r => r.status === 'in_use').length
        };
      });

      // 未処理: 出発時刻を過ぎたのに確定のまま / 返却予定を過ぎたのに貸出中のまま
      const unprocessed = active.filter(r =>
        (r.status === 'confirmed' && toMs(r.start) < now) ||
        (r.status === 'in_use' && toMs(r.end) < now)
      );

      // 売上サマリー (今月 (日本時間)・返却済/貸出中ベース)
      const tp = jstParts(now);
      const monthStart = jstDayStart(tp.y, tp.m, 1);
      const monthEnd = jstDayStart(tp.y, tp.m + 1, 1);
      const salesMonth = active
        .filter(r => (r.status === 'returned' || r.status === 'in_use') && inRange(r.start, monthStart, monthEnd))
        .reduce((s, r) => s + ((r.price && r.price.total) || 0), 0);

      // 車検アラート (90日以内・車両のみ)。残り日数 = 車検満了日 − 今日 (日本時間の暦日)
      const todayStart = dayStartOf(todayYmd(now));
      const shaken = S.assets({ activeOnly: true }).filter(a => a.shakenDate).map(a => {
        const expire = dayStartOf(a.shakenDate);
        if (!isFinite(expire)) return null;
        const daysLeft = Math.round((expire - todayStart) / DAY);
        return { expireDate: fmtDate(a.shakenDate), vehicleName: a.name, plate: a.plate || '', daysLeft: daysLeft };
      }).filter(x => x && x.daysLeft <= 90).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 5);

      return delay({
        date: today,
        bookings: reservations.filter(r => inDay(r.createdAt || r.start)),
        departures: active.filter(r => inDay(r.start)),
        returns: active.filter(r => inDay(r.end)),
        weekly: weekly,
        byLocation: byLocation,
        unprocessed: unprocessed,
        salesMonth: salesMonth,
        shaken: shaken,
        notifications: S.notifications().slice(0, 6)
      });
    },

    // ---- 顧客 (予約由来・旧互換) ----
    listCustomers: () => {
      const map = new Map();
      S.list('reservations').forEach(r => {
        const key = (r.customerEmail || r.customerName || '').toLowerCase();
        if (!key) return;
        if (!map.has(key)) {
          map.set(key, { name: r.customerName, email: r.customerEmail, phone: r.customerPhone, reservationCount: 0, latestReservation: r.start });
        }
        const c = map.get(key);
        c.reservationCount++;
        if (toMs(r.start) > toMs(c.latestReservation)) c.latestReservation = r.start;
      });
      return delay(Array.from(map.values()).sort((a, b) => (toMs(b.latestReservation) || 0) - (toMs(a.latestReservation) || 0)));
    },

    // ---- 売上集計 (12ヶ月・日本時間の月ごと・貸出開始日で集計) ----
    getRevenue: () => {
      const tp = jstParts(Date.now());
      const out = [];
      const reservations = S.list('reservations');
      for (let i = 11; i >= 0; i--) {
        const start = jstDayStart(tp.y, tp.m - i, 1);
        const end = jstDayStart(tp.y, tp.m - i + 1, 1);
        const p = jstParts(start);
        let total = 0, count = 0;
        reservations.forEach(r => {
          if (r.status === 'cancelled') return;
          const s = toMs(r.start);
          if (!(s >= start && s < end)) return;
          total += (r.price && r.price.total) || 0;
          count++;
        });
        out.push({ year: p.y, month: p.m, label: p.y + '/' + pad2(p.m), count: count, total: total });
      }
      return delay(out);
    }
  };

  window.SkyRentAPI = api;
})();
