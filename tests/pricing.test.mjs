/**
 * 料金計算エンジンのテスト (js/pricing-core.js / js/pricing.js)
 *
 * 実行: node --test tests/pricing.test.mjs
 *   実行環境のタイムゾーンに依存しないことを確かめるため、次の両方で通すこと。
 *     TZ=UTC        node --test tests/pricing.test.mjs
 *     TZ=Asia/Tokyo node --test tests/pricing.test.mjs
 *
 * 期待値はすべて「レンタカー 総合料金表 (2026年6月改定版)」(seed.sql の pricing_rules) から手計算した値。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PATH = join(ROOT, 'js/pricing-core.js');
const SHARED_PATH = join(ROOT, 'supabase/functions/_shared/pricing-core.js');
const ADAPTER_PATH = join(ROOT, 'js/pricing.js');
const SEED_PATH = join(ROOT, 'supabase/seed.sql');

await import(pathToFileURL(CORE_PATH).href);
const C = globalThis.SkyRentPricingCore;

// ---- テスト用データ (seed.sql と同じ値) ----
const COMPACT = { id: 'V001', categoryId: 'cat-rental', priceHour: 1100, priceDay: 7700, customFields: { bodyType: 'コンパクト' } };
const SUV = { id: 'V003', categoryId: 'cat-rental', priceHour: 2200, priceDay: 17000, customFields: { bodyType: 'SUV' } };
const MINIVAN = { id: 'V004', categoryId: 'cat-rental', priceHour: 2200, priceDay: 17000, customFields: { bodyType: 'ミニバン' } };
const KEI = { id: 'V005', categoryId: 'cat-rental', priceHour: 1100, priceDay: 7700, customFields: { bodyType: '軽トラック' } };
const KITCHEN = { id: 'K001', categoryId: 'cat-kitchen', priceHour: null, priceDay: 22000, customFields: {} };
const CDW = { id: 'OP101', name: '免責補償制度 (CDW)', price: 1650, priceShort: 1100, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover' };
const PAP = { id: 'OP102', name: '安心保証コース (PAP)', price: 3300, priceShort: 2200, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover' };
const KCDW = { id: 'OP201', name: '免責補償制度 (CDW)', price: 3300, priceShort: null, priceType: 'per_day', categoryIds: ['cat-kitchen'], exclusiveGroup: 'cover' };

// 日本時間の日時 'YYYY-MM-DD HH:mm' → ISO (+09:00)
const jst = s => s.replace(' ', 'T') + ':00+09:00';
const q = (asset, start, end, extra) => C.quote(Object.assign({ asset, start: jst(start), end: jst(end) }, extra || {}));
const line = (quote, code) => quote.lines.filter(l => l.code === code);
const sumLines = quote => quote.lines.reduce((s, l) => s + l.amount, 0);

// 平日だけに収まる期間の基準: 2026-10-05 (月) 〜 10-09 (金)。10-12 はスポーツの日。

describe('基本料金', () => {
  test('コンパクト 平日 10:00→13:00 (3時間) = 3,300 (時間料金)', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-05 13:00');
    assert.equal(r.ok, true);
    assert.equal(r.hours, 3);
    assert.equal(r.days, 1);
    assert.equal(r.plan, 'hourly');
    assert.equal(r.base, 3300);
    assert.equal(r.total, 3300);
  });
  test('コンパクト 平日 10:00→翌10:00 = 7,700', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00');
    assert.equal(r.hours, 24);
    assert.equal(r.plan, 'daily');
    assert.equal(r.base, 7700);
    assert.equal(r.total, 7700);
    assert.equal(line(r, 'extension').length, 0);
  });
  test('コンパクト 26時間 = 7,700 + 延長 2,200 = 9,900 (行を分ける)', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 12:00');
    assert.equal(r.hours, 26);
    assert.equal(r.days, 2);
    assert.equal(r.base, 9900);
    assert.equal(r.total, 9900);
    assert.deepEqual(line(r, 'base').map(l => [l.label, l.amount]), [['基本料金 (24時間 × 1)', 7700]]);
    assert.deepEqual(line(r, 'extension').map(l => [l.label, l.amount]), [['延長料金 (2時間)', 2200]]);
  });
  test('コンパクト 8時間 = 7,700 (8,800 より24時間料金が安い)', () => {
    const r = q(COMPACT, '2026-10-05 09:00', '2026-10-05 17:00');
    assert.equal(r.hours, 8);
    assert.equal(r.plan, 'daily');
    assert.equal(r.base, 7700);
  });
  test('コンパクト 48時間 = 15,400', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-07 10:00');
    assert.equal(r.hours, 48);
    assert.equal(r.days, 2);
    assert.equal(r.base, 15400);
    assert.equal(r.total, 15400);
  });
  test('延長が24時間料金を超えるときは24時間料金が上限 (31時間 → 7,700 + 7,700)', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 17:00');
    assert.equal(r.hours, 31);
    assert.equal(r.base, 15400);
  });
  test('SUV 平日 24時間 = 17,000', () => {
    const r = q(SUV, '2026-10-05 10:00', '2026-10-06 10:00');
    assert.equal(r.base, 17000);
    assert.equal(r.total, 17000);
  });
  test('キッチンカー (時間貸しなし) 5時間 = 22,000', () => {
    const r = q(KITCHEN, '2026-10-05 10:00', '2026-10-05 15:00');
    assert.equal(r.plan, 'daily');
    assert.equal(r.base, 22000);
    assert.equal(r.total, 22000);
  });
  test('キッチンカー 30時間 = 22,000 + 22,000 = 44,000', () => {
    const r = q(KITCHEN, '2026-10-05 10:00', '2026-10-06 16:00');
    assert.equal(r.hours, 30);
    assert.equal(r.base, 44000);
    assert.equal(line(r, 'extension')[0].amount, 22000);
  });
  test('端数は切り上げ・最低1時間 (3時間1分 → 4時間 / 10分 → 1時間)', () => {
    assert.equal(q(COMPACT, '2026-10-05 10:00', '2026-10-05 13:01').base, 4400);
    assert.equal(q(COMPACT, '2026-10-05 10:00', '2026-10-05 10:10').hours, 1);
    assert.equal(C.hoursBetween(jst('2026-10-05 10:00'), jst('2026-10-05 10:00')), 1);
  });
  test('期間が不正なら INVALID_PERIOD', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-05 09:00');
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['INVALID_PERIOD']);
    assert.equal(r.total, 0);
    assert.deepEqual(C.quote({ asset: COMPACT, start: 'あした', end: jst('2026-10-05 10:00') }).errors, ['INVALID_PERIOD']);
  });
  test('車両が無ければ INVALID_ASSET', () => {
    assert.deepEqual(C.quote({ asset: null, start: jst('2026-10-05 10:00'), end: jst('2026-10-05 12:00') }).errors, ['INVALID_ASSET']);
  });
  test('rulesVersion を返し、行の合計 = total', () => {
    const r = q(COMPACT, '2026-10-02 21:00', '2026-10-04 07:00', { options: [CDW], discountType: 'student', coupon: { id: 'C1', amount: 500 } });
    assert.equal(r.rulesVersion, '2026-06');
    assert.equal(sumLines(r), r.total);
    assert.equal(r.total, r.subtotal - r.discount - r.couponDiscount);
  });
});

describe('オプション (補償)', () => {
  const cdw = (s, e) => line(q(COMPACT, s, e, { options: [CDW] }), 'option')[0].amount;
  test('CDW 3時間 = 1,100 (短時間料金)', () => assert.equal(cdw('2026-10-05 10:00', '2026-10-05 13:00'), 1100));
  test('CDW 6時間 = 1,100 / 7時間 = 1,650', () => {
    assert.equal(cdw('2026-10-05 10:00', '2026-10-05 16:00'), 1100);
    assert.equal(cdw('2026-10-05 10:00', '2026-10-05 17:00'), 1650);
  });
  test('CDW 24時間 = 1,650', () => assert.equal(cdw('2026-10-05 10:00', '2026-10-06 10:00'), 1650));
  test('CDW 30時間 = 1,650 + 1,100 = 2,750', () => assert.equal(cdw('2026-10-05 10:00', '2026-10-06 16:00'), 2750));
  test('CDW 48時間 = 3,300', () => assert.equal(cdw('2026-10-05 10:00', '2026-10-07 10:00'), 3300));
  test('CDW 36時間 = 1,650 + 1,650 (端数12時間 > 6)', () => assert.equal(cdw('2026-10-05 10:00', '2026-10-06 22:00'), 3300));
  test('キッチンカー CDW (短時間料金なし) 5時間 = 3,300', () => {
    assert.equal(line(q(KITCHEN, '2026-10-05 10:00', '2026-10-05 15:00', { options: [KCDW] }), 'option')[0].amount, 3300);
  });
  test('per_rental は1回だけ', () => {
    const once = { id: 'X1', name: 'チャイルドシート', price: 550, priceType: 'per_rental', categoryIds: null };
    assert.equal(line(q(COMPACT, '2026-10-05 10:00', '2026-10-08 10:00', { options: [once] }), 'option')[0].amount, 550);
  });
  test('CDW と PAP の同時選択 → OPTION_CONFLICT', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [CDW, PAP] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.includes('OPTION_CONFLICT'));
  });
  test('同じオプションの重複指定は1つとして扱う (衝突にしない)', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [CDW, CDW] });
    assert.equal(r.ok, true);
    assert.equal(line(r, 'option').length, 1);
  });
  test('他カテゴリ専用のオプション → OPTION_NOT_APPLICABLE', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [KCDW] });
    assert.ok(r.errors.includes('OPTION_NOT_APPLICABLE'));
  });
  test('DB 行 (snake_case) のままでも計算できる', () => {
    const row = { id: 'OP101', name: '免責補償制度 (CDW)', price: 1650, price_short: 1100, price_type: 'per_day', category_ids: ['cat-rental'], exclusive_group: 'cover' };
    const asset = { id: 'V001', category_id: 'cat-rental', price_hour: 1100, price_day: 7700, custom_fields: {} };
    const r = q(asset, '2026-10-05 10:00', '2026-10-05 13:00', { options: [row] });
    assert.equal(r.total, 3300 + 1100);
  });
});

describe('土日祝割増', () => {
  const fee = r => line(r, 'weekend').reduce((s, l) => s + l.amount, 0);
  test('2026-09-26 (土) 10:00→16:00 → +330', () => {
    const r = q(COMPACT, '2026-09-26 10:00', '2026-09-26 16:00');
    assert.equal(fee(r), 330);
    assert.equal(r.total, 6600 + 330);
  });
  test('2026-09-24 (木) 10:00→16:00 → 割増なし', () => assert.equal(fee(q(COMPACT, '2026-09-24 10:00', '2026-09-24 16:00')), 0));
  test('2026-09-22 (火・国民の休日) → +330', () => assert.equal(fee(q(COMPACT, '2026-09-22 10:00', '2026-09-22 16:00')), 330));
  test('金 10:00 → 土 10:00 → +330 (1回だけ)', () => assert.equal(fee(q(COMPACT, '2026-10-02 10:00', '2026-10-03 10:00')), 330));
  test('土日を丸ごと含んでも1回だけ', () => assert.equal(fee(q(COMPACT, '2026-10-02 10:00', '2026-10-05 10:00')), 330));
  test('終了がちょうど土曜 0:00 なら土曜には触れない (終了の1ms前の日まで)', () => {
    assert.equal(fee(q(COMPACT, '2026-10-01 10:00', '2026-10-03 00:00')), 0);
    assert.equal(fee(q(COMPACT, '2026-10-01 10:00', '2026-10-03 00:01')), 330);
  });
  test('extraHolidays (臨時の祝日扱い) も対象', () => {
    const rules = Object.assign({}, C.DEFAULT_RULES, { extraHolidays: ['2026-10-06'] });
    assert.equal(fee(q(COMPACT, '2026-10-06 10:00', '2026-10-06 16:00', { rules })), 330);
    assert.equal(fee(q(COMPACT, '2026-10-06 10:00', '2026-10-06 16:00')), 0);
  });
});

describe('繁忙期割増', () => {
  test('2026-05-02 10:00→05-03 10:00 → +550 のみ (土日でも 330 は付かない)', () => {
    const r = q(COMPACT, '2026-05-02 10:00', '2026-05-03 10:00');
    assert.equal(r.busy, true);
    assert.deepEqual(line(r, 'busy').map(l => l.amount), [550]);
    assert.equal(line(r, 'weekend').length, 0);
    assert.equal(r.total, 7700 + 550);
  });
  test('2026-12-31→2027-01-02 (年またぎ) → +550', () => {
    const r = q(COMPACT, '2026-12-31 10:00', '2027-01-02 10:00');
    assert.equal(r.busy, true);
    assert.equal(line(r, 'busy')[0].amount, 550);
    assert.equal(r.total, 15400 + 550);
  });
  test('2027-01-04 (月) 平日 → 割増なし', () => {
    const r = q(COMPACT, '2027-01-04 10:00', '2027-01-04 16:00');
    assert.equal(r.busy, false);
    assert.equal(line(r, 'busy').length + line(r, 'weekend').length, 0);
    assert.equal(r.total, 6600);
  });
  test('期間の途中で繁忙期に入れば適用 (4/24 金 → 4/27 月)', () => {
    const r = q(COMPACT, '2026-04-24 10:00', '2026-04-27 10:00');
    assert.equal(r.busy, true);
    assert.equal(line(r, 'weekend').length, 0);
  });
  test('終了がちょうど 4/26 0:00 なら繁忙期ではない (土曜なので土日祝割増)', () => {
    const r = q(COMPACT, '2026-04-25 10:00', '2026-04-26 00:00');
    assert.equal(r.busy, false);
    assert.equal(line(r, 'weekend')[0].amount, 330);
  });
});

describe('夜間料金', () => {
  const fee = r => line(r, 'night').reduce((s, l) => s + l.amount, 0);
  test('貸出 21:00 → +1,100', () => assert.equal(fee(q(COMPACT, '2026-10-05 21:00', '2026-10-06 12:00')), 1100));
  test('貸出 7:00 返却 21:00 → +2,200', () => assert.equal(fee(q(COMPACT, '2026-10-05 07:00', '2026-10-05 21:00')), 2200));
  test('貸出 8:00 → なし', () => assert.equal(fee(q(COMPACT, '2026-10-05 08:00', '2026-10-05 18:00')), 0));
  test('貸出 20:00 → +1,100', () => assert.equal(fee(q(COMPACT, '2026-10-05 20:00', '2026-10-06 10:00')), 1100));
  test('境界: 7:59 は夜間、19:59 は昼間', () => {
    assert.equal(fee(q(COMPACT, '2026-10-05 07:59', '2026-10-05 12:00')), 1100);
    assert.equal(fee(q(COMPACT, '2026-10-05 12:00', '2026-10-05 19:59')), 0);
  });
  test('UTC 表記の日時でも日本時間で判定 (12:00Z = 21:00 JST)', () => {
    const r = C.quote({ asset: COMPACT, start: '2026-10-05T12:00:00Z', end: '2026-10-06T03:00:00Z' });
    assert.equal(fee(r), 1100);
  });
});

describe('割引', () => {
  test('学生 24時間 コンパクト → 基本 7,700 から -1,100', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'student' });
    assert.equal(r.ok, true);
    assert.equal(r.base, 7700);
    assert.equal(r.discount, 1100);
    assert.equal(r.total, 6600);
    assert.deepEqual(line(r, 'discount').map(l => [l.label, l.amount]), [['学生割引', -1100]]);
  });
  test('学生 12時間 → DISCOUNT_NOT_APPLICABLE で割引なし', () => {
    const r = q(COMPACT, '2026-10-05 08:00', '2026-10-05 20:00', { discountType: 'student' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['DISCOUNT_NOT_APPLICABLE']);
    assert.equal(r.discount, 0);
    assert.equal(r.total, 7700 + 1100); // 返却 20:00 は夜間
  });
  test('守成クラブ + キッチンカー 24時間 → -3,000', () => {
    const r = q(KITCHEN, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'shusei_club' });
    assert.equal(r.ok, true);
    assert.equal(r.discount, 3000);
    assert.equal(r.total, 19000);
  });
  test('守成クラブ + コンパクト → 適用不可', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'shusei_club' });
    assert.deepEqual(r.errors, ['DISCOUNT_NOT_APPLICABLE']);
    assert.equal(r.discount, 0);
    assert.equal(r.total, 7700);
  });
  test('法人・二地域居住者も -1,100 / 未知の割引は適用不可', () => {
    assert.equal(q(SUV, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'corporate' }).total, 15900);
    assert.equal(q(SUV, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'dual_residence' }).total, 15900);
    assert.deepEqual(q(SUV, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'vip' }).errors, ['DISCOUNT_NOT_APPLICABLE']);
  });
  test('割引は基本料金を超えない', () => {
    const cheap = { id: 'X', categoryId: 'cat-rental', priceHour: 100, priceDay: 500 };
    const r = q(cheap, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'student', options: [CDW] });
    assert.equal(r.discount, 500);
    assert.equal(r.total, 1650);
  });
});

describe('クーポン', () => {
  test('クーポン 1,000 は合計から控除', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { coupon: { id: 'CP1', amount: 1000 } });
    assert.equal(r.couponDiscount, 1000);
    assert.equal(r.total, 6700);
    assert.deepEqual(line(r, 'coupon').map(l => l.amount), [-1000]);
  });
  test('合計 800 のとき 0 円 (マイナスにしない)', () => {
    const cheap = { id: 'X', categoryId: 'cat-rental', priceHour: 800, priceDay: 5000 };
    const r = q(cheap, '2026-10-05 10:00', '2026-10-05 11:00', { coupon: { id: 'CP1', amount: 1000 } });
    assert.equal(r.subtotal, 800);
    assert.equal(r.couponDiscount, 800);
    assert.equal(r.total, 0);
  });
  test('割引とクーポンの併用: 割引後の金額までしか引かない', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { discountType: 'student', coupon: { id: 'CP1', amount: 1000 } });
    assert.equal(r.total, 7700 - 1100 - 1000);
  });
});

describe('祝日', () => {
  const H2026 = ['01-01', '01-12', '02-11', '02-23', '03-20', '04-29', '05-03', '05-04', '05-05', '05-06',
    '07-20', '08-11', '09-21', '09-22', '09-23', '10-12', '11-03', '11-23'].map(d => '2026-' + d);
  const H2027 = ['01-01', '01-11', '02-11', '02-23', '03-21', '03-22', '04-29', '05-03', '05-04', '05-05',
    '07-19', '08-11', '09-20', '09-23', '10-11', '11-03', '11-23'].map(d => '2027-' + d);
  const allDays = y => {
    const out = [];
    for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  };

  test('2026 年の祝日がすべて true で、それ以外は false', () => {
    H2026.forEach(d => assert.equal(C.isJapaneseHoliday(d), true, d));
    assert.deepEqual(allDays(2026).filter(d => C.isJapaneseHoliday(d)), H2026);
  });
  test('2027 年の祝日がすべて true で、それ以外は false', () => {
    H2027.forEach(d => assert.equal(C.isJapaneseHoliday(d), true, d));
    assert.deepEqual(allDays(2027).filter(d => C.isJapaneseHoliday(d)), H2027);
  });
  test('平日は false', () => {
    ['2026-09-24', '2026-09-25', '2026-05-07', '2026-12-31', '2027-01-04', '2027-09-21', '2027-09-22'].forEach(d =>
      assert.equal(C.isJapaneseHoliday(d), false, d));
  });
  test('祝日名 (振替休日・国民の休日を含む)', () => {
    assert.equal(C.holidayName('2026-05-06'), '振替休日');
    assert.equal(C.holidayName('2026-09-22'), '国民の休日');
    assert.equal(C.holidayName('2026-09-23'), '秋分の日');
    assert.equal(C.holidayName('2027-03-22'), '振替休日');
    assert.equal(C.holidayName('2027-03-21'), '春分の日');
    assert.equal(C.holidayName('2026-09-24'), null);
  });
  test('extraHolidays (rules) も祝日扱い', () => {
    assert.equal(C.isJapaneseHoliday('2026-10-06', { extraHolidays: ['2026-10-06'] }), true);
    assert.equal(C.isJapaneseHoliday('2026-10-07', { extraHolidays: [{ date: '2026-10-07', name: '創立記念日' }] }), true);
    assert.equal(C.isJapaneseHoliday('2026-10-06'), false);
  });
});

describe('日時 (日本時間固定)', () => {
  test('jstParts は日本時間の各部を返す', () => {
    assert.deepEqual(C.jstParts('2026-09-24T15:30:00Z'), { y: 2026, m: 9, d: 25, hh: 0, mm: 30, dow: 5, ymd: '2026-09-25' });
    assert.deepEqual(C.jstParts(new Date(Date.UTC(2026, 11, 31, 14, 59))), { y: 2026, m: 12, d: 31, hh: 23, mm: 59, dow: 4, ymd: '2026-12-31' });
  });
  test('タイムゾーン表記の無い日時は日本時間として解釈', () => {
    assert.equal(C.jstParts('2026-09-24T10:00').hh, 10);
    assert.equal(C.jstParts('2026-09-24').ymd, '2026-09-24');
    assert.equal(C.jstParts('2026-09-24T10:00').ymd, '2026-09-24');
  });
  test('Postgres 形式 (空白区切り・+00) も読める / 不正な日時は null', () => {
    assert.equal(C.jstParts('2026-09-24 01:00:00+00').hh, 10);
    assert.equal(C.jstParts('2026-02-30T10:00:00+09:00'), null);
    assert.equal(C.jstParts('not a date'), null);
  });
  test('実行環境の TZ を変えても結果が同じ', () => {
    const cases = () => [
      q(COMPACT, '2026-10-02 21:00', '2026-10-03 07:00', { options: [CDW] }),
      C.quote({ asset: COMPACT, start: '2026-04-25T15:00:00Z', end: '2026-04-26T15:00:00Z' }),
      C.cancellationFee({ asset: COMPACT, start: '2026-10-20T01:00:00Z', cancelAt: '2026-10-18T15:01:00Z', base: 7700 }),
      C.jstParts('2026-12-31T15:00:00Z')
    ];
    const saved = process.env.TZ;
    const results = [];
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        results.push(JSON.stringify(cases()));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
    results.forEach(r => assert.equal(r, results[0]));
  });
  test('ローカル時刻の Date API・現在時刻・ロケール整形を使っていない', () => {
    const src = readFileSync(CORE_PATH, 'utf8');
    assert.doesNotMatch(src, /\.(getHours|getMinutes|getSeconds|getDate|getDay|getMonth|getFullYear|setHours|setDate|setMonth|setFullYear|getTimezoneOffset)\(/);
    assert.doesNotMatch(src, /Date\.now\(|new Date\(\s*\)|\.toLocale\w*\(/);
  });
});

describe('キャンセル料 (base = 24時間の基本料金)', () => {
  // 通常期の貸出日: 2026-10-20 (火) 10:00
  const PICK = '2026-10-20 10:00';
  const fee = (asset, cancelAt, base, extra) =>
    C.cancellationFee(Object.assign({ asset, category: { id: asset.categoryId }, start: jst(PICK), cancelAt: jst(cancelAt), base }, extra || {}));

  test('通常期 コンパクト 7,700: 3日前 0 / 前々日 2,310 / 前日 2,310 / 当日 3,850 / 無断 7,700', () => {
    assert.equal(fee(COMPACT, '2026-10-17 15:00', 7700).fee, 0);
    assert.equal(fee(COMPACT, '2026-10-18 15:00', 7700).fee, 2310);
    assert.equal(fee(COMPACT, '2026-10-19 15:00', 7700).fee, 2310);
    assert.equal(fee(COMPACT, '2026-10-20 08:00', 7700).fee, 3850);
    assert.equal(fee(COMPACT, '2026-10-20 12:00', 7700, { noShow: true }).fee, 7700);
  });
  test('ラベルと区分', () => {
    const f1 = fee(COMPACT, '2026-10-19 15:00', 7700);
    assert.deepEqual(f1, { cls: 'compact', busy: false, daysBefore: 1, pct: 30, fee: 2310, label: '前日 (30%)' });
    assert.equal(fee(COMPACT, '2026-10-18 15:00', 7700).label, '前々日 (30%)');
    assert.equal(fee(COMPACT, '2026-10-20 08:00', 7700).label, '当日 (50%)');
    assert.equal(fee(COMPACT, '2026-10-17 15:00', 7700).label, '3日前までは無料');
    assert.equal(fee(COMPACT, '2026-10-20 12:00', 7700, { noShow: true }).label, '無断キャンセル (100%)');
    assert.equal(fee(KITCHEN, '2026-10-07 10:00', 22000).label, '13日前 (50%)');
    assert.equal(fee(KEI, '2026-10-19 15:00', 7700).cls, 'compact');
    assert.equal(fee(MINIVAN, '2026-10-19 15:00', 17000).cls, 'large');
    assert.equal(C.cancellationFee({ asset: {}, start: jst(PICK), cancelAt: jst('2026-10-19 10:00'), base: 7700 }).cls, 'compact');
  });
  test('通常期 SUV 17,000: 前日 5,100 / 当日 8,500', () => {
    assert.equal(fee(SUV, '2026-10-19 15:00', 17000).cls, 'large');
    assert.equal(fee(SUV, '2026-10-19 15:00', 17000).fee, 5100);
    assert.equal(fee(SUV, '2026-10-20 09:00', 17000).fee, 8500);
  });
  test('通常期 キッチンカー 22,000: 14日前 0 / 13日前 11,000 / 3日前 11,000 / 前日 22,000', () => {
    assert.equal(fee(KITCHEN, '2026-10-06 10:00', 22000).cls, 'kitchen');
    assert.equal(fee(KITCHEN, '2026-10-06 10:00', 22000).fee, 0);
    assert.equal(fee(KITCHEN, '2026-10-07 10:00', 22000).fee, 11000);
    assert.equal(fee(KITCHEN, '2026-10-17 10:00', 22000).fee, 11000);
    assert.equal(fee(KITCHEN, '2026-10-19 10:00', 22000).fee, 22000);
  });
  test('繁忙期 (貸出日 2026-05-03): コンパクト 7日前 0 / 6日前 2,310 / 当日 3,850', () => {
    const b = (asset, cancelAt, base) => C.cancellationFee({ asset, category: { id: asset.categoryId }, start: jst('2026-05-03 10:00'), cancelAt: jst(cancelAt), base });
    assert.equal(b(COMPACT, '2026-04-26 10:00', 7700).busy, true);
    assert.equal(b(COMPACT, '2026-04-26 10:00', 7700).fee, 0);
    assert.equal(b(COMPACT, '2026-04-27 10:00', 7700).fee, 2310);
    assert.equal(b(COMPACT, '2026-05-03 08:00', 7700).fee, 3850);
  });
  test('繁忙期 キッチンカー: 13日前 4,400 / 6日前 6,600 / 前日 11,000 / 当日 22,000', () => {
    const b = (cancelAt) => C.cancellationFee({ asset: KITCHEN, category: { id: 'cat-kitchen' }, start: jst('2026-05-03 10:00'), cancelAt: jst(cancelAt), base: 22000 }).fee;
    assert.equal(b('2026-04-20 10:00'), 4400);
    assert.equal(b('2026-04-27 10:00'), 6600);
    assert.equal(b('2026-05-02 10:00'), 11000);
    assert.equal(b('2026-05-03 08:00'), 22000);
  });
  test('daysBefore は日本時間の暦日差 (取消 23:59 と翌 0:01 で1日違う)', () => {
    const d = cancelAt => C.cancellationFee({ asset: COMPACT, start: jst(PICK), cancelAt, base: 7700 });
    assert.equal(d('2026-10-18T23:59:00+09:00').daysBefore, 2);
    assert.equal(d('2026-10-19T00:01:00+09:00').daysBefore, 1);
    // 同じ瞬間を UTC で表記しても同じ (UTC ではどちらも 10-18)
    assert.equal(d('2026-10-18T14:59:00Z').daysBefore, 2);
    assert.equal(d('2026-10-18T15:01:00Z').daysBefore, 1);
    assert.equal(d('2026-10-18T15:01:00Z').fee, 2310);
  });
  test('category を省略しても asset.categoryId から区分を決める', () => {
    assert.equal(C.cancellationFee({ asset: KITCHEN, start: jst(PICK), cancelAt: jst('2026-10-19 10:00'), base: 22000 }).cls, 'kitchen');
  });
  test('日時が不正なら例外', () => {
    assert.throws(() => C.cancellationFee({ asset: COMPACT, start: 'x', cancelAt: jst(PICK), base: 7700 }), RangeError);
  });
});

describe('DEFAULT_RULES', () => {
  test('supabase/seed.sql の pricing_rules と同じ値', () => {
    const sql = readFileSync(SEED_PATH, 'utf8');
    const m = /\(\s*'pricing_rules'\s*,\s*'((?:[^']|'')*)'\s*\)/.exec(sql);
    assert.ok(m, 'seed.sql に pricing_rules が見つかりません');
    const seedRules = JSON.parse(m[1].replace(/''/g, "'"));
    assert.deepEqual(JSON.parse(JSON.stringify(C.DEFAULT_RULES)), seedRules);
  });
  test('rules を省略すると DEFAULT_RULES / 一部だけ渡すと残りは既定値', () => {
    const partial = { version: 'test', weekendHolidayFee: 500 };
    const r = q(COMPACT, '2026-09-26 10:00', '2026-09-26 16:00', { rules: partial });
    assert.equal(r.rulesVersion, 'test');
    assert.equal(line(r, 'weekend')[0].amount, 500);
    assert.equal(r.base, 6600);
  });
  test('DEFAULT_RULES は書き換えられない', () => {
    assert.ok(Object.isFrozen(C.DEFAULT_RULES));
    assert.ok(Object.isFrozen(C.DEFAULT_RULES.cancellation.normal.compact[0]));
  });
});

describe('ファイル構成', () => {
  test('js/pricing-core.js と supabase/functions/_shared/pricing-core.js がバイト一致', () => {
    assert.ok(readFileSync(CORE_PATH).equals(readFileSync(SHARED_PATH)),
      '一致していません。node scripts/sync-shared.mjs を実行してください');
  });
  test('import / export 文を含まない (classic script として読める)', () => {
    const src = readFileSync(CORE_PATH, 'utf8');
    assert.doesNotMatch(src, /^\s*(import|export)\s/m);
    const ctx = vm.createContext({});
    vm.runInContext(src, ctx, { filename: 'pricing-core.js' });
    assert.equal(vm.runInContext('typeof SkyRentPricingCore.quote', ctx), 'function');
  });
  test('Deno の副作用 import で SkyRentPricingCore が設定される', (t) => {
    const probe = spawnSync('deno', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('deno が見つからないため省略'); return; }
    const code = "await import('" + pathToFileURL(SHARED_PATH).href + "'); console.log(typeof globalThis.SkyRentPricingCore.quote)";
    const r = spawnSync('deno', ['eval', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'function');
  });
});

describe('js/pricing.js (既存画面向けアダプタ)', () => {
  // ブラウザと同じく classic script として window 上に読み込む
  function loadAdapter(storedRules) {
    const storeAssets = [
      { assetId: 'V001', categoryId: 'cat-rental', name: '日産 ノート', priceHour: 1100, priceDay: 7700, customFields: { bodyType: 'コンパクト' } },
      { assetId: 'K001', categoryId: 'cat-kitchen', name: 'キッチンカー', priceHour: null, priceDay: 22000, customFields: {} }
    ];
    const storeOptions = [
      { optionId: 'OP101', name: '免責補償制度 (CDW)', price: 1650, priceShort: 1100, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover', active: true },
      { optionId: 'OP102', name: '安心保証コース (PAP)', price: 3300, priceShort: 2200, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover', active: true }
    ];
    const ctx = vm.createContext({ console });
    vm.runInContext('var window = globalThis;', ctx);
    ctx.SkyRentStore = {
      read: (key, fallback) => key === 'settings.pricing_rules' && storedRules !== undefined ? JSON.parse(JSON.stringify(storedRules)) : fallback,
      list: key => (key === 'options' ? storeOptions : []),
      getAsset: id => storeAssets.find(a => a.assetId === id) || null,
      getCategory: id => ({ categoryId: id })
    };
    vm.runInContext(readFileSync(CORE_PATH, 'utf8'), ctx, { filename: 'pricing-core.js' });
    vm.runInContext(readFileSync(ADAPTER_PATH, 'utf8'), ctx, { filename: 'pricing.js' });
    return { P: ctx.SkyRentPricing, asset: storeAssets[0], kitchen: storeAssets[1], options: storeOptions };
  }
  const plain = v => JSON.parse(JSON.stringify(v));

  test('旧API calculate() が旧形式 (lines[].label/amount, days, total …) で返す', () => {
    const { P, asset, options } = loadAdapter(null);
    const c = P.calculate({ asset, start: jst('2026-10-05 10:00'), end: jst('2026-10-06 12:00'), quantity: 1, options: [options[0]], coupon: { amount: 1000 } });
    assert.ok(Array.isArray(c.lines) && c.lines.length > 0);
    c.lines.forEach(l => {
      assert.equal(typeof l.label, 'string');
      assert.equal(typeof l.amount, 'number');
    });
    assert.equal(c.days, 2);
    assert.equal(c.hours, 26);
    assert.equal(c.plan, 'daily');
    assert.equal(c.subtotal, 9900 + 2750);
    assert.equal(c.discount, 1000);
    assert.equal(c.total, 9900 + 2750 - 1000);
    assert.equal(c.total, c.subtotal - c.discount);
    assert.equal(c.lines.reduce((s, l) => s + l.amount, 0), c.total);
    assert.deepEqual(plain(c.lines.map(l => [l.label, l.amount])), [
      ['基本料金 (24時間 × 1)', 7700],
      ['延長料金 (2時間)', 2200],
      ['免責補償制度 (CDW) (24時間 × 1 + 2時間・短時間料金)', 2750],
      ['クーポン割引', -1000]
    ]);
    assert.equal(c.ok, true);
    assert.equal(c.quote.base, 9900);
  });
  test('割引の種類も渡せて、discount = 割引 + クーポン', () => {
    const { P, asset } = loadAdapter(null);
    const c = P.calculate({ asset, start: jst('2026-10-05 10:00'), end: jst('2026-10-06 10:00'), discountType: 'student', coupon: { couponId: 'C1', amount: 500 } });
    assert.equal(c.discount, 1600);
    assert.equal(c.total, 6100);
  });
  test('エラーは errors に入る (CDW と PAP)', () => {
    const { P, asset, options } = loadAdapter(null);
    const c = P.calculate({ asset, start: jst('2026-10-05 10:00'), end: jst('2026-10-06 10:00'), options });
    assert.equal(c.ok, false);
    assert.deepEqual(plain(c.errors), ['OPTION_CONFLICT']);
  });
  test('料金ルールは store の settings.pricing_rules を使い、無ければ DEFAULT_RULES', () => {
    const custom = Object.assign(plain(C.DEFAULT_RULES), { version: 'store', weekendHolidayFee: 500 });
    const a = loadAdapter(custom);
    const c1 = a.P.calculate({ asset: a.asset, start: jst('2026-09-26 10:00'), end: jst('2026-09-26 16:00') });
    assert.equal(c1.total, 6600 + 500);
    assert.equal(a.P.rules().version, 'store');

    const b = loadAdapter(null);
    const c2 = b.P.calculate({ asset: b.asset, start: jst('2026-09-26 10:00'), end: jst('2026-09-26 16:00') });
    assert.equal(c2.total, 6600 + 330);
    const r = b.P.rules();
    assert.deepEqual(plain(r), plain(C.DEFAULT_RULES));
    r.busyFee = 1; // 複製なので書き換えても既定値は変わらない
    assert.equal(b.P.rules().busyFee, 550);
  });
  test('quote() は assetId / optionIds から store を引いて計算できる', () => {
    const { P } = loadAdapter(null);
    const r = P.quote({ assetId: 'V001', start: jst('2026-10-05 10:00'), end: jst('2026-10-05 13:00'), optionIds: ['OP101'] });
    assert.equal(r.total, 3300 + 1100);
  });
  test('cancellationFee() は予約データから base と区分を補う', () => {
    const { P } = loadAdapter(null);
    const r1 = P.cancellationFee({
      reservation: { assetId: 'V001', categoryId: 'cat-rental', start: jst('2026-10-20 10:00'), end: jst('2026-10-21 10:00'), price: {} },
      cancelAt: jst('2026-10-19 12:00')
    });
    assert.equal(r1.fee, 2310);
    assert.equal(r1.label, '前日 (30%)');
    // 料金内訳のスナップショットに base があればそれを使う
    const r2 = P.cancellationFee({
      reservation: { assetId: 'K001', start: jst('2026-10-20 10:00'), end: jst('2026-10-22 10:00'), price: { base: 44000 } },
      cancelAt: jst('2026-10-19 12:00')
    });
    assert.equal(r2.cls, 'kitchen');
    assert.equal(r2.fee, 44000);
  });
  test('yen() はロケールに依存しない', () => {
    const { P } = loadAdapter(null);
    assert.equal(P.yen(1100), '¥1,100');
    assert.equal(P.yen(-22000), '-¥22,000');
    assert.equal(P.yen(0), '¥0');
  });
});
