/**
 * Sky Rent - レンタカー予約システム バックエンド (Google Apps Script)
 *
 * 機能:
 *   1. 車両一覧の取得 (Sheets)
 *   2. 空き状況の照会 (Sheets予約台帳 + Google Calendar 両方を照合)
 *   3. 予約の作成 (Sheets追加 + Calendar イベント作成)
 *
 * デプロイ:
 *   「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *   実行ユーザー: 自分 / アクセス: 全員
 *   発行された /exec URL を フロントエンドの js/config.js に貼り付け
 */

// ===== 設定 =====
const CONFIG = {
  // 車両マスタ・予約台帳を入れる Spreadsheet の ID
  // 初回 setup() を実行すると自動で作成され、ScriptProperties に保存されます
  SHEET_VEHICLES: '車両マスタ',
  SHEET_RESERVATIONS: '予約台帳',

  // 在庫照合に使う Google Calendar の ID
  // 'primary' = ログインユーザーのメインカレンダー
  // 専用カレンダーを作りたい場合は ScriptProperties.CALENDAR_ID を上書き
  DEFAULT_CALENDAR_ID: 'primary',

  // 1日の営業時間外も予約可能とするか
  ALLOW_OVERNIGHT: true
};

// ===== エントリポイント =====
/**
 * GET: 車両一覧 / 空き状況照会
 * パラメータ:
 *   action=vehicles            -> 車両一覧
 *   action=availability        -> 空き状況 (start, end が必要)
 */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'vehicles';
    let result;

    switch (action) {
      case 'vehicles':
        result = { ok: true, data: listVehicles() };
        break;
      case 'availability':
        result = {
          ok: true,
          data: getAvailability(e.parameter.start, e.parameter.end)
        };
        break;
      case 'reservations':
        result = { ok: true, data: listReservations(e.parameter.from, e.parameter.to) };
        break;
      case 'dashboard':
        result = { ok: true, data: getDashboard(e.parameter.date) };
        break;
      case 'customers':
        result = { ok: true, data: listCustomers() };
        break;
      case 'revenue':
        result = { ok: true, data: getRevenue(e.parameter.year, e.parameter.month) };
        break;
      default:
        result = { ok: false, error: 'Unknown action: ' + action };
    }

    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * POST: 予約作成
 * Body (JSON):
 *   { vehicleId, customerName, customerEmail, customerPhone, start, end, note }
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const result = createReservation(body);
    return jsonOutput({ ok: true, data: result });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message || err) });
  }
}

// ===== 車両一覧 =====
function listVehicles() {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_VEHICLES, [
    'vehicleId', 'name', 'class', 'plate', 'capacity', 'pricePerDay', 'imageUrl', 'active'
  ]);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  return values.slice(1)
    .map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])))
    .filter(v => v.vehicleId && (v.active === true || v.active === 'TRUE' || v.active === '' || v.active === undefined));
}

// ===== 空き状況 =====
/**
 * Sheets の予約台帳と Google Calendar の両方を見て、
 * 期間 [start, end] と重複する予定がある車両は「空きなし」として返す。
 *
 * @return [{ vehicleId, available: boolean, conflictReason?: string }]
 */
function getAvailability(startStr, endStr) {
  if (!startStr || !endStr) throw new Error('start, end は必須です');
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (!(start instanceof Date) || isNaN(start) || !(end instanceof Date) || isNaN(end)) {
    throw new Error('日時の形式が不正です (ISO 8601 を使用してください)');
  }
  if (end <= start) throw new Error('終了日時は開始日時より後にしてください');

  const vehicles = listVehicles();
  const reservations = getReservationsInRange_(start, end);
  const calendarBusy = getCalendarBusyEvents_(start, end);

  return vehicles.map(v => {
    const sheetConflict = reservations.find(r =>
      String(r.vehicleId) === String(v.vehicleId) &&
      r.status !== 'cancelled'
    );
    if (sheetConflict) {
      return { vehicleId: v.vehicleId, available: false, conflictReason: '他の予約と重複' };
    }

    // Google Calendar に車両ID入りタイトルがあれば、その車両は塞がっている扱い
    const calendarConflict = calendarBusy.find(ev =>
      ev.title.indexOf(String(v.vehicleId)) !== -1 ||
      ev.title.indexOf(String(v.name)) !== -1
    );
    if (calendarConflict) {
      return {
        vehicleId: v.vehicleId,
        available: false,
        conflictReason: 'Googleカレンダーの予定と重複: ' + calendarConflict.title
      };
    }

    return { vehicleId: v.vehicleId, available: true };
  });
}

// ===== 予約作成 =====
function createReservation(body) {
  const required = ['vehicleId', 'customerName', 'customerEmail', 'start', 'end'];
  for (const k of required) {
    if (!body[k]) throw new Error('必須項目が不足: ' + k);
  }

  const start = new Date(body.start);
  const end = new Date(body.end);
  if (end <= start) throw new Error('終了日時は開始日時より後にしてください');

  // ロック (同時予約による二重登録を防止)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('混雑中です。しばらくして再試行してください');

  try {
    // 再度照合 (送信中に他の予約が入っていないか)
    const availability = getAvailability(start.toISOString(), end.toISOString());
    const target = availability.find(a => String(a.vehicleId) === String(body.vehicleId));
    if (!target) throw new Error('指定された車両が見つかりません');
    if (!target.available) throw new Error('予約不可: ' + (target.conflictReason || '空きなし'));

    const vehicles = listVehicles();
    const vehicle = vehicles.find(v => String(v.vehicleId) === String(body.vehicleId));
    if (!vehicle) throw new Error('車両情報が取得できません');

    const reservationId = 'R' + Utilities.formatDate(new Date(), 'JST', 'yyyyMMddHHmmss') +
      '-' + Math.floor(Math.random() * 1000);

    // 1) Sheets 予約台帳に追加
    const sheet = getOrCreateSheet_(CONFIG.SHEET_RESERVATIONS, [
      'reservationId', 'vehicleId', 'vehicleName',
      'customerName', 'customerEmail', 'customerPhone',
      'start', 'end', 'status', 'note',
      'calendarEventId', 'createdAt'
    ]);

    // 2) Google Calendar にイベント作成
    const calendarId = getCalendarId_();
    const calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) throw new Error('カレンダーが見つかりません: ' + calendarId);

    const eventTitle = '【予約】' + vehicle.name + ' (' + vehicle.vehicleId + ') / ' + body.customerName;
    const eventDesc = [
      '予約ID: ' + reservationId,
      'お客様: ' + body.customerName,
      'メール: ' + body.customerEmail,
      '電話: ' + (body.customerPhone || ''),
      '備考: ' + (body.note || '')
    ].join('\n');

    const event = calendar.createEvent(eventTitle, start, end, { description: eventDesc });
    const eventId = event.getId();

    sheet.appendRow([
      reservationId,
      body.vehicleId,
      vehicle.name,
      body.customerName,
      body.customerEmail,
      body.customerPhone || '',
      start,
      end,
      'confirmed',
      body.note || '',
      eventId,
      new Date()
    ]);

    // 3) 顧客に確認メール (任意)
    sendConfirmationEmail_(body.customerEmail, {
      reservationId, vehicle, body, start, end
    });

    return {
      reservationId,
      vehicleName: vehicle.name,
      start: start.toISOString(),
      end: end.toISOString(),
      calendarEventId: eventId
    };
  } finally {
    lock.releaseLock();
  }
}

// ===== 管理画面用エンドポイント =====
/**
 * ダッシュボード集計
 * @param dateStr YYYY-MM-DD (省略時 = 当日)
 * @return {
 *   date,
 *   bookings: 過去1週間に登録された予約数,
 *   departures: 当日出発予定の予約[],
 *   returns: 当日返却予定の予約[],
 *   weekly: [{date, count}] 過去7日の登録数,
 *   shaken: 車検期限切れの車輌[]
 * }
 */
function getDashboard(dateStr) {
  const target = dateStr ? new Date(dateStr + 'T00:00:00+09:00') : new Date();
  target.setHours(0, 0, 0, 0);
  const dayEnd = new Date(target); dayEnd.setHours(23, 59, 59, 999);

  const allReservations = listReservations() || [];

  // 過去7日 (target含む) の登録数
  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(target); d.setDate(target.getDate() - i);
    const dEnd = new Date(d); dEnd.setHours(23, 59, 59, 999);
    const count = allReservations.filter(r => {
      const c = new Date(r.createdAt);
      return c >= d && c <= dEnd;
    }).length;
    weekly.push({
      date: Utilities.formatDate(d, 'JST', 'M/d'),
      count
    });
  }

  // 当日登録の予約数 (KPI 1: 予約された件数)
  const bookings = allReservations.filter(r => {
    const c = new Date(r.createdAt);
    return c >= target && c <= dayEnd;
  });

  // 当日出発の予約
  const departures = allReservations.filter(r => {
    const s = new Date(r.start);
    return s >= target && s <= dayEnd;
  }).sort((a, b) => new Date(a.start) - new Date(b.start));

  // 当日返却の予約
  const returns = allReservations.filter(r => {
    const e = new Date(r.end);
    return e >= target && e <= dayEnd;
  }).sort((a, b) => new Date(a.end) - new Date(b.end));

  return {
    date: Utilities.formatDate(target, 'JST', 'yyyy-MM-dd'),
    bookings: bookings.map(simplifyForList_),
    departures: departures.map(simplifyForList_),
    returns: returns.map(simplifyForList_),
    weekly,
    shaken: [] // TODO: 車検期限管理は v2 で対応
  };
}

function simplifyForList_(r) {
  return {
    reservationId: r.reservationId,
    vehicleId: r.vehicleId,
    vehicleName: r.vehicleName,
    customerName: r.customerName,
    start: r.start,
    end: r.end,
    status: r.status
  };
}

/**
 * 予約一覧 (期間指定可)
 */
function listReservations(fromStr, toStr) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_RESERVATIONS, [
    'reservationId', 'vehicleId', 'vehicleName',
    'customerName', 'customerEmail', 'customerPhone',
    'start', 'end', 'status', 'note',
    'calendarEventId', 'createdAt'
  ]);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  let list = values.slice(1)
    .map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])))
    .filter(r => r.reservationId);

  if (fromStr) {
    const from = new Date(fromStr);
    list = list.filter(r => new Date(r.start) >= from);
  }
  if (toStr) {
    const to = new Date(toStr);
    list = list.filter(r => new Date(r.end) <= to);
  }
  // 開始日降順
  list.sort((a, b) => new Date(b.start) - new Date(a.start));
  // 日付を ISO 文字列に
  list.forEach(r => {
    if (r.start instanceof Date) r.start = r.start.toISOString();
    if (r.end instanceof Date) r.end = r.end.toISOString();
    if (r.createdAt instanceof Date) r.createdAt = r.createdAt.toISOString();
  });
  return list;
}

/**
 * 顧客一覧 (予約台帳から重複排除して抽出)
 */
function listCustomers() {
  const reservations = listReservations() || [];
  const map = new Map();
  reservations.forEach(r => {
    const key = (r.customerEmail || r.customerName || '').toLowerCase();
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        name: r.customerName,
        email: r.customerEmail,
        phone: r.customerPhone,
        reservationCount: 0,
        latestReservation: r.start
      });
    }
    const c = map.get(key);
    c.reservationCount++;
    if (new Date(r.start) > new Date(c.latestReservation)) {
      c.latestReservation = r.start;
    }
  });
  return Array.from(map.values()).sort((a, b) =>
    new Date(b.latestReservation) - new Date(a.latestReservation));
}

/**
 * 月別売上集計
 */
function getRevenue(year, month) {
  const reservations = listReservations() || [];
  const vehicles = listVehicles() || [];
  const priceMap = {};
  vehicles.forEach(v => { priceMap[v.vehicleId] = Number(v.pricePerDay) || 0; });

  // 期間: 引数の年月、未指定なら過去12ヶ月
  if (year && month) {
    return revenueForMonth_(reservations, priceMap, Number(year), Number(month));
  }
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(revenueForMonth_(reservations, priceMap, d.getFullYear(), d.getMonth() + 1));
  }
  return months;
}

function revenueForMonth_(reservations, priceMap, year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  let total = 0;
  let count = 0;
  reservations.forEach(r => {
    if (r.status === 'cancelled') return;
    const s = new Date(r.start);
    if (s < start || s >= end) return;
    const e = new Date(r.end);
    const days = Math.max(1, Math.ceil((e - s) / (24 * 60 * 60 * 1000)));
    total += (priceMap[r.vehicleId] || 0) * days;
    count++;
  });
  return { year, month, label: `${year}/${String(month).padStart(2, '0')}`, count, total };
}

// ===== ヘルパー =====
function getOrCreateSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f0f0f0');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // 削除されていた場合は作り直す
    }
  }
  const ss = SpreadsheetApp.create('Sky Rent データ ' +
    Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd'));
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getCalendarId_() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('CALENDAR_ID') || CONFIG.DEFAULT_CALENDAR_ID;
}

function getReservationsInRange_(start, end) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_RESERVATIONS, [
    'reservationId', 'vehicleId', 'vehicleName',
    'customerName', 'customerEmail', 'customerPhone',
    'start', 'end', 'status', 'note',
    'calendarEventId', 'createdAt'
  ]);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  return values.slice(1)
    .map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])))
    .filter(r => {
      if (!r.start || !r.end) return false;
      const rs = new Date(r.start);
      const re = new Date(r.end);
      // 期間が重なるか
      return rs < end && re > start;
    });
}

function getCalendarBusyEvents_(start, end) {
  const calendarId = getCalendarId_();
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) return [];
  const events = calendar.getEvents(start, end);
  return events.map(ev => ({
    id: ev.getId(),
    title: ev.getTitle() || '',
    start: ev.getStartTime(),
    end: ev.getEndTime()
  }));
}

function sendConfirmationEmail_(to, ctx) {
  try {
    const subject = '【Sky Rent】ご予約を承りました (' + ctx.reservationId + ')';
    const body = [
      ctx.body.customerName + ' 様',
      '',
      'この度はSky Rentをご利用いただき誠にありがとうございます。',
      '以下の内容でご予約を承りました。',
      '',
      '─────────────',
      '予約ID: ' + ctx.reservationId,
      '車両: ' + ctx.vehicle.name,
      '貸出: ' + Utilities.formatDate(ctx.start, 'JST', 'yyyy/MM/dd HH:mm'),
      '返却: ' + Utilities.formatDate(ctx.end, 'JST', 'yyyy/MM/dd HH:mm'),
      '─────────────',
      '',
      'ご来店をお待ちしております。',
      '',
      'Sky Rent'
    ].join('\n');
    MailApp.sendEmail(to, subject, body);
  } catch (e) {
    console.warn('確認メール送信失敗:', e);
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 初期セットアップ =====
/**
 * 初回のみエディタから手動実行するセットアップ。
 * 1. Spreadsheet を新規作成 (既にあれば再利用)
 * 2. 車両マスタ・予約台帳の見出しを作成
 * 3. サンプル車両を追加
 */
function setup() {
  const vehicles = getOrCreateSheet_(CONFIG.SHEET_VEHICLES, [
    'vehicleId', 'name', 'class', 'plate', 'capacity', 'pricePerDay', 'imageUrl', 'active'
  ]);
  const reservations = getOrCreateSheet_(CONFIG.SHEET_RESERVATIONS, [
    'reservationId', 'vehicleId', 'vehicleName',
    'customerName', 'customerEmail', 'customerPhone',
    'start', 'end', 'status', 'note',
    'calendarEventId', 'createdAt'
  ]);

  // サンプル車両 (空のときだけ追加)
  if (vehicles.getLastRow() <= 1) {
    const samples = [
      ['V001', 'コンパクト (ヴィッツ等)', 'コンパクト', '札幌 500 あ 1234', 5, 5500, '', true],
      ['V002', 'ミドル (カローラ等)',     'ミドル',     '札幌 500 あ 5678', 5, 7700, '', true],
      ['V003', 'ミニバン (ノア等)',       'ミニバン',   '札幌 500 あ 9012', 7, 11000, '', true],
      ['V004', 'SUV (ハリアー等)',        'SUV',        '札幌 500 あ 3456', 5, 13200, '', true]
    ];
    samples.forEach(row => vehicles.appendRow(row));
  }

  const ss = getSpreadsheet_();
  console.log('Spreadsheet URL:', ss.getUrl());
  console.log('Calendar ID:', getCalendarId_());
  console.log('セットアップ完了。Web Appとしてデプロイし、URL をフロントエンドに設定してください。');
}
