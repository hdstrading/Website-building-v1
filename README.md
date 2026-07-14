# PH Payroll — Offline Philippine Payroll System

A **100% offline**, browser-based payroll application built for Philippine
compliance. No installation, no server, no internet connection required — just
open `index.html` in any modern browser. All data is stored locally on your
machine.

Upload a **Daily Time Record (DTR)** and the app automatically computes basic
pay, overtime, night differential, tardiness/undertime, government
contributions, withholding tax, allowances, commissions, benefits, and loan
deductions — then generates printable payslips.

---

## ✨ Features

| Area | What it does |
|------|--------------|
| **Employee 201 File** | Full record: personal details, home address, contact, employment & regularization dates, government IDs (SSS, PhilHealth, Pag-IBIG, TIN), **bank details for salary credit**, and emergency contacts. Printable / downloadable as PDF. |
| **Work schedule** | Each employee has a shift schedule (time in / out / break). The DTR uses it to automatically detect **tardiness, undertime and overtime** from the punches — no need to key in a schedule per day. |
| **DTR entry** | Opening a period's DTR **auto-fills a row per coverage date** (rest days pre-ticked) — just enter In/Out, or tick Rest / Absent, or pick a **leave type (SL / VL / EL)**. CSV import is also supported. Computes worked hours, overtime, night differential (10 PM–6 AM), tardiness and undertime. |
| **Per-cutoff statutory deductions** | Each payroll period has independent **SSS / PhilHealth / Pag-IBIG** tick boxes, so you can deduct e.g. SSS on the 15th and PhilHealth + Pag-IBIG on the 30th. |
| **Custom overtime policy** | Configurable OT rules: a **minimum before OT counts** (e.g. the first hour must be completed), **rounding blocks** (e.g. 30 minutes), and a **grace threshold** (e.g. within 5 minutes rounds up, so a 5:58 clock-out counts as 6:00). |
| **DOLE premiums** | Applies statutory multipliers for regular OT, rest day, special non-working day, and regular holiday work (including rest-day combinations). Unworked **regular holidays** are paid 100%; special non-working days are "no work, no pay". |
| **SSS** | Monthly Salary Credit computation with employee/employer/EC split (2025 15% schedule, editable). |
| **PhilHealth** | 5% premium with income floor/ceiling, 50/50 split (editable). |
| **Pag-IBIG (HDMF)** | 1%/2% employee tiers with employer counterpart and salary cap (editable). |
| **Withholding tax** | BIR TRAIN tables — daily, weekly, semi-monthly and monthly derived automatically. |
| **Allowances & commissions** | Recurring taxable / non-taxable (de minimis) earnings, plus one-off per-period adjustments (commissions, bonuses). |
| **Loans, advances & in-house deductibles** | SSS/Pag-IBIG/company loans, **cash advances** and **product advances** (products taken from the company store), with a reference note, automatic amortization and running balance. |
| **Payslips** | Detailed stub with itemized earnings/deductions, **full DTR daily breakdown**, and a **notes section** listing deductible balances. On-screen preview and downloadable as PDF (individually or in batch). |
| **Reports** | **(A) Accounting report** — every earning & deduction itemized per employee, for the books. **(B) Finance report** — net pay + bank details per employee, for salary crediting. Both printable/PDF and CSV. |
| **Exports & backup** | Export the payroll register to CSV; back up / restore the entire database as JSON. |

---

## 🚀 Getting Started

1. **Download / clone** this repository.
2. Open **`index.html`** in a modern browser (Chrome, Edge, Firefox, Safari).
   You can literally double-click the file — no web server needed.
3. The app loads with two demo employees so you can explore immediately.

### Typical workflow

1. **Employees** → add your staff (salary, rate factor, government IDs).
2. **Allowances & Commissions** → add recurring earnings.
3. **Loans & Advances** → record any active loans.
4. **Run Payroll** → create a payroll **period**.
5. **DTR / Time** → upload the DTR CSV for that period (or key it in).
6. **Run Payroll** → review the register, open **Payslips**, add per-period
   **Adjustments** (commissions/bonuses), then **Finalize** (this saves the run
   and reduces loan balances).
7. **Reports** → generate the Accounting and Finance (salary-crediting) reports.
8. **Backup & Data** → export a JSON backup regularly.

### Downloading PDFs (payslips, 201 file, reports)

Every "Download PDF / Print" button opens a clean print view — in the print
dialog choose **"Save as PDF"** as the destination to download the file. This
keeps the app fully offline with no external libraries. Payslips can be printed
one at a time or in a batch (one per page) from **Run Payroll → Print All
Payslips**.

### In-house deductibles (cash & product advances)

Record these under **Loans & Deductibles**:
- **Cash Advance** — an advance against payroll.
- **Product Advance** — products the employee took from the company, repaid via
  salary deduction. Use the *Reference / Description* field to note the item.

Both use a total amount, a monthly amortization, and a running balance that is
automatically deducted each period and reduced on finalize. Remaining balances
also appear in the Notes section of the payslip.

---

## 📄 DTR CSV format

A sample is provided at [`samples/sample_dtr.csv`](samples/sample_dtr.csv).

| Column | Required | Notes |
|--------|----------|-------|
| `EmployeeCode` | ✅ | Must match the employee's code exactly. |
| `Date` | ✅ | e.g. `2026-07-01`. |
| `TimeIn`, `TimeOut` | – | `08:00`, `8:00 AM`, or `0800`. Blank = no punch. |
| `Break` | – | Break minutes (default 60). |
| `DayType` | – | `regular`, `special`, or `regular_holiday`. |
| `RestDay` | – | `1` / `Yes` if the day is the employee's rest day. |
| `ScheduledIn` | – | Shift start, used to compute tardiness. |
| `Absent` | – | `1` / `Yes` for an unworked, unpaid day. |
| `PaidLeave` | – | `1` / `Yes` for a paid leave day. |
| `RequiredHours` | – | Standard hours for the day (default 8). |

Column headers are matched case-insensitively and ignore spaces/punctuation, so
`Time In`, `timein`, and `TIME_IN` all work.

---

## 🧮 How pay is calculated

- **Daily rate** = monthly basic × 12 ÷ working-days factor (313 for a 6-day
  week, 261 for 5-day, 365 with rest-day pay). **Hourly rate** = daily ÷ 8.
- **Schedule-driven** tardiness, undertime and overtime: with a shift schedule
  set on the employee, time-in after the start is tardiness, time-out before the
  end is undertime, and time worked beyond the shift end is overtime.
- **Overtime rounding** follows the company policy under **Statutory Settings →
  Overtime Policy**: OT is credited only after the minimum (default 60 min) is
  completed, then in blocks (default 30 min), rounding up within a grace window
  (default 5 min — so a 5:58 clock-out is treated as 6:00 = one hour).
- **Overtime / holiday / night differential** use the DOLE multipliers in
  `assets/js/dtr.js`.
- **Contributions** are computed on the monthly basis and (for semi-monthly
  periods) can be deducted on one cut-off while skipped on the other, via the
  period's *"Deduct Contributions?"* setting.
- **Taxable income** = taxable earnings − mandatory contributions −
  tardiness/undertime; the appropriate BIR period table is then applied.
- **13th month pay** helper = total basic earned ÷ 12.

All statutory rates and tables are **editable** under **Statutory Settings** and
persist with your data.

---

## 📱 Android app (tablet-ready)

The same app is also packaged as a native **Android app** for tablets/phones —
a thin WebView wrapper around this exact offline web app. The easiest way to get
it is the built-in **GitHub Actions** build:

1. GitHub → **Actions** tab → **“Build Android APK”** → (runs on each push to
   `main`, or **Run workflow**).
2. Download the **`ph-payroll-apk`** artifact and install `app-debug.apk` on the
   tablet (allow “install unknown apps” when prompted).

Full details, local build steps, and Play Store notes are in
[`android/README.md`](android/README.md).

## 🗂️ Project structure

```
index.html                 App shell (loads scripts in order)
assets/css/styles.css       Styling
assets/js/statutory.js      SSS / PhilHealth / Pag-IBIG / BIR tax engine
assets/js/dtr.js            DTR parsing + hours & premium computation
assets/js/storage.js        Local (localStorage) persistence + backup/restore
assets/js/payroll.js        Payroll engine (ties everything together)
assets/js/ui.js             Screens, forms, payslips
assets/js/app.js            Bootstrap
samples/sample_dtr.csv      Example DTR you can import
```

No build step, no dependencies, no tracking. Everything runs in the browser.

---

## 💾 Data & privacy

Data lives in your browser's `localStorage` on **this device only**. Clearing
browser data erases it, so **export a JSON backup regularly** (Backup & Data).
To move data to another computer, export on one and import on the other.

---

## ⚠️ Important legal disclaimer

This software is provided **as-is, without warranty of any kind**, for
administrative convenience. Philippine government contribution tables and tax
rules (**SSS, PhilHealth, Pag-IBIG/HDMF, BIR**) change periodically. The
built-in defaults reflect the schedules understood to be in force for **2025**
and **must be verified** against the latest official circulars before use in
production.

This tool is **not a substitute for professional accounting, tax, or legal
advice**. The authors accept no liability for errors in computation or for
any reliance placed on its output. Always have payroll reviewed by a qualified
Philippine payroll/accounting professional.
