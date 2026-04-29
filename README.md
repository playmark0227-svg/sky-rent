# Sky Rent

Googleカレンダー連携付きのレンタカー予約システム (MVP)。
GitHub Pages (フロント) + Google Apps Script (バックエンド) + Google Sheets (DB) + Google Calendar (在庫照合) で動作する、**サーバーレス・無料運用**の構成です。

公開URL: https://playmark0227-svg.github.io/sky-rent/

## 特徴

- **Googleカレンダー自動照合**: 予約時に Google Sheets と Google Calendar の双方を見て、空き状況を判定
- **二重予約防止**: ScriptLock + 予約確定時の再照合
- **完了メール自動送信**: 顧客向けに予約確認メール送信
- **無料**: Google アカウントだけで運用可能

## ディレクトリ構成

```
sky-rent/
├── index.html              # トップページ (1ページ完結ステップ式)
├── css/style.css
├── js/
│   ├── config.js          # GAS の URL を設定 (要編集)
│   ├── api.js             # API クライアント (モック切替対応)
│   └── app.js             # メイン処理
├── gas/
│   ├── Code.gs            # バックエンド (これを GAS にコピペ)
│   └── appsscript.json    # GAS マニフェスト
└── README.md
```

## セットアップ手順

### 1. Google Apps Script の準備

1. https://script.google.com/ にアクセス → 「新しいプロジェクト」
2. プロジェクト名を `Sky Rent Backend` などに変更
3. 左サイドバーの ⚙(プロジェクトの設定) → 「`appsscript.json`マニフェストファイルをエディタに表示」にチェック
4. `gas/Code.gs` の内容をエディタに貼り付け (`Code.gs`)
5. `gas/appsscript.json` の内容をエディタの `appsscript.json` に貼り付け
6. エディタ上部で関数 `setup` を選択 → 「実行」
   - 初回は権限承認が必要 (Sheets / Calendar / Mail / Script へのアクセスを許可)
   - 実行ログに Spreadsheet URL が表示されるので開いて確認 (サンプル車両4台が登録されています)

### 2. ウェブアプリとしてデプロイ

1. 右上「デプロイ」→「新しいデプロイ」
2. 種類: **ウェブアプリ**
3. 設定:
   - 説明: `Sky Rent v1`
   - 実行するユーザー: **自分**
   - アクセスできるユーザー: **全員**
4. 「デプロイ」を押すと URL が発行される (`https://script.google.com/macros/s/.../exec`)
5. この URL をコピー

### 3. フロントエンドの設定

`js/config.js` の `GAS_URL` を発行された URL に書き換える:

```javascript
window.SKY_RENT_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbx.../exec',
  USE_MOCK_WHEN_NO_URL: true
};
```

### 4. GitHub Pages で公開

リポジトリの Settings → Pages →
- Source: `Deploy from a branch`
- Branch: `main` / root

数分で `https://<ユーザー名>.github.io/sky-rent/` で公開されます。

### 5. (任意) 専用カレンダーを使う

デフォルトではログインユーザーのメインカレンダー (primary) を使用しますが、
レンタカー専用のカレンダーに分けたい場合:

1. Google Calendar で新規カレンダーを作成 (例: `Sky Rent 予約`)
2. カレンダー設定 → カレンダーの統合 → カレンダーIDをコピー
3. GAS エディタで → プロジェクトの設定 → スクリプト プロパティ → 追加
   - キー: `CALENDAR_ID`
   - 値: コピーしたカレンダーID

## 仕組み (照合ロジック)

予約フォーム送信 → GAS が以下の順で照合:

1. **Sheets 予約台帳** に同じ車両 × 期間重複の予約があるか
2. **Google Calendar** に同じ期間でタイトルに車両ID/車両名を含むイベントがあるか
3. どちらにも無ければ → Sheets追加 + Calendar イベント作成 + 確認メール送信

```
[ お客様 ] → [ index.html (GitHub Pages) ]
                        |
                        ▼ fetch
              [ Google Apps Script ]
                ├─ Google Sheets (車両/予約台帳)
                ├─ Google Calendar (在庫照合)
                └─ Mail (確認メール)
```

## カスタマイズ

- **車両を増やす**: Spreadsheet `車両マスタ` シートに行を追加 (`active=TRUE` にすれば即反映)
- **料金体系の変更**: `pricePerDay` を編集
- **店舗名・ロゴ**: `index.html` の `Sky Rent` を変更

## ロードマップ (v2 以降)

- [ ] 管理者ダッシュボード (店舗側UI)
- [ ] 予約キャンセル機能
- [ ] クレジットカード決済 (Stripe 連携)
- [ ] 貸渡証 / 領収書 PDF発行
- [ ] OTAメールAI解析
- [ ] 多店舗対応

## ライセンス

MIT
