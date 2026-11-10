/**
 * tools/v4-render-check.js — end-to-end verification of the V4 document editor.
 * Seeds a small dataset, then drives the REAL renderer:
 *   · the kind card grid (9 kinds, each with its name, icon and colour)
 *   · the header that follows the chosen kind (name, badge, colour, chip)
 *   · the per-kind fields (party / destination / direction / default store)
 *   · no default value in any box
 *   · the item column keeps its width
 *   · saving a production receipt, an adjustment and a gate order
 *   · the exit permits of the new kinds
 * Writes .tmp/v4shots/*.png and prints PASS/FAIL for every check.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v4-render-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v4shots');
const DATA = path.join(ROOT, '.tmp', 'v4render');
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
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.message ? e.message : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

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
  const whB = dbMod.addWarehouse({ code: 'W-B', name: 'مخزن ب', location: 'خلف خط النفخ' });
  const item1 = dbMod.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'أمبولة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: whA.id, good: 5000 }, { warehouseId: whB.id, good: 3000 }]);
  const item2 = dbMod.addItem({ code: '0002', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام' },
    [{ warehouseId: whA.id, good: 1000 }]);
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  dbMod.addParty({ name: 'شركة الأمل', phone: '0555000000', type: 'supplier' });

  /* ---------------- window ---------------- */
  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); console.log('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  /* --- the helpers that drive a real user --- */
  /** open the editor on a fresh document */
  const openEditor = async () => { await js(`SamDocs.openEditor(null); 1`); await sleep(900); };
  /** click the kind card whose name matches */
  const pickKind = async (name) => {
    await js(`(() => {
      const card = [...document.querySelectorAll('.modal.editor .kind-card')]
        .find(c => (c.querySelector('.kc-name')||{}).textContent === ${JSON.stringify(name)});
      if (!card) return 'no-card';
      card.click();
      return 'ok';
    })()`);
    await sleep(350);
  };
  /** pick an option from a searchable combo, exactly like a user would */
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
  /** type a number into the quantity box of a line */
  const setQty = async (rowIdx, value) => js(`(() => {
    const row = document.querySelectorAll('.modal.editor .lines-tbl tbody tr')[${rowIdx}];
    if (!row) return 'no-row';
    const inp = row.querySelector('.num-in');
    inp.value = ${JSON.stringify(String(value))};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
    return 'ok';
  })()`);
  /** click the editor footer button */
  const clickFoot = async (act) => {
    await js(`(() => {
      const b = document.querySelector('.modal.editor .modal-foot .btn[data-act=${JSON.stringify(act)}]');
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()`);
    await sleep(1100);
  };
  const closeTop = async () => {
    await js(`(() => {
      /* the print preview (.pv) is not a modal — close it first */
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
  /** is any overlay still covering the app? */
  const overlayOpen = async () => js(`(() => ({
    pv: document.querySelectorAll('.pv').length,
    modal: document.querySelectorAll('.overlay .modal').length
  }))()`);

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);

  /* ================= 1. the kind card grid ================= */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(900);
  await openEditor();

  const grid = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const cards = [...ed.querySelectorAll('.kind-card')];
    return {
      count: cards.length,
      names: cards.map(c => (c.querySelector('.kc-name')||{}).textContent),
      hints: cards.map(c => ((c.querySelector('.kc-hint')||{}).textContent || '').length > 10),
      icons: cards.map(c => { const u = c.querySelector('.kc-ic use'); return u ? u.getAttribute('href') : null; }),
      tones: cards.map(c => [...c.classList].filter(x => x.startsWith('tone-'))[0] || null),
      on: cards.filter(c => c.classList.contains('on')).length
    };
  })()`);
  check('the kind grid shows one card per document kind', grid && grid.count === 9, grid && grid.count);
  check('every card carries a name, a hint and an icon',
    grid && grid.hints.every(Boolean) && grid.icons.every((i) => !!i && i.startsWith('#')), grid && { hints: grid.hints, icons: grid.icons });
  check('every card owns its own colour', grid && new Set(grid.tones).size === 9, grid && grid.tones);
  check('the names are the nine document kinds',
    grid && JSON.stringify(grid.names) === JSON.stringify(['مشتريات', 'مبيعات', 'مرتجع مبيعات', 'مرتجع مشتريات',
      'نقل بين المخازن', 'سند استلام الإنتاج', 'إذن إدخال', 'إذن خروج', 'تسوية جرد']), grid && grid.names);
  check('exactly one card is selected', grid && grid.on === 1, grid && grid.on);
  await shot('01-kind-grid');

  /* ================= 2. the header follows the kind ================= */
  const headOf = async () => js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const badge = ed.querySelector('.ed-badge use');
    const chip = ed.querySelector('.kind-chip');
    return {
      title: (ed.querySelector('.ed-txt h3')||{}).textContent,
      badge: badge ? badge.getAttribute('href') : null,
      tone: [...ed.classList].filter(c => c.startsWith('tone-'))[0] || null,
      chip: chip ? chip.textContent.trim() : null,
      chipTone: chip ? [...chip.classList].filter(c => c.startsWith('tone-'))[0] : null,
      chipIcon: chip && chip.querySelector('use') ? chip.querySelector('use').getAttribute('href') : null
    };
  })()`);
  const h1 = await headOf();
  check('the header names the chosen kind', h1 && h1.chip === 'مشتريات' && h1.title === 'مستند جديد', h1);

  await pickKind('سند استلام الإنتاج');
  const h2 = await headOf();
  check('choosing another kind changes the header title', h2 && h2.chip === 'سند استلام الإنتاج', h2);
  check('the header badge follows the kind icon', h2 && h2.badge === '#i-factory' && h2.chipIcon === '#i-factory', h2);
  check('the header colour follows the kind', h2 && h2.tone === 'tone-produce' && h2.chipTone === 'tone-produce', h2);
  check('the header of one kind differs from another', h1 && h2 && h1.badge !== h2.badge && h1.tone !== h2.tone, { h1, h2 });
  await shot('02-header-production');

  /* ================= 3. the per-kind fields ================= */
  const fieldsOf = async () => js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const vis = (sel) => { const n = ed.querySelector(sel); if (!n) return null; const s = getComputedStyle(n); return s.display !== 'none'; };
    const ths = [...ed.querySelectorAll('.lines-tbl thead th')];
    const colVisible = (label) => { const th = ths.find(x => x.textContent.trim() === label); return th ? getComputedStyle(th).display !== 'none' : false; };
    return {
      party: vis('.party-cell'), value: vis('.value-cell'), dest: vis('.dest-cell'), whDefault: vis('.wh-default'),
      destCol: colVisible('الوجهة'), signCol: colVisible('الاتجاه'),
      ths: ths.map(x => x.textContent.trim()),
      partyCount: ed.querySelector('.party-cell .combo-opt') ? 1 : 0
    };
  })()`);

  const fProd = await fieldsOf();
  check('a production receipt hides the party and the invoice value', fProd && fProd.party === false && fProd.value === false, fProd);
  check('a production receipt shows no destination column', fProd && fProd.destCol === false, fProd);
  check('a production receipt has no default warehouse box', fProd && fProd.whDefault === false, fProd);

  /* the header and the row must always show the SAME columns, otherwise
     the body drifts under the wrong heading */
  const colCount = async () => js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const visTh = [...ed.querySelectorAll('.lines-tbl thead th')]
      .filter(t => getComputedStyle(t).display !== 'none').map(t => t.textContent.trim());
    const row = ed.querySelector('.lines-tbl tbody tr');
    const visTd = [...row.children].filter(td => getComputedStyle(td).display !== 'none').length;
    const combos = [...row.querySelectorAll('.combo')].filter(c => getComputedStyle(c.closest('td')).display !== 'none').length;
    return { ths: visTh, td: visTd, combos };
  })()`);
  const cProd = await colCount();
  check('the header and the row show the same columns',
    cProd && cProd.ths.length === cProd.td, cProd);
  check('a production receipt shows exactly two combos (item + warehouse)',
    cProd && cProd.combos === 2, cProd);

  await pickKind('تسوية جرد');
  const fAdj = await fieldsOf();
  check('an adjustment shows the direction column', fAdj && fAdj.signCol === true, fAdj);
  check('an adjustment hides the party and the destination', fAdj && fAdj.party === false && fAdj.destCol === false, fAdj);

  await pickKind('نقل بين المخازن');
  const fTr = await fieldsOf();
  check('a transfer shows the destination column', fTr && fTr.destCol === true, fTr);
  check('a transfer hides the party', fTr && fTr.party === false, fTr);
  check('a transfer shows the default warehouse box', fTr && fTr.whDefault === true, fTr);

  await pickKind('مبيعات');
  const fSale = await fieldsOf();
  check('a sale shows the party and the invoice value', fSale && fSale.party === true && fSale.value === true, fSale);
  check('a sale hides the direction column', fSale && fSale.signCol === false, fSale);

  /* ================= 4. nothing carries a default ================= */
  await pickKind('مشتريات');
  const defaults = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const row = ed.querySelector('.lines-tbl tbody tr');
    const money = ed.querySelector('.value-cell input');
    const item = row.querySelector('.item-c .combo-input');
    const wh = row.querySelector('.wh-c .combo-input');
    const dest = ed.querySelector('.dest-cell .combo-input');
    const head = ed.querySelector('.wh-default .combo-input');
    const g = (n) => (n ? n.value.trim() : null);
    return { money: g(money), item: g(item), wh: g(wh), dest: g(dest), head: g(head) };
  })()`);
  check('the invoice value starts empty', defaults && defaults.money === '', defaults);
  check('the item box starts empty', defaults && defaults.item === '', defaults);
  check('the line warehouse starts empty', defaults && defaults.wh === '', defaults);
  check('the destination box starts empty', defaults && defaults.dest === '', defaults);
  check('the default warehouse box starts empty', defaults && defaults.head === '', defaults);

  /* ================= 5. the item column keeps its width ================= */
  const widths = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const th = ed.querySelector('.lines-tbl th.item-h');
    const tbl = ed.querySelector('.lines-tbl');
    const wrap = ed.querySelector('.lines-wrap');
    const prev = ed.style.width;
    /* squeeze the window: the item column must NOT be crushed, the table
       has to scroll sideways instead */
    ed.style.width = '760px';
    const item = Math.round(th.getBoundingClientRect().width);
    const scroll = wrap.scrollWidth;
    const client = wrap.clientWidth;
    ed.style.width = prev;
    return {
      item,
      scroll,
      client,
      table: tbl ? Math.round(tbl.getBoundingClientRect().width) : 0,
      wrap: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0
    };
  })()`);
  check('the item column is wide enough', widths && widths.item >= 260, widths);
  check('the item column never shrinks below 260px on a narrow window',
    widths && widths.item >= 260, widths);
  check('the table scrolls sideways instead of crushing the item column',
    widths && widths.scroll > widths.client, widths);

  /* ================= 6. the caret opens the list without typing ================= */
  await js(`(() => {
    const row = document.querySelectorAll('.modal.editor .lines-tbl tbody tr')[0];
    const inp = row.querySelector('.item-c .combo-input');
    inp.focus();
    const caret = row.querySelector('.item-c .combo-caret');
    caret.click();
    return 1;
  })()`);
  await sleep(400);
  const popOpen = await js(`(() => {
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    return { open: pops.length > 0, options: pop ? pop.querySelectorAll('.combo-opt').length : 0 };
  })()`);
  check('the caret opens the list with an empty box', popOpen && popOpen.open && popOpen.options > 0, popOpen);
  await shot('03-combo-open');
  await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);

  /* ================= 7. saving a production receipt ================= */
  await pickKind('سند استلام الإنتاج');
  const before = dbMod.availableInLocation(item1.id, whA.id, 'good', null);
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .item-c .combo', '0001');
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .wh-c .combo', 'W-A');
  await setQty(0, 250);
  await shot('04-production-filled');
  await clickFoot('save');
  await sleep(900);
  const after = dbMod.availableInLocation(item1.id, whA.id, 'good', null);
  check('a production receipt increases the stock', after === before + 250, { before, after });
  const prodDocs = dbMod.listDocuments({ kind: 'prod_receipt' });
  check('the production receipt is stored as a document', prodDocs.length === 1, prodDocs.map((d) => d.doc_no));
  const prodDoc = prodDocs.length ? dbMod.getDocument(prodDocs[0].id) : null;
  check('its line names its own warehouse', prodDoc && prodDoc.lines[0].warehouse_id === whA.id, prodDoc && prodDoc.lines[0]);
  check('the ledger row carries the same document number',
    prodDoc && prodDoc.lines[0].pieces === 250 && prodDoc.doc_no.startsWith('PRC-'), prodDoc && { no: prodDoc.doc_no, pieces: prodDoc.lines[0].pieces });

  /* ================= 8. the adjustment direction is required ================= */
  await openEditor();
  await pickKind('تسوية جرد');
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .item-c .combo', '0001');
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .wh-c .combo', 'W-A');
  await setQty(0, 30);
  await clickFoot('save');
  const adjErr = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const b = ed.querySelector('.form-err');
    return { text: b ? b.textContent.trim() : '', open: !!ed };
  })()`);
  check('an adjustment without a direction is refused', adjErr && /اتجاه السطر 1/.test(adjErr.text), adjErr);

  const adjBefore = dbMod.availableInLocation(item1.id, whA.id, 'good', null);
  await js(`(() => {
    const row = document.querySelectorAll('.modal.editor .lines-tbl tbody tr')[0];
    const btns = [...row.querySelectorAll('.sign-seg .s-btn')];
    const down = btns.find(b => b.textContent.trim() === 'عجز');
    down.click();
    return btns.length;
  })()`);
  await sleep(250);
  await clickFoot('save');
  await sleep(700);
  const adjAfter = dbMod.availableInLocation(item1.id, whA.id, 'good', null);
  check('an adjustment shortage lowers the stock', adjAfter === adjBefore - 30, { adjBefore, adjAfter });
  const adjDocs = dbMod.listDocuments({ kind: 'adjustment' });
  const adjDoc = adjDocs.length ? dbMod.getDocument(adjDocs[0].id) : null;
  check('the adjustment line keeps its direction', adjDoc && Number(adjDoc.lines[0].sign) === -1, adjDoc && adjDoc.lines[0]);

  /* ================= 9. a gate order ================= */
  await openEditor();
  await pickKind('إذن خروج');
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .item-c .combo', '0002');
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .wh-c .combo', 'W-A');
  await setQty(0, 40);
  await clickFoot('save');
  await sleep(600);
  const gateDocs = dbMod.listDocuments({ kind: 'gate_out' });
  check('a gate exit order is stored', gateDocs.length === 1, gateDocs.map((d) => d.doc_no));

  /* ================= 10. the permits of the new kinds ================= */
  const prodPermits = await js(`(async () => {
    const doc = await SamDB.call('getDocument', ${prodDoc.id});
    const pages = SamDocs.permitPages(doc);
    return { count: pages.length, title: pages[0] ? pages[0].title : null, head: pages[0] ? pages[0].head.map(h => h.k) : [] };
  })()`);
  check('a production receipt prints an exit permit of the production',
    prodPermits && prodPermits.count === 1 && prodPermits.title === 'تصريح خروج إنتاج', prodPermits);
  check('the production permit names the warehouse and the document',
    prodPermits && prodPermits.head.includes('المخزن') && prodPermits.head.includes('رقم المستند'), prodPermits && prodPermits.head);

  const gatePermits = await js(`(async () => {
    const doc = await SamDB.call('getDocument', ${gateDocs[0].id});
    const pages = SamDocs.permitPages(doc);
    return { count: pages.length, title: pages[0] ? pages[0].title : null };
  })()`);
  check('a gate exit order prints the gate permit',
    gatePermits && gatePermits.count === 1 && gatePermits.title === 'تصريح خروج من المصنع', gatePermits);

  await js(`SamDocs.printPermits(${prodDoc.id}); 1`);
  await sleep(900);
  await shot('05-permit-production');
  const pvSheets = await js(`document.querySelectorAll('.pv .sheet').length`);
  check('the production permit reaches the print preview', pvSheets === 1, pvSheets);
  await closeTop();
  const cleared = await overlayOpen();
  check('the print preview closes and leaves the screen clear',
    cleared && cleared.pv === 0 && cleared.modal === 0, cleared);

  /* ================= 11. the document list shows the kind ================= */
  const listRow = await js(`(() => {
    const tr = document.querySelector('#docsTbl tbody tr');
    if (!tr) return null;
    const chip = tr.querySelector('.kind-chip');
    return { chip: chip ? chip.textContent.trim() : null, icon: chip && chip.querySelector('use') ? chip.querySelector('use').getAttribute('href') : null };
  })()`);
  check('every document in the list shows its kind with an icon', listRow && listRow.icon && listRow.icon.startsWith('#'), listRow);
  await shot('06-list');

  /* ================= 12. the production screen ================= */
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(1100);

  const prodBtns = await js(`(() => {
    const head = document.querySelector('#v-production .view-actions');
    const b = document.getElementById('btnNewProdReceipt');
    const tabs = [...document.querySelectorAll('#prodTabs .tab')].map(t => t.dataset.tab);
    return { label: b ? b.textContent.trim() : null, tabs, primary: b ? b.classList.contains('btn-primary') : false };
  })()`);
  check('the production screen offers the production receipt', prodBtns && /سند استلام الإنتاج/.test(prodBtns.label || ''), prodBtns && prodBtns.label);
  check('the production screen has its own tabs', prodBtns && prodBtns.tabs.includes('prodreceipts') && prodBtns.tabs.includes('gap'), prodBtns && prodBtns.tabs);

  /* the button opens the document editor already on the production kind */
  await js(`document.getElementById('btnNewProdReceipt').click(); 1`);
  await sleep(1000);
  const opened = await js(`(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    if (!ed) return null;
    const chip = ed.querySelector('.kind-chip');
    const on = ed.querySelector('.kind-card.on .kc-name');
    const route = ed.querySelector('.route-fill');
    return {
      chip: chip ? chip.textContent.trim() : null,
      on: on ? on.textContent.trim() : null,
      routeVisible: route ? getComputedStyle(route).display !== 'none' : false
    };
  })()`);
  check('the button opens the editor on the production kind', opened && opened.chip === 'سند استلام الإنتاج' && opened.on === 'سند استلام الإنتاج', opened);
  check('the production receipt offers the routing quick-fill', opened && opened.routeVisible === true, opened);

  /* the quick-fill takes the warehouses from the production routing */
  dbMod.setProdRouting({ fgGoodWh: whB.id, fgDefectWh: whA.id, rawDefectWh: whA.id, bagItemId: null, bagWhId: null });
  await pickCombo('.modal.editor .lines-tbl tbody tr:first-child .item-c .combo', '0001');
  await js(`document.querySelector('.modal.editor .route-fill').click(); 1`);
  await sleep(700);
  const filled = await js(`(() => {
    const row = document.querySelector('.modal.editor .lines-tbl tbody tr:first-child');
    const inp = row.querySelector('.wh-c .combo-input');
    return inp ? inp.value.trim() : '';
  })()`);
  check('the quick-fill fills the line from the routing', /مخزن ب/.test(filled || ''), filled);
  await closeTop();

  /* ================= 13. the shortage section ================= */
  /* the daily production report is documentation only — it must not move the stock */
  const stockBeforeReport = dbMod.availableInLocation(item1.id, whA.id, 'good', null);
  const today = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();
  dbMod.saveReceipt({
    doc_date: today, raw_item_id: item2.id, carton_no: 'C-TEST-1', carton_pieces: 100,
    lines: [{ item_id: item1.id, good: 80, defect_cans: 5, defect_ampoules: 0, bags_used: 2, breaks: 3 }]
  });
  const stockAfterReport = dbMod.availableInLocation(item1.id, whA.id, 'good', null);
  check('the daily production report does not touch the stock', stockBeforeReport === stockAfterReport, { stockBeforeReport, stockAfterReport });

  await js(`document.querySelector('#prodTabs .tab[data-tab=gap]').click(); 1`);
  await sleep(1200);
  const gap = await js(`(() => {
    const tb = document.querySelector('#gapTbl tbody');
    const rows = tb ? tb.querySelectorAll('tr').length : 0;
    const first = tb && tb.querySelector('tr') ? [...tb.querySelector('tr').children].map(c => c.textContent.trim()) : [];
    const foot = document.getElementById('gapFoot').textContent.replace(/\\s+/g, ' ').trim();
    return { rows, first, foot };
  })()`);
  check('the shortage section lists the production reports', gap && gap.rows === 1, gap && gap.rows);
  check('the shortage row shows the shortage and the damage', gap && gap.first.join('|').indexOf('15') >= 0, gap && gap.first);
  check('the shortage totals are shown', gap && /العجز/.test(gap.foot) && /15/.test(gap.foot), gap && gap.foot);
  await js(`document.getElementById('gapTbl').scrollIntoView({ block: 'center' }); 1`);
  await shot('07-gap-section');

  /* ================= 14. the production receipt documents ================= */
  await js(`document.querySelector('#prodTabs .tab[data-tab=prodreceipts]').click(); 1`);
  await sleep(800);
  const prodList = await js(`(() => {
    const tb = document.querySelector('#prodDocsTbl tbody');
    const rows = tb ? tb.querySelectorAll('tr').length : 0;
    const first = tb && tb.querySelector('tr') ? [...tb.querySelector('tr').children].map(c => c.textContent.trim()) : [];
    return { rows, first };
  })()`);
  check('the production receipts are listed with their warehouses',
    prodList && prodList.rows === 1 && /مخزن أ/.test(prodList.first.join('|')), prodList);
  await shot('08-prod-receipts');

  /* ================= 15. no «محرز» anywhere in the renderer ================= */  const held = await js(`(() => {
    const hits = [];
    document.querySelectorAll('*').forEach(n => {
      if (n.children.length === 0 && /محرز/.test(n.textContent || '')) hits.push((n.textContent || '').trim().slice(0, 40));
    });
    return hits;
  })()`);
  check('the screen shows no «محرز» bucket', held && held.length === 0, held);

  const srcHeld = (() => {
    const out = [];
    const dir = path.join(RENDERER, 'js');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      txt.split('\n').forEach((line, i) => { if (/محرز/.test(line)) out.push(`${f}:${i + 1}`); });
    }
    const html = fs.readFileSync(path.join(RENDERER, 'app.html'), 'utf8');
    html.split('\n').forEach((line, i) => { if (/محرز/.test(line)) out.push(`app.html:${i + 1}`); });
    return out;
  })();
  check('no renderer file mentions «محرز» any more', srcHeld.length === 0, srcHeld);

  /* ================= 16. the report centre is a window ================= */
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(1200);
  const launcher = await js(`(() => ({
    cards: document.querySelectorAll('#rptCards .rpt-card').length,
    icons: [...document.querySelectorAll('#rptCards .rpt-card .rc-ic use')].map(u => u.getAttribute('href')),
    titles: [...document.querySelectorAll('#rptCards .rpt-card .rc-t b')].map(b => b.textContent.trim())
  }))()`);
  check('the reports screen is a launcher with one card per report', launcher && launcher.cards === 9, launcher && launcher.cards);
  check('every report card carries its own icon', launcher && launcher.icons.every((i) => i && i.startsWith('#')), launcher && launcher.icons);
  check('every report card is named', launcher && launcher.titles.every((t) => t.length > 3), launcher && launcher.titles);

  /* a card opens the report window */
  await js(`document.querySelector('#rptCards .rpt-card[data-report=movements]').click(); 1`);
  await sleep(1600);
  const rw = await js(`(() => ({
    overlay: document.querySelectorAll('.rw-overlay').length,
    title: document.querySelector('.rw-head h3') ? document.querySelector('.rw-head h3').textContent.trim() : null,
    rail: document.querySelectorAll('.rw-rail .rw-item').length,
    railIcons: [...document.querySelectorAll('.rw-rail .rw-item .rw-ic use')].map((u) => u.getAttribute('href')),
    frows: document.querySelectorAll('.rw-content .rw-frow').length,
    combos: document.querySelectorAll('.rw-content .combo').length,
    table: !!document.getElementById('reportTbl'),
    rows: document.querySelectorAll('#reportTbl tbody tr').length,
    cols: document.querySelectorAll('#reportTbl thead th').length,
    foot: document.getElementById('reportFoot') ? document.getElementById('reportFoot').textContent.trim() : '',
    actions: [...document.querySelectorAll('.rw-actions .btn')].map((b) => b.textContent.trim())
  }))()`);
  check('a report card opens the report window', rw && rw.overlay === 1, rw && rw.overlay);
  check('the window is titled مركز التقارير', rw && rw.title === 'مركز التقارير', rw && rw.title);
  check('the window lists the nine reports, each with an icon',
    rw && rw.rail === 9 && rw.railIcons.every((i) => i && i.startsWith('#')), rw && { rail: rw.rail, icons: rw.railIcons });
  check('the window carries the filter panel', rw && rw.frows === 5 && rw.combos === 4, rw && { frows: rw.frows, combos: rw.combos });
  check('the preview shows the movement rows', rw && rw.table && rw.rows > 0 && rw.cols > 0, rw && { rows: rw.rows, cols: rw.cols });
  check('the footer totals the report', rw && rw.foot.indexOf('عدد الأسطر') >= 0, rw && rw.foot);
  check('the window offers Excel, print, PDF and close',
    rw && rw.actions.some((a) => a.indexOf('Excel') >= 0) && rw.actions.some((a) => a.indexOf('طباعة') >= 0)
      && rw.actions.some((a) => a.indexOf('PDF') >= 0) && rw.actions.some((a) => a.indexOf('إغلاق') >= 0), rw && rw.actions);
  await shot('09-report-window');

  /* double-clicking a row opens the source document, with edit + hard delete.
     The first row may be an opening balance (no source document), so the row
     that belongs to a real document is the one that must open. */
  const dbl = await js(`(() => {
    const rows = (window.SamReports.state.result && window.SamReports.state.result.rows) || [];
    const i = rows.findIndex((r) => r.docId);
    if (i < 0) return 'no-doc-row';
    const tr = document.querySelectorAll('#reportTbl tbody tr')[i];
    if (!tr) return 'no-tr';
    tr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'clicked ' + i;
  })()`);
  await sleep(1400);
  const docView = await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return null;
    return {
      title: m.querySelector('h3') ? m.querySelector('h3').textContent.trim() : null,
      btns: [...m.querySelectorAll('.modal-foot .btn')].map((b) => b.textContent.trim())
    };
  })()`);
  check('double-clicking a report row opens the source document',
    docView && docView.title && docView.title.indexOf('—') > 0, docView && docView.title);
  check('the source document offers تعديل and حذف نهائي',
    docView && docView.btns.some((b) => b.indexOf('تعديل') >= 0) && docView.btns.some((b) => b.indexOf('حذف نهائي') >= 0),
    docView && docView.btns);
  await shot('10-source-document');
  await closeTop();

  /* the column chooser really changes the table (the repaint is async, so
     every read waits for it) */
  await js(`document.getElementById('btnNoCols').click(); 1`);
  await sleep(1300);
  const noCols = await js(`(() => {
    const err = document.querySelector('.rw-error');
    return {
      cols: document.querySelectorAll('#reportTbl thead th').length,
      err: err ? err.textContent.trim() : ''
    };
  })()`);
  check('cancelling every column is refused with a clear message',
    noCols && noCols.cols === 0 && noCols.err.indexOf('عمود') >= 0, noCols);

  await js(`(() => {
    const box = [...document.querySelectorAll('#colsWrap .col-check')].find((x) => x.textContent.indexOf('كود الصنف') >= 0);
    if (!box) return 'no-box';
    box.querySelector('input').click();
    return 'clicked';
  })()`);
  await sleep(1300);
  const oneCol = await js(`({
    cols: document.querySelectorAll('#reportTbl thead th').length,
    head: [...document.querySelectorAll('#reportTbl thead th')].map((t) => t.textContent.trim())
  })`);
  check('picking one column leaves exactly one column', oneCol && oneCol.cols === 1, oneCol);
  check('the surviving column is the one that was picked',
    oneCol && oneCol.head[0] === 'كود الصنف', oneCol && oneCol.head);
  await js(`document.getElementById('btnAllCols').click(); 1`);
  await sleep(1300);
  const allCols = await js(`document.querySelectorAll('#reportTbl thead th').length`);
  check('selecting every column brings them all back', allCols > 10, allCols);

  /* another report from the rail brings its own table, and hides the columns row */
  await js(`document.querySelector('.rw-rail .rw-item[data-key=stock_status]').click(); 1`);
  await sleep(1400);
  const stock = await js(`(() => {
    const row = document.querySelector('.rw-f-cols');
    return {
      colsRow: row ? getComputedStyle(row).display : null,
      cols: document.querySelectorAll('#reportTbl thead th').length,
      rows: document.querySelectorAll('#reportTbl tbody tr').length,
      head: [...document.querySelectorAll('#reportTbl thead th')].map((t) => t.textContent.trim())
    };
  })()`);
  check('the columns row belongs to the movement report only', stock && stock.colsRow === 'none', stock && stock.colsRow);
  check('the other report brings its own columns and rows',
    stock && stock.cols > 0 && stock.rows > 0, stock && { cols: stock.cols, rows: stock.rows });
  check('the stock report shows the balance columns',
    stock && stock.head.join('|').indexOf('سليم') >= 0 && stock.head.join('|').indexOf('تالف') >= 0, stock && stock.head);
  await shot('11-stock-status');

  /* the daily report opens in the same shell, without the rail */
  await js(`SamReportWindow.close(); 1`);
  await sleep(500);
  await js(`document.querySelector('.nav-item[data-view=daily]').click(); 1`);
  await sleep(1300);
  await js(`document.getElementById('btnDailyWindow').click(); 1`);
  await sleep(1600);
  const dw = await js(`(() => ({
    overlay: document.querySelectorAll('.rw-overlay').length,
    title: document.querySelector('.rw-head h3') ? document.querySelector('.rw-head h3').textContent.trim() : null,
    rail: document.querySelector('.rw-rail') ? getComputedStyle(document.querySelector('.rw-rail')).display : 'none',
    tbl: !!document.getElementById('dwTbl'),
    actions: [...document.querySelectorAll('.rw-actions .btn')].map((b) => b.textContent.trim())
  }))()`);
  check('the daily report opens in its own window', dw && dw.overlay === 1 && dw.title === 'التقرير اليومي', dw);
  check('the daily window carries no report rail', dw && dw.rail === 'none', dw && dw.rail);
  check('the daily window shows its table and its actions', dw && dw.tbl && dw.actions.length === 4, dw);
  await shot('12-daily-window');
  await js(`SamReportWindow.close(); 1`);
  await sleep(400);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  console.log(errors.length ? 'RENDERER ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(fail || errors.length ? 1 : 0);
});
