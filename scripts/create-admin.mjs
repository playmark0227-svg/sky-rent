#!/usr/bin/env node
/**
 * グロースレンタカー - 最初の管理者 (スタッフ role = 'admin') を作成するスクリプト
 *
 * 使い方 (リポジトリ直下で):
 *   npm install
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role キー または sb_secret_ キー> \
 *     node scripts/create-admin.mjs --email you@example.com --name "山田 太郎" [--password 'Abcdefg123']
 *
 *   .env ファイルに書いた場合: node --env-file=.env.admin scripts/create-admin.mjs --email ... --name ...
 *
 * 動き:
 *   1. Supabase Auth にユーザーを作成 (メール確認済みとして作成。確認メールは送られない)
 *   2. staff テーブルに role = 'admin'・全拠点 (location_ids = null) で登録
 *   - 同じメールアドレスのユーザーが既にいる場合は、ユーザーは作らず staff 行だけ作成します
 *     (パスワードは変更しません)。既に staff 行があれば admin・有効に更新します。
 *   - --password を省略すると、強いパスワードを自動生成して 1 回だけ表示します。
 *   - 二段階認証 (TOTP) は、本人が管理画面 (manage/login.html) に初めてログインしたときに設定します。
 *
 * 二段階認証のやり直し (認証アプリを入れたスマホの紛失・機種変更):
 *   node scripts/create-admin.mjs --email you@example.com --reset-mfa
 *   → そのユーザーの二段階認証の登録をすべて削除します (ログイン中のセッションも切れます)。
 *     次回ログイン時に登録画面が再び表示されます。スタッフの役割は変えません。
 *
 * 注意: service_role キーは全データを操作できる鍵です。画面共有・チャット・Git に残さないでください。
 */
'use strict';

import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';

const USAGE = `使い方:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \\
    node scripts/create-admin.mjs --email <メールアドレス> --name <氏名> [--password <パスワード>]

  --email      管理者のメールアドレス (必須)
  --name       管理者の氏名 (必須。管理画面の右上に表示されます)
  --password   初期パスワード (省略時は自動生成して表示)。8文字以上・英大文字/英小文字/数字を各1文字以上
  --reset-mfa  二段階認証の登録を削除する (スマホ紛失時)。--email だけ指定します
  --help       この説明を表示`;

function fail(message, code = 1) {
  console.error(`\nエラー: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------
// 引数・環境変数
// ---------------------------------------------------------------------
let args;
try {
  args = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      'reset-mfa': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  }).values;
} catch (e) {
  fail(`引数を読み取れませんでした (${e.message})。\n\n${USAGE}`);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const email = String(args.email || '').trim().toLowerCase();
const name = String(args.name || '').trim();
const resetMfa = !!args['reset-mfa'];
let password = args.password == null ? '' : String(args.password);
const generated = !password;

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail(`--email に正しいメールアドレスを指定してください。\n\n${USAGE}`);
}
if (resetMfa && (name || !generated)) {
  fail('--reset-mfa は --email だけと一緒に指定してください (--name / --password は使いません)。');
}
if (!resetMfa && !name) fail(`--name に氏名を指定してください。\n\n${USAGE}`);
if (name.length > 100) fail('--name は 100 文字以内で指定してください。');

// supabase/config.toml の minimum_password_length = 8 / lower_upper_letters_digits と同じ条件
function passwordProblem(pw) {
  if (pw.length < 8) return '8文字以上にしてください';
  if (!/[a-z]/.test(pw)) return '英小文字を1文字以上含めてください';
  if (!/[A-Z]/.test(pw)) return '英大文字を1文字以上含めてください';
  if (!/[0-9]/.test(pw)) return '数字を1文字以上含めてください';
  return null;
}

// 紛らわしい文字 (0/O, 1/l/I) を除いた16文字。各文字種を必ず含める
function generatePassword() {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const all = lower + upper + digit;
  const pick = (set) => set[randomInt(set.length)];
  const chars = [pick(lower), pick(upper), pick(digit)];
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

if (resetMfa) {
  // 二段階認証のやり直しではパスワードを扱わない
} else if (generated) {
  password = generatePassword();
} else {
  const problem = passwordProblem(password);
  if (problem) fail(`--password が条件を満たしていません: ${problem}。`);
}

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!url || !/^https?:\/\//.test(url)) {
  fail('環境変数 SUPABASE_URL を設定してください (例: https://xxxx.supabase.co)。');
}
if (!key) {
  fail('環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください (ダッシュボード → Project Settings → API Keys の service_role / secret キー)。');
}
// anon / publishable キーを誤って渡したときに分かりやすく止める
if (key.startsWith('sb_publishable_')) {
  fail('SUPABASE_SERVICE_ROLE_KEY に公開用 (publishable) キーが入っています。service_role (secret) キーを指定してください。');
}
if (key.split('.').length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    if (payload.role && payload.role !== 'service_role') {
      fail(`SUPABASE_SERVICE_ROLE_KEY に role = "${payload.role}" のキーが入っています。service_role キーを指定してください。`);
    }
  } catch {
    // JWT として読めない形式はそのまま使う (新形式のキーなど)
  }
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function describeError(error) {
  const msg = String((error && error.message) || error || '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
    return `Supabase に接続できませんでした。SUPABASE_URL (${url}) が正しいか、ネットワークを確認してください。`;
  }
  if (/invalid api key|invalid jwt|jwt|unauthorized|not allowed|401|403/i.test(msg)) {
    return 'キーが正しくないため拒否されました。SUPABASE_SERVICE_ROLE_KEY に service_role (secret) キーを指定しているか確認してください。';
  }
  return msg || '原因不明のエラーです。';
}

// ---------------------------------------------------------------------
// 1. Auth ユーザー
// ---------------------------------------------------------------------
async function findUserByEmail(target) {
  const perPage = 1000;
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data && data.users) || [];
    const hit = users.find((u) => String(u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) break;
  }
  return null;
}

async function ensureUser() {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { account_type: 'staff', name },
  });
  if (!error && data && data.user) return { user: data.user, created: true };

  const code = error && (error.code || '');
  const msg = String((error && error.message) || '');
  const exists = code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered|already exists/i.test(msg);
  if (!exists) {
    if (code === 'weak_password' || /password/i.test(msg)) {
      throw new Error(`パスワードが Supabase の条件を満たしていません (${msg})。別のパスワードを指定してください。`);
    }
    throw new Error(`ユーザーを作成できませんでした: ${describeError(error)}`);
  }
  const user = await findUserByEmail(email);
  if (!user) throw new Error('同じメールアドレスのユーザーがいるはずですが、見つかりませんでした。ダッシュボードの Authentication → Users を確認してください。');
  return { user, created: false };
}

// ---------------------------------------------------------------------
// 2. staff 行
// ---------------------------------------------------------------------
async function ensureStaff(user) {
  const { data: current, error: selErr } = await supabase
    .from('staff')
    .select('user_id, role, active, name')
    .eq('user_id', user.id)
    .maybeSingle();
  if (selErr) {
    if (/relation .*staff.* does not exist|Could not find the table/i.test(selErr.message || '')) {
      throw new Error('staff テーブルがありません。先に「supabase db push」でデータベースを作成してください。');
    }
    throw new Error(`スタッフ情報を読めませんでした: ${describeError(selErr)}`);
  }

  if (!current) {
    const { error } = await supabase.from('staff').insert({
      user_id: user.id,
      name,
      email,
      role: 'admin',
      location_ids: null,
      active: true,
    });
    if (error) throw new Error(`スタッフとして登録できませんでした: ${describeError(error)}`);
    return 'created';
  }
  if (current.role === 'admin' && current.active) return 'unchanged';

  const { error } = await supabase
    .from('staff')
    .update({ role: 'admin', active: true })
    .eq('user_id', user.id);
  if (error) throw new Error(`スタッフ情報を更新できませんでした: ${describeError(error)}`);
  return `updated (${current.role}${current.active ? '' : '・無効'} → admin・有効)`;
}

async function isMember(userId) {
  const { data } = await supabase.from('members').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------
// 二段階認証の登録を削除 (--reset-mfa)
// ---------------------------------------------------------------------
async function resetMfaFactors() {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`${email} のユーザーが見つかりません。メールアドレスを確認してください。`);
  const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId: user.id });
  if (error) throw new Error(`二段階認証の登録を読めませんでした: ${describeError(error)}`);
  const factors = (data && data.factors) || [];
  let removed = 0;
  for (const f of factors) {
    const { error: delErr } = await supabase.auth.admin.mfa.deleteFactor({ userId: user.id, id: f.id });
    if (delErr) throw new Error(`二段階認証の登録を削除できませんでした: ${describeError(delErr)}`);
    removed++;
  }
  console.log(`\n${email} の二段階認証の登録を ${removed} 件削除しました。`);
  console.log(removed
    ? '次回ログイン時に、二段階認証の登録画面 (QR コード) が表示されます。'
    : '登録はありませんでした (次回ログイン時に登録画面が表示されます)。');
}

// ---------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------
try {
  console.log(`\n接続先: ${url}`);
  if (resetMfa) {
    await resetMfaFactors();
    process.exit(0);
  }
  const { user, created } = await ensureUser();
  const staffResult = await ensureStaff(user);
  const member = await isMember(user.id);

  console.log('\n完了しました。');
  console.log(`  メールアドレス : ${email}`);
  console.log(`  氏名           : ${name}`);
  console.log(`  ユーザーID     : ${user.id}`);
  console.log(`  Auth ユーザー  : ${created ? '新しく作成しました (メール確認済み)' : '既存のユーザーを使いました (パスワードは変更していません)'}`);
  console.log(`  スタッフ登録   : ${
    staffResult === 'created' ? '管理者 (admin・全拠点) として登録しました'
      : staffResult === 'unchanged' ? '既に管理者として登録済みです (変更なし)'
        : `管理者に更新しました ${staffResult.replace(/^updated /, '')}`}`);
  if (created && generated) {
    console.log('\n  初期パスワード (この画面にしか表示されません。安全な場所に控えてください):');
    console.log(`    ${password}`);
  }
  if (member) {
    console.log('\n  ※ このアカウントは会員としても登録されています。スタッフ用には会員とは別のメールアドレスをおすすめします。');
  }
  console.log(`
次の手順:
  1. 公開サイトの manage/login.html を開き、上のメールアドレスとパスワードでログインします。
  2. 初回は二段階認証の設定画面が出ます。スマートフォンの認証アプリ (Google Authenticator /
     Microsoft Authenticator など) で QR コードを読み取り、表示された 6 桁の数字を入力してください。
  3. 自動生成のパスワードを使った場合は、ログイン画面の「パスワードを忘れた方」から変更できます。
`);
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : describeError(e));
}
