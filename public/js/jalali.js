// تبدیل تاریخ میلادی ⇄ شمسی (الگوریتم ۳۳ ساله). این فایل هم در مرورگر و هم در سرور استفاده می‌شود.
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => Math.trunc(a / b);
const mod = (a, b) => a - Math.trunc(a / b) * b;

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
// ترتیب هفته ایرانی: شنبه = ۰ … جمعه = ۶
export const WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

function jalCal(jy, withoutLeap) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14, jp = BREAKS[0], jm, jump = 0, leap, n;
  if (jy < jp || jy >= BREAKS[bl - 1]) throw new RangeError('سال شمسی نامعتبر: ' + jy);
  for (let i = 1; i < bl; i += 1) {
    jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (withoutLeap) return { gy, march };
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}
function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}
function j2d(jy, jm, jd) {
  const r = jalCal(jy, true);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}
function d2j(jdn) {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy, false);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export const toJalali = (gy, gm, gd) => d2j(g2d(gy, gm, gd));
export const toGregorian = (jy, jm, jd) => d2g(j2d(jy, jm, jd));
export const isLeapJalali = (jy) => jalCal(jy, false).leap === 0;
export const jalaliMonthLength = (jy, jm) => (jm <= 6 ? 31 : jm <= 11 ? 30 : isLeapJalali(jy) ? 30 : 29);
export function isValidJalali(jy, jm, jd) {
  return Number.isInteger(jy) && Number.isInteger(jm) && Number.isInteger(jd) &&
    jy >= 1300 && jy <= 1700 && jm >= 1 && jm <= 12 && jd >= 1 && jd <= jalaliMonthLength(jy, jm);
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' میلادی → { jy, jm, jd } */
export function isoToJalali(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return toJalali(y, m, d);
}
/** 'YYYY-MM-DD' میلادی → 'YYYY/MM/DD' شمسی (ارقام لاتین) */
export function isoToJalaliString(iso) {
  const { jy, jm, jd } = isoToJalali(iso);
  return `${jy}/${pad(jm)}/${pad(jd)}`;
}
/** شمسی → 'YYYY-MM-DD' میلادی */
export function jalaliToIso(jy, jm, jd) {
  const g = toGregorian(jy, jm, jd);
  return `${g.gy}-${pad(g.gm)}-${pad(g.gd)}`;
}

const FA = '۰۱۲۳۴۵۶۷۸۹';
const AR = '٠١٢٣٤٥٦٧٨٩';
/** ارقام فارسی/عربی → لاتین */
export function normalizeDigits(str) {
  return String(str ?? '').replace(/[۰-۹٠-٩]/g, (c) => {
    const i = FA.indexOf(c);
    return String(i >= 0 ? i : AR.indexOf(c));
  });
}
/** ارقام لاتین → فارسی (فقط برای نمایش) */
export const toFaDigits = (str) => String(str ?? '').replace(/\d/g, (d) => FA[d]);

/** ورودی متنی شمسی مثل «۱۴۰۵/۰۷/۲۵» → 'YYYY-MM-DD' میلادی یا null */
export function parseJalaliInput(text) {
  const m = normalizeDigits(text).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const [jy, jm, jd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidJalali(jy, jm, jd)) return null;
  return jalaliToIso(jy, jm, jd);
}

/** «۲۵ مهر ۱۴۰۵» */
export function jalaliLong(iso) {
  const { jy, jm, jd } = isoToJalali(iso);
  return `${toFaDigits(jd)} ${JALALI_MONTHS[jm - 1]} ${toFaDigits(jy)}`;
}
