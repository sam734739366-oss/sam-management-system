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
      const dataDir = datadir.resolveDir(app);
      db.init(dataDir);
      startupLog('database opened at ' + dataDir);
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
      updater.autoCheck();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (err) {
      startupLog('STARTUP FAILED: ' + (err && err.stack ? err.stack : err));
      dialog.showErrorBox('تعذّر تشغيل نظام SAM', String((err && err.stack) || err));
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
