# GAS バックエンド

これは旧 Google Apps Script 試作のソースコードです。現行フロントはこのコードへ接続されておらず、本番バックエンドとしては採用しません。本番化方針は [本番化実装ハンドオフ](../docs/production/README.md) を参照してください。

## ファイル

- `Code.gs` — メインロジック
- `appsscript.json` — マニフェスト (タイムゾーン / OAuthスコープ / Web App設定)

## デプロイ手順

デモ検証用の参考手順です。現行の接続状況はリポジトリ直下の [データ層とバックエンド](../README.md#データ層とバックエンド現行デモ) を参照してください。

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
