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
const engine = require('./payroll-engine');
const totp = require('./totp');

const app = express();
app.set('trust proxy', true); // behind Caddy/Nginx: honour X-Forwarded-Proto
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(A.authenticate);

// A user issued a temporary password must set their own before doing anything
// else: block all API calls (except checking who they are, logging out, and the
// change-password call itself) until they do.
app.use(function (req, res, next) {
  if (req.user && req.user.must_change_password && req.path.indexOf('/api/') === 0) {
    const allowed =
      (req.method === 'GET' && req.path === '/api/auth/me') ||
      (req.method === 'POST' && req.path === '/api/auth/logout') ||
      (req.method === 'POST' && req.path === '/api/me/change-password');
    if (!allowed) return res.status(403).json({ error: 'Please set a new password before continuing.', code: 'MUST_CHANGE_PASSWORD' });
  }
  next();
});

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

/* ---------- location scoping (per-location manager accounts) ----------
 * A user with a location_id sees and edits ONLY that location's slice of the
 * company document. Periods, settings (meta) and statutory tables are shared and
 * stay read-only for scoped users. Superadmins and unscoped admins see everything.
 */
function scopedEmpIdSet(data, locationId) {
  const ids = {};
  (data.employees || []).forEach(function (e) { if (e && e.locationId === locationId) ids[e.id] = true; });
  return ids;
}
// A read view of the company data limited to one location.
function scopeCompanyData(data, locationId) {
  const inLoc = scopedEmpIdSet(data, locationId);
  function filterMap(map) {
    const out = {};
    Object.keys(map || {}).forEach(function (pid) {
      const per = map[pid] || {}, kept = {};
      Object.keys(per).forEach(function (empId) { if (inLoc[empId]) kept[empId] = per[empId]; });
      out[pid] = kept;
    });
    return out;
  }
  const otA = {};
  Object.keys(data.otApprovals || {}).forEach(function (empId) { if (inLoc[empId]) otA[empId] = data.otApprovals[empId]; });
  return Object.assign({}, data, {
    employees: (data.employees || []).filter(function (e) { return inLoc[e.id]; }),
    allowances: (data.allowances || []).filter(function (a) { return inLoc[a.employeeId]; }),
    loans: (data.loans || []).filter(function (l) { return inLoc[l.employeeId]; }),
    dtr: filterMap(data.dtr),
    adjustments: filterMap(data.adjustments),
    payrolls: filterMap(data.payrolls),
    otApprovals: otA
  });
}
// Merge a scoped user's submitted (single-location) document back into the full
// stored document, so a scoped save only ever touches THEIR location. Periods,
// payrolls, settings and statutory config are never changed by a scoped user.
function mergeScopedCompanyData(stored, submitted, locationId) {
  const merged = JSON.parse(JSON.stringify(stored));
  // Force submitted employees to stay in this location (can't be moved out).
  const submittedEmps = (submitted.employees || []).map(function (e) { return Object.assign({}, e, { locationId: locationId }); });
  // Scope = employees that were in this location OR are in the submitted set.
  const scope = {};
  (stored.employees || []).forEach(function (e) { if (e.locationId === locationId) scope[e.id] = true; });
  submittedEmps.forEach(function (e) { if (e.id) scope[e.id] = true; });

  merged.employees = (stored.employees || []).filter(function (e) { return e.locationId !== locationId; }).concat(submittedEmps);
  function mergeByEmp(storedArr, submittedArr) {
    return (storedArr || []).filter(function (x) { return !scope[x.employeeId]; })
      .concat((submittedArr || []).filter(function (x) { return scope[x.employeeId]; }));
  }
  merged.allowances = mergeByEmp(stored.allowances, submitted.allowances);
  merged.loans = mergeByEmp(stored.loans, submitted.loans);
  function mergeMap(storedMap, submittedMap) {
    const out = {}, pids = {};
    Object.keys(storedMap || {}).forEach(function (p) { pids[p] = true; });
    Object.keys(submittedMap || {}).forEach(function (p) { pids[p] = true; });
    Object.keys(pids).forEach(function (pid) {
      const s = (storedMap && storedMap[pid]) || {}, b = (submittedMap && submittedMap[pid]) || {}, per = {};
      Object.keys(s).forEach(function (empId) { if (!scope[empId]) per[empId] = s[empId]; });
      Object.keys(b).forEach(function (empId) { if (scope[empId]) per[empId] = b[empId]; });
      out[pid] = per;
    });
    return out;
  }
  merged.dtr = mergeMap(stored.dtr, submitted.dtr);
  merged.adjustments = mergeMap(stored.adjustments, submitted.adjustments);
  const otA = {};
  Object.keys(stored.otApprovals || {}).forEach(function (empId) { if (!scope[empId]) otA[empId] = stored.otApprovals[empId]; });
  Object.keys(submitted.otApprovals || {}).forEach(function (empId) { if (scope[empId]) otA[empId] = submitted.otApprovals[empId]; });
  merged.otApprovals = otA;
  // Shared / central-only — never altered by a scoped save.
  merged.periods = stored.periods;
  merged.payrolls = stored.payrolls;
  merged.thirteenthMonth = stored.thirteenthMonth;
  merged.meta = stored.meta;
  merged.statutoryConfig = stored.statutoryConfig;
  return merged;
}
function locationNameOf(data, locationId) {
  const l = ((data.meta && data.meta.locations) || []).find(function (x) { return x.id === locationId; });
  return l ? l.name : '';
}
// For a location-scoped reviewer, keep only request rows whose employee_code
// belongs to their location. Unscoped reviewers (central) see everything.
function scopeRequestRows(req, rows) {
  const loc = req.user && req.user.location_id;
  if (!loc) return rows;
  const data = getCompanyData(); const byCode = {};
  (data.employees || []).forEach(function (e) { if (e.code) byCode[e.code] = e.locationId || null; });
  return rows.filter(function (r) { return byCode[r.employee_code] === loc; });
}
// Record an in-app notification for a user (best-effort; never throws to caller).
function notify(userId, type, title, body) {
  if (!userId) return;
  try {
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(userId, type, title, body || '');
  } catch (e) { console.error('notify failed', e.message); }
}
/* ---------- audit trail ---------- */
// Record who changed what and when (mutations only — never views).
function audit(req, action, entity, detail) {
  try {
    const u = req && req.user;
    db.prepare('INSERT INTO audit_log (user_id, user_email, role, action, entity, detail) VALUES (?,?,?,?,?,?)')
      .run(u ? u.id : null, u ? u.email : null, u ? u.role : null, action, entity, String(detail || '').slice(0, 500));
  } catch (e) { console.error('audit failed', e.message); }
}
// Human-readable diff of two company-data documents → [{action, entity, detail}].
function diffCompanyData(oldD, newD) {
  oldD = oldD || {}; newD = newD || {};
  const changes = [];
  function byId(arr) { const m = {}; (arr || []).forEach(function (x) { if (x && x.id) m[x.id] = x; }); return m; }
  function val(x) { return x == null ? '—' : (typeof x === 'object' ? JSON.stringify(x) : String(x)); }
  function diffList(entity, oldArr, newArr, labelFn, fields) {
    const o = byId(oldArr), n = byId(newArr);
    Object.keys(n).forEach(function (id) {
      if (!o[id]) { changes.push({ action: 'create', entity: entity, detail: 'Added ' + labelFn(n[id]) }); return; }
      const chg = [];
      fields.forEach(function (f) { if (val(o[id][f]) !== val(n[id][f])) chg.push(f + ': ' + val(o[id][f]) + ' → ' + val(n[id][f])); });
      if (chg.length) changes.push({ action: 'update', entity: entity, detail: 'Edited ' + labelFn(n[id]) + ' — ' + chg.join('; ') });
    });
    Object.keys(o).forEach(function (id) { if (!n[id]) changes.push({ action: 'delete', entity: entity, detail: 'Removed ' + labelFn(o[id]) }); });
  }
  const empL = function (e) { return (e.lastName || '') + ', ' + (e.firstName || '') + ' [' + (e.code || e.id) + ']'; };
  diffList('employee', oldD.employees, newD.employees, empL,
    ['code', 'lastName', 'firstName', 'basicSalary', 'employmentType', 'employmentStatus', 'active',
     'sssNo', 'philhealthNo', 'pagibigNo', 'tin', 'deductSSS', 'deductPhilHealth', 'deductPagIBIG',
     'schedTimeIn', 'schedTimeOut', 'leaveCreditsPerYear', 'leaveCreditsUsed', 'bankAccountNumber']);
  diffList('allowance', oldD.allowances, newD.allowances, function (a) { return (a.name || 'allowance') + ' [' + a.id + ']'; },
    ['employeeId', 'name', 'amount', 'type', 'taxable', 'basis']);
  diffList('loan', oldD.loans, newD.loans, function (l) { return (l.type || 'loan') + ' [' + l.id + ']'; },
    ['employeeId', 'type', 'principal', 'monthlyAmortization', 'perCutoffAmount', 'balance', 'active']);
  diffList('period', oldD.periods, newD.periods, function (p) { return (p.name || p.id); },
    ['name', 'startDate', 'endDate', 'payDate', 'status', 'frequency']);
  // Settings blocks
  const meta = function (d) { return d.meta || {}; };
  ['company', 'overtime', 'leavePolicy', 'thirteenthPolicy', 'nightDiff', 'contributionSchedule', 'locations'].forEach(function (k) {
    if (JSON.stringify(meta(oldD)[k]) !== JSON.stringify(meta(newD)[k]))
      changes.push({ action: 'update', entity: 'settings', detail: k + ' changed to ' + val(meta(newD)[k]) });
  });
  if (JSON.stringify(oldD.statutoryConfig) !== JSON.stringify(newD.statutoryConfig))
    changes.push({ action: 'update', entity: 'settings', detail: 'Government rate tables changed' });
  if (JSON.stringify(oldD.otApprovals) !== JSON.stringify(newD.otApprovals))
    changes.push({ action: 'update', entity: 'overtime', detail: 'Overtime authorizations updated' });
  // DTR + payroll results per period
  Object.keys(newD.dtr || {}).forEach(function (pid) {
    if (JSON.stringify((oldD.dtr || {})[pid]) !== JSON.stringify(newD.dtr[pid]))
      changes.push({ action: 'update', entity: 'DTR', detail: 'Time records updated for period ' + pid });
  });
  Object.keys(newD.payrolls || {}).forEach(function (pid) {
    if (JSON.stringify((oldD.payrolls || {})[pid]) !== JSON.stringify(newD.payrolls[pid]))
      changes.push({ action: 'update', entity: 'payroll', detail: 'Payroll results updated for period ' + pid });
  });
  return changes;
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
const ADVANCE_TYPES = { cash_advance: true, product_advance: true }; // cleared within the month

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
// Monthly basic salary (mirrors assets/js/payroll.js rates()).
function monthlyBasicOf(emp) {
  const factor = emp.dailyRateFactor || 313;
  if (emp.employmentType === 'daily') return round2((emp.basicSalary || 0) * factor / 12);
  if (emp.employmentType === 'hourly') return round2((emp.basicSalary || 0) * 8 * factor / 12);
  return emp.basicSalary || 0; // monthly
}
// Sum of an employee's outstanding (active) cash-advance loan balances.
function outstandingCashAdvance(data, emp) {
  return (data.loans || []).filter(function (l) {
    return l.employeeId === emp.id && l.active !== false &&
      (l.loanType === 'cash_advance' || /cash advance/i.test(l.type || ''));
  }).reduce(function (s, l) { return s + (l.balance || 0); }, 0);
}
// Pending (not yet approved) cash-advance request amounts for a user.
function pendingCashAdvanceAmount(userId) {
  const row = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM loan_requests WHERE user_id = ? AND loan_type = 'cash_advance' AND status = 'pending'").get(userId);
  return row ? row.t : 0;
}
// Cash-advance headroom for an employee: half of monthly basic, less what's used.
function cashAdvanceInfo(data, emp, userId) {
  const cap = round2(monthlyBasicOf(emp) / 2);
  const outstanding = round2(outstandingCashAdvance(data, emp));
  const pending = round2(pendingCashAdvanceAmount(userId));
  return { monthlyBasic: monthlyBasicOf(emp), cap: cap, outstanding: outstanding, pending: pending,
    available: round2(Math.max(0, cap - outstanding - pending)) };
}

/* ================= AUTOMATIC PAYROLL PERIODS & JOBS ================= */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function pad2i(n) { return (n < 10 ? '0' : '') + n; }
function isoYMD(y, m, d) { return y + '-' + pad2i(m) + '-' + pad2i(d); }
function isoOf(dt) { return isoYMD(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()); }
function lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); } // m = 1-12
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// The two cutoff periods for calendar month y/m (m = 1-12). When a location is
// given, the periods belong to that branch (own id/name) so each branch runs and
// finalizes payroll independently; otherwise they are shared (single-branch).
function periodsForMonth(y, m, loc) {
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  const pre = loc ? ('p_' + loc.id + '_' + y + '-' + pad2i(m)) : ('p_' + y + '-' + pad2i(m));
  const suffix = loc ? ' [' + loc.name + ']' : '';
  const payD = Math.min(30, lastDayOfMonth(y, m)); // last day when the month has no 30th (Feb)
  const base = { frequency: 'semi-monthly', status: 'open', auto: true };
  if (loc) { base.locationId = loc.id; }
  const p1 = Object.assign({}, base, { id: pre + '_15', cutoff: '15th',
    name: MONTHS[m - 1] + ' ' + y + ' — 15th pay' + suffix,
    startDate: isoYMD(py, pm, 26), endDate: isoYMD(y, m, 10), payDate: isoYMD(y, m, 15) });
  const p2 = Object.assign({}, base, { id: pre + '_30', cutoff: '30th',
    name: MONTHS[m - 1] + ' ' + y + ' — 30th pay' + suffix,
    startDate: isoYMD(y, m, 11), endDate: isoYMD(y, m, 25), payDate: isoYMD(y, m, payD) });
  return [p1, p2];
}
// Ensure the current and next month's cutoff periods exist (idempotent by id).
// With locations configured, generate one set per location; otherwise a shared set.
function ensurePeriods(data, today) {
  data.periods = data.periods || [];
  const have = {}; data.periods.forEach(function (p) { have[p.id] = true; });
  const y = today.getFullYear(), m = today.getMonth() + 1;
  const months = [[y, m], [m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1]];
  const locs = (data.meta && data.meta.locations) || [];
  const targets = locs.length ? locs : [null];
  let changed = false;
  months.forEach(function (ym) {
    targets.forEach(function (loc) {
      periodsForMonth(ym[0], ym[1], loc).forEach(function (p) { if (!have[p.id]) { data.periods.push(p); changed = true; } });
    });
  });
  return changed;
}
function activeEmployeeUsers() {
  return db.prepare("SELECT * FROM users WHERE status = 'active' AND (role = 'employee' OR role = 'supervisor') AND employee_code IS NOT NULL").all();
}
function adminUsers() {
  return db.prepare("SELECT * FROM users WHERE status = 'active' AND (role = 'superadmin' OR role = 'admin_payroll')").all();
}
function notifyAll(users, type, title, body) { users.forEach(function (u) { notify(u.id, type, title, body); }); }

// Daily maintenance: create upcoming periods, send cutoff reminders, and
// auto-compute a draft payroll once a cutoff has ended (admin reviews & finalizes).
function runDailyJobs() {
  try {
    const data = getCompanyData();
    const today = todayLocal();
    let changed = ensurePeriods(data, today);
    (data.periods || []).forEach(function (p) {
      if (p.status === 'finalized') return;
      const end = parseDateLocal(p.endDate);
      const dayBefore = new Date(end); dayBefore.setDate(end.getDate() - 1);
      // 1) Reminder the day before the cutoff closes (once).
      if (!p.reminderSent && sameDay(today, dayBefore)) {
        notifyAll(activeEmployeeUsers(), 'cutoff', 'Cutoff closes tomorrow',
          'The cutoff for ' + p.name + ' closes on ' + p.endDate + '. File any leave or overtime now — anything after that is credited to the next cutoff.');
        p.reminderSent = true; changed = true;
      }
      // 2) Auto-compute a draft payroll once the cutoff has ended (once) — but
      // ONLY when DTR has actually been uploaded for this period. With no DTR
      // there is nothing to base a payroll on, so no draft is generated.
      if (!p.autoComputed && today > end && periodHasDtr(data, p.id)) {
        try {
          const results = engine.computePeriod(data, p);
          data.payrolls = data.payrolls || {};
          data.payrolls[p.id] = results;
          p.autoComputed = true; p.autoComputedAt = isoOf(today);
          notifyAll(adminUsers(), 'payroll', 'Draft payroll ready',
            'A draft payroll for ' + p.name + ' has been computed and is ready to review and finalize (pay date ' + p.payDate + '). Upload the latest DTR first, then finalize.');
          changed = true;
        } catch (e) { console.error('auto payroll failed for ' + p.id, e.message); }
      }
    });
    if (changed) saveCompanyData(data);
  } catch (e) { console.error('runDailyJobs failed', e.message); }
}
// The next chronological non-finalized period after a given one (for OT carry-over).
function nextOpenPeriod(data, afterPeriod) {
  return (data.periods || [])
    .filter(function (p) { return p.status !== 'finalized' && p.startDate > afterPeriod.endDate; })
    .sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; })[0] || null;
}
function periodForDate(data, dateStr) {
  return (data.periods || []).find(function (p) { return dateStr >= p.startDate && dateStr <= p.endDate; }) || null;
}
// True when at least one employee has DTR rows uploaded for this period.
function periodHasDtr(data, pid) {
  const m = (data.dtr || {})[pid];
  if (!m) return false;
  return Object.keys(m).some(function (empId) { return Array.isArray(m[empId]) && m[empId].length > 0; });
}

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
// Effective shift for an employee on a specific date. A per-weekday entry in
// emp.weekSchedule overrides the base shift field-by-field; blanks fall back.
function schedForDate(emp, dateStr) {
  emp = emp || {};
  const base = { in: emp.schedTimeIn || '', out: emp.schedTimeOut || '',
    brk: emp.schedBreakMins != null ? emp.schedBreakMins : 60, off: false };
  const d = parseDateLocal(dateStr);
  if (isNaN(d.getTime()) || !emp.weekSchedule) return base;
  const wd = d.getDay();
  const ws = emp.weekSchedule[wd] || emp.weekSchedule[String(wd)];
  if (!ws) return base;
  const has = (x) => x != null && String(x).trim() !== '';
  return {
    in: has(ws.in) ? ws.in : base.in,
    out: has(ws.out) ? ws.out : base.out,
    brk: has(ws.brk) ? (parseInt(ws.brk, 10) || 0) : base.brk,
    off: !!ws.off
  };
}
// Lateness (minutes) that day, from the employee's DTR punch for the date.
function lateForDate(data, emp, dateStr) {
  const schedIn = hmToMin(schedForDate(emp, dateStr).in);
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
//  kind 'after'  — post-shift OT, timeVal = end time (work beyond shift end)
//  kind 'before' — pre-shift OT,  timeVal = early time-in (before shift start)
function computeFiledOT(data, emp, dateStr, kind, timeVal) {
  const rules = (data.meta && data.meta.overtime) || {};
  const sched = schedForDate(emp, dateStr);
  if (kind === 'before') {
    const schedIn = hmToMin(sched.in);
    const startMin = hmToMin(timeVal);
    if (schedIn == null || startMin == null) return null;
    const preRaw = Math.max(0, schedIn - startMin);
    return { otRaw: preRaw, otMinutes: applyOtRulesSrv(preRaw, rules, 0), lateMinutes: 0 };
  }
  const schedOut = hmToMin(sched.out);
  const endMin = hmToMin(timeVal);
  if (schedOut == null || endMin == null) return null;
  const endN = endMin < schedOut ? endMin + 1440 : endMin; // crossed midnight
  const otRaw = Math.max(0, endN - schedOut);
  const late = lateForDate(data, emp, dateStr);
  return { otRaw: otRaw, otMinutes: applyOtRulesSrv(otRaw, rules, late), lateMinutes: late };
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
  // Sick / emergency / unpaid-authorized are for unplannable events — may be backdated.
  if (md <= -1) return type === 'SL' || type === 'EL' || type === 'UAL';
  if (md === 0) return true;                           // current month
  if (md === 1) return manualOpen || t0.getDate() >= openDay;
  return manualOpen;                                   // 2+ months ahead
}
// Inclusive whole-day count between two ISO dates (for credit accounting).
function leaveDayCount(from, to) {
  const a = parseDateLocal(from), b = parseDateLocal(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
// Remaining paid-leave credits for an employee this calendar year. Starts from the
// 201 record (annual entitlement less what admin has marked used), then also nets out
// credited-leave days the employee has already filed this year (pending or approved)
// so they can't queue more pending paid leave than they hold. Unpaid Authorized Leave (UAL)
// never touches credits.
function leaveCreditsRemaining(emp, userId) {
  const perYear = Number(emp && emp.leaveCreditsPerYear) || 0;
  const usedField = Number(emp && emp.leaveCreditsUsed) || 0;
  const year = todayLocal().getFullYear();
  let filed = 0;
  try {
    const rows = db.prepare(
      "SELECT date_from, date_to FROM leave_requests WHERE user_id = ? " +
      "AND leave_type IN ('VL','SL','EL') AND status = 'pending' " +
      "AND substr(date_from,1,4) = ?"
    ).all(userId, String(year));
    rows.forEach(function (r) { filed += leaveDayCount(r.date_from, r.date_to); });
  } catch (e) { /* table shape guard */ }
  return Math.max(0, perYear - usedField - filed);
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
  res.json({ user: A.publicUser(user), mustChangePassword: !!user.must_change_password });
});

app.post('/api/auth/logout', (req, res) => { A.clearToken(res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: A.publicUser(req.user) }));

// Set a new password (voluntary change, or the forced change after an admin
// issued a temporary one). Verifies the current password and clears the flag.
app.post('/api/me/change-password', A.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'Your new password must be at least 6 characters.' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u || !A.verifyPassword(currentPassword || '', u.password_hash)) return res.status(400).json({ error: 'Your current (temporary) password is incorrect.' });
  if (A.verifyPassword(newPassword, u.password_hash)) return res.status(400).json({ error: 'Please choose a new password that is different from the temporary one.' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(A.hashPassword(newPassword), u.id);
  audit({ user: { id: u.id, email: u.email, role: u.role } }, 'update', 'user', 'Set a new password' + (u.must_change_password ? ' (required after admin reset)' : ''));
  res.json({ ok: true });
});

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

// Self-service password reset using the authenticator app (no email needed).
// Requires the user to have enabled 2FA beforehand. A single generic error is
// returned for a bad email or code so the endpoint can't be used to probe accounts.
app.post('/api/auth/reset-2fa', (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase();
  const { code, password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const bad = function () { return res.status(400).json({ error: 'Invalid email or authentication code.' }); };
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || user.status === 'disabled' || !user.totp_enabled || !user.totp_secret) return bad();
  if (!totp.verifyToken(code, user.totp_secret)) return bad();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(password), user.id);
  audit({ user: { id: user.id, email: user.email, role: user.role } }, 'update', 'user', 'Password reset via authenticator (2FA)');
  res.json({ ok: true });
});

// Whether the signed-in user has the authenticator app enabled.
app.get('/api/me/2fa/status', A.requireAuth, (req, res) => {
  res.json({ enabled: !!req.user.totp_enabled });
});

// Begin enrolment: generate (or regenerate) a pending secret and return the
// setup key + otpauth URI. Not active until confirmed with a valid code.
app.post('/api/me/2fa/setup', A.requireAuth, (req, res) => {
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  res.json({ secret: secret, otpauthUrl: totp.otpauthURL(secret, req.user.email, 'HDS Trading Payroll') });
});

// Confirm enrolment: verify a code against the pending secret and switch 2FA on.
app.post('/api/me/2fa/verify', A.requireAuth, (req, res) => {
  const code = (req.body && req.body.code) || '';
  const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!row || !row.totp_secret) return res.status(400).json({ error: 'Start the setup first.' });
  if (!totp.verifyToken(code, row.totp_secret)) return res.status(400).json({ error: 'That code is incorrect. Check your authenticator app and try again.' });
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  audit(req, 'update', 'user', 'Enabled authenticator (2FA)');
  res.json({ ok: true });
});

// Turn 2FA off (requires a current code to confirm it's really the owner).
app.post('/api/me/2fa/disable', A.requireAuth, (req, res) => {
  const code = (req.body && req.body.code) || '';
  if (req.user.totp_enabled && !totp.verifyToken(code, req.user.totp_secret)) {
    return res.status(400).json({ error: 'Enter a current code from your authenticator to turn 2FA off.' });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
  audit(req, 'update', 'user', 'Disabled authenticator (2FA)');
  res.json({ ok: true });
});

/* ================= COMPANY DATA (admin) ================= */
// Auditors (3rd-party, read-only) may load company data to view reports only.
app.get('/api/company', A.requireRole('superadmin', 'admin_payroll', 'finance', 'auditor'), (req, res) => {
  const row = getCompany();
  const full = JSON.parse(row.data_json);
  const loc = req.user.location_id || null;
  const out = { name: row.name, version: row.data_version, data: loc ? scopeCompanyData(full, loc) : full, role: req.user.role };
  if (loc) out.scope = { locationId: loc, locationName: locationNameOf(full, loc) };
  res.json(out);
});
// Only superadmin & payroll admins may write the full company data. A user scoped
// to a location has their submission merged so it only ever touches THEIR branch.
app.put('/api/company', A.requireRole('superadmin', 'admin_payroll'), (req, res) => {
  const { data, version } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Missing data.' });
  const before = getCompanyData(); // capture prior state for the audit diff
  const loc = req.user.location_id || null;
  try {
    const toSave = loc ? mergeScopedCompanyData(before, data, loc) : data;
    const v = saveCompanyData(toSave, version);
    // Log each meaningful change (who/what/when) for the superadmin history.
    const changes = diffCompanyData(before, toSave).slice(0, 60);
    changes.forEach(function (c) { audit(req, c.action, c.entity, c.detail + (loc ? ' [' + locationNameOf(before, loc) + ']' : '')); });
    res.json({ ok: true, version: v });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

/* ================= ADMIN: users & leave ================= */
const adminMgmt = A.requireRole('superadmin', 'admin_payroll');
// Supervisors can review & decide leave / overtime / product-advance requests
// and view employees' DTR — but not touch payroll, users or company settings.
const canReview = A.requireRole('superadmin', 'admin_payroll', 'finance', 'supervisor');
const canDecide = A.requireRole('superadmin', 'admin_payroll', 'supervisor');
// Managing user accounts is a central function — a location-scoped admin cannot.
function requireUnscoped(req, res, next) {
  if (req.user && req.user.location_id) return res.status(403).json({ error: 'Location managers cannot manage user accounts. Ask a central administrator.' });
  next();
}

app.get('/api/admin/users', adminMgmt, requireUnscoped, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json({ users: users.map(function (u) {
    return Object.assign(A.publicUser(u), { profile: JSON.parse(u.profile_json || '{}'), createdAt: u.created_at });
  }) });
});

// Approve / activate a user, set role, and link (or create) their employee record.
app.post('/api/admin/users/:id/approve', adminMgmt, requireUnscoped, (req, res) => {
  const { role, employeeCode, createEmployee, locationId } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newRole = A.ROLES.indexOf(role) >= 0 ? role : 'employee';
  let code = employeeCode || user.employee_code || null;

  // Optionally create an employee (201) record in company data from the sign-up profile.
  // Supervisors are employees too, so they also get a 201.
  if (createEmployee && (newRole === 'employee' || newRole === 'supervisor')) {
    const data = getCompanyData();
    const profile = JSON.parse(user.profile_json || '{}');
    code = code || profile.code || ('EMP-' + String(user.id).padStart(4, '0'));
    if (!findEmpByCode(data, code)) {
      data.employees.push(Object.assign({
        id: 'emp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        code: code, employmentType: 'monthly', dailyRateFactor: 313, workDaysPerWeek: 6, restDay: 0,
        employmentStatus: 'probationary', leaveCreditsPerYear: 0, leaveCreditsUsed: 0,
        schedTimeIn: '08:00', schedTimeOut: '17:00', schedBreakMins: 60,
        contributionBasis: 'basic', active: true,
        locationId: locationId || null
      }, sanitizeProfile(profile), { code: code }));
      saveCompanyData(data);
    }
  }
  // Superadmins are never location-scoped; everyone else may be tied to a branch.
  const loc = (newRole === 'superadmin') ? null : (locationId || null);
  db.prepare('UPDATE users SET status = \'active\', role = ?, employee_code = ?, location_id = ? WHERE id = ?')
    .run(newRole, code, loc, user.id);
  audit(req, 'update', 'user', 'Approved ' + user.email + ' as ' + newRole + (code ? ' (' + code + ')' : '') + (loc ? ' @ ' + locationNameOf(getCompanyData(), loc) : ''));
  res.json({ ok: true });
});

// Set (or clear) a user's location scope. Superadmins cannot be scoped.
app.post('/api/admin/users/:id/location', adminMgmt, requireUnscoped, (req, res) => {
  const { locationId } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.role === 'superadmin' && locationId) return res.status(400).json({ error: 'A Super Admin cannot be limited to a single location.' });
  const loc = locationId || null;
  if (loc && !locationNameOf(getCompanyData(), loc)) return res.status(400).json({ error: 'Unknown location.' });
  db.prepare('UPDATE users SET location_id = ? WHERE id = ?').run(loc, user.id);
  audit(req, 'update', 'user', 'Set ' + user.email + ' location to ' + (loc ? locationNameOf(getCompanyData(), loc) : 'All locations'));
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/role', adminMgmt, requireUnscoped, (req, res) => {
  const { role } = req.body || {};
  if (A.ROLES.indexOf(role) < 0) return res.status(400).json({ error: 'Invalid role.' });
  // Guard: never leave the system without a superadmin.
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (target && target.role === 'superadmin' && role !== 'superadmin') {
    const supers = db.prepare('SELECT COUNT(*) c FROM users WHERE role = \'superadmin\' AND status = \'active\'').get().c;
    if (supers <= 1) return res.status(400).json({ error: 'There must be at least one Super Admin.' });
  }
  // Promoting to Super Admin clears any location scope (superadmins see all).
  if (role === 'superadmin') db.prepare('UPDATE users SET role = ?, location_id = NULL WHERE id = ?').run(role, req.params.id);
  else db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  audit(req, 'update', 'user', 'Role of ' + (target ? target.email : req.params.id) + ' → ' + role);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/status', adminMgmt, requireUnscoped, (req, res) => {
  const { status } = req.body || {};
  if (['active', 'disabled', 'pending'].indexOf(status) < 0) return res.status(400).json({ error: 'Invalid status.' });
  const tgt = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  audit(req, 'update', 'user', 'Status of ' + (tgt ? tgt.email : req.params.id) + ' → ' + status);
  res.json({ ok: true });
});

// Read-only leave feed for the whole-month Leave Calendar view (all admin-app
// roles, including auditors and finance). Location-scoped like the other feeds.
app.get('/api/leave-calendar', A.requireRole('superadmin', 'admin_payroll', 'finance', 'auditor', 'supervisor'), (req, res) => {
  const rows = db.prepare(
    `SELECT lr.employee_code, lr.date_from, lr.date_to, lr.leave_type, lr.status, lr.reason, u.full_name, u.email
     FROM leave_requests lr JOIN users u ON u.id = lr.user_id
     WHERE lr.status != 'rejected' ORDER BY lr.date_from`
  ).all();
  res.json({ requests: scopeRequestRows(req, rows) });
});

app.get('/api/admin/leave-requests', canReview, (req, res) => {
  const rows = db.prepare(
    `SELECT lr.*, u.full_name, u.email FROM leave_requests lr JOIN users u ON u.id = lr.user_id
     ORDER BY (lr.status = 'pending') DESC, lr.created_at DESC`
  ).all();
  res.json({ requests: scopeRequestRows(req, rows) });
});

app.post('/api/admin/leave-requests/:id', canDecide, (req, res) => {
  const { decision } = req.body || {}; // 'approved' | 'rejected'
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const row = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Leave request not found.' });
  db.prepare('UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(decision, req.user.id, req.params.id);
  notify(row.user_id, 'leave', 'Leave ' + decision,
    row.leave_type + ' leave for ' + row.date_from + (row.date_to !== row.date_from ? ' → ' + row.date_to : '') + ' was ' + decision + '.');
  audit(req, decision, 'leave request', (row.employee_code || ('user ' + row.user_id)) + ' ' + row.leave_type + ' ' + row.date_from + '→' + row.date_to + ' ' + decision);
  res.json({ ok: true });
});

/* ---- overtime authorization (admin review) ---- */
app.get('/api/admin/overtime-requests', canReview, (req, res) => {
  const rows = db.prepare(
    `SELECT o.*, u.full_name, u.email FROM overtime_requests o JOIN users u ON u.id = o.user_id
     ORDER BY (o.status = 'pending') DESC, o.ot_date DESC, o.created_at DESC`
  ).all();
  res.json({ requests: scopeRequestRows(req, rows).map(function (r) { return Object.assign(r, { reason_label: OT_REASONS[r.reason] || r.reason }); }) });
});
app.post('/api/admin/overtime-requests/:id', canDecide, (req, res) => {
  const { decision } = req.body || {};
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const row = db.prepare('SELECT * FROM overtime_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Overtime request not found.' });
  db.prepare('UPDATE overtime_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(decision, req.user.id, row.id);

  // Reflect the decision in company data so payroll gates OT on it. Keyed by the
  // employee's id, then date, then kind (before = pre-shift, after = post-shift).
  let companyChanged = false;
  const data = getCompanyData();
  const applicant = db.prepare('SELECT employee_code FROM users WHERE id = ?').get(row.user_id);
  const emp = findEmpByCode(data, row.employee_code || (applicant && applicant.employee_code));
  let carriedTo = null;
  if (emp) {
    data.otApprovals = data.otApprovals || {};
    const byDate = data.otApprovals[emp.id] = data.otApprovals[emp.id] || {};
    const day = byDate[row.ot_date] = byDate[row.ot_date] || {};
    day[row.ot_kind === 'before' ? 'before' : 'after'] = (decision === 'approved');
    if (!day.before && !day.after) delete byDate[row.ot_date];

    // Carry-over: if the OT's own cutoff is already finalized, the pay can't go
    // into that (locked) period — credit it to the next open cutoff instead.
    if (decision === 'approved') {
      const otPeriod = periodForDate(data, row.ot_date);
      if (otPeriod && otPeriod.status === 'finalized') {
        const dtrDay = (((data.dtr || {})[otPeriod.id] || {})[emp.id] || []).find(function (d) { return d.date === row.ot_date; });
        const next = nextOpenPeriod(data, otPeriod);
        if (dtrDay && next) {
          const ot = engine.overtimeForDay(data, emp, dtrDay);
          if (ot.amount > 0) {
            data.adjustments = data.adjustments || {};
            data.adjustments[next.id] = data.adjustments[next.id] || {};
            const arr = data.adjustments[next.id][emp.id] = data.adjustments[next.id][emp.id] || [];
            arr.push({ name: 'Overtime carried from ' + row.ot_date, amount: ot.amount, taxable: true, type: 'overtime', carriedFrom: row.ot_date });
            carriedTo = next;
          }
        }
      }
    }
    try { saveCompanyData(data); companyChanged = true; } catch (e) { /* leave status set; payroll gating just won't see it yet */ }
  }
  const hrs = (row.ot_minutes / 60).toFixed(2);
  const kindLabel = row.ot_kind === 'before' ? 'pre-shift ' : '';
  const carryNote = carriedTo ? ' Its cutoff was already finalized, so it will be paid on the next cutoff (' + carriedTo.name + ').' : '';
  notify(row.user_id, 'overtime', 'Overtime ' + decision,
    'Your ' + kindLabel + 'overtime for ' + row.ot_date + ' (' + hrs + ' hr' + (hrs === '1.00' ? '' : 's') + ') was ' + decision + '.' + carryNote);
  audit(req, decision, 'overtime request', (row.employee_code || ('user ' + row.user_id)) + ' ' + kindLabel + 'OT ' + row.ot_date + ' (' + hrs + 'h) ' + decision + (carriedTo ? ' → carried to ' + carriedTo.name : ''));
  res.json({ ok: true, companyChanged: companyChanged, carriedTo: carriedTo ? carriedTo.name : null });
});

/* ---- loan applications (admin review) ---- */
app.get('/api/admin/loan-requests', canReview, (req, res) => {
  let rows = db.prepare(
    `SELECT lr.*, u.full_name, u.email FROM loan_requests lr JOIN users u ON u.id = lr.user_id
     ORDER BY (lr.status = 'pending') DESC, lr.created_at DESC`
  ).all();
  // Supervisors only handle product advances.
  if (req.user.role === 'supervisor') rows = rows.filter(function (r) { return r.loan_type === 'product_advance'; });
  res.json({ requests: scopeRequestRows(req, rows).map(function (r) { return Object.assign(r, { loan_type_label: LOAN_TYPES[r.loan_type] || r.loan_type }); }) });
});

// Approve (creating a payroll loan that is auto-deducted) or reject a loan request.
app.post('/api/admin/loan-requests/:id', canDecide, (req, res) => {
  const { decision, monthlyAmortization } = req.body || {};
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const reqRow = db.prepare('SELECT * FROM loan_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'Loan request not found.' });
  // Supervisors may only decide product advances (not cash advances or gov't loans).
  if (req.user.role === 'supervisor' && reqRow.loan_type !== 'product_advance')
    return res.status(403).json({ error: 'Supervisors can only approve product advances.' });
  if (reqRow.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });

  if (decision === 'rejected') {
    db.prepare('UPDATE loan_requests SET status = \'rejected\', reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
      .run(req.user.id, reqRow.id);
    notify(reqRow.user_id, 'loan', 'Loan application rejected',
      (LOAN_TYPES[reqRow.loan_type] || 'Loan') + ' for ₱' + Number(reqRow.amount).toLocaleString('en-PH') + ' was not approved.');
    audit(req, 'reject', 'loan request', (reqRow.employee_code || ('user ' + reqRow.user_id)) + ' ' + (LOAN_TYPES[reqRow.loan_type] || reqRow.loan_type) + ' ₱' + reqRow.amount + ' rejected');
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
  const loanId = 'loan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  data.loans = data.loans || [];
  const loan = {
    id: loanId, employeeId: emp.id, loanType: reqRow.loan_type, type: LOAN_TYPES[reqRow.loan_type] || 'Loan',
    principal: reqRow.amount, balance: reqRow.amount, active: true, source: 'application', requestId: reqRow.id
  };
  let deductDesc;
  if (ADVANCE_TYPES[reqRow.loan_type]) {
    // Advance: cleared within the month — a fixed amount per cutoff over 1 or 2 cutoffs.
    const cutoffs = Math.min(2, Math.max(1, reqRow.installments || 1));
    const perCutoff = Number(monthlyAmortization) > 0 ? round2(monthlyAmortization) : round2(reqRow.amount / cutoffs);
    loan.perCutoffAmount = perCutoff;
    loan.monthlyAmortization = reqRow.amount;
    loan.installmentsPlanned = cutoffs;
    deductDesc = '₱' + perCutoff.toLocaleString('en-PH') + ' per cutoff over ' + cutoffs + ' cutoff' + (cutoffs > 1 ? 's' : '');
  } else {
    const perMonth = Number(monthlyAmortization) > 0 ? round2(monthlyAmortization) : round2(reqRow.amount / Math.max(1, reqRow.installments));
    loan.monthlyAmortization = perMonth;
    deductDesc = '₱' + perMonth.toLocaleString('en-PH') + ' per month';
  }
  data.loans.push(loan);
  let version;
  try { version = saveCompanyData(data); }
  catch (e) { return res.status(e.code === 'CONFLICT' ? 409 : 500).json({ error: e.message }); }
  db.prepare('UPDATE loan_requests SET status = \'approved\', loan_id = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(loanId, req.user.id, reqRow.id);
  notify(reqRow.user_id, 'loan', 'Loan application approved',
    (LOAN_TYPES[reqRow.loan_type] || 'Loan') + ' for ₱' + Number(reqRow.amount).toLocaleString('en-PH') +
    ' approved — ' + deductDesc + '.');
  audit(req, 'approve', 'loan request', (reqRow.employee_code || ('user ' + reqRow.user_id)) + ' ' + (LOAN_TYPES[reqRow.loan_type] || reqRow.loan_type) + ' ₱' + reqRow.amount + ' approved (' + deductDesc + ')');
  res.json({ ok: true, loanId: loanId, companyVersion: version });
});

/* ---- 201 change requests (bank / government IDs — admin review) ---- */
const canDecide201 = A.requireRole('superadmin', 'admin_payroll');
const PCR_LABELS = { bankName: 'Bank', bankAccountName: 'Account Name', bankAccountNumber: 'Account No.',
  sssNo: 'SSS No.', philhealthNo: 'PhilHealth No.', pagibigNo: 'Pag-IBIG No.', tin: 'TIN' };
app.get('/api/admin/profile-requests', canDecide201, (req, res) => {
  const data = getCompanyData();
  let rows = db.prepare(
    `SELECT pcr.*, u.full_name, u.email FROM profile_change_requests pcr JOIN users u ON u.id = pcr.user_id
     ORDER BY (pcr.status = 'pending') DESC, pcr.created_at DESC`
  ).all();
  rows = scopeRequestRows(req, rows); // narrow to the reviewer's branch when scoped
  res.json({ requests: rows.map(function (r) {
    const emp = findEmpByCode(data, r.employee_code) || {};
    const fields = JSON.parse(r.fields_json || '{}');
    const changes = Object.keys(fields).map(function (f) {
      return { field: f, label: PCR_LABELS[f] || f, from: emp[f] || '', to: fields[f] };
    });
    return { id: r.id, employee_code: r.employee_code, full_name: r.full_name, email: r.email,
      status: r.status, created_at: r.created_at, changes: changes };
  }) });
});
app.post('/api/admin/profile-requests/:id', canDecide201, (req, res) => {
  const { decision } = req.body || {};
  if (['approved', 'rejected'].indexOf(decision) < 0) return res.status(400).json({ error: 'Invalid decision.' });
  const row = db.prepare('SELECT * FROM profile_change_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });
  const data = getCompanyData();
  const emp = findEmpByCode(data, row.employee_code);
  // A location-scoped reviewer may only decide their own branch's requests.
  if (req.user.location_id && (!emp || (emp.locationId || null) !== req.user.location_id)) {
    return res.status(403).json({ error: 'Not allowed for this location.' });
  }
  const fields = JSON.parse(row.fields_json || '{}');
  if (decision === 'approved') {
    if (!emp) return res.status(400).json({ error: 'No 201 record is linked to this employee.' });
    Object.keys(fields).forEach(function (f) { if (APPROVAL_201.indexOf(f) >= 0) emp[f] = fields[f]; });
    try { saveCompanyData(data); }
    catch (e) { return res.status(e.code === 'CONFLICT' ? 409 : 500).json({ error: e.message }); }
  }
  db.prepare("UPDATE profile_change_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(decision, req.user.id, row.id);
  notify(row.user_id, 'profile', 'Bank / government-ID change ' + decision,
    'Your requested change to ' + Object.keys(fields).map(function (f) { return PCR_LABELS[f] || f; }).join(', ') + ' was ' + decision + '.');
  audit(req, decision, 'profile change', (row.employee_code || ('user ' + row.user_id)) + ' bank/gov-ID change ' + decision + ' (' + Object.keys(fields).join(', ') + ')');
  res.json({ ok: true });
});

/* ================= EXTERNAL INTEGRATIONS =================
 * Machine-to-machine endpoints for sibling apps (e.g. the inventory system).
 * Authenticated with a shared secret (INTEGRATION_API_KEY) rather than a user
 * login, and matched to payroll by the employee CODE (never by name).
 */
function integrationAuth(req, res, next) {
  const key = process.env.INTEGRATION_API_KEY;
  if (!key) return res.status(503).json({ error: 'Integration is not enabled on the payroll server (INTEGRATION_API_KEY is not set).' });
  const provided = req.get('X-Integration-Key') || (req.body && req.body.apiKey) || '';
  // Length-guarded compare; both sides are short shared secrets.
  if (!provided || provided.length !== key.length || provided !== key) {
    return res.status(401).json({ error: 'Invalid integration key.' });
  }
  next();
}

// Look up active employees (code + name) so the inventory app can pick/validate
// a payroll employee code. Read-only.
app.get('/api/integrations/employees', integrationAuth, (req, res) => {
  const data = getCompanyData();
  const q = String(req.query.code || '').trim();
  let list = (data.employees || []).filter(function (e) { return e.active !== false; });
  if (q) list = list.filter(function (e) { return e.code === q; });
  res.json({ employees: list.map(function (e) {
    return { code: e.code, name: (e.lastName || '') + ', ' + (e.firstName || ''), id: e.id };
  }) });
});

// Inventory → payroll: record a staff sales order as a Product Advance. Applied
// directly (no approval step), deducted over 1–2 cutoffs within the month.
// Idempotent on orderRef so re-sends don't double-charge.
app.post('/api/integrations/product-advance', integrationAuth, (req, res) => {
  const { employeeCode, amount, reference, orderRef, cutoffs } = req.body || {};
  if (!employeeCode) return res.status(400).json({ error: 'employeeCode is required.' });
  const amt = round2(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'A positive amount is required.' });

  const data = getCompanyData();
  const emp = findEmpByCode(data, String(employeeCode).trim());
  if (!emp) return res.status(404).json({ error: 'No employee with code "' + employeeCode + '" exists in payroll.', code: 'EMPLOYEE_NOT_FOUND' });

  data.loans = data.loans || [];
  // Idempotency: the same inventory order already posted → return the existing one.
  if (orderRef != null && String(orderRef).trim() !== '') {
    const dup = data.loans.find(function (l) { return l.source === 'inventory' && l.sourceOrderRef === String(orderRef); });
    if (dup) return res.json({ ok: true, duplicate: true, loanId: dup.id, employeeId: emp.id });
  }

  const cuts = Math.min(2, Math.max(1, parseInt(cutoffs, 10) || 1));
  const perCutoff = round2(amt / cuts);
  const loanId = 'loan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const loan = {
    id: loanId, employeeId: emp.id, loanType: 'product_advance', type: 'Product Advance',
    principal: amt, balance: amt, active: true,
    perCutoffAmount: perCutoff, monthlyAmortization: amt, installmentsPlanned: cuts,
    reference: reference ? String(reference).slice(0, 200) : ('Inventory order ' + (orderRef || '')),
    source: 'inventory', sourceOrderRef: (orderRef != null ? String(orderRef) : null)
  };
  data.loans.push(loan);
  let version;
  try { version = saveCompanyData(data); }
  catch (e) { return res.status(e.code === 'CONFLICT' ? 409 : 500).json({ error: e.message }); }

  const deductDesc = '₱' + perCutoff.toLocaleString('en-PH') + ' per cutoff over ' + cuts + ' cutoff' + (cuts > 1 ? 's' : '');
  audit({ user: { id: null, email: 'inventory-integration', role: 'system' } }, 'create', 'loan',
    'Product Advance ₱' + amt + ' for ' + emp.code + ' from inventory order ' + (orderRef || '(none)') + ' — ' + deductDesc);
  const linked = db.prepare('SELECT id FROM users WHERE employee_code = ?').get(emp.code);
  if (linked) notify(linked.id, 'loan', 'Product advance recorded',
    'A product advance of ₱' + amt.toLocaleString('en-PH') + ' (' + (reference || ('order ' + orderRef)) + ') was added and will be deducted ' + deductDesc + '.');
  res.json({ ok: true, loanId: loanId, employeeId: emp.id, perCutoffAmount: perCutoff, cutoffs: cuts, companyVersion: version });
});

// Inventory → payroll: credit back a product advance when goods are physically
// returned (a confirmed sales return). Identified by the ORIGINAL order/invoice
// ref used when it was posted. Any not-yet-deducted amount is cancelled from the
// outstanding balance; any portion already withheld in a finalized cutoff is
// refunded as a (non-taxable) adjustment on the next open payslip. Idempotent on
// returnRef so the same return never credits twice.
app.post('/api/integrations/product-advance/reverse', integrationAuth, (req, res) => {
  const { orderRef, amount, returnRef, reason } = req.body || {};
  if (!orderRef) return res.status(400).json({ error: 'orderRef (the original order/invoice reference) is required.' });
  const amt = round2(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'A positive amount is required.' });

  const data = getCompanyData();
  data.loans = data.loans || [];
  const loan = data.loans.find(function (l) { return l.source === 'inventory' && l.sourceOrderRef === String(orderRef); });
  if (!loan) return res.status(404).json({ error: 'No product advance was found for order ' + orderRef + '.', code: 'ADVANCE_NOT_FOUND' });

  loan.reversals = loan.reversals || [];
  if (returnRef != null && String(returnRef).trim() !== '' &&
      loan.reversals.some(function (r) { return r.returnRef === String(returnRef); })) {
    return res.json({ ok: true, duplicate: true, loanId: loan.id });
  }

  const alreadyReversed = loan.reversals.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
  const maxReversible = round2((loan.principal || 0) - alreadyReversed);
  const credit = round2(Math.min(amt, Math.max(0, maxReversible)));

  const emp = (data.employees || []).find(function (e) { return e.id === loan.employeeId; });
  // Cancel not-yet-deducted amount from the balance; refund whatever was already withheld.
  const balanceReduce = round2(Math.min(credit, loan.balance || 0));
  loan.balance = round2((loan.balance || 0) - balanceReduce);
  const refund = round2(credit - balanceReduce);
  if (loan.balance <= 0) loan.active = false;
  loan.reversals.push({ returnRef: (returnRef != null ? String(returnRef) : null), amount: credit, reason: reason || '', at: new Date().toISOString() });

  // Refund the already-deducted portion on the earliest open (non-finalized) period.
  let refundPeriod = null;
  if (refund > 0 && emp) {
    const open = (data.periods || [])
      .filter(function (p) { return p.status !== 'finalized'; })
      .sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; })[0] || null;
    if (open) {
      data.adjustments = data.adjustments || {};
      data.adjustments[open.id] = data.adjustments[open.id] || {};
      const arr = data.adjustments[open.id][emp.id] = data.adjustments[open.id][emp.id] || [];
      arr.push({ name: 'Product advance refund' + (returnRef ? ' (return ' + returnRef + ')' : ''),
        amount: refund, taxable: false, type: 'refund', reversalOf: String(orderRef) });
      refundPeriod = open;
    }
  }

  let version;
  try { version = saveCompanyData(data); }
  catch (e) { return res.status(e.code === 'CONFLICT' ? 409 : 500).json({ error: e.message }); }

  const empLabel = emp ? emp.code : ('loan ' + loan.id);
  audit({ user: { id: null, email: 'inventory-integration', role: 'system' } }, 'update', 'loan',
    'Reversed ₱' + credit + ' of product advance for ' + empLabel + ' (order ' + orderRef +
    (returnRef ? ', return ' + returnRef : '') + ') — ₱' + balanceReduce + ' cancelled from balance' +
    (refund > 0 ? (', ₱' + refund + ' refunded' + (refundPeriod ? ' on ' + refundPeriod.name : ' (no open period — pending)')) : ''));
  if (emp) {
    const linked = db.prepare('SELECT id FROM users WHERE employee_code = ?').get(emp.code);
    if (linked) notify(linked.id, 'loan', 'Product advance reversed',
      'A returned purchase credited back ₱' + credit.toLocaleString('en-PH') + '.' +
      (refund > 0 && refundPeriod ? ' ₱' + refund.toLocaleString('en-PH') + ' already deducted will be refunded on ' + refundPeriod.name + '.' : ''));
  }
  res.json({ ok: true, loanId: loan.id, credited: credit, balanceReduced: balanceReduce,
    refunded: refund, refundPeriod: refundPeriod ? refundPeriod.name : null,
    remainingBalance: loan.balance, companyVersion: version });
});

// Admin resets a user's password (provide one, or a random one is generated).
app.post('/api/admin/users/:id/password', adminMgmt, requireUnscoped, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  let pw = (req.body && req.body.password) || '';
  let generated = false;
  if (!pw) { pw = Math.random().toString(36).slice(2, 10); generated = true; }
  if (String(pw).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  // Admin-issued passwords are temporary: the user must set their own on next login.
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(A.hashPassword(pw), user.id);
  audit(req, 'update', 'user', 'Issued a temporary password for ' + user.email + ' (must change on next login)');
  res.json({ ok: true, password: generated ? pw : undefined, temporary: true });
});

// Superadmin: system change history (who / what / when). Views are not logged.
app.get('/api/admin/audit-log', A.requireRole('superadmin'), (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    const like = '%' + q + '%';
    rows = db.prepare('SELECT * FROM audit_log WHERE user_email LIKE ? OR action LIKE ? OR entity LIKE ? OR detail LIKE ? ORDER BY id DESC LIMIT ?')
      .all(like, like, like, like, limit);
  } else {
    rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }
  res.json({ entries: rows });
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
  audit(req, 'notify', 'payslips', 'Sent payslip notifications for ' + period.name + ' (' + notified + ' employee(s))');
  res.json({ ok: true, sent, skipped, notified, emailConfigured: mailer.configured() });
});

/* ================= SUPERVISOR (view-only team DTR) ================= */
// Minimal employee roster (no salaries) for supervisors to pick from.
app.get('/api/sup/employees', canReview, (req, res) => {
  const data = getCompanyData();
  const loc = req.user.location_id || null;
  res.json({ employees: (data.employees || []).filter(function (e) {
    return e.active !== false && (!loc || e.locationId === loc);
  }).map(function (e) {
    return { id: e.id, code: e.code, firstName: e.firstName, lastName: e.lastName, position: e.position,
      schedTimeIn: e.schedTimeIn, schedTimeOut: e.schedTimeOut };
  }) });
});
// One employee's DTR for a period (read-only).
app.get('/api/sup/dtr/:periodId/:empId', canReview, (req, res) => {
  const data = getCompanyData();
  const period = (data.periods || []).find(function (p) { return p.id === req.params.periodId; });
  const days = ((data.dtr[req.params.periodId] || {})[req.params.empId]) || [];
  res.json({ period: period || null, days: days });
});
// Periods list for supervisors (name/status only).
app.get('/api/sup/periods', canReview, (req, res) => {
  const data = getCompanyData();
  res.json({ periods: (data.periods || []).map(function (p) { return { id: p.id, name: p.name, status: p.status }; }) });
});

/* ================= EMPLOYEE SELF-SERVICE ================= */
app.get('/api/me/profile', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const emp = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;
  const loans = emp ? (data.loans || []).filter(function (l) { return l.employeeId === emp.id; }) : [];
  const pcr = db.prepare("SELECT fields_json, created_at FROM profile_change_requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(req.user.id);
  res.json({
    user: A.publicUser(req.user),
    profile: JSON.parse(req.user.profile_json || '{}'),
    employee: emp || null,
    loans: loans,
    cashAdvance: emp ? cashAdvanceInfo(data, emp, req.user.id) : null,
    pendingProfileChange: pcr ? { fields: JSON.parse(pcr.fields_json || '{}'), at: pcr.created_at } : null,
    company: data.meta.company
  });
});

// Fields an employee may edit on their OWN 201. Contact details apply instantly;
// bank details and government IDs affect payouts/remittances, so those changes
// go through admin approval. Nothing that affects pay (salary, employment
// type/status, schedule, code, location, deductions, leave credits, active) is
// self-editable at all.
const CONTACT_201 = ['contactNumber', 'email', 'address', 'civilStatus',
  'emergencyName', 'emergencyRelation', 'emergencyContact'];
const APPROVAL_201 = ['bankName', 'bankAccountName', 'bankAccountNumber', 'sssNo', 'philhealthNo', 'pagibigNo', 'tin'];
function trimVal(v) { return (typeof v === 'string') ? v.trim() : v; }
// Employee updates their own 201: contact details are saved immediately; bank /
// government-ID changes are queued for admin approval.
app.post('/api/me/201', A.requireAuth, (req, res) => {
  const body = req.body || {};
  const data = getCompanyData();
  const emp = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;

  if (emp) {
    let contactChanged = false;
    CONTACT_201.forEach(function (f) { if (f in body) { emp[f] = trimVal(body[f]); contactChanged = true; } });
    if (contactChanged) {
      try { saveCompanyData(data); }
      catch (e) { return res.status(e.code === 'CONFLICT' ? 409 : 500).json({ error: e.message }); }
      audit({ user: { id: req.user.id, email: req.user.email, role: req.user.role } },
        'update', 'employee', (emp.code || ('user ' + req.user.id)) + ' updated their own contact details');
    }
    // Bank / gov-ID changes that actually differ from the current record → pending.
    const changes = {};
    APPROVAL_201.forEach(function (f) {
      if (f in body) { const v = trimVal(body[f]); if (String(v || '') !== String(emp[f] || '')) changes[f] = v; }
    });
    let pending = null;
    if (Object.keys(changes).length) {
      db.prepare("DELETE FROM profile_change_requests WHERE user_id = ? AND status = 'pending'").run(req.user.id);
      db.prepare('INSERT INTO profile_change_requests (user_id, employee_code, fields_json) VALUES (?, ?, ?)')
        .run(req.user.id, emp.code || null, JSON.stringify(changes));
      pending = changes;
      notifyAll(adminUsers(), 'profile', 'Bank / government-ID change to review',
        (emp.lastName || '') + ', ' + (emp.firstName || '') + ' (' + (emp.code || '') + ') requested a change to their bank / government-ID details.');
      audit({ user: { id: req.user.id, email: req.user.email, role: req.user.role } },
        'create', 'profile change', (emp.code || '') + ' requested bank/gov-ID change: ' + Object.keys(changes).join(', '));
    }
    return res.json({ ok: true, contactApplied: contactChanged, pending: pending });
  }

  // Not yet linked to a 201 — everything is just kept on the sign-up profile
  // (an administrator finalizes it later), so no approval step is needed.
  const profile = JSON.parse(req.user.profile_json || '{}');
  CONTACT_201.concat(APPROVAL_201).forEach(function (f) { if (f in body) profile[f] = trimVal(body[f]); });
  db.prepare('UPDATE users SET profile_json = ? WHERE id = ?').run(JSON.stringify(profile), req.user.id);
  res.json({ ok: true, profile: profile });
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
  const kind = req.query.kind === 'before' ? 'before' : 'after';
  const date = req.query.date, time = req.query.time || req.query.endTime;
  if (!date || !time) return res.json({ ok: false });
  const daySched = schedForDate(emp, date);
  const sched = kind === 'before' ? daySched.in : daySched.out;
  if (!sched) return res.json({ ok: false, error: 'Your shift ' + (kind === 'before' ? 'start' : 'end') + ' time is not set for that day. Ask your administrator.' });
  const c = computeFiledOT(data, emp, date, kind, time);
  if (!c) return res.json({ ok: false, error: 'Check the time you entered.' });
  res.json({ ok: true, kind: kind, otMinutes: c.otMinutes, otHours: c.otMinutes / 60, lateMinutes: c.lateMinutes, sched: sched });
});
app.get('/api/me/overtime', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM overtime_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ requests: rows.map(function (r) { return Object.assign(r, { reason_label: OT_REASONS[r.reason] || r.reason }); }) });
});
app.post('/api/me/overtime', A.requireAuth, (req, res) => {
  const { date, kind, reason, specificReason, endTime, time } = req.body || {};
  const k = kind === 'before' ? 'before' : 'after';
  const timeVal = time || endTime;
  if (!OT_REASONS[reason]) return res.status(400).json({ error: 'Choose a valid overtime reason.' });
  if (!date) return res.status(400).json({ error: 'Enter the date the overtime was rendered.' });
  if (!timeVal) return res.status(400).json({ error: k === 'before' ? 'Enter your early time-in.' : 'Enter the end time of the overtime.' });
  if (!specificReason || !String(specificReason).trim()) return res.status(400).json({ error: 'A specific reason is required.' });
  if (parseDateLocal(date) > todayLocal()) return res.status(400).json({ error: 'The overtime date cannot be in the future.' });
  const data = getCompanyData();
  const emp = findEmpByCode(data, req.user.employee_code);
  if (!emp) return res.status(400).json({ error: 'No employee (201) record is linked to your account yet.' });
  const daySched = schedForDate(emp, date);
  const sched = k === 'before' ? daySched.in : daySched.out;
  if (!sched) return res.status(400).json({ error: 'Your work schedule (shift ' + (k === 'before' ? 'start' : 'end') + ') is not set for that day. Ask your administrator.' });
  const c = computeFiledOT(data, emp, date, k, timeVal);
  if (!c) return res.status(400).json({ error: 'Could not compute overtime — check the time you entered.' });
  db.prepare(
    `INSERT INTO overtime_requests (user_id, employee_code, ot_date, ot_kind, reason, specific_reason, end_time, ot_minutes, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, req.user.employee_code, date, k, reason, String(specificReason).trim(), timeVal, c.otMinutes, c.lateMinutes);
  res.json({ ok: true, otMinutes: c.otMinutes, otHours: c.otMinutes / 60, lateMinutes: c.lateMinutes });
});

/* ---- loan applications (employee self-service) ---- */
app.get('/api/me/loans', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM loan_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ requests: rows });
});
app.post('/api/me/loans', A.requireAuth, (req, res) => {
  const { loanType, amount, installments, reason, emergencyAck } = req.body || {};
  if (!LOAN_TYPES[loanType]) return res.status(400).json({ error: 'Choose a valid loan type.' });
  const amt = Number(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter a valid amount.' });
  // Advances (cash / product) are cleared within the month over 1 or 2 cutoffs.
  const inst = ADVANCE_TYPES[loanType]
    ? Math.min(2, Math.max(1, parseInt(installments, 10) || 1))
    : Math.max(1, parseInt(installments, 10) || 1);

  if (loanType === 'cash_advance') {
    if (!emergencyAck) return res.status(400).json({ error: 'Please confirm the cash advance is for an emergency purpose.' });
    const data = getCompanyData();
    const emp = findEmpByCode(data, req.user.employee_code);
    if (emp) {
      const ca = cashAdvanceInfo(data, emp, req.user.id);
      if (ca.available <= 0) return res.status(400).json({ error: 'You have reached the cash-advance limit (half of your monthly basic salary). Pay down your existing cash advance before applying again.' });
      if (amt > ca.available) return res.status(400).json({ error: 'This exceeds your available cash-advance limit of ₱' + ca.available.toLocaleString('en-PH') + ' (half of monthly basic salary, less what you already have).' });
    }
  }
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
// Shared team calendar for employees: APPROVED leaves of their own branch (all
// branches when none are configured). Names + type only — no reason (privacy).
app.get('/api/me/leave-calendar', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const me = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;
  const myLoc = me ? (me.locationId || null) : null;
  const hasLocs = ((data.meta && data.meta.locations) || []).length > 0;
  const byCode = {}; (data.employees || []).forEach(function (e) { if (e.code) byCode[e.code] = e.locationId || null; });
  let rows = db.prepare(
    `SELECT lr.employee_code, lr.date_from, lr.date_to, lr.leave_type, u.full_name
     FROM leave_requests lr JOIN users u ON u.id = lr.user_id
     WHERE lr.status = 'approved' ORDER BY lr.date_from`
  ).all();
  if (hasLocs) rows = rows.filter(function (r) { return byCode[r.employee_code] === myLoc; });
  res.json({ requests: rows });
});
app.get('/api/me/leave-window', A.requireAuth, (req, res) => {
  const data = getCompanyData();
  const pol = leavePolicyOf(data);
  const t = todayLocal();
  const emp = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;
  res.json({
    openDay: Number(pol.openDay) || 21,
    manualOpen: !!pol.manualOpen,
    creditsRemaining: emp ? leaveCreditsRemaining(emp, req.user.id) : 0,
    serverDate: t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
  });
});

app.post('/api/me/leave', A.requireAuth, (req, res) => {
  const { dateFrom, dateTo, leaveType, reason } = req.body || {};
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Start and end dates are required.' });
  if (dateTo < dateFrom) return res.status(400).json({ error: 'End date cannot be before the start date.' });
  const type = ['SL', 'VL', 'EL', 'UAL'].indexOf(leaveType) >= 0 ? leaveType : 'VL';
  // Enforce the leave application window for employees (admins may file anytime).
  if (['superadmin', 'admin_payroll'].indexOf(req.user.role) < 0) {
    const data = getCompanyData();
    const pol = leavePolicyOf(data);
    if (!leaveDateAllowed(dateFrom, type, pol) || !leaveDateAllowed(dateTo, type, pol)) {
      return res.status(400).json({ error: 'Leave filing for those dates is not open yet. ' +
        (type === 'VL' ? 'Next-month leave opens on day ' + (Number(pol.openDay) || 21) + ' of the current month.' :
          'Please pick eligible dates.') });
    }
    // Paid leave (VL/SL/EL) requires available credits. When exhausted, the employee
    // must use Unpaid Authorized Leave (UAL) instead, which is unpaid and needs approval.
    if (type !== 'UAL') {
      const emp = req.user.employee_code ? findEmpByCode(data, req.user.employee_code) : null;
      const remaining = emp ? leaveCreditsRemaining(emp, req.user.id) : 0;
      const need = leaveDayCount(dateFrom, dateTo);
      if (remaining < need) {
        return res.status(400).json({
          error: 'You do not have enough leave credits for this request (' + remaining +
            ' remaining, ' + need + ' requested). Please file it as "Unpaid Authorized Leave" instead.',
          code: 'NO_LEAVE_CREDITS', remaining: remaining
        });
      }
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
// DTR is view-only for employees — attendance comes from the biometric device /
// admin, so employees cannot change their own records (this would affect payroll).
app.post('/api/me/dtr/:periodId', A.requireAuth, (req, res) => {
  return res.status(403).json({ error: 'Your DTR is view-only. Time records are maintained by your administrator from the biometric device.' });
});

/* ---- physical time card uploads (employee → admin) ---- */
const TIMECARD_MIME = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'application/pdf': 1 };
function parseDataUrl(s) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(s || ''));
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}
// Employee uploads a photo/scan of their physical time card for a period.
app.post('/api/me/timecard', A.requireAuth, (req, res) => {
  const { periodId, dataUrl, note } = req.body || {};
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return res.status(400).json({ error: 'Please attach an image or PDF of your time card.' });
  if (!TIMECARD_MIME[parsed.mime]) return res.status(400).json({ error: 'Only JPG, PNG, WEBP or PDF files are accepted.' });
  // Guard the size (base64 is ~4/3 of the bytes; ~4MB of image keeps us under the body limit).
  if (parsed.b64.length > 5.4 * 1024 * 1024) return res.status(400).json({ error: 'That file is too large. Please upload a smaller photo (under ~4 MB).' });
  const info = db.prepare(
    'INSERT INTO time_cards (user_id, employee_code, period_id, mime, data, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, req.user.employee_code || null, periodId || null, parsed.mime, parsed.b64, String(note || '').slice(0, 300));
  res.json({ ok: true, id: info.lastInsertRowid });
});
// The employee's own uploads (metadata only) — optionally filtered to a period.
app.get('/api/me/timecards', A.requireAuth, (req, res) => {
  const pid = req.query.periodId;
  const rows = pid
    ? db.prepare('SELECT id, period_id, mime, note, created_at FROM time_cards WHERE user_id = ? AND period_id = ? ORDER BY created_at DESC').all(req.user.id, pid)
    : db.prepare('SELECT id, period_id, mime, note, created_at FROM time_cards WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ timecards: rows });
});
// Employee removes one of their own uploads.
app.delete('/api/me/timecard/:id', A.requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM time_cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});
// Admin/supervisor list of uploaded time cards for a period (location-scoped).
app.get('/api/admin/timecards', A.requireRole('superadmin', 'admin_payroll', 'finance', 'auditor', 'supervisor'), (req, res) => {
  const pid = req.query.periodId;
  let rows = (pid
    ? db.prepare(`SELECT tc.id, tc.employee_code, tc.period_id, tc.mime, tc.note, tc.created_at, u.full_name
                  FROM time_cards tc JOIN users u ON u.id = tc.user_id WHERE tc.period_id = ? ORDER BY tc.created_at DESC`).all(pid)
    : db.prepare(`SELECT tc.id, tc.employee_code, tc.period_id, tc.mime, tc.note, tc.created_at, u.full_name
                  FROM time_cards tc JOIN users u ON u.id = tc.user_id ORDER BY tc.created_at DESC`).all());
  rows = scopeRequestRows(req, rows); // narrow to the reviewer's branch when scoped
  res.json({ timecards: rows });
});
// Stream one time card's image. Owner or any admin-app role may view; scoped
// admins only within their branch.
app.get('/api/timecard/:id', A.requireAuth, (req, res) => {
  const tc = db.prepare('SELECT * FROM time_cards WHERE id = ?').get(req.params.id);
  if (!tc) return res.status(404).json({ error: 'Not found.' });
  const isOwner = tc.user_id === req.user.id;
  const adminRoles = ['superadmin', 'admin_payroll', 'finance', 'auditor', 'supervisor'];
  const isAdmin = adminRoles.indexOf(req.user.role) >= 0;
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Not allowed.' });
  if (!isOwner && isAdmin && req.user.location_id) {
    const loc = {}; (getCompanyData().employees || []).forEach(function (e) { if (e.code) loc[e.code] = e.locationId || null; });
    if (loc[tc.employee_code] !== req.user.location_id) return res.status(403).json({ error: 'Not allowed.' });
  }
  res.set('Content-Type', tc.mime);
  res.set('Content-Disposition', 'inline; filename="timecard-' + tc.id + '"');
  res.send(Buffer.from(tc.data, 'base64'));
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

// Scheduled maintenance: run shortly after boot, then every 6 hours. Jobs are
// idempotent (deterministic period ids + one-time flags), so extra runs are safe.
setTimeout(runDailyJobs, 4000);
setInterval(runDailyJobs, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('PH Payroll server listening on port ' + PORT));

module.exports = app;
