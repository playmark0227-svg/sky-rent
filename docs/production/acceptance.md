# 本番実装・受入・Go / No-Go チェックリスト

更新日: 2026-09-16
対象: グロースレンタカー公開予約、会員、問い合わせ、管理、請求・入金、通知、運用基盤
状態: **実装前ドラフト。本書の Blocker が一つでも未完了なら本番公開 No-Go**

> [!WARNING]
> 現行の GitHub Pages 版は `localStorage` を正本とする機能デモであり、本番受入の対象外である。実在する個人情報、免許情報、予約、問い合わせ、請求情報を入力してはならない。

本書は、開発者と事業責任者が同じチェックリストで実装着手、検収、移行、公開可否を判断するための資料である。API 契約は [OpenAPI](openapi.yaml)、DB と transaction の不変条件は [データモデル](data-model.md)、採用構成と事業判断は [本番化実装ハンドオフ](README.md)、現行との差は [現状監査](current-state-audit.md) を正とする。

法令への適合性については実装受入の観点で整理したもので、法的助言ではない。公開前に、判断 P の資料一式を日本法の専門家および管轄運輸支局へ確認する。

## 1. 使い方と判定規則

- `[ ]` は未完了、`[x]` は証跡を添えて完了したことを示す。
- 各チェックには、課題・PR・テスト結果・承認記録・監視画面等の URL または保存場所を `証跡:` に記入する。
- **Blocker** は v1 公開前に必須。**Conditional** は記載条件に該当する場合に必須。**Recommended** は非適用理由を記録した場合だけ延期できる。
- 自動テストの成功だけでは完了としない。権限、PII、法務表示、復元、実ブラウザは人手でも確認する。
- 受入データに実在顧客の PII を使わない。固定 fixture または明示的な合成データだけを使う。
- 不具合を waive する場合は、severity、影響、期限、暫定回避、owner、事業責任者とセキュリティ責任者の承認を記録する。Critical / High の waive は不可。

### 1.1 受入責任

| 領域 | 実行責任 | 承認責任 | 必須証跡 |
|---|---|---|---|
| 機能・API・DB | 開発責任者 | プロダクト責任者 | CI、PR、migration、E2E |
| 認証・認可・PII | セキュリティ担当 | 事業責任者 | threat model、権限試験、監査ログ |
| 料金・予約・請求 | 開発担当 + 業務担当 | 事業責任者 | 期待値表、照合結果、承認日 |
| 法務表示・同意 | 業務担当 + 法務担当 | 代表者または権限者 | 判断 P、版付き公開文書、レビュー記録 |
| 移行・バックアップ | 開発 / SRE | システム owner | dry-run、照合、復元記録 |
| Go / No-Go | 各領域 owner | 事業責任者 | §13 の署名記録 |

## 2. 実装着手条件（Definition of Ready）

### 2.1 事業判断 A〜P

全項目に `owner / 決定内容 / 承認者 / 承認日 / 変更履歴` が必要である。「後で決める」は未完了として扱う。

| ID | 決定対象 | 着手条件 |
|---|---|---|
| A | Supabase plan、予算、契約・請求・障害連絡 owner | 必要な Auth、PITR、ログ、リージョン、サポート条件を満たす plan が承認済み |
| B | 公開 / admin / API domain、Cookie・Auth 境界 | origin、CORS、Cookie 属性、redirect URL、CSP 対象が確定 |
| C | v1 の商品、拠点、実車 master | asset 1 行 = 物理 1 台、拠点、公開可否、必要免許が承認済み |
| D | 料金、税、端数、season、割引優先順位 | 具体例を含む期待値表が承認済み |
| E | 営業時間、休業、前後 buffer、整備 block | 空き判定へ変換できる形式で確定 |
| F | 予約成立、仮押さえ、変更、取消、no-show | 状態遷移、料金発生日、期限、担当が確定 |
| G | guest 予約、本人確認、view / cancel token | token 発行・有効期限・再発行・失効・漏えい時手順が確定 |
| H | 免許情報の項目、目的、取得時点、閲覧者、保持 | 予約時に本当に必要な項目と貸渡時取得項目を分離し承認済み |
| I | staff 名簿、role × permission × 拠点 scope | `viewer / maintenance / store_staff / accounting / admin` の deny-by-default 表が承認済み |
| J | 請求書資格、締日、税、様式、振込先、取消・訂正 | invoice / payment / reversal の業務フローが確定 |
| K | email provider、送信元、template、bounce / complaint 運用 | SPF / DKIM / DMARC、配信責任者、SLA が確定 |
| L | 問い合わせ種別、担当、拠点、SLA、spam 対策 | routing と escalation が確定 |
| M | 旧データの有無、正本、移行対象、変換、廃棄 | source ごとの件数と owner が確定 |
| N | 保持・削除、privacy、委託 / 再委託、国外取扱い | 項目別 retention と data flow が承認済み |
| O | traffic、SLO、RPO / RTO、障害連絡、保守時間 | §10 の値または代替値が承認済み |
| P | 事業者正式情報、許可・届出、貸渡約款、料金、取消、保険補償、特商法、privacy、外部送信 | 法務・運輸支局確認済みの公開原稿と適用判断、版、施行日が承認済み |

- [ ] `DR-01` A〜P の決定記録に空欄がない。証跡: __________
- [ ] `DR-02` A〜P の変更が DB / OpenAPI / UI / 公開文書 / 運用手順へ与える影響を追跡できる。証跡: __________
- [ ] `DR-03` v1 対象外（オンライン決済、未採用商品等）は API、UI、文書で有効に見えない。証跡: __________
- [ ] `DR-04` DB、OpenAPI、permission 表、法務文書で同じ用語・状態・金額・時刻境界を使う。証跡: __________
- [ ] `DR-05` threat model、data flow、PII inventory、processor 一覧がレビュー済み。証跡: __________

### 2.2 全チケット共通 Definition of Done

- [ ] 実装・migration・設定変更が peer review 済みで、既知の Critical / High がない。
- [ ] success、validation、unauthenticated、unauthorized、conflict、retry、timeout の自動テストがある。
- [ ] 認可は UI 非表示だけでなく API と DB / RLS で強制される。
- [ ] client の user ID、role、price、discount、invoice eligibility、status を信頼しない。
- [ ] 変更操作は request ID、actor、scope、result を監査でき、秘密・token・不要な PII をログへ出さない。
- [ ] DB 変更には forward migration、互換期間、rollback または roll-forward 手順がある。
- [ ] メトリクス、alert、runbook、担当 owner が追加されている。
- [ ] OpenAPI、データモデル、運用文書、公開文書の該当箇所が同じ PR で更新されている。
- [ ] browser / keyboard / screen reader を含む該当受入を通過している。
- [ ] 証跡 URL と、必要なら残存リスク・期限・owner がチケットに記録されている。

## 3. フェーズと実装チケット

### Phase 0 — 決定、法務、基盤（全 Phase の前提）

#### `P0-01` A〜P 決定台帳

依存: なし

- [ ] A〜P を §2.1 の形式で承認し、変更は ADR / decision log で管理する。
- [ ] 料金・取消・保持・permission・RPO / RTO は具体例または表で machine-testable にする。
- [ ] **DoD:** 未決値、仮の会社情報、仮料金、仮連絡先が本番 artifact にない。

#### `P0-02` 本番法務パック

依存: `P0-01(P)`

- [ ] §8 の法務受入を完了し、公開文書ごとに `document_type / version / effective_at / content_hash / language` を固定する。
- [ ] 管轄運輸支局への許可・届出内容と、サイトの事業者・拠点・料金・約款・補償が一致する。
- [ ] 特商法の適用、予約契約と貸渡契約の成立時点、取消料発生時点を法務担当が明記する。
- [ ] **DoD:** 法務承認済みの原稿、承認者、承認日、次回レビュー日が保存される。

#### `P0-03` 環境分離、CI/CD、secret

依存: `P0-01(A,B,O)`

- [ ] `local / test / staging / production` を別 project・DB・Auth・secret・domain で分離する。
- [ ] production deploy は protected branch、required CI、承認者、immutable build artifact を通す。
- [ ] secret は secret manager で管理し、repository、HTML、bundle、ログに含めない。
- [ ] production から staging へ PII を複製しない。必要時は不可逆マスクした合成データを使う。
- [ ] **DoD:** staging から production の DB / storage / email へ書けないことを実証する。

#### `P0-04` テスト基盤と時刻・外部 service 境界

依存: `P0-01(D,E,F,K,L)`

- [ ] clock、email、storage、PSP（将来）、analytics を差替え可能にし、決定的な fixture を用意する。
- [ ] DB は UTC 保存、業務表示・締め境界は `Asia/Tokyo` とし、日跨ぎ・月跨ぎ・閏日を test する。
- [ ] OpenAPI contract test と migration test を CI に追加する。
- [ ] **DoD:** 外部 provider を実送信せず、主要 E2E を反復実行できる。

### Phase 1 — DB、認証、認可、監査

#### `P1-01` DB schema と予約不変条件

依存: `P0-01(C,D,E,F,J,N)`, `P0-03`

- [ ] PK / FK / unique / check / exclusion constraint、半開区間 `[start_at, end_at)`、money の integer 単位を migration 化する。
- [ ] 予約、allocation、価格 snapshot、point、coupon、invoice、payment、audit、outbox を上書きだけで消さない設計にする。
- [ ] 物理削除が法定・会計・監査履歴を壊さない。Auth user の disable / anonymize と業務履歴を分離する。
- [ ] **DoD:** 空 DB と直前 production 相当 DB の両方で migration が成功し、constraint 破りが DB で拒否される。

#### `P1-02` Auth、RBAC、RLS、MFA

依存: `P0-01(B,G,I)`, `P1-01`

- [ ] member と staff の subject、session、logout、password reset、email verification を実装する。
- [ ] staff は `viewer / maintenance / store_staff / accounting / admin` と拠点 scope を毎 request で DB の現値から評価する。
- [ ] staff の管理操作は AAL2 / MFA を必須とし、降格・無効化・拠点変更を既存 session に速やかに反映する。
- [ ] user JWT の DB client と、限定した server / RPC の service credential を分離する。service role の常用は禁止する。
- [ ] **DoD:** §5 の horizontal / vertical / cross-location 試験が API と DB 直下の双方で通る。

#### `P1-03` PII、mask、監査

依存: `P0-01(H,I,N)`, `P1-02`

- [ ] 一覧、詳細、帳票、CSV、ログごとに full / masked / deny DTO を分ける。
- [ ] full PII の read / export は permission、purpose、AAL2、拠点 scope、監査を要求する。
- [ ] 監査 event は anonymous / member / staff / system / import を表し、成功・拒否・失敗を追記専用で残す。
- [ ] 予約段階の免許番号・画像は決定 H の必要最小限だけを取得し、検索 key や一般一覧に使わない。貸渡時は法定貸渡簿の免許種類・番号を暗号化して終了後最低2年保持し、通常DTOはlast4だけとする。
- [ ] **DoD:** §7 の PII 試験と、監査ログ改ざん・削除拒否試験が通る。

#### `P1-04` 冪等、outbox、retry

依存: `P1-01`, `P1-02`

- [ ] 予約・問い合わせ・入金・請求・取消等の mutation に、subject / anonymous scope を含む冪等境界を定義する。
- [ ] 同じ key + 同じ canonical payload は同じ結果、同じ key + 異なる payload は conflict とする。
- [ ] DB commit と outbox enqueue を同一 transaction にし、worker retry で二重送信・二重計上しない。
- [ ] 匿名 mutation は事前bootstrap/Cookieなしで、client生成の128bit以上の予測困難な key（UUIDv4または16 random bytes以上）を要求する。serverはendpointとkeyをsecret付きHMACでscope化し、raw keyを保存・logしない。
- [ ] **DoD:** network timeout、worker crash、duplicate delivery、順序逆転を fault injection して §6 を満たす。

### Phase 2 — 公開予約、会員、問い合わせ、通知

#### `P2-01` 公開 catalog、価格、quote

依存: `P1-01`, `P0-01(C,D,E)`

- [ ] 公開可の拠点・カテゴリ・asset・option・営業条件だけを返す。
- [ ] server が active immutable pricing revision から税・割引・season・option を再計算し、quote ID と期限を返す。
- [ ] client 表示値の改ざん、期限切れ quote、非公開 master、invoice 不適格を拒否する。
- [ ] **DoD:** 判断 D の全 golden case と境界値で UI / API / invoice の金額が一致する。

#### `P2-02` 空き検索と予約 transaction

依存: `P1-01`, `P1-04`, `P2-01`

- [ ] 検索は目安、作成 transaction 内で価格・営業時間・buffer・整備・重複・資格を再検証する。
- [ ] reservation、allocation、価格 snapshot、consent evidence、audit、outbox を単一 transaction で確定する。
- [ ] 競合は安定した Problem Details と retry 可否を返し、二重予約を生成しない。
- [ ] **DoD:** §6 の並行・rollback・冪等試験が production 相当 DB で通る。

#### `P2-03` guest / member の予約照会・変更・取消

依存: `P1-02`, `P2-02`, `P0-01(F,G)`

- [ ] member は本人予約だけ、guest は十分な entropy を持つ所有 token で対象予約だけを扱う。
- [ ] token を URL query、referrer、analytics、ログへ出さず、失効・再発行・rate limit を実装する。
- [ ] 変更・取消は競合と row version を再検証し、reason code、actor、適用規定、金額を履歴化する。
- [ ] **DoD:** 他人予約、推測 token、期限切れ token、同時変更を拒否する。view token は失効・取消・期限切れまでの再利用を許可して `use_count / last_used_at` を記録し、cancel token は成功時に原子的に消費して再利用だけを拒否する。

#### `P2-04` 会員

依存: `P1-02`, `P1-03`

- [ ] password を業務 DB に保存せず、確認済み subject だけを member に紐付ける。
- [ ] email 一致だけで既存予約を自動連結しない。account linking は再認証・所有確認・監査を伴う。
- [ ] point / coupon は追記台帳から残高を再現でき、同一 reservation で二重付与・二重消費しない。
- [ ] 退会、開示、訂正、利用停止は法定保持データと Auth disable を区別する。
- [ ] **DoD:** takeover、replay、二重付与、self-service privacy request の E2E が通る。

#### `P2-05` 問い合わせ

依存: `P1-03`, `P1-04`, `P0-01(L)`

- [ ] location / category / owner / SLA を持つ durable DB 受付とし、画面内保存だけで完了表示しない。
- [ ] 予約に紐付ける場合、member ownership または guest ownership token を検証する。
- [ ] spam、rate limit、危険添付、HTML injection、メール header injection を防ぐ。
- [ ] internal note と customer message を分離し、顧客へ internal note を返さない。
- [ ] **DoD:** 受付 ID、担当 routing、返信 outbox、失敗 alert、監査を確認できる。

#### `P2-06` 通知

依存: `P1-04`, `P0-01(K)`, `P2-02`, `P2-05`

- [ ] 受付、成立、変更、取消、問い合わせ返信を別 template / event とし、状態を誤認させない。
- [ ] provider ID、attempt、delivered / bounced / complained / failed を保存し、DLQ を運用できる。
- [ ] template に秘密 token や不要な免許情報を含めない。guest link は期限・失効を持つ。
- [ ] transaction 通知と marketing を分離し、marketing は明示 opt-in と unsubscribe を持つ。
- [ ] 予約・会員登録・問い合わせのmarketing入力は任意・既定OFFで、OFFでも本体処理が成功する。ON/OFFは承認済み文書versionとserver時刻で証跡化する。
- [ ] 会員は本人設定から変更でき、広告メールの停止はlogin不要で完了する。opaque tokenはquery/referrer/analytics/通常logへ出さず、fragmentから専用headerへ移し、再送も冪等に停止状態を維持する。
- [ ] 再同意がない限りsuppressionを解除せず、送信workerは毎回最新preferenceとsuppressionを確認する。
- [ ] **DoD:** duplicate / delay / bounce / provider outage の受入と runbook が通る。

#### `P2-07` 最終確認、法的文書、同意証跡

依存: `P0-02`, `P2-01`, `P2-02`

- [ ] §8 の最終確認 6 項目、明確な申込 button、容易な訂正手段を mobile / desktop で実装する。
- [ ] 貸渡約款、取消規定、privacy 利用目的を送信前に一操作以内で確認できる。
- [ ] terms / cancellation の確認、privacy の利用目的明示、任意 marketing 同意を意味上分離する。
- [ ] server が文書 version / hash、表示言語、source、accepted_at、request ID、最終 quote を保存する。client 時刻を正としない。
- [ ] **DoD:** 表示した内容を予約単位で再現でき、文書改定後も過去予約の適用版を提示できる。

### Phase 3 — 管理、車両、請求・入金

#### `P3-01` 予約・車両・整備運用

依存: `P1-02`, `P1-03`, `P2-02`

- [ ] role / permission / location scope ごとに mask 済み一覧と必要時だけの full detail を実装する。
- [ ] asset、営業 closure、maintenance block は予約と同じ占有規則で競合を防ぐ。
- [ ] 状態遷移は server state machine、reason code、optimistic lock、audit を必須とする。
- [ ] CSV / 印刷 / report も API と同じ認可・mask・監査を通す。
- [ ] **DoD:** 同時編集、拠点越境、禁止遷移、整備と予約の競合が拒否される。

#### `P3-02` invoice、payment、reversal

依存: `P1-01`, `P1-03`, `P0-01(J)`

- [ ] invoice は line、税率、subtotal、tax、total、宛先 snapshot、番号を保存し、発行後の上書きを禁止する。
- [ ] 入金は amount、tender、occurred_at、reference を持つ追記 transaction とし、取消・返金は reversal で表す。
- [ ] void / reissue / mark-paid は permission、AAL2、reason、row version、audit を要求する。
- [ ] v1 の予約作成では `online` 決済を受理せず、現地決済と承認済み請求書払いだけに制限する。
- [ ] **DoD:** 二重入金、過大入金、取消、再発行、締め境界、税計算を照合できる。

#### `P3-03` 管理運用と監査レビュー

依存: `P3-01`, `P3-02`, `P2-05`

- [ ] staff join / move / leave、MFA reset、緊急権限、定期 access review 手順を用意する。
- [ ] full PII access、export、権限変更、料金 publish、invoice 操作を定期レビューできる。
- [ ] break-glass は期限、理由、二者承認、通知、事後レビューを持つ。
- [ ] **DoD:** 退職者無効化と権限剥奪を演習し、既存 session が継続利用できない。

#### `P3-04` 法定貸渡記録・貸渡証・年次報告

依存: `P1-03`, `P3-01`, `P0-02`

- [ ] 貸渡開始時に借受人、全運転者の氏名/住所/免許種類/番号、車両、日時、貸渡/返還事務所、料金等をimmutable snapshotへ固定する。
- [ ] レンタカー型カーシェアリングに該当しない貸渡しでは、貸渡証を所定事項・注意事項付きで借受人へ交付し、貸渡簿の全運転者へ携行・請求時提示を指示する。交付先・方法・日時と、指示した全driver index・方法・server日時をversion、hash、理由、audit付きで残し、未交付・一人でも未指示なら貸渡開始を拒否する。
- [ ] 返還時に走行距離、事故事項等を確定し、貸渡簿を終了後最低2年保持する。通常画面は免許last4だけとする。
- [ ] 年次貸渡実績は、管轄運輸支局ごとに別葉で、事務所数・車種区分ごとの車両数、延貸渡回数、延貸渡日車数、延走行キロ、総貸渡料金を現行様式どおり集計する。レンタカー型カーシェアリングを行う場合は、同様式の専用内訳も生成する。
- [ ] 3月31日配置車両数は、管轄運輸支局ごとに別葉で、全配置事務所の名称・所在地、車種区分別台数・合計を現行様式どおり集計する。
- [ ] 拠点の改名・移転・開閉、車両の移管・車種区分変更・廃車は業務発効日付き履歴にし、過去の対象期間/3月31日snapshotを生成時の現行masterから復元しない。
- [ ] 両報告は管轄確認済み様式version/template hashを固定し、serverが対象期間/基準日の実効履歴から算出した全報告対象事務所を含まない生成を拒否する。主たる事務所所在地を管轄する提出先運輸支局長をsnapshot化し、集計snapshot / hash、file hash・提出先・提出・受理証跡を追記専用で保存する。
- [ ] **DoD:** 国交省通達の貸渡簿/貸渡証fixture、2年保持、毎年5月31日提出のrehearsalを法務・業務担当が承認する。

### Phase 4 — 移行、復旧、監視、hardening

#### `P4-01` データ移行

依存: `P1-01`, `P0-01(M,N)`, 対象 feature 完了

- [ ] §9 の inventory、mapping、dry-run、reject、reconciliation、rollback を完了する。
- [ ] browser `localStorage` export を正本または本番 backup として取り込まない。
- [ ] import actor / source / batch / original ID / checksum を監査し、再実行しても重複しない。
- [ ] **DoD:** production snapshot 相当で dry-run 2 回が同じ結果になり、業務 owner が件数・金額を承認する。

#### `P4-02` backup、restore、DR

依存: `P1-01`, `P0-01(A,N,O)`

- [ ] §10 の暫定 RPO / RTO または O の承認値を満たす backup / WAL / export を構成する。
- [ ] 暗号化、access 分離、保管期限、削除、破損検知、provider 障害時の取得経路を定義する。
- [ ] isolated 環境で restore し、件数・constraint・RLS・主要 E2E・outbox を確認する。
- [ ] **DoD:** 時刻入りの復元演習で実測 RPO / RTO が目標内、証跡と改善 owner が残る。

#### `P4-03` 監視、alert、incident response

依存: 各 feature、`P0-01(O)`

- [ ] §11 の service、security、business、delivery、backup 指標を PII なしで取得する。
- [ ] severity、on-call、ack / escalation、顧客告知、法定漏えい判断、postmortem 手順を定義する。
- [ ] synthetic 予約は本番在庫・売上に混入せず、専用 fixture / tenant で行う。
- [ ] **DoD:** alert drill と table-top incident で、担当が runbook のみを使って検知・切分け・連絡できる。

#### `P4-04` security / performance hardening

依存: Phase 1〜3

- [ ] SAST、dependency / secret scan、DAST、manual authz review、rate-limit test を CI / release gate に入れる。
- [ ] CSP、HSTS、secure header、TLS、Cookie 属性、CORS、CSRF、XSS、SQL injection、SSRF、upload を確認する。
- [ ] traffic 想定の 2 倍以上または O の承認 load で、予約競合の正しさを保ったまま SLO を満たす。
- [ ] **DoD:** Critical / High vulnerability が 0、Medium は期限・owner 付きで承認済み。

### Phase 5 — 総合受入と公開

#### `P5-01` E2E、browser、accessibility

依存: Phase 2〜4

- [ ] §4〜§12 の matrix を staging の release candidate で実行する。
- [ ] 日本語・英語、guest・member・各 staff role、mobile・desktop の主要 journey を通す。
- [ ] **DoD:** Blocker 100%、Recommended は非適用根拠付きで、未解決 Critical / High が 0。

#### `P5-02` cutover rehearsal

依存: `P4-01`, `P4-02`, `P4-03`, `P5-01`

- [ ] freeze、最終差分、migration、DNS / config、smoke、業務照合、rollback を時間計測して rehearsing する。
- [ ] 本番前 backup と rollback point を取り、old demo への PII 入力を技術的に停止する。
- [ ] **DoD:** rehearsal が O の停止許容内で完了し、連絡網と当日担当が確定する。

#### `P5-03` Go / No-Go と公開後監視

依存: `P5-02`

- [ ] §13 を全 owner が署名し、release / rollback authority を当日確認する。
- [ ] 公開直後の予約・問い合わせ・通知・請求・監査を業務担当と共同確認する。
- [ ] **DoD:** rollback window 終了まで heightened monitoring を行い、正式に通常運用へ移管する。

## 4. 機能 E2E 受入マトリクス

| ID | 経路 | Blocker 受入条件 | 結果 / 証跡 |
|---|---|---|---|
| `E2E-01` | 匿名: 検索 → 詳細 → quote → 最終確認 → 予約 | server 金額・空き再検証、文書版証跡、1 reservation、確認通知 | [ ] ______ |
| `E2E-02` | guest 照会 / 取消 | view tokenは期限内再利用、再発行/取消で旧token失効、cancel tokenは一回使用。URL/log非露出、取消規定・audit・通知が一致 | [ ] ______ |
| `E2E-03` | 会員登録 → verify → login → 本人予約 | email 未確認は保護操作不可、本人データのみ、logout 後 session 無効 | [ ] ______ |
| `E2E-04` | 会員の予約履歴 / point / coupon | 他会員を参照不可、台帳と残高一致、retry で二重処理なし | [ ] ______ |
| `E2E-05` | 問い合わせ → routing → 返信 | durable 受付、拠点担当、internal note 非公開、配信状態・SLA 可視化 | [ ] ______ |
| `E2E-06` | staff 貸出 → 返却 | AAL2、scope、state machine、reason、row version、audit | [ ] ______ |
| `E2E-07` | 整備 block / closure | 重複予約を許さず、既存予約への影響が警告・監査される | [ ] ______ |
| `E2E-08` | invoice 発行 → 入金 → reversal / void | line / 税 / total 一致、append-only、権限・理由・監査 | [ ] ______ |
| `E2E-09` | 通知 provider 障害 | 業務 transaction は確定、outbox retry / DLQ / alert、偽の送信済み表示なし | [ ] ______ |
| `E2E-10` | 退会 / privacy request | 本人確認、法定保持と削除を分離、期限内処理、audit | [ ] ______ |
| `E2E-11` | 貸渡開始 → 貸渡証交付 → 返還 | 法定貸渡簿snapshot、借受人への交付、全運転者への携行・提示指示（対象/方法/server時刻）、一人でも未指示なら出発拒否、再発行、走行距離・事故、免許PII制限、2年保持 | [ ] ______ |
| `E2E-12` | 年次法定報告 | 対象期間に報告対象だった全配置事務所の4/1〜3/31について、車種区分別の車両数・延貸渡回数・延貸渡日車数・延走行キロ・総貸渡料金（該当時はカーシェア内訳）と、3/31時点の事務所名・所在地・車種区分別台数を現行様式へ出力。基準日後の改名/移転/開閉/車両移管/廃車で過去snapshotが変わらず、部分生成拒否、集計/file hash固定、5/31提出/受理証跡 | [ ] ______ |
| `E2E-13` | marketing同意 → 配信 → login不要停止 | 3フォームで既定OFF、ONだけ配信可、文書版/時刻/evidence保存、transaction通知は継続、token再送は冪等、停止後送信0、明示的な再同意だけで再開 | [ ] ______ |

## 5. セキュリティ・認可受入マトリクス

判断 I の permission 表を正とする。下表は最低境界であり、I で狭めることはできるが、法務・セキュリティ再レビューなしに広げない。

| Subject / role | 許可の最低境界 | 必ず拒否する例 | 結果 / 証跡 |
|---|---|---|---|
| anonymous | 公開 catalog、quote、予約作成、所有 token 付き guest 操作 | admin、`/me`、他 guest、full PII、invoice | [ ] ______ |
| member | 自分の profile・予約・point / coupon・許可された invoice / inquiry | 他 member、client 指定 member ID、staff API | [ ] ______ |
| viewer | 許可 scope の mask 済み read | mutation、full PII、export、権限変更 | [ ] ______ |
| maintenance | 許可拠点の asset・整備・必要最小限の予定 | 顧客 full PII、請求・入金、会員、他拠点 | [ ] ______ |
| store_staff | 許可拠点の予約・貸渡・問い合わせと業務上必要な PII | accounting / role 管理、無理由 export、他拠点 | [ ] ______ |
| accounting | 許可された invoice / payment / 必要最小限の請求先 | fleet 変更、免許情報、role 管理、他 scope | [ ] ______ |
| admin | 承認済み全拠点管理、role 管理 | audit 物理削除、MFA 回避、無監査 full PII access | [ ] ______ |
| system / worker | 単一用途の限定 RPC / queue 処理 | 対話 login、任意 table、任意 tenant / location | [ ] ______ |

- [ ] `SEC-01` 未認証は 401、認証済み権限不足は 403、存在秘匿が必要な object は一貫した 404 を返す。
- [ ] `SEC-02` ID を連番・他人 ID・他拠点 ID に変更しても read / write / export できない。
- [ ] `SEC-03` role / permission / location を client claim や request body だけから信用しない。
- [ ] `SEC-04` 降格、disable、password reset、MFA reset 後に refresh / existing session で旧権限を使えない。
- [ ] `SEC-05` state-changing Cookie 認証 request は CSRF 防御、Bearer は安全な保存と CORS 制限を持つ。
- [ ] `SEC-06` login、guest token、問い合わせ、予約、password reset に個別 rate limit と abuse alert がある。
- [ ] `SEC-07` error、access log、trace、analytics、URL、email event に password、secret、token、免許番号、full contact がない。
- [ ] `SEC-08` production service credential は rotation 済みで、利用箇所・owner・期限が inventory 化される。
- [ ] `SEC-09` deny event と full PII access / export を actor、purpose、scope、result 付きで検索できる。
- [ ] `SEC-10` audit table の update / delete を通常 admin と app role の双方で拒否する。

## 6. 予約競合・transaction・冪等受入マトリクス

| ID | 試験 | 期待結果 | 結果 / 証跡 |
|---|---|---|---|
| `CON-01` 同じ asset / 同じ時間へ 2 request を同時送信 | 1 件だけ成功、他方は conflict。占有行は 1 件 | [ ] ______ |
| `CON-02` 同じ asset へ 20〜100 並行 request | 成功数が物理 capacity を超えず、deadlock retry が bounded | [ ] ______ |
| `CON-03` `A.end_at == B.start_at` | 半開区間のため両方成功 | [ ] ______ |
| `CON-04` 1 分でも重複、buffer と重複 | conflict | [ ] ______ |
| `CON-05` maintenance / closure と予約を同時作成 | commit 順に一方だけ成功し、他方 conflict | [ ] ______ |
| `CON-06` 非占有状態への取消完了後 | 規定どおり空きへ戻る。履歴・取消料は残る | [ ] ______ |
| `CON-07` transaction 中に consent / outbox / audit 書込を強制失敗 | reservation / allocation / coupon 等も全 rollback | [ ] ______ |
| `CON-08` client price / discount / tax / invoiceAllowed 改ざん | server 再計算または拒否。改ざん値は保存しない | [ ] ______ |
| `IDEM-01` 同じ subject・key・payload を retry | 同じ status / resource / business result。重複行なし | [ ] ______ |
| `IDEM-02` 同じ key、異なる payload | conflict、先の結果を変更しない | [ ] ______ |
| `IDEM-03` 別 member / 別 anonymous scope が同じ key | 相互に衝突・結果漏えいしない | [ ] ______ |
| `IDEM-04` response 前に connection 切断し retry | 最大 1 回の業務効果、結果を安全に再取得 | [ ] ______ |
| `IDEM-05` outbox worker を commit 前後で kill | event 欠落なし、provider の二重副作用なし | [ ] ______ |
| `LOCK-01` 同じ row version で 2 staff が更新 | 1 件成功、他方 precondition / conflict。silent overwrite なし | [ ] ______ |
| `PRICE-01` quote 後に価格 revision を publish | 期限・判断 D どおり再 quote または旧 snapshot。混在計算なし | [ ] ______ |

## 7. PII・privacy・監査受入マトリクス

| ID | Blocker 受入条件 | 結果 / 証跡 |
|---|---|---|
| `PII-01` | data inventory に項目、目的、法的根拠 / 同意要否、source、閲覧 role、委託先、保持、削除がある | [ ] ______ |
| `PII-02` | 予約・会員・問い合わせ form は送信前に具体的利用目的を表示し、一操作以内で privacy を開ける | [ ] ______ |
| `PII-03` | 免許番号は個人識別符号として保護し、判断 H がなければ予約時に収集せず貸渡時の必要最小限にする | [ ] ______ |
| `PII-04` | list / search / notification / audit は mask 値、full 値は必要 permission + AAL2 + purpose + audit | [ ] ______ |
| `PII-05` | DB / object storage / backup は暗号化され、key / secret / access が分離される | [ ] ______ |
| `PII-06` | 委託先・再委託先の選定、契約、安全管理、incident 通知、削除 / return、監査可能性を確認済み | [ ] ______ |
| `PII-07` | 外国事業者・国外 access / storage の有無を data flow で確認し、必要な同意 / 情報提供 / 継続確認を P で承認 | [ ] ______ |
| `PII-08` | 開示、訂正、利用停止、削除、第三者提供停止、苦情の受付と本人確認を過剰収集なしで完遂できる | [ ] ______ |
| `PII-09` | retention job が legal hold を尊重し、期限到来データを削除 / anonymize し、件数と失敗を監査する | [ ] ______ |
| `PII-10` | backup 内削除は retention expiry と restore 後再適用手順を privacy 文書・runbook と一致させる | [ ] ______ |
| `PII-11` | reportable breach の判定、PPC 等への速報 / 確報、本人通知、委託先連携の table-top を実施 | [ ] ______ |
| `PII-12` | consent / confirmation evidence は改ざん検知でき、過去の適用文書本文を hash / version から再現できる | [ ] ______ |

## 8. 日本法務・公開表示・同意受入マトリクス

### 8.1 必須または Blocker

| ID | 区分 | 受入条件 | 結果 / 証跡 |
|---|---|---|---|
| `LGL-01` | 事業許可 | 道路運送法第80条の自家用自動車有償貸渡許可を取得し、会社、主たる事務所、配置事務所、対象車種が実運用と一致 | [ ] ______ |
| `LGL-02` | 届出 | 実施する貸渡料金・貸渡約款と変更内容が管轄運輸支局へ必要どおり届出済み。公開版と content diff が 0 | [ ] ______ |
| `LGL-02A` | 自動車保険 | 全貸渡車両が公開日時点の許可条件を満たす保険へ加入し、実保険証券と公開する補償・免責・適用除外が一致。現行通達の基準（対人1名8,000万円以上、対物1事故200万円以上、搭乗者1名500万円以上）を下回らず、管轄運輸支局へ最新条件を再確認 | [ ] ______ |
| `LGL-03` | 貸渡条件 | 貸渡料金・約款、および「貸渡しに付随した運転者の紹介・あっせんを行わない」旨を、許可条件に沿う方法で明示 | [ ] ______ |
| `LGL-04` | 重要事項（内部 Blocker） | 国交省通達の指導事項（明示するよう努める事項）を本番公開の内部 Blocker とし、貸渡前に損害賠償 / NOC、保険・補償の範囲と条件、事故・故障・盗難、違法駐車、返還遅延を認識可能に表示 | [ ] ______ |
| `LGL-05` | 法定記録 | 貸渡簿の必須項目を貸渡終了から2年保存する。レンタカー型カーシェアリングに該当しない貸渡しでは、貸渡証を所定事項・注意事項付きで書面または電磁的方法により交付し、運転者へ携行を指示 | [ ] ______ |
| `LGL-05A` | 年次報告 | 管轄運輸支局へ現行様式を確認し、前年4月1日〜当年3月31日の貸渡実績報告書と、3月31日時点の事務所別車種別配置車両数一覧表を生成・照合し、主たる事務所所在地を管轄する運輸支局長へ毎年5月31日までに提出した証跡と受領証跡を運用できる | [ ] ______ |
| `LGL-06` | 特商法広告 | B2C Web 予約を通信販売として扱うかを P で確定し、適用時は名称、住所、確実な電話、責任者、税込価格・追加負担、支払、提供時期、申込期限、取消を容易に到達できる場所へ表示 | [ ] ______ |
| `LGL-07` | 最終確認 | 申込直前に、台数 / 貸渡期間、税込総額、支払時期・方法、提供日時・店舗、申込期限があれば期限、取消・解除条件 / 方法を一覧表示 | [ ] ______ |
| `LGL-08` | 誤操作防止 | CTA が有償予約の申込みだと明確で、内容を容易に確認・訂正できる。「次へ」「送信」だけで確定させない | [ ] ______ |
| `LGL-09` | 成立時点 | 「申込受付」「予約成立」「貸渡契約成立」を区別し、承諾主体・通知・取消料発生時点を画面、メール、約款、DB 状態で一致 | [ ] ______ |
| `LGL-10` | 取消料 | 取消時期ごとの料金が平均的損害を超えない算定根拠を保存し、問い合わせ時に説明できる。事業者の責任を全部免除する条項を置かない | [ ] ______ |
| `LGL-11` | 利用目的 | 予約・会員・問い合わせで直接取得する PII の具体的利用目的を、送信前に本人へ明示 | [ ] ______ |
| `LGL-12` | privacy 公表 | 名称・住所・代表者、全利用目的、開示等手続 / 手数料、安全管理措置、苦情窓口を本人が知り得る状態に置く。認定個人情報保護団体の対象事業者である場合は団体名と苦情解決申出先も公表 | [ ] ______ |
| `LGL-13` | 提供・委託 | 第三者提供、委託、共同利用、外国移転、cookie / 個人関連情報の実 data flow と文書が一致し、必要な同意・確認・記録を実施 | [ ] ______ |
| `LGL-14` | 文書組入れ | 貸渡約款を契約内容とする旨を申込前に表示し、全文を容易に閲覧・保存可能にする。条文版と同意証跡を保存 | [ ] ______ |

### 8.2 条件付き・強く推奨

| ID | 条件 | 受入条件 | 結果 / 証跡 |
|---|---|---|---|
| `LGL-C01` | 電話等を省略する場合 | 法第11条ただし書の適用を法務承認し、全省略事項を申込判断前に遅滞なく書面 / 電磁的記録で返せる請求経路と SLA を実証。通常は確実につながる電話の直接表示を推奨 | [ ] / N/A ______ |
| `LGL-C02` | 許可番号のサイト表示 | 一律の Web 表示義務は今回の一次資料で確認できていない。管轄運輸支局・法務が必要と判断した場合に正式番号を表示し、推測値を掲載しない | [ ] / N/A ______ |
| `LGL-C03` | 外部送信規律の対象 service を提供する場合 | 送信情報、送信先事業者名、双方の利用目的を通知 / 公表、同意、または適法な opt-out で確認機会を付与 | [ ] / N/A ______ |
| `LGL-C04` | 通常の来店予約 site | 総務省 FAQ では自己需要の来店予約 page は原則対象外だが、第三者 tag / SDK を inventory 化し privacy / 個人関連情報の要件を別途確認 | [ ] ______ |
| `LGL-C05` | analytics / 広告 | 非必須 tag は目的・送信先・保持を表示し、provider の結合利用、国外移転、他法域に応じ consent manager を採否決定 | [ ] / N/A ______ |
| `LGL-C06` | marketing email | 取引通知と分離した事前opt-in、既定OFF、login不要unsubscribe、suppressionを実装し、適用時は承諾 / 請求記録を最後の広告送信から3年保存。採用しない場合は入力・文書・送信をすべて無効化 | [ ] / N/A ______ |
| `LGL-C07` | オンライン前払い導入時 | 特商法13条の適用を法務確認し、事業者の名称・住所・電話、受領額 / 日、申込み対象役務の種類 / 数量、予約諾否、承諾時の提供時期、不承諾時に直ちに返金する旨と方法を通知・保存できるよう実装 | [ ] / N/A ______ |
| `LGL-C08` | card 決済導入時 | PSP hosted / token で card 非保持、加盟店のカード番号適切管理・不正利用防止、3-D Secure、二重課金 / 返金を受入 | [ ] / N/A ______ |

### 8.3 法務文書の具体的な公開前確認

- [ ] `law.html`: 登記上の名称、現に活動する住所、責任者、連絡可能な電話 / 適法な省略手続、実売価格、全追加料金、支払、提供、取消が P と一致する。
- [ ] `clause.html`: 北海道運輸局の参考様式を出発点に、事業実態へ合わせた届出版であり、制定・施行日、保険限度、NOC、取消、個人情報、連絡先が空欄でない。
- [ ] `insurance.html`: 実契約の保険証券・補償制度と、対人 / 対物 / 車両 / 搭乗者、免責、適用除外、NOC が一致する。
- [ ] `privacy.html`: demo / `localStorage` の説明を本番版から除き、実 vendor、保存場所、保持、国外取扱い、安全管理、請求窓口を記載する。
- [ ] 全公開文書: version、施行日、旧版、変更履歴、問い合わせ先、相互 link があり、404 / 仮文言 / 矛盾がない。
- [ ] 日本語を正本とし、英訳がある場合は重要条件・金額・日付・優先言語の意味が一致する。

## 9. 移行受入マトリクス

| ID | Blocker 受入条件 | 結果 / 証跡 |
|---|---|---|
| `MIG-01` | source ごとに owner、抽出日時、件数、checksum、PII 分類、正本性を記録 | [ ] ______ |
| `MIG-02` | old ID → new ID、timezone、status、金額、税、取消、member、重複の mapping 表を承認 | [ ] ______ |
| `MIG-03` | 必須値欠落・不正期間・孤児 FK・重複 email 等を勝手に補わず reject report へ出す | [ ] ______ |
| `MIG-04` | import は batch ID と natural / source key で冪等。再実行後の件数・金額が不変 | [ ] ______ |
| `MIG-05` | source / target の予約件数、占有、会員、point、coupon、invoice、payment、総額を照合 | [ ] ______ |
| `MIG-06` | sample 全件照合 + 高リスク項目全件照合を業務 owner が署名 | [ ] ______ |
| `MIG-07` | 旧平文 password を移行せず、reset / invite flow を使う | [ ] ______ |
| `MIG-08` | 読取専用化、最終差分、切替、rollback、旧 source の保持 / 安全廃棄を rehearsal | [ ] ______ |
| `MIG-09` | 移行中・移行後に同一 asset の重複予約が存在しない DB query 証跡がある | [ ] ______ |
| `MIG-10` | `localStorage` デモデータは正式 source と明示承認された場合を除き、本番へ取り込まない | [ ] ______ |

## 10. バックアップ・復元、RPO / RTO

以下は判断 O の承認前提となる暫定案である。より緩い値へ変更する場合は、停止中の電話 / 手作業受付、再入力、顧客連絡、損失上限を事業側が明記して承認する。

| tier | 対象 | RPO 案 | RTO 案 | 最低検証頻度 |
|---|---|---:|---:|---:|
| Tier 1 | reservation、allocation、payment、invoice、consent、audit、outbox | 15分以内 | 4時間以内 | 四半期ごと + 重大変更前 |
| Tier 2 | master、pricing draft、設定、template、content | 24時間以内 | 8時間以内 | 半期ごと |
| Tier 3 | 再生成可能な cache / search index | 24時間以内 | 24時間以内 | release ごとの再生成試験 |

- [ ] `BAK-01` point-in-time または同等の log backup が Tier 1 RPO を満たす。
- [ ] `BAK-02` daily backup は暗号化・別 access boundary で 35 日以上保持するか、O で代替を承認する。
- [ ] `BAK-03` backup job 成否だけでなく restore 可能性を checksum / 定期 restore で確認する。
- [ ] `BAK-04` production へ上書きせず isolated project へ、指定時点を restore できる。
- [ ] `BAK-05` restore 後に migration version、FK / exclusion、RLS、Auth link、件数、金額、主要 E2E を検証する。
- [ ] `BAK-06` secret、provider webhook、DNS、scheduled job、queue 等、DB 外の復旧手順がある。
- [ ] `BAK-07` retention 期限後に backup が消えること、restore 後に deletion / suppression を再適用することを確認する。
- [ ] `BAK-08` 実測 `障害時点 / 最新復元時点 / 復元開始 / 業務再開` を記録し、RPO / RTO 内である。
- [ ] `BAK-09` ransomware / credential compromise 時に clean credential と clean artifact から復元できる。
- [ ] `BAK-10` 予約停止中の手作業受付、復旧後照合、二重予約防止の業務継続手順を rehearsal する。

## 11. 監視・運用受入マトリクス

### 11.1 最低限の監視

| ID | signal | alert / dashboard 受入 | 結果 / 証跡 |
|---|---|---|---|
| `OBS-01` public / admin / API availability | 外形監視、TLS / DNS 期限、地域別失敗 | [ ] ______ |
| `OBS-02` latency / error | route / status / release 別 p50 / p95 / p99、5xx、timeout | [ ] ______ |
| `OBS-03` booking | create 成功 / validation / conflict / rollback、異常な 0 件・急増 | [ ] ______ |
| `OBS-04` idempotency / DB | key conflict、deadlock、lock wait、connection、replication / backup lag | [ ] ______ |
| `OBS-05` Auth / security | login failure、MFA failure、rate limit、deny、role change、full PII / export | [ ] ______ |
| `OBS-06` outbox / email | oldest age、retry、DLQ、bounce、complaint、provider outage | [ ] ______ |
| `OBS-07` business reconciliation | 予約と allocation、invoice と payment、point / coupon 台帳の不一致 | [ ] ______ |
| `OBS-08` privacy / retention | deletion job、privacy request SLA、失敗件数、legal hold | [ ] ______ |
| `OBS-09` backup | backup age、失敗、checksum、前回 restore 日、実測 RPO / RTO | [ ] ______ |
| `OBS-10` frontend | JS error、Core Web Vitals、form abandonment。ただし PII / token を送らない | [ ] ______ |

### 11.2 Incident / change 運用

- [ ] severity 1〜4 の定義、24時間連絡先、ack / escalation、decision authority がある。
- [ ] booking 競合制御停止、PII 漏えい、admin takeover、決済 / invoice 誤り、通知消失、backup 失敗の runbook がある。
- [ ] PII incident は封じ込めと並行して、個人情報保護法上の報告対象 / 本人通知を所定 owner が判断する。
- [ ] log / trace / support ticket に PII を貼り付けない scrub と access control がある。
- [ ] deploy には release ID、actor、承認、migration、feature flag、rollback point が残る。
- [ ] emergency change は事後 1 営業日以内に review し、恒久対応期限を付ける。
- [ ] Critical incident は blameless postmortem、再発防止 owner、期限、検証まで close しない。

## 12. Browser・accessibility・品質受入

### 12.1 対応環境

- [ ] desktop: Chrome / Edge / Firefox の最新2安定版、macOS Safari の最新2安定版。
- [ ] mobile: iOS Safari の current / current-1、Android Chrome の current / current-1。
- [ ] viewport: 320 CSS px、375、768、1024、1440 で横 scroll・重なり・操作不能がない（意図した表 scroll を除く）。
- [ ] 低速回線、API timeout、offline 復帰、二重 tap、back / reload でも二重予約・誤完了表示がない。

### 12.2 WCAG 2.2 AA を目標とする Blocker

- [ ] 全操作を keyboard のみで完遂でき、focus 順と visible focus が適切。
- [ ] label、fieldset / legend、required、error summary、field error が programmatically associated。
- [ ] 色だけに依存せず、通常 text / UI component の contrast を満たす。
- [ ] heading、landmark、page title、language、link / button name が意味的に正しい。
- [ ] modal / drawer は focus trap、Escape、focus return、screen reader name を持つ。
- [ ] dynamic quote、availability、error、完了は適切な live region で通知し、過剰読上げしない。
- [ ] timeout / hold expiry は事前通知と延長手段を持つ。認証再入力時も入力済み内容を不必要に失わない。
- [ ] 200% zoom と text spacing 変更で情報・操作が欠落しない。
- [ ] axe 等の automated test で Critical / Serious 0。VoiceOver + Safari、NVDA + Firefox / Chrome の主要 journey を手動確認。

### 12.3 最終確認画面固有

- [ ] mobile の CTA より前に重要条件を認識でき、sticky CTA が取消条件を隠さない。
- [ ] 総額は税込で内訳と一致し、追加必須料金を後出ししない。
- [ ] 車両 / class、台数、貸渡・返却日時 / 拠点、option、支払、取消を個別に変更できる。
- [ ] 同意 checkbox は初期 off。文書 link は新規 tab を強制せず、戻っても入力・選択を保持する。
- [ ] `aria-disabled` だけに頼らず server も未確認 / 不正 request を拒否する。

## 13. Go / No-Go

### 13.1 Go 条件

- [ ] A〜P が owner・承認日付きで確定し、P の法務・運輸支局確認が完了。
- [ ] Phase 0〜5 の全 Blocker と §4〜§12 の Blocker が完了。
- [ ] Critical / High の defect・security finding・data mismatch が 0。
- [ ] production 相当で競合、冪等、権限逸脱、PII mask、通知 retry、migration、restore を再実行済み。
- [ ] 実測 RPO / RTO が O の承認値内。
- [ ] 本番の会社情報、電話、許可・届出、料金、約款、取消、保険、privacy と実装が一致。
- [ ] dashboard、alert、on-call、業務継続、rollback、顧客連絡 template が有効。
- [ ] 公開直前 backup と rollback point が確認済み。
- [ ] 事業、開発、セキュリティ、法務、運用の各 owner が署名。

### 13.2 即時 No-Go 条件

- [ ] **該当なし:** `localStorage`、平文 password、demo session、無認証 admin が production path に残る。
- [ ] **該当なし:** 競合試験で二重予約、capacity 超過、部分 commit が1件でも発生する。
- [ ] **該当なし:** 他人 / 他拠点データ、full PII、invoice、export へ権限外 access できる。
- [ ] **該当なし:** 予約金額・取消料・約款・保険・事業者情報が承認済み P と不一致。
- [ ] **該当なし:** 最終確認6項目、訂正手段、利用目的の送信前明示、同意版証跡のいずれかが欠ける。
- [ ] **該当なし:** 問い合わせ / 通知を保存・配信していないのに成功 / 送信済みと表示する。
- [ ] **該当なし:** backup がない、restore 未実施、RPO / RTO 未承認または未達。
- [ ] **該当なし:** Critical / High vulnerability、未解決の migration 不一致、rollback 不成立がある。

### 13.3 署名

| 役割 | 氏名 | 判定 | 日時 | 証跡 / 条件 |
|---|---|---|---|---|
| 事業責任者 |  | Go / No-Go |  |  |
| 開発責任者 |  | Go / No-Go |  |  |
| セキュリティ / privacy |  | Go / No-Go |  |  |
| 法務確認者 |  | Go / No-Go |  |  |
| 運用責任者 |  | Go / No-Go |  |  |

## 14. 一次資料（法務受入の根拠）

確認日: 2026-09-16。改正・所管庁の最新案内を公開前に再確認する。

| 分野 | 一次資料 | 本書での扱い |
|---|---|---|
| レンタカー許可 | [北海道運輸局「レンタカー事業について」](https://wwwtb.mlit.go.jp/hokkaido/bunyabetsu/jidousya/index_00002.html) | 道路運送法に基づく許可が必要 |
| 許可条件・表示・記録 | [国土交通省通達「貸渡人を自動車の使用者として行う自家用自動車の貸渡し（レンタカー）の取扱いについて」](https://wwwtb.mlit.go.jp/hokkaido/content/000269958.pdf) | 料金 / 約款 / 運転者非供給の明示、貸渡簿2年、貸渡証、重要事項 |
| 貸渡約款 | [北海道運輸局「貸渡約款の設定・変更」](https://wwwtb.mlit.go.jp/hokkaido/shinseinavi.renta105.html) / [参考様式 DOCX](https://wwwtb.mlit.go.jp/hokkaido/content/000341612.docx) | 参考様式はそのまま法定の「標準約款」ではなく、実態に合わせ届出・確認する |
| 特定商取引法 | [e-Gov「特定商取引に関する法律」](https://laws.e-gov.go.jp/law/351AC0000000057) / [消費者庁 通信販売](https://www.no-trouble.caa.go.jp/what/mailorder/) | 広告表示、最終確認、誤認表示、広告メール |
| 最終確認画面 | [消費者庁「通信販売の申込み段階における表示についてのガイドライン」](https://www.caa.go.jp/policies/policy/consumer_transaction/specified_commercial_transactions/assets/consumer_transaction_cms101_2401119_03.pdf) | 6 項目、一覧性、明確な申込み、確認・訂正 |
| 電子契約 | [e-Gov「電子消費者契約に関する民法の特例に関する法律」](https://laws.e-gov.go.jp/law/413AC0000000095) | 操作ミスを防ぐ申込意思・内容の確認措置 |
| 定型約款 | [e-Gov「民法」第548条の2〜4](https://laws.e-gov.go.jp/law/129AC0000000089) | 約款を契約へ組み入れる表示と閲覧、相手方を一方的に害する条項 |
| 消費者契約 | [e-Gov「消費者契約法」](https://laws.e-gov.go.jp/law/412AC0000000061) / [消費者庁 逐条解説](https://www.caa.go.jp/policies/policy/consumer_system/consumer_contract_act/annotations) | 全部免責、平均的損害を超える取消料、不当条項 |
| 個人情報 | [個人情報保護委員会 ガイドライン（通則編）](https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/) | 送信前の利用目的明示、安全管理、委託監督、漏えい、保有個人データ公表 |
| 国外提供 | [個人情報保護委員会 ガイドライン（外国にある第三者への提供編）](https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/) | 国外 vendor / access の同意・情報提供・継続確認 |
| Cookie / 個人関連情報 | [個人情報保護委員会 Q&A](https://www.ppc.go.jp/personalinfo/faq/APPI_QA/) | Cookie 等の第三者提供先で個人データ化する場合の確認・同意 |
| 外部送信 | [総務省「外部送信規律 FAQ」](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00002.html) | 対象 service の確認機会。通常の来店予約 page は原則自己需要との公式例 |
| 将来の card 決済 | [経済産業省「クレジットカード・セキュリティガイドライン」関連資料](https://www.meti.go.jp/policy/economy/consumer/credit/) | card 情報適切管理、不正利用防止、非保持化の責任分界 |
