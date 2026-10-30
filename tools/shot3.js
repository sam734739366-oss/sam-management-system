/**
 * tools/shot3.js — smoke test for phase 3 (documents, gate pass) + the
 * contrast / label fixes. Seeds the database directly, then drives the UI.
 * Usage: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tools/shot3.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots3');
const DATA = path.join(ROOT, '.tmp', 'data3');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));

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
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 700) {
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

  /* ---------- seed master data straight into sqlite ---------- */
  const main = dbMod.getMainWarehouse();
  const prod = dbMod.addWarehouse({ code: 'S02', name: 'مخزن الإنتاج', kind: 'sub' });
  const itemA = dbMod.addItem(
    { code: '0001', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12, pieces_per_bag: 0, min_good_alert: 500, max_defect_alert: 100 },
    [{ warehouseId: main.id, good: 24000, defect: 120, held: 40 }, { warehouseId: prod.id, good: 3600 }]
  );
  const itemB = dbMod.addItem(
    { code: '0002', name: 'أمبولة ماء معقّم 200 مل', base_unit: 'حبة', category: 'خام', pieces_per_carton: 40, pieces_per_bag: 240, min_good_alert: 1000, max_defect_alert: 50 },
    [{ warehouseId: main.id, good: 800, defect: 900 }]
  );
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  const supp = dbMod.addParty({ name: 'شركة البلاستيك المتحدة', phone: '0112233445', type: 'supplier' });
  console.log('seeded:', itemA.code, itemB.code, main.code, prod.code, cust.name, supp.name);

  /* ---------- UI ---------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#0b1433',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) errors.push(`[console] ${d.source || ''}:${d.lineNumber || ''} ${d.message}`);
  });
  win.webContents.on('did-fail-load', (_e, c, d, u) => errors.push(`[load] ${c} ${d} ${u}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`[gone] ${JSON.stringify(d)}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await win.loadFile(path.join(RENDERER, 'app.html'));
  await sleep(1200);

  /* 1) items form — label wording + input contrast with typed text */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(400);
  await js(`window.SamItems.openForm(null); 1`);
  await sleep(400);
  await js(`(() => {
    const m = document.querySelector('.modal');
    const ins = [...m.querySelectorAll('.form-grid input.input')];
    ins[0].value = '0003';
    ins[1].value = 'كوب ورق 8 أونصة';
    ins[3].value = 'ملحقات';
    ins[5].value = '2000';
    const bal = [...m.querySelectorAll('.bal-in')];
    bal[0].value = '18000';
    return 'ok';
  })()`);
  await shot('p3-01-item-form-contrast', 1400);
  await shot('p3-01b-item-form-settled', 1200);
  await js(`document.querySelector('.modal .modal-foot .btn-ghost').click()`);
  await sleep(300);

  /* 2) new sale document */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(500);
  await shot('p3-02-docs-empty');
  await js(`window.SamDocs.openEditor(null); 1`);
  await sleep(500);
  await js(`(() => { const b=[...document.querySelectorAll('.seg-btn')]; b.find(x=>x.textContent.trim()==='مبيعات').click(); return 'sale'; })()`);
  await sleep(300);

  // party via searchable combo
  await js(`(() => {
    const inp = document.querySelector('.party-cell .combo-input');
    inp.focus(); inp.value = 'رياض';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    return pops.length + ' popups, first option: ' + (pops[0] ? pops[0].textContent.trim().slice(0, 40) : 'none');
  })()`);
  await shot('p3-03-party-combo-filter', 1400);
  await js(`(() => { const p=[...document.querySelectorAll('.combo-pop')].find(x=>x.style.display!=='none'); p.querySelector('.combo-opt').click(); return 'picked'; })()`);
  await sleep(250);

  // item in line 1 via searchable combo
  await js(`(() => {
    const inp = document.querySelector('.lines-tbl tbody tr .combo-input');
    inp.focus(); inp.value = 'جلدلة';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    if (!p) return 'NO POPUP';
    p.querySelector('.combo-opt').click();
    return 'item picked';
  })()`);
  await sleep(400);
  await js(`(() => {
    const tr = document.querySelector('.lines-tbl tbody tr');
    const nums = [...tr.querySelectorAll('input.num-in')];
    nums[0].value = '2400'; nums[0].dispatchEvent(new Event('input', {bubbles:true}));
    nums[1].value = '200';  nums[1].dispatchEvent(new Event('input', {bubbles:true}));
    const inv = document.querySelector('.ed-grid input[placeholder^="نص حر"]');
    inv.value = '٣٥٠٠ ريال (نص حر)';
    return 'qty+value';
  })()`);
  await sleep(400);
  await shot('p3-04-sale-editor', 1400);

  await js(`document.querySelector('.modal-foot [data-act="save"]').click()`);
  await sleep(900);
  await shot('p3-05-docs-list');

  /* 3) purchase from a supplier */
  const step = async (label, code) => {
    try { console.log('  ' + label + ' -> ' + JSON.stringify(await js(code))); }
    catch (e) { console.log('  ' + label + ' FAILED: ' + e.message); throw e; }
  };

  await js(`window.SamDocs.openEditor(null); 1`);
  await sleep(500);
  await step('party type list', `(() => {
    const inp = document.querySelector('.party-cell .combo-input');
    if (!inp) return 'NO PARTY INPUT';
    inp.focus(); inp.value = 'بلاستيك';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    return p ? [...p.querySelectorAll('.combo-opt')].map(o => o.textContent.trim()) : 'NO POPUP';
  })()`);
  await step('pick party', `(() => { const p=[...document.querySelectorAll('.combo-pop')].find(x=>x.style.display!=='none'); if(!p) return 'NO POPUP'; const o=p.querySelector('.combo-opt'); if(!o) return 'NO OPTION: '+p.textContent; o.click(); return 'picked ' + o.textContent.trim(); })()`);
  await sleep(300);
  await step('item type', `(() => {
    const i2 = document.querySelector('.lines-tbl tbody tr .combo-input');
    if (!i2) return 'NO ITEM INPUT';
    i2.focus(); i2.value = 'امبولة';
    i2.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    return p ? [...p.querySelectorAll('.combo-opt')].map(o => o.textContent.trim()) : 'NO POPUP';
  })()`);
  await step('pick item + qty + save', `(() => {
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    if (!p) return 'NO POPUP';
    const o = p.querySelector('.combo-opt');
    if (!o) return 'NO OPTION';
    o.click();
    const tr = document.querySelector('.lines-tbl tbody tr');
    const nums = [...tr.querySelectorAll('input.num-in')];
    nums[0].value = '5000'; nums[0].dispatchEvent(new Event('input', {bubbles:true}));
    const btn = document.querySelector('.modal-foot [data-act="save"]');
    if (!btn) return 'NO SAVE BTN';
    btn.click();
    return 'clicked save';
  })()`);
  await sleep(1200);
  await step('errors after save', `window.__lastError || 'none'`);

  /* 3b) transfer from main warehouse to production */
  await js(`window.SamDocs.openEditor(null); 1`);
  await sleep(600);
  await step('switch to transfer mode', `(() => {
    const b = [...document.querySelectorAll('.seg-btn')].find(x => x.textContent.trim() === 'تحويل مخزن');
    if (!b) return 'NO TRANSFER TAB';
    b.click();
    return 'party hidden=' + (document.querySelector('.party-cell').style.display === 'none')
      + ', dest visible=' + (document.querySelector('.dest-cell').style.display !== 'none');
  })()`);
  await step('pick destination warehouse', `(() => {
    const inp = document.querySelector('.dest-cell .combo-input');
    if (!inp) return 'NO DEST INPUT';
    inp.focus(); inp.value = 'الإنتاج';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    if (!p) return 'NO POPUP';
    const o = p.querySelector('.combo-opt');
    if (!o) return 'NO OPTION: ' + p.textContent;
    o.click();
    return 'dest = ' + o.textContent.trim().replace(/\s+/g, ' ');
  })()`);
  await sleep(300);
  await step('transfer line + save', `(() => {
    const inp = document.querySelector('.lines-tbl tbody tr .combo-input');
    inp.focus(); inp.value = 'جلدلة';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    const o = p && p.querySelector('.combo-opt');
    if (!o) return 'NO ITEM OPTION';
    o.click();
    const nums = [...document.querySelector('.lines-tbl tbody tr').querySelectorAll('input.num-in')];
    nums[0].value = '1200'; nums[0].dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-foot [data-act="save"]').click();
    return 'clicked save';
  })()`);
  await sleep(1300);
  await step('stock per warehouse after transfer',
    `SamDB.call('listItems','').then(r => r.filter(i=>i.code==='0001').map(i => Object.entries(i.stockByWarehouse).map(([w,s]) => 'wh'+w+':'+[s.good,s.defect,s.held].join('/'))))`);
  await shot('p3-05c-after-transfer', 1200);

  /* 4) gate pass print preview from the sale document */
  const ids = await js(`SamDB.call('listDocuments', {}).then(r => r.map(x => [x.id, x.kind, x.doc_no]))`);
  console.log('documents:', JSON.stringify(ids));
  const sale = ids.find((r) => r[1] === 'sale');
  await js(`window.SamDocs.printGatePass(${sale[0]})`);
  await shot('p3-06-gate-pass-preview', 1500);
  await shot('p3-06b-gate-pass-settled', 1200);
  await js(`document.querySelector('.pv .btn-ghost:last-child').click()`);
  await sleep(200);

  /* 5) hard delete with stock impact */
  await js(`(() => { const tr=document.querySelector('#docsTbl tbody tr'); const r=tr.getBoundingClientRect(); tr.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+250,clientY:r.bottom-4})); })()`);
  await sleep(400);
  await js(`document.querySelector('.ctx-item.danger').click()`);
  await shot('p3-07-hard-delete-impact', 1500);
  await js(`document.querySelector('.modal-foot .btn-danger').click()`);
  await sleep(900);
  await shot('p3-08-after-delete');

  const summary = dbMod.summary();
  console.log('db summary:', JSON.stringify(summary));
  const stock = js(`SamDB.call('listItems','').then(r=>r.map(i=>[i.code,i.mainStock.good,i.mainStock.defect,i.mainStock.held,i.totalPieces]))`);
  console.log('stock:', JSON.stringify(await stock));

  const code = errors.length ? 1 : 0;
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(code);
});
