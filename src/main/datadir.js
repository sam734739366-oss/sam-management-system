'use strict';

/**
 * src/main/datadir.js — where the data lives, chosen by the user.
 *
 * The customer asked for an icon that lets him pick the folder that keeps
 * his data, so copying a backup is a plain folder copy.
 *
 * The choice is stored OUTSIDE the database — in a tiny JSON file next to
 * the app's own user-data folder — because the database itself lives in the
 * folder the user picks, and it may not exist yet on the very first run.
 *
 * The stored path is honoured on the next launch. Moving the data happens
 * only on an explicit request, and it is always a copy: the original file is
 * never deleted, so a failed move can never lose data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  folderWritable, fileWritable, unlockFile, unlockFolder, dbFamily, copyDataFolder
} = require('./writable');

const POINTER = 'sam-data-dir.json';

let cache = null;

function defaultDir(app) {
  return app.getPath('userData');
}

/**
 * Where the pointer file (the customer's choice of data folder) may live.
 *
 * The first place is the app's own folder. When that folder cannot be
 * written to — a profile copied from another machine keeps the read-only
 * mark — the choice is kept in the next place instead, so the customer is
 * never asked again on every launch.
 */
function pointerFiles(app) {
  const list = [];
  const push = (p) => { if (p && !list.includes(p)) list.push(p); };
  try { push(path.join(defaultDir(app), POINTER)); } catch (e) { /* ignore */ }
  try { push(path.join(app.getPath('appData'), POINTER)); } catch (e) { /* ignore */ }
  try { push(path.join(app.getPath('documents'), POINTER)); } catch (e) { /* ignore */ }
  return list;
}

function pointerFile(app) {
  return pointerFiles(app)[0];
}

/** read the pointer — the newest of the places that holds one */
function readPointer(app) {
  let best = null;
  let bestKey = -Infinity;
  for (const f of pointerFiles(app)) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      const key = raw.at ? Date.parse(raw.at) : fs.statSync(f).mtimeMs;
      if (!Number.isNaN(key) && key > bestKey) { best = raw; bestKey = key; }
    } catch (e) { /* this place holds nothing usable — try the next */ }
  }
  return best;
}

/** read the stored choice; empty means "use the default location" */
function storedDir(app) {
  const raw = readPointer(app);
  const dir = String((raw && raw.dir) || '').trim();
  return dir && fs.existsSync(dir) ? dir : '';
}

/** the raw pointer file — it carries more than the folder (see syncPending) */
function pointerData(app) {
  return readPointer(app);
}

/** write the pointer to the first place that accepts the write */
function writePointer(app, data) {
  const files = pointerFiles(app);
  let last = null;
  for (const f of files) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
      cache = null;
      return f;
    } catch (e) { last = e; }
  }
  throw last || new Error('تعذّر حفظ اختيار مجلد البيانات');
}

/**
 * The folder the database must live in for THIS launch.
 * Order: explicit env var (used by the test harness) > the user's choice >
 * the default app folder.
 */
function resolveDir(app) {
  if (process.env.SAM_DATA_DIR) return process.env.SAM_DATA_DIR;
  const chosen = storedDir(app);
  if (chosen) return chosen;
  return defaultDir(app);
}

/** what the settings screen shows */
function info(app) {
  const dir = resolveDir(app);
  const def = defaultDir(app);
  const dbFile = path.join(dir, 'sam.db');
  return {
    dir,
    dbFile,
    isCustom: dir !== def,
    defaultDir: def,
    exists: fs.existsSync(dir),
    dbExists: fs.existsSync(dbFile),
    dbSize: (() => { try { return fs.statSync(dbFile).size; } catch (e) { return 0; } })(),
    pointerFile: pointerFile(app),
    /* V9 — is the place we live in able to take a write? */
    writable: folderWritable(dir),
    dbWritable: fileWritable(dbFile),
    freeSpaceMB: (() => {
      try {
        const st = fs.statfsSync(dir);
        return Math.round((st.bavail * st.bsize) / (1024 * 1024));
      } catch (e) { return null; }
    })()
  };
}

/**
 * V9 — a folder that cannot be written to.
 *
 * Where the data goes when the folder the customer chose refuses every
 * write. The app's own folder comes first (it is the place the program
 * expects to live), then Documents, then the temporary folder — which is
 * the last resort and never the first choice.
 */
function fallbackDirs(app) {
  const out = [];
  const push = (p, label) => { if (p && !out.some((x) => x.dir === p)) out.push({ dir: p, label }); };
  try { push(path.join(defaultDir(app), 'data'), 'مجلد البرنامج'); } catch (e) { /* ignore */ }
  try { push(path.join(app.getPath('documents'), 'SAM Management System'), 'مجلد المستندات'); } catch (e) { /* ignore */ }
  try { push(path.join(app.getPath('temp'), 'SAM Management System'), 'المجلد المؤقت'); } catch (e) { /* ignore */ }
  return out;
}

/**
 * V9 — make sure the data folder can take a write BEFORE the database
 * opens.
 *
 * The customer installed the program on a second computer and it refused
 * to start with «attempt to write a readonly database». The data file had
 * arrived from another machine with the Windows read-only mark still on
 * it. There are two ways out, and both are tried here:
 *
 *   1. lift the mark (the common case — the data stays exactly where it
 *      is, and the program simply starts);
 *   2. if the folder itself refuses every write, copy the whole data
 *      folder — database, write-ahead log, pictures and backups — to a
 *      folder that accepts writes and remember it for the next launch.
 *      The original is NEVER deleted or moved: it stays as a safety copy.
 *
 * @returns {{dir:string, ok:boolean, repaired:string, relocated:boolean,
 *            from:string, to:string, message:string}}
 */
function ensureUsable(app, dir) {
  const target = dir || resolveDir(app);
  const out = {
    dir: target, ok: true, repaired: '', relocated: false,
    from: '', to: target, message: ''
  };

  try { fs.mkdirSync(target, { recursive: true }); } catch (e) { /* checked below */ }

  /* 1 — the file itself: lift the read-only mark */
  const dbFile = path.join(target, 'sam.db');
  const fileBlocked = fs.existsSync(dbFile) && !fileWritable(dbFile);
  if (fileBlocked) {
    for (const f of dbFamily(target)) unlockFile(f);
    if (fileWritable(dbFile)) {
      out.repaired = 'file';
      out.message = 'أُزيلت علامة «للقراءة فقط» عن ملف قاعدة البيانات — البيانات سليمة.';
    }
  }

  /* 2 — the folder: a new file has to be creatable there (the -wal lives
         beside the database) */
  if (!folderWritable(target)) {
    unlockFolder(target);
    if (folderWritable(target)) {
      out.repaired = out.repaired || 'folder';
      out.message = out.message || 'أُزيلت علامة «للقراءة فقط» عن مجلد البيانات — البيانات سليمة.';
    }
  }

  const dbStillBlocked = fs.existsSync(dbFile) && !fileWritable(dbFile);
  if (folderWritable(target) && !dbStillBlocked) return out;

  /* 3 — still blocked: take the data to a folder that accepts writes */
  for (const cand of fallbackDirs(app)) {
    if (cand.dir === target) continue;
    try { fs.mkdirSync(cand.dir, { recursive: true }); } catch (e) { /* ignore */ }
    if (!folderWritable(cand.dir)) continue;
    if (!copyDataFolder(target, cand.dir)) continue;
    writePointer(app, {
      dir: cand.dir,
      at: new Date().toISOString(),
      from: null,
      pending: false
    });
    out.dir = cand.dir;
    out.to = cand.dir;
    out.from = target;
    out.relocated = true;
    out.repaired = out.repaired || 'relocated';
    out.message = `تعذّر الكتابة في مجلد البيانات، لذلك نُسخت بياناتك إلى «${cand.label}» (${cand.dir}). النسخة الأصلية بقيت كما هي.`;
    return out;
  }

  out.ok = false;
  out.message = 'مجلد البيانات لا يقبل الكتابة، ولم نجد مجلداً بديلاً يمكن الكتابة فيه.';
  return out;
}

/** remember the folder the user picked (applies on the next launch) */
function remember(app, dir, fromDbFile) {
  const clean = String(dir || '').trim();
  if (!clean) throw new Error('لم يتم اختيار مجلد');
  if (!fs.existsSync(clean)) throw new Error('المجلد المحدد غير موجود');
  writePointer(app, {
    dir: clean,
    at: new Date().toISOString(),
    /* where the live database is RIGHT NOW — the next launch copies it over
       the new folder before opening, so nothing typed since the pick is lost */
    from: fromDbFile || null,
    pending: !!fromDbFile
  });
  return info(app);
}

/**
 * V4 — run BEFORE the database opens.
 *
 * The user picked a new folder while the app was running. A copy was taken
 * at that moment, but the user kept typing afterwards, so the copy can be
 * older than the data. This copies the live database once more — the fresh
 * one — into the new folder and then opens the new folder. The old file
 * stays untouched as a safety copy.
 */
function applyPending(app) {
  const p = pointerData(app);
  if (!p || !p.pending) return null;
  const target = String(p.dir || '').trim();
  const from = String(p.from || '').trim();
  if (!target) return null;
  try { fs.mkdirSync(target, { recursive: true }); } catch (e) { /* ignore */ }
  let copied = false;
  if (from && fs.existsSync(from)) {
    copied = copyDatabase(from, path.join(target, 'sam.db'));
  }
  p.pending = false;
  p.appliedAt = new Date().toISOString();
  writePointer(app, p);
  return { dir: target, copied, from };
}

/**
 * Copy a SQLite database file into another place, WAL and all.
 *
 * A plain copy of the main file alone can tear: the transactions that are
 * not yet checkpointed live in the -wal sidecar. So the sidecar travels
 * with it. The -shm file is NOT copied — it is a rebuildable index, and
 * SQLite recreates it as soon as it opens the copy.
 *
 * This runs BEFORE the database is opened, so nothing writes to the source
 * while it is being copied.
 */
function copyDatabase(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    const wal = src + '-wal';
    if (fs.existsSync(wal)) fs.copyFileSync(wal, dest + '-wal');
    // a stale shared-memory index would confuse SQLite — let it rebuild
    try { if (fs.existsSync(dest + '-shm')) fs.unlinkSync(dest + '-shm'); } catch (e) { /* ignore */ }
    return true;
  } catch (e) {
    return false;
  }
}

/** forget the custom folder — the app goes back to its default location */
function forget(app) {
  try { fs.unlinkSync(pointerFile(app)); } catch (e) { /* nothing to remove */ }
  cache = null;
  return info(app);
}

/**
 * Copy the live database into a folder the user picked.
 * The source is NEVER removed — the copy is additive.
 */
/**
 * The export is ONE file, and it is a consistent one.
 *
 * The live database works in WAL mode, so the folder holds three files:
 * sam.db (the database), sam.db-wal (the newest rows, not yet folded in)
 * and sam.db-shm (its index). Copying them by hand filled the customer's
 * folder with three files that only mean something together — and a copy
 * of sam.db alone could be missing the newest rows.
 *
 * The backup API of SQLite writes the whole database, folded and complete,
 * into ONE file: that is the copy the customer takes away.
 */
async function exportTo(app, target, liveDbFile) {
  const clean = String(target || '').trim();
  if (!clean) throw new Error('لم يتم اختيار مجلد');
  fs.mkdirSync(clean, { recursive: true });
  const dest = path.join(clean, 'sam.db');
  const src = liveDbFile || path.join(resolveDir(app), 'sam.db');
  if (!fs.existsSync(src)) throw new Error('لا توجد قاعدة بيانات جاهزة للنسخ');
  const db = require('./db');
  const res = await db.backupTo(dest);
  /* V9 — the file the customer carries to the other computer must NOT carry
     the read-only mark with it. A file that arrives marked read-only makes
     the program on the other machine fail to write — and the restore then
     copies that mark onto the live database, so the program never starts
     again. The mark is cleared HERE, once, at the source. */
  unlockFile(dest);
  const size = fs.statSync(dest).size;
  return { dir: clean, path: dest, size, files: 1 };
}

/** simple guard: is the path writable? */
function writable(dir) {
  const probe = path.join(dir, `.sam-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/** common cloud roots we can offer without asking the user to pick a file */
function cloudRoots(app) {
  const home = os.homedir();
  const candidates = [
    { id: 'gdrive', label: 'Google Drive', paths: [
      path.join(home, 'Google Drive'),
      path.join(home, 'My Drive'),
      'G:\\My Drive',
      'G:\\Google Drive'
    ] },
    { id: 'onedrive', label: 'OneDrive', paths: [
      path.join(home, 'OneDrive'),
      path.join(home, 'OneDrive - Personal')
    ] },
    { id: 'dropbox', label: 'Dropbox', paths: [
      path.join(home, 'Dropbox'),
      path.join(home, 'Dropbox (Personal)')
    ] }
  ];
  const out = [];
  for (const c of candidates) {
    for (const p of c.paths) {
      if (fs.existsSync(p)) { out.push({ id: c.id, label: c.label, path: p }); break; }
    }
  }
  return out;
}

module.exports = {
  resolveDir, info, remember, forget, exportTo, writable, cloudRoots,
  defaultDir, storedDir, applyPending, ensureUsable, fallbackDirs
};
