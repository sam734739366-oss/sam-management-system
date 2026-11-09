/**
 * tools/shot8.js — V2 smoke test (tasks 1..5).
 * Drives the real UI in a hidden window, checks the numbers behind it,
 * and writes screenshots to .tmp/shots8.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots8');
const DATA = path.join(ROOT, '.tmp', 'data8');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const checks = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const xlsx = require(path.join(ROOT, 'src', 'main', 'xlsx.js'));

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
}

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return true;
    } catch (e) {
      if (attempt === tries) { console.warn(`WARN: ${label} still locked after ${tries} tries (${e.code})`); return false; }
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  return false;
}

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (!cleanedUp) {
    cleanedUp = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    dbMod.close();
    await rmRetry(DATA, { label: 'temp data dir' });
    await rmRetry(path.join(ROOT, '.tmp', 'xlsx8'), { tries: 4, label: 'xlsx out dir' });
  }
  app.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.message ? e.message : e));
  if (errors.length) console.log('RENDERER ERRORS:\n' + errors.join('\n'));
  shutdown(1);
});
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 1000, raw = false) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  /* A hidden window gets no compositor frames, so entry animations sit frozen
     at their 0% keyframe (opacity 0). Finish them so the capture is honest —
     unless the shot is *of* an animation (raw = true). */
  if (!raw) {
    try {
      /* capturePage forces exactly one compositor frame, which is the only
         thing that advances animations in a hidden window: tick once, then
         cancel any entry animation so nothing is caught at its 0% keyframe. */
      await win.webContents.capturePage();
      await win.webContents.executeJavaScript(
        `(() => { try { document.getAnimations().forEach(a => a.cancel()); } catch (e) {} return 1; })()`, true);
    } catch (e) { /* page may be navigating */ }
    await sleep(60);
  }
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

  const main = dbMod.getMainWarehouse();
  dbMod.addItem({ code: '0001', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12, pieces_per_bag: 0, min_good_alert: 500, max_defect_alert: 200 },
    [{ warehouseId: main.id, good: 24000 }]);
  dbMod.addItem({ code: '9001', name: 'كيس بلاستيك', base_unit: 'كيس', category: 'ملحقات', pieces_per_carton: 0, pieces_per_bag: 0 },
    [{ warehouseId: main.id, good: 1000 }]);
  dbMod.addItem({ code: '5001', name: 'أمبولة منفوخة', base_unit: 'حبة', category: 'منتج تام', pieces_per_carton: 24, pieces_per_bag: 20 },
    [{ warehouseId: main.id, good: 5000 }]);
  const idOf = (code) => dbMod.listItems(code)[0].id;
  const AMPOULE = idOf('5001');
  const cust = dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });
  const hangar = dbMod.addWarehouse({ code: 'H02', name: 'هنجر التالف', kind: 'sub', location: 'خلف الخط' });
  dbMod.setProdRouting({ fgGoodWh: main.id, fgDefectWh: hangar.id, rawDefectWh: hangar.id, bagItemId: idOf('9001'), bagWhId: main.id });

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) errors.push(`[console] ${d.source || ''}:${d.lineNumber || ''} ${d.message}`);
  });
  win.webContents.on('did-fail-load', (_e, c, m, u) => errors.push(`[load] ${c} ${m} ${u}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`[gone] ${JSON.stringify(d)}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const step = async (label, code) => {
    try { const v = await js(code); console.log('  ' + label + ' -> ' + JSON.stringify(v)); return v; }
    catch (e) { console.log('  ' + label + ' FAILED: ' + e.message); throw e; }
  };

  /* ================= 1) login screen is clean + bright ================= */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(900);
  const loginState = await step('login page', `({
    hasParticles: !!document.querySelector('.fx'),
    hasSkip: !!document.getElementById('skipBtn'),
    hasBottle: !!document.getElementById('loginCard') || !!document.querySelector('.lc-bottle'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    cardBg: getComputedStyle(document.querySelector('.login-card')).backgroundColor,
    title: getComputedStyle(document.querySelector('.lc-word h1')).color
  })`);
  check('login has no particle canvas', loginState.hasParticles === false, loginState.hasParticles);
  check('login has no skip-intro button', loginState.hasSkip === false, loginState.hasSkip);
  check('login background is bright', /248, 250, 252|255, 255, 255/.test(loginState.bodyBg), loginState.bodyBg);
  await shot('v2-01-login');

  await step('wrong password rejected', `(() => {
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'nope';
    document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    return 'sent';
  })()`);
  await sleep(700);
  await step('error text', `document.getElementById('loginError').textContent`);

  /* ================= 2) login -> intro overlay plays ================= */
  // exactly what the login form does before handing over to app.html
  await step('set the just-logged-in marker', `sessionStorage.setItem('sam.justLoggedIn','1')`);
  await step('admin login', `sam.auth.login('admin','admin123').then(r => r.ok ? r.data.username : 'FAIL ' + r.error)`);
  await sleep(700);
  const introEarly = await step('intro overlay present', `(() => {
    const ov = document.querySelector('.intro-ov');
    return { exists: !!ov, bottle: !!(ov && ov.querySelector('.io-bottle')), canvas: !!(ov && ov.querySelector('.io-fx')) };
  })()`);
  check('post-login intro overlay appears', introEarly.exists && introEarly.canvas && introEarly.bottle, introEarly);
  // a hidden window never ticks rAF/CSS animations, so pin the bottle to its
  // visible mid-frame purely so the screenshot can show the composition
  await step('pin intro frame for the capture', `(() => {
    const b = document.querySelector('.io-bottle');
    if (b) { b.className = 'io-bottle s-in'; b.style.animation = 'none'; b.style.opacity = '1'; }
    return 'pinned';
  })()`);
  await shot('v2-02-intro', 0, true);
  await sleep(1700);
  const introAfter = await step('intro finished', `({ overlay: !!document.querySelector('.intro-ov'), dashActive: document.getElementById('v-dashboard').classList.contains('active') })`);
  check('intro removes itself within ~2s', introAfter.overlay === false && introAfter.dashActive, introAfter);
  await shot('v2-03-dashboard');

  /* ================= 3) items form: no default zeros + comma format ================= */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(900);
  const itemsHead = await step('items header', `[...document.querySelectorAll('#itemsTbl thead th')].map(t=>t.textContent.trim())`);
  check('no "محجوز" anywhere in the DOM', !/(محجوز)/.test(await js('document.body.innerText')), 'checked');
  check('held column renamed to محرز', itemsHead.includes('محرز'), itemsHead);

  await js(`document.getElementById('btnAddItem').click()`);
  await sleep(700);
  const formProbe = await step('new item form defaults', `(() => {
    const m = document.querySelector('.modal');
    const nums = [...m.querySelectorAll('[data-num="1"]')];
    return {
      numericCount: nums.length,
      allEmpty: nums.every(n => n.value === ''),
      allPlaceholderZero: nums.every(n => n.placeholder === '0'),
      infoHints: [...m.querySelectorAll('.hint-txt')].map(h => h.textContent).filter(t => t.includes('معلوماتي'))
    };
  })()`);
  check('numeric fields start empty (no default 0)', formProbe.allEmpty && formProbe.numericCount >= 4, formProbe);
  check('carton/bag marked informational', formProbe.infoHints.length >= 2, formProbe.infoHints);

  await step('type 1200000 -> blur shows commas', `(() => {
    const m = document.querySelector('.modal');
    const n = m.querySelectorAll('[data-num="1"]')[0];
    n.focus(); n.value = '1200000';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.blur();
    n.dispatchEvent(new Event('blur', { bubbles: true }));
    return n.value;
  })()`).then((v) => check('thousands separator applied on blur', String(v).includes(','), v));

  // cancel the form, then use the API for the rest
  await js(`document.querySelector('.modal .modal-foot .btn-ghost').click()`);
  await sleep(400);

  /* ================= 4) sale bigger than stock warns, then saves ================= */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(900);
  const shortDocs = await step('oversized sale via db returns warnings', `(() => 1)()`);
  void shortDocs;
  const doc = dbMod.saveDocument({
    kind: 'sale', doc_date: '2026-10-30', party_id: cust.id, warehouse_id: main.id,
    invoice_value: '1,250,000', notes: 'اختبار رصيد سالب',
    lines: [{ item_id: AMPOULE, bucket: 'good', pieces: 6000, cartons: 0, bags: 0 }]
  });
  check('negative stock saved with a warning instead of blocking', Array.isArray(doc.warnings) && doc.warnings.length === 1, doc.warnings);
  const afterSale = dbMod.availablePieces(AMPOULE, 'good');
  check('balance went negative as expected', afterSale === -1000, afterSale);

  /* ================= 5) UI sale editor: warning modal appears ================= */
  await step('items visible to the renderer', `SamDB.call('listItems','').then(r => r.map(i => [i.code, i.name, i.is_active, i.base_unit]))`);
  await js(`document.getElementById('btnNewDoc').click()`);
  await sleep(900);
  await step('switch the editor to مبيعات', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    [...ed.querySelectorAll('.seg-btn')].find(b => b.textContent.trim() === 'مبيعات').click();
    return ed.querySelectorAll('.seg-btn.on')[0].textContent.trim();
  })()`);
  const pickCombo = (query) => `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const host = ${JSON.stringify(query)};
    // V3: a line now carries three combos (item, warehouse, destination), so
    // the item combo is found by its cell, not by its position in the list.
    const inp = host === 'party'
      ? ed.querySelector('.party-cell .combo-input')
      : ed.querySelector('.lines-tbl tbody tr td:first-child .combo-input');
    if (!inp) return -1;
    inp.focus(); inp.value = host === 'party' ? 'موزع' : 'أمبولة';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const pop = [...document.querySelectorAll('.combo-pop')].filter(x => x.style.display !== 'none').pop();
    return pop ? pop.querySelectorAll('.combo-opt').length : 0;
  })()`;
  await step('type into the party combo', pickCombo('party'));
  await sleep(300);
  await step('pick the party', `(() => {
    const pop = [...document.querySelectorAll('.combo-pop')].filter(x => x.style.display !== 'none').pop();
    pop.querySelector('.combo-opt').click();
    return 'picked';
  })()`);
  await sleep(300);
  await step('type into the item combo', pickCombo('item'));
  await sleep(300);
  await step('pick the item', `(() => {
    const pop = [...document.querySelectorAll('.combo-pop')].filter(x => x.style.display !== 'none').pop();
    pop.querySelector('.combo-opt').click();
    return 'picked';
  })()`);
  await sleep(700);
  const availRead = await step('availability + unit chip after picking', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    return {
      avail: ed.querySelector('.avail').textContent,
      lowClass: ed.querySelector('.avail').className,
      unit: ed.querySelector('.unit-chip') ? ed.querySelector('.unit-chip').textContent : null
    };
  })()`);
  check('unit chip shows the picked item base unit', availRead.unit === 'حبة', availRead);
  check('available column resolved', availRead.avail !== '—', availRead);

  await step('set a quantity bigger than stock', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const qty = ed.querySelector('.lines-tbl tbody [data-num="1"]');
    qty.focus(); qty.value = '999999';
    qty.dispatchEvent(new Event('input', { bubbles: true }));
    qty.blur();
    qty.dispatchEvent(new Event('blur', { bubbles: true }));
    return { value: qty.value, low: ed.querySelector('.avail').className };
  })()`);
  await sleep(400);
  const ampBefore = dbMod.availablePieces(AMPOULE, 'good');
  // V3: an external invoice number is mandatory, so the editor refuses to
  // save without it — the harness has to fill it like a real user would.
  await step('fill the external invoice number', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const inp = [...ed.querySelectorAll('input')].find(i => /رقم الفاتورة/.test(i.placeholder || ''));
    if (!inp) return 'no invoice-number field';
    inp.focus(); inp.value = 'EXT-1001';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value;
  })()`);
  await sleep(250);
  await step('click save', `[...document.querySelectorAll('.modal.editor')].pop().querySelector('.modal-foot .btn-primary').click()`);
  await sleep(900);
  const warnUi = await step('warning dialog shown', `(() => {
    const m = [...document.querySelectorAll('.modal.info')].pop();
    return { present: !!m, title: m ? m.querySelector('h3').textContent : null, body: m ? m.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null };
  })()`);
  check('insufficient stock raises a confirm dialog, not an error', warnUi.present && /غير كاف/.test(warnUi.title || ''), warnUi.title);
  check('dialog names the item and the negative result', /999,999|999999/.test(warnUi.body || '') && /-/.test(warnUi.body || ''), warnUi.body);
  await shot('v2-04-negative-stock-warning');
  await step('confirm and continue', `(() => {
    const m = [...document.querySelectorAll('.modal.info')].pop();
    [...m.querySelectorAll('.modal-foot .btn')].find(b => /متابعة/.test(b.textContent)).click();
    return 'confirmed';
  })()`);
  await sleep(1400);
  const ampAfter = dbMod.availablePieces(AMPOULE, 'good');
  check('saving after the warning wrote the document', ampAfter === ampBefore - 999999, [ampBefore, ampAfter]);
  const uiDocCount = await step('document list refreshed with the new sale', `document.querySelectorAll('#docsTbl tbody tr').length`);
  check('the sale appears in the grid', uiDocCount >= 2, uiDocCount);
  await shot('v2-05-after-negative-sale');

  /* ================= 6) invoice value: empty + grouped + YER ================= */
  const invUi = await step('invoice value field', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    return 'gone';
  })()`);
  void invUi;
  await js(`document.getElementById('btnNewDoc').click()`);
  await sleep(800);
  const invProbe = await step('invoice value props', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const cells = [...ed.querySelectorAll('.ed-cell')];
    const cell = cells.find(c => /قيمة الفاتورة/.test(c.querySelector('label').textContent));
    const inp = cell.querySelector('input');
    return { label: cell.querySelector('label').textContent, empty: inp.value === '', placeholder: inp.placeholder, affix: cell.querySelector('.affix-txt') ? cell.querySelector('.affix-txt').textContent : null };
  })()`);
  check('invoice value starts empty with 0 placeholder', invProbe.empty && invProbe.placeholder === '0', invProbe);
  check('invoice value shows the currency', /ريال/.test(invProbe.affix || '') && /ريال/.test(invProbe.label), invProbe);
  await js(`[...document.querySelectorAll('.modal.editor')].pop().querySelector('.modal-foot .btn-ghost:last-of-type').click()`);
  await sleep(300);

  /* ================= 7) tolling: customer material + scrap register ================= */
  const tol = dbMod.saveTolling({
    doc_date: '2026-10-30', party_id: cust.id, raw_item_id: AMPOULE, warehouse_id: main.id,
    pieces_in: 4000, bags_in: 10, note: 'نفخ للغير',
    lines: [{ item_id: AMPOULE, good: 3000, defect: 600, bags: 8 }]
  });
  check('tolling order numbered', /^TOL-/.test(tol.doc_no), tol.doc_no);
  check('tolling totals computed', tol.totalGood === 3000 && tol.totalDefect === 600, [tol.totalGood, tol.totalDefect]);
  const scrapRows = dbMod.listScrap({});
  check('defect written to scrap_movements with is_customer=1', scrapRows.length === 1 && scrapRows[0].is_customer === 1 && scrapRows[0].pieces === 600,
    scrapRows.map((s) => [s.pieces, s.is_customer, s.partyName]));
  check('tolling moves tagged is_customer', dbMod.reportQuery({ buckets: ['good', 'defect'], onlyCustomer: true }).rows.length >= 3,
    dbMod.reportQuery({ buckets: ['good', 'defect'], onlyCustomer: true }).rows.map((r) => [r.docType, r.delta]));

  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(1200);
  await js(`document.querySelector('#prodTabs .tab[data-tab=tolling]').click()`);
  await sleep(800);
  await step('tolling table row', `[...document.querySelectorAll('#tollingTbl tbody tr')].map(t=>[t.children[1].textContent.trim(), t.children[3].textContent.trim(), t.children[5].textContent.trim(), t.children[6].textContent.trim(), t.children[7].textContent.trim()])`);
  await js(`document.getElementById('btnNewTolling').click()`);
  await sleep(900);
  await shot('v2-05b-tolling-form');
  await step('close tolling form', `(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    const btn = [...m.querySelectorAll('.modal-foot .btn')].find(b => /إلغاء/.test(b.textContent));
    if (btn) btn.click();
    return 'closed';
  })()`);
  await sleep(400);
  await js(`document.querySelector('#prodTabs .tab[data-tab=scrap]').click()`);
  await sleep(700);
  const scrapShot = await step('scrap table', `[...document.querySelectorAll('#scrapTbl tbody tr')].map(t=>[t.children[2].textContent.trim(), t.children[3].textContent.trim(), t.children[5].textContent.trim()])`);
  check('scrap register renders the customer-owned row', /العميل|موزع/.test(JSON.stringify(scrapShot)), scrapShot);
  await shot('v2-05-scrap-register');

  /* ================= 8) production: bag fractions ================= */
  const rec = dbMod.saveReceipt({
    doc_date: '2026-10-30', raw_item_id: AMPOULE, carton_no: 'C-01', carton_pieces: 5000,
    bags_used: 250, note: 'اختبار الكسر',
    lines: [{ item_id: AMPOULE, bags_used: 250, breaks: 100, defect_cans: 40, defect_ampoules: 20 }]
  });
  // 250 bags x 20 units - 100 breaks = 4900 good, computed by the server too
  check('good pieces auto-computed from bags and breaks', rec.lines[0].good === 4900, rec.lines.map((l) => [l.good, l.bags_used, l.breaks]));
  check('shortage/surplus derived from the produced total', rec.produced_total === 4960 && rec.shortage === 40 && rec.surplus === 0,
    [rec.produced_total, rec.shortage, rec.surplus]);

  await js(`document.querySelector('#prodTabs .tab[data-tab=receipts]').click()`);
  await js(`document.getElementById('btnNewReceipt').click()`);
  await sleep(900);
  const autoGood = await step('bag fractions auto-fill good in the UI', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const inp = ed.querySelector('.lines-tbl .combo-input');
    inp.focus(); inp.value = 'أمبولة';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const pop = [...document.querySelectorAll('.combo-pop')].filter(x => x.style.display !== 'none').pop();
    return { opts: pop ? pop.querySelectorAll('.combo-opt').length : 0, items: ed.querySelectorAll('.combo-input').length };
  })()`);
  await sleep(400);
  await step('pick product then bags + breaks', `(() => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    [...document.querySelectorAll('.combo-pop')].filter(x => x.style.display !== 'none').pop().querySelector('.combo-opt').click();
    const nums = [...ed.querySelectorAll('.lines-tbl tbody [data-num="1"]')];
    const set = (n, v) => { n.focus(); n.value = String(v); n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('blur', { bubbles: true })); };
    set(nums[0], 100); // bags
    set(nums[1], 30);  // breaks
    return { good: nums[2].value, unit: ed.querySelector('.unit-chip') ? ed.querySelector('.unit-chip').textContent : null };
  })()`).then((v) => check('UI computed good = 100 bags x 20 - 30 breaks = 1970', v.good === '1,970', v));
  await shot('v2-06-production-bag-fractions');
  await step('close receipt editor', `[...document.querySelectorAll('.modal.editor')].pop().querySelector('.modal-foot .btn-ghost:last-of-type').click()`);
  await sleep(400);

  /* ================= 9) archive: a record with no stock effect ================= */
  const before = dbMod.summary().mainPieces;
  dbMod.saveArchive({ doc_date: '2026-10-29', shift: 'نهارية', machine: 'خط 2', raw_item_id: AMPOULE, product_item_id: AMPOULE, cartons: 12, bags: 5, good: 900, defect: 40, note: 'يوم سابق' });
  const afterArchive = dbMod.summary().mainPieces;
  check('archive row stored', dbMod.listArchive().length === 1, dbMod.listArchive().map((a) => [a.doc_no, a.pieces]));
  check('archive changed no stock at all', before === afterArchive, [before, afterArchive]);
  await js(`document.querySelector('#prodTabs .tab[data-tab=archive]').click()`);
  await sleep(700);
  await step('archive table', `[...document.querySelectorAll('#archiveTbl tbody tr')].map(t=>[t.children[1].textContent.trim(), t.children[3].textContent.trim(), t.children[4].textContent.trim(), t.children[9].textContent.trim()])`);
  await shot('v2-07-archive');

  /* ================= 10) reports: default = good only, totals on visible cols ================= */
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(900);
  const buckets = await step('bucket checkboxes default', `[...document.querySelectorAll('#bucketWrap .col-check')].map(l => [l.textContent.trim(), l.querySelector('input').checked])`);
  check('only Good ticked by default', JSON.stringify(buckets) === JSON.stringify([['سليم', true], ['تالف', false], ['محرز', false]]), buckets);
  await step('widen the report period to cover the harness history', `(() => {
    document.getElementById('fFrom').value = '2026-10-01';
    document.getElementById('fTo').value = '2026-12-31';
    return [document.getElementById('fFrom').value, document.getElementById('fTo').value];
  })()`);
  await js(`document.getElementById('btnRunReport').click()`);
  await sleep(1200);
  const rep1 = await step('good-only report', `({ rows: SamReports ? undefined : undefined, count: document.querySelectorAll('#reportTbl tbody tr').length, foot: document.getElementById('reportFoot').textContent.replace(/\\s+/g,' ').slice(0,180) })`);
  check('report ran and shows rows', rep1.count > 0, rep1.count);
  check('footer sums visible numeric columns only', /وارد/.test(rep1.foot) && /صادر/.test(rep1.foot) && /صافي الحركة/.test(rep1.foot) && /الوحدة:/.test(rep1.foot), rep1.foot);
  await shot('v2-08-report-good-only');

  await shot('v2-08b-report-grid');
  // tick Defect + Held -> row count must grow, footer must follow the visible columns
  await step('tick defect + held', `(() => {
    [...document.querySelectorAll('#bucketWrap input')].forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
    return 'ticked';
  })()`);
  await sleep(1600);
  const rep2 = await step('all-buckets report', `({ count: document.querySelectorAll('#reportTbl tbody tr').length, foot: document.getElementById('reportFoot').textContent.replace(/\\s+/g,' ').slice(0,180) })`);
  check('adding buckets adds rows', rep2.count > rep1.count, [rep1.count, rep2.count]);

  await step('hide the IN column and re-check the footer', `(() => {
    const lab = [...document.querySelectorAll('#colsWrap .col-check')].find(l => /وارد/.test(l.textContent));
    const cb = lab.querySelector('input');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('reportFoot').textContent.replace(/\\s+/g,' ');
  })()`).then((foot) => check('footer drops the hidden column total', !/وارد:/.test(foot), foot.slice(0, 160)));

  // optional per-hangar breakdown
  await step('enable breakdown by hangar', `(() => {
    const lab = [...document.querySelectorAll('#optWrap .col-check')].find(l => /تفصيل/.test(l.textContent));
    const cb = lab.querySelector('input');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
    return 'on';
  })()`);
  await sleep(1600);
  await step('print report to preview', `document.getElementById('btnPrintReport').click()`);
  await sleep(1200);
  const pv = await step('print sheet structure', `(() => {
    const s = [...document.querySelectorAll('.pv .sheet')].pop();
    if (!s) return { present: false };
    const meta = [...s.querySelectorAll('.doc-meta .m-item')].map(n => n.textContent.replace(/\\s+/g,' ').trim());
    return {
      present: true,
      landscape: s.classList.contains('landscape'),
      title: s.querySelector('.doc-title h1').textContent,
      meta,
      signatures: [...s.querySelectorAll('.sig .nm')].map(n => n.textContent),
      wm: s.querySelector('.wm').textContent,
      wmColor: getComputedStyle(s.querySelector('.wm')).color,
      locationTable: /تفصيل حسب المخزن/.test(s.textContent)
    };
  })()`);
  check('print preview renders the premium sheet', pv.present && pv.landscape, pv.present && pv.landscape);
  check('centred meta holds period/buckets/rows', pv.meta && pv.meta.length === 3, pv.meta);
  check('signature band has the three roles', JSON.stringify(pv.signatures) === JSON.stringify(['المعد', 'المراجع', 'المدير']), pv.signatures);
  const wmAlpha = Number((pv.wmColor.match(/([\d.]+)\)\s*$/) || [0, 1])[1]);
  check('watermark is subtle', /775158678/.test(pv.wm) && wmAlpha <= 0.08, [pv.wm, pv.wmColor]);
  check('hangar breakdown printed', pv.locationTable, pv.locationTable);
  await step('layer census at print preview', `({
    previews: document.querySelectorAll('.pv').length,
    editors: document.querySelectorAll('.modal.editor').length,
    overlays: document.querySelectorAll('.overlay').length,
    pvZ: (() => { const p = document.querySelector('.pv'); return p ? getComputedStyle(p).zIndex + '/' + getComputedStyle(p).display : null; })(),
    pvBox: (() => { const p = document.querySelector('.pv'); return p ? JSON.stringify(p.getBoundingClientRect()) : null; })(),
    pvStyle: (() => { const p = document.querySelector('.pv'); if (!p) return null; const c = getComputedStyle(p); return [c.position, c.inset, c.opacity, c.visibility, c.transform, c.filter].join(' | '); })(),
    pvParent: (() => { const p = document.querySelector('.pv'); return p ? p.parentElement.className + '#' + p.parentElement.id : null; })(),
    topAtCenter: (() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); let n = e; const chain = []; while (n && chain.length < 5) { chain.push(n.tagName + '.' + (n.className || '').toString().split(' ')[0]); n = n.parentElement; } return chain.join(' < '); })(),
    anims: (() => {
      const one = (sel) => { const n = document.querySelector(sel); if (!n) return null; return { op: getComputedStyle(n).opacity, anims: n.getAnimations().map((a) => [a.animationName, a.playState, a.currentTime, a.effect.getTiming().fill].join(':')) }; };
      return { pv: one('.pv'), overlay: one('.overlay') };
    })()
  })`);
  await shot('v2-09-print-report');
  await step('close preview', `[...document.querySelectorAll('.pv')].pop().querySelector('.pv-bar .btn-ghost').click()`);
  await sleep(400);

  /* ================= 11) gate pass + invoice printing ================= */
  const saleDoc = dbMod.listDocuments({ kind: 'sale' })[0];
  await step('open gate pass preview', `SamDocs.printPermits(${saleDoc.id})`);
  await sleep(1200);
  const gp = await step('gate pass fields', `(() => {
    const s = [...document.querySelectorAll('.pv .sheet')].pop();
    return {
      title: s.querySelector('.doc-title h1').textContent,
      meta: [...s.querySelectorAll('.doc-meta .m-item')].map(n => n.textContent.replace(/\\s+/g,' ').trim()),
      sigs: [...s.querySelectorAll('.sig .nm')].map(n => n.textContent),
      hasPriceWords: /سعر|قيمة|ريال/.test(s.textContent)
    };
  })()`);
  check('gate pass titled and centred', /تصريح خروج/.test(gp.title || '') && gp.meta.length === 4, gp);
  check('gate pass signatures include السائق', gp.sigs.includes('السائق'), gp.sigs);
  check('gate pass shows no prices', gp.hasPriceWords === false, gp.hasPriceWords);
  await shot('v2-10-gate-pass');
  await step('close preview', `[...document.querySelectorAll('.pv')].pop().querySelector('.pv-bar .btn-ghost').click()`);
  await sleep(300);

  /* ================= 12) real xlsx export ================= */
  const ExcelJS = require('exceljs');
  const xlsxDir = path.join(ROOT, '.tmp', 'xlsx8');
  fs.mkdirSync(xlsxDir, { recursive: true });
  const file = path.join(xlsxDir, 'v2-report.xlsx');
  const res = dbMod.reportQuery({ buckets: ['good', 'defect', 'held'], byLocation: true });
  await xlsx.writeWorkbook({
    filePath: file,
    sheetName: 'حركة المخزون',
    title: 'تقرير حركة المخزون',
    subtitle: 'SAM Management System — 775158678',
    meta: [['عدد الأسطر', String(res.totals.rows)], ['الحالات', res.totals.bucketLabels.join(' + ')]],
    columns: [
      { header: 'التاريخ', key: 'createdAt' },
      { header: 'رقم المستند', key: 'docNo' },
      { header: 'الصنف', key: 'itemName' },
      { header: 'الحالة', key: 'bucket' },
      { header: 'وارد', key: 'inQty', num: true },
      { header: 'صادر', key: 'outQty', num: true },
      { header: 'صافي الحركة', key: 'delta', num: true },
      { header: 'الرصيد المتحرك', key: 'movingBalance', num: true }
    ],
    rows: res.rows,
    totals: [{ key: 'delta', value: res.totals.qty }, { key: 'inQty', value: res.rows.reduce((a, r) => a + r.inQty, 0) }]
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const headRow = ws.getRow(6);
  const bodyRow = ws.getRow(7);
  const numericCell = bodyRow.getCell(7);
  check('xlsx file written', fs.statSync(file).size > 5000, fs.statSync(file).size);
  check('numbers are real numeric cells with #,##0', numericCell.type === 2 && numericCell.numFmt === '#,##0', [numericCell.type, numericCell.numFmt]);
  check('header row branded', headRow.getCell(1).value === 'التاريخ' && headRow.getCell(1).fill.fgColor.argb === '2563EB', headRow.getCell(1).value);
  check('sheet is right-to-left', ws.views[0].rightToLeft === true, ws.views[0]);
  check('column widths auto-sized', ws.columns.slice(0, 3).every((c) => c.width >= 9), ws.columns.map((c) => Math.round(c.width)));
  check('totals row present and numeric', typeof ws.lastRow.getCell(7).value === 'number', ws.lastRow.getCell(7).value);

  /* ================= 13) hangars screen + keyboard shortcuts ================= */
  await js(`document.querySelector('.nav-item[data-view=warehouses]').click()`);
  await sleep(900);
  const whScreen = await step('hangars screen', `({
    title: document.getElementById('tbTitle').textContent,
    heads: [...document.querySelectorAll('#whTbl thead th')].map(t => t.textContent.trim()),
    rows: document.querySelectorAll('#whTbl tbody tr').length
  })`);
  check('warehouses screen named المخازن', /المخازن/.test(whScreen.title), whScreen.title);
  await shot('v2-11-hangars');

  const shortcuts = await step('Ctrl+N on the hangars screen', `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    return 'sent';
  })()`);
  void shortcuts;
  await sleep(700);
  const hangarForm = await step('hangar form opened by Ctrl+N', `(() => {
    const m = document.querySelector('.modal');
    return { any: !!m, editor: !!document.querySelector('.modal.editor'), title: m ? m.querySelector('h3').textContent : null };
  })()`);
  check('Ctrl+N opens the screen-specific "new" form', hangarForm.any === true && /مخزن/.test(hangarForm.title || ''), hangarForm);
  await step('Esc closes it', `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'sent';
  })()`);
  await sleep(500);
  check('Esc closes the modal', await js(`!document.querySelector('.modal')`));

  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(900);
  await step('Ctrl+N on the transactions screen', `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    return 'sent';
  })()`);
  await sleep(700);
  const afterCtrlN = await step('document editor opened by Ctrl+N', `!!document.querySelector('.modal.editor')`);
  check('Ctrl+N opens a new document editor on the operations screen', afterCtrlN === true, afterCtrlN);
  const escWorks = await step('Esc closes it', `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'sent';
  })()`);
  void escWorks;
  await sleep(600);
  check('Esc closes the document editor', await js(`!document.querySelector('.modal.editor')`));

  /* ================= 14) hard delete still reverses everything ================= */
  const beforeDel = dbMod.availablePieces(AMPOULE, 'good');
  dbMod.deleteDocument(saleDoc.id);
  const afterDel = dbMod.availablePieces(AMPOULE, 'good');
  check('hard delete reversed the sale exactly', afterDel - beforeDel === saleDoc.totalPieces, [beforeDel, afterDel, saleDoc.totalPieces]);
  const tolBefore = dbMod.availablePieces(AMPOULE, 'good');
  dbMod.deleteTolling(tol.id);
  check('deleting a tolling order removes its customer moves too',
    dbMod.reportQuery({ buckets: ['good', 'defect'], onlyCustomer: true }).rows.length === 0,
    dbMod.reportQuery({ buckets: ['good', 'defect'], onlyCustomer: true }).rows.length);
  void tolBefore;

  /* ================= summary ================= */
  console.log('\n--- V2 checks ---');
  const failed = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`));
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (errors.length) console.log('RENDERER ERRORS:\n' + errors.join('\n'));
  const code = failed.length || errors.length ? 1 : 0;
  await shutdown(code);
});
