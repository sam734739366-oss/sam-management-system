/**
 * tools/v5-visual.js — the visual sweep of the V5 round.
 *
 * It opens the real app and photographs the screens the customer asked
 * about, so the plates, the backgrounds and the flexible layout can be
 * judged with the eyes and not only with assertions:
 *
 *   10..15  the windows that carry their own header plate
 *           (the guide, the report centre, the update window)
 *   20..24  the responsive ladder — 1400 / 1180 / 940 / 760 px
 *   30..33  the item form and the document editor at two widths
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v5-visual.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v5visual');
const DATA = path.join(ROOT, '.tmp', 'v5visual-data');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  app.exit(code);
}
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.message ? e.message : e));
  shutdown(1);
});
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(problems.length ? 1 : 0); } });

console.log('BOOT ' + new Date().toISOString());

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

['update:state', 'update:feed', 'update:check', 'update:backup'].forEach((ch) => {
  try { ipcMain.handle(ch, () => ({ ok: true, data: ch === 'update:feed' ? [] : { state: 'idle' } })); }
  catch (e) { /* already registered */ }
});

app.whenReady().then(async () => {
  dbMod.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'خلف خط النفخ' });
  const item1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5000 }, { warehouseId: whB.id, good: 3000 }]);
  dbMod.addItem({ code: '0002', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام' },
    [{ warehouseId: whA.id, good: 1000 }]);
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  const doc = dbMod.saveDocument({
    kind: 'sale', doc_no: 'V5-001', party_id: cust.id, warehouse_id: whA.id,
    invoice_value: '150000', notes: 'فاتورة اختبار', doc_date: '2026-01-05',
    lines: [{ item_id: item1.id, warehouse_id: whA.id, bucket: 'good', pieces: 120, cartons: 5, bags: 0 }]
  });

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#eef2f8',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? (({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level) : d.level;
    if (lvl >= 2) { problems.push(`[console] ${d.message}`); console.log('CONSOLE ' + lvl + ': ' + String(d.message || '').slice(0, 240)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    problems.push('JS FAILED: ' + e.message);
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 180) + ' :: ' + e.message);
    return null;
  });
  const shot = async (name, settle = 800) => {
    await sleep(settle);
    try { await win.webContents.capturePage(); } catch (e) {}
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('shot -> ' + name);
  };
  const resize = async (w, h = 900) => {
    win.setSize(w, h);
    await sleep(650);
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  /* a hidden window does not tick its animations, so every overlay would be
     caught mid-fade. Freeze them: the review must show the settled look. */
  await js(`(() => {
    const s = document.createElement('style');
    s.textContent = '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;transition-duration:0s !important;transition-delay:0s !important}';
    document.head.appendChild(s);
    return 1;
  })()`);

  /* ---------------- the windows that own a header plate ---------------- */
  await js(`document.getElementById('btnHelp').click()`);
  await shot('10-guide');
  await js(`document.querySelector('.guide-x').click()`);

  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(1200);
  await shot('11-report-centre');
  await js(`void SamReports.openWindow('movements')`);
  await sleep(900);
  await shot('12-report-window');
  await js(`document.querySelector('.rw-x').click()`);

  await js(`document.getElementById('btnUpdate').click()`);
  await shot('13-update-window');
  await js(`document.querySelector('.updwin-x').click()`);

  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(1000);
  await shot('14-settings');

  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(900);
  await shot('15-transactions');

  /* ---------------- the responsive ladder ---------------- */
  await js(`document.querySelector('.nav-item[data-view=dashboard]').click()`);
  await sleep(900);
  for (const [w, tag] of [[1400, '20-w1400'], [1180, '21-w1180'], [940, '22-w940'], [760, '23-w760']]) {
    await resize(w, 900);
    await shot(tag);
  }
  await resize(1440, 900);

  /* ---------------- the forms at two widths ---------------- */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(900);
  await js(`SamItems.openForm(null); 1`);
  await shot('30-item-form-1440');
  await resize(940, 900);
  await shot('31-item-form-940');
  await resize(1440, 900);
  await js(`document.querySelector('.overlay .modal .btn[data-act=cancel], .overlay .modal .modal-foot .btn-ghost').click()`);

  await js(`SamDocs.openEditor(${doc.id}); 1`);
  await shot('32-editor-1440');
  await resize(940, 900);
  await shot('33-editor-940');

  console.log('\n=== visual sweep done ===');
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console errors');
  await shutdown(problems.length ? 1 : 0);
}).catch((e) => { console.log('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
