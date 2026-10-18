import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, firstFree, book, payAtGateway, status } from './helpers.js';

async function withAdmin(fn, env) {
  const ctx = await startApp(env);
  try {
    ctx.app.auth.createAdmin('owner', 'Str0ng-Pass-123');
    const login = await ctx.call('POST', '/admin/api/login', { username: 'owner', password: 'Str0ng-Pass-123' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    ctx.admin = { cookie, csrf: login.json.csrf, login };
    ctx.a = (m, p, body) => ctx.call(m, p, body, { cookie, 'x-csrf-token': ctx.admin.csrf });
    await fn(ctx);
  } finally { await ctx.close(); }
}
const confirmed = async (ctx, over = {}, skip = 0) => { const b = (await book(ctx, await firstFree(ctx, skip), over)).json; await payAtGateway(ctx, b); return b; };

test('پنل مدیریت: بدون ورود هیچ داده‌ای در دسترس نیست و همه مسیرها ۴۰۱ می‌دهند', async () => {
  const ctx = await startApp();
  try {
    for (const [m, p] of [['GET', '/admin/api/bookings'], ['GET', '/admin/api/settings'], ['GET', '/admin/api/export.csv'], ['GET', '/admin/api/report'], ['PUT', '/admin/api/hours'], ['POST', '/admin/api/bookings/1/cancel'], ['GET', '/admin/api/services']]) {
      const r = await ctx.call(m, p, m === 'GET' ? undefined : {}); assert.equal(r.status, 401, `${m} ${p}`);
      assert.ok(!r.text.includes('0912'));
    }
    assert.equal((await ctx.call('GET', '/admin/api/me')).json.authenticated, false);
    assert.equal((await ctx.call('GET', '/admin/api/bookings', undefined, { cookie: 'sid=forged' })).status, 401);
    const bad = await ctx.call('POST', '/admin/api/login', { username: 'x', password: 'y' });
    assert.equal(bad.status, 401); assert.equal(bad.json.error.message, 'نام کاربری یا رمز عبور درست نیست.');
  } finally { await ctx.close(); }
});

test('ورود: کوکی HttpOnly/SameSite، CSRF اجباری، قفل پس از ۵ تلاش ناموفق', async () => {
  await withAdmin(async (ctx) => {
    const sc = ctx.admin.login.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\/admin/);
    assert.equal((await ctx.call('POST', '/admin/api/settings', {}, { cookie: ctx.admin.cookie })).status, 404);
    const noCsrf = await ctx.call('PUT', '/admin/api/settings', { tagline: 'x' }, { cookie: ctx.admin.cookie });
    assert.equal(noCsrf.status, 403); assert.equal(noCsrf.json.error.code, 'bad_csrf');
    assert.equal((await ctx.call('PUT', '/admin/api/settings', { tagline: 'x' }, { cookie: ctx.admin.cookie, 'x-csrf-token': 'bad' })).status, 403);
    assert.equal((await ctx.a('PUT', '/admin/api/settings', { tagline: 'شعار تازه' })).status, 200);
    for (let i = 0; i < 5; i++) await ctx.call('POST', '/admin/api/login', { username: 'owner', password: 'wrong' + i });
    const locked = await ctx.call('POST', '/admin/api/login', { username: 'owner', password: 'Str0ng-Pass-123' });
    assert.equal(locked.status, 429);
    assert.equal((await ctx.a('GET', '/admin/api/me')).json.authenticated, true);
    await ctx.a('POST', '/admin/api/logout', {});
    assert.equal((await ctx.call('GET', '/admin/api/bookings', undefined, { cookie: ctx.admin.cookie })).status, 401);
  });
});

test('فهرست، جست‌وجو (نام/موبایل/کد)، جزئیات و خروجی CSV', async () => {
  await withAdmin(async (ctx) => {
    const b1 = await confirmed(ctx, { first_name: 'محمد', last_name: 'کریمی', phone: '09121111111' });
    const b2 = await confirmed(ctx, { first_name: 'رضا', last_name: 'احمدی', phone: '09352222222' }, 1);
    const all = (await ctx.a('GET', '/admin/api/bookings')).json;
    assert.equal(all.total, 2); assert.equal(all.bookings[0].status_fa, 'قطعی‌شده'); assert.equal(all.bookings[0].payment_fa, 'پرداخت‌شده');
    for (const [q, code] of [['کریمی', b1.code], ['09352222222', b2.code], [b1.code, b1.code], ['۰۹۳۵۲۲۲۲۲۲۲', b2.code], ['محمد کریمی', b1.code]]) {
      const r = (await ctx.a('GET', `/admin/api/bookings?q=${encodeURIComponent(q)}`)).json;
      assert.deepEqual(r.bookings.map((x) => x.code), [code], q);
    }
    assert.equal((await ctx.a('GET', `/admin/api/bookings?q=${encodeURIComponent("' OR 1=1 --")}`)).json.total, 0);
    assert.equal((await ctx.a('GET', '/admin/api/bookings?status=bad')).status, 400);
    const det = (await ctx.a('GET', `/admin/api/bookings/${all.bookings[0].id}`)).json;
    assert.equal(det.payments.length, 1); assert.equal(det.payments[0].status, 'verified');
    const csv = await ctx.a('GET', '/admin/api/export.csv');
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
    const raw = new Uint8Array(await (await fetch(ctx.base + '/admin/api/export.csv', { headers: { cookie: ctx.admin.cookie } })).arrayBuffer());
    assert.deepEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // BOM برای نمایش درست فارسی در Excel
    assert.ok(csv.text.startsWith('کد پیگیری')); assert.equal(csv.text.trim().split('\r\n').length, 3); assert.ok(csv.text.includes('کریمی'));
  });
});

test('لغو نوبت، ثبت مراجعه، تسویه باقی‌مانده، بازپرداخت و آزادشدن ساعت', async () => {
  await withAdmin(async (ctx) => {
    const slot = await firstFree(ctx);
    const b = (await book(ctx, slot)).json; await payAtGateway(ctx, b);
    const id = (await ctx.a('GET', '/admin/api/bookings')).json.bookings[0].id;
    assert.equal((await ctx.a('POST', `/admin/api/bookings/${id}/attendance`, { value: 'attended' })).status, 200);
    assert.equal((await ctx.a('POST', `/admin/api/bookings/${id}/attendance`, { value: 'weird' })).status, 400);
    assert.equal((await ctx.a('POST', `/admin/api/bookings/${id}/settle`, { settled: true })).status, 200);
    let rep = (await ctx.a('GET', '/admin/api/report?from=2026-10-01&to=2026-11-30')).json;
    assert.equal(rep.deposits_received, 500000); assert.equal(rep.remaining_settled, 500000); assert.equal(rep.total_income, 1000000); assert.equal(rep.counts.confirmed, 1); assert.equal(rep.includes_test_payments, true);
    await ctx.a('POST', `/admin/api/bookings/${id}/settle`, { settled: false });
    const c = await ctx.a('POST', `/admin/api/bookings/${id}/cancel`, { reason: 'درخواست مشتری', deposit: 'refund_due' });
    assert.equal(c.status, 200); assert.equal(c.json.booking.status, 'cancelled'); assert.equal(c.json.booking.deposit_outcome, 'refund_due');
    assert.equal((await ctx.a('POST', `/admin/api/bookings/${id}/cancel`, {})).status, 409);
    assert.equal((await ctx.call('GET', `/api/slots?date=${slot.date}`)).json.slots.find((s) => s.start_time === slot.start_time).state, 'free');
    assert.equal((await status(ctx, b)).outcome, 'cancelled');
    assert.equal((await ctx.a('POST', `/admin/api/bookings/${id}/refunded`, {})).status, 200);
    rep = (await ctx.a('GET', '/admin/api/report?from=2026-10-01&to=2026-11-30')).json;
    assert.equal(rep.deposits_refunded, 500000); assert.equal(rep.deposits_net, 0);
  });
});

test('تعطیلی روز، مسدودکردن ساعت و تغییر ساعات کاری بلافاصله روی رزرو مشتری اثر می‌گذارد', async () => {
  await withAdmin(async (ctx) => {
    const day = '2026-10-19'; // دوشنبه
    assert.ok((await ctx.call('GET', `/api/slots?date=${day}`)).json.slots.length > 0);
    assert.equal((await ctx.a('POST', '/admin/api/closed', { date: day, reason: 'مناسبت' })).status, 200);
    assert.equal((await ctx.call('GET', `/api/days`)).json.days.find((d) => d.date === day).state, 'closed');
    assert.equal((await book(ctx, { date: day, start_time: '12:00' })).status, 409);
    await ctx.a('DELETE', `/admin/api/closed/${day}`);
    assert.equal((await ctx.a('POST', '/admin/api/blocked', { date: day, start_time: '12:00', end_time: '13:00', reason: 'کار شخصی' })).status, 200);
    const s = (await ctx.call('GET', `/api/slots?date=${day}`)).json.slots;
    assert.equal(s.find((x) => x.start_time === '12:00').state, 'disabled'); assert.equal(s.find((x) => x.start_time === '13:00').state, 'free');
    assert.equal((await book(ctx, { date: day, start_time: '12:00' })).status, 409);
    const hours = (await ctx.a('GET', '/admin/api/hours')).json.hours.map((h) => (h.weekday === 2 ? { ...h, start_time: '14:00', end_time: '17:00' } : h));
    assert.equal((await ctx.a('PUT', '/admin/api/hours', { hours })).status, 200);
    assert.deepEqual((await ctx.call('GET', `/api/slots?date=${day}`)).json.slots.map((x) => x.start_time), ['14:00', '15:00', '16:00']);
    hours.find((h) => h.weekday === 2).end_time = '13:00';
    assert.equal((await ctx.a('PUT', '/admin/api/hours', { hours })).status, 400); // پایان قبل از شروع
    assert.equal((await ctx.a('POST', '/admin/api/blocked', { date: day, start_time: '15:00', end_time: '14:00' })).status, 400);
  });
});

test('خدمات و قیمت: اعتبارسنجی، اعمال فقط روی رزروهای جدید، حداقل یک خدمت فعال', async () => {
  await withAdmin(async (ctx) => {
    const old = (await book(ctx, await firstFree(ctx))).json;
    const sv = (await ctx.a('GET', '/admin/api/services')).json.services[0];
    const bad = await ctx.a('PUT', `/admin/api/services/${sv.id}`, { name: 'کوتاهی مو', duration_min: 60, price_toman: 1000000, deposit_toman: 2000000 });
    assert.equal(bad.status, 400); assert.ok(bad.json.error.fields.deposit_toman);
    assert.equal((await ctx.a('PUT', `/admin/api/services/${sv.id}`, { name: 'کوتاهی مو', duration_min: 60, price_toman: 1200000, deposit_toman: 600000 })).status, 200);
    assert.equal((await ctx.call('GET', '/api/config')).json.services[0].deposit_toman, 600000);
    assert.equal((await status(ctx, old)).deposit_toman, 500000);
    assert.equal((await ctx.a('PUT', `/admin/api/services/${sv.id}`, { name: 'کوتاهی مو', duration_min: 60, price_toman: 1200000, deposit_toman: 600000, active: false })).status, 400);
    const add = await ctx.a('POST', '/admin/api/services', { name: 'اصلاح ریش', duration_min: 30, price_toman: 400000, deposit_toman: 100000 });
    assert.equal(add.status, 200);
    assert.equal((await ctx.call('GET', '/api/config')).json.services.length, 2);
    const half = await ctx.call('GET', `/api/slots?date=2026-10-19&service_id=${add.json.id}`);
    assert.equal(half.json.slots[0].end_time, '10:30'); // ساعت‌ها بر اساس مدت خدمت
  });
});

test('تنظیمات: اعتبارسنجی لینک اینستاگرام (بدون لینک ساختگی) و تغییر رمز', async () => {
  await withAdmin(async (ctx) => {
    assert.equal((await ctx.call('GET', '/api/config')).json.business.instagram_url, ''); // تا وقتی ارائه نشده، چیزی نمایش داده نمی‌شود
    assert.equal((await ctx.a('PUT', '/admin/api/settings', { instagram_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await ctx.a('PUT', '/admin/api/settings', { instagram_url: 'https://evil.com/x' })).status, 400);
    assert.equal((await ctx.a('PUT', '/admin/api/settings', { instagram_url: 'https://instagram.com/my_barber', phone: '۰۲۱۱۲۳۴۵۶۷۸', hold_minutes: 20 })).status, 200);
    assert.equal((await ctx.a('PUT', '/admin/api/settings', { hold_minutes: 1 })).status, 400);
    const cfg = (await ctx.call('GET', '/api/config')).json;
    assert.equal(cfg.business.instagram_url, 'https://instagram.com/my_barber'); assert.equal(cfg.hold_minutes, 20);
    assert.equal((await ctx.a('POST', '/admin/api/password', { current_password: 'nope', new_password: 'AnotherStrong-9' })).status, 403);
    assert.equal((await ctx.a('POST', '/admin/api/password', { current_password: 'Str0ng-Pass-123', new_password: 'short' })).status, 400);
    assert.equal((await ctx.a('POST', '/admin/api/password', { current_password: 'Str0ng-Pass-123', new_password: 'AnotherStrong-9' })).status, 200);
    assert.equal((await ctx.call('GET', '/admin/api/bookings', undefined, { cookie: ctx.admin.cookie })).status, 401); // نشست‌های قبلی بسته شد
    assert.equal((await ctx.call('POST', '/admin/api/login', { username: 'owner', password: 'AnotherStrong-9' })).status, 200);
  });
});

test('رشته‌های حاوی HTML در نام ذخیره/نمایش داده نمی‌شوند و قوانین به‌صورت متن خام برمی‌گردند', async () => {
  await withAdmin(async (ctx) => {
    assert.equal((await book(ctx, await firstFree(ctx), { first_name: '<img src=x onerror=alert(1)>' })).status, 400);
    await ctx.a('PUT', '/admin/api/settings', { rules: '<b>قانون</b>\nدوم' });
    assert.equal((await ctx.call('GET', '/api/config')).json.rules, '<b>قانون</b>\nدوم'); // کلاینت با textContent نمایش می‌دهد
    const home = await ctx.call('GET', '/'); assert.ok(!home.text.includes('<b>قانون</b>'));
  });
});
