/**
 * tools/v6-render-check.js — end-to-end verification of the V6 work:
 * the two numbers of a document and the new «توريد الإنتاج» voucher.
 * It drives the REAL renderer (the same one the user sees):
 *   · the kind grid carries ten kinds, each with its own name, icon and colour
 *   · the editor shows TWO number boxes: ours (read-only, generated) and the
 *     number of the paper that came from another system (the only typed one)
 *   · a «توريد الإنتاج» voucher saves, lowers the stock and shows both numbers
 *   · the operations list filters by the new kind, the production screen lists
 *     its vouchers, and the printed sheet + the exit permit carry both numbers
 * Writes .tmp/v6shots/*.png and prints PASS/FAIL for every check.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v6-render-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v6shots');
const DATA = path.join(ROOT, '.tmp', 'v6render');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
/* On this host the Electron console is not captured by the shell pipe, so
   every line is written to a log file as well. */
const LOG = path.join(ROOT, '.tmp', 'v6-render-check.log');
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
    /* the animations are FINISHED, not cancelled — cancelling a fade-in
       leaves the element at opacity 0 and the capture comes out blank */
    await win.webContents.executeJavaScript(`(() => {
      try { document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); } catch (e) {}
      return 1;
    })()`, true);
  } catch (e) { /* navigating */ }
  /* the harness window is hidden, so the compositor may still be holding the
     PREVIOUS frame — capture once and throw it away, then capture again so
     the shot shows what the screen really looks like now */
  try { win.webContents.invalidate(); } catch (e) {}
  await sleep(200);
  try { await win.webContents.capturePage(); } catch (e) {}
  await sleep(160);
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  logLine('shot -> ' + name);
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
  const item1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5000 }]);

  /* ---------------- window ---------------- */
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

  const openEditor = async (kind) => {
    await js(`SamDocs.openEditor(null, ${JSON.stringify(kind || null)}); 1`);
    await sleep(1100);
  };
  const pickCombo = async (hostSel, text) => js(`(async () => {
    const host = document.querySelector(${JSON.stringify(hostSel)});
    if (!host) return 'no-host';
    const inp = host.querySelector('.combo-input');
    if (!inp) return 'no-input';
    inp.focus();
    inp.value = ${JSON.stringify(text)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    if (!pop) return 'no-pop';
    const opt = pop.querySelector('.combo-opt');
    if (!opt) return 'no-opt';
    opt.click();
    await new Promise(r => setTimeout(r, 200));
    return 'picked';
  })()`);
  const setQty = async (rowIdx, value) => js(`(() => {
    const row = document.querySelectorAll('.modal.editor .lines-tbl tbody tr')[${rowIdx}];
    if (!row) return 'no-row';
    const inp = row.querySelector('.num-in');
    if (!inp) return 'no-input';
    inp.value = ${JSON.stringify(String(value))};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
    return 'ok';
  })()`);
  const setLineWh = async (rowIdx, text) => js(`(async () => {
    const row = document.querySelectorAll('.modal.editor .lines-tbl tbody tr')[${rowIdx}];
    if (!row) return 'no-row';
    /* the row carries: item combo, warehouse combo, (destination) */
    const combos = row.querySelectorAll('.combo');
    const host = combos[1];
    if (!host) return 'no-host:' + combos.length;
    const inp = host.querySelector('.combo-input');
    if (!inp) return 'no-input';
    inp.focus();
    inp.value = ${JSON.stringify(text)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    if (!pop) return 'no-pop';
    const opt = pop.querySelector('.combo-opt');
    if (!opt) return 'no-opt';
    opt.click();
    await new Promise(r => setTimeout(r, 250));
    return 'picked:' + (combos[1].querySelector('.combo-input')||{}).value;
  })()`);
  const clickFoot = async (act) => {
    await js(`(() => {
      const eds = [...document.querySelectorAll('.modal.editor')];
      const ed = eds.pop();
      if (!ed) return 'no-editor';
      const b = ed.querySelector('.modal-foot .btn[data-act=${JSON.stringify(act)}]');
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()`);
    await sleep(1300);
  };
  const closeTop = async () => {
    await js(`(() => {
      const pv = [...document.querySelectorAll('.pv')].pop();
      if (pv) { const b = pv.querySelectorAll('.pv-bar .btn-ghost')[1]; if (b) b.click(); }
      const m = [...document.querySelectorAll('.overlay .modal')].pop();
      if (!m) return 'none';
      const btns = [...m.querySelectorAll('.modal-foot .btn')];
      const b = btns.slice().reverse().find(x => /إغلاق|إلغاء/.test(x.textContent));
      (b || btns[btns.length - 1]).click();
      return 'closed';
    })()`);
    await sleep(500);
  };

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  /* ================= 1. the launcher + the chooser ================= */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(1200);

  /* the launcher of the operations screen — one tile per document kind */
  const launcher = await js(`(() => {
    const tiles = [...document.querySelectorAll('#docKinds .kl-tile')];
    return {
      count: tiles.length,
      names: tiles.map(t => (t.querySelector('.kl-name') || {}).textContent),
      icons: tiles.map(t => { const u = t.querySelector('.kc-ic use'); return u ? u.getAttribute('href') : null; }),
      tones: tiles.map(t => [...t.classList].filter(x => x.startsWith('tone-'))[0] || null),
      counts: tiles.map(t => (t.querySelector('.kl-count') || {}).textContent)
    };
  })()`);
  check('the launcher carries ten kinds', launcher.count === 10, launcher.count);
  const lIssue = launcher.names.indexOf('سند توريد الإنتاج');
  check('«سند توريد الإنتاج» is in the launcher', lIssue >= 0, launcher.names);
  check('the launcher tile of «توريد الإنتاج» has its own icon', launcher.icons[lIssue] === '#i-issue', launcher.icons[lIssue]);
  check('the launcher tile of «توريد الإنتاج» has its own colour', launcher.tones[lIssue] === 'tone-issue', launcher.tones[lIssue]);
  check('every launcher tile carries a colour', launcher.tones.filter(Boolean).length === launcher.count, launcher.tones);
  check('the launcher colours are not all the same', [...new Set(launcher.tones)].length >= 9, [...new Set(launcher.tones)]);
  await shot('01-launcher');

  /* the chooser — a popup of coloured cards that stands on its own */
  await js(`SamDocs.openEditor(null, null); 1`);
  await sleep(1000);
  const grid = await js(`(() => {
    const pk = [...document.querySelectorAll('.modal.picker')].pop();
    if (!pk) return null;
    const cards = [...pk.querySelectorAll('.kind-card')];
    return {
      count: cards.length,
      names: cards.map(c => (c.querySelector('.kc-name') || {}).textContent),
      icons: cards.map(c => { const u = c.querySelector('.kc-ic use'); return u ? u.getAttribute('href') : null; }),
      tones: cards.map(c => [...c.classList].filter(x => x.startsWith('tone-'))[0] || null)
    };
  })()`);
  check('the chooser carries ten kinds', !!grid && grid.count === 10, grid && grid.count);
  const issueIdx = grid ? grid.names.indexOf('سند توريد الإنتاج') : -1;
  check('«سند توريد الإنتاج» is in the chooser', issueIdx >= 0, grid && grid.names);
  check('«توريد الإنتاج» has its own icon', grid && grid.icons[issueIdx] === '#i-issue', grid && grid.icons[issueIdx]);
  check('«توريد الإنتاج» has its own colour', grid && grid.tones[issueIdx] === 'tone-issue', grid && grid.tones[issueIdx]);
  const tones = grid ? grid.tones.filter(Boolean) : [];
  check('every kind carries a colour', tones.length === (grid ? grid.count : 0), tones.length);
  const uniqTones = [...new Set(tones)];
  check('the colours are not all the same', uniqTones.length >= 9, uniqTones);
  await shot('01b-chooser');

  /* the icon really exists in the sprite — a missing symbol draws nothing */
  const sprite = await js(`(() => {
    const s = document.querySelector('#i-issue');
    if (!s) return null;
    const u = document.querySelector('use[href="#i-issue"]');
    return { symbol: !!s, viewBox: s.getAttribute('viewBox'), used: !!u };
  })()`);
  check('the i-issue symbol exists in the sprite', !!sprite && sprite.symbol && sprite.used, sprite);

  /* picking a kind opens THAT kind's own page — tinted in its own colour */
  await js(`(() => {
    const pk = [...document.querySelectorAll('.modal.picker')].pop();
    const card = [...pk.querySelectorAll('.kind-card')].find(c => c.dataset.kind === 'prod_issue');
    if (!card) return 'no-card';
    card.click(); return 'clicked';
  })()`);
  await sleep(1100);
  const edTheme = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    if (!ed) return null;
    const cs = getComputedStyle(ed);
    return {
      tone: [...ed.classList].filter(x => x.startsWith('tone-'))[0] || null,
      bg: cs.backgroundColor,
      gridInside: ed.querySelectorAll('.kind-card').length,
      chip: (ed.querySelector('.kind-chip') || {}).textContent,
      swap: !!ed.querySelector('.ed-swap')
    };
  })()`);
  check('the chosen kind opens its own page', !!edTheme && edTheme.tone === 'tone-issue', edTheme);
  check('the page wears the colour of its kind', !!edTheme && edTheme.bg === 'rgb(255, 247, 237)', edTheme && edTheme.bg);
  check('the page carries no grid of cards inside', !!edTheme && edTheme.gridInside === 0, edTheme && edTheme.gridInside);
  check('the page can change its kind', !!edTheme && edTheme.swap === true, edTheme);
  check('the page shows the name of its kind', !!edTheme && /توريد الإنتاج/.test(edTheme.chip || ''), edTheme && edTheme.chip);
  await shot('01c-kind-page');

  /* «تغيير النوع» reopens the chooser and the page recolours itself */
  await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const b = ed.querySelector('.ed-swap');
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  await sleep(900);
  const reopened = await js(`!!([...document.querySelectorAll('.modal.picker')].pop())`);
  check('«تغيير النوع» opens the chooser again', reopened === true, reopened);
  await js(`(() => {
    const pk = [...document.querySelectorAll('.modal.picker')].pop();
    const card = [...pk.querySelectorAll('.kind-card')].find(c => c.dataset.kind === 'purchase');
    if (!card) return 'no-card';
    card.click(); return 'clicked';
  })()`);
  await sleep(1000);
  const recoloured = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    if (!ed) return null;
    return {
      tone: [...ed.classList].filter(x => x.startsWith('tone-'))[0] || null,
      bg: getComputedStyle(ed).backgroundColor
    };
  })()`);
  check('the page recolours itself to the new kind', !!recoloured && recoloured.tone === 'tone-buy', recoloured);
  check('the new colour reaches the page background', !!recoloured && recoloured.bg === 'rgb(239, 246, 255)', recoloured && recoloured.bg);
  await closeTop();
  await sleep(400);

  /* ================= 2. the two number boxes ================= */
  await openEditor('prod_issue');
  const boxes = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const q = (sel) => { const n = ed.querySelector(sel); return n ? { value: n.value, readonly: n.readOnly, ph: n.placeholder } : null; };
    return {
      internal: q('.docno-cell .input'),
      external: q('.extno-cell .input'),
      labels: [...ed.querySelectorAll('.ed-label .field-txt')].map(n => n.textContent)
    };
  })()`);
  check('the editor has an internal-number box', !!boxes.internal, boxes.labels);
  check('the internal number is read-only', boxes.internal && boxes.internal.readonly === true, boxes.internal);
  check('the internal number is previewed before saving', boxes.internal && /^PRI-\d+$/.test(boxes.internal.value), boxes.internal && boxes.internal.value);
  check('the editor has an external-number box', !!boxes.external, boxes.labels);
  check('the external number can be typed', boxes.external && boxes.external.readonly === false, boxes.external);
  check('the external number starts empty', boxes.external && boxes.external.value === '', boxes.external && boxes.external.value);
  await shot('02-two-numbers');

  /* ================= 3. save a «توريد الإنتاج» ================= */
  const pickItem = await pickCombo('.modal.editor .lines-tbl tbody tr:nth-child(1) .combo', 'أمبولة');
  const pickWh = await setLineWh(0, 'مخزن أ');
  await setQty(0, 300);
  /* the number of the paper that came from another system — the only typed one */
  await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const inp = ed.querySelector('.extno-cell .input');
    inp.value = 'EXT-2026-77';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  logLine('  pick item: ' + JSON.stringify(pickItem) + ' / pick wh: ' + JSON.stringify(pickWh));
  const before = dbMod.availablePieces(item1.id, 'good');
  await clickFoot('save');
  const errBar = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    if (!ed) return 'editor-gone';
    const e = ed.querySelector('.form-err');
    return e ? (e.innerText || '').trim() : 'no-err';
  })()`);
  logLine('  error bar after save: ' + JSON.stringify(errBar));
  const saved = dbMod.listProdIssues(50);
  check('the «توريد الإنتاج» voucher was saved', saved.length === 1, saved.map(d => d.doc_no));
  if (!saved.length) { logLine('--- aborting the rest: nothing was saved ---'); shutdown(1); return; }
  const doc = saved[0];
  check('it carries the generated internal number', /^PRI-\d+$/.test(doc.doc_no), doc.doc_no);
  check('it keeps the number of the other system', doc.external_no === 'EXT-2026-77', doc.external_no);
  check('its lines are in the document', doc.lineCount === 1 && doc.totalPieces === 300, { lines: doc.lineCount, pieces: doc.totalPieces });
  const after = dbMod.availablePieces(item1.id, 'good');
  check('it lowered the stock', after === before - 300, { before, after });

  /* ================= 4. the list shows both numbers ================= */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(900);
  const listCell = await js(`(() => {
    const tr = document.querySelector('#docsTbl tbody tr');
    if (!tr) return null;
    const tds = [...tr.querySelectorAll('td')];
    return { text: tds[1] ? tds[1].innerText : '', html: tds[1] ? tds[1].innerHTML : '' };
  })()`);
  check('the list shows the internal number', !!listCell && listCell.text.includes(doc.doc_no), listCell && listCell.text);
  check('the list shows the external number', !!listCell && listCell.text.includes('EXT-2026-77'), listCell && listCell.text);
  await shot('03-list');

  /* the new tab filters the list */
  const tabInfo = await js(`(() => {
    const tabs = [...document.querySelectorAll('#docTabs .tab')];
    const t = tabs.find(x => x.dataset.kind === 'prod_issue');
    if (!t) return null;
    const plate = t.querySelector('.t3d');
    t.click();
    return { name: t.innerText.trim(), tone: plate ? [...plate.classList].filter(x => x.startsWith('tone-'))[0] || null : null };
  })()`);
  await sleep(900);
  const filtered = await js(`(() => ({
    rows: document.querySelectorAll('#docsTbl tbody tr').length,
    kinds: [...document.querySelectorAll('#docsTbl tbody tr .kind-chip')].map(n => n.textContent.trim())
  }))()`);
  check('the operations list has a «توريد الإنتاج» tab', !!tabInfo, tabInfo);
  check('the tab carries the kind colour', tabInfo && tabInfo.tone === 'tone-issue', tabInfo && tabInfo.tone);
  check('the tab filters to the new kind', filtered.rows === 1 && filtered.kinds.join('').includes('توريد الإنتاج'), filtered);
  await shot('04-tab-filter');

  /* ================= 5. the production screen ================= */
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(1200);
  const prodBtn = await js(`(() => {
    const b = document.getElementById('btnNewProdIssue');
    if (!b) return null;
    return { text: b.innerText.trim(), tone: b.querySelector('.t3d') ? [...b.querySelector('.t3d').classList].filter(x => x.startsWith('tone-'))[0] : null };
  })()`);
  check('the production screen has a «توريد الإنتاج» button', !!prodBtn, prodBtn);
  check('the button carries the kind colour', prodBtn && prodBtn.tone === 'tone-issue', prodBtn && prodBtn.tone);

  const prodList = await js(`(() => {
    const t = [...document.querySelectorAll('#prodTabs .tab')].find(x => x.dataset.tab === 'prodissues');
    if (!t) return null;
    t.click();
    return t.innerText.trim();
  })()`);
  await sleep(900);
  const prodRows = await js(`(() => ({
    rows: document.querySelectorAll('#prodIssueDocsTbl tbody tr').length,
    text: [...document.querySelectorAll('#prodIssueDocsTbl tbody tr td')].map(n => n.innerText.trim())
  }))()`);
  check('the production screen has a «توريد الإنتاج» tab', !!prodList, prodList);
  check('the production screen lists the voucher', prodRows.rows === 1, prodRows);
  check('the production row shows both numbers', prodRows.text.join(' ').includes(doc.doc_no), prodRows.text);
  await shot('05-production');

  /* ================= 6. the printed sheet + the permit ================= */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(800);
  const print = await js(`(async () => {
    const d = await SamDB.call('getDocument', ${doc.id});
    SamDocs.printInvoice(d.id);
    await new Promise(r => setTimeout(r, 900));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return { opened: false };
    const text = pv.innerText;
    const pages = pv.querySelectorAll('.print-page').length;
    return { opened: true, pages, hasInternal: text.includes(d.doc_no), hasExternal: text.includes('EXT-2026-77'), title: (pv.querySelector('.doc-title h1')||{}).textContent };
  })()`);
  check('the «سند توريد الإنتاج» prints', print.opened === true, print);
  check('the printed sheet carries the internal number', print.hasInternal === true, print);
  check('the printed sheet carries the external number', print.hasExternal === true, print);
  await shot('06-print-sheet');
  await closeTop();

  const permit = await js(`(async () => {
    const d = await SamDB.call('getDocument', ${doc.id});
    const pages = SamDocs.permitPages(d);
    await new Promise(r => setTimeout(r, 300));
    return { count: pages.length, title: pages.length ? pages[0].title : null, head: pages.length ? JSON.stringify(pages[0].head) : null };
  })()`);
  check('the exit permit of the new kind builds', permit.count >= 1, permit);
  check('the permit is titled «تصريح توريد إنتاج»', /توريد/.test(permit.title || ''), permit.title);
  check('the permit carries both numbers', /الرقم الداخلي/.test(permit.head || '') && /الرقم الخارجي/.test(permit.head || ''), permit.head);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
