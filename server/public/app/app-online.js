/* ==========================================================================
 * app-online.js — Admin bootstrap for the online edition
 * --------------------------------------------------------------------------
 * Confirms the signed-in user is an admin role, loads the company data from
 * the server, renders the reused payroll UI, and adds a top bar (role,
 * save status, logout). Finance is view-only (server rejects writes).
 * ========================================================================== */
(function (PH) {
  'use strict';
  var ADMIN = ['superadmin', 'admin_payroll', 'finance', 'auditor'];

  function api(url, opts) {
    return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }

  var canManage = false;

  function topbar(user) {
    canManage = user.role === 'superadmin' || user.role === 'admin_payroll';
    var roleLabel = { superadmin: 'Super Admin', admin_payroll: 'Admin — Payroll', finance: 'Finance', auditor: 'Auditor (3rd-party)' }[user.role] || user.role;
    var bar = document.createElement('div');
    bar.className = 'topbar';
    bar.innerHTML =
      '<span class="tb-role">' + roleLabel + '</span>' +
      (user.role === 'finance' ? '<span class="tb-ro">view-only</span>' : '') +
      '<span id="tb-status" class="tb-status"></span>' +
      (canManage ? '<button id="tb-access" class="tb-btn">Users &amp; Access</button>' : '') +
      '<span class="tb-user">' + (user.fullName || user.email) + '</span>' +
      '<button id="tb-logout" class="tb-btn">Log out</button>';
    document.body.appendChild(bar);
    document.getElementById('tb-logout').addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; });
    });
    if (canManage) document.getElementById('tb-access').addEventListener('click', openAccessPanel);
    PH.storage.onStatus = function (s) {
      var el = document.getElementById('tb-status');
      if (!el) return;
      el.textContent = { saving: 'Saving…', saved: 'All changes saved', error: 'Save error — check connection', readonly: 'View-only' }[s] || '';
      el.className = 'tb-status ' + s;
    };
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  var ROLE_OPTS = [['employee', 'Employee'], ['supervisor', 'Supervisor'], ['auditor', 'Auditor (3rd-party)'], ['finance', 'Finance'], ['admin_payroll', 'Admin — Payroll'], ['superadmin', 'Super Admin']];
  // Configured locations/branches (from the loaded company document).
  function companyLocations() { return (((window.__COMPANY__ || {}).data || {}).meta || {}).locations || []; }
  function locOptions(sel) {
    return [['', 'All locations']].concat(companyLocations().map(function (l) { return [l.id, l.name]; }))
      .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === (sel || '') ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }

  function openAccessPanel() {
    var ov = document.createElement('div');
    ov.className = 'acc-overlay';
    var isSuper = (window.__COMPANY__ && window.__COMPANY__.role === 'superadmin');
    ov.innerHTML = '<div class="acc-modal"><div class="acc-head"><b>Users &amp; Access</b><button class="acc-x">✕</button></div>' +
      '<div class="acc-tabs"><a class="active" data-at="approvals">Approvals</a><a data-at="users">All Users</a><a data-at="leave">Leave Requests</a><a data-at="overtime">Overtime</a><a data-at="loans">Loan Requests</a><a data-at="pcr">201 Changes</a><a data-at="documents">Documents</a>' +
      (isSuper ? '<a data-at="history">History</a>' : '') + '</div>' +
      '<div class="acc-body" id="acc-body">Loading…</div></div>';
    document.body.appendChild(ov);
    ov.querySelector('.acc-x').onclick = function () { ov.remove(); };
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    ov.querySelectorAll('.acc-tabs a').forEach(function (a) {
      a.onclick = function () { ov.querySelectorAll('.acc-tabs a').forEach(function (x) { x.classList.remove('active'); }); a.classList.add('active'); renderTab(a.dataset.at); };
    });
    var body = ov.querySelector('#acc-body');
    var leaveMonth = new Date(); leaveMonth = new Date(leaveMonth.getFullYear(), leaveMonth.getMonth(), 1);
    var leaveIncludePending = true;

    function renderTab(tab) {
      body.innerHTML = 'Loading…';
      if (tab === 'leave') return api('/api/admin/leave-requests').then(function (r) { renderLeave(r.body.requests || []); });
      if (tab === 'overtime') return api('/api/admin/overtime-requests').then(function (r) { renderOvertime(r.body.requests || []); });
      if (tab === 'loans') return api('/api/admin/loan-requests').then(function (r) { renderLoans(r.body.requests || []); });
      if (tab === 'pcr') return api('/api/admin/profile-requests').then(function (r) { renderPcr(r.body.requests || []); });
      if (tab === 'documents') return renderDocuments();
      if (tab === 'history') return api('/api/admin/audit-log').then(function (r) { renderHistory((r.body || {}).entries || []); });
      return api('/api/admin/users').then(function (r) { (tab === 'approvals' ? renderApprovals : renderUsers)(r.body.users || []); });
    }

    function renderApprovals(users) {
      var pending = users.filter(function (u) { return u.status === 'pending'; });
      if (!pending.length) { body.innerHTML = '<p class="acc-muted">No accounts awaiting approval.</p>'; return; }
      body.innerHTML = pending.map(function (u) {
        var p = u.profile || {};
        return '<div class="acc-card" data-uid="' + u.id + '"><div><b>' + esc(u.fullName || (p.firstName + ' ' + p.lastName)) + '</b> — ' + esc(u.email) + '</div>' +
          '<div class="acc-muted">' + esc([p.position, p.contactNumber, p.sssNo && ('SSS ' + p.sssNo)].filter(Boolean).join(' • ')) + '</div>' +
          '<div class="acc-row"><select class="ap-role">' + ROLE_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === 'employee' ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
          (companyLocations().length ? '<select class="ap-loc" title="Location">' + locOptions('') + '</select>' : '') +
          '<label class="acc-chk"><input type="checkbox" class="ap-emp" checked> Create 201 record</label>' +
          '<button class="acc-btn ap-go">Approve</button></div></div>';
      }).join('');
      body.querySelectorAll('.acc-card').forEach(function (cardEl) {
        cardEl.querySelector('.ap-go').onclick = function () {
          var uid = cardEl.dataset.uid;
          var locSel = cardEl.querySelector('.ap-loc');
          api('/api/admin/users/' + uid + '/approve', { method: 'POST', body: JSON.stringify({
            role: cardEl.querySelector('.ap-role').value, createEmployee: cardEl.querySelector('.ap-emp').checked,
            locationId: locSel ? locSel.value : '' }) })
            .then(function () { renderTab('approvals'); });
        };
      });
    }

    function renderUsers(users) {
      var hasLoc = companyLocations().length > 0;
      body.innerHTML = '<table class="acc-tbl"><thead><tr><th>Name / Email</th><th>Role</th>' +
        (hasLoc ? '<th>Location</th>' : '') + '<th>Status</th><th></th></tr></thead><tbody>' +
        users.map(function (u) {
          return '<tr data-uid="' + u.id + '"><td>' + esc(u.fullName || '') + '<div class="acc-muted">' + esc(u.email) + (u.employeeCode ? ' • ' + esc(u.employeeCode) : '') + '</div></td>' +
            '<td><select class="u-role">' + ROLE_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === u.role ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>' +
            (hasLoc ? '<td><select class="u-loc"' + (u.role === 'superadmin' ? ' disabled title="Super Admins see all locations"' : '') + '>' + locOptions(u.locationId || '') + '</select></td>' : '') +
            '<td><span class="acc-badge ' + u.status + '">' + u.status + '</span></td>' +
            '<td class="acc-actions"><button class="acc-btn ghost u-toggle">' + (u.status === 'disabled' ? 'Enable' : 'Disable') + '</button>' +
            '<button class="acc-btn ghost u-pw">Reset password</button></td></tr>';
        }).join('') + '</tbody></table>';
      body.querySelectorAll('tr[data-uid]').forEach(function (tr) {
        var uid = tr.dataset.uid;
        tr.querySelector('.u-role').onchange = function (e) {
          api('/api/admin/users/' + uid + '/role', { method: 'POST', body: JSON.stringify({ role: e.target.value }) })
            .then(function (r) { if (!r.ok) { alert(r.body.error || 'Failed'); } renderTab('users'); });
        };
        var locSel = tr.querySelector('.u-loc');
        if (locSel) locSel.onchange = function (e) {
          api('/api/admin/users/' + uid + '/location', { method: 'POST', body: JSON.stringify({ locationId: e.target.value }) })
            .then(function (r) { if (!r.ok) { alert(r.body.error || 'Failed'); renderTab('users'); } });
        };
        tr.querySelector('.u-toggle').onclick = function () {
          var disable = tr.querySelector('.u-toggle').textContent === 'Disable';
          api('/api/admin/users/' + uid + '/status', { method: 'POST', body: JSON.stringify({ status: disable ? 'disabled' : 'active' }) }).then(function () { renderTab('users'); });
        };
        tr.querySelector('.u-pw').onclick = function () {
          var pw = prompt('New password (leave blank to auto-generate one):', '');
          if (pw === null) return;
          api('/api/admin/users/' + uid + '/password', { method: 'POST', body: JSON.stringify({ password: pw }) })
            .then(function (r) {
              if (!r.ok) { alert(r.body.error || 'Failed'); return; }
              alert(r.body.password ? ('Temporary password: ' + r.body.password + '\n\nShare it with the user; they can change it after signing in.') : 'Password updated.');
            });
        };
      });
    }

    // Month calendar of applied leaves (approved + optionally pending).
    var LV_COLORS = { SL: '#2563eb', VL: '#0a7d33', EL: '#d97706', UAL: '#6b7280', '': '#334155' };
    var LV_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    function lvPad(n) { return (n < 10 ? '0' : '') + n; }
    function drawLeaveCalendar(reqs) {
      var el = document.getElementById('lv-cal'); if (!el) return;
      var y = leaveMonth.getFullYear(), m = leaveMonth.getMonth();
      var first = new Date(y, m, 1), daysIn = new Date(y, m + 1, 0).getDate();
      var cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (d) {
        return '<div style="text-align:center;font-size:11px;color:#94a3b8;font-weight:700;padding:4px 0">' + d + '</div>';
      });
      for (var i = 0; i < first.getDay(); i++) cells.push('<div></div>');
      for (var day = 1; day <= daysIn; day++) {
        var iso = y + '-' + lvPad(m + 1) + '-' + lvPad(day);
        var on = reqs.filter(function (r) {
          if (r.status === 'rejected') return false;
          if (!leaveIncludePending && r.status !== 'approved') return false;
          return r.date_from <= iso && iso <= r.date_to;
        });
        var chips = on.map(function (r) {
          var c = LV_COLORS[r.leave_type] || LV_COLORS[''];
          var pending = r.status !== 'approved';
          return '<div title="' + esc((r.full_name || r.email) + ' — ' + r.leave_type + ' (' + r.status + ')') + '" ' +
            'style="font-size:10px;line-height:1.3;margin-top:2px;padding:1px 4px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
            'color:#fff;background:' + c + ';' + (pending ? 'opacity:.55;border:1px dashed #fff' : '') + '">' +
            esc((r.full_name || r.email || '').split(' ')[0]) + ' · ' + esc(r.leave_type) + '</div>';
        }).join('');
        cells.push('<div style="min-height:64px;border:1px solid #e2e8f0;border-radius:6px;padding:3px;background:' + (on.length ? '#f8fafc' : '#fff') + '">' +
          '<div style="font-size:11px;color:#64748b;font-weight:600">' + day + '</div>' + chips + '</div>');
      }
      el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
          '<div><button class="acc-btn ghost" id="lv-prev">‹</button> <b style="margin:0 8px">' + LV_MONTHS[m] + ' ' + y + '</b> <button class="acc-btn ghost" id="lv-next">›</button></div>' +
          '<label class="acc-chk"><input type="checkbox" id="lv-pend"' + (leaveIncludePending ? ' checked' : '') + '> Include pending</label>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">' + cells.join('') + '</div>' +
        '<div class="acc-muted" style="margin-top:6px;font-size:11px">' +
          Object.keys(LV_COLORS).filter(function (k) { return k; }).map(function (k) {
            return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + LV_COLORS[k] + ';margin:0 3px 0 10px;vertical-align:middle"></span>' + k;
          }).join('') + ' &nbsp;·&nbsp; dashed = pending</div>';
      document.getElementById('lv-prev').onclick = function () { leaveMonth = new Date(y, m - 1, 1); drawLeaveCalendar(reqs); };
      document.getElementById('lv-next').onclick = function () { leaveMonth = new Date(y, m + 1, 1); drawLeaveCalendar(reqs); };
      document.getElementById('lv-pend').onchange = function (e) { leaveIncludePending = e.target.checked; drawLeaveCalendar(reqs); };
    }

    function renderLeave(reqs) {
      var calWrap = '<div id="lv-cal" style="margin-bottom:16px"></div>';
      if (!reqs.length) { body.innerHTML = calWrap + '<p class="acc-muted">No leave requests.</p>'; drawLeaveCalendar(reqs); return; }
      body.innerHTML = calWrap + '<h4 style="margin:6px 0">All Leave Requests</h4>' +
        '<table class="acc-tbl"><thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>' +
        reqs.map(function (x) {
          return '<tr data-lid="' + x.id + '"><td>' + esc(x.full_name || x.email) + '</td><td>' + esc(x.date_from) + ' → ' + esc(x.date_to) +
            (x.reason ? '<div class="acc-muted">' + esc(x.reason) + '</div>' : '') + '</td><td>' + esc(x.leave_type) + '</td>' +
            '<td><span class="acc-badge ' + x.status + '">' + x.status + '</span></td>' +
            '<td class="acc-actions">' + (x.status === 'pending' ? '<button class="acc-btn l-ok">Approve</button><button class="acc-btn ghost l-no">Reject</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      body.querySelectorAll('tr[data-lid]').forEach(function (tr) {
        var lid = tr.dataset.lid;
        var ok = tr.querySelector('.l-ok'), no = tr.querySelector('.l-no');
        if (ok) ok.onclick = function () { decide(lid, 'approved'); };
        if (no) no.onclick = function () { decide(lid, 'rejected'); };
      });
      function decide(lid, d) { api('/api/admin/leave-requests/' + lid, { method: 'POST', body: JSON.stringify({ decision: d }) }).then(function () { renderTab('leave'); }); }
      drawLeaveCalendar(reqs);
    }

    function renderOvertime(reqs) {
      if (!reqs.length) { body.innerHTML = '<p class="acc-muted">No overtime requests.</p>'; return; }
      body.innerHTML = '<p class="acc-muted">OT hours are auto-computed from each employee\'s schedule and the company overtime policy (late employees forfeit the first hour). Approving is what makes the overtime payable in payroll.</p>' +
        '<table class="acc-tbl"><thead><tr><th>Employee</th><th>Date</th><th>Type</th><th>Reason</th><th class="num">OT Hrs</th><th>Status</th><th></th></tr></thead><tbody>' +
        reqs.map(function (x) {
          var hrs = (x.ot_minutes / 60).toFixed(2);
          var kind = x.ot_kind === 'before' ? 'Pre-shift' : 'After shift';
          var lateNote = x.late_minutes > 0 ? '<div class="acc-muted">late ' + x.late_minutes + 'm that day</div>' : '';
          return '<tr data-oid="' + x.id + '"><td>' + esc(x.full_name || x.email) + '</td>' +
            '<td>' + esc(x.ot_date) + '<div class="acc-muted">' + (x.ot_kind === 'before' ? 'in ' : 'ends ') + esc(x.end_time) + '</div></td>' +
            '<td>' + kind + '</td>' +
            '<td>' + esc(x.reason_label || x.reason) + '<div class="acc-muted">' + esc(x.specific_reason || '') + '</div></td>' +
            '<td class="num">' + hrs + lateNote + '</td>' +
            '<td><span class="acc-badge ' + x.status + '">' + x.status + '</span></td>' +
            '<td class="acc-actions">' + (x.status === 'pending' ? '<button class="acc-btn o-ok">Approve</button><button class="acc-btn ghost o-no">Reject</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      body.querySelectorAll('tr[data-oid]').forEach(function (tr) {
        var oid = tr.dataset.oid;
        var ok = tr.querySelector('.o-ok'), no = tr.querySelector('.o-no');
        function decide(d) {
          api('/api/admin/overtime-requests/' + oid, { method: 'POST', body: JSON.stringify({ decision: d }) }).then(function (r) {
            if (r.body && r.body.companyChanged) refreshCompany(); // payroll gating data changed
            renderTab('overtime');
          });
        }
        if (ok) ok.onclick = function () { decide('approved'); };
        if (no) no.onclick = function () { decide('rejected'); };
      });
    }

    function renderHistory(entries) {
      var head = '<p class="acc-muted">Every change made in the system — who, what and when. Filter below. (Viewing is not logged.)</p>' +
        '<input id="hist-q" placeholder="Filter by person, action, entity or detail…" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:7px;margin-bottom:8px">';
      if (!entries.length) { body.innerHTML = head + '<p class="acc-muted">No changes recorded yet.</p>'; bindHistFilter(); return; }
      body.innerHTML = head + '<table class="acc-tbl"><thead><tr><th>When (UTC)</th><th>Who</th><th>Role</th><th>Action</th><th>What</th></tr></thead><tbody>' +
        entries.map(function (e) {
          return '<tr><td style="white-space:nowrap">' + esc(e.at) + '</td><td>' + esc(e.user_email || '—') + '</td>' +
            '<td>' + esc(e.role || '—') + '</td><td><span class="acc-badge">' + esc(e.action) + '</span> ' + esc(e.entity) + '</td>' +
            '<td>' + esc(e.detail || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      bindHistFilter();
    }
    function bindHistFilter() {
      var q = document.getElementById('hist-q'); if (!q) return;
      var t = null;
      q.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          api('/api/admin/audit-log?q=' + encodeURIComponent(q.value)).then(function (r) {
            var val = q.value; renderHistory((r.body || {}).entries || []);
            var q2 = document.getElementById('hist-q'); if (q2) { q2.value = val; q2.focus(); }
          });
        }, 300);
      });
    }

    function peso(n) { return '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function renderLoans(reqs) {
      if (!reqs.length) { body.innerHTML = '<p class="acc-muted">No loan applications.</p>'; return; }
      body.innerHTML = '<p class="acc-muted">Approving a loan creates an auto-deducted payroll loan on the employee. Set the amount taken each pay period.</p>' +
        '<table class="acc-tbl"><thead><tr><th>Employee</th><th>Type</th><th>Amount</th><th>Per cutoff</th><th>Status</th><th></th></tr></thead><tbody>' +
        reqs.map(function (x) {
          var suggested = Math.round((x.amount / Math.max(1, x.installments)) * 100) / 100;
          return '<tr data-lid="' + x.id + '"><td>' + esc(x.full_name || x.email) + '</td>' +
            '<td>' + esc(x.loan_type_label || x.loan_type) + (x.reason ? '<div class="acc-muted">' + esc(x.reason) + '</div>' : '') + '</td>' +
            '<td>' + peso(x.amount) + '<div class="acc-muted">' + esc(x.installments) + ' cutoff(s) requested</div></td>' +
            '<td>' + (x.status === 'pending' ? '<input class="ln-amt" type="number" step="0.01" value="' + suggested + '" style="width:100px">' : (x.loan_id ? 'loan created' : '—')) + '</td>' +
            '<td><span class="acc-badge ' + x.status + '">' + x.status + '</span></td>' +
            '<td class="acc-actions">' + (x.status === 'pending' ? '<button class="acc-btn ln-ok">Approve</button><button class="acc-btn ghost ln-no">Reject</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      body.querySelectorAll('tr[data-lid]').forEach(function (tr) {
        var lid = tr.dataset.lid;
        var ok = tr.querySelector('.ln-ok'), no = tr.querySelector('.ln-no');
        if (ok) ok.onclick = function () {
          var amtEl = tr.querySelector('.ln-amt');
          api('/api/admin/loan-requests/' + lid, { method: 'POST', body: JSON.stringify({ decision: 'approved', monthlyAmortization: amtEl ? amtEl.value : '' }) })
            .then(function (r) {
              if (!r.ok) { alert(r.body.error || 'Could not approve.'); return; }
              refreshCompany();          // company data changed server-side (new payroll loan)
              renderTab('loans');
            });
        };
        if (no) no.onclick = function () {
          api('/api/admin/loan-requests/' + lid, { method: 'POST', body: JSON.stringify({ decision: 'rejected' }) }).then(function () { renderTab('loans'); });
        };
      });
    }

    function renderPcr(reqs) {
      if (!reqs.length) { body.innerHTML = '<p class="acc-muted">No bank / government-ID change requests.</p>'; return; }
      body.innerHTML = '<p class="acc-muted">Employees’ requested changes to bank details and government IDs. Approving applies them to the 201 record.</p>' +
        '<table class="acc-tbl"><thead><tr><th>Employee</th><th>Requested changes</th><th>Status</th><th></th></tr></thead><tbody>' +
        reqs.map(function (x) {
          var changes = (x.changes || []).map(function (c) {
            return '<div><b>' + esc(c.label) + ':</b> <span class="acc-muted">' + esc(c.from || '—') + '</span> → ' + esc(c.to || '—') + '</div>';
          }).join('');
          return '<tr data-pid="' + x.id + '"><td>' + esc(x.full_name || x.email) + (x.employee_code ? '<div class="acc-muted">' + esc(x.employee_code) + '</div>' : '') + '</td>' +
            '<td>' + changes + '</td>' +
            '<td><span class="acc-badge ' + x.status + '">' + x.status + '</span></td>' +
            '<td class="acc-actions">' + (x.status === 'pending' ? '<button class="acc-btn pcr-ok">Approve</button><button class="acc-btn ghost pcr-no">Reject</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      body.querySelectorAll('tr[data-pid]').forEach(function (tr) {
        var pid = tr.dataset.pid;
        function decide(d) {
          api('/api/admin/profile-requests/' + pid, { method: 'POST', body: JSON.stringify({ decision: d }) }).then(function (r) {
            if (!r.ok) { alert(r.body.error || 'Failed'); return; }
            if (d === 'approved') refreshCompany(); // 201 record changed server-side
            renderTab('pcr');
          });
        }
        var ok = tr.querySelector('.pcr-ok'), no = tr.querySelector('.pcr-no');
        if (ok) ok.onclick = function () { decide('approved'); };
        if (no) no.onclick = function () { decide('rejected'); };
      });
    }

    // ---- Documents: issue NTE / Notice of Decision / memo, and view employee docs ----
    var ADMIN_ISSUE_CATS = [['nte', 'Notice to Explain (NTE)'], ['nod', 'Notice of Decision'], ['memo', 'Memo'], ['other', 'Other Document']];
    var docFilterCode = '';
    function empList() {
      return ((((window.__COMPANY__ || {}).data || {}).employees) || []).slice().sort(function (a, b) {
        return String(a.lastName || '').localeCompare(String(b.lastName || ''));
      });
    }
    function empName(e) { return ((e.lastName || '') + ', ' + (e.firstName || '')).replace(/^, |, $/g, '') || (e.code || '?'); }
    function readFileDataUrl(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error('read')); };
        fr.readAsDataURL(file);
      });
    }
    function renderDocuments() {
      var emps = empList();
      var empOpts = emps.map(function (e) { return '<option value="' + esc(e.code) + '">' + esc(empName(e)) + (e.code ? ' (' + esc(e.code) + ')' : '') + '</option>'; }).join('');
      body.innerHTML =
        '<div class="acc-card"><b>Issue a document to an employee</b>' +
        '<div class="acc-muted" style="margin:4px 0 8px">Send an NTE, Notice of Decision or memo. The employee is notified and can view it in their portal Documents tab.</div>' +
        '<div class="acc-row"><select id="doc-emp"><option value="">— Choose employee —</option>' + empOpts + '</select>' +
        '<select id="doc-cat">' + ADMIN_ISSUE_CATS.map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select></div>' +
        '<div class="acc-row"><input id="doc-title" placeholder="Title (e.g. NTE — Tardiness Aug 2026)" style="flex:1"></div>' +
        '<div class="acc-row"><input id="doc-note" placeholder="Note (optional)" style="flex:1"></div>' +
        '<div class="acc-row"><input type="file" id="doc-file" accept="image/*,application/pdf">' +
        '<button class="acc-btn" id="doc-issue">Issue Document</button><span id="doc-msg" class="acc-muted"></span></div></div>' +
        '<div class="acc-row" style="margin:10px 0"><b style="align-self:center">View documents:</b>' +
        '<select id="doc-filter"><option value="">All (recent)</option>' + empOpts + '</select></div>' +
        '<div id="doc-list">Loading…</div>';
      document.getElementById('doc-filter').value = docFilterCode;
      document.getElementById('doc-filter').onchange = function () { docFilterCode = this.value; loadAdminDocs(); };
      document.getElementById('doc-issue').onclick = issueDocument;
      loadAdminDocs();
    }
    function issueDocument() {
      var msg = document.getElementById('doc-msg');
      var code = document.getElementById('doc-emp').value;
      var cat = document.getElementById('doc-cat').value;
      var title = document.getElementById('doc-title').value;
      var note = document.getElementById('doc-note').value;
      var file = document.getElementById('doc-file').files[0];
      if (!code) { msg.textContent = ' Choose an employee.'; return; }
      if (!file) { msg.textContent = ' Attach a file.'; return; }
      if (file.size > 5 * 1024 * 1024) { msg.textContent = ' File is too large (max ~5 MB).'; return; }
      var btn = document.getElementById('doc-issue'); btn.disabled = true; msg.textContent = ' Uploading…';
      readFileDataUrl(file).then(function (dataUrl) {
        return api('/api/admin/documents', { method: 'POST', body: JSON.stringify({ employeeCode: code, category: cat, title: title, note: note, dataUrl: dataUrl }) });
      }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { msg.textContent = ' ' + (r.body.error || 'Failed.'); return; }
        msg.textContent = ' ✓ Issued';
        document.getElementById('doc-title').value = ''; document.getElementById('doc-note').value = ''; document.getElementById('doc-file').value = '';
        docFilterCode = code; loadAdminDocs();
        var f = document.getElementById('doc-filter'); if (f) f.value = code;
      }).catch(function () { btn.disabled = false; msg.textContent = ' Could not read that file.'; });
    }
    function loadAdminDocs() {
      var el = document.getElementById('doc-list'); if (!el) return;
      el.innerHTML = 'Loading…';
      api('/api/admin/documents' + (docFilterCode ? '?employeeCode=' + encodeURIComponent(docFilterCode) : '')).then(function (r) {
        var list = (r.body && r.body.documents) || [];
        if (!list.length) { el.innerHTML = '<p class="acc-muted">No documents.</p>'; return; }
        el.innerHTML = '<table class="acc-tbl"><thead><tr><th>Employee</th><th>Type</th><th>Title</th><th>Source</th><th>Date</th><th></th></tr></thead><tbody>' +
          list.map(function (d) {
            var src = d.direction === 'admin' ? 'HR / Admin' : 'Employee';
            return '<tr data-did="' + d.id + '"><td>' + esc(d.full_name || d.employee_code || '—') +
              (d.employee_code ? '<div class="acc-muted">' + esc(d.employee_code) + '</div>' : '') + '</td>' +
              '<td>' + esc(d.categoryLabel) + '</td><td>' + esc(d.title || '—') +
              (d.leave_request_id ? ' <span class="acc-badge approved">leave</span>' : '') + '</td>' +
              '<td>' + src + '</td><td>' + esc((d.created_at || '').slice(0, 10)) + '</td>' +
              '<td class="acc-actions"><a class="acc-btn ghost" href="/api/document/' + d.id + '" target="_blank">View</a>' +
              (isSuper ? '<button class="acc-btn ghost doc-del">Delete</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>';
        el.querySelectorAll('tr[data-did]').forEach(function (tr) {
          var del = tr.querySelector('.doc-del');
          if (del) del.onclick = function () {
            if (!confirm('Delete this document permanently?')) return;
            api('/api/admin/documents/' + tr.dataset.did, { method: 'DELETE' }).then(loadAdminDocs);
          };
        });
      });
    }

    renderTab('approvals');
  }

  // Reload company data after an admin action changed it server-side (e.g. loan
  // approval created a payroll loan), so the in-app view and save version stay current.
  function refreshCompany() {
    return api('/api/company').then(function (c) {
      if (!c.ok) return;
      window.__COMPANY__ = { data: c.body.data, version: c.body.version, role: c.body.role };
      PH.storage.load();
      PH.ui.render();
    });
  }

  // Called by the shared UI after a payroll is finalized (online only).
  function onFinalize(period) {
    if (!canManage) return;
    PH.storage.saveNow().then(function () {
      if (!confirm('Payroll finalized. Email payslip notifications to employees now?')) return;
      return api('/api/admin/notify-payslips', { method: 'POST', body: JSON.stringify({ periodId: period.id }) })
        .then(function (r) {
          if (!r.ok) { alert(r.body.error || 'Could not send notifications.'); return; }
          if (!r.body.emailConfigured) alert('Email is not configured on the server, so no messages were sent. Ask your admin to set up SMTP.');
          else alert('Payslip notifications sent to ' + r.body.sent + ' employee(s).' + (r.body.skipped ? ' Skipped ' + r.body.skipped + ' (no email/account).' : ''));
        });
    }).catch(function (e) { alert('Could not save before notifying: ' + e.message); });
  }

  function boot() {
    window.__PH_NO_AUTOINIT__ = true;
    var overlay = document.createElement('div');
    overlay.className = 'boot-overlay';
    overlay.innerHTML = '<div class="boot-card">Loading payroll…</div>';
    document.body.appendChild(overlay);

    api('/api/auth/me').then(function (me) {
      var user = me.body.user;
      if (!user) { location.href = '/'; return; }
      if (user.mustChangePassword) { location.href = '/'; return; } // set a new password first
      if (ADMIN.indexOf(user.role) < 0) { location.href = '/portal'; return; }
      return api('/api/company').then(function (c) {
        if (!c.ok) { location.href = '/'; return; }
        window.__COMPANY__ = { data: c.body.data, version: c.body.version, role: c.body.role };
        PH.role = c.body.role; // lets the shared UI restrict nav (e.g. auditor = reports only)
        PH.storage.load();
        PH.ui._setPrintCss(PH.PRINT_CSS || '');
        PH.onFinalize = onFinalize;
        PH.ui.render();
        topbar(user);
        overlay.remove();
      });
    }).catch(function (e) {
      overlay.innerHTML = '<div class="boot-card">Could not load. <a href="/">Back to sign in</a></div>';
      console.error(e);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.PH = window.PH || {});
