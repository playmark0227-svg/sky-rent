# グロースレンタカー 開発コントラクト (内部規約 / API仕様)

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
  type: 'vehicle'|'item',      // 現在は vehicle のみ運用 (物品単体レンタルは提供していない)
  icon: '🍳', sort: 2, active: true, description: '…',
  customFieldDefs: [           // カテゴリ固有のカスタム項目定義 (管理画面から編集可能)
    { key: 'sinks', label: 'シンク数', type: 'text'|'number'|'select',
      unit: '槽', options: ['…'](selectのみ), filterable: true|false }
  ] }
```
シード: cat-rental(一般レンタカー) / cat-kitchen(キッチンカー)
※ type:'item' (物品カテゴリ) はデータモデル上の枠のみ。物品単体のレンタルは提供しておらず、取扱いは車両2カテゴリのみ。

### locations (拠点)
```js
{ locationId: 'loc-kitami', name: '北見本店', nameEn, tel, address, hours: '9:00-19:00', holiday: 'なし (年中無休)', sort }
```
シード: loc-sapporo / loc-chitose / loc-asahikawa / loc-hakodate

### assets (車両マスタ)
```js
{ assetId: 'K001', categoryId, locationId, name, nameEn, plate, capacity,
  priceHour, priceDay, priceWeek, priceMonth,   // null 可。priceDay は必須
  stock: 1,                    // 在庫数。車両は常に 1
  requiredLicense: '',         // 例 '準中型免許以上'。空なら不要
  image: '🚗',                 // 絵文字 or 画像URL
  active: true,
  shakenDate: ISO|null, maintenanceDate: ISO|null,   // 車検・点検期限 (車両のみ)
  customFields: { sinks: 2, power: 3000 } }          // categoryのcustomFieldDefsに対応
```

### options (オプション2階層)
```js
{ optionId: 'OP101', name: '免責補償制度 (CDW)', price: 1650,
  priceType: 'per_day'|'per_rental',
  categoryIds: null | ['cat-rental'],   // null = 共通オプション (全車両カテゴリ)
  active: true }
```
シードは補償オプションのみ: OP101/OP102 (cat-rental) / OP201/OP202 (cat-kitchen)。
装備品の貸し出しは行わないため、共通オプション (`categoryIds: null`) は現在 0 件。

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

---

## v3 デザイン (2026-08 / 黒 × オレンジ)

参考: BUDDICA TOURISM (tourism.buddica.jp) の配色・表示方法に寄せた。

- 配色トークン (css/style.css `:root`)
  - 地: `--ink #0a0a0a` / 節: `--ink-2 #111` / カード: `--ink-3 #161616` / 面: `--ink-4 #1e1e1e`
  - 罫: `--line #2a2a2a` / `--line-2 #383838`
  - 文字: `--color-text #fff` / `--color-muted #9a9a9a` / `--color-muted-2 #6d6d6d`
  - アクセント: `--color-primary #ff6a00` / `--color-primary-dark #e05c00`
- 書体: `--font-sans` = Noto Sans JP (見出し **900**)、`--font-num` = Barlow Condensed (英字ラベル・数値)
  ※ `--font-serif` は `--font-sans` のエイリアス。明朝は使わない。
- 見出しパターン: `<p class="eyebrow">ENGLISH</p><p class="eyebrow-jp">日本語</p><h2 class="section-title">…</h2>`

### 下層ページの雛形 (公開側)

```html
<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ページ名 | グロースレンタカー</title>
<link rel="stylesheet" href="css/style.css"><link rel="stylesheet" href="css/public.css">
</head><body>
  <header class="site-header">…共通ヘッダー…</header>
  <main class="container page-offset" style="padding-bottom:80px">
    <nav class="crumb"><a href="index.html">トップ</a><span>›</span><span>ページ名</span></nav>
    <div class="page-head"><p class="eyebrow">ENGLISH</p><h1>ページ名</h1><p>要約</p></div>
    <div class="doc-body">…本文…</div>
  </main>
  <footer class="site-footer">…共通フッター…</footer>
  <script src="js/config.js"></script><script src="js/store.js"></script>
  <script src="js/pricing.js"></script><script src="js/i18n.js"></script><script src="js/api.js"></script>
</body></html>
```

- 本文は `.doc-body` (h2 は左オレンジ罫、table・ul・ol・`.doc-note` を用意済み)
- 目次は `.toc`、FAQは `<details class="faq">`
- 追従CTAは `<a class="float-cta" href="search.html">` (js/lp.js 相当のトグルは各ページ任意)

### 会社・拠点の確定情報 (2026-08)

- 運営会社: **株式会社Skyward Growth**
- 所在地: 〒090-0042 北海道北見市北二条西2丁目8 KITAMI BASE内
- 代表取締役: 藤本 大地
- メール: daichi.fujimoto@skyward-growth.com
- 公式LINE: https://lin.ee/PuLt0Ig
- 拠点: 北見本店 / 釧路店 (※正式名称・TEL は確認中)
- 料金・キャンセル規定は「レンタカー 総合料金表 (2026年6月改定版)」に準拠

---

## 取り扱わないもの

以下はサービスとして提供していない。ページ・データ・オプションのいずれにも追加しないこと。

- **家電・装備品のレンタル**は行わない (オプションとしても提供しない)。
  例: ポータブル冷蔵冷凍庫 / 電子レンジ / サーキュレーター / ポータブル電源 / ドラムリール /
  カセットコンロ / カセットボンベ / 炊飯器 / 電気ケトル / 家電セット / 集客セット
- **特殊車両・工具・キャンピングカー**も取り扱わない。

提供するオプションは補償 (免責補償制度 CDW / 安心保証コース PAP) のみ。
季節・時間帯の割増 (土日祝割増・夜間料金・繁忙期割増) は料金体系であってオプションではない。
車両に標準装備されている設備 (カーナビ・ETC車載器、キッチンカーの営業設備等) は
「貸し出す装備品」ではなく車両の仕様なので、スペックとして表示してよい。
