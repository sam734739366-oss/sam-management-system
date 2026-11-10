/**
 * tools/shot5.js — smoke test for phase 5 (dynamic report center).
 * Seeds a full ledger (purchase, sale, transfer, issue, production report),
 * then drives the report screen: filters, column checkboxes, balances,
 * totals, print preview and the Excel/CSV export payload.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots5');
const DATA = path.join(ROOT, '.tmp', 'data5');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return true;
    } catch (e) {
      if (attempt === tries) { console.warn(`WARN: ${label} still locked after ${tries} tries (${e.code})`); return false; }
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  return false;
}

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (!cleanedUp) {
    cleanedUp = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    dbMod.close();
    await rmRetry(DATA, { label: 'temp data dir' });
  }
  app.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.message ? e.message : e));
  if (errors.length) console.log('RENDERER ERRORS:\n' + errors.join('\n'));
  shutdown(1);
});
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 1200) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
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

  /* ---------------- seed a full ledger ---------------- */
  const main = dbMod.getMainWarehouse();
  const fg = dbMod.addWarehouse({ code: 'S10', name: 'مخزن المنتج التام', kind: 'sub' });
  const fgd = dbMod.addWarehouse({ code: 'S11', name: 'مخزن التالف', kind: 'sub' });
  const rwd = dbMod.addWarehouse({ code: 'S12', name: 'مخزن الخام التالف', kind: 'sub' });
  const raw = dbMod.addItem(
    { code: '0001', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12, pieces_per_bag: 0, min_good_alert: 500, max_defect_alert: 200 },
    [{ warehouseId: main.id, good: 24000, defect: 120, held: 40 }]
  );
  const fin = dbMod.addItem(
    { code: '9001', name: 'كوب ورق 8 أونصة', base_unit: 'حبة', category: 'منتج تام', pieces_per_carton: 200, pieces_per_bag: 2000, min_good_alert: 1000, max_defect_alert: 100 },
    [{ warehouseId: fg.id, good: 5000 }]
  );
  const bags = dbMod.addItem(
    { code: '7001', name: 'كيس تجميع بلاستيك', base_unit: 'كيس', category: 'ملحقات', pieces_per_carton: 0, pieces_per_bag: 0, min_good_alert: 0, max_defect_alert: 0 },
    [{ warehouseId: main.id, good: 1000 }]
  );
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  const supp = dbMod.addParty({ name: 'شركة البلاستيك المتحدة', phone: '0112233445', type: 'supplier' });
  dbMod.setProdRouting({ fgGoodWh: fg.id, fgDefectWh: fgd.id, rawDefectWh: rwd.id, bagItemId: bags.id, bagWhId: main.id });

  const today = new Date().toISOString().slice(0, 10);
  dbMod.saveDocument({ kind: 'purchase', doc_date: today, party_id: supp.id, warehouse_id: main.id, invoice_value: '12,500 ريال', lines: [{ item_id: raw.id, bucket: 'good', pieces: 12000, cartons: 1000 }] });
  dbMod.saveDocument({ kind: 'sale', doc_date: today, party_id: cust.id, warehouse_id: main.id, invoice_value: '٣٥٠٠ ريال (نص حر)', lines: [{ item_id: raw.id, bucket: 'good', pieces: 2400, cartons: 200 }] });
  dbMod.saveDocument({ kind: 'transfer', doc_date: today, warehouse_id: main.id, dest_warehouse_id: fg.id, lines: [{ item_id: raw.id, bucket: 'good', pieces: 1200, cartons: 100 }] });
  dbMod.saveIssue({ doc_date: today, item_id: raw.id, warehouse_id: main.id, cartons: 500, pieces: 6000 });
  dbMod.saveReceipt({ doc_date: today, raw_item_id: raw.id, carton_no: 'C-2026-10-301', carton_pieces: 6000, bags_used: 3, lines: [{ item_id: fin.id, good: 5700, defect_cans: 200, defect_ampoules: 80, bags_used: 3 }] });
  console.log('seeded full ledger:', JSON.stringify(dbMod.summary()));

  /* ---------------- UI ---------------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#0b1433',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) errors.push(`[console] ${d.source || ''}:${d.lineNumber || ''} ${d.message}`);
  });
  win.webContents.on('did-fail-load', (_e, c, m, u) => errors.push(`[load] ${c} ${m} ${u}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`[gone] ${JSON.stringify(d)}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const step = async (label, code) => {
    try { console.log('  ' + label + ' -> ' + JSON.stringify(await js(code))); }
    catch (e) { console.log('  ' + label + ' FAILED: ' + e.message); throw e; }
  };

  /* V4: the app needs a session — log in through the real login page */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(700);
  await js(`sessionStorage.setItem('sam.justLoggedIn','1'); sam.auth.login('admin','admin123'); 1`);
  await sleep(2600);
  await win.loadFile(path.join(RENDERER, 'app.html'));
  await sleep(1300);
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(900);

  /* V4: the report centre is a WINDOW now — the screen is only a launcher */
  await step('open the report window', `window.SamReports.run().then(() => 'opened')`);
  await sleep(1500);
  await step('the window is up', `(() => ({
    overlay: document.querySelectorAll('.rw-overlay').length,
    rail: document.querySelectorAll('.rw-rail .rw-item').length,
    cols: document.querySelectorAll('#colsWrap .col-check').length
  }))()`);

  /* clear the default "today" range so every row is in scope */
  await step('filters cleared', `(() => { document.getElementById('btnResetFilters').click(); return [document.getElementById('fFrom').value, document.getElementById('fTo').value]; })()`);
  await sleep(900);
  await step('run report', `window.SamReports.run().then(() => 'ran')`);
  await sleep(1200);
  await step('rows + totals', `({
    rows: document.querySelectorAll('#reportTbl tbody tr').length,
    cols: [...document.querySelectorAll('#reportTbl thead th')].map(t => t.textContent.trim()),
    foot: document.getElementById('reportFoot').textContent.replace(/\s+/g, ' ').trim()
  })`);
  await step('first three rows', `[...document.querySelectorAll('#reportTbl tbody tr')].slice(0,3).map(t => [...t.children].map(td => td.textContent.trim()).join(' | ').replace(/\s+/g,' '))`);
  await shot('p5-01-report-all');

  /* column toggling */
  await step('uncheck a column', `(() => {
    const boxes = [...document.querySelectorAll('#colsWrap .col-check')];
    const target = boxes.find(b => b.textContent.includes('المخزن'));
    target.querySelector('input').click();
    return [...document.querySelectorAll('#reportTbl thead th')].map(t => t.textContent.trim());
  })()`);
  await step('select none then two columns', `(() => {
    document.getElementById('btnNoCols').click();
    const boxes = [...document.querySelectorAll('#colsWrap .col-check')];
    boxes.find(b => b.textContent.includes('الصنف')).querySelector('input').click();
    boxes.find(b => b.textContent.includes('الرصيد المتحرك')).querySelector('input').click();
    return { head: [...document.querySelectorAll('#reportTbl thead th')].map(t => t.textContent.trim()), foot: document.getElementById('reportFoot').textContent.replace(/\s+/g,' ').trim().slice(0,80) };
  })()`);
  await shot('p5-02-report-two-columns');
  await step('all columns back', `(() => { document.getElementById('btnAllCols').click(); return document.querySelectorAll('#reportTbl thead th').length; })()`);

  /* filter by document type */
  await step('filter kind = sale', `(() => {
    const inp = document.querySelector('#fKind .combo-input');
    inp.focus(); inp.value = 'مبيعات';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    const o = p && [...p.querySelectorAll('.combo-opt')].find(x => x.textContent.includes('مبيعات'));
    if (!o) return 'NO OPTION';
    o.click();
    return 'picked ' + o.textContent.trim().replace(/\s+/g, ' ');
  })()`);
  await sleep(400);
  await step('run filtered', `window.SamReports.run().then(() => ({
    rows: document.querySelectorAll('#reportTbl tbody tr').length,
    types: [...new Set([...document.querySelectorAll('#reportTbl tbody tr')].map(t => t.children[2].textContent.trim()))]
  }))`);
  await shot('p5-03-report-filtered');

  /* the export payload (the save dialog itself is not automated) */
  await step('the result carries its columns and rows', `(() => {
    const r = window.SamReports.state.result;
    return { report: r.report, cols: r.columns.map(c => c.label), rows: r.rows.length };
  })()`);
  await step('the footer totals the visible numeric columns', `document.getElementById('reportFoot').textContent.replace(/\\s+/g,' ').trim()`);

  /* print preview of the full report */
  await js(`document.getElementById('btnResetFilters').click()`);
  await sleep(900);
  await step('press the print action', `(() => {
    const b = [...document.querySelectorAll('.rw-actions .btn')].find(x => /طباعة/.test(x.textContent));
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await shot('p5-04-report-print', 1600);
  await js(`document.querySelector('.pv .btn-ghost:last-child').click()`);
  await sleep(300);

  const code = errors.length ? 1 : 0;
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(code);
});
