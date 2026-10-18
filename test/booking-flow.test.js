import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, firstFree, book, person, payAtGateway, status, startFakeZarinpal, T0 } from './helpers.js';

const withApp = (name, fn, env, opts) => test(name, async () => { const ctx = await startApp(env, opts); try { await fn(ctx); } finally { await ctx.close(); } });
const rows = (ctx, sql, ...a) => ctx.app.db.prepare(sql).all(...a);

withApp('روزها: جمعه تعطیل، گذشته غیرفعال، تاریخ شمسی درست', async (ctx) => {
  const { json } = await ctx.call('GET', '/api/days');
  assert.equal(json.today, '2026-10-18');
  const fri = json.days.find((d) => d.weekday === 'جمعه' && d.date >= json.today);
  assert.equal(fri.state, 'closed');
  assert.equal(json.days.find((d) => d.date === '2026-10-17').state, 'past');
  const today = json.days.find((d) => d.date === '2026-10-18');
  assert.equal(today.jalali, '1405/07/26'); assert.equal(today.weekday, 'یکشنبه'); assert.equal(today.state, 'open');
  assert.equal(json.days.length % 7, 0);
  assert.equal(json.days[0].weekday, 'شنبه');
});

withApp('ساعت‌ها: بازه‌های یک‌ساعته، گذشته غیرفعال (با حداقل فاصله ۶۰ دقیقه)', async (ctx) => {
  const { json } = await ctx.call('GET', '/api/slots?date=2026-10-18');
  assert.equal(json.slots[0].start_time, '10:00'); assert.equal(json.slots[0].end_time, '11:00');
  assert.equal(json.slots.length, 8);
  assert.equal(json.slots[0].state, 'disabled'); // ۱۰:۰۰ کمتر از ۶۰ دقیقه بعد از ۰۹:۳۰
  assert.equal(json.slots[1].state, 'free');
  const past = await ctx.call('GET', '/api/slots?date=2026-10-17');
  assert.deepEqual(past.json.slots, []);
  assert.equal((await ctx.call('GET', '/api/slots?date=bad')).status, 400);
});

withApp('مسیر کامل: انتخاب → رزرو موقت → پرداخت → قطعی‌شدن → رسید و تقویم', async (ctx) => {
  const slot = await firstFree(ctx);
  const r = await book(ctx, slot);
  assert.equal(r.status, 200, r.text);
  const b = r.json;
  assert.match(b.code, /^\d{8}$/);
  assert.equal(b.booking.status, 'pending_payment'); assert.equal(b.booking.outcome, 'pending');
  // ساعت برای دیگران بسته می‌شود
  assert.equal((await ctx.call('GET', `/api/slots?date=${slot.date}`)).json.slots.find((s) => s.start_time === slot.start_time).state, 'booked');
  const p = await payAtGateway(ctx, b);
  assert.equal(p.callback.status, 302);
  assert.equal(p.callback.headers.get('location'), `/#/result/${b.code}/${b.token}`);
  const v = await status(ctx, b);
  assert.equal(v.status, 'confirmed'); assert.equal(v.payment_status, 'paid'); assert.equal(v.outcome, 'confirmed');
  assert.equal(v.deposit_toman, 500000); assert.equal(v.remaining_toman, 500000); assert.equal(v.price_toman, 1000000);
  assert.ok(v.ref_id); assert.equal(v.is_test_payment, true);
  assert.equal(v.phone_masked, '0912***6789');
  const pay = rows(ctx, 'SELECT * FROM payments')[0];
  assert.equal(pay.amount_toman, 500000); assert.equal(pay.amount_gateway, 5000000); assert.equal(pay.status, 'verified');
  const ics = await ctx.call('GET', `/api/bookings/${b.code}/ics?t=${b.token}`);
  assert.equal(ics.status, 200); assert.match(ics.text, /BEGIN:VEVENT/); assert.match(ics.text, /DTSTART:\d{8}T\d{6}Z/);
  // رسید بدون توکن درست قابل مشاهده نیست
  assert.equal((await ctx.call('GET', `/api/bookings/${b.code}?t=wrong`)).status, 404);
  assert.equal((await ctx.call('GET', `/api/bookings/${b.code}`)).status, 404);
});

withApp('رزرو هم‌زمان: از ۲۰ درخواست هم‌زمان فقط یکی موفق می‌شود', async (ctx) => {
  const slot = await firstFree(ctx);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => book(ctx, slot, { phone: `0912000${String(i).padStart(4, '0')}`, first_name: 'مشتری', last_name: 'تست' })));
  const ok = results.filter((r) => r.status === 200), taken = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1); assert.equal(taken.length, 19);
  assert.ok(taken.every((r) => ['slot_taken', 'slot_unavailable'].includes(r.json.error.code)));
  assert.equal(rows(ctx, "SELECT * FROM bookings WHERE status IN ('pending_payment','confirmed')").length, 1);
});

withApp('تلاش مجدد همان مشتری برای همان ساعت رزرو تکراری نمی‌سازد', async (ctx) => {
  const slot = await firstFree(ctx);
  const a = await book(ctx, slot), b = await book(ctx, slot);
  assert.equal(a.json.code, b.json.code);
  assert.equal(rows(ctx, 'SELECT * FROM bookings').length, 1);
  assert.equal((await book(ctx, slot, { phone: '09350000000' })).status, 409);
});

withApp('پرداخت لغو/ناموفق: رزرو قطعی نمی‌شود، تلاش مجدد رزرو تکراری نمی‌سازد، سپس موفق می‌شود', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot)).json;
  await payAtGateway(ctx, b, 'cancel');
  let v = await status(ctx, b);
  assert.equal(v.status, 'pending_payment'); assert.equal(v.outcome, 'payment_failed'); assert.equal(v.payment_status, 'failed');
  await payAtGateway(ctx, b, 'pay'); // تلاش مجدد روی همان رزرو
  v = await status(ctx, b);
  assert.equal(v.status, 'confirmed'); assert.equal(v.payment_status, 'paid');
  assert.equal(rows(ctx, 'SELECT * FROM bookings').length, 1);
  assert.deepEqual(rows(ctx, 'SELECT status FROM payments ORDER BY id').map((x) => x.status), ['cancelled', 'verified']);
});

withApp('امنیت پرداخت: Status=OK جعلی در URL بدون پرداخت واقعی، رزرو را قطعی نمی‌کند', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot)).json;
  const p = await payAtGateway(ctx, b, 'none'); // انتقال به درگاه، بدون پرداخت
  const cb = await ctx.call('GET', `/payment/callback?Authority=${p.authority}&Status=OK`);
  assert.equal(cb.status, 302);
  const v = await status(ctx, b);
  assert.equal(v.status, 'pending_payment'); assert.equal(v.payment_status, 'failed'); assert.notEqual(v.outcome, 'confirmed');
  assert.equal(rows(ctx, "SELECT * FROM payments WHERE status='verified'").length, 0);
  // authority ناشناس هم ایمن مدیریت می‌شود
  const bad = await ctx.call('GET', '/payment/callback?Authority=NOPE&Status=OK');
  assert.equal(bad.status, 302); assert.equal(bad.headers.get('location'), '/');
});

withApp('مبلغ فقط از سرور تعیین می‌شود (فیلد amount مرورگر نادیده گرفته می‌شود)', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot, { amount: 1, deposit_toman: 1, price_toman: 1 })).json;
  await ctx.call('POST', `/api/bookings/${b.code}/pay`, { token: b.token, amount: 1000 });
  const pay = rows(ctx, 'SELECT * FROM payments')[0];
  assert.equal(pay.amount_toman, 500000); assert.equal(pay.amount_gateway, 5000000);
  assert.equal(rows(ctx, 'SELECT deposit_toman FROM bookings')[0].deposit_toman, 500000);
});

withApp('کال‌بک تکراری idempotent است (یک تراکنش، یک تأیید)', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot)).json;
  const p = await payAtGateway(ctx, b);
  await ctx.call('GET', `/payment/callback?Authority=${p.authority}&Status=OK`);
  await ctx.call('GET', `/payment/callback?Authority=${p.authority}&Status=OK`);
  assert.equal(rows(ctx, "SELECT * FROM payments WHERE status='verified'").length, 1);
  assert.equal(rows(ctx, "SELECT * FROM bookings WHERE status='confirmed'").length, 1);
});

withApp('انقضای رزرو موقت: بعد از مهلت ساعت دوباره آزاد می‌شود و پرداخت منقضی رد می‌شود', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot)).json;
  ctx.advance(14);
  assert.equal((await ctx.call('GET', `/api/slots?date=${slot.date}`)).json.slots.find((s) => s.start_time === slot.start_time).state, 'booked');
  ctx.advance(2); // ۱۶ دقیقه > ۱۵
  assert.equal((await ctx.call('GET', `/api/slots?date=${slot.date}`)).json.slots.find((s) => s.start_time === slot.start_time).state, 'free');
  const r = await ctx.call('POST', `/api/bookings/${b.code}/pay`, { token: b.token });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'hold_expired');
  const sw = await ctx.app.svc.sweep();
  assert.equal(sw.expired, 1);
  assert.equal((await status(ctx, b)).outcome, 'expired');
  assert.equal((await book(ctx, slot, { phone: '09350000000' })).status, 200); // نفر بعدی می‌تواند بگیرد
});

withApp('پرداخت موفق با تأخیر در کال‌بک: sweep تراکنش را از درگاه استعلام و رزرو را قطعی می‌کند', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot)).json;
  const p = await payAtGateway(ctx, b, 'none');
  ctx.app.db.prepare("UPDATE mock_gateway SET state='paid' WHERE authority=?").run(p.authority); // کاربر پرداخت کرد ولی کال‌بک نرسید
  ctx.advance(20);
  await ctx.app.svc.sweep();
  const v = await status(ctx, b);
  assert.equal(v.status, 'confirmed'); assert.equal(v.payment_status, 'paid');
});

withApp('پرداخت دیرهنگام وقتی ساعت به دیگری رسیده: بیعانه «نیازمند بازپرداخت» علامت می‌خورد', async (ctx) => {
  const slot = await firstFree(ctx);
  const b = (await book(ctx, slot)).json;
  const p = await payAtGateway(ctx, b, 'none');
  ctx.advance(30);
  ctx.app.db.prepare("UPDATE bookings SET hold_expires_at=? WHERE code=?").run(ctx.state.now - 1000, b.code); // شبیه‌سازی گذشتن مهلت بدون فعال‌شدن sweep
  assert.equal((await book(ctx, slot, { phone: '09350000000' })).status, 200); // نفر دوم ساعت را می‌گیرد
  ctx.app.db.prepare("UPDATE mock_gateway SET state='paid' WHERE authority=?").run(p.authority);
  await ctx.call('GET', `/payment/callback?Authority=${p.authority}&Status=OK`);
  const v = await status(ctx, b);
  assert.equal(v.outcome, 'paid_not_assigned'); assert.notEqual(v.status, 'confirmed');
  const row = rows(ctx, 'SELECT * FROM bookings WHERE code=?', b.code)[0];
  assert.equal(row.needs_refund, 1); assert.equal(row.deposit_outcome, 'refund_due');
  assert.equal(rows(ctx, "SELECT * FROM bookings WHERE status='confirmed'").length, 0);
});

withApp('اعتبارسنجی فرم در سرور، پیام‌های فارسی', async (ctx) => {
  const slot = await firstFree(ctx);
  const r = await book(ctx, slot, { first_name: '', last_name: 'ا', phone: '123' });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'validation_error');
  assert.ok(r.json.error.fields.first_name.includes('وارد کنید')); assert.ok(r.json.error.fields.phone.includes('معتبر'));
  assert.equal((await book(ctx, slot, { accept_rules: false })).json.error.code, 'rules_not_accepted');
  assert.equal((await book(ctx, { date: slot.date, start_time: '10:30' })).status, 409); // ساعت خارج از بازه‌ها
  assert.equal((await book(ctx, { date: '2026-10-23', start_time: '10:00' })).status, 409); // جمعه تعطیل
  assert.equal((await book(ctx, { date: '2026-10-17', start_time: '12:00' })).status, 409); // گذشته
  assert.equal((await book(ctx, { date: '2027-12-01', start_time: '12:00' })).status, 409); // خارج از بازه
  assert.equal((await book(ctx, { date: 'abc', start_time: 'x' })).status, 400);
  assert.equal(rows(ctx, 'SELECT * FROM bookings').length, 0);
});

withApp('قیمت رزروهای قبلی با تغییر قیمت خدمت عوض نمی‌شود', async (ctx) => {
  const slot = await firstFree(ctx), slot2 = await firstFree(ctx, 1);
  const b1 = (await book(ctx, slot)).json;
  ctx.app.db.prepare('UPDATE services SET price_toman=1200000, deposit_toman=600000').run();
  const b2 = (await book(ctx, slot2, { phone: '09350000000' })).json;
  assert.equal(rows(ctx, 'SELECT deposit_toman FROM bookings WHERE code=?', b1.code)[0].deposit_toman, 500000);
  assert.equal(rows(ctx, 'SELECT deposit_toman FROM bookings WHERE code=?', b2.code)[0].deposit_toman, 600000);
  await payAtGateway(ctx, b2);
  assert.equal(rows(ctx, 'SELECT amount_toman FROM payments')[0].amount_toman, 600000);
});

withApp('محدودیت رزرو پرداخت‌نشده و نرخ درخواست', async (ctx) => {
  const ph = '09360000000';
  assert.equal((await book(ctx, await firstFree(ctx, 0), { phone: ph })).status, 200);
  assert.equal((await book(ctx, await firstFree(ctx, 1), { phone: ph })).status, 200);
  const third = await book(ctx, await firstFree(ctx, 2), { phone: ph });
  assert.equal(third.status, 429); assert.equal(third.json.error.code, 'too_many_pending');
}, { });

withApp('محدودسازی نرخ (rate limit) فعال است', async (ctx) => {
  const slot = await firstFree(ctx);
  let last;
  for (let i = 0; i < 17; i++) last = await book(ctx, slot, { phone: `0937000${String(i).padStart(4, '0')}` });
  assert.equal(last.status, 429); assert.equal(last.json.error.code, 'rate_limited');
}, { RATE_LIMIT_ENABLED: 'true' });

withApp('امنیت HTTP: مسیرهای مخرب، هدرها، Origin و نوع محتوا', async (ctx) => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fserver/db.js', '/server/db.js', '/.env', '/data/app.db', '/admin.html']) {
    const r = await ctx.call('GET', p); assert.ok([404].includes(r.status), `${p} → ${r.status}`);
  }
  const home = await ctx.call('GET', '/');
  assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.text, /<title>آرایشگاه مردانه \| نوبت‌دهی آنلاین<\/title>/); assert.match(home.text, /application\/ld\+json/);
  assert.equal((await ctx.call('POST', '/api/bookings', undefined, { origin: 'https://evil.example' })).status, 403);
  const form = await fetch(ctx.base + '/api/bookings', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  const big = await fetch(ctx.base + '/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70000) }) });
  assert.equal(big.status, 413);
  assert.equal((await ctx.call('GET', '/api/nope')).status, 404);
  assert.equal((await ctx.call('POST', '/mock-gateway/XYZ/pay', undefined, { 'content-type': 'application/x-www-form-urlencoded' })).status, 404);
});

withApp('SQL Injection: ورودی‌های مخرب باعث خطا یا نفوذ نمی‌شوند', async (ctx) => {
  const slot = await firstFree(ctx);
  const evil = "x'); DROP TABLE bookings;--";
  assert.equal((await book(ctx, slot, { first_name: evil })).status, 400);
  assert.equal((await ctx.call('GET', `/api/bookings/${encodeURIComponent("1' OR '1'='1")}?t=x`)).status, 404);
  assert.equal((await ctx.call('GET', `/api/slots?date=${encodeURIComponent("2026-10-18' OR 1=1")}`)).status, 400);
  assert.ok(rows(ctx, 'SELECT * FROM bookings'));
});

/* ---------- زرین‌پال (روی سرور شبیه‌ساز محلی؛ نه درگاه واقعی) ---------- */
test('آداپتور زرین‌پال: ریال، تأیید، کد ۱۰۱، شکست و خطای شبکه', async () => {
  const fake = await startFakeZarinpal();
  const ctx = await startApp({ PAYMENT_GATEWAY: 'zarinpal', ZARINPAL_MERCHANT_ID: '12345678-1234-1234-1234-123456789012', ZARINPAL_API_BASE: fake.url });
  try {
    const b = (await book(ctx, await firstFree(ctx))).json;
    const r = await ctx.call('POST', `/api/bookings/${b.code}/pay`, { token: b.token });
    assert.equal(r.status, 200); assert.match(r.json.redirect_url, /\/pg\/StartPay\/A0+\d+$/);
    const reqCall = fake.calls.find((c) => c.url.includes('request'));
    assert.equal(reqCall.body.amount, 5000000); // ۵۰۰٬۰۰۰ تومان = ۵٬۰۰۰٬۰۰۰ ریال
    assert.equal(reqCall.body.merchant_id, '12345678-1234-1234-1234-123456789012');
    assert.equal(reqCall.body.callback_url, `${ctx.app.config.baseUrl}/payment/callback`);
    const authority = r.json.redirect_url.split('/').pop();
    // پرداخت نشده → verify منفی → ناموفق
    await ctx.call('GET', `/payment/callback?Authority=${authority}&Status=OK`);
    assert.equal((await status(ctx, b)).status, 'pending_payment');
    // خطای شبکه هنگام verify → نتیجه نامشخص (ناموفق ثبت نمی‌شود)
    fake.paid.add(authority);
    const old = fake.server.listeners('request')[0]; // جایگزینی موقت با قطع اتصال
    fake.server.removeAllListeners('request');
    fake.server.on('request', (req, res) => res.destroy());
    await ctx.call('GET', `/payment/callback?Authority=${authority}&Status=OK`);
    assert.equal(rows(ctx, 'SELECT status FROM payments')[0].status, 'failed'); // قبلاً failed شده بود و تغییر نکرد
    fake.server.removeAllListeners('request'); fake.server.on('request', old);
    // اکنون درگاه پرداخت را تأیید می‌کند → رزرو قطعی (حتی بعد از failed قبلی)
    await ctx.call('GET', `/payment/callback?Authority=${authority}&Status=OK`);
    const v = await status(ctx, b);
    assert.equal(v.status, 'confirmed'); assert.equal(v.is_test_payment, false); assert.match(v.ref_id, /^777\d+$/);
  } finally { await ctx.close(); await fake.close(); }
});

test('زرین‌پال: کد ۱۰۱ (قبلاً تأییدشده) موفق است و درگاه غیرقابل‌دسترس خطای واضح می‌دهد', async () => {
  const fake = await startFakeZarinpal();
  const ctx = await startApp({ PAYMENT_GATEWAY: 'zarinpal', ZARINPAL_MERCHANT_ID: '12345678-1234-1234-1234-123456789012', ZARINPAL_API_BASE: fake.url });
  try {
    const b = (await book(ctx, await firstFree(ctx))).json;
    const r = await ctx.call('POST', `/api/bookings/${b.code}/pay`, { token: b.token });
    const authority = r.json.redirect_url.split('/').pop();
    fake.paid.add(authority); fake.paid.add('dup:' + authority);
    await ctx.call('GET', `/payment/callback?Authority=${authority}&Status=OK`);
    assert.equal((await status(ctx, b)).status, 'confirmed');
    await fake.close();
    const b2 = (await book(ctx, await firstFree(ctx), { phone: '09350000000' })).json;
    const down = await ctx.call('POST', `/api/bookings/${b2.code}/pay`, { token: b2.token });
    assert.equal(down.status, 502); assert.ok(down.json.error.message.includes('درگاه'));
    assert.equal(rows(ctx, 'SELECT * FROM payments WHERE booking_id=(SELECT id FROM bookings WHERE code=?)', b2.code).length, 0);
  } finally { await ctx.close(); }
});

test('تنظیمات: بدون merchant_id واقعی یا در production با mock، سرور راه‌اندازی نمی‌شود', async () => {
  const { loadConfig, validateConfig } = await import('../server/config.js');
  assert.ok(validateConfig(loadConfig({ PAYMENT_GATEWAY: 'zarinpal' }, { readDotEnv: false })).some((e) => e.includes('ZARINPAL_MERCHANT_ID')));
  assert.ok(validateConfig(loadConfig({ NODE_ENV: 'production', BASE_URL: 'https://x.ir', PAYMENT_GATEWAY: 'mock' }, { readDotEnv: false })).some((e) => e.includes('mock')));
  assert.ok(validateConfig(loadConfig({ NODE_ENV: 'production', BASE_URL: 'http://x.ir', PAYMENT_GATEWAY: 'zarinpal', ZARINPAL_MERCHANT_ID: '12345678-1234-1234-1234-123456789012' }, { readDotEnv: false })).some((e) => e.includes('https')));
  assert.deepEqual(validateConfig(loadConfig({ NODE_ENV: 'production', BASE_URL: 'https://x.ir', PAYMENT_GATEWAY: 'zarinpal', ZARINPAL_MERCHANT_ID: '12345678-1234-1234-1234-123456789012' }, { readDotEnv: false })), []);
});

/* ---------- پیامک (با ارائه‌دهنده‌ی آزمایشی تست؛ ارسال واقعی نیست) ---------- */
test('پیامک: پیش‌فرض غیرفعال و بدون ارسال؛ در حالت فعال تأیید رزرو، OTP و یادآوری', async () => {
  const off = await startApp();
  try {
    const b = (await book(off, await firstFree(off))).json; await payAtGateway(off, b);
    assert.equal(off.app.db.prepare('SELECT COUNT(*) c FROM notifications').get().c, 0);
    assert.equal((await off.call('POST', '/api/otp/send', { phone: '09123456789' })).status, 404);
  } finally { await off.close(); }
  const sent = [];
  const ctx = await startApp({ SMS_ENABLED: 'true', SMS_API_KEY: 'k', SMS_SENDER: '1000', OTP_REQUIRED: 'true' }, { smsProvider: { async send(m) { sent.push(m); } } });
  try {
    const slot = await firstFree(ctx);
    assert.equal((await book(ctx, slot)).json.error.code, 'otp_required');
    assert.equal((await ctx.call('POST', '/api/otp/verify', { phone: '09123456789', code: '11111' })).status, 400);
    await ctx.call('POST', '/api/otp/send', { phone: '۰۹۱۲۳۴۵۶۷۸۹' });
    const code = sent.at(-1).text.match(/\d{5}/)[0];
    assert.equal((await ctx.call('POST', '/api/otp/verify', { phone: '09123456789', code: code === '10000' ? '10001' : '10000' })).status, 400);
    const tok = (await ctx.call('POST', '/api/otp/verify', { phone: '09123456789', code })).json.otp_token;
    const b = (await book(ctx, slot, { otp_token: tok })).json;
    assert.ok(b.code);
    assert.equal((await book(ctx, await firstFree(ctx, 1), { otp_token: tok })).json.error.code, 'otp_required'); // توکن یک‌بارمصرف
    await payAtGateway(ctx, b);
    assert.ok(sent.some((m) => m.text.includes('قطعی شد') && m.to === '09123456789'));
    // یادآوری: ۱ ساعت و نیم قبل از نوبت
    const row = rows(ctx, 'SELECT * FROM bookings')[0];
    ctx.state.now = row.start_ts - 2 * 3600_000; await ctx.app.svc.sweep();
    assert.ok(sent.some((m) => m.text.includes('یادآوری')));
    const n = sent.length; await ctx.app.svc.sweep(); assert.equal(sent.length, n); // فقط یک بار
  } finally { await ctx.close(); }
});
