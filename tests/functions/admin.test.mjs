/**
 * admin Edge Function (supabase/functions/admin/index.ts) の結合テスト
 *   - POST /admin/staff/reset-mfa  (二段階認証のリセット・監査ログ)
 *   - POST /admin/outbox/process   ({refIds, limit} で対象と件数を絞る)
 *
 * 実行: node --test tests/functions/admin.test.mjs
 *
 * 前提 (ローカル検証環境。docs/production/implementation-v1.md §0):
 *   - supabase start 済み (API http://127.0.0.1:54321)
 *   - supabase functions serve --env-file supabase/functions/.env.local が起動中
 *
 * 守っていること:
 *   - スタッフ (管理者・対象・閲覧のみ) は実行ごとに作り、本物の TOTP で AAL2 にしてから呼ぶ。
 *     共有の管理者 (admin@example.com) の二段階認証には触れない。終わったらユーザーごと消す。
 *   - 送信キューのジョブは実行ごとに一意の ref_id で作り、終わったら消す。
 *     他の担当のワーカーが同時に動いていても崩れないよう、件数は「自分のジョブだけ・上限以下」で確かめる。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const FN = SUPABASE_URL + '/functions/v1';
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const sr = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = crypto.randomBytes(4).toString('hex');
const created = { users: [], outboxIds: [] };

// ---------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------
async function admin(path, token, body) {
  const headers = { apikey: ANON, authorization: 'Bearer ' + (token || ANON) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(FN + '/admin' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
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
function aalOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).aal;
}

/** スタッフを作る (メール確認済みの Auth ユーザー + staff 行) */
async function makeStaff(tag, role) {
  const email = 'f2-' + tag + '-' + RUN + '@example.com';
  const password = 'F2-' + crypto.randomBytes(9).toString('base64url') + '9a';
  const { data, error } = await sr.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  created.users.push(data.user.id);
  const ins = await sr.from('staff').insert({ user_id: data.user.id, name: 'テスト ' + tag, email, role });
  assert.ifError(ins.error);
  return { id: data.user.id, email, password };
}

/** パスワードでログイン (AAL1) → TOTP を登録・検証 (AAL2) */
async function signInWithTotp(staff, friendlyName) {
  const client = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const si = await client.auth.signInWithPassword({ email: staff.email, password: staff.password });
  assert.ifError(si.error);
  const aal1 = si.data.session.access_token;
  const en = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: friendlyName || 'f2-' + RUN });
  assert.ifError(en.error);
  const cv = await client.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: totp(en.data.totp.secret) });
  assert.ifError(cv.error);
  const token = cv.data.access_token;
  assert.equal(aalOf(token), 'aal2');
  return { client, aal1, token, factorId: en.data.id };
}

async function factorsOf(userId) {
  const { data, error } = await sr.auth.admin.mfa.listFactors({ userId });
  assert.ifError(error);
  return data.factors || [];
}

async function auditRows(rowId) {
  const { data, error } = await sr.from('audit_log').select('*')
    .eq('action', 'mfa_reset').eq('table_name', 'staff').eq('row_id', rowId).order('id');
  assert.ifError(error);
  return data;
}

// ---------------------------------------------------------------------
// 準備・後片付け
// ---------------------------------------------------------------------
let boss = null; // この実行専用の管理者 (AAL2)

before(async () => {
  const r = await admin('/__ping__');
  assert.equal(r.status, 404, 'admin 関数が起動していません: ' + r.text);
  assert.equal(r.json && r.json.code, 'NOT_FOUND');
  const s = await makeStaff('boss', 'admin');
  const aal = await signInWithTotp(s, 'f2-boss-' + RUN);
  boss = { ...s, ...aal };
});

after(async () => {
  if (created.outboxIds.length) await sr.from('outbox').delete().in('id', created.outboxIds);
  if (created.users.length) {
    await sr.from('audit_log').delete().eq('action', 'mfa_reset').in('row_id', created.users);
  }
  for (const id of created.users) await sr.auth.admin.deleteUser(id).catch(() => {});
});

// =====================================================================
describe('二段階認証のリセット (POST /admin/staff/reset-mfa)', () => {
  test('権限: 未ログイン 401 / AAL1 の管理者 403 / 閲覧のみ (AAL2) 403 / 入力不備 400 / スタッフ以外 404', async () => {
    const target = await makeStaff('t1', 'store_staff');
    const t = await signInWithTotp(target);
    assert.equal((await factorsOf(target.id)).length, 1);

    let r = await admin('/staff/reset-mfa', null, { userId: target.id });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json.code, 'UNAUTHENTICATED');

    r = await admin('/staff/reset-mfa', boss.aal1, { userId: target.id });
    assert.equal(r.status, 403, 'パスワードだけ (AAL1) の管理者は不可: ' + r.text);
    assert.equal(r.json.code, 'FORBIDDEN');

    const viewer = await makeStaff('viewer', 'viewer');
    const v = await signInWithTotp(viewer);
    r = await admin('/staff/reset-mfa', v.token, { userId: target.id });
    assert.equal(r.status, 403, '閲覧のみのスタッフは不可: ' + r.text);
    assert.equal(r.json.code, 'FORBIDDEN');
    // 対象のスタッフ (二段階認証済み) も staff.write は無い
    r = await admin('/staff/reset-mfa', t.token, { userId: viewer.id });
    assert.equal(r.status, 403, r.text);
    assert.equal((await factorsOf(target.id)).length, 1, '断られた操作では消えない');
    assert.equal((await factorsOf(viewer.id)).length, 1);

    r = await admin('/staff/reset-mfa', boss.token, { userId: 'not-a-uuid' });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'VALIDATION');
    assert.ok(r.json.fields.userId);
    r = await admin('/staff/reset-mfa', boss.token, {});
    assert.equal(r.status, 400);

    r = await admin('/staff/reset-mfa', boss.token, { userId: crypto.randomUUID() });
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.code, 'NOT_FOUND');

    // GET では使えない
    r = await admin('/staff/reset-mfa', boss.token);
    assert.equal(r.status, 405);
    assert.equal((await auditRows(target.id)).length, 0, '断られた操作は監査ログに残らない');
  });

  test('自分自身の二段階認証はリセットできない (403・消えない)', async () => {
    const before = await factorsOf(boss.id);
    assert.ok(before.length >= 1);
    const r = await admin('/staff/reset-mfa', boss.token, { userId: boss.id });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'FORBIDDEN');
    assert.match(r.json.message, /ご自身/);
    assert.equal((await factorsOf(boss.id)).length, before.length);
    // 大文字の UUID でも自分と判定する
    const r2 = await admin('/staff/reset-mfa', boss.token, { userId: boss.id.toUpperCase() });
    assert.equal(r2.status, 403, r2.text);
    assert.equal((await factorsOf(boss.id)).length, before.length);
    assert.equal((await auditRows(boss.id)).length, 0);
  });

  test('AAL2 の管理者は他のスタッフの TOTP (未確認の登録も) を全部消せる → 監査ログ → 本人は登録し直せる', async () => {
    const target = await makeStaff('t2', 'store_staff');
    const t = await signInWithTotp(target, 'f2-main-' + RUN);
    // 2つ目の登録 (確認前のまま) も消えること
    const en2 = await t.client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'f2-second-' + RUN });
    assert.ifError(en2.error);
    const before = await factorsOf(target.id);
    assert.equal(before.length, 2);
    assert.deepEqual(before.map((f) => f.status).sort(), ['unverified', 'verified']);

    let list = await admin('/staff/list', boss.token, {});
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.staff.find((s) => s.userId === target.id).mfaEnabled, true);

    const r = await admin('/staff/reset-mfa', boss.token, { userId: target.id });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, removed: 2 });
    assert.deepEqual(await factorsOf(target.id), []);
    assert.equal((await factorsOf(boss.id)).length, 1, '操作した管理者の登録はそのまま');

    list = await admin('/staff/list', boss.token, {});
    assert.equal(list.json.staff.find((s) => s.userId === target.id).mfaEnabled, false);

    // 監査ログ (service_role で直接記録)
    const rows = await auditRows(target.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, boss.id);
    assert.equal(rows[0].actor_role, 'admin');
    assert.equal(rows[0].diff.removed, 2);
    assert.equal(rows[0].diff.complete, true);
    assert.deepEqual(rows[0].diff.factors.map((f) => f.type), ['totp', 'totp']);
    assert.ok(!JSON.stringify(rows[0].diff).includes('f2-main-'), '登録名 (端末名など) は記録しない');
    assert.ok(Date.now() - Date.parse(rows[0].at) < 10 * 60e3);

    // 登録が無くなった後にもう一度 → removed 0 (これも記録する)
    const again = await admin('/staff/reset-mfa', boss.token, { user_id: target.id });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json, { ok: true, removed: 0 });
    assert.equal((await auditRows(target.id)).length, 2);

    // 本人はパスワードでログインし直し、新しい認証アプリを登録して AAL2 に戻れる
    const re = await signInWithTotp(target, 'f2-new-' + RUN);
    assert.equal(aalOf(re.token), 'aal2');
    const after = await factorsOf(target.id);
    assert.equal(after.length, 1);
    assert.equal(after[0].status, 'verified');
  });
});

// =====================================================================
describe('ワーカーの手動実行 (POST /admin/outbox/process)', () => {
  test('{refIds, limit}: 指定した予約番号などのジョブだけを、limit 件まで処理する', async () => {
    const REF = 'F2-' + RUN;
    const OTHER = 'F2-other-' + RUN;
    // 未対応テンプレート = 送信せずに failed (再試行なし) になる。メールは出ない
    const job = (ref) => ({ template: 'no_such_template', to_email: 'f2-outbox-' + RUN + '@example.com', payload: {}, ref_type: 'test', ref_id: ref });
    const { data: rows, error } = await sr.from('outbox').insert([job(REF), job(REF), job(REF), job(OTHER)]).select('id, ref_id');
    assert.ifError(error);
    rows.forEach((x) => created.outboxIds.push(x.id));
    const mine = rows.filter((x) => x.ref_id === REF).map((x) => x.id);
    const other = rows.find((x) => x.ref_id === OTHER).id;

    const r1 = await admin('/outbox/process', boss.token, { refIds: [REF], limit: 2 });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.processed, r1.json.results.length);
    const ids1 = r1.json.results.map((x) => x.id);
    assert.ok(ids1.length >= 1 && ids1.length <= 2, 'limit を超えない: ' + JSON.stringify(ids1));
    assert.ok(ids1.every((id) => mine.includes(id)), '指定した ref_id のジョブだけ: ' + JSON.stringify(ids1));
    assert.ok(r1.json.results.every((x) => x.status === 'failed'));

    const r2 = await admin('/outbox/process', boss.token, { refIds: [REF, REF], limit: 10 });
    assert.equal(r2.status, 200, r2.text);
    const ids2 = r2.json.results.map((x) => x.id);
    assert.ok(ids2.every((id) => mine.includes(id) && !ids1.includes(id)), '処理済みのジョブは繰り返さない: ' + JSON.stringify(ids2));
    assert.ok(![...ids1, ...ids2].includes(other), '別の ref_id は処理しない');

    const { data: after } = await sr.from('outbox').select('id, status, attempts').in('id', mine).order('id');
    assert.deepEqual(after.map((x) => [x.status, x.attempts]), [['failed', 1], ['failed', 1], ['failed', 1]], '3件とも1回ずつ処理された');

    // 空の一覧は「対象なし」(全件の処理にはならない)
    const r3 = await admin('/outbox/process', boss.token, { refIds: [] });
    assert.equal(r3.status, 200, r3.text);
    assert.deepEqual([r3.json.processed, r3.json.results], [0, []]);

    // 入力不備
    for (const bad of [{ refIds: REF }, { refIds: [''] }, { refIds: ['x'.repeat(65)] }, { refIds: [123] }, { refIds: Array(51).fill(REF) }]) {
      const r = await admin('/outbox/process', boss.token, bad);
      assert.equal(r.status, 400, JSON.stringify(bad) + ' → ' + r.text);
      assert.equal(r.json.code, 'VALIDATION');
      assert.ok(r.json.fields.refIds);
    }
  });
});
