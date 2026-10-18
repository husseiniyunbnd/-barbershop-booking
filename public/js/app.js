// رابط کاربری مشتری: صفحه اصلی، مراحل رزرو و صفحه نتیجه. همه‌ی متن‌های پویا با textContent درج می‌شوند (ضد XSS).
import { toFaDigits } from './jalali.js';

const $app = document.getElementById('app');
const fa = (n) => new Intl.NumberFormat('fa-IR').format(n);
const money = (n) => `${fa(n)} تومان`;
const ft = (t) => toFaDigits(t);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } } // CSSOM: سازگار با CSP
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c.nodeType ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw Object.assign(new Error('ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید.'), { network: true }); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || 'خطایی رخ داد.'), { code: json?.error?.code, fields: json?.error?.fields, status: res.status });
  return json;
}

/* ---------- وضعیت برنامه ---------- */
const S = { config: null, serviceId: null, weekIdx: 0, days: null, date: null, slots: null, time: null, first: '', last: '', phone: '', accept: false, otpToken: '', pending: null };
const DRAFT_KEY = 'draft.v1';
const saveDraft = () => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ serviceId: S.serviceId, date: S.date, time: S.time, first: S.first, last: S.last, phone: S.phone, accept: S.accept, pending: S.pending })); } catch { /* ignore */ } };
const loadDraft = () => { try { Object.assign(S, JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}')); } catch { /* ignore */ } };
loadDraft();

const service = () => S.config.services.find((x) => x.id === S.serviceId) || S.config.services[0];
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const mount = (...nodes) => { $app.replaceChildren(...nodes); window.scrollTo({ top: 0 }); $app.focus({ preventScroll: true }); };

/* ---------- اجزای مشترک ---------- */
function header(showBack) {
  const b = S.config.business;
  return h('header', { class: 'top' }, h('div', { class: 'wrap' },
    h('a', { class: 'brand', href: '/', onclick: (e) => { e.preventDefault(); go('#/'); } },
      b.logo_url ? h('img', { src: b.logo_url, alt: '', width: 36, height: 36 }) : null, h('span', { text: b.name })),
    showBack ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('#/') }, 'صفحه اصلی')
      : h('nav', { class: 'nav', 'aria-label': 'بخش‌های صفحه' }, [['خدمات', 'sec-price'], ['ساعت کاری', 'sec-hours'], ['قوانین', 'sec-rules']].map(([t, id]) =>
        h('button', { onclick: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }) }, t)))));
}
function errBox(msg, kind = '') { return h('div', { class: `alert ${kind}`, role: 'alert' }, msg); }
function testBanner() { return S.config.test_payment ? h('div', { class: 'alert test' }, 'حالت آزمایشی: درگاه پرداخت واقعی نیست و هیچ مبلغی کسر نمی‌شود.') : null; }

/* ---------- صفحه اصلی ---------- */
function renderLanding() {
  const c = S.config, b = c.business, sv = c.services[0];
  const startBtn = (cls = 'btn btn-gold') => h('button', { class: cls, onclick: () => go('#/book') }, 'رزرو نوبت');
  const ruleItems = c.rules.split('\n').map((x) => x.trim()).filter(Boolean);
  const contacts = [
    b.phone && h('a', { href: `tel:${b.phone}` }, `تلفن: ${toFaDigits(b.phone)}`),
    b.address && h('span', { text: `نشانی: ${b.address}` }),
    b.instagram_url && h('a', { href: b.instagram_url, target: '_blank', rel: 'noopener noreferrer' }, 'اینستاگرام'),
  ].filter(Boolean);

  mount(header(false), h('main', {},
    h('section', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', {}, h('h1', { text: b.tagline || b.name }), h('p', { text: b.intro }),
        h('div', { class: 'cta' }, startBtn(), h('span', { class: 'hint' }, `بیعانه: ${money(sv.deposit_toman)}`))),
      h('div', { class: 'pole-wrap', 'aria-hidden': 'true' }, h('div', { class: 'pole' })))),

    h('section', { class: 'section section-light', id: 'sec-price' }, h('div', { class: 'wrap price-grid' },
      h('div', {}, h('h2', { text: 'خدمات و قیمت' }), c.services.map((x) => h('p', { class: 'hint', text: `${x.name}، ${fa(x.duration_min)} دقیقه` })),
        h('p', { class: 'hint', text: 'با پرداخت بیعانه، نوبت شما همان لحظه قطعی می‌شود و مبلغ باقی‌مانده هنگام مراجعه پرداخت می‌شود.' }),
        h('div', { style: 'margin-top:1.2rem' }, startBtn())),
      h('div', {}, c.services.map((x) => h('div', { class: 'ticket', style: 'margin-bottom:1rem' },
        h('div', { class: 'ticket-head' }, h('small', { text: 'خدمت' }), h('strong', { text: x.name })),
        h('dl', {}, h('div', { class: 'row' }, h('dt', { text: 'مدت' }), h('dd', { text: `${fa(x.duration_min)} دقیقه` })),
          h('div', { class: 'row' }, h('dt', { text: 'هزینه کامل' }), h('dd', { class: 'big', text: money(x.price_toman) })),
          h('div', { class: 'row' }, h('dt', { text: 'بیعانه (آنلاین)' }), h('dd', { text: money(x.deposit_toman) })),
          h('div', { class: 'row' }, h('dt', { text: 'باقی‌مانده (هنگام مراجعه)' }), h('dd', { text: money(x.remaining_toman) })))))))),

    h('section', { class: 'section' }, h('div', { class: 'wrap' }, h('h2', { text: 'مراحل رزرو' }),
      h('ol', { class: 'steps-list' }, [['انتخاب روز', 'روزی که آرایشگاه باز است را انتخاب کنید.'], ['انتخاب ساعت', 'از بین ساعت‌های آزاد همان روز.'], ['ثبت اطلاعات', 'نام و شماره همراه شما.'], ['پرداخت بیعانه', 'پس از پرداخت، نوبت قطعی و کد پیگیری صادر می‌شود.']]
        .map(([t, d]) => h('li', {}, h('div', {}, h('b', { text: t }), h('span', { text: d }))))))),

    h('section', { class: 'section', id: 'sec-hours' }, h('div', { class: 'wrap' }, h('h2', { text: 'ساعت کاری' }),
      h('div', { class: 'hours' }, c.hours.map((x) => h('div', { class: x.is_open ? '' : 'off' }, h('span', { text: x.name }), h('span', { class: 'num', text: x.is_open ? `${ft(x.start_time)} تا ${ft(x.end_time)}` : 'تعطیل' })))))),

    contacts.length ? h('section', { class: 'section' }, h('div', { class: 'wrap' }, h('h2', { text: 'راه ارتباطی' }), h('div', { class: 'contact' }, contacts))) : null,

    h('section', { class: 'section', id: 'sec-rules' }, h('div', { class: 'wrap' }, h('h2', { text: 'قوانین رزرو و لغو نوبت' }), h('ul', { class: 'rules' }, ruleItems.map((r) => h('li', { text: r }))))),
  ), h('footer', { class: 'footer' }, h('div', { class: 'wrap' }, h('span', { text: b.name }), startBtn('btn btn-gold btn-sm'))));
}

/* ---------- قاب مراحل ---------- */
const STEPS = ['روز', 'ساعت', 'اطلاعات', 'تأیید', 'پرداخت'];
function flow(stepIdx, content, actions) {
  const track = h('div', { class: 'track', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': STEPS.length, 'aria-valuenow': stepIdx + 1, 'aria-label': 'پیشرفت رزرو' }, h('div', { class: 'pole', style: `width:${((stepIdx + 1) / STEPS.length) * 100}%` }));
  mount(header(true), h('main', { class: 'flow' }, h('div', { class: 'wrap' },
    h('div', { class: 'stepper' }, h('div', { class: 'meta' }, h('b', { text: `مرحله ${fa(stepIdx + 1)} از ${fa(STEPS.length)}: ${STEPS[stepIdx]}` }), h('span', { text: `مهلت پرداخت پس از ثبت: ${fa(S.config.hold_minutes)} دقیقه` })),
      track, h('div', { class: 'stepnames', 'aria-hidden': 'true' }, STEPS.map((s, i) => h('span', { class: i === stepIdx ? 'on' : '', text: s })))),
    h('div', { class: 'layout' }, h('section', { class: 'panel' }, content, actions), h('aside', {}, ticket())))));
}

function ticket() {
  const sv = service();
  const d = S.days?.find((x) => x.date === S.date);
  const row = (k, v, cls = '') => h('div', { class: 'row' }, h('dt', { text: k }), h('dd', { class: cls }, v));
  return h('div', { class: 'ticket', 'aria-label': 'خلاصه‌ی نوبت' }, h('div', { class: 'ticket-head' }, h('small', { text: 'نوبت شما' }), h('strong', { text: sv.name })),
    h('dl', {}, row('روز', d ? `${d.weekday}، ${d.jalali_long}` : h('span', { class: 'empty', text: 'انتخاب نشده' })),
      row('ساعت', S.time ? ft(`${S.time} تا ${S.slots?.find((x) => x.start_time === S.time)?.end_time || ''}`) : h('span', { class: 'empty', text: 'انتخاب نشده' }), 'num'),
      row('هزینه کامل', money(sv.price_toman)), row('بیعانه امروز', money(sv.deposit_toman), 'big'), row('باقی‌مانده', money(sv.remaining_toman))));
}

/* ---------- مرحله ۱: روز ---------- */
async function stepDay() {
  const sv = service();
  flow(0, h('p', { class: 'sub', text: 'در حال دریافت روزها…' }));
  try { S.days = (await api(`/api/days?service_id=${sv.id}`)).days; } catch (e) { return flow(0, errBox(e.message)); }
  const weeks = []; for (let i = 0; i < S.days.length; i += 7) weeks.push(S.days.slice(i, i + 7));
  if (S.weekIdx >= weeks.length) S.weekIdx = 0;
  const first = weeks[S.weekIdx][0], last = weeks[S.weekIdx][6];
  const label = (d) => d.state === 'open' ? `${fa(d.free_count)} ساعت آزاد` : ({ past: 'گذشته', closed: 'تعطیل', full: 'تکمیل', beyond: 'خارج از بازه‌ی رزرو' }[d.state]);
  const picker = S.config.services.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'svc', text: 'خدمت' }),
    h('select', { id: 'svc', class: 'field-select', onchange: (e) => { S.serviceId = Number(e.target.value); S.date = S.time = null; saveDraft(); stepDay(); } },
      S.config.services.map((x) => h('option', { value: x.id, selected: x.id === sv.id, text: `${x.name} — ${money(x.price_toman)}` })))) : null;
  flow(0, [
    h('h2', { text: 'کدام روز؟' }), h('p', { class: 'sub', text: 'روزهای خاکستریِ خط‌چین قابل انتخاب نیستند.' }), picker,
    h('div', { class: 'weekbar' },
      h('button', { class: 'btn btn-ghost btn-sm', disabled: S.weekIdx === 0, onclick: () => { S.weekIdx--; stepDay(); } }, 'هفته قبل'),
      h('b', { text: `${first.jalali_long} تا ${last.jalali_long}` }),
      h('button', { class: 'btn btn-ghost btn-sm', disabled: S.weekIdx >= weeks.length - 1, onclick: () => { S.weekIdx++; stepDay(); } }, 'هفته بعد')),
    h('div', { class: 'days', role: 'group', 'aria-label': 'روزهای هفته' }, weeks[S.weekIdx].map((d) => h('button', {
      class: 'day', disabled: d.state !== 'open', 'aria-pressed': String(S.date === d.date),
      onclick: () => { if (S.date !== d.date) S.time = null; S.date = d.date; saveDraft(); go('#/book/time'); },
    }, h('span', { class: 'wd', text: d.weekday }), h('span', { class: 'dt', text: d.jalali_long }), h('span', { class: 'st', text: label(d) })))),
  ]);
}

/* ---------- مرحله ۲: ساعت ---------- */
let slotTimer = null;
async function stepTime() {
  if (!S.date) return go('#/book');
  const sv = service();
  const render = (data, note) => {
    const lbl = { free: null, booked: 'رزروشده', disabled: 'غیرفعال' };
    const body = !data.slots.length ? h('div', { class: 'empty-state', text: 'برای این روز ساعتی قابل رزرو نیست. روز دیگری انتخاب کنید.' })
      : h('div', { class: 'slots', role: 'group', 'aria-label': 'ساعت‌های نوبت' }, data.slots.map((s) => h('button', {
        class: `slot ${s.state === 'free' ? '' : s.state}`, disabled: s.state !== 'free', 'aria-pressed': String(S.time === s.start_time),
        onclick: (e) => { S.time = s.start_time; saveDraft(); document.querySelectorAll('.slot').forEach((el) => el.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); document.getElementById('next').disabled = false; refreshTicket(); },
      }, h('span', { class: 'num', text: ft(`${s.start_time} تا ${s.end_time}`) }), lbl[s.state] ? h('small', { text: lbl[s.state] }) : null)));
    flow(1, [h('h2', { text: `ساعت نوبت — ${data.weekday} ${data.jalali_long}` }), h('p', { class: 'sub', text: 'هر نوبت یک بازه‌ی مشخص دارد.' }), note ? errBox(note, 'info') : null, body,
      h('div', { class: 'legend', 'aria-hidden': 'true' }, h('span', { class: 'f' }, h('i'), 'آزاد'), h('span', { class: 's' }, h('i'), 'انتخاب‌شده'), h('span', { class: 'b' }, h('i'), 'رزروشده'), h('span', { class: 'd' }, h('i'), 'غیرفعال'))],
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => go('#/book') }, 'تغییر روز'),
      h('button', { id: 'next', class: 'btn btn-gold', disabled: !S.time, onclick: () => go('#/book/info') }, 'ادامه')));
  };
  const refreshTicket = () => { const a = document.querySelector('.layout aside'); if (a) a.replaceChildren(ticket()); };
  const load = async (initial) => {
    try {
      const data = await api(`/api/slots?date=${S.date}&service_id=${sv.id}`);
      S.slots = data.slots;
      let note = null;
      if (S.time && !data.slots.some((s) => s.start_time === S.time && s.state === 'free')) { S.time = null; saveDraft(); note = 'ساعتی که انتخاب کرده بودید دیگر آزاد نیست. لطفاً ساعت دیگری انتخاب کنید.'; }
      if (initial || note) render(data, note); else if (!S.time) render(data, null);
    } catch (e) { flow(1, errBox(e.message)); }
  };
  if (!S.days) { try { S.days = (await api(`/api/days?service_id=${sv.id}`)).days; } catch { /* ignore */ } }
  await load(true);
  clearInterval(slotTimer);
  slotTimer = setInterval(() => { if (location.hash === '#/book/time') load(false); else clearInterval(slotTimer); }, 20000);
}

/* ---------- مرحله ۳: اطلاعات ---------- */
const FA2EN = (s) => String(s).replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
const NAME_RE = /^[\p{L}\p{M}\u200c' .\-]{2,40}$/u;
function checkFields(f) {
  const e = {};
  const nm = (v, l) => { v = v.trim().replace(/\s+/g, ' '); if (!v) return `${l} را وارد کنید.`; if (v.length < 2) return `${l} باید حداقل ۲ حرف باشد.`; if (!NAME_RE.test(v)) return `${l} فقط می‌تواند شامل حروف باشد.`; return null; };
  e.first_name = nm(f.first, 'نام'); e.last_name = nm(f.last, 'نام خانوادگی');
  let p = FA2EN(f.phone).replace(/[\s\-()]/g, ''); if (p.startsWith('+98')) p = '0' + p.slice(3); else if (p.startsWith('0098')) p = '0' + p.slice(4); else if (/^9\d{9}$/.test(p)) p = '0' + p;
  e.phone = !f.phone.trim() ? 'شماره تلفن همراه را وارد کنید.' : /^09\d{9}$/.test(p) ? null : 'شماره تلفن همراه معتبر نیست؛ مثال: ۰۹۱۲۳۴۵۶۷۸۹';
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v));
}
function stepInfo(serverErrors = {}) {
  if (!S.time) return go('#/book/time');
  const fields = {};
  const mk = (key, id, label, val, props = {}) => {
    const input = h('input', { id, value: val, 'aria-describedby': `${id}-e`, autocomplete: props.autocomplete, inputmode: props.inputmode, class: props.ltr ? 'ltr' : '', maxlength: props.max,
      oninput: (e) => { S[key] = e.target.value; if (key === 'phone') S.otpToken = ''; saveDraft(); } });
    const err = h('div', { class: 'err', id: `${id}-e`, 'aria-live': 'polite' });
    fields[key] = { input, err };
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, props.help ? h('div', { class: 'help', text: props.help }) : null, err);
  };
  const show = (errs) => { for (const [k, { input, err }] of Object.entries(fields)) { const m = errs[{ first: 'first_name', last: 'last_name', phone: 'phone' }[k]]; err.textContent = m || ''; input.setAttribute('aria-invalid', m ? 'true' : 'false'); } };
  const otpBox = S.config.otp_required ? otpUi(() => FA2EN(S.phone)) : null;
  flow(2, [h('h2', { text: 'اطلاعات شما' }), h('p', { class: 'sub', text: 'برای ثبت نوبت و اطلاع‌رسانی از شماره‌تان استفاده می‌کنیم.' }),
    h('div', { class: 'row2' }, mk('first', 'f-first', 'نام', S.first, { autocomplete: 'given-name', max: 40 }), mk('last', 'f-last', 'نام خانوادگی', S.last, { autocomplete: 'family-name', max: 40 })),
    mk('phone', 'f-phone', 'شماره تلفن همراه', S.phone, { autocomplete: 'tel', inputmode: 'tel', ltr: true, max: 16, help: 'مثال: ۰۹۱۲۳۴۵۶۷۸۹' }), otpBox],
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => go('#/book/time') }, 'بازگشت'),
    h('button', { class: 'btn btn-gold', onclick: () => {
      const errs = checkFields(S); show(errs);
      if (S.config.otp_required && !S.otpToken) errs.otp = 'ابتدا شماره را با کد پیامکی تأیید کنید.';
      if (errs.otp) document.getElementById('otp-e').textContent = errs.otp;
      if (Object.keys(errs).length) { document.querySelector('[aria-invalid="true"]')?.focus(); return; }
      go('#/book/confirm');
    } }, 'ادامه')));
  show(serverErrors);
}
function otpUi(getPhone) {
  const msg = h('div', { class: 'err', id: 'otp-e', 'aria-live': 'polite' });
  const code = h('input', { class: 'ltr', inputmode: 'numeric', maxlength: 5, 'aria-label': 'کد تأیید', autocomplete: 'one-time-code' });
  const sendBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { msg.textContent = ''; try { await api('/api/otp/send', { method: 'POST', body: { phone: getPhone() } }); msg.textContent = 'کد پیامک شد.'; } catch (e) { msg.textContent = e.fields?.phone || e.message; } } }, 'ارسال کد تأیید');
  const okBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { msg.textContent = ''; try { S.otpToken = (await api('/api/otp/verify', { method: 'POST', body: { phone: getPhone(), code: code.value } })).otp_token; saveDraft(); msg.textContent = 'شماره تأیید شد.'; } catch (e) { msg.textContent = e.message; } } }, 'تأیید کد');
  return h('div', { class: 'field' }, h('label', { text: 'تأیید شماره با پیامک' }), h('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap' }, sendBtn, code, okBtn), msg);
}

/* ---------- مرحله ۴: تأیید و پرداخت ---------- */
function stepConfirm() {
  if (!S.time) return go('#/book/time');
  if (Object.keys(checkFields(S)).length) return go('#/book/info');
  const sv = service(), d = S.days?.find((x) => x.date === S.date);
  const endT = S.slots?.find((x) => x.start_time === S.time)?.end_time;
  const row = (k, v, cls) => h('div', { class: 'row' }, h('dt', { text: k }), h('dd', { class: cls || '' }, v));
  const err = h('div', { id: 'cerr' });
  const box = h('input', { type: 'checkbox', id: 'accept', checked: S.accept, onchange: (e) => { S.accept = e.target.checked; saveDraft(); label.dataset.invalid = 'false'; } });
  const label = h('label', { class: 'check', for: 'accept' }, box, h('span', {}, 'قوانین رزرو و لغو نوبت را خوانده‌ام و می‌پذیرم.'));
  const rulesDetails = h('details', { style: 'margin-top:.7rem' }, h('summary', { style: 'cursor:pointer;color:var(--brass)', text: 'مشاهده‌ی قوانین' }), h('ul', { class: 'rules', style: 'margin-top:.7rem' }, S.config.rules.split('\n').filter((x) => x.trim()).map((r) => h('li', { text: r }))));
  const pay = h('button', { class: 'btn btn-gold', id: 'paybtn' }, 'تأیید اطلاعات و پرداخت بیعانه');
  const setBusy = (on) => { pay.disabled = on; pay.replaceChildren(on ? h('span', { class: 'spin' }) : document.createTextNode('تأیید اطلاعات و پرداخت بیعانه'), ...(on ? [document.createTextNode(' در حال انتقال به درگاه…')] : [])); };
  pay.addEventListener('click', async () => {
    err.replaceChildren();
    if (!S.accept) { label.dataset.invalid = 'true'; err.replaceChildren(errBox('برای ادامه باید قوانین رزرو را بپذیرید.')); return; }
    setBusy(true);
    try {
      const sig = [S.serviceId ?? sv.id, S.date, S.time, FA2EN(S.phone), S.first.trim(), S.last.trim()].join('|');
      let p = S.pending;
      if (!p || p.sig !== sig || p.expires <= Date.now() + 15000) {
        const r = await api('/api/bookings', { method: 'POST', body: { service_id: sv.id, date: S.date, start_time: S.time, first_name: S.first, last_name: S.last, phone: S.phone, accept_rules: true, otp_token: S.otpToken || undefined } });
        p = S.pending = { sig, code: r.code, token: r.token, expires: r.hold_expires_at }; saveDraft();
      }
      const { redirect_url } = await api(`/api/bookings/${p.code}/pay`, { method: 'POST', body: { token: p.token } });
      location.assign(redirect_url);
    } catch (e) {
      setBusy(false);
      if (e.code === 'hold_expired') { S.pending = null; saveDraft(); }
      if (e.code === 'validation_error' || e.code === 'otp_required') return stepInfo(e.fields || {});
      if (['slot_taken', 'slot_unavailable'].includes(e.code)) { S.time = null; S.pending = null; saveDraft(); err.replaceChildren(errBox(e.message), h('button', { class: 'btn btn-gold', onclick: () => go('#/book/time') }, 'انتخاب ساعت دیگر')); return; }
      err.replaceChildren(errBox(e.message));
    }
  });
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) setBusy(false); }, { once: true });
  flow(3, [h('h2', { text: 'بررسی نهایی' }), h('p', { class: 'sub', text: 'اطلاعات را بررسی کنید؛ سپس به درگاه پرداخت منتقل می‌شوید.' }), testBanner(),
    h('dl', { class: 'summary' },
      row('نام و نام خانوادگی', `${S.first.trim()} ${S.last.trim()}`), row('شماره تلفن', ft(FA2EN(S.phone)), 'num ltr'),
      row('روز و تاریخ', d ? `${d.weekday}، ${d.jalali_long}` : ''), row('ساعت', ft(`${S.time} تا ${endT || ''}`), 'num'),
      row('نوع خدمت', sv.name), row('مدت خدمت', `${fa(sv.duration_min)} دقیقه`), row('هزینه کامل', money(sv.price_toman)),
      row('مبلغ بیعانه', money(sv.deposit_toman), 'hl'), row('مبلغ باقی‌مانده', money(sv.remaining_toman)),
      row('وضعیت رزرو', h('span', { class: 'status-chip', text: 'در انتظار پرداخت بیعانه' }))),
    h('p', { class: 'note', text: 'با پرداخت موفق بیعانه، رزرو شما قطعی می‌شود. مبلغ باقی‌مانده طبق سیاست آرایشگاه هنگام مراجعه پرداخت می‌شود.' }),
    label, rulesDetails, err],
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => go('#/book/info') }, 'ویرایش'), pay));
}

/* ---------- نتیجه ---------- */
async function stepResult(code, token, tries = 0) {
  let b;
  try { b = (await api(`/api/bookings/${encodeURIComponent(code)}?t=${encodeURIComponent(token)}`)).booking; }
  catch (e) { return mount(header(true), h('main', { class: 'flow' }, h('div', { class: 'narrow' }, errBox(e.message), h('button', { class: 'btn btn-gold', onclick: () => go('#/') }, 'بازگشت به صفحه اصلی')))); }
  if (b.outcome === 'pending' && tries < 20) { resultView(b, true); return setTimeout(() => { if (location.hash.startsWith('#/result')) stepResult(code, token, tries + 1); }, 3000); }
  if (b.outcome === 'confirmed') { S.pending = null; S.time = null; S.date = null; S.accept = false; saveDraft(); }
  resultView(b, false, token);
}
function resultView(b, checking, token) {
  const home = h('button', { class: 'btn btn-ghost', onclick: () => go('#/') }, 'بازگشت به صفحه اصلی');
  const retry = h('button', { class: 'btn btn-gold', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api(`/api/bookings/${b.code}/pay`, { method: 'POST', body: { token } }); location.assign(r.redirect_url); }
    catch (er) { e.currentTarget.disabled = false; document.getElementById('rerr').replaceChildren(errBox(er.message)); }
  } }, 'تلاش مجدد برای پرداخت');
  const row = (k, v, cls) => h('div', { class: 'row' }, h('dt', { text: k }), h('dd', { class: cls || '' }, v));
  const details = h('dl', { class: 'summary receipt' }, row('نام مشتری', b.name), row('شماره تلفن', ft(b.phone_masked), 'num ltr'), row('روز و تاریخ', `${b.weekday}، ${b.jalali_long}`), row('ساعت', ft(`${b.start_time} تا ${b.end_time}`), 'num'),
    row('خدمت', b.service_name), row('هزینه کامل', money(b.price_toman)), row('بیعانه', money(b.deposit_toman), 'hl'), row('مبلغ باقی‌مانده (هنگام مراجعه)', money(b.remaining_toman)),
    row('وضعیت پرداخت', h('span', { class: `status-chip ${b.payment_status === 'paid' ? 'ok' : 'bad'}`, text: b.payment_status === 'paid' ? 'پرداخت‌شده' : 'پرداخت‌نشده' })),
    b.ref_id ? row('شماره مرجع تراکنش', b.ref_id, 'num ltr') : null);
  const contact = b.business.phone ? h('p', { class: 'hint', text: `تلفن آرایشگاه: ${toFaDigits(b.business.phone)}` }) : null;
  const cfg = {
    confirmed: ['✓', 'نوبت شما با موفقیت ثبت شد', ''],
    pending: ['…', checking ? 'در حال بررسی پرداخت…' : 'نتیجه‌ی پرداخت هنوز مشخص نیست', ''],
    payment_failed: ['!', 'پرداخت انجام نشد', 'bad'],
    expired: ['!', 'مهلت پرداخت تمام شد', 'bad'],
    cancelled: ['!', 'این نوبت لغو شده است', 'bad'],
    paid_not_assigned: ['!', 'پرداخت انجام شد اما نوبت قطعی نشد', 'bad'],
  }[b.outcome];
  const body = { confirmed: null, pending: h('p', { class: 'sub', text: checking ? 'لطفاً صفحه را نبندید.' : 'اگر مبلغی کسر شده، چند دقیقه بعد همین صفحه را دوباره باز کنید یا با آرایشگاه تماس بگیرید.' }),
    payment_failed: h('p', { class: 'sub', text: 'پرداخت لغو یا ناموفق بود و نوبت قطعی نشده است. تا پایان مهلت می‌توانید دوباره تلاش کنید؛ رزرو تکراری ایجاد نمی‌شود.' }),
    expired: h('p', { class: 'sub', text: 'ساعت آزاد شد. لطفاً دوباره نوبت بگیرید.' }), cancelled: null,
    paid_not_assigned: h('p', { class: 'sub', text: 'در زمان تأیید، این ساعت دیگر در دسترس نبود. بیعانه شما باید بازپرداخت شود؛ لطفاً با آرایشگاه تماس بگیرید و کد پیگیری را اعلام کنید.' }) }[b.outcome];
  const acts = [];
  if (b.outcome === 'confirmed') acts.push(h('button', { class: 'btn btn-gold', onclick: () => window.print() }, 'چاپ یا ذخیره‌ی رسید'), h('a', { class: 'btn btn-ghost', href: `/api/bookings/${b.code}/ics?t=${encodeURIComponent(token)}` }, 'افزودن به تقویم'));
  if (b.outcome === 'payment_failed') acts.push(retry);
  if (b.outcome === 'expired') acts.push(h('button', { class: 'btn btn-gold', onclick: () => go('#/book') }, 'انتخاب نوبت جدید'));
  mount(header(true), h('main', { class: 'flow' }, h('div', { class: 'narrow' }, h('section', { class: 'panel result' },
    b.is_test_payment ? errBox('پرداخت آزمایشی بود (درگاه واقعی نیست).', 'test') : null,
    h('div', { class: `mark ${cfg[2]}`, 'aria-hidden': 'true', text: cfg[0] }), h('h1', { text: cfg[1] }), body,
    b.outcome === 'confirmed' ? h('div', { class: 'code-box' }, h('small', { text: 'کد پیگیری' }), h('b', { class: 'num', text: toFaDigits(b.code) })) : null,
    ['confirmed', 'paid_not_assigned'].includes(b.outcome) ? details : null, h('div', { id: 'rerr' }), contact,
    h('div', { class: 'btn-row' }, acts, home)))));
}

/* ---------- مسیریابی ---------- */
function route() {
  if (!S.config) return;
  clearInterval(slotTimer);
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/result\/(\d+)\/([0-9a-f]+)$/);
  if (m) return stepResult(m[1], m[2]);
  if (hash === '#/book') return stepDay();
  if (hash === '#/book/time') return stepTime();
  if (hash === '#/book/info') return stepInfo();
  if (hash === '#/book/confirm') return stepConfirm();
  renderLanding();
}

(async function init() {
  try {
    S.config = await api('/api/config');
    if (!S.serviceId || !S.config.services.some((x) => x.id === S.serviceId)) S.serviceId = S.config.services[0]?.id;
    if (!S.config.services.length) { $app.replaceChildren(h('p', { class: 'boot', text: 'در حال حاضر امکان رزرو آنلاین وجود ندارد.' })); return; }
    window.addEventListener('hashchange', route);
    route();
  } catch (e) { $app.replaceChildren(h('p', { class: 'boot', text: e.message })); }
})();
