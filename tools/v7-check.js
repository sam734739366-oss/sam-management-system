/**
 * tools/v7-check.js — verification of the V7 work:
 *   · the update check ALWAYS ends in a final state (it never searches for ever)
 *   · the progress bar stops: no stripes outside a real download, no stale
 *     percentage, and an error leaves the bar at zero
 *   · the data can be restored from a file: the file is checked, the current
 *     data is copied away first, and the file really replaces the live database
 * It drives the REAL main process and the REAL renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7data');
const CUSTOMER = path.join(ROOT, '.tmp', 'v7customer');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const restore = require(path.join(ROOT, 'src', 'main', 'restore.js'));
const updater = require(path.join(ROOT, 'src', 'main', 'updater.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const errors = [];

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) {
      if (attempt === tries) { logLine(`WARN: ${label} still locked (${e.code})`); return false; }
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
  await rmRetry(CUSTOMER, { label: 'customer dir' });
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');

/* ================= part 1 — the updater, on its own ================= */

/** the published tag, read the same way the app reads it */
function liveTag() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/sam734739366-oss/sam-management-system/releases/latest',
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SAM-Management-System' }
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d).tag_name); } catch (e) { reject(new Error('bad json')); }
      });
    });
    req.setTimeout(12000, () => req.destroy());
    req.on('error', reject);
    req.end();
  });
}

async function updaterTests() {
  /* ---- the version comparison ---- */
  check('cmp: 0.5.0 is newer than 0.4.0', updater.cmpVersions('0.5.0', '0.4.0') === 1);
  check('cmp: the same version is equal', updater.cmpVersions('0.5.0', '0.5.0') === 0);
  check('cmp: 0.4.0 is older than 0.5.0', updater.cmpVersions('0.4.0', '0.5.0') === -1);
  check('cmp: the v prefix is ignored', updater.cmpVersions('v0.5.0', '0.5.0') === 0);
  check('cmp: two digits are compared as numbers', updater.cmpVersions('0.10.0', '0.9.0') === 1);
  check('cmp: a missing part counts as zero', updater.cmpVersions('0.5', '0.5.0') === 0);

  /* ---- a promise that never settles must not hang the check ---- */
  const started = Date.now();
  let timedOut = null;
  try {
    await updater.withTimeout(new Promise(() => { }), 700, 'انتهت مهلة الفحص عن التحديث');
  } catch (e) {
    timedOut = e;
  }
  const waited = Date.now() - started;
  check('the deadline rejects a promise that never settles', !!timedOut, timedOut && timedOut.message);
  check('the deadline waits no longer than it promised', waited < 2500, waited);
  check('the deadline says the wait is over', timedOut && timedOut.code === 'ETIMEDOUT', timedOut && timedOut.code);

  /* ---- an address that answers nothing ---- */
  let blackhole = null;
  try {
    await updater.withTimeout(updater.fetchJson('https://10.255.255.1/nothing'), 2500, 'انتهت مهلة الفحص عن التحديث');
  } catch (e) {
    blackhole = e;
  }
  check('a silent address ends with an error, not with a hang', !!blackhole, blackhole && blackhole.message);

  /* ---- a host that does not exist ---- */
  let noHost = null;
  try {
    await updater.fetchJson('https://no-such-host-sam-9f2a1b.test/x');
  } catch (e) {
    noHost = e;
  }
  check('a missing host ends with an Arabic sentence', !!noHost && /GitHub|الإنترنت/.test(noHost.message), noHost && noHost.message);

  /* ---- the real feed ---- */
  let tag = null;
  try { tag = await liveTag(); } catch (e) { logLine('  (the published tag could not be read: ' + e.message + ')'); }
  logLine('  the published tag is: ' + tag);

  let json = null;
  const t0 = Date.now();
  try {
    json = await updater.fetchJson('https://github.com/sam734739366-oss/sam-management-system/releases/latest');
  } catch (e) { logLine('  fetchJson failed: ' + e.message); }
  const fetchMs = Date.now() - t0;
  check('the releases/latest answers with JSON', !!json && !!json.tag_name, json && json.tag_name);
  check('the answer comes quickly', fetchMs < 20000, fetchMs);
  if (tag && json && json.tag_name) {
    check('the answer is the published tag', json.tag_name === tag, { api: tag, app: json.tag_name });
  }

  /* ---- the check itself ---- */
  const c0 = Date.now();
  const st = await updater.check();
  const checkMs = Date.now() - c0;
  check('the check ends in a final state', ['available', 'up-to-date', 'error'].includes(st.status), st.status);
  check('the check never stays «checking»', st.status !== 'checking', st.status);
  check('the check finishes inside the deadline', checkMs < 25000, checkMs);
  check('the check names the published version', !!(st.latest && /^\d+\.\d+\.\d+$/.test(st.latest)), st.latest);
  check('the check names the running version', !!st.current, st.current);
  if (tag && st.latest) {
    const wanted = String(tag).replace(/^v/i, '');
    check('the published version is the one that was asked for', st.latest === wanted, { wanted, got: st.latest });
  }
  logLine('  the check said: ' + st.status + ' — ' + st.message);

  /* ---- a feed that does not exist: the bar must stop with an error ---- */
  const cfgPath = require.resolve(path.join(ROOT, 'updater.config.json'));
  const realCfg = require.cache[cfgPath];
  require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: { provider: 'github', owner: 'sam734739366-oss', repo: 'sam-repo-that-does-not-exist-7a91', channel: 'latest' }
  };
  const bad = await updater.check();
  check('a missing release ends with an error', bad.status === 'error', bad.status);
  check('the error carries a readable sentence', !!bad.message && bad.message.length > 10, bad.message);
  check('the error leaves the bar at zero', bad.percent === 0, bad.percent);
  if (realCfg) require.cache[cfgPath] = realCfg; else delete require.cache[cfgPath];

  /* ---- the check is not run twice at the same time ---- */
  const [a, b] = await Promise.all([updater.check(), updater.check()]);
  check('two checks at once both end in a final state', ['available', 'up-to-date', 'error'].includes(a.status) && ['available', 'up-to-date', 'error'].includes(b.status), { a: a.status, b: b.status });
}

/* ================= part 2 — the renderer ================= */

async function rendererTests() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    logLine('   stack: ' + (e && e.stack ? String(e.stack).slice(0, 400) : 'none'));
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);
  /* a recorder for every error the page throws — with its place */
  await js(`window.__errs = [];
    window.addEventListener('error', (e) => {
      window.__errs.push({ msg: String(e.message), src: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 500) : null });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__errs.push({ msg: 'rejection: ' + String(e.reason && e.reason.message ? e.reason.message : e.reason), src: 'promise', line: 0, col: 0, stack: e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 500) : null });
    });
    1`);

  /* ---- the update screen ---- */
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(1000);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=update]').click()`);
  await sleep(900);

  const screen = await js(`(() => ({
    badge: (document.getElementById('updStateBadge')||{}).textContent,
    label: (document.getElementById('updLabel')||{}).textContent,
    percent: (document.getElementById('updPercent')||{}).textContent,
    fill: (document.getElementById('updFill')||{}).style ? document.getElementById('updFill').style.width : null,
    wrapClass: (document.getElementById('updBarWrap')||{}).className,
    info: (document.getElementById('updInfo')||{}).innerText,
    visible: !document.getElementById('set-update').classList.contains('hidden')
  }))()`);
  check('the update screen opens', screen.visible === true, screen);
  check('the screen shows the published version', /0\.5\.0/.test(screen.info || ''), screen.info);
  const APP_VERSION = require(path.join(ROOT, 'package.json')).version;
  check('the screen shows the running version', new RegExp('v' + APP_VERSION.replace(/\./g, '\\.')).test(screen.info || ''), screen.info);
  check('the bar is at zero before any check', screen.percent === '0.0%', screen.percent);
  check('the bar carries no moving state before any check', !/busy|checking/.test(screen.wrapClass || ''), screen.wrapClass);

  /* ---- the check button reaches a final state ---- */
  await js(`document.getElementById('btnCheckUpdate').click()`);
  let final = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const s = await js(`sam.update.state()`);
    const st = (s && s.ok) ? s.data : (s || {});
    if (st.status && st.status !== 'checking') { final = st; break; }
  }
  check('the check from the button ends in a final state', !!final && ['available', 'up-to-date', 'error'].includes(final.status), final && final.status);
  check('the check from the button names the published version', !!final && final.latest === '0.5.0', final && final.latest);
  await sleep(600);
  /* the read is guarded: a page hiccup must not throw the whole battery away */
  const READ = `(() => {
    try {
      const g = (id) => document.getElementById(id);
      const badge = g('updStateBadge'), label = g('updLabel'), percent = g('updPercent'), fill = g('updFill'), wrap = g('updBarWrap');
      return {
        badge: badge ? badge.textContent : null,
        label: label ? label.textContent : null,
        percent: percent ? percent.textContent : null,
        fill: fill ? fill.style.width : null,
        wrapClass: wrap ? wrap.className : null,
        ERROR: null
      };
    } catch (e) {
      return { badge: null, label: null, percent: null, fill: null, wrapClass: null, ERROR: String(e && e.message) };
    }
  })()`;
  const after = (await js(READ)) || {};
  if (after.ERROR) logLine('  (the read reported: ' + after.ERROR + ')');
  logLine('  the errors the page recorded: ' + JSON.stringify(await js(`window.__errs || []`)));
  check('the bar stopped searching', !/checking/.test(after.wrapClass || ''), after.wrapClass);
  check('the bar is not running', !/busy/.test(after.wrapClass || ''), after.wrapClass);
  check('the bar is back to zero', after.percent === '0.0%' && after.fill === '0%', after);
  check('the screen says something about the version', /\d+\.\d+\.\d+/.test(after.label || ''), after.label);

  /* ---- an error stops the bar as well ---- */
  const cfgPath = require.resolve(path.join(ROOT, 'updater.config.json'));
  const realCfg = require.cache[cfgPath];
  require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: { provider: 'github', owner: 'sam734739366-oss', repo: 'sam-repo-that-does-not-exist-7a91', channel: 'latest' }
  };
  await updater.check();                 /* the state is pushed to the window */
  if (realCfg) require.cache[cfgPath] = realCfg; else delete require.cache[cfgPath];
  await sleep(800);
  const errScreen = (await js(READ)) || {};
  check('the error is written on the screen', /خطأ/.test(errScreen.badge || ''), errScreen.badge);
  check('the error stops the bar', !/busy|checking/.test(errScreen.wrapClass || ''), errScreen.wrapClass);
  check('the error leaves the bar at zero', errScreen.percent === '0.0%' && errScreen.fill === '0%', errScreen);

  /* ---- the preview of the bar ---- */
  await js(`document.getElementById('btnSimulateUpdate').click()`);
  await sleep(5200);
  const sim = (await js(READ)) || {};
  check('the preview ends at a hundred', sim.percent === '100.0%', sim);
  check('the preview marks the bar as done', /done/.test(sim.wrapClass || ''), sim.wrapClass);
  check('the preview stops the running state', !/busy|checking/.test(sim.wrapClass || ''), sim.wrapClass);

  /* ---- the stripes only move while the file comes down ---- */
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'css', 'app.css'), 'utf8');
  const stripeRules = css.split('\n').filter((l) => l.includes('animation: stripes'));
  check('the stripes are bound to the running state only',
    stripeRules.length === 1 && /\.upd-bar-wrap\.busy/.test(css.split('\n').find((l) => l.includes('animation: stripes')) || ''),
    stripeRules);
  check('no other rule makes the stripes move',
    !/upd-fill::after\s*\{[^}]*animation/.test(css.replace(/\n/g, ' ').replace(/\s+/g, ' ')) ||
    /\.upd-bar-wrap\.busy \.upd-fill::after/.test(css),
    'see the css');

  /* ---- the restore icon and the buttons ---- */
  const restoreUi = (await js(`(() => ({
    symbol: !!document.getElementById('i-restore'),
    used: !!document.querySelector('use[href="#i-restore"]'),
    fileBtn: !!document.getElementById('btnRestoreFile'),
    dirBtn: !!document.getElementById('btnRestoreDataDir'),
    veil: !!document.getElementById('dropRestore'),
    api: !!(window.SamRestore && window.SamRestore.pick && window.SamRestore.fromPath),
    backRestoreCol: !!document.querySelector('#backupsTbl thead th:nth-child(4)'),
    titleBtn: !!document.getElementById('btnRestoreData'),
    titleIcon: !!document.querySelector('#btnRestoreData use[href="#i-restore"]')
  }))()`)) || {};
  check('the restore icon exists in the sprite', restoreUi.symbol === true && restoreUi.used === true, restoreUi);
  check('there is a «restore from a file» button', restoreUi.fileBtn === true, restoreUi);
  check('there is a «restore the data folder» button', restoreUi.dirBtn === true, restoreUi);
  check('there is a drop overlay', restoreUi.veil === true, restoreUi);
  check('the restore functions are loaded', restoreUi.api === true, restoreUi);
  check('there is a restore icon in the title bar', restoreUi.titleBtn === true && restoreUi.titleIcon === true, restoreUi);

  /* the drop overlay opens when a file is dragged over the window */
  const veilOn = await js(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.db', { type: 'application/octet-stream' }));
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return document.getElementById('dropRestore').classList.contains('on');
  })()`);
  check('the overlay shows when a file is dragged over', veilOn === true, veilOn);
  const veilOff = await js(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.db', { type: 'application/octet-stream' }));
    window.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return document.getElementById('dropRestore').classList.contains('on');
  })()`);
  check('the overlay hides when the file leaves', veilOff === false, veilOff);

  /* the whole road from the window to the file on disk */
  const bridge = (await js(`sam.restore.describe(${JSON.stringify(dbMod.dbFile())})`)) || {};
  check('the window can ask about a data file', bridge.ok === true && !!(bridge.data && bridge.data.name === 'sam.db'), bridge);
  const bridgeBad = (await js(`sam.restore.describe('${path.join(ROOT, '.tmp', 'no-such-file.db').replace(/\\/g, '\\\\')}')`)) || {};
  check('the window refuses a file that is not there', bridgeBad.ok === false && /غير موجود/.test(bridgeBad.error || ''), bridgeBad);

  /* ---- the settings screens that hold the restore ---- */
  await js(`document.querySelector('#settingsTabs .tab[data-tab=backup]').click()`);
  await sleep(900);
  const backupTab = (await js(`(() => ({
    fileBtn: !!document.getElementById('btnRestoreFile'),
    head: [...document.querySelectorAll('#backupsTbl thead th')].map(n => n.textContent.trim()),
    rows: document.querySelectorAll('#backupsTbl tbody tr').length
  }))()`)) || {};
  check('the backups screen has the restore button', backupTab.fileBtn === true, backupTab);
  check('the backups table has a column for the restore', backupTab.head.length >= 4, backupTab.head);
}

/* ================= part 3 — the restore itself ================= */

async function restoreTests() {
  /* ---- a file that is not a database ---- */
  const junk = path.join(ROOT, '.tmp', 'v7-junk.txt');
  fs.writeFileSync(junk, 'this is not a database');
  check('a text file is not a database', restore.isSqlite(junk) === false);
  let junkErr = null;
  try { restore.describe(junk); } catch (e) { junkErr = e; }
  check('a text file is refused with an Arabic sentence', !!junkErr && /ملف|بيانات/.test(junkErr.message), junkErr && junkErr.message);

  /* ---- a file that does not exist ---- */
  let goneErr = null;
  try { restore.describe(path.join(ROOT, '.tmp', 'no-such-file.db')); } catch (e) { goneErr = e; }
  check('a missing file is refused with an Arabic sentence', !!goneErr && /غير موجود/.test(goneErr.message), goneErr && goneErr.message);

  /* ---- the live database: it must hold at least one item ---- */
  if (dbMod.listItems('').length === 0) {
    const lw = dbMod.addWarehouse({ code: 'L01', name: 'مخزن الاختبار', location: 'صنعاء' });
    dbMod.addItem({ code: 'L-001', name: 'صنف الاختبار', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
      [{ warehouseId: lw.id, good: 5 }]);
  }
  check('the live database is a database', restore.isSqlite(dbMod.dbFile()) === true);
  const live = restore.describe(dbMod.dbFile());
  check('the live database can be described', live.ok === true, live);
  check('the description carries the number of items', live.items >= 1, live.items);
  check('the description carries the tables', live.tables >= 5, live.tables);

  /* ---- a folder that holds the database ---- */
  const folder = restore.describe(DATA);
  check('a folder that holds the database is understood', folder.ok === true && folder.name === 'sam.db', folder);

  /* ---- the customer's file: a database of their own, built here ---- */
  fs.mkdirSync(CUSTOMER, { recursive: true });
  dbMod.close();
  dbMod.init(CUSTOMER);
  const cw = dbMod.addWarehouse({ code: 'C01', name: 'مخزن العميل', location: 'صنعاء' });
  dbMod.addItem({ code: 'C-100', name: 'صنف العميل الأول', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: cw.id, good: 111 }]);
  dbMod.addItem({ code: 'C-200', name: 'صنف العميل الثاني', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: cw.id, good: 222 }]);
  dbMod.close();
  const customerFile = path.join(ROOT, '.tmp', 'v7-customer.db');
  fs.copyFileSync(path.join(CUSTOMER, 'sam.db'), customerFile);
  check('the customer file is a database', restore.isSqlite(customerFile) === true);

  const described = restore.describe(customerFile);
  check('the customer file can be described', described.ok === true, described);
  check('the customer file holds his items', described.items === 2, described.items);

  /* ---- back to the live directory, then the restore ---- */
  dbMod.init(DATA);
  session.ensureSeed();
  const beforeItems = dbMod.listItems('').length;
  const beforeUsers = dbMod.listUsers().length;
  logLine('  before the restore: ' + beforeItems + ' items, ' + beforeUsers + ' users');

  const restoreAt = Date.now();
  const result = await restore.restoreFrom(customerFile, { relaunch: false });
  check('the restore reports success', result && result.ok === true, result);
  check('the restore names the file', result && result.file === 'v7-customer.db', result && result.file);
  check('the restore points at the copy of the old data', !!result.safety, result && result.safety);

  const afterItems = dbMod.listItems('');
  check('the customer data is now live', afterItems.length === 2, afterItems.map(i => i.code));
  check('the customer item is the right one', afterItems.some((i) => i.code === 'C-100'), afterItems.map(i => i.code));
  const liveItem = dbMod.getItem(afterItems[0].id);
  const stock = dbMod.itemStock(liveItem.id) || [];
  const goodTotal = stock.reduce((s, r) => s + Number(r.good || 0), 0);
  check('the customer stock came with it', goodTotal === 111, { rows: stock, goodTotal });

  /* ---- the old data was kept ---- */
  const backups = fs.existsSync(path.join(DATA, 'backups'))
    ? fs.readdirSync(path.join(DATA, 'backups')).filter((f) => /sam-pre-restore-.*\.db/.test(f))
    : [];
  check('a copy of the old data was kept', backups.length >= 1, backups);
  if (backups.length) {
    const old = path.join(DATA, 'backups', backups[0]);
    check('the copy of the old data is a database', restore.isSqlite(old) === true, old);
  }

  /* ---- the customer can still log in ---- */
  const users = dbMod.listUsers();
  check('the restored file has an account to log in with', users.length >= 1, users.map((u) => u.username));
  check('the account is «admin»', users.some((u) => u.username === 'admin'), users.map((u) => u.username));

  /* ---- the write-ahead log that is there now belongs to the NEW database ---- */
  const walPath = dbMod.dbFile() + '-wal';
  const walExists = fs.existsSync(walPath);
  const walFresh = walExists && fs.statSync(walPath).mtimeMs >= restoreAt - 3000;
  check('the old write-ahead log was removed with the old file', !walExists || walFresh,
    { walPath, walExists, walFresh });
}

/* ================= run ================= */
app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  await rmRetry(CUSTOMER);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  logLine('\n===== 1. the update check =====');
  if (!process.env.SAM_SKIP_PART1) await updaterTests();
  else logLine('  (part 1 was skipped)');

  logLine('\n===== 2. the screen =====');
  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
  updater.init(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4], line: a[5] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300) + ' @' + (d.source || '') + ':' + (d.line || '')); }
  });
  await rendererTests();

  logLine('\n===== 3. the restore =====');
  await restoreTests();

  logLine('\nCONSOLE ERRORS: ' + errors.length);
  errors.forEach((e) => logLine('  ' + e));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
