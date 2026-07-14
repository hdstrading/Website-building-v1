/* ==========================================================================
 * ui.js — User interface: navigation, views, forms, rendering
 * ========================================================================== */
(function (PH) {
  'use strict';

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
  var qs = function (sel, root) { return (root || document).querySelector(sel); };

  var state = { view: 'dashboard', selectedPeriod: null, lastRun: null };

  var VIEWS = [
    ['dashboard', 'Dashboard', '📊'],
    ['employees', 'Employees', '👥'],
    ['dtr', 'DTR / Time', '⏰'],
    ['earnings', 'Allowances & Commissions', '💰'],
    ['loans', 'Loans & Advances', '🏦'],
    ['payroll', 'Run Payroll', '🧮'],
    ['settings', 'Statutory Settings', '⚙️'],
    ['backup', 'Backup & Data', '💾']
  ];

  function navigate(view) { state.view = view; render(); }

  function render() {
    var app = qs('#app');
    app.innerHTML =
      '<aside class="sidebar">' +
        '<div class="brand"><span class="brand-mark">₱</span>' +
          '<div><div class="brand-title">PH Payroll</div>' +
          '<div class="brand-sub">Offline Edition</div></div></div>' +
        '<nav>' + VIEWS.map(function (v) {
          return '<a href="#" class="nav-item ' + (state.view === v[0] ? 'active' : '') +
            '" data-nav="' + v[0] + '"><span class="nav-ico">' + v[2] + '</span>' + v[1] + '</a>';
        }).join('') + '</nav>' +
        '<div class="sidebar-foot">' + esc(S.db.meta.company.name) + '</div>' +
      '</aside>' +
      '<main class="main"><div id="view"></div></main>';

    app.querySelectorAll('[data-nav]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); navigate(a.dataset.nav); });
    });
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
    var emps = S.list('employees');
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

    var periods = S.list('periods');
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
  function viewEmployees(v) {
    var emps = S.list('employees');
    var rows = emps.length ? emps.map(function (e) {
      var r = PH.payroll.rates(e);
      return '<tr><td><b>' + esc(e.code) + '</b></td><td>' + esc(e.lastName + ', ' + e.firstName) +
        '</td><td>' + esc(e.position || '') + '</td><td>' + esc(e.employmentType) +
        '</td><td>' + money(e.basicSalary) + '</td><td>' + money(r.daily) +
        '</td><td>' + (e.active !== false ? '<span class="badge badge-ok">active</span>' : '<span class="badge">inactive</span>') +
        '</td><td class="row-actions">' +
        '<button class="btn-sm" data-emp-edit="' + e.id + '">Edit</button>' +
        '<button class="btn-sm btn-danger" data-emp-del="' + e.id + '">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="muted">No employees yet. Click "Add Employee".</td></tr>';

    v.innerHTML = card('Employees',
      '<table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Position</th><th>Type</th>' +
      '<th>Basic</th><th>Daily Rate</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table>',
      '<button class="btn" data-emp-add>+ Add Employee</button>');

    v.querySelector('[data-emp-add]').addEventListener('click', function () { employeeForm(); });
    v.querySelectorAll('[data-emp-edit]').forEach(function (b) {
      b.addEventListener('click', function () { employeeForm(S.find('employees', b.dataset.empEdit)); });
    });
    v.querySelectorAll('[data-emp-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (confirm('Delete this employee?')) { S.remove('employees', b.dataset.empDel); renderView(); }
      });
    });
  }

  function employeeForm(emp) {
    emp = emp || { employmentType: 'monthly', dailyRateFactor: 313, workDaysPerWeek: 6, restDay: 0, active: true, contributionBasis: 'basic' };
    var f = [
      ['code', 'Employee Code', 'text'], ['firstName', 'First Name', 'text'],
      ['lastName', 'Last Name', 'text'], ['position', 'Position', 'text'],
      ['department', 'Department', 'text'], ['hireDate', 'Date Hired', 'date'],
      ['sssNo', 'SSS No.', 'text'], ['philhealthNo', 'PhilHealth No.', 'text'],
      ['pagibigNo', 'Pag-IBIG No.', 'text'], ['tin', 'TIN', 'text'],
      ['bankAccount', 'Bank / Account', 'text']
    ];
    var body =
      '<div class="grid2">' + f.map(function (x) {
        return field(x[1], '<input name="' + x[0] + '" type="' + x[2] + '" value="' + esc(emp[x[0]] || '') + '">');
      }).join('') +
      field('Employment Type',
        select('employmentType', ['monthly', 'daily', 'hourly'], emp.employmentType)) +
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
      '</div>';
    modal((emp.id ? 'Edit' : 'Add') + ' Employee', body, function (form) {
      var data = collect(form);
      data.id = emp.id;
      data.basicSalary = parseFloat(data.basicSalary) || 0;
      data.dailyRateFactor = parseInt(data.dailyRateFactor, 10) || 313;
      data.workDaysPerWeek = parseInt(data.workDaysPerWeek, 10) || 6;
      data.restDay = parseInt(data.restDay, 10) || 0;
      data.active = data.active === 'true';
      if (!data.code || !data.lastName) { alert('Code and Last Name are required.'); return false; }
      S.upsert('employees', data);
      renderView();
    });
  }

  /* ===================== DTR ===================== */
  function viewDTR(v) {
    var periods = S.list('periods');
    if (!periods.length) {
      v.innerHTML = card('DTR / Time Records',
        '<p class="muted">Create a payroll period first (under "Run Payroll") to attach a DTR.</p>');
      return;
    }
    var pid = state.selectedPeriod || periods[0].id;
    state.selectedPeriod = pid;
    var period = S.find('periods', pid);
    var dtr = (S.db.dtr[pid]) || {};

    var byEmp = S.list('employees').map(function (e) {
      var days = dtr[e.id] || [];
      return '<tr><td>' + esc(e.code) + '</td><td>' + esc(e.lastName + ', ' + e.firstName) +
        '</td><td>' + days.length + ' day(s)</td><td class="row-actions">' +
        '<button class="btn-sm" data-dtr-edit="' + e.id + '">Enter / Edit</button>' +
        (days.length ? '<button class="btn-sm btn-danger" data-dtr-clear="' + e.id + '">Clear</button>' : '') +
        '</td></tr>';
    }).join('');

    v.innerHTML =
      card('Select Period',
        '<div class="inline">' + select('period', periods.map(function (p) { return [p.id, p.name]; }), pid) +
        '</div>', '') +
      card('Upload DTR (CSV)',
        '<p class="muted">Columns: <code>EmployeeCode, Date, TimeIn, TimeOut, Break, DayType, RestDay, ScheduledIn, Absent, PaidLeave, RequiredHours</code>. ' +
        'Times accept <code>08:00</code>, <code>8:00 AM</code> or <code>0800</code>. See <code>samples/sample_dtr.csv</code>.</p>' +
        '<input type="file" id="dtrFile" accept=".csv,text/csv">' +
        '<button class="btn" id="dtrImportBtn">Import into Period</button>' +
        '<div id="dtrImportMsg" class="msg"></div>') +
      card('DTR Status — ' + esc(period.name),
        '<table class="tbl"><thead><tr><th>Code</th><th>Employee</th><th>Records</th><th></th></tr></thead><tbody>' +
        byEmp + '</tbody></table>');

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

  function dtrForm(pid, empId) {
    var emp = S.find('employees', empId);
    var days = ((S.db.dtr[pid] || {})[empId] || []).slice();
    function rowHtml(d, i) {
      d = d || {};
      return '<tr data-i="' + i + '">' +
        '<td><input name="date" type="date" value="' + esc(d.date || '') + '"></td>' +
        '<td><input name="timeIn" value="' + esc(d.timeIn || '') + '" placeholder="08:00"></td>' +
        '<td><input name="timeOut" value="' + esc(d.timeOut || '') + '" placeholder="17:00"></td>' +
        '<td><input name="breakMins" type="number" value="' + (d.breakMins != null ? d.breakMins : 60) + '" style="width:60px"></td>' +
        '<td>' + select('dayType', [['regular','Regular'],['special','Special'],['regular_holiday','Reg. Holiday']], d.dayType || 'regular') + '</td>' +
        '<td style="text-align:center"><input name="restDay" type="checkbox"' + (d.restDay ? ' checked' : '') + '></td>' +
        '<td style="text-align:center"><input name="absent" type="checkbox"' + (d.absent ? ' checked' : '') + '></td>' +
        '<td><button class="btn-sm btn-danger" data-row-del="' + i + '">✕</button></td></tr>';
    }
    if (!days.length) days.push({});
    var body =
      '<div class="dtr-scroll"><table class="tbl dtr-tbl"><thead><tr><th>Date</th><th>In</th><th>Out</th>' +
      '<th>Break</th><th>Day Type</th><th>Rest</th><th>Absent</th><th></th></tr></thead>' +
      '<tbody id="dtrRows">' + days.map(rowHtml).join('') + '</tbody></table></div>' +
      '<button class="btn-sm" id="dtrAddRow" type="button">+ Add Day</button>';
    modal('DTR — ' + esc(emp.lastName + ', ' + emp.firstName), body, function (form) {
      var out = [];
      form.querySelectorAll('#dtrRows tr').forEach(function (tr) {
        var g = function (n) { var el = tr.querySelector('[name=' + n + ']'); return el; };
        var date = g('date').value;
        var tin = g('timeIn').value, tout = g('timeOut').value;
        if (!date && !tin && !tout) return;
        out.push({
          date: date, timeIn: tin, timeOut: tout,
          breakMins: parseInt(g('breakMins').value, 10) || 0,
          dayType: g('dayType').value,
          restDay: g('restDay').checked, absent: g('absent').checked
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
    function bindRowDel() {
      rowsEl.querySelectorAll('[data-row-del]').forEach(function (b) {
        b.onclick = function () { b.closest('tr').remove(); };
      });
    }
    bindRowDel();
  }

  /* ===================== EARNINGS (allowances/commissions) ===================== */
  function viewEarnings(v) {
    var emps = S.list('employees');
    var alw = S.list('allowances');
    var rows = alw.length ? alw.map(function (a) {
      var e = S.find('employees', a.employeeId);
      return '<tr><td>' + esc(e ? e.code : '?') + '</td><td>' + esc(a.name) +
        '</td><td>' + esc(a.type || 'allowance') + '</td><td>' + money(a.amount) +
        '</td><td>' + (a.taxable ? 'Taxable' : 'Non-taxable') +
        '</td><td>' + (a.perPeriod ? 'Per Period' : 'Monthly') + '</td>' +
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

  function earningForm(a) {
    a = a || { taxable: false, type: 'allowance', perPeriod: false };
    var empOpts = S.list('employees').map(function (e) { return [e.id, e.code + ' — ' + e.lastName + ', ' + e.firstName]; });
    var body = '<div class="grid2">' +
      field('Employee', select('employeeId', empOpts, a.employeeId)) +
      field('Name', '<input name="name" value="' + esc(a.name || '') + '">') +
      field('Type', select('type', [['allowance','Allowance'],['commission','Commission'],['benefit','Benefit'],['other','Other']], a.type || 'allowance')) +
      field('Amount', '<input name="amount" type="number" step="0.01" value="' + (a.amount || '') + '">') +
      field('Taxable?', select('taxable', [['false','Non-taxable (de minimis)'],['true','Taxable']], String(!!a.taxable))) +
      field('Frequency', select('perPeriod', [['false','Monthly (split across periods)'],['true','Per Pay Period']], String(!!a.perPeriod))) +
      '</div>';
    modal((a.id ? 'Edit' : 'Add') + ' Earning', body, function (form) {
      var d = collect(form); d.id = a.id;
      d.amount = parseFloat(d.amount) || 0;
      d.taxable = d.taxable === 'true';
      d.perPeriod = d.perPeriod === 'true';
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
        '</td><td>' + money(l.principal) + '</td><td>' + money(l.monthlyAmortization) +
        '</td><td>' + money(l.balance) + '</td><td>' +
        (l.active ? '<span class="badge badge-ok">active</span>' : '<span class="badge">closed</span>') +
        '</td><td class="row-actions"><button class="btn-sm" data-loan-edit="' + l.id + '">Edit</button>' +
        '<button class="btn-sm btn-danger" data-loan-del="' + l.id + '">Delete</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">No loans or advances recorded.</td></tr>';

    v.innerHTML = card('Loans & Cash Advances',
      '<p class="muted">Amortizations are auto-deducted and balances decrease when a period is finalized.</p>' +
      '<table class="tbl"><thead><tr><th>Emp</th><th>Type</th><th>Principal</th><th>Amortization/mo</th>' +
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
      field('Loan Type', select('type', ['SSS Loan', 'Pag-IBIG Loan', 'Company Loan', 'Cash Advance', 'Other'], l.type)) +
      field('Principal', '<input name="principal" type="number" step="0.01" value="' + (l.principal || '') + '">') +
      field('Monthly Amortization', '<input name="monthlyAmortization" type="number" step="0.01" value="' + (l.monthlyAmortization || '') + '">') +
      field('Current Balance', '<input name="balance" type="number" step="0.01" value="' + (l.balance != null ? l.balance : l.principal || '') + '">') +
      field('Start Date', '<input name="startDate" type="date" value="' + esc(l.startDate || '') + '">') +
      field('Status', select('active', [['true','Active'],['false','Closed']], String(l.active !== false))) +
      '</div>';
    modal((l.id ? 'Edit' : 'Add') + ' Loan', body, function (form) {
      var d = collect(form); d.id = l.id;
      d.principal = parseFloat(d.principal) || 0;
      d.monthlyAmortization = parseFloat(d.monthlyAmortization) || 0;
      d.balance = parseFloat(d.balance) || 0;
      d.active = d.active === 'true';
      if (!d.employeeId) { alert('Employee required.'); return false; }
      S.upsert('loans', d); renderView();
    });
  }

  /* ===================== RUN PAYROLL ===================== */
  function viewPayroll(v) {
    var periods = S.list('periods');
    var pid = state.selectedPeriod || (periods[0] && periods[0].id);
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
        PH.payroll.finalizePeriod(period); renderView();
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
    p = p || { frequency: 'semi-monthly', applyContributions: true, status: 'draft' };
    var body = '<div class="grid2">' +
      field('Period Name', '<input name="name" value="' + esc(p.name || '') + '" placeholder="e.g. July 2026 (1-15)">') +
      field('Frequency', select('frequency', ['semi-monthly', 'monthly', 'weekly', 'daily'], p.frequency)) +
      field('Start Date', '<input name="startDate" type="date" value="' + esc(p.startDate || '') + '">') +
      field('End Date', '<input name="endDate" type="date" value="' + esc(p.endDate || '') + '">') +
      field('Pay Date', '<input name="payDate" type="date" value="' + esc(p.payDate || '') + '">') +
      field('Deduct Contributions?', select('applyContributions', [['true','Yes (deduct SSS/PhilHealth/Pag-IBIG)'],['false','No (skip this period)']], String(p.applyContributions !== false))) +
      '</div><p class="hint">Tip: for semi-monthly, deduct full monthly contributions on one cut-off (e.g. end of month) and set "No" on the other.</p>';
    modal((p.id ? 'Edit' : 'New') + ' Payroll Period', body, function (form) {
      var d = collect(form); d.id = p.id; d.status = p.status || 'draft';
      d.applyContributions = d.applyContributions === 'true';
      if (!d.name) { alert('Period name required.'); return false; }
      var saved = S.upsert('periods', d);
      state.selectedPeriod = saved.id; renderView();
    });
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
  function payslipHTML(r, period) {
    var comp = S.db.meta.company;
    var earn = r.earnings.map(function (e) {
      return '<tr><td>' + esc(e.name) + (e.taxable ? '' : ' <span class="tag">non-tax</span>') +
        '</td><td class="num">' + money(e.amount) + '</td></tr>';
    }).join('');
    var ded = r.deductions.map(function (d) {
      return '<tr><td>' + esc(d.name) + '</td><td class="num">' + money(d.amount) + '</td></tr>';
    }).join('');
    var dtr = r.dtr;
    return '<div class="payslip">' +
      '<div class="ps-head"><div><div class="ps-co">' + esc(comp.name) + '</div>' +
      '<div class="ps-co-sub">' + esc(comp.address || '') + (comp.tin ? ' • TIN ' + esc(comp.tin) : '') + '</div></div>' +
      '<div class="ps-title">PAYSLIP</div></div>' +
      '<div class="ps-meta"><div><b>' + esc(r.employeeName) + '</b> (' + esc(r.employeeCode) + ')</div>' +
      '<div>Period: ' + esc(period.name) + '</div>' +
      '<div>Pay Date: ' + esc(period.payDate || '—') + '</div></div>' +
      '<div class="ps-cols"><div class="ps-col"><h4>Earnings</h4><table class="ps-tbl"><tbody>' + earn +
      '</tbody><tfoot><tr><td><b>Gross Pay</b></td><td class="num"><b>' + money(r.grossPay) + '</b></td></tr></tfoot></table></div>' +
      '<div class="ps-col"><h4>Deductions</h4><table class="ps-tbl"><tbody>' + (ded || '<tr><td class="muted">None</td><td></td></tr>') +
      '</tbody><tfoot><tr><td><b>Total Deductions</b></td><td class="num"><b>' + money(r.totalDeductions) + '</b></td></tr></tfoot></table></div></div>' +
      '<div class="ps-net">NET PAY <span>' + money(r.netPay) + '</span></div>' +
      '<div class="ps-foot"><table class="ps-mini"><tr><td>Days Present</td><td>' + dtr.daysPresent +
      '</td><td>OT Hours</td><td>' + hrs(dtr.otMinutes) + '</td><td>Night Diff</td><td>' + hrs(dtr.nightDiffMinutes) + '</td></tr>' +
      '<tr><td>Absences</td><td>' + dtr.daysAbsent + '</td><td>Late</td><td>' + dtr.lateMinutes +
      'm</td><td>Undertime</td><td>' + dtr.undertimeMinutes + 'm</td></tr>' +
      '<tr><td>SSS MSC</td><td>' + money(r.contributions.sss.msc) + '</td><td>Taxable</td><td>' + money(r.taxableBase) +
      '</td><td>Contrib. Basis</td><td>' + money(r.contributions.basis) + '</td></tr></table></div>' +
      '<div class="ps-sign"><div>_____________________<br>Employee Signature</div>' +
      '<div>_____________________<br>Authorized Signatory</div></div></div>';
  }

  function showPayslip(r, period) {
    modal('Payslip', payslipHTML(r, period),
      null, 'wide',
      '<button class="btn" id="printSlip">Print / Save PDF</button>');
    qs('#printSlip').addEventListener('click', function () { printPayslips([r], period); });
  }

  function printPayslips(list, period) {
    var w = window.open('', '_blank');
    var css = document.getElementById('appStyles') ? '' : '';
    w.document.write('<html><head><title>Payslips — ' + esc(period.name) + '</title>' +
      '<style>' + PAYSLIP_PRINT_CSS + '</style></head><body>' +
      list.map(function (r) { return payslipHTML(r, period); }).join('<div class="page-break"></div>') +
      '</body></html>');
    w.document.close();
    w.focus();
    setTimeout(function () { w.print(); }, 300);
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

  /* ===================== SETTINGS ===================== */
  function viewSettings(v) {
    var c = PH.statutory.config;
    var comp = S.db.meta.company;
    function num(path, val, step) {
      return '<input data-cfg="' + path + '" type="number" step="' + (step || 'any') + '" value="' + val + '">';
    }
    v.innerHTML =
      card('Company Information',
        '<div class="grid2">' +
        field('Company Name', '<input data-co="name" value="' + esc(comp.name) + '">') +
        field('Address', '<input data-co="address" value="' + esc(comp.address || '') + '">') +
        field('TIN', '<input data-co="tin" value="' + esc(comp.tin || '') + '">') +
        '</div>') +
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
        '<button class="btn" id="saveCfg">Save Settings</button>' +
        '<button class="btn-sm btn-danger" id="resetCfg">Reset to 2025 Defaults</button>') +
      '<p class="disclaimer">⚠️ These defaults reflect the schedules understood to be in force for 2025. ' +
      'This tool is provided as-is and is not a substitute for professional advice. Verify all values against the ' +
      'current official SSS, PhilHealth, HDMF and BIR circulars.</p>';

    v.querySelector('#saveCfg').addEventListener('click', function () {
      v.querySelectorAll('[data-cfg]').forEach(function (inp) {
        var path = inp.dataset.cfg.split('.');
        var obj = PH.statutory.config;
        for (var i = 0; i < path.length - 1; i++) obj = obj[path[i]];
        obj[path[path.length - 1]] = parseFloat(inp.value) || 0;
      });
      v.querySelectorAll('[data-co]').forEach(function (inp) { comp[inp.dataset.co] = inp.value; });
      S.save();
      toast('Settings saved.');
    });
    v.querySelector('#resetCfg').addEventListener('click', function () {
      if (confirm('Reset statutory tables to 2025 defaults?')) { PH.statutory.resetConfig(); S.save(); renderView(); }
    });
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
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  var SAMPLE_DTR = 'EmployeeCode,Date,TimeIn,TimeOut,Break,DayType,RestDay,ScheduledIn,Absent,PaidLeave\n' +
    'EMP-001,2026-07-01,08:00,17:00,60,regular,,08:00,,\n' +
    'EMP-001,2026-07-02,08:15,19:00,60,regular,,08:00,,\n' +
    'EMP-001,2026-07-03,08:00,17:00,60,regular,,08:00,,\n' +
    'EMP-002,2026-07-01,09:00,18:00,60,regular,,09:00,,\n' +
    'EMP-002,2026-07-02,,,,regular,,,1,\n';

  var PAYSLIP_PRINT_CSS = '';

  PH.ui = {
    render: render, navigate: navigate,
    _setPrintCss: function (css) { PAYSLIP_PRINT_CSS = css; },
    money: money
  };
})(window.PH = window.PH || {});
