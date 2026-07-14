/* ==========================================================================
 * storage.js — Local (offline) persistence layer
 * --------------------------------------------------------------------------
 * All data lives in the browser's localStorage. No server, no network.
 * Provides CRUD helpers, JSON backup/restore, and first-run seeding.
 * ========================================================================== */
(function (PH) {
  'use strict';

  var KEY = 'ph_payroll_db_v1';

  function emptyDB() {
    return {
      meta: { version: 1, company: { name: 'My Company', address: '', tin: '' } },
      employees: [],
      allowances: [],   // recurring earnings tied to an employee
      loans: [],
      periods: [],
      dtr: {},          // { periodId: { employeeId: [days] } }
      adjustments: {},  // { periodId: { employeeId: [{name,amount,taxable,type}] } }
      payrolls: {},     // { periodId: { employeeId: computedResult } }
      statutoryConfig: null
    };
  }

  var db = null;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      db = raw ? JSON.parse(raw) : emptyDB();
    } catch (e) {
      console.error('Failed to load DB, starting fresh', e);
      db = emptyDB();
    }
    if (db.statutoryConfig) PH.statutory.setConfig(db.statutoryConfig);
    return db;
  }

  function save() {
    db.statutoryConfig = PH.statutory.config;
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      alert('Could not save data (storage may be full): ' + e.message);
    }
    return db;
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 7);
  }

  // ---- generic collection helpers ----
  function list(coll) { return db[coll] || []; }
  function find(coll, id) {
    return (db[coll] || []).find(function (x) { return x.id === id; });
  }
  function upsert(coll, item) {
    if (!item.id) item.id = uid(coll.slice(0, 3));
    var arr = db[coll] || (db[coll] = []);
    var i = arr.findIndex(function (x) { return x.id === item.id; });
    if (i >= 0) arr[i] = Object.assign(arr[i], item); else arr.push(item);
    save();
    return item;
  }
  function remove(coll, id) {
    db[coll] = (db[coll] || []).filter(function (x) { return x.id !== id; });
    save();
  }

  // ---- backup / restore ----
  function exportJSON() {
    db.statutoryConfig = PH.statutory.config;
    return JSON.stringify(db, null, 2);
  }
  function importJSON(text) {
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('employees' in parsed)) {
      throw new Error('Not a valid payroll backup file.');
    }
    db = Object.assign(emptyDB(), parsed);
    if (db.statutoryConfig) PH.statutory.setConfig(db.statutoryConfig);
    save();
    return db;
  }

  function resetAll() {
    db = emptyDB();
    PH.statutory.resetConfig();
    save();
    return db;
  }

  // ---- first-run demo seed ----
  function seedIfEmpty() {
    if (db.employees.length) return;
    var e1 = {
      id: uid('emp'), code: 'EMP-001', firstName: 'Juan', lastName: 'Dela Cruz',
      position: 'Sales Associate', department: 'Sales', employmentType: 'monthly',
      basicSalary: 20000, dailyRateFactor: 313, workDaysPerWeek: 6, restDay: 0,
      hireDate: '2023-01-15', sssNo: '34-1234567-8', philhealthNo: '12-345678901-2',
      pagibigNo: '1234-5678-9012', tin: '123-456-789-000', contributionBasis: 'basic',
      active: true
    };
    var e2 = {
      id: uid('emp'), code: 'EMP-002', firstName: 'Maria', lastName: 'Santos',
      position: 'Accountant', department: 'Finance', employmentType: 'monthly',
      basicSalary: 35000, dailyRateFactor: 261, workDaysPerWeek: 5, restDay: 0,
      hireDate: '2022-06-01', sssNo: '34-7654321-0', philhealthNo: '12-109876543-2',
      pagibigNo: '9876-5432-1098', tin: '987-654-321-000', contributionBasis: 'basic',
      active: true
    };
    db.employees.push(e1, e2);
    db.allowances.push(
      { id: uid('alw'), employeeId: e1.id, name: 'Rice Allowance', amount: 2000, taxable: false, type: 'allowance' },
      { id: uid('alw'), employeeId: e1.id, name: 'Transportation', amount: 1500, taxable: true, type: 'allowance' },
      { id: uid('alw'), employeeId: e2.id, name: 'Meal Allowance', amount: 2000, taxable: false, type: 'allowance' }
    );
    db.loans.push(
      { id: uid('lon'), employeeId: e1.id, type: 'SSS Loan', principal: 12000, monthlyAmortization: 1000, balance: 8000, startDate: '2024-11-01', active: true },
      { id: uid('lon'), employeeId: e2.id, type: 'Company Loan', principal: 30000, monthlyAmortization: 2500, balance: 20000, startDate: '2024-08-01', active: true }
    );
    var period = {
      id: uid('per'), name: 'July 2026 (1–15)', startDate: '2026-07-01', endDate: '2026-07-15',
      payDate: '2026-07-20', frequency: 'semi-monthly', applyContributions: true, status: 'draft'
    };
    db.periods.push(period);
    save();
  }

  PH.storage = {
    KEY: KEY,
    load: load, save: save, uid: uid,
    get db() { return db; },
    list: list, find: find, upsert: upsert, remove: remove,
    exportJSON: exportJSON, importJSON: importJSON,
    resetAll: resetAll, seedIfEmpty: seedIfEmpty, emptyDB: emptyDB
  };
})(window.PH = window.PH || {});
