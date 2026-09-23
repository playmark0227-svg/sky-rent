/**
 * グロースレンタカー - 起動処理
 *
 * ページ固有の処理は <script type="text/x-deferred"> (外部ファイルは data-src) に書かれている。
 * このファイルが、
 *   1. 読み込み中は画面を隠し (<html class="skyrent-booting">)
 *   2. DOMContentLoaded の後に SkyRentBackend.init({area}) を待ち (本番はサーバーからデータを読む)
 *   3. 遅延スクリプトを文書順に実行し
 *   4. window に 'skyrent:ready' を発火して画面を表示する。
 * デモモードは init が即座に終わるので待ち時間はない。
 *
 * 遅延スクリプトは DOMContentLoaded / load の後に動くため、その中で登録された
 * DOMContentLoaded / load のリスナーは (既に発火済みなら) 非同期ですぐ呼ぶ。
 */
(function () {
  'use strict';
  if (window.__skyrentBootStarted) return;
  window.__skyrentBootStarted = true;

  const root = document.documentElement;
  const BOOT_CLASS = 'skyrent-booting';
  const SAFETY_MS = 8000;          // これを過ぎたら読み込み中でも画面を出す
  const SCRIPT_TIMEOUT_MS = 15000; // data-src の読込がこれを過ぎたら次へ進む
  root.classList.add(BOOT_CLASS);

  // ===================================================================
  // 発火済みの DOMContentLoaded / load に後から登録されたリスナーを呼ぶ
  // ===================================================================
  const fired = {
    DOMContentLoaded: () => document.readyState !== 'loading',
    load: () => document.readyState === 'complete'
  };
  const pending = [];

  function invokeLater(target, type, listener) {
    const entry = { target: target, type: type, listener: listener, cancelled: false };
    pending.push(entry);
    setTimeout(() => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      if (entry.cancelled) return;
      const ev = new Event(type);
      try {
        if (typeof listener === 'function') listener.call(target, ev);
        else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(ev);
      } catch (e) {
        reportError(e);
      }
    }, 0);
  }

  function reportError(e) {
    // 通常のスクリプトエラーと同じく window.onerror 経由でコンソールに出す
    setTimeout(() => { throw e; }, 0);
  }

  function patchTarget(target, types) {
    const origAdd = target.addEventListener;
    const origRemove = target.removeEventListener;
    if (typeof origAdd !== 'function') return;
    target.addEventListener = function (type, listener, options) {
      const self = this == null ? target : this;
      if (listener && types.indexOf(type) >= 0 && fired[type]()) {
        invokeLater(self, type, listener);
        return undefined;
      }
      return origAdd.call(self, type, listener, options);
    };
    target.removeEventListener = function (type, listener, options) {
      const self = this == null ? target : this;
      pending.forEach(p => {
        if (p.target === self && p.type === type && p.listener === listener) p.cancelled = true;
      });
      return origRemove.call(self, type, listener, options);
    };
  }
  patchTarget(document, ['DOMContentLoaded']);
  patchTarget(window, ['DOMContentLoaded', 'load']);

  // ===================================================================
  // 画面の表示・エラーバナー
  // ===================================================================
  function reveal() { root.classList.remove(BOOT_CLASS); }

  function removeBanner() {
    const old = document.getElementById('skyrent-boot-banner');
    if (old) old.remove();
  }

  function showBanner(kind, detail) {
    if (!document.body) return;
    removeBanner();
    const bar = document.createElement('div');
    bar.id = 'skyrent-boot-banner';
    bar.className = 'skyrent-error-banner' + (kind === 'slow' ? ' skyrent-error-banner--slow' : '');
    bar.setAttribute('role', 'alert');
    const msg = document.createElement('p');
    msg.className = 'skyrent-error-banner__msg';
    msg.textContent = kind === 'slow'
      ? 'データの読み込みに時間がかかっています。しばらく待っても表示が変わらない場合は、再読み込みしてください。'
      : 'サーバーからデータを読み込めませんでした。通信環境をご確認のうえ、再読み込みしてください。' +
        (detail ? ' (' + detail + ')' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skyrent-error-banner__btn';
    btn.textContent = '再読み込み';
    btn.addEventListener('click', () => location.reload());
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'skyrent-error-banner__close';
    close.setAttribute('aria-label', 'このお知らせを閉じる');
    close.textContent = '×';
    close.addEventListener('click', removeBanner);
    bar.appendChild(msg);
    bar.appendChild(btn);
    bar.appendChild(close);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // 通信エラー以外 (権限など) は、原因の説明をバナーに添える
  function errorDetail(e) {
    const B = window.SkyRentBackend;
    if (!e || !e.code || ['NETWORK', 'TIMEOUT', 'INTERNAL'].indexOf(e.code) >= 0) return '';
    if (B && typeof B.errorMessage === 'function') return B.errorMessage(e.code);
    return '';
  }

  // ===================================================================
  // 遅延スクリプトの実行
  // ===================================================================
  function execOne(el) {
    return new Promise(resolve => {
      const s = document.createElement('script');
      Array.prototype.forEach.call(el.attributes, attr => {
        if (attr.name !== 'type' && attr.name !== 'data-src') s.setAttribute(attr.name, attr.value);
      });
      const src = el.getAttribute('data-src');
      if (src) {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          console.error('スクリプトの読み込みがタイムアウトしました: ' + src);
          finish();
        }, SCRIPT_TIMEOUT_MS);
        s.async = false;
        s.addEventListener('load', finish);
        s.addEventListener('error', () => {
          console.error('スクリプトを読み込めませんでした: ' + src);
          finish();
        });
        s.src = src;
        el.parentNode.replaceChild(s, el);
      } else {
        // インラインは挿入した時点で同期実行される (エラーは window.onerror へ)
        s.text = el.text;
        el.parentNode.replaceChild(s, el);
        resolve();
      }
    });
  }

  async function runDeferred() {
    let el;
    // 実行中に追加された遅延スクリプトも文書順で拾う
    while ((el = document.querySelector('script[type="text/x-deferred"]'))) {
      await execOne(el);
    }
  }

  function areaOf(path) {
    const p = String(path || '');
    if (/\/manage\/login\.html$/i.test(p)) return 'admin-login';
    if (/\/manage\//i.test(p)) return 'admin';
    return 'public';
  }

  function domReady() {
    return new Promise(resolve => {
      if (document.readyState !== 'loading') resolve();
      else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }

  async function start() {
    await domReady();
    const B = window.SkyRentBackend;
    let failed = null;
    let slowShown = false;
    const safety = setTimeout(() => {
      reveal();
      if (!(B && B._lastRedirect)) { slowShown = true; showBanner('slow'); }
    }, SAFETY_MS);

    try {
      if (B && typeof B.init === 'function') await B.init({ area: areaOf(location.pathname) });
    } catch (e) {
      failed = e || new Error('init failed');
      console.error('SkyRentBackend.init に失敗しました', e);
    }
    clearTimeout(safety);
    if (failed) showBanner('error', errorDetail(failed));
    else if (slowShown) removeBanner();

    try {
      await runDeferred();
    } catch (e) {
      console.error('ページ処理の実行に失敗しました', e);
    }
    try {
      window.dispatchEvent(new Event('skyrent:ready'));
    } finally {
      reveal();
    }
  }

  start().catch(e => {
    console.error(e);
    reveal();
  });
})();
