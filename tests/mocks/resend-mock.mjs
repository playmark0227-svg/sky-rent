#!/usr/bin/env node
/**
 * Resend (メール送信 API) の検証用モック (ローカル専用)
 *
 *   node tests/mocks/resend-mock.mjs [port=8978]
 *
 *   POST /emails            Authorization: Bearer <key> 必須。宛先に "bounce" を含むと 422 を返す (失敗経路の試験用)
 *   GET  /_mock/emails      受け取ったメール一覧 (件名・本文・宛先)
 *   POST /_mock/reset       全消去
 *   POST /_mock/fail        {status, count} 次の count 回を status で失敗させる
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.PORT || 8978);
let emails = [];
let failPlan = { status: 0, count: 0 };
let seq = 1;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }

  if (req.url === '/_mock/emails') return send(res, 200, emails);
  if (req.url === '/_mock/reset' && req.method === 'POST') { emails = []; failPlan = { status: 0, count: 0 }; return send(res, 200, { ok: true }); }
  if (req.url === '/_mock/fail' && req.method === 'POST') { failPlan = { status: json.status || 500, count: json.count || 1 }; return send(res, 200, { ok: true }); }

  if (req.url === '/emails' && req.method === 'POST') {
    if (!/^Bearer re_/.test(req.headers.authorization || '')) {
      return send(res, 401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' });
    }
    if (failPlan.count > 0) { failPlan.count--; return send(res, failPlan.status, { statusCode: failPlan.status, name: 'internal_server_error', message: 'mock failure' }); }
    const to = [].concat(json && json.to || []);
    if (!json || !json.from || !to.length || !json.subject || !(json.text || json.html)) {
      return send(res, 422, { statusCode: 422, name: 'validation_error', message: 'from / to / subject / text は必須です' });
    }
    if (to.some(a => /bounce/i.test(a))) {
      return send(res, 422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' });
    }
    const id = 'mock-email-' + (seq++);
    emails.push({ id, at: new Date().toISOString(), from: json.from, to, subject: json.subject, text: json.text || '', html: json.html || '', reply_to: json.reply_to });
    return send(res, 200, { id });
  }
  send(res, 404, { message: 'not found' });
}).listen(PORT, '0.0.0.0', () => console.log('resend-mock listening on :' + PORT));
