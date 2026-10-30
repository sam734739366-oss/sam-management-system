'use strict';

/**
 * src/main/db.js — SQLite layer (better-sqlite3).
 *
 * Design rules that every later phase depends on:
 *  - The PIECE (الحبة) is the unit of truth. Cartons/bags are informational.
 *  - stock_moves is the single ledger; on-hand balances are derived from it,
 *    never stored twice.
 *  - Documents are HARD-DELETED: removing a move (or a document) simply
 *    removes rows, and the derived balance reverts immediately.
 */

const path = require('path');
const fs = require('fs');

const BUCKETS = ['good', 'defect', 'held'];
const AR_BUCKET = { good: 'سليم', defect: 'تالف', held: 'محجوز' };

let db = null;
let dbPath = null;

/* ------------------------------------------------------------------ *
 * schema
 * ------------------------------------------------------------------ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main','sub')),
  location TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_unit TEXT NOT NULL DEFAULT 'حبة',
  category TEXT,
  pieces_per_carton INTEGER NOT NULL DEFAULT 0,
  pieces_per_bag INTEGER NOT NULL DEFAULT 0,
  min_good_alert INTEGER NOT NULL DEFAULT 0,
  max_defect_alert INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  type TEXT NOT NULL DEFAULT 'customer' CHECK (type IN ('customer','supplier','both')),
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (bucket IN ('good','defect','held')),
  piece_delta INTEGER NOT NULL,
  carton_qty INTEGER NOT NULL DEFAULT 0,
  bag_qty INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT NOT NULL DEFAULT 'opening',
  doc_id INTEGER,
  doc_no TEXT,
  party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','sale_return','purchase_return','transfer')),
  doc_no TEXT NOT NULL,
  doc_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  dest_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  invoice_value TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS doc_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id),
  dest_warehouse_id INTEGER REFERENCES warehouses(id),
  bucket TEXT NOT NULL DEFAULT 'good' CHECK (bucket IN ('good','defect','held')),
  pieces INTEGER NOT NULL DEFAULT 0,
  cartons INTEGER NOT NULL DEFAULT 0,
  bags INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  is_active INTEGER NOT NULL DEFAULT 1,
  screens TEXT,
  perms TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prod_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  cartons INTEGER NOT NULL DEFAULT 0,
  pieces INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS prod_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  issue_id INTEGER REFERENCES prod_issues(id) ON DELETE SET NULL,
  raw_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  carton_no TEXT,
  carton_pieces INTEGER NOT NULL DEFAULT 0,
  bags_used INTEGER NOT NULL DEFAULT 0,
  produced_total INTEGER NOT NULL DEFAULT 0,
  shortage INTEGER NOT NULL DEFAULT 0,
  surplus INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS prod_receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES prod_receipts(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  good INTEGER NOT NULL DEFAULT 0,
  defect_cans INTEGER NOT NULL DEFAULT 0,
  defect_ampoules INTEGER NOT NULL DEFAULT 0,
  bags_used INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_moves(item_id, warehouse_id, bucket);
CREATE INDEX IF NOT EXISTS idx_moves_doc ON stock_moves(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_moves_created ON stock_moves(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parties_name ON parties(name);
`;

/** add columns that later phases rely on, for databases created earlier */
function migrate() {
  const cols = db.prepare('PRAGMA table_info(stock_moves)').all().map((c) => c.name);
  if (!cols.includes('party_id')) db.exec('ALTER TABLE stock_moves ADD COLUMN party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT');
  const whCols = db.prepare('PRAGMA table_info(warehouses)').all().map((c) => c.name);
  if (!whCols.includes('location')) db.exec('ALTER TABLE warehouses ADD COLUMN location TEXT');
}

/**
 * Distinct values already stored, used to power the <datalist> suggestions
 * on free-text master-data fields. Column names come from a fixed allow-list,
 * never from the caller, so nothing here is injectable.
 */
const DISTINCT_FIELDS = {
  base_unit: { table: 'items', column: 'base_unit' },
  category: { table: 'items', column: 'category' },
  wh_location: { table: 'warehouses', column: 'location' },
  wh_note: { table: 'warehouses', column: 'note' },
  party_phone: { table: 'parties', column: 'phone' }
};

function distinctValues(field) {
  const spec = DISTINCT_FIELDS[field];
  if (!spec) throw new Error('حقل غير معروف لل اقتراحات');
  const rows = db.prepare(
    `SELECT DISTINCT ${spec.column} AS v FROM ${spec.table}
     WHERE ${spec.column} IS NOT NULL AND TRIM(${spec.column}) <> '' ORDER BY v`
  ).all();
  return rows.map((r) => r.v);
}

function init(userDataDir) {
  const Database = require('better-sqlite3');
  fs.mkdirSync(userDataDir, { recursive: true });
  dbPath = path.join(userDataDir, 'sam.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();

  const version = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0);
  if (version < 1) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  }
  seedDefaults();
  return { path: dbPath };
}

/** first run: a main warehouse so the opening-balance flow always works */
function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM warehouses').get().c;
  if (count === 0) {
    db.prepare("INSERT INTO warehouses(code,name,kind,note) VALUES('M01','المخزن الرئيسي','main','أُنشئ تلقائياً عند أول تشغيل')").run();
  }
}

/**
 * Release the file handle. Windows keeps a locked .db (and its -wal / -shm
 * siblings) until every connection is closed, so anything that wants to
 * delete or replace the data directory must call this first.
 */
function close() {
  if (!db) return false;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) { /* journal may already be gone */ }
  try {
    db.close();
  } catch (e) {
    console.warn('db close:', e.message);
    return false;
  }
  db = null;
  return true;
}

/**
 * Online backup via the SQLite backup API — safe to call while the app is
 * running, no need to close the connection first.
 */
async function backupTo(filePath) {
  if (!db) throw new Error('قاعدة البيانات غير مفتوحة');
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  await db.backup(filePath);
  return { path: filePath, size: fs.statSync(filePath).size };
}

function dataDir() {
  return dbPath ? path.dirname(dbPath) : null;
}

function dbFile() {
  return dbPath;
}

/* ------------------------------------------------------------------ *
 * warehouses
 * ------------------------------------------------------------------ */

function listWarehouses() {
  return db.prepare(`
    SELECT w.*,
      (SELECT COUNT(DISTINCT m.item_id) FROM stock_moves m WHERE m.warehouse_id = w.id) AS item_count,
      (SELECT COALESCE(SUM(m.piece_delta),0) FROM stock_moves m WHERE m.warehouse_id = w.id) AS total_pieces
    FROM warehouses w
    ORDER BY (w.kind='main') DESC, w.id
  `).all();
}

function getMainWarehouse() {
  return db.prepare("SELECT * FROM warehouses WHERE kind='main' AND is_active=1 LIMIT 1").get() || null;
}

function addWarehouse(w) {
  validateWarehouse(w);
  if (w.kind === 'main' && getMainWarehouse()) {
    throw new Error('يوجد مخزن رئيسي بالفعل — يجب أن يكون هناك مخزن رئيسي واحد فقط.');
  }
  const info = db
    .prepare('INSERT INTO warehouses(code,name,kind,location,note,is_active) VALUES(?,?,?,?,?,?)')
    .run(w.code.trim(), w.name.trim(), w.kind, str(w.location), w.note || null, w.is_active === false ? 0 : 1);
  return getWarehouse(info.lastInsertRowid);
}

function updateWarehouse(id, w) {
  validateWarehouse(w);
  const current = getWarehouse(id);
  if (!current) throw new Error('المخزن غير موجود');
  if (w.kind === 'main' && current.kind !== 'main') {
    const other = db.prepare("SELECT id FROM warehouses WHERE kind='main' AND id<>?").get(id);
    if (other) throw new Error('لا يمكن تعيين مخزن رئيسي آخر — المخزن الرئيسي موجود بالفعل.');
  }
  db.prepare('UPDATE warehouses SET code=?, name=?, kind=?, location=?, note=?, is_active=? WHERE id=?').run(
    w.code.trim(), w.name.trim(), w.kind, str(w.location), w.note || null, w.is_active === false ? 0 : 1, id
  );
  return getWarehouse(id);
}

function getWarehouse(id) {
  return db.prepare('SELECT * FROM warehouses WHERE id=?').get(id) || null;
}

function warehouseImpact(id) {
  const moves = db.prepare('SELECT COUNT(*) AS c FROM stock_moves WHERE warehouse_id=?').get(id).c;
  const pieces = db.prepare('SELECT COALESCE(SUM(ABS(piece_delta)),0) AS p FROM stock_moves WHERE warehouse_id=?').get(id).p;
  return { moves, pieces };
}

function deleteWarehouse(id) {
  const impact = warehouseImpact(id);
  if (impact.moves > 0) {
    throw new Error(
      `لا يمكن حذف المخزن: لديه ${impact.moves} حركة مخزون بإجمالي ${impact.pieces} حبة. ` +
      'انقل الأرصدة أو احذف المستندات المرتبطة أولاً.'
    );
  }
  db.prepare('DELETE FROM warehouses WHERE id=?').run(id);
  return true;
}

function validateWarehouse(w) {
  if (!w || !String(w.code || '').trim()) throw new Error('كود المخزن مطلوب');
  if (!String(w.name || '').trim()) throw new Error('اسم المخزن مطلوب');
  if (!['main', 'sub'].includes(w.kind)) throw new Error('نوع المخزن غير صالح');
}

/* ------------------------------------------------------------------ *
 * items
 * ------------------------------------------------------------------ */

const STOCK_SQL = `
  SELECT m.warehouse_id AS warehouseId, m.bucket AS bucket,
         COALESCE(SUM(m.piece_delta),0) AS pieces
  FROM stock_moves m
  WHERE m.item_id = ?
  GROUP BY m.warehouse_id, m.bucket
`;

function attachStock(item) {
  const rows = db.prepare(STOCK_SQL).all(item.id);
  const byWh = {};
  for (const r of rows) {
    byWh[r.warehouseId] = byWh[r.warehouseId] || { good: 0, defect: 0, held: 0, total: 0 };
    byWh[r.warehouseId][r.bucket] = r.pieces;
    byWh[r.warehouseId].total += r.pieces;
  }
  const main = getMainWarehouse();
  const mainStock = (main && byWh[main.id]) || { good: 0, defect: 0, held: 0, total: 0 };
  let total = 0;
  Object.values(byWh).forEach((s) => (total += s.total));
  const alerts = [];
  if (main && mainStock.good < item.min_good_alert) alerts.push('low-good');
  if (item.max_defect_alert > 0 && mainStock.defect > item.max_defect_alert) alerts.push('high-defect');
  return {
    ...item,
    stockByWarehouse: byWh,
    mainStock,
    totalPieces: total,
    alertLowGood: alerts.includes('low-good'),
    alertHighDefect: alerts.includes('high-defect')
  };
}

function listItems(search = '') {
  const like = `%${String(search).trim()}%`;
  const rows = db.prepare(
    `SELECT * FROM items
     WHERE (?='' OR code LIKE ? OR name LIKE ? OR IFNULL(category,'') LIKE ?)
     ORDER BY code`
  ).all(String(search).trim(), like, like, like);
  return rows.map(attachStock);
}

function getItem(id) {
  const row = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  return row ? attachStock(row) : null;
}

function itemStock(id) {
  const item = getItem(id);
  if (!item) return null;
  const whs = listWarehouses();
  return whs.map((w) => ({
    warehouseId: w.id,
    code: w.code,
    name: w.name,
    kind: w.kind,
    good: item.stockByWarehouse[w.id]?.good || 0,
    defect: item.stockByWarehouse[w.id]?.defect || 0,
    held: item.stockByWarehouse[w.id]?.held || 0
  }));
}

/**
 * Create an item together with its opening balances.
 * balances = [{ warehouseId, good, defect, held }]
 */
function addItem(item, balances = []) {
  validateItem(item);
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO items(code,name,base_unit,category,pieces_per_carton,pieces_per_bag,min_good_alert,max_defect_alert,is_active)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(
      item.code.trim(), item.name.trim(), item.base_unit?.trim() || 'حبة', item.category?.trim() || null,
      int(item.pieces_per_carton), int(item.pieces_per_bag), int(item.min_good_alert), int(item.max_defect_alert),
      item.is_active === false ? 0 : 1
    );
    const id = info.lastInsertRowid;
    writeOpening(id, balances);
    return id;
  });
  const id = tx();
  return getItem(id);
}

function updateItem(id, item, balances = null) {
  validateItem(item);
  const existing = db.prepare('SELECT id FROM items WHERE id=?').get(id);
  if (!existing) throw new Error('الصنف غير موجود');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE items SET code=?, name=?, base_unit=?, category=?, pieces_per_carton=?, pieces_per_bag=?,
        min_good_alert=?, max_defect_alert=?, is_active=?, updated_at=datetime('now','localtime')
       WHERE id=?`
    ).run(
      item.code.trim(), item.name.trim(), item.base_unit?.trim() || 'حبة', item.category?.trim() || null,
      int(item.pieces_per_carton), int(item.pieces_per_bag), int(item.min_good_alert), int(item.max_defect_alert),
      item.is_active === false ? 0 : 1, id
    );
    if (balances) {
      // opening balances are re-stated as a set: drop the old opening rows, write the new ones
      db.prepare("DELETE FROM stock_moves WHERE item_id=? AND doc_type='opening'").run(id);
      writeOpening(id, balances);
    }
  });
  tx();
  return getItem(id);
}

function writeOpening(itemId, balances) {
  const ins = db.prepare(
    `INSERT INTO stock_moves(item_id,warehouse_id,bucket,piece_delta,carton_qty,bag_qty,doc_type,doc_no,note)
     VALUES(?,?,?,0,0,0,'opening',?,?)`
  );
  const upd = db.prepare('UPDATE stock_moves SET piece_delta=? WHERE id=?');
  for (const b of balances || []) {
    const whId = int(b.warehouseId);
    if (!whId) continue;
    for (const bucket of BUCKETS) {
      const qty = int(b[bucket]);
      if (qty === 0) continue;
      const info = ins.run(itemId, whId, bucket, 'افتتاحي', 'رصيد افتتاحي');
      upd.run(qty, info.lastInsertRowid);
    }
  }
}

/** opening balances only (doc_type='opening'), keyed by warehouse id */
function openingBalances(itemId) {
  const rows = db.prepare(
    `SELECT warehouse_id AS warehouseId, bucket, SUM(piece_delta) AS qty
     FROM stock_moves WHERE item_id=? AND doc_type='opening'
     GROUP BY warehouse_id, bucket`
  ).all(itemId);
  const map = {};
  for (const r of rows) {
    map[r.warehouseId] = map[r.warehouseId] || { good: 0, defect: 0, held: 0 };
    map[r.warehouseId][r.bucket] = r.qty;
  }
  return map;
}

function deleteItemImpact(id) {
  const item = getItem(id);
  if (!item) return null;
  const moves = db.prepare('SELECT COUNT(*) AS c FROM stock_moves WHERE item_id=?').get(id).c;
  const lines = [];
  for (const [whId, s] of Object.entries(item.stockByWarehouse)) {
    const wh = getWarehouse(Number(whId));
    for (const bucket of BUCKETS) {
      if (s[bucket]) {
        lines.push({
          item: `${item.code} - ${item.name}`,
          wh: wh ? `${wh.name}` : '?',
          dir: s[bucket] > 0 ? 'خصم (عكس زيادة)' : 'إضافة (عكس خصم)',
          qty: `${s[bucket]} ${AR_BUCKET[bucket]}`
        });
      }
    }
  }
  return { item, moves, totalPieces: item.totalPieces, lines };
}

function deleteItem(id) {
  const impact = deleteItemImpact(id);
  if (!impact) throw new Error('الصنف غير موجود');
  db.prepare('DELETE FROM items WHERE id=?').run(id); // cascades to stock_moves
  return impact;
}

function validateItem(item) {
  if (!item || !String(item.code || '').trim()) throw new Error('كود الصنف مطلوب');
  if (!String(item.name || '').trim()) throw new Error('اسم الصنف مطلوب');
  for (const k of ['pieces_per_carton', 'pieces_per_bag', 'min_good_alert', 'max_defect_alert']) {
    const v = int(item[k]);
    if (v < 0) throw new Error('القيم الرقمية يجب أن تكون صفر أو أكبر');
  }
}

/* ------------------------------------------------------------------ *
 * parties — العملاء والموردون (جدول مستقل يُستخدم كقائمة منسدلة)
 * ------------------------------------------------------------------ */

const PARTY_TYPES = { customer: 'عميل', supplier: 'مورد', both: 'عميل ومورد' };

function listParties(search = '', type = '') {
  const like = `%${String(search).trim()}%`;
  return db.prepare(
    `SELECT p.*,
            (SELECT COUNT(DISTINCT m.doc_type || '-' || m.doc_id) FROM stock_moves m
              WHERE m.party_id = p.id AND m.doc_type <> 'opening') AS doc_count
     FROM parties p
     WHERE (?='' OR p.name LIKE ? OR IFNULL(p.phone,'') LIKE ? OR IFNULL(p.notes,'') LIKE ?)
       AND (?='' OR p.type = ? OR p.type = 'both')
     ORDER BY p.name`
  ).all(String(search).trim(), like, like, like, type || '', type || '');
}

function getParty(id) {
  return db.prepare('SELECT * FROM parties WHERE id=?').get(id) || null;
}

function addParty(p) {
  validateParty(p);
  const info = db.prepare('INSERT INTO parties(name,phone,type,notes,is_active) VALUES(?,?,?,?,?)')
    .run(p.name.trim(), str(p.phone), p.type, str(p.notes), p.is_active === false ? 0 : 1);
  return getParty(info.lastInsertRowid);
}

function updateParty(id, p) {
  validateParty(p);
  if (!getParty(id)) throw new Error('الطرف غير موجود');
  db.prepare(`UPDATE parties SET name=?, phone=?, type=?, notes=?, is_active=?,
              updated_at=datetime('now','localtime') WHERE id=?`)
    .run(p.name.trim(), str(p.phone), p.type, str(p.notes), p.is_active === false ? 0 : 1, id);
  return getParty(id);
}

function partyImpact(id) {
  const docs = db.prepare("SELECT COUNT(*) AS c FROM stock_moves WHERE party_id=? AND doc_type<>'opening'").get(id).c;
  return { party: getParty(id), docs };
}

function deleteParty(id) {
  const impact = partyImpact(id);
  if (!impact.party) throw new Error('الطرف غير موجود');
  if (impact.docs > 0) {
    throw new Error(
      `لا يمكن حذف «${impact.party.name}»: مرتبط بـ ${impact.docs} مستند. ` +
      'احذف المستندات أولاً (حذف نهائي يعكس المخزون) ثم أعد المحاولة.'
    );
  }
  db.prepare('DELETE FROM parties WHERE id=?').run(id);
  return true;
}

function validateParty(p) {
  if (!p || !String(p.name || '').trim()) throw new Error('اسم العميل / المورد مطلوب');
  if (!PARTY_TYPES[p.type]) throw new Error('اختر نوعاً صحيحاً: عميل أو مورد أو كلاهما');
}

function str(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

/* ------------------------------------------------------------------ *
 * moves
 * ------------------------------------------------------------------ */

function listRecentMoves(limit = 20) {
  return db.prepare(
    `SELECT m.*, i.code AS itemCode, i.name AS itemName, i.base_unit AS baseUnit,
            w.name AS warehouseName, w.kind AS warehouseKind
     FROM stock_moves m
     JOIN items i ON i.id = m.item_id
     JOIN warehouses w ON w.id = m.warehouse_id
     ORDER BY m.id DESC LIMIT ?`
  ).all(limit);
}

function moveDetail(id) {
  return db.prepare(
    `SELECT m.*, i.code AS itemCode, i.name AS itemName, i.base_unit AS baseUnit,
            w.name AS warehouseName
     FROM stock_moves m JOIN items i ON i.id=m.item_id JOIN warehouses w ON w.id=m.warehouse_id
     WHERE m.id=?`
  ).get(id) || null;
}

function deleteMove(id) {
  const m = moveDetail(id);
  if (!m) throw new Error('الحركة غير موجودة');
  db.prepare('DELETE FROM stock_moves WHERE id=?').run(id);
  return m;
}

/* ------------------------------------------------------------------ *
 * documents — المشتريات / المبيعات / المرتجعات / التحويلات
 * Every line writes stock_moves rows, so balances are always derived
 * from the ledger and a hard delete simply removes those rows again.
 * ------------------------------------------------------------------ */

const DOC_KINDS = {
  purchase: { ar: 'مشتريات', sign: 1, prefix: 'PUR' },
  sale: { ar: 'مبيعات', sign: -1, prefix: 'SAL' },
  sale_return: { ar: 'مرتجع مبيعات', sign: 1, prefix: 'SRT' },
  purchase_return: { ar: 'مرتجع مشتريات', sign: -1, prefix: 'PRT' },
  transfer: { ar: 'تحويل مخزن', sign: 0, prefix: 'TRF' }
};

/** every doc_type that can appear in stock_moves, including production rows */
const DOC_LABELS_ALL = {
  ...Object.fromEntries(Object.entries(DOC_KINDS).map(([k, v]) => [k, v.ar])),
  opening: 'رصيد افتتاحي',
  issue: 'صرف إنتاج',
  receipt: 'استلام إنتاج',
  bags: 'أكياس مستخدمة'
};

function nextDocNo(kind) {
  const meta = DOC_KINDS[kind];
  const used = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE kind=?').get(kind).c;
  let n = used + 1;
  const exists = db.prepare('SELECT 1 FROM documents WHERE doc_no=?');
  let candidate = `${meta.prefix}-${String(n).padStart(4, '0')}`;
  while (exists.get(candidate)) {
    n += 1;
    candidate = `${meta.prefix}-${String(n).padStart(4, '0')}`;
  }
  return candidate;
}

/** available pieces of an item in a warehouse/bucket (optionally ignoring one document) */
function availablePieces(itemId, warehouseId, bucket, ignoreDocId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(piece_delta),0) AS p FROM stock_moves
     WHERE item_id=? AND warehouse_id=? AND bucket=? AND (? IS NULL OR NOT (doc_type<>'opening' AND doc_id=?))`
  ).get(itemId, warehouseId, bucket, ignoreDocId || null, ignoreDocId || null);
  return row.p;
}

function validateDocument(payload) {
  const meta = DOC_KINDS[payload.kind];
  if (!meta) throw new Error('نوع المستند غير صالح');
  if (!payload.doc_date) throw new Error('تاريخ المستند مطلوب');
  if (payload.kind === 'transfer') {
    if (!payload.warehouse_id || !payload.dest_warehouse_id) throw new Error('اختر مخزن المصدر ومخزن الوجهة');
    if (Number(payload.warehouse_id) === Number(payload.dest_warehouse_id)) throw new Error('لا يمكن التحويل إلى نفس المخزن');
  } else {
    if (!payload.warehouse_id) throw new Error('اختر المخزن');
    if (payload.kind === 'sale' || payload.kind === 'purchase') {
      if (!payload.party_id) throw new Error('اختر العميل / المورد من القائمة');
    }
  }
  // blank rows are allowed in the grid but never saved
  const raw = payload.lines || [];
  const filled = raw.filter((l) => l.item_id || int(l.pieces) > 0);
  if (!filled.length) throw new Error('أضف سطراً واحداً على الأقل (صنف + كمية)');
  for (const l of filled) {
    const at = raw.indexOf(l) + 1;
    if (!l.item_id) throw new Error(`اختر الصنف في السطر ${at}`);
    if (int(l.pieces) <= 0) throw new Error(`كمية الحبة في السطر ${at} يجب أن تكون أكبر من صفر`);
    if (!BUCKETS.includes(l.bucket || 'good')) throw new Error(`حالة غير صالحة في السطر ${at}`);
  }
  payload.lines = filled;
  return meta;
}

/**
 * Create or update a document.
 * payload = { id?, kind, doc_no, doc_date, party_id, warehouse_id, dest_warehouse_id,
 *             invoice_value, notes, lines:[{ item_id, bucket, pieces, cartons, bags, note }] }
 */
function saveDocument(payload) {
  const meta = validateDocument(payload);
  const id = int(payload.id) || null;

  const tx = db.transaction(() => {
    if (id) {
      // drop the old ledger rows first so availability checks see the pre-edit state
      db.prepare("DELETE FROM stock_moves WHERE doc_id=? AND doc_type<>'opening'").run(id);
      db.prepare('DELETE FROM doc_lines WHERE document_id=?').run(id);
    }

    let docId = id;
    if (docId) {
      db.prepare(
        `UPDATE documents SET kind=?, doc_no=?, doc_date=?, party_id=?, warehouse_id=?, dest_warehouse_id=?,
         invoice_value=?, notes=? WHERE id=?`
      ).run(
        payload.kind, (payload.doc_no || '').trim() || nextDocNo(payload.kind), payload.doc_date,
        int(payload.party_id) || null, int(payload.warehouse_id) || null, int(payload.dest_warehouse_id) || null,
        (payload.invoice_value == null ? '' : String(payload.invoice_value)).trim() || null,
        (payload.notes || '').trim() || null, docId
      );
    } else {
      const info = db.prepare(
        `INSERT INTO documents(kind,doc_no,doc_date,party_id,warehouse_id,dest_warehouse_id,invoice_value,notes)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run(
        payload.kind, (payload.doc_no || '').trim() || nextDocNo(payload.kind), payload.doc_date,
        int(payload.party_id) || null, int(payload.warehouse_id) || null, int(payload.dest_warehouse_id) || null,
        (payload.invoice_value == null ? '' : String(payload.invoice_value)).trim() || null,
        (payload.notes || '').trim() || null
      );
      docId = info.lastInsertRowid;
    }

    const insLine = db.prepare(
      `INSERT INTO doc_lines(document_id,item_id,warehouse_id,dest_warehouse_id,bucket,pieces,cartons,bags,note)
       VALUES(?,?,?,?,?,?,?,?,?)`
    );
    const insMove = db.prepare(
      `INSERT INTO stock_moves(item_id,warehouse_id,bucket,piece_delta,carton_qty,bag_qty,doc_type,doc_id,doc_no,party_id,note)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    );
    const docNo = (payload.doc_no || '').trim() || nextDocNo(payload.kind);

    for (const l of payload.lines) {
      const itemId = int(l.item_id);
      const bucket = l.bucket || 'good';
      const pieces = int(l.pieces);
      const cartons = int(l.cartons);
      const bags = int(l.bags);
      const item = db.prepare('SELECT code,name FROM items WHERE id=?').get(itemId);
      if (!item) throw new Error('أحد الأصناف غير موجود');

      if (payload.kind === 'transfer') {
        const src = int(l.warehouse_id || payload.warehouse_id);
        const dst = int(l.dest_warehouse_id || payload.dest_warehouse_id);
        const avail = availablePieces(itemId, src, bucket, docId);
        if (pieces > avail) {
          throw new Error(`رصيد «${item.name}» في المخزن المصدر ${avail} حبة فقط (المطلوب ${pieces})`);
        }
        insLine.run(docId, itemId, src, dst, bucket, pieces, cartons, bags, l.note || null);
        insMove.run(itemId, src, bucket, -pieces, cartons, bags, payload.kind, docId, docNo, null, l.note || 'تحويل صادر');
        insMove.run(itemId, dst, bucket, pieces, cartons, bags, payload.kind, docId, docNo, null, l.note || 'تحويل وارد');
      } else {
        const wh = int(l.warehouse_id || payload.warehouse_id);
        if (meta.sign < 0) {
          const avail = availablePieces(itemId, wh, bucket, docId);
          if (pieces > avail) {
            throw new Error(`رصيد «${item.name}» ${avail} حبة فقط في هذا المخزن والحالة (المطلوب ${pieces})`);
          }
        }
        insLine.run(docId, itemId, wh, null, bucket, pieces, cartons, bags, l.note || null);
        insMove.run(itemId, wh, bucket, meta.sign * pieces, cartons, bags, payload.kind, docId, docNo,
          int(payload.party_id) || null, l.note || null);
      }
    }
    return docId;
  });

  const newId = tx();
  return getDocument(newId);
}

function getDocument(id) {
  const head = db.prepare(
    `SELECT d.*, p.name AS partyName, p.type AS partyType,
            w.name AS warehouseName, w.code AS warehouseCode,
            dw.name AS destWarehouseName
     FROM documents d
     LEFT JOIN parties p ON p.id = d.party_id
     LEFT JOIN warehouses w ON w.id = d.warehouse_id
     LEFT JOIN warehouses dw ON dw.id = d.dest_warehouse_id
     WHERE d.id=?`
  ).get(id);
  if (!head) return null;
  head.kindAr = DOC_KINDS[head.kind] ? DOC_KINDS[head.kind].ar : head.kind;
  const lines = db.prepare(
    `SELECT l.*, i.code AS itemCode, i.name AS itemName, i.base_unit AS baseUnit,
            i.pieces_per_carton AS perCarton, i.pieces_per_bag AS perBag,
            w.name AS warehouseName, dw.name AS destWarehouseName
     FROM doc_lines l
     JOIN items i ON i.id = l.item_id
     LEFT JOIN warehouses w ON w.id = l.warehouse_id
     LEFT JOIN warehouses dw ON dw.id = l.dest_warehouse_id
     WHERE l.document_id=? ORDER BY l.id`
  ).all(id);
  return { ...head, lines, totalPieces: lines.reduce((a, l) => a + int(l.pieces), 0) };
}

function listDocuments(filter = {}) {
  const kind = filter.kind || '';
  const search = `%${String(filter.search || '').trim()}%`;
  const rows = db.prepare(
    `SELECT d.*, p.name AS partyName, w.name AS warehouseName, dw.name AS destWarehouseName,
            (SELECT COALESCE(SUM(l.pieces),0) FROM doc_lines l WHERE l.document_id=d.id) AS totalPieces,
            (SELECT COUNT(*) FROM doc_lines l WHERE l.document_id=d.id) AS lineCount
     FROM documents d
     LEFT JOIN parties p ON p.id=d.party_id
     LEFT JOIN warehouses w ON w.id=d.warehouse_id
     LEFT JOIN warehouses dw ON dw.id=d.dest_warehouse_id
     WHERE (?='' OR d.kind=?)
       AND (?='' OR d.doc_no LIKE ? OR IFNULL(p.name,'') LIKE ? OR IFNULL(d.invoice_value,'') LIKE ?)
     ORDER BY d.id DESC
     LIMIT ?`
  ).all(kind, kind, search.slice(1), search, search, search, int(filter.limit) || 300);
  return rows.map((r) => ({ ...r, kindAr: DOC_KINDS[r.kind] ? DOC_KINDS[r.kind].ar : r.kind }));
}

/** what will be reverted if this document is hard-deleted */
function documentImpact(id) {
  const doc = getDocument(id);
  if (!doc) return null;
  const lines = doc.lines.map((l) => {
    const out = DOC_KINDS[doc.kind].sign < 0;
    if (doc.kind === 'transfer') {
      return { item: `${l.itemCode} — ${l.itemName}`, wh: l.warehouseName, dir: 'إضافة (عكس الصادر)', qty: `${l.pieces} ${AR_BUCKET[l.bucket]}` , extra: l.destWarehouseName };
    }
    return {
      item: `${l.itemCode} — ${l.itemName}`,
      wh: l.warehouseName,
      dir: out ? 'إضافة (عكس الخصم)' : 'خصم (عكس الإضافة)',
      qty: `${l.pieces} ${AR_BUCKET[l.bucket]}`
    };
  });
  return { doc, lines, totalPieces: doc.totalPieces };
}

function deleteDocument(id) {
  const impact = documentImpact(id);
  if (!impact) throw new Error('المستند غير موجود');
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM stock_moves WHERE doc_id=? AND doc_type<>'opening'").run(id);
    db.prepare('DELETE FROM doc_lines WHERE document_id=?').run(id);
    db.prepare('DELETE FROM documents WHERE id=?').run(id);
  });
  tx();
  return impact;
}

function gatePass(id) {
  const doc = getDocument(id);
  if (!doc) throw new Error('المستند غير موجود');
  return doc;
}

/* ------------------------------------------------------------------ *
 * users — admin (full) and user (restricted per screen + per action)
 * ------------------------------------------------------------------ */

const ALL_SCREENS = ['dashboard', 'items', 'warehouses', 'parties', 'transactions', 'production', 'reports', 'settings'];
const ALL_PERMS = ['view', 'add', 'edit', 'delete'];

function rowToUser(r) {
  if (!r) return null;
  let screens = null;
  let perms = null;
  try { screens = r.screens ? JSON.parse(r.screens) : null; } catch (e) { screens = null; }
  try { perms = r.perms ? JSON.parse(r.perms) : null; } catch (e) { perms = null; }
  return {
    ...r,
    is_active: !!r.is_active,
    screens: screens || ALL_SCREENS.slice(),
    perms: perms || { view: true, add: true, edit: true, delete: true }
  };
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY (role=\'admin\') DESC, username').all().map(rowToUser);
}

function getUser(id) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
}

function getUserByUsername(username) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim().toLowerCase()));
}

function addUser(payload, credentials) {
  const username = String(payload.username || '').trim().toLowerCase();
  if (!username) throw new Error('اسم المستخدم مطلوب');
  if (!credentials || !credentials.hash) throw new Error('كلمة المرور مطلوبة');
  if (getUserByUsername(username)) throw new Error(`اسم المستخدم «${username}» مستخدم بالفعل`);
  const role = payload.role === 'admin' ? 'admin' : 'user';
  const info = db.prepare(
    `INSERT INTO users(username, full_name, salt, password_hash, role, is_active, screens, perms)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(username, str(payload.full_name), credentials.salt, credentials.hash, role,
    payload.is_active === false ? 0 : 1,
    JSON.stringify(role === 'admin' ? ALL_SCREENS : (payload.screens || [])),
    JSON.stringify(role === 'admin' ? { view: true, add: true, edit: true, delete: true } : (payload.perms || {})));
  return getUser(info.lastInsertRowid);
}

function updateUser(id, payload, credentials) {
  const existing = getUser(id);
  if (!existing) throw new Error('المستخدم غير موجود');
  const username = String(payload.username || existing.username).trim().toLowerCase();
  const clash = getUserByUsername(username);
  if (clash && clash.id !== id) throw new Error('اسم المستخدم مستخدم لشخص آخر');
  const role = payload.role === 'admin' ? 'admin' : 'user';
  db.prepare(
    `UPDATE users SET username=?, full_name=?, role=?, is_active=?, screens=?, perms=?,
     salt=COALESCE(?, salt), password_hash=COALESCE(?, password_hash) WHERE id=?`
  ).run(username, str(payload.full_name), role, payload.is_active === false ? 0 : 1,
    JSON.stringify(role === 'admin' ? ALL_SCREENS : (payload.screens || [])),
    JSON.stringify(role === 'admin' ? { view: true, add: true, edit: true, delete: true } : (payload.perms || {})),
    credentials ? credentials.salt : null, credentials ? credentials.hash : null, id);
  return getUser(id);
}

function deleteUser(id) {
  const u = getUser(id);
  if (!u) throw new Error('المستخدم غير موجود');
  const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND is_active=1").get().c;
  if (u.role === 'admin' && admins <= 1) throw new Error('لا يمكن حذف آخر مدير نشط في النظام');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  return true;
}

function touchLogin(id) {
  db.prepare("UPDATE users SET last_login=datetime('now','localtime') WHERE id=?").run(id);
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

/* ------------------------------------------------------------------ *
 * settings + production routing
 * ------------------------------------------------------------------ */

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, String(value == null ? '' : value));
  return value;
}

/** where production output is routed: good -> FG good, defect cans -> FG defect,
 *  defect ampoules -> raw material defect */
function prodRouting() {
  return {
    fgGoodWh: int(getSetting('prod.fg_good_wh')),
    fgDefectWh: int(getSetting('prod.fg_defect_wh')),
    rawDefectWh: int(getSetting('prod.raw_defect_wh')),
    bagItemId: int(getSetting('prod.bag_item_id')),
    bagWhId: int(getSetting('prod.bag_wh_id'))
  };
}

function setProdRouting(part) {
  const map = {
    fgGoodWh: 'prod.fg_good_wh',
    fgDefectWh: 'prod.fg_defect_wh',
    rawDefectWh: 'prod.raw_defect_wh',
    bagItemId: 'prod.bag_item_id',
    bagWhId: 'prod.bag_wh_id'
  };
  Object.entries(part || {}).forEach(([k, v]) => { if (map[k]) setSetting(map[k], int(v)); });
  return prodRouting();
}

function nextProdNo(table, prefix) {
  const used = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  let n = used + 1;
  let candidate = `${prefix}-${String(n).padStart(4, '0')}`;
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE doc_no=?`);
  while (exists.get(candidate)) {
    n += 1;
    candidate = `${prefix}-${String(n).padStart(4, '0')}`;
  }
  return candidate;
}

/* ------------------------------------------------------------------ *
 * issue to production — deducts raw material cartons
 * ------------------------------------------------------------------ */

function listIssues(limit = 200) {
  return db.prepare(
    `SELECT i.*, it.code AS itemCode, it.name AS itemName, it.pieces_per_carton AS perCarton,
            w.name AS warehouseName
     FROM prod_issues i
     JOIN items it ON it.id = i.item_id
     JOIN warehouses w ON w.id = i.warehouse_id
     ORDER BY i.id DESC LIMIT ?`
  ).all(limit);
}

function saveIssue(payload) {
  const itemId = int(payload.item_id);
  const whId = int(payload.warehouse_id);
  const cartons = int(payload.cartons);
  const pieces = int(payload.pieces);
  if (!itemId) throw new Error('اختر صنف المادة الخام');
  if (!whId) throw new Error('اختر المخزن المصدر');
  if (pieces <= 0) throw new Error('عدد الحبات يجب أن يكون أكبر من صفر');

  const item = db.prepare('SELECT code,name FROM items WHERE id=?').get(itemId);
  if (!item) throw new Error('الصنف غير موجود');
  const id = int(payload.id) || null;

  const tx = db.transaction(() => {
    if (id) db.prepare("DELETE FROM stock_moves WHERE doc_id=? AND doc_type='issue'").run(id);
    let docId = id;
    if (id) {
      db.prepare('UPDATE prod_issues SET doc_no=?, doc_date=?, item_id=?, warehouse_id=?, cartons=?, pieces=?, note=? WHERE id=?')
        .run(payload.doc_no, payload.doc_date, itemId, whId, cartons, pieces, str(payload.note), id);
    } else {
      const info = db.prepare(
        'INSERT INTO prod_issues(doc_no,doc_date,item_id,warehouse_id,cartons,pieces,note) VALUES(?,?,?,?,?,?,?)'
      ).run(payload.doc_no || nextProdNo('prod_issues', 'ISS'), payload.doc_date, itemId, whId, cartons, pieces, str(payload.note));
      docId = info.lastInsertRowid;
    }
    const no = db.prepare('SELECT doc_no FROM prod_issues WHERE id=?').get(docId).doc_no;
    db.prepare(
      `INSERT INTO stock_moves(item_id,warehouse_id,bucket,piece_delta,carton_qty,bag_qty,doc_type,doc_id,doc_no,note)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(itemId, whId, 'good', -pieces, cartons, 0, 'issue', docId, no, str(payload.note) || 'صرف للمنتج');
    return docId;
  });

  const newId = tx();
  const row = db.prepare(
    `SELECT i.*, it.code AS itemCode, it.name AS itemName, w.name AS warehouseName
     FROM prod_issues i JOIN items it ON it.id=i.item_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.id=?`
  ).get(newId);
  return row;
}

function issueImpact(id) {
  const row = db.prepare(
    `SELECT i.*, it.code AS itemCode, it.name AS itemName, w.name AS warehouseName
     FROM prod_issues i JOIN items it ON it.id=i.item_id JOIN warehouses w ON w.id=i.warehouse_id WHERE i.id=?`
  ).get(id);
  if (!row) return null;
  return {
    doc: row,
    lines: [{
      item: `${row.itemCode} — ${row.itemName}`,
      wh: row.warehouseName,
      dir: 'إضافة (عكس الخصم)',
      qty: `${row.pieces} سليم`
    }]
  };
}

function deleteIssue(id) {
  const impact = issueImpact(id);
  if (!impact) throw new Error('المستند غير موجود');
  db.transaction(() => {
    db.prepare("DELETE FROM stock_moves WHERE doc_id=? AND doc_type='issue'").run(id);
    db.prepare('DELETE FROM prod_issues WHERE id=?').run(id);
  })();
  return impact;
}

/* ------------------------------------------------------------------ *
 * receive production — the daily production report
 * ------------------------------------------------------------------ */

function listReceipts(limit = 200) {
  const rows = db.prepare(
    `SELECT r.*, raw.code AS rawCode, raw.name AS rawName, iss.doc_no AS issueNo
     FROM prod_receipts r
     JOIN items raw ON raw.id = r.raw_item_id
     LEFT JOIN prod_issues iss ON iss.id = r.issue_id
     ORDER BY r.id DESC LIMIT ?`
  ).all(limit);
  return rows.map((r) => ({ ...r, lines: receiptLines(r.id) }));
}

function receiptLines(receiptId) {
  return db.prepare(
    `SELECT l.*, i.code AS itemCode, i.name AS itemName, i.base_unit AS baseUnit
     FROM prod_receipt_lines l JOIN items i ON i.id = l.item_id
     WHERE l.receipt_id=? ORDER BY l.id`
  ).all(receiptId);
}

function getReceipt(id) {
  const r = db.prepare(
    `SELECT r.*, raw.code AS rawCode, raw.name AS rawName, iss.doc_no AS issueNo
     FROM prod_receipts r JOIN items raw ON raw.id=r.raw_item_id
     LEFT JOIN prod_issues iss ON iss.id=r.issue_id WHERE r.id=?`
  ).get(id);
  if (!r) return null;
  return { ...r, lines: receiptLines(id) };
}

function saveReceipt(payload) {
  const routing = prodRouting();
  const rawItemId = int(payload.raw_item_id);
  const lines = (payload.lines || []).map((l) => ({
    item_id: int(l.item_id),
    good: int(l.good),
    defect_cans: int(l.defect_cans),
    defect_ampoules: int(l.defect_ampoules),
    bags_used: int(l.bags_used),
    note: l.note
  })).filter((l) => l.item_id || l.good || l.defect_cans || l.defect_ampoules);
  const cartonPieces = int(payload.carton_pieces);

  if (!rawItemId) throw new Error('اختر صنف المادة الخام في الترويسة');
  if (!payload.carton_no || !String(payload.carton_no).trim()) throw new Error('رقم الكرتونة مطلوب');
  if (cartonPieces <= 0) throw new Error('عدد حبات الكرتونة يجب أن يكون أكبر من صفر');
  if (!lines.length) throw new Error('أضف صفاً واحداً على الأقل للمنتجات التامة');
  lines.forEach((l, i) => {
    if (!l.item_id) throw new Error(`اختر المنتج التام في السطر ${i + 1}`);
    if (l.good + l.defect_cans + l.defect_ampoules <= 0) throw new Error(`أدخل كمية في السطر ${i + 1}`);
  });

  const produced = lines.reduce((a, l) => a + l.good + l.defect_cans + l.defect_ampoules, 0);
  const bagsTotal = int(payload.bags_used) || lines.reduce((a, l) => a + l.bags_used, 0);
  const shortage = Math.max(0, cartonPieces - produced);
  const surplus = Math.max(0, produced - cartonPieces);

  // routing is only required for the buckets that actually have quantities
  if (lines.some((l) => l.good > 0) && !routing.fgGoodWh) throw new Error('حدّد مخزن «منتج تام سليم» في قسم توجيه الأرصدة');
  if (lines.some((l) => l.defect_cans > 0) && !routing.fgDefectWh) throw new Error('حدّد مخزن «منتج تام تالف» في قسم توجيه الأرصدة');
  if (lines.some((l) => l.defect_ampoules > 0) && !routing.rawDefectWh) throw new Error('حدّد مخزن «خام تالف» في قسم توجيه الأرصدة');

  const id = int(payload.id) || null;
  let newId = null;
  const tx = db.transaction(() => {
    if (id) {
      db.prepare("DELETE FROM stock_moves WHERE doc_id=? AND doc_type IN ('receipt','bags')").run(id);
      db.prepare('DELETE FROM prod_receipt_lines WHERE receipt_id=?').run(id);
      db.prepare(
        `UPDATE prod_receipts SET doc_no=?, doc_date=?, issue_id=?, raw_item_id=?, carton_no=?, carton_pieces=?,
         bags_used=?, produced_total=?, shortage=?, surplus=?, note=? WHERE id=?`
      ).run(payload.doc_no, payload.doc_date, int(payload.issue_id) || null, rawItemId, String(payload.carton_no).trim(),
        cartonPieces, bagsTotal, produced, shortage, surplus, str(payload.note), id);
    } else {
      const info = db.prepare(
        `INSERT INTO prod_receipts(doc_no,doc_date,issue_id,raw_item_id,carton_no,carton_pieces,bags_used,produced_total,shortage,surplus,note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).run(payload.doc_no || nextProdNo('prod_receipts', 'PRD'), payload.doc_date, int(payload.issue_id) || null,
        rawItemId, String(payload.carton_no).trim(), cartonPieces, bagsTotal, produced, shortage, surplus, str(payload.note));
      newId = info.lastInsertRowid;
    }
    const receiptId = id || newId;
    const docNo = db.prepare('SELECT doc_no FROM prod_receipts WHERE id=?').get(receiptId).doc_no;

    const insLine = db.prepare(
      'INSERT INTO prod_receipt_lines(receipt_id,item_id,good,defect_cans,defect_ampoules,bags_used,note) VALUES(?,?,?,?,?,?,?)'
    );
    const insMove = db.prepare(
      `INSERT INTO stock_moves(item_id,warehouse_id,bucket,piece_delta,carton_qty,bag_qty,doc_type,doc_id,doc_no,note)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    );

    for (const l of lines) {
      insLine.run(receiptId, l.item_id, l.good, l.defect_cans, l.defect_ampoules, l.bags_used, str(l.note));
      // good -> finished-goods GOOD warehouse
      if (l.good) insMove.run(l.item_id, routing.fgGoodWh, 'good', l.good, 0, 0, 'receipt', receiptId, docNo, 'إنتاج جيد');
      // defect cans -> finished-goods DEFECT warehouse
      if (l.defect_cans) insMove.run(l.item_id, routing.fgDefectWh, 'defect', l.defect_cans, 0, 0, 'receipt', receiptId, docNo, 'تالف علب');
      // defect ampoules -> RAW MATERIAL defect warehouse, on the raw item
      if (l.defect_ampoules) insMove.run(rawItemId, routing.rawDefectWh, 'defect', l.defect_ampoules, 0, 0, 'receipt', receiptId, docNo, 'تالف أمبولة');
    }
    // bags consumed, deducted from the bag item when configured
    if (bagsTotal > 0 && routing.bagItemId) {
      const wh = routing.bagWhId || routing.fgGoodWh;
      insMove.run(routing.bagItemId, wh, 'good', -bagsTotal, 0, bagsTotal, 'bags', receiptId, docNo, 'أكياس مستخدمة في الإنتاج');
    }
    return receiptId;
  });

  const savedId = tx();
  return getReceipt(savedId);
}

function receiptImpact(id) {
  const r = getReceipt(id);
  if (!r) return null;
  const routing = prodRouting();
  const lines = [];
  for (const l of r.lines) {
    const name = `${l.itemCode} — ${l.itemName}`;
    if (l.good) lines.push({ item: name, wh: whName(routing.fgGoodWh), dir: 'خصم (عكس الإضافة)', qty: `${l.good} سليم` });
    if (l.defect_cans) lines.push({ item: name, wh: whName(routing.fgDefectWh), dir: 'خصم (عكس الإضافة)', qty: `${l.defect_cans} تالف` });
    if (l.defect_ampoules) {
      const raw = db.prepare('SELECT code,name FROM items WHERE id=?').get(r.raw_item_id);
      lines.push({ item: `${raw.code} — ${raw.name}`, wh: whName(routing.rawDefectWh), dir: 'خصم (عكس الإضافة)', qty: `${l.defect_ampoules} تالف` });
    }
  }
  const bags = db.prepare("SELECT COALESCE(SUM(piece_delta),0) AS p FROM stock_moves WHERE doc_id=? AND doc_type='bags'").get(id).p;
  if (bags) {
    const routing2 = prodRouting();
    const bagItem = db.prepare('SELECT code,name FROM items WHERE id=?').get(routing2.bagItemId);
    if (bagItem) lines.push({ item: `${bagItem.code} — ${bagItem.name}`, wh: whName(routing2.bagWhId || routing2.fgGoodWh), dir: 'إضافة (عكس الخصم)', qty: `${-bags} سليم` });
  }
  return { doc: r, lines, produced: r.produced_total, shortage: r.shortage, surplus: r.surplus };
}

function whName(id) {
  const w = id ? getWarehouse(id) : null;
  return w ? w.name : 'غير محدد';
}

function deleteReceipt(id) {
  const impact = receiptImpact(id);
  if (!impact) throw new Error('التقرير غير موجود');
  db.transaction(() => {
    db.prepare("DELETE FROM stock_moves WHERE doc_id=? AND doc_type IN ('receipt','bags')").run(id);
    db.prepare('DELETE FROM prod_receipt_lines WHERE receipt_id=?').run(id);
    db.prepare('DELETE FROM prod_receipts WHERE id=?').run(id);
  })();
  return impact;
}

/** open issues, for the "linked issue" picker inside a receipt */
function listOpenIssues() {
  return db.prepare(
    `SELECT i.id, i.doc_no, i.pieces, i.cartons, it.code AS itemCode, it.name AS itemName, w.name AS warehouseName
     FROM prod_issues i JOIN items it ON it.id=i.item_id JOIN warehouses w ON w.id=i.warehouse_id
     ORDER BY i.id DESC LIMIT 100`
  ).all();
}

/* ------------------------------------------------------------------ *
 * reports — one dynamic query used by the report center
 * ------------------------------------------------------------------ */

/**
 * Returns every ledger row matching the filters, with a per-item moving
 * balance computed over the whole filtered timeline, then trimmed to the
 * requested date range. Totals are returned separately so the UI never
 * re-adds a document's invoice value once per line.
 */
function reportQuery(filters = {}) {
  const whId = int(filters.warehouseId) || null;
  const itemId = int(filters.itemId) || null;
  const partyId = int(filters.partyId) || null;
  const kind = filters.kind || '';
  const bucket = filters.bucket || '';
  const from = (filters.dateFrom || '').trim();
  const to = (filters.dateTo || '').trim();

  const where = [];
  const params = {};
  if (whId) { where.push('m.warehouse_id = @whId'); params.whId = whId; }
  if (itemId) { where.push('m.item_id = @itemId'); params.itemId = itemId; }
  if (partyId) { where.push('m.party_id = @partyId'); params.partyId = partyId; }
  if (kind) { where.push('m.doc_type = @kind'); params.kind = kind; }
  if (bucket) { where.push('m.bucket = @bucket'); params.bucket = bucket; }

  const sql = `
    SELECT m.id, m.created_at AS createdAt, m.piece_delta AS delta, m.carton_qty AS cartons,
           m.bag_qty AS bags, m.bucket AS bucket, m.doc_type AS docType, m.doc_id AS docId,
           m.doc_no AS docNo, m.note AS note, m.party_id AS partyId,
           m.warehouse_id AS warehouseId,
           i.id AS itemId, i.code AS itemCode, i.name AS itemName, i.base_unit AS baseUnit,
           i.pieces_per_carton AS perCarton, i.pieces_per_bag AS perBag,
           w.name AS warehouseName, w.kind AS warehouseKind,
           p.name AS partyName,
           d.invoice_value AS invoiceValue
    FROM stock_moves m
    JOIN items i ON i.id = m.item_id
    JOIN warehouses w ON w.id = m.warehouse_id
    LEFT JOIN parties p ON p.id = m.party_id
    LEFT JOIN documents d ON d.id = m.doc_id AND d.kind = m.doc_type
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.created_at, m.id`;

  const rows = db.prepare(sql).all(params);

  // moving balance per item across the whole filtered timeline
  const running = {};
  const seenDoc = new Set();
  for (const r of rows) {
    running[r.itemId] = (running[r.itemId] || 0) + r.delta;
    r.movingBalance = running[r.itemId];
    const key = `${r.docType}:${r.docId || r.id}`;
    r.docFirst = seenDoc.has(key) ? 0 : 1;
    seenDoc.add(key);
  }

  const inRange = rows.filter((r) => {
    const day = String(r.createdAt).slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });

  // current main-warehouse balance per item (all buckets), independent of the date range
  const main = getMainWarehouse();
  const mainBal = {};
  if (main) {
    const mb = db.prepare(
      `SELECT item_id AS id,
              COALESCE(SUM(piece_delta),0) AS total,
              COALESCE(SUM(CASE WHEN bucket='good' THEN piece_delta ELSE 0 END),0) AS good,
              COALESCE(SUM(CASE WHEN bucket='defect' THEN piece_delta ELSE 0 END),0) AS defect,
              COALESCE(SUM(CASE WHEN bucket='held' THEN piece_delta ELSE 0 END),0) AS held
       FROM stock_moves WHERE warehouse_id=? GROUP BY item_id`
    ).all(main.id);
    mb.forEach((r) => (mainBal[r.id] = r));
  }

  let qty = 0;
  let value = 0;
  let nonNumeric = 0;
  for (const r of inRange) {
    qty += r.delta;
    if (r.docFirst && r.invoiceValue) {
      const n = parseMoney(r.invoiceValue);
      if (n == null) nonNumeric += 1;
      else value += n;
    }
  }

  return {
    rows: inRange.map((r) => ({
      ...r,
      bucketAr: AR_BUCKET[r.bucket],
      docTypeAr: DOC_LABELS_ALL[r.docType] || r.docType,
      mainBalance: mainBal[r.itemId] ? mainBal[r.itemId].total : 0,
      mainGood: mainBal[r.itemId] ? mainBal[r.itemId].good : 0,
      mainDefect: mainBal[r.itemId] ? mainBal[r.itemId].defect : 0,
      mainHeld: mainBal[r.itemId] ? mainBal[r.itemId].held : 0
    })),
    totals: {
      rows: inRange.length,
      qty,
      value,
      nonNumeric,
      mainWarehouse: main ? main.name : null
    },
    columns: [
      'createdAt', 'docNo', 'docType', 'partyName', 'itemCode', 'itemName',
      'warehouseName', 'bucketAr', 'cartons', 'bags', 'delta', 'mainBalance', 'movingBalance',
      'invoiceValue', 'note'
    ]
  };
}

function parseMoney(text) {
  const cleaned = String(text == null ? '' : text)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/,/g, '')
    .replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** distinct filter values for the report screen */
function reportFacets() {
  return {
    docTypes: db.prepare('SELECT DISTINCT doc_type AS v FROM stock_moves ORDER BY v').all().map((r) => r.v),
    warehouses: listWarehouses().map((w) => ({ id: w.id, name: w.name, kind: w.kind }))
  };
}

/* ------------------------------------------------------------------ *
 * dashboard / summary
 * ------------------------------------------------------------------ */

function summary() {
  const items = db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_active=1').get().c;
  const main = getMainWarehouse();
  const mainPieces = main
    ? db.prepare('SELECT COALESCE(SUM(piece_delta),0) AS p FROM stock_moves WHERE warehouse_id=?').get(main.id).p
    : 0;
  const mainGood = main
    ? db.prepare("SELECT COALESCE(SUM(piece_delta),0) AS p FROM stock_moves WHERE warehouse_id=? AND bucket='good'").get(main.id).p
    : 0;
  const mainDefect = main
    ? db.prepare("SELECT COALESCE(SUM(piece_delta),0) AS p FROM stock_moves WHERE warehouse_id=? AND bucket='defect'").get(main.id).p
    : 0;
  const mainHeld = main
    ? db.prepare("SELECT COALESCE(SUM(piece_delta),0) AS p FROM stock_moves WHERE warehouse_id=? AND bucket='held'").get(main.id).p
    : 0;
  const today = db.prepare("SELECT COUNT(*) AS c FROM stock_moves WHERE date(created_at)=date('now','localtime')").get().c;
  const docs = db.prepare('SELECT COUNT(*) AS c FROM documents').get().c;
  const todayDocs = db.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_date=date('now','localtime')").get().c;
  const all = listItems('');
  const alerts = all.filter((i) => i.alertLowGood || i.alertHighDefect).length;
  return {
    items,
    warehouses: db.prepare('SELECT COUNT(*) AS c FROM warehouses').get().c,
    parties: db.prepare('SELECT COUNT(*) AS c FROM parties').get().c,
    documents: docs,
    todayDocs,
    moves: db.prepare('SELECT COUNT(*) AS c FROM stock_moves').get().c,
    mainPieces, mainGood, mainDefect, mainHeld,
    todayMoves: today,
    alerts,
    dbPath
  };
}

function stats() {
  return summary();
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

module.exports = {
  init,
  close,
  backupTo,
  dataDir,
  dbFile,
  BUCKETS,
  AR_BUCKET,
  listWarehouses,
  getWarehouse,
  getMainWarehouse,
  addWarehouse,
  updateWarehouse,
  deleteWarehouse,
  warehouseImpact,
  listItems,
  getItem,
  itemStock,
  openingBalances,
  addItem,
  updateItem,
  deleteItem,
  deleteItemImpact,
  PARTY_TYPES,
  listParties,
  getParty,
  addParty,
  updateParty,
  deleteParty,
  partyImpact,
  listRecentMoves,
  DOC_KINDS,
  nextDocNo,
  saveDocument,
  getDocument,
  listDocuments,
  documentImpact,
  deleteDocument,
  gatePass,
  availablePieces,
  getSetting,
  setSetting,
  prodRouting,
  setProdRouting,
  listIssues,
  saveIssue,
  issueImpact,
  deleteIssue,
  listOpenIssues,
  listReceipts,
  getReceipt,
  saveReceipt,
  receiptImpact,
  deleteReceipt,
  distinctValues,
  reportQuery,
  reportFacets,
  ALL_SCREENS,
  ALL_PERMS,
  listUsers,
  getUser,
  getUserByUsername,
  addUser,
  updateUser,
  deleteUser,
  touchLogin,
  userCount,
  moveDetail,
  deleteMove,
  summary
};
