/**
 * tools/shot.js — visual smoke test for phases 1-2.
 * Boots the app in a hidden window, drives the UI, writes PNGs to .tmp/shots.
 *
 * Windows keeps an exclusive lock on an open SQLite file, so this harness:
 *   1. closes every database connection before touching the data folder,
 *   2. retries removals with exponential backoff (100, 200, 400, 800 … ms),
 *   3. logs a warning instead of crashing when a lock survives all retries,
 *   4. cleans its temp folder on exit — always after the connection is closed.
 *
 * Usage: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tools/shot.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots');
const DATA = path.join(ROOT, '.tmp', 'data');

const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));

/* ---------------- locked-file-safe removal ---------------- */
async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return true;
    } catch (e) {
      if (attempt === tries) {
        console.warn(`WARN: ${label} still present after ${tries} attempts (${e.code}): ${e.message}`);
        return false;
      }
      const wait = base * 2 ** (attempt - 1);
      console.log(`   ${label} busy (${e.code}) — retry ${attempt}/${tries} in ${wait}ms`);
      await sleep(wait);
    }
  }
  return false;
}

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (!cleanedUp) {
    cleanedUp = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* ignore */ }
    dbMod.close();                                  // release sam.db first
    await rmRetry(DATA, { label: 'temp data dir' });
  }
  app.exit(code);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
app.on('will-quit', (e) => {
  if (cleanedUp) return;
  e.preventDefault();
  shutdown(errors.length ? 1 : 0);
});

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 750) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log('shot ->', name);
}

app.whenReady().then(async () => {
  /* a previous run may still hold the file: close, then retry-clean, then open */
  dbMod.close();
  await rmRetry(DATA, { label: 'temp data dir' });
  await rmRetry(OUT, { tries: 4, label: 'screenshots dir' });
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#0b1433',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) errors.push(`[console] ${d.source || ''}:${d.lineNumber || ''} ${d.message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => errors.push(`[load] ${code} ${desc} ${url}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`[gone] ${JSON.stringify(d)}`));

  const js = (code) => win.webContents.executeJavaScript(code, true);

  /* ---------- login ---------- */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(1200);
  await shot('p1-login-intro');
  await shot('p1-login-form', 600);
  await js(`document.getElementById('username').value='admin';
            document.getElementById('password').value='admin123';
            document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
  await sleep(1800);
  if (!win.webContents.getURL().includes('app.html')) await win.loadFile(path.join(RENDERER, 'app.html'));
  await shot('p2-01-dashboard-empty');

  /* ---------- warehouses: add a sub warehouse ---------- */
  await js(`document.querySelector('.nav-item[data-view=warehouses]').click()`);
  await sleep(400);
  await js(`window.SamWarehouses.openForm(null); 1`);
  await sleep(400);
  await js(`(() => {
      const m = document.querySelector('.modal');
      m.querySelectorAll('input.input')[0].value = 'S02';
      m.querySelectorAll('input.input')[1].value = 'مخزن الإنتاج';
      m.querySelector('.modal-foot .btn-primary').click();
    })()`);
  await sleep(600);
  await js(`window.SamWarehouses.openForm(null); 1`);
  await sleep(300);
  await js(`(() => {
      const m = document.querySelector('.modal');
      m.querySelectorAll('input.input')[0].value = 'S03';
      m.querySelectorAll('input.input')[1].value = 'مخزن المرتجعات';
      m.querySelector('.modal-foot .btn-primary').click();
    })()`);
  await shot('p2-02-warehouses');

  /* ---------- items: add two items with opening balances ---------- */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(400);

  async function addItem(code, name, ctn, bag, minG, maxD, mainGood, mainDefect, mainHeld, subGood) {
    await js(`window.SamItems.openForm(null); 1`);
    await sleep(350);
    await js(`(() => {
      const m = document.querySelector('.modal');
      const ins = [...m.querySelectorAll('.form-grid input.input')];
      ins[0].value = ${JSON.stringify(code)};
      ins[1].value = ${JSON.stringify(name)};
      ins[2].value = 'حبة';
      ins[3].value = ${JSON.stringify('خام')};
      ins[4].value = ${ctn};
      ins[5].value = ${bag};
      ins[6].value = ${minG};
      ins[7].value = ${maxD};
      const bal = [...m.querySelectorAll('.bal-in')];
      bal[0].value = ${mainGood};   // main good
      bal[1].value = ${mainDefect}; // main defect
      bal[2].value = ${mainHeld};   // main held
      bal[3].value = ${subGood};    // first sub good
      m.querySelector('.modal-foot .btn-primary').click();
      return bal.length;
    })()`);
    await sleep(500);
  }

  await addItem('0001', 'مياه جلدلة 1.5 لتر', 12, 0, 500, 100, 24000, 120, 40, 3600);
  await addItem('0002', 'أمبولة ماء معقّم 200 مل', 40, 240, 1000, 50, 800, 900, 0, 0);
  await shot('p2-03-items');

  /* ---------- dashboard reflects the database ---------- */
  await js(`document.querySelector('.nav-item[data-view=dashboard]').click()`);
  await shot('p2-04-dashboard-live');

  /* ---------- parties ---------- */
  await js(`document.querySelector('.nav-item[data-view=parties]').click()`);
  await sleep(400);
  await js(`window.SamParties.openForm(null); 1`);
  await sleep(400);
  await js(`(() => {
      const m = document.querySelector('.modal');
      m.querySelectorAll('input.input')[0].value = 'موزع الرياض';
      m.querySelectorAll('input.input')[1].value = '0555123456';
      m.querySelector('.modal-foot .btn-primary').click();
    })()`);
  await sleep(500);
  await js(`window.SamParties.openForm(null); 1`);
  await sleep(400);
  await js(`(() => {
      const m = document.querySelector('.modal');
      m.querySelectorAll('input.input')[0].value = 'شركة البلاستيك المتحدة';
      m.querySelectorAll('input.input')[1].value = '0112233445';
      [...m.querySelectorAll('input[type=radio]')][1].checked = true;
      m.querySelector('.modal-foot .btn-primary').click();
    })()`);
  await shot('p2-05-parties');

  /* ---------- smart searchable dropdown ---------- */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(400);
  await js(`document.getElementById('btnSmartSearch').click()`);
  await sleep(500);
  await js(`(() => {
      const inp = document.querySelector('.combo-input');
      inp.focus();
      return 'focused';
    })()`);
  await sleep(300);
  await js(`(() => {
      const inp = document.querySelectorAll('.combo-input')[0];
      inp.value = 'امبو';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  await shot('p2-06-combo-arabic-filter');
  const picked = await js(`(() => { const o = document.querySelector('.combo-pop .combo-opt'); if (!o) return 'NO OPTIONS'; o.click(); return o.textContent.trim(); })()`);
  console.log('combo matched when typing "امبو":', picked);
  await sleep(300);
  await js(`(() => {
      const inp = document.querySelectorAll('.combo-input')[1];
      inp.focus();
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  await sleep(300);
  await js(`(() => { const o = document.querySelectorAll('.combo-pop .combo-opt')[1]; o.click(); return o.textContent; })()`);
  await shot('p2-07-combo-result');
  await js(`document.querySelector('.overlay .modal-foot .btn').click()`);

  /* ---------- hard delete a stock move ---------- */
  await js(`document.querySelector('.nav-item[data-view=dashboard]').click()`);
  await sleep(600);
  await js(`(() => { const tr = document.querySelector('#movesTbl tbody tr:last-child'); const r = tr.getBoundingClientRect(); tr.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+200,clientY:r.bottom-4})); })()`);
  await sleep(400);
  await js(`document.querySelector('.ctx-item.danger').click()`);
  await shot('p2-08-hard-delete-move');
  await js(`document.querySelector('.modal-foot .btn-danger').click()`);
  await sleep(700);
  await shot('p2-09-after-delete');

  /* ---------- settings ---------- */
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await shot('p2-10-settings');

  const info = await js(`({
    items: document.querySelectorAll('#itemsTbl tbody tr').length,
    wh: document.querySelectorAll('#whTbl tbody tr').length,
    parties: document.querySelectorAll('#partiesTbl tbody tr').length,
    moves: document.querySelectorAll('#movesTbl tbody tr').length,
    kpiItems: document.getElementById('kpiItems').textContent,
    kpiStock: document.getElementById('kpiStock').textContent,
    kpiAlerts: document.getElementById('kpiAlerts').textContent,
    alertsRows: document.querySelectorAll('#alertsTbl tbody tr').length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth
  })`);
  console.log('state:', JSON.stringify(info, null, 2));

  console.log('db summary:', JSON.stringify(dbMod.summary()));

  const code = errors.length ? 1 : 0;
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(code);   // closes the db, then removes the temp folder
});
