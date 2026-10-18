// اتصال به درگاه زرین‌پال (API نسخه ۴). فقط روی سرور اجرا می‌شود؛ merchant_id هرگز به مرورگر نمی‌رسد.
// نکته: نشانی‌ها و کدهای پاسخ را پیش از راه‌اندازی واقعی با مستندات رسمی زرین‌پال تطبیق دهید.
const FAILED_CODES = new Set([-50, -51, -52, -53, -54, -55, -9, -10, -11, -12, -15, -16, -17, -18, -19]);

export function createZarinpal({ merchantId, apiBase, startPayBase, currency }, fetchImpl = fetch) {
  const toGateway = (toman) => (currency === 'IRT' ? toman : toman * 10);

  async function post(path, payload) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* پاسخ غیر JSON */ }
    return { httpStatus: res.status, json };
  }
  const codeOf = (json) => {
    const d = json?.data;
    if (d && !Array.isArray(d) && d.code !== undefined) return Number(d.code);
    const e = json?.errors;
    if (e && !Array.isArray(e) && e.code !== undefined) return Number(e.code);
    return null;
  };

  return {
    name: 'zarinpal',
    isTest: false,
    toGatewayAmount: toGateway,

    async request({ amountToman, mobile, description, callbackUrl }) {
      const amountGateway = toGateway(amountToman);
      let r;
      try {
        r = await post('/pg/v4/payment/request.json', {
          merchant_id: merchantId,
          amount: amountGateway,
          currency,
          callback_url: callbackUrl,
          description,
          metadata: { mobile },
        });
      } catch (e) {
        const err = new Error('ارتباط با درگاه پرداخت برقرار نشد.');
        err.code = 'gateway_unreachable';
        throw err;
      }
      const code = codeOf(r.json);
      const authority = r.json?.data?.authority;
      if (code !== 100 || !authority) {
        const err = new Error('درگاه پرداخت درخواست را نپذیرفت.');
        err.code = 'gateway_rejected';
        err.gatewayCode = code;
        throw err;
      }
      return { authority, redirectUrl: `${startPayBase}/pg/StartPay/${authority}`, amountGateway };
    },

    /** خروجی: { status: 'verified' | 'failed' | 'unknown', code, refId, cardPan } */
    async verify({ authority, amountGateway }) {
      let r;
      try {
        r = await post('/pg/v4/payment/verify.json', { merchant_id: merchantId, amount: amountGateway, authority });
      } catch {
        return { status: 'unknown', code: null }; // خطای شبکه: نتیجه نامشخص است، «ناموفق» ثبت نمی‌شود
      }
      const code = codeOf(r.json);
      if (code === 100 || code === 101) {
        const d = r.json.data;
        return { status: 'verified', code, refId: d.ref_id != null ? String(d.ref_id) : null, cardPan: d.card_pan || null };
      }
      if (code !== null && FAILED_CODES.has(code)) return { status: 'failed', code };
      return { status: 'unknown', code };
    },
  };
}
