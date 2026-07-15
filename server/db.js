/**
 * SQLite persistence layer for DhishaAI LMS.
 *
 * Design goals:
 *   - Keep the existing in-memory `DB` object and ALL 185 query sites unchanged
 *     (reads/writes still hit fast in-memory arrays — zero API/website change).
 *   - Use SQLite as the durable, crash-safe store (WAL + atomic transactions)
 *     instead of rewriting a giant JSON file on every save.
 *   - Store uploaded file blobs (base64 PDFs) in a SEPARATE `files` table that is
 *     NEVER loaded into RAM, so the working set stays small even at 10k+ users.
 *   - Degrade gracefully: if the native better-sqlite3 binary can't load on the
 *     target server, `init()` returns false and the app falls back to JSON files
 *     (so a bad binary can never take the site down on launch day).
 *
 * Each collection is stored document-style as rows of (id, data-json). We only
 * re-write a collection when its contents actually changed, so the hot write
 * paths (quiz results, progress) don't touch large tables like `materials`.
 */
const path = require('path');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  Database = null; // native module unavailable — caller will use JSON fallback
}

// Path is overridable via env (used by tests to run against an isolated copy).
const DB_FILE = process.env.DHISHA_SQLITE || path.join(__dirname, 'dhishaai.db');

// Top-level collections that make up the in-memory DB object.
const COLLECTIONS = [
  'users', 'admins', 'courses', 'students', 'enrollments', 'quizzes',
  'quiz_results', 'progress', 'notifications', 'assignments', 'materials',
  'topics', 'forum_posts', 'batches', 'authorities', 'enroll_requests', 'projects', 'group_sessions',
];

let db = null;
let available = false;
const lastSnapshot = {}; // per-collection last serialized value, for change detection

function keyOf(item, i) {
  if (item && item.id !== undefined && item.id !== null) return String(item.id);
  return `__idx_${i}`;
}

function init() {
  if (!Database) return false;
  try {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');   // concurrent-safe, crash-safe
    db.pragma('synchronous = NORMAL'); // fast + durable enough for an LMS
    for (const c of COLLECTIONS) {
      db.prepare(`CREATE TABLE IF NOT EXISTS col_${c} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`).run();
    }
    db.prepare(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT, fileName TEXT, fileType TEXT)`).run();
    available = true;
    return true;
  } catch (e) {
    console.error('SQLite init failed:', e.message);
    db = null;
    available = false;
    return false;
  }
}

// True when the database has never been populated (fresh install).
function isEmpty() {
  if (!available) return true;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM col_users`).get();
    return !row || row.n === 0;
  } catch (e) { return true; }
}

// Load every collection into a plain object shaped exactly like the in-memory DB.
function loadAll() {
  const out = {};
  for (const c of COLLECTIONS) {
    const rows = db.prepare(`SELECT data FROM col_${c}`).all();
    const arr = rows.map(r => JSON.parse(r.data));
    out[c] = arr;
    lastSnapshot[c] = JSON.stringify(arr); // seed change-detection so first persist is a no-op
  }
  return out;
}

// Persist the in-memory DB object. Only collections whose contents changed are
// re-written, each inside a single transaction (atomic, crash-safe).
function persist(DBObj) {
  if (!available) return;
  const tx = db.transaction(() => {
    for (const c of COLLECTIONS) {
      const arr = Array.isArray(DBObj[c]) ? DBObj[c] : [];
      const serialized = JSON.stringify(arr);
      if (lastSnapshot[c] === serialized) continue; // unchanged — skip
      db.prepare(`DELETE FROM col_${c}`).run();
      const ins = db.prepare(`INSERT OR REPLACE INTO col_${c} (id, data) VALUES (?, ?)`);
      arr.forEach((item, i) => ins.run(keyOf(item, i), JSON.stringify(item)));
      lastSnapshot[c] = serialized;
    }
  });
  tx();
}

// ── File blob helpers (kept out of RAM) ──────────────────────────────────────
function putFile(id, data, fileName, fileType) {
  if (!available) return;
  db.prepare(`INSERT OR REPLACE INTO files (id, data, fileName, fileType) VALUES (?, ?, ?, ?)`)
    .run(String(id), data || null, fileName || null, fileType || null);
}
function getFile(id) {
  if (!available) return null;
  return db.prepare(`SELECT data, fileName, fileType FROM files WHERE id = ?`).get(String(id)) || null;
}
function delFile(id) {
  if (!available) return;
  db.prepare(`DELETE FROM files WHERE id = ?`).run(String(id));
}

module.exports = {
  get available() { return available; },
  DB_FILE,
  init,
  isEmpty,
  loadAll,
  persist,
  putFile,
  getFile,
  delFile,
};
