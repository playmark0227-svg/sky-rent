/**
 * グロースレンタカー - バックエンド接続 (window.SkyRentBackend)
 *
 * デモモード (js/config.js の SUPABASE_URL が空):
 *   各メソッドは SkyRentStore (localStorage) の同等処理で動き、本番と同じ形の Promise を返す。
 * 本番モード (SUPABASE_URL と SUPABASE_ANON_KEY あり):
 *   supabase-js を CDN から読み込み、
 *     - init({area}) でサーバーのデータを読み込んで SkyRentStore に入れる (メモリのみ)
 *     - 予約・見積・問い合わせ・空き状況は Edge Function (api) を呼ぶ
 *     - 管理画面では画面からの書き込みを DB へ反映する (書込フック・ドメイン関数の差し替え)
 *
 * DB 行 ⇔ 画面用の旧形式 (store) の変換は fromDb / toDb にまとめている (契約書 §4.5 の対応表)。
 */
(function () {
  'use strict';

  const CONFIG = window.SKY_RENT_CONFIG || {};
  const S = window.SkyRentStore;
  const LIVE = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
  const SUPABASE_URL = String(CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
  const ANON_KEY = String(CONFIG.SUPABASE_ANON_KEY || '');
  const FUNCTIONS_URL = String(CONFIG.FUNCTIONS_URL || (SUPABASE_URL ? SUPABASE_URL + '/functions/v1' : '')).replace(/\/+$/, '');
  const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
  // CDN の配信内容が改ざんされていたら読み込ませない (Subresource Integrity)。版を上げたらハッシュも更新する:
  //   curl -sL <URL> | openssl dgst -sha384 -binary | openssl base64 -A
  const SUPABASE_JS_SRI = 'sha384-xPW3QHswsICVC2mW6BFNwMbhpLkbZ133fKOhxNx3QGGgAOJfL3O9t8r2aWn1aez6';
  const REQUEST_TIMEOUT_MS = 20000;
  const MIN = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;
  const JST_OFFSET = 9 * HOUR;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ===================================================================
  // エラー
  // ===================================================================
  const MESSAGES = {
    VALIDATION: '入力内容に不備があります。表示された項目をご確認ください。',
    CONSENT_REQUIRED: '規約などへの同意が必要です。最新の内容をご確認のうえ、同意の欄にチェックしてください。',
    UNAUTHENTICATED: 'ログインが必要です。ログインしてから、もう一度お試しください。',
    FORBIDDEN: 'この操作を行う権限がありません。必要な場合は管理者にお問い合わせください。',
    INVOICE_NOT_ALLOWED: '請求書払いはご利用いただけません。お支払い方法を「当日店頭でのお支払い」に変更してください。',
    NOT_FOUND: 'お探しの情報が見つかりませんでした。予約番号などをご確認ください。',
    AVAILABILITY_CONFLICT: '申し訳ありません。ご希望の期間は他のご予約と重なっているため予約できません。日時または車両を変更してください。',
    STAFF_UNAVAILABLE: 'ご希望の時間は受け渡し担当者の予定が埋まっています。別の日時をお選びください。',
    HANDOVER_CONFLICT: 'ご希望の時間は同じ店舗で別のお客様の受け渡しがあります。時間を少しずらしてお選びください。',
    PRICE_CHANGED: '料金が変わりました。新しい金額をご確認のうえ、もう一度確定してください。',
    CONFLICT: '他の操作と重なったため処理できませんでした。画面を再読み込みして最新の内容をご確認のうえ、もう一度お試しください。',
    COUPON_INVALID: 'このクーポンはご利用いただけません (使用済み・期限切れなど)。クーポンを外して、もう一度お試しください。',
    NOT_CANCELLABLE: 'このご予約はWebではキャンセルできません (貸出開始後・キャンセル済みなど)。お手数ですが公式LINEまたはお問い合わせフォームからご連絡ください。',
    IDEMPOTENCY_KEY_REUSED: '同じ操作が別の内容で送信されました。画面を再読み込みして、最初からやり直してください。',
    IDEMPOTENCY_KEY_REQUIRED: '送信内容を確認できませんでした。画面を再読み込みして、もう一度お試しください。',
    RATE_LIMITED: '短時間に操作が集中したため、受付を一時的に止めています。しばらく待ってから、もう一度お試しください。',
    PAYLOAD_TOO_LARGE: '送信する内容が大きすぎます。文章を短くして、もう一度お試しください。',
    CALENDAR_UNAVAILABLE: '担当者の予定を確認できないため、ただいまWeb予約を受け付けられません。時間をおいてお試しいただくか、公式LINEまたはお問い合わせフォームからご相談ください。',
    INTERNAL: 'システムでエラーが発生しました。時間をおいて、もう一度お試しください。',
    NETWORK: 'サーバーに接続できませんでした。通信環境をご確認のうえ、もう一度お試しください。',
    TIMEOUT: 'サーバーからの応答がありませんでした。通信環境をご確認のうえ、もう一度お試しください。',
    DEMO_MODE: 'デモ環境ではこの機能は使えません。本番環境 (サーバー接続時) でご利用いただけます。',
    VERSION_CONFLICT: '他のスタッフが先にこのデータを更新しました。画面を再読み込みして、最新の内容を確認してください。',
    INVALID_TRANSITION: 'この予約は、選択した状態には変更できません。現在の状態をご確認ください。',
    INVALID_PERIOD: '貸出日時と返却日時をご確認ください (返却は貸出より後の日時にしてください)。',
    START_IN_PAST: '過去の日時は予約できません。貸出日時をご確認ください。',
    PERIOD_TOO_LONG: 'Webで予約できる期間は最長93日です。それより長いご利用は公式LINEまたはお問い合わせフォームからご相談ください。',
    START_TOO_FAR: 'ご予約は400日先まで受け付けています。貸出日をご確認ください。',
    ASSET_UNAVAILABLE: 'この車両は現在ご予約いただけません。別の車両をお選びください。',
    INVALID_ASSET: 'この車両は料金が設定されていないため、Webではご予約いただけません。別の車両をお選びいただくか、公式LINEまたはお問い合わせフォームからお問い合わせください。',
    OPTION_INVALID: '選択されたオプションはこの車両ではご利用いただけません。オプションを選び直してください。',
    OPTION_NOT_APPLICABLE: '選択されたオプションはこの車両ではご利用いただけません。オプションを選び直してください。',
    OPTION_CONFLICT: '同時に選べない補償が選ばれています。どちらか1つにしてください。',
    DISCOUNT_NOT_APPLICABLE: '選択された割引はこのご予約には適用できません (利用時間・車種の条件をご確認ください)。',
    MEMBER_NOT_ACTIVE: '会員情報を確認できませんでした。ログインし直してから、もう一度お試しください。',
    LAST_ADMIN: '最後の管理者は無効化・役割変更できません。先に別の管理者を追加してください。',
    INVALID_DELTA: '増減するポイント数と理由を入力してください (1回の調整は±100ポイントまで)。',
    INVALID_AMOUNT: '金額が正しくありません。1円〜100,000円の範囲で入力してください。',
    NO_RESERVATIONS: '請求対象の予約を選択してください。',
    RESERVATIONS_NOT_INVOICEABLE: '選択した予約の中に、この会員のものではない・請求済み・キャンセル済みの予約があります。選択を見直してください。',
    INVALID_STATUS: '状態の指定が正しくありません。',
    INVALID_RANGE: '期間の指定が正しくありません。',
    RANGE_TOO_LONG: '指定された期間が長すぎます。期間を短くしてください。',
    FOREIGN_KEY: 'この項目は予約などで使われているため削除できません。無効にしてください。',
    INVALID_CREDENTIALS: 'メールアドレスまたはパスワードが正しくありません。入力内容をご確認ください。',
    EMAIL_NOT_CONFIRMED: 'メールアドレスの確認が済んでいません。登録時にお送りしたメールのリンクを開いてから、ログインしてください。',
    EMAIL_TAKEN: 'このメールアドレスは既に登録されています。ログインするか、パスワード再設定をご利用ください。',
    WEAK_PASSWORD: '8文字以上で、英大文字・英小文字・数字をそれぞれ1文字以上含めてください。',
    SAME_PASSWORD: '新しいパスワードが現在のものと同じです。別のパスワードを入力してください。',
    MFA_INVALID: '確認コードが正しくないか、有効期限が切れています。認証アプリに表示されている最新の6桁を入力してください。',
    MFA_REQUIRED: '二段階認証が必要です。ログイン画面から確認コードを入力してください。',
    NOT_MEMBER: '会員情報が見つかりませんでした。会員登録がお済みでない場合は、新規登録をお願いします。',
    NOT_STAFF: 'このアカウントは管理画面を利用できません。スタッフとして登録されているか、管理者にご確認ください。',
    LINK_INVALID: 'メールのリンクが無効か、有効期限が切れています。お手数ですが、もう一度メールの送信からやり直してください。',
    OFFLINE_SAVE: 'サーバーに接続できないため保存できません。通信環境をご確認のうえ、画面を再読み込みしてください。'
  };

  function errorMessage(code) {
    return MESSAGES[code] || MESSAGES.INTERNAL;
  }

  // サーバー (Edge Function) がエラーに同梱する項目。Error にそのまま載せる
  //   fields: 入力不備の項目 / quote: 新しい見積 (PRICE_CHANGED) / cancellation: キャンセル料 (PRICE_CHANGED・NOT_CANCELLABLE)
  //   documents・missing: 同意が必要な文書と、足りない文書の id (CONSENT_REQUIRED)
  const ERROR_EXTRA_KEYS = ['fields', 'quote', 'cancellation', 'documents', 'missing', 'status', 'requestId', 'detail'];

  function makeError(code, message, extra) {
    const c = code || 'INTERNAL';
    const e = new Error(message || errorMessage(c));
    e.code = c;
    Object.defineProperty(e, '_skyrent', { value: true });
    if (extra) {
      ERROR_EXTRA_KEYS.forEach(k => {
        if (extra[k] !== undefined && extra[k] !== null) e[k] = extra[k];
      });
    }
    return e;
  }

  const AUTH_CODES = {
    invalid_credentials: 'INVALID_CREDENTIALS', email_not_confirmed: 'EMAIL_NOT_CONFIRMED',
    user_already_exists: 'EMAIL_TAKEN', email_exists: 'EMAIL_TAKEN',
    weak_password: 'WEAK_PASSWORD', same_password: 'SAME_PASSWORD',
    over_email_send_rate_limit: 'RATE_LIMITED', over_request_rate_limit: 'RATE_LIMITED', over_sms_send_rate_limit: 'RATE_LIMITED',
    email_address_invalid: 'VALIDATION', validation_failed: 'VALIDATION',
    signup_disabled: 'FORBIDDEN', user_banned: 'FORBIDDEN',
    mfa_verification_failed: 'MFA_INVALID', mfa_challenge_expired: 'MFA_INVALID',
    mfa_factor_not_found: 'MFA_INVALID', mfa_verification_rejected: 'MFA_INVALID',
    insufficient_aal: 'MFA_REQUIRED',
    session_not_found: 'UNAUTHENTICATED', session_expired: 'UNAUTHENTICATED', refresh_token_not_found: 'UNAUTHENTICATED',
    refresh_token_already_used: 'UNAUTHENTICATED', bad_jwt: 'UNAUTHENTICATED', no_authorization: 'UNAUTHENTICATED',
    reauthentication_needed: 'UNAUTHENTICATED', user_not_found: 'UNAUTHENTICATED'
  };

  // supabase-js / PostgREST / Auth のエラー → {code, message(日本語)} の Error
  function toError(err) {
    if (!err) return makeError('INTERNAL');
    // makeError / call() で作った Error はそのまま
    if (err._skyrent) return err;
    const msg = String(err.message || '');
    // DB の RPC は message にコード文字列を入れて raise する (public.fail)
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(msg)) return makeError(msg, null, { detail: err.details || err.detail });
    if (err.name === 'AbortError' || /aborted|timeout/i.test(msg)) return makeError('TIMEOUT');
    if (AUTH_CODES[err.code]) return makeError(AUTH_CODES[err.code]);
    if (/Invalid login credentials/i.test(msg)) return makeError('INVALID_CREDENTIALS');
    if (/Email not confirmed/i.test(msg)) return makeError('EMAIL_NOT_CONFIRMED');
    if (/already (been )?registered|already exists/i.test(msg)) return makeError('EMAIL_TAKEN');
    if (/Password should/i.test(msg)) return makeError('WEAK_PASSWORD');
    if (err.code === '42501' || /permission denied|row-level security/i.test(msg)) return makeError('FORBIDDEN');
    if (err.code === 'PGRST301' || err.code === 'PGRST302' || /JWT/.test(msg)) return makeError('UNAUTHENTICATED');
    // 外部キー違反 (予約などから参照されている行の削除)
    if (err.code === '23503') return makeError('FOREIGN_KEY');
    // 排他制約 (期間の重なり)
    if (err.code === '23P01') return makeError('AVAILABILITY_CONFLICT');
    if (/^23/.test(String(err.code || ''))) return makeError('VALIDATION');
    if (err.name === 'TypeError' || /Failed to fetch|NetworkError|fetch failed|Load failed|network/i.test(msg)) return makeError('NETWORK');
    if (err.status === 429) return makeError('RATE_LIMITED');
    return makeError('INTERNAL');
  }

  // ===================================================================
  // 通知 (トースト)
  // ===================================================================
  function toast(msg, type) {
    const kind = ['success', 'error', 'warn', 'info'].indexOf(type) >= 0 ? type : 'info';
    const show = () => {
      let box = document.getElementById('skyrent-toasts');
      if (!box) {
        box = document.createElement('div');
        box.id = 'skyrent-toasts';
        box.className = 'skyrent-toasts';
        box.setAttribute('aria-live', 'polite');
        document.body.appendChild(box);
      }
      const el = document.createElement('div');
      el.className = 'skyrent-toast skyrent-toast--' + kind;
      el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      el.textContent = String(msg == null ? '' : msg);
      box.appendChild(el);
      const ms = kind === 'error' ? 6000 : (kind === 'warn' ? 5000 : 3500);
      setTimeout(() => {
        el.classList.add('is-leaving');
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
      }, ms);
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
  }

  // ===================================================================
  // 小物
  // ===================================================================
  function nowIso() { return new Date().toISOString(); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => x === undefined ? 'null' : stableStringify(x)).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function same(a, b) { return stableStringify(a) === stableStringify(b); }
  function randomToken(bytes) {
    const arr = new Uint8Array(bytes || 16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(arr);
    else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    let s = '';
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // 公開サイトのページ URL (管理画面からは 1 階層上)
  function siteUrl(path) {
    const inManage = /\/manage\//.test(location.pathname);
    try { return new URL((inManage ? '../' : '') + path, location.href).href; } catch (e) { return path; }
  }

  // ===================================================================
  // 日時 (日本時間)
  //   画面の <input type="datetime-local"> の値 ('YYYY-MM-DDTHH:MM'。タイムゾーン表記なし) は、
  //   端末のタイムゾーンに関係なく常に日本時間として扱う (貸出・返却は北海道の店舗で行うため)。
  //   解釈は料金計算と同じ SkyRentPricingCore.toMs に任せる。new Date(文字列) / Date.parse は
  //   タイムゾーン表記の無い文字列を端末の時刻で解釈するので使わない。
  // ===================================================================
  const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const DATE_TEXT_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 日時 (ISO 文字列 / 'YYYY-MM-DDTHH:MM' / 'YYYY/M/D H:MM' / Date / ミリ秒) → エポックミリ秒。不正なら NaN
  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string') return NaN;
    const s = v.trim();
    const m = DATE_TEXT_RE.exec(s);
    if (m) {
      // ISO 8601 の形にそろえる (区切りの '/'・1桁の月日時)
      const time = m[4] ? 'T' + pad2(+m[4]) + ':' + m[5] + (m[6] ? ':' + m[6] + (m[7] ? '.' + m[7] : '') : '') : '';
      const iso = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) + time + (m[8] || '');
      const core = window.SkyRentPricingCore;
      if (core && typeof core.toMs === 'function') return core.toMs(iso);
      // 料金エンジンが無いときの代替 (タイムゾーン表記なし = 日本時間)
      if (m[8]) return time ? Date.parse(iso) : NaN;
      return Date.parse(iso + (time ? '' : 'T00:00') + '+09:00');
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
    // ISO 以外 (Date#toString などタイムゾーン付きの文字列)
    return s ? Date.parse(s) : NaN;
  }
  function toIso(v) {
    const t = toMs(v);
    if (!isFinite(t)) throw makeError('VALIDATION', '日時の形式が正しくありません。');
    return new Date(t).toISOString();
  }
  // 解釈できれば ISO、できなければ元の値
  function isoOr(v) {
    const t = toMs(v);
    return isFinite(t) ? new Date(t).toISOString() : v;
  }
  // 'YYYY-MM-DD' (JST)
  function jstDate(v) {
    if (v == null || v === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
    const t = toMs(v);
    if (!isFinite(t)) return null;
    return new Date(t + JST_OFFSET).toISOString().slice(0, 10);
  }
  // t (ミリ秒) を含む日本時間の暦日 [0:00, 翌0:00)
  function jstDayRange(t) {
    const start = Math.floor((t + JST_OFFSET) / DAY) * DAY - JST_OFFSET;
    return [start, start + DAY];
  }

  // 画面向け (SkyRentBackend.jst)
  const jst = {
    // datetime-local の値 (日本時間) → ISO (UTC)。解釈できなければ null
    fromInput(v) {
      const t = toMs(v);
      return isFinite(t) ? new Date(t).toISOString() : null;
    },
    // ISO など → datetime-local に入れる値 'YYYY-MM-DDTHH:MM' (日本時間)。解釈できなければ ''
    toInput(v) {
      const t = toMs(v);
      return isFinite(t) ? new Date(t + JST_OFFSET).toISOString().slice(0, 16) : '';
    },
    // 表示用 '2026/10/01(木) 10:00' (日本時間)。opts: {time:false} 日付だけ / {weekday:false} 曜日なし / {year:false} 年なし
    format(v, opts) {
      opts = opts || {};
      const t = toMs(v);
      if (!isFinite(t)) return '';
      const d = new Date(t + JST_OFFSET);
      let s = (opts.year === false ? '' : d.getUTCFullYear() + '/') + pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate());
      if (opts.weekday !== false) s += '(' + WEEKDAYS_JA[d.getUTCDay()] + ')';
      if (opts.time !== false) s += ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
      return s;
    },
    // 日本時間の日付 'YYYY-MM-DD'。解釈できなければ ''
    ymd(v) { return jstDate(v) || ''; }
  };

  // ===================================================================
  // DB 行 ⇔ 画面用の旧形式 (store)
  // ===================================================================
  // [storeのキー, DBの列, 型]  型: int / date / bool / textArray / (なし = そのまま)
  const CATALOG_MAPS = {
    category: {
      idKey: 'categoryId',
      cols: [['categoryId', 'id'], ['name', 'name'], ['nameEn', 'name_en'], ['type', 'type'], ['icon', 'icon'],
             ['description', 'description'], ['sort', 'sort', 'int'], ['active', 'active', 'bool'],
             ['customFieldDefs', 'custom_field_defs']]
    },
    location: {
      idKey: 'locationId',
      cols: [['locationId', 'id'], ['name', 'name'], ['nameEn', 'name_en'], ['tel', 'tel'], ['address', 'address'],
             ['hours', 'hours'], ['holiday', 'holiday'], ['sort', 'sort', 'int'], ['active', 'active', 'bool']]
    },
    asset: {
      idKey: 'assetId',
      cols: [['assetId', 'id'], ['categoryId', 'category_id'], ['locationId', 'location_id'], ['name', 'name'],
             ['nameEn', 'name_en'], ['plate', 'plate'], ['capacity', 'capacity', 'int'], ['priceHour', 'price_hour', 'int'],
             ['priceDay', 'price_day', 'int'], ['priceWeek', 'price_week', 'int'], ['priceMonth', 'price_month', 'int'],
             ['stock', 'stock', 'int'], ['requiredLicense', 'required_license'], ['image', 'image'], ['photo', 'photo'],
             ['active', 'active', 'bool'], ['shakenDate', 'shaken_date', 'date'], ['maintenanceDate', 'maintenance_date', 'date'],
             ['customFields', 'custom_fields'], ['sort', 'sort', 'int']]
    },
    option: {
      // description などの列に無い項目は extra に入る (extra.description)
      idKey: 'optionId',
      cols: [['optionId', 'id'], ['name', 'name'], ['price', 'price', 'int'], ['priceShort', 'price_short', 'int'],
             ['priceType', 'price_type'], ['categoryIds', 'category_ids', 'textArray'], ['kind', 'kind'],
             ['exclusiveGroup', 'exclusive_group'], ['active', 'active', 'bool'], ['sort', 'sort', 'int']]
    }
  };
  // 旧画面 (api.js) が付け足す派生項目。DB へは送らない
  const DERIVED_KEYS = ['vehicleId', 'class', 'categoryName', 'categoryType', 'pricePerDay', 'availability'];

  function normalize(v, type) {
    if (type === 'int') {
      if (v === '' || v == null) return null;
      const n = Number(v);
      return isFinite(n) ? Math.round(n) : null;
    }
    if (type === 'date') return jstDate(v);
    if (type === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
    if (type === 'textArray') {
      if (v == null || v === '') return null;
      if (Array.isArray(v)) return v.map(String);
      return String(v).split(',').map(s => s.trim()).filter(Boolean);
    }
    return v === undefined ? null : v;
  }

  function catalogFromDb(map, row) {
    const obj = {};
    if (!row) return obj;
    map.cols.forEach(c => { if (hasOwn(row, c[1])) obj[c[0]] = row[c[1]]; });
    // extra は展開して上書き (ID は上書きしない)
    if (row.extra && typeof row.extra === 'object' && !Array.isArray(row.extra)) {
      Object.keys(row.extra).forEach(k => { if (k !== map.idKey) obj[k] = row.extra[k]; });
    }
    return obj;
  }
  function catalogToDb(map, obj) {
    const row = {};
    const known = {};
    map.cols.forEach(c => {
      known[c[0]] = true;
      if (hasOwn(obj, c[0])) row[c[1]] = normalize(obj[c[0]], c[2]);
    });
    const extra = {};
    Object.keys(obj).forEach(k => {
      if (known[k] || k.charAt(0) === '_' || DERIVED_KEYS.indexOf(k) >= 0 || obj[k] === undefined) return;
      extra[k] = obj[k];
    });
    row.extra = extra;
    return row;
  }

  // 会員番号 (M00001) ⇔ user_id の対応 (store の members から引く)
  function memberNoOfUser(userId) {
    if (!userId) return null;
    const m = S.list('members').find(x => x.userId === userId);
    return m ? m.memberId : null;
  }

  const fromDb = {
    category: row => catalogFromDb(CATALOG_MAPS.category, row),
    location: row => catalogFromDb(CATALOG_MAPS.location, row),
    asset: row => catalogFromDb(CATALOG_MAPS.asset, row),
    option: row => catalogFromDb(CATALOG_MAPS.option, row),

    // ctx: {asset(id) -> asset, memberNo(userId) -> 'M00001'}
    reservation(row, ctx) {
      ctx = ctx || {};
      const asset = ctx.asset ? ctx.asset(row.asset_id) : S.getAsset(row.asset_id);
      const memberNo = ctx.memberNo ? ctx.memberNo(row.user_id) : memberNoOfUser(row.user_id);
      const total = row.total != null ? row.total : ((row.price && row.price.total) || 0);
      const price = row.price && typeof row.price === 'object' && !Array.isArray(row.price) ? clone(row.price) : {};
      if (price.total == null) price.total = total;
      const assetName = asset ? asset.name : '';
      return {
        reservationId: row.id, kind: row.kind || 'rental',
        assetId: row.asset_id, vehicleId: row.asset_id, assetName: assetName, vehicleName: assetName,
        categoryId: row.category_id, locationId: row.location_id, quantity: 1,
        customerName: row.customer_name, customerKana: row.customer_kana,
        customerEmail: row.customer_email, customerPhone: row.customer_phone, company: row.company,
        memberId: memberNo || null, userId: row.user_id || null,
        start: row.start_at, end: row.end_at,
        optionIds: row.option_ids || [], options: row.options || [],
        payment: { method: row.payment_method, status: row.payment_status },
        price: price, total: total,
        discountType: row.discount_type == null ? null : row.discount_type,
        couponId: row.coupon_id == null ? null : row.coupon_id,
        status: row.status, pointGranted: !!row.point_granted,
        invoiceId: row.invoice_id == null ? null : row.invoice_id,
        note: row.note, staffNote: row.staff_note,
        cancelFee: row.cancel_fee == null ? null : row.cancel_fee,
        cancelledAt: row.cancelled_at == null ? null : row.cancelled_at,
        cancelledBy: row.cancelled_by == null ? null : row.cancelled_by,
        licenseConfirmed: !!row.license_confirmed, createdAt: row.created_at, version: row.version,
        gcalEvents: row.gcal_events || {}
      };
    },

    coupon(row) {
      return {
        couponId: row.id, amount: row.amount, reason: row.reason, issuedAt: row.issued_at,
        expiresAt: row.expires_at == null ? null : row.expires_at,
        usedAt: row.used_at == null ? null : row.used_at,
        usedFor: row.used_reservation_id == null ? null : row.used_reservation_id
      };
    },

    ledger(row) {
      return {
        id: row.id, at: row.created_at, delta: row.delta, reason: row.reason,
        reservationId: row.reservation_id == null ? null : row.reservation_id
      };
    },

    // x: {points, coupons:[行], ledger:[行]}
    member(row, x) {
      x = x || {};
      return {
        memberId: row.member_no, userId: row.user_id, name: row.name, nameKana: row.name_kana,
        email: row.email, phone: row.phone, company: row.company,
        isCorporate: !!row.is_corporate, invoiceAllowed: !!row.invoice_allowed, marketingOptIn: !!row.marketing_opt_in,
        status: row.status, points: Number(x.points) || 0,
        coupons: (x.coupons || []).map(fromDb.coupon),
        pointHistory: (x.ledger || []).map(fromDb.ledger),
        createdAt: row.created_at, lastUseAt: row.last_use_at == null ? null : row.last_use_at
      };
    },

    invoice(row, ctx) {
      ctx = ctx || {};
      const memberNo = ctx.memberNo ? ctx.memberNo(row.user_id) : memberNoOfUser(row.user_id);
      return {
        invoiceId: row.id, memberId: memberNo || null, userId: row.user_id,
        company: row.company, address: row.address, caseName: row.case_name,
        reservationIds: row.reservation_ids || [], amount: row.amount, status: row.status,
        issuedAt: row.issued_at, dueDate: row.due_date == null ? null : row.due_date,
        paidAt: row.paid_at == null ? null : row.paid_at
      };
    },

    inquiry(row) {
      return {
        inquiryId: row.id, name: row.name, company: row.company, email: row.email, tel: row.tel,
        topic: row.topic, body: row.body, reservationId: row.reservation_id == null ? null : row.reservation_id,
        status: row.status, staffNote: row.staff_note, createdAt: row.created_at,
        userId: row.user_id == null ? null : row.user_id,
        assignedTo: row.assigned_to == null ? null : row.assigned_to
      };
    },

    setting(row) { return ['settings.' + row.key, row.value]; },

    activity(row) { return { at: row.at, type: row.type, message: row.message, refId: row.ref_id == null ? null : row.ref_id }; },

    staff(row) {
      return {
        userId: row.user_id, name: row.name, email: row.email, role: row.role,
        locationIds: row.location_ids == null ? null : row.location_ids, active: row.active !== false,
        perms: permsOf(row.role)
      };
    },

    // public_catalog の結果 → _hydrate に渡す形
    catalog(cat) {
      cat = cat || {};
      const out = {
        categories: (cat.categories || []).map(fromDb.category),
        locations: (cat.locations || []).map(fromDb.location),
        assets: (cat.assets || []).map(fromDb.asset),
        options: (cat.options || []).map(fromDb.option),
        legal: cat.legal || []
      };
      const settings = cat.settings || {};
      Object.keys(settings).forEach(k => { out['settings.' + k] = settings[k]; });
      const colls = cat.collections || {};
      Object.keys(colls).forEach(c => { out[storeKeyOfCollection(c)] = colls[c] || []; });
      return out;
    }
  };

  const toDb = {
    category: obj => catalogToDb(CATALOG_MAPS.category, obj),
    location: obj => catalogToDb(CATALOG_MAPS.location, obj),
    asset: obj => catalogToDb(CATALOG_MAPS.asset, obj),
    option: obj => catalogToDb(CATALOG_MAPS.option, obj),

    reservation(obj) {
      const pay = obj.payment || {};
      const total = obj.total != null ? obj.total : ((obj.price && obj.price.total) || 0);
      return {
        id: obj.reservationId, kind: obj.kind || 'rental',
        asset_id: obj.assetId, category_id: obj.categoryId, location_id: obj.locationId,
        start_at: obj.start, end_at: obj.end, status: obj.status,
        user_id: obj.userId || null,
        customer_name: obj.customerName || '', customer_kana: obj.customerKana || '',
        customer_email: obj.customerEmail || '', customer_phone: obj.customerPhone || '', company: obj.company || '',
        license_confirmed: !!obj.licenseConfirmed,
        payment_method: pay.method || 'onsite', payment_status: pay.status || 'unpaid',
        option_ids: obj.optionIds || [], options: obj.options || [],
        price: obj.price || {}, total: total,
        discount_type: obj.discountType || null, coupon_id: obj.couponId || null, invoice_id: obj.invoiceId || null,
        point_granted: !!obj.pointGranted, note: obj.note || '', staff_note: obj.staffNote || '',
        cancel_fee: obj.cancelFee == null ? null : obj.cancelFee,
        cancelled_at: obj.cancelledAt || null, cancelled_by: obj.cancelledBy || null,
        created_at: obj.createdAt, version: obj.version, gcal_events: obj.gcalEvents || {}
      };
    },

    coupon(obj, userId) {
      return {
        id: obj.couponId, user_id: userId, amount: obj.amount, reason: obj.reason || '', issued_at: obj.issuedAt,
        expires_at: obj.expiresAt || null, used_at: obj.usedAt || null, used_reservation_id: obj.usedFor || null
      };
    },

    member(obj) {
      return {
        user_id: obj.userId, member_no: obj.memberId, email: obj.email || '', name: obj.name || '',
        name_kana: obj.nameKana || '', phone: obj.phone || '', company: obj.company || '',
        is_corporate: !!obj.isCorporate, invoice_allowed: !!obj.invoiceAllowed, marketing_opt_in: !!obj.marketingOptIn,
        status: obj.status || 'active', last_use_at: obj.lastUseAt || null, created_at: obj.createdAt
      };
    },

    invoice(obj) {
      return {
        id: obj.invoiceId, user_id: obj.userId, company: obj.company || '', address: obj.address || '',
        case_name: obj.caseName || '', reservation_ids: obj.reservationIds || [], amount: obj.amount,
        status: obj.status || 'unpaid', issued_at: obj.issuedAt, due_date: jstDate(obj.dueDate),
        paid_at: obj.paidAt || null
      };
    },

    inquiry(obj) {
      return {
        id: obj.inquiryId, name: obj.name, company: obj.company || '', email: obj.email, tel: obj.tel || '',
        topic: obj.topic, body: obj.body, reservation_id: obj.reservationId || null, status: obj.status || 'new',
        staff_note: obj.staffNote || '', created_at: obj.createdAt, user_id: obj.userId || null,
        assigned_to: obj.assignedTo || null
      };
    },

    setting(key, value) { return { key: String(key).replace(/^settings\./, ''), value: value }; }
  };

  // 管理画面の汎用一覧 (crud.js の storageKey) ⇔ app_collections.collection
  const COLLECTION_BY_KEY = {
    'employees': 'employees', 'notices': 'notices', 'holidays-list': 'holidays', 'faq': 'faq',
    'custom-pages': 'custom-pages', 'price-plans': 'price-plans', 'vehicle-classes': 'vehicle-classes',
    'customer-rates': 'customer-rates', 'input-fields': 'input-fields', 'high-season': 'high-season',
    'vehicle-types': 'vehicle-types'
  };
  function storeKeyOfCollection(c) {
    const k = Object.keys(COLLECTION_BY_KEY).find(x => COLLECTION_BY_KEY[x] === c);
    return k || c;
  }

  // ===================================================================
  // 権限 (DB の role_has_perm と同じ表)
  // ===================================================================
  const ALL_PERMS = ['read', 'reservations.write', 'members.write', 'inquiries.write', 'content.write', 'outbox.read',
                     'blocks.write', 'invoices.write', 'payments.write', 'catalog.write', 'settings.write',
                     'staff.write', 'audit.read'];
  const ROLE_PERMS = {
    admin: ALL_PERMS,
    store_staff: ['read', 'reservations.write', 'members.write', 'inquiries.write', 'content.write', 'outbox.read', 'blocks.write'],
    accounting: ['read', 'invoices.write', 'payments.write', 'outbox.read'],
    maintenance: ['read', 'catalog.write', 'blocks.write'],
    viewer: ['read']
  };
  function permsOf(role) { return (ROLE_PERMS[role] || []).slice(); }

  // ===================================================================
  // 通信 (本番のみ)
  // ===================================================================
  function timedFetch(input, init) {
    init = Object.assign({}, init || {});
    let timer = null;
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController();
      const outer = init.signal;
      if (outer) {
        if (outer.aborted) ctrl.abort();
        else outer.addEventListener('abort', () => ctrl.abort());
      }
      init.signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    }
    return window.fetch(input, init).then(
      res => { clearTimeout(timer); return res; },
      err => { clearTimeout(timer); throw err; });
  }

  function loadScript(src, integrity) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(makeError('NETWORK', '接続用ライブラリを読み込めませんでした。通信環境をご確認のうえ、再読み込みしてください。'));
      (document.head || document.documentElement).appendChild(s);
    });
  }

  // ===================================================================
  // メールのリンク (パスワード再設定・招待・メール確認) で開かれたとき
  //   Auth は確認後に `#access_token=...&type=recovery` (失敗時は `#error=...&error_code=...`) を付けて
  //   このサイトへ戻す。supabase-js は createClient の時点でこの # を読んで消し、PASSWORD_RECOVERY も
  //   その時点のリスナーにしか届けないため、createClient より前に # を読んで覚えておく
  //   (ページは SkyRentBackend.auth.urlEvent() で読む)。
  //   #lookup=<予約番号>.<照会キー> (ゲスト照会) は Auth のものではないので、supabase-js に渡さず残す。
  // ===================================================================
  const LINK_TYPES = { recovery: 'recovery', invite: 'invite', signup: 'signup', email: 'signup', email_change: 'email_change', magiclink: 'magiclink' };
  const LINK_ERRORS = {
    otp_expired: 'LINK_INVALID', access_denied: 'LINK_INVALID', flow_state_expired: 'LINK_INVALID',
    flow_state_not_found: 'LINK_INVALID', bad_code_verifier: 'LINK_INVALID', user_not_found: 'LINK_INVALID',
    email_address_invalid: 'LINK_INVALID'
  };
  const urlAuth = captureAuthHash();

  function captureAuthHash() {
    const out = { type: null, error: null, message: null, hasToken: false };
    let raw = '';
    try { raw = String(location.hash || ''); } catch (e) { raw = ''; }
    if (raw.length < 2) return out;
    let params;
    try { params = new URLSearchParams(raw.slice(1)); } catch (e) { return out; }
    if (params.has('lookup')) return out;  // ゲスト照会はページ側で読む
    out.hasToken = !!params.get('access_token');
    const type = params.get('type');
    if (out.hasToken && type && hasOwn(LINK_TYPES, type)) out.type = LINK_TYPES[type];
    const code = params.get('error_code') || params.get('error');
    const desc = params.get('error_description');
    if (code || desc) {
      out.error = { code: code || 'unspecified_error', description: desc || '', message: errorMessage(LINK_ERRORS[code] || 'LINK_INVALID') };
    }
    // メールアドレス変更の途中経過など (トークンなしの案内文)
    if (!out.hasToken && params.get('message')) out.message = params.get('message');
    // トークンの無い Auth の結果 (期限切れ・案内文) は supabase-js が消さないので、ここで URL から消す
    // (再読み込みで同じ表示を繰り返さない・ブックマークに残さない)
    if (!out.hasToken && (out.error || out.message)) {
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* 続行 */ }
    }
    return out;
  }

  function urlEvent() {
    return {
      type: urlAuth.type,
      error: urlAuth.error ? Object.assign({}, urlAuth.error) : null,
      message: urlAuth.message
    };
  }

  // ===================================================================
  // ログイン状態の保存先
  //   *.github.io は同じアカウントの他のリポジトリのサイトと同じオリジンになり、localStorage を
  //   読み書きし合えるため、タブを閉じると消える sessionStorage に置く。config.AUTH_STORAGE で変更可。
  // ===================================================================
  function authStorageMode() {
    const mode = String(CONFIG.AUTH_STORAGE || 'auto').toLowerCase();
    if (mode === 'local' || mode === 'session') return mode;
    let host = '';
    try { host = String(location.hostname || '').toLowerCase(); } catch (e) { host = ''; }
    return /(^|\.)github\.io$/.test(host) ? 'session' : 'local';
  }

  function memoryStorage() {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: k => { m.delete(k); }
    };
  }

  // supabase-js に渡す storage (undefined = 既定の localStorage)
  function authStorage() {
    if (authStorageMode() !== 'session') return undefined;
    let store;
    try {
      store = window.sessionStorage;
      store.setItem('sky-rent.__probe', '1');
      store.removeItem('sky-rent.__probe');
    } catch (e) {
      store = memoryStorage();  // sessionStorage が使えない環境 (プライバシー設定など) はこのタブのメモリ
    }
    // 以前 localStorage に保存されたログイン状態が残っていれば消す
    try {
      const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
      ['', '-code-verifier', '-user'].forEach(sfx => { window.localStorage.removeItem('sb-' + ref + '-auth-token' + sfx); });
    } catch (e) { /* 続行 */ }
    return store;
  }

  let client = null;
  let clientPromise = null;
  function getClient() {
    if (!LIVE) return Promise.reject(makeError('DEMO_MODE'));
    if (!clientPromise) {
      const lib = () => window.supabase && typeof window.supabase.createClient === 'function';
      clientPromise = (lib() ? Promise.resolve() : loadScript(SUPABASE_JS_URL, SUPABASE_JS_SRI)).then(() => {
        if (!lib()) throw makeError('NETWORK', '接続用ライブラリを読み込めませんでした。再読み込みしてください。');
        const authOpts = {
          persistSession: true, autoRefreshToken: true,
          // # に access_token があるときだけ supabase-js に読ませる (#lookup や、エラーだけの # は渡さない)
          detectSessionInUrl: (url, params) => !!(params && params.access_token)
        };
        const storage = authStorage();
        if (storage) authOpts.storage = storage;
        client = window.supabase.createClient(SUPABASE_URL, ANON_KEY, { auth: authOpts, global: { fetch: timedFetch } });
        // PASSWORD_RECOVERY は登録済みのリスナーにしか届かないので、作った直後に登録して覚えておく
        try {
          client.auth.onAuthStateChange(event => {
            if (event === 'PASSWORD_RECOVERY') urlAuth.type = 'recovery';
          });
        } catch (e) { /* 続行 */ }
        return client;
      });
      clientPromise.catch(() => { clientPromise = null; });
    }
    return clientPromise;
  }

  async function accessToken() {
    const c = await getClient();
    const res = await c.auth.getSession();
    const session = res && res.data && res.data.session;
    return session ? session.access_token : null;
  }

  function codeOfStatus(status) {
    if (status === 400) return 'VALIDATION';
    if (status === 401) return 'UNAUTHENTICATED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status === 413) return 'PAYLOAD_TOO_LARGE';
    if (status === 429) return 'RATE_LIMITED';
    return 'INTERNAL';
  }

  // Edge Function 呼び出し。失敗は Error (code / message / fields / quote) を throw
  async function call(fn, path, opts) {
    opts = opts || {};
    if (!LIVE) throw makeError('DEMO_MODE');
    const hasBody = opts.body !== undefined;
    const method = String(opts.method || (hasBody ? 'POST' : 'GET')).toUpperCase();
    let p = String(path || '');
    if (p && p.charAt(0) !== '/' && p.charAt(0) !== '?') p = '/' + p;
    const url = FUNCTIONS_URL + '/' + String(fn).replace(/^\/+|\/+$/g, '') + p;
    let token = null;
    try { token = await accessToken(); } catch (e) { token = null; }
    const headers = { apikey: ANON_KEY, Authorization: 'Bearer ' + (token || ANON_KEY) };
    const init = { method: method, headers: headers };
    if (hasBody && method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await timedFetch(url, init);
    } catch (e) {
      throw makeError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok || !json || json.ok === false) {
      let code;
      if (json && json.code) code = json.code;
      else if (!json && [401, 403, 429].indexOf(res.status) < 0) code = 'INTERNAL';
      else code = codeOfStatus(res.status);
      // 同梱の項目 (fields・quote・cancellation・documents・missing・requestId) はそのまま載せる
      throw makeError(code, json && typeof json.message === 'string' ? json.message : null,
        Object.assign({}, json && typeof json === 'object' ? json : {}, { status: res.status }));
    }
    return json;
  }

  async function rpc(c, name, args) {
    const res = await c.rpc(name, args || {});
    if (res.error) throw toError(res.error);
    return res.data;
  }

  // 1000 行ずつ全件読む (PostgREST の max_rows 対策)
  async function selectAll(c, table, cols, order) {
    const PAGE = 1000;
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = c.from(table).select(cols || '*');
      (order || []).forEach(col => { q = q.order(col, { ascending: true }); });
      const res = await q.range(from, from + PAGE - 1);
      if (res.error) throw toError(res.error);
      const rows = res.data || [];
      rows.forEach(r => out.push(r));
      if (rows.length < PAGE) break;
    }
    return out;
  }

  // 行を消す。RLS で拒否された delete はエラーにならず「0 件削除」で終わるため、消えた件数を確かめ、
  // 消えなかった行がまだ残っていれば (= 権限が無い) FORBIDDEN を投げる。
  // 既に他の人が消していた行 (残っていない) は成功扱い。
  //   filters: [[列, 'eq' | 'in', 値]]  keyCol: 件数確認に使う列
  async function deleteRows(c, table, filters, keyCol) {
    const where = q => { filters.forEach(f => { q = f[1] === 'in' ? q.in(f[0], f[2]) : q.eq(f[0], f[2]); }); return q; };
    const res = await where(c.from(table).delete()).select(keyCol);
    if (res.error) throw toError(res.error);
    const deleted = (res.data || []).length;
    const inFilter = filters.find(f => f[1] === 'in');
    const expected = inFilter ? inFilter[2].length : 1;
    if (deleted >= expected) return deleted;
    const left = await where(c.from(table).select(keyCol));
    if (left.error) throw toError(left.error);
    if ((left.data || []).length) throw makeError('FORBIDDEN');
    return deleted;
  }

  function never() { return new Promise(() => {}); }

  const backend = {};

  function redirect(url) {
    backend._lastRedirect = url;
    try { location.replace(url); } catch (e) { /* 画面遷移できない環境 (テスト) */ }
  }
  function redirectToLogin(extra) {
    const here = (location.pathname.split('/').pop() || 'dashboard.html') + location.search + location.hash;
    const q = new URLSearchParams(Object.assign({ next: here }, extra || {}));
    redirect('login.html?' + q.toString());
  }

  // ===================================================================
  // 空き状況 + 受け渡し担当者の判定
  // ===================================================================
  let availabilityData = null;

  function busyLists(loc) {
    if (Array.isArray(loc.calendars) && loc.calendars.length) return loc.calendars.map(c => (c && c.busy) || []);
    return [loc.busy || []];
  }
  function overlaps(b, w) {
    const bs = toMs(b.start), be = toMs(b.end);
    if (!isFinite(bs) || !isFinite(be)) return false;
    return bs < w[1] && be > w[0];
  }

  // 契約書 §3.2 の判定をブラウザでも行う (表示用。最終判定はサーバー)
  function staffCheck(asset, start, end) {
    const a = asset && typeof asset === 'object' ? asset : (S ? S.getAsset(asset) : null);
    const data = availabilityData;
    if (!a || !data || !data.staff) return { ok: true };
    const st = data.staff;
    const s = toMs(start), e = toMs(end);
    if (!isFinite(s) || !isFinite(e)) return { ok: true };
    const H = Math.max(0, Number(st.handoverMinutes) || 0) * MIN;
    const locId = a.locationId;

    if (st.enabled) {
      const loc = (st.locations || {})[locId];
      if (loc && loc.configured) {
        const span = Math.max(H, MIN);
        const windows = st.mode === 'day' ? [jstDayRange(s), jstDayRange(e)] : [[s, s + span], [e, e + span]];
        const lists = busyLists(loc);
        const blocked = windows.some(w => !lists.some(list => !list.some(b => overlaps(b, w))));
        if (blocked) return { ok: false, code: 'STAFF_UNAVAILABLE', message: errorMessage('STAFF_UNAVAILABLE') };
      }
    }
    if (st.oneHandoverAtATime && H > 0) {
      const times = ((data.handovers || {})[locId]) || [];
      const clash = times.some(t => {
        const x = toMs(t);
        return isFinite(x) && (Math.abs(x - s) < H || Math.abs(x - e) < H);
      });
      if (clash) return { ok: false, code: 'HANDOVER_CONFLICT', message: errorMessage('HANDOVER_CONFLICT') };
    }
    return { ok: true };
  }

  function extraAvailabilityCheck(asset, start, end) {
    const r = staffCheck(asset, start, end);
    return r.ok ? null : { ok: false, reason: r.message, code: r.code };
  }

  // 担当者の予定を確認できているか (画面の案内用)
  //   checked: サーバーの空き状況 (担当者の予定を含む) を読み込めたか (デモ・読込失敗は false)
  //   error: Google に接続できなかったなど、担当者の予定全体を確認できないときのコード ('CALENDAR_UNAVAILABLE' など)
  //   unavailableLocations: カレンダーの一部または全部を読めなかった拠点の ID
  //     (最終判定はサーバー。failOpen でなければ、その拠点の予約は確定時に CALENDAR_UNAVAILABLE になる)
  function staffAvailabilityState() {
    const st = availabilityData && availabilityData.staff;
    if (!st || typeof st !== 'object') return { checked: false, error: null, unavailableLocations: [] };
    const locs = st.locations && typeof st.locations === 'object' ? st.locations : {};
    return {
      checked: true,
      error: st.error ? String(st.error) : null,
      unavailableLocations: Object.keys(locs).filter(id => locs[id] && locs[id].unavailable === true)
    };
  }

  function demoAvailability() {
    return {
      ok: true, busy: [], handovers: {},
      staff: { enabled: false, mode: 'handover', handoverMinutes: 0, oneHandoverAtATime: false, locations: {} }
    };
  }

  function applyAvailability(json) {
    availabilityData = json || null;
    const busy = ((json && json.busy) || []).map((b, i) => ({
      reservationId: 'busy-' + (i + 1), assetId: b.assetId, start: b.start, end: b.end,
      status: 'confirmed', _busy: true
    }));
    const mine = S.list('reservations').filter(r => !r._busy);
    S._hydrate({ reservations: mine.concat(busy) });
    S._setExtraAvailabilityCheck(extraAvailabilityCheck);
  }

  function needsAvailability() {
    return /\/(search|detail|booking)\.html$/i.test(location.pathname);
  }

  // ===================================================================
  // 会員 (本番)
  // ===================================================================
  const MEMBER_RES_COLS = 'id,kind,asset_id,category_id,location_id,start_at,end_at,status,user_id,customer_name,' +
    'customer_kana,customer_email,customer_phone,company,license_confirmed,payment_method,payment_status,option_ids,' +
    'options,price,total,discount_type,coupon_id,invoice_id,point_granted,note,cancel_fee,cancelled_at,cancelled_by,' +
    'version,created_at';
  const ADMIN_RES_COLS = MEMBER_RES_COLS + ',staff_note,gcal_events,source';

  // opts.reservations === false: 予約は読まない (管理画面で会員1人分を取り直すとき)
  async function loadMemberData(c, userId, opts) {
    const withReservations = !(opts && opts.reservations === false);
    const results = await Promise.all([
      c.from('members').select('*').eq('user_id', userId).maybeSingle(),
      c.from('member_points').select('points').eq('user_id', userId).maybeSingle(),
      c.from('coupons').select('*').eq('user_id', userId).order('issued_at', { ascending: true }),
      c.from('point_ledger').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
      // 会員は予約表を直接読めない (スタッフのメモ等を見せないため)。列を限定した RPC で本人分だけ取る
      withReservations ? c.rpc('member_reservations') : Promise.resolve({ data: [], error: null })
    ]);
    const err = results.find(r => r.error);
    if (err) throw toError(err.error);
    if (!results[0].data) return null;
    const member = fromDb.member(results[0].data, {
      points: results[1].data ? results[1].data.points : 0,
      coupons: results[2].data, ledger: results[3].data
    });
    const reservations = (results[4].data || []).map(r => fromDb.reservation(r, { memberNo: () => member.memberId }));
    return { member: member, reservations: reservations };
  }

  function applyMember(data) {
    const busy = S.list('reservations').filter(r => r._busy);
    if (data && data.member && data.member.status === 'active') {
      S._hydrate({
        members: [data.member],
        memberSession: { memberId: data.member.memberId },
        reservations: data.reservations.concat(busy)
      });
    } else {
      S._hydrate({ members: [], memberSession: undefined, reservations: busy });
    }
  }

  async function currentUserId(c) {
    const res = await c.auth.getSession();
    const session = res && res.data && res.data.session;
    return session && session.user ? session.user.id : null;
  }

  // ===================================================================
  // 管理画面 (本番)
  // ===================================================================
  let staff = null;
  let adminClient = null;

  async function loadAdminData(c) {
    const all = await Promise.all([
      selectAll(c, 'categories', '*', ['sort', 'id']),
      selectAll(c, 'locations', '*', ['sort', 'id']),
      selectAll(c, 'assets', '*', ['sort', 'id']),
      selectAll(c, 'options', '*', ['sort', 'id']),
      selectAll(c, 'app_settings', 'key,value', ['key']),
      selectAll(c, 'app_collections', 'collection,id,data,sort', ['collection', 'sort', 'id']),
      selectAll(c, 'legal_documents', 'id,version,title,url,effective_at,active', ['id', 'version']),
      selectAll(c, 'members', '*', ['member_no']),
      selectAll(c, 'member_points', 'user_id,points', ['user_id']),
      selectAll(c, 'coupons', '*', ['issued_at', 'id']),
      selectAll(c, 'point_ledger', '*', ['id']),
      selectAll(c, 'reservations', ADMIN_RES_COLS, ['start_at', 'id']),
      selectAll(c, 'invoices', '*', ['id']),
      selectAll(c, 'inquiries', '*', ['created_at', 'id']),
      rpc(c, 'admin_recent_activity', { p_limit: 50 }).catch(e => { console.warn('操作履歴を読み込めませんでした', e.code); return []; })
    ]);
    const [cats, locs, assets, opts, settings, colls, legal, members, points, coupons, ledger, reservations, invoices, inquiries, activity] = all;

    const byUser = (rows) => {
      const m = {};
      rows.forEach(r => { (m[r.user_id] = m[r.user_id] || []).push(r); });
      return m;
    };
    const pointsByUser = {};
    points.forEach(p => { pointsByUser[p.user_id] = p.points; });
    const couponsByUser = byUser(coupons);
    const ledgerByUser = byUser(ledger);
    const memberObjs = members.map(row => fromDb.member(row, {
      points: pointsByUser[row.user_id], coupons: couponsByUser[row.user_id], ledger: ledgerByUser[row.user_id]
    }));
    const memberNo = {};
    memberObjs.forEach(m => { memberNo[m.userId] = m.memberId; });
    const assetObjs = assets.map(fromDb.asset);
    const assetById = {};
    assetObjs.forEach(a => { assetById[a.assetId] = a; });
    const ctx = { asset: id => assetById[id] || null, memberNo: uid => (uid ? memberNo[uid] || null : null) };

    const values = {
      categories: cats.map(fromDb.category),
      locations: locs.map(fromDb.location),
      assets: assetObjs,
      options: opts.map(fromDb.option),
      legal: legal.filter(d => d.active).map(d => ({ id: d.id, version: d.version, title: d.title, url: d.url, effectiveAt: d.effective_at })),
      members: memberObjs,
      reservations: reservations.map(r => fromDb.reservation(r, ctx)),
      invoices: invoices.map(r => fromDb.invoice(r, ctx)),
      inquiries: inquiries.slice().reverse().map(fromDb.inquiry),
      notifications: (activity || []).filter(a => a.message).map(fromDb.activity)
    };
    settings.forEach(row => { const kv = fromDb.setting(row); values[kv[0]] = kv[1]; });
    const grouped = {};
    colls.forEach(row => { (grouped[row.collection] = grouped[row.collection] || []).push(row.data); });
    Object.keys(COLLECTION_BY_KEY).forEach(k => { values[k] = []; });  // 未登録の一覧は空 (デモの既定行を出さない)
    Object.keys(grouped).forEach(c => { values[storeKeyOfCollection(c)] = grouped[c]; });
    return values;
  }

  let reloading = null;
  function reloadAdmin() {
    if (!adminClient) return Promise.resolve();
    if (!reloading) {
      reloading = loadAdminData(adminClient)
        .then(values => { S._hydrate(values); })
        .finally(() => { reloading = null; });
    }
    return reloading;
  }

  // サーバー反映の直列実行 (失敗時はトーストを出し、最新データを取り直す)
  let syncChain = Promise.resolve();
  function enqueue(job) {
    syncChain = syncChain.then(job).catch(err => {
      const e = toError(err);
      console.error('サーバーへの反映に失敗しました', e.code);
      toast('保存できませんでした。' + e.message + (/再読み込み/.test(e.message) ? '' : ' 画面を再読み込みして、最新の内容をご確認ください。'), 'error');
      return reloadAdmin().catch(() => {});
    });
    return syncChain;
  }

  function indexBy(list, key) {
    const m = {};
    (list || []).forEach(x => { if (x && x[key] != null && x[key] !== '') m[String(x[key])] = x; });
    return m;
  }

  function replaceInList(key, idKey, obj) {
    const arr = S.list(key);
    const i = arr.findIndex(x => String(x[idKey]) === String(obj[idKey]));
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    const v = {};
    v[key] = arr;
    S._hydrate(v);
  }

  const CATALOG_KEYS = {
    categories: { table: 'categories', conv: 'category', idKey: 'categoryId' },
    locations: { table: 'locations', conv: 'location', idKey: 'locationId' },
    assets: { table: 'assets', conv: 'asset', idKey: 'assetId' },
    options: { table: 'options', conv: 'option', idKey: 'optionId' }
  };
  // 画面から直接書き換えてもサーバーに反映しない (専用の関数・RPC を使う) キー
  const SERVER_KEYS = ['invoices', 'notifications', 'legal', 'coupons', 'point_ledger', 'dataVersion'];
  const warnedKeys = {};

  function syncCatalog(c, key, next, prev) {
    const def = CATALOG_KEYS[key];
    const conv = toDb[def.conv];
    const prevById = indexBy(prev, def.idKey);
    const nextById = indexBy(next, def.idKey);
    const upserts = [];
    Object.keys(nextById).forEach(id => {
      const row = conv(nextById[id]);
      if (!prevById[id] || !same(conv(prevById[id]), row)) upserts.push(row);
    });
    const deletes = Object.keys(prevById).filter(id => !nextById[id]);
    if (!upserts.length && !deletes.length) return null;
    return async () => {
      // 行ごとに送る (列の揃っていない行をまとめて upsert すると既定値で上書きされるため)
      for (const row of upserts) {
        const res = await c.from(def.table).upsert(row);
        if (res.error) throw toError(res.error);
      }
      if (deletes.length) await deleteRows(c, def.table, [['id', 'in', deletes]], 'id');
    };
  }

  // スタッフ個人の表示設定など、全員で共有しない設定 (この画面のメモリだけ)
  const LOCAL_SETTINGS = ['profile'];

  function syncSetting(c, key, value) {
    const k = key.replace(/^settings\./, '');
    if (LOCAL_SETTINGS.indexOf(k) >= 0) return null;
    if (!/^[a-z0-9_.-]{1,60}$/.test(k)) {
      console.warn('設定キー「' + k + '」はサーバーに保存できない名前のため、この画面の中だけで使われます');
      return null;
    }
    return async () => {
      if (value === undefined) {
        await deleteRows(c, 'app_settings', [['key', 'eq', k]], 'key');
        return;
      }
      const res = await c.from('app_settings').upsert({ key: k, value: value });
      if (res.error) throw toError(res.error);
    };
  }

  function syncCollection(c, key, next, prev) {
    const coll = COLLECTION_BY_KEY[key];
    const rows = list => (list || []).map((item, i) => ({ collection: coll, id: item && item.id != null ? String(item.id) : '', data: item, sort: i }));
    const nextRows = rows(next);
    if (nextRows.some(r => !r.id)) console.warn('一覧「' + key + '」に ID の無い行があります。ID の無い行はサーバーに保存されません');
    const prevById = {};
    rows(prev).forEach(r => { if (r.id) prevById[r.id] = r; });
    const nextIds = {};
    const upserts = nextRows.filter(r => {
      if (!r.id) return false;
      nextIds[r.id] = true;
      const p = prevById[r.id];
      return !p || p.sort !== r.sort || !same(p.data, r.data);
    });
    const deletes = Object.keys(prevById).filter(id => !nextIds[id]);
    if (!upserts.length && !deletes.length) return null;
    return async () => {
      if (upserts.length) {
        const res = await c.from('app_collections').upsert(upserts);
        if (res.error) throw toError(res.error);
      }
      if (deletes.length) await deleteRows(c, 'app_collections', [['collection', 'eq', coll], ['id', 'in', deletes]], 'id');
    };
  }

  const MEMBER_PATCH = [['name', 'name'], ['nameKana', 'name_kana'], ['phone', 'phone'], ['company', 'company'],
                        ['isCorporate', 'is_corporate'], ['invoiceAllowed', 'invoice_allowed']];

  function syncMembers(c, next, prev) {
    const prevById = indexBy(prev, 'memberId');
    const jobs = [];
    (next || []).forEach(m => {
      const p = prevById[String(m.memberId)];
      if (!p || !m.userId) {
        if (!p) console.warn('会員の追加は「会員を招待」から行ってください (直接の追加はサーバーに反映されません)');
        return;
      }
      const patch = {};
      MEMBER_PATCH.forEach(f => { if (!same(p[f[0]], m[f[0]])) patch[f[1]] = m[f[0]]; });
      if (p.points !== m.points || !same(p.coupons, m.coupons) || !same(p.pointHistory, m.pointHistory)) {
        console.warn('ポイント・クーポンの変更は専用の操作 (ポイント調整・クーポン発行) で行ってください');
      }
      if (Object.keys(patch).length) {
        jobs.push(async () => {
          const row = await rpc(c, 'admin_update_member', { p_user: m.userId, p_patch: patch });
          const cur = S.getMember(m.memberId) || m;
          replaceInList('members', 'memberId', Object.assign({}, cur, fromDb.member(row, {
            points: cur.points, coupons: [], ledger: []
          }), { coupons: cur.coupons || [], pointHistory: cur.pointHistory || [] }));
        });
      }
    });
    if (Object.keys(prevById).some(id => !(next || []).some(m => String(m.memberId) === id))) {
      console.warn('会員の削除はサーバーに反映されません (退会は会員本人の操作で行います)');
    }
    return jobs.length ? async () => { for (const j of jobs) await j(); } : null;
  }

  // 予約の変更 → admin_update_reservation の patch
  function reservationPatch(b, a) {
    const p = {};
    if (a.status !== b.status) p.status = a.status;
    const pa = a.payment || {}, pb = b.payment || {};
    if (pa.status !== pb.status && pa.status) p.payment_status = pa.status;
    if (toMs(a.start) !== toMs(b.start)) p.start = toIso(a.start);
    if (toMs(a.end) !== toMs(b.end)) p.end = toIso(a.end);
    if (a.assetId !== b.assetId) p.asset_id = a.assetId;
    [['customerName', 'customer_name'], ['customerKana', 'customer_kana'], ['customerEmail', 'customer_email'],
     ['customerPhone', 'customer_phone'], ['company', 'company'], ['note', 'note'], ['staffNote', 'staff_note']]
      .forEach(f => { if ((a[f[0]] || '') !== (b[f[0]] || '')) p[f[1]] = a[f[0]] || ''; });
    if (a.cancelFee != null && a.cancelFee !== b.cancelFee) p.cancel_fee = Number(a.cancelFee) || 0;
    if (!same(a.price, b.price) && a.price) {
      p.price = a.price;
      if (a.price.total != null) p.total = Number(a.price.total) || 0;
    }
    if (a.total != null && a.total !== b.total) p.total = Number(a.total) || 0;
    if (a._notify === false) p.notify = false;
    return p;
  }

  // 画面 (store) で直接追加された予約は userId を持たず memberId (会員番号) だけのことがあるので、会員一覧から引く
  function userIdOfReservation(r) {
    if (r.userId) return r.userId;
    if (!r.memberId) return null;
    const m = S.getMember(r.memberId);
    return (m && m.userId) || null;
  }

  // 予約の版 (楽観ロック)。ジョブを実行する時点で store にある値を使う
  // (直前の更新がサーバーから返した新しい版で置き換わっているため、続けて更新しても衝突しない)
  function latestVersion(id, fallback) {
    const cur = S.findById('reservations', 'reservationId', id);
    const vs = [cur ? cur.version : null, fallback]
      .filter(v => v != null && v !== '' && isFinite(Number(v))).map(Number);
    return vs.length ? Math.max.apply(null, vs) : null;
  }

  function newReservationPayload(r) {
    const pay = r.payment || {};
    if (r.kind === 'block') {
      return { kind: 'block', asset_id: r.assetId, start_at: toIso(r.start), end_at: toIso(r.end), staff_note: r.staffNote || r.note || '' };
    }
    return {
      kind: 'rental', asset_id: r.assetId, start_at: toIso(r.start), end_at: toIso(r.end),
      user_id: userIdOfReservation(r), customer_name: r.customerName || '', customer_kana: r.customerKana || '',
      customer_email: r.customerEmail || '', customer_phone: r.customerPhone || '', company: r.company || '',
      license_confirmed: !!r.licenseConfirmed, payment_method: pay.method || 'onsite',
      option_ids: r.optionIds || [], options: r.options || [], price: r.price || {},
      total: r.total != null ? r.total : ((r.price && r.price.total) || 0),
      note: r.note || '', staff_note: r.staffNote || '', notify: false
    };
  }

  function replaceReservationRow(row) {
    if (!row) return;
    replaceInList('reservations', 'reservationId', fromDb.reservation(row));
  }

  function syncReservations(c, next, prev) {
    const prevById = indexBy((prev || []).filter(r => !r._busy), 'reservationId');
    const jobs = [];
    let created = false;
    (next || []).forEach(r => {
      if (r._busy) return;
      const p = prevById[String(r.reservationId)];
      if (!p) {
        created = true;
        jobs.push(async () => { await rpc(c, 'admin_create_reservation', { p: newReservationPayload(r) }); });
        return;
      }
      const patch = reservationPatch(p, r);
      if (Object.keys(patch).length) {
        jobs.push(async () => {
          replaceReservationRow(await rpc(c, 'admin_update_reservation', {
            p_id: r.reservationId, p_patch: patch, p_version: latestVersion(r.reservationId, p.version)
          }));
        });
      }
    });
    if (Object.keys(prevById).some(id => !(next || []).some(r => String(r.reservationId) === id))) {
      console.warn('予約の削除はサーバーに反映されません (キャンセルとして状態を変更してください)');
    }
    if (!jobs.length) return null;
    return async () => {
      for (const j of jobs) await j();
      if (created) await reloadAdmin();  // 採番された予約番号で取り直す
    };
  }

  function syncInquiries(c, next, prev) {
    const prevById = indexBy(prev, 'inquiryId');
    const jobs = [];
    (next || []).forEach(q => {
      const p = prevById[String(q.inquiryId)];
      if (!p) return;
      const patch = {};
      if (q.status !== p.status) patch.status = q.status;
      if ((q.staffNote || '') !== (p.staffNote || '')) patch.staff_note = q.staffNote || '';
      if ((q.assignedTo || null) !== (p.assignedTo || null)) patch.assigned_to = q.assignedTo || '';
      if (Object.keys(patch).length) {
        jobs.push(async () => {
          replaceInList('inquiries', 'inquiryId', fromDb.inquiry(await rpc(c, 'admin_update_inquiry', { p_id: q.inquiryId, p_patch: patch })));
        });
      }
    });
    return jobs.length ? async () => { for (const j of jobs) await j(); } : null;
  }

  function adminWriteHook(key, next, prev) {
    const c = adminClient;
    if (!c || !staff) return;
    let job = null;
    try {
      if (CATALOG_KEYS[key]) job = syncCatalog(c, key, next, prev);
      else if (key.indexOf('settings.') === 0) job = syncSetting(c, key, next);
      else if (COLLECTION_BY_KEY[key]) job = syncCollection(c, key, next, prev);
      else if (key === 'members') job = syncMembers(c, next, prev);
      else if (key === 'reservations') job = syncReservations(c, next, prev);
      else if (key === 'inquiries') job = syncInquiries(c, next, prev);
      else if (SERVER_KEYS.indexOf(key) >= 0) {
        if (!warnedKeys[key]) {
          warnedKeys[key] = true;
          console.warn('「' + key + '」はサーバーで管理しているため、画面からの直接の書き込みは反映されません');
        }
      }
      // それ以外 (画面の一時データ) はメモリだけ
    } catch (e) {
      job = () => Promise.reject(e);
    }
    if (job) enqueue(job);
  }

  // サーバーで管理しているキー (管理画面からの書込をサーバーへ反映するもの)
  function isServerKey(key) {
    if (CATALOG_KEYS[key] || COLLECTION_BY_KEY[key] || SERVER_KEYS.indexOf(key) >= 0) return true;
    if (key === 'members' || key === 'reservations' || key === 'inquiries') return true;
    if (key.indexOf('settings.') === 0) return LOCAL_SETTINGS.indexOf(key.slice(9)) < 0;
    return false;
  }

  // 管理画面の init に失敗したとき (サーバーに接続できない・データを読めない) の書込フック。
  // 画面の変更をメモリにだけ黙って保存しないよう、元に戻して「保存できません」と知らせる。
  let offlineToastAt = 0;
  function offlineWriteHook(key, next, prev) {
    if (!isServerKey(key)) return;  // 画面の一時データはそのまま
    const v = {};
    v[key] = prev;
    S._hydrate(v);
    const now = Date.now();
    if (now - offlineToastAt > 3000) {  // 続けて書き込まれてもトーストは1つ
      offlineToastAt = now;
      toast(errorMessage('OFFLINE_SAVE'), 'error');
    }
  }

  async function reloadMemberRow(c, userId) {
    const d = await loadMemberData(c, userId, { reservations: false });
    if (d && d.member) {
      const cur = S.list('members').find(m => m.userId === userId);
      replaceInList('members', 'memberId', Object.assign({}, cur || {}, d.member));
    }
  }

  async function reloadInvoicesAndReservations(c) {
    const [inv, res] = await Promise.all([
      selectAll(c, 'invoices', '*', ['id']),
      selectAll(c, 'reservations', ADMIN_RES_COLS, ['start_at', 'id'])
    ]);
    S._hydrate({ invoices: inv.map(r => fromDb.invoice(r)), reservations: res.map(r => fromDb.reservation(r)) });
  }

  // 画面から呼ばれる業務処理を RPC 版に差し替える (画面にはすぐ反映し、失敗したら取り直す)
  function replaceDomainFunctions(c) {
    S.updateReservation = function (reservationId, updates) {
      const arr = S.list('reservations');
      const i = arr.findIndex(r => r.reservationId === reservationId);
      if (i < 0) return null;
      const before = arr[i];
      const after = Object.assign({}, before, updates || {});
      // 画面の datetime-local の値 (日本時間) は ISO にそろえて持つ
      if (updates && updates.start !== undefined) after.start = isoOr(after.start);
      if (updates && updates.end !== undefined) after.end = isoOr(after.end);
      arr[i] = after;
      S._hydrate({ reservations: arr });
      const patch = reservationPatch(before, after);
      if (Object.keys(patch).length) {
        enqueue(async () => {
          replaceReservationRow(await rpc(c, 'admin_update_reservation', {
            p_id: reservationId, p_patch: patch, p_version: latestVersion(reservationId, before.version)
          }));
        });
      }
      return after;
    };

    S.adjustPoints = function (memberId, delta, reason) {
      const m = S.getMember(memberId);
      if (!m || !m.userId) return null;
      const d = Number(delta) || 0;
      const upd = Object.assign({}, m, {
        points: Math.max(0, (m.points || 0) + d),
        pointHistory: (m.pointHistory || []).concat([{ at: nowIso(), delta: d, reason: reason || '管理者操作' }])
      });
      replaceInList('members', 'memberId', upd);
      enqueue(async () => {
        await rpc(c, 'admin_adjust_points', { p_user: m.userId, p_delta: d, p_reason: reason || '' });
        await reloadMemberRow(c, m.userId);  // しきい値到達で発行されたクーポンも反映
      });
      return upd;
    };

    S.issueCouponManually = function (memberId, amount, reason) {
      const m = S.getMember(memberId);
      if (!m || !m.userId) return null;
      const upd = Object.assign({}, m, {
        coupons: (m.coupons || []).concat([{
          couponId: 'pending-' + Date.now(), amount: Number(amount) || 0, reason: reason || '管理者発行',
          issuedAt: nowIso(), usedAt: null, usedFor: null
        }])
      });
      replaceInList('members', 'memberId', upd);
      enqueue(async () => {
        await rpc(c, 'admin_issue_coupon', { p_user: m.userId, p_amount: Number(amount) || 0, p_reason: reason || '' });
        await reloadMemberRow(c, m.userId);
      });
      return upd;
    };

    S.createInvoice = function (payload) {
      payload = payload || {};
      const m = S.getMember(payload.memberId);
      if (!m) throw new Error('会員が見つかりません');
      if (!m.invoiceAllowed) throw new Error('この会員には請求書払い許可がありません');
      const rIds = payload.reservationIds || [];
      if (!rIds.length) throw new Error('対象予約を選択してください');
      const rs = S.list('reservations').filter(r => rIds.indexOf(r.reservationId) >= 0);
      const amount = rs.reduce((s, r) => s + ((r.price && r.price.total) || 0), 0);
      const due = new Date(); due.setMonth(due.getMonth() + 1);
      const inv = {
        invoiceId: '(発行処理中)', memberId: m.memberId, userId: m.userId,
        company: payload.company || m.company || m.name, address: payload.address || '',
        caseName: payload.caseName || 'レンタル料金 一式', reservationIds: rIds, amount: amount,
        status: 'unpaid', issuedAt: nowIso(), dueDate: payload.dueDate || due.toISOString(), paidAt: null
      };
      S._hydrate({ invoices: S.list('invoices').concat([inv]) });
      enqueue(async () => {
        await rpc(c, 'admin_create_invoice', {
          p_user: m.userId, p_reservation_ids: rIds, p_company: payload.company || '',
          p_address: payload.address || '', p_case_name: payload.caseName || '',
          p_due_date: payload.dueDate ? jstDate(payload.dueDate) : null
        });
        await reloadInvoicesAndReservations(c);
      });
      return inv;
    };

    S.setInvoiceStatus = function (invoiceId, status) {
      const invs = S.list('invoices');
      const inv = invs.find(x => x.invoiceId === invoiceId);
      if (!inv) return null;
      inv.status = status;
      inv.paidAt = status === 'paid' ? nowIso() : null;
      const res = S.list('reservations');
      res.forEach(r => {
        if (r.invoiceId === invoiceId) r.payment = Object.assign({}, r.payment, { status: status === 'paid' ? 'paid' : 'unpaid' });
      });
      S._hydrate({ invoices: invs, reservations: res });
      enqueue(async () => {
        await rpc(c, 'admin_set_invoice_status', { p_id: invoiceId, p_status: status });
        await reloadInvoicesAndReservations(c);
      });
      return inv;
    };

    // 会員登録 → 招待メール (パスワードは本人が設定する)
    S.registerMember = function (payload) {
      payload = payload || {};
      if (!payload.email) throw new Error('メールアドレスは必須です');
      if (S.findMemberByEmail(payload.email)) throw new Error('このメールアドレスは既に登録されています');
      const placeholder = {
        memberId: '(招待中)', userId: null, name: payload.name || '', nameKana: payload.nameKana || '',
        email: payload.email, phone: payload.phone || '', company: payload.company || '',
        isCorporate: !!payload.company, invoiceAllowed: !!payload.invoiceAllowed, status: 'invited',
        points: 0, coupons: [], pointHistory: [], createdAt: nowIso(), lastUseAt: null
      };
      enqueue(async () => {
        await backend.admin.inviteMember({
          email: payload.email, name: payload.name || '', name_kana: payload.nameKana || '',
          phone: payload.phone || '', company: payload.company || '', invoiceAllowed: !!payload.invoiceAllowed
        });
        toast('招待メールを送信しました。お客様がメールのリンクからパスワードを設定すると登録が完了します。', 'success');
        await reloadAdmin();
      });
      return placeholder;
    };
  }

  async function initAdmin(c) {
    const res = await c.auth.getSession();
    const session = res && res.data && res.data.session;
    if (!session) { redirectToLogin(); return never(); }
    const uid = session.user.id;
    const role = await rpc(c, 'staff_role');
    const own = await c.from('staff').select('user_id,name,email,role,active,location_ids').eq('user_id', uid).maybeSingle();
    if (own.error) throw toError(own.error);
    if (!role) {
      let aal = null;
      try {
        const a = await c.auth.mfa.getAuthenticatorAssuranceLevel();
        aal = a && a.data ? a.data.currentLevel : null;
      } catch (e) { aal = null; }
      if (own.data && own.data.active && aal !== 'aal2') {
        redirectToLogin({ step: 'mfa' });  // パスワードは通過済み → 二段階認証へ
        return never();
      }
      try { await c.auth.signOut(); } catch (e) { /* 続行 */ }
      redirectToLogin({ error: 'not_staff' });
      return never();
    }
    const row = own.data || {};
    staff = {
      userId: uid, name: row.name || session.user.email || '', email: row.email || session.user.email || '',
      role: role, perms: permsOf(role), locationIds: row.location_ids == null ? null : row.location_ids
    };
    adminClient = c;
    S._hydrate(await loadAdminData(c));
    S._setWriteHook(adminWriteHook);
    replaceDomainFunctions(c);
  }

  async function initPublic(c, area) {
    try {
      S._hydrate(fromDb.catalog(await rpc(c, 'public_catalog')));
    } catch (e) {
      if (area !== 'admin-login') throw e;
      console.warn('カタログを読み込めませんでした', e.code);
    }
    if (area === 'admin-login') return;
    let uid = null;
    try { uid = await currentUserId(c); } catch (e) { uid = null; }
    if (uid) {
      try { applyMember(await loadMemberData(c, uid)); }
      catch (e) { console.warn('会員情報を読み込めませんでした', e.code); }
    }
    if (needsAvailability()) {
      const from = jstDayRange(Date.now())[0] - DAY;  // 昨日の 0:00 (日本時間) から 120 日
      const to = from + 120 * DAY;
      try {
        applyAvailability(await availability(new Date(from), new Date(to)));
      } catch (e) {
        console.warn('空き状況を読み込めませんでした', e.code);
        toast('空き状況を読み込めませんでした。表示中の空き状況は最新でない可能性があります (ご予約の確定時にあらためて確認します)。', 'warn');
      }
    }
  }

  let initPromise = null;
  let readyResolve = null;
  const ready = new Promise(resolve => { readyResolve = resolve; });

  function init(opts) {
    if (initPromise) return initPromise;
    const area = (opts && opts.area) || 'public';
    initPromise = (async () => {
      if (!LIVE) return { ok: true, live: false, area: area };
      if (area === 'admin') {
        try {
          await initAdmin(await getClient());
        } catch (e) {
          // 画面は表示される (boot.js がエラーバナーを出す) が、変更はサーバーに届かないので保存させない
          S._setWriteHook(offlineWriteHook);
          throw e;
        }
      } else {
        await initPublic(await getClient(), area);
      }
      return { ok: true, live: true, area: area };
    })();
    initPromise.then(() => readyResolve(true), () => readyResolve(false));
    return initPromise;
  }

  // ===================================================================
  // 料金 (デモ / 表示用)
  // ===================================================================
  function pricingRules() {
    const P = window.SkyRentPricing;
    if (P && typeof P.rules === 'function') {
      try { const r = P.rules(); if (r) return r; } catch (e) { /* 次へ */ }
    }
    const r = S.read('settings.pricing_rules', null);
    if (r) return r;
    const core = window.SkyRentPricingCore;
    return core ? core.DEFAULT_RULES : null;
  }

  function computeQuote(asset, start, end, options, discountType, coupon) {
    const core = window.SkyRentPricingCore;
    if (core && typeof core.quote === 'function') {
      return core.quote({
        asset: { id: asset.assetId, categoryId: asset.categoryId, priceHour: asset.priceHour, priceDay: asset.priceDay, customFields: asset.customFields || {} },
        start: start, end: end,
        options: options.map(o => ({
          id: o.optionId, name: o.name, price: o.price, priceShort: o.priceShort == null ? null : o.priceShort,
          priceType: o.priceType || 'per_day', categoryIds: o.categoryIds || null, exclusiveGroup: o.exclusiveGroup || null
        })),
        discountType: discountType || null, coupon: coupon || null, rules: pricingRules()
      });
    }
    // 料金エンジン (pricing-core.js) が無いときの代替
    const c = window.SkyRentPricing.calculate({ asset: asset, start: start, end: end, quantity: 1, options: options, coupon: coupon ? { amount: coupon.amount } : null });
    return {
      ok: true, errors: [], hours: c.hours, days: c.days, plan: c.plan,
      lines: c.lines.map(l => ({ code: l.code || 'line', label: l.label, amount: l.amount })),
      base: c.lines.length ? c.lines[0].amount : 0, subtotal: c.subtotal, discount: 0,
      couponDiscount: c.discount || 0, total: c.total, busy: false, rulesVersion: null
    };
  }

  function cancellationFor(r, at) {
    const core = window.SkyRentPricingCore;
    const asset = S.getAsset(r.assetId) || { assetId: r.assetId, categoryId: r.categoryId, customFields: {} };
    const base = r.price && r.price.base != null ? r.price.base : ((r.price && r.price.total) || 0);
    const cancellable = r.status === 'confirmed' && toMs(r.start) > at.getTime();
    let fee = { fee: 0, pct: 0, label: '' };
    if (core && typeof core.cancellationFee === 'function') {
      try {
        fee = core.cancellationFee({
          asset: { id: asset.assetId, categoryId: asset.categoryId, customFields: asset.customFields || {} },
          category: { id: asset.categoryId }, start: r.start, cancelAt: at.toISOString(), base: base, rules: pricingRules()
        }) || fee;
      } catch (e) { console.warn('キャンセル料を計算できませんでした', e); }
    }
    return { cancellable: cancellable, fee: fee.fee || 0, pct: fee.pct || 0, label: fee.label || '' };
  }

  function safeReservation(r) {
    const loc = S.getLocation(r.locationId);
    return {
      id: r.reservationId, reservationId: r.reservationId, assetId: r.assetId, assetName: r.assetName,
      locationId: r.locationId, locationName: loc ? loc.name : '', start: r.start, end: r.end, status: r.status,
      total: r.total != null ? r.total : ((r.price && r.price.total) || 0), price: r.price, options: r.options || [],
      optionIds: r.optionIds || [], paymentMethod: (r.payment || {}).method || 'onsite',
      customerName: r.customerName, createdAt: r.createdAt,
      cancelFee: r.cancelFee == null ? null : r.cancelFee
    };
  }

  function findOptions(ids) {
    const all = S.list('options');
    return (ids || []).map(id => all.find(o => o.optionId === id)).filter(Boolean);
  }

  function demoCoupon(couponId) {
    if (!couponId) return null;
    const m = S.currentMember();
    const cp = m && (m.coupons || []).find(x => x.couponId === couponId && !x.usedAt);
    if (!cp) throw makeError('COUPON_INVALID');
    return { id: cp.couponId, amount: cp.amount };
  }

  function demoQuote(p) {
    p = p || {};
    const asset = S.getAsset(p.assetId);
    if (!asset) throw makeError('NOT_FOUND');
    if (!(toMs(p.end) > toMs(p.start))) throw makeError('INVALID_PERIOD');
    const quote = computeQuote(asset, p.start, p.end, findOptions(p.optionIds), p.discountType, demoCoupon(p.couponId));
    const av = S.availability(asset.assetId, p.start, p.end, 1);
    const reasons = [];
    if (!av.ok) reasons.push(av.code || 'AVAILABILITY_CONFLICT');
    return {
      ok: true, quote: quote,
      availability: {
        vehicle: av.ok || !!av.code, staff: av.code !== 'STAFF_UNAVAILABLE', handover: av.code !== 'HANDOVER_CONFLICT', reasons: reasons
      },
      demo: true
    };
  }

  function requireFields(fields) {
    if (Object.keys(fields).length) throw makeError('VALIDATION', null, { fields: fields });
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function demoCreateReservation(p) {
    p = p || {};
    const cust = p.customer || {};
    const fields = {};
    if (!p.assetId) fields.assetId = '車両を選択してください';
    if (!cust.name) fields.name = 'お名前を入力してください';
    if (!cust.email || !EMAIL_RE.test(cust.email)) fields.email = 'メールアドレスを正しく入力してください';
    if (!cust.phone) fields.phone = '電話番号を入力してください';
    if (!p.licenseConfirmed) fields.licenseConfirmed = '運転免許証の確認にチェックしてください';
    requireFields(fields);

    if (p.idempotencyKey) {
      const prev = S.list('reservations').find(r => r.idempotencyKey === p.idempotencyKey);
      if (prev) return createdResult(prev, prev.guestToken, true);
    }
    const q = demoQuote(p);
    const quote = q.quote;
    if (quote.ok === false && quote.errors && quote.errors.length) throw makeError(quote.errors[0], null, { quote: quote });
    if (p.expectedTotal != null && Number(p.expectedTotal) !== quote.total) throw makeError('PRICE_CHANGED', null, { quote: quote });
    const member = S.currentMember();
    if (p.paymentMethod === 'invoice' && !(member && member.invoiceAllowed)) throw makeError('INVOICE_NOT_ALLOWED');
    const av = S.availability(p.assetId, p.start, p.end, 1);
    if (!av.ok) throw makeError(av.code || 'AVAILABILITY_CONFLICT');

    const opts = findOptions(p.optionIds).map(o => ({ optionId: o.optionId, name: o.name, price: o.price, priceType: o.priceType || 'per_day' }));
    let r;
    try {
      r = S.createReservation({
        assetId: p.assetId, start: toIso(p.start), end: toIso(p.end), quantity: 1,
        customerName: cust.name, customerEmail: cust.email, customerPhone: cust.phone, company: cust.company || '',
        memberId: member ? member.memberId : null, optionIds: opts.map(o => o.optionId), options: opts,
        paymentMethod: p.paymentMethod === 'invoice' ? 'invoice' : 'onsite',
        price: Object.assign({}, quote, { breakdown: quote.lines }),
        couponId: p.couponId || null, licenseConfirmed: !!p.licenseConfirmed, note: p.note || ''
      });
    } catch (e) {
      throw makeError(/見つかりません/.test(String(e && e.message)) ? 'NOT_FOUND' : 'AVAILABILITY_CONFLICT');
    }
    const token = randomToken(18);
    S.upsert('reservations', 'reservationId', {
      reservationId: r.reservationId, customerKana: cust.kana || '', discountType: p.discountType || null,
      total: quote.total, idempotencyKey: p.idempotencyKey || null, guestToken: token
    });
    return createdResult(S.findById('reservations', 'reservationId', r.reservationId), token, false);
  }

  function createdResult(r, token, replay) {
    return {
      ok: true, replay: !!replay,
      reservation: {
        id: r.reservationId, assetId: r.assetId, start: r.start, end: r.end,
        total: r.total != null ? r.total : ((r.price && r.price.total) || 0), price: r.price,
        status: r.status, paymentMethod: (r.payment || {}).method || 'onsite'
      },
      guestToken: token || null,
      lookupUrl: token ? siteUrl('mypage.html') + '#lookup=' + encodeURIComponent(r.reservationId) + '.' + token : null,
      email: { status: 'skipped' },
      demo: true
    };
  }

  function demoFindForGuest(id, token) {
    const r = S.findById('reservations', 'reservationId', id);
    const m = S.currentMember();
    const ok = r && r.kind !== 'block' &&
      ((token && r.guestToken && String(token) === String(r.guestToken)) || (m && r.memberId && r.memberId === m.memberId));
    if (!ok) throw makeError('NOT_FOUND');
    return r;
  }

  function demoLookup(p) {
    p = p || {};
    const r = demoFindForGuest(p.id, p.token);
    return { ok: true, reservation: safeReservation(r), cancellation: cancellationFor(r, new Date()), demo: true };
  }

  function demoCancel(p) {
    p = p || {};
    const r = demoFindForGuest(p.id, p.token);
    const cn = cancellationFor(r, new Date());
    if (!cn.cancellable) throw makeError('NOT_CANCELLABLE');
    if (p.expectedFee != null && Number(p.expectedFee) !== cn.fee) throw makeError('PRICE_CHANGED', null, { cancellation: cn });
    S.updateReservation(r.reservationId, { status: 'cancelled', cancelFee: cn.fee, cancelledAt: nowIso(), cancelledBy: 'customer' });
    const after = S.findById('reservations', 'reservationId', r.reservationId);
    return {
      ok: true, reservation: safeReservation(after),
      cancellation: { fee: cn.fee, pct: cn.pct, label: cn.label }, email: { status: 'skipped' }, demo: true
    };
  }

  function demoInquiry(p) {
    p = p || {};
    // ハニーポット欄に入力がある = ボット。受け付けたふりをして保存しない
    if (p.website) return { ok: true, id: 'C' + String(Date.now()).slice(-5), email: { status: 'skipped' }, demo: true };
    const fields = {};
    if (!p.name) fields.name = 'お名前を入力してください';
    if (!p.email || !EMAIL_RE.test(p.email)) fields.email = 'メールアドレスを正しく入力してください';
    if (!p.topic) fields.topic = 'お問い合わせの種類を選択してください';
    if (!p.body) fields.body = 'お問い合わせ内容を入力してください';
    requireFields(fields);
    const list = S.list('inquiries');
    if (p.idempotencyKey) {
      const prev = list.find(x => x.idempotencyKey === p.idempotencyKey);
      if (prev) return { ok: true, id: prev.inquiryId, replay: true, email: { status: 'skipped' }, demo: true };
    }
    const id = S.genId('C', 'inquiries', 'inquiryId');
    list.unshift({
      inquiryId: id, name: p.name, company: p.company || '', email: p.email, tel: p.tel || '',
      topic: p.topic, body: p.body, reservationId: p.reservationId || null, status: 'new', staffNote: '',
      createdAt: nowIso(), idempotencyKey: p.idempotencyKey || null
    });
    S.saveList('inquiries', list);
    S.notify('inquiry', 'お問い合わせ ' + id + ' (' + p.topic + ') を受け付けました', id);
    return { ok: true, id: id, email: { status: 'skipped' }, demo: true };
  }

  // ===================================================================
  // 認証・会員
  // ===================================================================
  const demoAuthListeners = [];
  function emitDemoAuth(event) {
    const session = demoSession();
    demoAuthListeners.slice().forEach(cb => setTimeout(() => { try { cb(event, session); } catch (e) { console.error(e); } }, 0));
  }
  function demoSession() {
    const m = S.currentMember();
    return m ? { user: { id: m.memberId, email: m.email }, demo: true } : null;
  }

  function authError(error) { return toError(error); }

  // パスワードの条件 (Auth の設定と同じ): 8文字以上・英大文字・英小文字・数字をそれぞれ1文字以上
  function checkPassword(pw) {
    const s = pw == null ? '' : String(pw);
    const ok = s.length >= 8 && /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
    return ok ? { ok: true } : { ok: false, code: 'WEAK_PASSWORD', message: errorMessage('WEAK_PASSWORD') };
  }

  const auth = {
    checkPassword: checkPassword,

    // メールのリンクで開かれたときの種類とエラー
    //   {type: 'recovery'|'invite'|'signup'|'email_change'|'magiclink'|null,
    //    error: {code, description, message(日本語)}|null, message: Auth の案内文|null}
    urlEvent: urlEvent,

    async signUp(p) {
      p = p || {};
      if (!p.email || !EMAIL_RE.test(p.email)) throw makeError('VALIDATION', null, { fields: { email: 'メールアドレスを正しく入力してください' } });
      if (!checkPassword(p.password).ok) throw makeError('WEAK_PASSWORD');
      if (!LIVE) {
        let m;
        try {
          m = S.registerMember({ email: p.email, password: p.password, name: p.name || '', nameKana: p.kana || '', phone: p.phone || '', company: p.company || '' });
        } catch (e) {
          throw makeError(/既に登録/.test(String(e && e.message)) ? 'EMAIL_TAKEN' : 'VALIDATION');
        }
        S.upsert('members', 'memberId', { memberId: m.memberId, marketingOptIn: !!p.marketingOptIn, consent: p.consent || null });
        S.loginMember(p.email, p.password);
        emitDemoAuth('SIGNED_IN');
        return { ok: true, needsConfirmation: false, member: S.currentMember(), demo: true };
      }
      const c = await getClient();
      const res = await c.auth.signUp({
        email: p.email, password: p.password,
        options: {
          emailRedirectTo: siteUrl('mypage.html'),
          data: {
            account_type: 'member', name: p.name || '', name_kana: p.kana || '', phone: p.phone || '',
            company: p.company || '', marketing_opt_in: !!p.marketingOptIn, consent: p.consent || {}
          }
        }
      });
      if (res.error) throw authError(res.error);
      const session = res.data && res.data.session;
      if (session) applyMember(await loadMemberData(c, session.user.id));
      return { ok: true, needsConfirmation: !session, member: session ? S.currentMember() : null };
    },

    async signIn(email, password) {
      if (!LIVE) {
        const m = S.loginMember(email, password);
        if (!m) throw makeError('INVALID_CREDENTIALS');
        emitDemoAuth('SIGNED_IN');
        return { ok: true, member: S.currentMember(), demo: true };
      }
      const c = await getClient();
      const res = await c.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw authError(res.error);
      const data = await loadMemberData(c, res.data.user.id);
      if (!data || !data.member || data.member.status !== 'active') {
        try { await c.auth.signOut(); } catch (e) { /* 続行 */ }
        applyMember(null);
        throw makeError('NOT_MEMBER');
      }
      applyMember(data);
      return { ok: true, member: S.currentMember() };
    },

    async signOut() {
      if (!LIVE) {
        S.logoutMember();
        emitDemoAuth('SIGNED_OUT');
        return { ok: true, demo: true };
      }
      const c = await getClient();
      const res = await c.auth.signOut();
      applyMember(null);
      if (res && res.error) throw authError(res.error);
      return { ok: true };
    },

    async resetPassword(email) {
      if (!email || !EMAIL_RE.test(email)) throw makeError('VALIDATION', null, { fields: { email: 'メールアドレスを正しく入力してください' } });
      if (!LIVE) return { ok: true, demo: true };
      const c = await getClient();
      const res = await c.auth.resetPasswordForEmail(email, { redirectTo: siteUrl('mypage.html') });
      if (res.error) throw authError(res.error);
      return { ok: true };
    },

    // 会員登録の確認メールをもう一度送る (メールが届かない・リンクの期限が切れたとき)
    async resendSignup(email) {
      if (!email || !EMAIL_RE.test(email)) throw makeError('VALIDATION', null, { fields: { email: 'メールアドレスを正しく入力してください' } });
      if (!LIVE) return { ok: true, demo: true };
      const c = await getClient();
      const res = await c.auth.resend({ type: 'signup', email: email, options: { emailRedirectTo: siteUrl('mypage.html') } });
      if (res && res.error) throw authError(res.error);
      return { ok: true };
    },

    async updatePassword(pw) {
      if (!checkPassword(pw).ok) throw makeError('WEAK_PASSWORD');
      if (!LIVE) {
        const m = S.currentMember();
        if (!m) throw makeError('UNAUTHENTICATED');
        S.upsert('members', 'memberId', { memberId: m.memberId, password: pw });
        return { ok: true, demo: true };
      }
      const c = await getClient();
      const res = await c.auth.updateUser({ password: pw });
      if (res.error) throw authError(res.error);
      return { ok: true };
    },

    async session() {
      if (!LIVE) return demoSession();
      const c = await getClient();
      const res = await c.auth.getSession();
      return (res && res.data && res.data.session) || null;
    },

    // cb(event, session)。戻り値を呼ぶと解除
    onChange(cb) {
      if (typeof cb !== 'function') return function () {};
      if (!LIVE) {
        demoAuthListeners.push(cb);
        return function () { const i = demoAuthListeners.indexOf(cb); if (i >= 0) demoAuthListeners.splice(i, 1); };
      }
      let sub = null;
      let cancelled = false;
      getClient().then(c => {
        if (cancelled) return;
        const r = c.auth.onAuthStateChange((event, session) => {
          // supabase-js のコールバック内で await しない (別タスクで呼ぶ)
          setTimeout(() => { try { cb(event, session); } catch (e) { console.error(e); } }, 0);
        });
        sub = r && r.data && r.data.subscription;
      }).catch(() => {});
      return function () { cancelled = true; if (sub) sub.unsubscribe(); };
    }
  };

  const member = {
    current() { return S.currentMember(); },

    async reload() {
      if (!LIVE) return S.currentMember();
      const c = await getClient();
      const uid = await currentUserId(c);
      applyMember(uid ? await loadMemberData(c, uid) : null);
      return S.currentMember();
    },

    async updateProfile(patch) {
      patch = patch || {};
      const m = S.currentMember();
      if (!m) throw makeError('UNAUTHENTICATED');
      if (!LIVE) {
        const upd = { memberId: m.memberId };
        ['name', 'nameKana', 'phone', 'company', 'marketingOptIn'].forEach(k => { if (patch[k] !== undefined) upd[k] = patch[k]; });
        if (patch.company !== undefined) upd.isCorporate = !!patch.company;
        S.upsert('members', 'memberId', upd);
        return { ok: true, member: S.currentMember(), demo: true };
      }
      const c = await getClient();
      const p = {};
      [['name', 'name'], ['nameKana', 'name_kana'], ['phone', 'phone'], ['company', 'company'], ['marketingOptIn', 'marketing_opt_in']]
        .forEach(f => { if (patch[f[0]] !== undefined) p[f[1]] = patch[f[0]]; });
      await rpc(c, 'member_update_profile', { p_patch: p });
      return { ok: true, member: await member.reload() };
    },

    async close() {
      const m = S.currentMember();
      if (!m) throw makeError('UNAUTHENTICATED');
      if (!LIVE) {
        S.removeById('members', 'memberId', m.memberId);
        S.logoutMember();
        emitDemoAuth('SIGNED_OUT');
        return { ok: true, demo: true };
      }
      await call('api', '/me/close', { body: { confirm: true } });
      const c = await getClient();
      try { await c.auth.signOut({ scope: 'local' }); } catch (e) { /* 続行 */ }
      applyMember(null);
      return { ok: true };
    }
  };

  // ===================================================================
  // 公開・会員向け API
  // ===================================================================
  async function availability(from, to) {
    if (!LIVE) return demoAvailability();
    const q = '?from=' + encodeURIComponent(toIso(from)) + '&to=' + encodeURIComponent(toIso(to));
    return call('api', '/availability' + q, { method: 'GET' });
  }

  async function quote(p) {
    if (!LIVE) return demoQuote(p);
    return call('api', '/quote', { body: p });
  }

  async function createReservation(p) {
    if (!LIVE) return demoCreateReservation(p);
    const json = await call('api', '/reservations', { body: p });
    // 同じタブで続けて検索したときに埋まって見えるよう、空き判定用の予約を足す
    const r = json && json.reservation;
    if (r && r.assetId && r.start && r.end) {
      const list = S.list('reservations');
      list.push({ reservationId: r.id, assetId: r.assetId, start: r.start, end: r.end, status: r.status || 'confirmed', _busy: true });
      S._hydrate({ reservations: list });
      const a = S.getAsset(r.assetId);
      if (availabilityData && a) {
        const h = availabilityData.handovers = availabilityData.handovers || {};
        (h[a.locationId] = h[a.locationId] || []).push(r.start, r.end);
      }
    }
    return json;
  }

  async function lookupReservation(p) {
    p = p || {};
    if (!LIVE) return demoLookup(p);
    return call('api', '/reservations/lookup', { body: { id: p.id, token: p.token || undefined } });
  }

  async function cancelReservation(p) {
    p = p || {};
    if (!LIVE) return demoCancel(p);
    return call('api', '/reservations/cancel', { body: { id: p.id, token: p.token || undefined, expectedFee: p.expectedFee } });
  }

  async function submitInquiry(p) {
    if (!LIVE) return demoInquiry(p);
    return call('api', '/inquiries', { body: p });
  }

  // ===================================================================
  // 管理
  // ===================================================================
  function demoOnly() { return Promise.reject(makeError('DEMO_MODE')); }

  // 整数に丸めて範囲に収める (数でなければ既定値)
  function clampInt(v, min, max, def) {
    if (v === undefined || v === null || v === '') return def;
    const n = Math.floor(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  const AUDIT_DEFAULT_LIMIT = 50;
  const AUDIT_MAX_LIMIT = 200;
  // 操作履歴の期間の端 → ISO。'YYYY-MM-DD' は日本時間の 0:00 (end = true なら翌日 0:00 = その日を含む)。
  // 指定なしは null、解釈できなければ undefined
  function auditBound(v, end) {
    if (v === undefined || v === null || v === '') return null;
    const s = typeof v === 'string' ? v.trim() : v;
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const t = toMs(s + 'T00:00');
      return isFinite(t) ? new Date(t + (end ? DAY : 0)).toISOString() : undefined;
    }
    const t = toMs(s);
    return isFinite(t) ? new Date(t).toISOString() : undefined;
  }

  // 認証アプリに表示する発行者名と、登録の既定名
  const MFA_ISSUER = 'グロースレンタカー';
  const MFA_DEFAULT_NAME = 'グロースレンタカー 管理画面';
  const DEMO_STAFF = { userId: 'demo', name: 'デモ管理者', email: '', role: 'admin', perms: ALL_PERMS.slice(), locationIds: null, demo: true };

  const admin = {
    get staff() { return LIVE ? staff : DEMO_STAFF; },

    can(perm) {
      if (!LIVE) return true;
      if (!staff) return false;
      return staff.role === 'admin' || staff.perms.indexOf(perm) >= 0;
    },

    inviteMember(p) { return LIVE ? call('admin', '/members/invite', { body: p || {} }) : demoOnly(); },
    inviteStaff(p) { return LIVE ? call('admin', '/staff/invite', { body: p || {} }) : demoOnly(); },
    listStaff() { return LIVE ? call('admin', '/staff/list', { body: {} }) : demoOnly(); },

    async updateStaff(userId, patch) {
      if (!LIVE) return demoOnly();
      patch = patch || {};
      const p = {};
      if (patch.name !== undefined) p.name = patch.name;
      if (patch.role !== undefined) p.role = patch.role;
      if (patch.active !== undefined) p.active = !!patch.active;
      if (patch.locationIds !== undefined) p.location_ids = patch.locationIds;
      else if (patch.location_ids !== undefined) p.location_ids = patch.location_ids;
      const c = await getClient();
      return { ok: true, staff: fromDb.staff(await rpc(c, 'admin_update_staff', { p_user: userId, p_patch: p })) };
    },

    // 二段階認証の登録を解除して、次回ログイン時に登録し直してもらう (認証アプリの機種変更・紛失時)
    //   → {ok, removed: 解除した件数}
    resetStaffMfa(userId) {
      if (!LIVE) return demoOnly();
      if (!userId) return Promise.reject(makeError('VALIDATION', null, { fields: { userId: 'スタッフを選択してください' } }));
      return call('admin', '/staff/reset-mfa', { body: { userId: String(userId) } });
    },

    // メール送信・カレンダー同期を1回実行する。opts: {refIds?: 予約番号などの配列 (その分だけ処理), limit?: 件数}
    processOutbox(opts) {
      if (!LIVE) return demoOnly();
      opts = opts || {};
      const body = {};
      if (opts.refIds != null) body.refIds = (Array.isArray(opts.refIds) ? opts.refIds : [opts.refIds]).map(String);
      if (opts.limit != null && opts.limit !== '') body.limit = Number(opts.limit);
      return call('admin', '/outbox/process', { body: body });
    },

    async retryOutbox(id) {
      if (!LIVE) return demoOnly();
      const c = await getClient();
      await rpc(c, 'admin_retry_outbox', { p_id: Number(id) });
      return { ok: true };
    },

    calendarStatus() { return LIVE ? call('admin', '/calendar/status', { method: 'GET' }) : demoOnly(); },
    calendarTest(calendarId) { return LIVE ? call('admin', '/calendar/test', { body: { calendarId: calendarId } }) : demoOnly(); },

    async saveSetting(key, value) {
      const k = String(key || '').replace(/^settings\./, '');
      if (!LIVE) { S.write('settings.' + k, value); return { ok: true, demo: true }; }
      const c = await getClient();
      const res = await c.from('app_settings').upsert({ key: k, value: value });
      if (res.error) throw toError(res.error);
      const v = {};
      v['settings.' + k] = value;
      S._hydrate(v);
      return { ok: true };
    },

    async updateInquiry(id, patch) {
      patch = patch || {};
      const staffNote = patch.staffNote !== undefined ? patch.staffNote : patch.staff_note;
      const assignedTo = patch.assignedTo !== undefined ? patch.assignedTo : patch.assigned_to;
      if (!LIVE) {
        const q = S.findById('inquiries', 'inquiryId', id);
        if (!q) throw makeError('NOT_FOUND');
        const upd = { inquiryId: id };
        if (patch.status !== undefined) upd.status = patch.status;
        if (staffNote !== undefined) upd.staffNote = staffNote;
        if (assignedTo !== undefined) upd.assignedTo = assignedTo;
        S.upsert('inquiries', 'inquiryId', upd);
        return { ok: true, inquiry: S.findById('inquiries', 'inquiryId', id), demo: true };
      }
      const p = {};
      if (patch.status !== undefined) p.status = patch.status;
      if (staffNote !== undefined) p.staff_note = staffNote;
      if (assignedTo !== undefined) p.assigned_to = assignedTo || '';
      const c = await getClient();
      const inquiry = fromDb.inquiry(await rpc(c, 'admin_update_inquiry', { p_id: id, p_patch: p }));
      replaceInList('inquiries', 'inquiryId', inquiry);
      return { ok: true, inquiry: inquiry };
    },

    // 貸出停止枠 (整備・車検など) p: {assetId, start, end, note}
    async createBlock(p) {
      p = p || {};
      const a = S.getAsset(p.assetId);
      if (!a) throw makeError('NOT_FOUND');
      if (!(toMs(p.end) > toMs(p.start))) throw makeError('INVALID_PERIOD');
      const note = p.note || p.reason || '';
      if (!LIVE) {
        const av = S.availability(a.assetId, p.start, p.end, 1);
        if (!av.ok) throw makeError('AVAILABILITY_CONFLICT');
        const r = {
          reservationId: S.genId('B', 'reservations', 'reservationId'), kind: 'block',
          assetId: a.assetId, vehicleId: a.assetId, assetName: a.name, vehicleName: a.name,
          categoryId: a.categoryId, locationId: a.locationId, quantity: 1,
          customerName: '', customerEmail: '', customerPhone: '', company: '', memberId: null,
          start: toIso(p.start), end: toIso(p.end), optionIds: [], options: [],
          payment: { method: 'onsite', status: 'unpaid' }, price: { total: 0, lines: [] }, total: 0,
          couponId: null, status: 'confirmed', pointGranted: false, invoiceId: null, licenseConfirmed: false,
          note: '', staffNote: note, createdAt: nowIso()
        };
        const list = S.list('reservations');
        list.push(r);
        S.saveList('reservations', list);
        return { ok: true, reservation: r, demo: true };
      }
      const c = await getClient();
      const row = await rpc(c, 'admin_create_reservation', {
        p: { kind: 'block', asset_id: a.assetId, start_at: toIso(p.start), end_at: toIso(p.end), staff_note: note }
      });
      const r = fromDb.reservation(row);
      replaceInList('reservations', 'reservationId', r);
      return { ok: true, reservation: r };
    },

    async deleteBlock(id) {
      if (!LIVE) {
        const r = S.findById('reservations', 'reservationId', id);
        if (!r || r.kind !== 'block') throw makeError('NOT_FOUND');
        S.upsert('reservations', 'reservationId', { reservationId: id, status: 'cancelled', cancelledBy: 'staff', cancelledAt: nowIso() });
        return { ok: true, demo: true };
      }
      const c = await getClient();
      await rpc(c, 'admin_delete_block', { p_id: id });
      const r = S.findById('reservations', 'reservationId', id);
      if (r) replaceInList('reservations', 'reservationId', Object.assign({}, r, { status: 'cancelled', cancelledBy: 'staff', cancelledAt: nowIso() }));
      return { ok: true };
    },

    async recentActivity() {
      if (!LIVE) return S.notifications();
      const c = await getClient();
      const rows = await rpc(c, 'admin_recent_activity', { p_limit: 50 });
      const list = (rows || []).filter(a => a.message).map(fromDb.activity);
      S._hydrate({ notifications: list });
      return list;
    },

    // 操作履歴 (audit_log。新しい順)
    //   p: {table, rowId, actor, action, from, to, offset, limit}
    //     actor: スタッフの user_id / '__system' (操作者なし: サーバー処理) / '__member' (会員本人の操作)
    //     from / to: 'YYYY-MM-DD' は日本時間の日付 (to の日を含む)。ISO の日時ならその時刻 (to は含まない)
    //     limit: 1〜200 (既定 50)
    //   → {ok, rows:[{id, at, actor, actor_role, action, table_name, row_id, diff}], total, offset, limit, hasMore}
    async auditLog(p) {
      if (!LIVE) return demoOnly();
      p = p || {};
      if (staff && !admin.can('audit.read')) throw makeError('FORBIDDEN');
      const limit = clampInt(p.limit, 1, AUDIT_MAX_LIMIT, AUDIT_DEFAULT_LIMIT);
      const offset = clampInt(p.offset, 0, 1e9, 0);
      const fields = {};
      const from = auditBound(p.from, false);
      const to = auditBound(p.to, true);
      if (from === undefined) fields.from = '期間の始まりの日付を正しく入力してください';
      if (to === undefined) fields.to = '期間の終わりの日付を正しく入力してください';
      if (from && to && Date.parse(to) <= Date.parse(from)) fields.to = '期間の終わりは、始まりと同じ日かそれより後の日を指定してください';
      requireFields(fields);

      const c = await getClient();
      let q = c.from('audit_log')
        .select('id,at,actor,actor_role,action,table_name,row_id,diff', { count: 'exact' })
        .order('at', { ascending: false })
        .order('id', { ascending: false });
      if (p.table) q = q.eq('table_name', String(p.table));
      if (p.rowId != null && p.rowId !== '') q = q.eq('row_id', String(p.rowId));
      if (p.action) q = q.eq('action', String(p.action));
      if (p.actor === '__system') q = q.is('actor', null);
      else if (p.actor === '__member') q = q.eq('actor_role', 'authenticated');
      else if (p.actor) q = q.eq('actor', String(p.actor));
      if (from) q = q.gte('at', from);
      if (to) q = q.lt('at', to);
      const res = await q.range(offset, offset + limit - 1);
      if (res.error) throw toError(res.error);
      const rows = res.data || [];
      const total = typeof res.count === 'number' ? res.count : null;
      return {
        ok: true, rows: rows, total: total, offset: offset, limit: limit,
        hasMore: total != null ? offset + rows.length < total : rows.length === limit
      };
    },

    // パスワード再設定メール (スタッフ用。リンクは管理画面のログインへ戻る)
    async resetPassword(email) {
      if (!email || !EMAIL_RE.test(email)) throw makeError('VALIDATION', null, { fields: { email: 'メールアドレスを正しく入力してください' } });
      if (!LIVE) return { ok: true, demo: true };
      const c = await getClient();
      const res = await c.auth.resetPasswordForEmail(email, { redirectTo: siteUrl('manage/login.html') });
      if (res && res.error) throw authError(res.error);
      return { ok: true };
    },

    // いまのログイン状態 (ログイン画面の分岐用)
    //   → {userId, email, aal, nextLevel, staff:{name, role, locationIds, active}|null, hasTotp}
    //     未ログインは userId = null。aal: 'aal1' (パスワードのみ) / 'aal2' (二段階認証済み)。
    //     nextLevel = 'aal2' かつ aal = 'aal1' なら確認コードの入力が必要。hasTotp: 確認済みの認証アプリがある
    async sessionState() {
      const out = { userId: null, email: null, aal: null, nextLevel: null, staff: null, hasTotp: false };
      if (!LIVE) {
        let s = null;
        try { s = JSON.parse(sessionStorage.getItem('sky-rent.session') || 'null'); } catch (e) { s = null; }
        if (!s) return Object.assign(out, { demo: true });
        return Object.assign(out, {
          userId: DEMO_STAFF.userId, email: String(s.userId || ''), aal: 'aal2', nextLevel: 'aal2',
          staff: { name: DEMO_STAFF.name, role: DEMO_STAFF.role, locationIds: null, active: true }, demo: true
        });
      }
      const c = await getClient();
      const res = await c.auth.getSession();
      const session = res && res.data && res.data.session;
      if (!session || !session.user) return out;
      out.userId = session.user.id;
      out.email = session.user.email || null;
      // 二段階認証の状態は取れなくても続ける (ログイン画面はパスワードの入力からやり直せる)
      const soft = fn => Promise.resolve().then(fn).catch(e => ({ data: null, error: e }));
      const [aal, own, factors] = await Promise.all([
        soft(() => c.auth.mfa.getAuthenticatorAssuranceLevel()),
        c.from('staff').select('user_id,name,role,active,location_ids').eq('user_id', out.userId).maybeSingle(),
        soft(() => c.auth.mfa.listFactors())
      ]);
      if (aal && aal.data) {
        out.aal = aal.data.currentLevel || null;
        out.nextLevel = aal.data.nextLevel || null;
      }
      if (own && own.error) throw toError(own.error);
      const row = own && own.data;
      if (row) {
        out.staff = {
          name: row.name || '', role: row.role || null,
          locationIds: row.location_ids == null ? null : row.location_ids, active: row.active !== false
        };
      }
      const totp = (factors && factors.data && factors.data.totp) || [];
      out.hasTotp = totp.some(f => f.status === 'verified');
      return out;
    },

    mfa: {
      async listFactors() {
        if (!LIVE) return demoOnly();
        const c = await getClient();
        const res = await c.auth.mfa.listFactors();
        if (res.error) throw authError(res.error);
        return { ok: true, totp: (res.data && res.data.totp) || [], all: (res.data && res.data.all) || [] };
      },
      // TOTP を登録する。{factorId, qrCode(SVG の data URL), secret(手入力用), uri}
      //   opts.friendlyName: この端末の登録名 (既定「グロースレンタカー 管理画面」)。
      //   認証アプリには発行者「グロースレンタカー」として表示される
      async enroll(opts) {
        if (!LIVE) return demoOnly();
        const c = await getClient();
        // 途中で止まった未確認の登録が残っていると新規登録できないため片付ける
        const cur = await c.auth.mfa.listFactors();
        const all = (cur.data && cur.data.all) || [];
        const stale = all.filter(f => f.factor_type === 'totp' && f.status !== 'verified');
        for (const f of stale) { await c.auth.mfa.unenroll({ factorId: f.id }); }
        // 登録名は同じ人の中で重複できないので、使用中なら (2)・(3)… を付ける
        const taken = all.filter(f => f.status === 'verified').map(f => f.friendly_name || '');
        const base = String((opts && opts.friendlyName) || MFA_DEFAULT_NAME).trim() || MFA_DEFAULT_NAME;
        let name = base;
        for (let i = 2; taken.indexOf(name) >= 0; i++) name = base + ' (' + i + ')';
        const params = { factorType: 'totp', issuer: MFA_ISSUER, friendlyName: name };
        const res = await c.auth.mfa.enroll(params);
        if (res.error) throw authError(res.error);
        const d = res.data || {};
        const t = d.totp || {};
        return { ok: true, factorId: d.id, qrCode: t.qr_code, secret: t.secret, uri: t.uri };
      },
      async challengeAndVerify(factorId, code) {
        if (!LIVE) return demoOnly();
        if (factorId && typeof factorId === 'object') { code = factorId.code; factorId = factorId.factorId; }
        const c = await getClient();
        const res = await c.auth.mfa.challengeAndVerify({ factorId: factorId, code: String(code || '').replace(/\s+/g, '') });
        if (res.error) {
          const e = authError(res.error);
          throw e.code === 'INTERNAL' || e.code === 'VALIDATION' ? makeError('MFA_INVALID') : e;
        }
        return { ok: true };
      },
      async unenroll(factorId) {
        if (!LIVE) return demoOnly();
        if (factorId && typeof factorId === 'object') factorId = factorId.factorId;
        const c = await getClient();
        const res = await c.auth.mfa.unenroll({ factorId: factorId });
        if (res.error) throw authError(res.error);
        return { ok: true };
      }
    },

    // スタッフのログイン (パスワード)。needsMfa = true なら続けて確認コードが必要
    async signIn(email, password) {
      if (!LIVE) {
        try { sessionStorage.setItem('sky-rent.session', JSON.stringify({ userId: email || 'demo', loginAt: nowIso() })); } catch (e) { /* 続行 */ }
        return { ok: true, needsMfa: false, hasFactor: false, factors: [], demo: true };
      }
      const c = await getClient();
      const res = await c.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw authError(res.error);
      const own = await c.from('staff').select('user_id,name,role,active').eq('user_id', res.data.user.id).maybeSingle();
      if (own.error || !own.data || !own.data.active) {
        try { await c.auth.signOut(); } catch (e) { /* 続行 */ }
        throw makeError('NOT_STAFF');
      }
      const aal = await c.auth.mfa.getAuthenticatorAssuranceLevel();
      const fs = await c.auth.mfa.listFactors();
      const verified = ((fs.data && fs.data.totp) || []).filter(f => f.status === 'verified');
      return {
        ok: true,
        needsMfa: !(aal.data && aal.data.currentLevel === 'aal2'),
        hasFactor: verified.length > 0,
        factors: verified.map(f => ({ id: f.id, friendlyName: f.friendly_name || '' }))
      };
    },

    async signOut() {
      if (!LIVE) {
        try { sessionStorage.removeItem('sky-rent.session'); } catch (e) { /* 続行 */ }
        return { ok: true, demo: true };
      }
      const c = await getClient();
      staff = null;
      const res = await c.auth.signOut();
      if (res && res.error) throw authError(res.error);
      return { ok: true };
    }
  };

  // ===================================================================
  // 公開
  // ===================================================================
  Object.assign(backend, {
    live: LIVE,
    ready: ready,
    init: init,
    toast: toast,
    errorMessage: errorMessage,
    call: call,
    availability: availability,
    quote: quote,
    createReservation: createReservation,
    lookupReservation: lookupReservation,
    cancelReservation: cancelReservation,
    submitInquiry: submitInquiry,
    staffCheck: staffCheck,
    staffAvailabilityState: staffAvailabilityState,
    jst: jst,
    auth: auth,
    member: member,
    admin: admin,
    fromDb: fromDb,
    toDb: toDb,
    _lastRedirect: null
  });
  Object.defineProperty(backend, 'client', { enumerable: true, get: () => client });

  window.SkyRentBackend = backend;

  // 本番はページの読み込みと並行して接続ライブラリを取りに行く
  if (LIVE) getClient().catch(() => {});
})();
