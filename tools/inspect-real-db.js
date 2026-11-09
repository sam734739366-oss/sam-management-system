/**
 * tools/inspect-real-db.js — read-only peek at the REAL database to confirm
 * the V3 migration landed (move_date backfilled, warehouses normalized).
 */
const { app } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

const REAL = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'SAM Management System', 'sam.db')
  : '';

app.whenReady().then(() => {
  const db = new Database(REAL, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(stock_moves)').all().map((c) => c.name);
  console.log('stock_moves columns :', cols.join(', '));
  console.log('has move_date      :', cols.includes('move_date'));
  console.log('move_date buckets  :',
    JSON.stringify(db.prepare('SELECT move_date, COUNT(*) AS c FROM stock_moves GROUP BY move_date ORDER BY move_date').all()));
  console.log('warehouses         :', JSON.stringify(db.prepare('SELECT id,code,name,kind,location FROM warehouses').all()));
  console.log('row counts         :', JSON.stringify({
    items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
    parties: db.prepare('SELECT COUNT(*) c FROM parties').get().c,
    documents: db.prepare('SELECT COUNT(*) c FROM documents').get().c,
    stock_moves: db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c
  }));
  console.log('tables             :',
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(', '));
  db.close();
  app.exit(0);
}).catch((e) => { console.error('INSPECT FAILED:', e.message); app.exit(1); });
