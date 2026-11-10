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

/**
 * Chromium reports printer failures as short English codes; the user needs
 * to know WHAT to do, so each code is translated into an Arabic sentence.
 */
function friendlyPrintError(reason) {
  const r = String(reason || '').trim();
  if (!r) return 'فشلت الطباعة — تحقق من وجود الطابعة واتصالها';
  const map = [
    [/cancel/i, 'أُلغيت الطباعة — لم تُطبع المستندات'],
    [/spool/i, 'طابعة Windows (Spooler) متوقفة — أعد تشغيل خدمة الطباعة'],
    [/paper/i, 'لا يوجد ورق في الطابعة'],
    [/ink|toner/i, 'حبر أو تونر الطابعة منخفض — غيّره ثم أعد المحاولة'],
    [/offline|not.*connected/i, 'الطابعة غير متصلة بالجهاز'],
    [/access|denied|permission/i, 'لا يوجد صلاحية للطباعة على هذه الطابعة'],
    [/no printer|printer.*not.*found/i, 'لم يُعثر على طابعة — اختر طابعة من القائمة']
  ];
  for (const [re, msg] of map) if (re.test(r)) return `${msg} (${r})`;
  return `فشلت الطباعة: ${r}`;
}

module.exports = function registerIpc(getWindow) {
  const fromEvent = (event) => BrowserWindow.fromWebContents(event.sender) || getWindow();

  /* ---- window chrome ---- */
  ipcMain.handle('win:minimize', (e) => { const w = fromEvent(e); if (w) w.minimize(); });
  ipcMain.handle('win:maximize', (e) => { const w = fromEvent(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
  ipcMain.handle('win:close', (e) => { const w = fromEvent(e); if (w) w.close(); });
  ipcMain.handle('win:isMaximized', (e) => { const w = fromEvent(e); return w ? w.isMaximized() : false; });

  /* ---- printing ---- */

  /**
   * V4 — printing must work on ANY printer the machine has.
   * The old code forced `pageSize: A4` and custom margins on every job; when
   * the selected printer could not honour that (a receipt printer, a label
   * printer, a driver that rejects a custom page) Chromium aborted the job
   * and the user saw "الطباعة أُلغيت أو فشلت".
   * Now the page is driven by CSS (@page) and the printer's own defaults,
   * and a failure carries the real reason so the UI can explain it.
   */
  ipcMain.handle('win:print', async (e, opts = {}) => {
    const w = fromEvent(e);
    if (!w) return { ok: false, error: 'لا توجد نافذة للطباعة' };
    const { landscape, deviceName, copies, silent, pageSize, margins, ...rest } = opts || {};
    const printOptions = {
      silent: silent === true,
      printBackground: true,
      copies: Math.max(1, Number(copies) || 1),
      landscape: !!landscape,
      ...(deviceName ? { deviceName } : {}),
      ...(pageSize ? { pageSize } : {}),
      ...(margins ? { margins } : {}),
      ...rest
    };
    return new Promise((resolve) => {
      let settled = false;
      const done = (payload) => { if (!settled) { settled = true; resolve(payload); } };
      // Chromium never calls back when the printer dialog is dismissed by the
      // user — a silent timeout keeps the UI from hanging forever.
      const guard = setTimeout(() => {
        done({ ok: false, error: 'لم تُرجع الطباعة نتيجة — تحقق من الطابعة ثم أعد المحاولة', timeout: true });
      }, 120000);
      try {
        w.webContents.print(printOptions, (success, failureReason) => {
          clearTimeout(guard);
          if (success) done({ ok: true });
          else done({ ok: false, error: friendlyPrintError(failureReason) });
        });
      } catch (err) {
        clearTimeout(guard);
        done({ ok: false, error: friendlyPrintError((err && err.message) || String(err)) });
      }
    });
  });

  /** the printers this machine can print on — the app never assumes one */
  ipcMain.handle('win:printers', async () => {
    const w = fromEvent(e);
    if (!w) return { ok: false, error: 'لا توجد نافذة' };
    try {
      const list = await w.webContents.getPrinters();
      return {
        ok: true,
        data: (list || []).map((p) => ({
          name: p.name,
          displayName: p.displayName || p.name,
          description: p.description || '',
          status: p.status || 0,
          isDefault: !!p.isDefault,
          printerName: p.printerName || ''
        }))
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('win:savePdf', async (e, opts = {}) => {
    const w = fromEvent(e);
    if (!w) return { ok: false, error: 'لا توجد نافذة للطباعة' };
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: 'حفظ كملف PDF',
      defaultPath: opts.fileName || `SAM-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const data = await w.webContents.printToPDF({
        printBackground: true,
        landscape: !!opts.landscape,
        pageSize: opts.pageSize || 'A4',
        preferCSSPageSize: opts.preferCSSPageSize !== false,
        marginLeft: 0.2,
        marginRight: 0.2,
        marginTop: 0.25,
        marginBottom: 0.25
      });
      fs.writeFileSync(filePath, data);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: friendlyPrintError((err && err.message) || String(err)) };
    }
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
