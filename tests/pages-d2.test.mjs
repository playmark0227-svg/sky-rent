/**
 * 担当D2 のページのテスト: 会員 (mypage.html)・問い合わせ (contact.html)・法務表示 (privacy / faq / guide / law)
 *
 * 実行: node --test tests/pages-d2.test.mjs
 *
 *   - デモモード: jsdom でページを開き、会員登録・ログイン・予約のキャンセル・プロフィール変更・
 *     パスワード変更・退会・ゲスト照会 (#lookup=)・期限切れリンクの案内・問い合わせの送信を画面操作で確かめる。
 *   - 本番モード: ローカル Supabase (http://127.0.0.1:54321) と起動中の Edge Functions に接続して、
 *     会員登録 → 確認メール (Mailpit) のリンクで戻る → 歓迎表示、期限切れリンク、パスワード再設定、招待、
 *     会員の予約キャンセル、ゲスト照会からのキャンセル、退会、問い合わせ (ハニーポット・同意の版) を確かめる。
 *     Supabase / Edge Functions / Mailpit が動いていなければ skip。
 *
 * DB に作るテスト用の予約は「今日から150〜390日後のランダムな日時」にし、最後はキャンセル済みにする。
 * 作ったユーザーは最後に削除する。外部 CDN にはアクセスしない (supabase-js は node_modules の同じ版を返す)。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function resolveFrom(bases, id) {
  for (const base of bases) {
    if (!base) continue;
    try { return require.resolve(id, { paths: [base] }); } catch (e) { /* 次へ */ }
  }
  return null;
}
const BASES = [ROOT, process.env.SKYRENT_TEST_DEPS].filter(Boolean);
const jsdomPath = resolveFrom(BASES, 'jsdom');
const jsdom = jsdomPath ? require(jsdomPath) : null;
const SUPABASE_UMD = BASES
  .map(b => join(b, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'))
  .find(p => existsSync(p)) || null;

const ORIGIN = 'http://localhost:8765';
// 本番モードのページは Auth の戻り先として許可されている URL (config.toml の additional_redirect_urls) で開く
const LIVE_ORIGIN = 'http://127.0.0.1:8901';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
const LOCAL_API = 'http://127.0.0.1:54321';
const MAILPIT = 'http://127.0.0.1:54324';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const LIVE_CONFIG = { SUPABASE_URL: LOCAL_API, SUPABASE_ANON_KEY: ANON_KEY };
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };
// この実行だけの送信元 IP (公開アドレス扱いの文書用範囲)。IP 単位のレート制限を他の担当のテストと分ける
const TEST_IP = '203.0.113.' + (1 + Math.floor(Math.random() * 250));

async function intercept(request, opts) {
  opts = opts || {};
  const url = new URL(request.url);
  if (url.origin === ORIGIN || url.origin === LIVE_ORIGIN) {
    const file = resolve(ROOT, '.' + decodeURIComponent(url.pathname));
    if (!(file === ROOT || file.startsWith(ROOT + sep)) || !existsSync(file)) return new Response('not found', { status: 404 });
    const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    return new Response(readFileSync(file), { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
  }
  if (request.url === SUPABASE_CDN && SUPABASE_UMD) {
    return new Response(readFileSync(SUPABASE_UMD), { headers: { 'Content-Type': 'application/javascript' } });
  }
  const css = /\.css(\?|$)|fonts\.googleapis/.test(request.url);
  return new Response('', { headers: { 'Content-Type': css ? 'text/css' : 'application/javascript' } });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const plain = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const deq = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);
async function waitFor(fn, ms, step) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step || 25);
  }
}

/** ページを jsdom で開く。mode: 'demo' | 'live' */
function openPage(path, opts) {
  opts = opts || {};
  const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
  const html = readFileSync(join(ROOT, path.split(/[?#]/)[0]), 'utf8');
  const out = { errors: [], consoleErrors: [], warnings: [], resourceErrors: [], notImplemented: [], requests: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => out.consoleErrors.push(a.map(x => (x && x.stack) || String(x)).join(' ')));
  vc.on('warn', (...a) => out.warnings.push(a.map(String).join(' ')));
  vc.on('jsdomError', e => {
    if (e.type === 'unhandled-exception') out.errors.push((e.cause && e.cause.stack) || e.message);
    else if (e.type === 'resource-loading') out.resourceErrors.push((e.url || '') + ' ' + e.message);
    else if (e.type === 'not-implemented') out.notImplemented.push(e.message);
  });
  const origin = opts.mode === 'live' ? LIVE_ORIGIN : ORIGIN;
  const dom = new JSDOM(html, {
    url: origin + '/' + path,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: { interceptors: [requestInterceptor(req => intercept(req, opts))] },
    beforeParse(window) {
      // Edge Functions への送信を記録し、送信元 IP をこの実行専用にする
      window.fetch = (input, init) => {
        const url = String(input && input.url ? input.url : input);
        let body = null;
        try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (e) { body = null; }
        out.requests.push({ url: url, method: (init && init.method) || 'GET', body: body });
        if (url.indexOf('/functions/v1/') >= 0) {
          const h = new globalThis.Headers((init && init.headers) || {});
          h.set('x-real-ip', TEST_IP);
          init = Object.assign({}, init, { headers: h });
        }
        return globalThis.fetch(input, init);
      };
      window.AbortController = globalThis.AbortController;
      window.AbortSignal = globalThis.AbortSignal;
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.matchMedia = q => ({
        matches: false, media: String(q), onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }
      });
      if (opts.mode === 'live') window.localStorage.setItem('sky-rent.configOverride', JSON.stringify(LIVE_CONFIG));
      Object.entries(opts.local || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
      Object.entries(opts.session || {}).forEach(([k, v]) => window.sessionStorage.setItem(k, v));
      window.__ready = new Promise(res => window.addEventListener('skyrent:ready', () => res(true)));
    }
  });
  out.dom = dom;
  out.window = dom.window;
  out.document = dom.window.document;
  out.$ = s => dom.window.document.querySelector(s);
  out.ready = ms => Promise.race([dom.window.__ready, new Promise(r => setTimeout(() => r(false), ms || 10000).unref())]);
  out.close = () => { try { dom.window.close(); } catch (e) { /* 無視 */ } };
  return out;
}

function assertClean(page, label) {
  deq(page.errors, [], label + ': JS エラー');
  deq(page.resourceErrors, [], label + ': 読み込めなかったファイル');
  deq(page.consoleErrors, [], label + ': console.error');
  deq(page.notImplemented.filter(m => /navigation/i.test(m)), [], label + ': 想定外の画面遷移');
}

// 入力欄に値を入れる
function fill(page, values) {
  Object.entries(values).forEach(([sel, v]) => {
    const el = page.$(sel);
    assert.ok(el, sel + ' が無い');
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}
function submit(page, sel) {
  const form = page.$(sel);
  assert.ok(form, sel + ' が無い');
  form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
}
const visible = (page, id) => { const el = page.$('#' + id); return !!el && !el.hidden; };
const text = (page, sel) => { const el = page.$(sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };
const currentView = page => ['auth', 'sent', 'reset', 'newpass', 'link', 'member', 'lookup'].filter(v => visible(page, 'view-' + v));

// 業務データ (sky-rent.*) が localStorage に無いこと (本番モード)
function businessKeys(storage) {
  const ok = ['sky-rent.configOverride', 'sky-rent.lang', 'sky-rent.introSeen'];
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.indexOf('sky-rent.') === 0 && ok.indexOf(k) < 0) out.push(k);
  }
  return out;
}

const NO_JSDOM = jsdom ? false : 'jsdom が見つかりません (npm install を実行してください)';

// =====================================================================
// デモモード: mypage.html
// =====================================================================
describe('デモモード: mypage.html', { skip: NO_JSDOM }, () => {
  test('未ログイン → ログイン・会員登録の画面 (デモ会員の案内・プライバシーポリシーの版を表示)', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      deq(currentView(page), ['auth']);
      assert.equal(page.$('#demo-hint').hidden, false, 'デモ会員の案内が出ない');
      assert.match(text(page, '#r-privacy-label'), /プライバシーポリシー \(2026-08版\)/);
      assert.equal(page.$('#r-marketing').checked, false, '案内メールの受信が既定で ON になっている');
      assert.match(text(page, '#reg-form'), /8文字以上で、英大文字・英小文字・数字をそれぞれ1文字以上/);
      assertClean(page, 'mypage');
    } finally { page.close(); }
  });

  test('会員登録: 入力チェック (パスワード条件・確認用の不一致・同意なし) → 登録すると歓迎表示・同意の版と案内メールOFFを記録', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore;
      const email = 'd2-demo-' + Date.now() + '@example.com';
      fill(page, { '#r-name': 'テスト 花子', '#r-kana': 'テスト ハナコ', '#r-email': email, '#r-pass': 'abcdefgh1', '#r-pass2': 'abcdefgh1', '#r-privacy': true });
      submit(page, '#reg-form');
      await waitFor(() => !page.$('#reg-error').hidden);
      assert.match(text(page, '#reg-error'), /英大文字/, 'パスワード条件のエラーが出ない');
      assert.equal(S.findMemberByEmail(email), null);

      fill(page, { '#r-pass': 'Abcdefgh1', '#r-pass2': 'Abcdefgh2' });
      submit(page, '#reg-form');
      await waitFor(() => /一致しません/.test(text(page, '#reg-error')));
      assert.match(text(page, '#reg-error'), /一致しません/);

      fill(page, { '#r-pass2': 'Abcdefgh1', '#r-privacy': false });
      submit(page, '#reg-form');
      await waitFor(() => /プライバシーポリシーへの同意/.test(text(page, '#reg-error')));
      assert.equal(S.findMemberByEmail(email), null, '同意なしで登録された');

      fill(page, { '#r-privacy': true });
      submit(page, '#reg-form');
      await waitFor(() => visible(page, 'view-member'), 3000);
      deq(currentView(page), ['member']);
      assert.match(text(page, '#view-member'), /会員登録が完了しました。ようこそ、テスト 花子 様/);
      const m = S.findMemberByEmail(email);
      assert.ok(m, '会員が作られていない');
      assert.equal(m.marketingOptIn, false);
      deq(m.consent.documents, [{ id: 'privacy', version: '2026-08' }]);
      assert.equal(m.consent.marketing.optIn, false);
      assert.ok(m.consent.agreedAt);
      assertClean(page, 'mypage 登録');
    } finally { page.close(); }
  });

  test('ログイン → 予約一覧 → キャンセル料を表示して確認 → キャンセル (モーダル) / 間違ったパスワード', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore;
      fill(page, { '#l-email': 'demo@example.com', '#l-pass': 'wrong-pass' });
      submit(page, '#login-form');
      await waitFor(() => !page.$('#login-error').hidden);
      assert.match(text(page, '#login-error'), /メールアドレスまたはパスワードが正しくありません/);

      fill(page, { '#l-pass': 'demo1234' });
      submit(page, '#login-form');
      await waitFor(() => visible(page, 'view-member'));
      assert.match(text(page, '#view-member'), /デモ 太郎 様/);
      // 確定済み・貸出前の予約 (シード) にキャンセルボタンがある
      const target = S.list('reservations').find(r => r.memberId === 'M001' && r.status === 'confirmed' && Date.parse(r.start) > Date.now());
      assert.ok(target, 'シードに貸出前の予約が無い');
      const btn = page.$('[data-res="' + target.reservationId + '"]');
      assert.ok(btn, '予約一覧に出ていない');
      assert.equal(btn.textContent, '詳細・キャンセル');
      // 他の会員の予約は出ない
      const other = S.list('reservations').find(r => r.memberId === 'M002');
      assert.equal(page.$('[data-res="' + other.reservationId + '"]'), null, '他の会員の予約が見えている');

      btn.click();
      await waitFor(() => page.$('#mp-modal-body [data-cancel-open]'));
      assert.equal(page.$('#mp-modal').hidden, false);
      const body = text(page, '#mp-modal-body');
      assert.match(body, new RegExp(target.reservationId));
      assert.match(body, /いまキャンセルした場合のキャンセル料: ¥[\d,]+/);
      assert.match(body, /貸出日時\s*\d{4}\/\d{2}\/\d{2}\([日月火水木金土]\) 10:00/, '日本時間の表示になっていない');
      page.$('#mp-modal-body [data-cancel-open]').click();
      assert.equal(page.$('#mp-modal-body [data-cancel-step2]').hidden, false, '確認の段階が出ない');
      page.$('#mp-modal-body [data-cancel-go]').click();
      await waitFor(() => /キャンセルが完了しました/.test(text(page, '#mp-modal-body')), 3000);
      assert.match(text(page, '#mp-modal-body'), /デモ環境のため、確認メールは送信されません/);
      const after = S.findById('reservations', 'reservationId', target.reservationId);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.cancelledBy, 'customer');
      // 閉じると一覧が更新され、キャンセル済みになる
      page.$('#mp-modal-close').click();
      await waitFor(() => page.$('#mp-modal').hidden);
      await waitFor(() => page.$('[data-res="' + target.reservationId + '"]') && page.$('[data-res="' + target.reservationId + '"]').textContent === '詳細');
      const row = page.$('[data-res="' + target.reservationId + '"]').closest('tr');
      assert.match(row.textContent, /キャンセル/);
      assertClean(page, 'mypage キャンセル');
    } finally { page.close(); }
  });

  test('キャンセル料が変わった (PRICE_CHANGED) ときは新しい金額を見せて、もう一度確定してもらう', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend, S = w.SkyRentStore;
      fill(page, { '#l-email': 'demo@example.com', '#l-pass': 'demo1234' });
      submit(page, '#login-form');
      await waitFor(() => visible(page, 'view-member'));
      const target = S.list('reservations').find(r => r.memberId === 'M001' && r.status === 'confirmed' && Date.parse(r.start) > Date.now());
      page.$('[data-res="' + target.reservationId + '"]').click();
      await waitFor(() => page.$('#mp-modal-body [data-cancel-open]'));
      // 1回目: サーバーの計算が変わった体で PRICE_CHANGED を返す。2回目は本物に渡す
      const orig = B.cancelReservation;
      const calls = [];
      B.cancelReservation = p => {
        calls.push(Object.assign({}, p));
        if (calls.length === 1) {
          const e = new w.Error('料金が変わりました。');
          e.code = 'PRICE_CHANGED';
          e.cancellation = { cancellable: true, fee: 123456, pct: 50, label: '当日 (50%)' };
          return Promise.reject(e);
        }
        return orig.call(B, Object.assign({}, p, { expectedFee: undefined }));
      };
      page.$('#mp-modal-body [data-cancel-open]').click();
      page.$('#mp-modal-body [data-cancel-go]').click();
      await waitFor(() => /キャンセル料が変わりました/.test(text(page, '#mp-modal-body')));
      assert.match(text(page, '#mp-modal-body [data-result]'), /新しい金額 ¥123,456 \(当日 \(50%\)\)/);
      assert.match(text(page, '#mp-modal-body [data-cancel-step2]'), /キャンセル料は ¥123,456 です/);
      assert.equal(S.findById('reservations', 'reservationId', target.reservationId).status, 'confirmed', '確認前にキャンセルされた');
      page.$('#mp-modal-body [data-cancel-go]').click();
      await waitFor(() => /キャンセルが完了しました/.test(text(page, '#mp-modal-body')), 3000);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].expectedFee, 123456, '2回目は新しい金額で送っていない');
      assert.equal(S.findById('reservations', 'reservationId', target.reservationId).status, 'cancelled');
      B.cancelReservation = orig;
      assertClean(page, 'mypage PRICE_CHANGED');
    } finally { page.close(); }
  });

  test('プロフィール変更 (案内メールの受信) / パスワード変更 (条件チェック) / ログアウト', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      const S = page.window.SkyRentStore;
      fill(page, { '#l-email': 'demo@example.com', '#l-pass': 'demo1234' });
      submit(page, '#login-form');
      await waitFor(() => visible(page, 'view-member'));

      fill(page, { '#pf-name': '' });
      submit(page, '#pf-form');
      await waitFor(() => !page.$('#pf-msg').hidden);
      assert.match(text(page, '#pf-msg'), /お名前を入力してください/);

      fill(page, { '#pf-name': 'デモ 次郎', '#pf-phone': '090-1234-5678', '#pf-marketing': true });
      submit(page, '#pf-form');
      await waitFor(() => /登録情報を保存しました/.test(text(page, '#view-member')));
      let m = S.currentMember();
      assert.equal(m.name, 'デモ 次郎');
      assert.equal(m.phone, '090-1234-5678');
      assert.equal(m.marketingOptIn, true);
      assert.equal(page.$('#pf-marketing').checked, true);

      fill(page, { '#pw-new': 'short1A', '#pw-new2': 'short1A' });
      submit(page, '#pw-form');
      await waitFor(() => !page.$('#pw-msg').hidden);
      assert.match(text(page, '#pw-msg'), /8文字以上/);
      fill(page, { '#pw-new': 'NewDemo-2026', '#pw-new2': 'NewDemo-2026' });
      submit(page, '#pw-form');
      await waitFor(() => /パスワードを変更しました/.test(text(page, '#pw-msg')));
      assert.equal(S.currentMember().password, 'NewDemo-2026');

      page.$('#logout-btn').click();
      await waitFor(() => visible(page, 'view-auth'));
      assert.match(text(page, '#page-msg'), /ログアウトしました/);
      assert.equal(S.currentMember(), null);
      assertClean(page, 'mypage プロフィール');
    } finally { page.close(); }
  });

  test('退会: 確認のチェックが必要 → 退会すると会員情報が消えてログアウト', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      const S = page.window.SkyRentStore;
      fill(page, { '#l-email': 'corp@example.com', '#l-pass': 'demo1234' });
      submit(page, '#login-form');
      await waitFor(() => visible(page, 'view-member'));
      submit(page, '#close-form');
      await waitFor(() => !page.$('#close-msg').hidden);
      assert.match(text(page, '#close-msg'), /チェックしてください/);
      assert.ok(S.findMemberByEmail('corp@example.com'));
      fill(page, { '#close-confirm': true });
      submit(page, '#close-form');
      await waitFor(() => visible(page, 'view-auth'));
      assert.match(text(page, '#page-msg'), /退会の手続きが完了しました/);
      assert.equal(S.findMemberByEmail('corp@example.com'), null);
      assertClean(page, 'mypage 退会');
    } finally { page.close(); }
  });

  test('パスワード再設定の画面 (デモはメールを送らない案内) / 期限切れリンク (#error=...) は案内を出して # を消す', async () => {
    const page = openPage('mypage.html');
    try {
      assert.equal(await page.ready(8000), true);
      page.$('#to-reset').click();
      deq(currentView(page), ['reset']);
      fill(page, { '#rs-email': 'not-an-email' });
      submit(page, '#reset-form');
      await waitFor(() => !page.$('#reset-error').hidden);
      fill(page, { '#rs-email': 'demo@example.com' });
      submit(page, '#reset-form');
      await waitFor(() => visible(page, 'view-sent'));
      assert.match(text(page, '#view-sent'), /デモ環境のため、メールは送信されません/);
      assertClean(page, 'mypage 再設定');
    } finally { page.close(); }

    const page2 = openPage('mypage.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    try {
      assert.equal(await page2.ready(8000), true);
      deq(currentView(page2), ['link']);
      assert.match(text(page2, '#link-msg'), /メールのリンクが無効か、有効期限が切れています/);
      assert.equal(page2.window.location.hash, '', '# が残っている');
      page2.$('#view-link [data-go="reset"]').click();
      deq(currentView(page2), ['reset']);
      assertClean(page2, 'mypage 期限切れ');
    } finally { page2.close(); }
  });

  test('ゲスト照会 (#lookup=予約番号.照会キー): ログインなしで表示・キャンセル / 不正なキー・壊れた URL', async () => {
    // 1) 予約を作る (デモの予約 API)
    const page = openPage('mypage.html');
    let lookupUrl, id, local = {};
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, B = w.SkyRentBackend;
      // (jsdom の Date は別 realm なので、ミリ秒の数値で渡す)
      const start = Date.now() + 200 * 86400000;
      const s = B.jst.toInput(start).slice(0, 10) + 'T11:00';
      const e = B.jst.toInput(start + 86400000).slice(0, 10) + 'T11:00';
      const q = await B.quote({ assetId: 'V003', start: s, end: e, optionIds: [] });
      const res = await B.createReservation({
        idempotencyKey: 'd2-demo-' + Date.now(), assetId: 'V003', start: s, end: e, optionIds: [],
        customer: { name: 'ゲスト 太郎', email: 'guest-d2@example.com', phone: '09011112222' },
        paymentMethod: 'onsite', licenseConfirmed: true, expectedTotal: q.quote.total
      });
      lookupUrl = res.lookupUrl; id = res.reservation.id;
      assert.match(lookupUrl, /mypage\.html#lookup=R\d+\.[A-Za-z0-9_-]+$/);
      // 同じタブで # を変えると照会画面になる
      w.location.hash = lookupUrl.slice(lookupUrl.indexOf('#'));
      await waitFor(() => visible(page, 'view-lookup') && page.$('#lookup-body [data-cancel-open]'), 3000);
      assert.match(text(page, '#lookup-body'), /ゲスト 太郎 様/);
      assert.match(text(page, '#lookup-body'), /キャンセル料: ¥0 \(/);
      for (let i = 0; i < w.localStorage.length; i++) local[w.localStorage.key(i)] = w.localStorage.getItem(w.localStorage.key(i));
      assertClean(page, 'mypage 照会 (同じタブ)');
    } finally { page.close(); }

    // 2) 照会 URL で新しく開く (同じブラウザのデータ)
    const hash = lookupUrl.slice(lookupUrl.indexOf('#'));
    const page2 = openPage('mypage.html' + hash, { local: local });
    try {
      assert.equal(await page2.ready(8000), true);
      await waitFor(() => page2.$('#lookup-body [data-cancel-open]'), 3000);
      deq(currentView(page2), ['lookup']);
      page2.$('#lookup-body [data-cancel-open]').click();
      page2.$('#lookup-body [data-cancel-go]').click();
      await waitFor(() => /キャンセルが完了しました/.test(text(page2, '#lookup-body')), 3000);
      const r = page2.window.SkyRentStore.findById('reservations', 'reservationId', id);
      assert.equal(r.status, 'cancelled');
      assert.match(text(page2, '#lookup-body'), /キャンセル済み/);
      // 照会をやめるとログイン画面
      page2.$('#lookup-leave').click();
      deq(currentView(page2), ['auth']);
      assert.equal(page2.window.location.hash, '');
      assertClean(page2, 'mypage 照会');
    } finally { page2.close(); }

    // 3) キーが違う → 見つからない / 形が壊れている → 案内
    const page3 = openPage('mypage.html#lookup=' + id + '.WrongTokenWrongToken', { local: local });
    try {
      assert.equal(await page3.ready(8000), true);
      await waitFor(() => /見つかりませんでした/.test(text(page3, '#lookup-body')), 3000);
      assert.ok(page3.$('#lookup-body [data-retry]'));
    } finally { page3.close(); }
    const page4 = openPage('mypage.html#lookup=broken');
    try {
      assert.equal(await page4.ready(8000), true);
      assert.match(text(page4, '#lookup-body'), /照会URLが正しくありません/);
    } finally { page4.close(); }
  });
});

// =====================================================================
// デモモード: contact.html と法務ページ
// =====================================================================
describe('デモモード: contact.html', { skip: NO_JSDOM }, () => {
  test('入力チェック → 送信中はボタン無効 → 受付番号を表示 / ハニーポットは保存しない / ページは localStorage に直接書かない', async () => {
    const page = openPage('contact.html?topic=' + encodeURIComponent('法人利用・請求書払いについて'));
    try {
      assert.equal(await page.ready(8000), true);
      const w = page.window, S = w.SkyRentStore;
      assert.equal(page.$('#cf-topic').value, '法人利用・請求書払いについて');
      assert.match(text(page, '#cf-agree-label'), /プライバシーポリシー \(2026-08版\)/);
      // ハニーポット欄は見えない・フォーカスされない
      const hp = page.$('#cf-website');
      assert.equal(hp.getAttribute('tabindex'), '-1');
      assert.equal(hp.closest('[aria-hidden="true"]') !== null, true);

      const before = S.list('inquiries').length;
      submit(page, '#ct-form');
      await waitFor(() => page.$('#cf-err').classList.contains('on'));
      assert.match(text(page, '#cf-err'), /お名前をご入力ください/);
      assert.ok(page.$('#cf-name').closest('.fg').classList.contains('has-err'));

      fill(page, { '#cf-name': '問合 太郎', '#cf-email': 'contact-d2@example.com', '#cf-body': '法人で月に数回利用したいです。', '#cf-reservation': 'r-12', '#cf-agree': true });
      submit(page, '#ct-form');
      await waitFor(() => /予約番号は/.test(text(page, '#cf-err')));
      fill(page, { '#cf-reservation': 'r00012' });

      // localStorage への直接書込を記録 (デモの store 以外が書いていないこと)
      const origSet = w.Storage.prototype.setItem;
      const direct = [];
      w.Storage.prototype.setItem = function (k, v) { if (!/^sky-rent\./.test(k) || k === 'sky-rent.inquiries') direct.push(k); return origSet.call(this, k, v); };
      submit(page, '#ct-form');
      assert.equal(page.$('#cf-submit').disabled, true, '送信中にボタンが無効にならない');
      assert.equal(page.$('#cf-submit').textContent, '送信しています…');
      await waitFor(() => page.$('#ct-done').classList.contains('on'), 3000);
      w.Storage.prototype.setItem = origSet;
      const list = S.list('inquiries');
      assert.equal(list.length, before + 1);
      const inq = list[0];
      assert.equal(inq.reservationId, 'R00012');
      assert.equal(inq.topic, '法人利用・請求書払いについて');
      assert.match(inq.idempotencyKey, /^inq_[A-Za-z0-9_-]{16,}$/);
      assert.match(text(page, '#ct-ref'), new RegExp('受付番号: ' + inq.inquiryId));
      assert.match(text(page, '#ct-mail'), /デモ環境のため/);
      assert.equal(page.$('#ct-form').style.display, 'none');
      // store (デモの保存先) 経由の書込だけ
      deq(direct.filter(k => k !== 'sky-rent.inquiries'), [], 'ページが localStorage に直接書いた');
      assertClean(page, 'contact');
    } finally { page.close(); }

    const page2 = openPage('contact.html');
    try {
      assert.equal(await page2.ready(8000), true);
      const S = page2.window.SkyRentStore;
      const before = S.list('inquiries').length;
      fill(page2, { '#cf-name': 'bot', '#cf-email': 'bot@example.com', '#cf-topic': 'その他', '#cf-body': 'spam spam spam', '#cf-agree': true, '#cf-website': 'http://spam.example' });
      submit(page2, '#ct-form');
      await waitFor(() => page2.$('#ct-done').classList.contains('on'), 3000);
      assert.equal(S.list('inquiries').length, before, 'ハニーポットに入力があるのに保存された');
    } finally { page2.close(); }
  });

  test('ログイン中の会員は、お名前・連絡先が入っている', async () => {
    const page = openPage('contact.html', { session: { 'sky-rent.memberSession': JSON.stringify({ memberId: 'M001' }) } });
    try {
      assert.equal(await page.ready(8000), true);
      assert.equal(page.$('#cf-name').value, 'デモ 太郎');
      assert.equal(page.$('#cf-email').value, 'demo@example.com');
    } finally { page.close(); }
  });
});

describe('法務・案内ページ (privacy / faq / guide / law)', { skip: NO_JSDOM }, () => {
  test('privacy.html: 保存先・メール送信・Googleカレンダー (電話番号は登録しない)・免許番号を取らない・ブラウザ保存・デモの記述', async () => {
    const page = openPage('privacy.html');
    try {
      assert.equal(await page.ready(8000), true);
      const t = text(page, 'main');
      assert.match(t, /Supabase/);
      assert.match(t, /東京リージョン/);
      assert.match(t, /Resend/);
      assert.match(t, /Google カレンダー|Googleカレンダー/);
      assert.match(t, /予約番号・車両・お名前・貸出と返却の日時/);
      assert.match(t, /電話番号やメールアドレスは登録しません/);
      assert.match(t, /Web予約では、運転免許証の番号や画像はお預かりしません/);
      assert.match(t, /ログイン状態を保つための情報/);
      assert.match(t, /デモ環境 \(本番のサーバーに接続していない公開デモ\) では/);
      // 「ローカルストレージに予約を保存する」旨はデモ環境の段落にだけある
      const s10 = page.$('#s10').parentElement;
      const paras = [...s10.querySelectorAll('p')].filter(p => /ご予約内容や会員情報.*ローカルストレージ/.test(p.textContent));
      assert.equal(paras.length, 1);
      assert.match(paras[0].textContent, /^デモ環境/);
      assert.match(t, /版: 2026-08/);
      assertClean(page, 'privacy');
    } finally { page.close(); }
  });

  test('law.html: #cancel (キャンセル規定の版の URL) があり、予約の成立時期・キャンセル方法 (マイページ / 照会URL / LINE) を記載', async () => {
    const page = openPage('law.html');
    try {
      assert.equal(await page.ready(8000), true);
      assert.ok(page.$('#cancel'), 'law.html#cancel が無い (legal_documents の cancel の URL)');
      const t = text(page, 'main');
      assert.match(t, /予約の成立時期/);
      assert.match(t, /上記の内容で予約を確定する/);
      const c = page.$('#cancel').nextElementSibling.nextElementSibling.textContent;
      assert.match(c, /マイページ/);
      assert.match(c, /照会URL/);
      assert.match(c, /公式LINE/);
      assert.doesNotMatch(t, /電話でのキャンセル|お電話でキャンセル/);
      assertClean(page, 'law');
    } finally { page.close(); }
  });

  test('faq.html / guide.html: 免許証は当日店頭で確認・キャンセルはマイページ / 照会URL / LINE・番号の振り直し', async () => {
    const page = openPage('faq.html');
    try {
      assert.equal(await page.ready(8000), true);
      const t = text(page, 'main');
      assert.match(t, /免許証の番号を入力していただく必要はありません/);
      assert.match(t, /照会URL/);
      assert.doesNotMatch(t, /キャンセル料はご連絡をいただいた時点を基準/);
      const nums = [...page.document.querySelectorAll('.faq .q')].map(x => x.textContent);
      deq(nums, nums.map((_, i) => 'Q' + String(i + 1).padStart(2, '0')), 'Q の番号が連番でない');
      assertClean(page, 'faq');
    } finally { page.close(); }
    const g = openPage('guide.html');
    try {
      assert.equal(await g.ready(8000), true);
      const t = text(g, 'main');
      assert.match(t, /運転免許証の番号を入力する必要はありません/);
      assert.match(t, /照会URL/);
      assert.match(t, /上記の内容で予約を確定する/);
      assert.ok(g.$('a[href="law.html#cancel"]'));
      assertClean(g, 'guide');
    } finally { g.close(); }
  });
});

// =====================================================================
// 本番モード: ローカル Supabase + Edge Functions + Mailpit
// =====================================================================
async function api(path, opts) {
  opts = opts || {};
  const key = opts.service ? SERVICE_KEY : ANON_KEY;
  const headers = Object.assign({ apikey: key, Authorization: 'Bearer ' + (opts.token || key), 'Content-Type': 'application/json' }, opts.headers || {});
  if (path.indexOf('/functions/v1/') === 0) headers['x-real-ip'] = TEST_IP;
  const res = await fetch(LOCAL_API + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const raw = await res.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = raw; }
  if (!res.ok && !opts.allowError) {
    const e = new Error(path + ': HTTP ' + res.status + ' ' + raw.slice(0, 300));
    e.status = res.status; e.body = json;
    throw e;
  }
  return opts.allowError ? { status: res.status, json: json } : json;
}
const serviceSelect = (table, query) => api('/rest/v1/' + table + '?' + query, { service: true });
async function deleteUser(userId) {
  if (!userId) return;
  try { await api('/auth/v1/admin/users/' + userId, { service: true, method: 'DELETE' }); } catch (e) { /* 後片付けの失敗は無視 */ }
}
async function findUserId(email) {
  const rows = await serviceSelect('members', 'select=user_id&email=eq.' + encodeURIComponent(email));
  return rows[0] ? rows[0].user_id : null;
}
async function createMember(opts) {
  opts = opts || {};
  const email = 'd2-live-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
  const password = opts.password || 'D2-Live-Pass-2026a';
  const user = await api('/auth/v1/admin/users', {
    service: true,
    body: { email: email, password: password, email_confirm: true, user_metadata: { account_type: 'member', name: opts.name || 'テスト 会員', phone: '09000000000' } }
  });
  return { email: email, password: password, userId: user.id || (user.user && user.user.id) };
}
async function signInToken(email, password) {
  const s = await api('/auth/v1/token?grant_type=password', { body: { email: email, password: password } });
  return s.access_token;
}

// Mailpit: 宛先のメールを待ち、本文の Auth のリンク (/auth/v1/verify?...) を返す
async function mailLink(to, subjectRe, sinceMs) {
  const end = Date.now() + 15000;
  for (;;) {
    const res = await fetch(MAILPIT + '/api/v1/search?query=' + encodeURIComponent('to:"' + to + '"'));
    const list = res.ok ? await res.json() : { messages: [] };
    const msg = (list.messages || []).find(m => (!subjectRe || subjectRe.test(m.Subject)) && (!sinceMs || Date.parse(m.Created) >= sinceMs - 2000));
    if (msg) {
      const full = await (await fetch(MAILPIT + '/api/v1/message/' + msg.ID)).json();
      const body = String(full.HTML || '') + '\n' + String(full.Text || '');
      const m = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(body);
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    if (Date.now() > end) throw new Error(to + ' 宛てのメールが届かない');
    await sleep(300);
  }
}
// Auth のリンクを開き、戻り先 URL の # 以降を返す
async function followAuthLink(link) {
  const res = await fetch(link, { redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  const i = loc.indexOf('#');
  return { location: loc, hash: i >= 0 ? loc.slice(i) : '' };
}

// 予約を作る (150〜390日後のランダムな日時。重なったら別の日時でやり直す)
async function createReservation(opts) {
  const catalog = await api('/rest/v1/rpc/public_catalog', { body: {} });
  const docs = (catalog.legal || []).filter(d => ['clause', 'cancel', 'privacy'].includes(d.id)).map(d => ({ id: d.id, version: d.version }));
  const assets = ['V001', 'V003', 'V004', 'V005', 'V002'];
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const day = 150 + Math.floor(Math.random() * 241);
    const hour = 9 + Math.floor(Math.random() * 8);
    const minute = [0, 10, 20, 30, 40, 50][Math.floor(Math.random() * 6)];
    // 日本時間の hour:minute
    const base = new Date(Date.now() + day * 86400000);
    const ymd = new Date(base.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const start = new Date(ymd + 'T' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00+09:00').toISOString();
    const end = new Date(Date.parse(start) + 26 * 3600000).toISOString();
    const assetId = assets[Math.floor(Math.random() * assets.length)];
    const auth = opts.token ? { token: opts.token } : { service: true };
    const q = await api('/functions/v1/api/quote', Object.assign({ body: { assetId: assetId, start: start, end: end, optionIds: [] } }, auth));
    const r = await api('/functions/v1/api/reservations', Object.assign({
      allowError: true,
      body: {
        idempotencyKey: 'd2test_' + randomBytes(12).toString('hex'), assetId: assetId, start: start, end: end, optionIds: [],
        customer: { name: opts.name, kana: '', email: opts.email, phone: '090-1111-2222', company: '' },
        paymentMethod: 'onsite', licenseConfirmed: true, note: 'D2 テスト', expectedTotal: q.quote.total,
        consent: { documents: docs, agreedAt: new Date().toISOString() }
      }
    }, auth));
    if (r.status === 200 && r.json && r.json.ok) return r.json;
    lastErr = r;
    if (!(r.json && ['AVAILABILITY_CONFLICT', 'HANDOVER_CONFLICT', 'STAFF_UNAVAILABLE'].includes(r.json.code))) break;
  }
  throw new Error('予約を作れない: ' + JSON.stringify(lastErr && lastErr.json));
}

// テストが途中で失敗しても予約を「確定」のまま残さない (照会キー or 会員のトークンでキャンセル)
async function cleanupReservation(id, auth) {
  if (!id) return;
  try {
    const row = (await serviceSelect('reservations', 'select=status&id=eq.' + id))[0];
    if (!row || row.status !== 'confirmed') return;
    const opts = auth.accessToken ? { token: auth.accessToken } : {};
    const body = { id: id, token: auth.token || undefined };
    const lk = await api('/functions/v1/api/reservations/lookup', Object.assign({ allowError: true, body: body }, opts));
    const fee = lk.json && lk.json.cancellation ? lk.json.cancellation.fee : 0;
    await api('/functions/v1/api/reservations/cancel', Object.assign({ allowError: true, body: Object.assign({ expectedFee: fee }, body) }, opts));
  } catch (e) { /* 後片付けの失敗は無視 */ }
}

async function supabaseUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(LOCAL_API + '/functions/v1/api/', { signal: ctrl.signal, headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } });
    clearTimeout(t);
    const json = await res.json().catch(() => null);
    const mp = await fetch(MAILPIT + '/api/v1/messages?limit=1').then(r => r.ok, () => false);
    return !!(json && json.ok) && mp;
  } catch (e) { return false; }
}

describe('本番モード: mypage.html (ローカル Supabase + Edge Functions + Mailpit)', { skip: NO_JSDOM || (SUPABASE_UMD ? false : 'supabase-js が見つかりません') }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });

  test('会員登録 (画面) → 確認メールのリンクで戻る → 歓迎表示・同意の版を記録 → 同じリンクをもう一度開くと期限切れの案内', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions / Mailpit に接続できません');
    const email = 'd2-signup-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
    let userId = null;
    const page = openPage('mypage.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      assert.equal(page.window.SkyRentBackend.live, true);
      deq(currentView(page), ['auth']);
      assert.equal(page.$('#demo-hint').hidden, true, '本番でデモ会員の案内が出ている');
      const since = Date.now();
      fill(page, { '#r-name': '登録 次郎', '#r-kana': 'トウロク ジロウ', '#r-email': email, '#r-phone': '090-3333-4444', '#r-pass': 'Signup-2026x', '#r-pass2': 'Signup-2026x', '#r-privacy': true });
      submit(page, '#reg-form');
      await waitFor(() => visible(page, 'view-sent') || !page.$('#reg-error').hidden, 10000);
      assert.equal(page.$('#reg-error').hidden, true, text(page, '#reg-error'));
      deq(currentView(page), ['sent']);
      assert.match(text(page, '#view-sent'), new RegExp(email.replace(/[.+]/g, '\\$&') + ' 宛てに、メールアドレス確認のメール'));
      userId = await findUserId(email);
      assert.ok(userId, '会員の行が作られていない');
      const row = (await serviceSelect('members', 'select=*&user_id=eq.' + userId))[0];
      assert.equal(row.marketing_opt_in, false);
      deq(row.consent.documents, [{ id: 'privacy', version: '2026-08' }]);
      assert.equal(row.consent.marketing.optIn, false);
      assert.equal(row.name, '登録 次郎');
      deq(businessKeys(page.window.localStorage), [], '業務データが localStorage にある');

      const link = await mailLink(email, /メールアドレスのご確認/, since);
      const back = await followAuthLink(link);
      assert.match(back.location, /^http:\/\/127\.0\.0\.1:8901\/mypage\.html#/, '戻り先が mypage.html でない: ' + back.location.replace(/#.*/, '#...'));
      assert.match(back.hash, /access_token=.*type=signup/);

      const page2 = openPage('mypage.html' + back.hash, { mode: 'live' });
      try {
        assert.equal(await page2.ready(15000), true);
        await waitFor(() => visible(page2, 'view-member'), 5000);
        deq(currentView(page2), ['member']);
        assert.match(text(page2, '#view-member'), /メールアドレスの確認が完了し、会員登録が完了しました。ようこそ、登録 次郎 様/);
        assert.equal(page2.window.location.hash.indexOf('access_token'), -1, 'トークンが URL に残っている');
        assert.match(text(page2, '#view-member'), /ご予約はまだありません/);

        // プロフィール変更 (案内メールの受信を ON) → DB に届く
        fill(page2, { '#pf-company': '株式会社テスト', '#pf-marketing': true });
        submit(page2, '#pf-form');
        await waitFor(() => /登録情報を保存しました/.test(text(page2, '#view-member')), 8000);
        const row2 = (await serviceSelect('members', 'select=*&user_id=eq.' + userId))[0];
        assert.equal(row2.company, '株式会社テスト');
        assert.equal(row2.marketing_opt_in, true);

        page2.$('#logout-btn').click();
        await waitFor(() => visible(page2, 'view-auth'), 5000);
        assert.equal(await page2.window.SkyRentBackend.auth.session(), null);
        deq(page2.errors, []);
      } finally { page2.close(); }

      // 同じリンクをもう一度 → 期限切れのエラーで戻る → 案内画面
      const again = await followAuthLink(link);
      assert.match(again.hash, /error/);
      const page3 = openPage('mypage.html' + again.hash, { mode: 'live' });
      try {
        assert.equal(await page3.ready(15000), true);
        deq(currentView(page3), ['link']);
        assert.match(text(page3, '#link-msg'), /メールのリンクが無効か、有効期限が切れています/);
        assert.equal(page3.window.location.hash, '');
      } finally { page3.close(); }
    } finally {
      page.close();
      await deleteUser(userId || await findUserId(email).catch(() => null));
    }
  });

  test('パスワード再設定 (画面からメール送信) → リンクで戻ると新しいパスワードの画面 → 設定してログインできる', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions / Mailpit に接続できません');
    const m = await createMember({ name: '再設定 三郎' });
    try {
      const page = openPage('mypage.html', { mode: 'live' });
      const since = Date.now();
      try {
        assert.equal(await page.ready(15000), true);
        page.$('#to-reset').click();
        fill(page, { '#rs-email': m.email });
        submit(page, '#reset-form');
        await waitFor(() => visible(page, 'view-sent') || !page.$('#reset-error').hidden, 10000);
        assert.equal(page.$('#reset-error').hidden, true, text(page, '#reset-error'));
        assert.match(text(page, '#view-sent'), /パスワード再設定用のメールが届きます/);
      } finally { page.close(); }

      const link = await mailLink(m.email, /パスワード再設定/, since);
      const back = await followAuthLink(link);
      assert.match(back.hash, /type=recovery/);
      const page2 = openPage('mypage.html' + back.hash, { mode: 'live' });
      try {
        assert.equal(await page2.ready(15000), true);
        await waitFor(() => visible(page2, 'view-newpass'), 5000);
        assert.match(text(page2, '#np-title'), /新しいパスワードの設定/);
        fill(page2, { '#np-pass': 'weakpassword', '#np-pass2': 'weakpassword' });
        submit(page2, '#np-form');
        await waitFor(() => !page2.$('#np-error').hidden);
        assert.match(text(page2, '#np-error'), /英大文字/);
        fill(page2, { '#np-pass': 'Recovered-2026b', '#np-pass2': 'Recovered-2026b' });
        submit(page2, '#np-form');
        await waitFor(() => visible(page2, 'view-member'), 8000);
        assert.match(text(page2, '#view-member'), /パスワードを変更しました/);
        assert.match(text(page2, '#view-member'), /再設定 三郎 様/);
      } finally { page2.close(); }
      assert.ok(await signInToken(m.email, 'Recovered-2026b'), '新しいパスワードでログインできない');
    } finally {
      await deleteUser(m.userId);
    }
  });

  test('招待リンク (管理画面から会員を招待) → パスワード設定の画面 → 設定すると会員画面', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions / Mailpit に接続できません');
    const email = 'd2-invite-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
    let userId = null;
    try {
      const link = await api('/auth/v1/admin/generate_link', {
        service: true,
        body: { type: 'invite', email: email, data: { account_type: 'member', name: '招待 四郎' }, redirect_to: LIVE_ORIGIN + '/mypage.html' }
      });
      userId = link.id || (link.user && link.user.id) || await findUserId(email);
      const back = await followAuthLink(link.action_link || (link.properties && link.properties.action_link));
      assert.match(back.hash, /type=invite/);
      const page = openPage('mypage.html' + back.hash, { mode: 'live' });
      try {
        assert.equal(await page.ready(15000), true);
        await waitFor(() => visible(page, 'view-newpass'), 5000);
        assert.match(text(page, '#np-title'), /パスワードの設定/);
        assert.match(text(page, '#np-lead'), /ご招待ありがとうございます/);
        fill(page, { '#np-pass': 'Invited-2026c', '#np-pass2': 'Invited-2026c' });
        submit(page, '#np-form');
        await waitFor(() => visible(page, 'view-member'), 8000);
        assert.match(text(page, '#view-member'), /パスワードを設定しました/);
        assert.match(text(page, '#view-member'), /招待 四郎 様/);
      } finally { page.close(); }
      assert.ok(await signInToken(email, 'Invited-2026c'));
      userId = userId || await findUserId(email);
    } finally {
      await deleteUser(userId || await findUserId(email).catch(() => null));
    }
  });

  test('会員: ログイン → 予約一覧 → キャンセル料を確認してキャンセル (Edge Function) → 一覧が更新 → 退会', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions / Mailpit に接続できません');
    const m = await createMember({ name: '予約 五郎' });
    let id = null, token = null;
    try {
      token = await signInToken(m.email, m.password);
      const created = await createReservation({ token: token, name: '予約 五郎', email: m.email });
      id = created.reservation.id;
      const dbRow = (await serviceSelect('reservations', 'select=user_id,status&id=eq.' + id))[0];
      assert.equal(dbRow.user_id, m.userId, '会員の予約になっていない');

      const page = openPage('mypage.html', { mode: 'live' });
      try {
        assert.equal(await page.ready(15000), true);
        fill(page, { '#l-email': m.email, '#l-pass': 'wrong-Pass-1' });
        submit(page, '#login-form');
        await waitFor(() => !page.$('#login-error').hidden, 8000);
        assert.match(text(page, '#login-error'), /メールアドレスまたはパスワードが正しくありません/);
        fill(page, { '#l-pass': m.password });
        submit(page, '#login-form');
        await waitFor(() => visible(page, 'view-member'), 8000);
        const btn = await waitFor(() => page.$('[data-res="' + id + '"]'), 3000);
        assert.ok(btn, '予約一覧に出ていない');
        assert.equal(btn.textContent, '詳細・キャンセル');
        btn.click();
        await waitFor(() => page.$('#mp-modal-body [data-cancel-open]'), 8000);
        const body = text(page, '#mp-modal-body');
        assert.match(body, /いまキャンセルした場合のキャンセル料: ¥0/);
        assert.match(body, /北海道/, '店舗の住所が出ない');
        page.$('#mp-modal-body [data-cancel-open]').click();
        page.$('#mp-modal-body [data-cancel-go]').click();
        await waitFor(() => /キャンセルが完了しました|mp-msg err/.test(page.$('#mp-modal-body').innerHTML) && !/キャンセルしています/.test(text(page, '#mp-modal-body')), 15000);
        assert.match(text(page, '#mp-modal-body'), /キャンセルが完了しました。キャンセル料: ¥0/);
        const after = (await serviceSelect('reservations', 'select=status,cancel_fee,cancelled_by&id=eq.' + id))[0];
        assert.equal(after.status, 'cancelled');
        assert.equal(after.cancel_fee, 0);
        page.$('#mp-modal-close').click();
        await waitFor(() => page.$('[data-res="' + id + '"]') && page.$('[data-res="' + id + '"]').textContent === '詳細', 8000);
        // キャンセル API に会員のトークンで送り、照会キーは送っていない
        const cancelReq = page.requests.find(r => /\/functions\/v1\/api\/reservations\/cancel$/.test(r.url));
        assert.ok(cancelReq);
        assert.equal(cancelReq.body.id, id);
        assert.equal(cancelReq.body.expectedFee, 0);
        assert.equal(cancelReq.body.token, undefined);

        // 退会
        fill(page, { '#close-confirm': true });
        submit(page, '#close-form');
        await waitFor(() => visible(page, 'view-auth') || !page.$('#close-msg').hidden, 10000);
        assert.equal(page.$('#close-msg') ? page.$('#close-msg').hidden : true, true, text(page, '#close-msg'));
        assert.match(text(page, '#page-msg'), /退会の手続きが完了しました/);
        const closed = (await serviceSelect('members', 'select=status,email,name&user_id=eq.' + m.userId))[0];
        assert.equal(closed.status, 'closed');
        assert.equal(closed.email, '');
        const login = await api('/auth/v1/token?grant_type=password', { allowError: true, body: { email: m.email, password: m.password } });
        assert.notEqual(login.status, 200, '退会後もログインできる');
        deq(businessKeys(page.window.localStorage), [], '業務データが localStorage にある');
        deq(page.errors, []);
      } finally { page.close(); }
    } finally {
      await cleanupReservation(id, { accessToken: token });
      await deleteUser(m.userId);
    }
  });

  test('ゲスト照会: 照会URL (#lookup=) でログインなしに表示 → キャンセル → 照会キーは # 以降と POST 本文だけ', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions / Mailpit に接続できません');
    const created = await createReservation({ name: 'ゲスト 六郎', email: 'd2-guest-' + Date.now() + '@example.com' });
    const id = created.reservation.id;
    assert.match(created.lookupUrl, /mypage\.html#lookup=R\d+\./);
    const hash = created.lookupUrl.slice(created.lookupUrl.indexOf('#'));
    const token = hash.slice(hash.indexOf('.') + 1);
    const page = openPage('mypage.html' + hash, { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      await waitFor(() => page.$('#lookup-body [data-cancel-open]') || /mp-msg err/.test(page.$('#lookup-body').innerHTML), 10000);
      deq(currentView(page), ['lookup']);
      const body = text(page, '#lookup-body');
      assert.match(body, new RegExp(id));
      assert.match(body, /ゲスト 六郎 様/);
      assert.match(body, /合計 \(税込\)\s*¥[\d,]+/);
      page.$('#lookup-body [data-cancel-open]').click();
      page.$('#lookup-body [data-cancel-go]').click();
      await waitFor(() => /キャンセルが完了しました|mp-msg err/.test(page.$('#lookup-body [data-result]') ? page.$('#lookup-body').innerHTML : ''), 15000);
      assert.match(text(page, '#lookup-body'), /キャンセルが完了しました/);
      assert.match(text(page, '#lookup-body'), /キャンセルの確認メールをお送りしました|確認メールは、まもなく|確認メールをお送りできませんでした/);
      const after = (await serviceSelect('reservations', 'select=status,cancelled_by&id=eq.' + id))[0];
      assert.equal(after.status, 'cancelled');
      // 照会キーは URL のクエリに出さず、POST の本文で送る
      const fnReqs = page.requests.filter(r => r.url.indexOf('/functions/v1/') >= 0);
      assert.ok(fnReqs.length >= 2);
      fnReqs.forEach(r => assert.equal(r.url.indexOf(token), -1, '照会キーが URL に入っている'));
      assert.equal(fnReqs.find(r => /lookup$/.test(r.url)).body.token, token);
      deq(businessKeys(page.window.localStorage), [], '業務データが localStorage にある');
      deq(page.errors, []);

      // もう一度開くとキャンセル済みの表示 (キャンセルボタンなし)
      const page2 = openPage('mypage.html' + hash, { mode: 'live' });
      try {
        assert.equal(await page2.ready(15000), true);
        await waitFor(() => /キャンセル済み|mp-msg err/.test(page2.$('#lookup-body').innerHTML), 10000);
        assert.match(text(page2, '#lookup-body'), /このご予約はキャンセル済みです/);
        assert.equal(page2.$('#lookup-body [data-cancel-open]'), null);
      } finally { page2.close(); }
    } finally {
      page.close();
      await cleanupReservation(id, { token: token });
    }
  });
});

describe('本番モード: contact.html (ローカル Supabase + Edge Functions)', { skip: NO_JSDOM || (SUPABASE_UMD ? false : 'supabase-js が見つかりません') }, () => {
  let up = false;
  before(async () => { up = await supabaseUp(); });

  test('送信 → submit_inquiry_tx に届き、受付番号を表示 (同意の版・冪等キー) / ハニーポットは保存しない', async t => {
    if (!up) return t.skip('ローカル Supabase / Edge Functions に接続できません');
    const email = 'd2-inquiry-' + Date.now() + '-' + randomBytes(3).toString('hex') + '@example.com';
    const page = openPage('contact.html', { mode: 'live' });
    try {
      assert.equal(await page.ready(15000), true);
      assert.match(text(page, '#cf-agree-label'), /プライバシーポリシー \(2026-08版\)/);
      fill(page, { '#cf-name': '問合 七郎', '#cf-email': email, '#cf-tel': '011-222-3333', '#cf-topic': 'その他', '#cf-body': 'D2 のテストです。返信は不要です。', '#cf-agree': true });
      submit(page, '#ct-form');
      assert.equal(page.$('#cf-submit').disabled, true);
      await waitFor(() => page.$('#ct-done').classList.contains('on') || page.$('#cf-err').classList.contains('on'), 15000);
      assert.equal(page.$('#cf-err').classList.contains('on'), false, text(page, '#cf-err'));
      const ref = text(page, '#ct-ref').replace('受付番号: ', '');
      assert.match(ref, /^C\d+/);
      const rows = await serviceSelect('inquiries', 'select=id,email,topic,consent,idempotency_key&email=eq.' + encodeURIComponent(email));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, ref);
      deq(rows[0].consent.documents, [{ id: 'privacy', version: '2026-08' }]);
      const req = page.requests.find(r => /\/functions\/v1\/api\/inquiries$/.test(r.url));
      assert.equal(rows[0].idempotency_key, req.body.idempotencyKey);
      assert.equal(req.body.website, '');
      assert.match(text(page, '#ct-mail'), /受付確認のメール/);
      deq(businessKeys(page.window.localStorage), [], '業務データが localStorage にある');
      deq(page.errors, []);
    } finally { page.close(); }

    const botEmail = 'd2-bot-' + Date.now() + '@example.com';
    const page2 = openPage('contact.html', { mode: 'live' });
    try {
      assert.equal(await page2.ready(15000), true);
      fill(page2, { '#cf-name': 'bot', '#cf-email': botEmail, '#cf-topic': 'その他', '#cf-body': 'spam spam spam', '#cf-agree': true, '#cf-website': 'http://spam.example' });
      submit(page2, '#ct-form');
      await waitFor(() => page2.$('#ct-done').classList.contains('on') || page2.$('#cf-err').classList.contains('on'), 15000);
      assert.equal(page2.$('#ct-done').classList.contains('on'), true);
      const rows = await serviceSelect('inquiries', 'select=id&email=eq.' + encodeURIComponent(botEmail));
      deq(rows, [], 'ハニーポットに入力があるのに保存された');
    } finally { page2.close(); }
  });
});
