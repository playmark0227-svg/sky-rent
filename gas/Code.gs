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
