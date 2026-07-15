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

6. **Security before real use** (edit `server/.env`):
   - Set a real `JWT_SECRET` (any long random string).
   - Change the demo passwords (they are public in the README).

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

## Important limits

- **Same network only.** `192.168.x.x` is a private IP — reachable inside the
  office, **not** from home or mobile data. For outside-the-office access you'd
  need a static public IP/domain + router port-forwarding, or cloud hosting.
- The **server PC must stay on** for the site to be available.
- If the server's IP changes (DHCP), the address changes too. Ask IT to give
  the server a **static/reserved IP** so the address never changes.
