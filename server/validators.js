// اعتبارسنجی ورودی‌ها در سمت سرور. پیام‌ها فارسی هستند.
import { normalizeDigits } from '../public/js/jalali.js';

export class ValidationError extends Error {
  constructor(fields, message = 'اطلاعات واردشده معتبر نیست.') {
    super(message);
    this.status = 400;
    this.code = 'validation_error';
    this.fields = fields; // { fieldName: 'پیام' }
  }
}

const NAME_RE = /^[\p{L}\p{M}\u200c' .\-]{2,40}$/u;

export function cleanName(v) {
  return String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function validateName(v, label) {
  const s = cleanName(v);
  if (!s) return { error: `${label} را وارد کنید.` };
  if (s.length < 2) return { error: `${label} باید حداقل ۲ حرف باشد.` };
  if (s.length > 40) return { error: `${label} نباید بیشتر از ۴۰ حرف باشد.` };
  if (!NAME_RE.test(s)) return { error: `${label} فقط می‌تواند شامل حروف باشد.` };
  return { value: s };
}

/** شماره همراه ایران → '09123456789' یا null */
export function normalizePhone(v) {
  let s = normalizeDigits(v).replace(/[\s\-()‌]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = '0' + s;
  return /^09\d{9}$/.test(s) ? s : null;
}

export function validatePhone(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return { error: 'شماره تلفن همراه را وارد کنید.' };
  const p = normalizePhone(raw);
  if (!p) return { error: 'شماره تلفن همراه معتبر نیست؛ مثال: ۰۹۱۲۳۴۵۶۷۸۹' };
  return { value: p };
}

export function maskPhone(p) {
  return p && p.length === 11 ? `${p.slice(0, 4)}***${p.slice(7)}` : '';
}

export function validateCustomer(body) {
  const errors = {};
  const first = validateName(body?.first_name, 'نام');
  const last = validateName(body?.last_name, 'نام خانوادگی');
  const phone = validatePhone(body?.phone);
  if (first.error) errors.first_name = first.error;
  if (last.error) errors.last_name = last.error;
  if (phone.error) errors.phone = phone.error;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { first_name: first.value, last_name: last.value, phone: phone.value };
}

export function intInRange(v, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(normalizeDigits(v).replace(/[,٬\s]/g, '')) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
