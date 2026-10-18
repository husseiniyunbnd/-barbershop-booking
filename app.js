import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, getSettings, tx } from './db.js';
import { createClock, isIsoDate } from './time.js';
import { createGateway } from './payment/index.js';
import { createSms } from './sms.js';
import { createBookingService } from './booking.js';
import { createAuth } from './auth.js';
import { createOtp } from './otp.js';
import { adminRoutes } from './admin.js';
import { AppError } from './errors.js';
import { ValidationError, validatePhone } from './validators.js';
import { send, sendJson, redirect, readBody, parseCookies, createLimiter, serveStatic, escapeHtml } from './http.js';

const COOKIE = 'sid';

export function createApp(config, { clock: clockOverride, fetchImpl, smsProvider, logger = console } = {}) {
  const db = openDb(config.databasePath);
  const clock = clockOverride || createClock(config.tzOffsetMinutes);
  const gateway = createGateway({ config, db, clock, fetchImpl });
  const sms = createSms({ config, db, clock, provider: smsProvider, fetchImpl });
  const svc = createBookingService({ db, clock, config, gateway, sms });
  const auth = createAuth({ db, clock });
  const otp = createOtp({ db, clock, sms });
  const hit = createLimiter(config.rateLimitEnabled, () => clock.nowMs());
  const baseHost = new URL(config.baseUrl).host;
  const indexHtml = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8');

  /* ---------- مسیرها ---------- */
  const routes = [];
  const add = (method, p, handler, extra = {}) => {
    const keys = [];
    const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...extra });
  };
  const serviceFrom = (q) => {
    const s = svc.resolveService(q.service_id);
    if (!s) throw new AppError(404, 'no_service', 'خدمتی برای رزرو فعال نیست.');
    return s;
  };

  add('GET', '/api/config', () => {
    const s = getSettings(db);
    const hours = db.prepare('SELECT * FROM working_hours ORDER BY weekday').all();
    const names = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
    return {
      business: { name: s.business_name, tagline: s.tagline, intro: s.intro, phone: s.phone, address: s.address, instagram_url: s.instagram_url, logo_url: s.logo_url },
      rules: s.rules,
      services: svc.activeServices().map((x) => ({ id: x.id, name: x.name, duration_min: x.duration_min, price_toman: x.price_toman, deposit_toman: x.deposit_toman, remaining_toman: x.price_toman - x.deposit_toman })),
      hours: hours.map((h) => ({ weekday: h.weekday, name: names[h.weekday], is_open: !!h.is_open, start_time: h.start_time, end_time: h.end_time })),
      hold_minutes: s.hold_minutes, window_days: s.booking_window_days,
      otp_required: sms.otpRequired, test_payment: gateway.isTest,
    };
  });
  add('GET', '/api/days', ({ query }) => ({ days: svc.listDays(serviceFrom(query)), today: clock.today() }));
  add('GET', '/api/slots', ({ query }) => svc.listSlots(query.date, serviceFrom(query)));

  add('POST', '/api/otp/send', async ({ body, ip, hit: h }) => {
    if (!sms.otpRequired) throw new AppError(404, 'otp_disabled', 'تأیید پیامکی فعال نیست.');
    const p = validatePhone(body?.phone);
    if (p.error) throw new ValidationError({ phone: p.error });
    h(`otp:ip:${ip}`, 10, 10 * 60_000); h(`otp:ph:${p.value}`, 5, 10 * 60_000);
    await otp.send(p.value);
    return { ok: true };
  });
  add('POST', '/api/otp/verify', ({ body, ip, hit: h }) => {
    if (!sms.otpRequired) throw new AppError(404, 'otp_disabled', 'تأیید پیامکی فعال نیست.');
    const p = validatePhone(body?.phone);
    if (p.error) throw new ValidationError({ phone: p.error });
    h(`otpv:ip:${ip}`, 30, 10 * 60_000);
    return { otp_token: otp.verify(p.value, String(body?.code ?? '').replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))) };
  });

  add('POST', '/api/bookings', ({ body, ip, hit: h }) => {
    h(`book:${ip}`, 15, 10 * 60_000);
    if (sms.otpRequired) {
      const p = validatePhone(body?.phone);
      if (p.error || !otp.check(p.value, body?.otp_token)) throw new AppError(403, 'otp_required', 'ابتدا شماره موبایل را با کد پیامکی تأیید کنید.', { fields: { otp: 'کد تأیید پیامکی لازم است.' } });
    }
    const b = svc.createHold(body);
    if (sms.otpRequired) otp.consume(b.phone);
    return { code: b.code, token: svc.receiptToken(b.code), hold_expires_at: b.hold_expires_at, booking: svc.publicView(b) };
  });
  const authBooking = (params, token) => {
    const b = svc.bookingByCode(params.code);
    if (!b || !svc.tokenOk(b.code, token)) throw new AppError(404, 'not_found', 'رزرو پیدا نشد.');
    return b;
  };
  add('POST', '/api/bookings/:code/pay', async ({ params, body, ip, hit: h }) => {
    h(`pay:${ip}`, 20, 10 * 60_000);
    authBooking(params, body?.token);
    return svc.startPayment(params.code);
  });
  add('GET', '/api/bookings/:code', ({ params, query }) => ({ booking: svc.publicView(authBooking(params, query.t)) }));
  add('GET', '/api/bookings/:code/ics', ({ params, query, res }) => {
    const b = authBooking(params, query.t);
    if (b.status !== 'confirmed') throw new AppError(409, 'not_confirmed', 'فقط نوبت قطعی‌شده قابل افزودن به تقویم است.');
    send(res, 200, svc.icsFor(b), { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="appointment-${b.code}.ics"`, 'cache-control': 'no-store' });
    return null;
  });

  add('GET', '/payment/callback', async ({ query, res }) => {
    let code = null;
    try { code = await svc.handleCallback(query.Authority || query.authority, query.Status || query.status); } catch (e) {
      if (!(e instanceof AppError)) logger.error('callback error:', e.message);
      const p = db.prepare('SELECT b.code FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.authority=?').get(String(query.Authority || ''));
      code = p?.code ?? null;
    }
    redirect(res, code ? `/#/result/${code}/${svc.receiptToken(code)}` : '/');
    return null;
  });

  /* درگاه آزمایشی */
  const mockPage = (a, row, biz) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>درگاه آزمایشی</title><link rel="stylesheet" href="/css/app.css"></head><body class="mock-body"><main class="mock-card">
<p class="mock-warn">درگاه آزمایشی — این یک پرداخت واقعی نیست و هیچ مبلغی کسر نمی‌شود.</p>
<h1>پرداخت بیعانه</h1><p>${escapeHtml(biz)}</p><p class="mock-amount">${(row.amount_gateway / 10).toLocaleString('fa-IR')} تومان</p>
<form method="post" action="/mock-gateway/${escapeHtml(a)}/pay"><button class="btn btn-gold" type="submit">پرداخت موفق (آزمایشی)</button></form>
<form method="post" action="/mock-gateway/${escapeHtml(a)}/cancel"><button class="btn btn-ghost" type="submit">انصراف</button></form></main></body></html>`;
  add('GET', '/mock-gateway/:a', ({ params, res }) => {
    if (!gateway.isTest) throw new AppError(404, 'not_found', 'پیدا نشد.');
    const row = db.prepare("SELECT * FROM mock_gateway WHERE authority=? AND state='open'").get(params.a);
    if (!row) throw new AppError(404, 'not_found', 'تراکنش آزمایشی پیدا نشد یا قبلاً استفاده شده است.');
    send(res, 200, mockPage(params.a, row, getSettings(db).business_name), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return null;
  });
  for (const act of ['pay', 'cancel']) {
    add('POST', `/mock-gateway/:a/${act}`, async ({ params, res }) => {
      if (!gateway.isTest) throw new AppError(404, 'not_found', 'پیدا نشد.');
      const ch = db.prepare("UPDATE mock_gateway SET state=? WHERE authority=? AND state='open'").run(act === 'pay' ? 'paid' : 'cancelled', params.a).changes;
      if (!ch) throw new AppError(404, 'not_found', 'تراکنش آزمایشی پیدا نشد یا قبلاً استفاده شده است.');
      redirect(res, `/payment/callback?Authority=${encodeURIComponent(params.a)}&Status=${act === 'pay' ? 'OK' : 'NOK'}`, 303);
      return null;
    }, { form: true });
  }

  /* پنل مدیریت */
  for (const r of adminRoutes({ db, clock, svc, auth, gateway, sms, config })) {
    add(r.method, r.path, r.handler, { admin: r.admin });
  }
  add('GET', '/healthz', () => ({ ok: true }));

  /* ---------- سرور ---------- */
  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff.at(-1);
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { const h = new URL(o).host; return h === baseHost || h === req.headers.host; } catch { return false; }
  }

  function renderIndex() {
    const s = getSettings(db);
    const ld = { '@context': 'https://schema.org', '@type': 'HairSalon', name: s.business_name, description: s.tagline };
    if (s.phone) ld.telephone = s.phone;
    if (s.address) ld.address = s.address;
    if (s.instagram_url) ld.sameAs = [s.instagram_url];
    const title = `${s.business_name} | نوبت‌دهی آنلاین`;
    return indexHtml
      .replaceAll('{{TITLE}}', escapeHtml(title))
      .replaceAll('{{DESCRIPTION}}', escapeHtml(`${s.tagline}. ${s.intro}`))
      .replaceAll('{{CANONICAL}}', escapeHtml(config.baseUrl + '/'))
      .replaceAll('{{JSONLD}}', JSON.stringify(ld).replace(/</g, '\\u003c'));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/api/') || url.pathname.startsWith('/payment/') || url.pathname.startsWith('/mock-gateway/')) {
        hit(`all:${ip}`, 600, 60_000);
      }
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !originOk(req)) throw new AppError(403, 'bad_origin', 'درخواست از مبدأ نامعتبر ارسال شد.');

      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const cookies = parseCookies(req);
        const token = cookies[COOKIE];
        const session = r.admin !== undefined ? auth.getSession(token) : null;
        if (r.admin === true) {
          if (!session) throw new AppError(401, 'unauthorized', 'برای ادامه وارد پنل مدیریت شوید.');
          if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'bad_csrf', 'نشست نامعتبر است؛ صفحه را دوباره بارگذاری کنید.');
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req, 64 * 1024, { form: !!r.form }) : {};
        const cookieBase = `${COOKIE}=`;
        const flags = `; HttpOnly; SameSite=Strict; Path=/admin${config.secureCookies ? '; Secure' : ''}`;
        const extraHeaders = {};
        const ctx = {
          req, res, url, params, query: Object.fromEntries(url.searchParams), body, ip, hit, token, session,
          setCookie: (v, maxAge) => { extraHeaders['set-cookie'] = `${cookieBase}${v}${flags}; Max-Age=${maxAge}`; },
          clearCookie: () => { extraHeaders['set-cookie'] = `${cookieBase}${flags}; Max-Age=0`; },
        };
        const out = await r.handler(ctx);
        if (out === null || res.headersSent) return;
        if (out && out.__csv !== undefined) {
          return send(res, 200, out.__csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="bookings.csv"', 'cache-control': 'no-store', ...extraHeaders });
        }
        return sendJson(res, 200, out, extraHeaders);
      }

      if (method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, renderIndex(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        if (url.pathname === '/admin' || url.pathname === '/admin/') {
          return send(res, 200, fs.readFileSync(path.join(config.publicDir, 'admin.html')), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        }
        if (url.pathname === '/robots.txt') return send(res, 200, `User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /payment/\nSitemap: ${config.baseUrl}/sitemap.xml\n`, { 'content-type': 'text/plain; charset=utf-8' });
        if (url.pathname === '/sitemap.xml') return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHtml(config.baseUrl)}/</loc></url></urlset>`, { 'content-type': 'application/xml; charset=utf-8' });
        if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/admin/api/') && url.pathname !== '/admin.html' && serveStatic(res, config.publicDir, url.pathname)) return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/api/')) throw new AppError(404, 'not_found', 'مسیر پیدا نشد.');
      send(res, 404, fs.readFileSync(path.join(config.publicDir, '404.html')), { 'content-type': 'text/html; charset=utf-8' });
    } catch (e) {
      const isApp = e instanceof AppError || e instanceof ValidationError;
      if (!isApp) logger.error('unhandled:', e);
      if (res.headersSent) return res.end();
      const status = isApp ? e.status : 500;
      const wantsHtml = !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/admin/api/');
      if (wantsHtml && method !== 'GET' || (wantsHtml && url.pathname.startsWith('/mock-gateway'))) {
        return send(res, status, `<!doctype html><meta charset="utf-8"><title>خطا</title><body dir="rtl" style="font-family:sans-serif;padding:2rem">${escapeHtml(isApp ? e.message : 'خطای داخلی سرور')}<p><a href="/">بازگشت</a></p>`, { 'content-type': 'text/html; charset=utf-8' });
      }
      const headers = e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {};
      sendJson(res, status, { error: { code: isApp ? e.code : 'internal_error', message: isApp ? e.message : 'خطای داخلی سرور. لطفاً دوباره تلاش کنید.', fields: e.fields } }, headers);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  let timer = null;
  return {
    server, db, clock, svc, auth, gateway, sms, config,
    listen: (port = config.port, host = config.host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    startSweeper() {
      timer = setInterval(() => svc.sweep().catch((e) => logger.error('sweep error:', e.message)), config.sweepIntervalMs);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      db.close();
    },
  };
}
