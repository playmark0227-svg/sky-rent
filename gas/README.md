# GAS バックエンド

これはサーバーサイド (Google Apps Script) のソースコードです。

## ファイル

- `Code.gs` — メインロジック
- `appsscript.json` — マニフェスト (タイムゾーン / OAuthスコープ / Web App設定)

## デプロイ手順

詳細はリポジトリ直下の [README.md](../README.md#セットアップ手順) を参照してください。

要点:

1. https://script.google.com/ で新規プロジェクト作成
2. `Code.gs` の内容を貼り付け
3. プロジェクトの設定で `appsscript.json` を表示し、内容を貼り付け
4. エディタから `setup()` を実行 (権限承認 + サンプルデータ作成)
5. 「デプロイ」→「ウェブアプリ」で公開
6. 発行 URL を フロントの `js/config.js` に設定

## ローカル開発したい場合

[clasp](https://github.com/google/clasp) を使うと CLI で push/pull できます。

```bash
npm install -g @google/clasp
clasp login
clasp clone <ScriptId>
# Code.gs / appsscript.json をこのフォルダの内容で上書き
clasp push
clasp deploy
```
