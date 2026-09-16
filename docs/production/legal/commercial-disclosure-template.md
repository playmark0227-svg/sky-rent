# 特定商取引法に基づく表記テンプレート

状態: **草案 / 本番公開禁止**
文書種別: `commercial_disclosure`
版: `{{DOCUMENT_VERSION}}` / 施行日: `{{EFFECTIVE_AT}}` / 更新日: `{{UPDATED_AT}}`

> 個人向けWeb予約は、現地払いでも通信販売に該当し得る前提で用意するテンプレートです。取引設計に対する適用と表記事項を日本法の専門家が確認し、すべて実値へ置換してから公開してください。

| 表記事項 | 公開内容 |
|---|---|
| 事業者の正式名称 | `{{LEGAL_ENTITY_NAME}}` |
| 代表者または通信販売責任者 | `{{REPRESENTATIVE_OR_RESPONSIBLE_PERSON}}` |
| 所在地 | `{{POSTAL_CODE}}` `{{REGISTERED_ADDRESS}}` |
| 電話番号 | `{{PHONE_NUMBER}}`（受付時間 `{{PHONE_HOURS}}`） |
| メール/問い合わせ方法 | `{{CONTACT_EMAIL_OR_FORM}}`（回答目安 `{{RESPONSE_SLA}}`） |
| Webサイト | `{{SITE_URL}}` |
| 自家用自動車有償貸渡事業 | `{{PERMIT_DETAILS}}` |
| 販売/役務の対価 | 各車両・日時の見積および[料金ページ](pricing-cancellation-template.md)に税込表示 |
| 対価以外の負担 | `{{ADDITIONAL_CHARGES}}`（option、乗捨て、燃料、延長、NOC、通信料等を区別） |
| 支払方法 | `{{PAYMENT_METHODS}}` |
| 支払時期 | `{{PAYMENT_TIMING}}` |
| 役務の提供時期 | 予約で選択した貸渡開始日時 `{{SERVICE_TIMING_DETAIL}}` |
| 申込みの有効期限 | `{{APPLICATION_EXPIRY_OR_NOT_APPLICABLE}}` |
| 予約成立/貸渡契約成立 | `{{RESERVATION_ACCEPTANCE_POINT}}` / `{{RENTAL_CONTRACT_FORMATION_POINT}}` |
| 変更・取消し・無断取消し | [取消規定](pricing-cancellation-template.md) `{{CANCELLATION_SUMMARY}}` |
| 返金 | `{{REFUND_METHOD_AND_TIMING}}` |
| 事業者都合・車両提供不能 | `{{OPERATOR_FAILURE_REMEDY}}` |
| 動作環境等 | `{{TECHNICAL_REQUIREMENTS_OR_NOT_APPLICABLE}}` |
| 特別条件 | 年齢、免許、本人確認、利用区域等 `{{ELIGIBILITY_AND_RESTRICTIONS}}` |

## 表示実装

- 全ページfooter、予約入力、最終確認、予約完了メールから1操作で到達可能にする。
- 電話番号等を「請求があれば遅滞なく開示」方式にする場合は、法的可否・請求導線・即応運用を専門家が承認する。原則はページへ直接表示する。
- 価格、支払、提供時期、取消しを貸渡約款や料金ページへ分散させる場合も、リンク名と位置を明瞭にし、最終確認には必要事項を再掲する。
- 表示内容の変更は新versionとして保存し、過去予約から受付時の内容を再現できるようにする。

## 公開前チェック

- [ ] 登記・許可・実際の問い合わせ受付情報と一致
- [ ] 税込総額と追加負担を予約前に判別できる
- [ ] 現地払いを理由に支払時期・方法を省略していない
- [ ] 取消条件・期限・返金方法が具体的
- [ ] 最終確認画面と矛盾しない
- [ ] 専門家が適用と表現を承認
