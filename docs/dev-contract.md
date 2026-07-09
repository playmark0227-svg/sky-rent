# Sky Rent 開発コントラクト (内部規約 / API仕様)

全ページはこの規約に従って実装する。**このファイルが唯一の正**。

## スクリプト読み込み順 (必須)

公開サイト (ルート直下のページ):
```html
<script src="js/config.js"></script>
<script src="js/store.js"></script>
<script src="js/pricing.js"></script>
<script src="js/i18n.js"></script>
<script src="js/api.js"></script>
```

管理画面 (manage/ 配下のページ):
```html
<script src="partials.js"></script>
<script src="../js/config.js"></script>
<script src="../js/store.js"></script>
<script src="../js/pricing.js"></script>
<script src="../js/api.js"></script>
```
管理画面は `<body>` 直後に `<div data-include="topbar"></div>`、CSS は `css/manage.css`。
公開サイトの CSS は `css/style.css` + `css/public.css`(新規追加分)。

## データモデル (localStorage / window.SkyRentStore)

すべて `sky-rent.` プレフィックス。**直接 localStorage を触らず、必ず SkyRentStore 経由で読む・書く。**

### categories (カテゴリ / EAV定義)
```js
{ categoryId: 'cat-kitchen', name: 'キッチンカー', nameEn: 'Kitchen Car',
  type: 'vehicle'|'item',      // item = 物品単体レンタル (家電・工具)
  icon: '🍳', sort: 2, active: true, description: '…',
  customFieldDefs: [           // カテゴリ固有のカスタム項目定義 (管理画面から編集可能)
    { key: 'sinks', label: 'シンク数', type: 'text'|'number'|'select',
      unit: '槽', options: ['…'](selectのみ), filterable: true|false }
  ] }
```
シード: cat-rental(一般レンタカー) / cat-kitchen / cat-camping / cat-special(特殊車両) / cat-appliance(家電, item) / cat-tool(工具, item)

### locations (4拠点)
```js
{ locationId: 'loc-sapporo', name: '札幌本店', nameEn, tel, address, hours: '9:00-19:00', holiday: '水曜定休', sort }
```
シード: loc-sapporo / loc-chitose / loc-asahikawa / loc-hakodate

### assets (車両・物品 統合マスタ)
```js
{ assetId: 'K001', categoryId, locationId, name, nameEn, plate, capacity,
  priceHour, priceDay, priceWeek, priceMonth,   // null 可。priceDay は必須
  stock: 1,                    // 物品は在庫数 (>1可)。車両は常に 1
  requiredLicense: '',         // 例 '準中型免許以上'。空なら不要
  image: '🚗',                 // 絵文字 or 画像URL
  active: true,
  shakenDate: ISO|null, maintenanceDate: ISO|null,   // 車検・点検期限 (車両のみ)
  customFields: { sinks: 2, power: 3000 } }          // categoryのcustomFieldDefsに対応
```

### options (オプション2階層)
```js
{ optionId: 'OP101', name: '発電機 (2.8kVA)', price: 4400,
  priceType: 'per_day'|'per_rental',
  categoryIds: null | ['cat-kitchen'],   // null = 共通オプション (全車両カテゴリ)
  active: true }
```

### members (会員)
```js
{ memberId: 'M001', name, nameKana, email, phone, password(デモ平文),
  company: '', isCorporate: false,
  invoiceAllowed: false,      // 請求書払い許可フラグ (管理者のみ付与)
  points: 8,
  coupons: [{ couponId, amount: 1000, issuedAt, usedAt: null, usedFor: null, reason }],
  pointHistory: [{ at, delta, reason }],
  createdAt, lastUseAt }
```
デモ会員: demo@example.com / demo1234 (一般) と corp@example.com / demo1234 (法人・請求書払い許可)

### reservations (予約)
```js
{ reservationId: 'R0001',
  assetId, vehicleId(=assetIdの旧互換), assetName, vehicleName(旧互換),
  categoryId, locationId, quantity,
  customerName, customerEmail, customerPhone, company, licenseNo,
  memberId: null|'M001',
  start: ISO, end: ISO,
  optionIds: [], options: [{optionId, name, price, priceType}],
  payment: { method: 'onsite'|'invoice', status: 'unpaid'|'paid' },
  price: { total, breakdown|lines: [{label, amount}], … },
  couponId: null, status: 'confirmed'|'in_use'|'returned'|'cancelled',
  pointGranted: false, invoiceId: null, licenseConfirmed: false,
  note, createdAt }
```

### invoices (請求書)
```js
{ invoiceId: 'INV-0001', memberId, company, address, caseName,
  reservationIds: [], amount, status: 'unpaid'|'paid',
  issuedAt, dueDate, paidAt }
```

### settings
- `SkyRentStore.pointSettings()` → `{pointPerUse, couponThreshold, couponAmount, expiryMonths}` (キー `settings.points`)
- `SkyRentStore.read('settings.billing', {})` → `{bankName, accountType, accountNo, holder}` (振込先)

## SkyRentStore メソッド (同期)

- `list(entity)` / `saveList(entity, arr)` / `upsert(entity, idField, obj)` / `removeById(entity, idField, id)` / `genId(prefix, entity, idField)`
- `categories(includeInactive?)`, `getCategory(id)`, `locations()`, `getLocation(id)`
- `assets({categoryId?, locationId?, activeOnly?, type?})`, `getAsset(id)`
- `optionsForCategory(categoryId)` → `{common: [], specific: []}` (物品カテゴリは common=[])
- `availability(assetId, start, end, qty, excludeResId?)` → `{ok, remaining, stock, reason}`
- `searchAvailable({categoryId?, locationId?, start?, end?, quantity?, filters?})` → assets配列 + 各要素に `.availability`
  - filters: `{customFieldKey: value}`。number型は「以上」、select/textは完全一致
- `createReservation(payload)` → 予約 (空き検証・クーポン消費・通知ログ込み)。payload: `{assetId, quantity, customerName, customerEmail, customerPhone, company, licenseNo, memberId, start, end, optionIds, options, paymentMethod, price, couponId, licenseConfirmed, note}`
- `updateReservation(id, updates)` — `status: 'returned'` にすると会員へ自動ポイント付与+10pt到達でクーポン自動発行
- `registerMember(payload)` / `loginMember(email, pw)` / `logoutMember()` / `currentMember()`
- `adjustPoints(memberId, delta, reason)` / `issueCouponManually(memberId, amount, reason)` / `unusedCoupons(memberId)`
- `invoices()` / `createInvoice({memberId, reservationIds, company, address, caseName, dueDate?})` / `setInvoiceStatus(id, 'paid'|'unpaid')`
- `notify(type, message, refId)` / `notifications()`
- `STATUS_LABELS` = {confirmed:'確定', in_use:'貸出中', returned:'返却済', cancelled:'キャンセル'}
- `PAYMENT_LABELS` = {onsite:'現地決済', invoice:'請求書払い'}

## SkyRentPricing (同期)

```js
SkyRentPricing.calculate({ asset, start, end, quantity, options: [optionObj], coupon: {amount}|null })
// → { lines: [{label, amount}], days, hours, plan, subtotal, discount, total }
```
時間貸し(<24h)/日貸し/週割(≥7日)/月割(≥30日)を自動選択。ハイシーズン加算は `sky-rent.high-season` を自動参照。

## SkyRentAPI (Promise / 公開サイト・旧管理画面用)

`listCategories() / listLocations() / listVehicles(filter?) / listAssets(filter?) / getAsset(id) / listOptions(categoryId) / search(params) / checkAvailability(start,end) / createReservation(payload) / listReservations(from?,to?) / updateReservation(id,updates) / getDashboard(dateStr?,locationId?) / listCustomers() / getRevenue()`

`getDashboard` の戻り: `{date, bookings, departures, returns, weekly, byLocation:[{locationId,name,departures,returns,inUse}], unprocessed:[予約], salesMonth, shaken, notifications}`

## SkyRentI18n (公開サイトのみ)

- HTML: `data-i18n="key"` / `data-i18n-placeholder="key"`。言語トグルボタンは `<button data-lang-toggle></button>`
- JS: `SkyRentI18n.t('key')`, `.getLang()`, `.setLang('en')`。言語変更イベント: `document` の `sky-rent:langchange`
- 動的描画するテキストも極力 `t()` を使う。データ (資産名等) は日本語のまま、nameEn があれば `getLang()==='en'` 時に併用可

## コーディング規約

- 素の HTML/CSS/JS (フレームワーク・ビルド不使用)。IIFE で囲む。`const $ = s => document.querySelector(s);`
- **ユーザー入力・データ由来の文字列は必ず `esc()` で HTML エスケープ**:
  `function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}`
- 金額表示: `'¥' + n.toLocaleString()`
- 日時表示: `YYYY/MM/DD HH:mm`
- 管理画面のモーダルは `.crud-modal / .crud-modal-bg / .crud-modal-card / .crud-modal-head / .crud-modal-foot` クラス (manage.css 定義済) を再利用
- ステータスバッジ: `.status.status-confirmed / .status-in_use / .status-returned / .status-cancelled`
- 印刷対象ページは `@media print` で不要要素 (`.topbar`, `.no-print`) を隠す
- モバイル: manage.css のレスポンシブ規約に従う (テーブルは `.card` 内横スクロール)
