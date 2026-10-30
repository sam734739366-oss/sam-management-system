'use strict';

/**
 * All main-process IPC handlers live here so both the real app (main.js)
 * and the smoke-test harness (tools/shot.js) register the identical surface.
 * @param {() => import('electron').BrowserWindow | null} getWindow
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

module.exports = function registerIpc(getWindow) {
  const fromEvent = (event) => BrowserWindow.fromWebContents(event.sender) || getWindow();

  /* ---- window chrome ---- */
  ipcMain.handle('win:minimize', (e) => { const w = fromEvent(e); if (w) w.minimize(); });
  ipcMain.handle('win:maximize', (e) => { const w = fromEvent(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
  ipcMain.handle('win:close', (e) => { const w = fromEvent(e); if (w) w.close(); });
  ipcMain.handle('win:isMaximized', (e) => { const w = fromEvent(e); return w ? w.isMaximized() : false; });

  /* ---- printing ---- */
  ipcMain.handle('win:print', async (e, opts = {}) => {
    const w = fromEvent(e);
    if (!w) return { ok: false, error: 'no-window' };
    return new Promise((resolve) => {
      w.webContents.print(
        {
          silent: false,
          printBackground: true,
          copies: 1,
          pageSize: { width: 21000, height: 29700 }, // A4, 1/100 mm
          margins: { marginType: 'custom', top: 50, bottom: 50, left: 50, right: 50 },
          ...opts
        },
        (success, failureReason) => resolve({ ok: !!success, error: failureReason || null })
      );
    });
  });

  ipcMain.handle('win:savePdf', async (e, opts = {}) => {
    const w = fromEvent(e);
    if (!w) return { ok: false, error: 'no-window' };
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: 'حفظ كملف PDF',
      defaultPath: opts.fileName || `SAM-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const data = await w.webContents.printToPDF({
      printBackground: true,
      landscape: !!opts.landscape,
      pageSize: 'A4',
      marginLeft: 0.2,
      marginRight: 0.2,
      marginTop: 0.25,
      marginBottom: 0.25
    });
    fs.writeFileSync(filePath, data);
    return { ok: true, path: filePath };
  });

  /* ---- navigation ---- */
  ipcMain.handle('nav:toMain', (e) => {
    const w = fromEvent(e);
    if (w) w.loadFile(path.join(RENDERER, 'app.html'));
    return true;
  });
  ipcMain.handle('nav:toLogin', (e) => {
    const w = fromEvent(e);
    if (w) w.loadFile(path.join(RENDERER, 'login.html'));
    return true;
  });

  /* ---- app info ---- */
  ipcMain.handle('app:info', () => {
    let dbPath = null;
    try { dbPath = require('./db').summary().dbPath || null; } catch (e) { /* db not initialised yet */ }
    return {
      version: require(path.join(ROOT, 'package.json')).version,
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
      appData: app.getPath('userData'),
      dbPath
    };
  });
  ipcMain.handle('app:openPath', async (_e, target) => {
    if (typeof target !== 'string' || !target) return false;
    await shell.openPath(target);
    return true;
  });

  /* Export helper: save text content (CSV / HTML) chosen by the renderer. */
  ipcMain.handle('app:saveFile', async (e, opts = {}) => {
    const w = fromEvent(e);
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: opts.title || 'حفظ الملف',
      defaultPath: opts.fileName || `SAM-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: opts.filters || [{ name: 'All files', extensions: ['*'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, String(opts.content == null ? '' : opts.content), 'utf8');
    return { ok: true, path: filePath };
  });

  /* Real .xlsx export — exceljs builds the workbook in this process. */
  ipcMain.handle('app:saveXlsx', async (e, spec = {}) => {
    const w = fromEvent(e);
    const name = spec.fileName || `SAM-Report-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: spec.title || 'تصدير Excel',
      defaultPath: /\.xlsx$/i.test(name) ? name : name.replace(/\.[a-z0-9]+$/i, '') + '.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const info = await require('./xlsx').writeWorkbook({ ...spec, filePath });
      return { ok: true, data: info };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
};
