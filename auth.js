import crypto from 'node:crypto';
import { AppError } from './errors.js';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(got, expected);
}
const DUMMY = hashPassword('dummy-password-for-timing');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const SESSION_HOURS = 12;
export const MIN_PASSWORD = 10;

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `رمز عبور باید حداقل ${MIN_PASSWORD} نویسه باشد.`;
  if (pw.length > 200) return 'رمز عبور بیش از حد طولانی است.';
  if (/^(.)\1+$/.test(pw)) return 'رمز عبور بسیار ساده است.';
  return null;
}

export function createAuth({ db, clock }) {
  const failures = new Map(); // username → { n, until }
  return {
    createAdmin(username, password) {
      const err = validatePasswordStrength(password);
      if (err) throw new Error(err);
      db.prepare('INSERT INTO admin_users(username,password_hash,created_at) VALUES (?,?,?)').run(username, hashPassword(password), clock.nowMs());
    },
    setPassword(adminId, password) {
      db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(hashPassword(password), adminId);
      db.prepare('DELETE FROM admin_sessions WHERE admin_id=?').run(adminId); // خروج از همه‌ی نشست‌ها
    },
    login(username, password) {
      const key = String(username).toLowerCase();
      const f = failures.get(key);
      if (f && f.until > clock.nowMs()) throw new AppError(429, 'locked', 'به‌دلیل تلاش‌های ناموفق، ورود موقتاً قفل شد. بعداً تلاش کنید.');
      const u = db.prepare('SELECT * FROM admin_users WHERE username=?').get(String(username));
      const ok = verifyPassword(String(password), u ? u.password_hash : DUMMY) && !!u;
      if (!ok) {
        const n = (f?.n || 0) + 1;
        failures.set(key, { n, until: n >= 5 ? clock.nowMs() + 15 * 60_000 : 0 });
        throw new AppError(401, 'bad_credentials', 'نام کاربری یا رمز عبور درست نیست.');
      }
      failures.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(24).toString('base64url');
      const now = clock.nowMs();
      db.prepare('INSERT INTO admin_sessions(token_hash,admin_id,csrf,expires_at,created_at) VALUES (?,?,?,?,?)').run(sha(token), u.id, csrf, now + SESSION_HOURS * 3600_000, now);
      return { token, csrf, username: u.username, maxAge: SESSION_HOURS * 3600 };
    },
    getSession(token) {
      if (!token) return null;
      const s = db.prepare(`SELECT s.*, u.username FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.token_hash=?`).get(sha(token));
      if (!s || s.expires_at < clock.nowMs()) return null;
      return { adminId: s.admin_id, username: s.username, csrf: s.csrf, tokenHash: s.token_hash };
    },
    logout(token) { if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(sha(token)); },
    verifyAdminPassword(adminId, password) {
      const u = db.prepare('SELECT password_hash FROM admin_users WHERE id=?').get(adminId);
      return !!u && verifyPassword(String(password), u.password_hash);
    },
  };
}
