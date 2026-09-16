# 広告メール同意テンプレート

状態: **草案 / 本番公開禁止**
文書種別: `marketing`
版: `{{DOCUMENT_VERSION}}` / 施行日: `{{EFFECTIVE_AT}}`

## フォーム表示

既定OFFの独立したcheckboxとして、次のように表示します。

> [ ] `{{LEGAL_ENTITY_NAME}}` から、キャンペーン、空車情報、お得な案内をメールで受け取ることに同意します。配信は各メールの停止リンクまたは `{{PREFERENCE_CENTER_URL}}` からいつでも停止できます。[詳しい取扱い]({{PRIVACY_URL}})

予約・会員登録・問い合わせに必要な通知と広告を分離し、同意しなくてもサービスを利用できるようにします。

## 証跡

- email ID（生emailをanalytics logへ出さない）
- `opted_in` / `declined` / `withdrawn`（OFFは同意として扱わない）
- document version / content hash
- server時刻、source、locale、request ID
- 同意時に表示した文面snapshot
- 撤回時刻・方法

## 配信要件

- 送信前に最新の同意状態とsuppression listを確認
- 送信者名称・連絡先・配信停止方法を明瞭に表示
- unsubscribeはlogin不要で、短時間に反映
- 停止linkはopaque tokenをURL query、referrer、analytics、通常logへ送らず、公開landing pageのfragmentから専用request headerへ渡す。再送は冪等に成功扱いとする
- 停止後はsuppressionを有効にし、本人が新しい文書versionへ再同意しない限り解除しない
- transaction通知へ広告を混在させない
- 購入/予約履歴だけを根拠に同意済み扱いしない
- 特定商取引法上の電子メール広告に該当する場合、承諾を得た記録または請求を受けた記録を最後の広告送信日から3年間保存し、それ以上の期間 `{{CONSENT_RECORD_RETENTION}}` が必要かを法務承認
