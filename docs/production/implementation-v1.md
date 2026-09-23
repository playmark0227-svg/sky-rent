# 本番実装 v1 — 実装契約書

更新日: 2026-09-23 / 対象: グロースレンタカー (公開サイト・会員・管理画面)

この文書は **実装者どうしの約束** です。DB は `supabase/migrations/*.sql` と `supabase/seed.sql` が正です
(読んでから作業すること)。ここに無い名前・形を勝手に作らない。

---

## 0. 全体像

```
静的サイト (GitHub Pages)                         Supabase
 ├ js/config.js      接続先 (空 = デモモード)       ├ Postgres  … supabase/migrations
 ├ js/boot.js        データ読込後にページ処理を実行   ├ Auth      … 会員 (メール確認) / スタッフ (TOTP 必須)
 ├ js/backend.js     Supabase 接続・同期・API呼出   ├ Edge Functions
 ├ js/store.js       画面用キャッシュ (既存API維持)  │   ├ api     公開・会員向け (予約/見積/問い合わせ/空き)
 ├ js/pricing-core.js 料金計算 (サーバーと同一コード) │   ├ admin   スタッフ向け (招待/メール再送/カレンダー)
 └ 各ページ                                         │   └ worker  メール送信・Googleカレンダー同期
                                                     └ Google Calendar API (担当者の空き・予約の書込)
```

- **デモモード**: `SKY_RENT_CONFIG.SUPABASE_URL` が空。これまでどおり localStorage で動く (GitHub Pages の現状)。
- **本番モード**: URL とキーが入っている。業務データは **ブラウザに永続保存しない** (store はメモリのみ)。
- 画面はどちらのモードでも同じコードで動くこと。本番専用の処理は `SkyRentBackend.live` で分岐。

### ローカル検証環境 (このマシンで起動済み)

| 項目 | 値 |
|---|---|
| API URL | `http://127.0.0.1:54321` |
| anon key (JWT) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0` |
| service_role key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU` |
| DB | `docker exec -i supabase_db_sky-rent psql -U postgres` |
| メール受信確認 (Mailpit) | `http://127.0.0.1:54324` (API: `/api/v1/messages`) |
| DB 作り直し | `supabase db reset` (migrations + seed) |
| Edge Functions 起動 | `supabase functions serve --env-file supabase/functions/.env.local` |

---

## 1. 料金計算 `js/pricing-core.js`

ブラウザ (classic script) と Deno (ES module として side-effect import) の両方で動く1ファイル。
import/export 文を書かず、IIFE の中で `globalThis.SkyRentPricingCore = {...}` を設定する。
Edge Function 側は `supabase/functions/_shared/pricing-core.js` に **同一内容をコピー** して使う
(`node scripts/sync-shared.mjs` でコピー、`tests/` で一致を検査)。

料金ルールは `app_settings.pricing_rules` (seed 参照)。関数は全て純関数 (Date.now を内部で呼ばない)。

```js
SkyRentPricingCore = {
  DEFAULT_RULES,                         // seed の pricing_rules と同じ内容
  quote(input) -> Quote,
  cancellationFee(input) -> Fee,
  isJapaneseHoliday(ymd, rules?) -> boolean   // 'YYYY-MM-DD' (JST)
  holidayName(ymd) -> string|null,
  jstParts(isoOrDate) -> {y,m,d,hh,mm,dow,ymd},
  hoursBetween(start, end) -> int              // 端数切り上げ、最低1
}
```

### quote(input)

```
input = {
  asset:    {id, categoryId, priceHour, priceDay, customFields:{bodyType?}},
  start, end,                     // ISO 文字列 or Date
  options:  [{id, name, price, priceShort, priceType, categoryIds, exclusiveGroup}],  // 選択されたもの
  discountType: null | 'student' | 'corporate' | 'dual_residence' | 'shusei_club',
  coupon:   null | {id, amount},
  rules:    pricing_rules (省略時 DEFAULT_RULES)
}
Quote = {
  ok: boolean, errors: [code...],       // 例: 'INVALID_PERIOD', 'OPTION_CONFLICT', 'DISCOUNT_NOT_APPLICABLE'
  hours, days,                          // days = ceil(hours/24)
  plan: 'hourly' | 'daily',
  lines: [{code, label, amount}],       // 画面にそのまま出す内訳 (税込・円)
  base,                                 // 基本料金 (延長含む) — キャンセル料の基準
  subtotal, discount, couponDiscount, total,
  busy: boolean, rulesVersion
}
```

計算規則 (総合料金表 2026年6月改定版):

1. **基本料金** h = 利用時間 (切り上げ・最低1時間)
   - h < 24: `min(h × priceHour, priceDay)` (priceHour 無しは priceDay) … plan = hourly/daily
   - h ≥ 24: `floor(h/24) × priceDay + min((h%24) × priceHour, priceDay)` (priceHour 無しで端数ありは priceDay)
     行は「基本料金 (24時間 × n)」「延長料金 (m時間)」に分ける。
2. **オプション** (per_day): h ≤ shortHoursMax(6) かつ priceShort あり → priceShort。
   それ以外は `floor(h/24) × price + (端数0なら0 / 端数≤6 かつ priceShort あり → priceShort / それ以外 price)`。
   per_rental は1回。同じ exclusiveGroup を2つ以上 → errors に 'OPTION_CONFLICT'。
3. **繁忙期割増** busyFee(550) を1回。利用期間が触れる暦日 (JST、開始日〜終了時刻の1ms前の日) に
   busyPeriods (MM-DD, 年またぎ可) が1日でもあれば適用。busy = true。
4. **土日祝割増** weekendHolidayFee(330) を1回。触れる暦日に土・日・祝日 (extraHolidays 含む) があれば適用。
   **繁忙期が適用されたときは付けない。**
5. **夜間料金** nightFee(1100)。貸出時刻・返却時刻それぞれ (JST) が nightStartHour(20)〜翌 nightEndHour(8)
   (20:00 以上 または 8:00 未満) なら1回ずつ。両方なら2回 (= 2,200)。
6. **割引** (1つだけ): 利用時間 ≥ minHours(24) かつ categoryIds 条件を満たすとき、基本料金から amount 引き
   (基本料金を超えない)。満たさない場合は errors に 'DISCOUNT_NOT_APPLICABLE' を入れ、割引しない。
7. **クーポン**: 小計から amount 引き (0円未満にしない)。
8. total = subtotal − discount − couponDiscount。

祝日: 内閣府の祝日法ロジック (固定日・ハッピーマンデー・春分/秋分の簡易式・振替休日・国民の休日) を実装。
テストで 2026・2027 年の全祝日を検証する
(2026: 1/1,1/12,2/11,2/23,3/20,4/29,5/3,5/4,5/5,5/6(振替),7/20,8/11,9/21,9/22(国民の休日),9/23,10/12,11/3,11/23 /
 2027: 1/1,1/11,2/11,2/23,3/21,3/22(振替),4/29,5/3,5/4,5/5,7/19,8/11,9/20,9/23,10/11,11/3,11/23)。

### cancellationFee(input)

```
input = { asset, category:{id}, start, cancelAt, base, noShow?: boolean, rules }
Fee = { cls: 'compact'|'large'|'kitchen', busy, daysBefore, pct, fee, label }
```
- 車種区分: categoryClass[category.id] → なければ classOf[asset.customFields.bodyType] → 既定 'compact'。
- daysBefore = JST の暦日差 (貸出日 − 取消日)。当日 0、前日 1、前々日 2。
- busy = 貸出日 (JST) が busyPeriods 内。tiers = rules.cancellation[busy ? 'busy' : 'normal'][cls]。
  daysBefore ≥ minDays を満たす最初の段の pct。noShow なら noShowPct。
- fee = floor(base × pct / 100)。label 例: 「前日 (30%)」「3日前以降は無料」。

### js/pricing.js (既存画面向けアダプタ)

`SkyRentPricing.calculate({asset,start,end,quantity,options,coupon,discountType})` を維持し、
中で `quote()` を呼んで旧形式 `{lines:[{label,amount}], days, hours, plan, subtotal, discount, total}` を返す。
rules は `SkyRentStore.read('settings.pricing_rules')` → 無ければ DEFAULT_RULES。
`SkyRentPricing.cancellationFee(...)`, `SkyRentPricing.rules()` も公開する。

---

## 2. Edge Functions

共通: `supabase/functions/<name>/index.ts` (Deno)。`supabase/config.toml` で **3つとも `verify_jwt = false`**
(新形式の publishable key でも動くよう、認証は関数内で行う)。

- CORS: `ALLOWED_ORIGINS` (カンマ区切り) に一致する Origin だけ許可。未設定なら `*`。OPTIONS に 204。
- 成功: `200 {ok:true, ...}`。失敗: `{ok:false, code, message, requestId, fields?}` + 下表の HTTP ステータス。
  `message` は日本語 (お客様向けの文)。内部エラーの詳細は返さない (ログにだけ出す。個人情報はログに出さない)。
- ユーザー識別: `Authorization: Bearer <access_token>` があれば、anon key の client に
  そのヘッダを付けて `auth.getUser()` で検証。無効なら未ログイン扱い (api) / 401 (admin)。
- DB 書込は service_role の client で `supabase/migrations` の RPC を呼ぶ。

| code | HTTP | 意味 |
|---|---|---|
| VALIDATION | 400 | 入力不備。`fields: {name: 'メッセージ'}` |
| CONSENT_REQUIRED | 400 | 必須の同意が無い / 版が古い |
| UNAUTHENTICATED | 401 | ログインが必要 |
| FORBIDDEN / INVOICE_NOT_ALLOWED | 403 | 権限なし |
| NOT_FOUND | 404 | |
| AVAILABILITY_CONFLICT | 409 | 車両が埋まっている |
| STAFF_UNAVAILABLE | 409 | 受け渡し担当者の予定が埋まっている (Google カレンダー) |
| HANDOVER_CONFLICT | 409 | 同じ拠点で受け渡し時刻が近い予約がある |
| PRICE_CHANGED | 409 | 表示金額と再計算額が違う。`quote` を同梱 |
| COUPON_INVALID / NOT_CANCELLABLE / IDEMPOTENCY_KEY_REUSED | 409 | |
| RATE_LIMITED | 429 | |
| CALENDAR_UNAVAILABLE | 503 | Google に接続できず、failOpen = false |
| FOREIGN_KEY | 409 | 予約などで使われている行の削除 (DB 23503)。「無効にしてください」と案内 |
| CONFLICT | 409 | その他の競合 |
| INTERNAL | 500 | |

### 環境変数 (`supabase/functions/.env.example` に説明付きで列挙)

| 変数 | 用途 |
|---|---|
| SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY | Supabase が自動で渡す |
| SITE_URL | 公開サイトの URL (末尾 /)。メール内リンク用 |
| ALLOWED_ORIGINS | CORS 許可 Origin |
| GUEST_TOKEN_SECRET | ゲスト照会キーの HMAC 秘密鍵 (32文字以上) |
| WORKER_SECRET | worker 起動用の共有秘密 (`x-worker-secret` ヘッダ) |
| RESEND_API_KEY / RESEND_API_BASE | メール送信 (Resend)。未設定なら送信せず `skipped` |
| MAIL_FROM | 例 `グロースレンタカー <noreply@example.com>` |
| SHOP_NOTIFY_EMAIL | 店舗宛て通知の宛先 (カンマ区切り可) |
| GOOGLE_SERVICE_ACCOUNT_JSON | サービスアカウント鍵 JSON (そのまま or base64) |
| GOOGLE_API_BASE / GOOGLE_TOKEN_URL | 既定 `https://www.googleapis.com` / 鍵の token_uri。テストで差し替え |

### 2.1 `api` (公開・会員)

ゲスト照会キー: `token = base64url(HMAC-SHA256(GUEST_TOKEN_SECRET, 'guest:' + reservationId))`、
DB には `sha256hex(token)` を `guest_token_hash` として保存。**平文トークンは DB に保存しない**
(メール送信時は worker が同じ式で再生成する)。照会URL: `${SITE_URL}mypage.html#lookup=<id>.<token>`。

1. `GET /api/availability?from=ISO&to=ISO` (最大 120 日)
   ```
   {ok, busy:[{assetId,start,end}],               // public_busy_ranges
        handovers:{<locationId>:[ISO,...]},        // 有効予約の貸出・返却時刻 (oneHandoverAtATime 用。個人情報なし)
        staff:{enabled, mode, handoverMinutes, oneHandoverAtATime,
               locations:{<locationId>:{configured:bool, busy:[{start,end}]}}}}
   ```
   Google の結果は `calendar_cache` に5分キャッシュ。予定の件名などは返さない (時間帯のみ)。
2. `POST /api/quote` `{assetId, start, end, optionIds, discountType?, couponId?}`
   → `{ok, quote, availability:{vehicle:bool, staff:bool, handover:bool, reasons:[code]}}`
   (クーポンはログイン会員本人の未使用分のみ有効。サーバー側カタログと pricing_rules で計算)
3. `POST /api/reservations`
   ```
   {idempotencyKey, assetId, start, end, optionIds, discountType?, couponId?,
    customer:{name, kana, email, phone, company}, paymentMethod:'onsite'|'invoice',
    licenseConfirmed:true, note, expectedTotal,
    consent:{documents:[{id,version}], agreedAt}}
   ```
   手順: 検証 → レート制限 (IP ハッシュ 10回/10分) → カタログ・ルール取得 → quote (サーバー計算) →
   `expectedTotal` と不一致なら PRICE_CHANGED → 必須同意 (clause, cancel, privacy の active 版) を確認 →
   担当者の空き (§3、Google へ直接問い合わせ・キャッシュを使わない) → `create_reservation_tx`
   (handover_minutes は calendar.oneHandoverAtATime のとき handoverMinutes) → worker を同期実行 (待ち最大 8 秒)。
   → `{ok, reservation:{id, assetId, start, end, total, price, status, paymentMethod},
       guestToken, lookupUrl, email:{status:'sent'|'queued'|'skipped'|'failed'}}`
   メール: お客様 `reservation_confirmed`、店舗 `reservation_new_shop`。
4. `POST /api/reservations/lookup` `{id, token?}` (会員は token 不要で本人分)
   → `{ok, reservation:{...安全な項目, assetName, locationName}, cancellation:{cancellable, fee, pct, label}}`
5. `POST /api/reservations/cancel` `{id, token?, expectedFee}` → 料金ルールでキャンセル料を計算し
   `cancel_reservation_tx`。expectedFee と違えば PRICE_CHANGED。メール: `reservation_cancelled` / `_shop`。
6. `POST /api/inquiries`
   `{idempotencyKey, name, company, email, tel, topic, body, reservationId?, website:'' (ハニーポット), consent:{documents:[{id:'privacy',version}]}}`
   → `submit_inquiry_tx` → `{ok, id, email:{status}}`。メール: `inquiry_received` / `inquiry_new_shop`。
   レート制限: IP 5回/10分、同一メール 10回/日。
7. `POST /api/me/close` (会員) `{confirm:true}` → `member_close_account` → auth ユーザーを soft delete。

### 2.2 `admin` (スタッフ。AAL2 + 権限を関数内で `rpc('has_perm')` で確認)

1. `POST /admin/members/invite` (members.write) `{email, name, name_kana, phone, company, invoiceAllowed}`
   → `auth.admin.inviteUserByEmail(email, {data:{account_type:'member', ...}, redirectTo: SITE_URL+'mypage.html'})`
2. `POST /admin/staff/invite` (staff.write) `{email, name, role, locationIds|null}`
   → 招待 (redirectTo: SITE_URL+'manage/login.html') + `staff` 行を作成
3. `POST /admin/staff/list` (staff.write) → `{ok, staff:[...+ lastSignInAt, mfaEnabled]}`
4. `POST /admin/outbox/process` (outbox.read) `{refIds?, limit?}` → worker を1回実行 → `{ok, processed, results}`
5. `GET  /admin/calendar/status` (settings.write)
   → `{ok, configured, serviceAccountEmail, locations:{<id>:[{calendarId, access:'events'|'freeBusyOnly'|'none', error?}]}}`
6. `POST /admin/calendar/test` (settings.write) `{calendarId}` → 同上1件 + 直近7日の予定あり時間帯の件数
7. `POST /admin/staff/reset-mfa` (staff.write) `{userId}` → 対象スタッフの TOTP をすべて削除 → `{ok, removed}`。
   自分自身は 403 (他の管理者に依頼する)。監査ログに `mfa_reset` を記録。スマートフォン紛失時の復旧用。

### 2.3 `worker`

`POST /worker` — `x-worker-secret: WORKER_SECRET` または service_role の Bearer が必須。
`outbox_claim(20)` → template ごとに処理 → `outbox_mark`。api/admin からは HTTP ではなく関数を直接呼ぶ。

- メール: `_shared/mail-templates.ts` で payload から件名・本文 (テキスト) を組み立て Resend へ。
  RESEND_API_KEY 未設定 → `skipped` (last_error: 'メール送信サービス未設定')。宛先不正 → `failed`。
  テンプレート: `reservation_confirmed`, `reservation_new_shop`, `reservation_cancelled`,
  `reservation_cancelled_shop`, `inquiry_received`, `inquiry_new_shop`, `coupon_issued`。
  本文には 予約番号・車両・拠点 (名称・住所)・貸出/返却日時・料金内訳・支払方法・
  キャンセル規定の要点 (§1 の表を文章化)・照会URL・問い合わせ先 (LINE / メール) を入れる。
- `gcal_sync`: §3。

---

## 3. Google カレンダー連携

設定: `app_settings.calendar` (seed と `20260923000400_calendar_jobs.sql` の冒頭コメント参照)。
認証: サービスアカウント (RS256 の JWT を WebCrypto で署名 → token 取得。scope
`https://www.googleapis.com/auth/calendar`)。担当者は自分のカレンダーをサービスアカウントの
メールアドレスに「予定の変更」権限で共有する。鍵は Edge Function の secret だけに置く。

### 3.1 担当者の「予定あり」時間帯の取得

`GET {GOOGLE_API_BASE}/calendar/v3/calendars/{id}/events?timeMin&timeMax&singleEvents=true&orderBy=startTime&maxResults=2500`
- 予定あり = `status != 'cancelled'` かつ **当社が書いた予定ではない** (`extendedProperties.private.skyrent`)
  かつ (`transparency != 'transparent'` **または終日予定**) かつ 自分が「不参加」でない。
  ※ Google の終日予定は既定で「予定なし」なので freeBusy では拾えない。「休み」を終日で入れる運用に対応するため events を読む。
- events が 403/404 のときだけ `POST /calendar/v3/freeBusy` にフォールバック (access = 'freeBusyOnly')。
- 1拠点に複数カレンダーがある場合、**誰か1人でも空いていれば受け渡し可能**。

### 3.2 判定

- `mode = 'handover'`: 貸出窓 `[start, start + handoverMinutes)` と 返却窓 `[end, end + handoverMinutes)` の
  それぞれで、拠点のカレンダーのうち少なくとも1つが予定ありと重ならない。
- `mode = 'day'`: 貸出日・返却日 (JST 0:00〜24:00) のそれぞれで、少なくとも1つのカレンダーに予定ありが1件も無い。
- 拠点にカレンダー未登録 → その拠点は判定しない (予約可)。`enabled = false` → 判定しない。
- Google 接続失敗: `failOpen` なら予約可 (ログに警告)、そうでなければ CALENDAR_UNAVAILABLE。

### 3.3 予約の書き込み (`gcal_sync`)

最新の予約を読み、拠点の **先頭のカレンダー** に2件 (貸出・返却) を upsert:
- 件名 `【貸出】R00012 マツダ CX-5 / 山田 太郎 様`、`【返却】…`
- 時間: 貸出 `[start, start+handoverMinutes)`、返却 `[end, end+handoverMinutes)`、timeZone Asia/Tokyo
- `transparency: 'transparent'` (空き判定に影響させない)、`extendedProperties.private.skyrent = 予約番号`
- 説明: 予約番号・車両・人数ではなく **電話番号は入れない** (外部サービスへの個人情報の送信を最小化)。
  管理画面の予約一覧 URL (`SITE_URL + 'manage/reservation-list.html'`) を入れる。
- 状態が cancelled / no_show → 予定を削除。confirmed / in_use / returned → upsert。
- 予定IDは `set_reservation_gcal_events(id, {pickup:{calendarId,eventId}, return:{...}})` で保存。
- カレンダー未設定なら `skipped`。

---

## 4. フロントエンド

### 4.1 `js/config.js`

```js
window.SKY_RENT_CONFIG = {
  SUPABASE_URL: '',            // 本番: https://xxxx.supabase.co
  SUPABASE_ANON_KEY: '',       // 本番: anon / publishable key
  FUNCTIONS_URL: '',           // 空なら SUPABASE_URL + '/functions/v1'
  SITE_NAME: 'グロースレンタカー',
  AUTH_STORAGE: 'auto'         // ログイン状態の保存先。auto = *.github.io なら sessionStorage、それ以外は localStorage
};
```
`*.github.io` は同じ GitHub アカウントの全リポジトリの Pages と同一オリジンになるため、ログイン情報を
localStorage に置くと他のサイトのスクリプトから読める。独自ドメインで公開するまでは sessionStorage (タブを閉じると消える) にする。
localhost / 127.0.0.1 で開いたときだけ `localStorage['sky-rent.configOverride']` (JSON) で上書き可 (検証用)。
旧 `GAS_URL` は削除 (api.js の該当コードも整理)。

### 4.2 スクリプト構成 (適用済み: `scripts/transform-script-tags.py`)

`config → store → pricing-core → pricing → (i18n) → (api) → (photos) → backend → boot` の後に、
ページ固有処理が `<script type="text/x-deferred">` (外部なら `data-src`) で並ぶ。**新規ページも同じ形にする。**

### 4.3 `js/boot.js`

1. 読み込み時に `<html>` へ `skyrent-booting` クラスを付ける (CSS で body を隠す: style.css / manage.css に
   `html.skyrent-booting body{visibility:hidden}` を追加)。
2. DOMContentLoaded 後 `await SkyRentBackend.init({area})`。area: `manage/login.html` → 'admin-login'、
   `manage/*` → 'admin'、それ以外 → 'public'。
3. 遅延スクリプトを文書順に実行 (インラインは新しい script 要素へ本文をコピー、data-src は src 読込を待つ)。
   実行中〜以後に登録される `DOMContentLoaded` / `load` リスナーは、既に発火済みなら非同期で即呼ぶ。
4. `window.dispatchEvent(new Event('skyrent:ready'))`、クラスを外す。
5. init 失敗時: 画面上部に日本語のエラーバナー (再読み込みボタン付き) を出し、ページ処理は実行する。
   8 秒で強制表示する安全策も入れる。デモモードは待ち時間ゼロ。

### 4.4 `js/store.js` の本番モード

- `LIVE = !!(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)`。LIVE なら seed しない・localStorage に書かない
  (メモリのみ)。`S.live` を公開。
- 追加: `S._hydrate({key: value, ...})` (フックを通さず書く)、`S._setWriteHook(fn(key, next, prev))`、
  `S._setExtraAvailabilityCheck(fn(asset, start, end) -> {ok, reason}|null)` (availability() の最後で適用)。
- 既存の関数名・戻り値の形は変えない。

### 4.5 `js/backend.js` — `window.SkyRentBackend`

```
live, ready (Promise), client (supabase-js。live 時だけ CDN から読込:
  https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js)
init({area}), toast(msg, type), errorMessage(code) -> 日本語, call(fn, path, {method, body}) -> json

公開・会員 (デモモードでは store の同等処理で代替し、同じ形で返す):
  availability(from, to), quote(p), createReservation(p), lookupReservation({id, token}),
  cancelReservation({id, token, expectedFee}), submitInquiry(p)
  auth.signUp({email, password, name, kana, phone, company, marketingOptIn, consent}),
  auth.signIn(email, password), auth.signOut(), auth.resetPassword(email), auth.updatePassword(pw),
  auth.session(), auth.onChange(cb), member.current(), member.reload(), member.updateProfile(patch),
  member.close()
  staffCheck(asset, start, end) -> {ok, code?, message?}   // 担当者の空き + 受け渡し重複 (表示用)
  auth.urlEvent() -> {type:'recovery'|'invite'|'signup'|'email_change'|'magiclink'|null, error:{code, description, message}|null, message}
       // メール内リンクで戻ってきたときの種類。supabase-js が URL の # を消費する前に読み取って保持している
  auth.checkPassword(pw) -> {ok, message?}   // 8文字以上・英大文字/英小文字/数字 (Auth の設定と同じ条件)
  jst.fromInput(v) -> ISO / jst.toInput(iso) -> 'YYYY-MM-DDTHH:MM' / jst.format(iso, {time, weekday, year}) / jst.ymd(v)
       // 日時入力は端末のタイムゾーンに関係なく常に日本時間として扱う (new Date(文字列) を画面で使わない)

管理 (live 時のみ実データ):
  admin.staff (現在のスタッフ {userId, name, role, perms[]}), admin.can(perm),
  admin.inviteMember(p), admin.inviteStaff(p), admin.listStaff(), admin.updateStaff(userId, patch),
  admin.processOutbox(), admin.retryOutbox(id), admin.calendarStatus(), admin.calendarTest(id),
  admin.saveSetting(key, value), admin.updateInquiry(id, patch), admin.createBlock(p), admin.deleteBlock(id),
  admin.recentActivity(), admin.mfa.{listFactors, enroll, challengeAndVerify, unenroll}, admin.signIn, admin.signOut
  admin.resetPassword(email)         // 戻り先 manage/login.html の再設定メール
  admin.sessionState()               // {userId, email, aal, nextLevel, staff:{name, role, locationIds, active}|null, hasTotp}
  admin.auditLog({table, rowId, actor, action, from, to, offset, limit}) -> {ok, rows, total, offset, limit, hasMore}
  admin.resetStaffMfa(userId)        // POST /admin/staff/reset-mfa (他のスタッフの二段階認証を解除。自分は不可)
  admin.processOutbox({refIds, limit})
  auth.resendSignup(email)           // 確認メールの再送
  staffAvailabilityState()           // {checked, error|null, unavailableLocations:[...]}
```

#### init の中身 (live)

- 共通: `public_catalog` RPC → 旧形式に変換して `_hydrate({categories, locations, assets, options,
  'settings.<key>': value..., <collection>: items..., legal})`。
- area = public: 会員セッションがあれば `members`(本人)・`member_points`・`coupons`・`point_ledger`・
  本人の `reservations` を読み `_hydrate`。`search.html` / `detail.html` / `booking.html` では
  `availability(今日-1日, +120日)` を読み、busy を合成予約 (`{reservationId:'busy-N', assetId, start, end,
  status:'confirmed', _busy:true}`) として `reservations` に入れ、担当者判定を `_setExtraAvailabilityCheck` に登録。
- area = admin: セッション無し → `login.html?next=<今のページ>` へ。`staff_role` が null →
  (AAL1 なら) ログイン画面の二段階認証へ / スタッフでなければサインアウトしてログイン画面へ。
  スタッフなら全データを並列取得 → 旧形式へ変換 → `_hydrate`。`notifications` は `admin_recent_activity`。
  書込フック (`_setWriteHook`) を登録:
  - `categories` / `locations` / `assets` / `options` → 差分 (id 単位) を upsert / delete
  - `settings.<key>` → `app_settings` upsert
  - 汎用一覧 (crud.js / settings.js のキー。例 employees, notices, holidays, faq, custom-pages,
    price-plans, vehicle-classes, customer-rates, input-fields, high-season) → `app_collections` 差分
  - `members` の既存行の変更 → `admin_update_member` / `reservations` の変更 → `admin_update_reservation`
  - それ以外のサーバー管理キーへの直接書込は console.warn して無視
  - 失敗時は toast (日本語) を出し、最新データを取り直す
- ドメイン関数の差し替え (live, admin): `S.updateReservation`, `S.adjustPoints`, `S.issueCouponManually`,
  `S.createInvoice`, `S.setInvoiceStatus`, `S.registerMember` (→ 招待) — 画面にはすぐ反映 (楽観更新) し、
  RPC 失敗時は toast + 取り直し。

#### DB 行 ⇔ 旧形式 (store) の対応

| store | DB |
|---|---|
| category `{categoryId, name, nameEn, type, icon, description, sort, active, customFieldDefs}` | categories (`extra` は展開して上書き) |
| location `{locationId, name, nameEn, tel, address, hours, holiday, sort, active}` | locations |
| asset `{assetId, categoryId, locationId, name, nameEn, plate, capacity, priceHour, priceDay, priceWeek, priceMonth, stock, requiredLicense, image, photo, active, shakenDate, maintenanceDate, customFields, sort}` | assets |
| option `{optionId, name, price, priceShort, priceType, categoryIds, kind, exclusiveGroup, active, sort, description}` | options (`extra.description`) |
| reservation `{reservationId, kind, assetId, vehicleId(=assetId), assetName, vehicleName, categoryId, locationId, quantity:1, customerName, customerKana, customerEmail, customerPhone, company, memberId(=member_no), userId, start, end, optionIds, options, payment:{method,status}, price, total, discountType, couponId, status, pointGranted, invoiceId, note, staffNote, cancelFee, cancelledAt, cancelledBy, licenseConfirmed, createdAt, version, gcalEvents}` | reservations |
| member `{memberId(=member_no), userId, name, nameKana, email, phone, company, isCorporate, invoiceAllowed, marketingOptIn, status, points, coupons:[{couponId, amount, reason, issuedAt, usedAt, usedFor}], pointHistory:[{at, delta, reason}], createdAt, lastUseAt}` | members + member_points + coupons + point_ledger |
| invoice `{invoiceId, memberId, userId, company, address, caseName, reservationIds, amount, status, issuedAt, dueDate, paidAt}` | invoices |
| inquiry `{inquiryId, name, company, email, tel, topic, body, reservationId, status, staffNote, createdAt}` | inquiries |

### 4.6 公開ページ

- **booking.html**: 免許番号の入力欄を削除し「運転される方全員が有効な運転免許証を持っている (当日店頭で確認)」の
  必須チェックに置換。割引 (学生/法人/二地域居住者/守成クラブ) の選択 (証明書類の案内付き)。
  **最終確認画面** (消費者庁の6項目): 車両・台数・貸出/返却日時と拠点 (住所)、料金内訳と総額 (税込)、
  支払時期・方法 (当日店頭 / 請求書)、予約の成立時点 (確定ボタンを押した時点)、キャンセル規定
  (この車両・この時期の段階表と、いま取り消した場合の金額) と取消方法。
  同意チェックは文書ごとに版を表示。ボタン文言「上記の内容で予約を確定する」。
  確定は `SkyRentBackend.createReservation` (二重送信防止: 冪等キーを sessionStorage に保持、送信中はボタン無効)。
  エラーコードごとの日本語表示と、PRICE_CHANGED 時は新金額を見せて再確認。
  完了画面はメール送信状態に応じて文言を変える (sent / queued / skipped・failed / デモ)。
  照会URLを表示 (「この画面を保存」の案内)。
- **mypage.html**: 会員登録 (メール確認あり。プライバシーポリシー同意必須・案内メール同意は任意で既定OFF)、
  ログイン、パスワード再設定、ログアウト、プロフィール編集、ポイント・クーポン、予約一覧、
  キャンセル (料金を表示して確認)、退会。`#lookup=<id>.<token>` で開いたらゲスト照会・キャンセル。
- **contact.html**: `SkyRentBackend.submitInquiry`。ハニーポット欄を追加 (非表示)。
- **search.html / detail.html**: 担当者不在・受け渡し重複の時間帯は選べない/理由を表示 (`staffCheck`)。
- **privacy.html**: 本番時の保存先 (Supabase・東京リージョン)、メール送信 (Resend)、Google カレンダー
  (予約番号・車両・お名前・日時を担当者カレンダーへ登録) を委託先として追記。デモの localStorage 記述は
  「デモ環境では」と限定。免許番号はWeb予約では取得しない旨。

### 4.7 管理画面

- **login.html**: メール + パスワード → TOTP 未登録なら登録 (QR と手入力キー表示) → 6桁コード → AAL2。
  登録済みなら 6桁コード。パスワード再設定メール。デモモードは従来どおり。
- **partials.js**: サイドバーに「お問い合わせ」「メール送信状況」「Googleカレンダー連携」「スタッフ・権限」
  「操作履歴」を追加 (権限の無い項目は隠す)。ヘッダーにスタッフ名・役割・ログアウト。デモの自動セッションは
  デモモードのときだけ。
- 新規: `manage/inquiries.html`, `manage/mail-log.html`, `manage/calendar.html`, `manage/staff.html`,
  `manage/audit.html` (どれもデモモードでも「本番接続時に使えます」と説明を出して壊れないこと)。
- `manage/reservation-list.html`: キャンセル時にキャンセル料 (pricing-core) を提示して確定。
  貸出停止枠 (整備・車検) の登録/解除。
- `manage/members.html`: 本番では「会員を招待」(メール) に置換。

---

## 5. 守ること

- 画面に出す値はすべてエスケープ (既存の `esc()` を使う)。`innerHTML` に生の入力を入れない。
- 個人情報を console / localStorage / URL クエリに出さない (照会トークンは URL の # 以降のみ)。
- 文言は日本語・です/ます。エラーは「何が起きたか + どうすればよいか」。
- 既存画面の見た目 (黒×オレンジ / 管理画面の既存スタイル) に合わせる。
- デモモードの挙動を壊さない (GitHub Pages の公開デモは本番設定なしで動き続ける)。

---

## 6. 実装後に確定した事項 (2026-09-23)

- **拠点スコープ**: 担当拠点を持つスタッフは、その拠点の予約に加えて、その拠点で取引のある会員・ポイント・クーポン・請求書・
  問い合わせ・メール送信記録だけを読める (`20260923000900_security_fixes.sql` の `staff_can_member` ほか)。
  どの拠点とも取引のない会員・一般の問い合わせは全スタッフに見える。予約の付け替えも担当拠点の車両の間だけ。
- **会員の予約の読み取り**: 予約表の直接 select は不可。`member_reservations()` がスタッフ用の列 (staff_note 等) を除いて返す。
- **予約の上限**: ゲストは1件31日・同じメール/電話で有効3件・合計31日、会員は1件93日・有効10件・合計279日 (`api/index.ts` の定数)。
  同じ受信箱への確定メールは1日5通、問い合わせ自動返信は1日3通。問い合わせ種別は画面の選択肢のみ受け付け、自動返信に入力内容を載せない。
- **レート制限の IP**: 既定では X-Forwarded-For の右端の公開アドレス。本番で1度ログを見て `CLIENT_IP_HEADER` を決める (`.env.example`)。
- **ポイント手動調整**: 1回 ±100pt・理由必須 (`20260923000950_points_adjust_cap.sql`)。
- **外部スクリプト**: supabase-js / chart.js / exceljs は版を固定し SRI (sha384) を付ける。版を上げたらハッシュも更新する。
- **テスト**: `npm test` (料金・画面) / `npm run test:functions` (Edge Functions、ファイルは直列実行) / `npm run test:db` または
  `supabase test db` (pgTAP)。モックの起動は `npm run mock:google` / `npm run mock:resend`、ダミー鍵は `npm run test:fixtures`。

