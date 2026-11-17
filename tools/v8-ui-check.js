/**
 * tools/v8-ui-check.js — the new screen, seen.
 *
 * The customer will do this in front of the customer: open the settings,
 * look at the data folder, see the repair button and the instruction
 * line. This drives the REAL window and checks that:
 *   1 — the settings screen opens;
 *   2 — the data tab shows the folder, the size and the write permission;
 *   3 — the repair button is there and HIDDEN while everything is fine;
 *   4 — when the folder is read-only, the button APPEARS and says why;
 *   5 — pressing it repairs the folder and the data is untouched;
 *   6 — the instruction line that tells him how to move the data is there.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v8-ui-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v8ui');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

process.env.SAM_DATA_DIR = DATA;

app.whenReady().then(async () => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(DATA, { recursive: true });

  const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
  const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
  db.init(DATA);
  session.ensureSeed();
  db.addWarehouse({ code: 'W1', name: 'مخزن', location: '' });
  db.addItem({ code: 'R-1', name: 'خامة', base_unit: 'حبة' }, [{ warehouseId: 1, good: 100 }]);

  /* the REAL IPC surface — the same handlers the app registers */
  require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);

  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const js = (code) => win.webContents.executeJavaScript(code);

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(900);
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(1800);

  /* ---- 1 — the settings screen ---- */
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(800);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=data]').click()`);
  await sleep(1200);

  const info = await js(`(() => {
    const rows = [...document.querySelectorAll('#ddInfo dt')].map((dt,i)=>dt.textContent.trim()+': '+document.querySelectorAll('#ddInfo dd')[i].textContent.trim());
    return {
      badge: document.getElementById('ddBadge').textContent.trim(),
      rows,
      fixVisible: document.getElementById('btnFixDataDir') ? document.getElementById('btnFixDataDir').style.display !== 'none' : null,
      fixLabel: document.getElementById('btnFixDataDir') ? document.getElementById('btnFixDataDir').textContent.trim() : null,
      notes: [...document.querySelectorAll('#set-data .foot-note')].map(n=>n.textContent.trim())
    };
  })()`);

  check('the settings screen opens the data tab', !!info && info.rows.length >= 5, info && info.rows);
  check('it shows the data folder and the file', !!(info && info.rows.some(r => r.indexOf('مجلد البيانات') === 0)));
  check('it shows the write permission in Arabic', !!(info && info.rows.some(r => r.indexOf('صلاحية الكتابة') === 0)), info && info.rows.find(r => r.indexOf('صلاحية الكتابة') === 0));
  check('the repair button is HIDDEN while everything is fine', info && info.fixVisible === false, info && { visible: info.fixVisible });
  check('the instruction line for moving the data is there',
    !!(info && info.notes.some(n => n.indexOf('لنقل البيانات إلى جهاز آخر') >= 0)),
    info && info.notes.find(n => n.indexOf('لنقل') >= 0));

  /* ---- 2 — the folder goes read-only: the button must appear ---- */
  const dbFile = path.join(DATA, 'sam.db');
  fs.chmodSync(dbFile, 0o444);
  await js(`sam.datadir.info().then(()=>{ if (window.SamSettings) window.SamSettings.load(); })`);
  await sleep(400);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=data]').click()`);
  await sleep(1200);
  const broken = await js(`(() => ({
    badge: document.getElementById('ddBadge').textContent.trim(),
    fixVisible: document.getElementById('btnFixDataDir').style.display !== 'none',
    perm: [...document.querySelectorAll('#ddInfo dt')].map((dt,i)=>dt.textContent.trim()+': '+document.querySelectorAll('#ddInfo dd')[i].textContent.trim()).find(r=>r.indexOf('صلاحية الكتابة')===0)
  }))()`);
  check('the badge says the folder needs fixing', broken && broken.badge.indexOf('إصلاح') >= 0, broken && broken.badge);
  check('the repair button APPEARS', broken && broken.fixVisible === true, broken);
  check('it says WHY, in Arabic', !!(broken && broken.perm && broken.perm.indexOf('إصلاح') >= 0), broken && broken.perm);

  /* ---- 3 — pressing it repairs the folder (the customer confirms the
             question the program asks) ---- */
  await js(`(() => { document.getElementById('btnFixDataDir').click(); return 'clicked'; })()`);
  await sleep(700);
  const asked = await js(`(() => {
    const m = document.querySelector('.modal');
    if (!m) return { modal: false };
    const btns = [...m.querySelectorAll('.modal-foot .btn')].map(b => b.textContent.trim());
    const yes = [...m.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.indexOf('إصلاح الآن') >= 0);
    if (yes) yes.click();
    return { modal: true, buttons: btns };
  })()`);
  check('the program asks before touching anything', asked && asked.modal === true, asked);
  await sleep(2500);
  const after = await js(`sam.datadir.info().then(r => r.ok ? r.data : null)`);
  check('the repair made the folder writable again', after && after.writable === true && after.dbWritable === true,
    after && { writable: after.writable, dbWritable: after.dbWritable });
  const stillThere = db.listItems().length;
  check('the data is untouched', stillThere === 1, { items: stillThere });

  /* ---- 4 — the export produces ONE clean file ---- */
  const exportDir = path.join(ROOT, '.tmp', 'v8ui-export');
  try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(exportDir, { recursive: true });
  const exported = await datadirExport(exportDir);
  check('the export writes ONE file', exported && exported.ok && fs.readdirSync(exportDir).length === 1,
    exported && { files: fs.readdirSync(exportDir) });
  const exportedFile = path.join(exportDir, 'sam.db');
  const attr = require('child_process').execFileSync('attrib', [exportedFile], { encoding: 'utf8' }).split(/\r?\n/)[0];
  check('the exported file carries no read-only mark', !(attr.split(':')[0] || '').trim().includes('R'), { attrib: attr.trim() });

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  try { db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(fail ? 1 : 0);
});

/** the export the customer presses: «حفظ نسخة في مكان آخر» */
function datadirExport(dir) {
  const datadir = require(path.join(ROOT, 'src', 'main', 'datadir.js'));
  return datadir.exportTo({
    getPath(which) {
      if (which === 'userData') return DATA;
      if (which === 'appData') return path.dirname(DATA);
      if (which === 'documents') return path.join(ROOT, '.tmp', 'v8ui-docs');
      if (which === 'temp') return path.join(ROOT, '.tmp', 'v8ui-temp');
      return DATA;
    }
  }, dir, path.join(DATA, 'sam.db')).then((r) => ({ ok: true, path: r.path })).catch((e) => ({ ok: false, error: e.message }));
}
