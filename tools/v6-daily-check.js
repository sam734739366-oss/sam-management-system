/**
 * tools/v6-daily-check.js — end-to-end verification of V6-2:
 * «التقرير اليوم اريد دخول وخروج وارد وصادر ومتبقي لكل مخزن والمتبقي الاجمالي»
 *
 * The report must show, for EVERY warehouse:
 *   · وارد اليوم   — what came IN that day
 *   · صادر اليوم   — what went OUT that day
 *   · المتبقي       — what is still in that warehouse
 * and then the grand total of the remaining stock.
 *
 * It checks the numbers in the DATABASE first, then the SCREEN the user
 * actually reads, then the PRINTED sheet.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v6-daily-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v6daily');
const DATA = path.join(ROOT, '.tmp', 'v6dailydata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v6-daily-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
try { fs.writeFileSync(LOG, ''); } catch (e) {}
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
/** the digits of a formatted number — "21,300" becomes 21300 */
const num = (v) => String(v == null ? '' : v).replace(/[^\d.-]/g, '').replace(/-$/, '') === '' ? 0 : Number(String(v).replace(/[^\d.-]/g, ''));

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) {
      if (attempt === tries) { logLine('WARN: ' + label + ' still locked (' + e.code + ')'); return false; }
      await sleep(base * 2 ** (attempt - 1));
    }
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
  await rmRetry(DATA, { label: 'data dir' });
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
logLine('--- ipc modules loaded ---');

async function shot(name, settle = 700) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(`(() => {
      try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); } catch (e) {}
      return 1;
    })()`, true);
  } catch (e) {}
  try { win.webContents.invalidate(); } catch (e) {}
  await sleep(200);
  try { await win.webContents.capturePage(); } catch (e) {}
  await sleep(160);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  logLine('shot -> ' + name);
}

app.whenReady().then(async () => {
  try { await run(); }
  catch (e) { fail++; logLine('FAIL  the harness crashed :: ' + (e && e.stack ? e.stack : e)); }
  logLine('\n' + pass + ' passed, ' + fail + ' failed');
  if (errors.length) logLine('CONSOLE ERRORS:\n' + errors.join('\n'));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });

async function run() {
  dbMod.close();
  await rmRetry(DATA);
  await rmRetry(OUT, { tries: 4 });
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* ---------------- the seed: two warehouses, two items ----------------
     yesterday opens the balances, today moves the stock */
  const TODAY = dbMod.dailyReport({ date: '' }).date;
  const YESTERDAY = (() => {
    const d = new Date(TODAY + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  logLine('today = ' + TODAY + ' · yesterday = ' + YESTERDAY);

  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'الطرف الغربي' });
  const item1 = dbMod.addItem({ code: '1001', name: 'صنف أول', base_unit: 'حبة', category: 'منتج' }, []);
  const item2 = dbMod.addItem({ code: '1002', name: 'صنف ثانٍ', base_unit: 'حبة', category: 'منتج' }, []);
  const supplier = dbMod.addParty({ name: 'مورد الاختبار', type: 'supplier', phone: '770000001' });
  const customer = dbMod.addParty({ name: 'عميل الاختبار', type: 'customer', phone: '770000002' });

  const buy = (date, item, wh, pieces) => dbMod.saveDocument({
    kind: 'purchase', doc_date: date, party_id: supplier.id, warehouse_id: wh,
    lines: [{ item_id: item.id, warehouse_id: wh, bucket: 'good', pieces }]
  });
  const sell = (date, item, wh, pieces) => dbMod.saveDocument({
    kind: 'sale', doc_date: date, party_id: customer.id, warehouse_id: wh,
    lines: [{ item_id: item.id, warehouse_id: wh, bucket: 'good', pieces }]
  });

  buy(YESTERDAY, item1, whA.id, 500);
  buy(YESTERDAY, item2, whA.id, 300);
  buy(YESTERDAY, item2, whB.id, 100);
  buy(TODAY, item1, whA.id, 100);
  buy(TODAY, item1, whB.id, 60);
  sell(TODAY, item2, whB.id, 30);

  /* ================= 1. the numbers of the report ================= */
  const res = dbMod.dailyReport({ date: TODAY, buckets: ['good'] });
  check('the report knows the day it was asked about', res.date === TODAY, res.date);
  check('the report lists every warehouse', res.warehouses.length >= 2, res.warehouses.map((w) => w.name));

  const rowOf = (code) => res.rows.find((r) => r.itemCode === code);
  const r1 = rowOf('1001'), r2 = rowOf('1002');
  const cell = (row, whId, key) => (row.cells[whId] || {})[key];

  check('«صنف أول» — what came IN to «مخزن أ» today',
    cell(r1, whA.id, 'inQty') === 100, { got: cell(r1, whA.id, 'inQty'), want: 100 });
  check('«صنف أول» — what went OUT of «مخزن أ» today',
    cell(r1, whA.id, 'outQty') === 0, { got: cell(r1, whA.id, 'outQty'), want: 0 });
  check('«صنف أول» — what is left in «مخزن أ»',
    cell(r1, whA.id, 'balance') === 600, { got: cell(r1, whA.id, 'balance'), want: 600 });
  check('«صنف أول» — what came IN to «مخزن ب» today',
    cell(r1, whB.id, 'inQty') === 60, { got: cell(r1, whB.id, 'inQty'), want: 60 });
  check('«صنف أول» — what is left in «مخزن ب»',
    cell(r1, whB.id, 'balance') === 60, { got: cell(r1, whB.id, 'balance'), want: 60 });

  check('«صنف ثانٍ» — what went OUT of «مخزن ب» today',
    cell(r2, whB.id, 'outQty') === 30, { got: cell(r2, whB.id, 'outQty'), want: 30 });
  check('«صنف ثانٍ» — what is left in «مخزن ب»',
    cell(r2, whB.id, 'balance') === 70, { got: cell(r2, whB.id, 'balance'), want: 70 });
  check('«صنف ثانٍ» — what is left in «مخزن أ»',
    cell(r2, whA.id, 'balance') === 300, { got: cell(r2, whA.id, 'balance'), want: 300 });

  check('the grand total of what came IN',
    res.grand.inQty === 160, { got: res.grand.inQty, want: 160 });
  check('the grand total of what went OUT',
    res.grand.outQty === 30, { got: res.grand.outQty, want: 30 });
  check('the grand total of what is left',
    res.grand.balance === 1030, { got: res.grand.balance, want: 1030 });

  const tA = res.warehouseTotals[whA.id], tB = res.warehouseTotals[whB.id];
  check('«مخزن أ» — its own incoming total', tA.inQty === 100, tA);
  check('«مخزن أ» — its own outgoing total', tA.outQty === 0, tA);
  check('«مخزن أ» — its own remaining stock', tA.balance === 900, tA);
  check('«مخزن ب» — its own incoming total', tB.inQty === 60, tB);
  check('«مخزن ب» — its own outgoing total', tB.outQty === 30, tB);
  check('«مخزن ب» — its own remaining stock', tB.balance === 130, tB);
  check('the warehouse totals add up to the grand total',
    tA.balance + tB.balance === res.grand.balance, { a: tA.balance, b: tB.balance, grand: res.grand.balance });

  /* ================= the window ================= */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  await js(`document.querySelector('.nav-item[data-view="daily"]').click()`);
  await sleep(2200);

  /* ================= 2. the screen the user reads ================= */
  const ui = await js(`(() => {
    const txt = (n) => (n ? n.innerText.replace(/\\s+/g, ' ').trim() : '');
    const head1 = [...document.querySelectorAll('#dailyTbl thead tr:nth-child(1) th')].map(txt);
    const head2 = [...document.querySelectorAll('#dailyTbl thead tr:nth-child(2) th')].map(txt);
    const rows = [...document.querySelectorAll('#dailyTbl tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(txt));
    const sumHead = [...document.querySelectorAll('#dailySumTbl thead th')].map(txt);
    const sumRows = [...document.querySelectorAll('#dailySumTbl tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(txt));
    const kpis = [...document.querySelectorAll('#dailyKpis .kpi')].map(k => ({
      top: txt(k.querySelector('.k-top')), val: txt(k.querySelector('.k-val'))
    }));
    return { head1, head2, rows, sumHead, sumRows, kpis, warehouses: head1.length - 3,
      foot: txt(document.getElementById('dailyFoot')) };
  })()`);

  check('the screen shows a column for every warehouse',
    !!ui && ['مخزن أ', 'مخزن ب'].every((n) => ui.head1.some((h) => h.indexOf(n) === 0)), ui && ui.head1);
  /* the last group gathers every warehouse of the item */
  check('the screen shows the group that gathers every warehouse',
    !!ui && ui.head1.indexOf('إجمالي كل المخازن') >= 0, ui && ui.head1);
  check('every warehouse has its own three columns',
    !!ui && ui.head2.length === ui.warehouses * 3 + 3 &&
      ui.head2.filter((h) => h === 'وارد الفترة').length === ui.warehouses &&
      ui.head2.filter((h) => h === 'صادر الفترة').length === ui.warehouses &&
      ui.head2.filter((h) => h === 'المتبقي').length === ui.warehouses + 1,
    ui && { head1: ui.head1, head2: ui.head2, warehouses: ui.warehouses });

  /* the position of a warehouse group inside the row — read it from the
     header so the check does not depend on how many warehouses exist */
  const groupOf = (name) => {
    const idx = ui.head1.findIndex((h) => h.indexOf(name) === 0);
    return idx < 0 ? -1 : idx;
  };
  const cellOf = (row, whName, which) => {
    const g = groupOf(whName);
    if (g < 0) return null;
    const base = 2 + (g - 2) * 3;   /* الصنف, الوحدة, then three per group */
    return { in: row[base], out: row[base + 1], bal: row[base + 2] };
  };
  const uiRow = (code) => (ui && ui.rows.find((r) => r[0].indexOf(code) === 0)) || [];
  const u1 = uiRow('1001'), u2 = uiRow('1002');
  const a1 = cellOf(u1, 'مخزن أ'), b1 = cellOf(u1, 'مخزن ب');
  const a2 = cellOf(u2, 'مخزن أ'), b2 = cellOf(u2, 'مخزن ب');
  check('«صنف أول» — the incoming cell of «مخزن أ» reads 100',
    !!a1 && num(a1.in) === 100, a1);
  check('«صنف أول» — the remaining cell of «مخزن أ» reads 600',
    !!a1 && num(a1.bal) === 600, a1);
  check('«صنف أول» — the incoming cell of «مخزن ب» reads 60',
    !!b1 && num(b1.in) === 60, b1);
  check('«صنف أول» — the remaining cell of «مخزن ب» reads 60',
    !!b1 && num(b1.bal) === 60, b1);
  check('«صنف أول» — the grand remaining reads 660',
    num(u1[u1.length - 1]) === 660, u1);
  check('«صنف ثانٍ» — the outgoing cell of «مخزن ب» reads 30',
    !!b2 && num(b2.out) === 30, b2);
  check('«صنف ثانٍ» — the remaining cell of «مخزن ب» reads 70',
    !!b2 && num(b2.bal) === 70, b2);
  check('«صنف ثانٍ» — the remaining cell of «مخزن أ» reads 300',
    !!a2 && num(a2.bal) === 300, a2);
  check('«صنف ثانٍ» — the grand remaining reads 370',
    num(u2[u2.length - 1]) === 370, u2);

  check('the summary table names every warehouse',
    !!ui && ui.sumHead.join('|') === 'المخزن|وارد الفترة|صادر الفترة|المتبقي', ui && ui.sumHead);
  const sumA = (ui && ui.sumRows.find((r) => r[0].indexOf('مخزن أ') === 0)) || [];
  const sumB = (ui && ui.sumRows.find((r) => r[0].indexOf('مخزن ب') === 0)) || [];
  const sumG = (ui && ui.sumRows.find((r) => r[0].indexOf('إجمالي كل المخازن') === 0)) || [];
  check('the summary of «مخزن أ» reads 100 / 0 / 900',
    num(sumA[1]) === 100 && num(sumA[2]) === 0 && num(sumA[3]) === 900, sumA);
  check('the summary of «مخزن ب» reads 60 / 30 / 130',
    num(sumB[1]) === 60 && num(sumB[2]) === 30 && num(sumB[3]) === 130, sumB);
  check('the summary carries the grand total of every warehouse',
    num(sumG[1]) === 160 && num(sumG[2]) === 30 && num(sumG[3]) === 1030, sumG);

  const kpiOf = (label) => (ui && ui.kpis.find((k) => k.top.indexOf(label) === 0)) || null;
  check('a tile shows the grand remaining stock',
    kpiOf('إجمالي المتبقي') && num(kpiOf('إجمالي المتبقي').val) === 1030, kpiOf('إجمالي المتبقي'));
  check('a tile shows what came in the period',
    kpiOf('وارد الفترة') && num(kpiOf('وارد الفترة').val) === 160, kpiOf('وارد الفترة'));
  check('a tile shows what went out in the period',
    kpiOf('صادر الفترة') && num(kpiOf('صادر الفترة').val) === 30, kpiOf('صادر الفترة'));
  check('a tile shows how many items the report holds',
    kpiOf('الأصناف') && num(kpiOf('الأصناف').val) === 2, kpiOf('الأصناف'));

  await shot('01-daily-screen');

  /* ================= 3. the printed sheet ================= */
  await js(`document.getElementById('btnPrintDaily').click()`);
  await sleep(1100);
  const sheet = await js(`(() => {
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return null;
    const tables = [...pv.querySelectorAll('.sheet table.tbl')];
    const main = tables[0], sum = tables[1];
    const txt = (n) => (n ? n.innerText.replace(/\\s+/g, ' ').trim() : '');
    return {
      head1: [...main.querySelectorAll('thead tr:nth-child(1) th')].map(txt),
      head2: [...main.querySelectorAll('thead tr:nth-child(2) th')].map(txt),
      rows: [...main.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(txt)),
      sumRows: sum ? [...sum.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(txt)) : [],
      title: txt(pv.querySelector('.doc-title h1'))
    };
  })()`);
  check('the printed report is titled «التقرير اليومي»',
    !!sheet && sheet.title.indexOf('التقرير اليومي') >= 0, sheet && sheet.title);
  const nWh = sheet ? sheet.head1.length - 3 : 0;
  check('the printed table keeps the three columns of every warehouse',
    !!sheet && sheet.head2.length === nWh * 3 + 3 &&
      sheet.head2.filter((h) => h === 'وارد الفترة').length === nWh &&
      sheet.head2.filter((h) => h === 'صادر الفترة').length === nWh &&
      sheet.head2.filter((h) => h === 'المتبقي').length === nWh + 1,
    sheet && { head1: sheet.head1, head2: sheet.head2 });
  const pCell = (row, whName, which) => {
    const g = (sheet.head1 || []).findIndex((h) => h.indexOf(whName) === 0);
    if (g < 0) return null;
    const base = 2 + (g - 2) * 3;
    return { in: row[base], out: row[base + 1], bal: row[base + 2] };
  };
  const p1 = (sheet && sheet.rows.find((r) => r[0].indexOf('1001') === 0)) || [];
  const p2 = (sheet && sheet.rows.find((r) => r[0].indexOf('1002') === 0)) || [];
  const pa1 = pCell(p1, 'مخزن أ'), pb1 = pCell(p1, 'مخزن ب');
  const pb2 = pCell(p2, 'مخزن ب');
  check('the printed row of «صنف أول» reads 100 in / 600 left in «مخزن أ»',
    !!pa1 && num(pa1.in) === 100 && num(pa1.bal) === 600, pa1);
  check('the printed row of «صنف أول» reads 60 in / 60 left in «مخزن ب»',
    !!pb1 && num(pb1.in) === 60 && num(pb1.bal) === 60, pb1);
  check('the printed grand remaining of «صنف أول» reads 660',
    num(p1[p1.length - 1]) === 660, p1);
  check('the printed row of «صنف ثانٍ» reads 30 out / 70 left in «مخزن ب»',
    !!pb2 && num(pb2.out) === 30 && num(pb2.bal) === 70, pb2);
  check('the printed grand remaining of «صنف ثانٍ» reads 370',
    num(p2[p2.length - 1]) === 370, p2);
  const pG = (sheet && sheet.sumRows.find((r) => r[0].indexOf('إجمالي كل المخازن') === 0)) || [];
  check('the printed summary carries the grand total 160 / 30 / 1030',
    num(pG[1]) === 160 && num(pG[2]) === 30 && num(pG[3]) === 1030, pG);

  await shot('02-daily-print');
}
