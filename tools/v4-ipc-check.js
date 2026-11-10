'use strict';

/**
 * tools/v4-ipc-check.js — verifies the V4 main-process additions:
 *   · the Excel writer produces a readable workbook with sane page setup
 *   · the data-dir module resolves / remembers / exports without data loss
 *   · the cloud-sync module detects clients and validates the e-mail
 *   · every new IPC operation is present in the API allow-list AND in the
 *     permission map (a missing entry means "عملية غير معروفة" at runtime)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + name + ' :: ' + JSON.stringify(detail)); }
  else { fail += 1; console.log('FAIL  ' + name + ' :: ' + JSON.stringify(detail)); }
}

const TMP = path.join(__dirname, '..', '.tmp', 'v4ipc');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

(async () => {
  /* ---------------- 1. Excel writer ---------------- */
  const { writeWorkbook } = require('../src/main/xlsx');
  const xlsxPath = path.join(TMP, 'report.xlsx');
  let info = null;
  try {
    info = await writeWorkbook({
      filePath: xlsxPath,
      title: 'حركة المخزون',
      subtitle: 'من 2026-01-01 إلى 2026-11-10',
      meta: [['المخزن', 'مخزن أ'], ['عدد السطور', '3']],
      sheetName: 'الحركة',
      landscape: false,
      columns: [
        { header: 'التاريخ', key: 'date' },
        { header: 'رقم المستند', key: 'docNo' },
        { header: 'الصنف', key: 'itemName' },
        { header: 'الوارد', key: 'inQty', num: true },
        { header: 'الصادر', key: 'outQty', num: true }
      ],
      rows: [
        { date: '2026-01-01', docNo: 'PUR-0001', itemName: 'صنف أول طويل الاسم', inQty: 120, outQty: 0 },
        { date: '2026-01-02', docNo: 'SAL-0001', itemName: 'صنف ثانٍ', inQty: 0, outQty: 45 },
        { date: '2026-01-03', docNo: 'SAL-0002', itemName: 'صنف ثالث', inQty: 10, outQty: 7 }
      ],
      totals: [{ key: 'inQty', value: 130, label: 'الإجمالي' }, { key: 'outQty', value: 52 }]
    });
    check('writeWorkbook writes a file', !!info && info.size > 3000, info);
  } catch (e) {
    check('writeWorkbook writes a file', false, { message: e.message });
  }

  /* read the produced workbook back and inspect its page setup */
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const ws = wb.worksheets[0];
    const ps = ws.pageSetup || {};
    check('the sheet is right-to-left', ws.views && ws.views[0] && ws.views[0].rightToLeft === true, ws.views);
    check('fitToPage is on', ps.fitToPage === true, ps);
    check('fitToWidth is 1 (one page wide)', ps.fitToWidth === 1, { fitToWidth: ps.fitToWidth });
    check('fitToHeight is 0 (as many pages as needed, NOT squeezed on one)', ps.fitToHeight === 0, { fitToHeight: ps.fitToHeight });
    check('the sheet is horizontally centred', ps.horizontalCentered === true, { horizontalCentered: ps.horizontalCentered });
    check('the paper is A4', ps.paperSize === 9, { paperSize: ps.paperSize });
    check('the orientation follows the report', ps.orientation === 'portrait', { orientation: ps.orientation });

    // find the header row by its caption instead of guessing the row number
    const headerRowNo = Number((ps.printTitlesRow || '').split(':')[0]);
    check('the header row is declared for repeating on every page', !!headerRowNo, { printTitlesRow: ps.printTitlesRow });
    const headerRow = ws.getRow(headerRowNo);
    check('the header row carries the Arabic captions', headerRow.getCell(1).value === 'التاريخ', { value: headerRow.getCell(1).value });
    const headFont = headerRow.getCell(1).font || {};
    check('the header font is large enough to print', (headFont.size || 0) >= 12, { size: headFont.size });

    const bodyRowNo = headerRowNo + 1;
    const bodyFont = ws.getRow(bodyRowNo).getCell(1).font || {};
    check('the body font is large enough to print', (bodyFont.size || 0) >= 11.5, { size: bodyFont.size });

    const numCell = ws.getRow(bodyRowNo).getCell(4);
    check('numbers stay numbers', typeof numCell.value === 'number', { value: numCell.value, type: typeof numCell.value });
    check('the totals row carries the sums', ws.getRow(bodyRowNo + 3).getCell(4).value === 130, { value: ws.getRow(bodyRowNo + 3).getCell(4).value });
  } catch (e) {
    check('the produced workbook can be read back', false, { message: e.message });
  }

  /* ---------------- 2. data-dir module ---------------- */
  const datadir = require('../src/main/datadir');
  const fakeApp = { getPath: () => path.join(TMP, 'userdata') };
  fs.mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'picked'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'picked', 'sam.db'), 'FAKE-DB-BYTES');

  let di = datadir.info(fakeApp);
  check('the default folder is used when nothing was chosen', di.dir === path.join(TMP, 'userdata') && di.isCustom === false, di);
  check('the db file is named sam.db', di.dbFile.endsWith('sam.db'), { dbFile: di.dbFile });

  datadir.remember(fakeApp, path.join(TMP, 'picked'));
  di = datadir.info(fakeApp);
  check('the chosen folder is remembered', di.dir === path.join(TMP, 'picked') && di.isCustom === true, di);
  check('resolveDir follows the choice', datadir.resolveDir(fakeApp) === path.join(TMP, 'picked'), { resolved: datadir.resolveDir(fakeApp) });

  const exported = datadir.exportTo(fakeApp, path.join(TMP, 'exported'), path.join(TMP, 'picked', 'sam.db'));
  check('exportTo copies the database', fs.existsSync(exported.path), exported);
  check('exportTo never deletes the source', fs.existsSync(path.join(TMP, 'picked', 'sam.db')), { source: path.join(TMP, 'picked', 'sam.db') });
  check('the copy has the same bytes', fs.readFileSync(exported.path, 'utf8') === 'FAKE-DB-BYTES', { size: exported.size });

  datadir.forget(fakeApp);
  di = datadir.info(fakeApp);
  check('forget returns to the default folder', di.isCustom === false, di);

  /* ---------------- 3. cloud sync ---------------- */
  const cloudsync = require('../src/main/cloudsync');
  const clients = cloudsync.detectClients();
  check('cloud client detection does not crash', Array.isArray(clients), { found: clients.map((c) => c.label) });

  const fakeDb = {
    backupTo: async (f) => { fs.writeFileSync(f, 'DB'); return { path: f, size: 2 }; },
    setSetting: (k, v) => { fakeDb._s[k] = v; },
    getSetting: (k) => fakeDb._s[k] || '',
    _s: {}
  };
  let rejected = null;
  try { await cloudsync.syncByEmail(fakeDb, 'not-an-email'); } catch (e) { rejected = e.message; }
  check('a malformed e-mail is rejected', !!rejected && /بريد/.test(rejected), { message: rejected });

  /* ---------------- 4. IPC allow-list + permissions ---------------- */
  const ipcDbPath = path.join(__dirname, '..', 'src', 'main', 'ipc-db.js');
  const src = fs.readFileSync(ipcDbPath, 'utf8');
  const apiBlock = (src.match(/const API = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const permBlock = (src.match(/const PERMS = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const apiNames = new Set((apiBlock.match(/^\s{2}(\w+):/gm) || []).map((s) => s.trim().replace(':', '')));
  const permNames = new Set((permBlock.match(/^\s{2}(\w+):/gm) || []).map((s) => s.trim().replace(':', '')));

  /* read-only helpers are allowed without an explicit rule; every WRITE or
     DELETE must be guarded by a permission rule */
  const WRITE_OPS = /^(save|add|update|delete|remove|set|clear|saveDocument|deleteDocument|deleteItem|deleteParty|deleteWarehouse|deleteMove|deleteReceipt|deleteIssue|deleteTolling|deleteScrap|deleteArchive|saveReceipt|saveIssue|saveTolling|saveArchive|saveUser|setProdRouting|saveXlsx)$/;
  const unguardedWrites = [...apiNames].filter((n) => WRITE_OPS.test(n) && !permNames.has(n));
  check('every write operation is guarded by a permission rule', unguardedWrites.length === 0, { unguarded: unguardedWrites });
  check('the new V4 read operations are reachable', apiNames.has('runReport') && apiNames.has('REPORTS'), {
    runReport: apiNames.has('runReport'), REPORTS: apiNames.has('REPORTS')
  });
  check('the new V4 read operations have a permission rule too', permNames.has('runReport') && permNames.has('REPORTS'), {
    runReport: permNames.has('runReport'), REPORTS: permNames.has('REPORTS')
  });

  /* ---------------- 5. preload exposes the new bridges ---------------- */
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  ['printers', 'datadir', 'cloud', 'backup'].forEach((k) => {
    check(`preload exposes "${k}"`, preloadSrc.includes(k), { key: k });
  });

  /* ---------------- 6. the IPC handlers actually register ---------------- */
  const registered = [];
  const fakeIpcMain = { handle: (ch) => registered.push(ch) };
  const fakeElectron = {
    ipcMain: fakeIpcMain,
    BrowserWindow: { fromWebContents: () => null },
    app: { getPath: () => path.join(TMP, 'userdata'), isPackaged: false, getVersion: () => '0.4.0' },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => '' }
  };
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return origLoad.apply(this, arguments);
  };
  try {
    require('../src/main/ipc')(() => null);
  } catch (e) {
    check('ipc.js registers without throwing', false, { message: e.message });
  }
  Module._load = origLoad;
  Module._resolveFilename = origResolve;
  ['win:print', 'win:printers', 'win:savePdf'].forEach((ch) => {
    check(`the channel "${ch}" is registered`, registered.includes(ch), { channels: registered.length });
  });

  console.log(`\n${pass}/${pass + fail} IPC checks passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
