/**
 * グロースレンタカー - 統合データストア
 *
 * 要件定義書 v3.0 (2026-06-26) 準拠のデータ層。
 *   - 車両カテゴリ + 物品カテゴリ (家電・工具) を統合した「アセット」モデル
 *   - カテゴリごとのカスタム項目 (EAV/JSON方式) — 管理画面から自由に定義可能
 *   - 拠点 (北見・釧路) / オプション2階層 (共通・カテゴリ専用) / 在庫数管理 (物品)
 *   - 会員・ポイント・クーポン制度 / 請求書払い (法人・行政のみ)
 *   - 通知ログ (メール送信のデモ代替)
 *
 * ストレージ: localStorage (デモ) / 本番は js/api.js 経由で GAS 等へ差替可能。
 * すべてのキーは 'sky-rent.' プレフィックス。
 */
(function () {
  'use strict';
  const PREFIX = 'sky-rent.';
  const DATA_VERSION = 4;
  const DAY = 86400000;

  // ===== 低レベル入出力 =====
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function write(key, val) { localStorage.setItem(PREFIX + key, JSON.stringify(val)); }

  // 「今日」基準の相対日時 ISO (シードデータ用)
  function at(offsetDays, hour) {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString();
  }

  // ===================================================================
  // シードデータ
  // ===================================================================

  const SEED_CATEGORIES = [
    { categoryId: 'cat-rental', name: '一般レンタカー', nameEn: 'Rental Car', type: 'vehicle', icon: '🚗', sort: 1, active: true,
      description: '通勤・買い物・旅行・お仕事に。コンパクトからSUV・ミニバン・軽トラックまで。',
      customFieldDefs: [
        { key: 'bodyType', label: 'ボディタイプ', type: 'select', options: ['コンパクト', 'SUV', 'ミニバン', '軽トラック'], filterable: true },
        { key: 'drive',    label: '駆動方式',     type: 'select', options: ['2WD', '4WD'], filterable: true },
        { key: 'mission',  label: 'トランスミッション', type: 'select', options: ['AT', 'MT'], filterable: false },
        { key: 'navi',     label: 'カーナビ',     type: 'select', options: ['有', '無'], filterable: false },
        { key: 'etc',      label: 'ETC車載器',    type: 'select', options: ['有', '無'], filterable: false }
      ] },
    { categoryId: 'cat-kitchen', name: 'キッチンカー', nameEn: 'Kitchen Car', type: 'vehicle', icon: '🍳', sort: 2, active: true,
      description: 'イベント出店・移動販売・開業テストに。営業許可対応の本格装備。',
      customFieldDefs: [
        { key: 'kitchenSize', label: 'キッチン寸法',  type: 'text',   unit: '', filterable: false },
        { key: 'equipment',   label: '搭載機材',      type: 'text',   unit: '', filterable: false },
        { key: 'sinks',       label: 'シンク数',      type: 'number', unit: '槽', filterable: false },
        { key: 'power',       label: '電源容量',      type: 'number', unit: 'W', filterable: false }
      ] }
  ];

  const SEED_LOCATIONS = [
    { locationId: 'loc-kitami',  name: '北見本店', nameEn: 'Kitami',  tel: '0157-00-0001', address: '北海道北見市', hours: '9:00-19:00', holiday: 'なし (年中無休)', sort: 1 },
    { locationId: 'loc-kushiro', name: '釧路店',   nameEn: 'Kushiro', tel: '0154-00-0002', address: '北海道釧路市', hours: '9:00-18:00', holiday: 'なし (年中無休)', sort: 2 }
  ];

  const SEED_ASSETS = [
    { assetId: 'V001', categoryId: 'cat-rental', locationId: 'loc-kitami', name: '日産 ノート', nameEn: 'Nissan Note',
      plate: '', capacity: 5, priceHour: 1100, priceDay: 7700, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🚗', photo: 'images/cars/note-black.jpg', active: true,
      shakenDate: at(210, 0), maintenanceDate: at(40, 0),
      customFields: { bodyType: 'コンパクト', drive: '2WD', mission: 'AT', navi: '有', etc: '有' } },
    { assetId: 'V002', categoryId: 'cat-rental', locationId: 'loc-kushiro', name: '日産 ノート e-POWER', nameEn: 'Nissan Note e-POWER',
      plate: '', capacity: 5, priceHour: 1100, priceDay: 7700, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🚗', photo: 'images/cars/note-white.jpg', active: true,
      shakenDate: at(300, 0), maintenanceDate: at(65, 0),
      customFields: { bodyType: 'コンパクト', drive: '2WD', mission: 'AT', navi: '有', etc: '有' } },
    { assetId: 'V003', categoryId: 'cat-rental', locationId: 'loc-kitami', name: 'マツダ CX-5', nameEn: 'Mazda CX-5',
      plate: '', capacity: 5, priceHour: 2200, priceDay: 17000, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🚙', photo: 'images/cars/cx5.jpg', active: true,
      shakenDate: at(80, 0), maintenanceDate: at(25, 0),
      customFields: { bodyType: 'SUV', drive: '4WD', mission: 'AT', navi: '有', etc: '有' } },
    { assetId: 'V004', categoryId: 'cat-rental', locationId: 'loc-kitami', name: 'トヨタ シエンタ', nameEn: 'Toyota Sienta',
      plate: '', capacity: 7, priceHour: 2200, priceDay: 17000, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🚐', photo: 'images/cars/sienta.jpg', active: true,
      shakenDate: at(160, 0), maintenanceDate: at(50, 0),
      customFields: { bodyType: 'ミニバン', drive: '2WD', mission: 'AT', navi: '有', etc: '有' } },
    { assetId: 'V005', categoryId: 'cat-rental', locationId: 'loc-kitami', name: '軽トラック', nameEn: 'Kei Truck',
      plate: '', capacity: 2, priceHour: 1100, priceDay: 7700, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🛻', photo: '', active: true,
      shakenDate: at(120, 0), maintenanceDate: at(35, 0),
      customFields: { bodyType: '軽トラック', drive: '4WD', mission: 'AT', navi: '無', etc: '無' } },
    { assetId: 'K001', categoryId: 'cat-kitchen', locationId: 'loc-kitami', name: 'キッチンカー', nameEn: 'Kitchen Car',
      plate: '', capacity: 2, priceHour: null, priceDay: 22000, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🍳', photo: '', active: true,
      shakenDate: at(190, 0), maintenanceDate: at(55, 0),
      customFields: { kitchenSize: '2400×1800×1900mm', equipment: '2槽シンク・換気扇・作業台・給排水タンク・冷蔵庫', sinks: 2, power: 3000 } }
  ];

  // オプション: categoryIds = null → 共通 (全車両カテゴリ)。priceType: per_day | per_rental
  const SEED_OPTIONS = [
    // 装備オプション (全車共通・24時間あたり)
    { optionId: 'OP001', name: 'ポータブル冷蔵冷凍庫', price: 3300, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP002', name: '電子レンジ',           price: 2200, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP003', name: 'サーキュレーター',     price: 1100, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP004', name: 'ポータブル電源',       price: 3300, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP005', name: 'ドラムリール',         price: 1100, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP006', name: 'カセットコンロ',       price: 1100, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP007', name: 'カセットボンベ',       price: 1100, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP008', name: '炊飯器',               price: 2200, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP009', name: '電気ケトル',           price: 1100, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP010', name: '家電セット (上記9点まとめ)', price: 11000, priceType: 'per_day', categoryIds: null, active: true },
    { optionId: 'OP011', name: '集客セット (ホワイトボード・マグネット・ペン)', price: 1100, priceType: 'per_day', categoryIds: null, active: true },
    // 補償 (レンタカー)
    { optionId: 'OP101', name: '免責補償制度 (CDW)',   price: 1650, priceType: 'per_day', categoryIds: ['cat-rental'], active: true },
    { optionId: 'OP102', name: '安心保証コース (PAP)', price: 3300, priceType: 'per_day', categoryIds: ['cat-rental'], active: true },
    // 補償 (キッチンカー)
    { optionId: 'OP201', name: '免責補償制度 (CDW)',   price: 3300, priceType: 'per_day', categoryIds: ['cat-kitchen'], active: true },
    { optionId: 'OP202', name: '安心保証コース (PAP)', price: 6600, priceType: 'per_day', categoryIds: ['cat-kitchen'], active: true }
  ];

  const SEED_MEMBERS = [
    { memberId: 'M001', name: 'デモ 太郎', nameKana: 'デモ タロウ', email: 'demo@example.com', phone: '090-0000-1111',
      password: 'demo1234', company: '', isCorporate: false, invoiceAllowed: false,
      points: 8, coupons: [],
      pointHistory: [
        { at: at(-40, 12), delta: 4, reason: '過去利用分 (移行)' },
        { at: at(-10, 12), delta: 1, reason: '予約 R0004 返却完了' },
        { at: at(-5, 12),  delta: 3, reason: 'キャンペーン付与' }
      ],
      createdAt: at(-120, 10), lastUseAt: at(-6, 10) },
    { memberId: 'M002', name: '(株)北海道イベント企画', nameKana: 'ホッカイドウイベントキカク', email: 'corp@example.com', phone: '011-222-3333',
      password: 'demo1234', company: '株式会社北海道イベント企画', isCorporate: true, invoiceAllowed: true,
      points: 3, coupons: [],
      pointHistory: [
        { at: at(-18, 12), delta: 1, reason: '予約 R0002 返却完了' },
        { at: at(-4, 12),  delta: 2, reason: '予約 R0006 返却完了ほか' }
      ],
      createdAt: at(-200, 10), lastUseAt: at(-4, 10) }
  ];

  // [開始offset, 日数, assetId, qty, 氏名, email, 電話, status, 支払方法, memberId, 備考, 登録offset]
  const SEED_RESERVATION_ROWS = [
    [-25, 3, 'V003', 1, '田中 健一',   'tanaka@example.com',   '090-1010-2020', 'returned',  'onsite',  null,   '',                    -27],
    [-20, 2, 'K001', 1, '(株)北海道イベント企画', 'corp@example.com', '011-222-3333', 'returned', 'invoice', 'M002', '夏祭りイベント出店',   -25],
    [-15, 2, 'V001', 1, '鈴木 美咲',   'suzuki@example.com',   '080-2233-4455', 'cancelled', 'onsite',  null,   'お客様都合キャンセル', -17],
    [-10, 4, 'V004', 1, 'デモ 太郎',   'demo@example.com',     '090-0000-1111', 'returned',  'onsite',  'M001', '家族旅行',             -14],
    [ -8, 1, 'V005', 1, '山本工務店',   'yamamoto-k@example.com', '011-555-6677', 'returned', 'onsite',  null,   '資材運搬',             -9],
    [ -6, 2, 'V002', 1, '(株)北海道イベント企画', 'corp@example.com', '011-222-3333', 'returned', 'invoice', 'M002', '出張利用',         -8],
    [ -4, 2, 'V001', 1, '伊藤 翔太',   'ito-s@example.com',    '070-6677-8899', 'returned',  'onsite',  null,   '',                    -5],
    [ -1, 3, 'K001', 1, '中村 由美',   'nakamura@example.com', '090-7788-9900', 'in_use',    'onsite',  null,   'マルシェ出店 (貸出中)', -3],
    [ -1, 2, 'V003', 1, '小林 誠',     'kobayashi@example.com','080-8899-0011', 'in_use',    'onsite',  null,   '道東ドライブ (貸出中)', -2],
    [  0, 1, 'V004', 1, '加藤 健',     'kato@example.com',     '090-1212-3434', 'confirmed', 'onsite',  null,   '本日出発',             -1],
    [  0, 2, 'V005', 1, '吉田 直樹',   'yoshida@example.com',  '070-2323-4545', 'confirmed', 'onsite',  null,   '引越し',                0],
    [  1, 2, 'V002', 1, '佐々木 玲奈', 'sasaki@example.com',   '080-3434-5656', 'confirmed', 'onsite',  null,   '',                    -1],
    [  2, 4, 'V001', 1, 'デモ 太郎',   'demo@example.com',     '090-0000-1111', 'confirmed', 'onsite',  'M001', '週末利用',              0],
    [  3, 2, 'V005', 1, '松本 浩二',   'matsumoto@example.com','090-4545-6767', 'confirmed', 'onsite',  null,   '農作業',               -2],
    [  5, 3, 'K001', 1, '井上 美穂',   'inoue@example.com',    '070-5656-7878', 'confirmed', 'onsite',  null,   'クレープ移動販売',      0],
    [  8, 2, 'V003', 1, '木村 拓也',   'kimura@example.com',   '080-6767-8989', 'confirmed', 'onsite',  null,   '出張',                 -1],
    [ 12, 2, 'V004', 1, '渡辺 さやか', 'watanabe@example.com', '090-7878-9090', 'confirmed', 'onsite',  null,   '記念日利用',            0],
    [ 14, 3, 'V002', 1, '高橋 大輔',   'takahashi@example.com','090-3344-5566', 'confirmed', 'onsite',  null,   '連休利用',              0]
  ];

  function buildSeedReservations() {
    const assetById = {};
    SEED_ASSETS.forEach(a => { assetById[a.assetId] = a; });
    return SEED_RESERVATION_ROWS.map((row, i) => {
      const [off, dur, assetId, qty, name, email, phone, status, payMethod, memberId, note, createdOff] = row;
      const a = assetById[assetId];
      const days = dur;
      const base = (a.priceDay || 0) * days * qty;
      const r = {
        reservationId: 'R' + String(i + 1).padStart(4, '0'),
        assetId: assetId,
        vehicleId: assetId,               // 旧画面互換エイリアス
        assetName: a.name,
        vehicleName: a.name,              // 旧画面互換エイリアス
        categoryId: a.categoryId,
        locationId: a.locationId,
        quantity: qty,
        customerName: name, customerEmail: email, customerPhone: phone,
        company: memberId === 'M002' ? '株式会社北海道イベント企画' : '',
        licenseNo: (a.categoryId === 'cat-appliance' || a.categoryId === 'cat-tool') ? '' : '012345678900',
        memberId: memberId,
        start: at(off, 10), end: at(off + dur, 10),
        optionIds: [], options: [],
        payment: { method: payMethod, status: status === 'returned' && payMethod === 'onsite' ? 'paid' : 'unpaid' },
        price: { total: base, breakdown: [{ label: '基本料金 ' + days + '日 × ' + qty, amount: base }] },
        couponId: null,
        status: status,
        pointGranted: status === 'returned' && !!memberId,
        invoiceId: null,
        licenseConfirmed: !!a.requiredLicense,
        note: note,
        createdAt: at(createdOff, 9)
      };
      return r;
    });
  }

  function buildSeedInvoices(reservations) {
    const r2 = reservations.find(r => r.reservationId === 'R0002');
    const r6 = reservations.find(r => r.reservationId === 'R0006');
    const inv = [];
    if (r2) {
      inv.push({
        invoiceId: 'INV-0001', memberId: 'M002', company: '株式会社北海道イベント企画',
        address: '北海道札幌市中央区大通西5-8', caseName: '夏祭りイベント キッチンカーレンタル',
        reservationIds: ['R0002'], amount: r2.price.total,
        status: 'paid', issuedAt: at(-18, 10), dueDate: at(12, 0), paidAt: at(-10, 10)
      });
      r2.invoiceId = 'INV-0001';
      r2.payment.status = 'paid';
    }
    if (r6) {
      inv.push({
        invoiceId: 'INV-0002', memberId: 'M002', company: '株式会社北海道イベント企画',
        address: '北海道札幌市中央区大通西5-8', caseName: '資材運搬 ダンプレンタル',
        reservationIds: ['R0006'], amount: r6.price.total,
        status: 'unpaid', issuedAt: at(-4, 10), dueDate: at(26, 0), paidAt: null
      });
      r6.invoiceId = 'INV-0002';
    }
    return inv;
  }

  // ===================================================================
  // シード投入 / マイグレーション
  // ===================================================================
  function ensureSeeded() {
    const ver = read('dataVersion', 0);
    if (ver === DATA_VERSION) return;
    // 旧バージョンのデータキーを破棄 (settings.* は温存)
    ['vehicles', 'reservations', 'categories', 'locations', 'assets', 'options',
     'members', 'invoices', 'notifications'].forEach(k => localStorage.removeItem(PREFIX + k));
    write('categories', SEED_CATEGORIES);
    write('locations', SEED_LOCATIONS);
    write('assets', SEED_ASSETS);
    write('options', SEED_OPTIONS);
    write('members', SEED_MEMBERS);
    const reservations = buildSeedReservations();
    const invoices = buildSeedInvoices(reservations);
    write('reservations', reservations);
    write('invoices', invoices);
    write('notifications', [
      { at: at(-1, 9), type: 'reservation', message: '新規予約 R0009 (高級セダン / 小林 誠 様) を受け付けました', refId: 'R0009' },
      { at: at(0, 8),  type: 'reservation', message: '新規予約 R0011 (ポータブル電源 / 吉田 直樹 様) を受け付けました', refId: 'R0011' }
    ]);
    // ポイント設定・振込先の既定値 (未設定時のみ)
    if (read('settings.points', null) == null) {
      write('settings.points', { pointPerUse: 1, couponThreshold: 10, couponAmount: 1000, expiryMonths: 12 });
    }
    if (read('settings.billing', null) == null) {
      write('settings.billing', { bankName: '北洋銀行 札幌支店', accountType: '普通', accountNo: '1234567', holder: 'カ) スカイレント' });
    }
    write('dataVersion', DATA_VERSION);
  }

  // ===================================================================
  // 汎用 CRUD
  // ===================================================================
  function list(entity) { return read(entity, []); }
  function saveList(entity, arr) { write(entity, arr); }
  function findById(entity, idField, id) {
    return list(entity).find(x => String(x[idField]) === String(id)) || null;
  }
  function upsert(entity, idField, obj) {
    const arr = list(entity);
    const i = arr.findIndex(x => String(x[idField]) === String(obj[idField]));
    if (i >= 0) arr[i] = Object.assign({}, arr[i], obj); else arr.push(obj);
    saveList(entity, arr);
    return obj;
  }
  function removeById(entity, idField, id) {
    const arr = list(entity).filter(x => String(x[idField]) !== String(id));
    saveList(entity, arr);
  }
  function genId(prefix, entity, idField) {
    const arr = list(entity);
    let n = 1;
    while (arr.some(x => x[idField] === prefix + String(n).padStart(4, '0'))) n++;
    return prefix + String(n).padStart(4, '0');
  }

  // ===================================================================
  // ドメイン API
  // ===================================================================
  function categories(includeInactive) {
    return list('categories')
      .filter(c => includeInactive || c.active !== false)
      .sort((a, b) => (a.sort || 99) - (b.sort || 99));
  }
  function getCategory(id) { return findById('categories', 'categoryId', id); }
  function locations() { return list('locations').sort((a, b) => (a.sort || 99) - (b.sort || 99)); }
  function getLocation(id) { return findById('locations', 'locationId', id); }
  function assets(filter) {
    let arr = list('assets');
    if (filter) {
      if (filter.categoryId) arr = arr.filter(a => a.categoryId === filter.categoryId);
      if (filter.locationId) arr = arr.filter(a => a.locationId === filter.locationId);
      if (filter.activeOnly) arr = arr.filter(a => a.active !== false);
      if (filter.type) {
        const catTypes = {};
        list('categories').forEach(c => { catTypes[c.categoryId] = c.type; });
        arr = arr.filter(a => catTypes[a.categoryId] === filter.type);
      }
    }
    return arr;
  }
  function getAsset(id) { return findById('assets', 'assetId', id); }

  // カテゴリに適用可能なオプション (共通 + 専用) — 物品カテゴリには共通オプションを出さない
  function optionsForCategory(categoryId) {
    const cat = getCategory(categoryId);
    const isItem = cat && cat.type === 'item';
    const all = list('options').filter(o => o.active !== false);
    return {
      common: isItem ? [] : all.filter(o => o.categoryIds == null),
      specific: all.filter(o => Array.isArray(o.categoryIds) && o.categoryIds.indexOf(categoryId) >= 0)
    };
  }

  // ===== 空き状況 (車両=重複不可 / 物品=在庫数と照合) =====
  function reservedQty(assetId, start, end, excludeReservationId) {
    const s = new Date(start), e = new Date(end);
    return list('reservations')
      .filter(r => String(r.assetId) === String(assetId)
        && r.status !== 'cancelled'
        && r.reservationId !== excludeReservationId
        && new Date(r.start) < e && new Date(r.end) > s)
      .reduce((sum, r) => sum + (Number(r.quantity) || 1), 0);
  }
  function availability(assetId, start, end, qty, excludeReservationId) {
    const a = getAsset(assetId);
    if (!a) return { ok: false, remaining: 0, reason: '対象が見つかりません' };
    const stock = Number(a.stock) || 1;
    const used = reservedQty(assetId, start, end, excludeReservationId);
    const remaining = Math.max(0, stock - used);
    const need = Number(qty) || 1;
    return {
      ok: remaining >= need,
      remaining: remaining,
      stock: stock,
      reason: remaining >= need ? '' : (stock > 1 ? '在庫不足 (残り' + remaining + ')' : '他の予約と重複しています')
    };
  }

  // 検索: カテゴリ・拠点・期間・カスタム項目フィルタ
  function searchAvailable(params) {
    params = params || {};
    let arr = assets({ activeOnly: true, categoryId: params.categoryId || undefined, locationId: params.locationId || undefined });
    if (params.filters) {
      Object.keys(params.filters).forEach(key => {
        const val = params.filters[key];
        if (val === '' || val == null) return;
        arr = arr.filter(a => {
          const cf = (a.customFields || {})[key];
          if (cf == null) return false;
          // number フィールドは「以上」でフィルタ
          if (!isNaN(Number(val)) && !isNaN(Number(cf)) && String(Number(val)) === String(val)) return Number(cf) >= Number(val);
          return String(cf) === String(val);
        });
      });
    }
    return arr.map(a => {
      const av = (params.start && params.end)
        ? availability(a.assetId, params.start, params.end, params.quantity || 1)
        : { ok: true, remaining: Number(a.stock) || 1, stock: Number(a.stock) || 1, reason: '' };
      return Object.assign({}, a, { availability: av });
    });
  }

  // ===== 通知ログ (メール送信のデモ代替) =====
  function notify(type, message, refId) {
    const arr = list('notifications');
    arr.unshift({ at: new Date().toISOString(), type: type, message: message, refId: refId || null });
    saveList('notifications', arr.slice(0, 100));
  }

  // ===== 予約 =====
  function createReservation(payload) {
    const a = getAsset(payload.assetId);
    if (!a) throw new Error('車両・物品が見つかりません');
    const qty = Number(payload.quantity) || 1;
    const av = availability(a.assetId, payload.start, payload.end, qty);
    if (!av.ok) throw new Error('申し訳ありません。' + av.reason);

    const cat = getCategory(a.categoryId);
    const reservationId = genId('R', 'reservations', 'reservationId');
    const r = {
      reservationId: reservationId,
      assetId: a.assetId, vehicleId: a.assetId,
      assetName: a.name, vehicleName: a.name,
      categoryId: a.categoryId, locationId: payload.locationId || a.locationId,
      quantity: qty,
      customerName: payload.customerName || '',
      customerEmail: payload.customerEmail || '',
      customerPhone: payload.customerPhone || '',
      company: payload.company || '',
      licenseNo: payload.licenseNo || '',
      memberId: payload.memberId || null,
      start: payload.start, end: payload.end,
      optionIds: payload.optionIds || [],
      options: payload.options || [],
      payment: { method: payload.paymentMethod || 'onsite', status: 'unpaid' },
      price: payload.price || { total: 0, breakdown: [] },
      couponId: payload.couponId || null,
      status: 'confirmed',
      pointGranted: false,
      invoiceId: null,
      licenseConfirmed: !!payload.licenseConfirmed,
      note: payload.note || '',
      createdAt: new Date().toISOString()
    };
    const arr = list('reservations');
    arr.push(r);
    saveList('reservations', arr);

    // クーポンを使用済みにする
    if (r.couponId && r.memberId) {
      const m = findById('members', 'memberId', r.memberId);
      if (m) {
        const c = (m.coupons || []).find(x => x.couponId === r.couponId);
        if (c) { c.usedAt = new Date().toISOString(); c.usedFor = reservationId; }
        upsert('members', 'memberId', m);
      }
    }
    notify('reservation', '新規予約 ' + reservationId + ' (' + a.name + ' / ' + r.customerName + ' 様) を受け付けました。確認メールを送信しました', reservationId);
    return r;
  }

  function updateReservation(reservationId, updates) {
    const arr = list('reservations');
    const i = arr.findIndex(r => r.reservationId === reservationId);
    if (i < 0) return null;
    const before = arr[i];
    const after = Object.assign({}, before, updates);
    arr[i] = after;
    saveList('reservations', arr);

    if (updates.status && updates.status !== before.status) {
      const labels = { confirmed: '確定', in_use: '貸出中', returned: '返却済', cancelled: 'キャンセル' };
      notify('status', '予約 ' + reservationId + ' の状態を「' + (labels[updates.status] || updates.status) + '」に変更しました。通知メールを送信しました', reservationId);
      // 返却完了 → ポイント付与 (会員のみ・重複防止)
      if (updates.status === 'returned' && after.memberId && !after.pointGranted) {
        grantPointForReservation(after);
        arr[i].pointGranted = true;
        saveList('reservations', arr);
      }
    }
    return arr[i];
  }

  // ===== 会員・ポイント・クーポン =====
  function pointSettings() {
    return read('settings.points', { pointPerUse: 1, couponThreshold: 10, couponAmount: 1000, expiryMonths: 12 });
  }
  function members() { return list('members'); }
  function getMember(id) { return findById('members', 'memberId', id); }
  function findMemberByEmail(email) {
    return list('members').find(m => (m.email || '').toLowerCase() === String(email || '').toLowerCase()) || null;
  }

  function registerMember(payload) {
    if (!payload.email || !payload.password) throw new Error('メールアドレスとパスワードは必須です');
    if (findMemberByEmail(payload.email)) throw new Error('このメールアドレスは既に登録されています');
    const m = {
      memberId: genId('M', 'members', 'memberId'),
      name: payload.name || '', nameKana: payload.nameKana || '',
      email: payload.email, phone: payload.phone || '',
      password: payload.password, // デモ実装 (本番はハッシュ化必須)
      company: payload.company || '', isCorporate: !!payload.company,
      invoiceAllowed: false,
      points: 0, coupons: [], pointHistory: [],
      createdAt: new Date().toISOString(), lastUseAt: null
    };
    upsert('members', 'memberId', m);
    notify('member', '新規会員登録: ' + m.name + ' 様 (' + m.email + ')。登録確認メールを送信しました', m.memberId);
    return m;
  }
  function loginMember(email, password) {
    const m = findMemberByEmail(email);
    if (!m || m.password !== password) return null;
    sessionStorage.setItem(PREFIX + 'memberSession', JSON.stringify({ memberId: m.memberId, at: new Date().toISOString() }));
    return m;
  }
  function logoutMember() { sessionStorage.removeItem(PREFIX + 'memberSession'); }
  function currentMember() {
    try {
      const s = JSON.parse(sessionStorage.getItem(PREFIX + 'memberSession') || 'null');
      if (!s) return null;
      return expirePointsIfNeeded(getMember(s.memberId));
    } catch (e) { return null; }
  }

  // ポイント有効期限 (最終利用日から expiryMonths ヶ月で失効)
  function expirePointsIfNeeded(m) {
    if (!m || !m.lastUseAt || !m.points) return m;
    const cfg = pointSettings();
    const limit = new Date(m.lastUseAt);
    limit.setMonth(limit.getMonth() + (cfg.expiryMonths || 12));
    if (new Date() > limit && m.points > 0) {
      m.pointHistory = m.pointHistory || [];
      m.pointHistory.push({ at: new Date().toISOString(), delta: -m.points, reason: '有効期限切れによる失効' });
      m.points = 0;
      upsert('members', 'memberId', m);
    }
    return m;
  }

  function adjustPoints(memberId, delta, reason) {
    const m = getMember(memberId);
    if (!m) return null;
    m.points = Math.max(0, (m.points || 0) + delta);
    m.pointHistory = m.pointHistory || [];
    m.pointHistory.push({ at: new Date().toISOString(), delta: delta, reason: reason || '管理者操作' });
    if (delta > 0) m.lastUseAt = new Date().toISOString();
    upsert('members', 'memberId', m);
    maybeIssueCoupon(m);
    return getMember(memberId);
  }

  function grantPointForReservation(reservation) {
    const cfg = pointSettings();
    adjustPoints(reservation.memberId, cfg.pointPerUse || 1, '予約 ' + reservation.reservationId + ' 返却完了');
  }

  // 累計ポイントがしきい値到達 → クーポン自動発行 & ポイント消費
  function maybeIssueCoupon(m) {
    const cfg = pointSettings();
    const threshold = cfg.couponThreshold || 10;
    let member = getMember(m.memberId);
    while (member.points >= threshold) {
      member.points -= threshold;
      member.coupons = member.coupons || [];
      const couponId = 'CP' + Date.now() + Math.floor(Math.random() * 1000);
      member.coupons.push({
        couponId: couponId, amount: cfg.couponAmount || 1000,
        issuedAt: new Date().toISOString(), usedAt: null, usedFor: null,
        reason: 'ポイント' + threshold + 'pt 到達特典'
      });
      member.pointHistory.push({ at: new Date().toISOString(), delta: -threshold, reason: 'クーポン発行 (¥' + (cfg.couponAmount || 1000).toLocaleString() + ') に交換' });
      upsert('members', 'memberId', member);
      notify('coupon', member.name + ' 様に ¥' + (cfg.couponAmount || 1000).toLocaleString() + ' クーポンを自動発行しました。案内メールを送信しました', member.memberId);
      member = getMember(m.memberId);
    }
  }

  function issueCouponManually(memberId, amount, reason) {
    const m = getMember(memberId);
    if (!m) return null;
    m.coupons = m.coupons || [];
    m.coupons.push({
      couponId: 'CP' + Date.now(), amount: amount,
      issuedAt: new Date().toISOString(), usedAt: null, usedFor: null,
      reason: reason || '管理者発行'
    });
    upsert('members', 'memberId', m);
    notify('coupon', m.name + ' 様に ¥' + Number(amount).toLocaleString() + ' クーポンを発行しました', memberId);
    return m;
  }

  function unusedCoupons(memberId) {
    const m = getMember(memberId);
    return m ? (m.coupons || []).filter(c => !c.usedAt) : [];
  }

  // ===== 請求書 =====
  function invoices() { return list('invoices'); }
  function createInvoice(payload) {
    const m = getMember(payload.memberId);
    if (!m) throw new Error('会員が見つかりません');
    if (!m.invoiceAllowed) throw new Error('この会員には請求書払い許可がありません');
    const rIds = payload.reservationIds || [];
    if (!rIds.length) throw new Error('対象予約を選択してください');
    const rs = list('reservations').filter(r => rIds.indexOf(r.reservationId) >= 0);
    const amount = rs.reduce((s, r) => s + ((r.price && r.price.total) || 0), 0);
    const invoiceId = 'INV-' + String(list('invoices').length + 1).padStart(4, '0');
    const due = new Date(); due.setMonth(due.getMonth() + 1);
    const inv = {
      invoiceId: invoiceId, memberId: m.memberId,
      company: payload.company || m.company || m.name,
      address: payload.address || '',
      caseName: payload.caseName || 'レンタル料金 一式',
      reservationIds: rIds, amount: amount,
      status: 'unpaid', issuedAt: new Date().toISOString(),
      dueDate: payload.dueDate || due.toISOString(), paidAt: null
    };
    upsert('invoices', 'invoiceId', inv);
    // 予約に請求書IDを紐付け
    const arr = list('reservations');
    arr.forEach(r => { if (rIds.indexOf(r.reservationId) >= 0) r.invoiceId = invoiceId; });
    saveList('reservations', arr);
    notify('invoice', '請求書 ' + invoiceId + ' (' + inv.company + ' / ¥' + amount.toLocaleString() + ') を発行しました', invoiceId);
    return inv;
  }
  function setInvoiceStatus(invoiceId, status) {
    const inv = findById('invoices', 'invoiceId', invoiceId);
    if (!inv) return null;
    inv.status = status;
    inv.paidAt = status === 'paid' ? new Date().toISOString() : null;
    upsert('invoices', 'invoiceId', inv);
    // 紐付く予約の入金状態も同期
    const arr = list('reservations');
    arr.forEach(r => { if (r.invoiceId === invoiceId) r.payment.status = status === 'paid' ? 'paid' : 'unpaid'; });
    saveList('reservations', arr);
    return inv;
  }

  // ===== 状態ラベル =====
  const STATUS_LABELS = { confirmed: '確定', in_use: '貸出中', returned: '返却済', cancelled: 'キャンセル' };
  const PAYMENT_LABELS = { onsite: '現地決済', invoice: '請求書払い', online: 'オンライン決済' };

  // ===================================================================
  // 初期化 & 公開
  // ===================================================================
  ensureSeeded();

  window.SkyRentStore = {
    PREFIX: PREFIX,
    DATA_VERSION: DATA_VERSION,
    read: read, write: write,
    list: list, saveList: saveList, findById: findById, upsert: upsert, removeById: removeById, genId: genId,
    categories: categories, getCategory: getCategory,
    locations: locations, getLocation: getLocation,
    assets: assets, getAsset: getAsset,
    optionsForCategory: optionsForCategory,
    availability: availability, searchAvailable: searchAvailable, reservedQty: reservedQty,
    createReservation: createReservation, updateReservation: updateReservation,
    members: members, getMember: getMember, findMemberByEmail: findMemberByEmail,
    registerMember: registerMember, loginMember: loginMember, logoutMember: logoutMember, currentMember: currentMember,
    adjustPoints: adjustPoints, issueCouponManually: issueCouponManually, unusedCoupons: unusedCoupons,
    pointSettings: pointSettings,
    invoices: invoices, createInvoice: createInvoice, setInvoiceStatus: setInvoiceStatus,
    notify: notify, notifications: function () { return list('notifications'); },
    STATUS_LABELS: STATUS_LABELS, PAYMENT_LABELS: PAYMENT_LABELS
  };
})();
