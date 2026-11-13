/**
 * tools/v5-check.js — the V5 acceptance run.
 *
 * It drives the REAL renderer and checks the five things the customer
 * asked for in this round:
 *   1. the item form: every box the same width and the same height
 *   2. the print preview: real paper, one A4 page per sheet, the right
 *      paper size in the produced PDF (measured from the PDF itself)
 *   3. the permits: ONE permit per half sheet (A5 landscape), two per A4
 *   4. the edit date: an edit carries TODAY, not the creation date
 *   5. the cloud sync: the e-mail alone decides the client
 *
 * It also writes screenshots to .tmp/v5shots for a visual review.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v5-check.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v5shots');
const DATA = path.join(ROOT, '.tmp', 'v5data');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const cloudsync = require(path.join(ROOT, 'src', 'main', 'cloudsync.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v5-report.txt');
function log(line) {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  try { console.log(line); } catch (e) {}
}
function check(name, ok, detail) {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) {
      if (attempt === tries) { log(`WARN: ${label} still locked (${e.code})`); return false; }
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
process.on('unhandledRejection', (e) => { log('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

log('BOOT ' + new Date().toISOString());

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

/* the updater is wired in main.js — stub its channels here so the renderer
   never logs "no handler registered" during the run */
['update:state', 'update:feed', 'update:check', 'update:backup'].forEach((ch) => {
  try { ipcMain.handle(ch, () => ({ ok: true, data: ch === 'update:feed' ? [] : { state: 'idle' } })); }
  catch (e) { /* already registered */ }
});

/** read every /MediaBox out of a PDF buffer (points, 1pt = 1/72 inch) */
function pdfBoxes(buf) {
  const txt = buf.toString('latin1');
  const out = [];
  const re = /\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/g;
  let m;
  while ((m = re.exec(txt))) {
    out.push([Math.round(Number(m[3]) - Number(m[1])), Math.round(Number(m[4]) - Number(m[2]))]);
  }
  return out;
}

app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  await rmRetry(OUT, { tries: 4 });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* ---------------- seed ---------------- */
  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'خلف خط النفخ' });
  const item1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5000 }, { warehouseId: whB.id, good: 3000 }]);
  const item2 = dbMod.addItem({ code: '0002', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام' },
    [{ warehouseId: whA.id, good: 1000 }]);
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });

  /* a sale that leaves from TWO warehouses → TWO permits */
  const doc = dbMod.saveDocument({
    kind: 'sale',
    doc_no: 'V5-001',
    party_id: cust.id,
    warehouse_id: whA.id,
    invoice_value: '150000',
    notes: 'فاتورة اختبار V5',
    doc_date: '2026-01-05',
    lines: [
      { item_id: item1.id, warehouse_id: whA.id, bucket: 'good', pieces: 120, cartons: 5, bags: 0 },
      { item_id: item1.id, warehouse_id: whB.id, bucket: 'good', pieces: 40, cartons: 0, bags: 2 }
    ]
  });

  /* ---------------- window ---------------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#eef2f8',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); log('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });
  const shot = async (name, settle = 700) => {
    await sleep(settle);
    try { await win.webContents.capturePage(); } catch (e) {}
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    log('shot -> ' + name);
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);
  await shot('01-dashboard');

  /* ================= 1. the item form: equal boxes ================= */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(900);
  await js(`SamItems.openForm(null); 1`);
  await sleep(900);
  await shot('02-item-form');

  const formGeom = await js(`(() => {
    const modal = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!modal) return { error: 'no modal' };
    const grids = modal.querySelectorAll('.form-grid-4');
    const fields = [...modal.querySelectorAll('.form-grid-4 .field')];
    /* a field may hold something else than a plain input (the picture,
       the unit of its own) — only the plain inputs are measured */
    const boxes = fields.map((f) => {
      const i = f.querySelector('.input');
      if (!i) return null;
      const r = i.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(Boolean);
    const bal = [...modal.querySelectorAll('.bal-grid .bal-in')].map((i) => {
      const r = i.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    const whRows = modal.querySelectorAll('.bal-grid .wh-name').length;
    return {
      grids: grids.length,
      fields: boxes.length,
      widths: [...new Set(boxes.map((b) => b.w))],
      heights: [...new Set(boxes.map((b) => b.h))],
      balWidths: [...new Set(bal.map((b) => b.w))],
      balHeights: [...new Set(bal.map((b) => b.h))],
      balCount: bal.length,
      whRows,
      sections: modal.querySelectorAll('.form-sec').length
    };
  })()`);
  check('the item form has two 4-column groups', formGeom.grids === 2, formGeom);
  check('all the input boxes share one width', formGeom.widths && formGeom.widths.length === 1, formGeom.widths);
  check('all the input boxes share one height', formGeom.heights && formGeom.heights.length === 1, formGeom.heights);
  check('the balance boxes share one width', formGeom.balWidths && formGeom.balWidths.length === 1, formGeom.balWidths);
  check('the balance boxes share one height', formGeom.balHeights && formGeom.balHeights.length === 1, formGeom.balHeights);
  check('every warehouse row has exactly 2 balance boxes',
    formGeom.whRows > 0 && formGeom.balCount === formGeom.whRows * 2,
    { balCount: formGeom.balCount, whRows: formGeom.whRows });
  check('the item form has its section headers', formGeom.sections === 3, formGeom.sections);

  await js(`(() => { const b = [...document.querySelectorAll('.overlay .modal .modal-foot .btn')].reverse().find(x => /إلغاء|إغلاق/.test(x.textContent)); if (b) b.click(); return 1; })()`);
  await sleep(500);

  /* ================= 2. the permits: one per half sheet ================= */
  const permitInfo = await js(`(async () => {
    const d = await SamDB.call('getDocument', ${JSON.stringify(doc.id)});
    const pages = SamDocs.permitPages(d);
    return { count: pages.length, first: pages[0] ? pages[0].title : null, lines: d.lines.length };
  })()`);
  check('the sale produces two permits (two warehouses)', permitInfo.count === 2, permitInfo);

  /* open the permit preview */
  await js(`SamDocs.printPermits(${JSON.stringify(doc.id)}); 1`);
  await sleep(1200);
  await shot('03-permit-preview');

  const pv = await js(`(() => {
    const ov = document.querySelector('.pv');
    if (!ov) return { error: 'no preview' };
    const pages = [...ov.querySelectorAll('.print-page')];
    const halves = [...ov.querySelectorAll('.sheet.half')];
    const cut = ov.querySelector('.pv-cut');
    const cap = ov.querySelector('.pv-cap');
    const first = halves[0] ? halves[0].getBoundingClientRect() : null;
    const second = halves[1] ? halves[1].getBoundingClientRect() : null;
    const pg = pages[0] ? pages[0].getBoundingClientRect() : null;
    return {
      pages: pages.length,
      halves: halves.length,
      hasCut: !!cut,
      cap: cap ? cap.textContent.trim() : null,
      halfW: first ? Math.round(first.width) : 0,
      halfH: first ? Math.round(first.height) : 0,
      pageW: pg ? Math.round(pg.width) : 0,
      pageH: pg ? Math.round(pg.height) : 0,
      secondTop: second ? Math.round(second.top - first.top) : 0,
      zoom: document.querySelector('.pv-zv') ? document.querySelector('.pv-zv').textContent : null,
      hasZoomBtns: ov.querySelectorAll('.pv-zoom button').length
    };
  })()`);
  check('the permit preview shows one A4 page', pv.pages === 1, pv);
  check('two permits share that page', pv.halves === 2, pv.halves);
  check('the preview shows the cut line', pv.hasCut === true, pv.hasCut);
  check('the preview names the page and the paper', /صفحة 1/.test(pv.cap || '') && /A4/.test(pv.cap || ''), pv.cap);
  check('the preview offers zoom controls', pv.hasZoomBtns === 3, pv.hasZoomBtns);
  check('each permit is exactly half the page height', Math.abs(pv.secondTop - pv.halfH) <= 2, { secondTop: pv.secondTop, halfH: pv.halfH });

  /* ---- the printed PDF: the page boxes tell the truth ---- */
  const pdf = await (async () => {
    await js(`(() => {
      const host = document.getElementById('printHost');
      const src = document.querySelector('.pv .pv-pages');
      host.innerHTML = '';
      const clone = src.cloneNode(true);
      clone.style.transform = '';
      host.appendChild(clone);
      document.body.classList.add('is-printing');
      return 1;
    })()`);
    await sleep(400);
    const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, marginType: 'none' });
    await js(`(() => { document.body.classList.remove('is-printing'); document.getElementById('printHost').innerHTML=''; return 1; })()`);
    fs.writeFileSync(path.join(OUT, 'permits.pdf'), data);
    return pdfBoxes(data);
  })();
  log('   PDF boxes: ' + JSON.stringify(pdf));
  check('the permit PDF has exactly one page', pdf.length === 1, pdf.length);
  check('the permit PDF page is A4 portrait (595×842pt)', pdf.length === 1 && Math.abs(pdf[0][0] - 595) <= 3 && Math.abs(pdf[0][1] - 842) <= 3, pdf[0]);

  await js(`(() => { const pv = document.querySelector('.pv'); if (pv) pv.querySelector('.pv-bar .btn-ghost:last-of-type').click(); return 1; })()`);
  await sleep(500);

  /* ================= 3. a full A4 sheet prints on one A4 page ================= */
  await js(`(() => {
    SamUI.printPreview({
      title: 'تقرير اختبار',
      docRef: 'RPT-TEST',
      head: [{ k: 'الفترة', v: 'كل الفترات' }],
      bodyHtml: '<p class="doc-note">هذا نص تجريبي للتأكد من أن الورقة تملأ صفحة A4 واحدة.</p>' +
        SamUI.tableHtml([{ key: 'a', label: 'الصنف' }, { key: 'b', label: 'الكمية' }],
          [{ a: 'أمبولة منفوخة', b: '120' }, { a: 'مياه جلدلة', b: '40' }], '160'),
      signatures: ['المعد', 'المراجع', 'المدير']
    }); 1;
  })()`);
  await sleep(1100);
  await shot('04-sheet-preview');
  const sheetPdf = await (async () => {
    await js(`(() => {
      const host = document.getElementById('printHost');
      const src = document.querySelector('.pv .pv-pages');
      host.innerHTML = '';
      const clone = src.cloneNode(true);
      clone.style.transform = '';
      host.appendChild(clone);
      document.body.classList.add('is-printing');
      return 1;
    })()`);
    await sleep(400);
    const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, marginType: 'none' });
    await js(`(() => { document.body.classList.remove('is-printing'); document.getElementById('printHost').innerHTML=''; return 1; })()`);
    fs.writeFileSync(path.join(OUT, 'sheet.pdf'), data);
    return pdfBoxes(data);
  })();
  log('   sheet PDF boxes: ' + JSON.stringify(sheetPdf));
  check('the report PDF has exactly one page', sheetPdf.length === 1, sheetPdf.length);
  check('the report PDF page is A4 portrait', sheetPdf.length === 1 && Math.abs(sheetPdf[0][0] - 595) <= 3 && Math.abs(sheetPdf[0][1] - 842) <= 3, sheetPdf[0]);
  await js(`(() => { const pv = document.querySelector('.pv'); if (pv) pv.querySelector('.pv-bar .btn-ghost:last-of-type').click(); return 1; })()`);
  await sleep(500);

  /* ================= 4. the edit carries TODAY ================= */
  /* a BRAND NEW document opens on today, with no old-date hint */
  await js(`SamDocs.openEditor(null, 'sale'); 1`);
  await sleep(1300);
  const newDates = await js(`(() => {
    const inp = document.querySelector('.modal.editor input[type=date]');
    const hints = [...document.querySelectorAll('.modal.editor .hint-txt')].map(h => h.textContent.trim());
    const dateHint = hints.find(h => h.indexOf('تاريخ الإنشاء الأصلي') >= 0) || null;
    return { value: inp ? inp.value : null, today: SamUI.today(), dateHint, hints };
  })()`);
  check("a new document opens on today's date", newDates.value === newDates.today, newDates);
  check('a new document shows no old-date hint', !newDates.dateHint, newDates.dateHint);
  /* V6 — the editor also explains the internal number it will give */
  check('the editor explains the internal number of the new document',
    newDates.hints.some((h) => h.indexOf('رقم النظام') >= 0), newDates.hints);
  await js(`(() => { const b = [...document.querySelectorAll('.overlay .modal .modal-foot .btn')].reverse().find(x => /إلغاء|إغلاق/.test(x.textContent)); if (b) b.click(); return 1; })()`);
  await sleep(600);

  /* an OLD document opens on today too, and shows where it came from */
  const beforeEdit = dbMod.getDocument(doc.id);
  await js(`SamDocs.openEditor(${JSON.stringify(doc.id)}); 1`);
  await sleep(1300);
  const editDates = await js(`(() => {
    const inp = document.querySelector('.modal.editor input[type=date]');
    /* the hint of the DATE cell — the editor carries other hints too */
    const hint = document.querySelector('.modal.editor .date-cell .hint-txt');
    return { value: inp ? inp.value : null, today: SamUI.today(), hint: hint ? hint.textContent : null };
  })()`);
  check('editing an old document shows today, not the old date', editDates.value === editDates.today, editDates);
  check('the original creation date stays visible', /تاريخ الإنشاء الأصلي/.test(editDates.hint || ''), editDates.hint);
  await shot('05-editor');

  /* ---- the icon plate must never carry the button's label ----
     the plate is the FIRST span of a button, so a stray
     querySelector('span') would pour the label text INTO the icon */
  const plates = await js(`(() => {
    const bad = [];
    const scan = (root, where) => {
      [...root.querySelectorAll('.t3d')].forEach((p) => {
        const t = (p.textContent || '').trim();
        if (t) bad.push({ where, cls: p.className, text: t.slice(0, 60) });
      });
    };
    scan(document, 'document');
    const foot = document.querySelector('.modal.editor .modal-foot');
    if (foot) scan(foot, 'editor-foot');
    /* and every plate-carrying button keeps a separate label */
    const noLabel = [...document.querySelectorAll('.btn')].filter((b) =>
      b.querySelector('.t3d') && !b.querySelector('.btn-txt') &&
      !/^\\s*$/.test(b.textContent || '')).map((b) => ({
      cls: b.className, text: (b.textContent || '').trim().slice(0, 60)
    }));
    const footBtns = foot ? [...foot.querySelectorAll('.btn')].map((b) => ({
      act: b.dataset.act || null,
      plate: (b.querySelector('.t3d') || {}).textContent || '',
      label: b.querySelector('.btn-txt') ? b.querySelector('.btn-txt').textContent.trim() : null
    })) : [];
    return { bad, noLabel, footBtns };
  })()`);
  check('no icon plate carries a text label', (plates.bad || []).length === 0, plates.bad);
  check('every plate-button keeps its own label span', (plates.noLabel || []).length === 0, plates.noLabel);
  check('the editor footer buttons show label and plate separately',
    (plates.footBtns || []).every((b) => !b.plate.trim() && (b.label === null || b.label.length > 0)),
    plates.footBtns);

  /* ---- and the edit is really SAVED through the editor ---- */
  const saved = await js(`(async () => {
    /* watch the very call the editor makes */
    const orig = SamDB.call;
    window.__saveLog = [];
    SamDB.call = async (n, ...a) => {
      try {
        const r = await orig(n, ...a);
        if (n === 'saveDocument') window.__saveLog.push({ n, ok: true, doc_no: r && r.doc_no });
        return r;
      } catch (e) {
        if (n === 'saveDocument') window.__saveLog.push({ n, ok: false, msg: e && e.message, raw: String(e).slice(0, 300) });
        throw e;
      }
    };
    const ta = document.querySelector('.modal.editor textarea');
    if (ta) { ta.value = 'ملاحظة بعد التعديل'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    const b = document.querySelector('.modal.editor .modal-foot .btn[data-act=save]');
    if (!b) return { error: 'no save button' };
    b.click();
    /* the editor may ask before saving a negative balance — answer it */
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 400));
      const warn = [...document.querySelectorAll('.overlay .modal .modal-foot .btn')]
        .find(x => /متابعة الحفظ/.test(x.textContent));
      if (warn) { warn.click(); }
    }
    await new Promise(r => setTimeout(r, 1500));
    const err = document.querySelector('.modal.editor .form-err');
    const stillOpen = !!document.querySelector('.modal.editor');
    const editors = document.querySelectorAll('.modal.editor').length;
    const btn = document.querySelector('.modal.editor .modal-foot .btn[data-act=save]');
    return {
      clicked: true, stillOpen, editors,
      btnDisabled: btn ? btn.disabled : null,
      log: window.__saveLog,
      err: err ? err.textContent.trim() : null
    };
  })()`);
  log('   save click: ' + JSON.stringify(saved));
  await js(`(() => { try { SamDB.call = SamDB.call; } catch (e) {} return 1; })()`);
  await sleep(900);

  /* ---- and the database follows the same rule ---- */
  const dbDates = dbMod.getDocument(doc.id);
  const today = dbMod.getDocument(doc.id) && new Date().toLocaleDateString('en-CA');
  check('the edited document carries the EDIT date', dbDates.doc_date === today, { doc_date: dbDates.doc_date, today });
  check('the database records the moment of the edit', !!dbDates.updated_at, dbDates.updated_at);
  check('the creation time never changes', dbDates.created_at === beforeEdit.created_at,
    { before: beforeEdit.created_at, now: dbDates.created_at });
  check('the edit was stored', dbDates.notes === 'ملاحظة بعد التعديل', dbDates.notes);
  const q = dbMod.reportQuery({ dateFrom: today, dateTo: today, includeCustomer: true });
  const todayMoves = (q.rows || []).filter((m) => m.docId === doc.id);
  check('the ledger rows of the edit carry the edit date', todayMoves.length > 0,
    { moveRows: todayMoves.length, sample: todayMoves[0] || null });

  await js(`(() => { const b = [...document.querySelectorAll('.overlay .modal .modal-foot .btn')].reverse().find(x => /إلغاء|إغلاق/.test(x.textContent)); if (b) b.click(); return 1; })()`);
  await sleep(400);

  /* ================= 5. the cloud sync: the e-mail alone ================= */
  const pick = cloudsync.chooseClient([
    { id: 'onedrive', label: 'OneDrive', installed: true, accounts: ['someone@outlook.com'] },
    { id: 'gdrive', label: 'Google Drive', installed: true, accounts: ['me@gmail.com'] }
  ], 'me@gmail.com', '');
  check('a gmail address picks Google Drive', pick.client.id === 'gdrive' && pick.why === 'account', pick);
  const pick2 = cloudsync.chooseClient([
    { id: 'onedrive', label: 'OneDrive', installed: true, accounts: ['someone@outlook.com'] },
    { id: 'gdrive', label: 'Google Drive', installed: true, accounts: [] }
  ], 'me@gmail.com', '');
  check('an unknown gmail address still picks Google Drive', pick2.client.id === 'gdrive' && pick2.why === 'provider', pick2);
  const pick3 = cloudsync.chooseClient([
    { id: 'onedrive', label: 'OneDrive', installed: true, accounts: ['someone@outlook.com'] },
    { id: 'gdrive', label: 'Google Drive', installed: true, accounts: [] }
  ], 'someone@outlook.com', '');
  check('an outlook address picks OneDrive', pick3.client.id === 'onedrive', pick3);

  /* ---- the live detection on this very machine ---- */
  const live = cloudsync.detectClients();
  const liveG = live.find((c) => c.id === 'gdrive');
  const driveFs = path.join(process.env.LOCALAPPDATA || path.join(ROOT, '.tmp'), 'Google', 'DriveFS');
  const driveInstalled = fs.existsSync(driveFs);
  check('the DriveFS client folder is found', driveInstalled, driveFs);
  if (driveInstalled) {
    check('Google Drive for Desktop is detected', !!liveG, live.map((c) => c.id));
    check('the detected Drive has a usable sync folder', !!(liveG && liveG.root), liveG && liveG.root);
    check('the signed-in Google account is read', !!(liveG && liveG.accountHint && liveG.accountHint.includes('@')),
      liveG && liveG.accountHint);
    check('the account address is clean (no log noise)',
      !!(liveG && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(liveG.accountHint || '')),
      liveG && liveG.accountHint);
    const livePick = cloudsync.chooseClient(live.filter((c) => c.installed),
      (liveG && liveG.accountHint) || 'x@gmail.com', '');
    check('the signed-in account routes to Google Drive', livePick.client.id === 'gdrive', livePick);
  }

  /* ---- the settings screen shows the folder and the note ---- */
  await js(`document.querySelector('.nav-item[data-view=settings]').click(); 1`);
  await sleep(700);
  await js(`SamSettings.showTab('data'); 1`);
  await sleep(1400);
  const cloudUi = await js(`(() => {
    const note = document.getElementById('cloudNote');
    const input = document.getElementById('cloudEmail');
    const info = document.getElementById('cloudInfo');
    const rows = info ? [...info.querySelectorAll('dt')].map((d) => d.textContent.trim()) : [];
    return {
      hasNote: !!note,
      hasInput: !!input,
      noteClass: note ? note.className : '',
      noteText: note ? note.textContent.trim().slice(0, 120) : '',
      email: input ? input.value : '',
      rows,
      hasFolderRow: rows.some((r) => /مجلد النسخ/.test(r)),
      hasFolderText: /SAM-Backups/.test(note ? note.textContent : '')
    };
  })()`);
  check('the cloud card has the e-mail field and the live note', cloudUi.hasNote && cloudUi.hasInput, cloudUi);
  check('the cloud card names the copy folder', cloudUi.hasFolderRow, cloudUi.rows);
  if (driveInstalled) {
    check('the live note shows where the copy lands', cloudUi.hasFolderText, cloudUi.noteText);
    check('the signed-in account is filled in for the user', /@/.test(cloudUi.email || ''), cloudUi.email);
  }
  await shot('40-cloud-sync');

  /* ================= 6. the 3D tiles are really there ================= */
  const tiles = await js(`(() => {
    const nav = [...document.querySelectorAll('.nav-item .t3d')];
    const kpi = [...document.querySelectorAll('.kpi .t3d')];
    const kc = [...document.querySelectorAll('.kc-ic')];
    const navTones = nav.map(n => [...n.classList].filter(c => c.startsWith('tone-'))[0] || null);
    const plate = nav[0] ? getComputedStyle(nav[0]) : null;
    return {
      nav: nav.length,
      kpi: kpi.length,
      kindCards: kc.length,
      navTones: [...new Set(navTones)],
      hasGradient: plate ? /gradient/.test(plate.backgroundImage) : false,
      hasShadow: plate ? plate.boxShadow !== 'none' : false
    };
  })()`);
  check('every navigation item carries a 3D tile', tiles.nav === 9, tiles);
  check('the KPI cards carry a 3D tile', tiles.kpi === 4, tiles);
  check('the tiles are painted with a gradient and a shadow', tiles.hasGradient && tiles.hasShadow, tiles);
  check('the navigation tiles use several colours', (tiles.navTones || []).length >= 5, tiles.navTones);

  /* ================= 7. the app still has no console errors ================= */
  check('no console errors', errors.length === 0, errors.slice(0, 6));

  log(`\n=== V5: ${pass} passed, ${fail} failed ===`);
  await shutdown(fail ? 1 : 0);
}).catch((e) => { log('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
