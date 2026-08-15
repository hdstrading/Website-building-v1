/* ==========================================================================
 * ui.js — User interface: navigation, views, forms, rendering
 * ========================================================================== */
(function (PH) {
  'use strict';

  // Brand mark: deep-blue badge, Ferrari-red accent bar, white peso glyph.
  PH.BRAND_SVG = "<svg viewBox='0 0 64 64' width='38' height='38' aria-hidden='true'>" +
    "<rect width='64' height='64' rx='14' fill='#17408b'/>" +
    "<rect x='17' y='47' width='30' height='5' rx='2.5' fill='#e11d2a'/>" +
    "<text x='32' y='42' font-family='Arial,Helvetica,sans-serif' font-size='36' font-weight='bold' fill='#fff' text-anchor='middle'>₱</text></svg>";

  var S = PH.storage;
  var money = function (n) {
    n = n || 0;
    return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var hrs = function (mins) { return (mins / 60).toFixed(2) + 'h'; };

  /* ---- Government ID validation (format + duplicate check) ----
   * No public agency API exists to confirm a number is registered to a person,
   * so we validate the digit-count format and flag duplicates/blanks — which
   * catches the typos and collisions that cause rejected remittances. */
  var GOV_ID = {
    sss:        { label: 'SSS',        field: 'sssNo',        digits: [10] },
    philhealth: { label: 'PhilHealth', field: 'philhealthNo', digits: [12] },
    pagibig:    { label: 'Pag-IBIG',   field: 'pagibigNo',    digits: [12] },
    tin:        { label: 'TIN',        field: 'tin',          digits: [9, 12, 13] } // 9 base + optional branch
  };
  var GOV_ID_KEYS = ['sss', 'philhealth', 'pagibig', 'tin'];
  function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  // Returns null if OK, else { level:'missing'|'invalid', msg }.
  function govIdIssue(type, value) {
    var rule = GOV_ID[type]; if (!rule) return null;
    if (!String(value || '').trim()) return { level: 'missing', msg: rule.label + ' number is missing' };
    var d = digitsOf(value);
    if (rule.digits.indexOf(d.length) < 0)
      return { level: 'invalid', msg: rule.label + ' should be ' + rule.digits.join(' or ') + ' digits (you entered ' + d.length + ')' };
    return null;
  }
  // Set of employee ids that share a gov-id number with someone else, per type.
  function govIdDuplicateMap(employees) {
    var out = {}; // type -> { empId: true }
    GOV_ID_KEYS.forEach(function (type) {
      var byDigits = {};
      employees.forEach(function (e) {
        var d = digitsOf(e[GOV_ID[type].field]); if (!d) return;
        (byDigits[d] = byDigits[d] || []).push(e.id);
      });
      Object.keys(byDigits).forEach(function (dg) {
        if (byDigits[dg].length > 1) byDigits[dg].forEach(function (id) { (out[type] = out[type] || {})[id] = true; });
      });
    });
    return out;
  }
  var cap = function (s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'; };
  var qs = function (sel, root) { return (root || document).querySelector(sel); };

  var state = { view: 'dashboard', selectedPeriod: null, lastRun: null, locationId: '' };
  // A location-scoped account (set by the server) is locked to its own branch.
  var SCOPE = null;
  try { SCOPE = (typeof window !== 'undefined' && window.__COMPANY__ && window.__COMPANY__.scope) || null; } catch (e) { SCOPE = null; }
  if (SCOPE && SCOPE.locationId) state.locationId = SCOPE.locationId;

  /* ===================== LOCATIONS (multi-branch) ===================== */
  // The configured branches/locations. Empty = single-location (feature dormant).
  function locations() { return (S.db.meta && S.db.meta.locations) || []; }
  function locationName(id) {
    var l = locations().filter(function (x) { return x.id === id; })[0];
    return l ? l.name : '';
  }
  // Is this employee in the currently-selected location scope? '' = all locations.
  function inScope(emp) {
    if (!state.locationId) return true;
    return (emp && emp.locationId) === state.locationId;
  }
  // Filter a list of employees (or employee-id keys) by the active location scope.
  function scopeEmps(list) { return (list || []).filter(inScope); }
  function scopeIds(ids) {
    return (ids || []).filter(function (id) { var e = S.find('employees', id); return e ? inScope(e) : true; });
  }
  // Periods visible in the current location scope: the branch's own periods plus
  // any legacy shared periods (no locationId). '' scope = all periods.
  function scopePeriods(list) {
    if (!state.locationId) return list || [];
    return (list || []).filter(function (p) { return !p.locationId || p.locationId === state.locationId; });
  }
  function todayISO() { var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  // Periods in chronological order (by coverage start, then pay date).
  function periodsChrono(list) {
    return (list || []).slice().sort(function (a, b) {
      var as = a.startDate || a.payDate || '', bs = b.startDate || b.payDate || '';
      return as < bs ? -1 : as > bs ? 1 : 0;
    });
  }
  // The period to show by default on load/refresh: the one whose coverage
  // contains today (the cut-off currently being processed); else the nearest
  // upcoming period by pay date; else the most recent one.
  function defaultPeriodId(list) {
    if (!list || !list.length) return null;
    var iso = todayISO();
    var contain = list.filter(function (p) { return p.startDate && p.endDate && p.startDate <= iso && iso <= p.endDate; });
    if (contain.length) return periodsChrono(contain)[0].id;
    var upcoming = periodsChrono(list.filter(function (p) { return (p.payDate || p.endDate || '') >= iso; }));
    if (upcoming.length) return upcoming[0].id;
    var all = periodsChrono(list);
    return all[all.length - 1].id;
  }

  var VIEWS = [
    ['dashboard', 'Dashboard', '📊'],
    ['employees', 'Employees (201)', '👥'],
    ['dtr', 'DTR / Time', '⏰'],
    ['earnings', 'Allowances & Commissions', '💰'],
    ['loans', 'Loans & Deductibles', '🏦'],
    ['payroll', 'Run Payroll', '🧮'],
    ['leavecal', 'Leave Calendar', '📅'],
    ['reports', 'Reports', '📑'],
    ['thirteenth', '13th Month Pay', '🎁'],
    ['bir', 'BIR Forms', '📄'],
    ['settings', 'Statutory Settings', '⚙️'],
    ['backup', 'Backup & Data', '💾']
  ];

  // Auditors (3rd-party, read-only) see only the report views + the leave calendar.
  var AUDITOR_VIEWS = ['leavecal', 'reports', 'thirteenth', 'bir'];
  // The Leave Calendar reads server data, so it only appears in the online edition.
  var IS_ONLINE = !!(PH.storage && PH.storage.KEY === 'online');
  function visibleViews() {
    var vs = (PH.role === 'auditor') ? VIEWS.filter(function (v) { return AUDITOR_VIEWS.indexOf(v[0]) >= 0; }) : VIEWS;
    return vs.filter(function (v) { return v[0] !== 'leavecal' || IS_ONLINE; });
  }

  function navigate(view) { state.view = view; render(); }

  function render() {
    var app = qs('#app');
    // Keep auditors within their allowed views.
    if (PH.role === 'auditor' && AUDITOR_VIEWS.indexOf(state.view) < 0) state.view = 'reports';
    app.innerHTML =
      '<aside class="sidebar">' +
        '<div class="brand"><span class="brand-mark">' + PH.BRAND_SVG + '</span>' +
          '<div><div class="brand-title">HDS Trading</div>' +
          '<div class="brand-sub">Payroll Solutions</div></div></div>' +
        '<nav>' + visibleViews().map(function (v) {
          return '<a href="#" class="nav-item ' + (state.view === v[0] ? 'active' : '') +
            '" data-nav="' + v[0] + '"><span class="nav-ico">' + v[2] + '</span>' + v[1] + '</a>';
        }).join('') + '</nav>' +
        (SCOPE && SCOPE.locationId
          ? '<div class="sidebar-loc" style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.08)"><label style="display:block;font-size:11px;color:#94a3b8;margin:0 0 4px">Location</label>' +
            '<div style="color:#fff;font-weight:600">' + esc(SCOPE.locationName || locationName(SCOPE.locationId)) + '</div>' +
            '<div style="font-size:11px;color:#94a3b8">Your branch</div></div>'
          : (locations().length ? '<div class="sidebar-loc" style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.08)"><label style="display:block;font-size:11px;color:#94a3b8;margin:0 0 4px">Location</label>' +
            select('locFilter', [['', 'All locations']].concat(locations().map(function (l) { return [l.id, l.name]; })), state.locationId) + '</div>' : '')) +
        '<div class="sidebar-foot">' + esc(S.db.meta.company.name) + '</div>' +
      '</aside>' +
      '<main class="main"><div id="view"></div></main>';

    app.querySelectorAll('[data-nav]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); navigate(a.dataset.nav); });
    });
    var locSel = app.querySelector('[name=locFilter]');
    if (locSel) locSel.addEventListener('change', function (e) { state.locationId = e.target.value; render(); });
    renderView();
  }

  function renderView() {
    var v = qs('#view');
    ({
      dashboard: viewDashboard,
      employees: viewEmployees,
      dtr: viewDTR,
      earnings: viewEarnings,
      loans: viewLoans,
      payroll: viewPayroll,
      leavecal: viewLeaveCalendar,
      reports: viewReports,
      thirteenth: viewThirteenth,
      bir: viewBIR,
      settings: viewSettings,
      backup: viewBackup
    })[state.view](v);
  }

  function card(title, body, actions) {
    return '<section class="card"><div class="card-head"><h2>' + title + '</h2>' +
      (actions ? '<div class="card-actions">' + actions + '</div>' : '') +
      '</div><div class="card-body">' + body + '</div></section>';
  }

  /* ===================== DASHBOARD ===================== */
  function viewDashboard(v) {
    var emps = scopeEmps(S.list('employees'));
    var active = emps.filter(function (e) { return e.active !== false; });
    var loans = S.list('loans').filter(function (l) { return l.active && l.balance > 0; });
    var totalMonthly = active.reduce(function (s, e) {
      return s + PH.payroll.rates(e).monthlyBasic;
    }, 0);
    var loanBal = loans.reduce(function (s, l) { return s + (l.balance || 0); }, 0);

    var stats =
      '<div class="stat-grid">' +
        stat('Active Employees', active.length, '👥') +
        stat('Monthly Basic Payroll', money(totalMonthly), '💵') +
        stat('Open Loans', loans.length, '🏦') +
        stat('Loan Balance', money(loanBal), '📉') +
      '</div>';

    var periods = periodsChrono(scopePeriods(S.list('periods')));
    var periodRows = periods.length ? periods.map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.startDate) + ' → ' + esc(p.endDate) +
        '</td><td>' + esc(p.frequency) + '</td><td><span class="badge ' +
        (p.status === 'finalized' ? 'badge-ok' : 'badge-draft') + '">' + esc(p.status) + '</span></td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">No payroll periods yet.</td></tr>';

    v.innerHTML = stats +
      card('Payroll Periods',
        '<table class="tbl"><thead><tr><th>Name</th><th>Coverage</th><th>Frequency</th><th>Status</th></tr></thead><tbody>' +
        periodRows + '</tbody></table>') +
      card('Getting Started',
        '<ol class="steps">' +
        '<li>Add your <b>employees</b> with their salary, rate factor and government IDs.</li>' +
        '<li>Set up recurring <b>allowances</b> and any active <b>loans</b>.</li>' +
        '<li>Create a payroll <b>period</b>, then <b>upload the DTR</b> (CSV) for that period.</li>' +
        '<li>Go to <b>Run Payroll</b> to compute, review, print payslips and finalize.</li>' +
        '</ol><p class="disclaimer">⚠️ Statutory tables (SSS, PhilHealth, Pag-IBIG, BIR) change periodically. ' +
        'Review the values under <b>Statutory Settings</b> against the latest official circulars before each run.</p>');
  }
  function stat(label, val, ico) {
    return '<div class="stat"><div class="stat-ico">' + ico + '</div><div>' +
      '<div class="stat-val">' + val + '</div><div class="stat-label">' + label + '</div></div></div>';
  }

  /* ===================== EMPLOYEES ===================== */
  // Build the bulk monthly-schedule template (CSV) for a month: one row per active
  // (in-scope) employee per date, pre-filled from each employee's current effective
  // schedule. A blank Time In/Out means a rest day.
  function schedPad(n) { return (n < 10 ? '0' : '') + n; }
  function csvCell(s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function scheduleTemplateCsv(ym) {
    var p = ym.split('-'), year = +p[0], mon = (+p[1]) - 1;
    var daysIn = new Date(year, mon + 1, 0).getDate();
    var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var emps = scopeEmps(S.list('employees')).filter(function (e) { return e.active !== false; });
    var lines = ['EmployeeCode,EmployeeName,Date,Weekday,TimeIn,TimeOut'];
    emps.forEach(function (e) {
      for (var day = 1; day <= daysIn; day++) {
        var iso = year + '-' + schedPad(mon + 1) + '-' + schedPad(day);
        var s = PH.dtr.scheduleForDate(e, iso);
        var inV = s.off ? '' : (s.in || ''), outV = s.off ? '' : (s.out || '');
        lines.push([csvCell(e.code), csvCell(((e.lastName || '') + ', ' + (e.firstName || '')).replace(/^, |, $/g, '')),
          iso, WD[new Date(year, mon, day).getDay()], inV, outV].join(','));
      }
    });
    return lines.join('\n');
  }
  // Apply a parsed schedule template to the employees' monthly grids. Each
  // (employee, month) present in the file replaces that month entirely.
  function applyScheduleImport(parsed) {
    var codeMap = {};
    S.list('employees').forEach(function (e) { if (e.code) codeMap[String(e.code).trim().toLowerCase()] = e; });
    var matched = {}, months = {}, unmatched = [];
    Object.keys(parsed.byCode).forEach(function (code) {
      var emp = codeMap[code.trim().toLowerCase()];
      if (!emp) { unmatched.push(code); return; }
      emp.monthSchedule = emp.monthSchedule || {};
      Object.keys(parsed.byCode[code]).forEach(function (ym) {
        emp.monthSchedule[ym] = parsed.byCode[code][ym]; // month is now the source of truth
        months[ym] = true;
      });
      // Drop any now-empty monthSchedule to keep the record tidy.
      if (!Object.keys(emp.monthSchedule).length) delete emp.monthSchedule;
      matched[emp.id] = true;
      S.upsert('employees', emp);
    });
    return { employees: Object.keys(matched).length, months: Object.keys(months).length, unmatched: unmatched };
  }

  function viewEmployees(v) {
    var hasLoc = locations().length > 0;
    var emps = scopeEmps(S.list('employees'));
    var rows = emps.length ? emps.map(function (e) {
      var r = PH.payroll.rates(e);
      return '<tr><td><b>' + esc(e.code) + '</b></td><td>' +
        (IS_ONLINE ? '<img src="/api/admin/photo/' + encodeURIComponent(e.code || '') + '" style="width:26px;height:26px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px" onerror="this.style.display=\'none\'">' : '') +
        esc(e.lastName + ', ' + e.firstName) +
        '</td><td>' + esc(e.position || '') + '</td>' +
        (hasLoc ? '<td>' + esc(locationName(e.locationId) || '—') + '</td>' : '') +
        '<td>' + esc(e.employmentType) +
        '</td><td>' + money(e.basicSalary) + '</td><td>' + money(r.daily) +
        '</td><td>' + (e.active !== false ? '<span class="badge badge-ok">active</span>' : '<span class="badge">inactive</span>') +
        '</td><td class="row-actions">' +
        '<button class="btn-sm" data-emp-view="' + e.id + '">201 File</button>' +
        '<button class="btn-sm" data-emp-edit="' + e.id + '">Edit</button>' +
        '<button class="btn-sm btn-danger" data-emp-del="' + e.id + '">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="' + (hasLoc ? 9 : 8) + '" class="muted">No employees' + (state.locationId ? ' in this location' : ' yet. Click "Add Employee"') + '.</td></tr>';

    v.innerHTML = govIdCheckCard(emps.filter(function (e) { return e.active !== false; })) +
      card('Employees' + (state.locationId ? ' — ' + esc(locationName(state.locationId)) : ''),
      '<table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Position</th>' +
      (hasLoc ? '<th>Location</th>' : '') + '<th>Type</th>' +
      '<th>Basic</th><th>Daily Rate</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table>',
      '<button class="btn" data-emp-add>+ Add Employee</button>');

    var schMonth = new Date().toISOString().slice(0, 7);
    v.innerHTML += card('Bulk Monthly Schedule',
      '<p class="sub">Download a template for a month (pre-filled with each employee\'s current schedule), edit the ' +
      '<b>Time In</b> / <b>Time Out</b> columns in Excel, then upload it to set everyone\'s schedule for that month at once. ' +
      'A blank Time In/Out means a <b>rest day</b>. Uploading replaces each employee\'s schedule for the months in the file.</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' +
        '<label class="fld" style="max-width:200px"><span class="fld-label">Month</span><input type="month" id="schTplMonth" value="' + schMonth + '"></label>' +
        '<button class="btn" id="schTplDl">Download template</button>' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">' +
        '<input type="file" id="schTplFile" accept=".csv,text/csv">' +
        '<button class="btn" id="schTplUp">Upload filled template</button>' +
        '<span id="schTplMsg" class="msg"></span>' +
      '</div>');

    v.querySelector('[data-emp-add]').addEventListener('click', function () { employeeForm(); });
    v.querySelector('#schTplDl').addEventListener('click', function () {
      var ym = v.querySelector('#schTplMonth').value || schMonth;
      if (!scopeEmps(S.list('employees')).filter(function (e) { return e.active !== false; }).length) {
        v.querySelector('#schTplMsg').textContent = 'No active employees to include.'; v.querySelector('#schTplMsg').className = 'msg err'; return;
      }
      downloadFile('schedule_template_' + ym + '.csv', scheduleTemplateCsv(ym), 'text/csv');
    });
    v.querySelector('#schTplUp').addEventListener('click', function () {
      var file = v.querySelector('#schTplFile').files[0];
      var msg = v.querySelector('#schTplMsg');
      if (!file) { msg.textContent = 'Choose the filled template CSV first.'; msg.className = 'msg err'; return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = PH.dtr.importScheduleCsv(reader.result);
          if (!Object.keys(parsed.byCode).length) { msg.className = 'msg err'; msg.textContent = 'No schedule rows found. Check the file has EmployeeCode, Date, TimeIn, TimeOut columns.'; return; }
          var res = applyScheduleImport(parsed);
          S.save();
          msg.className = 'msg ok';
          msg.textContent = 'Updated ' + res.employees + ' employee(s) across ' + res.months + ' month(s).' +
            (parsed.invalid ? ' Skipped ' + parsed.invalid + ' invalid time value(s).' : '') +
            (res.unmatched.length ? ' Unmatched codes: ' + res.unmatched.join(', ') : '');
          renderView();
        } catch (err) { msg.className = 'msg err'; msg.textContent = 'Import failed: ' + err.message; }
      };
      reader.readAsText(file);
    });
    v.querySelectorAll('[data-emp-view]').forEach(function (b) {
      b.addEventListener('click', function () { view201(S.find('employees', b.dataset.empView)); });
    });
    v.querySelectorAll('[data-emp-edit]').forEach(function (b) {
      b.addEventListener('click', function () { employeeForm(S.find('employees', b.dataset.empEdit)); });
    });
    v.querySelectorAll('[data-emp-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (confirm('Delete this employee?')) { S.remove('employees', b.dataset.empDel); renderView(); }
      });
    });
  }

  // Summary card of government-ID problems across active employees.
  function govIdCheckCard(emps) {
    var dupMap = govIdDuplicateMap(emps);
    var issues = [];
    emps.forEach(function (e) {
      var probs = [];
      GOV_ID_KEYS.forEach(function (type) {
        var iss = govIdIssue(type, e[GOV_ID[type].field]);
        if (iss) probs.push(iss.msg);
        if (dupMap[type] && dupMap[type][e.id]) probs.push(GOV_ID[type].label + ' number is duplicated with another employee');
      });
      if (probs.length) issues.push({ name: e.lastName + ', ' + e.firstName + ' (' + (e.code || '—') + ')', probs: probs });
    });
    if (!emps.length) return '';
    if (!issues.length) {
      return card('Government ID Check',
        '<p style="color:var(--ok);margin:0"><b>✓ All ' + emps.length + ' active employees</b> have SSS, PhilHealth, Pag-IBIG and TIN numbers in a valid format with no duplicates.</p>');
    }
    var list = issues.map(function (it) {
      return '<li><b>' + esc(it.name) + '</b><ul>' + it.probs.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></li>';
    }).join('');
    return card('Government ID Check',
      '<p class="muted">These issues can cause rejected SSS/PhilHealth/Pag-IBIG/BIR remittances. Fix them before filing. ' +
      '(A valid format is checked here; the agencies remain the authority on whether a number belongs to a person.)</p>' +
      '<div style="color:var(--warn)"><b>' + issues.length + ' employee(s)</b> need attention:</div><ul class="idcheck">' + list + '</ul>');
  }

  function employeeForm(emp) {
    emp = emp || { employmentType: 'monthly', dailyRateFactor: 313, workDaysPerWeek: 6, restDay: 0, active: true, contributionBasis: 'basic' };
    function txt(name, label, type) {
      return field(label, '<input name="' + name + '" type="' + (type || 'text') + '" value="' + esc(emp[name] || '') + '">');
    }
    // ---- Monthly schedule grid ------------------------------------------------
    // Each calendar month can carry an explicit per-date shift. The grid is the
    // source of truth for any month it configures: a day left blank is a rest day.
    // Months never configured here fall back to the base Work Schedule above.
    var MS_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    var MS_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var monthSched = emp.monthSchedule ? JSON.parse(JSON.stringify(emp.monthSchedule)) : {};
    var msTouched = {}; // months the admin actively edited/cleared this session
    function msPad(n) { return (n < 10 ? '0' : '') + n; }
    function msKeyOf(d) { return d.getFullYear() + '-' + msPad(d.getMonth() + 1); }
    var msCur = msKeyOf(new Date());
    function msPrevKey(k) { var p = k.split('-'); var d = new Date(+p[0], +p[1] - 1, 1); d.setMonth(d.getMonth() - 1); return msKeyOf(d); }
    function msLabel(k) { var p = k.split('-'); return MS_MONTHS[(+p[1]) - 1] + ' ' + p[0]; }
    function msSplit(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? [msPad(+m[1]), m[2]] : ['', '']; }
    function msHrOpts(sel) { var o = '<option value="">—</option>'; for (var h = 0; h < 24; h++) { var v = msPad(h); o += '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + v + '</option>'; } return o; }
    function msMinOpts(sel) { var o = '<option value="">—</option>'; for (var m = 0; m < 60; m += 5) { var v = msPad(m); o += '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + v + '</option>'; } return o; }
    function msBaseShift() {
      var f = msOv && msOv.querySelector('form');
      var gi = f && f.querySelector('[name=schedTimeIn]'), go = f && f.querySelector('[name=schedTimeOut]');
      var i = (gi && gi.value) || emp.schedTimeIn || '08:00';
      var o = (go && go.value) || emp.schedTimeOut || '17:00';
      return { in: msSplit(i)[0] ? i : '08:00', out: msSplit(o)[0] ? o : '17:00' };
    }
    var msOv = null; // set to the modal overlay once created
    function renderMonthGrid() {
      var host = msOv && msOv.querySelector('#monthSchedHost');
      if (!host) return;
      var p = msCur.split('-'); var year = +p[0], mon = (+p[1]) - 1;
      var daysIn = new Date(year, mon + 1, 0).getDate();
      var monthObj = monthSched[msCur] || {};
      var rows = '';
      for (var day = 1; day <= daysIn; day++) {
        var e = monthObj[day] || monthObj[String(day)] || {};
        var ip = msSplit(e.in), op = msSplit(e.out);
        var wd = new Date(year, mon, day).getDay();
        var rest = !(e.in || e.out);
        rows += '<tr data-day="' + day + '"' + (rest ? ' class="ms-rest"' : '') + '>' +
          '<td>' + day + '</td><td class="ms-wd">' + MS_WD[wd] + '</td>' +
          '<td><select class="ms-ih">' + msHrOpts(ip[0]) + '</select> : <select class="ms-im">' + msMinOpts(ip[1]) + '</select></td>' +
          '<td><select class="ms-oh">' + msHrOpts(op[0]) + '</select> : <select class="ms-om">' + msMinOpts(op[1]) + '</select></td>' +
          '<td class="ms-tag" style="color:#94a3b8;font-size:12px">' + (rest ? 'Rest day' : '') + '</td></tr>';
      }
      host.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
          '<button type="button" class="btn sm" data-ms="prev">‹</button>' +
          '<b style="min-width:130px;text-align:center">' + msLabel(msCur) + '</b>' +
          '<button type="button" class="btn sm" data-ms="next">›</button>' +
          '<span style="flex:1"></span>' +
          '<button type="button" class="btn sm" data-ms="copy">Copy previous month</button>' +
          '<button type="button" class="btn sm" data-ms="fill">Fill all with default shift</button>' +
          '<button type="button" class="btn sm ghost" data-ms="clear">Clear month (all rest)</button>' +
        '</div>' +
        '<div style="max-height:340px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px">' +
        '<table class="tbl"><thead><tr><th>Date</th><th>Day</th><th>Time In</th><th>Time Out</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      wireMonthGrid(host);
    }
    function msEnsureMonth() { msTouched[msCur] = true; if (!monthSched[msCur]) monthSched[msCur] = {}; return monthSched[msCur]; }
    function msUpdateRow(tr) {
      var ih = tr.querySelector('.ms-ih').value, im = tr.querySelector('.ms-im').value;
      var oh = tr.querySelector('.ms-oh').value, om = tr.querySelector('.ms-om').value;
      var inV = ih !== '' ? (ih + ':' + (im || '00')) : '';
      var outV = oh !== '' ? (oh + ':' + (om || '00')) : '';
      var m = msEnsureMonth(); var day = tr.getAttribute('data-day');
      if (inV || outV) m[day] = { in: inV, out: outV }; else delete m[day];
      var rest = !(inV || outV);
      tr.classList.toggle('ms-rest', rest);
      tr.querySelector('.ms-tag').textContent = rest ? 'Rest day' : '';
    }
    function wireMonthGrid(host) {
      host.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.querySelectorAll('select').forEach(function (sel) {
          sel.addEventListener('change', function () { msUpdateRow(tr); });
        });
      });
      host.querySelectorAll('[data-ms]').forEach(function (b) {
        b.onclick = function () {
          var act = b.getAttribute('data-ms');
          if (act === 'prev') { var pp = msCur.split('-'); var d = new Date(+pp[0], +pp[1] - 1, 1); d.setMonth(d.getMonth() - 1); msCur = msKeyOf(d); renderMonthGrid(); }
          else if (act === 'next') { var np = msCur.split('-'); var d2 = new Date(+np[0], +np[1] - 1, 1); d2.setMonth(d2.getMonth() + 1); msCur = msKeyOf(d2); renderMonthGrid(); }
          else if (act === 'copy') {
            var src = monthSched[msPrevKey(msCur)];
            if (!src || !Object.keys(src).length) { alert('The previous month (' + msLabel(msPrevKey(msCur)) + ') has no schedule to copy.'); return; }
            msTouched[msCur] = true; monthSched[msCur] = JSON.parse(JSON.stringify(src)); renderMonthGrid();
          } else if (act === 'fill') {
            var bs = msBaseShift(); var pp2 = msCur.split('-'); var di = new Date(+pp2[0], +pp2[1], 0).getDate();
            var mo = msEnsureMonth(); for (var dd = 1; dd <= di; dd++) mo[dd] = { in: bs.in, out: bs.out }; renderMonthGrid();
          } else if (act === 'clear') {
            msTouched[msCur] = true; monthSched[msCur] = {}; renderMonthGrid();
          }
        };
      });
    }
    var body =
      '<h4 class="form-section">Personal Information</h4><div class="grid2">' +
        txt('code', 'Employee Code') + txt('firstName', 'First Name') +
        txt('middleName', 'Middle Name') + txt('lastName', 'Last Name') +
        txt('birthDate', 'Date of Birth', 'date') +
        field('Civil Status', select('civilStatus', ['Single', 'Married', 'Widowed', 'Separated'], emp.civilStatus || 'Single')) +
        txt('contactNumber', 'Contact Number') + txt('email', 'Email') +
        '<label class="fld fld-wide"><span class="fld-label">Home Address</span>' +
        '<input name="address" value="' + esc(emp.address || '') + '"></label>' +
      '</div>' +
      '<h4 class="form-section">Employment</h4><div class="grid2">' +
        (locations().length ? field('Location / Branch',
          select('locationId', [['', '— none —']].concat(locations().map(function (l) { return [l.id, l.name]; })), emp.locationId || '')) : '') +
        txt('position', 'Position') + txt('department', 'Department') +
        txt('hireDate', 'Date Hired', 'date') + txt('regularizationDate', 'Regularization Date', 'date') +
        field('Employment Status',
          select('employmentStatus', [['probationary','Probationary'],['regular','Regular'],['contractual','Contractual']], emp.employmentStatus || 'probationary') +
          '<small class="hint">Regular employees are entitled to Service Incentive Leave.</small>') +
        field('Employment Type', select('employmentType', ['monthly', 'daily', 'hourly'], emp.employmentType)) +
        field('Basic Salary / Rate',
          '<input name="basicSalary" type="number" step="0.01" value="' + (emp.basicSalary || '') + '">' +
          '<small class="hint">Monthly basic for "monthly"; daily rate for "daily"; hourly rate for "hourly".</small>') +
        field('Working-Days Factor (per year)',
          '<input name="dailyRateFactor" type="number" value="' + (emp.dailyRateFactor || 313) + '">' +
          '<small class="hint">313 (6-day wk), 261 (5-day wk), or 365 (with rest-day pay).</small>') +
        field('Work Days / Week', '<input name="workDaysPerWeek" type="number" value="' + (emp.workDaysPerWeek || 6) + '">') +
        field('Rest Day', select('restDay', [['0','Sunday'],['1','Monday'],['2','Tuesday'],['3','Wednesday'],['4','Thursday'],['5','Friday'],['6','Saturday']], String(emp.restDay || 0))) +
        field('Contribution Basis', select('contributionBasis', [['basic','Monthly Basic Salary'],['gross','Gross Pay']], emp.contributionBasis || 'basic')) +
        field('Status', select('active', [['true','Active'],['false','Inactive']], String(emp.active !== false))) +
      '</div>' +
      '<h4 class="form-section">Statutory Deductions</h4>' +
      '<p class="sub">Probationary employees may opt out of government deductions for their first six months; switch these to “Deduct” once regularized. When off, both the employee and employer share are skipped and the employee is left off that agency’s remittance report.</p>' +
      '<div class="grid3">' +
        field('SSS', select('deductSSS', [['true','Deduct'],['false','Not deducted']], String(emp.deductSSS !== false))) +
        field('PhilHealth', select('deductPhilHealth', [['true','Deduct'],['false','Not deducted']], String(emp.deductPhilHealth !== false))) +
        field('Pag-IBIG', select('deductPagIBIG', [['true','Deduct'],['false','Not deducted']], String(emp.deductPagIBIG !== false))) +
      '</div>' +
      '<h4 class="form-section">Work Schedule</h4>' +
      '<p class="sub">This is the <b>default</b> shift used for every day. If a staff member works different hours on different days, set those below in the per-day schedule.</p>' +
      '<div class="grid2">' +
        field('Shift Time In',
          '<input name="schedTimeIn" value="' + esc(emp.schedTimeIn || '') + '" placeholder="08:00">' +
          '<small class="hint">Used to detect tardiness. Leave blank to pay purely by hours worked.</small>') +
        field('Shift Time Out',
          '<input name="schedTimeOut" value="' + esc(emp.schedTimeOut || '') + '" placeholder="17:00">' +
          '<small class="hint">Work beyond this counts as overtime (per your OT policy).</small>') +
        field('Break (minutes)', '<input name="schedBreakMins" type="number" value="' + (emp.schedBreakMins != null ? emp.schedBreakMins : 60) + '">') +
      '</div>' +
      '<h4 class="form-section">Monthly Schedule</h4>' +
      '<p class="sub">Set each day\'s <b>Time In</b> and <b>Time Out</b> for the month using the drop-downs. ' +
      'Leave a day blank to make it a <b>rest day</b> (work rendered then earns rest-day pay). ' +
      'Use <b>Copy previous month</b> to duplicate last month\'s pattern, or <b>Fill all with default shift</b> to apply the shift above to every day. ' +
      'Months you don\'t set here fall back to the default shift.</p>' +
      '<div id="monthSchedHost"></div>' +
      '<h4 class="form-section">Leave Credits (Service Incentive Leave)</h4><div class="grid2">' +
        field('Leave Credits / Year',
          '<input name="leaveCreditsPerYear" type="number" step="0.5" value="' + (emp.leaveCreditsPerYear != null ? emp.leaveCreditsPerYear : (emp.employmentStatus === 'regular' ? 5 : 0)) + '">' +
          '<small class="hint">Regular employees: 5 days (SIL). Set 0 for probationary/contractual.</small>') +
        field('Leave Credits Used',
          '<input name="leaveCreditsUsed" type="number" step="0.5" value="' + (emp.leaveCreditsUsed || 0) + '">' +
          '<small class="hint">Auto-increases when paid leave is taken. Reset to 0 at the start of each year.</small>') +
      '</div>' +
      '<h4 class="form-section">Government IDs</h4><div class="grid2">' +
        txt('sssNo', 'SSS No.') + txt('philhealthNo', 'PhilHealth No.') +
        txt('pagibigNo', 'Pag-IBIG No.') + txt('tin', 'TIN') +
        field('Biometric / Device ID',
          '<input name="biometricId" value="' + esc(emp.biometricId || '') + '">' +
          '<small class="hint">The user ID/number on the biometric time clock (e.g. NGTeco). Used to match imported attendance.</small>') +
      '</div>' +
      '<h4 class="form-section">Bank Details (for salary credit)</h4><div class="grid2">' +
        txt('bankName', 'Bank Name') + txt('bankAccountName', 'Account Name') +
        txt('bankAccountNumber', 'Account Number') +
      '</div>' +
      '<h4 class="form-section">Emergency Contact</h4><div class="grid2">' +
        txt('emergencyName', 'Contact Name') + txt('emergencyRelation', 'Relationship') +
        txt('emergencyContact', 'Contact Number') +
      '</div>';
    var ov = modal((emp.id ? 'Edit' : 'Add') + ' Employee', body, function (form) {
      var data = collect(form);
      data.id = emp.id;
      data.basicSalary = parseFloat(data.basicSalary) || 0;
      data.dailyRateFactor = parseInt(data.dailyRateFactor, 10) || 313;
      data.workDaysPerWeek = parseInt(data.workDaysPerWeek, 10) || 6;
      data.restDay = parseInt(data.restDay, 10) || 0;
      data.leaveCreditsPerYear = parseFloat(data.leaveCreditsPerYear) || 0;
      data.leaveCreditsUsed = parseFloat(data.leaveCreditsUsed) || 0;
      data.schedBreakMins = data.schedBreakMins !== '' ? (parseInt(data.schedBreakMins, 10) || 0) : 60;
      // Preserve any legacy per-weekday schedule as-is (still honoured as a fallback
      // for months not configured in the monthly grid).
      if (emp.weekSchedule) data.weekSchedule = emp.weekSchedule;
      // Serialise the monthly schedule: drop empty months so only configured
      // months are kept (a configured month with all-blank days stays, meaning
      // every day that month is a rest day).
      var msClean = {};
      Object.keys(monthSched).forEach(function (k) {
        var mo = monthSched[k] || {}; var kept = {};
        Object.keys(mo).forEach(function (d) {
          var e = mo[d]; if (e && (e.in || e.out)) kept[d] = { in: e.in || '', out: e.out || '' };
        });
        // Keep the month if it has entries, OR the admin actively configured it
        // this session (e.g. cleared it to mean "all rest days"), OR it was already
        // stored on the record. Merely viewing an empty month does not persist it.
        if (Object.keys(kept).length || msTouched[k] || (emp.monthSchedule && emp.monthSchedule[k])) msClean[k] = kept;
      });
      if (Object.keys(msClean).length) data.monthSchedule = msClean; else delete data.monthSchedule;
      data.active = data.active === 'true';
      data.deductSSS = data.deductSSS === 'true';
      data.deductPhilHealth = data.deductPhilHealth === 'true';
      data.deductPagIBIG = data.deductPagIBIG === 'true';
      if (!data.code || !data.lastName) { alert('Code and Last Name are required.'); return false; }
      // Warn (but allow override) on malformed or duplicated government IDs.
      var idProblems = [];
      var others = S.list('employees').filter(function (e) { return e.id !== data.id; });
      GOV_ID_KEYS.forEach(function (type) {
        var f = GOV_ID[type].field;
        var iss = govIdIssue(type, data[f]);
        if (iss && iss.level === 'invalid') idProblems.push(iss.msg);
        var d = digitsOf(data[f]);
        if (d && others.some(function (e) { return digitsOf(e[f]) === d; }))
          idProblems.push(GOV_ID[type].label + ' number is already used by another employee');
      });
      if (idProblems.length && !confirm('Please double-check these government IDs:\n\n• ' + idProblems.join('\n• ') + '\n\nSave anyway?')) return false;
      S.upsert('employees', data);
      renderView();
    }, 'wide');
    msOv = ov;
    renderMonthGrid();
  }

  /* ---- 201 File (printable employee record) ---- */
  function view201(emp) {
    var comp = S.db.meta.company;
    var loans = S.list('loans').filter(function (l) { return l.employeeId === emp.id; });
    var alw = S.list('allowances').filter(function (a) { return a.employeeId === emp.id; });
    var r = PH.payroll.rates(emp);
    function row(label, val) {
      return '<tr><td class="f201-l">' + label + '</td><td>' + esc(val || '—') + '</td></tr>';
    }
    // Government-ID row with a format/duplicate validity mark.
    var dupMap = govIdDuplicateMap(S.list('employees'));
    function idRow(type) {
      var rule = GOV_ID[type], val = emp[rule.field], iss = govIdIssue(type, val), mark;
      if (!val) mark = ' <span class="muted">— missing</span>';
      else if (iss && iss.level === 'invalid') mark = ' <span style="color:var(--warn)" title="' + esc(iss.msg) + '">⚠ check format</span>';
      else mark = ' <span style="color:var(--ok)">✓</span>';
      if (dupMap[type] && dupMap[type][emp.id]) mark += ' <span style="color:var(--danger)" title="Same number used by another employee">⚠ duplicate</span>';
      return '<tr><td class="f201-l">' + rule.label + ' No.</td><td>' + esc(val || '—') + mark + '</td></tr>';
    }
    var loanRows = loans.length ? loans.map(function (l) {
      return '<tr><td>' + esc(l.type) + (l.reference ? ' — ' + esc(l.reference) : '') +
        '</td><td class="num">' + money(l.monthlyAmortization) + '</td><td class="num">' + money(l.balance) +
        '</td><td>' + (l.active ? 'Active' : 'Closed') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">None</td></tr>';
    var alwRows = alw.length ? alw.map(function (a) {
      return '<tr><td>' + esc(a.name) + '</td><td>' + esc(a.type || 'allowance') +
        '</td><td class="num">' + money(a.amount) + '</td><td>' + (a.taxable ? 'Taxable' : 'Non-taxable') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">None</td></tr>';

    var html = '<div class="f201" id="f201print">' +
      '<div class="f201-head"><div><div class="f201-co">' + esc(comp.name) + '</div>' +
      '<div class="f201-sub">' + esc(comp.address || '') + '</div></div>' +
      '<div class="f201-title">EMPLOYEE 201 FILE</div></div>' +
      '<div class="f201-name">' + esc([emp.lastName, emp.firstName].filter(Boolean).join(', ')) +
      (emp.middleName ? ' ' + esc(emp.middleName) : '') + ' <span class="f201-code">' + esc(emp.code) + '</span></div>' +
      '<div class="f201-grid">' +
        '<div><h4>Personal</h4><table class="f201-tbl">' +
          row('Date of Birth', emp.birthDate) + row('Civil Status', emp.civilStatus) +
          row('Contact Number', emp.contactNumber) + row('Email', emp.email) +
          row('Home Address', emp.address) + '</table></div>' +
        '<div><h4>Employment</h4><table class="f201-tbl">' +
          row('Position', emp.position) + row('Department', emp.department) +
          row('Employment Status', cap(emp.employmentStatus)) +
          row('Date Hired', emp.hireDate) + row('Regularization', emp.regularizationDate) +
          row('Employment Type', emp.employmentType) + row('Basic Salary/Rate', money(emp.basicSalary)) +
          row('Daily Rate', money(r.daily)) +
          row('Work Schedule', (emp.schedTimeIn && emp.schedTimeOut) ? (emp.schedTimeIn + ' – ' + emp.schedTimeOut + ' (' + (emp.schedBreakMins != null ? emp.schedBreakMins : 60) + 'm break)') : 'Not set') +
          row('Leave Credits (yr)', (emp.leaveCreditsPerYear || 0) + ' — used ' + (emp.leaveCreditsUsed || 0) +
            ', ' + Math.max(0, (emp.leaveCreditsPerYear || 0) - (emp.leaveCreditsUsed || 0)) + ' left') +
          row('Status', emp.active !== false ? 'Active' : 'Inactive') +
          '</table></div>' +
        '<div><h4>Government IDs</h4><table class="f201-tbl">' +
          idRow('sss') + idRow('philhealth') + idRow('pagibig') + idRow('tin') +
          row('Deductions', 'SSS: ' + (emp.deductSSS !== false ? 'Yes' : 'No') +
            ' · PhilHealth: ' + (emp.deductPhilHealth !== false ? 'Yes' : 'No') +
            ' · Pag-IBIG: ' + (emp.deductPagIBIG !== false ? 'Yes' : 'No')) + '</table></div>' +
        '<div><h4>Bank Details (Salary Credit)</h4><table class="f201-tbl">' +
          row('Bank', emp.bankName) + row('Account Name', emp.bankAccountName) +
          row('Account Number', emp.bankAccountNumber) + '</table>' +
          '<h4 style="margin-top:12px">Emergency Contact</h4><table class="f201-tbl">' +
          row('Name', emp.emergencyName) + row('Relationship', emp.emergencyRelation) +
          row('Contact', emp.emergencyContact) + '</table></div>' +
      '</div>' +
      '<h4 class="f201-h">Allowances & Recurring Earnings</h4>' +
      '<table class="f201-list"><thead><tr><th>Name</th><th>Type</th><th class="num">Amount</th><th>Tax</th></tr></thead><tbody>' +
      alwRows + '</tbody></table>' +
      '<h4 class="f201-h">Loans, Advances & Deductibles</h4>' +
      '<table class="f201-list"><thead><tr><th>Type / Reference</th><th class="num">Amortization/mo</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>' +
      loanRows + '</tbody></table>' +
      '</div>';

    modal('201 File', html, null, 'wide',
      '<button class="btn" id="print201">Download PDF / Print</button>');
    qs('#print201').addEventListener('click', function () {
      printHTML('201 File — ' + emp.code, html);
    });
  }

  /* ===================== DTR ===================== */
  function viewDTR(v) {
    var periods = periodsChrono(scopePeriods(S.list('periods')));
    if (!periods.length) {
      v.innerHTML = card('DTR / Time Records',
        '<p class="muted">Create a payroll period first (under "Run Payroll") to attach a DTR.</p>');
      return;
    }
    var pid = state.selectedPeriod || defaultPeriodId(periods);
    state.selectedPeriod = pid;
    var period = S.find('periods', pid);
    var dtr = (S.db.dtr[pid]) || {};

    var byEmp = scopeEmps(S.list('employees')).map(function (e) {
      var days = dtr[e.id] || [];
      var sched = (e.schedTimeIn && e.schedTimeOut)
        ? esc(e.schedTimeIn + '–' + e.schedTimeOut)
        : '<span class="muted">not set</span>';
      return '<tr><td>' + esc(e.code) + '</td><td>' + esc(e.lastName + ', ' + e.firstName) +
        '</td><td>' + sched + '</td>' +
        '<td>' + days.length + ' day(s)</td><td class="row-actions">' +
        '<button class="btn-sm" data-dtr-edit="' + e.id + '">Enter / Edit</button>' +
        (days.length ? '<button class="btn-sm btn-danger" data-dtr-clear="' + e.id + '">Clear</button>' : '') +
        '</td></tr>';
    }).join('');

    v.innerHTML =
      card('Select Period',
        '<div class="inline">' + select('period', periods.map(function (p) { return [p.id, p.name]; }), pid) +
        '</div>', '') +
      card('Upload DTR (CSV)',
        '<p class="muted">Columns: <code>EmployeeCode, Date, TimeIn, TimeOut, Break, DayType, RestDay, ScheduledIn, ScheduledOut, Absent, LeaveType, RequiredHours</code>. ' +
        '<code>LeaveType</code> accepts <code>SL</code>, <code>VL</code> or <code>EL</code> (approved paid leave). ' +
        'Schedule columns are optional — the employee\'s profile schedule is used when they are blank. ' +
        'Times accept <code>08:00</code>, <code>8:00 AM</code> or <code>0800</code>. See <code>samples/sample_dtr.csv</code>.</p>' +
        '<input type="file" id="dtrFile" accept=".csv,text/csv">' +
        '<button class="btn" id="dtrImportBtn">Import into Period</button>' +
        '<div id="dtrImportMsg" class="msg"></div>') +
      card('Import from Biometric Device (NGTeco)',
        '<p class="muted">Export attendance from <b>NGTeco Office</b> (Excel/CSV) and import it here — punches are ' +
        'matched to employees by their <b>Biometric / Device ID</b> (set on the employee\'s profile), then paired ' +
        'into time-in / time-out per day for the selected period. Handles raw punch logs or in/out summaries.</p>' +
        '<input type="file" id="bioFile" accept=".csv,text/csv">' +
        '<button class="btn" id="bioImportBtn">Import Attendance</button>' +
        '<div id="bioImportMsg" class="msg"></div>') +
      card('DTR Status — ' + esc(period.name),
        '<p class="muted">Each employee\'s <b>schedule</b> (set in their profile) is used to compute tardiness, undertime and overtime automatically from the punches.</p>' +
        '<table class="tbl"><thead><tr><th>Code</th><th>Employee</th><th>Schedule</th><th>Records</th><th></th></tr></thead><tbody>' +
        byEmp + '</tbody></table>') +
      ((S.db.meta.overtime && S.db.meta.overtime.requireAuthorization !== false) ? card('Overtime Authorization',
        '<p class="muted">Overtime is only paid when authorized. Review the overtime detected in this period\'s punches and authorize it here — no need to wait for employees to file. Covers post-shift and pre-shift (early time-in) overtime.</p>' +
        '<button class="btn" id="otAuthBtn">Review &amp; Authorize Overtime</button>', '') : '') +
      (IS_ONLINE ? card('Uploaded Time Cards — ' + esc(period.name),
        '<p class="muted">Photos/scans of physical time cards submitted by employees for this period, for reference when checking the DTR.</p>' +
        '<div id="tcAdmin">Loading…</div>') : '');

    if (IS_ONLINE) loadAdminTimecards(pid);

    v.querySelector('[name=period]').addEventListener('change', function (e) {
      state.selectedPeriod = e.target.value; renderView();
    });
    v.querySelector('#dtrImportBtn').addEventListener('click', function () {
      var file = v.querySelector('#dtrFile').files[0];
      var msg = v.querySelector('#dtrImportMsg');
      if (!file) { msg.textContent = 'Choose a CSV file first.'; msg.className = 'msg err'; return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var imported = PH.dtr.importDTRCsv(reader.result);
          var codeMap = {};
          S.list('employees').forEach(function (e) { codeMap[e.code] = e.id; });
          var store = S.db.dtr[pid] = S.db.dtr[pid] || {};
          var matched = 0, unmatched = [];
          Object.keys(imported).forEach(function (code) {
            var eid = codeMap[code];
            if (eid) { store[eid] = imported[code]; matched++; }
            else unmatched.push(code);
          });
          S.save();
          msg.className = 'msg ok';
          msg.textContent = 'Imported DTR for ' + matched + ' employee(s).' +
            (unmatched.length ? ' Unmatched codes: ' + unmatched.join(', ') : '');
          renderView();
        } catch (err) { msg.className = 'msg err'; msg.textContent = 'Import failed: ' + err.message; }
      };
      reader.readAsText(file);
    });
    v.querySelector('#bioImportBtn').addEventListener('click', function () {
      var file = v.querySelector('#bioFile').files[0];
      var msg = v.querySelector('#bioImportMsg');
      if (!file) { msg.textContent = 'Choose the exported attendance file first.'; msg.className = 'msg err'; return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var byBio = PH.dtr.importBiometricCsv(reader.result);
          var res = importBiometricIntoPeriod(byBio, period);
          S.save(); renderView();
          var m2 = document.querySelector('#bioImportMsg');
          m2.className = 'msg ok';
          m2.textContent = 'Imported attendance for ' + res.matched + ' employee(s), ' + res.days + ' day(s) within ' +
            period.name + '.' + (res.unmatched.length ? ' Unmatched device IDs: ' + res.unmatched.join(', ') : '');
        } catch (err) { msg.className = 'msg err'; msg.textContent = 'Import failed: ' + err.message; }
      };
      reader.readAsText(file);
    });
    var otAuthBtn = v.querySelector('#otAuthBtn');
    if (otAuthBtn) otAuthBtn.addEventListener('click', function () { otAuthForm(pid); });
    v.querySelectorAll('[data-dtr-edit]').forEach(function (b) {
      b.addEventListener('click', function () { dtrForm(pid, b.dataset.dtrEdit); });
    });
    v.querySelectorAll('[data-dtr-clear]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (confirm('Clear DTR for this employee in this period?')) {
          delete S.db.dtr[pid][b.dataset.dtrClear]; S.save(); renderView();
        }
      });
    });
  }

  // Admin shortcut: authorize the overtime detected in a period's punches
  // directly (writes S.db.otApprovals), without waiting for employees to file.
  function otAuthForm(pid) {
    var period = S.find('periods', pid);
    var dtr = S.db.dtr[pid] || {};
    var otPolicy = S.db.meta.overtime || {};
    var approvals = S.db.otApprovals || {};
    var rows = [];
    S.list('employees').filter(function (e) { return e.active !== false; }).forEach(function (e) {
      (dtr[e.id] || []).forEach(function (d) {
        if (!d.date) return;
        var r = PH.dtr.computeDay(d, {
          defaultBreak: e.schedBreakMins != null ? e.schedBreakMins : 60,
          schedIn: e.schedTimeIn || null, schedOut: e.schedTimeOut || null,
          weekSchedule: e.weekSchedule || null, monthSchedule: e.monthSchedule || null,
          ot: otPolicy, requireOtAuth: false // want the ungated (potential) OT here
        });
        var post = r.otMinutes || 0, pre = r.preOtMinutes || 0;
        if (post <= 0 && pre <= 0) return;
        var appr = (approvals[e.id] && approvals[e.id][d.date]) || {};
        rows.push({ eid: e.id, name: e.lastName + ', ' + e.firstName, date: d.date,
          pre: pre, post: post, aPre: !!appr.before, aPost: !!appr.after });
      });
    });
    rows.sort(function (a, b) { return a.name.localeCompare(b.name) || a.date.localeCompare(b.date); });

    if (!rows.length) {
      modal('Authorize Overtime — ' + esc(period.name),
        '<p class="muted">No overtime was detected in this period\'s punches. Import the DTR/biometric file first, and make sure employees have a shift schedule set.</p>', null, 'wide');
      return;
    }
    function cell(row, kind) {
      var mins = kind === 'before' ? row.pre : row.post;
      if (mins <= 0) return '<span class="muted">—</span>';
      var checked = kind === 'before' ? row.aPre : row.aPost;
      return '<label class="acc-chk"><input type="checkbox" data-kind="' + kind + '"' + (checked ? ' checked' : '') +
        '> ' + (mins / 60).toFixed(2) + 'h</label>';
    }
    var body =
      '<p class="muted">Tick the overtime to authorize (it then becomes payable). <b>Pre-shift</b> = clocked in before shift start; <b>After shift</b> = worked past shift end.</p>' +
      '<div class="inline" style="margin-bottom:8px"><button class="btn-sm" id="otaAll" type="button">✓ Authorize all</button>' +
      '<button class="btn-sm" id="otaNone" type="button">✗ Clear all</button></div>' +
      '<div class="dtr-scroll"><table class="tbl"><thead><tr><th>Employee</th><th>Date</th><th>Pre-shift OT</th><th>After-shift OT</th></tr></thead><tbody>' +
      rows.map(function (row, i) {
        return '<tr data-otrow="' + i + '" data-eid="' + esc(row.eid) + '" data-date="' + esc(row.date) + '">' +
          '<td>' + esc(row.name) + '</td><td>' + esc(row.date) + ' <span class="sub">' + weekdayName(row.date) + '</span></td>' +
          '<td>' + cell(row, 'before') + '</td><td>' + cell(row, 'after') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    modal('Authorize Overtime — ' + esc(period.name), body, function (form) {
      form.querySelectorAll('tr[data-otrow]').forEach(function (tr) {
        var eid = tr.dataset.eid, date = tr.dataset.date;
        var preCb = tr.querySelector('[data-kind=before]'), postCb = tr.querySelector('[data-kind=after]');
        var before = !!(preCb && preCb.checked), after = !!(postCb && postCb.checked);
        S.db.otApprovals = S.db.otApprovals || {};
        var m = S.db.otApprovals[eid] = S.db.otApprovals[eid] || {};
        if (before || after) m[date] = { before: before, after: after };
        else delete m[date];
        if (Object.keys(m).length === 0) delete S.db.otApprovals[eid];
      });
      S.save();
      toast('Overtime authorizations saved.');
      renderView();
    }, 'wide');

    // "Authorize all / Clear all" convenience toggles (bind after modal is in DOM).
    setTimeout(function () {
      var all = document.getElementById('otaAll'), none = document.getElementById('otaNone');
      function setAll(val) { document.querySelectorAll('.modal tr[data-otrow] input[type=checkbox]').forEach(function (c) { c.checked = val; }); }
      if (all) all.addEventListener('click', function () { setAll(true); });
      if (none) none.addEventListener('click', function () { setAll(false); });
    }, 0);
  }

  function dtrForm(pid, empId) {
    var emp = S.find('employees', empId);
    var period = S.find('periods', pid);
    var days = ((S.db.dtr[pid] || {})[empId] || []).slice();
    function rowHtml(d, i) {
      d = d || {};
      return '<tr data-i="' + i + '">' +
        '<td><input name="date" type="date" value="' + esc(d.date || '') + '">' +
        (d.date ? '<div class="sub">' + weekdayName(d.date) + '</div>' : '') + '</td>' +
        '<td><input name="timeIn" value="' + esc(d.timeIn || '') + '"></td>' +
        '<td><input name="timeOut" value="' + esc(d.timeOut || '') + '"></td>' +
        '<td><input name="breakMins" type="number" value="' + (d.breakMins != null ? d.breakMins : (emp.schedBreakMins != null ? emp.schedBreakMins : 60)) + '" style="width:56px"></td>' +
        '<td>' + select('dayType', [['regular','Regular'],['special','Special Non-Wkg'],['regular_holiday','Reg. Holiday']], d.dayType || 'regular') + '</td>' +
        '<td style="text-align:center"><input name="restDay" type="checkbox"' + (d.restDay ? ' checked' : '') + '></td>' +
        '<td style="text-align:center"><input name="absent" type="checkbox"' + (d.absent ? ' checked' : '') + '></td>' +
        '<td>' + select('leaveType', [['','—'],['SL','SL'],['VL','VL'],['EL','EL'],['UAL','UAL']], d.leaveType || '') + '</td>' +
        '<td><button class="btn-sm btn-danger" data-row-del="' + i + '">✕</button></td></tr>';
    }
    // Auto-populate a row for every date in the coverage when nothing exists yet.
    if (!days.length && period && period.startDate && period.endDate) {
      days = coverageDays(period, emp);
    }
    if (!days.length) days.push({});
    var body =
      '<p class="muted">Dates below are auto-filled from the period coverage' +
      (period && period.startDate ? ' (' + esc(period.startDate) + ' to ' + esc(period.endDate) + ')' : '') +
      '. Just enter <b>In/Out</b> times, or tick <b>Rest</b> / <b>Absent</b>, or pick a <b>Leave</b> type (SL / VL / EL). ' +
      'Rest days are pre-ticked from the employee\'s rest day.</p>' +
      '<div class="dtr-scroll"><table class="tbl dtr-tbl"><thead><tr><th>Date</th><th>In</th><th>Out</th>' +
      '<th>Break</th><th>Day Type</th><th>Rest</th><th>Absent</th><th>Leave</th><th></th></tr></thead>' +
      '<tbody id="dtrRows">' + days.map(rowHtml).join('') + '</tbody></table></div>' +
      '<button class="btn-sm" id="dtrAddRow" type="button">+ Add Day</button>' +
      '<button class="btn-sm" id="dtrFillDates" type="button">↻ Re-fill coverage dates</button>';
    modal('DTR — ' + esc(emp.lastName + ', ' + emp.firstName), body, function (form) {
      var out = [];
      form.querySelectorAll('#dtrRows tr').forEach(function (tr) {
        var g = function (n) { var el = tr.querySelector('[name=' + n + ']'); return el; };
        var date = g('date').value;
        var tin = g('timeIn').value, tout = g('timeOut').value;
        var leaveType = g('leaveType').value;
        var restDay = g('restDay').checked, absent = g('absent').checked;
        // Skip completely empty rows (no date, no punches, no flags).
        if (!date && !tin && !tout && !leaveType && !restDay && !absent) return;
        out.push({
          date: date, timeIn: tin, timeOut: tout,
          breakMins: parseInt(g('breakMins').value, 10) || 0,
          dayType: g('dayType').value,
          restDay: restDay, absent: absent,
          leaveType: leaveType, leavePaid: !!leaveType
        });
      });
      S.db.dtr[pid] = S.db.dtr[pid] || {};
      if (out.length) S.db.dtr[pid][empId] = out; else delete S.db.dtr[pid][empId];
      S.save(); renderView();
    }, 'wide');

    var rowsEl = qs('#dtrRows');
    var counter = days.length;
    qs('#dtrAddRow').addEventListener('click', function () {
      var tmp = document.createElement('tbody');
      tmp.innerHTML = rowHtml({}, counter++);
      rowsEl.appendChild(tmp.firstChild);
      bindRowDel();
    });
    qs('#dtrFillDates').addEventListener('click', function () {
      if (!period || !period.startDate || !period.endDate) { alert('Set the period start and end dates first.'); return; }
      if (rowsEl.querySelector('input[name=timeIn]') &&
          !confirm('Replace the current rows with a fresh set of coverage dates? Any entries here will be cleared.')) return;
      var fresh = coverageDays(period, emp);
      counter = fresh.length;
      rowsEl.innerHTML = fresh.map(rowHtml).join('');
      bindRowDel();
    });
    function bindRowDel() {
      rowsEl.querySelectorAll('[data-row-del]').forEach(function (b) {
        b.onclick = function () { b.closest('tr').remove(); };
      });
    }
    bindRowDel();
  }

  // Build one blank DTR row per calendar date in the period, pre-marking the
  // employee's weekly rest day.
  function coverageDays(period, emp) {
    var out = [];
    var start = new Date(period.startDate + 'T00:00:00');
    var end = new Date(period.endDate + 'T00:00:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return out;
    var restDow = emp && emp.restDay != null ? parseInt(emp.restDay, 10) : -1;
    var guard = 0;
    for (var dt = new Date(start); dt <= end && guard < 400; dt.setDate(dt.getDate() + 1), guard++) {
      var iso = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
      out.push({ date: iso, dayType: 'regular', restDay: dt.getDay() === restDow });
    }
    return out;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function weekdayName(iso) {
    var d = new Date(iso + 'T00:00:00');
    return isNaN(d.getTime()) ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  }

  // Resolve a biometric device key to an employee: by Biometric/Device ID,
  // then employee code, then an exact name match.
  function resolveBioEmployee(key) {
    var k = String(key || '').trim();
    if (!k) return null;
    var kl = k.toLowerCase();
    var emps = S.list('employees');
    return emps.find(function (e) { return (e.biometricId || '').trim() === k; }) ||
      emps.find(function (e) { return e.code === k; }) ||
      emps.find(function (e) {
        var f = (e.firstName || '').toLowerCase().trim(), l = (e.lastName || '').toLowerCase().trim();
        return kl === (f + ' ' + l).trim() || kl === (l + ' ' + f).trim() || kl === (l + ', ' + f).trim();
      }) || null;
  }
  // Merge imported biometric days into a period's DTR (only dates in coverage).
  function importBiometricIntoPeriod(byBio, period) {
    var store = S.db.dtr[period.id] = S.db.dtr[period.id] || {};
    var matched = 0, dayCount = 0, unmatched = [];
    Object.keys(byBio).forEach(function (key) {
      var emp = resolveBioEmployee(key);
      if (!emp) { unmatched.push(key); return; }
      matched++;
      var byDate = {};
      (store[emp.id] || []).forEach(function (d) { byDate[d.date] = d; });
      byBio[key].forEach(function (day) {
        if (!day.date) return;
        if (period.startDate && day.date < period.startDate) return;
        if (period.endDate && day.date > period.endDate) return;
        var cur = byDate[day.date];
        if (cur) { cur.timeIn = day.timeIn; cur.timeOut = day.timeOut; cur.absent = false; cur.leaveType = ''; cur.leavePaid = false; }
        else {
          byDate[day.date] = { date: day.date, timeIn: day.timeIn, timeOut: day.timeOut,
            dayType: 'regular', breakMins: (emp.schedBreakMins != null ? emp.schedBreakMins : 60) };
        }
        dayCount++;
      });
      store[emp.id] = Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
    });
    return { matched: matched, days: dayCount, unmatched: unmatched };
  }

  /* ===================== EARNINGS (allowances/commissions) ===================== */
  function viewEarnings(v) {
    var emps = S.list('employees');
    var alw = S.list('allowances');
    var rows = alw.length ? alw.map(function (a) {
      var e = S.find('employees', a.employeeId);
      var basis = a.basis || (a.perPeriod ? 'perPeriod' : 'monthly');
      return '<tr><td>' + esc(e ? e.code : '?') + '</td><td>' + esc(a.name) +
        '</td><td>' + esc(a.type || 'allowance') + '</td><td>' + money(a.amount) +
        (basis === 'daily' ? '<span class="sub">/day present</span>' : '') +
        '</td><td>' + (a.taxable ? 'Taxable' : 'Non-taxable') +
        '</td><td>' + basisLabel(basis) + '</td>' +
        '<td class="row-actions"><button class="btn-sm" data-alw-edit="' + a.id + '">Edit</button>' +
        '<button class="btn-sm btn-danger" data-alw-del="' + a.id + '">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">No recurring allowances/commissions defined.</td></tr>';

    v.innerHTML = card('Recurring Allowances, Commissions & Other Earnings',
      '<p class="muted">These auto-apply every payroll run. One-off commissions/bonuses for a single period ' +
      'can be added directly in the "Run Payroll" screen.</p>' +
      '<table class="tbl"><thead><tr><th>Emp</th><th>Name</th><th>Type</th><th>Amount</th>' +
      '<th>Tax</th><th>Frequency</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>',
      emps.length ? '<button class="btn" data-alw-add>+ Add Earning</button>' : '');

    var addBtn = v.querySelector('[data-alw-add]');
    if (addBtn) addBtn.addEventListener('click', function () { earningForm(); });
    v.querySelectorAll('[data-alw-edit]').forEach(function (b) {
      b.addEventListener('click', function () { earningForm(S.find('allowances', b.dataset.alwEdit)); });
    });
    v.querySelectorAll('[data-alw-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (confirm('Delete this earning?')) { S.remove('allowances', b.dataset.alwDel); renderView(); }
      });
    });
  }

  function basisLabel(basis) {
    return { monthly: 'Monthly', perPeriod: 'Per Period', daily: 'Per Day Present' }[basis] || 'Monthly';
  }

  function earningForm(a) {
    a = a || { taxable: false, type: 'allowance', basis: 'monthly' };
    var basis = a.basis || (a.perPeriod ? 'perPeriod' : 'monthly');
    var empOpts = S.list('employees').map(function (e) { return [e.id, e.code + ' — ' + e.lastName + ', ' + e.firstName]; });
    var body = '<div class="grid2">' +
      field('Employee', select('employeeId', empOpts, a.employeeId)) +
      field('Name', '<input name="name" value="' + esc(a.name || '') + '">') +
      field('Type', select('type', [['allowance','Allowance'],['commission','Commission'],['benefit','Benefit'],['other','Other']], a.type || 'allowance')) +
      field('Amount / Rate',
        '<input name="amount" type="number" step="0.01" value="' + (a.amount || '') + '">' +
        '<small class="hint">For "Per Day Present" this is the <b>daily rate</b>.</small>') +
      field('Taxable?', select('taxable', [['false','Non-taxable (de minimis)'],['true','Taxable']], String(!!a.taxable))) +
      field('Basis',
        select('basis', [
          ['monthly', 'Monthly (split across periods)'],
          ['perPeriod', 'Per Pay Period (fixed)'],
          ['daily', 'Per Day Present (from DTR attendance)']
        ], basis) +
        '<small class="hint">"Per Day Present" pays the rate × days present in the DTR — absences, rest days and leave are excluded (requires DTR entry).</small>') +
      '</div>';
    modal((a.id ? 'Edit' : 'Add') + ' Earning', body, function (form) {
      var d = collect(form); d.id = a.id;
      d.amount = parseFloat(d.amount) || 0;
      d.taxable = d.taxable === 'true';
      d.perPeriod = d.basis === 'perPeriod'; // keep legacy flag in sync
      if (!d.employeeId || !d.name) { alert('Employee and Name required.'); return false; }
      S.upsert('allowances', d); renderView();
    });
  }

  /* ===================== LOANS ===================== */
  function viewLoans(v) {
    var loans = S.list('loans');
    var rows = loans.length ? loans.map(function (l) {
      var e = S.find('employees', l.employeeId);
      return '<tr><td>' + esc(e ? e.code : '?') + '</td><td>' + esc(l.type) +
        (l.reference ? '<div class="sub">' + esc(l.reference) + '</div>' : '') +
        '</td><td>' + money(l.principal) + '</td><td>' + money(l.monthlyAmortization) +
        '</td><td>' + money(l.balance) + '</td><td>' +
        (l.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge">closed</span>') +
        '</td><td class="row-actions"><button class="btn-sm" data-loan-edit="' + l.id + '">Edit</button>' +
        '<button class="btn-sm btn-danger" data-loan-del="' + l.id + '">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">No loans or advances recorded.</td></tr>';

    v.innerHTML = card('Loans, Advances & Deductibles',
      '<p class="muted">Includes SSS/Pag-IBIG loans, company loans, <b>cash advances</b> and <b>product advances</b>. ' +
      'Amortizations are auto-deducted and balances decrease when a period is finalized.</p>' +
      '<table class="tbl"><thead><tr><th>Emp</th><th>Type / Reference</th><th>Total</th><th>Amortization/mo</th>' +
      '<th>Balance</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>',
      S.list('employees').length ? '<button class="btn" data-loan-add>+ Add Loan</button>' : '');

    var addBtn = v.querySelector('[data-loan-add]');
    if (addBtn) addBtn.addEventListener('click', function () { loanForm(); });
    v.querySelectorAll('[data-loan-edit]').forEach(function (b) {
      b.addEventListener('click', function () { loanForm(S.find('loans', b.dataset.loanEdit)); });
    });
    v.querySelectorAll('[data-loan-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (confirm('Delete this loan?')) { S.remove('loans', b.dataset.loanDel); renderView(); }
      });
    });
  }

  function loanForm(l) {
    l = l || { active: true, type: 'SSS Loan' };
    var empOpts = S.list('employees').map(function (e) { return [e.id, e.code + ' — ' + e.lastName + ', ' + e.firstName]; });
    var body = '<div class="grid2">' +
      field('Employee', select('employeeId', empOpts, l.employeeId)) +
      field('Type', select('type', ['SSS Loan', 'Pag-IBIG Loan', 'Company Loan', 'Cash Advance', 'Product Advance', 'Other'], l.type)) +
      field('Reference / Description', '<input name="reference" value="' + esc(l.reference || '') + '" placeholder="e.g. product taken, PO no.">') +
      field('Principal / Total Amount', '<input name="principal" id="loanPrincipal" type="number" step="0.01" value="' + (l.principal || '') + '" ' +
        'oninput="var b=document.getElementById(\'loanBalance\'); if(b&&!b.dataset.touched){b.value=this.value;}">') +
      field('Monthly Amortization', '<input name="monthlyAmortization" type="number" step="0.01" value="' + (l.monthlyAmortization || '') + '">' +
        '<small class="hint">Spread across the month\'s cutoffs. Used when the per-cutoff field below is blank.</small>') +
      field('Per-cutoff deduction (advances)', '<input name="perCutoffAmount" type="number" step="0.01" value="' + (l.perCutoffAmount != null ? l.perCutoffAmount : '') + '">' +
        '<small class="hint">For cash / product advances: a fixed amount taken each cutoff until cleared (e.g. full principal = one cutoff; principal ÷ 2 = two cutoffs). Leave blank for monthly-amortized loans.</small>') +
      field('Current Balance', '<input name="balance" id="loanBalance" type="number" step="0.01" value="' + (l.balance != null ? l.balance : l.principal || '') + '" ' +
        'oninput="this.dataset.touched=\'1\'">' +
        '<small class="hint">The amount still owed. Leave blank to start it at the full principal / total amount above.</small>') +
      field('Start Date', '<input name="startDate" type="date" value="' + esc(l.startDate || '') + '">') +
      field('Status', select('active', [['true','Active'],['false','Closed']], String(l.active !== false))) +
      '</div>';
    modal((l.id ? 'Edit' : 'Add') + ' Loan', body, function (form) {
      var d = collect(form); d.id = l.id;
      var balBlank = (d.balance == null || String(d.balance).trim() === '');
      d.principal = parseFloat(d.principal) || 0;
      d.monthlyAmortization = parseFloat(d.monthlyAmortization) || 0;
      var perCut = parseFloat(d.perCutoffAmount);
      if (perCut > 0) d.perCutoffAmount = perCut; else delete d.perCutoffAmount;
      // A blank balance means "start at the full principal" — otherwise the loan
      // would save with a ₱0 balance and be silently skipped by payroll.
      d.balance = balBlank ? d.principal : (parseFloat(d.balance) || 0);
      d.active = d.active === 'true';
      if (!d.employeeId) { alert('Employee required.'); return false; }
      S.upsert('loans', d); renderView();
    });
  }

  /* ===================== RUN PAYROLL ===================== */
  function viewPayroll(v) {
    var periods = periodsChrono(scopePeriods(S.list('periods')));
    var pid = state.selectedPeriod || defaultPeriodId(periods);
    state.selectedPeriod = pid;

    var header = card('Payroll Periods',
      (periods.length ? '<div class="inline">' + select('period', periods.map(function (p) { return [p.id, p.name + ' (' + p.status + ')']; }), pid) +
        '<button class="btn-sm" id="editPeriod">Edit Period</button>' +
        '<button class="btn-sm btn-danger" id="delPeriod">Delete Period</button></div>' : '<p class="muted">No periods yet.</p>'),
      '<button class="btn" id="addPeriod">+ New Period</button>');

    v.innerHTML = header + '<div id="runArea"></div>';

    v.querySelector('#addPeriod').addEventListener('click', function () { periodForm(); });
    var sel = v.querySelector('[name=period]');
    if (sel) sel.addEventListener('change', function (e) { state.selectedPeriod = e.target.value; renderView(); });
    var ep = v.querySelector('#editPeriod');
    if (ep) ep.addEventListener('click', function () { periodForm(S.find('periods', pid)); });
    var dp = v.querySelector('#delPeriod');
    if (dp) dp.addEventListener('click', function () {
      if (confirm('Delete this period and its DTR/results?')) {
        S.remove('periods', pid); delete S.db.dtr[pid]; delete S.db.payrolls[pid];
        delete S.db.adjustments[pid]; S.save(); state.selectedPeriod = null; renderView();
      }
    });

    if (!pid) return;
    renderRun(v.querySelector('#runArea'), S.find('periods', pid));
  }

  function renderRun(area, period) {
    var results = PH.payroll.runPeriod(period);
    state.lastRun = { periodId: period.id, results: results };
    var ids = Object.keys(results);

    var totals = { gross: 0, ded: 0, net: 0, sss: 0, ph: 0, pi: 0, tax: 0 };
    var rows = ids.map(function (id) {
      var r = results[id];
      totals.gross += r.grossPay; totals.ded += r.totalDeductions; totals.net += r.netPay;
      totals.sss += r.contributions.sss.ee; totals.ph += r.contributions.philhealth.ee;
      totals.pi += r.contributions.pagibig.ee; totals.tax += r.withholdingTax;
      return '<tr><td>' + esc(r.employeeCode) + '</td><td>' + esc(r.employeeName) +
        '</td><td class="num">' + money(r.grossPay) + '</td>' +
        '<td class="num">' + money(r.contributions.employeeTotal) + '</td>' +
        '<td class="num">' + money(r.withholdingTax) + '</td>' +
        '<td class="num">' + money(r.totalDeductions) + '</td>' +
        '<td class="num"><b>' + money(r.netPay) + '</b></td>' +
        '<td class="row-actions"><button class="btn-sm" data-pay-slip="' + id + '">Payslip</button>' +
        '<button class="btn-sm" data-pay-adj="' + id + '">Adjust</button></td></tr>';
    }).join('');

    var finalized = period.status === 'finalized';
    area.innerHTML = card('Payroll Register — ' + esc(period.name) +
      (finalized ? ' <span class="badge badge-ok">finalized</span>' : ' <span class="badge badge-draft">draft (preview)</span>'),
      (ids.length ?
        '<div class="dtr-scroll"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th class="num">Gross</th>' +
        '<th class="num">Contrib.</th><th class="num">Tax</th><th class="num">Deductions</th><th class="num">Net Pay</th><th></th></tr></thead><tbody>' +
        rows + '</tbody><tfoot><tr><td colspan="2"><b>TOTALS</b></td>' +
        '<td class="num"><b>' + money(totals.gross) + '</b></td>' +
        '<td class="num"><b>' + money(totals.sss + totals.ph + totals.pi) + '</b></td>' +
        '<td class="num"><b>' + money(totals.tax) + '</b></td>' +
        '<td class="num"><b>' + money(totals.ded) + '</b></td>' +
        '<td class="num"><b>' + money(totals.net) + '</b></td><td></td></tr></tfoot></table></div>'
        : '<p class="muted">No active employees to compute.</p>'),
      (ids.length ?
        '<button class="btn-sm" id="exportRun">Export CSV</button>' +
        '<button class="btn-sm" id="printAll">Print All Payslips</button>' +
        (finalized ? '<button class="btn-sm" id="reopen">Reopen</button>'
          : '<button class="btn" id="finalize">Finalize Payroll</button>') : ''));

    area.querySelectorAll('[data-pay-slip]').forEach(function (b) {
      b.addEventListener('click', function () { showPayslip(results[b.dataset.paySlip], period); });
    });
    area.querySelectorAll('[data-pay-adj]').forEach(function (b) {
      b.addEventListener('click', function () { adjustmentForm(period.id, b.dataset.payAdj); });
    });
    var fin = area.querySelector('#finalize');
    if (fin) fin.addEventListener('click', function () {
      if (confirm('Finalize this payroll? Loan balances will be reduced and results saved.')) {
        PH.payroll.finalizePeriod(period);
        // Online edition hook (e.g. email payslip notifications). No-op offline.
        if (PH.onFinalize) { try { PH.onFinalize(period); } catch (e) { console.error(e); } }
        renderView();
      }
    });
    var re = area.querySelector('#reopen');
    if (re) re.addEventListener('click', function () {
      period.status = 'draft'; S.upsert('periods', period); renderView();
    });
    var exp = area.querySelector('#exportRun');
    if (exp) exp.addEventListener('click', function () { exportRunCSV(period, results); });
    var pa = area.querySelector('#printAll');
    if (pa) pa.addEventListener('click', function () { printPayslips(ids.map(function (id) { return results[id]; }), period); });
  }

  function periodForm(p) {
    p = periodDefaults(p);
    function chk(name, label, checked) {
      return '<label class="chk"><input type="checkbox" name="' + name + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>';
    }
    var body = '<div class="grid2">' +
      field('Period Name', '<input name="name" value="' + esc(p.name || '') + '" placeholder="e.g. July 2026 (1-15)">') +
      field('Frequency', select('frequency', ['semi-monthly', 'monthly', 'weekly', 'daily'], p.frequency)) +
      field('Start Date', '<input name="startDate" type="date" value="' + esc(p.startDate || '') + '">') +
      field('End Date', '<input name="endDate" type="date" value="' + esc(p.endDate || '') + '">') +
      field('Pay Date', '<input name="payDate" type="date" value="' + esc(p.payDate || '') + '">') +
      '</div>' +
      '<h4 class="form-section">Statutory Deductions this cut-off</h4>' +
      '<p class="hint">Tick which government contributions to deduct in THIS period. ' +
      'For semi-monthly you can, for example, deduct <b>SSS on the 15th</b> and <b>PhilHealth &amp; Pag-IBIG on the 30th</b>. ' +
      'Note: if a <b>Government Deduction Schedule</b> is set in Settings, that schedule decides these automatically and overrides the boxes below.</p>' +
      '<div class="chk-row">' +
        chk('applySSS', 'SSS', p.applySSS) +
        chk('applyPhilHealth', 'PhilHealth', p.applyPhilHealth) +
        chk('applyPagIBIG', 'Pag-IBIG', p.applyPagIBIG) +
      '</div>';
    modal((p.id ? 'Edit' : 'New') + ' Payroll Period', body, function (form) {
      var d = collect(form); d.id = p.id; d.status = p.status || 'draft';
      d.applySSS = !!d.applySSS; d.applyPhilHealth = !!d.applyPhilHealth; d.applyPagIBIG = !!d.applyPagIBIG;
      delete d.applyContributions;
      if (!d.name) { alert('Period name required.'); return false; }
      // New periods created while a branch is selected belong to that branch.
      if (!p.id) { if (state.locationId) d.locationId = state.locationId; }
      else if (p.locationId) d.locationId = p.locationId;
      var saved = S.upsert('periods', d);
      state.selectedPeriod = saved.id; renderView();
    });
  }

  // Normalise a period's contribution flags (migrates the old single flag).
  function periodDefaults(p) {
    if (!p) return { frequency: 'semi-monthly', status: 'draft', applySSS: true, applyPhilHealth: true, applyPagIBIG: true };
    if (p.applySSS === undefined && p.applyPhilHealth === undefined && p.applyPagIBIG === undefined) {
      var on = p.applyContributions !== false;
      p.applySSS = on; p.applyPhilHealth = on; p.applyPagIBIG = on;
    }
    return p;
  }

  function adjustmentForm(pid, empId) {
    var emp = S.find('employees', empId);
    S.db.adjustments[pid] = S.db.adjustments[pid] || {};
    var list = (S.db.adjustments[pid][empId] || []).slice();
    function rowHtml(a, i) {
      a = a || { taxable: true, type: 'commission' };
      return '<tr data-i="' + i + '"><td><input name="name" value="' + esc(a.name || '') + '" placeholder="e.g. Sales Commission"></td>' +
        '<td>' + select('type', [['commission','Commission'],['allowance','Allowance'],['bonus','Bonus'],['deduction','Deduction (negative)'],['other','Other']], a.type || 'commission') + '</td>' +
        '<td><input name="amount" type="number" step="0.01" value="' + (a.amount != null ? a.amount : '') + '" style="width:110px"></td>' +
        '<td>' + select('taxable', [['true','Taxable'],['false','Non-tax']], String(a.taxable !== false)) + '</td>' +
        '<td><button class="btn-sm btn-danger" data-adj-del type="button">✕</button></td></tr>';
    }
    if (!list.length) list.push(null);
    var body = '<p class="muted">One-off earnings/deductions for <b>' + esc(emp.lastName + ', ' + emp.firstName) +
      '</b> in this period only. Use "Deduction" type for negative items (loans/advances live in the Loans tab).</p>' +
      '<table class="tbl"><thead><tr><th>Description</th><th>Type</th><th>Amount</th><th>Tax</th><th></th></tr></thead>' +
      '<tbody id="adjRows">' + list.map(rowHtml).join('') + '</tbody></table>' +
      '<button class="btn-sm" id="adjAdd" type="button">+ Add Line</button>';
    modal('Period Adjustments', body, function (form) {
      var out = [];
      form.querySelectorAll('#adjRows tr').forEach(function (tr) {
        var name = tr.querySelector('[name=name]').value.trim();
        var amt = parseFloat(tr.querySelector('[name=amount]').value);
        if (!name || isNaN(amt)) return;
        var type = tr.querySelector('[name=type]').value;
        if (type === 'deduction' && amt > 0) amt = -amt;
        out.push({ name: name, type: type, amount: amt, taxable: tr.querySelector('[name=taxable]').value === 'true' });
      });
      if (out.length) S.db.adjustments[pid][empId] = out; else delete S.db.adjustments[pid][empId];
      S.save(); renderView();
    });
    var rowsEl = qs('#adjRows'); var c = list.length;
    qs('#adjAdd').addEventListener('click', function () {
      var t = document.createElement('tbody'); t.innerHTML = rowHtml(null, c++);
      rowsEl.appendChild(t.firstChild); bindDel();
    });
    function bindDel() {
      rowsEl.querySelectorAll('[data-adj-del]').forEach(function (b) {
        b.onclick = function () { b.closest('tr').remove(); };
      });
    }
    bindDel();
  }

  /* ===================== PAYSLIP ===================== */
  var DAY_LABELS = (PH.dtr && PH.dtr.DAY_TYPES) || {};
  function payslipHTML(r, period, opts) {
    opts = opts || {};
    var comp = S.db.meta.company;
    var emp = S.find('employees', r.employeeId) || {};
    var earn = r.earnings.map(function (e) {
      return '<tr><td>' + esc(e.name) + (e.taxable ? '' : ' <span class="tag">non-tax</span>') +
        '</td><td class="num">' + money(e.amount) + '</td></tr>';
    }).join('');
    var ded = r.deductions.map(function (d) {
      return '<tr><td>' + esc(d.name) + '</td><td class="num">' + money(d.amount) + '</td></tr>';
    }).join('');
    var dtr = r.dtr;

    // ---- DTR daily detail table ----
    var dtrDetail = '';
    if (dtr.details && dtr.details.length) {
      var drows = dtr.details.map(function (d) {
        var dl = (DAY_LABELS[d.dayType] && DAY_LABELS[d.dayType].label) || d.dayType;
        if (d.restDay) dl += ' (RD)';
        var regCell;
        if (d.absent) regCell = 'ABSENT';
        else if (d.leaveType && d.workedMinutes === 0) { dl = d.leaveType + ' Leave'; regCell = 'LEAVE'; }
        else regCell = (d.regularMinutes / 60).toFixed(2);
        return '<tr><td>' + esc(d.date || '') + '</td><td>' + esc(dl) +
          '</td><td class="num">' + regCell +
          '</td><td class="num">' + (d.otMinutes / 60).toFixed(2) +
          '</td><td class="num">' + (d.nightDiffMinutes / 60).toFixed(2) +
          '</td><td class="num">' + (d.lateMinutes || 0) +
          '</td><td class="num">' + (d.undertimeMinutes || 0) + '</td></tr>';
      }).join('');
      dtrDetail = '<div class="ps-dtr"><h4>Daily Time Record</h4>' +
        '<table class="ps-tbl ps-dtr-tbl"><thead><tr><th>Date</th><th>Day Type</th>' +
        '<th class="num">Reg h</th><th class="num">OT h</th><th class="num">ND h</th>' +
        '<th class="num">Late m</th><th class="num">UT m</th></tr></thead><tbody>' + drows +
        '</tbody><tfoot><tr><td colspan="2"><b>Totals</b></td>' +
        '<td class="num"><b>' + (dtr.regularMinutes / 60).toFixed(2) + '</b></td>' +
        '<td class="num"><b>' + (dtr.otMinutes / 60).toFixed(2) + '</b></td>' +
        '<td class="num"><b>' + (dtr.nightDiffMinutes / 60).toFixed(2) + '</b></td>' +
        '<td class="num"><b>' + dtr.lateMinutes + '</b></td>' +
        '<td class="num"><b>' + dtr.undertimeMinutes + '</b></td></tr></tfoot></table></div>';
    }

    // ---- Notes: deductible balances remaining ----
    var loans = S.list('loans').filter(function (l) { return l.employeeId === r.employeeId; });
    var noteRows = (r.loanDeductions || []).map(function (ld) {
      var loan = S.find('loans', ld.id) || {};
      var ref = loan.reference ? ' (' + loan.reference + ')' : '';
      return '<tr><td>' + esc(ld.name) + esc(ref) + '</td><td class="num">' + money(ld.amount) +
        '</td><td class="num">' + money(loan.balance != null ? loan.balance : 0) + '</td></tr>';
    }).join('');
    var notesSection = '<div class="ps-notes"><h4>Notes — Deductibles &amp; Advances</h4>' +
      (noteRows ? '<table class="ps-tbl"><thead><tr><th>Item</th><th class="num">Deducted this period</th>' +
        '<th class="num">Remaining balance</th></tr></thead><tbody>' + noteRows + '</tbody></table>'
        : '<p class="muted">No active loans, cash advances or product advances this period.</p>') +
      '<div class="ps-note-free">' + (opts.note ? esc(opts.note) : '________________________________________________') + '</div></div>';

    return '<div class="payslip">' +
      '<div class="ps-head"><div><div class="ps-co">' + esc(comp.name) + '</div>' +
      '<div class="ps-co-sub">' + esc(comp.address || '') + (comp.tin ? ' • TIN ' + esc(comp.tin) : '') + '</div></div>' +
      '<div class="ps-title">PAYSLIP</div></div>' +
      '<div class="ps-meta"><div><b>' + esc(r.employeeName) + '</b> (' + esc(r.employeeCode) + ')' +
      (emp.position ? '<br><span class="muted">' + esc(emp.position) + (emp.department ? ' • ' + esc(emp.department) : '') + '</span>' : '') + '</div>' +
      '<div>Period: ' + esc(period.name) + '<br>Coverage: ' + esc(period.startDate || '') + ' – ' + esc(period.endDate || '') + '</div>' +
      '<div>Pay Date: ' + esc(period.payDate || '—') + (emp.bankName ? '<br>Credit to: ' + esc(emp.bankName) + ' ' + esc(emp.bankAccountNumber || '') : '') + '</div></div>' +
      '<div class="ps-cols"><div class="ps-col"><h4>Earnings</h4><table class="ps-tbl"><tbody>' + earn +
      '</tbody><tfoot><tr><td><b>Gross Pay</b></td><td class="num"><b>' + money(r.grossPay) + '</b></td></tr></tfoot></table></div>' +
      '<div class="ps-col"><h4>Deductions</h4><table class="ps-tbl"><tbody>' + (ded || '<tr><td class="muted">None</td><td></td></tr>') +
      '</tbody><tfoot><tr><td><b>Total Deductions</b></td><td class="num"><b>' + money(r.totalDeductions) + '</b></td></tr></tfoot></table></div></div>' +
      '<div class="ps-net">NET PAY <span>' + money(r.netPay) + '</span></div>' +
      dtrDetail + notesSection +
      '<div class="ps-foot"><table class="ps-mini"><tr><td>Days Present</td><td>' + dtr.daysPresent +
      '</td><td>OT Hours</td><td>' + hrs(dtr.otMinutes) + '</td><td>Night Diff</td><td>' + hrs(dtr.nightDiffMinutes) + '</td></tr>' +
      '<tr><td>Absences</td><td>' + dtr.daysAbsent + '</td><td>Late</td><td>' + dtr.lateMinutes +
      'm</td><td>Undertime</td><td>' + dtr.undertimeMinutes + 'm</td></tr>' +
      '<tr><td>SSS MSC</td><td>' + money(r.contributions.sss.msc) + '</td><td>Taxable</td><td>' + money(r.taxableBase) +
      '</td><td>Contrib. Basis</td><td>' + money(r.contributions.basis) + '</td></tr>' +
      (r.leave ? '<tr><td>Status</td><td>' + esc(cap(r.employmentStatus)) +
        '</td><td>Leave Used</td><td>' + r.leave.paid +
        '</td><td>Leave Left</td><td>' + r.leave.remainingAfter + '</td></tr>' +
        ((r.leave.unpaidAuthorized || 0) > 0 ? '<tr><td>Unpaid Auth. Leave</td><td>' + r.leave.unpaidAuthorized +
          ' day' + (r.leave.unpaidAuthorized > 1 ? 's' : '') + '</td><td></td><td></td><td></td><td></td></tr>' : '') : '') +
      '</table></div>' +
      '<div class="ps-sign"><div>_____________________<br>Employee Signature</div>' +
      '<div>_____________________<br>Authorized Signatory</div></div></div>';
  }

  function showPayslip(r, period) {
    modal('Payslip', payslipHTML(r, period),
      null, 'wide',
      '<button class="btn" id="printSlip">Download PDF / Print</button>');
    qs('#printSlip').addEventListener('click', function () { printPayslips([r], period); });
  }

  // Generic print helper: opens a print window (use "Save as PDF" as the
  // destination to download). Fully offline — no external libraries.
  // On Android the native bridge prints via the OS print framework.
  function printHTML(title, bodyHTML) {
    var fullHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) +
      '</title><style>' + PAYSLIP_PRINT_CSS + '</style></head><body>' + bodyHTML + '</body></html>';
    if (PH.platform && PH.platform.print(title, fullHtml)) return;
    var w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to print / download the PDF.'); return; }
    w.document.write(fullHtml);
    w.document.close();
    w.focus();
    setTimeout(function () { w.print(); }, 300);
  }

  function printPayslips(list, period) {
    printHTML('Payslips — ' + period.name,
      list.map(function (r) { return payslipHTML(r, period); }).join('<div class="page-break"></div>'));
  }

  function exportRunCSV(period, results) {
    var lines = [['Code', 'Name', 'Gross Pay', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Withholding Tax',
      'Loans', 'Late/Undertime', 'Total Deductions', 'Net Pay'].join(',')];
    Object.keys(results).forEach(function (id) {
      var r = results[id];
      var loans = r.loanDeductions.reduce(function (s, l) { return s + l.amount; }, 0);
      var lu = (r.dtr.lateDeduction || 0) + (r.dtr.undertimeDeduction || 0);
      lines.push([r.employeeCode, '"' + r.employeeName + '"', r.grossPay,
        r.contributions.sss.ee, r.contributions.philhealth.ee, r.contributions.pagibig.ee,
        r.withholdingTax, loans.toFixed(2), lu.toFixed(2), r.totalDeductions, r.netPay].join(','));
    });
    downloadFile(period.name.replace(/[^\w]+/g, '_') + '_payroll.csv', lines.join('\n'), 'text/csv');
  }

  // Gallery of employee-uploaded physical time cards for a period (admin DTR view).
  function loadAdminTimecards(pid) {
    var el = document.getElementById('tcAdmin'); if (!el) return;
    fetch('/api/admin/timecards?periodId=' + encodeURIComponent(pid), { headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var rows = (j && j.timecards) || [];
        if (state.locationId) {
          var loc = {}; S.list('employees').forEach(function (e) { if (e.code) loc[e.code] = e.locationId || null; });
          rows = rows.filter(function (t) { return loc[t.employee_code] === state.locationId; });
        }
        if (!rows.length) { el.innerHTML = '<p class="muted">No time cards uploaded for this period.</p>'; return; }
        el.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:12px">' + rows.map(function (t) {
          var isPdf = t.mime === 'application/pdf';
          var thumb = isPdf
            ? '<div style="width:96px;height:96px;display:flex;align-items:center;justify-content:center;font-size:34px;border:1px solid #e2e8f0;border-radius:8px">📄</div>'
            : '<img src="/api/timecard/' + t.id + '" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0">';
          return '<a href="/api/timecard/' + t.id + '" target="_blank" style="text-decoration:none;color:inherit;width:112px">' + thumb +
            '<div style="font-size:12px;font-weight:600;margin-top:3px">' + esc(t.full_name || t.employee_code || '') + '</div>' +
            (t.note ? '<div style="font-size:11px;color:#64748b">' + esc(t.note) + '</div>' : '') +
            '<div style="font-size:10px;color:#94a3b8">' + esc((t.created_at || '').slice(0, 10)) + '</div></a>';
        }).join('') + '</div>';
      })
      .catch(function () { el.innerHTML = '<p class="muted">Could not load time cards.</p>'; });
  }

  /* ===================== LEAVE CALENDAR ===================== */
  var leaveCalState = { month: null, incPend: true, rows: [] };
  var LC_COLORS = { SL: '#2563eb', VL: '#0a7d33', EL: '#d97706', UAL: '#6b7280', '': '#334155' };
  function viewLeaveCalendar(v) {
    if (!leaveCalState.month) { var t = new Date(); leaveCalState.month = new Date(t.getFullYear(), t.getMonth(), 1); }
    v.innerHTML = card('Leave Calendar', '<p class="muted">Loading…</p>');
    fetch('/api/leave-calendar', { headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var rows = (j && j.requests) || [];
        // Central admins can narrow to one branch via the sidebar location filter.
        if (state.locationId) {
          var loc = {}; S.list('employees').forEach(function (e) { if (e.code) loc[e.code] = e.locationId || null; });
          rows = rows.filter(function (r) { return loc[r.employee_code] === state.locationId; });
        }
        leaveCalState.rows = rows;
        drawLeaveCal(v);
      })
      .catch(function () { v.innerHTML = card('Leave Calendar', '<p class="muted">Could not load leave data.</p>'); });
  }
  function drawLeaveCal(v) {
    var m = leaveCalState.month, rows = leaveCalState.rows || [];
    var y = m.getFullYear(), mo = m.getMonth();
    var first = new Date(y, mo, 1), daysIn = new Date(y, mo + 1, 0).getDate();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (d) {
      return '<div style="text-align:center;font-size:11px;color:#94a3b8;font-weight:700;padding:4px 0">' + d + '</div>';
    });
    for (var i = 0; i < first.getDay(); i++) cells.push('<div></div>');
    for (var day = 1; day <= daysIn; day++) {
      var iso = y + '-' + p2(mo + 1) + '-' + p2(day);
      var on = rows.filter(function (r) {
        if (!leaveCalState.incPend && r.status !== 'approved') return false;
        return r.date_from <= iso && iso <= r.date_to;
      });
      var chips = on.map(function (r) {
        var c = LC_COLORS[r.leave_type] || LC_COLORS[''];
        var pending = r.status !== 'approved';
        return '<div title="' + esc((r.full_name || r.email) + ' — ' + r.leave_type + ' (' + r.status + ')') + '" ' +
          'style="font-size:10px;line-height:1.3;margin-top:2px;padding:1px 4px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;background:' + c + ';' + (pending ? 'opacity:.55;border:1px dashed #fff' : '') + '">' +
          esc((r.full_name || r.email || '').split(' ')[0]) + ' · ' + esc(r.leave_type) + '</div>';
      }).join('');
      cells.push('<div style="min-height:70px;border:1px solid #e2e8f0;border-radius:6px;padding:3px;background:' + (on.length ? '#f8fafc' : '#fff') + '">' +
        '<div style="font-size:11px;color:#64748b;font-weight:600">' + day + '</div>' + chips + '</div>');
    }
    var scopeLabel = state.locationId ? ' — ' + esc(locationName(state.locationId)) : '';
    var head =
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">' +
        '<div><button class="btn-sm" id="lcPrev">‹</button> <b style="margin:0 8px">' + MONTHS[mo] + ' ' + y + '</b> <button class="btn-sm" id="lcNext">›</button></div>' +
        '<label class="chk"><input type="checkbox" id="lcPend"' + (leaveCalState.incPend ? ' checked' : '') + '> Include pending</label>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">' + cells.join('') + '</div>' +
      '<div class="muted" style="margin-top:8px;font-size:11px">' +
        Object.keys(LC_COLORS).filter(function (k) { return k; }).map(function (k) {
          return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + LC_COLORS[k] + ';margin:0 3px 0 10px;vertical-align:middle"></span>' + k;
        }).join('') + ' &nbsp;·&nbsp; dashed = pending</div>';
    v.innerHTML = card('Leave Calendar' + scopeLabel, head);
    v.querySelector('#lcPrev').addEventListener('click', function () { leaveCalState.month = new Date(y, mo - 1, 1); drawLeaveCal(v); });
    v.querySelector('#lcNext').addEventListener('click', function () { leaveCalState.month = new Date(y, mo + 1, 1); drawLeaveCal(v); });
    v.querySelector('#lcPend').addEventListener('change', function (e) { leaveCalState.incPend = e.target.checked; drawLeaveCal(v); });
  }

  /* ===================== REPORTS ===================== */
  function viewReports(v) {
    var periods = periodsChrono(scopePeriods(S.list('periods')));
    if (!periods.length) {
      v.innerHTML = card('Reports', '<p class="muted">Create a payroll period first.</p>');
      return;
    }
    var pid = state.selectedPeriod || defaultPeriodId(periods);
    state.selectedPeriod = pid;
    var period = S.find('periods', pid);
    var results = period.status === 'finalized' && S.db.payrolls[pid]
      ? S.db.payrolls[pid] : PH.payroll.runPeriod(period);
    var ids = scopeIds(Object.keys(results));

    v.innerHTML =
      card('Select Period',
        '<div class="inline">' + select('period', periods.map(function (p) { return [p.id, p.name + ' (' + p.status + ')']; }), pid) +
        (period.status === 'finalized' ? '<span class="badge badge-ok">finalized</span>' : '<span class="badge badge-draft">preview</span>') +
        (state.locationId ? ' <span class="badge">' + esc(locationName(state.locationId)) + '</span>' : ' <span class="badge">All locations</span>') +
        '</div>') +
      card('A. Accounting Report — Full Payslip Detail',
        '<p class="muted">Every earning and deduction itemized per employee. For books, journal entries and audit.</p>' +
        '<div class="dtr-scroll">' + accountingTable(results, ids) + '</div>',
        '<button class="btn-sm" id="accPrint">Download PDF / Print</button>' +
        '<button class="btn-sm" id="accCsv">Export CSV</button>') +
      card('B. Finance Report — Salary Crediting',
        '<p class="muted">Net pay and bank details per employee, for the bank salary-credit file.</p>' +
        '<div class="dtr-scroll">' + financeTable(results, ids) + '</div>',
        '<button class="btn-sm" id="finPrint">Download PDF / Print</button>' +
        '<button class="btn-sm" id="finCsv">Export CSV</button>') +
      remittanceCard('sss', 'C. SSS — Contribution Collection List (R-3)',
        'Monthly SSS contributions per employee, for filing/remittance to SSS.') +
      remittanceCard('philhealth', 'D. PhilHealth — Remittance Report (RF-1)',
        'Monthly PhilHealth premiums per employee, for filing/remittance to PhilHealth.') +
      remittanceCard('pagibig', 'E. Pag-IBIG — Contribution Remittance (MCRF)',
        'Monthly Pag-IBIG (HDMF) contributions per employee, for remittance to Pag-IBIG.') +
      '<p class="disclaimer">💡 Remittance figures are each employee\'s <b>monthly</b> contribution (based on their ' +
      'contribution basis), shown independently of pay cut-offs. Verify member numbers and totals before filing.</p>';

    v.querySelector('[name=period]').addEventListener('change', function (e) {
      state.selectedPeriod = e.target.value; renderView();
    });
    ['sss', 'philhealth', 'pagibig'].forEach(function (kind) {
      var monthLabel = remitMonthLabel(period);
      v.querySelector('[data-remit-print="' + kind + '"]').addEventListener('click', function () {
        printHTML(remitTitle(kind) + ' — ' + monthLabel,
          '<h2>' + esc(remitTitle(kind)) + '</h2>' +
          '<div class="rpt-sub">' + esc(S.db.meta.company.name) +
          (S.db.meta.company.tin ? ' • TIN ' + esc(S.db.meta.company.tin) : '') +
          ' • For the month of ' + esc(monthLabel) + '</div>' +
          remittanceTable(kind));
      });
      v.querySelector('[data-remit-csv="' + kind + '"]').addEventListener('click', function () {
        exportRemittanceCSV(kind, monthLabel);
      });
    });
    v.querySelector('#accPrint').addEventListener('click', function () {
      printHTML('Accounting Report — ' + period.name,
        '<h2>Accounting Report — ' + esc(period.name) + '</h2>' +
        '<div class="rpt-sub">' + esc(S.db.meta.company.name) + ' • Coverage ' + esc(period.startDate || '') + ' to ' + esc(period.endDate || '') + '</div>' +
        accountingTable(results, ids));
    });
    v.querySelector('#accCsv').addEventListener('click', function () { exportAccountingCSV(period, results); });
    v.querySelector('#finPrint').addEventListener('click', function () {
      printHTML('Salary Crediting — ' + period.name,
        '<h2>Salary Crediting (Finance) — ' + esc(period.name) + '</h2>' +
        '<div class="rpt-sub">' + esc(S.db.meta.company.name) + ' • Pay date ' + esc(period.payDate || '—') + '</div>' +
        financeTable(results, ids));
    });
    v.querySelector('#finCsv').addEventListener('click', function () { exportFinanceCSV(period, results); });
  }

  // Collect the union of all earning/deduction line names, for stable columns.
  function collectKeys(results, ids, prop) {
    var seen = [];
    ids.forEach(function (id) {
      (results[id][prop] || []).forEach(function (x) { if (seen.indexOf(x.name) < 0) seen.push(x.name); });
    });
    return seen;
  }

  function accountingTable(results, ids) {
    if (!ids.length) return '<p class="muted">No employees to report.</p>';
    var earnKeys = collectKeys(results, ids, 'earnings');
    var dedKeys = collectKeys(results, ids, 'deductions');
    var head = '<tr><th>Code</th><th>Name</th>' +
      earnKeys.map(function (k) { return '<th class="num">' + esc(k) + '</th>'; }).join('') +
      '<th class="num">Gross</th>' +
      dedKeys.map(function (k) { return '<th class="num">' + esc(k) + '</th>'; }).join('') +
      '<th class="num">Total Ded.</th><th class="num">Net Pay</th></tr>';
    var tot = {}; var grossT = 0, dedT = 0, netT = 0;
    var body = ids.map(function (id) {
      var r = results[id];
      var em = {}, dm = {};
      (r.earnings || []).forEach(function (e) { em[e.name] = (em[e.name] || 0) + e.amount; });
      (r.deductions || []).forEach(function (d) { dm[d.name] = (dm[d.name] || 0) + d.amount; });
      grossT += r.grossPay; dedT += r.totalDeductions; netT += r.netPay;
      earnKeys.concat(dedKeys).forEach(function (k) { tot[k] = (tot[k] || 0) + ((em[k] || dm[k]) || 0); });
      return '<tr><td>' + esc(r.employeeCode) + '</td><td>' + esc(r.employeeName) + '</td>' +
        earnKeys.map(function (k) { return '<td class="num">' + (em[k] ? money(em[k]) : '—') + '</td>'; }).join('') +
        '<td class="num"><b>' + money(r.grossPay) + '</b></td>' +
        dedKeys.map(function (k) { return '<td class="num">' + (dm[k] ? money(dm[k]) : '—') + '</td>'; }).join('') +
        '<td class="num">' + money(r.totalDeductions) + '</td><td class="num"><b>' + money(r.netPay) + '</b></td></tr>';
    }).join('');
    var foot = '<tr><td colspan="2"><b>TOTALS</b></td>' +
      earnKeys.map(function (k) { return '<td class="num"><b>' + money(tot[k]) + '</b></td>'; }).join('') +
      '<td class="num"><b>' + money(grossT) + '</b></td>' +
      dedKeys.map(function (k) { return '<td class="num"><b>' + money(tot[k]) + '</b></td>'; }).join('') +
      '<td class="num"><b>' + money(dedT) + '</b></td><td class="num"><b>' + money(netT) + '</b></td></tr>';
    return '<table class="tbl rpt-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table>';
  }

  function financeTable(results, ids) {
    if (!ids.length) return '<p class="muted">No employees to report.</p>';
    var netT = 0;
    var body = ids.map(function (id) {
      var r = results[id];
      var e = S.find('employees', id) || {};
      netT += r.netPay;
      return '<tr><td>' + esc(r.employeeCode) + '</td><td>' + esc(r.employeeName) +
        '</td><td>' + esc(e.bankName || '—') + '</td><td>' + esc(e.bankAccountNumber || '—') +
        '</td><td>' + esc(e.bankAccountName || '—') + '</td><td class="num"><b>' + money(r.netPay) + '</b></td></tr>';
    }).join('');
    return '<table class="tbl rpt-tbl"><thead><tr><th>Code</th><th>Name</th><th>Bank</th>' +
      '<th>Account No.</th><th>Account Name</th><th class="num">Net Pay (Credit)</th></tr></thead><tbody>' +
      body + '</tbody><tfoot><tr><td colspan="5"><b>TOTAL TO CREDIT</b></td><td class="num"><b>' +
      money(netT) + '</b></td></tr></tfoot></table>';
  }

  function exportAccountingCSV(period, results) {
    var ids = Object.keys(results);
    var earnKeys = collectKeys(results, ids, 'earnings');
    var dedKeys = collectKeys(results, ids, 'deductions');
    var header = ['Code', 'Name'].concat(earnKeys, ['Gross'], dedKeys, ['Total Deductions', 'Net Pay']);
    var lines = [header.map(csvCell).join(',')];
    ids.forEach(function (id) {
      var r = results[id];
      var em = {}, dm = {};
      (r.earnings || []).forEach(function (e) { em[e.name] = (em[e.name] || 0) + e.amount; });
      (r.deductions || []).forEach(function (d) { dm[d.name] = (dm[d.name] || 0) + d.amount; });
      var row = [r.employeeCode, r.employeeName]
        .concat(earnKeys.map(function (k) { return (em[k] || 0).toFixed(2); }))
        .concat([r.grossPay.toFixed(2)])
        .concat(dedKeys.map(function (k) { return (dm[k] || 0).toFixed(2); }))
        .concat([r.totalDeductions.toFixed(2), r.netPay.toFixed(2)]);
      lines.push(row.map(csvCell).join(','));
    });
    downloadFile(period.name.replace(/[^\w]+/g, '_') + '_accounting.csv', lines.join('\n'), 'text/csv');
  }

  function exportFinanceCSV(period, results) {
    var lines = [['Code', 'Name', 'Bank', 'Account Number', 'Account Name', 'Net Pay'].join(',')];
    Object.keys(results).forEach(function (id) {
      var r = results[id]; var e = S.find('employees', id) || {};
      lines.push([r.employeeCode, r.employeeName, e.bankName || '', e.bankAccountNumber || '',
        e.bankAccountName || '', r.netPay.toFixed(2)].map(csvCell).join(','));
    });
    downloadFile(period.name.replace(/[^\w]+/g, '_') + '_salary_credit.csv', lines.join('\n'), 'text/csv');
  }

  /* ---- Government remittance reports (monthly) ---- */
  function remitTitle(kind) {
    return {
      sss: 'SSS Contribution Collection List (R-3)',
      philhealth: 'PhilHealth Remittance Report (RF-1)',
      pagibig: 'Pag-IBIG Contribution Remittance (MCRF)'
    }[kind];
  }
  function remitMonthLabel(period) {
    // Prefer the period's coverage month; fall back to the period name.
    var d = period && period.endDate ? new Date(period.endDate) : new Date();
    if (isNaN(d.getTime())) return (period && period.name) || '';
    return d.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
  }
  // Monthly contribution snapshot for every active employee.
  // Employees excluded from a given agency's report when opted out at the 201 level.
  function remittanceOptedOut(emp, kind) {
    if (kind === 'sss') return emp.deductSSS === false;
    if (kind === 'philhealth') return emp.deductPhilHealth === false;
    if (kind === 'pagibig') return emp.deductPagIBIG === false;
    return false;
  }
  function remittanceData(kind) {
    return S.list('employees').filter(function (e) {
      return e.active !== false && !(kind && remittanceOptedOut(e, kind));
    }).map(function (e) {
      var basis = PH.payroll.rates(e).monthlyBasic;
      var c = PH.statutory.computeContributions(basis);
      return { emp: e, basis: basis, sss: c.sss, philhealth: c.philhealth, pagibig: c.pagibig };
    });
  }
  function remittanceTable(kind) {
    var data = remittanceData(kind);
    if (!data.length) return '<p class="muted">No active employees to report.</p>';
    var head, bodyFn, tot;
    if (kind === 'sss') {
      head = '<tr><th>SSS No.</th><th>Employee Name</th><th class="num">MSC</th><th class="num">EE</th>' +
        '<th class="num">ER</th><th class="num">EC</th><th class="num">Total</th></tr>';
      tot = { ee: 0, er: 0, ec: 0, t: 0 };
      bodyFn = function (d) {
        var total = PH.statutory.round2(d.sss.ee + d.sss.er + d.sss.ec);
        tot.ee += d.sss.ee; tot.er += d.sss.er; tot.ec += d.sss.ec; tot.t += total;
        return '<td>' + esc(d.emp.sssNo || '—') + '</td><td>' + esc(name(d.emp)) +
          '</td><td class="num">' + money(d.sss.msc) + '</td><td class="num">' + money(d.sss.ee) +
          '</td><td class="num">' + money(d.sss.er) + '</td><td class="num">' + money(d.sss.ec) +
          '</td><td class="num"><b>' + money(total) + '</b></td>';
      };
    } else if (kind === 'philhealth') {
      head = '<tr><th>PhilHealth No.</th><th>Employee Name</th><th class="num">Salary Base</th>' +
        '<th class="num">EE</th><th class="num">ER</th><th class="num">Total</th></tr>';
      tot = { ee: 0, er: 0, t: 0 };
      bodyFn = function (d) {
        tot.ee += d.philhealth.ee; tot.er += d.philhealth.er; tot.t += d.philhealth.total;
        return '<td>' + esc(d.emp.philhealthNo || '—') + '</td><td>' + esc(name(d.emp)) +
          '</td><td class="num">' + money(d.philhealth.base) + '</td><td class="num">' + money(d.philhealth.ee) +
          '</td><td class="num">' + money(d.philhealth.er) + '</td><td class="num"><b>' + money(d.philhealth.total) + '</b></td>';
      };
    } else { // pagibig
      head = '<tr><th>Pag-IBIG MID No.</th><th>Employee Name</th><th class="num">EE</th>' +
        '<th class="num">ER</th><th class="num">Total</th></tr>';
      tot = { ee: 0, er: 0, t: 0 };
      bodyFn = function (d) {
        tot.ee += d.pagibig.ee; tot.er += d.pagibig.er; tot.t += d.pagibig.total;
        return '<td>' + esc(d.emp.pagibigNo || '—') + '</td><td>' + esc(name(d.emp)) +
          '</td><td class="num">' + money(d.pagibig.ee) + '</td><td class="num">' + money(d.pagibig.er) +
          '</td><td class="num"><b>' + money(d.pagibig.total) + '</b></td>';
      };
    }
    var rows = data.map(function (d) { return '<tr>' + bodyFn(d) + '</tr>'; }).join('');
    var span = kind === 'sss' ? 3 : (kind === 'philhealth' ? 3 : 2);
    var footCells = kind === 'sss'
      ? '<td class="num"><b>' + money(tot.ee) + '</b></td><td class="num"><b>' + money(tot.er) +
        '</b></td><td class="num"><b>' + money(tot.ec) + '</b></td><td class="num"><b>' + money(tot.t) + '</b></td>'
      : '<td class="num"><b>' + money(tot.ee) + '</b></td><td class="num"><b>' + money(tot.er) +
        '</b></td><td class="num"><b>' + money(tot.t) + '</b></td>';
    return '<table class="tbl rpt-tbl"><thead>' + head + '</thead><tbody>' + rows +
      '</tbody><tfoot><tr><td colspan="' + span + '"><b>TOTALS</b></td>' + footCells + '</tr></tfoot></table>';
  }
  function remittanceCard(kind, title, desc) {
    return card(title,
      '<p class="muted">' + desc + '</p><div class="dtr-scroll">' + remittanceTable(kind) + '</div>',
      '<button class="btn-sm" data-remit-print="' + kind + '">Download PDF / Print</button>' +
      '<button class="btn-sm" data-remit-csv="' + kind + '">Export CSV</button>');
  }
  function exportRemittanceCSV(kind, monthLabel) {
    var data = remittanceData(kind);
    var lines, fname;
    if (kind === 'sss') {
      lines = [['SSS No.', 'Name', 'MSC', 'EE', 'ER', 'EC', 'Total'].join(',')];
      data.forEach(function (d) {
        var t = (d.sss.ee + d.sss.er + d.sss.ec).toFixed(2);
        lines.push([d.emp.sssNo || '', name(d.emp), d.sss.msc, d.sss.ee.toFixed(2), d.sss.er.toFixed(2),
          d.sss.ec.toFixed(2), t].map(csvCell).join(','));
      });
      fname = 'SSS_R3';
    } else if (kind === 'philhealth') {
      lines = [['PhilHealth No.', 'Name', 'Salary Base', 'EE', 'ER', 'Total'].join(',')];
      data.forEach(function (d) {
        lines.push([d.emp.philhealthNo || '', name(d.emp), d.philhealth.base, d.philhealth.ee.toFixed(2),
          d.philhealth.er.toFixed(2), d.philhealth.total.toFixed(2)].map(csvCell).join(','));
      });
      fname = 'PhilHealth_RF1';
    } else {
      lines = [['Pag-IBIG MID No.', 'Name', 'EE', 'ER', 'Total'].join(',')];
      data.forEach(function (d) {
        lines.push([d.emp.pagibigNo || '', name(d.emp), d.pagibig.ee.toFixed(2),
          d.pagibig.er.toFixed(2), d.pagibig.total.toFixed(2)].map(csvCell).join(','));
      });
      fname = 'PagIBIG_MCRF';
    }
    downloadFile(fname + '_' + monthLabel.replace(/[^\w]+/g, '_') + '.csv', lines.join('\n'), 'text/csv');
  }
  function name(e) { return e.lastName + ', ' + e.firstName + (e.middleName ? ' ' + e.middleName.charAt(0) + '.' : ''); }

  function csvCell(v) {
    v = String(v == null ? '' : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /* ===================== 13TH MONTH PAY ===================== */
  var TAX_EXEMPT_13TH = 90000; // ₱90,000 exemption ceiling (shared w/ other benefits)

  function periodYear(p) {
    var d = p.endDate || p.payDate || p.startDate;
    if (!d) return null;
    var dt = new Date(d + 'T00:00:00');
    return isNaN(dt.getTime()) ? null : dt.getFullYear();
  }
  // Sum finalized "Basic Pay" earned by an employee within a calendar year.
  function basicEarnedFromHistory(empId, year) {
    var pol = (S.db.meta && S.db.meta.thirteenthPolicy) || {};
    var deductTardy = pol.deductTardiness !== false; // default: deduct
    var total = 0;
    S.list('periods').forEach(function (p) {
      if (periodYear(p) !== year) return;
      var run = (S.db.payrolls[p.id] || {})[empId];
      if (!run) return;
      (run.earnings || []).forEach(function (e) {
        if (/^Basic Pay/.test(e.name)) total += e.amount;
      });
      // Absences already lower Basic Pay; also net out tardiness & undertime
      // (time not worked) when the policy calls for it.
      if (deductTardy && run.dtr) {
        total -= (run.dtr.lateDeduction || 0) + (run.dtr.undertimeDeduction || 0);
      }
    });
    return PH.statutory.round2(Math.max(0, total));
  }

  function viewThirteenth(v) {
    var thisYear = new Date().getFullYear();
    var years = {};
    S.list('periods').forEach(function (p) { var y = periodYear(p); if (y) years[y] = 1; });
    years[thisYear] = 1;
    var yearList = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    var year = state.thirteenthYear || yearList[0] || thisYear;
    state.thirteenthYear = year;

    var store = S.db.thirteenthMonth[year] = S.db.thirteenthMonth[year] || {};
    var emps = S.list('employees').filter(function (e) { return e.active !== false; });

    function basicFor(emp) {
      var ov = store[emp.id];
      if (ov && ov.basicEarned != null) return ov.basicEarned;
      var hist = basicEarnedFromHistory(emp.id, year);
      return hist > 0 ? hist : PH.payroll.rates(emp).monthlyBasic * 12; // full-year estimate
    }
    function releasedFor(emp) { var ov = store[emp.id]; return (ov && ov.released) || 0; }

    var rows = emps.map(function (e) {
      return '<tr data-emp="' + e.id + '"><td>' + esc(e.code) + '</td><td>' + esc(name(e)) +
        '</td><td><input class="t13-basic" type="number" step="0.01" value="' + basicFor(e) + '" style="width:130px"></td>' +
        '<td class="num t13-pay">—</td>' +
        '<td><input class="t13-rel" type="number" step="0.01" value="' + releasedFor(e) + '" style="width:110px"></td>' +
        '<td class="num t13-bal">—</td><td class="num t13-tax">—</td></tr>';
    }).join('');

    v.innerHTML =
      card('13th Month Pay',
        '<p class="muted">13th month pay = <b>total basic salary earned in the year ÷ 12</b> (excludes overtime, ' +
        'holiday pay, night differential and allowances). Basic earned is pulled from finalized payrolls for the ' +
        'selected year and can be edited. Amounts up to ₱90,000 (combined with other bonuses) are tax-exempt.</p>' +
        '<p class="sub">Basic earned is net of absences' +
        (((S.db.meta.thirteenthPolicy || {}).deductTardiness !== false) ? ', tardiness and undertime' : '') +
        '. Change this in Settings → 13th Month Pay Policy.</p>' +
        '<div class="inline"><label class="fld" style="max-width:160px"><span class="fld-label">Year</span>' +
        select('t13year', yearList.map(function (y) { return [String(y), String(y)]; }), String(year)) + '</label></div>' +
        (emps.length ?
          '<div class="dtr-scroll"><table class="tbl rpt-tbl"><thead><tr><th>Code</th><th>Name</th>' +
          '<th>Basic Salary Earned</th><th class="num">13th Month Pay</th>' +
          '<th>Advance Released</th><th class="num">Balance to Release</th><th class="num">Taxable (&gt;₱90k)</th>' +
          '</tr></thead><tbody id="t13rows">' + rows + '</tbody>' +
          '<tfoot><tr><td colspan="3"><b>TOTALS</b></td><td class="num"><b id="t13totPay">—</b></td>' +
          '<td></td><td class="num"><b id="t13totBal">—</b></td><td class="num"><b id="t13totTax">—</b></td></tr></tfoot>' +
          '</table></div>'
          : '<p class="muted">No active employees.</p>'),
        (emps.length ?
          '<button class="btn" id="t13save">Save</button>' +
          '<button class="btn-sm" id="t13print">Download PDF / Print</button>' +
          '<button class="btn-sm" id="t13csv">Export CSV</button>' : ''));

    v.querySelector('[name=t13year]').addEventListener('change', function (e) {
      state.thirteenthYear = parseInt(e.target.value, 10); renderView();
    });
    if (!emps.length) return;

    function recompute() {
      var totPay = 0, totBal = 0, totTax = 0;
      v.querySelectorAll('#t13rows tr').forEach(function (tr) {
        var basic = parseFloat(tr.querySelector('.t13-basic').value) || 0;
        var released = parseFloat(tr.querySelector('.t13-rel').value) || 0;
        var pay = PH.statutory.round2(basic / 12);
        var bal = PH.statutory.round2(pay - released);
        var tax = PH.statutory.round2(Math.max(0, pay - TAX_EXEMPT_13TH));
        tr.querySelector('.t13-pay').textContent = money(pay);
        tr.querySelector('.t13-bal').textContent = money(bal);
        tr.querySelector('.t13-tax').textContent = money(tax);
        totPay += pay; totBal += bal; totTax += tax;
      });
      v.querySelector('#t13totPay').textContent = money(totPay);
      v.querySelector('#t13totBal').textContent = money(totBal);
      v.querySelector('#t13totTax').textContent = money(totTax);
    }
    v.querySelectorAll('#t13rows input').forEach(function (inp) {
      inp.addEventListener('input', recompute);
    });
    recompute();

    v.querySelector('#t13save').addEventListener('click', function () {
      v.querySelectorAll('#t13rows tr').forEach(function (tr) {
        var id = tr.dataset.emp;
        store[id] = {
          basicEarned: parseFloat(tr.querySelector('.t13-basic').value) || 0,
          released: parseFloat(tr.querySelector('.t13-rel').value) || 0
        };
      });
      S.save();
      toast('13th month figures saved for ' + year + '.');
    });
    v.querySelector('#t13print').addEventListener('click', function () {
      printHTML('13th Month Pay ' + year, thirteenthPrintHTML(year));
    });
    v.querySelector('#t13csv').addEventListener('click', function () { exportThirteenthCSV(year); });
  }

  function thirteenthRows(year) {
    var store = S.db.thirteenthMonth[year] || {};
    return S.list('employees').filter(function (e) { return e.active !== false; }).map(function (e) {
      var ov = store[e.id];
      var basic = ov && ov.basicEarned != null ? ov.basicEarned
        : (basicEarnedFromHistory(e.id, year) || PH.payroll.rates(e).monthlyBasic * 12);
      var released = (ov && ov.released) || 0;
      var pay = PH.statutory.round2(basic / 12);
      return { emp: e, basic: basic, released: released, pay: pay,
        balance: PH.statutory.round2(pay - released),
        taxable: PH.statutory.round2(Math.max(0, pay - TAX_EXEMPT_13TH)) };
    });
  }
  function thirteenthPrintHTML(year) {
    var data = thirteenthRows(year);
    var tp = 0, tb = 0, tt = 0;
    var body = data.map(function (d) {
      tp += d.pay; tb += d.balance; tt += d.taxable;
      return '<tr><td>' + esc(d.emp.code) + '</td><td>' + esc(name(d.emp)) +
        '</td><td class="num">' + money(d.basic) + '</td><td class="num">' + money(d.pay) +
        '</td><td class="num">' + money(d.released) + '</td><td class="num">' + money(d.balance) +
        '</td><td class="num">' + money(d.taxable) + '</td></tr>';
    }).join('');
    return '<h2>13th Month Pay — ' + year + '</h2>' +
      '<div class="rpt-sub">' + esc(S.db.meta.company.name) + '</div>' +
      '<table class="tbl rpt-tbl"><thead><tr><th>Code</th><th>Name</th><th class="num">Basic Earned</th>' +
      '<th class="num">13th Month</th><th class="num">Advance</th><th class="num">Balance</th><th class="num">Taxable</th></tr></thead>' +
      '<tbody>' + body + '</tbody><tfoot><tr><td colspan="3"><b>TOTALS</b></td>' +
      '<td class="num"><b>' + money(tp) + '</b></td><td></td><td class="num"><b>' + money(tb) +
      '</b></td><td class="num"><b>' + money(tt) + '</b></td></tr></tfoot></table>' +
      '<p style="font-size:11px;color:#555">13th month pay = total basic salary earned ÷ 12. Tax-exempt up to ₱90,000 ' +
      '(shared with other bonuses/benefits); the excess is taxable.</p>';
  }
  function exportThirteenthCSV(year) {
    var data = thirteenthRows(year);
    var lines = [['Code', 'Name', 'Basic Salary Earned', '13th Month Pay', 'Advance Released', 'Balance to Release', 'Taxable Portion'].join(',')];
    data.forEach(function (d) {
      lines.push([d.emp.code, name(d.emp), d.basic.toFixed(2), d.pay.toFixed(2),
        d.released.toFixed(2), d.balance.toFixed(2), d.taxable.toFixed(2)].map(csvCell).join(','));
    });
    downloadFile('13th_month_' + year + '.csv', lines.join('\n'), 'text/csv');
  }

  /* ===================== BIR FORMS ===================== */
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function dateOf(p) {
    var s = p.endDate || p.payDate || p.startDate;
    var d = s ? new Date(s + 'T00:00:00') : null;
    return d && !isNaN(d.getTime()) ? d : null;
  }
  function resultsFor(p) {
    return (p.status === 'finalized' && S.db.payrolls[p.id]) ? S.db.payrolls[p.id] : PH.payroll.runPeriod(p);
  }
  // Sum compensation figures per employee across a set of periods.
  function aggregateComp(periodsList) {
    var agg = {};
    periodsList.forEach(function (p) {
      var res = resultsFor(p);
      Object.keys(res).forEach(function (id) {
        var r = res[id];
        var a = agg[id] || (agg[id] = { gross: 0, contrib: 0, nonTax: 0, taxable: 0, tax: 0 });
        a.gross += r.grossPay;
        a.contrib += r.contributions.employeeTotal;
        a.nonTax += r.nonTaxableEarnings;
        a.taxable += r.taxableBase;
        a.tax += r.withholdingTax;
      });
    });
    Object.keys(agg).forEach(function (id) {
      var a = agg[id];
      Object.keys(a).forEach(function (k) { a[k] = PH.statutory.round2(a[k]); });
    });
    return agg;
  }
  function thirteenthPayFor(empId, year) {
    var rows = thirteenthRows(year);
    var found = rows.filter(function (r) { return r.emp.id === empId; })[0];
    return found ? found.pay : 0;
  }

  function viewBIR(v) {
    var thisYear = new Date().getFullYear();
    var years = {};
    S.list('periods').forEach(function (p) { var y = periodYear(p); if (y) years[y] = 1; });
    years[thisYear] = 1;
    var yearList = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    var year = state.birYear || yearList[0] || thisYear;
    state.birYear = year;

    var periodsY = S.list('periods').filter(function (p) { return periodYear(p) === year; });
    var defMonth = state.birMonth != null ? state.birMonth
      : (periodsY.length && dateOf(periodsY[periodsY.length - 1]) ? dateOf(periodsY[periodsY.length - 1]).getMonth() : new Date().getMonth());
    state.birMonth = defMonth;

    var monthPeriods = periodsY.filter(function (p) { var d = dateOf(p); return d && d.getMonth() === defMonth; });
    var monthAgg = aggregateComp(monthPeriods);
    var yearAgg = aggregateComp(periodsY);
    var emps = S.list('employees').filter(function (e) { return e.active !== false; });

    // ---- 1601-C (monthly) ----
    var mt = { gross: 0, contrib: 0, nonTax: 0, taxable: 0, tax: 0 };
    var mRows = emps.map(function (e) {
      var a = monthAgg[e.id]; if (!a) return '';
      mt.gross += a.gross; mt.contrib += a.contrib; mt.nonTax += a.nonTax; mt.taxable += a.taxable; mt.tax += a.tax;
      return '<tr><td>' + esc(e.tin || '—') + '</td><td>' + esc(name(e)) +
        '</td><td class="num">' + money(a.gross) + '</td><td class="num">' + money(a.contrib + a.nonTax) +
        '</td><td class="num">' + money(a.taxable) + '</td><td class="num"><b>' + money(a.tax) + '</b></td></tr>';
    }).join('');
    var c1601 = !monthPeriods.length
      ? '<p class="muted">No payroll for ' + MONTHS[defMonth] + ' ' + year + '. Create/finalize a period covering that month.</p>'
      : '<div class="bir-summary">Total tax withheld to remit for <b>' + MONTHS[defMonth] + ' ' + year +
        '</b>: <span>' + money(mt.tax) + '</span></div>' +
        '<div class="dtr-scroll"><table class="tbl rpt-tbl"><thead><tr><th>TIN</th><th>Employee</th>' +
        '<th class="num">Gross Comp.</th><th class="num">Non-Taxable</th><th class="num">Taxable Comp.</th>' +
        '<th class="num">Tax Withheld</th></tr></thead><tbody>' + mRows +
        '</tbody><tfoot><tr><td colspan="2"><b>TOTALS</b></td><td class="num"><b>' + money(mt.gross) +
        '</b></td><td class="num"><b>' + money(mt.contrib + mt.nonTax) + '</b></td><td class="num"><b>' + money(mt.taxable) +
        '</b></td><td class="num"><b>' + money(mt.tax) + '</b></td></tr></tfoot></table></div>';

    // ---- 2316 (annual, per employee) ----
    var yRows = emps.map(function (e) {
      var a = yearAgg[e.id] || { gross: 0, contrib: 0, nonTax: 0, taxable: 0, tax: 0 };
      var t13 = thirteenthPayFor(e.id, year);
      var non13 = Math.min(t13, TAX_EXEMPT_13TH);
      var nonTaxable = PH.statutory.round2(a.contrib + a.nonTax + non13);
      return '<tr><td>' + esc(e.code) + '</td><td>' + esc(name(e)) +
        '</td><td class="num">' + money(a.gross) + '</td><td class="num">' + money(nonTaxable) +
        '</td><td class="num">' + money(a.taxable) + '</td><td class="num"><b>' + money(a.tax) +
        '</b></td><td><button class="btn-sm" data-2316="' + e.id + '">Certificate</button></td></tr>';
    }).join('');

    v.innerHTML =
      card('BIR Forms',
        '<div class="inline"><label class="fld" style="max-width:150px"><span class="fld-label">Year</span>' +
        select('birYear', yearList.map(function (y) { return [String(y), String(y)]; }), String(year)) + '</label></div>' +
        '<p class="disclaimer">These summarise your payroll for filing support. They do <b>not</b> perform BIR year-end ' +
        'tax annualisation/refund — have year-end adjustments reviewed by your accountant. Ensure company &amp; employee ' +
        'TINs are filled in.</p>') +
      card('1601-C — Monthly Remittance of Tax Withheld on Compensation',
        '<div class="inline"><label class="fld" style="max-width:180px"><span class="fld-label">Month</span>' +
        select('birMonth', MONTHS.map(function (m, i) { return [String(i), m]; }), String(defMonth)) + '</label></div>' +
        c1601,
        monthPeriods.length ? '<button class="btn-sm" id="bir1601Print">Download PDF / Print</button>' +
          '<button class="btn-sm" id="bir1601Csv">Export CSV</button>' : '') +
      card('2316 — Certificate of Compensation Payment / Tax Withheld (annual)',
        '<p class="muted">One certificate per employee for ' + year + '. Non-taxable includes mandatory contributions, ' +
        'de minimis/non-taxable allowances and 13th-month pay up to ₱90,000.</p>' +
        (emps.length ? '<div class="dtr-scroll"><table class="tbl rpt-tbl"><thead><tr><th>Code</th><th>Employee</th>' +
          '<th class="num">Gross Comp.</th><th class="num">Non-Taxable</th><th class="num">Taxable Comp.</th>' +
          '<th class="num">Tax Withheld</th><th></th></tr></thead><tbody>' + yRows + '</tbody></table></div>'
          : '<p class="muted">No active employees.</p>'),
        emps.length ? '<button class="btn-sm" id="bir2316All">Print All Certificates</button>' : '');

    v.querySelector('[name=birYear]').addEventListener('change', function (e) {
      state.birYear = parseInt(e.target.value, 10); state.birMonth = null; renderView();
    });
    v.querySelector('[name=birMonth]').addEventListener('change', function (e) {
      state.birMonth = parseInt(e.target.value, 10); renderView();
    });
    var p1 = v.querySelector('#bir1601Print');
    if (p1) p1.addEventListener('click', function () {
      printHTML('1601-C ' + MONTHS[defMonth] + ' ' + year, form1601HTML(monthAgg, defMonth, year));
    });
    var c1 = v.querySelector('#bir1601Csv');
    if (c1) c1.addEventListener('click', function () { export1601CSV(monthAgg, defMonth, year); });
    v.querySelectorAll('[data-2316]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = S.find('employees', b.dataset['2316']);
        printHTML('BIR 2316 — ' + e.code + ' — ' + year, form2316HTML(yearAgg[e.id], e, year));
      });
    });
    var all = v.querySelector('#bir2316All');
    if (all) all.addEventListener('click', function () {
      printHTML('BIR 2316 Certificates — ' + year,
        emps.map(function (e) { return form2316HTML(yearAgg[e.id], e, year); }).join('<div class="page-break"></div>'));
    });
  }

  function form1601HTML(agg, month, year) {
    var comp = S.db.meta.company;
    var t = { gross: 0, contrib: 0, nonTax: 0, taxable: 0, tax: 0 };
    var rows = S.list('employees').filter(function (e) { return e.active !== false && agg[e.id]; }).map(function (e) {
      var a = agg[e.id];
      t.gross += a.gross; t.contrib += a.contrib; t.nonTax += a.nonTax; t.taxable += a.taxable; t.tax += a.tax;
      return '<tr><td>' + esc(e.tin || '') + '</td><td>' + esc(name(e)) + '</td><td class="num">' + money(a.gross) +
        '</td><td class="num">' + money(a.contrib + a.nonTax) + '</td><td class="num">' + money(a.taxable) +
        '</td><td class="num">' + money(a.tax) + '</td></tr>';
    }).join('');
    return '<h2>BIR Form 1601-C</h2><div class="rpt-sub">Monthly Remittance Return of Income Taxes Withheld on Compensation</div>' +
      '<table class="kv"><tr><td>Withholding Agent</td><td>' + esc(comp.name) + '</td><td>TIN</td><td>' + esc(comp.tin || '') + '</td></tr>' +
      '<tr><td>For the Month</td><td>' + MONTHS[month] + ' ' + year + '</td><td>Address</td><td>' + esc(comp.address || '') + '</td></tr></table>' +
      '<table class="tbl rpt-tbl"><thead><tr><th>TIN</th><th>Employee</th><th class="num">Gross Comp.</th>' +
      '<th class="num">Non-Taxable</th><th class="num">Taxable Comp.</th><th class="num">Tax Withheld</th></tr></thead><tbody>' +
      rows + '</tbody><tfoot><tr><td colspan="2"><b>TOTALS</b></td><td class="num"><b>' + money(t.gross) +
      '</b></td><td class="num"><b>' + money(t.contrib + t.nonTax) + '</b></td><td class="num"><b>' + money(t.taxable) +
      '</b></td><td class="num"><b>' + money(t.tax) + '</b></td></tr></tfoot></table>' +
      '<div class="bir-remit">Total Amount of Tax Withheld to Remit: <b>' + money(t.tax) + '</b></div>';
  }
  function export1601CSV(agg, month, year) {
    var lines = [['TIN', 'Name', 'Gross Compensation', 'Non-Taxable', 'Taxable Compensation', 'Tax Withheld'].join(',')];
    S.list('employees').filter(function (e) { return e.active !== false && agg[e.id]; }).forEach(function (e) {
      var a = agg[e.id];
      lines.push([e.tin || '', name(e), a.gross.toFixed(2), (a.contrib + a.nonTax).toFixed(2),
        a.taxable.toFixed(2), a.tax.toFixed(2)].map(csvCell).join(','));
    });
    downloadFile('1601C_' + MONTHS[month] + '_' + year + '.csv', lines.join('\n'), 'text/csv');
  }

  function form2316HTML(agg, emp, year) {
    agg = agg || { gross: 0, contrib: 0, nonTax: 0, taxable: 0, tax: 0 };
    var comp = S.db.meta.company;
    var t13 = thirteenthPayFor(emp.id, year);
    var non13 = Math.min(t13, TAX_EXEMPT_13TH);
    var exc13 = PH.statutory.round2(Math.max(0, t13 - TAX_EXEMPT_13TH));
    var nonTaxable = PH.statutory.round2(agg.contrib + agg.nonTax + non13);
    var taxableComp = PH.statutory.round2(agg.taxable + exc13);
    function kv(l, val) { return '<tr><td>' + l + '</td><td class="num">' + money(val) + '</td></tr>'; }
    return '<div class="form2316">' +
      '<div class="f2316-head"><div><b>BIR Form No. 2316</b><br><span class="muted">Certificate of Compensation Payment / Tax Withheld</span></div>' +
      '<div class="num">For the Year<br><b>' + year + '</b></div></div>' +
      '<table class="kv"><tr><td>Employee</td><td>' + esc(name(emp)) + '</td><td>TIN</td><td>' + esc(emp.tin || '') + '</td></tr>' +
      '<tr><td>Address</td><td colspan="3">' + esc(emp.address || '') + '</td></tr>' +
      '<tr><td>Employer</td><td>' + esc(comp.name) + '</td><td>TIN</td><td>' + esc(comp.tin || '') + '</td></tr>' +
      '<tr><td>Employer Address</td><td colspan="3">' + esc(comp.address || '') + '</td></tr></table>' +
      '<table class="tbl f2316-tbl"><tbody>' +
      '<tr class="sec"><td colspan="2">Gross Compensation Income</td></tr>' +
      kv('Gross compensation (regular)', agg.gross) +
      kv('13th month pay &amp; other benefits', t13) +
      '<tr class="sec"><td colspan="2">Less: Non-Taxable / Exempt</td></tr>' +
      kv('SSS, PhilHealth, Pag-IBIG &amp; union dues', agg.contrib) +
      kv('De minimis / non-taxable allowances', agg.nonTax) +
      kv('13th month &amp; other benefits (max ₱90,000)', non13) +
      kv('Total non-taxable / exempt', nonTaxable) +
      '<tr class="sec"><td colspan="2">Taxable Compensation</td></tr>' +
      kv('Taxable compensation income', taxableComp) +
      '</tbody><tfoot>' +
      '<tr><td><b>Total Tax Withheld</b></td><td class="num"><b>' + money(agg.tax) + '</b></td></tr></tfoot></table>' +
      '<p class="f2316-note">This certificate reflects amounts recorded in this system for the year. It does not include ' +
      'BIR year-end tax annualisation; final tax due/refund should be reviewed by your accountant.</p>' +
      '<div class="ps-sign"><div>_____________________<br>Employee Signature</div>' +
      '<div>_____________________<br>Employer / Authorized Agent</div></div></div>';
  }

  /* ===================== SETTINGS ===================== */
  function viewSettings(v) {
    var c = PH.statutory.config;
    var comp = S.db.meta.company;
    var lp = S.db.meta.leavePolicy || (S.db.meta.leavePolicy = { manualOpen: false, openDay: 21 });
    var t13 = S.db.meta.thirteenthPolicy || (S.db.meta.thirteenthPolicy = { deductTardiness: true });
    // When a location is selected in the sidebar, the three payroll-policy cards
    // (Overtime, Night Differential, Deduction Schedule) edit THAT branch's
    // override; otherwise they edit the company-wide default.
    var editingLoc = state.locationId || '';
    var LS = editingLoc ? ((S.db.meta.locationSettings || {})[editingLoc] || {}) : {};
    var OT_DEFAULT = { enabled: true, minMinutes: 60, incrementMinutes: 30, graceMinutes: 5 };
    // Display values: the branch override if it exists, else the company default.
    var ot = editingLoc ? (LS.overtime || S.db.meta.overtime || OT_DEFAULT) : (S.db.meta.overtime || (S.db.meta.overtime = OT_DEFAULT));
    var nd = editingLoc ? (LS.nightDiff || S.db.meta.nightDiff || { enabled: true }) : (S.db.meta.nightDiff || (S.db.meta.nightDiff = { enabled: true }));
    var cs = editingLoc ? (LS.contributionSchedule || S.db.meta.contributionSchedule || {}) : (S.db.meta.contributionSchedule || (S.db.meta.contributionSchedule = {}));
    // Resolve (and lazily create) the object a Save should write to.
    function policyTarget(key, dflt) {
      if (editingLoc) {
        S.db.meta.locationSettings = S.db.meta.locationSettings || {};
        var b = S.db.meta.locationSettings[editingLoc] || (S.db.meta.locationSettings[editingLoc] = {});
        return b[key] || (b[key] = JSON.parse(JSON.stringify(S.db.meta[key] || dflt)));
      }
      return S.db.meta[key] || (S.db.meta[key] = dflt);
    }
    var CS_OPTS = [['', 'Per-period (manual tick boxes)'], ['15th', 'Deduct on the 15th cut-off'], ['30th', 'Deduct on the 30th cut-off']];
    function num(path, val, step) {
      return '<input data-cfg="' + path + '" type="number" step="' + (step || 'any') + '" value="' + val + '">';
    }
    var policyBanner = editingLoc
      ? '<section class="card"><div class="card-body" style="background:#eef6ff;border-radius:8px">' +
        '<b>Editing payroll policies for ' + esc(locationName(editingLoc)) + '.</b> ' +
        'The Overtime, Night Differential and Deduction Schedule cards below set this branch\'s override (blank = follow the company default). ' +
        'Company &amp; statutory settings stay company-wide. ' +
        (((S.db.meta.locationSettings || {})[editingLoc]) ? '<button class="btn-sm" id="resetLocPol">Reset ' + esc(locationName(editingLoc)) + ' to company default</button>' : '') +
        ' <span class="muted">Switch the sidebar to “All locations” to edit the company defaults.</span></div></section>'
      : (locations().length ? '<section class="card"><div class="card-body muted">Editing <b>company-wide</b> defaults. Pick a branch in the sidebar to set a per-branch override for Overtime, Night Differential or Deduction Schedule.</div></section>' : '');
    v.innerHTML = policyBanner +
      card('Company Information',
        '<p class="muted">Shown on payslips, the 201 file and reports. For most users, this is the only section you need to fill in.</p>' +
        '<div class="grid2">' +
        field('Company Name', '<input data-co="name" value="' + esc(comp.name) + '">') +
        field('Address', '<input data-co="address" value="' + esc(comp.address || '') + '">') +
        field('TIN', '<input data-co="tin" value="' + esc(comp.tin || '') + '">') +
        '</div>',
        '<button class="btn" id="saveCo">Save Company Info</button>') +
      card('Locations / Branches',
        '<p class="muted">Set up your branches here, then assign each employee to one (on their 201). ' +
        'Use the <b>Location</b> selector in the sidebar to view a single branch or all of them together.</p>' +
        '<div id="locList">' + (locations().length
          ? '<table class="tbl"><thead><tr><th>Location Name</th><th>Employees</th><th></th></tr></thead><tbody>' +
            locations().map(function (l) {
              var n = S.list('employees').filter(function (e) { return e.locationId === l.id; }).length;
              return '<tr><td><input data-loc-id="' + l.id + '" value="' + esc(l.name) + '" style="width:100%"></td>' +
                '<td>' + n + '</td><td class="row-actions"><button class="btn-sm btn-danger" data-loc-del="' + l.id + '">Delete</button></td></tr>';
            }).join('') + '</tbody></table>'
          : '<p class="muted">No locations yet — add your branches below.</p>') + '</div>' +
        '<div class="inline" style="margin-top:10px"><input id="locNew" placeholder="New location name (e.g. Cebu Branch)"> ' +
        '<button class="btn-sm" id="locAdd">+ Add Location</button></div>',
        '<button class="btn" id="saveLocs">Save Location Names</button>') +
      card('Contribution Quick Check',
        '<p class="muted">Type a monthly salary to preview the automatic government deductions using the current rates. ' +
        'This is only a preview — it changes nothing and saves nothing.</p>' +
        '<label class="fld" style="max-width:260px"><span class="fld-label">Monthly Salary</span>' +
        '<input id="previewSalary" type="number" step="100" value="20000"></label>' +
        '<div id="previewOut" class="preview-out"></div>') +
      card('Overtime Policy',
        '<p class="muted">How overtime (work beyond an employee\'s shift end) is credited.</p>' +
        '<div class="grid2">' +
        field('Overtime enabled', select('otEnabled', [['true','Yes — credit overtime'],['false','No — never credit overtime']], String(ot.enabled !== false))) +
        field('Minimum before OT counts (minutes)',
          '<input id="otMin" type="number" value="' + (ot.minMinutes != null ? ot.minMinutes : 60) + '">' +
          '<small class="hint">Overtime is only credited once this much is completed — e.g. 60 = the first hour must be finished.</small>') +
        field('Round in blocks of (minutes)',
          '<input id="otInc" type="number" value="' + (ot.incrementMinutes || 30) + '">' +
          '<small class="hint">After the first hour, OT accrues in these blocks — e.g. 30 minutes.</small>') +
        field('Grace / rounding threshold (minutes)',
          '<input id="otGrace" type="number" value="' + (ot.graceMinutes != null ? ot.graceMinutes : 5) + '">' +
          '<small class="hint">Within this many minutes of a block, round up. e.g. 5 → clock-out 5:58 counts as 6:00 (1 hour).</small>') +
        field('Late employees forfeit first OT hour',
          select('otLateForfeit', [['true','Yes — a late employee loses the first OT hour'],['false','No — treat OT the same for everyone']], String(ot.lateForfeitsFirstHour !== false)) +
          '<small class="hint">When someone clocks in late (beyond the grace window), the first hour of overtime is not credited and OT is only counted in complete whole hours after that.</small>') +
        field('Require overtime authorization',
          select('otRequireAuth', [['true','Yes — pay overtime only when authorized'],['false','No — pay all overtime from the DTR']], String(ot.requireAuthorization !== false)) +
          '<small class="hint">When on, both post-shift OT and pre-shift (early time-in) OT are paid only for dates an employee filed and an admin approved. Unauthorized OT (and early time-in) is not paid.</small>') +
        '</div>',
        '<button class="btn" id="saveOt">Save Overtime Policy</button>') +
      card('Night Differential',
        '<p class="muted">Philippine law adds a premium (+' + Math.round(PH.dtr.NIGHT_DIFF_RATE * 100) + '%) for hours worked between 10:00 PM and 6:00 AM. ' +
        'Turn this off if your company does not pay night differential.</p>' +
        field('Night differential',
          select('ndEnabled', [['true','On — pay the night-shift premium (10 PM–6 AM)'],['false','Off — do not pay night differential']], String(nd.enabled !== false)) +
          '<small class="hint">When off, no night-differential pay is computed for anyone. Existing finalized payrolls are unaffected.</small>'),
        '<button class="btn" id="saveNd">Save Night Differential</button>') +
      card('Government Deduction Schedule',
        '<p class="muted">Choose which semi-monthly cut-off each government contribution is deducted on. ' +
        'Set once here and every payroll follows it automatically — no need to toggle per period. ' +
        '(This governs the per-period tick boxes when set.)</p>' +
        '<div class="grid3">' +
        field('SSS', select('csSSS', CS_OPTS, cs.sss || '')) +
        field('PhilHealth', select('csPH', CS_OPTS, cs.philhealth || '')) +
        field('Pag-IBIG', select('csPI', CS_OPTS, cs.pagibig || '')) +
        '</div>' +
        '<p class="hint">Withholding tax is always computed on each cut-off\'s own pay and is not scheduled here.</p>',
        '<button class="btn" id="saveCs">Save Deduction Schedule</button>') +
      card('Leave Application Window',
        '<p class="muted">Controls when employees can file leave from the portal. Sick and Emergency leave can always be filed (including recent past days); this window governs planned (Vacation) leave for future months.</p>' +
        '<div class="grid2">' +
        field('Next-month filing opens on day',
          '<input id="lpOpenDay" type="number" min="1" max="28" value="' + (lp.openDay != null ? lp.openDay : 21) + '">' +
          '<small class="hint">Employees can file next month\'s leave only from this day of the current month onward. e.g. 21 → leave for next month opens on the 21st.</small>') +
        field('Open filing now (override)',
          select('lpManual', [['false','No — follow the day rule above'],['true','Yes — open future-month filing immediately']], String(!!lp.manualOpen)) +
          '<small class="hint">Turn on to let employees file leave for any upcoming month right away, ignoring the day rule.</small>') +
        '</div>',
        '<button class="btn" id="saveLp">Save Leave Window</button>') +
      card('13th Month Pay Policy',
        '<p class="muted">The 13th-month base is the total Basic Pay earned for the year. Absences already lower it. This setting decides whether tardiness and undertime (time not worked) are also netted out.</p>' +
        field('Deduct tardiness & undertime from the 13th-month base',
          select('t13Tardy', [['true','Yes — net out tardiness & undertime'],['false','No — ignore tardiness & undertime']], String(t13.deductTardiness !== false)) +
          '<small class="hint">Following DOLE, 13th-month pay is based on basic salary actually earned. Turn off only if your company chooses not to deduct tardiness/undertime.</small>') ,
        '<button class="btn" id="saveT13">Save 13th Month Policy</button>') +
      '<details class="advanced"><summary>⚙️ Advanced: government rate tables — most users can leave these alone</summary>' +
        '<div class="advanced-body">' +
        '<p class="disclaimer">These are already set to the latest Philippine government rates (2025). ' +
        'Only change them when an official SSS, PhilHealth, Pag-IBIG (HDMF) or BIR circular updates the rates. ' +
        'If you are unsure, leave everything as it is.</p>' +
        card('SSS',
          '<div class="grid3">' +
          field('Employee Rate', num('sss.employeeRate', c.sss.employeeRate)) +
          field('Employer Rate', num('sss.employerRate', c.sss.employerRate)) +
          field('MSC Step', num('sss.mscStep', c.sss.mscStep)) +
          field('MSC Minimum', num('sss.mscMin', c.sss.mscMin)) +
          field('MSC Maximum', num('sss.mscMax', c.sss.mscMax)) +
          field('EC Threshold (MSC)', num('sss.ecThreshold', c.sss.ecThreshold)) +
          field('EC Low', num('sss.ecLow', c.sss.ecLow)) +
          field('EC High', num('sss.ecHigh', c.sss.ecHigh)) +
          '</div>') +
        card('PhilHealth',
          '<div class="grid3">' +
          field('Premium Rate', num('philhealth.rate', c.philhealth.rate)) +
          field('Employee Share', num('philhealth.employeeShare', c.philhealth.employeeShare)) +
          field('Income Floor', num('philhealth.floor', c.philhealth.floor)) +
          field('Income Ceiling', num('philhealth.ceiling', c.philhealth.ceiling)) +
          '</div>') +
        card('Pag-IBIG (HDMF)',
          '<div class="grid3">' +
          field('Low Bracket (≤)', num('pagibig.lowBracket', c.pagibig.lowBracket)) +
          field('EE Rate (low)', num('pagibig.eeRateLow', c.pagibig.eeRateLow)) +
          field('EE Rate (high)', num('pagibig.eeRateHigh', c.pagibig.eeRateHigh)) +
          field('ER Rate', num('pagibig.erRate', c.pagibig.erRate)) +
          field('Max Base', num('pagibig.maxBase', c.pagibig.maxBase)) +
          '</div>') +
        card('BIR Withholding Tax (Monthly brackets)',
          '<p class="muted">Over / Base tax / Rate. Daily, weekly and semi-monthly tables are derived automatically.</p>' +
          '<table class="tbl"><thead><tr><th>Compensation Over</th><th>Base Tax</th><th>Rate</th></tr></thead><tbody>' +
          c.tax.brackets.map(function (b, i) {
            return '<tr><td>' + num('tax.brackets.' + i + '.over', b.over) + '</td>' +
              '<td>' + num('tax.brackets.' + i + '.base', b.base) + '</td>' +
              '<td>' + num('tax.brackets.' + i + '.rate', b.rate) + '</td></tr>';
          }).join('') + '</tbody></table>',
          '<button class="btn" id="saveCfg">Save Rate Changes</button>' +
          '<button class="btn-sm btn-danger" id="resetCfg">Reset to Default Rates</button>') +
        '</div></details>';

    v.querySelector('#saveCo').addEventListener('click', function () {
      v.querySelectorAll('[data-co]').forEach(function (inp) { comp[inp.dataset.co] = inp.value; });
      S.save();
      toast('Company info saved.');
      render();
    });
    // ---- Locations / branches ----
    S.db.meta.locations = S.db.meta.locations || [];
    var locAdd = v.querySelector('#locAdd');
    if (locAdd) locAdd.addEventListener('click', function () {
      var name = (v.querySelector('#locNew').value || '').trim();
      if (!name) { alert('Enter a location name.'); return; }
      S.db.meta.locations.push({ id: 'loc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name });
      S.save(); renderView();
    });
    var saveLocs = v.querySelector('#saveLocs');
    if (saveLocs) saveLocs.addEventListener('click', function () {
      v.querySelectorAll('[data-loc-id]').forEach(function (inp) {
        var loc = S.db.meta.locations.filter(function (l) { return l.id === inp.dataset.locId; })[0];
        if (loc) loc.name = (inp.value || '').trim() || loc.name;
      });
      S.save(); toast('Locations saved.'); renderView();
    });
    v.querySelectorAll('[data-loc-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.locDel;
        var used = S.list('employees').filter(function (e) { return e.locationId === id; }).length;
        if (used > 0) { alert('This location still has ' + used + ' employee(s) assigned. Reassign them first, then delete.'); return; }
        if (!confirm('Delete this location?')) return;
        S.db.meta.locations = S.db.meta.locations.filter(function (l) { return l.id !== id; });
        if (state.locationId === id) state.locationId = '';
        S.save(); renderView();
      });
    });
    var locSuffix = editingLoc ? ' for ' + locationName(editingLoc) : '';
    var resetBtn = v.querySelector('#resetLocPol');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (!confirm('Reset ' + locationName(editingLoc) + ' to the company-default policies?')) return;
      if (S.db.meta.locationSettings) delete S.db.meta.locationSettings[editingLoc];
      S.save(); renderView();
    });
    v.querySelector('#saveOt').addEventListener('click', function () {
      var t = policyTarget('overtime', OT_DEFAULT);
      t.enabled = v.querySelector('[name=otEnabled]').value === 'true';
      t.minMinutes = parseInt(v.querySelector('#otMin').value, 10) || 0;
      t.incrementMinutes = parseInt(v.querySelector('#otInc').value, 10) || 30;
      t.graceMinutes = parseInt(v.querySelector('#otGrace').value, 10) || 0;
      t.lateForfeitsFirstHour = v.querySelector('[name=otLateForfeit]').value === 'true';
      t.requireAuthorization = v.querySelector('[name=otRequireAuth]').value === 'true';
      S.save();
      toast('Overtime policy saved' + locSuffix + '.');
    });
    v.querySelector('#saveNd').addEventListener('click', function () {
      var t = policyTarget('nightDiff', { enabled: true });
      t.enabled = v.querySelector('[name=ndEnabled]').value === 'true';
      S.save();
      toast('Night differential ' + (t.enabled ? 'enabled' : 'disabled') + locSuffix + '.');
    });
    v.querySelector('#saveCs').addEventListener('click', function () {
      var t = policyTarget('contributionSchedule', {});
      function set(key, sel) { var val = v.querySelector(sel).value; if (val) t[key] = val; else delete t[key]; }
      set('sss', '[name=csSSS]'); set('philhealth', '[name=csPH]'); set('pagibig', '[name=csPI]');
      S.save();
      toast('Government deduction schedule saved' + locSuffix + '.');
    });
    v.querySelector('#saveLp').addEventListener('click', function () {
      var day = parseInt(v.querySelector('#lpOpenDay').value, 10);
      lp.openDay = (day >= 1 && day <= 28) ? day : 21;
      lp.manualOpen = v.querySelector('[name=lpManual]').value === 'true';
      S.save();
      toast('Leave application window saved.');
    });
    v.querySelector('#saveT13').addEventListener('click', function () {
      t13.deductTardiness = v.querySelector('[name=t13Tardy]').value === 'true';
      S.save();
      toast('13th month pay policy saved.');
    });
    v.querySelector('#saveCfg').addEventListener('click', function () {
      v.querySelectorAll('[data-cfg]').forEach(function (inp) {
        var path = inp.dataset.cfg.split('.');
        var obj = PH.statutory.config;
        for (var i = 0; i < path.length - 1; i++) obj = obj[path[i]];
        obj[path[path.length - 1]] = parseFloat(inp.value) || 0;
      });
      S.save();
      toast('Rates saved.');
      renderPreview();
    });
    v.querySelector('#resetCfg').addEventListener('click', function () {
      if (confirm('Reset all government rate tables to the default (2025) values?')) {
        PH.statutory.resetConfig(); S.save(); renderView();
      }
    });

    function renderPreview() {
      var sal = parseFloat(v.querySelector('#previewSalary').value) || 0;
      var sss = PH.statutory.computeSSS(sal);
      var ph = PH.statutory.computePhilHealth(sal);
      var pi = PH.statutory.computePagIBIG(sal);
      var contribEE = PH.statutory.round2(sss.ee + ph.ee + pi.ee);
      var taxable = PH.statutory.round2(Math.max(0, sal - contribEE));
      var tax = PH.statutory.computeWithholdingTax(taxable, 'monthly');
      var totalDed = PH.statutory.round2(contribEE + tax);
      var net = PH.statutory.round2(sal - totalDed);
      function r2(label, val, strong) {
        return '<tr><td>' + label + '</td><td class="num">' + (strong ? '<b>' + money(val) + '</b>' : money(val)) + '</td></tr>';
      }
      v.querySelector('#previewOut').innerHTML =
        '<table class="tbl preview-tbl"><tbody>' +
        r2('SSS (employee share)', sss.ee) +
        r2('PhilHealth (employee share)', ph.ee) +
        r2('Pag-IBIG (employee share)', pi.ee) +
        r2('Withholding tax (monthly)', tax) +
        '</tbody><tfoot>' +
        r2('Total deductions', totalDed, true) +
        r2('Estimated take-home (basic only)', net, true) +
        '</tfoot></table>' +
        '<p class="hint">Excludes allowances, overtime, loans and leave — those are computed per employee at payroll time.</p>';
    }
    v.querySelector('#previewSalary').addEventListener('input', renderPreview);
    renderPreview();
  }

  /* ===================== BACKUP ===================== */
  function viewBackup(v) {
    v.innerHTML =
      card('Backup & Restore',
        '<p class="muted">All data is stored locally in this browser only. Export regularly to keep a safe copy, ' +
        'or to move data to another computer.</p>' +
        '<button class="btn" id="expBtn">⬇ Export Backup (JSON)</button> ' +
        '<label class="btn btn-file">⬆ Import Backup<input type="file" id="impFile" accept=".json,application/json" hidden></label>' +
        '<div id="backupMsg" class="msg"></div>') +
      card('Sample Files',
        '<p class="muted">A sample DTR and employee CSV are included in the <code>samples/</code> folder of this app.</p>' +
        '<button class="btn-sm" id="dlSampleDtr">Download Sample DTR CSV</button>') +
      card('Danger Zone',
        '<p class="muted">This permanently erases all employees, DTR, and payroll data on this browser.</p>' +
        '<button class="btn btn-danger" id="wipeBtn">Erase All Data</button>');

    v.querySelector('#expBtn').addEventListener('click', function () {
      downloadFile('ph_payroll_backup_' + new Date().toISOString().slice(0, 10) + '.json',
        S.exportJSON(), 'application/json');
    });
    v.querySelector('#impFile').addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var msg = v.querySelector('#backupMsg');
        try { S.importJSON(reader.result); msg.className = 'msg ok'; msg.textContent = 'Backup restored.'; render(); }
        catch (err) { msg.className = 'msg err'; msg.textContent = 'Restore failed: ' + err.message; }
      };
      reader.readAsText(file);
    });
    v.querySelector('#dlSampleDtr').addEventListener('click', function () {
      downloadFile('sample_dtr.csv', SAMPLE_DTR, 'text/csv');
    });
    v.querySelector('#wipeBtn').addEventListener('click', function () {
      if (confirm('Erase ALL data? This cannot be undone.') && confirm('Really erase everything?')) {
        S.resetAll(); render();
      }
    });
  }

  /* ===================== shared widgets ===================== */
  function field(label, control) {
    return '<label class="fld"><span class="fld-label">' + label + '</span>' + control + '</label>';
  }
  function select(name, options, value) {
    return '<select name="' + name + '" data-name="' + name + '">' + options.map(function (o) {
      var val = Array.isArray(o) ? o[0] : o, lbl = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(val) + '"' + (String(val) === String(value) ? ' selected' : '') + '>' + esc(lbl) + '</option>';
    }).join('') + '</select>';
  }
  function collect(form) {
    var out = {};
    form.querySelectorAll('input,select').forEach(function (el) {
      if (!el.name) return;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }
  function modal(title, body, onSave, size, extraFooter) {
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = '<div class="modal ' + (size || '') + '"><div class="modal-head"><h3>' + title +
      '</h3><button class="modal-x">✕</button></div><form class="modal-body">' + body + '</form>' +
      '<div class="modal-foot">' + (extraFooter || '') +
      (onSave ? '<button class="btn btn-primary" data-save>Save</button>' : '') +
      '<button class="btn" data-close>Close</button></div></div>';
    document.body.appendChild(overlay);
    var form = overlay.querySelector('form');
    function close() { overlay.remove(); }
    overlay.querySelector('.modal-x').onclick = close;
    overlay.querySelector('[data-close]').onclick = close;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    var saveBtn = overlay.querySelector('[data-save]');
    if (saveBtn) saveBtn.onclick = function () {
      if (onSave(form) === false) return; close();
    };
    return overlay;
  }
  function toast(text) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }
  function downloadFile(name, content, type) {
    // On Android, save to the device's Downloads via the native bridge.
    if (PH.platform && PH.platform.saveFile(name, content, type)) {
      toast('Saved to Downloads: ' + name);
      return;
    }
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  var SAMPLE_DTR = 'EmployeeCode,Date,TimeIn,TimeOut,Break,DayType,RestDay,ScheduledIn,ScheduledOut,Absent,LeaveType,RequiredHours\n' +
    'EMP-001,2026-07-01,08:00,17:00,60,regular,,,,,,\n' +
    'EMP-001,2026-07-02,08:15,19:30,60,regular,,,,,,\n' +
    'EMP-001,2026-07-07,08:00,17:00,60,regular,,,,,SL,\n' +
    'EMP-001,2026-07-08,,,,regular,,,,1,,\n' +
    'EMP-001,2026-07-10,08:00,17:00,60,regular_holiday,,,,,,\n' +
    'EMP-002,2026-07-04,,,,regular,,,,,VL,\n';

  var PAYSLIP_PRINT_CSS = '';

  PH.ui = {
    render: render, navigate: navigate,
    _setPrintCss: function (css) { PAYSLIP_PRINT_CSS = css; },
    money: money
  };
})(window.PH = window.PH || {});
