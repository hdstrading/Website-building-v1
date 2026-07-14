/* ==========================================================================
 * statutory.js — Philippine statutory contribution & tax engine
 * --------------------------------------------------------------------------
 * All rates/tables live in one editable config object (PH.statutory.config)
 * so they can be updated from the Settings screen when a new government
 * circular is released. Defaults reflect the schedules in force for 2025.
 *
 * IMPORTANT: Government contribution tables change frequently. Always verify
 * the built-in defaults against the latest official circulars from SSS,
 * PhilHealth, Pag-IBIG (HDMF) and the BIR before using in production.
 * ========================================================================== */
(function (PH) {
  'use strict';

  var DEFAULT_CONFIG = {
    // ---- SSS (RA 11199 schedule, 2025: 15% total) --------------------------
    sss: {
      totalRate: 0.15,        // total contribution rate
      employeeRate: 0.05,     // employee share
      employerRate: 0.10,     // employer share (incl. WISP portion)
      mscStep: 500,           // Monthly Salary Credit increment
      mscMin: 5000,           // minimum MSC
      mscMax: 35000,          // maximum MSC (incl. WISP tier)
      ecThreshold: 15000,     // MSC at/above which EC = ecHigh
      ecLow: 10,              // Employees' Compensation (employer only)
      ecHigh: 30
    },
    // ---- PhilHealth (2024/2025: 5% premium) --------------------------------
    philhealth: {
      rate: 0.05,             // total premium rate
      employeeShare: 0.5,     // employee pays half
      floor: 10000,           // income floor
      ceiling: 100000         // income ceiling
    },
    // ---- Pag-IBIG / HDMF ---------------------------------------------------
    pagibig: {
      lowBracket: 1500,       // compensation at/below which employee rate = eeRateLow
      eeRateLow: 0.01,
      eeRateHigh: 0.02,
      erRate: 0.02,
      maxBase: 10000          // max monthly compensation used for the computation
    },
    // ---- BIR Withholding Tax (TRAIN, tables effective 2023 onward) ---------
    // Monthly brackets. base = tax on lower bound, rate applied to excess.
    tax: {
      brackets: [
        { over: 0,      base: 0,        rate: 0.00 },
        { over: 20833,  base: 0,        rate: 0.15 },
        { over: 33333,  base: 2500,     rate: 0.20 },
        { over: 66667,  base: 8541.80,  rate: 0.25 },
        { over: 166667, base: 33541.80, rate: 0.30 },
        { over: 666667, base: 183541.80,rate: 0.35 }
      ]
    }
  };

  // Deep clone so edits never mutate the defaults.
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var config = clone(DEFAULT_CONFIG);

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /* ---- SSS ---------------------------------------------------------------
   * Determines the Monthly Salary Credit by rounding compensation to the
   * nearest MSC step (bounded by min/max), then applies the statutory rates.
   * Employee-facing deduction = MSC x employeeRate (this already includes any
   * WISP portion the employee pays on the upper MSC tier).
   */
  function computeSSS(compensation, cfg) {
    cfg = cfg || config.sss;
    var comp = Math.max(0, compensation || 0);
    var msc = Math.round(comp / cfg.mscStep) * cfg.mscStep;
    if (msc < cfg.mscMin) msc = cfg.mscMin;
    if (msc > cfg.mscMax) msc = cfg.mscMax;
    var ee = round2(msc * cfg.employeeRate);
    var er = round2(msc * cfg.employerRate);
    var ec = msc >= cfg.ecThreshold ? cfg.ecHigh : cfg.ecLow;
    return { msc: msc, ee: ee, er: er, ec: ec, total: round2(ee + er + ec) };
  }

  /* ---- PhilHealth --------------------------------------------------------- */
  function computePhilHealth(salary, cfg) {
    cfg = cfg || config.philhealth;
    var base = Math.min(Math.max(salary || 0, cfg.floor), cfg.ceiling);
    var premium = round2(base * cfg.rate);
    var ee = round2(premium * cfg.employeeShare);
    var er = round2(premium - ee);
    return { base: base, ee: ee, er: er, total: premium };
  }

  /* ---- Pag-IBIG / HDMF --------------------------------------------------- */
  function computePagIBIG(compensation, cfg) {
    cfg = cfg || config.pagibig;
    var comp = Math.max(0, compensation || 0);
    var base = Math.min(comp, cfg.maxBase);
    var eeRate = comp <= cfg.lowBracket ? cfg.eeRateLow : cfg.eeRateHigh;
    var ee = round2(base * eeRate);
    var er = round2(base * cfg.erRate);
    return { base: base, ee: ee, er: er, total: round2(ee + er) };
  }

  /* ---- BIR Withholding Tax ----------------------------------------------
   * The BIR daily/weekly/semi-monthly/monthly tables are the annual schedule
   * divided by the number of periods per year. We scale the monthly brackets
   * by a period factor to reproduce each table.
   */
  var PERIOD_FACTOR = {
    monthly: 1,
    'semi-monthly': 0.5,
    weekly: 12 / 52,
    daily: 12 / 365
  };

  function computeWithholdingTax(taxableIncome, frequency, cfg) {
    cfg = cfg || config.tax;
    var factor = PERIOD_FACTOR[frequency] != null ? PERIOD_FACTOR[frequency] : 1;
    var income = Math.max(0, taxableIncome || 0);
    var brackets = cfg.brackets;
    var chosen = brackets[0];
    for (var i = brackets.length - 1; i >= 0; i--) {
      if (income > brackets[i].over * factor) { chosen = brackets[i]; break; }
    }
    var tax = chosen.base * factor + chosen.rate * (income - chosen.over * factor);
    return round2(Math.max(0, tax));
  }

  /* ---- Aggregate all mandatory contributions -----------------------------
   * `basis` is the compensation figure used for statutory bases (usually the
   * monthly basic salary, regardless of pay frequency).
   */
  function computeContributions(basis) {
    var sss = computeSSS(basis);
    var ph = computePhilHealth(basis);
    var pi = computePagIBIG(basis);
    return {
      sss: sss,
      philhealth: ph,
      pagibig: pi,
      employeeTotal: round2(sss.ee + ph.ee + pi.ee),
      employerTotal: round2(sss.er + sss.ec + ph.er + pi.er)
    };
  }

  PH.statutory = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    get config() { return config; },
    setConfig: function (c) { config = c; },
    resetConfig: function () { config = clone(DEFAULT_CONFIG); return config; },
    computeSSS: computeSSS,
    computePhilHealth: computePhilHealth,
    computePagIBIG: computePagIBIG,
    computeWithholdingTax: computeWithholdingTax,
    computeContributions: computeContributions,
    round2: round2
  };
})(window.PH = window.PH || {});
