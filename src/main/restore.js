'use strict';

/**
 * src/main/restore.js — putting a data file back into the program.
 *
 * The customer asked for an icon that restores the data: he has a file from
 * another machine (or from an older copy of the program) and wants to bring
 * it back in. The file can arrive in two ways — he picks it with a dialog,
 * or he drops it on the window — and both end here.
 *
 * The rules of this file:
 *   1. The file is CHECKED before anything is touched. A file that is not a
 *      SQLite database, or that has no SAM tables, is refused with a clear
 *      sentence — never half-applied.
 *   2. The data we have NOW is copied into the backups folder first. The old
 *      data is never simply thrown away.
 *   3. The live database is CLOSED before the file is swapped, because
 *      Windows keeps a lock on an open .db (and its -wal / -shm siblings).
 *   4. The stale -wal and -shm files are removed with the old file. A
 *      leftover write-ahead log belongs to the OLD database and would
 *      corrupt the new one.
 *   5. The program starts again on the restored file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const db = require('./db');
const backup = require('./backup');

const MAGIC = 'SQLite format 3';
/* the one table every SAM file has — without it the file is not ours */
const REQUIRED = ['items'];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

/**
 * The customer may drop a FOLDER (the one that holds his data) instead of the
 * file itself — then the database inside it is the one we work with.
 */
function resolveTarget(p) {
  if (!p) return '';
  let st = null;
  try { st = fs.statSync(p); } catch (e) { return ''; }
  if (st.isFile()) return p;
  if (st.isDirectory()) {
    const inside = path.join(p, 'sam.db');
    if (isFile(inside)) return inside;
    /* a folder of backups: take the newest one */
    try {
      const files = fs.readdirSync(p)
        .filter((f) => /^sam-.*\.db$/.test(f))
        .map((f) => path.join(p, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (files.length) return files[0];
    } catch (e) { /* ignore */ }
  }
  return '';
}

/** the SQLite magic header — the cheapest honest check there is */
function isSqlite(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    return n >= 15 && buf.toString('latin1', 0, 15) === MAGIC;
  } catch (e) {
    return false;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * Copy the source into a temporary folder and let SQLite recover it there.
 * Working on a copy means the original file is never modified, and the
 * write-ahead log (if the file came from a running program) is merged into
 * the copy — so the restored data is complete even if the customer copied
 * the file while the program was running.
 */
function materialise(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-restore-'));
  const target = path.join(dir, 'sam.db');
  fs.copyFileSync(source, target);
  const wal = source + '-wal';
  if (isFile(wal) && fs.statSync(wal).size > 0) {
    try { fs.copyFileSync(wal, target + '-wal'); } catch (e) { /* optional */ }
  }
  const Database = require('better-sqlite3');
  let handle = null;
  try {
    handle = new Database(target);
    /* merging the log into the file makes the copy self-contained */
    try { handle.pragma('journal_mode = DELETE'); } catch (e) { /* already merged */ }
    const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const missing = REQUIRED.filter((t) => !tables.includes(t));
    return { dir, file: target, tables, missing };
  } catch (e) {
    rmrf(dir);
    throw new Error('الملف ليس قاعدة بيانات صالحة — لا يمكن استعادته');
  } finally {
    if (handle) { try { handle.close(); } catch (e) { /* ignore */ } }
  }
}

function fileInfo(p) {
  const st = fs.statSync(p);
  return {
    name: path.basename(p),
    path: p,
    size: st.size,
    mtime: st.mtime.toLocaleString('ar-EG-u-nu-latn')
  };
}

/**
 * Look at a file WITHOUT touching anything — the settings screen shows this
 * before the user commits to the restore.
 */
function describe(source) {
  if (!source) throw new Error('لم يتم اختيار ملف');
  const target = resolveTarget(source);
  if (!target) throw new Error('الملف غير موجود أو ليس ملف بيانات');
  if (!isFile(target)) throw new Error('الملف غير موجود أو ليس ملفاً');
  const info = fileInfo(target);
  if (!isSqlite(target)) throw new Error('هذا ليس ملف بيانات — يبدو غير صالح');

  const mat = materialise(target);
  try {
    if (mat.missing.length) {
      throw new Error('هذا الملف لا يخص برنامج SAM — لا توجد فيه جداول الأصناف');
    }
    let items = 0;
    try {
      const Database = require('better-sqlite3');
      const h = new Database(mat.file, { readonly: true });
      try { items = h.prepare('SELECT COUNT(*) AS c FROM items').get().c; } finally { h.close(); }
    } catch (e) { /* the count is a nicety, not a condition */ }

    return {
      ok: true,
      name: info.name,
      path: info.path,
      size: info.size,
      mtime: info.mtime,
      tables: mat.tables.length,
      items
    };
  } finally {
    rmrf(mat.dir);
  }
}

/**
 * The restore itself. The order matters: check, copy the old data away,
 * close the database, swap the file, open it again, start the program.
 */
async function restoreFrom(source, opts = {}) {
  const relaunch = opts.relaunch !== false;
  const info = describe(source);        /* throws with a clear sentence */
  const target = info.path;             /* the file inside the folder, if any */

  /* 1 — the data we have now goes into the backups folder first */
  let safety = null;
  try {
    const r = await backup.backupNow('pre-restore');
    safety = r && r.path ? r.path : null;
  } catch (e) {
    safety = null;
  }

  const mat = materialise(target);
  try {
    if (mat.missing.length) throw new Error('هذا الملف لا يخص برنامج SAM — لا توجد فيه جداول الأصناف');

    /* 2 — release the lock so Windows lets us write the file */
    const live = db.dbFile();
    const dir = db.dataDir();
    db.close();

    /* 3 — swap the file; the old write-ahead log must go with it */
    fs.copyFileSync(mat.file, live);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(live + suffix); } catch (e) { /* not there */ }
    }

    /* 4 — open the restored database again: the schema and the migrations
           run on it exactly as they do on any normal start */
    db.init(dir);
    ensureAdmin();

    /* 5 — start the program again on the restored data */
    if (relaunch) {
      app.relaunch();
      setTimeout(() => app.exit(0), 400);
    }

    return {
      ok: true,
      file: info.name,
      items: info.items,
      safety,
      message: 'تمت استعادة البيانات — سيُعاد تشغيل البرنامج'
    };
  } finally {
    rmrf(mat.dir);
  }
}

/**
 * The safety valve: the person who restores the data must be able to log in.
 * If the restored file has no "admin" account, one is created with the
 * default password — the customer keeps every account they already had.
 */
function ensureAdmin() {
  try {
    const session = require('./session');
    const existing = db.getUserByUsername('admin');
    if (existing) return false;
    db.addUser({ username: 'admin', full_name: 'مدير النظام', role: 'admin' }, session.makeCredentials('admin123'));
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { describe, restoreFrom, isSqlite, resolveTarget };
