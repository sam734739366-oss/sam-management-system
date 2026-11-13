/**
 * tools/v6-layout-check.js — V6-7 evidence:
 * «واريد كل المربعات ظاهره من غير تحريك الصفحة يمين وشمال»
 * «واريد كل المربعات مميزه وواضحه»
 * «ايضاح المربعات بشكل اكبر وجعله مناسب لكل مايكتب بداخله»
 *
 * It opens EVERY screen of the program and measures it:
 *   · does anything scroll sideways? (the page itself and every table box)
 *   · is every box big enough for the text inside it?
 *   · are the boxes distinct from each other (a border and a background)?
 * Writes .tmp/v6layout/*.png and prints PASS/FAIL for every check.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v6-layout-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v6layout');
const DATA = path.join(ROOT, '.tmp', 'v6layoutdata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v6-layout-check.log');
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
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
logLine('--- ipc modules loaded ---');

async function shot(name, settle = 700) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(`(() => {
      try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); } catch (e) {}
      return 1;
    })()`, true);
  } catch (e) { /* navigating */ }
  try { win.webContents.invalidate(); } catch (e) {}
  await sleep(200);
  try { await win.webContents.capturePage(); } catch (e) {}
  await sleep(160);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  logLine('shot -> ' + name);
}

/* the measurement — done INSIDE the page so the numbers are the real ones */
const MEASURE = `(() => {
  const view = document.querySelector('.view.active');
  if (!view) return null;
  const content = document.getElementById('content');
  const out = {
    view: view.id,
    pageScrollsSideways: content.scrollWidth > content.clientWidth + 2,
    pageOverflow: content.scrollWidth - content.clientWidth,
    wraps: [],
    tiny: [],
    boxes: []
  };
  view.querySelectorAll('.tbl-wrap, .lines-wrap, .grid-2, .filters-grid, .routing-grid').forEach((w) => {
    if (!w.getClientRects().length) return;
    if (w.scrollWidth > w.clientWidth + 2) {
      out.wraps.push({ cls: w.className, id: w.id || null, over: w.scrollWidth - w.clientWidth, sw: w.scrollWidth, cw: w.clientWidth });
    }
  });
  /* the smallest text on the screen — the user must be able to read it */
  view.querySelectorAll('*').forEach((n) => {
    if (!n.getClientRects().length) return;
    const t = (n.textContent || '').trim();
    if (!t || n.children.length > 2) return;
    const fs = parseFloat(getComputedStyle(n).fontSize);
    if (fs && fs < 11) out.tiny.push({ tag: n.tagName, cls: (n.className || '').toString().slice(0, 40), fs, text: t.slice(0, 30) });
  });
  /* the boxes — each one must be big enough and clearly separated */
  view.querySelectorAll('.card, .kpi, .view-head').forEach((c) => {
    if (!c.getClientRects().length) return;
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    out.boxes.push({
      cls: (c.className || '').toString().split(' ').slice(0, 2).join(' '),
      w: Math.round(r.width), h: Math.round(r.height),
      border: cs.borderTopWidth,
      radius: cs.borderTopLeftRadius
    });
  });

  /* the first card of THIS view: its border, its shadow and its title rule.
     A card that carries no title has no rule to show — so the title rule is
     read from the first card that HAS a title. */
  const card = [...view.querySelectorAll('.card')].find((c) => c.getClientRects().length);
  const titled = [...view.querySelectorAll('.card')].find((c) => c.getClientRects().length && c.querySelector('.card-head'));
  if (card) {
    const cs = getComputedStyle(card);
    const head = titled ? titled.querySelector('.card-head') : null;
    const hs = head ? getComputedStyle(head) : null;
    out.card = {
      border: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
      bg: cs.backgroundColor,
      headBorder: hs ? hs.borderBottomWidth : null,
      headRule: hs ? getComputedStyle(head, '::before').width : null,
      hasTitled: !!titled,
      h: Math.round(card.getBoundingClientRect().height)
    };
  }

  /* the KPI tile of THIS view */
  const k = view.querySelector('.kpi');
  if (k) {
    const cs = getComputedStyle(k);
    const val = k.querySelector('.k-val');
    const top = k.querySelector('.k-top');
    out.kpi = {
      h: Math.round(k.getBoundingClientRect().height),
      pad: cs.paddingTop,
      valFs: val ? getComputedStyle(val).fontSize : null,
      topFs: top ? getComputedStyle(top).fontSize : null,
      noteFs: (k.querySelector('.k-note') ? getComputedStyle(k.querySelector('.k-note')).fontSize : null)
    };
  }

  /* the cells of THIS view */
  const td = view.querySelector('.tbl tbody td');
  const th = view.querySelector('.tbl thead th');
  if (td && th) {
    const cs = getComputedStyle(td), hs = getComputedStyle(th);
    out.cells = {
      tdH: Math.round(td.getBoundingClientRect().height),
      tdPad: cs.paddingTop + ' ' + cs.paddingLeft,
      thH: Math.round(th.getBoundingClientRect().height),
      thPad: hs.paddingTop + ' ' + hs.paddingLeft,
      tdFs: cs.fontSize, thFs: hs.fontSize,
      clipped: td.scrollWidth > td.clientWidth + 2,
      headClipped: th.scrollWidth > th.clientWidth + 2
    };
  }
  return out;
})()`;

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
  const items = [];
  for (let i = 1; i <= 24; i++) {
    items.push(dbMod.addItem(
      { code: String(1000 + i), name: 'صنف تجريبي طويل الاسم ' + i, base_unit: 'حبة', category: 'منتج', pieces_per_carton: 12 },
      [{ warehouseId: whA.id, good: 500 + i * 10 }, { warehouseId: whB.id, good: 200 + i * 5 }]
    ));
  }
  ['شركة الأمل التجارية', 'مؤسسة النور', 'ورشة الإخوة'].forEach((n, i) => {
    dbMod.addParty({ name: n, type: i === 0 ? 'customer' : 'supplier', phone: '77' + i + '000000' });
  });

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
  await sleep(2800);

  const screens = [
    'dashboard', 'items', 'warehouses', 'parties',
    'transactions', 'production', 'daily', 'reports', 'settings'
  ];
  const results = {};
  for (const v of screens) {
    await js(`document.querySelector('.nav-item[data-view=${JSON.stringify(v)}]').click()`);
    await sleep(1500);
    const m = await js(MEASURE);
    results[v] = m;
    logLine(`--- ${v} :: ` + JSON.stringify({
      pageOverflow: m && m.pageOverflow,
      wraps: m && m.wraps,
      tiny: m && m.tiny.length,
      card: m && m.card,
      kpi: m && m.kpi,
      cells: m && m.cells
    }));
    check(`the «${v}» page never scrolls sideways`, !!(m && m.pageScrollsSideways === false), m && { over: m.pageOverflow });
    check(`no box of the «${v}» screen scrolls sideways`, !!(m && m.wraps.length === 0), m && m.wraps);
    check(`no text of the «${v}» screen is smaller than 11px`, !!(m && m.tiny.length === 0), m && m.tiny.slice(0, 6));
    if (m && m.card) {
      check(`the boxes of the «${v}» screen have a visible border`, parseFloat(m.card.border) >= 0.7, m.card.border);
      /* a card that carries a title must separate it with a rule and mark it
         with a coloured band; a card with no title has nothing to separate */
      if (m.card.hasTitled) {
        check(`the boxes of the «${v}» screen have a rule under the title`, m.card.headBorder !== null && parseFloat(m.card.headBorder) >= 0.7, m.card.headBorder);
        check(`the boxes of the «${v}» screen have a coloured marker`, m.card.headRule !== null && parseFloat(m.card.headRule) >= 2, m.card.headRule);
      }
    }
    if (m && m.kpi) {
      check(`the KPI box of the «${v}» screen is tall enough to read`, m.kpi.h >= 70, m.kpi);
      check(`the KPI number of the «${v}» screen is big enough`, parseFloat(m.kpi.valFs) >= 24, m.kpi);
      check(`the KPI label of the «${v}» screen is big enough`, parseFloat(m.kpi.topFs) >= 12.5, m.kpi);
    }
    if (m && m.cells) {
      check(`the cells of the «${v}» screen are tall enough for their text`, m.cells.tdH >= 28, m.cells);
      check(`the cell text of the «${v}» screen is never cut off`, m.cells.clipped === false, m.cells);
      check(`the header text of the «${v}» screen is never cut off`, m.cells.headClipped === false, m.cells);
      check(`the cell font of the «${v}» screen is readable`, parseFloat(m.cells.tdFs) >= 13, m.cells);
    }
    if (v === 'items') await shot('01-items');
    if (v === 'dashboard') await shot('02-dashboard');
    if (v === 'transactions') await shot('03-transactions');
    if (v === 'daily') await shot('04-daily');
  }

  /* ================= the app tells the customer what changed ============ */
  await js(`document.querySelector('.nav-item[data-view=dashboard]').click()`);
  await sleep(1200);
  const rel = await js(`(() => {
    const items = [...document.querySelectorAll('#roadmap li')];
    const card = [...document.querySelectorAll('.card-head h3')].find(h => /تغيّر/.test(h.textContent));
    return {
      version: (document.getElementById('tbVer')||{}).textContent,
      sideNum: (document.querySelector('.pc-num')||{}).textContent,
      sideTxt: (document.querySelector('.pc-txt')||{}).textContent,
      phase: (document.getElementById('sbPhase')||{}).textContent,
      title: card ? card.textContent.trim() : null,
      count: items.length,
      first: items.length ? items[0].textContent.replace(/\\s+/g,' ').trim().slice(0, 60) : null,
      clipped: items.filter(li => li.scrollWidth > li.clientWidth + 2).length
    };
  })()`);
  /* the labels must follow the version in package.json — not a hardcoded number */
  const APP_VERSION = require(path.join(ROOT, 'package.json')).version;
  const ROUND = 'V' + APP_VERSION.split('.')[1];
  check('the title bar carries the new version', rel && rel.version === 'v' + APP_VERSION, rel && rel.version);
  check('the sidebar names the new round', rel && rel.sideNum === ROUND, rel && rel.sideNum);
  check('the status bar names the new round', rel && new RegExp(ROUND).test(rel.phase || ''), rel && rel.phase);
  check('the dashboard lists what changed in this round', rel && new RegExp(ROUND).test(rel.title || '') && rel.count >= 8, rel && { title: rel.title, count: rel.count });
  check('the changelog lines are not cut off', rel && rel.clipped === 0, rel && rel.clipped);
  await shot('05-changelog');

  /* the boxes must be clearly separated: a border and a rounded corner */
  const cardStyle = results.items && results.items.card;

  /* the KPI boxes must be big enough to read at a glance */
  const kpi = results.dashboard && results.dashboard.kpi;

  /* the cells must be big enough for what is written inside them */
  const cells = results.items && results.items.cells;

  logLine(`\n${pass} passed, ${fail} failed`);
  if (errors.length) logLine('CONSOLE ERRORS:\n' + errors.join('\n'));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
