/**
 * Google カレンダー連携 (supabase/functions/_shared/{google,staff-calendar}.ts) と
 * admin Edge Function (supabase/functions/admin/index.ts) の結合テスト
 *
 * 実行: node --test tests/functions/calendar.test.mjs
 *
 * 前提 (ローカルで起動済みであること。無ければ skip):
 *   - Supabase (http://127.0.0.1:54321) と `supabase functions serve`
 *   - Google Calendar モック: node tests/mocks/google-mock.mjs (http://127.0.0.1:8979)
 *   - deno (staff-calendar.ts をホストから直接呼ぶ)
 *
 * 進め方:
 *   - テスト用の拠点・車両を service_role で作り、app_settings.calendar にその拠点だけを追加する。
 *     カレンダー ID は実行ごとに一意 (モックの /_mock/reset は使わない)。終わったら全部消して設定を戻す。
 *   - 判定 (§3.1 / §3.2) と gcal_sync (§3.3) は deno から staff-calendar.ts を直接呼んで確かめる。
 *   - api (/api/availability・/api/quote・/api/reservations) が実装済みなら HTTP 経由でも確かめる。
 *   - admin は AAL2 のトークン (ローカル既定の JWT 秘密鍵で署名) で呼ぶ。
 *   - 日時は「今日から 150〜390 日後」のランダムな日を使う。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPABASE_URL = 'http://127.0.0.1:54321';
const FN = SUPABASE_URL + '/functions/v1';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const GMOCK = 'http://127.0.0.1:8979';
const MAILPIT = 'http://127.0.0.1:54324';
const SA_JSON = readFileSync(join(ROOT, 'tests/fixtures/test-service-account.json'), 'utf8');
const SA = JSON.parse(SA_JSON);
const STAFF_CAL_URL = pathToFileURL(join(ROOT, 'supabase/functions/_shared/staff-calendar.ts')).href;

const DENO_ENV = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SITE_URL: 'http://127.0.0.1:8901/',
  GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(SA_JSON).toString('base64'),
  GOOGLE_API_BASE: GMOCK,
  GOOGLE_TOKEN_URL: GMOCK + '/token'
};

const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------
// テストデータ (実行ごとに一意)
// ---------------------------------------------------------------------
const RAND = crypto.randomBytes(3).toString('hex');
const LOC = 'b2t-' + RAND;
const ASSET = 'b2t-car-' + RAND;
const ASSET_NAME = 'テスト車両 B2-' + RAND;
const CAL_A = 'b2-' + RAND + '-a@cal.test';
const CAL_B = 'b2-' + RAND + '-b@cal.test';
const CAL_FB = 'b2-' + RAND + '-fb@cal.test';
const CAL_NONE = 'b2-' + RAND + '-none@cal.test';
const CUSTOMER_PHONE = '090-1234-5678';

const MIN = 60000, DAY = 86400000, JST = 9 * 3600000;
const TODAY_JST = Math.floor((Date.now() + JST) / DAY) * DAY - JST;
const BASE_DAY = 150 + crypto.randomInt(0, 200); // 150〜349 日後 (+ 最大 40 日のずらしで 390 日以内)
/** 基準日から d 日後の日本時間 hh:mm (ISO) */
function at(d, hh, mm = 0) { return new Date(TODAY_JST + (BASE_DAY + d) * DAY + (hh * 60 + mm) * MIN).toISOString(); }
/** 基準日から d 日後 (日本時間) の 'YYYY-MM-DD' */
function ymd(d) { return new Date(TODAY_JST + (BASE_DAY + d) * DAY + JST).toISOString().slice(0, 10); }

const reservationIds = [];
const authUserIds = [];
let origCalendar = null;
let lastWritten = null;
let env = { ok: false, why: '' };
let apiReady = false;

// ---------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

async function readCalendarSetting() {
  const { data, error } = await svc.from('app_settings').select('value').eq('key', 'calendar').maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

/** app_settings.calendar を書き換える (テスト拠点だけを足した形) */
async function setCalendar(patch, calendarIds) {
  const base = origCalendar || {};
  const value = Object.assign({}, base, {
    enabled: true, mode: 'handover', handoverMinutes: 30, oneHandoverAtATime: true,
    writeEvents: true, failOpen: false
  }, patch || {});
  value.locations = Object.assign({}, base.locations || {}, { [LOC]: { calendarIds: calendarIds || [CAL_A] } });
  const { error } = await svc.from('app_settings').upsert({ key: 'calendar', value });
  if (error) throw error;
  lastWritten = value;
}

const isTestLoc = (id) => /^b2t-/.test(id);
const hasTestLoc = (v) => Object.keys((v && v.locations) || {}).some(isTestLoc);

/**
 * テストが触る前の設定。このテストが同時に複数動くと、後から始まった方の origCalendar には
 * 先の実行の拠点や enabled:true が入っているため、監査ログからテスト拠点を含まない最新の値を探す。
 */
async function calendarBaseline() {
  if (origCalendar && !hasTestLoc(origCalendar)) return origCalendar;
  const { data } = await svc.from('audit_log').select('diff')
    .eq('table_name', 'app_settings').eq('row_id', 'calendar').order('id', { ascending: false }).limit(500);
  for (const row of data || []) {
    const v = row.diff && row.diff.value;
    if (v && v.locations && !hasTestLoc(v)) return v;
  }
  return null;
}

async function restoreCalendar() {
  if (!lastWritten) return;
  const cur = await readCalendarSetting();
  let next;
  if (stable(cur) === stable(lastWritten)) {
    next = JSON.parse(JSON.stringify(origCalendar));
  } else {
    // 途中で他の人が設定を変えた: その変更は残し、テスト拠点だけを外す
    next = Object.assign({}, cur, { locations: Object.assign({}, (cur && cur.locations) || {}) });
    delete next.locations[LOC];
  }
  if (next) {
    // 途中で止まった・上書きされた実行が残したテスト拠点も外す
    // (拠点の行がもう無い、または 10 分以上前に作られたまま = 後片付けまで進まなかった実行)
    const testIds = Object.keys(next.locations || {}).filter(isTestLoc);
    if (testIds.length) {
      const { data: live } = await svc.from('locations').select('id').in('id', testIds)
        .gt('updated_at', new Date(Date.now() - 10 * 60e3).toISOString());
      const liveIds = new Set((live || []).map(x => x.id));
      testIds.filter(id => !liveIds.has(id)).forEach(id => delete next.locations[id]);
    }
    // 他に動いているこのテストが無ければ (最後に終わった実行)、テストが書き換える項目 (enabled・failOpen など) を
    // テスト前の値に戻す。同時に動いた別の実行が最後に書いた値 (failOpen:true など) も残さない。
    // この設定を書き換えるテストはこのファイルだけ (pages-e2 は接続テストのみで保存しない)。
    const base = hasTestLoc(next) ? null : await calendarBaseline();
    if (base) {
      Object.keys(lastWritten).filter(k => k !== 'locations').forEach(k => {
        if (k in base) next[k] = base[k]; else delete next[k];
      });
    }
    const { error } = await svc.from('app_settings').upsert({ key: 'calendar', value: next });
    if (error) throw error;
  }
  lastWritten = null;
}

function denoCall(fn, ...args) { return denoCallWith({}, fn, ...args); }

function denoCallWith(extraEnv, fn, ...args) {
  const code = 'const m = await import(' + JSON.stringify(STAFF_CAL_URL) + ');' +
    'const out = await m[' + JSON.stringify(fn) + '](...JSON.parse(Deno.env.get("B2_ARGS")));' +
    'console.log("__OUT__" + JSON.stringify(out));';
  return new Promise((resolveP, reject) => {
    execFile('deno', ['eval', '--no-check', code], {
      cwd: ROOT, timeout: 120000, maxBuffer: 20 * 1024 * 1024,
      env: Object.assign({}, process.env, DENO_ENV, extraEnv, { B2_ARGS: JSON.stringify(args) })
    }, (err, stdout, stderr) => {
      const line = String(stdout || '').split('\n').find(l => l.startsWith('__OUT__'));
      if (!line) return reject(new Error('deno の実行に失敗: ' + String(stderr || (err && err.message) || '').slice(-2000)));
      resolveP(JSON.parse(line.slice(7)));
    });
  });
}

async function http(method, url, { body, headers } = {}) {
  const init = { method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text };
}

// ---- Google モック ----
async function mockCal(id, access) { return http('POST', GMOCK + '/_mock/calendars/' + encodeURIComponent(id), { body: { access } }); }
async function mockEvent(id, ev) {
  const r = await http('POST', GMOCK + '/_mock/calendars/' + encodeURIComponent(id) + '/events', { body: ev });
  assert.equal(r.status, 200, 'モックに予定を入れられません');
  return r.json;
}
async function mockEvents(id) { return (await http('GET', GMOCK + '/_mock/calendars/' + encodeURIComponent(id) + '/events')).json || []; }
async function ourEvents(id, reservationId) {
  return (await mockEvents(id)).filter(e => ((e.extendedProperties || {}).private || {}).skyrent === reservationId);
}
async function mockFail(status, count) { return http('POST', GMOCK + '/_mock/fail', { body: { status, count } }); }
/** 残った障害回数を使い切る (他の担当のテストに影響させない) */
async function drainFail(status) {
  for (let i = 0; i < 300; i++) {
    const r = await http('GET', GMOCK + '/calendar/v3/_drain');
    if (r.status !== status) return;
  }
}

// ---- サービスアカウントとして Google (モック) を直接操作する ----
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
async function saToken() {
  const now = Math.floor(Date.now() / 1000);
  const input = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: GMOCK + '/token', iat: now, exp: now + 600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), SA.private_key);
  const res = await fetch(GMOCK + '/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + b64url(sig) })
  });
  const j = await res.json();
  assert.ok(j.access_token, 'モックのトークンを取得できません');
  return j.access_token;
}
async function gapi(method, path, body) {
  const t = await saToken();
  return http(method, GMOCK + '/calendar/v3' + path, { body, headers: { authorization: 'Bearer ' + t } });
}

// ---- 認証 (ローカル既定の JWT 秘密鍵で AAL を指定したトークンを作る) ----
function userJwt(sub, aal, email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({
    sub, email, aud: 'authenticated', role: 'authenticated', aal, iat: now, exp: now + 1800,
    iss: SUPABASE_URL + '/auth/v1', amr: [{ method: aal === 'aal2' ? 'totp' : 'password', timestamp: now }]
  }));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + s;
}
function authHeaders(token) { return { apikey: ANON_KEY, authorization: 'Bearer ' + (token || ANON_KEY) }; }
async function admin(path, token, body, method) {
  return http(method || (body === undefined ? 'GET' : 'POST'), FN + '/admin' + path, { body, headers: authHeaders(token) });
}
/**
 * 公開 api を呼ぶ。service_role のキーを付けるとレート制限だけが外れる (自動テスト用。他の担当と
 * 同じ IP 枠を使い切らないように)。ログインしていない利用者 (ゲスト) として扱われる。
 */
async function api(path, body, method) {
  return http(method || (body === undefined ? 'GET' : 'POST'), FN + '/api' + path,
    { body, headers: { apikey: ANON_KEY, authorization: 'Bearer ' + SERVICE_KEY } });
}

// ---- TOTP (RFC 6238) — 二段階認証を本当に通す ----
function base32Decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(str).replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, t = Date.now()) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function findAuthUser(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

async function waitForMail(to, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await http('GET', MAILPIT + '/api/v1/search?query=' + encodeURIComponent('to:' + to));
    const msgs = (r.json && r.json.messages) || [];
    if (msgs.length) return msgs;
    await new Promise(res => setTimeout(res, 500));
  }
  return [];
}

async function createReservationTx(startIso, endIso, label) {
  const p = {
    idempotency_key: 'b2-test-' + crypto.randomBytes(12).toString('hex'),
    request_hash: 'b2-test', asset_id: ASSET, start_at: startIso, end_at: endIso,
    customer: { name: 'テスト ' + label, kana: 'テスト', email: 'b2-cust-' + RAND + '@example.com', phone: CUSTOMER_PHONE, company: '' },
    payment_method: 'onsite', license_confirmed: true, option_ids: [], options: [], price: {}, total: 1000,
    note: '', consent: {}, emails: []
  };
  const { data, error } = await svc.rpc('create_reservation_tx', { p });
  if (error) throw new Error('create_reservation_tx: ' + error.message);
  const id = data.reservation.id;
  reservationIds.push(id);
  await parkJobs(id);
  return id;
}

/**
 * 予約の変更で積まれた gcal_sync ジョブを「処理済み」にしておく。
 * このテストは processGcalJob を直接呼ぶので、他の担当のワーカーが同じジョブを同時に拾って
 * 競合しないようにする (後片付けで行ごと消す)。
 */
async function parkJobs(id) {
  const { error } = await svc.from('outbox').update({ status: 'skipped', last_error: 'B2 テストで直接処理' })
    .eq('ref_id', id).eq('template', 'gcal_sync').eq('status', 'pending');
  if (error) throw error;
}

async function reservationRow(id) {
  const { data, error } = await svc.from('reservations').select('id, status, start_at, end_at, gcal_events').eq('id', id).single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// 準備と後片付け
// ---------------------------------------------------------------------
before(async () => {
  try {
    const g = await fetch(GMOCK + '/_mock/requests').catch(() => null);
    if (!g || !g.ok) { env = { ok: false, why: 'Google モック (127.0.0.1:8979) が起動していません' }; return; }
    const s = await svc.from('locations').select('id').limit(1);
    if (s.error) { env = { ok: false, why: 'Supabase に接続できません' }; return; }
    await new Promise((res, rej) => execFile('deno', ['--version'], (e) => (e ? rej(e) : res())));
  } catch (e) {
    env = { ok: false, why: '前提が揃っていません: ' + e.message };
    return;
  }
  origCalendar = await readCalendarSetting();

  let r = await svc.from('locations').insert({ id: LOC, name: 'B2テスト拠点 ' + RAND, address: '北海道テスト市1-1', sort: 999 });
  if (r.error) throw r.error;
  r = await svc.from('assets').insert({
    id: ASSET, category_id: 'cat-rental', location_id: LOC, name: ASSET_NAME, price_hour: 1000, price_day: 6000, sort: 999
  });
  if (r.error) throw r.error;

  for (const [id, access] of [[CAL_A, 'writer'], [CAL_B, 'writer'], [CAL_FB, 'freeBusyOnly'], [CAL_NONE, 'none']]) {
    const m = await mockCal(id, access);
    assert.equal(m.status, 200);
  }

  // api が実装済みか (functions serve がファイル変更で再読込中のこともあるので少し待つ)
  for (let i = 0; i < 10 && !apiReady; i++) {
    if (i) await new Promise(res => setTimeout(res, 1500));
    const probe = await api('/availability?from=' + encodeURIComponent(at(0, 0)) + '&to=' + encodeURIComponent(at(2, 0)), undefined, 'GET').catch(() => null);
    apiReady = !!(probe && probe.status === 200 && probe.json && probe.json.ok === true && probe.json.staff);
  }
  env = { ok: true, why: '' };
});

after(async () => {
  if (!env.ok) return;
  const errors = [];
  try { await restoreCalendar(); } catch (e) { errors.push('設定の復元: ' + e.message); }
  try { await drainFail(503); } catch (e) { /* モック停止中 */ }
  const { data: rows } = await svc.from('reservations').select('id').eq('asset_id', ASSET);
  const ids = [...new Set([...(rows || []).map(x => x.id), ...reservationIds])];
  if (ids.length) {
    let r = await svc.from('outbox').delete().in('ref_id', ids).eq('ref_type', 'reservation');
    if (r.error) errors.push('outbox: ' + r.error.message);
    r = await svc.from('reservations').delete().in('id', ids);
    if (r.error) errors.push('reservations: ' + r.error.message);
  }
  let r = await svc.from('assets').delete().eq('id', ASSET);
  if (r.error) errors.push('assets: ' + r.error.message);
  r = await svc.from('locations').delete().eq('id', LOC);
  if (r.error) errors.push('locations: ' + r.error.message);
  r = await svc.from('calendar_cache').delete().like('key', '%:' + LOC + ':%');
  if (r.error) errors.push('calendar_cache: ' + r.error.message);
  for (const id of authUserIds) {
    const d = await svc.auth.admin.deleteUser(id);
    if (d.error) errors.push('auth user: ' + d.error.message);
  }
  if (errors.length) throw new Error('後片付けに失敗: ' + errors.join(' / '));
});

function need(t) {
  if (!env.ok) { t.skip(env.why); return false; }
  return true;
}

// ---------------------------------------------------------------------
// 1. 判定 (staff-calendar.ts を直接呼ぶ)
// ---------------------------------------------------------------------
describe('担当者の空き判定 (§3.1 / §3.2)', () => {
  it('handover: 担当者の予定と貸出時刻が重なると STAFF_UNAVAILABLE、30 分ずらせば予約可', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    await mockEvent(CAL_A, { summary: '打ち合わせ (社外秘)', start: at(0, 10), end: at(0, 11) });
    await mockEvent(CAL_A, { summary: '通院', start: at(2, 14), end: at(2, 15) });

    let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(0, 10, 30), end: at(1, 16) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'STAFF_UNAVAILABLE');
    assert.match(r.message, /貸出/);

    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(0, 11), end: at(1, 16) });
    assert.deepEqual(r, { ok: true }, '予定の終わり (11:00) からの受け渡しは可能');
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(0, 9, 30), end: at(1, 16) });
    assert.deepEqual(r, { ok: true }, '9:30〜10:00 の受け渡しは予定 (10:00〜) と重ならない');

    // 返却時刻の側も判定する
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(1, 9), end: at(2, 14, 15) });
    assert.equal(r.code, 'STAFF_UNAVAILABLE');
    assert.match(r.message, /返却/);

    // 未登録の拠点・連携無効は判定しない
    r = await denoCall('checkStaffForReservation', { locationId: 'loc-kitami', start: at(0, 10, 30), end: at(1, 16) });
    assert.deepEqual(r, { ok: true });
  });

  it('終日の「休み」(transparent の終日予定) がある日は受け渡し不可', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    await mockEvent(CAL_A, { summary: '休み', start: ymd(3), end: ymd(4), allDay: true }); // モックは終日を transparent で作る
    let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(3, 13), end: at(5, 13) });
    assert.equal(r.code, 'STAFF_UNAVAILABLE');
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(4, 0, 0), end: at(5, 13) });
    assert.deepEqual(r, { ok: true }, '翌日 0:00 からは休みの範囲外');
  });

  it('自分が「不参加」の予定・予定なし (transparent) の時間指定予定は数えない', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    await mockEvent(CAL_A, { summary: '欠席する会議', start: at(6, 10), end: at(6, 11), attendees: [{ email: CAL_A, self: true, responseStatus: 'declined' }] });
    await mockEvent(CAL_A, { summary: 'メモ', start: at(6, 13), end: at(6, 14), transparency: 'transparent' });
    let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(6, 10, 15), end: at(6, 13, 15) });
    assert.deepEqual(r, { ok: true });
  });

  it('Google が自動で作る終日の予定 (勤務場所・誕生日) は数えない', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    for (const [eventType, summary] of [['workingLocation', 'オフィス'], ['birthday', '誰かの誕生日']]) {
      const r = await gapi('POST', '/calendars/' + encodeURIComponent(CAL_A) + '/events', {
        summary, eventType, transparency: 'transparent', start: { date: ymd(16) }, end: { date: ymd(17) }
      });
      assert.equal(r.status, 200);
    }
    const r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(16, 10), end: at(16, 18) });
    assert.deepEqual(r, { ok: true });
  });

  it('サービスアカウント鍵が未設定: 判定は CALENDAR_UNAVAILABLE (failOpen=false)、書き込みは skipped', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover', failOpen: false }, [CAL_A]);
    const noKey = { GOOGLE_SERVICE_ACCOUNT_JSON: '' };
    let r = await denoCallWith(noKey, 'checkStaffForReservation', { locationId: LOC, start: at(18, 10), end: at(18, 18) });
    assert.equal(r.code, 'CALENDAR_UNAVAILABLE');
    const a = await denoCallWith(noKey, 'getStaffAvailability', { from: at(18, 0), to: at(19, 0) });
    assert.equal(a.locations[LOC].configured, true);
    assert.equal(a.locations[LOC].unavailable, true);
    const id = await createReservationTx(at(18, 10), at(18, 18), '鍵なし');
    r = await denoCallWith(noKey, 'processGcalJob', { payload: { reservation_id: id } });
    assert.equal(r.status, 'skipped');
    assert.match(r.error, /未設定/);
    // 壊れた鍵でも落ちない
    r = await denoCallWith({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not-a-key' }, 'checkStaffForReservation', { locationId: LOC, start: at(18, 10), end: at(18, 18) });
    assert.equal(r.code, 'CALENDAR_UNAVAILABLE');
    await setCalendar({ mode: 'handover', failOpen: true }, [CAL_A]);
    r = await denoCallWith(noKey, 'checkStaffForReservation', { locationId: LOC, start: at(18, 10), end: at(18, 18) });
    assert.equal(r.ok, true);
  });

  it('1 拠点に 2 人登録: 1 人だけ予定ありなら予約可、2 人とも埋まっていれば不可', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A, CAL_B]);
    // CAL_A は基準日 10:00〜11:00 が埋まっている (上のテスト)。CAL_B は空き
    let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(0, 10, 30), end: at(1, 16) });
    assert.deepEqual(r, { ok: true });
    await mockEvent(CAL_B, { summary: '外出', start: at(0, 10, 15), end: at(0, 12) });
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(0, 10, 30), end: at(1, 16) });
    assert.equal(r.code, 'STAFF_UNAVAILABLE');
  });

  it('day モード: 貸出日・返却日に予定が 1 件でもあれば不可 / 当社の書いた予定は無視', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'day' }, [CAL_A]);
    await mockEvent(CAL_A, { summary: '夕方の用事', start: at(7, 18), end: at(7, 19) });
    let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(7, 9), end: at(8, 9) });
    assert.equal(r.code, 'STAFF_UNAVAILABLE', '同じ日の夕方に予定がある');
    assert.match(r.message, /貸出日/);
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(8, 9), end: at(9, 17) });
    assert.deepEqual(r, { ok: true });

    // 当社が書いた予定 (extendedProperties.private.skyrent) は「予定なし」でなくても数えない
    const ins = await gapi('POST', '/calendars/' + encodeURIComponent(CAL_A) + '/events', {
      summary: '【貸出】R99999 他の予約', start: { dateTime: at(10, 10) }, end: { dateTime: at(10, 11) },
      transparency: 'opaque', extendedProperties: { private: { skyrent: 'R99999' } }
    });
    assert.equal(ins.status, 200);
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(10, 9), end: at(11, 9) });
    assert.deepEqual(r, { ok: true });
  });

  it('freeBusyOnly の共有は freeBusy で判定する / 共有なしは読めない扱い', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_FB]);
    await mockEvent(CAL_FB, { summary: '来客', start: at(12, 10), end: at(12, 11) });
    let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(12, 10, 30), end: at(13, 10) });
    assert.equal(r.code, 'STAFF_UNAVAILABLE');
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(12, 11), end: at(13, 10) });
    assert.deepEqual(r, { ok: true });

    // 共有されていないカレンダーしか無い → 確認できない (failOpen=false なら CALENDAR_UNAVAILABLE)
    await setCalendar({ mode: 'handover', failOpen: false }, [CAL_NONE]);
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(12, 13), end: at(13, 13) });
    assert.equal(r.code, 'CALENDAR_UNAVAILABLE');
    // 読める人が空いていれば、読めない人がいても予約可
    await setCalendar({ mode: 'handover', failOpen: false }, [CAL_NONE, CAL_A]);
    r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(12, 13), end: at(13, 13) });
    assert.deepEqual(r, { ok: true });
  });

  it('Google 障害: failOpen=false → CALENDAR_UNAVAILABLE、failOpen=true → 予約可', async (t) => {
    if (!need(t)) return;
    try {
      await setCalendar({ mode: 'handover', failOpen: false }, [CAL_A]);
      await mockFail(503, 40);
      let r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(14, 10), end: at(15, 10) });
      assert.equal(r.code, 'CALENDAR_UNAVAILABLE');
      assert.match(r.message, /担当者の予定を確認でき/);
      await drainFail(503);

      await setCalendar({ mode: 'handover', failOpen: true }, [CAL_A]);
      await mockFail(503, 40);
      r = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(14, 10), end: at(15, 10) });
      assert.equal(r.ok, true);
    } finally {
      await drainFail(503);
    }
  });

  it('getStaffAvailability: カレンダーごとの busy を返し、件名・カレンダー ID を含まない (5 分キャッシュ)', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A, CAL_B]);
    const range = { from: at(-1, 0), to: at(20, 0) };
    const a = await denoCall('getStaffAvailability', range);
    assert.equal(a.enabled, true);
    assert.equal(a.mode, 'handover');
    assert.equal(a.handoverMinutes, 30);
    assert.equal(a.oneHandoverAtATime, true);
    const loc = a.locations[LOC];
    assert.ok(loc && loc.configured, 'テスト拠点が configured');
    assert.equal(loc.calendars.length, 2);
    const txt = JSON.stringify(a);
    for (const secret of ['打ち合わせ', '社外秘', '通院', '休み', CAL_A, CAL_B, 'summary']) {
      assert.ok(!txt.includes(secret), '公開結果に「' + secret + '」が含まれている');
    }
    const aBusy = loc.calendars[0].busy.map(b => b.start + '/' + b.end);
    assert.ok(aBusy.includes(at(0, 10) + '/' + at(0, 11)), 'CAL_A の 10:00〜11:00');
    assert.ok(aBusy.includes(at(3, 0) + '/' + at(4, 0)), '終日の休みが busy に入る');
    assert.ok(!aBusy.some(x => x.startsWith(at(10, 10))), '当社の予定は busy に入らない');
    assert.ok(!aBusy.some(x => x.startsWith(at(6, 10)) || x.startsWith(at(6, 13))), '不参加・予定なしは busy に入らない');
    // 拠点全体の busy = 全員が埋まっている時間帯 (CAL_A 10:00-11:00 ∩ CAL_B 10:15-12:00)
    assert.deepEqual(loc.busy, [{ start: at(0, 10, 15), end: at(0, 11) }]);
    // 未設定の拠点は configured:false
    for (const [id, l] of Object.entries(a.locations)) if (id !== LOC && (origCalendar?.locations?.[id]?.calendarIds || []).length === 0) assert.equal(l.configured, false);

    // キャッシュ: 行ができ、2 回目は Google に聞かない
    const { data: rows } = await svc.from('calendar_cache').select('key').like('key', '%:' + LOC + ':%');
    assert.ok(rows.length >= 1, 'calendar_cache に保存される');
    const before = ((await http('GET', GMOCK + '/_mock/requests')).json || []).length;
    const b = await denoCall('getStaffAvailability', range);
    const afterN = ((await http('GET', GMOCK + '/_mock/requests')).json || []).length;
    assert.deepEqual(b.locations[LOC], loc);
    const mine = ((await http('GET', GMOCK + '/_mock/requests')).json || []).slice(before, afterN)
      .filter(q => q.path.includes(encodeURIComponent(CAL_A)) || q.path.includes(encodeURIComponent(CAL_B)));
    assert.equal(mine.length, 0, 'キャッシュが効いていない');
  });
});

// ---------------------------------------------------------------------
// 2. 予約 → 担当者カレンダー (gcal_sync)
// ---------------------------------------------------------------------
describe('予約の書き込み (§3.3 gcal_sync)', () => {
  it('確定 → 貸出・返却の 2 件 / 日時変更 → 更新 / Google で消された予定は作り直す / 取消 → 削除', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover', handoverMinutes: 30, writeEvents: true }, [CAL_A, CAL_B]);
    const id = await createReservationTx(at(30, 10), at(31, 15), '確定');
    const { data: jobs } = await svc.from('outbox').select('id, template, status').eq('ref_id', id).eq('template', 'gcal_sync');
    assert.ok(jobs.length >= 1, '予約の作成で gcal_sync ジョブが積まれる');

    let res = await denoCall('processGcalJob', { id: jobs[0].id, ref_id: id, payload: { reservation_id: id } });
    assert.deepEqual(res, { status: 'sent' });
    let evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    assert.equal(evs.length, 2, '先頭のカレンダーに 2 件');
    assert.equal((await ourEvents(CAL_B, id)).length, 0, '2 番目のカレンダーには書かない');
    const pickup = evs.find(e => e.extendedProperties.private.skyrentKind === 'pickup');
    const ret = evs.find(e => e.extendedProperties.private.skyrentKind === 'return');
    assert.ok(pickup && ret);
    assert.equal(pickup.summary, '【貸出】' + id + ' ' + ASSET_NAME + ' / テスト 確定 様');
    assert.equal(ret.summary, '【返却】' + id + ' ' + ASSET_NAME + ' / テスト 確定 様');
    for (const e of [pickup, ret]) {
      assert.equal(e.transparency, 'transparent');
      assert.equal(e.extendedProperties.private.skyrent, id);
      assert.equal(e.start.timeZone, 'Asia/Tokyo');
      assert.ok(!JSON.stringify(e).includes(CUSTOMER_PHONE) && !JSON.stringify(e).includes('09012345678'), '電話番号を送らない');
      assert.ok(!JSON.stringify(e).includes('b2-cust-'), 'メールアドレスを送らない');
      assert.match(e.description, /manage\/reservation-list\.html/);
      assert.match(e.description, new RegExp('予約番号: ' + id));
    }
    assert.equal(Date.parse(pickup.start.dateTime), Date.parse(at(30, 10)));
    assert.equal(Date.parse(pickup.end.dateTime), Date.parse(at(30, 10, 30)));
    assert.equal(Date.parse(ret.start.dateTime), Date.parse(at(31, 15)));
    let row = await reservationRow(id);
    assert.deepEqual(row.gcal_events, {
      pickup: { calendarId: CAL_A, eventId: pickup.id }, return: { calendarId: CAL_A, eventId: ret.id }
    });

    // 当社の予定は空き判定に影響しない (確定した予約の時刻でも、担当者は空き扱い)
    let chk = await denoCall('checkStaffForReservation', { locationId: LOC, start: at(30, 10), end: at(32, 10) });
    assert.deepEqual(chk, { ok: true });

    // 日時変更 → 同じ予定を更新
    let u = await svc.from('reservations').update({ period: '[' + at(30, 13) + ',' + at(32, 11) + ')' }).eq('id', id);
    assert.ifError(u.error);
    await parkJobs(id);
    res = await denoCall('processGcalJob', { ref_id: id, payload: { reservation_id: id } });
    assert.deepEqual(res, { status: 'sent' });
    evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    assert.equal(evs.length, 2);
    const p2 = evs.find(e => e.extendedProperties.private.skyrentKind === 'pickup');
    const r2 = evs.find(e => e.extendedProperties.private.skyrentKind === 'return');
    assert.equal(p2.id, pickup.id, '予定 ID は同じ (更新)');
    assert.equal(r2.id, ret.id);
    assert.equal(Date.parse(p2.start.dateTime), Date.parse(at(30, 13)));
    assert.equal(Date.parse(r2.start.dateTime), Date.parse(at(32, 11)));
    assert.match(p2.description, /返却: .*11:00/);

    // Google 側で貸出の予定が消されていたら作り直す
    const del = await gapi('DELETE', '/calendars/' + encodeURIComponent(CAL_A) + '/events/' + encodeURIComponent(pickup.id));
    assert.equal(del.status, 204);
    u = await svc.from('reservations').update({ period: '[' + at(30, 14) + ',' + at(32, 11) + ')' }).eq('id', id);
    assert.ifError(u.error);
    await parkJobs(id);
    res = await denoCall('processGcalJob', { ref_id: id, payload: { reservation_id: id } });
    assert.deepEqual(res, { status: 'sent' });
    evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    assert.equal(evs.length, 2, '作り直して 2 件');
    const p3 = evs.find(e => e.extendedProperties.private.skyrentKind === 'pickup');
    assert.notEqual(p3.id, pickup.id);
    assert.equal(Date.parse(p3.start.dateTime), Date.parse(at(30, 14)));
    row = await reservationRow(id);
    assert.equal(row.gcal_events.pickup.eventId, p3.id);

    // 取消 → 2 件とも削除、予定 ID を消す
    u = await svc.from('reservations').update({ status: 'cancelled', cancelled_by: 'staff' }).eq('id', id);
    assert.ifError(u.error);
    await parkJobs(id);
    res = await denoCall('processGcalJob', { ref_id: id, payload: { reservation_id: id } });
    assert.deepEqual(res, { status: 'sent' });
    evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    assert.equal(evs.length, 0, '取消で削除');
    row = await reservationRow(id);
    assert.deepEqual(row.gcal_events, {});
    // もう一度流しても成功 (既に無い)
    res = await denoCall('processGcalJob', { ref_id: id, payload: { reservation_id: id } });
    assert.deepEqual(res, { status: 'sent' });
  });

  it('予定 ID を保存し損ねても重複して作らない / 書き込み権限が無ければ failed / 予約が無ければ skipped', async (t) => {
    if (!need(t)) return;
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    const id = await createReservationTx(at(34, 10), at(35, 10), '重複');
    assert.deepEqual(await denoCall('processGcalJob', { payload: { reservation_id: id } }), { status: 'sent' });
    // 予定 ID が保存されていない状態を作る (ワーカーが途中で落ちた想定)
    const r = await svc.rpc('set_reservation_gcal_events', { p_id: id, p_events: {} });
    assert.ifError(r.error);
    assert.deepEqual(await denoCall('processGcalJob', { payload: { reservation_id: id } }), { status: 'sent' });
    const evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    assert.equal(evs.length, 2, '当社の印で見つけて更新する (重複しない)');

    await setCalendar({ mode: 'handover' }, [CAL_FB]);
    const id2 = await createReservationTx(at(36, 10), at(37, 10), '権限なし');
    const res = await denoCall('processGcalJob', { payload: { reservation_id: id2 } });
    assert.equal(res.status, 'failed');
    assert.match(res.error, /権限|共有/);

    assert.equal((await denoCall('processGcalJob', { payload: { reservation_id: 'R-NOPE-' + RAND } })).status, 'skipped');
  });
});

// ---------------------------------------------------------------------
// 3. HTTP (api) — B1 の api が実装済みのときだけ
// ---------------------------------------------------------------------
describe('api 経由 (/api/availability・/api/quote・/api/reservations)', () => {
  async function legalConsent() {
    const { data } = await svc.from('legal_documents').select('id, version').eq('active', true);
    return { documents: (data || []).filter(d => ['clause', 'cancel', 'privacy'].includes(d.id)).map(d => ({ id: d.id, version: d.version })), agreedAt: new Date().toISOString() };
  }

  it('担当者の予定と重なる時刻は quote / reservations で STAFF_UNAVAILABLE、30 分ずらせば可', async (t) => {
    if (!need(t)) return;
    if (!apiReady) { t.skip('api がまだ実装されていません'); return; }
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    // CAL_A は基準日 10:00〜11:00 が埋まっている
    let q = await api('/quote', { assetId: ASSET, start: at(0, 10, 30), end: at(1, 16), optionIds: [] });
    assert.equal(q.status, 200, q.text);
    assert.equal(q.json.availability.staff, false);
    assert.ok(q.json.availability.reasons.includes('STAFF_UNAVAILABLE'));

    const body = {
      idempotencyKey: 'b2-api-' + crypto.randomBytes(12).toString('hex'), assetId: ASSET,
      start: at(0, 10, 30), end: at(1, 16), optionIds: [],
      customer: { name: 'テスト API', kana: 'テスト エーピーアイ', email: 'b2-api-' + RAND + '@example.com', phone: CUSTOMER_PHONE, company: '' },
      paymentMethod: 'onsite', licenseConfirmed: true, note: '', expectedTotal: q.json.quote.total, consent: await legalConsent()
    };
    let r = await api('/reservations', body);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'STAFF_UNAVAILABLE');

    q = await api('/quote', { assetId: ASSET, start: at(0, 11), end: at(1, 16), optionIds: [] });
    assert.equal(q.status, 200, q.text);
    assert.equal(q.json.availability.staff, true);
  });

  it('予約確定 → モックのカレンダーに 2 件、取消 → 削除 (worker 経由)', async (t) => {
    if (!need(t)) return;
    if (!apiReady) { t.skip('api がまだ実装されていません'); return; }
    await setCalendar({ mode: 'handover' }, [CAL_A]);
    const start = at(40, 10), end = at(40, 18);
    const q = await api('/quote', { assetId: ASSET, start, end, optionIds: [] });
    assert.equal(q.status, 200, q.text);
    const r = await api('/reservations', {
      idempotencyKey: 'b2-api-' + crypto.randomBytes(12).toString('hex'), assetId: ASSET, start, end, optionIds: [],
      customer: { name: 'テスト 確定', kana: 'テスト カクテイ', email: 'b2-api-' + RAND + '@example.com', phone: CUSTOMER_PHONE, company: '' },
      paymentMethod: 'onsite', licenseConfirmed: true, note: '', expectedTotal: q.json.quote.total, consent: await legalConsent()
    });
    assert.equal(r.status, 200, r.text);
    const id = r.json.reservation.id;
    reservationIds.push(id);
    // worker は予約確定の中で同期実行される (待ち最大 8 秒)。間に合わなければ admin から流す
    let evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    t.diagnostic(evs.length === 2 ? '予約確定の同期ワーカーでカレンダーに反映済み' : '同期ワーカーでは未反映 → admin/outbox/process で反映');
    if (evs.length < 2) {
      const tok = userJwt(await adminUserId(), 'aal2', 'admin@example.com');
      await admin('/outbox/process', tok, { refIds: [id] });
      evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    }
    assert.equal(evs.length, 2);
    assert.ok(evs.every(e => e.transparency === 'transparent'));

    const c = await api('/reservations/cancel', { id, token: r.json.guestToken, expectedFee: 0 });
    assert.equal(c.status, 200, c.text);
    const tok = userJwt(await adminUserId(), 'aal2', 'admin@example.com');
    const p = await admin('/outbox/process', tok, { refIds: [id] });
    assert.equal(p.status, 200, p.text);
    evs = (await ourEvents(CAL_A, id)).filter(e => e.status !== 'cancelled');
    assert.equal(evs.length, 0, '取消で削除');
  });

  it('Google 障害: failOpen=false → CALENDAR_UNAVAILABLE (503)、true → 予約可', async (t) => {
    if (!need(t)) return;
    if (!apiReady) { t.skip('api がまだ実装されていません'); return; }
    try {
      await setCalendar({ mode: 'handover', failOpen: false }, [CAL_A]);
      const start = at(42, 10), end = at(42, 18);
      const q0 = await api('/quote', { assetId: ASSET, start, end, optionIds: [] });
      assert.equal(q0.status, 200, q0.text);
      await mockFail(503, 60);
      const r = await api('/reservations', {
        idempotencyKey: 'b2-api-' + crypto.randomBytes(12).toString('hex'), assetId: ASSET, start, end, optionIds: [],
        customer: { name: 'テスト 障害', kana: 'テスト ショウガイ', email: 'b2-api-' + RAND + '@example.com', phone: CUSTOMER_PHONE, company: '' },
        paymentMethod: 'onsite', licenseConfirmed: true, note: '', expectedTotal: q0.json.quote.total, consent: await legalConsent()
      });
      assert.equal(r.status, 503, r.text);
      assert.equal(r.json.code, 'CALENDAR_UNAVAILABLE');
      await drainFail(503);

      await setCalendar({ mode: 'handover', failOpen: true }, [CAL_A]);
      await mockFail(503, 60);
      const q = await api('/quote', { assetId: ASSET, start, end, optionIds: [] });
      assert.equal(q.status, 200, q.text);
      assert.equal(q.json.availability.staff, true);
    } finally {
      await drainFail(503);
    }
  });

  it('/api/availability の staff はカレンダーごとの busy を返し、予定の内容を含まない', async (t) => {
    if (!need(t)) return;
    if (!apiReady) { t.skip('api がまだ実装されていません'); return; }
    await setCalendar({ mode: 'handover' }, [CAL_A, CAL_B]);
    const r = await api('/availability?from=' + encodeURIComponent(at(-1, 0)) + '&to=' + encodeURIComponent(at(20, 0)), undefined, 'GET');
    assert.equal(r.status, 200, r.text);
    const st = r.json.staff;
    assert.equal(st.enabled, true);
    const loc = st.locations[LOC];
    assert.ok(loc && loc.configured);
    assert.equal(loc.calendars.length, 2);
    assert.ok(loc.calendars[0].busy.some(b => b.start === new Date(at(0, 10)).toISOString()));
    for (const secret of ['打ち合わせ', '社外秘', '通院', '休み', '外出', CAL_A, CAL_B, 'summary', 'description']) {
      assert.ok(!r.text.includes(secret), '公開結果に「' + secret + '」が含まれている');
    }
  });
});

// ---------------------------------------------------------------------
// 4. admin
// ---------------------------------------------------------------------
let _adminId = null;
async function adminUserId() {
  if (_adminId) return _adminId;
  const u = await findAuthUser('admin@example.com');
  assert.ok(u, '管理者アカウント admin@example.com がありません');
  _adminId = u.id;
  return _adminId;
}

describe('admin Edge Function (§2.2)', () => {
  it('未ログイン → 401、AAL1 → 403、不明なパス → 404', async (t) => {
    if (!need(t)) return;
    const id = await adminUserId();
    let r = await admin('/calendar/status', null);
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'UNAUTHENTICATED');
    r = await admin('/calendar/status', userJwt(id, 'aal1', 'admin@example.com'));
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'FORBIDDEN');
    r = await admin('/staff/list', userJwt(id, 'aal1', 'admin@example.com'), {});
    assert.equal(r.status, 403);
    r = await admin('/nope', userJwt(id, 'aal2', 'admin@example.com'), {});
    assert.equal(r.status, 404);
  });

  it('AAL2 管理者: calendar/status (events / freeBusyOnly / none) と calendar/test', async (t) => {
    if (!need(t)) return;
    const tok = userJwt(await adminUserId(), 'aal2', 'admin@example.com');
    await setCalendar({ mode: 'handover' }, [CAL_A, CAL_FB, CAL_NONE]);
    let r = await admin('/calendar/status', tok);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.serviceAccountEmail, SA.client_email);
    const list = r.json.locations[LOC];
    assert.deepEqual(list.map(x => [x.calendarId, x.access]), [[CAL_A, 'events'], [CAL_FB, 'freeBusyOnly'], [CAL_NONE, 'none']]);
    assert.ok(list[2].error, '共有なしには理由が付く');
    assert.ok(Array.isArray(r.json.locations['loc-kitami'] || []), '全拠点が並ぶ');

    // calendar/test: 今後 7 日の予定あり時間帯の件数
    const tomorrow = TODAY_JST + DAY;
    await mockEvent(CAL_A, { summary: '近日の予定', start: new Date(tomorrow + 10 * 3600000).toISOString(), end: new Date(tomorrow + 11 * 3600000).toISOString() });
    r = await admin('/calendar/test', tok, { calendarId: CAL_A });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.access, 'events');
    assert.equal(r.json.busyCount, 1);
    r = await admin('/calendar/test', tok, { calendarId: CAL_FB });
    assert.equal(r.json.access, 'freeBusyOnly');
    r = await admin('/calendar/test', tok, { calendarId: CAL_NONE });
    assert.equal(r.json.access, 'none');
    r = await admin('/calendar/test', tok, { calendarId: '' });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'VALIDATION');
    assert.ok(r.json.fields.calendarId);
  });

  it('AAL2 管理者: staff/list・members/invite (Mailpit に招待メール)・staff/invite・outbox/process', async (t) => {
    if (!need(t)) return;
    const adminId = await adminUserId();
    const tok = userJwt(adminId, 'aal2', 'admin@example.com');

    let r = await admin('/staff/list', tok, {});
    assert.equal(r.status, 200, r.text);
    const me = r.json.staff.find(s => s.userId === adminId);
    assert.ok(me, '管理者自身が一覧にいる');
    assert.equal(me.role, 'admin');
    assert.equal(typeof me.mfaEnabled, 'boolean');
    assert.ok('lastSignInAt' in me);

    // 会員の招待
    const memberEmail = 'b2-invite-' + RAND + '@example.com';
    r = await admin('/members/invite', tok, { email: memberEmail, name: 'テスト 招待', name_kana: 'テスト ショウタイ', phone: '090-0000-0000', company: '', invoiceAllowed: true });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.userId);
    authUserIds.push(r.json.userId);
    const mails = await waitForMail(memberEmail);
    assert.ok(mails.length >= 1, 'Mailpit に招待メールが届く');
    const { data: m } = await svc.from('members').select('user_id, name, invoice_allowed').eq('user_id', r.json.userId).single();
    assert.equal(m.name, 'テスト 招待');
    assert.equal(m.invoice_allowed, true);
    // 招待中 (メール未確認) のアドレスは招待メールを送り直す / 登録済みのアドレスは 409
    r = await admin('/members/invite', tok, { email: memberEmail, name: 'テスト 招待' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.resent, true);
    assert.equal(r.json.userId, authUserIds[authUserIds.length - 1]);
    r = await admin('/members/invite', tok, { email: 'admin@example.com', name: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'CONFLICT');
    // 入力不備
    r = await admin('/members/invite', tok, { email: 'not-an-email' });
    assert.equal(r.status, 400);
    assert.ok(r.json.fields.email);

    // スタッフの招待 (新規ユーザー)
    const staffEmail = 'b2-staff-' + RAND + '@example.com';
    r = await admin('/staff/invite', tok, { email: staffEmail, name: 'テスト スタッフ', role: 'store_staff', locationIds: [LOC] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.invited, true);
    authUserIds.push(r.json.userId);
    assert.ok((await waitForMail(staffEmail)).length >= 1, 'スタッフにも招待メールが届く');
    // 既存ユーザー (上の会員) をスタッフにする → staff 行だけ作る
    r = await admin('/staff/invite', tok, { email: memberEmail, name: 'テスト 兼務', role: 'viewer', locationIds: null });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.invited, false);
    r = await admin('/staff/invite', tok, { email: memberEmail, name: 'テスト 兼務', role: 'viewer' });
    assert.equal(r.status, 409, '既にスタッフ');
    r = await admin('/staff/invite', tok, { email: 'b2-x-' + RAND + '@example.com', name: 'x', role: 'boss' });
    assert.equal(r.status, 400);
    assert.ok(r.json.fields.role);
    r = await admin('/staff/list', tok, {});
    const invited = r.json.staff.find(s => s.email === staffEmail);
    assert.ok(invited);
    assert.equal(invited.role, 'store_staff');
    assert.deepEqual(invited.locationIds, [LOC]);
    assert.equal(invited.mfaEnabled, false);
    assert.equal(invited.lastSignInAt, null);

    // ワーカーを 1 回実行 (対象をこのテストの予約に絞る)
    r = await admin('/outbox/process', tok, { refIds: ['R-NOPE-' + RAND] });
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.processed, 'number');
    assert.ok(Array.isArray(r.json.results));
  });

  it('viewer (本物の TOTP で AAL2) は admin の操作をすべて 403 / 一覧では mfaEnabled=true', async (t) => {
    if (!need(t)) return;
    const email = 'b2-viewer-' + RAND + '@example.com';
    const password = 'Vw-' + crypto.randomBytes(9).toString('base64url') + '9a';
    const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ifError(error);
    authUserIds.push(data.user.id);
    const ins = await svc.from('staff').insert({ user_id: data.user.id, name: 'テスト 閲覧', email, role: 'viewer' });
    assert.ifError(ins.error);

    // パスワードでログイン → TOTP を登録・検証して AAL2 のセッションを得る (ユーザーごと後片付けで消す)
    const uc = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const si = await uc.auth.signInWithPassword({ email, password });
    assert.ifError(si.error);
    const aal1 = si.data.session.access_token;
    let r = await admin('/staff/list', aal1, {});
    assert.equal(r.status, 403, 'AAL1 (パスワードのみ) は 403');
    const en = await uc.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'b2-test-' + RAND });
    assert.ifError(en.error);
    const cv = await uc.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: totp(en.data.totp.secret) });
    assert.ifError(cv.error);
    const tok = cv.data.access_token;
    assert.equal(JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).aal, 'aal2');

    for (const [path, body] of [['/calendar/status', undefined], ['/calendar/test', { calendarId: CAL_A }], ['/staff/list', {}],
      ['/members/invite', { email: 'b2-never-' + RAND + '@example.com' }], ['/staff/invite', { email: 'b2-never2-' + RAND + '@example.com', name: 'x', role: 'admin' }],
      ['/outbox/process', {}]]) {
      r = await admin(path, tok, body);
      assert.equal(r.status, 403, path + ' → ' + r.text);
      assert.equal(r.json.code, 'FORBIDDEN');
    }
    assert.equal(await findAuthUser('b2-never-' + RAND + '@example.com'), null, '招待されていない');

    // 管理者の一覧では、このスタッフは二段階認証あり・ログイン済み
    const adminTok = userJwt(await adminUserId(), 'aal2', 'admin@example.com');
    r = await admin('/staff/list', adminTok, {});
    assert.equal(r.status, 200, r.text);
    const v = r.json.staff.find(x => x.userId === data.user.id);
    assert.ok(v);
    assert.equal(v.role, 'viewer');
    assert.equal(v.mfaEnabled, true);
    assert.ok(v.lastSignInAt);
  });
});
