# Deploying DhishaAI LMS to a public domain (with MySQL)

This guide takes the app from "runs on the office LAN" to a **public website**
(`https://lms.yourcompany.com`) backed by your **company MySQL database**, hosted on
your existing company server.

There are 4 parts. Parts A–B are the app (you can do these). Parts C–D need whoever
controls your company's **internet connection, domain, and firewall** (usually IT).

---

## A. Point the app at your MySQL database

1. **Create an empty database + a user** on your MySQL/MariaDB server (ask your DB
   admin, or run in MySQL):

   ```sql
   CREATE DATABASE dhishaai_lms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'dhishaai'@'%' IDENTIFIED BY 'a-strong-password-here';
   GRANT ALL PRIVILEGES ON dhishaai_lms.* TO 'dhishaai'@'%';
   FLUSH PRIVILEGES;
   ```

2. **Install dependencies** (adds the MySQL driver) and set up config:

   ```bash
   cd server
   npm install
   copy .env.example .env       # (Linux/mac: cp .env.example .env)
   ```

3. **Edit `server/.env`** — fill in your database details and turn MySQL on:

   ```ini
   DB_ENGINE=mysql
   MYSQL_HOST=your-db-host        # e.g. 192.168.1.60 or db.internal
   MYSQL_PORT=3306
   MYSQL_USER=dhishaai
   MYSQL_PASSWORD=a-strong-password-here
   MYSQL_DATABASE=dhishaai_lms
   # (or instead of the 5 lines above: MYSQL_URL=mysql://dhishaai:pass@host:3306/dhishaai_lms)

   JWT_SECRET=<a long random string — CHANGE THIS>
   PORT=9000
   ```

4. **Copy your existing data** (users, courses, materials, everything) from the
   current SQLite database into MySQL — run once:

   ```bash
   node migrate-sqlite-to-mysql.js
   ```

   You'll see it list each collection and the number of rows/files copied.
   (Skip this step if you're starting fresh — the app will seed demo data on first run.)

5. **Start the server** — it should now say `✅ Database loaded from MySQL ...`:

   ```bash
   node index.js
   ```

   > If MySQL can't be reached, the app prints an error and falls back to local
   > storage instead of crashing — so check the startup log says **MySQL**.

**To switch back to SQLite** at any time: set `DB_ENGINE=sqlite` in `.env` and restart.

---

## B. Keep it running as a service (auto-restart, starts on boot)

Right now you start it by hand. For a real site it must restart on crash and on reboot.
On this Windows server you already have helper scripts in the project root:

- **`Install-Autostart.bat`** (run as Administrator) — makes the server start
  automatically when Windows boots.
- **`Run-Server-Forever.bat`** — keeps it running and restarts it if it stops.

(If you prefer a proper Windows service, install **NSSM** and point it at
`node index.js` in the `server` folder — ask if you want steps for that.)

---

## C. Put HTTPS in front of it  ⚠️ required for a public site

Never expose the Node app directly to the internet on port 9000. Put a **reverse
proxy** in front that terminates HTTPS (the padlock) and forwards to the app.

The simplest on Windows is **[Caddy](https://caddyserver.com/)** — it gets and renews
a **free SSL certificate automatically**. Install Caddy, then create a file named
`Caddyfile` (no extension) next to it:

```
lms.yourcompany.com {
    reverse_proxy 127.0.0.1:9000
}
```

Run `caddy run` (or install it as a service). That's it — Caddy serves
`https://lms.yourcompany.com` and forwards to your app. Certificates auto-renew.

> Alternatives: **IIS** with the URL Rewrite + ARR modules, or **nginx**. Caddy is by
> far the least fuss for auto-HTTPS.

---

## D. Domain + public access  (your IT / network team)

These changes are on your company's network gear — I can't make them from the app:

1. **DNS:** create an `A` record for `lms.yourcompany.com` pointing at your company's
   **public IP address**.
2. **Firewall / router (NAT):** forward inbound **TCP 443** (and 80, for the certificate
   check) from the internet to this server's internal IP (`192.168.1.50`).
3. **Windows Firewall on the server:** allow inbound 443 and 80 (Caddy handles those;
   the app's 9000 stays internal-only — do **not** forward 9000 to the internet).

> 🔒 **Security note:** this server sits inside your office network. Exposing it to the
> internet means a compromise could reach other office systems. Ask IT to place it in a
> **DMZ** (isolated network segment) if possible, and keep only 443/80 open to the world.

---

## E. Before you go live — security checklist

- [ ] `JWT_SECRET` in `.env` changed to a long random string (not the placeholder), and
      **different from the one on any other machine**. Generate one with:
      `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- [ ] **No account left on a shipped default password.** Check and fix on the server:
      ```bash
      cd server
      node set-password.js --all-defaults
      node set-password.js superadmin@dhishaai.com "New Strong Pw"
      ```
      The server also prints a warning on every boot while any default remains.
      (Older README versions published these passwords on GitHub, so treat any
      account created before this change as compromised until rotated.)
- [ ] `.env` is **not** committed to git (it's already in `.gitignore` — keep it that way).
- [ ] MySQL user has a strong password and is **not** reachable from the public internet
      (only from the app server).
- [ ] Take a **backup** of the MySQL database on a schedule (e.g. `mysqldump` nightly).
- [ ] HTTPS works (`https://lms.yourcompany.com` shows a padlock, no warning).

---

## Quick reference — what runs where

| Piece                     | Where                        | Port (internet-facing?) |
|---------------------------|------------------------------|--------------------------|
| Caddy (HTTPS reverse proxy) | company server (192.168.1.50) | 443, 80 — **yes** |
| Node app (`index.js`)     | company server (127.0.0.1)   | 9000 — **no, internal**  |
| MySQL database            | company DB server            | 3306 — **no, internal**  |
