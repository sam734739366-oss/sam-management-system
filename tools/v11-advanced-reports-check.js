/**
 * tools/v11-advanced-reports-check.js — category, party statements and item report.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v11-advanced-reports-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v11-advanced-${process.pid}`);
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

process.on('unhandledRejection', (error) => {
  console.log('UNHANDLED: ' + (error && error.stack ? error.stack : error));
  console.log('\n==== ' + pass + ' passed, ' + (fail + 1) + ' failed ====');
  app.exit(1);
});

app.whenReady().then(() => {
  let db;
  try {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(DATA, { recursive: true });
    db = require(path.join(ROOT, 'src', 'main', 'db.js'));
    const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
    db.init(DATA);
    session.ensureSeed();

    db.addWarehouse({ code: 'W1', name: 'الرئيسي', location: '' });
    db.addWarehouse({ code: 'W2', name: 'الفرعي', location: '' });
    const W1 = db.getMainWarehouse().id;
    const W2 = db.listWarehouses().find((w) => w.code === 'W2').id;
    const A = db.addItem({ code: 'A-1', name: 'أمبول خام', base_unit: 'أمبول', category: 'خام' },
      [{ warehouseId: W1, good: 5000 }]);
    const B = db.addItem({ code: 'B-1', name: 'علبة تامة', base_unit: 'علبة', category: 'منتج تام' },
      [{ warehouseId: W1, good: 1000 }, { warehouseId: W2, good: 200 }]);
    const C = db.addItem({ code: 'C-1', name: 'غطاء', base_unit: 'غطاء', category: 'خام' },
      [{ warehouseId: W1, good: 1000 }]);
    const customer = db.addParty({ name: 'عميل الرياض', phone: '0555', type: 'customer' });
    const supplier = db.addParty({ name: 'مورد جدة', phone: '0444', type: 'supplier' });
    const line = (item, pieces, extra = {}) => ({ item_id: item.id, warehouse_id: W1, bucket: 'good', pieces, cartons: 0, bags: 0, ...extra });
    const doc = (kind, ext, date, value, lines, party_id = null) => db.saveDocument({
      kind, external_no: ext, doc_date: date, invoice_value: value,
      party_id, warehouse_id: W1, lines
    });

    const purchase = doc('purchase', 'P-1', '2026-01-01', '1,000', [line(A, 100)], supplier.id);
    const sale1 = doc('sale', 'S-1', '2026-01-05', '5,000', [line(A, 50), line(B, 10)], customer.id);
    const saleReturn = doc('sale_return', 'SR-1', '2026-01-10', '500', [line(B, 2)], customer.id);
    const purchaseReturn = doc('purchase_return', 'PR-1', '2026-01-15', '100', [line(A, 10)], supplier.id);
    const receipt = doc('prod_receipt', 'RC-1', '2026-01-20', '', [line(B, 100)]);
    const issue = doc('prod_issue', 'IS-1', '2026-01-25', '', [line(A, 200)]);
    const sale2 = doc('sale', 'S-2', '2026-01-28', '2,000', [line(C, 20)], customer.id);
    const sale3 = db.saveDocument({ kind: 'sale', external_no: 'S-3', doc_date: '2026-01-26',
      invoice_value: '800', party_id: customer.id, warehouse_id: W1,
      lines: [line(B, 5, { warehouse_id: W2 })] });

    const before = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    const kinds = db.DOC_REPORT_KINDS.map((k) => k.key);
    ['category', 'customer_statement', 'supplier_statement', 'item_report'].forEach((key) => {
      check(`نوع التقرير ${key} مسجّل`, kinds.includes(key), kinds);
    });
    check('دالة تقرير الفئات موجودة', typeof db.categoryReport === 'function');
    check('دالة كشف حساب الطرف موجودة', typeof db.partyStatementReport === 'function');
    check('دالة تقرير الصنف موجودة', typeof db.itemReport === 'function');
    if (typeof db.categoryReport !== 'function' || typeof db.partyStatementReport !== 'function' || typeof db.itemReport !== 'function') {
      finish(); return;
    }

    const range = { dateFrom: '2026-01-05', dateTo: '2026-01-28' };
    const category = db.categoryReport(range);
    eq('نوع تقرير الفئات', category.report, 'category');
    eq('تقرير الفئات: ثلاثة صفوف بوحدات منفصلة', category.rows.length, 3);
    const rawCat = category.rows.find((r) => r.category === 'خام' && r.unit === 'أمبول');
    const coverCat = category.rows.find((r) => r.category === 'خام' && r.unit === 'غطاء');
    const finishedCat = category.rows.find((r) => r.category === 'منتج تام' && r.unit === 'علبة');
    eq('الفئة الخام: صادر الأمبول', rawCat && rawCat.outQty, 260);
    eq('الفئة الخام: صافي الأمبول', rawCat && rawCat.net, -260);
    eq('الفئة الخام: قيمة فواتير الأمبول مرة واحدة', rawCat && rawCat.value, 5100);
    eq('فئة الأغطية: صادر الغطاء', coverCat && coverCat.outQty, 20);
    eq('فئة الأغطية: قيمة فاتورتها', coverCat && coverCat.value, 2000);
    eq('فئة التام: وارد العلب', finishedCat && finishedCat.inQty, 102);
    eq('فئة التام: صادر العلب', finishedCat && finishedCat.outQty, 15);
    eq('فئة التام: صافي العلب', finishedCat && finishedCat.net, 87);
    eq('قيمة الفواتير لا تتكرر بين الفئات', category.totals.value, 8400);
    eq('عدد مستندات الفئات دون تكرار', category.totals.documents, 7);
    check('إجماليات الفئات تفصل الوحدات', (category.totals.byUnit || []).length === 3, category.totals.byUnit);

    const onlySale1 = db.categoryReport({ ...range, docIds: [sale1.id] });
    eq('فلتر المستند في تقرير الفئات', onlySale1.rows.reduce((n, r) => n + r.lines, 0), 2);
    eq('قيمة المستند المحدد في الفئات', onlySale1.totals.value, 5000);
    const onlyRaw = db.categoryReport({ ...range, category: ['خام'] });
    eq('فلتر الفئة يضيّق تقرير الفئات', onlyRaw.rows.length, 2);

    const customerStatement = db.partyStatementReport({ ...range, kind: 'customer_statement' });
    eq('نوع كشف العميل', customerStatement.report, 'customer_statement');
    eq('كشف العميل: أربعة مستندات', customerStatement.totals.documents, 4);
    eq('كشف العميل: الرصيد الافتتاحي', customerStatement.totals.opening, 0);
    eq('كشف العميل: عليه مبيعات', customerStatement.totals.debit, 7800);
    eq('كشف العميل: له مرتجع', customerStatement.totals.credit, 500);
    eq('كشف العميل: الرصيد الختامي', customerStatement.totals.balance, 7300);
    const customerFirst = customerStatement.rows.find((r) => r.docId === sale1.id && r.docFirst);
    eq('أول سطر لفاتورة العميل يحمل الرصيد الجاري', customerFirst && customerFirst.balance, 5000);
    const customerReturn = customerStatement.rows.find((r) => r.docId === saleReturn.id && r.docFirst);
    eq('مرتجع العميل يخفض الرصيد', customerReturn && customerReturn.balance, 4500);
    check('قيمة الفاتورة مرة واحدة في كشف العميل', customerStatement.rows.filter((r) => r.docId === sale1.id && r.invoiceValue != null).length === 1);
    const customerByUnit = Object.fromEntries((customerStatement.totals.byUnit || []).map((u) => [u.unit, u]));
    eq('كشف العميل: أمبول صادر', customerByUnit['أمبول'] && customerByUnit['أمبول'].outQty, 50);
    eq('كشف العميل: علبة واردة', customerByUnit['علبة'] && customerByUnit['علبة'].inQty, 2);
    eq('كشف العميل: علبة صادرة', customerByUnit['علبة'] && customerByUnit['علبة'].outQty, 15);

    const supplierStatement = db.partyStatementReport({ ...range, kind: 'supplier_statement' });
    eq('نوع كشف المورد', supplierStatement.report, 'supplier_statement');
    eq('كشف المورد: الرصيد الافتتاحي من فاتورة سابقة', supplierStatement.totals.opening, 1000);
    eq('كشف المورد: مرتجع المشتريات', supplierStatement.totals.credit, 100);
    eq('كشف المورد: الرصيد الختامي', supplierStatement.totals.balance, 900);
    const supplierRow = supplierStatement.rows.find((r) => r.docId === purchaseReturn.id && r.docFirst);
    eq('أول سطر لمرتجع المورد يحمل الرصيد', supplierRow && supplierRow.balance, 900);

    const itemSummary = db.itemReport({ ...range, mode: 'summary' });
    eq('نوع تقرير الصنف', itemSummary.report, 'item_report');
    eq('تقرير الصنف: أربعة صفوف صنف/مخزن', itemSummary.rows.length, 4);
    const itemA = itemSummary.rows.find((r) => r.itemId === A.id && r.warehouseId === W1);
    eq('صنف الأمبول: الافتتاحي', itemA && itemA.opening, 5100);
    eq('صنف الأمبول: الوارد', itemA && itemA.inQty, 0);
    eq('صنف الأمبول: الصادر', itemA && itemA.outQty, 260);
    eq('صنف الأمبول: المتبقي', itemA && itemA.balance, 4840);
    const itemB2 = itemSummary.rows.find((r) => r.itemId === B.id && r.warehouseId === W2);
    eq('صنف العلبة في الفرعي: المتبقي', itemB2 && itemB2.balance, 195);
    const itemUnits = Object.fromEntries((itemSummary.totals.byUnit || []).map((u) => [u.unit, u]));
    eq('إجمالي افتتاحي العلب بوحدتها', itemUnits['علبة'] && itemUnits['علبة'].opening, 1200);
    eq('إجمالي متبقي العلب بوحدتها', itemUnits['علبة'] && itemUnits['علبة'].balance, 1287);
    eq('إجمالي متبقي الأغطية بوحدتها', itemUnits['غطاء'] && itemUnits['غطاء'].balance, 980);
    eq('إجمالي متبقي الأمبول بوحدتها', itemUnits['أمبول'] && itemUnits['أمبول'].balance, 4840);

    const itemDetail = db.itemReport({ ...range, mode: 'detail', itemId: [A.id], warehouseId: [W1] });
    eq('تفصيل الصنف: ثلاث حركات في الفترة', itemDetail.rows.length, 3);
    eq('تفصيل الصنف: أول رصيد جارٍ', itemDetail.rows[0] && itemDetail.rows[0].balance, 5050);
    eq('تفصيل الصنف: الرصيد بعد المرتجع', itemDetail.rows[1] && itemDetail.rows[1].balance, 5040);
    eq('تفصيل الصنف: الرصيد الختامي', itemDetail.rows[2] && itemDetail.rows[2].balance, 4840);
    const itemByDoc = db.itemReport({ ...range, mode: 'detail', docIds: [sale1.id] });
    eq('فلتر المستند في تفصيل الصنف', itemByDoc.rows.length, 2);

    const filteredDoc = db.docReport({ kind: 'sale', mode: 'detail', docIds: [sale1.id] });
    eq('النقر على رقم المستند يفتح مستنداً واحداً', filteredDoc.rows.length, 2);
    check('كل سطر من المستند المحدد', filteredDoc.rows.every((r) => r.docId === sale1.id), filteredDoc.rows.map((r) => r.docId));

    const after = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    eq('التقارير المتقدمة لا تكتب شيئاً', after, before);

    /* Adjustments are real stock changes even though their document sign is
       zero; the direction lives on each line. */
    const adjusted = db.addItem({ code: 'ADJ-1', name: 'صنف تسوية', base_unit: 'حبة', category: 'تسوية' },
      [{ warehouseId: W1, good: 0 }]);
    db.saveDocument({ kind: 'adjustment', external_no: 'ADJ-1', doc_date: '2026-01-22',
      party_id: customer.id, warehouse_id: W1, lines: [
        line(adjusted, 7, { sign: 1 }), line(adjusted, 2, { sign: -1 })
      ] });
    const adjustedCategory = db.categoryReport({ itemId: [adjusted.id] }).rows[0];
    eq('تسوية الجرد: الوارد من اتجاه السطر', adjustedCategory && adjustedCategory.inQty, 7);
    eq('تسوية الجرد: الصادر من اتجاه السطر', adjustedCategory && adjustedCategory.outQty, 2);
    eq('تسوية الجرد: الصافي', adjustedCategory && adjustedCategory.net, 5);
    const adjustedStatement = db.partyStatementReport({ kind: 'customer_statement', partyId: [customer.id], itemId: [adjusted.id] });
    const adjustedUnit = (adjustedStatement.totals.byUnit || []).find((u) => u.unit === 'حبة');
    eq('كشف العميل: تسوية الجرد واردة', adjustedUnit && adjustedUnit.inQty, 7);
    eq('كشف العميل: تسوية الجرد صادرة', adjustedUnit && adjustedUnit.outQty, 2);

    const idle = db.addItem({ code: 'IDLE-1', name: 'صنف افتتاحي فقط', base_unit: 'حبة', category: 'خام' },
      [{ warehouseId: W1, good: 40 }]);
    const priorOnly = db.addItem({ code: 'PRIOR-1', name: 'صنف حركة سابقة فقط', base_unit: 'حبة', category: 'خام' },
      [{ warehouseId: W1, good: 0 }]);
    doc('purchase', 'P-PRIOR', '2026-01-01', '', [line(priorOnly, 25)], supplier.id);
    const openingOnly = db.itemReport({ ...range, mode: 'summary', itemId: [idle.id, priorOnly.id] });
    eq('ملخص الصنف يبقي أصناف الافتتاحي فقط', openingOnly.rows.length, 2);
    eq('صنف الافتتاحي فقط يظهر برصيده', openingOnly.rows.find((r) => r.itemId === idle.id) && openingOnly.rows.find((r) => r.itemId === idle.id).balance, 40);
    eq('صنف الحركة السابقة فقط يظهر برصيده', openingOnly.rows.find((r) => r.itemId === priorOnly.id) && openingOnly.rows.find((r) => r.itemId === priorOnly.id).balance, 25);
    const openingUnit = (openingOnly.totals.byUnit || []).find((u) => u.unit === 'حبة');
    eq('إجمالي أصناف الافتتاحي فقط', openingUnit && openingUnit.opening, 65);
    eq('إجمالي متبقي أصناف الافتتاحي فقط', openingUnit && openingUnit.balance, 65);
    finish();
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    fail++;
    finish();
  }

  function finish() {
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
    try { if (db) db.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    app.exit(fail ? 1 : 0);
  }
});
