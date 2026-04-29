/**
 * Sky Rent - API クライアント
 * GAS Web App と通信する薄いラッパー。
 */
(function () {
  const config = window.SKY_RENT_CONFIG || {};
  const GAS_URL = config.GAS_URL;
  const isConfigured = GAS_URL && GAS_URL.indexOf('REPLACE_ME') === -1;

  // ===== モックデータ (GAS未設定時のみ使用) =====
  const MOCK_VEHICLES = [
    { vehicleId: 'V001', name: 'コンパクト (ヴィッツ等)', class: 'コンパクト', capacity: 5, pricePerDay: 5500 },
    { vehicleId: 'V002', name: 'ミドル (カローラ等)',     class: 'ミドル',     capacity: 5, pricePerDay: 7700 },
    { vehicleId: 'V003', name: 'ミニバン (ノア等)',       class: 'ミニバン',   capacity: 7, pricePerDay: 11000 },
    { vehicleId: 'V004', name: 'SUV (ハリアー等)',        class: 'SUV',        capacity: 5, pricePerDay: 13200 }
  ];

  async function get(action, params) {
    if (!isConfigured) {
      if (!config.USE_MOCK_WHEN_NO_URL) throw new Error('GAS_URL が設定されていません');
      return mockGet(action, params);
    }
    const url = new URL(GAS_URL);
    url.searchParams.set('action', action);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { method: 'GET' });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '通信エラー');
    return json.data;
  }

  async function post(body) {
    if (!isConfigured) {
      if (!config.USE_MOCK_WHEN_NO_URL) throw new Error('GAS_URL が設定されていません');
      return mockPost(body);
    }
    // GAS の doPost は CORS の関係で text/plain で送るのが安定
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '通信エラー');
    return json.data;
  }

  function mockGet(action, params) {
    return new Promise(resolve => setTimeout(() => {
      if (action === 'vehicles') {
        resolve(MOCK_VEHICLES);
      } else if (action === 'availability') {
        // ダミー: V003 だけ常に塞がっている扱い
        resolve(MOCK_VEHICLES.map(v => v.vehicleId === 'V003'
          ? { vehicleId: v.vehicleId, available: false, conflictReason: '【DEMO】Googleカレンダーの予定と重複' }
          : { vehicleId: v.vehicleId, available: true }));
      } else if (action === 'dashboard') {
        const today = (params && params.date) || new Date().toISOString().slice(0,10);
        const weekly = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(today); d.setDate(d.getDate() - i);
          weekly.push({
            date: (d.getMonth()+1) + '/' + d.getDate(),
            count: i === 1 ? 1 : i === 3 ? 3 : i === 0 ? 8 : 0
          });
        }
        resolve({
          date: today,
          bookings: [],
          departures: [{
            reservationId: 'DEMO001',
            vehicleId: 'V003',
            vehicleName: 'ジムニー クロスアドベンチャー',
            customerName: '伊藤',
            start: today + 'T09:00:00+09:00',
            end: today + 'T18:00:00+09:00',
            status: 'confirmed'
          }],
          returns: [],
          weekly,
          shaken: []
        });
      } else if (action === 'reservations') {
        resolve([
          {
            reservationId: 'DEMO001', vehicleId: 'V003',
            vehicleName: 'ジムニー クロスアドベンチャー',
            customerName: '伊藤', customerEmail: 'ito@example.com', customerPhone: '090-1111-2222',
            start: new Date().toISOString(), end: new Date(Date.now()+86400000).toISOString(),
            status: 'confirmed', note: '', createdAt: new Date().toISOString()
          },
          {
            reservationId: 'DEMO002', vehicleId: 'V001',
            vehicleName: 'コンパクト (ヴィッツ等)',
            customerName: '佐藤', customerEmail: 'sato@example.com', customerPhone: '090-3333-4444',
            start: new Date(Date.now()+3*86400000).toISOString(), end: new Date(Date.now()+5*86400000).toISOString(),
            status: 'confirmed', note: 'チャイルドシート希望', createdAt: new Date().toISOString()
          }
        ]);
      } else if (action === 'customers') {
        resolve([
          { name: '伊藤', email: 'ito@example.com', phone: '090-1111-2222', reservationCount: 1, latestReservation: new Date().toISOString() },
          { name: '佐藤', email: 'sato@example.com', phone: '090-3333-4444', reservationCount: 1, latestReservation: new Date().toISOString() }
        ]);
      } else if (action === 'revenue') {
        const out = [];
        for (let i = 11; i >= 0; i--) {
          const d = new Date(); d.setMonth(d.getMonth() - i);
          out.push({
            year: d.getFullYear(), month: d.getMonth()+1,
            label: d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0'),
            count: Math.floor(Math.random()*15) + 5,
            total: Math.floor(Math.random()*500000) + 100000
          });
        }
        resolve(out);
      } else {
        resolve([]);
      }
    }, 400));
  }

  function mockPost(body) {
    return new Promise(resolve => setTimeout(() => {
      const v = MOCK_VEHICLES.find(x => x.vehicleId === body.vehicleId);
      resolve({
        reservationId: 'DEMO' + Date.now(),
        vehicleName: (v && v.name) || body.vehicleId,
        start: body.start,
        end: body.end,
        calendarEventId: 'mock-event'
      });
    }, 600));
  }

  // 公開
  window.SkyRentAPI = {
    isConfigured,
    listVehicles: () => get('vehicles'),
    checkAvailability: (start, end) => get('availability', { start, end }),
    createReservation: (payload) => post(payload),
    // 管理画面向け
    getDashboard: (date) => get('dashboard', date ? { date } : {}),
    listReservations: (from, to) => get('reservations', { from: from || '', to: to || '' }),
    listCustomers: () => get('customers'),
    getRevenue: (year, month) => get('revenue', year && month ? { year, month } : {})
  };
})();
