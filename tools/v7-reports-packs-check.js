/**
 * tools/v7-reports-packs-check.js — the packs (الكراتين والأكياس) in the reports:
 *   · the daily report grows a group of pack columns for the item
 *   · a movement of 300 pieces of an item whose bag holds 24 is written
 *     the way the customer counts it: «12 كيس + 12 حبة»
 *   · the switch «إظهار الكراتين والأكياس» takes the columns away and
 *     brings them back
 *   · the printed sheet and the Excel spec carry the same columns
 * It drives the real main process and the real renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-reports-packs-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7packs');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-reports-packs-check.log');
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

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

/* today — the daily report shows one day, so the movement is today */
const NOW = new Date();
const pad = (n) => String(n).padStart(2, '0');
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;

/* the texts the reports must carry */
const T_BAG = '12 كيس + 12 حبة';   // 300 pieces, a bag of 24
const T_CARTON = '2 كرتون + 5 حبة'; // 25 pieces, a carton of 10
const T_UNIT = '3 باك + 20 حبة';    // 170 pieces, a unit of its own of 50

async function main() {
  dbMod.close();
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  const wh = dbMod.addWarehouse({ code: 'W1', name: 'مخزن الأكياس', location: 'الشمال' });
  const party = dbMod.addParty({ name: 'عميل الأكياس', type: 'supplier', phone: '771234567' });

  /* the item whose bag holds 24 pieces */
  const bagItem = dbMod.addItem({
    code: 'P-1', name: 'صنف الأكياس', base_unit: 'حبة', category: 'منتج',
    pieces_per_bag: 24
  }, [{ warehouseId: wh.id, good: 0 }]);
  /* the item whose carton holds 10 pieces */
  const cartItem = dbMod.addItem({
    code: 'P-2', name: 'صنف الكراتين', base_unit: 'حبة', category: 'منتج',
    pieces_per_carton: 10
  }, [{ warehouseId: wh.id, good: 0 }]);
  /* the item with a unit of its own (50 pieces) */
  const unitItem = dbMod.addItem({
    code: 'P-3', name: 'صنف الوحدة', base_unit: 'حبة', category: 'منتج',
    unit_label: 'باك', unit_pieces: 50
  }, [{ warehouseId: wh.id, good: 0 }]);

  /* the movements: 300 pieces (12 bags of 24 + 12 pieces) and 25 pieces */
  dbMod.saveDocument({
    kind: 'purchase', doc_date: TODAY, party_id: party.id, warehouse_id: wh.id,
    lines: [{ item_id: bagItem.id, warehouse_id: wh.id, pieces: 300, bags: 12, bags_part: 12 }]
  });
  dbMod.saveDocument({
    kind: 'purchase', doc_date: TODAY, party_id: party.id, warehouse_id: wh.id,
    lines: [{ item_id: cartItem.id, warehouse_id: wh.id, pieces: 25, cartons: 2, cartons_part: 5 }]
  });
  dbMod.saveDocument({
    kind: 'purchase', doc_date: TODAY, party_id: party.id, warehouse_id: wh.id,
    lines: [{ item_id: unitItem.id, warehouse_id: wh.id, pieces: 170 }]
  });

  /* ---- the main process and the renderer ---- */
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
  await sleep(2800);

  await js(`document.querySelector('.nav-item[data-view=daily]').click()`);
  await sleep(1800);

  /* the packs start ON — the switch is remembered, so the check forces it */
  await js(`(() => {
    try { localStorage.setItem('sam.packs.v1', '1'); } catch (e) {}
    return window.SamDaily ? SamDaily.setPacks(true) : null;
  })()`);
  await sleep(800);

  /* ---------------- the daily report ---------------- */
  const dailyOn = await js(`(() => {
    const heads = [...document.querySelectorAll('#dailyTbl thead th')].map(n => n.textContent.trim());
    const rows = [...document.querySelectorAll('#dailyTbl tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
    const row = rows.find(r => r.some(c => c.indexOf('P-1') >= 0));
    const row2 = rows.find(r => r.some(c => c.indexOf('P-2') >= 0));
    const row3 = rows.find(r => r.some(c => c.indexOf('P-3') >= 0));
    return {
      group: heads.some(h => h.indexOf('الكراتين والأكياس') >= 0),
      heads: heads.slice(-6),
      bagRow: row || null,
      cartonRow: row2 || null,
      unitRow: row3 || null,
      switchExists: !!document.getElementById('dPacks'),
      switchOn: (document.getElementById('dPacks') || {}).checked
    };
  })()`) || {};
  check('the daily report has a group for the packs', dailyOn.group === true, dailyOn.heads);
  check('the switch is on the daily screen', dailyOn.switchExists === true && dailyOn.switchOn === true, dailyOn);
  check('300 pieces are written as «12 كيس + 12 حبة»',
    !!(dailyOn.bagRow && dailyOn.bagRow.some((c) => c.indexOf(T_BAG) >= 0)), dailyOn.bagRow);
  check('25 pieces are written as «2 كرتون + 5 حبة»',
    !!(dailyOn.cartonRow && dailyOn.cartonRow.some((c) => c.indexOf(T_CARTON) >= 0)), dailyOn.cartonRow);
  check('the unit of its own is written as «3 بك + 20 حبة»',
    !!(dailyOn.unitRow && dailyOn.unitRow.some((c) => c.indexOf(T_UNIT) >= 0)), dailyOn.unitRow);

  /* ---------------- the switch takes the columns away ---------------- */
  await js(`(() => { const cb = document.getElementById('dPacks'); cb.checked = false; cb.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(700);
  const dailyOff = await js(`(() => {
    const heads = [...document.querySelectorAll('#dailyTbl thead th')].map(n => n.textContent.trim());
    const rows = [...document.querySelectorAll('#dailyTbl tbody tr')].map(tr => tr.textContent);
    return {
      group: heads.some(h => h.indexOf('الكراتين والأكياس') >= 0),
      text: rows.some(r => r.indexOf('12 كيس + 12 حبة') >= 0),
      stored: (function () { try { return localStorage.getItem('sam.packs.v1'); } catch (e) { return null; } })()
    };
  })()`) || {};
  check('the switch takes the pack columns away', dailyOff.group === false, dailyOff);
  check('the numbers of the packs are gone with them', dailyOff.text === false, dailyOff);
  check('the choice is remembered', dailyOff.stored === '0', dailyOff);

  /* and brings them back */
  await js(`(() => { const cb = document.getElementById('dPacks'); cb.checked = true; cb.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(700);
  const dailyBack = await js(`(() => {
    const heads = [...document.querySelectorAll('#dailyTbl thead th')].map(n => n.textContent.trim());
    const rows = [...document.querySelectorAll('#dailyTbl tbody tr')].map(tr => tr.textContent);
    return {
      group: heads.some(h => h.indexOf('الكراتين والأكياس') >= 0),
      text: rows.some(r => r.indexOf('12 كيس + 12 حبة') >= 0),
      stored: (function () { try { return localStorage.getItem('sam.packs.v1'); } catch (e) { return null; } })()
    };
  })()`) || {};
  check('the switch brings the pack columns back', dailyBack.group === true && dailyBack.text === true, dailyBack);

  /* ---------------- the print and the Excel ---------------- */
  const specs = await js(`(() => {
    const s = SamDaily.sheetSpec();
    const x = SamDaily.excelSpec();
    const row = (x.rows || []).find(r => r.code === 'P-1');
    return {
      body: s ? s.bodyHtml : '',
      sheetGroup: s ? s.bodyHtml.indexOf('الكراتين والأكياس') >= 0 : false,
      sheetText: s ? s.bodyHtml.indexOf('${T_BAG}') >= 0 : false,
      cols: (x.columns || []).map(c => c.header),
      packCols: (x.columns || []).filter(c => String(c.key).indexOf('pack_') === 0).map(c => c.header),
      row: row || null
    };
  })()`) || {};
  check('the printed sheet carries the group of the packs', specs.sheetGroup === true, specs.cols);
  check('the printed sheet carries the numbers', specs.sheetText === true, { sheetText: specs.sheetText });
  check('the Excel spec carries the pack columns', (specs.packCols || []).length > 0, specs.packCols);
  check('the Excel spec carries the numbers',
    !!(specs.row && String(specs.row.pack_bags || '').indexOf(T_BAG) >= 0), specs.row);

  /* the switch takes them away from the print and the Excel too */
  await js(`(() => { const cb = document.getElementById('dPacks'); cb.checked = false; cb.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(600);
  const specsOff = await js(`(() => {
    const s = SamDaily.sheetSpec();
    const x = SamDaily.excelSpec();
    return {
      sheetGroup: s ? s.bodyHtml.indexOf('الكراتين والأكياس') >= 0 : false,
      packCols: (x.columns || []).filter(c => String(c.key).indexOf('pack_') === 0).length
    };
  })()`) || {};
  check('the print and the Excel follow the switch',
    specsOff.sheetGroup === false && specsOff.packCols === 0, specsOff);

  await js(`(() => { const cb = document.getElementById('dPacks'); cb.checked = true; cb.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(600);

  /* ---------------- the reports centre ---------------- */
  await js(`SamReports.load()`);
  await sleep(1500);
  await js(`(() => { SamReports.openWindow('movements'); return true; })()`);
  await sleep(2000);
  const mov = await js(`(() => { try {
    const heads = [...document.querySelectorAll('.rw-window #reportTbl thead th')].map(n => n.textContent.trim());
    const rows = [...document.querySelectorAll('.rw-window #reportTbl tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
    const row = rows.find(r => r.some(c => c.indexOf('P-1') >= 0));
    return {
      heads: heads.slice(-4),
      packHead: heads.some(h => h.indexOf('كيس') >= 0 && h.indexOf('الحركة') >= 0),
      row: row || null,
      text: !!(row && row.some(c => c.indexOf('${T_BAG}') >= 0)),
      switchExists: !!document.getElementById('fPacks'),
      switchOn: (document.getElementById('fPacks') || {}).checked
    };
  } catch (e) { return { err: String((e && e.message) || e) }; } })()`) || {};
  check('the movement report has the packs of the movement', mov.packHead === true, mov.heads);
  check('the movement is written as «12 كيس + 12 حبة»', mov.text === true, mov.row);
  check('the switch is in the report window', mov.switchExists === true && mov.switchOn === true, mov);

  /* the Excel of the reports centre */
  const rSpec = await js(`(() => {
    const x = SamReports.excelSpec();
    const row = (x.rows || []).find(r => r.itemCode === 'P-1');
    return {
      packCols: (x.columns || []).filter(c => String(c.key).indexOf('pack_') === 0).map(c => c.header),
      row: row || null
    };
  })()`) || {};
  check('the Excel of the reports centre carries the packs', (rSpec.packCols || []).length > 0, rSpec.packCols);
  check('the Excel of the reports centre carries the numbers',
    !!(rSpec.row && String(rSpec.row.pack_bags || '').indexOf(T_BAG) >= 0), rSpec.row);

  /* the switch of the report window */
  await js(`(() => { const cb = document.getElementById('fPacks'); cb.checked = false; cb.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(1600);
  const movOff = await js(`(() => {
    const heads = [...document.querySelectorAll('.rw-window #reportTbl thead th')].map(n => n.textContent.trim());
    const x = SamReports.excelSpec();
    return {
      packHead: heads.some(h => h.indexOf('كيس') >= 0 && h.indexOf('الحركة') >= 0),
      packCols: (x.columns || []).filter(c => String(c.key).indexOf('pack_') === 0).length
    };
  })()`) || {};
  check('the switch of the report window takes the packs away',
    movOff.packHead === false && movOff.packCols === 0, movOff);

  await js(`(() => { const cb = document.getElementById('fPacks'); cb.checked = true; cb.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(1600);
  const movBack = await js(`(() => {
    const heads = [...document.querySelectorAll('.rw-window #reportTbl thead th')].map(n => n.textContent.trim());
    return { packHead: heads.some(h => h.indexOf('كيس') >= 0 && h.indexOf('الحركة') >= 0) };
  })()`) || {};
  check('the switch of the report window brings the packs back', movBack.packHead === true, movBack);

  /* ---------------- the stock report: the packs of the balance ---------------- */
  await js(`(() => { SamReports.openWindow('stock_status'); return true; })()`);
  await sleep(1800);
  const stock = await js(`(() => { try {
    const heads = [...document.querySelectorAll('.rw-window #reportTbl thead th')].map(n => n.textContent.trim());
    const rows = [...document.querySelectorAll('.rw-window #reportTbl tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
    const row = rows.find(r => r.some(c => c.indexOf('P-1') >= 0));
    return {
      packHead: heads.some(h => h.indexOf('كيس') >= 0 && h.indexOf('الرصيد') >= 0),
      text: !!(row && row.some(c => c.indexOf('${T_BAG}') >= 0)),
      row: row || null
    };
  } catch (e) { return { err: String((e && e.message) || e) }; } })()`) || {};
  check('the stock report shows the packs of the balance', stock.packHead === true && stock.text === true, stock);

  await shutdown(fail ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
