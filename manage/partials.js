/**
 * Sky Rent 管理画面 - 共通パーツ (トップナビ + ユーザードロップダウン)
 *
 * 全ページ共通のヘッダー (ナビゲーション・ユーザーメニュー) を 1 箇所で定義し、
 * 各ページに動的に差し込む。
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

        <nav class="topnav">
          <div class="topnav-item">
            <button class="topnav-toggle">予約管理 ▼</button>
            <div class="topnav-menu">
              <a href="dashboard.html">ダッシュボード</a>
              <a href="reservation-table.html">貸渡予約表</a>
              <a href="reservation-list.html">予約一覧</a>
              <a href="reservation-cancellations.html">予約キャンセル一覧</a>
              <a href="shaken-list.html">車検予約一覧</a>
              <a href="inspection-list.html">点検予約一覧</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle">各種管理 ▼</button>
            <div class="topnav-menu">
              <a href="customers.html">顧客管理</a>
              <a href="customer-rates.html">顧客料金種別管理</a>
              <a href="vehicle-classes.html">クラス管理</a>
              <a href="vehicle-types.html">車種管理</a>
              <a href="vehicles.html">車輌管理</a>
              <a href="price-plans.html">料金プラン管理</a>
              <a href="options.html">オプション管理</a>
              <a href="holidays.html">定休日管理</a>
              <a href="high-season.html">ハイシーズン管理</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle">分析 ▼</button>
            <div class="topnav-menu">
              <a href="revenue.html">売上集計</a>
              <a href="utilization.html">車輌稼働率</a>
              <a href="ga-integration.html">GoogleAnalytics連携設定</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle">社内管理 ▼</button>
            <div class="topnav-menu">
              <a href="stores.html">店舗管理</a>
              <a href="employees.html">従業員管理</a>
              <a href="rental-report.html">貸渡実績報告書 (陸運局)</a>
              <a href="reports-print.html">定期報告書類の印刷</a>
            </div>
          </div>
          <div class="topnav-item">
            <button class="topnav-toggle">予約サイト設定 ▼</button>
            <div class="topnav-menu">
              <a href="site-settings.html">予約サイト設定</a>
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
            <button class="topbar-user topnav-toggle">
              ${escapeHtml(profile.name)}
              <small>事業者コード: c00000-000001 ▼</small>
            </button>
            <div class="topnav-menu" style="right:0;left:auto;min-width:200px">
              <a href="profile.html">プロフィール編集</a>
              <a href="../" target="_blank">予約サイトを表示 ↗</a>
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
    const placeholder = document.querySelector('[data-include="topbar"]');
    if (placeholder) placeholder.outerHTML = buildTopbar();
    setupDropdowns();
    highlightActive();
    setupLogout();
    checkSession();
  }

  function setupDropdowns() {
    document.querySelectorAll('.topnav-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.topnav-item');
        const isOpen = item.classList.contains('open');
        document.querySelectorAll('.topnav-item.open').forEach(o => o.classList.remove('open'));
        if (!isOpen) item.classList.add('open');
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.topnav-item.open').forEach(o => o.classList.remove('open'));
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.topnav-item.open').forEach(o => o.classList.remove('open'));
      }
    });
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
