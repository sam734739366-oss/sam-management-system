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

const POINTER = 'sam-data-dir.json';

let cache = null;

function defaultDir(app) {
  return app.getPath('userData');
}

function pointerFile(app) {
  return path.join(defaultDir(app), POINTER);
}

/** read the stored choice; empty means "use the default location" */
function storedDir(app) {
  try {
    const f = pointerFile(app);
    if (!fs.existsSync(f)) return '';
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const dir = String((raw && raw.dir) || '').trim();
    return dir && fs.existsSync(dir) ? dir : '';
  } catch (e) {
    return '';
  }
}

/** the raw pointer file — it carries more than the folder (see syncPending) */
function pointerData(app) {
  try {
    const f = pointerFile(app);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8')) || null;
  } catch (e) {
    return null;
  }
}

function writePointer(app, data) {
  fs.mkdirSync(path.dirname(pointerFile(app)), { recursive: true });
  fs.writeFileSync(pointerFile(app), JSON.stringify(data, null, 2), 'utf8');
  cache = null;
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
  return {
    dir,
    dbFile: path.join(dir, 'sam.db'),
    isCustom: dir !== def,
    defaultDir: def,
    exists: fs.existsSync(dir),
    dbExists: fs.existsSync(path.join(dir, 'sam.db')),
    dbSize: (() => { try { return fs.statSync(path.join(dir, 'sam.db')).size; } catch (e) { return 0; } })(),
    pointerFile: pointerFile(app),
    freeSpaceMB: (() => {
      try {
        const st = fs.statfsSync(dir);
        return Math.round((st.bavail * st.bsize) / (1024 * 1024));
      } catch (e) { return null; }
    })()
  };
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
function exportTo(app, target, liveDbFile) {
  const clean = String(target || '').trim();
  if (!clean) throw new Error('لم يتم اختيار مجلد');
  fs.mkdirSync(clean, { recursive: true });
  const dest = path.join(clean, 'sam.db');
  const src = liveDbFile || path.join(resolveDir(app), 'sam.db');
  if (!fs.existsSync(src)) throw new Error('لا توجد قاعدة بيانات جاهزة للنسخ');
  // copy the -wal / -shm siblings too when they exist, so the copy is complete
  for (const suffix of ['-wal', '-shm']) {
    const from = src + suffix;
    if (fs.existsSync(from)) { try { fs.copyFileSync(from, dest + suffix); } catch (e) { /* optional */ } }
  }
  fs.copyFileSync(src, dest);
  const size = fs.statSync(dest).size;
  return { dir: clean, path: dest, size };
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

module.exports = { resolveDir, info, remember, forget, exportTo, writable, cloudRoots, defaultDir, storedDir, applyPending };
