/**
 * tools/v9-invoice-probe.js — evidence, not guesses.
 *
 * The customer says the invoice value does not show in the detail nor in
 * the totals. Before touching anything, look at HIS data (on a COPY, so
 * the live file is never opened and no migration ever runs) and at the
 * column budget of the paper.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LIVE = path.join(process.env.APPDATA || '', 'SAM Management System');
const COPY = path.join(ROOT, '.tmp', 'invoice-probe');

app.whenReady().then(() => {
  try { fs.rmSync(COPY, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(COPY, { recursive: true });
  for (const f of ['sam.db', 'sam.db-wal']) {
    const src = path.join(LIVE, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(COPY, f));
  }
  const Database = require('better-sqlite3');
  const db = new Database(path.join(COPY, 'sam.db'));

  console.log('=== 1. invoice_value per kind (HIS real data) ===');
  const perKind = db.prepare(`
    SELECT kind, COUNT(*) AS docs,
           SUM(CASE WHEN invoice_value IS NOT NULL AND TRIM(invoice_value) <> '' THEN 1 ELSE 0 END) AS withValue,
           COALESCE(SUM(CAST(NULLIF(TRIM(invoice_value),'') AS REAL)),0) AS total
    FROM documents GROUP BY kind ORDER BY docs DESC`).all();
  perKind.forEach((r) => console.log(`  ${r.kind}: docs=${r.docs} withValue=${r.withValue} total=${r.total}`));

  console.log('=== 2. sample sale documents ===');
  db.prepare(`SELECT id, doc_no, external_no, doc_date, invoice_value FROM documents
              WHERE kind='sale' ORDER BY id DESC LIMIT 8`).all()
    .forEach((r) => console.log(`  #${r.id} ${r.doc_no} ext=${r.external_no} date=${r.doc_date} value=${JSON.stringify(r.invoice_value)}`));

  console.log('=== 3. do the lines carry any price? ===');
  console.log('  doc_lines columns:', db.prepare('PRAGMA table_info(doc_lines)').all().map((c) => c.name).join(', '));

  console.log('=== 4. the paper budget, A4 portrait, detail mode ===');
  const COL_MM = {
    externalNo: 24, docDate: 22, docKindAr: 26, partyName: 34, warehouseName: 26,
    itemName: 40, baseUnit: 16, bucketAr: 16, itemCount: 16, pieces: 20,
    cartons: 16, bags: 16, invoiceValue: 26, note: 30
  };
  const detail = ['externalNo', 'docDate', 'partyName', 'itemName', 'baseUnit', 'bucketAr', 'pieces', 'cartons', 'bags', 'invoiceValue', 'warehouseName'];
  const budget = 210 - 10;
  let used = 0; const keep = []; const hidden = [];
  detail.forEach((k) => { const mm = COL_MM[k]; if (used + mm <= budget) { keep.push(k); used += mm; } else hidden.push(k); });
  console.log(`  budget=${budget}mm used=${used}mm`);
  console.log('  KEPT   :', keep.join(', '));
  console.log('  HIDDEN :', hidden.join(', '));

  console.log('=== 5. the same, A4 landscape ===');
  used = 0; const keep2 = []; const hidden2 = [];
  detail.forEach((k) => { const mm = COL_MM[k]; if (used + mm <= 297 - 10) { keep2.push(k); used += mm; } else hidden2.push(k); });
  console.log('  KEPT   :', keep2.join(', '));
  console.log('  HIDDEN :', hidden2.join(', '));

  db.close();
  try { fs.rmSync(COPY, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(0);
});