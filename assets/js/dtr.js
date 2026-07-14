/* ==========================================================================
 * dtr.js — Daily Time Record parsing & hours computation
 * --------------------------------------------------------------------------
 * Parses uploaded DTR (CSV), computes worked hours, overtime, night
 * differential, tardiness and undertime, and applies DOLE premium rates
 * per day type (regular / rest day / special / regular holiday).
 * ========================================================================== */
(function (PH) {
  'use strict';

  // DOLE premium multipliers applied to the hourly rate.
  // Reference: Labor Code of the Philippines / DOLE Handbook on Workers'
  // Statutory Monetary Benefits.
  var DAY_TYPES = {
    regular:          { label: 'Regular Day',            regular: 1.00, ot: 1.25 },
    rest_day:         { label: 'Rest Day',               regular: 1.30, ot: 1.69 },
    special:          { label: 'Special Non-Working Day',regular: 1.30, ot: 1.69 },
    special_rest:     { label: 'Special Day + Rest Day', regular: 1.50, ot: 1.95 },
    regular_holiday:  { label: 'Regular Holiday',        regular: 2.00, ot: 2.60 },
    regular_hol_rest: { label: 'Regular Holiday + Rest', regular: 2.60, ot: 3.38 }
  };

  var NIGHT_DIFF_RATE = 0.10;   // +10% for hours 22:00–06:00
  var NIGHT_START = 22 * 60;    // minutes from midnight
  var NIGHT_END = 6 * 60;
  var STANDARD_DAY_MINUTES = 8 * 60;

  function toMinutes(t) {
    if (t == null || t === '') return null;
    t = String(t).trim();
    // Accept "HH:MM", "H:MM AM/PM", "HHMM"
    var ampm = null;
    var m = t.match(/(am|pm)$/i);
    if (m) { ampm = m[1].toLowerCase(); t = t.replace(/\s*(am|pm)$/i, '').trim(); }
    var parts, h, min;
    if (t.indexOf(':') >= 0) {
      parts = t.split(':');
      h = parseInt(parts[0], 10);
      min = parseInt(parts[1], 10) || 0;
    } else if (/^\d{3,4}$/.test(t)) {
      h = parseInt(t.slice(0, t.length - 2), 10);
      min = parseInt(t.slice(-2), 10);
    } else {
      h = parseInt(t, 10); min = 0;
    }
    if (isNaN(h)) return null;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return h * 60 + (min || 0);
  }

  // Minutes worked that fall inside the night-differential window (22:00–06:00).
  function nightMinutes(start, end) {
    if (start == null || end == null) return 0;
    var total = 0;
    // Walk each minute-block; handle shifts crossing midnight by adding 1440.
    if (end <= start) end += 24 * 60;
    for (var t = start; t < end; t++) {
      var m = t % (24 * 60);
      if (m >= NIGHT_START || m < NIGHT_END) total++;
    }
    return total;
  }

  /* Apply the company overtime policy to a raw OT minute count.
   * Rules (all configurable):
   *  - Round to `incrementMinutes` blocks (default 30). If within `graceMinutes`
   *    (default 5) of completing the next block, round up; otherwise floor.
   *    e.g. 58 min -> 60 (within 5 of 60); 40 min -> 30.
   *  - OT is only credited once the first block of `minMinutes` (default 60,
   *    "the first hour") is completed. Below that, OT = 0.
   */
  function applyOtRules(otRaw, rules) {
    rules = rules || {};
    if (rules.enabled === false) return 0;
    if (!(otRaw > 0)) return 0;
    var inc = rules.incrementMinutes > 0 ? rules.incrementMinutes : 30;
    var grace = rules.graceMinutes != null ? rules.graceMinutes : 5;
    var minM = rules.minMinutes != null ? rules.minMinutes : 60;
    var blocks = Math.floor(otRaw / inc);
    var rem = otRaw - blocks * inc;
    if (rem >= inc - grace) blocks += 1;   // within grace of the next block
    var rounded = blocks * inc;
    return rounded < minM ? 0 : rounded;
  }

  /* Compute one day's figures.
   * day = { date, dayType, restDay, timeIn, timeOut, breakMins, requiredMinutes,
   *         scheduledIn, scheduledOut, absent, leavePaid }
   * opts = { defaultBreak, schedIn, schedOut, ot } — employee schedule + OT policy.
   */
  function computeDay(day, opts) {
    opts = opts || {};
    var result = {
      date: day.date,
      dayType: day.dayType || 'regular',
      restDay: !!day.restDay,
      workedMinutes: 0, regularMinutes: 0, otMinutes: 0, otRawMinutes: 0,
      nightDiffMinutes: 0, lateMinutes: 0, undertimeMinutes: 0,
      absent: !!day.absent, paidLeave: !!day.leavePaid, leaveType: day.leaveType || ''
    };

    // Resolve effective day type (rest-day upgrades)
    var dt = day.dayType || 'regular';
    if (day.restDay) {
      if (dt === 'regular') dt = 'rest_day';
      else if (dt === 'special') dt = 'special_rest';
      else if (dt === 'regular_holiday') dt = 'regular_hol_rest';
    }
    result.dayType = dt;

    if (day.absent) return result;

    var inM = toMinutes(day.timeIn);
    var outM = toMinutes(day.timeOut);
    if (inM == null || outM == null) {
      // No punches but flagged paid leave / holiday-with-pay handled by payroll
      return result;
    }
    var brk = day.breakMins != null ? day.breakMins : (opts.defaultBreak != null ? opts.defaultBreak : 60);
    var span = outM - inM;
    if (span <= 0) span += 24 * 60; // crossed midnight
    var worked = Math.max(0, span - brk);
    result.workedMinutes = worked;

    // Employee schedule (a per-day value overrides; blank falls back to default).
    var hasVal = function (x) { return x != null && String(x).trim() !== ''; };
    var schedIn = toMinutes(hasVal(day.scheduledIn) ? day.scheduledIn : opts.schedIn);
    var schedOut = toMinutes(hasVal(day.scheduledOut) ? day.scheduledOut : opts.schedOut);

    if (schedIn != null && schedOut != null) {
      // ----- Schedule-based (identifies late / undertime / OT) -----
      var schedSpan = schedOut - schedIn;
      if (schedSpan <= 0) schedSpan += 24 * 60;
      var required = day.requiredMinutes != null ? day.requiredMinutes : Math.max(0, schedSpan - brk);
      // Normalise the out time relative to the shift start for overnight shifts.
      var schedOutN = schedOut < schedIn ? schedOut + 24 * 60 : schedOut;
      var outN = outM;
      if (outN < schedIn) outN += 24 * 60;
      result.lateMinutes = Math.max(0, inM - schedIn);
      result.undertimeMinutes = Math.max(0, schedOutN - outN);
      // Full scheduled day is "regular"; late & undertime are deducted separately
      // in peso terms, so paid regular time nets to what was actually rendered.
      result.regularMinutes = required;
      var otRaw = Math.max(0, outN - schedOutN);
      result.otRawMinutes = otRaw;
      result.otMinutes = applyOtRules(otRaw, opts.ot);
    } else {
      // ----- Fallback (no schedule set): pay by hours worked beyond 8 -----
      var required2 = day.requiredMinutes != null ? day.requiredMinutes : STANDARD_DAY_MINUTES;
      result.regularMinutes = Math.min(worked, required2);
      result.otRawMinutes = Math.max(0, worked - required2);
      result.otMinutes = applyOtRules(result.otRawMinutes, opts.ot);
      if (worked < required2 && dt === 'regular') result.undertimeMinutes = required2 - worked;
    }

    result.nightDiffMinutes = nightMinutes(inM, outM);
    return result;
  }

  /* Compute pay for one day given the employee hourly rate. */
  function computeDayPay(dayResult, hourlyRate) {
    var mult = DAY_TYPES[dayResult.dayType] || DAY_TYPES.regular;
    var perMin = hourlyRate / 60;
    var regularPay = dayResult.regularMinutes * perMin * mult.regular;
    var otPay = dayResult.otMinutes * perMin * mult.ot;
    var ndPay = dayResult.nightDiffMinutes * perMin * NIGHT_DIFF_RATE;
    return {
      regular: PH.statutory.round2(regularPay),
      overtime: PH.statutory.round2(otPay),
      nightDiff: PH.statutory.round2(ndPay),
      total: PH.statutory.round2(regularPay + otPay + ndPay)
    };
  }

  /* Summarise & price a full period of DTR days. */
  function computeDTR(days, hourlyRate, opts) {
    var summary = {
      daysPresent: 0, daysAbsent: 0, paidLeaves: 0,
      holidayDaysUnworked: 0,   // unworked REGULAR holidays -> paid at 100%
      leaveDaysRequested: 0,    // unworked paid-leave days (gated by credits in payroll)
      regularMinutes: 0, otMinutes: 0, nightDiffMinutes: 0,
      lateMinutes: 0, undertimeMinutes: 0,
      regularPay: 0, overtimePay: 0, nightDiffPay: 0,
      details: []
    };
    (days || []).forEach(function (d) {
      var r = computeDay(d, opts);
      var pay = computeDayPay(r, hourlyRate);
      r.pay = pay;
      if (r.absent) summary.daysAbsent++;
      else if (r.paidLeave && r.workedMinutes === 0) summary.paidLeaves++;
      else if (r.workedMinutes > 0) summary.daysPresent++;
      // Unworked-day pay rules (Labor Code):
      //  - Regular holiday not worked => still paid 100% of daily rate.
      //  - Paid leave day => counted here, paid later if leave credits remain.
      //  - Special non-working day not worked => no work, no pay (nothing added).
      if (!r.absent && r.workedMinutes === 0) {
        if (/regular_hol/.test(r.dayType)) { summary.holidayDaysUnworked++; r.unworkedHoliday = true; }
        else if (r.paidLeave) summary.leaveDaysRequested++;
      }
      summary.regularMinutes += r.regularMinutes;
      summary.otMinutes += r.otMinutes;
      summary.nightDiffMinutes += r.nightDiffMinutes;
      summary.lateMinutes += r.lateMinutes;
      summary.undertimeMinutes += r.undertimeMinutes;
      summary.regularPay += pay.regular;
      summary.overtimePay += pay.overtime;
      summary.nightDiffPay += pay.nightDiff;
      summary.details.push(r);
    });
    // Tardiness / undertime deduction (in peso)
    var perMin = hourlyRate / 60;
    summary.lateDeduction = PH.statutory.round2(summary.lateMinutes * perMin);
    summary.undertimeDeduction = PH.statutory.round2(summary.undertimeMinutes * perMin);
    ['regularPay', 'overtimePay', 'nightDiffPay'].forEach(function (k) {
      summary[k] = PH.statutory.round2(summary[k]);
    });
    return summary;
  }

  /* ---- CSV parsing ------------------------------------------------------- */
  function parseCSV(text) {
    var rows = [];
    var row = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }

  /* Import DTR CSV into per-employee day arrays keyed by employee code.
   * Expected headers (case-insensitive, flexible):
   *   EmployeeCode, Date, TimeIn, TimeOut, Break, DayType, RestDay,
   *   ScheduledIn, Absent, PaidLeave, RequiredHours
   */
  function importDTRCsv(text) {
    var rows = parseCSV(text);
    if (!rows.length) return {};
    var header = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); });
    function idx() {
      for (var a = 0; a < arguments.length; a++) {
        var j = header.indexOf(arguments[a]);
        if (j >= 0) return j;
      }
      return -1;
    }
    var iCode = idx('employeecode', 'code', 'employeeid', 'empid', 'id');
    var iDate = idx('date');
    var iIn = idx('timein', 'in', 'am_in', 'amin');
    var iOut = idx('timeout', 'out', 'pm_out', 'pmout');
    var iBreak = idx('break', 'breakmins', 'breakminutes');
    var iType = idx('daytype', 'type', 'holiday');
    var iRest = idx('restday', 'rest');
    var iSched = idx('scheduledin', 'schedin', 'shiftstart');
    var iSchedOut = idx('scheduledout', 'schedout', 'shiftend');
    var iAbsent = idx('absent');
    var iLeave = idx('paidleave', 'leave');
    var iLeaveType = idx('leavetype', 'leavecode');
    var iReq = idx('requiredhours', 'requiredhrs', 'reqhours');

    var out = {};
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var code = (iCode >= 0 ? row[iCode] : '').trim();
      if (!code) continue;
      var d = {
        date: iDate >= 0 ? row[iDate].trim() : '',
        timeIn: iIn >= 0 ? row[iIn].trim() : '',
        timeOut: iOut >= 0 ? row[iOut].trim() : '',
        breakMins: iBreak >= 0 && row[iBreak].trim() !== '' ? parseInt(row[iBreak], 10) : undefined,
        dayType: normaliseType(iType >= 0 ? row[iType].trim() : ''),
        restDay: iRest >= 0 ? truthy(row[iRest]) : false,
        scheduledIn: iSched >= 0 ? row[iSched].trim() : undefined,
        scheduledOut: iSchedOut >= 0 ? row[iSchedOut].trim() : undefined,
        absent: iAbsent >= 0 ? truthy(row[iAbsent]) : false,
        leaveType: normaliseLeave(iLeaveType >= 0 ? row[iLeaveType] : ''),
        leavePaid: (iLeaveType >= 0 && normaliseLeave(row[iLeaveType])) ? true : (iLeave >= 0 ? truthy(row[iLeave]) : false),
        requiredMinutes: iReq >= 0 && row[iReq].trim() !== '' ? Math.round(parseFloat(row[iReq]) * 60) : undefined
      };
      (out[code] = out[code] || []).push(d);
    }
    return out;
  }

  function truthy(v) {
    v = String(v || '').trim().toLowerCase();
    return v === '1' || v === 'y' || v === 'yes' || v === 'true' || v === 'x';
  }
  function normaliseLeave(v) {
    v = String(v || '').trim().toUpperCase();
    if (v === 'SL' || v === 'VL' || v === 'EL') return v;
    if (/SICK/.test(v)) return 'SL';
    if (/VAC/.test(v)) return 'VL';
    if (/EMERG/.test(v)) return 'EL';
    return '';
  }
  function normaliseType(v) {
    // Strip spaces/underscores/punctuation so "regular_holiday", "Regular Holiday"
    // and "regularholiday" all match.
    v = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (!v) return 'regular';
    if (v === 'rh' || (v.indexOf('regular') >= 0 && v.indexOf('hol') >= 0)) return 'regular_holiday';
    if (v.indexOf('special') >= 0 || v === 'sh' || v === 'snw' || v === 'snwh') return 'special';
    if (v.indexOf('rest') >= 0) return 'rest_day';
    if (v.indexOf('hol') >= 0) return 'regular_holiday'; // bare "holiday" => regular holiday
    return 'regular';
  }

  PH.dtr = {
    DAY_TYPES: DAY_TYPES,
    NIGHT_DIFF_RATE: NIGHT_DIFF_RATE,
    toMinutes: toMinutes,
    nightMinutes: nightMinutes,
    applyOtRules: applyOtRules,
    computeDay: computeDay,
    computeDayPay: computeDayPay,
    computeDTR: computeDTR,
    parseCSV: parseCSV,
    importDTRCsv: importDTRCsv
  };
})(window.PH = window.PH || {});
