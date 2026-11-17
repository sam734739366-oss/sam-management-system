'use strict';

/**
 * src/main/writable.js — can this place be written to, and how to open it.
 *
 * The customer installed the program on a second computer and it refused to
 * start:
 *
 *   SqliteError: attempt to write a readonly database
 *   at migrate (…\src\main\db.js:302:6)
 *
 * The reason is never a broken program: the data file arrived from another
 * machine (a USB drive, an archive, a network share) and Windows kept the
 * READ-ONLY mark on it. SQLite can READ such a file, so the tables look
 * fine — but the first WRITE (here: the migration that normalises the
 * warehouses) dies, and the program closes before the window appears.
 *
 * These helpers answer one question — «can I write here?» — and offer the
 * two ways out:
 *   · lift the read-only mark of the file (the usual case), or
 *   · copy the whole data folder to a place that accepts writes.
 * Nothing here ever deletes or moves the customer's data.
 */

const fs = require('fs');
const path = require('path');

/** can a NEW file be created in this folder? */
function folderWritable(dir) {
  if (!dir) return false;
  const probe = path.join(dir, `.sam-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    try { fs.unlinkSync(probe); } catch (e2) { /* ignore */ }
    return false;
  }
}

/** can this EXISTING file be written to? (the read-only mark says no) */
function fileWritable(file) {
  if (!file) return false;
  try {
    if (!fs.existsSync(file)) return false;
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Lift the read-only mark of a file.
 * On Windows this is exactly the «للقراءة فقط» box in the file properties.
 * @returns {boolean} true when the file can be written afterwards
 */
function unlockFile(file) {
  if (!file || !fs.existsSync(file)) return false;
  try { fs.chmodSync(file, 0o666); } catch (e) { /* ignore */ }
  return fileWritable(file);
}

/** lift the read-only mark of a folder */
function unlockFolder(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try { fs.chmodSync(dir, 0o777); } catch (e) { /* ignore */ }
  return folderWritable(dir);
}

/** the database file and the two files SQLite keeps beside it */
function dbFamily(dir) {
  const base = path.join(dir, 'sam.db');
  return [base, base + '-wal', base + '-shm'];
}

/**
 * Copy a whole data folder to another place.
 *
 * The database travels with its write-ahead log (the newest rows live
 * there), the pictures of the items and the backups travel too, and the
 * shared-memory index is left behind so SQLite rebuilds it.
 *
 * A file that is NEWER in the destination is never overwritten: the
 * destination may already hold work that is newer than the source.
 */
function copyDataFolder(from, to) {
  const copied = [];
  try { fs.mkdirSync(to, { recursive: true }); } catch (e) { return false; }
  const src = path.join(from, 'sam.db');
  if (!fs.existsSync(src)) return false;
  for (const suffix of ['', '-wal']) {
    const s = src + suffix;
    if (!fs.existsSync(s)) continue;
    const d = path.join(to, 'sam.db' + suffix);
    try {
      if (fs.existsSync(d) && fs.statSync(d).mtimeMs >= fs.statSync(s).mtimeMs) continue;
      fs.copyFileSync(s, d);
      unlockFile(d);
      copied.push(path.basename(d));
    } catch (e) { /* ignore */ }
  }
  for (const sub of ['images', 'backups']) {
    const s = path.join(from, sub);
    if (!fs.existsSync(s)) continue;
    try {
      fs.cpSync(s, path.join(to, sub), { recursive: true, force: false, errorOnExist: false });
      copied.push(sub);
    } catch (e) { /* the pictures are not vital for the database to open */ }
  }
  /* a stale index belongs to the old file — let SQLite rebuild it */
  try { fs.rmSync(path.join(to, 'sam.db-shm'), { force: true }); } catch (e) { /* ignore */ }
  return copied.length > 0;
}

module.exports = {
  folderWritable,
  fileWritable,
  unlockFile,
  unlockFolder,
  dbFamily,
  copyDataFolder
};
