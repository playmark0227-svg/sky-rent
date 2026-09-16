# プライバシーポリシーテンプレート

状態: **草案 / 本番公開禁止**
文書種別: `privacy`
版: `{{DOCUMENT_VERSION}}` / 施行日: `{{EFFECTIVE_AT}}` / 更新日: `{{UPDATED_AT}}`

> 実際に取得・利用・委託・送信するデータを棚卸しし、`{{...}}` をすべて実値にしてください。「サービス向上のため」だけの抽象的記載や、不要な運転免許証情報の収集は禁止します。

## 1. 個人情報取扱事業者

- 名称: `{{LEGAL_ENTITY_NAME}}`
- 住所: `{{REGISTERED_ADDRESS}}`
- 代表者: `{{REPRESENTATIVE_NAME}}`
- 個人情報保護責任者: `{{PRIVACY_OWNER_TITLE}}`
- 問い合わせ/苦情窓口: `{{PRIVACY_CONTACT}}`
- 認定個人情報保護団体の対象事業者である場合の団体名・苦情解決申出先（非該当の場合はその旨）: `{{ACCREDITED_PRIVACY_ORGANIZATION_OR_NONE}}`

## 2. 取得する情報と利用目的

| 情報区分 | 具体的な項目 | 必須/任意 | 具体的な利用目的 | 保存期間 |
|---|---|---|---|---|
| 予約者・借受人 | `{{CUSTOMER_FIELDS}}` | `{{REQUIREDNESS}}` | 予約受付、本人連絡、貸渡契約、変更・取消し | `{{CUSTOMER_RETENTION}}` |
| 運転資格 | `{{LICENSE_FIELDS}}` | `{{REQUIREDNESS}}` | 法令/約款に基づく資格確認 | `{{LICENSE_RETENTION}}` |
| 利用・車両 | `{{RENTAL_FIELDS}}` | 必須 | 車両引渡し、返還、事故・違反対応 | `{{RENTAL_RETENTION}}` |
| 支払・請求 | `{{PAYMENT_FIELDS}}` | `{{REQUIREDNESS}}` | 決済、返金、請求、会計 | `{{PAYMENT_RETENTION}}` |
| 問い合わせ | `{{INQUIRY_FIELDS}}` | `{{REQUIREDNESS}}` | 回答、本人確認、品質管理 | `{{INQUIRY_RETENTION}}` |
| 会員・特典 | `{{MEMBER_FIELDS}}` | 任意 | 会員機能、point/coupon管理 | `{{MEMBER_RETENTION}}` |
| セキュリティ | IP、端末、認証・操作log等 `{{SECURITY_FIELDS}}` | 自動取得 | 不正防止、障害解析、監査 | `{{SECURITY_RETENTION}}` |
| 広告配信 | `{{MARKETING_FIELDS}}` | 任意 | 同意した案内の配信・停止 | `{{MARKETING_RETENTION}}` |

フォームごとに、送信ボタンより前で取得主体・そのフォーム固有の目的・必須/任意・本ページへのリンクを表示します。利用目的を追加・変更する場合は、本人が合理的に予測できる範囲かを確認し、必要な通知・公表・同意を行います。

### 運転免許証情報

- 予約時に必要か: `{{LICENSE_COLLECTION_NECESSITY}}`
- 取得する最小項目: `{{MINIMUM_LICENSE_FIELDS}}`
- 原本確認のみ/保存の別: `{{VERIFY_OR_STORE}}`
- 全文を閲覧できるroleと目的: `{{LICENSE_ACCESS_CONTROL}}`
- 暗号化・mask・audit: `{{LICENSE_SECURITY}}`
- 削除時期: `{{LICENSE_DELETION_TRIGGER}}`

予約時取得の必要性が承認されるまで番号全文や画像を保存せず、通常画面/APIには末尾4桁だけを返します。実際の貸渡開始時は、許可条件上の貸渡簿に必要な全運転者の免許種類・番号を暗号化して記録し、貸渡終了から最低2年保存する取扱いを上表と利用目的に明記します。

## 3. Cookie・端末情報・外部送信

必要Cookie、任意Cookie、local storage、SDK等は [外部送信ポリシー](external-transmission-template.md) に一覧化します。任意のanalytics/広告を使う場合は、同意/拒否を同等に選べる画面と撤回方法を提供し、拒否しても予約できるようにします。

## 4. 委託

予約基盤、hosting、メール、決済、会計、保守等の委託先カテゴリ、委託情報、選定・契約・監督: `{{PROCESSOR_DETAILS}}`。委託先へ目的外利用させません。

## 5. 第三者提供

- 通常の第三者提供の有無・相手・項目・目的・根拠: `{{THIRD_PARTY_DISCLOSURE}}`
- 事故、違反、保険請求、法令照会等: `{{REQUIRED_DISCLOSURES}}`
- opt-out提供の有無: `{{OPT_OUT_DISCLOSURE_OR_NONE}}`

委託、共同利用、法令上の例外と第三者提供を区別します。

## 6. 共同利用

共同利用する場合のみ、項目、利用者の範囲、目的、管理責任者の名称・住所・代表者を記載します: `{{JOINT_USE_OR_NONE}}`。

## 7. 外国にある第三者・国外処理

国/地域、受領者、制度、保護措置、本人への情報提供、同意または他の取扱根拠: `{{CROSS_BORDER_TRANSFER_OR_NONE}}`。単に「海外サーバーを利用することがあります」とだけ記載しません。

## 8. 安全管理措置

基本方針、責任体制、規程、教育、入退室・媒体、アクセス制御、MFA、暗号化、logging、脆弱性管理、委託先監督、国外制度把握、backup、incident対応の概要: `{{SECURITY_MEASURES_SUMMARY}}`。

安全上支障がある詳細な設定値・秘密情報は公開しません。

## 9. 保存・削除

目的、法令、会計、紛争可能性に応じた区分別期間を第2節に明記し、期間満了後は削除または不可逆匿名化します。legal hold、backupからの期限後削除、退会時に保持する取引snapshot: `{{RETENTION_AND_DELETION_PROCESS}}`。

## 10. 開示等の請求

利用目的通知、開示（第三者提供記録を含む）、訂正・追加・削除、利用停止・消去、第三者提供停止の対象、受付方法、本人/代理人確認、回答方法、期間、手数料、請求書式: `{{DATA_SUBJECT_REQUEST_PROCESS}}`。

法令上応じられない場合は、範囲と理由を説明します。

## 11. 漏えい等への対応

連絡窓口: `{{INCIDENT_CONTACT}}`。対象事態の判定、拡大防止、調査、個人情報保護委員会への速報/確報、本人通知、再発防止をincident runbookに定めます。

## 12. 未成年者・代理申込み

年齢条件、親権者同意、代理予約、運転者本人への告知: `{{MINOR_AND_PROXY_BOOKING_RULE}}`。

## 13. 任意提供・不提供の結果

任意項目と提供しない場合の影響: `{{OPTIONAL_FIELDS_EFFECT}}`。広告メールへの不同意を予約拒否理由にしません。

## 14. 改定

改定方法、重要変更の通知、施行日、過去版の閲覧: `{{CHANGE_NOTICE_RULE}}`。公開済み文書は上書きせず、versionとcontent hashを保存します。
