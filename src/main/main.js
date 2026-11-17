'use strict';

/* The very first thing we do is open a log file with plain Node APIs, so that
   even a failure while loading the rest of this file leaves a trace. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STARTUP_LOG = path.join(os.tmpdir(), 'sam-startup.log');
function startupLog(msg) {
  const line = `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`;
  try { fs.appendFileSync(STARTUP_LOG, line); } catch (e) { /* ignore */ }
  try { console.log(line.trim()); } catch (e) { /* ignore */ }
}
startupLog('main module loading');

let app, BrowserWindow, Menu, shell, nativeImage, dialog;
let registerIpc;
try {
  ({ app, BrowserWindow, Menu, shell, nativeImage, dialog } = require('electron'));
  registerIpc = require('./ipc');
  startupLog('requires ok');
} catch (e) {
  startupLog('FATAL while requiring modules: ' + (e && e.stack ? e.stack : e));
  throw e;
}

/* Sound + animations must be able to start without a user gesture. */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('SAM Management System');

process.on('uncaughtException', (e) => {
  startupLog('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
  try { dialog.showErrorBox('خطأ غير متوقع في نظام SAM', String((e && e.message) || e)); } catch (err) { /* ignore */ }
  app.exit(1);
});
process.on('unhandledRejection', (e) => startupLog('UNHANDLED: ' + (e && e.stack ? e.stack : e)));
startupLog(`boot packaged=${app.isPackaged} electron=${process.versions.electron} log=${STARTUP_LOG}`);

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ICON_PNG = path.join(ROOT, 'build', 'icon.png');
const ICON_ICO = path.join(ROOT, 'build', 'icon.ico');

let mainWindow = null;

/* V9 — a note the customer must see in Arabic (the data folder was
   repaired, or the data was moved to a folder that accepts writes).
   It lives in src/main/notice.js so the window can read it. */

function windowIcon() {
  try {
    if (process.platform === 'win32' && fs.existsSync(ICON_ICO)) {
      const img = nativeImage.createFromPath(ICON_ICO);
      if (!img.isEmpty()) return img;
    }
    if (fs.existsSync(ICON_PNG)) {
      const img = nativeImage.createFromPath(ICON_PNG);
      if (!img.isEmpty()) return img;
    }
  } catch (err) {
    console.warn('icon load failed:', err.message);
  }
  return nativeImage.createEmpty();
}

/**
 * V9 — the customer never sees an English stack trace.
 *
 * The most common failure is a data folder that arrived from another
 * machine with the Windows read-only mark still on it. SQLite reads the
 * file, then dies on the first write, and the whole program closes before
 * the window appears. The message says what happened, where the data is,
 * and what to do — in Arabic, in three lines.
 */
function startupErrorMessage(err, dataDir) {
  const raw = String((err && err.message) || err || '');
  const isReadonly = /readonly|read-only|attempt to write/i.test(raw);
  const lines = [];

  if (isReadonly) {
    lines.push('تعذّر الكتابة في مجلد البيانات — الملف محفوظ «للقراءة فقط».');
    lines.push('');
    lines.push('سبب ذلك: عادةً ما يكون مجلد البيانات قد نُسخ من جهاز آخر، فاحتفظ ويندوز بعلامة «للقراءة فقط».');
    lines.push('');
    lines.push('الحل: افتح المجلد التالي، وأنزع علامة «للقراءة فقط» من مجلده ومن ملف sam.db، ثم شغّل البرنامج:');
    lines.push(String(dataDir || ''));
    lines.push('');
    lines.push('بياناتك سليمة ولن تُفقد — الملف موجود ويمكن قراءته.');
  } else {
    lines.push('حدث خطأ أثناء فتح قاعدة البيانات.');
    if (dataDir) {
      lines.push('');
      lines.push('مجلد البيانات:');
      lines.push(String(dataDir));
    }
    if (raw) {
      lines.push('');
      lines.push('التفاصيل التقنية: ' + raw);
    }
  }

  lines.push('');
  lines.push('سجل البرنامج كاملاً: ' + STARTUP_LOG);
  return lines.join('\n');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#f8fafc',
    title: 'SAM Management System',
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(RENDERER, 'login.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  const pushMaxState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('win:maximized', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', pushMaxState);
  mainWindow.on('unmaximize', pushMaxState);
  mainWindow.webContents.once('did-finish-load', pushMaxState);
  mainWindow.on('close', () => { mainWindow = null; });

  /* External links open in the default browser, never inside the app. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  startupLog('single-instance lock not held -> quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    let dataDir = '';
    try {
      startupLog('app ready');
      Menu.setApplicationMenu(null);
      const db = require('./db');
      /* V4 — the user may choose where the data lives; the choice is read
         before the database opens so the very first launch already honours it.
         applyPending runs first: when the user picked a new folder while the
         app was running, this copies the FRESH database into that folder —
         so nothing he typed after the pick is lost. */
      const datadir = require('./datadir');
      const pending = datadir.applyPending(app);
      if (pending) startupLog('data folder switched to ' + pending.dir + ' (copied=' + pending.copied + ')');
      let dataDir = datadir.resolveDir(app);

      /* V9 — the data folder can arrive READ-ONLY (copied from another
         machine over a USB drive or a network share keeps the Windows
         read-only mark). SQLite reads such a file perfectly, then dies on
         the first write — the program used to close with an English stack
         trace and no window at all. Here the mark is lifted, or the data is
         copied to a folder that accepts writes. Nothing is ever deleted. */
      let prep = null;
      try {
        prep = datadir.ensureUsable(app, dataDir);
        if (prep && prep.dir) dataDir = prep.dir;
        if (prep && prep.repaired) startupLog('data folder repaired: ' + prep.repaired + ' -> ' + dataDir);
      } catch (err) {
        startupLog('data folder check failed: ' + (err && err.message ? err.message : err));
      }
      db.init(dataDir);
      startupLog('database opened at ' + dataDir);
      /* the repair is worth telling the customer about — it is kept for the
         window to show it in Arabic the moment it appears */
      if (prep && prep.message) {
        require('./notice').set(prep.message, prep.relocated ? 'warn' : 'ok');
      }
      const session = require('./session');
      const seeded = session.ensureSeed();
      require('./ipc-db')();
      require('./ipc-auth')(() => mainWindow);
      registerIpc(() => mainWindow);
      const updater = require('./updater');
      updater.init(() => mainWindow);
      createWindow();
      startupLog('window created');
      if (seeded) startupLog('created default admin user');
      const backup = require('./backup');
      backup.autoSyncOnStart().then((r) => { if (r && r.error) startupLog('auto-sync: ' + r.error); }).catch(() => {});
      /* V5 — the cloud backup: the saved e-mail is enough. It runs a moment
         after the window is up, so the app never waits for the network. */
      setTimeout(() => {
        require('./cloudsync').autoSync(require('./db'))
          .then((r) => {
            if (r && r.ok) startupLog('cloud auto-sync -> ' + r.data.folder);
            else if (r && r.error) startupLog('cloud auto-sync: ' + r.error);
          })
          .catch(() => {});
      }, 8000);
      updater.autoCheck();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (err) {
      startupLog('STARTUP FAILED: ' + (err && err.stack ? err.stack : err));
      /* V9 — the customer gets an Arabic sentence, never an English stack
         trace. The technical detail stays in the log file. */
      dialog.showErrorBox('تعذّر تشغيل نظام SAM', startupErrorMessage(err, dataDir));
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
