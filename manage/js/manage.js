/**
 * Sky Rent 管理画面 - ダッシュボード
 *
 * - トップナビ ドロップダウン
 * - 日付選択 (前日/本日/翌日 + 検索)
 * - KPI 3カード
 * - 過去1週間 折れ線チャート (Chart.js)
 * - 当日出発/帰着リスト
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let weekChart = null;
  const state = { date: new Date() };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setupDateBar();
    setDate(new Date());
    loadDashboard();
  }

  // ===== 日付バー =====
  function setupDateBar() {
    $('#date-prev').addEventListener('click', (e) => {
      e.preventDefault(); shiftDate(-1);
    });
    $('#date-next').addEventListener('click', (e) => {
      e.preventDefault(); shiftDate(1);
    });
    $('#date-today').addEventListener('click', (e) => {
      e.preventDefault(); setDate(new Date()); loadDashboard();
    });
    $('#btn-search').addEventListener('click', () => {
      const y = +$('#date-y').value;
      const m = +$('#date-m').value;
      const d = +$('#date-d').value;
      if (y && m && d) {
        const date = new Date(y, m - 1, d);
        setDate(date);
        loadDashboard();
      }
    });
    $('#btn-print').addEventListener('click', () => {
      window.print();
    });
  }

  function shiftDate(days) {
    const d = new Date(state.date);
    d.setDate(d.getDate() + days);
    setDate(d);
    loadDashboard();
  }

  function setDate(date) {
    state.date = date;
    $('#date-y').value = date.getFullYear();
    $('#date-m').value = date.getMonth() + 1;
    $('#date-d').value = date.getDate();
  }

  // ===== ダッシュボード読み込み =====
  async function loadDashboard() {
    showLoading();
    try {
      const d = state.date;
      const dateStr = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      const data = await window.SkyRentAPI.getDashboard(dateStr);
      render(data);
    } catch (err) {
      console.error('ダッシュボード読み込み失敗', err);
      alert('データの取得に失敗しました: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  function render(data) {
    // KPI
    $('#kpi-bookings').textContent = (data.bookings || []).length;
    $('#kpi-depart').textContent = (data.departures || []).length;
    $('#kpi-return').textContent = (data.returns || []).length;

    // 予約された件数テーブル (過去1週間に登録された分)
    renderTable('#tbl-bookings', data.bookings, 4, (r) => `
      <td>${formatDate(new Date(r.start), 'M/d')}</td>
      <td>${escapeHtml(r.vehicleName)}</td>
      <td>${escapeHtml(r.vehicleId)}</td>
      <td>${escapeHtml(r.customerName)}</td>
    `);

    // 出発予約 (時刻順)
    renderTable('#tbl-departures', data.departures, 5, (r) => `
      <td>${formatDate(new Date(r.start), 'HH:mm')}</td>
      <td>${escapeHtml(r.vehicleName)}</td>
      <td>${escapeHtml(r.vehicleId)}</td>
      <td>${escapeHtml(r.customerName)}</td>
      <td><a href="reservation-list.html#${r.reservationId}" class="detail-link">詳細</a></td>
    `);

    // 帰着予約
    renderTable('#tbl-returns', data.returns, 5, (r) => `
      <td>${formatDate(new Date(r.end), 'HH:mm')}</td>
      <td>${escapeHtml(r.vehicleName)}</td>
      <td>${escapeHtml(r.vehicleId)}</td>
      <td>${escapeHtml(r.customerName)}</td>
      <td><a href="reservation-list.html#${r.reservationId}" class="detail-link">詳細</a></td>
    `);

    // 車検テーブル
    renderTable('#tbl-shaken', data.shaken, 3, (r) => `
      <td>${escapeHtml(r.expireDate || '')}</td>
      <td>${escapeHtml(r.vehicleName || '')}</td>
      <td>${escapeHtml(r.plate || '')}</td>
    `);

    // 折れ線チャート
    renderWeeklyChart(data.weekly || []);
  }

  function renderTable(sel, rows, colspan, rowFn) {
    const tbody = document.querySelector(sel);
    if (!tbody) return;
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr class="empty"><td colspan="${colspan}">該当する予約はありません</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => '<tr>' + rowFn(r) + '</tr>').join('');
  }

  function renderWeeklyChart(weekly) {
    const ctx = document.getElementById('chart-week');
    if (!ctx) return;
    const labels = weekly.map(w => w.date);
    const data = weekly.map(w => w.count);

    if (weekChart) weekChart.destroy();
    weekChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '過去 1週間の登録数',
          data,
          fill: true,
          backgroundColor: 'rgba(78,197,182,0.35)',
          borderColor: '#4ec5b6',
          tension: 0.4,
          pointBackgroundColor: '#4ec5b6',
          pointBorderColor: '#4ec5b6',
          pointRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'center',
            labels: { boxWidth: 14, font: { size: 11 } }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { stepSize: 1, font: { size: 11 } }
          },
          x: { ticks: { font: { size: 11 } } }
        }
      }
    });
  }

  // ===== ユーティリティ =====
  function showLoading() { $('#loading').hidden = false; }
  function hideLoading() { $('#loading').hidden = true; }

  function formatDate(d, fmt) {
    const Y = d.getFullYear();
    const M = d.getMonth() + 1;
    const D = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return fmt
      .replace('Y', Y)
      .replace('M', String(M).padStart(2, '0'))
      .replace('d', String(D).padStart(2, '0'))
      .replace('HH', h)
      .replace('mm', m);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
