'use strict';

/**
 * src/main/cloudsync.js — "type your cloud e-mail and press one button".
 *
 * The customer asked for a sync that needs NOTHING but an e-mail address:
 * no file picking, no token juggling. That is exactly what a locally
 * installed cloud client (Google Drive for Desktop / OneDrive / Dropbox)
 * already provides — it watches a folder and uploads whatever appears in
 * it, using the account the user signed in with.
 *
 * So the program:
 *   1. finds the cloud client's sync folder on this machine,
 *   2. reads the signed-in account when the client exposes it,
 *   3. copies the database into <cloud>/SAM-Backups/,
 *   4. warns the user when the typed e-mail is not the signed-in one.
 *
 * The copy is additive — the original database is never touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/* ------------------------------------------------------------------ *
 * cloud client detection
 * ------------------------------------------------------------------ */

function isDir(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (e) { return false; }
}

function firstExisting(paths) {
  for (const p of paths) if (isDir(p)) return p;
  return '';
}

/** the first folder that really exists AND can be written into */
function firstWritable(paths) {
  for (const p of paths) if (isDir(p) && writable(p)) return p;
  return '';
}

/** every cloud client we can find on this machine */
function detectClients() {
  const home = os.homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  const clients = [];

  /* ---- Google Drive for Desktop (the modern client lives in DriveFS) ---- */
  const gdriveBase = path.join(localApp, 'Google', 'DriveFS');
  const gdriveLegacy = path.join(localApp, 'Google', 'Drive');
  const gdriveInstalled = isDir(gdriveBase) || isDir(gdriveLegacy);
  if (gdriveInstalled) {
    const roots = [];
    if (isDir(gdriveBase)) roots.push(...drivefsRoots(gdriveBase));
    roots.push(
      path.join(home, 'Google Drive'),
      path.join(home, 'My Drive'),
      path.join(home, 'Google Drive Desktop'),
      'G:\\My Drive',
      'G:\\Google Drive',
      'G:\\Drive',
      'D:\\My Drive',
      'D:\\Google Drive'
    );
    const gdrive = firstWritable(roots);
    const accounts = googleAccounts(localApp, home);
    clients.push({
      id: 'gdrive',
      label: 'Google Drive',
      root: gdrive || '',
      installPath: gdriveBase,
      accountHint: bestEmail(accounts),
      accounts,
      installed: true,
      ready: !!gdrive
    });
  }

  /* ---- OneDrive ---- */
  const onedrive = firstExisting([
    path.join(home, 'OneDrive'),
    path.join(home, 'OneDrive - Personal'),
    'C:\\Users\\Public\\OneDrive'
  ]);
  if (onedrive) {
    const acc = onedriveAccount(localApp, home);
    clients.push({
      id: 'onedrive',
      label: 'OneDrive',
      root: onedrive,
      installPath: path.join(localApp, 'Microsoft\\OneDrive'),
      accountHint: acc,
      accounts: acc ? [acc] : [],
      installed: true,
      ready: true
    });
  }

  /* ---- Dropbox ---- */
  const dropbox = firstExisting([
    path.join(home, 'Dropbox'),
    path.join(home, 'Dropbox (Personal)')
  ]);
  if (dropbox) {
    const acc = dropboxAccount(appData, home);
    clients.push({
      id: 'dropbox',
      label: 'Dropbox',
      root: dropbox,
      installPath: path.join(appData, 'Dropbox'),
      accountHint: acc,
      accounts: acc ? [acc] : [],
      installed: true,
      ready: true
    });
  }

  return clients;
}

/* ------------------------------------------------------------------ *
 * Google Drive for Desktop — the DriveFS client
 *
 * Everything the modern client knows lives under
 *   %LOCALAPPDATA%\Google\DriveFS
 *     <account-id>\metadata_sqlite_db  → the signed-in account
 *     root_preference_sqlite.db        → where the sync folder lives
 * The old probe (Google\Drive) died with the old client years ago, so
 * a machine with Drive installed used to look like it had NO Drive at all.
 * ------------------------------------------------------------------ */

const EMAIL_SOFT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

/* a real top-level domain wins over the noise the binary logs produce */
const KNOWN_TLD = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro',
  'io', 'co', 'me', 'tv', 'cc', 'ly', 'ye', 'sa', 'ae', 'eg', 'ps', 'jo', 'kw',
  'qa', 'bh', 'om', 'ma', 'dz', 'tn', 'lb', 'iq', 'sy', 'sd', 'uk', 'de', 'fr',
  'es', 'it', 'nl', 'be', 'ch', 'at', 'se', 'no', 'fi', 'dk', 'pl', 'pt', 'gr',
  'ru', 'ua', 'tr', 'il', 'ir', 'in', 'pk', 'bd', 'cn', 'jp', 'kr', 'tw', 'hk',
  'sg', 'my', 'th', 'vn', 'ph', 'id', 'au', 'nz', 'ca', 'mx', 'br', 'ar', 'cl',
  'pe', 'za', 'ng', 'us', 'eu', 'app', 'dev', 'xyz', 'online', 'site', 'store',
  'tech', 'cloud', 'page', 'link', 'click', 'live', 'mail'
]);

/** open a SQLite file read-only — never throws */
function openReadonly(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const Database = require('better-sqlite3');
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) { return null; }
}

function queryAll(db, sql) {
  if (!db) return [];
  try { return db.prepare(sql).all(); } catch (e) { return []; }
}

function closeDb(db) {
  try { if (db) db.close(); } catch (e) { /* already closed */ }
}

/** the id of the account Google Drive is signed in with */
function drivefsCurrentAccount() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Google\\DriveFS', '/v', 'CurrentAccountToken'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = out.match(/CurrentAccountToken\s+REG_SZ\s+(\S+)/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

/** every account folder DriveFS keeps on this machine */
function drivefsAccountIds(base) {
  let ids = [];
  try {
    ids = fs.readdirSync(base).filter((f) => /^\d{6,}$/.test(f) && isDir(path.join(base, f)));
  } catch (e) { return []; }
  const current = drivefsCurrentAccount();
  if (current && ids.includes(current)) return [current];
  return ids;
}

/** read the tail of a file — the interesting part is always the newest */
function readTail(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('latin1');
  } finally { fs.closeSync(fd); }
}

/** the account address, as the DriveFS logs spell it */
function drivefsLogMails(base) {
  const out = [];
  const dir = path.join(base, 'Logs');
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of files) {
    if (!/^(drive_fs|structured_log)/.test(f)) continue;
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).size > 16 * 1024 * 1024) continue;
      const raw = readTail(p, 512 * 1024);
      const re = new RegExp(EMAIL_SOFT.source, 'g');
      let m;
      while ((m = re.exec(raw))) out.push(m[0]);
    } catch (e) { /* unreadable — no account check */ }
  }
  return out;
}

/**
 * The signed-in Google account, when the client leaves it readable.
 * The metadata db holds it inside a protobuf blob (property
 * "driveway_account") where the address is framed by non-address bytes,
 * so it comes out clean. A failure here is NEVER fatal — the sync simply
 * runs without an account check.
 */
function googleAccount(localApp, home) {
  return bestEmail(googleAccounts(localApp, home));
}

/** every Google account this machine has ever signed in with */
function googleAccounts(localApp, home) {
  const found = [];
  const push = (raw) => {
    const m = cleanEmail(raw);
    if (!m) return;
    const v = m.toLowerCase();
    if (v && !found.some((x) => x.toLowerCase() === v)) found.push(m);
  };

  const drivefs = path.join(localApp, 'Google', 'DriveFS');
  for (const id of drivefsAccountIds(drivefs)) {
    const db = openReadonly(path.join(drivefs, id, 'metadata_sqlite_db'));
    try {
      const rows = queryAll(db, "select value from properties where property like '%account%'");
      for (const r of rows) {
        const buf = r.value;
        if (!buf) continue;
        const txt = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
        const m = txt.match(EMAIL_SOFT);
        if (m) m.forEach(push);
      }
    } finally { closeDb(db); }
  }

  /* the logs name the account too — a safety net when the db is locked */
  drivefsLogMails(drivefs).forEach(push);

  /* the old client kept a plain "last account" file */
  for (const f of [
    path.join(localApp, 'Google', 'Drive', 'sync_config.db'),
    path.join(localApp, 'Google', 'DriveFS', 'accounts.db'),
    path.join(localApp, 'Google', 'DriveFS', 'accounts.db.bak'),
    path.join(localApp, 'Google', 'Drive', 'accounts.db')
  ]) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw = fs.readFileSync(f).toString('latin1');
      const re = new RegExp(EMAIL_SOFT.source, 'g');
      let m;
      while ((m = re.exec(raw))) push(m[0]);
    } catch (e) { /* unreadable — no account check */ }
  }

  /* the old client stored a plain "last account" file */
  try {
    const p = path.join(home, '.config', 'google_drive_sync_config.json');
    if (fs.existsSync(p)) {
      const re = new RegExp(EMAIL_SOFT.source, 'g');
      let m;
      const txt = fs.readFileSync(p, 'utf8');
      while ((m = re.exec(txt))) push(m[0]);
    }
  } catch (e) { /* ignore */ }

  return found;
}

/**
 * Tidy an address that was dug out of a binary log: the JSON escape
 * (\u0022) and a stray byte right after the domain are noise, not part
 * of the address.
 */
function cleanEmail(mail) {
  let m = String(mail || '').trim();
  m = m.replace(/^u00[0-9a-f]{2}/i, '');   /* a JSON escape leaked in */
  m = m.replace(/^["'<>]+/, '');           /* a quote leaked in */
  const at = m.lastIndexOf('@');
  if (at <= 0) return '';
  const local = m.slice(0, at);
  const domain = m.slice(at + 1);
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return '';
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return '';
  /* cut the junk the logs leave after the domain ("gmail.comZ") */
  for (let cut = 0; cut < m.length; cut++) {
    const candidate = m.slice(0, m.length - cut);
    const tld = (candidate.split('@')[1] || '').split('.').pop().toLowerCase();
    if (KNOWN_TLD.has(tld)) return candidate;
  }
  return m;
}

/**
 * Pick the most plausible address out of noisy candidates: a real
 * top-level domain beats the mangled variants the binary logs produce.
 */
function bestEmail(list) {
  const freq = new Map();
  for (const raw of list || []) {
    const m = cleanEmail(raw);
    if (!m || !EMAIL_RE.test(m)) continue;
    freq.set(m, (freq.get(m) || 0) + 1);
  }
  let best = '';
  let score = -1;
  for (const [mail, n] of freq) {
    const tld = (mail.split('@')[1] || '').split('.').pop().toLowerCase();
    const s = (KNOWN_TLD.has(tld) ? 100 : 0) + n;
    if (s > score) { score = s; best = mail; }
  }
  return best;
}

/**
 * Where Google Drive keeps the files on this machine:
 *   1. the mounted drive letter ("G:\My Drive") when Drive is running,
 *   2. the folder the user chose to mirror (an arbitrary sync folder).
 * Both are ordinary local folders — whatever we drop in them is uploaded.
 */
function drivefsRoots(base) {
  const roots = [];
  const db = openReadonly(path.join(base, 'root_preference_sqlite.db'));
  try {
    const media = queryAll(db, 'select name, last_mount_point, fs_type from media');
    for (const m of media) {
      if (!/google drive/i.test(m.name || '')) continue;
      const mount = String(m.last_mount_point || '').trim();
      if (!mount) continue;
      const letter = /\\$/.test(mount) ? mount : mount + '\\';
      const myDrive = path.join(letter, 'My Drive');
      roots.push(isDir(myDrive) ? myDrive : letter);
    }
    const rows = queryAll(db, 'select last_seen_absolute_path, root_path, is_my_drive from roots');
    const mine = rows.filter((r) => r.is_my_drive);
    const rest = rows.filter((r) => !r.is_my_drive);
    for (const r of mine.concat(rest)) {
      const abs = String(r.last_seen_absolute_path || '').trim();
      if (abs) roots.push(abs);
      else if (r.root_path) roots.push(path.join(os.homedir(), r.root_path));
    }
  } finally { closeDb(db); }
  return roots;
}

function onedriveAccount(localApp, home) {
  try {
    const dir = path.join(localApp, 'Microsoft', 'OneDrive', 'settings');
    if (!fs.existsSync(dir)) return '';
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$|settings$/i.test(f)) continue;
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (m) return m[0];
    }
  } catch (e) { /* ignore */ }
  return '';
}

function dropboxAccount(appData, home) {
  try {
    const p = path.join(appData, 'Dropbox', 'info.json');
    if (!fs.existsSync(p)) return '';
    const m = fs.readFileSync(p, 'utf8').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (m) return m[0];
  } catch (e) { /* ignore */ }
  return '';
}

/* ------------------------------------------------------------------ *
 * the sync itself
 * ------------------------------------------------------------------ */

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** the domain decides which cloud can take the copy */
function providerOf(email) {
  const e = String(email || '').toLowerCase();
  if (/@(gmail|googlemail)\./.test(e)) return 'gdrive';
  if (/@(outlook|hotmail|live|msn)\./.test(e)) return 'onedrive';
  if (/@(icloud|me|mac)\./.test(e)) return 'onedrive';
  return '';
}

/**
 * Choose the cloud client for the typed e-mail — no picking by hand:
 *   1. the client that is already signed in with that very e-mail,
 *   2. the client that serves that e-mail's provider (gmail → Drive),
 *   3. the client's saved choice from the last sync,
 *   4. the first one that is installed.
 */
function chooseClient(clients, email, preferredId) {
  const wanted = String(email || '').trim().toLowerCase();

  const byAccount = clients.find((c) => (c.accounts || []).some((a) => a.toLowerCase() === wanted));
  if (byAccount) return { client: byAccount, why: 'account' };

  const provider = providerOf(wanted);
  const byProvider = clients.find((c) => c.id === provider);
  if (byProvider) return { client: byProvider, why: 'provider' };

  if (preferredId) {
    const saved = clients.find((c) => c.id === preferredId);
    if (saved) return { client: saved, why: 'saved' };
  }
  const first = clients.find((c) => c.installed) || clients[0];
  return { client: first, why: 'default' };
}

/**
 * One click: the user types an e-mail, the program does the rest.
 * @param {object} db        the db module (for backupTo / settings)
 * @param {string} email     the cloud account e-mail
 * @param {string} [clientId] force a specific client (the settings screen
 *                            still offers it, but it is never needed)
 */
async function syncByEmail(db, email, clientId) {
  const clean = String(email || '').trim();
  if (!EMAIL_RE.test(clean)) throw new Error('اكتب بريداً إلكترونياً صحيحاً مثل name@gmail.com');

  const clients = detectClients();
  const installed = clients.filter((c) => c.installed);
  if (!installed.length) {
    throw new Error(
      'لم يُعثر على برنامج سحابي جاهز على هذا الجهاز (Google Drive أو OneDrive أو Dropbox). ' +
      'ثبّت Google Drive for Desktop وسجّل الدخول بحسابك ثم اضغط «مزامنة» — أو استخدم «نسخة احتياطية» لاختيار مجلد بنفسك.'
    );
  }

  const picked = clientId
    ? { client: clients.find((c) => c.id === clientId) || installed[0], why: 'manual' }
    : chooseClient(installed, clean, db.getSetting('sync.client'));
  const chosen = picked.client;
  if (!chosen || !chosen.root) {
    throw new Error(
      `برنامج ${chosen ? chosen.label : 'السحابة'} مثبّت لكنه لم ينشئ مجلد التزامن بعد. ` +
      'افتح البرنامج مرة واحدة وسجّل الدخول بحسابك ثم أعد المحاولة — أو استخدم «نسخة احتياطية» لاختيار مجلد بنفسك.'
    );
  }

  const target = path.join(chosen.root, 'SAM-Backups');
  fs.mkdirSync(target, { recursive: true });

  const live = path.join(target, 'sam.db');
  const dated = path.join(target, `sam-${stamp()}.db`);
  await db.backupTo(live);
  await db.backupTo(dated);

  // keep the folder tidy — the newest copies only
  const olds = fs.readdirSync(target)
    .filter((f) => /^sam-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(target, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  olds.slice(12).forEach((x) => { try { fs.unlinkSync(path.join(target, x.f)); } catch (e) { /* locked */ } });

  const account = chosen.accountHint || '';
  const mismatch = !!(account && account.toLowerCase() !== clean.toLowerCase());
  const manifest = {
    email: clean,
    client: chosen.label,
    clientRoot: chosen.root,
    account,
    at: new Date().toISOString(),
    file: dated
  };
  fs.writeFileSync(path.join(target, 'sync-info.json'), JSON.stringify(manifest, null, 2), 'utf8');

  db.setSetting('sync.email', clean);
  db.setSetting('sync.client', chosen.id);
  db.setSetting('sync.last', `${new Date().toISOString()}|${live}`);

  return {
    ok: true,
    client: chosen.label,
    clientRoot: chosen.root,
    folder: target,
    live,
    dated,
    account,
    mismatch,
    picked: picked.why,
    warning: mismatch
      ? `الحساب المسجّل في ${chosen.label} هو «${account}» وليس «${clean}» — سيُرفع الملف إلى الحساب المسجّل.`
      : (account ? '' : `لم نتمكن من قراءة الحساب المسجّل في ${chosen.label} — تأكد أن الملف يُرفع إلى ${clean}.`)
  };
}

/**
 * The automatic backup: run it when the app starts, using the e-mail the
 * customer saved once. It never blocks the app and never throws.
 */
async function autoSync(db) {
  const email = db.getSetting('sync.email');
  if (!email) return { ok: false, skipped: 'no-email' };
  if (db.getSetting('sync.auto') === '0') return { ok: false, skipped: 'off' };
  try {
    const r = await syncByEmail(db, email);
    return { ok: true, data: r };
  } catch (e) {
    db.setSetting('sync.last_error', (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** switch the automatic backup on or off */
function setAuto(db, on) {
  db.setSetting('sync.auto', on ? '1' : '0');
  return { ok: true, auto: on !== false };
}

/** what the settings screen shows before the user presses the button */
function status(db) {
  const clients = detectClients();
  const email = db.getSetting('sync.email');
  const clientId = db.getSetting('sync.client');
  const chosen = clients.find((c) => c.id === clientId) || null;
  const installed = clients.filter((c) => c.installed);
  /* the client the typed e-mail would use right now — the button needs
     no picking at all */
  const suggested = email ? chooseClient(installed.length ? installed : clients, email, clientId).client : null;
  return {
    email,
    clients: clients.map((c) => ({
      id: c.id, label: c.label, root: c.root, account: c.accountHint || '',
      installed: !!c.installed, ready: !!c.root, accounts: c.accounts || []
    })),
    activeClient: chosen ? { id: chosen.id, label: chosen.label, root: chosen.root } : null,
    suggestedClient: suggested ? { id: suggested.id, label: suggested.label, root: suggested.root } : null,
    account: chosen ? chosen.accountHint : '',
    auto: db.getSetting('sync.auto') !== '0',
    last: db.getSetting('sync.last'),
    lastError: db.getSetting('sync.last_error')
  };
}

/** open the download page of a cloud client that is not installed */
function openInstallerPage(clientId) {
  const pages = {
    gdrive: 'https://support.google.com/drive/answer/10838124?hl=ar',
    onedrive: 'https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage',
    dropbox: 'https://www.dropbox.com/desktop'
  };
  const url = pages[clientId] || pages.gdrive;
  return new Promise((resolve) => {
    execFile('cmd', ['/c', 'start', '""', url], () => resolve(url));
  });
}

module.exports = {
  detectClients, syncByEmail, autoSync, setAuto, status, openInstallerPage, stamp,
  chooseClient, providerOf, googleAccounts, googleAccount, bestEmail, drivefsRoots
};
