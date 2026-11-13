/**
 * tools/v7-centre-check.js — the evidence that EVERY writing inside the
 * boxes is in the middle.
 *
 * The customer asked (verbatim):
 * «اجعل كل الكتابات داخل المربعات في التقارير او الطباعة او في البرنامج
 *   بالوسط»
 * — every writing inside the boxes must be CENTRED: in the reports, in the
 * print AND in the program.
 *
 * This harness opens the REAL program (it logs in, walks the screens and
 * measures the real DOM) and proves:
 *   · the writing of a normal cell is in the middle (text-align: center) —
 *     in EVERY table of EVERY screen, cell by cell;
 *   · the head of the table is centred too (it keeps its solid fill);
 *   · the totals row is centred as well — even where the table carries its
 *     own alignment as an INLINE style (style="text-align:left");
 *   · the PAPER (the print media, emulated for real) carries the same
 *     centring — the printed sheet looks like the screen;
 *   · the picture beside the name never pushes the name off the centre,
 *     and the small writing inside a cell (the reading under a box of
 *     packs, the quiet second line) stands in the middle as well;
 *   · nothing overflows sideways — neither the page, nor the content, nor
 *     the box of a table, nor the paper.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-centre-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v7centre');
const DATA = path.join(ROOT, '.tmp', 'v7centredata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-centre-check.log');
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
window.__ctr = {
  vis(e) { return !!e && e.getClientRects().length > 0; },

  /* the alignment of every visible cell of ONE table */
  align(tbl) {
    const pick = (sel) => [...tbl.querySelectorAll(sel)].filter((e) => this.vis(e));
    const list = (els) => els.map((e) => ({
      align: getComputedStyle(e).textAlign,
      txt: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 28)
    }));
    return {
      head: list(pick('thead th')),
      body: list(pick('tbody td')),
      tot: list(pick('.tot-row td')),
      dir: getComputedStyle(tbl).direction
    };
  },

  /* EVERY visible table of the page */
  tables() {
    return [...document.querySelectorAll('table.tbl')]
      .filter((t) => this.vis(t))
      .map((t, i) => ({ i, align: this.align(t) }));
  },

  /* the box of an element */
  box(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
  },

  /* the writing itself (the ink of the text), measured with a range */
  ink(el) {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const b = r.getBoundingClientRect();
      return { left: b.left, right: b.right, w: b.width, h: b.height };
    } catch (e) { return null; }
  },

  /* the group of the children of a box (the picture and the name) */
  group(el) {
    const kids = [...el.children].filter((c) => this.vis(c));
    if (!kids.length) return null;
    const rs = kids.map((c) => c.getBoundingClientRect());
    const left = Math.min.apply(null, rs.map((r) => r.left));
    const right = Math.max.apply(null, rs.map((r) => r.right));
    const host = el.getBoundingClientRect();
    const g = (left + right) / 2, h = (host.left + host.right) / 2;
    return { group: +g.toFixed(2), host: +h.toFixed(2), delta: +Math.abs(g - h).toFixed(2), w: +(right - left).toFixed(2) };
  },

  /* EVERY visible cell that carries a picture, and where the group (the
     picture and the name) stands inside that cell */
  picCells() {
    const out = [];
    document.querySelectorAll('table.tbl td').forEach((td) => {
      if (!this.vis(td)) return;
      const img = td.querySelector('img');
      if (!img) return;
      const group = img.parentElement;
      const cs = getComputedStyle(group);
      const flex = cs.display === 'flex' || cs.display === 'inline-flex';
      let left = 0, right = 0;
      if (flex) {
        const rs = [...group.children].filter((c) => this.vis(c)).map((c) => c.getBoundingClientRect());
        if (!rs.length) return;
        left = Math.min.apply(null, rs.map((r) => r.left));
        right = Math.max.apply(null, rs.map((r) => r.right));
      } else {
        const r = group.getBoundingClientRect();
        left = r.left; right = r.right;
      }
      const tr = td.getBoundingClientRect();
      const gc = (left + right) / 2, tc = (tr.left + tr.right) / 2;
      out.push({
        txt: (td.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26),
        delta: +Math.abs(gc - tc).toFixed(2),
        flex: flex,
        natural: img.naturalWidth,
        src: String(img.src || '').slice(0, 160),
        align: getComputedStyle(td).textAlign
      });
    });
    return out;
  },

  /* the page must never scroll sideways */
  sideways() {
    const de = document.documentElement;
    const content = document.getElementById('content');
    const wraps = [];
    document.querySelectorAll('.view.active .tbl-wrap, .view.active .lines-wrap').forEach((w) => {
      if (!this.vis(w)) return;
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

/* the probe table: a picture beside the name, a box of packs with its
   reading under it, a unit chip, a number and a totals row — the four
   shapes the customer spoke about. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1x1 = 'data:image/png;base64,' + PNG_B64;
const PROBE_HTML = `
<table class="tbl" id="ctrProbe">
  <thead><tr><th>الصنف</th><th>الوحدة</th><th>الأكياس</th><th>الكمية</th></tr></thead>
  <tbody>
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:9px">
          <img class="sam-pic" src="${PNG_1x1}" alt="" style="width:14px;height:14px;object-fit:contain;border-radius:6px;background:#f1f5f9;flex:none;align-self:center;">
          <div style="min-width:0">
            <div>صنف تجريبي للقياس</div>
            <span class="sub">التغليف: 5 كيس</span>
          </div>
        </div>
      </td>
      <td><span class="unit-chip">حبة</span></td>
      <td class="pack-c">
        <input class="input num-in" value="5">
        <em class="pack-read" style="font-style:normal;display:block;margin-top:3px;font-size:10px;font-weight:700;color:var(--muted-fg);line-height:1.25;text-align:center">5 كيس + 70 حبة</em>
      </td>
      <td class="num qty">1,070</td>
    </tr>
    <tr class="tot-row"><td>الإجمالي</td><td>حبة</td><td>5</td><td style="text-align:left">1,070</td></tr>
  </tbody>
</table>`;

/* ------------------------------------------------------------------ *
 * the checks
 * ------------------------------------------------------------------ */
const isCenter = (a) => String(a || '').toLowerCase() === 'center';
/* the cells of a group that are NOT in the middle */
const notCentered = (cells) => (cells || []).filter((c) => !isCenter(c.align));

function checkCells(label, group, cells) {
  const bad = notCentered(cells);
  check(`every ${label} is centred`, bad.length === 0, {
    total: (cells || []).length,
    bad: bad.slice(0, 6)
  });
}

let win;
let jsExec = null;
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
    /* a HIDDEN window never produces frames, so the CSS animations (the
       fade of a view) stay frozen at their first frame and the picture
       comes out empty. The animations are finished by hand here — the
       measurement itself is never touched. */
    if (jsExec) await jsExec(`(() => {
      document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} });
      return true;
    })()`);
    await win.webContents.invalidate();
    await sleep(300);
    try { await win.webContents.capturePage(); } catch (e) {}
    await sleep(250);
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
  /* a picture for the items — the picture beside the name must not push
     the name off the centre, and that can only be proved with a real one */
  fs.mkdirSync(path.join(DATA, 'images'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'images', 'pic.png'),
    Buffer.from(PNG_B64, 'base64'));
  note('the picture of the seed: ' + JSON.stringify({
    file: path.join(DATA, 'images', 'pic.png'),
    exists: fs.existsSync(path.join(DATA, 'images', 'pic.png')),
    size: fs.existsSync(path.join(DATA, 'images', 'pic.png')) ? fs.statSync(path.join(DATA, 'images', 'pic.png')).size : -1
  }));
  for (let i = 1; i <= 20; i++) {
    dbMod.addItem(
      { code: String(2000 + i), name: 'صنف تجريبي طويل الاسم ' + i, base_unit: 'حبة', category: 'منتج', pieces_per_carton: 12, image: 'pic.png' },
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
  jsExec = js;

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(3000);
  await js(HELPERS);
  check('the page loaded the helpers of the measurement', !!(await js(`!!window.__ctr`)));

  /* =================================================================
     1 — EVERY screen of the program: every cell of every table must
         stand in the middle
     ================================================================= */
  const screens = [
    'dashboard', 'items', 'warehouses', 'parties',
    'transactions', 'production', 'daily', 'reports', 'settings'
  ];
  let seenBody = 0, seenHead = 0, seenTot = 0, seenPics = 0;
  for (const v of screens) {
    await js(`document.querySelector('.nav-item[data-view=${JSON.stringify(v)}]').click()`);
    await sleep(1600);

    const side = (await js(`window.__ctr.sideways()`)) || {};
    check(`the «${v}» page never scrolls sideways`,
      !!(side.doc && side.doc.scrollW <= side.doc.clientW + 2), side.doc);
    check(`the content of the «${v}» page never scrolls sideways`,
      !!(side.content && side.content.scrollW <= side.content.clientW + 2), side.content);
    check(`no table box of the «${v}» page scrolls sideways`,
      !!(side.wraps && side.wraps.length === 0), side.wraps);

    const tables = (await js(`window.__ctr.tables()`)) || [];
    if (!tables.length) {
      note(`the «${v}» screen carries no table — nothing to measure there`);
      continue;
    }
    const heads = [], bodies = [], tots = [];
    tables.forEach((t) => {
      heads.push(...t.align.head);
      bodies.push(...t.align.body);
      tots.push(...t.align.tot);
    });
    seenHead += heads.length; seenBody += bodies.length; seenTot += tots.length;
    checkCells(`cell of the «${v}» screen`, 'body cell', bodies);
    checkCells(`head cell of the «${v}» screen`, 'head cell', heads);
    if (tots.length) checkCells(`totals cell of the «${v}» screen`, 'totals cell', tots);
    /* the page stays RTL — the centring never changes the order */
    const dirs = tables.map((t) => t.align.dir);
    check(`the tables of the «${v}» screen stay RTL`,
      dirs.every((d) => d === 'rtl'), dirs.slice(0, 4));
    /* the picture beside the name never pushes the name off the centre */
    const pics = (await js(`window.__ctr.picCells()`)) || [];
    if (pics.length) {
      seenPics += pics.length;
      const badPics = pics.filter((p) => p.delta > 3 || !isCenter(p.align));
      check(`the picture beside the name stays in the middle of its cell (${v})`,
        badPics.length === 0, { total: pics.length, sample: pics[0], bad: badPics.slice(0, 4) });
      const broken = pics.filter((p) => !p.natural);
      check(`the pictures of the «${v}» screen are really loaded (${v})`,
        broken.length === 0, { total: pics.length, broken: broken.slice(0, 3) });
    }
    if (v === 'items') {
      const diag = (await js(`(() => {
        const c = document.getElementById('content');
        const view = document.querySelector('.view.active');
        const t = document.querySelector('#itemsTbl');
        const r = t ? t.getBoundingClientRect() : null;
        const cs = view ? getComputedStyle(view) : null;
        return {
          view: view ? view.id : null,
          opacity: cs ? cs.opacity : null,
          transform: cs ? cs.transform : null,
          content: c ? { scrollTop: c.scrollTop, scrollH: c.scrollHeight, clientH: c.clientHeight } : null,
          table: r ? { top: Math.round(r.top), h: Math.round(r.height) } : null
        };
      })()`)) || {};
      note('the items screen: ' + JSON.stringify(diag));
      await shot('01-items');
    }
  }
  note(`measured on the real screens: ${seenHead} head cells, ${seenBody} body cells, ${seenTot} totals cells, ${seenPics} picture cells`);
  check('the real screens carry body cells to measure', seenBody > 0, { seenBody });
  check('the real screens carry head cells to measure', seenHead > 0, { seenHead });

  /* =================================================================
     1b — the REPORTS of the customer: the window of the report centre
          with the picture beside the name of the item
     ================================================================= */
  await js(`document.querySelector('.nav-item[data-view="reports"]').click()`);
  await sleep(1200);
  const cardOpened = await js(`(() => {
    const c = document.querySelector('.rpt-card');
    if (!c) return false;
    c.click();
    return true;
  })()`);
  check('the window of the report centre opened', cardOpened === true);
  await sleep(2200);
  const railPicked = await js(`(() => {
    const it = document.querySelector('.rw-item');
    if (!it) return false;
    it.click();
    return true;
  })()`);
  if (railPicked) { await sleep(2800); }
  else { note('the rail of the reports carries no item — the preview was not measured'); }
  const rptTables = (await js(`window.__ctr.tables()`)) || [];
  const rptCells = [];
  rptTables.forEach((t) => { rptCells.push(...t.align.body, ...t.align.head, ...t.align.tot); });
  if (rptCells.length) {
    checkCells('cell of the report', 'body cell', rptCells);
    const rptPics = (await js(`window.__ctr.picCells()`)) || [];
    const badRpt = rptPics.filter((p) => p.delta > 3 || !isCenter(p.align));
    check('the picture beside the name of the report stays in the middle of its cell',
      rptPics.length === 0 || badRpt.length === 0, { total: rptPics.length, bad: badRpt.slice(0, 4) });
  } else {
    note('the report carries no table yet — the report window was measured on the paper instead');
  }
  await js(`(() => {
    const t = document.querySelector('.rw-content table.tbl, .rw-pbody table.tbl, .rw-body table.tbl');
    if (t) t.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(500);
  await shot('05-report');
  await js(`(() => { const x = document.querySelector('.rw-x'); if (x) x.click(); return true; })()`);
  await sleep(800);

  /* =================================================================
     2 — the probe: the picture beside the name, the reading under the
         box of packs, the unit chip, the quiet second line and the
         totals row that carries an INLINE alignment
     ================================================================= */
  await js(`document.querySelector('.nav-item[data-view="items"]').click()`);
  await sleep(1200);
  const probeBuilt = await js(`(() => {
    const host = document.getElementById('content') || document.body;
    const d = document.createElement('div');
    d.id = 'ctrProbeHost';
    d.style.margin = '10px';
    d.innerHTML = ${JSON.stringify(PROBE_HTML)};
    host.appendChild(d);
    return !!d.querySelector('#ctrProbe');
  })()`);
  check('the probe table (the picture, the packs, the totals) was built', !!(probeBuilt && probeBuilt === true));

  const probe = (await js(`(() => {
    const tbl = document.getElementById('ctrProbe');
    if (!tbl) return null;
    const a = window.__ctr.align(tbl);
    const picCell = tbl.querySelector('tbody tr td');
    const picRow = picCell.querySelector('div');
    const chip = tbl.querySelector('.unit-chip');
    const read = tbl.querySelector('.pack-read');
    const sub = tbl.querySelector('.sub');
    const inkOf = (el) => { const i = window.__ctr.ink(el); return i ? +(((i.left + i.right) / 2)).toFixed(2) : null; };
    const boxOf = (el) => { const b = window.__ctr.box(el); return +(((b.left + b.right) / 2)).toFixed(2); };
    return {
      head: a.head, body: a.body, tot: a.tot,
      group: window.__ctr.group(picRow),
      chip: { align: getComputedStyle(chip.parentElement).textAlign, centre: inkOf(chip), cell: boxOf(chip.parentElement) },
      read: { align: getComputedStyle(read).textAlign, centre: inkOf(read), cell: boxOf(read) },
      sub: { align: getComputedStyle(sub).textAlign, centre: inkOf(sub), cell: boxOf(sub) }
    };
  })()`)) || {};

  checkCells('probe body cell', 'body cell', probe.body);
  checkCells('probe head cell', 'head cell', probe.head);
  checkCells('probe totals cell', 'totals cell', probe.tot);
  check('the totals cell of the probe wins over its own INLINE alignment',
    (probe.tot || []).every((c) => isCenter(c.align)), probe.tot);
  check('the picture and the name stand in the middle of their cell',
    !!(probe.group && probe.group.delta <= 3), probe.group);
  check('the unit chip stands in the middle of its cell',
    !!(probe.chip && probe.chip.centre !== null && Math.abs(probe.chip.centre - probe.chip.cell) <= 3), probe.chip);
  check('the reading under the box of packs stands in the middle of its cell',
    !!(probe.read && probe.read.centre !== null && Math.abs(probe.read.centre - probe.read.cell) <= 3), probe.read);
  check('the quiet second line stands in the middle of its cell',
    !!(probe.sub && probe.sub.centre !== null && Math.abs(probe.sub.centre - probe.sub.cell) <= 3), probe.sub);
  await shot('02-probe');

  await js(`(() => { const d = document.getElementById('ctrProbeHost'); if (d) d.remove(); return true; })()`);

  /* =================================================================
     3 — the PAPER: the preview of the screen and then the print media
     ================================================================= */
  const built = await js(`(() => {
    const cols = [
      { key: 'code', label: 'الرمز', align: 'start' },
      { key: 'name', label: 'الاسم' },
      { key: 'unit', label: 'الوحدة', align: 'center' },
      { key: 'qty', label: 'الكمية', align: 'end' }
    ];
    const rows = [
      { code: '1001', name: 'صنف تجريبي أول', unit: 'حبة', qty: '120' },
      { code: '1002', name: 'صنف تجريبي ثان', unit: 'كيس', qty: '80' },
      { code: '1003', name: 'صنف تجريبي ثالث', unit: 'حبة', qty: '40' }
    ];
    const body = SamUI.tableHtml(cols, rows, '265');
    const sh = SamUI.sheet({ title: 'ورقة اختبار', bodyHtml: body });
    document.body.appendChild(sh);
    return { ok: true };
  })()`);
  check('the sheet of the paper was built', !!(built && built.ok));

  const readSheet = async (where) => {
    const s = (await js(`(() => {
      const sh = document.querySelector('body > section.sheet');
      if (!sh) return null;
      const tbl = sh.querySelector('table.tbl');
      if (!tbl) return null;
      const a = window.__ctr.align(tbl);
      const b = window.__ctr.box(sh);
      const tb = tbl.getBoundingClientRect();
      return {
        head: a.head, body: a.body, tot: a.tot, dir: a.dir,
        sheet: { w: +b.w.toFixed(1), scrollW: sh.scrollWidth, clientW: sh.clientWidth },
        table: { w: +tb.width.toFixed(1), scrollW: tbl.scrollWidth, clientW: tbl.clientWidth },
        printMatch: window.matchMedia('print').matches
      };
    })()`)) || {};
    if (!s.head) { check(`the paper carries a table to measure (${where})`, false, null); return null; }
    checkCells(`paper body cell (${where})`, 'body cell', s.body);
    checkCells(`paper head cell (${where})`, 'head cell', s.head);
    checkCells(`paper totals cell (${where})`, 'totals cell', s.tot);
    check(`the paper stays RTL (${where})`, s.dir === 'rtl', s.dir);
    return s;
  };

  const paperScreen = await readSheet('on the screen');
  if (paperScreen) {
    check('the paper never pushes its own table sideways',
      paperScreen.table.scrollW <= paperScreen.table.clientW + 2, paperScreen.table);
  }
  await shot('03-paper-screen');

  const printed = await setMedia('print');
  if (!printed) {
    note('the print media could not be emulated — the paper was measured on the screen only');
  } else {
    await sleep(500);
    const paperPrint = await readSheet('print media');
    if (paperPrint) {
      check('the print media is really on (window.matchMedia("print"))',
        paperPrint.printMatch === true, paperPrint.printMatch);
      check('the paper never pushes its own table sideways (print media)',
        paperPrint.table.scrollW <= paperPrint.table.clientW + 2, paperPrint.table);
    }
    await shot('04-paper-print');
    await setMedia('');
  }

  /* the page must not scroll sideways with the paper on it */
  const sideAfter = (await js(`window.__ctr.sideways()`)) || {};
  check('the page never scrolls sideways, the paper included',
    !!(sideAfter.doc && sideAfter.doc.scrollW <= sideAfter.doc.clientW + 2), sideAfter.doc);
  check('no table box scrolls sideways, the paper included',
    !!(sideAfter.wraps && sideAfter.wraps.length === 0), sideAfter.wraps);

  await js(`(() => { const sh = document.querySelector('body > section.sheet'); if (sh) sh.remove(); return true; })()`);

  /* =================================================================
     4 — the files themselves: the rules that do the work are really
         written in the two stylesheets
     ================================================================= */
  const appCss = fs.readFileSync(path.join(RENDERER, 'css', 'app.css'), 'utf8');
  const printCss = fs.readFileSync(path.join(RENDERER, 'css', 'print.css'), 'utf8');
  check('app.css centres the cells of the tables', /\.tbl th,\s*\.tbl td\s*\{[^}]*text-align:\s*center\s*!important/.test(appCss));
  check('app.css centres the head and the totals row',
    /\.tbl thead th/.test(appCss) && /\.tot-row td/.test(appCss));
  check('app.css centres the picture beside the name',
    /:has\(img\)/.test(appCss));
  check('print.css centres the cells of the printed sheet',
    /\.sheet table\.tbl th,\s*\.sheet table\.tbl td\s*\{[^}]*text-align:\s*center\s*!important/.test(printCss));

  logLine(`\n${pass} passed, ${fail} failed`);
  if (errors.length) logLine('CONSOLE ERRORS:\n' + errors.join('\n'));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
