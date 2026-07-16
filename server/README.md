# PH Payroll — Online (multi-user) edition

An online, multi-user version of the payroll app that runs on a server so it's
reachable from **any Android device or browser**. It reuses the exact same
payroll engine and admin UI as the offline app, adding accounts, **role-based
access**, and an **employee self-service portal**.

> The offline single-file app (repo root) still works unchanged. This server is
> a separate, optional deployment for teams that want a shared online system.

## Roles & access

| Role | Can do |
|------|--------|
| **Super Admin** | Everything, incl. approving users and assigning roles. |
| **Admin — Payroll** | Full payroll app (employees, DTR, runs, reports), approve users & leave. |
| **Finance** | Opens the full app **view-only** (for reports / salary crediting); cannot edit. |
| **Employee** | Personal portal only: view 201, view payslips, submit own DTR, file leave. |

## Sign-up flow (self-register + approval)

1. The first **Super Admin** is created from `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` on first boot.
2. Employees **register themselves** and fill in their **201 details** — their account stays *pending*.
3. A Super Admin / Payroll Admin **approves** the account, which can auto-create the employee's 201 record and set their role.
4. Approved users sign in; admins land on the payroll app, employees on the portal.

## Run locally

```bash
cd server
cp .env.example .env          # then edit the values
npm install
npm start                     # http://localhost:3000
```

Open `http://localhost:3000`, sign in as the Super Admin, and go.

## Deploy online

### Option A — Render (easiest, free tier)
1. Push this repo to GitHub (already done).
2. In Render: **New → Blueprint**, select this repo (it reads `render.yaml`).
3. Set **SUPERADMIN_EMAIL** and **SUPERADMIN_PASSWORD** when prompted (JWT_SECRET is generated).
4. Deploy. You'll get a public `https://…onrender.com` URL to open on any device.

The SQLite database is stored on a **1 GB persistent disk** mounted at `/data`, so data survives restarts and redeploys.

### Option B — IONOS (VPS with Docker)
A full step-by-step guide (create the VPS, point your domain, one-command launch
with automatic HTTPS) is in **[`DEPLOY-IONOS.md`](DEPLOY-IONOS.md)**. It uses the
`docker-compose.yml` + `Caddyfile` at the repo root.

### Option C — Docker (any host / your own server)

```bash
# build from the REPO ROOT (so the shared engine is included)
docker build -f server/Dockerfile -t ph-payroll .
docker run -d -p 3000:3000 \
  -e JWT_SECRET="$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))')" \
  -e SUPERADMIN_EMAIL=admin@yourcompany.com \
  -e SUPERADMIN_PASSWORD=a-strong-password \
  -v ph_payroll_data:/data \
  ph-payroll
```

Put it behind HTTPS (a reverse proxy like Caddy/Nginx, or the platform's built-in TLS) before real use.

## The Android app

Point the tablet app at your deployed URL — either open it in the browser and
"Add to Home screen", or update the WebView app to load the hosted URL instead
of the bundled files (say the word and I'll switch the APK to online mode).

## Security notes

- Passwords are hashed with **bcrypt**; sessions are signed **JWT** in httpOnly cookies.
- **Always set a strong `JWT_SECRET`** and run behind **HTTPS** in production.
- Role checks are enforced **server-side** (the UI only hides what a role can't use).

## API (summary)

- `POST /api/auth/register|login|logout`, `GET /api/auth/me`
- `GET/PUT /api/company` — full company data (admins; PUT is Super Admin / Payroll only)
- `GET /api/admin/users`, `POST /api/admin/users/:id/approve|role|status`
- `GET /api/admin/leave-requests`, `POST /api/admin/leave-requests/:id`
- `GET /api/me/profile|payslips|periods|leave`, `POST /api/me/leave`, `GET/POST /api/me/dtr/:periodId`
