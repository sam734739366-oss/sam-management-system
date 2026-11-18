/**
 * tools/v9-docreports-check.js — the NEW document reports, proved by numbers.
 *
 * The customer threw away the old report catalogue: it annoyed him and told
 * him nothing. What replaces it must answer one question per document kind,
 * and its totals must be in the unit of the thing counted — 20,000 ريال,
 * 20,000 أمبول, 20,000 كيس, 20,000 كرتون, 20,000 غطاء — never one number
 * that mixes ampoules with covers.
 *
 * Every expectation below is computed BY HAND from the seed, so a wrong
 * query cannot hide behind a query-shaped assertion.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v9-docreports-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', 'v9doc');
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

app.whenReady().then(async () => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(DATA, { recursive: true });

  const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
  const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
  db.init(DATA);
  session.ensureSeed();

  /* ---------------- the seed, and the arithmetic it implies ----------------
     W1 main, W2 sub.
     A أمبول زجاج  base_unit 'أمبول'  category 'خام'      perCarton 1080  opening 5000
     B علبة تام    base_unit 'علبة'   category 'منتج تام' perCarton 24    opening 1000
     C غطاء        base_unit 'غطاء'   category 'خام'      perCarton 0     opening 1000

     purchase  PUR  ext 'P-9'     value 7000   A 2000
     sale      S1   ext 'EXT-100' value 20000  A 1000 + B 8 كراتين = 192
     sale      S2   ext 'EXT-050' value 5000   C 300
     sale_return    ext 'R-1'     value 1000   B 50
     purchase_return ext 'PR-1'   value 500    A 200
     prod_receipt   ext 'RC-1'                 B 500 سليم
     prod_issue     ext 'IS-1'                 A 500
     tolling_in     ext 'TL-1'                 A 21600 (20 كرتون)

     sale detail  ⇒ 3 أسطر · 1492 حبة · 8 كراتين · 25000 ريال
     sale byUnit  ⇒ أمبول 1000 · علبة 192 · غطاء 300
     sale order   ⇒ EXT-050 قبل EXT-100 (الرقم الخارجي هو الترتيب)
     daily A      ⇒ وارد 2000 · صادر 1700 (والافتتاحي 5000 لا يُحسب)
  ------------------------------------------------------------------------ */
  db.addWarehouse({ code: 'W1', name: 'الرئيسي', location: '' });
  db.addWarehouse({ code: 'W2', name: 'الفرعي', location: '' });
  const W1 = db.getMainWarehouse().id;
  const W2 = db.listWarehouses().find((w) => w.code === 'W2').id;

  const A = db.addItem({ code: 'A-1', name: 'أمبول زجاج', base_unit: 'أمبول', category: 'خام', pieces_per_carton: 1080 }, [{ warehouseId: W1, good: 5000 }]);
  const B = db.addItem({ code: 'B-1', name: 'علبة تام', base_unit: 'علبة', category: 'منتج تام', pieces_per_carton: 24 }, [{ warehouseId: W1, good: 1000 }]);
  const C = db.addItem({ code: 'C-1', name: 'غطاء', base_unit: 'غطاء', category: 'خام' }, [{ warehouseId: W1, good: 1000 }]);
  const P1 = db.addParty({ name: 'عميل الرياض', phone: '0555', type: 'customer' });
  const P2 = db.addParty({ name: 'مورد جدة', phone: '0444', type: 'supplier' });
  const today = new Date().toISOString().slice(0, 10);
  const line = (item, pieces, extra = {}) => ({ item_id: item.id || item, bucket: 'good', pieces, cartons: 0, bags: 0, ...extra });
  const doc = (kind, ext, value, lines, extra = {}) => db.saveDocument({
    kind, external_no: ext, doc_date: today, invoice_value: value,
    party_id: extra.party_id || null, warehouse_id: extra.warehouse_id || W1, lines, ...extra
  });

  doc('purchase', 'P-9', '7000', [line(A, 2000)], { party_id: P2.id || P2 });
  doc('sale', 'EXT-100', '20000', [line(A, 1000), line(B, 192, { cartons: 8 })], { party_id: P1.id || P1 });
  doc('sale', 'EXT-050', '5000', [line(C, 300)], { party_id: P1.id || P1 });
  doc('sale_return', 'R-1', '1000', [line(B, 50)], { party_id: P1.id || P1 });
  doc('purchase_return', 'PR-1', '500', [line(A, 200)], { party_id: P2.id || P2 });
  doc('prod_receipt', 'RC-1', '', [line(B, 500, { warehouse_id: W1 })]);
  doc('prod_issue', 'IS-1', '', [line(A, 500, { warehouse_id: W1 })]);
  doc('tolling_in', 'TL-1', '', [line(A, 21600, { cartons: 20, warehouse_id: W1 })], { party_id: P1.id || P1 });

  const before = {
    docs: db.listDocuments({}).length,
    moves: db.reportQuery({}).rows.length
  };

  /* ================= 1 — the engine exists and answers per kind ================= */
  check('db.docReport exists', typeof db.docReport === 'function');
  if (typeof db.docReport !== 'function') { finish(); return; }

  const KINDS = ['sale', 'purchase', 'prod_receipt', 'prod_issue', 'sale_return', 'purchase_return', 'tolling_in'];
  const wantDocs = { sale: 2, purchase: 1, prod_receipt: 1, prod_issue: 1, sale_return: 1, purchase_return: 1, tolling_in: 1 };
  for (const k of KINDS) {
    const r = db.docReport({ kind: k, mode: 'summary' });
    eq(`«${k}» يعرض مستنداته فقط`, r.rows.length, wantDocs[k]);
    check(`«${k}» كل صفوفه من نفس النوع`, r.rows.every((x) => x.docKind === k), r.rows.map((x) => x.docKind));
  }
  const all = db.docReport({ kind: '', mode: 'summary' });
  eq('«الكل» في النوع يعرض كل المستندات', all.rows.length, 8);

  /* ================= 2 — detail mode: one row per line ================= */
  const det = db.docReport({ kind: 'sale', mode: 'detail' });
  eq('التفصيلي: سطر لكل صنف داخل المستند', det.rows.length, 3);
  check('التفصيلي يحمل اسم الصنف ووحدته', det.rows.every((r) => r.itemName && r.baseUnit),
    det.rows.map((r) => [r.itemName, r.baseUnit]));
  eq('التفصيلي: مجموع الحبات', det.totals.pieces, 1492);
  eq('التفصيلي: مجموع الكراتين', det.totals.cartons, 8);

  /* ================= 3 — totals in the unit of the thing ================= */
  const byUnit = {};
  (det.totals.byUnit || []).forEach((u) => (byUnit[u.unit] = u.pieces));
  eq('إجمالي الأمبول بوحدته', byUnit['أمبول'], 1000);
  eq('إجمالي العلب بوحدتها', byUnit['علبة'], 192);
  eq('إجمالي الأغطية بوحدتها', byUnit['غطاء'], 300);
  check('لا يُجمع نصّان مختلفان في رقم واحد', (det.totals.byUnit || []).length === 3, det.totals.byUnit);

  /* ================= 4 — money counted once per document ================= */
  eq('قيمة الفواتير تُحسب مرة لكل مستند لا مرة لكل سطر', det.totals.value, 25000);
  eq('الملخّص: نفس القيمة', db.docReport({ kind: 'sale', mode: 'summary' }).totals.value, 25000);
  const firstFlags = det.rows.filter((r) => r.docFirst).length;
  eq('عدد المستندات في التفصيلي', firstFlags, 2);

  /* ================= 5 — the EXTERNAL number is the one shown ================= */
  const sum = db.docReport({ kind: 'sale', mode: 'summary' });
  eq('الترتيب بالرقم الخارجي', sum.rows.map((r) => r.externalNo), ['EXT-050', 'EXT-100']);
  check('الرقم الخارجي موجود في كل صف', sum.rows.every((r) => String(r.externalNo || '').length > 0));
  check('عمود الرقم الخارجي معروض', sum.columns.some((c) => c.key === 'externalNo'));
  check('الرقم الداخلي ليس العمود الأول', sum.columns[0].key === 'externalNo', sum.columns[0]);

  /* ================= 6 — «الكل» means NO constraint, everywhere ================= */
  const base = db.docReport({ kind: 'sale', mode: 'detail' }).rows.length;
  eq('partyId فارغ = الكل', db.docReport({ kind: 'sale', mode: 'detail', partyId: '' }).rows.length, base);
  eq('partyId صفر = الكل', db.docReport({ kind: 'sale', mode: 'detail', partyId: 0 }).rows.length, base);
  eq('itemId فارغ = الكل', db.docReport({ kind: 'sale', mode: 'detail', itemId: '' }).rows.length, base);
  eq('category فارغة = الكل', db.docReport({ kind: 'sale', mode: 'detail', category: '' }).rows.length, base);
  eq('warehouseId فارغ = الكل', db.docReport({ kind: 'sale', mode: 'detail', warehouseId: '' }).rows.length, base);
  eq('buckets فارغة = الكل', db.docReport({ kind: 'sale', mode: 'detail', buckets: [] }).rows.length, base);

  /* and a REAL constraint still constrains */
  const onlyC = db.docReport({ kind: 'sale', mode: 'detail', itemId: C.id || C });
  eq('فلتر الصنف يعمل فعلاً', onlyC.rows.length, 1);
  eq('فلتر الصنف: الكمية', onlyC.totals.pieces, 300);
  const onlyRaw = db.docReport({ kind: 'sale', mode: 'detail', category: 'خام' });
  eq('فلتر الفئة يعمل فعلاً', onlyRaw.rows.length, 2);
  eq('فلتر الفئة: أمبول + غطاء', onlyRaw.totals.pieces, 1300);
  const onlyP2 = db.docReport({ kind: '', mode: 'summary', partyId: P2.id || P2 });
  eq('فلتر الطرف يعمل فعلاً', onlyP2.rows.length, 2);

  /* ================= 7 — the daily report stops showing the opening ================= */
  const dflt = db.dailyReport({ dateFrom: today, dateTo: today });
  const rowA = dflt.rows.find((r) => r.itemCode === 'A-1');
  eq('اليومي: وارد الألف لا يشمل الافتتاحي', rowA.totalIn, 2000);
  eq('اليومي: صادر الألف', rowA.totalOut, 1700);
  const withOpen = db.dailyReport({ dateFrom: today, dateTo: today, includeOpening: true });
  eq('اليومي: مع إظهار الافتتاحي يدخل في الوارد', withOpen.rows.find((r) => r.itemCode === 'A-1').totalIn, 7000);
  check('اليومي يحمل الافتتاحي رقماً مستقلاً', rowA.cells[W1] && typeof rowA.cells[W1].opening === 'number',
    rowA.cells[W1]);
  eq('اليومي: الافتتاحي مستقل = 5000', rowA.cells[W1].opening, 5000);

  /* ================= 8 — the daily report gains the new filters ================= */
  const dSale = db.dailyReport({ dateFrom: today, dateTo: today, kind: 'sale' });
  const dSaleA = dSale.rows.find((r) => r.itemCode === 'A-1');
  eq('اليومي بفلتر النوع: صادر المبيعات فقط', dSaleA.totalOut, 1000);
  eq('اليومي بفلتر النوع: لا وارد', dSaleA.totalIn, 0);
  const dCat = db.dailyReport({ dateFrom: today, dateTo: today, category: 'خام' });
  check('اليومي بفلتر الفئة: أصناف الفئة فقط', dCat.rows.every((r) => r.category === 'خام'),
    dCat.rows.map((r) => [r.itemCode, r.category]));
  const dParty = db.dailyReport({ dateFrom: today, dateTo: today, partyId: P2.id || P2 });
  check('اليومي بفلتر الطرف: مورد جدة فقط', dParty.rows.find((r) => r.itemCode === 'A-1').totalIn === 2000,
    dParty.rows.find((r) => r.itemCode === 'A-1'));
  check('اليومي: إجماليات بالوحدة', Array.isArray(dCat.totalsByUnit) && dCat.totalsByUnit.length > 0, dCat.totalsByUnit);
  const dUnit = {};
  (dCat.totalsByUnit || []).forEach((u) => (dUnit[u.unit] = u.inQty));
  eq('اليومي: وارد الأمبول بوحدته', dUnit['أمبول'], 2000);

  /* ================= 9 — nothing was written ================= */
  const after = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
  eq('التقارير لا تكتب شيئاً في البيانات', after, before);

  finish();

  function finish() {
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
    try { db.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    app.exit(fail ? 1 : 0);
  }
});