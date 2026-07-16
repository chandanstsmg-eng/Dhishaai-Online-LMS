/**
 * Persistence backend selector.
 *
 * Default = SQLite (db.js) — zero config, exactly the behavior you have today.
 * Set DB_ENGINE=mysql (or mariadb) in server/.env to run against the company's
 * MySQL/MariaDB server instead (db-mysql.js). Both modules expose the same method
 * names, so index.js never has to care which one is active.
 */
const engine = String(process.env.DB_ENGINE || '').toLowerCase();

if (engine === 'mysql' || engine === 'mariadb') {
  console.log('🗄  Storage backend: MySQL/MariaDB (DB_ENGINE=' + engine + ')');
  module.exports = require('./db-mysql');
} else {
  module.exports = require('./db'); // SQLite (with JSON fallback) — the default
}
