/**
 * グロースレンタカー - API クライアント
 *
 * データアクセスの唯一の入口。現在は js/store.js (localStorage) に委譲。
 * 本番バックエンド (GAS / AWS 等) 接続時は、GAS_URL を設定すると
 * fetch ベースの実装へ切替できる抽象化層 (決済・メール送信の拡張ポイント込み)。
 *
 * 旧管理画面との互換のため、旧フィールド名 (vehicleId / vehicleName /
 * pricePerDay / class) のエイリアスを返す。
 */
(function () {
  'use strict';
  const config = window.SKY_RENT_CONFIG || {};
  const GAS_URL = config.GAS_URL;
  const isConfigured = !!(GAS_URL && GAS_URL.indexOf('REPLACE_ME') === -1);
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
      if (from) arr = arr.filter(r => new Date(r.end) >= new Date(from));
      if (to) arr = arr.filter(r => new Date(r.start) <= new Date(to));
      arr.sort((a, b) => new Date(b.start) - new Date(a.start));
      return delay(arr);
    },
    updateReservation: (id, updates) => delay(S.updateReservation(id, updates)),

    // ---- ダッシュボード ----
    getDashboard: (dateStr, locationId) => {
      const today = dateStr || new Date().toISOString().slice(0, 10);
      const target = new Date(today + 'T00:00:00');
      const dayEnd = new Date(target); dayEnd.setHours(23, 59, 59, 999);
      let reservations = S.list('reservations');
      if (locationId) reservations = reservations.filter(r => r.locationId === locationId);

      const inDay = (d) => { const x = new Date(d); return x >= target && x <= dayEnd; };
      const active = reservations.filter(r => r.status !== 'cancelled');

      // 過去1週間の新規予約数
      const weekly = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(target); d.setDate(target.getDate() - i);
        const dEnd = new Date(d); dEnd.setHours(23, 59, 59, 999);
        const cnt = reservations.filter(r => { const c = new Date(r.createdAt || r.start); return c >= d && c <= dEnd; }).length;
        weekly.push({ date: (d.getMonth() + 1) + '/' + d.getDate(), count: cnt });
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

      // 未処理: 本日出発なのに確定のまま / 返却予定日超過で貸出中のまま
      const now = new Date();
      const unprocessed = active.filter(r =>
        (r.status === 'confirmed' && new Date(r.start) < now) ||
        (r.status === 'in_use' && new Date(r.end) < now)
      );

      // 売上サマリー (当月・返却済/貸出中ベース)
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const salesMonth = active
        .filter(r => (r.status === 'returned' || r.status === 'in_use') && new Date(r.start) >= monthStart)
        .reduce((s, r) => s + ((r.price && r.price.total) || 0), 0);

      // 車検アラート (90日以内・車両のみ)
      const shaken = S.assets({ activeOnly: true }).filter(a => a.shakenDate).map(a => {
        const daysLeft = Math.ceil((new Date(a.shakenDate) - now) / 86400000);
        return { expireDate: fmtDate(a.shakenDate), vehicleName: a.name, plate: a.plate || '', daysLeft: daysLeft };
      }).filter(x => x.daysLeft <= 90).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 5);

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
        if (new Date(r.start) > new Date(c.latestReservation)) c.latestReservation = r.start;
      });
      return delay(Array.from(map.values()).sort((a, b) => new Date(b.latestReservation) - new Date(a.latestReservation)));
    },

    // ---- 売上集計 (12ヶ月) ----
    getRevenue: () => {
      const now = new Date();
      const out = [];
      const reservations = S.list('reservations');
      for (let i = 11; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        let total = 0, count = 0;
        reservations.forEach(r => {
          if (r.status === 'cancelled') return;
          const s = new Date(r.start);
          if (s < start || s >= end) return;
          total += (r.price && r.price.total) || 0;
          count++;
        });
        out.push({ year: start.getFullYear(), month: start.getMonth() + 1, label: start.getFullYear() + '/' + String(start.getMonth() + 1).padStart(2, '0'), count: count, total: total });
      }
      return delay(out);
    }
  };

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  }

  window.SkyRentAPI = api;
})();
