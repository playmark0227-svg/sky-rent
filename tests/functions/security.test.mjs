/**
 * Edge Functions のセキュリティ回帰テスト — 報告された攻撃の再現手順を、修正後の関数に対して実行する
 *
 * 実行: node --test tests/functions/security.test.mjs
 *
 * 前提 (tests/functions/api.test.mjs と同じ):
 *   - supabase start 済み (API http://127.0.0.1:54321)
 *   - supabase functions serve --env-file supabase/functions/.env.local が起動中 (SITE_URL は 127.0.0.1 = ローカル開発)
 *   - Resend モック (tests/mocks/resend-mock.mjs) が :8978 で起動中
 *   - deno (ratelimit.ts・mail-templates.ts を直接呼ぶテストだけ。無ければ省略)
 *
 * 扱う報告:
 *   functions-1  お問い合わせの種類 (topic) に任意の文字列・URL を入れて、店舗のドメインから第三者へメールを送らせる
 *   functions-2 / func-2  レート制限の IP を利用者が書けるヘッダ (cf-connecting-ip・内部アドレスの X-Forwarded-For) で変えられる
 *   func-1  無認証の予約で全車両を長期間押さえられる
 *   func-3  自己申告の割引が当日確認できなかったときの金額が分からない
 *
 * 守っていること:
 *   - 予約の日時は「今日から150〜390日後のランダムな日」。重なったら別の日でやり直す。
 *   - 連絡先 (メールアドレス・電話番号) は実行ごとに一意 (他の実行・他のテストの上限と混ざらない)。
 *   - 作った予約・問い合わせ・送信キュー・会員・レート制限の行はテストの最後に削除する。Resend モックは reset しない。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
const RUN = randomUUID().slice(0, 8);
const HOUR = 3600e3;
const DAY = 864e5;
let seq = 0;
const created = { reservations: new Set(), inquiries: new Set(), users: new Set() };

/** 実行ごとに一意のメールアドレス (後片付けで 'sec-' + RUN + '-%' を拾う) */
function mail(tag) {
  return 'sec-' + RUN + '-' + tag + '-' + (++seq) + '@example.com';
}
/** 実行ごとにほぼ一意の携帯番号 */
function phone() {
  return '090-' + String(randomInt(1000, 10000)) + '-' + String(randomInt(1000, 10000));
}
function key(tag) {
  return 'sectest-' + tag + '-' + RUN + '-' + randomUUID().replace(/-/g, '').slice(0, 12);
}
/** レート制限の試験用ネットワーク (2001:db8:xxxx:xxxx::/64) */
function testNet() {
  return '2001:db8:' + randomBytes(2).toString('hex') + ':' + randomBytes(2).toString('hex');
}
/** ratelimit.ts の mailboxKey と同じ規則 (テスト側でメールを数えるため) */
function mailboxKey(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  let local = s.slice(0, at);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  return local + '@' + s.slice(at + 1);
}

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
  return { status: res.status, json };
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

async function mockEmails() {
  const r = await fetch(RESEND_MOCK + '/_mock/emails');
  return r.json();
}
async function emailsTo(addr) {
  return (await mockEmails()).filter((e) => (e.to || []).includes(addr));
}
async function emailsToMailbox(addr) {
  const k = mailboxKey(addr);
  return (await mockEmails()).filter((e) => (e.to || []).some((t) => mailboxKey(t) === k));
}
async function emailsAbout(needle) {
  return (await mockEmails()).filter((e) => String(e.subject || '').includes(needle));
}

/** 日本時間の今日から off 日後の hh:00 (ISO) */
function slotStart(off, hh) {
  const jstMidnight = Math.floor((Date.now() + 9 * HOUR) / DAY) * DAY - 9 * HOUR;
  return new Date(jstMidnight + off * DAY + hh * HOUR).toISOString();
}

const RETRY_CODES = ['AVAILABILITY_CONFLICT', 'HANDOVER_CONFLICT', 'STAFF_UNAVAILABLE', 'CALENDAR_UNAVAILABLE'];

/**
 * 予約を送る。車両・日は空いているところを探して (重なったら別の日で) やり直す。
 *   token: 'service' / 会員のトークン / 省略 (anon = ゲスト)
 *   hours: 期間。expectedTotal を省略するとサーバーの見積 (service) の金額を使う
 */
async function reserve({ token, hours, customer, discountType = null, assets = ['V001', 'V002', 'V003', 'V004', 'V005'], headers, expectedTotal, tries = 10 }) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    const assetId = assets[randomInt(0, assets.length)];
    const start = slotStart(150 + randomInt(0, 241), 9 + randomInt(0, 8));
    const end = new Date(Date.parse(start) + hours * HOUR).toISOString();
    let total = expectedTotal;
    if (total === undefined) {
      const q = await call('/api/quote', { body: { assetId, start, end, optionIds: [], discountType }, token: 'service' });
      assert.equal(q.status, 200, JSON.stringify(q.json));
      total = q.json.quote.total;
    }
    const body = {
      idempotencyKey: key('res'), assetId, start, end, optionIds: [], discountType, couponId: null,
      customer: { kana: '', company: '', ...customer }, paymentMethod: 'onsite', licenseConfirmed: true, note: '',
      expectedTotal: total, consent: await consentAll()
    };
    r = await call('/api/reservations', { body, token, headers: typeof headers === 'function' ? headers(i) : headers });
    if (r.json && r.json.reservation && r.json.reservation.id) created.reservations.add(r.json.reservation.id);
    if (!(r.json && RETRY_CODES.includes(r.json.code))) return { ...r, body, attempts: i + 1 };
  }
  return { ...r, attempts: tries };
}

/** 会員を作ってログインする (メール確認済み) */
async function makeMember(tag) {
  const email = mail(tag);
  const password = 'Sec-Pass-' + RUN + '9a';
  const { data, error } = await sr.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { account_type: 'member', name: '会員 ' + tag, name_kana: 'カイイン', phone: phone() }
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
/** deno から DB (hit_rate_limit) を使うときの環境 */
const DB_ENV = { SUPABASE_URL, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, GUEST_TOKEN_SECRET: 'sectest-' + 'x'.repeat(40) };

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
  const likeRun = 'sec-' + RUN + '-%';
  const extraRes = await sr.from('reservations').select('id').ilike('customer_email', likeRun);
  (extraRes.data || []).forEach((r) => created.reservations.add(r.id));
  const extraInq = await sr.from('inquiries').select('id').ilike('email', likeRun);
  (extraInq.data || []).forEach((r) => created.inquiries.add(r.id));
  const resIds = [...created.reservations];
  const inqIds = [...created.inquiries];
  if (resIds.length || inqIds.length) await sr.from('outbox').delete().in('ref_id', [...resIds, ...inqIds]);
  if (resIds.length) {
    const { error } = await sr.from('reservations').delete().in('id', resIds);
    if (error) console.warn('予約の削除に失敗しました', error.message);
  }
  if (inqIds.length) await sr.from('inquiries').delete().in('id', inqIds);
  for (const id of created.users) await sr.auth.admin.deleteUser(id).catch(() => {});
  await sr.from('rate_limits').delete().like('bucket', 'sectest-' + RUN + '%');
});

// =====================================================================
describe('functions-1: お問い合わせの種類は決まった選択肢だけ・自動返信に送信者の文字列を載せない', () => {
  const TOPICS = ['ご予約について', 'ご予約の変更・キャンセル', '料金・お見積りについて', '法人利用・請求書払いについて',
    'キッチンカーのレンタルについて', '忘れ物について', 'その他'];

  test('報告の再現: 匿名で topic に URL → VALIDATION (保存もメールもしない)', async () => {
    const victim = 'phish-victim-' + RUN + '@example.com';
    const r = await call('/api/inquiries', {
      headers: { 'cf-connecting-ip': '203.0.113.77' },
      body: {
        name: 'アカウント確認のお願い', email: victim, topic: '至急 https://evil-phish.example/login?v=' + RUN, body: 'x',
        consent: { documents: [{ id: 'privacy', version: '2026-08' }], agreedAt: '2026-09-23T00:00:00Z' }
      }
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.code, 'VALIDATION');
    assert.ok(r.json.fields.topic);
    const { data } = await sr.from('inquiries').select('id').eq('email', victim);
    assert.equal(data.length, 0, '保存された');
    assert.equal((await emailsTo(victim)).length, 0, '第三者宛てにメールが送られた');
    // 店舗宛てを含め、この URL を載せたメールは1通も無い (モックには修正前の再現で送られたメールが残っているので、この実行の URL で探す)
    assert.equal((await mockEmails()).filter((e) => JSON.stringify(e).includes('evil-phish.example/login?v=' + RUN)).length, 0);
  });

  test('一覧にない種類は URL が無くても拒否 / contact.html の7種類はすべて通る', async () => {
    for (const topic of ['アカウント確認のお願い', 'ご予約について！', 'その他 evil.example', 'x'.repeat(61)]) {
      // service_role (レート制限なし) で入力検証だけを見る
      const r = await call('/api/inquiries', { token: 'service', body: { name: '検証', email: mail('topic'), topic, body: 'test', consent: { documents: [] } } });
      assert.equal(r.status, 400, topic);
      assert.equal(r.json.code, 'VALIDATION', topic);
      assert.ok(r.json.fields.topic, topic);
    }
    for (const topic of TOPICS) {
      // 同意なし = 入力検証を通ったあと CONSENT_REQUIRED (保存しない)
      const r = await call('/api/inquiries', { token: 'service', body: { name: '検証', email: mail('topic'), topic, body: 'test', consent: { documents: [] } } });
      assert.equal(r.json.code, 'CONSENT_REQUIRED', topic + ': ' + JSON.stringify(r.json));
    }
  });

  test('自動返信には名前・会社名・本文を載せない (種類は選択肢のまま)。店舗宛てには載せる', async () => {
    const email = mail('reply');
    const r = await call('/api/inquiries', {
      body: {
        idempotencyKey: key('inq'), name: 'アカウント確認のお願い', company: '至急ご対応ください商会', email,
        topic: 'その他', body: '本文は自動返信に載らない ' + RUN, consent: await consentPrivacy()
      }
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    created.inquiries.add(r.json.id);
    assert.equal(r.json.email.status, 'sent');
    const auto = await emailsTo(email);
    assert.equal(auto.length, 1);
    const t = auto[0].text;
    assert.ok(t.startsWith('お客様\n'), '宛名は固定の「お客様」: ' + t.slice(0, 40));
    for (const bad of ['アカウント確認のお願い', '至急ご対応ください商会', '本文は自動返信に載らない']) {
      assert.ok(!t.includes(bad) && !auto[0].subject.includes(bad), '自動返信に「' + bad + '」が載っている');
    }
    assert.ok(t.includes(r.json.id) && t.includes('お問い合わせの種類: その他'));
    const shop = (await emailsAbout(r.json.id)).filter((m) => m.to.includes(SHOP_EMAIL));
    assert.equal(shop.length, 1);
    assert.ok(shop[0].text.includes('アカウント確認のお願い'), '店舗宛てには名前を載せる');
  });

  test('同じ受信箱への自動返信は1日3通まで (+サブアドレス・大文字を変えても同じ)。超えた分も受け付けて店舗に通知する', async () => {
    const base = 'sec-' + RUN + '-cap';
    const addrs = [base + '@example.com', base.toUpperCase() + '+1@example.com', base + '+2@EXAMPLE.com', base + '+abc@example.com'];
    const results = [];
    for (const email of addrs) {
      const r = await call('/api/inquiries', {
        body: { idempotencyKey: key('cap'), name: '上限 太郎', email, topic: 'ご予約について', body: '上限のテスト', consent: await consentPrivacy() }
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      created.inquiries.add(r.json.id);
      results.push(r.json);
    }
    // 受付直後の送信は最大8秒だけ待つ設計。別のワーカーが先に取り出していれば 'queued' (後で送る) になるのは正常
    for (const st of results.slice(0, 3).map((x) => x.email.status)) assert.ok(['sent', 'queued'].includes(st), st);
    assert.equal(results[3].email.status, 'skipped', '4件目の自動返信は送らない');
    const { data } = await sr.from('inquiries').select('id').in('id', results.map((x) => x.id));
    assert.equal(data.length, 4, '4件目も保存される');
    // 送信待ちが残っていれば送り切るまで待つ (最大15秒)
    const until = Date.now() + 15000;
    let replies = [], shop = [];
    while (Date.now() < until) {
      await fetch(SUPABASE_URL + '/functions/v1/worker', { method: 'POST', headers: { authorization: 'Bearer ' + SERVICE, apikey: SERVICE } }).catch(() => {});
      replies = await emailsToMailbox(addrs[0]);
      shop = (await emailsAbout(results[3].id)).filter((m) => m.to.includes(SHOP_EMAIL));
      if (replies.length >= 3 && shop.length >= 1) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(replies.length, 3, '自動返信は3通まで');
    assert.equal(shop.length, 1, '4件目も店舗には通知する');
  });

  test('テンプレート: 対策前に保存された一覧外の種類は「その他」として出す (URL を載せない)', () => {
    const out = denoEval(
      "import { renderMail } from './_shared/mail-templates.ts';" +
      "const ctx = { siteUrl: 'http://127.0.0.1:8901/', site: { shopName: 'グロースレンタカー', company: '', line: 'L', email: 'e@example.com', hours: 'h' }, rules: null, payload: {}," +
      "  inquiry: { id: 'C09999', name: 'アカウント確認のお願い', topic: '至急 https://evil-phish.example/x', body: 'b', company: '', reservation_id: null, created_at: '2026-09-23T00:00:00Z', user_id: null } };" +
      "const a = renderMail('inquiry_received', ctx); const b = renderMail('inquiry_new_shop', ctx);" +
      "console.log(JSON.stringify({ a, b }));"
    );
    if (out === null) return; // deno が無い環境では省略
    const { a, b } = JSON.parse(out);
    assert.ok(a.text.includes('お問い合わせの種類: その他'));
    assert.ok(!a.text.includes('evil-phish') && !a.subject.includes('evil-phish'));
    assert.ok(!a.text.includes('アカウント確認のお願い'));
    assert.ok(!b.text.includes('evil-phish') && !b.subject.includes('evil-phish'), '店舗宛ても一覧外の種類は出さない');
  });
});

// =====================================================================
describe('functions-2 / func-2: レート制限の IP を利用者が書けるヘッダで変えられない', () => {
  test('報告の再現: cf-connecting-ip を毎回変えても X-Forwarded-For が同じなら同じ枠 (6回目で RATE_LIMITED)', async () => {
    const xff = testNet() + '::1';
    const codes = [];
    for (let i = 0; i < 6; i++) {
      // 同意なし (= 保存されない) の送信でも回数は数える
      const r = await call('/api/inquiries', {
        headers: { 'cf-connecting-ip': '203.0.113.' + (10 + i + randomInt(0, 200)), 'X-Forwarded-For': xff },
        body: { name: '連投', email: mail('cf'), topic: 'その他', body: 'test', consent: { documents: [] } }
      });
      codes.push(r.json.code);
    }
    assert.deepEqual(codes, ['CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'RATE_LIMITED']);
  });

  test('本番 (SITE_URL が公開 URL) では、内部アドレス・IP でない値・ヘッダ無しも共有の枠で数える / ローカル開発では数えない', async () => {
    const name = 'sectest-' + RUN + '-ip';
    const code = (site) =>
      "import { limitByIp, UNIDENTIFIED_FACTOR } from './_shared/ratelimit.ts';" +
      "const warns = []; console.warn = (...a) => warns.push(a.join(' '));" +
      "const variants = [{ 'x-forwarded-for': '10.0.0.1' }, { 'x-forwarded-for': '192.168.1.5, 172.18.0.1' }, { 'x-forwarded-for': 'unknown' }, {}," +
      "  { 'cf-connecting-ip': '203.0.113.' + Math.floor(Math.random() * 200), 'x-forwarded-for': '10.0.0.2' }];" +
      "const out = [];" +
      "for (let i = 0; i < 12; i++) {" +
      "  const headers = { authorization: 'Bearer " + ANON + "', ...variants[i % variants.length] };" +
      "  try { await limitByIp(new Request('http://x/api/inquiries', { method: 'POST', headers }), '" + name + "-' + " + JSON.stringify(site.tag) + ", 1, 86400); out.push('ok'); }" +
      "  catch (e) { out.push(e.code || String(e)); }" +
      "}" +
      // service_role は数えない
      "await limitByIp(new Request('http://x/', { headers: { authorization: 'Bearer " + SERVICE + "', 'x-forwarded-for': '10.0.0.1' } }), '" + name + "-' + " + JSON.stringify(site.tag) + ", 1, 86400);" +
      "console.log(JSON.stringify({ out, factor: UNIDENTIFIED_FACTOR, warns: warns.map((w) => JSON.parse(w).code) }));";

    const prod = denoEval(code({ tag: 'prod' }), { ...DB_ENV, SITE_URL: 'https://growth-rentacar.example/' });
    if (prod === null) return; // deno が無い環境では省略
    const p = JSON.parse(prod);
    assert.equal(p.factor, 10);
    assert.deepEqual(p.out, [...Array(10).fill('ok'), 'RATE_LIMITED', 'RATE_LIMITED'], '上限 1 × 10 倍の共有枠');
    assert.deepEqual(p.warns.sort(), ['CLIENT_IP_HEADER_UNSET', 'CLIENT_IP_UNIDENTIFIED'], '警告は1度ずつ');
    const { data: rows } = await sr.from('rate_limits').select('bucket, hits').eq('bucket', name + '-prod:ip:unidentified');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hits, 12, 'service_role の呼び出しは数えない');

    const local = JSON.parse(denoEval(code({ tag: 'local' }), { ...DB_ENV, SITE_URL: 'http://127.0.0.1:8901/' }));
    assert.deepEqual(local.out, Array(12).fill('ok'), 'ローカル開発では内部アドレスを数えない');
    assert.deepEqual(local.warns, [], 'ローカル開発では警告しない');
    const { data: none } = await sr.from('rate_limits').select('bucket').like('bucket', name + '-local%');
    assert.equal(none.length, 0);

    // CLIENT_IP_HEADER を設定すれば未設定の警告は出ない
    const set = JSON.parse(denoEval(code({ tag: 'hdr' }), { ...DB_ENV, SITE_URL: 'https://growth-rentacar.example/', CLIENT_IP_HEADER: 'x-real-ip' }));
    assert.ok(!set.warns.includes('CLIENT_IP_HEADER_UNSET'));
  });

  test('IP を特定できなくても、同じ受信箱宛ての予約確定メールは1日5件まで (会員・IP を毎回変えても)', async () => {
    const m = await makeMember('mailcap');
    const victim = 'sec-' + RUN + '-victim';
    const ph = phone();
    const codes = [];
    let retried = false;
    for (let i = 0; i < 6; i++) {
      const r = await reserve({
        token: m.token, hours: 3,
        customer: { name: '送り付け 太郎', email: victim + '+' + i + '@example.com', phone: ph },
        headers: () => ({ 'cf-connecting-ip': '203.0.113.' + randomInt(1, 250), 'X-Forwarded-For': testNet() + '::1' })
      });
      if (r.attempts > 1) retried = true;
      codes.push(r.status === 200 ? 'ok' : r.json.code);
      if (codes[codes.length - 1] === 'RATE_LIMITED') break;
    }
    const ok = codes.filter((c) => c === 'ok').length;
    assert.equal(codes[codes.length - 1], 'RATE_LIMITED', codes.join(','));
    assert.deepEqual(codes.slice(0, -1), Array(ok).fill('ok'), codes.join(','));
    // 空きの確認より後 (DB の確定時) に重なりが見つかってやり直した分も1件と数えるため、そのときだけ 5 件未満になりうる
    if (retried) assert.ok(ok >= 1 && ok <= 5, codes.join(','));
    else assert.equal(ok, 5, codes.join(','));
    const confirmations = (await emailsToMailbox(victim + '@example.com')).filter((e) => /ご予約確定/.test(e.subject));
    assert.equal(confirmations.length, ok, '予約確定メールは確定した件数だけ');
    const again = await reserve({ token: m.token, hours: 3, customer: { name: '送り付け 太郎', email: victim + '@example.com', phone: ph } });
    assert.equal(again.json.code, 'RATE_LIMITED');
  });
});

// =====================================================================
describe('func-1: 無認証の予約で車両を押さえ続けられない', () => {
  test('報告の再現: 匿名で93日の予約 → PERIOD_TOO_LONG (ゲストは1件31日まで)。32日も不可', async () => {
    for (const days of [93, 32]) {
      const r = await reserve({ hours: days * 24, customer: { name: '攻撃 太郎', email: mail('long'), phone: phone() }, expectedTotal: 1 });
      assert.equal(r.status, 400, days + '日: ' + JSON.stringify(r.json));
      assert.equal(r.json.code, 'PERIOD_TOO_LONG');
      assert.match(r.json.message, /ログインせずに.*最長31日/);
      assert.ok(r.json.fields.end);
    }
    const { data } = await sr.from('reservations').select('id').ilike('customer_email', 'sec-' + RUN + '-long-%');
    assert.equal(data.length, 0);
  });

  test('会員 (確認済みのアカウント) は31日を超えて予約できる', async () => {
    const m = await makeMember('long');
    const r = await reserve({ token: m.token, hours: 40 * 24, customer: { name: '会員 長期', email: m.email, phone: phone() } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.reservation.status, 'confirmed');
  });

  test('ゲスト: 同じメールアドレス (受信箱) は有効な予約3件まで。電話番号が同じでも同じ人として数える。キャンセルすれば枠が空く', async () => {
    const email = mail('hold');
    const ph = phone();
    const made = [];
    for (let i = 0; i < 3; i++) {
      const r = await reserve({ hours: 3, customer: { name: '押さえ 太郎', email, phone: ph } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      made.push(r.json);
    }
    // メールアドレスの書き方を変えても同じ受信箱
    let r = await reserve({ hours: 3, customer: { name: '押さえ 太郎', email: email.replace('@', '+x@').toUpperCase(), phone: phone() }, expectedTotal: undefined });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, 'RESERVATION_LIMIT');
    assert.match(r.json.message, /3件/);
    // 別のメールアドレスでも、電話番号 (書き方違い: +81) が同じなら同じ人
    r = await reserve({ hours: 3, customer: { name: '押さえ 次郎', email: mail('hold2'), phone: '+81 ' + ph.slice(1) } });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, 'RESERVATION_LIMIT');
    // 別の人は影響を受けない
    r = await reserve({ hours: 3, customer: { name: '別人 三郎', email: mail('other'), phone: phone() } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // 1件キャンセルすれば、もう1件予約できる
    const c0 = made[0];
    const lk = await call('/api/reservations/lookup', { body: { id: c0.reservation.id, token: c0.guestToken } });
    assert.equal(lk.status, 200);
    const cn = await call('/api/reservations/cancel', { body: { id: c0.reservation.id, token: c0.guestToken, expectedFee: lk.json.cancellation.fee } });
    assert.equal(cn.status, 200, JSON.stringify(cn.json));
    r = await reserve({ hours: 3, customer: { name: '押さえ 太郎', email, phone: ph } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { data } = await sr.from('reservations').select('id').eq('customer_email', email).in('status', ['confirmed', 'in_use']);
    assert.equal(data.length, 3);
  });

  test('ゲスト: 有効な予約の合計は31日分まで (20日 + 12日 → RESERVATION_LIMIT、20日 + 11日 は可)', async () => {
    const email = mail('days');
    const ph = phone();
    let r = await reserve({ hours: 20 * 24, customer: { name: '日数 太郎', email, phone: ph } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await reserve({ hours: 12 * 24, customer: { name: '日数 太郎', email, phone: ph } });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, 'RESERVATION_LIMIT');
    assert.match(r.json.message, /31日分/);
    r = await reserve({ hours: 11 * 24, customer: { name: '日数 太郎', email, phone: ph } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  test('報告の再現: 1人の匿名利用者が6台を31日ずつ押さえようとしても、2台目で止まる', async () => {
    const email = mail('fleet');
    const ph = phone();
    const codes = [];
    for (const assetId of ['V001', 'V002', 'V003', 'V004', 'V005', 'K001']) {
      const r = await reserve({ hours: 31 * 24, assets: [assetId], customer: { name: '攻撃 太郎', email, phone: ph } });
      codes.push(r.status === 200 ? 'ok' : r.json.code);
    }
    assert.deepEqual(codes, ['ok', 'RESERVATION_LIMIT', 'RESERVATION_LIMIT', 'RESERVATION_LIMIT', 'RESERVATION_LIMIT', 'RESERVATION_LIMIT']);
  });
});

// =====================================================================
describe('func-3: 自己申告の割引を当日確認できなかったときの金額を明示する', () => {
  test('法人割引の予約: お客様には割引前の金額、店舗には「未確認」「会社名の記入なし」「確認できない場合の請求額」', async () => {
    const email = mail('disc');
    const r = await reserve({ token: 'service', hours: 26, discountType: 'corporate', assets: ['V003'], customer: { name: '割引 太郎', email, phone: phone(), company: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { id, total, price } = r.json.reservation;
    assert.ok(price.discount > 0);
    const full = '¥' + (total + price.discount).toLocaleString('en-US');
    const mine = await emailsTo(email);
    assert.equal(mine.length, 1);
    assert.ok(mine[0].text.includes('割引前の料金 (' + full + ')'), mine[0].text);
    const shop = (await emailsAbout(id)).filter((m) => m.to.includes(SHOP_EMAIL));
    assert.equal(shop.length, 1);
    const line = shop[0].text.split('\n').find((l) => l.startsWith('割引'));
    assert.ok(line, shop[0].text);
    for (const needle of ['法人割引', '-¥' + price.discount.toLocaleString('en-US'), '未確認', '会社名の記入なし', '確認できない場合の請求額 ' + full]) {
      assert.ok(line.includes(needle), '店舗宛ての割引の行に「' + needle + '」がありません: ' + line);
    }
  });
});
