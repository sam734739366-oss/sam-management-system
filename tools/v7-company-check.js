/**
 * tools/v7-company-check.js — the company of the customer in the settings:
 *   · the settings screen has the new «الشركة» tab, with its fields
 *   · the switch of the pack units is ON by default (the setting is missing)
 *   · the name is stored and comes back after a restart
 *   · the logo is stored as a FILE NAME, and the file really lands in the
 *     images folder of the data folder
 *   · SamCompany carries the name and a file:// link
 *   · the printed sheet carries the company — and the program's own name
 *     and its watermark stay in the footer of the paper
 *   · the logo can be removed again (the setting and the file both go)
 * It drives the REAL main process and the REAL renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-company-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7company');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const IMAGES = path.join(DATA, 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-company-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const errors = [];

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  await rmRetry(DATA);
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;

/* the logo of the test: a real 1×1 PNG */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const COMPANY_NAME = 'شركة الأمل للمشروبات';

async function rmRetry(target, { tries = 8, base = 100 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) {
      if (attempt === tries) return false;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  return false;
}

/* ================= the renderer ================= */

async function rendererTests() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 220) + ' :: ' + e.message);
    return null;
  });

  /** wait until an expression in the page becomes true */
  async function until(code, label, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await js(code);
      if (v) return v;
      await sleep(250);
    }
    logLine('  (timed out waiting for: ' + label + ')');
    return null;
  }

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(3000);

  /* a recorder for every error the page throws */
  await js(`window.__errs = [];
    window.addEventListener('error', (e) => { window.__errs.push({ msg: String(e.message), src: e.filename, line: e.lineno }); });
    window.addEventListener('unhandledrejection', (e) => { window.__errs.push({ msg: 'rejection: ' + String(e.reason && e.reason.message ? e.reason.message : e.reason) }); });
    1`);

  /* ---- open the settings and the new tab ---- */
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(900);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=company]').click()`);
  await sleep(1000);

  const ui = (await js(`(() => {
    const b = document.querySelector('#settingsTabs .tab[data-tab=company]');
    const p = document.getElementById('set-company');
    const box = document.getElementById('companyLogoBox');
    const r = box ? box.getBoundingClientRect() : null;
    const pack = document.getElementById('showPackUnits');
    return {
      tab: !!b,
      tabText: b ? b.textContent.trim() : '',
      panel: !!p,
      visible: p ? !p.classList.contains('hidden') : false,
      nameField: !!document.getElementById('companyName'),
      logoBox: !!box,
      logoImg: !!document.getElementById('companyLogoImg'),
      pickBtn: !!document.getElementById('btnPickLogo'),
      removeBtn: !!document.getElementById('btnRemoveLogo'),
      saveBtn: !!document.getElementById('btnSaveCompany'),
      pack: !!pack,
      packChecked: pack ? pack.checked : null,
      box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      active: b ? b.classList.contains('active') : false
    };
  })()`)) || {};
  check('the settings screen has the «الشركة» tab', ui.tab === true && /الشركة/.test(ui.tabText || ''), ui.tabText);
  check('the tab becomes the active one when it is clicked', ui.active === true, ui.active);
  check('the panel of the company opens', ui.panel === true && ui.visible === true, ui);
  check('the tab carries the name field', ui.nameField === true, ui.nameField);
  check('the tab carries the picture picker', ui.logoBox === true && ui.logoImg === true && ui.pickBtn === true && ui.removeBtn === true, ui);
  check('the tab carries the save button', ui.saveBtn === true, ui.saveBtn);
  check('the tab carries the switch of the pack units', ui.pack === true, ui.pack);
  check('the preview of the logo is about 120×60', !!ui.box && ui.box.w >= 110 && ui.box.w <= 132 && ui.box.h >= 50 && ui.box.h <= 72, ui.box);
  check('the pack units are shown by default (the setting is missing)', ui.packChecked === true, ui.packChecked);

  /* ---- the name and the picture ---- */
  await js(`(() => {
    const n = document.getElementById('companyName');
    n.value = ${JSON.stringify(COMPANY_NAME)};
    n.dispatchEvent(new Event('input', { bubbles: true }));
    return n.value;
  })()`);

  await js(`(() => {
    const bin = atob(${JSON.stringify(PNG_B64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'logo.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const inp = document.getElementById('companyLogoFile');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const picked = await until(`(() => { const i = document.getElementById('companyLogoImg'); return !!(i && i.src && i.src.indexOf('data:image') === 0); })()`, 'the picture is read');
  check('the chosen picture shows in the preview at once', !!picked, picked);

  /* ---- the save ---- */
  await js(`document.getElementById('btnSaveCompany').click()`);
  /* the three settings are written one after the other — wait for the last */
  const saved = await until(`(async () => {
    const all = await SamDB.call('allSettings');
    if (!all || !all.company_name || !all.company_logo || all.show_pack_units === undefined) return null;
    return all;
  })()`, 'the settings are written');
  check('the name is stored in the settings', !!saved && saved.company_name === COMPANY_NAME, saved && saved.company_name);
  check('the logo is stored as the NAME of the file', !!saved && saved.company_logo === 'company-logo.png', saved && saved.company_logo);
  check('the switch is stored with the save', !!saved && saved.show_pack_units === '1', saved && saved.show_pack_units);

  const logoFile = path.join(IMAGES, 'company-logo.png');
  check('the picture really landed in the images folder of the data folder',
    fs.existsSync(logoFile) && fs.statSync(logoFile).size > 0, logoFile);

  /* ---- SamCompany carries it ---- */
  const comp = (await js(`(async () => {
    await SamCompany.load();
    return { name: SamCompany.data.name, logo: SamCompany.data.logo, logoFile: SamCompany.logoFile };
  })()`)) || {};
  check('SamCompany carries the name of the company', comp.name === COMPANY_NAME, comp.name);
  check('SamCompany carries a file:// link for the logo', typeof comp.logo === 'string' && comp.logo.indexOf('file://') === 0, comp.logo);
  check('the link points at the saved picture', !!comp.logo && comp.logo.indexOf('company-logo.png') >= 0, comp.logo);
  check('SamCompany keeps the name of the file', comp.logoFile === 'company-logo.png', comp.logoFile);

  /* ---- the printed sheet ---- */
  const html = (await js(`SamUI.sheet({ title: 'ورقة اختبار' }).outerHTML`)) || '';
  check('the printed sheet carries the name of the company', html.indexOf(COMPANY_NAME) >= 0, html.length);
  check('the printed sheet carries the logo of the company', html.indexOf('co-logo') >= 0 && html.indexOf('company-logo.png') >= 0, html.indexOf('co-logo'));
  check('the printed sheet keeps the program in the footer', html.indexOf('SAM Management System') >= 0, html.indexOf('SAM Management System'));
  check('the printed sheet keeps the watermark', html.indexOf('SAM 775158678') >= 0, html.indexOf('SAM 775158678'));
  check('the printed sheet says the company comes through SAM', html.indexOf('عبر نظام SAM') >= 0, html.indexOf('عبر نظام SAM'));

  /* ---- the switch of the pack units ---- */
  await js(`(() => { const p = document.getElementById('showPackUnits'); p.checked = false; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const off = await until(`(async () => { const all = await SamDB.call('allSettings'); return all && all.show_pack_units === '0' ? all : null; })()`, 'show_pack_units is off');
  check('the switch stores show_pack_units = 0', !!off, off && off.show_pack_units);
  await js(`(() => { const p = document.getElementById('showPackUnits'); p.checked = true; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const on = await until(`(async () => { const all = await SamDB.call('allSettings'); return all && all.show_pack_units === '1' ? all : null; })()`, 'show_pack_units is on');
  check('the switch stores show_pack_units = 1', !!on, on && on.show_pack_units);

  /* ---- the name survives a restart ---- */
  await win.loadFile(path.join(RENDERER, 'app.html'));
  await sleep(2600);
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(700);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=company]').click()`);
  await sleep(900);
  const after = (await js(`(() => {
    const n = document.getElementById('companyName');
    const i = document.getElementById('companyLogoImg');
    return { name: n ? n.value : '', logo: i ? i.src : '' };
  })()`)) || {};
  check('the name comes back after a restart', after.name === COMPANY_NAME, after.name);
  check('the logo comes back after a restart', !!after.logo && after.logo.indexOf('company-logo.png') >= 0, after.logo);

  /* ---- the logo can be removed ---- */
  await js(`document.getElementById('btnRemoveLogo').click()`);
  const gone = await until(`(async () => { const all = await SamDB.call('allSettings'); return all && !all.company_logo ? all : null; })()`, 'the logo setting is cleared');
  check('removing the logo clears the setting', !!gone, gone && gone.company_logo);
  check('removing the logo deletes the file', !fs.existsSync(logoFile), logoFile);
  const html2 = (await js(`SamUI.sheet({ title: 'ورقة اختبار' }).outerHTML`)) || '';
  check('the sheet no longer carries the logo', html2.indexOf('co-logo') < 0, html2.indexOf('co-logo'));
  check('the sheet still carries the name of the company', html2.indexOf(COMPANY_NAME) >= 0, html2.indexOf(COMPANY_NAME));
  check('the sheet still keeps the program in the footer', html2.indexOf('SAM Management System') >= 0 && html2.indexOf('SAM 775158678') >= 0, true);

  const errs = (await js(`window.__errs || []`)) || [];
  check('the page raised no error', errs.length === 0, errs);
}

/* ================= run ================= */
app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  logLine('--- harness starting ---');
  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

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

  logLine('\nCONSOLE ERRORS: ' + errors.length);
  errors.forEach((e) => logLine('  ' + e));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
