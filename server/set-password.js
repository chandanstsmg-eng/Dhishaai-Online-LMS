/**
 * Change an account's password (or list accounts).
 *
 * Seeding only ever runs on a brand-new database, so editing the seed code does
 * NOT change accounts that already exist. This script is how you change a real,
 * live account — on your PC or on the company server.
 *
 *   node set-password.js --list
 *   node set-password.js superadmin@dhishaai.com "NewStrongPassword!"
 *   node set-password.js --all-defaults          (report accounts still on a known default)
 *
 * Stop the server first if you are using SQLite, then start it again afterwards.
 */
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const store = require('./store');

// Passwords that shipped as demo defaults — anything still using one is unsafe.
const KNOWN_DEFAULTS = ['superadmin123', 'python123', 'sql123', 'powerbi123', 'ml123', 'excel123', 'student123', 'admin123'];

(async () => {
  if (!(await store.init())) {
    console.error('❌ Could not open the database. Run this from the server/ folder, after `npm install`.');
    process.exit(1);
  }
  const DB = await store.loadAll();
  const users = DB.users || [];
  const [arg1, arg2] = process.argv.slice(2);

  if (!arg1 || arg1 === '--list') {
    console.log(`\n${users.length} account(s):\n`);
    users.forEach(u => console.log(`  ${String(u.role).padEnd(11)} ${u.email}`));
    console.log('\nUsage: node set-password.js <email> "<new password>"\n');
    return;
  }

  if (arg1 === '--all-defaults') {
    const weak = users.filter(u => KNOWN_DEFAULTS.some(d => bcrypt.compareSync(d, u.password)));
    if (!weak.length) { console.log('\n✅ No account is using a known default password.\n'); return; }
    console.log(`\n⚠️  ${weak.length} account(s) still using a shipped default password:\n`);
    weak.forEach(u => console.log(`  ${String(u.role).padEnd(11)} ${u.email}`));
    console.log('\nChange each one:  node set-password.js <email> "<new password>"\n');
    return;
  }

  const email = String(arg1).toLowerCase();
  const newPw = arg2;
  if (!newPw || newPw.length < 8) {
    console.error('❌ Give a new password of at least 8 characters, in quotes.');
    process.exit(1);
  }
  const idx = users.findIndex(u => String(u.email).toLowerCase() === email);
  if (idx < 0) {
    console.error(`❌ No account with the email "${arg1}". Run --list to see them all.`);
    process.exit(1);
  }

  users[idx].password = bcrypt.hashSync(newPw, 10);
  users[idx].passwordChangedAt = new Date().toISOString();
  await store.persist(DB);
  console.log(`\n✅ Password updated for ${users[idx].email} (${users[idx].role}).`);
  console.log('   Restart the server so it reloads the database.\n');
})().catch(e => { console.error('❌ Failed:', e.message); process.exit(1); });
