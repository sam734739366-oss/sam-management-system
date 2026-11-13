/**
 * tools/v7-batch-db-check.js — the batch layer on its own (no renderer):
 * the numbers of the customer's raw material must follow it exactly.
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-batch-db-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v7batch');

const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
};

process.env.SAM_DATA_DIR = DATA;

app.whenReady().then(() => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DATA, { recursive: true });
  db.init(DATA);
  session.ensureSeed();

  const wh = db.addWarehouse({ code: 'W1', name: 'مخزن الخام', location: '' });
  const raw = db.addItem({ code: 'R-1', name: 'خامة العميل', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: wh.id, good: 0 }]);
  const box = db.addItem({ code: 'B-1', name: 'علبة جاهزة', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 1 },
    [{ warehouseId: wh.id, good: 0 }]);
  const party = db.addParty({ name: 'عميل النفخ', type: 'customer', phone: '771111111' });

  /* 1 — the batch (the receipt of the customer's raw material) */
  const batch = db.saveTolling({ doc_date: '2026-05-01', party_id: party.id, raw_item_id: raw.id, warehouse_id: wh.id, pieces_in: 1000, bags_in: 20, note: 'خامة' });
  check('the batch is created', !!batch && batch.id > 0, batch && { no: batch.doc_no });
  check('the batch knows its customer', batch.partyName === 'عميل النفخ', batch && batch.partyName);
  check('the batch starts with nothing issued', batch.issued === 0 && batch.remaining === 1000, batch && { issued: batch.issued, remaining: batch.remaining });
  const moves = db.prepare ? null : null;
  const one = db.listTolling()[0];
  check('the batch is in the list', !!one && one.id === batch.id, one && one.doc_no);

  /* 2 — the raw material leaves for the plant */
  const issue = db.saveDocument({
    kind: 'prod_issue', doc_date: '2026-05-02', party_id: party.id, warehouse_id: wh.id, batch_id: batch.id,
    lines: [{ item_id: raw.id, warehouse_id: wh.id, pieces: 600 }]
  });
  let b = db.getTolling(batch.id);
  check('the issued material is counted', b.issued === 600, b && b.issued);
  check('the remainder follows', b.remaining === 400, b && b.remaining);
  const isCust = db.prepare ? null : null;
  const flagged = db.listRecentMoves(50).filter((m) => m.docType === 'prod_issue' || m.doc_type === 'prod_issue');
  check('the movement of the batch belongs to the customer', flagged.some((m) => Number(m.isCustomer || m.is_customer) === 1), flagged.slice(0, 2));

  /* 3 — the boxes come back from the plant */
  db.saveDocument({
    kind: 'prod_receipt', doc_date: '2026-05-03', party_id: party.id, warehouse_id: wh.id, batch_id: batch.id,
    lines: [{ item_id: box.id, warehouse_id: wh.id, pieces: 550 }]
  });
  b = db.getTolling(batch.id);
  check('the produced boxes are counted', b.producedGood === 550, b && b.producedGood);
  check('the batch is ready for the customer', b.status === 'ready', b && b.status);

  /* 4 — the customer is invoiced and the boxes leave */
  const sale = db.saveDocument({
    kind: 'sale', doc_date: '2026-05-04', party_id: party.id, warehouse_id: wh.id, batch_id: batch.id,
    blowing_fee: '25000', external_no: 'INV-777',
    lines: [{ item_id: box.id, warehouse_id: wh.id, pieces: 500 }]
  });
  b = db.getTolling(batch.id);
  check('the delivered boxes are counted', b.delivered === 500, b && b.delivered);
  check('the boxes still to deliver are known', b.toDeliver === 50, b && b.toDeliver);
  const got = db.getDocument(sale.id);
  check('the invoice keeps the batch', Number(got.batch_id) === batch.id, got && got.batch_id);
  check('the invoice keeps the blowing fee', String(got.blowing_fee) === '25000', got && got.blowing_fee);
  check('the invoice keeps the external number', got.external_no === 'INV-777', got && got.external_no);

  /* 5 — a batch that is in use cannot vanish */
  let refused = null;
  try { db.deleteTolling(batch.id); } catch (e) { refused = e; }
  check('a batch that is used cannot be deleted', !!refused && /مستند/.test(refused.message), refused && refused.message);
  check('the batch is still there', !!db.getTolling(batch.id), db.getTolling(batch.id) && db.getTolling(batch.id).doc_no);

  /* 6 — the customer's material is really in the ledger */
  const stock = db.itemStock(raw.id);
  const rawTotal = (stock || []).reduce((a, r) => a + Number(r.good || 0), 0);
  check('the raw material of the customer is still in the warehouse', rawTotal === 400, { rawTotal, rows: stock });

  /* 7 — a free batch can be deleted, and it takes its movement with it */
  const free = db.saveTolling({ doc_date: '2026-05-05', party_id: party.id, raw_item_id: raw.id, warehouse_id: wh.id, pieces_in: 50 });
  db.deleteTolling(free.id);
  check('a free batch is deleted', !db.getTolling(free.id), free.id);
  const stock2 = db.itemStock(raw.id);
  const rawTotal2 = (stock2 || []).reduce((a, r) => a + Number(r.good || 0), 0);
  check('the movement of the deleted batch went with it', rawTotal2 === 400, { rawTotal2 });

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  try { db.close(); } catch (e) {}
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL', e && e.stack); app.exit(1); });
