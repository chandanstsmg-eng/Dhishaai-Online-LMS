# Putting DhishaAI LMS on the internet, safely (Windows Server)

Use this when students should be able to reach the site **from anywhere**, not
just the office Wi-Fi. On a public address, HTTPS is not optional: without it
every student's password is sent across the internet in clear text.

The setup is:

```
  student's browser
        │  https://lms.yourcompany.com   (encrypted)
        ▼
  Caddy  :443   ← free auto-renewing certificate
        │  http://127.0.0.1:9000         (stays inside the server)
        ▼
  DhishaAI LMS (Node)
```

The Node app is **not** exposed directly. Caddy is the only thing listening on
the public ports.

---

## 1. Prepare the domain

- Pick the address students will use, e.g. `lms.yourcompany.com`.
- In your DNS provider, add an **A record** pointing that name at the server's
  **public** IP address.
- Verify it resolves before continuing:
  ```powershell
  nslookup lms.yourcompany.com
  ```

## 2. Open the ports

On the **Windows firewall** (run PowerShell as administrator):

```powershell
New-NetFirewallRule -DisplayName "HTTP 80"  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow
New-NetFirewallRule -DisplayName "HTTPS 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
```

On the **office router**, port-forward TCP **80** and **443** to this server.

> Port 80 must stay open. Caddy uses it to prove you own the domain when it
> issues and renews the certificate.

Do **not** forward port 9000 — the app should only be reachable through Caddy.

## 3. Configure the app

In `server\.env`:

```ini
PORT=9000
NODE_ENV=production

# Long random value, different from every other machine:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=<paste the generated value>

# Required so rate limiting sees each visitor's real IP through the proxy.
TRUST_PROXY=true

# Lock the API to your own site.
CORS_ORIGIN=https://lms.yourcompany.com

# Set to false if only admins should create student accounts.
ALLOW_PUBLIC_SIGNUP=true
```

Then rotate any account still on a shipped default password:

```powershell
cd server
node set-password.js --all-defaults
node set-password.js superadmin@dhishaai.com "Your Strong Password"
```

Restart the app and confirm the startup line reads:

```
🔒 Security check: no default passwords, token secret is set.
```

## 4. Install Caddy

Download the Windows build from <https://caddyserver.com/download> and put
`caddy.exe` next to the `Caddyfile` in the project folder.

Edit the `Caddyfile` and replace `lms.yourcompany.com` with your real domain.

Test it in the foreground first:

```powershell
.\caddy.exe run --config Caddyfile
```

Open `https://lms.yourcompany.com` from a phone on mobile data (not office
Wi-Fi). You should see a padlock and no warning. Press `Ctrl+C` to stop.

## 5. Run Caddy on boot

```powershell
.\caddy.exe start --config Caddyfile
```

To survive a reboot, install it as a service. The simplest reliable route is
[NSSM](https://nssm.cc/):

```powershell
nssm install DhishaAI-Caddy "C:\path\to\caddy.exe" "run --config C:\path\to\Caddyfile"
nssm start DhishaAI-Caddy
```

Make sure the **LMS itself** also starts on boot (`Install-Autostart.bat`).

---

## Before you announce the address

- [ ] `https://` loads with a padlock, from **outside** the office network.
- [ ] `http://` redirects to `https://` automatically.
- [ ] Port 9000 is **not** reachable from the internet (only 80/443 forwarded).
- [ ] `JWT_SECRET` set, and different from any other machine.
- [ ] `node set-password.js --all-defaults` reports no defaults.
- [ ] `TRUST_PROXY=true` and `CORS_ORIGIN` set to your domain.
- [ ] Decided whether `ALLOW_PUBLIC_SIGNUP` should be `true` or `false`.
- [ ] A backup of `server\dhishaai.db`, `-wal` **and** `-shm` exists off-server.
- [ ] Each course has its admin assigned and its syllabus published.

## What is already protected

- **Login brute force** — 20 attempts per IP per 15 minutes, then HTTP 429.
- **Signup flooding** — 5 new accounts per IP per hour.
- **Weak passwords** — public sign-up requires at least 8 characters.
- **Grades** — quizzes are scored on the server; a student cannot submit their
  own score. Progress is derived, not accepted from the browser.
- **Data separation** — students only see their own progress; the leaderboard
  and forum are scoped to their batch/courses.

## What is still worth adding later

- **Email verification** on sign-up (nothing currently proves an address is real).
- **Password reset** — there is no self-service reset; an admin must run
  `set-password.js`.
- **Off-server backups on a schedule**, not just before launch.
