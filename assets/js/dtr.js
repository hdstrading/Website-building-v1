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
   *  - Late penalty (when `lateForfeitsFirstHour` is on, default): if the
   *    employee is late by more than `graceMinutes`, the first hour of OT is
   *    NOT approved and the remainder is credited only in COMPLETE whole hours.
   *    e.g. late + 2h30m OT -> 1h; late + 1h30m OT -> 0.
   */
  function applyOtRules(otRaw, rules, lateMinutes) {
    rules = rules || {};
    if (rules.enabled === false) return 0;
    if (!(otRaw > 0)) return 0;
    var inc = rules.incrementMinutes > 0 ? rules.incrementMinutes : 30;
    var grace = rules.graceMinutes != null ? rules.graceMinutes : 5;
    var minM = rules.minMinutes != null ? rules.minMinutes : 60;
    var late = lateMinutes || 0;

    if (late > grace && rules.lateForfeitsFirstHour !== false) {
      var creditable = otRaw - minM;          // forfeit the first hour
      if (creditable <= 0) return 0;
      return Math.floor(creditable / 60) * 60; // complete whole hours only
    }

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
      preOtMinutes: 0, preOtRawMinutes: 0, otExcludedMinutes: 0,
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
      // Post-shift OT (work beyond scheduled end).
      var otRaw = Math.max(0, outN - schedOutN);
      result.otRawMinutes = otRaw;
      result.otMinutes = applyOtRules(otRaw, opts.ot, result.lateMinutes);
      // Pre-shift OT (clock-in before scheduled start). No late penalty applies.
      var preRaw = Math.max(0, schedIn - inM);
      result.preOtRawMinutes = preRaw;
      result.preOtMinutes = applyOtRules(preRaw, opts.ot, 0);
    } else {
      // ----- Fallback (no schedule set): pay by hours worked beyond 8 -----
      var required2 = day.requiredMinutes != null ? day.requiredMinutes : STANDARD_DAY_MINUTES;
      result.regularMinutes = Math.min(worked, required2);
      result.otRawMinutes = Math.max(0, worked - required2);
      result.otMinutes = applyOtRules(result.otRawMinutes, opts.ot);
      if (worked < required2 && dt === 'regular') result.undertimeMinutes = required2 - worked;
    }

    // Overtime authorization gating: pay OT only when authorized for this date
    // (before = pre-shift early-in, after = post-shift). Excluded OT is tracked
    // so admins can see how much unauthorized OT was rendered but not paid.
    if (opts.requireOtAuth) {
      var auth = (opts.otAuth && opts.otAuth[day.date]) || null;
      if (!(auth && auth.after)) { result.otExcludedMinutes += result.otMinutes; result.otMinutes = 0; }
      if (!(auth && auth.before)) { result.otExcludedMinutes += result.preOtMinutes; result.preOtMinutes = 0; }
    }

    result.nightDiffMinutes = nightMinutes(inM, outM);
    return result;
  }

  /* Compute pay for one day given the employee hourly rate. */
  function computeDayPay(dayResult, hourlyRate) {
    var mult = DAY_TYPES[dayResult.dayType] || DAY_TYPES.regular;
    var perMin = hourlyRate / 60;
    var regularPay = dayResult.regularMinutes * perMin * mult.regular;
    // Pre-shift and post-shift OT are both paid at the day's OT multiplier.
    var otPay = (dayResult.otMinutes + (dayResult.preOtMinutes || 0)) * perMin * mult.ot;
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
      unpaidLeaveDays: 0,       // Unpaid Authorized Leave (UAL) days — tracked, never paid
      leaveDays: [],            // [{date, type}] in order, for per-type pay & credits
      regularMinutes: 0, otMinutes: 0, preOtMinutes: 0, otExcludedMinutes: 0, nightDiffMinutes: 0,
      lateMinutes: 0, undertimeMinutes: 0,
      regularPay: 0, overtimePay: 0, nightDiffPay: 0,
      // Worked premium-day pay, kept apart from ordinary regular-day pay so the
      // payslip can show holiday/rest-day pay on their own lines.
      regularHolidayPay: 0, specialHolidayPay: 0, restDayPay: 0,
      details: []
    };
    (days || []).forEach(function (d) {
      var r = computeDay(d, opts);
      var pay = computeDayPay(r, hourlyRate);
      r.pay = pay;
      if (r.absent) summary.daysAbsent++;
      else if (r.leaveType === 'UAL' && r.workedMinutes === 0) { /* unpaid — counted below */ }
      else if (r.paidLeave && r.workedMinutes === 0) summary.paidLeaves++;
      else if (r.workedMinutes > 0) summary.daysPresent++;
      // Unworked-day pay rules (Labor Code):
      //  - Regular holiday not worked => still paid 100% of daily rate.
      //  - Paid leave day => counted here, paid later if leave credits remain.
      //  - Special non-working day not worked => no work, no pay (nothing added).
      if (!r.absent && r.workedMinutes === 0) {
        if (r.leaveType === 'UAL') { summary.unpaidLeaveDays++; r.unpaidLeave = true; }
        else if (/regular_hol/.test(r.dayType)) { summary.holidayDaysUnworked++; r.unworkedHoliday = true; }
        else if (r.paidLeave) {
          summary.leaveDaysRequested++;
          summary.leaveDays.push({ date: r.date, type: r.leaveType || '' });
        }
      }
      summary.regularMinutes += r.regularMinutes;
      summary.otMinutes += r.otMinutes;
      summary.preOtMinutes += (r.preOtMinutes || 0);
      summary.otExcludedMinutes += (r.otExcludedMinutes || 0);
      summary.nightDiffMinutes += r.nightDiffMinutes;
      summary.lateMinutes += r.lateMinutes;
      summary.undertimeMinutes += r.undertimeMinutes;
      // Route the day's base ("regular") pay into the right bucket by day type:
      // ordinary regular days vs worked regular-holiday / special-holiday / rest-day.
      if (r.dayType === 'regular') summary.regularPay += pay.regular;
      else if (/regular_hol/.test(r.dayType)) summary.regularHolidayPay += pay.regular;
      else if (/special/.test(r.dayType)) summary.specialHolidayPay += pay.regular;
      else summary.restDayPay += pay.regular; // rest_day
      summary.overtimePay += pay.overtime;
      summary.nightDiffPay += pay.nightDiff;
      summary.details.push(r);
    });
    // Tardiness / undertime deduction (in peso)
    var perMin = hourlyRate / 60;
    summary.lateDeduction = PH.statutory.round2(summary.lateMinutes * perMin);
    summary.undertimeDeduction = PH.statutory.round2(summary.undertimeMinutes * perMin);
    ['regularPay', 'overtimePay', 'nightDiffPay', 'regularHolidayPay', 'specialHolidayPay', 'restDayPay'].forEach(function (k) {
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
    if (v === 'SL' || v === 'VL' || v === 'EL' || v === 'UAL') return v;
    if (/SICK/.test(v)) return 'SL';
    if (/VAC/.test(v)) return 'VL';
    if (/UNPAID/.test(v) || /\bUAL\b/.test(v)) return 'UAL';   // Unpaid Authorized Leave
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

  /* ---- Biometric attendance import (NGTeco NG-TC1 export & similar) --------
   * NGTeco has no direct API; you export attendance (Excel/CSV) from NGTeco
   * Office and import it here. Handles two shapes:
   *   (a) raw punch log  — one row per punch with a date/time; grouped per
   *       person per day into first punch = time in, last = time out.
   *   (b) daily summary  — one row per person per day with in/out columns.
   * Returns { biometricId: [ {date, timeIn, timeOut} ] }, keyed by the device
   * user id/number so the UI can map it to an employee.
   */
  function pad2n(n) { return (n < 10 ? '0' : '') + n; }
  function minutesToHHMM(m) { return pad2n(Math.floor(m / 60)) + ':' + pad2n(m % 60); }
  // "07:57:04" -> "07:57" (biometric exports include seconds; DTR works in minutes).
  function trimSeconds(t) { var m = /^(\d{1,2}):(\d{2})(?::\d{2})?/.exec(t || ''); return m ? m[1] + ':' + m[2] : (t || ''); }
  // Normalise a date token to YYYY-MM-DD (accepts YYYY-M-D, M/D/YYYY, D/M/YYYY).
  function normaliseDate(s) {
    s = String(s || '').trim();
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return m[1] + '-' + pad2n(+m[2]) + '-' + pad2n(+m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) {
      var a = +m[1], b = +m[2];
      // If the first field is > 12 it must be the day (D/M/Y); otherwise assume M/D/Y.
      var mo = a > 12 ? b : a, da = a > 12 ? a : b;
      return m[3] + '-' + pad2n(mo) + '-' + pad2n(da);
    }
    return s;
  }
  // Split a combined "date time" value into { date, time }.
  function splitDateTime(s) {
    s = String(s || '').trim();
    var parts = s.split(/[ T]+/);
    if (parts.length >= 2) {
      var timePart = parts.slice(1).join(' ');
      return { date: normaliseDate(parts[0]), time: timePart };
    }
    return { date: normaliseDate(s), time: '' };
  }

  function importBiometricCsv(text) {
    var rows = parseCSV(text);
    if (!rows.length) return {};
    var header = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); });
    function idx() {
      for (var a = 0; a < arguments.length; a++) {
        var j = header.indexOf(arguments[a]); if (j >= 0) return j;
      }
      return -1;
    }
    var iId = idx('userid', 'employeeid', 'empid', 'pin', 'enrollid', 'acno', 'id', 'no', 'usernumber', 'personid');
    var iName = idx('name', 'username', 'employeename', 'fullname');
    var iDateTime = idx('datetime', 'punchtime', 'clocktime', 'timestamp', 'checktime', 'time');
    var iDate = idx('date', 'attdate', 'workdate');
    var iIn = idx('clockin', 'timein', 'checkin', 'in', 'signin', 'onduty');
    var iOut = idx('clockout', 'timeout', 'checkout', 'out', 'signout', 'offduty');
    // "time" can be a punch time (raw) or unused; prefer explicit in/out if present.
    var out = {};
    function keyFor(row) {
      var k = iId >= 0 ? String(row[iId] || '').trim() : '';
      if (!k && iName >= 0) k = String(row[iName] || '').trim();
      return k;
    }

    var dailyMode = iIn >= 0 && iOut >= 0;
    if (dailyMode) {
      for (var r = 1; r < rows.length; r++) {
        var row = rows[r]; var key = keyFor(row); if (!key) continue;
        var date = iDate >= 0 ? normaliseDate(row[iDate]) : '';
        if (!date && iDateTime >= 0) date = splitDateTime(row[iDateTime]).date;
        if (!date) continue;
        (out[key] = out[key] || []).push({
          date: date,
          timeIn: trimSeconds(String(row[iIn] || '').trim()),
          timeOut: trimSeconds(String(row[iOut] || '').trim())
        });
      }
      return out;
    }

    // Raw punch mode: group all punches by person + day, in=earliest, out=latest.
    var groups = {}; // key -> date -> { min:{m,s}, max:{m,s} }
    for (var r2 = 1; r2 < rows.length; r2++) {
      var row2 = rows[r2]; var key2 = keyFor(row2); if (!key2) continue;
      var date2, timeStr;
      if (iDateTime >= 0) { var dt = splitDateTime(row2[iDateTime]); date2 = dt.date; timeStr = dt.time; }
      else if (iDate >= 0) { date2 = normaliseDate(row2[iDate]); timeStr = ''; }
      else continue;
      if (!date2 || !timeStr) continue;
      var mins = toMinutes(timeStr);
      if (mins == null) continue;
      var g = groups[key2] || (groups[key2] = {});
      var d = g[date2];
      if (!d) { g[date2] = { min: { m: mins, s: timeStr }, max: { m: mins, s: timeStr } }; }
      else {
        if (mins < d.min.m) d.min = { m: mins, s: timeStr };
        if (mins > d.max.m) d.max = { m: mins, s: timeStr };
      }
    }
    Object.keys(groups).forEach(function (key3) {
      Object.keys(groups[key3]).sort().forEach(function (date3) {
        var d3 = groups[key3][date3];
        (out[key3] = out[key3] || []).push({
          date: date3,
          timeIn: minutesToHHMM(d3.min.m),
          timeOut: d3.max.m > d3.min.m ? minutesToHHMM(d3.max.m) : ''
        });
      });
    });
    return out;
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
    importDTRCsv: importDTRCsv,
    importBiometricCsv: importBiometricCsv,
    normaliseDate: normaliseDate
  };
})(window.PH = window.PH || {});
