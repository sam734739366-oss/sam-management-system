/**
 * tools/v3-db-check.js — fast DB-layer verification for V3 tasks 1..4.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v3-db-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v3db');
const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
async function rmRetry(t) { for (let i = 0; i < 8; i++) { try { fs.rmSync(t, { recursive: true, force: true }); if (!fs.existsSync(t)) return; } catch (e) { await sleep(100 * 2 ** i); } } }

app.whenReady().then(async () => {
  db.close(); await rmRetry(DATA); fs.mkdirSync(DATA, { recursive: true });
  db.init(DATA);

  // Task 1: equal warehouses, no main constraint
  const seeded = db.listWarehouses();
  check('seed one plain warehouse', seeded.length === 1 && seeded[0].name === 'المخزن 1', seeded.map((w) => w.name));
  const A = db.addWarehouse({ code: 'A', name: 'مخزن أ', location: 'الموقع أ' });
  const B = db.addWarehouse({ code: 'B', name: 'مخزن ب', location: 'الموقع ب' });
  check('add two equal warehouses (no kind required)', !!A.id && !!B.id && db.listWarehouses().length === 3);
  check('all warehouses kind=sub', db.listWarehouses().every((w) => w.kind === 'sub'));

  // item with opening split across warehouses
  const item = db.addItem({ code: 'I1', name: 'صنف اختبار', base_unit: 'علبة', pieces_per_carton: 12 },
    [{ warehouseId: A.id, good: 100 }, { warehouseId: B.id, good: 50 }]);
  const attached = db.getItem(item.id);
  check('stock total spans warehouses', attached.stock.total === 150, attached.stock);
  check('per-warehouse breakdown', attached.stockByWarehouse[A.id].good === 100 && attached.stockByWarehouse[B.id].good === 50);

  const cust = db.addParty({ name: 'عميل', type: 'customer' });
  /* the program counts in the LOCAL day (date('now','localtime')) — the
     test must use the same day, or it fails after midnight */
  const today = new Date().toLocaleDateString('sv');
  const past = '2026-01-15';

  // Task 2/3: sale with past date, lines in two warehouses
  const sale = db.saveDocument({
    kind: 'sale', doc_no: 'EXT-100', doc_date: past, party_id: cust.id,
    lines: [
      { item_id: item.id, bucket: 'good', pieces: 30, warehouse_id: A.id },
      { item_id: item.id, bucket: 'good', pieces: 20, warehouse_id: B.id }
    ]
  });
  /* V6: the number the caller sends is the EXTERNAL one — the document gets
     an internal number of its own, and that is the one the ledger carries. */
  const saleMoves = db.reportQuery({ dateFrom: past, dateTo: past }).rows.filter((r) => r.docNo === sale.doc_no);
  check('sale moves carry business move_date', saleMoves.length === 2 && saleMoves.every((r) => r.moveDate === past), saleMoves.map((r) => r.moveDate));
  check('the typed number survives as the external number', sale.external_no === 'EXT-100', sale.external_no);
  check('per-warehouse balance after sale', db.availableInLocation(item.id, A.id, 'good') === 70 && db.availableInLocation(item.id, B.id, 'good') === 30);

  // Task 3: reportQuery filters by move_date (past doc excluded from today)
  const todayRep = db.reportQuery({ dateFrom: today, dateTo: today });
  check('reportQuery today excludes past-date doc', todayRep.rows.every((r) => r.docNo !== sale.doc_no), todayRep.rows.length);
  const pastRep = db.reportQuery({ dateFrom: past, dateTo: past });
  check('reportQuery past includes the doc', pastRep.rows.some((r) => r.docNo === sale.doc_no));

  // Task 4: dailyReport for the past date
  const dr = db.dailyReport({ date: past });
  const row = dr.rows.find((r) => r.itemId === item.id);
  check('dailyReport has item row with unit', !!row && row.baseUnit === 'علبة');
  check('dailyReport per-warehouse in/out/balance', row.cells[A.id].outQty === 30 && row.cells[A.id].balance === 70 && row.cells[B.id].outQty === 20 && row.cells[B.id].balance === 30, row.cells);
  check('dailyReport grand balance', dr.grand.balance === 100, dr.grand);
  check('dailyReport warehouse totals', dr.warehouseTotals[A.id].balance === 70 && dr.warehouseTotals[B.id].balance === 30);
  const drToday = db.dailyReport({ date: today });
  const todayRow = drToday.rows.find((r) => r.itemId === item.id);
  check('dailyReport today excludes past-date sale (out=0, opening in=150)', todayRow.totalOut === 0 && todayRow.totalIn === 150, { in: todayRow.totalIn, out: todayRow.totalOut });

  // Task 3: per-warehouse shortage warning (sell 999 from A which has 70)
  const warnDoc = db.saveDocument({
    kind: 'sale', doc_no: 'EXT-200', doc_date: today, party_id: cust.id,
    lines: [{ item_id: item.id, bucket: 'good', pieces: 999, warehouse_id: A.id }]
  });
  check('shortage warning mentions warehouse', (warnDoc.warnings || []).some((w) => w.includes('مخزن أ')), warnDoc.warnings);

  console.log(`\n${pass}/${pass + fail} DB checks passed`);
  db.close(); await rmRetry(DATA);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });