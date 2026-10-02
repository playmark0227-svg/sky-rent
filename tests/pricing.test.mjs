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
// 区分の決まっていないボディタイプ (料金ルールの classOf に無いもの) はコンパクトの段階
const OTHER_BODY = { id: 'V099', categoryId: 'cat-rental', priceHour: 1100, priceDay: 7700, customFields: { bodyType: 'その他' } };
const KITCHEN = { id: 'K001', categoryId: 'cat-kitchen', priceHour: null, priceDay: 22000, customFields: {} };
const CDW = { id: 'OP101', name: '免責補償制度 (CDW)', price: 1650, priceShort: 1100, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover' };
const PAP = { id: 'OP102', name: '安心保証コース (PAP)', price: 3300, priceShort: 2200, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover' };
const KCDW = { id: 'OP201', name: '免責補償制度 (CDW)', price: 3300, priceShort: null, priceType: 'per_day', categoryIds: ['cat-kitchen'], exclusiveGroup: 'cover' };
// 装備オプション (全車共通・24時間ごと・短時間料金なし)。家電セットは OP001〜OP009 を含む
const equip = (id, name, price, extra) => Object.assign({ id, name, price, priceShort: null, priceType: 'per_day', categoryIds: null, exclusiveGroup: null }, extra || {});
const APPLIANCES = [
  equip('OP001', 'ポータブル冷蔵冷凍庫', 3300), equip('OP002', '電子レンジ', 2200), equip('OP003', 'サーキュレーター', 1100),
  equip('OP004', 'ポータブル電源', 3300), equip('OP005', 'ドラムリール', 1100), equip('OP006', 'カセットコンロ', 1100),
  equip('OP007', 'カセットボンベ', 1100), equip('OP008', '炊飯器', 2200), equip('OP009', '電気ケトル', 1100)
];
const [FRIDGE, MICROWAVE] = APPLIANCES;
const APPLIANCE_SET = equip('OP010', '家電セット (上記9点まとめ)', 11000, { includes: APPLIANCES.map(o => o.id) });
const PROMO_SET = equip('OP011', '集客セット', 1100);
// 家電レンタル (家電だけのレンタル) の受け取り窓口。基本料金 0・時間料金なし
const ITEM = { id: 'A001', categoryId: 'cat-appliance', categoryType: 'item', priceHour: null, priceDay: 0, customFields: {} };
const RICE = APPLIANCES[7]; // 炊飯器 2,200

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
    assert.equal(r.rulesVersion, '2026-10');
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

describe('オプション (装備・家電セット)', () => {
  const opt = (r, id) => r.lines.find(l => l.code === 'option' && l.optionId === id);
  test('装備 3時間 → 24時間料金 (短時間料金は無い): 冷蔵冷凍庫 3,300', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-05 13:00', { options: [FRIDGE] });
    assert.equal(r.ok, true);
    assert.deepEqual([opt(r, 'OP001').label, opt(r, 'OP001').amount], ['ポータブル冷蔵冷凍庫 (24時間まで)', 3300]);
    assert.equal(r.total, 3300 + 3300);
  });
  test('装備 24時間 = ×1 / 25時間 = ×2 / 48時間 = ×2 / 49時間 = ×3 (端数が6時間以内でも24時間料金)', () => {
    const amount = (s, e) => opt(q(COMPACT, s, e, { options: [MICROWAVE] }), 'OP002').amount;
    assert.equal(amount('2026-10-05 10:00', '2026-10-06 10:00'), 2200);
    assert.equal(amount('2026-10-05 10:00', '2026-10-06 11:00'), 4400);
    assert.equal(amount('2026-10-05 10:00', '2026-10-07 10:00'), 4400);
    assert.equal(amount('2026-10-05 10:00', '2026-10-07 11:00'), 6600);
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 11:00', { options: [MICROWAVE] });
    assert.equal(opt(r, 'OP002').label, '電子レンジ (24時間 × 1 + 1時間)');
  });
  test('家電セット 25時間 = 11,000 × 2 = 22,000', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 11:00', { options: [APPLIANCE_SET] });
    assert.equal(r.ok, true);
    assert.equal(opt(r, 'OP010').amount, 22000);
    assert.equal(r.total, 7700 + 1100 + 22000);
  });
  test('全車共通: キッチンカーにも付けられる (時間貸しなしの車両でも24時間ごと)', () => {
    const r = q(KITCHEN, '2026-10-05 10:00', '2026-10-05 15:00', { options: [APPLIANCE_SET, PROMO_SET] });
    assert.equal(r.ok, true);
    assert.equal(opt(r, 'OP010').amount, 11000);
    assert.equal(opt(r, 'OP011').amount, 1100);
    assert.equal(r.total, 22000 + 11000 + 1100);
  });
  test('割引 (学生・法人・二地域居住・守成クラブ) は基本料金だけ。装備の料金は変わらない', () => {
    for (const type of ['student', 'corporate', 'dual_residence']) {
      const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET], discountType: type });
      assert.equal(r.ok, true, type);
      assert.equal(r.discount, 1100, type);
      assert.equal(opt(r, 'OP010').amount, 11000, type);
      assert.equal(r.total, 7700 + 11000 - 1100, type);
    }
    const k = q(KITCHEN, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET], discountType: 'shusei_club' });
    assert.equal(k.discount, 3000);
    assert.equal(k.total, 22000 + 11000 - 3000);
    // 割引額が基本料金を超えても、装備の料金までは引かない (上限は基本料金)
    const rules = Object.assign({}, C.DEFAULT_RULES, { discounts: { big: { label: '大きな割引', amount: 50000, minHours: 24 } } });
    const big = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET], discountType: 'big', rules });
    assert.equal(big.discount, 7700);
    assert.equal(big.total, 11000);
  });
  test('家電セット + セットに含まれる品目 → OPTION_CONFLICT (9品目すべて・選ぶ順番が逆でも)', () => {
    for (const item of APPLIANCES) {
      for (const options of [[APPLIANCE_SET, item], [item, APPLIANCE_SET]]) {
        const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options });
        assert.equal(r.ok, false, options.map(o => o.id).join('+'));
        assert.deepEqual(r.errors, ['OPTION_CONFLICT'], options.map(o => o.id).join('+'));
      }
    }
    // 複数の品目が重なってもエラーは1つ
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [FRIDGE, MICROWAVE, APPLIANCE_SET] });
    assert.deepEqual(r.errors, ['OPTION_CONFLICT']);
  });
  test('家電セット単独・家電セット + 集客セット・家電セット + CDW は選べる', () => {
    const one = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET] });
    assert.equal(one.ok, true);
    assert.equal(one.total, 7700 + 11000);
    const promo = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET, PROMO_SET] });
    assert.equal(promo.ok, true);
    assert.equal(promo.total, 7700 + 11000 + 1100);
    const cover = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [CDW, APPLIANCE_SET] });
    assert.equal(cover.ok, true);
    assert.equal(cover.total, 7700 + 1650 + 11000);
    // 家電セットに含まれない品目どうし (個別に全部) も選べる
    const each = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: APPLIANCES.concat([PROMO_SET]) });
    assert.equal(each.ok, true);
    assert.equal(each.total, 7700 + 16500 + 1100);
  });
  test('補償2つは従来どおり OPTION_CONFLICT (装備を一緒に選んでも)', () => {
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET, CDW, PAP] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['OPTION_CONFLICT']);
  });
  test('includes が配列でなければ無視・自分自身を含めても衝突にしない・DB 行 (snake_case) でも判定する', () => {
    const broken = Object.assign({}, APPLIANCE_SET, { includes: 'OP001' });
    assert.equal(q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [broken, FRIDGE] }).ok, true);
    const self = Object.assign({}, APPLIANCE_SET, { includes: ['OP010'] });
    assert.equal(q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [self] }).ok, true);
    const row = { id: 'OP010', name: '家電セット', price: 11000, price_short: null, price_type: 'per_day', category_ids: null, exclusive_group: null, includes: ['OP002'] };
    const r = q(COMPACT, '2026-10-05 10:00', '2026-10-06 10:00', { options: [{ id: 'OP002', name: '電子レンジ', price: 2200, price_type: 'per_day' }, row] });
    assert.deepEqual(r.errors, ['OPTION_CONFLICT']);
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
    assert.equal(fee(OTHER_BODY, '2026-10-19 15:00', 7700).cls, 'compact');
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

describe('家電レンタル (家電だけのレンタル・categoryType = item)', () => {
  const opt = (r, id) => r.lines.find(l => l.code === 'option' && l.optionId === id);
  test('電子レンジ + 炊飯器 48時間 = 4,400 + 4,400 = 8,800 (基本料金 0・行は家電だけ)', () => {
    const r = q(ITEM, '2026-10-05 10:00', '2026-10-07 10:00', { options: [MICROWAVE, RICE] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.hours, 48);
    assert.equal(r.days, 2);
    assert.equal(r.plan, 'daily');
    assert.equal(r.base, 0);
    assert.equal(r.subtotal, 8800);
    assert.equal(r.total, 8800);
    assert.deepEqual(r.lines.map(l => [l.code, l.label, l.amount]), [
      ['option', '電子レンジ (24時間 × 2)', 4400],
      ['option', '炊飯器 (24時間 × 2)', 4400]
    ]);
    assert.equal(sumLines(r), r.total);
    assert.equal(r.rulesVersion, '2026-10');
  });
  test('3時間でも24時間分 (電子レンジ 2,200) / 25時間は ×2', () => {
    const r3 = q(ITEM, '2026-10-05 10:00', '2026-10-05 13:00', { options: [MICROWAVE] });
    assert.equal(r3.ok, true);
    assert.equal(r3.hours, 3);
    assert.deepEqual([opt(r3, 'OP002').label, opt(r3, 'OP002').amount], ['電子レンジ (24時間まで)', 2200]);
    assert.equal(r3.total, 2200);
    assert.equal(q(ITEM, '2026-10-05 10:00', '2026-10-06 11:00', { options: [MICROWAVE] }).total, 4400);
  });
  test('家電を1つも選ばなければ ITEM_REQUIRED (料金 0)', () => {
    for (const options of [undefined, [], [null]]) {
      const r = q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options });
      assert.equal(r.ok, false);
      assert.deepEqual(r.errors, ['ITEM_REQUIRED']);
      assert.equal(r.total, 0);
      assert.deepEqual(r.lines, []);
    }
  });
  test('料金が 0・時間料金なしでも INVALID_ASSET にしない (車両は従来どおり INVALID_ASSET)', () => {
    assert.equal(q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options: [MICROWAVE] }).ok, true);
    const noPrice = Object.assign({}, ITEM, { priceDay: null });
    assert.equal(q(noPrice, '2026-10-05 10:00', '2026-10-06 10:00', { options: [MICROWAVE] }).total, 2200);
    const vehicle = Object.assign({}, ITEM, { categoryType: 'vehicle', categoryId: 'cat-rental' });
    assert.deepEqual(q(vehicle, '2026-10-05 10:00', '2026-10-06 10:00', { options: [MICROWAVE] }).errors, ['INVALID_ASSET']);
  });
  test('土日祝・夜間・繁忙期の割増はかけない (繁忙期かどうか busy は返す)', () => {
    const cases = [
      ['2026-10-03 21:00', '2026-10-04 07:00'], // 土曜 夜間の受け取り・日曜 夜間の返却
      ['2026-09-22 10:00', '2026-09-22 16:00'], // 国民の休日
      ['2026-05-02 10:00', '2026-05-03 10:00'], // ゴールデンウィーク
      ['2026-12-31 21:00', '2027-01-02 07:00']  // 年末年始・夜間
    ];
    for (const [s, e] of cases) {
      const r = q(ITEM, s, e, { options: [MICROWAVE] });
      assert.equal(r.ok, true, s);
      assert.deepEqual(r.lines.map(l => l.code), ['option'], s);
      assert.equal(r.total, opt(r, 'OP002').amount, s);
    }
    assert.equal(q(ITEM, '2026-05-02 10:00', '2026-05-03 10:00', { options: [MICROWAVE] }).busy, true);
    assert.equal(q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options: [MICROWAVE] }).busy, false);
  });
  test('rules.itemSurcharges = true のときだけ割増をかける', () => {
    const rules = Object.assign({}, C.DEFAULT_RULES, { itemSurcharges: true });
    const r = q(ITEM, '2026-10-03 21:00', '2026-10-04 07:00', { options: [MICROWAVE], rules });
    assert.equal(line(r, 'weekend')[0].amount, 330);
    assert.deepEqual(line(r, 'night').map(l => [l.label, l.amount]), [['夜間料金 (お受け取り・ご返却 2回)', 2200]]);
    assert.equal(r.total, 2200 + 330 + 2200);
    const busy = q(ITEM, '2026-05-02 10:00', '2026-05-03 10:00', { options: [MICROWAVE], rules });
    assert.equal(line(busy, 'busy')[0].amount, 550);
  });
  test('割引 (学生・法人・二地域居住・守成クラブ) は使えない → DISCOUNT_NOT_APPLICABLE (料金は変わらない)', () => {
    for (const type of ['student', 'corporate', 'dual_residence', 'shusei_club']) {
      const r = q(ITEM, '2026-10-05 10:00', '2026-10-07 10:00', { options: [MICROWAVE, RICE], discountType: type });
      assert.equal(r.ok, false, type);
      assert.deepEqual(r.errors, ['DISCOUNT_NOT_APPLICABLE'], type);
      assert.equal(r.discount, 0, type);
      assert.equal(r.total, 8800, type);
      assert.equal(line(r, 'discount').length, 0, type);
    }
    // カテゴリの条件が無い割引でも同じ
    const rules = Object.assign({}, C.DEFAULT_RULES, { discounts: { any: { label: '誰でも割引', amount: 500, minHours: 0 } } });
    assert.deepEqual(q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options: [MICROWAVE], discountType: 'any', rules }).errors, ['DISCOUNT_NOT_APPLICABLE']);
  });
  test('クーポン (¥1,000) は車両と同じく使える (0円未満にしない)', () => {
    const r = q(ITEM, '2026-10-05 10:00', '2026-10-07 10:00', { options: [MICROWAVE, RICE], coupon: { id: 'CP1', amount: 1000 } });
    assert.equal(r.ok, true);
    assert.equal(r.couponDiscount, 1000);
    assert.equal(r.total, 7800);
    const small = q(ITEM, '2026-10-05 10:00', '2026-10-05 12:00', { options: [APPLIANCES[2]], coupon: { id: 'CP1', amount: 1000 } });
    assert.equal(small.subtotal, 1100);
    assert.equal(small.total, 100);
    const zero = q(ITEM, '2026-10-05 10:00', '2026-10-05 12:00', { options: [APPLIANCES[2]], coupon: { id: 'CP1', amount: 5000 } });
    assert.equal(zero.total, 0);
  });
  test('家電セットは借りられる・セット + 中の品目は OPTION_CONFLICT・補償 (車両専用) は OPTION_NOT_APPLICABLE', () => {
    const set = q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET, PROMO_SET] });
    assert.equal(set.ok, true);
    assert.equal(set.total, 11000 + 1100);
    assert.deepEqual(q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options: [APPLIANCE_SET, MICROWAVE] }).errors, ['OPTION_CONFLICT']);
    const cover = q(ITEM, '2026-10-05 10:00', '2026-10-06 10:00', { options: [CDW, MICROWAVE] });
    assert.ok(cover.errors.includes('OPTION_NOT_APPLICABLE'));
  });
  test('DB 行 (snake_case の category_type) でも家電レンタルとして計算する / 省略すると車両 (従来どおり)', () => {
    const row = { id: 'A001', category_id: 'cat-appliance', category_type: 'item', price_hour: null, price_day: 0, custom_fields: {} };
    assert.equal(q(row, '2026-10-05 10:00', '2026-10-07 10:00', { options: [MICROWAVE, RICE] }).total, 8800);
    // categoryType 無し・'vehicle' の車両は今までと同じ計算
    const explicit = Object.assign({}, COMPACT, { categoryType: 'vehicle' });
    for (const asset of [COMPACT, explicit]) {
      const r = q(asset, '2026-10-03 21:00', '2026-10-04 07:00', { options: [CDW], discountType: 'student' });
      assert.deepEqual(r.errors, ['DISCOUNT_NOT_APPLICABLE']); // 10時間なので学生割引の条件外
      assert.equal(r.base, 7700);
      assert.equal(line(r, 'weekend')[0].amount, 330);
      assert.equal(line(r, 'night')[0].label, '夜間料金 (貸出・返却 2回)');
    }
  });
});

describe('キャンセル料 (家電レンタル)', () => {
  // 通常期のお受け取り日: 2026-10-20 (火) 10:00。電子レンジ + 炊飯器 48時間 = 8,800
  const r = q(ITEM, '2026-10-20 10:00', '2026-10-22 10:00', { options: [MICROWAVE, RICE] });
  const base = C.cancellationBase({ price: r, total: r.total, categoryType: 'item' });
  const fee = (start, cancelAt, extra) =>
    C.cancellationFee(Object.assign({ asset: ITEM, category: { id: 'cat-appliance' }, start: jst(start), cancelAt: jst(cancelAt), base }, extra || {}));

  test('元になる利用料金は家電 (オプション) の料金の合計 = 8,800', () => assert.equal(base, 8800));
  test('通常期: 3日前 0 / 前々日 2,640 / 前日 2,640 / 当日 4,400 / 無断 8,800 (コンパクトカーと同じ割合)', () => {
    assert.equal(fee('2026-10-20 10:00', '2026-10-17 15:00').fee, 0);
    assert.equal(fee('2026-10-20 10:00', '2026-10-18 15:00').fee, 2640);
    assert.equal(fee('2026-10-20 10:00', '2026-10-19 15:00').fee, 2640);
    assert.equal(fee('2026-10-20 10:00', '2026-10-20 08:00').fee, 4400);
    assert.equal(fee('2026-10-20 10:00', '2026-10-20 12:00', { noShow: true }).fee, 8800);
    assert.deepEqual(fee('2026-10-20 10:00', '2026-10-19 15:00'),
      { cls: 'item', busy: false, daysBefore: 1, pct: 30, fee: 2640, label: '前日 (30%)' });
    assert.equal(fee('2026-10-20 10:00', '2026-10-17 15:00').label, '3日前までは無料');
  });
  test('繁忙期 (お受け取り日 2026-05-03): 7日前 0 / 6日前 30% / 当日 50%', () => {
    assert.equal(fee('2026-05-03 10:00', '2026-04-26 10:00').busy, true);
    assert.equal(fee('2026-05-03 10:00', '2026-04-26 10:00').fee, 0);
    assert.equal(fee('2026-05-03 10:00', '2026-04-27 10:00').fee, 2640);
    assert.equal(fee('2026-05-03 10:00', '2026-05-03 08:00').fee, 4400);
  });
  test('item の段階が無い古い料金ルールでは、コンパクトカーの段階 (同じ割合) で計算する', () => {
    const old = JSON.parse(JSON.stringify(C.DEFAULT_RULES));
    delete old.cancellation.categoryClass['cat-appliance'];
    delete old.cancellation.normal.item;
    delete old.cancellation.busy.item;
    const f = fee('2026-10-20 10:00', '2026-10-19 15:00', { rules: old });
    assert.equal(f.cls, 'compact');
    assert.equal(f.fee, 2640);
  });
  test('cancellationBase: 車両は基本料金 (延長料金を含む)・家電レンタルは家電の合計・内訳が無ければ合計', () => {
    const v = q(COMPACT, '2026-10-05 10:00', '2026-10-06 12:00', { options: [CDW, APPLIANCE_SET] });
    assert.equal(C.cancellationBase({ price: v, total: v.total }), 9900);
    assert.equal(C.cancellationBase({ price: v, total: v.total, categoryType: 'vehicle' }), 9900);
    // 予約の行 (snake_case) のまま・クーポンは差し引かない (家電の料金の合計)
    const withCoupon = q(ITEM, '2026-10-05 10:00', '2026-10-07 10:00', { options: [MICROWAVE, RICE], coupon: { amount: 1000 } });
    assert.equal(C.cancellationBase({ price: withCoupon, total: withCoupon.total, is_item: true }), 8800);
    assert.equal(C.cancellationBase({ price: { breakdown: withCoupon.lines }, total: withCoupon.total, isItem: true }), 8800);
    assert.equal(C.cancellationBase({ price: {}, total: 5000, isItem: true }), 5000);
    assert.equal(C.cancellationBase({ price: {}, total: 5000 }), 5000);
    assert.equal(C.cancellationBase({ price: null, total: null }), 0);
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
      { optionId: 'OP102', name: '安心保証コース (PAP)', price: 3300, priceShort: 2200, priceType: 'per_day', categoryIds: ['cat-rental'], exclusiveGroup: 'cover', active: true },
      // 装備 (store の形。includes は DB の extra.includes が展開されたもの)
      { optionId: 'OP002', name: '電子レンジ', price: 2200, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true },
      { optionId: 'OP010', name: '家電セット (上記9点まとめ)', price: 11000, priceShort: null, priceType: 'per_day', categoryIds: null, kind: 'other', exclusiveGroup: null, active: true,
        includes: ['OP001', 'OP002', 'OP003', 'OP004', 'OP005', 'OP006', 'OP007', 'OP008', 'OP009'] }
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
    return { P: ctx.SkyRentPricing, asset: storeAssets[0], kitchen: storeAssets[1], options: storeOptions.slice(0, 2), equipment: storeOptions.slice(2) };
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
  test('store のオプション (includes 付き) のままで、家電セットと中の品目の同時選択を OPTION_CONFLICT にする', () => {
    const { P, asset, equipment } = loadAdapter(null);
    const period = { start: jst('2026-10-05 10:00'), end: jst('2026-10-06 10:00') };
    const c = P.calculate(Object.assign({ asset, options: equipment }, period));
    assert.equal(c.ok, false);
    assert.deepEqual(plain(c.errors), ['OPTION_CONFLICT']);
    const r = P.quote(Object.assign({ assetId: 'V001', optionIds: ['OP010', 'OP101'] }, period));
    assert.equal(r.ok, true);
    assert.equal(r.total, 7700 + 11000 + 1650);
    assert.deepEqual(plain(P.quote(Object.assign({ assetId: 'V001', optionIds: ['OP002', 'OP010'] }, period)).errors), ['OPTION_CONFLICT']);
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
