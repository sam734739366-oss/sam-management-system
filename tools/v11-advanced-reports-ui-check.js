/**
 * tools/v11-advanced-reports-ui-check.js — advanced reports in the real renderer.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v11-advanced-reports-ui-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v11-advanced-ui-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const digits = (s) => String(s || '').replace(/[^\d]/g, '');
process.on('unhandledRejection', (error) => {
  console.log('UNHANDLED: ' + (error && error.stack ? error.stack : error));
  console.log('\n==== ' + pass + ' passed, ' + (fail + 1) + ' failed ====');
  app.exit(1);
});

app.whenReady().then(async () => {
  let win, db;
  let cleaned = false;
  const errors = [];
  async function shutdown(code = 0) {
    if (cleaned) return;
    cleaned = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    try { if (db) db.close(); } catch (e) {}
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
    app.exit(code);
  }

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
    const A = db.addItem({ code: 'A-1', name: 'أمبول خام', base_unit: 'أمبول', category: 'خام' }, [{ warehouseId: W1, good: 5000 }]);
    const B = db.addItem({ code: 'B-1', name: 'علبة تامة', base_unit: 'علبة', category: 'منتج تام' },
      [{ warehouseId: W1, good: 1000 }, { warehouseId: W2, good: 200 }]);
    const C = db.addItem({ code: 'C-1', name: 'غطاء', base_unit: 'غطاء', category: 'خام' }, [{ warehouseId: W1, good: 1000 }]);
    const customer = db.addParty({ name: 'عميل الرياض', phone: '0555', type: 'customer' });
    const supplier = db.addParty({ name: 'مورد جدة', phone: '0444', type: 'supplier' });
    const line = (item, pieces, extra = {}) => ({ item_id: item.id, warehouse_id: W1, bucket: 'good', pieces, cartons: 0, bags: 0, ...extra });
    const doc = (kind, ext, date, value, lines, party_id = null) => db.saveDocument({
      kind, external_no: ext, doc_date: date, invoice_value: value, party_id, warehouse_id: W1, lines
    });
    doc('purchase', 'P-1', '2026-01-01', '1,000', [line(A, 100)], supplier.id);
    const sale1 = doc('sale', 'S-1', '2026-01-05', '5,000', [line(A, 50), line(B, 10)], customer.id);
    doc('sale_return', 'SR-1', '2026-01-10', '500', [line(B, 2)], customer.id);
    doc('purchase_return', 'PR-1', '2026-01-15', '100', [line(A, 10)], supplier.id);
    doc('prod_receipt', 'RC-1', '2026-01-20', '', [line(B, 100)]);
    doc('prod_issue', 'IS-1', '2026-01-25', '', [line(A, 200)]);
    doc('sale', 'S-2', '2026-01-28', '2,000', [line(C, 20)], customer.id);
    db.saveDocument({ kind: 'sale', external_no: 'S-3', doc_date: '2026-01-26', invoice_value: '800',
      party_id: customer.id, warehouse_id: W1, lines: [line(B, 5, { warehouse_id: W2 })] });

    require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);
    win = new BrowserWindow({ width: 1440, height: 900, show: false,
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[0] === 'object' && args[0] ? args[0] : { level: args[1], message: args[2] };
      const level = typeof d.level === 'string' ? ({ error: 3, warning: 2 })[d.level] ?? 0 : d.level;
      if (level >= 2) errors.push(String(d.message || ''));
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadFile(path.join(RENDERER, 'login.html'));
    await sleep(800);
    await js(`sam.auth.login('admin','admin123')`);
    await sleep(1600);
    await js(`localStorage.removeItem('sam.docreports.v1')`);
    await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
    await sleep(1000);

    const kinds = await js(`[...document.querySelectorAll('#drKinds .dr-kind')].map(b => b.dataset.kind)`);
    check('أزرار التقارير المتقدمة الأربعة ظاهرة', ['category', 'customer_statement', 'supplier_statement', 'item_report'].every(k => kinds.includes(k)), kinds);
    check('التقارير السابقة لم تُحذف', kinds.length === 13 && kinds.includes('customer_raw') && kinds.includes('warehouse_flow'), kinds);

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'category').click()`);
    await sleep(1000);
    const category = await js(`(() => { const s=SamDocReports.state; return { kind:s.kind, rows:s.res.rows.length,
      heads:[...document.querySelectorAll('#drTbl thead th')].map(x=>x.textContent.trim()),
      totals:document.getElementById('drTotals').textContent.replace(/\\s+/g,' ').trim() }; })()`);
    check('تقرير الفئات يعمل في الشاشة', category && category.kind === 'category' && category.rows === 3, category);
    check('تقرير الفئات يفصل الوحدات', category && ['أمبول','علبة','غطاء'].every(u => category.totals.includes(u)), category && category.totals);
    check('شكل الفئات لا يعرض تفصيلي/ملخص', await js(`getComputedStyle(document.getElementById('drModeSection')).display === 'none'`));

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'customer_statement').click()`);
    await sleep(1000);
    const customerStatement = await js(`(() => { const s=SamDocReports.state; return { kind:s.kind, rows:s.res.rows.length,
      totals:s.res.totals, text:document.getElementById('drTotals').textContent.replace(/\\s+/g,' ').trim() }; })()`);
    check('كشف العميل يعرض الرصيد الختامي', customerStatement && customerStatement.totals.balance === 7300, customerStatement && customerStatement.totals);
    check('كشف العميل يعرض الرصيد في البطاقات', customerStatement && digits(customerStatement.text).includes('7300'), customerStatement && customerStatement.text);

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'supplier_statement').click()`);
    await sleep(1000);
    const supplierStatement = await js(`SamDocReports.state.res.totals`);
    check('كشف المورد يحسب الرصيد والمرتجع', supplierStatement && supplierStatement.opening === 0 && supplierStatement.balance === 900, supplierStatement);

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'item_report').click()`);
    await sleep(1000);
    const itemSummary = await js(`(() => { const s=SamDocReports.state; return { mode:s.mode, rows:s.res.rows.length,
      totals:s.res.totals, text:document.getElementById('drTotals').textContent.replace(/\\s+/g,' ').trim() }; })()`);
    check('تقرير الصنف يفتح على الملخص', itemSummary && itemSummary.mode === 'summary' && itemSummary.rows === 4, itemSummary);
    check('تقرير الصنف يعرض المتبقي بوحدته', itemSummary && digits(itemSummary.text).includes('4840') && digits(itemSummary.text).includes('1287'), itemSummary && itemSummary.text);
    await js(`[...document.querySelectorAll('#drMode button')].find(b => b.dataset.mode === 'detail').click()`);
    await sleep(900);
    const itemDetail = await js(`(() => ({ mode:SamDocReports.state.mode, rows:SamDocReports.state.res.rows.length }))()`);
    check('تقرير الصنف يفتح تفصيل الحركات', itemDetail && itemDetail.mode === 'detail' && itemDetail.rows === 9, itemDetail);

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'sale').click()`);
    await sleep(1000);
    const drillParty = await js(`(() => {
      const tr=[...document.querySelectorAll('#drTbl tbody tr.dr-row')].find(x=>x.textContent.includes('عميل الرياض'));
      const td=tr && [...tr.children].find(x=>x.textContent.includes('عميل الرياض'));
      if(!td) return {found:false}; td.click(); return {found:true, drill:td.dataset.drill};
    })()`);
    await sleep(1000);
    const afterParty = await js(`(() => ({ kind:SamDocReports.state.kind, partyId:SamDocReports.state.partyId,
      back:!!document.getElementById('btnDocBack') && getComputedStyle(document.getElementById('btnDocBack')).display !== 'none' }))()`);
    check('النقر على العميل يفتح كشفه', drillParty && drillParty.drill === 'party' && afterParty && afterParty.kind === 'customer_statement' && afterParty.partyId.length === 1, { drillParty, afterParty });
    check('زر الرجوع يظهر بعد النقر للتقرير', afterParty && afterParty.back, afterParty);
    await js(`document.getElementById('btnDocBack').click()`);
    await sleep(900);
    check('الرجوع يعيد تقرير المبيعات', await js(`SamDocReports.state.kind === 'sale'`));

    const drillItem = await js(`(() => {
      const tr=[...document.querySelectorAll('#drTbl tbody tr.dr-row')].find(x=>x.textContent.includes('أمبول خام'));
      const td=tr && [...tr.children].find(x=>x.textContent.includes('أمبول خام'));
      if(!td) return {found:false}; td.click(); return {found:true, drill:td.dataset.drill};
    })()`);
    await sleep(1000);
    const afterItem = await js(`(() => ({ kind:SamDocReports.state.kind, itemId:SamDocReports.state.itemId, mode:SamDocReports.state.mode }))()`);
    check('النقر على الصنف يفتح تقرير الصنف', drillItem && drillItem.drill === 'item' && afterItem && afterItem.kind === 'item_report' && afterItem.itemId.length === 1 && afterItem.mode === 'summary', { drillItem, afterItem });
    await js(`document.getElementById('btnDocBack').click()`);
    await sleep(900);

    const drillDoc = await js(`(() => {
      const tr=[...document.querySelectorAll('#drTbl tbody tr.dr-row')].find(x=>x.textContent.includes('S-1'));
      const td=tr && tr.children[0]; if(!td) return {found:false}; td.click(); return {found:true, drill:td.dataset.drill};
    })()`);
    await sleep(1000);
    const afterDoc = await js(`(() => ({ kind:SamDocReports.state.kind, docIds:SamDocReports.state.docIds,
      rows:SamDocReports.state.res.rows.length,
      clear:!!document.getElementById('drDocClear') && getComputedStyle(document.getElementById('drDocField')).display !== 'none' }))()`);
    check('النقر على رقم المستند يفتح مستنداً واحداً', drillDoc && drillDoc.drill === 'doc' && afterDoc && afterDoc.docIds.length === 1 && afterDoc.rows === 2, { drillDoc, afterDoc });
    check('فلتر المستند ظاهر ويمكن إلغاؤه', afterDoc && afterDoc.clear, afterDoc);
    await js(`document.getElementById('drDocClear').click()`);
    await sleep(900);
    check('إلغاء فلتر المستند يعيد كل المبيعات', await js(`SamDocReports.state.docIds.length === 0 && SamDocReports.state.res.rows.length === 4`));

    const overlaysBefore = await js(`document.querySelectorAll('body > .overlay').length`);
    await js(`(() => { const r=document.querySelector('#drTbl tbody tr.dr-row'); if(r) r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); })()`);
    await sleep(400);
    check('النقر المزدوج لا يفتح تعديلاً من التقرير', await js(`document.querySelectorAll('body > .overlay').length === ${overlaysBefore}`));

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'item_report').click()`);
    await sleep(900);
    await js(`[...document.querySelectorAll('#drMode button')].find(b => b.dataset.mode === 'summary').click()`);
    await sleep(900);
    const paper = await js(`SamDocReports.sheetOpts()`);
    check('ورق تقرير الصنف يحمل العنوان والأرقام', paper && /تقرير الصنف/.test(paper.title) && ['4840','1287'].every(n => digits(paper.bodyHtml).includes(n)), paper && paper.bodyHtml.slice(0, 400));
    const xlsx = await js(`SamDocReports.excelSpec()`);
    check('Excel يحمل صفوف تقرير الصنف', xlsx && xlsx.rows.length === 4 && xlsx.columns.some(c => c.key === 'balance'), xlsx && xlsx.rows.length);
    check('Excel يحمل إجماليات الوحدات', xlsx && (xlsx.meta || []).some(m => /علبة/.test(String(m[0])) && digits(m[1]).includes('1287')), xlsx && xlsx.meta);

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
