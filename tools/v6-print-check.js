/**
 * tools/v6-print-check.js — end-to-end verification of V6-6:
 * EVERY screen in the program must be printable.
 *
 * It drives the REAL renderer (the same one the user sees):
 *   · the title bar carries a print button that prints the open screen
 *   · every data screen carries its own «طباعة الشاشة» button
 *   · the printer rebuilds the screen as a real A4 sheet (masthead,
 *     watermark, title, the numbers, the tables) — never a screenshot
 *   · a long list is split into pages that FIT the paper: nothing is cut
 *     off at the bottom, and the last page says «صفحة X من Y»
 *   · the preview shows the real paper, so what the user sees is what
 *     the printer delivers
 * Writes .tmp/v6print/*.png and prints PASS/FAIL for every check.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v6-print-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v6print');
const DATA = path.join(ROOT, '.tmp', 'v6printdata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
/* On this host the Electron console is not captured by the shell pipe, so
   every line is written to a log file as well. */
const LOG = path.join(ROOT, '.tmp', 'v6-print-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

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
  try { dbMod.close(); } catch (e) {}
  await rmRetry(DATA, { label: 'data dir' });
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
logLine('--- ipc modules loaded ---');

async function shot(name, settle = 700) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(`(() => {
      try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); } catch (e) {}
      return 1;
    })()`, true);
  } catch (e) { /* navigating */ }
  try { win.webContents.invalidate(); } catch (e) {}
  await sleep(200);
  try { await win.webContents.capturePage(); } catch (e) {}
  await sleep(160);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  logLine('shot -> ' + name);
}

app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  await rmRetry(OUT, { tries: 4 });
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* ---------------- seed ---------------- */
  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'الطرف الغربي' });
  const items = [];
  for (let i = 1; i <= 32; i++) {
    items.push(dbMod.addItem(
      { code: String(1000 + i), name: `صنف تجريبي ${i}`, base_unit: 'حبة', category: 'منتج', pieces_per_carton: 12 },
      [{ warehouseId: whA.id, good: 500 + i * 10 }, { warehouseId: whB.id, good: 200 + i * 5 }]
    ));
  }
  const parties = [];
  ['شركة الأمل التجارية', 'مؤسسة النور', 'ورشة الإخوة'].forEach((n, i) => {
    parties.push(dbMod.addParty({ name: n, type: i === 0 ? 'customer' : 'supplier', phone: '77' + i + '000000' }));
  });
  const kinds = ['purchase', 'sale', 'sale_return', 'purchase_return', 'transfer', 'prod_receipt', 'prod_issue', 'gate_in', 'gate_out', 'adjustment'];
  kinds.forEach((kind, i) => {
    try {
      dbMod.saveDocument({
        kind,
        doc_date: '2026-11-13',
        party_id: (kind === 'sale' || kind === 'purchase') ? parties[i % parties.length].id : null,
        warehouse_id: whA.id,
        dest_warehouse_id: kind === 'transfer' ? whB.id : null,
        invoice_value: kind === 'sale' || kind === 'purchase' ? 1000 + i * 100 : '',
        notes: 'مستند تجريبي للطباعة',
        lines: [{ item_id: items[i % items.length].id, warehouse_id: whA.id, bucket: 'good', pieces: 10 + i, cartons: 1, bags: 0 }]
      });
    } catch (e) { logLine('  seed ' + kind + ' failed: ' + e.message); }
  });
  /* the production board needs its own rows — the material issues live
     in their own table, not in the documents ledger */
  for (let i = 0; i < 4; i++) {
    try {
      dbMod.saveIssue({
        doc_date: '2026-11-13',
        item_id: items[i].id,
        warehouse_id: whA.id,
        cartons: 2,
        pieces: 120 + i * 10,
        note: 'صرف خام تجريبي'
      });
    } catch (e) { logLine('  seed issue failed: ' + e.message); }
  }

  /* ---------------- window ---------------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  const closePv = async () => {
    await js(`(() => {
      const pv = [...document.querySelectorAll('.pv')].pop();
      if (!pv) return 'none';
      const b = pv.querySelector('.pv-bar .btn-ghost:last-of-type');
      if (b) b.click();
      return 'closed';
    })()`);
    await sleep(450);
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  /* ================= 1. the buttons ================= */
  const tbBtn = await js(`(() => {
    const b = document.getElementById('btnPrintScreen');
    if (!b) return null;
    return { title: b.title, icon: !!b.querySelector('use[href="#i-print"]'), tone: [...b.classList].filter(x => x.startsWith('tone-'))[0] || null };
  })()`);
  check('the title bar carries a print button', !!tbBtn, tbBtn);
  check('the print button shows the print icon', tbBtn && tbBtn.icon === true, tbBtn);
  check('the print button carries a colour', tbBtn && !!tbBtn.tone, tbBtn);

  const screens = ['dashboard', 'items', 'warehouses', 'parties', 'transactions', 'production', 'settings'];
  const btnInfo = await js(`(() => {
    const out = {};
    ${JSON.stringify(screens)}.forEach(v => {
      const view = document.getElementById('v-' + v);
      const b = view ? view.querySelector('.view-actions .btn-print-screen') : null;
      out[v] = b ? b.innerText.trim() : null;
    });
    return out;
  })()`);
  screens.forEach((v) => check(`the «${v}» screen has a print button`, !!(btnInfo && btnInfo[v]), btnInfo && btnInfo[v]));

  /* ================= 2. every screen prints ================= */
  const titles = {
    dashboard: 'لوحة التحكم', items: 'الأصناف', warehouses: 'المخازن',
    parties: 'العملاء والموردين', transactions: 'العمليات', production: 'الإنتاج', settings: 'الإعدادات'
  };
  for (const v of screens) {
    await js(`document.querySelector('.nav-item[data-view=${JSON.stringify(v)}]').click()`);
    await sleep(1400);
    const res = await js(`(async () => {
      const view = document.getElementById('v-${v}');
      const b = view.querySelector('.view-actions .btn-print-screen');
      if (!b) return { clicked: false };
      b.click();
      await new Promise(r => setTimeout(r, 800));
      const pv = [...document.querySelectorAll('.pv')].pop();
      if (!pv) return { clicked: true, opened: false };
      const MM = 96 / 25.4;
      const pages = [...pv.querySelectorAll('.print-page')];
      const land = pages.some(p => p.classList.contains('land'));
      const paper = (land ? 210 : 297) * MM;
      const over = pages.map(p => [...p.querySelectorAll('.sheet')].reduce((a, s) => a + s.offsetHeight, 0))
        .map(h => Math.round(h - paper));
      const h1 = (pv.querySelector('.doc-title h1') || {}).textContent;
      const cap = (pv.querySelector('.doc-body .doc-note b') || {}).textContent;
      const wm = !!pv.querySelector('.sheet .wm span');
      const rows = pv.querySelectorAll('.sheet table.tbl tbody tr').length;
      const tables = pv.querySelectorAll('.sheet table.tbl').length;
      const warn = !!pv.querySelector('.pv-cap .over');
      const marks = [...pv.querySelectorAll('.pg-label')].map(n => n.dataset.pg);
      return { clicked: true, opened: true, pages: pages.length, land, over, h1, cap, wm, rows, tables, warn, marks, title: (pv.querySelector('.pv-note')||{}).textContent };
    })()`);
    check(`the «${v}» screen opens a print preview`, !!(res && res.opened), res);
    check(`the «${v}» sheet carries the screen title`, !!(res && res.h1 && res.h1.trim() === titles[v]), res && res.h1);
    check(`the «${v}» sheet carries the watermark`, !!(res && res.wm), res && res.wm);
    check(`the «${v}» sheet carries a real table`, !!(res && res.tables >= 1 && res.rows >= 1), res && { tables: res.tables, rows: res.rows });
    check(`the «${v}» sheet fits the paper`, !!(res && res.over.every((d) => d <= 2)), res && res.over);
    check(`the «${v}» preview warns about no overflow`, !!(res && res.warn === false), res && res.warn);
    if (v === 'dashboard') await shot('01-dashboard-print');
    if (v === 'items') await shot('02-items-print');
    if (v === 'settings') await shot('03-settings-print');
    await closePv();
  }

  /* ================= 3. a long list is split into pages ================= */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(1400);
  const split = await js(`(async () => {
    SamPrintScreen.print('items');
    await new Promise(r => setTimeout(r, 900));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return null;
    const pages = [...pv.querySelectorAll('.print-page')];
    const rowsPer = pages.map(p => p.querySelectorAll('.sheet table.tbl tbody tr').length);
    return {
      pages: pages.length,
      rowsPer,
      total: rowsPer.reduce((a, b) => a + b, 0),
      marks: [...pv.querySelectorAll('.pg-label')].map(n => n.dataset.pg),
      heads: pages.map(p => (p.querySelector('.sheet table.tbl thead th') || {}).textContent)
    };
  })()`);
  check('a long list is split into more than one page', !!(split && split.pages >= 2), split && split.pages);
  check('every row reaches the paper', !!(split && split.total === 32), split && split.total);
  check('the header repeats on every page', !!(split && new Set(split.heads).size === 1 && split.heads[0]), split && split.heads);
  check('the pages are numbered «صفحة X من Y»', !!(split && split.marks.length === split.pages && split.marks[0] === '1/' + split.pages), split && split.marks);
  check('no page holds more than 25 rows', !!(split && split.rowsPer.every((n) => n <= 25)), split && split.rowsPer);
  await shot('04-items-pages');
  await closePv();

  /* ================= 4. the title-bar printer ================= */
  await js(`document.querySelector('.nav-item[data-view=warehouses]').click()`);
  await sleep(1200);
  const tb = await js(`(async () => {
    document.getElementById('btnPrintScreen').click();
    await new Promise(r => setTimeout(r, 800));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return { opened: false };
    return { opened: true, h1: (pv.querySelector('.doc-title h1') || {}).textContent, rows: pv.querySelectorAll('.sheet table.tbl tbody tr').length };
  })()`);
  check('the title-bar button prints the open screen', !!(tb && tb.opened), tb);
  check('the title-bar print shows the open screen', !!(tb && tb.h1 && tb.h1.trim() === 'المخازن'), tb && tb.h1);
  check('the title-bar print carries the data', !!(tb && tb.rows >= 2), tb && tb.rows);
  await closePv();

  /* ================= 5. Ctrl+P prints the screen ================= */
  const ctrlP = await js(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return { opened: false };
    return { opened: true, h1: (pv.querySelector('.doc-title h1') || {}).textContent };
  })()`);
  check('Ctrl+P prints the open screen', !!(ctrlP && ctrlP.opened), ctrlP);
  check('Ctrl+P prints the screen that is open', !!(ctrlP && ctrlP.h1 && ctrlP.h1.trim() === 'المخازن'), ctrlP && ctrlP.h1);
  await closePv();

  /* ================= 6. the PDF button is there ================= */
  const pdf = await js(`(async () => {
    SamPrintScreen.print('items');
    await new Promise(r => setTimeout(r, 700));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return null;
    const labels = [...pv.querySelectorAll('.pv-bar .btn')].map(b => b.innerText.trim());
    const hasPrint = labels.some(t => t.includes('طباعة'));
    const hasPdf = labels.some(t => t.includes('PDF'));
    const hasZoom = !!pv.querySelector('.pv-zoom');
    return { labels, hasPrint, hasPdf, hasZoom };
  })()`);
  check('the preview offers printing', !!(pdf && pdf.hasPrint), pdf && pdf.labels);
  check('the preview offers saving a PDF', !!(pdf && pdf.hasPdf), pdf && pdf.labels);
  check('the preview offers zooming', !!(pdf && pdf.hasZoom), pdf && pdf.hasZoom);
  await closePv();

  logLine(`\n${pass} passed, ${fail} failed`);
  if (errors.length) logLine('CONSOLE ERRORS:\n' + errors.join('\n'));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
