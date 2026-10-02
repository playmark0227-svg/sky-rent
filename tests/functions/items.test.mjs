/**
 * 家電レンタル (車を借りずに家電だけを借りる) の結合テスト — 実際に起動している Edge Functions へ HTTP で問い合わせる
 *
 * 実行: node --test tests/functions/items.test.mjs
 *
 * 前提: tests/functions/api.test.mjs と同じ (supabase start / functions serve / Resend モック :8978)。
 *
 * 守っていること:
 *   - 在庫の判定がほかのテストの予約とぶつからないよう、このテスト専用の家電 (在庫1) と家電セット、車両を一時的に作り、最後に消す。
 *     受け取り窓口は seed の A001 (家電レンタル（北見本店）) を使う。
 *   - 予約の日時は「今日から150〜390日後のランダムな日」。キャンセル料が発生する経路だけ、明日の未明 (3時台) の短い予約を使う。
 *   - Resend モックは reset しない。宛先・予約番号で絞り込んで確認する。
 *   - 作った予約・送信キューはテストの最後に削除する。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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
const SHOP_EMAIL = (FN_ENV.SHOP_NOTIFY_EMAIL || 'shop@growth-rentacar.test').split(',')[0].trim();

const sr = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const HOUR = 3600e3;
const DAY = 864e5;
let seq = 0;
const created = { reservations: new Set() };

// このテスト専用の家電 (在庫1)・家電セット・車両
const ITEM = 'TI' + RUN;          // テスト家電 (24時間 ¥1,000・在庫1)
const ITEM2 = 'TJ' + RUN;         // テスト家電その2 (24時間 ¥500・在庫1)
const SET = 'TS' + RUN;           // テスト家電セット (ITEM と ITEM2 を含む。¥1,300)
const CAR = 'TV' + RUN;           // テスト車両 (コンパクト)
const WINDOW = 'A001';            // 家電レンタルの受け取り窓口 (seed)

function mail(tag) {
  return 'i1-' + RUN + '-' + tag + '-' + (++seq) + '@example.com';
}
function key(tag) {
  return 'i1test-' + tag + '-' + RUN + '-' + randomUUID().replace(/-/g, '').slice(0, 12);
}

async function call(path, { method, body, token } = {}) {
  const auth = token === 'service' ? SERVICE : (token || ANON);
  const h = { apikey: ANON, Authorization: 'Bearer ' + auth };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(FUNCTIONS + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'), headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function jstIso(y, m, d, hh, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)).toISOString();
}
const usedDays = new Set();
function futureSlot(hours, hh = 10) {
  let off;
  do { off = 150 + Math.floor(Math.random() * 241); } while (usedDays.has(off));
  usedDays.add(off);
  const p = Core.jstParts(new Date(Date.now() + off * DAY).toISOString());
  const start = jstIso(p.y, p.m, p.d, hh, 0);
  return { start, end: new Date(Date.parse(start) + hours * HOUR).toISOString() };
}
const plus = (iso, h) => new Date(Date.parse(iso) + h * HOUR).toISOString();

let LEGAL = null;
async function consentFor(ids) {
  if (!LEGAL) {
    const { data, error } = await sr.from('legal_documents').select('id, version').eq('active', true);
    if (error) throw error;
    LEGAL = data;
  }
  return { documents: LEGAL.filter((d) => ids.includes(d.id)).map((d) => ({ id: d.id, version: d.version })), agreedAt: new Date().toISOString() };
}
const ITEM_DOCS = ['item_clause', 'cancel', 'privacy'];
const CAR_DOCS = ['clause', 'cancel', 'privacy'];

async function quote(p) {
  return call('/api/quote', { body: { assetId: p.assetId, start: p.start, end: p.end, optionIds: p.optionIds || [] }, token: 'service' });
}

/** 見積 → 予約確定 (service_role で呼ぶ = レート制限の対象外) */
async function reserve(p, { docs, license, expectedTotal } = {}) {
  const isItem = p.assetId === WINDOW;
  const q = expectedTotal !== undefined ? null : await quote(p);
  const body = {
    idempotencyKey: key('res'),
    assetId: p.assetId, start: p.start, end: p.end, optionIds: p.optionIds || [],
    customer: p.customer || { name: '家電 太郎', kana: 'カデン タロウ', email: mail('res'), phone: '090-0000-' + String(1000 + (seq % 9000)), company: '' },
    paymentMethod: 'onsite',
    licenseConfirmed: license !== undefined ? license : !isItem,
    expectedTotal: expectedTotal !== undefined ? expectedTotal : (q.json && q.json.quote ? q.json.quote.total : 0),
    consent: await consentFor(docs || (isItem ? ITEM_DOCS : CAR_DOCS))
  };
  const r = await call('/api/reservations', { body, token: 'service' });
  if (r.json && r.json.reservation && r.json.reservation.id) created.reservations.add(r.json.reservation.id);
  return { ...r, body };
}

async function emailsTo(addr) {
  const r = await fetch(RESEND_MOCK + '/_mock/emails');
  return (await r.json()).filter((e) => (e.to || []).includes(addr));
}
async function emailsAbout(needle) {
  const r = await fetch(RESEND_MOCK + '/_mock/emails');
  return (await r.json()).filter((e) => String(e.subject || '').includes(needle));
}

// ---------------------------------------------------------------------
// 準備と後片付け
// ---------------------------------------------------------------------
before(async () => {
  const opts = [
    { id: ITEM, name: 'テスト家電 ' + RUN, price: 1000, price_type: 'per_day', category_ids: null, kind: 'other', stock: 1, sort: 900, extra: { description: 'テスト用' } },
    { id: ITEM2, name: 'テスト家電2 ' + RUN, price: 500, price_type: 'per_day', category_ids: null, kind: 'other', stock: 1, sort: 901, extra: {} },
    { id: SET, name: 'テスト家電セット ' + RUN, price: 1300, price_type: 'per_day', category_ids: null, kind: 'other', stock: null, sort: 902, extra: { includes: [ITEM, ITEM2] } }
  ];
  let { error } = await sr.from('options').insert(opts);
  if (error) throw error;
  ({ error } = await sr.from('assets').insert({
    id: CAR, category_id: 'cat-rental', location_id: 'loc-kitami', name: 'テスト車両 ' + RUN, price_hour: 1100, price_day: 7700,
    image: '🚗', custom_fields: { bodyType: 'コンパクト' }, sort: 999
  }));
  if (error) throw error;
});

after(async () => {
  const likeRun = 'i1-' + RUN + '-%';
  const extra = await sr.from('reservations').select('id').or('customer_email.like.' + likeRun + ',asset_id.eq.' + CAR);
  (extra.data || []).forEach((r) => created.reservations.add(r.id));
  const ids = [...created.reservations];
  if (ids.length) {
    await sr.from('outbox').delete().in('ref_id', ids);
    const { error } = await sr.from('reservations').delete().in('id', ids);
    if (error) console.warn('予約の削除に失敗しました', error.message);
  }
  await sr.from('assets').delete().eq('id', CAR);
  await sr.from('options').delete().in('id', [ITEM, ITEM2, SET]);
});

// =====================================================================
describe('家電レンタル: 見積 (/api/quote)', () => {
  test('家電だけ: 基本料金0・家電の24時間料金の合計・割増なし / 家電を選ばないと ITEM_REQUIRED', async () => {
    const { start, end } = futureSlot(25, 21); // 25時間 (×2)・夜間に掛かる時刻でも割増なし
    let r = await quote({ assetId: WINDOW, start, end, optionIds: [ITEM] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.categoryType, 'item');
    assert.deepEqual(r.json.quote.errors, []);
    assert.equal(r.json.quote.base, 0);
    assert.equal(r.json.quote.total, 2000, '¥1,000 × 2 (25時間)');
    assert.ok(!r.json.quote.lines.some((l) => /割増|夜間/.test(l.label)), '家電レンタルに割増はかけない');
    assert.ok(Array.isArray(r.json.unavailableOptionIds));
    assert.ok(!r.json.unavailableOptionIds.includes(ITEM));

    r = await quote({ assetId: WINDOW, start, end, optionIds: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.quote.errors, ['ITEM_REQUIRED']);
  });

  test('貸し出し中の家電は unavailableOptionIds に入る (中身が貸し出し中の家電セットも)', async () => {
    const { start, end } = futureSlot(6);
    const r1 = await reserve({ assetId: WINDOW, start, end, optionIds: [ITEM] });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const q = await quote({ assetId: WINDOW, start: plus(start, 1), end: plus(end, 1), optionIds: [ITEM2] });
    assert.equal(q.status, 200);
    assert.ok(q.json.unavailableOptionIds.includes(ITEM));
    assert.ok(q.json.unavailableOptionIds.includes(SET), '中身が貸し出し中なのでセットも選べない');
    assert.ok(!q.json.unavailableOptionIds.includes(ITEM2));
    assert.equal(q.json.availability.options, true, '選んだ ITEM2 は貸し出せる');
    // 終わった直後 (終了 = 開始) は重ならない
    const q2 = await quote({ assetId: WINDOW, start: end, end: plus(end, 3), optionIds: [ITEM] });
    assert.ok(!q2.json.unavailableOptionIds.includes(ITEM));
  });
});

// =====================================================================
describe('家電レンタル: 予約確定 (/api/reservations)', () => {
  test('ゲスト予約: 免許の確認なし・物品レンタル規約に同意・is_item・メール (お受け取り/本人確認書類/家電の一覧)', async () => {
    const { start, end } = futureSlot(48);
    const email = mail('ok');
    const r = await reserve({ assetId: WINDOW, start, end, optionIds: [ITEM, ITEM2],
      customer: { name: '家電 花子', kana: 'カデン ハナコ', email, phone: '090-1234-0001', company: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { reservation } = r.json;
    assert.equal(reservation.total, 3000, '(¥1,000 + ¥500) × 2');
    assert.equal(r.json.email.status, 'sent');

    const { data: row } = await sr.from('reservations').select('*').eq('id', reservation.id).single();
    assert.equal(row.is_item, true);
    assert.equal(row.asset_id, WINDOW);
    assert.equal(row.license_confirmed, false, '家電レンタルは運転免許の確認をしない');
    assert.deepEqual([...row.option_ids].sort(), [ITEM, ITEM2].sort());
    assert.deepEqual(row.consent.documents.map((d) => d.id).sort(), ['cancel', 'item_clause', 'privacy']);

    const mine = await emailsTo(email);
    assert.equal(mine.length, 1);
    const t = mine[0].text;
    for (const needle of [reservation.id, '家電レンタル', 'お受け取り', 'ご返却', '本人確認書類', 'テスト家電 ' + RUN, 'テスト家電2 ' + RUN, '¥3,000']) {
      assert.ok(t.includes(needle), 'お客様メールに「' + needle + '」がありません');
    }
    assert.ok(!t.includes('運転される方全員の運転免許証'), '家電レンタルのメールで運転免許証の持参を案内しない');
    const shop = (await emailsAbout(reservation.id)).filter((e) => e.to.includes(SHOP_EMAIL));
    assert.equal(shop.length, 1);
  });

  test('家電レンタルの窓口には同じ時間に何件でも入る (別の家電なら通る)', async () => {
    const { start, end } = futureSlot(5);
    const a = await reserve({ assetId: WINDOW, start, end, optionIds: [ITEM] });
    const b = await reserve({ assetId: WINDOW, start: plus(start, 1), end: plus(end, 1), optionIds: [ITEM2] });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
  });

  test('在庫切れ: 家電だけ×家電だけ・車両のオプション×家電だけ・家電セット×中の品目 → 409 OPTION_SOLD_OUT (保存もメールもしない)', async () => {
    const { start, end } = futureSlot(6);
    const first = await reserve({ assetId: WINDOW, start, end, optionIds: [ITEM] });
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const cases = [
      { label: '家電だけ', p: { assetId: WINDOW, optionIds: [ITEM] }, sold: [ITEM] },
      { label: '車両のオプション', p: { assetId: CAR, optionIds: [ITEM] }, sold: [ITEM] },
      { label: '家電セット', p: { assetId: WINDOW, optionIds: [SET] }, sold: [ITEM, SET].sort() }
    ];
    for (const c of cases) {
      const email = mail('sold');
      const r = await reserve({ ...c.p, start: plus(start, 2), end: plus(end, 2),
        customer: { name: '在庫 切れ', kana: '', email, phone: '090-1234-0002', company: '' } });
      assert.equal(r.status, 409, c.label + ': ' + JSON.stringify(r.json));
      assert.equal(r.json.code, 'OPTION_SOLD_OUT');
      assert.deepEqual([...r.json.details.optionIds].sort(), c.sold, c.label);
      assert.ok(r.json.fields && r.json.fields.optionIds);
      const { data: rows } = await sr.from('reservations').select('id').eq('customer_email', email);
      assert.equal(rows.length, 0, c.label + ': 保存しない');
      assert.equal((await emailsTo(email)).length, 0, c.label + ': メールを送らない');
    }
  });

  test('車両の予約で借りている家電は、同じ時間の家電だけの予約で選べない (逆向き)', async () => {
    const { start, end } = futureSlot(8);
    const car = await reserve({ assetId: CAR, start, end, optionIds: [ITEM2] });
    assert.equal(car.status, 200, JSON.stringify(car.json));
    const r = await reserve({ assetId: WINDOW, start: plus(start, 3), end: plus(end, 3), optionIds: [ITEM2] });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'OPTION_SOLD_OUT');
  });

  test('同時に6件 (車両3件 + 家電だけ3件) 来ても、在庫1の家電は1件だけ通る', async () => {
    const { start, end } = futureSlot(4);
    const jobs = [CAR, CAR, CAR, WINDOW, WINDOW, WINDOW].map((assetId, i) => ({ assetId, start: plus(start, i * 0.25), end: plus(end, i * 0.25), optionIds: [ITEM] }));
    const res = await Promise.all(jobs.map((p) => reserve(p)));
    const ok = res.filter((r) => r.status === 200);
    const codes = res.filter((r) => r.status !== 200).map((r) => r.json && r.json.code);
    assert.equal(ok.length, 1, JSON.stringify(res.map((r) => [r.status, r.json && r.json.code])));
    // 同じ車両の2件目以降は車両の重なり (AVAILABILITY_CONFLICT) で止まることもある。家電が2件通らないことが大事
    assert.ok(codes.every((c) => c === 'OPTION_SOLD_OUT' || c === 'AVAILABILITY_CONFLICT'), JSON.stringify(codes));
  });

  test('家電を選ばない → 400 ITEM_REQUIRED / 同意が貸渡約款だけ → CONSENT_REQUIRED / 車両は免許の確認が要る', async () => {
    const { start, end } = futureSlot(4);
    let r = await reserve({ assetId: WINDOW, start, end, optionIds: [] }, { expectedTotal: 0 });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'ITEM_REQUIRED');

    r = await reserve({ assetId: WINDOW, start, end, optionIds: [ITEM2] }, { docs: CAR_DOCS });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'CONSENT_REQUIRED');
    assert.ok(r.json.missing.includes('item_clause'));

    r = await reserve({ assetId: CAR, start, end, optionIds: [] }, { license: false });
    assert.equal(r.status, 400);
    assert.ok(r.json.fields && r.json.fields.licenseConfirmed, '車両の予約は運転免許の確認が要る');
  });
});

// =====================================================================
describe('家電レンタル: 照会とキャンセル', () => {
  test('キャンセル料は家電の料金の合計をもとに計算する (pricing-core と一致)', async () => {
    // キャンセル料が発生するよう、明日 (日本時間) の未明 3時台に2時間の予約を作る
    const t = Core.jstParts(new Date(Date.now() + DAY).toISOString());
    const start = jstIso(t.y, t.m, t.d, 3, 5 * Math.floor(Math.random() * 10));
    const end = plus(start, 2);
    const email = mail('cancel');
    const r = await reserve({ assetId: WINDOW, start, end, optionIds: [ITEM, ITEM2],
      customer: { name: '取消 家電', kana: '', email, phone: '090-1234-0003', company: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { id } = r.json.reservation;
    const token = r.json.guestToken;
    assert.equal(r.json.reservation.total, 1500);

    const l = await call('/api/reservations/lookup', { body: { id, token } });
    assert.equal(l.status, 200);
    assert.equal(l.json.reservation.isItem, true);
    const { data: rules } = await sr.from('app_settings').select('value').eq('key', 'pricing_rules').single();
    const local = Core.cancellationFee({
      asset: { id: WINDOW, categoryId: 'cat-appliance' }, category: { id: 'cat-appliance' }, start, cancelAt: new Date().toISOString(),
      base: 1500, rules: rules.value
    });
    assert.equal(local.cls, 'item');
    assert.ok(local.fee > 0, '前日のキャンセルは有料');
    assert.equal(l.json.cancellation.fee, local.fee);
    assert.equal(l.json.cancellation.fee, Math.floor(1500 * local.pct / 100), '元の金額は家電の合計 ¥1,500');

    const c = await call('/api/reservations/cancel', { body: { id, token, expectedFee: local.fee } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.reservation.status, 'cancelled');
    const { data: row } = await sr.from('reservations').select('status, cancel_fee').eq('id', id).single();
    assert.deepEqual(row, { status: 'cancelled', cancel_fee: local.fee });

    // キャンセル後は、同じ家電を同じ時間に借りられる
    const again = await quote({ assetId: WINDOW, start, end, optionIds: [ITEM] });
    assert.ok(!again.json.unavailableOptionIds.includes(ITEM));
  });
});
