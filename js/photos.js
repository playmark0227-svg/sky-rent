/**
 * Sky Rent - カテゴリ/資産 → 実写写真マッピング
 * 絵文字サムネの代わりに写真を表示 (読み込み失敗時は絵文字へ自動フォールバック)。
 * asset.photo (URL) があれば最優先。無ければカテゴリ既定写真。
 */
(function () {
  'use strict';
  const U = (id, w) => 'https://images.unsplash.com/' + id + '?auto=format&fit=crop&w=' + (w || 900) + '&q=70';

  // カテゴリ既定写真 (Unsplash)
  const CAT_PHOTOS = {
    'cat-rental':    U('photo-1449965408869-eaa3f722e40d'),  // 夕暮れの道を走る車
    'cat-kitchen':   U('photo-1565123409695-7b5ef63a2efb'),  // フードトラック
    'cat-camping':   U('photo-1533591380348-14193f1de18f'),  // 夕陽とキャンパーバン
    'cat-special':   U('photo-1541625602330-2277a4c46182'),  // 作業現場
    'cat-appliance': U('photo-1498049794561-7780e7231661'),  // 電子機器
    'cat-tool':      U('photo-1504148455328-c376907d081c')   // 工具
  };
  // 資産ID別の上書き (主要車両に個別写真)
  const ASSET_PHOTOS = {
    'V001': U('photo-1502877338535-766e1452684a'),           // コンパクトカー
    'V004': U('photo-1519641471654-76ce0107ad1b'),           // SUV
    'V006': U('photo-1503376780353-7e6692767b70'),           // 高級車
    'C001': U('photo-1533591380348-14193f1de18f'),
    'K001': U('photo-1565123409695-7b5ef63a2efb'),
    'I001': U('photo-1593941707882-a5bba14938c7'),           // ポータブル電源/バッテリー
    'I101': U('photo-1504148455328-c376907d081c')
  };

  function photoFor(asset) {
    if (!asset) return null;
    if (asset.photo) return asset.photo;
    if (ASSET_PHOTOS[asset.assetId]) return ASSET_PHOTOS[asset.assetId];
    return CAT_PHOTOS[asset.categoryId] || null;
  }

  /**
   * サムネHTML: 写真 <img> + 失敗時は絵文字が残る構造
   * 使い方: el.innerHTML = SkyRentPhotos.thumbHtml(asset)  (親は .thumb 相当)
   */
  function thumbHtml(asset) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const url = photoFor(asset);
    const emoji = esc(asset && asset.image || '📦');
    if (!url) return emoji;
    return '<span class="thumb-emoji" aria-hidden="true">' + emoji + '</span>' +
      '<img src="' + esc(url) + '" alt="' + esc(asset.name || '') + '" loading="lazy" onerror="this.remove()">';
  }

  window.SkyRentPhotos = { photoFor: photoFor, thumbHtml: thumbHtml, CAT_PHOTOS: CAT_PHOTOS, U: U };
})();
