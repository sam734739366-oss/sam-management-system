/**
 * tools/v7-tolling-check.js — verification of the V7 tolling flow:
 * the customer's material walks through FOUR steps, and the batch (دفعة)
 * is what ties them together:
 *   1. استلام خام العميل   → the batch is born (ONE incoming movement)
 *   2. صرف خام إلى الإنتاج → a «prod_issue» document (is_customer = 1)
 *   3. استلام المنتج التام → a «prod_receipt» document
 *   4. فاتورة مبيعات       → a «sale» document with «أجور نفخ»
 * and the renderer really shows all of it.
 * It drives the REAL main process and the REAL renderer.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-tolling-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7tolling');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the data folder is chosen BEFORE the database is loaded — the app never
   touches the customer's real data while the check runs */
process.env.SAM_DATA_DIR = DATA;

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-tolling-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
function check(name, ok, detail) {
  logLine(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const errors = [];

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
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail || errors.length ? 1 : 0); } });

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
logLine('--- harness starting ---');

/* ================= the flow, step by step ================= */

/** the batch row really goes — the schema drops the link of the papers
    that point at it (ON DELETE SET NULL) */
function rawDeleteBatch(id) {
  try {
    const Database = require('better-sqlite3');
    const conn = new Database(dbMod.dbFile());
    conn.pragma('foreign_keys = ON');
    conn.prepare('DELETE FROM tolling_orders WHERE id=?').run(id);
    conn.close();
    return true;
  } catch (e) {
    logLine('  (the direct delete of the batch failed: ' + e.message + ')');
    return false;
  }
}

/** every movement of the ledger, newest first */
const moves = (n = 60) => dbMod.listRecentMoves(n) || [];
/** the movements of one document kind */
const movesOf = (docType) => moves(200).filter((m) => m.doc_type === docType);

async function flowTests(ids) {
  const { wh, raw, box, party } = ids;
  const today = new Date().toISOString().slice(0, 10);

  /* ---------- 1. the batch is born ---------- */
  const batch = dbMod.saveTolling({
    doc_date: today,
    party_id: party.id,
    raw_item_id: raw.id,
    warehouse_id: wh.id,
    pieces_in: 1000,
    bags_in: 12,
    note: 'دفعة اختبار'
  });
  check('the batch is created', !!(batch && batch.id), batch && batch.doc_no);
  check('the batch carries a TOL number', /^TOL-\d{4}$/.test(String(batch.doc_no || '')), batch.doc_no);
  check('the batch knows its customer', batch.party_id === party.id && batch.partyName === party.name, {
    party_id: batch.party_id, partyName: batch.partyName
  });

  const fresh = dbMod.getTolling(batch.id);
  check('a new batch has issued = 0', Number(fresh.issued) === 0, fresh.issued);
  check('a new batch has producedGood = 0', Number(fresh.producedGood) === 0, fresh.producedGood);
  check('a new batch keeps the whole quantity', Number(fresh.remaining) === Number(fresh.pieces_in), {
    pieces_in: fresh.pieces_in, remaining: fresh.remaining
  });
  check('a new batch is «received»', fresh.status === 'received', fresh.status);

  const inMoves = movesOf('tolling_in').filter((m) => m.doc_id === batch.id);
  check('the batch writes ONE incoming movement', inMoves.length === 1, inMoves.length);
  check('the incoming movement carries the whole quantity', Number(inMoves[0] && inMoves[0].piece_delta) === 1000, inMoves[0] && inMoves[0].piece_delta);
  check('the material belongs to the customer', Number(inMoves[0] && inMoves[0].is_customer) === 1, inMoves[0] && inMoves[0].is_customer);

  /* ---------- 2. صرف خام إلى الإنتاج ---------- */
  const issue = dbMod.saveDocument({
    kind: 'prod_issue',
    doc_date: today,
    external_no: 'ISS-1',
    batch_id: batch.id,
    notes: 'صرف إلى الخط',
    lines: [{ item_id: raw.id, bucket: 'good', pieces: 800, cartons: 0, bags: 0, warehouse_id: wh.id }]
  });
  check('the «صرف خام إلى الإنتاج» document is saved', !!(issue && issue.id), issue && issue.doc_no);
  const afterIssue = dbMod.getTolling(batch.id);
  check('the issue lowers what was issued', Number(afterIssue.issued) === 800, afterIssue.issued);
  check('the issue lowers what is left', Number(afterIssue.remaining) === 200, afterIssue.remaining);
  check('the batch is now «in-production»', afterIssue.status === 'in-production', afterIssue.status);
  const issueMoves = movesOf('prod_issue').filter((m) => m.doc_id === issue.id);
  check('the issue writes a movement', issueMoves.length === 1, issueMoves.length);
  check('the movement of the issue belongs to the customer', Number(issueMoves[0] && issueMoves[0].is_customer) === 1, issueMoves[0] && issueMoves[0].is_customer);
  check('the movement of the issue leaves the warehouse', Number(issueMoves[0] && issueMoves[0].piece_delta) === -800, issueMoves[0] && issueMoves[0].piece_delta);

  /* ---------- 3. استلام المنتج التام ---------- */
  const receipt = dbMod.saveDocument({
    kind: 'prod_receipt',
    doc_date: today,
    external_no: 'PRC-1',
    batch_id: batch.id,
    notes: 'Boxes back from the plant',
    lines: [{ item_id: box.id, bucket: 'good', pieces: 700, cartons: 0, bags: 70, warehouse_id: wh.id }]
  });
  check('the «استلام المنتج التام» document is saved', !!(receipt && receipt.id), receipt && receipt.doc_no);
  const afterReceipt = dbMod.getTolling(batch.id);
  check('the receipt raises what was produced', Number(afterReceipt.producedGood) === 700, afterReceipt.producedGood);
  check('the batch is now «ready»', afterReceipt.status === 'ready', afterReceipt.status);
  const recMoves = movesOf('prod_receipt').filter((m) => m.doc_id === receipt.id);
  check('the movement of the receipt belongs to the customer', Number(recMoves[0] && recMoves[0].is_customer) === 1, recMoves[0] && recMoves[0].is_customer);

  /* ---------- 4. فاتورة مبيعات + أجور نفخ ---------- */
  const sale = dbMod.saveDocument({
    kind: 'sale',
    doc_date: today,
    external_no: 'INV-77',
    party_id: party.id,
    invoice_value: '12000',
    blowing_fee: '2500',
    batch_id: batch.id,
    notes: 'Boxes delivered',
    lines: [{ item_id: box.id, bucket: 'good', pieces: 700, cartons: 0, bags: 70, warehouse_id: wh.id }]
  });
  check('the sales invoice is saved', !!(sale && sale.id), sale && sale.doc_no);
  const stored = dbMod.getDocument(sale.id);
  check('the invoice keeps the batch', Number(stored.batch_id) === Number(batch.id), stored.batch_id);
  check('the invoice keeps the blowing fee', String(stored.blowing_fee || '') === '2500', stored.blowing_fee);
  const afterSale = dbMod.getTolling(batch.id);
  check('the invoice raises what was delivered', Number(afterSale.delivered) === 700, afterSale.delivered);
  check('the batch is now «delivered»', afterSale.status === 'delivered', afterSale.status);
  check('nothing is left to deliver', Number(afterSale.toDeliver) === 0, afterSale.toDeliver);
  const saleMoves = movesOf('sale').filter((m) => m.doc_id === sale.id);
  check('the movement of the invoice belongs to the customer', Number(saleMoves[0] && saleMoves[0].is_customer) === 1, saleMoves[0] && saleMoves[0].is_customer);

  /* ---------- 5. the batch is deleted: the papers stay, the link goes ---------- */
  const impact = dbMod.tollingImpact(batch.id);
  check('the impact preview lists the movements of the batch', !!(impact && impact.lines && impact.lines.length), impact && impact.lines && impact.lines.length);
  check('the impact preview names the documents that use the batch', !!(impact && impact.docs && impact.docs.length === 3), impact && impact.docs && impact.docs.length);

  let refused = null;
  try { dbMod.deleteTolling(batch.id); } catch (e) { refused = e; }
  if (refused) {
    /* the database refuses to drop a batch that the papers still use —
       that is the safe answer: nothing is deleted behind the user's back */
    check('a batch that the papers use is not deleted behind the back', /مستخدمة|الدفعة/.test(refused.message || ''), refused.message);
  } else {
    check('the batch is gone', dbMod.getTolling(batch.id) === null, dbMod.getTolling(batch.id));
  }
  /* and when the batch row really goes, the papers stay and the link
     drops — the foreign key of the schema does that (ON DELETE SET NULL) */
  rawDeleteBatch(batch.id);
  const issueAfter = dbMod.getDocument(issue.id);
  const receiptAfter = dbMod.getDocument(receipt.id);
  const saleAfter = dbMod.getDocument(sale.id);
  check('the «صرف خام إلى الإنتاج» paper stays', !!issueAfter, issueAfter && issueAfter.doc_no);
  check('the «استلام المنتج التام» paper stays', !!receiptAfter, receiptAfter && receiptAfter.doc_no);
  check('the sales invoice stays', !!saleAfter, saleAfter && saleAfter.doc_no);
  check('the invoice drops the link to the batch', saleAfter.batch_id === null, saleAfter.batch_id);
  check('the invoice keeps its blowing fee', String(saleAfter.blowing_fee || '') === '2500', saleAfter.blowing_fee);
  check('the issue drops the link to the batch', issueAfter.batch_id === null, issueAfter.batch_id);
  check('the receipt drops the link to the batch', receiptAfter.batch_id === null, receiptAfter.batch_id);

  /* ---------- 6. a batch nobody used can be deleted ---------- */
  const spare = dbMod.saveTolling({
    doc_date: today, party_id: party.id, raw_item_id: raw.id, warehouse_id: wh.id,
    pieces_in: 40, bags_in: 0, note: 'دفعة لحذفها'
  });
  const spareMoves = movesOf('tolling_in').filter((m) => m.doc_id === spare.id);
  dbMod.deleteTolling(spare.id);
  check('an unused batch is deleted', dbMod.getTolling(spare.id) === null, dbMod.getTolling(spare.id));
  check('its incoming movement goes with it', movesOf('tolling_in').filter((m) => m.doc_id === spare.id).length === 0, spareMoves.length);

  /* ---------- a second batch, so the screen has something to show ---- */
  const shown = dbMod.saveTolling({
    doc_date: today,
    party_id: party.id,
    raw_item_id: raw.id,
    warehouse_id: wh.id,
    pieces_in: 500,
    bags_in: 5,
    note: 'دفعة للعرض'
  });
  check('a second batch is created', !!(shown && shown.id), shown && shown.doc_no);

  return { batchId: batch.id, issueId: issue.id, receiptId: receipt.id, saleId: sale.id, shownId: shown.id };
}

/* ================= the renderer ================= */
async function rendererTests(ids) {
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 200) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2800);

  /* ---- the production screen ---- */
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(1500);

  const btn = await js(`(() => {
    const b = document.getElementById('btnNewTolling');
    return { text: b ? (b.querySelector('.btn-txt') || {}).textContent : null, hidden: b ? b.hasAttribute('hidden') : null };
  })()`);
  check('the production screen has the «استلام خام عميل» button', !!(btn && /استلام\s*خام\s*عميل/.test(btn.text || '')), btn);

  /* the legacy «صرف إنتاج» tab must not create anything any more */
  const legacy = await js(`(() => {
    const b = document.getElementById('btnNewIssue');
    const tab = document.querySelector('#prodTabs .tab[data-tab=issues]');
    return {
      hidden: b ? b.hasAttribute('hidden') : null,
      display: b ? b.style.display : null,
      tab: tab ? tab.textContent.trim() : null
    };
  })()`);
  check('the legacy «صرف خام جديد» button is closed', legacy && legacy.hidden === true, legacy);

  /* ---- the screen never scrolls sideways ---- */
  const layout = await js(`(() => {
    const d = document.documentElement;
    const t = document.getElementById('tollingTbl');
    const wrap = t ? t.closest('.tbl-wrap') : null;
    const cs = wrap ? getComputedStyle(wrap) : null;
    const small = [...document.querySelectorAll('#v-production *')].filter(n => {
      if (!n.textContent || !n.textContent.trim()) return false;
      if (n.children.length) return false;
      const f = parseFloat(getComputedStyle(n).fontSize || '0');
      return f > 0 && f < 11;
    }).map(n => ({ text: (n.textContent || '').trim().slice(0, 24), size: getComputedStyle(n).fontSize }));
    return {
      page: d.scrollWidth, win: window.innerWidth,
      wrapOverflow: cs ? cs.overflowX : null,
      wrapScroll: wrap ? wrap.scrollWidth : null,
      wrapClient: wrap ? wrap.clientWidth : null,
      small
    };
  })()`);
  check('the production screen never scrolls sideways', !!(layout && layout.page <= layout.win + 2), layout);
  check('the long table scrolls inside its own frame', !!(layout && /auto|scroll/.test(layout.wrapOverflow || '')), layout);
  check('no text of the screen is below 11px', !!(layout && (layout.small || []).length === 0), layout && layout.small);

  /* ---- the batch list ---- */
  await js(`document.querySelector('#prodTabs .tab[data-tab=tolling]').click()`);
  await sleep(900);
  const tbl = await js(`(() => {
    const t = document.getElementById('tollingTbl');
    if (!t) return { missing: true };
    const rows = [...t.querySelectorAll('tbody tr')];
    return {
      head: [...t.querySelectorAll('thead th')].map(h => h.textContent.trim()),
      rows: rows.length,
      first: rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').trim() : null,
      progress: rows[0] ? (rows[0].querySelector('.progress-cell') || {}).innerText : null,
      status: rows[0] ? (rows[0].querySelector('.chip') || {}).textContent : null,
      tone: rows[0] ? [...(rows[0].querySelector('.chip') || { classList: [] }).classList].filter(c => c.startsWith('tone-'))[0] : null
    };
  })()`);
  check('the batch table renders a row for every batch', tbl && tbl.rows >= 1, tbl && tbl.rows);
  check('the batch table has a progress column', !!(tbl && tbl.head && tbl.head.some(h => /التقدّم|التقدم/.test(h))), tbl && tbl.head);
  check('the row shows the whole story in one line', !!(tbl && tbl.progress && /مستلم/.test(tbl.progress) && /متبق/.test(tbl.progress)), tbl && tbl.progress);
  check('the row shows the customer', !!(tbl && tbl.first && /شركة العميل للاختبار/.test(tbl.first)), tbl && tbl.first);
  check('the row shows the raw material', !!(tbl && tbl.first && /خام العميل/.test(tbl.first)), tbl && tbl.first);
  check('the row shows a status chip', !!(tbl && tbl.status && tbl.status.length), tbl && tbl.status);
  check('the status chip wears a tone of the app', !!(tbl && tbl.tone && /^tone-/.test(tbl.tone)), tbl && tbl.tone);

  /* the batch that the flow created was deleted above — make one more */
  const made = await js(`(async () => {
    const b = await SamDB.call('saveTolling', {
      doc_date: new Date().toISOString().slice(0, 10),
      party_id: ${ids.party.id}, raw_item_id: ${ids.raw.id}, warehouse_id: ${ids.wh.id},
      pieces_in: 500, bags_in: 4, note: 'دفعة من الشاشة'
    });
    return { id: b.id, doc_no: b.doc_no };
  })()`);
  check('a batch can be created from the renderer', !!(made && made.id), made);
  await js(`SamProd.load()`);
  await sleep(1200);
  const tbl2 = await js(`(() => {
    const rows = [...document.querySelectorAll('#tollingTbl tbody tr')];
    return { rows: rows.length, text: rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').trim() : null };
  })()`);
  check('the new batch shows up in the list', tbl2 && tbl2.rows >= 1, tbl2);
  check('the new batch carries its number', !!(tbl2 && tbl2.text && /TOL-\d{4}/.test(tbl2.text)), tbl2 && tbl2.text);

  /* ---- the document editor ---- */
  const openEditor = async (kind) => {
    await js(`SamDocs.openEditor(null, ${JSON.stringify(kind)}); 1`);
    await sleep(1200);
    return js(`(() => {
      const eds = [...document.querySelectorAll('.modal.editor')];
      const ed = eds.pop();
      if (!ed) return { missing: true };
      const cells = [...ed.querySelectorAll('.ed-cell')].map(c => ({
        label: (c.querySelector('.field-txt') || {}).textContent || '',
        visible: c.style.display !== 'none'
      }));
      return {
        title: (ed.querySelector('.ed-txt h3') || {}).textContent || '',
        chip: (ed.querySelector('.kind-chip') || {}).textContent || '',
        cells
      };
    })()`);
  };
  const closeEditor = async () => {
    await js(`(() => {
      const eds = [...document.querySelectorAll('.modal.editor')];
      const ed = eds.pop();
      if (!ed) return 'none';
      const b = ed.querySelector('.modal-foot .btn[data-act=cancel]');
      if (b) b.click();
      return 'closed';
    })()`);
    await sleep(700);
  };

  for (const kind of ['prod_issue', 'prod_receipt', 'sale']) {
    const ed = await openEditor(kind);
    const batchCell = (ed.cells || []).find((c) => /دفعة العميل/.test(c.label));
    check(`the editor of «${kind}» shows the «دفعة العميل» box`, !!(batchCell && batchCell.visible), ed && ed.cells);
    await closeEditor();
  }

  const edOther = await openEditor('purchase');
  const otherBatchCell = (edOther.cells || []).find((c) => /دفعة العميل/.test(c.label));
  check('a purchase has no «دفعة العميل» box', !otherBatchCell || otherBatchCell.visible === false, otherBatchCell);
  await closeEditor();

  const edSale = await openEditor('sale');
  const feeCell = (edSale.cells || []).find((c) => /أجور نفخ/.test(c.label));
  check('the invoice shows the «أجور نفخ» box', !!(feeCell && feeCell.visible), edSale && edSale.cells);
  check('the «أجورنفخ» box carries the currency', !!(feeCell && /ريال/.test(feeCell.label)), feeCell);
  await closeEditor();

  const edIssue = await openEditor('prod_issue');
  const feeIssue = (edIssue.cells || []).find((c) => /أجور نفخ/.test(c.label));
  check('«صرف خام إلى الإنتاج» has no «أجور نفخ» box', !feeIssue || feeIssue.visible === false, feeIssue);

  /* picking the batch on a «صرف خام إلى الإنتاج» opens a line with the
     raw material of the batch and what is left of it */
  const picked = await js(`(async () => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const cell = ed.querySelector('.ed-cell.batch-cell');
    if (!cell) return { error: 'no-batch-cell' };
    const inp = cell.querySelector('.combo-input');
    inp.focus();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    if (!pop) return { error: 'no-pop' };
    const opts = [...pop.querySelectorAll('.combo-opt')];
    if (!opts.length) return { error: 'no-options' };
    opts[0].click();
    await new Promise(r => setTimeout(r, 500));
    const row = ed.querySelector('.lines-tbl tbody tr');
    if (!row) return { error: 'no-row' };
    const combos = [...row.querySelectorAll('.combo')];
    return {
      options: opts.length,
      optionText: opts[0].innerText.replace(/\\s+/g, ' ').trim(),
      item: combos[0] ? combos[0].querySelector('.combo-input').value : null,
      qty: (row.querySelector('.num-in') || {}).value,
      hint: (cell.querySelector('.hint-txt') || {}).textContent || ''
    };
  })()`);
  check('the «دفعة العميل» box lists the batches', !!(picked && picked.options >= 1), picked);
  check('the batch is labelled with its number, its customer and its material',
    !!(picked && /TOL-\d{4}/.test(picked.optionText || '') && /عميل|شركة|العميل/.test(picked.optionText || '')),
    picked && picked.optionText);
  check('picking the batch fills the line with the raw material', !!(picked && picked.item && picked.item.length), picked && picked.item);
  check('picking the batch fills the quantity that is left', !!(picked && picked.qty && Number(String(picked.qty).replace(/,/g, '')) === 500), picked && picked.qty);
  await closeEditor();

  /* picking the batch on a sale tells the user what the batch holds */
  await openEditor('sale');
  const saleHint = await js(`(async () => {
    const ed = [...document.querySelectorAll('.modal.editor')].pop();
    const cell = ed.querySelector('.ed-cell.batch-cell');
    if (!cell) return { error: 'no-batch-cell' };
    const inp = cell.querySelector('.combo-input');
    inp.focus();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const pops = [...document.querySelectorAll('.combo-pop')].filter(p => p.style.display !== 'none');
    const pop = pops[pops.length - 1];
    const opts = pop ? [...pop.querySelectorAll('.combo-opt')] : [];
    if (!opts.length) return { error: 'no-options' };
    opts[0].click();
    await new Promise(r => setTimeout(r, 500));
    return { hint: (cell.querySelector('.hint-txt') || {}).textContent || '' };
  })()`);
  check('the invoice says what the batch holds', !!(saleHint && /العلب المنتجة لهذه الدفعة/.test(saleHint.hint || '')), saleHint);
  check('the invoice says who the customer is', !!(saleHint && /العميل/.test(saleHint.hint || '')), saleHint);
  await closeEditor();

  /* ---- the «صرف خام إلى الإنتاج» list shows the batch of every paper ---- */
  const madeDoc = await js(`(async () => {
    const batches = await SamDB.call('listTolling', 200);
    if (!batches.length) return { error: 'no-batches' };
    const b = batches[0];
    const d = await SamDB.call('saveDocument', {
      kind: 'prod_issue',
      doc_date: new Date().toISOString().slice(0, 10),
      external_no: 'ISS-RENDER',
      batch_id: b.id,
      lines: [{ item_id: ${ids.raw.id}, bucket: 'good', pieces: 50, warehouse_id: ${ids.wh.id} }]
    });
    return { id: d.id, doc_no: d.doc_no, batch_id: d.batch_id };
  })()`);
  check('a «صرف خام إلى الإنتاج» paper can carry a batch', !!(madeDoc && madeDoc.batch_id), madeDoc);
  await js(`document.querySelector('#prodTabs .tab[data-tab=prodissues]').click()`);
  await js(`SamProd.load(); 1`);
  await sleep(1600);
  const issueList = await js(`(() => {
    const t = document.getElementById('prodIssueDocsTbl');
    const rows = [...t.querySelectorAll('tbody tr')];
    return {
      rows: rows.length,
      head: [...t.querySelectorAll('thead th')].map(h => h.textContent.trim()),
      title: (document.querySelector('#prodissuesPanel .card-head h3') || {}).textContent || '',
      texts: rows.map(r => r.innerText.replace(/\\s+/g, ' ').trim())
    };
  })()`);
  check('the «صرف خام إلى الإنتاج» list carries a row', issueList && issueList.rows >= 1, issueList && issueList.rows);
  check('the card of the list says «صرف خام إلى الإنتاج»', !!(issueList && /صرف خام إلى الإنتاج/.test(issueList.title || '')), issueList && issueList.title);
  check('the list has a column for the batch', !!(issueList && issueList.head.some((h) => /الدفعة/.test(h))), issueList && issueList.head);
  check('the list shows the batch and its customer',
    !!(issueList && (issueList.texts || []).some((t) => /TOL-\d{4}/.test(t) && /شركة العميل للاختبار/.test(t))),
    issueList && issueList.texts);
  const tabLabel = await js(`(() => {
    const t = document.querySelector('#prodTabs .tab[data-tab=prodissues]');
    return t ? t.textContent.trim() : null;
  })()`);
  check('the tab of the list says «صرف خام إلى الإنتاج»', !!(tabLabel && /صرف خام إلى الإنتاج/.test(tabLabel)), tabLabel);

  /* ---- the operations screen: the names of the kinds come from the database ---- */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(1600);
  const launcher = await js(`(() => {
    const tiles = [...document.querySelectorAll('#docKinds .kl-tile')];
    return tiles.map(t => ({ name: (t.querySelector('.kl-name') || {}).textContent, tone: [...t.classList].filter(c => c.startsWith('tone-'))[0] }));
  })()`);
  check('the launcher says «صرف خام إلى الإنتاج»',
    !!(launcher && launcher.some((t) => /صرف خام إلى الإنتاج/.test(t.name || ''))), launcher && launcher.map((t) => t.name));
  check('the launcher says «استلام المنتج التام»',
    !!(launcher && launcher.some((t) => /استلام المنتج التام/.test(t.name || ''))), launcher && launcher.map((t) => t.name));
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(900);

  /* ---- the printed papers ---- */
  const closePreview = async () => {
    await js(`(() => {
      const pv = [...document.querySelectorAll('.pv')].pop();
      if (!pv) return 'none';
      const b = [...pv.querySelectorAll('.pv-bar .btn')].find(x => /إغلاق/.test(x.textContent || ''));
      if (b) b.click();
      return 'closed';
    })()`);
    await sleep(600);
  };

  /* «طباعة تصريح دخول» — a half A5 sheet, signed by the gate and the keeper */
  const permit = await js(`(async () => {
    const batches = await SamDB.call('listTolling', 200);
    if (!batches.length) return { error: 'no-batches' };
    const b = batches[0];
    SamProd.printTolling(b.id);
    await new Promise(r => setTimeout(r, 1000));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return { error: 'no-preview' };
    const sheet = pv.querySelector('.sheet');
    return {
      doc_no: b.doc_no,
      title: (pv.querySelector('.doc-title h1') || {}).textContent || '',
      half: sheet ? sheet.classList.contains('half') : false,
      text: pv.innerText.replace(/\\s+/g, ' ').trim(),
      sigs: [...pv.querySelectorAll('.sig-band .nm')].map(n => n.textContent.trim())
    };
  })()`);
  check('«طباعة تصريح دخول» opens the print preview', !!(permit && !permit.error), permit && permit.error);
  check('the permit is half an A5 sheet', !!(permit && permit.half), permit && permit.half);
  check('the permit carries the number of the batch', !!(permit && /TOL-\d{4}/.test(permit.text || '')), permit && permit.text);
  check('the permit carries the customer and the material',
    !!(permit && /شركة العميل للاختبار/.test(permit.text || '') && /خام العميل/.test(permit.text || '')), permit && permit.text);
  check('the permit is signed by the gate guard and the warehouse keeper',
    !!(permit && (permit.sigs || []).includes('حارس البوابة') && (permit.sigs || []).includes('أمين المخازن')), permit && permit.sigs);
  check('the permit is NOT signed by the driver', !!(permit && !(permit.sigs || []).includes('السائق')), permit && permit.sigs);
  await closePreview();

  /* the invoice — the batch and the blowing fee are on the paper */
  const invPrint = await js(`(async () => {
    const batches = await SamDB.call('listTolling', 200);
    if (!batches.length) return { error: 'no-batches' };
    const b = batches[0];
    const d = await SamDB.call('saveDocument', {
      kind: 'sale',
      doc_date: new Date().toISOString().slice(0, 10),
      external_no: 'INV-RENDER',
      party_id: ${ids.party.id},
      invoice_value: '9000',
      blowing_fee: '1500',
      batch_id: b.id,
      lines: [{ item_id: ${ids.box.id}, bucket: 'good', pieces: 10, warehouse_id: ${ids.wh.id} }]
    });
    SamDocs.printInvoice(d.id);
    await new Promise(r => setTimeout(r, 1000));
    const pv = [...document.querySelectorAll('.pv')].pop();
    if (!pv) return { error: 'no-preview', doc_no: d.doc_no };
    return {
      doc_no: d.doc_no,
      batch_id: d.batch_id,
      blowing_fee: d.blowing_fee,
      text: pv.innerText.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  check('the invoice keeps the batch', !!(invPrint && invPrint.batch_id), invPrint);
  check('the invoice keeps the blowing fee', !!(invPrint && invPrint.blowing_fee === '1500'), invPrint);
  check('the printed invoice carries the blowing fee',
    !!(invPrint && /أجور نفخ/.test(invPrint.text || '') && /1,500|1500/.test(invPrint.text || '')), invPrint && invPrint.text);
  check('the printed invoice carries the batch', !!(invPrint && /TOL-\d{4}/.test(invPrint.text || '')), invPrint && invPrint.text);
  await closePreview();

  /* ---- the details of a document that carries a batch ---- */
  const details = await js(`(async () => {
    const docs = await SamDB.call('listDocuments', { kind: 'sale' });
    const d = docs.find(x => x.batch_id);
    if (!d) return { error: 'no-doc' };
    SamDocs.viewDoc(d.id);
    await new Promise(r => setTimeout(r, 900));
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return { error: 'no-modal' };
    const dl = m.querySelector('dl.info');
    const pairs = dl ? [...dl.querySelectorAll('dt')].map((dt, i) => [dt.textContent.trim(), dl.querySelectorAll('dd')[i] ? dl.querySelectorAll('dd')[i].textContent.trim() : '']) : [];
    return { doc_no: d.doc_no, pairs, text: m.innerText.replace(/\\s+/g, ' ').trim() };
  })()`);
  check('the details of the invoice show the batch',
    !!(details && (details.pairs || []).some((p) => /دفعة العميل/.test(p[0]) && /TOL-\d{4}/.test(p[1] || ''))), details && details.pairs);
  check('the details of the invoice show the blowing fee',
    !!(details && (details.pairs || []).some((p) => /أجور نفخ/.test(p[0]) && /1500/.test(p[1] || ''))), details && details.pairs);
  await js(`(() => {
    const m = [...document.querySelectorAll('.overlay .modal')].pop();
    if (!m) return 'none';
    const b = [...m.querySelectorAll('.modal-foot .btn')].find(x => /إغلاق/.test(x.textContent || ''));
    if (b) b.click();
    return 'closed';
  })()`);
  await sleep(600);

}

/* ================= run ================= */
app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  /* ---------------- seed ---------------- */
  const wh = dbMod.addWarehouse({ code: 'W-T7', name: 'مخزن الاختبار', location: 'صنعاء' });
  const raw = dbMod.addItem({ code: 'RAW-7', name: 'خام العميل', base_unit: 'حبة', category: 'خام', pieces_per_carton: 24 },
    [{ warehouseId: wh.id, good: 0 }]);
  const box = dbMod.addItem({ code: 'BOX-7', name: 'علبة منفوخة', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 24 },
    [{ warehouseId: wh.id, good: 0 }]);
  const party = dbMod.addParty({ name: 'شركة العميل للاختبار', phone: '770000000', type: 'customer' });
  logLine(`  seeded: warehouse ${wh.id}, raw ${raw.id}, box ${box.id}, party ${party.id}`);

  logLine('\n===== 1. the flow of the four steps =====');
  await flowTests({ wh, raw, box, party });

  logLine('\n===== 2. the screen =====');
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
    if (lvl >= 2) { errors.push(`[console] ${d.source || ''} ${d.message}`); logLine('CONSOLE ' + lvl + ': ' + (d.message || '').slice(0, 300)); }
  });
  await rendererTests({ wh, raw, box, party });

  logLine('\nCONSOLE ERRORS: ' + errors.length);
  errors.forEach((e) => logLine('  ' + e));
  shutdown(fail || errors.length ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
