/**
 * 担当E1: 管理画面の入口と権限 (manage/login.html / manage/partials.js / manage/staff.html / manage/audit.html)
 *
 * 実行: node --test tests/pages-e1.test.mjs
 *
 *   - デモモード: 簡易ログイン・?next= の検証・ヘッダー/メニュー・新規ページの「本番接続時に使えます」
 *   - 偽クライアント (本番モード・サーバーなし): 役割ごとのメニュー表示、スタッフ画面のエラー表示
 *     (LAST_ADMIN・入力エラー)、操作履歴の表示 (*** の伏せ字・ページ送り・絞り込み)
 *   - ローカル Supabase (http://127.0.0.1:54321 + 起動中の Edge Functions):
 *       パスワード → 二段階認証の登録 (QR/キー) → AAL2 → ?next= へ、登録済みの確認コード、?step=mfa、
 *       招待リンク・再設定リンクからの新パスワード設定、スタッフ一覧・招待・役割変更、操作履歴の絞り込み
 *     テスト用ユーザーは毎回作って最後に消す (admin@example.com には触らない)。起動していなければ skip。
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
const AUTH_KEY = 'sb-127-auth-token';   // supabase-js の保存キー (URL のホスト 127.0.0.1 → '127')
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

/**
 * ページを jsdom で開く
 *   mode: 'demo' | 'live' (ローカル Supabase) | 'fake' (偽の supabase クライアント)
 *   fetch: (url, init) => Response | null … window.fetch の差し替え (null なら本物)
 */
function openPage(path, opts) {
  opts = opts || {};
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
  const file = join(ROOT, path.split(/[?#]/)[0]);
  const html = readFileSync(file, 'utf8');
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
    url: ORIGIN + '/' + path,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: { interceptors: [requestInterceptor(req => intercept(req))] },
    beforeParse(window) {
      window.fetch = async (...args) => {
        if (opts.fetch) {
          const r = await opts.fetch(String(args[0] && args[0].url ? args[0].url : args[0]), args[1] || {});
          if (r) return r;
        }
        return globalThis.fetch(...args);
      };
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.scrollTo = () => {};
      window.confirm = () => (opts.confirm === undefined ? true : opts.confirm);
      window.matchMedia = q => ({ matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
      if (opts.mode === 'live') window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(LIVE_CONFIG));
      if (opts.mode === 'fake') {
        window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(FAKE_CONFIG));
        window.supabase = { createClient: () => opts.fakeClient };
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
  out.ready = ms => Promise.race([dom.window.__ready, new Promise(r => setTimeout(() => r(false), ms || 8000).unref())]);
  out.close = () => { try { dom.window.close(); } catch (e) { /* 無視 */ } };
  out.$ = s => dom.window.document.querySelector(s);
  out.text = s => { const el = dom.window.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };
  return out;
}

// JS エラー・読み込み失敗・console.error が無いこと (allowNav: 画面遷移 (location.replace) は想定どおり)
function assertClean(page, label, allowNav) {
  deq(page.errors, [], label + ': JS エラー');
  deq(page.resourceErrors, [], label + ': 読み込めなかったファイル');
  deq(page.consoleErrors, [], label + ': console.error');
  if (!allowNav) deq(page.notImplemented.filter(m => /navigation/i.test(m)), [], label + ': 想定外の画面遷移');
}
function assertBooted(page, label) {
  assert.equal(page.document.querySelectorAll('script[type="text/x-deferred"]').length, 0, label + ': 未実行の遅延スクリプト');
  assert.equal(page.document.documentElement.classList.contains('skyrent-booting'), false, label + ': 画面が隠れたまま');
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
function visible(el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden || (e.style && e.style.display === 'none')) return false;
  }
  return !!el;
}
function navHrefs(page) {
  return Array.from(page.document.querySelectorAll('.topnav-menu a[data-perm]')).filter(visible).map(a => a.getAttribute('href'));
}
// jsdom の input に値を入れる
function fill(page, sel, v) {
  const el = page.$(sel);
  assert.ok(el, sel + ' が無い');
  el.value = v;
}
function submit(page, formSel) {
  const f = page.$(formSel);
  f.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
}
const view = page => page.window.SkyRentManageLogin && page.window.SkyRentManageLogin.view;

const NO_JSDOM = jsdom ? false : 'jsdom が見つかりません (npm install を実行してください)';

// =====================================================================
// ローカル Supabase の小物
// =====================================================================
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
async function api(path, opts) {
  opts = opts || {};
  const key = opts.service ? SERVICE_KEY : ANON_KEY;
  const res = await fetch(LOCAL_API + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    redirect: 'manual',
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + (opts.token || key), 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  if (!res.ok && !opts.allowError) {
    const e = new Error(path + ': HTTP ' + res.status + ' ' + text.slice(0, 200));
    e.body = json;
    e.status = res.status;
    throw e;
  }
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
// 同じコードの使い回しで弾かれないよう、30 秒の区切りの直前 (残り 3 秒未満) は次の区切りまで待つ
async function freshTotp(secret) {
  const left = 30000 - (Date.now() % 30000);
  if (left < 3000) await sleep(left + 200);
  return totp(secret);
}
const jwtPayload = t => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());
const uniq = p => 'e1-' + p + '-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
const PASSWORD = () => 'E1-pass-' + randomBytes(4).toString('hex') + 'Aa1';

const createdUsers = [];
async function createUser(opts) {
  opts = opts || {};
  const email = uniq(opts.prefix || 'user');
  const password = PASSWORD();
  const user = await api('/auth/v1/admin/users', { service: true, body: { email: email, password: password, email_confirm: true } });
  const userId = user.id || (user.user && user.user.id);
  createdUsers.push(userId);
  if (opts.role) {
    await api('/rest/v1/staff', { service: true, body: { user_id: userId, name: opts.name || 'E1 テスト', email: email, role: opts.role, active: true, location_ids: opts.locationIds || null }, headers: { Prefer: 'return=minimal' } });
  }
  const out = { userId: userId, email: email, password: password };
  if (opts.factor) {
    const s1 = await api('/auth/v1/token?grant_type=password', { body: { email: email, password: password } });
    const factor = await api('/auth/v1/factors', { token: s1.access_token, body: { factor_type: 'totp', friendly_name: 'e1-test' } });
    const ch = await api('/auth/v1/factors/' + factor.id + '/challenge', { token: s1.access_token, body: {} });
    const s2 = await api('/auth/v1/factors/' + factor.id + '/verify', { token: s1.access_token, body: { challenge_id: ch.id, code: await freshTotp(factor.totp.secret) } });
    out.secret = factor.totp.secret;
    out.factorId = factor.id;
    out.session = Object.assign({}, s2, { expires_at: s2.expires_at || Math.floor(Date.now() / 1000) + (s2.expires_in || 3600) });
  }
  return out;
}
// 登録済みの認証アプリの今のコード (ローカルの Auth は同じ区切り内のコードの再利用を拒まないので待たない)
async function nextCode(u) {
  return freshTotp(u.secret);
}
async function passwordSession(email, password) {
  const s = await api('/auth/v1/token?grant_type=password', { body: { email: email, password: password } });
  return Object.assign({}, s, { expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) });
}
async function deleteUser(userId) {
  try { await api('/auth/v1/admin/users/' + userId, { service: true, method: 'DELETE' }); } catch (e) { /* 後片付けの失敗は無視 */ }
}
async function serviceSelect(table, query) {
  return api('/rest/v1/' + table + '?' + (query || 'select=*'), { service: true });
}
// 招待・再設定のリンクを開いたときに戻ってくる # (access_token=...&type=...)
async function linkHash(type, email, extra) {
  const body = Object.assign({ type: type, email: email, redirect_to: 'http://127.0.0.1:8901/manage/login.html' }, extra || {});
  const link = await api('/auth/v1/admin/generate_link', { service: true, body: body });
  const actionLink = link.action_link || (link.properties && link.properties.action_link);
  const res = await fetch(actionLink, { redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  const hash = loc.split('#')[1] || '';
  assert.ok(/access_token=/.test(hash), type + ' のリンクから access_token が返らない: ' + loc.replace(/access_token=[^&]+/, '…'));
  return { hash: '#' + hash, userId: link.id || (link.user && link.user.id) };
}

// =====================================================================
// 偽の supabase クライアント (本番モードをサーバーなしで)
// =====================================================================
const ADMIN_UID = '11111111-2222-3333-4444-555555555555';
const OTHER_UID = '22222222-3333-4444-5555-666666666666';
const MEMBER_UID = '99999999-8888-7777-6666-555555555555';
function fakeDb(role) {
  const audit = [];
  for (let i = 0; i < 62; i++) {
    audit.push({ id: 1000 - i, at: new Date(Date.UTC(2026, 8, 22, 12, 0, 0) - i * 60000).toISOString(), actor: ADMIN_UID, actor_role: 'admin', action: 'update', table_name: 'reservations', row_id: 'R' + String(100 + i).padStart(5, '0'), diff: { status: 'in_use' } });
  }
  audit[0] = { id: 1000, at: '2026-09-22T12:00:00+00:00', actor: ADMIN_UID, actor_role: 'admin', action: 'update', table_name: 'staff', row_id: OTHER_UID, diff: { role: 'viewer', email: '***', active: false } };
  audit[1] = { id: 999, at: '2026-09-22T11:59:00+00:00', actor: null, actor_role: 'service_role', action: 'insert', table_name: 'reservations', row_id: 'R00001', diff: { id: 'R00001', kind: 'rental', status: 'confirmed', asset_id: 'V003', customer_name: '<b>会員</b> 一郎', total: 17000, start_at: '2026-10-01T01:00:00+00:00', created_at: '2026-09-22T11:59:00+00:00', price: { total: 17000 } } };
  audit[2] = { id: 998, at: '2026-09-22T11:58:00+00:00', actor: MEMBER_UID, actor_role: 'authenticated', action: 'update', table_name: 'members', row_id: MEMBER_UID, diff: { phone: '***', marketing_opt_in: true } };
  audit[3] = { id: 997, at: '2026-09-22T11:57:00+00:00', actor: ADMIN_UID, actor_role: 'admin', action: 'delete', table_name: 'app_collections', row_id: 'faq/F001', diff: { deleted: true } };
  return {
    __session: { access_token: 'fake-token', user: { id: ADMIN_UID, email: 'admin@example.com' } },
    __role: role || 'admin',
    __failRpc: {},
    categories: [{ id: 'cat-rental', name: '一般レンタカー', name_en: 'Rental Car', type: 'vehicle', icon: '🚗', description: '', sort: 1, active: true, custom_field_defs: [], extra: {} }],
    locations: [{ id: 'loc-kitami', name: '北見本店', name_en: 'Kitami', tel: '', address: '北海道北見市', hours: '', holiday: '', sort: 1, active: true, extra: {} },
                { id: 'loc-kushiro', name: '釧路店', name_en: 'Kushiro', tel: '', address: '北海道釧路市', hours: '', holiday: '', sort: 2, active: true, extra: {} }],
    assets: [{ id: 'V003', category_id: 'cat-rental', location_id: 'loc-kitami', name: 'マツダ CX-5', name_en: '', plate: '', capacity: 5, price_hour: 2200, price_day: 17000, price_week: null, price_month: null, stock: 1, required_license: '', image: '', photo: '', active: true, shaken_date: null, maintenance_date: null, custom_fields: {}, sort: 1, extra: {} }],
    options: [], app_settings: [], app_collections: [], legal_documents: [],
    members: [{ user_id: MEMBER_UID, member_no: 'M00001', email: 'm@example.com', name: '会員 一郎', name_kana: '', phone: '090', company: '', is_corporate: false, invoice_allowed: false, marketing_opt_in: false, status: 'active', last_use_at: null, created_at: '2026-01-01T00:00:00+00:00' }],
    member_points: [], coupons: [], point_ledger: [], reservations: [], invoices: [], inquiries: [],
    staff: [{ user_id: ADMIN_UID, name: '管理 太郎', email: 'admin@example.com', role: 'admin', active: true, location_ids: null },
            { user_id: OTHER_UID, name: '店舗 花子', email: 'hanako@example.com', role: 'store_staff', active: true, location_ids: ['loc-kitami'] }],
    audit_log: audit
  };
}
function fakeClient(db, log) {
  const test = (f, r) => {
    const v = r[f[0]];
    switch (f[1]) {
      case 'eq': return v === f[2];
      case 'in': return f[2].indexOf(v) >= 0;
      case 'is': return v === f[2] || (f[2] === null && v == null);
      case 'gte': return String(v) >= String(f[2]) || Date.parse(v) >= Date.parse(f[2]);
      case 'lt': return Date.parse(v) < Date.parse(f[2]);
      default: return true;
    }
  };
  function exec(st) {
    log.push({ kind: 'from', table: st.table, op: st.op, filters: st.filters, orders: st.orders, range: st.range });
    if (st.op !== 'select') return { data: null, error: null };
    let rows = (db[st.table] || []).filter(r => st.filters.every(f => test(f, r)));
    st.orders.slice().reverse().forEach(o => {
      rows = rows.slice().sort((a, b) => {
        const x = a[o[0]], y = b[o[0]];
        const c = x < y ? -1 : x > y ? 1 : 0;
        return o[1] ? c : -c;
      });
    });
    if (st.single) return { data: rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null, error: null };
    if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
    return { data: JSON.parse(JSON.stringify(rows)), error: null };
  }
  function builder(table) {
    const st = { table: table, op: 'select', filters: [], orders: [], range: null, single: false };
    const b = {
      select(cols) { st.cols = cols; return b; },
      order(col, o) { st.orders.push([col, !(o && o.ascending === false)]); return b; },
      range(x, y) { st.range = [x, y]; return b; },
      eq(col, v) { st.filters.push([col, 'eq', v]); return b; },
      in(col, vs) { st.filters.push([col, 'in', vs]); return b; },
      is(col, v) { st.filters.push([col, 'is', v]); return b; },
      gte(col, v) { st.filters.push([col, 'gte', v]); return b; },
      lt(col, v) { st.filters.push([col, 'lt', v]); return b; },
      maybeSingle() { st.single = true; return b; },
      upsert() { st.op = 'upsert'; return b; },
      delete() { st.op = 'delete'; return b; },
      then(ok, ng) { return Promise.resolve(exec(st)).then(ok, ng); }
    };
    return b;
  }
  const rpcs = {
    public_catalog: () => ({ categories: db.categories, locations: db.locations, assets: db.assets, options: db.options, settings: {}, collections: {}, legal: [] }),
    staff_role: () => db.__role,
    admin_recent_activity: () => [],
    admin_update_staff: a => {
      const s = db.staff.find(x => x.user_id === a.p_user);
      if (!s) throw new Error('NOT_FOUND');
      Object.assign(s, a.p_patch);
      return JSON.parse(JSON.stringify(s));
    }
  };
  return {
    auth: {
      getSession: async () => ({ data: { session: db.__session || null }, error: null }),
      signOut: async () => { log.push({ kind: 'signOut' }); db.__session = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' }, error: null }) }
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
// 偽の Edge Function (admin)
function fakeFunctions(db, log) {
  return async (url, init) => {
    if (url.indexOf(FAKE_URL + '/functions/v1/') !== 0) return null;
    const path = url.slice((FAKE_URL + '/functions/v1').length).split('?')[0];
    const body = init && init.body ? JSON.parse(init.body) : null;
    log.push({ kind: 'fn', path: path, body: body });
    const json = (status, obj) => new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/admin/staff/list') {
      return json(200, { ok: true, staff: db.staff.map(s => ({ userId: s.user_id, name: s.name, email: s.email, role: s.role, locationIds: s.location_ids, active: s.active, lastSignInAt: s.user_id === ADMIN_UID ? '2026-09-22T01:30:00Z' : null, emailConfirmed: s.user_id === ADMIN_UID, mfaEnabled: s.user_id === ADMIN_UID })) });
    }
    if (path === '/admin/staff/invite') {
      if (db.__inviteError) return json(db.__inviteError.status, Object.assign({ ok: false, requestId: 'req-1' }, db.__inviteError.body));
      db.staff.push({ user_id: 'new-' + db.staff.length, name: body.name, email: body.email, role: body.role, active: true, location_ids: body.locationIds });
      return json(200, { ok: true, userId: 'new', invited: true });
    }
    return json(404, { ok: false, code: 'NOT_FOUND', message: '見つかりません' });
  };
}

// =====================================================================
// デモモード
// =====================================================================
describe('デモモード', { skip: NO_JSDOM }, () => {
  test('login.html: 簡易ログイン → ?next= のページへ / 再設定はメールを送らない', async () => {
    const page = openPage('manage/login.html?next=staff.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      assert.equal(view(page), 'login');
      assert.ok(visible(page.$('#demo-note')), 'デモの案内が出ない');
      assert.equal(page.$('#login-email').type, 'text', 'デモは任意の値で入れる');
      // パスワード再設定 (デモ)
      page.$('[data-action="forgot"]').click();
      assert.equal(view(page), 'forgot');
      fill(page, '#forgot-email', 'someone@example.com');
      submit(page, '#forgot-form');
      await waitFor(() => page.text('#login-info'), 2000);
      assert.match(page.text('#login-info'), /デモ環境ではメールは送信されません/);
      page.$('[data-action="back"]').click();
      assert.equal(view(page), 'login');
      // 任意の値でログイン
      fill(page, '#login-email', 'demo-user');
      fill(page, '#login-password', 'x');
      submit(page, '#login-form');
      await waitFor(() => w.SkyRentManageLogin.lastRedirect, 3000);
      assert.equal(w.SkyRentManageLogin.lastRedirect, 'staff.html');
      assert.equal(JSON.parse(w.sessionStorage.getItem('sky-rent.session')).userId, 'demo-user');
      assertBooted(page, 'demo-login');
      assertClean(page, 'demo-login', true);
    } finally { page.close(); }
  });

  test('login.html: ?next= は同じディレクトリのファイル名だけ (オープンリダイレクト対策)', async () => {
    const page = openPage('manage/login.html');
    try {
      assert.equal(await page.ready(8000), true);
      const safeNext = page.window.SkyRentManageLogin.safeNext;
      const cases = {
        '': 'dashboard.html',
        'reservation-list.html': 'reservation-list.html',
        'reservation-list.html?x=1&y=2': 'reservation-list.html?x=1&y=2',
        'reservation-list.html#R00012': 'reservation-list.html#R00012',
        'audit.html?table=reservations&row=R00012': 'audit.html?table=reservations&row=R00012',
        'https://evil.example.com/': 'dashboard.html',
        '//evil.example.com/x.html': 'dashboard.html',
        '/\\evil.example.com': 'dashboard.html',
        '\\\\evil.example.com/a.html': 'dashboard.html',
        'javascript:alert(1)': 'dashboard.html',
        'JavaScript:alert(1)//.html': 'dashboard.html',
        'data:text/html,<script>alert(1)</script>': 'dashboard.html',
        '../index.html': 'dashboard.html',
        '../../evil.html': 'dashboard.html',
        'sub/page.html': 'dashboard.html',
        '/manage/dashboard.html': 'dashboard.html',
        'login.html': 'dashboard.html',
        'LOGIN.html?next=x': 'dashboard.html',
        'dashboard.html\\@evil.example.com': 'dashboard.html',
        'dashboard.html?\\': 'dashboard.html',
        ' dashboard.html': 'dashboard.html',
        'dash board.html': 'dashboard.html',
        'members.htm': 'dashboard.html',
        'http:evil.example.com': 'dashboard.html'
      };
      Object.entries(cases).forEach(([input, expected]) => assert.equal(safeNext(input), expected, JSON.stringify(input)));
      assert.equal(safeNext(null), 'dashboard.html');
      assertClean(page, 'safeNext');
    } finally { page.close(); }
  });

  test('partials.js: 新しいメニュー・ヘッダーの名前 (store 経由)・デモの自動セッション', async () => {
    const page = openPage('manage/dashboard.html', { local: { 'sky-rent.settings.profile': JSON.stringify({ name: 'デモ 花子' }) } });
    try {
      assert.equal(await page.ready(8000), true);
      const hrefs = navHrefs(page);
      ['inquiries.html', 'mail-log.html', 'calendar.html', 'staff.html', 'audit.html', 'dashboard.html', 'site-settings.html', 'employees.html', 'contact.html'].forEach(h => {
        assert.ok(hrefs.indexOf(h) >= 0, h + ' がメニューに無い');
      });
      // システムについてのお問合せ・手順書は「システム」のグループに1つだけ
      const contact = page.document.querySelectorAll('.topnav-menu a[href="contact.html"]');
      assert.equal(contact.length, 1);
      assert.equal(contact[0].closest('[data-nav-group]').querySelector('.topnav-toggle').textContent.replace(/▼/, '').trim(), 'システム');
      assert.match(contact[0].textContent, /システムについてのお問合せ・手順書/);
      assert.equal(page.text('#topbar-staff-name'), 'デモ 花子');
      assert.equal(page.text('#topbar-staff-role'), '管理者 (デモ)');
      assert.ok(page.$('a[href="profile.html"]'), 'デモではプロフィール編集を出す');
      assert.ok(page.$('#topbar-logout'));
      assert.ok(page.window.sessionStorage.getItem('sky-rent.session'), 'デモの自動セッションが作られない');
      assertBooted(page, 'demo-dashboard');
      assertClean(page, 'demo-dashboard');
    } finally { page.close(); }
  });

  test('staff.html / audit.html: 「本番接続時に使えます」を出して壊れない', async () => {
    for (const path of ['manage/staff.html', 'manage/audit.html']) {
      const page = openPage(path);
      try {
        assert.equal(await page.ready(8000), true, path);
        assert.match(page.text('.page-notice'), /本番接続時に使えます/, path);
        assert.ok(visible(page.$('.page-notice')), path);
        assert.ok(!visible(page.$(path.indexOf('staff') >= 0 ? '#staff-main' : '#audit-main')), path + ': 本番用の一覧が出ている');
        if (path.indexOf('staff') >= 0) {
          // 役割ごとの説明表 (13 の権限 + 概要)
          assert.equal(page.document.querySelectorAll('#role-table tbody tr').length, 14);
          assert.equal(page.document.querySelectorAll('#role-table thead th').length, 6);
          assert.match(page.text('#role-table'), /店舗スタッフ/);
        }
        assert.ok(page.$('.topbar'), path + ': ヘッダー');
        assert.ok(page.$('.topnav-menu a.active'), path + ': 現在のページがメニューで強調されない');
        assertBooted(page, path);
        assertClean(page, path);
      } finally { page.close(); }
    }
  });
});

// =====================================================================
// 本番モード (偽クライアント)
// =====================================================================
describe('本番モード (偽クライアント): メニューの権限・スタッフ画面・操作履歴', { skip: NO_JSDOM }, () => {
  test('partials.js: 役割ごとに権限の無いメニューを隠す・名前と役割・ログアウト', async () => {
    // 従業員管理 (デモ用の一覧) は本番ではどの役割にも出さない (スタッフ・権限に一本化)。お問合せ・手順書は全員
    const expect = {
      admin: { show: ['staff.html', 'audit.html', 'calendar.html', 'mail-log.html', 'inquiries.html', 'site-settings.html', 'contact.html'], hide: ['employees.html'] },
      store_staff: { show: ['mail-log.html', 'inquiries.html', 'content.html', 'dashboard.html', 'contact.html'], hide: ['staff.html', 'audit.html', 'calendar.html', 'site-settings.html', 'ga-integration.html', 'employees.html'] },
      viewer: { show: ['dashboard.html', 'inquiries.html', 'members.html', 'contact.html'], hide: ['mail-log.html', 'staff.html', 'audit.html', 'calendar.html', 'site-settings.html', 'content.html', 'employees.html'] },
      accounting: { show: ['mail-log.html', 'invoices.html', 'contact.html'], hide: ['staff.html', 'audit.html', 'calendar.html', 'content.html', 'employees.html'] }
    };
    for (const role of Object.keys(expect)) {
      const db = fakeDb(role);
      const log = [];
      const page = openPage('manage/dashboard.html', { mode: 'fake', fakeClient: fakeClient(db, log) });
      try {
        assert.equal(await page.ready(8000), true, role);
        const hrefs = navHrefs(page);
        expect[role].show.forEach(h => assert.ok(hrefs.indexOf(h) >= 0, role + ': ' + h + ' が出ない'));
        expect[role].hide.forEach(h => assert.ok(hrefs.indexOf(h) < 0, role + ': ' + h + ' が出ている'));
        assert.equal(page.text('#topbar-staff-name'), '管理 太郎');
        assert.equal(page.text('#topbar-staff-role'), { admin: '管理者', store_staff: '店舗スタッフ', viewer: '閲覧のみ', accounting: '経理' }[role]);
        // 本番のユーザーメニューは「アカウント」(パスワード・二段階認証)。端末内のプロフィール編集は出さない
        assert.equal(page.document.querySelectorAll('a[href="profile.html"]').length, 1);
        assert.match(page.text('a[href="profile.html"]'), /アカウント/);
        assert.doesNotMatch(page.text('a[href="profile.html"]'), /プロフィール編集/);
        assert.equal(page.document.querySelectorAll('a[href="employees.html"]').length, 0, '本番で従業員管理がメニューにある');
        if (role === 'viewer') {
          // 表示できる項目が無いグループ (予約サイト設定) ごと隠す。システムはお問合せ・手順書だけ
          const groups = Array.from(page.document.querySelectorAll('[data-nav-group]')).filter(visible).map(g => g.querySelector('.topnav-toggle').textContent.replace(/▼/, '').trim());
          assert.ok(groups.indexOf('予約サイト設定') < 0, groups.join(','));
          assert.ok(groups.indexOf('システム') >= 0, groups.join(','));
          const sys = Array.from(page.document.querySelectorAll('[data-nav-group]')).find(g => /システム/.test(g.querySelector('.topnav-toggle').textContent));
          deq(Array.from(sys.querySelectorAll('a[data-perm]')).filter(visible).map(a => a.getAttribute('href')), ['contact.html']);
        }
        assert.equal(page.window.sessionStorage.getItem('sky-rent.session'), null, '本番でデモのセッションを作った');
        if (role === 'admin') {
          // ログアウト → Supabase のサインアウト → login.html
          page.$('#topbar-logout').click();
          await waitFor(() => log.some(l => l.kind === 'signOut'), 2000);
          assert.ok(log.some(l => l.kind === 'signOut'), 'サインアウトしない');
          await waitFor(() => page.notImplemented.some(m => /navigation/i.test(m)), 2000);
        }
        deq(businessKeys(page.window.localStorage), []);
        assertClean(page, 'fake-nav-' + role, role === 'admin');
      } finally { page.close(); }
    }
  });

  test('staff.html: 一覧・招待 (入力エラー/成功)・編集 (LAST_ADMIN の表示)', async () => {
    const db = fakeDb('admin');
    const log = [];
    const page = openPage('manage/staff.html', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-user]').length === 2, 3000);
      const rows = Array.from(page.document.querySelectorAll('#tbl tr[data-user]'));
      assert.equal(rows.length, 2);
      const t = page.text('#tbl');
      assert.match(t, /管理 太郎.*\(あなた\)/);
      assert.match(t, /店舗スタッフ/);
      assert.match(t, /北見本店/);
      assert.match(t, /全拠点/);
      assert.match(t, /設定済み/);
      assert.match(t, /未設定/);
      assert.match(t, /招待中/);
      assert.match(t, /2026\/09\/22\(火\) 10:30/, '最終ログインが日本時間で出ない');

      // 招待: 入力エラー (画面側)
      page.$('#btn-invite').click();
      assert.ok(visible(page.$('#staff-modal')));
      fill(page, '#sf-email', 'not-an-email');
      submit(page, '#staff-form');
      await waitFor(() => visible(page.$('[data-error-for="email"]')), 1000);
      assert.match(page.text('[data-error-for="email"]'), /メールアドレス/);
      assert.match(page.text('[data-error-for="name"]'), /名前/);
      assert.equal(log.filter(l => l.kind === 'fn' && l.path === '/admin/staff/invite').length, 0, '入力エラーなのに送信した');
      // サーバーの 409 (既にスタッフ)
      db.__inviteError = { status: 409, body: { code: 'CONFLICT', message: 'このメールアドレスは既にスタッフとして登録されています。スタッフ一覧から役割を変更してください。' } };
      fill(page, '#sf-email', 'new-staff@example.com');
      fill(page, '#sf-name', '新人 次郎');
      page.$('#sf-role').value = 'viewer';
      page.$('input[name=locScope][value=some]').checked = true;
      page.$('input[name=locScope][value=some]').dispatchEvent(new w.Event('change', { bubbles: true }));
      page.$('input[name=loc][value=loc-kushiro]').checked = true;
      submit(page, '#staff-form');
      await waitFor(() => visible(page.$('#staff-form-error')), 2000);
      assert.match(page.text('#staff-form-error'), /既にスタッフとして登録されています/);
      // 成功
      db.__inviteError = null;
      submit(page, '#staff-form');
      await waitFor(() => !visible(page.$('#staff-modal')), 2000);
      const inv = log.filter(l => l.kind === 'fn' && l.path === '/admin/staff/invite').pop();
      deq(inv.body, { email: 'new-staff@example.com', name: '新人 次郎', role: 'viewer', locationIds: ['loc-kushiro'] });
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-user]').length === 3, 2000);
      assert.match(page.text('#skyrent-toasts'), /招待メールを送信しました/);

      // 編集: LAST_ADMIN
      page.$('.btn-edit[data-user="' + ADMIN_UID + '"]').click();
      assert.equal(page.$('#sf-email').readOnly, true);
      assert.match(page.text('#staff-modal-note'), /ご自身のアカウント/);
      db.__failRpc.admin_update_staff = 'LAST_ADMIN';
      page.$('input[name=active][value="0"]').checked = true;
      submit(page, '#staff-form');
      await waitFor(() => visible(page.$('#staff-form-error')), 2000);
      assert.match(page.text('#staff-form-error'), /最後の管理者は無効化・役割変更できません/);
      const call = log.filter(l => l.name === 'admin_update_staff').pop();
      deq(call.args, { p_user: ADMIN_UID, p_patch: { active: false } }, '変わった項目だけ送る');
      page.$('[data-close]').click();

      // 編集: 成功 (役割・拠点)
      delete db.__failRpc.admin_update_staff;
      page.$('.btn-edit[data-user="' + OTHER_UID + '"]').click();
      page.$('#sf-role').value = 'maintenance';
      page.$('input[name=locScope][value=all]').checked = true;
      submit(page, '#staff-form');
      await waitFor(() => !visible(page.$('#staff-modal')), 2000);
      deq(log.filter(l => l.name === 'admin_update_staff').pop().args, { p_user: OTHER_UID, p_patch: { role: 'maintenance', location_ids: null } });
      await waitFor(() => /整備担当/.test(page.text('#tbl')), 2000);
      assert.match(page.text('#tbl'), /整備担当/);
      // 表示の絞り込み
      page.$('#f-status').value = 'inactive';
      page.$('#f-status').dispatchEvent(new w.Event('change', { bubbles: true }));
      assert.match(page.text('#tbl'), /該当するスタッフはいません/);
      assertClean(page, 'fake-staff');
    } finally { page.close(); }
  });

  test('staff.html / audit.html: 権限の無い役割には「権限がありません」', async () => {
    for (const path of ['manage/staff.html', 'manage/audit.html']) {
      const db = fakeDb('store_staff');
      const log = [];
      const page = openPage(path, { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
      try {
        assert.equal(await page.ready(8000), true, path);
        assert.match(page.text('.page-notice'), /権限がありません/, path);
        assert.ok(!visible(page.$(path.indexOf('staff') >= 0 ? '#staff-main' : '#audit-main')), path);
        assert.equal(log.filter(l => l.kind === 'fn' || l.table === 'audit_log').length, 0, path + ': 権限が無いのに読みに行った');
        assertClean(page, 'fake-noperm-' + path);
      } finally { page.close(); }
    }
  });

  test('audit.html: 新しい順・差分の表示 (*** は伏せ字)・ページ送り・絞り込み・対象の履歴', async () => {
    const db = fakeDb('admin');
    const log = [];
    const page = openPage('manage/audit.html', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-id]').length === 50, 3000);
      assert.equal(page.document.querySelectorAll('#tbl tr[data-id]').length, 50);
      const q = log.filter(l => l.table === 'audit_log').pop();
      deq(q.orders, [['at', false], ['id', false]], '新しい順に並べていない');
      deq(q.range, [0, 50], '1 件多く取って次ページの有無を見る');
      assert.match(page.text('#audit-main .audit-help'), /個人情報/);
      // 先頭 (staff の変更): 役割・*** ・有効
      await waitFor(() => /管理 太郎/.test(page.text('#tbl tr[data-id="1000"]')), 2000);
      const first = page.$('#tbl tr[data-id="1000"]');
      assert.match(first.textContent, /2026\/09\/22\(火\) 21:00/);
      assert.match(first.textContent, /管理 太郎/);
      assert.match(first.textContent, /スタッフ/);
      assert.match(first.textContent, /変更/);
      assert.match(first.textContent, /役割 → 閲覧のみ/);
      assert.match(first.textContent, /有効 → いいえ/);
      assert.ok(first.querySelector('.masked'), '*** が伏せ字として表示されない');
      assert.match(first.querySelector('.masked').getAttribute('title'), /個人情報/);
      // 追加 (システム): 名前はエスケープされ、項目は日本語
      const ins = page.$('#tbl tr[data-id="999"]');
      assert.match(ins.textContent, /システム/);
      assert.match(ins.textContent, /追加/);
      assert.match(ins.textContent, /状態: 確定/);
      assert.equal(ins.querySelector('b'), null, 'お客様名がエスケープされていない');
      assert.match(ins.textContent, /<b>会員<\/b> 一郎/);
      assert.ok(ins.querySelector('details'), '多い項目は折りたたむ');
      assert.doesNotMatch(ins.textContent, /created_at/);
      // お客様 (会員) の変更
      assert.match(page.text('#tbl tr[data-id="998"]'), /お客様.*会員 M00001/);
      // 削除
      assert.match(page.text('#tbl tr[data-id="997"]'), /削除しました/);

      // ページ送り
      assert.equal(page.$('#pager-top .js-prev').disabled, true);
      assert.equal(page.$('#pager-top .js-next').disabled, false);
      assert.match(page.text('#pager-top'), /1〜50 件目/);
      page.$('#pager-top .js-next').click();
      await waitFor(() => /51〜62 件目/.test(page.text('#pager-top')), 2000);
      assert.match(page.text('#pager-top'), /51〜62 件目/);
      assert.equal(page.$('#pager-top .js-next').disabled, true);
      assert.equal(page.document.querySelectorAll('#tbl tr[data-id]').length, 12);

      // 絞り込み (対象・操作者・操作・期間)
      page.$('#f-table').value = 'reservations';
      page.$('#f-actor').value = '__system';
      page.$('#f-action').value = 'insert';
      page.$('#f-from').value = '2026-09-22';
      page.$('#f-to').value = '2026-09-22';
      submit(page, '#audit-filter');
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-id]').length === 1, 2000);
      const f = log.filter(l => l.table === 'audit_log').pop();
      deq(f.filters, [
        ['table_name', 'eq', 'reservations'], ['action', 'eq', 'insert'], ['actor', 'is', null],
        ['at', 'gte', '2026-09-21T15:00:00.000Z'], ['at', 'lt', '2026-09-22T15:00:00.000Z']
      ]);
      deq(f.range, [0, 50], '絞り込むと 1 ページ目から');
      // 操作者の選択肢にスタッフの名前
      assert.ok(Array.from(page.document.querySelectorAll('#f-actor option')).some(o => o.textContent === '店舗 花子'));
      // 期間の逆転
      page.$('#f-from').value = '2026-09-23';
      submit(page, '#audit-filter');
      await waitFor(() => /期間の終わり/.test(page.text('#tbl')), 2000);
      assert.match(page.text('#tbl'), /期間の終わり/);
      // 条件をクリア → 「履歴」リンクでその対象だけ
      page.$('#btn-clear').click();
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-id]').length === 50, 2000);
      page.$('#tbl tr[data-id="1000"] .js-history').click();
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-id]').length === 1, 2000);
      deq(log.filter(l => l.table === 'audit_log').pop().filters, [['table_name', 'eq', 'staff'], ['row_id', 'eq', OTHER_UID]]);
      assert.equal(page.$('#f-row').value, OTHER_UID);
      deq(businessKeys(w.localStorage), []);
      assertClean(page, 'fake-audit');
    } finally { page.close(); }
  });

  test('audit.html?table=reservations&row=R00110 で開くとその対象から', async () => {
    const db = fakeDb('admin');
    const log = [];
    const page = openPage('manage/audit.html?table=reservations&row=R00110', { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fakeFunctions(db, log) });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-id]').length === 1, 2000);
      deq(log.filter(l => l.table === 'audit_log')[0].filters, [['table_name', 'eq', 'reservations'], ['row_id', 'eq', 'R00110']]);
      assert.ok(page.$('#tbl a[href="reservation-list.html#R00110"]'), '予約一覧へのリンク');
      assertClean(page, 'fake-audit-query');
    } finally { page.close(); }
  });
});

// =====================================================================
// 本番モード (ローカル Supabase + Edge Functions)
// =====================================================================
describe('本番モード (ローカル Supabase)', { skip: NO_JSDOM }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });
  after(async () => { for (const id of createdUsers.splice(0)) await deleteUser(id); });

  test('login.html: パスワード → 二段階認証の登録 (QR・手入力キー) → AAL2 → ?next= へ', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const u = await createUser({ role: 'store_staff', name: 'E1 登録 太郎', prefix: 'enroll' });
    const page = openPage('manage/login.html?next=' + encodeURIComponent('reservation-list.html?x=1'), { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      const w = page.window;
      await waitFor(() => view(page) === 'login', 10000);
      assert.equal(view(page), 'login');
      assert.equal(page.$('#login-email').type, 'email');
      assert.ok(!visible(page.$('#demo-note')));
      // 間違ったパスワード
      fill(page, '#login-email', u.email);
      fill(page, '#login-password', 'Wrong-pass-123');
      submit(page, '#login-form');
      await waitFor(() => page.text('#login-alert'), 10000);
      assert.match(page.text('#login-alert'), /メールアドレスまたはパスワードが正しくありません/);
      // 正しいパスワード → 登録画面
      fill(page, '#login-password', u.password);
      submit(page, '#login-form');
      await waitFor(() => view(page) === 'enroll', 15000);
      assert.equal(view(page), 'enroll');
      assert.equal(page.$('#login-password').value, '', 'パスワードが画面に残っている');
      const src = page.$('#enroll-qr').getAttribute('src') || '';
      assert.match(src, /^data:image\/svg\+xml;charset=utf-8,%3C/, 'QR コードの画像がエンコードされていない');
      assert.ok(!/#/.test(src), 'data URL に # が残っている');
      assert.ok(visible(page.$('#enroll-qr')));
      const secret = page.text('#enroll-secret');
      assert.match(secret, /^[A-Z2-7]{16,}$/, '手入力用のキーが出ない');
      // 間違ったコード
      fill(page, '#enroll-code', '000000');
      submit(page, '#enroll-form');
      await waitFor(() => /確認コードが正しくない/.test(page.text('#login-alert')), 10000);
      assert.match(page.text('#login-alert'), /確認コードが正しくない/);
      assert.equal(view(page), 'enroll');
      // 全角で正しいコード → next へ
      const code = await freshTotp(secret);
      fill(page, '#enroll-code', code.replace(/[0-9]/g, d => String.fromCharCode(d.charCodeAt(0) + 0xFEE0)));
      submit(page, '#enroll-form');
      await waitFor(() => w.SkyRentManageLogin.lastRedirect, 15000);
      assert.equal(w.SkyRentManageLogin.lastRedirect, 'reservation-list.html?x=1');
      const stored = JSON.parse(w.localStorage.getItem(AUTH_KEY));
      assert.equal(jwtPayload(stored.access_token).aal, 'aal2');
      const factors = await api('/auth/v1/admin/users/' + u.userId + '/factors', { service: true });
      assert.equal(factors.filter(f => f.status === 'verified' && f.factor_type === 'totp').length, 1);
      assert.equal(w.sessionStorage.getItem('sky-rent.manageLinkFlow'), null);
      deq(businessKeys(w.localStorage), []);
      assertClean(page, 'live-enroll', true);
    } finally { page.close(); }
  });

  test('login.html: 登録済みなら確認コード → 既定はダッシュボード / 外部の ?next= は無視', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const u = await createUser({ role: 'viewer', name: 'E1 確認 花子', prefix: 'mfa', factor: true });
    const page = openPage('manage/login.html?next=' + encodeURIComponent('https://evil.example.com/steal.html'), { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      fill(page, '#login-email', u.email);
      fill(page, '#login-password', u.password);
      submit(page, '#login-form');
      await waitFor(() => view(page) === 'mfa', 15000);
      assert.equal(view(page), 'mfa');
      assert.ok(!visible(page.$('#mfa-factor-row')), '認証アプリが1つなら選択欄は出さない');
      fill(page, '#mfa-code', await nextCode(u));
      submit(page, '#mfa-form');
      await waitFor(() => page.window.SkyRentManageLogin.lastRedirect, 15000);
      assert.equal(page.window.SkyRentManageLogin.lastRedirect, 'dashboard.html');
      assertClean(page, 'live-mfa', true);
    } finally { page.close(); }

    // ?step=mfa: パスワードだけ済んだ (AAL1) セッションで開くと確認コードの入力から
    const s1 = await passwordSession(u.email, u.password);
    const page2 = openPage('manage/login.html?next=members.html&step=mfa', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(s1) } });
    try {
      assert.equal(await page2.ready(15000), true);
      await waitFor(() => view(page2) === 'mfa', 15000);
      assert.equal(view(page2), 'mfa');
      assert.match(page2.text('#mfa-lead'), /パスワードの確認は済んでいます/);
      fill(page2, '#mfa-code', await nextCode(u));
      submit(page2, '#mfa-form');
      await waitFor(() => page2.window.SkyRentManageLogin.lastRedirect, 15000);
      assert.equal(page2.window.SkyRentManageLogin.lastRedirect, 'members.html');
      assertClean(page2, 'live-step-mfa', true);
    } finally { page2.close(); }

    // AAL2 のまま開いたら「ログインしています」+ 管理画面へ進む
    const page3 = openPage('manage/login.html?next=audit.html', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(u.session) } });
    try {
      assert.equal(await page3.ready(15000), true);
      await waitFor(() => view(page3) === 'signed', 15000);
      assert.equal(page3.text('#signed-name'), 'E1 確認 花子');
      assert.equal(page3.$('#btn-continue').getAttribute('href'), 'audit.html');
      assert.equal(page3.window.SkyRentManageLogin.lastRedirect, null, '勝手に遷移した');
      assertClean(page3, 'live-signed');
    } finally { page3.close(); }
  });

  test('login.html: スタッフでないアカウント / ?error=not_staff / 期限切れリンク', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const u = await createUser({ prefix: 'member' });   // staff 行なし
    const page = openPage('manage/login.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      fill(page, '#login-email', u.email);
      fill(page, '#login-password', u.password);
      submit(page, '#login-form');
      await waitFor(() => page.text('#login-alert'), 15000);
      assert.match(page.text('#login-alert'), /管理画面を利用できません/);
      assert.equal(view(page), 'login');
      assert.equal(page.window.localStorage.getItem(AUTH_KEY), null, 'スタッフでないのにセッションが残っている');
      assertClean(page, 'live-not-staff');
    } finally { page.close(); }

    const page2 = openPage('manage/login.html?next=dashboard.html&error=not_staff', { mode: 'live' });
    try {
      assert.equal(await page2.ready(15000), true);
      await waitFor(() => view(page2) === 'login', 5000);
      assert.match(page2.text('#login-alert'), /管理画面を利用できません/);
      assertClean(page2, 'live-error-param');
    } finally { page2.close(); }

    const page3 = openPage('manage/login.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { mode: 'live' });
    try {
      assert.equal(await page3.ready(15000), true);
      await waitFor(() => view(page3) === 'login', 5000);
      assert.match(page3.text('#login-alert'), /リンクが無効か、有効期限が切れています/);
      assertClean(page3, 'live-expired-link');
    } finally { page3.close(); }

    // ?step=mfa で二段階認証が未登録のスタッフ (AAL1) → 登録画面から
    const s = await createUser({ role: 'maintenance', name: 'E1 未登録', prefix: 'step' });
    const page4 = openPage('manage/login.html?next=vehicles.html&step=mfa', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(await passwordSession(s.email, s.password)) } });
    try {
      assert.equal(await page4.ready(15000), true);
      await waitFor(() => view(page4) === 'enroll', 15000);
      assert.equal(view(page4), 'enroll');
      assert.match(page4.text('#login-info'), /二段階認証を設定してください/);
      // 「最初からやり直す」→ サインアウトしてログイン画面
      page4.$('#enroll-form [data-action="restart"]').click();
      await waitFor(() => view(page4) === 'login' && !page4.window.localStorage.getItem(AUTH_KEY), 10000);
      assert.equal(view(page4), 'login');
      assert.equal(page4.window.localStorage.getItem(AUTH_KEY), null);
      assertClean(page4, 'live-step-enroll');
    } finally { page4.close(); }
  });

  test('login.html: 再設定リンク (二段階認証あり) → 確認コード → 新しいパスワード → 次のページ', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const u = await createUser({ role: 'store_staff', name: 'E1 再設定', prefix: 'recovery', factor: true });
    const link = await linkHash('recovery', u.email);
    const page = openPage('manage/login.html' + link.hash, { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      const w = page.window;
      assert.equal(w.SkyRentBackend.auth.urlEvent().type, 'recovery');
      await waitFor(() => view(page) === 'mfa', 15000);
      assert.equal(view(page), 'mfa');
      assert.match(page.text('#mfa-lead'), /パスワードを再設定する前に/);
      assert.ok(!/access_token/.test(w.location.hash), 'URL にトークンが残っている');
      fill(page, '#mfa-code', await nextCode(u));
      submit(page, '#mfa-form');
      await waitFor(() => view(page) === 'newpw', 15000);
      assert.equal(view(page), 'newpw');
      assert.match(page.text('#newpw-title'), /新しいパスワード/);
      // 弱いパスワード / 不一致
      fill(page, '#newpw-1', 'weakpass');
      fill(page, '#newpw-2', 'weakpass');
      submit(page, '#newpw-form');
      await waitFor(() => page.text('#login-alert'), 3000);
      assert.match(page.text('#login-alert'), /英大文字・英小文字・数字/);
      const newPw = PASSWORD();
      fill(page, '#newpw-1', newPw);
      fill(page, '#newpw-2', newPw + 'x');
      submit(page, '#newpw-form');
      await waitFor(() => /一致しません/.test(page.text('#login-alert')), 3000);
      assert.match(page.text('#login-alert'), /一致しません/);
      fill(page, '#newpw-2', newPw);
      submit(page, '#newpw-form');
      await waitFor(() => w.SkyRentManageLogin.lastRedirect, 15000);
      assert.equal(w.SkyRentManageLogin.lastRedirect, 'dashboard.html');
      // 新しいパスワードでログインできる / 古いパスワードは使えない
      const s = await passwordSession(u.email, newPw);
      assert.ok(s.access_token);
      const old = await api('/auth/v1/token?grant_type=password', { body: { email: u.email, password: u.password }, allowError: true });
      assert.equal(old.status, 400);
      assert.equal(w.sessionStorage.getItem('sky-rent.manageLinkFlow'), null);
      assertClean(page, 'live-recovery', true);
    } finally { page.close(); }
  });

  test('login.html: 招待リンク → パスワード設定 → 二段階認証の登録 → ダッシュボード', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const email = uniq('invite');
    const link = await linkHash('invite', email, { data: { account_type: 'staff', name: 'E1 招待' } });
    createdUsers.push(link.userId);
    await api('/rest/v1/staff', { service: true, body: { user_id: link.userId, name: 'E1 招待', email: email, role: 'viewer', active: true }, headers: { Prefer: 'return=minimal' } });
    const page = openPage('manage/login.html' + link.hash, { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      const w = page.window;
      await waitFor(() => view(page) === 'newpw', 15000);
      assert.equal(view(page), 'newpw');
      assert.match(page.text('#newpw-title'), /はじめてのログイン/);
      assert.equal(w.sessionStorage.getItem('sky-rent.manageLinkFlow'), 'invite');
      const pw = PASSWORD();
      fill(page, '#newpw-1', pw);
      fill(page, '#newpw-2', pw);
      submit(page, '#newpw-form');
      await waitFor(() => view(page) === 'enroll', 15000);
      assert.equal(view(page), 'enroll');
      assert.match(page.text('#login-info'), /パスワードを設定しました/);
      assert.equal(w.sessionStorage.getItem('sky-rent.manageLinkFlow'), null);
      fill(page, '#enroll-code', await freshTotp(page.text('#enroll-secret')));
      submit(page, '#enroll-form');
      await waitFor(() => w.SkyRentManageLogin.lastRedirect, 15000);
      assert.equal(w.SkyRentManageLogin.lastRedirect, 'dashboard.html');
      assert.ok((await passwordSession(email, pw)).access_token, '設定したパスワードでログインできない');
      assertClean(page, 'live-invite', true);
    } finally { page.close(); }
  });

  test('login.html: パスワード再設定メールの戻り先はこのログイン画面', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const page = openPage('manage/login.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      const w = page.window;
      // 実際のメール送信 (Auth のメール送信数の上限を共有している) はせず、呼び出し内容だけ確かめる
      const calls = [];
      w.SkyRentBackend.client.auth.resetPasswordForEmail = async (email, opts) => { calls.push({ email: email, opts: opts }); return { data: {}, error: null }; };
      page.$('[data-action="forgot"]').click();
      fill(page, '#forgot-email', 'bad');
      submit(page, '#forgot-form');
      await waitFor(() => page.text('#login-alert'), 3000);
      assert.match(page.text('#login-alert'), /メールアドレスを正しく/);
      fill(page, '#forgot-email', 'staff-reset@example.com');
      submit(page, '#forgot-form');
      await waitFor(() => page.text('#login-info'), 5000);
      deq(calls, [{ email: 'staff-reset@example.com', opts: { redirectTo: ORIGIN + '/manage/login.html' } }]);
      assert.match(page.text('#login-info'), /登録されている場合は/);
      // 送信回数の上限
      w.SkyRentBackend.client.auth.resetPasswordForEmail = async () => ({ data: null, error: { code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' } });
      submit(page, '#forgot-form');
      await waitFor(() => page.text('#login-alert'), 5000);
      assert.match(page.text('#login-alert'), /短時間に操作が集中/);
      assertClean(page, 'live-forgot');
    } finally { page.close(); }
  });

  test('staff.html / audit.html / partials.js: 二段階認証済みの管理者で一覧・招待・役割変更・操作履歴', async t => {
    if (!up) return t.skip('ローカル Supabase に接続できません');
    const adminUser = await createUser({ role: 'admin', name: 'E1 管理者', prefix: 'admin', factor: true });
    const target = await createUser({ role: 'store_staff', name: 'E1 対象 次郎', prefix: 'target', locationIds: ['loc-kitami'] });
    const page = openPage('manage/staff.html', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(adminUser.session) } });
    let invitedId = null;
    try {
      assert.equal(await page.ready(20000), true, 'skyrent:ready (' + page.window.SkyRentBackend._lastRedirect + ')');
      const w = page.window;
      assert.equal(page.text('#topbar-staff-name'), 'E1 管理者');
      assert.equal(page.text('#topbar-staff-role'), '管理者');
      assert.ok(navHrefs(page).indexOf('audit.html') >= 0);
      await waitFor(() => page.document.querySelectorAll('#tbl tr[data-user]').length >= 3, 15000);
      const rowOf = id => page.$('#tbl tr[data-user="' + id + '"]');
      assert.ok(rowOf(adminUser.userId), '自分の行が無い');
      assert.match(rowOf(adminUser.userId).textContent, /\(あなた\)/);
      assert.match(rowOf(adminUser.userId).textContent, /設定済み/);
      assert.match(rowOf(target.userId).textContent, /店舗スタッフ/);
      assert.match(rowOf(target.userId).textContent, /未設定/);
      assert.match(rowOf(target.userId).textContent, /まだログインしていません/);
      const locName = w.SkyRentStore.getLocation('loc-kitami').name;
      assert.match(rowOf(target.userId).textContent, new RegExp(locName));
      assert.match(page.text('#tbl'), /admin@example\.com/);

      // 役割・拠点・有効の変更 → DB
      rowOf(target.userId).querySelector('.btn-edit').click();
      page.$('#sf-role').value = 'viewer';
      page.$('input[name=locScope][value=all]').checked = true;
      page.$('input[name=active][value="0"]').checked = true;
      submit(page, '#staff-form');
      await waitFor(() => !visible(page.$('#staff-modal')), 10000);
      const row = (await serviceSelect('staff', 'select=role,active,location_ids&user_id=eq.' + target.userId))[0];
      deq(row, { role: 'viewer', active: false, location_ids: null });
      // 無効は既定の表示 (有効なスタッフ) から消える
      await waitFor(() => !rowOf(target.userId), 5000);
      assert.equal(rowOf(target.userId), null);

      // 招待 (本物の招待メール: Mailpit に届く)
      const email = uniq('invited');
      page.$('#btn-invite').click();
      fill(page, '#sf-email', email);
      fill(page, '#sf-name', 'E1 招待 三郎');
      page.$('#sf-role').value = 'accounting';
      submit(page, '#staff-form');
      await waitFor(() => !visible(page.$('#staff-modal')), 20000);
      assert.equal(page.text('#staff-form-error'), '', '招待でエラー: ' + page.text('#staff-form-error'));
      const invited = (await serviceSelect('staff', 'select=user_id,role,active,location_ids&email=eq.' + encodeURIComponent(email)))[0];
      assert.ok(invited, 'staff 行が作られない');
      invitedId = invited.user_id;
      createdUsers.push(invitedId);
      deq({ role: invited.role, active: invited.active, location_ids: invited.location_ids }, { role: 'accounting', active: true, location_ids: null });
      await waitFor(() => rowOf(invitedId), 10000);
      assert.match(rowOf(invitedId).textContent, /招待中/);
      const mail = await waitFor(async () => {
        const r = await fetch('http://127.0.0.1:54324/api/v1/search?query=' + encodeURIComponent('to:' + email)).then(x => x.json()).catch(() => null);
        return r && r.messages && r.messages[0];
      }, 10000, 300);
      assert.ok(mail, '招待メールが届かない');
      const detail = await fetch('http://127.0.0.1:54324/api/v1/message/' + mail.ID).then(x => x.json());
      assert.match(detail.HTML + detail.Text, /manage(%2F|\/)login\.html/, '招待メールの戻り先が管理画面のログインではない');
      // 同じアドレスをもう一度 → 409 の説明
      page.$('#btn-invite').click();
      fill(page, '#sf-email', email);
      fill(page, '#sf-name', 'E1 招待 三郎');
      submit(page, '#staff-form');
      await waitFor(() => visible(page.$('#staff-form-error')), 15000);
      assert.match(page.text('#staff-form-error'), /既にスタッフとして登録されています/);
      page.$('[data-close]').click();
      assertClean(page, 'live-staff');
    } finally { page.close(); }

    // 監査: staff の email を service_role で変える (*** で記録される)
    await api('/rest/v1/staff?user_id=eq.' + target.userId, { service: true, method: 'PATCH', body: { email: 'changed-' + target.email }, headers: { Prefer: 'return=minimal' } });
    const page2 = openPage('manage/audit.html?table=staff&row=' + target.userId, { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(adminUser.session) } });
    try {
      assert.equal(await page2.ready(20000), true);
      await waitFor(() => page2.document.querySelectorAll('#tbl tr[data-id]').length >= 3, 15000);
      // 操作者の名前 (スタッフ一覧) が届いて描き直されるのを待ってから行を読む
      await waitFor(() => /E1 管理者/.test(page2.text('#tbl')), 10000);
      const rows = Array.from(page2.document.querySelectorAll('#tbl tr[data-id]'));
      // 新しい順: email の変更 (システム・***) → 役割の変更 (E1 管理者) → 追加
      assert.match(rows[0].textContent, /システム/);
      assert.ok(rows[0].querySelector('.masked'), 'メールアドレスの変更が *** で出ない');
      const upd = rows.find(r => /役割 → 閲覧のみ/.test(r.textContent));
      assert.ok(upd, '役割の変更の履歴が無い');
      assert.match(upd.textContent, /E1 管理者/);
      assert.match(upd.textContent, /有効 → いいえ/);
      assert.match(upd.textContent, /担当拠点 → \(なし\)/);
      assert.match(rows[rows.length - 1].textContent, /追加/);
      assert.ok(Array.from(page2.document.querySelectorAll('#f-actor option')).some(o => o.value === adminUser.userId), '操作者の選択肢にスタッフが無い');
      // 操作者で絞り込み
      page2.$('#f-actor').value = adminUser.userId;
      submit(page2, '#audit-filter');
      await waitFor(() => page2.document.querySelectorAll('#tbl tr[data-id]').length === 1, 10000);
      assert.match(page2.text('#tbl'), /役割 → 閲覧のみ/);
      assertClean(page2, 'live-audit');
    } finally { page2.close(); }

    // 管理者以外 (AAL2 の閲覧のみ) は操作履歴・スタッフを使えない
    const viewer = await createUser({ role: 'viewer', name: 'E1 閲覧', prefix: 'viewer', factor: true });
    const page3 = openPage('manage/audit.html', { mode: 'live', local: { [AUTH_KEY]: JSON.stringify(viewer.session) } });
    try {
      assert.equal(await page3.ready(20000), true);
      assert.match(page3.text('.page-notice'), /権限がありません/);
      const hrefs = navHrefs(page3);
      assert.ok(hrefs.indexOf('audit.html') < 0 && hrefs.indexOf('staff.html') < 0 && hrefs.indexOf('mail-log.html') < 0);
      assert.ok(hrefs.indexOf('dashboard.html') >= 0);
      assert.equal(page3.text('#topbar-staff-role'), '閲覧のみ');
      assertClean(page3, 'live-viewer');
    } finally { page3.close(); }
  });
});
