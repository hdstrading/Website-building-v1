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
    // payslip DTR + notes
    '.ps-dtr,.ps-notes{margin-top:12px;}.ps-dtr h4,.ps-notes h4{margin:6px 0;font-size:13px;border-bottom:1px solid #ccc;}' +
    '.ps-dtr-tbl th{background:#f6f6f6;font-size:10px;text-align:left;padding:3px 4px;border-bottom:1px solid #ccc;}' +
    '.ps-note-free{margin-top:8px;font-size:11px;color:#555;min-height:18px;}.tag{font-size:9px;background:#eee;padding:1px 4px;border-radius:3px;color:#666;}' +
    // 201 file
    '.f201-head{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;}' +
    '.f201-co{font-size:18px;font-weight:800;}.f201-sub{font-size:11px;color:#555;}' +
    '.f201-title{font-size:15px;font-weight:800;letter-spacing:1px;}.f201-name{font-size:16px;font-weight:700;margin:12px 0;}' +
    '.f201-code{font-size:12px;color:#777;font-weight:400;}.f201-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;}' +
    '.f201-grid h4,.f201-h{margin:4px 0 6px;font-size:11px;color:#0e7490;text-transform:uppercase;letter-spacing:.4px;}' +
    '.f201-h{margin-top:14px;border-top:1px solid #ccc;padding-top:8px;}' +
    '.f201-tbl{width:100%;border-collapse:collapse;font-size:12px;}.f201-tbl td{padding:3px 4px;border-bottom:1px dotted #ddd;vertical-align:top;}' +
    '.f201-l{color:#777;width:42%;}.f201-list{width:100%;border-collapse:collapse;font-size:12px;}' +
    '.f201-list th,.f201-list td{padding:5px 6px;border-bottom:1px solid #ddd;text-align:left;}.f201-list th{background:#f6f6f6;font-size:11px;color:#555;}' +
    // reports
    'h2{font-size:16px;margin:0 0 4px;}.rpt-sub{font-size:12px;color:#555;margin-bottom:10px;}' +
    // BIR forms
    '.bir-remit{background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:8px 12px;margin-top:10px;font-size:13px;}' +
    '.kv{border-collapse:collapse;font-size:11px;margin:8px 0 12px;width:100%;}.kv td{border:1px solid #ccc;padding:4px 8px;}' +
    '.kv td:nth-child(odd){background:#f6f6f6;font-weight:bold;width:18%;}' +
    '.form2316{border:1px solid #333;padding:16px;max-width:720px;}' +
    '.f2316-head{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;}' +
    '.f2316-tbl{width:100%;font-size:11px;border-collapse:collapse;}.f2316-tbl td{padding:4px 8px;border-bottom:1px dotted #ddd;}' +
    '.f2316-tbl tr.sec td{background:#eee;font-weight:bold;}.f2316-tbl tfoot td{border-top:2px solid #111;background:#f6f6f6;}' +
    '.f2316-note{font-size:10px;color:#555;margin-top:10px;}.ps-sign{display:flex;justify-content:space-between;margin-top:24px;font-size:11px;text-align:center;}' +
    '.tbl,.rpt-tbl{width:100%;border-collapse:collapse;font-size:11px;}' +
    '.tbl th,.tbl td,.rpt-tbl th,.rpt-tbl td{border:1px solid #ccc;padding:4px 6px;text-align:left;white-space:nowrap;}' +
    '.tbl th,.rpt-tbl th{background:#f6f6f6;}.tbl tfoot td,.rpt-tbl tfoot td{background:#f0f0f0;}' +
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
