// پنل مدیریت. احراز هویت و مجوزها سمت سرور اعمال می‌شود؛ این فایل فقط رابط کاربری است.
import { toFaDigits, parseJalaliInput, isoToJalaliString, normalizeDigits } from './jalali.js';

const root = document.getElementById('root');
const fa = (n) => new Intl.NumberFormat('fa-IR').format(n);
const money = (n) => `${fa(n)} تومان`;
const ft = (s) => toFaDigits(s);
let csrf = null;
let sys = null;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }
    else if (k === 'value') el.value = v; else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c.nodeType ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  let res;
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('ارتباط با سرور برقرار نشد.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.endsWith('/login')) { csrf = null; renderLogin(); }
    throw Object.assign(new Error(json?.error?.message || 'خطایی رخ داد.'), { fields: json?.error?.fields, status: res.status });
  }
  return json;
}

let toastTimer;
function toast(msg, bad = false) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: `toast alert ${bad ? '' : 'info'}`, role: 'status' }, msg);
  document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function field(label, input, hint) { return h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'help', text: hint }) : null); }
const inp = (v = '', props = {}) => h('input', { value: v, ...props });

/* ---------- ورود ---------- */
function renderLogin(msg) {
  const u = inp('', { autocomplete: 'username', class: 'ltr', 'aria-label': 'نام کاربری' }), p = inp('', { type: 'password', autocomplete: 'current-password', class: 'ltr', 'aria-label': 'رمز عبور' });
  const err = h('div', { class: 'err', role: 'alert', text: msg || '' });
  const go = guard(async () => { err.textContent = ''; try { const r = await api('/admin/api/login', { method: 'POST', body: { username: u.value, password: p.value } }); csrf = r.csrf; boot(); } catch (e) { err.textContent = e.message; } });
  root.replaceChildren(h('main', { class: 'wrap login' }, h('div', { class: 'card' }, h('h1', { text: 'ورود به پنل مدیریت', style: 'font-size:1.4rem;margin-bottom:1rem' }),
    field('نام کاربری', u), field('رمز عبور', p), err, h('button', { class: 'btn btn-gold', style: 'width:100%;margin-top:.8rem', onclick: go }, 'ورود'))));
  p.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  u.focus();
}

/* ---------- قاب اصلی ---------- */
const TABS = [['bookings', 'نوبت‌ها'], ['schedule', 'برنامه کاری'], ['services', 'خدمات'], ['report', 'گزارش'], ['settings', 'تنظیمات']];
let tab = 'bookings';
function shell() {
  const main = h('main', { class: 'wrap' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, t]) => h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; shell(); } }, t)));
  root.replaceChildren(h('header', { class: 'adm-top' }, h('div', { class: 'wrap' }, h('b', { text: 'پنل مدیریت' }),
    sys.gateway_is_test ? h('span', { class: 'tag warn', text: 'درگاه آزمایشی' }) : h('span', { class: 'tag ok', text: `درگاه: ${sys.gateway}` }),
    h('span', { class: 'tag', text: `امروز: ${sys.today_long}` }),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: guard(async () => { await api('/admin/api/logout', { method: 'POST', body: {} }); csrf = null; renderLogin(); }) }, 'خروج'), tabs)), main);
  ({ bookings: viewBookings, schedule: viewSchedule, services: viewServices, report: viewReport, settings: viewSettings })[tab](main);
}

/* ---------- نوبت‌ها ---------- */
const stTag = (b) => h('span', { class: `tag ${b.status === 'confirmed' ? 'ok' : b.status === 'pending_payment' ? 'warn' : 'bad'}`, text: b.status_fa });
async function viewBookings(main) {
  const f = { q: '', status: '', from: sys.today_jalali.replaceAll('/', '/'), to: '', needs_refund: false, order: 'asc' };
  const q = inp('', { placeholder: 'نام، موبایل یا کد پیگیری' }), st = h('select', {}, [['', 'همه‌ی وضعیت‌ها'], ['confirmed', 'قطعی‌شده'], ['pending_payment', 'در انتظار پرداخت'], ['cancelled', 'لغوشده'], ['expired', 'منقضی‌شده']].map(([v, t]) => h('option', { value: v, text: t })));
  const from = inp(ft(f.from), { class: 'ltr', placeholder: '۱۴۰۵/۰۷/۲۵' }), to = inp('', { class: 'ltr', placeholder: 'تا (شمسی)' });
  const refund = h('input', { type: 'checkbox' });
  const list = h('div', {});
  const load = guard(async () => {
    const qs = new URLSearchParams();
    const pf = from.value.trim() ? parseJalaliInput(from.value) : null, pt = to.value.trim() ? parseJalaliInput(to.value) : null;
    if (from.value.trim() && !pf) throw new Error('تاریخ شروع نامعتبر است (نمونه: ۱۴۰۵/۰۷/۲۵).');
    if (to.value.trim() && !pt) throw new Error('تاریخ پایان نامعتبر است.');
    if (pf) qs.set('from', pf); if (pt) qs.set('to', pt); if (q.value.trim()) qs.set('q', q.value.trim()); if (st.value) qs.set('status', st.value); if (refund.checked) qs.set('needs_refund', '1');
    const { bookings, total } = await api(`/admin/api/bookings?${qs}`);
    const csv = h('a', { class: 'btn btn-ghost btn-sm', href: `/admin/api/export.csv?${qs}` }, 'خروجی CSV');
    list.replaceChildren(h('p', { class: 'hint', text: `${fa(total)} نوبت` }), csv, bookings.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['تاریخ', 'ساعت', 'مشتری', 'موبایل', 'وضعیت', 'پرداخت', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, bookings.map((b) => h('tr', {}, h('td', { text: `${b.weekday} ${ft(b.jalali_date)}` }), h('td', { class: 'num', text: ft(b.start_time) }),
        h('td', {}, `${b.first_name} ${b.last_name}`, h('div', { class: 'hint num', text: ft(b.code) })), h('td', { class: 'num ltr', text: ft(b.phone) }),
        h('td', {}, stTag(b), b.attendance_fa ? h('div', { class: 'hint', text: b.attendance_fa }) : null),
        h('td', {}, h('span', { class: `tag ${b.payment_status === 'paid' ? 'ok' : ''}`, text: b.payment_fa }), b.gateway === 'mock' ? h('div', { class: 'hint', text: 'آزمایشی' }) : null, b.needs_refund ? h('div', { class: 'tag bad', text: 'نیازمند بازپرداخت' }) : null),
        h('td', {}, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openBooking(b.id, load) }, 'جزئیات'))))))) : h('div', { class: 'empty-state', text: 'نوبتی با این فیلتر پیدا نشد.' }));
  });
  main.append(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, field('جست‌وجو', q), field('وضعیت', st), field('از تاریخ (شمسی)', from), field('تا تاریخ (شمسی)', to),
    h('label', { class: 'inline-check' }, refund, 'فقط نیازمند بازپرداخت'), h('button', { class: 'btn btn-gold btn-sm', onclick: load }, 'اعمال')), list));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  load();
}

async function openBooking(id, reload) {
  const { booking: b, payments } = await api(`/admin/api/bookings/${id}`);
  const close = () => dlg.remove();
  const act = (fn, okMsg) => guard(async () => { await fn(); toast(okMsg); close(); reload(); });
  const reason = inp('', { placeholder: 'دلیل لغو (اختیاری)' });
  const dep = h('select', {}, [['undecided', 'بیعانه: بعداً تعیین می‌شود'], ['refund_due', 'بیعانه بازپرداخت می‌شود'], ['forfeited', 'بیعانه سوخت می‌شود']].map(([v, t]) => h('option', { value: v, text: t })));
  const dl = (k, v) => h('div', { class: 'day-row' }, h('span', { text: k }), h('b', { text: v }));
  const dlg = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'card' }, h('h2', { text: `نوبت ${ft(b.code)}` }),
    dl('مشتری', `${b.first_name} ${b.last_name}`), dl('موبایل', ft(b.phone)), dl('زمان', `${b.weekday} ${ft(b.jalali_date)}، ${ft(b.start_time)} تا ${ft(b.end_time)}`), dl('خدمت', b.service_name),
    dl('قیمت کامل / بیعانه / باقی‌مانده', `${money(b.price_toman)} / ${money(b.deposit_toman)} / ${money(b.remaining_toman)}`), dl('وضعیت', `${b.status_fa} — ${b.payment_fa}`),
    b.attendance_fa ? dl('مراجعه', b.attendance_fa) : null, b.remaining_settled ? dl('باقی‌مانده', 'تسویه شده') : null, b.admin_note ? h('p', { class: 'note', text: b.admin_note }) : null,
    payments.length ? h('div', {}, h('h3', { text: 'تراکنش‌ها', style: 'font-size:1rem;margin:.8rem 0 .3rem' }), payments.map((p) => h('div', { class: 'hint num', text: `${p.gateway} • ${p.status} • ${fa(p.amount_toman)} • ${p.ref_id || '-'}` }))) : null,
    h('div', { class: 'btn-row', style: 'justify-content:flex-start' },
      b.status === 'confirmed' ? [h('button', { class: 'btn btn-ghost btn-sm', onclick: act(() => api(`/admin/api/bookings/${id}/attendance`, { method: 'POST', body: { value: 'attended' } }), 'ثبت شد') }, 'مراجعه کرد'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: act(() => api(`/admin/api/bookings/${id}/attendance`, { method: 'POST', body: { value: 'no_show' } }), 'ثبت شد') }, 'مراجعه نکرد'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: act(() => api(`/admin/api/bookings/${id}/settle`, { method: 'POST', body: { settled: !b.remaining_settled } }), 'ثبت شد') }, b.remaining_settled ? 'لغو تسویه' : 'ثبت تسویه‌ی باقی‌مانده')] : null,
      b.status !== 'confirmed' && b.payment_status !== 'paid' ? h('button', { class: 'btn btn-ghost btn-sm', onclick: act(async () => { const r = await api(`/admin/api/bookings/${id}/reconcile`, { method: 'POST', body: {} }); toast(`نتیجه‌ی استعلام: ${r.results.join('، ') || 'تراکنشی نبود'}`); }, 'استعلام انجام شد') }, 'استعلام تراکنش از درگاه') : null,
      b.payment_status === 'paid' && (b.needs_refund || b.status === 'cancelled') ? h('button', { class: 'btn btn-ghost btn-sm', onclick: act(() => api(`/admin/api/bookings/${id}/refunded`, { method: 'POST', body: {} }), 'ثبت شد') }, 'بازپرداخت انجام شد') : null),
    ['confirmed', 'pending_payment'].includes(b.status) ? h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', { text: 'لغو نوبت', style: 'font-size:1rem;margin-bottom:.5rem' }), reason, b.payment_status === 'paid' ? dep : null,
      h('p', { class: 'hint', text: 'بازپرداخت واقعی را از پنل درگاه پرداخت انجام دهید و سپس «بازپرداخت انجام شد» را بزنید.' }),
      h('button', { class: 'btn btn-danger btn-sm', onclick: act(() => api(`/admin/api/bookings/${id}/cancel`, { method: 'POST', body: { reason: reason.value, deposit: b.payment_status === 'paid' ? dep.value : 'undecided' } }), 'نوبت لغو شد') }, 'لغو نوبت')) : null,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ghost', onclick: close }, 'بستن'))));
  document.body.append(dlg);
}

/* ---------- برنامه کاری ---------- */
async function viewSchedule(main) {
  const { hours } = await api('/admin/api/hours');
  const names = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
  const rows = hours.map((x) => ({ x, open: h('input', { type: 'checkbox', checked: !!x.is_open }), s: inp(x.start_time, { type: 'time', class: 'ltr' }), e: inp(x.end_time, { type: 'time', class: 'ltr' }) }));
  const hoursCard = h('div', { class: 'card' }, h('h2', { text: 'روزها و ساعات کاری هفتگی' }),
    sys.hours_are_default ? h('p', { class: 'note', text: 'این ساعات پیش‌فرض هستند. ساعت واقعی آرایشگاه را وارد و ذخیره کنید.' }) : null,
    rows.map((r, i) => h('div', { class: 'day-row' }, h('label', { class: 'inline-check' }, r.open, h('b', { text: names[i] })), h('span', { class: 'chips' }, r.s, h('span', { text: 'تا' }), r.e))),
    h('p', { class: 'hint', text: 'طول هر نوبت برابر مدت خدمت است؛ ساعت‌ها از زمان شروع به‌صورت پشت‌سرهم ساخته می‌شوند.' }),
    h('button', { class: 'btn btn-gold btn-sm', onclick: guard(async () => { await api('/admin/api/hours', { method: 'PUT', body: { hours: rows.map((r, i) => ({ weekday: i, is_open: r.open.checked, start_time: r.s.value, end_time: r.e.value })) } }); sys.hours_are_default = false; toast('ساعات کاری ذخیره شد.'); }) }, 'ذخیره'));

  const cal = h('div', {}), blk = h('div', {});
  const loadCal = guard(async () => {
    const { days } = await api('/admin/api/calendar?count=45');
    cal.replaceChildren(days.filter((d) => d.weekly_open || d.closed).map((d) => h('div', { class: 'day-row' }, h('span', {}, `${d.weekday} ${ft(d.jalali)}`, d.bookings ? h('span', { class: 'tag warn', text: `${fa(d.bookings)} نوبت` }) : null, d.reason ? h('span', { class: 'hint', text: ` ${d.reason}` }) : null),
      h('button', { class: `btn btn-sm ${d.closed ? 'btn-gold' : 'btn-ghost'}`, onclick: guard(async () => {
        if (d.closed) await api(`/admin/api/closed/${d.date}`, { method: 'DELETE' });
        else { const r = await api('/admin/api/closed', { method: 'POST', body: { date: d.date, reason: 'تعطیل' } }); if (r.conflicts) toast(`توجه: ${fa(r.conflicts)} نوبت در این روز ثبت شده؛ برای آن‌ها لغو یا هماهنگی لازم است.`, true); }
        loadCal();
      }) }, d.closed ? 'بازکردن روز' : 'تعطیل‌کردن'))));
  });
  const bd = inp('', { class: 'ltr', placeholder: '۱۴۰۵/۰۷/۲۵' }), bs = inp('10:00', { type: 'time', class: 'ltr' }), be = inp('11:00', { type: 'time', class: 'ltr' }), br = inp('', { placeholder: 'دلیل (اختیاری)' });
  const loadBlk = guard(async () => {
    const { blocked } = await api('/admin/api/blocked');
    blk.replaceChildren(blocked.length ? blocked.map((b) => h('div', { class: 'day-row' }, h('span', { text: `${b.weekday} ${ft(b.jalali)}، ${ft(b.start_time)} تا ${ft(b.end_time)} ${b.reason}` }), h('button', { class: 'btn btn-ghost btn-sm', onclick: guard(async () => { await api(`/admin/api/blocked/${b.id}`, { method: 'DELETE' }); loadBlk(); }) }, 'حذف'))) : h('p', { class: 'hint', text: 'زمان مسدودشده‌ای وجود ندارد.' }));
  });
  const blockCard = h('div', { class: 'card' }, h('h2', { text: 'مسدودکردن زمان خاص' }), h('div', { class: 'toolbar' }, field('تاریخ (شمسی)', bd), field('از', bs), field('تا', be), field('دلیل', br),
    h('button', { class: 'btn btn-gold btn-sm', onclick: guard(async () => {
      const iso = parseJalaliInput(bd.value); if (!iso) throw new Error('تاریخ نامعتبر است (نمونه: ۱۴۰۵/۰۷/۲۵).');
      const r = await api('/admin/api/blocked', { method: 'POST', body: { date: iso, start_time: bs.value, end_time: be.value, reason: br.value } });
      if (r.conflicts) toast(`توجه: ${fa(r.conflicts)} نوبت در این بازه ثبت شده است.`, true); else toast('ثبت شد.'); loadBlk();
    }) }, 'مسدودکردن')), blk);
  main.append(hoursCard, h('div', { class: 'card' }, h('h2', { text: 'تعطیلات (۴۵ روز آینده)' }), cal), blockCard);
  loadCal(); loadBlk();
}

/* ---------- خدمات ---------- */
async function viewServices(main) {
  const { services } = await api('/admin/api/services');
  const rowCard = (s) => {
    const n = inp(s?.name || '', {}), d = inp(s?.duration_min ?? 60, { type: 'number', min: 15, max: 480 }), p = inp(s?.price_toman ?? '', { class: 'ltr', inputmode: 'numeric' }), dp = inp(s?.deposit_toman ?? '', { class: 'ltr', inputmode: 'numeric' });
    const act = h('input', { type: 'checkbox', checked: s ? !!s.active : true });
    const num = (el) => Number(normalizeDigits(el.value).replace(/[,٬\s]/g, ''));
    return h('div', { class: 'card' }, h('h2', { text: s ? s.name : 'خدمت جدید' }), h('div', { class: 'grid c4' }, field('نام خدمت', n), field('مدت (دقیقه)', d), field('قیمت کامل (تومان)', p), field('بیعانه (تومان)', dp)),
      h('label', { class: 'inline-check' }, act, 'فعال (قابل رزرو)'), h('p', { class: 'hint', text: 'تغییر قیمت فقط روی رزروهای جدید اثر دارد؛ رزروهای قبلی با قیمت زمان ثبت باقی می‌مانند.' }),
      h('button', { class: 'btn btn-gold btn-sm', onclick: guard(async () => {
        const body = { name: n.value, duration_min: Number(d.value), price_toman: num(p), deposit_toman: num(dp), active: act.checked };
        try { await api(s ? `/admin/api/services/${s.id}` : '/admin/api/services', { method: s ? 'PUT' : 'POST', body }); toast('ذخیره شد.'); tab = 'services'; shell(); }
        catch (e) { throw new Error(e.message); }
      }) }, 'ذخیره'));
  };
  main.append(...services.map(rowCard), rowCard(null));
}

/* ---------- گزارش ---------- */
async function viewReport(main) {
  const from = inp(ft(isoToJalaliString(new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10))), { class: 'ltr' }), to = inp(ft(sys.today_jalali), { class: 'ltr' });
  const out = h('div', {});
  const load = guard(async () => {
    const f = parseJalaliInput(from.value), t = parseJalaliInput(to.value);
    if (!f || !t) throw new Error('تاریخ نامعتبر است (نمونه: ۱۴۰۵/۰۷/۲۵).');
    const r = await api(`/admin/api/report?from=${f}&to=${t}`);
    const k = (l, v) => h('div', { class: 'kpi' }, h('small', { text: l }), h('b', { text: v }));
    out.replaceChildren(r.includes_test_payments ? h('div', { class: 'alert test', text: 'این گزارش شامل پرداخت‌های آزمایشی است و درآمد واقعی نیست.' }) : null,
      r.needs_refund_count ? h('div', { class: 'alert', text: `${fa(r.needs_refund_count)} رزرو نیازمند بازپرداخت بیعانه است (در تب نوبت‌ها فیلتر کنید).` }) : null,
      h('div', { class: 'kpis' }, k('بیعانه‌ی دریافتی', money(r.deposits_received)), k('بازپرداخت‌شده', money(r.deposits_refunded)), k('خالص بیعانه', money(r.deposits_net)), k('باقی‌مانده‌ی تسویه‌شده', money(r.remaining_settled)),
        k('باقی‌مانده‌ی تسویه‌نشده', money(r.remaining_pending)), k('جمع درآمد ثبت‌شده', money(r.total_income)), k('نوبت قطعی', fa(r.counts.confirmed || 0)), k('لغو / منقضی', `${fa(r.counts.cancelled || 0)} / ${fa(r.counts.expired || 0)}`)),
      r.daily.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['تاریخ', 'نوبت قطعی', 'بیعانه'].map((x) => h('th', { text: x })))), h('tbody', {}, r.daily.map((d) => h('tr', {}, h('td', { text: ft(d.jalali) }), h('td', { text: fa(d.n) }), h('td', { text: money(d.dep) })))))) : null);
  });
  main.append(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, field('از (شمسی)', from), field('تا (شمسی)', to), h('button', { class: 'btn btn-gold btn-sm', onclick: load }, 'نمایش')), out));
  load();
}

/* ---------- تنظیمات ---------- */
async function viewSettings(main) {
  const { settings: s } = await api('/admin/api/settings');
  const F = {};
  const t = (k, label, props = {}, hint) => { F[k] = inp(s[k] ?? '', props); return field(label, F[k], hint); };
  F.rules = h('textarea', { text: s.rules }); F.rules.value = s.rules;
  F.intro = h('textarea', { style: 'min-height:80px' }); F.intro.value = s.intro;
  main.append(h('div', { class: 'card' }, h('h2', { text: 'اطلاعات آرایشگاه' }),
    h('div', { class: 'grid c2' }, t('business_name', 'نام آرایشگاه'), t('tagline', 'شعار صفحه اول'), t('phone', 'شماره تماس', { class: 'ltr' }), t('address', 'نشانی'),
      t('instagram_url', 'لینک اینستاگرام', { class: 'ltr', placeholder: 'https://instagram.com/…' }, 'تا وقتی خالی باشد هیچ لینکی نمایش داده نمی‌شود.'), t('logo_url', 'نشانی لوگو', { class: 'ltr' }, 'فایل را در public/img بگذارید و مثلاً /img/logo.svg بنویسید.')),
    field('معرفی کوتاه', F.intro), field('قوانین رزرو و لغو نوبت (هر خط یک بند)', F.rules, 'سیاست بازپرداخت بیعانه را خودتان تعیین کنید؛ سیستم به‌صورت خودکار تصمیم نمی‌گیرد.')),
    h('div', { class: 'card' }, h('h2', { text: 'قوانین سیستم رزرو' }), h('div', { class: 'grid c3' }, t('hold_minutes', 'مهلت پرداخت (دقیقه)', { type: 'number' }), t('booking_window_days', 'رزرو تا چند روز آینده', { type: 'number' }),
      t('min_lead_minutes', 'حداقل فاصله تا نوبت (دقیقه)', { type: 'number' }), t('reminder_hours_before', 'یادآوری چند ساعت قبل', { type: 'number' }), t('max_pending_per_phone', 'حداکثر رزرو پرداخت‌نشده‌ی هر شماره', { type: 'number' }))),
    h('button', { class: 'btn btn-gold', onclick: guard(async () => {
      const body = {}; for (const k of Object.keys(F)) body[k] = F[k].value;
      for (const k of ['hold_minutes', 'booking_window_days', 'min_lead_minutes', 'reminder_hours_before', 'max_pending_per_phone']) body[k] = Number(body[k]);
      await api('/admin/api/settings', { method: 'PUT', body }); toast('تنظیمات ذخیره شد.');
    }) }, 'ذخیره‌ی تنظیمات'),
    h('div', { class: 'card', style: 'margin-top:1.2rem' }, h('h2', { text: 'وضعیت اتصال‌ها' }),
      h('p', { text: `درگاه پرداخت: ${sys.gateway}${sys.gateway_is_test ? ' (آزمایشی؛ پرداخت واقعی نیست)' : ''}` }), h('p', { text: `پیامک: ${sys.sms_enabled ? 'فعال' : 'غیرفعال'}` }), h('p', { class: 'hint', text: `نشانی سایت: ${sys.base_url}` })),
    passwordCard());
}
function passwordCard() {
  const c = inp('', { type: 'password', autocomplete: 'current-password' }), n = inp('', { type: 'password', autocomplete: 'new-password' });
  return h('div', { class: 'card' }, h('h2', { text: 'تغییر رمز عبور' }), h('div', { class: 'grid c2' }, field('رمز فعلی', c), field('رمز جدید (حداقل ۱۰ نویسه)', n)),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: guard(async () => { await api('/admin/api/password', { method: 'POST', body: { current_password: c.value, new_password: n.value } }); csrf = null; renderLogin('رمز تغییر کرد؛ دوباره وارد شوید.'); }) }, 'تغییر رمز'));
}

async function boot() {
  try {
    const me = await api('/admin/api/me');
    if (!me.authenticated) return renderLogin();
    csrf = me.csrf; sys = await api('/admin/api/system'); shell();
  } catch (e) { root.replaceChildren(h('p', { class: 'boot', text: e.message })); }
}
boot();
