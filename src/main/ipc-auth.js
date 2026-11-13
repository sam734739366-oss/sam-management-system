'use strict';

/**
 * src/main/ipc-auth.js — session, user management, backup and Drive sync IPC.
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const session = require('./session');
const backup = require('./backup');
const cloudsync = require('./cloudsync');
const datadir = require('./datadir');
const db = require('./db');
const restore = require('./restore');

const RENDERER = path.resolve(__dirname, '..', 'renderer');

module.exports = function registerAuthIpc(getWindow) {
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender) || getWindow();

  const wrap = (fn) => {
    try { return { ok: true, data: fn() }; }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  };

  const wrapAsync = async (fn) => {
    try { return { ok: true, data: await fn() }; }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  };

  /* ---------------- session ---------------- */
  ipcMain.handle('auth:login', (e, username, password) => wrap(() => {
    const user = session.login(username, password);
    const w = winOf(e);
    if (w) w.loadFile(path.join(RENDERER, 'app.html'));
    return user;
  }));

  ipcMain.handle('auth:logout', (e) => wrap(() => {
    session.logout();
    const w = winOf(e);
    if (w) w.loadFile(path.join(RENDERER, 'login.html'));
    return true;
  }));

  ipcMain.handle('auth:current', () => wrap(() => session.currentUser()));

  ipcMain.handle('auth:changePassword', (_e, oldPw, newPw) => wrap(() => session.changeOwnPassword(oldPw, newPw)));

  ipcMain.handle('app:meta', () => wrap(() => ({
    screens: db.ALL_SCREENS.map((key) => ({ key, label: session.SCREEN_LABELS[key] })),
    perms: db.ALL_PERMS.map((key) => ({ key, label: session.PERM_LABELS[key] }))
  })));

  /* ---------------- users (admin) ---------------- */
  ipcMain.handle('users:list', () => wrap(() => session.listUsers()));
  ipcMain.handle('users:save', (_e, payload) => wrap(() => session.saveUser(payload)));
  ipcMain.handle('users:remove', (_e, id) => wrap(() => session.removeUser(id)));

  /* ---------------- backup ---------------- */
  ipcMain.handle('backup:now', () => wrapAsync(() => backup.backupNow('manual')));
  ipcMain.handle('backup:list', () => wrap(() => backup.listBackups()));

  ipcMain.handle('backup:saveAs', async (e) => {
    const w = winOf(e);
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: 'حفظ نسخة من قاعدة البيانات',
      defaultPath: `sam-backup-${backup.stamp()}.db`,
      filters: [{ name: 'SAM database', extensions: ['db'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try { return { ok: true, data: await backup.saveCopyTo(filePath) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  /* ---------------- V7: bring a data file back into the program ---------------- */
  /* the customer has a file from another machine: he picks it, we look at it
     first, and only then does he confirm the restore */
  ipcMain.handle('restore:describe', (_e, file) => wrap(() => restore.describe(file)));

  ipcMain.handle('restore:pick', async (e) => {
    const w = winOf(e);
    const res = await dialog.showOpenDialog(w, {
      title: 'اختر ملف البيانات لاستعادته',
      properties: ['openFile'],
      defaultPath: app.getPath('documents'),
      filters: [
        { name: 'ملف بيانات SAM', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'كل الملفات', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try { return { ok: true, data: restore.describe(res.filePaths[0]) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('restore:fromPath', async (_e, file) => {
    try { return { ok: true, data: await restore.restoreFrom(file) }; }
    catch (err) { return { ok: false, error: (err && err.message) ? err.message : String(err) }; }
  });

  /* ---------------- Google Drive sync ---------------- */
  ipcMain.handle('sync:info', () => wrap(() => backup.syncInfo()));

  ipcMain.handle('sync:setConfig', (_e, cfg) => wrap(() => backup.setSyncConfig(cfg)));

  ipcMain.handle('sync:pickFolder', async (e) => {
    const w = winOf(e);
    const res = await dialog.showOpenDialog(w, {
      title: 'اختر مجلد Google Drive',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: path.join(app.getPath('home'), 'Google Drive')
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try { return { ok: true, data: backup.setSyncConfig({ folder: res.filePaths[0] }) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('sync:now', () => wrapAsync(() => backup.syncNow()));

  /* ---------------- V4: sync by e-mail only ---------------- */
  ipcMain.handle('cloud:status', () => wrap(() => cloudsync.status(db)));

  ipcMain.handle('cloud:sync', (_e, email, clientId) => wrapAsync(() => cloudsync.syncByEmail(db, email, clientId)));

  /* the automatic backup — the e-mail alone, every time the app opens */
  ipcMain.handle('cloud:auto', (_e, on) => wrap(() => cloudsync.setAuto(db, on)));

  ipcMain.handle('cloud:autoRun', () => wrapAsync(() => cloudsync.autoSync(db)));

  ipcMain.handle('cloud:installPage', (_e, clientId) => wrap(() => ({ url: cloudsync.openInstallerPage(clientId) })));

  /* ---------------- V4: where the data lives ---------------- */
  ipcMain.handle('datadir:info', () => wrap(() => datadir.info(app)));

  ipcMain.handle('datadir:pick', async (e) => {
    const w = winOf(e);
    const res = await dialog.showOpenDialog(w, {
      title: 'اختر مجلد الاحتفاظ بالبيانات',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: datadir.info(app).dir
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const picked = res.filePaths[0];
    if (!datadir.writable(picked)) return { ok: false, error: 'لا يمكن الكتابة في المجلد المختار' };
    try {
      /* the copy is immediate so the customer sees his data in the new
         folder at once — and the ORIGINAL file is never touched */
      const copy = datadir.exportTo(app, picked, db.dbFile());
      /* the live database path is remembered too: on the next launch the
         program copies the FRESH database over, so anything typed between
         the pick and the restart is not lost */
      const saved = datadir.remember(app, picked, db.dbFile());
      return { ok: true, data: { copy, info: saved, restartNeeded: true } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('datadir:reset', () => wrap(() => datadir.forget(app)));

  ipcMain.handle('datadir:export', async (e) => {
    const w = winOf(e);
    const res = await dialog.showOpenDialog(w, {
      title: 'اختر مجلد نسخة احتياطية',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('documents')
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try { return { ok: true, data: datadir.exportTo(app, res.filePaths[0], db.dbFile()) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
};
