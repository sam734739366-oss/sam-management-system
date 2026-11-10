/**
 * tools/v4-migration-check.js — prove that V4 opens a V3 database without
 * losing a single row.
 *
 * Part A builds a GENUINE V3 database with the real v0.3.0 db.js (extracted
 * from git history) holding the customer's exact situation — two warehouses
 * plus items with an opening balance and nothing else — then migrates it.
 * Part B migrates a copy of the database the installed program actually wrote.
 *
 * Run under Electron:  env -u ELECTRON_RUN_AS_NODE npx electron tools/v4-migration-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.tmp', 'v4mig');
const LIVE_DIR = path.join(process.env.APPDATA || '', 'SAM Management System');
const LIVE_DB = path.join(LIVE_DIR, 'sam.db');
const V3_COMMIT = '830a18e';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + ' :: ' + JSON.stringify(detail)); }
  else { fail++; console.log('FAIL  ' + name + ' :: ' + JSON.stringify(detail)); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));

/* ------------------------------------------------------------------ *
 * the genuine v0.3.0 database module, taken straight from git history
 * ------------------------------------------------------------------ */
function loadV3Module() {
  const src = execFileSync('git', ['show', V3_COMMIT + ':src/main/db.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const file = path.join(WORK, 'v3-db.js');
  fs.writeFileSync(file, src, 'utf8');
  delete require.cache[require.resolve(file)];
  return require(file);
}

/* ------------------------------------------------------------------ *
 * a fingerprint of everything that must survive the migration
 *
 * V3 and V4 spell some columns differently (carton_qty / carton_delta,
 * document_id / doc_id, party_id / party …), so every projection is built
 * from the columns that actually exist in the database being read.
 * ------------------------------------------------------------------ */
function fingerprint(dir) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'sam.db'));
  const cols = (table) => { try { return db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name); } catch (e) { return []; } };
  const pick = (table, list) => list.filter((c) => cols(table).indexOf(c) !== -1);
  const project = (table, list, order) => {
    const use = pick(table, list);
    if (!use.length) return [];
    try { return db.prepare('SELECT ' + use.join(',') + ' FROM ' + table + ' ORDER BY ' + (order || 'id')).all(); }
    catch (e) { return [{ error: e.message }]; }
  };
  const fp = {
    tables: (() => { try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name); } catch (e) { return []; } })(),
    warehouses: project('warehouses', ['id', 'code', 'name', 'kind']),
    items: project('items', ['id', 'code', 'name', 'base_unit']),
    stockMoves: project('stock_moves', ['id', 'item_id', 'warehouse_id', 'piece_delta', 'bucket', 'doc_type']),
    docLines: project('doc_lines', ['id', 'item_id', 'warehouse_id', 'pieces', 'cartons', 'bags', 'bucket']),
    documents: project('documents', ['id', 'kind', 'doc_no', 'doc_date']),
    users: project('users', ['id', 'username', 'role']),
    parties: project('parties', ['id', 'name'])
  };
  db.close();
  return fp;
}

function copyLiveDb(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  ['sam.db', 'sam.db-wal', 'sam.db-shm'].forEach((f) => {
    const src = path.join(LIVE_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, f));
  });
  /* fold the WAL into the main file so the copy is self-contained */
  const Database = require('better-sqlite3');
  const db = new Database(path.join(destDir, 'sam.db'));
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  ['sam.db-wal', 'sam.db-shm'].forEach((f) => {
    const p = path.join(destDir, f);
    if (fs.existsSync(p)) { try { fs.rmSync(p); } catch (e) { /* ignore */ } }
  });
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    fail++;
    console.log('FAIL  the harness crashed :: ' + (e && e.stack ? e.stack : String(e)));
  }
  try { dbMod.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { console.log('  (cleanup skipped: ' + e.message + ')'); }
  console.log('\n' + (fail === 0 ? pass + '/' + (pass + fail) + ' migration checks passed' : fail + ' FAILURES out of ' + (pass + fail)));
  app.exit(fail === 0 ? 0 : 1);
});

/* never let a locked file keep the harness alive */
const bail = setTimeout(() => {
  console.log('FAIL  the harness timed out');
  process.exit(1);
}, 120000);
app.on('will-quit', () => clearTimeout(bail));

async function run() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  /* ============ A. the customer's scenario, on a real V3 database ============ */
  const custDir = path.join(WORK, 'customer');
  fs.mkdirSync(custDir, { recursive: true });

  const v3 = loadV3Module();
  v3.init(custDir);
  const wA = v3.addWarehouse({ code: 'W1', name: 'المخزن الرئيسي', location: 'صنعاء' });
  const wB = v3.addWarehouse({ code: 'W2', name: 'مخزن الفرع', location: 'عدن' });
  v3.addItem({ code: '0001', name: 'أمبولة منفوخة 20 مل', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 24, pieces_per_bag: 12, min_good_alert: 500, max_defect_alert: 100 },
    [{ warehouseId: wA.id, good: 5000, defect: 120, held: 250 }, { warehouseId: wB.id, good: 800 }]);
  v3.addItem({ code: '0002', name: 'كيس شاي 400 جرام', base_unit: 'كيس', category: 'منتج', pieces_per_carton: 20, pieces_per_bag: 10, min_good_alert: 200, max_defect_alert: 50 },
    [{ warehouseId: wA.id, good: 1200 }]);
  v3.addItem({ code: '0003', name: 'كرتون مضغوط', base_unit: 'كرتون', category: 'مادة خام' },
    [{ warehouseId: wB.id, good: 300 }]);
  v3.close();

  const before = fingerprint(custDir);
  console.log('  V3 customer database: ' + before.items.length + ' items, ' + before.warehouses.length +
    ' warehouses, ' + before.stockMoves.length + ' stock moves, ' + before.documents.length + ' documents');

  dbMod.init(custDir);
  await sleep(200);
  const after = fingerprint(custDir);

  check('the customer keeps every warehouse',
    JSON.stringify(after.warehouses) === JSON.stringify(before.warehouses),
    { before: before.warehouses, after: after.warehouses });
  check('a warehouse the user named «المخزن الرئيسي» keeps its name',
    after.warehouses.some((w) => w.code === 'W1' && w.name === 'المخزن الرئيسي'),
    after.warehouses.map((w) => w.code + '=' + w.name));
  check('the customer keeps every item',
    JSON.stringify(after.items) === JSON.stringify(before.items), after.items.map((i) => i.code));
  check('no stock movement is lost',
    after.stockMoves.length === before.stockMoves.length, { before: before.stockMoves.length, after: after.stockMoves.length });
  const core = (rows) => JSON.stringify(rows.map((m) => [m.id, m.item_id, m.warehouse_id, m.piece_delta, m.doc_type]));
  check('every movement keeps its values (the bucket is the only thing V4 changes)',
    core(after.stockMoves) === core(before.stockMoves),
    after.stockMoves.map((m) => m.item_id + ':' + m.warehouse_id + '=' + m.piece_delta + '/' + m.bucket));
  check('the only bucket that changed is «محرز» → «سليم»',
    after.stockMoves.every((m, i) => m.bucket === (before.stockMoves[i].bucket === 'held' ? 'good' : before.stockMoves[i].bucket)),
    before.stockMoves.map((m, i) => m.bucket + '→' + after.stockMoves[i].bucket));
  check('the legacy «محرز» quantity is not deleted',
    after.stockMoves.some((m) => m.piece_delta === 250), after.stockMoves.map((m) => m.bucket + ':' + m.piece_delta));
  check('the legacy «محرز» quantity becomes «سليم»',
    after.stockMoves.every((m) => m.bucket !== 'held'), [...new Set(after.stockMoves.map((m) => m.bucket))]);
  check('the «تالف» quantities stay «تالف»',
    after.stockMoves.filter((m) => m.piece_delta === 120).length > 0 &&
    after.stockMoves.filter((m) => m.piece_delta === 120).every((m) => m.bucket === 'defect'),
    after.stockMoves.filter((m) => m.piece_delta === 120).map((m) => m.bucket));

  /* the balances the customer will actually see in the app */
  let items = null;
  let balErr = null;
  try { items = dbMod.listItems(); } catch (e) { balErr = e.message; }
  const first = (items || []).find((i) => i.code === '0001');
  let stock = null;
  try { stock = first ? dbMod.itemStock(first.id) : null; } catch (e) { balErr = balErr || e.message; }
  check('the balances read back through the new API',
    !balErr && stock && stock.length === 2, balErr || stock);
  check('the opening balance of item 0001 is «سليم 5250 / تالف 120» in the first warehouse',
    stock && stock[0] && stock[0].good === 5250 && stock[0].defect === 120, stock);
  check('the opening balance of item 0001 is «سليم 800» in the second warehouse',
    stock && stock[1] && stock[1].good === 800 && stock[1].defect === 0, stock);

  /* the new V4 tables exist */
  ['prod_receipts', 'prod_receipt_lines', 'scrap_movements'].forEach((t) => {
    check('the V4 table «' + t + '» exists', after.tables.indexOf(t) !== -1, t);
  });

  /* running the migration twice must not double anything */
  dbMod.close();
  dbMod.init(custDir);
  await sleep(150);
  const twice = fingerprint(custDir);
  check('the migration is idempotent',
    twice.stockMoves.length === after.stockMoves.length &&
    JSON.stringify(twice.stockMoves.map((m) => [m.id, m.piece_delta, m.bucket])) ===
    JSON.stringify(after.stockMoves.map((m) => [m.id, m.piece_delta, m.bucket])),
    { first: after.stockMoves.length, second: twice.stockMoves.length });
  dbMod.close();

  /* ============ B. the real installed-program database ============ */
  if (fs.existsSync(LIVE_DB)) {
    const liveDir = path.join(WORK, 'live');
    copyLiveDb(liveDir);
    const liveBefore = fingerprint(liveDir);
    console.log('  live database: ' + liveBefore.items.length + ' items, ' + liveBefore.warehouses.length +
      ' warehouses, ' + liveBefore.stockMoves.length + ' stock moves, ' + liveBefore.documents.length + ' documents');

    dbMod.init(liveDir);
    await sleep(250);
    const liveAfter = fingerprint(liveDir);

    check('the live database keeps every item',
      JSON.stringify(liveAfter.items) === JSON.stringify(liveBefore.items),
      { before: liveBefore.items.length, after: liveAfter.items.length });
    check('the live database keeps every warehouse',
      JSON.stringify(liveAfter.warehouses) === JSON.stringify(liveBefore.warehouses),
      { before: liveBefore.warehouses.length, after: liveAfter.warehouses.length });
    check('the live database keeps every stock move',
      JSON.stringify(liveAfter.stockMoves.map((m) => [m.id, m.item_id, m.warehouse_id, m.piece_delta, m.doc_type])) ===
      JSON.stringify(liveBefore.stockMoves.map((m) => [m.id, m.item_id, m.warehouse_id, m.piece_delta, m.doc_type])),
      { before: liveBefore.stockMoves.length, after: liveAfter.stockMoves.length });
    check('the live database keeps every document',
      JSON.stringify(liveAfter.documents.map((d) => [d.id, d.kind, d.doc_no, d.doc_date])) ===
      JSON.stringify(liveBefore.documents.map((d) => [d.id, d.kind, d.doc_no, d.doc_date])),
      { before: liveBefore.documents.length, after: liveAfter.documents.length });
    check('the live database keeps every document line',
      JSON.stringify(liveAfter.docLines.map((d) => [d.id, d.doc_id, d.item_id, d.pieces, d.bucket])) ===
      JSON.stringify(liveBefore.docLines.map((d) => [d.id, d.doc_id, d.item_id, d.pieces, d.bucket])),
      { before: liveBefore.docLines.length, after: liveAfter.docLines.length });
    check('the live database keeps every user',
      JSON.stringify(liveAfter.users) === JSON.stringify(liveBefore.users), liveAfter.users);
    check('the live database keeps every party',
      JSON.stringify(liveAfter.parties) === JSON.stringify(liveBefore.parties), liveAfter.parties);
    check('no bucket other than «سليم»/«تالف» remains in the live database',
      liveAfter.stockMoves.every((m) => m.bucket === 'good' || m.bucket === 'defect'),
      [...new Set(liveAfter.stockMoves.map((m) => m.bucket))]);
    check('the live database gains the V4 tables',
      ['prod_receipts', 'prod_receipt_lines', 'scrap_movements'].every((t) => liveAfter.tables.indexOf(t) !== -1),
      liveAfter.tables.filter((t) => /prod|scrap/i.test(t)));
    dbMod.close();
  } else {
    console.log('SKIP  no live database at ' + LIVE_DB);
  }
}
