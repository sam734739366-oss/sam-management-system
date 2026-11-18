/**
 * tools/v9-multi-check.js — every option must be REAL.
 *
 * Three things the customer hit, proved here before they are fixed:
 *   1. the report opened on «اليوم» while his last invoice was yesterday,
 *      so the table was EMPTY — no value, no note, nothing;
 *   2. the note column was off by default, so notes never showed;
 *   3. a filter took ONE choice only — he asked to pick several.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v9-multi-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `multi-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

process.env.SAM_DATA_DIR = DATA;
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.message ? e.message : e));
  console.log('\n==== ' + pass + ' passed, ' + (fail + 1) + ' failed ====');
  app.exit(1);
});

app.whenReady().then(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
  const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
  db.init(DATA);
  session.ensureSeed();

  db.addWarehouse({ code: 'W1', name: 'الرئيسي', location: '' });
  db.addWarehouse({ code: 'W2', name: 'الفرعي', location: '' });
  const W1 = db.getMainWarehouse().id;
  const W2 = db.listWarehouses().find((w) => w.code === 'W2').id;
  const A = db.addItem({ code: 'A-1', name: 'أمبول', base_unit: 'أمبول', category: 'خام', pieces_per_carton: 1080 }, [{ warehouseId: W1, good: 9000 }]);
  const B = db.addItem({ code: 'B-1', name: 'علبة', base_unit: 'علبة', category: 'تام', pieces_per_carton: 24 }, [{ warehouseId: W1, good: 9000 }]);
  const C = db.addItem({ code: 'C-1', name: 'غطاء', base_unit: 'غطاء', category: 'خام' }, [{ warehouseId: W2, good: 9000 }]);
  const P1 = db.addParty({ name: 'عميل أول', type: 'customer' });
  const P2 = db.addParty({ name: 'عميل ثانٍ', type: 'customer' });
  const P3 = db.addParty({ name: 'مورد', type: 'supplier' });

  /* YESTERDAY — the day the customer's real invoices carry */
  const y = new Date(); y.setDate(y.getDate() - 1);
  const YEST = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const line = (item, pieces, extra = {}) => ({ item_id: item.id, bucket: 'good', pieces, cartons: 0, bags: 0, ...extra });
  const doc = (kind, ext, value, lines, extra = {}) => db.saveDocument({
    kind, external_no: ext, doc_date: YEST, invoice_value: value,
    party_id: extra.party_id || null, warehouse_id: extra.warehouse_id || W1, lines, ...extra
  });
  doc('sale', 'S-1', '412,500', [line(A, 100, { note: 'ملاحظة السطر الأول' })], { party_id: P1.id, notes: 'ملاحظة المستند' });
  doc('sale', 'S-2', '10,000', [line(B, 20)], { party_id: P2.id, notes: 'ملاحظة المستند فقط' });
  const LONG_NOTE = 'ملاحظة طويلة جداً من العميل: محمد الفقيه استلم كيساً وبقي خمسون علبة في المخزن، والسائق سيعود غداً لاستلام الباقي مع فاتورة أجور النفخ، ويرجى الاتصال قبل الوصول لأن البوابة تغلق مبكراً يوم الخميس';
  doc('sale', 'S-3', '5,000', [line(C, 30, { warehouse_id: W2 })], { party_id: P1.id, warehouse_id: W2, notes: LONG_NOTE });
  doc('purchase', 'P-1', '7,000', [line(A, 200)], { party_id: P3.id });

  /* ============ 1 — several choices in ONE filter ============ */
  const both = db.docReport({ kind: 'sale', mode: 'summary', partyId: [P1.id, P2.id] });
  eq('فلتر الطرف يقبل أكثر من طرف', both.rows.length, 3);
  const one = db.docReport({ kind: 'sale', mode: 'summary', partyId: [P2.id] });
  eq('اختيار طرف واحد يضيّق فعلاً', one.rows.length, 1);
  eq('القيمة تتبع الاختيار', one.totals.value, 10000);
  const twoItems = db.docReport({ kind: 'sale', mode: 'detail', itemId: [A.id, C.id] });
  eq('فلتر الصنف يقبل صنفين', twoItems.rows.length, 2);
  const twoCats = db.docReport({ kind: 'sale', mode: 'detail', category: ['خام', 'تام'] });
  eq('فلتر الفئة يقبل فئتين', twoCats.rows.length, 3);
  const twoWh = db.docReport({ kind: 'sale', mode: 'detail', warehouseId: [W1, W2] });
  eq('فلتر المخزن يقبل مخزنين', twoWh.rows.length, 3);
  const twoKinds = db.docReport({ kind: ['sale', 'purchase'], mode: 'summary' });
  eq('فلتر النوع يقبل نوعين', twoKinds.rows.length, 4);
  const scalar = db.docReport({ kind: 'sale', mode: 'summary', partyId: P1.id });
  eq('القيمة المفردة ما زالت تعمل', scalar.rows.length, 2);
  eq('الفارغ ما زال يعني الكل', db.docReport({ kind: 'sale', mode: 'summary', partyId: [] }).rows.length, 3);

  /* the daily report and the flow report take the same several choices */
  const dBoth = db.dailyReport({ dateFrom: YEST, dateTo: YEST, partyId: [P1.id, P2.id] });
  check('اليومي يقبل أكثر من طرف', dBoth.rows.some((r) => r.totalOut > 0), dBoth.rows.map((r) => [r.itemCode, r.totalOut]));
  const fBoth = db.stockFlowReport({ mode: 'summary', warehouseId: [W1, W2] });
  eq('حركة المخازن تقبل مخزنين', fBoth.rows.length, 2);
  const fOne = db.stockFlowReport({ mode: 'summary', warehouseId: [W2] });
  eq('حركة المخازن بمخزن واحد', fOne.rows.length, 1);

  /* ============ 2 — the screen opens with CONTENT, and the notes show ============ */
  let win;
  require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);
  win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(900);
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(1800);
  await js(`localStorage.removeItem('sam.docreports.v1')`);
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(2200);

  const opened = await js(`(() => ({
    rows: document.querySelectorAll('#drTbl tbody tr.dr-row').length,
    heads: [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim()),
    period: SamDocReports.state.period,
    noteOn: (() => { const l = [...document.querySelectorAll('#drCols .col-check')].find(x => /ملاحظة/.test(x.textContent)); return l ? l.querySelector('input').checked : null; })(),
    valueCell: (() => { const h = [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim()).indexOf('قيمة الفاتورة');
      const tr = document.querySelector('#drTbl tbody tr.dr-row'); return h >= 0 && tr ? tr.children[h].textContent.trim() : null; })()
  }))()`);
  check('التقرير يفتح وفيه صفوف (لا يفتح فارغاً)', opened && opened.rows > 0, opened && { rows: opened.rows, period: opened.period });
  check('عمود الملاحظة ظاهر افتراضياً', opened && opened.heads.indexOf('ملاحظة') >= 0 && opened.noteOn === true, opened && opened.heads);
  check('قيمة الفاتورة المنسّقة تظهر رقماً في الخلية', opened && opened.valueCell && opened.valueCell.replace(/[^\d]/g, '') === '412500', opened && opened.valueCell);

  /* the note the customer writes lives on the DOCUMENT, not on the line */
  const notes = await js(`(() => {
    const heads = [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim());
    const ni = heads.indexOf('ملاحظة'); const ei = heads.indexOf('رقم المستند');
    const rows = [...document.querySelectorAll('#drTbl tbody tr.dr-row')];
    const find = (ext) => { const tr = rows.find(r => r.children[ei].textContent.trim() === ext); return tr && ni >= 0 ? tr.children[ni].textContent.trim() : null; };
    return { s1: find('S-1'), s2: find('S-2') };
  })()`);
  check('ملاحظة السطر تظهر عند وجودها', notes && notes.s1 === 'ملاحظة السطر الأول', notes);
  check('ملاحظة المستند تظهر على أول سطر عندما لا ملاحظة للسطر', notes && notes.s2 === 'ملاحظة المستند فقط', notes);

  /* a long note stays a SMALL box — it must not blow up the row */
  const longNote = await js(`(() => {
    const heads = [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim());
    const ni = heads.indexOf('ملاحظة'); const ei = heads.indexOf('رقم المستند');
    const rows = [...document.querySelectorAll('#drTbl tbody tr.dr-row')];
    const tr = rows.find(r => r.children[ei].textContent.trim() === 'S-3');
    const plain = rows.find(r => r.children[ei].textContent.trim() === 'S-2');
    if (!tr || ni < 0) return { err: 'no row' };
    const cell = tr.children[ni].querySelector('.note-cell') || tr.children[ni];
    const cs = getComputedStyle(cell);
    return {
      fs: parseFloat(cs.fontSize),
      w: Math.round(cell.getBoundingClientRect().width),
      clamp: cs.webkitLineClamp,
      rowH: Math.round(tr.getBoundingClientRect().height),
      plainRowH: plain ? Math.round(plain.getBoundingClientRect().height) : null,
      titleLen: (cell.getAttribute('title') || '').length
    };
  })()`);
  check('خط الملاحظة صغير', longNote && longNote.fs <= 11.5, longNote && longNote.fs);
  check('مربع الملاحظة محدود العرض', longNote && longNote.w <= 195, longNote && longNote.w);
  check('الملاحظة الطويلة محشورة في سطرين', longNote && longNote.clamp === '2', longNote && longNote.clamp);
  check('الصف ذو الملاحظة الطويلة لا يتضخم',
    longNote && longNote.plainRowH && longNote.rowH <= longNote.plainRowH * 2.2,
    longNote && { rowH: longNote.rowH, plainRowH: longNote.plainRowH });
  check('النص الكامل متاح عند التحويم', longNote && longNote.titleLen > 100, longNote && longNote.titleLen);

  /* ============ 3 — picking several in the dropdown, by hand ============ */
  const picked = await js(`(() => {
    const inp = document.querySelector('#drParty input');
    inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    inp.click();
    const pop = [...document.querySelectorAll('.combo-pop')].find(p => p.style.display !== 'none');
    if (!pop) return { err: 'no pop' };
    const opts = [...pop.querySelectorAll('.combo-opt')];
    const labels = opts.map(o => o.textContent.trim());
    const first = opts.find(o => /عميل أول/.test(o.textContent));
    const second = opts.find(o => /عميل ثانٍ/.test(o.textContent));
    if (first) first.click();
    const pop2 = [...document.querySelectorAll('.combo-pop')].find(p => p.style.display !== 'none');
    const opts2 = pop2 ? [...pop2.querySelectorAll('.combo-opt')] : [];
    const second2 = opts2.find(o => /عميل ثانٍ/.test(o.textContent));
    if (second2) second2.click();
    return { labels, value: SamDocReports.state.partyId, field: document.querySelector('#drParty input').value };
  })()`);
  check('القائمة تبقى مفتوحة بعد الاختيار الأول', picked && !picked.err, picked);
  check('قائمة الطرف فيها الأطراف فعلاً لا «الكل» فقط',
    picked && Array.isArray(picked.labels) && picked.labels.some((l) => /عميل أول/.test(l)) && picked.labels.some((l) => /عميل ثانٍ/.test(l)),
    picked && picked.labels);
  check('اختياران يعيشان معاً في الفلتر', picked && Array.isArray(picked.value) && picked.value.length === 2, picked && picked.value);
  await sleep(1500);
  const afterPick = await js(`document.querySelectorAll('#drTbl tbody tr.dr-row').length`);
  eq('التقرير يعرض مستندات الطرفين معاً', afterPick, 3);
  const fieldTxt = await js(`document.querySelector('#drParty input').value`);
  check('الحقل يقول ما اختير لا «الكل»', String(fieldTxt || '').indexOf('الكل') < 0 && String(fieldTxt || '').length > 0, fieldTxt);

  /* «الكل» clears the several choices */
  await js(`(() => {
    const inp = document.querySelector('#drParty input');
    inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); inp.click();
    const pop = [...document.querySelectorAll('.combo-pop')].find(p => p.style.display !== 'none');
    const all = pop && [...pop.querySelectorAll('.combo-opt')].find(o => /الكل/.test(o.textContent));
    if (all) all.click();
    return 1;
  })()`);
  await sleep(1400);
  const cleared = await js(`(() => ({ v: SamDocReports.state.partyId, rows: document.querySelectorAll('#drTbl tbody tr.dr-row').length }))()`);
  check('«الكل» يمسح الاختيارات المتعددة', cleared && (!cleared.v || cleared.v.length === 0) && cleared.rows === 3, cleared);

  /* the paper must carry the value AND the note, on the default portrait A4 */
  await js(`document.getElementById('btnDocPrint').click()`);
  await sleep(1900);
  const paperHeads = await js(`[...document.querySelectorAll('.pv-frame .print-page table thead th')].map(t => t.textContent.trim())`);
  check('الورقة A4 العمودية تحمل قيمة الفاتورة والملاحظة',
    Array.isArray(paperHeads) && paperHeads.indexOf('قيمة الفاتورة') >= 0 && paperHeads.indexOf('ملاحظة') >= 0, paperHeads);
  const paperNote = await js(`(() => {
    const heads = [...document.querySelectorAll('.pv-frame .print-page table thead th')].map(t => t.textContent.trim());
    const ni = heads.indexOf('ملاحظة');
    const tds = [...document.querySelectorAll('.pv-frame .print-page table tbody tr')].map(tr => tr.children[ni] ? tr.children[ni].textContent.trim() : '');
    return tds.filter(Boolean);
  })()`);
  check('ملاحظة المستند مطبوعة على الورقة فعلاً', Array.isArray(paperNote) && paperNote.some((t) => /ملاحظة المستند فقط/.test(t)), paperNote);
  const paperNoteCells = await js(`[...document.querySelectorAll('.pv-frame .print-page .note-cell')].map(c => ({ fs: parseFloat(getComputedStyle(c).fontSize), len: c.textContent.trim().length }))`);
  check('خط الملاحظة على الورقة صغير', Array.isArray(paperNoteCells) && paperNoteCells.length > 0 && paperNoteCells.every((c) => c.fs <= 12), paperNoteCells);
  check('الملاحظة الطويلة كاملة على الورقة بلا قص', Array.isArray(paperNoteCells) && paperNoteCells.some((c) => c.len > 100), paperNoteCells);

  /* ---- colour that MEANS something: on the screen AND on the paper ---- */
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>/إغلاق/.test(x.textContent)); if(b) b.click(); return 1; })()`);
  await sleep(700);
  await js(`(() => { const b=[...document.querySelectorAll('#drKinds .dr-kind')].find(x=>x.dataset.kind==='warehouse_flow'); if(b) b.click(); return 1; })()`);
  await sleep(2000);
  const flowColors = await js(`(() => {
    const heads = [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim());
    const ki = heads.indexOf('نوع الحركة'); const ii = heads.indexOf('وارد'); const oi = heads.indexOf('صادر');
    const rows = [...document.querySelectorAll('#drTbl tbody tr.dr-row')];
    const col = (tr, i) => { const td = tr.children[i]; if (!td) return null; const e = td.querySelector('b, span.num') || td; return getComputedStyle(e).color; };
    return { kinds: [...new Set(rows.map(r => col(r, ki)))], inC: col(rows[0], ii), outC: col(rows[0], oi) };
  })()`);
  check('اسم المستند ملوّن بأكثر من لون حسب النوع', flowColors && flowColors.kinds.length >= 2, flowColors && flowColors.kinds);
  check('الوارد والصادر بلونين مختلفين', flowColors && flowColors.inC && flowColors.outC && flowColors.inC !== flowColors.outC, flowColors);

  await js(`document.getElementById('btnDocPrint').click()`);
  await sleep(2000);
  const paperColors = await js(`(() => {
    const sheet = document.querySelector('.pv-frame .print-page .sheet');
    if (!sheet) return { err: 'no sheet' };
    const heads = [...sheet.querySelectorAll('table thead th')].map(t => t.textContent.trim());
    const ki = heads.indexOf('نوع الحركة'); const ii = heads.indexOf('وارد');
    const rows = [...sheet.querySelectorAll('table tbody tr')];
    const col = (tr, i) => { const td = tr.children[i]; if (!td) return null; const e = td.querySelector('b, span.num') || td; return getComputedStyle(e).color; };
    return { heads, kinds: [...new Set(rows.map(r => col(r, ki)))], inC: col(rows[0], ii),
             allBlack: rows.every(r => col(r, ki) === 'rgb(0, 0, 0)') };
  })()`);
  check('عمود نوع الحركة موجود على الورقة', paperColors && paperColors.heads && paperColors.heads.indexOf('نوع الحركة') >= 0, paperColors && paperColors.heads);
  check('التلوين يصل إلى الورقة فعلاً لا أسود فقط',
    paperColors && paperColors.kinds && paperColors.kinds.length >= 2 && paperColors.allBlack === false, paperColors);
  check('لون الوارد على الورقة هو نفسه على الشاشة',
    paperColors && flowColors && paperColors.inC === flowColors.inC, { paper: paperColors && paperColors.inC, screen: flowColors && flowColors.inC });

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  try { await js(`localStorage.removeItem('sam.docreports.v1')`); } catch (e) { /* ignore */ }
  try { db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(fail ? 1 : 0);
});