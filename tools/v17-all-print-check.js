/**
 * tools/v17-all-print-check.js — every paper variant keeps its footer clear.
 *
 * Drives the real renderer with a temporary database. It measures A4/A5,
 * portrait/landscape, dense, signed, direct and half-sheet documents in both
 * preview and print media, then exercises the real half-permit preview so an
 * oversized permit cannot silently lose rows or its footer.
 * PDF content assertions require Python with PyMuPDF (`fitz`) installed.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v17-all-print-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v17-print-${process.pid}`);
const OUT = path.join(ROOT, '.tmp', 'v17print');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

const specs = [
  { id: 'a4-portrait-short', rows: 3, paper: 'a4', landscape: false, dense: false, sigs: [] },
  { id: 'a4-portrait-long', rows: 65, paper: 'a4', landscape: false, dense: false, sigs: [] },
  { id: 'a4-portrait-signed-long', rows: 55, paper: 'a4', landscape: false, dense: false, sigs: ['ONE', 'TWO', 'THREE'] },
  { id: 'a4-portrait-dense-long', rows: 75, paper: 'a4', landscape: false, dense: true, sigs: [] },
  { id: 'a4-landscape-short', rows: 3, paper: 'a4', landscape: true, dense: true, sigs: [] },
  { id: 'a4-landscape-long', rows: 45, paper: 'a4', landscape: true, dense: true, sigs: [] },
  { id: 'a5-portrait-short', rows: 3, paper: 'a5', landscape: false, dense: false, sigs: [] },
  { id: 'a5-portrait-long', rows: 40, paper: 'a5', landscape: false, dense: false, sigs: [] },
  { id: 'a5-landscape-short', rows: 3, paper: 'a5', landscape: true, dense: true, sigs: [] },
  { id: 'a5-landscape-long', rows: 30, paper: 'a5', landscape: true, dense: true, sigs: [] },
  { id: 'direct-a4-long', rows: 65, paper: 'a4', landscape: false, dense: false, sigs: [], direct: true },
  { id: 'direct-a4-landscape-long', rows: 45, paper: 'a4', landscape: true, dense: true, sigs: [], direct: true },
  { id: 'direct-a5-long', rows: 40, paper: 'a5', landscape: false, dense: false, sigs: [], direct: true }
];

function options(spec) {
  return {
    title: 'فحص كل المطبوعات',
    subtitle: spec.id,
    docRef: spec.id,
    head: [{ k: 'الفترة', v: 'كل الفترات' }],
    dense: !!spec.dense,
    landscape: !!spec.landscape,
    paper: spec.paper,
    half: !!spec.half,
    kind: spec.sigs && spec.sigs.length ? 'invoice' : 'report',
    __sigs: spec.sigs || [],
    signatures: spec.sigs || [],
    footer: 'FOOTER_MARKER',
    bodyHtml: `<table class="tbl" style="width:100%;table-layout:fixed"><thead><tr><th>ID</th><th>VALUE</th></tr></thead><tbody>${
      Array.from({ length: spec.rows }, (_, i) => `<tr><td>ROW${String(i + 1).padStart(3, '0')}</td><td>${1000 + i}</td></tr>`).join('')
    }</tbody></table>`
  };
}

function pdfWords(file) {
  const script = `import fitz,sys,json
d=fitz.open(sys.argv[1])
out=[]
for p in d:
    words=[{'x1':w[0],'y1':w[1],'x2':w[2],'y2':w[3],'text':w[4]} for w in p.get_text('words')]
    out.append({'w':p.rect.width,'h':p.rect.height,'words':words})
print(json.dumps(out))`;
  const raw = cp.execFileSync('python', ['-c', script, file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw.trim().split(/\r?\n/).filter((line) => line.startsWith('[')).pop());
}

async function stageAndPdf(win, js, id) {
  await js(`(() => {
    const root = document.querySelector('.pv-pages');
    if (!root) return 0;
    const clone = root.cloneNode(true);
    clone.style.transform = '';
    document.getElementById('printHost').replaceChildren(clone);
    document.body.classList.add('is-printing');
    return 1;
  })()`);
  const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, marginType: 'none' });
  const file = path.join(OUT, id + '.pdf');
  fs.writeFileSync(file, data);
  await js(`document.body.classList.remove('is-printing'); document.getElementById('printHost').replaceChildren();`);
  return pdfWords(file);
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
      width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f4f7fb',
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

    const debuggerApi = win.webContents.debugger;
    debuggerApi.attach('1.3');

    const measure = `(() => {
      const root = document.getElementById('probe') || document.getElementById('printHost');
      const s = root.matches('.sheet') ? root : root.querySelector('.sheet');
      const b = s && s.querySelector('.doc-body');
      const f = s && s.querySelector('.doc-foot');
      if (!s || !b || !f) return { error: 'missing sheet/body/footer' };
      const sr = s.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const fr = f.getBoundingClientRect();
      const cells = [...b.querySelectorAll('*')].map(e => e.getBoundingClientRect());
      const bodyBottom = cells.reduce((max, r) => Math.max(max, r.bottom), br.bottom);
      const cs = getComputedStyle(s), cf = getComputedStyle(f);
      return {
        sheetClass: s.className,
        parentClass: s.parentElement.className,
        position: cf.position,
        display: cs.display,
        direction: cs.flexDirection,
        gap: +(fr.top - bodyBottom).toFixed(1),
        inset: +(sr.bottom - fr.bottom).toFixed(1),
        overflow: cs.overflow,
        scrollH: s.scrollHeight,
        clientH: s.clientHeight,
        clipped: s.scrollHeight > s.clientHeight + 2,
        rows: b.querySelectorAll('tbody tr').length,
        footerText: f.textContent.includes('FOOTER_MARKER'),
        horizontalOverflow: Math.max(0, s.scrollWidth - s.clientWidth)
      };
    })()`;

    for (const spec of specs) {
      const opts = options(spec);
      await js(`(() => {
        document.getElementById('printHost').replaceChildren();
        document.getElementById('probe')?.remove();
        document.body.classList.remove('is-printing');
        const o = ${JSON.stringify(opts)};
        const sheet = SamUI.sheet(o);
        if (${!!spec.direct}) {
          sheet.id = 'probe';
          document.body.appendChild(sheet);
        } else {
          const root = SamUI.el('div', 'pv-pages'); root.id = 'probe';
          const frame = SamUI.el('div', ${JSON.stringify(`pv-frame${spec.landscape ? ' land' : ''}${spec.paper === 'a5' ? ' a5' : ''}`)});
          const page = SamUI.el('div', ${JSON.stringify(`print-page${spec.landscape ? ' land' : ''}${spec.paper === 'a5' ? ' a5' : ''}`)});
          page.appendChild(sheet); frame.appendChild(page); root.appendChild(frame); document.body.appendChild(root);
        }
        return 1;
      })()`);
      await sleep(140);
      const preview = await js(measure);
      if (!spec.direct) {
        check(`${spec.id}: التذييل داخل التدفق وفي مسافة آمنة`, preview && preview.position === 'static'
          && preview.display === 'flex' && preview.direction === 'column'
          && preview.gap >= 6 && preview.inset >= 16 && preview.inset <= 24
          && preview.footerText && !preview.clipped && preview.horizontalOverflow <= 1, preview);
      }

      await js(`(() => {
        const n = document.getElementById('probe');
        const c = n.cloneNode(true); c.style.transform = '';
        document.getElementById('printHost').replaceChildren(c);
        document.body.classList.add('is-printing');
        n.remove();
        return 1;
      })()`);
      await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(120);
      const printed = await js(measure);
      check(`${spec.id}: وضع الطباعة لا يعيد التداخل أو القص`, printed && printed.position === 'static'
        && printed.gap >= 6 && printed.inset >= 16 && printed.inset <= 24
        && printed.footerText && !printed.clipped && printed.horizontalOverflow <= 1, printed);
      await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { media: '' });
      await js(`document.body.classList.remove('is-printing'); document.getElementById('printHost').replaceChildren();`);
    }

    /* A short document must keep its footer at the physical paper bottom in
       the real PDF, not only in the screen preview. */
    const shortDoc = options({ id: 'pdf-short-a4', rows: 3, paper: 'a4', landscape: false, dense: false, sigs: [] });
    await js(`(() => { SamUI.printPreview(${JSON.stringify(shortDoc)}); return 1; })()`);
    await sleep(350);
    const shortPdf = await stageAndPdf(win, js, 'pdf-short-a4');
    const shortFooter = shortPdf.flatMap((p) => p.words.filter((w) => w.text.includes('FOOTER_MARKER')));
    const shortPage = shortPdf[0];
    check('PDF القصير يضع التذييل قرب حافة الورقة', shortPdf.length === 1 && shortFooter.length === 1
      && shortFooter[0].y2 > shortPage.h - 45, { pages: shortPdf.length, footer: shortFooter, pageH: shortPage && shortPage.h });
    await js(`(() => { const b=[...document.querySelectorAll('.pv-bar button')].find(x=>x.textContent.includes('إغلاق')); if(b) b.click(); return 1; })()`);
    await sleep(100);

    /* Fit is per permit: one long permit must not force the short permits to
       full A4, and removing signatures must be allowed to restore two-up. */
    const shortPermitA = options({ id: 'permit-short-a', rows: 4, paper: 'a4', landscape: false, dense: false, sigs: ['ONE', 'TWO', 'THREE'], half: true });
    shortPermitA.kind = 'v17_test';
    const longSignature = 'توقيع طويل جداً '.repeat(24);
    const middlePermit = options({ id: 'permit-long', rows: 1, paper: 'a4', landscape: false, dense: false, sigs: [longSignature], half: true });
    middlePermit.kind = 'v17_test';
    middlePermit.bodyHtml = `<table class="tbl" style="width:100%;table-layout:fixed"><thead><tr><th>ID</th><th>VALUE</th></tr></thead><tbody><tr><td>ROW001</td><td>1000</td></tr></tbody></table><div style="height:75mm"></div>`;
    const shortPermitB = options({ id: 'permit-short-b', rows: 4, paper: 'a4', landscape: false, dense: false, sigs: ['ONE', 'TWO', 'THREE'], half: true });
    shortPermitB.kind = 'v17_test';
    await js(`(() => { SamUI.printPreview({ title: 'multi-permit', half: true, pages: ${JSON.stringify([shortPermitA, middlePermit, shortPermitB])} }); return 1; })()`);
    await sleep(500);
    const multiSummary = await js(`[...document.querySelectorAll('.pv .sheet')].map(s => ({ id:(s.querySelector('.t-sub')||{}).textContent, half:s.classList.contains('half'), clipped:s.scrollHeight>s.clientHeight+2, rows:s.querySelectorAll('tbody tr').length, sigs:s.querySelectorAll('.sig').length, sigText:[...s.querySelectorAll('.sig .nm')].map(x=>x.textContent.length) }))`);
    const multiLong = multiSummary.find((s) => s.id === 'permit-long');
    const multiShorts = multiSummary.filter((s) => s.id !== 'permit-long');
    check('التصريح الطويل وحده يتحول إلى A4', multiLong && !multiLong.half && !multiLong.clipped, multiSummary);
    check('التصاريح القصيرة تبقى بنصف ورقة', multiShorts.length === 2 && multiShorts.every((s) => s.half && !s.clipped), multiSummary);

    const multiPdf = await stageAndPdf(win, js, 'multi-permit');
    const pdfRows = multiPdf.flatMap((p) => p.words.filter((w) => /^ROW\d+$/.test(w.text)));
    const pdfFooters = multiPdf.flatMap((p) => p.words.filter((w) => w.text.includes('FOOTER_MARKER')));
    const overlap = multiPdf.some((p) => {
      const rows = p.words.filter((w) => /^ROW\d+$/.test(w.text));
      const foot = p.words.filter((w) => w.text.includes('FOOTER_MARKER'));
      return rows.some((r) => foot.some((f) => f.y1 < r.y2 && f.y2 > r.y1));
    });
    check('PDF متعدد التصاريح يحفظ كل الصفوف والتذييل', pdfRows.length === 9 && pdfFooters.length === 3 && !overlap,
      { pages: multiPdf.length, rows: pdfRows.length, footers: pdfFooters.length, overlap });

    await js(`[...document.querySelectorAll('.pv-sig-chip[aria-pressed="true"]')].forEach(b => b.click())`);
    await sleep(350);
    const rebuilt = await js(`[...document.querySelectorAll('.pv .sheet')].map(s => ({ id:(s.querySelector('.t-sub')||{}).textContent, half:s.classList.contains('half'), clipped:s.scrollHeight>s.clientHeight+2 }))`);
    check('إزالة التوقيعات تعيد حساب ملاءمة كل تصريح', rebuilt.find((s) => s.id === 'permit-long')?.half === true, rebuilt);
    await js(`(() => { const b=[...document.querySelectorAll('.pv-bar button')].find(x=>x.textContent.includes('إغلاق')); if(b) b.click(); return 1; })()`);
    await sleep(100);

    /* A late company logo can make a near-limit permit taller after the first
       measurement. The preview must recheck once the image and fonts settle. */
    const logoPermit = options({ id: 'permit-late-logo', rows: 14, paper: 'a4', landscape: false, dense: false, sigs: ['ONE', 'TWO', 'THREE'], half: true });
    logoPermit.kind = 'v17_test';
    await js(`(() => { SamUI.printPreview(${JSON.stringify(logoPermit)}); return 1; })()`);
    await sleep(150);
    await js(`(() => {
      const mast = document.querySelector('.pv .doc-mast');
      const box = document.createElement('div');
      box.className = 'm-company';
      const img = document.createElement('img');
      img.className = 'co-logo';
      img.alt = '';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000"><rect width="400" height="1000" fill="#1d4ed8"/></svg>');
      box.appendChild(img);
      if (mast) mast.appendChild(box);
      return 1;
    })()`);
    await sleep(500);
    const logoSheet = await js(`(() => { const s=document.querySelector('.pv .sheet'); const img=s&&s.querySelector('.co-logo'); return s?{half:s.classList.contains('half'),clipped:s.scrollHeight>s.clientHeight+2,rows:s.querySelectorAll('tbody tr').length,logoLoaded:!!(img&&img.complete&&img.naturalWidth)}:null; })()`);
    check('تحميل الشعار المتأخر لا يقطع التصريح', logoSheet && !logoSheet.clipped && logoSheet.rows === 14 && logoSheet.logoLoaded, logoSheet);
    await js(`(() => { const b=[...document.querySelectorAll('.pv-bar button')].find(x=>x.textContent.includes('إغلاق')); if(b) b.click(); return 1; })()`);
    await sleep(100);

    /* The real preview must promote an oversized half-permit to a full A4
       page instead of hiding rows and the footer behind overflow:hidden. */
    const longPermit = options({ id: 'half-long-signed', rows: 22, paper: 'a4', landscape: false, dense: false, sigs: ['ONE', 'TWO', 'THREE'], half: true });
    longPermit.kind = 'v17_test';
    await js(`(() => { SamUI.printPreview(${JSON.stringify(longPermit)}); return 1; })()`);
    await sleep(450);
    const permit = await js(measure.replace("document.getElementById('probe') || document.getElementById('printHost')", "document.querySelector('.pv') || document.getElementById('probe') || document.getElementById('printHost')"));
    check('التصريح الطويل لا يفقد صفوفاً أو تذييلاً', permit && permit.rows === 22 && permit.footerText && !permit.clipped, permit);
    check('التصريح الطويل يتحول إلى صفحة كاملة عند الحاجة', permit && !permit.sheetClass.includes('half') && !permit.parentClass.includes('perm'), permit);
    await js(`(() => { const b=[...document.querySelectorAll('.pv-bar button')].find(x=>x.textContent.includes('إغلاق')); if(b) b.click(); return 1; })()`);
    await sleep(100);

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
