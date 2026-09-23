/**
 * グロースレンタカー 管理画面 - ダッシュボード
 * 全拠点を一画面で。拠点フィルタ・拠点別サマリー・未処理アラート・売上・
 * 対応が必要なこと (未対応のお問い合わせ・メール送信/カレンダー同期の失敗)・最近の動き。
 *
 * 日付は日本時間で扱う (SkyRentBackend.jst)。
 * 本番モードの「最近の動き」はサーバーの操作履歴 (admin_recent_activity) を store の notifications に読み込んだもの。
 */
(function () {
  'use strict';
  const S = window.SkyRentStore;
  const B = window.SkyRentBackend;
  const $ = s => document.querySelector(s);
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  const DAY = 86400000;
  let weekChart = null;
  const state = { ymd: '', locationId: '' };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // 拠点セレクト
    $('#loc-filter').innerHTML = '<option value="">全拠点</option>' + S.locations().map(l => '<option value="' + esc(l.locationId) + '">' + esc(l.name) + '</option>').join('');
    $('#loc-filter').addEventListener('change', () => { state.locationId = $('#loc-filter').value; load(); });
    setupDateBar();
    setYmd(todayYmd());
    load();
    loadTodo();
  }

  // ===== 日付 (日本時間の 'YYYY-MM-DD') =====
  function todayYmd() { return B && B.jst ? B.jst.ymd(new Date()) : new Date().toISOString().slice(0, 10); }
  function ymdOf(y, m, d) {
    const t = Date.UTC(y, m - 1, d);
    return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  }
  function addDays(ymd, n) {
    const p = ymd.split('-').map(Number);
    return ymdOf(p[0], p[1], p[2] + n);
  }

  function setupDateBar() {
    $('#date-prev').addEventListener('click', e => { e.preventDefault(); shift(-1); });
    $('#date-next').addEventListener('click', e => { e.preventDefault(); shift(1); });
    $('#date-today').addEventListener('click', e => { e.preventDefault(); setYmd(todayYmd()); load(); });
    $('#btn-search').addEventListener('click', () => {
      const y = +$('#date-y').value, m = +$('#date-m').value, d = +$('#date-d').value;
      if (y && m && d) { setYmd(ymdOf(y, m, d)); load(); loadTodo(); }
    });
    $('#btn-print').addEventListener('click', () => window.print());
  }
  function shift(n) { setYmd(addDays(state.ymd, n)); load(); }
  function setYmd(ymd) {
    if (!ymd) return;
    state.ymd = ymd;
    const p = ymd.split('-').map(Number);
    $('#date-y').value = p[0]; $('#date-m').value = p[1]; $('#date-d').value = p[2];
  }

  async function load() {
    $('#loading').hidden = false;
    try {
      const data = await window.SkyRentAPI.getDashboard(state.ymd, state.locationId || null);
      render(data);
    } catch (e) {
      console.warn('ダッシュボードを表示できませんでした', e && e.message);
      if (B && B.toast) B.toast('ダッシュボードを表示できませんでした。画面を再読み込みしてください。', 'error');
    }
    finally { $('#loading').hidden = true; }
  }

  function locName(id) { const l = S.getLocation(id); return l ? l.name : ''; }

  function render(data) {
    $('#kpi-bookings').textContent = (data.bookings || []).length;
    $('#kpi-depart').textContent = (data.departures || []).length;
    $('#kpi-return').textContent = (data.returns || []).length;
    $('#kpi-sales').textContent = (data.salesMonth || 0).toLocaleString();

    // 拠点別サマリー
    $('#loc-summary').innerHTML = (data.byLocation || []).map(b =>
      '<div class="card" style="padding:10px 12px;cursor:pointer;border-top:2px solid var(--primary)" data-loc="' + esc(b.locationId) + '">' +
      '<div style="font-weight:700;font-size:13px;margin-bottom:6px">' + esc(b.name) + '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:12px"><span>出発 <strong>' + b.departures + '</strong></span><span>帰着 <strong>' + b.returns + '</strong></span><span>貸出中 <strong>' + b.inUse + '</strong></span></div></div>'
    ).join('');
    $('#loc-summary').querySelectorAll('[data-loc]').forEach(el => el.addEventListener('click', () => { state.locationId = el.dataset.loc; $('#loc-filter').value = el.dataset.loc; load(); }));

    // 未処理アラート (貸出停止枠・無断キャンセルは対象外)
    const un = (data.unprocessed || []).filter(r => r.kind !== 'block' && r.status !== 'no_show');
    const card = $('#alert-card');
    card.style.display = 'block';
    if (un.length) {
      card.style.borderLeftColor = '#e54848';
      const now = Date.now();
      card.innerHTML = '<strong style="color:#c0392b">⚠ 未処理の予約 (' + un.length + '件)</strong>' +
        '<table class="data-table" style="margin-top:8px"><thead><tr><th>予約ID</th><th>対象</th><th>拠点</th><th>借受人</th><th>要対応</th></tr></thead><tbody>' +
        un.map(r => {
          const label = r.status === 'confirmed' && Date.parse(r.start) < now ? '出発予定を超過 (貸出処理待ち)' : '返却予定を超過 (返却処理待ち)';
          return '<tr><td><a href="reservation-list.html#' + encodeURIComponent(r.reservationId) + '" class="detail-link"><code>' + esc(r.reservationId) + '</code></a></td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td><td style="color:#c0392b">' + label + '</td></tr>';
        }).join('') +
        '</tbody></table>';
    } else {
      card.style.borderLeftColor = '#1e8a4a';
      card.innerHTML = '<span style="color:#1e8a4a">✓ 未処理の予約はありません。</span>';
    }

    // テーブル
    const rentals = rows => (rows || []).filter(r => r.kind !== 'block');
    fillTable('#tbl-bookings', rentals(data.bookings), 4, r => '<td>' + fmt(r.createdAt || r.start, 'date') + '</td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td>');
    fillTable('#tbl-departures', rentals(data.departures), 5, r => '<td>' + fmt(r.start, 'time') + '</td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td><td><a href="reservation-list.html#' + encodeURIComponent(r.reservationId) + '" class="detail-link">詳細</a></td>');
    fillTable('#tbl-returns', rentals(data.returns), 5, r => '<td>' + fmt(r.end, 'time') + '</td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td><td><a href="reservation-list.html#' + encodeURIComponent(r.reservationId) + '" class="detail-link">詳細</a></td>');
    fillTable('#tbl-shaken', data.shaken, 3, r => '<td>' + esc(r.expireDate) + '</td><td>' + esc(r.vehicleName) + '</td><td style="' + (r.daysLeft < 30 ? 'color:#c0392b;font-weight:700' : '') + '">' + esc(r.daysLeft) + '日</td>');

    renderActivity(data.notifications || []);
    renderChart(data.weekly || []);
  }

  // ===== 最近の動き =====
  function activityLink(n) {
    if (!n.refId) return '';
    const id = encodeURIComponent(n.refId);
    if (n.type === 'reservation' || n.type === 'status') return 'reservation-list.html#' + id;
    if (n.type === 'inquiry') return 'inquiries.html#' + id;
    if (n.type === 'invoice') return 'invoices.html';
    if (n.type === 'member' || n.type === 'coupon') return 'members.html';
    return '';
  }
  function renderActivity(list) {
    const items = (list || []).filter(n => n && n.message).slice(0, 8);
    $('#notif-list').innerHTML = items.length
      ? items.map(n => {
        const href = activityLink(n);
        const text = esc(n.message);
        return '<li><span class="news-date">' + fmt(n.at, 'datetime') + '</span> ' + (href ? '<a href="' + href + '" class="detail-link">' + text + '</a>' : text) + '</li>';
      }).join('')
      : '<li>最近の動きはありません</li>';
  }

  // ===== 対応が必要なこと =====
  async function loadTodo() {
    const newInquiries = S.list('inquiries').filter(q => !q.status || q.status === 'new').length;
    setTodo('#n-inquiries', newInquiries);
    const live = !!(B && B.live);
    if (!live) {
      setTodo('#n-mail-failed', null);
      setTodo('#n-gcal-failed', null);
      $('#todo-note').textContent = 'メール送信・カレンダー同期の失敗件数は、本番接続時に表示されます。';
      return;
    }
    if (!B.admin.can('outbox.read')) {
      $('#todo-mail').hidden = true;
      $('#todo-gcal').hidden = true;
      return;
    }
    const c = B.client;
    const count = r => (r && !r.error ? (typeof r.count === 'number' ? r.count : (Array.isArray(r.data) ? r.data.length : null)) : null);
    try {
      const res = await Promise.all([
        c.from('outbox').select('id', { count: 'exact', head: true }).eq('status', 'failed').neq('template', 'gcal_sync'),
        c.from('outbox').select('id', { count: 'exact', head: true }).eq('status', 'failed').eq('template', 'gcal_sync')
      ]);
      setTodo('#n-mail-failed', count(res[0]));
      setTodo('#n-gcal-failed', count(res[1]));
    } catch (e) {
      setTodo('#n-mail-failed', null);
      setTodo('#n-gcal-failed', null);
      $('#todo-note').textContent = '送信状況の件数を読み込めませんでした。';
    }
  }
  function setTodo(sel, n) {
    const el = $(sel);
    if (!el) return;
    el.textContent = n == null ? '-' : String(n);
    const item = el.closest('.dash-todo-item');
    if (item) item.classList.toggle('is-alert', typeof n === 'number' && n > 0);
  }

  function fillTable(sel, rows, colspan, rowFn) {
    const tb = $(sel); if (!tb) return;
    if (!rows || !rows.length) { tb.innerHTML = '<tr class="empty"><td colspan="' + colspan + '">該当なし</td></tr>'; return; }
    tb.innerHTML = rows.map(r => '<tr>' + rowFn(r) + '</tr>').join('');
  }

  function renderChart(weekly) {
    const ctx = document.getElementById('chart-week'); if (!ctx || typeof window.Chart !== 'function') return;
    if (weekChart) weekChart.destroy();
    weekChart = new window.Chart(ctx, {
      type: 'line',
      data: { labels: weekly.map(w => w.date), datasets: [{ label: '過去1週間の予約受付数', data: weekly.map(w => w.count), fill: true, backgroundColor: 'rgba(78,197,182,.35)', borderColor: '#4ec5b6', tension: .4, pointRadius: 4, pointBackgroundColor: '#4ec5b6' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { boxWidth: 14, font: { size: 11 } } } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } } }, x: { ticks: { font: { size: 11 } } } } }
    });
  }

  // 日本時間で表示。kind: 'date' (MM/DD) / 'time' (HH:MM) / 'datetime' (MM/DD HH:MM)
  function fmt(iso, kind) {
    if (!iso) return '';
    const s = B && B.jst ? B.jst.format(iso, { year: false, weekday: false }) : '';  // 'MM/DD HH:MM'
    if (!s) return '';
    const parts = s.split(' ');
    if (kind === 'date') return esc(parts[0]);
    if (kind === 'time') return esc(parts[1] || '');
    return esc(s);
  }
})();
