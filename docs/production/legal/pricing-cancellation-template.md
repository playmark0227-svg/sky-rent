# 貸渡料金・取消し・保険補償テンプレート

状態: **草案 / 本番公開禁止**
文書種別: `pricing` / `cancellation`（1ページにまとめる場合も版を個別登録し、予約の確定料金は別snapshot保存）
版: `{{DOCUMENT_VERSION}}` / 施行日: `{{EFFECTIVE_AT}}`

> 金額・税・時間帯・適用条件をすべて許可/届出・料金DBの実値で埋め、同じfixtureで画面とAPIを検証してください。記載のない費用を予約確定後に追加しないでください。

## 1. 料金の基本

- 通貨: JPY
- 税表示: `{{TAX_INCLUDED_OR_EXCLUDED}}`（顧客向け総額は税込表示）
- 料金計算単位と端数処理: `{{RATE_UNIT_AND_ROUNDING}}`
- 料金が確定する時点: `{{PRICE_LOCK_POINT}}`
- 見積有効期限: `{{QUOTE_TTL_MINUTES}}` 分
- 支払時期・方法: `{{PAYMENT_TIMING_AND_METHODS}}`

| 車両クラス | 通常料金 | 繁忙期 | 超過 | 含まれるもの | version |
|---|---:|---:|---:|---|---|
| `{{VEHICLE_CLASS}}` | `{{BASE_PRICE_TAX_INCLUDED}}` | `{{HIGH_SEASON_RULE}}` | `{{OVERTIME_PRICE}}` | `{{INCLUDED_ITEMS}}` | `{{PRICING_REVISION}}` |

## 2. 追加料金

| 項目 | 税込額/計算式 | 適用条件 | 上限・例外 |
|---|---:|---|---|
| オプション | `{{OPTION_PRICE}}` | `{{OPTION_CONDITION}}` | `{{OPTION_LIMIT}}` |
| 乗捨て | `{{ONE_WAY_FEE}}` | `{{ONE_WAY_CONDITION}}` | `{{ONE_WAY_LIMIT}}` |
| 燃料/充電 | `{{REFUEL_PRICE}}` | `{{REFUEL_CONDITION}}` | `{{REFUEL_LIMIT}}` |
| 延長・遅延 | `{{LATE_FEE}}` | `{{LATE_CONDITION}}` | `{{LATE_LIMIT}}` |
| 配車/回送等 | `{{DELIVERY_FEE}}` | `{{DELIVERY_CONDITION}}` | `{{DELIVERY_LIMIT}}` |

保証金、デポジット、カード与信枠がある場合: `{{DEPOSIT_AND_AUTHORIZATION}}`。徴収・解除時期と返金方法を明示します。

## 3. 予約変更・取消し

変更と取消しは `{{CANCELLATION_CHANNELS}}` から受け付け、当社が受信した時刻（Asia/Tokyo）を基準にします。

| 取消しが受け付けられた時点 | 取消手数料（税込） | 上限 | 備考 |
|---|---:|---:|---|
| `{{PERIOD_1}}` | `{{FEE_1}}` | `{{CAP_1}}` | `{{NOTE_1}}` |
| `{{PERIOD_2}}` | `{{FEE_2}}` | `{{CAP_2}}` | `{{NOTE_2}}` |
| `{{PERIOD_3}}` | `{{FEE_3}}` | `{{CAP_3}}` | `{{NOTE_3}}` |
| 無断取消し | `{{NO_SHOW_FEE}}` | `{{NO_SHOW_CAP}}` | `{{NO_SHOW_DEFINITION}}` |

- 日数・時刻の数え方: `{{CANCELLATION_TIME_CALCULATION}}`
- 予約変更を取消し扱いにする条件: `{{CHANGE_AS_CANCELLATION}}`
- 悪天候、公共交通機関停止、災害等の特例: `{{EXCEPTION_POLICY}}`
- 当社都合で提供できない場合: `{{OPERATOR_CANCELLATION}}`
- 取消し可能な最終時点と連絡先: `{{CANCELLATION_DEADLINE_AND_CONTACT}}`

## 4. 返金

- 返金対象: `{{REFUND_ELIGIBILITY}}`
- 返金方法: `{{REFUND_METHOD}}`
- 当社処理期限: `{{REFUND_PROCESSING_DAYS}}`
- 決済事業者/金融機関による反映の目安: `{{REFUND_POSTING_ESTIMATE}}`
- 手数料負担: `{{REFUND_FEES}}`
- 一部利用後の精算: `{{PARTIAL_USE_REFUND}}`

返金額・理由・元取引・処理日時を台帳へ保存し、支払取消しと返金を区別します。

## 5. 保険・補償

| 補償 | 限度額 | 免責額 | 主な対象外 |
|---|---:|---:|---|
| 対人 | `{{BODILY_INJURY_LIMIT}}` | `{{BODILY_INJURY_DEDUCTIBLE}}` | `{{BODILY_INJURY_EXCLUSIONS}}` |
| 対物 | `{{PROPERTY_DAMAGE_LIMIT}}` | `{{PROPERTY_DAMAGE_DEDUCTIBLE}}` | `{{PROPERTY_DAMAGE_EXCLUSIONS}}` |
| 車両 | `{{VEHICLE_DAMAGE_LIMIT}}` | `{{VEHICLE_DAMAGE_DEDUCTIBLE}}` | `{{VEHICLE_DAMAGE_EXCLUSIONS}}` |
| 人身傷害等 | `{{PERSONAL_INJURY_LIMIT}}` | `{{PERSONAL_INJURY_DEDUCTIBLE}}` | `{{PERSONAL_INJURY_EXCLUSIONS}}` |

- 保険会社・保険商品/証券情報: `{{INSURANCE_DETAILS}}`
- 免責補償制度の料金・免除範囲: `{{CDW_DETAILS}}`
- 補償が適用されない行為・条件: `{{COVERAGE_EXCLUSIONS}}`
- ロードサービス: `{{ROADSIDE_ASSISTANCE}}`

## 6. NOC・休車損害等

| 状況 | NOC等の税込額/算定 | 適用条件 |
|---|---:|---|
| 自走して予定営業所へ返還 | `{{NOC_DRIVABLE}}` | `{{NOC_DRIVABLE_CONDITION}}` |
| 自走不能/予定外返還 | `{{NOC_NON_DRIVABLE}}` | `{{NOC_NON_DRIVABLE_CONDITION}}` |
| その他実費 | `{{OTHER_DAMAGE_CHARGES}}` | `{{OTHER_DAMAGE_CONDITION}}` |

NOCが保険・車両免責・修理費と別であること、免除商品がある場合の範囲、重複徴収しないルールを明示します。

## 7. 表示・テスト要件

- 検索結果、見積、予約入力、最終確認、完了メールで同一revisionを使用
- 最終確認で基本料金、option、割引、税、追加負担、総額を分解表示
- 取消料を具体的な金額または計算式で申込前に表示
- price snapshotへ各line、根拠revision、税/端数、通貨、hashを保存
- 承認fixtureで通常日、繁忙期、日跨ぎ、延長、取消境界時刻をE2E確認
