'use strict';

/**
 * tools/ui-shots.js — يلتقط صوراً لكل شاشات البرنامج.
 *
 * الغرض: معرفة ما يراه المستخدم فعلاً — حجم المربعات والخط والفراغات —
 * قبل أي تعديل على التصميم، وبعده للمقارنة.
 *
 * التشغيل:
 *   env -u ELECTRON_RUN_AS_NODE npx electron tools/ui-shots.js [مجلد الإخراج]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'uishots', process.argv[2] || 'now');
const DATA = path.join(ROOT, '.tmp', 'uishots-data');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  app.exit(code);
}
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });

process.env.SAM_DATA_DIR = DATA;
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 800) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(`(() => { try { document.getAnimations().forEach(a => a.cancel()); } catch (e) {} return 1; })()`, true);
  } catch (e) { /* navigating */ }
  await sleep(80);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  console.log('shot ->', name);
}

app.whenReady().then(async () => {
  dbMod.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* بيانات واقعية حتى لا تكون الشاشات فارغة */
  const whA = dbMod.addWarehouse({ code: 'W-01', name: 'المخزن الرئيسي', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-02', name: 'مخزن الإنتاج', location: 'خلف خط النفخ' });
  const i1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5250, defect: 120 }]);
  const i2 = dbMod.addItem({ code: '0002', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12 },
    [{ warehouseId: whA.id, good: 1800 }]);
  dbMod.addItem({ code: '0003', name: 'غطاء بلاستيك 28 مم', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 500 },
    [{ warehouseId: whB.id, good: 4200 }]);
  dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  dbMod.addParty({ name: 'شركة الأمل', phone: '0555000000', type: 'supplier' });

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  const views = ['dashboard', 'items', 'warehouses', 'parties', 'transactions', 'production', 'daily', 'reports', 'settings'];
  for (const v of views) {
    await js(`document.querySelector('.nav-item[data-view=${JSON.stringify(v)}]').click()`);
    await sleep(1100);
    await shot('view-' + v);
  }

  /* صفحة إدخال الصنف — التي وصفها المستخدم بأنها ملخبطة */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(900);
  await js(`window.SamItems.openForm(null); 1`);
  await sleep(900);
  await shot('form-item-new');
  await js(`(() => { const b = [...document.querySelectorAll('.overlay .modal-foot .btn')].pop(); if (b) b.click(); return 1; })()`);
  await sleep(500);

  /* محرّر المستند — بطاقات الأنواع */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(900);
  await js(`window.SamDocs.openEditor(null); 1`);
  await sleep(1200);
  await shot('editor-kinds');
  await js(`(() => { const b = [...document.querySelectorAll('.overlay .modal-foot .btn')].pop(); if (b) b.click(); return 1; })()`);
  await sleep(500);

  /* الإنتاج */
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(1100);
  await shot('view-production-2');

  /* معاينة الطباعة — التصريح */
  await js(`(() => {
    const rows = [...document.querySelectorAll('#reportTbl tbody tr, .tbl tbody tr')];
    return rows.length;
  })()`);

  console.log('DONE ->', OUT);
  shutdown(0);
});
