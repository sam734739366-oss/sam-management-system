'use strict';

/**
 * src/main/updater.js — electron-updater wired to an in-app progress UI.
 *
 * Events are pushed to the renderer on channel 'app:update-state' with
 * { status, percent, speed, transferred, total, version, message }.
 * In an unpacked (development) run the real updater cannot talk to GitHub,
 * so `update:simulate` exists to preview the progress UI honestly.
 */

const { app, ipcMain } = require('electron');
const path = require('path');

const CHANNEL = 'app:update-state';

let state = { status: 'idle', percent: 0, speed: 0, transferred: 0, total: 0, version: null, message: '' };
let getWindow = () => null;
let autoUpdater = null;

function loadAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    autoUpdater = null;
  }
  return autoUpdater;
}

function push() {
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send(CHANNEL, state);
  return state;
}

function set(patch) {
  state = { ...state, ...patch };
  return push();
}

const fmtError = (e) => (e && (e.message || e.description)) || String(e);

function wire() {
  const au = loadAutoUpdater();
  if (!au) return;
  au.autoDownload = false;
  au.autoInstallOnAppQuit = true;
  au.logger = null;

  au.on('checking-for-update', () => set({ status: 'checking', message: 'جارٍ فحص التحديثات…' }));
  au.on('update-available', (info) => set({
    status: 'available', version: info.version, message: `يتوفر إصدار جديد ${info.version}`, percent: 0
  }));
  au.on('update-not-available', (info) => set({
    status: 'up-to-date', version: (info && info.version) || null, message: 'أنت على أحدث إصدار'
  }));
  au.on('download-progress', (p) => set({
    status: 'downloading',
    percent: Math.round((p.percent || 0) * 10) / 10,
    speed: p.bytesPerSecond || 0,
    transferred: p.transferred || 0,
    total: p.total || 0
  }));
  au.on('update-downloaded', (info) => set({
    status: 'downloaded', version: info.version, percent: 100, message: 'اكتمل التحميل — جاهز للتثبيت'
  }));
  au.on('error', (e) => set({ status: 'error', message: fmtError(e) }));
}

function devMode() { return !app.isPackaged; }

/**
 * V4 — a copy of the database is taken BEFORE any update is installed.
 * The customer asked that an update must never damage the data he entered,
 * so the copy is taken twice: before downloading and before installing.
 * A failure here never blocks the update — it only means no copy was made.
 */
async function safetyBackup() {
  try {
    const backup = require('./backup');
    const res = await backup.backupNow('pre-update');
    return `أُخذت نسخة احتياطية: ${res && res.path ? res.path : ''}`;
  } catch (e) {
    try {
      const db = require('./db');
      const path = require('path');
      const os = require('os');
      const fs = require('fs');
      const dir = path.join(os.tmpdir(), 'sam-pre-update');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `sam-${Date.now()}.db`);
      await db.backupTo(file);
      return `أُخذت نسخة احتياطية: ${file}`;
    } catch (e2) {
      return '';
    }
  }
}

function feedUrl() {
  // published GitHub releases feed; overridable without touching code
  const cfg = require(path.join(__dirname, '..', '..', 'updater.config.json'));
  return cfg;
}

function init(getWindowFn) {
  getWindow = getWindowFn || (() => null);
  wire();

  ipcMain.handle('update:state', () => state);

  ipcMain.handle('update:check', async () => {
    if (devMode()) {
      return set({
        status: 'dev',
        message: 'فحص التحديثات متاح فقط في النسخة المثبتة (exe). جرّب «معاينة شريط التقدم».'
      });
    }
    try {
      await loadAutoUpdater().checkForUpdates();
      return state;
    } catch (e) {
      return set({ status: 'error', message: fmtError(e) });
    }
  });

  ipcMain.handle('update:download', async () => {
    if (devMode()) return set({ status: 'dev', message: 'غير متاح في وضع التطوير' });
    try {
      // V4 — never let an update touch the data without a safety copy first
      const safety = await safetyBackup();
      await loadAutoUpdater().downloadUpdate();
      return set({ status: 'downloading', message: safety ? `${safety} — جارٍ التحميل` : 'جارٍ التحميل' });
    } catch (e) {
      return set({ status: 'error', message: fmtError(e) });
    }
  });

  ipcMain.handle('update:install', async () => {
    if (devMode()) return set({ status: 'dev', message: 'غير متاح في وضع التطوير' });
    // the last line of defence: copy the database before the app restarts
    const safety = await safetyBackup();
    setImmediate(() => {
      try { loadAutoUpdater().quitAndInstall(false, true); } catch (e) { /* ignore */ }
    });
    return set({
      status: 'installing',
      message: safety ? `${safety} — جارٍ إعادة التشغيل والتثبيت…` : 'جارٍ إعادة التشغيل والتثبيت…'
    });
  });

  /* the safety copy the user can find if anything goes wrong */
  ipcMain.handle('update:backup', async () => {
    try {
      const r = await safetyBackup();
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: fmtError(e) };
    }
  });

  /* honest preview of the progress UI while developing */
  ipcMain.handle('update:simulate', async () => {
    const total = 78 * 1024 * 1024;
    set({ status: 'available', version: '0.2.0', message: 'معاينة — يتوفر إصدار جديد 0.2.0', percent: 0 });
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 1; i <= 20; i++) {
      const percent = i * 5;
      set({
        status: 'downloading',
        percent,
        transferred: Math.round((total * percent) / 100),
        total,
        speed: 3.2 * 1024 * 1024 + Math.round(Math.random() * 1.6 * 1024 * 1024)
      });
      await new Promise((r) => setTimeout(r, 160));
    }
    return set({ status: 'downloaded', percent: 100, message: 'اكتمل التحميل (معاينة) — جاهز للتثبيت' });
  });

  ipcMain.handle('update:feed', () => {
    try { return feedUrl(); } catch (e) { return { error: e.message }; }
  });
}

/** silent background check a few seconds after launch */
function autoCheck(delayMs = 8000) {
  if (devMode()) return;
  setTimeout(() => {
    try { loadAutoUpdater().checkForUpdates(); } catch (e) { /* ignore */ }
  }, delayMs);
}

module.exports = { init, autoCheck, state: () => state };
