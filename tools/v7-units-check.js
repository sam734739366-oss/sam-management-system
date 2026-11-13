/**
 * tools/v7-units-check.js — the automatic carton / bag calculation of the
 * document editor:
 *
 *   · a line shows ONLY the packs its own item uses (a bag item shows
 *     «أكياس» and «كسور كيس» and no «كراتين» at all);
 *   · typing the QUANTITY fills the packs (300 pieces of a bag of 24 →
 *     12 bags and 12 pieces of an incomplete bag);
 *   · typing the packs fills the quantity (12 bags and 12 pieces → 300);
 *   · the saved document keeps the new fields (cartons_part, bags_part,
 *     unit_count, unit_part);
 *   · the ledger is untouched by the packs — the stock moves only carry
 *     the pieces.
 *
 * It drives the REAL main process and the REAL renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-units-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7units');
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
    }
  };
  true;
`;

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
  await sleep(1000);
  check('the editor opened', !!(await js(`!!document.querySelector('.lines-tbl tbody tr')`)));

  /* ---- pick the item that uses a bag of 24 ---- */
  const picked = await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.bag.code}')`);
  check('the item of the line was picked', picked === 'ok', picked);
  await sleep(600);

  /* ---- the table follows the item ---- */
  const head = await js(`window.__h.headTexts()`) || [];
  check('the table shows the bags', head.indexOf('أكياس') >= 0, head);
  check('the table shows the incomplete bag', head.indexOf('كسور كيس') >= 0, head);
  check('the table does not show the cartons', head.indexOf('كراتين') < 0, head);

  const row = await js(`(() => {
    const r = window.__h.row(0);
    return {
      bags: !!(r && r.querySelector('[data-pack=bags]')),
      bagsPart: !!(r && r.querySelector('[data-pack=bags_part]')),
      cartons: !!(r && r.querySelector('[data-pack=cartons]')),
      saysCartons: r ? /كراتين/.test(r.innerHTML) : false
    };
  })()`) || {};
  check('the line shows the bags', row.bags === true, row);
  check('the line shows the pieces of the incomplete bag', row.bagsPart === true, row);
  check('the line does not show the cartons', row.cartons === false && row.saysCartons === false, row);

  /* ---- the quantity fills the packs ---- */
  await js(`(() => { const r = window.__h.row(0); window.__h.type(r.querySelector('[data-role=pieces]'), '300'); return true; })()`);
  await sleep(400);
  const filled = await js(`(() => {
    const r = window.__h.row(0);
    return {
      qty: r.querySelector('[data-role=pieces]').value,
      bags: r.querySelector('[data-pack=bags]').value,
      part: r.querySelector('[data-pack=bags_part]').value,
      read: (r.querySelector('.pack-read') || {}).textContent
    };
  })()`) || {};
  check('300 pieces are 12 bags', filled.bags === '12', filled);
  check('300 pieces leave 12 pieces of an incomplete bag', filled.part === '12', filled);
  check('the reading says «12 كيس + 12 حبة»', /12 كيس/.test(filled.read || '') && /12 حبة/.test(filled.read || ''), filled);

  /* ---- the totals bar follows the packs ---- */
  const totals = await js(`(() => {
    const t = document.querySelector('.totals-bar');
    return t ? t.textContent.replace(/\\s+/g, ' ').trim() : '';
  })()`) || '';
  check('the totals bar shows the bags', /أكياس/.test(totals), totals);
  check('the totals bar shows the incomplete bags', /كسور كيس/.test(totals), totals);

  /* ---- the packs fill the quantity ----
     the quantity is emptied first, so the numbers really come from the
     two boxes of the pack and not from what was there before */
  await js(`(() => { const r = window.__h.row(0); window.__h.type(r.querySelector('[data-role=pieces]'), ''); return true; })()`);
  await sleep(300);
  const emptied = await js(`(() => {
    const r = window.__h.row(0);
    return {
      qty: r.querySelector('[data-role=pieces]').value,
      bags: r.querySelector('[data-pack=bags]').value,
      part: r.querySelector('[data-pack=bags_part]').value
    };
  })()`) || {};
  check('an empty quantity empties the packs', emptied.qty === '' && emptied.bags === '' && emptied.part === '', emptied);

  await js(`(() => {
    const r = window.__h.row(0);
    window.__h.type(r.querySelector('[data-pack=bags]'), '12');
    window.__h.type(r.querySelector('[data-pack=bags_part]'), '12');
    return true;
  })()`);
  await sleep(400);
  const back = await js(`(() => {
    const r = window.__h.row(0);
    return {
      qty: r.querySelector('[data-role=pieces]').value,
      bags: r.querySelector('[data-pack=bags]').value,
      part: r.querySelector('[data-pack=bags_part]').value
    };
  })()`) || {};
  check('12 bags and 12 pieces are 300 pieces', back.qty === '300', back);
  check('the two boxes keep what the user typed', back.bags === '12' && back.part === '12', back);

  /* ---- the warehouse of the line ---- */
  const wh = await js(`window.__h.pickCombo(window.__h.row(0), 1, '${ctx.wh.code}')`);
  check('the warehouse of the line was picked', wh === 'ok', wh);
  await sleep(400);

  /* ---- save the document ---- */
  await js(`document.querySelector('[data-act=save]').click(); true`);
  const saved = await js(`Promise.race([window.__ed, new Promise((r) => setTimeout(() => r(null), 20000))])`);
  check('the document was saved', !!(saved && saved.id), saved && saved.id);
  if (!saved || !saved.id) return;

  /* ---- the document keeps the new fields ---- */
  const doc = await js(`SamDB.call('getDocument', ${saved.id})`);
  const line = (doc && doc.lines && doc.lines[0]) || {};
  check('the document keeps the quantity', Number(line.pieces) === 300, line.pieces);
  check('the document keeps the bags', Number(line.bags) === 12, line.bags);
  check('the document keeps the pieces of the incomplete bag', Number(line.bags_part) === 12, line.bags_part);
  check('the document has no cartons', Number(line.cartons) === 0 && Number(line.cartons_part) === 0,
    { c: line.cartons, p: line.cartons_part });
  check('the document has no unit of its own', Number(line.unit_count) === 0 && Number(line.unit_part) === 0,
    { c: line.unit_count, p: line.unit_part });
  check('the document reads its item units', Number(line.perBag) === 24, line.perBag);

  /* ---- the ledger carries the pieces only ---- */
  const moves = await js(`SamDB.call('listRecentMoves', 30)`) || [];
  const move = moves.find((m) => Number(m.item_id) === Number(ctx.bag.id));
  check('the ledger carries the pieces', !!move && Number(move.piece_delta) === 300, move && move.piece_delta);
  const stock = await js(`SamDB.call('itemStock', ${ctx.bag.id})`) || [];
  const good = stock.reduce((a, r) => a + Number(r.good || 0), 0);
  check('the stock moved by exactly 300 pieces', good === 1300, good);

  /* ---- the printed invoice shows the packs ---- */
  await js(`window.SamDocs.printInvoice(${saved.id}); true`);
  await sleep(1600);
  const paper = await js(`(() => {
    const p = document.querySelector('.pv-pages');
    return p ? p.textContent.replace(/\\s+/g, ' ') : null;
  })()`);
  check('the printed invoice shows the bags', /أكياس/.test(paper || ''), (paper || '').slice(0, 200));
  check('the printed invoice shows the incomplete bag', /كسور كيس/.test(paper || ''), (paper || '').slice(0, 200));
  const paperHead = await js(`(() => [...document.querySelectorAll('.pv-pages thead th')].map((t) => t.textContent.trim()))()`) || [];
  check('the printed table has the bags column', paperHead.indexOf('أكياس') >= 0, paperHead);
  check('the printed table has the incomplete bags column', paperHead.indexOf('كسور كيس') >= 0, paperHead);
  const paperRow = await js(`(() => {
    const tds = [...document.querySelectorAll('.pv-pages tbody tr:first-child td')].map((t) => t.textContent.trim());
    return tds;
  })()`) || [];
  check('the printed line carries the packs', paperRow.indexOf('12') >= 0, paperRow);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(600);

  /* ---- the view of the document shows the packs too ---- */
  await js(`window.SamDocs.viewDoc(${saved.id}); true`);
  await sleep(1200);
  const view = await js(`(() => {
    const t = document.querySelector('.modal .tbl');
    if (!t) return null;
    return {
      head: [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim()),
      row: [...t.querySelectorAll('tbody tr:first-child td')].map((x) => x.textContent.trim())
    };
  })()`);
  check('the view of the document shows the bags', !!(view && view.head.indexOf('أكياس') >= 0), view && view.head);
  check('the view of the document shows the incomplete bag', !!(view && view.head.indexOf('كسور كيس') >= 0), view && view.head);
  check('the view of the document carries the packs', !!(view && view.row.indexOf('12') >= 0), view && view.row);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(600);

  /* ---- the permit of a document that needs one ---- */
  await js(`window.__ed3 = window.SamDocs.openEditor(null, 'gate_out'); true`);
  await sleep(1200);
  await js(`(() => {
    const r = document.querySelectorAll('.lines-tbl tbody tr')[0];
    const pick = (i, t) => {
      const c = r.querySelectorAll('.combo')[i];
      const input = c.querySelector('.combo-input');
      document.querySelectorAll('.combo-pop').forEach((p) => { p.style.display = 'none'; });
      input.value = t; input.dispatchEvent(new Event('input', { bubbles: true }));
      const pops = [...document.querySelectorAll('.combo-pop')].filter((p) => p.style.display !== 'none');
      if (pops[0]) { const o = pops[0].querySelector('.combo-opt'); if (o) o.click(); }
    };
    pick(0, '${ctx.bag.code}');
    pick(1, '${ctx.wh.code}');
    const q = r.querySelector('[data-role=pieces]');
    q.value = '300'; q.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  await js(`document.querySelector('[data-act=save]').click(); true`);
  const saved2 = await js(`Promise.race([window.__ed3, new Promise((r) => setTimeout(() => r(null), 20000))])`);
  check('the permit document was saved', !!(saved2 && saved2.id), saved2 && saved2.id);
  if (saved2 && saved2.id) {
    await js(`window.SamDocs.printPermits(${saved2.id}); true`);
    await sleep(1600);
    const permit = await js(`(() => {
      const t = document.querySelector('.pv-pages thead');
      if (!t) return null;
      return {
        head: [...t.querySelectorAll('th')].map((x) => x.textContent.trim()),
        row: [...document.querySelectorAll('.pv-pages tbody tr:first-child td')].map((x) => x.textContent.trim())
      };
    })()`);
    check('the permit shows the bags', !!(permit && permit.head.indexOf('أكياس') >= 0), permit && permit.head);
    check('the permit shows the incomplete bag', !!(permit && permit.head.indexOf('كسور كيس') >= 0), permit && permit.head);
    check('the permit carries the packs', !!(permit && permit.row.indexOf('12') >= 0), permit && permit.row);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(600);
  }

  /* ---- the other kinds of item ---- */
  await js(`window.__ed2 = window.SamDocs.openEditor(null, 'gate_in'); true`);
  await sleep(1000);
  const ctn = await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.carton.code}')`);
  check('the carton item was picked', ctn === 'ok', ctn);
  await sleep(600);
  const cHead = await js(`window.__h.headTexts()`) || [];
  check('the carton item shows the cartons', cHead.indexOf('كراتين') >= 0, cHead);
  check('the carton item shows the incomplete carton', cHead.indexOf('كسور كرتون') >= 0, cHead);
  check('the carton item shows no bags', cHead.indexOf('أكياس') < 0, cHead);
  const cRow = await js(`(() => {
    const r = window.__h.row(0);
    return { cartons: !!(r && r.querySelector('[data-pack=cartons]')), bags: !!(r && r.querySelector('[data-pack=bags]')) };
  })()`) || {};
  check('the carton line has the cartons only', cRow.cartons === true && cRow.bags === false, cRow);

  const unt = await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.unit.code}')`);
  check('the unit item was picked', unt === 'ok', unt);
  await sleep(600);
  const uHead = await js(`window.__h.headTexts()`) || [];
  check('the unit item shows its own unit', uHead.indexOf('علبة') >= 0, uHead);
  check('the unit item shows the incomplete unit', uHead.indexOf('كسور علبة') >= 0, uHead);

  const plain = await js(`window.__h.pickCombo(window.__h.row(0), 0, '${ctx.plain.code}')`);
  check('the plain item was picked', plain === 'ok', plain);
  await sleep(600);
  const pHead = await js(`window.__h.headTexts()`) || [];
  const pRow = await js(`(() => {
    const r = window.__h.row(0);
    return { packs: r.querySelectorAll('[data-pack]').length, text: window.__h.rowText(r) };
  })()`) || {};
  check('an item without packs shows no pack box', pRow.packs === 0, pRow);
  check('an item without packs keeps the quantity', /الكمية/.test(pHead.join(' ')), pHead);

  /* ---- a second line with another item: the table speaks of both ---- */
  await js(`(() => {
    const btn = [...document.querySelectorAll('.row-add .btn')][0];
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(500);
  await js(`window.__h.pickCombo(window.__h.row(1), 0, '${ctx.bag.code}')`);
  await sleep(600);
  const mHead = await js(`window.__h.headTexts()`) || [];
  check('the table of two lines speaks of the bags', mHead.indexOf('أكياس') >= 0 && mHead.indexOf('كسور كيس') >= 0, mHead);
  const mRows = await js(`(() => {
    const cols = (r) => r ? [...r.querySelectorAll('td')].reduce((a, td) => a + (td.colSpan || 1), 0) : -1;
    const a = window.__h.row(0), b = window.__h.row(1);
    return {
      aCells: cols(a),
      bCells: cols(b),
      aPacks: a ? a.querySelectorAll('[data-pack]').length : -1,
      bPacks: b ? b.querySelectorAll('[data-pack]').length : -1
    };
  })()`) || {};
  check('the two lines have the same shape', mRows.aCells === mRows.bCells && mRows.aCells > 0, mRows);
  check('the line without packs keeps no pack box', mRows.aPacks === 0, mRows);
  check('the line with the bag has its two boxes', mRows.bPacks === 2, mRows);

  /* close the editor without saving */
  await js(`document.querySelector('[data-act=cancel]').click(); true`);
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
    const carton = dbMod.addItem({ code: 'CTN-12', name: 'صنف الكرتون', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 12 }, []);
    const unit = dbMod.addItem({ code: 'UNT-06', name: 'صنف الوحدة', base_unit: 'حبة', category: 'منتج', unit_label: 'علبة', unit_pieces: 6 }, []);
    const plain = dbMod.addItem({ code: 'PLN-01', name: 'صنف بلا عبوة', base_unit: 'حبة', category: 'منتج' }, []);
    const ctx = { wh, bag, carton, unit, plain };

    require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

    win = new BrowserWindow({
      width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    win.webContents.on('console-message', (...a) => {
      const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], source: a[4], line: a[5] };
      const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
      /* only the files of this work are counted — the other screens are
         being written by other hands and must not fail this check */
      const mine = /documents\.js|units\.js/.test(String(d.source || ''));
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
