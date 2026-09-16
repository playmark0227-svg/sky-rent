# 外部送信・Cookieポリシーテンプレート

状態: **草案 / 本番公開禁止**
文書種別: `external_transmission`
版: `{{DOCUMENT_VERSION}}` / 施行日: `{{EFFECTIVE_AT}}`

> 電気通信事業法の外部送信規律がこのサービスに適用されるかは、サービス実態に基づく専門家判断が必要です。適用外との判断でも、第三者script/SDK/Cookie/端末保存を必ず棚卸しし、privacy・同意管理・CSPと一致させてください。

## 1. 利用者情報の外部送信

### 現行デモで確認済みの候補

次は2026-09-16時点のsource scanで見つかったものであり、本番採用を承認した一覧ではありません。実ブラウザのnetwork captureで、redirect・provider domain・送信項目まで確定します。

| 現行要素 | 読み込み/遷移 | 想定される確認事項 | 本番対応 |
|---|---|---|---|
| `images.unsplash.com` | 公開ページが画像を直接読み込み | IP、user agent、referrer、画像URL等。Unsplashの実policy/保存/国外処理 | 自社管理画像へ置換、またはinventory・privacy・CSPへ正式登録 |
| `cdn.jsdelivr.net` | 管理デモがChart.js/ExcelJSを直接読み込み | 管理端末の接続情報、供給網、version固定、SRI | bundleをbuild成果物へ固定し、外部実行scriptを原則廃止 |
| `lin.ee` | 利用者が明示的にLINEへ遷移 | LINE側で取得される情報、予約/問い合わせの引継ぎ、privacy案内 | 外部遷移表示、委託/第三者提供/正本の判断、PIIをURLへ含めない |
| `github.com` | docsからsourceへ明示的に遷移 | GitHub側でのアクセス情報 | 顧客向け法務本文は自domainにもHTMLで掲載 |

`rg` の文字列検索だけで「送信なし」と判定せず、service worker、CSS、redirect、tag manager、API responseが動的に追加するdomainも観測します。

### 本番inventory

| 機能/サービス | 送信先事業者 | 送信される情報 | 当社の利用目的 | 送信先の利用目的 | 保存期間 | 停止/opt-out | 必須/任意 |
|---|---|---|---|---|---|---|---|
| hosting/CDN | `{{HOSTING_PROVIDER}}` | IP、日時、URL、user agent等 `{{HOSTING_DATA}}` | 配信、security、障害対応 | `{{HOSTING_PROVIDER_PURPOSE}}` | `{{HOSTING_RETENTION}}` | `{{HOSTING_OPT_OUT}}` | 必須 |
| 地図 | `{{MAP_PROVIDER_OR_NONE}}` | `{{MAP_DATA}}` | `{{MAP_FIRST_PARTY_PURPOSE}}` | `{{MAP_PROVIDER_PURPOSE}}` | `{{MAP_RETENTION}}` | `{{MAP_OPT_OUT}}` | `{{MAP_REQUIREDNESS}}` |
| error監視 | `{{ERROR_PROVIDER_OR_NONE}}` | `{{ERROR_DATA}}` | `{{ERROR_FIRST_PARTY_PURPOSE}}` | `{{ERROR_PROVIDER_PURPOSE}}` | `{{ERROR_RETENTION}}` | `{{ERROR_OPT_OUT}}` | `{{ERROR_REQUIREDNESS}}` |
| analytics | `{{ANALYTICS_PROVIDER_OR_NONE}}` | `{{ANALYTICS_DATA}}` | `{{ANALYTICS_FIRST_PARTY_PURPOSE}}` | `{{ANALYTICS_PROVIDER_PURPOSE}}` | `{{ANALYTICS_RETENTION}}` | `{{ANALYTICS_OPT_OUT}}` | 任意 |
| 決済 | `{{PAYMENT_PROVIDER_OR_NONE}}` | `{{PAYMENT_DATA}}` | `{{PAYMENT_FIRST_PARTY_PURPOSE}}` | `{{PAYMENT_PROVIDER_PURPOSE}}` | `{{PAYMENT_RETENTION}}` | `{{PAYMENT_OPT_OUT}}` | 方式依存 |
| その他 | `{{OTHER_PROVIDER_OR_NONE}}` | `{{OTHER_DATA}}` | `{{OTHER_FIRST_PARTY_PURPOSE}}` | `{{OTHER_PROVIDER_PURPOSE}}` | `{{OTHER_RETENTION}}` | `{{OTHER_OPT_OUT}}` | `{{OTHER_REQUIREDNESS}}` |

送信先のprivacy/opt-out URL: `{{PROVIDER_POLICY_LINKS}}`。

## 2. Cookie・ブラウザ保存

| 名称 | 発行者 | 保存内容 | 目的 | 有効期間 | 必須/任意 |
|---|---|---|---|---|---|
| `{{COOKIE_NAME}}` | `{{COOKIE_DOMAIN}}` | `{{COOKIE_CONTENT}}` | `{{COOKIE_PURPOSE}}` | `{{COOKIE_EXPIRY}}` | `{{COOKIE_REQUIREDNESS}}` |

- 認証Cookie: `Secure`, `HttpOnly`, `SameSite={{SAME_SITE}}`、短い有効期限、logout/権限変更時に失効。
- guest token、免許番号、payment情報をlocalStorageへ保存しない。
- 必須でない保存・送信は同意前に開始せず、拒否・撤回後に停止する。

## 3. 同意・通知・opt-out方式

外部送信規律の適用判断と採用方式（通知/公表、同意、opt-out）: `{{LEGAL_APPLICABILITY_AND_METHOD}}`。

任意カテゴリの同意UI:

- 「すべて許可」と「任意は拒否」を同じ階層・視認性で表示
- 目的別に変更でき、既定OFF
- 撤回後の新規送信を停止し、設定画面へ常時到達可能
- consent version、時刻、選択、localeを保存

## 4. Inventory・リリースゲート

CIでHTML/JS、tag manager、network allowlist、CSPを検査し、未登録domainへの通信を失敗させます。tag managerからの動的追加にもowner・data・目的・保存・opt-out・法務承認を要求します。

- [ ] 本番network captureと表が一致
- [ ] CSP `connect-src`, `img-src`, `script-src`, `frame-src` と一致
- [ ] privacyの委託/第三者提供/国外移転と一致
- [ ] 任意tagは同意前・拒否後に発火しない
- [ ] provider変更で新versionを発行
- [ ] 専門家が適用判断と方式を承認
