import { loadConfig, validateConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length) {
  console.error('خطا در تنظیمات؛ سرور اجرا نشد:\n - ' + errors.join('\n - '));
  process.exit(1);
}
const app = createApp(config);
app.startSweeper();
await app.listen();
console.log(`سرور روی ${config.baseUrl} (پورت ${config.port}) اجرا شد.`);
if (config.payment.gateway === 'mock') console.log('هشدار: درگاه پرداخت «آزمایشی» فعال است؛ پرداخت واقعی انجام نمی‌شود.');
if (!app.db.prepare('SELECT 1 FROM admin_users').get()) console.log('هنوز مدیری ساخته نشده است. اجرا کنید: npm run create-admin');

const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
