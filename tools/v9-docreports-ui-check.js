/**
 * tools/v9-docreports-ui-check.js — the new screen, seen in the real window.
 *
 * The customer deleted the old catalogue in his mind before I deleted it in
 * the code: «أزعجتني ولم تفدني بشيء». What he must find instead is one screen
 * that answers a question per document kind, totals in the unit of the thing,
 * the number HE wrote on the paper, and a preview that is the paper.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v9-docreports-ui-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v9ui-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
const digits = (s) => String(s || '').replace(/[^\d]/g, '');

process.env.SAM_DATA_DIR = DATA;

/* a missing element must fail the run, never hang it */
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.message ? e.message : e));
  console.log('\n==== ' + pass + ' passed, ' + (fail + 1) + ' failed ====');
  app.exit(1);
});

app.whenReady().then(async () => {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'images'), { recursive: true });
  /* a 1×1 png so the picture column has something real to show */
  fs.writeFileSync(path.join(DATA, 'images', 'b.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
  const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
  db.init(DATA);
  session.ensureSeed();

  db.addWarehouse({ code: 'W1', name: 'الرئيسي', location: '' });
  const W1 = db.getMainWarehouse().id;
  const A = db.addItem({ code: 'A-1', name: 'أمبول زجاج', base_unit: 'أمبول', category: 'خام', pieces_per_carton: 1080 }, [{ warehouseId: W1, good: 5000 }]);
  const B = db.addItem({ code: 'B-1', name: 'علبة تام', base_unit: 'علبة', category: 'منتج تام', pieces_per_carton: 24, image: 'b.png' }, [{ warehouseId: W1, good: 1000 }]);
  const C = db.addItem({ code: 'C-1', name: 'غطاء', base_unit: 'غطاء', category: 'خام' }, [{ warehouseId: W1, good: 1000 }]);
  /* an item that only SITS in the warehouse: a balance and no movement in the
     period. The customer asked for it to stay out unless he asks for it. */
  db.addItem({ code: 'D-1', name: 'صنف راكد', base_unit: 'حبة', category: 'خام' }, [{ warehouseId: W1, good: 77 }]);
  const P1 = db.addParty({ name: 'عميل الرياض', phone: '0555', type: 'customer' });
  const today = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const line = (item, pieces, extra = {}) => ({ item_id: item.id, bucket: 'good', pieces, cartons: 0, bags: 0, ...extra });
  const doc = (kind, ext, value, lines, extra = {}) => db.saveDocument({
    kind, external_no: ext, doc_date: today, invoice_value: value,
    party_id: P1.id, warehouse_id: W1, lines, ...extra
  });
  doc('sale', 'EXT-100', '20000', [line(A, 1000), line(B, 192, { cartons: 8 })]);
  doc('sale', 'EXT-050', '5000', [line(C, 300)]);
  doc('purchase', 'P-9', '7000', [line(A, 2000)]);

  let win;
  require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);

  win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(900);
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(1800);
  /* a fresh run must start from a fresh choice — but ONLY the choice of this
     screen: the customer's other preferences (packs, signatures) are his */
  await js(`localStorage.removeItem('sam.docreports.v1')`);

  /* ---- 1 — the old catalogue is gone, the new screen is here ---- */
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(1200);
  const screen = await js(`(() => ({
    active: document.getElementById('v-reports').classList.contains('active'),
    oldCards: !!document.getElementById('rptCards'),
    oldBtn: !!document.getElementById('btnOpenReports'),
    kinds: [...document.querySelectorAll('#drKinds .dr-kind')].map(b => b.textContent.trim()),
    hasTable: !!document.getElementById('drTbl'),
    hasTotals: !!document.getElementById('drTotals')
  }))()`);
  check('شاشة التقارير تفتح', screen && screen.active === true, screen && screen.active);
  check('بطاقات التقارير القديمة اختفت', screen && screen.oldCards === false && screen.oldBtn === false,
    screen && { cards: screen.oldCards, btn: screen.oldBtn });
  check('أنواع التقارير الثلاثة عشر موجودة', screen && screen.kinds.length === 13, screen && screen.kinds);
  check('جدول وصندوق إجماليات موجودان', screen && screen.hasTable && screen.hasTotals, screen);

  /* ---- 2 — the sales report, detailed then summary ---- */
  await js(`[...document.querySelectorAll('#drKinds .dr-kind')].find(b => b.dataset.kind === 'sale').click()`);
  await sleep(1400);
  const detail = await js(`(() => ({
    rows: document.querySelectorAll('#drTbl tbody tr.dr-row').length,
    heads: [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim()),
    firstCell: (document.querySelector('#drTbl tbody tr.dr-row td') || {}).textContent,
    pics: document.querySelectorAll('#drTbl tbody img').length,
    totals: document.getElementById('drTotals').textContent,
    mode: (document.querySelector('#drMode .on') || {}).dataset ? document.querySelector('#drMode .on').dataset.mode : null
  }))()`);
  check('التفصيلي: سطر لكل صنف (٣ أسطر)', detail && detail.rows === 3, detail && detail.rows);
  check('العمود الأول هو رقم المستند', detail && detail.heads[0] === 'رقم المستند', detail && detail.heads[0]);
  check('الرقم الخارجي هو المعروض أولاً', detail && String(detail.firstCell || '').trim() === 'EXT-050', detail && detail.firstCell);
  check('صورة الصنف تظهر في التقرير', detail && detail.pics >= 1, detail && detail.pics);
  check('الإجماليات تذكر الأمبول', detail && detail.totals.indexOf('أمبول') >= 0, detail && detail.totals);
  check('إجمالي الأمبول ١٠٠٠', detail && digits(detail.totals).indexOf('1000') >= 0, detail && detail.totals);
  check('إجمالي العلب ١٩٢', detail && digits(detail.totals).indexOf('192') >= 0, detail && detail.totals);
  check('إجمالي الأغطية ٣٠٠', detail && digits(detail.totals).indexOf('300') >= 0, detail && detail.totals);
  check('إجمالي النقد ٢٥٠٠٠ ريال', detail && digits(detail.totals).indexOf('25000') >= 0 && detail.totals.indexOf('ريال') >= 0, detail && detail.totals);

  await js(`[...document.querySelectorAll('#drMode button')].find(b => b.dataset.mode === 'summary').click()`);
  await sleep(1200);
  const summary = await js(`document.querySelectorAll('#drTbl tbody tr.dr-row').length`);
  check('الملخّص: سطر لكل مستند (٢)', summary === 2, summary);

  /* the choice survives a reload — it is stored, not a one-shot */
  await js(`location.reload()`);
  await sleep(2200);
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(1400);
  const kept = await js(`(() => ({
    mode: (document.querySelector('#drMode .on') || {}).dataset ? document.querySelector('#drMode .on').dataset.mode : null,
    rows: document.querySelectorAll('#drTbl tbody tr.dr-row').length
  }))()`);
  check('اختيار الملخّص محفوظ بعد إعادة التحميل', kept && kept.mode === 'summary' && kept.rows === 2, kept);

  /* ---- 3 — «الكل» is a visible choice in every filter ---- */
  const alls = await js(`(() => {
    const ids = ['drParty', 'drItem', 'drWh', 'drCategory'];
    const out = {};
    ids.forEach(id => {
      const host = document.getElementById(id);
      const inp = host && host.querySelector('input');
      out[id] = inp ? inp.value : null;
    });
    return out;
  })()`);
  for (const id of ['drParty', 'drItem', 'drWh', 'drCategory']) {
    check(`«الكل» ظاهرة في ${id}`, alls && String(alls[id] || '').indexOf('الكل') >= 0, alls && alls[id]);
  }
  const optAll = await js(`(() => {
    const inp = document.querySelector('#drParty input');
    inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    inp.click();
    const pop = [...document.querySelectorAll('.combo-pop')].find(p => p.style.display !== 'none');
    const opts = pop ? [...pop.querySelectorAll('.combo-opt .label')].map(n => n.textContent.trim()) : [];
    return opts;
  })()`);
  check('«الكل» خيار حقيقي في القائمة المنسدلة', Array.isArray(optAll) && optAll.indexOf('الكل') >= 0, optAll);
  await js(`document.body.click()`);

  /* ---- 4 — the daily report gains the opening switch and the unit totals ---- */
  await js(`document.querySelector('.nav-item[data-view=daily]').click()`);
  await sleep(1500);
  const daily = await js(`(() => ({
    opening: !!document.getElementById('dOpening'),
    openingChecked: document.getElementById('dOpening') ? document.getElementById('dOpening').checked : null,
    kind: !!document.getElementById('dKind'),
    party: !!document.getElementById('dParty'),
    item: !!document.getElementById('dItem'),
    category: !!document.getElementById('dCategory'),
    unitTotals: !!document.getElementById('dUnitTotals'),
    unitText: document.getElementById('dUnitTotals') ? document.getElementById('dUnitTotals').textContent : ''
  }))()`);
  check('اليومي: مربع إظهار الرصيد الافتتاحي موجود', daily && daily.opening === true, daily);
  check('اليومي: الافتتاحي مطفأ افتراضياً', daily && daily.openingChecked === false, daily && daily.openingChecked);
  check('اليومي: فلاتر النوع والطرف والصنف والفئة', daily && daily.kind && daily.party && daily.item && daily.category, daily);
  check('اليومي: إجماليات بالوحدة', daily && daily.unitTotals === true && daily.unitText.indexOf('أمبول') >= 0, daily && daily.unitText);

  /* ---- 4b — an item that did not move stays out; the total mode shows the total ---- */
  const idleHidden = await js(`document.getElementById('dailyTbl').textContent.indexOf('صنف راكد') >= 0`);
  check('اليومي: صنف لم يتحرك في الفترة لا يظهر', idleHidden === false, idleHidden);
  await js(`(() => { const cb=document.getElementById('dItemTotal'); cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
  await sleep(1000);
  const totalMode = await js(`(() => {
    const heads=[...document.querySelectorAll('#dailyTbl thead th')].map(t=>t.textContent.trim());
    const rows=[...document.querySelectorAll('#dailyTbl tbody tr')];
    const first=rows[0]?[...rows[0].children].map(td=>td.textContent.trim()):[];
    return { heads, hasBalance: heads.indexOf('المتبقي')>=0, cells: first.length, first };
  })()`);
  check('اليومي: وضع «إجمالي المتبقي فقط» يعرض عمود المتبقي', totalMode && totalMode.hasBalance === true, totalMode && totalMode.heads);
  check('اليومي: وضع الإجمالي يعرض أكثر من الاسم والوحدة', totalMode && totalMode.cells >= 5, totalMode && totalMode.cells);
  await js(`(() => { const cb=document.getElementById('dAllItems'); cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
  await sleep(1000);
  const idleShown = await js(`document.getElementById('dailyTbl').textContent.indexOf('صنف راكد') >= 0`);
  check('اليومي: «إظهار كل الأصناف» يُظهر الراكد عند الطلب', idleShown === true, idleShown);

  /* ---- 5 — the preview IS the paper: 5mm, centred, bold, A4 portrait ---- */
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(1200);
  await js(`document.getElementById('btnDocPrint').click()`);
  await sleep(1800);
  const paper = await js(`(() => {
    const page = document.querySelector('.pv-frame .print-page');
    if (!page) return { open: false };
    const sheet = page.querySelector('.sheet');
    const cell = page.querySelector('table td');
    const cs = sheet ? getComputedStyle(sheet) : null;
    const cc = cell ? getComputedStyle(cell) : null;
    return {
      open: true,
      land: page.classList.contains('land'),
      padTop: cs ? parseFloat(cs.paddingTop) : null,
      padRight: cs ? parseFloat(cs.paddingRight) : null,
      align: cc ? cc.textAlign : null,
      weight: cc ? cc.fontWeight : null,
      size: cc ? parseFloat(cc.fontSize) : null,
      width: sheet ? sheet.getBoundingClientRect().width : null
    };
  })()`);
  check('المعاينة تفتح', paper && paper.open === true, paper);
  check('A4 عمودي افتراضياً (بلا أفقي)', paper && paper.land === false, paper && paper.land);
  check('هوامش صغيرة جداً ≈ ٥ملم', paper && paper.padTop >= 17 && paper.padTop <= 21 && paper.padRight >= 17 && paper.padRight <= 21,
    paper && { top: paper.padTop, right: paper.padRight });
  check('الكتابة وسطية', paper && paper.align === 'center', paper && paper.align);
  check('الكتابة غامقة وواضحة', paper && Number(paper.weight) >= 600, paper && paper.weight);
  /* the preview must wear the PAPER's own type size (10pt), not the screen's
     10.5pt — this is the number that proves the two surfaces are one */
  check('المعاينة تلبس خط الورقة نفسه (١٠نقطة)', paper && paper.size >= 13 && paper.size <= 13.7, paper && paper.size);
  /* the customer asked for the invoice value in so many words — it must never
     be the column the paper budget drops */
  const paperHeads = await js(`[...document.querySelectorAll('.pv-frame .print-page table thead th')].map(t=>t.textContent.trim())`);
  check('قيمة الفاتورة تظهر على الورقة A4 العمودية', Array.isArray(paperHeads) && paperHeads.indexOf('قيمة الفاتورة') >= 0, paperHeads);

  /* ---- 6 — A5 is a real paper, half the width, and the caption says so ---- */
  await js(`(() => { const b=[...document.querySelectorAll('.pv-bar .btn')].find(x=>x.textContent.indexOf('إغلاق')>=0); if(b) b.click(); return 1; })()`);
  await sleep(600);
  await js(`[...document.querySelectorAll('#drPaper button')].find(b=>b.dataset.paper==='a5').click()`);
  await sleep(600);
  await js(`document.getElementById('btnDocPrint').click()`);
  await sleep(1600);
  const a5 = await js(`(() => {
    const p = document.querySelector('.pv-frame .print-page');
    const s = p && p.querySelector('.sheet');
    return { a5: p ? p.classList.contains('a5') : null, w: s ? s.offsetWidth : null,
             cap: (document.querySelector('.pv-cap') || {}).textContent || '' };
  })()`);
  check('A5 ورقة حقيقية بعرض ١٤٨ملم', a5 && a5.a5 === true && a5.w >= 555 && a5.w <= 565, a5);
  check('ترويسة المعاينة تقول A5', a5 && a5.cap.indexOf('A5') >= 0, a5 && a5.cap);

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  /* leave the customer's profile as it was: the A5 choice of this check must
     not follow him into his own program */
  try { await js(`localStorage.removeItem('sam.docreports.v1')`); } catch (e) { /* ignore */ }
  try { db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(fail ? 1 : 0);
});