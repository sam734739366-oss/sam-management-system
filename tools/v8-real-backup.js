/**
 * tools/v8-real-backup.js — make a SAFE copy of the customer's real data,
 * right now, from the machine that holds it.
 *
 * The customer says the data exists ONLY in the program on this machine.
 * So before anything else, this writes a verified, self-contained copy of
 * it to a place of the customer's choosing — a copy that opens on any
 * computer and carries no read-only mark.
 *
 * It also prints what is inside, so the customer sees the numbers and
 * knows the data is really there.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v8-real-backup.js <targetFolder>
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIVE_DIR = path.join(process.env.APPDATA || '', 'SAM Management System');
const LIVE_DB = path.join(LIVE_DIR, 'sam.db');
const TARGET = process.argv[2] || path.join(ROOT, '.tmp', 'customer-backup');

function isRO(p) {
  try {
    const line = execFileSync('attrib', [p], { encoding: 'utf8' }).split(/\r?\n/)[0];
    return (line.split(':')[0] || '').trim().includes('R');
  } catch (e) { return '?'; }
}

app.whenReady().then(async () => {
  console.log('live database:', LIVE_DB);
  if (!fs.existsSync(LIVE_DB)) {
    console.log('THERE IS NO DATABASE AT THAT PATH — nothing was copied.');
    app.exit(1);
    return;
  }
  console.log('the live file is read-only?', isRO(LIVE_DB));

  const Database = require('better-sqlite3');
  const db = new Database(LIVE_DB, { readonly: true });
  const counts = {
    items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
    documents: db.prepare('SELECT COUNT(*) c FROM documents').get().c,
    moves: db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c,
    parties: db.prepare('SELECT COUNT(*) c FROM parties').get().c,
    warehouses: db.prepare('SELECT COUNT(*) c FROM warehouses').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c
  };
  db.close();
  console.log('\nwhat is inside the real data:');
  for (const [k, v] of Object.entries(counts)) console.log('   ' + k + ': ' + v);

  fs.mkdirSync(TARGET, { recursive: true });
  const dest = path.join(TARGET, 'sam.db');

  /* the same way the program exports it: one folded, self-contained file */
  const live = new Database(LIVE_DB);
  try { live.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  await live.backup(dest);
  live.close();
  { const c = new Database(dest); try { c.pragma('journal_mode = DELETE'); } catch (e) { /* ignore */ } c.close(); }
  fs.chmodSync(dest, 0o666);

  /* verify the copy really opens and really holds the data */
  const v = new Database(dest, { readonly: true });
  const mode = v.pragma('journal_mode', { simple: true });
  const copied = {
    items: v.prepare('SELECT COUNT(*) c FROM items').get().c,
    documents: v.prepare('SELECT COUNT(*) c FROM documents').get().c,
    moves: v.prepare('SELECT COUNT(*) c FROM stock_moves').get().c
  };
  v.close();

  console.log('\nthe copy:', dest);
  console.log('   size:', fs.statSync(dest).size, 'bytes');
  console.log('   journal_mode:', mode, '(one self-contained file)');
  console.log('   read-only mark?', isRO(dest));
  console.log('   what is inside:', JSON.stringify(copied));
  const same = copied.items === counts.items && copied.documents === counts.documents && copied.moves === counts.moves;
  console.log('\nTHE COPY HOLDS THE SAME DATA AS THE ORIGINAL:', same ? 'YES' : 'NO — DO NOT TRUST IT');
  app.exit(same ? 0 : 1);
});
