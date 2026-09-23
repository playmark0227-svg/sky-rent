// =====================================================================
// メールのテンプレート (件名・本文テキスト)
//   renderMail(template, ctx) は純関数。ctx (予約・車両・拠点・設定など) は worker-core が DB から読む。
//   件名は必ず【グロースレンタカー】で始める。お客様向けは丁寧語。
//   個人情報は必要最小限 (店舗宛ては氏名まで。連絡先は管理画面で確認してもらう)。
// =====================================================================
import { Core } from './catalog.ts';
import { oneLine } from './mail.ts';

export const TEMPLATES = [
  'reservation_confirmed',
  'reservation_new_shop',
  'reservation_cancelled',
  'reservation_cancelled_shop',
  'inquiry_received',
  'inquiry_new_shop',
  'coupon_issued'
] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/**
 * お問い合わせの種類 (contact.html の選択肢と同じ)。サーバーはこの一覧にあるものだけを受け付ける。
 *   自由な文字列を受け付けると、自動返信 (攻撃者が指定した宛先に店舗のドメインから届く) に
 *   任意の文面・URL を載せられてしまうため。
 */
export const INQUIRY_TOPICS: readonly string[] = [
  'ご予約について',
  'ご予約の変更・キャンセル',
  '料金・お見積りについて',
  '法人利用・請求書払いについて',
  'キッチンカーのレンタルについて',
  '忘れ物について',
  'その他'
];

/** 一覧にない種類 (この対策より前に保存されたもの) は「その他」として出す */
export function safeTopic(topic: unknown): string {
  const t = typeof topic === 'string' ? topic.trim() : '';
  return INQUIRY_TOPICS.includes(t) ? t : 'その他';
}

export type SiteInfo = { shopName: string; company: string; line: string; email: string; hours: string };

export const DEFAULT_SITE: SiteInfo = {
  shopName: 'グロースレンタカー',
  company: '株式会社Skyward Growth',
  line: 'https://lin.ee/PuLt0Ig',
  email: 'daichi.fujimoto@skyward-growth.com',
  hours: '9:00〜19:00 (年中無休)'
};

export type ReservationCtx = {
  id: string;
  kind: string;
  status: string;
  start_at: string;
  end_at: string;
  category_id: string;
  customer_name: string;
  user_id: string | null;
  payment_method: string;
  options: Array<{ optionId?: string; name?: string }>;
  price: any;
  total: number;
  discount_type: string | null;
  /** 会社名 (法人割引の確認用。メール本文には出さず、未記入かどうかだけ使う) */
  company?: string | null;
  note: string;
  cancel_fee: number | null;
  cancelled_by: string | null;
  source?: string;
};

export type MailContext = {
  siteUrl: string;
  site: SiteInfo;
  rules: any;
  payload: Record<string, any>;
  reservation?: ReservationCtx | null;
  asset?: { id: string; name: string; category_id: string; custom_fields: Record<string, unknown> } | null;
  location?: { id: string; name: string; address: string; tel: string; hours: string } | null;
  /** 照会URL (送信用は本物、DB 保存用は伏せ字) */
  lookupUrl?: string | null;
  inquiry?: {
    id: string; name: string; topic: string; body: string; company: string;
    reservation_id: string | null; created_at: string; user_id: string | null;
  } | null;
  coupon?: { amount: number; reason: string; expires_at: string | null } | null;
};

export class TemplateError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'TemplateError';
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------
// 書式
// ---------------------------------------------------------------------
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function comma(n: number): string {
  return String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
export function yen(n: number): string {
  const v = Number(n) || 0;
  return (v < 0 ? '-¥' : '¥') + comma(v);
}
function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}
/** 2026年10月1日(木) 10:00 (日本時間) */
export function fmtDateTime(iso: string): string {
  const p = Core.jstParts(iso);
  if (!p) return '';
  return p.y + '年' + p.m + '月' + p.d + '日(' + DOW[p.dow] + ') ' + pad2(p.hh) + ':' + pad2(p.mm);
}
/** 10/1(木) */
export function fmtShortDate(iso: string): string {
  const p = Core.jstParts(iso);
  if (!p) return '';
  return p.m + '/' + p.d + '(' + DOW[p.dow] + ')';
}
function fmtDate(iso: string): string {
  const p = Core.jstParts(iso);
  if (!p) return '';
  return p.y + '年' + p.m + '月' + p.d + '日(' + DOW[p.dow] + ')';
}
/** 氏名など (改行・制御文字を除き、長すぎる値は切る) */
function nm(s: unknown, max = 50): string {
  return oneLine(String(s ?? ''), max);
}
/** 本文に入れる複数行テキスト (制御文字を除く・長さ制限) */
function para(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return t.length > max ? t.slice(0, max) + '…(以下省略)' : t;
}

function lines(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== false).join('\n');
}

const RULE = '――――――――――――――――――――';

function signature(ctx: MailContext): string {
  const s = ctx.site;
  return lines(
    RULE,
    s.shopName + (s.company ? ' (' + s.company + ')' : ''),
    ctx.siteUrl,
    '公式LINE: ' + s.line,
    'メール: ' + s.email,
    '受付時間: ' + s.hours,
    RULE
  );
}

function subject(s: string): string {
  return '【グロースレンタカー】' + oneLine(s, 200);
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new TemplateError(what + 'が見つからないため、メールを作れませんでした');
  return v;
}

// ---------------------------------------------------------------------
// 予約の共通ブロック
// ---------------------------------------------------------------------
function assetName(ctx: MailContext): string {
  return ctx.asset ? ctx.asset.name : '(車両情報なし)';
}

function locationBlock(ctx: MailContext, withDetail: boolean): string {
  const l = ctx.location;
  if (!l) return '店舗　　: (店舗情報なし)';
  const out = ['店舗　　: ' + l.name + (l.address ? ' (' + l.address + ')' : '')];
  if (withDetail) {
    const extra = [l.tel ? '電話 ' + l.tel : '', l.hours ? '営業時間 ' + l.hours : ''].filter(Boolean).join(' / ');
    if (extra) out.push('　　　　  ' + extra);
  }
  return out.join('\n');
}

function reservationBlock(ctx: MailContext, r: ReservationCtx, withDetail: boolean): string {
  const opts = (Array.isArray(r.options) ? r.options : []).map((o) => nm(o && o.name, 60)).filter(Boolean);
  return lines(
    '予約番号: ' + r.id,
    '車両　　: ' + assetName(ctx),
    locationBlock(ctx, withDetail),
    '貸出　　: ' + fmtDateTime(r.start_at),
    '返却　　: ' + fmtDateTime(r.end_at),
    'オプション: ' + (opts.length ? opts.join('、') : 'なし')
  );
}

function priceBlock(r: ReservationCtx): string {
  const ls: Array<{ label: string; amount: number }> = r.price && Array.isArray(r.price.lines)
    ? r.price.lines
    : (r.price && Array.isArray(r.price.breakdown) ? r.price.breakdown : []);
  const out = ls.map((l) => '・' + nm(l.label, 80) + '　' + yen(Number(l.amount) || 0));
  out.push('合計 (税込)　' + yen(r.total));
  return out.join('\n');
}

function paymentText(method: string): string {
  if (method === 'invoice') {
    return '請求書払い — 当社が発行する請求書に記載の期日までにお支払いください。';
  }
  return '当日店頭でのお支払い — ご利用当日に店頭で、現金またはクレジットカードでお支払いください (事前のお支払いはありません)。';
}

function dayLabel(d: number): string {
  if (d <= 0) return '当日';
  if (d === 1) return '前日';
  if (d === 2) return '前々日';
  return d + '日前';
}

function tierRange(min: number, upperExclusive: number | null): string {
  if (upperExclusive === null) {
    if (min <= 0) return 'いつでも';
    return min >= 3 ? min + '日前まで' : dayLabel(min) + 'まで';
  }
  const lo = min;
  const hi = upperExclusive - 1;
  if (hi <= lo) return dayLabel(lo);
  if (lo === 1 && hi === 2) return '前々日・前日';
  return dayLabel(hi) + '〜' + dayLabel(lo);
}

/** この車両区分・この時期のキャンセル規定 (段階表を文章に) */
export function cancellationPolicyText(ctx: MailContext, r: ReservationCtx): string {
  const rules = ctx.rules || Core.DEFAULT_RULES;
  const base = r.price && Number.isFinite(Number(r.price.base)) ? Number(r.price.base) : Number(r.total || 0);
  const info = Core.cancellationFee({
    asset: ctx.asset
      ? { id: ctx.asset.id, categoryId: ctx.asset.category_id, customFields: ctx.asset.custom_fields || {} }
      : { categoryId: r.category_id, customFields: {} },
    category: { id: r.category_id },
    start: r.start_at,
    cancelAt: r.start_at,
    base,
    rules
  });
  const C = (rules && rules.cancellation) || Core.DEFAULT_RULES.cancellation;
  const tiers: Array<{ minDays: number; pct: number }> = (((C[info.busy ? 'busy' : 'normal'] || {})[info.cls]) || [])
    .map((t: any) => ({ minDays: Number(t.minDays) || 0, pct: Number(t.pct) || 0 }))
    .sort((a: any, b: any) => b.minDays - a.minDays);
  const out: string[] = [];
  out.push('キャンセル料は、基本料金 (延長料金を含む・' + yen(base) + ') に対する割合で計算します。');
  if (info.busy) out.push('このご予約は繁忙期にあたるため、繁忙期の規定を適用します。');
  tiers.forEach((t, i) => {
    const upper = i === 0 ? null : tiers[i - 1].minDays;
    const range = tierRange(t.minDays, upper);
    out.push('・' + range + ': ' + (t.pct === 0 ? '無料' : '基本料金の' + t.pct + '% (' + yen(Math.floor(base * t.pct / 100)) + ')'));
  });
  const noShow = Number.isFinite(Number(C.noShowPct)) ? Number(C.noShowPct) : 100;
  out.push('・無断キャンセル: 基本料金の' + noShow + '% (' + yen(Math.floor(base * noShow / 100)) + ')');
  out.push('※ 日数は貸出日を基準に、日本時間の暦日で数えます (前日 = 貸出日の前の日)。');
  return out.join('\n');
}

/** 割引額 (予約時の料金内訳から。無ければ 0) */
function discountAmount(r: ReservationCtx): number {
  const v = r.price ? Number(r.price.discount) : 0;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * 割引は予約時には自己申告のため、当日に証明を確認する。
 * 確認できなかったときの金額 (割引前) を、お客様・店舗の双方に明示しておく。
 */
function discountProof(ctx: MailContext, r: ReservationCtx): string | null {
  if (!r.discount_type) return null;
  const d = ((ctx.rules && ctx.rules.discounts) || Core.DEFAULT_RULES.discounts)[r.discount_type];
  if (!d) return null;
  const amount = discountAmount(r);
  return lines(
    '・' + (d.label || '割引') + 'の確認書類 (' + (d.proof || '確認できるもの') + ')',
    amount > 0
      ? '　※ 当日ご提示いただけない場合は割引を適用できないため、割引前の料金 (' + yen(r.total + amount) + ') をお支払いいただきます。'
      : null
  );
}

function adminUrl(ctx: MailContext, page: string): string {
  return ctx.siteUrl + 'manage/' + page;
}

// ---------------------------------------------------------------------
// テンプレート
// ---------------------------------------------------------------------
function reservationConfirmed(ctx: MailContext) {
  const r = need(ctx.reservation, '予約');
  const proof = discountProof(ctx, r);
  const text = lines(
    nm(r.customer_name) + ' 様',
    '',
    'このたびはグロースレンタカーをご予約いただき、誠にありがとうございます。',
    '以下の内容でご予約が確定しました。',
    '',
    '■ ご予約内容',
    reservationBlock(ctx, r, true),
    '',
    '■ 料金 (税込)',
    priceBlock(r),
    '',
    '■ お支払い方法・時期',
    paymentText(r.payment_method),
    '',
    '■ キャンセル規定 (この車両・この時期)',
    cancellationPolicyText(ctx, r),
    '',
    '■ ご予約の確認・キャンセル',
    ctx.lookupUrl ? '下記のページから、ご予約内容の確認とキャンセル (貸出開始前まで) ができます。' : null,
    ctx.lookupUrl || null,
    ctx.lookupUrl ? '※ このURLはご予約専用です。他の方に知られないようご注意ください。' : null,
    'ご予約の変更は、公式LINEまたはメールでご連絡ください。',
    '',
    '■ 当日お持ちいただくもの',
    '・運転される方全員の運転免許証 (当日、店頭で確認させていただきます)',
    proof,
    r.payment_method === 'invoice' ? null : '・お支払いに使う現金またはクレジットカード',
    '',
    'ご来店を心よりお待ちしております。',
    '',
    signature(ctx)
  );
  return { subject: subject('ご予約確定のお知らせ (予約番号 ' + r.id + ')'), text };
}

function reservationNewShop(ctx: MailContext) {
  const r = need(ctx.reservation, '予約');
  const discountLabel = r.discount_type
    ? ((ctx.rules && ctx.rules.discounts && ctx.rules.discounts[r.discount_type]) || {}).label || r.discount_type
    : null;
  const dAmount = discountAmount(r);
  // 割引は自己申告 (証明は当日確認)。確認できなければ割引前の金額を請求する
  const noCompany = r.discount_type === 'corporate' && !String(r.company ?? '').trim();
  const discount = discountLabel
    ? discountLabel + (dAmount > 0 ? ' -' + yen(dAmount) : '') + ' (未確認・当日、確認書類をご確認ください' +
      (noCompany ? '。会社名の記入なし' : '') +
      (dAmount > 0 ? '。確認できない場合の請求額 ' + yen(r.total + dAmount) : '') + ')'
    : null;
  const text = lines(
    '新しいWeb予約を受け付けました。',
    '',
    reservationBlock(ctx, r, false),
    'お客様　: ' + nm(r.customer_name) + ' 様 (' + (r.user_id ? '会員' : 'ゲスト') + ')',
    '合計　　: ' + yen(r.total) + ' (税込)',
    '支払方法: ' + (r.payment_method === 'invoice' ? '請求書払い' : '当日店頭'),
    discount ? '割引　　: ' + discount : null,
    r.note ? '備考　　: あり (管理画面でご確認ください)' : null,
    '',
    'お客様の連絡先・詳細は管理画面でご確認ください。',
    adminUrl(ctx, 'reservation-list.html'),
    '',
    '(このメールは予約システムから自動送信しています)'
  );
  const loc = ctx.location ? ' ' + ctx.location.name : '';
  return { subject: subject('新規Web予約 ' + r.id + ' (' + fmtShortDate(r.start_at) + loc + ')'), text };
}

function reservationCancelled(ctx: MailContext) {
  const r = need(ctx.reservation, '予約');
  const fee = Number(r.cancel_fee ?? ctx.payload.cancel_fee ?? 0) || 0;
  const label = typeof ctx.payload.label === 'string' ? nm(ctx.payload.label, 40) : '';
  const byStaff = (r.cancelled_by || ctx.payload.by) === 'staff';
  const text = lines(
    nm(r.customer_name) + ' 様',
    '',
    byStaff
      ? '当店にて、以下のご予約のキャンセル手続きを行いました。'
      : '以下のご予約のキャンセルを承りました。',
    '',
    '■ キャンセルしたご予約',
    reservationBlock(ctx, r, false),
    '',
    '■ キャンセル料',
    fee > 0
      ? yen(fee) + (label ? ' (' + label + ')' : '') + '\nキャンセル料のお支払い方法は、店舗から別途ご連絡いたします。'
      : 'かかりません (無料)',
    '',
    byStaff ? 'お心当たりのない場合は、お手数ですが公式LINEまたはメールでご連絡ください。' : null,
    'またのご利用を心よりお待ちしております。',
    '',
    signature(ctx)
  );
  return { subject: subject('ご予約キャンセルのお知らせ (予約番号 ' + r.id + ')'), text };
}

function reservationCancelledShop(ctx: MailContext) {
  const r = need(ctx.reservation, '予約');
  const fee = Number(r.cancel_fee ?? ctx.payload.cancel_fee ?? 0) || 0;
  const by = (r.cancelled_by || ctx.payload.by) === 'staff' ? 'スタッフ' : 'お客様 (Web)';
  const text = lines(
    '予約がキャンセルされました。',
    '',
    reservationBlock(ctx, r, false),
    'お客様　: ' + nm(r.customer_name) + ' 様 (' + (r.user_id ? '会員' : 'ゲスト') + ')',
    '取消者　: ' + by,
    'キャンセル料: ' + (fee > 0 ? yen(fee) : '無料'),
    '',
    '詳細は管理画面でご確認ください。',
    adminUrl(ctx, 'reservation-list.html'),
    '',
    '(このメールは予約システムから自動送信しています)'
  );
  return { subject: subject('予約キャンセル ' + r.id + ' (' + fmtShortDate(r.start_at) + ')'), text };
}

function inquiryReceived(ctx: MailContext) {
  const q = need(ctx.inquiry, 'お問い合わせ');
  // 送信者が入力した文字列 (本文・お名前・会社名) はここに載せない。
  //   宛先はフォームに入力されたアドレス (所有を確認していない) なので、第三者に任意の文面を
  //   店舗のドメインから送らせないため。種類は決まった選択肢だけを出す。
  const text = lines(
    'お客様',
    '',
    'グロースレンタカーへお問い合わせいただき、ありがとうございます。',
    '以下のとおり受け付けました。内容を確認のうえ、担当者よりご連絡いたします。',
    '',
    '受付番号　　: ' + q.id,
    'お問い合わせの種類: ' + safeTopic(q.topic),
    q.reservation_id ? '予約番号　　: ' + nm(q.reservation_id, 20) : null,
    '受付日時　　: ' + fmtDateTime(q.created_at),
    '',
    'お急ぎの場合は、公式LINEからご連絡ください。',
    '',
    '※ このメールはお問い合わせフォームの送信時に自動でお送りしています。',
    '　 お心当たりのない場合は、お手数ですがこのメールを破棄してください。',
    '',
    signature(ctx)
  );
  return { subject: subject('お問い合わせを受け付けました (受付番号 ' + q.id + ')'), text };
}

function inquiryNewShop(ctx: MailContext) {
  const q = need(ctx.inquiry, 'お問い合わせ');
  const text = lines(
    '新しいお問い合わせを受け付けました。',
    '',
    '受付番号: ' + q.id,
    '種類　　: ' + safeTopic(q.topic),
    'お名前　: ' + nm(q.name) + ' 様' + (q.company ? ' (' + nm(q.company, 100) + ')' : '') + (q.user_id ? ' / 会員' : ''),
    q.reservation_id ? '予約番号: ' + nm(q.reservation_id, 20) : null,
    '受付日時: ' + fmtDateTime(q.created_at),
    '',
    '―― 内容 ――',
    para(q.body, 2000),
    '――――――',
    '',
    'ご連絡先・対応状況は管理画面でご確認ください。',
    adminUrl(ctx, 'inquiries.html'),
    '',
    '(このメールは予約システムから自動送信しています)'
  );
  return { subject: subject('新しいお問い合わせ ' + q.id + ' (' + safeTopic(q.topic) + ')'), text };
}

function couponIssued(ctx: MailContext) {
  const p = ctx.payload || {};
  const amount = Number((ctx.coupon && ctx.coupon.amount) ?? p.amount) || 0;
  if (!(amount > 0)) throw new TemplateError('クーポンの金額が不明なため、メールを作れませんでした');
  const reason = nm((ctx.coupon && ctx.coupon.reason) || p.reason ||
    (p.threshold ? 'ポイント' + p.threshold + 'pt 到達特典' : ''), 80);
  const exp = ctx.coupon && ctx.coupon.expires_at ? fmtDate(ctx.coupon.expires_at) + 'まで' : null;
  const text = lines(
    (p.name ? nm(p.name) + ' 様' : 'お客様'),
    '',
    'いつもグロースレンタカーをご利用いただき、ありがとうございます。',
    yen(amount) + ' のクーポンを発行しました。',
    '',
    '■ クーポン',
    '金額: ' + yen(amount),
    reason ? '内容: ' + reason : null,
    exp ? '有効期限: ' + exp : null,
    '',
    '■ ご利用方法',
    '会員ページにログインのうえ、ご予約の際にクーポンを選んでください。',
    ctx.siteUrl + 'mypage.html',
    '',
    signature(ctx)
  );
  return { subject: subject(yen(amount) + ' クーポンを発行しました'), text };
}

const RENDERERS: Record<TemplateName, (ctx: MailContext) => { subject: string; text: string }> = {
  reservation_confirmed: reservationConfirmed,
  reservation_new_shop: reservationNewShop,
  reservation_cancelled: reservationCancelled,
  reservation_cancelled_shop: reservationCancelledShop,
  inquiry_received: inquiryReceived,
  inquiry_new_shop: inquiryNewShop,
  coupon_issued: couponIssued
};

export function isTemplate(name: string): name is TemplateName {
  return (TEMPLATES as readonly string[]).includes(name);
}

/** お客様宛て (返信先を店舗の連絡先にする) か */
export function isCustomerTemplate(name: string): boolean {
  return name === 'reservation_confirmed' || name === 'reservation_cancelled' ||
    name === 'inquiry_received' || name === 'coupon_issued';
}

export function renderMail(template: string, ctx: MailContext): { subject: string; text: string } {
  if (!isTemplate(template)) throw new TemplateError('未対応のメールテンプレートです: ' + oneLine(template, 40));
  return RENDERERS[template](ctx);
}
