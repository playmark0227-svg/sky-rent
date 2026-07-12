/**
 * Sky Rent — トップLP 演出スクリプト
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
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CAT_EN = {
    'cat-rental': 'Rental Car', 'cat-kitchen': 'Kitchen Car', 'cat-camping': 'Camper',
    'cat-special': 'Special Vehicle', 'cat-appliance': 'Appliance', 'cat-tool': 'Tools'
  };

  // ===== イントロスプラッシュ =====
  function intro() {
    const el = $('#intro');
    if (!el) { document.body.classList.add('ready'); return; }
    const seen = sessionStorage.getItem('sky-rent.introSeen');
    const wait = (reduced || seen) ? 60 : 1500;
    if (reduced || seen) el.style.display = 'none';
    setTimeout(() => {
      el.classList.add('leave');
      document.body.classList.add('ready');
      sessionStorage.setItem('sky-rent.introSeen', '1');
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
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
    $$('.rv, .rv-l, .rv-r, .rv-scale').forEach(el => io.observe(el));
  }

  // ===== 数字カウントアップ =====
  function counters() {
    const els = $$('[data-count]');
    if (!els.length) return;
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
  function fmtLocal(d) { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function searchPanel() {
    const cats = S.categories(), locs = S.locations();
    $('#hs-category').innerHTML = '<option value="">すべてのカテゴリ</option>' + cats.map(c => '<option value="' + c.categoryId + '">' + esc(c.icon + ' ' + c.name) + '</option>').join('');
    $('#hs-location').innerHTML = '<option value="">すべての拠点</option>' + locs.map(l => '<option value="' + l.locationId + '">' + esc(l.name) + '</option>').join('');
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0);
    const t2 = new Date(t); t2.setDate(t2.getDate() + 1);
    $('#hs-start').value = fmtLocal(t);
    $('#hs-end').value = fmtLocal(t2);
    $('#hero-search').addEventListener('submit', e => {
      e.preventDefault();
      const p = new URLSearchParams();
      if ($('#hs-category').value) p.set('category', $('#hs-category').value);
      if ($('#hs-location').value) p.set('location', $('#hs-location').value);
      if ($('#hs-start').value) p.set('start', new Date($('#hs-start').value).toISOString());
      if ($('#hs-end').value) p.set('end', new Date($('#hs-end').value).toISOString());
      location.href = 'search.html?' + p.toString();
    });
  }

  // ===== 統計 =====
  function stats() {
    const cats = S.categories().length;
    const assets = S.assets({ activeOnly: true }).length;
    const locs = S.locations().length;
    const el1 = $('#st-cats'), el2 = $('#st-assets'), el3 = $('#st-locs');
    if (el1) el1.dataset.count = cats;
    if (el2) el2.dataset.count = assets;
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
      return '<a class="cat-item rv d' + Math.min(i + 1, 6) + '" href="search.html?category=' + c.categoryId + '">' +
        '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="ttl"><span class="en">' + esc(CAT_EN[c.categoryId] || c.nameEn || '') + '</span><span class="jp">' + esc(c.name) + '</span></span>' +
        '<span class="desc">' + esc(c.description || '') + '<span class="cnt">' + cnt + ' UNITS</span></span>' +
        '<span class="go">→</span>' +
        (ph ? '<img class="float-img" src="' + ph + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
        '</a>';
    }).join('');
  }

  // ===== 車両ラインナップ (横スクロール) =====
  function lineup() {
    const sc = $('#lineup-scroller');
    if (!sc) return;
    // 目玉を選抜: 各カテゴリから1台ずつ + 人気車
    const picks = ['K001', 'C001', 'V004', 'T001', 'V006', 'I001', 'K002', 'T003', 'I103'];
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
          '<a class="btn btn-primary" href="detail.html?id=' + a.assetId + '">詳細・予約する</a>' +
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
      '<p>' + esc(l.address) + '<br>TEL ' + esc(l.tel) + '<br>' + esc(l.hours) + ' ／ ' + esc(l.holiday) + '</p>' +
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
    if (!els.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { e.target.style.animationPlayState = e.isIntersecting ? 'running' : 'paused'; });
    }, { threshold: 0 });
    els.forEach(el => io.observe(el));
  }

  function boot() {
    stats(); searchPanel(); catList(); lineup(); locations(); faq();
    header(); reveals(); counters(); parallax(); pauseOffscreen(); intro();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
