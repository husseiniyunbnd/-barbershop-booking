// ساخت/به‌روزرسانی کاربر مدیر:  npm run create-admin
import readline from 'node:readline/promises';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { createClock } from '../server/time.js';
import { createAuth, validatePasswordStrength } from '../server/auth.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const auth = createAuth({ db, clock: createClock(config.tzOffsetMinutes) });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const username = (process.env.ADMIN_USERNAME || (await rl.question('نام کاربری مدیر: '))).trim();
const password = process.env.ADMIN_PASSWORD || (await rl.question('رمز عبور (حداقل ۱۰ نویسه؛ روی صفحه نمایش داده می‌شود): '));
rl.close();
if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) { console.error('نام کاربری باید ۳ تا ۳۲ نویسه‌ی انگلیسی/عدد باشد.'); process.exit(1); }
const err = validatePasswordStrength(password);
if (err) { console.error(err); process.exit(1); }
const existing = db.prepare('SELECT id FROM admin_users WHERE username=?').get(username);
if (existing) { auth.setPassword(existing.id, password); console.log('رمز عبور مدیر به‌روزرسانی شد.'); }
else { auth.createAdmin(username, password); console.log('مدیر ساخته شد.'); }
db.close();
