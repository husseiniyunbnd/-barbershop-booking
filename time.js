// ابزار زمان: همه‌ی تاریخ/ساعت‌ها به وقت محلی (تهران) ذخیره می‌شوند و همراه با epoch (UTC) نگه داشته می‌شوند.
import { WEEKDAYS } from '../public/js/jalali.js';

export function createClock(offsetMinutes = 210, nowFn = () => Date.now()) {
  const offsetMs = offsetMinutes * 60_000;
  const pad = (n) => String(n).padStart(2, '0');
  const api = {
    offsetMinutes,
    nowMs: () => nowFn(),
    /** تاریخ امروز به وقت محلی: 'YYYY-MM-DD' */
    today() {
      return new Date(nowFn() + offsetMs).toISOString().slice(0, 10);
    },
    /** دقایق سپری‌شده از نیمه‌شب محلی */
    minutesNow() {
      const d = new Date(nowFn() + offsetMs);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    },
    /** epoch میلی‌ثانیه برای تاریخ و ساعت محلی */
    tsOf(date, time) {
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      return Date.UTC(y, m - 1, d, hh, mm) - offsetMs;
    },
    addDays(date, n) {
      const [y, m, d] = date.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    },
    /** شنبه=۰ … جمعه=۶ */
    weekdayIndex(date) {
      const [y, m, d] = date.split('-').map(Number);
      const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // یکشنبه=۰
      return (js + 1) % 7;
    },
    weekdayName(date) {
      return WEEKDAYS[api.weekdayIndex(date)];
    },
    /** تاریخ شنبه‌ی همان هفته */
    weekStart(date) {
      return api.addDays(date, -api.weekdayIndex(date));
    },
    minutesToTime: (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`,
    timeToMinutes(t) {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    },
    /** 'YYYY-MM-DDTHH:mm:ss+03:30' برای نمایش/ثبت */
    isoLocal(ms) {
      const d = new Date(ms + offsetMs);
      const sign = offsetMinutes >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutes);
      return `${d.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    },
  };
  return api;
}

export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
