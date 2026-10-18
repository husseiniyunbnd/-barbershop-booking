// هسته‌ی رزرو: ساعت‌های آزاد، رزرو موقت، پرداخت، تأیید و بازیابی تراکنش.
import crypto from 'node:crypto';
import { getSettings, getSecret, tx } from './db.js';
import { AppError } from './errors.js';
import { isIsoDate, isTime } from './time.js';
import { validateCustomer } from './validators.js';
import { isoToJalaliString, jalaliLong, toFaDigits } from '../public/js/jalali.js';

const ACTIVE_NOW = `(status='confirmed' OR (status='pending_payment' AND hold_expires_at > ?))`;

export function createBookingService({ db, clock, config, gateway, sms }) {
  const secret = getSecret(db);
  const settings = () => getSettings(db);

  /* ---------- ابزار ---------- */
  const receiptToken = (code) => crypto.createHmac('sha256', secret).update('receipt:' + code).digest('hex').slice(0, 32);
  const tokenOk = (code, t) => {
    const a = Buffer.from(receiptToken(code));
    const b = Buffer.from(String(t ?? ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const newCode = () => {
    for (let i = 0; i < 20; i++) {
      const c = String(crypto.randomInt(10_000_000, 100_000_000));
      if (!db.prepare('SELECT 1 FROM bookings WHERE code=?').get(c)) return c;
    }
    throw new AppError(500, 'code_generation', 'ساخت کد پیگیری ممکن نشد.');
  };

  const getService = (id) => db.prepare('SELECT * FROM services WHERE id=?').get(id);
  const activeServices = () => db.prepare('SELECT * FROM services WHERE active=1 ORDER BY sort_order, id').all();
  const resolveService = (id) => {
    const list = activeServices();
    if (id == null || id === '') return list[0] || null;
    return list.find((s) => s.id === Number(id)) || null;
  };

  /* ---------- ساعت‌های آزاد ---------- */
  function daySchedule(date) {
    const wd = clock.weekdayIndex(date);
    const h = db.prepare('SELECT * FROM working_hours WHERE weekday=?').get(wd);
    const closedRow = db.prepare('SELECT reason FROM closed_days WHERE date=?').get(date);
    if (!h || !h.is_open) return { open: false, reason: 'weekly_off' };
    if (closedRow) return { open: false, reason: 'holiday', note: closedRow.reason };
    return { open: true, start: clock.timeToMinutes(h.start_time), end: clock.timeToMinutes(h.end_time) };
  }

  /** وضعیت تک‌تک بازه‌های یک روز: free | booked | disabled */
  function computeSlots(date, service) {
    const sch = daySchedule(date);
    if (!sch.open) return { sch, slots: [] };
    const now = clock.nowMs();
    const { min_lead_minutes } = settings();
    const blocked = db.prepare('SELECT * FROM blocked_slots WHERE date=?').all(date);
    const taken = db.prepare(`SELECT start_ts,end_ts FROM bookings WHERE date=? AND ${ACTIVE_NOW}`).all(date, now);
    const slots = [];
    for (let m = sch.start; m + service.duration_min <= sch.end; m += service.duration_min) {
      const start_time = clock.minutesToTime(m);
      const end_time = clock.minutesToTime(m + service.duration_min);
      const s = clock.tsOf(date, start_time);
      const e = clock.tsOf(date, end_time);
      let state = 'free';
      let reason = null;
      if (s < now + min_lead_minutes * 60_000) { state = 'disabled'; reason = 'past'; }
      else if (blocked.some((b) => clock.timeToMinutes(b.start_time) < m + service.duration_min && clock.timeToMinutes(b.end_time) > m)) { state = 'disabled'; reason = 'blocked'; }
      else if (taken.some((t) => t.start_ts < e && t.end_ts > s)) { state = 'booked'; }
      slots.push({ start_time, end_time, state, reason });
    }
    return { sch, slots };
  }

  function dayLabel(date) {
    return { date, weekday: clock.weekdayName(date), weekday_index: clock.weekdayIndex(date), jalali: isoToJalaliString(date), jalali_long: jalaliLong(date) };
  }

  function listDays(service) {
    const s = settings();
    const today = clock.today();
    const last = clock.addDays(today, s.booking_window_days);
    const start = clock.weekStart(today);
    const endWeek = clock.addDays(clock.weekStart(last), 6);
    const days = [];
    for (let d = start; d <= endWeek; d = clock.addDays(d, 1)) {
      const info = { ...dayLabel(d), state: 'open', free_count: 0 };
      if (d < today) info.state = 'past';
      else if (d > last) info.state = 'beyond';
      else {
        const { sch, slots } = computeSlots(d, service);
        if (!sch.open) { info.state = 'closed'; info.note = sch.note || ''; }
        else {
          info.free_count = slots.filter((x) => x.state === 'free').length;
          info.total = slots.length;
          if (info.free_count === 0) info.state = slots.some((x) => x.state === 'booked') ? 'full' : 'closed';
        }
      }
      days.push(info);
    }
    return days;
  }

  function listSlots(date, service) {
    if (!isIsoDate(date)) throw new AppError(400, 'bad_date', 'تاریخ نامعتبر است.');
    const s = settings();
    const today = clock.today();
    if (date < today || date > clock.addDays(today, s.booking_window_days)) return { ...dayLabel(date), open: false, slots: [] };
    const { sch, slots } = computeSlots(date, service);
    return { ...dayLabel(date), open: sch.open, note: sch.note || '', slots };
  }

  /* ---------- رزرو موقت ---------- */
  function expireStale() {
    const now = clock.nowMs();
    return db.prepare("UPDATE bookings SET status='expired', updated_at=? WHERE status='pending_payment' AND hold_expires_at <= ?").run(now, now).changes;
  }

  function createHold(body) {
    const customer = validateCustomer(body);
    const service = resolveService(body?.service_id);
    if (!service) throw new AppError(400, 'bad_service', 'خدمت انتخاب‌شده در دسترس نیست.');
    const { date, start_time } = body || {};
    if (!isIsoDate(date) || !isTime(start_time)) throw new AppError(400, 'bad_slot', 'روز یا ساعت نامعتبر است.');
    if (body?.accept_rules !== true) throw new AppError(400, 'rules_not_accepted', 'برای ادامه باید قوانین رزرو را بپذیرید.', { fields: { accept_rules: 'پذیرش قوانین الزامی است.' } });

    const s = settings();
    return tx(db, () => {
      expireStale();
      const now = clock.nowMs();
      const { slots, sch } = computeSlots(date, service);
      const today = clock.today();
      const slot = slots.find((x) => x.start_time === start_time);
      if (date < today || date > clock.addDays(today, s.booking_window_days) || !sch.open || !slot) {
        throw new AppError(409, 'slot_unavailable', 'این زمان برای رزرو در دسترس نیست. لطفاً زمان دیگری انتخاب کنید.');
      }
      // رزرو موقتِ قبلیِ همین مشتری روی همین ساعت → همان را برگردان (جلوگیری از رزرو تکراری هنگام تلاش مجدد)
      const same = db.prepare(`SELECT * FROM bookings WHERE status='pending_payment' AND hold_expires_at > ? AND phone=? AND date=? AND start_time=? AND service_id=? AND first_name=? AND last_name=?`)
        .get(now, customer.phone, date, start_time, service.id, customer.first_name, customer.last_name);
      if (same) return same;
      if (slot.state !== 'free') throw new AppError(409, 'slot_taken', 'این ساعت همین حالا توسط شخص دیگری رزرو شد. لطفاً ساعت دیگری انتخاب کنید.');

      const pend = db.prepare("SELECT COUNT(*) c FROM bookings WHERE phone=? AND status='pending_payment' AND hold_expires_at > ?").get(customer.phone, now).c;
      if (pend >= s.max_pending_per_phone) throw new AppError(429, 'too_many_pending', 'چند رزرو پرداخت‌نشده دارید. لطفاً چند دقیقه بعد دوباره تلاش کنید.');

      const end_time = clock.minutesToTime(clock.timeToMinutes(start_time) + service.duration_min);
      const row = {
        code: newCode(), ...customer, service_id: service.id, service_name: service.name, duration_min: service.duration_min,
        price_toman: service.price_toman, deposit_toman: service.deposit_toman, remaining_toman: service.price_toman - service.deposit_toman,
        date, jalali_date: isoToJalaliString(date), start_time, end_time,
        start_ts: clock.tsOf(date, start_time), end_ts: clock.tsOf(date, end_time),
        hold_expires_at: now + s.hold_minutes * 60_000, created_at: now, updated_at: now,
      };
      try {
        db.prepare(`INSERT INTO bookings(code,first_name,last_name,phone,service_id,service_name,duration_min,price_toman,deposit_toman,remaining_toman,date,jalali_date,start_time,end_time,start_ts,end_ts,status,payment_status,hold_expires_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_payment','unpaid',?,?,?)`)
          .run(row.code, row.first_name, row.last_name, row.phone, row.service_id, row.service_name, row.duration_min, row.price_toman, row.deposit_toman, row.remaining_toman,
            row.date, row.jalali_date, row.start_time, row.end_time, row.start_ts, row.end_ts, row.hold_expires_at, row.created_at, row.updated_at);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) throw new AppError(409, 'slot_taken', 'این ساعت همین حالا توسط شخص دیگری رزرو شد. لطفاً ساعت دیگری انتخاب کنید.');
        throw e;
      }
      return db.prepare('SELECT * FROM bookings WHERE code=?').get(row.code);
    });
  }

  /* ---------- پرداخت ---------- */
  const bookingByCode = (code) => db.prepare('SELECT * FROM bookings WHERE code=?').get(String(code));

  async function startPayment(code) {
    const s = settings();
    let b = bookingByCode(code);
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    if (b.status === 'confirmed') throw new AppError(409, 'already_confirmed', 'این نوبت قبلاً قطعی شده است.');
    if (b.status !== 'pending_payment' || b.hold_expires_at <= clock.nowMs()) {
      throw new AppError(409, 'hold_expired', 'مهلت پرداخت این رزرو تمام شده است. لطفاً دوباره نوبت بگیرید.');
    }
    const attempts = db.prepare('SELECT COUNT(*) c FROM payments WHERE booking_id=?').get(b.id).c;
    if (attempts >= 5) throw new AppError(429, 'too_many_attempts', 'تعداد تلاش‌های پرداخت بیش از حد مجاز است. نوبت جدید بگیرید.');

    // مبلغ فقط از رکورد سرور خوانده می‌شود
    const amount = b.deposit_toman;
    const callbackUrl = `${config.baseUrl}/payment/callback`;
    const r = await gateway.request({
      amountToman: amount, mobile: b.phone, callbackUrl,
      description: `بیعانه نوبت ${b.code}`,
    }).catch((e) => {
      throw new AppError(502, e.code || 'gateway_error', 'اتصال به درگاه پرداخت انجام نشد. چند لحظه بعد دوباره تلاش کنید.');
    });

    tx(db, () => {
      const cur = db.prepare('SELECT status FROM bookings WHERE id=?').get(b.id);
      if (cur.status !== 'pending_payment') throw new AppError(409, 'hold_expired', 'مهلت پرداخت این رزرو تمام شده است. لطفاً دوباره نوبت بگیرید.');
      const now = clock.nowMs();
      db.prepare(`INSERT INTO payments(booking_id,gateway,authority,amount_toman,amount_gateway,status,created_at,updated_at) VALUES (?,?,?,?,?,'initiated',?,?)`)
        .run(b.id, gateway.name, r.authority, amount, r.amountGateway, now, now);
      // تا پایان فرایند پرداخت، ساعت برای مشتری نگه داشته می‌شود
      db.prepare('UPDATE bookings SET hold_expires_at=MAX(hold_expires_at, ?), gateway=?, updated_at=? WHERE id=?')
        .run(now + s.hold_minutes * 60_000, gateway.name, now, b.id);
    });
    return { redirect_url: r.redirectUrl };
  }

  /** تأیید یک پرداختِ تأییدشده توسط درگاه؛ idempotent است. */
  function applyVerified(paymentId, v) {
    return tx(db, () => {
      const now = clock.nowMs();
      const p = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
      if (p.status === 'verified') return { booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(p.booking_id), changed: false };
      try {
        db.prepare("UPDATE payments SET status='verified', ref_id=?, card_pan=?, gateway_code=?, verified_at=?, updated_at=? WHERE id=?")
          .run(v.refId ?? null, v.cardPan ?? null, v.code ?? null, now, now, p.id);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) throw new AppError(409, 'duplicate_ref', 'این تراکنش قبلاً ثبت شده است.');
        throw e;
      }
      let b = db.prepare('SELECT * FROM bookings WHERE id=?').get(p.booking_id);
      let changed = false;
      if (b.status === 'confirmed') {
        // پرداخت دوم برای رزروی که قبلاً قطعی شده
        db.prepare("UPDATE bookings SET needs_refund=1, admin_note=?, updated_at=? WHERE id=?").run(trim(`${b.admin_note} پرداخت تکراری (${p.authority})`), now, b.id);
      } else if (b.status === 'pending_payment') {
        db.prepare("UPDATE bookings SET status='confirmed', payment_status='paid', confirmed_at=?, hold_expires_at=NULL, gateway=?, updated_at=? WHERE id=?").run(now, p.gateway, now, b.id);
        changed = true;
      } else if (b.status === 'expired') {
        const clash = db.prepare(`SELECT 1 FROM bookings WHERE id<>? AND date=? AND start_ts < ? AND end_ts > ? AND ${ACTIVE_NOW}`).get(b.id, b.date, b.end_ts, b.start_ts, now);
        if (!clash) {
          db.prepare("UPDATE bookings SET status='confirmed', payment_status='paid', confirmed_at=?, hold_expires_at=NULL, gateway=?, admin_note=?, updated_at=? WHERE id=?")
            .run(now, p.gateway, trim(`${b.admin_note} پرداخت پس از پایان مهلت رسید و چون ساعت آزاد بود نوبت قطعی شد.`), now, b.id);
          changed = true;
        } else {
          db.prepare("UPDATE bookings SET payment_status='paid', needs_refund=1, deposit_outcome='refund_due', admin_note=?, updated_at=? WHERE id=?")
            .run(trim(`${b.admin_note} پرداخت پس از پایان مهلت انجام شد ولی ساعت به شخص دیگری رسیده؛ بیعانه باید بازپرداخت شود.`), now, b.id);
        }
      } else { // cancelled
        db.prepare("UPDATE bookings SET payment_status='paid', needs_refund=1, deposit_outcome='refund_due', updated_at=? WHERE id=?").run(now, b.id);
      }
      b = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
      return { booking: b, changed };
    });
  }
  const trim = (s) => String(s).trim().slice(0, 500);

  function markPayment(paymentId, status, code) {
    const now = clock.nowMs();
    db.prepare("UPDATE payments SET status=?, gateway_code=COALESCE(?,gateway_code), updated_at=? WHERE id=? AND status<>'verified'").run(status, code ?? null, now, paymentId);
    const p = db.prepare('SELECT booking_id FROM payments WHERE id=?').get(paymentId);
    db.prepare("UPDATE bookings SET payment_status='failed', updated_at=? WHERE id=? AND payment_status='unpaid'").run(now, p.booking_id);
  }

  async function verifyPayment(p) {
    const v = await gateway.verify({ authority: p.authority, amountGateway: p.amount_gateway });
    if (v.status === 'verified') {
      const r = applyVerified(p.id, v);
      if (r.changed) notifyConfirmed(r.booking);
      return 'verified';
    }
    if (v.status === 'failed') { markPayment(p.id, 'failed', v.code); return 'failed'; }
    return 'unknown';
  }

  /** بازگشت از درگاه. فقط authority خوانده می‌شود؛ مبلغ و نتیجه از سرور/درگاه می‌آید. */
  async function handleCallback(authority, status) {
    const p = authority ? db.prepare('SELECT * FROM payments WHERE authority=?').get(String(authority)) : null;
    if (!p) return null;
    const b = db.prepare('SELECT code FROM bookings WHERE id=?').get(p.booking_id);
    if (p.status !== 'verified') {
      if (status !== 'OK') markPayment(p.id, 'cancelled');
      else await verifyPayment(p);
    }
    return b.code;
  }

  /** تطبیق دستی/خودکار: وضعیت تراکنش‌های نامشخص را از درگاه می‌پرسد. */
  async function reconcileBooking(bookingId) {
    const pays = db.prepare("SELECT * FROM payments WHERE booking_id=? AND status IN ('initiated','failed','cancelled') ORDER BY id DESC").all(bookingId);
    const results = [];
    for (const p of pays) {
      results.push(await verifyPayment(p));
      if (results.at(-1) === 'verified') break;
    }
    return results;
  }

  /* ---------- نمایش ---------- */
  function lastPayment(id) {
    return db.prepare('SELECT * FROM payments WHERE booking_id=? ORDER BY id DESC LIMIT 1').get(id);
  }

  function publicView(b) {
    const p = lastPayment(b.id);
    const biz = settings();
    const outcome = b.status === 'confirmed' ? 'confirmed'
      : b.needs_refund ? 'paid_not_assigned'
      : b.status === 'expired' ? 'expired'
      : b.status === 'cancelled' ? 'cancelled'
      : (p && ['failed', 'cancelled'].includes(p.status)) ? 'payment_failed'
      : 'pending';
    return {
      code: b.code, name: `${b.first_name} ${b.last_name}`,
      phone_masked: b.phone ? `${b.phone.slice(0, 4)}***${b.phone.slice(7)}` : '',
      date: b.date, weekday: clock.weekdayName(b.date), jalali: b.jalali_date, jalali_long: jalaliLong(b.date),
      start_time: b.start_time, end_time: b.end_time, service_name: b.service_name, duration_min: b.duration_min,
      price_toman: b.price_toman, deposit_toman: b.deposit_toman, remaining_toman: b.remaining_toman,
      status: b.status, payment_status: b.payment_status, outcome,
      hold_expires_at: b.status === 'pending_payment' ? b.hold_expires_at : null,
      last_payment_status: p?.status || null, ref_id: p?.status === 'verified' ? p.ref_id : null,
      is_test_payment: p?.gateway === 'mock',
      business: { name: biz.business_name, phone: biz.phone, address: biz.address },
    };
  }

  function icsFor(b) {
    const biz = settings();
    const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barbershop Booking//FA//', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${b.code}@barbershop-booking`, `DTSTAMP:${z(clock.nowMs())}`, `DTSTART:${z(b.start_ts)}`, `DTEND:${z(b.end_ts)}`,
      `SUMMARY:${esc(`${b.service_name} - ${biz.business_name}`)}`,
      `DESCRIPTION:${esc(`کد پیگیری: ${b.code}\nمبلغ باقی‌مانده: ${b.remaining_toman} تومان`)}`,
      `LOCATION:${esc(biz.address)}`, 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
  }

  /* ---------- پیامک ---------- */
  function notifyConfirmed(b) {
    const biz = settings();
    sms.send({ to: b.phone, type: 'confirmation', bookingId: b.id,
      text: `${b.first_name} عزیز، نوبت شما در ${biz.business_name} برای ${clock.weekdayName(b.date)} ${toFaDigits(b.jalali_date)} ساعت ${toFaDigits(b.start_time)} قطعی شد. کد پیگیری: ${toFaDigits(b.code)}` }).catch(() => {});
  }

  /* ---------- عملیات مدیر ---------- */
  function cancel(id, { reason = '', deposit = 'undecided' } = {}) {
    if (!['undecided', 'refund_due', 'forfeited'].includes(deposit)) throw new AppError(400, 'bad_deposit', 'تکلیف بیعانه نامعتبر است.');
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    if (!['confirmed', 'pending_payment'].includes(b.status)) throw new AppError(409, 'not_cancellable', 'این رزرو قابل لغو نیست.');
    const now = clock.nowMs();
    const paid = b.payment_status === 'paid';
    db.prepare("UPDATE bookings SET status='cancelled', cancel_reason=?, cancelled_at=?, deposit_outcome=?, updated_at=? WHERE id=?")
      .run(String(reason).slice(0, 300), now, paid ? deposit : null, now, id);
    const nb = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    if (paid) {
      const biz = settings();
      sms.send({ to: nb.phone, type: 'cancellation', bookingId: nb.id,
        text: `نوبت شما در ${biz.business_name} (کد ${toFaDigits(nb.code)}) لغو شد.${biz.phone ? ' برای هماهنگی با ' + toFaDigits(biz.phone) + ' تماس بگیرید.' : ''}` }).catch(() => {});
    }
    return nb;
  }

  function setAttendance(id, value) {
    if (![null, 'attended', 'no_show'].includes(value)) throw new AppError(400, 'bad_value', 'مقدار نامعتبر است.');
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    if (b.status !== 'confirmed') throw new AppError(409, 'not_confirmed', 'فقط برای نوبت قطعی‌شده قابل ثبت است.');
    db.prepare('UPDATE bookings SET attendance=?, updated_at=? WHERE id=?').run(value, clock.nowMs(), id);
  }

  function settle(id, settled) {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    if (b.status !== 'confirmed') throw new AppError(409, 'not_confirmed', 'فقط برای نوبت قطعی‌شده قابل ثبت است.');
    const now = clock.nowMs();
    db.prepare('UPDATE bookings SET remaining_settled_at=?, updated_at=? WHERE id=?').run(settled ? now : null, now, id);
  }

  function markRefunded(id) {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    if (!b) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    if (b.payment_status !== 'paid') throw new AppError(409, 'not_paid', 'برای این رزرو بیعانه‌ای پرداخت نشده است.');
    db.prepare("UPDATE bookings SET payment_status='refunded', deposit_outcome='refunded', needs_refund=0, updated_at=? WHERE id=?").run(clock.nowMs(), id);
  }

  /* ---------- پاروبِ دوره‌ای ---------- */
  async function sweep() {
    const now = clock.nowMs();
    // ۱) قبل از منقضی‌کردن، رزروهایی که پرداخت آغازشده دارند از درگاه استعلام می‌شوند
    const stale = db.prepare(`SELECT DISTINCT b.id FROM bookings b JOIN payments p ON p.booking_id=b.id
      WHERE b.status='pending_payment' AND b.hold_expires_at <= ? AND p.status='initiated'`).all(now);
    for (const r of stale) await reconcileBooking(r.id).catch(() => {});
    const expired = tx(db, () => expireStale());
    // ۲) پرداخت‌های دیرهنگام در ۲۴ ساعت اخیر
    const late = db.prepare(`SELECT DISTINCT b.id FROM bookings b JOIN payments p ON p.booking_id=b.id
      WHERE b.status='expired' AND b.updated_at > ? AND p.status='initiated'`).all(now - 24 * 3600_000);
    for (const r of late) await reconcileBooking(r.id).catch(() => {});
    // ۳) یادآوری
    let reminded = 0;
    if (sms.enabled) {
      const hrs = settings().reminder_hours_before;
      const due = db.prepare("SELECT * FROM bookings WHERE status='confirmed' AND reminder_sent_at IS NULL AND start_ts > ? AND start_ts <= ?").all(now, now + hrs * 3600_000);
      const biz = settings();
      for (const b of due) {
        const r = await sms.send({ to: b.phone, type: 'reminder', bookingId: b.id,
          text: `یادآوری نوبت: ${biz.business_name}، ${b.first_name} عزیز، امروز ساعت ${toFaDigits(b.start_time)}. کد پیگیری ${toFaDigits(b.code)}` });
        if (r.sent) { db.prepare('UPDATE bookings SET reminder_sent_at=? WHERE id=?').run(now, b.id); reminded++; }
      }
    }
    // ۴) پاک‌سازی
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM otp_codes WHERE expires_at < ? AND (verified_until IS NULL OR verified_until < ?)').run(now, now);
    return { expired, reminded };
  }

  return {
    receiptToken, tokenOk, activeServices, resolveService, getService, listDays, listSlots, createHold, startPayment,
    handleCallback, reconcileBooking, verifyPayment, applyVerified, publicView, icsFor, bookingByCode, expireStale,
    cancel, setAttendance, settle, markRefunded, sweep, settings,
  };
}
