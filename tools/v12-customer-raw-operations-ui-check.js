/**
 * tools/v12-customer-raw-operations-ui-check.js — customer raw archive in operations.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v12-customer-raw-operations-ui-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v12-raw-ops-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
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
    db.addUser({ username: 'ops', full_name: 'موظف عمليات',
      screens: ['items', 'warehouses', 'parties', 'transactions'],
      perms: { view: true, add: true } }, session.makeCredentials('ops123'));

    const wh = db.addWarehouse({ code: 'W-RAW-OPS', name: 'مخزن العمليات', location: '' });
    const raw = db.addItem({ code: 'RAW-OPS', name: 'أمبول خام', base_unit: 'امبول', category: 'خام' },
      [{ warehouseId: wh.id, good: 0 }]);
    const box = db.addItem({ code: 'BOX-OPS', name: 'علبة تامة', base_unit: 'علبة', category: 'منتج تام' },
      [{ warehouseId: wh.id, good: 0 }]);
    const customer1 = db.addParty({ name: 'عميل أول', phone: '0501', type: 'customer' });
    const customer2 = db.addParty({ name: 'عميل ثانٍ', phone: '0502', type: 'customer' });
    const line = (item, pieces) => ({ item_id: item.id, warehouse_id: wh.id, bucket: 'good', pieces, cartons: 0, bags: 0 });
    const receipt = (party, pieces, ext) => db.saveDocument({ kind: 'tolling_in', external_no: ext,
      doc_date: '2026-11-20', party_id: party.id, warehouse_id: wh.id, lines: [line(raw, pieces)] });
    const r1 = receipt(customer1, 100, 'RAW-1');
    const r2 = receipt(customer2, 50, 'RAW-2');
    receipt(customer2, 40, 'RAW-3');
    db.saveDocument({ kind: 'prod_issue', external_no: 'ISS-1', doc_date: '2026-11-21', batch_id: r1.batch_id,
      lines: [line(raw, 100)] });
    db.saveDocument({ kind: 'prod_receipt', external_no: 'PRC-1', doc_date: '2026-11-22', batch_id: r1.batch_id,
      lines: [line(box, 60)] });
    db.saveDocument({ kind: 'sale', external_no: 'INV-1', doc_date: '2026-11-23', party_id: customer1.id,
      batch_id: r1.batch_id, invoice_value: '500', lines: [line(box, 50)] });
    db.saveDocument({ kind: 'prod_issue', external_no: 'ISS-2', doc_date: '2026-11-21', batch_id: r2.batch_id,
      lines: [line(raw, 20)] });

    require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);
    win = new BrowserWindow({ width: 1500, height: 950, show: false,
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
    await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
    await sleep(1600);

    const archive = await js(`(() => {
      const host=document.getElementById('rawIssueStrip');
      const table=document.getElementById('rawBatchesTbl');
      return { visible: host && getComputedStyle(host).display !== 'none',
        text: host ? host.textContent.replace(/\\s+/g,' ').trim() : '',
        rows: table ? table.querySelectorAll('tbody tr[data-batch-id]').length : 0,
        search: !!document.getElementById('rawBatchSearch'),
        status: !!document.getElementById('rawBatchStatus'),
        report: !!document.getElementById('rawGoReport'),
        newReceipt: !!document.getElementById('rawNewReceipt'),
        oldCards: host ? host.querySelectorAll('.raw-card').length : 0,
        production: !!document.getElementById('rawGoProduction') };
    })()`);
    check('أرشيف خام العميل ظاهر في العمليات', archive && archive.visible && /دفعات خام العميل/.test(archive.text), archive);
    check('الأرشيف يعرض كل الاستلامات', archive && archive.rows === 3, archive && archive.rows);
    check('البحث وفلتر الحالة وإجراءات التقرير والاستلام موجودة', archive && archive.search && archive.status && archive.report && archive.newReceipt, archive);
    check('شريط الصرف القديم وتصاريح الدخول ما زالا يعملان', archive && archive.oldCards >= 1 && archive.production, archive);

    const rowText = await js(`document.getElementById('rawBatchesTbl').textContent.replace(/\\s+/g,' ').trim()`);
    check('الأرشيف يعرض أرقام متابعة الدفعة', ['100','60','50','10','40'].every(n => rowText.includes(n)), rowText.slice(0, 500));

    await js(`(() => { const e=document.getElementById('rawBatchSearch'); e.value='عميل ثانٍ'; e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(250);
    check('بحث العميل يضيّق الدفعات', await js(`document.querySelectorAll('#rawBatchesTbl tbody tr[data-batch-id]').length === 2`));
    await js(`(() => { const e=document.getElementById('rawBatchSearch'); e.value=''; e.dispatchEvent(new Event('input',{bubbles:true})); const s=document.getElementById('rawBatchStatus'); s.value='received'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(250);
    check('فلتر الحالة يعرض الدفعات المستلمة فقط', await js(`document.querySelectorAll('#rawBatchesTbl tbody tr[data-batch-id]').length === 1`));
    await js(`(() => { const s=document.getElementById('rawBatchStatus'); s.value='all'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(250);

    await js(`document.querySelector('#rawBatchesTbl tr[data-batch-id] [data-action="report"]').click()`);
    await sleep(1300);
    const opened = await js(`(() => ({ kind:SamDocReports.state.kind, batchIds:SamDocReports.state.batchIds,
      rows:SamDocReports.state.res && SamDocReports.state.res.rows.length,
      batchField:!!document.getElementById('drBatchField') && getComputedStyle(document.getElementById('drBatchField')).display !== 'none' }))()`);
    check('زر تقرير الدفعة يفتح التقرير مفلتراً', opened && opened.kind === 'customer_raw' && opened.batchIds.length === 1 && opened.rows === 1, opened);
    check('فلتر الدفعة ظاهر في شاشة التقرير', opened && opened.batchField, opened);
    await js(`document.getElementById('drBatchClear').click()`);
    await sleep(900);
    check('إلغاء فلتر الدفعة يعيد كل الدفعات', await js(`SamDocReports.state.batchIds.length === 0 && SamDocReports.state.res.rows.length === 3`));

    await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
    await sleep(1200);
    await js(`document.getElementById('rawNewReceipt').click(); null`);
    await sleep(500);
    const editor = await js(`(() => { const m=document.querySelector('.modal.editor'); return m ? m.textContent.replace(/\\s+/g,' ').trim().slice(0,180) : ''; })()`);
    check('زر استلام جديد يفتح محرر استلام خام العميل', /استلام خام عميل/.test(editor), editor);
    await js(`(() => { const b=[...document.querySelectorAll('.modal.editor .modal-foot button')].find(x=>/إغلاق/.test(x.textContent||'')); if(b)b.click(); })()`);
    await sleep(250);

    await js(`sam.auth.logout()`);
    await sleep(700);
    await js(`sam.auth.login('ops','ops123')`);
    await sleep(1500);
    await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
    await sleep(1400);
    const limited = await js(`(async () => {
      let denied = false;
      try { await SamDB.call('docReport', { kind: 'customer_raw' }); }
      catch (e) { denied = !!(e && e.denied); }
      return {
        archiveRows: document.querySelectorAll('#rawBatchesTbl tbody tr[data-batch-id]').length,
        reportButtons: document.querySelectorAll('#rawBatchesTbl [data-action="report"]').length,
        headerReport: !!document.getElementById('rawGoReport') && getComputedStyle(document.getElementById('rawGoReport')).display !== 'none',
        newReceipt: !!document.getElementById('rawNewReceipt') && getComputedStyle(document.getElementById('rawNewReceipt')).display !== 'none',
        denied
      };
    })()`);
    check('مستخدم العمليات يرى الأرشيف دون صلاحية تقارير', limited && limited.archiveRows === 3 && limited.reportButtons === 0 && !limited.headerReport, limited);
    check('مستخدم العمليات يحتفظ بصلاحية الاستلام الجديد', limited && limited.newReceipt, limited);
    check('التقرير المباشر ممنوع دون صلاحية تقارير', limited && limited.denied, limited);

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
