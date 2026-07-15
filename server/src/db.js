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
`);

// Seed the single company row with an empty data document if missing.
function emptyCompanyData() {
  return {
    meta: {
      version: 1,
      company: { name: 'My Company', address: '', tin: '' },
      overtime: { enabled: true, minMinutes: 60, incrementMinutes: 30, graceMinutes: 5 }
    },
    employees: [], allowances: [], loans: [], periods: [],
    dtr: {}, adjustments: {}, payrolls: {}, thirteenthMonth: {}, statutoryConfig: null
  };
}
if (!db.prepare('SELECT 1 FROM companies WHERE id = 1').get()) {
  db.prepare('INSERT INTO companies (id, name, data_json, data_version) VALUES (1, ?, ?, 1)')
    .run('My Company', JSON.stringify(emptyCompanyData()));
}

module.exports = { db, emptyCompanyData };
