/**
 * 担当D1: 予約の流れ (公開ページ) のテスト
 *   booking.html / search.html / detail.html / index.html + js/lp.js
 *
 * 実行: node --test tests/pages-d1.test.mjs
 *       (端末のタイムゾーンに依存しないことを見るため TZ=UTC / Asia/Tokyo / America/Los_Angeles でも実行する)
 *
 *   - デモモード: jsdom でページを開き、日本時間の扱い・見積の行・空きの理由と候補・最終確認画面の表示事項・
 *     同意・二重送信防止・完了画面を確かめる。
 *   - 本番モード: localStorage['sky-rent.configOverride'] でローカル Supabase + 起動中の Edge Functions に接続。
 *     予約を実際に確定し (PRICE_CHANGED → 再確認 → 確定 / メール送信失敗)、最後に API でキャンセルする。
 *     担当者の予定 (Google カレンダー) は /api/availability・/api/quote の応答を差し替えて確かめる
 *     (共有の app_settings.calendar や Google モックの状態は変えない)。Supabase が起動していなければ skip。
 *
 * 本番で作る予約は「今日から150〜390日後のランダムな日時」(他の担当のテストとぶつからないように)。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

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

const ORIGIN = 'http://localhost:8901';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
const LOCAL_API = 'http://127.0.0.1:54321';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const LIVE_CONFIG = { SUPABASE_URL: LOCAL_API, SUPABASE_ANON_KEY: ANON_KEY };
const RESEND_MOCK = 'http://127.0.0.1:8978';

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
  // フォント・画像・計測タグなどはネットワークに出さず空で返す (要求は記録する)
  interceptLog.push(request.url);
  const css = /\.css(\?|$)|fonts\.googleapis/.test(request.url);
  return new Response('', { headers: { 'Content-Type': css ? 'text/css' : 'application/javascript' } });
}
const interceptLog = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const plain = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const deq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
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

/**
 * ページを jsdom で開く
 *   opts.mode: 'demo' | 'live'
 *   opts.fetchHook(url, init, next) -> Response | null  (本番: 特定の URL の応答を差し替える)
 *   opts.local / opts.session: 開く前に入れておく storage
 */
function openPage(path, opts) {
  opts = opts || {};
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
  const html = readFileSync(join(ROOT, path.split(/[?#]/)[0]), 'utf8');
  const out = { errors: [], consoleErrors: [], resourceErrors: [], notImplemented: [], requests: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => out.consoleErrors.push(a.map(x => (x && x.stack) || String(x)).join(' ')));
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
        const url = String((input && input.url) || input);
        out.requests.push({ url: url, method: (init && init.method) || 'GET', body: init && init.body });
        const next = () => globalThis.fetch(input, init);
        if (opts.fetchHook) {
          const r = await opts.fetchHook(url, init || {}, next);
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
      window.matchMedia = q => ({ matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
      if (opts.mode === 'live') window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(LIVE_CONFIG));
      Object.entries(opts.local || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
      Object.entries(opts.session || {}).forEach(([k, v]) => window.sessionStorage.setItem(k, v));
      window.__ready = new Promise(res => window.addEventListener('skyrent:ready', () => res(true)));
    }
  });
  out.window = dom.window;
  out.document = dom.window.document;
  out.$ = s => dom.window.document.querySelector(s);
  out.$$ = s => Array.from(dom.window.document.querySelectorAll(s));
  out.text = s => { const el = dom.window.document.querySelector(s); return el ? el.textContent : ''; };
  out.ready = ms => Promise.race([dom.window.__ready, new Promise(r => setTimeout(() => r(false), ms || 10000).unref())]);
  out.close = () => { try { dom.window.close(); } catch (e) { /* 無視 */ } };
  return out;
}

// JS エラー・読み込み失敗・console.error が無いこと (画面遷移は allowNav のときだけ許す)
function assertClean(page, label, allowNav) {
  deq(page.errors, [], label + ': JS エラー');
  deq(page.resourceErrors, [], label + ': 読み込めなかったファイル');
  deq(page.consoleErrors, [], label + ': console.error');
  if (!allowNav) deq(page.notImplemented.filter(m => /navigation/i.test(m)), [], label + ': 想定外の画面遷移');
}

// 入力欄に値を入れる (change / input を発火)
function setValue(page, sel, v) {
  const el = page.$(sel);
  assert.ok(el, sel + ' が無い');
  el.value = v;
  el.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  el.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}
function check(page, sel, on) {
  const el = page.$(sel);
  assert.ok(el, sel + ' が無い');
  if (el.checked !== on) el.click();
}

// ---- 日本時間の小物 (テスト側も端末 TZ に依存しない) ----
const jstToday0 = () => Math.floor((Date.now() + JST) / DAY) * DAY - JST;
const jstInput = ms => new Date(ms + JST).toISOString().slice(0, 16);
const jstDow = ms => new Date(ms + JST).getUTCDay();
// n 日後 (日本時間) の h:m
const jstAt = (days, h, m) => jstToday0() + days * DAY + h * HOUR + (m || 0) * 60000;
// n 日後以降で最初の平日 (月〜金) の日数。祝日も避ける
function weekdayOffset(from, core) {
  for (let d = from; d < from + 14; d++) {
    const t = jstAt(d, 10);
    const dow = jstDow(t);
    if (dow !== 0 && dow !== 6 && !core.isJapaneseHoliday(new Date(t).toISOString())) return d;
  }
  return from;
}

// 料金計算コア (祝日判定などテスト側の日付選びに使う)
await import(pathToFileURL(join(ROOT, 'js/pricing-core.js')).href);
const CORE = globalThis.SkyRentPricingCore;

const PENDING = 'sky-rent.pendingBooking';
const NO_JSDOM = jsdom ? false : 'jsdom が見つかりません (npm install を実行してください)';

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
async function apiCall(path, body) {
  const res = await fetch(LOCAL_API + '/functions/v1/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function serviceSelect(table, query) {
  const res = await fetch(LOCAL_API + '/rest/v1/' + table + '?' + query, { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
  if (!res.ok) throw new Error(table + ': HTTP ' + res.status);
  return res.json();
}
const jsonResponse = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

// =====================================================================
// デモモード
// =====================================================================
describe('D1 デモモード: 検索・詳細 (日本時間・空きの理由・見積)', { skip: NO_JSDOM }, () => {
  test('search.html: 既定は明日 10:00 (日本時間)・URL は日本時間・重複の理由を表示', async () => {
    const page = openPage('search.html');
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$$('#results .asset-card').length >= 6, 4000);
      const t = jstAt(1, 10);
      assert.equal(page.$('#s-start').value, jstInput(t), '既定の出発日時');
      assert.equal(page.$('#s-end').value, jstInput(t + DAY), '既定の返却日時');
      // URL は日本時間の 'YYYY-MM-DDTHH:MM'
      const q = new URLSearchParams(page.window.location.search);
      assert.equal(q.get('start'), jstInput(t));
      const link = page.$('#results a.btn-primary').getAttribute('href');
      assert.match(link, new RegExp('start=' + encodeURIComponent(jstInput(t)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(page.text('#tz-note'), /日本時間/);
      assertClean(page, 'search');
    } finally { page.close(); }

    // デモのシード予約 (V003: 8日後 10:00 から2日間) と重なる期間 → 予約不可 + 理由 + 別の日時へのリンク
    const s = jstAt(8, 12), e = jstAt(9, 12);
    const page2 = openPage('search.html?category=cat-rental&start=' + jstInput(s) + '&end=' + jstInput(e));
    try {
      assert.equal(await page2.ready(8000), true);
      await waitFor(() => page2.$$('#results .asset-card').length >= 5, 4000);
      const cards = page2.$$('#results .asset-card');
      const v003 = cards.find(c => /マツダ CX-5/.test(c.textContent));
      assert.ok(v003, 'V003 のカードが無い');
      assert.ok(v003.classList.contains('ng'), 'V003 が予約不可になっていない');
      assert.match(v003.textContent, /他の予約と重複しています/);
      assert.match(v003.querySelector('a.btn').textContent, /別の日時を探す/);
      // おすすめ順: 予約できる車両が先
      assert.ok(cards[0].classList.contains('ok'));
      assert.match(page2.text('#result-count'), /件の空きが見つかりました \(全\d+件\)/);
      assert.equal(page2.$('#s-start').value, jstInput(s), 'URL の日本時間がそのまま入力欄に入る');
      assertClean(page2, 'search-ng');
    } finally { page2.close(); }

    // 旧形式 (ISO) の URL も読める / 過去の日時はエラー表示
    const past = jstAt(-2, 10);
    const page3 = openPage('search.html?start=' + encodeURIComponent(new Date(past).toISOString()) + '&end=' + encodeURIComponent(new Date(past + DAY).toISOString()));
    try {
      assert.equal(await page3.ready(8000), true);
      await waitFor(() => !page3.$('#search-error').hidden, 3000);
      assert.equal(page3.$('#s-start').value, jstInput(past));
      assert.match(page3.text('#search-error'), /過去の日時/);
      assertClean(page3, 'search-past');
    } finally { page3.close(); }
  });

  test('detail.html: 日本時間・補償の短時間料金/割増の行・補償は1つだけ・重複時は理由と候補', async () => {
    const page = openPage('detail.html?id=V003');
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$$('[data-opt]').length >= 2, 3000);
      const core = CORE;
      // 平日の 18:00 から 4 時間 (返却 22:00 は夜間料金) + CDW の短時間料金
      const d = weekdayOffset(20, core);
      setValue(page, '#p-start', jstInput(jstAt(d, 18)));
      setValue(page, '#p-end', jstInput(jstAt(d, 18) + 4 * HOUR));
      check(page, '[data-opt="OP101"]', true);
      const lines = page.$$('#p-lines .pl').map(x => x.textContent);
      assert.ok(lines.some(l => /基本料金 \(4時間\)/.test(l) && /¥8,800/.test(l)), '基本料金 4時間: ' + lines.join(' | '));
      assert.ok(lines.some(l => /免責補償制度 \(CDW\) \(4時間・短時間料金\)/.test(l) && /¥1,100/.test(l)), 'CDW 短時間料金: ' + lines.join(' | '));
      assert.ok(lines.some(l => /夜間料金 \(返却時\)/.test(l) && /¥1,100/.test(l)), '夜間料金: ' + lines.join(' | '));
      assert.equal(page.text('#p-total'), '¥11,000');
      // 補償は同じグループから1つだけ
      check(page, '[data-opt="OP102"]', true);
      assert.equal(page.$('[data-opt="OP101"]').checked, false, 'CDW と PAP を同時に選べてしまう');
      assert.ok(page.$$('#p-lines .pl').some(x => /安心保証コース/.test(x.textContent)));
      // 土曜日を含む → 土日祝割増
      let sat = 20; while (jstDow(jstAt(sat, 10)) !== 6) sat++;
      setValue(page, '#p-start', jstInput(jstAt(sat, 10)));
      setValue(page, '#p-end', jstInput(jstAt(sat + 1, 10)));
      assert.ok(page.$$('#p-lines .pl').some(x => /土日祝割増/.test(x.textContent) && /¥330/.test(x.textContent)));
      assert.equal(page.$('#book-btn').disabled, false);
      assert.match(page.text('#p-discount-note'), /割引/);

      // シード予約 (V003: 8日後 10:00〜10日後 10:00) と重なる → 予約不可 + 理由 + 候補
      setValue(page, '#p-start', jstInput(jstAt(9, 10)));
      setValue(page, '#p-end', jstInput(jstAt(9, 16)));
      assert.equal(page.$('#book-btn').disabled, true);
      assert.match(page.text('#p-avail'), /ご予約いただけません/);
      assert.match(page.text('#p-reason'), /他の予約と重複しています/);
      const sugg = page.$$('#p-suggest button[data-s]');
      assert.ok(sugg.length >= 1, '空いている日時の候補が出ない');
      // 候補は営業時間 (北見 9:00-19:00) 内・同じ利用時間
      sugg.forEach(b => {
        const s = Number(b.dataset.s), e = Number(b.dataset.e);
        assert.equal(e - s, 6 * HOUR);
        const hm = new Date(s + JST).getUTCHours() * 60 + new Date(s + JST).getUTCMinutes();
        assert.ok(hm >= 9 * 60 && hm < 19 * 60, '営業時間外の候補: ' + b.textContent);
      });
      sugg[0].click();
      assert.equal(page.$('#book-btn').disabled, false, '候補を選んでも予約に進めない');
      assert.equal(page.$('#p-reason').hidden, true);

      // 出発日時を動かすと、返却も同じ利用時間だけずれる
      const before = page.$('#p-end').value;
      const s0 = page.window.SkyRentBackend.jst.fromInput(page.$('#p-start').value);
      setValue(page, '#p-start', jstInput(Date.parse(s0) + 3 * DAY));
      assert.notEqual(page.$('#p-end').value, before);
      assert.equal(Date.parse(page.window.SkyRentBackend.jst.fromInput(page.$('#p-end').value)) - Date.parse(page.window.SkyRentBackend.jst.fromInput(page.$('#p-start').value)), 6 * HOUR);

      // 予約に進む → pendingBooking (ISO・選んだ補償)
      check(page, '[data-opt="OP101"]', true);
      page.$('#book-btn').click();
      const pb = JSON.parse(page.window.sessionStorage.getItem(PENDING));
      assert.equal(pb.assetId, 'V003');
      assert.match(pb.start, /Z$/);
      assert.equal(jstInput(Date.parse(pb.start)), page.$('#p-start').value);
      deq(pb.optionIds, ['OP101']);
      assertClean(page, 'detail', true);
    } finally { page.close(); }

    // URL の日本時間 → 入力欄 / 過去は予約不可
    const page2 = openPage('detail.html?id=V001&start=2027-01-15T09:30&end=2027-01-16T09:30');
    try {
      assert.equal(await page2.ready(8000), true);
      await waitFor(() => page2.$('#p-start').value, 3000);
      assert.equal(page2.$('#p-start').value, '2027-01-15T09:30');
      assert.equal(page2.$('#p-end').value, '2027-01-16T09:30');
      setValue(page2, '#p-start', jstInput(jstAt(-1, 10)));
      setValue(page2, '#p-end', jstInput(jstAt(0, 10)));
      assert.equal(page2.$('#book-btn').disabled, true);
      assert.match(page2.text('#p-reason'), /過去の日時/);
      assertClean(page2, 'detail-url');
    } finally { page2.close(); }
  });
});

describe('D1 デモモード: 予約手続き (booking.html)', { skip: NO_JSDOM }, () => {
  function pendingFor(assetId, startMs, hours, optionIds, extra) {
    return JSON.stringify(Object.assign({ assetId: assetId, start: new Date(startMs).toISOString(), end: new Date(startMs + hours * HOUR).toISOString(), quantity: 1, optionIds: optionIds || [] }, extra || {}));
  }
  function fill(page, o) {
    o = o || {};
    setValue(page, '#f-name', o.name != null ? o.name : 'テスト 花子');
    setValue(page, '#f-kana', 'テスト ハナコ');
    setValue(page, '#f-email', o.email || 'hanako@example.com');
    setValue(page, '#f-phone', o.phone || '０９０−１２３４−５６７８');
    if (o.license !== false) check(page, '#f-licconf', true);
  }

  test('入力 → 最終確認 (6項目・割引・キャンセル規定) → 同意 → 確定 → 完了 (再読み込みでも完了画面)', async () => {
    // 平日 10:00 から 26 時間 (割引の対象: 24時間以上)
    const d = weekdayOffset(30, CORE);
    const start = jstAt(d, 10);
    const page = openPage('booking.html', { session: { [PENDING]: pendingFor('V001', start, 26, ['OP101']) } });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$('#f-licconf') && page.$$('input[name="discount"]').length, 3000);
      // 免許証番号の入力欄は無い (必須チェックに置き換え)
      assert.equal(page.$('#f-license'), null, '免許証番号の入力欄が残っている');
      assert.match(page.text('#license-wrap'), /運転される方全員が、有効な運転免許証を持っています/);
      // 割引: 学生・法人・二地域は選べる / 守成クラブはキッチンカーのみ (理由を表示)
      const radios = page.$$('input[name="discount"]');
      deq(radios.map(r => r.value), ['', 'student', 'corporate', 'dual_residence', 'shusei_club']);
      assert.equal(page.$('input[name="discount"][value="student"]').disabled, false);
      const shusei = page.$('input[name="discount"][value="shusei_club"]');
      assert.equal(shusei.disabled, true);
      assert.match(shusei.closest('label').textContent, /キッチンカーのご利用が対象です/);
      assert.match(page.$('input[name="discount"][value="student"]').closest('label').textContent, /学生証/);
      // 冪等キーは sessionStorage に保持
      const key = JSON.parse(page.window.sessionStorage.getItem(PENDING)).idempotencyKey;
      assert.match(key, /^[A-Za-z0-9_-]{16,100}$/);

      // 必須チェック: 免許証の確認が無い → 項目の下にエラー
      fill(page, { license: false });
      page.$('#cust-form').dispatchEvent(new page.window.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page.$('#input-error').hidden, 2000);
      assert.match(page.text('#input-error'), /運転免許証/);
      assert.ok(page.$('#license-wrap + .bk-field-err'), '免許証の確認の下にエラーが出ない');
      assert.equal(page.$('#pane-confirm').hidden, true);

      // 学生割引を選んで確認画面へ
      check(page, '#f-licconf', true);
      page.$('input[name="discount"][value="student"]').click();
      page.$('#cust-form').dispatchEvent(new page.window.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page.$('#pane-confirm').hidden, 3000);
      assert.equal(page.$('#pane-confirm').hidden, false, '確認画面に進まない: ' + page.text('#input-error'));
      const body = page.text('#confirm-body');
      // 消費者庁の6項目
      ['ご予約の車両・台数', '1台', '貸出・返却の日時と店舗', '北見本店', '北海道北見市', '料金の内訳と総額 (税込)',
        'お支払いの方法と時期', 'ご利用当日、車両のお渡し時に店舗でお支払いください', '予約の成立時点', 'キャンセル規定',
        '取り消しの方法', 'マイページ'].forEach(s => assert.ok(body.indexOf(s) >= 0, '確認画面に「' + s + '」が無い'));
      // 日時は日本時間
      assert.ok(body.indexOf(page.window.SkyRentBackend.jst.format(new Date(start).toISOString())) >= 0, '貸出日時 (日本時間) が無い');
      // 料金: 基本料金 (24時間 × 1) + 延長 2時間 + CDW + 学生割引
      const q = page.window.SkyRentPricing.quote({ assetId: 'V001', start: new Date(start).toISOString(), end: new Date(start + 26 * HOUR).toISOString(), optionIds: ['OP101'], discountType: 'student' });
      assert.equal(page.text('#confirm-total'), page.window.SkyRentPricing.yen(q.total));
      assert.ok(q.lines.some(l => l.code === 'discount' && l.amount === -1100));
      assert.match(body, /学生割引/);
      // キャンセル規定: コンパクト (通常期) の段階表 + いま取り消した場合
      assert.match(body, /コンパクト・軽トラック/);
      assert.match(body, /通常期/);
      const rows = page.$$('#confirm-body .bk-table tr').map(r => r.textContent);
      assert.ok(rows.some(r => /3日前 \(.+\) まで/.test(r) && /無料/.test(r)), '3日前まで無料の行: ' + rows.join(' | '));
      assert.ok(rows.some(r => /2日前〜前日/.test(r) && /30%/.test(r) && r.indexOf(page.window.SkyRentPricing.yen(Math.floor(q.base * 0.3))) >= 0));
      assert.ok(rows.some(r => /当日/.test(r) && /50%/.test(r)));
      assert.ok(rows.some(r => /無断キャンセル/.test(r) && /100%/.test(r)));
      assert.match(page.text('#cancel-now'), /¥0/);   // 30日前なので無料
      // 同意は文書ごとに版つき
      const consents = page.$$('#consent-box input[data-doc]');
      deq(consents.map(c => c.dataset.doc + '@' + c.dataset.ver), ['clause@2026-08', 'cancel@2026-08', 'privacy@2026-08']);
      assert.match(page.text('#consent-box'), /2026-08版/);
      assert.equal(page.text('#btn-submit'), '上記の内容で予約を確定する');

      // 同意なし → エラー
      const before = page.window.SkyRentStore.list('reservations').length;
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#confirm-error').hidden, 2000);
      assert.match(page.text('#confirm-error'), /貸渡約款.*同意が必要です/);
      // 同意して確定。続けてもう一度押しても1件だけ (二重送信防止)
      consents.forEach(c => { c.checked = true; });
      page.$('#btn-submit').click();
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#pane-done').hidden, 3000);
      assert.equal(page.$('#pane-done').hidden, false, '完了画面にならない: ' + page.text('#confirm-error'));
      assert.equal(page.window.SkyRentStore.list('reservations').length, before + 1, '二重に予約された');
      const r = page.window.SkyRentStore.list('reservations').slice(-1)[0];
      assert.equal(r.idempotencyKey, key, '冪等キーが送られていない');
      assert.equal(r.discountType, 'student');
      assert.equal(r.total, q.total);
      assert.equal(r.licenseConfirmed, true);
      assert.equal(r.customerPhone, '090-1234-5678', '全角の電話番号を半角にしていない');
      // 完了画面
      assert.equal(page.text('#done-id'), r.reservationId);
      assert.match(page.text('#done-mail'), /デモ環境/);
      assert.match(page.text('#done-pay'), /店舗/);
      assert.match(page.$('#lookup-url').value, new RegExp('mypage\\.html#lookup=' + r.reservationId + '\\.'));
      assert.match(page.text('#pane-done'), /この画面を保存してください/);
      assert.equal(page.$('#summary-card').hidden, true);
      // sessionStorage には個人情報を残さない
      const saved = page.window.sessionStorage.getItem(PENDING);
      assert.ok(JSON.parse(saved).done, '完了の記録が無い');
      ['hanako@example.com', 'テスト 花子', '090-1234-5678'].forEach(s => assert.equal(saved.indexOf(s), -1, 'sessionStorage に個人情報: ' + s));
      assertClean(page, 'booking');

      // 再読み込みしても完了画面
      const page2 = openPage('booking.html', { session: { [PENDING]: saved } });
      try {
        assert.equal(await page2.ready(8000), true);
        await waitFor(() => !page2.$('#pane-done').hidden, 2000);
        assert.equal(page2.text('#done-id'), r.reservationId);
        assert.equal(page2.$('#pane-input').hidden, true);
        assertClean(page2, 'booking-reload');
      } finally { page2.close(); }
    } finally { page.close(); }
  });

  test('24時間未満は割引を選べない (理由を表示) / 電話番号の形式 / 過去の日時 / キッチンカーは守成クラブ可', async () => {
    const page = openPage('booking.html', { session: { [PENDING]: pendingFor('V001', jstAt(40, 10), 5, []) } });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$$('input[name="discount"]').length, 3000);
      ['student', 'corporate', 'dual_residence'].forEach(k => {
        const el = page.$('input[name="discount"][value="' + k + '"]');
        assert.equal(el.disabled, true, k + ' が選べてしまう');
        assert.match(el.closest('label').textContent, /24時間以上のご利用が対象です \(今回は5時間\)/);
      });
      fill(page, { phone: '12-34' });
      page.$('#cust-form').dispatchEvent(new page.window.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page.$('#input-error').hidden, 2000);
      assert.match(page.$('#f-phone').nextElementSibling.textContent, /電話番号を正しく入力してください/);
      assertClean(page, 'booking-short');
    } finally { page.close(); }

    const page2 = openPage('booking.html', { session: { [PENDING]: pendingFor('V001', jstAt(-1, 10), 5, []) } });
    try {
      assert.equal(await page2.ready(8000), true);
      await waitFor(() => !page2.$('#input-error').hidden, 2000);
      assert.match(page2.text('#input-error'), /貸出日時を過ぎている/);
      assert.match(page2.$('#input-error a.btn').getAttribute('href'), /^detail\.html\?id=V001&start=/);
      assertClean(page2, 'booking-past');
    } finally { page2.close(); }

    const page3 = openPage('booking.html', { session: { [PENDING]: pendingFor('K001', jstAt(60, 10), 48, ['OP201']) } });
    try {
      assert.equal(await page3.ready(8000), true);
      await waitFor(() => page3.$$('input[name="discount"]').length, 3000);
      assert.equal(page3.$('input[name="discount"][value="shusei_club"]').disabled, false);
      page3.$('input[name="discount"][value="shusei_club"]').click();
      fill(page3);
      page3.$('#cust-form').dispatchEvent(new page3.window.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page3.$('#pane-confirm').hidden, 3000);
      const body = page3.text('#confirm-body');
      assert.match(body, /守成クラブ会員割引/);
      assert.match(body, /キッチンカー/);
      // キッチンカー (通常期): 14日前まで無料 / 13日前〜3日前 50% / 2日前〜当日 100%
      const rows = page3.$$('#confirm-body .bk-table tr').map(r => r.textContent);
      assert.ok(rows.some(r => /14日前 \(.+\) まで/.test(r) && /無料/.test(r)), rows.join(' | '));
      assert.ok(rows.some(r => /13日前〜3日前/.test(r) && /50%/.test(r)), rows.join(' | '));
      assert.ok(rows.some(r => /2日前〜当日/.test(r) && /100%/.test(r)), rows.join(' | '));
      assertClean(page3, 'booking-kitchen');
    } finally { page3.close(); }
  });

  test('確定時のエラー: PRICE_CHANGED は新しい金額を見せて再確認 / 日時の問題は選び直しへ / 通信エラーは同じキーで再送', async () => {
    const start = jstAt(45, 10);
    const page = openPage('booking.html', { session: { [PENDING]: pendingFor('V002', start, 24, []) } });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$('#f-licconf'), 3000);
      const w = page.window, B = w.SkyRentBackend;
      fill(page);
      page.$('#cust-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page.$('#pane-confirm').hidden, 3000);
      page.$$('#consent-box input[data-doc]').forEach(c => { c.checked = true; });
      const orig = B.createReservation;
      const sent = [];
      const oldTotal = page.text('#confirm-total');
      // 1回目: 料金が変わった (サーバーの新しい見積つき)
      B.createReservation = async p => {
        sent.push(p);
        if (sent.length === 1) {
          const q = Object.assign({}, w.SkyRentPricing.quote({ assetId: 'V002', start: p.start, end: p.end }));
          q.lines = q.lines.concat([{ code: 'busy', label: '繁忙期割増', amount: 550 }]);
          q.total += 550;
          const e = new Error(B.errorMessage('PRICE_CHANGED')); e.code = 'PRICE_CHANGED'; e.quote = q; throw e;
        }
        if (sent.length === 2) { const e = new Error(B.errorMessage('NETWORK')); e.code = 'NETWORK'; throw e; }
        if (sent.length === 3) { const e = new Error(B.errorMessage('STAFF_UNAVAILABLE')); e.code = 'STAFF_UNAVAILABLE'; throw e; }
        return orig(p);
      };
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#price-notice').hidden, 2000);
      assert.match(page.text('#price-notice'), /料金が変わりました/);
      assert.match(page.text('#price-notice'), new RegExp(oldTotal.replace(/[¥,]/g, '.')));
      const newTotal = page.text('#confirm-total');
      assert.notEqual(newTotal, oldTotal, '新しい金額が表示されない');
      assert.match(page.text('#confirm-body'), /繁忙期割増/);
      assert.equal(page.$('#pane-confirm').hidden, false);
      assert.ok(page.$$('#consent-box input[data-doc]').every(c => c.checked), '同意のチェックが外れた');
      // 2回目: 新しい金額で送る → 通信エラー (同じ冪等キーのまま)
      page.$('#btn-submit').click();
      await waitFor(() => sent.length === 2 && !page.$('#confirm-error').hidden, 2000);
      assert.equal(sent[1].expectedTotal, sent[0].expectedTotal + 550, '再送で新しい金額を送っていない');
      assert.equal(sent[1].idempotencyKey, sent[0].idempotencyKey);
      assert.match(page.text('#confirm-error'), /サーバーに接続できませんでした/);
      assert.equal(page.$('#btn-submit').disabled, false);
      // 3回目: 担当者の予定 → 日時を選び直すリンク
      page.$('#btn-submit').click();
      await waitFor(() => sent.length === 3 && /受け渡し担当者/.test(page.text('#confirm-error')), 2000);
      assert.match(page.$('#confirm-error a.btn').getAttribute('href'), /^detail\.html\?id=V002&start=/);
      // 送信内容の形 (契約書 §2.1-3)
      const p = sent[0];
      deq(Object.keys(p).sort(), ['assetId', 'consent', 'couponId', 'customer', 'discountType', 'end', 'expectedTotal', 'idempotencyKey', 'licenseConfirmed', 'note', 'optionIds', 'paymentMethod', 'start'].sort());
      deq(p.consent.documents, [{ id: 'clause', version: '2026-08' }, { id: 'cancel', version: '2026-08' }, { id: 'privacy', version: '2026-08' }]);
      assert.equal(p.licenseConfirmed, true);
      assert.equal(p.customer.license, undefined);
      assertClean(page, 'booking-errors');
    } finally { page.close(); }
  });

  test('会員: 情報の自動入力・請求書払い・クーポン (合計から差し引き)・完了画面にマイページ / 英語表示でも動く', async () => {
    const start = jstAt(50, 10);
    const page = openPage('booking.html', {
      session: { [PENDING]: pendingFor('V004', start, 24, []), 'sky-rent.memberSession': JSON.stringify({ memberId: 'M002' }) }
    });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.$('#f-name').value, 3000);
      const w = page.window, S = w.SkyRentStore;
      assert.equal(page.$('#f-email').value, 'corp@example.com');
      assert.ok(page.$('input[name="pay"][value="invoice"]'), '請求書払いが選べない');
      // クーポンを持たせて再描画
      const m = S.getMember('M002');
      m.coupons = [{ couponId: 'CPTEST1', amount: 1000, reason: 'テスト', issuedAt: new Date().toISOString(), usedAt: null, usedFor: null }];
      S.upsert('members', 'memberId', m);
      w.document.dispatchEvent(new w.CustomEvent('sky-rent:langchange'));
      await waitFor(() => page.$('#coupon-wrap').style.display === 'block', 2000);
      setValue(page, '#f-coupon', 'CPTEST1');
      page.$('input[name="pay"][value="invoice"]').click();
      check(page, '#f-licconf', true);
      page.$('#cust-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page.$('#pane-confirm').hidden, 3000);
      assert.equal(page.$('#pane-confirm').hidden, false, page.text('#input-error'));
      const body = page.text('#confirm-body');
      assert.match(body, /請求書払い/);
      assert.match(body, /請求書に記載の期日までにお支払いください/);
      assert.match(body, /クーポン割引/);
      // SUV・ミニバン (通常期)
      assert.match(body, /SUV・ミニバン/);
      page.$$('#consent-box input[data-doc]').forEach(c => { c.checked = true; });
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#pane-done').hidden, 3000);
      assert.equal(page.$('#pane-done').hidden, false, page.text('#confirm-error'));
      const r = S.list('reservations').slice(-1)[0];
      assert.equal(r.payment.method, 'invoice');
      assert.equal(r.couponId, 'CPTEST1');
      assert.equal(r.memberId, 'M002');
      assert.ok(S.getMember('M002').coupons.find(c => c.couponId === 'CPTEST1').usedAt, 'クーポンが使用済みにならない');
      assert.match(page.text('#done-pay'), /請求書/);
      assert.equal(page.$('#done-mypage').hidden, false);
      assertClean(page, 'booking-member');
    } finally { page.close(); }

    // 英語表示 (sky-rent.lang = en) でも JS エラーなく動く
    for (const path of ['booking.html', 'detail.html?id=V003', 'search.html']) {
      const p = openPage(path, { local: { 'sky-rent.lang': 'en' }, session: { [PENDING]: pendingFor('V003', jstAt(60, 10), 24, ['OP101']) } });
      try {
        assert.equal(await p.ready(8000), true, path);
        await sleep(50);
        if (path === 'booking.html') assert.equal(p.text('#btn-submit'), 'Confirm this booking');
        if (path === 'search.html') assert.match(p.text('#tz-note'), /JST/);
        assertClean(p, 'en ' + path);
      } finally { p.close(); }
    }
  });
});

describe('D1 デモモード: トップ (index.html / lp.js)', { skip: NO_JSDOM }, () => {
  test('SEO・テーマカラー・GA は skyrent:ready 後に SkyRentStore の settings.* から反映 / 検索パネルは日本時間', async () => {
    const page = openPage('index.html', {
      local: {
        'sky-rent.settings.seo': JSON.stringify({ title: 'テストのタイトル', description: 'テストの説明', keywords: 'レンタカー,北見' }),
        'sky-rent.settings.site': JSON.stringify({ themeColor: '#1c4a7a' }),
        'sky-rent.settings.ga': JSON.stringify({ ga4Id: 'G-TEST1234' })
      }
    });
    try {
      assert.equal(await page.ready(8000), true);
      await waitFor(() => page.document.title === 'テストのタイトル', 2000);
      assert.equal(page.document.title, 'テストのタイトル');
      assert.equal(page.$('meta[name="description"]').getAttribute('content'), 'テストの説明');
      assert.equal(page.$('meta[name="keywords"]').getAttribute('content'), 'レンタカー,北見');
      assert.match(page.$('#skyrent-theme').textContent, /--color-primary: #1c4a7a/);
      assert.ok(page.$('script[src*="googletagmanager.com/gtag/js?id=G-TEST1234"]'), 'GA のタグが入らない');
      assert.equal(typeof page.window.gtag, 'function');
      const t = jstAt(1, 10);
      assert.equal(page.$('#hs-start').value, jstInput(t));
      assert.equal(page.$('#hs-end').value, jstInput(t + DAY));
      assertClean(page, 'index');
    } finally { page.close(); }

    // 不正な値は反映しない (CSS・URL に文字列をそのまま入れない)
    const page2 = openPage('index.html', {
      local: {
        'sky-rent.settings.site': JSON.stringify({ themeColor: 'red;} body{display:none' }),
        'sky-rent.settings.ga': JSON.stringify({ ga4Id: 'G-1"><script>' })
      }
    });
    try {
      assert.equal(await page2.ready(8000), true);
      await sleep(50);
      assert.equal(page2.$('#skyrent-theme'), null);
      assert.equal(page2.$('script[src*="googletagmanager"]'), null);
      assert.equal(page2.document.title.indexOf('グロースレンタカー'), 0);
      assertClean(page2, 'index-bad');
    } finally { page2.close(); }
  });
});

// =====================================================================
// 本番モード (ローカル Supabase + Edge Functions)
// =====================================================================
describe('D1 本番モード: ローカル Supabase + Edge Functions', { skip: NO_JSDOM }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });

  test('index.html: SEO・テーマは public_catalog の settings から (localStorage は読まない・書かない)', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions に接続できません');
    const page = openPage('index.html', {
      mode: 'live',
      // localStorage に古いデモの値があっても本番では使わない
      local: { 'sky-rent.settings.seo': JSON.stringify({ title: 'デモの古いタイトル' }) },
      fetchHook: async (url, init, next) => {
        if (url.indexOf('/rest/v1/rpc/public_catalog') < 0) return null;
        const res = await next();
        const j = await res.json();
        j.settings = Object.assign({}, j.settings, { seo: { title: 'サーバーのタイトル', description: 'サーバーの説明' }, site: Object.assign({}, (j.settings || {}).site, { themeColor: '#aa3300' }) });
        return jsonResponse(j);
      }
    });
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => page.document.title === 'サーバーのタイトル', 3000);
      assert.equal(page.document.title, 'サーバーのタイトル');
      assert.equal(page.$('meta[name="description"]').getAttribute('content'), 'サーバーの説明');
      assert.match(page.$('#skyrent-theme').textContent, /#aa3300/);
      assert.equal(page.window.SkyRentStore.live, true);
      assertClean(page, 'live-index');
    } finally { page.close(); }
  });

  test('search / detail: 担当者の予定・受け渡し重複の理由を表示 (空き状況の応答を差し替え)', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions に接続できません');
    // 20日後 (日本時間) の 9:00〜12:00 は北見の担当者が全員予定あり / 25日後 10:00 に北見で受け渡しあり
    const busyDay = 20, hoDay = 25;
    const staffBusy = { start: new Date(jstAt(busyDay, 9)).toISOString(), end: new Date(jstAt(busyDay, 12)).toISOString() };
    const handoverAt = new Date(jstAt(hoDay, 10)).toISOString();
    const quoteCalls = [];
    const hook = async (url, init, next) => {
      if (url.indexOf('/functions/v1/api/availability') >= 0) {
        const res = await next();
        const j = await res.json();
        j.handovers = Object.assign({}, j.handovers, { 'loc-kitami': ((j.handovers || {})['loc-kitami'] || []).concat([handoverAt]) });
        j.staff = {
          enabled: true, mode: 'handover', handoverMinutes: 30, oneHandoverAtATime: true,
          locations: {
            'loc-kitami': { configured: true, busy: [staffBusy], calendars: [{ busy: [staffBusy] }, { busy: [staffBusy] }] },
            'loc-kushiro': { configured: false, busy: [], calendars: [] }
          }
        };
        return jsonResponse(j);
      }
      if (url.indexOf('/functions/v1/api/quote') >= 0) {
        const body = JSON.parse(init.body);
        quoteCalls.push(body);
        // 読み込んだ範囲 (120日) より先は、サーバーの判定 (Google に直接問い合わせ) で担当者が不在
        if (Date.parse(body.start) > jstAt(200, 0)) {
          return jsonResponse({ ok: true, quote: { ok: true, errors: [], total: 1, lines: [] }, availability: { vehicle: true, staff: false, handover: true, reasons: ['STAFF_UNAVAILABLE'] } });
        }
      }
      return null;
    };
    const s = jstAt(busyDay, 10), e = jstAt(busyDay + 1, 10);
    const page = openPage('search.html?start=' + jstInput(s) + '&end=' + jstInput(e), { mode: 'live', fetchHook: hook });
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => page.$$('#results .asset-card').length >= 6, 4000);
      const cards = page.$$('#results .asset-card');
      const kitami = cards.filter(c => /北見/.test(c.textContent));
      const kushiro = cards.filter(c => /釧路/.test(c.textContent));
      assert.ok(kitami.length >= 4 && kushiro.length >= 1);
      kitami.forEach(c => {
        assert.ok(c.classList.contains('ng'), '北見の車両が予約可になっている: ' + c.textContent);
        assert.match(c.textContent, /受け渡し担当者の予定が埋まっています/);
      });
      // 釧路はカレンダー未設定 → 判定しない
      assert.ok(kushiro.some(c => c.classList.contains('ok')), '釧路の車両が予約不可');
      assertClean(page, 'live-search-staff');
    } finally { page.close(); }

    // detail: 担当者不在 → 理由 + 近い候補 → 候補を選ぶとサーバーでも確認 (実際の /api/quote)
    const page2 = openPage('detail.html?id=V003&start=' + jstInput(s) + '&end=' + jstInput(e), { mode: 'live', fetchHook: hook });
    try {
      assert.equal(await page2.ready(20000), true);
      await waitFor(() => page2.$('#p-reason') && !page2.$('#p-reason').hidden, 4000);
      assert.match(page2.text('#p-reason'), /受け渡し担当者の予定が埋まっています/);
      assert.equal(page2.$('#book-btn').disabled, true);
      const sugg = page2.$$('#p-suggest button[data-s]');
      assert.ok(sugg.length >= 1, '候補が出ない');
      sugg.forEach(b => {
        const st = Number(b.dataset.s);
        // 担当者の予定 (9:00〜12:00) と重ならない・受け渡し (10:00±30分) とも重ならない
        assert.ok(!(st < jstAt(busyDay, 12) && st + 30 * 60000 > jstAt(busyDay, 9)) || st >= jstAt(busyDay, 12), '担当者の予定と重なる候補: ' + b.textContent);
      });
      sugg[0].click();
      assert.equal(page2.$('#book-btn').disabled, false);
      await waitFor(() => /確認しました/.test(page2.text('#p-check')), 6000);
      assert.match(page2.text('#p-check'), /空き状況を確認しました/);
      assert.ok(quoteCalls.length >= 1, 'サーバーの見積 (空き確認) が呼ばれない');

      // 受け渡しの時刻が近い (10:00 の受け渡しから10分後) → HANDOVER_CONFLICT
      setValue(page2, '#p-start', jstInput(jstAt(hoDay, 10, 10)));
      setValue(page2, '#p-end', jstInput(jstAt(hoDay + 1, 13)));
      assert.match(page2.text('#p-reason'), /同じ店舗で別のお客様の受け渡しがあります/);
      assert.equal(page2.$('#book-btn').disabled, true);

      // 読み込んだ範囲の先: 画面では判定できない → サーバーの判定で不可
      setValue(page2, '#p-start', jstInput(jstAt(210, 10)));
      setValue(page2, '#p-end', jstInput(jstAt(211, 10)));
      assert.equal(page2.$('#book-btn').disabled, false);
      await waitFor(() => page2.$('#book-btn').disabled, 6000);
      assert.equal(page2.$('#book-btn').disabled, true, 'サーバーの判定 (担当者不在) が反映されない');
      assert.match(page2.text('#p-reason'), /受け渡し担当者の予定が埋まっています/);
      assertClean(page2, 'live-detail-staff');
    } finally { page2.close(); }
  });

  // 実際に予約を確定する (PRICE_CHANGED → 再確認 → 確定 / 冪等キー / メール送信状態) → 最後にキャンセル
  async function freeSlot(assetId, hours) {
    for (let i = 0; i < 8; i++) {
      const day = 150 + Math.floor(Math.random() * 240);
      const h = 9 + Math.floor(Math.random() * 7), m = Math.random() < 0.5 ? 0 : 30;
      const start = jstAt(day, h, m);
      const r = await apiCall('/quote', { assetId: assetId, start: new Date(start).toISOString(), end: new Date(start + hours * HOUR).toISOString(), optionIds: [] });
      if (r.status === 200 && r.json && r.json.availability && !r.json.availability.reasons.length) return start;
    }
    throw new Error('空いている日時が見つかりません');
  }
  async function cancelViaApi(lookupUrl) {
    const m = /#lookup=([^.]+)\.(.+)$/.exec(lookupUrl || '');
    if (!m) return null;
    const id = decodeURIComponent(m[1]), token = m[2];
    const lk = await apiCall('/reservations/lookup', { id: id, token: token });
    if (lk.status !== 200) return lk;
    return apiCall('/reservations/cancel', { id: id, token: token, expectedFee: lk.json.cancellation.fee });
  }

  test('booking.html: 確定 (PRICE_CHANGED → 新金額で再確認 → 確定)・送信は1回ずつ・DB と照会URL・メール送信状態', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions に接続できません');
    const start = await freeSlot('V005', 26);
    const tag = 'd1-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const email = tag + '@example.com';
    const pending = JSON.stringify({ assetId: 'V005', start: new Date(start).toISOString(), end: new Date(start + 26 * HOUR).toISOString(), quantity: 1, optionIds: ['OP101'] });
    const resCalls = [];
    const page = openPage('booking.html', {
      mode: 'live', session: { [PENDING]: pending },
      fetchHook: async (url, init) => { if (/\/functions\/v1\/api\/reservations$/.test(url)) resCalls.push(JSON.parse(init.body)); return null; }
    });
    let lookupUrl = null;
    try {
      assert.equal(await page.ready(20000), true);
      await waitFor(() => page.$('#f-licconf') && page.$$('#consent-box input[data-doc]').length === 3, 5000);
      const w = page.window, S = w.SkyRentStore;
      // 版は public_catalog の legal
      deq(page.$$('#consent-box input[data-doc]').map(c => c.dataset.doc), ['clause', 'cancel', 'privacy']);
      const legal = S.list('legal');
      page.$$('#consent-box input[data-doc]').forEach(c => assert.equal(c.dataset.ver, legal.find(x => x.id === c.dataset.doc).version));
      setValue(page, '#f-name', 'テスト D1');
      setValue(page, '#f-email', email);
      setValue(page, '#f-phone', '090-0000-1234');
      check(page, '#f-licconf', true);
      page.$('input[name="discount"][value="corporate"]').click();
      page.$('#cust-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
      await waitFor(() => !page.$('#pane-confirm').hidden || !page.$('#input-error').hidden, 10000);
      assert.equal(page.$('#pane-confirm').hidden, false, '確認画面に進まない: ' + page.text('#input-error'));
      assert.equal(page.$('#price-notice').hidden, true, 'サーバーの見積と画面の見積が違う');
      const shownTotal = page.text('#confirm-total');

      // 画面側の料金ルールだけ変える (= サーバーと食い違う) → 確定で PRICE_CHANGED
      const rules = JSON.parse(JSON.stringify(S.read('settings.pricing_rules')));
      rules.discounts.corporate.amount = 2200;
      S._hydrate({ 'settings.pricing_rules': rules });
      page.$$('#consent-box input[data-doc]').forEach(c => { c.checked = true; });
      page.$('#btn-submit').click();
      page.$('#btn-submit').click();   // 送信中の2回目は無視される
      await waitFor(() => !page.$('#price-notice').hidden || !page.$('#confirm-error').hidden, 15000);
      assert.equal(resCalls.length, 1, '送信中に2回送られた');
      if (page.$('#price-notice').hidden && /短時間に操作が集中/.test(page.text('#confirm-error'))) return t.skip('レート制限 (他のテストと共有の IP) のため確定できませんでした');
      assert.match(page.text('#price-notice'), /料金が変わりました/);
      assert.equal(page.text('#confirm-total'), shownTotal, 'サーバーの金額に戻っていない');
      // 新しい金額で再確認 → 確定
      page.$('#btn-submit').click();
      await waitFor(() => !page.$('#pane-done').hidden || (resCalls.length === 2 && !page.$('#confirm-error').hidden), 20000);
      if (page.$('#pane-done').hidden && /短時間に操作が集中/.test(page.text('#confirm-error'))) return t.skip('レート制限 (他のテストと共有の IP) のため確定できませんでした');
      assert.equal(page.$('#pane-done').hidden, false, '完了画面にならない: ' + page.text('#confirm-error'));
      assert.equal(resCalls.length, 2);
      assert.equal(resCalls[1].idempotencyKey, resCalls[0].idempotencyKey, '冪等キーが変わった');
      assert.equal(resCalls[0].expectedTotal - resCalls[1].expectedTotal, -1100, '再送の金額がサーバーの金額でない');
      const id = page.text('#done-id');
      assert.match(id, /^R\d+$/);
      lookupUrl = page.$('#lookup-url').value;
      assert.match(lookupUrl, new RegExp('^http://127\\.0\\.0\\.1:8901/mypage\\.html#lookup=' + id + '\\.'));
      // メール送信状態 (Resend モック → sent。届かない場合は queued / 送れない場合は別の文言)
      assert.match(page.text('#done-mail'), /予約確認メールをお送りしました|送信の準備をしています/);
      assert.match(page.text('#done-pay'), /店舗/);
      // DB: 割引・金額・同意の版
      const rows = await serviceSelect('reservations', 'select=id,total,discount_type,license_confirmed,customer_email,consent,option_ids,start_at&id=eq.' + id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].discount_type, 'corporate');
      assert.equal(page.window.SkyRentPricing.yen(rows[0].total), shownTotal);
      assert.equal(rows[0].license_confirmed, true);
      assert.equal(rows[0].customer_email, email);
      deq(rows[0].option_ids, ['OP101']);
      assert.equal(Date.parse(rows[0].start_at), start);
      if (rows[0].consent && rows[0].consent.documents) deq(rows[0].consent.documents.map(d => d.id).sort(), ['cancel', 'clause', 'privacy']);
      // 照会URLで照会できる
      const m = /#lookup=([^.]+)\.(.+)$/.exec(lookupUrl);
      const lk = await apiCall('/reservations/lookup', { id: decodeURIComponent(m[1]), token: m[2] });
      assert.equal(lk.status, 200);
      assert.equal(lk.json.reservation.id, id);
      // 業務データ・個人情報を localStorage / sessionStorage に残さない
      const ss = page.window.sessionStorage.getItem(PENDING);
      assert.equal(ss.indexOf(email), -1);
      for (let i = 0; i < page.window.localStorage.length; i++) {
        const k = page.window.localStorage.key(i);
        assert.ok(['sky-rent.configOverride', 'sky-rent.lang'].indexOf(k) >= 0 || !/^sky-rent\./.test(k), 'localStorage に ' + k);
        assert.equal(String(page.window.localStorage.getItem(k)).indexOf(email), -1);
      }
      // メール本文 (Resend モック) に照会URLが入っている (届いていれば)
      try {
        const mails = await (await fetch(RESEND_MOCK + '/_mock/emails')).json();
        const mine = (Array.isArray(mails) ? mails : (mails.emails || [])).filter(x => JSON.stringify(x.to || '').indexOf(email) >= 0);
        if (mine.length) assert.ok(mine.some(x => String(x.text || x.body || '').indexOf(id) >= 0), '確認メールに予約番号が無い');
      } catch (e) { /* モックが無ければ見ない */ }
      assertClean(page, 'live-booking');
    } finally {
      page.close();
      if (lookupUrl) {
        const c = await cancelViaApi(lookupUrl);
        assert.equal(c && c.status, 200, 'テスト予約のキャンセルに失敗: ' + JSON.stringify(c && c.json));
      }
    }
  });

  // メール送信状態ごとの完了画面の文言 (予約を作らないよう createReservation の応答を差し替える。
  // 実際の failed は Resend モックの "bounce" 宛先で確認済み: 共有 IP のレート制限を消費しないようここでは作らない)
  test('booking.html: 完了画面の文言は email.status (sent / queued / failed / skipped) で変わる', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions に接続できません');
    const start = jstAt(200, 10);
    const pending = JSON.stringify({ assetId: 'V002', start: new Date(start).toISOString(), end: new Date(start + 3 * HOUR).toISOString(), quantity: 1, optionIds: [] });
    const expect = {
      sent: /予約確認メールをお送りしました/,
      queued: /送信の準備をしています/,
      failed: /予約確認メールをお送りできませんでした/,
      skipped: /予約確認メールをお送りできませんでした/
    };
    for (const status of Object.keys(expect)) {
      const page = openPage('booking.html', { mode: 'live', session: { [PENDING]: pending } });
      try {
        assert.equal(await page.ready(20000), true);
        await waitFor(() => page.$('#f-licconf') && page.$$('#consent-box input[data-doc]').length === 3, 5000);
        const w = page.window, B = w.SkyRentBackend;
        let sent = null;
        B.quote = async p => ({ ok: true, quote: w.SkyRentPricing.quote({ assetId: p.assetId, start: p.start, end: p.end }), availability: { vehicle: true, staff: true, handover: true, reasons: [] } });
        B.createReservation = async p => {
          sent = p;
          return {
            ok: true, replay: false,
            reservation: { id: 'R09999', assetId: p.assetId, start: p.start, end: p.end, total: p.expectedTotal, price: { lines: [] }, status: 'confirmed', paymentMethod: 'onsite' },
            guestToken: 'tok', lookupUrl: 'http://127.0.0.1:8901/mypage.html#lookup=R09999.tok', email: { status: status }
          };
        };
        setValue(page, '#f-name', 'テスト D1');
        setValue(page, '#f-email', 'status-d1@example.com');
        setValue(page, '#f-phone', '0154-00-0000');
        check(page, '#f-licconf', true);
        page.$('#cust-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
        await waitFor(() => !page.$('#pane-confirm').hidden, 5000);
        page.$$('#consent-box input[data-doc]').forEach(c => { c.checked = true; });
        page.$('#btn-submit').click();
        await waitFor(() => !page.$('#pane-done').hidden, 5000);
        assert.ok(sent, status + ': 送信されない');
        assert.match(page.text('#done-mail'), expect[status], status + ': ' + page.text('#done-mail'));
        assert.equal(page.$('#lookup-url').value, 'http://127.0.0.1:8901/mypage.html#lookup=R09999.tok');
        assert.equal(page.$('#done-mypage').hidden, true, 'ゲストに「マイページで確認」を出している');
        assertClean(page, 'live-status-' + status);
      } finally { page.close(); }
    }
  });
});
