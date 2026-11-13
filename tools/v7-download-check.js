/**
 * tools/v7-download-check.js — the DOWNLOAD must TALK.
 *
 * The customer installed the released build, pressed «فحص التحديثات», saw
 * that an update exists, pressed «تحميل» — and NOTHING happened: no
 * movement, no word, no message. The program looked dead.
 *
 * The cause was in the main process: `download()` prepared the download (a
 * second network round-trip) and copied the database WITHOUT pushing a
 * single state, so the modal kept showing the old state for a long, long
 * time. This harness drives the REAL update machine of the REAL app and
 * proves, against the REAL modal:
 *
 *   1. a NEW state reaches the modal within a second of the press
 *   2. the state of the preparation is Arabic (never a raw key)
 *   3. the progress moves the bar (percent + speed + size)
 *   4. a failure is an Arabic sentence and the modal stays usable
 *   5. the preparation is done ONCE — no second round-trip to GitHub
 *
 * The network is a FAKE one (a stub of electron-updater that behaves like
 * the slow line of the customer: the preparation takes seconds), but every
 * line of src/main/updater.js and src/renderer/js/updatewin.js that is
 * exercised here is the real one.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-download-check.js
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7download');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-download-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const ARABIC = /[؀-ۿ]/;

/* ------------------------------------------------------------------ *
 * the fake network — the slow line of the customer
 * ------------------------------------------------------------------ */
const net = {
  prepareDelay: 2500,     /* the library asks GitHub again — it is slow */
  prepareFails: false,
  downloadFails: false,
  checks: 0,              /* how many times GitHub was asked */
  downloads: 0
};

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = true;
    this.logger = null;
    this.installed = false;
  }
  setFeedURL() { /* the feed is ours already */ }
  checkForUpdates() {
    net.checks++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (net.prepareFails) {
          const e = new Error('net::ERR_INTERNET_DISCONNECTED');
          this.emit('error', e);       /* the library does exactly this */
          reject(e);
          return;
        }
        this.emit('update-available', { version: '9.9.9' });
        resolve({ version: '9.9.9', files: [] });
      }, net.prepareDelay);
    });
  }
  async downloadUpdate() {
    net.downloads++;
    const total = 100 * 1024 * 1024;
    if (net.downloadFails) {
      /* a RAW ENGLISH error of the library — the customer must never see it */
      const e = new Error('net::ERR_CONNECTION_RESET');
      this.emit('error', e);
      throw e;
    }
    for (let i = 1; i <= 5; i++) {
      await sleep(320);
      const transferred = Math.round((total * (i * 20)) / 100);
      this.emit('download-progress', {
        percent: i * 20,                              /* 0–100, as the library reports it */
        bytesPerSecond: Math.round(1024 * 1024 * (1 + i / 2)),
        transferred,
        total
      });
    }
    this.emit('update-downloaded', { version: '9.9.9' });
    return [path.join(ROOT, '.tmp', 'SAM-Setup-9.9.9.exe')];
  }
  quitAndInstall() { this.installed = true; }
}

/* the stub replaces the library — it must be in place BEFORE the updater
   is loaded, so the real code wires itself to it */
const realUpdater = require.resolve('electron-updater');
const fake = new FakeUpdater();
require.cache[realUpdater] = {
  id: realUpdater, filename: realUpdater, loaded: true,
  exports: { autoUpdater: fake }
};

/* the harness drives the REAL download path of a program that is not
   packaged (the updater reads this) */
process.env.SAM_UPDATE_MODE = 'real';
process.env.SAM_DATA_DIR = DATA;

const updater = require(path.join(ROOT, 'src', 'main', 'updater.js'));
const cfg = require(path.join(ROOT, 'updater.config.json'));

let win = null;
let cleanedUp = false;
async function shutdown(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { require(path.join(ROOT, 'src', 'main', 'db.js')).close(); } catch (e) {}
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code == null ? (fail ? 1 : 0) : code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(); } });

/* the read of the REAL modal — everything is taken from inside the modal */
const READ = `(() => {
  try {
    const win = document.querySelector('.updwin-window');
    if (!win) return { ERROR: 'no modal' };
    const g = (id) => win.querySelector('#' + id);
    const badge = win.querySelector('.uw-status .badge');
    const dl = g('uwBtnDownload');
    const ins = g('uwBtnInstall');
    const dlTxt = dl ? dl.querySelector('.btn-txt') : null;
    return {
      badge: badge ? badge.textContent : null,
      label: g('uwLabel') ? g('uwLabel').textContent : null,
      percent: g('uwPercent') ? g('uwPercent').textContent : null,
      size: g('uwSize') ? g('uwSize').textContent : null,
      speed: g('uwSpeed') ? g('uwSpeed').textContent : null,
      fill: g('uwFill') ? g('uwFill').style.width : null,
      wrap: g('uwLabel') ? g('uwLabel').closest('.upd-bar-wrap').className : null,
      dlText: dlTxt ? dlTxt.textContent : null,
      dlHidden: dl ? dl.classList.contains('hidden') : null,
      insHidden: ins ? ins.classList.contains('hidden') : null,
      info: win.querySelector('.info') ? win.querySelector('.info').innerText : null
    };
  } catch (e) {
    return { ERROR: String(e && e.message) };
  }
})()`;

async function run() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });
  const read = async () => (await js(READ)) || {};

  /* ---------------- the app ---------------- */
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
  dbMod.init(DATA);
  require(path.join(ROOT, 'src', 'main', 'session.js')).ensureSeed();

  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
  updater.init(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);
  const onMain = await js(`!!document.querySelector('.nav-item[data-view=settings]')`);
  check('the program is open on its main page', onMain === true, onMain);

  /* ---------------- the modal, opened the way the customer opens it ------- */
  await js(`document.getElementById('btnUpdate').click()`);
  await sleep(700);
  let modal = await read();
  check('the update modal is open', !modal.ERROR, modal.ERROR);
  check('the modal starts with an Arabic badge', !!(modal.badge && ARABIC.test(modal.badge)), modal.badge);

  /* ---- the verdict of the check: an update is waiting ---- */
  updater.__test.set({ status: 'available', phase: '', version: '9.9.9', latest: '9.9.9', percent: 0, message: 'يتوفر الإصدار 9.9.9' });
  await sleep(400);
  modal = await read();
  check('the modal shows the waiting update', /يتوفر تحديث/.test(modal.badge || ''), modal.badge);
  check('the download button is there', modal.dlHidden === false, modal);
  check('the download button carries its Arabic name', /تحميل/.test(modal.dlText || ''), modal.dlText);

  /* ================= 1. the progress event moves the bar ================= */
  fake.emit('download-progress', {
    percent: 42, bytesPerSecond: 2 * 1024 * 1024, transferred: 42 * 1024 * 1024, total: 100 * 1024 * 1024
  });
  await sleep(400);
  const moved = await read();
  check('the progress moves the percentage', moved.percent === '42.0%', moved.percent);
  check('the progress moves the bar', moved.fill === '42%', moved.fill);
  check('the progress shows the speed', /MB\/ث/.test(moved.speed || '') && !/^—/.test(moved.speed || ''), moved.speed);
  check('the progress shows the size', /42\.0 \/ 100\.0 MB/.test(moved.size || ''), moved.size);
  check('the badge during the download is Arabic', !!(moved.badge && ARABIC.test(moved.badge)), moved.badge);

  /* the verdict is back — the customer may press the button */
  updater.__test.set({ status: 'available', phase: '', version: '9.9.9', latest: '9.9.9', percent: 0, message: 'يتوفر الإصدار 9.9.9' });
  await sleep(300);

  /* ================= 2. the press, and the silence ================= */
  /* the preparation is running in the background — exactly as it does after
     the check. The download must WAIT for it, not start a second one. */
  const prep = updater.__test.prepare(cfg);
  await sleep(150);                      /* the preparation really started */
  const checksBefore = net.checks;

  const before = await read();
  const t0 = Date.now();
  await js(`document.getElementById('uwBtnDownload').click()`);

  /* ---- a NEW state must reach the modal within a second ---- */
  let first = null;
  for (let i = 0; i < 80; i++) {
    const s = await read();
    if (!s.ERROR && (s.badge !== before.badge || s.label !== before.label)) {
      first = { ms: Date.now() - t0, s };
      break;
    }
    await sleep(40);
  }
  check('the modal receives a new state within a second', !!first && first.ms <= 1000, first && { ms: first.ms, badge: first.s.badge, label: first.s.label });
  check('the silence is gone: the modal is not showing the old state', !!first && first.s.badge !== before.badge, { before: before.badge, after: first && first.s.badge });

  /* ---- the preparation is shown in Arabic ---- */
  const during = await read();
  check('the preparation shows an Arabic badge', !!(during.badge && ARABIC.test(during.badge)), during.badge);
  check('the preparation does not show a raw key', !/^[a-z][a-z-]*$/i.test(String(during.badge || '')), during.badge);
  check('the preparation says what is happening', /تجهيز|نسخة|التحميل/.test(during.badge + ' ' + (during.label || '')), { badge: during.badge, label: during.label });
  check('the label of the modal is Arabic too', !!(during.label && ARABIC.test(during.label)), during.label);

  /* ---- the button must not look dead ---- */
  check('the download button stays on the screen while it works', during.dlHidden === false, during);
  check('the download button says what it is doing', /جارٍ/.test(during.dlText || ''), during.dlText);

  /* ---- the bar reacts ---- */
  check('the bar is alive (the stripes move or it breathes)', /busy|checking/.test(during.wrap || ''), during.wrap);

  /* ---- no SECOND round-trip to GitHub ---- */
  await prep.catch(() => {});
  check('the download did not ask GitHub a second time', net.checks === checksBefore, { before: checksBefore, after: net.checks });

  /* ---- a second press reports the progress instead of doing nothing ---- */
  let toastText = '';
  for (let i = 0; i < 60; i++) {
    const s = await read();
    if (s.percent && s.percent !== '0.0%') break;
    await sleep(100);
  }
  await js(`document.getElementById('uwBtnDownload').click()`);
  await sleep(300);
  const toasts = await js(`[...document.querySelectorAll('#toasts .toast')].map(t => t.textContent)`);
  toastText = (toasts || []).join(' | ');
  check('a second press reports the progress', /جارٍ|%/.test(toastText), toastText);
  check('a second press does not start a second download', net.downloads === 1, net.downloads);

  /* ---- the progress really moves ---- */
  let progressed = null;
  for (let i = 0; i < 80; i++) {
    const s = await read();
    if (s.percent && s.percent !== '0.0%' && s.percent !== '42.0%') { progressed = s; break; }
    await sleep(100);
  }
  check('the download moves the bar', !!progressed, progressed);
  if (progressed) {
    check('the percentage of the download is real', parseFloat(progressed.percent) > 0 && parseFloat(progressed.percent) <= 100, progressed.percent);
    check('the speed of the download is shown', !/^—/.test(progressed.speed || ''), progressed.speed);
    check('the size of the download is shown', !/^0\.0 \/ 0\.0/.test(progressed.size || ''), progressed.size);
  }

  /* ---- the finished file offers the install ---- */
  let done = null;
  for (let i = 0; i < 80; i++) {
    const s = await read();
    if (s.insHidden === false) { done = s; break; }
    await sleep(100);
  }
  check('the modal offers the install when the file is ready', !!done, done);
  if (done) {
    check('the finished file is at a hundred', done.percent === '100.0%', done.percent);
    check('the finished file says it is ready', /تثبيت|جاهز/.test((done.badge || '') + ' ' + (done.label || '')), { badge: done.badge, label: done.label });
  }

  /* ================= 3. the failure ================= */
  updater.__test.set({ status: 'available', phase: '', version: '9.9.9', latest: '9.9.9', percent: 0, message: 'يتوفر الإصدار 9.9.9' });
  await sleep(300);
  net.downloadFails = true;
  await js(`document.getElementById('uwBtnDownload').click()`);
  let failed = null;
  for (let i = 0; i < 80; i++) {
    const s = await read();
    if (s.badge && /خطأ/.test(s.badge)) { failed = s; break; }
    await sleep(100);
  }
  check('a failure is shown on the modal', !!failed, failed);
  if (failed) {
    check('the failure is an Arabic sentence', !!(failed.label && ARABIC.test(failed.label)), failed.label);
    check('the failure is not the English text of the library', !/ERR_|Error:|check update first/i.test(failed.label || ''), failed.label);
    check('the failure says what to do', /تحقق|حاول|أعد|اتصال/.test(failed.label || ''), failed.label);
    check('the modal stays usable after the failure', failed.dlHidden === false, failed);
    check('the button offers another try', /إعادة المحاولة/.test(failed.dlText || ''), failed.dlText);
    check('the bar is not left running', !/busy|checking/.test(failed.wrap || ''), failed.wrap);
  }

  /* the program is still alive: the check button still answers */
  const stillThere = await js(`!!document.getElementById('uwBtnCheck')`);
  check('the modal is still there after the failure', stillThere === true, stillThere);

  await sleep(300);
  shutdown();
}

app.whenReady().then(() => run().catch((e) => {
  logLine('FATAL: ' + (e && e.stack ? e.stack : e));
  shutdown(1);
}));
