// درگاه آزمایشی: فقط برای توسعه و تست. هیچ پول واقعی جابه‌جا نمی‌شود و در حالت production فعال نمی‌شود.
// تأیید پرداخت مثل درگاه واقعی از مسیر verify و روی «وضعیت ذخیره‌شده در سرور» انجام می‌شود، نه پارامترهای URL.
import crypto from 'node:crypto';

export function createMockGateway({ db, baseUrl, clock }) {
  return {
    name: 'mock',
    isTest: true,
    toGatewayAmount: (toman) => toman * 10,

    async request({ amountToman }) {
      const authority = 'MOCK' + crypto.randomBytes(12).toString('hex').toUpperCase();
      const amountGateway = amountToman * 10;
      db.prepare('INSERT INTO mock_gateway(authority, amount_gateway, state, created_at) VALUES (?,?,?,?)')
        .run(authority, amountGateway, 'open', clock.nowMs());
      return { authority, redirectUrl: `${baseUrl}/mock-gateway/${authority}`, amountGateway };
    },

    async verify({ authority, amountGateway }) {
      const row = db.prepare('SELECT * FROM mock_gateway WHERE authority=?').get(authority);
      if (!row) return { status: 'failed', code: -54 };
      if (row.state !== 'paid') return { status: 'failed', code: -51 };
      if (row.amount_gateway !== amountGateway) return { status: 'failed', code: -50 };
      const refId = 'T' + crypto.createHash('sha256').update(authority).digest('hex').slice(0, 10).toUpperCase();
      return { status: 'verified', code: 100, refId, cardPan: null };
    },
  };
}
