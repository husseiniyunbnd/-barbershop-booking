// مسیرهای پنل مدیریت. همه (جز login/logout) پس از احراز هویت سمت سرور و بررسی CSRF اجرا می‌شوند.
import { AppError } from './errors.js';
import { ValidationError, intInRange, normalizePhone } from './validators.js';
import { isIsoDate, isTime } from './time.js';
import { isoToJalaliString, jalaliLong } from '../public/js/jalali.js';
import { validatePasswordStrength } from './auth.js';
import { setSettings, getSettings, tx } from './db.js';

const STATUS_FA = { pending_payment: 'در انتظار پرداخت', confirmed: 'قطعی‌شده', cancelled: 'لغوشده', expired: 'منقضی‌شده' };
const PAY_FA = { unpaid: 'پرداخت‌نشده', paid: 'پرداخت‌شده', failed: 'ناموفق', refunded: 'بازپرداخت‌شده' };
const ATT_FA = { attended: 'مراجعه کرد', no_show: 'مراجعه نکرد' };

export function adminRoutes({ db, clock, svc, auth, gateway, sms, config }) {
  const need = (cond, msg, field) => { if (!cond) throw new ValidationError(field ? { [field]: msg } : {}, msg); };
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

  function decorate(b) {
    return {
      id: b.id, code: b.code, first_name: b.first_name, last_name: b.last_name, phone: b.phone,
      service_name: b.service_name, duration_min: b.duration_min,
      price_toman: b.price_toman, deposit_toman: b.deposit_toman, remaining_toman: b.remaining_toman,
      date: b.date, jalali_date: b.jalali_date, weekday: clock.weekdayName(b.date), start_time: b.start_time, end_time: b.end_time,
      status: b.status, status_fa: STATUS_FA[b.status], payment_status: b.payment_status, payment_fa: PAY_FA[b.payment_status],
      gateway: b.gateway, needs_refund: !!b.needs_refund, deposit_outcome: b.deposit_outcome,
      attendance: b.attendance, attendance_fa: ATT_FA[b.attendance] || null, remaining_settled: !!b.remaining_settled_at,
      admin_note: b.admin_note, cancel_reason: b.cancel_reason, created_at: clock.isoLocal(b.created_at),
      hold_expires_at: b.hold_expires_at ? clock.isoLocal(b.hold_expires_at) : null,
    };
  }

  function filterBookings(q) {
    const where = []; const args = [];
    if (q.from) { need(isIsoDate(q.from), 'تاریخ شروع نامعتبر است.'); where.push('date >= ?'); args.push(q.from); }
    if (q.to) { need(isIsoDate(q.to), 'تاریخ پایان نامعتبر است.'); where.push('date <= ?'); args.push(q.to); }
    if (q.status) { need(Object.hasOwn(STATUS_FA, q.status), 'وضعیت نامعتبر است.'); where.push('status = ?'); args.push(q.status); }
    if (q.needs_refund === '1') where.push('needs_refund = 1');
    if (q.q) {
      const term = String(q.q).trim().slice(0, 60);
      const ph = normalizePhone(term);
      const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
      where.push("(code = ? OR phone = ? OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\')");
      args.push(term.replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)), ph || '-', like, like, like);
    }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
  }

  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // جلوگیری از تزریق فرمول در Excel
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const route = (method, path, handler, opts = {}) => ({ method, path, handler, admin: opts.public ? false : true });

  const r = [];

  /* ----- نشست ----- */
  r.push(route('POST', '/admin/api/login', ({ body, ip, hit, setCookie }) => {
    hit(`login:${ip}`, 20, 15 * 60_000);
    const s = auth.login(body?.username ?? '', body?.password ?? '');
    setCookie(s.token, s.maxAge);
    return { ok: true, username: s.username, csrf: s.csrf };
  }, { public: true }));
  r.push(route('POST', '/admin/api/logout', ({ token, clearCookie }) => { auth.logout(token); clearCookie(); return { ok: true }; }, { public: true }));
  r.push(route('GET', '/admin/api/me', ({ session }) => ({ authenticated: !!session, username: session?.username ?? null, csrf: session?.csrf ?? null }), { public: true, soft: true }));
  r.push(route('POST', '/admin/api/password', ({ body, session, clearCookie }) => {
    if (!auth.verifyAdminPassword(session.adminId, body?.current_password)) throw new AppError(403, 'bad_password', 'رمز عبور فعلی درست نیست.');
    const e = validatePasswordStrength(body?.new_password);
    if (e) throw new ValidationError({ new_password: e }, e);
    auth.setPassword(session.adminId, body.new_password);
    clearCookie();
    return { ok: true, relogin: true };
  }));

  /* ----- وضعیت سیستم ----- */
  r.push(route('GET', '/admin/api/system', () => ({
    gateway: gateway.name, gateway_is_test: gateway.isTest, sms_enabled: sms.enabled, otp_required: sms.otpRequired,
    base_url: config.baseUrl, today: clock.today(), today_jalali: isoToJalaliString(clock.today()), today_long: jalaliLong(clock.today()),
    hours_are_default: db.prepare("SELECT value FROM meta WHERE key='hours_reviewed'").get() == null,
  })));

  /* ----- رزروها ----- */
  r.push(route('GET', '/admin/api/bookings', ({ query }) => {
    const { sql, args } = filterBookings(query);
    const limit = Math.min(intInRange(query.limit, 1, 500) ?? 200, 500);
    const offset = intInRange(query.offset, 0, 1e6) ?? 0;
    const total = db.prepare(`SELECT COUNT(*) c FROM bookings ${sql}`).get(...args).c;
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    const rows = db.prepare(`SELECT * FROM bookings ${sql} ORDER BY date ${order}, start_time ${order}, id ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { total, bookings: rows.map(decorate) };
  }));
  r.push(route('GET', '/admin/api/bookings/:id', ({ params }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(params.id));
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    const payments = db.prepare('SELECT id,gateway,authority,amount_toman,status,ref_id,card_pan,gateway_code,created_at,verified_at FROM payments WHERE booking_id=? ORDER BY id').all(b.id)
      .map((p) => ({ ...p, created_at: clock.isoLocal(p.created_at), verified_at: p.verified_at ? clock.isoLocal(p.verified_at) : null }));
    return { booking: decorate(b), payments };
  }));
  r.push(route('POST', '/admin/api/bookings/:id/cancel', ({ params, body }) => ({ booking: decorate(svc.cancel(Number(params.id), { reason: str(body?.reason, 300), deposit: body?.deposit || 'undecided' })) })));
  r.push(route('POST', '/admin/api/bookings/:id/attendance', ({ params, body }) => { svc.setAttendance(Number(params.id), body?.value ?? null); return { ok: true }; }));
  r.push(route('POST', '/admin/api/bookings/:id/settle', ({ params, body }) => { svc.settle(Number(params.id), body?.settled === true); return { ok: true }; }));
  r.push(route('POST', '/admin/api/bookings/:id/refunded', ({ params }) => { svc.markRefunded(Number(params.id)); return { ok: true }; }));
  r.push(route('POST', '/admin/api/bookings/:id/reconcile', async ({ params }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(params.id));
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    const results = await svc.reconcileBooking(b.id);
    return { results, booking: decorate(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) };
  }));

  /* ----- تنظیمات عمومی ----- */
  const SETTING_RULES = {
    business_name: (v) => { const s = str(v, 60); need(s.length >= 1, 'نام آرایشگاه را وارد کنید.', 'business_name'); return s; },
    tagline: (v) => str(v, 120), intro: (v) => str(v, 300), phone: (v) => str(v, 30), address: (v) => str(v, 200),
    instagram_url: (v) => { const s = str(v, 200); need(s === '' || /^https:\/\/(www\.)?instagram\.com\/[\w.\-\/?=&]+$/i.test(s), 'لینک اینستاگرام باید با https://instagram.com/ شروع شود.', 'instagram_url'); return s; },
    logo_url: (v) => { const s = str(v, 200); need(s === '' || /^\/img\/[\w.\-]+$/.test(s) || /^https:\/\/[^\s"'<>]+$/i.test(s), 'نشانی لوگو نامعتبر است.', 'logo_url'); return s; },
    rules: (v) => str(v, 3000),
    hold_minutes: (v) => { const n = intInRange(v, 5, 60); need(n != null, 'مهلت پرداخت باید بین ۵ تا ۶۰ دقیقه باشد.', 'hold_minutes'); return n; },
    booking_window_days: (v) => { const n = intInRange(v, 1, 90); need(n != null, 'بازه‌ی رزرو باید بین ۱ تا ۹۰ روز باشد.', 'booking_window_days'); return n; },
    min_lead_minutes: (v) => { const n = intInRange(v, 0, 1440); need(n != null, 'حداقل فاصله تا نوبت باید بین ۰ تا ۱۴۴۰ دقیقه باشد.', 'min_lead_minutes'); return n; },
    reminder_hours_before: (v) => { const n = intInRange(v, 1, 48); need(n != null, 'زمان یادآوری باید بین ۱ تا ۴۸ ساعت باشد.', 'reminder_hours_before'); return n; },
    max_pending_per_phone: (v) => { const n = intInRange(v, 1, 5); need(n != null, 'مقدار نامعتبر است.', 'max_pending_per_phone'); return n; },
  };
  r.push(route('GET', '/admin/api/settings', () => ({ settings: getSettings(db) })));
  r.push(route('PUT', '/admin/api/settings', ({ body }) => {
    const patch = {};
    for (const [k, v] of Object.entries(body || {})) if (Object.hasOwn(SETTING_RULES, k)) patch[k] = SETTING_RULES[k](v);
    setSettings(db, patch);
    return { settings: getSettings(db) };
  }));

  /* ----- ساعات کاری ----- */
  r.push(route('GET', '/admin/api/hours', () => ({ hours: db.prepare('SELECT * FROM working_hours ORDER BY weekday').all() })));
  r.push(route('PUT', '/admin/api/hours', ({ body }) => {
    need(Array.isArray(body?.hours) && body.hours.length === 7, 'برنامه‌ی هفتگی باید ۷ روز داشته باشد.');
    const seen = new Set();
    for (const h of body.hours) {
      need(Number.isInteger(h.weekday) && h.weekday >= 0 && h.weekday <= 6 && !seen.has(h.weekday), 'روز هفته نامعتبر است.'); seen.add(h.weekday);
      need(isTime(h.start_time) && isTime(h.end_time), 'ساعت نامعتبر است.');
      need(!h.is_open || h.start_time < h.end_time, 'ساعت پایان باید بعد از ساعت شروع باشد.');
    }
    tx(db, () => {
      const up = db.prepare('UPDATE working_hours SET is_open=?, start_time=?, end_time=? WHERE weekday=?');
      for (const h of body.hours) up.run(h.is_open ? 1 : 0, h.start_time, h.end_time, h.weekday);
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('hours_reviewed','1')").run();
    });
    return { hours: db.prepare('SELECT * FROM working_hours ORDER BY weekday').all() };
  }));

  /* ----- تعطیلات و بلوک زمانی ----- */
  const countConflicts = (date, from = '00:00', to = '23:59') => db.prepare(
    "SELECT COUNT(*) c FROM bookings WHERE date=? AND status IN ('confirmed','pending_payment') AND start_time < ? AND end_time > ?").get(date, to, from).c;

  r.push(route('GET', '/admin/api/calendar', ({ query }) => {
    const from = isIsoDate(query.from) ? query.from : clock.today();
    const count = Math.min(intInRange(query.count, 1, 120) ?? 60, 120);
    const closed = new Map(db.prepare('SELECT date,reason FROM closed_days').all().map((x) => [x.date, x.reason]));
    const days = [];
    for (let i = 0; i < count; i++) {
      const d = clock.addDays(from, i);
      const wd = clock.weekdayIndex(d);
      const h = db.prepare('SELECT is_open FROM working_hours WHERE weekday=?').get(wd);
      days.push({ date: d, weekday: clock.weekdayName(d), jalali: isoToJalaliString(d), weekly_open: !!h?.is_open, closed: closed.has(d), reason: closed.get(d) || '',
        bookings: db.prepare("SELECT COUNT(*) c FROM bookings WHERE date=? AND status IN ('confirmed','pending_payment')").get(d).c });
    }
    return { days };
  }));
  r.push(route('POST', '/admin/api/closed', ({ body }) => {
    need(isIsoDate(body?.date), 'تاریخ نامعتبر است.', 'date');
    db.prepare('INSERT INTO closed_days(date,reason) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET reason=excluded.reason').run(body.date, str(body.reason, 100));
    return { ok: true, conflicts: countConflicts(body.date) };
  }));
  r.push(route('DELETE', '/admin/api/closed/:date', ({ params }) => { need(isIsoDate(params.date), 'تاریخ نامعتبر است.'); db.prepare('DELETE FROM closed_days WHERE date=?').run(params.date); return { ok: true }; }));

  r.push(route('GET', '/admin/api/blocked', ({ query }) => {
    const from = isIsoDate(query.from) ? query.from : clock.today();
    const rows = db.prepare('SELECT * FROM blocked_slots WHERE date >= ? ORDER BY date,start_time').all(from);
    return { blocked: rows.map((b) => ({ ...b, jalali: isoToJalaliString(b.date), weekday: clock.weekdayName(b.date) })) };
  }));
  r.push(route('POST', '/admin/api/blocked', ({ body }) => {
    need(isIsoDate(body?.date), 'تاریخ نامعتبر است.', 'date');
    need(isTime(body?.start_time) && isTime(body?.end_time) && body.start_time < body.end_time, 'بازه‌ی زمانی نامعتبر است.', 'start_time');
    const id = Number(db.prepare('INSERT INTO blocked_slots(date,start_time,end_time,reason) VALUES (?,?,?,?)').run(body.date, body.start_time, body.end_time, str(body.reason, 100)).lastInsertRowid);
    return { id, conflicts: countConflicts(body.date, body.start_time, body.end_time) };
  }));
  r.push(route('DELETE', '/admin/api/blocked/:id', ({ params }) => { db.prepare('DELETE FROM blocked_slots WHERE id=?').run(Number(params.id)); return { ok: true }; }));

  /* ----- خدمات ----- */
  function parseService(body) {
    const name = str(body?.name, 60);
    need(name.length >= 2, 'نام خدمت را وارد کنید.', 'name');
    const duration = intInRange(body?.duration_min, 15, 480); need(duration != null, 'مدت خدمت باید بین ۱۵ تا ۴۸۰ دقیقه باشد.', 'duration_min');
    const price = intInRange(body?.price_toman, 1000, 100_000_000); need(price != null, 'قیمت نامعتبر است (به تومان).', 'price_toman');
    const deposit = intInRange(body?.deposit_toman, 1000, 100_000_000); need(deposit != null, 'مبلغ بیعانه نامعتبر است (به تومان).', 'deposit_toman');
    need(deposit <= price, 'بیعانه نمی‌تواند بیشتر از قیمت کامل باشد.', 'deposit_toman');
    return { name, duration, price, deposit, active: body?.active === false ? 0 : 1 };
  }
  r.push(route('GET', '/admin/api/services', () => ({ services: db.prepare('SELECT * FROM services ORDER BY sort_order,id').all() })));
  r.push(route('POST', '/admin/api/services', ({ body }) => {
    const s = parseService(body);
    const id = Number(db.prepare('INSERT INTO services(name,duration_min,price_toman,deposit_toman,active,sort_order) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM services))').run(s.name, s.duration, s.price, s.deposit, s.active).lastInsertRowid);
    return { id };
  }));
  r.push(route('PUT', '/admin/api/services/:id', ({ params, body }) => {
    const id = Number(params.id);
    need(db.prepare('SELECT 1 FROM services WHERE id=?').get(id), 'خدمت پیدا نشد.');
    const s = parseService(body);
    tx(db, () => {
      db.prepare('UPDATE services SET name=?,duration_min=?,price_toman=?,deposit_toman=?,active=? WHERE id=?').run(s.name, s.duration, s.price, s.deposit, s.active, id);
      need(db.prepare('SELECT 1 FROM services WHERE active=1').get(), 'حداقل یک خدمت باید فعال بماند.');
    });
    return { ok: true }; // رزروهای قبلی با قیمت زمان ثبت باقی می‌مانند
  }));

  /* ----- گزارش و خروجی ----- */
  r.push(route('GET', '/admin/api/report', ({ query }) => {
    const from = isIsoDate(query.from) ? query.from : clock.addDays(clock.today(), -30);
    const to = isIsoDate(query.to) ? query.to : clock.today();
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM bookings WHERE date BETWEEN ? AND ? GROUP BY status').all(from, to).map((x) => [x.status, x.c]));
    const dep = db.prepare(`SELECT COALESCE(SUM(p.amount_toman),0) s, SUM(p.gateway='mock') m FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.status='verified' AND b.date BETWEEN ? AND ?`).get(from, to);
    const refunded = db.prepare("SELECT COALESCE(SUM(deposit_toman),0) s FROM bookings WHERE payment_status='refunded' AND date BETWEEN ? AND ?").get(from, to).s;
    const settled = db.prepare("SELECT COALESCE(SUM(remaining_toman),0) s FROM bookings WHERE status='confirmed' AND remaining_settled_at IS NOT NULL AND date BETWEEN ? AND ?").get(from, to).s;
    const pending = db.prepare("SELECT COALESCE(SUM(remaining_toman),0) s FROM bookings WHERE status='confirmed' AND remaining_settled_at IS NULL AND date BETWEEN ? AND ?").get(from, to).s;
    const needsRefund = db.prepare("SELECT COUNT(*) c FROM bookings WHERE needs_refund=1").get().c;
    const daily = db.prepare(`SELECT b.date, COUNT(*) n, SUM(b.deposit_toman) dep FROM bookings b WHERE b.status='confirmed' AND b.date BETWEEN ? AND ? GROUP BY b.date ORDER BY b.date`).all(from, to)
      .map((d) => ({ ...d, jalali: isoToJalaliString(d.date) }));
    return {
      from, to, from_jalali: isoToJalaliString(from), to_jalali: isoToJalaliString(to), counts,
      deposits_received: dep.s, deposits_refunded: refunded, deposits_net: dep.s - refunded,
      remaining_settled: settled, remaining_pending: pending, total_income: dep.s - refunded + settled,
      needs_refund_count: needsRefund, includes_test_payments: !!dep.m, daily,
    };
  }));
  r.push(route('GET', '/admin/api/export.csv', ({ query }) => {
    const { sql, args } = filterBookings(query);
    const rows = db.prepare(`SELECT * FROM bookings ${sql} ORDER BY date, start_time, id LIMIT 20000`).all(...args);
    const head = ['کد پیگیری', 'نام', 'نام خانوادگی', 'موبایل', 'تاریخ شمسی', 'تاریخ میلادی', 'شروع', 'پایان', 'خدمت', 'قیمت کامل (تومان)', 'بیعانه (تومان)', 'باقی‌مانده (تومان)',
      'وضعیت رزرو', 'وضعیت پرداخت', 'درگاه', 'مراجعه', 'تسویه باقی‌مانده', 'نیازمند بازپرداخت', 'ثبت رزرو'];
    const lines = [head.join(',')];
    for (const b of rows) {
      lines.push([b.code, b.first_name, b.last_name, b.phone, b.jalali_date, b.date, b.start_time, b.end_time, b.service_name, b.price_toman, b.deposit_toman, b.remaining_toman,
        STATUS_FA[b.status], PAY_FA[b.payment_status], b.gateway === 'mock' ? 'آزمایشی' : (b.gateway || ''), ATT_FA[b.attendance] || '', b.remaining_settled_at ? 'بله' : 'خیر', b.needs_refund ? 'بله' : 'خیر', clock.isoLocal(b.created_at)].map(csvCell).join(','));
    }
    return { __csv: '\uFEFF' + lines.join('\r\n') + '\r\n' };
  }));

  return r;
}
