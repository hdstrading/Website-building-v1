/* ==========================================================================
 * app.js — Bootstrap
 * ========================================================================== */
(function (PH) {
  'use strict';

  // CSS injected into the print window for payslips.
  var PRINT_CSS =
    'body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:16px;}' +
    '.payslip{border:1px solid #333;padding:16px;margin-bottom:16px;max-width:720px;}' +
    '.ps-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:8px;}' +
    '.ps-co{font-size:18px;font-weight:bold;}.ps-co-sub{font-size:11px;color:#555;}' +
    '.ps-title{font-size:16px;font-weight:bold;letter-spacing:2px;}' +
    '.ps-meta{display:flex;justify-content:space-between;font-size:12px;margin:8px 0;flex-wrap:wrap;gap:4px;}' +
    '.ps-cols{display:flex;gap:16px;}.ps-col{flex:1;}' +
    '.ps-col h4{margin:6px 0;border-bottom:1px solid #ccc;font-size:13px;}' +
    '.ps-tbl{width:100%;border-collapse:collapse;font-size:12px;}' +
    '.ps-tbl td{padding:3px 4px;border-bottom:1px dotted #ddd;}' +
    '.ps-tbl tfoot td{border-top:1px solid #333;border-bottom:none;}' +
    '.num{text-align:right;}.tag{font-size:9px;background:#eee;padding:1px 4px;border-radius:3px;color:#666;}' +
    '.ps-net{margin-top:10px;background:#111;color:#fff;padding:8px 12px;display:flex;justify-content:space-between;font-weight:bold;font-size:15px;}' +
    '.ps-foot{margin-top:10px;}.ps-mini{width:100%;border-collapse:collapse;font-size:11px;}' +
    '.ps-mini td{border:1px solid #ddd;padding:3px 6px;}.ps-mini td:nth-child(odd){background:#f6f6f6;font-weight:bold;}' +
    '.ps-sign{display:flex;justify-content:space-between;margin-top:24px;font-size:11px;text-align:center;}' +
    '.muted{color:#999;}.page-break{page-break-after:always;}' +
    '@media print{.payslip{border:1px solid #333;}}';

  function init() {
    PH.storage.load();
    PH.storage.seedIfEmpty();
    PH.ui._setPrintCss(PRINT_CSS);
    PH.ui.render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }

  PH.init = init;
})(window.PH = window.PH || {});
