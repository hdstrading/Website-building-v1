/* ==========================================================================
 * db.js — SQLite schema + connection
 * --------------------------------------------------------------------------
 * One company per deployment (the "company data" is the same JSON document the
 * offline app uses). Users, leave requests and DTR submissions are relational.
 * ========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'payroll.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Company',
  data_json TEXT NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'employee',        -- superadmin | admin_payroll | finance | employee
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | active | disabled
  employee_code TEXT,                            -- links to an employee in company data
  profile_json TEXT NOT NULL DEFAULT '{}',       -- 201 info submitted at sign-up
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'VL',          -- SL | VL | EL
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | approved | rejected
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dtr_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  period_id TEXT NOT NULL,
  days_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted',        -- submitted | accepted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, period_id)
);

CREATE TABLE IF NOT EXISTS loan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  loan_type TEXT NOT NULL,                         -- cash_advance | product_advance | sss_loan | pagibig_loan
  amount REAL NOT NULL DEFAULT 0,
  installments INTEGER NOT NULL DEFAULT 1,         -- number of pay-period deductions requested
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | rejected
  loan_id TEXT,                                    -- id of the payroll loan created on approval
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  ot_date TEXT NOT NULL,
  ot_kind TEXT NOT NULL DEFAULT 'after',           -- after (post-shift) | before (pre-shift early-in)
  reason TEXT NOT NULL,                            -- production | delivery | collection
  specific_reason TEXT NOT NULL,
  end_time TEXT NOT NULL,                          -- end time (after) OR early time-in (before)
  ot_minutes INTEGER NOT NULL DEFAULT 0,           -- creditable OT per the company policy
  late_minutes INTEGER NOT NULL DEFAULT 0,         -- lateness that day (affects the policy)
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | rejected
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                              -- payslip | leave | loan
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`);

// Migrate older overtime_requests created before ot_kind existed.
try { db.exec("ALTER TABLE overtime_requests ADD COLUMN ot_kind TEXT NOT NULL DEFAULT 'after'"); } catch (e) { /* column already present */ }

// Seed the single company row with an empty data document if missing.
function emptyCompanyData() {
  return {
    meta: {
      version: 1,
      company: { name: 'My Company', address: '', tin: '' },
      overtime: { enabled: true, minMinutes: 60, incrementMinutes: 30, graceMinutes: 5, lateForfeitsFirstHour: true, requireAuthorization: true },
      leavePolicy: { manualOpen: false, openDay: 21 },
      thirteenthPolicy: { deductTardiness: true }
    },
    employees: [], allowances: [], loans: [], periods: [],
    dtr: {}, adjustments: {}, payrolls: {}, thirteenthMonth: {}, otApprovals: {}, statutoryConfig: null
  };
}
if (!db.prepare('SELECT 1 FROM companies WHERE id = 1').get()) {
  db.prepare('INSERT INTO companies (id, name, data_json, data_version) VALUES (1, ?, ?, 1)')
    .run('My Company', JSON.stringify(emptyCompanyData()));
}

module.exports = { db, emptyCompanyData };
