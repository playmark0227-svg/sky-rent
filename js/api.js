/**
 * Sky Rent - API クライアント
 * GAS Web App と通信する薄いラッパー。
 */
(function () {
  const config = window.SKY_RENT_CONFIG || {};
  const GAS_URL = config.GAS_URL;
  const isConfigured = GAS_URL && GAS_URL.indexOf('REPLACE_ME') === -1;

  // ===== モックデータ (GAS未設定時は localStorage を使用) =====
  const VEHICLE_DEFAULTS = [
    { vehicleId: 'V001', name: 'コンパクト (ヴィッツ等)', class: 'コンパクト', plate: '札幌 500 あ 1234', capacity: 5, pricePerDay: 5500,  active: true },
    { vehicleId: 'V002', name: 'ミドル (カローラ等)',     class: 'ミドル',     plate: '札幌 500 あ 5678', capacity: 5, pricePerDay: 7700,  active: true },
    { vehicleId: 'V003', name: 'ミニバン (ノア等)',       class: 'ミニバン',   plate: '札幌 500 あ 9012', capacity: 7, pricePerDay: 11000, active: true },
    { vehicleId: 'V004', name: 'SUV (ハリアー等)',        class: 'SUV',        plate: '札幌 500 あ 3456', capacity: 5, pricePerDay: 13200, active: true },
    { vehicleId: 'V005', name: '軽自動車 (N-BOX等)',      class: '軽自動車',   plate: '札幌 580 か 7788', capacity: 4, pricePerDay: 4400,  active: true },
    { vehicleId: 'V006', name: 'ワゴン (セレナ等)',       class: 'ミニバン',   plate: '札幌 500 さ 2233', capacity: 8, pricePerDay: 12100, active: true },
    { vehicleId: 'V007', name: 'バン (ハイエース等)',     class: 'バン',       plate: '札幌 400 す 4455', capacity: 6, pricePerDay: 14300, active: true },
    { vehicleId: 'V008', name: '高級セダン (クラウン等)', class: 'ミドル',     plate: '札幌 300 た 6677', capacity: 5, pricePerDay: 16500, active: true }
  ];

  // localStorage の車両マスタを取得 (なければ既定値を投入)
  function localVehicles() {
    const raw = localStorage.getItem('sky-rent.vehicles');
    if (raw == null) {
      localStorage.setItem('sky-rent.vehicles', JSON.stringify(VEHICLE_DEFAULTS));
      return VEHICLE_DEFAULTS.slice();
    }
    try { return JSON.parse(raw); } catch (e) { return VEHICLE_DEFAULTS.slice(); }
  }
  // localStorage の予約台帳
  function localReservations() {
    const raw = localStorage.getItem('sky-rent.reservations');
    if (raw == null) {
      const seed = buildSeedReservations();
      localStorage.setItem('sky-rent.reservations', JSON.stringify(seed));
      return seed;
    }
    try { return JSON.parse(raw); } catch (e) { return []; }
  }

  // 「今日」を基準に時系列へ分散したデモ予約を生成
  // (過去/本日/未来にまたがり、ダッシュボード・ガント・稼働率・売上が動いて見えるようにする)
  function buildSeedReservations() {
    const nameById = {};
    VEHICLE_DEFAULTS.forEach(v => { nameById[v.vehicleId] = v.name; });
    const DAY = 86400000;
    // 指定オフセット日の 時:分 の ISO 文字列
    const at = (offsetDays, hour) => {
      const d = new Date();
      d.setHours(hour, 0, 0, 0);
      d.setDate(d.getDate() + offsetDays);
      return d.toISOString();
    };
    // [開始オフセット, 日数, 車輌, 氏名, メール, 電話, 状態, 備考, 登録オフセット]
    const rows = [
      [-20, 3, 'V004', '田中 健一',   'tanaka@example.com',  '090-1010-2020', 'confirmed', '',                  -22],
      [-15, 2, 'V001', '鈴木 美咲',   'suzuki@example.com',  '080-2233-4455', 'cancelled', 'お客様都合キャンセル', -17],
      [ -9, 4, 'V003', '高橋 大輔',   'takahashi@example.com','090-3344-5566', 'confirmed', '禁煙車希望',         -10],
      [ -6, 2, 'V007', '山本工務店',   'yamamoto-k@example.com','011-555-6677', 'confirmed', '社用・資材運搬',      -6],
      [ -4, 2, 'V002', '伊藤 翔太',   'ito-s@example.com',   '070-6677-8899', 'confirmed', '',                   -5],
      [ -2, 2, 'V008', '中村 由美',   'nakamura@example.com','090-7788-9900', 'confirmed', '空港送迎',            -3],
      [ -1, 2, 'V006', '小林 様',     'kobayashi@example.com','080-8899-0011', 'confirmed', 'チャイルドシート×2',  -2],
      [  0, 1, 'V003', '加藤 健',     'kato@example.com',    '090-1212-3434', 'confirmed', '',                   -1],
      [  0, 3, 'V001', '吉田 直樹',   'yoshida@example.com', '070-2323-4545', 'confirmed', '',                    0],
      [  1, 2, 'V004', '佐々木 玲奈', 'sasaki@example.com',  '080-3434-5656', 'confirmed', '',                   -1],
      [  3, 4, 'V002', '松本 浩二',   'matsumoto@example.com','090-4545-6767', 'confirmed', '長期割引適用',         0],
      [  5, 2, 'V006', '井上 美穂',   'inoue@example.com',   '070-5656-7878', 'confirmed', '',                   -2],
      [  8, 3, 'V005', '木村 拓也',   'kimura@example.com',  '080-6767-8989', 'confirmed', '',                   -1],
      [ 12, 2, 'V008', '渡辺 さやか', 'watanabe@example.com','090-7878-9090', 'confirmed', '記念日利用',           0]
    ];
    return rows.map((r, i) => {
      const [off, dur, vid, name, email, phone, status, note, createdOff] = r;
      return {
        reservationId: 'R' + String(i + 1).padStart(4, '0'),
        vehicleId: vid,
        vehicleName: nameById[vid] || vid,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        start: at(off, 10),
        end: at(off + dur, 10),
        status: status,
        note: note,
        createdAt: at(createdOff, 9)
      };
    });
  }
  function saveReservations(list) {
    localStorage.setItem('sky-rent.reservations', JSON.stringify(list));
  }

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
      const vehicles = localVehicles();
      const reservations = localReservations();

      if (action === 'vehicles') {
        resolve(vehicles.filter(v => v.active !== false));
      } else if (action === 'availability') {
        const start = params && params.start ? new Date(params.start) : new Date();
        const end = params && params.end ? new Date(params.end) : new Date(Date.now()+86400000);
        resolve(vehicles.map(v => {
          const conflict = reservations.find(r =>
            String(r.vehicleId) === String(v.vehicleId) &&
            r.status !== 'cancelled' &&
            new Date(r.start) < end && new Date(r.end) > start
          );
          if (conflict) {
            return { vehicleId: v.vehicleId, available: false,
              conflictReason: '他の予約と重複: ' + conflict.customerName + ' 様' };
          }
          return { vehicleId: v.vehicleId, available: true };
        }));
      } else if (action === 'dashboard') {
        const today = (params && params.date) || new Date().toISOString().slice(0,10);
        const target = new Date(today + 'T00:00:00+09:00');
        const dayEnd = new Date(target); dayEnd.setHours(23,59,59,999);

        const weekly = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(target); d.setDate(target.getDate() - i);
          const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
          const cnt = reservations.filter(r => {
            const c = new Date(r.createdAt || r.start);
            return c >= d && c <= dEnd;
          }).length;
          weekly.push({ date: (d.getMonth()+1) + '/' + d.getDate(), count: cnt });
        }

        const bookings = reservations.filter(r => {
          const c = new Date(r.createdAt || r.start);
          return c >= target && c <= dayEnd;
        });
        const departures = reservations.filter(r => {
          const s = new Date(r.start);
          return s >= target && s <= dayEnd;
        });
        const returns = reservations.filter(r => {
          const e = new Date(r.end);
          return e >= target && e <= dayEnd;
        });

        // 車検の未予約: 車輌マスタから車検満了日を擬似算出し、予約が未だ入っていないものを抽出
        // (shaken-list.html と同じロジック。実運用では車輌台帳の車検満了日カラムを参照)
        const nowReal = new Date();
        const shaken = vehicles.map((v, i) => {
          const expiry = new Date(nowReal);
          expiry.setMonth(expiry.getMonth() + (i * 4 - 2));
          const daysLeft = Math.ceil((expiry - nowReal) / 86400000);
          const booked = i % 2 === 0 && daysLeft < 100;
          return {
            expireDate: expiry.getFullYear() + '/' + String(expiry.getMonth()+1).padStart(2,'0') + '/' + String(expiry.getDate()).padStart(2,'0'),
            vehicleName: v.name,
            plate: v.plate || '',
            daysLeft, booked
          };
        }).filter(s => !s.booked && s.daysLeft > -60 && s.daysLeft <= 365)
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .slice(0, 5);

        resolve({ date: today, bookings, departures, returns, weekly, shaken });
      } else if (action === 'reservations') {
        let list = reservations.slice();
        if (params && params.from) list = list.filter(r => new Date(r.start) >= new Date(params.from));
        if (params && params.to) list = list.filter(r => new Date(r.end) <= new Date(params.to));
        list.sort((a, b) => new Date(b.start) - new Date(a.start));
        resolve(list);
      } else if (action === 'customers') {
        const map = new Map();
        reservations.forEach(r => {
          const key = (r.customerEmail || r.customerName || '').toLowerCase();
          if (!key) return;
          if (!map.has(key)) {
            map.set(key, {
              name: r.customerName, email: r.customerEmail, phone: r.customerPhone,
              reservationCount: 0, latestReservation: r.start
            });
          }
          const c = map.get(key);
          c.reservationCount++;
          if (new Date(r.start) > new Date(c.latestReservation)) c.latestReservation = r.start;
        });
        resolve(Array.from(map.values())
          .sort((a, b) => new Date(b.latestReservation) - new Date(a.latestReservation)));
      } else if (action === 'revenue') {
        // 12ヶ月の月次集計
        const priceMap = {}; vehicles.forEach(v => priceMap[v.vehicleId] = Number(v.pricePerDay)||0);
        const now = new Date();
        const out = [];
        for (let i = 11; i >= 0; i--) {
          const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
          let total = 0, count = 0;
          reservations.forEach(r => {
            if (r.status === 'cancelled') return;
            const s = new Date(r.start);
            if (s < start || s >= end) return;
            const e = new Date(r.end);
            const days = Math.max(1, Math.ceil((e - s) / 86400000));
            total += (priceMap[r.vehicleId] || 0) * days;
            count++;
          });
          out.push({
            year: start.getFullYear(), month: start.getMonth()+1,
            label: start.getFullYear() + '/' + String(start.getMonth()+1).padStart(2,'0'),
            count, total
          });
        }
        resolve(out);
      } else {
        resolve([]);
      }
    }, 200));
  }

  function mockPost(body) {
    return new Promise(resolve => setTimeout(() => {
      const vehicles = localVehicles();
      const v = vehicles.find(x => String(x.vehicleId) === String(body.vehicleId));
      const reservationId = 'R' + Date.now();
      const newReservation = {
        reservationId,
        vehicleId: body.vehicleId,
        vehicleName: (v && v.name) || body.vehicleId,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        customerPhone: body.customerPhone || '',
        start: body.start, end: body.end,
        status: 'confirmed',
        note: body.note || '',
        createdAt: new Date().toISOString()
      };
      const list = localReservations();
      list.push(newReservation);
      saveReservations(list);
      resolve({
        reservationId,
        vehicleName: newReservation.vehicleName,
        start: body.start,
        end: body.end,
        calendarEventId: 'mock-event'
      });
    }, 400));
  }

  // 公開: 予約をlocalStorage上で更新する用 (キャンセル等)
  function updateReservation(reservationId, updates) {
    const list = localReservations();
    const idx = list.findIndex(r => r.reservationId === reservationId);
    if (idx < 0) return false;
    list[idx] = Object.assign({}, list[idx], updates);
    saveReservations(list);
    return true;
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
    getRevenue: (year, month) => get('revenue', year && month ? { year, month } : {}),
    // ローカル管理用
    updateReservation: (id, updates) => {
      if (isConfigured) throw new Error('GAS設定済み環境ではこのAPIは使えません');
      return updateReservation(id, updates);
    }
  };
})();
