/**
 * Sky Rent 管理画面 - 共通パーツ
 *
 * トップナビゲーションを 1 箇所で定義し、各ページに動的に差し込む。
 * (静的サイトでも DRY を実現するための簡易実装)
 */
(function () {
  // 現在ページ判定
  const currentPath = location.pathname.split('/').pop() || 'dashboard.html';

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
            <a href="#" class="locked">予約キャンセル一覧 <span class="lock">🔒</span></a>
            <a href="#" class="locked">車検予約一覧 <span class="lock">🔒</span></a>
            <a href="#" class="locked">点検予約一覧 <span class="lock">🔒</span></a>
          </div>
        </div>
        <div class="topnav-item">
          <button class="topnav-toggle">各種管理 ▼</button>
          <div class="topnav-menu">
            <a href="customers.html">顧客管理</a>
            <a href="#" class="locked">顧客料金種別管理 <span class="lock">🔒</span></a>
            <a href="vehicle-classes.html">クラス管理</a>
            <a href="vehicle-types.html">車種管理</a>
            <a href="vehicles.html">車輌管理</a>
            <a href="#" class="locked">料金プラン管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">オプション管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">定休日管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">ハイシーズン管理 <span class="lock">🔒</span></a>
          </div>
        </div>
        <div class="topnav-item">
          <button class="topnav-toggle">分析 ▼</button>
          <div class="topnav-menu">
            <a href="revenue.html">売上集計</a>
            <a href="#" class="locked">車輌稼働率 <span class="lock">🔒</span></a>
            <a href="#" class="locked">GoogleAnalytics連携設定 <span class="lock">🔒</span></a>
          </div>
        </div>
        <div class="topnav-item">
          <button class="topnav-toggle">社内管理 ▼</button>
          <div class="topnav-menu">
            <a href="stores.html">店舗管理</a>
            <a href="#" class="locked">従業員管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">定期報告書類の印刷 <span class="lock">🔒</span></a>
          </div>
        </div>
        <div class="topnav-item">
          <button class="topnav-toggle">予約サイト設定 ▼</button>
          <div class="topnav-menu">
            <a href="#" class="locked">予約サイト設定 <span class="lock">🔒</span></a>
            <a href="content.html">コンテンツ管理</a>
            <a href="#" class="locked">カスタムページ管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">お知らせ管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">SEO管理 <span class="lock">🔒</span></a>
            <a href="#" class="locked">入力項目管理 <span class="lock">🔒</span></a>
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

  // ページタイトル
  function setPageTitle(title) {
    const h = document.querySelector('[data-page-title]');
    if (h) h.textContent = title;
    document.title = title + ' | Sky Rent 管理画面';
  }

  window.SkyRentAdmin = {
    injectTopbar,
    setPageTitle,
    currentPath
  };

  // 自動でtopbar差し込み
  document.addEventListener('DOMContentLoaded', injectTopbar);
})();
