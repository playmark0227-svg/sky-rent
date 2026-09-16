# 法務公開ページ実装要件

更新日: 2026-09-16
状態: **草案 / 本番公開禁止**

## 1. 方針

このフォルダは、日本国内でレンタカー予約を受け付けるための公開ページと申込画面を実装する直前のテンプレートである。法令本文を転載した完成約款ではなく、実在事業者の許可・届出・運用へ合わせる入力枠を定義する。

次を満たすまで顧客向けrouteへ公開しない。

- `{{...}}` placeholderが0件
- 自家用自動車有償貸渡事業の許可・届出内容と会社/営業所/料金/約款が一致
- 日本法の専門家、事業責任者、個人情報管理責任者が承認
- 文書ごとにversion、施行日、content hash、承認者、承認日を登録
- 予約最終確認E2Eと、過去予約から適用版を再表示する試験が合格

## 2. 顧客向けroute

| route | 文書 | 扱い |
|---|---|---|
| `/legal/rental-terms` | 貸渡約款 | レンタカー事業で必須。許可・届出内容と一致する承認済み版を表示 |
| `/legal/pricing` | 貸渡料金・追加負担・取消・NOC・補償 | 必須。予約前と最終確認から到達可能 |
| `/legal/commercial-disclosure` | 特定商取引法に基づく表記 | B2C Web申込は適用前提で実装し、専門家が最終判断 |
| `/legal/privacy` | 個人情報の取扱い | 個人情報取得前に利用目的を明示し、公表事項を掲載 |
| `/legal/external-transmission` | 外部送信ポリシー | 第三者script/SDKと適用判断に応じて公開。inventoryは常に必須 |
| `/legal/marketing-consent` | 広告メール同意の説明・設定 | 広告メールを送る場合。取引通知と分離し、同意撤回へ到達可能にする |
| `/legal/site-terms` | Webサイト利用条件 | 推奨。貸渡約款と矛盾させない |
| `/legal/accessibility` | 利用支援・問い合わせ | 推奨。法務窓口とは分離 |

実装前の入力テンプレート:

- [貸渡約款](rental-terms-template.md)
- [料金・取消し・保険補償](pricing-cancellation-template.md)
- [特定商取引法に基づく表記](commercial-disclosure-template.md)
- [プライバシーポリシー](privacy-policy-template.md)
- [外部送信・Cookie](external-transmission-template.md)
- [広告メール同意](marketing-consent-template.md)
- [予約最終確認画面](final-confirmation-spec.md)

全公開ページのfooter、予約入力、最終確認、予約完了メールから該当文書へ到達できるようにする。

## 3. 必須・条件付き・推奨

### 必須ゲート

- 道路運送法上の許可取得、正式な貸渡人/営業所/車両・料金・約款との整合
- 全貸渡車両の保険が公開日時点の許可条件を満たし、Webの補償・免責・適用除外が実保険証券と一致
- 貸渡料金と貸渡約款の借受人への明示
- 運転者の紹介・あっせんを行わない旨の明示、貸渡簿の法定項目と貸渡終了後2年保存。レンタカー型カーシェアリングを除き、貸渡証の交付と運転者への携行指示
- 前年度の貸渡実績（車種区分別の車両数、延貸渡回数、延貸渡日車数、延走行キロ、総貸渡料金。該当時はカーシェアリング内訳）と、3月31日時点の全配置事務所の名称・所在地・車種区分別車両数について、管轄運輸支局ごとに別葉とした管轄確認済み現行様式で、主たる事務所所在地を管轄する運輸支局長へ毎年5月31日までに報告する運用
- 通信販売として必要な広告事項と最終確認画面の表示・訂正導線
- 個人情報の具体的利用目的をフォーム送信前に明示
- 保有個人データの事業者情報、利用目的、開示等手続、安全管理措置概要、窓口
- 適用文書version・同意/確認・最終確認snapshotの保存
- 消費者契約法上無効となり得る全部免責・故意重過失免責・不当な解除制限を入れない

国交省通達が「明示するよう努めること」とする、損害賠償 / NOC、保険・補償、事故・故障・盗難、違法駐車、返還遅延の重要事項は、法定義務との表現を混同せず、本プロジェクトでは安全・紛争予防上の公開 Blocker として貸渡前に明示する。

### 条件付き

- 第三者analytics/広告/map/chat/error tracking等: 外部送信規律の適用判断と情報提供/同意/opt-out
- marketing email: 事前opt-in、拒否導線、承諾/請求証跡。特商法上の電子メール広告に該当する場合は最後の広告送信から3年間記録を保存
- 国外委託/第三者提供: 移転先・制度・保護措置の確認と必要な情報提供/同意
- online決済: 決済事業者hosted page、返金、PCI責任範囲。役務提供前に代金の全部または一部を受ける場合は、特商法13条の適用と、事業者情報、受領額 / 日、対象役務の種類 / 数量、諾否、提供時期、不承諾時の返金通知を確認
- 要配慮個人情報: 原則取得しない。必要時は法的根拠と同意を別途確認

### 推奨

- 日本語を正本とし、英訳は参考訳と明記
- PDFだけにせず、mobileで読めるHTMLと印刷版を用意
- 重要変更は既存予約へ遡及させず、新versionを発行
- 法務文面に平易な要約を付けるが、要約だけで同意を取らない

## 4. 取得画面の表示

氏名・メール・電話・会社・住所・免許等を入力させる各画面で、送信ボタンより前に次を表示する。

- 取得主体
- 具体的な利用目的
- 必須/任意
- 問い合わせ窓口
- privacyページへの明瞭なリンク

予約では、貸渡約款・取消規定・privacyの各versionを分離して提示する。

- 必須: 「貸渡約款と取消条件を確認し、予約を申し込みます」
- 通知: 「個人情報の利用目的を確認しました」
- 任意・既定OFF: 「お得な情報をメールで受け取る」

privacy同意を、法令上の利用目的明示や安全管理義務の代替にしない。marketing同意を予約条件にしない。

## 5. version・証跡

`legal_document_versions` に `document_type`, `version`, `language`, `content_hash`, `uri`, `published_at`, `effective_at`, `approved_by`, `approved_at` を保存し、公開済み版は変更しない。

予約・問い合わせでは少なくとも次を同一transactionで保存する。

- document type / version / content hash
- accepted/acknowledgedの区分
- occurred_at（server時刻）
- source / locale
- reservationまたはinquiry ID
- 最終確認snapshot hash
- request ID

文面差替えではなく新versionを発行し、既存予約は受付時versionで再現する。

## 6. 一次資料

- [レンタカー事業について（北海道運輸局）](https://wwwtb.mlit.go.jp/hokkaido/bunyabetsu/jidousya/index_00002.html)
- [許可条件・貸渡簿・貸渡証・年次報告（国土交通省）](https://wwwtb.mlit.go.jp/hokkaido/content/000269958.pdf)
- [北海道運輸局「貸渡実績報告の作成」・現行様式](https://wwwtb.mlit.go.jp/hokkaido/shinseinavi.renta109.html)
- [通信販売広告の表示事項（消費者庁）](https://www.no-trouble.caa.go.jp/what/mailorder/advertising.php)
- [通信販売の申込み段階の表示（消費者庁）](https://www.caa.go.jp/policies/policy/consumer_transaction/amendment/2021/notice02/)
- [通信販売の最終確認画面（消費者庁）](https://www.caa.go.jp/notice/assets/consumer_transaction_cms203_240315_02.pdf)
- [個人情報保護法ガイドライン（個人情報保護委員会）](https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/)
- [漏えい等の対応（個人情報保護委員会）](https://www.ppc.go.jp/personalinfo/legal/leakAction/)
- [外部送信規律FAQ（総務省）](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00002.html)
- [消費者契約法の不当条項（消費者庁）](https://www.caa.go.jp/policies/policy/consumer_system/consumer_contract_act/public_relations/assets/consumer_system_cms101_231107_01.pdf)

## 7. 公開前の専門家確認

最低限、次を質問票にして回答を証跡化する。

1. この予約方式・支払方式への特定商取引法の適用と必要表示
2. 貸渡約款・料金・取消料・NOC・補償の許可/届出整合
3. 予約申込と貸渡契約成立の時点
4. 免許情報を予約時に取得する必要性と保持期間
5. privacyの第三者提供・委託・国外移転・開示等手続
6. 第三者script/SDKに対する外部送信規律の適用
7. 免責・損害賠償・解除条項の消費者契約法適合性
8. marketing emailのopt-inと証跡保持
