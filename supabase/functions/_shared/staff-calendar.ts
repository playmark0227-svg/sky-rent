// =====================================================================
// 受け渡し担当者の Google カレンダー連携 (実装契約書 §3)
//
//   getStaffAvailability({from, to})          公開の空き状況用 (calendar_cache に 5 分キャッシュ)
//   checkStaffForReservation({locationId, start, end})
//                                             予約・見積の確定判定 (キャッシュを使わず Google へ直接)
//   handoverMinutesFor(locationId)            create_reservation_tx に渡す受け渡し間隔 (分)
//   processGcalJob(job)                       outbox の gcal_sync (予約 → 担当者カレンダーへ貸出・返却の予定)
//
// 「予定あり」の定義 (§3.1):
//   status != cancelled かつ 当社が書いた予定ではない (extendedProperties.private.skyrent)
//   かつ (transparency != transparent または 終日予定) かつ 自分 (そのカレンダー) が不参加でない。
//   events が 403 / 404 のときだけ freeBusy へフォールバック (access = freeBusyOnly)。
//
// 判定 (§3.2): 1 拠点に複数カレンダーがあれば「誰か 1 人でも空いていれば」受け渡し可能。
//   読めないカレンダー (共有されていない・接続失敗) は「空いている」とはみなさない。読める誰かが
//   空いていれば可、読める全員が埋まっていて読めない人がいれば「接続できない」扱い (failOpen に従う)。
//
// 個人情報: 予定の件名・説明は取得しない (fields で時間帯だけを読む)。公開用の結果には
//   カレンダー ID (担当者のメールアドレスであることが多い) を出さず 'staff-1' などの別名にする。
// =====================================================================
import { adminClient, env } from './db.ts';
import { DEFAULT_MESSAGES } from './http.ts';
import {
  deleteEvent, freeBusy, GoogleError, insertEvent, isConfigured, listEvents, loadServiceAccount, updateEvent,
  type GoogleEvent
} from './google.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const JST_OFFSET = 9 * HOUR;
const CACHE_TTL_MS = 5 * MIN;
const CACHE_PREFIX = 'staff:v1:';
const MAX_CALENDARS_PER_LOCATION = 10;
/** 予定一覧で読む項目 (件名・説明・参加者のメールアドレスは読まない) */
const EVENT_FIELDS = 'nextPageToken,items(id,status,eventType,transparency,start,end,extendedProperties,attendees(self,responseStatus))';
/**
 * Google が自動で作る終日の予定のうち「予定あり」に数えないもの。
 *   workingLocation … 勤務場所 (毎日の終日予定になるため、数えると全日が埋まる)
 *   birthday        … 連絡先の誕生日
 */
const IGNORED_EVENT_TYPES = ['workingLocation', 'birthday'];

export type BusyRange = { start: string; end: string };
type Range = [number, number];
type Access = 'events' | 'freeBusyOnly' | 'none';

export type CalendarSettings = {
  enabled: boolean;
  mode: 'handover' | 'day';
  handoverMinutes: number;
  oneHandoverAtATime: boolean;
  writeEvents: boolean;
  failOpen: boolean;
  locations: Record<string, { calendarIds: string[] }>;
};

export type StaffLocation = {
  configured: boolean;
  calendars: { calendarId: string; busy: BusyRange[] }[];
  busy: BusyRange[];
  /** 登録済みカレンダーのうち読めないものがある (共有設定の不備・Google 障害) */
  unavailable?: boolean;
};

export type StaffAvailability = {
  enabled: boolean;
  mode: 'handover' | 'day';
  handoverMinutes: number;
  oneHandoverAtATime: boolean;
  locations: Record<string, StaffLocation>;
};

export type StaffCheck =
  | { ok: true; warning?: string }
  | { ok: false; code: 'STAFF_UNAVAILABLE' | 'CALENDAR_UNAVAILABLE'; message: string };

// ---------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------
function toInt(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : def;
}

function calendarIdList(v: unknown): string[] {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const x of raw) {
    const s = typeof x === 'string' ? x.trim() : '';
    if (s && s.length <= 254 && !out.includes(s)) out.push(s);
    if (out.length >= MAX_CALENDARS_PER_LOCATION) break;
  }
  return out;
}

/** app_settings.calendar を既定値込みの形にそろえる */
export function normalizeCalendarSettings(v: unknown): CalendarSettings {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const locs: Record<string, { calendarIds: string[] }> = {};
  const rawLocs = o.locations && typeof o.locations === 'object' && !Array.isArray(o.locations)
    ? o.locations as Record<string, unknown> : {};
  for (const id of Object.keys(rawLocs).sort()) {
    const l = rawLocs[id] as Record<string, unknown> | null;
    locs[id] = { calendarIds: calendarIdList(l && typeof l === 'object' ? l.calendarIds : null) };
  }
  return {
    enabled: o.enabled === true,
    mode: o.mode === 'day' ? 'day' : 'handover',
    handoverMinutes: Math.min(24 * 60, Math.max(0, toInt(o.handoverMinutes, 30))),
    oneHandoverAtATime: o.oneHandoverAtATime !== false,
    writeEvents: o.writeEvents !== false,
    failOpen: o.failOpen === true,
    locations: locs
  };
}

export async function loadCalendarSettings(): Promise<CalendarSettings> {
  const { data, error } = await adminClient().from('app_settings').select('value').eq('key', 'calendar').maybeSingle();
  if (error) throw new Error('calendar settings: ' + (error.code || 'db error'));
  return normalizeCalendarSettings(data ? data.value : null);
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 設定の版 (カレンダーの割り当てが変われば変わる) */
async function settingsVersion(cfg: CalendarSettings): Promise<string> {
  return (await sha256hex(JSON.stringify(cfg.locations))).slice(0, 12);
}

// ---------------------------------------------------------------------
// 時刻・区間
// ---------------------------------------------------------------------
function jstDayStart(ms: number): number {
  return Math.floor((ms + JST_OFFSET) / DAY) * DAY - JST_OFFSET;
}
function jstDayRange(ms: number): Range {
  const s = jstDayStart(ms);
  return [s, s + DAY];
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
/** 日時 → ms。タイムゾーン表記の無い文字列 ('2026-10-01T10:00'・'2026-10-01') は日本時間として読む */
export function parseMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00+09:00');
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return Date.parse(s.replace(' ', 'T') + '+09:00');
  return Date.parse(s);
}
function pad2(n: number) { return (n < 10 ? '0' : '') + n; }
/** 'YYYY-MM-DDTHH:mm:00+09:00' */
function jstIso(ms: number): string {
  const d = new Date(ms + JST_OFFSET);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
    'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':00+09:00';
}
/** '2026/10/01 (木) 10:00' */
function jstLabel(ms: number): string {
  const d = new Date(ms + JST_OFFSET);
  const dow = '日月火水木金土'.charAt(d.getUTCDay());
  return d.getUTCFullYear() + '/' + pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) +
    ' (' + dow + ') ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function parseTime(v: string | undefined, allDay: boolean): number {
  if (!v) return NaN;
  return allDay ? Date.parse(v + 'T00:00:00+09:00') : Date.parse(v);
}

export function eventRange(ev: GoogleEvent): Range | null {
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const s = parseTime(allDay ? ev.start?.date : ev.start?.dateTime, allDay);
  let e = parseTime(allDay ? (ev.end?.date || '') : (ev.end?.dateTime || ''), allDay);
  if (!Number.isFinite(s)) return null;
  if (!Number.isFinite(e) || e <= s) e = allDay ? s + DAY : s;
  if (e <= s) return null;
  return [s, e];
}

/** §3.1 の「予定あり」 */
export function isBusyEvent(ev: GoogleEvent): boolean {
  if (!ev || ev.status === 'cancelled') return false;
  const priv = ev.extendedProperties && ev.extendedProperties.private;
  if (priv && priv.skyrent) return false; // 当社が書いた予定
  if (typeof ev.eventType === 'string' && IGNORED_EVENT_TYPES.includes(ev.eventType)) return false;
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  if (ev.transparency === 'transparent' && !allDay) return false;
  const self = (ev.attendees || []).find((a) => a && a.self);
  if (self && self.responseStatus === 'declined') return false;
  return true;
}

function mergeRanges(list: Range[]): Range[] {
  const xs = list.filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of xs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function clip(list: Range[], from: number, to: number): Range[] {
  return mergeRanges(list.map((r) => [Math.max(r[0], from), Math.min(r[1], to)] as Range));
}

/** 全員が予定ありの時間帯 (= 誰も空いていない時間帯) */
function intersectAll(lists: Range[][]): Range[] {
  if (!lists.length) return [];
  let acc = mergeRanges(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    const b = mergeRanges(lists[i]);
    const next: Range[] = [];
    let x = 0, y = 0;
    while (x < acc.length && y < b.length) {
      const s = Math.max(acc[x][0], b[y][0]), e = Math.min(acc[x][1], b[y][1]);
      if (s < e) next.push([s, e]);
      if (acc[x][1] < b[y][1]) x++; else y++;
    }
    acc = next;
  }
  return acc;
}

function overlaps(r: Range, w: Range) { return r[0] < w[1] && r[1] > w[0]; }
function toOut(list: Range[]): BusyRange[] { return list.map((r) => ({ start: iso(r[0]), end: iso(r[1]) })); }

// ---------------------------------------------------------------------
// Google から 1 カレンダー分の「予定あり」を読む
// ---------------------------------------------------------------------
type CalFetch = { calendarId: string; access: Access; busy: Range[]; error?: string; failed?: boolean };

function googleErrorText(e: unknown): string {
  if (e instanceof GoogleError) {
    if (e.notConfigured) return 'Google のサービスアカウント鍵が設定されていないか、読み込めません';
    if (e.code === 'TOKEN' && e.status >= 400 && e.status < 500) {
      return 'Google の認証に失敗しました (サービスアカウント鍵が無効・削除されていないか確認してください)';
    }
    if (e.status === 0) return 'Google カレンダーに接続できませんでした';
    if (e.status === 401) return 'Google の認証に失敗しました (鍵を確認してください)';
    if (e.status === 403) return 'このカレンダーを読む権限がありません (サービスアカウントに共有してください)';
    if (e.status === 404) return 'カレンダーが見つからないか、共有されていません';
    if (e.status === 429) return 'Google の利用上限に達しました。時間をおいてお試しください';
    return 'Google カレンダーでエラーが発生しました (' + e.status + ')';
  }
  return 'Google カレンダーの確認中にエラーが発生しました';
}

function isRateLimit(e: GoogleError) {
  return e.status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(e.reason);
}

export async function fetchCalendarBusy(calendarId: string, fromMs: number, toMs: number): Promise<CalFetch> {
  try {
    const events = await listEvents(calendarId, iso(fromMs), iso(toMs), { fields: EVENT_FIELDS });
    const busy: Range[] = [];
    for (const ev of events) {
      if (!isBusyEvent(ev)) continue;
      const r = eventRange(ev);
      if (r && overlaps(r, [fromMs, toMs])) busy.push(r);
    }
    return { calendarId, access: 'events', busy: mergeRanges(busy) };
  } catch (e) {
    if (e instanceof GoogleError && (e.status === 403 || e.status === 404) && !isRateLimit(e)) {
      // 予定の詳細を読めない共有 (「予定の表示 (時間枠のみ)」) → freeBusy で時間帯だけ読む
      try {
        const fb = await freeBusy([calendarId], iso(fromMs), iso(toMs));
        const c = fb[calendarId];
        if (!c || (c.errors && c.errors.length)) {
          return { calendarId, access: 'none', busy: [], error: 'カレンダーが見つからないか、サービスアカウントに共有されていません' };
        }
        const busy: Range[] = [];
        for (const b of c.busy) {
          const s = Date.parse(b.start), en = Date.parse(b.end);
          if (Number.isFinite(s) && Number.isFinite(en) && en > s) busy.push([s, en]);
        }
        return { calendarId, access: 'freeBusyOnly', busy: mergeRanges(busy) };
      } catch (e2) {
        return { calendarId, access: 'none', busy: [], error: googleErrorText(e2), failed: true };
      }
    }
    return { calendarId, access: 'none', busy: [], error: googleErrorText(e), failed: true };
  }
}

/** calendar/status 用: 読める範囲 (events / freeBusyOnly / none) を判定する */
export async function probeCalendar(calendarId: string, days = 1): Promise<CalFetch> {
  if (!isConfigured()) {
    return { calendarId, access: 'none', busy: [], error: loadServiceAccount().error || 'Google 連携が未設定です', failed: true };
  }
  const now = Date.now();
  return await fetchCalendarBusy(calendarId, now, now + days * DAY);
}

// ---------------------------------------------------------------------
// キャッシュ (calendar_cache、5 分)
// ---------------------------------------------------------------------
type CachedLocation = { calendars: { calendarId: string; access: Access; busy: Range[] }[] };

async function cacheGet(key: string): Promise<CachedLocation | null> {
  try {
    const { data, error } = await adminClient().from('calendar_cache')
      .select('data, fetched_at').eq('key', key).maybeSingle();
    if (error || !data) return null;
    if (Date.now() - Date.parse(data.fetched_at) > CACHE_TTL_MS) return null;
    return data.data as CachedLocation;
  } catch (_e) {
    return null;
  }
}

async function cachePut(key: string, value: CachedLocation) {
  try {
    const c = adminClient();
    await c.from('calendar_cache').upsert({ key, data: value, fetched_at: new Date().toISOString() });
    // 古いキャッシュの掃除 (1 時間より前)
    await c.from('calendar_cache').delete().lt('fetched_at', new Date(Date.now() - HOUR).toISOString());
  } catch (_e) {
    // キャッシュの失敗は致命的ではない
  }
}

// ---------------------------------------------------------------------
// 公開: 空き状況
// ---------------------------------------------------------------------
export async function getStaffAvailability(p: { from: string; to: string }): Promise<StaffAvailability> {
  const cfg = await loadCalendarSettings();
  const out: StaffAvailability = {
    enabled: cfg.enabled,
    mode: cfg.mode,
    handoverMinutes: cfg.handoverMinutes,
    // 受け渡しの同時刻制限は連携が有効なときだけ (サーバーの handoverMinutesFor と同じ条件)
    oneHandoverAtATime: cfg.enabled && cfg.oneHandoverAtATime,
    locations: {}
  };
  if (!cfg.enabled) return out;

  const fromRaw = parseMs(p.from), toRaw = parseMs(p.to);
  if (!Number.isFinite(fromRaw) || !Number.isFinite(toRaw) || toRaw <= fromRaw) return out;
  // キャッシュが効くよう、日本時間の日単位にそろえる
  const fromMs = jstDayStart(fromRaw);
  const toMs = jstDayStart(toRaw - 1) + DAY;
  const version = await settingsVersion(cfg);
  const googleReady = isConfigured();

  await Promise.all(Object.entries(cfg.locations).map(async ([locId, lc]) => {
    const ids = lc.calendarIds;
    if (!ids.length) {
      out.locations[locId] = { configured: false, calendars: [], busy: [] };
      return;
    }
    if (!googleReady) {
      out.locations[locId] = { configured: true, calendars: [], busy: [], unavailable: true };
      return;
    }
    const key = CACHE_PREFIX + version + ':' + locId + ':' + iso(fromMs) + ':' + iso(toMs);
    let cached = await cacheGet(key);
    if (!cached) {
      const results = await Promise.all(ids.map((id) => fetchCalendarBusy(id, fromMs, toMs)));
      cached = { calendars: results.map((r) => ({ calendarId: r.calendarId, access: r.access, busy: r.busy })) };
      if (results.some((r) => r.failed)) {
        console.warn(JSON.stringify({ level: 'warn', msg: 'staff-calendar: 担当者カレンダーを読めませんでした', location: locId }));
      } else {
        await cachePut(key, cached);
      }
    }
    const known = cached.calendars.filter((c) => c.access !== 'none');
    const loc: StaffLocation = {
      configured: true,
      calendars: known.map((c, i) => ({ calendarId: 'staff-' + (i + 1), busy: toOut(clip(c.busy, fromMs, toMs)) })),
      busy: toOut(clip(intersectAll(known.map((c) => c.busy)), fromMs, toMs))
    };
    if (known.length < ids.length) loc.unavailable = true;
    out.locations[locId] = loc;
  }));
  return out;
}

// ---------------------------------------------------------------------
// 予約・見積の確定判定 (キャッシュを使わない)
// ---------------------------------------------------------------------
function unavailable(cfg: CalendarSettings, locationId: string, why: string): StaffCheck {
  if (cfg.failOpen) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'staff-calendar: 担当者の予定を確認できないため確認を省略しました (failOpen)', location: locationId, why }));
    return { ok: true, warning: 'CALENDAR_UNAVAILABLE' };
  }
  console.warn(JSON.stringify({ level: 'warn', msg: 'staff-calendar: 担当者の予定を確認できないため受け付けませんでした (CALENDAR_UNAVAILABLE)', location: locationId, why }));
  return { ok: false, code: 'CALENDAR_UNAVAILABLE', message: DEFAULT_MESSAGES.CALENDAR_UNAVAILABLE };
}

export async function checkStaffForReservation(p: { locationId: string; start: string; end: string }): Promise<StaffCheck> {
  const cfg = await loadCalendarSettings();
  if (!cfg.enabled) return { ok: true };
  const ids = (cfg.locations[p.locationId] || { calendarIds: [] }).calendarIds;
  if (!ids.length) return { ok: true };
  const s = parseMs(p.start), e = parseMs(p.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { ok: true }; // 入力検証は呼び出し側 (VALIDATION)

  const span = Math.max(cfg.handoverMinutes, 1) * MIN;
  const windows: { label: string; range: Range }[] = cfg.mode === 'day'
    ? [{ label: '貸出日', range: jstDayRange(s) }, { label: '返却日', range: jstDayRange(e) }]
    : [{ label: '貸出', range: [s, s + span] }, { label: '返却', range: [e, e + span] }];

  if (!isConfigured()) return unavailable(cfg, p.locationId, 'not configured');

  // 問い合わせる期間: 近い窓はまとめる (貸出と返却が離れていれば別々に聞く)
  const spans: Range[] = [];
  for (const w of windows.map((x) => x.range).sort((a, b) => a[0] - b[0])) {
    const last = spans[spans.length - 1];
    if (last && w[0] - last[1] <= DAY) last[1] = Math.max(last[1], w[1]);
    else spans.push([w[0], w[1]]);
  }
  const perCal = await Promise.all(ids.map(async (id) => {
    const parts = await Promise.all(spans.map((sp) => fetchCalendarBusy(id, sp[0], sp[1])));
    const bad = parts.find((x) => x.access === 'none' || x.failed);
    return { calendarId: id, known: !bad, busy: mergeRanges(parts.flatMap((x) => x.busy)), why: bad ? (bad.error || '') : '' };
  }));
  const known = perCal.filter((c) => c.known);
  const unknown = perCal.filter((c) => !c.known);

  for (const w of windows) {
    const free = known.some((c) => !c.busy.some((b) => overlaps(b, w.range)));
    if (free) continue;
    if (unknown.length) return unavailable(cfg, p.locationId, unknown.map((u) => u.why).join(' / '));
    const msg = cfg.mode === 'day'
      ? 'ご希望の' + w.label + 'は受け渡し担当者の都合がつきません。別の日をお選びください。'
      : 'ご希望の' + w.label + '時刻は受け渡し担当者の都合がつきません。時刻をずらすか、別の日時をお選びください。';
    return { ok: false, code: 'STAFF_UNAVAILABLE', message: msg };
  }
  return { ok: true };
}

/** create_reservation_tx の handover_minutes。連携が有効かつ oneHandoverAtATime のときだけ */
export async function handoverMinutesFor(_locationId: string): Promise<number> {
  const cfg = await loadCalendarSettings();
  return cfg.enabled && cfg.oneHandoverAtATime ? cfg.handoverMinutes : 0;
}

// ---------------------------------------------------------------------
// gcal_sync: 予約 → 担当者カレンダー (§3.3)
// ---------------------------------------------------------------------
type EventRef = { calendarId: string; eventId: string };
type GcalEvents = { pickup?: EventRef; return?: EventRef };
type GcalResult = { status: 'sent' | 'skipped' | 'failed'; error?: string };

const WRITE_STATUSES = ['confirmed', 'in_use', 'returned'];
const DELETE_STATUSES = ['cancelled', 'no_show'];

function refOf(v: unknown): EventRef | undefined {
  const o = v as Record<string, unknown> | null;
  if (o && typeof o === 'object' && typeof o.calendarId === 'string' && typeof o.eventId === 'string' && o.calendarId && o.eventId) {
    return { calendarId: o.calendarId, eventId: o.eventId };
  }
  return undefined;
}

function gcalErrorText(e: unknown): string {
  if (e instanceof GoogleError && e.status === 403) {
    return '担当者カレンダーに書き込む権限がありません (サービスアカウントに「予定の変更」権限で共有してください)';
  }
  if (e instanceof GoogleError && e.status === 404) return '担当者カレンダーが見つからないか、共有されていません';
  return googleErrorText(e);
}

async function saveEvents(id: string, events: GcalEvents) {
  const { error } = await adminClient().rpc('set_reservation_gcal_events', { p_id: id, p_events: events });
  if (error) throw new Error('set_reservation_gcal_events: ' + (error.code || 'db error'));
}

async function removeRef(ref: EventRef | undefined) {
  if (!ref) return;
  await deleteEvent(ref.calendarId, ref.eventId); // 既に無い (404 / 410) なら成功扱い
}

type ResvRow = {
  id: string; kind: string; status: string; start_at: string; end_at: string; customer_name: string;
  location_id: string; asset_id: string; gcal_events: GcalEvents | null;
};

function eventBody(r: ResvRow, kind: 'pickup' | 'return', assetName: string, locationName: string, minutes: number) {
  const s = Date.parse(r.start_at), e = Date.parse(r.end_at);
  const at = kind === 'pickup' ? s : e;
  const tag = kind === 'pickup' ? '【貸出】' : '【返却】';
  const name = (r.customer_name || '').trim();
  const summary = tag + r.id + ' ' + assetName + (name ? ' / ' + name + ' 様' : '');
  const site = env().SITE_URL;
  const description = [
    '予約番号: ' + r.id,
    '車両: ' + assetName,
    '拠点: ' + locationName,
    '貸出: ' + jstLabel(s),
    '返却: ' + jstLabel(e),
    '',
    '予約の詳細 (管理画面): ' + site + 'manage/reservation-list.html',
    '',
    '※ グロースレンタカーの予約システムが自動で登録した予定です。予約を変更・取消すると自動で更新・削除されます。',
    '※ 「予定なし」として登録しているため、担当者の空き判定には影響しません。'
  ].join('\n');
  return {
    summary,
    description,
    start: { dateTime: jstIso(at), timeZone: 'Asia/Tokyo' },
    end: { dateTime: jstIso(at + minutes * MIN), timeZone: 'Asia/Tokyo' },
    transparency: 'transparent',
    status: 'confirmed',
    extendedProperties: { private: { skyrent: r.id, skyrentKind: kind } }
  };
}

/** 既存の予定を更新、無ければ (消えていれば) 作る。戻り値は保存する予定ID */
async function upsertEvent(calendarId: string, existing: EventRef | undefined, r: ResvRow, kind: 'pickup' | 'return',
  body: Record<string, unknown>): Promise<EventRef> {
  if (existing && existing.calendarId !== calendarId) {
    // 拠点・カレンダーが変わった → 古い予定を消す (消せなくても新しい方は作る)
    try { await removeRef(existing); } catch (_e) { /* 共有が外れたカレンダーなど */ }
    existing = undefined;
  }
  if (existing) {
    try {
      const ev = await updateEvent(calendarId, existing.eventId, body);
      return { calendarId, eventId: ev && ev.id ? String(ev.id) : existing.eventId };
    } catch (e) {
      if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
      // Google 側で消されていた → 作り直す
    }
  }
  // 前回の書き込み後に予定IDを保存できなかった場合の重複を防ぐ (当社の印で探す)
  const found = await listEvents(calendarId, undefined, undefined, {
    privateExtendedProperty: ['skyrent=' + r.id, 'skyrentKind=' + kind], fields: 'nextPageToken,items(id,status)', maxPages: 1
  });
  const alive = found.filter((x) => x && x.id && x.status !== 'cancelled');
  if (alive.length) {
    const ev = await updateEvent(calendarId, String(alive[0].id), body);
    for (const extra of alive.slice(1)) {
      try { await deleteEvent(calendarId, String(extra.id)); } catch (_e) { /* 次回に持ち越し */ }
    }
    return { calendarId, eventId: ev && ev.id ? String(ev.id) : String(alive[0].id) };
  }
  const ev = await insertEvent(calendarId, body);
  return { calendarId, eventId: String(ev.id) };
}

export async function processGcalJob(job: { id?: number; ref_id?: string | null; payload?: Record<string, unknown> | null }): Promise<GcalResult> {
  const reservationId = String((job && job.payload && job.payload.reservation_id) || (job && job.ref_id) || '');
  if (!reservationId) return { status: 'skipped', error: '対象の予約が指定されていません' };
  try {
    const cfg = await loadCalendarSettings();
    const db = adminClient();
    const { data: r, error } = await db.from('reservations')
      .select('id, kind, status, start_at, end_at, customer_name, location_id, asset_id, gcal_events')
      .eq('id', reservationId).maybeSingle();
    if (error) throw new Error('reservations: ' + (error.code || 'db error'));
    if (!r) return { status: 'skipped', error: '予約が見つかりません' };
    const row = r as ResvRow;
    if (row.kind !== 'rental') return { status: 'skipped', error: '貸出停止枠はカレンダーに登録しません' };

    const current: GcalEvents = { pickup: refOf(row.gcal_events?.pickup), return: refOf(row.gcal_events?.return) };
    const hasCurrent = !!(current.pickup || current.return);
    const targetCal = (cfg.locations[row.location_id] || { calendarIds: [] }).calendarIds[0] || '';

    if (!isConfigured()) {
      return hasCurrent || targetCal
        ? { status: 'skipped', error: 'Google 連携が未設定です (サービスアカウント鍵がありません)' }
        : { status: 'skipped', error: 'カレンダー未設定' };
    }

    // 取消・無断キャンセル → 予定を削除
    if (DELETE_STATUSES.includes(row.status)) {
      if (!hasCurrent) return { status: 'sent' };
      await removeRef(current.pickup);
      await removeRef(current.return);
      await saveEvents(row.id, {});
      return { status: 'sent' };
    }
    if (!WRITE_STATUSES.includes(row.status)) return { status: 'skipped', error: '対象外の状態です' };

    if (!cfg.enabled || !cfg.writeEvents) {
      return { status: 'skipped', error: 'カレンダーへの書き込みは無効に設定されています' };
    }
    if (!targetCal) {
      // この拠点にはカレンダーが無い (拠点を移した・登録を外した) → 以前の予定は消しておく
      if (hasCurrent) {
        try {
          await removeRef(current.pickup);
          await removeRef(current.return);
          await saveEvents(row.id, {});
        } catch (_e) { /* 消せなくても致命的ではない */ }
      }
      return { status: 'skipped', error: 'カレンダー未設定' };
    }

    const [{ data: asset }, { data: loc }] = await Promise.all([
      db.from('assets').select('name').eq('id', row.asset_id).maybeSingle(),
      db.from('locations').select('name').eq('id', row.location_id).maybeSingle()
    ]);
    const assetName = (asset && asset.name) || row.asset_id;
    const locationName = (loc && loc.name) || row.location_id;
    const minutes = cfg.handoverMinutes > 0 ? cfg.handoverMinutes : 30;

    const next: GcalEvents = {};
    try {
      next.pickup = await upsertEvent(targetCal, current.pickup, row, 'pickup', eventBody(row, 'pickup', assetName, locationName, minutes));
      next.return = await upsertEvent(targetCal, current.return, row, 'return', eventBody(row, 'return', assetName, locationName, minutes));
    } catch (e) {
      // 途中で失敗しても、作れた分の予定IDは保存しておく (再試行で重複させない)
      if (next.pickup) {
        try { await saveEvents(row.id, { pickup: next.pickup, return: current.return }); } catch (_e) { /* 再試行時に当社の印で探す */ }
      }
      throw e;
    }
    // 保存に失敗したら failed (再試行では当社の印で既存の予定を見つけて更新するので重複しない)
    await saveEvents(row.id, next);
    return { status: 'sent' };
  } catch (e) {
    const msg = e instanceof GoogleError ? gcalErrorText(e) : 'カレンダー同期でエラーが発生しました';
    console.warn(JSON.stringify({
      level: 'warn', msg: 'staff-calendar: gcal_sync 失敗', reservationId,
      status: e instanceof GoogleError ? e.status : undefined, reason: e instanceof GoogleError ? e.reason : (e as Error)?.message?.slice(0, 120)
    }));
    return { status: 'failed', error: msg };
  }
}
