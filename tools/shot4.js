/**
 * tools/shot4.js — smoke test for phase 4 (production) + the new
 * datalist suggestions on free-text master-data fields.
 * Usage: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tools/shot4.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots4');
const DATA = path.join(ROOT, '.tmp', 'data4');
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

async function shot(name, settle = 900) {
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

  /* ---------- seed ---------- */
  const main = dbMod.getMainWarehouse();
  const fg = dbMod.addWarehouse({ code: 'S10', name: 'مخزن المنتج التام', kind: 'sub', location: 'الدور الأول — تعبئة' });
  const fgDefect = dbMod.addWarehouse({ code: 'S11', name: 'مخزن التالف', kind: 'sub', location: 'الدور الأول — عزل' });
  const rawDefect = dbMod.addWarehouse({ code: 'S12', name: 'مخزن الخام التالف', kind: 'sub', location: 'الدور الأرضي' });
  dbMod.addWarehouse({ code: 'S13', name: 'مخزن المرتجعات', kind: 'sub', location: 'الدور الأول — تعبئة' });

  const raw = dbMod.addItem(
    { code: '0001', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12, pieces_per_bag: 0, min_good_alert: 500, max_defect_alert: 200 },
    [{ warehouseId: main.id, good: 24000, defect: 120, held: 40 }]
  );
  const fin = dbMod.addItem(
    { code: '9001', name: 'كوب ورق 8 أونصة', base_unit: 'حبة', category: 'منتج تام', pieces_per_carton: 200, pieces_per_bag: 2000, min_good_alert: 1000, max_defect_alert: 100 },
    [{ warehouseId: fg.id, good: 5000 }]
  );
  const bags = dbMod.addItem(
    { code: '7001', name: 'شنطة بلاستيك تجميع', base_unit: 'كيس', category: 'ملحقات', pieces_per_carton: 0, pieces_per_bag: 0, min_good_alert: 0, max_defect_alert: 0 },
    [{ warehouseId: main.id, good: 1000 }]
  );
  dbMod.setProdRouting({ fgGoodWh: fg.id, fgDefectWh: fgDefect.id, rawDefectWh: rawDefect.id, bagItemId: bags.id, bagWhId: main.id });
  console.log('seeded warehouses + items + routing');

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
  win.webContents.on('did-fail-load', (_e, c, m, u) => errors.push(`[load] ${c} ${m} ${u}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`[gone] ${JSON.stringify(d)}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const step = async (label, code) => {
    try { console.log('  ' + label + ' -> ' + JSON.stringify(await js(code))); }
    catch (e) { console.log('  ' + label + ' FAILED: ' + e.message); throw e; }
  };

  await win.loadFile(path.join(RENDERER, 'app.html'));
  await sleep(1300);

  /* 1) datalist suggestions on the item form */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(500);
  await js(`window.SamItems.openForm(null); 1`);
  await sleep(900);
  await step('datalist base_unit options', `[...document.querySelectorAll('#dl-base_unit option')].map(o => o.value)`);
  await step('datalist category options', `[...document.querySelectorAll('#dl-category option')].map(o => o.value)`);
  await step('unit field is a plain text input', `(() => { const i=document.querySelector('#dl-base_unit') ? [...document.querySelectorAll('.modal .form-grid input.input')][2] : null; return i ? i.tagName + '/' + i.type + '/list=' + i.getAttribute('list') : 'not found'; })()`);
  await shot('p4-01-item-suggestions', 1200);
  await js(`document.querySelector('.modal .modal-foot .btn-ghost').click()`);
  await sleep(400);

  /* 2) warehouse location suggestions */
  await js(`document.querySelector('.nav-item[data-view=warehouses]').click()`);
  await sleep(500);
  await js(`window.SamWarehouses.openForm(null); 1`);
  await sleep(900);
  await step('datalist wh_location options', `[...document.querySelectorAll('#dl-wh_location option')].map(o => o.value)`);
  await js(`document.querySelector('.modal .modal-foot .btn-ghost').click()`);
  await sleep(400);

  /* 3) production screen + routing panel */
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(900);
  await shot('p4-02-production-routing');
  await step('routing combos filled', `({
    fgGood: document.querySelector('#rtFgGood .combo-input').value,
    fgDefect: document.querySelector('#rtFgDefect .combo-input').value,
    rawDefect: document.querySelector('#rtRawDefect .combo-input').value,
    bagItem: document.querySelector('#rtBagItem .combo-input').value
  })`);

  /* 4) issue raw material to production */
  await js(`document.getElementById('btnNewIssue').click()`);
  await sleep(700);
  await step('pick raw item', `(() => {
    const inp = document.querySelector('#v-production .modal .ed-cell:nth-child(3) .combo-input') || document.querySelector('.modal .combo-input');
    inp.focus(); inp.value = 'جلدلة';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    if (!p) return 'NO POPUP';
    const o = p.querySelector('.combo-opt');
    if (!o) return 'NO OPTION';
    o.click();
    return 'picked ' + o.textContent.trim().replace(/\s+/g, ' ');
  })()`);
  await sleep(400);
  await step('cartons -> auto pieces', `(() => {
    const m = document.querySelector('.modal');
    const nums = [...m.querySelectorAll('input[type=number]')];
    nums[0].value = '500'; nums[0].dispatchEvent(new Event('input', { bubbles: true }));
    return { cartons: nums[0].value, pieces: nums[1].value, hint: m.querySelector('.foot-note').textContent };
  })()`);
  await shot('p4-03-issue-form', 1200);
  await js(`document.querySelector('.modal .modal-foot .btn-gold').click()`);
  await sleep(1100);
  await step('stock after issue', `SamDB.call('listItems','').then(r=>r.filter(i=>i.code==='0001').map(i=>i.mainStock))`);

  /* 5) daily production report */
  await js(`document.getElementById('btnNewReceipt').click()`);
  await sleep(900);
  await step('header fields', `(() => {
    const m = document.querySelector('.modal.editor');
    if (!m) return 'NO EDITOR';
    const cells = [...m.querySelectorAll('.ed-cell')];
    const cartonNo = cells.find(c => c.textContent.includes('رقم الكرتونة')).querySelector('input');
    const cartonPieces = cells.find(c => c.textContent.includes('حبات الكرتونة')).querySelector('input');
    const rawCombo = cells.find(c => c.textContent.includes('المادة الخام')).querySelector('.combo-input');
    cartonNo.value = 'C-2026-10-301';
    cartonPieces.value = '6000';
    cartonPieces.dispatchEvent(new Event('input', { bubbles: true }));
    rawCombo.focus(); rawCombo.value = 'جلدلة';
    rawCombo.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    const o = p && p.querySelector('.combo-opt');
    if (o) o.click();
    return { cartonNo: cartonNo.value, cartonPieces: cartonPieces.value, raw: rawCombo.value };
  })()`);
  await sleep(500);
  await step('finished line + quantities', `(() => {
    const tr = document.querySelector('.modal.editor .lines-tbl tbody tr');
    const inp = tr.querySelector('.combo-input');
    inp.focus(); inp.value = 'كوب';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const p = [...document.querySelectorAll('.combo-pop')].find(x => x.style.display !== 'none');
    const o = p && p.querySelector('.combo-opt');
    if (!o) return 'NO FINISHED OPTION';
    o.click();
    const nums = [...tr.querySelectorAll('input.num-in')];
    nums[0].value = '5700';   // good
    nums[1].value = '200';    // defect cans
    nums[2].value = '80';     // defect ampoules
    nums[3].value = '3';      // bags used
    nums.forEach(n => n.dispatchEvent(new Event('input', { bubbles: true })));
    return 'filled';
  })()`);
  await sleep(600);
  await step('live shortage/surplus', `document.querySelector('.modal.editor .totals-bar').textContent.replace(/\s+/g,' ')`);
  await step('routing flow preview', `document.querySelector('.modal.editor .flow-bar').textContent.replace(/\s+/g,' ')`);
  await shot('p4-04-receipt-editor', 1300);
  await js(`document.querySelector('.modal.editor .modal-foot [data-act="save"]').click()`);
  await sleep(1300);
  await step('receipts table', `[...document.querySelectorAll('#receiptsTbl tbody tr')].map(t=>t.textContent.replace(/\s+/g,' ').trim())`);
  await shot('p4-05-receipts-list', 1200);

  /* 6) stock after the report — smart routing */
  const after = await step('stock by warehouse after report',
    `SamDB.call('listItems','').then(r=>r.map(i=>[i.code, Object.entries(i.stockByWarehouse).map(([w,s])=>'wh'+w+':'+[s.good,s.defect,s.held].join('/')).join(' | ')]))`);

  /* 7) print the daily report */
  const recId = await js(`SamDB.call('listReceipts', 5).then(r => r[0].id)`);
  await js(`window.SamProd.printReceipt(${recId})`);
  await shot('p4-06-report-preview', 1500);
  await js(`document.querySelector('.pv .btn-ghost:last-child').click()`);
  await sleep(300);

  /* 8) hard delete the report -> everything reverts */
  await js(`(() => { const tr=document.querySelector('#receiptsTbl tbody tr'); const r=tr.getBoundingClientRect(); tr.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+300,clientY:r.bottom-4})); })()`);
  await sleep(500);
  await js(`document.querySelector('.ctx-item.danger').click()`);
  await shot('p4-07-delete-impact', 1500);
  await js(`document.querySelector('.modal-foot .btn-danger').click()`);
  await sleep(1200);
  await step('stock after hard delete',
    `SamDB.call('listItems','').then(r=>r.map(i=>[i.code, Object.entries(i.stockByWarehouse).map(([w,s])=>'wh'+w+':'+[s.good,s.defect,s.held].join('/')).join(' | ')]))`);
  await shot('p4-08-after-delete', 1200);

  console.log('db summary:', JSON.stringify(dbMod.summary()));
  const code = errors.length ? 1 : 0;
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(code);
});
