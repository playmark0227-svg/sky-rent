/**
 * グロースレンタカー - 多言語対応 (i18n)
 *
 * 要件定義書 4.1「多言語対応」準拠: 日本語を基本とし、英語に対応。
 * 辞書にロケールを追加するだけで中国語・韓国語へ拡張可能な構造。
 *
 * 使い方:
 *   <span data-i18n="search.title"></span>            … textContent を差し替え
 *   <input data-i18n-placeholder="form.name">          … placeholder を差し替え
 *   SkyRentI18n.t('search.title')                      … JS から取得
 *   SkyRentI18n.setLang('en')                          … 言語切替 (localStorage に保持)
 */
(function () {
  'use strict';
  const KEY = 'sky-rent.lang';

  const DICT = {
    ja: {
      'nav.features': '特徴', 'nav.search': '予約する', 'nav.categories': 'カテゴリ',
      'nav.locations': '店舗一覧', 'nav.mypage': 'マイページ', 'nav.admin': '管理画面',
      'hero.title': '空へ、自由を。グロースレンタカー',
      'hero.lead': '通勤にも旅行にもお仕事にも。イベント出店のキッチンカーまで、24時間Webでご予約。',
      'hero.cta': '空きを検索する',
      'search.title': '空き状況を検索',
      'search.category': 'カテゴリ', 'search.location': '利用拠点',
      'search.start': '出発日時 (受取)', 'search.end': '返却日時',
      'search.submit': '検索する', 'search.all': 'すべて',
      'search.results': '件の空きが見つかりました', 'search.noresults': '条件に合う空きが見つかりませんでした',
      'search.available': '予約可', 'search.unavailable': '予約不可', 'search.stock': '残り',
      'search.perday': '/日',
      'detail.specs': 'スペック・装備', 'detail.options': 'オプションを選択',
      'detail.optCommon': '共通オプション', 'detail.optSpecific': '専用オプション',
      'detail.license': 'この車両の運転には次の免許・資格が必要です',
      'detail.quantity': '数量', 'detail.estimate': '料金見積り', 'detail.total': '合計 (税込)',
      'detail.book': 'この内容で予約に進む', 'detail.back': '検索結果へ戻る',
      'detail.location': '取扱拠点', 'detail.capacity': '定員', 'detail.plate': 'ナンバー',
      'booking.title': 'ご予約手続き', 'booking.customer': 'お客様情報',
      'booking.name': 'お名前', 'booking.kana': 'フリガナ', 'booking.email': 'メールアドレス',
      'booking.phone': '電話番号', 'booking.company': '会社名 (法人の場合)',
      'booking.license': '運転免許証番号', 'booking.licenseNote': '車両レンタルのため免許証情報の入力が必要です',
      'booking.licenseConfirm': '上記の必要免許・資格を保有していることを確認しました',
      'booking.payment': 'お支払い方法', 'booking.onsite': '現地決済 (現金・カード)',
      'booking.invoice': '請求書払い (法人・行政向け)',
      'booking.coupon': 'クーポンを利用する', 'booking.note': '備考・ご要望',
      'booking.confirm': '入力内容の確認へ', 'booking.submit': 'この内容で予約を確定する',
      'booking.fix': '入力内容を修正する',
      'booking.done.title': 'ご予約ありがとうございました',
      'booking.done.text': 'ご登録のメールアドレス宛に予約確認メールをお送りしました。当日は現地にてお支払いください。',
      'booking.done.top': 'トップに戻る', 'booking.done.mypage': 'マイページで確認',
      'mypage.title': 'マイページ', 'mypage.login': 'ログイン', 'mypage.register': '新規会員登録',
      'mypage.logout': 'ログアウト', 'mypage.points': 'ポイント残高', 'mypage.coupons': '保有クーポン',
      'mypage.history': '予約履歴', 'mypage.pointHistory': 'ポイント履歴',
      'mypage.email': 'メールアドレス', 'mypage.password': 'パスワード',
      'common.yen': '円', 'common.day': '日', 'common.days': '日間', 'common.close': '閉じる',
      'common.required': '必須', 'common.login_as': 'ログイン中',
      'footer.copyright': '© 2026 グロースレンタカー',
      'cat.vehicle': '車両レンタル', 'cat.item': '物品レンタル',
      'loc.hours': '営業時間', 'loc.holiday': '定休日', 'loc.tel': '電話'
    },
    en: {
      'nav.features': 'Features', 'nav.search': 'Book Now', 'nav.categories': 'Categories',
      'nav.locations': 'Locations', 'nav.mypage': 'My Page', 'nav.admin': 'Admin',
      'hero.title': 'Freedom, to the road. Growth Rent a Car.',
      'hero.lead': 'Compact cars, SUVs, minivans, kei trucks and kitchen cars — book online 24/7.',
      'hero.cta': 'Search Availability',
      'search.title': 'Search Availability',
      'search.category': 'Category', 'search.location': 'Location',
      'search.start': 'Pick-up Date & Time', 'search.end': 'Return Date & Time',
      'search.submit': 'Search', 'search.all': 'All',
      'search.results': 'result(s) available', 'search.noresults': 'No availability found for your criteria',
      'search.available': 'Available', 'search.unavailable': 'Unavailable', 'search.stock': 'left',
      'search.perday': '/day',
      'detail.specs': 'Specifications', 'detail.options': 'Select Options',
      'detail.optCommon': 'Common Options', 'detail.optSpecific': 'Category Options',
      'detail.license': 'The following license/qualification is required to operate this vehicle',
      'detail.quantity': 'Quantity', 'detail.estimate': 'Price Estimate', 'detail.total': 'Total (tax incl.)',
      'detail.book': 'Proceed to Booking', 'detail.back': 'Back to Results',
      'detail.location': 'Location', 'detail.capacity': 'Capacity', 'detail.plate': 'Plate',
      'booking.title': 'Booking', 'booking.customer': 'Customer Information',
      'booking.name': 'Name', 'booking.kana': 'Name (Kana)', 'booking.email': 'Email',
      'booking.phone': 'Phone', 'booking.company': 'Company (for corporate)',
      'booking.license': "Driver's License No.", 'booking.licenseNote': "Driver's license is required for vehicle rental",
      'booking.licenseConfirm': 'I confirm that I hold the required license/qualification above',
      'booking.payment': 'Payment Method', 'booking.onsite': 'Pay on-site (cash / card)',
      'booking.invoice': 'Invoice billing (corporate / government)',
      'booking.coupon': 'Use coupon', 'booking.note': 'Notes / Requests',
      'booking.confirm': 'Review Booking', 'booking.submit': 'Confirm Booking',
      'booking.fix': 'Edit Details',
      'booking.done.title': 'Thank you for your booking!',
      'booking.done.text': 'A confirmation email has been sent to your address. Please pay on-site on the day.',
      'booking.done.top': 'Back to Top', 'booking.done.mypage': 'View in My Page',
      'mypage.title': 'My Page', 'mypage.login': 'Log in', 'mypage.register': 'Sign up',
      'mypage.logout': 'Log out', 'mypage.points': 'Point Balance', 'mypage.coupons': 'Coupons',
      'mypage.history': 'Booking History', 'mypage.pointHistory': 'Point History',
      'mypage.email': 'Email', 'mypage.password': 'Password',
      'common.yen': 'JPY', 'common.day': 'day', 'common.days': 'days', 'common.close': 'Close',
      'common.required': 'Required', 'common.login_as': 'Logged in as',
      'footer.copyright': '© 2026 Growth Rent a Car',
      'cat.vehicle': 'Vehicle Rental', 'cat.item': 'Item Rental',
      'loc.hours': 'Hours', 'loc.holiday': 'Closed', 'loc.tel': 'Tel'
    }
    // 将来: zh, ko をここに追加
  };

  function getLang() { return localStorage.getItem(KEY) || 'ja'; }
  function setLang(lang) {
    localStorage.setItem(KEY, DICT[lang] ? lang : 'ja');
    apply();
    document.dispatchEvent(new CustomEvent('sky-rent:langchange', { detail: { lang: getLang() } }));
  }
  function t(key) {
    const lang = getLang();
    return (DICT[lang] && DICT[lang][key]) || DICT.ja[key] || key;
  }
  function apply() {
    document.documentElement.lang = getLang();
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
    document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    // 言語トグルボタンの表示更新
    document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
      btn.textContent = getLang() === 'ja' ? 'EN' : '日本語';
    });
  }
  // 共通ヘッダーが後から注入されるため、何度呼んでも安全にしておく
  function setupToggles() {
    document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
      if (btn.dataset.langBound) return;
      btn.dataset.langBound = '1';
      btn.addEventListener('click', () => setLang(getLang() === 'ja' ? 'en' : 'ja'));
    });
  }

  document.addEventListener('DOMContentLoaded', () => { setupToggles(); apply(); });

  window.SkyRentI18n = { t: t, getLang: getLang, setLang: setLang, apply: apply, bindToggles: setupToggles, DICT: DICT };
})();
