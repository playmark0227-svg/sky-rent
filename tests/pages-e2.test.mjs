/**
 * 担当E2: 管理画面の業務ページのテスト
 *   manage/inquiries.html / mail-log.html / calendar.html (新規)
 *   manage/reservation-list.html / members.html / dashboard.html (+ js/manage.js)
 *   manage/site-settings.html / ga-integration.html / high-season.html / contact.html
 *
 * 実行: node --test tests/pages-e2.test.mjs
 *
 *   - デモモード: 各ページを jsdom で開き、主要な操作をして store (localStorage) の結果を確かめる。
 *   - 本番モード (偽クライアント): supabase-js の代わりの偽クライアントと、Edge Functions への fetch の差し替えで、
 *     画面が送る RPC・API の中身とエラー時の表示 (VERSION_CONFLICT・VALIDATION など) を確かめる。
 *   - 本番モード (ローカル Supabase + 起動中の Edge Functions + Google / Resend のモック):
 *     二段階認証済みのスタッフで開き、実際に DB へ届くことを確かめる。起動していなければ skip。
 *     作ったテスト用の行 (予約・問い合わせ・outbox・招待した会員) は最後に消す。
 *     他の担当とぶつからないよう、予約は「今日から 150〜390 日後のランダムな日」に作り、
 *     app_settings (calendar / pricing_rules) は書き換えない (保存の中身は偽クライアントで確かめる)。
 *
 * 外部 CDN にはアクセスしない (supabase-js は node_modules の同じ版を返す。Chart.js は空の代用品)。
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
const SUPABASE_UMD = [ROOT, process.env.SKYRENT_TEST_DEPS]
  .filter(Boolean)
  .map(b => join(b, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'))
  .find(p => existsSync(p)) || null;

const ORIGIN = 'http://localhost:8765';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
const LOCAL_API = 'http://127.0.0.1:54321';
const GOOGLE_MOCK = 'http://127.0.0.1:8979';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const LIVE_CONFIG = { SUPABASE_URL: LOCAL_API, SUPABASE_ANON_KEY: ANON_KEY };
const FAKE_URL = 'http://fake-supabase.invalid';
const FAKE_CONFIG = { SUPABASE_URL: FAKE_URL, SUPABASE_ANON_KEY: 'fake-anon-key' };
const FAKE_FN = FAKE_URL + '/functions/v1';
const CHART_STUB = 'window.Chart = function () { return { destroy: function () {}, update: function () {} }; };';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };
const DAY = 86400000;
const JST = 9 * 3600000;

const NO_JSDOM = jsdom ? false : 'jsdom が見つかりません (npm install を実行してください)';

// =====================================================================
// jsdom でページを開く (tests/frontend-core.test.mjs と同じ仕組み)
// =====================================================================
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
  if (/chart\.js|chart\.umd/i.test(request.url)) return new Response(CHART_STUB, { headers: { 'Content-Type': 'application/javascript' } });
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
 * opts.mode: 'demo' (既定) | 'live' | 'fake'
 * opts.local / opts.session: 事前に入れる storage
 * opts.fakeClient: 偽の supabase クライアント (mode = 'fake')
 * opts.fetch(url, init) → Response|null: window.fetch の差し替え (null なら本物の fetch)
 * opts.confirm: window.confirm の戻り値 (既定 true)
 */
function openPage(path, opts) {
  opts = opts || {};
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
  const file = join(ROOT, path.split(/[?#]/)[0]);
  const html = readFileSync(file, 'utf8');
  const out = { errors: [], consoleErrors: [], warnings: [], resourceErrors: [], notImplemented: [], fetches: [] };
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
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        out.fetches.push({ url: url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null });
        if (opts.fetch) {
          const r = await opts.fetch(url, init || {});
          if (r) return r;
        }
        return globalThis.fetch(input, init);
      };
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.scrollTo = () => {};
      window.confirm = () => (opts.confirm === undefined ? true : opts.confirm);
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
  out.dom = dom;
  out.window = dom.window;
  out.document = dom.window.document;
  out.$ = s => dom.window.document.querySelector(s);
  out.$$ = s => Array.from(dom.window.document.querySelectorAll(s));
  // skyrent:ready の後、遅延スクリプトが登録した DOMContentLoaded (非同期で呼ばれる) の実行を待つ
  out.ready = async ms => {
    const r = await Promise.race([dom.window.__ready, new Promise(res => setTimeout(() => res(false), ms || 8000).unref())]);
    await sleep(40);
    return r;
  };
  out.close = () => { try { dom.window.close(); } catch (e) { /* 無視 */ } };
  out.text = s => { const el = dom.window.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };
  out.click = s => { const el = typeof s === 'string' ? dom.window.document.querySelector(s) : s; assert.ok(el, 'クリックする要素が無い: ' + s); el.click(); };
  out.set = (s, v) => {
    const el = typeof s === 'string' ? dom.window.document.querySelector(s) : s;
    assert.ok(el, '入力する要素が無い: ' + s);
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v; else el.value = v;
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  out.toasts = kind => Array.from(dom.window.document.querySelectorAll('.skyrent-toast' + (kind ? '--' + kind : ''))).map(t => t.textContent);
  return out;
}

function assertClean(page, label) {
  deq(page.errors, [], label + ': JS エラー');
  deq(page.resourceErrors, [], label + ': 読み込めなかったファイル');
  deq(page.consoleErrors, [], label + ': console.error');
  deq(page.notImplemented.filter(m => /navigation/i.test(m)), [], label + ': 想定外の画面遷移');
}
function assertBooted(page, label) {
  assert.equal(page.document.querySelectorAll('script[type="text/x-deferred"]').length, 0, label + ': 未実行の遅延スクリプトが残っている');
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
const lsJson = (page, key) => JSON.parse(page.window.localStorage.getItem('sky-rent.' + key) || 'null');

// 日本時間の 'YYYY-MM-DD' / 日時 → ISO
function jstYmd(ms) { return new Date(ms + JST).toISOString().slice(0, 10); }
function jstIso(ymd, hh) { return new Date(Date.parse(ymd + 'T00:00:00Z') - JST + (hh || 0) * 3600000).toISOString(); }
function jstInput(iso) { return new Date(Date.parse(iso) + JST).toISOString().slice(0, 16); }
const yen = n => '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// =====================================================================
// 偽の supabase クライアント (本番モードの画面ロジック用)
// =====================================================================
function fakeDb() {
  const uid = '11111111-2222-3333-4444-555555555555';
  const memberUid = '99999999-8888-7777-6666-555555555555';
  const tomorrow = jstYmd(Date.now() + DAY);
  const r1 = {
    id: 'R00001', kind: 'rental', asset_id: 'V003', category_id: 'cat-rental', location_id: 'loc-kitami',
    start_at: jstIso(tomorrow, 10), end_at: jstIso(jstYmd(Date.now() + 2 * DAY), 10), status: 'confirmed', user_id: memberUid,
    customer_name: '会員 一郎', customer_kana: '', customer_email: 'm@example.com', customer_phone: '090', company: '',
    license_confirmed: true, payment_method: 'onsite', payment_status: 'unpaid', option_ids: [], options: [],
    price: { base: 17000, total: 17000, lines: [{ code: 'base', label: '基本料金', amount: 17000 }] }, total: 17000,
    discount_type: null, coupon_id: null, invoice_id: null, point_granted: false,
    note: '', staff_note: '', cancel_fee: null, cancelled_at: null, cancelled_by: null, source: 'web', version: 1,
    created_at: '2026-09-20T00:00:00+00:00',
    gcal_events: { pickup: { calendarId: 'a@x.test', eventId: 'ev1' }, return: { calendarId: 'a@x.test', eventId: 'ev2' } }
  };
  const r2 = Object.assign({}, r1, {
    id: 'R00002', asset_id: 'V002', location_id: 'loc-kushiro', customer_name: 'ゲスト 花子', customer_email: 'g@example.com', user_id: null,
    start_at: jstIso(jstYmd(Date.now() + 20 * DAY), 10), end_at: jstIso(jstYmd(Date.now() + 21 * DAY), 10),
    price: { base: 7700, total: 7700, lines: [] }, total: 7700, gcal_events: {}
  });
  return {
    __session: { access_token: 'fake-token', user: { id: uid, email: 'admin@example.com' } },
    __role: 'admin',
    __failRpc: {},
    categories: [{ id: 'cat-rental', name: '一般レンタカー', name_en: '', type: 'vehicle', icon: '🚗', description: '', sort: 1, active: true, custom_field_defs: [], extra: {} }],
    locations: [{ id: 'loc-kitami', name: '北見本店', name_en: '', tel: '', address: '北海道北見市', hours: '', holiday: '', sort: 1, active: true, extra: {} },
                { id: 'loc-kushiro', name: '釧路店', name_en: '', tel: '', address: '北海道釧路市', hours: '', holiday: '', sort: 2, active: true, extra: {} }],
    assets: [{ id: 'V003', category_id: 'cat-rental', location_id: 'loc-kitami', name: 'マツダ CX-5', name_en: '', plate: '', capacity: 5, price_hour: 2200, price_day: 17000, price_week: null, price_month: null, stock: 1, required_license: '', image: '', photo: '', active: true, shaken_date: null, maintenance_date: null, custom_fields: { bodyType: 'SUV' }, sort: 3, extra: {} },
             { id: 'V002', category_id: 'cat-rental', location_id: 'loc-kushiro', name: '日産 ノート e-POWER', name_en: '', plate: '', capacity: 5, price_hour: 1100, price_day: 7700, price_week: null, price_month: null, stock: 1, required_license: '', image: '', photo: '', active: true, shaken_date: null, maintenance_date: null, custom_fields: { bodyType: 'コンパクト' }, sort: 2, extra: {} }],
    options: [],
    app_settings: [
      { key: 'site', value: { shopName: 'グロースレンタカー', siteName: 'サーバーのサイト名' } },
      { key: 'ga', value: { ga4Id: 'G-SERVER1', 'event.purchase': false } },
      { key: 'calendar', value: {
        enabled: true, mode: 'day', handoverMinutes: 45, oneHandoverAtATime: true, writeEvents: true, failOpen: false, customKey: 1,
        locations: { 'loc-kitami': { calendarIds: ['a@x.test', 'b@x.test'], note: 'keep' }, 'loc-kushiro': { calendarIds: ['k@x.test'] }, 'loc-old': { calendarIds: ['z@x.test'] } } } },
      { key: 'pricing_rules', value: { version: 'server-1', busyFee: 999, weekendHolidayFee: 330, busyPeriods: [{ name: 'GW', from: '04-26', to: '05-05' }], cancellation: { noShowPct: 100 }, custom: 'keep' } }
    ],
    app_collections: [],
    legal_documents: [],
    members: [{ user_id: memberUid, member_no: 'M00001', email: 'm@example.com', name: '会員 一郎', name_kana: '', phone: '090', company: '', is_corporate: false, invoice_allowed: false, marketing_opt_in: false, status: 'active', last_use_at: null, created_at: '2026-01-01T00:00:00+00:00' }],
    member_points: [{ user_id: memberUid, points: 3 }],
    coupons: [],
    point_ledger: [],
    reservations: [r1, r2],
    invoices: [],
    inquiries: [
      { id: 'C00001', name: '問合 花子', company: '', email: 'q@example.com', tel: '090-1111-2222', topic: '予約について', body: '本文です\n<img src=x onerror="window.__xss=1">', reservation_id: 'R00001', user_id: null, status: 'new', staff_note: '', assigned_to: null, created_at: '2026-09-21T00:00:00+00:00' },
      { id: 'C00002', name: '完了 太郎', company: '株式会社テスト', email: 'c@example.com', tel: '', topic: 'その他', body: '完了済み', reservation_id: null, user_id: null, status: 'closed', staff_note: '対応済み', assigned_to: null, created_at: '2026-09-01T00:00:00+00:00' }
    ],
    outbox: [
      { id: 11, template: 'reservation_confirmed', to_email: 'yamada.taro@example.com', subject: '【グロースレンタカー】ご予約を承りました', status: 'failed', attempts: 2, last_error: '一時的なエラー (500)', ref_type: 'reservation', ref_id: 'R00001', created_at: '2026-09-22T01:00:00+00:00', sent_at: null, next_attempt_at: '2026-09-22T02:00:00+00:00' },
      { id: 12, template: 'gcal_sync', to_email: 'google-calendar', subject: null, status: 'failed', attempts: 1, last_error: 'このカレンダーを読む権限がありません', ref_type: 'reservation', ref_id: 'R00002', created_at: '2026-09-22T01:00:00+00:00', sent_at: null, next_attempt_at: '2026-09-22T02:00:00+00:00' },
      { id: 13, template: 'inquiry_received', to_email: 'q@example.com', subject: null, status: 'pending', attempts: 0, last_error: null, ref_type: 'inquiry', ref_id: 'C00001', created_at: '2026-09-22T03:00:00+00:00', sent_at: null, next_attempt_at: '2026-09-22T03:00:00+00:00' },
      { id: 14, template: 'coupon_issued', to_email: 'm@example.com', subject: 'クーポン', status: 'skipped', attempts: 1, last_error: 'メール送信サービス未設定', ref_type: 'coupon', ref_id: 'c-1', created_at: '2026-09-22T04:00:00+00:00', sent_at: null, next_attempt_at: '2026-09-22T04:00:00+00:00' }
    ],
    staff: [{ user_id: uid, name: '管理 太郎', email: 'admin@example.com', role: 'admin', active: true, location_ids: null }]
  };
}

// db の特別な項目: __session / __role / __failRpc[name] = 'CODE'
function fakeClient(db, log) {
  const test = (r, f) => {
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
    log.push({ kind: 'from', table: st.table, op: st.op, payload: st.payload, filters: st.filters, opts: st.opts, order: st.order });
    if (st.op === 'select') {
      let rows = (db[st.table] || []).filter(r => st.filters.every(f => test(r, f)));
      if (st.order) rows = rows.slice().sort((a, b) => (a[st.order[0]] < b[st.order[0]] ? -1 : a[st.order[0]] > b[st.order[0]] ? 1 : 0) * (st.order[1] ? 1 : -1));
      const count = rows.length;
      if (st.single) return { data: rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null, error: null };
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.opts && st.opts.head) return { data: null, count: count, error: null };
      return { data: JSON.parse(JSON.stringify(rows)), count: st.opts && st.opts.count ? count : null, error: null };
    }
    if (st.op === 'upsert') {
      const list = Array.isArray(st.payload) ? st.payload : [st.payload];
      if (st.table === 'app_settings') {
        list.forEach(p => {
          const i = db.app_settings.findIndex(x => x.key === p.key);
          if (i >= 0) db.app_settings[i] = p; else db.app_settings.push(p);
        });
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
  function builder(table) {
    const st = { table: table, op: 'select', filters: [], range: null, single: false, payload: null, opts: null, order: null };
    const b = {
      select(cols, o) { if (st.op === 'select') { st.cols = cols; st.opts = o || null; } return b; },
      order(col, o) { if (!st.order) st.order = [col, !o || o.ascending !== false]; return b; },
      range(x, y) { st.range = [x, y]; return b; },
      limit(n) { st.range = [0, n - 1]; return b; },
      eq(col, v) { st.filters.push([col, 'eq', v]); return b; },
      neq(col, v) { st.filters.push([col, 'neq', v]); return b; },
      in(col, vs) { st.filters.push([col, 'in', vs]); return b; },
      ilike(col, v) { st.filters.push([col, 'ilike', v]); return b; },
      maybeSingle() { st.single = true; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = JSON.parse(JSON.stringify(p)); return b; },
      delete() { st.op = 'delete'; return b; },
      then(ok, ng) { return Promise.resolve(exec(st)).then(ok, ng); }
    };
    return b;
  }
  const clone = v => JSON.parse(JSON.stringify(v));
  const rpcs = {
    public_catalog: () => ({ categories: db.categories, locations: db.locations, assets: db.assets, options: db.options, settings: {}, collections: {}, legal: [] }),
    staff_role: () => db.__role,
    admin_recent_activity: () => [
      { at: '2026-09-22T00:00:00+00:00', type: 'reservation', message: '新規予約 R00001 (会員 一郎 様) を受け付けました', ref_id: 'R00001' },
      { at: '2026-09-21T00:00:00+00:00', type: 'inquiry', message: 'お問い合わせ C00001 を受け付けました', ref_id: 'C00001' }
    ],
    admin_update_reservation: a => {
      const r = db.reservations.find(x => x.id === a.p_id);
      if (!r) throw new Error('NOT_FOUND');
      if (a.p_version != null && a.p_version !== r.version) throw new Error('VERSION_CONFLICT');
      const p = a.p_patch || {};
      if (p.status) r.status = p.status;
      if (p.cancel_fee != null) r.cancel_fee = p.cancel_fee;
      if (p.staff_note != null) r.staff_note = p.staff_note;
      if (p.payment_status) r.payment_status = p.payment_status;
      if (p.status === 'cancelled') { r.cancelled_by = 'staff'; r.cancelled_at = new Date().toISOString(); }
      r.version += 1;
      return clone(r);
    },
    admin_create_reservation: a => {
      const asset = db.assets.find(x => x.id === a.p.asset_id);
      const row = Object.assign({}, db.reservations[0], {
        id: 'B' + String(900 + db.reservations.length).padStart(5, '0'), kind: a.p.kind || 'rental',
        asset_id: asset.id, category_id: asset.category_id, location_id: asset.location_id,
        start_at: a.p.start_at, end_at: a.p.end_at, status: 'confirmed', user_id: null,
        customer_name: '', customer_email: '', customer_phone: '', staff_note: a.p.staff_note || '', version: 1, gcal_events: {}, price: {}, total: 0
      });
      db.reservations.push(row);
      return clone(row);
    },
    admin_delete_block: a => {
      const r = db.reservations.find(x => x.id === a.p_id && x.kind === 'block');
      if (!r) throw new Error('NOT_FOUND');
      r.status = 'cancelled';
      return null;
    },
    admin_update_inquiry: a => {
      const q = db.inquiries.find(x => x.id === a.p_id);
      if (!q) throw new Error('NOT_FOUND');
      if (a.p_patch.status) q.status = a.p_patch.status;
      if (a.p_patch.staff_note != null) q.staff_note = a.p_patch.staff_note;
      return clone(q);
    },
    admin_update_member: a => {
      const m = db.members.find(x => x.user_id === a.p_user);
      if (!m) throw new Error('NOT_FOUND');
      Object.keys(a.p_patch || {}).forEach(k => { m[k] = a.p_patch[k]; });
      return clone(m);
    },
    admin_retry_outbox: a => {
      const o = db.outbox.find(x => x.id === a.p_id);
      // DB (20260923000800_outbox_retry_reset.sql) と同じ: 試行回数を 0 に戻して最初から送り直す
      if (o && (o.status === 'failed' || o.status === 'skipped')) { o.status = 'pending'; o.attempts = 0; o.last_error = null; }
      return null;
    }
  };
  return {
    auth: {
      getSession: async () => ({ data: { session: db.__session || null }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' }, error: null }) }
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
const jsonRes = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

// =====================================================================
// デモモード
// =====================================================================
describe('E2 デモモード', { skip: NO_JSDOM }, () => {
  test('calendar.html: 本番接続時の案内・設定の保存 (このブラウザ内)・入力チェック・並べ替え', async () => {
    const page = openPage('manage/calendar.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      assert.match(page.text('#status-body'), /本番接続時に使えます/);
      assert.match(page.text('#mode-note'), /デモ環境/);
      assert.equal(page.$('#f-enabled').checked, false);
      assert.equal(page.$('#f-mode-handover').checked, true);
      assert.equal(page.$('#f-minutes').value, '30');
      assert.equal(page.$('#f-one').checked, true);
      assert.equal(page.$('#f-write').checked, true);
      assert.equal(page.$('#f-failopen').checked, false);
      deq(page.$$('.gc-loc').map(b => b.dataset.loc), ['loc-kitami', 'loc-kushiro']);
      const kitami = page.$('.gc-loc[data-loc="loc-kitami"]');
      assert.equal(kitami.querySelector('[data-empty]').hidden, false, '未登録の案内が出ない');

      // 追加 → 接続テストは本番のみ
      page.click(kitami.querySelector('.gc-add'));
      page.click(kitami.querySelector('.gc-add'));
      let rows = kitami.querySelectorAll('[data-row]');
      assert.equal(rows.length, 2);
      assert.match(rows[0].querySelector('.gc-order').textContent, /書き込み先/);
      page.set(rows[0].querySelector('.gc-id'), '  staff-a@example.com ');
      page.set(rows[1].querySelector('.gc-id'), 'not an id');
      page.click(rows[0].querySelector('.gc-test'));
      assert.match(rows[0].querySelector('.gc-result').textContent, /本番接続時/);
      assert.equal(rows[0].querySelector('.gc-id').value, 'staff-a@example.com', '前後の空白を取り除かない');
      assert.equal(page.$('#dirty-note').hidden, false, '未保存の表示が出ない');

      // 不正な ID は保存しない
      page.click('#btn-save');
      assert.equal(page.$('#save-error').hidden, false);
      assert.match(page.text('#save-error'), /形式が正しくありません/);
      assert.equal(lsJson(page, 'settings.calendar'), null, '不正なまま保存された');

      // 直して並べ替え (2 行目を先頭へ)
      page.set(rows[1].querySelector('.gc-id'), 'staff-b@group.calendar.google.com');
      page.click(rows[1].querySelector('.gc-up'));
      rows = kitami.querySelectorAll('[data-row]');
      assert.equal(rows[0].querySelector('.gc-id').value, 'staff-b@group.calendar.google.com');
      page.set('#f-enabled', true);
      page.set('#f-mode-day', true);
      page.set('#f-minutes', '45');
      page.set('#f-failopen', true);
      assert.equal(page.$('#failopen-warn').hidden, false, 'failOpen の注意が出ない');
      page.click('#btn-save');
      const saved = await waitFor(() => lsJson(page, 'settings.calendar'), 2000);
      deq(saved, {
        enabled: true, mode: 'day', handoverMinutes: 45, oneHandoverAtATime: true, writeEvents: true, failOpen: true,
        locations: { 'loc-kitami': { calendarIds: ['staff-b@group.calendar.google.com', 'staff-a@example.com'] }, 'loc-kushiro': { calendarIds: [] } }
      });
      assert.equal(page.$('#dirty-note').hidden, true);
      assert.ok(page.toasts('success').some(t => /保存しました/.test(t)));

      // 重複
      page.click(kitami.querySelector('.gc-add'));
      rows = kitami.querySelectorAll('[data-row]');
      page.set(rows[2].querySelector('.gc-id'), 'staff-a@example.com');
      page.click('#btn-save');
      assert.match(page.text('#save-error'), /2回登録/);
      // 受け渡し時間の範囲
      page.click(rows[2].querySelector('.gc-del'));
      page.set('#f-minutes', '2000');
      page.click('#btn-save');
      assert.match(page.text('#save-error'), /0〜1440/);
      assertBooted(page, 'calendar');
      assertClean(page, 'calendar');
      assert.equal(w.SkyRentBackend.live, false);
    } finally { page.close(); }
  });

  test('mail-log.html: 本番接続時に使えます (壊れない)', async () => {
    const page = openPage('manage/mail-log.html');
    try {
      assert.equal(await page.ready(8000), true);
      assert.match(page.text('#alerts'), /本番接続時に使えます/);
      assert.ok(page.$('#alerts a[href*="setup.md"]'), '手順書へのリンクが無い');
      assert.equal(page.$('#btn-process').disabled, true);
      assertBooted(page, 'mail-log');
      assertClean(page, 'mail-log');
    } finally { page.close(); }
  });

  test('inquiries.html: タブ・本文はエスケープ・状態とメモの更新 (store)', async () => {
    const inquiries = [
      { inquiryId: 'C0002', name: '山田 花子', company: '', email: 'h@example.com', tel: '090-1234-5678', topic: '予約について', body: '1行目\n<script>window.__xss=1</script><img src=x onerror="window.__xss=2">', reservationId: 'R0001', status: 'new', staffNote: '', createdAt: '2026-09-22T01:00:00.000Z' },
      { inquiryId: 'C0001', name: '完了 太郎', company: '株式会社テスト', email: 'c@example.com', tel: '', topic: 'その他', body: '完了済み', reservationId: null, status: 'closed', staffNote: '回答済み', createdAt: '2026-09-01T01:00:00.000Z' }
    ];
    const page = openPage('manage/inquiries.html', { local: { 'sky-rent.inquiries': JSON.stringify(inquiries) } });
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      assert.match(page.text('#mode-note'), /デモ環境/);
      assert.equal(page.text('#n-new'), '1');
      assert.equal(page.text('#n-in_progress'), '0');
      assert.equal(page.text('#n-closed'), '1');
      assert.equal(page.$$('#tbl tr[data-id]').length, 1);
      assert.ok(page.$('#tbl a[href="reservation-list.html#R0001"]'), '関連予約のリンクが無い');
      page.click('#tbl tr[data-id="C0002"] td');
      assert.equal(page.$('#iq-body').textContent, inquiries[0].body, '本文がそのまま表示されない');
      assert.equal(page.$$('#detail script, #detail img').length, 0, '本文が HTML として解釈された');
      assert.equal(w.__xss, undefined);
      assert.ok(page.$('#detail a[href="mailto:h@example.com"]'));
      assert.ok(page.$('#detail a[href="tel:09012345678"]'));
      // 対応を始める → 対応中タブへ
      page.set('#iq-note', '電話で折り返し予定');
      page.click('#iq-start');
      await waitFor(() => page.text('#n-in_progress') === '1', 2000);
      const saved = lsJson(page, 'inquiries').find(q => q.inquiryId === 'C0002');
      assert.equal(saved.status, 'in_progress');
      assert.equal(saved.staffNote, '電話で折り返し予定');
      assert.equal(page.$('[data-tab="in_progress"]').getAttribute('aria-selected'), 'true');
      assert.match(page.text('#iq-msg'), /保存しました/);
      // 完了タブ・キーワード
      page.click('[data-tab="closed"]');
      page.set('#kw', 'テスト');
      assert.equal(page.$$('#tbl tr[data-id]').length, 1);
      page.set('#kw', '該当なしの語');
      assert.match(page.text('#tbl'), /該当するお問い合わせはありません/);
      assertBooted(page, 'inquiries');
      assertClean(page, 'inquiries');
    } finally { page.close(); }
  });

  test('inquiries.html#C0001 で直接開く', async () => {
    const inquiries = [{ inquiryId: 'C0001', name: '完了 太郎', company: '', email: 'c@example.com', tel: '', topic: 'その他', body: '本文', reservationId: null, status: 'closed', staffNote: '', createdAt: '2026-09-01T01:00:00.000Z' }];
    const page = openPage('manage/inquiries.html#C0001', { local: { 'sky-rent.inquiries': JSON.stringify(inquiries) } });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$('#iq-body'), 2000);
      assert.equal(page.$('[data-tab="closed"]').getAttribute('aria-selected'), 'true');
      assert.equal(page.$('#iq-body').textContent, '本文');
      assertClean(page, 'inquiries-hash');
    } finally { page.close(); }
  });

  test('reservation-list.html: キャンセル料を示して減額・免除 / 無断キャンセル / 貸出停止枠の登録・解除', async () => {
    const page = openPage('manage/reservation-list.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore, P = w.SkyRentPricing;
      await waitFor(() => page.$$('#tbl tr:not(.empty)').length, 3000);
      const future = S.list('reservations').filter(r => r.status === 'confirmed' && Date.parse(r.start) > Date.now());
      assert.ok(future.length >= 2, '未来の確定予約がシードに無い');
      const r1 = future[0], r2 = future[1];

      // --- キャンセル (免除 + 理由) ---
      page.click(page.$('#tbl .detail-link[data-id="' + r1.reservationId + '"]'));
      assert.ok(page.$('#crud-modal #act-cancel'), 'キャンセルのボタンが無い');
      assert.match(page.text('#rd-gcal'), /連携していません/);
      page.click('#act-cancel');
      const rule = P.cancellationFee({ reservation: r1 });
      assert.equal(page.text('#rd-rule'), yen(rule.fee));
      assert.equal(page.$('#rd-fee').value, String(rule.fee));
      page.click(page.$('#rd-panel [data-fee="0"]'));
      assert.equal(page.$('#rd-fee').value, '0');
      if (rule.fee !== 0) {
        page.click('#rd-confirm');
        assert.equal(page.$('#rd-fee-err').hidden, false, '理由なしで規定と違う金額を確定できた');
        assert.match(page.text('#rd-fee-err'), /理由/);
      }
      page.set('#rd-fee', '-5');
      page.click('#rd-confirm');
      assert.match(page.text('#rd-fee-err'), /0 円以上/);
      page.set('#rd-fee', '0');
      page.set('#rd-reason', 'テスト免除');
      page.click('#rd-confirm');
      await waitFor(() => !page.$('#crud-modal'), 2000);
      let after1 = S.findById('reservations', 'reservationId', r1.reservationId);
      assert.equal(after1.status, 'cancelled');
      assert.equal(after1.cancelFee, 0);
      assert.equal(after1.cancelledBy, 'staff');
      if (rule.fee !== 0) assert.match(after1.staffNote, /理由: テスト免除/);
      assert.ok(page.toasts('success').some(t => /キャンセルにしました/.test(t)));

      // --- 無断キャンセル (規定どおり = 100%) ---
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + r2.reservationId + '"]'), 2000);
      page.click(page.$('#tbl .detail-link[data-id="' + r2.reservationId + '"]'));
      page.click('#act-noshow');
      const ns = P.cancellationFee({ reservation: r2, noShow: true });
      assert.equal(ns.pct, 100);
      assert.equal(page.$('#rd-fee').value, String(ns.fee));
      assert.equal(page.$('#rd-notify'), null, '無断キャンセルでメールの選択肢が出た');
      page.click('#rd-confirm');
      await waitFor(() => !page.$('#crud-modal'), 2000);
      const after2 = S.findById('reservations', 'reservationId', r2.reservationId);
      assert.equal(after2.status, 'no_show');
      assert.equal(after2.cancelFee, ns.fee);
      assert.equal(after2.staffNote || '', r2.staffNote || '', '規定どおりなのにメモが増えた');
      await sleep(200);  // 一覧の読み直し (SkyRentAPI.listReservations) を待つ
      page.set('#status-filter', 'no_show');
      await waitFor(() => /無断キャンセル/.test(page.text('#tbl')), 2000);
      assert.match(page.text('#tbl'), /無断キャンセル/);
      // 無断キャンセル → 確定に戻す
      page.click(page.$('#tbl .detail-link[data-id="' + r2.reservationId + '"]'));
      page.click('#act-restore');
      await waitFor(() => S.findById('reservations', 'reservationId', r2.reservationId).status === 'confirmed', 2000);
      assert.equal(S.findById('reservations', 'reservationId', r2.reservationId).status, 'confirmed');
      page.set('#status-filter', '');

      // --- 貸出停止枠 ---
      assert.equal(page.$('#btn-block').hidden, false);
      page.click('#btn-block');
      assert.ok(page.$('#bk-asset'));
      const d = jstYmd(Date.now() + 200 * DAY);
      page.set('#bk-asset', 'V005');
      page.set('#bk-start', d + 'T18:00');
      page.set('#bk-end', d + 'T09:00');
      page.click('#bk-save');
      assert.match(page.text('#bk-err'), /終了は開始より後/);
      page.set('#bk-start', d + 'T09:00');
      page.set('#bk-end', d + 'T18:00');
      page.set('#bk-reason', '車検');
      page.set('#bk-memo', '北見の整備工場');
      page.click('#bk-save');
      await waitFor(() => !page.$('#crud-modal'), 2000);
      const block = S.list('reservations').find(r => r.kind === 'block' && r.assetId === 'V005');
      assert.ok(block, '停止枠が登録されない');
      assert.equal(block.start, jstIso(d, 9));
      assert.equal(block.end, jstIso(d, 18));
      assert.equal(block.staffNote, '車検 — 北見の整備工場');
      page.set('#kind-filter', 'block');
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + block.reservationId + '"]'), 2000);
      assert.match(page.text('#tbl'), /貸出停止枠/);
      assert.match(page.text('#tbl'), /停止中/);
      // 重なる停止枠は登録できない
      page.click('#btn-block');
      page.set('#bk-asset', 'V005');
      page.set('#bk-start', d + 'T12:00');
      page.set('#bk-end', d + 'T20:00');
      page.click('#bk-save');
      await waitFor(() => !page.$('#bk-err').hidden, 2000);
      assert.match(page.text('#bk-err'), /予約または別の停止枠が入っている/);
      page.click('#crud-modal .crud-cancel');
      // 解除
      page.click(page.$('#tbl .detail-link[data-id="' + block.reservationId + '"]'));
      page.click('#act-unblock');
      await waitFor(() => S.findById('reservations', 'reservationId', block.reservationId).status === 'cancelled', 2000);
      assert.equal(S.findById('reservations', 'reservationId', block.reservationId).status, 'cancelled');
      await waitFor(() => /解除済み/.test(page.text('#tbl')), 2000);
      assert.match(page.text('#tbl'), /解除済み/);
      assertBooted(page, 'reservation-list');
      assertClean(page, 'reservation-list');
    } finally { page.close(); }
  });

  test('members.html: デモは「会員追加」(直接登録) のまま', async () => {
    const page = openPage('manage/members.html');
    try {
      assert.equal(await page.ready(8000), true);
      assert.equal(page.text('#btn-add'), '+ 会員追加');
      assert.match(page.text('#mode-note'), /デモ環境/);
      page.click('#btn-add');
      page.set('#m-name', 'デモ 追加');
      page.set('#m-email', 'demo-add@example.com');
      page.click('#m-save');
      assert.ok(page.window.SkyRentStore.findMemberByEmail('demo-add@example.com'));
      assert.match(page.text('#tbl'), /demo-add@example.com/);
      assertClean(page, 'members');
    } finally { page.close(); }
  });

  test('dashboard.html: 未対応のお問い合わせ件数・送信失敗は本番のみ・最近の動き', async () => {
    const inquiries = [
      { inquiryId: 'C0003', name: 'a', email: 'a@example.com', topic: 't', body: 'b', status: 'new', createdAt: '2026-09-22T01:00:00.000Z' },
      { inquiryId: 'C0002', name: 'b', email: 'b@example.com', topic: 't', body: 'b', status: 'new', createdAt: '2026-09-21T01:00:00.000Z' },
      { inquiryId: 'C0001', name: 'c', email: 'c@example.com', topic: 't', body: 'b', status: 'closed', createdAt: '2026-09-20T01:00:00.000Z' }
    ];
    const page = openPage('manage/dashboard.html', { local: { 'sky-rent.inquiries': JSON.stringify(inquiries) } });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.text('#n-inquiries') === '2', 3000);
      assert.equal(page.text('#n-inquiries'), '2');
      assert.ok(page.$('#todo-inquiries').classList.contains('is-alert'));
      assert.equal(page.text('#n-mail-failed'), '-');
      assert.match(page.text('#todo-note'), /本番接続時/);
      assert.match(page.text('.bottom-row'), /最近の動き/);
      await waitFor(() => page.$$('#notif-list li a').length, 3000);
      assert.ok(page.$('#notif-list a[href^="reservation-list.html#"]'), '最近の動きから予約へのリンクが無い');
      // 日付は日本時間の今日
      const today = jstYmd(Date.now()).split('-').map(Number);
      deq([+page.$('#date-y').value, +page.$('#date-m').value, +page.$('#date-d').value], today);
      page.click('#date-next');
      const tomorrow = jstYmd(Date.now() + DAY).split('-').map(Number);
      deq([+page.$('#date-y').value, +page.$('#date-m').value, +page.$('#date-d').value], tomorrow);
      assertBooted(page, 'dashboard');
      assertClean(page, 'dashboard');
    } finally { page.close(); }
  });

  test('site-settings.html: 保存済みの値を既定値で上書きしない・料金/キャンセルは料金表で決まると明記', async () => {
    const page = openPage('manage/site-settings.html', {
      local: { 'sky-rent.settings.site': JSON.stringify({ siteName: '保存済みの名前', themeColor: '#123456', shopName: 'サーバー側で使う値', 'cancel.7days': false }) }
    });
    try {
      assert.equal(await page.ready(8000), true);
      assert.equal(page.$('[data-setting="siteName"]').value, '保存済みの名前');
      assert.equal(page.$('[data-setting="themeColor"]').value, '#123456');
      assert.equal(page.$('[data-setting="siteUrl"]').value, 'https://playmark0227-svg.github.io/sky-rent/', '未保存の項目は既定値');
      assert.equal(page.$$('[data-setting^="cancel."], [data-setting^="pay."], [data-setting^="notify."]').length, 0, '料金に効かない項目が残っている');
      assert.match(page.text('main'), /料金・キャンセル規定は総合料金表 \(pricing_rules\) で決まります/);
      assert.match(page.text('#cancel-rules'), /3日前まで: 無料/);
      assert.match(page.text('#cancel-rules'), /14日前まで: 無料/);
      assert.match(page.text('#cancel-rules'), /無断キャンセル: 100%/);
      page.set('[data-setting="siteName"]', '新しい名前');
      page.click('[data-save]');
      const saved = lsJson(page, 'settings.site');
      assert.equal(saved.siteName, '新しい名前');
      assert.equal(saved.shopName, 'サーバー側で使う値');
      assert.equal(saved['cancel.7days'], false, 'フォームに無い項目が消えた');
      assertBooted(page, 'site-settings');
      assertClean(page, 'site-settings');
    } finally { page.close(); }
  });

  test('ga-integration.html: 既定値 (計測 ON) は未保存のときだけ・保存済みの OFF を上書きしない', async () => {
    const p1 = openPage('manage/ga-integration.html');
    try {
      assert.equal(await p1.ready(8000), true);
      assert.equal(p1.$('[data-setting="event.purchase"]').checked, true);
      assert.equal(p1.$('[data-setting="event.viewItem"]').checked, true);
      assert.equal(p1.$('[data-setting="event.search"]').checked, false);
      assertClean(p1, 'ga-default');
    } finally { p1.close(); }
    const p2 = openPage('manage/ga-integration.html', { local: { 'sky-rent.settings.ga': JSON.stringify({ ga4Id: 'G-SAVED', 'event.purchase': false }) } });
    try {
      assert.equal(await p2.ready(8000), true);
      assert.equal(p2.$('[data-setting="ga4Id"]').value, 'G-SAVED');
      assert.equal(p2.$('[data-setting="event.purchase"]').checked, false, '保存済みの OFF が既定値で上書きされた');
      assert.equal(p2.$('[data-setting="event.viewItem"]').checked, true);
      assertClean(p2, 'ga-saved');
    } finally { p2.close(); }
  });

  test('high-season.html: 繁忙期は pricing_rules.busyPeriods / 追加して保存すると料金に反映', async () => {
    const page = openPage('manage/high-season.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      assert.match(page.text('main'), /pricing_rules/);
      assert.equal(page.$$('#tbl [data-row]').length, 2);
      deq(page.$$('#tbl .hs-name').map(i => i.value), ['ゴールデンウィーク', '年末年始']);
      assert.match(page.text('#tbl'), /〜/);
      assert.match(page.text('#effects'), /¥550/);
      // 追加 (名前なし → エラー)
      page.click('#btn-add');
      assert.equal(page.$('#dirty').hidden, false);
      page.click('#btn-save');
      assert.match(page.text('#err'), /名称を入力/);
      const row = page.$$('#tbl [data-row]')[2];
      page.set(row.querySelector('.hs-name'), 'お盆');
      page.set(row.querySelector('.hs-from-m'), '8');
      page.set(row.querySelector('.hs-from-d'), '13');
      page.set(row.querySelector('.hs-to-m'), '8');
      page.set(row.querySelector('.hs-to-d'), '16');
      // 2/30 はエラー
      page.set(page.$$('#tbl [data-row]')[0].querySelector('.hs-to-m'), '2');
      page.set(page.$$('#tbl [data-row]')[0].querySelector('.hs-to-d'), '30');
      page.click('#btn-save');
      assert.match(page.text('#err'), /終了日 \(2月30日\) がありません/);
      page.set(page.$$('#tbl [data-row]')[0].querySelector('.hs-to-m'), '5');
      page.set(page.$$('#tbl [data-row]')[0].querySelector('.hs-to-d'), '5');
      page.click('#btn-save');
      await waitFor(() => lsJson(page, 'settings.pricing_rules'), 2000);
      const rules = lsJson(page, 'settings.pricing_rules');
      deq(rules.busyPeriods, [
        { name: 'ゴールデンウィーク', from: '04-26', to: '05-05' }, { name: '年末年始', from: '12-29', to: '01-03' }, { name: 'お盆', from: '08-13', to: '08-16' }
      ]);
      assert.equal(rules.busyFee, 550, '他の項目が消えた');
      assert.ok(rules.cancellation && rules.cancellation.normal, 'キャンセル規定が消えた');
      // 料金計算に反映 (8/14 は繁忙期)
      const y = new Date().getUTCFullYear() + 1;
      const q = w.SkyRentPricing.quote({ assetId: 'V001', start: y + '-08-14T10:00', end: y + '-08-15T10:00' });
      assert.equal(q.busy, true, '保存した繁忙期が料金に反映されない');
      assert.ok(page.toasts('success').length);
      assertBooted(page, 'high-season');
      assertClean(page, 'high-season');
    } finally { page.close(); }
  });

  test('contact.html: 送信フォームをやめ、手順書と連絡先の案内だけ', async () => {
    const page = openPage('manage/contact.html');
    try {
      assert.equal(await page.ready(8000), true);
      assert.equal(page.$$('form, textarea, input').length, 0, 'フォームが残っている');
      assert.ok(page.$('a[href$="docs/production/setup.md"]'), '手順書へのリンクが無い');
      assert.ok(page.$('a[href="mail-log.html"]'));
      assert.ok(page.$('a[href="calendar.html"]'));
      assert.ok(page.$('a[href="https://lin.ee/PuLt0Ig"]'));
      assert.equal(page.window.localStorage.getItem('sky-rent.contact-log'), null);
      assertBooted(page, 'contact');
      assertClean(page, 'contact');
    } finally { page.close(); }
  });
});

// =====================================================================
// 本番モード (偽クライアント)
// =====================================================================
describe('E2 本番モード (偽クライアント)', { skip: NO_JSDOM }, () => {
  function fakePage(path, db, log, fetchFn) {
    return openPage(path, { mode: 'fake', fakeClient: fakeClient(db, log), fetch: fetchFn || (() => null) });
  }
  const rpcs = (log, name) => log.filter(l => l.kind === 'rpc' && l.name === name);

  test('calendar.html: サーバーの設定を表示・状態一覧 (freeBusyOnly の注意)・接続テスト・保存は画面に無い項目を残す', async () => {
    const db = fakeDb();
    const log = [];
    const status = {
      ok: true, configured: true, serviceAccountEmail: 'skyrent-calendar@proj.iam.gserviceaccount.com', enabled: true, mode: 'day',
      locations: {
        'loc-kitami': [{ calendarId: 'a@x.test', access: 'events' }, { calendarId: 'b@x.test', access: 'freeBusyOnly' }],
        'loc-kushiro': [{ calendarId: 'k@x.test', access: 'events' }],
        'loc-old': [{ calendarId: 'z@x.test', access: 'none', error: 'カレンダーが見つからないか、サービスアカウントに共有されていません' }]
      }
    };
    const page = fakePage('manage/calendar.html', db, log, async (url, init) => {
      if (url === FAKE_FN + '/admin/calendar/status') return jsonRes(status);
      if (url === FAKE_FN + '/admin/calendar/test') {
        const id = JSON.parse(init.body).calendarId;
        if (id === 'new@x.test') return jsonRes({ ok: true, configured: true, calendarId: id, access: 'events', busyCount: 3 });
        return jsonRes({ ok: true, configured: true, calendarId: id, access: 'freeBusyOnly', busyCount: 1 });
      }
      return null;
    });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$('#sa-email'), 3000);
      assert.equal(page.$('#sa-email').value, 'skyrent-calendar@proj.iam.gserviceaccount.com');
      assert.match(page.text('#status-body'), /鍵 \(サービスアカウント\) が登録されています/);
      assert.match(page.text('#status-body'), /予定の変更/);
      assert.equal(page.$$('#status-table tbody tr').length, 4);
      const fbRow = page.$('#status-table tr[data-status-cal="b@x.test"]');
      assert.match(fbRow.textContent, /freeBusyOnly/);
      assert.match(fbRow.textContent, /終日の「休み」が反映されず/);
      assert.match(page.text('#status-table tr[data-status-cal="z@x.test"]'), /接続できません/);
      assert.match(page.text('#status-body'), /確認が必要なカレンダーが 2 件/);
      // 認証ヘッダ付きで GET
      const st = page.fetches.find(f => f.url === FAKE_FN + '/admin/calendar/status');
      assert.equal(st.method, 'GET');
      assert.equal(st.headers.Authorization, 'Bearer fake-token');

      // フォームはサーバーの値
      assert.equal(page.$('#f-enabled').checked, true);
      assert.equal(page.$('#f-mode-day').checked, true);
      assert.equal(page.$('#f-minutes').value, '45');
      deq(page.$$('.gc-loc').map(b => b.dataset.loc), ['loc-kitami', 'loc-kushiro', 'loc-old']);
      assert.match(page.text('.gc-loc[data-loc="loc-old"] h3'), /拠点一覧に無い ID/);
      const kitami = page.$('.gc-loc[data-loc="loc-kitami"]');
      deq(Array.from(kitami.querySelectorAll('.gc-id')).map(i => i.value), ['a@x.test', 'b@x.test']);

      // 接続テスト (b@x.test を先頭にして、書き込めない注意)
      let rows = kitami.querySelectorAll('[data-row]');
      page.click(rows[1].querySelector('.gc-up'));
      rows = kitami.querySelectorAll('[data-row]');
      page.click(rows[0].querySelector('.gc-test'));
      await waitFor(() => /freeBusyOnly/.test(rows[0].querySelector('.gc-result').textContent), 2000);
      assert.match(rows[0].querySelector('.gc-result').textContent, /書き込み先\) なので、予約が書き込まれません/);
      const testCall = page.fetches.find(f => f.url === FAKE_FN + '/admin/calendar/test');
      deq(testCall.body, { calendarId: 'b@x.test' });
      // 追加した行のテスト
      page.click(kitami.querySelector('.gc-add'));
      rows = kitami.querySelectorAll('[data-row]');
      page.set(rows[2].querySelector('.gc-id'), 'new@x.test');
      page.click(rows[2].querySelector('.gc-test'));
      await waitFor(() => /events/.test(rows[2].querySelector('.gc-result').textContent), 2000);
      assert.match(rows[2].querySelector('.gc-result').textContent, /予定あり」: 3 件/);

      // 保存: a@x.test を削除、受け渡し 60 分、loc-old は消さない・customKey / note は残す
      page.click(rows[1].querySelector('.gc-del'));
      page.set('#f-minutes', '60');
      page.set('#f-mode-handover', true);
      page.click('#btn-save');
      await waitFor(() => log.some(l => l.table === 'app_settings' && l.op === 'upsert'), 2000);
      const up = log.find(l => l.table === 'app_settings' && l.op === 'upsert');
      deq(up.payload, {
        key: 'calendar',
        value: {
          enabled: true, mode: 'handover', handoverMinutes: 60, oneHandoverAtATime: true, writeEvents: true, failOpen: false, customKey: 1,
          locations: {
            'loc-kitami': { calendarIds: ['b@x.test', 'new@x.test'], note: 'keep' },
            'loc-kushiro': { calendarIds: ['k@x.test'] },
            'loc-old': { calendarIds: ['z@x.test'] }
          }
        }
      });
      await waitFor(() => page.toasts('success').length, 2000);
      // 保存後に状態を取り直す
      await waitFor(() => page.fetches.filter(f => f.url === FAKE_FN + '/admin/calendar/status').length >= 2, 2000);
      assert.equal(page.window.SkyRentStore.read('settings.calendar').handoverMinutes, 60);
      deq(businessKeys(page.window.localStorage), []);
      assertClean(page, 'fake-calendar');
    } finally { page.close(); }
  });

  test('calendar.html: 鍵が未設定 / 権限の無いスタッフは閲覧のみ', async () => {
    const db = fakeDb();
    const page = fakePage('manage/calendar.html', db, [], async url => {
      if (url === FAKE_FN + '/admin/calendar/status') return jsonRes({ ok: true, configured: false, serviceAccountEmail: null, enabled: false, mode: 'handover', locations: {}, error: 'GOOGLE_SERVICE_ACCOUNT_JSON が設定されていません' });
      return null;
    });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => /未設定/.test(page.text('#status-body')), 3000);
      assert.match(page.text('#status-body'), /GOOGLE_SERVICE_ACCOUNT_JSON/);
      assertClean(page, 'fake-calendar-noconf');
    } finally { page.close(); }

    const db2 = fakeDb();
    db2.__role = 'store_staff';
    const page2 = fakePage('manage/calendar.html', db2, [], async () => { throw new Error('呼ばれてはいけない'); });
    try {
      assert.equal(await page2.ready(8000), true);
      assert.match(page2.text('#status-body'), /管理者\) だけが行えます/);
      assert.equal(page2.$('#cal-fieldset').disabled, true);
      assert.equal(page2.$('#btn-save').disabled, true);
      assert.equal(page2.fetches.filter(f => /calendar/.test(f.url)).length, 0);
      assertClean(page2, 'fake-calendar-viewer');
    } finally { page2.close(); }
  });

  test('reservation-list.html: キャンセル料の減額 (cancel_fee・理由・通知なし を patch へ) / VERSION_CONFLICT は再読み込みを促す / 停止枠 / カレンダー同期の状態', async () => {
    const db = fakeDb();
    const log = [];
    db.app_settings = db.app_settings.filter(s => s.key !== 'pricing_rules');  // 既定の料金ルールで計算
    const page = fakePage('manage/reservation-list.html', db, log);
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore, P = w.SkyRentPricing;
      await waitFor(() => page.$('#tbl .detail-link[data-id="R00001"]'), 3000);

      // R00001 (明日の貸出 = 前日 30%)
      page.click(page.$('#tbl .detail-link[data-id="R00001"]'));
      assert.match(page.text('#rd-gcal'), /登録済み/);
      assert.match(page.text('#rd-gcal'), /a@x\.test/);
      page.click('#act-cancel');
      const r1 = S.findById('reservations', 'reservationId', 'R00001');
      const fee = P.cancellationFee({ reservation: r1 });
      assert.equal(fee.pct, 30);
      assert.equal(fee.fee, 5100);
      assert.equal(page.text('#rd-rule'), '¥5,100');
      page.set('#rd-fee', '1000');
      page.click('#rd-confirm');
      assert.match(page.text('#rd-fee-err'), /理由を入力/);
      page.set('#rd-reason', '常連のため減額');
      page.set('#rd-notify', false);
      page.click('#rd-confirm');
      await waitFor(() => rpcs(log, 'admin_update_reservation').length, 2000);
      const call = rpcs(log, 'admin_update_reservation')[0];
      assert.equal(call.args.p_id, 'R00001');
      assert.equal(call.args.p_version, 1);
      assert.equal(call.args.p_patch.status, 'cancelled');
      assert.equal(call.args.p_patch.cancel_fee, 1000);
      assert.equal(call.args.p_patch.notify, false);
      assert.match(call.args.p_patch.staff_note, /【キャンセル料】¥1,000 \(規定 ¥5,100\) 理由: 常連のため減額/);
      assert.match(call.args.p_patch.staff_note, /管理 太郎/);
      await waitFor(() => !page.$('#crud-modal'), 2000);
      const after = S.findById('reservations', 'reservationId', 'R00001');
      assert.equal(after.status, 'cancelled');
      assert.equal(after.version, 2, 'サーバーの結果で置き換わらない');
      assert.equal(after.cancelFee, 1000);
      assert.ok(page.toasts('success').some(t => /キャンセルにしました \(キャンセル料 ¥1,000\)/.test(t)));

      // R00002: カレンダー同期は未登録 + 最新の同期処理 (失敗)
      await waitFor(() => page.$('#tbl .detail-link[data-id="R00002"]'), 2000);
      page.click(page.$('#tbl .detail-link[data-id="R00002"]'));
      assert.match(page.text('#rd-gcal'), /未登録/);
      await waitFor(() => /最新の同期処理/.test(page.text('#rd-gcal')), 2000);
      assert.match(page.text('#rd-gcal'), /失敗 \(このカレンダーを読む権限がありません\)/);
      assert.ok(page.$('#rd-gcal a[href="mail-log.html?kind=gcal&q=R00002"]'));
      // 他のスタッフが先に更新 → VERSION_CONFLICT
      db.__failRpc.admin_update_reservation = 'VERSION_CONFLICT';
      page.click('#act-inuse');
      await waitFor(() => !page.$('#rd-msg').hidden, 2000);
      assert.match(page.text('#rd-msg'), /他のスタッフが先にこのデータを更新しました/);
      assert.ok(page.$('#rd-reload'), '再読み込みのボタンが無い');
      assert.equal(page.$('#act-inuse').disabled, false, 'ボタンが押せないまま');
      assert.equal(S.findById('reservations', 'reservationId', 'R00002').status, 'confirmed', '失敗したのに画面の状態が変わった');
      delete db.__failRpc.admin_update_reservation;
      page.click('#crud-modal .crud-cancel');

      // 貸出停止枠: 日本時間の入力 → ISO で admin_create_reservation / 解除は admin_delete_block
      page.click('#btn-block');
      page.set('#bk-asset', 'V002');
      page.set('#bk-start', '2027-03-01T09:00');
      page.set('#bk-end', '2027-03-02T18:00');
      page.set('#bk-reason', '定期点検');
      page.click('#bk-save');
      await waitFor(() => rpcs(log, 'admin_create_reservation').length, 2000);
      deq(rpcs(log, 'admin_create_reservation')[0].args, {
        p: { kind: 'block', asset_id: 'V002', start_at: '2027-03-01T00:00:00.000Z', end_at: '2027-03-02T09:00:00.000Z', staff_note: '定期点検' }
      });
      await waitFor(() => !page.$('#crud-modal'), 2000);
      const block = S.list('reservations').find(r => r.kind === 'block');
      assert.ok(block);
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + block.reservationId + '"]'), 2000);
      page.click(page.$('#tbl .detail-link[data-id="' + block.reservationId + '"]'));
      page.click('#act-unblock');
      await waitFor(() => rpcs(log, 'admin_delete_block').length, 2000);
      deq(rpcs(log, 'admin_delete_block')[0].args, { p_id: block.reservationId });
      deq(businessKeys(w.localStorage), []);
      assertClean(page, 'fake-reservation-list');
    } finally { page.close(); }
  });

  test('mail-log.html: 宛先は伏せ字・未設定の案内・状態の件数・再送は retryOutbox → 対象の予約番号だけ処理', async () => {
    const db = fakeDb();
    const log = [];
    const page = fakePage('manage/mail-log.html', db, log, async (url, init) => {
      if (url === FAKE_FN + '/admin/outbox/process') {
        const body = JSON.parse(init.body || '{}');
        const results = db.outbox.filter(o => o.status === 'pending' && (!body.refIds || body.refIds.indexOf(o.ref_id) >= 0))
          .map(o => { o.status = 'sent'; o.attempts += 1; o.sent_at = new Date().toISOString(); return { id: o.id, template: o.template, status: 'sent' }; });
        return jsonRes({ ok: true, processed: results.length, results: results });
      }
      return null;
    });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$$('#tbl tr[data-id]').length === 4, 3000);
      const table = page.text('#tbl');
      assert.match(table, /ya\*\*\*\*@example\.com/);
      assert.ok(table.indexOf('yamada.taro') < 0, '宛先が伏せ字になっていない');
      assert.match(table, /カレンダー同期/);
      assert.match(table, /担当者のカレンダー/);
      assert.match(table, /お問い合わせ受付 \(お客様\)/);
      assert.match(table, /次回の自動再送/);
      assert.ok(page.$('#tbl a[href="reservation-list.html#R00001"]'));
      assert.ok(page.$('#tbl a[href="inquiries.html#C00001"]'));
      // 案内 (最新のメールが「送信せず: メール送信サービス未設定」)
      await waitFor(() => page.$('#setup-alert'), 2000);
      assert.match(page.text('#setup-alert'), /メール送信サービスが未設定です/);
      assert.ok(page.$('#setup-alert a[href$="setup.md"]'));
      // 件数
      await waitFor(() => !page.$('#counts').hidden, 2000);
      assert.equal(page.text('#counts [data-count="failed"] strong'), '2');
      assert.equal(page.text('#counts [data-count="pending"] strong'), '1');
      assert.equal(page.text('#counts [data-count="skipped"] strong'), '1');

      // 失敗したメールを再送
      page.click(page.$('#tbl [data-retry="11"]'));
      await waitFor(() => page.toasts('success').length, 2000);
      deq(rpcs(log, 'admin_retry_outbox')[0].args, { p_id: 11 });
      const proc = page.fetches.find(f => f.url === FAKE_FN + '/admin/outbox/process');
      deq(proc.body, { refIds: ['R00001'] });
      assert.match(page.toasts('success')[0], /送信 1件/);
      await waitFor(() => /送信済み/.test(page.text('#tbl tr[data-id="11"]')), 2000);
      // 再送で試行回数が 0 に戻ってから送る (2 回失敗 → 再送 → 1 回目で送信)
      assert.equal(page.text('#tbl tr[data-id="11"] td:nth-child(6)'), '1', '再送で試行回数が 0 に戻っていない');

      // 絞り込み: 状態 = 失敗 / 種類 = カレンダー同期
      log.length = 0;
      page.set('#f-status', 'failed');
      await waitFor(() => page.$$('#tbl tr[data-id]').length === 1, 2000);
      page.set('#f-kind', 'gcal');
      await waitFor(() => log.some(l => l.table === 'outbox' && l.filters.some(f => f[0] === 'template' && f[1] === 'eq')), 2000);
      assert.equal(page.$$('#tbl tr[data-id]').length, 1);
      assert.match(page.text('#tbl'), /失敗/);
      // 関連番号 (記号は取り除く)
      page.set('#f-status', '');
      page.set('#f-kind', '');
      page.set('#f-ref', 'C0000%1');
      page.click('#btn-search');
      await waitFor(() => page.$('#tbl tr[data-id="13"]') && page.$$('#tbl tr[data-id]').length === 1, 2000);
      assert.ok(page.$('#tbl tr[data-id="13"]'), 'rows: ' + page.$$('#tbl tr[data-id]').map(t => t.dataset.id).join(','));
      assert.equal(page.$$('#tbl tr[data-id]').length, 1);
      // 未送信を今すぐ送信 → 対象の番号だけ
      page.click(page.$('#tbl [data-send="13"]'));
      await waitFor(() => page.fetches.filter(f => f.url === FAKE_FN + '/admin/outbox/process').length >= 2, 2000);
      deq(page.fetches.filter(f => f.url === FAKE_FN + '/admin/outbox/process')[1].body, { refIds: ['C00001'] });
      assertClean(page, 'fake-mail-log');
    } finally { page.close(); }
  });

  test('inquiries.html: 状態・メモの更新は admin_update_inquiry / 最新の情報に更新', async () => {
    const db = fakeDb();
    const log = [];
    const page = fakePage('manage/inquiries.html', db, log);
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window;
      assert.equal(page.text('#n-new'), '1');
      assert.equal(page.text('#mode-note'), '');
      page.click('#tbl tr[data-id="C00001"] td');
      assert.equal(page.$('#iq-body').textContent, '本文です\n<img src=x onerror="window.__xss=1">');
      assert.equal(w.__xss, undefined);
      assert.match(page.text('#detail'), /マツダ CX-5/, '関連予約の概要が出ない');
      page.set('#iq-status', 'closed');
      page.set('#iq-note', '9/24 電話で回答済み');
      page.click('#iq-save');
      await waitFor(() => rpcs(log, 'admin_update_inquiry').length, 2000);
      deq(rpcs(log, 'admin_update_inquiry')[0].args, { p_id: 'C00001', p_patch: { status: 'closed', staff_note: '9/24 電話で回答済み' } });
      await waitFor(() => page.text('#n-closed') === '2', 2000);
      assert.equal(page.$('[data-tab="closed"]').getAttribute('aria-selected'), 'true');
      // 失敗
      db.__failRpc.admin_update_inquiry = 'FORBIDDEN';
      page.click('#iq-save');
      await waitFor(() => /保存できませんでした/.test(page.text('#iq-msg')), 2000);
      assert.match(page.text('#iq-msg'), /権限がありません/);
      delete db.__failRpc.admin_update_inquiry;
      // 最新の情報に更新 (サーバーで増えた問い合わせ)
      db.inquiries.push({ id: 'C00003', name: '新着 三郎', company: '', email: 'n@example.com', tel: '', topic: 'その他', body: '新しい', reservation_id: null, user_id: null, status: 'new', staff_note: '', assigned_to: null, created_at: '2026-09-23T00:00:00+00:00' });
      page.click('#btn-refresh');
      await waitFor(() => page.text('#n-new') === '1' && w.SkyRentStore.list('inquiries').length === 3, 2000);
      assert.equal(w.SkyRentStore.list('inquiries').length, 3);
      assertClean(page, 'fake-inquiries');
    } finally { page.close(); }
  });

  test('members.html: 本番は「会員を招待」(admin/members/invite)・入力エラーの表示・招待した会員を一覧に足す', async () => {
    const db = fakeDb();
    const log = [];
    let calls = 0;
    const page = fakePage('manage/members.html', db, log, async (url, init) => {
      if (url !== FAKE_FN + '/admin/members/invite') return null;
      calls++;
      const body = JSON.parse(init.body);
      if (calls === 1) return jsonRes({ ok: false, code: 'VALIDATION', message: '入力内容に不備があります。表示された項目をご確認ください。', fields: { phone: '電話番号は数字とハイフンで入力してください' }, requestId: 'req-1' }, 400);
      db.members.push({ user_id: 'u-new', member_no: 'M00002', email: body.email, name: body.name, name_kana: body.name_kana, phone: body.phone, company: body.company, is_corporate: false, invoice_allowed: false, marketing_opt_in: false, status: 'active', last_use_at: null, created_at: new Date().toISOString() });
      return jsonRes({ ok: true, userId: 'u-new', email: body.email, invited: true, resent: false });
    });
    try {
      assert.equal(await page.ready(8000), true);
      assert.equal(page.text('#btn-add'), '+ 会員を招待');
      page.click('#btn-add');
      assert.equal(page.$('#m-pass'), null, '本番でパスワード欄が出ている');
      page.click('#i-send');
      assert.match(page.text('#i-err'), /氏名を入力/);
      page.set('#i-name', '招待 太郎');
      page.set('#i-kana', 'ショウタイ タロウ');
      page.set('#i-email', 'invite@example.com');
      page.set('#i-phone', 'abc');
      page.click('#i-send');
      await waitFor(() => /電話番号は数字とハイフン/.test(page.text('#i-err')), 2000);
      assert.match(page.text('#i-err'), /入力内容に不備があります/);
      page.set('#i-phone', '090-1111-2222');
      page.click('#i-send');
      await waitFor(() => page.toasts('success').length, 2000);
      const inv = page.fetches.filter(f => f.url === FAKE_FN + '/admin/members/invite');
      assert.equal(inv.length, 2);
      deq(inv[1].body, { email: 'invite@example.com', name: '招待 太郎', name_kana: 'ショウタイ タロウ', phone: '090-1111-2222', company: '', invoiceAllowed: false });
      assert.equal(inv[1].method, 'POST');
      assert.match(page.toasts('success')[0], /招待メールを送信しました/);
      await waitFor(() => /invite@example\.com/.test(page.text('#tbl')), 2000);
      assert.equal(page.window.SkyRentStore.getMember('M00002').userId, 'u-new');
      // 会員詳細: 請求書払いの許可 → admin_update_member (書込フック)
      page.click(page.$('#tbl [data-detail="M00001"]'));
      page.click('#inv-toggle');
      await waitFor(() => rpcs(log, 'admin_update_member').length, 2000);
      deq(rpcs(log, 'admin_update_member')[0].args.p_patch, { is_corporate: true, invoice_allowed: true });
      assert.equal(log.filter(l => l.kind === 'from' && l.table === 'notifications').length, 0);
      assertClean(page, 'fake-members');
    } finally { page.close(); }
  });

  test('dashboard.html: 未対応のお問い合わせ・メール送信/カレンダー同期の失敗件数・最近の動き (操作履歴)', async () => {
    const db = fakeDb();
    const page = fakePage('manage/dashboard.html', db, []);
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.text('#n-mail-failed') === '1' && page.text('#n-gcal-failed') === '1', 3000);
      assert.equal(page.text('#n-inquiries'), '1');
      assert.equal(page.text('#n-mail-failed'), '1');
      assert.equal(page.text('#n-gcal-failed'), '1');
      assert.ok(page.$('#todo-mail').classList.contains('is-alert'));
      assert.equal(page.$('#todo-mail').getAttribute('href'), 'mail-log.html?status=failed&kind=mail');
      await waitFor(() => page.$$('#notif-list li a').length === 2, 2000);
      assert.ok(page.$('#notif-list a[href="reservation-list.html#R00001"]'));
      assert.ok(page.$('#notif-list a[href="inquiries.html#C00001"]'));
      assertClean(page, 'fake-dashboard');
    } finally { page.close(); }
  });

  test('high-season / site-settings / ga-integration: サーバーの値を表示し、保存は他の項目を残す', async () => {
    const db = fakeDb();
    const log = [];
    const page = fakePage('manage/high-season.html', db, log);
    try {
      assert.equal(await page.ready(8000), true);
      deq(page.$$('#tbl .hs-name').map(i => i.value), ['GW']);
      assert.match(page.text('#effects'), /¥999/);
      page.click(page.$('#tbl .hs-del'));
      page.click('#btn-add');
      const row = page.$('#tbl [data-row]');
      page.set(row.querySelector('.hs-name'), '年末年始');
      page.set(row.querySelector('.hs-from-m'), '12');
      page.set(row.querySelector('.hs-from-d'), '29');
      page.set(row.querySelector('.hs-to-m'), '1');
      page.set(row.querySelector('.hs-to-d'), '3');
      page.click('#btn-save');
      await waitFor(() => log.some(l => l.table === 'app_settings' && l.op === 'upsert'), 2000);
      deq(log.find(l => l.table === 'app_settings' && l.op === 'upsert').payload, {
        key: 'pricing_rules',
        value: { version: 'server-1', busyFee: 999, weekendHolidayFee: 330, busyPeriods: [{ name: '年末年始', from: '12-29', to: '01-03' }], cancellation: { noShowPct: 100 }, custom: 'keep' }
      });
      assertClean(page, 'fake-high-season');
    } finally { page.close(); }

    const p2 = fakePage('manage/site-settings.html', fakeDb(), []);
    try {
      assert.equal(await p2.ready(8000), true);
      assert.equal(p2.$('[data-setting="siteName"]').value, 'サーバーのサイト名');
      assertClean(p2, 'fake-site-settings');
    } finally { p2.close(); }

    const p3 = fakePage('manage/ga-integration.html', fakeDb(), []);
    try {
      assert.equal(await p3.ready(8000), true);
      assert.equal(p3.$('[data-setting="ga4Id"]').value, 'G-SERVER1');
      assert.equal(p3.$('[data-setting="event.purchase"]').checked, false, 'サーバーの OFF を既定値で上書きした');
      assertClean(p3, 'fake-ga');
    } finally { p3.close(); }

    // 権限の無いスタッフは編集できない
    const db4 = fakeDb();
    db4.__role = 'viewer';
    const p4 = fakePage('manage/high-season.html', db4, []);
    try {
      assert.equal(await p4.ready(8000), true);
      assert.equal(p4.$('#edit-actions').hidden, true);
      assert.equal(p4.$$('#tbl input, #tbl select').length, 0);
      assert.match(p4.text('#perm-note'), /管理者だけ/);
      assertClean(p4, 'fake-high-season-viewer');
    } finally { p4.close(); }
  });
});

// =====================================================================
// 本番モード: ローカル Supabase + Edge Functions + モック
// =====================================================================
async function supabaseUp() {
  try {
    const res = await fetch(LOCAL_API + '/rest/v1/rpc/public_catalog', {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' }, body: '{}'
    });
    return res.ok;
  } catch (e) { return false; }
}
async function functionsUp() {
  try {
    const res = await fetch(LOCAL_API + '/functions/v1/admin/calendar/status', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    return res.status === 401 && j && j.code === 'UNAUTHENTICATED';
  } catch (e) { return false; }
}
async function googleMockUp() {
  try { return (await fetch(GOOGLE_MOCK + '/_mock/requests', { signal: AbortSignal.timeout(2000) })).ok; } catch (e) { return false; }
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
    const e = new Error(path + ': HTTP ' + res.status + ' ' + text.slice(0, 300));
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json;
}
const svcSelect = (table, query) => api('/rest/v1/' + table + '?' + query, { service: true });
const svcInsert = (table, row) => api('/rest/v1/' + table, { service: true, body: row, headers: { Prefer: 'return=representation' } }).then(r => r[0]);
const svcUpdate = (table, query, patch) => api('/rest/v1/' + table + '?' + query, { service: true, method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } });
const svcDelete = (table, query) => api('/rest/v1/' + table + '?' + query, { service: true, method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null);
async function mock(path, body) {
  const res = await fetch(GOOGLE_MOCK + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error('google mock ' + path + ': ' + res.status);
  return res.json();
}

// 二段階認証 (TOTP) を通したスタッフのセッション
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
function totp(secret) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
function signLocalJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return h + '.' + p + '.' + createHmac('sha256', LOCAL_JWT_SECRET).update(h + '.' + p).digest('base64url');
}
async function createStaffSession(role) {
  const email = 'e2-staff-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
  const password = 'E2-test-' + Date.now() + 'Aa1';
  const user = await api('/auth/v1/admin/users', { service: true, body: { email: email, password: password, email_confirm: true } });
  const userId = user.id || (user.user && user.user.id);
  try {
    await api('/rest/v1/staff', { service: true, body: { user_id: userId, name: 'E2 テスト管理者', email: email, role: role || 'admin', active: true }, headers: { Prefer: 'return=minimal' } });
    const s1 = await api('/auth/v1/token?grant_type=password', { body: { email: email, password: password } });
    let s2;
    try {
      const factor = await api('/auth/v1/factors', { token: s1.access_token, body: { factor_type: 'totp', friendly_name: 'e2-test' } });
      const ch = await api('/auth/v1/factors/' + factor.id + '/challenge', { token: s1.access_token, body: {} });
      s2 = await api('/auth/v1/factors/' + factor.id + '/verify', { token: s1.access_token, body: { challenge_id: ch.id, code: totp(factor.totp.secret) } });
    } catch (e) {
      if (!(e.body && e.body.error_code === 'mfa_totp_enroll_not_enabled')) throw e;
      const payload = JSON.parse(Buffer.from(s1.access_token.split('.')[1], 'base64url').toString());
      payload.aal = 'aal2';
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
  if (!userId) return;
  try { await api('/auth/v1/admin/users/' + userId, { service: true, method: 'DELETE' }); } catch (e) { /* 後片付けの失敗は無視 */ }
}

// 今日から 150〜390 日後のランダムな日 (日本時間の 'YYYY-MM-DD')。used と重ならない
function randomDay(used) {
  for (;;) {
    const d = 150 + Math.floor(Math.random() * 241);
    if (!used.has(d)) { used.add(d); return jstYmd(Date.now() + d * DAY); }
  }
}

describe('E2 本番モード: ローカル Supabase + Edge Functions', { skip: NO_JSDOM || (SUPABASE_UMD ? false : 'supabase-js が見つかりません') }, () => {
  let ready = false;
  let why = '';
  let staff = null;
  const rand = randomBytes(4).toString('hex');

  before(async () => {
    if (!(await supabaseUp())) { why = 'ローカル Supabase に接続できません'; return; }
    if (!(await functionsUp())) { why = 'Edge Functions が起動していません'; return; }
    staff = await createStaffSession('admin');
    ready = true;
  });
  after(async () => { if (staff) await deleteUser(staff.userId); });

  function livePage(path, extra) {
    return openPage(path, Object.assign({ mode: 'live', local: { 'sb-127-auth-token': JSON.stringify(staff.session) } }, extra || {}));
  }

  test('calendar.html: サービスアカウントの表示・接続テスト (events / freeBusyOnly / 共有なし) — 設定は保存しない', async t => {
    if (!ready) return t.skip(why);
    if (!(await googleMockUp())) return t.skip('Google のモックが起動していません');
    const W = 'e2-' + rand + '-w@cal.test', F = 'e2-' + rand + '-f@cal.test', N = 'e2-' + rand + '-none@cal.test';
    const prepare = async () => {
      await mock('/_mock/calendars/' + encodeURIComponent(W), { access: 'writer' });
      await mock('/_mock/calendars/' + encodeURIComponent(F), { access: 'freeBusyOnly' });
      const day = jstYmd(Date.now() + 2 * DAY);
      await mock('/_mock/calendars/' + encodeURIComponent(W) + '/events', { summary: '会議', start: day + 'T10:00:00+09:00', end: day + 'T11:00:00+09:00' });
      await mock('/_mock/calendars/' + encodeURIComponent(F) + '/events', { summary: '外出', start: day + 'T13:00:00+09:00', end: day + 'T14:00:00+09:00' });
    };
    await prepare();
    const before = await svcSelect('app_settings', 'select=value&key=eq.calendar');
    const page = livePage('manage/calendar.html');
    try {
      assert.equal(await page.ready(20000), true, 'skyrent:ready が発火しない (' + page.window.SkyRentBackend._lastRedirect + ')');
      await waitFor(() => page.$('#sa-email'), 20000);
      assert.equal(page.$('#sa-email').value, 'skyrent-calendar@skyrent-test.iam.gserviceaccount.com');
      assert.match(page.text('#status-body'), /鍵 \(サービスアカウント\) が登録されています/);
      assert.ok(page.$$('.gc-loc').length >= 2, '拠点が表示されない');
      assert.ok(/^\d+$/.test(page.$('#f-minutes').value), '受け渡し時間が表示されない');

      const block = page.$('.gc-loc[data-loc="loc-kushiro"]');
      const base = block.querySelectorAll('[data-row]').length;
      [W, F, N].forEach(() => page.click(block.querySelector('.gc-add')));
      const rows = Array.from(block.querySelectorAll('[data-row]')).slice(base);
      page.set(rows[0].querySelector('.gc-id'), W);
      page.set(rows[1].querySelector('.gc-id'), F);
      page.set(rows[2].querySelector('.gc-id'), N);
      const run = async i => {
        page.click(rows[i].querySelector('.gc-test'));
        await waitFor(() => /events|freeBusyOnly|none|できません/.test(rows[i].querySelector('.gc-result').textContent), 20000);
        return rows[i].querySelector('.gc-result').textContent;
      };
      let w = await run(0);
      if (!/events/.test(w)) { await prepare(); w = await run(0); }  // 他の担当がモックを初期化した場合に 1 回だけやり直す
      assert.match(w, /events/);
      assert.match(w, /予定あり」: 1 件/);
      const f = await run(1);
      assert.match(f, /freeBusyOnly/);
      assert.match(f, /終日の「休み」が反映されず/);
      const n = await run(2);
      assert.match(n, /接続できません/);
      assert.equal(page.$('#dirty-note').hidden, false);
      // 保存していないので DB は変わらない (このテストは app_settings を書き換えない)
      const after = await svcSelect('app_settings', 'select=value&key=eq.calendar');
      const ids = JSON.stringify(after);
      assert.ok(ids.indexOf(W) < 0, '接続テストだけで設定が保存された');
      deq(after, after.length ? after : before);
      deq(businessKeys(page.window.localStorage), []);
      assertBooted(page, 'live-calendar');
      assertClean(page, 'live-calendar');
    } finally { page.close(); }
  });

  test('reservation-list.html: キャンセル (料金の変更・理由・通知なし) / 無断キャンセル / VERSION_CONFLICT / 停止枠の登録・解除 が DB に届く', async t => {
    if (!ready) return t.skip(why);
    const used = new Set();
    const created = [];
    const email = 'e2-resv-' + rand + '@example.com';
    async function insertReservation() {
      for (let i = 0; i < 6; i++) {
        const day = randomDay(used);
        const start = jstIso(day, 10), end = new Date(Date.parse(start) + DAY).toISOString();
        try {
          const row = await svcInsert('reservations', {
            asset_id: 'V005', category_id: 'cat-rental', location_id: 'loc-kitami', period: '[' + start + ',' + end + ')',
            customer_name: 'E2 テスト', customer_email: email, customer_phone: '090-0000-0000', license_confirmed: true,
            total: 7700, price: { base: 7700, total: 7700, lines: [{ code: 'base', label: '基本料金 (24時間 × 1)', amount: 7700 }] }, source: 'staff'
          });
          created.push(row.id);
          return row;
        } catch (e) {
          if (!/23P01|exclu/i.test(String(e.message))) throw e;  // 他の担当の予約と重なったら別の日で
        }
      }
      throw new Error('テスト用の予約を作れませんでした');
    }
    const r1 = await insertReservation(), r2 = await insertReservation(), r3 = await insertReservation();
    const blockDay = randomDay(used);
    const page = livePage('manage/reservation-list.html');
    try {
      assert.equal(await page.ready(20000), true);
      const S = page.window.SkyRentStore;
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + r3.id + '"]'), 5000);

      // --- r1: キャンセル。規定 (150日以上前 = 無料) と違う 500 円 → 理由が必要。お客様へのメールなし
      page.click(page.$('#tbl .detail-link[data-id="' + r1.id + '"]'));
      page.click('#act-cancel');
      assert.equal(page.text('#rd-rule'), '¥0');
      page.set('#rd-fee', '500');
      page.click('#rd-confirm');
      assert.match(page.text('#rd-fee-err'), /理由を入力/);
      page.set('#rd-reason', 'E2 テストの手数料');
      page.set('#rd-notify', false);
      page.click('#rd-confirm');
      await waitFor(() => !page.$('#crud-modal'), 15000);
      assert.ok(page.toasts('success').some(x => /キャンセルにしました/.test(x)), 'トーストが出ない: ' + page.toasts().join(' / '));
      let row = (await svcSelect('reservations', 'select=status,cancel_fee,cancelled_by,staff_note,version&id=eq.' + r1.id))[0];
      assert.equal(row.status, 'cancelled');
      assert.equal(row.cancel_fee, 500);
      assert.equal(row.cancelled_by, 'staff');
      assert.match(row.staff_note, /【キャンセル料】¥500 \(規定 ¥0\) 理由: E2 テストの手数料/);
      assert.match(row.staff_note, /E2 テスト管理者/);
      const mails = await svcSelect('outbox', 'select=id,template&ref_id=eq.' + r1.id + '&template=eq.reservation_cancelled');
      deq(mails, [], '「通知なし」なのにキャンセルのメールが積まれた');
      assert.equal(S.findById('reservations', 'reservationId', r1.id).version, row.version, '画面の版がサーバーと合わない');

      // --- r2: 無断キャンセル (規定 = 100%)
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + r2.id + '"]'), 5000);
      page.click(page.$('#tbl .detail-link[data-id="' + r2.id + '"]'));
      page.click('#act-noshow');
      assert.equal(page.text('#rd-rule'), '¥7,700');
      page.click('#rd-confirm');
      await waitFor(() => !page.$('#crud-modal'), 15000);
      row = (await svcSelect('reservations', 'select=status,cancel_fee&id=eq.' + r2.id))[0];
      deq(row, { status: 'no_show', cancel_fee: 7700 });

      // --- r3: 他のスタッフが先に更新 → VERSION_CONFLICT (DB は変わらない)
      await svcUpdate('reservations', 'id=eq.' + r3.id, { staff_note: '別のスタッフのメモ' });
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + r3.id + '"]'), 5000);
      page.click(page.$('#tbl .detail-link[data-id="' + r3.id + '"]'));
      page.click('#act-inuse');
      await waitFor(() => !page.$('#rd-msg').hidden, 15000);
      assert.match(page.text('#rd-msg'), /他のスタッフが先にこのデータを更新しました/);
      assert.ok(page.$('#rd-reload'));
      row = (await svcSelect('reservations', 'select=status&id=eq.' + r3.id))[0];
      assert.equal(row.status, 'confirmed');
      page.click('#crud-modal .crud-cancel');

      // --- 貸出停止枠の登録 → 解除
      page.click('#btn-block');
      page.set('#bk-asset', 'V005');
      page.set('#bk-start', blockDay + 'T09:00');
      page.set('#bk-end', blockDay + 'T18:00');
      page.set('#bk-reason', '整備・修理');
      page.set('#bk-memo', 'E2 テスト ' + rand);
      page.click('#bk-save');
      await waitFor(() => !page.$('#crud-modal') || !page.$('#bk-err').hidden, 15000);
      assert.equal(page.$('#crud-modal'), null, '停止枠を登録できない: ' + (page.$('#bk-err') ? page.text('#bk-err') : ''));
      const blocks = await svcSelect('reservations', 'select=id,kind,status,start_at,end_at,staff_note,asset_id&kind=eq.block&staff_note=eq.' + encodeURIComponent('整備・修理 — E2 テスト ' + rand));
      assert.equal(blocks.length, 1, '停止枠が DB に無い');
      created.push(blocks[0].id);
      assert.equal(Date.parse(blocks[0].start_at), Date.parse(jstIso(blockDay, 9)));
      assert.equal(Date.parse(blocks[0].end_at), Date.parse(jstIso(blockDay, 18)));
      await waitFor(() => page.$('#tbl .detail-link[data-id="' + blocks[0].id + '"]'), 5000);
      page.click(page.$('#tbl .detail-link[data-id="' + blocks[0].id + '"]'));
      page.click('#act-unblock');
      await waitFor(() => !page.$('#crud-modal'), 15000);
      row = (await svcSelect('reservations', 'select=status&id=eq.' + blocks[0].id))[0];
      assert.equal(row.status, 'cancelled');
      deq(businessKeys(page.window.localStorage), []);
      assertClean(page, 'live-reservation-list');
    } finally {
      page.close();
      if (created.length) {
        await svcDelete('outbox', 'ref_id=in.(' + created.join(',') + ')');
        await svcDelete('reservations', 'id=in.(' + created.join(',') + ')');
      }
    }
  });

  test('mail-log.html: 実際のワーカーで送信 → 宛先不正は失敗 → 再送 (伏せ字・対象の番号だけ処理)', async t => {
    if (!ready) return t.skip(why);
    const ref = 'E2T-' + rand;
    const bad = 'e2-bounce-' + rand + '@example.com', ok = 'e2-ok-' + rand + '@example.com';
    const payload = { name: 'E2 テスト', amount: 500, reason: 'テスト' };
    const a = await svcInsert('outbox', { template: 'coupon_issued', to_email: bad, payload: payload, ref_type: 'test', ref_id: ref });
    const b = await svcInsert('outbox', { template: 'coupon_issued', to_email: ok, payload: payload, ref_type: 'test', ref_id: ref });
    const page = livePage('manage/mail-log.html?q=' + ref);
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => page.$$('#tbl tr[data-id]').length === 2, 10000);
      const text = page.text('#tbl');
      assert.ok(text.indexOf(bad) < 0 && text.indexOf(ok) < 0, '宛先が伏せ字になっていない');
      assert.match(text, /e2\*\*\*\*@example\.com/);
      assert.match(text, /クーポン発行のお知らせ/);
      // 状態ごとの件数 (head + count)
      await waitFor(() => !page.$('#counts').hidden, 10000);
      assert.match(page.text('#counts [data-count="failed"] strong'), /^\d+$/);
      const status = id => page.text('#tbl tr[data-id="' + id + '"] .ml-st');
      if (status(a.id) === '未送信') {
        page.click(page.$('#tbl [data-send="' + a.id + '"]'));
        await waitFor(() => status(a.id) === '失敗' && status(b.id) === '送信済み', 20000);
      } else {
        await waitFor(() => status(a.id) === '失敗' && status(b.id) === '送信済み', 20000);  // 他の処理が先に送った
      }
      assert.equal(status(a.id), '失敗');
      assert.equal(status(b.id), '送信済み');
      const errText = page.text('#tbl tr[data-id="' + a.id + '"]');
      assert.ok(errText.indexOf(bad) < 0, 'エラー文に宛先が出ている');
      // 宛先不正は自動では再送しない → 「再送」で最初から送り直す案内
      assert.match(errText, /自動では再送しません/);
      assert.match(errText, /「再送」を押すと、最初から送り直します/);
      // 再送 → 試行回数が 0 に戻ってから送り直し → もう一度失敗 (試行 1 回)
      const btn = page.$('#tbl [data-retry="' + a.id + '"]');
      assert.ok(btn, '再送ボタンが無い');
      const toastsBefore = page.toasts().length;
      page.click(btn);
      // 再送 (retryOutbox → 対象の番号だけ処理) が終わるとトーストが出る
      await waitFor(() => page.toasts().length > toastsBefore, 20000);
      await waitFor(() => status(a.id) === '失敗', 20000);
      const dbRow = (await svcSelect('outbox', 'select=status,attempts&id=eq.' + a.id))[0];
      deq(dbRow, { status: 'failed', attempts: 1 }, '再送で試行回数が 0 に戻っていない');
      await waitFor(() => page.text('#tbl tr[data-id="' + a.id + '"] td:nth-child(6)') === '1', 20000);
      assert.equal(page.text('#tbl tr[data-id="' + a.id + '"] td:nth-child(6)'), '1');
      assert.ok(page.toasts().some(x => /処理しました|処理を依頼しました/.test(x)), 'トーストが出ない');
      // 処理は対象の番号だけ
      const calls = page.fetches.filter(f => /\/functions\/v1\/admin\/outbox\/process$/.test(f.url));
      assert.ok(calls.length >= 1);
      calls.forEach(c => deq(c.body, { refIds: [ref] }));
      assertClean(page, 'live-mail-log');
    } finally {
      page.close();
      await svcDelete('outbox', 'ref_id=eq.' + ref);
    }
  });

  test('inquiries.html: サーバーの問い合わせを表示し、状態・メモの更新が DB に届く', async t => {
    if (!ready) return t.skip(why);
    const q = await svcInsert('inquiries', { name: 'E2 テスト ' + rand, email: 'e2-inq-' + rand + '@example.com', topic: 'その他', body: '1行目\n<b>太字ではない</b>' });
    const page = livePage('manage/inquiries.html#' + q.id);
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => page.$('#iq-body'), 5000);
      assert.equal(page.$('#iq-body').textContent, '1行目\n<b>太字ではない</b>');
      assert.equal(page.$$('#iq-body b').length, 0);
      page.set('#iq-note', 'E2 テストで対応済み');
      page.click('#iq-close');
      await waitFor(() => /保存しました/.test(page.text('#iq-msg')), 15000);
      const row = (await svcSelect('inquiries', 'select=status,staff_note&id=eq.' + q.id))[0];
      deq(row, { status: 'closed', staff_note: 'E2 テストで対応済み' });
      assert.equal(page.$('[data-tab="closed"]').getAttribute('aria-selected'), 'true');
      assertClean(page, 'live-inquiries');
    } finally {
      page.close();
      await svcDelete('inquiries', 'id=eq.' + q.id);
    }
  });

  test('members.html: 「会員を招待」で招待メールが届き、会員一覧に出る', async t => {
    if (!ready) return t.skip(why);
    const email = 'e2-invite-' + rand + '@example.com';
    const page = livePage('manage/members.html');
    let userId = null;
    try {
      assert.equal(await page.ready(20000), true);
      assert.equal(page.text('#btn-add'), '+ 会員を招待');
      page.click('#btn-add');
      page.set('#i-name', 'E2 招待');
      page.set('#i-email', email);
      page.click('#i-send');
      await waitFor(() => page.toasts('success').length || (page.$('#i-err') && !page.$('#i-err').hidden), 20000);
      assert.ok(page.toasts('success').some(x => /招待メールを送信しました/.test(x)), '招待できない: ' + (page.$('#i-err') ? page.text('#i-err') : ''));
      const m = (await svcSelect('members', 'select=user_id,email,name&email=eq.' + encodeURIComponent(email)))[0];
      assert.ok(m, 'members 行ができていない');
      userId = m.user_id;
      assert.equal(m.name, 'E2 招待');
      await waitFor(() => page.text('#tbl').indexOf(email) >= 0, 5000);
      // 招待メール (Mailpit)
      const found = await waitFor(async () => {
        const r = await fetch('http://127.0.0.1:54324/api/v1/search?query=' + encodeURIComponent('to:"' + email + '"'));
        const j = await r.json();
        return (j.messages_count || (j.messages || []).length) > 0;
      }, 15000, 500);
      assert.ok(found, '招待メールが届かない');
      assertClean(page, 'live-members');
    } finally {
      page.close();
      if (!userId) {
        const m = await svcSelect('members', 'select=user_id&email=eq.' + encodeURIComponent(email)).catch(() => []);
        userId = m[0] && m[0].user_id;
      }
      await deleteUser(userId);
    }
  });

  test('dashboard / high-season / site-settings / ga-integration / contact: 本番でも壊れずサーバーの値を表示 (保存はしない)', async t => {
    if (!ready) return t.skip(why);
    const page = livePage('manage/dashboard.html');
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => /^\d+$/.test(page.text('#n-mail-failed')) && /^\d+$/.test(page.text('#n-gcal-failed')), 10000);
      assert.match(page.text('#n-mail-failed'), /^\d+$/);
      const S = page.window.SkyRentStore;
      assert.equal(page.text('#n-inquiries'), String(S.list('inquiries').filter(q => q.status === 'new').length));
      assertClean(page, 'live-dashboard');
    } finally { page.close(); }

    const rules = (await svcSelect('app_settings', 'select=value&key=eq.pricing_rules'))[0].value;
    const hs = livePage('manage/high-season.html');
    try {
      assert.equal(await hs.ready(20000), true);
      deq(hs.$$('#tbl .hs-name').map(i => i.value), (rules.busyPeriods || []).map(p => p.name));
      assertClean(hs, 'live-high-season');
    } finally { hs.close(); }

    for (const p of ['manage/site-settings.html', 'manage/ga-integration.html', 'manage/contact.html']) {
      const pg = livePage(p);
      try {
        assert.equal(await pg.ready(20000), true, p);
        assertBooted(pg, p);
        assertClean(pg, p);
        deq(businessKeys(pg.window.localStorage), [], p);
      } finally { pg.close(); }
    }
  });
});
