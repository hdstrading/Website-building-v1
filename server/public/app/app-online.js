/* ==========================================================================
 * app-online.js — Admin bootstrap for the online edition
 * --------------------------------------------------------------------------
 * Confirms the signed-in user is an admin role, loads the company data from
 * the server, renders the reused payroll UI, and adds a top bar (role,
 * save status, logout). Finance is view-only (server rejects writes).
 * ========================================================================== */
(function (PH) {
  'use strict';
  var ADMIN = ['superadmin', 'admin_payroll', 'finance'];

  function api(url, opts) {
    return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  }

  var canManage = false;

  function topbar(user) {
    canManage = user.role === 'superadmin' || user.role === 'admin_payroll';
    var roleLabel = { superadmin: 'Super Admin', admin_payroll: 'Admin — Payroll', finance: 'Finance' }[user.role] || user.role;
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
  var ROLE_OPTS = [['employee', 'Employee'], ['finance', 'Finance'], ['admin_payroll', 'Admin — Payroll'], ['superadmin', 'Super Admin']];

  function openAccessPanel() {
    var ov = document.createElement('div');
    ov.className = 'acc-overlay';
    ov.innerHTML = '<div class="acc-modal"><div class="acc-head"><b>Users &amp; Access</b><button class="acc-x">✕</button></div>' +
      '<div class="acc-tabs"><a class="active" data-at="approvals">Approvals</a><a data-at="users">All Users</a><a data-at="leave">Leave Requests</a><a data-at="loans">Loan Requests</a></div>' +
      '<div class="acc-body" id="acc-body">Loading…</div></div>';
    document.body.appendChild(ov);
    ov.querySelector('.acc-x').onclick = function () { ov.remove(); };
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    ov.querySelectorAll('.acc-tabs a').forEach(function (a) {
      a.onclick = function () { ov.querySelectorAll('.acc-tabs a').forEach(function (x) { x.classList.remove('active'); }); a.classList.add('active'); renderTab(a.dataset.at); };
    });
    var body = ov.querySelector('#acc-body');

    function renderTab(tab) {
      body.innerHTML = 'Loading…';
      if (tab === 'leave') return api('/api/admin/leave-requests').then(function (r) { renderLeave(r.body.requests || []); });
      if (tab === 'loans') return api('/api/admin/loan-requests').then(function (r) { renderLoans(r.body.requests || []); });
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
          '<label class="acc-chk"><input type="checkbox" class="ap-emp" checked> Create 201 record</label>' +
          '<button class="acc-btn ap-go">Approve</button></div></div>';
      }).join('');
      body.querySelectorAll('.acc-card').forEach(function (cardEl) {
        cardEl.querySelector('.ap-go').onclick = function () {
          var uid = cardEl.dataset.uid;
          api('/api/admin/users/' + uid + '/approve', { method: 'POST', body: JSON.stringify({
            role: cardEl.querySelector('.ap-role').value, createEmployee: cardEl.querySelector('.ap-emp').checked }) })
            .then(function () { renderTab('approvals'); });
        };
      });
    }

    function renderUsers(users) {
      body.innerHTML = '<table class="acc-tbl"><thead><tr><th>Name / Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
        users.map(function (u) {
          return '<tr data-uid="' + u.id + '"><td>' + esc(u.fullName || '') + '<div class="acc-muted">' + esc(u.email) + (u.employeeCode ? ' • ' + esc(u.employeeCode) : '') + '</div></td>' +
            '<td><select class="u-role">' + ROLE_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === u.role ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>' +
            '<td><span class="acc-badge ' + u.status + '">' + u.status + '</span></td>' +
            '<td class="acc-actions"><button class="acc-btn ghost u-toggle">' + (u.status === 'disabled' ? 'Enable' : 'Disable') + '</button>' +
            '<button class="acc-btn ghost u-pw">Reset password</button></td></tr>';
        }).join('') + '</tbody></table>';
      body.querySelectorAll('tr[data-uid]').forEach(function (tr) {
        var uid = tr.dataset.uid;
        tr.querySelector('.u-role').onchange = function (e) {
          api('/api/admin/users/' + uid + '/role', { method: 'POST', body: JSON.stringify({ role: e.target.value }) })
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

    function renderLeave(reqs) {
      if (!reqs.length) { body.innerHTML = '<p class="acc-muted">No leave requests.</p>'; return; }
      body.innerHTML = '<table class="acc-tbl"><thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>' +
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
      if (ADMIN.indexOf(user.role) < 0) { location.href = '/portal'; return; }
      return api('/api/company').then(function (c) {
        if (!c.ok) { location.href = '/'; return; }
        window.__COMPANY__ = { data: c.body.data, version: c.body.version, role: c.body.role };
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
