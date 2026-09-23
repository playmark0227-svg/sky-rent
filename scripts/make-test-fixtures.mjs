#!/usr/bin/env node
/**
 * ローカル検証用のダミー資格情報を作る (git には入れない)。
 *   - tests/fixtures/test-sa-key.pem / test-sa-pub.pem / test-service-account.json
 *       … Google モック (tests/mocks/google-mock.mjs) 専用の使い捨て鍵。本物の Google では使えない。
 *   - supabase/functions/.env.local
 *       … supabase functions serve 用の環境変数 (モックの URL と、ランダムな秘密値)。
 * 既にあるファイルは上書きしない (--force で作り直す)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const force = process.argv.includes('--force');
fs.mkdirSync(FIX, { recursive: true });

const keyPath = path.join(FIX, 'test-sa-key.pem');
const pubPath = path.join(FIX, 'test-sa-pub.pem');
const saPath = path.join(FIX, 'test-service-account.json');
if (force || !fs.existsSync(keyPath)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('作成: tests/fixtures/test-sa-key.pem, test-sa-pub.pem');
}
const sa = {
  type: 'service_account', project_id: 'skyrent-test', private_key_id: 'test-key-1',
  private_key: fs.readFileSync(keyPath, 'utf8'),
  client_email: 'skyrent-calendar@skyrent-test.iam.gserviceaccount.com', client_id: '1',
  token_uri: 'http://host.docker.internal:8979/token'
};
fs.writeFileSync(saPath, JSON.stringify(sa, null, 2));

const envPath = path.join(ROOT, 'supabase', 'functions', '.env.local');
if (force || !fs.existsSync(envPath)) {
  const rnd = n => crypto.randomBytes(n).toString('base64url');
  fs.writeFileSync(envPath, [
    '# ローカル検証用 (git に入れない)。本番の値は Supabase の secrets に設定する',
    'SITE_URL=http://127.0.0.1:8901/',
    'ALLOWED_ORIGINS=http://127.0.0.1:8901,http://localhost:8901',
    'GUEST_TOKEN_SECRET=' + rnd(32),
    'WORKER_SECRET=' + rnd(32),
    'RESEND_API_KEY=re_test_local',
    'RESEND_API_BASE=http://host.docker.internal:8978',
    'MAIL_FROM=グロースレンタカー <noreply@growth-rentacar.test>',
    'SHOP_NOTIFY_EMAIL=shop@growth-rentacar.test',
    'GOOGLE_SERVICE_ACCOUNT_JSON=' + Buffer.from(JSON.stringify(sa)).toString('base64'),
    'GOOGLE_API_BASE=http://host.docker.internal:8979',
    'GOOGLE_TOKEN_URL=http://host.docker.internal:8979/token',
    ''
  ].join('\n'));
  console.log('作成: supabase/functions/.env.local');
}
console.log('テスト用の資格情報を用意しました (本物の Google・メールには接続しません)');
