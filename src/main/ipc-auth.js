'use strict';

/**
 * src/main/ipc-auth.js — session, user management, backup and Drive sync IPC.
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const session = require('./session');
const backup = require('./backup');
const db = require('./db');

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
};
