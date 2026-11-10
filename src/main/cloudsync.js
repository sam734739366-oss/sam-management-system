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

function firstExisting(paths) {
  for (const p of paths) if (isDir(p)) return p;
  return '';
}

/** every cloud client we can find on this machine */
function detectClients() {
  const home = os.homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  const clients = [];

  /* ---- Google Drive for Desktop ---- */
  const gdrive = firstExisting([
    path.join(home, 'Google Drive'),
    path.join(home, 'My Drive'),
    'G:\\My Drive',
    'G:\\Google Drive',
    'G:\\Drive',
    path.join(home, 'Google Drive Desktop')
  ]);
  if (gdrive) {
    clients.push({
      id: 'gdrive',
      label: 'Google Drive',
      root: gdrive,
      installPath: path.join(localApp, 'Google', 'Drive'),
      accountHint: googleAccount(localApp, home)
    });
  }

  /* ---- OneDrive ---- */
  const onedrive = firstExisting([
    path.join(home, 'OneDrive'),
    path.join(home, 'OneDrive - Personal'),
    path.join(home, 'OneDrive - Personal'),
    'C:\\Users\\Public\\OneDrive'
  ]);
  if (onedrive) {
    clients.push({
      id: 'onedrive',
      label: 'OneDrive',
      root: onedrive,
      installPath: path.join(localApp, 'Microsoft\\OneDrive'),
      accountHint: onedriveAccount(localApp, home)
    });
  }

  /* ---- Dropbox ---- */
  const dropbox = firstExisting([
    path.join(home, 'Dropbox'),
    path.join(home, 'Dropbox (Personal)')
  ]);
  if (dropbox) {
    clients.push({
      id: 'dropbox',
      label: 'Dropbox',
      root: dropbox,
      installPath: path.join(appData, 'Dropbox'),
      accountHint: dropboxAccount(appData, home)
    });
  }

  return clients;
}

/**
 * The signed-in Google account, when the client leaves it readable.
 * Google Drive for Desktop keeps a SQLite config; the string is lightly
 * obfuscated but not encrypted. A failure here is NEVER fatal — the sync
 * simply runs without an account check.
 */
function googleAccount(localApp, home) {
  const candidates = [
    path.join(localApp, 'Google', 'Drive', 'sync_config.db'),
    path.join(localApp, 'Google', 'DriveFS', 'accounts.db'),
    path.join(localApp, 'Google', 'Drive', 'accounts.db')
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw = fs.readFileSync(f);
      const m = raw.toString('latin1').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (m) return m[0];
    } catch (e) { /* unreadable — no account check */ }
  }
  // the old client stored a plain "last account" file
  try {
    const p = path.join(home, '.config', 'google_drive_sync_config.json');
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf8').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (m) return m[0];
    }
  } catch (e) { /* ignore */ }
  return '';
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

/**
 * One click: the user types an e-mail, the program does the rest.
 * @param {object} db        the db module (for backupTo / settings)
 * @param {string} email     the cloud account e-mail
 * @param {string} [clientId] which detected cloud client to use
 */
async function syncByEmail(db, email, clientId) {
  const clean = String(email || '').trim();
  if (!EMAIL_RE.test(clean)) throw new Error('اكتب بريداً إلكترونياً صحيحاً مثل name@gmail.com');

  const clients = detectClients();
  if (!clients.length) {
    throw new Error(
      'لم يُعثر على برنامج سحابي على هذا الجهاز (Google Drive أو OneDrive أو Dropbox). ' +
      'ثبّت Google Drive for Desktop وسجّل الدخول بحسابك ثم أعد المحاولة — أو استخدم «نسخة احتياطية» لاختيار مجلد بنفسك.'
    );
  }
  const client = clientId ? clients.find((c) => c.id === clientId) : null;
  if (clientId && !client) throw new Error('برنامج السحابة المطلوب غير موجود على هذا الجهاز');
  const chosen = client || clients[0];

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
    warning: mismatch
      ? `الحساب المسجّل في ${chosen.label} هو «${account}» وليس «${clean}» — سيُرفع الملف إلى الحساب المسجّل.`
      : (account ? '' : `لم نتمكن من قراءة الحساب المسجّل في ${chosen.label} — تأكد أن الملف يُرفع إلى ${clean}.`)
  };
}

/** what the settings screen shows before the user presses the button */
function status(db) {
  const clients = detectClients();
  const email = db.getSetting('sync.email');
  const clientId = db.getSetting('sync.client');
  const chosen = clients.find((c) => c.id === clientId) || null;
  return {
    email,
    clients: clients.map((c) => ({ id: c.id, label: c.label, root: c.root, account: c.accountHint || '' })),
    activeClient: chosen ? { id: chosen.id, label: chosen.label, root: chosen.root } : null,
    account: chosen ? chosen.accountHint : '',
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

module.exports = { detectClients, syncByEmail, status, openInstallerPage, stamp };
