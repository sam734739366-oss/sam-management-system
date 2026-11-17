/**
 * tools/v8-customer-check.js — the customer's story, proven fixed.
 *
 * HIS WORDS:
 *   "the program works normally when installed with no data inside it.
 *    I took a copy of the data from the program installed on this device,
 *    and when I restored it on the other computer it refused the data and
 *    this problem appeared. Before, the export produced three files and
 *    restoring them worked fine. Then you made the data file one file."
 *
 * THE MECHANISM (proved, not guessed):
 *   1 — a file that travels between machines keeps the Windows READ-ONLY
 *       mark (copyFileSync and cpSync both carry it over);
 *   2 — the RESTORE copied that marked file straight onto the live
 *       database — so the program inherited the mark;
 *   3 — the next launch died at the first write:
 *       «attempt to write a readonly database» at db.js:302 in migrate().
 *
 * THE FIX, proven here:
 *   A — the exported file is folded (journal_mode = DELETE) and carries no
 *       read-only mark, so it travels anywhere and opens anywhere;
 *   B — the restore lifts the mark on the copy it works on, and on the
 *       live database after the swap — so a restore can never poison it;
 *   C — a program that already inherited the mark repairs itself at
 *       startup and opens with ALL its data.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v8-customer-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MACHINE_A = path.join(ROOT, '.tmp', 'cust-a');     /* the good one */
const MACHINE_B = path.join(ROOT, '.tmp', 'cust-b');     /* the broken one */
const USB = path.join(ROOT, '.tmp', 'cust-usb');          /* the stick in between */

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

function isRO(p) {
  try {
    const line = execFileSync('attrib', [p], { encoding: 'utf8' }).split(/\r?\n/)[0];
    return (line.split(':')[0] || '').trim().includes('R');
  } catch (e) { return '?'; }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
const datadir = require(path.join(ROOT, 'src', 'main', 'datadir.js'));
const restore = require(path.join(ROOT, 'src', 'main', 'restore.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const writable = require(path.join(ROOT, 'src', 'main', 'writable.js'));

function fakeApp(dir) {
  return {
    getPath(which) {
      if (which === 'userData') return dir;
      if (which === 'appData') return path.dirname(dir);
      if (which === 'documents') return path.join(ROOT, '.tmp', 'cust-docs');
      if (which === 'temp') return path.join(ROOT, '.tmp', 'cust-temp');
      return dir;
    }
  };
}

app.whenReady().then(async () => {
  rmrf(MACHINE_A); rmrf(MACHINE_B); rmrf(USB);
  fs.mkdirSync(MACHINE_A, { recursive: true });
  fs.mkdirSync(MACHINE_B, { recursive: true });
  fs.mkdirSync(USB, { recursive: true });

  /* ================= MACHINE A — where the data lives ================= */
  console.log('\n=== MACHINE A — the computer that holds the data ===');
  process.env.SAM_DATA_DIR = MACHINE_A;
  db.init(MACHINE_A);
  session.ensureSeed();
  const wh = db.addWarehouse({ code: 'W1', name: 'مخزن Raw', location: '' });
  db.addItem({ code: 'R-1', name: 'خامة العميل', base_unit: 'حبة', pieces_per_carton: 12 },
    [{ warehouseId: wh.id, good: 5000 }]);
  db.addItem({ code: 'B-1', name: 'علبة جاهزة', base_unit: 'حبة', pieces_per_bag: 20 },
    [{ warehouseId: wh.id, good: 800 }]);
  db.addParty({ name: 'عميل النفخ', type: 'customer', phone: '771111111' });
  fs.mkdirSync(path.join(MACHINE_A, 'images'), { recursive: true });
  fs.writeFileSync(path.join(MACHINE_A, 'images', 'R-1.png'), 'PHOTO-BYTES');
  const itemsOnA = db.listItems().length;
  check('machine A holds the real data', itemsOnA === 2, { items: itemsOnA });

  /* ================= THE EXPORT — one file, safe to carry ================= */
  console.log('\n=== THE EXPORT — one file the customer carries ===');
  const exported = await datadir.exportTo(fakeApp(MACHINE_A), USB, db.dbFile());
  const file = exported.path;
  console.log('   exported:', file, 'size=' + exported.size);
  check('the export is ONE file', exported.files === 1 && fs.readdirSync(USB).length === 1,
    { files: fs.readdirSync(USB) });
  check('the exported file carries NO read-only mark', isRO(file) === false, { readOnly: isRO(file) });
  {
    const Database = require('better-sqlite3');
    const h = new Database(file, { readonly: true });
    const mode = h.pragma('journal_mode', { simple: true });
    const n = h.prepare('SELECT COUNT(*) AS c FROM items').get().c;
    h.close();
    check('the exported file is SELF-CONTAINED (no -wal needed)', mode !== 'wal', { journal_mode: mode, items: n });
    check('the exported file holds all the items', n === 2, { items: n });
  }

  /* ================= THE TRANSFER — the mark rides along ================= */
  console.log('\n=== THE TRANSFER — USB / network / archive ===');
  fs.chmodSync(file, 0o444);
  check('the file arrives on the other computer marked read-only', isRO(file) === true);

  /* ================= MACHINE B — the fresh install ================= */
  console.log('\n=== MACHINE B — the fresh install, then the restore ===');
  process.env.SAM_DATA_DIR = MACHINE_B;
  db.close();
  db.init(MACHINE_B);
  session.ensureSeed();
  check('the fresh install works with no data', db.listItems().length === 0);

  let restoreError = null;
  try {
    const r = await restore.restoreFrom(file, { relaunch: false });
    console.log('   the restore returned:', JSON.stringify({ ok: r.ok, items: r.items }));
  } catch (e) {
    restoreError = e;
    console.log('   THE RESTORE FAILED:', e.message);
  }
  check('the restore ACCEPTS the data', !restoreError, restoreError && restoreError.message);
  const liveB = db.dbFile();
  check('the live database is NOT read-only after the restore', isRO(liveB) === false, { readOnly: isRO(liveB) });

  /* ================= MACHINE B — the next launch ================= */
  console.log('\n=== MACHINE B — the next launch ===');
  let startError = null;
  try {
    db.close();
    db.init(MACHINE_B);
    const n = db.listItems().length;
    check('the program starts and shows the restored data', n === 2, { items: n });
  } catch (e) {
    startError = e;
    check('the program starts and shows the restored data', false, e.message);
  }

  /* ================= MACHINE B — already broken before the update ======= */
  console.log('\n=== MACHINE B — a program that ALREADY inherited the mark ===');
  const BROKEN = path.join(ROOT, '.tmp', 'cust-broken');
  rmrf(BROKEN);
  fs.mkdirSync(BROKEN, { recursive: true });
  db.close();
  /* the poisoned state the customer is in right now: the live database is
     marked read-only, and the program cannot write a single row */
  fs.copyFileSync(path.join(MACHINE_A, 'sam.db'), path.join(BROKEN, 'sam.db'));
  fs.chmodSync(path.join(BROKEN, 'sam.db'), 0o444);
  process.env.SAM_DATA_DIR = BROKEN;
  let brokenError = null;
  try {
    db.init(BROKEN);
    db.prepare("UPDATE warehouses SET name='x'").run();
  } catch (e) { brokenError = e; }
  check('the broken state is reproduced exactly', !!brokenError && /readonly/i.test(brokenError.message || ''),
    brokenError && brokenError.message);

  /* the startup repair — what the NEW version does */
  try { db.close(); } catch (e) { /* ignore */ }
  const prep = datadir.ensureUsable(fakeApp(MACHINE_B), BROKEN);
  check('the startup repair lifts the mark', prep.ok && prep.repaired === 'file', prep);
  let repairedError = null;
  try {
    db.init(BROKEN);
    /* a real write through the real API — the stock opening balance */
    db.addItem({ code: 'T-1', name: 'صنف بعد الإصلاح', base_unit: 'حبة' }, [{ warehouseId: 1, good: 1 }]);
  } catch (e) { repairedError = e; }
  check('the program opens and writes again', !repairedError, repairedError && repairedError.message);
  let recoveredItems = 0;
  try { recoveredItems = db.listItems().length; } catch (e) { /* ignore */ }
  check('the data is all still there — nothing is lost', recoveredItems === 3, { items: recoveredItems });

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  try { db.close(); } catch (e) { /* ignore */ }
  rmrf(MACHINE_A); rmrf(MACHINE_B); rmrf(USB); rmrf(BROKEN);
  app.exit(fail ? 1 : 0);
});
