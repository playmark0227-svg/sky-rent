/**
 * Sky Rent 管理画面 - 共通パーツ (トップナビ + ユーザードロップダウン)
 *
 * 全ページ共通のヘッダー (ナビゲーション・ユーザーメニュー) を 1 箇所で定義し、
 * 各ページに動的に差し込む。
 * モバイルではハンバーガーメニュー (ドロワー) に自動切替。
 */
(function () {
  // プロフィール情報を localStorage から取得
  function getProfile() {
    const p = JSON.parse(localStorage.getItem('sky-rent.settings.profile') || '{}');
    return {
      name: p.name || '山田 太郎',
      email: p.email || 'yamada@sky-rent.example.com'
    };
  }

  function buildTopbar() {
    const profile = getProfile();
    return `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="dashboard.html">
          <span class="brand-mark">空</span>
          <span class="brand-sub">Sky Rent<br><small>(簡易版)</small></span>
        </a>

        <button class="nav-burger" type="button" aria-label="メニューを開く" aria-expanded="false" aria-controls="topnav">
          <span class="nav-burger-bar"></span>
          <span class="nav-burger-bar"></span>
          <span class="nav-burger-bar"></span>
        </button>

        <nav class="topnav" id="topnav">
          <div class="topnav-item">
            <button class="topnav-toggle" aria-haspopup="true" aria-expanded="false">予約管理 <span class="caret">▼</span></button>
            <div class="topnav-menu">
              <a href="dashboard.html">ダッシュボード</a>
              <a href="reservation-table.html">貸渡予約表 (ガント)</a>
              <a href="reservation-list.html">予約一覧</a>
              <a href="forms.html">帳票出力 (貸渡証・領収書等)</a>
              <a href="reservation-cancellations.html">予約キャンセル一覧</a>
              <a href="shaken-list.html">車検予約一覧</a>
              <a href="inspection-list.html">点検予約一覧</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle" aria-haspopup="true" aria-expanded="false">各種管理 <span class="caret">▼</span></button>
            <div class="topnav-menu">
              <a href="categories.html">カテゴリ管理 (カスタム項目)</a>
              <a href="vehicles.html">車両・物品管理</a>
              <a href="options.html">オプション管理</a>
              <a href="members.html">顧客・会員管理</a>
              <a href="invoices.html">請求書管理</a>
              <a href="customer-rates.html">顧客料金種別管理</a>
              <a href="price-plans.html">料金プラン管理</a>
              <a href="holidays.html">定休日管理</a>
              <a href="high-season.html">ハイシーズン管理</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle" aria-haspopup="true" aria-expanded="false">分析 <span class="caret">▼</span></button>
            <div class="topnav-menu">
              <a href="revenue.html">売上集計</a>
              <a href="utilization.html">車輌稼働率</a>
              <a href="ga-integration.html">GoogleAnalytics連携設定</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle" aria-haspopup="true" aria-expanded="false">社内管理 <span class="caret">▼</span></button>
            <div class="topnav-menu">
              <a href="stores.html">店舗管理</a>
              <a href="employees.html">従業員管理</a>
              <a href="rental-report.html">貸渡実績報告書 (陸運局)</a>
              <a href="reports-print.html">定期報告書類の印刷</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle" aria-haspopup="true" aria-expanded="false">予約サイト設定 <span class="caret">▼</span></button>
            <div class="topnav-menu">
              <a href="site-settings.html">予約サイト設定</a>
              <a href="points.html">ポイント・クーポン設定</a>
              <a href="content.html">コンテンツ管理</a>
              <a href="custom-pages.html">カスタムページ管理</a>
              <a href="notices.html">お知らせ管理</a>
              <a href="seo.html">SEO管理</a>
              <a href="input-fields.html">入力項目管理</a>
            </div>
          </div>
        </nav>

        <div class="topbar-right">
          <div class="topbar-links">
            <a href="billing.html">▶請求情報</a>
            <a href="contact.html">▶お問合せ</a>
            <a href="faq.html">▶よくあるご質問(FAQ)</a>
          </div>
          <div class="topnav-item user-menu">
            <button class="topbar-user topnav-toggle" aria-haspopup="true" aria-expanded="false">
              ${escapeHtml(profile.name)}
              <small>事業者コード: c00000-000001 ▼</small>
            </button>
            <div class="topnav-menu" style="right:0;left:auto;min-width:220px">
              <a href="profile.html">プロフィール編集</a>
              <a href="../" target="_blank">予約サイトを表示 ↗</a>
              <a href="../docs/index.html" target="_blank">システムドキュメント ↗</a>
              <a href="#" id="topbar-logout" style="color:#c0392b">ログアウト</a>
            </div>
          </div>
        </div>
      </div>
    </header>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function injectTopbar() {
    injectFavicon();
    const placeholder = document.querySelector('[data-include="topbar"]');
    if (placeholder) placeholder.outerHTML = buildTopbar();
    setupDropdowns();
    setupMobileNav();
    highlightActive();
    setupLogout();
    checkSession();
  }

  // ===== favicon / テーマカラー (全ページ共通の見た目) =====
  function injectFavicon() {
    if (document.querySelector('link[rel="icon"]')) return;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c4a7a"/><text x="32" y="46" font-size="40" text-anchor="middle" fill="#ffffff" font-family="serif" font-weight="bold">空</text></svg>';
    const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = href;
    document.head.appendChild(icon);
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.href = href;
    document.head.appendChild(apple);
    if (!document.querySelector('meta[name="theme-color"]')) {
      const tc = document.createElement('meta');
      tc.name = 'theme-color';
      tc.content = '#1c4a7a';
      document.head.appendChild(tc);
    }
  }

  function setupDropdowns() {
    document.querySelectorAll('.topnav-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.topnav-item');
        const isOpen = item.classList.contains('open');
        // 他のメニューを閉じる
        document.querySelectorAll('.topnav-item.open').forEach(o => {
          o.classList.remove('open');
          const t = o.querySelector('.topnav-toggle');
          if (t) t.setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          item.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
    // 外側クリックで全て閉じる
    document.addEventListener('click', closeAllMenus);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeAllMenus(); closeMobileDrawer(); }
    });
  }

  function closeAllMenus() {
    document.querySelectorAll('.topnav-item.open').forEach(o => {
      o.classList.remove('open');
      const t = o.querySelector('.topnav-toggle');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }

  // ===== モバイル: ハンバーガードロワー =====
  function setupMobileNav() {
    const burger = document.querySelector('.nav-burger');
    if (!burger) return;
    burger.addEventListener('click', (e) => {
      e.stopPropagation();
      const topbar = document.querySelector('.topbar');
      const open = topbar.classList.toggle('mobile-open');
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
      if (!open) closeAllMenus();
    });
    // ドロワー内のリンクをタップしたら閉じる (画面遷移前に体感を良く)
    document.querySelectorAll('.topnav-menu a, .topbar-links a').forEach(a => {
      a.addEventListener('click', closeMobileDrawer);
    });
  }

  function closeMobileDrawer() {
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.classList.remove('mobile-open');
    const burger = document.querySelector('.nav-burger');
    if (burger) {
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'メニューを開く');
    }
  }

  function highlightActive() {
    const path = location.pathname.split('/').pop() || 'dashboard.html';
    document.querySelectorAll('.topnav-menu a').forEach(a => {
      if (a.getAttribute('href') === path) {
        a.classList.add('active');
        const item = a.closest('.topnav-item');
        if (item) item.classList.add('current');
      }
    });
  }

  function setupLogout() {
    const lo = document.querySelector('#topbar-logout');
    if (lo) {
      lo.addEventListener('click', e => {
        e.preventDefault();
        if (!confirm('ログアウトしますか?')) return;
        sessionStorage.removeItem('sky-rent.session');
        location.href = 'login.html';
      });
    }
  }

  function checkSession() {
    // ログインページ自体ではチェックしない
    if (location.pathname.endsWith('login.html')) return;
    // 自動ログインを許可 (デモ用): セッションがなければ作る
    if (!sessionStorage.getItem('sky-rent.session')) {
      sessionStorage.setItem('sky-rent.session', JSON.stringify({
        userId: 'demo',
        loginAt: new Date().toISOString()
      }));
    }
  }

  document.addEventListener('DOMContentLoaded', injectTopbar);
})();
