/* ==========================================================================
 * payroll-engine.js — run the shared browser payroll engine on the server.
 * --------------------------------------------------------------------------
 * The compute code in assets/js (statutory/dtr/payroll) is plain JS with no DOM
 * use, so we load it into a vm sandbox and drive it from company data. Used for
 * automated draft payroll and precise day-level overtime carry-over amounts.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ASSETS = path.join(__dirname, '..', '..', 'assets', 'js');
function loadEngine() {
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  ['statutory.js', 'dtr.js', 'payroll.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ASSETS, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox.window.PH;
}

// Compute (draft) payroll results for one period: { employeeId: result }.
function computePeriod(companyData, period) {
  const PH = loadEngine();
  PH.storage = { db: companyData }; // computeEmployee reads meta.overtime + otApprovals here
  const results = {};
  (companyData.employees || []).filter(function (e) { return e.active !== false; }).forEach(function (emp) {
    const dtrDays = ((companyData.dtr || {})[period.id] || {})[emp.id] || null;
    const allowances = (companyData.allowances || []).filter(function (a) { return a.employeeId === emp.id; });
    const adjustments = ((companyData.adjustments || {})[period.id] || {})[emp.id] || [];
    const loans = (companyData.loans || []).filter(function (l) { return l.employeeId === emp.id; });
    results[emp.id] = PH.payroll.computeEmployee(emp, { period: period, dtrDays: dtrDays, allowances: allowances, adjustments: adjustments, loans: loans });
  });
  return results;
}

// Precise overtime pay for a single already-recorded DTR day (for carry-over).
// Returns { amount, hours } using the same policy/multipliers as payroll.
function overtimeForDay(companyData, emp, dtrDay) {
  const PH = loadEngine();
  const rates = PH.payroll.rates(emp);
  const otPolicy = (companyData.meta && companyData.meta.overtime) || {};
  // Force this day's OT to count regardless of authorization gating.
  const r = PH.dtr.computeDay(dtrDay, {
    defaultBreak: emp.schedBreakMins != null ? emp.schedBreakMins : 60,
    schedIn: emp.schedTimeIn || null, schedOut: emp.schedTimeOut || null,
    ot: otPolicy, requireOtAuth: false
  });
  const pay = PH.dtr.computeDayPay(r, rates.hourly);
  const otMin = (r.otMinutes || 0) + (r.preOtMinutes || 0);
  return { amount: pay.overtime, hours: Math.round((otMin / 60) * 100) / 100 };
}

module.exports = { computePeriod, overtimeForDay };
