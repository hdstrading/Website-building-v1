# HDS Trading Payroll Solutions — Admin Operations Guide

Everyday reference for running and updating the online payroll system.

---

## 1. Where the app lives / how to update it

The payroll app runs in Docker on your IONOS server, in:

```
/root/website-building-v1
```

> ⚠️ This is **not** the same as `/opt/crm` — that folder is a different application (your CRM). Never run payroll updates there.

To update to the latest version (do this in order — **pull first, then build**):

```
cd /root/website-building-v1
git pull
docker compose up -d --build
```

- `git pull` says **"Already up to date."** → you already have the newest code. This is normal, not an error.
- `git pull` lists files → new code came down; the rebuild below applies it.

Confirm it's healthy:

```
docker compose ps
```

Both **website-building-v1-app-1** and **website-building-v1-caddy-1** should show **Up**. Then open `https://payroll.hdstradingopc.com`.

**The server must stay running** — the automatic cutoffs, reminders and draft payroll are scheduled inside the app (they run a few seconds after each start and every 6 hours).

---

## 2. Payroll cutoffs (created automatically)

Two cutoffs per month are generated automatically — you don't create them by hand:

| Salary date | Coverage (DTR period) | Pays on |
|-------------|----------------------|---------|
| **15th** | 26th of previous month → 10th of this month | 15th |
| **30th** | 11th → 25th of this month | 30th (or the last day of the month when there's no 30th, e.g. Feb 28) |

The system always keeps the current and next month's cutoffs ready.

---

## 3. The payroll cycle each cutoff

1. **Employees clock in/out** on the biometric device the whole cutoff.
2. **Day before the cutoff closes** — employees get a reminder to file any leave / overtime. Anything filed/approved after the cutoff rolls to the **next** cutoff automatically.
3. **After the cutoff closes** — the system auto-computes a **DRAFT** payroll and notifies the payroll admins.
4. **Payroll admin:**
   - Upload the latest biometric DTR CSV (DTR / Time → Import from Biometric Device).
   - Review & authorize any overtime (DTR screen → *Review & Authorize Overtime*, or employees file it and you approve).
   - Open **Run Payroll**, review the numbers, and click **Finalize**. Finalizing is what actually pays it out (decrements loans, consumes leave credits) — it is never automatic.
5. **Generate payslips & reports**, and email payslip notifications.

> Overtime is only **paid** when authorized. A biometric CSV full of late clock-outs will not pay overtime until it's approved.

---

## 4. Who can do what (roles)

| Role | Access |
|------|--------|
| **Super Admin** | Everything, plus the **History** tab (full change log: who/what/when). |
| **Admin — Payroll** | Full payroll: employees, DTR, payroll, reports, approvals, settings. |
| **Finance** | View-only admin (salary crediting / reports); cannot edit. |
| **Auditor** (3rd-party) | Read-only **Reports / 13th Month / BIR** only. No 201, no editing, no user/history access. |
| **Supervisor** | Employee portal + view-only Team DTR + approve **leave, overtime, and product advances** (not cash advances). |
| **Employee** | Portal: own 201, **view-only** DTR, file leave/overtime/loans, payslips, notifications. |

Assign roles in **Users & Access** (approve sign-ups or change a role). Auditors and other non-employees do **not** need a 201 record.

---

## 5. Security & tracking

- **Idle timeout:** anyone is signed out automatically after **5 minutes** of inactivity (portal and admin app).
- **History (Super Admin only):** every change — edits, additions, removals, approvals — is logged with the date, time, and who did it. Users & Access → **History**, with a text filter. Viewing is never logged.

---

## 6. Loans & cash advances

- **Cash & product advances** are cleared **within the month** — one cutoff, or split over two.
- **Cash advances** are for emergencies (school, medical, other quality-of-life needs); the employee must confirm this, and the total cannot exceed **half of monthly basic salary** (the option is disabled once they reach the limit).
- **SSS / Pag-IBIG loans** are spread over their monthly amortization.
- Approvals: employee applies in the portal → admin (or supervisor, for product advances) approves; the deduction then runs automatically until cleared.

---

## 7. Backups

Employee/payroll data lives in a Docker volume and survives updates. To snapshot it:

```
cd /root/website-building-v1
docker run --rm -v website-building-v1_payroll_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/payroll-backup-$(date +%F).tgz -C /data .
```

You can also export a JSON copy in-app via **Backup & Data → Export**.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `git pull` → "Already up to date" | Not an error — you have the latest. |
| Site won't load (connection refused) | Check IONOS firewall allows inbound TCP **80 & 443**; confirm the containers are **Up** (`docker compose ps`). |
| Updates don't seem to apply | Make sure you're in `/root/website-building-v1` (not `/opt/crm`), and run `git pull` **before** `docker compose up -d --build`. |
| Overtime not paid | It must be authorized for that cutoff (employee files + admin approves, or bulk-authorize on the DTR screen). |
| Automatic periods/reminders didn't fire | The app must be running; they run within seconds of a restart and every 6 hours. |
