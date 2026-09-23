#!/usr/bin/env node
/**
 * ブラウザとサーバーで共用するファイルを Edge Function 側 (supabase/functions/_shared/) へコピーする。
 *
 *   正本: js/pricing-core.js  →  コピー: supabase/functions/_shared/pricing-core.js
 *
 * 使い方:
 *   node scripts/sync-shared.mjs          … コピーする (内容が同じなら何もしない)
 *   node scripts/sync-shared.mjs --check  … 一致しているか確認するだけ (違えば終了コード 1)
 *
 * js/pricing-core.js を直したら必ず実行すること (tests/pricing.test.mjs がバイト一致を検査する)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// [正本, コピー先] (リポジトリ直下からの相対パス)
const FILES = [
  ['js/pricing-core.js', 'supabase/functions/_shared/pricing-core.js']
];

const checkOnly = process.argv.includes('--check');
let mismatch = 0;

for (const [src, dst] of FILES) {
  const srcPath = join(ROOT, src);
  const dstPath = join(ROOT, dst);
  const body = readFileSync(srcPath);
  const current = existsSync(dstPath) ? readFileSync(dstPath) : null;

  if (current && current.equals(body)) {
    console.log('一致しています: ' + dst);
    continue;
  }
  if (checkOnly) {
    console.error('一致していません: ' + dst + ' が ' + src + ' と違います。node scripts/sync-shared.mjs を実行してください。');
    mismatch++;
    continue;
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, body);
  console.log('コピーしました: ' + src + ' → ' + dst);
}

process.exit(mismatch ? 1 : 0);
