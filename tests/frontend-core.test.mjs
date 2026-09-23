/**
 * 画面側の共通基盤のテスト (js/config.js / js/store.js / js/boot.js / js/backend.js /
 * manage/js/crud.js / manage/js/settings.js)
 *
 * 実行: node --test tests/frontend-core.test.mjs
 *
 *   - デモモード: 代表ページを jsdom で開き、boot.js が遅延スクリプト (text/x-deferred) を
 *     実行して描画されること・JS エラーが無いことを確かめる。
 *   - 本番モード: localStorage['sky-rent.configOverride'] でローカル Supabase
 *     (http://127.0.0.1:54321) を指定して開き、public_catalog の内容が store に入り、
 *     業務データが localStorage に書かれないことを確かめる。Supabase が起動していなければ skip。
 *   - 管理画面: 未ログインなら login.html へ。書込フックとドメイン関数の差し替えは
 *     偽の supabase クライアントで確かめる (TOTP を通したスタッフを用意しなくてよいように)。
 *   - DB 行 ⇔ store の変換関数の往復。
 *
 * 外部 CDN (supabase-js・Chart.js・フォント) にはアクセスしない: supabase-js は node_modules の
 * 同じ版 (2.117.0) を返し、それ以外は空のスクリプト / CSS を返す。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ---- 依存 (jsdom / supabase-js の UMD) はリポジトリの node_modules を優先 ----
function resolveFrom(bases, id) {
  for (const base of bases) {
    if (!base) continue;
    try { return require.resolve(id, { paths: [base] }); } catch (e) { /* 次へ */ }
  }
  return null;
}
const BASES = [ROOT, process.env.SKYRENT_TEST_DEPS].filter(Boolean);
const jsdomPath = resolveFrom(BASES, 'jsdom');
const jsdom = jsdomPath ? require(jsdomPath) : null;
const SUPABASE_UMD = [ROOT, process.env.SKYRENT_TEST_DEPS]
  .filter(Boolean)
  .map(b => join(b, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'))
  .find(p => existsSync(p)) || null;

const ORIGIN = 'http://localhost:8765';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
const LOCAL_API = 'http://127.0.0.1:54321';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const LIVE_CONFIG = { SUPABASE_URL: LOCAL_API, SUPABASE_ANON_KEY: ANON_KEY };
const FAKE_CONFIG = { SUPABASE_URL: 'http://fake-supabase.invalid', SUPABASE_ANON_KEY: 'fake-anon-key' };

const CHART_STUB = 'window.__chartCalls = 0; window.Chart = function () { window.__chartCalls++; return { destroy: function () {}, update: function () {} }; };';

const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };

// opts.origin: サイトを別のオリジン (例 https://owner.github.io) で配信する
// opts.configJs: js/config.js の後ろに足す JS (localhost 以外では configOverride が効かないため)
async function intercept(request, opts) {
  opts = opts || {};
  const url = new URL(request.url);
  if (url.origin === ORIGIN || (opts.origin && url.origin === opts.origin)) {
    const file = resolve(ROOT, '.' + decodeURIComponent(url.pathname));
    if (!(file === ROOT || file.startsWith(ROOT + sep)) || !existsSync(file)) {
      return new Response('not found', { status: 404 });
    }
    const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    let body = readFileSync(file);
    if (opts.configJs && /\/js\/config\.js$/.test(url.pathname)) body = body.toString('utf8') + '\n' + opts.configJs;
    return new Response(body, { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
  }
  if (request.url === SUPABASE_CDN && SUPABASE_UMD) {
    return new Response(readFileSync(SUPABASE_UMD), { headers: { 'Content-Type': 'application/javascript' } });
  }
  if (/chart\.js|chart\.umd/i.test(request.url)) {
    return new Response(CHART_STUB, { headers: { 'Content-Type': 'application/javascript' } });
  }
  // フォント・画像・計測タグなどはネットワークに出さず空で返す
  const css = /\.css(\?|$)|fonts\.googleapis/.test(request.url);
  return new Response('', { headers: { 'Content-Type': css ? 'text/css' : 'application/javascript' } });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// jsdom 側で作られた配列・オブジェクトは別 realm なので、JSON で普通の値にしてから比べる
const plain = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const deq = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);
async function waitFor(fn, ms, step) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step || 25);
  }
}

// 遅延スクリプトの中で DOMContentLoaded / load を後から登録する + data-src の読込完了を待つかを見る
const LATE_LISTENER_PROBE = `
  <script type="text/x-deferred">
    window.__probe = { dcl: false, load: false, scriptsBefore: document.querySelectorAll('script[type="text/x-deferred"]').length };
    document.addEventListener('DOMContentLoaded', function () { window.__probe.dcl = true; });
    window.addEventListener('load', function () { window.__probe.load = true; });
  </script>`;

/**
 * ページを jsdom で開く
 *   mode: 'demo' | 'live' (ローカル Supabase) | 'fake' (偽の supabase クライアント)
 */
function openPage(path, opts) {
  opts = opts || {};
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
  const file = join(ROOT, path.split(/[?#]/)[0]);
  let html = readFileSync(file, 'utf8');
  if (opts.inject) html = html.replace(/<\/body>/i, opts.inject + '\n</body>');
  const out = { errors: [], consoleErrors: [], warnings: [], resourceErrors: [], notImplemented: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => out.consoleErrors.push(a.map(x => (x && x.stack) || String(x)).join(' ')));
  vc.on('warn', (...a) => out.warnings.push(a.map(String).join(' ')));
  vc.on('jsdomError', e => {
    if (e.type === 'unhandled-exception') out.errors.push((e.cause && e.cause.stack) || e.message);
    else if (e.type === 'resource-loading') out.resourceErrors.push((e.url || '') + ' ' + e.message);
    else if (e.type === 'not-implemented') out.notImplemented.push(e.message);
  });
  const dom = new JSDOM(html, {
    url: (opts.origin || ORIGIN) + '/' + path,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: { interceptors: [requestInterceptor(req => intercept(req, opts))] },
    beforeParse(window) {
      // jsdom には fetch が無いので Node の fetch を渡す (AbortController 等も Node 側に揃える)
      window.fetch = (...args) => globalThis.fetch(...args);
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.scrollTo = () => {};
      window.matchMedia = q => ({
        matches: false, media: String(q), onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }
      });
      if (opts.mode === 'live') window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(opts.config || LIVE_CONFIG));
      if (opts.mode === 'fake') {
        window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(Object.assign({}, FAKE_CONFIG, opts.config || {})));
        // createClient に渡されたオプション (auth.storage / detectSessionInUrl) を後で確かめる
        window.supabase = { createClient: (url, key, options) => { window.__createClient = { url: url, key: key, options: options }; return opts.fakeClient; } };
      }
      Object.entries(opts.local || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
      Object.entries(opts.session || {}).forEach(([k, v]) => window.sessionStorage.setItem(k, v));
      window.__readyFired = false;
      window.__ready = new Promise(res => window.addEventListener('skyrent:ready', () => { window.__readyFired = true; res(true); }));
    }
  });
  out.dom = dom;
  out.window = dom.window;
  out.document = dom.window.document;
  // 待ち時間切れは false。タイマーはプロセス終了を引き止めない (unref)
  out.ready = ms => Promise.race([dom.window.__ready, new Promise(r => setTimeout(() => r(false), ms || 8000).unref())]);
  out.close = () => { try { dom.window.close(); } catch (e) { /* 無視 */ } };
  return out;
}

// JS エラー・読み込み失敗・console.error が無いこと
function assertClean(page, label) {
  deq(page.errors, [], label + ': JS エラー');
  deq(page.resourceErrors, [], label + ': 読み込めなかったファイル');
  deq(page.consoleErrors, [], label + ': console.error');
  const nav = page.notImplemented.filter(m => /navigation/i.test(m));
  deq(nav, [], label + ': 想定外の画面遷移');
}

function assertBooted(page, label) {
  const doc = page.document;
  assert.equal(doc.querySelectorAll('script[type="text/x-deferred"]').length, 0, label + ': 未実行の遅延スクリプトが残っている');
  assert.equal(doc.documentElement.classList.contains('skyrent-booting'), false, label + ': 画面が隠れたまま');
}

// 業務データ (sky-rent.*) が localStorage に無いこと
function businessKeys(storage) {
  const ok = ['sky-rent.configOverride', 'sky-rent.lang', 'sky-rent.introSeen'];
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.indexOf('sky-rent.') === 0 && ok.indexOf(k) < 0) out.push(k);
  }
  return out;
}

async function supabaseUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(LOCAL_API + '/rest/v1/rpc/public_catalog', {
      method: 'POST', signal: ctrl.signal,
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' }, body: '{}'
    });
    clearTimeout(t);
    return res.ok;
  } catch (e) { return false; }
}

async function serviceSelect(table, query) {
  const res = await fetch(LOCAL_API + '/rest/v1/' + table + '?' + (query || 'select=*'), {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if (!res.ok) throw new Error(table + ': HTTP ' + res.status);
  return res.json();
}

const NO_JSDOM = jsdom ? false : 'jsdom が見つかりません (npm install を実行してください)';

// ---- 実スタッフ (二段階認証済み) を作るための小物 ----
function base32Decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(str).replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, now) {
  const counter = Math.floor((now || Date.now()) / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
async function api(path, opts) {
  opts = opts || {};
  const key = opts.service ? SERVICE_KEY : ANON_KEY;
  const res = await fetch(LOCAL_API + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + (opts.token || key), 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  if (!res.ok) {
    const e = new Error(path + ': HTTP ' + res.status + ' ' + text.slice(0, 200));
    e.body = json;
    throw e;
  }
  return json;
}
// ローカル開発用の JWT 秘密鍵 (supabase CLI の既定値。anon key もこの鍵で署名されている)
const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
function signLocalJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return h + '.' + p + '.' + createHmac('sha256', LOCAL_JWT_SECRET).update(h + '.' + p).digest('base64url');
}
// 管理者ユーザーを作り、パスワード + TOTP で AAL2 のセッションを得る
async function createStaffSession(role) {
  const email = 'frontend-core-test-' + Date.now() + '@example.com';
  const password = 'Fc-test-' + Date.now() + 'Aa1';
  const user = await api('/auth/v1/admin/users', { service: true, body: { email: email, password: password, email_confirm: true } });
  const userId = user.id || (user.user && user.user.id);
  try {
    await api('/rest/v1/staff', { service: true, body: { user_id: userId, name: 'テスト 管理者', email: email, role: role || 'admin', active: true }, headers: { Prefer: 'return=minimal' } });
    const s1 = await api('/auth/v1/token?grant_type=password', { body: { email: email, password: password } });
    let s2;
    try {
      const factor = await api('/auth/v1/factors', { token: s1.access_token, body: { factor_type: 'totp', friendly_name: 'frontend-core-test' } });
      const ch = await api('/auth/v1/factors/' + factor.id + '/challenge', { token: s1.access_token, body: {} });
      s2 = await api('/auth/v1/factors/' + factor.id + '/verify', { token: s1.access_token, body: { challenge_id: ch.id, code: totp(factor.totp.secret) } });
    } catch (e) {
      // 起動中のローカル環境で TOTP の登録が無効 (config.toml 変更前に起動した) 場合は、
      // ローカル専用の秘密鍵で AAL2 のアクセストークンを作る (本番の鍵ではない)
      if (!(e.body && e.body.error_code === 'mfa_totp_enroll_not_enabled')) throw e;
      const payload = JSON.parse(Buffer.from(s1.access_token.split('.')[1], 'base64url').toString());
      payload.aal = 'aal2';
      payload.amr = [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }].concat(payload.amr || []);
      s2 = Object.assign({}, s1, { access_token: signLocalJwt(payload), expires_at: payload.exp });
    }
    const session = Object.assign({}, s2, { expires_at: s2.expires_at || Math.floor(Date.now() / 1000) + (s2.expires_in || 3600) });
    return { userId: userId, email: email, session: session };
  } catch (e) {
    await deleteUser(userId);
    throw e;
  }
}
async function deleteUser(userId) {
  try { await api('/auth/v1/admin/users/' + userId, { service: true, method: 'DELETE' }); } catch (e) { /* 後片付けの失敗は無視 */ }
}

// =====================================================================
// デモモード
// =====================================================================
describe('デモモード: boot が遅延スクリプトを実行して描画する', { skip: NO_JSDOM }, () => {
  test('index.html (data-src の読込を待つ・後付けの DOMContentLoaded / load も呼ばれる)', async () => {
    const probeOrder = `
      <script type="text/x-deferred">
        window.__lpRanBefore = document.getElementById('hs-category').options.length;
      </script>`;
    const page = openPage('index.html', { inject: LATE_LISTENER_PROBE + probeOrder });
    try {
      assert.equal(await page.ready(8000), true, 'skyrent:ready が発火しない');
      const w = page.window;
      await waitFor(() => w.__probe && w.__probe.dcl && w.__probe.load, 5000);
      assert.equal(w.__probe.dcl, true, '後から登録した DOMContentLoaded が呼ばれない');
      assert.equal(w.__probe.load, true, '後から登録した load が呼ばれない');
      // lp.js (data-src) の実行が終わってから次のインラインが動いている
      assert.equal(w.__lpRanBefore, 3, 'data-src の読込完了前に次のスクリプトが動いた');
      assert.equal(page.document.querySelectorAll('#hs-category option').length, 3);
      assert.equal(page.document.querySelectorAll('#hs-location option').length, 3);
      assert.equal(w.SkyRentStore.live, false);
      assert.equal(w.SkyRentBackend.live, false);
      assertBooted(page, 'index');
      assertClean(page, 'index');
    } finally { page.close(); }
  });

  test('search.html', async () => {
    const page = openPage('search.html');
    try {
      assert.equal(await page.ready(8000), true);
      const n = await waitFor(() => page.document.querySelectorAll('#results > *').length >= 6 && page.document.querySelectorAll('#results > *').length, 4000);
      assert.ok(n >= 6, '検索結果が描画されない (' + n + ')');
      assertBooted(page, 'search');
      assertClean(page, 'search');
    } finally { page.close(); }
  });

  test('detail.html?id=V003', async () => {
    const page = openPage('detail.html?id=V003', { inject: LATE_LISTENER_PROBE });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.document.querySelector('#d-name') && page.document.querySelector('#d-name').textContent.trim(), 3000);
      assert.equal(page.document.querySelector('#d-name').textContent.trim(), 'マツダ CX-5');
      await waitFor(() => page.window.__probe && page.window.__probe.dcl, 3000);
      assert.equal(page.window.__probe.dcl, true);
      assertBooted(page, 'detail');
      assertClean(page, 'detail');
    } finally { page.close(); }
  });

  test('booking.html (pendingBooking あり)', async () => {
    const start = new Date(Date.now() + 20 * 86400000); start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 86400000);
    const pending = { assetId: 'V003', start: start.toISOString(), end: end.toISOString(), quantity: 1, optionIds: ['OP101'] };
    const page = openPage('booking.html', { session: { 'sky-rent.pendingBooking': JSON.stringify(pending) } });
    try {
      assert.equal(await page.ready(8000), true);
      const shown = await waitFor(() => page.document.body.textContent.indexOf('マツダ CX-5') >= 0, 3000);
      assert.ok(shown, '予約内容 (車両名) が描画されない');
      assertBooted(page, 'booking');
      assertClean(page, 'booking');
    } finally { page.close(); }
  });

  test('mypage.html', async () => {
    const page = openPage('mypage.html', { inject: LATE_LISTENER_PROBE });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.window.__probe && page.window.__probe.dcl, 3000);
      assertBooted(page, 'mypage');
      assertClean(page, 'mypage');
    } finally { page.close(); }
  });

  test('manage/dashboard.html (manage.js は data-src)', async () => {
    const page = openPage('manage/dashboard.html');
    try {
      assert.equal(await page.ready(8000), true);
      assert.ok(page.document.querySelector('.topbar'), 'ヘッダーが差し込まれない');
      const kpi = await waitFor(() => /^\d+$/.test(page.document.querySelector('#kpi-bookings').textContent.trim()), 3000);
      assert.ok(kpi, 'KPI が描画されない');
      assertBooted(page, 'dashboard');
      assertClean(page, 'dashboard');
    } finally { page.close(); }
  });

  test('manage/employees.html (crud.js: デモは既定行を localStorage に保存)', async () => {
    const page = openPage('manage/employees.html');
    try {
      assert.equal(await page.ready(8000), true);
      assert.equal(page.document.querySelectorAll('#tbl tr').length, 4);
      const saved = JSON.parse(page.window.localStorage.getItem('sky-rent.employees'));
      assert.equal(saved.length, 4);
      assertBooted(page, 'employees');
      assertClean(page, 'employees');
    } finally { page.close(); }
  });

  test('manage/site-settings.html (settings.js: store 経由で保存・フォームに無い項目は残す)', async () => {
    const page = openPage('manage/site-settings.html', {
      local: { 'sky-rent.settings.site': JSON.stringify({ siteName: '保存済みの名前', shopName: 'サーバー側で使う値' }) }
    });
    try {
      assert.equal(await page.ready(8000), true);
      const doc = page.document;
      assert.equal(doc.querySelector('[data-setting="siteName"]').value, '保存済みの名前');
      doc.querySelector('[data-setting="siteName"]').value = '新しい名前';
      doc.querySelector('[data-save]').click();
      const saved = JSON.parse(page.window.localStorage.getItem('sky-rent.settings.site'));
      assert.equal(saved.siteName, '新しい名前');
      assert.equal(saved.shopName, 'サーバー側で使う値');
      assertBooted(page, 'site-settings');
      assertClean(page, 'site-settings');
    } finally { page.close(); }
  });

  test('manage/reservation-list.html', async () => {
    const page = openPage('manage/reservation-list.html');
    try {
      assert.equal(await page.ready(8000), true);
      const rows = await waitFor(() => page.document.querySelectorAll('#tbl tr:not(.empty)').length, 3000);
      assert.ok(rows > 0, '予約一覧が描画されない');
      assertBooted(page, 'reservation-list');
      assertClean(page, 'reservation-list');
    } finally { page.close(); }
  });

  test('SkyRentBackend のデモ実装 (予約 → 照会 → キャンセル / 問い合わせ / 見積 / 空き)', async () => {
    const page = openPage('index.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      const B = w.SkyRentBackend, S = w.SkyRentStore;
      // 空いている時間帯 (V001 の30日後)
      const start = new Date(Date.now() + 30 * 86400000); start.setHours(10, 0, 0, 0);
      const end = new Date(start.getTime() + 2 * 86400000);
      const q = await B.quote({ assetId: 'V001', start: start.toISOString(), end: end.toISOString(), optionIds: ['OP101'] });
      assert.equal(q.ok, true);
      assert.ok(q.quote.total > 0);
      assert.equal(q.availability.vehicle, true);

      const av = await B.availability(start, end);
      deq(av.busy, []);
      deq(B.staffCheck('V001', start.toISOString(), end.toISOString()), { ok: true });

      const payload = {
        idempotencyKey: 'test-key-0123456789abcdef', assetId: 'V001', start: start.toISOString(), end: end.toISOString(),
        optionIds: ['OP101'], customer: { name: 'テスト 太郎', kana: 'テスト タロウ', email: 'test@example.com', phone: '090-0000-0000', company: '' },
        paymentMethod: 'onsite', licenseConfirmed: true, note: '', expectedTotal: q.quote.total,
        consent: { documents: [{ id: 'clause', version: '2026-08' }], agreedAt: new Date().toISOString() }
      };
      // 金額が違えば PRICE_CHANGED (新しい見積を同梱)
      await assert.rejects(B.createReservation(Object.assign({}, payload, { expectedTotal: 1 })), e => e.code === 'PRICE_CHANGED' && !!e.quote && e.quote.total === q.quote.total);
      const res = await B.createReservation(payload);
      assert.equal(res.ok, true);
      assert.ok(res.reservation.id);
      assert.equal(res.reservation.total, q.quote.total);
      assert.ok(res.guestToken);
      assert.match(res.lookupUrl, /mypage\.html#lookup=/);
      // 同じ冪等キーは同じ予約を返す
      const again = await B.createReservation(payload);
      assert.equal(again.reservation.id, res.reservation.id);
      // 重なる予約は AVAILABILITY_CONFLICT
      await assert.rejects(B.createReservation(Object.assign({}, payload, { idempotencyKey: 'other-key-0123456789abcd' })), e => e.code === 'AVAILABILITY_CONFLICT');

      const lk = await B.lookupReservation({ id: res.reservation.id, token: res.guestToken });
      assert.equal(lk.reservation.id, res.reservation.id);
      assert.equal(lk.cancellation.cancellable, true);
      await assert.rejects(B.lookupReservation({ id: res.reservation.id, token: 'wrong' }), e => e.code === 'NOT_FOUND');
      const cn = await B.cancelReservation({ id: res.reservation.id, token: res.guestToken, expectedFee: lk.cancellation.fee });
      assert.equal(cn.reservation.status, 'cancelled');
      await assert.rejects(B.cancelReservation({ id: res.reservation.id, token: res.guestToken }), e => e.code === 'NOT_CANCELLABLE');

      await assert.rejects(B.submitInquiry({ name: '', email: 'x', topic: '', body: '' }), e => e.code === 'VALIDATION' && !!(e.fields && e.fields.email));
      const iq = await B.submitInquiry({ idempotencyKey: 'inq-0123456789abcdef', name: '問合 花子', email: 'q@example.com', topic: '予約について', body: 'テストです', website: '' });
      assert.equal(iq.ok, true);
      assert.equal(S.list('inquiries')[0].inquiryId, iq.id);

      // 会員
      const si = await B.auth.signIn('demo@example.com', 'demo1234');
      assert.equal(si.member.memberId, 'M001');
      assert.equal(B.member.current().memberId, 'M001');
      await assert.rejects(B.auth.signIn('demo@example.com', 'wrong-pass'), e => e.code === 'INVALID_CREDENTIALS');
      await B.auth.signOut();
      assert.equal(B.member.current(), null);

      assert.equal(B.admin.can('staff.write'), true);
      await assert.rejects(B.admin.listStaff(), e => e.code === 'DEMO_MODE');
      assert.match(B.errorMessage('STAFF_UNAVAILABLE'), /担当者/);
      assertClean(page, 'demo-backend');
    } finally { page.close(); }
  });

  test('エラーコード表 (契約書 §2) の日本語文がすべてある', async () => {
    const page = openPage('manage/login.html');
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      const internal = B.errorMessage('INTERNAL');
      ['VALIDATION', 'CONSENT_REQUIRED', 'UNAUTHENTICATED', 'FORBIDDEN', 'INVOICE_NOT_ALLOWED', 'NOT_FOUND',
       'AVAILABILITY_CONFLICT', 'STAFF_UNAVAILABLE', 'HANDOVER_CONFLICT', 'PRICE_CHANGED', 'COUPON_INVALID',
       'NOT_CANCELLABLE', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED', 'CALENDAR_UNAVAILABLE', 'INTERNAL',
       // 料金エンジン (pricing-core) の errors・外部キー違反・Edge Function の CONFLICT
       'INVALID_ASSET', 'OPTION_NOT_APPLICABLE', 'OPTION_CONFLICT', 'DISCOUNT_NOT_APPLICABLE', 'INVALID_PERIOD',
       'FOREIGN_KEY', 'CONFLICT', 'VERSION_CONFLICT', 'WEAK_PASSWORD', 'LINK_INVALID'].forEach(code => {
        const m = B.errorMessage(code);
        assert.match(m, /[ぁ-んァ-ヶ一-龠]/, code);
        if (code !== 'INTERNAL') assert.notEqual(m, internal, code + ' が既定文のまま');
      });
      assert.equal(B.errorMessage('FOREIGN_KEY'), 'この項目は予約などで使われているため削除できません。無効にしてください。');
      assert.equal(B.errorMessage('WEAK_PASSWORD'), '8文字以上で、英大文字・英小文字・数字をそれぞれ1文字以上含めてください。');
      assertClean(page, 'login');
    } finally { page.close(); }
  });
});

// =====================================================================
// 受け渡し担当者の判定 (契約書 §3.2) — ブラウザ側
// =====================================================================
describe('staffCheck / 追加の空き判定', { skip: NO_JSDOM }, () => {
  test('handover / day / 受け渡し重複 / 未設定の拠点', async () => {
    // 偽クライアントで公開ページを開き、/api/availability の応答を差し替える
    const db = fakeDb();
    const client = fakeClient(db, []);
    const page = openPage('detail.html?id=V003', { mode: 'fake', fakeClient: client });
    const w = page.window;
    const T = iso => new Date(iso).toISOString();
    const availability = {
      ok: true,
      busy: [{ assetId: 'V002', start: T('2026-10-10T01:00:00Z'), end: T('2026-10-11T01:00:00Z') }],
      handovers: { 'loc-kitami': [T('2026-10-20T01:00:00Z')] },
      staff: {
        enabled: true, mode: 'handover', handoverMinutes: 30, oneHandoverAtATime: true,
        locations: {
          'loc-kitami': { configured: true, busy: [{ start: T('2026-10-15T00:00:00Z'), end: T('2026-10-15T03:00:00Z') }] },
          'loc-kushiro': { configured: false, busy: [] }
        }
      }
    };
    // backend の fetch (Edge Function) を差し替え。応答の JSON は同じオブジェクトを返すので、
    // 後から availability を書き換えると判定条件を変えられる
    const calls = [];
    w.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init && init.headers });
      if (String(url).indexOf('/functions/v1/api/availability') >= 0) {
        return { ok: true, status: 200, json: async () => availability };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false, code: 'NOT_FOUND', message: 'not found' }) };
    };
    try {
      assert.equal(await page.ready(8000), true);
      const B = w.SkyRentBackend, S = w.SkyRentStore;
      // busy → 合成予約
      const busy = S.list('reservations').filter(r => r._busy);
      assert.equal(busy.length, 1);
      assert.equal(busy[0].reservationId, 'busy-1');
      assert.equal(S.availability('V002', T('2026-10-10T05:00:00Z'), T('2026-10-10T08:00:00Z'), 1).ok, false);
      assert.equal(S.availability('V002', T('2026-10-12T05:00:00Z'), T('2026-10-12T08:00:00Z'), 1).ok, true);
      // Edge Function 呼び出しのヘッダ (apikey + ログイン中は access_token)
      const call = calls.find(c => c.url.indexOf('/api/availability?from=') >= 0);
      assert.ok(call, '/api/availability が呼ばれていない');
      assert.equal(call.headers.apikey, FAKE_CONFIG.SUPABASE_ANON_KEY);
      assert.equal(call.headers.Authorization, 'Bearer fake-token');
      // 担当者の予定あり (JST 10/15 9:00〜12:00) に貸出 → 不可
      const r1 = B.staffCheck('V003', T('2026-10-15T01:00:00Z'), T('2026-10-16T05:00:00Z'));
      assert.equal(r1.ok, false);
      assert.equal(r1.code, 'STAFF_UNAVAILABLE');
      // 空き判定にも反映される (理由付き)
      const av = S.availability('V003', T('2026-10-15T01:00:00Z'), T('2026-10-16T05:00:00Z'), 1);
      assert.equal(av.ok, false);
      assert.equal(av.code, 'STAFF_UNAVAILABLE');
      assert.match(av.reason, /担当者/);
      // 予定の外なら可
      assert.equal(B.staffCheck('V003', T('2026-10-15T04:00:00Z'), T('2026-10-16T05:00:00Z')).ok, true);
      // 受け渡し時刻が 30 分以内に重なる → HANDOVER_CONFLICT
      const r2 = B.staffCheck('V003', T('2026-10-20T01:20:00Z'), T('2026-10-21T01:00:00Z'));
      assert.equal(r2.code, 'HANDOVER_CONFLICT');
      assert.equal(B.staffCheck('V003', T('2026-10-20T01:30:00Z'), T('2026-10-21T01:00:00Z')).ok, true);
      // カレンダー未登録の拠点は判定しない
      assert.equal(B.staffCheck('V002', T('2026-10-15T01:00:00Z'), T('2026-10-16T05:00:00Z')).ok, true);
      // day モード: 返却日 (JST 10/15) に予定あり → 不可
      availability.staff.mode = 'day';
      assert.equal(B.staffCheck('V003', T('2026-10-13T01:00:00Z'), T('2026-10-15T08:00:00Z')).ok, false);
      assert.equal(B.staffCheck('V003', T('2026-10-13T01:00:00Z'), T('2026-10-14T08:00:00Z')).ok, true);
      // 1拠点に複数カレンダー: 誰か1人でも空いていれば可
      availability.staff.mode = 'handover';
      availability.staff.locations['loc-kitami'] = {
        configured: true,
        calendars: [{ busy: [{ start: T('2026-10-15T00:00:00Z'), end: T('2026-10-15T03:00:00Z') }] }, { busy: [] }]
      };
      assert.equal(B.staffCheck('V003', T('2026-10-15T01:00:00Z'), T('2026-10-16T05:00:00Z')).ok, true);
      // 無効なら判定しない
      availability.staff.enabled = false;
      availability.staff.oneHandoverAtATime = false;
      assert.equal(B.staffCheck('V003', T('2026-10-20T01:20:00Z'), T('2026-10-21T01:00:00Z')).ok, true);
      assertClean(page, 'staffCheck');
    } finally { page.close(); }
  });
});

// =====================================================================
// 本番モード (ローカル Supabase)
// =====================================================================
describe('本番モード: ローカル Supabase', { skip: NO_JSDOM || (SUPABASE_UMD ? false : 'supabase-js が見つかりません') }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });

  test('index.html: public_catalog が store に入り、業務データを localStorage に書かない', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const page = openPage('index.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true, 'skyrent:ready が発火しない');
      const w = page.window;
      const S = w.SkyRentStore, B = w.SkyRentBackend;
      assert.equal(S.live, true);
      assert.equal(B.live, true);
      assert.ok(B.client, 'supabase クライアントが作られていない');
      assert.equal(S.assets().length, 6);
      assert.equal(S.locations().length, 2);
      assert.equal(S.list('options').length, 4);
      assert.equal(S.categories().length, 2);
      deq(S.getAsset('V003').customFields.bodyType, 'SUV');
      assert.equal(S.list('options').find(o => o.optionId === 'OP101').priceShort, 1100);
      assert.ok(S.read('settings.pricing_rules', null), '料金ルールが入っていない');
      assert.equal(S.list('legal').length, 4);
      // デモのシード (予約・会員) は入らない
      deq(S.list('reservations'), []);
      deq(S.list('members'), []);
      assert.equal(S.currentMember(), null);
      // 画面にサーバーのデータが出ている
      assert.equal(page.document.querySelectorAll('#hs-category option').length, 3);
      // 書き込みもメモリだけ
      S.write('assets', S.assets());
      deq(businessKeys(w.localStorage), [], 'localStorage に業務データが書かれた');
      assert.equal(w.localStorage.getItem('sky-rent.assets'), null);
      assert.equal(w.localStorage.getItem('sky-rent.dataVersion'), null);
      deq(businessKeys(w.sessionStorage).filter(k => k !== 'sky-rent.introSeen'), []);
      assertBooted(page, 'live-index');
      assertClean(page, 'live-index');
    } finally { page.close(); }
  });

  test('search.html: 空き状況が読めなくても (Edge Function 未起動) 画面は動く', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const page = openPage('search.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(25000), true);
      const w = page.window;
      assert.equal(w.SkyRentStore.assets().length, 6);
      const n = await waitFor(() => page.document.querySelectorAll('#results > *').length >= 6 && page.document.querySelectorAll('#results > *').length, 4000);
      assert.ok(n >= 6, '検索結果が描画されない');
      // 空き状況: 取れたなら合成予約だけ、取れなかったなら警告トースト
      const rs = w.SkyRentStore.list('reservations');
      assert.ok(rs.every(r => r._busy), '合成予約以外が入っている');
      deq(businessKeys(w.localStorage), []);
      assertBooted(page, 'live-search');
      assertClean(page, 'live-search');
    } finally { page.close(); }
  });

  test('manage/dashboard.html: 未ログインなら login.html?next=... へ (ページ処理は動かない)', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const page = openPage('manage/dashboard.html', { mode: 'live' });
    try {
      const w = page.window;
      const url = await waitFor(() => w.SkyRentBackend && w.SkyRentBackend._lastRedirect, 15000);
      assert.equal(url, 'login.html?next=dashboard.html');
      await sleep(300);
      assert.equal(w.__readyFired, false, 'リダイレクト中にページ処理が動いた');
      assert.ok(page.document.querySelectorAll('script[type="text/x-deferred"]').length > 0);
      deq(w.SkyRentStore.list('reservations'), []);
      deq(page.errors, []);
      deq(businessKeys(w.localStorage), []);
    } finally { page.close(); }
  });

  test('manage/reservation-list.html: 二段階認証済みの実スタッフで全データを読み、設定の書込がDBに届く', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const staff = await createStaffSession();
    const settingKey = 'frontend_core_test_' + Date.now();
    const page = openPage('manage/reservation-list.html', {
      mode: 'live',
      local: { 'sb-127-auth-token': JSON.stringify(staff.session) }
    });
    try {
      assert.equal(await page.ready(20000), true, 'skyrent:ready が発火しない (' + page.window.SkyRentBackend._lastRedirect + ')');
      const w = page.window, S = w.SkyRentStore, B = w.SkyRentBackend;
      assert.equal(B._lastRedirect, null);
      assert.equal(B.admin.staff.role, 'admin');
      assert.equal(B.admin.staff.name, 'テスト 管理者');
      assert.equal(B.admin.can('settings.write'), true);
      assert.equal(S.assets().length, 6);
      assert.equal(S.locations().length, 2);
      assert.equal(S.list('options').length, 4);
      assert.ok(S.read('settings.calendar', null), 'スタッフ専用の設定 (calendar) が読めていない');
      assert.ok(Array.isArray(S.list('notifications')));
      const cnt = await serviceSelect('reservations', 'select=id');
      assert.equal(S.list('reservations').length, cnt.length, '予約の件数がDBと合わない');
      deq(businessKeys(w.localStorage), []);

      // 設定の書込 → app_settings に届く / 消すと消える
      S.write('settings.' + settingKey, { ok: true, n: 1 });
      let rows = [];
      for (let i = 0; i < 80 && !rows.length; i++) { rows = await serviceSelect('app_settings', 'select=key,value&key=eq.' + settingKey); if (!rows.length) await sleep(50); }
      deq(rows, [{ key: settingKey, value: { ok: true, n: 1 } }]);
      S.write('settings.' + settingKey, undefined);
      for (let i = 0; i < 80 && rows.length; i++) { rows = await serviceSelect('app_settings', 'select=key&key=eq.' + settingKey); if (rows.length) await sleep(50); }
      deq(rows, []);

      // 操作履歴 (admin.auditLog): この設定の追加・削除が新しい順に、件数付きで読める
      const log = await B.admin.auditLog({ table: 'app_settings', rowId: settingKey });
      deq(log.rows.map(r => r.action), ['delete', 'insert']);
      assert.equal(log.total, 2);
      assert.equal(log.hasMore, false);
      assert.equal(log.rows[0].actor, staff.userId);
      assert.equal(log.rows[0].actor_role, 'admin');
      assert.equal(log.rows[0].table_name, 'app_settings');
      assert.equal(log.rows[0].row_id, settingKey);
      const one = await B.admin.auditLog({ table: 'app_settings', rowId: settingKey, limit: 1 });
      deq([one.rows.length, one.total, one.hasMore], [1, 2, true]);
      deq((await B.admin.auditLog({ table: 'app_settings', rowId: settingKey, action: 'insert' })).rows.map(r => r.action), ['insert']);
      assert.equal((await B.admin.auditLog({ table: 'app_settings', rowId: settingKey, actor: staff.userId })).total, 2);
      assert.equal((await B.admin.auditLog({ table: 'app_settings', rowId: settingKey, actor: '__system' })).total, 0);
      const todayJst = B.jst.ymd(new Date());
      assert.equal((await B.admin.auditLog({ table: 'app_settings', rowId: settingKey, from: todayJst, to: todayJst })).total, 2, '今日 (日本時間) の範囲に入らない');
      assert.equal((await B.admin.auditLog({ table: 'app_settings', rowId: settingKey, to: '2020-01-01' })).total, 0);

      // ログイン状態 (admin.sessionState)
      const st = await B.admin.sessionState();
      assert.equal(st.userId, staff.userId);
      assert.equal(st.email, staff.email);
      assert.equal(st.aal, 'aal2');
      deq(st.staff, { name: 'テスト 管理者', role: 'admin', locationIds: null, active: true });
      assert.equal(st.hasTotp, true);

      // 認証アプリの登録 (admin.mfa.enroll): 発行者「グロースレンタカー」・登録名が重なれば (2) を付ける
      const en = await B.admin.mfa.enroll({ friendlyName: 'frontend-core-test' });
      assert.ok(en.factorId && en.secret, '登録用のキーが返らない');
      assert.match(decodeURIComponent(en.uri), /issuer=グロースレンタカー/);
      assert.match(decodeURIComponent(en.uri), /^otpauth:\/\/totp\/グロースレンタカー:/);
      const fs = await B.admin.mfa.listFactors();
      assert.equal(fs.all.find(f => f.id === en.factorId).friendly_name, 'frontend-core-test (2)');
      await B.admin.mfa.unenroll(en.factorId);
      assertBooted(page, 'live-admin');
      assertClean(page, 'live-admin');
    } finally {
      page.close();
      await deleteUser(staff.userId);
      try { await api('/rest/v1/app_settings?key=eq.' + settingKey, { service: true, method: 'DELETE' }); } catch (e) { /* 無視 */ }
    }
  });

  test('manage/login.html (admin-login) はリダイレクトしない', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const page = openPage('manage/login.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      assert.equal(page.window.SkyRentBackend._lastRedirect, null);
      assertBooted(page, 'live-login');
      deq(page.errors, []);
      deq(page.consoleErrors, []);
    } finally { page.close(); }
  });

  test('接続できないとき: エラーバナー (再読み込みボタン付き) を出し、ページ処理は実行する', async () => {
    const page = openPage('index.html', { mode: 'live', config: { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: ANON_KEY } });
    try {
      assert.equal(await page.ready(25000), true, 'skyrent:ready が発火しない');
      const banner = page.document.getElementById('skyrent-boot-banner');
      assert.ok(banner, 'エラーバナーが出ない');
      assert.match(banner.textContent, /読み込めませんでした/);
      assert.ok(banner.querySelector('.skyrent-error-banner__btn'), '再読み込みボタンが無い');
      assert.equal(banner.querySelector('.skyrent-error-banner__btn').textContent, '再読み込み');
      assertBooted(page, 'live-fail');  // ページ処理は実行され、画面は表示される
      assert.equal(await page.window.SkyRentBackend.ready, false);
      deq(page.errors, []);
      deq(businessKeys(page.window.localStorage), []);
    } finally { page.close(); }
  });

  test('DB → store → DB の往復で値が保たれる (実際の行)', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const page = openPage('manage/login.html');
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      const strip = row => { const r = Object.assign({}, row); delete r.updated_at; return r; };
      for (const [table, conv] of [['categories', 'category'], ['locations', 'location'], ['assets', 'asset'], ['options', 'option']]) {
        const rows = await serviceSelect(table);
        assert.ok(rows.length > 0, table + ' が空');
        rows.forEach(row => {
          const back = JSON.parse(JSON.stringify(B.toDb[conv](B.fromDb[conv](row))));
          deq(back, strip(row), table + ' ' + row.id);
        });
      }
      // オプションの説明は extra.description ⇔ description
      const op = (await serviceSelect('options', 'select=*&id=eq.OP101'))[0];
      assert.equal(B.fromDb.option(op).description, op.extra.description);
      // 公開カタログ (plate 等が除かれた行) も、含まれている列は保たれる
      const cat = await (await fetch(LOCAL_API + '/rest/v1/rpc/public_catalog', {
        method: 'POST', headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' }, body: '{}'
      })).json();
      cat.assets.forEach(row => {
        const back = B.toDb.asset(B.fromDb.asset(row));
        Object.keys(row).filter(k => k !== 'updated_at').forEach(k => deq(back[k], row[k], 'public asset ' + row.id + ' ' + k));
      });
      // 設定
      const settings = await serviceSelect('app_settings', 'select=key,value');
      settings.forEach(row => {
        const kv = B.fromDb.setting(row);
        deq(B.toDb.setting(kv[0], kv[1]), { key: row.key, value: row.value });
      });
      // 予約 (あれば)
      const res = await serviceSelect('reservations', 'select=id,kind,asset_id,category_id,location_id,start_at,end_at,status,user_id,customer_name,customer_kana,customer_email,customer_phone,company,license_confirmed,payment_method,payment_status,option_ids,options,price,total,discount_type,coupon_id,invoice_id,point_granted,note,staff_note,cancel_fee,cancelled_at,cancelled_by,version,created_at,gcal_events&limit=50');
      res.filter(row => row.price && row.price.total != null).forEach(row => {
        const back = JSON.parse(JSON.stringify(B.toDb.reservation(B.fromDb.reservation(row, { asset: () => null, memberNo: () => null }))));
        deq(back, row, 'reservation ' + row.id);
      });
      deq(page.errors, []);
    } finally { page.close(); }
  });
});

// =====================================================================
// 変換関数の往復 (合成した行)
// =====================================================================
describe('DB 行 ⇔ store の変換', { skip: NO_JSDOM }, () => {
  test('予約・会員・請求書・問い合わせ・カタログの往復', async () => {
    const page = openPage('manage/login.html');
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      const rt = (x, conv, ...a) => JSON.parse(JSON.stringify(B.toDb[conv](B.fromDb[conv](x, ...a))));

      const reservation = {
        id: 'R00012', kind: 'rental', asset_id: 'V003', category_id: 'cat-rental', location_id: 'loc-kitami',
        start_at: '2026-10-01T01:00:00+00:00', end_at: '2026-10-03T01:00:00+00:00', status: 'confirmed',
        user_id: '6a1c0d0e-1111-2222-3333-444455556666', customer_name: '山田 太郎', customer_kana: 'ヤマダ タロウ',
        customer_email: 'yamada@example.com', customer_phone: '090-1111-2222', company: '',
        license_confirmed: true, payment_method: 'onsite', payment_status: 'unpaid',
        option_ids: ['OP101'], options: [{ id: 'OP101', name: '免責補償制度 (CDW)', amount: 3300 }],
        price: { ok: true, lines: [{ code: 'base', label: '基本料金 (24時間 × 2)', amount: 34000 }], base: 34000, subtotal: 37300, total: 37300 },
        total: 37300, discount_type: 'student', coupon_id: null, invoice_id: null, point_granted: false,
        note: '到着が遅れるかもしれません', staff_note: '常連', cancel_fee: null, cancelled_at: null, cancelled_by: null,
        version: 3, created_at: '2026-09-20T03:00:00+00:00',
        gcal_events: { pickup: { calendarId: 'a@example.com', eventId: 'e1' } }
      };
      const ctx = { asset: id => ({ assetId: id, name: 'マツダ CX-5' }), memberNo: () => 'M00007' };
      const r = B.fromDb.reservation(reservation, ctx);
      assert.equal(r.reservationId, 'R00012');
      assert.equal(r.vehicleId, 'V003');
      assert.equal(r.assetName, 'マツダ CX-5');
      assert.equal(r.memberId, 'M00007');
      assert.equal(r.start, reservation.start_at);
      assert.equal(r.price.total, 37300);
      deq(r.payment, { method: 'onsite', status: 'unpaid' });
      deq(rt(reservation, 'reservation', ctx), reservation);

      const memberRow = {
        user_id: '6a1c0d0e-1111-2222-3333-444455556666', member_no: 'M00007', email: 'yamada@example.com',
        name: '山田 太郎', name_kana: 'ヤマダ タロウ', phone: '090-1111-2222', company: '', is_corporate: false,
        invoice_allowed: false, marketing_opt_in: true, status: 'active', last_use_at: null, created_at: '2026-01-01T00:00:00+00:00'
      };
      const couponRow = { id: '0f0e0d0c-aaaa-bbbb-cccc-000000000001', user_id: memberRow.user_id, amount: 1000, reason: 'ポイント10pt 到達特典', issued_at: '2026-09-01T00:00:00+00:00', expires_at: null, used_at: null, used_reservation_id: null };
      const ledgerRow = { id: 5, user_id: memberRow.user_id, delta: 1, reason: '予約 R00001 ご返却', reservation_id: 'R00001', created_by: null, created_at: '2026-08-01T00:00:00+00:00' };
      const m = B.fromDb.member(memberRow, { points: 7, coupons: [couponRow], ledger: [ledgerRow] });
      assert.equal(m.memberId, 'M00007');
      assert.equal(m.points, 7);
      assert.equal(m.coupons[0].couponId, couponRow.id);
      assert.equal(m.pointHistory[0].delta, 1);
      deq(JSON.parse(JSON.stringify(B.toDb.member(m))), memberRow);
      deq(B.toDb.coupon(m.coupons[0], memberRow.user_id), couponRow);

      const invoiceRow = {
        id: 'INV-0003', user_id: memberRow.user_id, company: '株式会社テスト', address: '北海道北見市', case_name: 'レンタル料金 一式',
        reservation_ids: ['R00012'], amount: 37300, status: 'unpaid', issued_at: '2026-09-21T00:00:00+00:00', due_date: '2026-10-31', paid_at: null
      };
      deq(rt(invoiceRow, 'invoice', { memberNo: () => 'M00007' }), invoiceRow);
      assert.equal(B.fromDb.invoice(invoiceRow, { memberNo: () => 'M00007' }).memberId, 'M00007');

      const inquiryRow = {
        id: 'C00002', name: '問合 花子', company: '', email: 'q@example.com', tel: '', topic: '予約について', body: '質問です',
        reservation_id: null, status: 'new', staff_note: '', created_at: '2026-09-22T00:00:00+00:00', user_id: null, assigned_to: null
      };
      deq(rt(inquiryRow, 'inquiry'), inquiryRow);

      // カタログ: 列に無い項目は extra に入り、戻すと項目になる
      const assetRow = {
        id: 'V009', category_id: 'cat-rental', location_id: 'loc-kitami', name: 'テスト車', name_en: 'Test', plate: '北見 500 あ 12-34',
        capacity: 5, price_hour: null, price_day: 9900, price_week: null, price_month: null, stock: 1, required_license: '',
        image: '🚗', photo: '', active: false, shaken_date: '2027-03-31', maintenance_date: null,
        custom_fields: { bodyType: 'コンパクト' }, sort: 9, extra: { memo: '社用車' }
      };
      const a = B.fromDb.asset(assetRow);
      assert.equal(a.memo, '社用車');
      assert.equal(a.shakenDate, '2027-03-31');
      deq(rt(assetRow, 'asset'), assetRow);
      // 画面から来る値 (文字列の数値・ISO の日時・派生項目) は DB の型に揃える
      const fromScreen = B.toDb.asset(Object.assign({}, a, {
        priceDay: '12000', priceHour: '', shakenDate: '2027-03-30T15:00:00.000Z', active: 'true',
        vehicleId: 'V009', availability: { ok: true }, _tmp: 1
      }));
      assert.equal(fromScreen.price_day, 12000);
      assert.equal(fromScreen.price_hour, null);
      assert.equal(fromScreen.shaken_date, '2027-03-31');  // JST の日付
      assert.equal(fromScreen.active, true);
      deq(fromScreen.extra, { memo: '社用車' });

      const categoryRow = { id: 'cat-x', name: 'X', name_en: '', type: 'vehicle', icon: '', description: '', sort: 3, active: true, custom_field_defs: [], extra: { color: '#f00' } };
      deq(rt(categoryRow, 'category'), categoryRow);
      const optionRow = { id: 'OPX', name: 'X', price: 100, price_short: null, price_type: 'per_rental', category_ids: null, kind: 'other', exclusive_group: null, active: true, sort: 1, extra: { description: '説明' } };
      deq(rt(optionRow, 'option'), optionRow);
      const locationRow = { id: 'loc-x', name: 'X店', name_en: 'X', tel: '0157-00-0000', address: '北見', hours: '9-18', holiday: '', sort: 3, active: true, extra: {} };
      deq(rt(locationRow, 'location'), locationRow);
    } finally { page.close(); }
  });
});

// =====================================================================
// 管理画面 (本番モード) — 偽の supabase クライアントで書込フック等を確かめる
// =====================================================================
function fakeDb() {
  const uid = '11111111-2222-3333-4444-555555555555';
  const memberUid = '99999999-8888-7777-6666-555555555555';
  const reservation = {
    id: 'R00001', kind: 'rental', asset_id: 'V003', category_id: 'cat-rental', location_id: 'loc-kitami',
    start_at: '2026-10-01T01:00:00+00:00', end_at: '2026-10-02T01:00:00+00:00', status: 'confirmed', user_id: memberUid,
    customer_name: '会員 一郎', customer_kana: '', customer_email: 'm@example.com', customer_phone: '090', company: '',
    license_confirmed: true, payment_method: 'onsite', payment_status: 'unpaid', option_ids: [], options: [],
    price: { lines: [], total: 17000 }, total: 17000, discount_type: null, coupon_id: null, invoice_id: null, point_granted: false,
    note: '', staff_note: '', cancel_fee: null, cancelled_at: null, cancelled_by: null, source: 'web', version: 1,
    created_at: '2026-09-20T00:00:00+00:00', gcal_events: {}
  };
  return {
    __session: { access_token: 'fake-token', user: { id: uid, email: 'admin@example.com' } },
    __role: 'admin',
    __failRpc: {},
    categories: [{ id: 'cat-rental', name: '一般レンタカー', name_en: 'Rental Car', type: 'vehicle', icon: '🚗', description: '', sort: 1, active: true, custom_field_defs: [], extra: {} }],
    locations: [{ id: 'loc-kitami', name: '北見本店', name_en: 'Kitami', tel: '', address: '北海道北見市', hours: '', holiday: '', sort: 1, active: true, extra: {} },
                { id: 'loc-kushiro', name: '釧路店', name_en: 'Kushiro', tel: '', address: '北海道釧路市', hours: '', holiday: '', sort: 2, active: true, extra: {} }],
    assets: [{ id: 'V003', category_id: 'cat-rental', location_id: 'loc-kitami', name: 'マツダ CX-5', name_en: 'Mazda CX-5', plate: '', capacity: 5, price_hour: 2200, price_day: 17000, price_week: null, price_month: null, stock: 1, required_license: '', image: '🚙', photo: '', active: true, shaken_date: null, maintenance_date: null, custom_fields: { bodyType: 'SUV' }, sort: 3, extra: {} },
             { id: 'V002', category_id: 'cat-rental', location_id: 'loc-kushiro', name: '日産 ノート e-POWER', name_en: '', plate: '', capacity: 5, price_hour: 1100, price_day: 7700, price_week: null, price_month: null, stock: 1, required_license: '', image: '🚗', photo: '', active: true, shaken_date: null, maintenance_date: null, custom_fields: { bodyType: 'コンパクト' }, sort: 2, extra: {} }],
    options: [{ id: 'OP101', name: '免責補償制度 (CDW)', price: 1650, price_short: 1100, price_type: 'per_day', category_ids: ['cat-rental'], kind: 'cover', exclusive_group: 'cover', active: true, sort: 1, extra: {} }],
    app_settings: [{ key: 'site', value: { shopName: 'グロースレンタカー' } }, { key: 'points', value: { pointPerUse: 1, couponThreshold: 10, couponAmount: 1000, expiryMonths: 12 } }],
    app_collections: [{ collection: 'employees', id: 'E001', sort: 0, data: { id: 'E001', name: '本番 花子', email: '', store: '本店', role: '管理者', lastLogin: '', active: true } }],
    legal_documents: [{ id: 'privacy', version: '2026-08', title: 'プライバシーポリシー', url: 'privacy.html', effective_at: '2026-08-01', active: true }],
    members: [{ user_id: memberUid, member_no: 'M00001', email: 'm@example.com', name: '会員 一郎', name_kana: '', phone: '090', company: '', is_corporate: false, invoice_allowed: false, marketing_opt_in: false, status: 'active', last_use_at: null, created_at: '2026-01-01T00:00:00+00:00' }],
    member_points: [{ user_id: memberUid, points: 3 }],
    coupons: [],
    point_ledger: [{ id: 1, user_id: memberUid, delta: 3, reason: '移行', reservation_id: null, created_at: '2026-02-01T00:00:00+00:00' }],
    reservations: [reservation],
    invoices: [],
    inquiries: [{ id: 'C00001', name: '問合 花子', company: '', email: 'q@example.com', tel: '', topic: '予約', body: '本文', reservation_id: null, user_id: null, status: 'new', staff_note: '', assigned_to: null, created_at: '2026-09-01T00:00:00+00:00' }],
    staff: [{ user_id: uid, name: '管理 太郎', email: 'admin@example.com', role: 'admin', active: true, location_ids: null }]
  };
}

// db の特別な項目:
//   __session / __role / __aal         ログイン状態・staff_role の結果・AAL
//   __failRpc[name] = 'CODE'          その RPC を P0001 'CODE' で失敗させる
//   __failWrites                      insert/upsert/delete を RLS 違反 (42501) で失敗させる
//   __denyDelete                      delete を「エラーなし・0 件」で終わらせる (本物の RLS と同じ振る舞い)
//   __deleteError = {code, message}   delete をそのエラーで失敗させる (例: 外部キー違反 23503)
//   __failTables[table]               その表の select を通信エラーで失敗させる
//   __authListeners                   onAuthStateChange で登録されたコールバック
function fakeClient(db, log) {
  const test1 = (r, f) => {
    const v = r[f[0]];
    if (f[1] === 'eq' || f[1] === 'is') return v === f[2] || (f[1] === 'is' && f[2] === null && v == null);
    if (f[1] === 'in') return f[2].indexOf(v) >= 0;
    if (f[1] === 'gte') return v >= f[2];
    if (f[1] === 'lt') return v < f[2];
    return false;
  };
  const match = st => r => st.filters.every(f => test1(r, f));
  function exec(st) {
    log.push({ kind: 'from', table: st.table, op: st.op, payload: st.payload, filters: st.filters, cols: st.cols, count: st.count, range: st.range, orders: st.orders });
    if (st.op === 'select') {
      if (db.__failTables && db.__failTables[st.table]) return { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
      let rows = (db[st.table] || []).filter(match(st));
      if (st.single) return { data: rows[0] || null, error: null };
      const count = st.count ? rows.length : null;
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      return { data: JSON.parse(JSON.stringify(rows)), error: null, count: count };
    }
    if (db.__failWrites) return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
    if (st.op === 'delete') {
      if (db.__deleteError) return { data: null, error: db.__deleteError };
      const hit = (db[st.table] || []).filter(match(st));
      if (!db.__denyDelete) db[st.table] = (db[st.table] || []).filter(r => hit.indexOf(r) < 0);
      const deleted = db.__denyDelete ? [] : hit;
      return { data: st.cols ? JSON.parse(JSON.stringify(deleted)) : null, error: null };
    }
    return { data: null, error: null };
  }
  function builder(table) {
    const st = { table: table, op: 'select', filters: [], range: null, single: false, payload: null, orders: [] };
    const b = {
      select(cols, opts) { st.cols = cols; if (opts && opts.count) st.count = opts.count; return b; },
      order(col, o) { st.orders.push([col, !!(o && o.ascending)]); return b; },
      range(x, y) { st.range = [x, y]; return b; },
      eq(col, v) { st.filters.push([col, 'eq', v]); return b; },
      in(col, vs) { st.filters.push([col, 'in', vs]); return b; },
      is(col, v) { st.filters.push([col, 'is', v]); return b; },
      gte(col, v) { st.filters.push([col, 'gte', v]); return b; },
      lt(col, v) { st.filters.push([col, 'lt', v]); return b; },
      maybeSingle() { st.single = true; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = JSON.parse(JSON.stringify(p)); return b; },
      delete() { st.op = 'delete'; return b; },
      then(ok, ng) { return Promise.resolve(exec(st)).then(ok, ng); }
    };
    return b;
  }
  const rpcs = {
    public_catalog: () => ({
      categories: db.categories, locations: db.locations, assets: db.assets, options: db.options,
      settings: {}, collections: {}, legal: [], serverTime: new Date().toISOString()
    }),
    staff_role: () => db.__role,
    // 本物と同じく、ログイン中の本人の予約だけ (列は限定済み)
    member_reservations: () => {
      const uid = db.__session && db.__session.user && db.__session.user.id;
      return JSON.parse(JSON.stringify(db.reservations.filter(r => r.kind === 'rental' && uid && r.user_id === uid)))
        .map(r => { delete r.staff_note; delete r.gcal_events; delete r.source; return r; });
    },
    admin_create_reservation: a => {
      const asset = db.assets.find(x => x.id === a.p.asset_id);
      const row = Object.assign({}, db.reservations[0], {
        id: 'R' + String(900 + db.reservations.length).padStart(5, '0'), kind: a.p.kind || 'rental',
        asset_id: asset.id, category_id: asset.category_id, location_id: asset.location_id,
        start_at: a.p.start_at, end_at: a.p.end_at, status: 'confirmed', user_id: a.p.user_id || null,
        customer_name: a.p.customer_name || '', staff_note: a.p.staff_note || '', version: 1
      });
      db.reservations.push(row);
      return JSON.parse(JSON.stringify(row));
    },
    admin_recent_activity: () => [{ at: '2026-09-22T00:00:00+00:00', type: 'reservation', message: '新規予約 R00001 (会員 一郎 様) を受け付けました', ref_id: 'R00001' }],
    admin_update_reservation: a => {
      const r = db.reservations.find(x => x.id === a.p_id);
      if (a.p_version != null && a.p_version !== r.version) throw new Error('VERSION_CONFLICT');
      if (a.p_patch.status) r.status = a.p_patch.status;
      if (a.p_patch.staff_note != null) r.staff_note = a.p_patch.staff_note;
      r.version += 1;
      return JSON.parse(JSON.stringify(r));
    },
    admin_update_member: a => {
      const m = db.members.find(x => x.user_id === a.p_user);
      if (a.p_patch.name != null) m.name = a.p_patch.name;
      return JSON.parse(JSON.stringify(m));
    },
    admin_adjust_points: a => {
      const p = db.member_points.find(x => x.user_id === a.p_user);
      p.points += a.p_delta;
      return p.points;
    }
  };
  return {
    auth: {
      getSession: async () => ({ data: { session: db.__session || null }, error: null }),
      signOut: async () => { log.push({ kind: 'signOut' }); db.__session = null; return { error: null }; },
      onAuthStateChange: cb => {
        (db.__authListeners = db.__authListeners || []).push(cb);
        return { data: { subscription: { unsubscribe() { db.__authListeners = db.__authListeners.filter(x => x !== cb); } } } };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: db.__aal || 'aal2' }, error: null }) }
    },
    rpc: async (name, args) => {
      log.push({ kind: 'rpc', name: name, args: JSON.parse(JSON.stringify(args || {})) });
      if (db.__failRpc[name]) return { data: null, error: { message: db.__failRpc[name], code: 'P0001' } };
      const h = rpcs[name];
      if (!h) return { data: null, error: { message: 'NOT_FOUND', code: 'P0001' } };
      try { return { data: h(args || {}), error: null }; } catch (e) { return { data: null, error: { message: e.message, code: 'P0001' } }; }
    },
    from: builder
  };
}

describe('管理画面 (本番モード・偽クライアント)', { skip: NO_JSDOM }, () => {
  test('employees.html: 本番は「スタッフ・権限」への案内だけ出し、一覧 (デモの既定行) を表示も保存もしない', async () => {
    const db = fakeDb();
    const log = [];
    const page = openPage('manage/employees.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore, B = w.SkyRentBackend;
      assert.equal(S.live, true);
      assert.equal(B.admin.staff.role, 'admin');
      assert.equal(B.admin.can('staff.write'), true);
      assert.equal(page.document.getElementById('emp-live-notice').hidden, false, '案内が出ない');
      assert.equal(page.document.getElementById('emp-list').hidden, true, '一覧が出ている');
      assert.equal(page.document.getElementById('emp-staff-link').hidden, false);
      await sleep(100);
      assert.equal(log.filter(l => l.table === 'app_collections' && l.op !== 'select').length, 0, '既定行が保存された');
      deq(businessKeys(w.localStorage), []);
      // 全データが入っている
      assert.equal(S.findById('reservations', 'reservationId', 'R00001').assetName, 'マツダ CX-5');
      assert.equal(S.findById('reservations', 'reservationId', 'R00001').memberId, 'M00001');
      assert.equal(S.getMember('M00001').points, 3);
      assert.equal(S.notifications()[0].refId, 'R00001');
      assert.equal(S.read('settings.site').shopName, 'グロースレンタカー');
      assertClean(page, 'fake-employees');
    } finally { page.close(); }
  });

  test('notices.html (crud.js): サーバーの一覧を表示し、デモの既定行を書かない / 保存は app_collections へ差分', async () => {
    const db = fakeDb();
    db.app_collections.push({ collection: 'notices', id: 'N001', sort: 0, data: { id: 'N001', date: '2026-09-01', title: '本番のお知らせ', category: 'お知らせ', expiry: '無期限', active: true } });
    const log = [];
    const page = openPage('manage/notices.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      // サーバーの 1 行だけ (既定の 5 行は出さない・書かない)
      assert.equal(page.document.querySelectorAll('#tbl tr').length, 1);
      assert.match(page.document.querySelector('#tbl').textContent, /本番のお知らせ/);
      assert.equal(log.filter(l => l.table === 'app_collections' && l.op !== 'select').length, 0, '既定行が保存された');
      deq(businessKeys(w.localStorage), []);

      // crud.js から保存 → app_collections へ差分 upsert
      const list = w.SkyRentCRUD.load('notices', []);
      list.push({ id: 'N002', date: '2026-09-20', title: '追加のお知らせ', category: 'お知らせ', expiry: '-', active: true });
      w.SkyRentCRUD.save('notices', list);
      await waitFor(() => log.some(l => l.table === 'app_collections' && l.op === 'upsert'), 2000);
      const up = log.find(l => l.table === 'app_collections' && l.op === 'upsert');
      deq(up.payload.map(r => r.id), ['N002'], '変わった行だけ送る');
      assert.equal(up.payload[0].collection, 'notices');
      // 削除
      w.SkyRentCRUD.save('notices', list.slice(1));
      await waitFor(() => log.some(l => l.table === 'app_collections' && l.op === 'delete'), 2000);
      const del = log.find(l => l.table === 'app_collections' && l.op === 'delete');
      deq(del.filters, [['collection', 'eq', 'notices'], ['id', 'in', ['N001']]]);
      deq(businessKeys(w.localStorage), []);
      assertClean(page, 'fake-notices');
    } finally { page.close(); }
  });

  test('書込フック (カタログ・設定・会員・予約) とドメイン関数の差し替え・失敗時のトースト', async () => {
    const db = fakeDb();
    const log = [];
    const page = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore;
      const writes = () => log.filter(l => (l.kind === 'from' && l.op !== 'select') || (l.kind === 'rpc' && /^admin_(update|adjust|create|issue|set)/.test(l.name)));

      // カタログ: 変わった車両だけ upsert
      const assets = S.assets();
      assets.find(a => a.assetId === 'V003').priceDay = 18000;
      S.write('assets', assets);
      await waitFor(() => writes().length >= 1, 2000);
      let wr = writes();
      assert.equal(wr.length, 1);
      assert.equal(wr[0].table, 'assets');
      assert.equal(wr[0].op, 'upsert');
      assert.equal(wr[0].payload.id, 'V003');
      assert.equal(wr[0].payload.price_day, 18000);
      log.length = 0;

      // 設定 → app_settings
      S.write('settings.site', { shopName: '新しい名前' });
      await waitFor(() => writes().length >= 1, 2000);
      deq(writes()[0].payload, { key: 'site', value: { shopName: '新しい名前' } });
      log.length = 0;

      // 会員の変更 → admin_update_member
      const members = S.members();
      members[0].name = '会員 一郎 (改)';
      S.write('members', members);
      await waitFor(() => writes().length >= 1, 2000);
      assert.equal(writes()[0].name, 'admin_update_member');
      deq(writes()[0].args.p_patch, { name: '会員 一郎 (改)' });
      log.length = 0;

      // S.updateReservation (差し替え) → admin_update_reservation (楽観更新)
      const after = S.updateReservation('R00001', { status: 'in_use' });
      assert.equal(after.status, 'in_use');
      assert.equal(S.findById('reservations', 'reservationId', 'R00001').status, 'in_use');
      await waitFor(() => writes().length >= 1, 2000);
      assert.equal(writes()[0].name, 'admin_update_reservation');
      deq(writes()[0].args, { p_id: 'R00001', p_patch: { status: 'in_use' }, p_version: 1 });
      await waitFor(() => S.findById('reservations', 'reservationId', 'R00001').version === 2, 2000);
      assert.equal(S.findById('reservations', 'reservationId', 'R00001').version, 2, 'サーバーの結果で置き換わらない');
      log.length = 0;

      // S.adjustPoints (差し替え)
      S.adjustPoints('M00001', 2, 'テスト');
      assert.equal(S.getMember('M00001').points, 5);
      await waitFor(() => log.some(l => l.name === 'admin_adjust_points'), 2000);
      deq(log.find(l => l.name === 'admin_adjust_points').args, { p_user: db.members[0].user_id, p_delta: 2, p_reason: 'テスト' });
      log.length = 0;

      // 失敗 → 日本語のトースト + 取り直し
      db.__failRpc.admin_update_reservation = 'VERSION_CONFLICT';
      S.updateReservation('R00001', { staffNote: 'メモ' });
      const toast = await waitFor(() => page.document.querySelector('.skyrent-toast--error'), 3000);
      assert.ok(toast, 'エラーのトーストが出ない');
      assert.match(toast.textContent, /他のスタッフが先に/);
      await waitFor(() => S.findById('reservations', 'reservationId', 'R00001').staffNote === '', 3000);
      assert.equal(S.findById('reservations', 'reservationId', 'R00001').staffNote, '', '失敗後に最新データを取り直していない');

      // サーバー管理のキーは無視 (警告のみ)
      log.length = 0;
      S.notify('info', 'テスト');
      await sleep(50);
      assert.equal(writes().length, 0);
      deq(businessKeys(w.localStorage), []);
      deq(page.errors, []);
      deq(page.resourceErrors, []);
    } finally { page.close(); }
  });

  test('スタッフでないアカウント → サインアウトして login.html?error=not_staff / AAL1 → step=mfa', async () => {
    const db = fakeDb();
    db.__role = null;
    db.staff = [];
    const log = [];
    const page = openPage('manage/reservation-list.html?x=1', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      const url = await waitFor(() => page.window.SkyRentBackend && page.window.SkyRentBackend._lastRedirect, 5000);
      assert.equal(url, 'login.html?next=reservation-list.html%3Fx%3D1&error=not_staff');
      assert.ok(log.some(l => l.kind === 'signOut'));
      assert.equal(page.window.__readyFired, false);
    } finally { page.close(); }

    const db2 = fakeDb();
    db2.__role = null;
    db2.__aal = 'aal1';
    const page2 = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db2, []) });
    try {
      const url = await waitFor(() => page2.window.SkyRentBackend && page2.window.SkyRentBackend._lastRedirect, 5000);
      assert.equal(url, 'login.html?next=dashboard.html&step=mfa');
    } finally { page2.close(); }
  });
});

describe('本番モード (偽クライアント): 設定画面・8秒の安全策', { skip: NO_JSDOM }, () => {
  test('site-settings.html: サーバーの設定をフォームに出し、保存はフォームに無い項目を残して app_settings へ', async () => {
    const db = fakeDb();
    const log = [];
    const page = openPage('manage/site-settings.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const doc = page.document;
      doc.querySelector('[data-setting="siteName"]').value = '本番の名前';
      doc.querySelector('[data-save]').click();
      await waitFor(() => log.some(l => l.table === 'app_settings' && l.op === 'upsert'), 2000);
      const up = log.find(l => l.table === 'app_settings' && l.op === 'upsert');
      assert.equal(up.payload.key, 'site');
      assert.equal(up.payload.value.siteName, '本番の名前');
      assert.equal(up.payload.value.shopName, 'グロースレンタカー', 'サーバーの既存項目が消えた');
      deq(businessKeys(page.window.localStorage), []);
      assertClean(page, 'fake-site-settings');
    } finally { page.close(); }
  });

  test('init が終わらないとき 8 秒で画面を表示する (ページ処理は待つ)', async () => {
    const db = fakeDb();
    const client = fakeClient(db, []);
    client.rpc = () => new Promise(() => {});  // 応答が返らない
    const page = openPage('index.html', { mode: 'fake', fakeClient: client });
    try {
      await sleep(1000);
      assert.equal(page.document.documentElement.classList.contains('skyrent-booting'), true, '読み込み中は隠す');
      await sleep(7500);
      assert.equal(page.document.documentElement.classList.contains('skyrent-booting'), false, '8 秒で表示されない');
      const banner = page.document.getElementById('skyrent-boot-banner');
      assert.ok(banner && /時間がかかっています/.test(banner.textContent), '案内バナーが出ない');
      assert.equal(page.window.__readyFired, false);
    } finally { page.close(); }
  });
});

// =====================================================================
// メールのリンク (パスワード再設定・招待・メール確認) — SkyRentBackend.auth.urlEvent()
// =====================================================================
const RECOVERY_HASH = '#access_token=fake-at&expires_at=1990000000&expires_in=3600&refresh_token=fake-rt&sb=&token_type=bearer&type=recovery';
const EXPIRED_HASH = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=';

describe('メールのリンク: urlEvent と supabase-js への受け渡し', { skip: NO_JSDOM }, () => {
  test('#access_token (type=recovery) → urlEvent.type = recovery / detectSessionInUrl は access_token のときだけ true', async () => {
    const db = fakeDb();
    const page = openPage('index.html' + RECOVERY_HASH, { mode: 'fake', fakeClient: fakeClient(db, []) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend;
      deq(B.auth.urlEvent(), { type: 'recovery', error: null, message: null });
      const opts = w.__createClient.options;
      assert.equal(typeof opts.auth.detectSessionInUrl, 'function');
      const detect = params => opts.auth.detectSessionInUrl(new URL(ORIGIN + '/index.html'), params);
      assert.equal(detect({ access_token: 'x', type: 'recovery' }), true);
      assert.equal(detect({ lookup: 'R00001.token' }), false, '#lookup を supabase-js に渡している');
      assert.equal(detect({ error: 'access_denied', error_code: 'otp_expired', error_description: 'x' }), false, 'エラーだけの # を supabase-js に渡している');
      assert.equal(opts.auth.persistSession, true);
      assert.equal(opts.auth.storage, undefined, 'localhost では既定 (localStorage) のまま');
      assertClean(page, 'recovery-hash');
    } finally { page.close(); }
  });

  test('PASSWORD_RECOVERY は createClient 直後に登録したリスナーで記録する (後から登録したページにも分かる)', async () => {
    const db = fakeDb();
    const page = openPage('index.html', { mode: 'fake', fakeClient: fakeClient(db, []) });
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      assert.equal(B.auth.urlEvent().type, null);
      assert.ok((db.__authListeners || []).length >= 1, 'onAuthStateChange が登録されていない');
      db.__authListeners.forEach(cb => cb('SIGNED_IN', db.__session));
      assert.equal(B.auth.urlEvent().type, null);
      db.__authListeners.forEach(cb => cb('PASSWORD_RECOVERY', db.__session));
      assert.equal(B.auth.urlEvent().type, 'recovery');
      assertClean(page, 'password-recovery-event');
    } finally { page.close(); }
  });

  test('#lookup=... (ゲスト照会) は残す / 期限切れのエラーは日本語付きで記録し、# を消す', async () => {
    const page = openPage('index.html#lookup=R00001.guest-token', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []) });
    try {
      assert.equal(await page.ready(8000), true);
      deq(page.window.SkyRentBackend.auth.urlEvent(), { type: null, error: null, message: null });
      assert.equal(page.window.location.hash, '#lookup=R00001.guest-token', '#lookup が消えた');
    } finally { page.close(); }

    const page2 = openPage('index.html' + EXPIRED_HASH, { mode: 'fake', fakeClient: fakeClient(fakeDb(), []) });
    try {
      assert.equal(await page2.ready(8000), true);
      const ev = page2.window.SkyRentBackend.auth.urlEvent();
      assert.equal(ev.type, null);
      assert.equal(ev.error.code, 'otp_expired');
      assert.equal(ev.error.description, 'Email link is invalid or has expired');
      assert.match(ev.error.message, /有効期限/);
      assert.equal(page2.window.location.hash, '', 'エラーの # が URL に残っている');
      // 返す値はコピー (ページが書き換えても次の呼び出しに影響しない)
      ev.error.code = 'x';
      assert.equal(page2.window.SkyRentBackend.auth.urlEvent().error.code, 'otp_expired');
      assertClean(page2, 'expired-hash');
    } finally { page2.close(); }

    // デモモードでも同じ形で返す
    const page3 = openPage('index.html#access_token=a&expires_in=3600&refresh_token=b&token_type=bearer&type=invite');
    try {
      assert.equal(await page3.ready(8000), true);
      deq(page3.window.SkyRentBackend.auth.urlEvent(), { type: 'invite', error: null, message: null });
      assertClean(page3, 'demo-hash');
    } finally { page3.close(); }
  });
});

// =====================================================================
// ログイン状態の保存先 (AUTH_STORAGE)
// =====================================================================
describe('ログイン状態の保存先: *.github.io は sessionStorage', { skip: NO_JSDOM }, () => {
  const GH = 'https://skyrent-owner.github.io';
  const ghConfig = extra => 'Object.assign(window.SKY_RENT_CONFIG, ' + JSON.stringify(Object.assign({}, FAKE_CONFIG, extra || {})) + ');';

  test('github.io (auto) → sessionStorage・古い localStorage のトークンを消す / AUTH_STORAGE で切り替え', async () => {
    const db = fakeDb();
    const page = openPage('index.html', {
      mode: 'fake', fakeClient: fakeClient(db, []), origin: GH, configJs: ghConfig(),
      local: { 'sb-fake-supabase-auth-token': '{"access_token":"old"}' }
    });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      assert.equal(w.location.hostname, 'skyrent-owner.github.io');
      assert.equal(w.SkyRentBackend.live, true);
      assert.ok(w.__createClient.options.auth.storage === w.sessionStorage, 'sessionStorage になっていない');
      assert.equal(w.localStorage.getItem('sb-fake-supabase-auth-token'), null, '古いトークンが localStorage に残っている');
      assertClean(page, 'gh-auto');
    } finally { page.close(); }

    const page2 = openPage('index.html', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []), origin: GH, configJs: ghConfig({ AUTH_STORAGE: 'local' }) });
    try {
      assert.equal(await page2.ready(8000), true);
      assert.equal(page2.window.__createClient.options.auth.storage, undefined, "AUTH_STORAGE: 'local' なら既定");
    } finally { page2.close(); }

    const page3 = openPage('index.html', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []), config: { AUTH_STORAGE: 'session' } });
    try {
      assert.equal(await page3.ready(8000), true);
      assert.ok(page3.window.__createClient.options.auth.storage === page3.window.sessionStorage, "AUTH_STORAGE: 'session' が効かない");
    } finally { page3.close(); }
  });
});

// =====================================================================
// パスワードの条件 (WEAK_PASSWORD)
// =====================================================================
describe('パスワードの条件', { skip: NO_JSDOM }, () => {
  test('8文字以上・英大文字・英小文字・数字 (デモの会員登録・パスワード変更も同じ条件)', async () => {
    const page = openPage('index.html');
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      [['Abcdefg1', true], ['abcdefg1', false], ['ABCDEFG1', false], ['Abcdefgh', false], ['Abc1234', false], ['', false], [null, false]]
        .forEach(([pw, ok]) => assert.equal(B.auth.checkPassword(pw).ok, ok, String(pw)));
      assert.equal(B.auth.checkPassword('abc').message, '8文字以上で、英大文字・英小文字・数字をそれぞれ1文字以上含めてください。');
      const email = 'weak-' + Date.now() + '@example.com';
      await assert.rejects(B.auth.signUp({ email: email, password: 'abcdefgh1', name: 'テスト' }), e => e.code === 'WEAK_PASSWORD' && /英大文字/.test(e.message));
      const ok = await B.auth.signUp({ email: email, password: 'Abcdefgh1', name: 'テスト' });
      assert.equal(ok.ok, true);
      await assert.rejects(B.auth.updatePassword('short1A'), e => e.code === 'WEAK_PASSWORD');
      assert.equal((await B.auth.updatePassword('Newpass123')).ok, true);
      await B.auth.signOut();
      assertClean(page, 'password-policy');
    } finally { page.close(); }
  });
});

// =====================================================================
// 日時は常に日本時間 (TZ=America/Los_Angeles などでも同じ結果)
// =====================================================================
describe('日時 (datetime-local の値は日本時間)', { skip: NO_JSDOM }, () => {
  test('SkyRentBackend.jst / store の空き判定・予約の保存 / デモのシードは日本時間 10:00', async () => {
    const page = openPage('index.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend, S = w.SkyRentStore;
      assert.equal(B.jst.fromInput('2026-10-01T10:00'), '2026-10-01T01:00:00.000Z');
      assert.equal(B.jst.fromInput('2026-10-01T01:00:00Z'), '2026-10-01T01:00:00.000Z');
      assert.equal(B.jst.fromInput('2026/10/1 9:05'), '2026-10-01T00:05:00.000Z');
      assert.equal(B.jst.fromInput(''), null);
      assert.equal(B.jst.fromInput('2026-02-30T10:00'), null);
      assert.equal(B.jst.toInput('2026-10-01T01:00:00Z'), '2026-10-01T10:00');
      assert.equal(B.jst.toInput('2026-09-30T15:30:00.000Z'), '2026-10-01T00:30');
      assert.equal(B.jst.toInput('2026-10-01T10:00'), '2026-10-01T10:00');
      assert.equal(B.jst.toInput('こわれた値'), '');
      assert.equal(B.jst.format('2026-10-01T01:00:00Z'), '2026/10/01(木) 10:00');
      assert.equal(B.jst.format('2026-10-01T10:00'), '2026/10/01(木) 10:00');
      assert.equal(B.jst.format('2026-10-01T01:00:00Z', { time: false }), '2026/10/01(木)');
      assert.equal(B.jst.format('2026-10-01T01:00:00Z', { weekday: false }), '2026/10/01 10:00');
      assert.equal(B.jst.format('2026-10-01T01:00:00Z', { year: false }), '10/01(木) 10:00');
      assert.equal(B.jst.format(''), '');
      assert.equal(B.jst.ymd('2026-09-30T15:30:00Z'), '2026-10-01');

      // デモのシード予約は日本時間の 10:00
      const seeds = S.list('reservations');
      assert.ok(seeds.length > 0);
      assert.ok(seeds.every(r => B.jst.toInput(r.start).slice(11) === '10:00'), 'シードの時刻が日本時間 10:00 でない');

      // 貸出停止枠 (日本時間の入力) → ISO で保存
      const blk = await B.admin.createBlock({ assetId: 'V001', start: '2027-03-10T10:00', end: '2027-03-11T10:00', note: '車検' });
      assert.equal(blk.reservation.start, '2027-03-10T01:00:00.000Z');
      assert.equal(blk.reservation.end, '2027-03-11T01:00:00.000Z');
      // 空き判定も日本時間 (返却 10:00 の直前は重なる / ちょうど 10:00 からは空き)
      assert.equal(S.availability('V001', '2027-03-11T09:30', '2027-03-11T12:00', 1).ok, false);
      assert.equal(S.availability('V001', '2027-03-11T10:00', '2027-03-11T12:00', 1).ok, true);
      assert.equal(S.availability('V001', '2027-03-10T01:30:00Z', '2027-03-10T02:00:00Z', 1).ok, false);
      assert.equal(S.availability('V001', '2027-03-10T00:30:00Z', '2027-03-10T01:00:00Z', 1).ok, true);  // 日本時間 9:30〜10:00
      // store の予約作成・更新も ISO にそろえる
      const r = S.createReservation({ assetId: 'V002', start: '2027-04-01T09:00', end: '2027-04-02T09:00', customerName: '日時 テスト' });
      assert.equal(r.start, '2027-04-01T00:00:00.000Z');
      const u = S.updateReservation(r.reservationId, { end: '2027-04-02T18:00' });
      assert.equal(u.end, '2027-04-02T09:00:00.000Z');
      // 見積 (デモ) も日本時間で計算: 20:00 貸出は夜間料金
      const q = await B.quote({ assetId: 'V001', start: '2027-05-11T20:00', end: '2027-05-12T10:00', optionIds: [] });
      assert.ok(q.quote.lines.some(l => l.code === 'night'), '日本時間 20:00 の夜間料金が付かない');
      assertClean(page, 'jst');
    } finally { page.close(); }
  });

  test('空き状況の取得範囲は日本時間の昨日 0:00 から / staffCheck も日本時間の入力で判定', async () => {
    const db = fakeDb();
    const page = openPage('detail.html?id=V003', { mode: 'fake', fakeClient: fakeClient(db, []) });
    const w = page.window;
    const calls = [];
    const availability = {
      ok: true, busy: [], handovers: {},
      staff: {
        enabled: true, mode: 'handover', handoverMinutes: 30, oneHandoverAtATime: false,
        locations: { 'loc-kitami': { configured: true, busy: [{ start: '2026-10-15T00:00:00Z', end: '2026-10-15T03:00:00Z' }] } }
      }
    };
    w.fetch = async url => {
      calls.push(String(url));
      if (String(url).indexOf('/functions/v1/api/availability') >= 0) return { ok: true, status: 200, json: async () => availability };
      return { ok: false, status: 404, json: async () => ({ ok: false, code: 'NOT_FOUND', message: 'not found' }) };
    };
    try {
      assert.equal(await page.ready(8000), true);
      const B = w.SkyRentBackend;
      const u = new URL(calls.find(c => c.indexOf('/api/availability?') >= 0));
      const DAYMS = 86400000, JST = 9 * 3600000;
      const today = Math.floor((Date.now() + JST) / DAYMS) * DAYMS - JST;
      assert.equal(u.searchParams.get('from'), new Date(today - DAYMS).toISOString(), '取得開始が日本時間の昨日 0:00 でない');
      assert.equal(u.searchParams.get('to'), new Date(today - DAYMS + 120 * DAYMS).toISOString());
      // 担当者の予定あり = 日本時間 10/15 9:00〜12:00
      assert.equal(B.staffCheck('V003', '2026-10-15T10:00', '2026-10-16T14:00').code, 'STAFF_UNAVAILABLE');
      assert.equal(B.staffCheck('V003', '2026-10-15T12:00', '2026-10-16T14:00').ok, true);
      assert.equal(w.SkyRentStore.availability('V003', '2026-10-15T11:30', '2026-10-16T14:00', 1).code, 'STAFF_UNAVAILABLE');
      assertClean(page, 'jst-availability');
    } finally { page.close(); }
  });
});

// =====================================================================
// 管理画面の書込 (偽クライアント): 削除件数の確認・予約の版・会員の user_id・init 失敗時
// =====================================================================
describe('管理画面の書込 (偽クライアント) — 第1波の点検の修正', { skip: NO_JSDOM }, () => {
  async function openAdmin(db, log, path) {
    const page = openPage(path || 'manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    assert.equal(await page.ready(8000), true);
    return page;
  }
  const errorToasts = page => Array.prototype.map.call(page.document.querySelectorAll('.skyrent-toast--error'), el => el.textContent);

  test('RLS で拒否された削除 (0 件) は FORBIDDEN のトーストを出して取り直す (カタログ・設定・汎用一覧)', async () => {
    const db = fakeDb();
    const log = [];
    const page = await openAdmin(db, log);
    try {
      const w = page.window, S = w.SkyRentStore;
      db.__denyDelete = true;
      // カタログ
      S.write('assets', S.assets().filter(a => a.assetId !== 'V002'));
      await waitFor(() => errorToasts(page).length >= 1, 3000);
      assert.match(errorToasts(page)[0], /権限がありません/);
      await waitFor(() => S.getAsset('V002'), 3000);
      assert.ok(S.getAsset('V002'), '失敗後に取り直していない');
      assert.equal(db.assets.length, 2);
      // 設定 (キーの削除)
      S.write('settings.site', undefined);
      await waitFor(() => errorToasts(page).length >= 2, 3000);
      assert.match(errorToasts(page)[1], /権限がありません/);
      await waitFor(() => S.read('settings.site', null), 3000);
      assert.equal(S.read('settings.site').shopName, 'グロースレンタカー');
      // 汎用一覧
      S.write('employees', []);
      await waitFor(() => errorToasts(page).length >= 3, 3000);
      assert.match(errorToasts(page)[2], /権限がありません/);
      assert.equal(db.app_collections.length, 1);

      // 本当に消えたときはトーストを出さない / 既に無い行の削除も成功扱い
      db.__denyDelete = false;
      const before = errorToasts(page).length;
      log.length = 0;
      S.write('assets', S.assets().filter(a => a.assetId !== 'V002'));
      S.write('settings.never-saved', undefined);
      await waitFor(() => log.filter(l => l.op === 'delete').length >= 2, 3000);
      await sleep(100);
      assert.equal(db.assets.length, 1);
      assert.equal(errorToasts(page).length, before, '成功した削除でエラーが出た');
      assert.ok(log.some(l => l.table === 'assets' && l.op === 'delete'));
    } finally { page.close(); }
  });

  test('外部キー違反 (23503) は「予約などで使われているため削除できません」', async () => {
    const db = fakeDb();
    const page = await openAdmin(db, []);
    try {
      const S = page.window.SkyRentStore;
      db.__deleteError = { code: '23503', message: 'update or delete on table "assets" violates foreign key constraint "reservations_asset_id_fkey" on table "reservations"' };
      S.write('assets', S.assets().filter(a => a.assetId !== 'V003'));
      await waitFor(() => errorToasts(page).length >= 1, 3000);
      assert.match(errorToasts(page)[0], /予約などで使われているため削除できません。無効にしてください。/);
    } finally { page.close(); }
  });

  test('予約を続けて更新しても VERSION_CONFLICT にならない (版はジョブ実行時の store の値) / 日時は日本時間で送る', async () => {
    const db = fakeDb();
    const log = [];
    const page = await openAdmin(db, log);
    try {
      const S = page.window.SkyRentStore;
      S.updateReservation('R00001', { status: 'in_use' });
      S.updateReservation('R00001', { staffNote: 'キー受け渡し済み' });
      S.updateReservation('R00001', { end: '2026-10-02T18:00' });
      await waitFor(() => log.filter(l => l.name === 'admin_update_reservation').length >= 3 && S.findById('reservations', 'reservationId', 'R00001').version === 4, 3000);
      const calls = log.filter(l => l.name === 'admin_update_reservation');
      deq(calls.map(c => c.args.p_version), [1, 2, 3]);
      deq(calls[2].args.p_patch, { end: '2026-10-02T09:00:00.000Z' });
      assert.equal(errorToasts(page).length, 0, 'エラーのトーストが出た');
      const r = S.findById('reservations', 'reservationId', 'R00001');
      assert.equal(r.status, 'in_use');
      assert.equal(r.staffNote, 'キー受け渡し済み');
      assert.equal(db.reservations[0].staff_note, 'キー受け渡し済み');
      deq(page.errors, []);
      deq(page.consoleErrors, []);
    } finally { page.close(); }
  });

  test('store に直接追加された予約は memberId から user_id を引いて admin_create_reservation へ', async () => {
    const db = fakeDb();
    const log = [];
    const page = await openAdmin(db, log);
    try {
      const S = page.window.SkyRentStore;
      S.createReservation({
        assetId: 'V002', start: '2027-01-10T10:00', end: '2027-01-11T10:00', memberId: 'M00001',
        customerName: '会員 一郎', customerEmail: 'm@example.com', customerPhone: '090', paymentMethod: 'onsite'
      });
      await waitFor(() => log.some(l => l.name === 'admin_create_reservation'), 3000);
      const p = log.find(l => l.name === 'admin_create_reservation').args.p;
      assert.equal(p.user_id, db.members[0].user_id);
      assert.equal(p.start_at, '2027-01-10T01:00:00.000Z');
      assert.equal(p.end_at, '2027-01-11T01:00:00.000Z');
      // 採番後に取り直す
      await waitFor(() => S.list('reservations').some(r => r.reservationId === 'R00901'), 3000);
      assert.equal(S.findById('reservations', 'reservationId', 'R00901').memberId, 'M00001');
      assert.equal(errorToasts(page).length, 0);
    } finally { page.close(); }
  });

  test('init に失敗したら、書込は「サーバーに接続できないため保存できません」と知らせて元に戻す', async () => {
    const db = fakeDb();
    db.__failTables = { reservations: true };
    const log = [];
    const page = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore;
      assert.equal(await w.SkyRentBackend.ready, false);
      assert.ok(page.document.getElementById('skyrent-boot-banner'), 'エラーバナーが出ない');
      log.length = 0;
      S.write('settings.site', { shopName: '保存されない' });
      assert.equal(S.read('settings.site', null), null, 'メモリにだけ保存された');
      S.write('assets', [{ assetId: 'X1', name: 'x' }]);
      deq(S.list('assets'), []);
      S.updateReservation('R-none', { status: 'cancelled' });
      await waitFor(() => errorToasts(page).length >= 1, 2000);
      assert.equal(errorToasts(page).length, 1, 'トーストは続けて出さない');
      assert.match(errorToasts(page)[0], /サーバーに接続できないため保存できません/);
      // 画面の一時データはそのまま使える
      S.write('ui.tmp', { a: 1 });
      deq(S.read('ui.tmp'), { a: 1 });
      assert.equal(log.filter(l => l.kind === 'from' && l.op !== 'select').length, 0, 'サーバーへ書こうとした');
      deq(businessKeys(w.localStorage), []);
      deq(page.errors, []);
    } finally { page.close(); }
  });

  test('会員 (公開ページ): 予約は member_reservations RPC で本人分だけ読み、予約表を直接読まない', async () => {
    const db = fakeDb();
    const memberUid = db.members[0].user_id;
    db.__session = { access_token: 'member-token', user: { id: memberUid, email: 'm@example.com' } };
    // 他人の予約
    db.reservations.push(Object.assign({}, db.reservations[0], { id: 'R00002', user_id: '00000000-0000-0000-0000-000000000000', customer_name: '他人' }));
    const log = [];
    const page = openPage('index.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const S = page.window.SkyRentStore, B = page.window.SkyRentBackend;
      assert.equal(B.member.current().memberId, 'M00001');
      assert.equal(B.member.current().points, 3);
      deq(S.list('reservations').map(r => r.reservationId), ['R00001']);
      assert.equal(S.list('reservations')[0].memberId, 'M00001');
      assert.equal(S.list('reservations')[0].staffNote, undefined);
      assert.ok(log.some(l => l.kind === 'rpc' && l.name === 'member_reservations'));
      assert.equal(log.filter(l => l.kind === 'from' && l.table === 'reservations').length, 0, '予約表を直接読んでいる');
      assertClean(page, 'member-reservations');
    } finally { page.close(); }
  });
});

// =====================================================================
// 本番モード (ローカル Supabase): メールのリンク・保存先・RLS で拒否された削除
// =====================================================================
describe('本番モード: ローカル Supabase (C2 の修正)', { skip: NO_JSDOM || (SUPABASE_UMD ? false : 'supabase-js が見つかりません') }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });

  async function createMember(password) {
    const email = 'frontend-core-member-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '@example.com';
    const user = await api('/auth/v1/admin/users', {
      service: true,
      body: { email: email, password: password, email_confirm: true, user_metadata: { account_type: 'member', name: 'テスト 会員' } }
    });
    return { email: email, userId: user.id || (user.user && user.user.id) };
  }

  test('パスワード再設定のリンク (実際の Auth のリダイレクト) → urlEvent = recovery・ログイン済み・# は消え、新しいパスワードを設定できる', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const m = await createMember('Init-Pass-2026a');
    try {
      const link = await api('/auth/v1/admin/generate_link', { service: true, body: { type: 'recovery', email: m.email, redirect_to: 'http://127.0.0.1:8901/mypage.html' } });
      const actionLink = link.action_link || (link.properties && link.properties.action_link);
      assert.ok(actionLink, 'リンクを作れない');
      const res = await fetch(actionLink, { redirect: 'manual' });
      const location = res.headers.get('location') || '';
      const hash = location.slice(location.indexOf('#'));
      assert.match(hash, /access_token=.*type=recovery/, 'Auth のリダイレクトの形が想定と違う');

      const page = openPage('index.html' + hash, { mode: 'live' });
      try {
        assert.equal(await page.ready(15000), true);
        const w = page.window, B = w.SkyRentBackend;
        deq(B.auth.urlEvent(), { type: 'recovery', error: null, message: null });
        const session = await B.auth.session();
        assert.ok(session && session.user, 'リンクのトークンでログインしていない');
        assert.equal(session.user.email, m.email);
        assert.ok(w.location.hash.indexOf('access_token') < 0, 'トークンが URL に残っている');
        assert.equal(B.member.current().email, m.email);
        await assert.rejects(B.auth.updatePassword('weakpassword'), e => e.code === 'WEAK_PASSWORD');
        assert.equal((await B.auth.updatePassword('New-Pass-2026b')).ok, true);
        const s = await api('/auth/v1/token?grant_type=password', { body: { email: m.email, password: 'New-Pass-2026b' } });
        assert.ok(s.access_token, '新しいパスワードでログインできない');
        deq(page.errors, []);
      } finally { page.close(); }

      // #lookup は supabase-js が消さない
      const page2 = openPage('index.html#lookup=R99999.not-a-token', { mode: 'live' });
      try {
        assert.equal(await page2.ready(15000), true);
        assert.equal(page2.window.location.hash, '#lookup=R99999.not-a-token');
        assert.equal(await page2.window.SkyRentBackend.auth.session(), null);
      } finally { page2.close(); }
    } finally {
      await deleteUser(m.userId);
    }
  });

  test('*.github.io では会員のログイン状態を sessionStorage に保存する (localStorage には書かない)', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const m = await createMember('Member-Pass-2026a');
    const page = openPage('index.html', {
      origin: 'https://skyrent-owner.github.io',
      configJs: 'Object.assign(window.SKY_RENT_CONFIG, ' + JSON.stringify(LIVE_CONFIG) + ');'
    });
    try {
      assert.equal(await page.ready(15000), true);
      const w = page.window, B = w.SkyRentBackend;
      assert.equal(B.live, true);
      const urls = [];
      const origFetch = w.fetch;
      w.fetch = (url, init) => { urls.push(String(url)); return origFetch(url, init); };
      const r = await B.auth.signIn(m.email, 'Member-Pass-2026a');
      assert.equal(r.member.email, m.email);
      deq(w.SkyRentStore.list('reservations').filter(x => !x._busy), []);
      assert.ok(w.sessionStorage.getItem('sb-127-auth-token'), 'sessionStorage に保存されていない');
      const lsKeys = [];
      for (let i = 0; i < w.localStorage.length; i++) lsKeys.push(w.localStorage.key(i));
      deq(lsKeys.filter(k => /^sb-/.test(k)), [], 'localStorage にログイン状態が書かれた');
      // 会員の予約は RPC で読む (予約表を直接読まない)
      assert.ok(urls.some(u => /\/rest\/v1\/rpc\/member_reservations/.test(u)), 'member_reservations を呼んでいない');
      assert.equal(urls.filter(u => /\/rest\/v1\/reservations/.test(u)).length, 0, '予約表を直接読んでいる');
      await B.auth.signOut();
      assert.equal(w.sessionStorage.getItem('sb-127-auth-token'), null);
      deq(page.errors, []);
    } finally {
      page.close();
      await deleteUser(m.userId);
    }
  });

  test('権限の無いスタッフ (viewer) の設定削除は RLS で 0 件 → FORBIDDEN のトーストを出し、行は残る', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const staff = await createStaffSession('viewer');
    const settingKey = 'frontend_core_c2_' + Date.now();
    await api('/rest/v1/app_settings', { service: true, body: { key: settingKey, value: { keep: true } }, headers: { Prefer: 'return=minimal' } });
    const page = openPage('manage/reservation-list.html', { mode: 'live', local: { 'sb-127-auth-token': JSON.stringify(staff.session) } });
    try {
      assert.equal(await page.ready(20000), true, 'skyrent:ready が発火しない (' + page.window.SkyRentBackend._lastRedirect + ')');
      const w = page.window, S = w.SkyRentStore, B = w.SkyRentBackend;
      assert.equal(B.admin.staff.role, 'viewer');
      deq(S.read('settings.' + settingKey, null), { keep: true });
      S.write('settings.' + settingKey, undefined);
      const toastEl = await waitFor(() => page.document.querySelector('.skyrent-toast--error'), 8000);
      assert.ok(toastEl, 'エラーのトーストが出ない (削除が成功扱いになっている)');
      assert.match(toastEl.textContent, /権限がありません/);
      const rows = await serviceSelect('app_settings', 'select=key,value&key=eq.' + settingKey);
      deq(rows, [{ key: settingKey, value: { keep: true } }], '行が消えた');
      await waitFor(() => S.read('settings.' + settingKey, null), 5000);
      deq(S.read('settings.' + settingKey, null), { keep: true }, '失敗後に取り直していない');
      deq(page.errors, []);
    } finally {
      page.close();
      await deleteUser(staff.userId);
      try { await api('/rest/v1/app_settings?key=eq.' + settingKey, { service: true, method: 'DELETE' }); } catch (e) { /* 無視 */ }
    }
  });
});

// =====================================================================
// F1: 画面側基盤の追加 — エラーの同梱項目・案内文・確認メールの再送・管理の追加関数・
//     担当者の予定の状態・無断キャンセルの表示・集計の日本時間
// =====================================================================
describe('画面側基盤の追加 (F1)', { skip: NO_JSDOM }, () => {
  // Edge Function の応答を差し替える (fetch)。routes: {'<パスの一部>': [status, body]}
  function stubFunctions(w, routes) {
    const calls = [];
    w.fetch = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, method: init && init.method, headers: init && init.headers, body: init && init.body ? JSON.parse(init.body) : undefined });
      const key = Object.keys(routes).find(k => u.indexOf(k) >= 0);
      const hit = key ? routes[key] : [404, { ok: false, code: 'NOT_FOUND', message: 'not found' }];
      return { ok: hit[0] >= 200 && hit[0] < 300, status: hit[0], json: async () => JSON.parse(JSON.stringify(hit[1])) };
    };
    return calls;
  }

  test('案内文: 電話・店舗への連絡を案内しない (NOT_CANCELLABLE / CALENDAR_UNAVAILABLE ほか)', async () => {
    const page = openPage('index.html');
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      assert.equal(B.errorMessage('NOT_CANCELLABLE'), 'このご予約はWebではキャンセルできません (貸出開始後・キャンセル済みなど)。お手数ですが公式LINEまたはお問い合わせフォームからご連絡ください。');
      assert.equal(B.errorMessage('CALENDAR_UNAVAILABLE'), '担当者の予定を確認できないため、ただいまWeb予約を受け付けられません。時間をおいてお試しいただくか、公式LINEまたはお問い合わせフォームからご相談ください。');
      ['VALIDATION', 'CONSENT_REQUIRED', 'UNAUTHENTICATED', 'FORBIDDEN', 'INVOICE_NOT_ALLOWED', 'NOT_FOUND', 'AVAILABILITY_CONFLICT',
       'STAFF_UNAVAILABLE', 'HANDOVER_CONFLICT', 'PRICE_CHANGED', 'CONFLICT', 'COUPON_INVALID', 'NOT_CANCELLABLE', 'IDEMPOTENCY_KEY_REUSED',
       'RATE_LIMITED', 'CALENDAR_UNAVAILABLE', 'INTERNAL', 'NETWORK', 'TIMEOUT', 'INVALID_PERIOD', 'START_IN_PAST', 'PERIOD_TOO_LONG',
       'START_TOO_FAR', 'ASSET_UNAVAILABLE', 'INVALID_ASSET', 'OPTION_INVALID', 'OPTION_CONFLICT', 'DISCOUNT_NOT_APPLICABLE', 'MEMBER_NOT_ACTIVE',
       'NOT_MEMBER', 'LINK_INVALID', 'EMAIL_NOT_CONFIRMED'].forEach(code => {
        assert.doesNotMatch(B.errorMessage(code), /電話|店舗まで|店頭まで/, code);
      });
      assert.match(B.errorMessage('PERIOD_TOO_LONG'), /公式LINEまたはお問い合わせフォーム/);
      assert.match(B.errorMessage('INVALID_ASSET'), /公式LINEまたはお問い合わせフォーム/);
      assertClean(page, 'messages');
    } finally { page.close(); }
  });

  test('デモ: resendSignup / admin.resetPassword は疑似成功・admin.sessionState・本番専用の管理関数は DEMO_MODE・担当者の状態は未確認', async () => {
    const page = openPage('manage/login.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend;
      await assert.rejects(B.auth.resendSignup('not-an-email'), e => e.code === 'VALIDATION' && !!e.fields.email);
      deq(await B.auth.resendSignup('someone@example.com'), { ok: true, demo: true });
      await assert.rejects(B.admin.resetPassword(''), e => e.code === 'VALIDATION' && !!e.fields.email);
      deq(await B.admin.resetPassword('staff@example.com'), { ok: true, demo: true });

      w.sessionStorage.removeItem('sky-rent.session');
      const st0 = await B.admin.sessionState();
      assert.equal(st0.userId, null);
      assert.equal(st0.staff, null);
      await B.admin.signIn('demo@example.com', 'x');
      const st1 = await B.admin.sessionState();
      assert.equal(st1.aal, 'aal2');
      deq(st1.staff, { name: 'デモ管理者', role: 'admin', locationIds: null, active: true });
      assert.equal(st1.hasTotp, false);

      for (const fn of [() => B.admin.auditLog({}), () => B.admin.resetStaffMfa('u1'), () => B.admin.processOutbox({ refIds: ['R0001'] })]) {
        await assert.rejects(fn(), e => e.code === 'DEMO_MODE');
      }
      deq(B.staffAvailabilityState(), { checked: false, error: null, unavailableLocations: [] });
      assertClean(page, 'demo-f1');
    } finally { page.close(); }
  });

  test('store: 無断キャンセル (no_show) の表示名と通知文', async () => {
    const page = openPage('index.html');
    try {
      assert.equal(await page.ready(8000), true);
      const S = page.window.SkyRentStore;
      assert.equal(S.STATUS_LABELS.no_show, '無断キャンセル');
      const r = S.list('reservations').find(x => x.status === 'confirmed');
      S.updateReservation(r.reservationId, { status: 'no_show' });
      assert.equal(S.notifications()[0].message, '予約 ' + r.reservationId + ' の状態を「無断キャンセル」に変更しました。通知メールを送信しました');
      assertClean(page, 'no-show-label');
    } finally { page.close(); }
  });

  test('call(): サーバーのエラーに同梱された項目 (documents・missing・cancellation・quote・fields) をそのまま載せる', async () => {
    const page = openPage('index.html', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend;
      const documents = [{ id: 'clause', version: '2026-08', title: '貸渡約款', url: 'clause.html' }, { id: 'cancel', version: '2026-08', title: 'キャンセル規定', url: 'clause.html#cancel' }];
      const quote = { ok: true, total: 18650, lines: [] };
      const cancellation = { cancellable: false, fee: 0, pct: 0, label: '' };
      const calls = stubFunctions(w, {
        '/api/reservations/cancel': [409, { ok: false, code: 'NOT_CANCELLABLE', message: 'キャンセルできません', requestId: 'req-2', cancellation: cancellation }],
        '/api/reservations/lookup': [400, { ok: false, code: 'VALIDATION', message: '入力内容に不備があります。', requestId: 'req-3', fields: { id: '予約番号を入力してください' } }],
        '/api/reservations': [400, { ok: false, code: 'CONSENT_REQUIRED', message: '同意が必要です', requestId: 'req-1', documents: documents, missing: ['cancel'] }],
        '/api/quote': [409, { ok: false, code: 'PRICE_CHANGED', message: '料金が変わりました', requestId: 'req-4', quote: quote }]
      });
      await assert.rejects(B.createReservation({ assetId: 'V003' }), e => {
        assert.equal(e.code, 'CONSENT_REQUIRED');
        assert.equal(e.message, '同意が必要です');
        deq(e.documents, documents);
        deq(e.missing, ['cancel']);
        assert.equal(e.requestId, 'req-1');
        assert.equal(e.status, 400);
        return true;
      });
      await assert.rejects(B.cancelReservation({ id: 'R00001', token: 't', expectedFee: 0 }), e => e.code === 'NOT_CANCELLABLE' && plain(e.cancellation).cancellable === false && e.status === 409);
      await assert.rejects(B.lookupReservation({ id: '' }), e => e.code === 'VALIDATION' && e.fields.id === '予約番号を入力してください');
      await assert.rejects(B.quote({ assetId: 'V003' }), e => e.code === 'PRICE_CHANGED' && e.quote.total === 18650);
      assert.equal(calls.length, 4);
      assertClean(page, 'call-extras');
    } finally { page.close(); }
  });

  test('auth.resendSignup (本番): supabase.auth.resend に type=signup と mypage.html への戻り先を渡す', async () => {
    const client = fakeClient(fakeDb(), []);
    const resends = [];
    client.auth.resend = async args => { resends.push(JSON.parse(JSON.stringify(args))); return resends.length > 1 ? { data: null, error: { code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' } } : { data: {}, error: null }; };
    const page = openPage('mypage.html', { mode: 'fake', fakeClient: client });
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      deq(await B.auth.resendSignup('member@example.com'), { ok: true });
      deq(resends[0], { type: 'signup', email: 'member@example.com', options: { emailRedirectTo: ORIGIN + '/mypage.html' } });
      await assert.rejects(B.auth.resendSignup('member@example.com'), e => e.code === 'RATE_LIMITED');
      await assert.rejects(B.auth.resendSignup('bad'), e => e.code === 'VALIDATION');
      assert.equal(resends.length, 2);
    } finally { page.close(); }
  });

  test('admin (本番・偽クライアント): processOutbox の引数 / resetStaffMfa / resetPassword / sessionState / mfa.enroll の発行者と登録名', async () => {
    const db = fakeDb();
    const log = [];
    const client = fakeClient(db, log);
    const mfaCalls = [];
    const resets = [];
    client.auth.resetPasswordForEmail = async (email, opts) => { resets.push({ email: email, opts: JSON.parse(JSON.stringify(opts)) }); return { data: {}, error: null }; };
    client.auth.mfa = {
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
      listFactors: async () => ({
        data: {
          totp: [{ id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: '私のスマホ' }],
          all: [{ id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: '私のスマホ' },
                { id: 'f2', factor_type: 'totp', status: 'unverified', friendly_name: 'やりかけ' }]
        }, error: null
      }),
      unenroll: async args => { mfaCalls.push({ unenroll: args.factorId }); return { data: {}, error: null }; },
      enroll: async args => { mfaCalls.push({ enroll: JSON.parse(JSON.stringify(args)) }); return { data: { id: 'f3', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'ABC', uri: 'otpauth://totp/x' } }, error: null }; }
    };
    const page = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: client });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend;
      const calls = stubFunctions(w, {
        '/admin/outbox/process': [200, { ok: true, processed: 1, results: [] }],
        '/admin/staff/reset-mfa': [200, { ok: true, removed: 1 }]
      });
      // メール送信の実行: 対象・件数を渡す (指定なしは空)
      await B.admin.processOutbox({ refIds: ['R00001'], limit: 5 });
      await B.admin.processOutbox();
      await B.admin.processOutbox({ refIds: 'R00002' });
      const outbox = calls.filter(c => /\/functions\/v1\/admin\/outbox\/process$/.test(c.url));
      deq(outbox.map(c => c.body), [{ refIds: ['R00001'], limit: 5 }, {}, { refIds: ['R00002'] }]);
      assert.equal(outbox[0].method, 'POST');
      // 二段階認証のリセット
      deq(await B.admin.resetStaffMfa('11111111-aaaa-bbbb-cccc-000000000001'), { ok: true, removed: 1 });
      const rm = calls.find(c => /\/functions\/v1\/admin\/staff\/reset-mfa$/.test(c.url));
      assert.equal(rm.method, 'POST');
      deq(rm.body, { userId: '11111111-aaaa-bbbb-cccc-000000000001' });
      assert.equal(rm.headers.Authorization, 'Bearer fake-token');
      await assert.rejects(B.admin.resetStaffMfa(''), e => e.code === 'VALIDATION');
      // パスワード再設定: 管理画面のログインへ戻る
      deq(await B.admin.resetPassword('admin@example.com'), { ok: true });
      deq(resets, [{ email: 'admin@example.com', opts: { redirectTo: ORIGIN + '/manage/login.html' } }]);
      // ログイン状態
      deq(await B.admin.sessionState(), {
        userId: db.staff[0].user_id, email: 'admin@example.com', aal: 'aal2', nextLevel: 'aal2',
        staff: { name: '管理 太郎', role: 'admin', locationIds: null, active: true }, hasTotp: true
      });
      // 認証アプリの登録: 未確認の登録を片付け、発行者と登録名を渡す (使用中の名前には (2))
      const en = await B.admin.mfa.enroll({ friendlyName: '私のスマホ' });
      deq({ factorId: en.factorId, secret: en.secret }, { factorId: 'f3', secret: 'ABC' });
      await B.admin.mfa.enroll();
      deq(mfaCalls, [
        { unenroll: 'f2' }, { enroll: { factorType: 'totp', issuer: 'グロースレンタカー', friendlyName: '私のスマホ (2)' } },
        { unenroll: 'f2' }, { enroll: { factorType: 'totp', issuer: 'グロースレンタカー', friendlyName: 'グロースレンタカー 管理画面' } }
      ]);
      // 未ログイン
      db.__session = null;
      deq(await B.admin.sessionState(), { userId: null, email: null, aal: null, nextLevel: null, staff: null, hasTotp: false });
      deq(page.errors, []);
      deq(page.consoleErrors, []);
    } finally { page.close(); }
  });

  test('admin.auditLog (偽クライアント): 絞り込み・日本時間の期間・新しい順・件数付き / 入力不備 / 権限なし', async () => {
    const db = fakeDb();
    const uid = db.staff[0].user_id;
    db.audit_log = [
      { id: 5, at: '2026-10-01T14:59:00.000Z', actor: uid, actor_role: 'admin', action: 'update', table_name: 'reservations', row_id: 'R00001', diff: { status: ['confirmed', 'in_use'] } },
      { id: 4, at: '2026-10-01T03:00:00.000Z', actor: null, actor_role: 'service_role', action: 'update', table_name: 'reservations', row_id: 'R00001', diff: {} },
      { id: 3, at: '2026-09-30T15:00:00.000Z', actor: uid, actor_role: 'admin', action: 'insert', table_name: 'reservations', row_id: 'R00002', diff: {} },
      { id: 2, at: '2026-09-30T14:59:59.000Z', actor: 'm-1', actor_role: 'authenticated', action: 'insert', table_name: 'reservations', row_id: 'R00001', diff: {} },
      { id: 1, at: '2026-09-30T01:00:00.000Z', actor: uid, actor_role: 'admin', action: 'update', table_name: 'app_settings', row_id: 'site', diff: {} }
    ];
    const log = [];
    const page = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const B = page.window.SkyRentBackend;
      log.length = 0;
      // 日本時間 10/1 の 1 日分 (9/30 15:00Z 〜 10/1 15:00Z)
      const r = await B.admin.auditLog({ table: 'reservations', from: '2026-10-01', to: '2026-10-01', limit: 2 });
      deq(r.rows.map(x => x.id), [5, 4]);
      assert.equal(r.total, 3);
      assert.equal(r.hasMore, true);
      assert.equal(r.offset, 0);
      assert.equal(r.limit, 2);
      const q = log.find(l => l.table === 'audit_log');
      assert.equal(q.count, 'exact');
      deq(q.range, [0, 1]);
      deq(q.orders, [['at', false], ['id', false]]);
      deq(q.filters, [['table_name', 'eq', 'reservations'], ['at', 'gte', '2026-09-30T15:00:00.000Z'], ['at', 'lt', '2026-10-01T15:00:00.000Z']]);
      assert.equal(q.cols, 'id,at,actor,actor_role,action,table_name,row_id,diff');
      // 次のページ
      const r2 = await B.admin.auditLog({ table: 'reservations', from: '2026-10-01', to: '2026-10-01', limit: 2, offset: 2 });
      deq([r2.rows.map(x => x.id), r2.total, r2.hasMore], [[3], 3, false]);
      // 行・操作・操作した人
      deq((await B.admin.auditLog({ table: 'reservations', rowId: 'R00001', action: 'update' })).rows.map(x => x.id), [5, 4]);
      deq((await B.admin.auditLog({ actor: '__system' })).rows.map(x => x.id), [4]);
      deq((await B.admin.auditLog({ actor: '__member' })).rows.map(x => x.id), [2]);
      deq((await B.admin.auditLog({ actor: uid })).rows.map(x => x.id), [5, 3, 1]);
      // ISO の日時はその時刻 (to は含まない)
      deq((await B.admin.auditLog({ from: '2026-09-30T14:59:59Z', to: '2026-10-01T03:00:00Z' })).rows.map(x => x.id), [3, 2]);
      // 件数の範囲 (既定 50・最大 200)
      log.length = 0;
      await B.admin.auditLog({ limit: 1000 });
      await B.admin.auditLog({});
      deq(log.filter(l => l.table === 'audit_log').map(l => l.range), [[0, 199], [0, 49]]);
      // 入力不備
      await assert.rejects(B.admin.auditLog({ from: '2026-02-30' }), e => e.code === 'VALIDATION' && !!e.fields.from);
      await assert.rejects(B.admin.auditLog({ from: '2026-10-02', to: '2026-10-01' }), e => e.code === 'VALIDATION' && /始まりと同じ日かそれより後/.test(e.fields.to));
      deq(page.errors, []);
    } finally { page.close(); }

    // 操作履歴を見る権限が無いスタッフ
    const db2 = fakeDb();
    db2.__role = 'viewer';
    db2.audit_log = [];
    const page2 = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db2, []) });
    try {
      assert.equal(await page2.ready(8000), true);
      await assert.rejects(page2.window.SkyRentBackend.admin.auditLog({}), e => e.code === 'FORBIDDEN');
    } finally { page2.close(); }
  });

  test('staffAvailabilityState: 空き状況の staff.error と拠点ごとの unavailable を公開する', async () => {
    const page = openPage('detail.html?id=V003', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []) });
    const w = page.window;
    const availability = {
      ok: true, busy: [], handovers: {},
      staff: {
        enabled: true, mode: 'handover', handoverMinutes: 30, oneHandoverAtATime: false,
        locations: {
          'loc-kitami': { configured: true, busy: [], calendars: [], unavailable: true },
          'loc-kushiro': { configured: true, busy: [], calendars: [{ busy: [] }] }
        }
      }
    };
    stubFunctions(w, { '/functions/v1/api/availability': [200, availability] });
    try {
      assert.equal(await page.ready(8000), true);
      const B = w.SkyRentBackend;
      deq(B.staffAvailabilityState(), { checked: true, error: null, unavailableLocations: ['loc-kitami'] });
      deq(B.staffAvailabilityState(), { checked: true, error: null, unavailableLocations: ['loc-kitami'] }, '呼ぶたびに同じ結果');
      assertClean(page, 'staff-state');
    } finally { page.close(); }

    // Google に接続できない (staff.error)
    const page2 = openPage('booking.html', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []) });
    stubFunctions(page2.window, {
      '/functions/v1/api/availability': [200, { ok: true, busy: [], handovers: {}, staff: { enabled: false, mode: 'handover', handoverMinutes: 0, oneHandoverAtATime: false, locations: {}, error: 'CALENDAR_UNAVAILABLE' } }]
    });
    try {
      assert.equal(await page2.ready(8000), true);
      deq(page2.window.SkyRentBackend.staffAvailabilityState(), { checked: true, error: 'CALENDAR_UNAVAILABLE', unavailableLocations: [] });
    } finally { page2.close(); }

    // 空き状況を読めなかった / 読まないページ
    const page3 = openPage('search.html', { mode: 'fake', fakeClient: fakeClient(fakeDb(), []) });
    stubFunctions(page3.window, { '/functions/v1/api/availability': [503, { ok: false, code: 'INTERNAL', message: 'x' }] });
    try {
      assert.equal(await page3.ready(8000), true);
      deq(page3.window.SkyRentBackend.staffAvailabilityState(), { checked: false, error: null, unavailableLocations: [] });
    } finally { page3.close(); }
  });

  test('SkyRentAPI の集計は日本時間 (今日・今月・週の日付・車検の残り日数・一覧の期間)', async () => {
    const page = openPage('index.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore, A = w.SkyRentAPI;
      // いま = 日本時間 2026-10-01 00:30 (ロサンゼルスでは 9/30 の朝・UTC でも 9/30)
      const NOW = Date.parse('2026-10-01T00:30:00+09:00');
      w.Date.now = () => NOW;
      const base = { locationId: 'loc-kitami', assetId: 'V001', assetName: '日産 ノート', customerName: 'テスト', kind: 'rental' };
      const R = (id, o) => Object.assign({ reservationId: id }, base, o);
      S._hydrate({
        reservations: [
          R('A', { status: 'returned', start: '2026-09-30T15:10:00.000Z', end: '2026-10-01T14:59:00.000Z', createdAt: '2026-09-30T15:05:00.000Z', price: { total: 10000 } }),
          R('B', { status: 'in_use', start: '2026-09-30T14:50:00.000Z', end: '2026-10-01T15:00:00.000Z', createdAt: '2026-09-24T15:00:00.000Z', price: { total: 20000 } }),
          R('C', { status: 'no_show', start: '2026-10-01T01:00:00.000Z', end: '2026-10-02T01:00:00.000Z', createdAt: '2026-09-29T00:00:00.000Z', price: { total: 0 } }),
          R('D', { status: 'confirmed', start: '2026-09-30T15:20:00.000Z', end: '2026-10-02T01:00:00.000Z', createdAt: '2026-09-30T15:15:00.000Z', price: { total: 3000 } }),
          R('E', { status: 'cancelled', start: '2026-10-01T03:00:00.000Z', end: '2026-10-02T03:00:00.000Z', createdAt: '2026-09-30T15:25:00.000Z', price: { total: 9000 } }),
          R('F', { status: 'confirmed', start: '2026-11-01T01:00:00.000Z', end: '2026-11-02T01:00:00.000Z', createdAt: '2026-09-24T14:59:00.000Z', price: { total: 7000 } })
        ],
        assets: S.assets().map(a => Object.assign({}, a, {
          shakenDate: { V001: '2026-10-31', V002: '2026-10-01T15:00:00.000Z', V003: '2026-09-30', V004: '2027-06-01' }[a.assetId] || null
        }))
      });
      const ids = list => plain(list).map(r => r.reservationId);
      const d = plain(await A.getDashboard());
      assert.equal(d.date, '2026-10-01');
      deq(ids(d.departures), ['A', 'D'], '本日出発');
      deq(ids(d.returns), ['A'], '本日帰着');
      deq(ids(d.bookings), ['A', 'D', 'E'], '本日の新規予約');
      deq(ids(d.unprocessed), ['D'], '未処理');
      assert.equal(d.salesMonth, 10000, '今月 (日本時間) の売上');
      deq(d.weekly, [
        { date: '9/25', count: 1 }, { date: '9/26', count: 0 }, { date: '9/27', count: 0 }, { date: '9/28', count: 0 },
        { date: '9/29', count: 1 }, { date: '9/30', count: 0 }, { date: '10/1', count: 3 }
      ]);
      deq(d.byLocation.find(b => b.locationId === 'loc-kitami'), { locationId: 'loc-kitami', name: '北見本店', departures: 2, returns: 1, inUse: 1 });
      deq(d.shaken.map(x => [x.vehicleName, x.expireDate, x.daysLeft]), [
        ['マツダ CX-5', '2026/09/30', -1], ['日産 ノート e-POWER', '2026/10/02', 1], ['日産 ノート', '2026/10/31', 30]
      ]);
      // 日付を指定 (日本時間の 9/30)
      const d2 = plain(await A.getDashboard('2026-09-30'));
      assert.equal(d2.date, '2026-09-30');
      deq(ids(d2.departures), ['B']);
      deq(ids(d2.returns), []);
      assert.equal(d2.salesMonth, 10000, '今月は日付の指定に関係なく今日基準');

      // 月別売上 (日本時間の月)
      const rev = plain(await A.getRevenue());
      assert.equal(rev.length, 12);
      deq(rev[11], { year: 2026, month: 10, label: '2026/10', count: 3, total: 13000 });
      deq(rev[10], { year: 2026, month: 9, label: '2026/09', count: 1, total: 20000 });
      assert.equal(rev[0].label, '2025/11');

      // 一覧の期間 (タイムゾーン表記なし = 日本時間)・開始の新しい順
      deq(ids(await A.listReservations('2026-10-01T00:00', '2026-10-01T23:59')), ['E', 'C', 'D', 'A', 'B']);
      deq(ids(await A.listReservations('2026-10-01T00:15')), ['F', 'E', 'C', 'D', 'A', 'B']);
      deq(ids(await A.listReservations(null, '2026-10-01T00:15')), ['A', 'B']);
      assertClean(page, 'api-jst');
    } finally { page.close(); }
  });
});
