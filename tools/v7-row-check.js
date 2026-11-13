/**
 * tools/v7-row-check.js — the lines table of a document.
 *
 * The customer sent a picture: the row he added with «إضافة سطر» was
 * malformed — the «الحالة» buttons were squeezed into one line and every
 * column after them had slid to the left. The cause: the «الوجهة» column
 * (which exists only on a transfer) was hidden with an inline style on the
 * rows that existed when the editor opened — a row added later kept it, so
 * the row became one cell wider than the header.
 *
 * This harness proves that EVERY row of the table has the same columns and
 * the same widths — the first row and the rows the user adds later.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-row-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7row');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-row-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
const check = (name, ok, detail) => {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
};

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;

const ROWS = `(() => {
  const tables = [...document.querySelectorAll('.lines-tbl')];
  const tbl = tables[tables.length - 1];
  if (!tbl) return { err: 'no lines table' };
  const tb = tbl.querySelector('tbody');
  const rows = [...tb.querySelectorAll('tr')];
  const headCells = [...tbl.querySelectorAll('thead th')];
  const head = headCells.map(h => h.textContent.trim());
  return {
    head,
    rows: rows.length,
    visible: rows.map(r => [...r.children].filter(c => getComputedStyle(c).display !== 'none').length),
    headVisible: headCells.filter(c => getComputedStyle(c).display !== 'none').length,
    widths: rows.map(r => [...r.children].map(c => Math.round(c.getBoundingClientRect().width))),
    bucketWidths: rows.map(r => { const b = r.querySelector('.bucket-seg'); return b ? Math.round(b.getBoundingClientRect().width) : -1; }),
    bucketLabels: rows.map(r => [...r.querySelectorAll('.bucket-seg .b-btn')].map(b => b.textContent.trim()))
  };
})()`;

app.whenReady().then(async () => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();
  const wh = dbMod.addWarehouse({ code: 'W1', name: 'مخزن 1', location: '' });
  const wh2 = dbMod.addWarehouse({ code: 'W2', name: 'مخزن 2', location: '' });
  dbMod.addItem({ code: 'X-1', name: 'صنف', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: wh.id, good: 10 }, { warehouseId: wh2.id, good: 20 }]);

  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

  win = new BrowserWindow({
    width: 1600, height: 1000, show: false, frame: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 140) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(1000);

  /* ---- the entry permit: the kind of the picture ---- */
  await js(`(function(){ SamDocs.openEditor(null, 'gate_in'); return 1; })()`);
  await sleep(1400);
  const before = (await js(ROWS)) || {};
  check('the editor opened with one row', before.rows === 1, before);

  await js(`(function(){
    const bs = [...document.querySelectorAll('.editor button, .modal button')].filter(x => x.textContent.indexOf('إضافة سطر') >= 0);
    const b = bs[bs.length - 1];
    if (b) b.click();
    return 1;
  })()`);
  await sleep(900);
  const after = (await js(ROWS)) || {};

  check('the new row was added', after.rows === 2, after.rows);
  check('both rows show the same number of columns',
    after.visible && after.visible.length === 2 && after.visible[0] === after.visible[1], after.visible);
  check('both rows show as many columns as the header',
    after.visible && after.visible.length === 2 && after.visible[0] === after.headVisible, { row: after.visible, head: after.headVisible });
  check('the columns of the two rows have the same widths',
    after.widths && after.widths.length === 2 && JSON.stringify(after.widths[0]) === JSON.stringify(after.widths[1]), after.widths);
  check('the «الحالة» of the new row has the same room as the first',
    after.bucketWidths && after.bucketWidths.length === 2 && after.bucketWidths[0] === after.bucketWidths[1] && after.bucketWidths[1] > 100,
    after.bucketWidths);
  check('the «الحالة» of the new row still reads «سليم» and «تالف»',
    after.bucketLabels && after.bucketLabels[1] && after.bucketLabels[1].join(',') === 'سليم,تالف', after.bucketLabels);

  /* the party of the entry permit */
  const party = (await js(`(() => {
    const grids = [...document.querySelectorAll('.ed-grid')];
    const c = grids[grids.length - 1] ? grids[grids.length - 1].querySelector('.party-cell') : null;
    if (!c) return { err: 'no party cell' };
    return { display: getComputedStyle(c).display, label: (c.querySelector('.field-txt') || {}).textContent };
  })()`)) || {};
  check('the entry permit has a box for the customer', party.display && party.display !== 'none', party);
  check('the box is named after the customer', /العميل/.test(party.label || ''), party.label);

  /* ---- a transfer keeps its destination column in EVERY row ---- */
  await js(`(function(){ document.querySelector('.ed-close, .modal .btn-ghost')?.click(); return 1; })()`);
  await sleep(700);
  await js(`(function(){ SamDocs.openEditor(null, 'transfer'); return 1; })()`);
  await sleep(1400);
  await js(`(function(){
    const bs = [...document.querySelectorAll('.editor button, .modal button')].filter(x => x.textContent.indexOf('إضافة سطر') >= 0);
    const b = bs[bs.length - 1];
    if (b) b.click();
    return 1;
  })()`);
  await sleep(900);
  const tr = (await js(ROWS)) || {};
  check('the transfer keeps the destination column in every row',
    tr.visible && tr.visible.length === 2 && tr.visible[0] === tr.visible[1] && tr.visible[0] === tr.headVisible, { rows: tr.visible, head: tr.headVisible });
  check('the rows of the transfer have the same widths',
    tr.widths && tr.widths.length === 2 && JSON.stringify(tr.widths[0]) === JSON.stringify(tr.widths[1]), tr.widths);

  await shutdown(fail ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
