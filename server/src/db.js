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

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  user_email TEXT,
  role TEXT,
  action TEXT NOT NULL,        -- create | update | delete | approve | reject | login-reset | notify | finalize
  entity TEXT NOT NULL,        -- what was changed (employee, loan, company settings, user, …)
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`);

// Migrate older overtime_requests created before ot_kind existed.
try { db.exec("ALTER TABLE overtime_requests ADD COLUMN ot_kind TEXT NOT NULL DEFAULT 'after'"); } catch (e) { /* column already present */ }

// Reason an admin gives when declining a loan application (shown to the employee).
try { db.exec("ALTER TABLE loan_requests ADD COLUMN decline_reason TEXT"); } catch (e) { /* column already present */ }

// Proof-of-payment receipts for remitted government contributions (SSS,
// PhilHealth, Pag-IBIG) and BIR, kept as records under the reports. Stored as
// base64, keyed by agency + month (+ location for multi-branch).
db.exec(`
CREATE TABLE IF NOT EXISTS remittance_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agency TEXT NOT NULL,             -- sss | philhealth | pagibig | bir
  period_key TEXT NOT NULL,         -- 'YYYY-MM' the contribution/tax is for
  location_id TEXT,                 -- null = company-wide / all locations
  mime TEXT NOT NULL,
  file_name TEXT DEFAULT '',
  data TEXT NOT NULL,
  note TEXT DEFAULT '',             -- OR / reference number, remarks
  amount REAL,                      -- amount paid (optional)
  paid_at TEXT,                     -- date paid (optional, ISO)
  uploaded_by INTEGER, uploader_role TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remit_key ON remittance_receipts(agency, period_key);
`);

// Employee sign-off on a finalized payslip: either accepted (with a typed name
// for acknowledgement) or disputed (with the reason). One row per employee per
// period; a later submission replaces the earlier one.
db.exec(`
CREATE TABLE IF NOT EXISTS payslip_ack (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  employee_code TEXT,
  period_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'accepted' | 'disputed'
  signed_name TEXT DEFAULT '',      -- typed name on acceptance
  dispute_reason TEXT DEFAULT '',   -- reason on dispute
  net_pay REAL,                     -- snapshot of the net pay acknowledged
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, period_id)
);
CREATE INDEX IF NOT EXISTS idx_payack_period ON payslip_ack(period_id);
`);

// Authenticator-app (TOTP) 2FA, used for self-service password reset.
try { db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT"); } catch (e) { /* column already present */ }
try { db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* column already present */ }

// Per-location manager scoping: when set, the user only sees/edits that location.
try { db.exec("ALTER TABLE users ADD COLUMN location_id TEXT"); } catch (e) { /* column already present */ }

// Force a password change on next login (set when an admin issues a temp password).
try { db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* column already present */ }

// Employee profile photo (latest self picture). One per user, stored as base64.
db.exec(`
CREATE TABLE IF NOT EXISTS profile_photos (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Employee requests to change sensitive 201 fields (bank / government IDs) that
// require admin approval before they are applied to the 201 record.
db.exec(`
CREATE TABLE IF NOT EXISTS profile_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pcr_user ON profile_change_requests(user_id);
`);

// Documents attached to an employee: uploaded BY the employee (medical
// certificate, emergency-leave proof, other) or issued TO them by HR/admin
// (Notice to Explain, Notice of Decision, memo). Stored as base64.
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_user_id INTEGER,
  subject_employee_code TEXT,
  direction TEXT NOT NULL,          -- 'employee' (uploaded by the employee) | 'admin' (issued by HR/admin)
  category TEXT NOT NULL,           -- med_cert | el_proof | other | nte | nod | memo
  title TEXT DEFAULT '',
  note TEXT DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  data TEXT NOT NULL,
  leave_request_id INTEGER,
  uploaded_by INTEGER,
  uploader_role TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_subject ON documents(subject_user_id);
CREATE INDEX IF NOT EXISTS idx_docs_code ON documents(subject_employee_code);
CREATE INDEX IF NOT EXISTS idx_docs_leave ON documents(leave_request_id);
`);

// Bulletin board: HR / payroll announcements, upcoming events, holidays and
// memos posted by admins / supervisors. Shown to employees as a login pop-up and
// in a Bulletin tab. A per-user ack table tracks who has already seen each post
// so it only pops up until dismissed.
db.exec(`
CREATE TABLE IF NOT EXISTS bulletins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'announcement', -- announcement | event | holiday | memo
  event_date TEXT,           -- optional date the event/holiday falls on
  ends_at TEXT,              -- optional last day to show it (after this it stops appearing)
  pinned INTEGER NOT NULL DEFAULT 0,
  location_id TEXT,          -- null = all locations
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  author_name TEXT DEFAULT '',
  author_role TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bulletins_active ON bulletins(active, ends_at);

CREATE TABLE IF NOT EXISTS bulletin_acks (
  bulletin_id INTEGER NOT NULL REFERENCES bulletins(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bulletin_id, user_id)
);
`);
// Optional attached memo file (PDF/DOCX) on a bulletin, stored as base64.
try { db.exec("ALTER TABLE bulletins ADD COLUMN file_mime TEXT"); } catch (e) { /* column already present */ }
try { db.exec("ALTER TABLE bulletins ADD COLUMN file_name TEXT"); } catch (e) { /* column already present */ }
try { db.exec("ALTER TABLE bulletins ADD COLUMN file_data TEXT"); } catch (e) { /* column already present */ }

// Work-from-Home / Field-Work DTR filings. Employees who cannot use the biometric
// file their own attendance for a day, attaching an EOD report and time-in/time-out
// photos as proof. On approval it becomes a flat 8-hour worked day in the DTR (no
// late/overtime). Files are stored as base64 in the same DB volume.
db.exec(`
CREATE TABLE IF NOT EXISTS wfh_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  work_date TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'wfh',          -- wfh | field
  time_in TEXT, time_out TEXT,
  eod_note TEXT DEFAULT '',
  eod_mime TEXT, eod_name TEXT, eod_data TEXT,   -- EOD report file
  in_mime TEXT, in_data TEXT,                    -- time-in photo
  out_mime TEXT, out_data TEXT,                  -- time-out photo
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  reviewed_by INTEGER, reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wfh_user ON wfh_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_wfh_status ON wfh_requests(status);
`);

// Employee-uploaded physical time cards (photo/scan) for a payroll period. The
// image is kept as base64 so it persists in the same DB volume as everything else.
db.exec(`
CREATE TABLE IF NOT EXISTS time_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  period_id TEXT,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  data TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timecards_user ON time_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_timecards_period ON time_cards(period_id);
`);

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
