/**
 * グロースレンタカー — トップLP 演出スクリプト
 * イントロ / ヘッダー状態 / スクロールリビール / カウンター /
 * パララックス / 横スクロールカルーセル / 動的データ描画
 */
(function () {
  'use strict';
  // JSが動く環境でのみリビール用の初期非表示を有効化 (no-JS/クローラは常時表示)
  document.documentElement.classList.add('js');
  const S = window.SkyRentStore;
  const P = window.SkyRentPhotos;
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const reduced = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CAT_EN = { 'cat-rental': 'Rental Car', 'cat-kitchen': 'Kitchen Car' };

  // ===== イントロスプラッシュ =====
  function intro() {
    const el = $('#intro');
    if (!el) { document.body.classList.add('ready'); return; }
    let seen = false;
    try { seen = sessionStorage.getItem('sky-rent.introSeen'); } catch (e) { /* storage unavailable */ }
    const wait = (reduced || seen) ? 60 : 1500;
    if (reduced || seen) el.style.display = 'none';
    setTimeout(() => {
      el.classList.add('leave');
      document.body.classList.add('ready');
      try { sessionStorage.setItem('sky-rent.introSeen', '1'); } catch (e) { /* storage unavailable */ }
      setTimeout(() => el.remove(), 900);
    }, wait);
  }

  // ===== ヘッダー: スクロールで白背景化 =====
  function header() {
    const h = $('.site-header');
    const onScroll = () => h.classList.toggle('scrolled', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ===== スクロールリビール =====
  function reveals() {
    const targets = $$('.rv, .rv-l, .rv-r, .rv-scale');
    if (typeof IntersectionObserver !== 'function') {
      targets.forEach(el => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
    targets.forEach(el => io.observe(el));
  }

  // ===== 数字カウントアップ =====
  function counters() {
    const els = $$('[data-count]');
    if (!els.length) return;
    if (typeof IntersectionObserver !== 'function') {
      els.forEach(el => { el.textContent = parseInt(el.dataset.count, 10) || 0; });
      return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const el = e.target, target = parseInt(el.dataset.count, 10) || 0, dur = 1400;
        if (reduced) { el.textContent = target; return; }
        const t0 = performance.now();
        (function tick(t) {
          const p = Math.min(1, (t - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased);
          if (p < 1) requestAnimationFrame(tick);
        })(t0);
      });
    }, { threshold: 0.5 });
    els.forEach(el => io.observe(el));
  }

  // ===== パララックス ([data-parallax] を縦方向に微移動) =====
  function parallax() {
    if (reduced) return;
    const els = [...$$('[data-parallax]')];
    if (!els.length) return;
    let ticking = false;
    function update() {
      const vh = window.innerHeight;
      els.forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) return;
        const speed = parseFloat(el.dataset.parallax) || 0.12;
        const center = r.top + r.height / 2 - vh / 2;
        el.style.transform = 'translate3d(0,' + (-center * speed).toFixed(1) + 'px,0)';
      });
      ticking = false;
    }
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  // ===== 検索パネル =====
  //   日時は端末のタイムゾーンに関係なく日本時間で扱う。search.html へは日本時間の 'YYYY-MM-DDTHH:MM' で渡す。
  const HOUR = 3600000, DAY = 86400000, JST_OFFSET = 9 * HOUR;
  function jstInput(ms) {
    const B = window.SkyRentBackend;
    if (B && B.jst) return B.jst.toInput(ms);
    return new Date(ms + JST_OFFSET).toISOString().slice(0, 16);
  }
  function jstValid(v) {
    const B = window.SkyRentBackend;
    if (B && B.jst) return !!B.jst.fromInput(v);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v || ''));
  }
  function searchPanel() {
    const cats = S.categories(), locs = S.locations();
    $('#hs-category').innerHTML = '<option value="">すべてのカテゴリ</option>' + cats.map(c => '<option value="' + esc(c.categoryId) + '">' + esc((c.icon ? c.icon + ' ' : '') + c.name) + '</option>').join('');
    $('#hs-location').innerHTML = '<option value="">すべての拠点</option>' + locs.map(l => '<option value="' + esc(l.locationId) + '">' + esc(l.name) + '</option>').join('');
    // 既定: 明日 10:00 〜 あさって 10:00 (日本時間)
    const today = Math.floor((Date.now() + JST_OFFSET) / DAY) * DAY - JST_OFFSET;
    const t = today + DAY + 10 * HOUR;
    $('#hs-start').value = jstInput(t);
    $('#hs-end').value = jstInput(t + DAY);
    $('#hs-start').min = jstInput(today);
    $('#hs-end').min = jstInput(today);
    $('#hero-search').addEventListener('submit', e => {
      e.preventDefault();
      const p = new URLSearchParams();
      if ($('#hs-category').value) p.set('category', $('#hs-category').value);
      if ($('#hs-location').value) p.set('location', $('#hs-location').value);
      if (jstValid($('#hs-start').value)) p.set('start', $('#hs-start').value);
      if (jstValid($('#hs-end').value)) p.set('end', $('#hs-end').value);
      location.href = 'search.html?' + p.toString();
    });
  }

  // ===== 管理画面の設定 (SEO・テーマカラー・GA) を反映 =====
  //   データの読み込み後 (skyrent:ready) に SkyRentStore の settings.* から読む。
  //   本番はサーバー (public_catalog) の値、デモは localStorage の値。
  function readSetting(key) {
    try {
      const v = S.read('settings.' + key, null);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) { return {}; }
  }
  function shade(hex, percent) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); if (!m) return hex;
    return '#' + [m[1], m[2], m[3]].map(h => {
      const v = parseInt(h, 16);
      return Math.max(0, Math.min(255, v + Math.round(v * percent / 100))).toString(16).padStart(2, '0');
    }).join('');
  }
  function setMeta(name, content) {
    let m = document.querySelector('meta[name="' + name + '"]');
    if (!m) { m = document.createElement('meta'); m.setAttribute('name', name); document.head.appendChild(m); }
    m.setAttribute('content', content);
  }
  function applySiteSettings() {
    const seo = readSetting('seo'), site = readSetting('site'), ga = readSetting('ga');
    if (typeof seo.title === 'string' && seo.title.trim()) document.title = seo.title.trim();
    if (typeof seo.description === 'string' && seo.description.trim()) setMeta('description', seo.description.trim());
    if (typeof seo.keywords === 'string' && seo.keywords.trim()) setMeta('keywords', seo.keywords.trim());
    // テーマカラーは #RRGGBB だけ受け付ける (CSS に文字列をそのまま入れない)
    const color = typeof site.themeColor === 'string' ? site.themeColor.trim() : '';
    if (/^#?[0-9a-f]{6}$/i.test(color)) {
      const hex = color.charAt(0) === '#' ? color : '#' + color;
      let st = document.getElementById('skyrent-theme');
      if (!st) { st = document.createElement('style'); st.id = 'skyrent-theme'; document.head.appendChild(st); }
      st.textContent = ':root { --color-primary: ' + hex + ' !important; --color-primary-dark: ' + shade(hex, -15) + ' !important; }';
    }
    const gaId = typeof ga.ga4Id === 'string' ? ga.ga4Id.trim() : '';
    if (/^G-[A-Z0-9]{4,20}$/i.test(gaId) && !window.gtag) {
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
      document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', gaId);
    }
  }

  // ===== 統計 =====
  function stats() {
    const assets = S.assets({ activeOnly: true }).length;
    const locs = S.locations().length;
    const el1 = $('#st-assets2'), el3 = $('#st-locs');
    if (el1) el1.dataset.count = assets;
    if (el3) el3.dataset.count = locs;
  }

  // ===== カテゴリショーケース =====
  function catList() {
    const wrap = $('#cat-list');
    if (!wrap) return;
    const cats = S.categories();
    wrap.innerHTML = cats.map((c, i) => {
      const cnt = S.assets({ categoryId: c.categoryId, activeOnly: true }).length;
      const ph = P.CAT_PHOTOS[c.categoryId];
      return '<a class="cat-item rv d' + Math.min(i + 1, 6) + '" href="search.html?category=' + esc(encodeURIComponent(c.categoryId)) + '">' +
        '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="ttl"><span class="en">' + esc(CAT_EN[c.categoryId] || c.nameEn || '') + '</span><span class="jp">' + esc(c.name) + '</span></span>' +
        '<span class="desc">' + esc(c.description || '') + '<span class="cnt">' + cnt + ' UNITS</span></span>' +
        '<span class="go">→</span>' +
        (ph ? '<img class="float-img" src="' + ph + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
        '</a>';
    }).join('');
  }

  // ===== クラス別タイル (ボディタイプごとの最安値) =====
  // 一般レンタカーは bodyType 単位、キッチンカーはカテゴリ自体を1クラスとして扱う。
  function classGrid() {
    const wrap = $('#class-grid');
    if (!wrap) return;
    const groups = new Map(); // ラベル -> { min, href, seats }
    S.categories().forEach(c => {
      const useBody = (c.customFieldDefs || []).some(d => d.key === 'bodyType');
      S.assets({ categoryId: c.categoryId, activeOnly: true }).forEach(a => {
        const label = (useBody && (a.customFields || {}).bodyType) || c.name;
        const price = Number(a.priceDay) || 0;
        if (!price) return;
        const href = 'search.html?category=' + encodeURIComponent(c.categoryId) +
          (useBody && (a.customFields || {}).bodyType ? '&f_bodyType=' + encodeURIComponent(label) : '');
        const cur = groups.get(label);
        if (!cur) groups.set(label, { min: price, href: href, seats: a.capacity || 0 });
        else {
          if (price < cur.min) { cur.min = price; cur.href = href; }
          if ((a.capacity || 0) > cur.seats) cur.seats = a.capacity;
        }
      });
    });
    const block = wrap.closest('.class-block');
    if (!groups.size) { if (block) block.remove(); return; }
    const rows = [...groups.entries()].sort((a, b) => a[1].min - b[1].min);
    wrap.innerHTML = rows.map(([label, g]) =>
      '<a class="class-tile" href="' + esc(g.href) + '">' +
        '<span class="ct-txt"><span class="ct-name">' + esc(label) + '</span>' +
        '<span class="ct-price">¥' + g.min.toLocaleString() + '〜<small>/ 24時間' +
        (g.seats ? '・' + g.seats + '名' : '') + '</small></span></span>' +
        '<span class="ct-go" aria-hidden="true">→</span>' +
      '</a>').join('');
  }

  // ===== 車両ラインナップ (横スクロール) =====
  function lineup() {
    const sc = $('#lineup-scroller');
    if (!sc) return;
    // 目玉を選抜: 各カテゴリから1台ずつ + 人気車
    const picks = ['V003', 'V004', 'V001', 'V002', 'V005', 'K001'];
    const assets = picks.map(id => S.getAsset(id)).filter(a => a && a.active !== false);
    sc.innerHTML = assets.map((a, i) => {
      const c = S.getCategory(a.categoryId);
      return '<div class="lu-card rv d' + Math.min(i % 4 + 1, 4) + '">' +
        '<div class="ph"><span>' + esc(a.image || '📦') + '</span>' +
          '<span class="tag">' + esc(CAT_EN[a.categoryId] || (c && c.nameEn) || '') + '</span>' +
          '<img src="' + esc(P.photoFor(a) || '') + '" alt="' + esc(a.name) + '" loading="lazy" onerror="this.remove()">' +
        '</div>' +
        '<div class="bd">' +
          '<div class="nm">' + esc(a.name) + '</div>' +
          '<div class="mt">' + esc(c ? c.name : '') + (a.capacity ? '・定員' + a.capacity + '名' : (a.stock > 1 ? '・在庫' + a.stock + '点' : '')) + (a.requiredLicense ? '・<b style="color:#b03c15">要免許</b>' : '') + '</div>' +
          '<div class="pr"><span class="yen">¥' + Number(a.priceDay).toLocaleString() + '</span><small>/日〜</small></div>' +
          '<a class="btn btn-primary" href="detail.html?id=' + esc(encodeURIComponent(a.assetId)) + '">詳細・予約する</a>' +
        '</div></div>';
    }).join('');
    // ナビ矢印
    const step = 322;
    $('#lu-prev').addEventListener('click', () => sc.scrollBy({ left: -step, behavior: 'smooth' }));
    $('#lu-next').addEventListener('click', () => sc.scrollBy({ left: step, behavior: 'smooth' }));
  }

  // ===== 拠点 =====
  function locations() {
    const wrap = $('#loc-grid');
    if (!wrap) return;
    wrap.innerHTML = S.locations().map((l, i) =>
      '<div class="loc-card rv d' + (i + 1) + '">' +
      '<div class="no">BASE ' + String(i + 1).padStart(2, '0') + '</div>' +
      '<h3>' + esc(l.name) + '</h3>' +
      '<p>' + esc(l.address) + (l.tel ? '<br>TEL ' + esc(l.tel) : '') + '<br>' + esc(l.hours) + ' ／ ' + esc(l.holiday) + '</p>' +
      '</div>'
    ).join('');
  }

  // ===== FAQ: 1つ開いたら他を閉じる =====
  function faq() {
    $$('.faq').forEach(d => {
      d.addEventListener('toggle', () => {
        if (d.open) $$('.faq').forEach(o => { if (o !== d) o.open = false; });
      });
    });
  }

  // ===== 画面外の無限アニメーションを一時停止 (省電力・描画安定化) =====
  function pauseOffscreen() {
    const els = ['.lp-hero .bg', '.marquee .track', '.hero-scroll .line'].map(s => $(s)).filter(Boolean);
    if (!els.length || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { e.target.style.animationPlayState = e.isIntersecting ? 'running' : 'paused'; });
    }, { threshold: 0 });
    els.forEach(el => io.observe(el));
  }

  // boot.js がデータを読み込んだ後に発火する (このファイルはその前に実行される)
  window.addEventListener('skyrent:ready', () => {
    try { applySiteSettings(); } catch (e) { console.error('applySiteSettings failed', e); }
  }, { once: true });

  function boot() {
    // データ初期化や一部機能が失敗しても、イントロだけは必ず解除する。
    intro();
    [stats, searchPanel, catList, classGrid, lineup, locations, faq,
      header, reveals, counters, parallax, pauseOffscreen].forEach(fn => {
      try { fn(); } catch (e) { console.error(fn.name + ' init failed', e); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
