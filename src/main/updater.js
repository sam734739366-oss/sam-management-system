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
 * GitHub directly (ONE request, 18-second deadline) for the published tag and
 * compares it with the running version. The library is kept for the download
 * and is configured from updater.config.json, so it never depends on an
 * app-update.yml that may be missing from the installed folder.
 *
 * V7.1 — the DOWNLOAD was silent, and that is what the customer reported:
 * «عند تحميل التحديث لم يستجيب شي ولم يتحدث البرنامج» (he pressed «تحميل»
 * and the program said nothing at all).
 *
 *  1. THE SILENCE. `download()` did three things in a row without saying a
 *     word: it prepared the download (a SECOND network round-trip — the
 *     library asks GitHub again), it copied the database (the safety copy),
 *     and only THEN did it push the first state. On a slow line the first
 *     step alone takes 1–15 seconds and the copy takes more — the modal
 *     kept showing the old state («يتوفر تحديث»), the button did nothing,
 *     and the program looked dead.
 *     Now EVERY slow step pushes a state BEFORE it starts:
 *        «جارٍ تجهيز التحميل…» → «جارٍ أخذ نسخة احتياطية…» → «جارٍ التحميل…»
 *     The state keeps its machine values (available / downloading /
 *     downloaded / error …) so the settings screen and the title-bar button
 *     keep working, and it carries a `phase` that says WHAT is happening.
 *  2. THE SECOND ROUND-TRIP. The check already prepares the download in the
 *     background. That preparation is now SHARED: pressing «تحميل» never
 *     asks GitHub a second time — it waits for the preparation that is
 *     already running, or goes straight to the download when it succeeded.
 *  3. THE RAW ERRORS. Every failure the customer may see is now an Arabic
 *     sentence — never the English text of the updater library.
 *  4. THE PROGRESS. `download-progress` moves the bar with the percentage,
 *     the speed and the size — and the label follows it, so the modal is
 *     never frozen at «0%».
 *
 * Events are pushed to the renderer on channel 'app:update-state' with
 * { status, phase, percent, speed, transferred, total, version, message }.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const https = require('https');

const CHANNEL = 'app:update-state';

/* the deadlines — nothing in this file may wait for ever */
const TIME = {
  check: 18000,             /* our own answer to "is there a new version?" */
  prepare: 120000,          /* the library's own check — a slow line needs room */
  download: 30 * 60 * 1000  /* a slow line is not a broken line */
};

/* what is happening RIGHT NOW — the customer reads this, never a key */
const PHASE = {
  prepare: 'جارٍ تجهيز التحميل…',
  backup: 'جارٍ أخذ نسخة احتياطية…',
  download: 'جارٍ التحميل…'
};

let state = {
  status: 'idle',
  phase: '',       /* '' | 'prepare' | 'backup' | 'download' */
  percent: 0,
  speed: 0,
  transferred: 0,
  total: 0,
  version: null,
  latest: null,
  current: null,
  message: '',
  note: ''         /* the safety copy — a line of its own, not the headline */
};

let getWindow = () => null;
let autoUpdater = null;
let busy = false;          /* our own check is running */
let prepared = false;      /* the library knows what to download */
let inflight = null;       /* the check that is running RIGHT NOW */
let preparePromise = null; /* the preparation that is running RIGHT NOW */
let prepareError = null;   /* why the last preparation failed (Arabic) */
let downloading = false;   /* a download is running RIGHT NOW */
let providerReady = false; /* the provider was pointed at our feed already */

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

/**
 * The state goes to EVERY window.
 *
 * The updater lives in a window of its own (the small window that shows
 * the bar), and it listens on ITS OWN webContents — sending the state to
 * the main window only meant the customer pressed «تحميل» and nothing
 * happened: the bar never moved and no word was said.
 */
function push() {
  let windows = [];
  try { windows = require('electron').BrowserWindow.getAllWindows(); }
  catch (e) { windows = []; }
  const w = getWindow();
  if (w && windows.indexOf(w) < 0) windows.push(w);
  windows.forEach((win) => {
    try {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CHANNEL, state);
      }
    } catch (e) { /* the window closed while we were talking to it */ }
  });
  return state;
}

function set(patch) {
  state = { ...state, ...patch };
  return push();
}

const fmtError = (e) => (e && (e.message || e.description)) || String(e);

/** the customer must know WHICH version he has, not only that it is the last */
const upToDate = (v) => (v ? `أنت على أحدث إصدار (${v})` : 'أنت على أحدث إصدار');

/**
 * A friendly ARABIC sentence for every failure the user may see.
 *
 * The customer reads Arabic only: a raw English error of the updater
 * library («Please check update first», «net::ERR_…») is no help at all,
 * so it is translated — and when it cannot be translated, a clear Arabic
 * sentence replaces it instead of leaking the English text.
 */
function friendly(e) {
  const raw = fmtError(e);
  /* a sentence we wrote ourselves — it is already Arabic */
  if (/[؀-ۿ]/.test(raw)) return raw;
  if (/ETIMEDOUT|timeout|timed out/i.test(raw)) {
    return 'انتهت المهلة — الاتصال بالإنترنت بطيء جداً، حاول مرة أخرى';
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|ENETUNREACH/i.test(raw)) {
    return 'تعذّر الوصول إلى GitHub — تحقق من الاتصال بالإنترنت';
  }
  if (/ECONNABORTED|socket hang up|aborted/i.test(raw)) {
    return 'انقطع الاتصال أثناء التحديث — حاول مرة أخرى';
  }
  if (/check update first/i.test(raw)) {
    return 'تعذّر بدء التحميل — أعد فحص التحديثات أولاً';
  }
  if (/already in progress/i.test(raw)) {
    return 'التحميل جارٍ بالفعل — انتظر حتى ينتهي';
  }
  if (/ENOSPC|no space/i.test(raw)) {
    return 'لا توجد مساحة كافية على القرص لتثبيت التحديث';
  }
  if (/EACCES|EPERM|permission denied/i.test(raw)) {
    return 'تعذّر الكتابة على القرص — تحقق من الصلاحيات';
  }
  if (/certificate|SSL|self.signed/i.test(raw)) {
    return 'تعذّر الاتصال الآمن بـ GitHub — تحقق من الشبكة';
  }
  if (/404|not found|no published/i.test(raw)) {
    return 'لم يُعثر على ملف التحديث على GitHub';
  }
  if (/ERR_UPDATER|updater is inactive|not packaged/i.test(raw)) {
    return 'التحديث متاح في النسخة المثبتة (exe) فقط';
  }
  /* nothing we recognise — the customer still gets a sentence, not a code */
  return 'تعذّر تحميل التحديث — تحقق من الاتصال بالإنترنت ثم أعد المحاولة';
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

/**
 * The percentage of the download.
 *
 * The library reports 0–100 (percent: transferred / total * 100); the
 * older versions reported 0–1. Both are understood, so the bar never
 * freezes at 10% because of a change in the library.
 */
function progressPercent(p) {
  let v = Number(p && p.percent) || 0;
  if (v > 0 && v <= 1) v = v * 100;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
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
    /* while a download is running WE own the screen: the library must not
       wipe «جارٍ تجهيز التحميل…» and put the old verdict back */
    if (downloading) return;
    if (state.status === 'available') return;
    set({ status: 'available', phase: '', version: info.version, percent: 0, message: `يتوفر الإصدار ${info.version}` });
  });
  au.on('update-not-available', (info) => {
    if (state.status !== 'checking' && state.status !== 'idle') return;
    set({ status: 'up-to-date', phase: '', version: (info && info.version) || state.version, percent: 0, message: upToDate((info && info.version) || state.version) });
  });
  au.on('download-progress', (p) => {
    const pct = progressPercent(p);
    set({
      status: 'downloading',
      phase: 'download',
      percent: pct,
      speed: p.bytesPerSecond || 0,
      transferred: p.transferred || 0,
      total: p.total || 0,
      message: `جارٍ التحميل… ${Math.round(pct)}%`
    });
  });
  au.on('update-downloaded', (info) => set({
    status: 'downloaded',
    phase: '',
    version: info.version,
    percent: 100,
    message: 'اكتمل التحميل — جاهز للتثبيت'
  }));
  au.on('error', (e) => {
    /* a failure while preparing the download must not overwrite a verdict we
       already reached; a failure during the download must be shown */
    if (!['checking', 'idle', 'downloading'].includes(state.status)) return;
    set({ status: 'error', phase: '', percent: 0, message: friendly(e) });
  });
}

/**
 * The program is not packaged (npm start) — there is no installer to
 * download, so the real path is refused with a clear sentence.
 *
 * SAM_UPDATE_MODE=real forces the real path; the harness
 * (tools/v7-download-check.js) uses it to drive the REAL download machine
 * of a program that is not packaged.
 */
function devMode() {
  const forced = String(process.env.SAM_UPDATE_MODE || '').toLowerCase();
  if (forced === 'real') return false;
  if (forced === 'dev') return true;
  return !app.isPackaged;
}

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
  if (providerReady) return au;
  try {
    au.setFeedURL({ provider: 'github', owner: cfg.owner, repo: cfg.repo });
    providerReady = true;
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
    phase: '',
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
        set({ status: 'available', phase: '', version: found.version, latest: found.version, percent: 0, message: `يتوفر الإصدار ${found.version}` });
        /* the library prepares the download in the background — it is QUIET
           (it must not change the verdict we already reached) and it is
           SHARED: the download waits for THIS preparation instead of
           asking GitHub a second time. */
        prepare(cfg).catch(() => {});
      } else if (cmp === 0) {
        set({ status: 'up-to-date', phase: '', version: found.version, latest: found.version, percent: 0, message: upToDate(found.version) });
      } else {
        set({
          status: 'up-to-date',
          phase: '',
          version: found.version,
          latest: found.version,
          percent: 0,
          message: `نسختك أحدث من المنشور (${current} عندك — ${found.version} على GitHub)`
        });
      }
    } catch (e) {
      set({ status: 'error', phase: '', percent: 0, message: friendly(e) });
    } finally {
      busy = false;
    }
  })();

  inflight = run;
  try { await run; } catch (e) { /* the state already says what happened */ }
  if (inflight === run) inflight = null;
  return state;
}

/**
 * Ask the library what it would download, under a deadline.
 *
 * ONE preparation at a time: when the background preparation of the check
 * is still running, this waits for THAT one — the customer never pays for
 * a second round-trip to GitHub. When it already succeeded, nothing is
 * asked at all.
 */
async function prepare(cfg) {
  if (prepared) return true;                 /* nothing to ask — no network */
  if (preparePromise) return preparePromise; /* the same request, shared */
  const au = configureProvider(cfg || feedConfig());
  if (!au) throw new Error('مكتبة التحديث غير متوفرة');
  /* the work starts in a microtask, so the promise is registered BEFORE it
     can finish — a dead promise is never left behind */
  const work = Promise.resolve().then(async () => {
    try {
      await withTimeout(au.checkForUpdates(), TIME.prepare,
        'انتهت مهلة تجهيز التحميل — الاتصال بطيء، حاول مرة أخرى');
      prepared = true;
      prepareError = null;
      return true;
    } catch (e) {
      prepareError = friendly(e);
      throw e;
    }
  });
  const run = work.finally(() => { if (preparePromise === run) preparePromise = null; });
  preparePromise = run;
  return run;
}

/**
 * The download — the part the customer called dead.
 *
 * Every step says what it is doing BEFORE it starts:
 *   «جارٍ تجهيز التحميل…»     → the preparation (only when it is really needed)
 *   «جارٍ أخذ نسخة احتياطية…» → the safety copy of the database
 *   «جارٍ التحميل… NN%»       → the file itself, with the real progress
 *
 * A second press while the download runs does NOT start a second download:
 * the current state is returned, so the screen can report the progress.
 */
async function download() {
  if (devMode()) {
    return set({ status: 'dev', phase: '', percent: 0, message: 'التحميل متاح في النسخة المثبتة (exe) فقط — جرّب «معاينة شريط التقدم»' });
  }
  if (downloading) {
    /* the customer pressed again — report where we are, start nothing */
    return state;
  }
  downloading = true;
  try {
    const cfg = feedConfig();
    const au = configureProvider(cfg);
    if (!au) throw new Error('مكتبة التحديث غير متوفرة');

    /* ---- 1. the preparation (the second network round-trip) ---- */
    const already = prepared;
    set({
      status: 'downloading',
      phase: 'prepare',
      percent: 0, speed: 0, transferred: 0, total: 0,
      message: already ? 'التحميل جاهز — جارٍ البدء' : PHASE.prepare
    });
    if (!already) {
      try {
        await prepare(cfg);
      } catch (e) {
        throw new Error(prepareError || friendly(e));
      }
    }

    /* ---- 2. the safety copy (the database) ---- */
    set({
      status: 'downloading',
      phase: 'backup',
      percent: 0, speed: 0, transferred: 0, total: 0,
      message: PHASE.backup
    });
    const safety = await safetyBackup();

    /* ---- 3. the file itself ---- */
    set({
      status: 'downloading',
      phase: 'download',
      percent: 0, speed: 0, transferred: 0, total: 0,
      message: PHASE.download,
      note: safety || 'تعذّر أخذ نسخة احتياطية — التحميل مستمر'
    });
    await withTimeout(au.downloadUpdate(), TIME.download,
      'انتهت مهلة التحميل — الشبكة بطيئة جداً، حاول مرة أخرى');

    /* the library normally announces the finished file; if it did not, the
       customer must still be offered the install */
    if (state.status === 'downloading') {
      set({ status: 'downloaded', phase: '', percent: 100, message: 'اكتمل التحميل — جاهز للتثبيت' });
    }
    return state;
  } catch (e) {
    return set({ status: 'error', phase: '', percent: 0, message: friendly(e) });
  } finally {
    downloading = false;
  }
}

async function install() {
  if (devMode()) {
    return set({ status: 'dev', phase: '', percent: 0, message: 'التثبيت متاح في النسخة المثبتة (exe) فقط' });
  }
  /* the last line of defence: copy the database before the app restarts */
  const safety = await safetyBackup();
  setImmediate(() => {
    try { loadAutoUpdater().quitAndInstall(false, true); } catch (e) { /* ignore */ }
  });
  return set({
    status: 'installing',
    phase: '',
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
    set({ status: 'available', phase: '', version: '0.2.0', percent: 0, message: 'معاينة — يتوفر إصدار جديد 0.2.0' });
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 1; i <= 20; i++) {
      const percent = i * 5;
      set({
        status: 'downloading',
        phase: 'download',
        percent,
        transferred: Math.round((total * percent) / 100),
        total,
        speed: 3.2 * 1024 * 1024 + Math.round(Math.random() * 1.6 * 1024 * 1024),
        message: `جارٍ التحميل… ${percent}%`
      });
      await new Promise((r) => setTimeout(r, 160));
    }
    return set({ status: 'downloaded', phase: '', percent: 100, message: 'اكتمل التحميل (معاينة) — جاهز للتثبيت' });
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

module.exports = {
  init, autoCheck, state: () => state, check, cmpVersions, fetchJson, withTimeout, appVersion,
  /* the harness (tools/v7-download-check.js) drives the REAL machine */
  __test: { set, push, prepare, download, install, wire, progressPercent, friendly }
};
