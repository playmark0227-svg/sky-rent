/**
 * グロースレンタカー - 車両写真マッピング
 *
 * 優先順位: asset.photo (実車写真) → カテゴリ既定写真 → 絵文字。
 * 実車写真は images/cars/ に配置 (2026年8月撮影・ナンバー処理済み)。
 */
(function () {
  'use strict';
  const U = (id, w) => 'https://images.unsplash.com/' + id + '?auto=format&fit=crop&w=' + (w || 900) + '&q=70';

  // 実車写真がまだ無いカテゴリの暫定イメージ
  const CAT_PHOTOS = {
    'cat-rental':  U('photo-1449965408869-eaa3f722e40d'),
    'cat-kitchen': U('photo-1565123409695-7b5ef63a2efb')
  };

  // 資産IDごとの実車写真 (store.js の asset.photo が優先。ここは保険)
  const ASSET_PHOTOS = {
    'V001': 'images/cars/note-black.jpg',   // 日産 ノート (黒)
    'V002': 'images/cars/note-white.jpg',   // 日産 ノート e-POWER (白)
    'V003': 'images/cars/cx5.jpg',          // マツダ CX-5
    'V004': 'images/cars/sienta.jpg'        // トヨタ シエンタ
  };

  // manage/ 配下など、1階層深いページからでも解決できるようパスを補正
  function resolve(p) {
    if (!p || /^https?:/.test(p)) return p;
    const depth = (location.pathname.replace(/\/[^/]*$/, '/').match(/\//g) || []).length;
    // ルート直下のページは相対パスのまま、manage/ や docs/ からは 1つ上へ
    return /\/(manage|docs)\//.test(location.pathname) ? '../' + p : p;
  }

  function photoFor(asset) {
    if (!asset) return null;
    if (asset.photo) return resolve(asset.photo);
    if (ASSET_PHOTOS[asset.assetId]) return resolve(ASSET_PHOTOS[asset.assetId]);
    return CAT_PHOTOS[asset.categoryId] || null;
  }

  /**
   * サムネHTML: 写真 <img> + 読み込み失敗時は絵文字が残る構造
   */
  function thumbHtml(asset) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const url = photoFor(asset);
    const emoji = esc(asset && asset.image || '🚗');
    if (!url) return emoji;
    return '<span class="thumb-emoji" aria-hidden="true">' + emoji + '</span>' +
      '<img src="' + esc(url) + '" alt="' + esc(asset.name || '') + '" loading="lazy" onerror="this.remove()">';
  }

  window.SkyRentPhotos = { photoFor: photoFor, thumbHtml: thumbHtml, CAT_PHOTOS: CAT_PHOTOS, U: U };
})();
