/**
 * tools/v7-combo-check.js — the autocomplete dropdown (SamUI.combo) that every
 * screen uses for the items, the parties and the warehouses:
 *   · a plain CLICK on the field opens the list of ALL the options — the
 *     customer must not have to type to see what is inside
 *   · the list is STILL open after the mouse is released (it used to flash
 *     for a moment and then vanish)
 *   · an option can be picked with a plain click, and onChange fires
 *   · typing still filters the list, and the «no match» line still shows
 *   · Escape still closes the list
 * It drives the REAL renderer with REAL mouse and key events, on the REAL
 * combo() helper of the items screen.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-combo-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7combodata');
const RENDERER = path.join(ROOT, 'src', 'renderer');
/* a window that is really on the screen and really focused — a hidden one
   never gives the page the focus, and the focus event is the one that opens
   the list. SAM_COMBO_FOCUS=0 keeps the window hidden. */
const FOCUSABLE = process.env.SAM_COMBO_FOCUS !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-combo-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const errors = [];

/* ================= the window ================= */

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { dbMod.close(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  logLine(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code);
}
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');

/* ================= the mouse and the keyboard ================= */

/** a real mouse click at the given point of the page */
async function clickAt(x, y) {
  const px = Math.round(x), py = Math.round(y);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py });
  await sleep(40);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(70);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(90);
}
async function moveTo(x, y) {
  const px = Math.round(x), py = Math.round(y);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py });
  await sleep(60);
}
async function pressKey(key) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
  await sleep(120);
}
async function typeChar(ch) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
  win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
  await sleep(90);
}

/* ================= the helpers inside the page ================= */

/** finds the combo of the item field of the «smart search» window */
const INSTALL = `(() => {
  const field = () => {
    const f = [...document.querySelectorAll('.overlay .field')].find((n) => {
      const t = n.querySelector('.field-txt');
      return t && t.textContent.trim() === 'الصنف';
    });
    return f || null;
  };
  const input = () => { const f = field(); return f ? f.querySelector('.combo-input') : null; };
  const openPop = () => [...document.querySelectorAll('.combo-pop')].find((p) => p.style.display !== 'none') || null;
  window.__combo = {
    found: () => !!field(),
    input,
    state: () => {
      const p = openPop();
      const i = input();
      const f = field();
      const hidden = f ? f.querySelector('.combo-value') : null;
      return {
        open: !!p,
        options: p ? p.querySelectorAll('.combo-opt').length : 0,
        empty: p ? ((p.querySelector('.combo-empty') || {}).textContent || '').trim() : '',
        labels: p ? [...p.querySelectorAll('.combo-opt .label')].map((n) => n.textContent.trim()) : [],
        sel: p ? (((p.querySelector('.combo-opt.sel .label') || {}).textContent) || '').trim() : '',
        text: i ? i.value : '',
        value: hidden ? hidden.value : '',
        focused: i ? document.activeElement === i : false,
        spy: (window.__spy || []).slice()
      };
    },
    rect: (which) => {
      const f = field();
      if (!f) return null;
      let n = null;
      if (which === 'input') n = f.querySelector('.combo-input');
      else if (which === 'caret') n = f.querySelector('.combo-caret');
      else if (which === 'opt') { const p = openPop(); n = p ? p.querySelectorAll('.combo-opt')[0] : null; }
      else if (which === 'title') n = document.querySelector('.overlay .modal h3');
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    at: (x, y) => {
      const n = document.elementFromPoint(x, y);
      if (!n) return null;
      return (n.className || n.tagName) + ' | ' + (n.textContent || '').trim().slice(0, 40);
    }
  };
  return true;
})()`;

/* the trace of every mouse and focus event around the dropdown */
const TRACE = `(() => {
  window.__trace = [];
  const rec = (tag, e) => {
    const pop = [...document.querySelectorAll('.combo-pop')].find((p) => p.style.display !== 'none');
    const t = e && e.target;
    window.__trace.push({
      tag,
      on: t ? String(t.className || t.tagName).slice(0, 40) : null,
      open: !!pop,
      ms: Date.now()
    });
  };
  window.addEventListener('blur', (e) => rec('window-blur', e), true);
  window.addEventListener('focus', (e) => rec('window-focus', e), true);
  document.addEventListener('mousedown', (e) => rec('mousedown', e), true);
  document.addEventListener('mouseup', (e) => rec('mouseup', e), true);
  document.addEventListener('click', (e) => rec('click', e), true);
  document.addEventListener('focusin', (e) => rec('focusin', e), true);
  document.addEventListener('focusout', (e) => rec('focusout', e), true);
  return true;
})()`;

/* ================= the checks ================= */

async function comboTests() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });
  const state = () => js(`window.__combo.state()`);
  const rect = (w) => js(`window.__combo.rect(${JSON.stringify(w)})`);

  /* ---- the window of the items screen ---- */
  await js(`document.querySelector('.nav-item[data-view=items]').click()`);
  await sleep(1600);
  await js(`document.getElementById('btnSmartSearch').click()`);
  await sleep(900);
  const there = await js(`window.__combo.found()`);
  check('the item combo is on the screen', there === true, there);
  if (there !== true) return;

  /* ---- 1. a plain click opens the list of ALL the options ---- */
  let r = await rect('input');
  if (!r) { check('the combo field can be measured', false); return; }
  /* the caret sits on the left in an RTL field — click the text, not the arrow */
  const ix = r.w > 90 ? r.left + r.w * 0.75 : r.cx;
  const iy = r.cy;
  logLine('  the field is at ' + JSON.stringify({ x: Math.round(ix), y: Math.round(iy) }) + ' -> ' + (await js(`window.__combo.at(${Math.round(ix)}, ${Math.round(iy)})`)));
  check('the point of the click is on the text of the field',
    /combo-input/.test(String(await js(`window.__combo.at(${Math.round(ix)}, ${Math.round(iy)})`)) || ''),
    await js(`window.__combo.at(${Math.round(ix)}, ${Math.round(iy)})`));

  /* press the mouse and look before the release */
  logLine('  the focus before the press: ' + JSON.stringify(await js(`(() => ({
    active: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
    hasFocus: document.hasFocus(),
    same: document.activeElement === window.__combo.input()
  }))()`)));
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(ix), y: Math.round(iy) });
  await sleep(40);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(ix), y: Math.round(iy), button: 'left', clickCount: 1 });
  await sleep(90);
  const pressed = await state();
  logLine('  while the button is down: ' + JSON.stringify(pressed));
  logLine('  the trace of the press: ' + JSON.stringify(await js(`window.__trace`)));
  await js(`window.__trace = []`);

  /* now release the mouse */
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(ix), y: Math.round(iy), button: 'left', clickCount: 1 });
  await sleep(140);
  const released = await state();
  logLine('  after the release: ' + JSON.stringify(released));
  logLine('  the trace of the release: ' + JSON.stringify(await js(`window.__trace`)));

  check('the click opens the list', pressed.open === true && released.open === true,
    { pressed: pressed.open, released: released.open });
  check('the list shows every option — no typing needed',
    released.open === true && released.options >= 3 && released.empty === '',
    { options: released.options, empty: released.empty, labels: released.labels });
  check('the list is still open after the mouse is released',
    released.open === true, { open: released.open, options: released.options });
  check('the field has the focus while the list is open', released.focused === true, released.focused);

  /* ---- 2. the list stays open while the mouse moves over it ---- */
  const opt = await rect('opt');
  check('an option is on the screen', !!opt, opt);
  if (opt) {
    await moveTo(opt.cx, opt.cy);
    const over = await state();
    check('the list stays open while the mouse is over it', over.open === true,
      { open: over.open, options: over.options });
  }

  /* ---- 3. a plain click on an option picks it ---- */
  const before = await state();
  if (opt) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(opt.cx), y: Math.round(opt.cy) });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(opt.cx), y: Math.round(opt.cy), button: 'left', clickCount: 1 });
    await sleep(80);
    const mid = await state();
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(opt.cx), y: Math.round(opt.cy), button: 'left', clickCount: 1 });
    await sleep(160);
    const after = await state();
    logLine('  after the pick: ' + JSON.stringify(after));
    check('the option can be picked with a plain click',
      after.value !== '' && after.value !== before.value, { before: before.value, after: after.value });
    check('onChange fires when an option is picked',
      after.spy.length > before.spy.length && String(after.spy[after.spy.length - 1]) === after.value,
      { spy: after.spy, value: after.value });
    check('the picked item is written in the field', /—/.test(after.text) || after.text.length > 0, after.text);
    check('the list is still open while the option is pressed', mid.open === true, mid.open);
  }

  /* ---- 4. a filled field opens the list of ALL the options again ---- */
  /* the field must lose the focus first — that is the normal case: the user
     comes from another field and clicks on a field that already holds a
     value, and the list must open with every option, not with «no match» */
  const titleRect = await rect('title');
  if (titleRect) { await clickAt(titleRect.cx, titleRect.cy); await sleep(250); }
  const r2 = await rect('input');
  const jx = r2.w > 90 ? r2.left + r2.w * 0.75 : r2.cx;
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(jx), y: Math.round(r2.cy) });
  await sleep(40);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(jx), y: Math.round(r2.cy), button: 'left', clickCount: 1 });
  await sleep(90);
  const pressed2 = await state();
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(jx), y: Math.round(r2.cy), button: 'left', clickCount: 1 });
  await sleep(160);
  const again = await state();
  logLine('  the second click on a filled field: ' + JSON.stringify(again));
  check('a filled field opens the list of all the options again',
    again.open === true && again.options >= 3 && again.empty === '',
    { options: again.options, empty: again.empty, text: again.text });
  check('the current value is marked inside the list',
    again.sel !== '', { sel: again.sel, text: again.text });
  check('the list is still open after the release of the second click',
    again.open === true && pressed2.open === true, { pressed: pressed2.open, released: again.open });

  /* ---- 5. typing filters the list ---- */
  await typeChar('C');
  await sleep(150);
  const typed = await state();
  logLine('  after typing C: ' + JSON.stringify(typed));
  check('typing filters the list', typed.open === true && typed.options >= 1 && typed.options < 3,
    { options: typed.options, labels: typed.labels });
  check('the filter keeps the right option', typed.labels.length === 1 && /شريط/.test(typed.labels[0] || ''),
    typed.labels);

  /* ---- 6. the «no match» line ---- */
  await typeChar('Z');
  await typeChar('Z');
  await sleep(150);
  const none = await state();
  logLine('  after typing CZZ: ' + JSON.stringify(none));
  check('the «no match» line shows when nothing fits',
    none.open === true && none.options === 0 && none.empty.length > 0, { empty: none.empty });

  /* ---- 7. the caret is a real toggle ---- */
  const caret = await rect('caret');
  check('the caret is on the screen', !!caret, caret);
  if (caret) {
    await clickAt(caret.cx, caret.cy);
    const t1 = await state();
    await clickAt(caret.cx, caret.cy);
    const t2 = await state();
    await clickAt(caret.cx, caret.cy);
    const t3 = await state();
    logLine('  the caret: ' + JSON.stringify([t1.open, t2.open, t3.open]));
    check('the caret opens the list with every option',
      t2.open === true && t2.options >= 3, { open: t2.open, options: t2.options });
    check('the caret closes the list again', t3.open === false, t3.open);
    check('the caret does not steal the focus from the field', t2.focused === true, t2.focused);
  }

  /* ---- 8. a click outside closes the list ---- */
  const title = await rect('title');
  if (title) {
    await clickAt(title.cx, title.cy);
    const outside = await state();
    check('a click outside closes the list', outside.open === false, outside.open);
  }

  /* ---- 9. Escape closes the list ---- */
  const r3 = await rect('input');
  if (r3) {
    await clickAt(r3.w > 90 ? r3.left + r3.w * 0.75 : r3.cx, r3.cy);
    const opened = await state();
    check('the list can be opened again', opened.open === true, opened.open);
    await pressKey('Escape');
    const escaped = await state();
    check('Escape closes the list', escaped.open === false, escaped.open);
  }

  /* ---- 10. the keyboard still walks the list ---- */
  const r4 = await rect('input');
  if (r4) {
    await clickAt(r4.w > 90 ? r4.left + r4.w * 0.75 : r4.cx, r4.cy);
    await pressKey('ArrowDown');
    const arrows = await state();
    check('the arrow keys keep the list open', arrows.open === true, arrows.open);
    await pressKey('Escape');
  }
}

/* ================= the «+» of the quick add ================= */

async function plusTests() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 160) + ' :: ' + e.message);
    return null;
  });

  /* the editor of a document — the party combo there carries the «+» */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(1600);
  await js(`document.getElementById('btnNewDoc').click()`);
  await sleep(1400);
  const kind = await js(`(() => {
    const c = document.querySelector('.kind-card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check('the document editor opens', !!kind, kind);
  if (!kind) return;
  await clickAt(kind.x, kind.y);
  await sleep(2200);

  const plus = await js(`(() => {
    const f = [...document.querySelectorAll('.ed-cell')].find((n) => {
      const t = n.querySelector('.ed-label .field-txt');
      return t && t.textContent.indexOf('العميل / المورد') === 0;
    });
    const b = f ? f.querySelector('.combo-plus') : null;
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const c = f.querySelector('.combo-caret');
    const cr = c ? c.getBoundingClientRect() : null;
    const i = f.querySelector('.combo-input');
    const ir = i ? i.getBoundingClientRect() : null;
    return {
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      plus: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      caret: cr ? { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom } : null,
      input: ir ? { left: ir.left, right: ir.right } : null
    };
  })()`);
  check('the «+» of the quick add is on the screen', !!plus, plus);
  if (!plus) return;
  logLine('  the point of the «+»: ' + JSON.stringify(await js(`(() => {
    const n = document.elementFromPoint(${Math.round(plus.x)}, ${Math.round(plus.y)});
    return n ? (n.className || n.tagName) + ' | ' + (n.textContent || '').trim().slice(0, 30) : null;
  })()`)));

  await js(`(() => {
    window.__plus = [];
    const n = document.querySelector('.ed-cell .combo-plus');
    if (!n) return false;
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'].forEach((t) => n.addEventListener(t, (e) => {
      window.__plus.push({ t, on: e.target.tagName, prevented: e.defaultPrevented });
    }));
    return true;
  })()`);
  await clickAt(plus.x, plus.y);
  await sleep(1400);
  logLine('  the events of the «+»: ' + JSON.stringify(await js(`window.__plus`)));
  const titles = await js(`[...document.querySelectorAll('.modal h3')].map((n) => n.textContent.trim())`);
  logLine('  the open windows: ' + JSON.stringify(titles));
  check('the «+» opens the quick add form',
    (titles || []).some((t) => /إضافة عميل/.test(t)), titles);
  await pressKey('Escape');
  await sleep(700);
}

/* ================= every screen still works ================= */

async function smokeTests() {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch(() => null);
  for (const view of ['dashboard', 'items', 'warehouses', 'parties', 'transactions',
    'production', 'daily', 'reports', 'settings']) {
    await js(`document.querySelector('.nav-item[data-view=${view}]').click()`);
    await sleep(900);
  }
  const errs = await js(`window.__errs || []`);
  check('every screen opens without an error', (errs || []).length === 0, errs);
  const combos = await js(`document.querySelectorAll('.combo').length`);
  check('the screens still hold their dropdowns', (combos || 0) > 0, combos);
}

/* ================= run ================= */

app.whenReady().then(async () => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* the data the check needs: three items with different names and codes */
  const wh = dbMod.addWarehouse({ code: 'W-01', name: 'مخزن الشمال', location: 'صنعاء' });
  [
    { code: 'AA-001', name: 'كرتون أبيض', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    { code: 'BB-002', name: 'بلاستيك شفاف', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    { code: 'CC-003', name: 'شريط لاصق', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 }
  ].forEach((it) => dbMod.addItem(it, [{ warehouseId: wh.id, good: 10 }]));

  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: FOCUSABLE, frame: false, backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  if (FOCUSABLE) { win.show(); win.focus(); }
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4], line: a[5] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) { errors.push(`[console] ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(3600);

  /* a recorder for every error the page throws */
  await js(`window.__errs = [];
    window.addEventListener('error', (e) => {
      window.__errs.push({ msg: String(e.message), src: e.filename, line: e.lineno });
    });
    1`);

  /* the spy on onChange — the real combo() is still the one that runs */
  await js(`window.__spy = [];
    (function () {
      const real = window.SamUI.combo;
      window.SamUI.combo = function (host, opts) {
        opts = opts || {};
        const was = opts.onChange;
        opts.onChange = function (v) { window.__spy.push(v); if (was) return was(v); };
        return real(host, opts);
      };
    })();
    1`);

  logLine('\n===== the dropdown of the item field =====');
  await js(INSTALL);
  await js(TRACE);
  await comboTests();

  logLine('\n===== the «+» of the quick add =====');
  await plusTests();

  logLine('\n===== every screen =====');
  await smokeTests();

  const errs = (await js(`window.__errs || []`)) || [];
  check('the page raised no error', errs.length === 0, errs);

  logLine('\nCONSOLE ERRORS: ' + errors.length);
  errors.forEach((e) => logLine('  ' + e));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
