// بارگذاری تنظیمات از متغیرهای محیطی (و فایل .env در صورت وجود). هیچ کلید واقعی‌ای در کد نیست.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(overrides = {}, { readDotEnv = true } = {}) {
  let fileEnv = {};
  const envPath = path.join(ROOT, '.env');
  if (readDotEnv && fs.existsSync(envPath)) fileEnv = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const env = { ...fileEnv, ...process.env, ...overrides };

  const production = env.NODE_ENV === 'production';
  const port = int(env.PORT, 3000);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const config = {
    production,
    host: env.HOST || '0.0.0.0',
    port,
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: bool(env.TRUST_PROXY, false),
    databasePath: env.DATABASE_PATH === ':memory:' ? ':memory:' : env.DATABASE_PATH ? path.resolve(ROOT, env.DATABASE_PATH) : path.join(ROOT, 'data', 'app.db'),
    publicDir: path.join(ROOT, 'public'),
    tzOffsetMinutes: int(env.TZ_OFFSET_MINUTES, 210), // تهران: UTC+03:30 (بدون ساعت تابستانی)
    sweepIntervalMs: int(env.SWEEP_INTERVAL_SECONDS, 30) * 1000,
    rateLimitEnabled: bool(env.RATE_LIMIT_ENABLED, true),
    payment: {
      gateway: (env.PAYMENT_GATEWAY || 'mock').toLowerCase(), // mock | zarinpal
      zarinpal: {
        merchantId: env.ZARINPAL_MERCHANT_ID || '',
        apiBase: (env.ZARINPAL_API_BASE || 'https://payment.zarinpal.com').replace(/\/+$/, ''),
        startPayBase: (env.ZARINPAL_STARTPAY_BASE || env.ZARINPAL_API_BASE || 'https://payment.zarinpal.com').replace(/\/+$/, ''),
        currency: (env.ZARINPAL_CURRENCY || 'IRR').toUpperCase(), // IRR (ریال) یا IRT (تومان)
      },
    },
    sms: {
      enabled: bool(env.SMS_ENABLED, false),
      provider: (env.SMS_PROVIDER || 'kavenegar').toLowerCase(),
      apiKey: env.SMS_API_KEY || '',
      sender: env.SMS_SENDER || '',
      otpRequired: bool(env.OTP_REQUIRED, false),
    },
  };
  return config;
}

/** خطاهای پیکربندی که نباید اجازه راه‌اندازی سرور را بدهند */
export function validateConfig(config) {
  const errors = [];
  if (config.production) {
    if (!config.baseUrl.startsWith('https://')) errors.push('BASE_URL باید در حالت production با https شروع شود.');
    if (config.payment.gateway === 'mock') errors.push('درگاه آزمایشی (mock) در حالت production مجاز نیست. PAYMENT_GATEWAY=zarinpal را تنظیم کنید.');
  }
  if (!['mock', 'zarinpal'].includes(config.payment.gateway)) errors.push('PAYMENT_GATEWAY فقط می‌تواند mock یا zarinpal باشد.');
  if (config.payment.gateway === 'zarinpal' && !/^[0-9a-fA-F-]{36}$/.test(config.payment.zarinpal.merchantId)) {
    errors.push('ZARINPAL_MERCHANT_ID خالی یا نامعتبر است (باید کد ۳۶ نویسه‌ای پذیرنده باشد).');
  }
  if (config.sms.enabled && (!config.sms.apiKey || !config.sms.sender)) errors.push('SMS_ENABLED=true است ولی SMS_API_KEY یا SMS_SENDER تنظیم نشده.');
  if (config.sms.otpRequired && !config.sms.enabled) errors.push('OTP_REQUIRED فقط با SMS_ENABLED=true قابل استفاده است.');
  return errors;
}
