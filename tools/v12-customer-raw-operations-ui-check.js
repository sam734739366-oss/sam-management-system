/**
 * tools/v12-customer-raw-operations-ui-check.js — icon-only customer raw follow-up.
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
    await sleep(1500);

    const operations = await js(`(() => {
      const view=document.getElementById('v-transactions');
      const icon=document.getElementById('rawGoReport');
      const strip=document.getElementById('rawIssueStrip');
      return {
        archiveTable:!!document.getElementById('rawBatchesTbl'),
        archiveSearch:!!document.getElementById('rawBatchSearch'),
        archiveText:/الاستلامات والمتابعة/.test(view.textContent||''),
        iconInHeader:!!icon && !!icon.closest('.view-actions'),
        iconVisible:!!icon && getComputedStyle(icon).display !== 'none',
        iconText:icon ? icon.textContent.trim() : '',
        iconLabel:icon ? icon.getAttribute('aria-label') : '',
        iconSvg:!!icon && !!icon.querySelector('svg'),
        oldCards:strip ? strip.querySelectorAll('.raw-card').length : 0,
        production:!!document.getElementById('rawGoProduction')
      };
    })()`);
    check('لا يظهر جدول الأرشيف أو بحثه داخل العمليات', operations && !operations.archiveTable && !operations.archiveSearch && !operations.archiveText, operations);
    check('أيقونة المتابعة فقط تظهر في ترويسة العمليات', operations && operations.iconInHeader && operations.iconVisible && operations.iconSvg, operations);
    check('الأيقونة بلا نص ظاهر ومعها تسمية واضحة', operations && operations.iconText === '' && /متابعة خام العميل/.test(operations.iconLabel || ''), operations);
    check('شريط الصرف القديم وتصاريح الدخول ما زالا يعملان', operations && operations.oldCards >= 1 && operations.production, operations);

    await js(`document.getElementById('rawGoReport').click()`);
    await sleep(1300);
    const opened = await js(`(() => ({ active:document.getElementById('v-reports').classList.contains('active'),
      kind:SamDocReports.state.kind, rows:SamDocReports.state.res && SamDocReports.state.res.rows.length }))()`);
    check('الضغط على الأيقونة يفتح شاشة متابعة خام العميل', opened && opened.active && opened.kind === 'customer_raw' && opened.rows === 3, opened);

    await js(`sam.auth.logout()`);
    await sleep(700);
    await js(`sam.auth.login('ops','ops123')`);
    await sleep(1500);
    await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
    await sleep(1300);
    const limited = await js(`(async () => {
      let denied=false;
      try { await SamDB.call('docReport',{kind:'customer_raw'}); } catch(e) { denied=!!(e&&e.denied); }
      const icon=document.getElementById('rawGoReport');
      return { denied, iconHidden:!icon || getComputedStyle(icon).display === 'none' };
    })()`);
    check('مستخدم العمليات لا يرى أيقونة تقارير غير مسموح له', limited && limited.iconHidden, limited);
    check('التقرير المباشر ممنوع دون صلاحية تقارير', limited && limited.denied, limited);

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
