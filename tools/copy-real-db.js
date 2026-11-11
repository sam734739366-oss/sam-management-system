/**
 * tools/copy-real-db.js — make a CONSISTENT copy of the live database into
 * the project's "نسخة بيانات" folder and verify the login password.
 *
 * The copy goes through SQLite's own backup API (not a file copy) so the
 * WAL is folded in and the result is never half-written.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/copy-real-db.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'نسخة بيانات');
const REAL = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'SAM Management System', 'sam.db')
  : '';

const log = (l) => { try { fs.appendFileSync(path.join(ROOT, '.tmp', 'copy-real-db.txt'), l + '\n'); } catch (e) {} console.log(l); };

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  try { fs.unlinkSync(path.join(ROOT, '.tmp', 'copy-real-db.txt')); } catch (e) {}

  if (!REAL || !fs.existsSync(REAL)) {
    log('NO LIVE DATABASE at ' + REAL);
    app.exit(1);
    return;
  }
  log('live database: ' + REAL);

  const src = new Database(REAL, { readonly: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dstPath = path.join(OUT_DIR, 'sam.db');
  for (const f of ['sam.db-wal', 'sam.db-shm']) {
    try { fs.rmSync(path.join(OUT_DIR, f), { force: true }); } catch (e) {}
  }
  await src.backup(dstPath);
  src.close();

  const dst = new Database(dstPath, { readonly: true });
  const counts = {
    users: dst.prepare('SELECT COUNT(*) c FROM users').get().c,
    warehouses: dst.prepare('SELECT COUNT(*) c FROM warehouses').get().c,
    items: dst.prepare('SELECT COUNT(*) c FROM items').get().c,
    parties: dst.prepare('SELECT COUNT(*) c FROM parties').get().c,
    documents: dst.prepare('SELECT COUNT(*) c FROM documents').get().c,
    stock_moves: dst.prepare('SELECT COUNT(*) c FROM stock_moves').get().c
  };
  const users = dst.prepare('SELECT id, username, role, is_active FROM users').all();
  dst.close();
  log('copy written: ' + dstPath);
  log('counts  : ' + JSON.stringify(counts));
  log('users   : ' + JSON.stringify(users));

  /* ---- the password check (against the COPY, not the live file) ---- */
  const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
  const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
  dbMod.init(OUT_DIR);

  /* the customer states the password of that data: make the copy carry it.
     The password is NEVER written in this file — it comes from the
     environment (SAM_COPY_PASSWORD) so it stays out of the repository. */
  const wanted = (process.env.SAM_COPY_PASSWORD || '').trim();
  if (wanted) {
    let already = false;
    try { session.login('admin', wanted); already = true; } catch (e) {}
    if (!already) {
      const admin = dbMod.getUserByUsername('admin');
      const cred = session.makeCredentials(wanted);
      dbMod.updateUser(admin.id, {
        username: admin.username, full_name: admin.full_name, role: admin.role,
        screens: admin.screens, perms: admin.perms, is_active: admin.is_active
      }, cred);
      log('the copy\'s admin password was set to the one the customer gave');
    }
  }

  /* without an explicit password we only report what the copy already holds */
  const candidates = wanted ? [wanted] : ['admin123'];
  const results = {};
  for (const p of candidates) {
    try {
      const r = session.login('admin', p);
      results[p] = r && r.username ? 'OK (' + r.role + ')' : 'wrong';
    } catch (e) {
      results[p] = 'rejected: ' + e.message;
    }
  }
  log('password ' + JSON.stringify(results));
  dbMod.close();
  app.exit(0);
}).catch((e) => { log('COPY FAILED: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
