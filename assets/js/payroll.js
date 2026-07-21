/* ==========================================================================
 * payroll.js — Payroll computation engine
 * --------------------------------------------------------------------------
 * Combines employee master data, DTR results, allowances/commissions, loans
 * and statutory contributions/tax into a full payslip for one pay period.
 * ========================================================================== */
(function (PH) {
  'use strict';

  var round2 = PH.statutory.round2;

  // Derive an employee's daily & hourly rate.
  function rates(emp) {
    var daily, hourly, monthlyBasic;
    var factor = emp.dailyRateFactor || 313;
    if (emp.employmentType === 'monthly') {
      monthlyBasic = emp.basicSalary || 0;
      daily = round2(monthlyBasic * 12 / factor);
      hourly = round2(daily / 8);
    } else if (emp.employmentType === 'daily') {
      daily = emp.basicSalary || 0;
      hourly = round2(daily / 8);
      monthlyBasic = round2(daily * factor / 12);
    } else { // hourly
      hourly = emp.basicSalary || 0;
      daily = round2(hourly * 8);
      monthlyBasic = round2(daily * factor / 12);
    }
    return { daily: daily, hourly: hourly, monthlyBasic: monthlyBasic };
  }

  // How many pay periods per month (for prorating contributions/tax).
  function periodsPerMonth(freq) {
    switch (freq) {
      case 'monthly': return 1;
      case 'semi-monthly': return 2;
      case 'weekly': return 52 / 12;
      case 'daily': return 313 / 12;
      default: return 1;
    }
  }

  /* Compute one employee's payslip for a period.
   * ctx = { period, dtrDays, allowances, adjustments, loans }
   */
  function computeEmployee(emp, ctx) {
    var r = rates(emp);
    var freq = ctx.period.frequency || 'semi-monthly';
    var ppm = periodsPerMonth(freq);

    // ---- Basic / worked pay -------------------------------------------------
    var dtr = null;
    var basicPay;
    if (ctx.dtrDays && ctx.dtrDays.length) {
      var otPolicy = (PH.storage.db.meta && PH.storage.db.meta.overtime) || null;
      dtr = PH.dtr.computeDTR(ctx.dtrDays, r.hourly, {
        defaultBreak: emp.schedBreakMins != null ? emp.schedBreakMins : 60,
        schedIn: emp.schedTimeIn || null,
        schedOut: emp.schedTimeOut || null,
        ot: otPolicy,
        // Overtime is paid only when authorized, if the company requires it.
        requireOtAuth: !!(otPolicy && otPolicy.requireAuthorization),
        otAuth: (PH.storage.db.otApprovals && PH.storage.db.otApprovals[emp.id]) || {}
      });
      // Base pay from actual worked regular hours; OT & ND added separately.
      basicPay = dtr.regularPay;
    } else {
      // No DTR: pay the period's prorated basic salary.
      basicPay = round2(r.monthlyBasic / ppm);
      dtr = { regularPay: basicPay, overtimePay: 0, nightDiffPay: 0,
        regularHolidayPay: 0, specialHolidayPay: 0, restDayPay: 0,
        lateDeduction: 0, undertimeDeduction: 0, daysPresent: 0, daysAbsent: 0,
        paidLeaves: 0, holidayDaysUnworked: 0, leaveDaysRequested: 0, unpaidLeaveDays: 0, leaveDays: [],
        regularMinutes: 0, otMinutes: 0, preOtMinutes: 0, otExcludedMinutes: 0, nightDiffMinutes: 0,
        lateMinutes: 0, undertimeMinutes: 0, details: [] };
    }

    // ---- Earnings -----------------------------------------------------------
    var earnings = [];
    earnings.push({ name: 'Basic Pay', amount: basicPay, taxable: true });
    // Worked premium-day pay — shown on their own lines, separate from Basic Pay.
    if (dtr.regularHolidayPay) earnings.push({ name: 'Regular Holiday Pay (worked)', amount: dtr.regularHolidayPay, taxable: true, kind: 'holiday' });
    if (dtr.specialHolidayPay) earnings.push({ name: 'Special Holiday Pay (worked)', amount: dtr.specialHolidayPay, taxable: true, kind: 'holiday' });
    if (dtr.restDayPay) earnings.push({ name: 'Rest Day Pay (worked)', amount: dtr.restDayPay, taxable: true, kind: 'holiday' });
    if (dtr.overtimePay) earnings.push({ name: 'Overtime Pay', amount: dtr.overtimePay, taxable: true });
    if (dtr.nightDiffPay) earnings.push({ name: 'Night Differential', amount: dtr.nightDiffPay, taxable: true });

    // Unworked regular-holiday pay (100% of daily rate per unworked reg. holiday).
    if (dtr.holidayDaysUnworked) {
      earnings.push({ name: 'Regular Holiday Pay (unworked, ' + dtr.holidayDaysUnworked + ' day' +
        (dtr.holidayDaysUnworked > 1 ? 's' : '') + ')',
        amount: round2(dtr.holidayDaysUnworked * r.daily), taxable: true, kind: 'holiday' });
    }

    // Service Incentive Leave: pay requested leave days, capped by remaining
    // credits. Each leave type (SL/VL/EL) shows on its own payslip line so the
    // breakdown is transparent, kept separate from basic pay.
    var leaveRemaining = Math.max(0, (emp.leaveCreditsPerYear || 0) - (emp.leaveCreditsUsed || 0));
    var leaveList = dtr.leaveDays || [];
    var paidByType = {};
    var leaveDaysPaid = 0;
    // Allocate paid days across leave types in the order they occur, up to
    // the remaining credit balance. Days beyond credits are unpaid.
    leaveList.forEach(function (ld) {
      if (leaveDaysPaid < leaveRemaining) {
        var t = ld.type || '';
        paidByType[t] = (paidByType[t] || 0) + 1;
        leaveDaysPaid++;
      }
    });
    // Fall back to the aggregate count when per-day detail is unavailable
    // (e.g. no-DTR stub or a legacy import without leaveDays).
    if (!leaveList.length && (dtr.leaveDaysRequested || 0) > 0) {
      leaveDaysPaid = Math.min(dtr.leaveDaysRequested || 0, leaveRemaining);
      if (leaveDaysPaid > 0) paidByType[''] = leaveDaysPaid;
    }
    var LEAVE_LABEL = { SL: 'Sick Leave', VL: 'Vacation Leave', EL: 'Emergency Leave', '': 'Leave' };
    ['SL', 'VL', 'EL', ''].forEach(function (t) {
      var n = paidByType[t];
      if (!n) return;
      earnings.push({ name: (LEAVE_LABEL[t] || 'Leave') + ' Pay (' + n + ' day' +
        (n > 1 ? 's' : '') + ')',
        amount: round2(n * r.daily), taxable: true, kind: 'leave' });
    });
    var leaveInfo = {
      requested: dtr.leaveDaysRequested || leaveList.length || 0,
      paid: leaveDaysPaid,
      byType: paidByType,
      unpaidAuthorized: dtr.unpaidLeaveDays || 0,   // UAL days — tracked, not paid
      creditsPerYear: emp.leaveCreditsPerYear || 0,
      remainingBefore: leaveRemaining,
      remainingAfter: leaveRemaining - leaveDaysPaid
    };

    // Recurring allowances. Basis:
    //  - 'daily'     : rate x days present in the DTR (attendance-based; excludes
    //                  absences, rest days and leave — days with no worked time)
    //  - 'perPeriod' : fixed amount each pay period
    //  - 'monthly'   : monthly amount split across the period(s)
    var daysPresent = dtr.daysPresent || 0;
    (ctx.allowances || []).forEach(function (a) {
      var basis = a.basis || (a.perPeriod ? 'perPeriod' : 'monthly');
      var amt, label = a.name;
      if (basis === 'daily') {
        amt = round2((a.amount || 0) * daysPresent);
        label = a.name + ' (' + daysPresent + ' day' + (daysPresent !== 1 ? 's' : '') + ')';
      } else if (basis === 'perPeriod') {
        amt = round2(a.amount || 0);
      } else {
        amt = round2((a.amount || 0) / ppm);
      }
      if (amt) earnings.push({ name: label, amount: amt, taxable: !!a.taxable, kind: a.type || 'allowance' });
    });
    // One-off adjustments this period (commissions, bonuses, extra allowances).
    (ctx.adjustments || []).forEach(function (a) {
      if (a.amount) earnings.push({ name: a.name, amount: round2(a.amount), taxable: !!a.taxable, kind: a.type || 'other' });
    });

    var grossPay = round2(earnings.reduce(function (s, e) { return s + e.amount; }, 0));
    var taxableEarnings = round2(earnings.filter(function (e) { return e.taxable; })
      .reduce(function (s, e) { return s + e.amount; }, 0));
    var nonTaxableEarnings = round2(grossPay - taxableEarnings);

    // ---- Statutory contributions -------------------------------------------
    // Bases are computed on the MONTHLY figure, then split across the period(s)
    // only if applyContributions is set for this period (avoid double-charging).
    var contribBasis = emp.contributionBasis === 'gross'
      ? round2(grossPay * ppm) : r.monthlyBasic;
    var contrib = PH.statutory.computeContributions(contribBasis);

    // Each contribution can be scheduled on a different cut-off, so they are
    // toggled independently per period (with migration from the old flag).
    // Effective = period is scheduled for this contribution AND the employee is
    // not opted out at the 201 level (e.g. a probationary employee within their
    // first six months). Default (undefined) means "deduct".
    var per = ctx.period;
    var legacy = per.applyContributions !== false;
    var applySSS = (per.applySSS !== undefined ? !!per.applySSS : legacy) && (emp.deductSSS !== false);
    var applyPH = (per.applyPhilHealth !== undefined ? !!per.applyPhilHealth : legacy) && (emp.deductPhilHealth !== false);
    var applyPI = (per.applyPagIBIG !== undefined ? !!per.applyPagIBIG : legacy) && (emp.deductPagIBIG !== false);
    var sssEE = applySSS ? contrib.sss.ee : 0;
    var phEE = applyPH ? contrib.philhealth.ee : 0;
    var piEE = applyPI ? contrib.pagibig.ee : 0;
    var contribTotalEE = round2(sssEE + phEE + piEE);
    var employerTotal = round2(
      (applySSS ? contrib.sss.er + contrib.sss.ec : 0) +
      (applyPH ? contrib.philhealth.er : 0) +
      (applyPI ? contrib.pagibig.er : 0));

    // ---- Withholding tax ----------------------------------------------------
    // Taxable base = taxable earnings this period − contributions this period
    // (contributions are deductible). Late/undertime reduce taxable pay.
    var lateUt = round2(dtr.lateDeduction + dtr.undertimeDeduction);
    var taxableBase = round2(taxableEarnings - contribTotalEE - lateUt);
    var withholdingTax = PH.statutory.computeWithholdingTax(taxableBase, freq);

    // ---- Loans --------------------------------------------------------------
    var loanDeductions = [];
    (ctx.loans || []).forEach(function (ln) {
      if (!ln.active || (ln.balance || 0) <= 0) return;
      var amt;
      if (ln.perCutoffAmount != null) {
        // Advances: a fixed amount is taken each cutoff (cleared within the month).
        amt = round2(Math.min(ln.perCutoffAmount, ln.balance));
      } else {
        // Monthly amortization (e.g. SSS / Pag-IBIG loans) spread across the period(s).
        amt = round2(Math.min(ln.monthlyAmortization || 0, ln.balance || 0) / ppm);
      }
      if (amt > 0) loanDeductions.push({ id: ln.id, name: ln.type, amount: amt });
    });

    // ---- Deduction assembly -------------------------------------------------
    var deductions = [];
    if (sssEE) deductions.push({ name: 'SSS', amount: sssEE });
    if (phEE) deductions.push({ name: 'PhilHealth', amount: phEE });
    if (piEE) deductions.push({ name: 'Pag-IBIG', amount: piEE });
    if (withholdingTax) deductions.push({ name: 'Withholding Tax', amount: withholdingTax });
    if (dtr.lateDeduction) deductions.push({ name: 'Tardiness', amount: dtr.lateDeduction });
    if (dtr.undertimeDeduction) deductions.push({ name: 'Undertime', amount: dtr.undertimeDeduction });
    loanDeductions.forEach(function (l) { deductions.push({ name: l.name, amount: l.amount, loanId: l.id }); });

    var totalDeductions = round2(deductions.reduce(function (s, d) { return s + d.amount; }, 0));
    var netPay = round2(grossPay - totalDeductions);

    return {
      employeeId: emp.id, employeeCode: emp.code,
      employeeName: emp.lastName + ', ' + emp.firstName,
      periodId: ctx.period.id,
      rates: r,
      dtr: dtr,
      earnings: earnings,
      grossPay: grossPay,
      taxableEarnings: taxableEarnings,
      nonTaxableEarnings: nonTaxableEarnings,
      contributions: {
        sss: contrib.sss, philhealth: contrib.philhealth, pagibig: contrib.pagibig,
        employeeTotal: contribTotalEE, employerTotal: employerTotal,
        basis: contribBasis,
        appliedSSS: applySSS, appliedPhilHealth: applyPH, appliedPagIBIG: applyPI
      },
      withholdingTax: withholdingTax,
      taxableBase: taxableBase,
      loanDeductions: loanDeductions,
      deductions: deductions,
      totalDeductions: totalDeductions,
      leave: leaveInfo,
      employmentStatus: emp.employmentStatus || '',
      netPay: netPay
    };
  }

  /* Run payroll for all (active) employees in a period. */
  function runPeriod(period) {
    var S = PH.storage;
    var results = {};
    var dtrForPeriod = (S.db.dtr[period.id]) || {};
    var adjForPeriod = (S.db.adjustments[period.id]) || {};
    S.list('employees').filter(function (e) { return e.active !== false; }).forEach(function (emp) {
      var ctx = {
        period: period,
        dtrDays: dtrForPeriod[emp.id] || null,
        allowances: S.list('allowances').filter(function (a) { return a.employeeId === emp.id; }),
        adjustments: adjForPeriod[emp.id] || [],
        loans: S.list('loans').filter(function (l) { return l.employeeId === emp.id; })
      };
      results[emp.id] = computeEmployee(emp, ctx);
    });
    return results;
  }

  /* Finalize: persist results and decrement loan balances. */
  function finalizePeriod(period) {
    var S = PH.storage;
    var results = runPeriod(period);
    S.db.payrolls[period.id] = results;
    // Apply loan amortizations to balances, and consume used leave credits.
    Object.keys(results).forEach(function (empId) {
      (results[empId].loanDeductions || []).forEach(function (ld) {
        var loan = S.find('loans', ld.id);
        if (loan) {
          loan.balance = round2(Math.max(0, (loan.balance || 0) - ld.amount));
          if (loan.balance <= 0) loan.active = false;
        }
      });
      var lv = results[empId].leave;
      if (lv && lv.paid > 0) {
        var emp = S.find('employees', empId);
        if (emp) emp.leaveCreditsUsed = (emp.leaveCreditsUsed || 0) + lv.paid;
      }
    });
    period.status = 'finalized';
    S.upsert('periods', period);
    S.save();
    return results;
  }

  // 13th month pay = total basic salary earned in the year / 12.
  function thirteenthMonth(totalBasicEarned) {
    return round2((totalBasicEarned || 0) / 12);
  }

  PH.payroll = {
    rates: rates,
    periodsPerMonth: periodsPerMonth,
    computeEmployee: computeEmployee,
    runPeriod: runPeriod,
    finalizePeriod: finalizePeriod,
    thirteenthMonth: thirteenthMonth
  };
})(window.PH = window.PH || {});
