/**
 * tools/v10-customer-raw-ui-check.js — the customer-raw report in the real
 * renderer, on screen, on paper and in the Excel specification.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v10-customer-raw-ui-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v10-customer-raw-ui-${process.pid}`);
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
  let win;
  let db;
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

    const wh = db.addWarehouse({ code: 'W-CR-UI', name: 'مخزن المتابعة', location: 'صنعاء' });
    const raw = db.addItem({ code: 'RAW-CR-UI', name: 'أمبول خام العميل', base_unit: 'امبول', category: 'خام', pieces_per_carton: 1080 },
      [{ warehouseId: wh.id, good: 0 }]);
    const box = db.addItem({ code: 'BOX-CR-UI', name: 'علبة منتج العميل', base_unit: 'علبة', category: 'منتج تام' },
      [{ warehouseId: wh.id, good: 0 }]);
    const party = db.addParty({ name: 'عميل متابعة الواجهة', type: 'customer', phone: '770000003' });
    const batch = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 21600, note: 'دفعة المتابعة'
    });
    db.saveDocument({ kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-UI', batch_id: batch.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 21600 }] });
    db.saveDocument({ kind: 'prod_receipt', doc_date: '2026-11-16', external_no: 'PRC-UI', batch_id: batch.id,
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'good', pieces: 14600 }] });
    db.saveDocument({ kind: 'sale', doc_date: '2026-11-17', external_no: 'INV-UI', batch_id: batch.id, party_id: party.id,
      invoice_value: '12,600', blowing_fee: '2,000',
      lines: [{ item_id: box.id, warehouse_id: wh.id, bucket: 'good', pieces: 12600 }] });

    require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);
    win = new BrowserWindow({
      width: 1440, height: 900, show: false,
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
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
    check('زر متابعة خام العميل ظاهر', kinds.includes('customer_raw'), kinds);
    check('التقرير الجديد يضيف نوعاً دون حذف نوع', kinds.length === 13 && kinds.includes('warehouse_flow'), kinds);

    await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'customer_raw').click()`);
    await sleep(1200);
    const view = await js(`(() => {
      const s = SamDocReports.state;
      const r = s.res && s.res.rows[0];
      return {
        kind: s.kind,
        report: s.res && s.res.report,
        row: r ? { received: r.received, delivered: r.delivered, inWarehouse: r.inWarehouse, inProduction: r.inProduction, unitLabel: r.unitLabel } : null,
        rows: document.querySelectorAll('#drTbl tbody tr.dr-row').length,
        heads: [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim()),
        totals: document.getElementById('drTotals').textContent.replace(/\\s+/g, ' ').trim(),
        hidden: {
          mode: document.getElementById('drModeSection') ? getComputedStyle(document.getElementById('drModeSection')).display === 'none' : false,
          buckets: document.getElementById('drBucketsSection') ? getComputedStyle(document.getElementById('drBucketsSection')).display === 'none' : false,
          warehouse: document.getElementById('drWhField') ? getComputedStyle(document.getElementById('drWhField')).display === 'none' : false
        }
      };
    })()`);
    check('الواجهة تختار التقرير الجديد', view && view.kind === 'customer_raw' && view.report === 'customer_raw', view && view.report);
    check('صف الدفعة يظهر في الشاشة', view && view.rows === 1, view && view.rows);
    check('الشاشة تعرض 12600 مسلّم', view && view.row && view.row.delivered === 12600, view && view.row);
    check('الشاشة تعرض 2000 بالمخازن', view && view.row && view.row.inWarehouse === 2000, view && view.row);
    check('الشاشة تعرض 7000 بالإنتاج', view && view.row && view.row.inProduction === 7000, view && view.row);
    check('وحدة 1:1 ظاهرة للعميل', view && view.row && /1:1/.test(view.row.unitLabel), view && view.row);
    check('أعمدة الأسئلة الثلاثة ظاهرة', view && ['مسلّم للعميل', 'باقٍ بالمخازن', 'ما زال بالإنتاج'].every(h => view.heads.includes(h)), view && view.heads);
    check('بطاقات الإجماليات تذكر الأرقام المطلوبة', view && ['12600', '2000', '7000'].every(n => digits(view.totals).includes(n)), view && view.totals);
    check('خيارات الشكل والحالات والمخزن غير المنطبقة مخفية', view && view.hidden.mode && view.hidden.buckets && view.hidden.warehouse, view && view.hidden);

    await js(`SamDocs.openEditor(null, 'sale_return'); null`);
    await sleep(500);
    const returnBatch = await js(`(() => {
      const cell = document.querySelector('.modal.editor .batch-cell');
      return cell ? { visible: getComputedStyle(cell).display !== 'none', text: cell.textContent.replace(/\\s+/g, ' ').trim() } : null;
    })()`);
    check('مرتجع المبيعات يتيح ربطه بدفعة العميل', returnBatch && returnBatch.visible && /دفعة العميل/.test(returnBatch.text), returnBatch);
    await js(`(() => { const b=[...document.querySelectorAll('.modal.editor .modal-foot button')].find(x=>/إغلاق/.test(x.textContent||'')); if(b)b.click(); })()`);
    await sleep(250);

    const overlaysBefore = await js(`document.querySelectorAll('body > .overlay').length`);
    await js(`(() => { const r=document.querySelector('#drTbl tbody tr.dr-row'); if(r) r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); })()`);
    await sleep(500);
    const readOnly = await js(`(() => ({ overlays: document.querySelectorAll('body > .overlay').length,
      dangerous: [...document.querySelectorAll('body > .overlay .btn-danger .btn-txt')].map(b => b.textContent.trim()),
      messages: [...document.querySelectorAll('.toast')].map(t => t.textContent.replace(/\\s+/g, ' ').trim()) }))()`);
    check('النقر المزدوج لا يفتح تعديلاً أو حذفاً من تقرير المتابعة', readOnly && readOnly.overlays === overlaysBefore && readOnly.dangerous.length === 0, readOnly);
    check('النقر المزدوج يوضح أن تقرير المتابعة للقراءة فقط', readOnly && readOnly.messages.some((m) => /للقراءة فقط/.test(m)), readOnly && readOnly.messages);

    const paper = await js(`(() => {
      const o = SamDocReports.sheetOpts();
      return { title: o.title, body: o.bodyHtml, paper: o.paper, kind: o.kind };
    })()`);
    check('الورق يحمل عنوان متابعة خام العميل', paper && /متابعة خام العميل/.test(paper.title), paper && paper.title);
    check('الورق يحمل المسلّم والمخازن والإنتاج', paper && ['12600', '2000', '7000'].every(n => digits(paper.body).includes(n)), paper && paper.body.slice(0, 500));
    check('الورق يحمل وحدة 1:1', paper && /1:1/.test(paper.body), paper && paper.body.slice(0, 500));
    check('الورق يستخدم نوع التقرير بدون توقيع إلزامي', paper && paper.kind === 'report', paper && paper.kind);

    await js(`[...document.querySelectorAll('#drPaper button')].find(b => b.dataset.paper === 'a5').click()`);
    await sleep(150);
    const a5 = await js(`(() => {
      const o = SamDocReports.sheetOpts();
      const detail = o.bodyHtml.split('</table>')[0];
      return { paper: o.paper, heads: [...detail.matchAll(/<th>([^<]+)<\\/th>/g)].map(m => m[1]) };
    })()`);
    check('A5 يبقي كل كميات الدفعة ومصدرها على الورق', a5 && a5.paper === 'a5'
      && ['دفعة العميل', 'الصنف', 'الوحدة', 'خام مستلم', 'صرف للإنتاج', 'تام مستلم',
        'مسلّم للعميل', 'باقٍ بالمخازن', 'ما زال بالإنتاج'].every(h => a5.heads.includes(h)), a5);
    await js(`SamDocReports.print(); 1`);
    await sleep(650);
    const a5Fit = await js(`(() => {
      const pv = [...document.querySelectorAll('.pv')].pop();
      const page = pv && pv.querySelector('.print-page.a5');
      const sheet = page && page.querySelector('.sheet');
      if (!sheet) return { open: false };
      const right = sheet.getBoundingClientRect().right;
      const tables = [...sheet.querySelectorAll('table')].map(t => t.getBoundingClientRect().right);
      return { open: true, over: tables.length ? Math.max(...tables) - right : 0, tables: tables.length };
    })()`);
    check('معاينة A5 بلا قص أو تجاوز أفقي', a5Fit && a5Fit.open && a5Fit.tables >= 2 && a5Fit.over <= 1, a5Fit);
    await js(`(() => { const pv=[...document.querySelectorAll('.pv')].pop(); if(pv){const b=[...pv.querySelectorAll('.pv-bar .btn')].find(x=>/إغلاق/.test(x.textContent||'')); if(b)b.click();} })()`);
    await sleep(250);
    await js(`[...document.querySelectorAll('#drPaper button')].find(b => b.dataset.paper === 'a4').click()`);

    const xlsx = await js(`(() => {
      const s = SamDocReports.excelSpec();
      return s && { columns: s.columns.map(c => c.key), row: s.rows[0], meta: s.meta, totals: s.totals };
    })()`);
    check('Excel يحمل أعمدة المتابعة', xlsx && ['received', 'delivered', 'inWarehouse', 'inProduction'].every(k => xlsx.columns.includes(k)), xlsx && xlsx.columns);
    check('Excel يحمل أرقام الدفعة نفسها', xlsx && xlsx.row && xlsx.row.delivered === 12600 && xlsx.row.inWarehouse === 2000 && xlsx.row.inProduction === 7000, xlsx && xlsx.row);
    check('Excel يحمل إجماليات الوحدة', xlsx && (xlsx.meta || []).some(m => /1:1/.test(String(m[0])) && digits(m[1]).includes('12600')), xlsx && xlsx.meta);

    await js(`SamDocReports.print(); 1`);
    await sleep(700);
    const preview = await js(`(() => {
      const pv = [...document.querySelectorAll('.pv')].pop();
      return pv ? { text: pv.innerText.replace(/\\s+/g, ' ').trim(), paper: (pv.querySelector('.sheet') || {}).className } : null;
    })()`);
    check('المعاينة تفتح وفيها الأرقام نفسها', preview && ['12600', '2000', '7000'].every(n => digits(preview.text).includes(n)), preview && preview.text.slice(0, 600));
    await js(`(() => { const pv=[...document.querySelectorAll('.pv')].pop(); if(pv){const b=[...pv.querySelectorAll('.pv-bar .btn')].find(x=>/إغلاق/.test(x.textContent||'')); if(b)b.click();} })()`);
    await sleep(300);

    const mismatchFinished = db.addItem({ code: 'FIN-UI-MISMATCH', name: 'قطعة غير متطابقة', base_unit: 'قطعة', category: 'منتج تام' },
      [{ warehouseId: wh.id, good: 0 }]);
    const mismatch = db.saveTolling({
      doc_date: '2026-11-12', party_id: party.id, raw_item_id: raw.id,
      warehouse_id: wh.id, pieces_in: 100, note: 'وحدتان مختلفتان'
    });
    db.saveDocument({ kind: 'prod_issue', doc_date: '2026-11-14', external_no: 'ISS-UI-MISMATCH', batch_id: mismatch.id,
      lines: [{ item_id: raw.id, warehouse_id: wh.id, bucket: 'good', pieces: 100 }] });
    db.saveDocument({ kind: 'prod_receipt', doc_date: '2026-11-16', external_no: 'PRC-UI-MISMATCH', batch_id: mismatch.id,
      lines: [{ item_id: mismatchFinished.id, warehouse_id: wh.id, bucket: 'good', pieces: 10 }] });
    db.saveDocument({ kind: 'sale', doc_date: '2026-11-17', external_no: 'INV-UI-MISMATCH', batch_id: mismatch.id, party_id: party.id,
      lines: [{ item_id: mismatchFinished.id, warehouse_id: wh.id, bucket: 'good', pieces: 5 }] });
    await js(`SamDocReports.run()`);
    await sleep(900);
    const mismatchView = await js(`(() => {
      const s = SamDocReports.state;
      const i = s.res.rows.findIndex(r => r.batchId === ${mismatch.id});
      const r = s.res.rows[i];
      const tr = document.querySelectorAll('#drTbl tbody tr.dr-row')[i];
      const heads = [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim());
      const cells = tr ? Object.fromEntries(heads.map((h, n) => [h, tr.children[n].textContent.trim()])) : {};
      return { row: r && { compatible: r.unitCompatible, label: r.unitLabel, inWarehouse: r.inWarehouse, inProduction: r.inProduction },
        cells, totals: document.getElementById('drTotals').textContent.replace(/\\s+/g, ' ').trim() };
    })()`);
    check('الشاشة تعلن أن وحدتي الدفعة مختلفتان', mismatchView && mismatchView.row && mismatchView.row.compatible === false
      && /وحدتان مختلفتان/.test(mismatchView.row.label), mismatchView && mismatchView.row);
    check('الشاشة لا تعرض صفراً بدل الرصيد غير القابل للحساب', mismatchView && mismatchView.cells['باقٍ بالمخازن'] === '—'
      && mismatchView.cells['ما زال بالإنتاج'] === '—', mismatchView && mismatchView.cells);
    check('الإجماليات تحذر من الدفعات غير المتطابقة', mismatchView && /دفعات بوحدات مختلفة/.test(mismatchView.totals), mismatchView && mismatchView.totals);
    const mismatchPaper = await js(`SamDocReports.sheetOpts().bodyHtml`);
    check('الورق يحذر من الوحدات المختلفة', /دفعات بوحدات مختلفة/.test(mismatchPaper), mismatchPaper.slice(-700));
    const mismatchXlsx = await js(`(() => { const s=SamDocReports.excelSpec(); return s.rows.find(r => r.batchNo === SamDocReports.state.res.rows.find(x => x.batchId === ${mismatch.id}).batchNo); })()`);
    check('Excel يترك الرصيد غير المتطابق فارغاً لا صفراً', mismatchXlsx && mismatchXlsx.inWarehouse === null && mismatchXlsx.inProduction === null, mismatchXlsx);

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    fail++;
    await shutdown(1);
  }
});
