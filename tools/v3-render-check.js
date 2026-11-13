/**
 * tools/v3-render-check.js — end-to-end verification of the V3 screens.
 * Seeds a multi-warehouse dataset, then drives the real renderer:
 *   · the daily report (item × warehouse + the grand remaining total)
 *   · the document editor (a warehouse per line)
 *   · the exit permits (one page per warehouse) and the transfer permits
 * Writes .tmp/v3shots/*.png and prints PASS/FAIL for every check.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v3-render-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v3shots');
const DATA = path.join(ROOT, '.tmp', 'v3render');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) {
      if (attempt === tries) { console.warn(`WARN: ${label} still locked (${e.code})`); return false; }
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
  dbMod.close();
  await rmRetry(DATA, { label: 'data dir' });
  app.exit(code);
}
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 700) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.capturePage();
    await win.webContents.executeJavaScript(`(() => { try { document.getAnimations().forEach(a => a.cancel()); } catch (e) {} return 1; })()`, true);
  } catch (e) { /* navigating */ }
  await sleep(60);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log('shot ->', name);
}

app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  await rmRetry(OUT, { tries: 4 });
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* ---------------- seed: three equal warehouses ---------------- */
  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'خلف خط النفخ' });
  const whC = dbMod.addWarehouse({ code: 'W-C', name: 'مخزن ج', location: 'المدخل الغربي' });
  const whs = dbMod.listWarehouses();
  check('four equal warehouses, no main one', whs.length === 4 && whs.every((w) => w.kind === 'sub'), whs.map((w) => w.name));

  const item1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24, pieces_per_bag: 20 },
    [{ warehouseId: whA.id, good: 20000 }, { warehouseId: whB.id, good: 12000 }, { warehouseId: whC.id, good: 5000 }]);
  const item2 = dbMod.addItem({ code: '0002', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12 },
    [{ warehouseId: whA.id, good: 8000 }]);
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });

  const today = localToday();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();

  /* a purchase yesterday — it shows as "in" only on its own day */
  dbMod.saveDocument({
    kind: 'purchase', doc_no: 'EXT-P-1', doc_date: yesterday, party_id: cust.id,
    warehouse_id: whA.id, invoice_value: '120000', notes: 'توريد من النظام الآخر',
    lines: [{ item_id: item1.id, bucket: 'good', pieces: 5000, cartons: 200, warehouse_id: whA.id }]
  });

  /* the sale of today — TWO warehouses, one invoice (the V3 case) */
  const sale = dbMod.saveDocument({
    kind: 'sale', doc_no: 'EXT-S-900', doc_date: today, party_id: cust.id,
    warehouse_id: whA.id, invoice_value: '246000', notes: 'فاتورة من نظام آخر',
    lines: [
      { item_id: item1.id, bucket: 'good', pieces: 3000, cartons: 125, warehouse_id: whA.id },
      { item_id: item1.id, bucket: 'good', pieces: 1500, cartons: 62, warehouse_id: whB.id },
      { item_id: item2.id, bucket: 'good', pieces: 400, cartons: 33, warehouse_id: whC.id }
    ]
  });
  check('sale saved with three warehouses', sale.lines.length === 3 && new Set(sale.lines.map((l) => l.warehouse_id)).size === 3, sale.lines.map((l) => l.warehouseName));

  /* a transfer of today — TWO source warehouses */
  const transfer = dbMod.saveDocument({
    kind: 'transfer', doc_no: 'TR-77', doc_date: today,
    warehouse_id: whA.id, dest_warehouse_id: whC.id,
    lines: [
      { item_id: item1.id, bucket: 'good', pieces: 1000, cartons: 41, warehouse_id: whA.id, dest_warehouse_id: whC.id },
      { item_id: item1.id, bucket: 'good', pieces: 400, cartons: 16, warehouse_id: whB.id, dest_warehouse_id: whC.id }
    ]
  });
  check('transfer saved with two source warehouses', transfer.lines.length === 2 && new Set(transfer.lines.map((l) => l.warehouse_id)).size === 2, transfer.lines.map((l) => `${l.warehouseName}→${l.destWarehouseName}`));

  /* ---------------- window ---------------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); console.log('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });
  const go = async (view) => { await js(`document.querySelector('.nav-item[data-view=${view}]').click()`); await sleep(900); };
  const closeTop = async () => {
    /* the print preview (.pv) is not a modal — close it first */
    await js(`(() => {
      const pv = [...document.querySelectorAll('.pv')].pop();
      if (pv) { const b = pv.querySelectorAll('.pv-bar .btn-ghost')[1]; if (b) b.click(); }
      const m = [...document.querySelectorAll('.overlay .modal')].pop();
      if (!m) return 'none';
      const btns = [...m.querySelectorAll('.modal-foot .btn')];
      const b = btns.slice().reverse().find(x => /إلغاء|إغلاق|فهمت|إبقاء/.test(x.textContent));
      (b || btns[btns.length - 1]).click();
      return 'closed';
    })()`);
    await sleep(400);
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);
  await shot('01-dashboard');

  /* ---------------- the daily report ---------------- */
  await go('daily');
  await sleep(1200);
  await shot('02-daily-report');

  const daily = await js(`(() => {
    const t = document.getElementById('dailyTbl');
    const rows = t.querySelectorAll('tbody tr').length;
    const heads = [...t.querySelectorAll('thead tr:first-child th.grp')].map(x => x.textContent.trim());
    const foot = document.getElementById('dailyFoot').textContent.replace(/\\s+/g,' ').trim();
    const sumRows = document.querySelectorAll('#dailySumTbl tbody tr').length;
    return { rows, heads, foot, sumRows, kpi: document.querySelector('#dailyKpis .k-val').textContent.trim() };
  })()`);
  check('daily table has rows', daily && daily.rows > 0, daily);
  check('daily header groups by warehouse', daily && daily.heads.length === 4, daily && daily.heads);
  check('daily summary has every warehouse + a grand total row', daily && daily.sumRows === 5, daily && daily.sumRows);

  const expected = dbMod.dailyReport({ date: today, buckets: ['good'] });
  check('daily grand balance matches the DB', daily && daily.kpi.replace(/,/g, '') === String(expected.grand.balance), { kpi: daily && daily.kpi, db: expected.grand.balance });
  check('daily "in today" counts only inflows',
    expected.warehouseTotals[whA.id].inQty === 28000 && expected.warehouseTotals[whB.id].inQty === 12000
    && expected.warehouseTotals[whC.id].inQty === 6400,
    Object.fromEntries(Object.entries(expected.warehouseTotals).map(([k, v]) => [k, v.inQty])));
  check("the purchase of yesterday is NOT counted as today's inflow",
    expected.warehouseTotals[whA.id].inQty === 28000,
    { inToday: expected.warehouseTotals[whA.id].inQty });

  /* the date filter really filters */
  await js(`(() => { const d = document.getElementById('dDate'); d.value = '${yesterday}'; d.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await sleep(1000);
  await shot('03-daily-yesterday');
  const yFoot = await js(`document.getElementById('dailyFoot').textContent.replace(/\s+/g,' ').trim()`);
  check('another date shows a different movement', yFoot !== daily.foot, { today: daily.foot, yesterday: yFoot });
  await js(`document.getElementById('btnTodayDaily').click()`);
  await sleep(1000);

  /* the print preview of the daily report */
  await js(`document.getElementById('btnPrintDaily').click()`);
  await sleep(900);
  await shot('04-daily-print');
  const pvPages = await js(`document.querySelectorAll('.pv .sheet').length`);
  check('daily print preview has one sheet', pvPages === 1, pvPages);
  await closeTop();

  /* ---------------- the document editor ---------------- */
  await go('transactions');
  await shot('05-transactions');
  await js(`SamDocs.openEditor(null, 'sale'); 1`);
  await sleep(1000);
  const editorCols = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const ths = [...ed.querySelectorAll('.lines-tbl thead th')].map(x => x.textContent.trim());
    return { ths, width: ed.getBoundingClientRect().width };
  })()`);
  check('the editor shows a warehouse column per line', editorCols && editorCols.ths.includes('المخزن'), editorCols && editorCols.ths);
  check('the editor is wide enough for the new columns', editorCols && editorCols.width > 1200, editorCols && editorCols.width);
  await shot('06-editor');
  await closeTop();

  /* ---------------- the permits ---------------- */
  const saleId = sale.id;
  const permits = await js(`(async () => {
    const doc = await SamDB.call('getDocument', ${saleId});
    const pages = SamDocs.permitPages(doc);
    const sum = pages.reduce((a, p) => a + (p.bodyHtml.match(/إجمالي هذا التصريح:<\\/b> ([\\d,]+)/) ? Number(p.bodyHtml.match(/إجمالي هذا التصريح:<\\/b> ([\\d,]+)/)[1].replace(/,/g,'')) : 0), 0);
    return { count: pages.length, sum, total: doc.totalPieces, titles: pages.map(p => p.title), hasPrice: pages.some(p => /سعر|قيمة|ريال/.test(p.bodyHtml)) };
  })()`);
  check('a sale from 3 warehouses makes 3 permits', permits && permits.count === 3, permits);
  check('the permit quantities add up to the invoice total', permits && permits.sum === permits.total, permits);
  check('no price appears on a permit', permits && permits.hasPrice === false, permits);

  await js(`SamDocs.printPermits(${saleId}); 1`);
  await sleep(1000);
  await shot('07-permits-sale');
  const salePages = await js(`document.querySelectorAll('.pv .sheet').length`);
  check('the preview stacks 3 permit pages', salePages === 3, salePages);

  /* the PDF staging — the sheet must reach the print host */
  const staged = await js(`(() => {
    const pv = [...document.querySelectorAll('.pv')].pop();
    const clone = pv.querySelector('.pv-pages').cloneNode(true);
    return { sheets: clone.querySelectorAll('.sheet').length, hasWatermark: !!clone.querySelector('.wm') };
  })()`);
  check('the staged document keeps every sheet and the watermark', staged && staged.sheets === 3 && staged.hasWatermark, staged);
  await closeTop();

  /* the transfer permits */
  const tperm = await js(`(async () => {
    const doc = await SamDB.call('getDocument', ${transfer.id});
    const pages = SamDocs.permitPages(doc);
    const sum = pages.reduce((a, p) => {
      const m = p.bodyHtml.match(/إجمالي هذا التصريح:<\\/b> ([\\d,]+)/);
      return a + (m ? Number(m[1].replace(/,/g,'')) : 0);
    }, 0);
    return { count: pages.length, sum, total: doc.totalPieces, head: pages.map(p => p.head.map(h => h.k + '=' + h.v).join(' | ')) };
  })()`);
  check('a transfer from 2 warehouses makes 2 permits', tperm && tperm.count === 2, tperm);
  check('the transfer permits add up to the document', tperm && tperm.sum === tperm.total, tperm);
  check('the transfer permit names the source and the destination', tperm && tperm.head.every((h) => /من مخزن=.*إلى مخزن=/.test(h)), tperm && tperm.head);

  await js(`SamDocs.printPermits(${transfer.id}); 1`);
  await sleep(1000);
  await shot('08-permits-transfer');
  await closeTop();

  /* the printed invoice */
  await js(`SamDocs.printInvoice(${saleId}); 1`);
  await sleep(900);
  await shot('09-invoice-print');
  const invHead = await js(`(() => {
    const s = [...document.querySelectorAll('.pv .sheet')].pop();
    const ths = [...s.querySelectorAll('table.tbl thead th')].map(x => x.textContent.trim());
    return { ths, hasWh: ths.includes('المخزن') };
  })()`);
  check('the printed invoice carries the warehouse column', invHead && invHead.hasWh, invHead && invHead.ths);
  await closeTop();

  /* the transactions list shows the warehouses of each document */
  const listCell = await js(`(() => {
    const tr = document.querySelector('#docsTbl tbody tr');
    return tr ? tr.children[5].textContent.trim() : '';
  })()`);
  check('the transactions list shows every warehouse of the document', /مخزن/.test(listCell || ''), listCell);
  await shot('10-transactions-list');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  console.log(errors.length ? 'RENDERER ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(fail || errors.length ? 1 : 0);
});
