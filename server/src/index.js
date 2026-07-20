/* ==========================================================================
 * index.js — Express app: auth, company data, admin, employee self-service
 * ========================================================================== */
'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, emptyCompanyData } = require('./db');
const A = require('./auth');
const mailer = require('./mailer');

const app = express();
app.set('trust proxy', true); // behind Caddy/Nginx: honour X-Forwarded-Proto
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(A.authenticate);

// Public base URL for links in emails (env override, else derive from request).
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return req.protocol + '://' + req.get('host');
}

/* ---------- helpers ---------- */
function getCompany() {
  return db.prepare('SELECT * FROM companies WHERE id = 1').get();
}
function getCompanyData() { return JSON.parse(getCompany().data_json); }
// Read-modify-write is atomic here because better-sqlite3 is synchronous.
function saveCompanyData(data, expectedVersion) {
  const row = getCompany();
  if (expectedVersion != null && Number(expectedVersion) !== row.data_version) {
    const err = new Error('Data was changed by someone else. Reload and try again.');
    err.code = 'CONFLICT';
    throw err;
  }
  const nextVersion = row.data_version + 1;
  db.prepare('UPDATE companies SET data_json = ?, data_version = ?, name = ?, updated_at = datetime(\'now\') WHERE id = 1')
    .run(JSON.stringify(data), nextVersion, (data.meta && data.meta.company && data.meta.company.name) || row.name);
  return nextVersion;
}
function findEmpByCode(data, code) {
  return (data.employees || []).find(function (e) { return e.code === code; });
}
// Record an in-app notification for a user (best-effort; never throws to caller).
function notify(userId, type, title, body) {
  if (!userId) return;
  try {
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(userId, type, title, body || '');
  } catch (e) { console.error('notify failed', e.message); }
}

/* ---------- leave application window ----------
 * Governs when an employee may file leave. Shared rule (mirrored in the portal):
 *  - VL cannot be backdated.
 *  - Current-month leave is always fileable.
 *  - Next-month leave opens on `openDay` of the current month (or when the
 *    superadmin flips `manualOpen`).
 *  - Two or more months ahead: only when `manualOpen` is on.
 *  - SL / EL may be backdated (unplanned absences).
 */
const LOAN_TYPES = {
  cash_advance:    'Cash Advance',
  product_advance: 'Product Advance',
  sss_loan:        'SSS Loan',
  pagibig_loan:    'Pag-IBIG Loan'
};
const OT_REASONS = { production: 'Production', delivery: 'Delivery', collection: 'Collection' };

/* ---------- overtime authorization computation ----------
 * Mirrors assets/js/dtr.js applyOtRules so filed OT is credited exactly like
 * DTR-derived OT: first hour must be completed, then round in blocks, and — if
 * the employee was late beyond the grace window — the first OT hour is forfeited
 * and only whole hours are credited (the company's OT-when-late policy).
 */
function hmToMin(s) { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function applyOtRulesSrv(otRaw, rules, lateMinutes) {
  rules = rules || {};
  if (rules.enabled === false) return 0;
  if (!(otRaw > 0)) return 0;
  const inc = rules.incrementMinutes > 0 ? rules.incrementMinutes : 30;
  const grace = rules.graceMinutes != null ? rules.graceMinutes : 5;
  const minM = rules.minMinutes != null ? rules.minMinutes : 60;
  const late = lateMinutes || 0;
  if (late > grace && rules.lateForfeitsFirstHour !== false) {
    const creditable = otRaw - minM;          // forfeit the first hour
    if (creditable <= 0) return 0;
    return Math.floor(creditable / 60) * 60;  // whole hours only
  }
  let blocks = Math.floor(otRaw / inc);
  const rem = otRaw - blocks * inc;
  if (rem >= inc - grace) blocks += 1;
  const rounded = blocks * inc;
  return rounded < minM ? 0 : rounded;
}
// Lateness (minutes) that day, from the employee's DTR punch for the date.
function lateForDate(data, emp, dateStr) {
  const schedIn = hmToMin(emp.schedTimeIn);
  if (schedIn == null) return 0;
  for (const pid in (data.dtr || {})) {
    const days = (data.dtr[pid] || {})[emp.id];
    if (!days) continue;
    for (const d of days) {
      if (d.date === dateStr && d.timeIn) {
        const ti = hmToMin(d.timeIn);
        if (ti != null) return Math.max(0, ti - schedIn);
      }
    }
  }
  return 0;
}
// Compute creditable OT for a filed authorization (null if schedule/time missing).
function computeFiledOT(data, emp, dateStr, endTime) {
  const schedOut = hmToMin(emp.schedTimeOut);
  const endMin = hmToMin(endTime);
  if (schedOut == null || endMin == null) return null;
  const endN = endMin < schedOut ? endMin + 1440 : endMin; // crossed midnight
  const otRaw = Math.max(0, endN - schedOut);
  const late = lateForDate(data, emp, dateStr);
  const otMinutes = applyOtRulesSrv(otRaw, (data.meta && data.meta.overtime) || {}, late);
  return { otRaw: otRaw, otMinutes: otMinutes, lateMinutes: late };
}
function leavePolicyOf(data) {
  return (data.meta && data.meta.leavePolicy) || { manualOpen: false, openDay: 21 };
}
function ymIndex(d) { return d.getFullYear() * 12 + d.getMonth(); }
function parseDateLocal(s) { const p = String(s).split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function todayLocal() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function leaveDateAllowed(dateStr, type, policy, today) {
  const d = parseDateLocal(dateStr);
  if (isNaN(d.getTime())) return false;
  const t0 = today || todayLocal();
  const openDay = Number(policy && policy.openDay) || 21;
  const manualOpen = !!(policy && policy.manualOpen);
  if (type === 'VL' && d < t0) return false;           // no backdated vacation
  const md = ymIndex(d) - ymIndex(t0);
  if (md <= -1) return type === 'SL' || type === 'EL'; // backdated sick/emergency only
  if (md === 0) return true;                           // current month
  if (md === 1) return manualOpen || t0.getDate() >= openDay;
  return manualOpen;                                   // 2+ months ahead
}

/* ================= AUTH ================= */
app.post('/api/auth/register', (req, res) => {
  const { email, password, fullName, profile } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: 'That email is already registered.' });
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, status, profile_json)
     VALUES (?, ?, ?, 'employee', 'pending', ?)`
  ).run(String(email).toLowerCase(), A.hashPassword(password), fullName || '', JSON.stringify(profile || {}));
  res.json({ ok: true, id: info.lastInsertRowid, message: 'Registration submitted. An administrator must approve your account before you can sign in.' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || !A.verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (user.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting administrator approval.' });
  if (user.status === 'disabled') return res.status(403).json({ error: 'Your account has been disabled.' });
  A.issueToken(res, user);
  res.json({ user: A.publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => { A.clearToken(res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: A.publicUser(req.user) }));

// Forgot password: emails a reset link (only when SMTP is configured).
app.post('/api/auth/forgot', async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase();
  if (!mailer.configured()) {
    return res.json({ ok: true, emailConfigured: false,
      message: 'Password reset by email is not set up on this server. Please ask your administrator to reset your password.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user && user.status !== 'disabled') {
    const link = baseUrl(req) + '/reset.html?token=' + encodeURIComponent(A.makeResetToken(user.id));
    try {
      await mailer.sendMail({
        to: user.email,
        subject: 'Reset your PH Payroll password',
        html: '<p>Hi ' + (user.full_name || '') + ',</p><p>Click the link below to set a new password (valid for 1 hour):</p>' +
          '<p><a href="' + link + '">Reset my password</a></p><p>If you did not request this, you can ignore this email.</p>',
        text: 'Reset your password: ' + link
      });
    } catch (e) { /* swallow — do not reveal */ }
  }
  // Always respond generically so the form can't be used to probe emails.
  res.json({ ok: true, emailConfigured: true,
    message: 'If that email is registered, a reset link has been sent.' });
});

app.post('/api/auth/reset', (req, res) => {
  const { token, password } = req.body || {};
  const uid = A.verifyResetToken(token || '');
  if (!uid) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(password), uid);
  res.json({ ok: true });
});

/* ================= COMPANY DATA (admin) ================= */
app.get('/api/company', A.requireAdmin, (req, res) => {
  const row = getCompany();
  res.json({ name: row.name, version: row.data_version, data: JSON.parse(row.data_json), role: req.user.role });
});
// Only superadmin & payroll admins may write the full company data.
app.put('/api/company', A.requireRole('superadmin', 'admin_payroll'), (req, res) => {
  const { data, version } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Missing data.' });
  try {
    const v = saveCompanyData(data, version);
    res.json({ ok: true, version: v });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

/* ================= ADMIN: users & leave ================= */
const adminMgmt = A.requireRole('superadmin', 'admin_payroll');

app.get('/api/admin/users', adminMgmt, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json({ users: users.map(function (u) {
    return Object.assign(A.publicUser(u), { profile: JSON.parse(u.profile_json || '{}'), createdAt: u.created_at });
  }) });
});

// Approve / activate a user, set role, and link (or create) their employee record.
app.post('/api/admin/users/:id/approve', adminMgmt, (req, res) => {
  const { role, employeeCode, createEmployee } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newRole = A.ROLES.indexOf(role) >= 0 ? role : 'employee';
  let code = employeeCode || user.employee_code || null;

  // Optionally create an employee (201) record in company data from the sign-up profile.
  if (createEmployee && newRole === 'employee') {
    const data = getCompanyData();
    const profile = JSON.parse(user.profile_json || '{}');
    code = code || profile.code || ('EMP-' + String(user.id).padStart(4, '0'));
    if (!findEmpByCode(data, code)) {
      data.employees.push(Object.assign({
        id: 'emp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        code: code, employmentType: 'monthly', dailyRateFactor: 313, workDaysPerWeek: 6, restDay: 0,
        employmentStatus: 'probationary', leaveCreditsPerYear: 0, leaveCreditsUsed: 0,
        schedTimeIn: '08:00', schedTimeOut: '17:00', schedBreakMins: 60,
        contributionBasis: 'basic', active: true
      }, sanitizeProfile(profile), { code: code }));
      saveCompanyData(data);
    }
  }
  db.prepare('UPDATE users SET status = \'active\', role = ?, employee_code = ? WHERE id = ?')
    .run(newRole, code, user.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/role', adminMgmt, (req, res) => {
  const { role } = req.body || {};
  if (A.ROLES.indexOf(role) < 0) return res.status(400).json({ error: 'Invalid role.' });
  // Guard: never leave the system without a superadmin.
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (target && target.role === 'superadmin' && role !== 'superadmin') {
    const supers = db.prepare('SELECT COUNT(*) c FROM users WHERE role = \'superadmin\' AND status = \'active\'').get().c;
    if (supers <= 1) return res.status(400).json({ error: 'There must be at least one Super Admin.' });
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/status', adminMgmt, (req, res) => {
  const { status } = req.body || {};
  if (['active', 'disabled', 'pending'].indexOf(status) < 0) return res.status(400).json({ error: 'Invalid status.' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/leave-requests', A.requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT lr.*, u.full_name, u.email FROM leave_requests lr JOIN users u ON u.id = lr.user_id
     ORDER BY (lr.status = 'pending') DESC, lr.created_at DESC`
  ).all();
  res.json({ requests: rows });
});

app.post('/api/admin/leave-requests/:id', adminMgmt, (req, res) => {
  const { decision } = req.body || {}; // 'approved' | 'rejected'
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const row = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Leave request not found.' });
  db.prepare('UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(decision, req.user.id, req.params.id);
  notify(row.user_id, 'leave', 'Leave ' + decision,
    row.leave_type + ' leave for ' + row.date_from + (row.date_to !== row.date_from ? ' → ' + row.date_to : '') + ' was ' + decision + '.');
  res.json({ ok: true });
});

/* ---- overtime authorization (admin review) ---- */
app.get('/api/admin/overtime-requests', A.requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT o.*, u.full_name, u.email FROM overtime_requests o JOIN users u ON u.id = o.user_id
     ORDER BY (o.status = 'pending') DESC, o.ot_date DESC, o.created_at DESC`
  ).all();
  res.json({ requests: rows.map(function (r) { return Object.assign(r, { reason_label: OT_REASONS[r.reason] || r.reason }); }) });
});
app.post('/api/admin/overtime-requests/:id', adminMgmt, (req, res) => {
  const { decision } = req.body || {};
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const row = db.prepare('SELECT * FROM overtime_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Overtime request not found.' });
  db.prepare('UPDATE overtime_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(decision, req.user.id, row.id);
  const hrs = (row.ot_minutes / 60).toFixed(2);
  notify(row.user_id, 'overtime', 'Overtime ' + decision,
    'Your overtime for ' + row.ot_date + ' (' + hrs + ' hr' + (hrs === '1.00' ? '' : 's') + ') was ' + decision + '.');
  res.json({ ok: true });
});

/* ---- loan applications (admin review) ---- */
app.get('/api/admin/loan-requests', A.requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT lr.*, u.full_name, u.email FROM loan_requests lr JOIN users u ON u.id = lr.user_id
     ORDER BY (lr.status = 'pending') DESC, lr.created_at DESC`
  ).all();
  res.json({ requests: rows.map(function (r) { return Object.assign(r, { loan_type_label: LOAN_TYPES[r.loan_type] || r.loan_type }); }) });
});

// Approve (creating a payroll loan that is auto-deducted) or reject a loan request.
app.post('/api/admin/loan-requests/:id', adminMgmt, (req, res) => {
  const { decision, monthlyAmortization } = req.body || {};
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const reqRow = db.prepare('SELECT * FROM loan_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'Loan request not found.' });
  if (reqRow.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });

  if (decision === 'rejected') {
    db.prepare('UPDATE loan_requests SET status = \'rejected\', reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
      .run(req.user.id, reqRow.id);
    notify(reqRow.user_id, 'loan', 'Loan application rejected',
      (LOAN_TYPES[reqRow.loan_type] || 'Loan') + ' for ₱' + Number(reqRow.amount).toLocaleString('en-PH') + ' was not approved.');
    return res.json({ ok: true });
  }

  // Approve: create the payroll loan on the linked employee so it deducts automatically.
  const data = getCompanyData();
  // Prefer the request's stored code, but fall back to the applicant's current
  // employee_code — the 201 may have been linked after they applied.
  const applicant = db.prepare('SELECT employee_code FROM users WHERE id = ?').get(reqRow.user_id);
  const empCode = reqRow.employee_code || (applicant && applicant.employee_code);
  const emp = findEmpByCode(data, empCode);
  if (!emp) return res.status(400).json({ error: 'No employee (201) record is linked to this applicant yet — approve their account/201 first.' });
  const perMonth = Number(monthlyAmortization) > 0
    ? Number(monthlyAmortization)
    : Math.round((reqRow.amount / Math.max(1, reqRow.installments)) * 100) / 100;
  const loanId = 'loan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  data.loans = data.loans || [];
  data.loans.push({
    id: loanId, employeeId: emp.id, type: LOAN_TYPES[reqRow.loan_type] || 'Loan',
    principal: reqRow.amount, monthlyAmortization: perMonth, balance: reqRow.amount,
    active: true, source: 'application', requestId: reqRow.id
  });
  let version;
  try { version = saveCompanyData(data); }
  catch (e) { return res.status(e.code === 'CONFLICT' ? 409 : 500).json({ error: e.message }); }
  db.prepare('UPDATE loan_requests SET status = \'approved\', loan_id = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(loanId, req.user.id, reqRow.id);
  notify(reqRow.user_id, 'loan', 'Loan application approved',
    (LOAN_TYPES[reqRow.loan_type] || 'Loan') + ' for ₱' + Number(reqRow.amount).toLocaleString('en-PH') +
    ' approved — ₱' + Number(perMonth).toLocaleString('en-PH') + ' will be deducted each period.');
  res.json({ ok: true, loanId: loanId, companyVersion: version });
});

// Admin resets a user's password (provide one, or a random one is generated).
app.post('/api/admin/users/:id/password', adminMgmt, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  let pw = (req.body && req.body.password) || '';
  let generated = false;
  if (!pw) { pw = Math.random().toString(36).slice(2, 10); generated = true; }
  if (String(pw).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(pw), user.id);
  res.json({ ok: true, password: generated ? pw : undefined });
});

// Email employees that their payslip for a finalized period is ready.
app.post('/api/admin/notify-payslips', A.requireAdmin, async (req, res) => {
  const { periodId } = req.body || {};
  const data = getCompanyData();
  const period = (data.periods || []).find(p => p.id === periodId);
  if (!period) return res.status(404).json({ error: 'Period not found.' });
  const results = data.payrolls[periodId] || {};
  const base = baseUrl(req);
  let sent = 0, skipped = 0, notified = 0;
  const users = db.prepare("SELECT * FROM users WHERE role = 'employee' AND status = 'active' AND employee_code IS NOT NULL").all();
  for (const u of users) {
    const emp = findEmpByCode(data, u.employee_code);
    if (!emp || !results[emp.id]) continue;              // no payslip for them this period
    const net = results[emp.id].netPay;
    // In-app notification is the reliable channel — always record it.
    notify(u.id, 'payslip', 'Payslip ready',
      'Your payslip for ' + period.name + ' is available. Net pay ₱' + Number(net).toLocaleString('en-PH', { minimumFractionDigits: 2 }) + '.');
    notified++;
    if (!u.email) { skipped++; continue; }
    try {
      const r = await mailer.sendMail({
        to: u.email,
        subject: 'Your payslip for ' + period.name + ' is ready',
        html: '<p>Hi ' + (u.full_name || '') + ',</p>' +
          '<p>Your payslip for <b>' + period.name + '</b> is now available.</p>' +
          '<p>Net pay: <b>₱' + Number(net).toLocaleString('en-PH', { minimumFractionDigits: 2 }) + '</b></p>' +
          '<p><a href="' + base + '/portal">Open the employee portal</a> to view and print it.</p>',
        text: 'Your payslip for ' + period.name + ' is ready. Open ' + base + '/portal to view it.'
      });
      if (r && r.skipped) skipped++; else sent++;
    } catch (e) { skipped++; }
  }
  res.json({ ok: true, sent, skipped, notified, emailConfigured: mailer.configured() });
});

/* ================= EMPLOYEE SELF-SERVICE ================= */
app.get('/api/me/profile', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const emp = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;
  const loans = emp ? (data.loans || []).filter(function (l) { return l.employeeId === emp.id; }) : [];
  res.json({
    user: A.publicUser(req.user),
    profile: JSON.parse(req.user.profile_json || '{}'),
    employee: emp || null,
    loans: loans,
    company: data.meta.company
  });
});

/* ---- in-app notifications ---- */
app.get('/api/me/notifications', A.requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).c;
  res.json({ items: items, unread: unread });
});
app.post('/api/me/notifications/read', A.requireAuth, (req, res) => {
  const id = req.body && req.body.id;
  if (id) db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ---- overtime authorization (employee self-service) ---- */
// Live preview of creditable OT for a date + end time (no write).
app.get('/api/me/overtime/preview', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const emp = findEmpByCode(data, req.user.employee_code);
  if (!emp) return res.json({ ok: false, error: 'No employee (201) record is linked to your account yet.' });
  if (!emp.schedTimeOut) return res.json({ ok: false, error: 'Your shift end time is not set. Ask your administrator.' });
  const date = req.query.date, endTime = req.query.endTime;
  if (!date || !endTime) return res.json({ ok: false });
  const c = computeFiledOT(data, emp, date, endTime);
  if (!c) return res.json({ ok: false, error: 'Check the end time.' });
  res.json({ ok: true, otMinutes: c.otMinutes, otHours: c.otMinutes / 60, lateMinutes: c.lateMinutes, schedOut: emp.schedTimeOut });
});
app.get('/api/me/overtime', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM overtime_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ requests: rows.map(function (r) { return Object.assign(r, { reason_label: OT_REASONS[r.reason] || r.reason }); }) });
});
app.post('/api/me/overtime', A.requireAuth, (req, res) => {
  const { date, reason, specificReason, endTime } = req.body || {};
  if (!OT_REASONS[reason]) return res.status(400).json({ error: 'Choose a valid overtime reason.' });
  if (!date) return res.status(400).json({ error: 'Enter the date the overtime was rendered.' });
  if (!endTime) return res.status(400).json({ error: 'Enter the end time of the overtime.' });
  if (!specificReason || !String(specificReason).trim()) return res.status(400).json({ error: 'A specific reason is required.' });
  if (parseDateLocal(date) > todayLocal()) return res.status(400).json({ error: 'The overtime date cannot be in the future.' });
  const data = getCompanyData();
  const emp = findEmpByCode(data, req.user.employee_code);
  if (!emp) return res.status(400).json({ error: 'No employee (201) record is linked to your account yet.' });
  if (!emp.schedTimeOut) return res.status(400).json({ error: 'Your work schedule (shift end) is not set. Ask your administrator.' });
  const c = computeFiledOT(data, emp, date, endTime);
  if (!c) return res.status(400).json({ error: 'Could not compute overtime — check the end time.' });
  db.prepare(
    `INSERT INTO overtime_requests (user_id, employee_code, ot_date, reason, specific_reason, end_time, ot_minutes, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, req.user.employee_code, date, reason, String(specificReason).trim(), endTime, c.otMinutes, c.lateMinutes);
  res.json({ ok: true, otMinutes: c.otMinutes, otHours: c.otMinutes / 60, lateMinutes: c.lateMinutes });
});

/* ---- loan applications (employee self-service) ---- */
app.get('/api/me/loans', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM loan_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ requests: rows });
});
app.post('/api/me/loans', A.requireAuth, (req, res) => {
  const { loanType, amount, installments, reason } = req.body || {};
  if (!LOAN_TYPES[loanType]) return res.status(400).json({ error: 'Choose a valid loan type.' });
  const amt = Number(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter a valid amount.' });
  const inst = Math.max(1, parseInt(installments, 10) || 1);
  db.prepare(
    `INSERT INTO loan_requests (user_id, employee_code, loan_type, amount, installments, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, req.user.employee_code, loanType, amt, inst, reason || '');
  res.json({ ok: true });
});

app.get('/api/me/leave', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ requests: rows });
});
app.get('/api/me/leave-window', A.requireAuth, (req, res) => {
  const pol = leavePolicyOf(getCompanyData());
  const t = todayLocal();
  res.json({
    openDay: Number(pol.openDay) || 21,
    manualOpen: !!pol.manualOpen,
    serverDate: t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
  });
});

app.post('/api/me/leave', A.requireAuth, (req, res) => {
  const { dateFrom, dateTo, leaveType, reason } = req.body || {};
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Start and end dates are required.' });
  if (dateTo < dateFrom) return res.status(400).json({ error: 'End date cannot be before the start date.' });
  const type = ['SL', 'VL', 'EL'].indexOf(leaveType) >= 0 ? leaveType : 'VL';
  // Enforce the leave application window for employees (admins may file anytime).
  if (['superadmin', 'admin_payroll'].indexOf(req.user.role) < 0) {
    const pol = leavePolicyOf(getCompanyData());
    if (!leaveDateAllowed(dateFrom, type, pol) || !leaveDateAllowed(dateTo, type, pol)) {
      return res.status(400).json({ error: 'Leave filing for those dates is not open yet. ' +
        (type === 'VL' ? 'Next-month leave opens on day ' + (Number(pol.openDay) || 21) + ' of the current month.' :
          'Please pick eligible dates.') });
    }
  }
  db.prepare(
    `INSERT INTO leave_requests (user_id, employee_code, date_from, date_to, leave_type, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, req.user.employee_code, dateFrom, dateTo, type, reason || '');
  res.json({ ok: true });
});

// Own DTR for a period (read from company data).
app.get('/api/me/dtr/:periodId', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const emp = findEmpByCode(data, req.user.employee_code);
  const period = (data.periods || []).find(function (p) { return p.id === req.params.periodId; });
  if (!emp || !period) return res.json({ period: period || null, days: [] });
  const days = ((data.dtr[period.id] || {})[emp.id]) || [];
  res.json({ period: period, days: days });
});
// Submit own DTR for a period (writes into company data + records a submission).
app.post('/api/me/dtr/:periodId', A.requireAuth, (req, res) => {
  const { days } = req.body || {};
  if (!Array.isArray(days)) return res.status(400).json({ error: 'days must be an array.' });
  const data = getCompanyData();
  const emp = findEmpByCode(data, req.user.employee_code);
  const period = (data.periods || []).find(function (p) { return p.id === req.params.periodId; });
  if (!emp) return res.status(400).json({ error: 'No employee record is linked to your account yet.' });
  if (!period) return res.status(404).json({ error: 'Payroll period not found.' });
  if (period.status === 'finalized') return res.status(400).json({ error: 'That period is already finalized.' });
  data.dtr[period.id] = data.dtr[period.id] || {};
  data.dtr[period.id][emp.id] = days;
  saveCompanyData(data);
  db.prepare(
    `INSERT INTO dtr_submissions (user_id, employee_code, period_id, days_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, period_id) DO UPDATE SET days_json = excluded.days_json, created_at = datetime('now')`
  ).run(req.user.id, req.user.employee_code, period.id, JSON.stringify(days));
  res.json({ ok: true });
});

// Own payslips (finalized payroll results).
app.get('/api/me/payslips', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const emp = findEmpByCode(data, req.user.employee_code);
  const out = [];
  if (emp) {
    (data.periods || []).forEach(function (p) {
      var r = (data.payrolls[p.id] || {})[emp.id];
      if (r && p.status === 'finalized') out.push({ period: p, result: r });
    });
  }
  res.json({ payslips: out });
});
// List active periods (for the employee DTR/leave pickers).
app.get('/api/me/periods', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  res.json({ periods: (data.periods || []).map(function (p) {
    return { id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, status: p.status };
  }) });
});

/* only copy safe 201 fields from a sign-up profile into an employee record */
function sanitizeProfile(p) {
  const allow = ['firstName', 'middleName', 'lastName', 'birthDate', 'civilStatus', 'address',
    'contactNumber', 'email', 'sssNo', 'philhealthNo', 'pagibigNo', 'tin',
    'emergencyName', 'emergencyRelation', 'emergencyContact',
    'bankName', 'bankAccountName', 'bankAccountNumber', 'position', 'department', 'hireDate'];
  const out = {};
  allow.forEach(function (k) { if (p[k] != null) out[k] = p[k]; });
  return out;
}

/* ================= STATIC FRONTEND ================= */
// Reuse the offline app's compute engine + UI (single source of truth).
app.use('/shared', express.static(path.join(__dirname, '..', '..', 'assets')));
app.use(express.static(path.join(__dirname, '..', 'public')));
// SPA-ish fallbacks
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app', 'index.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'portal.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

/* ================= FIRST-RUN SUPERADMIN ================= */
function seedSuperadmin() {
  const email = process.env.SUPERADMIN_EMAIL;
  const pw = process.env.SUPERADMIN_PASSWORD;
  const existing = db.prepare('SELECT COUNT(*) c FROM users WHERE role = \'superadmin\'').get().c;
  if (existing > 0 || !email || !pw) return;
  db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, status)
     VALUES (?, ?, 'Super Admin', 'superadmin', 'active')`
  ).run(String(email).toLowerCase(), A.hashPassword(pw));
  console.log('Seeded Super Admin:', email);
}
seedSuperadmin();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('PH Payroll server listening on port ' + PORT));

module.exports = app;
