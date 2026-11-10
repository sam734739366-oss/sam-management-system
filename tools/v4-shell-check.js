/**
 * tools/v4-shell-check.js — verification of the V4 shell:
 *   · the title bar carries the update button and the help button
 *   · the guide window opens, lists its topics, shows the document table
 *     and closes again
 *   · the update window opens with its four actions, reads its state from
 *     the main process and closes again
 *   · the settings tab "مجلد البيانات والسحابة" shows the live folder and
 *     the detected cloud clients
 *   · every input label carries its icon, and no input starts with a value
 * Writes .tmp/v4shell/*.png and prints PASS/FAIL for every check.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v4-shell-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v4shell');
const DATA = path.join(ROOT, '.tmp', 'v4shelldata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
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
process.on('unhandledRejection', (e) => { console.log('UNHANDLESS: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'updater.js')).init(() => win);

async function shot(name, settle = 700) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.capturePage();
    await win.webContents.executeJavaScript(`(() => { try { document.getAnimations().forEach(a => a.cancel()); } catch (e) {} return 1; })()`, true);
  } catch (e) { /* navigating */ }
  await sleep(60);
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

  /* ---------------- seed ---------------- */
  const whA = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });
  dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5000 }]);

  /* ---------------- window ---------------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); console.log('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);

  /* ================= 1. the title bar ================= */
  const bar = await js(`(() => ({
    help: !!document.getElementById('btnHelp'),
    update: !!document.getElementById('btnUpdate'),
    ver: (document.getElementById('tbVer')||{}).textContent,
    helpIcon: (document.querySelector('#btnHelp use')||{}).getAttribute ? document.querySelector('#btnHelp use').getAttribute('href') : null,
    updateIcon: (document.querySelector('#btnUpdate use')||{}).getAttribute ? document.querySelector('#btnUpdate use').getAttribute('href') : null
  }))()`);
  check('the title bar carries the help button', bar && bar.help === true, bar);
  check('the title bar carries the update button', bar && bar.update === true, bar);
  check('both buttons carry an icon', bar && bar.helpIcon === '#i-help' && bar.updateIcon === '#i-update', bar);
  check('the version badge reads v0.4.0', bar && bar.ver === 'v0.4.0', bar && bar.ver);

  /* the title-bar buttons must stay INSIDE the bar — a CSS class collision
     with the global `.busy` loading pill used to float them under the title */
  const place = await js(`(() => {
    const r = (n) => { const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const out = {};
    ['btnUpdate','btnHelp'].forEach((id) => {
      const n = document.getElementById(id);
      if (!n) { out[id] = null; return; }
      out[id] = {
        inBar: !!n.closest('#titlebar'),
        pos: getComputedStyle(n).position,
        rect: r(n),
        cls: n.className
      };
    });
    const tb = document.getElementById('titlebar');
    out.bar = tb ? r(tb) : null;
    return out;
  })()`);
  check('the title-bar buttons live inside the title bar',
    place && place.btnUpdate && place.btnUpdate.inBar && place.btnHelp && place.btnHelp.inBar, place);
  check('the title-bar buttons are not floating (no .busy collision)',
    place && place.btnUpdate && place.btnUpdate.pos !== 'fixed' && place.btnHelp && place.btnHelp.pos !== 'fixed', place);
  check('the title-bar buttons sit within the bar',
    place && place.bar && place.btnUpdate &&
    place.btnUpdate.rect.y + place.btnUpdate.rect.h <= place.bar.y + place.bar.h + 1 &&
    place.btnHelp.rect.y + place.btnHelp.rect.h <= place.bar.y + place.bar.h + 1, place);

  /* the sprite carries every icon the program asks for */
  const sprite = await js(`(() => {
    const ids = [...document.querySelectorAll('symbol')].map(s => s.id);
    const wanted = ['i-download','i-lock','i-info','i-mail','i-help','i-update','i-folder','i-cloud'];
    return { missing: wanted.filter(w => ids.indexOf(w) === -1), total: ids.length };
  })()`);
  check('every new icon exists in the sprite', sprite && sprite.missing.length === 0, sprite);

  /* ================= 2. the guide ================= */
  await js(`document.getElementById('btnHelp').click(); 1`);
  await sleep(700);
  const guide = await js(`(() => {
    const w = document.querySelector('.guide-window');
    if (!w) return null;
    const rail = [...w.querySelectorAll('.guide-item-btn')];
    return {
      title: (w.querySelector('.gt-txt h3')||{}).textContent,
      topics: rail.map(b => (b.querySelector('span:last-child')||{}).textContent),
      icons: rail.map(b => { const u = b.querySelector('use'); return u ? u.getAttribute('href') : null; }),
      active: rail.filter(b => b.classList.contains('on')).length,
      head: (w.querySelector('.gh-txt b')||{}).textContent,
      bullets: w.querySelectorAll('.guide-item').length,
      rows: w.querySelectorAll('.guide-tbl tbody tr').length,
      chips: [...w.querySelectorAll('.guide-tbl tbody .chip')].map(c => c.textContent.trim())
    };
  })()`);
  check('the guide window opens', guide !== null, guide && guide.title);
  check('the guide is titled «دليل الاستخدام»', guide && guide.title === 'دليل الاستخدام', guide && guide.title);
  check('the guide lists its seven topics', guide && guide.topics.length === 7, guide && guide.topics);
  check('every topic carries an icon', guide && guide.icons.every((i) => !!i && i.charAt(0) === '#'), guide && guide.icons);
  check('exactly one topic is active', guide && guide.active === 1, guide && guide.active);
  check('the first page shows the quick start', guide && guide.head === 'البداية السريعة', guide && guide.head);
  check('the quick start explains the three steps', guide && guide.bullets === 3, guide && guide.bullets);
  await shot('01-guide-start');

  /* the document table */
  await js(`(() => {
    const b = [...document.querySelectorAll('.guide-item-btn')].find(x => x.textContent.indexOf('المستندات') === 0);
    if (b) b.click();
    return b ? 'ok' : 'no-topic';
  })()`);
  await sleep(400);
  const guideDocs = await js(`(() => {
    const w = document.querySelector('.guide-window');
    return {
      head: (w.querySelector('.gh-txt b')||{}).textContent,
      rows: w.querySelectorAll('.guide-tbl tbody tr').length,
      names: [...w.querySelectorAll('.guide-tbl tbody .gt-name')].map(n => n.textContent.trim()),
      chips: [...w.querySelectorAll('.guide-tbl tbody .chip')].map(c => c.textContent.trim())
    };
  })()`);
  check('the documents page opens', guideDocs && guideDocs.head === 'المستندات وأثرها على المخزون', guideDocs && guideDocs.head);
  check('the documents page lists the nine kinds', guideDocs && guideDocs.rows === 9, guideDocs && guideDocs.rows);
  check('every kind shows its effect on the stock',
    guideDocs && guideDocs.chips.length === 9 && guideDocs.chips.every((c) => c.length > 0), guideDocs && guideDocs.chips);
  check('the effects are named in Arabic only',
    guideDocs && guideDocs.chips.every((c) => !/[A-Za-z]{3,}/.test(c)), guideDocs && guideDocs.chips);
  await shot('02-guide-documents');

  /* no English leaked into the guide */
  const english = await js(`(() => {
    const w = document.querySelector('.guide-window');
    const txt = w ? w.textContent : '';
    const words = (txt.match(/[A-Za-z]{4,}/g) || []).filter(x => ['Cairo','Tajawal'].indexOf(x) === -1);
    return [...new Set(words)];
  })()`);
  check('no English word leaked into the guide', english && english.length === 0, english);

  /* the guide closes */
  await js(`document.querySelector('.guide-x').click(); 1`);
  await sleep(400);
  const guideClosed = await js(`document.querySelectorAll('.guide-window').length`);
  check('the guide closes', guideClosed === 0, guideClosed);

  /* ================= 3. the update window ================= */
  await js(`document.getElementById('btnUpdate').click(); 1`);
  await sleep(1200);
  const upd = await js(`(() => {
    const w = document.querySelector('.updwin-window');
    if (!w) return null;
    return {
      title: (w.querySelector('.uw-txt h3')||{}).textContent,
      badge: (w.querySelector('.uw-status .badge')||{}).textContent,
      buttons: [...w.querySelectorAll('.updwin-foot .btn')].map(b => b.textContent.trim()),
      bar: !!w.querySelector('.upd-track .upd-fill'),
      percent: (w.querySelector('#uwPercent')||{}).textContent,
      info: [...w.querySelectorAll('.updwin-body .info dt')].map(d => d.textContent.trim())
    };
  })()`);
  check('the update window opens', upd !== null, upd && upd.title);
  check('the update window is titled «تحديث البرنامج»', upd && upd.title === 'تحديث البرنامج', upd && upd.title);
  check('the update window shows a status', upd && !!upd.badge, upd && upd.badge);
  check('the update window carries the progress bar', upd && upd.bar === true, upd && upd.bar);
  check('the update window offers the four actions',
    upd && upd.buttons.length === 4 && upd.buttons[0].indexOf('فحص') === 0 && upd.buttons[3].indexOf('معاينة') === 0, upd && upd.buttons);
  check('the update window shows the current version',
    upd && upd.info.indexOf('الإصدار الحالي') === 0, upd && upd.info);
  await shot('03-update-window');

  /* the simulate action moves the bar — the window is really wired */
  await js(`(() => {
    const b = [...document.querySelectorAll('.updwin-foot .btn')].find(x => x.textContent.indexOf('معاينة') === 0);
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(900);
  const moved = await js(`(() => {
    const w = document.querySelector('.updwin-window');
    return {
      percent: (w.querySelector('#uwPercent')||{}).textContent,
      width: (w.querySelector('#uwFill')||{}).style ? w.querySelector('#uwFill').style.width : ''
    };
  })()`);
  check('the progress bar really moves', moved && parseFloat(moved.percent) > 0, moved);

  await js(`document.querySelector('.updwin-x').click(); 1`);
  await sleep(400);
  const updClosed = await js(`document.querySelectorAll('.updwin-window').length`);
  check('the update window closes', updClosed === 0, updClosed);

  /* the update button wears the state */
  const busy = await js(`(() => {
    const b = document.getElementById('btnUpdate');
    return { cls: b.className, title: b.title };
  })()`);
  check('the update button carries a title', busy && !!busy.title, busy);

  /* ================= 4. the settings tab ================= */
  await js(`document.querySelector('.nav-item[data-view=settings]').click(); 1`);
  await sleep(900);
  const tabs = await js(`(() => ({
    tabs: [...document.querySelectorAll('#settingsTabs .tab')].map(t => t.textContent.trim()),
    hasData: !!document.getElementById('set-data'),
    hasFolder: !!document.getElementById('btnPickDataDir'),
    hasCloud: !!document.getElementById('btnCloudSync'),
    hasEmail: !!document.getElementById('cloudEmail')
  }))()`);
  check('the settings carry the data tab', tabs && tabs.hasData === true, tabs && tabs.tabs);
  check('the data tab holds the folder picker', tabs && tabs.hasFolder === true, tabs);
  check('the data tab holds the cloud sync', tabs && tabs.hasCloud === true && tabs.hasEmail === true, tabs);

  await js(`(() => {
    const b = [...document.querySelectorAll('#settingsTabs .tab')].find(t => t.dataset.tab === 'data');
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(1400);
  const dataTab = await js(`(() => {
    const dds = [...document.querySelectorAll('#ddInfo dt')].map(d => d.textContent.trim());
    const ddv = [...document.querySelectorAll('#ddInfo dd')].map(d => d.textContent.trim());
    const cld = [...document.querySelectorAll('#cloudInfo dt')].map(d => d.textContent.trim());
    const clv = [...document.querySelectorAll('#cloudInfo dd')].map(d => d.textContent.trim());
    return {
      ddKeys: dds, ddValues: ddv, clKeys: cld, clValues: clv,
      email: (document.getElementById('cloudEmail')||{}).value,
      clients: [...document.querySelectorAll('#cloudClients .col-check')].map(b => b.textContent.trim()),
      install: !!document.querySelector('#cloudClients .btn'),
      visible: !document.getElementById('set-data').classList.contains('hidden')
    };
  })()`);
  check('the data tab is visible', dataTab && dataTab.visible === true, dataTab && dataTab.visible);
  check('the folder card shows the live folder', dataTab && dataTab.ddKeys.indexOf('مجلد البيانات') === 0 && dataTab.ddValues[0].length > 3, dataTab && dataTab.ddValues);
  check('the folder card shows the database size', dataTab && dataTab.ddKeys.indexOf('حجم قاعدة البيانات') > 0, dataTab && dataTab.ddKeys);
  check('the cloud card shows the e-mail field empty by default', dataTab && (dataTab.email === '' || dataTab.email === undefined), dataTab && dataTab.email);
  check('the cloud card lists the detected clients or the download button',
    dataTab && (dataTab.clients.length > 0 || dataTab.install === true), dataTab && { clients: dataTab.clients, install: dataTab.install });
  await shot('04-settings-data');

  /* ================= 5. the field icons ================= */
  await js(`document.querySelector('.nav-item[data-view=items]').click(); 1`);
  await sleep(900);
  await js(`window.SamItems.openForm(null); 1`);
  await sleep(900);
  const fields = await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return null;
    const labels = [...m.querySelectorAll('.field-label')];
    const pairs = [...m.querySelectorAll('.field')].map(f => {
      const t = f.querySelector('.field-txt');
      const i = f.querySelector('input, textarea, select');
      return { label: t ? t.textContent.trim() : '', value: i ? i.value : '' };
    });
    return {
      total: labels.length,
      withIcon: labels.filter(l => l.querySelector('.field-ic use')).length,
      icons: labels.map(l => { const u = l.querySelector('.field-ic use'); return u ? u.getAttribute('href') : null; }),
      pairs: pairs,
      values: [...m.querySelectorAll('input, textarea')].map(i => i.value)
    };
  })()`);
  check('the item form labels every field with an icon',
    fields && fields.total > 0 && fields.withIcon === fields.total, fields && { total: fields.total, withIcon: fields.withIcon });
  /* the only box that may carry a value is the base unit — the piece is the
     base truth of the program, so it is the one default that stays */
  const filled = fields && fields.pairs.filter((p) => p.value !== '');
  check('no input in the item form starts with a value except the base unit',
    filled && filled.length === 1 && filled[0].label === 'الوحدة الأساسية' && filled[0].value === 'حبة', filled);
  check('the code and the name start empty',
    fields && fields.pairs.filter((p) => p.label === 'كود الصنف' || p.label === 'اسم الصنف')
      .every((p) => p.value === ''), fields && fields.pairs);
  await shot('05-item-form');

  /* the document editor labels too */
  await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (m) { const b = [...m.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.indexOf('إلغاء') >= 0 || x.textContent.indexOf('إغلاق') >= 0); if (b) b.click(); }
    return 'ok';
  })()`);
  await sleep(600);
  await js(`document.querySelector('.nav-item[data-view=transactions]').click(); 1`);
  await sleep(800);
  await js(`SamDocs.openEditor(null); 1`);
  await sleep(1000);
  const edFields = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    if (!ed) return null;
    const labels = [...ed.querySelectorAll('.ed-label')];
    return {
      total: labels.length,
      withIcon: labels.filter(l => l.querySelector('.field-ic use')).length,
      names: labels.map(l => l.textContent.trim())
    };
  })()`);
  check('the document editor labels every field with an icon',
    edFields && edFields.total > 0 && edFields.withIcon === edFields.total, edFields && { total: edFields.total, withIcon: edFields.withIcon });
  check('the editor labels keep their Arabic names',
    edFields && edFields.names.every((n) => !/[A-Za-z]{3,}/.test(n)), edFields && edFields.names);
  await shot('06-editor-labels');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (errors.length) {
    console.log('\nrenderer errors:');
    errors.forEach((e) => console.log('  ' + e));
  }
  shutdown(fail || errors.length ? 1 : 0);
});
