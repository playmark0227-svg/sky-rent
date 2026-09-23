/**
 * グロースレンタカー - フロントエンド設定
 *
 * SUPABASE_URL と SUPABASE_ANON_KEY が空のときは「デモモード」で動きます
 * (データはこのブラウザの localStorage に保存。GitHub Pages の公開デモ用)。
 * 両方を設定すると「本番モード」になり、データは Supabase から読み書きします
 * (業務データはブラウザに保存しません)。
 *
 *   SUPABASE_URL      : https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY : anon key / publishable key (公開してよいキー。service_role key は絶対に入れない)
 *   FUNCTIONS_URL     : Edge Functions の URL。空なら SUPABASE_URL + '/functions/v1'
 *   AUTH_STORAGE      : ログイン状態の保存先。
 *                         'auto'    … *.github.io で公開しているときはタブを閉じると消える sessionStorage
 *                                     (同じアカウントの他のリポジトリのサイトと保存領域を共有するため)、
 *                                     それ以外 (独自ドメイン) は localStorage (既定)
 *                         'local'   … 常に localStorage (ブラウザを閉じてもログインしたまま)
 *                         'session' … 常に sessionStorage (タブを閉じるとログアウト)
 *
 * 検証用: localhost / 127.0.0.1 で開いたときだけ、
 *   localStorage['sky-rent.configOverride'] = '{"SUPABASE_URL":"http://127.0.0.1:54321", ...}'
 * で上書きできます (本番の URL では無視されます)。
 */
window.SKY_RENT_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  FUNCTIONS_URL: '',
  AUTH_STORAGE: 'auto',
  SITE_NAME: 'グロースレンタカー'
};

(function () {
  'use strict';
  const cfg = window.SKY_RENT_CONFIG;
  const KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'FUNCTIONS_URL', 'AUTH_STORAGE', 'SITE_NAME'];
  try {
    const host = String(location.hostname || '');
    if (host !== 'localhost' && host !== '127.0.0.1') return;
    const raw = localStorage.getItem('sky-rent.configOverride');
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return;
    KEYS.forEach(k => {
      if (typeof o[k] === 'string') cfg[k] = o[k];
    });
  } catch (e) {
    // 上書き設定が壊れていても既定値で動かす
    console.warn('sky-rent.configOverride を読み込めませんでした', e);
  }
})();
