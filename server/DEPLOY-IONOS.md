# Deploying to IONOS

The online payroll server is a **Node.js + SQLite** app that runs in **Docker**.
On IONOS the right product is a **VPS (Virtual Private Server) or Cloud Server**
— not the managed web hosting (that's for PHP sites) and not *Deploy Now*
(aimed at static/framework sites). IONOS VPS plans support Docker and even offer
a pre‑configured Docker template.

This guide gets you a live, HTTPS URL (e.g. `https://payroll.yourcompany.com`)
in about 20 minutes. Commands are copy‑paste.

---

## 1. Create the VPS

1. IONOS control panel → **Servers & Cloud** → **Create VPS** (a small plan, ~2 GB RAM, is plenty).
2. Operating system: **Ubuntu 22.04/24.04**. If a **Docker** template is offered, pick it (skips step 4).
3. After it's created, note the **public IP address** and the **root password** (or add your SSH key).
4. In the server's **Firewall** settings, make sure inbound **TCP 22, 80 and 443** are allowed.

## 2. Point your domain at the server

In IONOS **Domains & SSL → your domain → DNS**, add an **A record**:

| Type | Host / Name | Value (points to) |
|------|-------------|-------------------|
| A | `payroll` | your VPS public IP |

That makes `payroll.yourcompany.com` resolve to the server. (DNS can take a few
minutes to propagate.)

## 3. Connect to the server

From your computer's terminal (Mac/Linux) or PowerShell (Windows):

```bash
ssh root@YOUR_SERVER_IP
```

## 4. Install Docker (skip if you used the Docker template)

```bash
curl -fsSL https://get.docker.com | sh
```

## 5. Get the code onto the server

The repo is private, so authenticate with a **GitHub Personal Access Token**
(GitHub → Settings → Developer settings → Fine-grained tokens → read access to
this repo). Then:

```bash
git clone https://github.com/hdstrading/website-building-v1.git
cd website-building-v1
```

When prompted for a password, paste the token. *(No git on the box? `apt install -y git` first.)*

## 6. Configure secrets

```bash
cp server/.env.example server/.env
nano server/.env
```

Set these values, then save (Ctrl+O, Enter, Ctrl+X):

- `JWT_SECRET` — a long random string. Generate one with:
  `openssl rand -hex 48`
- `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` — your first admin login.
- `SITE_ADDRESS` — your domain, e.g. `payroll.yourcompany.com`
  (or `:80` for a quick HTTP-only test without a domain).

## 7. Launch

```bash
docker compose up -d --build
```

Caddy automatically obtains a free HTTPS certificate for your domain. Open:

```
https://payroll.yourcompany.com
```

Sign in with the Super Admin email/password you set. Done — reachable from any
Android device or browser.

---

## Day‑to‑day

**Update to the latest version**
```bash
cd website-building-v1 && git pull && docker compose up -d --build
```

**View logs**
```bash
docker compose logs -f app
```

**Stop / start**
```bash
docker compose down          # stop
docker compose up -d         # start
```

**Backups** — the database lives in the `payroll_data` Docker volume. Two easy options:
- In the app: **Backup & Data → Export** (downloads a JSON copy).
- On the server, snapshot the volume:
  ```bash
  docker run --rm -v website-building-v1_payroll_data:/data -v $(pwd):/backup alpine \
    tar czf /backup/payroll-backup-$(date +%F).tgz -C /data .
  ```

## Automatic deploys (GitHub Actions → your VPS)

Once the server is running, you can have **every push to `main` auto-deploy**
(the `Deploy to IONOS` workflow rsyncs the code and rebuilds the containers).
It stays green and simply skips until you add these secrets.

**One-time setup:**

1. On your computer, create a dedicated deploy key (no passphrase):
   ```bash
   ssh-keygen -t ed25519 -f ionos_deploy -N "" -C "github-deploy"
   ```
2. Add the **public** key to the server so the Action can log in:
   ```bash
   ssh-copy-id -i ionos_deploy.pub root@YOUR_SERVER_IP
   # or paste the contents of ionos_deploy.pub into the server's ~/.ssh/authorized_keys
   ```
3. Make sure `rsync` is on the server: `apt install -y rsync`
4. In GitHub → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `IONOS_HOST` — your server IP or domain
   - `IONOS_USER` — e.g. `root`
   - `IONOS_SSH_KEY` — the **private** key (contents of the `ionos_deploy` file)
   - *(optional)* `IONOS_PORT` — SSH port if not 22
   - *(optional)* `IONOS_APP_DIR` — app folder if not `/root/website-building-v1`

That's it. Push to `main` (or run the workflow manually from the **Actions**
tab) and the server updates itself — no more manual `git pull`.

## Notes

- Always keep `JWT_SECRET` secret and run on HTTPS (this setup does).
- IONOS VPS gives you a fixed IP, so the domain mapping stays put.
- Prefer not to manage a server? The same app also deploys to Render in a few
  clicks — see `server/README.md`.
