/**
 * tools/v10-customer-raw-check.js — customer raw material tracking.
 *
 * The customer's example is the contract:
 *   received 21,600 → issued 21,600 → good finished 14,600 → delivered 12,600
 *   delivered 12,600 · in warehouses 2,000 · still in production 7,000
 * Ampoule = box, 1:1. The report is read-only and never mixes other units.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v10-customer-raw-check.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v10-customer-raw-${process.pid}`);
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

    const wh = db.addWarehouse({ code: 'W-CR', name: 'مخزن العميل', location: 'صنعاء' });
    const raw = db.addItem({
      code: 'RAW-CR', name: 'أمبول خام العميل', base_unit: 'امبول', category: 'خام', pieces_per_carton: 1080
    }, [{ warehouseId: wh.id, good: 0 }]);
    const box = db.addItem({
      code: 'BOX-CR', name: 'علبة منتج العميل', base_unit: 'علبة', category: 'منتج تام', pieces_per_carton: 24
    }, [{ warehouseId: wh.id, good: 0 }]);
    const cover = db.addItem({
      code: 'COVER-CR', name: 'غطاء عميل آخر', base_unit: 'غطاء', category: 'خام'
    }, [{ warehouseId: wh.id, good: 0 }]);
    const party = db.addParty({ name: 'عميل المتابعة', type: 'customer', phone: '770000001' });
    const other = db.addParty({ name: 'عميل آخر', type: 'customer', phone: '770000002' });

    const primary = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 21600, bags_in: 0, note: '20 كرتون × 1080'
    });
    db.saveDocument({
      kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-CR', batch_id: primary.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 21600 }]
    });
    db.saveDocument({
      kind: 'prod_receipt', doc_date: '2026-11-16', external_no: 'PRC-CR', batch_id: primary.id,
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'good', pieces: 14600 }]
    });
    db.saveDocument({
      kind: 'sale', doc_date: '2026-11-17', external_no: 'INV-CR', batch_id: primary.id,
      party_id: party.id, invoice_value: '12,600', blowing_fee: '2,000',
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'good', pieces: 12600 }]
    });

    const untouched = db.saveTolling({
      doc_date: '2026-11-12', party_id: other.id, raw_item_id: cover.id,
      warehouse_id: wh.id, pieces_in: 1000, note: 'خام لم يُصرف'
    });
    const partial = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 5000, note: 'صرف جزئي'
    });
    db.saveDocument({
      kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-CR-2', batch_id: partial.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 4000 }]
    });

    const before = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    check('db.customerRawReport exists', typeof db.customerRawReport === 'function');
    if (typeof db.customerRawReport !== 'function') { finish(); return; }

    const report = db.customerRawReport({ partyId: [], itemId: [], category: [] });
    eq('نوع التقرير', report.report, 'customer_raw');
    eq('كل الدفعات عند «الكل»', report.rows.length, 3);
    const row = report.rows.find((r) => r.batchId === primary.id);
    check('صف دفعة المثال موجود', !!row, row);
    if (!row) { finish(); return; }

    eq('المستلم من العميل', row.received, 21600);
    eq('المصروف للإنتاج', row.issued, 21600);
    eq('التام السليم المستلم', row.producedGood, 14600);
    eq('المسلّم للعميل', row.delivered, 12600);
    eq('المتبقي في المخازن = التام − المسلّم', row.inWarehouse, 2000);
    eq('ما زال في الإنتاج = المصروف − التام', row.inProduction, 7000);
    eq('خام لم يُصرف داخل المخزن', row.rawInWarehouse, 0);
    eq('تام سليم داخل المخزن', row.finishedInWarehouse, 2000);
    eq('الوحدة المؤكدة 1:1 ظاهرة', row.unitLabel, 'امبول / علبة (1:1)');
    check('أرقام الدفعة الأساسية موجودة', row.batchNo && row.docDate && row.partyName && row.itemName,
      { batchNo: row.batchNo, docDate: row.docDate, partyName: row.partyName, itemName: row.itemName });
    check('صف الدفعة لا ينتحل معرّف مستند', row.docId === null, row.docId);
    check('دالة أرشيف عمليات خام العميل موجودة', typeof db.customerRawArchive === 'function');
    eq('فلتر دفعة واحدة في تقرير المتابعة', db.customerRawReport({ batchIds: [primary.id] }).rows.length, 1);
    eq('فلتر أكثر من دفعة في تقرير المتابعة', db.customerRawReport({ batchIds: [primary.id, partial.id] }).rows.length, 2);
    if (typeof db.customerRawArchive === 'function') {
      const archive = db.customerRawArchive({ batchIds: [primary.id] });
      eq('أرشيف العمليات يعيد الدفعة المحددة', archive.rows.length, 1);
      eq('أرشيف العمليات يستخدم نفس أرقام التقرير', archive.rows[0] && {
        received: archive.rows[0].received, issued: archive.rows[0].issued,
        producedGood: archive.rows[0].producedGood, delivered: archive.rows[0].delivered,
        inWarehouse: archive.rows[0].inWarehouse, inProduction: archive.rows[0].inProduction
      }, { received: row.received, issued: row.issued, producedGood: row.producedGood,
        delivered: row.delivered, inWarehouse: row.inWarehouse, inProduction: row.inProduction });
    }

    const required = ['received', 'delivered', 'inWarehouse', 'inProduction'];
    required.forEach((key) => check(`عمود ${key} موجود`, report.columns.some((c) => c.key === key)));

    const partialRow = report.rows.find((r) => r.batchId === partial.id);
    eq('دفعة جزئية: خام بالمخزن', partialRow && partialRow.rawInWarehouse, 1000);
    eq('دفعة جزئية: إنتاج', partialRow && partialRow.inProduction, 4000);
    const untouchedRow = report.rows.find((r) => r.batchId === untouched.id);
    eq('دفعة لم تتحرك: كلها بالمخزن', untouchedRow && untouchedRow.inWarehouse, 1000);
    eq('دفعة لم تتحرك: لا إنتاج', untouchedRow && untouchedRow.inProduction, 0);

    const unit = (report.totals.byUnit || []).find((u) => u.unit === row.unitLabel);
    check('الإجماليات محفوظة بوحدة الدفعة', !!unit, report.totals.byUnit);
    if (unit) {
      eq('إجمالي مستلم الأمبول = العلبة', unit.received, 26600);
      eq('إجمالي مصروف الأمبول = العلبة', unit.issued, 25600);
      eq('إجمالي تام الأمبول = العلبة', unit.producedGood, 14600);
      eq('إجمالي مسلّم الأمبول = العلبة', unit.delivered, 12600);
      eq('إجمالي مخازن الأمبول = العلبة', unit.inWarehouse, 3000);
      eq('إجمالي إنتاج الأمبول = العلبة', unit.inProduction, 11000);
    }
    check('وحدة الغطاء لم تُخلط مع الأمبول', (report.totals.byUnit || []).some((u) => u.unit === 'غطاء' && u.received === 1000),
      report.totals.byUnit);

    eq('فلتر العميل يضيّق الدفعات', db.customerRawReport({ partyId: party.id }).rows.length, 2);
    eq('تعدد العملاء يعيد الدفعات الثلاث', db.customerRawReport({ partyId: [party.id, other.id] }).rows.length, 3);
    eq('فلتر الصنف الخام يعمل', db.customerRawReport({ itemId: [raw.id] }).rows.length, 2);
    eq('فلتر الفئة يعمل', db.customerRawReport({ category: ['خام'] }).rows.length, 3);
    eq('فلتر بلا نتائج يعطي صفراً', db.customerRawReport({ partyId: 999999 }).rows.length, 0);

    const activeOnSale = db.customerRawReport({ dateFrom: '2026-11-17', dateTo: '2026-11-17' });
    eq('دفعة عليها حركة في الفترة تدخل التقرير', activeOnSale.rows.length, 1);
    eq('يوم الفاتورة: المسلّم', activeOnSale.rows[0] && activeOnSale.rows[0].delivered, 12600);
    eq('يوم الفاتورة: المخازن', activeOnSale.rows[0] && activeOnSale.rows[0].inWarehouse, 2000);
    eq('يوم الفاتورة: الإنتاج', activeOnSale.rows[0] && activeOnSale.rows[0].inProduction, 7000);

    const gap = db.customerRawReport({ dateFrom: '2026-11-15', dateTo: '2026-11-15' });
    eq('يوم بلا استلام أو حركة لا يُدخل دفعة بسبب حركات قبل الفترة وبعدها', gap.rows.length, 0);

    const beforeReceipt = db.customerRawReport({ dateFrom: '2026-11-12', dateTo: '2026-11-15' });
    const early = beforeReceipt.rows.find((r) => r.batchId === primary.id);
    check('تقرير حتى تاريخ سابق موجود', !!early, early);
    if (early) {
      eq('قبل الاستلام التام: لا تام بعد', early.producedGood, 0);
      eq('قبل الاستلام التام: لا مسلّم بعد', early.delivered, 0);
      eq('قبل الاستلام التام: الكل في الإنتاج', early.inProduction, 21600);
      eq('قبل الاستلام التام: لا مخازن', early.inWarehouse, 0);
    }

    const after = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    eq('تقرير المتابعة لا يكتب شيئاً', after, before);

    const mismatchFinished = db.addItem({
      code: 'FIN-CR-MISMATCH', name: 'قطعة تامة غير مؤكدة', base_unit: 'قطعة', category: 'منتج تام'
    }, [{ warehouseId: wh.id, good: 0 }]);
    const mismatch = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 100, note: 'لا توجد معادلة تحويل مؤكدة'
    });
    db.saveDocument({
      kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-CR-MISMATCH', batch_id: mismatch.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 100 }]
    });
    db.saveDocument({
      kind: 'prod_receipt', doc_date: '2026-11-16', external_no: 'PRC-CR-MISMATCH', batch_id: mismatch.id,
      lines: [{ item_id: mismatchFinished.id, warehouse_id: wh.id, bucket: 'good', pieces: 10 }]
    });
    db.saveDocument({
      kind: 'sale', doc_date: '2026-11-17', external_no: 'INV-CR-MISMATCH', batch_id: mismatch.id, party_id: party.id,
      lines: [{ item_id: mismatchFinished.id, warehouse_id: wh.id, bucket: 'good', pieces: 5 }]
    });
    const beforeMismatchRead = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    const mismatchReport = db.customerRawReport({ itemId: [raw.id] });
    const mismatchRow = mismatchReport.rows.find((r) => r.batchId === mismatch.id);
    eq('الوحدة المختلفة معلنة للدفعة', mismatchRow && mismatchRow.unitLabel, 'امبول → قطعة (وحدتان مختلفتان)');
    eq('لا يُفترض أن الأمبول يساوي القطعة', mismatchRow && mismatchRow.unitCompatible, false);
    eq('لا يُجمع رصيد وحدتين مختلفتين', mismatchRow && mismatchRow.inWarehouse, null);
    eq('لا يُطرح إنتاج بوحدة أخرى من الخام', mismatchRow && mismatchRow.inProduction, null);
    eq('رصيد الخام يبقى بوحدته', mismatchRow && mismatchRow.rawInWarehouse, 0);
    eq('رصيد التام يبقى بوحدته', mismatchRow && mismatchRow.finishedInWarehouse, 5);
    eq('الدفعة غير المتطابقة معدومة في الإجمالي العام', mismatchReport.totals.incompatibleBatches, 1);
    check('الدفعة غير المتطابقة لا تدخل إجماليات الوحدة', !(mismatchReport.totals.byUnit || []).some((u) => /وحدتان مختلفتان/.test(u.unit)), mismatchReport.totals.byUnit);

    const afterMismatch = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    eq('تقرير الوحدات المختلفة لا يكتب شيئاً', afterMismatch, beforeMismatchRead);

    /* Backdating is supported. Before the raw receipt date, «received» is
       still zero; a pre-receipt issue must expose the chronology as negative
       warehouse stock, not hide it behind the batch's eventual full receipt. */
    const backdated = db.saveTolling({
      doc_date: '2026-11-20', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 100, note: 'صرف مؤرخ قبل الاستلام'
    });
    db.saveDocument({ kind: 'prod_issue', doc_date: '2026-11-19', external_no: 'ISS-CR-BACKDATED', batch_id: backdated.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 20 }] });
    const backdatedRow = db.customerRawReport({ dateTo: '2026-11-19' }).rows.find((r) => r.batchId === backdated.id);
    eq('قبل تاريخ الاستلام لا يُحسب الخام مستلاً', backdatedRow && backdatedRow.received, 0);
    eq('الصرف المؤرخ قبل الاستلام يبقى ظاهراً', backdatedRow && backdatedRow.issued, 20);
    eq('الصرف قبل الاستلام يكشف رصيد خام سالباً', backdatedRow && backdatedRow.rawInWarehouse, -20);
    eq('الصرف قبل الاستلام يبقى في الإنتاج', backdatedRow && backdatedRow.inProduction, 20);

    /* A batch names one raw item. Other items accidentally placed on its
       issue document must not consume that customer's raw quantity. */
    const mixedIssue = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 40, note: 'سند صرف متعدد الأصناف'
    });
    db.saveDocument({ kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-CR-MIXED-ITEM', batch_id: mixedIssue.id,
      lines: [
        { item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 30 },
        { item_id: cover.id, warehouse_id: wh.id, bucket: 'good', pieces: 5 }
      ] });
    const mixedIssueRow = db.customerRawReport({ itemId: [raw.id] }).rows.find((r) => r.batchId === mixedIssue.id);
    eq('الصرف يحسب صنف الخام الخاص بالدفعة فقط', mixedIssueRow && mixedIssueRow.issued, 30);
    eq('صنف آخر في سند الصرف لا يستهلك خام الدفعة', mixedIssueRow && mixedIssueRow.rawInWarehouse, 10);
    eq('صنف آخر في سند الصرف لا يعلن عدم توافق الدفعة', mixedIssueRow && mixedIssueRow.unitCompatible, true);
    eq('رصيد إنتاج الدفعة بعد تجاهل الصنف الآخر', mixedIssueRow && mixedIssueRow.inProduction, 30);

    /* A return reduces net delivered quantity; a defect receipt is shown but
       never counted as good finished product. Both remain read-only inputs. */
    db.saveDocument({
      kind: 'prod_receipt', doc_date: '2026-11-18', external_no: 'PRC-CR-DEFECT', batch_id: primary.id,
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'defect', pieces: 400 }]
    });
    db.saveDocument({
      kind: 'sale_return', doc_date: '2026-11-19', external_no: 'RET-CR', batch_id: primary.id,
      party_id: party.id,
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'good', pieces: 600 }]
    });
    const beforeEdgesRead = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    const edgeReport = db.customerRawReport({ partyId: party.id });
    const edgeRow = edgeReport.rows.find((r) => r.batchId === primary.id);
    eq('مرتجع المبيعات مسجّل للدفعة', edgeRow && edgeRow.returned, 600);
    eq('المسلّم صافٍ بعد المرتجع', edgeRow && edgeRow.delivered, 12000);
    eq('التالف مسجّل منفصلاً', edgeRow && edgeRow.producedDefect, 400);
    eq('التالف لا يدخل التام السليم', edgeRow && edgeRow.producedGood, 14600);
    eq('المرتجع يعود إلى رصيد التام بالمخزن', edgeRow && edgeRow.finishedInWarehouse, 2600);
    eq('رصيد المخازن بعد المرتجع', edgeRow && edgeRow.inWarehouse, 2600);
    eq('معادلة الإنتاج لا تتغير بالتالف', edgeRow && edgeRow.inProduction, 7000);
    const afterEdgesRead = { docs: db.listDocuments({}).length, moves: db.reportQuery({}).rows.length };
    eq('تقرير المرتجع والتالف لا يكتب شيئاً', afterEdgesRead, beforeEdgesRead);

    /* The invoice item can be linked by mistake in a different unit. Keep
       each stage's quantity visible, but never subtract pieces from boxes. */
    const saleMismatch = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 50, note: 'فاتورة بوحدة غير متطابقة'
    });
    db.saveDocument({ kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-CR-SALE-UNIT', batch_id: saleMismatch.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 50 }] });
    db.saveDocument({ kind: 'prod_receipt', doc_date: '2026-11-16', external_no: 'PRC-CR-SALE-UNIT', batch_id: saleMismatch.id,
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'good', pieces: 10 }] });
    db.saveDocument({ kind: 'sale', doc_date: '2026-11-17', external_no: 'INV-CR-SALE-UNIT', batch_id: saleMismatch.id, party_id: party.id,
      lines: [{ item_id: mismatchFinished.id, warehouse_id: wh.id, bucket: 'good', pieces: 5 }] });
    const saleUnitRow = db.customerRawReport({ itemId: [raw.id] }).rows.find((r) => r.batchId === saleMismatch.id);
    check('وحدة الفاتورة المختلفة تعلن عدم التوافق', saleUnitRow && saleUnitRow.unitCompatible === false
      && /وحدتان مختلفتان/.test(saleUnitRow.unitLabel), saleUnitRow && saleUnitRow.unitLabel);
    eq('التام السليم يبقى بوحدته', saleUnitRow && saleUnitRow.producedGood, 10);
    eq('المسلّم يبقى بوحدته', saleUnitRow && saleUnitRow.delivered, 5);
    eq('لا يُطرح مسلّم القطع من التام العلب', saleUnitRow && saleUnitRow.finishedInWarehouse, null);
    eq('لا يُجمع رصيد مخزون بوحدتين', saleUnitRow && saleUnitRow.inWarehouse, null);
    eq('رصيد الإنتاج يبقى صالحاً بين الأمبول والعلبة', saleUnitRow && saleUnitRow.inProduction, 40);
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
