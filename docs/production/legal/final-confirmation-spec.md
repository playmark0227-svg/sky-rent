# 予約最終確認画面 実装仕様

状態: **実装仕様 / 表示文言と取引条件は公開前承認が必要**
対象route: `{{FINAL_CONFIRMATION_ROUTE}}`

## 1. 目的

予約申込みの直前に、顧客が取引条件を一覧で確認し、誤りを訂正し、申込み操作だと明確に理解できる画面を提供する。確認画面を単なる途中画面にせず、表示内容・適用文書・同意をserver側でsnapshot化する。

## 2. 画面に必ず表示する6区分

| 区分 | レンタカー予約での表示 |
|---|---|
| 1. 数量 | 車両クラス/車両、台数、option数量、運転者人数等 |
| 2. 対価 | 税込基本料金、option、割引、税、追加負担、合計。未確定費用は条件と算定式 |
| 3. 支払時期・方法 | 現地/online、支払日、利用可能手段、デポジット/与信、返金方法 |
| 4. 提供時期 | 借受/返還日時、営業所、営業時間、貸渡契約の成立時点 |
| 5. 変更・取消し | 期限別取消料、無断取消し、変更方法、返金、連絡先、NOC等へのリンク |
| 6. 申込期限 | quote/申込みの有効期限、期間限定条件。該当しない場合はその旨 |

加えて、予約者/運転者のmask済み連絡先、利用目的、車両条件、保険・補償/免責、燃料、特別条件を表示します。

## 3. 推奨レイアウト順

1. 「予約内容の最終確認」見出しと申込みである旨
2. 車両・台数・貸渡期間・営業所
3. 料金明細・税込総額・支払
4. 変更/取消し・NOC・保険補償の要点
5. 顧客/運転者情報（mask表示）
6. 貸渡約款、取消規定、privacyのリンクとversion
7. 任意の広告メール同意（既定OFF、申込同意から分離）
8. 「入力内容を修正する」リンク/ボタン
9. 確定CTA

sticky CTAを使う場合も、その直前または同一viewportで総額、提供時期、取消し要点を再表示し、詳細へ即時移動できるようにします。

## 4. 文言

- 見出し: 「予約内容の最終確認」
- 確定CTA: **「上記内容で予約を申し込む」**
- 戻るCTA: 「入力内容を修正する」
- 禁止例: 「送信」「次へ」「完了」だけで申込みだと判別できない表現

予約受付と貸渡契約成立が別の場合、CTA付近に `{{RESERVATION_LEGAL_EFFECT_PLAIN_LANGUAGE}}` を表示します。

## 5. 同意・確認

必須checkbox:

> [ ] 貸渡約款（`{{TERMS_VERSION}}`）と取消条件（`{{CANCELLATION_VERSION}}`）を確認し、この内容で予約を申し込みます。

privacyは、個人情報取得前の利用目的表示を行ったうえで「プライバシーポリシー（`{{PRIVACY_VERSION}}`）を確認しました」と明示します。包括的な同意だけで利用目的明示を代替しません。

広告メールは [広告メール同意](marketing-consent-template.md) の別checkbox（既定OFF）とし、必須同意へ束ねません。

## 6. 訂正・エラー・二重送信

- 各sectionに「変更」導線を置き、戻っても入力とquote IDを保持
- 戻った後は価格・在庫・文書versionを再検証し、変更点を差分表示
- quote失効、在庫競合、価格変更は確定前に止め、新旧を提示して再確認を要求
- CTA押下後は二重クリックを抑止するが、`Idempotency-Key` でserver側も再送安全にする
- validation errorは該当sectionとfieldへfocusし、入力を失わせない

## 7. Server snapshot

確定requestからserverが正規化したsnapshotを生成し、予約と同じtransactionで保存する。

```json
{
  "schemaVersion": "1",
  "quoteId": "...",
  "vehicleClassId": "...",
  "quantity": 1,
  "pickup": {"locationId": "...", "at": "..."},
  "return": {"locationId": "...", "at": "..."},
  "applicationDeadline": "quote expiry server time",
  "options": [],
  "price": {"currency": "JPY", "lines": [], "taxIncludedTotal": 0},
  "payment": {"method": "...", "timing": "..."},
  "cancellationSummary": "...",
  "legalDocuments": [
    {"type": "rental_terms", "version": "...", "contentHash": "..."},
    {"type": "cancellation", "version": "...", "contentHash": "..."},
    {"type": "privacy", "version": "...", "contentHash": "..."}
  ],
  "customerContactMasked": {},
  "locale": "ja-JP",
  "confirmedAt": "server time",
  "requestId": "..."
}
```

- canonical JSONのhashを保存し、予約受付後に内容を変更しない
- client送信の価格、割引、文書version、時刻を信頼せず再計算/再取得
- marketing同意は別eventとして同一transactionで記録
- 完了メールと予約詳細から、当時の条件・文書を再表示

## 8. Accessibility・responsive

- keyboardのみで確認・修正・同意・申込みが可能
- checkbox labelと文書リンクを別々に操作可能
- 合計とerrorをscreen readerへ通知
- 色だけで変更/警告を表さない
- 320px幅、200% zoom、長い日本語・英数字でも横scrollなし
- countdownだけに依存せず失効日時を文字で表示

## 9. E2E受入条件

- [ ] 6区分すべてがCTA前に表示される
- [ ] 税込総額、支払、提供日時、取消料をmobileで確認できる
- [ ] 全項目を訂正して戻れ、再確認なしに確定しない
- [ ] 適用した3文書のversion/content hashを予約から再現できる
- [ ] quote失効/在庫競合/価格変更で古い内容を確定できない
- [ ] 20並列の同一申込みが1予約だけを作る
- [ ] 広告同意OFFでも予約でき、ON/OFF両方の証跡が残る
- [ ] keyboard、screen reader、mobile viewport試験が合格
