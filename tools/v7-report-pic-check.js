/**
 * tools/v7-report-pic-check.js — «الصورة بجانب اسم الصنف بدل الكود»:
 *   · every report row that shows an item shows the PICTURE beside the
 *     name, and the code is no longer a column of its own
 *   · the name of the item is DARK and BOLD — on the screen and on the paper
 *   · an item WITHOUT a picture shows its name alone: no empty box, no
 *     broken image
 *   · the printed sheet carries the picture beside the name
 *   · the Excel keeps the code (a cell cannot carry the picture) and the
 *     name is marked bold
 * It drives the real main process and the real renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-report-pic-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7pic');
const SHOTS = path.join(ROOT, '.tmp', 'v7picshots');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-report-pic-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

/** a dark ink — the name of the item must not be washed out */
function isDark(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(color || ''));
  if (!m) return false;
  return Number(m[1]) + Number(m[2]) + Number(m[3]) <= 300;
}

async function rmRetry(target) {
  for (let i = 1; i <= 6; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) return true; }
    catch (e) { await sleep(150 * 2 ** (i - 1)); }
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
  await rmRetry(DATA);
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

/* today — the daily report shows one day, so the movement is today */
const NOW = new Date();
const pad = (n) => String(n).padStart(2, '0');
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;

const NAME_PIC = 'صنف بصورة';
const NAME_PLAIN = 'صنف بلا صورة';

/** a real little PNG — the picture of the item must really load */
function tinyPng() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (img && !img.isEmpty()) return img.toPNG();
  } catch (e) { /* the raw bytes are a valid PNG as well */ }
  return Buffer.from(b64, 'base64');
}

/** the picture of an item — written on the disk, exactly like the app does */
function givePicture(item) {
  const name = `item-${item.id}.png`;
  const dir = path.join(dbMod.dataDir(), 'images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), tinyPng());
  dbMod.updateItem(item.id, {
    code: item.code,
    name: item.name,
    base_unit: item.base_unit,
    category: item.category || '',
    pieces_per_carton: item.pieces_per_carton || 0,
    pieces_per_bag: item.pieces_per_bag || 0,
    unit_label: item.unit_label || '',
    unit_pieces: item.unit_pieces || 0,
    image: name,
    min_good_alert: 0,
    max_defect_alert: 0,
    is_active: true
  });
  return name;
}

async function main() {
  dbMod.close();
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  const wh = dbMod.addWarehouse({ code: 'W1', name: 'مخزن الصورة', location: 'الشمال' });
  const party = dbMod.addParty({ name: 'عميل الصورة', type: 'supplier', phone: '770000009' });

  /* the item WITH a picture and the item WITHOUT one */
  const picItem = dbMod.addItem({ code: 'PIC-1', name: NAME_PIC, base_unit: 'حبة', category: 'منتج' },
    [{ warehouseId: wh.id, good: 10 }]);
  const plainItem = dbMod.addItem({ code: 'PIC-2', name: NAME_PLAIN, base_unit: 'حبة', category: 'منتج' },
    [{ warehouseId: wh.id, good: 5 }]);
  const picFile = givePicture(picItem);

  /* the movement of today — both items move, so both reports show them */
  dbMod.saveDocument({
    kind: 'purchase', doc_date: TODAY, party_id: party.id, warehouse_id: wh.id,
    lines: [
      { item_id: picItem.id, warehouse_id: wh.id, pieces: 40 },
      { item_id: plainItem.id, warehouse_id: wh.id, pieces: 25 }
    ]
  });

  /* ---- the main process and the renderer ---- */
  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] : d.level;
    if (lvl >= 2) logLine('CONSOLE ' + lvl + ': ' + String(d.message || '').slice(0, 300));
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  /** a picture of the screen — so the look can be checked too */
  async function shot(name) {
    await sleep(700);
    /* the window is hidden — the CSS of the screen never plays, so the
       animations are finished before the picture is taken */
    try {
      await win.webContents.executeJavaScript(`(() => {
        try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); } catch (e) {}
        return 1;
      })()`, true);
    } catch (e) { /* a missing shot never breaks the check */ }
    try { win.webContents.invalidate(); } catch (e) {}
    await sleep(200);
    try { await win.webContents.capturePage(); } catch (e) {}
    await sleep(160);
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
    } catch (e) { /* a missing shot never breaks the check */ }
  }

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  /* =====================================================================
     1 — the daily report on the screen
     ===================================================================== */
  /* wait for something to happen — the screen of the app is busy at start */
  const waitFor = async (code, tries = 40, gap = 150) => {
    for (let i = 0; i < tries; i++) {
      const v = await js(code);
      if (v) return v;
      await sleep(gap);
    }
    return null;
  };

  /* the daily screen must really be on the screen — the picture has a size
     only when the view is visible */
  await waitFor(`(() => {
    const v = document.getElementById('v-daily');
    if (v && v.classList.contains('active')) return true;
    const b = document.querySelector('.nav-item[data-view=daily]');
    if (b) b.click();
    return false;
  })()`);
  await sleep(1200);
  /* the picture of the item joins the table when the folder of the pictures
     arrives — wait for it (the report itself is never delayed by it) */
  await waitFor(`(() => {
    const img = document.querySelector('#dailyTbl tbody img.sam-pic');
    if (!img) return false;
    const r = img.getBoundingClientRect();
    return r.width > 0 ? true : false;
  })()`);
  const probe = await js(`(() => {
    const v = document.getElementById('v-daily');
    const st = window.SamDaily && SamDaily.state ? SamDaily.state : null;
    const cs = v ? getComputedStyle(v) : null;
    const anim = v ? v.getAnimations().map(a => a.playState + ':' + a.currentTime) : [];
    return {
      viewClass: v ? v.className : null,
      active: v ? v.classList.contains('active') : null,
      opacity: cs ? cs.opacity : null,
      display: cs ? cs.display : null,
      anim,
      rect: v ? JSON.stringify(v.getBoundingClientRect()) : null,
      children: v ? v.childElementCount : null,
      tbl: !!document.getElementById('dailyTbl'),
      rows: document.querySelectorAll('#dailyTbl tbody tr').length,
      resRows: st && st.res ? (st.res.rows || []).length : -1,
      from: st ? st.from : null,
      to: st ? st.to : null,
      items: st && st.res ? (st.res.rows || []).map(r => r.itemCode + ':' + r.itemName) : []
    };
  })()`);
  logLine('DAILY PROBE :: ' + JSON.stringify(probe));

  const daily = await js(`(() => {
    const rows = [...document.querySelectorAll('#dailyTbl tbody tr')];
    const rowOf = (name) => rows.find(tr => tr.textContent.indexOf(name) >= 0) || null;
    const picRow = rowOf('${NAME_PIC}');
    const plainRow = rowOf('${NAME_PLAIN}');
    const cellOf = (tr) => tr ? tr.querySelector('td.sam-item-cell') : null;
    const picCell = cellOf(picRow);
    const plainCell = cellOf(plainRow);
    const img = picCell ? picCell.querySelector('img.sam-pic') : null;
    const nameEl = picCell ? picCell.querySelector('.sam-item-name') : null;
    const cs = nameEl ? getComputedStyle(nameEl) : null;
    let touch = null;
    if (img && nameEl) {
      const a = img.getBoundingClientRect();
      const b = nameEl.getBoundingClientRect();
      touch = Math.round(Math.abs(a.left - b.right));
    }
    /* an empty box is an element that draws a frame but shows no picture */
    const boxes = plainCell
      ? [...plainCell.querySelectorAll('*')].filter(n => {
          const s = n.getAttribute('style') || '';
          return s.indexOf('border') >= 0 && !n.querySelector('img');
        }).length
      : null;
    return {
      hasPicRow: !!picRow,
      hasPlainRow: !!plainRow,
      img: !!img,
      src: img ? img.getAttribute('src') : '',
      loaded: img ? (img.complete && img.naturalWidth > 0) : false,
      size: img ? Math.round(img.getBoundingClientRect().width) : 0,
      nameText: nameEl ? nameEl.textContent.trim() : '',
      weight: cs ? cs.fontWeight : '',
      color: cs ? cs.color : '',
      touch,
      plainHasImg: plainCell ? !!plainCell.querySelector('img') : null,
      plainText: plainCell ? plainCell.textContent.trim() : '',
      plainBoxes: boxes
    };
  })()`) || {};

  check('the daily table shows the item that has a picture', daily.hasPicRow === true, daily);
  check('the daily table shows the item that has no picture', daily.hasPlainRow === true, daily);
  check('the daily row carries the picture of the item', daily.img === true, daily);
  check('the picture of the daily row is the file of the item',
    String(daily.src || '').indexOf(picFile) >= 0, daily.src);
  check('the picture really loads', daily.loaded === true, daily);
  check('the picture is small', daily.size > 8 && daily.size <= 18, daily.size);
  check('the picture sits right beside the name', daily.touch !== null && daily.touch <= 14, daily.touch);
  check('the name of the item is bold', Number(daily.weight) >= 700, daily.weight);
  check('the name of the item is dark', isDark(daily.color), daily.color);
  check('the name of the item is the name of the item', daily.nameText === NAME_PIC, daily.nameText);
  check('the item without a picture shows no picture at all', daily.plainHasImg === false, daily);
  check('the item without a picture shows no empty box', daily.plainBoxes === 0, daily);
  check('the item without a picture shows its name alone',
    String(daily.plainText || '').indexOf(NAME_PLAIN) >= 0, daily.plainText);

  await shot('01-daily-screen');

  /* ---- the paper of the daily report ---- */
  await js(`(() => { const b = document.getElementById('btnPrintDaily'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(1600);
  await shot('02-daily-print');
  await js(`(() => {
    const b = [...document.querySelectorAll('.pv-bar button')].find(x => x.textContent.indexOf('إغلاق') >= 0);
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(700);

  /* =====================================================================
     2 — the reports centre (the movements report)
     ===================================================================== */
  await js(`SamReports.load()`);
  await sleep(1600);
  await js(`(() => { SamReports.openWindow('movements'); return true; })()`);
  await sleep(2200);
  await waitFor(`(() => {
    const img = document.querySelector('.rw-window #reportTbl tbody img.sam-pic');
    if (!img) return false;
    const r = img.getBoundingClientRect();
    return r.width > 0 ? true : false;
  })()`);

  const mov = await js(`(() => {
    const tbl = document.querySelector('.rw-window #reportTbl');
    if (!tbl) return { err: 'no table' };
    const heads = [...tbl.querySelectorAll('thead th')].map(n => n.textContent.trim());
    const rows = [...tbl.querySelectorAll('tbody tr')];
    const rowOf = (name) => rows.find(tr => tr.textContent.indexOf(name) >= 0) || null;
    const picRow = rowOf('${NAME_PIC}');
    const plainRow = rowOf('${NAME_PLAIN}');
    const cellOf = (tr) => tr ? tr.querySelector('td .sam-item') : null;
    const picCell = cellOf(picRow);
    const plainCell = cellOf(plainRow);
    const img = picCell ? picCell.querySelector('img.sam-pic') : null;
    const nameEl = picCell ? picCell.querySelector('.sam-item-name') : null;
    const cs = nameEl ? getComputedStyle(nameEl) : null;
    let touch = null;
    if (img && nameEl) {
      const a = img.getBoundingClientRect();
      const b = nameEl.getBoundingClientRect();
      touch = Math.round(Math.abs(a.left - b.right));
    }
    const boxes = plainCell
      ? [...plainCell.querySelectorAll('*')].filter(n => {
          const s = n.getAttribute('style') || '';
          return s.indexOf('border') >= 0 && !n.querySelector('img');
        }).length
      : null;
    const res = (window.SamReports && SamReports.state) ? SamReports.state.result : null;
    return {
      heads,
      codeHead: heads.indexOf('كود الصنف') >= 0,
      codeColumn: !!(res && (res.columns || []).some(c => c.key === 'itemCode')),
      img: !!img,
      src: img ? img.getAttribute('src') : '',
      loaded: img ? (img.complete && img.naturalWidth > 0) : false,
      size: img ? Math.round(img.getBoundingClientRect().width) : 0,
      nameText: nameEl ? nameEl.textContent.trim() : '',
      weight: cs ? cs.fontWeight : '',
      color: cs ? cs.color : '',
      touch,
      plainHasImg: plainCell ? !!plainCell.querySelector('img') : null,
      plainText: plainCell ? plainCell.textContent.trim() : '',
      plainBoxes: boxes
    };
  })()`) || {};

  check('the report has no column of the item code', mov.codeHead === false, mov.heads);
  check('the column list of the report has no code of the item', mov.codeColumn === false, mov.heads);
  check('the report row carries the picture of the item', mov.img === true, mov);
  check('the picture of the report row is the file of the item',
    String(mov.src || '').indexOf(picFile) >= 0, mov.src);
  check('the picture of the report row really loads', mov.loaded === true, mov);
  check('the picture of the report row is small', mov.size > 8 && mov.size <= 18, mov.size);
  check('the picture of the report row sits right beside the name',
    mov.touch !== null && mov.touch <= 14, mov.touch);
  check('the name of the item is bold in the report', Number(mov.weight) >= 700, mov.weight);
  check('the name of the item is dark in the report', isDark(mov.color), mov.color);
  check('the item without a picture shows no picture in the report', mov.plainHasImg === false, mov);
  check('the item without a picture shows no empty box in the report', mov.plainBoxes === 0, mov);
  check('the item without a picture shows its name alone in the report',
    String(mov.plainText || '').indexOf(NAME_PLAIN) >= 0, mov.plainText);

  await shot('02-report-window');

  /* =====================================================================
     2b — the ledger of one item: the name of that item, with its picture
     ===================================================================== */
  await js(`(() => {
    try { SamReports.filters.itemId = ${picItem.id}; } catch (e) {}
    SamReports.openWindow('item_ledger');
    return true;
  })()`);
  await sleep(2200);
  const ledger = await js(`(() => {
    const tbl = document.querySelector('.rw-window #reportTbl');
    if (!tbl) return { err: 'no table' };
    const heads = [...tbl.querySelectorAll('thead th')].map(n => n.textContent.trim());
    const rows = [...tbl.querySelectorAll('tbody tr')];
    const row = rows.find(tr => tr.textContent.indexOf('${NAME_PIC}') >= 0) || null;
    const cell = row ? row.querySelector('td .sam-item') : null;
    const img = cell ? cell.querySelector('img.sam-pic') : null;
    const name = cell ? cell.querySelector('.sam-item-name') : null;
    return {
      heads,
      rows: rows.length,
      img: !!img,
      src: img ? img.getAttribute('src') : '',
      name: name ? name.textContent.trim() : '',
      bold: name ? /font-weight:\\s*(800|900|bold)/.test(name.getAttribute('style') || '') : false
    };
  })()`) || {};
  check('the ledger of an item shows the name of the item', ledger.name === NAME_PIC, ledger);
  check('the ledger of an item shows the picture of the item',
    ledger.img === true && String(ledger.src || '').indexOf(picFile) >= 0, ledger);
  check('the name of the item is bold in the ledger', ledger.bold === true, ledger);

  /* back to the movements report for the print */
  await js(`(() => {
    try { SamReports.filters.itemId = null; } catch (e) {}
    SamReports.openWindow('movements');
    return true;
  })()`);
  await sleep(1800);

  /* =====================================================================
     3 — the printed sheet (the paper)
     ===================================================================== */
  const sheets = await js(`(() => {
    const parse = (html) => {
      const host = document.createElement('div');
      host.innerHTML = html || '';
      return [...host.querySelectorAll('.sam-item')].map(cell => {
        const img = cell.querySelector('img.sam-pic');
        const name = cell.querySelector('.sam-item-name');
        return {
          img: !!img,
          src: img ? img.getAttribute('src') : '',
          size: img ? parseInt((img.getAttribute('style') || '').replace(/.*width:(\\d+)px.*/, '$1'), 10) : 0,
          name: name ? name.textContent.trim() : '',
          bold: name ? /font-weight:\\s*(800|900|bold)/.test(name.getAttribute('style') || '') : false
        };
      });
    };
    const r = SamReports.sheetSpec();
    const d = SamDaily.sheetSpec();
    return {
      report: parse(r ? r.bodyHtml : ''),
      daily: parse(d ? d.bodyHtml : ''),
      reportHasCodeHead: r ? (r.bodyHtml.indexOf('كود الصنف') >= 0) : null
    };
  })()`) || {};

  const rPic = (sheets.report || []).find((c) => c.name === NAME_PIC);
  const rPlain = (sheets.report || []).find((c) => c.name === NAME_PLAIN);
  check('the printed report carries the picture beside the name', !!(rPic && rPic.img), sheets.report);
  check('the picture of the printed report is the file of the item',
    !!(rPic && String(rPic.src || '').indexOf(picFile) >= 0), rPic);
  check('the picture of the printed report is small', !!(rPic && rPic.size >= 14 && rPic.size <= 20), rPic);
  check('the name of the item is bold on the printed report', !!(rPic && rPic.bold), rPic);
  check('the printed report has no column of the item code', sheets.reportHasCodeHead === false, sheets.reportHasCodeHead);
  check('the item without a picture shows its name alone on the paper',
    !!(rPlain && !rPlain.img && rPlain.name === NAME_PLAIN), rPlain);

  const dPic = (sheets.daily || []).find((c) => c.name === NAME_PIC);
  const dPlain = (sheets.daily || []).find((c) => c.name === NAME_PLAIN);
  check('the printed daily report carries the picture beside the name', !!(dPic && dPic.img), sheets.daily);
  check('the name of the item is bold on the printed daily report', !!(dPic && dPic.bold), dPic);
  check('the item without a picture shows its name alone on the daily paper',
    !!(dPlain && !dPlain.img && dPlain.name === NAME_PLAIN), dPlain);

  /* =====================================================================
     4 — the Excel: the code stays, the name is marked bold
     ===================================================================== */
  const xl = await js(`(() => {
    const r = SamReports.excelSpec();
    const d = SamDaily.excelSpec();
    const pick = (x) => ({
      heads: (x && x.columns || []).map(c => c.header),
      codeCol: !!(x && (x.columns || []).some(c => c.key === 'itemCode' || c.key === 'code')),
      nameCol: (x && (x.columns || []).find(c => c.key === 'itemName' || c.key === 'name')) || null
    });
    return { report: pick(r), daily: pick(d) };
  })()`) || {};

  check('the Excel of the reports keeps the code of the item', xl.report.codeCol === true, xl.report);
  check('the Excel of the reports marks the name bold',
    !!(xl.report.nameCol && xl.report.nameCol.bold === true), xl.report.nameCol);
  check('the Excel of the daily report keeps the code of the item', xl.daily.codeCol === true, xl.daily);
  check('the Excel of the daily report marks the name bold',
    !!(xl.daily.nameCol && xl.daily.nameCol.bold === true), xl.daily.nameCol);

  /* ---- the look of the paper ---- */
  await js(`(() => {
    const btn = [...document.querySelectorAll('.rw-window .rw-actions button')]
      .find(b => b.textContent.indexOf('طباعة') >= 0);
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  await sleep(1500);
  await shot('03-print-preview');

  await shutdown(fail ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
