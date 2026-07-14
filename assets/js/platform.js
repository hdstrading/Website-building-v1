/* ==========================================================================
 * platform.js — Platform adapter
 * --------------------------------------------------------------------------
 * Lets the same web app run both in a normal browser and inside the Android
 * WebView wrapper. When running on Android, a native bridge (AndroidBridge)
 * is injected; we route file downloads and printing through it. In a plain
 * browser these return false and the app falls back to standard web behaviour.
 * ========================================================================== */
(function (PH) {
  'use strict';

  var A = window.AndroidBridge;

  // UTF-8 safe base64 (btoa alone mangles non-ASCII like the ₱ sign).
  function toBase64Utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  PH.platform = {
    isAndroid: !!(A && A.saveBase64File),

    // Returns true if the save was handled natively.
    saveFile: function (name, content, type) {
      if (A && A.saveBase64File) {
        try {
          A.saveBase64File(name, toBase64Utf8(content), type || 'application/octet-stream');
          return true;
        } catch (e) { console.error('native saveFile failed', e); }
      }
      return false;
    },

    // Returns true if printing was handled natively.
    print: function (title, fullHtml) {
      if (A && A.printHtml) {
        try {
          A.printHtml(title || 'Document', toBase64Utf8(fullHtml));
          return true;
        } catch (e) { console.error('native print failed', e); }
      }
      return false;
    }
  };
})(window.PH = window.PH || {});
