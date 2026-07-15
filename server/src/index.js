/* ==========================================================================
 * index.js — Express app: auth, company data, admin, employee self-service
 * ========================================================================== */
'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, emptyCompanyData } = require('./db');
const A = require('./auth');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(A.authenticate);

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
  db.prepare('UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(decision, req.user.id, req.params.id);
  res.json({ ok: true });
});

/* ================= EMPLOYEE SELF-SERVICE ================= */
app.get('/api/me/profile', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const emp = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;
  res.json({
    user: A.publicUser(req.user),
    profile: JSON.parse(req.user.profile_json || '{}'),
    employee: emp || null,
    company: data.meta.company
  });
});

app.get('/api/me/leave', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ requests: rows });
});
app.post('/api/me/leave', A.requireAuth, (req, res) => {
  const { dateFrom, dateTo, leaveType, reason } = req.body || {};
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Start and end dates are required.' });
  const type = ['SL', 'VL', 'EL'].indexOf(leaveType) >= 0 ? leaveType : 'VL';
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
