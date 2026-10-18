import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 15 AND 480),
  price_toman INTEGER NOT NULL CHECK (price_toman > 0),
  deposit_toman INTEGER NOT NULL CHECK (deposit_toman > 0),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (deposit_toman <= price_toman)
);

-- برنامه هفتگی؛ weekday: شنبه=۰ … جمعه=۶
CREATE TABLE IF NOT EXISTS working_hours (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  is_open INTEGER NOT NULL DEFAULT 1,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closed_days (
  date TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS blocked_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_blocked_date ON blocked_slots(date);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  service_id INTEGER REFERENCES services(id),
  service_name TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  price_toman INTEGER NOT NULL,
  deposit_toman INTEGER NOT NULL,
  remaining_toman INTEGER NOT NULL,
  date TEXT NOT NULL,
  jalali_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','cancelled','expired')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','failed','refunded')),
  hold_expires_at INTEGER,
  gateway TEXT,
  needs_refund INTEGER NOT NULL DEFAULT 0,
  deposit_outcome TEXT CHECK (deposit_outcome IN ('undecided','refund_due','refunded','forfeited')),
  attendance TEXT CHECK (attendance IN ('attended','no_show')),
  remaining_settled_at INTEGER,
  admin_note TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  reminder_sent_at INTEGER,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- جلوگیری قطعی از رزرو تکراریِ یک شروع زمانی (علاوه بر بررسی هم‌پوشانی در تراکنش)
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot ON bookings(date, start_time) WHERE status IN ('pending_payment','confirmed');
CREATE INDEX IF NOT EXISTS ix_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS ix_bookings_phone ON bookings(phone);
CREATE INDEX IF NOT EXISTS ix_bookings_status_hold ON bookings(status, hold_expires_at);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  gateway TEXT NOT NULL,
  authority TEXT NOT NULL UNIQUE,
  amount_toman INTEGER NOT NULL,
  amount_gateway INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initiated','verified','failed','cancelled')),
  ref_id TEXT,
  card_pan TEXT,
  gateway_code INTEGER,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_ref ON payments(gateway, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payments_booking ON payments(booking_id);

-- درگاه آزمایشی (فقط برای mock)
CREATE TABLE IF NOT EXISTS mock_gateway (
  authority TEXT PRIMARY KEY,
  amount_gateway INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','paid','cancelled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_token_hash TEXT,
  verified_until INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER,
  type TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
`;

export const DEFAULT_RULES = [
  'رزرو فقط پس از پرداخت موفق بیعانه قطعی می‌شود.',
  'لطفاً ۵ دقیقه پیش از ساعت نوبت در آرایشگاه حاضر باشید.',
  'مبلغ باقی‌مانده هنگام مراجعه و پس از انجام خدمت پرداخت می‌شود.',
  'هر نوبت یک بازه‌ی مشخص دارد و در صورت تأخیر زیاد ممکن است کوتاه‌تر شود.',
  'شرایط لغو یا جابه‌جایی نوبت و سیاست بازپرداخت بیعانه: [در انتظار تعیین توسط صاحب آرایشگاه — از پنل مدیریت > تنظیمات ویرایش شود]',
].join('\n');

export const DEFAULT_SETTINGS = {
  business_name: 'آرایشگاه مردانه',
  tagline: 'کوتاهی مو با نوبت مشخص',
  intro: 'روز و ساعت دلخواه را انتخاب کنید، بیعانه را آنلاین بپردازید و نوبت‌تان همان لحظه قطعی می‌شود.',
  phone: '',
  address: '',
  instagram_url: '',
  logo_url: '/img/logo.svg',
  rules: DEFAULT_RULES,
  hold_minutes: 15,
  booking_window_days: 21,
  min_lead_minutes: 60,
  max_pending_per_phone: 2,
  reminder_hours_before: 3,
};

const DEFAULT_HOURS = [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, is_open: w === 6 ? 0 : 1, start_time: '10:00', end_time: '18:00' }));

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const has = (sql) => db.prepare(sql).get();
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(k, JSON.stringify(v));
  }
  if (!has('SELECT 1 FROM working_hours')) {
    const ins = db.prepare('INSERT INTO working_hours(weekday,is_open,start_time,end_time) VALUES (?,?,?,?)');
    for (const h of DEFAULT_HOURS) ins.run(h.weekday, h.is_open, h.start_time, h.end_time);
  }
  if (!has('SELECT 1 FROM services')) {
    db.prepare('INSERT INTO services(name,duration_min,price_toman,deposit_toman,active,sort_order) VALUES (?,?,?,?,1,0)')
      .run('کوتاهی مو', 60, 1_000_000, 500_000);
  }
  if (!has("SELECT 1 FROM meta WHERE key='app_secret'")) {
    db.prepare("INSERT INTO meta(key,value) VALUES ('app_secret', ?)").run(crypto.randomBytes(32).toString('hex'));
  }
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key,value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* مقدار خراب نادیده گرفته می‌شود */ }
  }
  return out;
}

export function setSettings(db, patch) {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(patch)) up.run(k, JSON.stringify(v));
}

export const getSecret = (db) => db.prepare("SELECT value FROM meta WHERE key='app_secret'").get().value;

/** اجرای تراکنش با قفل نوشتن (BEGIN IMMEDIATE)؛ تو در تو امن است. */
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}
