/**
 * グロースレンタカー 管理画面 - 貸渡証 (= 貸渡簿の1行)
 *
 *   予約一覧・予約表 (ガント)・帳票・貸渡簿で共通に使う。
 *   - defaults(r)        予約から作る初期値 (借受人・車両・日時・拠点・オプション・料金)
 *   - effective(r, rec)  保存済みの値があればそれを、無ければ初期値を使った「いまの貸渡証」
 *   - missing(v, opts)   貸渡簿の記載事項のうち、まだ入っていないもの (項目名の配列)
 *   - openEditor(r, o)   編集画面 (モーダル)。保存は SkyRentBackend.admin.saveRentalRecord
 *   - loanDocHtml(r, v)  貸渡証 (印刷用) の HTML
 *
 *   貸渡簿の記載事項: 利用者の氏名 (法人は名称)・住所 / 運転者の氏名・住所・運転免許の種類と番号 /
 *   登録番号 / 貸渡日時と時間 / 貸渡事務所・返還事務所 / 運行区間または行先・利用人数 /
 *   使用目的 (マイクロバスの場合のみ) / 走行キロ数 / 事故に関する事項
 *
 *   読み込み時には何も実行しない (SkyRentStore などは関数を呼んだときに参照する)。
 */
(function () {
  'use strict';
  const S = () => window.SkyRentStore;
  const B = () => window.SkyRentBackend;
  const P = () => window.SkyRentPricing;
  const DAY = 86400000;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function yen(n) { return n == null || n === '' ? '' : '¥' + Number(n).toLocaleString('ja-JP'); }
  function fmtDT(v) { return v ? B().jst.format(v, { weekday: false }) : ''; }
  function todayYmd() { return B().jst.toInput(new Date().toISOString()).slice(0, 10); }
  function fmtYmd(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? Number(m[1]) + '年' + Number(m[2]) + '月' + Number(m[3]) + '日' : '';
  }

  // 運転免許の種類 (入力の候補。自由入力もできる)
  const LICENSE_TYPES = ['普通', '普通 (AT限定)', '準中型', '準中型 (5t限定)', '中型', '中型 (8t限定)', '大型', '大型特殊', '二種'];

  function isItemRes(r) {
    if (r && r.isItem === true) return true;
    const a = S().getAsset(r.assetId);
    const c = S().getCategory(r.categoryId || (a && a.categoryId));
    return !!(c && c.type === 'item');
  }
  function optionKind(x) {
    const cur = S().findById('options', 'optionId', x.optionId || x.id) || x;
    return (cur.kind ? cur.kind === 'cover' : cur.exclusiveGroup === 'cover') ? 'cover' : 'equip';
  }

  // ===== 予約から作る初期値 =====
  function defaults(r) {
    const a = S().getAsset(r.assetId) || {};
    const l = S().getLocation(r.locationId) || {};
    const opts = (r.options || []).filter(Boolean);
    const lines = (r.price && (r.price.lines || r.price.breakdown)) || [];
    const optionFee = lines.filter(x => x && x.code === 'option').reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const total = r.total != null ? Number(r.total) || 0 : ((r.price && Number(r.price.total)) || 0);
    const pay = r.payment || {};
    const payLabel = (S().PAYMENT_LABELS && S().PAYMENT_LABELS[pay.method]) || '';
    const corp = String(r.company || '').trim();
    return {
      issuedOn: todayYmd(),
      // 法人の場合、利用者 (借受人) は法人名、運転者はご予約のお名前
      renterName: corp || r.customerName || '',
      renterAddress: '',
      renterPhone: r.customerPhone || '',
      driverSame: !corp,
      driverName: corp ? (r.customerName || '') : '',
      driverAddress: '',
      licenseNo: '', licenseType: '', licenseExpiry: null, birthDate: null, intlLicense: '',
      vehicleName: a.name || r.assetName || r.vehicleName || '',
      plate: a.plate || '',
      start: r.start || null, end: r.end || null,
      passengers: null, destination: '', purpose: '',
      pickupOffice: l.name || '', returnOffice: l.name || '', pickupPlace: '', dropoffPlace: '',
      odometerOut: null, odometerIn: null,
      accident: false, accidentNote: '',
      cover: opts.filter(x => optionKind(x) === 'cover').map(x => x.name).join('、'),
      optionsText: opts.filter(x => optionKind(x) !== 'cover').map(x => x.name).join('、'),
      rentalItems: '', service: '',
      baseFee: r.price && r.price.base != null ? Number(r.price.base) || 0 : Math.max(0, total - optionFee),
      optionFee: optionFee,
      total: total,
      payment: payLabel + (pay.status === 'paid' ? ' (入金済)' : ''),
      remarks: ''
    };
  }

  function effective(r, rec) {
    const v = defaults(r);
    if (rec) Object.keys(rec).forEach(k => { if (rec[k] !== undefined) v[k] = rec[k]; });
    v.saved = !!rec;
    v.version = rec ? rec.version : null;
    v.updatedAt = rec ? rec.updatedAt : null;
    v.distanceKm = v.odometerOut != null && v.odometerIn != null && v.odometerOut !== '' && v.odometerIn !== ''
      ? Number(v.odometerIn) - Number(v.odometerOut) : null;
    return v;
  }

  // 運転者 (借受人と同じなら借受人の値)
  function driverOf(v) {
    return v.driverSame ? { name: v.renterName, address: v.renterAddress } : { name: v.driverName, address: v.driverAddress };
  }

  // ===== 貸渡簿の記載事項のうち、入っていないもの =====
  //   returned: 返却済み (返却時メーターも要る)
  function missing(v, opts) {
    opts = opts || {};
    const out = [];
    const d = driverOf(v);
    const blank = x => x == null || String(x).trim() === '';
    if (blank(v.renterName)) out.push('利用者の氏名・名称');
    if (blank(v.renterAddress)) out.push('利用者の住所');
    if (blank(d.name)) out.push('運転者の氏名');
    if (blank(d.address)) out.push('運転者の住所');
    if (blank(v.licenseType)) out.push('運転免許の種類');
    if (blank(v.licenseNo)) out.push('運転免許の番号');
    if (blank(v.plate)) out.push('登録番号 (ナンバー)');
    if (blank(v.start) || blank(v.end)) out.push('貸渡日時');
    if (blank(v.pickupOffice)) out.push('貸渡事務所');
    if (blank(v.returnOffice)) out.push('返還事務所');
    if (blank(v.destination)) out.push('運行区間または行先');
    if (blank(v.passengers)) out.push('利用人数');
    if (blank(v.odometerOut)) out.push('貸出時メーター');
    if (opts.returned && blank(v.odometerIn)) out.push('返却時メーター');
    if (v.accident && blank(v.accidentNote)) out.push('事故に関する事項');
    return out;
  }

  // 貸渡時間 (例: 2日と2時間)
  function durationText(start, end) {
    const ms = Date.parse(end) - Date.parse(start);
    if (!(ms > 0)) return '';
    const h = Math.round(ms / 3600000);
    const d = Math.floor(h / 24), rest = h % 24;
    return (d ? d + '日' : '') + (rest || !d ? rest + '時間' : '');
  }

  // ===== 編集画面 =====
  function field(label, html, opts) {
    opts = opts || {};
    return '<div class="rr-f' + (opts.wide ? ' rr-wide' : '') + '"><label>' + esc(label) + (opts.req ? ' <span class="rr-req" title="貸渡簿の記載事項">※</span>' : '') + '</label>' + html + '</div>';
  }
  function text(id, v, attrs) { return '<input type="text" id="rr-' + id + '" value="' + esc(v == null ? '' : v) + '"' + (attrs || '') + '>'; }
  function num(id, v, attrs) { return '<input type="number" inputmode="numeric" id="rr-' + id + '" value="' + esc(v == null ? '' : v) + '"' + (attrs || '') + '>'; }
  function date(id, v) { return '<input type="date" id="rr-' + id + '" value="' + esc(v || '') + '">'; }
  function dt(id, v) { return '<input type="datetime-local" id="rr-' + id + '" value="' + esc(v ? B().jst.toInput(v) : '') + '">'; }
  function area(id, v, rows) { return '<textarea id="rr-' + id + '" rows="' + (rows || 2) + '">' + esc(v || '') + '</textarea>'; }

  const STYLE_ID = 'rr-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '.rr-body{padding:14px 20px;max-height:68vh;overflow:auto}' +
      '.rr-sec{margin:4px 0 14px}.rr-sec h4{font-size:13.5px;color:var(--primary,#1c4a7a);border-bottom:1px solid #e6ebf0;padding-bottom:4px;margin:0 0 8px}' +
      '.rr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}' +
      '.rr-f{display:flex;flex-direction:column;gap:3px}.rr-wide{grid-column:1/-1}' +
      '.rr-f label{font-size:12px;font-weight:600;color:#555}.rr-req{color:#c0392b}' +
      '.rr-f input,.rr-f textarea,.rr-f select{width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:3px;font:inherit;font-size:13px;box-sizing:border-box}' +
      '.rr-f input[aria-invalid=true]{border-color:#c0392b;background:#fff7f6}' +
      '.rr-inline{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}' +
      '.rr-dist{font-size:13px;padding:7px 0}.rr-dist b{font-size:15px}' +
      '.rr-missing{margin:0 0 12px;padding:8px 12px;border-radius:4px;background:#fff8e6;border:1px solid #f1d9a6;color:#7a5200;font-size:12.5px;line-height:1.7}' +
      '.rr-missing.is-ok{background:#eef8f1;border-color:#bfe3cb;color:#1e6b3a}' +
      '.rr-err{color:#c0392b;font-size:12.5px;padding:0 20px 8px}' +
      '.rr-al{margin:0 0 10px;padding:10px 14px;border-radius:4px;font-size:13px;line-height:1.8}.rr-al ul{margin:4px 0 0;padding-left:18px}' +
      '.rr-al-odo{background:#fdf0ee;border:1px solid #f0c4bd;color:#8a2a1c}.rr-al-oil{background:#fff8e6;border:1px solid #f1d9a6;color:#6b4a00}' +
      '.rr-al a{color:inherit}.rr-al small{color:inherit;opacity:.75}.rr-al-btn{margin-left:6px;padding:2px 10px;border:1px solid currentColor;border-radius:3px;background:#fff;color:inherit;font:inherit;font-size:12px;cursor:pointer}' +
      '.rr-al-btn:hover{background:rgba(255,255,255,.6)}.rr-al-btn:focus-visible{outline:2px solid #1c4a7a;outline-offset:1px}' +
      '@media (max-width:640px){.rr-grid{grid-template-columns:1fr}}';
    document.head.appendChild(st);
  }

  function openModal(html) {
    let modal = document.getElementById('crud-modal');
    if (!modal) { modal = document.createElement('div'); modal.id = 'crud-modal'; modal.className = 'crud-modal'; document.body.appendChild(modal); }
    modal.innerHTML = html;
    const close = () => modal.remove();
    modal.querySelector('.crud-modal-bg').addEventListener('click', close);
    modal.querySelectorAll('.crud-close, .crud-cancel').forEach(b => b.addEventListener('click', close));
    return { modal: modal, close: close };
  }

  // 画面の入力 → 保存する値
  function readForm(modal) {
    const g = id => { const el = modal.querySelector('#rr-' + id); return el ? el.value : undefined; };
    const fromDt = id => { const x = g(id); return x ? B().jst.fromInput(x) : null; };
    return {
      issuedOn: g('issuedOn') || null,
      renterName: g('renterName'), renterAddress: g('renterAddress'), renterPhone: g('renterPhone'),
      driverSame: modal.querySelector('#rr-driverSame').checked,
      driverName: g('driverName'), driverAddress: g('driverAddress'),
      licenseType: g('licenseType'), licenseNo: g('licenseNo'), licenseExpiry: g('licenseExpiry') || null,
      birthDate: g('birthDate') || null, intlLicense: g('intlLicense'),
      vehicleName: g('vehicleName'), plate: g('plate'),
      start: fromDt('start'), end: fromDt('end'),
      passengers: g('passengers'), destination: g('destination'), purpose: g('purpose'),
      pickupOffice: g('pickupOffice'), returnOffice: g('returnOffice'), pickupPlace: g('pickupPlace'), dropoffPlace: g('dropoffPlace'),
      odometerOut: g('odometerOut'), odometerIn: g('odometerIn'),
      accident: modal.querySelector('#rr-accident-yes').checked, accidentNote: g('accidentNote'),
      cover: g('cover'), optionsText: g('optionsText'), rentalItems: g('rentalItems'), service: g('service'),
      baseFee: g('baseFee'), optionFee: g('optionFee'), total: g('total'), payment: g('payment'),
      remarks: g('remarks')
    };
  }

  // 編集画面を開く。opts.onSaved(rec) / opts.focus ('odometer' で走行距離の欄へ)
  async function openEditor(r, opts) {
    opts = opts || {};
    ensureStyle();
    let rec = null;
    try { rec = await B().admin.rentalRecord(r.reservationId); } catch (e) {
      B().toast(B().errorMessage((e && e.code) || 'INTERNAL'), 'error');
      return null;
    }
    let v = effective(r, rec);
    const returned = r.status === 'returned';
    const canWrite = B().admin.can('reservations.write');
    const lic = '<datalist id="rr-license-types">' + LICENSE_TYPES.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>';
    const html =
      '<div class="crud-modal-bg"></div><div class="crud-modal-card" style="min-width:640px;max-width:760px">' +
      '<div class="crud-modal-head"><h3>貸渡証の編集 <code style="background:rgba(255,255,255,.2);color:#fff;font-size:12px;margin-left:8px;padding:2px 8px;border-radius:2px">' + esc(r.reservationId) + '</code></h3><button class="crud-close" type="button" aria-label="閉じる">×</button></div>' +
      '<div class="rr-body" id="rr-body">' +
        '<div class="rr-missing" id="rr-missing"></div>' +
        '<p style="font-size:12px;color:#777;margin:0 0 10px">※ は貸渡簿の記載事項です。' + (v.saved ? '最終保存: ' + esc(fmtDT(v.updatedAt)) : 'まだ保存していません (予約の内容から下書きしています)') + '</p>' +
        '<div class="rr-sec"><h4>借受人 (利用者)</h4><div class="rr-grid">' +
          field('氏名・名称 (法人は名称)', text('renterName', v.renterName), { req: true }) +
          field('電話番号', text('renterPhone', v.renterPhone)) +
          field('住所', text('renterAddress', v.renterAddress), { req: true, wide: true }) +
        '</div></div>' +
        '<div class="rr-sec"><h4>運転者</h4>' +
          '<label class="rr-inline" style="margin-bottom:8px"><input type="checkbox" id="rr-driverSame"' + (v.driverSame ? ' checked' : '') + '> 借受人と同じ</label>' +
          '<div class="rr-grid" id="rr-driver-fields">' +
            field('氏名', text('driverName', v.driverName), { req: true }) +
            field('住所', text('driverAddress', v.driverAddress), { req: true }) +
          '</div></div>' +
        '<div class="rr-sec"><h4>運転免許証</h4><div class="rr-grid">' +
          field('免許の種類', text('licenseType', v.licenseType, ' list="rr-license-types" autocomplete="off"') + lic, { req: true }) +
          field('免許証番号', text('licenseNo', v.licenseNo, ' inputmode="numeric" autocomplete="off"'), { req: true }) +
          field('有効期限', date('licenseExpiry', v.licenseExpiry)) +
          field('生年月日', date('birthDate', v.birthDate)) +
          field('国際免許証 (番号・発行国など)', text('intlLicense', v.intlLicense), { wide: true }) +
        '</div></div>' +
        '<div class="rr-sec"><h4>貸渡しの内容</h4><div class="rr-grid">' +
          field('車両名', text('vehicleName', v.vehicleName)) +
          field('登録番号 (ナンバー)', text('plate', v.plate, ' placeholder="例: 北見300 わ 1234"'), { req: true }) +
          field('貸出日時', dt('start', v.start), { req: true }) +
          field('返却日時', dt('end', v.end), { req: true }) +
          field('利用人数', num('passengers', v.passengers, ' min="1" max="99"'), { req: true }) +
          field('運行区間または行先', text('destination', v.destination, ' placeholder="例: 北見市内〜網走方面"'), { req: true }) +
          field('貸渡事務所', text('pickupOffice', v.pickupOffice), { req: true }) +
          field('返還事務所', text('returnOffice', v.returnOffice), { req: true }) +
          field('迎え場所', text('pickupPlace', v.pickupPlace)) +
          field('送り場所', text('dropoffPlace', v.dropoffPlace)) +
          field('使用目的 (マイクロバスの場合のみ)', text('purpose', v.purpose), { wide: true }) +
        '</div></div>' +
        '<div class="rr-sec" id="rr-sec-odometer"><h4>走行距離</h4><div class="rr-grid">' +
          field('貸出時メーター (km)', num('odometerOut', v.odometerOut, ' min="0"'), { req: true }) +
          field('返却時メーター (km)', num('odometerIn', v.odometerIn, ' min="0"'), { req: true }) +
          '<div class="rr-dist rr-wide">走行キロ数: <b id="rr-distance">-</b></div>' +
        '</div></div>' +
        '<div class="rr-sec"><h4>事故に関する事項</h4>' +
          '<label class="rr-inline" style="margin-right:16px"><input type="radio" name="rr-accident" id="rr-accident-no"' + (v.accident ? '' : ' checked') + '> 事故なし</label>' +
          '<label class="rr-inline"><input type="radio" name="rr-accident" id="rr-accident-yes"' + (v.accident ? ' checked' : '') + '> 事故あり</label>' +
          '<div class="rr-grid" style="margin-top:8px">' + field('事故の内容 (日時・場所・相手方・警察への届出・損傷など)', area('accidentNote', v.accidentNote, 3), { wide: true }) + '</div>' +
        '</div>' +
        '<div class="rr-sec"><h4>オプション・料金</h4><div class="rr-grid">' +
          field('補償制度', text('cover', v.cover)) +
          field('オプション', text('optionsText', v.optionsText)) +
          field('貸出品', text('rentalItems', v.rentalItems)) +
          field('サービス', text('service', v.service)) +
          field('基本料金 (円・税込)', num('baseFee', v.baseFee, ' min="0"')) +
          field('オプション料金 (円・税込)', num('optionFee', v.optionFee, ' min="0"')) +
          field('合計 (円・税込)', num('total', v.total, ' min="0"')) +
          field('決済方法', text('payment', v.payment)) +
        '</div></div>' +
        '<div class="rr-sec"><h4>その他</h4><div class="rr-grid">' +
          field('発行日', date('issuedOn', v.issuedOn)) +
          '<div></div>' +
          field('備考', area('remarks', v.remarks, 3), { wide: true }) +
        '</div></div>' +
      '</div>' +
      '<div class="rr-err" id="rr-err" role="alert" hidden></div>' +
      '<div class="crud-modal-foot" style="flex-wrap:wrap;gap:8px">' +
        (canWrite ? '<button type="button" class="btn btn-primary" id="rr-save">保存</button><button type="button" class="btn btn-gray" id="rr-save-print">保存して貸渡証を表示</button>' : '<span style="font-size:12.5px;color:#888">閲覧のみの権限のため保存できません</span>') +
        '<span style="flex:1"></span><button type="button" class="btn btn-gray crud-cancel">閉じる</button></div></div>';
    const m = openModal(html);
    const modal = m.modal;

    const $m = sel => modal.querySelector(sel);
    function refresh() {
      const same = $m('#rr-driverSame').checked;
      $m('#rr-driver-fields').hidden = same;
      const o = $m('#rr-odometerOut').value, i = $m('#rr-odometerIn').value;
      const dist = o !== '' && i !== '' ? Number(i) - Number(o) : null;
      $m('#rr-distance').textContent = dist == null ? '-' : (dist < 0 ? '返却時メーターが貸出時メーターより小さくなっています' : dist.toLocaleString('ja-JP') + ' km');
      $m('#rr-odometerIn').setAttribute('aria-invalid', dist != null && dist < 0 ? 'true' : 'false');
      $m('#rr-accidentNote').closest('.rr-f').hidden = !$m('#rr-accident-yes').checked;
      const cur = effective(r, Object.assign({}, rec || {}, readForm(modal)));
      const miss = missing(cur, { returned: returned });
      const box = $m('#rr-missing');
      box.className = 'rr-missing' + (miss.length ? '' : ' is-ok');
      box.textContent = miss.length ? '貸渡簿に必要で、まだ入っていない項目: ' + miss.join('・') : '貸渡簿の記載事項はすべて入っています。';
    }
    modal.querySelectorAll('input, textarea').forEach(el => el.addEventListener('input', refresh));
    modal.querySelectorAll('input[type=checkbox], input[type=radio]').forEach(el => el.addEventListener('change', refresh));
    refresh();
    if (opts.focus === 'odometer') {
      const sec = $m('#rr-sec-odometer');
      try { sec.scrollIntoView({ block: 'center' }); } catch (e) { /* 無視 */ }
      const target = r.status === 'in_use' || returned ? $m('#rr-odometerIn') : $m('#rr-odometerOut');
      try { target.focus(); } catch (e) { /* 無視 */ }
    }

    async function save(after) {
      const err = $m('#rr-err');
      err.hidden = true;
      modal.querySelectorAll('[aria-invalid=true]').forEach(el => el.setAttribute('aria-invalid', 'false'));
      const btns = modal.querySelectorAll('#rr-save, #rr-save-print');
      btns.forEach(b => { b.disabled = true; });
      try {
        rec = await B().admin.saveRentalRecord(r.reservationId, readForm(modal), rec ? rec.version : null);
        B().toast('貸渡証 ' + r.reservationId + ' を保存しました。', 'success');
        if (typeof opts.onSaved === 'function') opts.onSaved(rec);
        if (after === 'print') { location.href = 'forms.html?id=' + encodeURIComponent(r.reservationId) + '&doc=loan'; return; }
        m.close();
      } catch (e) {
        btns.forEach(b => { b.disabled = false; });
        const code = e && e.code;
        const fields = (e && e.fields) || {};
        Object.keys(fields).forEach(k => { const el = $m('#rr-' + k); if (el) el.setAttribute('aria-invalid', 'true'); });
        let msg = (e && e._skyrent && e.message) || B().errorMessage(code || 'INTERNAL');
        if (code === 'VALIDATION' && e && e.detail && /[^\x00-\x7F]/.test(String(e.detail))) msg = String(e.detail);
        if (code === 'VERSION_CONFLICT') msg = '他のスタッフが先にこの貸渡証を保存しました。閉じてから開き直してください。';
        err.textContent = msg;
        err.hidden = false;
      }
    }
    const sb = $m('#rr-save'), sp = $m('#rr-save-print');
    if (sb) sb.addEventListener('click', () => save());
    if (sp) sp.addEventListener('click', () => save('print'));
    return m;
  }

  // ===== 貸渡証 / 貸渡簿 (印刷用) =====
  //   ctx: {company, shop, address, tel, kind}
  //   kind: 'loan' = 貸渡証 (お客様に渡す) / 'book' = 貸渡簿 (会社で保管する)。中身は同じで、題名だけ変わる
  function loanDocHtml(r, v, ctx) {
    ctx = ctx || {};
    const book = ctx.kind === 'book';
    const d = driverOf(v);
    const row = (k, val) => '<tr><th>' + esc(k) + '</th><td>' + (val == null || val === '' ? '&nbsp;' : val) + '</td></tr>';
    const sec = (title, rows) => '<table class="ld-t"><thead><tr><th colspan="2">' + esc(title) + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
    const dist = v.distanceKm != null ? v.distanceKm.toLocaleString('ja-JP') + ' km' : '';
    const left =
      sec('貸渡人', row('屋号', esc(ctx.company || '株式会社Skyward Growth')) + row('店舗', esc(ctx.shop || '')) + row('住所', esc(ctx.address || '')) + row('電話番号', esc(ctx.tel || ''))) +
      sec('借受人', row('氏名・名称', esc(v.renterName) + (v.renterName ? ' 様' : '')) + row('住所', esc(v.renterAddress)) + row('電話番号', esc(v.renterPhone))) +
      sec('運転者', row('氏名・名称', esc(d.name)) + row('住所', esc(d.address))) +
      sec('内容', row('貸出日時', esc(fmtDT(v.start))) + row('返却日時', esc(fmtDT(v.end))) + row('貸渡時間', esc(durationText(v.start, v.end))) +
        row('車両名', esc(v.vehicleName)) + row('ナンバー', esc(v.plate)) + row('利用人数', v.passengers ? esc(v.passengers) + ' 人' : '') +
        row('運行区間・行先', esc(v.destination)) + (v.purpose ? row('使用目的', esc(v.purpose)) : '') +
        row('貸出時メーター', v.odometerOut != null && v.odometerOut !== '' ? esc(Number(v.odometerOut).toLocaleString('ja-JP')) + ' km' : '') +
        row('返却時メーター', v.odometerIn != null && v.odometerIn !== '' ? esc(Number(v.odometerIn).toLocaleString('ja-JP')) + ' km' : '') +
        row('走行キロ数', esc(dist)) + row('事故の有無', v.accident ? '有り' + (v.accidentNote ? ' — ' + esc(v.accidentNote) : '') : (v.saved ? '無し' : ''))) +
      sec('オプション', row('補償制度', esc(v.cover)) + row('オプション', esc(v.optionsText)) + row('貸出品', esc(v.rentalItems)) + row('サービス', esc(v.service)) +
        row('貸渡場所', esc(v.pickupOffice)) + row('返却場所', esc(v.returnOffice)) + row('迎え場所', esc(v.pickupPlace)) + row('送り場所', esc(v.dropoffPlace))) +
      sec('料金', row('基本料金', v.baseFee != null && v.baseFee !== '' ? yen(v.baseFee) + ' (税込)' : '') + row('オプション料金', v.optionFee != null && v.optionFee !== '' ? yen(v.optionFee) + ' (税込)' : '') +
        row('合計', v.total != null && v.total !== '' ? yen(v.total) + ' (税込)' : '') + row('決済方法', esc(v.payment)));
    const right =
      sec('運転免許証', row('免許証番号', esc(v.licenseNo)) + row('免許の種類', esc(v.licenseType)) + row('有効期限', esc(fmtYmd(v.licenseExpiry))) + row('生年月日', esc(fmtYmd(v.birthDate)))) +
      sec('国際免許証', row('番号など', esc(v.intlLicense))) +
      '<div class="ld-box"><b>注意書き</b><ol>' +
        '<li>運輸支局、警察署等から本証の提示を求められることがありますので、貸渡期間中は必ず本証を携帯してください。</li>' +
        '<li>当社は運転者付の貸出しあるいは運転者の紹介及び斡旋をお断りしておりますのでご了承ください。</li>' +
        '<li>事故・故障が発生した場合、事故の続発を防ぎ、負傷者の安全確保をした上で、直ちに警察及び出発営業所にご連絡ください。</li>' +
        '<li>貸渡期間が2日以上となる場合は、日常点検を実施してください。</li>' +
      '</ol></div>' +
      '<div class="ld-box"><b>備考</b><div class="ld-remarks">' + esc(v.remarks).replace(/\n/g, '<br>') + '</div></div>' +
      '<div class="ld-box"><b>ご署名</b><div class="ld-sign"></div><small>契約内容及び貸渡約款に同意の上で、ご署名ください。</small></div>';
    return '<div class="doc loan-doc' + (book ? ' book-doc' : '') + '">' +
      '<div class="ld-head"><h1>' + (book ? '貸渡簿' : '貸渡証') + (book ? '<small class="ld-sub">会社保管用</small>' : '') + '</h1><div class="ld-meta">発行日 ' + esc(fmtYmd(v.issuedOn) || fmtYmd(todayYmd())) + '<br>貸渡番号 ' + esc(r.reservationId) + '</div></div>' +
      '<div class="ld-cols"><div class="ld-col">' + left + '</div><div class="ld-col">' + right + '</div></div></div>';
  }
  // 貸渡証の印刷用スタイル (帳票画面に足す)
  const LOAN_DOC_CSS =
    '.loan-doc{max-width:760px;font-size:11.5px;line-height:1.55}' +
    '.loan-doc .ld-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px}' +
    '.loan-doc .ld-head h1{font-size:24px;letter-spacing:4px;border:0;padding:0;margin:0;text-align:left}' +
    '.loan-doc .ld-meta{text-align:right;font-size:11.5px}' +
    '.loan-doc .ld-sub{font-size:12px;letter-spacing:1px;margin-left:10px;font-weight:500;color:#555}' +
    '.doc-pair .loan-doc + .loan-doc{margin-top:28px}' +
    '@media print{.doc-pair .loan-doc + .loan-doc{page-break-before:always;break-before:page;margin-top:0}}' +
    '.loan-doc .ld-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.loan-doc table.ld-t{width:100%;border-collapse:collapse;margin-bottom:8px}' +
    '.loan-doc table.ld-t thead th{background:#f1f1f1;text-align:left;font-size:12px;padding:3px 6px;border:1px solid #999}' +
    '.loan-doc table.ld-t tbody th{width:36%;text-align:left;font-weight:500;padding:3px 6px;border:1px solid #bbb;background:#fafafa;vertical-align:top}' +
    '.loan-doc table.ld-t tbody td{padding:3px 6px;border:1px solid #bbb;vertical-align:top;word-break:break-all}' +
    '.loan-doc .ld-box{margin-bottom:8px}.loan-doc .ld-box b{display:block;margin-bottom:3px}' +
    '.loan-doc .ld-box ol{margin:0 0 0 1.3em;padding:0}.loan-doc .ld-box li{margin-bottom:2px}' +
    '.loan-doc .ld-remarks{border:1px solid #999;min-height:90px;padding:6px;border-radius:3px}' +
    '.loan-doc .ld-sign{border:1px solid #999;height:46px;border-radius:3px;margin-bottom:3px}';

  // ===================================================================
  // 予約の状態を変える (予約一覧・予約表で共通)。本番は admin_update_reservation を待って結果を反映する
  //   updates: store の形 (デモ)、patch: DB の形 (本番)。版 (version) が違えば VERSION_CONFLICT
  // ===================================================================
  async function applyChange(id, updates, patch) {
    if (!B().live) return S().updateReservation(id, updates);
    const c = B().client;
    if (!c) throw new Error('NETWORK');
    const cur = S().findById('reservations', 'reservationId', id);
    const version = cur && cur.version != null && isFinite(Number(cur.version)) ? Number(cur.version) : null;
    const res = await c.rpc('admin_update_reservation', { p_id: id, p_patch: patch, p_version: version });
    if (res.error) throw res.error;
    const row = B().fromDb.reservation(res.data);
    const list = S().list('reservations');
    const i = list.findIndex(x => x.reservationId === row.reservationId);
    if (i >= 0) list[i] = row; else list.push(row);
    S()._hydrate({ reservations: list });
    return row;
  }
  function errText(e) {
    const msg = String((e && e.message) || '');
    if (e && e._skyrent && msg) return msg;
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(msg)) return B().errorMessage(msg);
    if (e && e.code && /^[A-Z][A-Z_]+$/.test(String(e.code))) return B().errorMessage(e.code);
    if (e && (e.code === '42501' || /permission denied|row-level security/i.test(msg))) return B().errorMessage('FORBIDDEN');
    return B().errorMessage('INTERNAL');
  }

  function isVehicleRes(r) {
    if (!r || r.kind === 'block') return false;
    const a = S().getAsset(r.assetId);
    const c = S().getCategory(r.categoryId || (a && a.categoryId));
    return !!(c && c.type === 'vehicle');
  }
  const kmOf = v => (v == null || v === '' ? null : Number(v));

  // 車両ごとの最新のメーター (貸渡証の貸出時・返却時メーターのうち、いちばん大きい値)
  //   records: rentalRecords()、戻り値: {assetId: {km, firstKm, at}}
  function odometerByAsset(records) {
    const out = {};
    (records || []).forEach(rec => {
      const r = S().findById('reservations', 'reservationId', rec.id);
      if (!r || !isVehicleRes(r)) return;
      [kmOf(rec.odometerOut), kmOf(rec.odometerIn)].forEach(km => {
        if (km == null || !isFinite(km)) return;
        const o = out[r.assetId] || (out[r.assetId] = { km: km, firstKm: km, at: r.end });
        if (km > o.km) { o.km = km; o.at = r.end; }
        if (km < o.firstKm) o.firstKm = km;
      });
    });
    return out;
  }

  // ===== オイル交換の目安 (既定は 5,000 km ごと。残り 500 km から「そろそろ」) =====
  //   車両の oil = {intervalKm, lastKm, lastDate} (管理画面の車両で設定。本番は assets.extra.oil)
  //   前回の交換が未登録なら、記録の中でいちばん小さいメーターから数える (目安)
  const OIL_DEFAULT_KM = 5000, OIL_SOON_KM = 500;
  function oilStatus(asset, odo) {
    const oil = (asset && asset.oil) || {};
    const interval = Number(oil.intervalKm) > 0 ? Number(oil.intervalKm) : OIL_DEFAULT_KM;
    if (!odo) return { level: 'unknown', intervalKm: interval };
    const baseKnown = oil.lastKm != null && oil.lastKm !== '' && isFinite(Number(oil.lastKm));
    const base = baseKnown ? Number(oil.lastKm) : odo.firstKm;
    const since = odo.km - base;
    const remaining = interval - since;
    const level = remaining <= 0 ? 'due' : (remaining <= OIL_SOON_KM ? 'soon' : 'ok');
    return { level: level, intervalKm: interval, current: odo.km, base: base, baseKnown: baseKnown, since: since, remaining: remaining, lastDate: oil.lastDate || null };
  }
  function oilText(asset, st) {
    if (!st || st.level === 'unknown') return '';
    if (st.level === 'due') return (asset.name || '') + ': オイル交換の時期を過ぎています (前回から ' + st.since.toLocaleString('ja-JP') + ' km)';
    return (asset.name || '') + ': そろそろオイル交換です (あと ' + st.remaining.toLocaleString('ja-JP') + ' km)';
  }
  // オイル交換が近い・過ぎている車両 [{asset, st, text}]
  async function oilAlerts(records) {
    if (!records) records = await B().admin.rentalRecords();
    const odo = odometerByAsset(records);
    return S().assets({ activeOnly: true }).filter(a => {
      const c = S().getCategory(a.categoryId);
      return c && c.type === 'vehicle';
    }).map(a => ({ asset: a, st: oilStatus(a, odo[a.assetId]) }))
      .filter(x => x.st.level === 'due' || x.st.level === 'soon')
      .map(x => Object.assign(x, { text: oilText(x.asset, x.st) }));
  }
  // オイル交換をしたことを記録する (いまのメーターを前回の交換時に)。本番は車両の保存 (catalog.write の権限)
  function markOilChanged(asset, km) {
    const oil = Object.assign({}, asset.oil || {}, { lastKm: Number(km), lastDate: todayYmd() });
    if (!(Number(oil.intervalKm) > 0)) oil.intervalKm = OIL_DEFAULT_KM;
    S().upsert('assets', 'assetId', { assetId: asset.assetId, oil: oil });
    return oil;
  }

  // ===== 走行距離の入れ忘れ (貸出中で貸出時メーターが無い / 返却済みで返却時メーターが無い) =====
  //   days: 返却済みは、返却がこの日数以内のものだけ見る
  function mileageGaps(records, days) {
    const byId = {};
    (records || []).forEach(x => { byId[x.id] = x; });
    const since = Date.now() - (days || 60) * DAY;
    const out = [];
    S().list('reservations').forEach(r => {
      if (!isVehicleRes(r)) return;
      const rec = byId[r.reservationId] || {};
      if ((r.status === 'in_use' || r.status === 'returned') && kmOf(rec.odometerOut) == null) {
        if (r.status === 'in_use' || Date.parse(r.end) >= since) out.push({ r: r, missing: 'out' });
      }
      if (r.status === 'returned' && kmOf(rec.odometerIn) == null && Date.parse(r.end) >= since) out.push({ r: r, missing: 'in' });
    });
    // 貸出中を先に、そのあとは返却の新しい順
    return out.sort((x, y) => (x.r.status === 'in_use' ? 0 : 1) - (y.r.status === 'in_use' ? 0 : 1) || Date.parse(y.r.end) - Date.parse(x.r.end));
  }

  // ===== 貸出処理・返却処理 (走行距離の入力つき) =====
  //   kind: 'out' = 貸出 (出発) / 'in' = 返却。メーターが空のときは「入力されていません」と確かめてから進む。
  //   opts.onDone(row): 状態を変えたあと
  async function openHandover(r, kind, opts) {
    opts = opts || {};
    ensureStyle();
    const out = kind === 'out';
    let rec = null, records = [];
    try {
      rec = await B().admin.rentalRecord(r.reservationId);
      records = await B().admin.rentalRecords(S().list('reservations').filter(x => x.assetId === r.assetId).map(x => x.reservationId));
    } catch (e) { B().toast(errText(e), 'error'); return null; }
    const odo = odometerByAsset(records.filter(x => x.id !== r.reservationId))[r.assetId];
    const v = effective(r, rec);
    const outKnown = v.odometerOut != null && v.odometerOut !== '';
    const title = out ? '貸出処理 (出発)' : '返却処理';
    const html =
      '<div class="crud-modal-bg"></div><div class="crud-modal-card" style="min-width:440px;max-width:540px">' +
      '<div class="crud-modal-head"><h3>' + title + ' <code style="background:rgba(255,255,255,.2);color:#fff;font-size:12px;margin-left:6px;padding:2px 8px;border-radius:2px">' + esc(r.reservationId) + '</code></h3><button class="crud-close" type="button" aria-label="閉じる">×</button></div>' +
      '<div class="rr-body">' +
        '<p style="margin:0 0 10px;font-size:13px"><strong>' + esc(r.assetName || r.vehicleName) + '</strong> / ' + esc(r.customerName) + ' 様<br>' + esc(fmtDT(r.start)) + ' 〜 ' + esc(fmtDT(r.end)) + '</p>' +
        '<div class="rr-grid">' +
          (out
            ? field('貸出時メーター (km)', num('odoOut', v.odometerOut, ' min="0"'), { req: true, wide: true })
            : (outKnown
                ? '<div class="rr-wide" style="font-size:13px;color:#555">貸出時メーター: <b>' + Number(v.odometerOut).toLocaleString('ja-JP') + ' km</b></div>'
                : field('貸出時メーター (km)', num('odoOut', '', ' min="0" placeholder="未入力です"'), { req: true })) +
              field('返却時メーター (km)', num('odoIn', v.odometerIn, ' min="0"'), { req: true, wide: outKnown }) +
              '<div class="rr-wide"><label class="rr-inline" style="margin-right:16px"><input type="radio" name="rr-acc" id="rr-acc-no"' + (v.accident ? '' : ' checked') + '> 事故なし</label>' +
              '<label class="rr-inline"><input type="radio" name="rr-acc" id="rr-acc-yes"' + (v.accident ? ' checked' : '') + '> 事故あり</label></div>' +
              field('事故の内容', area('accNote', v.accidentNote, 2), { wide: true })) +
          '<div class="rr-dist rr-wide" id="rr-ho-info"></div>' +
        '</div>' +
        '<p style="font-size:12px;color:#777;margin:10px 0 0">免許証・住所・行先などは「貸渡証を編集」から入力できます。</p>' +
      '</div>' +
      '<div class="rr-err" id="rr-ho-err" role="alert" hidden></div>' +
      '<div class="crud-modal-foot" style="flex-wrap:wrap;gap:8px"><button type="button" class="btn btn-primary" id="rr-ho-go">' + (out ? '貸出処理をする' : '返却処理をする') + '</button>' +
        '<button type="button" class="btn btn-gray" id="rr-ho-edit">貸渡証を編集</button><span style="flex:1"></span><button type="button" class="btn btn-gray crud-cancel">閉じる</button></div></div>';
    const m = openModal(html);
    const modal = m.modal;
    const $m = sel => modal.querySelector(sel);
    const input = $m(out ? '#rr-odoOut' : '#rr-odoIn');
    const outInput = !out && !outKnown ? $m('#rr-odoOut') : null;   // 返却時に、入れ忘れた貸出時メーターも入れられる
    const outVal = () => (outInput ? (outInput.value === '' ? null : Number(outInput.value)) : (outKnown ? Number(v.odometerOut) : null));
    function info() {
      const val = input.value === '' ? null : Number(input.value);
      const parts = [];
      if (odo) parts.push('この車両の最新の記録: ' + odo.km.toLocaleString('ja-JP') + ' km');
      const first = out ? val : outVal();
      if (first != null && odo && first < odo.km) parts.push('⚠ 最新の記録より小さい値です');
      if (!out && val != null && outVal() != null) {
        const d = val - outVal();
        parts.push(d >= 0 ? '走行キロ数: ' + d.toLocaleString('ja-JP') + ' km' : '⚠ 貸出時メーターより小さい値です');
      }
      $m('#rr-ho-info').textContent = parts.join(' / ');
      if (!out) $m('#rr-accNote').closest('.rr-f').hidden = !$m('#rr-acc-yes').checked;
    }
    modal.querySelectorAll('input, textarea').forEach(el => el.addEventListener('input', info));
    modal.querySelectorAll('input[type=radio]').forEach(el => el.addEventListener('change', info));
    info();
    try { input.focus(); } catch (e) { /* 無視 */ }
    $m('#rr-ho-edit').addEventListener('click', () => { m.close(); openEditor(r, { focus: 'odometer', onSaved: opts.onSaved }); });
    $m('#rr-ho-go').addEventListener('click', async () => {
      const err = $m('#rr-ho-err');
      err.hidden = true;
      const raw = input.value.trim();
      if (outInput && outInput.value.trim() === '' && raw !== '' &&
          !window.confirm('貸出時の走行距離 (メーター) が入力されていません。\n返却時メーターだけで返却処理をしますか? (走行キロ数は計算できません)')) { try { outInput.focus(); } catch (e) { /* 無視 */ } return; }
      if (raw === '') {
        const q = out
          ? '貸出時の走行距離 (メーター) が入力されていません。\n入力せずに貸出処理をしますか? (あとから「走行距離を入力」で入れられます)'
          : '返却時の走行距離 (メーター) が入力されていません。\n入力せずに返却処理をしますか? (あとから「走行距離を入力」で入れられます)';
        if (!window.confirm(q)) { try { input.focus(); } catch (e) { /* 無視 */ } return; }
      }
      const btn = $m('#rr-ho-go');
      btn.disabled = true;
      try {
        const patch = out ? { odometerOut: raw } : { odometerIn: raw, accident: $m('#rr-acc-yes').checked, accidentNote: $m('#rr-accNote').value };
        if (outInput && outInput.value.trim() !== '') patch.odometerOut = outInput.value.trim();
        if (raw !== '' || !out) rec = await B().admin.saveRentalRecord(r.reservationId, patch, rec ? rec.version : null);
        const status = out ? 'in_use' : 'returned';
        const row = await applyChange(r.reservationId, { status: status }, { status: status });
        m.close();
        B().toast('予約 ' + r.reservationId + (out ? ' を貸出中にしました。' : ' を返却済にしました。'), 'success');
        if (raw === '') B().toast((out ? '貸出時' : '返却時') + 'の走行距離が未入力です。忘れずに入力してください。', 'warn');
        // 返却したら、その車両のオイル交換の目安を確かめる
        if (!out) {
          try {
            const all = await B().admin.rentalRecords(S().list('reservations').filter(x => x.assetId === r.assetId).map(x => x.reservationId));
            const a = S().getAsset(r.assetId);
            const st = oilStatus(a, odometerByAsset(all)[r.assetId]);
            if (st.level === 'due' || st.level === 'soon') window.alert('🛢 ' + oilText(a, st) + '\n(車両・物品管理、または予約表の「オイル交換済みにする」で記録できます)');
          } catch (e) { /* 目安の表示だけ */ }
        }
        if (typeof opts.onDone === 'function') opts.onDone(row);
      } catch (e) {
        btn.disabled = false;
        err.textContent = (e && e.code === 'VALIDATION' && e.detail && /[^\x00-\x7F]/.test(String(e.detail))) ? String(e.detail) : errText(e);
        // 他のスタッフが先に更新していたら、読み込み直してもらう
        if (/VERSION_CONFLICT/.test(String((e && (e.code + ' ' + e.message)) || ''))) {
          const rb = document.createElement('button');
          rb.type = 'button'; rb.className = 'btn btn-gray'; rb.id = 'rr-ho-reload'; rb.textContent = '最新の内容を読み込む';
          rb.style.cssText = 'margin-left:10px;padding:3px 10px;font-size:12px';
          rb.addEventListener('click', () => location.reload());
          err.appendChild(rb);
        }
        err.hidden = false;
      }
    });
    return m;
  }

  // ===== お知らせ欄 (走行距離の入れ忘れ・オイル交換の目安)。ダッシュボード・予約一覧・予約表の上に出す =====
  //   el: 入れる場所、opts.records: 読み込み済みの貸渡証 (省略すると読む)、opts.onChange(): 入力・交換の記録のあと (画面を読み直す)
  async function renderAlerts(el, opts) {
    if (!el) return;
    opts = opts || {};
    ensureStyle();
    let records = opts.records;
    if (!records) {
      try { records = await B().admin.rentalRecords(); } catch (e) { el.hidden = true; return; }
    }
    const gaps = mileageGaps(records, 60);
    const oils = await oilAlerts(records);
    if (!gaps.length && !oils.length) { el.hidden = true; el.innerHTML = ''; return; }
    const MAX = 5;
    const canCatalog = !B().admin.can || B().admin.can('catalog.write');
    let html = '';
    // 同じ予約の 貸出時・返却時 は1行にまとめる
    const byRes = [];
    gaps.forEach(g => {
      const hit = byRes.find(x => x.r.reservationId === g.r.reservationId);
      if (hit) hit.missing.push(g.missing); else byRes.push({ r: g.r, missing: [g.missing] });
    });
    if (byRes.length) {
      html += '<div class="rr-al rr-al-odo" data-alert="odometer"><strong>⚠ 走行距離 (メーター) が入力されていない予約が ' + byRes.length + ' 件あります</strong><ul>' +
        byRes.slice(0, MAX).map((g, i) => '<li data-gap-id="' + esc(g.r.reservationId) + '">' + esc(g.r.reservationId) + ' ' + esc(fmtDT(g.r.start)) + ' ' + esc(g.r.assetName || g.r.vehicleName) + ' / ' + esc(g.r.customerName) + ' 様 — ' +
          g.missing.map(x => (x === 'out' ? '貸出時' : '返却時')).join('・') + 'の走行距離が入力されていません ' +
          '<button type="button" class="rr-al-btn" data-gap="' + i + '">入力する</button></li>').join('') +
        (byRes.length > MAX ? '<li>ほか ' + (byRes.length - MAX) + ' 件 (<a href="rental-ledger.html">貸渡簿</a>の「足りない項目がある行だけ」で確認できます)</li>' : '') + '</ul></div>';
    }
    if (oils.length) {
      html += '<div class="rr-al rr-al-oil" data-alert="oil"><strong>🛢 オイル交換のお知らせ</strong><ul>' +
        oils.map((o, i) => '<li>' + esc(o.text) + ' <small>(メーター ' + o.st.current.toLocaleString('ja-JP') + ' km / ' + o.st.intervalKm.toLocaleString('ja-JP') + ' km ごと' + (o.st.baseKnown ? '' : '・前回の交換が未登録のため最初の記録から計算') + ')</small>' +
          (canCatalog ? ' <button type="button" class="rr-al-btn" data-oil="' + i + '">交換済みにする</button>' : '') + '</li>').join('') + '</ul></div>';
    }
    el.innerHTML = html;
    el.hidden = false;
    const refresh = () => { renderAlerts(el, opts); if (typeof opts.onChange === 'function') opts.onChange(); };
    el.querySelectorAll('[data-gap]').forEach(b => b.addEventListener('click', () => {
      openEditor(byRes[Number(b.dataset.gap)].r, { focus: 'odometer', onSaved: refresh });
    }));
    el.querySelectorAll('[data-oil]').forEach(b => b.addEventListener('click', () => {
      const o = oils[Number(b.dataset.oil)];
      const v = window.prompt(o.asset.name + ' のオイル交換を記録します。\n交換したときのメーター (km) を入れてください。', String(o.st.current));
      if (v == null) return;
      const km = Number(String(v).replace(/[,\s]/g, ''));
      if (!(km >= 0) || !isFinite(km) || Math.floor(km) !== km) { window.alert('メーターは 0 以上の整数 (km) で入れてください'); return; }
      markOilChanged(o.asset, km);
      B().toast(o.asset.name + ' のオイル交換を記録しました (' + km.toLocaleString('ja-JP') + ' km)', 'success');
      refresh();
    }));
  }

  window.SkyRentRentalRecord = {
    LICENSE_TYPES: LICENSE_TYPES,
    defaults: defaults, effective: effective, missing: missing, driverOf: driverOf, durationText: durationText,
    isItemRes: isItemRes, isVehicleRes: isVehicleRes, openEditor: openEditor, loanDocHtml: loanDocHtml, LOAN_DOC_CSS: LOAN_DOC_CSS,
    applyChange: applyChange, errText: errText, openHandover: openHandover, mileageGaps: mileageGaps,
    odometerByAsset: odometerByAsset, oilStatus: oilStatus, oilText: oilText, oilAlerts: oilAlerts, markOilChanged: markOilChanged,
    renderAlerts: renderAlerts, OIL_DEFAULT_KM: OIL_DEFAULT_KM, OIL_SOON_KM: OIL_SOON_KM
  };
})();
