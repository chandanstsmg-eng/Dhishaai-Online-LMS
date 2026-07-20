# Deploy DhishaAI LMS on the company server (office Wi-Fi access)

Goal: the app runs on the company server, and **every computer/phone on the
office Wi-Fi can open it** in a browser.

This works because the server listens on all network interfaces, so any device
on the **same network** (the office router — wired server + Wi-Fi clients count
as the same network) can reach it. The address everyone opens is the server's
IP, e.g. **http://192.168.1.50:9000**.

---

## One-time setup on the company server

1. **Install Node.js** (if not already): https://nodejs.org (LTS). Verify:
   ```
   node -v
   ```

2. **Get the code** (in the folder where you want it):
   ```
   git clone https://github.com/chandanstsmg-eng/Dhishaai-Online-LMS.git
   cd Dhishaai-Online-LMS
   ```

3. **Install server dependencies** (only once, and again only if deps change):
   ```
   cd server
   npm install
   cd ..
   ```

4. **Open the firewall** so other devices can connect:
   - Right-click **Allow-Firewall-Once.bat** -> **Run as administrator**.

5. **(Recommended) Auto-start on boot:**
   - Double-click **Install-Autostart.bat**.
   - Now the server launches by itself whenever the PC starts, and restarts
     automatically if it ever crashes.

6. **Security before real use — do not skip this.**

   a. **Set a real `JWT_SECRET`** in `server/.env`. It must be different from the
      one on any other machine. Generate one:
      ```
      node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
      ```

   b. **Rotate every account still on a shipped default password.** Older
      versions of this project published those passwords in the README on
      GitHub, so treat any account created before that change as compromised.
      Stop the server first, then:
      ```
      cd server
      node set-password.js --all-defaults                       :: lists unsafe accounts
      node set-password.js superadmin@dhishaai.com "Your Strong Password"
      ```
      Repeat for each account it lists, then start the server again.

   c. **Confirm it is clean.** On startup the server prints either
      `🔒 Security check: no default passwords, token secret is set.`
      or a `⚠️ SECURITY` block listing what is still wrong. **Do not let students
      or the public reach the server until you see the padlock line.**

---

## Start it (if you did NOT set auto-start)

Double-click **Run-Server-Forever.bat**. Keep the window open — it keeps the
site online and prints the Wi-Fi address to share.

---

## How people access it

On any device connected to the **same office Wi-Fi**, open a browser and go to:

```
http://<COMPANY-SERVER-IP>:9000
```

The server prints its exact address on startup. To find it manually, run
`ipconfig` on the server and use the IPv4 address (e.g. `192.168.1.50`).

Multiple users at once is fine.

---

## Updating to a new version later

```
git pull
cd server
npm install        (only if dependencies changed)
cd ..
```
Then **restart the server** (close the Run-Server-Forever window and start it
again, or just reboot if auto-start is on). Users hard-refresh their browser
(Ctrl+Shift+R).

> Backend change -> the server MUST be restarted or new features 404.
> Frontend-only change -> users just hard-refresh.

---

## Backing up (do this before you launch, then on a schedule)

The database uses SQLite in WAL mode, which means recent changes may still be
sitting in the `-wal` file. **Copying only `dhishaai.db` can silently lose the
most recent student progress.** Copy all three files together:

```
server\dhishaai.db
server\dhishaai.db-wal
server\dhishaai.db-shm
```

Safest of all: stop the server, copy `server\dhishaai.db*`, start it again.
Also copy `server\uploads\` (lesson videos) and keep a note of `server\.env`
somewhere safe — `.env` is deliberately not in git.

---

## Go-live checklist

- [ ] `git pull` done and the server **restarted** (backend changes need a restart).
- [ ] `JWT_SECRET` set in `server\.env`, different from every other machine.
- [ ] `node set-password.js --all-defaults` reports **no** default passwords.
- [ ] Startup prints `🔒 Security check: no default passwords, token secret is set.`
- [ ] Firewall opened (`Allow-Firewall-Once.bat` as administrator).
- [ ] Auto-start installed (`Install-Autostart.bat`) so a reboot brings it back.
- [ ] A backup of `server\dhishaai.db*` taken and stored off the server.
- [ ] Each course has its admin assigned and its syllabus published — a course
      with no modules honestly shows "Course content coming soon".
- [ ] If the site is reachable from **outside** the office network, put HTTPS in
      front of it (see `DEPLOY-PUBLIC-DOMAIN.md`). Without it, student passwords
      travel in clear text.

---

## Important limits

- **Same network only.** `192.168.x.x` is a private IP — reachable inside the
  office, **not** from home or mobile data. For outside-the-office access you'd
  need a static public IP/domain + router port-forwarding, or cloud hosting.
- The **server PC must stay on** for the site to be available.
- If the server's IP changes (DHCP), the address changes too. Ask IT to give
  the server a **static/reserved IP** so the address never changes.
