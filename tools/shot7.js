/**
 * tools/shot7.js — verifies the in-app updater UI (progress bar, percent,
 * speed, size) and the honest "development mode" guard.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots7');
const DATA = path.join(ROOT, '.tmp', 'data7');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return true;
    } catch (e) {
      if (attempt === tries) { console.warn(`WARN: ${label} still locked after ${tries} tries (${e.code})`); return false; }
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  return false;
}

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (!cleanedUp) {
    cleanedUp = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    dbMod.close();
    await rmRetry(DATA, { label: 'temp data dir' });
  }
  app.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.message)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'updater.js')).init(() => win);

async function shot(name, settle = 900) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
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

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#0b1433',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) errors.push(`[console] ${d.source || ''}:${d.lineNumber || ''} ${d.message}`);
  });
  win.webContents.on('did-fail-load', (_e, c, m, u) => errors.push(`[load] ${c} ${m} ${u}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const step = async (label, code) => {
    try { console.log('  ' + label + ' -> ' + JSON.stringify(await js(code))); }
    catch (e) { console.log('  ' + label + ' FAILED: ' + e.message); throw e; }
  };

  await win.loadFile(path.join(RENDERER, 'app.html'));
  await sleep(1200);
  await step('login admin', `sam.auth.login('admin','admin123').then(r => r.ok ? 'ok' : 'FAIL ' + r.error)`);
  await sleep(1500);
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(700);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=update]').click()`);
  await sleep(900);
  await step('updater panel', `({
    badge: document.getElementById('updStateBadge').textContent,
    info: document.getElementById('updInfo').textContent.replace(/\s+/g,' ').trim(),
    feed: document.getElementById('updFeed').textContent.replace(/\s+/g,' ').trim()
  })`);
  await step('dev-mode check', `sam.update.check().then(r => r.status + ' | ' + r.message)`);
  await sleep(500);

  await js(`sam.update.simulate()`);
  await shot('p7-01-updater-downloading', 1300);
  await step('mid-download state', `({
    percent: document.getElementById('updPercent').textContent,
    label: document.getElementById('updLabel').textContent,
    size: document.getElementById('updSize').textContent,
    speed: document.getElementById('updSpeed').textContent,
    width: document.getElementById('updFill').style.width
  })`);
  await sleep(2600);
  await step('final state', `({
    percent: document.getElementById('updPercent').textContent,
    badge: document.getElementById('updStateBadge').textContent,
    installVisible: !document.getElementById('btnInstallUpdate').classList.contains('hidden')
  })`);
  await shot('p7-02-updater-done', 900);

  const code = errors.length ? 1 : 0;
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(code);
});
