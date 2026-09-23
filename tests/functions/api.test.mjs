/**
 * Edge Functions (api / worker) の結合テスト — 実際に起動している関数へ HTTP で問い合わせる
 *
 * 実行: node --test tests/functions/api.test.mjs
 *
 * 前提 (ローカル検証環境。docs/production/implementation-v1.md §0):
 *   - supabase start 済み (API http://127.0.0.1:54321)
 *   - supabase functions serve --env-file supabase/functions/.env.local が起動中
 *   - Resend モック (tests/mocks/resend-mock.mjs) が :8978 で起動中
 *
 * 守っていること:
 *   - 予約の日時は「今日から150〜390日後のランダムな日」(他のテストとぶつからないように)。
 *     キャンセル料が発生する経路だけは、明日の未明 (3時台) の短い予約を使い、テストの最後に消す。
 *   - Resend モックは reset しない (他のテストのメールを消さない)。宛先・予約番号で絞り込んで確認する。
 *   - 作った予約・問い合わせ・送信キュー・会員はテストの最後に削除する。
 *   - レート制限を試すときは X-Forwarded-For に試験用アドレス (IPv6 の文書用 2001:db8::/32 から実行ごとに選んだ /64) を入れ、
 *     共有の枠を使い切らない (IPv4 の文書用 /24 は 254 個しかなく、10分以内の他の実行と枠が重なることがある)。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
await import(pathToFileURL(join(ROOT, 'js/pricing-core.js')).href);
const Core = globalThis.SkyRentPricingCore;

// ---------------------------------------------------------------------
// 接続先
// ---------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const FUNCTIONS = SUPABASE_URL + '/functions/v1';
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const RESEND_MOCK = process.env.RESEND_MOCK_URL || 'http://127.0.0.1:8978';

function readEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const FN_ENV = readEnvFile(join(ROOT, 'supabase/functions/.env.local'));
const WORKER_SECRET = process.env.WORKER_SECRET || FN_ENV.WORKER_SECRET || '';
const SITE_URL = (FN_ENV.SITE_URL || 'http://127.0.0.1:8901/').replace(/\/?$/, '/');
const ALLOWED_ORIGIN = (FN_ENV.ALLOWED_ORIGINS || 'http://127.0.0.1:8901').split(',')[0].trim();
const SHOP_EMAIL = (FN_ENV.SHOP_NOTIFY_EMAIL || 'shop@growth-rentacar.test').split(',')[0].trim();

const sr = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------
const RUN = randomUUID().slice(0, 8);
const HOUR = 3600e3;
const DAY = 864e5;
let seq = 0;
const created = { reservations: new Set(), inquiries: new Set(), users: new Set() };

function mail(tag) {
  return 'b1-' + RUN + '-' + tag + '-' + (++seq) + '@example.com';
}
/** レート制限の試験用ネットワーク (2001:db8:xxxx:xxxx::/64)。末尾 64 ビットを変えても同じ枠になる */
function testNet() {
  return '2001:db8:' + randomBytes(2).toString('hex') + ':' + randomBytes(2).toString('hex');
}
function key(tag) {
  return 'b1test-' + tag + '-' + RUN + '-' + randomUUID().replace(/-/g, '').slice(0, 12);
}

/** fetch のラッパ。token 省略時は anon key、'service' なら service_role */
async function call(path, { method, body, token, headers } = {}) {
  const auth = token === 'service' ? SERVICE : (token || ANON);
  const h = { apikey: ANON, Authorization: 'Bearer ' + auth, ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(FUNCTIONS + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

/** 日本時間の年月日時分 → ISO (UTC) */
function jstIso(y, m, d, hh, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)).toISOString();
}

/** 今日から 150〜390 日後の、まだ使っていない日の日本時間 hh:mm */
const usedDays = new Set();
function futureSlot(hours, { hh = 10 + Math.floor(Math.random() * 6), mm = 5 * Math.floor(Math.random() * 12) } = {}) {
  let off;
  do { off = 150 + Math.floor(Math.random() * 241); } while (usedDays.has(off));
  usedDays.add(off);
  const p = Core.jstParts(new Date(Date.now() + off * DAY).toISOString());
  const start = jstIso(p.y, p.m, p.d, hh, mm);
  return { start, end: new Date(Date.parse(start) + hours * HOUR).toISOString() };
}

let LEGAL = null;
async function consentAll() {
  if (!LEGAL) {
    const { data, error } = await sr.from('legal_documents').select('id, version').eq('active', true);
    if (error) throw error;
    LEGAL = data;
  }
  return {
    documents: LEGAL.filter((d) => ['clause', 'cancel', 'privacy'].includes(d.id)).map((d) => ({ id: d.id, version: d.version })),
    agreedAt: new Date().toISOString()
  };
}
async function consentPrivacy() {
  const c = await consentAll();
  return { documents: c.documents.filter((d) => d.id === 'privacy'), agreedAt: c.agreedAt };
}

async function quoteOf(p, token = 'service') {
  const r = await call('/api/quote', { body: p, token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.quote;
}

/** 見積 → 予約確定 (既定は service_role で呼ぶ = レート制限の対象外) */
async function reserve(p, { token = 'service', expectedTotal, consent, headers } = {}) {
  const customer = p.customer || { name: 'テスト 太郎', kana: 'テスト タロウ', email: mail('res'), phone: '090-0000-' + String(1000 + (seq % 9000)), company: '' };
  const body = {
    idempotencyKey: p.idempotencyKey || key('res'),
    assetId: p.assetId, start: p.start, end: p.end, optionIds: p.optionIds || [],
    discountType: p.discountType || null, couponId: p.couponId || null,
    customer, paymentMethod: p.paymentMethod || 'onsite', licenseConfirmed: true, note: p.note || '',
    expectedTotal: expectedTotal !== undefined ? expectedTotal
      : (await quoteOf({ assetId: p.assetId, start: p.start, end: p.end, optionIds: p.optionIds || [], discountType: p.discountType || null, couponId: p.couponId || null }, token)).total,
    consent: consent !== undefined ? consent : await consentAll()
  };
  const r = await call('/api/reservations', { body, token, headers });
  if (r.json && r.json.reservation && r.json.reservation.id) created.reservations.add(r.json.reservation.id);
  return { ...r, body };
}

async function mockEmails() {
  const r = await fetch(RESEND_MOCK + '/_mock/emails');
  return r.json();
}
async function emailsTo(addr) {
  return (await mockEmails()).filter((e) => (e.to || []).includes(addr));
}
async function emailsAbout(needle) {
  return (await mockEmails()).filter((e) => String(e.subject || '').includes(needle));
}

async function outboxOf(refId) {
  const { data, error } = await sr.from('outbox').select('*').eq('ref_id', refId).order('id');
  if (error) throw error;
  return data;
}

async function catalog() {
  const { data, error } = await createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } }).rpc('public_catalog');
  if (error) throw error;
  return data;
}

function coreAsset(a) {
  return { id: a.id, categoryId: a.category_id, priceHour: a.price_hour, priceDay: a.price_day, customFields: a.custom_fields || {} };
}
function coreOption(o) {
  return { id: o.id, name: o.name, price: o.price, priceShort: o.price_short, priceType: o.price_type, categoryIds: o.category_ids, exclusiveGroup: o.exclusive_group };
}

/** 会員を作ってログインする (メール確認済み) */
async function makeMember(tag, extra = {}) {
  const email = mail(tag);
  const password = 'Test-Pass-' + RUN + '9';
  const { data, error } = await sr.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { account_type: 'member', name: '会員 ' + tag, name_kana: 'カイイン', phone: '090-1111-2222', ...extra }
  });
  if (error) throw error;
  created.users.add(data.user.id);
  const c = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await c.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { id: data.user.id, email, token: s.data.session.access_token };
}

/** deno で関数のモジュールを直接読み込んで試す (deno が無ければ null) */
function denoEval(code, env = {}) {
  const r = spawnSync('deno', ['eval', '--quiet', code], {
    cwd: join(ROOT, 'supabase/functions'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}), ...env },
    encoding: 'utf8',
    timeout: 120000
  });
  if (r.error && r.error.code === 'ENOENT') return null;
  if (r.status !== 0) throw new Error('deno eval failed: ' + r.stderr);
  return r.stdout.trim().split('\n').pop();
}

// ---------------------------------------------------------------------
// 前提確認・後片付け
// ---------------------------------------------------------------------
before(async () => {
  const r = await call('/api/');
  assert.equal(r.status, 200, 'api 関数が起動していません: ' + JSON.stringify(r.json));
  const m = await fetch(RESEND_MOCK + '/_mock/emails').catch(() => null);
  assert.ok(m && m.ok, 'Resend モック (' + RESEND_MOCK + ') が起動していません');
});

after(async () => {
  // 応答を受け取れなかった (途中で失敗した) ものも、このテストのメールアドレスで拾って消す
  const likeRun = 'b1-' + RUN + '-%';
  const extraRes = await sr.from('reservations').select('id').like('customer_email', likeRun);
  (extraRes.data || []).forEach((r) => created.reservations.add(r.id));
  const extraInq = await sr.from('inquiries').select('id').like('email', likeRun);
  (extraInq.data || []).forEach((r) => created.inquiries.add(r.id));
  const resIds = [...created.reservations];
  const inqIds = [...created.inquiries];
  if (resIds.length || inqIds.length) {
    await sr.from('outbox').delete().in('ref_id', [...resIds, ...inqIds]);
  }
  if (resIds.length) {
    await sr.from('coupons').update({ used_at: null, used_reservation_id: null }).in('used_reservation_id', resIds);
    const { error } = await sr.from('reservations').delete().in('id', resIds);
    if (error) console.warn('予約の削除に失敗しました', error.message);
  }
  if (inqIds.length) await sr.from('inquiries').delete().in('id', inqIds);
  for (const id of created.users) {
    await sr.from('coupons').delete().eq('user_id', id);
    await sr.auth.admin.deleteUser(id).catch(() => {});
  }
});

// =====================================================================
describe('見積 (/api/quote)', () => {
  test('サーバーの見積は pricing-core (DB のカタログ・料金ルール) と一致する', async () => {
    const cat = await catalog();
    const rules = cat.settings.pricing_rules;
    const asset = (id) => cat.assets.find((a) => a.id === id);
    const opts = (ids) => ids.map((id) => cat.options.find((o) => o.id === id));
    const p27 = futureSlot(27);
    const cases = [
      { assetId: 'V001', start: jstIso(2027, 6, 9, 10), end: jstIso(2027, 6, 9, 13), optionIds: [] },               // 時間料金
      { assetId: 'V003', start: p27.start, end: p27.end, optionIds: ['OP101'], discountType: 'student' },             // 延長+補償+割引
      { assetId: 'K001', start: jstIso(2027, 6, 12, 21), end: jstIso(2027, 6, 14, 3), optionIds: ['OP201'], discountType: 'shusei_club' }, // 土日・夜間
      { assetId: 'V004', start: jstIso(2027, 5, 1, 9), end: jstIso(2027, 5, 3, 9), optionIds: ['OP102'] },           // 繁忙期
      { assetId: 'V001', start: jstIso(2027, 6, 9, 10), end: jstIso(2027, 6, 10, 10), optionIds: [], discountType: 'shusei_club' } // 割引の条件外
    ];
    for (const c of cases) {
      const server = await quoteOf(c);
      const local = Core.quote({
        asset: coreAsset(asset(c.assetId)), start: c.start, end: c.end, options: opts(c.optionIds).map(coreOption),
        discountType: c.discountType || null, coupon: null, rules
      });
      assert.deepEqual(server, JSON.parse(JSON.stringify(local)), c.assetId + ' ' + c.start);
    }
  });

  test('見積の入力不備は VALIDATION (fields 付き)、存在しない車両は NOT_FOUND', async () => {
    let r = await call('/api/quote', { body: { assetId: 'V001', start: 'あした', end: '2027-01-01T10:00' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'VALIDATION');
    assert.ok(r.json.fields.start);
    assert.ok(r.json.requestId);
    const s = futureSlot(3);
    r = await call('/api/quote', { body: { assetId: 'NOPE999', start: s.start, end: s.end } });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'NOT_FOUND');
    r = await call('/api/quote', { body: { assetId: 'V001', start: s.start, end: s.end, optionIds: ['OP201'] } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'OPTION_INVALID');
  });
});

// =====================================================================
describe('予約確定 (/api/reservations)', () => {
  test('確定 → DB に保存・Resend にお客様と店舗の2通・email.status=sent', async () => {
    const s = futureSlot(26);
    const email = mail('confirm');
    const r = await reserve({
      assetId: 'V001', start: s.start, end: s.end, optionIds: ['OP101'],
      customer: { name: '予約 花子', kana: 'ヨヤク ハナコ', email, phone: '０９０−１２３４−５６７８', company: '' },
      note: 'チャイルドシート希望'
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { reservation, guestToken, lookupUrl } = r.json;
    assert.match(reservation.id, /^R\d+$/);
    assert.equal(r.json.email.status, 'sent');
    assert.equal(reservation.total, r.body.expectedTotal);
    assert.equal(lookupUrl, SITE_URL + 'mypage.html#lookup=' + reservation.id + '.' + guestToken);

    const { data: row } = await sr.from('reservations').select('*').eq('id', reservation.id).single();
    assert.equal(row.status, 'confirmed');
    assert.equal(row.asset_id, 'V001');
    assert.equal(row.total, reservation.total);
    assert.equal(row.customer_phone, '090-1234-5678', '全角の電話番号は半角にそろえて保存');
    assert.equal(row.license_confirmed, true);
    assert.equal(row.price.base, reservation.price.base);
    assert.ok(Array.isArray(row.price.lines) && row.price.lines.length >= 2);
    assert.equal(row.price.rulesVersion, '2026-06');
    assert.deepEqual(row.option_ids, ['OP101']);
    // 照会キーは平文で保存しない (sha256 だけ)
    assert.equal(row.guest_token_hash, createHash('sha256').update(guestToken).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(guestToken));
    assert.deepEqual(row.consent.documents.map((d) => d.id).sort(), ['cancel', 'clause', 'privacy']);

    // メール: お客様 (予約確定) と店舗 (新規予約)
    const mine = await emailsTo(email);
    assert.equal(mine.length, 1);
    const m = mine[0];
    assert.match(m.subject, /^【グロースレンタカー】ご予約確定/);
    assert.ok(m.subject.includes(reservation.id));
    for (const needle of [reservation.id, '日産 ノート', '北見本店', '北海道北見市', lookupUrl, '運転免許証',
      'キャンセル規定', '合計 (税込)', '¥' + reservation.total.toLocaleString('en-US'), 'https://lin.ee/PuLt0Ig',
      'daichi.fujimoto@skyward-growth.com', '当日店頭']) {
      assert.ok(m.text.includes(needle), 'お客様メールに「' + needle + '」がありません');
    }
    const p = Core.jstParts(reservation.start);
    assert.ok(m.text.includes(p.y + '年' + p.m + '月' + p.d + '日('), '貸出日 (日本時間・曜日付き)');
    const shop = (await emailsAbout(reservation.id)).filter((e) => e.to.includes(SHOP_EMAIL));
    assert.equal(shop.length, 1);
    assert.match(shop[0].subject, /^【グロースレンタカー】新規Web予約/);
    assert.ok(shop[0].text.includes(SITE_URL + 'manage/reservation-list.html'));
    assert.ok(!shop[0].text.includes(email), '店舗宛てにはお客様のメールアドレスを載せない');
    assert.ok(!shop[0].text.includes('090-1234-5678'), '店舗宛てにはお客様の電話番号を載せない');

    // 送信キュー: 送信済み。保存した本文に照会キーは残さない
    const ob = await outboxOf(reservation.id);
    const mails = ob.filter((o) => o.template !== 'gcal_sync');
    assert.deepEqual(mails.map((o) => o.template).sort(), ['reservation_confirmed', 'reservation_new_shop']);
    assert.ok(mails.every((o) => o.status === 'sent' && o.provider_message_id));
    assert.ok(mails.every((o) => !String(o.body_text).includes(guestToken)));

    // 空き状況に反映される (誰の予約かは返さない)
    const av = await call('/api/availability?from=' + encodeURIComponent(new Date(Date.parse(s.start) - DAY).toISOString()) +
      '&to=' + encodeURIComponent(new Date(Date.parse(s.end) + DAY).toISOString()), { method: 'GET' });
    assert.equal(av.status, 200);
    assert.ok(av.json.busy.some((b) => b.assetId === 'V001' && b.start === reservation.start && b.end === reservation.end));
    assert.ok((av.json.handovers['loc-kitami'] || []).includes(reservation.start));
    assert.ok(!JSON.stringify(av.json).includes(email));
    assert.equal(typeof av.json.staff.enabled, 'boolean');
  });

  test('同じ車・同じ時間に同時20件 → 成功はちょうど1件、残りは AVAILABILITY_CONFLICT', async () => {
    const s = futureSlot(5);
    const total = (await quoteOf({ assetId: 'V004', start: s.start, end: s.end, optionIds: [] })).total;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve({
      assetId: 'V004', start: s.start, end: s.end,
      customer: { name: '同時 ' + i, kana: '', email: mail('race'), phone: '090-2222-' + String(1000 + i), company: '' }
    }, { expectedTotal: total })));
    const ok = results.filter((r) => r.status === 200);
    // 担当者カレンダーの設定 (他の担当の calendar テストが実行中など) で受け渡しの重複判定が先に掛かると
    // HANDOVER_CONFLICT になる。どちらも DB の排他で決まる「埋まっている」の結果
    const conflict = results.filter((r) => r.status === 409 && ['AVAILABILITY_CONFLICT', 'HANDOVER_CONFLICT'].includes(r.json.code));
    const codes = results.map((r) => r.status + ':' + (r.json && r.json.code)).join(',');
    assert.equal(ok.length, 1, codes);
    assert.equal(conflict.length, 19, codes);
    const { data } = await sr.from('reservations').select('id').eq('asset_id', 'V004')
      .eq('start_at', s.start).in('status', ['confirmed', 'in_use']);
    assert.equal(data.length, 1);
  });

  test('同じ冪等キーの再送は同じ予約を返す / 内容が違えば IDEMPOTENCY_KEY_REUSED', async () => {
    const s = futureSlot(4);
    const idem = key('idem');
    const customer = { name: '冪等 次郎', kana: '', email: mail('idem'), phone: '080-3333-4444', company: '' };
    const a = await reserve({ assetId: 'V002', start: s.start, end: s.end, idempotencyKey: idem, customer });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    const b = await reserve({ assetId: 'V002', start: s.start, end: s.end, idempotencyKey: idem, customer });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.reservation.id, a.json.reservation.id);
    assert.equal(b.json.replay, true);
    assert.equal(b.json.guestToken, a.json.guestToken);
    const { data } = await sr.from('reservations').select('id').eq('idempotency_key', idem);
    assert.equal(data.length, 1);
    assert.equal((await emailsTo(customer.email)).length, 1, '再送でメールが二重に送られない');
    const c = await reserve({ assetId: 'V002', start: s.start, end: s.end, idempotencyKey: idem, customer: { ...customer, name: '別人' } });
    assert.equal(c.status, 409);
    assert.equal(c.json.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('expectedTotal を改ざん → PRICE_CHANGED (新しい見積を同梱)・保存されない', async () => {
    const s = futureSlot(8);
    const q = await quoteOf({ assetId: 'V003', start: s.start, end: s.end, optionIds: ['OP102'] });
    const idem = key('price');
    const r = await reserve({ assetId: 'V003', start: s.start, end: s.end, optionIds: ['OP102'], idempotencyKey: idem }, { expectedTotal: q.total - 1000 });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'PRICE_CHANGED');
    assert.equal(r.json.quote.total, q.total);
    const { data } = await sr.from('reservations').select('id').eq('idempotency_key', idem);
    assert.equal(data.length, 0);
  });

  test('必須の同意が無い・版が古い → CONSENT_REQUIRED (保存されない)', async () => {
    const s = futureSlot(3);
    const idem = key('consent');
    let r = await reserve({ assetId: 'V005', start: s.start, end: s.end, idempotencyKey: idem }, { consent: null });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'CONSENT_REQUIRED');
    assert.deepEqual(r.json.missing.sort(), ['cancel', 'clause', 'privacy']);
    const old = await consentAll();
    old.documents = old.documents.map((d) => d.id === 'cancel' ? { id: 'cancel', version: '2020-01' } : d);
    r = await reserve({ assetId: 'V005', start: s.start, end: s.end, idempotencyKey: idem }, { consent: old });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'CONSENT_REQUIRED');
    assert.deepEqual(r.json.missing, ['cancel']);
    const { data } = await sr.from('reservations').select('id').eq('idempotency_key', idem);
    assert.equal(data.length, 0);
  });

  test('入力不備 → VALIDATION (fields)・免許確認なしも不可', async () => {
    const s = futureSlot(3);
    const r = await call('/api/reservations', {
      token: 'service',
      body: {
        idempotencyKey: key('val'), assetId: 'V001', start: s.start, end: s.end,
        customer: { name: '', email: 'not-an-email', phone: '12' }, licenseConfirmed: false, expectedTotal: 100
      }
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'VALIDATION');
    for (const f of ['name', 'email', 'phone', 'licenseConfirmed']) assert.ok(r.json.fields[f], f);
  });

  test('会員のクーポン: 他人のクーポンは COUPON_INVALID、本人のものは使える、未ログインは 401', async () => {
    const a = await makeMember('ca');
    const b = await makeMember('cb');
    const { data: cb, error: e1 } = await sr.from('coupons').insert({ user_id: b.id, amount: 1000, reason: 'テスト (他人)' }).select().single();
    assert.ifError(e1);
    const { data: ca, error: e2 } = await sr.from('coupons').insert({ user_id: a.id, amount: 1000, reason: 'テスト (本人)' }).select().single();
    assert.ifError(e2);
    const s = futureSlot(25);
    const base = { assetId: 'V003', start: s.start, end: s.end, optionIds: [] };

    // 見積の段階でも他人のクーポンは使えない
    let r = await call('/api/quote', { body: { ...base, couponId: cb.id }, token: a.token });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'COUPON_INVALID');

    const noCoupon = await quoteOf(base, a.token);
    r = await reserve({ ...base, couponId: cb.id }, { token: a.token, expectedTotal: noCoupon.total - 1000 });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'COUPON_INVALID');

    r = await reserve({ ...base, couponId: ca.id }, { token: 'service', expectedTotal: noCoupon.total - 1000 });
    assert.equal(r.status, 401, '未ログインでクーポン指定');
    assert.equal(r.json.code, 'UNAUTHENTICATED');

    r = await reserve({ ...base, couponId: ca.id, customer: { name: '会員 ca', kana: '', email: a.email, phone: '090-1111-2222', company: '' } },
      { token: a.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.reservation.total, noCoupon.total - 1000);
    const { data: row } = await sr.from('reservations').select('user_id, coupon_id').eq('id', r.json.reservation.id).single();
    assert.equal(row.user_id, a.id);
    assert.equal(row.coupon_id, ca.id);
    const { data: used } = await sr.from('coupons').select('used_at, used_reservation_id').eq('id', ca.id).single();
    assert.equal(used.used_reservation_id, r.json.reservation.id);

    // 会員はトークン無しで本人の予約を照会できる。他の会員からは見えない
    let l = await call('/api/reservations/lookup', { body: { id: r.json.reservation.id }, token: a.token });
    assert.equal(l.status, 200);
    assert.equal(l.json.reservation.isMember, true);
    l = await call('/api/reservations/lookup', { body: { id: r.json.reservation.id }, token: b.token });
    assert.equal(l.status, 404);

    // 請求書払いは許可された会員だけ
    const s2 = futureSlot(3);
    r = await reserve({ assetId: 'V001', start: s2.start, end: s2.end, paymentMethod: 'invoice' }, { token: b.token });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'INVOICE_NOT_ALLOWED');
  });
});

// =====================================================================
describe('照会・キャンセル', () => {
  test('照会: 正しいトークンは OK、違うトークンは NOT_FOUND、トークン無しの匿名は 401', async () => {
    const s = futureSlot(6);
    const r = await reserve({ assetId: 'V002', start: s.start, end: s.end });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { id } = r.json.reservation;
    const token = r.json.guestToken;
    let l = await call('/api/reservations/lookup', { body: { id, token } });
    assert.equal(l.status, 200);
    assert.equal(l.json.reservation.id, id);
    assert.equal(l.json.reservation.assetName, '日産 ノート e-POWER');
    assert.equal(l.json.reservation.locationName, '釧路店');
    assert.equal(l.json.cancellation.cancellable, true);
    assert.equal(l.json.cancellation.fee, 0, '150日以上先は無料');
    assert.ok(!('customerEmail' in l.json.reservation) && !('customer_phone' in l.json.reservation));
    l = await call('/api/reservations/lookup', { body: { id, token: token.slice(0, -3) + 'AAA' } });
    assert.equal(l.status, 404);
    assert.equal(l.json.code, 'NOT_FOUND');
    l = await call('/api/reservations/lookup', { body: { id: 'R99999999', token } });
    assert.equal(l.status, 404);
    l = await call('/api/reservations/lookup', { body: { id } });
    assert.equal(l.status, 401);
  });

  test('キャンセル: キャンセル料は pricing-core の cancellationFee と一致・取消メール (お客様・店舗)', async () => {
    // キャンセル料が発生するよう、明日 (日本時間) の未明 3時台に2時間の予約を作る
    const t = Core.jstParts(new Date(Date.now() + DAY).toISOString());
    const start = jstIso(t.y, t.m, t.d, 3, 5 * Math.floor(Math.random() * 10));
    const end = new Date(Date.parse(start) + 2 * HOUR).toISOString();
    const email = mail('cancel');
    const r = await reserve({ assetId: 'V005', start, end, customer: { name: '取消 三郎', kana: '', email, phone: '070-5555-6666', company: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { id } = r.json.reservation;
    const token = r.json.guestToken;

    const l = await call('/api/reservations/lookup', { body: { id, token } });
    assert.equal(l.status, 200);
    const cat = await catalog();
    const a = cat.assets.find((x) => x.id === 'V005');
    const local = Core.cancellationFee({
      asset: coreAsset(a), category: { id: a.category_id }, start, cancelAt: new Date().toISOString(),
      base: r.json.reservation.price.base, rules: cat.settings.pricing_rules
    });
    assert.ok(local.fee > 0, '前日のキャンセルは有料');
    assert.equal(l.json.cancellation.fee, local.fee);
    assert.equal(l.json.cancellation.pct, local.pct);

    let c = await call('/api/reservations/cancel', { body: { id, token, expectedFee: local.fee + 1 } });
    assert.equal(c.status, 409);
    assert.equal(c.json.code, 'PRICE_CHANGED');
    assert.equal(c.json.cancellation.fee, local.fee);

    c = await call('/api/reservations/cancel', { body: { id, token: 'wrong-token-value', expectedFee: local.fee } });
    assert.equal(c.status, 404);

    c = await call('/api/reservations/cancel', { body: { id, token, expectedFee: local.fee } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.reservation.status, 'cancelled');
    assert.equal(c.json.cancellation.fee, local.fee);
    assert.equal(c.json.email.status, 'sent');
    const { data: row } = await sr.from('reservations').select('status, cancel_fee, cancelled_by').eq('id', id).single();
    assert.deepEqual(row, { status: 'cancelled', cancel_fee: local.fee, cancelled_by: 'customer' });

    const cm = (await emailsTo(email)).filter((m) => /キャンセル/.test(m.subject));
    assert.equal(cm.length, 1);
    assert.match(cm[0].subject, /^【グロースレンタカー】ご予約キャンセルのお知らせ/);
    assert.ok(cm[0].text.includes('¥' + local.fee.toLocaleString('en-US')));
    const shop = (await emailsAbout(id)).filter((m) => m.to.includes(SHOP_EMAIL) && /キャンセル/.test(m.subject));
    assert.equal(shop.length, 1);

    c = await call('/api/reservations/cancel', { body: { id, token, expectedFee: local.fee } });
    assert.equal(c.status, 409);
    assert.equal(c.json.code, 'NOT_CANCELLABLE');
  });
});

// =====================================================================
describe('お問い合わせ (/api/inquiries)', () => {
  test('保存・自動返信 (本文は載せない)・店舗通知', async () => {
    const email = mail('inq');
    const body = 'キッチンカーの長期レンタルについて相談したいです。\n3ヶ月ほどを考えています。';
    const r = await call('/api/inquiries', {
      token: 'service',
      body: { idempotencyKey: key('inq'), name: '問合 四郎', company: '株式会社テスト', email, tel: '011-222-3333', topic: 'ご予約について', body, website: '', consent: await consentPrivacy() }
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.id;
    created.inquiries.add(id);
    assert.match(id, /^C\d+$/);
    assert.equal(r.json.email.status, 'sent');
    const { data: row } = await sr.from('inquiries').select('*').eq('id', id).single();
    assert.equal(row.email, email);
    assert.equal(row.body, body);
    assert.deepEqual(row.consent.documents.map((d) => d.id), ['privacy']);
    const auto = await emailsTo(email);
    assert.equal(auto.length, 1);
    assert.match(auto[0].subject, /^【グロースレンタカー】お問い合わせを受け付けました/);
    assert.ok(auto[0].text.includes(id) && auto[0].text.includes('ご予約について'));
    assert.ok(!auto[0].text.includes('長期レンタル'), '自動返信に本文を載せない (第三者への送り付け防止)');
    const shop = (await emailsAbout(id)).filter((m) => m.to.includes(SHOP_EMAIL));
    assert.equal(shop.length, 1);
    assert.ok(shop[0].text.includes('長期レンタル'));
    assert.ok(shop[0].text.includes(SITE_URL + 'manage/inquiries.html'));
    assert.equal(shop[0].reply_to, email, '店舗宛ては返信先をお客様に');
  });

  test('ハニーポットに入力があれば ok を返すが保存もメールもしない / 同意なしは CONSENT_REQUIRED', async () => {
    const email = mail('bot');
    let r = await call('/api/inquiries', {
      body: { name: 'bot', email, topic: 'spam', body: 'buy now', website: 'http://spam.example', consent: await consentPrivacy() }
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const { data } = await sr.from('inquiries').select('id').eq('email', email);
    assert.equal(data.length, 0);
    assert.equal((await emailsTo(email)).length, 0);

    r = await call('/api/inquiries', { token: 'service', body: { name: '同意なし', email: mail('nc'), topic: 'その他', body: 'test', consent: { documents: [] } } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'CONSENT_REQUIRED');
  });

  test('レート制限: 同じ IP から 10分に6回目で RATE_LIMITED (X-Real-IP・IPv6 の末尾を毎回変えても同じ枠)', async () => {
    const net = testNet();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      // 同意なし (= 保存されない) の送信でも回数は数える。X-Real-IP は利用者が書けるので枠の区別に使わない
      const r = await call('/api/inquiries', {
        // 同じ /64 の中で末尾だけ変える・X-Real-IP を変える、のどちらでも枠は増えない
        headers: { 'X-Forwarded-For': net + '::' + (i + 1).toString(16), 'X-Real-IP': '198.51.100.' + (1 + i) },
        body: { name: '連投', email: mail('rl'), topic: 'その他', body: 'test', consent: { documents: [] } }
      });
      codes.push(r.json.code);
    }
    assert.deepEqual(codes, ['CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'RATE_LIMITED']);
    // 別の IP は影響を受けない
    const other = await call('/api/inquiries', {
      headers: { 'X-Forwarded-For': testNet() + '::1' },
      body: { name: '別', email: mail('rl2'), topic: 'その他', body: 'test', consent: { documents: [] } }
    });
    assert.equal(other.json.code, 'CONSENT_REQUIRED');
  });

  test('予約のレート制限: 同じ IP から 10分に11回目で RATE_LIMITED', async () => {
    const xff = testNet() + '::1';
    const s = futureSlot(3);
    const codes = [];
    for (let i = 0; i < 11; i++) {
      // 金額が違う (= 保存されない) 送信でも回数は数える
      const r = await reserve({ assetId: 'V001', start: s.start, end: s.end }, { token: ANON, expectedTotal: 1, headers: { 'X-Forwarded-For': xff } });
      codes.push(r.json.code);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill('PRICE_CHANGED'));
    assert.equal(codes[10], 'RATE_LIMITED');
  });

  test('IP の取り方: 利用者が書けるヘッダ (X-Real-IP・X-Forwarded-For の左側) では枠を変えられない (ratelimit.ts を直接)', () => {
    // ローカルでは中継 (Kong) が X-Real-IP を上書きするため、HTTP 経由では確かめられない。関数を直接呼ぶ
    const cases = [
      // [名前, CLIENT_IP_HEADER, ヘッダ, 期待する IP]
      ['X-Real-IP だけ (既定では使わない)', '', { 'x-real-ip': '198.51.100.7' }, 'unknown'],
      ['X-Real-IP を変えても X-Forwarded-For の値', '', { 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '203.0.113.9, 172.18.0.1' }, '203.0.113.9'],
      ['同上 (別の X-Real-IP)', '', { 'x-real-ip': '192.0.2.200', 'x-forwarded-for': '203.0.113.9, 172.18.0.1' }, '203.0.113.9'],
      ['左側の偽装は無視 (右端から見て最初の公開アドレス)', '', { 'x-forwarded-for': '192.0.2.1, 192.0.2.2, 198.51.100.2, 10.0.0.1' }, '198.51.100.2'],
      ['右側に IP 以外があれば、その左 (利用者が書けるかもしれない) に進まない', '', { 'x-forwarded-for': '192.0.2.1, unknown, 10.0.0.1' }, '10.0.0.1'],
      ['ポート付き・IPv6 の書き方の違いはそろえる', '', { 'x-forwarded-for': '[2001:DB8:0:0::1]:443' }, '2001:db8::1'],
      ['IPv4 射影は IPv4 として扱う', '', { 'x-forwarded-for': '::ffff:203.0.113.4' }, '203.0.113.4'],
      // cf-connecting-ip は利用者が送った値がそのまま届く構成があるため、既定では使わない (CLIENT_IP_HEADER で明示したときだけ)
      ['cf-connecting-ip は既定では使わない (X-Forwarded-For の値)', '', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.9' }, '203.0.113.9'],
      ['cf-connecting-ip だけ → unknown', '', { 'cf-connecting-ip': '198.51.100.1' }, 'unknown'],
      ['同上 (壊れた値)', '', { 'cf-connecting-ip': 'evil', 'x-forwarded-for': '203.0.113.9' }, '203.0.113.9'],
      ['CLIENT_IP_HEADER=cf-connecting-ip で明示したときだけ cf-connecting-ip', 'cf-connecting-ip', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.9' }, '198.51.100.1'],
      ['ローカル (内部アドレスだけ) → 内部アドレス (数えない)', '', { 'x-real-ip': '172.18.0.1', 'x-forwarded-for': '172.18.0.1' }, '172.18.0.1'],
      ['ヘッダなし', '', {}, 'unknown'],
      ['CLIENT_IP_HEADER=x-real-ip で明示したときだけ X-Real-IP', 'X-Real-IP', { 'x-real-ip': '198.51.100.7', 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '203.0.113.2' }, '198.51.100.7'],
      ['CLIENT_IP_HEADER のヘッダが無ければ他のヘッダは使わない', 'x-real-ip', { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '203.0.113.2' }, 'unknown'],
      ['CLIENT_IP_HEADER が一覧なら右端から見て最初の公開アドレス', 'x-forwarded-for', { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '192.0.2.1, 198.51.100.3, 10.0.0.1' }, '198.51.100.3']
    ];
    const out = denoEval(
      "import { clientIp, isPrivateIp, rateKeyOf } from './_shared/ratelimit.ts';" +
      "const cases = JSON.parse(Deno.env.get('IP_CASES'));" +
      "const got = cases.map(([, forced, headers]) => { if (forced) Deno.env.set('CLIENT_IP_HEADER', forced); else Deno.env.delete('CLIENT_IP_HEADER');" +
      "  return clientIp(new Request('http://x/api/inquiries', { method: 'POST', headers })); });" +
      "const keys = ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2:ffff::9', '2001:0db8:0001:0002::', '2001:db8:1:3::1', '203.0.113.4'].map(rateKeyOf);" +
      "const priv = ['10.1.2.3', '172.18.0.1', '192.168.0.1', '127.0.0.1', '100.64.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:192.168.1.1', '203.0.113.5', '198.51.100.1', '8.8.8.8', '2001:db8::1', 'fc::1'].map(isPrivateIp);" +
      "console.log(JSON.stringify({ got, keys, priv }));",
      { IP_CASES: JSON.stringify(cases) }
    );
    if (out === null) return; // deno が無い環境では省略
    const r = JSON.parse(out);
    cases.forEach((c, i) => assert.equal(r.got[i], c[3], c[0]));
    assert.deepEqual(r.keys, ['2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64', '203.0.113.4'],
      'IPv6 は /64 単位 (末尾を変えても同じ枠)');
    assert.deepEqual(r.priv, [true, true, true, true, true, true, true, true, true, false, false, false, false, false]);
  });

  test('IP の確認用ログ (CLIENT_IP_DEBUG=1): 候補のヘッダと採用元を出し、IP は伏せる / 既定では出さない', () => {
    const code = (debug) =>
      "import { limitByIp } from './_shared/ratelimit.ts';" +
      "const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));" +
      (debug ? "Deno.env.set('CLIENT_IP_DEBUG', '1');" : '') +
      // 内部アドレスしか無い + ローカル開発 (SITE_URL が 127.0.0.1) = DB に問い合わせずに終わる
      "await limitByIp(new Request('http://x/api/availability', { headers: { 'x-real-ip': '198.51.100.23', 'x-forwarded-for': '10.1.2.3, 172.18.0.1' } }), 'availability', 300, 600);" +
      "orig(JSON.stringify(logs));";
    const LOCAL = { SITE_URL: 'http://127.0.0.1:8901/' };
    const on = denoEval(code(true), LOCAL);
    if (on === null) return;
    const logs = JSON.parse(on);
    assert.equal(logs.length, 1, on);
    const line = JSON.parse(logs[0]);
    assert.equal(line.msg, 'client-ip');
    assert.equal(line.source, 'x-forwarded-for');
    assert.equal(line.picked, '172.18.*.* (内部)');
    assert.deepEqual(line.headers['x-real-ip'], ['198.51.*.* (公開)']);
    assert.deepEqual(line.headers['x-forwarded-for'], ['10.1.*.* (内部)', '172.18.*.* (内部)']);
    assert.equal(line.headers['cf-connecting-ip'], null);
    assert.ok(!logs[0].includes('198.51.100.23') && !logs[0].includes('10.1.2.3'), 'IP をそのままログに出さない');
    assert.deepEqual(JSON.parse(denoEval(code(false), LOCAL)), [], '既定ではログに出さない');
  });
});

// =====================================================================
describe('メール送信の失敗と再送 (worker)', () => {
  test('Resend が 500 → failed (再試行予定) → worker 再実行で sent', async () => {
    const s = futureSlot(4);
    const email = mail('fail');
    const expected = (await quoteOf({ assetId: 'V003', start: s.start, end: s.end, optionIds: [] })).total;
    // 次の2通 (お客様・店舗) を 500 で失敗させる
    await fetch(RESEND_MOCK + '/_mock/fail', { method: 'POST', body: JSON.stringify({ status: 500, count: 2 }) });
    const r = await reserve({ assetId: 'V003', start: s.start, end: s.end, customer: { name: '失敗 五郎', kana: '', email, phone: '090-7777-8888', company: '' } },
      { expectedTotal: expected });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.reservation.id;
    assert.equal(r.json.email.status, 'failed');
    let ob = (await outboxOf(id)).filter((o) => o.template !== 'gcal_sync');
    const cust = ob.find((o) => o.template === 'reservation_confirmed');
    assert.equal(cust.status, 'failed');
    assert.equal(cust.attempts, 1);
    assert.match(cust.last_error, /HTTP 500/);
    assert.ok(Date.parse(cust.next_attempt_at) > Date.now(), '指数バックオフで次回は少し先');
    assert.ok(Date.parse(cust.next_attempt_at) < Date.now() + DAY);
    assert.equal((await emailsTo(email)).length, 0);

    // worker は認証が必要
    let w = await call('/worker', { body: {}, token: ANON });
    assert.equal(w.status, 401);
    w = await call('/worker', { body: {}, token: ANON, headers: { 'x-worker-secret': 'wrong-secret-value-0000' } });
    assert.equal(w.status, 401);

    // 再試行の時刻を今にして worker を実行 → 送信される
    await sr.from('outbox').update({ next_attempt_at: new Date().toISOString() }).eq('ref_id', id).eq('status', 'failed');
    w = await call('/worker', { body: { refIds: [id] }, token: ANON, headers: { 'x-worker-secret': WORKER_SECRET } });
    assert.equal(w.status, 200, JSON.stringify(w.json));
    assert.ok(w.json.results.filter((x) => x.template !== 'gcal_sync').every((x) => x.status === 'sent'), JSON.stringify(w.json.results));
    ob = (await outboxOf(id)).filter((o) => o.template !== 'gcal_sync');
    assert.ok(ob.every((o) => o.status === 'sent' && o.attempts === 2), JSON.stringify(ob.map((o) => [o.status, o.attempts])));
    assert.equal((await emailsTo(email)).length, 1);

    // service_role の Bearer でも起動できる
    w = await call('/worker', { body: { refIds: [id] }, token: 'service' });
    assert.equal(w.status, 200);
    assert.ok(!w.json.results.some((x) => x.template !== 'gcal_sync'), '送信済みのメールは再送しない');
  });

  test('宛先を Resend が 4xx で拒否 → failed のまま再試行しない', async () => {
    const email = 'bounce-' + RUN + '@example.com';
    const r = await call('/api/inquiries', {
      token: 'service',
      body: { name: '不達 六郎', email, topic: 'その他', body: '不達テスト', consent: await consentPrivacy() }
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    created.inquiries.add(r.json.id);
    assert.equal(r.json.email.status, 'failed');
    const ob = await outboxOf(r.json.id);
    const auto = ob.find((o) => o.template === 'inquiry_received');
    assert.equal(auto.status, 'failed');
    assert.match(auto.last_error, /HTTP 422/);
    assert.ok(!auto.last_error.includes(email), 'エラー記録にメールアドレスを残さない');
    assert.ok(Date.parse(auto.next_attempt_at) > Date.now() + 365 * DAY, '4xx は自動では再試行しない');
    const w = await call('/worker', { body: { refIds: [r.json.id] }, token: 'service' });
    assert.equal(w.status, 200);
    assert.ok(!w.json.results.some((x) => x.id === auto.id));
  });

  test('定期起動の worker (refIds なし) は期限の来たジョブを処理する (クーポン発行メール・未対応テンプレート)', async () => {
    const email = mail('coupon');
    const refA = randomUUID();
    const refB = 'b1test-' + RUN;
    const { data: rows, error } = await sr.from('outbox').insert([
      { template: 'coupon_issued', to_email: email, payload: { name: 'クーポン 七子', amount: 1000, threshold: 10 }, ref_type: 'coupon', ref_id: refA },
      { template: 'no_such_template', to_email: email, payload: {}, ref_type: 'test', ref_id: refB }
    ]).select('id');
    assert.ifError(error);
    try {
      const w = await call('/worker', { body: { limit: 100 }, token: ANON, headers: { 'x-worker-secret': WORKER_SECRET } });
      assert.equal(w.status, 200, JSON.stringify(w.json));
      const a = w.json.results.find((x) => x.id === rows[0].id);
      const b = w.json.results.find((x) => x.id === rows[1].id);
      assert.equal(a && a.status, 'sent', JSON.stringify(w.json.results));
      assert.equal(b && b.status, 'failed');
      const got = await emailsTo(email);
      assert.equal(got.length, 1);
      assert.match(got[0].subject, /^【グロースレンタカー】¥1,000 クーポンを発行しました/);
      assert.ok(got[0].text.includes('クーポン 七子 様') && got[0].text.includes(SITE_URL + 'mypage.html'));
      const { data: after } = await sr.from('outbox').select('id, status, next_attempt_at').in('id', rows.map((r) => r.id)).order('id');
      assert.equal(after[0].status, 'sent');
      assert.equal(after[1].status, 'failed');
      assert.ok(Date.parse(after[1].next_attempt_at) > Date.now() + 365 * DAY, '未対応テンプレートは再試行しない');
    } finally {
      await sr.from('outbox').delete().in('id', rows.map((r) => r.id));
    }
  });

  test('RESEND_API_KEY 未設定なら送らずに skipped', () => {
    const out = denoEval(
      "import { sendMail } from './_shared/mail.ts';" +
      "console.log(JSON.stringify(await sendMail({ to: 'someone@example.com', subject: 'x', text: 'y' })));",
      { RESEND_API_BASE: RESEND_MOCK }
    );
    if (out === null) return; // deno が無い環境では省略
    assert.deepEqual(JSON.parse(out), { status: 'skipped', error: 'メール送信サービス未設定' });
  });
});

// =====================================================================
describe('CORS・認証', () => {
  test('許可された Origin からは使える / それ以外の Origin は 403', async () => {
    let r = await call('/api/', { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(r.status, 200);
    r = await call('/api/', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'FORBIDDEN');
  });

  test('プリフライト (OPTIONS): 許可 Origin は 204 + そのOriginを返す / 他は 403 (関数を直接呼んで確認)', () => {
    // ローカルの API ゲートウェイ (Kong) は OPTIONS を自分で返すため、http.ts の handle を直接試す
    const out = denoEval(
      "import { handle } from './_shared/http.ts';" +
      "const f = async (o, m) => { const res = await handle(new Request('http://x/api/quote', { method: m, headers: { origin: o } }), () => ({ ok: true })); return [res.status, res.headers.get('access-control-allow-origin')]; };" +
      "console.log(JSON.stringify([await f('" + ALLOWED_ORIGIN + "', 'OPTIONS'), await f('https://evil.example', 'OPTIONS'), await f('" + ALLOWED_ORIGIN + "', 'GET'), await f('https://evil.example', 'GET')]));",
      { ALLOWED_ORIGINS: FN_ENV.ALLOWED_ORIGINS || ALLOWED_ORIGIN }
    );
    if (out === null) return;
    assert.deepEqual(JSON.parse(out), [[204, ALLOWED_ORIGIN], [403, null], [200, ALLOWED_ORIGIN], [403, null]]);
  });

  test('匿名で /api/me/close → 401、会員本人は退会できる (ログイン不可になる)', async () => {
    let r = await call('/api/me/close', { body: { confirm: true } });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'UNAUTHENTICATED');
    const m = await makeMember('close');
    r = await call('/api/me/close', { body: { confirm: false }, token: m.token });
    assert.equal(r.status, 400);
    r = await call('/api/me/close', { body: { confirm: true }, token: m.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { data: row } = await sr.from('members').select('status, email, name').eq('user_id', m.id).maybeSingle();
    if (row) assert.deepEqual(row, { status: 'closed', email: '', name: '退会済み会員' });
    const c = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
    const s = await c.auth.signInWithPassword({ email: m.email, password: 'Test-Pass-' + RUN + '9' });
    assert.ok(s.error, '退会後はログインできない');
  });

  test('未知のパス → NOT_FOUND / GET で予約 → METHOD_NOT_ALLOWED', async () => {
    let r = await call('/api/nothing');
    assert.equal(r.status, 404);
    r = await call('/api/reservations', { method: 'GET' });
    assert.equal(r.status, 405);
  });
});
