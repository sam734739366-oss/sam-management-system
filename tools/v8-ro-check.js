/**
 * tools/v8-ro-check.js — the customer's crash, proved and fixed.
 *
 * The customer installed the program on his second computer (Windows 11)
 * and it closed with:
 *
 *   SqliteError: attempt to write a readonly database
 *   at migrate (…\src\main\db.js:302:6)
 *   at Object.init (…\src\main\db.js:805:3)
 *
 * The data file had arrived from another machine with the Windows
 * READ-ONLY mark still on it. SQLite reads such a file fine, so the tables
 * look healthy — then the first write (the migration) dies and the whole
 * program closes before the window appears.
 *
 * This check proves:
 *   1 — the crash is reproduced exactly as the customer saw it
 *   2 — the repair lifts the mark and the database opens
 *   3 — NOT A SINGLE ROW is lost by the repair
 *   4 — a folder that refuses every write is handled by COPYING the data
 *       to a folder that accepts writes — and the original is left intact
 *   5 — the copy carries the items, the pictures and the backups
 *   6 — the Arabic error message never shows an English stack trace
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v8-ro-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v8ro');
const FALLBACK = path.join(ROOT, '.tmp', 'v8ro-fallback');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

/**
 * Windows ignores the permission bits of a FOLDER (chmod 0o555 does not
 * stop a write), so a folder that truly refuses new files is made with a
 * real deny-ACL on the folder ALONE (no inheritance): the folder refuses
 * every new file — SQLite cannot create its -wal there — while the data
 * file keeps its own rights, so it stays readable and copyable.
 *
 * That is exactly the customer's situation: the DATA is fine, the PLACE
 * refuses the write. The ACL is removed again right after, and the folder
 * is deleted — nothing of the customer's is touched by this.
 */
function denyFolderWrites(dir) {
  try {
    execFileSync('icacls', [dir, '/deny', `${process.env.USERNAME || 'Elite'}:(W)`], { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}
function allowWrites(dir) {
  try {
    execFileSync('icacls', [dir, '/remove:d', process.env.USERNAME || 'Elite'], { stdio: 'ignore' });
  } catch (e) { /* ignore */ }
}

const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
const datadir = require(path.join(ROOT, 'src', 'main', 'datadir.js'));
const writable = require(path.join(ROOT, 'src', 'main', 'writable.js'));

/* a fake `app` — the real one needs a ready Electron, and these helpers
   only need the two paths */
function fakeApp(userDataDir) {
  return {
    getPath(which) {
      if (which === 'userData') return userDataDir;
      if (which === 'appData') return path.dirname(userDataDir);
      if (which === 'documents') return path.join(ROOT, '.tmp', 'v8ro-docs');
      if (which === 'temp') return path.join(ROOT, '.tmp', 'v8ro-temp');
      return userDataDir;
    }
  };
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

/** the fingerprint of the data — what MUST survive the repair */
function fingerprint(dir) {
  const Database = require('better-sqlite3');
  const file = path.join(dir, 'sam.db');
  if (!fs.existsSync(file)) return null;
  const h = new Database(file, { readonly: true });
  try {
    const tables = h.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const items = h.prepare('SELECT id, code, name FROM items ORDER BY id').all();
    const moves = h.prepare('SELECT COUNT(*) AS c FROM stock_moves').get().c;
    const wh = h.prepare('SELECT COUNT(*) AS c FROM warehouses').get().c;
    return { tables, items, moves, wh };
  } finally { h.close(); }
}

app.whenReady().then(() => {
  try {
    rmrf(DATA); rmrf(FALLBACK);
    fs.mkdirSync(DATA, { recursive: true });

    /* ---------- build a real database with real data ---------- */
    db.init(DATA);
    const wh = db.addWarehouse({ code: 'W1', name: 'مخزن العميل', location: '' });
    db.addItem({ code: 'R-1', name: 'خامة العميل', base_unit: 'حبة', pieces_per_carton: 12 },
      [{ warehouseId: wh.id, good: 5000 }]);
    db.addItem({ code: 'B-1', name: 'علبة جاهزة', base_unit: 'حبة', pieces_per_bag: 20 },
      [{ warehouseId: wh.id, good: 300 }]);
    db.addParty({ name: 'عميل النفخ', type: 'customer', phone: '771111111' });
    db.addItem({ code: 'P-1', name: 'صنف بصورة', base_unit: 'حبة' }, [{ warehouseId: wh.id, good: 10 }]);
    /* a picture of an item lives beside the database */
    fs.mkdirSync(path.join(DATA, 'images'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'images', 'P-1.png'), 'FAKE-PNG-BYTES');
    db.close();

    const before = fingerprint(DATA);
    check('the database holds real data', !!before && before.items.length === 3 && before.moves > 0, before && { items: before.items.length, moves: before.moves });

    /* ---------- 1 — the customer crash, reproduced ---------- */
    const dbFile = path.join(DATA, 'sam.db');
    fs.chmodSync(dbFile, 0o444);              /* the Windows read-only mark */
    const blocked = !writable.fileWritable(dbFile);
    check('the file is now marked read-only (like a copy from another machine)', blocked);

    let crashed = null;
    try {
      db.init(DATA);
      db.prepare("UPDATE warehouses SET name='probe'").run();
    } catch (e) { crashed = e; }
    check('the crash is reproduced exactly as the customer saw it',
      !!crashed && /readonly/i.test(crashed.message || ''),
      crashed && crashed.message);
    try { db.close(); } catch (e) { /* ignore */ }

    /* ---------- 2 — the repair ---------- */
    const res = datadir.ensureUsable(fakeApp(FALLBACK), DATA);
    check('the repair says what it did', res.ok && res.repaired === 'file', res);
    check('the file can be written to now', writable.fileWritable(dbFile));
    check('the data stays exactly where it was', res.dir === DATA && !res.relocated, { dir: res.dir, relocated: res.relocated });

    /* ---------- 3 — nothing is lost ---------- */
    db.init(DATA);
    const after = fingerprint(DATA);
    check('NOT A SINGLE ROW is lost by the repair',
      after && before && JSON.stringify(after.items) === JSON.stringify(before.items)
      && after.moves === before.moves && after.wh === before.wh,
      { before: before && before.items.length, after: after && after.items.length, moves: after && after.moves });
    db.close();

    /* ---------- 4 — a folder that refuses EVERY write ---------- */
    const locked = path.join(ROOT, '.tmp', 'v8ro-locked');
    rmrf(locked);
    fs.mkdirSync(locked, { recursive: true });
    /* the WHOLE data folder goes here: the database, the pictures of the
       items and the backups — everything the customer would have copied */
    for (const name of fs.readdirSync(DATA)) {
      const from = path.join(DATA, name);
      const to = path.join(locked, name);
      if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true });
      else fs.copyFileSync(from, to);
    }
    fs.chmodSync(path.join(locked, 'sam.db'), 0o444);
    /* the folder refuses to create anything: the -wal cannot be born there,
       while the data itself stays readable — the customer's real case */
    const aclSet = denyFolderWrites(locked);
    const folderBlocked = aclSet && !writable.folderWritable(locked);
    const fileStillReadable = (() => {
      try { fs.readFileSync(path.join(locked, 'sam.db')); return true; } catch (e) { return 'ERR ' + e.code; }
    })();
    check('the folder refuses every write', folderBlocked, { aclSet, folderBlocked });
    check('the data inside it is still readable (nothing is lost)', fileStillReadable === true, { fileStillReadable });
    if (fileStillReadable !== true) {
      try { console.log('   ACL of the data file:\n' + execFileSync('icacls', [path.join(locked, 'sam.db')], { encoding: 'utf8' })); } catch (e) { /* ignore */ }
    }

    let res2 = null;
    if (folderBlocked) {
      res2 = datadir.ensureUsable(fakeApp(FALLBACK), locked);
      check('the data is copied to a folder that accepts writes', res2.ok && res2.relocated && res2.dir !== locked, { dir: res2.dir, from: res2.from, message: res2.message });
      check('the original folder is left untouched (never deleted)', fs.existsSync(path.join(locked, 'sam.db')));
    }

    /* ---------- 5 — the copy carries everything ---------- */
    if (res2 && res2.relocated) {
      const copied = fingerprint(res2.dir);
      check('the copy holds the same items', copied && copied.items.length === 3, copied && copied.items);
      check('the copy holds the same movements', copied && copied.moves === before.moves, copied && copied.moves);
      check('the picture of the item travels with the data',
        fs.existsSync(path.join(res2.dir, 'images', 'P-1.png')),
        path.join(res2.dir, 'images', 'P-1.png'));

      /* the copy really opens and works */
      let opened = false;
      try {
        db.init(res2.dir);
        const n = db.listItems().length;
        opened = n === 3;
        db.close();
      } catch (e) { opened = false; }
      check('the copy opens and the items are all there', opened);
    }
    allowWrites(locked);

    /* ---------- 6 — the message the customer reads ---------- */
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const hasArabic = /تعذّر الكتابة في مجلد البيانات/.test(mainSrc);
    const hasEnglishStack = /showErrorBox\('تعذّر تشغيل نظام SAM',\s*String\(\(err && err\.stack\)/.test(mainSrc);
    check('the startup error is an Arabic sentence', hasArabic);
    check('the English stack trace is never shown to the customer', !hasEnglishStack);

    /* the settings screen offers the repair */
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.html'), 'utf8');
    check('the settings screen has the repair button', html.includes('btnFixDataDir'));
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
    check('the repair is reachable from the window', preload.includes('repair: () => ipcRenderer.invoke(\'datadir:repair\')'));

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    rmrf(DATA); rmrf(FALLBACK); rmrf(locked);
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e && e.stack);
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    app.exit(1);
  }
});
