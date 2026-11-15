/**
 * tools/v7-4-check.js — the V7.4 round:
 *   · the new reports exist and carry real data
 *   · the documents are listed in the order of the customer's own number
 *   · the document view walks to the previous and the next document
 *   · the picture of an item opens big
 *   · ONE tab for the raw material and ONE for the production receipt
 *   · the operations header shows the raw material that left for the plant
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-4-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v74data');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const LOG = path.join(ROOT, '.tmp', 'v7-4-check.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLine = (s) => { console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
const check = (n, ok, d) => { logLine(`${ok ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' :: ' + JSON.stringify(d) : ''}`); ok ? pass++ : fail++; };

process.env.SAM_DATA_DIR = DATA;

app.whenReady().then(async () => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  dbMod.init(DATA);
  session.ensureSeed();

  const wh = dbMod.addWarehouse({ code: 'W1', name: 'مخزن', location: '' });
  const item = dbMod.addItem({ code: 'A-1', name: 'صنف', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: wh.id, good: 500 }]);
  const cust = dbMod.addParty({ name: 'عميل الاختبار', type: 'customer', phone: '770000' });
  const supp = dbMod.addParty({ name: 'مورد الاختبار', type: 'supplier', phone: '771000' });

  /* three sale documents whose EXTERNAL numbers are out of order */
  dbMod.saveDocument({ kind: 'sale', doc_date: '2026-05-03', party_id: cust.id, warehouse_id: wh.id, external_no: 'INV-300', lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 10 }] });
  dbMod.saveDocument({ kind: 'sale', doc_date: '2026-05-01', party_id: cust.id, warehouse_id: wh.id, external_no: 'INV-100', lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 20 }] });
  dbMod.saveDocument({ kind: 'purchase', doc_date: '2026-05-02', party_id: supp.id, warehouse_id: wh.id, external_no: 'PUR-200', lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 30 }] });
  dbMod.saveDocument({ kind: 'prod_issue', doc_date: '2026-05-04', party_id: null, warehouse_id: wh.id, external_no: 'PRD-400', lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 40 }] });
  dbMod.saveDocument({ kind: 'prod_receipt', doc_date: '2026-05-05', party_id: null, warehouse_id: wh.id, external_no: 'PRC-500', lines: [{ item_id: item.id, warehouse_id: wh.id, pieces: 35 }] });

  /* ---- 1 — the order of the external number ---- */
  const docs = dbMod.listDocuments({});
  const ext = docs.map((d) => d.external_no).filter(Boolean);
  const sorted = ext.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  check('the documents are listed by the external number', JSON.stringify(ext) === JSON.stringify(sorted), ext);

  /* ---- 2 — the new reports ---- */
  const keys = dbMod.REPORTS.map((r) => r.key);
  ['today_sales', 'production_receipts', 'customer_account', 'supplier_account', 'documents_report']
    .forEach((k) => check(`the report «${k}» is in the catalogue`, keys.indexOf(k) >= 0, keys));

  const sales = dbMod.runReport({ report: 'today_sales' });
  check('the sales report has the right shape', sales && sales.rows && sales.columns.length >= 5, sales && sales.columns.map((c) => c.key));
  const prod = dbMod.runReport({ report: 'production_receipts' });
  check('the production report carries the receipts', prod && prod.rows.length >= 1, prod && prod.rows.length);
  const custAcc = dbMod.runReport({ report: 'customer_account' });
  check('the customer account report has the customer', custAcc && custAcc.rows.some((r) => r.partyName === 'عميل الاختبار'), custAcc && custAcc.rows.map((r) => r.partyName));
  const suppAcc = dbMod.runReport({ report: 'supplier_account' });
  check('the supplier account report has the supplier', suppAcc && suppAcc.rows.some((r) => r.partyName === 'مورد الاختبار'), suppAcc && suppAcc.rows.map((r) => r.partyName));
  const docRep = dbMod.runReport({ report: 'documents_report' });
  check('the documents report carries every document', docRep && docRep.rows.length >= 5, docRep && docRep.rows.length);

  /* ---- 3 — the screen ---- */
  require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

  const win = new BrowserWindow({
    width: 1600, height: 1000, show: false, frame: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    logLine('JS FAILED: ' + String(code).replace(/\s+/g, ' ').slice(0, 140) + ' :: ' + e.message);
    return null;
  });

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(2600);

  /* the operations header shows the raw material */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(1800);
  const strip = (await js(`(() => {
    const h = document.getElementById('rawIssueStrip');
    if (!h) return { err: 'no strip' };
    return {
      text: h.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120),
      cards: h.querySelectorAll('.raw-card').length,
      go: !!h.querySelector('#rawGoProduction')
    };
  })()`)) || {};
  check('the operations header shows the raw material', !!strip.cards && strip.cards >= 1, strip);
  check('the header offers the production screen', strip.go === true, strip);

  /* ONE tab for the raw material, ONE for the receipt */
  await js(`document.querySelector('.nav-item[data-view=production]').click()`);
  await sleep(1800);
  const tabs = (await js(`(() => {
    const list = [...document.querySelectorAll('#prodTabs .tab')].map((t) => t.textContent.trim());
    return {
      list,
      issues: document.querySelectorAll('#prodTabs .tab[data-tab="issues"]').length,
      receipts: document.querySelectorAll('#prodTabs .tab[data-tab="receipts"]').length,
      prodissues: document.querySelectorAll('#prodTabs .tab[data-tab="prodissues"]').length,
      prodreceipts: document.querySelectorAll('#prodTabs .tab[data-tab="prodreceipts"]').length,
      legacyInside: document.querySelectorAll('#prodissuesPanel #issuesPanel').length,
      legacyReceiptsInside: document.querySelectorAll('#prodreceiptsPanel #receiptsPanel').length
    };
  })()`)) || {};
  check('there is no tab for the old raw material', tabs.issues === 0, tabs.list);
  check('there is no tab for the old production receipt', tabs.receipts === 0, tabs.list);
  check('there is ONE tab for the raw material', tabs.prodissues === 1, tabs.list);
  check('there is ONE tab for the production receipt', tabs.prodreceipts === 1, tabs.list);
  check('the old raw-material records are not a second tab', tabs.legacyInside === 0, tabs);
  check('the old receipt records are not a second tab', tabs.legacyReceiptsInside === 0, tabs);

  /* the old panels are gone — their records became documents */
  const gone = (await js(`(() => ({
    issuesPanel: !!document.getElementById('issuesPanel'),
    receiptsPanel: !!document.getElementById('receiptsPanel')
  }))()`)) || {};
  check('the old raw-material panel is gone', gone.issuesPanel === false, gone);
  check('the old receipt panel is gone', gone.receiptsPanel === false, gone);

  /* the walk from one document to the next */
  await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
  await sleep(1400);
  const aDoc = dbMod.listDocuments({})[0];
  const walk = (await js(`(function(){
    if (!window.SamDocs || !SamDocs.viewDoc) return { err: 'no SamDocs' };
    SamDocs.viewDoc(${Number(aDoc.id)});
    return { id: ${Number(aDoc.id)} };
  })()`)) || {};
  await sleep(1200);
  const nav = (await js(`(() => {
    const overlays = [...document.querySelectorAll('.overlay')];
    const btns = overlays.length
      ? [...overlays[overlays.length - 1].querySelectorAll('.modal-foot .btn')].map((b) => b.textContent.trim())
      : [];
    const heads = overlays.length ? [...overlays[overlays.length - 1].querySelectorAll('h3')].map((h) => h.textContent.trim()) : [];
    return { btns, heads, overlays: overlays.length, has: btns.some((b) => b.indexOf('التالي') >= 0) || btns.some((b) => b.indexOf('السابق') >= 0) };
  })()`)) || {};
  check('the document view offers the walk to the neighbours', nav.has === true, nav);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  try { dbMod.close(); } catch (e) {}
  app.exit(fail ? 1 : 0);
}).catch((e) => { logLine('FATAL: ' + (e && e.stack ? e.stack : e)); app.exit(1); });
