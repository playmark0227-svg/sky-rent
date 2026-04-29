/**
 * Sky Rent 管理画面 - 設定ページ用 ヘルパー
 *
 * 単一のキー/値ペアでフォームを localStorage に保存・復元する。
 *
 * 使い方:
 *   <input data-setting="site-name" value="...">
 *   <textarea data-setting="terms"></textarea>
 *   <input type="checkbox" data-setting="email.enabled">
 *   <button data-save>保存する</button>
 *
 *   <script src="js/settings.js"></script>
 *   <script>SkyRentSettings.init('site-config');</script>
 */
(function () {
  const PREFIX = 'sky-rent.settings.';

  function init(scope) {
    const key = PREFIX + scope;
    const saved = JSON.parse(localStorage.getItem(key) || '{}');

    // 復元
    document.querySelectorAll('[data-setting]').forEach(el => {
      const k = el.dataset.setting;
      if (saved[k] === undefined) return;
      if (el.type === 'checkbox') el.checked = !!saved[k];
      else el.value = saved[k];
    });

    function collect() {
      const out = {};
      document.querySelectorAll('[data-setting]').forEach(el => {
        const k = el.dataset.setting;
        if (el.type === 'checkbox') out[k] = el.checked;
        else if (el.type === 'number') out[k] = parseFloat(el.value) || 0;
        else out[k] = el.value;
      });
      return out;
    }

    function save() {
      localStorage.setItem(key, JSON.stringify(collect()));
      showToast('✓ 設定を保存しました');
    }

    document.querySelectorAll('[data-save]').forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); save(); });
    });

    // 自動保存 (入力時)
    if (document.body.dataset.autosave === 'true') {
      document.querySelectorAll('[data-setting]').forEach(el => {
        el.addEventListener('change', save);
        el.addEventListener('blur', save);
      });
    }

    return { save, get: () => collect() };
  }

  function showToast(msg) {
    let t = document.getElementById('skr-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'skr-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e8a4a;color:#fff;padding:12px 24px;border-radius:4px;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:1000;opacity:0;transition:opacity 0.2s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }

  window.SkyRentSettings = { init, showToast };
})();
