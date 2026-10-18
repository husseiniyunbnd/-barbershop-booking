import http from 'node:http';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { createClock } from '../server/time.js';

export const T0 = Date.UTC(2026, 9, 18, 6, 0); // یکشنبه ۱۸ اکتبر ۲۰۲۶، ساعت ۰۹:۳۰ تهران (۲۶ مهر ۱۴۰۵)
export const silent = { error() {}, log() {} };

export async function startApp(env = {}, opts = {}) {
  const state = { now: T0 };
  const clock = createClock(210, () => state.now);
  const config = loadConfig({ DATABASE_PATH: ':memory:', RATE_LIMIT_ENABLED: 'false', PAYMENT_GATEWAY: 'mock', ...env }, { readDotEnv: false });
  const app = createApp(config, { clock, logger: silent, ...opts });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const advance = (min) => { state.now += min * 60_000; };
  return { app, base, call, state, advance, close: () => app.close() };
}

/** اولین ساعت آزاد (روز و ساعت) را از API پیدا می‌کند */
export async function firstFree(ctx, skip = 0) {
  const { json } = await ctx.call('GET', '/api/days');
  let n = 0;
  for (const d of json.days.filter((x) => x.state === 'open')) {
    const s = await ctx.call('GET', `/api/slots?date=${d.date}`);
    for (const slot of s.json.slots.filter((x) => x.state === 'free')) { if (n++ === skip) return { date: d.date, start_time: slot.start_time }; }
  }
  throw new Error('no free slot');
}

export const person = (over = {}) => ({ first_name: 'علی', last_name: 'رضایی', phone: '۰۹۱۲۳۴۵۶۷۸۹', accept_rules: true, ...over });
export const book = (ctx, slot, over = {}) => ctx.call('POST', '/api/bookings', { ...person(), ...slot, ...over });

/** مراحل «پرداخت در درگاه آزمایشی» را مثل مرورگر انجام می‌دهد؛ action: pay | cancel | none */
export async function payAtGateway(ctx, booking, action = 'pay') {
  const r = await ctx.call('POST', `/api/bookings/${booking.code}/pay`, { token: booking.token });
  if (r.status !== 200) return { start: r };
  const authority = r.json.redirect_url.split('/').pop();
  if (action === 'none') return { start: r, authority };
  const g = await ctx.call('POST', `/mock-gateway/${authority}/${action}`, undefined, { 'content-type': 'application/x-www-form-urlencoded' });
  const cb = await ctx.call('GET', g.headers.get('location'));
  return { start: r, authority, gateway: g, callback: cb };
}
export const status = async (ctx, b) => (await ctx.call('GET', `/api/bookings/${b.code}?t=${b.token}`)).json.booking;

export function startFakeZarinpal({ paid = new Set(), failVerifyNetwork = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const j = JSON.parse(body || '{}'); calls.push({ url: req.url, body: j });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/pg/v4/payment/request.json') {
      if (!j.merchant_id || !(j.amount > 0)) return res.end(JSON.stringify({ data: [], errors: { code: -9, message: 'bad' } }));
      return res.end(JSON.stringify({ data: { code: 100, message: 'Success', authority: 'A' + String(calls.length).padStart(35, '0'), fee_type: 'Merchant', fee: 0 }, errors: [] }));
    }
    if (req.url === '/pg/v4/payment/verify.json') {
      if (failVerifyNetwork) return res.destroy();
      if (!paid.has(j.authority)) return res.end(JSON.stringify({ data: [], errors: { code: -51, message: 'failed' } }));
      return res.end(JSON.stringify({ data: { code: paid.has('dup:' + j.authority) ? 101 : 100, message: 'Verified', ref_id: 777000 + calls.length, card_pan: '603799******1234' }, errors: [] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, paid, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) })));
}
