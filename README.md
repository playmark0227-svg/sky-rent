# グロースレンタカー

北海道 北見・釧路のレンタカー / キッチンカー **予約サイト & 管理システム**。
素の HTML/CSS/JS (ビルド不要・GitHub Pages で配信) と、本番のバックエンドとして [Supabase](https://supabase.com/) を使います。

- 予約サイト: https://playmark0227-svg.github.io/sky-rent/
- 管理画面: https://playmark0227-svg.github.io/sky-rent/manage/dashboard.html
- ドキュメント: https://playmark0227-svg.github.io/sky-rent/docs/

## デモモードと本番モード

同じ画面のコードが、`js/config.js` の設定によって2通りに動きます。

| | デモモード | 本番モード |
|---|---|---|
| 切り替え | `js/config.js` の `SUPABASE_URL` が空 (現在の公開版) | `SUPABASE_URL` と `SUPABASE_ANON_KEY` を設定 |
| データの置き場所 | 閲覧している人のブラウザ内 (localStorage)。端末ごとに別々 | Supabase (Postgres・東京リージョン)。予約・会員などの業務データはブラウザに保存しない |
| 会員・スタッフのログイン | デモ用の簡易ログイン | Supabase Auth。会員はメール確認あり、スタッフは二段階認証 (TOTP) 必須 |
| 二重予約の防止 | 同じブラウザ内だけ | データベースの排他制約で拒否 |
| 料金 | 画面で計算 | サーバーが同じ計算コード (`js/pricing-core.js`) で再計算した額だけを保存 |
| メール | 送信しない (画面内の記録のみ) | Resend で実際に送信し、送信状況を記録・再送 |
| Google カレンダー | 使わない | 担当者の予定で受け渡しの可否を判定し、予約を担当者のカレンダーに書き込む |
| 用途 | 画面確認・営業デモ | 実運用 |

> [!WARNING]
> デモモードは本番システムではありません。実在するお客様の氏名・連絡先・免許情報・予約・請求情報を入力しないでください。

### ドキュメント (本番化)

- **[本番環境の立ち上げ手順書](docs/production/setup.md)** — 事業者向け。Supabase・メール (Resend)・Google カレンダー連携・管理者作成・公開前チェックリスト
- **[本番実装 v1 実装契約書](docs/production/implementation-v1.md)** — 開発者向け。API・データの形・画面の挙動の約束
- [現状監査](docs/production/current-state-audit.md) — デモの問題点と、この実装での対応状況 (§10)
- [本番化実装ハンドオフ](docs/production/README.md) / [データモデル](docs/production/data-model.md) / [OpenAPI](docs/production/openapi.yaml) / [受入基準](docs/production/acceptance.md)

## 開発者向け: ローカルで動かす

詳しくは [手順書 11章](docs/production/setup.md#11-ローカル開発環境の起動方法-開発者向け)。

```bash
# デモモードだけ確認する (Supabase 不要)
npx --yes http-server . -p 8901 -a 127.0.0.1 -c-1      # → http://127.0.0.1:8901/

# 本番モードをローカルの Supabase で確認する
colima start                                            # Docker 実行環境
supabase start                                          # DB・Auth・Mailpit (migrations と seed を適用)
supabase functions serve --env-file supabase/functions/.env.local   # .env.example をコピーして値を埋める
npm install
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY='<supabase status の値>' \
  node scripts/create-admin.mjs --email admin@example.com --name 管理者 --password 'Admin-Pass-2026'
```

ブラウザで http://127.0.0.1:8901/ を開き、開発者ツールのコンソールで
`localStorage.setItem('sky-rent.configOverride', JSON.stringify({SUPABASE_URL:'http://127.0.0.1:54321', SUPABASE_ANON_KEY:'<ANON_KEY>'}))`
を実行して再読み込みすると、ローカルの Supabase につながります (`localhost` / `127.0.0.1` のときだけ有効)。
ローカルで送られたメールは Mailpit (http://127.0.0.1:54324) で確認できます。

```bash
npm test               # 料金計算などの自動テスト (tests/*.test.mjs) + 共用ファイルの一致確認
npm run sync-shared    # js/pricing-core.js を直したら Edge Functions 側へコピー
npm run test:db        # DB の権限 (RLS)・業務ロジックのテスト (supabase test db。ローカル Supabase 起動中に)
```

## 主な機能

### 予約サイト (公開)
- **空き検索**: 日時・拠点 (北見/釧路)・カテゴリで空きを検索。カテゴリ固有の絞り込み (ボディタイプ・駆動方式 等)
- **車両詳細**: カテゴリごとのスペック表示、料金 (時間貸し/日貸し)、補償オプションの選択と見積り
- **担当者の空き**: 本番モードでは、受け渡し担当者の Google カレンダーに予定がある時間・休みの日は選べない
- **予約フロー**: 運転免許の保有確認 (免許番号は Web では取得せず当日店頭で確認)、割引・クーポン、支払方法 (当日店頭 / 請求書)、最終確認画面 (料金内訳・支払時期・キャンセル規定)、法務文書ごとの同意 (版を記録)
- **会員機能**: 会員登録 (メール確認)・ログイン・パスワード再設定・予約履歴・キャンセル・ポイント・クーポン・退会
- **ゲスト照会**: 予約確認メールの照会 URL から予約の確認・キャンセル
- **多言語**: 日本語 / 英語 (i18n 構造)
- **レスポンシブ**: スマートフォン最優先

### 管理画面 (スタッフ)
- **ログイン**: メール + パスワード + 二段階認証 (認証アプリ)。役割 (管理者・店舗スタッフ・経理・整備・閲覧) と担当拠点で権限を制御
- **ダッシュボード / ガントチャート式予約表 / 予約管理** (状態遷移・キャンセル料の提示・入金記録・貸出停止枠)
- **帳票出力**: 貸渡証・車輌チェックシート・領収書を A4 印刷
- **カテゴリ・車両・オプション・拠点・料金ルール・ポイント/クーポン・各種設定**
- **顧客・会員管理** (会員の招待・ポイント調整・クーポン発行・請求書払い許可)、**請求書管理**
- **お問い合わせ / メール送信状況 / Googleカレンダー連携 / スタッフ・権限 / 操作履歴** (本番モード)

### 決済
- 現地決済 (基本) / 請求書払い (許可された法人・行政の会員のみ)
- オンライン事前決済は初期リリースの対象外

## ディレクトリ構成

```
sky-rent/
├── index.html / search.html / detail.html / booking.html / mypage.html / contact.html …  # 公開サイト
├── css/
├── js/
│   ├── config.js        # 接続先の設定 (空 = デモモード)
│   ├── store.js         # 画面用のデータストア (本番モードではメモリのみ)
│   ├── pricing-core.js  # 料金計算 (ブラウザと Edge Functions で同じコード)
│   ├── pricing.js       # 既存画面向けの料金計算アダプタ
│   ├── backend.js       # Supabase への接続・同期・API 呼び出し
│   └── boot.js          # データ読み込み後にページ処理を実行
├── manage/              # 管理画面一式
├── supabase/
│   ├── config.toml      # ローカル開発用の Supabase 設定 (Auth・メールテンプレート・Edge Functions)
│   ├── migrations/      # テーブル・権限 (RLS)・予約処理・定期ジョブ (本番にも db push で適用)
│   ├── seed.sql         # 初期データ (カタログと設定のみ)
│   ├── templates/       # 認証メールの日本語テンプレート
│   └── functions/       # Edge Functions (api / admin / worker)
├── scripts/
│   └── create-admin.mjs # 最初の管理者を作成 / 二段階認証のリセット
├── docs/                # 納品ドキュメント・本番化ドキュメント (docs/production/)
├── package.json         # 運用スクリプトと検証用の依存 (サイト本体はビルド不要)
└── gas/                 # 旧試作 (非推奨。下記参照)
```

## ドキュメント (納品物)

`docs/index.html` から参照できます。

- **要件定義書** (`docs/requirements.html`) — 機能要件と実装状況
- **基本設計書** (`docs/design.html`) — システム構成図・画面遷移図・DBスキーマ・API仕様
- **管理者向けマニュアル** (`docs/manual.html`) — 管理画面の操作手順書
- **開発規約** (`docs/dev-contract.md`) — データモデル・API・コーディング規約

## 旧試作 (非推奨)

`gas/` には、初期に検討した Google Apps Script (GAS) バックエンドの試作が残っています。
**現在の画面はこのコードに接続しておらず、本番のバックエンドとしても採用しません** (本番は Supabase)。
以前の `js/config.js` の `GAS_URL` 設定は廃止しました。参考として残しているだけなので、新たにデプロイしないでください。
経緯は [`gas/README.md`](gas/README.md) を参照してください。

## ライセンス

MIT
