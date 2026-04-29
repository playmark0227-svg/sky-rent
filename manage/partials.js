/**
 * Sky Rent 管理画面 - 共通パーツ (トップナビ)
 *
 * 全ページで共通の トップナビ を 1 箇所で定義し、各ページに動的に差し込む。
 */
(function () {
  const TOPBAR_HTML = `
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
          <a href="#">▶請求情報</a>
          <a href="#">▶お問合せ</a>
          <a href="#">▶よくあるご質問(FAQ)</a>
        </div>
        <div class="topbar-user">
          Sky Rent STD+ 山田太郎
          <small>事業者コード: c00000-000001 ▼</small>
        </div>
      </div>
    </div>
  </header>`;

  function injectTopbar() {
    const placeholder = document.querySelector('[data-include="topbar"]');
    if (placeholder) {
      placeholder.outerHTML = TOPBAR_HTML;
    }
    setupDropdowns();
    highlightActive();
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
  }

  function highlightActive() {
    const path = location.pathname.split('/').pop() || 'dashboard.html';
    document.querySelectorAll('.topnav-menu a').forEach(a => {
      if (a.getAttribute('href') === path) {
        a.classList.add('active');
        // 親のトグルもアクティブ表示
        const item = a.closest('.topnav-item');
        if (item) item.classList.add('current');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', injectTopbar);
})();
