/**
 * グロースレンタカー 公開サイト 共通パーツ
 *   <div data-inc="header"></div>  … ヘッダー
 *   <div data-inc="footer"></div>  … フッター (法務ページへの導線を含む)
 *   <div data-inc="cta"></div>     … 右下の追従「いますぐ予約」バッジ
 * を実際のマークアップへ差し替える。ページ側の記述量を減らし、リンク切れを防ぐ。
 */
(function () {
  'use strict';
  const LINE = 'https://lin.ee/PuLt0Ig';
  const MAIL = 'daichi.fujimoto@skyward-growth.com';

  function header(active) {
    const nav = [
      ['index.html#categories', 'カテゴリ', true],
      ['fleet.html', '車両と料金', true],
      ['guide.html', 'ご利用方法', true],
      ['faq.html', 'よくある質問', true],
      ['mypage.html', 'マイページ', false]
    ];
    return '<header class="site-header">' +
      '<div class="container header-inner">' +
      '<a href="index.html" class="logo"><span class="logo-mark">G</span><span class="logo-text">グロースレンタカー</span></a>' +
      '<nav class="site-nav">' +
      nav.map(n => '<a href="' + n[0] + '"' + (n[2] ? ' class="nav-hide-sp"' : '') + '>' + n[1] + '</a>').join('') +
      '<a href="search.html" class="nav-cta">予約する</a>' +
      // 言語トグルは i18n 対応 (data-i18n を持つ) ページだけに出す。
      // 翻訳の無いページで押せてしまうと「効かないボタン」になるため。
      (document.querySelector('[data-i18n]') ? '<button class="lang-btn" data-lang-toggle type="button">EN</button>' : '') +
      '</nav></div></header>';
  }

  function footer() {
    return '<footer class="site-footer"><div class="container">' +
      '<div class="footer-top">' +
        '<div class="footer-brand">' +
          '<div class="fb-mark"><span class="fb-kanji">G</span>グロースレンタカー</div>' +
          '<div class="fb-en">Growth Rent a Car</div>' +
          '<p>コンパクトカー・SUV・ミニバン・軽トラック・キッチンカー。<br>北海道 北見・釧路からお貸しします。</p>' +
        '</div>' +
        '<div class="footer-col"><h4>Rental</h4>' +
          '<a href="search.html">空き検索・予約</a>' +
          '<a href="fleet.html">車両と料金</a>' +
          '<a href="insurance.html">保険・補償プラン</a>' +
          '<a href="search.html?category=cat-rental">一般レンタカー</a>' +
          '<a href="search.html?category=cat-kitchen">キッチンカー</a>' +
        '</div>' +
        '<div class="footer-col"><h4>Guide</h4>' +
          '<a href="guide.html">ご利用方法</a>' +
          '<a href="faq.html">よくあるご質問</a>' +
          '<a href="mypage.html">マイページ</a>' +
          '<a href="contact.html">お問い合わせ</a>' +
          '<a href="' + LINE + '" target="_blank" rel="noopener">公式LINE ↗</a>' +
        '</div>' +
        '<div class="footer-col"><h4>Company</h4>' +
          '<a href="company.html">会社概要</a>' +
          '<a href="clause.html">貸渡約款</a>' +
          '<a href="privacy.html">プライバシーポリシー</a>' +
          '<a href="law.html">特定商取引法に基づく表記</a>' +
          '<a href="mailto:' + MAIL + '">' + MAIL + '</a>' +
        '</div>' +
      '</div>' +
      '<div class="footer-bottom">' +
        '<span>© 2026 株式会社Skyward Growth — グロースレンタカー</span>' +
        '<span>デモ環境 (データはお使いのブラウザ内に保存されます)</span>' +
      '</div></div></footer>';
  }

  function cta() {
    return '<a class="float-cta" href="search.html" aria-label="いますぐ予約する">' +
      '<span class="fc-ring" aria-hidden="true"></span>いますぐ<br>予約</a>';
  }

  function inject() {
    document.querySelectorAll('[data-inc]').forEach(el => {
      const k = el.getAttribute('data-inc');
      const html = k === 'header' ? header() : k === 'footer' ? footer() : k === 'cta' ? cta() : '';
      if (html) el.outerHTML = html;
    });
    // ヘッダー: スクロールで背景を出す
    const h = document.querySelector('.site-header');
    if (h) {
      const on = () => h.classList.toggle('scrolled', window.scrollY > 40);
      window.addEventListener('scroll', on, { passive: true }); on();
    }
    // 追従CTA: 少しスクロールしたら表示
    const fc = document.querySelector('.float-cta');
    if (fc) {
      const on = () => fc.classList.toggle('show', window.scrollY > 420);
      window.addEventListener('scroll', on, { passive: true }); on();
    }
    // 共通ヘッダーは i18n.js より後に注入されるため、翻訳とトグルを貼り直す
    if (window.SkyRentI18n) {
      try {
        if (typeof SkyRentI18n.bindToggles === 'function') SkyRentI18n.bindToggles();
        if (typeof SkyRentI18n.apply === 'function') SkyRentI18n.apply();
      } catch (e) { console.warn('i18n rebind failed', e); }
    }
    // 現在ページをナビで強調
    const path = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.site-nav a').forEach(a => {
      if (a.getAttribute('href') === path) a.style.color = 'var(--color-primary)';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
