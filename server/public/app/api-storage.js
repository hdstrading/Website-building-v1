/* ==========================================================================
 * api-storage.js — drop-in replacement for the offline storage.js
 * --------------------------------------------------------------------------
 * Exposes the same PH.storage interface the UI/engine expect, but backed by
 * the server's company-data API instead of localStorage. The bootstrap
 * (app-online.js) fetches the company document first and stashes it on
 * window.__COMPANY__ before calling load().
 * ========================================================================== */
(function (PH) {
  'use strict';
  var db = null;
  var version = 1;
  var role = 'employee';
  var saveTimer = null;
  var saving = false;
  var dirty = false;

  function emptyDB() {
    return {
      meta: { version: 1, company: { name: 'My Company', address: '', tin: '' },
        overtime: { enabled: true, minMinutes: 60, incrementMinutes: 30, graceMinutes: 5, lateForfeitsFirstHour: true } },
      employees: [], allowances: [], loans: [], periods: [],
      dtr: {}, adjustments: {}, payrolls: {}, thirteenthMonth: {}, statutoryConfig: null
    };
  }

  function load() {
    var c = window.__COMPANY__ || {};
    db = c.data || emptyDB();
    version = c.version || 1;
    role = c.role || 'employee';
    if (!db.meta) db.meta = emptyDB().meta;
    if (!db.meta.overtime) db.meta.overtime = emptyDB().meta.overtime;
    if (db.meta.overtime.lateForfeitsFirstHour === undefined) db.meta.overtime.lateForfeitsFirstHour = true;
    if (!db.thirteenthMonth) db.thirteenthMonth = {};
    if (db.statutoryConfig) PH.statutory.setConfig(db.statutoryConfig);
    return db;
  }

  function scheduleSave() {
    if (role === 'finance') { PH.storage.onStatus && PH.storage.onStatus('readonly'); return; }
    dirty = true;
    PH.storage.onStatus && PH.storage.onStatus('saving');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }
  function flush() {
    if (saving || !dirty) return;
    saving = true; dirty = false;
    db.statutoryConfig = PH.statutory.config;
    fetch('/api/company', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: db, version: version })
    }).then(function (r) {
      if (r.status === 409) { return r.json().then(function (j) { throw new Error(j.error || 'Conflict'); }); }
      if (r.status === 403) { throw new Error('403'); }
      if (!r.ok) throw new Error('Save failed (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      version = j.version;
      saving = false;
      PH.storage.onStatus && PH.storage.onStatus(dirty ? 'saving' : 'saved');
      if (dirty) flush();
    }).catch(function (e) {
      saving = false;
      if (String(e.message) === '403') { PH.storage.onStatus && PH.storage.onStatus('readonly'); return; }
      PH.storage.onStatus && PH.storage.onStatus('error');
      if (/changed by someone else|Conflict/i.test(e.message)) {
        alert('This data was changed by another user. The page will reload to get the latest version.');
        location.reload();
      } else {
        console.error(e);
      }
    });
  }
  function save() { scheduleSave(); return db; }

  // Force an immediate save and resolve when the server has it (used before
  // actions that depend on the saved data, e.g. emailing payslips on finalize).
  function saveNow() {
    if (role === 'finance') return Promise.resolve();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    db.statutoryConfig = PH.statutory.config;
    dirty = false;
    return fetch('/api/company', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: db, version: version })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('Save failed (' + r.status + ')')); });
      return r.json();
    }).then(function (j) {
      version = j.version;
      PH.storage.onStatus && PH.storage.onStatus('saved');
    });
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  function list(coll) { return db[coll] || []; }
  function find(coll, id) { return (db[coll] || []).find(function (x) { return x.id === id; }); }
  function upsert(coll, item) {
    if (!item.id) item.id = uid(coll.slice(0, 3));
    var arr = db[coll] || (db[coll] = []);
    var i = arr.findIndex(function (x) { return x.id === item.id; });
    if (i >= 0) arr[i] = Object.assign(arr[i], item); else arr.push(item);
    save(); return item;
  }
  function remove(coll, id) {
    db[coll] = (db[coll] || []).filter(function (x) { return x.id !== id; });
    save();
  }
  function exportJSON() { db.statutoryConfig = PH.statutory.config; return JSON.stringify(db, null, 2); }
  function importJSON(text) {
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('employees' in parsed)) throw new Error('Not a valid payroll backup file.');
    db = Object.assign(emptyDB(), parsed);
    if (db.statutoryConfig) PH.statutory.setConfig(db.statutoryConfig);
    save(); return db;
  }
  function resetAll() { db = emptyDB(); PH.statutory.resetConfig(); save(); return db; }
  function seedIfEmpty() { /* online: data comes from the server, never seed demo data */ }

  PH.storage = {
    KEY: 'online', role: function () { return role; },
    load: load, save: save, uid: uid,
    get db() { return db; },
    list: list, find: find, upsert: upsert, remove: remove,
    exportJSON: exportJSON, importJSON: importJSON,
    resetAll: resetAll, seedIfEmpty: seedIfEmpty, emptyDB: emptyDB,
    flush: flush, saveNow: saveNow, onStatus: null
  };
})(window.PH = window.PH || {});
