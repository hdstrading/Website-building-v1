/* ==========================================================================
 * idle.js — auto sign-out after inactivity (online portal & admin app)
 * --------------------------------------------------------------------------
 * Logs the user out and returns to the sign-in page after 5 minutes with no
 * activity, so an unattended session can't be used by someone else.
 * ========================================================================== */
(function () {
  'use strict';
  var IDLE_MS = 5 * 60 * 1000; // 5 minutes
  var timer = null, signingOut = false;
  function signOut() {
    if (signingOut) return;
    signingOut = true;
    try { fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    setTimeout(function () { location.href = '/?timeout=1'; }, 150);
  }
  function reset() { if (signingOut) return; clearTimeout(timer); timer = setTimeout(signOut, IDLE_MS); }
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(function (ev) {
    document.addEventListener(ev, reset, { passive: true });
  });
  reset();
})();
