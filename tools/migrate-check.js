/**
 * tools/migrate-check.js — verifies that opening the REAL v0.1.0 database with
 * the V2 schema keeps every row and adds the new tables/columns.
 * It never touches the original file: everything runs on a copy in .tmp.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const REAL_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'SAM Management System') : '';
const SANDBOX = path.join(ROOT, '.tmp', 'migrate');
const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));

function copy() {
  if (!REAL_DIR) throw new Error('APPDATA not set');
  const src = path.join(REAL_DIR, 'sam.db');
  if (!fs.existsSync(src)) throw new Error('no real database at ' + src);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, path.join(SANDBOX, 'sam.db' + suffix));
  }
  return src;
}

/** raw counts straight from the copied file, before the V2 schema runs */
function countsBefore(file) {
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true });
  const one = (t) => { try { return db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch (e) { return 'missing'; } };
  const out = {
    items: one('items'), parties: one('parties'), warehouses: one('warehouses'),
    stock_moves: one('stock_moves'), documents: one('documents'), doc_lines: one('doc_lines'),
    prod_issues: one('prod_issues'), prod_receipts: one('prod_receipts'), users: one('users'),
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  };
  db.close();
  return out;
}

app.whenReady().then(async () => {
  const src = copy();
  const before = countsBefore(src);
  console.log('source (untouched):', src);
  console.log('before V2:', JSON.stringify(before));

  dbMod.init(SANDBOX);           // creates the V2 tables + runs migrate()
  const after = countsBefore(path.join(SANDBOX, 'sam.db'));
  console.log('after  V2:', JSON.stringify(after));

  const lost = Object.keys(before).filter((k) => k !== 'tables' && String(before[k]) !== String(after[k]));
  console.log(lost.length ? 'ROW COUNTS CHANGED: ' + lost.join(',') : 'no rows lost');

  const newTables = ['prod_archive', 'tolling_orders', 'tolling_lines', 'scrap_movements'];
  newTables.forEach((t) => console.log(`table ${t}: ${after.tables.includes(t) ? 'created' : 'MISSING'}`));
  const cols = after.tables.includes('stock_moves');
  console.log('stock_moves.is_customer present:',
    dbMod.reportQuery({ buckets: ['good', 'defect', 'held'], includeCustomer: true }).rows.every((r) => 'isCustomer' in r) && cols);
  console.log('prod_receipt_lines.breaks present:',
    (() => { try { dbMod.listReceipts(1); return true; } catch (e) { return e.message; } })());

  console.log('summary:', JSON.stringify(dbMod.summary()));
  console.log('items:', dbMod.listItems('').map((i) => [i.code, i.name, i.mainStock, i.base_unit]));
  console.log('report (good only):', dbMod.reportQuery({}).totals);
  console.log('report (all buckets + breakdown):',
    dbMod.reportQuery({ buckets: ['good', 'defect', 'held'], byLocation: true }).totals.locations);

  dbMod.close();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('sandbox removed; original file untouched');
  app.exit(lost.length || !newTables.every((t) => after.tables.includes(t)) ? 1 : 0);
}).catch((e) => {
  console.error('MIGRATION CHECK FAILED:', e.message);
  try { dbMod.close(); fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (err) {}
  app.exit(1);
});
