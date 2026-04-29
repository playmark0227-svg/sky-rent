/**
 * Sky Rent 管理画面 - 汎用 CRUD ライブラリ
 *
 * localStorage をバックエンドに、テーブル表示・追加・編集・削除 を一括提供。
 * 各ページは設定オブジェクトを 1 つ渡すだけで実装できる。
 *
 * 使い方:
 *   <table>...<tbody id="tbl"></tbody></table>
 *   <button id="btn-add">+ 追加</button>
 *   <script src="js/crud.js"></script>
 *   <script>
 *     SkyRentCRUD.init({
 *       storageKey: 'sky-rent.options',
 *       tableSelector: '#tbl',
 *       addButton: '#btn-add',
 *       columns: [
 *         { key: 'id', label: 'ID', code: true, readonly: true },
 *         { key: 'name', label: '名称', required: true },
 *         { key: 'price', label: '料金', type: 'number', format: yen },
 *         { key: 'unit', label: '課金単位', type: 'select', options: ['1日','1回','無制限'] },
 *         { key: 'active', label: '状態', type: 'status' }
 *       ],
 *       defaults: [...]   // 初回のみ投入
 *     });
 *   </script>
 */
(function () {
  const STORE_PREFIX = 'sky-rent.';

  function load(key, defaults) {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    if (raw == null) {
      // 初回: 既定値を保存
      if (defaults && defaults.length) {
        localStorage.setItem(STORE_PREFIX + key, JSON.stringify(defaults));
        return defaults.slice();
      }
      return [];
    }
    try { return JSON.parse(raw); } catch (e) { return []; }
  }
  function save(key, list) {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(list));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatCell(val, col, row) {
    if (col.format) {
      const r = col.format(val, row);
      if (r) return r;
    }
    if (val == null || val === '') return '<span style="color:#aaa">-</span>';
    if (col.code) return `<code>${escapeHtml(val)}</code>`;
    if (col.type === 'status') {
      const yes = val === true || val === 'true' || val === '有効' || val === '公開';
      const cls = yes ? 'status-confirmed' : 'status-cancelled';
      const label = col.statusLabel ? col.statusLabel(val) : (yes ? '有効' : '無効');
      return `<span class="status ${cls}">${escapeHtml(label)}</span>`;
    }
    if (col.type === 'percent') return escapeHtml(val) + '%';
    if (col.type === 'yen') return '¥' + Number(val).toLocaleString();
    if (col.type === 'date') {
      const d = new Date(val); if (isNaN(d)) return escapeHtml(val);
      return d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0');
    }
    if (col.type === 'checkbox') return val ? '✓' : '';
    if (col.type === 'select' && col.options) {
      // val がそのまま表示
      return escapeHtml(val);
    }
    if (col.bold) return `<strong>${escapeHtml(val)}</strong>`;
    return escapeHtml(val);
  }

  function generateId(prefix, list, idField) {
    idField = idField || 'id';
    let n = 1;
    while (list.some(x => x[idField] === prefix + String(n).padStart(3, '0'))) n++;
    return prefix + String(n).padStart(3, '0');
  }

  function showModal(html) {
    let modal = document.getElementById('crud-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'crud-modal';
      modal.className = 'crud-modal';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `<div class="crud-modal-bg"></div><div class="crud-modal-card">${html}</div>`;
    modal.querySelector('.crud-modal-bg').addEventListener('click', closeModal);
  }
  function closeModal() {
    const m = document.getElementById('crud-modal');
    if (m) m.remove();
  }

  function buildEditForm(item, columns) {
    const fields = columns.filter(col => !col.derived).map(col => {
      if (col.readonly) {
        return `<div class="crud-field">
          <label>${escapeHtml(col.label)}</label>
          <input type="text" name="${col.key}" value="${escapeHtml(item[col.key] || '')}" readonly style="background:#f5f5f5">
        </div>`;
      }
      if (col.type === 'select') {
        return `<div class="crud-field">
          <label>${escapeHtml(col.label)}${col.required?' <span style="color:#c0392b">*</span>':''}</label>
          <select name="${col.key}">
            ${col.options.map(o => `<option ${item[col.key]===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}
          </select>
        </div>`;
      }
      if (col.type === 'textarea') {
        return `<div class="crud-field">
          <label>${escapeHtml(col.label)}</label>
          <textarea name="${col.key}" rows="3">${escapeHtml(item[col.key] || '')}</textarea>
        </div>`;
      }
      if (col.type === 'checkbox') {
        return `<div class="crud-field">
          <label class="inline"><input type="checkbox" name="${col.key}" ${item[col.key]?'checked':''}> ${escapeHtml(col.label)}</label>
        </div>`;
      }
      if (col.type === 'status') {
        return `<div class="crud-field">
          <label>${escapeHtml(col.label)}</label>
          <select name="${col.key}">
            <option value="true" ${item[col.key]===true||item[col.key]==='true'?'selected':''}>有効</option>
            <option value="false" ${item[col.key]===false||item[col.key]==='false'?'selected':''}>無効</option>
          </select>
        </div>`;
      }
      const t = col.type === 'number' ? 'number' :
                col.type === 'date' ? 'date' :
                col.type === 'email' ? 'email' :
                col.type === 'tel' ? 'tel' : 'text';
      return `<div class="crud-field">
        <label>${escapeHtml(col.label)}${col.required?' <span style="color:#c0392b">*</span>':''}</label>
        <input type="${t}" name="${col.key}" value="${escapeHtml(item[col.key] || '')}" ${col.required?'required':''}>
      </div>`;
    }).join('');

    return `
      <div class="crud-modal-head">
        <h3>${item._isNew ? '新規追加' : '編集'}</h3>
        <button class="crud-close" type="button">×</button>
      </div>
      <form id="crud-form">
        ${fields}
        <div class="crud-modal-foot">
          ${item._isNew ? '' : '<button type="button" id="crud-delete" class="btn btn-gray">削除</button>'}
          <span style="flex:1"></span>
          <button type="button" class="btn btn-gray crud-cancel">キャンセル</button>
          <button type="submit" class="btn btn-primary">${item._isNew ? '追加' : '保存'}</button>
        </div>
      </form>
    `;
  }

  function init(config) {
    const {
      storageKey, tableSelector = '#tbl', addButton = '#btn-add',
      columns = [], defaults = [], idPrefix = 'X',
      sortBy = null
    } = config;

    // 主キーは columns の先頭で readonly のもの (デフォルト: 'id')
    const idCol = columns.find(c => c.readonly && c.code) || columns[0];
    const idField = (idCol && idCol.key) || 'id';

    let data = load(storageKey, defaults);

    function render() {
      const tbody = document.querySelector(tableSelector);
      if (!tbody) return;

      let rows = data.slice();
      if (sortBy) rows.sort((a, b) => String(a[sortBy] || '').localeCompare(String(b[sortBy] || '')));

      if (!rows.length) {
        tbody.innerHTML = `<tr class="empty"><td colspan="${columns.length + 1}" style="text-align:center;padding:24px;color:#888">データがありません。「+ 追加」から登録してください</td></tr>`;
        return;
      }

      tbody.innerHTML = rows.map((item, i) => `
        <tr data-idx="${i}">
          ${columns.map(col => `<td${col.center?' style="text-align:center"':''}${col.right?' style="text-align:right"':''}>${formatCell(item[col.key], col, item)}</td>`).join('')}
          <td style="text-align:center;width:80px"><a href="#" class="detail-link crud-edit" data-idx="${i}">編集</a></td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.crud-edit').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          openEditModal(parseInt(a.dataset.idx, 10));
        });
      });
    }

    function openEditModal(idx) {
      const item = idx == null
        ? Object.assign({ _isNew: true, [idField]: generateId(idPrefix, data, idField) }, ...columns.map(c => c.default !== undefined ? { [c.key]: c.default } : {}))
        : Object.assign({}, data[idx]);

      showModal(buildEditForm(item, columns));

      document.querySelector('#crud-form').addEventListener('submit', e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const newItem = {};
        columns.forEach(col => {
          if (col.type === 'checkbox') newItem[col.key] = !!fd.get(col.key);
          else if (col.type === 'number') newItem[col.key] = parseFloat(fd.get(col.key)) || 0;
          else if (col.type === 'status') newItem[col.key] = fd.get(col.key) === 'true';
          else newItem[col.key] = fd.get(col.key) || '';
        });
        if (item._isNew) {
          data.push(newItem);
        } else {
          data[idx] = newItem;
        }
        save(storageKey, data);
        closeModal();
        render();
      });

      const delBtn = document.querySelector('#crud-delete');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (!confirm('このデータを削除しますか?')) return;
          data.splice(idx, 1);
          save(storageKey, data);
          closeModal();
          render();
        });
      }
      document.querySelector('.crud-close').addEventListener('click', closeModal);
      document.querySelector('.crud-cancel').addEventListener('click', closeModal);
    }

    const addBtn = document.querySelector(addButton);
    if (addBtn) addBtn.addEventListener('click', () => openEditModal(null));

    // ESC でモーダル閉じる
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    render();

    return {
      reload: render,
      getData: () => data.slice(),
      reset: () => { data = defaults.slice(); save(storageKey, data); render(); }
    };
  }

  // 共通フォーマッタ
  const helpers = {
    yen: (v) => '¥' + Number(v).toLocaleString(),
    percent: (v) => v + '%'
  };

  window.SkyRentCRUD = { init, load, save, helpers };
  // モーダルCSSは manage/css/manage.css に統合済み
})();
