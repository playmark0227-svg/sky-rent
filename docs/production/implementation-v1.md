# 本番実装 v1 — 実装契約書

更新日: 2026-10-02 (家電レンタル = 家電だけのレンタル → §8) / 対象: グロースレンタカー (公開サイト・会員・管理画面)

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
  cancellationBase(input) -> int              // キャンセル料の元になる利用料金 (車両 = 基本料金 / 家電レンタル = 家電の料金の合計)
  isJapaneseHoliday(ymd, rules?) -> boolean   // 'YYYY-MM-DD' (JST)
  holidayName(ymd) -> string|null,
  jstParts(isoOrDate) -> {y,m,d,hh,mm,dow,ymd},
  hoursBetween(start, end) -> int              // 端数切り上げ、最低1
}
```

### quote(input)

```
input = {
  asset:    {id, categoryId, categoryType, priceHour, priceDay, customFields:{bodyType?}},
                                  // categoryType: 'vehicle' | 'item' (カテゴリの type。家電レンタルは 'item'。省略時は vehicle 扱い)
  start, end,                     // ISO 文字列 or Date
  options:  [{id, name, price, priceShort, priceType, categoryIds, exclusiveGroup, includes}],  // 選択されたもの
                                  // includes: セットに含まれる品目の id の配列 (家電セットだけ。配列でなければ無視)
  discountType: null | 'student' | 'corporate' | 'dual_residence' | 'shusei_club',
  coupon:   null | {id, amount},
  rules:    pricing_rules (省略時 DEFAULT_RULES)
}
Quote = {
  ok: boolean, errors: [code...],       // 例: 'INVALID_PERIOD', 'OPTION_CONFLICT', 'DISCOUNT_NOT_APPLICABLE', 'ITEM_REQUIRED'
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
   priceShort が無い装備オプションは、6時間以内でも price (24時間料金)。25時間なら ×2。
   per_rental は1回。次のどちらかなら errors に 'OPTION_CONFLICT' (同時に選べないオプション):
   - 同じ exclusiveGroup を2つ以上 (補償 CDW と PAP)。
   - 選ばれたオプションのどれかの includes に、同時に選ばれた別のオプションの id が入っている
     (家電セット OP010 と、セットに含まれる OP001〜OP009。二重請求の防止)。
3. **繁忙期割増** busyFee(550) を1回。利用期間が触れる暦日 (JST、開始日〜終了時刻の1ms前の日) に
   busyPeriods (MM-DD, 年またぎ可) が1日でもあれば適用。busy = true。
4. **土日祝割増** weekendHolidayFee(330) を1回。触れる暦日に土・日・祝日 (extraHolidays 含む) があれば適用。
   **繁忙期が適用されたときは付けない。**
5. **夜間料金** nightFee(1100)。貸出時刻・返却時刻それぞれ (JST) が nightStartHour(20)〜翌 nightEndHour(8)
   (20:00 以上 または 8:00 未満) なら1回ずつ。両方なら2回 (= 2,200)。
6. **割引** (1つだけ): 利用時間 ≥ minHours(24) かつ categoryIds 条件を満たすとき、基本料金から amount 引き
   (基本料金を超えない。オプション・割増には効かない)。満たさない場合は errors に 'DISCOUNT_NOT_APPLICABLE' を入れ、割引しない。
7. **クーポン**: 小計から amount 引き (0円未満にしない)。
8. total = subtotal − discount − couponDiscount。

**家電レンタル (`asset.categoryType === 'item'`) の違い** (2026-10。§8):
- 料金が 0・時間料金なしでも `INVALID_ASSET` にしない (基本料金 0。料金の行は選んだ家電だけで、基本料金の行は出さない)。
- オプションが1つも無ければ errors に `'ITEM_REQUIRED'` (「お借りになる家電を1つ以上お選びください。」)。
- 3〜5 の割増 (繁忙期・土日祝・夜間) はかけない。`rules.itemSurcharges === true` のときだけかける (既定 false)。
- 6 の割引は使えない。指定されたら `'DISCOUNT_NOT_APPLICABLE'` (割引は基本料金にだけ効くため)。
- 7 のクーポンは車両と同じ。オプション (家電) の料金の計算・`OPTION_CONFLICT` も車両と同じ。

祝日: 内閣府の祝日法ロジック (固定日・ハッピーマンデー・春分/秋分の簡易式・振替休日・国民の休日) を実装。
テストで 2026・2027 年の全祝日を検証する
(2026: 1/1,1/12,2/11,2/23,3/20,4/29,5/3,5/4,5/5,5/6(振替),7/20,8/11,9/21,9/22(国民の休日),9/23,10/12,11/3,11/23 /
 2027: 1/1,1/11,2/11,2/23,3/21,3/22(振替),4/29,5/3,5/4,5/5,7/19,8/11,9/20,9/23,10/11,11/3,11/23)。

### cancellationFee(input)

```
input = { asset, category:{id}, start, cancelAt, base, noShow?: boolean, rules }
Fee = { cls: 'compact'|'large'|'kitchen'|'item', busy, daysBefore, pct, fee, label }
```
- 車種区分: categoryClass[category.id] → なければ classOf[asset.customFields.bodyType] → 既定 'compact'。
  家電レンタルは `categoryClass['cat-appliance'] = 'item'` (段階はコンパクトと同じ割合。§8)。
- `base` (キャンセル料の元になる利用料金): 車両 = quote の `base` (基本料金)。家電レンタル = 家電 (オプション) の料金の合計
  (基本料金が 0 のため)。`cancellationBase({price, total, categoryType | isItem | is_item})` で求める
  (車両: `price.base`、無ければ total / 家電レンタル: `price.lines` のうち `code = 'option'` の合計、内訳が無ければ total)。
  呼ぶ側はすべてこの値を使う: api の lookup / cancel (`_shared/catalog.ts` の `cancellationFor`)・メールのキャンセル規定・デモの backend は
  この関数 (`SkyRentPricing.cancellationBase` 経由を含む)。booking.html の最終確認 (見積の `lines`) と管理画面の予約一覧は
  同じ計算 (オプションの行の合計) を画面の中で行う。マイページは lookup が返すキャンセル料を表示する。
- daysBefore = JST の暦日差 (貸出日 − 取消日)。当日 0、前日 1、前々日 2。
- busy = 貸出日 (JST) が busyPeriods 内。tiers = rules.cancellation[busy ? 'busy' : 'normal'][cls]。
  daysBefore ≥ minDays を満たす最初の段の pct。noShow なら noShowPct。
- fee = floor(base × pct / 100)。label 例: 「前日 (30%)」「3日前以降は無料」。

### js/pricing.js (既存画面向けアダプタ)

`SkyRentPricing.calculate({asset,start,end,quantity,options,coupon,discountType})` を維持し、
中で `quote()` を呼んで旧形式 `{lines:[{label,amount}], days, hours, plan, subtotal, discount, total}` を返す。
rules は `SkyRentStore.read('settings.pricing_rules')` → 無ければ DEFAULT_RULES。
`SkyRentPricing.cancellationFee(...)`, `SkyRentPricing.cancellationBase(...)`, `SkyRentPricing.rules()` も公開する。
quote に渡す asset には `categoryType` をカテゴリの type から補う (store の値は書き換えない)。

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
| OPTION_INVALID | 400 | 無効・存在しない・この車両のカテゴリでは選べないオプション (pricing-core の OPTION_NOT_APPLICABLE もこれで返す)。`fields.optionIds` |
| OPTION_CONFLICT | 400 | 同時に選べないオプション (補償を2つ / 家電セットとセットに含まれる品目)。`fields.optionIds` と `quote` (errors に OPTION_CONFLICT) を同梱 |
| ITEM_REQUIRED | 400 | 家電レンタルで家電 (オプション) を1つも選んでいない (pricing-core の `ITEM_REQUIRED`)。「お借りになる家電を1つ以上お選びください。」 |
| UNAUTHENTICATED | 401 | ログインが必要 |
| FORBIDDEN / INVOICE_NOT_ALLOWED | 403 | 権限なし |
| NOT_FOUND | 404 | |
| AVAILABILITY_CONFLICT | 409 | 車両が埋まっている |
| OPTION_SOLD_OUT | 409 | 選んだ家電 (装備オプション) のどれかが、その日時はすでに貸し出し中 (在庫切れ。§8)。`details.optionIds` (売り切れの家電の id。家電セットを選んだ場合はセット自身の id も) と `fields.optionIds` |
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
   家電レンタルの予約 (`is_item`) は busy に含めない (`public_busy_ranges` が返さない。窓口 A001 は重なりで止めないため)。
   店頭での受け渡しはあるので handovers には含める。
2. `POST /api/quote` `{assetId, start, end, optionIds, discountType?, couponId?}`
   → `{ok, quote, categoryType:'vehicle'|'item', availability:{vehicle:bool, staff:bool, handover:bool, options:bool, reasons:[code]}, unavailableOptionIds:[id...]}`
   (家電レンタルは車両の重なりを見ないので `vehicle` は常に true。選んだ家電が `unavailableOptionIds` に入っていれば
   `options = false`・reasons に `OPTION_SOLD_OUT`)
   (クーポンはログイン会員本人の未使用分のみ有効。サーバー側カタログと pricing_rules で計算。
   オプションの単価・exclusiveGroup・includes も DB の options 行から取り、クライアントが送る値は使わない。
   asset の `categoryType` はカテゴリの type を `coreAsset` で渡す)
   料金ルール上の不備 (期間・`OPTION_CONFLICT`・割引条件・`ITEM_REQUIRED`) は HTTP 200 のまま `quote.ok = false`・`quote.errors` で返す
   (detail.html / booking.html はこれを見て理由を出す)。無効・存在しないオプションは 400 `OPTION_INVALID`
   (家電レンタルで補償などを送ったときの文は「選択されたオプションは家電レンタルではご利用いただけません。…」)。
   400 `OPTION_CONFLICT` / `ITEM_REQUIRED` を返すのは `POST /api/reservations` だけ。
   `unavailableOptionIds` = その期間に貸し出せない (残り0の) 家電の id (`unavailable_option_ids(start, end)`。§8)。
   家電セットは中の9品目のどれかが残り0なら含める。選んでいるかどうかに関係なく返す (画面はその家電を選べなくする)。
   デモモードでも `SkyRentStore.unavailableOptionIds(startIso, endIso, excludeReservationId)` で同じ値を返す。
3. `POST /api/reservations`
   ```
   {idempotencyKey, assetId, start, end, optionIds, discountType?, couponId?,
    customer:{name, kana, email, phone, company}, paymentMethod:'onsite'|'invoice',
    licenseConfirmed:true, note, expectedTotal,
    consent:{documents:[{id,version}], agreedAt}}
   ```
   手順: 検証 → レート制限 (IP ハッシュ 10回/10分) → カタログ・ルール取得 → quote (サーバー計算) →
   `expectedTotal` と不一致なら PRICE_CHANGED → 必須同意 (車両 = clause, cancel, privacy / 家電レンタル = item_clause, cancel, privacy の
   active 版。`requireConsent` の必須文書をカテゴリの type で切り替える) を確認 →
   担当者の空き (§3、Google へ直接問い合わせ・キャッシュを使わない) → `create_reservation_tx`
   (handover_minutes は calendar.oneHandoverAtATime のとき handoverMinutes。家電の在庫もこの中で判定し、
   足りなければ 409 `OPTION_SOLD_OUT`) → worker を同期実行 (待ち最大 8 秒)。
   `licenseConfirmed: true` は車両だけ必須 (家電レンタルでは求めない)。家電レンタルで家電が0件なら 400 `ITEM_REQUIRED`。
   → `{ok, reservation:{id, assetId, start, end, total, price, status, paymentMethod},
       guestToken, lookupUrl, email:{status:'sent'|'queued'|'skipped'|'failed'}}`
   メール: お客様 `reservation_confirmed`、店舗 `reservation_new_shop`。
4. `POST /api/reservations/lookup` `{id, token?}` (会員は token 不要で本人分)
   → `{ok, reservation:{...安全な項目, assetName, locationName, categoryType:'vehicle'|'item', isItem}, cancellation:{cancellable, fee, pct, label}}`
   (`categoryType` / `isItem` はマイページ・照会画面で家電レンタルの表示 (お受け取り/ご返却・家電の一覧) に切り替えるため)
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
  家電レンタルは「車両」→「家電レンタル」、「貸出/返却」→「お受け取り/ご返却」とし、借りる家電の一覧を必ず入れる。
  運転免許の持参案内は出さず、「本人確認書類 (運転免許証・保険証など)」を案内する (お客様・店舗の両方。§8)。
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
- 件名 `【貸出】R00012 マツダ CX-5 / 山田 太郎 様`、`【返却】…`。家電レンタルは `【家電受取】` / `【家電返却】`
  (説明に入れる項目は車両と同じ。借りる家電の品目名は入れない)
- 時間: 貸出 `[start, start+handoverMinutes)`、返却 `[end, end+handoverMinutes)`、timeZone Asia/Tokyo
- `transparency: 'transparent'` (空き判定に影響させない)、`extendedProperties.private.skyrent = 予約番号`
- 説明: 予約番号・車両・人数ではなく **電話番号は入れない** (外部サービスへの個人情報の送信を最小化)。
  管理画面の予約一覧 URL (`SITE_URL + 'manage/reservation-list.html'`) を入れる。
  予約のオプション (補償・装備) の名前は入れない (プライバシーポリシー §5 で Google カレンダーに登録すると書いた項目は
  予約番号・車両・お名前・貸出と返却の日時だけ。装備の準備は管理画面の予約一覧で確認する。マニュアル 7.2)。
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
  `public_catalog` の `options[].extra` は `description` と `includes` だけを返す (extra の他の項目は出さない。
  `20260930000100_equipment_options.sql`)。
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
| option `{optionId, name, price, priceShort, priceType, categoryIds, kind, exclusiveGroup, active, sort, description, includes}` | options (`extra.description`, `extra.includes`) |
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
  家電レンタル (§8) では免許の確認を出さず、同意を「物品レンタル規約・キャンセル規定・プライバシーポリシー」にし、
  「車両」「貸出/返却」を「家電レンタル」「お受け取り/ご返却」と表示する。在庫切れ (`OPTION_SOLD_OUT`)・`ITEM_REQUIRED` はオプションのエラーと同じく、選び直し (詳細画面へ) を出す。
- **mypage.html**: 会員登録 (メール確認あり。プライバシーポリシー同意必須・案内メール同意は任意で既定OFF)、
  ログイン、パスワード再設定、ログアウト、プロフィール編集、ポイント・クーポン、予約一覧、
  キャンセル (料金を表示して確認)、退会。`#lookup=<id>.<token>` で開いたらゲスト照会・キャンセル。
- **contact.html**: `SkyRentBackend.submitInquiry`。ハニーポット欄を追加 (非表示)。
- **search.html / detail.html**: 担当者不在・受け渡し重複の時間帯は選べない/理由を表示 (`staffCheck`)。
- **detail.html のオプション** (booking.html は選んだものを引き継ぐ): kind で見出しを分ける。
  `kind = 'cover'` → 「補償オプション」(1つだけ選べる)、それ以外 → 「装備オプション」(全車共通・24時間ごと)。補償を先、装備を後。
  英語は 'Coverage' / 'Equipment'。説明 (装備は型番) を名前の下に小さく出す。
  家電セットにチェックを入れると、includes の9品目のチェックを外して無効にし「家電セットに含まれています」と出す。外すと元に戻す。
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
  貸出停止枠 (整備・車検) の登録/解除 (家電レンタルのアセットには作れない。§8)。
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

---

## 7. 装備オプションの復活 (2026-09-30)

2026-09-04 に全廃した装備オプション11品目を、事業者の依頼で戻した (総合料金表 2026年6月改定版どおり)。
品目・料金・型番の一覧は [`../dev-contract.md`](../dev-contract.md) の options の節。

| 項目 | 内容 |
|---|---|
| データ | `options` に OP001〜OP011 (`supabase/seed.sql`)。`price_type = 'per_day'`、`price_short = null`、`category_ids = null` (全車共通)、`kind = 'other'`、`exclusive_group = null`、`sort` 11〜21。型番は `extra.description`。家電セット OP010 だけ `extra.includes = ["OP001", …, "OP009"]` |
| 料金 | §1 の per_day のまま (24時間ごと。6時間以内でも24時間料金)。割引はオプションに効かない |
| 同時に選べない組み合わせ | 家電セットと、セットに含まれる品目 → `OPTION_CONFLICT` (§1 の 2.)。サーバーは DB の `extra.includes` を `coreOption` 経由で pricing-core に渡す (`supabase/functions/_shared/catalog.ts`) |
| マイグレーション | `20260930000100_equipment_options.sql` — `public_catalog()` を再定義し、`options[].extra` に `includes` を加える (`20260923000600_catalog_settings_tweaks.sql` の定義がもと。security definer・`search_path = ''`・anon / authenticated への実行権限は同じ) |
| エラーの文言 | `OPTION_CONFLICT` を補償専用から一般化。画面・API: 「同時に選べないオプションが選ばれています。補償は1つまで、家電セットに含まれる品目は個別に追加できません。」 / 入力欄 (`errors.ts`): 「同時に選べないオプションが選ばれています。」 |
| 画面 | detail.html の見出しを「補償オプション」「装備オプション」に分け、家電セットの中身を自動で外す (§4.6)。booking.html の確認画面も2行に分け、オプションのエラーでは「オプションを選び直す」(詳細画面へ) を出す |
| 管理画面 | `manage/options.html` に種類 (補償 / 装備)・説明・セットに含む品目を追加 (新規は装備が既定)。予約詳細・貸渡証・チェックシート (家電セットは中の9品目に分ける)・領収書にオプションの行 |
| スキーマ | `options.kind` の既定値を `'cover'` → `'other'` (種類を指定せずに追加したオプションが補償として扱われないように。同じマイグレーション) |
| Google カレンダー | 変更なし。予定の説明にオプション名は入れない (プライバシーポリシーの登録項目に無いため。§3.3)。載せる場合はプライバシーポリシーの改定と版の更新が要る |
| デモデータ | `js/store.js` の DATA_VERSION 7 → 8。7 のデータは予約・会員を残して装備オプションを足す。6 以前は作り直し |
| お問い合わせ | 種類に「装備オプションについて」を戻した (`contact.html` と `_shared/mail-templates.ts` の `INQUIRY_TOPICS`。並びは撤去前と同じ「キッチンカーのレンタルについて」の次) |
| 法務文書の版 | `law.html` の本文 (事業内容・料金) が変わるため、`legal_documents` の `law` だけ版 `2026-10` (effective_at `2026-10-01`)。予約時の同意対象 (clause / cancel / privacy) は据え置き |
| 在庫 | 装備オプションに在庫数の管理は無い (撤去前と同じ)。同じ時間帯に同じ品目の予約が重なっても止めない。要否は事業者に確認 ([現状監査 §10.5](current-state-audit.md#105-実装で新たに置いた業務ルール-要確認))。**→ 2026-10 に在庫 (`options.stock`) を入れた (§8)** |
| seed 投入済みの本番 | seed は入れ直さない。migration の push・Edge Functions の再公開・装備オプションの insert (seed の該当文)・`law` の版の切り替え (旧版の active を false にしてから 2026-10 を入れる。`legal_documents_one_active` があるため seed の insert だけでは切り替わらない) を [手順書 2-5](setup.md#2-5-既に-seed-を入れた本番に装備オプションを追加する-2026-09-30-の更新) の順に行う |

戻していないもの (撤去前の記述のうち、事実と違ったもの): 料金表に無いオプション (発電機・フライヤー・鉄板・のぼり旗など)、
家電・工具の単体レンタルとそのカテゴリ、電話でのキャンセル受付。
(家電の単体レンタルは、2026-10 に事業者の依頼で新しく始めた。§8。工具は今も取り扱わない)

---

## 8. 家電レンタル (2026-10)

事業者の依頼「車の貸し出しにオプション、ではなくそのまま家電貸出だけもやりたい」に対応した。
車を借りずに、装備オプションの家電だけを借りられる。車両の予約に付けるオプションとしての提供 (§7) はそのまま続ける。

### 8.1 しくみ

- 新カテゴリ `cat-appliance` (家電レンタル / Appliance Rental、`type = 'item'`、icon 🔌、sort 3、`custom_field_defs = []`)。
- 新アセット `A001` (家電レンタル（北見本店）、`loc-kitami`、`price_day = 0`、`price_hour = null`、`capacity = null`、sort 7)。
  家電そのものではなく **受け取り窓口**。家電レンタルの予約はすべてこのアセットに入る。
- 借りる家電は、既存の装備オプション OP001〜OP011 (`category_ids = null`) をこの予約で選ぶ。1予約で複数可・各品目1つずつ (数量の指定は無い)。
  補償 (CDW / PAP。cat-rental / cat-kitchen 専用) は出ない。家電を1つ以上選ぶのが必須 (`ITEM_REQUIRED`)。
- 料金 = 選んだ家電の24時間ごとの料金の合計 (基本料金 0)。割増なし・割引なし・クーポンは可 (§1 の「家電レンタルの違い」)。
- 受け取り・返却は北見本店。配送はしない。運転免許は不要 (受け取り時に本人確認書類を確認)。`license_confirmed` を求めない。
- ゲスト予約の上限 (1件31日・有効3件)・返却時のポイント付与は車両と同じ。

### 8.2 在庫 (車両のオプションと家電だけの予約で同じ在庫を使う)

- `options.stock int` (null = 数えない、0 以上)。seed: OP001〜OP009・OP011 = 1、OP010 (家電セット) = null (中の9品目の在庫を使う)、補償4件 = null。
- 家電 X の **使用数** = 期間内の「同時に貸し出している数の最大値」。数えるのは `status in ('confirmed','in_use')`・`kind = 'rental'` の予約で、
  `option_ids` を展開した集合 (選んだ id + その id の `extra.includes`) に X を含むもの。車両の予約も家電だけの予約も数える。変更時は自分自身を除く。
  同時最大は「期間の開始時点」と「期間内に始まる各予約の開始時点」で数えた件数の最大で求める。
- 予約で選んだ (展開後の) 在庫ありの家電のどれかが `使用数 + 1 > stock` なら `OPTION_SOLD_OUT` (409)。
  `details.optionIds` = 売り切れの家電の id (家電セットを選んだ場合はセット自身の id も)、`fields.optionIds` =「ご希望の日時は貸し出し中の家電があります。」。
  画面・API の文:「お選びの家電のうち、ご希望の日時はすでに貸し出し中のものがあります。別の日時か別の家電をお選びください。」
- **同時実行**: 予約の作成・日時変更の取引の中で、アセットの advisory lock (`hashtext('asset:'||asset_id)`) を取った後に、
  関係する在庫ありの家電ごとに `pg_advisory_xact_lock(hashtext('option:'||option_id))` を **id の昇順** で取ってから数える (デッドロック防止)。
- 見積 (`/api/quote`) の `unavailableOptionIds` = その期間に残り0の家電の id (家電セットは中の9品目のどれかが残り0なら含める)。

### 8.3 DB (`supabase/migrations/20261002000100_item_rental.sql`)

| 対象 | 内容 |
|---|---|
| `options.stock` | `int` (null 可・0 以上の check)。null = 在庫を数えない |
| `reservations.is_item` | `boolean not null default false`。トリガー `reservations_set_is_item` (before insert / update of `category_id`・`asset_id`・`is_item`) が `categories.type = 'item'` のとき true にする (直接書き換えても正しい値に戻る)。既存の予約も埋め戻す。画面・API からは送らない |
| カテゴリの種類の変更 | トリガー `categories_sync_is_item` (after update of `type`): そのカテゴリの予約の `is_item` を合わせる。物品 → 車両に変えるとき、同じ時間に重なる有効な予約があれば VALIDATION「このカテゴリには同じ時間に重なる予約があるため、車両レンタルに変えられません。」 |
| `reservations_no_overlap` | `where (status in ('confirmed','in_use') and not is_item)` に作り直す (家電レンタルの窓口 A001 には同じ時間に何件でも予約が入る。止めるのは在庫) |
| 索引 `reservations_option_period_idx` | `gist (period) where status in ('confirmed','in_use') and kind = 'rental' and cardinality(option_ids) > 0` (使用数を数えるため) |
| `public_busy_ranges` | `is_item` の予約を返さない |
| `member_reservations` | 返す項目に `is_item` を足す (マイページの「お受け取り/ご返却」の表示用) |
| `public.option_sold_out(p_option_ids text[], p_period tstzrange, p_exclude text default null) returns text[]` | 予約時の判定用。売り切れの家電の id (昇順。家電セットを選んだ場合はセット自身の id も)。空配列 = 在庫あり |
| `public.unavailable_option_ids(p_start timestamptz, p_end timestamptz, p_exclude text default null) returns text[]` | 見積用。その期間に残り0の家電の id |
| 内部の関数 | `options_expand(text[])` (選んだ id + `extra.includes`。重複なし・id 順)、`option_usage(id, period, exclude)` (同時最大の使用数)、`lock_option_stock(text[])` (在庫ありの家電の advisory lock を id 順に取る) |
| 実行権限 | 上の5関数は service_role だけ (anon / authenticated / public から revoke して service_role に grant)。トリガー関数 (`reservations_set_is_item` / `categories_sync_is_item`) は revoke だけ (直接は誰も実行しない)。管理画面の RPC は security definer の中から呼ぶ |
| `create_reservation_tx` | 家電レンタルで家電が0件なら `ITEM_REQUIRED`。アセットのロックの後に家電のロックを取り、`option_sold_out` が空でなければ `OPTION_SOLD_OUT` (detail = 売り切れの id のカンマ区切り。Edge Function が `details.optionIds` に直す) |
| `admin_create_reservation` | 家電レンタルのアセットに `kind = 'block'` → VALIDATION「家電レンタルには貸出停止枠を作れません。家電ごとの在庫はオプション管理で変えてください。」。家電0件なら `ITEM_REQUIRED`。在庫の判定は同じ |
| `admin_update_reservation` | 日時・アセットの変更や、取消・無断キャンセルからの戻しで有効になるときに在庫を判定 (自分自身は数えない)。車両の予約と家電レンタルの予約の間の付け替えは VALIDATION「車両の予約と家電レンタルの予約の間では付け替えできません。」 |
| 受け渡しの判定 | handover lock・`oneHandoverAtATime` は家電レンタルにもそのまま適用 (店頭での受け渡しがあるため) |

### 8.4 seed (`supabase/seed.sql`)

- `categories` に `cat-appliance`、`assets` に `A001`、`options` の OP001〜OP011 に `stock` (上の値)。
- `pricing_rules`: `version` を `'2026-10'`、`cancellation.categoryClass` に `'cat-appliance': 'item'`、
  `cancellation.normal.item = [{minDays:3,pct:0},{minDays:1,pct:30},{minDays:0,pct:50}]`、
  `cancellation.busy.item = [{minDays:7,pct:0},{minDays:1,pct:30},{minDays:0,pct:50}]` (無断は `noShowPct` 100)。`itemSurcharges` は既定 false。
- `legal_documents`: `('item_clause', '2026-10', '物品レンタル規約', 'item-terms.html', '2026-10-01')` を追加。
  `cancel` は版 `'2026-10'` (effective `2026-10-01`。law.html#cancel に家電レンタルの段階を足したため)。clause / privacy は据え置き。law は 2026-10 のまま。
- seed 投入済みの本番は seed を入れ直さず、[手順書 2-6](setup.md#2-6-既に-seed-を入れた本番に家電レンタルを追加する-2026-10-の更新) の SQL で足す。

### 8.5 変更一覧

| 項目 | 内容 |
|---|---|
| 料金エンジン | `js/pricing-core.js` (編集後 `npm run sync-shared`)。`input.asset.categoryType` で分岐 (§1)。`ITEM_REQUIRED`、割増なし (`rules.itemSurcharges`)、割引不可。キャンセル料の区分 `item` と、元になる利用料金 = 家電の料金の合計 |
| サーバー (api) | `coreAsset` に `categoryType`。見積に `unavailableOptionIds`。予約の同意文書をカテゴリで切り替え (`item_clause` / `cancel` / `privacy`)。家電レンタルは `licenseConfirmed` 不要。`OPTION_SOLD_OUT` (409)・`ITEM_REQUIRED` (400) |
| メール | 予約確認 (お客様・店舗)・キャンセル: 「家電レンタル」「お受け取り/ご返却」、借りる家電の一覧、本人確認書類の案内 (運転免許の持参案内は出さない) |
| Google カレンダー | 題名【家電受取】/【家電返却】。本文は車両と同じ項目だけ (家電の品目名は書かない。プライバシーポリシーどおり) |
| 公開画面 | 検索・一覧に「家電レンタル」。詳細では家電 (装備オプション) を選ぶ形にし、`unavailableOptionIds` の家電は選べなくする。予約画面は免許の確認を出さず、同意を物品レンタル規約に切り替える。マイページも「お受け取り/ご返却」と家電の一覧 |
| 管理画面 | オプション管理に在庫数。予約一覧・詳細・ダッシュボードで「お受け取り/ご返却」と家電の一覧。家電レンタルには貸出停止枠を出さない。帳票は物品貸出書 (家電を1行ずつ。家電セットは中の9品目に分ける)。貸渡実績報告書 (陸運局) から家電レンタルを除く |
| 法務文書 | 新設 `item-terms.html` (物品レンタル規約。版 2026-10)。`law.html#cancel` に家電レンタルの段階を追加し `cancel` を版 2026-10 に。車両の予約も、これからは cancel の 2026-10 版に同意してもらう (サーバーは active 版を確認するため) |
| デモ | `js/store.js` の DATA_VERSION 8 → 9。カテゴリ・A001・在庫 (`stock`)・`unavailableOptionIds()` / `optionSoldOut()` / `optionStock()` / `categoryTypeOf()`。デモの予約確定も在庫切れで `OPTION_SOLD_OUT`。8 のデータは予約・会員・管理画面で変えた値を残して、足りないもの (カテゴリ・A001・在庫・法務文書の版・料金ルールの家電レンタルの項目) だけを足す |
| 事業者に確認 | 既定値 (料金・在庫各1・北見本店のみ・配送なし・延滞・破損・キャンセル料・割増/割引なし・釧路の車両に家電を付けた場合の受け渡し) は [現状監査 §10.5](current-state-audit.md#105-実装で新たに置いた業務ルール-要確認) の末尾 |

変えていないもの: 車両 (cat-rental / cat-kitchen) の予約・料金・キャンセル料・補償・割引の動き。工具・特殊車両・キャンピングカーは取り扱わない。料金表に無い品目は足さない。

