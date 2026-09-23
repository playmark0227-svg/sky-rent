#!/usr/bin/env node
/**
 * Google Calendar API の検証用モック (ローカル専用)
 *
 *   node tests/mocks/google-mock.mjs [port=8979]
 *
 * 本物と同じ流れを再現する:
 *   - POST /token            サービスアカウントの JWT (RS256) を tests/fixtures/test-sa-pub.pem で「実際に検証」して
 *                            アクセストークンを返す (署名・iss・scope・aud・exp が不正なら 400)
 *   - GET  /calendar/v3/calendars/{id}                     カレンダー情報
 *   - GET  /calendar/v3/calendars/{id}/events              予定一覧 (timeMin/timeMax と重なるもの)
 *   - POST /calendar/v3/calendars/{id}/events              予定の作成
 *   - PUT|PATCH /calendar/v3/calendars/{id}/events/{eid}   予定の更新
 *   - DELETE /calendar/v3/calendars/{id}/events/{eid}      予定の削除
 *   - POST /calendar/v3/freeBusy                           予定あり時間帯 (本物と同様、終日予定は既定で含めない)
 *
 * テスト用の操作:
 *   - POST /_mock/reset                                    全消去
 *   - POST /_mock/calendars/{id}   {access: 'writer'|'reader'|'freeBusyOnly'|'none'}  カレンダーと共有権限を作る
 *   - POST /_mock/calendars/{id}/events  {summary, start, end, allDay?, transparency?}  担当者の予定を入れる
 *   - GET  /_mock/calendars/{id}/events                    保存されている予定 (当社が書いたものも含む)
 *   - GET  /_mock/requests                                 受けたリクエストの記録
 *   - POST /_mock/fail  {status, count}                    次の count 回を status で失敗させる (障害試験)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBKEY = fs.readFileSync(path.join(HERE, '..', 'fixtures', 'test-sa-pub.pem'), 'utf8');
const EXPECTED_ISS = 'skyrent-calendar@skyrent-test.iam.gserviceaccount.com';
const PORT = Number(process.argv[2] || process.env.PORT || 8979);

let calendars = new Map();   // id -> {access, events: Map<eventId, event>}
let tokens = new Set();
let requests = [];
let failPlan = { status: 0, count: 0 };
let seq = 1;

function reset() {
  calendars = new Map(); tokens = new Set(); requests = []; failPlan = { status: 0, count: 0 }; seq = 1;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function gerr(res, status, message, reason) {
  send(res, status, { error: { code: status, message, errors: [{ reason: reason || 'error', message }] } });
}
function b64urlDecode(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function verifyAssertion(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return 'JWT の形式が不正です';
  const header = JSON.parse(b64urlDecode(parts[0]).toString());
  const claims = JSON.parse(b64urlDecode(parts[1]).toString());
  if (header.alg !== 'RS256') return 'alg は RS256 である必要があります';
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), PUBKEY, b64urlDecode(parts[2]));
  if (!ok) return '署名が一致しません';
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== EXPECTED_ISS) return 'iss が不正です: ' + claims.iss;
  if (!String(claims.scope || '').includes('https://www.googleapis.com/auth/calendar')) return 'scope が不正です';
  if (!String(claims.aud || '').endsWith('/token')) return 'aud が不正です';
  if (!(claims.exp > now && claims.exp - claims.iat <= 3600 && claims.iat <= now + 60)) return 'iat/exp が不正です';
  return null;
}

function eventRange(ev) {
  const s = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date + 'T00:00:00+09:00');
  const e = ev.end.dateTime ? new Date(ev.end.dateTime) : new Date(ev.end.date + 'T00:00:00+09:00');
  return [s, e];
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  return raw;
}

function authed(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m && tokens.has(m[1]);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const raw = await body(req);
  let json = null;
  try { json = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null; } catch (e) { json = null; }
  if (!url.pathname.startsWith('/_mock')) {
    requests.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: json });
  }

  // ---- テスト操作 ----
  if (url.pathname === '/_mock/reset' && req.method === 'POST') { reset(); return send(res, 200, { ok: true }); }
  if (url.pathname === '/_mock/requests') return send(res, 200, requests);
  if (url.pathname === '/_mock/fail' && req.method === 'POST') { failPlan = { status: json.status || 500, count: json.count || 1 }; return send(res, 200, { ok: true }); }
  let m = /^\/_mock\/calendars\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const cal = calendars.get(id) || { access: 'writer', events: new Map() };
    cal.access = (json && json.access) || 'writer';
    calendars.set(id, cal);
    return send(res, 200, { ok: true, id, access: cal.access });
  }
  m = /^\/_mock\/calendars\/([^/]+)\/events$/.exec(url.pathname);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const cal = calendars.get(id);
    if (!cal) return send(res, 404, { error: 'no calendar' });
    if (req.method === 'GET') return send(res, 200, [...cal.events.values()]);
    const eid = 'seed' + (seq++);
    const ev = {
      id: eid, status: 'confirmed', summary: json.summary || '予定',
      transparency: json.transparency || (json.allDay ? 'transparent' : 'opaque'),
      start: json.allDay ? { date: json.start } : { dateTime: json.start },
      end: json.allDay ? { date: json.end } : { dateTime: json.end },
      attendees: json.attendees
    };
    cal.events.set(eid, ev);
    return send(res, 200, ev);
  }

  // ---- 障害試験 ----
  if (failPlan.count > 0) {
    failPlan.count--;
    return gerr(res, failPlan.status, 'mock failure', 'backendError');
  }

  // ---- OAuth token ----
  if (url.pathname === '/token' && req.method === 'POST') {
    const p = new URLSearchParams(raw);
    if (p.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    const why = verifyAssertion(p.get('assertion'));
    if (why) return send(res, 400, { error: 'invalid_grant', error_description: why });
    const t = 'mock-access-' + crypto.randomBytes(8).toString('hex');
    tokens.add(t);
    return send(res, 200, { access_token: t, expires_in: 3599, token_type: 'Bearer' });
  }

  if (!url.pathname.startsWith('/calendar/v3/')) return gerr(res, 404, 'Not Found', 'notFound');
  if (!authed(req)) return gerr(res, 401, 'Request had invalid authentication credentials.', 'authError');

  // ---- freeBusy ----
  if (url.pathname === '/calendar/v3/freeBusy' && req.method === 'POST') {
    const tMin = new Date(json.timeMin), tMax = new Date(json.timeMax);
    const out = {};
    for (const item of json.items || []) {
      const cal = calendars.get(item.id);
      if (!cal || cal.access === 'none') { out[item.id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] }; continue; }
      const busy = [];
      for (const ev of cal.events.values()) {
        if (ev.status === 'cancelled' || ev.transparency === 'transparent') continue;
        const [s, e] = eventRange(ev);
        if (s < tMax && e > tMin) busy.push({ start: s.toISOString(), end: e.toISOString() });
      }
      out[item.id] = { busy };
    }
    return send(res, 200, { kind: 'calendar#freeBusy', timeMin: json.timeMin, timeMax: json.timeMax, calendars: out });
  }

  m = /^\/calendar\/v3\/calendars\/([^/]+)(\/events(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (!m) return gerr(res, 404, 'Not Found', 'notFound');
  const calId = decodeURIComponent(m[1]);
  const cal = calendars.get(calId);
  if (!cal || cal.access === 'none') return gerr(res, 404, 'Not Found', 'notFound');

  if (!m[2]) {
    if (cal.access === 'freeBusyOnly') return gerr(res, 403, 'Forbidden', 'forbidden');
    return send(res, 200, { kind: 'calendar#calendar', id: calId, summary: calId, timeZone: 'Asia/Tokyo' });
  }

  const eventId = m[3] ? decodeURIComponent(m[3]) : null;
  if (req.method === 'GET' && !eventId) {
    if (cal.access === 'freeBusyOnly') return gerr(res, 403, 'Forbidden', 'forbidden');
    const tMin = url.searchParams.get('timeMin') ? new Date(url.searchParams.get('timeMin')) : new Date(0);
    const tMax = url.searchParams.get('timeMax') ? new Date(url.searchParams.get('timeMax')) : new Date(8.64e15);
    const priv = url.searchParams.getAll('privateExtendedProperty');
    const items = [...cal.events.values()].filter(ev => {
      const [s, e] = eventRange(ev);
      if (!(s < tMax && e > tMin)) return false;
      for (const p of priv) {
        const [k, v] = p.split('=');
        if (((ev.extendedProperties || {}).private || {})[k] !== v) return false;
      }
      return ev.status !== 'cancelled' || url.searchParams.get('showDeleted') === 'true';
    }).sort((a, b) => eventRange(a)[0] - eventRange(b)[0]);
    return send(res, 200, { kind: 'calendar#events', items });
  }

  const canWrite = cal.access === 'writer';
  if (req.method === 'POST' && !eventId) {
    if (!canWrite) return gerr(res, 403, 'You need to have writer access to this calendar.', 'requiredAccessLevel');
    const id = 'ev' + (seq++);
    const ev = Object.assign({ status: 'confirmed' }, json, { id });
    cal.events.set(id, ev);
    return send(res, 200, ev);
  }
  if (eventId && (req.method === 'PUT' || req.method === 'PATCH')) {
    if (!canWrite) return gerr(res, 403, 'You need to have writer access to this calendar.', 'requiredAccessLevel');
    const ev = cal.events.get(eventId);
    if (!ev || ev.status === 'cancelled') return gerr(res, 404, 'Not Found', 'notFound');
    const next = req.method === 'PUT' ? Object.assign({ status: 'confirmed' }, json, { id: eventId }) : Object.assign({}, ev, json, { id: eventId });
    cal.events.set(eventId, next);
    return send(res, 200, next);
  }
  if (eventId && req.method === 'DELETE') {
    if (!canWrite) return gerr(res, 403, 'You need to have writer access to this calendar.', 'requiredAccessLevel');
    const ev = cal.events.get(eventId);
    if (!ev) return gerr(res, 404, 'Not Found', 'notFound');
    if (ev.status === 'cancelled') return gerr(res, 410, 'Resource has been deleted', 'deleted');
    ev.status = 'cancelled';
    res.writeHead(204); return res.end();
  }
  if (eventId && req.method === 'GET') {
    const ev = cal.events.get(eventId);
    if (!ev) return gerr(res, 404, 'Not Found', 'notFound');
    return send(res, 200, ev);
  }
  return gerr(res, 405, 'Method not allowed', 'methodNotAllowed');
});

server.listen(PORT, '0.0.0.0', () => console.log('google-mock listening on :' + PORT));
