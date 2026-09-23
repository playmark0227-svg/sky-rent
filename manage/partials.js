/**
 * グロースレンタカー 管理画面 - 共通パーツ (トップナビ + ユーザーメニュー)
 *
 * 全ページ共通のヘッダー (ナビゲーション・ユーザーメニュー) を 1 箇所で定義し、
 * 各ページに動的に差し込む。
 * モバイルではハンバーガーメニュー (ドロワー) に自動切替。
 *
 * 本番モード (SkyRentBackend.live):
 *   - ログイン中のスタッフ (SkyRentBackend.admin.staff) の名前・役割を表示する
 *     (データの読み込み = SkyRentBackend.ready の後に反映)
 *   - 権限の無いメニュー項目は隠す (SkyRentBackend.admin.can。サーバー側でも同じ権限で拒否される)
 *   - デモ専用の「従業員管理」は出さない (スタッフのアカウントと権限は「スタッフ・権限」に一本化)
 *   - ユーザーメニューの「アカウント」(profile.html) でパスワード変更・二段階認証の案内
 *   - ログアウトは Supabase のセッションを終了してログイン画面へ
 * デモモード:
 *   - 従来どおり、ログインしていなければデモ用のセッションを自動で作る
 */
(function () {
  'use strict';

  const ROLE_LABELS = {
    admin: '管理者', store_staff: '店舗スタッフ', accounting: '経理', maintenance: '整備担当', viewer: '閲覧のみ'
  };

  // [リンク先, 表示名, 必要な権限, 'demo' = デモモードだけ出す]
  //   従業員管理 (employees.html) は端末内のデモ用の一覧。本番のスタッフのアカウントと権限は「スタッフ・権限」で管理する
  const NAV = [
    {
      label: '予約管理',
      items: [
        ['dashboard.html', 'ダッシュボード', 'read'],
        ['reservation-table.html', '貸渡予約表 (ガント)', 'read'],
        ['reservation-list.html', '予約一覧', 'read'],
        ['forms.html', '帳票出力 (貸渡証・領収書等)', 'read'],
        ['reservation-cancellations.html', '予約キャンセル一覧', 'read'],
        ['shaken-list.html', '車検予約一覧', 'read'],
        ['inspection-list.html', '点検予約一覧', 'read'],
        ['inquiries.html', 'お問い合わせ', 'read']
      ]
    },
    {
      label: '各種管理',
      items: [
        ['categories.html', 'カテゴリ管理 (カスタム項目)', 'read'],
        ['vehicles.html', '車両・物品管理', 'read'],
        ['options.html', 'オプション管理', 'read'],
        ['members.html', '顧客・会員管理', 'read'],
        ['invoices.html', '請求書管理', 'read'],
        ['customer-rates.html', '顧客料金種別管理', 'read'],
        ['price-plans.html', '料金プラン管理', 'read'],
        ['holidays.html', '定休日管理', 'read'],
        ['high-season.html', 'ハイシーズン管理', 'read']
      ]
    },
    {
      label: '分析',
      items: [
        ['revenue.html', '売上集計', 'read'],
        ['utilization.html', '車輌稼働率', 'read'],
        ['ga-integration.html', 'GoogleAnalytics連携設定', 'settings.write']
      ]
    },
    {
      label: '社内管理',
      items: [
        ['stores.html', '店舗管理', 'read'],
        ['employees.html', '従業員管理', 'read', 'demo'],
        ['rental-report.html', '貸渡実績報告書 (陸運局)', 'read'],
        ['reports-print.html', '定期報告書類の印刷', 'read']
      ]
    },
    {
      label: '予約サイト設定',
      items: [
        ['site-settings.html', '予約サイト設定', 'settings.write'],
        ['points.html', 'ポイント・クーポン設定', 'settings.write'],
        ['content.html', 'コンテンツ管理', 'content.write'],
        ['custom-pages.html', 'カスタムページ管理', 'content.write'],
        ['notices.html', 'お知らせ管理', 'content.write'],
        ['seo.html', 'SEO管理', 'settings.write'],
        ['input-fields.html', '入力項目管理', 'settings.write']
      ]
    },
    {
      label: 'システム',
      items: [
        ['mail-log.html', 'メール送信状況', 'outbox.read'],
        ['calendar.html', 'Googleカレンダー連携', 'settings.write'],
        ['staff.html', 'スタッフ・権限', 'staff.write'],
        ['audit.html', '操作履歴', 'audit.read'],
        ['contact.html', 'システムについてのお問合せ・手順書', 'read']
      ]
    }
  ];

  function backend() { return window.SkyRentBackend || null; }
  function isLive() { const B = backend(); return !!(B && B.live); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ヘッダーに出す名前と役割
  //   本番: SkyRentBackend.admin.staff (読み込み前は null)
  //   デモ: プロフィール設定 (store 経由) の名前
  function currentUser() {
    const B = backend();
    if (isLive()) {
      const st = B.admin && B.admin.staff;
      if (!st) return null;
      return { name: st.name || st.email || 'スタッフ', role: ROLE_LABELS[st.role] || st.role || '' };
    }
    let p = {};
    try {
      const S = window.SkyRentStore;
      p = (S && typeof S.read === 'function' ? S.read('settings.profile', {}) : {}) || {};
    } catch (e) { p = {}; }
    return { name: p.name || '山田 太郎', role: '管理者 (デモ)' };
  }

  // 本番では、デモ専用の項目 (4番目が 'demo') をメニューに出さない
  function navItems(group) {
    const live = isLive();
    return group.items.filter(it => !(live && it[3] === 'demo'));
  }

  function navHtml() {
    return NAV.map(group => `
          <div class="topnav-item" data-nav-group>
            <button class="topnav-toggle" aria-haspopup="true" aria-expanded="false">${escapeHtml(group.label)} <span class="caret">▼</span></button>
            <div class="topnav-menu">
              ${navItems(group).map(it => `<a href="${escapeHtml(it[0])}" data-perm="${escapeHtml(it[2])}">${escapeHtml(it[1])}</a>`).join('\n              ')}
            </div>
          </div>`).join('');
  }

  function buildTopbar() {
    const user = currentUser();
    const live = isLive();
    return `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="dashboard.html">
          <span class="brand-mark">G</span>
          <span class="brand-sub">グロースレンタカー<br><small>管理画面</small></span>
        </a>

        <button class="nav-burger" type="button" aria-label="メニューを開く" aria-expanded="false" aria-controls="topnav">
          <span class="nav-burger-bar"></span>
          <span class="nav-burger-bar"></span>
          <span class="nav-burger-bar"></span>
        </button>

        <nav class="topnav" id="topnav">${navHtml()}
        </nav>

        <div class="topbar-right">
          <div class="topbar-links">
            <a href="billing.html">▶請求情報</a>
            <a href="faq.html">▶よくあるご質問(FAQ)</a>
          </div>
          <div class="topnav-item user-menu">
            <button class="topbar-user topnav-toggle" aria-haspopup="true" aria-expanded="false">
              <span id="topbar-staff-name">${escapeHtml(user ? user.name : '読み込み中…')}</span>
              <small><span id="topbar-staff-role">${escapeHtml(user ? user.role : '')}</span> ▼</small>
            </button>
            <div class="topnav-menu" style="right:0;left:auto;min-width:220px">
              ${live ? '<a href="profile.html">アカウント (パスワード・二段階認証)</a>' : '<a href="profile.html">プロフィール編集</a>'}
              <a href="../" target="_blank" rel="noopener">予約サイトを表示 ↗</a>
              <a href="../docs/index.html" target="_blank" rel="noopener">システムドキュメント ↗</a>
              <a href="#" id="topbar-logout" style="color:#c0392b">ログアウト</a>
            </div>
          </div>
        </div>
      </div>
    </header>`;
  }

  function injectTopbar() {
    injectFavicon();
    const placeholder = document.querySelector('[data-include="topbar"]');
    if (placeholder) placeholder.outerHTML = buildTopbar();
    applyPermissions();
    setupDropdowns();
    setupMobileNav();
    highlightActive();
    setupLogout();
    checkSession();
    watchStaff();
  }

  // ===== 権限に応じたメニューの表示 =====
  //   本番でスタッフ情報が読めていない間 (読み込み中・接続失敗) は、閲覧 (read) の項目だけ出す
  function canSee(perm) {
    const B = backend();
    if (!isLive()) return true;
    const st = B.admin && B.admin.staff;
    if (!st) return perm === 'read';
    return typeof B.admin.can === 'function' ? !!B.admin.can(perm) : false;
  }

  function applyPermissions() {
    document.querySelectorAll('.topnav-menu a[data-perm]').forEach(a => {
      a.hidden = !canSee(a.getAttribute('data-perm'));
      a.style.display = a.hidden ? 'none' : '';
    });
    document.querySelectorAll('[data-nav-group]').forEach(g => {
      const visible = Array.prototype.some.call(g.querySelectorAll('.topnav-menu a[data-perm]'), a => !a.hidden);
      g.hidden = !visible;
      g.style.display = visible ? '' : 'none';
    });
  }

  function renderUser() {
    const user = currentUser();
    const name = document.getElementById('topbar-staff-name');
    const role = document.getElementById('topbar-staff-role');
    if (name) name.textContent = user ? user.name : 'ログイン情報を確認できません';
    if (role) role.textContent = user ? user.role : '';
  }

  // 本番は、データの読み込み (スタッフ情報の確定) を待ってから名前・権限を反映する
  function watchStaff() {
    const B = backend();
    if (!isLive() || !B.ready || typeof B.ready.then !== 'function') return;
    B.ready.then(() => { renderUser(); applyPermissions(); }, () => { renderUser(); applyPermissions(); });
  }

  // ===== favicon / テーマカラー (全ページ共通の見た目) =====
  function injectFavicon() {
    if (document.querySelector('link[rel="icon"]')) return;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c4a7a"/><text x="32" y="46" font-size="40" text-anchor="middle" fill="#ffffff" font-family="serif" font-weight="bold">G</text></svg>';
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

  let loggingOut = false;
  function setupLogout() {
    const lo = document.querySelector('#topbar-logout');
    if (!lo) return;
    lo.addEventListener('click', async e => {
      e.preventDefault();
      if (loggingOut) return;
      if (!confirm('ログアウトしますか?')) return;
      loggingOut = true;
      const B = backend();
      try {
        if (B && B.admin && typeof B.admin.signOut === 'function') await B.admin.signOut();
        else sessionStorage.removeItem('sky-rent.session');
      } catch (err) {
        // サーバーに届かなくても、この端末のログイン状態は消えている (supabase-js がローカルを先に消す)
        console.warn('ログアウトの通知に失敗しました', err && err.code);
      }
      location.href = 'login.html';
    });
  }

  // デモ用: ログインしていなければデモのセッションを自動で作る (本番では何もしない)
  function checkSession() {
    if (isLive()) return;
    if (location.pathname.endsWith('login.html')) return;
    try {
      if (!sessionStorage.getItem('sky-rent.session')) {
        sessionStorage.setItem('sky-rent.session', JSON.stringify({
          userId: 'demo',
          loginAt: new Date().toISOString()
        }));
      }
    } catch (e) { /* 続行 */ }
  }

  // 他のページ (新規の管理画面) から権限の表示名を使えるようにする
  window.SkyRentManageNav = { roleLabels: ROLE_LABELS, nav: NAV, refresh: () => { renderUser(); applyPermissions(); } };

  document.addEventListener('DOMContentLoaded', injectTopbar);
})();
