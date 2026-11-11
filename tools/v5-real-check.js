/**
 * tools/v5-real-check.js — the final acceptance run on the CUSTOMER'S data.
 *
 * The customer copied their live database into the project under the folder
 * "نسخة بيانات". This script works on a THROWAWAY copy of that file (their
 * data is never modified) and drives the real renderer against it:
 *
 *   1. the login with the password the customer gave
 *   2. every screen loads and shows THEIR rows (items, documents, production)
 *   3. the reports and the permits print on real paper (measured from the PDF)
 *   4. an edit of one of THEIR documents carries today's date, and the
 *      creation date stays untouched
 *   5. the pages stay flexible at four widths
 *   6. the cloud sync finds Google Drive on this machine
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v5-real-check.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v5realshots');
const DATA = path.join(ROOT, '.tmp', 'v5realdata');
const SOURCE = path.join(ROOT, 'نسخة بيانات', 'sam.db');
const RENDERER = path.join(ROOT, 'src', 'renderer');
/* The customer's own password is NEVER written in this file — it comes from
   the environment (SAM_REAL_PASSWORD) so the repository stays free of it.
   Run: SAM_REAL_PASSWORD=xxxx env -u ELECTRON_RUN_AS_NODE npx electron tools/v5-real-check.js */
const PASSWORD = (process.env.SAM_REAL_PASSWORD || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const cloudsync = require(path.join(ROOT, 'src', 'main', 'cloudsync.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v5-real-report.txt');
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

/** read every /MediaBox out of a PDF buffer (points, 1pt = 1/72 inch) */
function pdfBoxes(buf) {
  const txt = buf.toString('latin1');
  const out = [];
  const re = /\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/g;
  let m;
  while ((m = re.exec(txt))) out.push([Math.round(Number(m[3]) - Number(m[1])), Math.round(Number(m[4]) - Number(m[2]))]);
  return out;
}

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

app.whenReady().then(async () => {
  dbMod.close();
  if (!fs.existsSync(SOURCE)) { log('NO SOURCE DATABASE at ' + SOURCE); app.exit(1); return; }
  await rmRetry(DATA);
  await rmRetry(OUT, { tries: 4 });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  /* ---- a throwaway copy of the customer's data (their file stays untouched) ---- */
  const Database = require('better-sqlite3');
  const src = new Database(SOURCE, { readonly: true, fileMustExist: true });
  await src.backup(path.join(DATA, 'sam.db'));
  src.close();

  dbMod.init(DATA);
  session.ensureSeed();

  /* ---- what is inside the customer's data ---- */
  const probe = new Database(path.join(DATA, 'sam.db'), { readonly: true, fileMustExist: true });
  const count = (t) => { try { return probe.prepare(`select count(*) c from "${t}"`).get().c; } catch (e) { return -1; } };
  const realCounts = {
    items: count('items'), warehouses: count('warehouses'), parties: count('parties'),
    documents: count('documents'), stock_moves: count('stock_moves'),
    prod_receipts: count('prod_receipts'), prod_issues: count('prod_issues')
  };
  const realDocs = probe.prepare('select id, kind, doc_no, doc_date, created_at from documents order by id desc limit 5').all();
  probe.close();
  log('BOOT ' + new Date().toISOString());
  log('customer data: ' + JSON.stringify(realCounts));

  check('the customer data came through', realCounts.items > 0 && realCounts.documents > 0, realCounts);
  check('the copy carries the production records too', realCounts.prod_receipts > 0 || realCounts.prod_issues > 0, realCounts);

  /* ---- the password the customer gave ---- */
  if (!PASSWORD) {
    log('NO PASSWORD — set SAM_REAL_PASSWORD to the admin password of the copy');
    try { dbMod.close(); } catch (e) {}
    app.exit(2);
    return;
  }
  let logged = null;
  try { logged = session.login('admin', PASSWORD); } catch (e) { log('LOGIN FAILED: ' + e.message); }
  check('the customer password opens the admin account', !!(logged && logged.role === 'admin'),
    logged ? logged.username + '/' + logged.role : 'rejected');
  let oldRejected = false;
  try { session.login('admin', 'admin123'); } catch (e) { oldRejected = true; }
  check('the old default password no longer works', oldRejected, oldRejected);

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
  const shot = async (name, settle = 800) => {
    await sleep(settle);
    try { await win.webContents.capturePage(); } catch (e) {}
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    log('shot -> ' + name);
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','${PASSWORD}')`);
  await sleep(3000);
  await shot('01-dashboard-real');

  /* ================= 1. the dashboard shows THEIR numbers ================= */
  const kpis = await js(`(() => {
    const t = [...document.querySelectorAll('.kpi')].map((k) => {
      const v = k.querySelector('.kpi-val') || k.querySelector('.kpi-v') || k;
      const t2 = k.querySelector('.kpi-txt') || k.querySelector('.kpi-lbl') || k;
      return { v: (v.textContent || '').trim().slice(0, 40), t: (t2.textContent || '').trim().slice(0, 40) };
    });
    return { count: t.length, tiles: t, overflow: document.documentElement.scrollWidth > window.innerWidth + 2 };
  })()`);
  check('the dashboard shows four KPI tiles', kpis.count === 4, kpis);
  check('the dashboard does not scroll sideways', !kpis.overflow, kpis.overflow);

  /* ================= 2. the items screen shows THEIR items ================= */
  await js(`document.querySelector('.nav-item[data-view=items]').click(); 1`);
  await sleep(1200);
  await shot('02-items-real');
  const itemsUi = await js(`(() => {
    const rows = [...document.querySelectorAll('#v-items tbody tr')];
    const cells = rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim()));
    return { rows: rows.length, first: cells[0] || null, overflow: document.documentElement.scrollWidth > window.innerWidth + 2 };
  })()`);
  check('the items screen lists the customer items', itemsUi.rows >= realCounts.items, { ui: itemsUi.rows, db: realCounts.items });
  check('the items screen does not scroll sideways', !itemsUi.overflow, itemsUi.overflow);

  /* the item form on their data — every box the same size */
  await js(`SamItems.openForm(null); 1`);
  await sleep(1000);
  await shot('03-item-form-real');
  const formGeom = await js(`(() => {
    const modal = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!modal) return { error: 'no modal' };
    const boxes = [...modal.querySelectorAll('.form-grid-4 .field .input')].map((i) => {
      const r = i.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    const bal = [...modal.querySelectorAll('.bal-grid .bal-in')].map((i) => {
      const r = i.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      boxes: boxes.length,
      widths: [...new Set(boxes.map((b) => b.w))],
      heights: [...new Set(boxes.map((b) => b.h))],
      balWidths: [...new Set(bal.map((b) => b.w))],
      balHeights: [...new Set(bal.map((b) => b.h))]
    };
  })()`);
  check('the item form keeps equal boxes on real data',
    formGeom.widths && formGeom.widths.length === 1 && formGeom.heights && formGeom.heights.length === 1, formGeom);
  check('the balance boxes keep one size on real data',
    formGeom.balWidths && formGeom.balWidths.length === 1 && formGeom.balHeights && formGeom.balHeights.length === 1, formGeom);
  await js(`(() => { const b = [...document.querySelectorAll('.overlay .modal .modal-foot .btn')].reverse().find(x => /إلغاء|إغلاق/.test(x.textContent)); if (b) b.click(); return 1; })()`);
  await sleep(500);

  /* ================= 3. the documents screen shows THEIR documents ================= */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click(); 1`);
  await sleep(1400);
  await shot('04-documents-real');
  const docsUi = await js(`(() => {
    const rows = [...document.querySelectorAll('#docsTbl tbody tr')];
    const text = rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
    return { rows: rows.length, sample: text.slice(0, 3), overflow: document.documentElement.scrollWidth > window.innerWidth + 2 };
  })()`);
  check('the documents screen lists the customer documents', docsUi.rows >= realCounts.documents,
    { ui: docsUi.rows, db: realCounts.documents, sample: docsUi.sample });

  /* ================= 4. an edit of THEIR document carries today ================= */
  const target = realDocs[0];
  await js(`SamDocs.openEditor(${JSON.stringify(target.id)}); 1`);
  await sleep(1300);
  await shot('05-editor-real');
  const editDates = await js(`(() => {
    const inp = document.querySelector('.modal.editor input[type=date]');
    const hint = document.querySelector('.modal.editor .hint-txt');
    return { value: inp ? inp.value : null, today: SamUI.today(), hint: hint ? hint.textContent : null };
  })()`);
  check('editing a customer document shows today', editDates.value === editDates.today, editDates);
  check('the original creation date stays visible', /تاريخ الإنشاء الأصلي/.test(editDates.hint || ''), editDates.hint);

  const before = dbMod.getDocument(target.id);
  await js(`(() => {
    const ta = document.querySelector('.modal.editor textarea');
    if (ta) { ta.value = 'ملاحظة بعد التعديل'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    return 1;
  })()`);
  await sleep(250);
  await js(`(() => {
    const b = [...document.querySelectorAll('.modal.editor .modal-foot .btn')].find(x => /حفظ التعديلات/.test(x.textContent));
    if (b) b.click();
    return 1;
  })()`);
  await sleep(1500);
  const after = dbMod.getDocument(target.id);
  check('the edited document carries the edit date', after.doc_date === editDates.today,
    { doc_date: after.doc_date, today: editDates.today });
  check('the creation time never changes', after.created_at === before.created_at,
    { before: before.created_at, now: after.created_at });
  check('the edit was stored', after.notes === 'ملاحظة بعد التعديل', after.notes);

  /* ================= 5. their document prints on real paper ================= */
  await js(`SamDocs.printPermits(${JSON.stringify(target.id)}); 1`);
  await sleep(1400);
  await shot('06-permit-real');
  const pv = await js(`(() => {
    const ov = document.querySelector('.pv');
    if (!ov) return { error: 'no preview' };
    return {
      pages: ov.querySelectorAll('.print-page').length,
      halves: ov.querySelectorAll('.sheet.half').length,
      cap: ov.querySelector('.pv-cap') ? ov.querySelector('.pv-cap').textContent.trim() : null
    };
  })()`);
  check('the permit preview opens on their document', pv.pages >= 1, pv);
  const permitPdf = await (async () => {
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
    fs.writeFileSync(path.join(OUT, 'permit-real.pdf'), data);
    return pdfBoxes(data);
  })();
  log('   permit PDF boxes: ' + JSON.stringify(permitPdf));
  check('the permit of a customer document prints on A4', permitPdf.length >= 1
    && Math.abs(permitPdf[0][0] - 595) <= 3 && Math.abs(permitPdf[0][1] - 842) <= 3, permitPdf);
  await js(`(() => { const pv = document.querySelector('.pv'); if (pv) pv.querySelector('.pv-bar .btn-ghost:last-of-type').click(); return 1; })()`);
  await sleep(500);

  /* ================= 6. the production screen shows THEIR production ================= */
  await js(`document.querySelector('.nav-item[data-view=production]').click(); 1`);
  await sleep(1300);
  await shot('07-production-real');
  const prodUi = await js(`(() => ({
    tables: document.querySelectorAll('#v-production table').length,
    rows: document.querySelectorAll('#v-production tbody tr').length,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 2
  }))()`);
  check('the production screen renders their records', prodUi.tables >= 1, prodUi);
  check('the production screen does not scroll sideways', !prodUi.overflow, prodUi.overflow);

  /* ================= 7. the report centre prints their rows on one A4 ================= */
  await js(`document.querySelector('.nav-item[data-view=reports]').click(); 1`);
  await sleep(1400);
  await shot('08-reports-real');
  const reportUi = await js(`(() => ({
    cards: document.querySelectorAll('#v-reports .rpt-card').length,
    hasCombo: !!document.querySelector('#v-reports select')
  }))()`);
  check('the report centre shows its catalogue', reportUi.cards > 0, reportUi);

  /* run the report window over their data and print it */
  const reportRun = await js(`(async () => {
    try {
      await SamReports.run();
      await new Promise((r) => setTimeout(r, 2200));
      const win = document.querySelector('.rw-window');
      const rows = document.querySelectorAll('.rw-window tbody tr').length;
      const rail = document.querySelectorAll('.rw-window .rw-rail .rw-item, .rw-window .rw-rail button').length;
      return { ok: !!win, rows, rail };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  log('   report run: ' + JSON.stringify(reportRun));
  check('the report window opens over the customer data', reportRun.ok, reportRun);
  check('the report shows its rows', reportRun.rows > 0, reportRun);
  await shot('09-report-window-real');

  /* the print preview of that report, measured from the produced PDF */
  await js(`(async () => {
    try {
      const btn = [...document.querySelectorAll('.rw-window .btn')].find((b) => /طباعة/.test(b.textContent));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 1400));
    } catch (e) { /* the preview opens below */ }
    return 1;
  })()`);
  await sleep(1400);
  await shot('09b-report-preview-real');
  const reportPdf = await (async () => {
    const src = await js(`(() => {
      const pv = document.querySelector('.pv .pv-pages');
      if (!pv) return 0;
      const host = document.getElementById('printHost');
      host.innerHTML = '';
      const clone = pv.cloneNode(true);
      clone.style.transform = '';
      host.appendChild(clone);
      document.body.classList.add('is-printing');
      return 1;
    })()`);
    if (!src) return [];
    await sleep(500);
    const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, marginType: 'none' });
    await js(`(() => { document.body.classList.remove('is-printing'); document.getElementById('printHost').innerHTML=''; return 1; })()`);
    fs.writeFileSync(path.join(OUT, 'report-real.pdf'), data);
    return pdfBoxes(data);
  })();
  log('   report PDF boxes: ' + JSON.stringify(reportPdf));
  check('the report of their data prints on A4 paper', reportPdf.length >= 1
    && Math.abs(reportPdf[0][0] - 595) <= 3, reportPdf);

  /* ================= 8. the pages stay flexible ================= */
  const widths = [1440, 1180, 940, 760];
  const flex = [];
  for (const w of widths) {
    win.setSize(w, 900);
    await sleep(900);
    const r = await js(`(() => {
      const doc = document.documentElement;
      const wide = [...document.querySelectorAll('.view')].filter((v) => v.offsetParent !== null)
        .map((v) => ({ id: v.id, sw: v.scrollWidth, cw: v.clientWidth }))
        .filter((v) => v.sw > v.cw + 2);
      return { w: window.innerWidth, pageOverflow: doc.scrollWidth > window.innerWidth + 2, wide };
    })()`);
    flex.push(r);
    await shot(`10-flex-${w}-real`, 400);
  }
  check('no page scrolls sideways at any width', flex.every((f) => !f.pageOverflow), flex);
  win.setSize(1440, 900);
  await sleep(700);

  /* ================= 9. the cloud sync on this machine ================= */
  await js(`document.querySelector('.nav-item[data-view=settings]').click(); 1`);
  await sleep(700);
  await js(`SamSettings.showTab('data'); 1`);
  await sleep(1600);
  await shot('11-settings-real');
  const live = cloudsync.detectClients();
  const g = live.find((c) => c.id === 'gdrive');
  const cloudUi = await js(`(() => {
    const note = document.getElementById('cloudNote');
    const input = document.getElementById('cloudEmail');
    return { text: note ? note.textContent.trim() : '', email: input ? input.value : '' };
  })()`);
  check('Google Drive is detected on this machine', !!g, live.map((c) => c.id));
  check('the cloud card shows where the copy lands', /SAM-Backups/.test(cloudUi.text), cloudUi.text);
  check('the customer address is filled in', /@/.test(cloudUi.email), cloudUi.email);

  /* ================= 10. no console errors at all ================= */
  check('no console errors on the customer data', errors.length === 0, errors.slice(0, 8));

  log(`\n=== V5 REAL: ${pass} passed, ${fail} failed ===`);
  await shutdown(fail ? 1 : 0);
}).catch((e) => { log('FAILED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
