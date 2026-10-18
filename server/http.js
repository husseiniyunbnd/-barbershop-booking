import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
export const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
export const redirect = (res, location, status = 302) => send(res, status, '', { location, 'cache-control': 'no-store' });
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function readBody(req, limit = 64 * 1024, { form = false } = {}) {
  const type = String(req.headers['content-type'] || '');
  const isJson = type.includes('application/json');
  const isForm = form && type.includes('application/x-www-form-urlencoded');
  if (!isJson && !isForm) throw new AppError(415, 'unsupported_media_type', 'نوع درخواست پشتیبانی نمی‌شود.');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(413, 'too_large', 'حجم درخواست زیاد است.');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if (isForm) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { throw new AppError(400, 'bad_json', 'درخواست نامعتبر است.'); }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createLimiter(enabled = true, nowFn = () => Date.now()) {
  const buckets = new Map();
  return function hit(key, max, windowMs) {
    if (!enabled) return;
    const now = nowFn();
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n += 1;
    if (buckets.size > 20000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    if (b.n > max) throw new AppError(429, 'rate_limited', 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.', { retryAfter: Math.ceil((b.reset - now) / 1000) });
  };
}

export function serveStatic(res, publicDir, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return false; }
  if (rel.includes('\0')) return false;
  const full = path.resolve(publicDir, '.' + path.posix.normalize('/' + rel));
  if (full !== publicDir && !full.startsWith(publicDir + path.sep)) return false;
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
  send(res, 200, fs.readFileSync(full), { 'content-type': type, 'cache-control': cache, 'content-length': st.size });
  return true;
}
