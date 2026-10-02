/**
 * グロースレンタカー - 統合データストア
 *
 * 要件定義書 v3.0 (2026-06-26) 準拠のデータ層。
 *   - 車両を対象とした「アセット」モデル。家電などの装備品は、車両の予約に追加するオプションと、
 *     家電だけのレンタル (カテゴリ cat-appliance = type 'item'。アセット A001 は北見本店の受け取り窓口) で貸す
 *   - カテゴリごとのカスタム項目 (EAV/JSON方式) — 管理画面から自由に定義可能
 *   - 拠点 (北見本店) / オプション2階層 (共通 = 装備オプション・カテゴリ専用 = 補償) /
 *     車両の空き判定 (重なり禁止) / 家電 (装備オプション) の在庫判定 (options[].stock。車両のオプションと
 *     家電だけの予約で同じ在庫を使う。家電レンタルの窓口には重なり禁止をかけない)
 *   - 会員・ポイント・クーポン制度 / 請求書払い (法人・行政のみ)
 *   - 通知ログ (メール送信のデモ代替)
 *
 * ストレージ:
 *   デモモード (js/config.js の SUPABASE_URL が空) … localStorage。これまでどおり。
 *   本番モード (SUPABASE_URL と SUPABASE_ANON_KEY あり) … このタブのメモリだけ。
 *     シードは投入せず、localStorage / sessionStorage に業務データを書かない。
 *     データは js/backend.js がサーバーから読み込んで _hydrate() で入れ、
 *     画面からの書き込みは _setWriteHook() で登録された関数がサーバーへ反映する。
 * すべてのキーは 'sky-rent.' プレフィックス。
 */
(function () {
  'use strict';
  const PREFIX = 'sky-rent.';
  const DATA_VERSION = 10;
  const DAY = 86400000;
  const CONFIG = window.SKY_RENT_CONFIG || {};
  const LIVE = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

  // GitHub Pages では同じアカウント配下のサイトが同一オリジンになり、
  // localStorage の容量を共有する。容量不足やプライバシー設定で永続化
  // できない場合もデモを止めないよう、このタブ内のメモリへ退避する。
  // 本番モードでは常にメモリだけを使う。
  const memory = new Map();
  let persistentWritesEnabled = !LIVE;
  let storageWarningShown = false;
  let writeHook = null;
  let extraAvailabilityCheck = null;

  function warnStorage(e) {
    if (storageWarningShown) return;
    storageWarningShown = true;
    console.warn('localStorage を利用できないため、このタブでは一時メモリで動作します。', e);
  }

  // ===== 低レベル入出力 =====
  function read(key, fallback) {
    if (memory.has(key)) {
      try { return JSON.parse(memory.get(key)); } catch (e) { return fallback; }
    }
    if (LIVE) return fallback;
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      persistentWritesEnabled = false;
      warnStorage(e);
      return fallback;
    }
  }
  function memorySet(key, val) {
    const raw = JSON.stringify(val);
    if (raw === undefined) memory.delete(key); else memory.set(key, raw);
    return raw;
  }
  function write(key, val) {
    const prev = writeHook ? read(key, undefined) : undefined;
    const raw = memorySet(key, val);
    if (persistentWritesEnabled && raw !== undefined) {
      try {
        localStorage.setItem(PREFIX + key, raw);
      } catch (e) {
        persistentWritesEnabled = false;
        warnStorage(e);
      }
    }
    if (writeHook) {
      // フックには画面側と共有しないコピーを渡す
      try { writeHook(key, raw === undefined ? undefined : JSON.parse(raw), prev); }
      catch (e) { console.error('SkyRentStore write hook failed', key, e); }
    }
    return val;
  }
  function remove(key) {
    const prev = writeHook ? read(key, undefined) : undefined;
    memory.delete(key);
    if (!LIVE) {
      try {
        localStorage.removeItem(PREFIX + key);
      } catch (e) {
        persistentWritesEnabled = false;
        warnStorage(e);
      }
    }
    if (writeHook) {
      try { writeHook(key, undefined, prev); }
      catch (e) { console.error('SkyRentStore write hook failed', key, e); }
    }
  }

  // サーバーから読み込んだ値を入れる (書込フックを通さない・永続化しない)
  function hydrate(values) {
    if (!values || typeof values !== 'object') return;
    Object.keys(values).forEach(key => { memorySet(key, values[key]); });
  }
  // fn(key, next, prev): write() のたびに呼ばれる (本番の管理画面でサーバーへ反映する)
  function setWriteHook(fn) { writeHook = typeof fn === 'function' ? fn : null; }
  // fn(asset, start, end) -> {ok, reason} | null : availability() の最後に適用する追加判定
  function setExtraAvailabilityCheck(fn) { extraAvailabilityCheck = typeof fn === 'function' ? fn : null; }

  // ===== 日時 (日本時間) =====
  // 画面の datetime-local の値 ('YYYY-MM-DDTHH:MM'。タイムゾーン表記なし) は、端末のタイムゾーンに
  // 関係なく日本時間として扱う。解釈は SkyRentPricingCore.toMs (料金計算と同じ規則) に任せる
  // (このファイルは pricing-core.js より先に読み込まれるので、呼ばれた時点で探す)。
  const JST_OFFSET = 9 * 3600000;
  const DATE_TEXT_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string') return NaN;
    const s = v.trim();
    const m = DATE_TEXT_RE.exec(s);
    if (m) {
      const time = m[4] ? 'T' + pad2(+m[4]) + ':' + m[5] + (m[6] ? ':' + m[6] + (m[7] ? '.' + m[7] : '') : '') : '';
      const iso = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) + time + (m[8] || '');
      const core = window.SkyRentPricingCore;
      if (core && typeof core.toMs === 'function') return core.toMs(iso);
      if (m[8]) return time ? Date.parse(iso) : NaN;
      return Date.parse(iso + (time ? '' : 'T00:00') + '+09:00');
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
    return s ? Date.parse(s) : NaN;  // Date#toString などタイムゾーン付きの文字列
  }
  // 解釈できる日時は ISO (UTC) にそろえる。できなければ元の値
  function isoOr(v) {
    const t = toMs(v);
    return isFinite(t) ? new Date(t).toISOString() : v;
  }

  // 「今日 (日本時間)」基準の相対日時 ISO (シードデータ用)。hour は日本時間の時
  function at(offsetDays, hour) {
    const today = Math.floor((Date.now() + JST_OFFSET) / DAY) * DAY - JST_OFFSET;  // 今日 0:00 (日本時間)
    return new Date(today + offsetDays * DAY + hour * 3600000).toISOString();
  }

  // ===================================================================
  // シードデータ
  // ===================================================================

  const SEED_CATEGORIES = [
    { categoryId: 'cat-rental', name: '一般レンタカー', nameEn: 'Rental Car', type: 'vehicle', icon: '🚗', sort: 1, active: true,
      description: '通勤・買い物・旅行・お仕事に。コンパクトからSUV・ミニバンまで。',
      customFieldDefs: [
        { key: 'bodyType', label: 'ボディタイプ', type: 'select', options: ['コンパクト', 'SUV', 'ミニバン'], filterable: true },
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
      ] },
    // 家電だけのレンタル (車を借りずに装備オプションの家電を借りる)。DATA_VERSION 9 で追加
    { categoryId: 'cat-appliance', name: '家電レンタル', nameEn: 'Appliance Rental', type: 'item', icon: '🔌', sort: 3, active: true,
      description: '車がなくても大丈夫。ポータブル電源や調理家電を、家電だけでお貸しします。北見本店でお受け取り・ご返却。',
      customFieldDefs: [] }
  ];

  const SEED_LOCATIONS = [
    // 貸出は北見本店のみ (DATA_VERSION 10 で釧路店を廃止)。スタッフはご予約のあるお時間のみ店舗にいる
    { locationId: 'loc-kitami',  name: '北見本店', nameEn: 'Kitami',  tel: '', address: '北海道北見市若葉4丁目6', hours: '9:00-19:00 (スタッフはご予約のお時間のみ)', holiday: 'なし (年中無休)', sort: 1 }
  ];

  const SEED_ASSETS = [
    { assetId: 'V001', categoryId: 'cat-rental', locationId: 'loc-kitami', name: '日産 ノート', nameEn: 'Nissan Note',
      plate: '', capacity: 5, priceHour: 1100, priceDay: 7700, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🚗', photo: 'images/cars/note-black.jpg', active: true,
      shakenDate: at(210, 0), maintenanceDate: at(40, 0),
      customFields: { bodyType: 'コンパクト', drive: '2WD', mission: 'AT', navi: '有', etc: '有' } },
    { assetId: 'V002', categoryId: 'cat-rental', locationId: 'loc-kitami', name: '日産 ノート e-POWER', nameEn: 'Nissan Note e-POWER',
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
    { assetId: 'K001', categoryId: 'cat-kitchen', locationId: 'loc-kitami', name: 'キッチンカー', nameEn: 'Kitchen Car',
      plate: '', capacity: 2, priceHour: null, priceDay: 22000, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🍳', photo: '', active: true,
      shakenDate: at(190, 0), maintenanceDate: at(55, 0),
      customFields: { kitchenSize: '2400×1800×1900mm', equipment: '2槽シンク・換気扇・作業台・給排水タンク・冷蔵庫', sinks: 2, power: 3000 } },
    // 家電レンタルの受け取り窓口 (家電そのものではない)。借りる家電は予約で装備オプションから選ぶ。
    //   料金 = 選んだ家電の料金の合計 (基本料金 0)。同じ時間に何件でも予約が入る (止めるのは家電ごとの在庫)
    { assetId: 'A001', categoryId: 'cat-appliance', locationId: 'loc-kitami', name: '家電レンタル（北見本店）', nameEn: 'Appliance Rental (Kitami)',
      plate: '', capacity: null, priceHour: null, priceDay: 0, priceWeek: null, priceMonth: null, stock: 1,
      requiredLicense: '', image: '🔌', photo: '', active: true, sort: 7,
      shakenDate: null, maintenanceDate: null,
      customFields: {} }
  ];
  // DATA_VERSION 9 で追加したカテゴリ・アセット (8 → 9 の移行で足す)
  const APPLIANCE_CATEGORY_ID = 'cat-appliance';
  const APPLIANCE_ASSET_ID = 'A001';

  // オプション: categoryIds = null → 共通 (全車両カテゴリ)。priceType: per_day | per_rental
  //   kind: 'cover' (補償。exclusiveGroup 'cover' で1つだけ) / 'other' (装備)
  //   includes: セットに含まれる品目。セットと中の品目は同時に選べない (pricing-core が OPTION_CONFLICT にする)
  //   stock: 同時に貸し出せる数 (null = 在庫を数えない)。家電は各1。家電セット (OP010) は null で、中の9品目の在庫を使う
  //   内容は supabase/seed.sql の options と同じ (料金は総合料金表 2026年6月改定版)。
  //   家電だけのレンタル (cat-appliance) でも、この装備オプション (categoryIds = null) を借りる家電として選ぶ
  const SEED_OPTIONS = [
    // 補償 (レンタカー)
    { optionId: 'OP101', name: '免責補償制度 (CDW)',   price: 1650, priceShort: 1100, priceType: 'per_day', categoryIds: ['cat-rental'], kind: 'cover', exclusiveGroup: 'cover', active: true, sort: 1, stock: null, description: '事故時の免責負担ゼロ (最大10万円)' },
    { optionId: 'OP102', name: '安心保証コース (PAP)', price: 3300, priceShort: 2200, priceType: 'per_day', categoryIds: ['cat-rental'], kind: 'cover', exclusiveGroup: 'cover', active: true, sort: 2, stock: null, description: '免責免除・NOC免除' },
    // 補償 (キッチンカー)
    { optionId: 'OP201', name: '免責補償制度 (CDW)',   price: 3300, priceShort: null, priceType: 'per_day', categoryIds: ['cat-kitchen'], kind: 'cover', exclusiveGroup: 'cover', active: true, sort: 3, stock: null, description: '事故時の免責負担ゼロ (最大10万円)' },
    { optionId: 'OP202', name: '安心保証コース (PAP)', price: 6600, priceShort: null, priceType: 'per_day', categoryIds: ['cat-kitchen'], kind: 'cover', exclusiveGroup: 'cover', active: true, sort: 4, stock: null, description: '免責免除・NOC免除' },
    // 装備オプション (全車共通・24時間ごと。短時間料金なし)
    { optionId: 'OP001', name: 'ポータブル冷蔵冷凍庫', price: 3300, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 11, stock: 1, description: 'アイリスオーヤマ IPD-4A-B' },
    { optionId: 'OP002', name: '電子レンジ',           price: 2200, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 12, stock: 1, description: 'パナソニック NE-FL1C-W' },
    { optionId: 'OP003', name: 'サーキュレーター',     price: 1100, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 13, stock: 1, description: 'アイリスオーヤマ KCF-SDC15T-EC-W' },
    { optionId: 'OP004', name: 'ポータブル電源',       price: 3300, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 14, stock: 1, description: 'Jackery JE-1800A' },
    { optionId: 'OP005', name: 'ドラムリール',         price: 1100, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 15, stock: 1, description: '日動工業 NR-304D-S' },
    { optionId: 'OP006', name: 'カセットコンロ',       price: 1100, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 16, stock: 1, description: '岩谷産業 CB-ODX1-BK' },
    { optionId: 'OP007', name: 'カセットボンベ',       price: 1100, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 17, stock: 1, description: '岩谷産業 CB-250-OR' },
    { optionId: 'OP008', name: '炊飯器',               price: 2200, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 18, stock: 1, description: 'タイガー魔法瓶 JPV-Y180KV' },
    { optionId: 'OP009', name: '電気ケトル',           price: 1100, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 19, stock: 1, description: '象印マホービン CK-VB15 BM' },
    { optionId: 'OP010', name: '家電セット (上記9点まとめ)', price: 11000, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 20, stock: null,
      description: 'ポータブル冷蔵冷凍庫〜電気ケトルの9点をまとめたセット',
      includes: ['OP001', 'OP002', 'OP003', 'OP004', 'OP005', 'OP006', 'OP007', 'OP008', 'OP009'] },
    { optionId: 'OP011', name: '集客セット',           price: 1100, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true, sort: 21, stock: 1, description: 'ホワイトボード・マグネット・ペン' }
  ];
  // DATA_VERSION 8 で再開した装備オプション (7 → 8 の移行で足す)
  const EQUIPMENT_OPTION_IDS = ['OP001', 'OP002', 'OP003', 'OP004', 'OP005', 'OP006', 'OP007', 'OP008', 'OP009', 'OP010', 'OP011'];

  // 公開中の法務文書 (supabase/seed.sql の legal_documents の有効な版と同じ。本番は public_catalog の legal)
  //   予約時の同意: 車両 = clause・cancel・privacy / 家電レンタル = item_clause・cancel・privacy
  //   cancel は 2026-10 版 (家電レンタルのキャンセル料の段階を足したため)。clause は 2026-10 版 (貸渡約款の改訂)
  const SEED_LEGAL = [
    { id: 'cancel',      version: '2026-10', title: 'キャンセル規定',           url: 'law.html#cancel', effectiveAt: '2026-10-01' },
    { id: 'clause',      version: '2026-10', title: '貸渡約款',                 url: 'clause.html',     effectiveAt: '2026-10-01' },
    { id: 'item_clause', version: '2026-10', title: '物品レンタル規約',         url: 'item-terms.html', effectiveAt: '2026-10-01' },
    { id: 'law',         version: '2026-10', title: '特定商取引法に基づく表記', url: 'law.html',        effectiveAt: '2026-10-01' },
    { id: 'privacy',     version: '2026-08', title: 'プライバシーポリシー',     url: 'privacy.html',    effectiveAt: '2026-08-01' }
  ];

  // 家電レンタル (DATA_VERSION 9) で料金ルールに足した項目 (supabase/seed.sql の pricing_rules・
  // pricing-core の DEFAULT_RULES と同じ値)。キャンセル料の段階はコンパクトカーと同じ割合・割増なし。
  //   料金ルールを管理画面で保存したデモ (settings.pricing_rules がある) では、8 → 9 の移行で無い項目だけを足す。
  //   保存していなければ料金エンジンの既定値 (DEFAULT_RULES) をそのまま使う
  const ITEM_PRICING_RULES = {
    version: '2026-10',
    itemSurcharges: false,
    categoryClass: { 'cat-appliance': 'item' },
    normal: { item: [{ minDays: 3, pct: 0 }, { minDays: 1, pct: 30 }, { minDays: 0, pct: 50 }] },
    busy:   { item: [{ minDays: 7, pct: 0 }, { minDays: 1, pct: 30 }, { minDays: 0, pct: 50 }] }
  };

  // 家電の在庫切れ (OPTION_SOLD_OUT) の案内 (サーバーの /api/reservations と同じ文)
  const SOLD_OUT_MESSAGE = 'お選びの家電のうち、ご希望の日時はすでに貸し出し中のものがあります。別の日時か別の家電をお選びください。';
  const SOLD_OUT_FIELD = 'ご希望の日時は貸し出し中の家電があります。';
  // 家電レンタルの窓口には貸出停止枠を作れない (管理画面の案内。サーバーの admin_create_reservation と同じ文)
  const ITEM_BLOCK_MESSAGE = '家電レンタルには貸出停止枠を作れません。家電ごとの在庫はオプション管理で変えてください。';

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

  // [開始offset, 日数, assetId, qty, 氏名, email, 電話, status, 支払方法, memberId, 備考, 登録offset, 借りる家電 (家電レンタルのみ)]
  const SEED_RESERVATION_ROWS = [
    [-25, 3, 'V003', 1, '田中 健一',   'tanaka@example.com',   '090-1010-2020', 'returned',  'onsite',  null,   '',                    -27],
    [-20, 2, 'K001', 1, '(株)北海道イベント企画', 'corp@example.com', '011-222-3333', 'returned', 'invoice', 'M002', '夏祭りイベント出店',   -25],
    [-15, 2, 'V001', 1, '鈴木 美咲',   'suzuki@example.com',   '080-2233-4455', 'cancelled', 'onsite',  null,   'お客様都合キャンセル', -17],
    [-10, 4, 'V004', 1, 'デモ 太郎',   'demo@example.com',     '090-0000-1111', 'returned',  'onsite',  'M001', '家族旅行',             -14],
    [ -8, 1, 'V001', 1, '山本工務店',   'yamamoto-k@example.com', '011-555-6677', 'returned', 'onsite',  null,   '現場への移動',         -9],
    [ -6, 2, 'V002', 1, '(株)北海道イベント企画', 'corp@example.com', '011-222-3333', 'returned', 'invoice', 'M002', '出張利用',         -8],
    [ -4, 2, 'V001', 1, '伊藤 翔太',   'ito-s@example.com',    '070-6677-8899', 'returned',  'onsite',  null,   '',                    -5],
    [ -1, 3, 'K001', 1, '中村 由美',   'nakamura@example.com', '090-7788-9900', 'in_use',    'onsite',  null,   'マルシェ出店 (貸出中)', -3],
    [ -1, 2, 'V003', 1, '小林 誠',     'kobayashi@example.com','080-8899-0011', 'in_use',    'onsite',  null,   '道東ドライブ (貸出中)', -2],
    [  0, 1, 'V004', 1, '加藤 健',     'kato@example.com',     '090-1212-3434', 'confirmed', 'onsite',  null,   '本日出発',             -1],
    [  0, 2, 'V001', 1, '吉田 直樹',   'yoshida@example.com',  '070-2323-4545', 'confirmed', 'onsite',  null,   '帰省',                  0],
    [  1, 2, 'V002', 1, '佐々木 玲奈', 'sasaki@example.com',   '080-3434-5656', 'confirmed', 'onsite',  null,   '',                    -1],
    [  2, 4, 'V001', 1, 'デモ 太郎',   'demo@example.com',     '090-0000-1111', 'confirmed', 'onsite',  'M001', '週末利用',              0],
    [  3, 2, 'V002', 1, '松本 浩二',   'matsumoto@example.com','090-4545-6767', 'confirmed', 'onsite',  null,   '観光',                 -2],
    [  5, 3, 'K001', 1, '井上 美穂',   'inoue@example.com',    '070-5656-7878', 'confirmed', 'onsite',  null,   'クレープ移動販売',      0],
    [  8, 2, 'V003', 1, '木村 拓也',   'kimura@example.com',   '080-6767-8989', 'confirmed', 'onsite',  null,   '出張',                 -1],
    [ 12, 2, 'V004', 1, '渡辺 さやか', 'watanabe@example.com', '090-7878-9090', 'confirmed', 'onsite',  null,   '記念日利用',            0],
    [ 14, 3, 'V002', 1, '高橋 大輔',   'takahashi@example.com','090-3344-5566', 'confirmed', 'onsite',  null,   '連休利用',              0],
    // 家電レンタル (DATA_VERSION 9 で追加。料金 = 家電の24時間ごとの料金 × 日数の合計)
    [-12, 2, 'A001', 1, '高田 美紀',   'takada@example.com',   '080-1357-2468', 'returned',  'onsite',  null,   'ホームパーティー',     -15, ['OP006', 'OP007']],
    [  9, 2, 'A001', 1, '森 和也',     'mori-k@example.com',   '090-2468-1357', 'confirmed', 'onsite',  null,   'キャンプで使用',        -1, ['OP004', 'OP001']]
  ];

  function buildSeedReservations() {
    const assetById = {};
    SEED_ASSETS.forEach(a => { assetById[a.assetId] = a; });
    const optionById = {};
    SEED_OPTIONS.forEach(o => { optionById[o.optionId] = o; });
    return SEED_RESERVATION_ROWS.map((row, i) => {
      const [off, dur, assetId, qty, name, email, phone, status, payMethod, memberId, note, createdOff, itemIds] = row;
      const a = assetById[assetId];
      const days = dur;
      // 家電レンタルは基本料金 0 で、借りる家電の料金 (24時間ごと) の合計
      const items = (itemIds || []).map(id => optionById[id]);
      const lines = items.length
        ? items.map(o => ({ code: 'option', optionId: o.optionId, label: o.name + ' (24時間 × ' + days + ')', amount: o.price * days }))
        : [{ label: '基本料金 ' + days + '日 × ' + qty, amount: (a.priceDay || 0) * days * qty }];
      const base = lines.reduce((s, l) => s + l.amount, 0);
      const price = items.length
        ? { total: base, base: 0, subtotal: base, breakdown: lines, lines: lines }
        : { total: base, breakdown: lines };
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
        licenseNo: items.length ? '' : '012345678900',   // 家電レンタルは運転免許の確認なし
        memberId: memberId,
        start: at(off, 10), end: at(off + dur, 10),
        optionIds: items.map(o => o.optionId),
        options: items.map(o => ({ optionId: o.optionId, name: o.name, price: o.price, priceType: o.priceType })),
        payment: { method: payMethod, status: status === 'returned' && payMethod === 'onsite' ? 'paid' : 'unpaid' },
        price: price,
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
        address: '北海道北見市大通西2-1', caseName: '夏祭りイベント キッチンカーレンタル',
        reservationIds: ['R0002'], amount: r2.price.total,
        status: 'paid', issuedAt: at(-18, 10), dueDate: at(12, 0), paidAt: at(-10, 10)
      });
      r2.invoiceId = 'INV-0001';
      r2.payment.status = 'paid';
    }
    if (r6) {
      inv.push({
        invoiceId: 'INV-0002', memberId: 'M002', company: '株式会社北海道イベント企画',
        address: '北海道北見市大通西2-1', caseName: '出張利用 レンタカー',
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
  // 7 → 8: 装備オプション (OP001〜OP011) の再開。予約・会員などのデータは消さず、オプションだけを直す
  //   - 装備オプションが無ければ末尾に足す (管理画面で編集・追加したオプションはそのまま)
  //   - 既存のオプションには、無い項目 (説明文・並び順など) だけを補う
  function migrateToV8() {
    const seedById = {};
    SEED_OPTIONS.forEach(o => { seedById[o.optionId] = o; });
    const current = list('options');
    const have = {};
    const next = current.map(o => {
      have[o.optionId] = true;
      const seed = seedById[o.optionId];
      return seed ? Object.assign({}, seed, o) : o;
    });
    EQUIPMENT_OPTION_IDS.forEach(id => { if (!have[id]) next.push(Object.assign({}, seedById[id])); });
    write('options', next);
  }

  // 8 → 9: 家電だけのレンタル。予約・会員・設定・管理画面で変えた値は消さず、足りないものだけを足す
  //   - カテゴリ cat-appliance・アセット A001 が無ければ末尾に足す
  //   - オプションに在庫 (stock) が無ければ足す (料金表の品目は seed の値、管理画面で追加したものは null = 数えない)
  //   - 法務文書: 無い文書を足し、seed より古い版 (cancel 2026-08 など) は seed の版にする
  //   - 保存済みの料金ルールに家電レンタルの項目を足す
  function migrateToV9() {
    if (!getCategory(APPLIANCE_CATEGORY_ID)) {
      write('categories', list('categories').concat([clone(SEED_CATEGORIES.find(c => c.categoryId === APPLIANCE_CATEGORY_ID))]));
    }
    if (!getAsset(APPLIANCE_ASSET_ID)) {
      write('assets', list('assets').concat([clone(SEED_ASSETS.find(a => a.assetId === APPLIANCE_ASSET_ID))]));
    }
    const seedStock = {};
    SEED_OPTIONS.forEach(o => { seedStock[o.optionId] = o.stock; });
    const options = list('options');
    if (options.some(o => o && !Object.prototype.hasOwnProperty.call(o, 'stock'))) {
      write('options', options.map(o => {
        if (!o || Object.prototype.hasOwnProperty.call(o, 'stock')) return o;
        return Object.assign({}, o, { stock: seedStock[o.optionId] !== undefined ? seedStock[o.optionId] : null });
      }));
    }
    seedLegal();
    patchPricingRules();
  }

  // 9 → 10: 貸出拠点を北見本店だけにし、軽トラックの取扱いをやめる。予約・会員などのデータは消さない
  //   - 釧路店を削除し、釧路店の車両・予約は北見本店へ移す
  //   - 北見本店の所在地・営業時間 (スタッフはご予約のお時間のみ) を、初期値のままなら新しい値にする
  //   - 軽トラック (V005) を削除し、その予約は同じ料金の日産 ノート (V001 → V002 の順で空いている方) へ移す。
  //     どちらも空いていなければ、取消済みにする (デモデータのため)
  //   - カテゴリのボディタイプ・料金ルールの区分・CDW の説明・貸渡約款の版を新しい値にする
  const OLD_LOCATION_ID = 'loc-kushiro';
  const OLD_KEI_TRUCK_ID = 'V005';
  function migrateToV10() {
    const kitami = SEED_LOCATIONS[0];
    write('locations', list('locations').filter(l => l && l.locationId !== OLD_LOCATION_ID).map(l => {
      if (l.locationId !== kitami.locationId) return l;
      const next = Object.assign({}, l);
      if (!next.address || next.address === '北海道北見市') next.address = kitami.address;
      if (!next.hours || next.hours === '9:00-19:00') next.hours = kitami.hours;
      return next;
    }));
    write('assets', list('assets').filter(a => a && a.assetId !== OLD_KEI_TRUCK_ID).map(a =>
      a.locationId === OLD_LOCATION_ID ? Object.assign({}, a, { locationId: kitami.locationId }) : a));
    const byId = {};
    list('assets').forEach(a => { byId[a.assetId] = a; });
    const active = r => r && r.kind !== 'block' && (r.status === 'confirmed' || r.status === 'in_use');
    const overlaps = (r, assetId, all) => all.some(x => x !== r && x.assetId === assetId && (active(x) || x.kind === 'block') &&
      Date.parse(x.start) < Date.parse(r.end) && Date.parse(r.start) < Date.parse(x.end));
    const reservations = list('reservations');
    reservations.forEach(r => {
      if (r.locationId === OLD_LOCATION_ID) r.locationId = kitami.locationId;
      if (r.assetId !== OLD_KEI_TRUCK_ID) return;
      const to = ['V001', 'V002'].find(id => byId[id] && (!active(r) || !overlaps(r, id, reservations)));
      if (to) {
        r.assetId = r.vehicleId = to;
        r.assetName = r.vehicleName = byId[to].name;
        r.locationId = byId[to].locationId;
      } else {
        r.status = 'cancelled';
        r.note = (r.note ? r.note + ' / ' : '') + '軽トラックの取扱い終了のため取消';
      }
    });
    write('reservations', reservations);
    write('notifications', list('notifications').map(n => n && typeof n.message === 'string'
      ? Object.assign({}, n, { message: n.message.replace('(軽トラック /', '(日産 ノート /') }) : n));
    write('invoices', list('invoices').map(v => v && v.caseName === '資材運搬 軽トラックレンタル'
      ? Object.assign({}, v, { caseName: '出張利用 レンタカー' }) : v));
    const seedRental = SEED_CATEGORIES.find(c => c.categoryId === 'cat-rental');
    write('categories', list('categories').map(c => {
      if (!c || c.categoryId !== 'cat-rental') return c;
      const next = clone(c);
      if (typeof next.description === 'string' && next.description.indexOf('軽トラック') >= 0) next.description = seedRental.description;
      (next.customFieldDefs || []).forEach(d => {
        if (d && Array.isArray(d.options)) d.options = d.options.filter(o => o !== '軽トラック');
      });
      return next;
    }));
    write('options', list('options').map(o => o && o.optionId === 'OP101' && o.description === '事故時の免責負担ゼロ (最大5万円)'
      ? Object.assign({}, o, { description: '事故時の免責負担ゼロ (最大10万円)' }) : o));
    const rules = read('settings.pricing_rules', null);
    if (rules && rules.cancellation && rules.cancellation.classOf && rules.cancellation.classOf['軽トラック']) {
      const next = clone(rules);
      delete next.cancellation.classOf['軽トラック'];
      write('settings.pricing_rules', next);
    }
    seedLegal();
  }

  // 法務文書: 無い文書を足し、seed より古い版を seed の版にする (新しい版・追加した文書はそのまま)
  function seedLegal() {
    const cur = read('legal', null);
    const docs = Array.isArray(cur) ? cur.slice() : [];
    SEED_LEGAL.forEach(seed => {
      const i = docs.findIndex(d => d && d.id === seed.id);
      if (i < 0) docs.push(clone(seed));
      else if (!docs[i].version || String(docs[i].version) < seed.version) docs[i] = clone(seed);
    });
    write('legal', docs);
  }

  // 保存済みの料金ルール (管理画面で繁忙期などを保存したもの) に、家電レンタルの項目が無ければ足す
  function patchPricingRules() {
    const r = read('settings.pricing_rules', null);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return;
    const next = clone(r);
    if (!next.version || String(next.version) < ITEM_PRICING_RULES.version) next.version = ITEM_PRICING_RULES.version;
    if (next.itemSurcharges === undefined) next.itemSurcharges = ITEM_PRICING_RULES.itemSurcharges;
    const C = next.cancellation = next.cancellation && typeof next.cancellation === 'object' ? next.cancellation : {};
    C.categoryClass = Object.assign({}, ITEM_PRICING_RULES.categoryClass, C.categoryClass || {});
    ['normal', 'busy'].forEach(k => {
      C[k] = C[k] && typeof C[k] === 'object' ? C[k] : {};
      if (!Array.isArray(C[k].item)) C[k].item = clone(ITEM_PRICING_RULES[k].item);
    });
    write('settings.pricing_rules', next);
  }

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function ensureSeeded() {
    const ver = read('dataVersion', 0);
    if (ver === DATA_VERSION) return;
    if (ver === 7 || ver === 8 || ver === 9) {
      if (ver === 7) migrateToV8();
      if (ver <= 8) migrateToV9();
      migrateToV10();
      write('dataVersion', DATA_VERSION);
      return;
    }
    // それより古いバージョンのデータキーを破棄 (settings.* は温存)
    ['vehicles', 'reservations', 'categories', 'locations', 'assets', 'options',
     'members', 'invoices', 'notifications', 'legal'].forEach(remove);
    write('categories', SEED_CATEGORIES);
    write('locations', SEED_LOCATIONS);
    write('assets', SEED_ASSETS);
    write('options', SEED_OPTIONS);
    write('legal', SEED_LEGAL);
    patchPricingRules();
    write('members', SEED_MEMBERS);
    const reservations = buildSeedReservations();
    const invoices = buildSeedInvoices(reservations);
    write('reservations', reservations);
    write('invoices', invoices);
    write('notifications', [
      { at: at(-1, 9), type: 'reservation', message: '新規予約 R0009 (マツダ CX-5 / 小林 誠 様) を受け付けました', refId: 'R0009' },
      { at: at(0, 8),  type: 'reservation', message: '新規予約 R0011 (日産 ノート / 吉田 直樹 様) を受け付けました', refId: 'R0011' }
    ]);
    // ポイント設定・振込先の既定値 (未設定時のみ)
    if (read('settings.points', null) == null) {
      write('settings.points', { enabled: false, pointPerUse: 1, couponThreshold: 10, couponAmount: 1000, expiryMonths: 12 });
    }
    if (read('settings.billing', null) == null) {
      write('settings.billing', { bankName: '北洋銀行 北見支店', accountType: '普通', accountNo: '1234567', holder: 'カ) スカイワードグロース' });
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

  // 家電レンタル (カテゴリの type = 'item') か。カテゴリが分からなければ車両として扱う
  function isItemCategory(categoryId) {
    const cat = categoryId != null ? getCategory(categoryId) : null;
    return !!cat && cat.type === 'item';
  }
  // asset: アセット (または ID)。予約 ({assetId, categoryId}) を渡してもよい
  function isItemAsset(asset) {
    const a = asset && typeof asset === 'object' ? asset : getAsset(asset);
    if (!a) return false;
    const fromAsset = a.assetId != null ? getAsset(a.assetId) : null;
    return isItemCategory(a.categoryId != null ? a.categoryId : (fromAsset ? fromAsset.categoryId : null));
  }
  // 料金エンジン (pricing-core) に渡す区分 'vehicle' | 'item'
  function categoryTypeOf(asset) { return isItemAsset(asset) ? 'item' : 'vehicle'; }

  // カテゴリに適用可能なオプション (共通 + 専用)
  //   共通 (categoryIds = null) = 装備オプション。家電レンタルでは、これが借りる家電になる
  //   専用 = 補償 (CDW/PAP。一般レンタカー・キッチンカー専用なので家電レンタルには出ない)
  function optionsForCategory(categoryId) {
    const all = list('options').filter(o => o.active !== false);
    return {
      common: all.filter(o => o.categoryIds == null),
      specific: all.filter(o => Array.isArray(o.categoryIds) && o.categoryIds.indexOf(categoryId) >= 0)
    };
  }

  // ===== 家電 (装備オプション) の在庫 =====
  //   options[].stock: 同時に貸し出せる数 (null = 数えない)。家電セットは中の品目 (includes) の在庫を使う。
  //   ある家電 X の使用数 = 期間内に同時に貸し出している数の最大値。数えるのは確定・貸出中の予約 (貸出停止枠を除く) で、
  //   選んだオプションを展開した集合 (選んだ id + セットの中の品目) に X を含むもの。車両の予約も家電だけの予約も数える。
  //   同時最大は「期間の開始時点」と「期間内に始まる各予約の開始時点」で数えた件数の最大
  //   (サーバーの public.option_sold_out / unavailable_option_ids と同じ数え方)。
  //   ※ 本番の公開ページの store には他のお客様の予約が無いので、在庫はサーバーの見積 (unavailableOptionIds) で判断する
  function optionIndex() {
    const m = {};
    list('options').forEach(o => { if (o && o.optionId != null) m[String(o.optionId)] = o; });
    return m;
  }
  function stockOf(o) {
    if (!o || o.stock == null || o.stock === '') return null;
    const n = Number(o.stock);
    return isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  }
  // 選んだ id + セットの中の品目 (重複なし・選んだ順)
  function expandOptionIds(ids, byId) {
    byId = byId || optionIndex();
    const out = [];
    const add = id => { const s = String(id); if (out.indexOf(s) < 0) out.push(s); };
    (Array.isArray(ids) ? ids : []).forEach(id => {
      if (id == null || id === '') return;
      add(id);
      const o = byId[String(id)];
      if (o && Array.isArray(o.includes)) o.includes.forEach(add);
    });
    return out;
  }
  function optionIdsOf(r) {
    if (Array.isArray(r.optionIds)) return r.optionIds;
    return Array.isArray(r.options) ? r.options.map(o => o && (o.optionId != null ? o.optionId : o.id)).filter(x => x != null) : [];
  }
  // 期間 [s, e) に重なる、家電を借りている確定・貸出中の予約 {s, e, ids (展開済み)}
  function rentalsWithOptions(s, e, excludeReservationId, byId) {
    return list('reservations')
      .filter(r => r && (r.kind || 'rental') === 'rental' && (r.status === 'confirmed' || r.status === 'in_use')
        && !(excludeReservationId != null && String(r.reservationId) === String(excludeReservationId)))
      .map(r => ({ s: toMs(r.start), e: toMs(r.end), ids: expandOptionIds(optionIdsOf(r), byId) }))
      .filter(x => x.ids.length && x.s < e && x.e > s);
  }
  // 期間の開始時点と、期間内に始まる各予約の開始時点で数えた件数の最大
  function maxConcurrent(optionId, rentals, s) {
    const rs = rentals.filter(x => x.ids.indexOf(optionId) >= 0);
    const points = [s].concat(rs.filter(x => x.s > s).map(x => x.s));
    return points.reduce((max, t) => Math.max(max, rs.filter(x => x.s <= t && t < x.e).length), 0);
  }

  /** 家電ごとの在庫 (在庫を数える家電だけ) → [{optionId, stock, used, remaining}] */
  function optionStock(start, end, excludeReservationId) {
    const s = toMs(start), e = toMs(end);
    if (!isFinite(s) || !isFinite(e) || e <= s) return [];
    const byId = optionIndex();
    const rentals = rentalsWithOptions(s, e, excludeReservationId, byId);
    return list('options').filter(o => o && stockOf(o) != null).map(o => {
      const id = String(o.optionId);
      const stock = stockOf(o);
      const used = maxConcurrent(id, rentals, s);
      return { optionId: id, stock: stock, used: used, remaining: Math.max(0, stock - used) };
    });
  }

  /** その期間に貸し出せない (残り0) 有効な家電の id (昇順)。家電セットは中の品目のどれかが残り0なら含める */
  function unavailableOptionIds(start, end, excludeReservationId) {
    const empty = optionStock(start, end, excludeReservationId).filter(x => x.remaining <= 0).map(x => x.optionId);
    const out = [];
    list('options').forEach(o => {
      const id = o && o.optionId != null ? String(o.optionId) : null;
      if (!id || o.active === false) return;
      if (empty.indexOf(id) >= 0 || (Array.isArray(o.includes) && o.includes.some(x => empty.indexOf(String(x)) >= 0))) out.push(id);
    });
    return out.sort();
  }

  /** 選んだ家電のうち在庫が足りないもの (昇順)。家電セットを選んでいれば、売り切れの品目を含むセット自身の id も入れる。足りていれば [] */
  function optionSoldOut(optionIds, start, end, excludeReservationId) {
    const s = toMs(start), e = toMs(end);
    if (!isFinite(s) || !isFinite(e) || e <= s) return [];
    const byId = optionIndex();
    const chosen = expandOptionIds(optionIds, byId).filter(id => stockOf(byId[id]) != null);
    if (!chosen.length) return [];
    const rentals = rentalsWithOptions(s, e, excludeReservationId, byId);
    const sold = chosen.filter(id => maxConcurrent(id, rentals, s) + 1 > stockOf(byId[id]));
    if (!sold.length) return [];
    (Array.isArray(optionIds) ? optionIds : []).forEach(id => {
      const o = byId[String(id)];
      if (o && Array.isArray(o.includes) && sold.indexOf(String(id)) < 0 && o.includes.some(x => sold.indexOf(String(x)) >= 0)) sold.push(String(id));
    });
    return sold.sort();
  }

  // 在庫切れのエラー (code / details.optionIds / fields はサーバーの OPTION_SOLD_OUT と同じ形)
  function soldOutError(ids) {
    const e = new Error(SOLD_OUT_MESSAGE);
    e.code = 'OPTION_SOLD_OUT';
    e.details = { optionIds: ids.slice() };
    e.fields = { optionIds: SOLD_OUT_FIELD };
    return e;
  }

  // ===== 空き状況 (車両=重複不可 / 家電レンタル=重なりは見ず、家電ごとの在庫と照合) =====
  function reservedQty(assetId, start, end, excludeReservationId) {
    const s = toMs(start), e = toMs(end);
    return list('reservations')
      .filter(r => String(r.assetId) === String(assetId)
        && r.status !== 'cancelled' && r.status !== 'no_show'
        && r.reservationId !== excludeReservationId
        && toMs(r.start) < e && toMs(r.end) > s)
      .reduce((sum, r) => sum + (Number(r.quantity) || 1), 0);
  }
  // optionIds (省略可): 選んだ家電。渡すと在庫も確かめ、足りなければ
  //   {ok: false, code: 'OPTION_SOLD_OUT', soldOut: [id...], reason: 案内文} を返す
  function availability(assetId, start, end, qty, excludeReservationId, optionIds) {
    const a = getAsset(assetId);
    if (!a) return { ok: false, remaining: 0, reason: '対象が見つかりません' };
    let result;
    if (isItemAsset(a)) {
      // 家電レンタルの窓口は同じ時間に何件でも予約を受け付ける (止めるのは家電ごとの在庫)
      result = { ok: true, remaining: 1, stock: 1, reason: '', item: true };
    } else {
      const stock = Number(a.stock) || 1;
      const used = reservedQty(assetId, start, end, excludeReservationId);
      const remaining = Math.max(0, stock - used);
      const need = Number(qty) || 1;
      result = {
        ok: remaining >= need,
        remaining: remaining,
        stock: stock,
        reason: remaining >= need ? '' : (stock > 1 ? '在庫不足 (残り' + remaining + ')' : '他の予約と重複しています')
      };
    }
    // 選んだ家電の在庫 (車両のオプションと家電だけの予約で同じ在庫を使う)
    if (result.ok && Array.isArray(optionIds) && optionIds.length) {
      const sold = optionSoldOut(optionIds, start, end, excludeReservationId);
      if (sold.length) {
        result.ok = false;
        result.remaining = 0;
        result.reason = SOLD_OUT_MESSAGE;
        result.code = 'OPTION_SOLD_OUT';
        result.soldOut = sold;
      }
    }
    // 追加判定 (本番: 受け渡し担当者の予定・受け渡し時刻の重複。家電レンタルも店頭で受け渡す)。在庫で予約可のときだけ見る
    if (result.ok && extraAvailabilityCheck) {
      let extra = null;
      try { extra = extraAvailabilityCheck(a, start, end); } catch (e) { console.error('availability check failed', e); }
      if (extra && extra.ok === false) {
        result.ok = false;
        result.remaining = 0;
        result.reason = extra.reason || '選択された日時はご予約いただけません';
        if (extra.code) result.code = extra.code;
      }
    }
    return result;
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
    if (!a) throw new Error('車両が見つかりません');
    const qty = Number(payload.quantity) || 1;
    // 家電レンタルは借りる家電を1つ以上 (サーバーの admin_create_reservation と同じ)
    if (isItemAsset(a) && !(Array.isArray(payload.optionIds) && payload.optionIds.length)) {
      const err = new Error('お借りになる家電を1つ以上お選びください。');
      err.code = 'ITEM_REQUIRED';
      err.fields = { optionIds: err.message };
      throw err;
    }
    // 車両の重なり (家電レンタルは見ない) と、選んだ家電の在庫
    const av = availability(a.assetId, payload.start, payload.end, qty, undefined, payload.optionIds || []);
    if (!av.ok) {
      if (av.code === 'OPTION_SOLD_OUT') throw soldOutError(av.soldOut);
      const err = new Error('申し訳ありません。' + av.reason);
      err.code = av.code || 'AVAILABILITY_CONFLICT';
      throw err;
    }

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
      start: isoOr(payload.start), end: isoOr(payload.end),
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

  // ===================================================================
  // 貸渡証 (= 貸渡簿の1行)。予約1件につき1つ (id = 予約番号)。本番は rental_records 表 (admin_save_rental_record)
  //   検査は DB と同じ: 文字数・数値の範囲・返却時メーター ≥ 貸出時メーター・返却日時 > 貸出日時・版 (version)
  // ===================================================================
  const RENTAL_RECORD_TEXT = {
    renterName: 100, renterAddress: 200, renterPhone: 30, driverName: 100, driverAddress: 200,
    licenseNo: 30, licenseType: 50, intlLicense: 100, vehicleName: 100, plate: 30,
    destination: 200, purpose: 200, pickupOffice: 100, returnOffice: 100, pickupPlace: 200, dropoffPlace: 200,
    accidentNote: 2000, cover: 200, optionsText: 1000, rentalItems: 1000, service: 500, payment: 100, remarks: 2000
  };
  const RENTAL_RECORD_INT = { passengers: [1, 99], odometerOut: [0, 9999999], odometerIn: [0, 9999999], baseFee: [0, 999999999], optionFee: [0, 999999999], total: [0, 999999999] };
  const RENTAL_RECORD_DATE = ['issuedOn', 'licenseExpiry', 'birthDate'];
  const RENTAL_RECORD_TS = ['start', 'end'];
  const RENTAL_RECORD_BOOL = { driverSame: true, accident: false };

  function rentalRecordError(code, message, field) {
    const err = new Error(message || code);
    err.code = code;
    if (field) err.fields = { [field]: message || code };
    return err;
  }
  function getRentalRecord(id) { return findById('rentalRecords', 'id', id) || null; }
  function listRentalRecords() { return list('rentalRecords'); }
  function saveRentalRecord(id, patch, version) {
    patch = patch || {};
    const r = findById('reservations', 'reservationId', id);
    if (!r) throw rentalRecordError('NOT_FOUND', '予約が見つかりません。');
    if (r.kind === 'block') throw rentalRecordError('VALIDATION', '貸出停止枠には貸渡証を作れません。');
    const cur = getRentalRecord(id);
    if (cur && version != null && Number(version) !== Number(cur.version)) throw rentalRecordError('VERSION_CONFLICT', '他のスタッフが先にこのデータを更新しました。');
    const next = Object.assign({ id: id, driverSame: true, accident: false, version: 0, createdAt: new Date().toISOString() }, cur || {});
    Object.keys(RENTAL_RECORD_TEXT).forEach(k => {
      if (patch[k] === undefined) return;
      const v = String(patch[k] == null ? '' : patch[k]).trim();
      if (v.length > RENTAL_RECORD_TEXT[k]) throw rentalRecordError('VALIDATION', RENTAL_RECORD_TEXT[k] + '文字以内で入力してください。', k);
      next[k] = v;
    });
    Object.keys(RENTAL_RECORD_INT).forEach(k => {
      if (patch[k] === undefined) return;
      const raw = patch[k] == null ? '' : String(patch[k]).trim();
      if (raw === '') { next[k] = null; return; }
      const [lo, hi] = RENTAL_RECORD_INT[k];
      if (!/^\d{1,9}$/.test(raw) || Number(raw) < lo || Number(raw) > hi) throw rentalRecordError('VALIDATION', lo + '〜' + hi + ' の数字で入力してください。', k);
      next[k] = Number(raw);
    });
    RENTAL_RECORD_DATE.forEach(k => {
      if (patch[k] === undefined) return;
      const v = patch[k] == null ? '' : String(patch[k]).trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw rentalRecordError('VALIDATION', '日付の形が正しくありません。', k);
      next[k] = v || null;
    });
    RENTAL_RECORD_TS.forEach(k => {
      if (patch[k] === undefined) return;
      next[k] = patch[k] ? isoOr(patch[k]) : null;
    });
    Object.keys(RENTAL_RECORD_BOOL).forEach(k => {
      if (patch[k] === undefined) return;
      next[k] = patch[k] == null ? RENTAL_RECORD_BOOL[k] : !!patch[k];
    });
    if (next.odometerOut != null && next.odometerIn != null && next.odometerIn < next.odometerOut) {
      throw rentalRecordError('VALIDATION', '返却時メーターは貸出時メーター以上の値にしてください。', 'odometerIn');
    }
    if (next.start && next.end && Date.parse(next.end) <= Date.parse(next.start)) throw rentalRecordError('INVALID_PERIOD', '返却日時は貸出日時より後にしてください。', 'end');
    next.distanceKm = next.odometerOut != null && next.odometerIn != null ? next.odometerIn - next.odometerOut : null;
    next.version = (Number(next.version) || 0) + 1;
    next.updatedAt = new Date().toISOString();
    upsert('rentalRecords', 'id', next);
    return next;
  }

  function updateReservation(reservationId, updates) {
    updates = updates || {};
    const arr = list('reservations');
    const i = arr.findIndex(r => r.reservationId === reservationId);
    if (i < 0) return null;
    const before = arr[i];
    const after = Object.assign({}, before, updates);
    // 画面の datetime-local の値 (日本時間) は ISO にそろえて持つ
    if (updates.start !== undefined) after.start = isoOr(after.start);
    if (updates.end !== undefined) after.end = isoOr(after.end);
    // 車両の予約 (貸出停止枠を含む) と家電レンタルの予約の間では付け替えない (サーバーの admin_update_reservation と同じ)
    if (after.assetId !== before.assetId && getAsset(after.assetId) &&
        isItemAsset(getAsset(after.assetId)) !== isItemAsset({ assetId: before.assetId, categoryId: before.categoryId })) {
      const err = new Error('車両の予約と家電レンタルの予約の間では付け替えできません。');
      err.code = 'VALIDATION';
      throw err;
    }
    // 日時 (または車両・家電) を変えたときや、取消・無断キャンセルから戻して有効な予約になるときは、
    // 家電の在庫を確かめる (自分自身は数えない)。足りなければ変更しない
    const active = x => x.status === 'confirmed' || x.status === 'in_use';
    const moved = toMs(after.start) !== toMs(before.start) || toMs(after.end) !== toMs(before.end) ||
      after.assetId !== before.assetId || JSON.stringify(optionIdsOf(after)) !== JSON.stringify(optionIdsOf(before)) ||
      !active(before);
    if (moved && (after.kind || 'rental') === 'rental' && active(after)) {
      const sold = optionSoldOut(optionIdsOf(after), after.start, after.end, reservationId);
      if (sold.length) throw soldOutError(sold);
    }
    arr[i] = after;
    saveList('reservations', arr);

    if (updates.status && updates.status !== before.status) {
      const labels = { confirmed: '確定', in_use: '貸出中', returned: '返却済', cancelled: 'キャンセル', no_show: '無断キャンセル' };
      notify('status', '予約 ' + reservationId + ' の状態を「' + (labels[updates.status] || updates.status) + '」に変更しました。通知メールを送信しました', reservationId);
      // 返却完了 → ポイント付与 (会員のみ・重複防止。ポイント制度を使っている間だけ)
      if (updates.status === 'returned' && after.memberId && !after.pointGranted && pointsEnabled()) {
        grantPointForReservation(after);
        arr[i].pointGranted = true;
        saveList('reservations', arr);
      }
    }
    return arr[i];
  }

  // ===== 会員・ポイント・クーポン =====
  function pointSettings() {
    return read('settings.points', { enabled: false, pointPerUse: 1, couponThreshold: 10, couponAmount: 1000, expiryMonths: 12 });
  }
  // ポイント制度を使うか (settings.points.enabled が true のときだけ。未設定は使わない = 2026-10 から一旦停止中)。
  //   使わない間は、返却でポイントを付けず、クーポンも発行しない (本番は DB のトリガーも同じ判定)。画面ではポイント・クーポンの案内を出さない
  function pointsEnabled() {
    const p = pointSettings();
    return !!(p && p.enabled === true);
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
    // 本番: パスワード照合はサーバー (SkyRentBackend.auth.signIn) が行う
    if (LIVE) return null;
    const m = findMemberByEmail(email);
    if (!m || m.password !== password) return null;
    sessionStorage.setItem(PREFIX + 'memberSession', JSON.stringify({ memberId: m.memberId, at: new Date().toISOString() }));
    return m;
  }
  function logoutMember() {
    if (LIVE) { memory.delete('memberSession'); return; }
    sessionStorage.removeItem(PREFIX + 'memberSession');
  }
  function currentMember() {
    try {
      if (LIVE) {
        // 本番: ログイン中の会員は backend が _hydrate({memberSession, members}) で入れる
        const ls = read('memberSession', null);
        return ls ? getMember(ls.memberId) : null;
      }
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
  //   ポイント制度の停止中は発行しない (サーバーの issue_coupons_if_needed と同じ)
  function maybeIssueCoupon(m) {
    if (!pointsEnabled()) return;
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
  const STATUS_LABELS = { confirmed: '確定', in_use: '貸出中', returned: '返却済', cancelled: 'キャンセル', no_show: '無断キャンセル' };
  const PAYMENT_LABELS = { onsite: '現地決済', invoice: '請求書払い', online: 'オンライン決済' };

  // ===================================================================
  // 初期化 & 公開
  // ===================================================================
  if (!LIVE) {
    try {
      ensureSeeded();
    } catch (e) {
      // 想定外の初期化失敗でも API 自体は公開し、空データで画面を継続する。
      console.error('SkyRentStore seed initialization failed', e);
    }
  }

  window.SkyRentStore = {
    PREFIX: PREFIX,
    DATA_VERSION: DATA_VERSION,
    live: LIVE,
    _hydrate: hydrate, _setWriteHook: setWriteHook, _setExtraAvailabilityCheck: setExtraAvailabilityCheck,
    read: read, write: write,
    getRentalRecord: getRentalRecord, listRentalRecords: listRentalRecords, saveRentalRecord: saveRentalRecord,
    list: list, saveList: saveList, findById: findById, upsert: upsert, removeById: removeById, genId: genId,
    categories: categories, getCategory: getCategory,
    locations: locations, getLocation: getLocation,
    assets: assets, getAsset: getAsset,
    isItemCategory: isItemCategory, isItemAsset: isItemAsset, categoryTypeOf: categoryTypeOf,
    optionsForCategory: optionsForCategory,
    availability: availability, searchAvailable: searchAvailable, reservedQty: reservedQty,
    // 家電 (装備オプション) の在庫
    expandOptionIds: function (ids) { return expandOptionIds(ids); },
    optionStock: optionStock, unavailableOptionIds: unavailableOptionIds, optionSoldOut: optionSoldOut,
    SOLD_OUT_MESSAGE: SOLD_OUT_MESSAGE, SOLD_OUT_FIELD: SOLD_OUT_FIELD, ITEM_BLOCK_MESSAGE: ITEM_BLOCK_MESSAGE,
    createReservation: createReservation, updateReservation: updateReservation,
    members: members, getMember: getMember, findMemberByEmail: findMemberByEmail,
    registerMember: registerMember, loginMember: loginMember, logoutMember: logoutMember, currentMember: currentMember,
    adjustPoints: adjustPoints, issueCouponManually: issueCouponManually, unusedCoupons: unusedCoupons,
    pointSettings: pointSettings, pointsEnabled: pointsEnabled,
    invoices: invoices, createInvoice: createInvoice, setInvoiceStatus: setInvoiceStatus,
    notify: notify, notifications: function () { return list('notifications'); },
    STATUS_LABELS: STATUS_LABELS, PAYMENT_LABELS: PAYMENT_LABELS
  };
})();
