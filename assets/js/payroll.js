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
      dtr = PH.dtr.computeDTR(ctx.dtrDays, r.hourly, { defaultBreak: 60 });
      // Base pay from actual worked regular hours; OT & ND added separately.
      basicPay = dtr.regularPay;
    } else {
      // No DTR: pay the period's prorated basic salary.
      basicPay = round2(r.monthlyBasic / ppm);
      dtr = { regularPay: basicPay, overtimePay: 0, nightDiffPay: 0,
        lateDeduction: 0, undertimeDeduction: 0, daysPresent: 0, daysAbsent: 0,
        paidLeaves: 0, regularMinutes: 0, otMinutes: 0, nightDiffMinutes: 0,
        lateMinutes: 0, undertimeMinutes: 0, details: [] };
    }

    // ---- Earnings -----------------------------------------------------------
    var earnings = [];
    earnings.push({ name: 'Basic Pay', amount: basicPay, taxable: true });
    if (dtr.overtimePay) earnings.push({ name: 'Overtime Pay', amount: dtr.overtimePay, taxable: true });
    if (dtr.nightDiffPay) earnings.push({ name: 'Night Differential', amount: dtr.nightDiffPay, taxable: true });

    // Recurring allowances (prorated by period, unless per-period already).
    (ctx.allowances || []).forEach(function (a) {
      var amt = a.perPeriod ? a.amount : round2(a.amount / ppm);
      if (amt) earnings.push({ name: a.name, amount: amt, taxable: !!a.taxable, kind: a.type || 'allowance' });
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

    var applyContrib = ctx.period.applyContributions !== false;
    var sssEE = applyContrib ? contrib.sss.ee : 0;
    var phEE = applyContrib ? contrib.philhealth.ee : 0;
    var piEE = applyContrib ? contrib.pagibig.ee : 0;
    var contribTotalEE = round2(sssEE + phEE + piEE);

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
      var amt = Math.min(ln.monthlyAmortization || 0, ln.balance || 0);
      // Prorate loan amortization across the month's periods.
      amt = round2(amt / ppm);
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
        employeeTotal: contribTotalEE, employerTotal: applyContrib ? contrib.employerTotal : 0,
        basis: contribBasis, applied: applyContrib
      },
      withholdingTax: withholdingTax,
      taxableBase: taxableBase,
      loanDeductions: loanDeductions,
      deductions: deductions,
      totalDeductions: totalDeductions,
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
    // Apply loan amortizations to balances.
    Object.keys(results).forEach(function (empId) {
      (results[empId].loanDeductions || []).forEach(function (ld) {
        var loan = S.find('loans', ld.id);
        if (loan) {
          loan.balance = round2(Math.max(0, (loan.balance || 0) - ld.amount));
          if (loan.balance <= 0) loan.active = false;
        }
      });
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
