/**
 * MySQL / MariaDB persistence layer for DhishaAI LMS.
 *
 * This is a drop-in sibling of db.js (the SQLite layer). It exposes the SAME method
 * names so the rest of the app never changes — the only difference is these methods
 * are async (MySQL's driver is Promise-based). The app already awaits them, and
 * awaiting SQLite's synchronous returns is a harmless no-op, so a single code path
 * serves both backends.
 *
 * Design (identical philosophy to db.js):
 *   - Each collection is stored document-style: rows of (id, JSON data) in col_<name>.
 *   - Uploaded file blobs live in a SEPARATE `files` table, never loaded into RAM.
 *   - We only re-write a collection when its contents actually changed (snapshot
 *     comparison), so hot write paths (quiz results, progress) stay cheap.
 *   - persist() calls are serialized through an internal promise chain so two
 *     debounced flushes can never interleave and corrupt a collection.
 *   - If the DB can't be reached at startup, init() returns false and the caller
 *     falls back to JSON files — a bad DB can never take the site down on launch.
 *
 * Connection config comes from env (put these in server/.env):
 *   MYSQL_URL=mysql://user:pass@host:3306/dbname        (one-line form)
 *   — or the individual pieces —
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 */
let mysql = null;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  mysql = null; // driver not installed — caller will fall back to SQLite/JSON
}

// Same collections as db.js — keep the two lists in sync.
const COLLECTIONS = [
  'users', 'admins', 'courses', 'students', 'enrollments', 'quizzes',
  'quiz_results', 'progress', 'notifications', 'assignments', 'materials',
  'topics', 'forum_posts', 'batches', 'authorities', 'enroll_requests',
  'projects', 'group_sessions', 'lesson_videos', 'activity', 'certificates',
];

let pool = null;
let available = false;
const lastSnapshot = {}; // per-collection last serialized value, for change detection

function keyOf(item, i) {
  if (item && item.id !== undefined && item.id !== null) return String(item.id);
  return `__idx_${i}`;
}

function poolConfig() {
  const common = {
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 10),
    dateStrings: true,
    // NOTE: max packet size (for multi-MB base64 file blobs) is a SERVER setting
    // (max_allowed_packet). MySQL 8 defaults to 64MB; if you store large files on
    // an older server, raise it there. Uploads are capped at ~5MB so 16MB is enough.
  };
  // If a full connection URL is given, parse it into fields so it merges cleanly
  // with the pool options above (mysql2's config object has no "uri" key).
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: decodeURIComponent(u.hostname),
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username || 'root'),
        password: decodeURIComponent(u.password || ''),
        database: decodeURIComponent((u.pathname || '').replace(/^\//, '')) || 'dhishaai_lms',
        ...common,
      };
    } catch (e) {
      console.error('Invalid MYSQL_URL, falling back to MYSQL_* fields:', e.message);
    }
  }
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'dhishaai_lms',
    ...common,
  };
}

// A short human-readable description for startup logs (never includes the password).
function describe() {
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `MySQL ${u.host}${u.pathname}`; } catch { return 'MySQL'; } }
  return `MySQL ${process.env.MYSQL_HOST || '127.0.0.1'}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || 'dhishaai_lms'}`;
}

async function init() {
  if (!mysql) { console.error('MySQL driver (mysql2) not installed — run "npm install" in server/.'); return false; }
  try {
    pool = mysql.createPool(poolConfig());
    const conn = await pool.getConnection();
    try {
      for (const c of COLLECTIONS) {
        await conn.query(
          `CREATE TABLE IF NOT EXISTS col_${c} (id VARCHAR(191) PRIMARY KEY, data LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
      }
      await conn.query(
        `CREATE TABLE IF NOT EXISTS files (id VARCHAR(191) PRIMARY KEY, data LONGTEXT, fileName VARCHAR(512), fileType VARCHAR(255)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
    } finally { conn.release(); }
    available = true;
    return true;
  } catch (e) {
    console.error('MySQL init failed:', e.message);
    pool = null;
    available = false;
    return false;
  }
}

// True when the database has never been populated (fresh install).
async function isEmpty() {
  if (!available) return true;
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM col_users');
    return !rows[0] || Number(rows[0].n) === 0;
  } catch (e) { return true; }
}

// Load every collection into a plain object shaped exactly like the in-memory DB.
async function loadAll() {
  const out = {};
  for (const c of COLLECTIONS) {
    const [rows] = await pool.query(`SELECT data FROM col_${c}`);
    const arr = rows.map(r => {
      try { return JSON.parse(r.data); } catch { return null; }
    }).filter(x => x !== null);
    out[c] = arr;
    lastSnapshot[c] = JSON.stringify(arr); // seed change-detection so first persist is a no-op
  }
  return out;
}

// Persist the in-memory DB object. Only collections whose contents changed are
// re-written, each inside its own transaction. Calls are serialized so overlapping
// debounced flushes can't corrupt a table.
let _chain = Promise.resolve();
function persist(DBObj) {
  _chain = _chain.then(() => _persist(DBObj)).catch(e => console.error('MySQL persist error:', e.message));
  return _chain;
}
async function _persist(DBObj) {
  if (!available) return;
  for (const c of COLLECTIONS) {
    const arr = Array.isArray(DBObj[c]) ? DBObj[c] : [];
    const serialized = JSON.stringify(arr);
    if (lastSnapshot[c] === serialized) continue; // unchanged — skip
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM col_${c}`);
      const rows = arr.map((item, i) => [keyOf(item, i), JSON.stringify(item)]);
      // Insert in batches so a huge collection can't exceed max_allowed_packet.
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await conn.query(`INSERT INTO col_${c} (id, data) VALUES ?`, [chunk]);
      }
      await conn.commit();
      lastSnapshot[c] = serialized;
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }
}

// ── File blob helpers (kept out of RAM) ──────────────────────────────────────
async function putFile(id, data, fileName, fileType) {
  if (!available) return;
  await pool.query(
    `INSERT INTO files (id, data, fileName, fileType) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), fileName = VALUES(fileName), fileType = VALUES(fileType)`,
    [String(id), data || null, fileName || null, fileType || null]
  );
}
async function getFile(id) {
  if (!available) return null;
  const [rows] = await pool.query('SELECT data, fileName, fileType FROM files WHERE id = ?', [String(id)]);
  return rows[0] || null;
}
async function delFile(id) {
  if (!available) return;
  await pool.query('DELETE FROM files WHERE id = ?', [String(id)]);
}

module.exports = {
  get available() { return available; },
  get DB_FILE() { return describe(); },
  COLLECTIONS,
  init,
  isEmpty,
  loadAll,
  persist,
  putFile,
  getFile,
  delFile,
};
