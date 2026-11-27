/**
 * tools/v13-editor-layout-check.js — fixed document editor and aligned rows.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v13-editor-layout-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v13-editor-${process.pid}`);
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
    const wh = db.addWarehouse({ code: 'W-ED', name: 'مخزن المحرر', location: '' });
    db.addItem({ code: 'ED-1', name: 'صنف المحرر', base_unit: 'حبة', category: 'خام',
      pieces_per_carton: 100, pieces_per_bag: 10 }, [{ warehouseId: wh.id, good: 1000 }]);

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
    await js(`document.querySelector('.nav-item[data-view=transactions]').click()`);
    await sleep(1200);
    await js(`SamDocs.openEditor(null, 'gate_in'); null`);
    await sleep(900);
    await js(`(() => { for(let i=0;i<7;i++){ const b=[...document.querySelectorAll('.editor button')].find(x=>/إضافة سطر/.test(x.textContent||'')); if(b)b.click(); } return 1; })()`);
    await sleep(700);

    const measure = `(() => {
      const m=document.querySelector('.modal.editor');
      const body=m && m.querySelector('.ed-body');
      const head=m && m.querySelector('.ed-head');
      const foot=m && m.querySelector('.modal-foot');
      const wrap=m && m.querySelector('.lines-wrap');
      const tbl=m && m.querySelector('.lines-tbl');
      const rows=tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
      const heads=tbl ? [...tbl.querySelectorAll('thead th')] : [];
      const item=tbl && tbl.querySelector('tbody td.item-c');
      const de=document.documentElement;
      const content=document.getElementById('content');
      const rect=(e)=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,w:r.width,h:r.height};};
      return {
        viewport:{w:innerWidth,h:innerHeight},
        docOver:de.scrollWidth-de.clientWidth,
        contentOver:content?content.scrollWidth-content.clientWidth:0,
        modalOver:m?m.scrollWidth-m.clientWidth:0,
        bodyOver:body?body.scrollWidth-body.clientWidth:0,
        bodyOverflowX:body?getComputedStyle(body).overflowX:null,
        wrapOverflowX:wrap?getComputedStyle(wrap).overflowX:null,
        wrapOver:wrap?wrap.scrollWidth-wrap.clientWidth:0,
        sticky:item?getComputedStyle(item).position:null,
        head:head?rect(head):null, foot:foot?rect(foot):null,
        titleOver:m&&m.querySelector('.ed-title')?m.querySelector('.ed-title').scrollWidth-m.querySelector('.ed-title').clientWidth:0,
        gridOver:m&&m.querySelector('.ed-grid')?m.querySelector('.ed-grid').scrollWidth-m.querySelector('.ed-grid').clientWidth:0,
        rows:rows.length,
        visible:rows.map(r=>[...r.children].filter(c=>getComputedStyle(c).display!=='none').length),
        headVisible:heads.filter(c=>getComputedStyle(c).display!=='none').length,
        widths:rows.map(r=>[...r.children].map(c=>Math.round(c.getBoundingClientRect().width))),
        bucketWidths:rows.map(r=>{const b=r.querySelector('.bucket-seg');return b?Math.round(b.getBoundingClientRect().width):-1;})
      };
    })()`;

    async function verifySize(label) {
      await sleep(350);
      const m = await js(measure);
      check(`${label}: الصفحة والمحتوى والنافذة بلا تجاوز أفقي`, m && m.docOver <= 1 && m.contentOver <= 1 && m.modalOver <= 1,
        { docOver: m && m.docOver, contentOver: m && m.contentOver, modalOver: m && m.modalOver });
      check(`${label}: جسم المحرر لا يمرر أفقياً`, m && m.bodyOver <= 1 && m.bodyOverflowX === 'hidden',
        { bodyOver: m && m.bodyOver, bodyOverflowX: m && m.bodyOverflowX });
      check(`${label}: جدول الأسطر وحده يملك التمرير الداخلي`, m && (m.wrapOverflowX === 'auto' || m.wrapOverflowX === 'scroll'),
        { wrapOverflowX: m && m.wrapOverflowX, wrapOver: m && m.wrapOver });
      check(`${label}: عمود الصنف ثابت أثناء تمرير الجدول`, m && m.sticky === 'sticky', m && m.sticky);
      check(`${label}: كل الصفوف الجديدة مطابقة للترويسة`, m && m.rows === 8 && m.visible.every((n) => n === m.headVisible)
        && JSON.stringify(m.widths[0]) === JSON.stringify(m.widths[m.widths.length - 1]), m && { rows: m.rows, visible: m.visible, head: m.headVisible });
      check(`${label}: أزرار الحالة متساوية وغير مضغوطة`, m && m.bucketWidths.every((w) => w === m.bucketWidths[0] && w > 100), m && m.bucketWidths);
      check(`${label}: العناوين والشبكة بلا تداخل أفقي`, m && m.titleOver <= 1 && m.gridOver <= 1,
        { titleOver: m && m.titleOver, gridOver: m && m.gridOver });
      const fixed = await js(`(() => {
        const m=document.querySelector('.modal.editor'); const b=m.querySelector('.ed-body');
        const h=m.querySelector('.ed-head').getBoundingClientRect(); const f=m.querySelector('.modal-foot').getBoundingClientRect();
        b.scrollTop=Math.min(260, Math.max(0,b.scrollHeight-b.clientHeight));
        return {before:{head:h.top,foot:f.top},scrollTop:b.scrollTop};
      })()`);
      await sleep(120);
      const after = await js(`(() => { const m=document.querySelector('.modal.editor'); return {head:m.querySelector('.ed-head').getBoundingClientRect().top,foot:m.querySelector('.modal-foot').getBoundingClientRect().top}; })()`);
      check(`${label}: الترويسة وأزرار الحفظ ثابتتان`, fixed && Math.abs(fixed.before.head - after.head) <= 1 && Math.abs(fixed.before.foot - after.foot) <= 1,
        { before: fixed && fixed.before, after, scrollTop: fixed && fixed.scrollTop });
    }

    await verifySize('1440×900');
    win.setSize(1120, 720);
    await verifySize('1120×720');

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
