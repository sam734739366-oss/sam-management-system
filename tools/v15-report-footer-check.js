/**
 * tools/v15-report-footer-check.js — the report footer never covers the last row.
 *
 * Drives the real renderer and measures the same sheet in preview and print
 * media. The body is deliberately tall enough to reach the footer zone.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v15-report-footer-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v15-footer-${process.pid}`);
const OUT = path.join(ROOT, '.tmp', 'v15footer');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

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
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    db = require(path.join(ROOT, 'src', 'main', 'db.js'));
    const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
    db.init(DATA);
    session.ensureSeed();
    require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

    win = new BrowserWindow({
      width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f8fafc',
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[0] === 'object' && args[0] ? args[0] : { level: args[1], message: args[2] };
      const level = typeof d.level === 'string' ? ({ error: 3, warning: 2 })[d.level] ?? 0 : d.level;
      if (level >= 2) errors.push(String(d.message || ''));
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadFile(path.join(RENDERER, 'login.html'));
    await sleep(700);
    await js(`sam.auth.login('admin','admin123')`);
    await sleep(1500);

    const rows = Array.from({ length: 11 }, (_, i) => `<tr><td>صنف اختبار التذييل ${i + 1}</td><td>حبة</td><td>0</td><td>0</td><td>${100 + i}</td></tr>`).join('');
    await js(`(() => {
      const bodyHtml = \`
        <table class="tbl" style="width:100%;table-layout:fixed">
          <thead><tr><th>الصنف</th><th>الوحدة</th><th>وارد</th><th>صادر</th><th>المتبقي</th></tr></thead>
          <tbody>\${${JSON.stringify(rows)}}</tbody>
        </table>
        <div style="margin-top:5mm"><b>ملخص المخازن</b>
          <table class="tbl"><thead><tr><th>المخزن</th><th>وارد</th><th>صادر</th><th>المتبقي</th></tr></thead>
          <tbody><tr><td>المخزن الرئيسي</td><td>0</td><td>0</td><td>1,249,319</td></tr></tbody></table>
        </div>
        <div style="margin-top:4mm"><b>الإجماليات — كل شيء بوحدته</b>
          <table class="tbl"><thead><tr><th>الوحدة</th><th>وارد</th><th>صادر</th><th>المتبقي</th></tr></thead>
          <tbody>
            <tr><td>كيس</td><td>0</td><td>0</td><td>10,606</td></tr>
            <tr><td>علبة</td><td>0</td><td>0</td><td>524,600</td></tr>
            <tr><td>غطاء</td><td>0</td><td>0</td><td>260,704</td></tr>
            <tr><td>أمبول</td><td>0</td><td>0</td><td>450,999</td></tr>
            <tr><td>كيلو جرام</td><td>0</td><td>0</td><td>2,410</td></tr>
          </tbody></table>
        </div>\`;
      const node = SamUI.sheet({
        title: 'التقرير اليومي',
        subtitle: 'اختبار مسافة التذييل عن آخر صف',
        docRef: 'DR-FOOTER',
        docRefLabel: 'رقم التقرير',
        head: [{ k: 'الفترة', v: 'كل الفترات' }, { k: 'عدد الأصناف', v: '11' }],
        bodyHtml,
        dense: true,
        landscape: true,
        kind: 'report',
        footer: 'SAM Management System — التقرير اليومي (الكميات بالوحدة الأساسية لكل صنف)'
      });
      const frame = document.createElement('div');
      frame.className = 'pv-frame land';
      const page = document.createElement('div');
      page.className = 'print-page land';
      page.id = 'footerTestPage';
      page.appendChild(node);
      frame.appendChild(page);
      document.body.appendChild(frame);
      return 1;
    })()`);

    const measure = `(() => {
      const page = document.getElementById('footerTestPage');
      const sheet = page && page.querySelector('.sheet');
      const body = sheet && sheet.querySelector('.doc-body');
      const foot = sheet && sheet.querySelector('.doc-foot');
      if (!sheet || !body || !foot) return { error: 'missing sheet/body/footer' };
      const cells = [...body.querySelectorAll('*')].map(e => e.getBoundingClientRect());
      const bodyBottom = cells.reduce((max, r) => Math.max(max, r.bottom), body.getBoundingClientRect().bottom);
      const fr = foot.getBoundingClientRect();
      const sr = sheet.getBoundingClientRect();
      const cs = getComputedStyle(foot);
      return {
        gap: Math.round((fr.top - bodyBottom) * 10) / 10,
        bodyBottom: Math.round(bodyBottom * 10) / 10,
        footerTop: Math.round(fr.top * 10) / 10,
        footerBottom: Math.round(fr.bottom * 10) / 10,
        sheetBottom: Math.round(sr.bottom * 10) / 10,
        footerInset: Math.round((sr.bottom - fr.bottom) * 10) / 10,
        footerBackground: cs.backgroundColor,
        footerBorder: cs.borderTopColor,
        sheetPaddingBottom: getComputedStyle(sheet).paddingBottom,
        sheetOverflow: getComputedStyle(sheet).overflow
      };
    })()`;

    await sleep(250);
    const preview = await js(measure);
    check('المعاينة: آخر محتوى يترك مسافة واضحة فوق التذييل', preview && preview.gap >= 6, preview);
    check('المعاينة: التذييل داخل الورقة وليس خارجها', preview && preview.footerInset >= 16 && preview.footerInset <= 24, preview);
    check('المعاينة: التذييل يحمل خلفية خفيفة تفصله عن الجدول', preview && preview.footerBackground !== 'rgba(0, 0, 0, 0)' && preview.footerBackground !== 'transparent', preview && preview.footerBackground);
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'preview.png'), img.toPNG());
    } catch (e) { console.log('تعذر التقاط صورة المعاينة: ' + e.message); }

    const debuggerApi = win.webContents.debugger;
    debuggerApi.attach('1.3');
    try {
      await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
      await js(`(() => {
        const page = document.getElementById('footerTestPage');
        const host = document.getElementById('printHost');
        host.replaceChildren(page);
        document.body.classList.add('is-printing');
        return 1;
      })()`);
      await sleep(180);
      const printed = await js(measure);
      check('الطباعة: آخر محتوى يترك مسافة واضحة فوق التذييل', printed && printed.gap >= 6, printed);
      check('الطباعة: التذييل داخل مساحة الورقة', printed && printed.footerInset >= 16 && printed.footerInset <= 24, printed);
      check('الطباعة: خلفية التذييل تبقى ظاهرة', printed && printed.footerBackground !== 'rgba(0, 0, 0, 0)' && printed.footerBackground !== 'transparent', printed && printed.footerBackground);
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, 'print.png'), img.toPNG());
      } catch (e) { console.log('تعذر التقاط صورة الطباعة: ' + e.message); }
    } finally {
      try { await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { media: '' }); } catch (e) {}
      try { debuggerApi.detach(); } catch (e) {}
    }

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
