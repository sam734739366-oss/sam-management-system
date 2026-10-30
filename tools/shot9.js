/**
 * tools/shot9.js — visual audit tour.
 * Seeds a realistic dataset, then screenshots every screen and every
 * interactive state so colour / spacing / contrast problems are visible
 * instead of guessed at. Writes .tmp/shots9/*.png.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots9');
const DATA = path.join(ROOT, '.tmp', 'data9');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

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
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 700) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.capturePage();                       // force one frame
    await win.webContents.executeJavaScript(`(() => { try { document.getAnimations().forEach(a => a.cancel()); } catch (e) {} return 1; })()`, true);
  } catch (e) { /* navigating */ }
  await sleep(50);
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

  /* ---------- realistic seed data ---------- */
  const main = dbMod.getMainWarehouse();
  const h1 = dbMod.addWarehouse({ code: 'H-01', name: 'هنجر الخام', kind: 'sub', location: 'الطرف الشرقي' });
  const h2 = dbMod.addWarehouse({ code: 'H-02', name: 'هنجر التالف', kind: 'sub', location: 'خلف خط النفخ' });
  const seed = [
    ['0001', 'مياه جلدلة 1.5 لتر', 'حبة', 'خام', 12, 0, 24000, 120, 40],
    ['0002', 'مياه سمطة 330 مل', 'حبة', 'خام', 24, 0, 18600, 60, 0],
    ['5001', 'أمبولة منفوخة 20 مل', 'حبة', 'منتج تام', 24, 20, 9400, 310, 250],
    ['5002', 'علبة كرتون مطبوعة', 'علبة', 'ملحقات', 50, 0, 1200, 0, 0],
    ['9001', 'كيس بلاستيك', 'كيس', 'ملحقات', 0, 500, 4300, 0, 0]
  ];
  const ids = {};
  for (const [code, name, unit, cat, ctn, bag, good, defect, held] of seed) {
    const it = dbMod.addItem({ code, name, base_unit: unit, category: cat, pieces_per_carton: ctn, pieces_per_bag: bag, min_good_alert: 1000, max_defect_alert: 300 },
      [{ warehouseId: main.id, good, defect, held }]);
    ids[code] = it.id;
  }
  const parties = [
    ['موزع الرياض', '0555123456', 'customer'], ['شركة البركة', '0112345678', 'supplier'],
    ['مؤسسة النور', '0509876543', 'both'], ['عميل تجريبي بدون مستندات', '', 'customer']
  ].map(([name, phone, type]) => dbMod.addParty({ name, phone, type }).id);
  dbMod.setProdRouting({ fgGoodWh: main.id, fgDefectWh: h2.id, rawDefectWh: h2.id, bagItemId: ids['9001'], bagWhId: main.id });

  const money = (n) => n.toLocaleString('en-US');
  dbMod.saveDocument({ kind: 'purchase', doc_date: '2026-10-28', party_id: parties[1], warehouse_id: main.id, invoice_value: money(185000), notes: 'توريد خام', lines: [
    { item_id: ids['0001'], bucket: 'good', pieces: 12000, cartons: 1000, bags: 0 },
    { item_id: ids['0002'], bucket: 'good', pieces: 9600, cartons: 400, bags: 0 }] });
  dbMod.saveDocument({ kind: 'sale', doc_date: '2026-10-29', party_id: parties[0], warehouse_id: main.id, invoice_value: money(246000), notes: 'توزيع', lines: [
    { item_id: ids['5001'], bucket: 'good', pieces: 4800, cartons: 200, bags: 240 },
    { item_id: ids['0001'], bucket: 'good', pieces: 2400, cartons: 200, bags: 0 }] });
  dbMod.saveDocument({ kind: 'sale_return', doc_date: '2026-10-29', party_id: parties[0], warehouse_id: main.id, invoice_value: money(12000), lines: [
    { item_id: ids['5001'], bucket: 'defect', pieces: 120, cartons: 0, bags: 0 }] });
  dbMod.saveDocument({ kind: 'transfer', doc_date: '2026-10-30', warehouse_id: main.id, dest_warehouse_id: h1.id, lines: [
    { item_id: ids['0001'], bucket: 'good', pieces: 3000, cartons: 250, bags: 0 }] });
  dbMod.saveIssue({ doc_date: '2026-10-30', item_id: ids['0001'], warehouse_id: main.id, cartons: 500, pieces: 6000, note: 'لمنفخ خط 2' });
  dbMod.saveReceipt({ doc_date: '2026-10-30', raw_item_id: ids['0001'], carton_no: 'C-2026-10-301', carton_pieces: 6000, bags_used: 240, note: 'مناوبة صباحية', lines: [
    { item_id: ids['5001'], bags_used: 240, breaks: 60, defect_cans: 90, defect_ampoules: 40 }] });
  dbMod.saveTolling({ doc_date: '2026-10-30', party_id: parties[0], raw_item_id: ids['0002'], warehouse_id: main.id, pieces_in: 5000, bags_in: 12, note: 'نفخ للغير', lines: [
    { item_id: ids['5001'], good: 4200, defect: 500, bags: 10 }] });
  dbMod.saveArchive({ doc_date: '2026-10-27', shift: 'نهارية', machine: 'خط 2', raw_item_id: ids['0001'], product_item_id: ids['5001'], cartons: 40, bags: 120, good: 2400, defect: 80, note: 'يوم تجريبي بلا أثر' });

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
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 140) + ' :: ' + e.message);
    throw e;
  });
  const go = async (view) => { await js(`document.querySelector('.nav-item[data-view=${view}]').click()`); await sleep(900); };
  const closeTop = async () => {
    try {
      const r = await js(`(() => {
        const m = [...document.querySelectorAll('.overlay .modal')].pop();
        if (!m) return 'none';
        const btns = [...m.querySelectorAll('.modal-foot .btn')];
        const b = btns.slice().reverse().find(x => /إلغاء|إغلاق|فهمت|إبقاء/.test(x.textContent));
        (b || btns[btns.length - 1]).click();
        return 'closed';
      })()`);
      await sleep(350);
      return r;
    } catch (e) { console.log('  closeTop skipped: ' + e.message); return 'error'; }
  };

  /* ---------- tour ---------- */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await shot('01-login', 900);
  await js(`sessionStorage.setItem('sam.justLoggedIn','1')`);
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(300);
  await shot('02-intro', 0);
  await sleep(2200);
  await shot('03-dashboard');

  await go('items');
  await shot('04-items');
  await js(`document.getElementById('btnAddItem').click()`);
  await shot('05-item-form');
  await closeTop();
  await js(`document.getElementById('btnSmartSearch').click()`);
  await shot('06-smart-search');
  await closeTop();

  await go('warehouses');
  await shot('07-hangars');
  await go('parties');
  await shot('08-parties');

  await go('transactions');
  await shot('09-transactions');
  await js(`document.getElementById('btnNewDoc').click()`);
  await sleep(900);
  await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const inp = [...ed.querySelectorAll('.lines-tbl .combo-input')][0];
    inp.focus(); inp.value = 'أمبولة'; inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(400);
  await shot('10-doc-editor-open-combo');
  await js(`(() => {
    const pop = [...document.querySelectorAll('.combo-pop')].filter(x => x.style.display !== 'none').pop();
    pop.querySelector('.combo-opt').click();
    return 1;
  })()`);
  await sleep(600);
  await shot('11-doc-editor-filled');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  await sleep(400);
  await js(`SamDocs.viewDoc(${dbMod.listDocuments({ kind: 'sale' })[0].id}); 1`);
  await shot('12-doc-view');
  await closeTop();
  await js(`SamDocs.printInvoice(${dbMod.listDocuments({ kind: 'sale' })[0].id}); 1`);
  await shot('13-print-invoice');
  await js(`[...document.querySelectorAll('.pv')].pop().querySelectorAll('.pv-bar .btn-ghost')[1].click(); 1`);
  await js(`SamDocs.printGatePass(${dbMod.listDocuments({ kind: 'sale' })[0].id}); 1`);
  await shot('14-print-gatepass');
  await js(`[...document.querySelectorAll('.pv')].pop().querySelectorAll('.pv-bar .btn-ghost')[1].click(); 1`);

  await go('production');
  await shot('15-production-issues');
  await js(`document.querySelector('#prodTabs .tab[data-tab=receipts]').click()`);
  await sleep(700);
  await js(`document.getElementById('btnNewReceipt').click()`);
  await sleep(900);
  await shot('16-production-receipt-form');
  await closeTop();
  await js(`document.querySelector('#prodTabs .tab[data-tab=tolling]').click()`);
  await sleep(600);
  await shot('17-production-tolling');
  await js(`document.querySelector('#prodTabs .tab[data-tab=scrap]').click()`);
  await sleep(600);
  await shot('18-production-scrap');
  await js(`document.querySelector('#prodTabs .tab[data-tab=archive]').click()`);
  await sleep(600);
  await shot('19-production-archive');
  await js(`SamProd.printReceipt(${dbMod.listReceipts(1)[0].id}); 1`);
  await shot('20-print-receipt');
  await js(`[...document.querySelectorAll('.pv')].pop().querySelectorAll('.pv-bar .btn-ghost')[1].click(); 1`);

  await go('reports');
  await js(`document.getElementById('btnRunReport').click()`);
  await sleep(1400);
  await shot('21-reports-good-only');
  await js(`(() => { [...document.querySelectorAll('#bucketWrap input')].forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }); return 1; })()`);
  await sleep(1600);
  await shot('22-reports-all-buckets');
  await js(`document.getElementById('btnPrintReport').click()`);
  await shot('23-print-report');
  await js(`[...document.querySelectorAll('.pv')].pop().querySelectorAll('.pv-bar .btn-ghost')[1].click(); 1`);

  await go('settings');
  await shot('24-settings-general');
  await js(`document.querySelector('#settingsTabs .tab[data-tab=users]').click()`);
  await sleep(900);
  await shot('25-settings-users');
  await js(`document.getElementById('btnAddUser').click()`);
  await sleep(700);
  await shot('26-user-form');
  await closeTop();
  await js(`document.querySelector('#settingsTabs .tab[data-tab=backup]').click()`);
  await sleep(900);
  await shot('27-settings-backup');
  await js(`document.querySelector('#settingsTabs .tab[data-tab=update]').click()`);
  await sleep(900);
  await shot('28-settings-update');

  /* empty-state + toast look: wipe a filtered list */
  await go('items');
  await js(`(() => { const i = document.getElementById('itemSearch'); i.value = 'لايوجد'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(900);
  await shot('29-items-empty-state');

  /* dark-surface check: a hard-delete confirm (danger) + toast */
  await js(`(() => { const i = document.getElementById('itemSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(900);
  await js(`document.querySelector('#itemsTbl tbody tr').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 320 }))`);
  await sleep(400);
  await shot('30-context-menu');
  await js(`(() => { [...document.querySelectorAll('.ctx-item')].find(x => /حذف نهائي/.test(x.textContent)).click(); return 1; })()`);
  await sleep(800);
  await shot('31-hard-delete-warning');
  await closeTop();
  await js(`SamUI.toast('تم حفظ المستند رقم SAL-0004', 'ok'); SamUI.toast('رصيد صنف واحد أصبح سالباً', 'bad'); SamUI.toast('قيمة الفاتورة نصية غير رقمية', 'warn')`);
  await shot('32-toasts');

  console.log(errors.length ? 'RENDERER ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(errors.length ? 1 : 0);
});
