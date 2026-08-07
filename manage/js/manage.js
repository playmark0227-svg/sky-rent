/**
 * グロースレンタカー 管理画面 - ダッシュボード
 * 全4拠点を一画面で。拠点フィルタ・拠点別サマリー・未処理アラート・売上・自動通知ログ。
 */
(function () {
  const S = window.SkyRentStore;
  const $ = s => document.querySelector(s);
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  let weekChart = null;
  const state = { date: new Date(), locationId: '' };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // 拠点セレクト
    $('#loc-filter').innerHTML = '<option value="">全拠点</option>' + S.locations().map(l => '<option value="' + l.locationId + '">' + esc(l.name) + '</option>').join('');
    $('#loc-filter').addEventListener('change', () => { state.locationId = $('#loc-filter').value; load(); });
    setupDateBar();
    setDate(new Date());
    load();
  }

  function setupDateBar() {
    $('#date-prev').addEventListener('click', e => { e.preventDefault(); shift(-1); });
    $('#date-next').addEventListener('click', e => { e.preventDefault(); shift(1); });
    $('#date-today').addEventListener('click', e => { e.preventDefault(); setDate(new Date()); load(); });
    $('#btn-search').addEventListener('click', () => {
      const y = +$('#date-y').value, m = +$('#date-m').value, d = +$('#date-d').value;
      if (y && m && d) { setDate(new Date(y, m - 1, d)); load(); }
    });
    $('#btn-print').addEventListener('click', () => window.print());
  }
  function shift(n) { const d = new Date(state.date); d.setDate(d.getDate() + n); setDate(d); load(); }
  function setDate(date) { state.date = date; $('#date-y').value = date.getFullYear(); $('#date-m').value = date.getMonth() + 1; $('#date-d').value = date.getDate(); }

  async function load() {
    $('#loading').hidden = false;
    try {
      const d = state.date;
      const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const data = await window.SkyRentAPI.getDashboard(dateStr, state.locationId || null);
      render(data);
    } catch (e) { console.error(e); alert('データ取得に失敗: ' + e.message); }
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
      '<div class="card" style="padding:10px 12px;cursor:pointer;border-top:2px solid var(--primary)" data-loc="' + b.locationId + '">' +
      '<div style="font-weight:700;font-size:13px;margin-bottom:6px">' + esc(b.name) + '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:12px"><span>出発 <strong>' + b.departures + '</strong></span><span>帰着 <strong>' + b.returns + '</strong></span><span>貸出中 <strong>' + b.inUse + '</strong></span></div></div>'
    ).join('');
    $('#loc-summary').querySelectorAll('[data-loc]').forEach(el => el.addEventListener('click', () => { state.locationId = el.dataset.loc; $('#loc-filter').value = el.dataset.loc; load(); }));

    // 未処理アラート
    const un = data.unprocessed || [];
    if (un.length) {
      $('#alert-card').style.display = 'block';
      $('#alert-card').innerHTML = '<strong style="color:#c0392b">⚠ 未処理の予約 (' + un.length + '件)</strong>' +
        '<table class="data-table" style="margin-top:8px"><thead><tr><th>予約ID</th><th>対象</th><th>拠点</th><th>借受人</th><th>要対応</th></tr></thead><tbody>' +
        un.map(r => { const now = new Date(); const label = r.status === 'confirmed' && new Date(r.start) < now ? '出発予定を超過 (貸出処理待ち)' : '返却予定を超過 (返却処理待ち)';
          return '<tr><td><a href="reservation-list.html#' + r.reservationId + '" class="detail-link"><code>' + esc(r.reservationId) + '</code></a></td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td><td style="color:#c0392b">' + label + '</td></tr>'; }).join('') +
        '</tbody></table>';
    } else {
      $('#alert-card').style.display = 'block';
      $('#alert-card').style.borderLeftColor = '#1e8a4a';
      $('#alert-card').innerHTML = '<span style="color:#1e8a4a">✓ 未処理の予約はありません。</span>';
    }

    // テーブル
    fillTable('#tbl-bookings', data.bookings, 4, r => '<td>' + fmt(r.createdAt || r.start, 'M/d') + '</td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td>');
    fillTable('#tbl-departures', data.departures, 5, r => '<td>' + fmt(r.start, 'HH:mm') + '</td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td><td><a href="reservation-list.html#' + r.reservationId + '" class="detail-link">詳細</a></td>');
    fillTable('#tbl-returns', data.returns, 5, r => '<td>' + fmt(r.end, 'HH:mm') + '</td><td>' + esc(r.assetName || r.vehicleName) + '</td><td>' + esc(locName(r.locationId)) + '</td><td>' + esc(r.customerName) + '</td><td><a href="reservation-list.html#' + r.reservationId + '" class="detail-link">詳細</a></td>');
    fillTable('#tbl-shaken', data.shaken, 3, r => '<td>' + esc(r.expireDate) + '</td><td>' + esc(r.vehicleName) + '</td><td style="' + (r.daysLeft < 30 ? 'color:#c0392b;font-weight:700' : '') + '">' + r.daysLeft + '日</td>');

    // 通知ログ
    const notifs = data.notifications || [];
    $('#notif-list').innerHTML = notifs.length
      ? notifs.map(n => '<li><span class="news-date">' + fmt(n.at, 'M/d HH:mm') + '</span> ' + esc(n.message) + '</li>').join('')
      : '<li>通知はありません</li>';

    renderChart(data.weekly || []);
  }

  function fillTable(sel, rows, colspan, rowFn) {
    const tb = $(sel); if (!tb) return;
    if (!rows || !rows.length) { tb.innerHTML = '<tr class="empty"><td colspan="' + colspan + '">該当なし</td></tr>'; return; }
    tb.innerHTML = rows.map(r => '<tr>' + rowFn(r) + '</tr>').join('');
  }

  function renderChart(weekly) {
    const ctx = document.getElementById('chart-week'); if (!ctx) return;
    if (weekChart) weekChart.destroy();
    weekChart = new Chart(ctx, {
      type: 'line',
      data: { labels: weekly.map(w => w.date), datasets: [{ label: '過去1週間の予約受付数', data: weekly.map(w => w.count), fill: true, backgroundColor: 'rgba(78,197,182,.35)', borderColor: '#4ec5b6', tension: .4, pointRadius: 4, pointBackgroundColor: '#4ec5b6' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { boxWidth: 14, font: { size: 11 } } } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } } }, x: { ticks: { font: { size: 11 } } } } }
    });
  }

  function fmt(iso, f) {
    if (!iso) return '';
    const d = new Date(iso), p = n => String(n).padStart(2, '0');
    return f.replace('M', p(d.getMonth() + 1)).replace('d', p(d.getDate())).replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes()));
  }
})();
