import test from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../public/js/jalali.js';
import { normalizePhone, validateName, validateCustomer } from '../server/validators.js';

test('تبدیل شمسی/میلادی با تقویم ICU برای ۲۵ سال یکسان است', () => {
  const f = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
  for (let t = Date.UTC(2020, 0, 1); t < Date.UTC(2045, 0, 1); t += 864e5) {
    const d = new Date(t), iso = d.toISOString().slice(0, 10);
    const p = f.formatToParts(d); const g = (k) => Number(p.find((x) => x.type === k)?.value);
    const m = J.isoToJalali(iso);
    assert.deepEqual([m.jy, m.jm, m.jd], [g('relatedYear') || g('year'), g('month'), g('day')], iso);
    assert.equal(J.jalaliToIso(m.jy, m.jm, m.jd), iso);
  }
  assert.equal(J.isoToJalaliString('2026-10-18'), '1405/07/26');
  assert.equal(J.parseJalaliInput('۱۴۰۵/۰۷/۲۶'), '2026-10-18');
  assert.equal(J.parseJalaliInput('1405/12/30'), null);
});

test('نرمال‌سازی و اعتبارسنجی شماره موبایل', () => {
  for (const ok of ['09123456789', '۰۹۱۲۳۴۵۶۷۸۹', '+989123456789', '00989123456789', '9123456789', '0912 345 6789', '٠٩١٢٣٤٥٦٧٨٩']) assert.equal(normalizePhone(ok), '09123456789', ok);
  for (const bad of ['', '0912345678', '08123456789', '091234567890', 'abc', '02112345678']) assert.equal(normalizePhone(bad), null, bad);
});

test('اعتبارسنجی نام و پیام‌های فارسی', () => {
  assert.equal(validateName('  علی   اکبر ', 'نام').value, 'علی اکبر');
  assert.ok(validateName('', 'نام').error.includes('نام را وارد کنید'));
  assert.ok(validateName('a', 'نام').error);
  assert.ok(validateName('علی۱۲۳', 'نام').error);
  assert.ok(validateName('<script>', 'نام').error);
  assert.ok(validateName('x'.repeat(41), 'نام').error);
  try { validateCustomer({ first_name: '', last_name: '', phone: '1' }); assert.fail(); } catch (e) { assert.deepEqual(Object.keys(e.fields).sort(), ['first_name', 'last_name', 'phone']); }
});
