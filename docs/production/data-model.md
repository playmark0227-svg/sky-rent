# 本番データモデル／データ辞書 v1

更新日: 2026-09-16
対象基盤: Supabase（PostgreSQL / Auth / Edge Functions）

## 0. 位置づけ

本書は、[本番化実装ハンドオフ](README.md) と [OpenAPI 3.1 契約](openapi.yaml) を migration に落とす直前の論理データ辞書である。実行可能な SQL/DDL ではない。

- OpenAPI は外部 API の語彙、本文書は内部テーブル・制約・transaction の正とする。差分は実装前に両方を直す。
- DB は UTC、営業日・料金期間は `Asia/Tokyo` で解釈する。予約期間は半開区間 `[start_at, end_at)`。
- 金額は税込 JPY の整数。client が送る価格、会員ID、権限、状態は信頼しない。
- password hash、refresh token、session、MFA factor は Supabase `auth.users` / Auth が管理する。公開schemaへ独自認証テーブルを作らない。
- v1 は物理車両1台を `assets` 1行とし、予約数量は1。集合在庫は別設計として再承認する。

## 1. 命名・型・共通規則

### 1.1 API対応

| DB | API | 規則 |
|---|---|---|
| `public_code` | `assetCode`, `reservationCode` 等 | 外部表示用、一意・変更不可。内部FKに使わない |
| `row_version` | `rowVersion`, HTTP `ETag` | 1から始まる整数。更新は `If-Match` 必須 |
| `start_at`, `end_at` | `startAt`, `endAt` | UTC RFC 3339。DBは生成rangeも保持 |
| `pricing_revisions.public_code` | `pricingRevision` | quote/reservationへ固定 |
| `reservation_quotes.public_code` | `quoteId` | `Q…` 形式の推測困難なcode |
| snake_case | camelCase | serializerで変換しDB列を直接公開しない |

### 1.2 型方針

| 用途 | 方針 |
|---|---|
| PK/FK | UUID、server生成 |
| 外部code | text、最大64文字、format CHECK、table内UNIQUE、採番後不変 |
| 日時 | `timestamptz` UTC。業務日付は `date`、営業時間は `time` + timezone |
| 期間 | `tstzrange` / `daterange`、常に `[)`、start < end |
| 金額 | JPY整数。小数/float禁止。値引きlineだけ負数可 |
| 率 | basis points整数（20%=2000） |
| email | 正規化小文字を `citext` 相当、最大254文字。URL/logへ出さない |
| 電話 | 検索用E.164と表示snapshotを分離 |
| enum | PostgreSQL enumでなく `text + CHECK` を基本としOpenAPIと同時変更 |
| JSON | 設定、price/customer snapshot、監査差分に限定。`schema_version`、サイズ上限、schema検証 |
| token | 原文禁止。HMAC/SHA-256等のhashとkey idだけを保存 |
| 免許番号 | 保存が承認された場合だけfield-level暗号文 + 末尾表示文字列 |

### 1.3 共通列、削除、Auth user削除

- 更新可能な業務tableは `id*`, `created_at*`, `updated_at*`, `row_version*` を持つ。更新成功時だけ version を+1する。
- masterは `active=false` または `deleted_at` の論理削除。参照済み行を物理削除しない。
- 履歴・台帳・監査・明細はappend-only（AO）。訂正行を追加し、既存行を書き換えない。
- 表中の `*` は必須、`RV` はrow versionあり、`AO` はappend-only、`SD` は論理削除。
- FK既定は RESTRICT。退会時だけ profileをlockして `closed` → PII redaction → Auth session/token失効 → `members` / `staff_profiles.auth_user_id` と履歴actor FKをNULL化 → 最後にAuth user hard-deleteとする。actor snapshotは保持し、削除自体を別auditに残す。

### 1.4 API aggregate と親 `row_version`

子行変更もAPI aggregateの変更である。RPCは親をlockし `If-Match` を確認して、子行の追加/変更/revokeと同じtransactionで親versionを1回だけbumpする。子だけのcommitは禁止する。

| 親 | versionをbumpする子 |
|---|---|
| `locations` | business hours、closures |
| `categories` | fields、choices |
| `assets` | images、field values |
| `rental_options` | category links |
| `pricing_revisions` | draftのrate plans、option rates、high seasons/category links |
| `roles` | role permissions。影響するactive staff profileもbump |
| `staff_profiles` | roles、permission overrides、location scopes |
| `members` | API表現へ含むpoint account/ledger/coupon変更 |
| `reservations` | options、price lines、status history、allocation、payments、delivery状態 |
| `invoices` | reservation links、lines、payment/void/reissue |
| `inquiries` | messages、consents、担当/status、delivery状態 |

## 2. enum・状態

| 名前 | 値 |
|---|---|
| `ReservationStatus` | `pending`, `confirmed`, `in_use`, `returned`, `cancelled`, `expired` |
| `PaymentMethod` | `onsite`, `invoice`, `online` |
| `PaymentStatus` | `unpaid`, `pending`, `paid`, `partially_refunded`, `refunded`, `failed` |
| `PaymentBalanceDirection` | `increase_paid`, `decrease_paid` |
| `CouponStatus` | `available`, `redeemed`, `expired`, `void` |
| `InvoiceStatus` | `unpaid`, `paid`, `void`, `overdue` |
| `InquiryStatus` | `new`, `in_progress`, `waiting_customer`, `resolved`, `spam` |
| `EmailDeliveryStatus` | `queued`, `processing`, `sent`, `delivered`, `bounced`, `failed`, `suppressed` |
| `PriceLineType` | `base`, `season_surcharge`, `option`, `discount`, `tax`, `adjustment` |
| `AccountType` | `member`, `staff` |
| `StaffRole` | `viewer`, `maintenance`, `store_staff`, `accounting`, `admin` |
| `MaintenanceStatus` | `scheduled`, `active`, `completed`, `cancelled` |

内部状態: quote=`open|consumed|expired|void`、allocation=`held|committed|consumed|released`、outbox=`pending|processing|succeeded|dead`、import=`uploaded|validating|validated|importing|completed|failed|rolled_back`。

## 3. catalog・営業・料金

| table | PK / FK | 必須列・CHECK | UNIQUE / INDEX | 削除・版 |
|---|---|---|---|---|
| `locations` | PK `id` | `public_code*`, `name_ja*`, `timezone*='Asia/Tokyo'`, 住所、`phone_e164*`, `display_order*`, `active*` | UQ code; IDX active/order | SD/RV |
| `regulatory_location_periods` | PK `id`; FK `location_id*` | 業務発効日の `period*` daterange `[)`、配置事務所名・所在地・管轄運輸支局・報告対象性のsnapshot | 同locationのperiod重複禁止/GiST; jurisdiction/period IDX | 終了periodは不変。改称・移転・開閉は旧periodを閉じ新行 |
| `location_business_hours` | PK `id`; FK `location_id*` | `weekday*` 0–6, `slot_no*`, `is_closed*`, `opens_at`, `closes_at`, `closes_next_day*`; closedは時刻なし、openは両時刻必須・0<duration<24h | UQ `(location,weekday,slot_no)`; 同日複数slotと前日からの翌日跨ぎをlocal timeへ展開し重複禁止 | 親削除禁止/RV |
| `location_closures` | PK `id`; FK `location_id*`, cancel actor→Auth | `period*` `[)`, `kind*=closed|special_hours`, special用時刻/翌日flag、`status*=active|cancelled`, `reason*`, `cancelled_at/by/reason`; statusと取消列を整合 | GiST location/period; active検索IDX | 物理削除禁止/RV。取消で親bump |
| `categories` | PK `id` | `public_code*`, names, `kind*=vehicle|item`, `display_order*`, `active*` | UQ code | SD/RV |
| `category_fields` | PK `id`; FK `category_id*` | `field_key*`, label, `data_type*=text|number|select|boolean`, `required*`, `filterable*`, order | UQ category/key | 参照済み無効化/RV |
| `category_field_choices` | PK `id`; FK field* | value/labels/order/active、親type=selectのみ | UQ field/value | SD/RV |
| `assets` | PK `id`; FK category/location* | code、names、plate、`capacity*>0`, `stock_quantity*=1`, license/inspection dates、status、published、order | UQ code/plate; IDX location/status/published、category/status、期限 | SD/RV |
| `regulatory_asset_assignment_periods` | PK `id`; FK `asset_id*`, `location_id*` | 業務発効日の `period*` daterange `[)`、現行様式の車種区分・報告対象性のsnapshot | 同assetのperiod重複禁止/GiST; location/period/vehicle class IDX | 終了periodは不変。移管・車種区分変更・廃車は旧periodを閉じ新行 |
| `asset_images` | PK `id`; FK asset* | url、alt、order、active。scheme/domain/最大20 | UQ asset/url | SD/RV |
| `asset_field_values` | PK `id`; FK asset/field* | text/number/boolean/choiceのexactly-one、category/type一致 | UQ asset/field; filter IDX | 親追随/RV |
| `rental_options` | PK `id` | code、names、`scope*=all|selected`, active、order | UQ code | SD/RV |
| `rental_option_categories` | 複合PK/FK option/category | selectedのみ。allには行なし | PK | 親bump |
| `pricing_revisions` | PK `id`; FK approved_by→Auth | code、`status*=draft|active|retired`, effective range、currency JPY、published_at | UQ code; active期間重複禁止 | 発行後不変/RV |
| `rate_plans` | PK `id`; FK revision*、任意asset/category/location | rule type、fixed yenまたはbpsのexactly-one、priority、conditions | UQ revision/scope/type/priority | 発行後AO |
| `rental_option_rates` | PK `id`; FK revision/option* | `billing_unit*=per_day|per_rental`, amount>=0、JPY | UQ revision/option | 発行後AO |
| `high_seasons` | PK `id`; FK revision*、任意location | code/name、local daterange `[)`、fixed/bps、priority、active | UQ code; 競合期間禁止/GiST | draft中RV、発行後不変 |
| `high_season_categories` | 複合PK/FK season/category | 0件は全category | PK | 発行後不変 |
| `app_settings` | PK `id`; FK updated_by→Auth | key、schema_version、value、active。schema検証、secret禁止 | UQ key | SD/RV |

営業時間は `(weekday, slot_no)` で昼休み等の複数枠を表す。`closes_next_day=true` は22:00–翌02:00等を表し、前後曜日のslot/closureとUTCへ展開した後にも重ならないことをtestする。通常営業時間よりclosure/special hoursを優先する。

## 4. Auth・会員・staff・法的文書

| table | PK / FK | 必須列・CHECK | UNIQUE / INDEX | 削除・版 |
|---|---|---|---|---|
| `auth.users` | Supabase管理PK | email/password hash/MFA/Auth metadataはAuth管理 | Auth制約 | §1.3のorchestrator以外でhard-delete禁止 |
| `members` | PK; FK `auth_user_id` | code、name、email、phone、company/address、corporate、invoice_allowed、status | UQ code/auth user; active email partial UQ | closed後PII redaction/RV |
| `staff_profiles` | PK; FK auth user/primary location | code、display name、email、account_type=staff、status | UQ code/auth user; IDX status/location | closed無効化/RV |
| `roles` | PK | code/name/active。初期値は5 StaffRole | UQ code | 使用中削除禁止/RV |
| `permissions` | PK | code/description/sensitivity | UQ code | 原則削除禁止/RV |
| `staff_roles` | PK; FK staff/role、grant/revoke actor | grant/revoke時刻、activeは1 staff 1 role | active staff partial UQ | revoke保持/RV |
| `role_permissions` | 複合PK/FK role/permission | — | PK | admin+audit、親bump |
| `staff_permission_overrides` | PK; FK staff/permission/actors | `effect*=allow|deny`, grant/revoke。deny優先 | active staff/permission partial UQ | revoke保持/RV |
| `staff_location_scopes` | PK; FK staff/location/actors | grant/revoke | active staff/location partial UQ | revoke保持/RV |
| `legal_document_versions` | PK; FK `approved_by`→Auth | `document_type*=rental_terms|pricing|commercial_disclosure|privacy|external_transmission|site_terms|accessibility|cancellation|marketing`, version、`language*`（BCP 47）、content_hash、published/effective日時、approved_at、immutable URI | UQ type/language/version、type/language/hash | AO、公開後変更禁止 |
| `consent_records` | PK; FK member/document version、任意marketing event | `evidence_kind*=accepted|acknowledged|opted_in|declined|withdrawn`, occurred_at、source、language、evidence_hash、request_id。規約はaccepted、privacy等の通知はacknowledged、marketingだけopted_in/declined/withdrawn | IDX member/document/time | AO |

MFA factor/challenge/recoveryはAuthだけに置く。OpenAPI `/admin` の `x-requires-aal2:true` は署名済みJWTのAAL2へ対応し、API/RPCがsession失効とAALを毎回再確認する。

法的文書は公開済み不変版だけを保存し、public safe viewは有効版のversion/hash/URIだけを返す。会員登録、予約、問い合わせはserver transaction内で対象versionを固定する。

## 5. quote・予約・在庫・整備・支払

| table | PK / FK | 必須列・CHECK | UNIQUE / INDEX | 削除・版 |
|---|---|---|---|---|
| `reservation_quotes` | PK; FK member、asset*、revision*、coupon | Q code、start/end/range、quantity=1、option/asset/price snapshot、input hash、金額、status、expires_at | UQ code; IDX status/expiry、asset/range | 内容不変、status用RV、期限後削除 |
| `reservations` | PK; FK quote/member/asset/category/location/revision | code、source、start/end/range、quantity=1、status、hold expiry、payment method/status、金額、顧客/asset/location snapshot、免許last4、Hで予約時取得を承認した場合だけ短期暗号文、invoice資格、note | UQ code/quote; IDX member、asset/range、location/status/time、email/phone hash。免許番号検索禁止 | 物理削除禁止/RV。予約時免許暗号文は貸渡簿確定/期限で削除 |
| `reservation_options` | PK; FK reservation、任意option | option/name/billing/amount/qty/day snapshot | UQ reservation/option code | AO |
| `reservation_price_lines` | PK; FK reservation | line_no、PriceLineType、label、amount、非PII metadata | UQ reservation/line | AO |
| `reservation_status_history` | PK; FK reservation、actor Auth | from/to、reason code/text、occurred_at、request_id | IDX reservation/time、actor/time | AO |
| `reservation_confirmation_snapshots` | PK; FK reservation*、quote* | schema_version、rendered facts JSON（車両/数量/期間/拠点/明細/総額/支払時期・方法/提供時期/申込期限/取消要約）、content_hash、occurred_at、locale、request_id | UQ reservation; IDX quote/time | AO。秘密/tokenを含めない |
| `reservation_consents` | PK; FK reservation/document version/confirmation snapshot、任意marketing event | `evidence_kind*=accepted|acknowledged|opted_in|declined`, occurred_at、source、language、evidence_hash、request_id。規約/取消はaccepted、privacyはacknowledged、marketingは任意opted_in/declined | UQ reservation/document | AO |
| `guest_reservation_tokens` | PK; FK reservation | token_hash、hash_key_id、`purpose*=view|cancel`, expires/revoked/consumed、use_count、last_used_at | UQ hash; IDX reservation/purpose、expiry | `view` は失効/取消まで再利用可で使用回数を追記、`cancel` は一回使用でatomic consume |
| `rental_ledger_entries` | PK; FK reservation*、asset*、pickup/return location* | 借受人氏名/住所snapshot、全運転者の氏名/住所/免許種類/番号暗号文、登録/車両番号、貸渡日時/時間、貸渡/返還事務所、走行km、貸渡料金、事故事項、microbusの場合の運行区間/行先/利用人数/目的、schema version、content hash | UQ reservation; IDX rental end/date、location/date | AO。貸渡終了から最低2年、法務承認期間を保存 |
| `rental_certificates` | PK; FK reservation*、ledger entry* | document version/hash/immutable URI、借受人への交付日時/方法/宛先hash、全運転者への携行・提示指示日時/方法/driver index集合、借受人・全運転者・車両・貸渡日時/時間・貸渡/返還事務所・貸渡人snapshot、携行/提示、運転者紹介等なし、事故/故障連絡、2日以上の日常点検の注意事項 | UQ reservation/version; IDX issued/time | AO。初回交付時の指示対象は貸渡簿の全運転者と完全一致。交付/指示失敗もoutbox/auditへ記録し貸渡開始禁止 |
| `maintenance_blocks` | PK; FK asset*、created/cancel actor | code、start/end/range、kind、MaintenanceStatus、reason、activated/completed/cancelled日時、cancel理由 | UQ code; GiST asset/range; IDX status/start/end | 物理削除禁止/RV |
| `asset_allocations` | PK; FK asset*、reservationまたはmaintenance | source typeとexactly-one FK、period、quantity=1、state | UQ source; non-releasedのasset/range排他; GiST | 台帳、物理削除禁止/RV |
| `payment_attempts` | PK; FK reservationまたはinvoice、任意transaction | exactly-one親、provider、provider attempt id、`status*=pending|succeeded|failed|cancelled`, requested amount、error code、started/completed日時、idempotency ref | provider/attempt UQ; IDX parent/status/time | AO、provider payload/カード情報禁止 |
| `payment_transactions` | PK; FK reservationまたはinvoice、recorded_by | exactly-one親、`transaction_type*=payment|refund|adjustment`, `direction*=increase_paid|decrease_paid`, `amount_yen*>0`, JPY、occurred_at、reason、external ref。paymentはincrease、refundはdecrease、adjustmentはreason必須で両方向可 | provider ref UQ; IDX parent/time | AO、取消は反対取引 |

`net_paid = sum(increase_paid) - sum(decrease_paid)` を唯一の入金残高とする。v1は分割入金を受けず、`0=unpaid`、請求額と同額=`paid`、paid後の一部減額=`partially_refunded`、全額減額=`refunded` とする。`pending|failed` は最新の未確定/失敗 `payment_attempts` から表現し、settled ledgerとは混ぜない。過払い・返金超過を防ぐ。

## 6. point・coupon・invoice

| table | PK / FK | 必須列・CHECK | UNIQUE / INDEX | 削除・版 |
|---|---|---|---|---|
| `member_point_accounts` | PK; FK member* | balance>=0、lifetime earned、last activity、expires_at | UQ member | 削除禁止/RV |
| `point_ledger` | PK; FK member、任意reservation/coupon/actor | type、delta!=0、balance_after>=0、reason、occurred_at、dedupe | UQ dedupe、reservation/type; IDX member/time | AO |
| `coupons` | PK; FK member、source point、redeemed reservation、issued_by | code、amount>0、JPY、status、issued_at、`expires_at*`、redeem/void列。expires>issued | UQ code/source; IDX member/status/expiry | 物理削除禁止/RV |
| `invoices` | PK; FK member、issued_by | code、status、JPY、subtotal/tax/total、issuer/recipient/bank snapshot、issued/due/paid/void列 | UQ code; IDX status/due、member/time | 金額不変、status用RV |
| `invoice_reservations` | PK; FK invoice/reservation | active、linked/released時刻 | active reservation partial UQ | 履歴保持/RV |
| `invoice_lines` | PK; FK invoice、任意reservation | line_no、description、qty>0、unit/subtotal/tax/total | UQ invoice/line | AO |

## 7. 問い合わせ・非同期・運用

| table | PK / FK | 必須列・CHECK | UNIQUE / INDEX | 削除・版 |
|---|---|---|---|---|
| `inquiries` | PK; FK member、`location_id*`、reservation、assigned staff | code、name/email/hash、phone/company、topic/body、status、received_at。reservationとlocation一致 | UQ code; IDX location/status/time、assignee/status、email hash | 保持後匿名化/RV |
| `inquiry_messages` | PK; FK inquiry、author Auth、outbox | direction inbound/outbound/internal、body、occurred_at。outboundはstaff、internalは外部配送禁止 | IDX inquiry/time | AO |
| `inquiry_consents` | PK; FK inquiry/document version、任意marketing event | `evidence_kind*=acknowledged|opted_in|declined`, occurred_at、source、language、evidence_hash、request_id。privacyはacknowledged、marketingは任意opted_in/declined | UQ inquiry/document; IDX document/time | AO。問い合わせ削除後も承認保持期間はpseudonymized evidence保持 |
| `marketing_preferences` | PK; 任意FK member、latest event | `channel*=email`, `destination_hmac*`, HMAC key id、`status*=opted_in|opted_out`, last_event_at、last_marketing_sent_at | UQ channel/destination HMAC; IDX member/status | 現在状態projection/RV。生email禁止 |
| `marketing_preference_events` | PK; FK preference*、marketing document version、任意member/reservation/inquiry/source consent | `event_type*=opted_in|declined|withdrawn`, occurred_at、source、language、evidence_hash、request_id、actor snapshot。opted_inは承認済み文書version必須 | UQ request/dedupe; IDX preference/time、type/time | AO。送信可否の証跡 |
| `marketing_unsubscribe_tokens` | PK; FK preference*、任意email delivery | token hash、hash key id、expires/revoked、use_count、last_used_at | UQ token hash; IDX expiry/preference | raw token・URL・log保存禁止。期限後削除 |
| `outbox_events` | PK | event/aggregate、payload/schema version、dedupe、status、attempt、available/lock/error | UQ dedupe; IDX status/available、aggregate | RV、期限後削除 |
| `email_deliveries` | PK; FK outbox* | provider、recipient hash、status、attempt、requested、provider id、delivery/error | UQ outbox/attempt、provider id; IDX status/time | RV |
| `notification_suppressions` | PK | channel=email、destination hash、reason、active、created/released | active destination partial UQ | 履歴保持/RV |
| `idempotency_records` | PK | `actor_scope_type*=auth_subject|anonymous_key|guest`, `actor_scope_hmac*`, `scope_hmac_key_id*`, endpoint、`idempotency_key_hmac*`, `key_hmac_key_id*`, request hash、state、最小response、resource、expires_at。raw scope/key/body/Auth header禁止 | UQ scope type/scope HMAC/endpoint/key HMAC; IDX expiry/state | 24h以上後削除/RV |
| `audit_log` | PK; FK actor Auth、任意location | `actor_type*=anonymous|member|staff|system|import`, actor code snapshot、`role_snapshot`, `system_job_id`, `import_run_id`, action/resource/request/result、redacted差分、occurred_at。anonymous/system/importはactor FK null、member/staffは記録時必須。staffはrole snapshot必須、systemはsystem job必須、importはimport run必須 | IDX actor/time、resource/time、location/time、job/run、request | AO、actor FK SET NULL、partition保持 |
| `import_runs` | PK; FK initiated_by Auth | environment/source/manifest/checksum/dry_run/status/count/start/end/error | UQ env/checksum（明示再実行除く） | 記録保持/RV |
| `import_records` | PK; FK run* | entity/row/source key+hash/status/target/redacted error | UQ run/entity/row; IDX status | AO |
| `legacy_id_map` | PK; FK run* | source system/entity/legacy id/target id/mapped_at | UQ source/entity/legacy; target IDX | AO |
| `regulatory_filing_runs` | PK; FK submitted_by Auth | `filing_type*=annual_rental_performance|office_vehicle_count`, `status*=generated|submitted|accepted|rejected`, reporting start/end、as_of_date、year、管轄確認済みform version/template hash、immutable集計snapshot hash/URI、immutable file hash/URI、主たる事務所所在地からserverが確定した提出先運輸支局長snapshot、generated/submitted/accepted日時、submission channel、result/reference、redacted error。貸渡実績snapshotは管轄運輸支局・車種区分別の車両数・延貸渡回数・延貸渡日車数・延走行km・総貸渡料金と該当時のカーシェア内訳、配置車両snapshotは管轄運輸支局・全配置事務所の名称・所在地・車種区分別台数を含む | UQ filing type/year/as-of; IDX status/year | AO。毎年の提出証跡を保持 |

問い合わせのreservation linkは、memberならAuth subjectから解決した本人予約、guestなら対象予約の有効token hashを同一transactionで検証した場合だけ許す。codeだけでは紐付けず、locationは予約拠点に強制する。

匿名idempotencyに事前bootstrapやCookieを要求しない。clientはmutationごとに128bit以上の予測困難な `Idempotency-Key`（UUIDv4、または16 random bytes以上のbase64urlで22文字以上）を生成する。serverは認証済みならAuth subject、guest操作ならguest token、匿名なら `endpoint family || Idempotency-Key` からserver secret付きHMACでscopeを導出し、別keyでidempotency keyもHMAC化する。raw key、IP、UA、fingerprint、email、phoneを保存・log・namespace利用せず、rate-limit識別子とも共用しない。

## 8. transaction不変条件と自動遷移

| 操作 | 同じtransactionで守ること |
|---|---|
| quote | idempotency確保、active revisionでserver計算、snapshot/input hash/期限保存。allocationなし |
| 予約確定 | quote/hash/期限/未使用検証 → asset/coupon/member lock → 再計算 → allocation → reservation/options/lines/final-confirmation snapshot/consents/history/payment初期状態 → quote consumed/coupon redeemed/outbox/audit |
| 競合 | active allocationのasset/range排他を最終防御。競合時全rollback |
| 整備 | asset lock、競合確認、maintenance+allocation同時作成。取消も同時release |
| 状態遷移 | 許可遷移、If-Match、permission、理由、history、audit、必要outboxを一括 |
| 返却/point | returned初回遷移、ledger、残高、threshold、couponを一括しUQで二重付与防止 |
| payment/refund | transaction追記、net_paid再計算、payment/invoice status、auditを一括。既存取引上書き禁止 |
| invoice | 資格/対象予約lock、snapshot/lines/関連/outbox/auditを一括。void/reissueも履歴保持 |
| inquiry | location確定、予約本人/token検証、inquiry/message/`inquiry_consents`、outbox/auditを一括 |
| marketing preference | 予約・会員登録・問い合わせの任意値を承認済みmarketing文書と照合し、source consent、append-only event、現在状態、suppressionを一括更新。未選択でも契約処理を続行 |
| marketing unsubscribe | 公開landingがURL fragmentから専用headerへ移したopaque tokenのhash/期限を検証し、preferenceをlockしてwithdrawn eventとsuppressionを一括commit。同じ有効tokenの再送は成功扱いで広告停止を維持 |
| token | viewは有効期限/取消をlock下で確認しuse_count更新。cancelは未使用をlockして予約取消と同時consume |
| 自動遷移 | schedulerが期限条件をDB時刻で再確認し、対象lock・compare-and-set・history/outbox/auditを一括。多重実行をdedupe |
| Auth退会 | closed→redaction→session失効→FK null→Auth hard-delete。失敗時再実行可能 |
| import | master→Auth/profile→member→reward→reservation→invoice→inquiry。raw認証情報拒否、source hashで再実行安全 |
| 貸渡開始/終了 | 貸渡開始時に法定項目をsnapshot化し貸渡証をoutbox交付、終了時に走行距離・料金・事故事項を確定。貸渡簿は予約の可変profileを参照せず当時値を保持 |
| 法定報告master | 拠点の改名・移転・開閉、車両の移管・車種区分変更・廃車は、業務発効日で旧periodを閉じ新periodを追加。重複なしをconstraintで保証し、終了periodは上書きしない |

許可する自動遷移は、quote `open→expired`、reservation `pending→expired`、maintenance `scheduled→active→completed`、coupon `available→expired`、invoice `unpaid→overdue`。cancelled/completed等の終端から戻さず、手動overrideは専用permission、理由、AAL2、auditを必須とする。

## 9. RLS・DB特権境界

### 9.1 接続方式

全public tableでRLSを有効化しdefault denyとする。

| 主体 | 許可経路 | 禁止 |
|---|---|---|
| 公開/member/staff通常操作 | Edge Functionがanon key + 検証済みuser JWTを引継ぎ、RLS queryまたはallowlist RPC | service_role持替え、基表汎用CRUD、任意SQL/RPC |
| SECURITY DEFINER transaction RPC | 承認済み複数表操作だけ。caller、active status、permission、location、AAL2、If-Match、業務制約を再検証しaudit | UI表示、古いJWT role/scope、引数actorを信頼すること |
| service_role | 秘密環境のoutbox、import/migration、system専用allowlist RPC。job/run承認・期限・dedupeを検証 | interactive API、userなりすまし、基表直接更新、未登録RPC、browser/log露出 |

SECURITY DEFINER ownerはlogin不可の最小権限role、固定search_path、明示schema、必要最小EXECUTEとする。service_roleはRLSを第二防御として扱えないため、system/import専用RPC以外のDB操作権限を運用・testで拒否する。

### 9.2 アクセス表

凡例: R=読取、W=更新、M=mask済み、API=専用APIのみ、—=不可。

| データ | 匿名 | member本人 | viewer | maintenance | store_staff | accounting | admin | worker |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| public catalog/legal view | R | R | R | R | R | R | R/W | R |
| quote/予約作成 | API | API | — | — | API | — | API | R/W限定 |
| member profile | — | 自分R/W | M | — | 担当予約M | 請求対象M | R/W | 限定 |
| reservation | token限定 | 自分R | 担当拠点M | PIIなしR | 担当拠点R/W | 会計列R | 全拠点R/W | 限定 |
| sensitive contact/license | — | 本人API | — | — | 専用permission+AAL2+理由+audit | 専用permission | 同条件 | 必要処理のみ |
| point/coupon | — | 自分R | — | — | 担当会員R | R | R/W | 限定 |
| invoice/payment | — | 自分R | — | — | 現地入金W | R/W | R/W | 限定 |
| inquiry | API | 自分R | 担当拠点M | — | 担当拠点R/W | — | R/W | 配送のみ |
| marketing preference | tokenで停止のみ | 自分R/W | — | — | — | — | 監査済みsupport APIのみ | 配信判定R |
| staff/role/scope | — | — | 自分R | 自分R | 自分R | 自分R | R/W | provisioning |
| audit/import/outbox | — | — | — | — | 限定M | 会計限定R | R/承認 | W限定 |

### 9.3 OpenAPI permission catalog

OpenAPIの全81 admin operationにある `x-required-permissions`、`x-location-scope`、`x-requires-aal2` を正とし、seedは次の48 codeと完全一致させる。

| permission code | operationId → location scope |
|---|---|
| `catalog.read` | listAdminCategories → global |
| `catalog.write` | createAdminCategory, updateAdminCategory → global |
| `location.read` | listAdminLocations → claim-intersection; listLocationClosures → resource |
| `location.write` | createAdminLocation → global; updateAdminLocation, createLocationClosure, cancelLocationClosure → resource |
| `asset.read` | listAdminAssets → claim-intersection; getAdminAsset → resource |
| `asset.write` | createAdminAsset → claim-intersection; updateAdminAsset → resource |
| `option.read` | listAdminOptions → global |
| `option.write` | createAdminOption, updateAdminOption → global |
| `pricing.read` | listPricingRevisions, getPricingRevision, listPricingRatePlans, listPricingOptionRates, listPricingHighSeasons → global |
| `pricing.write` | createPricingRevision, createPricingRatePlan, updatePricingRatePlan, createPricingOptionRate, updatePricingOptionRate, createPricingHighSeason, updatePricingHighSeason → global |
| `pricing.publish` | publishPricingRevision, retirePricingRevision → global |
| `maintenance.read` | listMaintenanceBlocks → claim-intersection |
| `maintenance.write` | createMaintenanceBlock → claim-intersection; cancelMaintenanceBlock → resource |
| `reservation.read` | listAdminReservations → claim-intersection; getAdminReservation → resource |
| `reservation.write` | updateAdminReservation → resource |
| `reservation.transition` | transitionAdminReservation → resource |
| `reservation.pii.read` | getAdminReservationSensitiveContact → resource |
| `reservation.guest-token.reissue` | reissueGuestReservationTokens → resource |
| `rental-ledger.read` | getRentalLedger → resource |
| `rental-ledger.write` | startRentalLedger, completeRentalLedger → resource |
| `rental-ledger.pii.read` | getRentalLedgerSensitiveDriverLicenses → resource |
| `rental-certificate.read` | getRentalCertificate → resource |
| `rental-certificate.issue` | issueRentalCertificate, reissueRentalCertificate → resource |
| `rental-certificate.pii.read` | getSensitiveRentalCertificateDocument → resource |
| `payment.read` | listReservationPaymentTransactions → resource; listInvoicePaymentTransactions → related-reservations |
| `payment.record` | recordReservationPayment → resource; recordInvoicePayment → related-reservations |
| `member.read` | listAdminMembers, getAdminMember → related-reservations |
| `member.write` | updateAdminMember → related-reservations |
| `member.pii.read` | getAdminMemberSensitiveContact → related-reservations |
| `points.adjust` | adjustMemberPoints → related-reservations |
| `coupon.issue` | issueMemberCoupon → related-reservations |
| `invoice.read` | listAdminInvoices → claim-intersection; getAdminInvoice → related-reservations |
| `invoice.write` | createAdminInvoice → claim-intersection; reissueInvoice, voidInvoice → related-reservations |
| `inquiry.read` | listAdminInquiries → claim-intersection; getAdminInquiry → resource |
| `inquiry.write` | updateAdminInquiry → resource |
| `inquiry.reply` | replyToInquiry → resource |
| `inquiry.pii.read` | getAdminInquirySensitiveContact → resource |
| `dashboard.read` | getAdminDashboard → claim-intersection |
| `report.revenue.read` | getRevenueReport → claim-intersection |
| `report.utilization.read` | getUtilizationReport → claim-intersection |
| `statutory-report.read` | getAnnualRentalPerformanceReport, getMarch31FleetReport → claim-intersection |
| `statutory-report.generate` | generateAnnualRentalPerformanceFiling, generateMarch31FleetFiling → global（serverが対象期間/基準日の実効履歴から算出した全報告対象事務所を必須） |
| `statutory-report.manage` | recordStatutoryFilingSubmission → global |
| `staff.read` | listStaff → global |
| `staff.manage` | createStaff, updateStaff → global |
| `audit.read` | listAuditEvents → claim-intersection |
| `settings.read` | getAdminSettings → global |
| `settings.write` | updateAdminSettings → global |

全行AAL2必須。`claim-intersection` はquery条件とactive location scopeの積、`resource` は対象location、`related-reservations` は関連する全予約拠点で判定する。adminもpermission/AAL2/auditを省略しない。

## 10. 保持・復旧

| 区分 | 方針 |
|---|---|
| master | 論理削除。参照済みは物理削除しない |
| member/staff | 無効化・匿名化とAuth資格情報削除を分離 |
| reservation/invoice/payment/ledger/coupon | 物理削除禁止。cancel/void/reversalで訂正 |
| rental ledger/certificate/regulatory filing | 法令・許可条件の期間を優先。貸渡簿は貸渡終了から最低2年、交付/提出証跡は承認期間保持 |
| quote/token/idempotency | 期限後に定期物理削除、job結果監視 |
| inquiry/email/outbox | 承認保持期間後に本文/宛先匿名化または削除 |
| marketing consent/preference | 適用時は承諾・請求記録を最後の広告送信から最低3年保持。declined、suppression、tokenの期間はN/Pで承認し、生emailではなくHMAC識別子を使用 |
| audit/import | append-only、期間partition、legal hold後partition廃棄 |
| backup | 暗号化、PITR、復元演習、復元後の再削除手順 |

保持期間と法的文書は事業判断N/Pの承認まで仮置きとし、実PIIを投入しない。免許番号は、予約段階では目的・閲覧者・短期保持がHで承認されない限り保存しない。貸渡開始時は法定貸渡簿の項目として全運転者の免許種類・番号をfield-level暗号化し、貸渡終了から最低2年保存する。一般予約DTO・検索・通常logには全文を出さない。

## 11. migration前チェック

- [ ] 全table/列がOpenAPI request/responseへ追跡できる
- [ ] password/session/MFA secretの独自tableがない
- [ ] 81 admin operation / 48 permission code / scope / AAL2がCIで一致する
- [ ] user JWT+RLSが通常経路、service_role汎用CRUDが不可能
- [ ] 子変更が親ETagを同一transactionで1回だけbumpする
- [ ] 複数営業時間slot・翌日跨ぎ・closure取消の境界testがある
- [ ] maintenance 4状態と全自動遷移がDB時刻・dedupeでtest済み
- [ ] reservation/maintenance横断競合をallocation排他で強制する
- [ ] payment directionとnet_paid、refund超過をtestする
- [ ] view token再利用とcancel token一回使用を分離testする
- [ ] inquiry location/所有者/token/consent、coupon期限をtestする
- [ ] marketingは3フォームで既定OFF・任意、会員設定変更、login不要unsubscribe、再同意、suppression、取引通知との分離をtestする
- [ ] unsubscribe tokenをquery/referrer/通常logへ出さず、fragmentから専用headerへ移し、同一token再送でも停止状態が戻らない
- [ ] 匿名idempotency scope/key HMACにraw key/IP/PIIが残らない
- [ ] audit actor role/job/run制約とAuth削除後snapshotをtestする
- [ ] 貸渡開始・終了で貸渡簿と貸渡証の法定snapshot、交付証跡、全運転者免許の暗号化、貸渡終了後2年以上の保持をtestする
- [ ] 年次実績・3月31日車両数を、生成時の現行masterではなく対象期間/基準日の拠点・車両配置履歴から生成し、承認済み様式version/hash、提出・受理証跡、5月31日期限をrehearsalする
- [ ] RLS、同時予約、outbox、import、backup/restoreの受入testがある
