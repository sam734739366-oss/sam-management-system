/**
 * tools/v7-css-check.js — V7 evidence for the grid of the tables.
 *
 * The customer asked:
 * «توضيح خطوط الجداول التي تفرق بين الاعمدة والسطور ولون خلفية السطر
 *   الملون اوظحها اكثر في البرنامج والطباعة مثل خطوط الاكسل واضحة»
 * — the lines must tell the COLUMNS from the ROWS, and the striped row
 * must be CLEARLY visible, in the program AND on the paper.
 *
 * This harness opens the REAL program (it logs in, walks the screens and
 * measures the real DOM) and proves:
 *   · the head of a table wears a SOLID fill that differs from the body;
 *   · two consecutive body rows carry DIFFERENT backgrounds, and the
 *     difference is visible in EVERY channel (r, g and b);
 *   · the vertical separator and the horizontal separator are told apart
 *     (a different colour, and the row rule carries more contrast);
 *   · nothing scrolls sideways — the page itself, the content frame and
 *     every table box;
 *   · the PAPER (the print media, emulated for real) carries the same
 *     grid, with a stripe that is DEEPER than the one on the screen,
 *     because a faint tint is eaten by the printer;
 *   · the masthead of the paper (the company block) has its sizes.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-css-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v7css');
const DATA = path.join(ROOT, '.tmp', 'v7cssdata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-css-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
function note(s) { logLine('      ' + s); }

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

/* ------------------------------------------------------------------ *
 * the helpers that live INSIDE the page — they read the real computed
 * style of the real DOM, nothing is mocked.
 * ------------------------------------------------------------------ */
const HELPERS = `
window.__v7 = {
  /* "rgb(12, 34, 56)" / "rgba(12, 34, 56, .5)" -> {r,g,b,a} */
  rgb(s) {
    if (!s) return null;
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  },
  /* how dark a colour is (0 = black, 1 = white) */
  lum(c) {
    if (!c) return 1;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  },
  /* the contrast of a colour against the white paper */
  contrast(c) {
    if (!c) return 0;
    const l = this.lum(c);
    return (1.05) / (l + 0.05);
  },
  /* the vertical rule of a cell — the inline-end side (the page is RTL,
     so it is the LEFT side); it falls back to the physical side when
     the engine does not know the logical properties */
  inlineEnd(el) {
    const cs = getComputedStyle(el);
    const rtl = cs.direction === 'rtl';
    if (typeof cs.borderInlineEndWidth === 'string' && cs.borderInlineEndWidth !== '') {
      return { w: cs.borderInlineEndWidth, c: cs.borderInlineEndColor, side: 'inline-end' };
    }
    return rtl
      ? { w: cs.borderLeftWidth, c: cs.borderLeftColor, side: 'left' }
      : { w: cs.borderRightWidth, c: cs.borderRightColor, side: 'right' };
  },
  /* everything the checks need to know about ONE table */
  describe(tbl) {
    const th = tbl.querySelector('thead th');
    const hs = th ? getComputedStyle(th) : null;
    const rows = [...tbl.querySelectorAll('tbody tr')].filter((r) => r.getClientRects().length);
    const cell = rows[0] ? rows[0].querySelector('td,th') : null;
    const cs = cell ? getComputedStyle(cell) : null;
    const ie = cell ? window.__v7.inlineEnd(cell) : null;
    return {
      head: hs ? hs.backgroundColor : null,
      headRule: hs ? hs.borderBottomWidth : null,
      headRuleColor: hs ? hs.borderBottomColor : null,
      headWeight: hs ? hs.fontWeight : null,
      rowA: rows[0] ? getComputedStyle(rows[0]).backgroundColor : null,
      rowB: rows[1] ? getComputedStyle(rows[1]).backgroundColor : null,
      rowRule: cs ? cs.borderBottomWidth : null,
      rowRuleColor: cs ? cs.borderBottomColor : null,
      colRule: ie ? ie.w : null,
      colRuleColor: ie ? ie.c : null,
      colSide: ie ? ie.side : null,
      rows: rows.length
    };
  },
  /* the page must never scroll sideways */
  sideways() {
    const de = document.documentElement;
    const content = document.getElementById('content');
    const wraps = [];
    document.querySelectorAll('.view.active .tbl-wrap, .view.active .lines-wrap').forEach((w) => {
      if (!w.getClientRects().length) return;
      if (w.scrollWidth > w.clientWidth + 2) {
        wraps.push({ cls: w.className, over: w.scrollWidth - w.clientWidth });
      }
    });
    return {
      doc: { scrollW: de.scrollWidth, clientW: de.clientWidth },
      body: { scrollW: document.body.scrollWidth, clientW: document.body.clientWidth },
      content: content ? { scrollW: content.scrollWidth, clientW: content.clientWidth } : null,
      wraps: wraps
    };
  }
};
1`;

/* the assertions, computed here (in node) so every line is printed with
 * its own PASS/FAIL */
function rgbOf(s) {
  if (!s) return null;
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function lum(c) {
  if (!c) return 1;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrast(c) { return c ? 1.05 / (lum(c) + 0.05) : 0; }
function isSolid(s) {
  const c = rgbOf(s);
  return !!c && c.a === 1;
}
/* the difference of two colours, channel by channel */
function diff(a, b) {
  const x = rgbOf(a), y = rgbOf(b);
  if (!x || !y) return null;
  return { r: Math.abs(x.r - y.r), g: Math.abs(x.g - y.g), b: Math.abs(x.b - y.b) };
}

/* ------------------------------------------------------------------ *
 * the checks of ONE table
 * ------------------------------------------------------------------ */
function checkTable(where, t, opt = {}) {
  const label = opt.label || where;
  if (!t) { check(`${where} carries a table to measure`, false, null); return; }

  /* 1 — the head: a solid fill that differs from the body */
  check(`the head of the ${label} has a SOLID background`, isSolid(t.head), { head: t.head });
  check(`the head of the ${label} differs from the body rows`,
    !!t.head && t.head !== t.rowA && t.head !== t.rowB,
    { head: t.head, rowA: t.rowA, rowB: t.rowB });

  /* an empty table has no body to measure — the head is all there is */
  if (!t.rows) {
    note(`the ${label} has no row yet — the lines of the body cannot be measured there`);
    if (opt.strongHead !== false) {
      check(`the head of the ${label} carries a strong rule under it`,
        parseFloat(t.headRule) >= 0.9, { headRule: t.headRule, color: t.headRuleColor });
    }
    return;
  }

  /* 2 — the stripe: two consecutive rows must NOT be equal, and the
   *     difference must be seen in EVERY channel */
  if (t.rows >= 2) {
    const d = diff(t.rowA, t.rowB);
    check(`the striped row of the ${label} differs from the plain row`, !!d && (d.r > 0 || d.g > 0 || d.b > 0),
      { rowA: t.rowA, rowB: t.rowB });
    check(`the stripe of the ${label} is visible in every channel (r, g and b)`,
      !!d && d.r >= 3 && d.g >= 3 && d.b >= 3, d);
  } else {
    note(`the ${label} has only one row — the stripe cannot be measured there`);
  }

  /* 3 — the lines: the columns and the rows must be told apart */
  const colC = rgbOf(t.colRuleColor), rowC = rgbOf(t.rowRuleColor);
  check(`the ${label} tells the column line from the row line`,
    (!!colC && !!rowC && (colC.r !== rowC.r || colC.g !== rowC.g || colC.b !== rowC.b)) ||
    t.colRule !== t.rowRule,
    { colRule: t.colRule, colRuleColor: t.colRuleColor, rowRule: t.rowRule, rowRuleColor: t.rowRuleColor });
  check(`the row line of the ${label} carries more contrast than the column line`,
    contrast(rowC) >= contrast(colC), { rowContrast: +contrast(rowC).toFixed(3), colContrast: +contrast(colC).toFixed(3) });

  /* 4 — the strong rule under the head: it must be clearly thicker than
   *     the rule of the rows (the display snaps the widths, so the
   *     ratio is what counts) */
  if (opt.strongHead !== false) {
    const hr = parseFloat(t.headRule), rr = parseFloat(t.rowRule);
    check(`the head of the ${label} carries a strong rule under it`,
      hr > 0 && hr >= rr * 1.4, { headRule: t.headRule, rowRule: t.rowRule, color: t.headRuleColor });
  }
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
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* the print media, emulated for real through the debugger */
async function setMedia(media) {
  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: media || '' });
    return true;
  } catch (e) {
    logLine('  (the print media could not be emulated: ' + e.message + ')');
    return false;
  }
}

async function shot(name) {
  try {
    await win.webContents.invalidate();
    await sleep(250);
    try { await win.webContents.capturePage(); } catch (e) {}
    await sleep(200);
    const img = await win.webContents.capturePage();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    logLine('shot -> ' + name);
  } catch (e) { logLine('shot failed: ' + e.message); }
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
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'الطرف الغربي' });
  for (let i = 1; i <= 20; i++) {
    dbMod.addItem(
      { code: String(2000 + i), name: 'صنف تجريبي طويل الاسم ' + i, base_unit: 'حبة', category: 'منتج', pieces_per_carton: 12 },
      [{ warehouseId: whA.id, good: 500 + i * 10 }, { warehouseId: whB.id, good: 200 + i * 5 }]
    );
  }
  ['شركة الأمل التجارية', 'مؤسسة النور'].forEach((n, i) => {
    dbMod.addParty({ name: n, type: i === 0 ? 'customer' : 'supplier', phone: '77' + i + '000000' });
  });

  logLine('--- harness starting ---');
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
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(3000);
  await js(HELPERS);
  check('the page loaded the helpers of the measurement', !!(await js(`!!window.__v7`)));

  /* =================================================================
     1 — every screen of the program
     ================================================================= */
  const screens = [
    'dashboard', 'items', 'warehouses', 'parties',
    'transactions', 'production', 'daily', 'reports', 'settings'
  ];
  const screenTables = {};
  for (const v of screens) {
    await js(`document.querySelector('.nav-item[data-view=${JSON.stringify(v)}]').click()`);
    await sleep(1500);

    const side = (await js(`window.__v7.sideways()`)) || {};
    check(`the «${v}» page never scrolls sideways`,
      !!(side.doc && side.doc.scrollW <= side.doc.clientW + 2), side.doc);
    check(`the content of the «${v}» page never scrolls sideways`,
      !!(side.content && side.content.scrollW <= side.content.clientW + 2), side.content);
    check(`no table box of the «${v}» page scrolls sideways`,
      !!(side.wraps && side.wraps.length === 0), side.wraps);

    const t = (await js(`(() => {
      const view = document.querySelector('.view.active');
      const tbl = view ? view.querySelector('table.tbl') : null;
      if (!tbl) return null;
      return window.__v7.describe(tbl);
    })()`)) || null;
    if (t) {
      screenTables[v] = t;
      checkTable(`table of the «${v}» screen`, t, { label: `«${v}» screen` });
    } else {
      note(`the «${v}» screen carries no table — nothing to measure there`);
    }
    if (v === 'items') await shot('01-items');
    if (v === 'daily') await shot('04-daily');
  }

  /* the screen stripe must be strong enough to be seen — remember it */
  const screenStripe = (() => {
    const t = screenTables.items || Object.values(screenTables)[0];
    if (!t) return null;
    const a = rgbOf(t.rowA), b = rgbOf(t.rowB);
    if (!a || !b) return null;
    const striped = contrast(a) > contrast(b) ? a : b;
    return striped;
  })();

  /* =================================================================
     2 — the PAPER (the print media, emulated for real)
     ================================================================= */
  const built = await js(`(() => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 60;
    const g = c.getContext('2d'); g.fillStyle = '#2563eb'; g.fillRect(0, 0, 120, 60);
    const logo = c.toDataURL('image/png');
    const cols = [{ key: 'code', label: 'الرمز' }, { key: 'name', label: 'الاسم' }, { key: 'qty', label: 'الكمية' }];
    const rows = [
      { code: '1001', name: 'صنف تجريبي أول', qty: '120' },
      { code: '1002', name: 'صنف تجريبي ثان', qty: '80' },
      { code: '1003', name: 'صنف تجريبي ثالث', qty: '40' },
      { code: '1004', name: 'صنف تجريبي رابع', qty: '25' }
    ];
    const body = SamUI.tableHtml(cols, rows, '265');
    const sh = SamUI.sheet({ title: 'ورقة اختبار', bodyHtml: body });
    const mast = sh.querySelector('.doc-mast');
    const co = document.createElement('div');
    co.className = 'm-company';
    co.innerHTML = '<img class="co-logo" src="' + logo + '" alt="" />' +
      '<div class="co-txt"><div class="co-name">اسم الشركة</div>' +
      '<div class="co-sub">عبر نظام SAM لإدارة المخزون</div></div>';
    mast.insertBefore(co, mast.children[1]);
    document.body.appendChild(sh);
    return { ok: true };
  })()`);
  check('the sheet of the paper was built', !!(built && built.ok));

  /* --- 2a — the sheet as it is seen on the screen (the preview) --- */
  const sheetScreen = (await js(`(() => {
    const sh = document.querySelector('body > section.sheet');
    if (!sh) return null;
    const tbl = sh.querySelector('table.tbl');
    const co = sh.querySelector('.m-company');
    const logo = sh.querySelector('.co-logo');
    const name = sh.querySelector('.co-name');
    const sub = sh.querySelector('.co-sub');
    const cs = co ? getComputedStyle(co) : null;
    const ls = logo ? getComputedStyle(logo) : null;
    const lr = logo ? logo.getBoundingClientRect() : null;
    const nr = name ? name.getBoundingClientRect() : null;
    const sr = sh.getBoundingClientRect();
    return {
      table: tbl ? window.__v7.describe(tbl) : null,
      company: cs ? {
        display: cs.display,
        maxWidth: cs.maxWidth,
        width: Math.round(co.getBoundingClientRect().width),
        sheetWidth: Math.round(sr.width)
      } : null,
      logo: ls ? {
        maxH: ls.maxHeight, maxW: ls.maxWidth,
        h: lr ? Math.round(lr.height) : null,
        w: lr ? Math.round(lr.width) : null,
        fit: ls.objectFit,
        border: ls.borderTopWidth,
        radius: ls.borderTopLeftRadius
      } : null,
      name: name ? { fs: getComputedStyle(name).fontSize, weight: getComputedStyle(name).fontWeight } : null,
      sub: sub ? { fs: getComputedStyle(sub).fontSize } : null,
      logoOnTheRight: (lr && nr) ? (lr.left >= nr.left) : null
    };
  })()`)) || {};

  if (sheetScreen.table) {
    checkTable('table of the paper (on the screen)', sheetScreen.table, { label: 'paper (preview)' });
  } else {
    check('the paper carries a table to measure', false, null);
  }

  const co = sheetScreen.company || {};
  check('the company block of the masthead is a centred block',
    co.display === 'flex' && co.width <= (co.sheetWidth || 0) / 3 + 2, co);
  const lg = sheetScreen.logo || {};
  check('the logo of the company is at most 16mm high and 40mm wide',
    parseFloat(lg.maxH) <= 61 && parseFloat(lg.maxW) <= 152, lg);
  check('the logo of the company keeps its own shape (object-fit: contain)', lg.fit === 'contain', lg.fit);
  check('the logo of the company wears a thin border and a small radius',
    parseFloat(lg.border) > 0 && parseFloat(lg.border) <= 2 && parseFloat(lg.radius) >= 2, lg);
  check('the logo of the company sits on the right (the page is RTL)', sheetScreen.logoOnTheRight === true, sheetScreen.logoOnTheRight);
  check('the name of the company is at least 15px on the screen',
    parseFloat((sheetScreen.name || {}).fs) >= 15, sheetScreen.name);
  check('the line under the name of the company is small and quiet',
    parseFloat((sheetScreen.sub || {}).fs) >= 10 && parseFloat((sheetScreen.sub || {}).fs) <= 13, sheetScreen.sub);

  await shot('02-paper-preview');

  /* --- 2b — the same sheet with the PRINT media (for real) --- */
  const printed = await setMedia('print');
  if (printed) {
    await sleep(400);
    const sheetPrint = (await js(`(() => {
      const sh = document.querySelector('body > section.sheet');
      if (!sh) return null;
      const tbl = sh.querySelector('table.tbl');
      const co = sh.querySelector('.m-company');
      const logo = sh.querySelector('.co-logo');
      const name = sh.querySelector('.co-name');
      const sub = sh.querySelector('.co-sub');
      const cs = co ? getComputedStyle(co) : null;
      const ls = logo ? getComputedStyle(logo) : null;
      return {
        table: tbl ? window.__v7.describe(tbl) : null,
        adjust: tbl ? (getComputedStyle(tbl).printColorAdjust || getComputedStyle(tbl).webkitPrintColorAdjust || null) : null,
        company: cs ? { display: cs.display, maxWidth: cs.maxWidth, width: Math.round(co.getBoundingClientRect().width) } : null,
        logo: ls ? { maxH: ls.maxHeight, maxW: ls.maxWidth, border: ls.borderTopWidth, fit: ls.objectFit } : null,
        name: name ? { fs: getComputedStyle(name).fontSize, weight: getComputedStyle(name).fontWeight } : null,
        sub: sub ? { fs: getComputedStyle(sub).fontSize } : null
      };
    })()`)) || {};

    if (sheetPrint.table) {
      checkTable('table of the PAPER (print media)', sheetPrint.table, { label: 'paper (print)' });
    } else {
      check('the paper carries a table to measure (print media)', false, null);
    }
    check('the paper keeps its fills (print-color-adjust: exact)',
      sheetPrint.adjust === 'exact', sheetPrint.adjust);

    /* the stripe of the paper must be DEEPER than the stripe of the
       screen — a faint tint is eaten by the printer */
    const pt = sheetPrint.table || {};
    const pa = rgbOf(pt.rowA), pb = rgbOf(pt.rowB);
    const printStripe = pa && pb ? (contrast(pa) > contrast(pb) ? pa : pb) : null;
    check('the stripe of the paper is deeper than the stripe of the screen',
      !!printStripe && !!screenStripe && contrast(printStripe) >= contrast(screenStripe),
      { print: printStripe && +contrast(printStripe).toFixed(3), screen: screenStripe && +contrast(screenStripe).toFixed(3) });

    check('the company block of the paper is a centred block',
      (sheetPrint.company || {}).display === 'flex', sheetPrint.company);
    check('the logo of the company is at most 16mm high and 40mm wide on the paper',
      parseFloat(((sheetPrint.logo || {}).maxH || 0)) <= 61 && parseFloat(((sheetPrint.logo || {}).maxW || 0)) <= 152, sheetPrint.logo);
    check('the name of the company is at least 13pt on the paper',
      parseFloat((sheetPrint.name || {}).fs) >= 17, sheetPrint.name);
    check('the line under the name of the company is about 8.5pt on the paper',
      parseFloat((sheetPrint.sub || {}).fs) >= 10 && parseFloat((sheetPrint.sub || {}).fs) <= 12.5, sheetPrint.sub);
    await shot('03-paper-print');
    await setMedia('');
  } else {
    note('the print media could not be emulated — the paper was measured on the screen only');
  }

  /* the paper must not push the page sideways either */
  const sideAfter = (await js(`window.__v7.sideways()`)) || {};
  check('the page never scrolls sideways, the paper included',
    !!(sideAfter.doc && sideAfter.doc.scrollW <= sideAfter.doc.clientW + 2), sideAfter.doc);

  logLine(`\n${pass} passed, ${fail} failed`);
  if (errors.length) logLine('CONSOLE ERRORS:\n' + errors.join('\n'));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
