// اعلان‌های پیامکی. تا وقتی SMS_ENABLED=true و کلید واقعی تنظیم نشده باشد هیچ پیامکی ارسال (یا شبیه‌سازی) نمی‌شود.
import crypto from 'node:crypto';

export function createKavenegar({ apiKey, sender }, fetchImpl = fetch) {
  return {
    name: 'kavenegar',
    async send({ to, text }) {
      const url = `https://api.kavenegar.com/v1/${encodeURIComponent(apiKey)}/sms/send.json`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ receptor: to, sender, message: text }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.return?.status !== 200) throw new Error(`ارسال پیامک ناموفق بود (${json?.return?.status ?? res.status})`);
    },
  };
}

export function createSms({ config, db, clock, provider, fetchImpl }) {
  const enabled = config.sms.enabled;
  let prov = provider || null;
  if (enabled && !prov) {
    if (config.sms.provider === 'kavenegar') prov = createKavenegar(config.sms, fetchImpl);
    else throw new Error('SMS_PROVIDER ناشناخته است.');
  }

  async function send({ to, text, type, bookingId = null }) {
    if (!enabled || !prov) return { sent: false, reason: 'disabled' };
    const now = clock.nowMs();
    const id = Number(db.prepare('INSERT INTO notifications(booking_id,type,recipient,body,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(bookingId, type, to, type === 'otp' ? '(کد تأیید)' : text, 'pending', now).lastInsertRowid);
    try {
      await prov.send({ to, text });
      db.prepare("UPDATE notifications SET status='sent', sent_at=? WHERE id=?").run(clock.nowMs(), id);
      return { sent: true };
    } catch (e) {
      db.prepare("UPDATE notifications SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), id);
      return { sent: false, reason: 'failed' };
    }
  }

  return {
    enabled,
    otpRequired: enabled && config.sms.otpRequired,
    send,
  };
}

export const newOtpCode = () => String(crypto.randomInt(10000, 100000));
