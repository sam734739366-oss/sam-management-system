/**
 * tools/v7-sign-check.js — the signature footer of the printed documents.
 *
 * The customer complained that the footer of the print was wrong: an exit
 * permit must be signed by the warehouse keeper, the driver and the gate
 * guard, but a production receipt must NOT carry the driver — and the user
 * must be able to CHOOSE what the footer carries.
 *
 * This harness drives the REAL main process and the REAL renderer (the same
 * preload as the app) and proves:
 *   · every preset of every kind is exactly as it must be;
 *   · an exit permit carries the driver, a production receipt does not;
 *   · a report carries no signature footer at all;
 *   · the choice of the user survives a reload, and the reset brings the
 *     preset back;
 *   · the print preview shows the band, and clicking a chip takes the name
 *     out of the paper at once.
 *
 * Run: cd "C:/Users/Elite/Desktop/SAM-Management-System" &&
 *      env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-sign-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7signdata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the data folder of the test — it must be set BEFORE db.js is loaded */
process.env.SAM_DATA_DIR = DATA;

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const updater = require(path.join(ROOT, 'src', 'main', 'updater.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-sign-check.log');
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
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail ? 1 : 0); } });

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- the signature footer — harness starting ---');

/* ---------------- what the customer asked for ---------------- */
const EXPECTED = {
  exit_permit: ['أمين المخازن', 'السائق', 'حارس البوابة'],
  gate_in: ['حارس البوابة', 'أمين المخازن'],
  production_receipt: ['أمين المخازن', 'مسؤول الإنتاج', 'المدير'],
  production_issue: ['أمين المخازن', 'مسؤول الإنتاج', 'المدير'],
  invoice: ['أمين المخزن', 'المراجع', 'المدير'],
  transfer: ['أمين المخزن', 'السائق', 'المدير'],
  item_card: ['أمين المخزن', 'المراجع', 'المدير'],
  tolling_in: ['حارس البوابة', 'أمين المخازن'],
  report: []
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ================= the renderer ================= */
async function rendererTests() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 220) + ' :: ' + e.message);
    return null;
  });

  /* ---- the app opens, the user logs in ---- */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(800);
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(3000);

  /* the module must be there — it is loaded by ui.js (or by the <script>
     line of app.html) */
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await js(`!!(window.SamSignatures && window.SamSignatures.SIGN_PRESETS)`);
    if (!ready) await sleep(250);
  }
  check('the signature module is loaded in the app', ready === true);
  if (!ready) return;

  /* a clean slate — the tests must not see a choice of an earlier run */
  await js(`SamSignatures.clearAll(); true`);

  /* ================= 1. the presets ================= */
  const presets = await js(`(() => { const o = {}; for (const k in SamSignatures.SIGN_PRESETS) o[k] = SamSignatures.SIGN_PRESETS[k]; return o; })()`) || {};
  Object.keys(EXPECTED).forEach((k) => {
    check(`the preset of «${k}» is exactly as it must be`,
      same(presets[k], EXPECTED[k]), { got: presets[k], want: EXPECTED[k] });
  });
  check('there is no other kind of document',
    same(Object.keys(presets).sort(), Object.keys(EXPECTED).sort()), Object.keys(presets));

  /* ================= 2. what a print must carry ================= */
  const exit = await js(`SamSignatures.signaturesFor('exit_permit')`);
  check('an exit permit carries the keeper, the driver and the gate guard',
    same(exit, EXPECTED.exit_permit), exit);
  check('the driver signs the exit permit', Array.isArray(exit) && exit.includes('السائق'), exit);

  const prod = await js(`SamSignatures.signaturesFor('production_receipt')`);
  check('a production receipt carries no driver', Array.isArray(prod) && !prod.includes('السائق'), prod);
  check('a production receipt carries the production manager',
    Array.isArray(prod) && prod.includes('مسؤول الإنتاج'), prod);
  check('a production receipt carries the keeper and the manager',
    same(prod, EXPECTED.production_receipt), prod);

  const prodIssue = await js(`SamSignatures.signaturesFor('production_issue')`);
  check('a production issue carries no driver', Array.isArray(prodIssue) && !prodIssue.includes('السائق'), prodIssue);

  const rep = await js(`SamSignatures.signaturesFor('report')`);
  check('a report carries no signature footer', Array.isArray(rep) && rep.length === 0, rep);

  /* the kind of a print is understood even when the caller does not say it */
  const inferred = await js(`(() => ({
    exit: SamSignatures.resolveKind({ title: 'تصريح خروج من المصنع' }),
    receipt: SamSignatures.resolveKind({ title: 'سند استلام الإنتاج' }),
    issue: SamSignatures.resolveKind({ title: 'سند توريد الإنتاج' }),
    invoice: SamSignatures.resolveKind({ title: 'مبيعات' }),
    card: SamSignatures.resolveKind({ title: 'بطاقة رصيد صنف' }),
    report: SamSignatures.resolveKind({ title: 'تقرير الإنتاج اليومي' }),
    none: SamSignatures.resolveKind({})
  }))()`) || {};
  check('an exit permit is recognised', inferred.exit === 'exit_permit', inferred);
  check('a production receipt is recognised', inferred.receipt === 'production_receipt', inferred);
  check('a production issue is recognised', inferred.issue === 'production_issue', inferred);
  check('an invoice is recognised', inferred.invoice === 'invoice', inferred);
  check('an item card is recognised', inferred.card === 'item_card', inferred);
  check('a report is recognised', inferred.report === 'report', inferred);
  check('a document with no name at all still has a kind', !!inferred.none, inferred);

  /* the sheet itself takes the footer from the system */
  const sheetNames = await js(`(() => {
    const s = SamUI.sheet({ kind: 'production_receipt', title: 'سند استلام الإنتاج', bodyHtml: '' });
    return [...s.querySelectorAll('.sig .nm')].map(n => n.textContent.trim());
  })()`);
  check('the sheet of a production receipt carries no driver',
    Array.isArray(sheetNames) && !sheetNames.includes('السائق'), sheetNames);
  check('the sheet of a production receipt carries the three names',
    same(sheetNames, EXPECTED.production_receipt), sheetNames);

  const fallback = await js(`(() => {
    const s = SamUI.sheet({ title: 'ورقة بلا نوع', bodyHtml: '' });
    return [...s.querySelectorAll('.sig .nm')].map(n => n.textContent.trim());
  })()`);
  check('a document with no kind still prints a footer (and does not crash)',
    Array.isArray(fallback) && fallback.length === 2, fallback);

  /* ================= 3. the choice of the user ================= */
  const chosen = ['سائق الاختبار'];
  await js(`SamSignatures.setSignatureChoice('exit_permit', ${JSON.stringify(chosen)}); true`);
  const used = await js(`SamSignatures.signaturesFor('exit_permit')`);
  check('the choice of the user is used at once', same(used, chosen), used);
  check('the program knows the choice is there',
    (await js(`SamSignatures.hasSignatureChoice('exit_permit')`)) === true);

  /* ---- the choice survives a reload of the page ---- */
  win.reload();
  await sleep(2500);
  let back = false;
  for (let i = 0; i < 40 && !back; i++) {
    back = await js(`!!(window.SamSignatures && window.SamSignatures.SIGN_PRESETS)`);
    if (!back) await sleep(250);
  }
  check('the app opens again after the reload', back === true);
  const survived = await js(`SamSignatures.signaturesFor('exit_permit')`);
  check('the choice of the user survives the reload', same(survived, chosen), survived);

  /* ---- the reset brings the preset back ---- */
  await js(`SamSignatures.resetSignatureChoice('exit_permit'); true`);
  const restored = await js(`SamSignatures.signaturesFor('exit_permit')`);
  check('the reset brings the preset back', same(restored, EXPECTED.exit_permit), restored);
  check('the program knows the choice is gone',
    (await js(`SamSignatures.hasSignatureChoice('exit_permit')`)) === false);

  /* ================= 4. the print preview ================= */
  const openPreview = async (opts) => {
    await js(`document.querySelectorAll('.pv').forEach(n => n.remove()); true`);
    await js(`SamUI.printPreview(${JSON.stringify(opts)}); true`);
    await sleep(700);
    return js(`(() => ({
      open: !!document.querySelector('.pv'),
      cells: document.querySelectorAll('.pv .sheet .sig').length,
      names: [...document.querySelectorAll('.pv .sheet .sig .nm')].map(n => n.textContent.trim()),
      chips: [...document.querySelectorAll('.pv .pv-sig-chip')].map(c => c.dataset.name),
      pressed: [...document.querySelectorAll('.pv .pv-sig-chip')].map(c => c.getAttribute('aria-pressed'))
    }))()`);
  };

  /* ---- an exit permit ---- */
  const pvExit = await openPreview({ kind: 'exit_permit', title: 'تصريح خروج', bodyHtml: '<p>محتوى</p>' }) || {};
  check('the preview of the exit permit opens', pvExit.open === true, pvExit);
  check('the band of the exit permit carries three signatures', pvExit.cells === 3, pvExit);
  check('the band of the exit permit carries the right names',
    same(pvExit.names, EXPECTED.exit_permit), pvExit.names);
  check('the chips show the names of the footer',
    same(pvExit.chips, EXPECTED.exit_permit), pvExit.chips);
  check('the three chips are pressed (they are in the footer)',
    same(pvExit.pressed, ['true', 'true', 'true']), pvExit.pressed);

  /* ---- the row of the dialog itself ---- */
  const row = await js(`(() => {
    const r = document.querySelector('.pv .pv-sigs');
    if (!r) return null;
    return {
      text: (r.textContent || '').replace(/\\s+/g, ' ').trim(),
      chips: [...r.querySelectorAll('.pv-sig-chip')].map(c => c.textContent.trim()),
      add: !!r.querySelector('.pv-sig-add'),
      input: !!r.querySelector('.pv-sig-input'),
      reset: r.querySelector('.pv-sig-reset') ? (r.querySelector('.pv-sig-reset').textContent || '').trim() : null
    };
  })()`) || {};
  check('the print dialog carries a row for the signature footer', !!row.text, row);
  check('the row names the footer', /تذييل التوقيع/.test(row.text || ''), row.text);
  check('the row carries a chip per name', same(row.chips, EXPECTED.exit_permit), row.chips);
  check('the row carries the «+» of a name of its own', row.add === true && row.input === true, row);
  check('the row carries «رجوع للافتراضي»', /رجوع للافتراضي/.test(row.reset || ''), row.reset);

  /* ---- clicking the chip of the driver takes it out of the paper ---- */
  await js(`(() => {
    const c = [...document.querySelectorAll('.pv .pv-sig-chip')].find(x => x.dataset.name === 'السائق');
    if (c) c.click();
    return !!c;
  })()`);
  await sleep(500);
  const afterClick = await js(`(() => ({
    cells: document.querySelectorAll('.pv .sheet .sig').length,
    names: [...document.querySelectorAll('.pv .sheet .sig .nm')].map(n => n.textContent.trim()),
    chips: [...document.querySelectorAll('.pv .pv-sig-chip')].map(c => c.dataset.name),
    pressed: [...document.querySelectorAll('.pv .pv-sig-chip')].map(c => c.getAttribute('aria-pressed'))
  }))()`) || {};
  check('clicking the chip takes the name out of the band',
    afterClick.cells === 2 && !afterClick.names.includes('السائق'), afterClick);
  check('the chip stays in the row, so it can be put back',
    same(afterClick.chips, EXPECTED.exit_permit), afterClick.chips);
  check('the chip of the driver is not pressed any more',
    afterClick.pressed && afterClick.pressed[1] === 'false', afterClick.pressed);

  const remembered = await js(`SamSignatures.signaturesFor('exit_permit')`);
  check('the new footer is remembered for the next print',
    same(remembered, ['أمين المخازن', 'حارس البوابة']), remembered);

  /* ---- clicking it again puts the name back ---- */
  await js(`(() => {
    const c = [...document.querySelectorAll('.pv .pv-sig-chip')].find(x => x.dataset.name === 'السائق');
    if (c) c.click();
    return !!c;
  })()`);
  await sleep(500);
  const backOn = await js(`(() => ({
    cells: document.querySelectorAll('.pv .sheet .sig').length,
    names: [...document.querySelectorAll('.pv .sheet .sig .nm')].map(n => n.textContent.trim())
  }))()`) || {};
  check('clicking the chip again puts the name back',
    backOn.cells === 3 && backOn.names.includes('السائق'), backOn);

  /* ---- «رجوع للافتراضي» ---- */
  await js(`(() => { const b = document.querySelector('.pv .pv-sig-reset'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const afterReset = await js(`(() => ({
    cells: document.querySelectorAll('.pv .sheet .sig').length,
    names: [...document.querySelectorAll('.pv .sheet .sig .nm')].map(n => n.textContent.trim())
  }))()`) || {};
  check('the button brings the default of the kind back',
    same(afterReset.names, EXPECTED.exit_permit), afterReset);

  /* ---- a production receipt carries no driver ---- */
  const pvProd = await openPreview({ kind: 'production_receipt', title: 'سند استلام الإنتاج', bodyHtml: '<p>محتوى</p>' }) || {};
  check('the band of the production receipt carries three signatures', pvProd.cells === 3, pvProd);
  check('the band of the production receipt carries no driver',
    !pvProd.names.includes('السائق'), pvProd.names);
  check('the band of the production receipt carries the production manager',
    pvProd.names.includes('مسؤول الإنتاج'), pvProd.names);

  /* ---- a report carries no footer at all ---- */
  const pvReport = await openPreview({ kind: 'report', title: 'تقرير', bodyHtml: '<p>محتوى</p>' }) || {};
  check('the report carries no signature band', pvReport.cells === 0, pvReport);

  /* ---- an explicit array is the starting set ---- */
  const pvExplicit = await openPreview({
    kind: 'invoice', title: 'فاتورة', bodyHtml: '<p>محتوى</p>', signatures: ['أمين المخزن', 'المدير']
  }) || {};
  check('an explicit array is the starting set of the print',
    same(pvExplicit.names, ['أمين المخزن', 'المدير']), pvExplicit.names);

  /* ---- the choice of the user wins over the array of the caller ---- */
  await js(`SamSignatures.setSignatureChoice('invoice', ['المدير العام']); true`);
  const pvChosen = await openPreview({
    kind: 'invoice', title: 'فاتورة', bodyHtml: '<p>محتوى</p>', signatures: ['أمين المخزن', 'المدير']
  }) || {};
  check('the choice of the user wins over the array of the caller',
    same(pvChosen.names, ['المدير العام']), pvChosen.names);
  await js(`SamSignatures.resetSignatureChoice('invoice'); true`);

  /* ---- the kind is understood from the title alone ---- */
  const pvByTitle = await openPreview({ title: 'تصريح خروج من المصنع', bodyHtml: '<p>محتوى</p>' }) || {};
  check('the kind of the document is understood from its title',
    same(pvByTitle.names, EXPECTED.exit_permit), pvByTitle.names);

  /* ---- a document with no name at all still prints a footer ---- */
  const pvUnknown = await openPreview({ bodyHtml: '<p>محتوى</p>' }) || {};
  check('a document with no kind still prints the generic footer',
    same(pvUnknown.names, ['أمين المخزن', 'المدير']), pvUnknown.names);

  /* ---- the «+» takes a name of its own ---- */
  await js(`document.querySelectorAll('.pv').forEach(n => n.remove()); true`);
  await js(`SamUI.printPreview({ kind: 'invoice', title: 'فاتورة', bodyHtml: '<p>محتوى</p>' }); true`);
  await sleep(600);
  const added = await js(`(() => {
    const btn = document.querySelector('.pv .pv-sig-add');
    if (!btn) return { ok: false };
    btn.click();
    const input = document.querySelector('.pv .pv-sig-input');
    if (!input) return { ok: false };
    input.value = 'المدير العام';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok: true };
  })()`) || {};
  check('the «+» control is there', added.ok === true, added);
  await sleep(500);
  const withCustom = await js(`(() => ({
    names: [...document.querySelectorAll('.pv .sheet .sig .nm')].map(n => n.textContent.trim())
  }))()`) || {};
  check('a name of its own can be added to the footer',
    Array.isArray(withCustom.names) && withCustom.names.includes('المدير العام'), withCustom.names);

  await js(`document.querySelectorAll('.pv').forEach(n => n.remove()); true`);
}

/* ================= run ================= */
app.whenReady().then(async () => {
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
  updater.init(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4], line: a[5] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300) + ' @' + (d.source || '') + ':' + (d.line || ''));
  });

  logLine('\n===== the signature footer =====');
  await rendererTests();

  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  shutdown(fail ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
