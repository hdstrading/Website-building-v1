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

  function topbar(user) {
    var roleLabel = { superadmin: 'Super Admin', admin_payroll: 'Admin — Payroll', finance: 'Finance' }[user.role] || user.role;
    var bar = document.createElement('div');
    bar.className = 'topbar';
    bar.innerHTML =
      '<span class="tb-role">' + roleLabel + '</span>' +
      (user.role === 'finance' ? '<span class="tb-ro">view-only</span>' : '') +
      '<span id="tb-status" class="tb-status"></span>' +
      '<span class="tb-user">' + (user.fullName || user.email) + '</span>' +
      '<button id="tb-logout" class="tb-btn">Log out</button>';
    document.body.appendChild(bar);
    document.getElementById('tb-logout').addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; });
    });
    PH.storage.onStatus = function (s) {
      var el = document.getElementById('tb-status');
      if (!el) return;
      el.textContent = { saving: 'Saving…', saved: 'All changes saved', error: 'Save error — check connection', readonly: 'View-only' }[s] || '';
      el.className = 'tb-status ' + s;
    };
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
