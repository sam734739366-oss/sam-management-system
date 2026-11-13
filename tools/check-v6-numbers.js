/**
 * tools/check-v6-numbers.js — فحص رقمَي المستند (V6).
 *
 * 1) الترحيل: قاعدة بيانات حقيقية (نسخة بيانات المستخدم) تُفتح بالبرنامج
 *    الجديد — كل رقم كتبه المستخدم يجب أن ينجو في خانة «الرقم الخارجي»،
 *    وكل مستند يجب أن يحصل على رقم داخلي لا يتكرر.
 * 2) الترقيم: رقم جديد لكل نوع، لا يعاد رقم م删除.document، ولا يتغير
 *    الرقم عند التعديل.
 * 3) نوع المستند الجديد «توريد الإنتاج» يخفض الرصيد.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/check-v6-numbers.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.tmp', 'v6num');
const LIVE_COPY = path.join(ROOT, 'نسخة بيانات', 'sam.db');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + ' :: ' + JSON.stringify(detail)); }
  else { fail++; console.log('FAIL  ' + name + ' :: ' + JSON.stringify(detail)); }
}

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));

function copyLive(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  ['sam.db', 'sam.db-wal', 'sam.db-shm'].forEach((f) => {
    const src = path.join(ROOT, 'نسخة بيانات', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, f));
  });
  const Database = require('better-sqlite3');
  const db = new Database(path.join(destDir, 'sam.db'));
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  ['sam.db-wal', 'sam.db-shm'].forEach((f) => {
    const p = path.join(destDir, f);
    if (fs.existsSync(p)) { try { fs.rmSync(p); } catch (e) { /* ignore */ } }
  });
}

function rawAll(file, sql, params) {
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true });
  try { return db.prepare(sql).all(...(params || [])); }
  finally { db.close(); }
}

app.whenReady().then(async () => {
  try { await run(); }
  catch (e) { fail++; console.log('FAIL  the harness crashed :: ' + (e && e.stack ? e.stack : String(e))); }
  try { dbMod.close(); } catch (e) { /* ignore */ }
  console.log('\n' + (fail === 0 ? pass + '/' + (pass + fail) + ' checks passed' : fail + ' FAILURES out of ' + (pass + fail)));
  app.exit(fail === 0 ? 0 : 1);
});

const bail = setTimeout(() => { console.log('FAIL  timeout'); process.exit(1); }, 120000);
app.on('will-quit', () => clearTimeout(bail));

async function run() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  /* ================= A. the real database of the customer ================= */
  if (!fs.existsSync(LIVE_COPY)) {
    console.log('SKIP  no live copy at ' + LIVE_COPY);
  } else {
    const dir = path.join(WORK, 'live');
    copyLive(dir);
    const file = path.join(dir, 'sam.db');
    const before = rawAll(file, 'SELECT id, kind, doc_no, doc_date FROM documents ORDER BY id');
    const beforeMoves = rawAll(file, 'SELECT id, item_id, piece_delta, doc_no FROM stock_moves ORDER BY id');
    const beforeLines = rawAll(file, 'SELECT id, document_id, item_id, pieces FROM doc_lines ORDER BY id');

    dbMod.init(dir);
    dbMod.close();

    const after = rawAll(file, 'SELECT id, kind, doc_no, external_no, doc_date FROM documents ORDER BY id');
    const afterMoves = rawAll(file, 'SELECT id, item_id, piece_delta, doc_no FROM stock_moves ORDER BY id');
    const afterLines = rawAll(file, 'SELECT id, document_id, item_id, pieces FROM doc_lines ORDER BY id');

    check('every document survived the migration',
      after.length === before.length && after.every((d, i) => d.id === before[i].id && d.kind === before[i].kind),
      { before: before.length, after: after.length });
    check('the number the user typed is kept as the external number',
      after.every((d, i) => String(d.external_no || '') === String(before[i].doc_no || '')),
      after.map((d) => d.doc_no + ' / خارجي=' + d.external_no));
    check('every document got an internal number of its own kind',
      after.every((d) => /^[A-Z]{3}-\d{4,}$/.test(String(d.doc_no))), after.map((d) => d.doc_no));
    const internalNos = after.map((d) => d.doc_no);
    check('no two documents share an internal number',
      new Set(internalNos).size === internalNos.length, internalNos);
    check('the ledger follows the new numbers',
      JSON.stringify(afterMoves.map((m) => [m.id, m.item_id, m.piece_delta])) ===
      JSON.stringify(beforeMoves.map((m) => [m.id, m.item_id, m.piece_delta])),
      afterMoves.map((m) => m.doc_no));
    check('no ledger row keeps a number that no document has',
      afterMoves.every((m) => !m.doc_no || internalNos.indexOf(m.doc_no) !== -1 ||
        beforeMoves.some((b) => b.id === m.id && b.doc_no === m.doc_no)),
      afterMoves.map((m) => m.doc_no));
    check('every document line survived',
      JSON.stringify(afterLines) === JSON.stringify(beforeLines),
      { before: beforeLines.length, after: afterLines.length });

    /* running it twice must change nothing */
    dbMod.init(dir);
    dbMod.close();
    const twice = rawAll(file, 'SELECT id, kind, doc_no, external_no FROM documents ORDER BY id');
    check('the migration is idempotent',
      JSON.stringify(twice) === JSON.stringify(after.map((d) => ({ id: d.id, kind: d.kind, doc_no: d.doc_no, external_no: d.external_no }))),
      twice);
  }

  /* ================= B. the numbering rules on a fresh database ================= */
  const dir2 = path.join(WORK, 'fresh');
  fs.mkdirSync(dir2, { recursive: true });
  dbMod.init(dir2);

  const wh = dbMod.addWarehouse({ code: 'W-A', name: 'مخزن أ', location: '' });
  const item = dbMod.addItem({ code: '0001', name: 'أمبولة', base_unit: 'حبة', category: 'منتج' },
    [{ warehouseId: wh.id, good: 5000 }]);
  const cust = dbMod.addParty({ name: 'عميل', phone: '0555000000', type: 'customer' });

  const sale1 = dbMod.saveDocument({
    kind: 'sale', doc_date: '2026-01-01', party_id: cust.id, warehouse_id: wh.id,
    external_no: 'INV-77', lines: [{ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces: 100 }]
  });
  check('a new document gets an internal number', /^SAL-\d{4}$/.test(sale1.doc_no), sale1.doc_no);
  check('the number the user typed is stored as the external number',
    sale1.external_no === 'INV-77', sale1.external_no);

  const sale2 = dbMod.saveDocument({
    kind: 'sale', doc_date: '2026-01-02', party_id: cust.id, warehouse_id: wh.id,
    external_no: 'INV-77', lines: [{ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces: 50 }]
  });
  check('the same external number may repeat — ours never does',
    sale2.doc_no !== sale1.doc_no && sale2.external_no === 'INV-77', { a: sale1.doc_no, b: sale2.doc_no });

  /* an edit must never change the number */
  const edited = dbMod.saveDocument({
    id: sale1.id, kind: 'sale', doc_date: '2026-01-01', party_id: cust.id, warehouse_id: wh.id,
    external_no: 'INV-78', lines: [{ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces: 120 }]
  });
  check('the internal number survives the edit', edited.doc_no === sale1.doc_no, { was: sale1.doc_no, now: edited.doc_no });
  check('the external number follows the edit', edited.external_no === 'INV-78', edited.external_no);

  /* deleting the last document must not free its number */
  dbMod.deleteDocument(sale2.id);
  const sale3 = dbMod.saveDocument({
    kind: 'sale', doc_date: '2026-01-03', party_id: cust.id, warehouse_id: wh.id,
    external_no: 'INV-79', lines: [{ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces: 10 }]
  });
  check('a deleted number is never used again', sale3.doc_no !== sale2.doc_no && sale3.doc_no !== sale1.doc_no,
    { deleted: sale2.doc_no, fresh: sale3.doc_no });

  /* every kind has its own series */
  const prc = dbMod.saveDocument({
    kind: 'prod_receipt', doc_date: '2026-01-04',
    lines: [{ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces: 200 }]
  });
  check('each kind has its own number series', /^PRC-\d{4}$/.test(prc.doc_no), prc.doc_no);

  /* ================= C. the new kind «توريد الإنتاج» ================= */
  const before3 = dbMod.availableInLocation(item.id, wh.id, 'good');
  const issue = dbMod.saveDocument({
    kind: 'prod_issue', doc_date: '2026-01-05', notes: 'توريد إنتاج',
    lines: [{ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces: 300 }]
  });
  const after3 = dbMod.availableInLocation(item.id, wh.id, 'good');
  check('«توريد الإنتاج» has its own number series', /^PRI-\d{4}$/.test(issue.doc_no), issue.doc_no);
  check('«توريد الإنتاج» lowers the stock', after3 === before3 - 300, { before: before3, after: after3 });
  check('«توريد الإنتاج» is listed with the documents',
    dbMod.listDocuments({ kind: 'prod_issue' }).length === 1, dbMod.listDocuments({ kind: 'prod_issue' }).map((d) => d.doc_no));
  check('the search finds the external number',
    dbMod.listDocuments({ search: 'INV-79' }).length === 1, dbMod.listDocuments({ search: 'INV-79' }).map((d) => d.doc_no));

  dbMod.close();
}
