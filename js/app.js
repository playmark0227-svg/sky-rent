/**
 * グロースレンタカー - メインアプリ (1ページ ステップ遷移)
 *
 * 状態を 1 つの object で持ち、各ステップを切り替える。
 *   step-search    -> 日時選択
 *   step-vehicles  -> 車両選択 (空き状況込み)
 *   step-form      -> 顧客情報入力
 *   step-complete  -> 完了
 */
(function () {
  const state = {
    start: null,        // ISO string
    end: null,          // ISO string
    vehicles: [],       // [{ vehicleId, name, ... }]
    availability: [],   // [{ vehicleId, available, conflictReason? }]
    selectedVehicle: null
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ===== 初期化 =====
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setDefaultDates();
    $('#btn-search').addEventListener('click', onSearch);
    $('#reservation-form').addEventListener('submit', onSubmit);
    $$('[data-back]').forEach(el => el.addEventListener('click', () => goStep(el.dataset.back)));

    // GAS未設定の場合は警告
    if (!window.SkyRentAPI.isConfigured) {
      console.warn('[グロースレンタカー] GAS_URL 未設定。モック動作中です。');
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#fff3cd;color:#856404;padding:8px;text-align:center;font-size:13px;border-bottom:1px solid #ffeaa7';
      banner.textContent = 'デモモード: js/config.js の GAS_URL を設定すると本番動作します';
      document.body.prepend(banner);
    }
  }

  function setDefaultDates() {
    // デフォルト: 明日 10:00 〜 明後日 10:00
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    $('#start').value = toLocalDatetimeInput(tomorrow);
    $('#end').value = toLocalDatetimeInput(dayAfter);
  }

  // ===== STEP 1: 検索 =====
  async function onSearch() {
    hideError('#search-error');
    const startInput = $('#start').value;
    const endInput = $('#end').value;
    if (!startInput || !endInput) {
      return showError('#search-error', '貸出日時と返却日時を入力してください');
    }
    const start = new Date(startInput);
    const end = new Date(endInput);
    if (end <= start) {
      return showError('#search-error', '返却日時は貸出日時より後にしてください');
    }
    if (start < new Date(Date.now() - 60 * 60 * 1000)) {
      return showError('#search-error', '過去の日時は指定できません');
    }

    state.start = start.toISOString();
    state.end = end.toISOString();

    showLoading('空き状況を確認中...');
    try {
      const [vehicles, availability] = await Promise.all([
        window.SkyRentAPI.listVehicles(),
        window.SkyRentAPI.checkAvailability(state.start, state.end)
      ]);
      state.vehicles = vehicles;
      state.availability = availability;
      renderVehicles();
      goStep('vehicles');
    } catch (err) {
      showError('#search-error', '検索に失敗しました: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  // ===== STEP 2: 車両選択 =====
  function renderVehicles() {
    const start = new Date(state.start);
    const end = new Date(state.end);
    const days = Math.ceil((end - start) / (24 * 60 * 60 * 1000));

    $('#search-summary').innerHTML =
      `<strong>${formatDate(start)}</strong> 〜 <strong>${formatDate(end)}</strong>` +
      ` (${days}日間)`;

    const list = $('#vehicle-list');
    if (!state.vehicles.length) {
      list.innerHTML = '<p style="text-align:center;color:#666">車両情報を取得できませんでした</p>';
      return;
    }

    const availMap = {};
    state.availability.forEach(a => { availMap[a.vehicleId] = a; });

    list.innerHTML = state.vehicles.map(v => {
      const a = availMap[v.vehicleId] || { available: true };
      const total = (Number(v.pricePerDay) || 0) * days;
      return `
        <div class="vehicle-card ${a.available ? 'available' : 'unavailable'}">
          <div class="vehicle-img">${vehicleIcon(v.class)}</div>
          <div class="vehicle-body">
            <div class="vehicle-name">${escapeHtml(v.name)}</div>
            <div class="vehicle-meta">${escapeHtml(v.class || '')} / 定員 ${v.capacity || '-'}名</div>
            ${a.available
              ? '<span class="vehicle-status ok">予約可</span>'
              : `<span class="vehicle-status ng">予約不可</span><div class="vehicle-meta" style="font-size:12px">${escapeHtml(a.conflictReason || '')}</div>`}
            <div class="vehicle-price">¥${total.toLocaleString()} <small>/ ${days}日 (¥${(Number(v.pricePerDay)||0).toLocaleString()}/日)</small></div>
          </div>
          ${a.available
            ? `<button class="btn btn-primary" data-vehicle="${escapeHtml(v.vehicleId)}">この車両を選ぶ</button>`
            : '<button class="btn btn-secondary" disabled>選択不可</button>'}
        </div>`;
    }).join('');

    list.querySelectorAll('button[data-vehicle]').forEach(btn => {
      btn.addEventListener('click', () => onSelectVehicle(btn.dataset.vehicle));
    });
  }

  function onSelectVehicle(vehicleId) {
    const v = state.vehicles.find(x => String(x.vehicleId) === String(vehicleId));
    if (!v) return;
    state.selectedVehicle = v;
    renderSummary();
    goStep('form');
  }

  function renderSummary() {
    const start = new Date(state.start);
    const end = new Date(state.end);
    const days = Math.ceil((end - start) / (24 * 60 * 60 * 1000));
    const v = state.selectedVehicle;
    const total = (Number(v.pricePerDay) || 0) * days;

    $('#summary-dl').innerHTML = `
      <dt>車両</dt><dd>${escapeHtml(v.name)}</dd>
      <dt>貸出</dt><dd>${formatDate(start)}</dd>
      <dt>返却</dt><dd>${formatDate(end)}</dd>
      <dt>日数</dt><dd>${days}日</dd>
      <dt>料金</dt><dd><strong>¥${total.toLocaleString()}</strong></dd>
    `;
  }

  // ===== STEP 3: 予約送信 =====
  async function onSubmit(e) {
    e.preventDefault();
    hideError('#submit-error');

    const payload = {
      vehicleId: state.selectedVehicle.vehicleId,
      customerName: $('#customerName').value.trim(),
      customerEmail: $('#customerEmail').value.trim(),
      customerPhone: $('#customerPhone').value.trim(),
      start: state.start,
      end: state.end,
      note: $('#note').value.trim()
    };

    showLoading('予約を確定しています...');
    try {
      const result = await window.SkyRentAPI.createReservation(payload);
      renderComplete(result);
      goStep('complete');
    } catch (err) {
      showError('#submit-error', '予約失敗: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  function renderComplete(result) {
    $('#complete-dl').innerHTML = `
      <dt>予約ID</dt><dd>${escapeHtml(result.reservationId)}</dd>
      <dt>車両</dt><dd>${escapeHtml(result.vehicleName)}</dd>
      <dt>貸出</dt><dd>${formatDate(new Date(result.start))}</dd>
      <dt>返却</dt><dd>${formatDate(new Date(result.end))}</dd>
    `;
  }

  // ===== ステップ遷移 =====
  function goStep(name) {
    $$('.step-pane').forEach(p => p.classList.remove('active'));
    const pane = $('#step-' + name);
    if (pane) pane.classList.add('active');
    pane && pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ===== ユーティリティ =====
  function showError(sel, msg) {
    const el = $(sel);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function hideError(sel) {
    const el = $(sel);
    if (el) el.hidden = true;
  }
  function showLoading(text) {
    $('#loading-text').textContent = text || '処理中...';
    $('#loading').hidden = false;
  }
  function hideLoading() {
    $('#loading').hidden = true;
  }
  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${da} ${h}:${mi}`;
  }
  function toLocalDatetimeInput(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${da}T${h}:${mi}`;
  }
  function vehicleIcon(cls) {
    const c = String(cls || '');
    if (c.indexOf('ミニバン') >= 0) return '🚐';
    if (c.indexOf('SUV') >= 0) return '🚙';
    if (c.indexOf('コンパクト') >= 0) return '🚗';
    return '🚘';
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
