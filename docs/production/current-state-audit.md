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
