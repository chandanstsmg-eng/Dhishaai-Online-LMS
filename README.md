# 🎓 DhishaAI Online LMS

A full-stack Learning Management System for DhishaAI Complete Analytics — courses,
modules, quizzes (with time limits & anti-cheat), study materials, batches,
leaderboards, and multi-role admin management.

- **Frontend:** React 18 + Vite (pre-built into `client/dist`)
- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`), with automatic JSON-file fallback

---

## ✅ Prerequisites

- **Node.js 18 or newer** — download from https://nodejs.org (LTS). Check with `node -v`.
- **npm** (comes with Node).

> No database server to install — SQLite is embedded and the database file is created
> automatically on first run.

---

## 🚀 Quick Start (run the app)

```bash
# 1. Clone
git clone https://github.com/chandanstsmg-eng/Dhishaai-Online-LMS.git
cd Dhishaai-Online-LMS

# 2. Install backend dependencies (this also builds the SQLite engine for your OS)
cd server
npm install

# 3. Create your config from the template, then edit it
#    Windows:  copy .env.example .env
#    Linux/mac: cp .env.example .env
cp .env.example .env

# 4. Start the server
node index.js
```

Then open the URL printed in the console (e.g. **http://localhost** on port 80, or
**http://localhost:3000** if you set `PORT=3000`).

> The frontend is already built into `client/dist`, so you do **not** need to install
> or build the client just to run the app.

---

## 🔐 Demo Login Credentials

On first run the database is seeded with these accounts:

| Role            | Email                     | Password       |
|-----------------|---------------------------|----------------|
| 👑 Super Admin  | superadmin@dhishaai.com   | superadmin123  |
| 🐍 Python Admin | priya@dhishaai.com        | python123      |
| 🗄️ SQL Admin    | ravi@dhishaai.com         | sql123         |
| 📊 BI Admin     | divya@dhishaai.com        | powerbi123     |
| 🤖 ML Admin     | anil@dhishaai.com         | ml123          |
| 📋 Excel Admin  | suma@dhishaai.com         | excel123       |
| 🎓 Student      | rahul@email.com           | student123     |

> **Change these passwords after first login** for any real deployment.

---

## ⚙️ Configuration (`server/.env`)

| Variable     | Meaning                                                        |
|--------------|----------------------------------------------------------------|
| `PORT`       | Port the server listens on. `80` = `http://your-server`.       |
| `JWT_SECRET` | Secret for signing login tokens — **set a long random value**. |
| `NODE_ENV`   | `production` or `development`.                                  |

`.env` is **git-ignored** (it holds a secret). Always create it from `.env.example`.
Without a `.env`, the server still runs with safe defaults (port 9000).

---

## 🛠️ Developing the Frontend

The React source lives in `client/src`. After changing it, rebuild the bundle the
server serves:

```bash
cd client
npm install
npm run build      # outputs to client/dist (committed to the repo)
```

For a live dev server with hot reload:

```bash
cd client
npm run dev        # Vite dev server (proxies /api to the backend)
```

---

## 🏢 Production Deployment (Linux server)

```bash
# 1. Get the code and install backend deps
git clone https://github.com/chandanstsmg-eng/Dhishaai-Online-LMS.git
cd Dhishaai-Online-LMS/server
npm install
cp .env.example .env      # then edit PORT + JWT_SECRET

# 2. Port 80 needs root
sudo node index.js

# 3. Keep it running with PM2 (restarts on crash / reboot)
sudo npm install -g pm2
sudo pm2 start index.js --name dhishaai-lms
sudo pm2 save
sudo pm2 startup

# 4. Open the firewall
sudo ufw allow 80
```

Access at **http://your-server-ip**.

> **Database:** On first start the server creates `server/dhishaai.db` (SQLite). That
> file becomes your live database — **back it up**, and it is intentionally git-ignored
> so real data / student info is never pushed to the repo. Uploaded PDFs are stored
> inside it, not in RAM, so it scales to many users.

---

## 📁 Project Structure

```
Dhishaai-Online-LMS/
├── server/                 # Express backend (the app runs from here)
│   ├── index.js            # All API routes + serves the built frontend
│   ├── db.js               # SQLite persistence layer (+ JSON fallback)
│   ├── .env.example        # Copy to .env
│   └── package.json
├── client/                 # React frontend
│   ├── src/App.jsx         # The whole UI
│   ├── dist/               # Pre-built bundle the server serves (committed)
│   └── package.json
├── start.js / START.bat / start.sh   # Convenience launchers
└── README.md
```

---

## 🧯 Troubleshooting

**`git` / `node` not recognized** → install from https://git-scm.com and https://nodejs.org, reopen the terminal.

**`EACCES: permission denied` on port 80 (Linux)** → run with `sudo`, or pick another port in `.env` (e.g. `PORT=3000`).

**`better-sqlite3` install error** → make sure Node 18+ is installed, then re-run `npm install` inside `server/`. If it still fails the app falls back to a JSON file automatically.

**Port already in use**
```bash
# Windows
netstat -ano | findstr :80
taskkill /PID <number> /F
# Linux/mac
sudo lsof -ti:80 | xargs kill -9
```

**Changes not showing in the browser** → hard-refresh with `Ctrl + Shift + R`, and make sure you restarted the server after editing.

---

📧 admin@dhishaai.com · 🌐 www.dhishaai.com · © DhishaAI Complete Analytics, Bengaluru
