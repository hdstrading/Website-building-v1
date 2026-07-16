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
      meta: {
        version: 1,
        company: { name: 'My Company', address: '', tin: '' },
        // Company overtime policy (editable in Settings).
        overtime: { enabled: true, minMinutes: 60, incrementMinutes: 30, graceMinutes: 5, lateForfeitsFirstHour: true }
      },
      employees: [],
      allowances: [],   // recurring earnings tied to an employee
      loans: [],
      periods: [],
      dtr: {},          // { periodId: { employeeId: [days] } }
      adjustments: {},  // { periodId: { employeeId: [{name,amount,taxable,type}] } }
      payrolls: {},     // { periodId: { employeeId: computedResult } }
      thirteenthMonth: {}, // { year: { employeeId: { basicEarned, released } } }
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
    // Migrate older saved data that predates newer settings.
    if (!db.meta) db.meta = emptyDB().meta;
    if (!db.meta.overtime) db.meta.overtime = emptyDB().meta.overtime;
    if (db.meta.overtime.lateForfeitsFirstHour === undefined) db.meta.overtime.lateForfeitsFirstHour = true;
    if (!db.thirteenthMonth) db.thirteenthMonth = {};
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
      id: uid('emp'), code: 'EMP-001', firstName: 'Juan', middleName: 'Reyes', lastName: 'Dela Cruz',
      position: 'Sales Associate', department: 'Sales', employmentType: 'monthly',
      basicSalary: 20000, dailyRateFactor: 313, workDaysPerWeek: 6, restDay: 0,
      hireDate: '2023-01-15', regularizationDate: '2023-07-15',
      birthDate: '1995-03-20', civilStatus: 'Single',
      address: '123 Rizal St., Brgy. San Isidro, Quezon City',
      contactNumber: '0917-123-4567', email: 'juan.delacruz@example.com',
      sssNo: '34-1234567-8', philhealthNo: '12-345678901-2',
      pagibigNo: '1234-5678-9012', tin: '123-456-789-000',
      emergencyName: 'Ana Dela Cruz', emergencyRelation: 'Spouse', emergencyContact: '0918-765-4321',
      bankName: 'BDO', bankAccountName: 'Juan R. Dela Cruz', bankAccountNumber: '0012-3456-7890',
      employmentStatus: 'regular', leaveCreditsPerYear: 5, leaveCreditsUsed: 0,
      schedTimeIn: '08:00', schedTimeOut: '17:00', schedBreakMins: 60,
      contributionBasis: 'basic', active: true
    };
    var e2 = {
      id: uid('emp'), code: 'EMP-002', firstName: 'Maria', middleName: 'Lopez', lastName: 'Santos',
      position: 'Accountant', department: 'Finance', employmentType: 'monthly',
      basicSalary: 35000, dailyRateFactor: 261, workDaysPerWeek: 5, restDay: 0,
      hireDate: '2022-06-01', regularizationDate: '2022-12-01',
      birthDate: '1990-09-12', civilStatus: 'Married',
      address: '45 Mabini Ave., Brgy. Poblacion, Makati City',
      contactNumber: '0920-222-3333', email: 'maria.santos@example.com',
      sssNo: '34-7654321-0', philhealthNo: '12-109876543-2',
      pagibigNo: '9876-5432-1098', tin: '987-654-321-000',
      emergencyName: 'Pedro Santos', emergencyRelation: 'Spouse', emergencyContact: '0921-444-5555',
      bankName: 'BPI', bankAccountName: 'Maria L. Santos', bankAccountNumber: '3344-5566-77',
      employmentStatus: 'regular', leaveCreditsPerYear: 5, leaveCreditsUsed: 1,
      schedTimeIn: '09:00', schedTimeOut: '18:00', schedBreakMins: 60,
      contributionBasis: 'basic', active: true
    };
    db.employees.push(e1, e2);
    db.allowances.push(
      { id: uid('alw'), employeeId: e1.id, name: 'Rice Allowance', amount: 2000, taxable: false, type: 'allowance', basis: 'monthly' },
      { id: uid('alw'), employeeId: e1.id, name: 'Transportation', amount: 100, taxable: true, type: 'allowance', basis: 'daily' },
      { id: uid('alw'), employeeId: e2.id, name: 'Meal Allowance', amount: 150, taxable: false, type: 'allowance', basis: 'daily' }
    );
    db.loans.push(
      { id: uid('lon'), employeeId: e1.id, type: 'SSS Loan', principal: 12000, monthlyAmortization: 1000, balance: 8000, startDate: '2024-11-01', active: true },
      { id: uid('lon'), employeeId: e1.id, type: 'Product Advance', reference: 'Company store — appliances', principal: 6000, monthlyAmortization: 1000, balance: 4000, startDate: '2026-05-01', active: true },
      { id: uid('lon'), employeeId: e2.id, type: 'Company Loan', principal: 30000, monthlyAmortization: 2500, balance: 20000, startDate: '2024-08-01', active: true },
      { id: uid('lon'), employeeId: e2.id, type: 'Cash Advance', reference: 'Payroll cash advance', principal: 5000, monthlyAmortization: 2500, balance: 5000, startDate: '2026-07-01', active: true }
    );
    var period = {
      id: uid('per'), name: 'July 2026 (1–15)', startDate: '2026-07-01', endDate: '2026-07-15',
      payDate: '2026-07-20', frequency: 'semi-monthly',
      applySSS: true, applyPhilHealth: true, applyPagIBIG: true, status: 'draft'
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
