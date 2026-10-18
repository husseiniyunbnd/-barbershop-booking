import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { newOtpCode } from './sms.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createOtp({ db, clock, sms }) {
  return {
    async send(phone) {
      const now = clock.nowMs();
      const row = db.prepare('SELECT * FROM otp_codes WHERE phone=?').get(phone);
      if (row && row.expires_at - 120_000 + 60_000 > now) throw new AppError(429, 'otp_too_soon', 'کد تأیید اخیراً ارسال شده است. یک دقیقه صبر کنید.');
      const code = newOtpCode();
      db.prepare(`INSERT INTO otp_codes(phone,code_hash,expires_at,attempts,verified_token_hash,verified_until) VALUES (?,?,?,0,NULL,NULL)
        ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, verified_token_hash=NULL, verified_until=NULL`)
        .run(phone, sha(code), now + 120_000);
      const r = await sms.send({ to: phone, type: 'otp', text: `کد تأیید رزرو نوبت: ${code}` });
      if (!r.sent) throw new AppError(502, 'sms_failed', 'ارسال پیامک ممکن نشد. دوباره تلاش کنید.');
    },
    verify(phone, code) {
      const now = clock.nowMs();
      const row = db.prepare('SELECT * FROM otp_codes WHERE phone=?').get(phone);
      if (!row || row.expires_at < now) throw new AppError(400, 'otp_expired', 'کد تأیید منقضی شده است. کد جدید دریافت کنید.');
      if (row.attempts >= 5) throw new AppError(429, 'otp_locked', 'تعداد تلاش‌ها بیش از حد مجاز است. کد جدید دریافت کنید.');
      db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE phone=?').run(phone);
      const a = Buffer.from(sha(String(code))), b = Buffer.from(row.code_hash);
      if (!crypto.timingSafeEqual(a, b)) throw new AppError(400, 'otp_wrong', 'کد تأیید درست نیست.');
      const token = crypto.randomBytes(24).toString('base64url');
      db.prepare('UPDATE otp_codes SET verified_token_hash=?, verified_until=?, code_hash=? WHERE phone=?').run(sha(token), now + 15 * 60_000, sha(crypto.randomBytes(8)), phone);
      return token;
    },
    check(phone, token) {
      const row = db.prepare('SELECT * FROM otp_codes WHERE phone=?').get(phone);
      return !!(row && row.verified_token_hash && row.verified_until > clock.nowMs() && token && sha(String(token)) === row.verified_token_hash);
    },
    consume(phone) { db.prepare('UPDATE otp_codes SET verified_token_hash=NULL, verified_until=NULL WHERE phone=?').run(phone); },
  };
}
