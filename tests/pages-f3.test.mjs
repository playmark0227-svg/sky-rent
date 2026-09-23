/**
 * 担当F3: 画面の仕上げ
 *   booking.html     … キャンセルの連絡先 (公式LINE / お問い合わせフォーム・当社が受け付けた日) /
 *                      確定時の CONSENT_REQUIRED は、エラーの documents / missing で同意欄を出し直す (再読み込みしない)
 *   mypage.html      … 確認メールを送った画面・期限切れリンクの画面に「確認メールを再送」(連打防止)
 *   manage/partials.js / employees.html … 本番は「従業員管理」を出さず「スタッフ・権限」へ一本化、お問合せ・手順書は「システム」
 *   manage/profile.html … 本番はログイン中のスタッフの情報・パスワード変更・二段階認証の案内 (デモは従来どおり)
 *   manage/staff.html   … 各スタッフの「二段階認証をリセット」(自分以外・確認ダイアログ)
 *   manage/mail-log.html … 再送すると試行回数を 0 に戻して最初から送り直す案内
 *
 * 実行: node --test tests/pages-f3.test.mjs
 *
 *   - デモモード / 偽クライアント (本番モード・サーバーなし) で画面の動きを確かめる。
 *   - ローカル Supabase (http://127.0.0.1:54321 + 起動中の Edge Functions) でも確かめる。起動していなければ skip。
 *     テスト用のスタッフは毎回作って最後に消す。Auth のメール送信 (送信数の上限を他のテストと共有) は実際には送らず、
 *     呼び出し内容だけ確かめる。予約は「今日から150〜390日後のランダムな日時」に作り、最後に照会URLでキャンセルする。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

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
const SUPABASE_UMD = BASES.map(b => join(b, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')).find(p => existsSync(p)) || null;

const ORIGIN = 'http://localhost:8765';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
const LOCAL_API = 'http://127.0.0.1:54321';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const LIVE_CONFIG = { SUPABASE_URL: LOCAL_API, SUPABASE_ANON_KEY: ANON_KEY };
const FAKE_URL = 'http://fake-supabase.invalid';
const FAKE_CONFIG = { SUPABASE_URL: FAKE_URL, SUPABASE_ANON_KEY: 'fake-anon-key' };
const FAKE_FN = FAKE_URL + '/functions/v1';
const AUTH_KEY = 'sb-127-auth-token';   // supabase-js の保存キー (URL のホスト 127.0.0.1 → '127')
const LINE_URL = 'https://lin.ee/PuLt0Ig';
const PENDING = 'sky-rent.pendingBooking';
const HOUR = 3600000, DAY = 86400000, JST = 9 * HOUR;
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function intercept(request) {
  const url = new URL(request.url);
  if (url.origin === ORIGIN) {
    const file = resolve(ROOT, '.' + decodeURIComponent(url.pathname));
    if (!(file === ROOT || file.startsWith(ROOT + sep)) || !existsSync(file)) return new Response('not found', { status: 404 });
    const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    return new Response(readFileSync(file), { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
  }
  if (request.url === SUPABASE_CDN && SUPABASE_UMD) {
    return new Response(readFileSync(SUPABASE_UMD), { headers: { 'Content-Type': 'application/javascript' } });
  }
  const css = /\.css(\?|$)|fonts\.googleapis/.test(request.url);
  return new Response('', { headers: { 'Content-Type': css ? 'text/css' : 'application/javascript' } });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const plain = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const deq = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);
async function waitFor(fn, ms, step) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step || 25);
  }
}
const jsonRes = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

/**
 * ページを jsdom で開く
 *   opts.mode: 'demo' (既定) | 'live' (ローカル Supabase) | 'fake' (偽の supabase クライアント)
 *   opts.fakeClient: 偽の supabase クライアント (mode = 'fake')
 *   opts.fetch(url, init, next) → Response|null: window.fetch の差し替え (null なら本物)
 *   opts.local / opts.session: 事前に入れる storage / opts.confirm: window.confirm の戻り値 (既定 true)
 */
function openPage(path, opts) {
  opts = opts || {};
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
  const html = readFileSync(join(ROOT, path.split(/[?#]/)[0]), 'utf8');
  const out = { errors: [], consoleErrors: [], resourceErrors: [], notImplemented: [], fetches: [], confirms: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => out.consoleErrors.push(a.map(x => (x && x.stack) || String(x)).join(' ')));
  vc.on('jsdomError', e => {
    if (e.type === 'unhandled-exception') out.errors.push((e.cause && e.cause.stack) || e.message);
    else if (e.type === 'resource-loading') out.resourceErrors.push((e.url || '') + ' ' + e.message);
    else if (e.type === 'not-implemented') out.notImplemented.push(e.message);
  });
  out.confirmAnswer = opts.confirm === undefined ? true : opts.confirm;
  const dom = new JSDOM(html, {
    url: ORIGIN + '/' + path,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: { interceptors: [requestInterceptor(req => intercept(req))] },
    beforeParse(window) {
      window.fetch = async (input, init) => {
        const url = String((input && input.url) || input);
        let body = null;
        try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (e) { body = init.body; }
        out.fetches.push({ url: url, method: (init && init.method) || 'GET', body: body });
        const next = () => globalThis.fetch(input, init);
        if (opts.fetch) {
          const r = await opts.fetch(url, init || {}, next);
          if (r) return r;
        }
        return next();
      };
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.scrollTo = () => {};
      window.confirm = msg => { out.confirms.push(String(msg)); return out.confirmAnswer; };
      window.alert = msg => { out.alerts = (out.alerts || []).concat([String(msg)]); };
      window.matchMedia = q => ({ matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
      window.HTMLElement.prototype.scrollIntoView = function () {};
      if (opts.mode === 'live') window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(LIVE_CONFIG));
      if (opts.mode === 'fake') {
        window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(FAKE_CONFIG));
        window.supabase = { createClient: () => opts.fakeClient };
      }
      Object.entries(opts.local || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
      Object.entries(opts.session || {}).forEach(([k, v]) => window.sessionStorage.setItem(k, v));
      window.__ready = new Promise(res => window.addEventListener('skyrent:ready', () => res(true)));
    }
  });
  out.window = dom.window;
  out.document = dom.window.document;
  out.$ = s => dom.window.document.querySelector(s);
  out.$$ = s => Array.from(dom.window.document.querySelectorAll(s));
  out.text = s => { const el = dom.window.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };
  // skyrent:ready の後、遅延スクリプトが登録した DOMContentLoaded (非同期で呼ばれる) の実行を待つ
  out.ready = async ms => {
    const r = await Promise.race([dom.window.__ready, new Promise(res => setTimeout(() => res(false), ms || 8000).unref())]);
    await sleep(40);
    return r;
  };
  out.close = () => { try { dom.window.close(); } catch (e) { /* 無視 */ } };
  out.set = (s, v) => {
    const el = typeof s === 'string' ? dom.window.document.querySelector(s) : s;
    assert.ok(el, '入力する要素が無い: ' + s);
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v; else el.value = v;
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  out.submit = s => {
    const f = dom.window.document.querySelector(s);
    assert.ok(f, 'フォームが無い: ' + s);
    f.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  };
  out.toasts = kind => Array.from(dom.window.document.querySelectorAll('.skyrent-toast' + (kind ? '--' + kind : ''))).map(t => t.textContent);
  return out;
}

// JS エラー・読み込み失敗・console.error・想定外の画面遷移が無いこと
function assertClean(page, label) {
  deq(page.errors, [], label + ': JS エラー');
  deq(page.resourceErrors, [], label + ': 読み込めなかったファイル');
  deq(page.consoleErrors, [], label + ': console.error');
  deq(page.notImplemented.filter(m => /navigation/i.test(m)), [], label + ': 想定外の画面遷移');
}
function visible(el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden || (e.style && e.style.display === 'none')) return false;
  }
  return !!el;
}
function businessKeys(storage) {
  const ok = ['sky-rent.configOverride', 'sky-rent.lang', 'sky-rent.introSeen'];
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.indexOf('sky-rent.') === 0 && ok.indexOf(k) < 0) out.push(k);
  }
  return out;
}
const currentView = page => ['auth', 'sent', 'reset', 'newpass', 'link', 'member', 'lookup'].filter(v => !page.$('#view-' + v).hidden);
const navHrefs = page => page.$$('.topnav-menu a[data-perm]').filter(visible).map(a => a.getAttribute('href'));

const NO_JSDOM = jsdom ? false : 'jsdom が見つかりません (npm install を実行してください)';

// 日本時間の n 日後の h 時
const jstToday0 = () => Math.floor((Date.now() + JST) / DAY) * DAY - JST;
const jstAt = (days, h, m) => jstToday0() + days * DAY + h * HOUR + (m || 0) * 60000;

// =====================================================================
// 偽の supabase クライアント (本番モードの画面ロジック用)
// =====================================================================
const ADMIN_UID = '11111111-2222-3333-4444-555555555555';
const OTHER_UID = '22222222-3333-4444-5555-666666666666';
const THIRD_UID = '33333333-4444-5555-6666-777777777777';
function fakeDb(role) {
  return {
    __session: { access_token: 'fake-token', user: { id: ADMIN_UID, email: 'admin@example.com' } },
    __role: role || 'admin',
    __failRpc: {},
    __factors: [{ id: 'f-1', factor_type: 'totp', status: 'verified', friendly_name: 'phone' }],
    __aal: 'aal2',
    __updateUserError: null,
    categories: [{ id: 'cat-rental', name: '一般レンタカー', name_en: '', type: 'vehicle', icon: '🚗', description: '', sort: 1, active: true, custom_field_defs: [], extra: {} }],
    locations: [{ id: 'loc-kitami', name: '北見本店', name_en: '', tel: '', address: '北海道北見市', hours: '', holiday: '', sort: 1, active: true, extra: {} },
                { id: 'loc-kushiro', name: '釧路店', name_en: '', tel: '', address: '北海道釧路市', hours: '', holiday: '', sort: 2, active: true, extra: {} }],
    assets: [], options: [], app_settings: [], app_collections: [], legal_documents: [],
    members: [], member_points: [], coupons: [], point_ledger: [], reservations: [], invoices: [], inquiries: [],
    staff: [{ user_id: ADMIN_UID, name: '管理 太郎', email: 'admin@example.com', role: role || 'admin', active: true, location_ids: role === 'store_staff' ? ['loc-kushiro'] : null },
            { user_id: OTHER_UID, name: '店舗 花子', email: 'hanako@example.com', role: 'store_staff', active: true, location_ids: ['loc-kitami'] },
            { user_id: THIRD_UID, name: '整備 三郎', email: 'saburo@example.com', role: 'maintenance', active: true, location_ids: null }],
    // 二段階認証の登録状況 (偽の Edge Function の staff/list が返す)
    __mfa: { [ADMIN_UID]: true, [OTHER_UID]: true, [THIRD_UID]: false },
    outbox: []
  };
}
function fakeClient(db, log) {
  const clone = v => JSON.parse(JSON.stringify(v));
  const match = (r, f) => {
    const v = r[f[0]];
    switch (f[1]) {
      case 'eq': return v === f[2];
      case 'neq': return v !== f[2];
      case 'in': return f[2].indexOf(v) >= 0;
      case 'ilike': return new RegExp('^' + String(f[2]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i').test(String(v == null ? '' : v));
      default: return true;
    }
  };
  function exec(st) {
    log.push({ kind: 'from', table: st.table, op: st.op, filters: st.filters });
    if (st.op !== 'select') return { data: null, error: null };
    let rows = (db[st.table] || []).filter(r => st.filters.every(f => match(r, f)));
    if (st.order) rows = rows.slice().sort((a, b) => (a[st.order[0]] < b[st.order[0]] ? -1 : a[st.order[0]] > b[st.order[0]] ? 1 : 0) * (st.order[1] ? 1 : -1));
    const count = rows.length;
    if (st.single) return { data: rows[0] ? clone(rows[0]) : null, error: null };
    if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
    if (st.opts && st.opts.head) return { data: null, count: count, error: null };
    return { data: clone(rows), count: st.opts && st.opts.count ? count : null, error: null };
  }
  function builder(table) {
    const st = { table: table, op: 'select', filters: [], range: null, single: false, opts: null, order: null };
    const b = {
      select(cols, o) { if (st.op === 'select') st.opts = o || null; return b; },
      order(col, o) { if (!st.order) st.order = [col, !o || o.ascending !== false]; return b; },
      range(x, y) { st.range = [x, y]; return b; },
      limit(n) { st.range = [0, n - 1]; return b; },
      eq(col, v) { st.filters.push([col, 'eq', v]); return b; },
      neq(col, v) { st.filters.push([col, 'neq', v]); return b; },
      in(col, vs) { st.filters.push([col, 'in', vs]); return b; },
      ilike(col, v) { st.filters.push([col, 'ilike', v]); return b; },
      is(col, v) { return b; },
      gte() { return b; }, lt() { return b; }, lte() { return b; }, gt() { return b; },
      maybeSingle() { st.single = true; return b; },
      upsert() { st.op = 'upsert'; return b; },
      insert() { st.op = 'insert'; return b; },
      update() { st.op = 'update'; return b; },
      delete() { st.op = 'delete'; return b; },
      then(ok, ng) { return Promise.resolve(exec(st)).then(ok, ng); }
    };
    return b;
  }
  const rpcs = {
    public_catalog: () => ({ categories: db.categories, locations: db.locations, assets: db.assets, options: db.options, settings: {}, collections: {}, legal: [] }),
    staff_role: () => db.__role,
    admin_recent_activity: () => [],
    admin_retry_outbox: a => {
      const o = db.outbox.find(x => x.id === a.p_id);
      if (o && (o.status === 'failed' || o.status === 'skipped')) { o.status = 'pending'; o.attempts = 0; o.last_error = null; }
      return null;
    }
  };
  return {
    auth: {
      getSession: async () => ({ data: { session: db.__session || null }, error: null }),
      signOut: async () => { log.push({ kind: 'signOut' }); return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      updateUser: async attrs => {
        log.push({ kind: 'updateUser', attrs: clone(attrs) });
        if (db.__updateUserError) return { data: null, error: db.__updateUserError };
        return { data: { user: db.__session.user }, error: null };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: db.__aal, nextLevel: 'aal2' }, error: null }),
        listFactors: async () => ({ data: { totp: db.__factors.slice(), all: db.__factors.slice() }, error: null })
      }
    },
    rpc: async (name, args) => {
      log.push({ kind: 'rpc', name: name, args: clone(args || {}) });
      if (db.__failRpc[name]) return { data: null, error: { message: db.__failRpc[name], code: 'P0001' } };
      const h = rpcs[name];
      if (!h) return { data: null, error: { message: 'NOT_FOUND', code: 'P0001' } };
      try { return { data: h(args || {}), error: null }; } catch (e) { return { data: null, error: { message: e.message, code: 'P0001' } }; }
    },
    from: builder
  };
}
// 偽の Edge Function (admin)
function fakeFunctions(db, log) {
  return async (url, init) => {
    if (url.indexOf(FAKE_FN + '/') !== 0) return null;
    const path = url.slice(FAKE_FN.length).split('?')[0];
    const body = init && init.body ? JSON.parse(init.body) : null;
    log.push({ kind: 'fn', path: path, body: body });
    if (path === '/admin/staff/list') {
      return jsonRes({ ok: true, staff: db.staff.map(s => ({ userId: s.user_id, name: s.name, email: s.email, role: s.role, locationIds: s.location_ids, active: s.active, lastSignInAt: '2026-09-22T01:30:00Z', emailConfirmed: true, mfaEnabled: !!db.__mfa[s.user_id] })) });
    }
    if (path === '/admin/staff/reset-mfa') {
      if (db.__resetError) return jsonRes(Object.assign({ ok: false, requestId: 'req-1' }, db.__resetError.body), db.__resetError.status);
      const had = db.__mfa[body.userId] ? 1 : 0;
      db.__mfa[body.userId] = false;
      return jsonRes({ ok: true, removed: had });
    }
    if (path === '/admin/outbox/process') {
      const results = db.outbox.filter(o => o.status === 'pending' && o.attempts < 8 && (!body.refIds || body.refIds.indexOf(o.ref_id) >= 0))
        .map(o => { o.status = 'failed'; o.attempts += 1; o.last_error = '一時的なエラー (500)'; return { id: o.id, template: o.template, status: 'failed' }; });
      return jsonRes({ ok: true, processed: results.length, results: results });
    }
    return jsonRes({ ok: false, code: 'NOT_FOUND', message: '見つかりません' }, 404);
  };
}

// =====================================================================
// ローカル Supabase の小物
// =====================================================================
async function supabaseUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(LOCAL_API + '/functions/v1/api/', { signal: ctrl.signal, headers: { apikey: ANON_KEY } });
    clearTimeout(t);
    const j = await res.json().catch(() => null);
    return res.ok && j && j.ok === true;
  } catch (e) { return false; }
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
  if (!res.ok && !opts.allowError) throw new Error(path + ': HTTP ' + res.status + ' ' + text.slice(0, 200));
  return opts.allowError ? { status: res.status, json: json } : json;
}
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
async function freshTotp(secret) {
  const left = 30000 - (Date.now() % 30000);
  if (left < 3000) await sleep(left + 200);
  return totp(secret);
}
const uniq = p => 'f3-' + p + '-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
const PASSWORD = () => 'F3-pass-' + randomBytes(4).toString('hex') + 'Aa1';

const createdUsers = [];
// スタッフを作る (opts.factor = true なら認証アプリも登録して AAL2 のセッションを返す)
async function createStaff(opts) {
  opts = opts || {};
  const email = uniq(opts.prefix || 'staff');
  const password = PASSWORD();
  const user = await api('/auth/v1/admin/users', { service: true, body: { email: email, password: password, email_confirm: true } });
  const userId = user.id || (user.user && user.user.id);
  createdUsers.push(userId);
  await api('/rest/v1/staff', { service: true, body: { user_id: userId, name: opts.name || 'F3 テスト', email: email, role: opts.role || 'store_staff', active: true, location_ids: opts.locationIds || null }, headers: { Prefer: 'return=minimal' } });
  const out = { userId: userId, email: email, password: password };
  if (opts.factor) {
    const s1 = await api('/auth/v1/token?grant_type=password', { body: { email: email, password: password } });
    const factor = await api('/auth/v1/factors', { token: s1.access_token, body: { factor_type: 'totp', friendly_name: 'f3-test' } });
    const ch = await api('/auth/v1/factors/' + factor.id + '/challenge', { token: s1.access_token, body: {} });
    const s2 = await api('/auth/v1/factors/' + factor.id + '/verify', { token: s1.access_token, body: { challenge_id: ch.id, code: await freshTotp(factor.totp.secret) } });
    out.secret = factor.totp.secret;
    out.factorId = factor.id;
    out.session = Object.assign({}, s2, { expires_at: s2.expires_at || Math.floor(Date.now() / 1000) + (s2.expires_in || 3600) });
  }
  return out;
}
async function deleteUser(userId) {
  try { await api('/auth/v1/admin/users/' + userId, { service: true, method: 'DELETE' }); } catch (e) { /* 後片付けの失敗は無視 */ }
}
async function verifiedFactors(userId) {
  const u = await api('/auth/v1/admin/users/' + userId, { service: true });
  return ((u && u.factors) || []).filter(f => f.status === 'verified');
}
async function apiCall(path, body) {
  const res = await fetch(LOCAL_API + '/functions/v1/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// =====================================================================
// デモモード
// =====================================================================
describe('F3 デモモード', { skip: NO_JSDOM }, () => {
  function pendingFor(assetId, startMs, hours) {
    return JSON.stringify({ assetId: assetId, start: new Date(startMs).toISOString(), end: new Date(startMs + hours * HOUR).toISOString(), quantity: 1, optionIds: [] });
  }
  async function toConfirm(page) {
    await waitFor(() => page.$('#f-licconf') && page.$$('#consent-box input[data-doc]').length === 3, 3000);
    page.set('#f-name', 'テスト 花子');
    page.set('#f-email', 'hanako@example.com');
    page.set('#f-phone', '090-1234-5678');
    page.set('#f-licconf', true);
    page.submit('#cust-form');
    await waitFor(() => !page.$('#pane-confirm').hidden, 3000);
    assert.equal(page.$('#pane-confirm').hidden, false, '確認画面に進まない: ' + page.text('#input-error'));
  }
  const consents = page => page.$$('#consent-box input[data-doc]').map(c => c.dataset.doc + '@' + c.dataset.ver + (c.checked ? ':on' : ''));

  test('booking.html: 取り消しの連絡先は公式LINE / お問い合わせフォーム (当社が受け付けた日を基準)。電話・店舗への連絡は案内しない', async () => {
    const page = openPage('booking.html', { session: { [PENDING]: pendingFor('V001', jstAt(30, 10), 26) } });
    try {
      assert.equal(await page.ready(8000), true);
      await toConfirm(page);
      const body = page.text('#confirm-body');
      assert.match(body, /Webでお手続きできない場合は、公式LINEまたはお問い合わせフォームからご連絡ください。キャンセル料は、当社がご連絡を受け付けた日を基準にします。/);
      ['店舗までご連絡', 'ご連絡をいただいた日', 'お電話', '電話で'].forEach(s => assert.equal(body.indexOf(s), -1, '確認画面に「' + s + '」が残っている'));
      const line = page.$('#confirm-body a[href="' + LINE_URL + '"]');
      const form = page.$('#confirm-body a[href="contact.html"]');
      assert.ok(line && form, '公式LINE / お問い合わせフォームへのリンクが無い');
      // 予約手続きの途中の画面を閉じないよう、別のタブで開く
      assert.equal(line.getAttribute('target'), '_blank');
      assert.equal(form.getAttribute('target'), '_blank');
      assert.equal(line.getAttribute('rel'), 'noopener');
      // law.html#cancel と同じ連絡先・基準日
      const law = readFileSync(join(ROOT, 'law.html'), 'utf8');
      assert.ok(law.indexOf(LINE_URL) >= 0 && /当社がご連絡を受け付けた日/.test(law), 'law.html の記述と食い違う');
      assertClean(page, 'booking-contact');
    } finally { page.close(); }
  });

  test('booking.html: CONSENT_REQUIRED に最新の版 (documents / missing) があれば、再読み込みせずに同意欄を出し直す', async () => {
    const page = openPage('booking.html', { session: { [PENDING]: pendingFor('V001', jstAt(31, 10), 26) } });
    try {
      assert.equal(await page.ready(8000), true);
      await toConfirm(page);
      const w = page.window, B = w.SkyRentBackend;
      deq(consents(page), ['clause@2026-08', 'cancel@2026-08', 'privacy@2026-08']);
      const href = () => w.location.href;
      const urlBefore = href();
      // 確定の応答を差し替える: 1回目 = キャンセル規定が 2026-10 版に更新 / 2回目 = documents 無しの CONSENT_REQUIRED / 3回目 = 本物
      const calls = [];
      const real = B.createReservation;
      B.createReservation = async p => {
        calls.push(JSON.parse(JSON.stringify(p)));
        if (calls.length === 1) {
          const e = new Error('規約などへの同意が必要です。最新の内容をご確認のうえ、同意の欄にチェックしてください。');
          e.code = 'CONSENT_REQUIRED';
          e.documents = [
            { id: 'cancel', version: '2026-10', title: 'キャンセル規定 (2026年10月改定)', url: 'law.html#cancel' },
            { id: 'clause', version: '2026-08', title: '貸渡約款', url: 'clause.html' },
            { id: 'privacy', version: '2026-08', title: 'プライバシーポリシー', url: 'javascript:alert(1)' }
          ];
          e.missing = ['cancel'];
          throw e;
        }
        if (calls.length === 2) {
          const e = new Error('規約などへの同意が必要です。最新の内容をご確認のうえ、同意の欄にチェックしてください。');
          e.code = 'CONSENT_REQUIRED';
          throw e;
        }
        return real(p);
      };
      page.$$('#consent-box input[data-doc]').forEach(c => { c.checked = true; });
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#confirm-error').hidden, 3000);
      assert.equal(calls.length, 1);
      deq(calls[0].consent.documents, [{ id: 'clause', version: '2026-08' }, { id: 'cancel', version: '2026-08' }, { id: 'privacy', version: '2026-08' }]);
      // 画面はそのまま (再読み込み・画面遷移なし)。同意欄は最新の版で、更新された文書だけチェックし直し
      assert.equal(href(), urlBefore);
      assert.equal(page.$('#pane-confirm').hidden, false);
      assert.match(page.text('#confirm-error'), /「キャンセル規定 \(2026年10月改定\)」の内容が更新されました。最新の版をご確認のうえ、あらためて同意の欄にチェックを入れてから、もう一度「上記の内容で予約を確定する」を押してください。/);
      assert.doesNotMatch(page.text('#confirm-error'), /再読み込み/);
      deq(consents(page), ['clause@2026-08:on', 'cancel@2026-10', 'privacy@2026-08:on']);
      const cancelBox = page.$('#consent-box input[data-doc="cancel"]');
      assert.equal(w.document.activeElement, cancelBox, '更新された文書のチェック欄にフォーカスが移らない');
      const cancelLabel = cancelBox.closest('label');
      assert.match(cancelLabel.textContent, /2026-10版/);
      assert.ok(cancelLabel.querySelector('[data-updated]'), '更新の印が無い');
      assert.equal(page.$$('#consent-box [data-updated]').length, 1);
      assert.equal(cancelLabel.querySelector('a').getAttribute('href'), 'law.html#cancel');
      // サイト外・スクリプトの URL はリンクにしない
      assert.equal(page.$('#consent-box input[data-doc="privacy"]').closest('label').querySelector('a').getAttribute('href'), '#');

      // チェックし直さないまま押す → 送らずに案内
      page.$('#btn-submit').click();
      await waitFor(() => /同意が必要です。内容をご確認のうえ/.test(page.text('#confirm-error')), 2000);
      assert.match(page.text('#confirm-error'), /「キャンセル規定 \(2026年10月改定\)」への同意が必要です/);
      assert.equal(calls.length, 1, '同意が足りないのに送信した');

      // チェック → 新しい版で送る (2回目は documents 無し → 再読み込みの案内)
      cancelBox.checked = true;
      page.$('#btn-submit').click();
      await waitFor(() => calls.length === 2 && /再読み込み/.test(page.text('#confirm-error')), 3000);
      deq(calls[1].consent.documents, [{ id: 'clause', version: '2026-08' }, { id: 'cancel', version: '2026-10' }, { id: 'privacy', version: '2026-08' }]);
      assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey, '冪等キーが変わった');
      assert.match(page.text('#confirm-error'), /規約が更新された場合は、画面を再読み込みすると最新の版が表示されます/);
      deq(consents(page), ['clause@2026-08:on', 'cancel@2026-10:on', 'privacy@2026-08:on'], 'documents が無いときは同意欄を変えない');

      // 3回目は確定
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#pane-done').hidden, 3000);
      assert.equal(page.$('#pane-done').hidden, false, '完了画面にならない: ' + page.text('#confirm-error'));
      assert.equal(calls.length, 3);
      assertClean(page, 'booking-consent');
    } finally { page.close(); }
  });

  test('mypage.html: 期限切れリンクの画面から「確認メールを再送」(入力チェック・デモの案内・連打防止)', async () => {
    const page = openPage('mypage.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    try {
      assert.equal(await page.ready(8000), true);
      deq(currentView(page), ['link']);
      const w = page.window;
      const calls = [];
      const real = w.SkyRentBackend.auth.resendSignup;
      w.SkyRentBackend.auth.resendSignup = async email => { calls.push(email); return real(email); };
      assert.ok(visible(page.$('#link-resend-form')), '再送の欄が無い');
      assert.match(page.text('#view-link'), /下の「確認メールを再送」から、確認メールをお送りし直します/);
      assert.equal(page.text('#lr-btn'), '確認メールを再送');
      // 入力チェック
      page.set('#lr-email', 'not-an-email');
      page.submit('#link-resend-form');
      await waitFor(() => !page.$('#lr-msg').hidden, 2000);
      assert.match(page.text('#lr-msg'), /メールアドレスを正しく入力してください/);
      assert.equal(calls.length, 0);
      // 送る → デモの案内 → 60 秒は押せない
      page.set('#lr-email', 'someone@example.com');
      page.submit('#link-resend-form');
      await waitFor(() => /デモ環境/.test(page.text('#lr-msg')), 2000);
      deq(calls, ['someone@example.com']);
      assert.match(page.text('#lr-msg'), /デモ環境のため、メールは送信されません/);
      assert.equal(page.$('#lr-btn').disabled, true, '送ったあとも押せる');
      assert.match(page.text('#lr-btn'), /確認メールを再送 \(あと(60|59)秒\)/);
      page.submit('#link-resend-form');
      page.$('#lr-btn').click();
      await sleep(50);
      deq(calls, ['someone@example.com'], '待ち時間中に再送した');
      // 1 秒ごとに残りの秒数が減る
      const first = Number(/あと(\d+)秒/.exec(page.text('#lr-btn'))[1]);
      await waitFor(() => Number((/あと(\d+)秒/.exec(page.text('#lr-btn')) || [0, 99])[1]) < first, 2500, 100);
      assert.ok(Number(/あと(\d+)秒/.exec(page.text('#lr-btn'))[1]) < first, '残りの秒数が減らない');
      // ほかの手続きへ
      page.$('#view-link [data-go="reset"]').click();
      deq(currentView(page), ['reset']);
      assertClean(page, 'mypage-resend-demo');
    } finally { page.close(); }
  });

  test('manage: デモは従来どおり (従業員管理の一覧・編集 / プロフィールの保存・バックアップ)', async () => {
    const emp = openPage('manage/employees.html');
    try {
      assert.equal(await emp.ready(8000), true);
      assert.equal(emp.$('#emp-live-notice').hidden, true, 'デモで本番の案内が出ている');
      assert.ok(visible(emp.$('#btn-add')));
      await waitFor(() => emp.$$('#tbl tr[data-idx]').length === 4, 2000);
      assert.equal(emp.$$('#tbl .crud-edit').length, 4);
      assert.match(emp.text('#tbl'), /山田 太郎/);
      assert.ok(navHrefs(emp).indexOf('employees.html') >= 0, 'デモのメニューに従業員管理が無い');
      assertClean(emp, 'demo-employees');
    } finally { emp.close(); }

    const pf = openPage('manage/profile.html', { local: { 'sky-rent.settings.profile': JSON.stringify({ name: 'デモ 花子' }) } });
    try {
      assert.equal(await pf.ready(8000), true);
      assert.equal(pf.$('#pf-live').hidden, true, 'デモで本番の画面が出ている');
      assert.ok(visible(pf.$('#pf-demo')));
      assert.equal(pf.$('[data-setting="name"]').value, 'デモ 花子');
      ['#btn-export', '#btn-import-trigger', '#btn-reset', '#btn-logout', '#cur-pw'].forEach(s => assert.ok(pf.$(s), s + ' が無い'));
      assert.equal(pf.text('#pf-title'), 'プロフィール');
      // 保存 (端末内の settings.profile)
      pf.set('[data-setting="name"]', 'デモ 次郎');
      pf.$('[data-save]').click();
      assert.equal(JSON.parse(pf.window.localStorage.getItem('sky-rent.settings.profile')).name, 'デモ 次郎');
      assert.match(pf.text('a[href="profile.html"]'), /プロフィール編集/);
      assertClean(pf, 'demo-profile');
    } finally { pf.close(); }
  });
});

// =====================================================================
// 本番モード (偽クライアント)
// =====================================================================
describe('F3 本番モード (偽クライアント)', { skip: NO_JSDOM }, () => {
  test('employees.html: 「スタッフ・権限で管理します」と案内し、一覧の編集は出さない (管理者はリンク / それ以外は依頼の案内)', async () => {
    for (const role of ['admin', 'store_staff']) {
      const db = fakeDb(role);
      const log = [];
      const page = openPage('manage/employees.html', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
      try {
        assert.equal(await page.ready(8000), true, role);
        assert.ok(visible(page.$('#emp-live-notice')), role + ': 案内が出ない');
        assert.match(page.text('#emp-live-notice'), /スタッフのアカウントと権限は「スタッフ・権限」で管理します/);
        assert.ok(!visible(page.$('#emp-list')), role + ': デモの一覧が出ている');
        assert.ok(!visible(page.$('#btn-add')), role + ': 追加ボタンが出ている');
        assert.equal(page.$$('.crud-edit').length, 0, role + ': 編集リンクがある');
        assert.ok(!visible(page.$('#emp-roles')), role + ': デモの権限の説明が出ている');
        if (role === 'admin') {
          assert.ok(visible(page.$('#emp-staff-link')));
          assert.equal(page.$('#emp-staff-link').getAttribute('href'), 'staff.html');
        } else {
          assert.ok(!visible(page.$('#emp-staff-link')), '権限の無い役割にリンクを出している');
          assert.match(page.text('#emp-live-notice'), /管理者にご依頼ください/);
        }
        // メニューに従業員管理は無い / 書き込みもしない
        assert.equal(navHrefs(page).indexOf('employees.html'), -1);
        assert.equal(log.filter(l => l.kind === 'from' && l.op !== 'select').length, 0, role + ': 書き込んだ');
        deq(businessKeys(page.window.localStorage), []);
        assertClean(page, 'fake-employees-' + role);
      } finally { page.close(); }
    }
  });

  test('profile.html: ログイン中のスタッフ (名前・メール・役割・担当拠点・二段階認証) / パスワード変更 / デモ用の保存・バックアップは出さない', async () => {
    const db = fakeDb('store_staff');
    const log = [];
    const page = openPage('manage/profile.html', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => /設定済み/.test(page.text('#pf-mfa')), 3000);
      assert.ok(visible(page.$('#pf-live')));
      assert.ok(!visible(page.$('#pf-demo')));
      assert.equal(page.$$('#pf-demo *').length, 0, 'デモ用の入力欄が残っている');
      ['[data-setting]', '[data-save]', '#btn-export', '#btn-import-trigger', '#btn-reset', '#import-file'].forEach(s => assert.equal(page.$(s), null, s + ' が本番に出ている'));
      assert.equal(page.text('#pf-title'), 'アカウント');
      assert.equal(page.text('#pf-name'), '管理 太郎');
      assert.equal(page.text('#pf-email'), 'admin@example.com');
      assert.equal(page.text('#pf-role'), '店舗スタッフ');
      assert.equal(page.text('#pf-locations'), '釧路店');
      assert.match(page.text('#pf-mfa'), /設定済み.*このログインは確認コードで認証済みです/);
      assert.match(page.text('#pf-live'), /二段階認証のリセット/);
      assert.ok(!visible(page.$('#pf-mfa-admin')), '管理者以外にリセットの案内');
      // ユーザーメニューからこの画面へ
      assert.match(page.text('a[href="profile.html"]'), /アカウント/);

      // パスワード: 条件を満たさない → 送らない
      page.set('#pf-pw-new', 'short');
      page.set('#pf-pw-new2', 'short');
      page.submit('#pf-pw-form');
      await waitFor(() => !page.$('#pf-pw-msg').hidden, 2000);
      assert.match(page.text('#pf-pw-msg'), /パスワードは8文字以上で、英大文字・英小文字・数字/);
      // 確認用が違う
      page.set('#pf-pw-new', 'NewPass2026a');
      page.set('#pf-pw-new2', 'NewPass2026b');
      page.submit('#pf-pw-form');
      await waitFor(() => /一致しません/.test(page.text('#pf-pw-msg')), 2000);
      assert.equal(log.filter(l => l.kind === 'updateUser').length, 0, '入力エラーなのに送信した');
      // サーバーのエラー (同じパスワード)
      db.__updateUserError = { code: 'same_password', status: 422, message: 'New password should be different from the old password.' };
      page.set('#pf-pw-new2', 'NewPass2026a');
      page.submit('#pf-pw-form');
      await waitFor(() => /現在のものと同じ/.test(page.text('#pf-pw-msg')), 2000);
      assert.ok(page.$('#pf-pw-msg').classList.contains('is-error'));
      assert.equal(page.$('#pf-pw-btn').disabled, false);
      // 成功
      db.__updateUserError = null;
      page.submit('#pf-pw-form');
      page.submit('#pf-pw-form');   // 送信中の2回目は無視
      await waitFor(() => /パスワードを変更しました/.test(page.text('#pf-pw-msg')), 2000);
      deq(log.filter(l => l.kind === 'updateUser').map(l => l.attrs), [{ password: 'NewPass2026a' }, { password: 'NewPass2026a' }], '送信の回数 (同じパスワード1回 + 成功1回)');
      assert.equal(page.$('#pf-pw-new').value, '');
      assert.equal(page.$('#pf-pw-new2').value, '');
      // 端末にも app_settings (settings.profile) にも書かない
      assert.equal(log.filter(l => l.kind === 'from' && l.op !== 'select').length, 0);
      assert.equal(log.filter(l => l.kind === 'rpc' && /setting/.test(l.name)).length, 0);
      deq(businessKeys(page.window.localStorage), []);
      assertClean(page, 'fake-profile');
    } finally { page.close(); }

    // 認証アプリが未登録 (パスワードだけのログイン) / 管理者にはリセットの案内
    const db2 = fakeDb('admin');
    db2.__factors = [];
    db2.__aal = 'aal1';
    const page2 = openPage('manage/profile.html', { mode: 'fake', fakeClient: fakeClient(db2, []), fetch: fakeFunctions(db2, []) });
    try {
      assert.equal(await page2.ready(8000), true);
      await waitFor(() => /未設定/.test(page2.text('#pf-mfa')), 3000);
      assert.match(page2.text('#pf-mfa'), /未設定.*次回ログイン時に認証アプリの登録が必要です/);
      assert.match(page2.text('#pf-mfa-state'), /認証アプリが登録されていません/);
      assert.equal(page2.text('#pf-role'), '管理者');
      assert.equal(page2.text('#pf-locations'), '全拠点');
      assert.ok(visible(page2.$('#pf-mfa-admin')));
      assert.equal(page2.$('#pf-mfa-admin a').getAttribute('href'), 'staff.html');
      assertClean(page2, 'fake-profile-nomfa');
    } finally { page2.close(); }
  });

  test('staff.html: 「二段階認証をリセット」は自分以外・登録済みのスタッフだけ / 確認ダイアログ / 成功後は「次回ログイン時に再登録が必要です」', async () => {
    const db = fakeDb('admin');
    const log = [];
    const page = openPage('manage/staff.html', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
    const resets = () => log.filter(l => l.kind === 'fn' && l.path === '/admin/staff/reset-mfa');
    const row = id => page.$('#tbl tr[data-user="' + id + '"]');
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$$('#tbl tr[data-user]').length === 3, 3000);
      // 自分 (設定済み) にはボタンを出さない / 未設定のスタッフにも出さない
      assert.equal(row(ADMIN_UID).querySelector('.btn-mfa-reset'), null, '自分の行にリセットがある');
      assert.equal(row(THIRD_UID).querySelector('.btn-mfa-reset'), null, '未設定のスタッフにリセットがある');
      const btn = row(OTHER_UID).querySelector('.btn-mfa-reset');
      assert.ok(btn, 'リセットのボタンが無い');
      assert.equal(btn.textContent, '二段階認証をリセット');
      assert.ok(row(OTHER_UID).querySelector('.btn-edit'), '編集のボタンが無くなった');
      // 案内は Supabase の管理画面ではなく、この画面のリセット
      assert.doesNotMatch(page.text('.staff-notes'), /Supabase の管理画面/);
      assert.match(page.text('.staff-notes'), /「二段階認証をリセット」を押してください/);

      // 確認ダイアログで「キャンセル」→ 送らない
      page.confirmAnswer = false;
      btn.click();
      await sleep(50);
      assert.equal(page.confirms.length, 1);
      assert.match(page.confirms[0], /店舗 花子 さんの二段階認証をリセットします/);
      assert.match(page.confirms[0], /次回ログイン時に QR コードを読み取って登録し直す/);
      assert.equal(resets().length, 0, '確認で取り消したのに送った');

      // サーバーのエラー → トースト (ボタンは戻る)
      page.confirmAnswer = true;
      db.__resetError = { status: 403, body: { code: 'FORBIDDEN', message: 'この操作を行う権限がありません。必要な場合は管理者にお問い合わせください。' } };
      row(OTHER_UID).querySelector('.btn-mfa-reset').click();
      await waitFor(() => page.toasts('error').length, 2000);
      assert.match(page.toasts('error')[0], /二段階認証をリセットできませんでした。この操作を行う権限がありません/);
      assert.equal(row(OTHER_UID).querySelector('.btn-mfa-reset').disabled, false);

      // 成功 → 次回ログイン時に再登録
      db.__resetError = null;
      row(OTHER_UID).querySelector('.btn-mfa-reset').click();
      row(OTHER_UID).querySelector('.btn-mfa-reset') && row(OTHER_UID).querySelector('.btn-mfa-reset').click();   // 処理中の2回目は無視
      await waitFor(() => page.toasts('success').length, 2000);
      assert.match(page.toasts('success')[0], /店舗 花子 さんの二段階認証をリセットしました。次回ログイン時に再登録が必要です。/);
      deq(resets().map(l => l.body), [{ userId: OTHER_UID }, { userId: OTHER_UID }], '送信の回数 (エラー1回 + 成功1回)');
      await waitFor(() => log.filter(l => l.kind === 'fn' && l.path === '/admin/staff/list').length >= 2, 2000);
      await waitFor(() => /リセット済み/.test(row(OTHER_UID).textContent), 2000);
      assert.match(row(OTHER_UID).textContent, /未設定/);
      assert.match(row(OTHER_UID).textContent, /リセット済み。次回ログイン時に再登録が必要です/);
      assert.equal(row(OTHER_UID).querySelector('.btn-mfa-reset'), null, 'リセット後もボタンが残っている');
      assertClean(page, 'fake-staff-reset');
    } finally { page.close(); }
  });

  test('mail-log.html: 上限に達した失敗・自動では再送しない失敗は「再送すると最初から送り直します」/ 再送の権限が無ければ案内しない', async () => {
    const outbox = () => [
      { id: 21, template: 'reservation_confirmed', to_email: 'yamada@example.com', subject: '予約確認', status: 'failed', attempts: 8, last_error: '一時的なエラー (500)', ref_type: 'reservation', ref_id: 'R00021', created_at: '2026-09-22T01:00:00+00:00', sent_at: null, next_attempt_at: '2026-09-22T09:00:00+00:00' },
      { id: 22, template: 'inquiry_received', to_email: 'bad@example', subject: null, status: 'failed', attempts: 1, last_error: '宛先のメールアドレスが正しくありません', ref_type: 'inquiry', ref_id: 'C00022', created_at: '2026-09-22T02:00:00+00:00', sent_at: null, next_attempt_at: '2999-12-31T00:00:00.000Z' },
      { id: 23, template: 'coupon_issued', to_email: 'm@example.com', subject: null, status: 'pending', attempts: 8, last_error: null, ref_type: 'coupon', ref_id: 'c-23', created_at: '2026-09-22T03:00:00+00:00', sent_at: null, next_attempt_at: '2026-09-22T03:00:00+00:00' }
    ];
    const db = fakeDb('admin');
    db.outbox = outbox();
    const log = [];
    const page = openPage('manage/mail-log.html', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$$('#tbl tr[data-id]').length === 3, 3000);
      const rowText = id => page.text('#tbl tr[data-id="' + id + '"]');
      assert.match(rowText(21), /自動の再送は上限 \(8回\) に達したため止まっています。「再送」を押すと、最初から送り直します。/);
      assert.match(rowText(22), /自動では再送しません \(宛先の誤りなど\)。原因を確かめてから「再送」を押すと、最初から送り直します。/);
      assert.doesNotMatch(page.text('#tbl'), /送信されません|技術担当者にご連絡ください/);
      assert.match(page.text('.page-note'), /再送すると試行回数を 0 に戻し、最初から送り直します/);
      // 上限まで失敗したものも再送できる (試行回数が 0 に戻る)
      page.$('#tbl [data-retry="21"]').click();
      await waitFor(() => page.toasts().length, 2000);
      deq(log.filter(l => l.name === 'admin_retry_outbox').map(l => l.args), [{ p_id: 21 }]);
      await waitFor(() => page.text('#tbl tr[data-id="21"] td:nth-child(6)') === '1', 2000);
      assert.equal(page.text('#tbl tr[data-id="21"] td:nth-child(6)'), '1', '再送で試行回数が 0 に戻っていない');
      assertClean(page, 'fake-mail-log');
    } finally { page.close(); }

    // 経理 (outbox.read のみ): 再送ボタンも「再送」の案内も出さない
    const db2 = fakeDb('accounting');
    db2.outbox = outbox();
    const page2 = openPage('manage/mail-log.html', { mode: 'fake', fakeClient: fakeClient(db2, []), fetch: fakeFunctions(db2, []) });
    try {
      assert.equal(await page2.ready(8000), true);
      await waitFor(() => page2.$$('#tbl tr[data-id]').length === 3, 3000);
      assert.equal(page2.$$('#tbl [data-retry]').length, 0);
      assert.match(page2.text('#tbl'), /自動の再送は上限 \(8回\) に達したため止まっています。/);
      assert.doesNotMatch(page2.text('#tbl'), /「再送」を押すと/);
      assertClean(page2, 'fake-mail-log-accounting');
    } finally { page2.close(); }
  });
});

// =====================================================================
// 本番モード (ローカル Supabase + Edge Functions)
// =====================================================================
describe('F3 本番モード (ローカル Supabase)', { skip: NO_JSDOM || (SUPABASE_UMD ? false : 'supabase-js が見つかりません') }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });
  after(async () => { for (const id of createdUsers.splice(0)) await deleteUser(id); });
  const why = 'ローカル Supabase / Edge Functions に接続できません';

  test('mypage.html: 確認メールを送った画面・期限切れリンクの画面から再送 (Auth の resend: type=signup・戻り先・送信回数の上限)', async t => {
    if (!up) return t.skip(why);
    const email = uniq('member');
    const page = openPage('mypage.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      const w = page.window;
      // 実際のメール送信 (Auth のメール送信数の上限を共有している) はせず、呼び出し内容だけ確かめる
      const auth = w.SkyRentBackend.client.auth;
      const signups = [], resends = [];
      auth.signUp = async p => { signups.push(p.email); return { data: { user: { id: '00000000-0000-4000-8000-000000000000', email: p.email }, session: null }, error: null }; };
      auth.resend = async p => { resends.push(JSON.parse(JSON.stringify(p))); return { data: {}, error: null }; };
      page.set('#r-name', '再送 太郎');
      page.set('#r-email', email);
      page.set('#r-pass', 'Resend-2026x');
      page.set('#r-pass2', 'Resend-2026x');
      page.set('#r-privacy', true);
      page.submit('#reg-form');
      await waitFor(() => !page.$('#view-sent').hidden, 10000);
      deq(signups, [email]);
      assert.ok(visible(page.$('#sent-resend-btn')), '確認メールを送った画面に再送ボタンが無い');
      page.$('#sent-resend-btn').click();
      page.$('#sent-resend-btn').click();   // 送信中の2回目は無視
      await waitFor(() => !page.$('#sent-resend-msg').hidden, 5000);
      deq(resends, [{ type: 'signup', email: email, options: { emailRedirectTo: ORIGIN + '/mypage.html' } }]);
      assert.match(page.text('#sent-resend-msg'), new RegExp(email.replace(/[.+]/g, '\\$&') + ' 宛てに、確認メールをもう一度お送りしました'));
      assert.equal(page.$('#sent-resend-btn').disabled, true);
      assert.match(page.text('#sent-resend-btn'), /あと\d+秒/);
      page.$('#sent-resend-btn').click();
      await sleep(50);
      assert.equal(resends.length, 1, '待ち時間中に再送した');
      assertClean(page, 'live-mypage-sent');
    } finally { page.close(); }

    // 期限切れリンク → メールアドレスを入れて再送 / 送信回数の上限 (429)
    const page2 = openPage('mypage.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { mode: 'live' });
    try {
      assert.equal(await page2.ready(15000), true);
      deq(currentView(page2), ['link']);
      const auth = page2.window.SkyRentBackend.client.auth;
      const resends = [];
      auth.resend = async p => { resends.push(p.email); return { data: null, error: { code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' } }; };
      page2.set('#lr-email', email);
      page2.submit('#link-resend-form');
      await waitFor(() => !page2.$('#lr-msg').hidden, 5000);
      deq(resends, [email]);
      assert.match(page2.text('#lr-msg'), /短時間に操作が集中/);
      assert.ok(page2.$('#lr-msg').classList.contains('err'));
      assert.equal(page2.$('#lr-btn').disabled, true, '上限のあとすぐ押せる');
      assertClean(page2, 'live-mypage-link');
    } finally { page2.close(); }
  });

  test('booking.html: 古い版で確定 → サーバーの CONSENT_REQUIRED (documents / missing) で最新の版を出し直す → 同意し直して確定', async t => {
    if (!up) return t.skip(why);
    // 空いている日時 (他の担当とぶつからないよう 150〜390 日後)
    let start = null;
    for (let i = 0; i < 8 && !start; i++) {
      const s = jstAt(150 + Math.floor(Math.random() * 240), 9 + Math.floor(Math.random() * 7), Math.random() < 0.5 ? 0 : 30);
      const r = await apiCall('/quote', { assetId: 'V005', start: new Date(s).toISOString(), end: new Date(s + 26 * HOUR).toISOString(), optionIds: [] });
      if (r.status === 200 && r.json && r.json.availability && !r.json.availability.reasons.length) start = s;
    }
    assert.ok(start, '空いている日時が見つかりません');
    const email = uniq('booking');
    const resCalls = [];
    const page = openPage('booking.html', {
      mode: 'live',
      session: { [PENDING]: JSON.stringify({ assetId: 'V005', start: new Date(start).toISOString(), end: new Date(start + 26 * HOUR).toISOString(), quantity: 1, optionIds: [] }) },
      fetch: async (url, init, next) => {
        if (/\/functions\/v1\/api\/reservations$/.test(url)) resCalls.push(JSON.parse(init.body));
        // 画面の読み込み時だけ、キャンセル規定を古い版 (2026-07) にする (= 規約の更新前に開いていた画面)
        if (url.indexOf('/rest/v1/rpc/public_catalog') < 0) return null;
        const res = await next();
        const j = await res.json();
        j.legal = (j.legal || []).map(d => (d.id === 'cancel' ? Object.assign({}, d, { version: '2026-07', title: 'キャンセル規定 (旧)' }) : d));
        return jsonRes(j);
      }
    });
    let lookupUrl = null;
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => page.$('#f-licconf') && page.$$('#consent-box input[data-doc]').length === 3, 5000);
      deq(page.$$('#consent-box input[data-doc]').map(c => c.dataset.doc + '@' + c.dataset.ver), ['clause@2026-08', 'cancel@2026-07', 'privacy@2026-08']);
      page.set('#f-name', 'テスト F3');
      page.set('#f-email', email);
      page.set('#f-phone', '090-0000-3333');
      page.set('#f-licconf', true);
      page.submit('#cust-form');
      await waitFor(() => !page.$('#pane-confirm').hidden || !page.$('#input-error').hidden, 10000);
      assert.equal(page.$('#pane-confirm').hidden, false, '確認画面に進まない: ' + page.text('#input-error'));
      page.$$('#consent-box input[data-doc]').forEach(c => { c.checked = true; });
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#confirm-error').hidden || !page.$('#pane-done').hidden, 15000);
      if (/短時間に操作が集中/.test(page.text('#confirm-error'))) return t.skip('レート制限 (他のテストと共有の IP) のため確定できませんでした');
      assert.equal(resCalls.length, 1);
      assert.equal(page.$('#pane-done').hidden, true, '古い版のまま確定した');
      // サーバーの最新の版で同意欄を出し直す (キャンセル規定だけチェックし直し)
      assert.match(page.text('#confirm-error'), /「キャンセル規定」の内容が更新されました/);
      deq(page.$$('#consent-box input[data-doc]').map(c => c.dataset.doc + '@' + c.dataset.ver + (c.checked ? ':on' : '')), ['clause@2026-08:on', 'cancel@2026-08', 'privacy@2026-08:on']);
      assert.equal(page.$('#consent-box input[data-doc="cancel"]').closest('label').querySelector('a').getAttribute('href'), 'law.html#cancel');
      page.$('#consent-box input[data-doc="cancel"]').checked = true;
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#pane-done').hidden || (resCalls.length === 2 && !page.$('#confirm-error').hidden), 20000);
      if (page.$('#pane-done').hidden && /短時間に操作が集中/.test(page.text('#confirm-error'))) return t.skip('レート制限 (他のテストと共有の IP) のため確定できませんでした');
      assert.equal(page.$('#pane-done').hidden, false, '完了画面にならない: ' + page.text('#confirm-error'));
      assert.equal(resCalls.length, 2);
      assert.equal(resCalls[1].idempotencyKey, resCalls[0].idempotencyKey);
      deq(resCalls[1].consent.documents.map(d => d.id + '@' + d.version).sort(), ['cancel@2026-08', 'clause@2026-08', 'privacy@2026-08']);
      lookupUrl = page.$('#lookup-url').value;
      assertClean(page, 'live-booking-consent');
    } finally {
      page.close();
      const m = /#lookup=([^.]+)\.(.+)$/.exec(lookupUrl || '');
      if (m) {
        const id = decodeURIComponent(m[1]), token = m[2];
        const lk = await apiCall('/reservations/lookup', { id: id, token: token });
        const c = lk.status === 200 ? await apiCall('/reservations/cancel', { id: id, token: token, expectedFee: lk.json.cancellation.fee }) : lk;
        assert.equal(c.status, 200, 'テスト予約のキャンセルに失敗: ' + JSON.stringify(c.json));
      }
    }
  });

  test('profile.html: 二段階認証済みのスタッフの情報を表示し、パスワードを変更できる (新しいパスワードでログインできる)', async t => {
    if (!up) return t.skip(why);
    const u = await createStaff({ role: 'store_staff', name: 'F3 店舗 花子', prefix: 'profile', locationIds: ['loc-kitami'], factor: true });
    const page = openPage('manage/profile.html', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(u.session) } });
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => /設定済み/.test(page.text('#pf-mfa')), 10000);
      assert.equal(page.text('#pf-name'), 'F3 店舗 花子');
      assert.equal(page.text('#pf-email'), u.email);
      assert.equal(page.text('#pf-role'), '店舗スタッフ');
      assert.equal(page.text('#pf-locations'), page.window.SkyRentStore.getLocation('loc-kitami').name);
      assert.match(page.text('#pf-mfa'), /このログインは確認コードで認証済みです/);
      assert.equal(page.$('[data-setting]'), null);
      assert.equal(page.$('#btn-export'), null);
      // 同じパスワード → サーバーのエラー
      page.set('#pf-pw-new', u.password);
      page.set('#pf-pw-new2', u.password);
      page.submit('#pf-pw-form');
      await waitFor(() => !page.$('#pf-pw-msg').hidden, 10000);
      assert.match(page.text('#pf-pw-msg'), /現在のものと同じ/);
      // 新しいパスワード
      const next = PASSWORD();
      page.set('#pf-pw-new', next);
      page.set('#pf-pw-new2', next);
      page.submit('#pf-pw-form');
      await waitFor(() => /パスワードを変更しました/.test(page.text('#pf-pw-msg')), 10000);
      assert.match(page.text('#pf-pw-msg'), /パスワードを変更しました/);
      const s = await api('/auth/v1/token?grant_type=password', { body: { email: u.email, password: next } });
      assert.ok(s && s.access_token, '新しいパスワードでログインできない');
      const old = await api('/auth/v1/token?grant_type=password', { body: { email: u.email, password: u.password }, allowError: true });
      assert.equal(old.status, 400, '古いパスワードでログインできる');
      deq(businessKeys(page.window.localStorage), []);
      assertClean(page, 'live-profile');
    } finally { page.close(); }
  });

  test('staff.html: 別のスタッフの二段階認証をリセット (admin/staff/reset-mfa) → 認証アプリの登録が消え、一覧は「再登録が必要」', async t => {
    if (!up) return t.skip(why);
    const adminUser = await createStaff({ role: 'admin', name: 'F3 管理者', prefix: 'admin', factor: true });
    const target = await createStaff({ role: 'store_staff', name: 'F3 対象 次郎', prefix: 'target', factor: true });
    assert.equal((await verifiedFactors(target.userId)).length, 1);
    const page = openPage('manage/staff.html', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(adminUser.session) } });
    const row = id => page.$('#tbl tr[data-user="' + id + '"]');
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => row(adminUser.userId) && row(target.userId), 15000);
      assert.match(row(target.userId).textContent, /設定済み/);
      assert.equal(row(adminUser.userId).querySelector('.btn-mfa-reset'), null, '自分の行にリセットがある');
      const btn = row(target.userId).querySelector('.btn-mfa-reset');
      assert.ok(btn, 'リセットのボタンが無い');
      // 確認で取り消し → 何も変わらない
      page.confirmAnswer = false;
      btn.click();
      await sleep(100);
      assert.equal(page.fetches.filter(f => /\/admin\/staff\/reset-mfa$/.test(f.url)).length, 0);
      assert.equal((await verifiedFactors(target.userId)).length, 1);
      // リセット
      page.confirmAnswer = true;
      row(target.userId).querySelector('.btn-mfa-reset').click();
      await waitFor(() => page.toasts('success').length || page.toasts('error').length, 15000);
      assert.deepEqual(page.toasts('error'), [], 'リセットでエラー');
      assert.match(page.toasts('success')[0], /F3 対象 次郎 さんの二段階認証をリセットしました。次回ログイン時に再登録が必要です。/);
      deq(page.fetches.filter(f => /\/admin\/staff\/reset-mfa$/.test(f.url)).map(f => f.body), [{ userId: target.userId }]);
      assert.equal((await verifiedFactors(target.userId)).length, 0, '認証アプリの登録が消えていない');
      await waitFor(() => /リセット済み/.test(row(target.userId) ? row(target.userId).textContent : ''), 10000);
      assert.match(row(target.userId).textContent, /未設定/);
      assert.match(row(target.userId).textContent, /次回ログイン時に再登録が必要です/);
      assert.equal(row(target.userId).querySelector('.btn-mfa-reset'), null);
      // 管理者自身の登録は残る
      assert.equal((await verifiedFactors(adminUser.userId)).length, 1);
      assertClean(page, 'live-staff-reset');
    } finally { page.close(); }
  });
});
