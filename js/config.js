/**
 * Sky Rent - フロントエンド設定
 *
 * GAS_URL に Google Apps Script のウェブアプリ URL を設定してください。
 * (デプロイ後に発行される /exec で終わる URL)
 *
 * 例: https://script.google.com/macros/s/AKfycbx.../exec
 */
window.SKY_RENT_CONFIG = {
  // ↓↓↓ デプロイ後に書き換えてください ↓↓↓
  GAS_URL: 'https://script.google.com/macros/s/REPLACE_ME/exec',

  // フォールバック / 開発用: GAS が未デプロイのときダミー車両を表示
  USE_MOCK_WHEN_NO_URL: true
};
