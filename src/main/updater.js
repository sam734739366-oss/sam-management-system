'use strict';

/**
 * src/main/updater.js — the update check and the download, wired to an
 * in-app progress bar.
 *
 * V7 — the bar used to search for ever. Three real causes, all fixed here:
 *
 *  1. `checkForUpdates()` was awaited with NO deadline. The GitHub provider
 *     makes three HTTP calls in a row; if one of them stalls (proxy, DNS,
 *     throttling) the promise never settles and the state stays 'checking'
 *     for ever. Every network call now runs under an explicit deadline.
 *  2. The background check swallowed its rejection, so a failure could never
 *     reach the screen. It is handled now.
 *  3. Two checks could overlap (the silent one at launch + a click), and the
 *     second one is rejected by the library. A busy flag makes the second
 *     call return the state of the first one.
 *
 * The verdict itself no longer depends on the updater library: the app asks
 * GitHub directly (ONE request, 12-second deadline) for the published tag and
 * compares it with the running version. The library is kept for the download
 * and is configured from updater.config.json, so it never depends on an
 * app-update.yml that may be missing from the installed folder.
 *
 * Events are pushed to the renderer on channel 'app:update-state' with
 * { status, percent, speed, transferred, total, version, message }.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const https = require('https');

const CHANNEL = 'app:update-state';

/* the deadlines — nothing in this file may wait for ever */
const TIME = {
  check: 18000,             /* our own answer to "is there a new version?" */
  prepare: 45000,           /* the library's own check, which prepares the download */
  download: 30 * 60 * 1000  /* a slow line is not a broken line */
};

let state = {
  status: 'idle',
  percent: 0,
  speed: 0,
  transferred: 0,
  total: 0,
  version: null,
  latest: null,
  current: null,
  message: ''
};

let getWindow = () => null;
let autoUpdater = null;
let busy = false;      /* our own check is running */
let prepared = false;  /* the library knows what to download */
let inflight = null;   /* the check that is running RIGHT NOW */

/**
 * The version of THIS program.
 *
 * `app.getVersion()` is the version of Electron itself when the program is
 * started from a folder that has no package.json next to it — it then
 * answers "33.4.11", and the updater would compare the published 0.5.0 with
 * 33.4.11 and say "your copy is newer". The real version is the one in
 * package.json, exactly like `app:info` reports it.
 */
function appVersion() {
  try {
    const v = require(path.join(__dirname, '..', '..', 'package.json')).version;
    if (v) return String(v);
  } catch (e) { /* fall back to what Electron says */ }
  try { return app.getVersion(); } catch (e) { return '0.0.0'; }
}

function loadAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    autoUpdater = null;
  }
  return autoUpdater;
}

function push() {
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send(CHANNEL, state);
  return state;
}

function set(patch) {
  state = { ...state, ...patch };
  return push();
}

const fmtError = (e) => (e && (e.message || e.description)) || String(e);

/** a friendly Arabic sentence for every failure the user may see */
function friendly(e) {
  const raw = fmtError(e);
  if (/timeout|timed out|مهلة/i.test(raw)) return raw.replace(/^.*?(انتهت.*)$/, '$1');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return 'تعذّر الوصول إلى GitHub — تحقق من الاتصال بالإنترنت';
  }
  return raw;
}

/** a promise that can never hang: it rejects with a clear message instead */
function withTimeout(promise, ms, message) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/** compares "0.6.0" with "0.5.0" without pulling in a dependency */
function cmpVersions(a, b) {
  const clean = (v) => String(v == null ? '' : v).replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pa = clean(a);
  const pb = clean(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * ONE request to GitHub, with its own deadline. GitHub answers
 * `/releases/latest` with JSON when we ask for JSON — verified against the
 * live feed — so the answer comes in about a second instead of hanging.
 */
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('رابط غير صالح')); return; }
    let timedOut = false;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SAM-Management-System'
      }
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) { reject(new Error('تعذّر قراءة إصدار GitHub — تحويلات كثيرة')); return; }
        let next;
        try { next = new URL(res.headers.location, url).toString(); }
        catch (e) { reject(new Error('تعذّر قراءة إصدار GitHub')); return; }
        resolve(fetchJson(next, redirects + 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(code === 404
          ? 'لا توجد إصدارات منشورة على GitHub'
          : `استجابة غير متوقعة من GitHub (${code})`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 512 * 1024) { req.destroy(); reject(new Error('استجابة غير متوقعة من GitHub')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('تعذّر قراءة بيانات الإصدار من GitHub')); }
      });
    });
    req.setTimeout(TIME.check, () => { timedOut = true; req.destroy(); });
    req.on('error', () => {
      reject(new Error(timedOut
        ? 'انتهت مهلة الاتصال بـ GitHub'
        : 'تعذّر الوصول إلى GitHub — تحقق من الاتصال بالإنترنت'));
    });
    req.end();
  });
}

async function latestPublished(cfg) {
  const info = await fetchJson(`https://github.com/${cfg.owner}/${cfg.repo}/releases/latest`);
  const tag = String((info && info.tag_name) || '').trim();
  if (!tag) throw new Error('لم يُعثر على إصدار منشور على GitHub');
  const version = tag.replace(/^v/i, '');
  if (!/^\d+(\.\d+)*/.test(version)) throw new Error(`الإصدار المنشور غير مفهوم: ${tag}`);
  return { tag, version, url: `https://github.com/${cfg.owner}/${cfg.repo}/releases/tag/${tag}` };
}

function wire() {
  const au = loadAutoUpdater();
  if (!au) return;
  au.autoDownload = false;
  au.autoInstallOnAppQuit = true;
  au.logger = null;

  /* Our own state machine owns the "checking" status — the library must not
     drag the screen back to it while it prepares the download. */
  au.on('checking-for-update', () => { /* handled by our own check */ });

  au.on('update-available', (info) => {
    if (state.status === 'available') return;
    set({ status: 'available', version: info.version, percent: 0, message: `يتوفر الإصدار ${info.version}` });
  });
  au.on('update-not-available', (info) => {
    if (state.status !== 'checking' && state.status !== 'idle') return;
    set({ status: 'up-to-date', version: (info && info.version) || state.version, percent: 0, message: 'أنت على أحدث إصدار' });
  });
  au.on('download-progress', (p) => set({
    status: 'downloading',
    percent: Math.round((p.percent || 0) * 10) / 10,
    speed: p.bytesPerSecond || 0,
    transferred: p.transferred || 0,
    total: p.total || 0
  }));
  au.on('update-downloaded', (info) => set({
    status: 'downloaded',
    version: info.version,
    percent: 100,
    message: 'اكتمل التحميل — جاهز للتثبيت'
  }));
  au.on('error', (e) => {
    /* a failure while preparing the download must not overwrite a verdict we
       already reached; a failure during the download must be shown */
    if (!['checking', 'idle', 'downloading'].includes(state.status)) return;
    set({ status: 'error', percent: 0, message: friendly(e) });
  });
}

function devMode() { return !app.isPackaged; }

/**
 * V4 — a copy of the database is taken BEFORE any update is installed.
 * The customer asked that an update must never damage the data he entered,
 * so the copy is taken twice: before downloading and before installing.
 * A failure here never blocks the update — it only means no copy was made.
 */
async function safetyBackup() {
  try {
    const backup = require('./backup');
    const res = await backup.backupNow('pre-update');
    return `أُخذت نسخة احتياطية: ${res && res.path ? res.path : ''}`;
  } catch (e) {
    try {
      const db = require('./db');
      const path2 = require('path');
      const os = require('os');
      const fs = require('fs');
      const dir = path2.join(os.tmpdir(), 'sam-pre-update');
      fs.mkdirSync(dir, { recursive: true });
      const file = path2.join(dir, `sam-${Date.now()}.db`);
      await db.backupTo(file);
      return `أُخذت نسخة احتياطية: ${file}`;
    } catch (e2) {
      return '';
    }
  }
}

/** the published GitHub feed — one source of truth for the whole app */
function feedConfig() {
  return require(path.join(__dirname, '..', '..', 'updater.config.json'));
}

/** point the library at the same feed, so no app-update.yml is needed */
function configureProvider(cfg) {
  const au = loadAutoUpdater();
  if (!au) return null;
  try {
    au.setFeedURL({ provider: 'github', owner: cfg.owner, repo: cfg.repo });
  } catch (e) { /* the provider will complain later, with a readable message */ }
  return au;
}

/**
 * The check. It ALWAYS ends in a final state — available, up-to-date or
 * error — because every step of it has a deadline.
 *
 * V7 — a second call does NOT return "checking": it waits for the check that
 * is already running and returns ITS verdict. That is what happens when the
 * silent check at launch overlaps with a click on «فحص عن التحديث».
 */
async function check() {
  if (inflight) {
    /* another check is already running: wait for it, then report its verdict */
    try { await inflight; } catch (e) { /* the state already says what happened */ }
    return state;
  }
  busy = true;
  const current = appVersion();
  set({
    status: 'checking',
    percent: 0,
    speed: 0,
    transferred: 0,
    total: 0,
    current,
    message: 'جارٍ الفحص عن التحديث…'
  });

  const run = (async () => {
    try {
      const cfg = feedConfig();
      const found = await withTimeout(latestPublished(cfg), TIME.check, 'انتهت مهلة الفحص عن التحديث');
      const cmp = cmpVersions(found.version, current);
      if (cmp > 0) {
        set({ status: 'available', version: found.version, latest: found.version, percent: 0, message: `يتوفر الإصدار ${found.version}` });
        /* the library prepares the download in the background — its failure
           never changes the verdict we already reached */
        prepare(cfg).catch(() => {});
      } else if (cmp === 0) {
        set({ status: 'up-to-date', version: found.version, latest: found.version, percent: 0, message: 'أنت على أحدث إصدار' });
      } else {
        set({
          status: 'up-to-date',
          version: found.version,
          latest: found.version,
          percent: 0,
          message: `نسختك أحدث من المنشور (${current} عندك — ${found.version} على GitHub)`
        });
      }
    } catch (e) {
      set({ status: 'error', percent: 0, message: friendly(e) });
    } finally {
      busy = false;
    }
  })();

  inflight = run;
  try { await run; } catch (e) { /* the state already says what happened */ }
  if (inflight === run) inflight = null;
  return state;
}

/** ask the library what it would download, under a deadline */
async function prepare(cfg) {
  const au = configureProvider(cfg || feedConfig());
  if (!au) throw new Error('مكتبة التحديث غير متوفرة');
  await withTimeout(au.checkForUpdates(), TIME.prepare, 'انتهت مهلة تجهيز التحميل');
  prepared = true;
  return true;
}

async function download() {
  if (devMode()) {
    return set({ status: 'dev', percent: 0, message: 'التحميل متاح في النسخة المثبتة (exe) فقط — جرّب «معاينة شريط التقدم»' });
  }
  try {
    const cfg = feedConfig();
    const au = configureProvider(cfg);
    if (!au) throw new Error('مكتبة التحديث غير متوفرة');
    if (!prepared) await prepare(cfg);
    /* V4 — never let an update touch the data without a safety copy first */
    const safety = await safetyBackup();
    set({ status: 'downloading', percent: 0, message: safety ? `${safety} — جارٍ التحميل` : 'جارٍ التحميل' });
    await withTimeout(au.downloadUpdate(), TIME.download, 'انتهت مهلة التحميل');
    return state;
  } catch (e) {
    return set({ status: 'error', percent: 0, message: friendly(e) });
  }
}

async function install() {
  if (devMode()) {
    return set({ status: 'dev', percent: 0, message: 'التثبيت متاح في النسخة المثبتة (exe) فقط' });
  }
  /* the last line of defence: copy the database before the app restarts */
  const safety = await safetyBackup();
  setImmediate(() => {
    try { loadAutoUpdater().quitAndInstall(false, true); } catch (e) { /* ignore */ }
  });
  return set({
    status: 'installing',
    percent: 100,
    message: safety ? `${safety} — جارٍ إعادة التشغيل والتثبيت…` : 'جارٍ إعادة التشغيل والتثبيت…'
  });
}

function init(getWindowFn) {
  getWindow = getWindowFn || (() => null);
  wire();
  /* the provider is configured from the very beginning, so the library never
     goes looking for an app-update.yml inside the installed folder */
  try { configureProvider(feedConfig()); } catch (e) { /* ignore */ }

  ipcMain.handle('update:state', () => state);

  ipcMain.handle('update:check', () => check());

  ipcMain.handle('update:download', () => download());

  ipcMain.handle('update:install', () => install());

  /* the safety copy the user can find if anything goes wrong */
  ipcMain.handle('update:backup', async () => {
    try {
      const r = await safetyBackup();
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: fmtError(e) };
    }
  });

  /* honest preview of the progress UI while developing */
  ipcMain.handle('update:simulate', async () => {
    const total = 78 * 1024 * 1024;
    set({ status: 'available', version: '0.2.0', percent: 0, message: 'معاينة — يتوفر إصدار جديد 0.2.0' });
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 1; i <= 20; i++) {
      const percent = i * 5;
      set({
        status: 'downloading',
        percent,
        transferred: Math.round((total * percent) / 100),
        total,
        speed: 3.2 * 1024 * 1024 + Math.round(Math.random() * 1.6 * 1024 * 1024)
      });
      await new Promise((r) => setTimeout(r, 160));
    }
    return set({ status: 'downloaded', percent: 100, message: 'اكتمل التحميل (معاينة) — جاهز للتثبيت' });
  });

  ipcMain.handle('update:feed', () => {
    try { return feedConfig(); } catch (e) { return { error: e.message }; }
  });
}

/** silent background check a few seconds after launch */
function autoCheck(delayMs = 8000) {
  if (devMode()) return;
  setTimeout(() => { check().catch(() => { /* the state already says what happened */ }); }, delayMs);
}

module.exports = { init, autoCheck, state: () => state, check, cmpVersions, fetchJson, withTimeout, appVersion };
