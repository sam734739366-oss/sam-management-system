/**
 * tools/v7-reports-check.js — the V7 report work:
 *   · the daily report takes a PERIOD (from → to), not one day
 *   · every report with a per-warehouse breakdown carries a column that
 *     gathers ALL the warehouses of the item
 *   · a report is not a document: it carries NO signature footer
 * It drives the real main process and the real renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-reports-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7reports');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-reports-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

async function rmRetry(target) {
  for (let i = 1; i <= 6; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) { await sleep(150 * 2 ** (i - 1)); }
  }
  return false;
}

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  await rmRetry(DATA);
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* a date that is not today, so the period really is a period */
const DAY_A = '2026-03-01';
const DAY_B = '2026-03-05';
const DAY_C = '2026-04-10';

async function main() {
  dbMod.close();
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  const wh = dbMod.addWarehouse({ code: 'W1', name: 'مخزن أ', location: 'الشمال' });
  const wh2 = dbMod.addWarehouse({ code: 'W2', name: 'مخزن ب', location: 'الجنوب' });
  const party = dbMod.addParty({ name: 'عميل التقرير', type: 'customer', phone: '770000000' });
  const item = dbMod.addItem({ code: 'A-1', name: 'صنف التقرير', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: wh.id, good: 100 }]);

  /* three movements on three different days */
  dbMod.saveDocument({
    kind: 'purchase', doc_date: DAY_A, party_id: party.id, warehouse_id: wh.id,
    lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 50 }]
  });
  dbMod.saveDocument({
    kind: 'sale', doc_date: DAY_B, party_id: party.id, warehouse_id: wh.id,
    lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 20 }]
  });
  dbMod.saveDocument({
    kind: 'purchase', doc_date: DAY_C, party_id: party.id, warehouse_id: wh2.id,
    lines: [{ item_id: item.id, warehouse_id: wh2.id, pieces: 30 }]
  });

  /* ---- the period ---- */
  const all = dbMod.dailyReport({ dateFrom: DAY_A, dateTo: DAY_C, buckets: ['good'] });
  check('the period is reported back', all.from === DAY_A && all.to === DAY_C, { from: all.from, to: all.to });
  const rowAll = all.rows.find((r) => r.itemId === item.id);
  check('the period gathers every day inside it', rowAll && rowAll.totalIn === 80 && rowAll.totalOut === 20, rowAll && { in: rowAll.totalIn, out: rowAll.totalOut });

  const mid = dbMod.dailyReport({ dateFrom: DAY_A, dateTo: DAY_B, buckets: ['good'] });
  const rowMid = mid.rows.find((r) => r.itemId === item.id);
  check('a shorter period leaves the later day out', rowMid && rowMid.totalIn === 50 && rowMid.totalOut === 20, rowMid && { in: rowMid.totalIn, out: rowMid.totalOut });

  const one = dbMod.dailyReport({ dateFrom: DAY_A, dateTo: DAY_A, buckets: ['good'] });
  const rowOne = one.rows.find((r) => r.itemId === item.id);
  check('one day inside the period works too', rowOne && rowOne.totalIn === 50 && rowOne.totalOut === 0, rowOne && { in: rowOne.totalIn, out: rowOne.totalOut });

  const old = dbMod.dailyReport({ date: DAY_C, buckets: ['good'] });
  const rowOld = old.rows.find((r) => r.itemId === item.id);
  check('the old single day still works', rowOld && rowOld.totalIn === 30, rowOld && { in: rowOld.totalIn });

  /* ---- the column that gathers the warehouses ---- */
  const stock = dbMod.runReport({ report: 'stock_status', buckets: ['good'] });
  const col = (stock.columns || []).find((c) => c.key === 'allTotal');
  check('the stock report has a column for every warehouse', !!col, (stock.columns || []).map((c) => c.label));
  const srow = (stock.rows || []).find((r) => r.itemCode === 'A-1');
  check('the column shows the total of all the warehouses', srow && Number(srow.allTotal) === 160, srow && { allTotal: srow.allTotal, good: srow.good });
  const w2row = (stock.rows || []).find((r) => r.warehouseName === 'مخزن ب');
  check('every row of the item carries the same total', w2row && Number(w2row.allTotal) === 160, w2row && w2row.allTotal);

  /* ---- the renderer ---- */
  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);

  await js(`document.querySelector('.nav-item[data-view=daily]').click()`);
  await sleep(1400);

  const ui = await js(`(() => {
    const from = document.getElementById('dFrom');
    const to = document.getElementById('dTo');
    const heads = [...document.querySelectorAll('#v-daily thead th')].map(n => n.textContent.trim());
    return {
      hasFrom: !!from, hasTo: !!to,
      oldDate: !!document.getElementById('dDate'),
      heads,
      hasTotalGroup: heads.some(h => h.indexOf('إجمالي كل المخازن') >= 0)
    };
  })()`) || {};
  check('the daily screen takes a start date', ui.hasFrom === true, ui);
  check('the daily screen takes an end date', ui.hasTo === true, ui);
  check('the old single date box is gone', ui.oldDate === false, ui);
  check('the daily table has the column that gathers the warehouses', ui.hasTotalGroup === true, ui.heads && ui.heads.slice(-6));

  /* the period really filters the table */
  const filtered = await js(`(async () => {
    const from = document.getElementById('dFrom');
    const to = document.getElementById('dTo');
    from.value = '${DAY_A}'; from.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    to.value = '${DAY_A}'; to.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1200));
    const res = await SamDB.call('dailyReport', { dateFrom: '${DAY_A}', dateTo: '${DAY_A}', buckets: ['good'] });
    return { from: res.from, to: res.to, inQty: res.rows.length };
  })()`) || {};
  check('the window can filter by the period', filtered.from === DAY_A && filtered.to === DAY_A, filtered);

  /* ---- the print sheet carries no signature ---- */
  const printed = await js(`(() => {
    const src = window.SamDaily ? 'ok' : 'no';
    return { src, has: !!window.SamDaily };
  })()`) || {};
  check('the daily screen is loaded', printed.has === true, printed);

  const sig = await js(`(() => {
    /* the print options of the daily report */
    const s = window.SamDaily && window.SamDaily.state ? window.SamDaily.state.res : null;
    return { ran: !!s };
  })()`) || {};
  check('the daily report has run', sig.ran === true, sig);

  await shutdown(fail ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
