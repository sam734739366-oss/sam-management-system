/**
 * tools/check-print.js — فحص هندسة الطباعة الفعلي�� (اختبار انحدار).
 *
 * ي boots البرنامج الحقيقي، ثم:
 *   1) يطبع تقرير حركة المخزون (عرضي) ويحفظ PDF — ويتأكد أن حجم الصفحة
 *      A4 عرضي (842×595 نقطة) وليس عمودياً، فلا يُقصّ ربع الصفحة.
 *   2) يتأكد أن محتوى الورقة لا يفيض أفقياً خارج حدودها.
 *   3) يطبع تقرير اليوم (عرضي) ويتأكد من حجم صفحته.
 *   4) يطبع تصريح خروج (نصف ورقة) ويتأكد أن الصفحة A4 عمودية.
 *   5) يتأكد أن مسار الطابعة (webContents.print) يستقبل الاتجاه والمقاس
 *      الصحيحين — فالمسار لا يقرأ CSS في Chromium.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/check-print.js
 * Exit code 0 = كل الفحوص ناجحة.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'printcheck');
const DATA = path.join(ROOT, '.tmp', 'printcheck-data');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
let failures = 0;
function say(m) { lines.push(String(m)); console.log(m); }
function check(ok, label, detail) {
  if (!ok) failures += 1;
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

/* ---------- قراءة أحجام صفحات PDF فعلاً ---------- */
function inflateChunks(buf) {
  const texts = [buf.toString('latin1')];
  const marker = Buffer.from('stream');
  let i = 0;
  while (true) {
    i = buf.indexOf(marker, i);
    if (i < 0) break;
    let s = i + marker.length;
    if (buf[s] === 0x0d) s += 1;
    if (buf[s] === 0x0a) s += 1;
    const e = buf.indexOf(Buffer.from('endstream'), s);
    if (e < 0) break;
    const raw = buf.slice(s, e);
    try {
      texts.push(zlib.inflateSync(raw).toString('latin1'));
    } catch (err) {
      try { texts.push(zlib.inflateRawSync(raw).toString('latin1')); } catch (e2) { /* ليس deflate */ }
    }
    i = e + 9;
  }
  return texts;
}

function pdfBoxes(file) {
  const buf = fs.readFileSync(file);
  const texts = inflateChunks(buf);
  const boxes = [];
  const re = /\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/g;
  texts.forEach((t) => {
    let m;
    while ((m = re.exec(t))) {
      const w = Math.round(Math.abs(Number(m[3]) - Number(m[1])) * 100) / 100;
      const h = Math.round(Math.abs(Number(m[4]) - Number(m[2])) * 100) / 100;
      if (!boxes.some((b) => b.w === w && b.h === h)) boxes.push({ w, h });
    }
  });
  return boxes;
}

const A4P = { w: 595, h: 842 };
const A4L = { w: 842, h: 595 };
const near = (box, want) => box && Math.abs(box.w - want.w) < 3 && Math.abs(box.h - want.h) < 3;

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let win;
let cleanedUp = false;
async function shutdown(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n')); } catch (e) {}
  app.exit(code);
}
process.on('unhandledRejection', (e) => say('UNHANDLED: ' + (e && e.message ? e.message : e)));
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(failures ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

['update:state', 'update:feed', 'update:check', 'update:backup'].forEach((ch) => {
  try { ipcMain.handle(ch, () => ({ ok: true, data: ch === 'update:feed' ? [] : { state: 'idle' } })); }
  catch (e) { /* مسجّل مسبقاً */ }
});

/* ---- التقاط الـ PDF بدل حوار الحفظ ---- */
let pdfSeq = 0;
const capturedPrintOptions = [];
ipcMain.removeHandler('win:savePdf');
ipcMain.handle('win:savePdf', async () => {
  pdfSeq += 1;
  const file = path.join(OUT, `export-${pdfSeq}.pdf`);
  try {
    const staged = await win.webContents.executeJavaScript(
      `(function () {
         var h = document.getElementById('printHost');
         var p = h && h.firstElementChild;
         var pg = document.querySelector('.print-page');
         return {
           hostClass: document.body.className,
           hostChildren: h ? h.children.length : -1,
           rootClass: p ? p.className : null,
           rootPage: p ? getComputedStyle(p).page : null,
           sheetPage: p && p.querySelector('.sheet') ? getComputedStyle(p.querySelector('.sheet')).page : null
         };
       })()`, true);
    say('حالة التجهيز: ' + JSON.stringify(staged));
    const data = await win.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true, marginType: 'none'
    });
    fs.writeFileSync(file, data);
    return { ok: true, path: file };
  } catch (e) {
    say('فشل التقاط PDF: ' + (e && e.message ? e.message : String(e)));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

app.whenReady().then(async () => {
  dbMod.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'خلف خط النفخ' });
  const item1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5000 }, { warehouseId: whB.id, good: 3000 }]);
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  dbMod.saveDocument({
    kind: 'sale', doc_no: 'CHK-1', party_id: cust.id, warehouse_id: whA.id,
    invoice_value: '150000', notes: 'فحص', doc_date: '2026-01-05',
    lines: [{ item_id: item1.id, warehouse_id: whA.id, bucket: 'good', pieces: 120, cartons: 5, bags: 0 }]
  });

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#eef2f8',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  /* نعترض استدعاء الطابعة لنلتقط الخيارات التي يبنيها ipc.js بدل فتح حوار */
  win.webContents.print = (opts, cb) => { capturedPrintOptions.push(opts); setTimeout(() => cb(true, ''), 10); };

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { say('JS ERROR: ' + e.message); return null; }
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);
  await js(`(() => { const s=document.createElement('style'); s.textContent='*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}'; document.head.appendChild(s); return 1; })()`);

  /* قياس فيض الورقة أفقياً — compared with the sheet's BORDER box: the
     watermark is meant to cover the whole sheet (margins included). */
  const measure = `(() => {
    const pg = document.querySelector('.print-page');
    if (!pg) return { error: 'no preview' };
    const sh = pg.querySelector('.sheet');
    const scale = pg.getBoundingClientRect().width / (pg.offsetWidth || 1);
    const sr = sh.getBoundingClientRect();
    const over = [];
    sh.querySelectorAll('*').forEach((n) => {
      const r = n.getBoundingClientRect();
      if (!r.width) return;
      const outRight = r.right / scale - sr.right / scale;
      const outLeft = sr.left / scale - r.left / scale;
      if (outRight > 1 || outLeft > 1) {
        over.push({ cls: String(n.className || '').slice(0, 40), outRight: Math.round(outRight), outLeft: Math.round(outLeft) });
      }
    });
    return {
      pageClass: pg.className,
      pageW: pg.offsetWidth, pageH: pg.offsetHeight,
      sheetW: sh.offsetWidth, sheetH: sh.offsetHeight,
      overflowPx: sh.scrollWidth - sh.clientWidth,
      worst: over.slice(0, 5), worstCount: over.length
    };
  })()`;

  /* ---------- 1) تقرير حركة المخزون (عرضي) ---------- */
  await js(`SamReports.openWindow('movements'); 1`);
  await sleep(2000);
  await js(`SamReports.printReport(); 1`);
  await sleep(1500);

  const g = await js(measure);
  say('=== قياس المعاينة ===');
  say(JSON.stringify(g, null, 2));
  check(!!g && !g.error, 'المعاينة تُبنى', g && g.error);
  check(!!g && g.worstCount === 0, 'لا فيض أفقي خارج حدود الورقة',
    g ? `أقصى فيض ${g.worstCount} عنصر (${JSON.stringify(g.worst.slice(0, 2))})` : '');
  check(!!g && g.pageClass.indexOf('land') >= 0, 'صفحة المعاينة عرضية', g ? g.pageClass : '');

  /* مسار الطابعة */
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('طباعة')>=0); if(b) b.click(); return 1; })()`);
  await sleep(1200);
  const lastPrint = capturedPrintOptions[capturedPrintOptions.length - 1];
  say('خيارات الطابعة: ' + JSON.stringify(lastPrint));
  check(!!lastPrint && lastPrint.landscape === true, 'الطابعة تستقبل landscape=true', JSON.stringify(lastPrint && lastPrint.landscape));
  check(!!lastPrint && lastPrint.pageSize === 'A4', 'الطابعة تستقبل pageSize=A4', JSON.stringify(lastPrint && lastPrint.pageSize));

  /* مسار الـ PDF */
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('حفظ PDF')>=0); if(b) b.click(); return 1; })()`);
  await sleep(2500);
  let files = fs.readdirSync(OUT).filter((f) => f.startsWith('export-')).sort();
  let file = files.length ? path.join(OUT, files[files.length - 1]) : null;
  let boxes = file ? pdfBoxes(file) : [];
  say('حجم صفحة PDF (حركة المخزون): ' + JSON.stringify(boxes));
  check(boxes.some((b) => near(b, A4L)), 'PDF تقرير حركة المخزون A4 عرضي (297×210 مم)', JSON.stringify(boxes));
  check(!boxes.some((b) => near(b, A4P)), 'PDF ليس عمودياً (لا ربع صفحة مقصوص)', JSON.stringify(boxes));

  /* إغلاق المعاينة */
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('إغلاق')>=0); if(b) b.click(); return 1; })()`);
  await sleep(600);

  /* ---------- 2) التقرير اليومي (عرضي) ---------- */
  await js(`(async () => { await SamDaily.load(); SamDaily.printDaily(); return 1; })()`);
  await sleep(1800);
  const gd = await js(measure);
  check(!!gd && !gd.error, 'معاينة التقرير اليومي تُبنى', gd && gd.error);
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('حفظ PDF')>=0); if(b) b.click(); return 1; })()`);
  await sleep(2500);
  files = fs.readdirSync(OUT).filter((f) => f.startsWith('export-')).sort();
  file = files.length ? path.join(OUT, files[files.length - 1]) : null;
  boxes = file ? pdfBoxes(file) : [];
  say('حجم صفحة PDF (التقرير اليومي): ' + JSON.stringify(boxes));
  check(boxes.some((b) => near(b, A4L)), 'PDF التقرير اليومي A4 عرضي', JSON.stringify(boxes));

  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('إغلاق')>=0); if(b) b.click(); return 1; })()`);
  await sleep(600);

  /* ---------- 3) تصريح خروج (نصف ورقة) ---------- */
  await js(`(async () => { await SamDocs.load(); const d=(await SamDB.call('listDocuments',{kind:'sale'}))[0]; await SamDocs.printPermits(d.id); return 1; })()`);
  await sleep(1800);
  const gp = await js(measure);
  check(!!gp && !gp.error, 'معاينة التصريح تُبنى', gp && gp.error);
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('حفظ PDF')>=0); if(b) b.click(); return 1; })()`);
  await sleep(2500);
  files = fs.readdirSync(OUT).filter((f) => f.startsWith('export-')).sort();
  file = files.length ? path.join(OUT, files[files.length - 1]) : null;
  boxes = file ? pdfBoxes(file) : [];
  say('حجم صفحة PDF (التصريح): ' + JSON.stringify(boxes));
  check(boxes.some((b) => near(b, A4P)), 'PDF التصريح A4 عمودي (تصريحان بنصف ورقة)', JSON.stringify(boxes));

  say(`=== النتيجة: ${failures ? failures + ' فحص فاشل' : 'كل الفحوص ناجحة'} ===`);
  await shutdown(failures ? 1 : 0);
}).catch((e) => { say('FATAL: ' + (e && e.stack ? e.stack : e)); failures += 1; shutdown(1); });
