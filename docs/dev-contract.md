# グロースレンタカー 開発コントラクト (内部規約 / API仕様)

> **旧デモ実装用の規約です。** 本番実装の正は [`production/README.md`](production/README.md)、[`production/data-model.md`](production/data-model.md)、[`production/openapi.yaml`](production/openapi.yaml)、[`production/acceptance.md`](production/acceptance.md) です。現行実装との差分は [`production/current-state-audit.md`](production/current-state-audit.md) を参照してください。

以下は localStorage デモの保守時だけ参照します。本番の認証・予約・個人情報・管理 API には適用しません。

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
  type: 'vehicle'|'item',      // vehicle = 車両 / item = 家電レンタル (家電だけのレンタル。cat-appliance)
  icon: '🍳', sort: 2, active: true, description: '…',
  customFieldDefs: [           // カテゴリ固有のカスタム項目定義 (管理画面から編集可能)
    { key: 'sinks', label: 'シンク数', type: 'text'|'number'|'select',
      unit: '槽', options: ['…'](selectのみ), filterable: true|false }
  ] }
```
シード: cat-rental(一般レンタカー・vehicle) / cat-kitchen(キッチンカー・vehicle) / cat-appliance(家電レンタル・item)
```js
{ categoryId: 'cat-appliance', name: '家電レンタル', nameEn: 'Appliance Rental', type: 'item', icon: '🔌', sort: 3,
  description: '車がなくても大丈夫。ポータブル電源や調理家電を、家電だけでお貸しします。北見本店でお受け取り・ご返却。',
  customFieldDefs: [] }
```
※ type:'item' のカテゴリは cat-appliance だけ。家電レンタルのしくみは下の「家電レンタル (家電だけのレンタル)」の節。

### locations (拠点)
```js
{ locationId: 'loc-kitami', name: '北見本店', nameEn, tel, address, hours: '9:00-19:00', holiday: 'なし (年中無休)', sort }
```
シード: loc-kitami (北見本店。北海道北見市若葉4丁目6) のみ (2026-10 に釧路店を廃止)

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
シード: 車両 V001〜V004 (cat-rental。2026-10 に軽トラック V005 を廃止) / K001 (cat-kitchen) と、家電レンタルの受け取り窓口 A001。
```js
{ assetId: 'A001', categoryId: 'cat-appliance', locationId: 'loc-kitami',
  name: '家電レンタル（北見本店）', nameEn: 'Appliance Rental (Kitami)',
  capacity: null, priceHour: null, priceDay: 0, image: '🔌', photo: '', sort: 7, customFields: {} }
```
A001 は家電そのものではなく「家電レンタルの予約を受ける窓口」。基本料金 0 円で、借りる家電はこの予約で装備オプションとして選ぶ。
在庫は家電 (options.stock) ごとに数える (A001 の stock は 1 のままで、空き判定には使わない)。

### options (オプション2階層)
```js
{ optionId: 'OP101', name: '免責補償制度 (CDW)', price: 1650,
  priceShort: 1100,                     // 1〜6時間の料金。null = 6時間以内でも price (24時間料金)
  priceType: 'per_day'|'per_rental',    // per_day = 24時間ごと / per_rental = 1回
  categoryIds: null | ['cat-rental'],   // null = 共通オプション (全車両カテゴリ)
  kind: 'cover'|'other',                // cover = 補償オプション / other = 装備オプション (画面の見出しを分ける)
  exclusiveGroup: 'cover' | null,       // 同じグループからは1つだけ選べる (補償は CDW か PAP のどちらか)
  description: '…',                     // 名前の下に小さく出す説明 (装備は型番)。本番 DB では options.extra.description
  includes: ['OP001', …],               // セットに含まれる品目の optionId (家電セット OP010 だけが持つ)。本番 DB では options.extra.includes
  stock: null | 0以上の整数,            // 在庫数。null = 数えない (家電セット・補償)。本番 DB では options.stock
  active: true, sort: 1 }
```
シード:
- **補償オプション** (カテゴリ専用・`kind: 'cover'`・`exclusiveGroup: 'cover'`): OP101/OP102 (cat-rental) / OP201/OP202 (cat-kitchen)。
- **装備オプション** (共通 = `categoryIds: null`・`kind: 'other'`・`exclusiveGroup: null`・`priceType: 'per_day'`・`priceShort: null`・sort 11〜21):
  総合料金表 (2026年6月改定版) の11品目。料金は24時間ごと (税込)。

  | ID | 名称 | 24時間あたり | description | stock |
  |---|---|---|---|---|
  | OP001 | ポータブル冷蔵冷凍庫 | 3,300 | アイリスオーヤマ IPD-4A-B | 1 |
  | OP002 | 電子レンジ | 2,200 | パナソニック NE-FL1C-W | 1 |
  | OP003 | サーキュレーター | 1,100 | アイリスオーヤマ KCF-SDC15T-EC-W | 1 |
  | OP004 | ポータブル電源 | 3,300 | Jackery JE-1800A | 1 |
  | OP005 | ドラムリール | 1,100 | 日動工業 NR-304D-S | 1 |
  | OP006 | カセットコンロ | 1,100 | 岩谷産業 CB-ODX1-BK | 1 |
  | OP007 | カセットボンベ | 1,100 | 岩谷産業 CB-250-OR | 1 |
  | OP008 | 炊飯器 | 2,200 | タイガー魔法瓶 JPV-Y180KV | 1 |
  | OP009 | 電気ケトル | 1,100 | 象印マホービン CK-VB15 BM | 1 |
  | OP010 | 家電セット (上記9点まとめ) | 11,000 | ポータブル冷蔵冷凍庫〜電気ケトルの9点をまとめたセット。`includes: ['OP001', …, 'OP009']` | null (中の9品目の在庫を使う) |
  | OP011 | 集客セット | 1,100 | ホワイトボード・マグネット・ペン | 1 |

  補償 OP101 / OP102 / OP201 / OP202 の stock は null (数えない)。

オプションの約束:
- **同時に選べない組み合わせ** (`SkyRentPricingCore.quote` が errors に `'OPTION_CONFLICT'` を入れる):
  1. 同じ `exclusiveGroup` のオプションを2つ以上 (補償を2つ)。
  2. あるオプションの `includes` に、同時に選ばれた別のオプションの ID がある (家電セットと、セットに含まれる品目)。
     二重請求を防ぐため。`includes` が配列でなければ無視する。
- per_day の計算は24時間ごと (25時間なら ×2)。`priceShort` が null の装備は6時間以内でも24時間料金。
- 割引 (学生・法人・二地域居住者・守成クラブ) は基本料金だけに効き、オプションには効かない。
- 装備オプションは2通りで貸し出す。(1) 車両の予約に追加する (従来どおり)。(2) 家電レンタル (cat-appliance / A001) の予約で、家電だけを借りる。
  どちらも同じ在庫 (`stock`) を使う。数え方と在庫切れの扱いは下の「家電レンタル」の節。
- 補償 (CDW / PAP) は cat-rental / cat-kitchen 専用なので、家電レンタルには出ない。

### 家電レンタル (家電だけのレンタル。2026-10)

事業者の依頼「車の貸し出しにオプション、ではなくそのまま家電貸出だけもやりたい」に対応した。
車両の予約に付ける装備オプションとしての提供はそのまま続ける。

- **予約の形**: 窓口アセット A001 (`cat-appliance`) の予約で、借りる家電を装備オプション (OP001〜OP011) から **1つ以上** 選ぶ。
  1つの予約で複数の家電を借りられる。各品目は1つずつ (数量の指定は無い)。補償は出ない。
- **料金**: 選んだ家電の24時間ごとの料金の合計 (基本料金 0)。土日祝・夜間・繁忙期の割増はかけない。
  割引 (学生・法人・二地域居住者・守成クラブ) は使えない。ポイントの ¥1,000 クーポンは車両と同じく使える。
- **受け取り・返却**: 北見本店のみ。配送しない。運転免許は不要 (受け取り時に本人確認書類を確認)。`licenseConfirmed` を求めない。
- **重なり**: A001 には同じ時間に何件でも予約が入る (車両の「重なり禁止」は家電レンタルに適用しない)。止めるのは家電ごとの在庫。
- **貸出停止枠** (`kind: 'block'`) は家電レンタルのアセットには作れない。家電を貸せない期間は、オプション管理で在庫を 0 にするか無効にする。
- **受け渡しの担当者確認** (Google カレンダー・`oneHandoverAtATime`) は家電レンタルにもそのまま適用する (店頭で受け渡すため)。
- **キャンセル料**: 区分 `item` (`rules.cancellation.categoryClass['cat-appliance'] = 'item'`)。割合はコンパクトカーと同じ
  (通常期 3日前まで0% / 前日まで30% / 当日50%、繁忙期 7日前まで0% / 前日まで30% / 当日50%、無断100%)。
  キャンセル料の元になる「利用料金」は、車両 = 基本料金、家電レンタル = 家電 (オプション) の料金の合計。
- **同意する文書**: 車両 = `clause` / `cancel` / `privacy`、家電レンタル = `item_clause` (物品レンタル規約 `item-terms.html`) / `cancel` / `privacy`。
- ゲスト予約の上限 (1件31日・有効3件)・返却時のポイント付与は車両と同じ。

**在庫の数え方** (車両に付けたオプションと家電だけの予約で、同じ在庫を使う):
- 家電 X の使用数 = 期間内に「同時に貸し出している数」の最大値。数えるのは状態が `confirmed` / `in_use` の予約 (`kind: 'rental'`) で、
  `optionIds` を展開した集合 (選んだ id + その id の `includes`) に X を含むもの。車両の予約も家電だけの予約も数える。変更時は自分自身を除く。
  同時最大は「期間の開始時点」と「期間内に始まる各予約の開始時点」で数えた件数の最大。
- 予約で選んだ (展開後の) 家電のうち、在庫を数えるもの (`stock` が null でない) のどれかが 使用数 + 1 > `stock` なら、
  予約は `OPTION_SOLD_OUT` で失敗する。家電セットを選んだ場合は、中の9品目の在庫で判定する。
- 見積は、その期間に貸し出せない (残り0の) 家電の id を `unavailableOptionIds` で返す。家電セットは中の9品目のどれかが残り0なら含める。
  画面はこれを見て、その家電を選べなくする。

**エラーコード** (追加分。HTTP は本番 API の値):

| code | HTTP | いつ | お客様向けの文 |
|---|---|---|---|
| `ITEM_REQUIRED` | 400 | 家電レンタルで家電を1つも選んでいない (pricing-core の `quote.errors`。DB の `create_reservation_tx` / `admin_create_reservation` でも確認) | お借りになる家電を1つ以上お選びください。 |
| `OPTION_SOLD_OUT` | 409 | 選んだ家電のどれかが、その日時はすでに貸し出し中 | お選びの家電のうち、ご希望の日時はすでに貸し出し中のものがあります。別の日時か別の家電をお選びください。 |

`OPTION_SOLD_OUT` は `details: { optionIds: [売り切れの家電の id (家電セットを選んだ場合はセット自身の id も)] }` と
`fields.optionIds: 'ご希望の日時は貸し出し中の家電があります。'` を返す。

**表示の言葉**: 家電レンタルは「貸出/返却」ではなく「お受け取り/ご返却」、「車両」ではなく「家電レンタル」。
予約確認メール・マイページ・管理画面・帳票には、借りる家電の一覧を必ず出す。帳票は「物品貸出書」(家電セットは中の9品目に分けて1行ずつ)。

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
家電レンタルの予約は `assetId: 'A001'`・`categoryId: 'cat-appliance'`。借りる家電は `optionIds` / `options`。`licenseConfirmed` は求めない。
本番 DB では `reservations.is_item` が true になる (カテゴリの type が 'item' のときトリガーで設定。画面からは送らない)。

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
- `optionsForCategory(categoryId)` → `{common: [], specific: []}` (家電レンタル cat-appliance でも common に装備オプションを返す。家電レンタルで選ぶ家電はこれ)
- `availability(assetId, start, end, qty, excludeResId?, optionIds?)` → `{ok, remaining, stock, reason}` (家電レンタルの窓口 A001 は重なりで止めない。
  `optionIds` を渡すと選んだ家電の在庫も確かめ、足りなければ `ok: false`・`code: 'OPTION_SOLD_OUT'`・`soldOut: [id...]`)
- `unavailableOptionIds(startIso, endIso, excludeReservationId?)` → その期間に貸し出せない (残り0の) 家電の id の配列。見積の `unavailableOptionIds` と同じ値
- `optionSoldOut(optionIds, start, end, excludeResId?)` → 選んだ家電のうち在庫が足りないものの id (家電セットはセット自身の id も)。`[]` なら予約できる
- `optionStock(start, end, excludeResId?)` → `[{optionId, stock, used, remaining}]` (在庫を数える家電だけ)
- `isItemCategory(categoryId)` / `isItemAsset(asset)` / `categoryTypeOf(asset)` → 家電レンタルかどうか (`'vehicle'` | `'item'`。料金計算の `asset.categoryType` に渡す値)
- `createReservation` と `updateReservation` (日時・車両・家電を変えたとき。自分自身は数えない) は、家電の在庫が足りなければ `code: 'OPTION_SOLD_OUT'` (`details.optionIds`・`fields.optionIds` 付き) のエラーを投げる
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
(現在は `js/pricing-core.js` の `quote()` を呼ぶアダプタ。料金規則は [`production/implementation-v1.md`](production/implementation-v1.md) §1)
- 料金エンジンに渡す `asset` には `categoryType` (`'vehicle'` | `'item'`) をカテゴリの type から補う。家電レンタル (`'item'`) は基本料金 0・割増なし・割引なし、家電0件で `ITEM_REQUIRED`。
- `SkyRentPricing.cancellationFee(p)` / `SkyRentPricing.cancellationBase(p)`: キャンセル料の元になる利用料金は、車両 = 基本料金、家電レンタル = 借りる家電の料金の合計。

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
- メール: info@skyward-growth.com
- 公式LINE: https://lin.ee/PuLt0Ig
- 拠点: 北見本店 (北海道北見市若葉4丁目6。スタッフはご予約のお時間のみ)
- 料金・キャンセル規定は「レンタカー 総合料金表 (2026年6月改定版)」に準拠

---

## 取り扱わないもの

以下はサービスとして提供していない。ページ・データ・オプションのいずれにも追加しないこと。

- **特殊車両・工具・キャンピングカー**は取り扱わない (工具のカテゴリも作らない)。
- **料金表に無い品目・オプション** (例: 発電機・フライヤー・鉄板・のぼり旗) は追加しない。家電レンタルで貸すのも、装備オプション11品目だけ。

家電は **単体でも貸す** (2026-10 から)。家電レンタルのカテゴリ `cat-appliance` (type `'item'`) の窓口アセット A001 (北見本店) の予約で、
装備オプションの中から借りる家電を選ぶ形 (上の「家電レンタル」の節)。車両の予約に付ける装備オプションとしての提供も続ける。
受け取り・返却は北見本店だけで、配送はしない。

提供するオプションは、補償 (免責補償制度 CDW / 安心保証コース PAP。車両だけ) と、
装備オプション11品目 (ポータブル冷蔵冷凍庫 / 電子レンジ / サーキュレーター / ポータブル電源 / ドラムリール /
カセットコンロ / カセットボンベ / 炊飯器 / 電気ケトル / 家電セット / 集客セット。総合料金表 2026年6月改定版どおり) だけ。
装備オプションは 2026-09-04 にいったん全廃し、2026-09-30 に事業者の依頼で復活した。2026-10 から家電だけのレンタルも始めた。
季節・時間帯の割増 (土日祝割増・夜間料金・繁忙期割増) は料金体系であってオプションではない。
車両に標準装備されている設備 (カーナビ・ETC車載器、キッチンカーの営業設備等) は
装備オプション (別料金で追加する品目) ではなく車両の仕様なので、スペックとして表示してよい。
