'use strict';

/**
 * src/main/backup.js — local backups + Google Drive folder sync.
 *
 * Sync works by writing the database into a folder inside the user's
 * locally-synced Google Drive directory (Google Drive for Desktop uploads it
 * automatically). That keeps the app free of OAuth tokens and refresh-code
 * handling while still landing the file in the chosen Drive folder.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const KEEP_LOCAL = 12;
const KEEP_DRIVE = 12;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function backupsDir() {
  const dir = path.join(db.dataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function prune(dir, keep) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^sam-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(keep).forEach((x) => {
    try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) { /* locked elsewhere */ }
  });
  return files.length;
}

async function backupNow(label = 'manual') {
  const file = path.join(backupsDir(), `sam-${label}-${stamp()}.db`);
  const res = await db.backupTo(file);
  prune(backupsDir(), KEEP_LOCAL);
  db.setSetting('backup.last', `${new Date().toISOString()}|${file}`);
  return res;
}

/** save an explicit copy where the user chose (Save-As dialog path) */
async function saveCopyTo(target) {
  if (!target) throw new Error('لم يتم اختيار مسار');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const res = await db.backupTo(target);
  db.setSetting('backup.last', `${new Date().toISOString()}|${target}`);
  return res;
}

function listBackups() {
  const dir = backupsDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtime.toLocaleString('ar-EG-u-nu-latn') };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function syncInfo() {
  return {
    folder: db.getSetting('sync.folder'),
    auto: db.getSetting('sync.auto') === '1',
    last: db.getSetting('sync.last'),
    backupLast: db.getSetting('backup.last'),
    backupsDir: backupsDir(),
    dbFile: db.dbFile(),
    dbSize: (() => { try { return fs.statSync(db.dbFile()).size; } catch (e) { return 0; } })()
  };
}

function setSyncConfig({ folder, auto }) {
  if (folder !== undefined) {
    const clean = String(folder || '').trim();
    if (clean && !fs.existsSync(clean)) throw new Error('المجلد المحدد غير موجود');
    db.setSetting('sync.folder', clean);
  }
  if (auto !== undefined) db.setSetting('sync.auto', auto ? '1' : '0');
  return syncInfo();
}

async function syncNow() {
  const folder = db.getSetting('sync.folder');
  if (!folder) throw new Error('اختر مجلد Google Drive أولاً');
  if (!fs.existsSync(folder)) throw new Error('مجلد Google Drive المحدد غير موجود — تحقق من المزامنة');
  const target = path.join(folder, 'SAM-Backups');
  fs.mkdirSync(target, { recursive: true });
  const live = path.join(target, 'sam.db');
  const dated = path.join(target, `sam-${stamp()}.db`);
  await db.backupTo(live);
  await db.backupTo(dated);
  prune(target, KEEP_DRIVE);
  db.setSetting('sync.last', `${new Date().toISOString()}|${live}`);
  return { live, dated, target };
}

/** called on startup when auto-sync is on */
async function autoSyncOnStart() {
  if (db.getSetting('sync.auto') !== '1') return null;
  if (!db.getSetting('sync.folder')) return null;
  try {
    await backupNow('auto');
    return await syncNow();
  } catch (e) {
    db.setSetting('sync.last_error', `${new Date().toISOString()}|${e.message}`);
    return { error: e.message };
  }
}

module.exports = {
  stamp,
  backupNow,
  saveCopyTo,
  listBackups,
  syncInfo,
  setSyncConfig,
  syncNow,
  autoSyncOnStart,
  backupsDir
};
