/**
 * One-time data migration: copy everything from the existing SQLite database
 * (server/dhishaai.db) into the MySQL/MariaDB server configured in server/.env.
 *
 * Safe to run more than once — it overwrites the MySQL tables with the current
 * SQLite contents each time (it does NOT merge). Run it AFTER you've set the
 * MYSQL_* values in .env, and BEFORE you switch DB_ENGINE=mysql for live use:
 *
 *     cd server
 *     node migrate-sqlite-to-mysql.js
 *
 * It copies every collection AND all uploaded file blobs (the `files` table).
 */
require('dotenv').config();
const path = require('path');

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('❌ better-sqlite3 not installed. Run "npm install" in server/ first.'); process.exit(1); }

const mysqlStore = require('./db-mysql');

const SQLITE_FILE = process.env.DHISHA_SQLITE || path.join(__dirname, 'dhishaai.db');

(async () => {
  // 1. Open the existing SQLite database read-only.
  const fs = require('fs');
  if (!fs.existsSync(SQLITE_FILE)) {
    console.error(`❌ SQLite file not found at ${SQLITE_FILE}. Nothing to migrate.`);
    process.exit(1);
  }
  const sdb = new Database(SQLITE_FILE, { readonly: true });
  console.log('📂 Reading SQLite:', SQLITE_FILE);

  // 2. Connect to MySQL (creates tables if missing).
  const okConn = await mysqlStore.init();
  if (!okConn) {
    console.error('❌ Could not connect to MySQL. Check the MYSQL_* values in server/.env.');
    process.exit(1);
  }
  console.log('🔌 Connected to', mysqlStore.DB_FILE);

  // 3. Build the in-memory DB object from every col_* table in SQLite.
  const colTables = sdb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'col\\_%' ESCAPE '\\'"
  ).all().map(r => r.name);

  const DBObj = {};
  let totalDocs = 0;
  for (const table of colTables) {
    const coll = table.replace(/^col_/, '');
    const rows = sdb.prepare(`SELECT data FROM ${table}`).all();
    DBObj[coll] = rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
    totalDocs += DBObj[coll].length;
    console.log(`   • ${coll}: ${DBObj[coll].length} rows`);
  }

  // 4. Write all collections to MySQL (one atomic transaction per collection).
  await mysqlStore.persist(DBObj);
  console.log(`✅ Migrated ${totalDocs} documents across ${colTables.length} collections.`);

  // 5. Copy uploaded file blobs (the `files` table), if present.
  let fileCount = 0;
  try {
    const hasFiles = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").get();
    if (hasFiles) {
      const files = sdb.prepare('SELECT id, data, fileName, fileType FROM files').all();
      for (const f of files) {
        await mysqlStore.putFile(f.id, f.data, f.fileName, f.fileType);
        fileCount++;
      }
    }
  } catch (e) { console.warn('⚠  File blob copy issue:', e.message); }
  console.log(`✅ Migrated ${fileCount} uploaded file blob(s).`);

  sdb.close();
  console.log('\n🎉 Done. Now set DB_ENGINE=mysql in server/.env and restart the server.');
  process.exit(0);
})().catch(err => { console.error('❌ Migration failed:', err); process.exit(1); });
