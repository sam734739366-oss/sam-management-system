/**
 * tools/v7-items-check.js — the items screen (V7):
 *   · the editor carries the unit of its OWN («اسم الوحدة» + «عدد الحبات فيها»)
 *     beside the carton and the bag, and it shows a LIVE preview of the packs
 *   · the editor carries the picture of the item, and the picture is really
 *     written into the data folder when the item is saved
 *   · saving keeps unit_label / unit_pieces / image (read back with getItem)
 *   · the item in the list shows its tiny picture BESIDE its name
 *   · the smart search shows the picture and the packs of the item
 * It drives the REAL main process and the REAL renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-items-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7items');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const SHOTS = path.join(ROOT, '.tmp', 'v7items-shots');

let pass = 0, fail = 0;
/* On this host the Electron console is not captured by the shell pipe, so
   every line is written to a log file as well. */
const LOG = path.join(ROOT, '.tmp', 'v7-items-check.log');
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
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');
/* a watchdog: the check must never hang */
setTimeout(() => { logLine('FAIL  the harness timed out'); shutdown(1); }, 180000).unref?.();
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
logLine('--- ipc modules loaded ---');

/* a 1×1 PNG — the smallest picture that can be a real picture */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B64 = PNG_DATA_URL.split(',')[1];

app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* a warehouse, so the editor has an opening balance to write */
  const wh = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: 'الطرف الشرقي' });

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  /* a picture of the screen, so the eye can judge the look too */
  const shot = async (name, settle = 600) => {
    await sleep(settle);
    try {
      await win.webContents.executeJavaScript(`(() => {
        try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); } catch (e) {}
        return 1;
      })()`, true);
    } catch (e) { /* navigating */ }
    try { await win.webContents.capturePage(); } catch (e) {}
    await sleep(150);
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
      logLine('shot -> ' + name);
    } catch (e) { logLine('shot failed: ' + e.message); }
  };

  /* ---------------- login + the items screen ---------------- */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(3000);
  await js(`document.querySelector('.nav-item[data-view=items]').click(); 1`);
  /* the screen opens with a small transition — wait until it is really there */
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const seen = await js(`(() => {
      const v = document.querySelector('#v-items');
      return !!(v && getComputedStyle(v).display !== 'none');
    })()`);
    if (seen === true) break;
    await js(`(() => {
      const b = document.querySelector('.nav-item[data-view=items]');
      if (b) b.click();
      return 1;
    })()`);
  }

  const onItems = await js(`(() => {
    const v = document.querySelector('#v-items');
    return { visible: !!v && getComputedStyle(v).display !== 'none', rows: document.querySelectorAll('#itemsTbl tbody tr').length };
  })()`);
  check('the items screen is open', !!onItems && onItems.visible, onItems);

  /* ================= 1. the editor: the unit of its own + the picture ================= */
  await js(`SamItems.openForm(null); 1`);
  await sleep(1000);

  const fields = await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return null;
    const labels = [...m.querySelectorAll('.field-label .field-txt')].map(x => x.textContent.trim());
    return {
      labels,
      unitLabel: !!m.querySelector('#fUnitLabel'),
      unitPieces: !!m.querySelector('#fUnitPieces'),
      picFile: !!m.querySelector('#fItemImage'),
      picPick: !!m.querySelector('#fItemImagePick'),
      picClear: !!m.querySelector('#fItemImageClear'),
      picPreview: !!m.querySelector('#fItemImagePreview'),
      preview: !!m.querySelector('#fPackPreview')
    };
  })()`);
  check('the editor has the field «اسم الوحدة»', !!fields && fields.labels.includes('اسم الوحدة'), fields && fields.labels);
  check('the editor has the field «عدد الحبات فيها»', !!fields && fields.labels.includes('عدد الحبات فيها'), fields && fields.labels);
  check('the editor has the field «صورة الصنف»', !!fields && fields.labels.includes('صورة الصنف'), fields && fields.labels);
  check('the unit of its own is written into the two boxes', !!fields && fields.unitLabel && fields.unitPieces, fields);
  check('the picture field has a file input and its two buttons', !!fields && fields.picFile && fields.picPick && fields.picClear, fields);
  check('the editor has a preview for the picture', !!fields && fields.picPreview, fields);
  check('the editor has a preview for the packs', !!fields && fields.preview, fields);
  await shot('01-editor-empty');

  /* fill the form: the carton, the bag and the unit of its own */
  const setByLabel = async (label, value) => js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    const f = [...m.querySelectorAll('.field')].find(x => {
      const t = x.querySelector('.field-txt');
      return t && t.textContent.trim() === ${JSON.stringify(label)};
    });
    if (!f) return 'no-field';
    const i = f.querySelector('input');
    if (!i) return 'no-input';
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('blur', { bubbles: true }));
    return 'ok';
  })()`);
  await setByLabel('كود الصنف', '9001');
  await setByLabel('اسم الصنف', 'صنف اختبار الصورة');
  await setByLabel('الوحدة الأساسية', 'حبة');
  await setByLabel('عدد الوحدات لكل كرتونة', '50');
  await setByLabel('عدد الوحدات لكل كيس', '24');
  await setByLabel('اسم الوحدة', 'صندوق');
  await setByLabel('عدد الحبات فيها', '6');
  await sleep(400);

  const prev = await js(`(() => {
    const p = document.getElementById('fPackPreview');
    return p ? p.textContent.replace(/\\s+/g, ' ').trim() : null;
  })()`);
  check('the preview shows what one pack holds', !!prev && /صندوق واحد = 6/.test(prev), prev);
  check('the preview shows the example of the incomplete pack', !!prev && /12 كيس \+ 12 حبة/.test(prev), prev);

  /* the picture: a real file goes through the real file input */
  const chosen = await js(`(async () => {
    const b64 = ${JSON.stringify(PNG_B64)};
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'pic.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const inp = document.getElementById('fItemImage');
    if (!inp) return 'no-input';
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const pv = document.getElementById('fItemImagePreview');
    return { src: (pv && pv.getAttribute('src') || '').slice(0, 30), shown: pv ? getComputedStyle(pv).display : 'none' };
  })()`);
  check('the chosen picture shows in the small preview', !!chosen && chosen.shown !== 'none' && /data:image\/png/.test(chosen.src), chosen);
  await shot('02-editor-filled');

  /* an opening balance, so the stock is not zero */
  const bal = await js(`(() => {
    const cells = [...document.querySelectorAll('.overlay .modal .bal-in[data-bucket=good]')];
    if (!cells.length) return 'no-cells';
    cells[0].value = '300';
    cells[0].dispatchEvent(new Event('input', { bubbles: true }));
    cells[0].dispatchEvent(new Event('blur', { bubbles: true }));
    return cells.length;
  })()`);
  check('the opening balance can be written', bal !== 'no-cells', bal);

  /* ================= 2. save + read back ================= */
  await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    const b = m.querySelector('.modal-foot .btn-primary');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(2200);

  const back = await js(`(async () => {
    const list = await SamDB.call('listItems', '');
    const row = list.find(x => x.code === '9001');
    if (!row) return null;
    const item = await SamDB.call('getItem', row.id);
    return {
      id: item.id,
      unit_label: item.unit_label,
      unit_pieces: item.unit_pieces,
      image: item.image,
      pieces_per_carton: item.pieces_per_carton,
      pieces_per_bag: item.pieces_per_bag,
      good: item.mainStock && item.mainStock.good
    };
  })()`);
  check('the item was saved', !!back, back);
  check('the unit of its own is kept in the database', !!back && back.unit_label === 'صندوق' && Number(back.unit_pieces) === 6, back);
  check('the carton and the bag are kept in the database', !!back && Number(back.pieces_per_carton) === 50 && Number(back.pieces_per_bag) === 24, back);
  check('the picture is kept on the item', !!back && !!back.image, back && back.image);
  check('the picture file is really in the data folder', !!back && back.image && fs.existsSync(path.join(DATA, 'images', back.image)), back && back.image);

  /* ================= 3. the list: the picture beside the name ================= */
  const row = await js(`(() => {
    const tr = [...document.querySelectorAll('#itemsTbl tbody tr')].find(r => r.textContent.includes('9001'));
    if (!tr) return null;
    const img = tr.querySelector('img.sam-pic');
    const td = img ? img.closest('td') : tr.children[2];
    return {
      hasImg: !!img,
      src: img ? img.getAttribute('src') : '',
      width: img ? img.style.width : '',
      nameBeside: td ? td.textContent.includes('صنف اختبار الصورة') : false,
      cell: td ? td.textContent.replace(/\\s+/g, ' ').trim() : ''
    };
  })()`);
  check('the item in the list shows its picture', !!row && row.hasImg, row);
  check('the picture sits right beside the name', !!row && row.nameBeside, row && row.cell);
  check('the picture of the list is a small one (30px)', !!row && row.width === '30px', row && row.width);
  check('the list shows the packs of the item', !!row && /صندوق 6/.test(row.cell) && /كيس 24/.test(row.cell), row && row.cell);

  const noPic = await js(`(() => {
    const tr = [...document.querySelectorAll('#itemsTbl tbody tr')].find(r => !r.querySelector('img.sam-pic'));
    if (!tr) return null;
    return { text: tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40), imgs: tr.querySelectorAll('img').length };
  })()`);
  check('an item without a picture shows NO empty box', !noPic || noPic.imgs === 0, noPic);
  await shot('03-list');

  /* ================= 4. the smart search: the picture + the packs ================= */
  await js(`document.getElementById('btnSmartSearch').click(); 1`);
  await sleep(1100);
  const found = await js(`(async () => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return null;
    const combo = m.querySelector('.combo');
    if (!combo) return 'no-combo';
    const inp = combo.querySelector('.combo-input');
    inp.focus();
    inp.value = '9001';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    if (!pop) return 'no-pop';
    const opts = [...pop.querySelectorAll('.combo-opt')];
    const opt = opts.find(o => o.textContent.includes('9001')) || opts[0];
    if (!opt) return 'no-opt';
    const pack = opt.querySelector('.sam-pack');
    return {
      count: opts.length,
      pic: !!opt.querySelector('img.sam-pic'),
      pack: pack ? pack.textContent : '',
      text: opt.textContent.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  check('the smart search finds the item', !!found && typeof found === 'object', found);
  check('the smart search shows the picture beside the name', !!found && found.pic, found);
  check('the smart search shows the packs of the item', !!found && /صندوق 6/.test(found.pack) && /كيس 24/.test(found.pack), found && found.pack);
  await shot('04-smart-search');

  const picked = await js(`(async () => {
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    const opt = pop && pop.querySelector('.combo-opt');
    if (!opt) return 'no-opt';
    opt.click();
    await new Promise(r => setTimeout(r, 900));
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    const out = m.querySelector('.combo-result');
    if (!out) return 'no-out';
    return { text: out.textContent.replace(/\\s+/g, ' ').trim(), pic: !!out.querySelector('img.sam-pic') };
  })()`);
  check('the smart search shows the picture of the picked item', !!picked && picked.pic, picked);
  check('the smart search writes the balance in the packs', !!picked && /12 كيس \+ 12 حبة/.test(picked.text), picked && picked.text);
  check('the smart search shows the packs of the item', !!picked && /صندوق 6/.test(picked.text), picked && picked.text);

  await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    const b = [...m.querySelectorAll('.modal-foot .btn')].pop();
    if (b) b.click();
    return 'closed';
  })()`);
  await sleep(600);

  /* ================= 5. the printed card of the item ================= */
  const printed = await js(`(async () => {
    const list = await SamDB.call('listItems', '9001');
    const it = list[0];
    if (!it) return 'no-item';
    /* the card is printed from the view of the item (a double click opens it) */
    const row = [...document.querySelectorAll('#itemsTbl tbody tr')].find(r => r.textContent.includes('9001'));
    if (!row) return 'no-row';
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1400));
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return 'no-modal';
    const print = [...m.querySelectorAll('.modal-foot .btn')].find(b => /طباعة/.test(b.textContent));
    if (!print) return 'no-print-btn';
    print.click();
    await new Promise(r => setTimeout(r, 1400));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return 'no-preview';
    const img = pv.querySelector('img.sam-pic');
    const text = pv.textContent.replace(/\\s+/g, ' ').trim();
    return { pic: !!img, src: img ? img.getAttribute('src') : '', packs: /صندوق 6/.test(text) };
  })()`);
  check('the printed card of the item carries its picture', !!printed && printed.pic, printed);
  check('the printed card of the item carries its packs', !!printed && printed.packs, printed);
  await shot('05-printed-card');
  await js(`(() => {
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (pv) { const b = pv.querySelectorAll('.pv-bar .btn-ghost')[1]; if (b) b.click(); }
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (m) { const b = [...m.querySelectorAll('.modal-foot .btn')].pop(); if (b) b.click(); }
    return 'closed';
  })()`);
  await sleep(600);

  /* ================= 6. taking the picture away ================= */
  await js(`(async () => {
    const list = await SamDB.call('listItems', '9001');
    const it = list[0];
    SamItems.openForm(it);
    return it ? it.id : 0;
  })()`);
  await sleep(1200);
  const before = await js(`(() => {
    const pv = document.getElementById('fItemImagePreview');
    return { shown: pv ? getComputedStyle(pv).display : 'none', src: pv ? (pv.getAttribute('src') || '') : '' };
  })()`);
  check('the editor shows the picture of the item it edits', !!before && before.shown !== 'none' && /item-/.test(before.src), before);

  /* a plain edit (nothing touched) must NOT lose the picture */
  await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    const b = m.querySelector('.modal-foot .btn-primary');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(2200);
  const kept = await js(`(async () => {
    const list = await SamDB.call('listItems', '9001');
    const row = list[0];
    if (!row) return null;
    const item = await SamDB.call('getItem', row.id);
    return { image: item.image, unit_label: item.unit_label, unit_pieces: item.unit_pieces };
  })()`);
  check('an edit that touches nothing keeps the picture', !!kept && !!kept.image, kept);

  /* and now the picture is taken away */
  await js(`(async () => {
    const list = await SamDB.call('listItems', '9001');
    SamItems.openForm(list[0]);
    return 1;
  })()`);
  await sleep(1200);
  await js(`(() => {
    const b = document.getElementById('fItemImageClear');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(300);
  const cleared = await js(`(() => {
    const pv = document.getElementById('fItemImagePreview');
    return { shown: pv ? getComputedStyle(pv).display : 'none' };
  })()`);
  check('the button takes the picture away from the preview', !!cleared && cleared.shown === 'none', cleared);

  await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    const b = m.querySelector('.modal-foot .btn-primary');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(2200);

  const gone = await js(`(async () => {
    const list = await SamDB.call('listItems', '9001');
    const row = list[0];
    if (!row) return null;
    const item = await SamDB.call('getItem', row.id);
    return { image: item.image, unit_label: item.unit_label, unit_pieces: item.unit_pieces };
  })()`);
  check('the picture is gone from the item', !!gone && !gone.image, gone);
  check('the unit of its own survives the edit', !!gone && gone.unit_label === 'صندوق' && Number(gone.unit_pieces) === 6, gone);

  const rowAfter = await js(`(() => {
    const tr = [...document.querySelectorAll('#itemsTbl tbody tr')].find(r => r.textContent.includes('9001'));
    if (!tr) return null;
    return { imgs: tr.querySelectorAll('img.sam-pic').length, cell: tr.children[2].textContent.replace(/\\s+/g, ' ').trim() };
  })()`);
  check('the list shows NO picture for the item without one', !!rowAfter && rowAfter.imgs === 0, rowAfter);
  check('the list still shows the packs of the item', !!rowAfter && /صندوق 6/.test(rowAfter.cell), rowAfter && rowAfter.cell);

  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => {
  logLine('FATAL: ' + (e && e.stack ? e.stack : e));
  shutdown(1);
});
