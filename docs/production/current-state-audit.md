# 現状監査と本番化ギャップ

更新日: 2026-09-16
対象: `sky-rent` の公開画面、会員画面、管理画面、データ層、旧文書

## 0. 結論

現行成果物は、画面構成・デザイン・業務用語を確認する **機能デモ** としては再利用できる。一方、ブラウザごとに分離された `localStorage` を正本とし、本人確認、権限、予約競合、監査、通知、復旧を持たないため、そのまま本番データを扱ってはならない。

本番実装の正は [本番化実装ハンドオフ](README.md)、[データモデル](data-model.md)、[OpenAPI](openapi.yaml)、[受入基準](acceptance.md) とする。旧資料は現行デモの説明に限定する。

## 1. 確認できた構成

| 領域 | 現状 | 根拠 |
|---|---|---|
| 公開サイト | 素の HTML/CSS/JS。検索、車両詳細、予約、会員、問い合わせ、法務ページ | [`README.md`](../../README.md#L14-L23) |
| データ | `sky-rent.*` をブラウザの `localStorage` に JSON 保存 | [`js/store.js`](../../js/store.js#L11-L16), [`js/store.js`](../../js/store.js#L33-L67) |
| API | `SkyRentAPI` は Store を遅延付きで呼ぶだけ。`GAS_URL` 設定時も HTTP へ切り替わらない | [`js/api.js`](../../js/api.js#L11-L16), [`README.md`](../../README.md#L62-L70) |
| 会員認証 | 平文 password を member 行へ保存し、`sessionStorage` の member ID だけでログイン扱い | [`js/store.js`](../../js/store.js#L491-L519) |
| staff 認証 | 任意入力のデモ login と client-side session。管理ページ側も session を自動生成 | [`manage/login.html`](../../manage/login.html#L53-L61), [`manage/partials.js`](../../manage/partials.js#L237-L246) |
| 予約競合 | 読取後に配列へ追加するだけで、DB lock・排他制約・transaction がない | [`js/store.js`](../../js/store.js#L360-L372), [`js/store.js`](../../js/store.js#L407-L456) |
| 通知 | メールではなくブラウザ内通知ログ | [`js/store.js`](../../js/store.js#L400-L405), [`js/store.js`](../../js/store.js#L455-L455) |
| 問い合わせ | 送信者のブラウザへ保存するだけ | [`contact.html`](../../contact.html#L187-L208) |

## 2. 再利用可・要置換・本番禁止

### 再利用可（内容確認とアクセシビリティ修正後）

- 公開/管理画面の情報設計、色・余白・レスポンシブ CSS、一覧/カード/フォーム部品。
- `index.html`、`search.html`、`detail.html`、`fleet.html`、`guide.html`、`faq.html` の画面骨格。
- `law.html`、`privacy.html`、`clause.html`、`insurance.html` の掲載枠。ただし本文、版、施行日、事業者情報、料金、免責、保持期間は事業・法務承認後の版へ差し替える。
- `pricing.js` の計算例とテストケース候補。金額の正本や本番計算コードとしては使わない。

### 要置換

| 対象 | 置換内容 |
|---|---|
| `js/store.js`, `js/api.js` | OpenAPI 準拠 API、PostgreSQL transaction、認証済み subject、server-side pricing へ置換 |
| `booking.html` | quote ID、冪等key、server再計算、同意版証跡、競合応答、実配信状態へ接続 |
| `mypage.html` | Supabase Auth、確認済みメール、本人 RLS、退会/開示手続へ接続 |
| `contact.html` | DB受付、拠点、予約本人/guest token検証、同意証跡、outbox、spam対策へ接続 |
| `manage/*` | MFA/AAL2、permission、拠点scope、監査、mask済み DTO、楽観lockへ接続 |
| 料金・在庫 | client値を捨て、active pricing revision と DB allocation を正にする |
| 通知/Calendar | transaction outbox から非同期配送し、provider結果を記録する |

### 本番禁止

- 実在する顧客、免許、問い合わせ、password、予約、請求情報の `localStorage` 保存。
- `manage/` のデモ session、client-side role 判定、無認証の管理 URL 公開。
- client が送る会員ID、価格、割引、請求資格、状態を信頼する処理。
- 「メール送信済み」「受付済み」「リアルタイム在庫」と、外部処理が成功したように見せるデモ文言。
- browser JSON の export/import を本番移行またはバックアップとして使用すること。

## 3. 画面・機能の現状

| 利用者 | 画面/機能 | 現状評価 |
|---|---|---|
| 匿名 | 検索・詳細・見積り | UI は再利用可。在庫・価格は同一ブラウザ内だけで計算 |
| 匿名/会員 | 予約入力・確認・完了 | 氏名、連絡先、免許番号、支払方法、同意checkboxを扱うが、同意版を保存せずclient価格で即 `confirmed` |
| 会員 | 登録・login・履歴・point/coupon | 平文password、email一致による予約結合、確認メールなしのため全面置換 |
| 匿名/会員 | 問い合わせ | privacy checkbox はあるが同意証跡なし。localStorageだけなので本番受付ではない |
| staff | 予約/顧客/会員/請求/帳票/設定 | デモデータ操作としてのみ使用可。認可・列mask・監査がない |
| 公開 | 会社・特商法・privacy・約款・保険 | 導線はある。確定版ID、施行日、履歴、最終確認画面の重要条件表示が未設計 |

## 4. 現行データと処理

現行 Store はカテゴリ、拠点、asset、option、予約、member、point/coupon、invoice、通知を一つの browser origin に保存する。代表的な問題は次のとおり。

- 予約は空き検索後に配列へ追加し、価格、member ID、coupon、請求資格を同一clientが決定する。
- 予約statusは原則 `confirmed|in_use|returned|cancelled` で、仮押さえ・失効・履歴・楽観lockがない。
- 物理車両にも `stock > 1` を許す設計が残り、本番 v1 の「asset 1行 = 物理1台」と矛盾する。
- memberは password、point残高、coupon配列を同じ行に保持し、台帳から再現できない。
- 通知、入金、返金、請求、監査はappend-only ledgerではなく、画面用オブジェクトの上書きが中心。

本番 entity と不変条件は [データモデル](data-model.md) を参照する。

## 5. 仕様書と実装の主な矛盾

| 重要度 | 矛盾 | 根拠・影響 |
|---|---|---|
| Critical | README は本番でないと警告する一方、公開 form は免許番号・password・問い合わせを実際に保存できる | [`README.md`](../../README.md#L6-L7), [`booking.html`](../../booking.html#L47-L55), [`mypage.html`](../../mypage.html#L42-L51) |
| Critical | privacy は予約の確定内容を当社受付記録で管理すると述べるが、現状は browser 保存のみ | [`privacy.html`](../../privacy.html#L122-L129), [`js/store.js`](../../js/store.js#L442-L455) |
| Critical | 完了画面/通知ログは確認メール送信済みと表示するが、実送信しない | [`booking.html`](../../booking.html#L131-L135), [`js/store.js`](../../js/store.js#L400-L405) |
| High | API資料は接続先の差替えを示すが、実装は常に Store を呼ぶ | [`js/api.js`](../../js/api.js#L34-L70), [`README.md`](../../README.md#L64-L67) |
| High | 会員履歴は member ID に加えてemail一致でも結合し、email所有確認がない | [`mypage.html`](../../mypage.html#L113-L117) |
| High | 問い合わせ完了を表示するが、運営側へ届かない | [`contact.html`](../../contact.html#L197-L213) |
| High | 予約checkboxは約款・cancel・privacyを一括し、版/施行日/表示言語/同意時刻/evidenceを保存しない | [`booking.html`](../../booking.html#L78-L89), [`booking.html`](../../booking.html#L271-L293) |
| High | 会員登録に利用規約/privacyへの導線・同意記録がない | [`mypage.html`](../../mypage.html#L42-L52), [`mypage.html`](../../mypage.html#L98-L110) |
| High | 最終確認画面に取消条件、支払時期、申込期限等の要約がなく、価格/期間/顧客情報だけ | [`booking.html`](../../booking.html#L250-L267) |

## 6. 法務表示・同意の実装前確認候補

法的結論は法務担当者が判断する。少なくとも次を本番着手前に決め、版管理する。

1. `law.html`: 登記上の名称・現に活動する住所・確実に連絡可能な電話、役務対価、追加費用、支払時期/方法、提供時期、申込期限、変更/取消方法を確定する。電話を請求時開示とするなら、請求を本当に受け付け即時回答できる経路を先に用意する。
2. `booking.html` 確認pane: 数量/期間、支払総額、支払時期/方法、貸渡日時/拠点、申込期限またはquote期限、取消条件と連絡方法をボタン直前に一覧表示する。
3. `privacy.html`: Auth/DB/メール/LINE/analytics等の実利用先、取得項目、利用目的、委託/外国移転、保存期間、安全管理措置、開示等手続、苦情窓口を確定する。デモlocalStorageの説明は本番公開から除く。
4. `clause.html`: 国土交通省の最新モデル/許認可条件、保険約款、消費者契約上の免責・損害賠償、未成年/運転者手続きを専門家がレビューする。
5. `booking.html`, `mypage.html`, `contact.html`: 法的文書ごとにversion、content hash、同意/確認時刻、source、language、request IDをserverで保存する。任意のmarketing同意は契約/privacy確認と分離する。
6. 会員/予約/問い合わせの確認メールには受付内容、適用文書version、変更/取消窓口を含め、outboxの送達状態を保存する。

## 7. 重大リスク

| 重要度 | リスク | リリース条件 |
|---:|---|---|
| Critical | PII・password・免許情報の漏えい | browser保存廃止、Auth、暗号化、RLS、mask、保持/削除承認 |
| Critical | 二重予約・価格改ざん | DB排他制約、server再計算、単一transaction、concurrency test |
| Critical | 管理画面の無認証公開 | staff Auth、MFA/AAL2、permission/location scope、監査 |
| High | 申込み条件の表示/証跡不足 | 最終確認要件、法的文書版、同意証跡、確認メールの受入試験 |
| High | 通知/問い合わせ消失 | durable DB受付、outbox、retry、bounce、運用alert |
| High | 過剰なPII収集・不明確な保持 | 項目別目的/必須性/保持期限、免許情報の最小化、削除job |

## 8. 実装前の事業判断 A〜P

判断 ID は [本番化実装ハンドオフ §13](README.md#13-実装開始前の事業判断-ap) の A〜P だけを使用する。

| ID | 要決定事項 |
|---|---|
| A | Supabase plan、予算、責任者 |
| B | 公開/admin/API domain、Cookie/Auth境界 |
| C | v1の商品・拠点・実車master |
| D | 料金、税、端数、season、割引の優先順位 |
| E | 営業時間、休業、前後buffer、整備block |
| F | 予約成立、仮押さえ、変更/取消、no-show |
| G | guest予約、本人確認、view/cancel token |
| H | 免許情報の項目、目的、閲覧者、保持 |
| I | staff名簿、role×permission×拠点scope |
| J | 請求書資格、締日、様式、振込先 |
| K | email provider、送信元、template、送達運用 |
| L | 問い合わせ種別、担当、SLA、spam対策 |
| M | 旧データの有無、正本、移行範囲 |
| N | 項目別の保持/削除、privacy、委託/再委託、国外取扱い |
| O | traffic、RPO/RTO、障害連絡 |
| P | 正式事業者情報、許可、約款、料金・取消・補償、特商法・privacy・外部送信の承認 |

## 9. 実装着手ゲート

1. A〜P に owner、回答、承認日がある。
2. v1画面と削除/後回し範囲が確定している。
3. 料金・在庫・状態遷移・同意を例付きの自動testへ変換できる。
4. DB、OpenAPI、Auth/RBAC、PII、法務文書の横断レビューが完了している。
5. 二重予約、価格改ざん、権限逸脱、通知失敗、同意証跡、backup復元を受入試験に含めている。

## 10. 2026-09-23 実装状況

本番実装 v1 ([実装契約書](implementation-v1.md)) の着手に伴う追記。構成は **静的サイト (GitHub Pages) + Supabase (Postgres / Auth / Edge Functions) + Resend + Google Calendar API** とした。
立ち上げ手順は [本番環境の立ち上げ手順書](setup.md) を参照。

状態の凡例: **済** = 実装し、ローカルの Supabase 一式 (DB・Auth・Edge Functions・メール/Google のモック) で自動テストと実ブラウザ操作により確認済み / **設定済** = 設定ファイル・手順書を用意 (本番への反映は手順書に従い事業者が行う)

### 10.1 この実装で解消する項目

| 監査の指摘 (節) | 対応 | 主な場所 | 状態 |
|---|---|---|---|
| 二重予約・予約競合 (§1, §4, §7 Critical) | 予約期間を `tstzrange` で持ち、同じ車両の有効な予約 (confirmed / in_use) と貸出停止枠の重なりを **DB の排他制約** で拒否。予約作成は1トランザクション (`create_reservation_tx`)、冪等キー + リクエストハッシュで二重送信を1件にまとめる。受け渡し時刻の近接も拠点単位のロックで判定 | `supabase/migrations/…0100_schema.sql`, `…0300_domain.sql` | 済 |
| 価格改ざん (§4, §7 Critical) | 料金はサーバー (Edge Function) が料金ルール (`app_settings.pricing_rules`) とブラウザと同一の計算コードで再計算し、表示額と違えば `PRICE_CHANGED`。保存するのはサーバー計算額だけ | `js/pricing-core.js`, `supabase/functions/api` | 済 |
| `stock > 1` の物理車両 (§4) | `assets.stock` を 1 に制約 (物理1台 = 1行) | `…0100_schema.sql` | 済 |
| 会員の平文パスワード・email 一致の予約結合 (§1, §5 High) | 資格情報は Supabase Auth のみ。**メール確認必須**、パスワード8文字以上・英大文字/英小文字/数字。過去のゲスト予約は **メール所有の確認後に** 自動で紐付け | `supabase/config.toml`, `…0200_auth_rls.sql`, `mypage.html` | 済 |
| 管理画面の無認証公開・client 側の role 判定 (§1, §7 Critical) | スタッフは `staff` テーブルに登録された人だけ。**二段階認証 (TOTP) を通過した AAL2 セッションでなければ管理データを一切読めない** (DB 側で判定)。5 役割 × 権限 × 担当拠点。最後の管理者は外せない。最初の管理者は `scripts/create-admin.mjs` で作成 | `…0200_auth_rls.sql`, `supabase/config.toml`, `manage/login.html` | 済 |
| RLS・anon の直接アクセス (§2 本番禁止) | 全テーブルで RLS 有効。anon はテーブルを直接読めず、公開カタログと空き時間帯だけを個人情報を含まない RPC (`public_catalog`, `public_busy_ranges`) で返す。会員は本人の行だけ。書き込みは列を限定した RPC 経由 | `…0200_auth_rls.sql`, `…0300_domain.sql` | 済 |
| 同意証跡 (§5 High, §6) | 法務文書を版管理 (`legal_documents`)。予約・会員登録・問い合わせに、同意した文書 ID・版・時刻を保存 (`consent`)。サーバーで必須文書の現行版への同意を確認 (`CONSENT_REQUIRED`)。案内メールの同意は任意・既定 OFF で分離 | `…0100_schema.sql`, `supabase/functions/api`, `booking.html` 等 | 済 |
| 最終確認画面の表示不足 (§5 High, §6-2) | 車両・日時・拠点 (住所)・料金内訳と総額・支払時期/方法・予約成立の時点・キャンセル規定 (その車両・時期の段階表といま取り消した場合の金額) を確定ボタンの直前に表示 | `booking.html` | 済 |
| メール未送信なのに送信済み表示 (§2, §5 Critical) | 業務処理と **同じトランザクションで送信待ち (outbox) に積み**、worker が Resend で送信。失敗は指数バックオフで再送、送信中のまま止まったものは定期ジョブで戻す。完了画面は実際の送信状態 (sent / queued / skipped / failed) で文言を変える。管理画面「メール送信状況」で確認・再送 | `…0100_schema.sql`, `…0300_domain.sql`, `supabase/functions/worker`, `manage/mail-log.html` | 済 |
| 認証メール (会員登録確認・再設定・招待) | Supabase Auth の日本語テンプレート (グロースレンタカー名義・問い合わせ先 公式LINE)。本番は Resend の SMTP から送信 | `supabase/templates/*.html`, `supabase/config.toml`, 手順書 4・5章 | 設定済 |
| 問い合わせが運営に届かない (§1, §5 High) | DB で受付 (`submit_inquiry_tx`) + 店舗宛て通知メール + ハニーポット + レート制限 (IP・メールアドレス単位)。管理画面「お問い合わせ」で対応状況を管理 | `…0300_domain.sql`, `supabase/functions/api`, `contact.html`, `manage/inquiries.html` | 済 |
| 監査ログ・履歴なし (§4, §7) | 主要テーブルの追加・変更・削除をトリガーで **追記のみ** の `audit_log` に記録 (連絡先等はマスク)。利用者・スタッフは更新・削除できない。管理画面「操作履歴」「最近の動き」 | `…0300_domain.sql`, `manage/audit.html` | 済 |
| ポイント残高の上書き (§4) | ポイントは台帳 (`point_ledger`) の合計。返却時の付与は1予約1回を一意制約で保証。クーポンは行単位で使用済みを記録 | `…0100_schema.sql`, `…0300_domain.sql` | 済 |
| 同時編集の上書き (§3 staff) | 予約に `version` を持ち、管理画面からの更新は版が違えば拒否 (楽観ロック) | `…0300_domain.sql` | 済 |
| ブラウザへの業務データ保存 (§2 本番禁止, §7 Critical) | 本番モードでは画面用ストアをメモリのみにし、localStorage に業務データを書かない。デモモードは従来どおり | `js/store.js`, `js/backend.js` | 済 |
| 免許番号の過剰収集 (§7 High, 事業判断 H) | Web 予約では免許番号を取得・保存しない (免許保有の確認チェックのみ。当日店頭で確認)。DB にも列を置かない | `booking.html`, `…0100_schema.sql` | 済 |
| ゲスト予約の照会・取消 (事業判断 G) | 照会キーは HMAC で生成し、DB にはハッシュだけを保存。照会 URL はトークンを `#` 以降に置き、サーバーのログや URL クエリに出さない | `supabase/functions/api`, `mypage.html` | 済 |
| 担当者不在時の予約 (新規要望) | Google Calendar API (サービスアカウント) で担当者の予定を確認し、予定あり (終日の「休み」を含む) の時間・日は予約不可。予約は担当者カレンダーに【貸出】【返却】として書き込み、取消で削除 | `supabase/functions/api`, `worker`, `manage/calendar.html`, 手順書 6章 | 済 |
| バックアップ・復旧 (§7, 事業判断 O) | Supabase の自動バックアップ + PITR (推奨)、復元テストを公開前チェックに含めた | 手順書 1・10章 | 設定済 (契約・実施は事業者) |
| スパム・大量送信 | Edge Function でレート制限 (`hit_rate_limit`)、問い合わせのハニーポット | `…0300_domain.sql`, `supabase/functions/api` | 済 |

### 10.2 実装しても残る事業判断・法務確認

[事業判断 A〜P](README.md#13-実装開始前の事業判断-ap) のうち、実装では決められないもの。「仮置き」は実装上の初期値で、承認が必要。

| ID | 状態 | 実装での仮置き / 現状 | 決めること・確認すること |
|---|---|---|---|
| A | 未決 | 手順書で「東京リージョン + 有料プラン + PITR」を推奨 | Supabase の契約プラン・予算・責任者 (Owner) と予備の管理者 |
| B | 一部仮置き | 公開サイトは GitHub Pages (`playmark0227-svg.github.io/sky-rent/`)、API は Supabase の既定ドメイン。送信ドメインは `mail.<会社ドメイン>` を推奨 | 独自ドメインを使うか、送信ドメインの決定と DNS 設定の担当 |
| C | 一部仮置き | seed に北見本店・釧路店と車両6台 (仮)。住所は市名まで・電話は空欄 | 実車 (ナンバー・定員・写真・車検日) と拠点の正式情報、公開する車両 |
| D | 一部仮置き | 総合料金表 2026年6月改定版を料金ルールとして実装 (税込・円単位・繁忙期・土日祝・夜間・割引・クーポン) | 料金表の最終確認、端数処理、割引の併用条件、NOC の請求方法 |
| E | 一部仮置き | 受け渡し担当者の予定 (Google カレンダー) と受け渡し時刻の重複防止 (既定30分) で判定。整備・車検は貸出停止枠 | 営業時間外・定休日の予約を機械的に止めるか、前後の余裕時間、受け渡し時間の長さ、判定モード (時刻 / 1日単位) |
| F | 一部仮置き | 確定ボタンで即時成立 (仮押さえなし)。取消はお客様 (Web) とスタッフ、変更はスタッフのみ。キャンセル料は規定表どおり自動計算。無断キャンセル状態あり | 即時成立でよいか、変更の受付方法、当日・無断キャンセル時の請求方法 |
| G | 一部仮置き | ゲスト予約を許可。照会 URL (HMAC トークン) で確認・取消。トークンの有効期限なし (予約ごとに固定) | ゲスト予約を認めるか、照会 URL の有効期限、電話等での本人確認の手順 |
| H | 一部決定 | Web では免許番号を取得しない | 貸渡時の免許確認・貸渡簿への記録方法と保持期間 (法定事項の確認) |
| I | 一部仮置き | 5 役割 (管理者・店舗スタッフ・経理・整備・閲覧) × 担当拠点 + 二段階認証必須 | 実際のスタッフ名簿、役割と担当拠点の割当、退職時の手順 |
| J | 未決 | 請求書払いは「請求書払い許可」の会員のみ。振込先 (`app_settings.billing`) は空 | 請求書払いの対象・締日・様式・振込先 |
| K | 一部仮置き | メール送信は Resend。差出人・件名・本文の文案を用意 (予約系は `_shared/mail-templates.ts`、認証系は `supabase/templates/`) | 送信ドメイン・差出人名、文面の最終承認、不達時の運用 (誰が「メール送信状況」を見るか) |
| L | 一部仮置き | DB 受付 + 店舗通知 + ハニーポット + レート制限 | 問い合わせ種別、担当者、回答期限 (現在の画面表記「2営業日以内」) |
| M | 決定 (推奨どおり) | デモデータは移行しない。seed はカタログと設定のみ | 旧データ (紙・他システム) の有無と移行範囲 |
| N | 未決 | 退会時は会員情報を匿名化し未使用クーポンを削除。委託先は Supabase (保存は東京リージョン)・Resend・Google | 項目別の保持期間と削除、委託先・外国にある第三者への提供の説明 (Supabase・Resend・Google は外国の事業者)、Google カレンダーへお名前・予約内容を登録することの説明 |
| O | 未決 | 手順書で PITR と復元テストを推奨 | RPO / RTO、障害時の連絡体制とお客様への告知方法 |
| P | 未決 | 法務ページは掲載枠のみ。同意の版は `2026-08` で仮登録 | 正式な事業者情報・許可番号、約款・キャンセル規定・補償、特定商取引法に基づく表記、プライバシーポリシー (委託先・外部送信を含む) の専門家確認と承認。改定時は `legal_documents` の版を上げる |

### 10.3 本番公開の条件 (§9 の更新)

§9 の着手ゲートに加え、[手順書 10章のチェックリスト](setup.md#10-本番公開前チェックリスト) をすべて満たすまで、実際のお客様の予約を受け付けない。
特に、10.2 の **A・K・N・O・P が未決のまま公開しない** こと。

### 10.4 検証結果 (2026-09-23)

| 検証 | 件数 | 結果 |
|---|---|---|
| DB の権限・業務ロジック (pgTAP, `supabase/tests/database.test.sql`) | 145 | 全件合格。匿名・会員・二段階認証前後のスタッフ・役割別・拠点限定の各立場で、読める/書ける範囲を検査 |
| 料金計算 (`tests/pricing.test.mjs`) | 84 | 全件合格。総合料金表の全規則・2026/2027 の全祝日・キャンセル料の段階。端末のタイムゾーンを変えても同じ結果 |
| 画面・基盤 (`tests/frontend-core`, `pages-*`) | 218 | 日本時間・UTC・ロサンゼルス時間の端末でそれぞれ全件合格 (デモモード / 本番モードの両方) |
| Edge Functions の結合試験 (`tests/functions/*`) | 63 | 全件合格。同時20件の予約で成功ちょうど1件、料金の改ざん拒否、照会キー、キャンセル料、メール送信と再送、Google カレンダーの判定・書き込み・削除・障害時、権限 |
| 実ブラウザでの通し操作 | — | 検索 → 見積 → 予約確定 (最終確認画面の6項目・同意の版) → 確認メール → 照会URLからキャンセル / 管理画面ログイン (二段階認証の初回登録) / Google カレンダー連携の設定・接続テスト → 担当者の予定がある時間は予約不可・予約で【貸出】【返却】を書き込み |

**セキュリティ点検**: 4 観点 (DB 権限 / サーバー / 画面のスクリプト注入 / 業務ロジックの悪用) で実際に攻撃を試み、別の担当が1件ずつ再現を確認した。
成立した 7 件はすべて修正し、回帰テストを追加した (拠点限定スタッフによる他拠点への予約の付け替え・拠点外の顧客情報の閲覧、
問い合わせ種別を使ったフィッシングメール、IP ヘッダ偽装によるレート制限の回避、無認証の予約による枠の占有 など)。
加えて、外部スクリプトへの改ざん検知 (SRI) と、ポイント手動調整の上限 (1回 ±100pt) を入れた。

### 10.5 実装で新たに置いた業務ルール (要確認)

| ルール | 値 (変更場所) | 理由 |
|---|---|---|
| ゲスト (会員登録なし) の予約 | 1件あたり最長31日。同じメールアドレス・電話番号で有効な予約は3件・合計31日まで (`supabase/functions/api/index.ts` 冒頭の定数) | いたずらで全車両を長期間押さえられないようにするため |
| 会員の予約 | 1件あたり最長93日。有効な予約は10件・合計279日まで (同上) | 同上 |
| 同じ受信箱への予約確定メール / 問い合わせ自動返信 | 1日5通 / 1日3通まで (超えた分も予約・問い合わせ自体は受け付ける) | 第三者のアドレス宛てのメール送り付けを防ぐため |
| 受け渡しの間隔 | Google カレンダー連携が ON のとき、同じ拠点で貸出・返却の時刻が30分以内に重なる予約は不可 (管理画面で変更) | 担当者は同時に2件の受け渡しをできないため |
| 土日祝割増 | 利用期間に土日祝が1日でも含まれれば1回 ¥330 | 料金表の「1利用」を1予約1回と解釈 |
| 24時間を超えた分 | 1時間ごとに1時間料金、ただし24時間料金を上限 (例: コンパクト26時間 = ¥7,700 + ¥2,200) | 料金表の「超過(1時間)」「超過(1日)」から |
| 補償 (CDW/PAP) の短時間料金 | 6時間以内は短時間料金。24時間を超えた端数が6時間以内なら、その分も短時間料金 | 料金表の「1時間〜6時間」列から |
| 割引 (学生・法人・二地域居住者・守成クラブ) | お客様の自己申告で予約時に適用し、当日店頭で証明を確認。確認できなければ割引前の料金 (予約確定メール・店舗通知に明記) | 料金表の「提示」条件 |
| ポイントの手動調整 | 1回 ±100pt まで・理由必須 | 10pt で ¥1,000 クーポンに自動交換されるため |

