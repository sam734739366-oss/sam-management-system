/**
 * tools/v7-rows-check.js — the row the user adds LATER, and the picture
 * that replaces the code of the item in the papers.
 *
 * The customer sent a picture: the row he added with «إضافة سطر» in the
 * document editor did NOT behave like the first row — the quantity he
 * typed did not fill the packs, and the fraction box held a number that is
 * bigger than one unit.
 *
 * The cause was in the code: the boxes of a pack are drawn the moment the
 * row is made — before the row has an item — and only the rows whose item
 * CHANGED the units of the whole table got their boxes back. The first
 * row was lucky (the table was empty when the editor opened), a row added
 * later was not: it kept its empty cells for ever.
 *
 * This harness drives the REAL main process and the REAL renderer and proves:
 *   1. a row added with «إضافة سطر» reacts EXACTLY like the first row;
 *   2. the fraction box never shows a number >= the size of one unit;
 *   3. the quantity box never shows the fraction's value and vice versa;
 *   4. the printed invoice carries the picture next to the name and has no
 *      separate item-code column.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-rows-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7rows');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const errors = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

let win = null;
let cleanedUp = false;
async function shutdown(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* ignore */ }
  try { dbMod.close(); } catch (e) { /* ignore */ }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  app.exit(code || (fail ? 1 : 0));
}
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.stack ? e.stack : e));
  shutdown(1);
});
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* ---------------- the helpers of the page ---------------- */
const HELPERS = `
  window.__h = {
    row(n) { return document.querySelectorAll('.lines-tbl tbody tr')[n || 0]; },
    headTexts() { return [...document.querySelectorAll('.lines-tbl thead th')].map((t) => t.textContent.trim()); },
    rowText(r) { return (r ? r.textContent : '').replace(/\\s+/g, ' ').trim(); },
    type(el, v) { if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); return true; },
    pickCombo(scope, index, text) {
      const combos = scope.querySelectorAll('.combo');
      const c = combos[index];
      if (!c) return 'no combo ' + index;
      const input = c.querySelector('.combo-input');
      document.querySelectorAll('.combo-pop').forEach((p) => { p.style.display = 'none'; });
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const pops = [...document.querySelectorAll('.combo-pop')].filter((p) => p.style.display !== 'none');
      if (!pops.length) return 'no pop';
      const opt = pops[0].querySelector('.combo-opt');
      if (!opt) return 'no option';
      opt.click();
      return 'ok';
    },
    /* the boxes of one row: the pack boxes and the quantity */
    boxes(n) {
      const r = window.__h.row(n);
      if (!r) return null;
      const one = (sel) => { const e = r.querySelector(sel); return e ? e.value : null; };
      return {
        qty: one('[data-role=pieces]'),
        count: one('[data-pack=bags]'),
        part: one('[data-pack=bags_part]'),
        read: (r.querySelector('.pack-read') || {}).textContent || '',
        packInputs: r.querySelectorAll('[data-pack]').length
      };
    },
    addRow() {
      const bs = [...document.querySelectorAll('.row-add .btn, .editor .btn')].filter((x) => (x.textContent || '').indexOf('إضافة سطر') >= 0);
      const b = bs[bs.length - 1];
      if (!b) return 'no button';
      b.click();
      return 'ok';
    }
  };
  true;
`;

const BOXES = (n) => `JSON.stringify(window.__h.boxes(${n}))`;

async function rendererTests(ctx) {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    console.log('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);
  await js(HELPERS);

  /* ---- the editor opens on «إذن إدخال» (a kind that needs no party) ---- */
  await js(`window.__ed = window.SamDocs.openEditor(null, 'gate_in'); true`);
  await sleep(1200);
  check('the editor opened with one row', !!(await js(`!!window.__h.row(0)`)));

  /* ---- the FIRST row: the item that uses a bag of 24 ---- */
  const picked = await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.bag.code}')`);
  check('the item of the first row was picked', picked === 'ok', picked);
  await sleep(700);
  await js(`window.__h.type(window.__h.row(0).querySelector('[data-role=pieces]'), '300'); true`);
  await sleep(500);
  const first = JSON.parse(await js(BOXES(0)) || '{}');
  check('the first row: 300 pieces are 12 bags', first.count === '12', first);
  check('the first row: 300 pieces leave 12 pieces of an incomplete bag', first.part === '12', first);
  check('the first row: the quantity keeps what the user typed', first.qty === '300', first);

  /* ---- the row the user adds LATER ---- */
  const added = await js(`window.__h.addRow()`);
  check('the row was added with «إضافة سطر»', added === 'ok', added);
  await sleep(700);
  const picked2 = await js(`window.__h.pickCombo(window.__h.row(1), 0, '${ctx.bag.code}')`);
  check('the item of the new row was picked', picked2 === 'ok', picked2);
  await sleep(800);
  const shape = JSON.parse(await js(BOXES(1)) || '{}');
  check('the new row has the same pack boxes as the first row',
    shape.packInputs === 2 && shape.count !== null && shape.part !== null, shape);
  check('the new row has the same shape as the first row',
    shape.packInputs === first.packInputs, { first: first.packInputs, second: shape.packInputs });

  /* ---- the new row reacts EXACTLY like the first row ---- */
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-role=pieces]'), '300'); true`);
  await sleep(500);
  const second = JSON.parse(await js(BOXES(1)) || '{}');
  check('the new row: 300 pieces are 12 bags', second.count === '12', second);
  check('the new row: 300 pieces leave 12 pieces of an incomplete bag', second.part === '12', second);
  check('the new row: the quantity keeps what the user typed', second.qty === '300', second);
  check('the new row reads exactly like the first row',
    second.count === first.count && second.part === first.part && second.qty === first.qty,
    { first, second });

  /* ---- the packs of the new row fill the quantity ---- */
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-role=pieces]'), ''); true`);
  await sleep(300);
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-pack=bags]'), '12'); true`);
  await sleep(200);
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-pack=bags_part]'), '12'); true`);
  await sleep(500);
  const back = JSON.parse(await js(BOXES(1)) || '{}');
  check('the new row: 12 bags and 12 pieces are 300 pieces', back.qty === '300', back);
  check('the new row: the two boxes keep what the user typed', back.count === '12' && back.part === '12', back);

  /* ---- the fraction never holds more than one unit ---- */
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-pack=bags_part]'), '25'); true`);
  await sleep(500);
  const over = JSON.parse(await js(BOXES(1)) || '{}');
  check('the fraction box never shows a number >= the size of one unit',
    over.part !== null && Number(over.part) < 24, over);
  check('what is beyond one unit moves into the count',
    over.count === '13' && over.part === '1' && over.qty === '313', over);
  check('the reading of the new row agrees with the boxes',
    /13 كيس/.test(over.read || '') && /1 حبة/.test(over.read || ''), over);

  /* ---- the quantity and the fraction never show each other's number ---- */
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-role=pieces]'), '300'); true`);
  await sleep(500);
  const q300 = JSON.parse(await js(BOXES(1)) || '{}');
  check('the fraction box never shows the quantity',
    q300.part !== '300' && Number(q300.part) < 24, q300);
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-pack=bags]'), '12'); true`);
  await sleep(200);
  await js(`window.__h.type(window.__h.row(1).querySelector('[data-pack=bags_part]'), '12'); true`);
  await sleep(500);
  const both = JSON.parse(await js(BOXES(1)) || '{}');
  check('the quantity box never shows the fraction\'s value', both.qty !== '12' && both.qty === '300', both);
  check('the fraction box never shows the quantity\'s value', both.part !== '300' && both.part === '12', both);

  /* ---- the same rules in the FIRST row ---- */
  await js(`window.__h.type(window.__h.row(0).querySelector('[data-pack=bags_part]'), '25'); true`);
  await sleep(500);
  const overFirst = JSON.parse(await js(BOXES(0)) || '{}');
  check('the first row keeps the same rule for the fraction box',
    overFirst.part !== null && Number(overFirst.part) < 24, overFirst);

  /* ---- the numbers of the customer's own picture:
     a bag of 200 — 1,070 pieces are 5 bags and 70 pieces, and 11,196
     pieces are 55 bags and 196 pieces (never 11,196 in the fraction box) */
  await js(`window.__h.addRow()`);
  await sleep(700);
  await js(`window.__h.pickCombo(window.__h.row(2), 0, '${ctx.big.code}')`);
  await sleep(800);
  await js(`window.__h.type(window.__h.row(2).querySelector('[data-role=pieces]'), '1070'); true`);
  await sleep(600);
  const big = JSON.parse(await js(BOXES(2)) || '{}');
  check('the new row: 1,070 pieces of a bag of 200 are 5 bags', big.count === '5', big);
  check('the new row: 1,070 pieces leave 70 pieces of an incomplete bag', big.part === '70', big);
  check('the new row reads «5 كيس + 70 حبة»', /5 كيس/.test(big.read || '') && /70 حبة/.test(big.read || ''), big);
  await js(`window.__h.type(window.__h.row(2).querySelector('[data-role=pieces]'), '11196'); true`);
  await sleep(600);
  const big2 = JSON.parse(await js(BOXES(2)) || '{}');
  check('the new row: 11,196 pieces are 55 bags', big2.count === '55', big2);
  check('the new row: 11,196 pieces leave 196 pieces of an incomplete bag', big2.part === '196', big2);
  check('the new row: the quantity keeps 11,196 and the fraction box never holds it',
    big2.qty === '11196' && big2.part !== '11196' && Number(big2.part) < 200, big2);

  /* ---- the papers: the picture beside the name, and no code ---- */
  const wh = await js(`window.__h.pickCombo(window.__h.row(0), 1, '${ctx.wh.code}')`);
  check('the warehouse of the first row was picked', wh === 'ok', wh);
  await sleep(400);
  const wh2 = await js(`window.__h.pickCombo(window.__h.row(1), 1, '${ctx.wh.code}')`);
  check('the warehouse of the new row was picked', wh2 === 'ok', wh2);
  await sleep(400);
  const wh3 = await js(`window.__h.pickCombo(window.__h.row(2), 1, '${ctx.wh.code}')`);
  check('the warehouse of the third row was picked', wh3 === 'ok', wh3);
  await sleep(400);
  /* the first row carries the item that HAS a picture */
  await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.pic.code}')`);
  await sleep(700);
  await js(`window.__h.type(window.__h.row(0).querySelector('[data-role=pieces]'), '300'); true`);
  await sleep(500);
  await js(`document.querySelector('[data-act=save]').click(); true`);
  const saved = await js(`Promise.race([window.__ed, new Promise((r) => setTimeout(() => r(null), 20000))])`);
  check('the document was saved', !!(saved && saved.id), saved && saved.id);

  if (saved && saved.id) {
    await js(`window.SamDocs.printInvoice(${saved.id}); true`);
    await sleep(1800);
    const paper = await js(`(() => {
      const p = document.querySelector('.pv-pages');
      if (!p) return null;
      const head = [...p.querySelectorAll('thead th')].map((t) => t.textContent.trim());
      const cells = [...p.querySelectorAll('tbody tr td')].map((td) => ({
        text: td.textContent.trim(),
        html: td.innerHTML
      }));
      const img = p.querySelector('tbody img.sam-pic');
      return {
        head,
        cells: cells.map((c) => c.text),
        itemHtml: (cells.find((c) => c.html.indexOf('sam-pic') >= 0) || {}).html || '',
        imgs: p.querySelectorAll('tbody img.sam-pic').length,
        src: img ? img.getAttribute('src') : '',
        alt: img ? img.getAttribute('alt') : '',
        body: p.textContent.replace(/\\s+/g, ' ')
      };
    })()`) || {};
    check('the printed invoice carries the picture of the item', paper.imgs === 1, { imgs: paper.imgs, src: paper.src });
    check('the picture of the item is the picture of the file',
      /pic-test\.png/.test(paper.src || ''), paper.src);
    check('the printed invoice has no column of the code of the item',
      !(paper.head || []).some((h) => /كود/.test(h)), paper.head);
    check('the printed invoice does not show the code of the item',
      (paper.body || '').indexOf(ctx.pic.code) < 0, { code: ctx.pic.code });
    check('the printed invoice shows the name of the item',
      (paper.body || '').indexOf(ctx.pic.name) >= 0, { name: ctx.pic.name });
    check('the name of the item is bold and dark in the paper',
      /font-weight:800/.test(paper.itemHtml || '') && /color:#17202f/.test(paper.itemHtml || ''), paper.itemHtml);
    check('the picture of the item sits beside the name',
      /<img[^>]*class="sam-pic"[^>]*>\s*<b[^>]*>.*<\/b>/.test(paper.itemHtml || ''), paper.itemHtml);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(700);

    /* ---- the view of the document: the picture beside the name too ---- */
    await js(`window.SamDocs.viewDoc(${saved.id}); true`);
    await sleep(1400);
    const view = await js(`(() => {
      const t = document.querySelector('.modal .tbl');
      if (!t) return null;
      const td = t.querySelector('tbody tr td:nth-child(2)');
      return {
        text: td ? td.textContent.trim() : '',
        html: td ? td.innerHTML : '',
        imgs: t.querySelectorAll('tbody img.sam-pic').length,
        head: [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim())
      };
    })()`) || {};
    check('the view of the document carries the picture beside the name', view.imgs === 1, view);
    check('the view of the document does not show the code of the item',
      (view.text || '').indexOf(ctx.pic.code) < 0, view && view.text);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(700);
  }

  /* ---- an item WITHOUT a picture: the name alone, no empty box ---- */
  await js(`window.__ed4 = window.SamDocs.openEditor(null, 'gate_in'); true`);
  await sleep(1200);
  await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.bag.code}')`);
  await sleep(600);
  await js(`window.__h.pickCombo(window.__h.row(0), 1, '${ctx.wh.code}')`);
  await sleep(400);
  await js(`window.__h.type(window.__h.row(0).querySelector('[data-role=pieces]'), '300'); true`);
  await sleep(400);
  await js(`document.querySelector('[data-act=save]').click(); true`);
  const saved2 = await js(`Promise.race([window.__ed4, new Promise((r) => setTimeout(() => r(null), 20000))])`);
  check('the second document was saved', !!(saved2 && saved2.id), saved2 && saved2.id);
  if (saved2 && saved2.id) {
    await js(`window.SamDocs.printInvoice(${saved2.id}); true`);
    await sleep(1800);
    const plain = await js(`(() => {
      const p = document.querySelector('.pv-pages');
      if (!p) return null;
      const td = [...p.querySelectorAll('tbody tr td')].find((x) => x.textContent.indexOf('${ctx.bag.name}') >= 0);
      return { imgs: p.querySelectorAll('tbody img.sam-pic').length, html: td ? td.innerHTML : '' };
    })()`) || {};
    check('an item without a picture shows no empty box', plain.imgs === 0, plain);
    check('an item without a picture shows its name alone',
      /<b[^>]*>/.test(plain.html || '') && !/<img/.test(plain.html || ''), plain && plain.html);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(600);
  }

  /* ---- the permit: the picture beside the name too ---- */
  await js(`window.__ed5 = window.SamDocs.openEditor(null, 'gate_out'); true`);
  await sleep(1200);
  await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.pic.code}')`);
  await sleep(600);
  await js(`window.__h.pickCombo(window.__h.row(0), 1, '${ctx.wh.code}')`);
  await sleep(400);
  await js(`window.__h.type(window.__h.row(0).querySelector('[data-role=pieces]'), '300'); true`);
  await sleep(400);
  await js(`document.querySelector('[data-act=save]').click(); true`);
  const saved3 = await js(`Promise.race([window.__ed5, new Promise((r) => setTimeout(() => r(null), 20000))])`);
  check('the permit document was saved', !!(saved3 && saved3.id), saved3 && saved3.id);
  if (saved3 && saved3.id) {
    await js(`window.SamDocs.printPermits(${saved3.id}); true`);
    await sleep(1800);
    const permit = await js(`(() => {
      const p = document.querySelector('.pv-pages');
      if (!p) return null;
      return {
        imgs: p.querySelectorAll('tbody img.sam-pic').length,
        body: p.textContent.replace(/\\s+/g, ' '),
        head: [...p.querySelectorAll('thead th')].map((x) => x.textContent.trim())
      };
    })()`) || {};
    check('the permit carries the picture of the item', permit.imgs === 1, permit);
    check('the permit does not show the code of the item',
      (permit.body || '').indexOf(ctx.pic.code) < 0, { code: ctx.pic.code });
    check('the permit shows the name of the item',
      (permit.body || '').indexOf(ctx.pic.name) >= 0, { name: ctx.pic.name });
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(600);
  }

  /* ---- the shared helper of the picture is there for the other screens ---- */
  const helper = await js(`(async () => {
    if (!window.SamItemPic) return { loaded: false };
    await window.SamItemPic.ensure();
    return { loaded: true, api: Object.keys(window.SamItemPic).sort().join(',') };
  })()`) || {};
  check('the shared helper of the picture (js/itempic.js) is available',
    helper.loaded === true, helper);

  /* close the editor without saving */
  await js(`(() => { const b = document.querySelector('[data-act=cancel]'); if (b) b.click(); return true; })()`);
  await sleep(500);
}

app.whenReady().then(async () => {
  try {
    dbMod.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    dbMod.init(DATA);
    session.ensureSeed();

    /* ---- the data of the test ---- */
    const wh = dbMod.addWarehouse({ code: 'WH-U', name: 'مخزن الاختبار', location: 'صنعاء' });
    const bag = dbMod.addItem({ code: 'BAG-24', name: 'صنف الكيس', base_unit: 'حبة', category: 'منتج', pieces_per_bag: 24 },
      [{ warehouseId: wh.id, good: 1000 }]);
    /* an item WITH a picture — the file lives in the pictures folder */
    const imgDir = path.join(DATA, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2P8//8/AzWBiYGaYNSCqUQEAOhgMEAX8D8WZ0AAAAASUVORK5CYII=',
      'base64');
    fs.writeFileSync(path.join(imgDir, 'pic-test.png'), png);
    const pic = dbMod.addItem({ code: 'PICP-1', name: 'صنف بالصورة', base_unit: 'حبة', category: 'منتج', pieces_per_bag: 24, image: 'pic-test.png' },
      [{ warehouseId: wh.id, good: 1000 }]);
    /* the bag of 200 of the customer's own picture */
    const big = dbMod.addItem({ code: 'BAG-200', name: 'صنف الكيس الكبير', base_unit: 'حبة', category: 'منتج', pieces_per_bag: 200 },
      [{ warehouseId: wh.id, good: 5000 }]);
    const ctx = { wh, bag, pic, big };

    require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

    win = new BrowserWindow({
      width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    win.webContents.on('console-message', (...a) => {
      const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4], line: a[5] };
      const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] : d.level;
      const mine = /documents\.js|units\.js|itempic\.js/.test(String(d.source || ''));
      if (lvl >= 2 && mine) {
        errors.push(`[console] ${d.source || ''} ${d.message}`);
        console.log(`CONSOLE ${lvl}: ${d.message} @${d.source}:${d.line}`);
      }
    });

    await rendererTests(ctx);
    console.log('\nCONSOLE ERRORS: ' + errors.length);
    errors.forEach((e) => console.log('  ' + e));
    shutdown(fail || errors.length ? 1 : 0);
  } catch (e) {
    console.log('FATAL: ' + (e && e.stack ? e.stack : e));
    shutdown(1);
  }
});
