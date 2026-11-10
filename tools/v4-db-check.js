/**
 * tools/v4-db-check.js — V4 data-layer verification (db.js).
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v4-db-check.js
 *
 * Checks:
 *  (a) the 9 document kinds are accepted; prod_receipt adds, gate_out takes,
 *      adjustment honours its own per-line sign.
 *  (b) prod_receipt / gate_in / gate_out / adjustment REJECT a line without
 *      its own warehouse_id (no silent fallback to the header).
 *  (c) adjustment REJECTS a line whose sign is neither 1 nor -1.
 *  (d) documentImpact() describes an adjustment per line (both directions).
 *  (e) hard delete + edit revert / replace the balances exactly.
 *  (f) the migration path: a V3-shaped database (old documents CHECK + held
 *      buckets) opened through the V4 code keeps every row and every id.
 *  (g) runReport() works for EVERY key of the REPORTS catalogue, with the
 *      date-range and warehouse filters.
 *  (h) saveReceipt() writes no stock movement; receiptImpact() is
 *      documentation-only.
 *
 * Optional: SAM_DB_MODULE=<path> tests another copy of the module (the
 * shipped file is the default and is never modified by this script).
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v4db');
const V3DATA = path.join(ROOT, '.tmp', 'v4db-v3');
const MODULE_PATH = process.env.SAM_DB_MODULE
  ? path.resolve(ROOT, process.env.SAM_DB_MODULE)
  : path.join(ROOT, 'src', 'main', 'db.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  if (ok) pass++; else { fail++; failures.push({ name, detail }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rmRetry(t) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(t, { recursive: true, force: true }); if (!fs.existsSync(t)) return; } catch (e) { await sleep(100 * 2 ** i); }
  }
}
function throws(fn) {
  try { fn(); return null; } catch (e) { return e; }
}
const errMsg = (e) => (e && e.message ? e.message : String(e));

/* --- raw sqlite access (the app connection is not exported) --- */
function rawConnect(file) {
  const Database = require('better-sqlite3');
  return new Database(file);
}
function rawAll(file, sql, params = []) {
  const c = rawConnect(file);
  try { return c.prepare(sql).all(...params); } finally { c.close(); }
}
function rawGet(file, sql, params = []) {
  const c = rawConnect(file);
  try { return c.prepare(sql).get(...params); } finally { c.close(); }
}
function rawExec(file, sql) {
  const c = rawConnect(file);
  try { c.exec(sql); } finally { c.close(); }
}

/** every balance in the ledger: item x warehouse x bucket */
function snapshot(file) {
  return rawAll(file, `SELECT item_id, warehouse_id, bucket, SUM(piece_delta) AS pieces
                       FROM stock_moves GROUP BY item_id, warehouse_id, bucket
                       ORDER BY item_id, warehouse_id, bucket`);
}
function snapGet(snap, itemId, whId, bucket) {
  const r = snap.find((x) => x.item_id === itemId && x.warehouse_id === whId && x.bucket === bucket);
  return r ? r.pieces : 0;
}
const snapJson = (snap) => JSON.stringify(snap);

/* --- a database that looks exactly like V3 --- */
const V3_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main','sub')),
  location TEXT, is_active INTEGER NOT NULL DEFAULT 1, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  base_unit TEXT NOT NULL DEFAULT 'حبة', category TEXT,
  pieces_per_carton INTEGER NOT NULL DEFAULT 0, pieces_per_bag INTEGER NOT NULL DEFAULT 0,
  min_good_alert INTEGER NOT NULL DEFAULT 0, max_defect_alert INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
  type TEXT NOT NULL DEFAULT 'customer' CHECK (type IN ('customer','supplier','both')),
  notes TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (bucket IN ('good','defect','held')),
  piece_delta INTEGER NOT NULL, carton_qty INTEGER NOT NULL DEFAULT 0, bag_qty INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT NOT NULL DEFAULT 'opening', doc_id INTEGER, doc_no TEXT,
  party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT,
  is_customer INTEGER NOT NULL DEFAULT 0, note TEXT,
  move_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','sale_return','purchase_return','transfer')),
  doc_no TEXT NOT NULL, doc_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  dest_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  invoice_value TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE doc_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id),
  dest_warehouse_id INTEGER REFERENCES warehouses(id),
  bucket TEXT NOT NULL DEFAULT 'good' CHECK (bucket IN ('good','defect','held')),
  pieces INTEGER NOT NULL DEFAULT 0, cartons INTEGER NOT NULL DEFAULT 0, bags INTEGER NOT NULL DEFAULT 0, note TEXT
);
CREATE TABLE scrap_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'tolling' CHECK (source IN ('tolling','production','internal')),
  is_customer INTEGER NOT NULL DEFAULT 0,
  party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  pieces INTEGER NOT NULL DEFAULT 0,
  bucket TEXT NOT NULL DEFAULT 'defect' CHECK (bucket IN ('good','defect','held')),
  doc_type TEXT, doc_id INTEGER, doc_no TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

const V3_ROWS = `
INSERT INTO meta(key,value) VALUES('schema_version','1');
INSERT INTO warehouses(id,code,name,kind,location,is_active,note,created_at) VALUES
  (1,'W01','المخزن الرئيسي','main','',1,'قديم','2026-01-01 08:00:00'),
  (2,'W02','مخزن ب','sub','ب',1,NULL,'2026-01-01 08:00:00');
INSERT INTO items(id,code,name,base_unit,category,pieces_per_carton,pieces_per_bag,min_good_alert,max_defect_alert,is_active,created_at,updated_at) VALUES
  (1,'IT1','صنف أول','حبة',NULL,12,0,0,0,1,'2026-01-01 08:00:00','2026-01-01 08:00:00'),
  (2,'IT2','صنف ثاني','حبة',NULL,0,0,0,0,1,'2026-01-01 08:00:00','2026-01-01 08:00:00');
INSERT INTO parties(id,name,phone,type,notes,is_active,created_at,updated_at) VALUES
  (1,'عميل قديم',NULL,'customer',NULL,1,'2026-01-01 08:00:00','2026-01-01 08:00:00');
INSERT INTO documents(id,kind,doc_no,doc_date,party_id,warehouse_id,dest_warehouse_id,invoice_value,notes,created_at) VALUES
  (1,'purchase','PUR-0001','2026-01-10',1,1,NULL,NULL,NULL,'2026-01-10 09:00:00'),
  (5,'sale','SAL-0001','2026-01-11',1,1,NULL,'100','ملاحظة قديمة','2026-01-11 09:00:00');
INSERT INTO doc_lines(id,document_id,item_id,warehouse_id,dest_warehouse_id,bucket,pieces,cartons,bags,note) VALUES
  (1,1,1,1,NULL,'good',100,0,0,NULL),
  (2,5,1,1,NULL,'held',30,0,0,NULL);
INSERT INTO stock_moves(id,item_id,warehouse_id,bucket,piece_delta,carton_qty,bag_qty,doc_type,doc_id,doc_no,party_id,is_customer,note,move_date,created_at) VALUES
  (1,1,1,'good',100,0,0,'opening',NULL,'افتتاحي',NULL,0,NULL,'2026-01-01','2026-01-01 08:00:00'),
  (2,1,2,'good',50,0,0,'opening',NULL,'افتتاحي',NULL,0,NULL,'2026-01-01','2026-01-01 08:00:00'),
  (3,1,1,'good',100,0,0,'purchase',1,'PUR-0001',1,0,NULL,'2026-01-10','2026-01-10 09:00:00'),
  (4,1,1,'held',-30,0,0,'sale',5,'SAL-0001',1,0,NULL,'2026-01-11','2026-01-11 09:00:00'),
  (5,2,1,'defect',5,0,0,'internal',NULL,NULL,NULL,0,NULL,'2026-01-12','2026-01-12 09:00:00');
INSERT INTO scrap_movements(id,source,is_customer,party_id,item_id,warehouse_id,pieces,bucket,doc_type,doc_id,doc_no,note,created_at) VALUES
  (1,'tolling',1,1,1,1,7,'held','tolling_order',1,'TOL-0001',NULL,'2026-01-12 09:00:00');
`;

app.whenReady().then(async () => {
  console.log('module under test: ' + path.relative(ROOT, MODULE_PATH));
  let db = null;
  try {
    db = require(MODULE_PATH);
  } catch (e) {
    check('module loads', false, errMsg(e));
    console.log(`\n${pass}/${pass + fail} DB checks passed`);
    app.exit(1);
    return;
  }

  /* ================================================================== *
   * phase 1 — a fresh V4 database
   * ================================================================== */
  db.close(); await rmRetry(DATA); fs.mkdirSync(DATA, { recursive: true });
  const initRes = db.init(DATA);
  const file = initRes && initRes.path;
  check('init() opens a fresh database', !!file && fs.existsSync(file), file);

  const A = db.addWarehouse({ code: 'WA', name: 'مخزن أ', location: 'أ' });
  const B = db.addWarehouse({ code: 'WB', name: 'مخزن ب', location: 'ب' });
  check('two warehouses exist', !!A.id && !!B.id && db.listWarehouses().length === 3, db.listWarehouses().map((w) => w.code));

  const IT = db.addItem({ code: 'IT1', name: 'صنف رئيسي', base_unit: 'حبة', pieces_per_carton: 12 },
    [{ warehouseId: A.id, good: 100 }, { warehouseId: B.id, good: 50 }]);
  const KIT = db.addItem({ code: 'ITK', name: 'صنف الأنواع', base_unit: 'حبة' }, [{ warehouseId: A.id, good: 1000 }]);
  const FG = db.addItem({ code: 'ITF', name: 'صنف تام', base_unit: 'حبة' }, [{ warehouseId: A.id, good: 50 }]);
  const RAW = db.addItem({ code: 'ITR', name: 'مادة خام', base_unit: 'حبة' }, []);
  const party = db.addParty({ name: 'مورد اختبار', type: 'supplier' });
  check('opening balances are in the ledger',
    db.availableInLocation(IT.id, A.id, 'good') === 100 && db.availableInLocation(IT.id, B.id, 'good') === 50,
    { A: db.availableInLocation(IT.id, A.id, 'good'), B: db.availableInLocation(IT.id, B.id, 'good') });

  /* ---- (a) the nine document kinds ---- */
  const KINDS = ['purchase', 'sale', 'sale_return', 'purchase_return', 'transfer',
    'prod_receipt', 'gate_in', 'gate_out', 'adjustment'];
  check('DOC_KINDS exposes 9 kinds', Object.keys(db.DOC_KINDS || {}).length === 9, Object.keys(db.DOC_KINDS || {}));
  const docSql = rawGet(file, "SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").sql;
  check('documents CHECK allows the 4 new kinds',
    ['prod_receipt', 'gate_in', 'gate_out', 'adjustment'].every((k) => docSql.includes(`'${k}'`)), null);

  const saved = {};
  for (const kind of KINDS) {
    const lines = kind === 'transfer'
      ? [{ item_id: KIT.id, bucket: 'good', pieces: 5 }]
      : [{ item_id: KIT.id, bucket: 'good', pieces: 5, warehouse_id: A.id, ...(kind === 'adjustment' ? { sign: 1 } : {}) }];
    const payload = { kind, doc_date: '2026-03-05', party_id: party.id, warehouse_id: A.id, dest_warehouse_id: B.id, lines };
    if (kind === 'adjustment') delete payload.warehouse_id; // per-line warehouse only
    const e = throws(() => { saved[kind] = db.saveDocument(payload); });
    check('saveDocument accepts kind ' + kind,
      !e && !!saved[kind] && saved[kind].kind === kind,
      e ? errMsg(e) : { id: saved[kind].id, doc_no: saved[kind].doc_no });
  }
  check('every kind is listed back by listDocuments',
    KINDS.every((k) => db.listDocuments({ kind: k }).length === 1),
    KINDS.map((k) => k + ':' + db.listDocuments({ kind: k }).length));
  // the document number must be decided ONCE: the ledger row and the
  // document row must carry the same number (a second nextDocNo() call after
  // the INSERT would hand the ledger a different number)
  const noMismatch = [];
  for (const kind of KINDS) {
    const doc = saved[kind];
    const moves = rawAll(file, 'SELECT DISTINCT doc_no FROM stock_moves WHERE doc_id=? AND doc_type=?', [doc.id, kind]);
    if (moves.length !== 1 || moves[0].doc_no !== doc.doc_no) {
      noMismatch.push({ kind, document: doc.doc_no, ledger: moves.map((m) => m.doc_no) });
    }
  }
  check('the document number is decided ONCE (document row == ledger row)', noMismatch.length === 0, noMismatch);

  /* ---- (a) directions ---- */
  const kitA0 = db.availableInLocation(KIT.id, A.id, 'good');
  const pr = db.saveDocument({ kind: 'prod_receipt', doc_date: '2026-03-05', lines: [{ item_id: KIT.id, bucket: 'good', pieces: 10, warehouse_id: A.id }] });
  const kitA1 = db.availableInLocation(KIT.id, A.id, 'good');
  check('prod_receipt INCREASES the stock', kitA1 === kitA0 + 10, { before: kitA0, after: kitA1 });

  const go = db.saveDocument({ kind: 'gate_out', doc_date: '2026-03-05', lines: [{ item_id: KIT.id, bucket: 'good', pieces: 4, warehouse_id: A.id }] });
  const kitA2 = db.availableInLocation(KIT.id, A.id, 'good');
  check('gate_out DECREASES the stock', kitA2 === kitA1 - 4, { before: kitA1, after: kitA2 });

  const gi = db.saveDocument({ kind: 'gate_in', doc_date: '2026-03-05', lines: [{ item_id: KIT.id, bucket: 'good', pieces: 6, warehouse_id: A.id }] });
  const kitA3 = db.availableInLocation(KIT.id, A.id, 'good');
  check('gate_in INCREASES the stock', kitA3 === kitA2 + 6, { before: kitA2, after: kitA3 });

  const adjDown = db.saveDocument({ kind: 'adjustment', doc_date: '2026-03-05', lines: [{ item_id: KIT.id, bucket: 'good', pieces: 3, sign: -1, warehouse_id: A.id }] });
  const kitA4 = db.availableInLocation(KIT.id, A.id, 'good');
  check('adjustment sign=-1 DECREASES the stock', kitA4 === kitA3 - 3, { before: kitA3, after: kitA4 });

  const adjUp = db.saveDocument({ kind: 'adjustment', doc_date: '2026-03-05', lines: [{ item_id: KIT.id, bucket: 'good', pieces: 9, sign: 1, warehouse_id: A.id }] });
  const kitA5 = db.availableInLocation(KIT.id, A.id, 'good');
  check('adjustment sign=+1 INCREASES the stock', kitA5 === kitA4 + 9, { before: kitA4, after: kitA5 });
  check('adjustment ledger rows carry the sign',
    rawGet(file, 'SELECT piece_delta FROM stock_moves WHERE doc_id=? AND doc_type=? ORDER BY id', [adjUp.id, 'adjustment']).piece_delta === 9,
    rawAll(file, 'SELECT piece_delta FROM stock_moves WHERE doc_id=? AND doc_type=? ORDER BY id', [adjUp.id, 'adjustment']));

  /* ---- (b) per-line warehouse is mandatory ---- */
  for (const kind of ['prod_receipt', 'gate_in', 'gate_out', 'adjustment']) {
    const before = rawGet(file, 'SELECT COUNT(*) AS c FROM documents').c;
    const e = throws(() => db.saveDocument({
      kind, doc_date: '2026-03-05', party_id: party.id, warehouse_id: A.id,
      lines: [{ item_id: KIT.id, bucket: 'good', pieces: 3, ...(kind === 'adjustment' ? { sign: 1 } : {}) }]
    }));
    const after = rawGet(file, 'SELECT COUNT(*) AS c FROM documents').c;
    check(kind + ' REJECTS a line without its own warehouse_id',
      !!e && before === after && /مخزن/.test(errMsg(e)),
      e ? { message: errMsg(e), docsBefore: before, docsAfter: after } : 'NO ERROR THROWN (silent header fallback)');
  }

  /* ---- (c) adjustment sign validation ---- */
  for (const sign of [0, 2, -2, undefined]) {
    const before = rawGet(file, 'SELECT COUNT(*) AS c FROM documents').c;
    const e = throws(() => db.saveDocument({
      kind: 'adjustment', doc_date: '2026-03-05',
      lines: [{ item_id: KIT.id, bucket: 'good', pieces: 3, sign, warehouse_id: A.id }]
    }));
    const after = rawGet(file, 'SELECT COUNT(*) AS c FROM documents').c;
    check('adjustment REJECTS sign=' + String(sign), !!e && before === after, e ? errMsg(e) : 'NO ERROR THROWN');
  }

  /* ---- (d) documentImpact for an adjustment ---- */
  const adj = db.saveDocument({
    kind: 'adjustment', doc_date: '2026-03-06',
    lines: [
      { item_id: IT.id, bucket: 'good', pieces: 5, sign: -1, warehouse_id: A.id },
      { item_id: KIT.id, bucket: 'good', pieces: 8, sign: 1, warehouse_id: B.id }
    ]
  });
  const imp = db.documentImpact(adj.id);
  check('documentImpact returns one line per ledger row', !!imp && imp.lines.length === 2, imp && imp.lines);
  const shortLine = (imp.lines || []).find((l) => l.qty === '5 سليم');
  const surplusLine = (imp.lines || []).find((l) => l.qty === '8 سليم');
  check('adjustment shortage line is described as the reversal of the deduction',
    !!shortLine && shortLine.dir === 'إضافة (عكس الخصم)', shortLine);
  check('adjustment surplus line is described as the reversal of the addition',
    !!surplusLine && surplusLine.dir === 'خصم (عكس الزيادة)', surplusLine);
  check('documentImpact totals the document pieces', !!imp && imp.totalPieces === 13, imp && imp.totalPieces);
  check('documentImpact reads the ledger (direction per ledger row)',
    rawAll(file, 'SELECT piece_delta FROM stock_moves WHERE doc_id=? AND doc_type=? ORDER BY id', [adj.id, 'adjustment'])
      .map((r) => r.piece_delta).join(',') === '-5,8',
    rawAll(file, 'SELECT piece_delta FROM stock_moves WHERE doc_id=? AND doc_type=? ORDER BY id', [adj.id, 'adjustment']));

  /* ---- (e) hard delete + edit ---- */
  const snap0 = snapshot(file);
  const base = snapGet(snap0, IT.id, A.id, 'good');
  const delDoc = db.saveDocument({ kind: 'gate_in', doc_date: '2026-03-07', lines: [{ item_id: IT.id, bucket: 'good', pieces: 10, warehouse_id: A.id }] });
  check('the saved document moved the balance',
    db.availableInLocation(IT.id, A.id, 'good') === base + 10,
    { base, now: db.availableInLocation(IT.id, A.id, 'good') });
  db.deleteDocument(delDoc.id);
  check('hard delete reverts EVERY balance exactly', snapJson(snapshot(file)) === snapJson(snap0),
    { before: snap0, after: snapshot(file) });

  const editDoc = db.saveDocument({ kind: 'gate_in', doc_date: '2026-03-07', lines: [{ item_id: IT.id, bucket: 'good', pieces: 10, warehouse_id: A.id }] });
  db.saveDocument({
    id: editDoc.id, kind: 'gate_in', doc_date: '2026-03-07',
    lines: [{ item_id: IT.id, bucket: 'good', pieces: 25, warehouse_id: A.id }]
  });
  const edited = db.availableInLocation(IT.id, A.id, 'good');
  check('edit REPLACES the quantity (does not add to it)', edited === base + 25, { expected: base + 25, actual: edited });
  check('edit leaves exactly one ledger row for the document',
    rawGet(file, 'SELECT COUNT(*) AS c FROM stock_moves WHERE doc_id=? AND doc_type=?', [editDoc.id, 'gate_in']).c === 1,
    rawGet(file, 'SELECT COUNT(*) AS c FROM stock_moves WHERE doc_id=? AND doc_type=?', [editDoc.id, 'gate_in']).c);
  check('edit leaves exactly one document line',
    rawGet(file, 'SELECT COUNT(*) AS c FROM doc_lines WHERE document_id=?', [editDoc.id]).c === 1,
    rawGet(file, 'SELECT COUNT(*) AS c FROM doc_lines WHERE document_id=?', [editDoc.id]).c);
  db.deleteDocument(editDoc.id);
  check('delete after edit reverts every balance exactly', snapJson(snapshot(file)) === snapJson(snap0));

  /* ---- (g) the report centre ---- */
  const REPORTS = db.REPORTS;
  check('REPORTS catalogue is published', Array.isArray(REPORTS) && REPORTS.length === 9,
    Array.isArray(REPORTS) ? REPORTS.map((r) => r.key) : REPORTS);
  for (const rep of REPORTS || []) {
    const filters = { report: rep.key };
    if (rep.key === 'item_ledger') filters.itemId = IT.id; // this report needs an item
    let res = null, err = null;
    try { res = db.runReport(filters); } catch (e) { err = e; }
    const shapeOk = !!res && res.report === rep.key && typeof res.title === 'string' && res.title.length > 0
      && Array.isArray(res.columns) && res.columns.length > 0 && Array.isArray(res.rows)
      && !!res.totals && typeof res.totals === 'object';
    check('runReport(' + rep.key + ') returns {report,title,columns,rows,totals}', !err && shapeOk,
      err ? errMsg(err) : { report: res.report, title: res.title, columns: res.columns.length, rows: res.rows.length, totals: Object.keys(res.totals) });
    if (res && res.rows.length) {
      const missing = res.columns.map((c) => c.key).filter((k) => !(k in res.rows[0]));
      check('runReport(' + rep.key + ') rows carry every column key', missing.length === 0, missing);
    }
  }
  db.saveDocument({ kind: 'gate_in', doc_date: '2026-05-10', lines: [{ item_id: IT.id, bucket: 'good', pieces: 7, warehouse_id: B.id }] });
  const allMoves = db.runReport({ report: 'movements' });
  const rangedMoves = db.runReport({ report: 'movements', dateFrom: '2026-05-01', dateTo: '2026-05-31' });
  check('runReport filters by date range',
    rangedMoves.rows.length > 0 && rangedMoves.rows.length < allMoves.rows.length
    && rangedMoves.rows.every((r) => r.moveDate >= '2026-05-01' && r.moveDate <= '2026-05-31'),
    { all: allMoves.rows.length, ranged: rangedMoves.rows.length });
  const whRows = db.runReport({ report: 'stock_status', warehouseId: B.id });
  const whRowsAll = db.runReport({ report: 'stock_status' });
  check('runReport filters by warehouse',
    whRows.rows.length > 0 && whRows.rows.every((r) => r.warehouseId === B.id)
    && whRowsAll.rows.some((r) => r.warehouseId === A.id) && whRowsAll.rows.some((r) => r.warehouseId === B.id),
    { filtered: whRows.rows.length, unfiltered: whRowsAll.rows.length });

  /* ---- (h) the daily production report is documentation only ---- */
  const fgBefore = db.availableInLocation(FG.id, A.id, 'good');
  const receipt = db.saveReceipt({
    raw_item_id: RAW.id, doc_no: 'PRD-0001', doc_date: '2026-03-08', carton_no: 'CT-001', carton_pieces: 100,
    lines: [{ item_id: FG.id, good: 95, defect_cans: 2, defect_ampoules: 1 }]
  });
  const receiptMoves = rawGet(file, "SELECT COUNT(*) AS c FROM stock_moves WHERE doc_id=? AND doc_type IN ('receipt','bags')", [receipt.id]).c;
  check('saveReceipt writes NO stock movement', receiptMoves === 0, receiptMoves);
  check('saveReceipt does not change any balance', db.availableInLocation(FG.id, A.id, 'good') === fgBefore,
    { before: fgBefore, after: db.availableInLocation(FG.id, A.id, 'good') });
  const rImp = db.receiptImpact(receipt.id);
  check('receiptImpact reports documentationOnly === true',
    !!rImp && rImp.documentationOnly === true && rImp.legacyMoves === 0 && Array.isArray(rImp.lines) && rImp.lines.length === 0,
    rImp && { documentationOnly: rImp.documentationOnly, legacyMoves: rImp.legacyMoves, lines: rImp.lines.length });

  /* ================================================================== *
   * phase 2 — the migration from a V3-shaped database
   * ================================================================== */
  db.close();
  await rmRetry(V3DATA); fs.mkdirSync(V3DATA, { recursive: true });
  const v3file = path.join(V3DATA, 'sam.db');
  rawExec(v3file, V3_SCHEMA + V3_ROWS);
  const v3Docs = rawAll(v3file, 'SELECT * FROM documents ORDER BY id');
  const v3Moves = rawGet(v3file, 'SELECT COUNT(*) AS c, COALESCE(SUM(piece_delta),0) AS s FROM stock_moves');
  const v3Lines = rawGet(v3file, 'SELECT COUNT(*) AS c FROM doc_lines');
  const v3Held = rawGet(v3file, "SELECT COUNT(*) AS c FROM stock_moves WHERE bucket='held'").c;
  check('fixture looks like V3 (old CHECK, held buckets)',
    v3Docs.length === 2 && v3Moves.c === 5 && v3Held === 1 && v3Lines.c === 2,
    { docs: v3Docs.length, moves: v3Moves.c, held: v3Held, lines: v3Lines.c });

  db.init(V3DATA);
  const mfile = db.dbFile();

  const fk = rawAll(mfile, 'PRAGMA foreign_key_check');
  check('PRAGMA foreign_key_check is empty after the migration', Array.isArray(fk) && fk.length === 0, fk);
  const integ = rawGet(mfile, 'PRAGMA integrity_check');
  check("PRAGMA integrity_check === 'ok'", integ && integ.integrity_check === 'ok', integ);

  const mDocs = rawAll(mfile, 'SELECT id,kind,doc_no,doc_date,party_id,warehouse_id,dest_warehouse_id,invoice_value,notes,created_at FROM documents ORDER BY id');
  check('every pre-existing documents row survived WITH THE SAME id',
    mDocs.length === v3Docs.length && mDocs.every((d, i) => d.id === v3Docs[i].id && d.kind === v3Docs[i].kind && d.doc_no === v3Docs[i].doc_no
      && d.doc_date === v3Docs[i].doc_date && d.party_id === v3Docs[i].party_id && d.warehouse_id === v3Docs[i].warehouse_id
      && d.created_at === v3Docs[i].created_at),
    { before: v3Docs.map((d) => ({ id: d.id, kind: d.kind, doc_no: d.doc_no })), after: mDocs.map((d) => ({ id: d.id, kind: d.kind, doc_no: d.doc_no })) });
  const mDocSql = rawGet(mfile, "SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").sql;
  check('the documents CHECK was widened in place',
    ['prod_receipt', 'gate_in', 'gate_out', 'adjustment'].every((k) => mDocSql.includes(`'${k}'`)), null);
  const seqRows = rawAll(mfile, 'SELECT name, seq FROM sqlite_sequence ORDER BY name');
  check('the rebuild leaves no stale sqlite_sequence entry',
    !seqRows.some((r) => r.name === 'documents_v4')
    && seqRows.some((r) => r.name === 'documents' && r.seq >= 5), seqRows);

  const mMoves = rawGet(mfile, 'SELECT COUNT(*) AS c, COALESCE(SUM(piece_delta),0) AS s FROM stock_moves');
  const mHeld = rawGet(mfile, "SELECT COUNT(*) AS c FROM stock_moves WHERE bucket='held'").c;
  check('no stock_moves row was LOST by the migration', mMoves.c === v3Moves.c, { before: v3Moves.c, after: mMoves.c });
  check('total piece sum is unchanged by the migration', mMoves.s === v3Moves.s, { before: v3Moves.s, after: mMoves.s });
  check('the held rows became good', mHeld === 0 && rawGet(mfile, "SELECT COUNT(*) AS c FROM stock_moves WHERE bucket='good'").c === 4,
    { heldLeft: mHeld, good: rawGet(mfile, "SELECT COUNT(*) AS c FROM stock_moves WHERE bucket='good'").c });
  check('the held doc_lines became good',
    rawGet(mfile, "SELECT COUNT(*) AS c FROM doc_lines WHERE bucket='held'").c === 0
    && rawGet(mfile, "SELECT COUNT(*) AS c FROM doc_lines WHERE bucket='good'").c === v3Lines.c,
    { held: rawGet(mfile, "SELECT COUNT(*) AS c FROM doc_lines WHERE bucket='held'").c, good: rawGet(mfile, "SELECT COUNT(*) AS c FROM doc_lines WHERE bucket='good'").c });
  check('the held scrap_movements became good',
    rawGet(mfile, "SELECT COUNT(*) AS c FROM scrap_movements WHERE bucket='held'").c === 0
    && rawGet(mfile, "SELECT COUNT(*) AS c FROM scrap_movements WHERE bucket='good'").c === 1, null);
  check('doc_lines gained the additive sign column (default 1)',
    rawAll(mfile, 'PRAGMA table_info(doc_lines)').some((c) => c.name === 'sign' && c.notnull === 1)
    && rawAll(mfile, 'SELECT sign FROM doc_lines ORDER BY id').every((r) => r.sign === 1),
    rawAll(mfile, 'SELECT sign FROM doc_lines ORDER BY id'));
  check('the migration is flagged exactly once',
    !!rawGet(mfile, "SELECT value FROM meta WHERE key='held_merged_v4'"),
    rawGet(mfile, "SELECT value FROM meta WHERE key='held_merged_v4'"));
  check('the legacy main warehouse is normalized',
    rawGet(mfile, "SELECT COUNT(*) AS c FROM warehouses WHERE kind<>'sub'").c === 0
    && rawGet(mfile, "SELECT name FROM warehouses WHERE id=1").name === 'المخزن 1',
    rawAll(mfile, 'SELECT id,code,name,kind FROM warehouses ORDER BY id'));

  const migratedDoc = db.saveDocument({
    kind: 'adjustment', doc_date: '2026-06-01',
    lines: [{ item_id: 1, bucket: 'good', pieces: 2, sign: 1, warehouse_id: 1 }]
  });
  check('the migrated database accepts the new kinds', !!migratedDoc && migratedDoc.kind === 'adjustment',
    migratedDoc && { id: migratedDoc.id, kind: migratedDoc.kind });
  check('the new document id does not collide with the migrated ids',
    !!migratedDoc && migratedDoc.id > Math.max(...v3Docs.map((d) => d.id)),
    { newId: migratedDoc && migratedDoc.id, oldMax: Math.max(...v3Docs.map((d) => d.id)) });

  db.close(); await rmRetry(DATA); await rmRetry(V3DATA);

  console.log(`\n${pass}/${pass + fail} DB checks passed`);
  if (failures.length) {
    console.log('FAILED CHECKS:');
    failures.forEach((f) => console.log('  - ' + f.name + ' :: ' + JSON.stringify(f.detail)));
  }
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
