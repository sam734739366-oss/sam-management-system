/**
 * tools/v7-xlsx-check.js — فحص تصدير Excel (.xlsx) الحقيقي.
 *
 * The customer kept saying that "exporting anything to Excel still has
 * problems and errors". This harness drives the REAL writer
 * (src/main/xlsx.js) with REAL data out of the REAL database and then
 * re-opens every produced file with exceljs to see what the customer would
 * really get.
 *
 * It never opens a native save dialog: the writer is called directly, and
 * the IPC handler is exercised with a stubbed `dialog.showSaveDialog`.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v7-xlsx-check.js
 * Exit code 0 = every check passed.
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'v7-xlsx');
const DATA = path.join(ROOT, '.tmp', 'v7-xlsx-data');

/* the database must be told where to live BEFORE it is opened */
process.env.SAM_DATA_DIR = DATA;

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const { writeWorkbook } = require(path.join(ROOT, 'src', 'main', 'xlsx.js'));
const ExcelJS = require('exceljs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`;
  console.log(line);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TODAY = new Date().toISOString().slice(0, 10);
const AR = /[؀-ۿ]/;

/* =====================================================================
 * helpers
 * ===================================================================== */

/** open a produced file the way Excel would and hand back the sheet */
async function readSheet(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  return { wb, ws, wbSheets: wb.worksheets.map((w) => w.name) };
}

/** the values of a row, as plain JS */
function valuesOf(row) {
  const out = [];
  for (let i = 1; i <= row.cellCount; i++) {
    const v = row.getCell(i).value;
    out.push(v && typeof v === 'object' && 'result' in v ? v.result : v);
  }
  return out;
}

/** the row that carries the header captions */
function headerRowOf(ws, firstHeader) {
  let found = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (found) return;
    if (String(row.getCell(1).value || '').trim() === String(firstHeader).trim()) found = row;
  });
  return found;
}

/** the rows under the header, split into the body and the totals line */
function splitRows(ws, head) {
  const under = [];
  ws.eachRow({ includeEmpty: false }, (row) => { if (row.number > (head ? head.number : 0)) under.push(row); });
  const last = under[under.length - 1];
  const isTotals = last && /^الإجمالي/.test(String(valuesOf(last)[0] || '').trim());
  return { body: isTotals ? under.slice(0, -1) : under, totals: isTotals ? last : null, under };
}

function isZip(file) {
  if (!fs.existsSync(file)) return false;
  const b = fs.readFileSync(file);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
}

/* =====================================================================
 * 1. the data
 * ===================================================================== */

let SEED = null;

function seed() {
  /* the app creates one default warehouse on the first run — the test data
     replaces it so the report has exactly the warehouses it expects */
  dbMod.listWarehouses().forEach((w) => { try { dbMod.deleteWarehouse(w.id); } catch (e) { /* keep it */ } });
  const w1 = dbMod.addWarehouse({ code: 'W01', name: 'المخزن الرئيسي', location: 'صنعاء' });
  const w2 = dbMod.addWarehouse({ code: 'W02', name: 'مخزن الفرع', location: 'صنعاء' });
  const customer = dbMod.addParty({ name: 'مؤسسة النور التجارية', phone: '777000111', type: 'customer' });

  const oil = dbMod.addItem({ code: 'A-001', name: 'زيت طعام', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 12 },
    [{ warehouseId: w1.id, good: 100 }]);
  const sugar = dbMod.addItem({ code: 'A-002', name: 'سكر ناعم', base_unit: 'كيس', category: 'منتج', pieces_per_carton: 10 },
    [{ warehouseId: w1.id, good: 60 }]);
  const tea = dbMod.addItem({ code: 'A-003', name: 'شاي أحمر', base_unit: 'علبة', category: 'منتج', pieces_per_carton: 8 },
    [{ warehouseId: w2.id, good: 40 }]);
  const raw = dbMod.addItem({ code: 'R-001', name: 'مادة خام بPET', base_unit: 'حبة', category: 'مادة خام', pieces_per_carton: 1000 }, []);
  const bottle = dbMod.addItem({ code: 'P-001', name: 'قارورة 500 مل', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 24 }, []);
  const cap = dbMod.addItem({ code: 'P-002', name: 'غطاء بلاستيكي', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 100 }, []);
  const label = dbMod.addItem({ code: 'P-003', name: 'ملصقprinted لاصق', base_unit: 'حبة', category: 'منتج', pieces_per_carton: 50 }, []);

  /* a purchase and a sale, so the daily report really has traffic */
  dbMod.saveDocument({
    kind: 'purchase', doc_date: TODAY, party_id: customer.id, warehouse_id: w1.id,
    lines: [{ item_id: oil.id, pieces: 50, bucket: 'good' }]
  });
  dbMod.saveDocument({
    kind: 'sale', doc_date: TODAY, party_id: customer.id, warehouse_id: w1.id,
    lines: [{ item_id: oil.id, pieces: 20, bucket: 'good' }]
  });

  /* a production report, so the gap report has rows (and a long list) */
  dbMod.saveReceipt({
    doc_date: TODAY, raw_item_id: raw.id, carton_no: 'كرتون-1', carton_pieces: 300,
    lines: [
      { item_id: bottle.id, good: 90, defect_cans: 3, defect_ampoules: 2, breaks: 1 },
      { item_id: cap.id, good: 95, defect_cans: 1, breaks: 0 },
      { item_id: label.id, good: 88, defect_ampoules: 4, breaks: 2 }
    ]
  });

  SEED = { w1, w2, customer, oil, sugar, tea, raw, bottle };
  return SEED;
}

/* =====================================================================
 * 2. the three real callers, rebuilt on the main side
 * ===================================================================== */

/** what src/renderer/js/daily.js sends */
function dailySpec(res) {
  const whs = res.warehouses;
  const rows = res.rows;
  const columns = [
    { header: 'كود الصنف', key: 'code' },
    { header: 'اسم الصنف', key: 'name' },
    { header: 'الوحدة', key: 'unit' }
  ];
  whs.forEach((w) => {
    columns.push({ header: `${w.name} — وارد اليوم`, key: `w${w.id}in`, num: true, fmt: '#,##0' });
    columns.push({ header: `${w.name} — صادر اليوم`, key: `w${w.id}out`, num: true, fmt: '#,##0' });
    columns.push({ header: `${w.name} — المتبقي`, key: `w${w.id}bal`, num: true, fmt: '#,##0' });
  });
  columns.push({ header: 'إجمالي المتبقي', key: 'total', num: true, fmt: '#,##0' });

  const data = rows.map((r) => {
    const o = { code: r.itemCode, name: r.itemName, unit: r.baseUnit };
    let total = 0;
    whs.forEach((w) => {
      const c = r.cells[w.id] || {};
      o[`w${w.id}in`] = Number(c.inQty || 0);
      o[`w${w.id}out`] = Number(c.outQty || 0);
      o[`w${w.id}bal`] = Number(c.balance || 0);
      total += Number(c.balance || 0);
    });
    o.total = total;
    return o;
  });

  const totals = [];
  whs.forEach((w) => {
    totals.push({ key: `w${w.id}in`, value: whs.reduce((a, x) => a + Number((res.warehouseTotals[x.id] || {}).inQty || 0), 0) });
    totals.push({ key: `w${w.id}out`, value: whs.reduce((a, x) => a + Number((res.warehouseTotals[x.id] || {}).outQty || 0), 0) });
    totals.push({ key: `w${w.id}bal`, value: whs.reduce((a, x) => a + Number((res.warehouseTotals[x.id] || {}).balance || 0), 0) });
  });
  totals.push({ key: 'total', value: whs.reduce((a, w) => a + Number((res.warehouseTotals[w.id] || {}).balance || 0), 0) });

  return {
    fileName: `SAM-Daily-${res.date}.xlsx`,
    sheetName: 'التقرير اليومي',
    title: 'التقرير اليومي',
    subtitle: 'SAM Management System — شمس',
    meta: [
      ['التاريخ', res.date],
      ['الحالات', (res.bucketLabels || []).join(' + ')],
      ['المخازن', whs.map((w) => w.name).join(' · ')],
      ['عدد الأصناف', String(rows.length)],
      ['إجمالي المتبقي في كل المخازن', String(totals.find((t) => t.key === 'total').value)]
    ],
    columns,
    rows: data,
    totals
  };
}

/** what src/renderer/js/production.js sends */
function gapSpec(res, from, to) {
  const t = res.totals || {};
  const rows = res.rows || [];
  return {
    fileName: `SAM-Production-Gap-${TODAY}.xlsx`,
    sheetName: 'عجز وتالف الإنتاج',
    title: 'تقرير عجز وتالف الإنتاج',
    subtitle: 'SAM Management System — شمس',
    meta: [
      ['الفترة', `${from || 'البداية'} → ${to || 'اليوم'}`],
      ['عدد التقارير', String(t.rows || 0)],
      ['إجمالي العجز', String(t.shortage || 0)],
      ['إجمالي الزيادة', String(t.surplus || 0)],
      ['إجمالي التالف', String(t.defect || 0)]
    ],
    columns: [
      { header: 'التاريخ', key: 'docDate' },
      { header: 'رقم التقرير', key: 'docNo' },
      { header: 'رقم الكرتون', key: 'cartonNo' },
      { header: 'المادة الخام', key: 'rawItem' },
      { header: 'حبات الكرتون', key: 'cartonPieces', num: true },
      { header: 'الإنتاج', key: 'produced', num: true },
      { header: 'العجز', key: 'shortage', num: true },
      { header: 'الزيادة', key: 'surplus', num: true },
      { header: 'تالف علب', key: 'defectCans', num: true },
      { header: 'تالف أمبولة', key: 'defectAmpoules', num: true },
      { header: 'الكسر', key: 'breaks', num: true },
      { header: 'الأصناف', key: 'items' }
    ],
    rows: rows.map((x) => ({
      docDate: x.docDate, docNo: x.docNo, cartonNo: x.cartonNo || '',
      rawItem: x.rawItem, cartonPieces: Number(x.cartonPieces || 0), produced: Number(x.produced || 0),
      shortage: Number(x.shortage || 0), surplus: Number(x.surplus || 0),
      defectCans: Number(x.defectCans || 0), defectAmpoules: Number(x.defectAmpoules || 0),
      breaks: Number(x.breaks || 0), items: x.items || ''
    })),
    totals: [
      { key: 'produced', value: rows.reduce((a, x) => a + Number(x.produced || 0), 0) },
      { key: 'shortage', value: Number(t.shortage || 0) },
      { key: 'surplus', value: Number(t.surplus || 0) },
      { key: 'defectCans', value: Number(t.defect || 0) }
    ]
  };
}

/** what src/renderer/js/reports.js sends */
function reportSpec(res) {
  const cols = res.columns || [];
  const rows = (res.rows || []).map((r) => {
    const o = {};
    cols.forEach((c) => {
      if (c.num || c.money) o[c.key] = Number(r[c.key] || 0);
      else if (c.key === 'isCustomer') o[c.key] = r[c.key] ? 'نعم' : 'لا';
      else o[c.key] = r[c.key] == null ? '' : String(r[c.key]);
    });
    return o;
  });
  const NO_SUM = ['mainBalance', 'movingBalance', 'balance', 'minAlert', 'maxDefect', 'alert', 'alertKind', 'invoiceValue'];
  const totals = [];
  cols.forEach((c) => {
    if (!c.num && !c.money) return;
    if (NO_SUM.indexOf(c.key) >= 0) return;
    totals.push({ key: c.key, value: rows.reduce((a, r) => a + Number(r[c.key] || 0), 0) });
  });
  return {
    fileName: `SAM-${res.title.replace(/\s+/g, '-')}-${TODAY}.xlsx`,
    sheetName: res.title.slice(0, 28),
    title: res.title,
    subtitle: 'SAM Management System — شمس',
    meta: [
      ['الفترة', `${TODAY} → ${TODAY}`],
      ['النطاق', 'كل الأصناف'],
      ['عدد الأسطر', String(rows.length)]
    ],
    columns: cols.map((c) => ({
      header: c.label,
      key: c.key,
      num: !!(c.num || c.money),
      fmt: c.money ? '#,##0.00' : '#,##0'
    })),
    rows,
    totals
  };
}

/* =====================================================================
 * 3. the checks
 * ===================================================================== */

async function checkDaily() {
  const res = dbMod.dailyReport({ date: TODAY });
  const spec = dailySpec(res);
  const file = path.join(OUT, 'daily.xlsx');
  const info = await writeWorkbook({ ...spec, filePath: file });

  check('the daily export is written', isZip(file), info);
  check('the daily export counts its rows', info.rows === spec.rows.length, info);

  const { ws, wbSheets } = await readSheet(file);
  check('the daily export has one sheet', wbSheets.length === 1, wbSheets);
  check('the daily sheet keeps its Arabic name', wbSheets[0] === 'التقرير اليومي', wbSheets);

  const head = headerRowOf(ws, 'كود الصنف');
  check('the daily sheet has a header row', !!head, head && head.number);
  if (head) {
    const headers = valuesOf(head);
    check('the daily headers are in the report order',
      headers.slice(0, spec.columns.length).join('|') === spec.columns.map((c) => c.header).join('|'),
      headers);
    check('every daily header cell is styled',
      spec.columns.every((c, i) => {
        const cell = head.getCell(i + 1);
        return !!cell.font && cell.font.bold === true && !!cell.fill && cell.fill.pattern === 'solid';
      }),
      spec.columns.map((c, i) => ({ h: c.header, bold: head.getCell(i + 1).font && head.getCell(i + 1).font.bold })));
  }

  const { body, totals } = splitRows(ws, head);
  check('the daily export has one row per item', body.length === spec.rows.length, { got: body.length, want: spec.rows.length });

  const first = body[0];
  if (first) {
    const vals = valuesOf(first);
    check('the Arabic item name survives the export', String(vals[1] || '').trim() === spec.rows[0].name, vals[1]);
    const numCell = first.getCell(4);
    check('a quantity is a number, not text', typeof numCell.value === 'number', { value: numCell.value, type: typeof numCell.value });
    check('a quantity carries a number format', !!numCell.numFmt, numCell.numFmt);
    check('the numbers sit on the same side as the Arabic text',
      numCell.alignment && numCell.alignment.horizontal === first.getCell(2).alignment.horizontal,
      { num: numCell.alignment, text: first.getCell(2).alignment });
  }

  check('the totals line is written', !!totals, totals && valuesOf(totals).slice(0, 4));
  const totalSpec = spec.totals.find((t) => t.key === 'total');
  if (totals && totalSpec) {
    const idx = spec.columns.findIndex((c) => c.key === 'total') + 1;
    const cell = totals.getCell(idx);
    check('the grand total carries the right number', cell.value === totalSpec.value, { got: cell.value, want: totalSpec.value });
    check('the grand total is a number', typeof cell.value === 'number', typeof cell.value);
    check('the totals line says what it is', /^الإجمالي/.test(String(valuesOf(totals)[0] || '').trim()), valuesOf(totals)[0]);
  }

  check('the sheet reads from the right', !!(ws.views && ws.views[0] && ws.views[0].rightToLeft), ws.views);
  check('the header row stays frozen', !!(ws.views && ws.views[0] && ws.views[0].state === 'frozen' && ws.views[0].ySplit >= (head ? head.number : 1)),
    { views: ws.views, header: head && head.number });
  check('every column has a width of its own',
    spec.columns.every((c, i) => ws.getColumn(i + 1).width > 0), spec.columns.map((c, i) => ws.getColumn(i + 1).width));
  check('the title is merged over the whole table',
    (ws.model.merges || []).includes(`A1:${ws.getColumn(spec.columns.length).letter}1`),
    ws.model.merges);

  check('a wide report is exported in landscape', ws.pageSetup.orientation === 'landscape', ws.pageSetup.orientation);
  check('a wide report is not shrunk to fit one page',
    !(ws.pageSetup.fitToPage && ws.pageSetup.fitToWidth === 1), ws.pageSetup);
}

async function checkProductionGap() {
  const res = dbMod.productionGapReport({ dateFrom: TODAY, dateTo: TODAY });
  const spec = gapSpec(res, TODAY, TODAY);
  const file = path.join(OUT, 'production-gap.xlsx');
  await writeWorkbook({ ...spec, filePath: file });

  check('the production export is written', isZip(file), file);
  const { ws, wbSheets } = await readSheet(file);
  check('the production sheet keeps its Arabic name', wbSheets[0] === 'عجز وتالف الإنتاج', wbSheets);

  const head = headerRowOf(ws, 'التاريخ');
  check('the production sheet has a header row', !!head, head && head.number);
  if (head) {
    const headers = valuesOf(head);
    check('the production headers are in the report order',
      headers.slice(0, spec.columns.length).join('|') === spec.columns.map((c) => c.header).join('|'), headers);
  }
  const { body } = splitRows(ws, head);
  check('the production export has one row per report', body.length === spec.rows.length, { got: body.length, want: spec.rows.length });

  if (body.length) {
    const row = body[0];
    const vals = valuesOf(row);
    check('the Arabic raw material survives the export', String(vals[3] || '').trim() === spec.rows[0].rawItem, vals[3]);
    const qty = row.getCell(5);
    check('the carton quantity is a number', typeof qty.value === 'number', qty.value);
    /* the «الأصناف» column carries a long list — it must not be cut off */
    const itemsCell = row.getCell(12);
    const itemsText = String(itemsCell.value || '');
    const colWidth = ws.getColumn(12).width || 10;
    const lines = Math.ceil(itemsText.length / Math.max(1, colWidth - 1));
    check('the long list of items is wrapped, not cut', itemsCell.alignment && itemsCell.alignment.wrapText === true,
      { text: itemsText, alignment: itemsCell.alignment });
    check('the row of the long list is tall enough', (row.height || 0) >= 19 * lines,
      { height: row.height, want: 19 * lines, len: itemsText.length, width: colWidth });
  }
}

async function checkReport() {
  const res = dbMod.runReport({ report: 'movements', dateFrom: TODAY, dateTo: TODAY });
  const spec = reportSpec(res);
  const file = path.join(OUT, 'movements.xlsx');
  await writeWorkbook({ ...spec, filePath: file });

  check('the report export is written', isZip(file), file);
  const { ws, wbSheets } = await readSheet(file);
  check('the report sheet keeps its Arabic name', wbSheets[0] === 'حركة المخزون', wbSheets);

  const head = headerRowOf(ws, 'التاريخ');
  check('the report sheet has a header row', !!head, head && head.number);
  if (head) {
    const headers = valuesOf(head);
    check('the report headers are in the report order',
      headers.slice(0, spec.columns.length).join('|') === spec.columns.map((c) => c.header).join('|'), headers);
  }
  const { body } = splitRows(ws, head);
  check('the report export has one row per movement', body.length === spec.rows.length, { got: body.length, want: spec.rows.length });
  check('the report export is wide enough to be read', ws.pageSetup.orientation === 'landscape', ws.pageSetup.orientation);
}

async function checkEmpty() {
  const file = path.join(OUT, 'empty.xlsx');
  await writeWorkbook({
    filePath: file,
    sheetName: 'تقرير فارغ',
    title: 'تقرير بلا بيانات',
    columns: [{ header: 'كود الصنف', key: 'code' }, { header: 'اسم الصنف', key: 'name' }],
    rows: [],
    totals: []
  });
  check('an empty export is still a valid file', isZip(file), file);
  const { ws } = await readSheet(file);
  const text = [];
  ws.eachRow({ includeEmpty: false }, (row) => { text.push(valuesOf(row).join(' ')); });
  check('an empty export says there is no data', /لا توجد بيانات/.test(text.join(' | ')), text);
  check('an empty export still shows its headers', text.some((t) => /كود الصنف/.test(t)), text);
}

async function checkEdges() {
  /* a sheet name Excel would refuse */
  const bad = path.join(OUT, 'bad-name.xlsx');
  let err = null;
  try {
    await writeWorkbook({
      filePath: bad,
      sheetName: 'تقرير: الحركة',
      title: 'اختبار',
      columns: [{ header: 'كود', key: 'code' }],
      rows: [{ code: 'A-1' }]
    });
  } catch (e) { err = e; }
  check('an illegal sheet name does not break the export', !err && isZip(bad), err && err.message);
  if (!err && isZip(bad)) {
    const { wbSheets } = await readSheet(bad);
    check('the sheet name is legal for Excel', !/[?:\\\/\[\]*]/.test(wbSheets[0] || '') && (wbSheets[0] || '').length > 0, wbSheets);
  }

  /* a sheet name that is far too long */
  const long = path.join(OUT, 'long-name.xlsx');
  let err2 = null;
  try {
    await writeWorkbook({
      filePath: long,
      sheetName: 'تقرير طويل جداً يتجاوز الحد المسموح به في إكسل',
      columns: [{ header: 'كود', key: 'code' }],
      rows: [{ code: 'A-1' }]
    });
  } catch (e) { err2 = e; }
  check('a very long sheet name does not break the export', !err2 && isZip(long), err2 && err2.message);
  if (!err2 && isZip(long)) {
    const { wbSheets } = await readSheet(long);
    check('the sheet name fits the Excel limit', (wbSheets[0] || '').length <= 31, wbSheets);
  }

  /* Arabic-Indic digits must not turn into zero */
  const digits = path.join(OUT, 'digits.xlsx');
  await writeWorkbook({
    filePath: digits,
    sheetName: 'أرقام',
    columns: [{ header: 'الكمية', key: 'q', num: true }],
    rows: [{ q: '١٢٣' }, { q: '٤٥٦' }]
  });
  const { ws: dws } = await readSheet(digits);
  const dv = [];
  dws.eachRow({ includeEmpty: false }, (row) => { if (row.number > 1) dv.push(row.getCell(1).value); });
  check('Arabic-Indic digits keep their value', dv[0] === 123 && dv[1] === 456, dv);

  /* a broken value must never become a zero */
  const broken = path.join(OUT, 'broken.xlsx');
  await writeWorkbook({
    filePath: broken,
    sheetName: 'قيم',
    columns: [{ header: 'الكمية', key: 'q', num: true }, { header: 'ملاحظة', key: 'note' }],
    rows: [{ q: NaN, note: 'س' }, { q: undefined, note: '' }, { q: Infinity, note: '∞' }, { q: 'ليس رقماً', note: 'نص' }]
  });
  const { ws: bws } = await readSheet(broken);
  const bv = [];
  bws.eachRow({ includeEmpty: false }, (row) => { if (row.number > 1) bv.push(row.getCell(1).value); });
  check('a broken quantity never becomes a zero', !bv.some((v) => v === 0), bv);
  check('a broken quantity is left empty', bv.slice(0, 3).every((v) => v === null || v === undefined || v === ''), bv);
  check('a text that is not a number is kept as text', bv[3] === 'ليس رقماً', bv);

  /* the striped rows must not have holes where a cell is empty */
  const banded = [];
  bws.eachRow({ includeEmpty: false }, (row) => { if (row.number > 1 && (row.number - 1) % 2 === 0) banded.push(row); });
  let holes = 0;
  banded.forEach((row) => {
    for (let i = 1; i <= 2; i++) {
      const c = row.getCell(i);
      if (!c.fill || c.fill.pattern !== 'solid') holes++;
    }
  });
  check('the striped rows have no holes', holes === 0, { banded: banded.map((r) => r.number), holes });

  /* the failure of the writer must be an Arabic sentence */
  let err3 = null;
  try {
    await writeWorkbook({ filePath: path.join(OUT, 'no-such-folder', 'x.xlsx'), sheetName: 'س', columns: [{ header: 'أ', key: 'a' }], rows: [{ a: 1 }] });
  } catch (e) { err3 = e; }
  check('a failed export carries an Arabic sentence', !!err3 && AR.test(err3.message || ''), err3 && err3.message);

  /* a narrow report stays portrait */
  const narrow = path.join(OUT, 'narrow.xlsx');
  await writeWorkbook({
    filePath: narrow,
    sheetName: 'بسيط',
    columns: [{ header: 'كود', key: 'code' }, { header: 'اسم', key: 'name' }],
    rows: [{ code: 'A-1', name: 'صنف' }]
  });
  const { ws: nws } = await readSheet(narrow);
  check('a narrow report stays portrait', nws.pageSetup.orientation === 'portrait', nws.pageSetup.orientation);

  /* a negative number must not lose its sign to the RTL direction */
  const neg = path.join(OUT, 'negative.xlsx');
  await writeWorkbook({
    filePath: neg,
    sheetName: 'سالب',
    columns: [{ header: 'الرصيد', key: 'q', num: true }],
    rows: [{ q: -500 }]
  });
  const { ws: ngs } = await readSheet(neg);
  let negCell = null;
  ngs.eachRow({ includeEmpty: false }, (row) => { if (row.number > 1 && !negCell) negCell = row.getCell(1); });
  check('a negative number keeps its value', negCell && negCell.value === -500, negCell && negCell.value);
  check('a negative number keeps its sign on the left', negCell && negCell.alignment && negCell.alignment.readingOrder === 'ltr',
    negCell && negCell.alignment);

  /* no leftovers next to the exported file */
  const leftovers = fs.readdirSync(OUT).filter((f) => /\.tmp$|\.part$|\.partial$/i.test(f));
  check('no half-written file is left behind', leftovers.length === 0, leftovers);
}

/* =====================================================================
 * 4. the IPC handler (with a stubbed dialog — never a native one)
 * ===================================================================== */

async function checkIpc() {
  let win = null;
  require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);
  win = new BrowserWindow({
    width: 900, height: 600, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadURL('about:blank');
  await sleep(300);

  const jsCall = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (e) {
      return { ok: false, error: 'الاستدعاء رماه استثناء: ' + (e && e.message ? e.message : String(e)) };
    }
  };

  const realDialog = dialog.showSaveDialog;
  let captured = null;
  const target = path.join(OUT, 'from-ipc');

  try {
    /* 1. the user typed a name without an extension */
    dialog.showSaveDialog = async (w, opts) => {
      captured = { window: w, opts };
      return { canceled: false, filePath: target };
    };
    let res = await jsCall(
      `sam.app.saveXlsx(${JSON.stringify({ fileName: 'SAM-تقرير: اليوم.xlsx', sheetName: 'تقرير', title: 'تقرير', columns: [{ header: 'كود', key: 'code' }], rows: [{ code: 'A-1' }] })})`
    );
    check('the IPC export succeeds', res && res.ok === true, res);
    check('the exported file ends with .xlsx', fs.existsSync(target + '.xlsx'), fs.readdirSync(OUT).filter((f) => f.startsWith('from-ipc')));
    check('the dialog offers the xlsx filter',
      !!(captured && captured.opts && captured.opts.filters && captured.opts.filters.some((f) => (f.extensions || []).includes('xlsx'))), captured && captured.opts);
    check('the default name is legal for Windows',
      !!(captured && captured.opts && captured.opts.defaultPath && !/[<>:"/\\|?*]/.test(captured.opts.defaultPath)), captured && captured.opts.defaultPath);
    check('the default name keeps the .xlsx extension',
      !!(captured && captured.opts && /\.xlsx$/i.test(captured.opts.defaultPath || '')), captured && captured.opts.defaultPath);

    /* 2. the user cancelled */
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    res = await jsCall(
      `sam.app.saveXlsx(${JSON.stringify({ fileName: 'x.xlsx', columns: [{ header: 'كود', key: 'code' }], rows: [] })})`
    );
    check('a cancelled export says nothing was saved', res && res.ok === false && res.canceled === true, res);

    /* 3. the export fails — the message must be Arabic */
    const badDir = path.join(OUT, 'no-such-folder');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(badDir, 'x.xlsx') });
    res = await jsCall(
      `sam.app.saveXlsx(${JSON.stringify({ fileName: 'x.xlsx', columns: [{ header: 'كود', key: 'code' }], rows: [{ code: 'A' }] })})`
    );
    check('a failed export is reported, not thrown', res && res.ok === false, res);
    check('the failure carries an Arabic sentence', !!(res && AR.test(res.error || '')), res && res.error);
  } finally {
    dialog.showSaveDialog = realDialog;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  }
}

/* =====================================================================
 * 5. run
 * ===================================================================== */

let cleanedUp = false;
async function shutdown(code = 0) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { dbMod.close(); } catch (e) {}
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) console.log('the failures:\n  - ' + failures.join('\n  - '));
  app.exit(code);
}
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(fail ? 1 : 0); } });

app.whenReady().then(async () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    dbMod.init(DATA);
    session.ensureSeed();
    seed();

    console.log('\n===== 1. the daily report =====');
    await checkDaily();
    console.log('\n===== 2. the production gap report =====');
    await checkProductionGap();
    console.log('\n===== 3. the report centre =====');
    await checkReport();
    console.log('\n===== 4. the empty and the broken cases =====');
    await checkEmpty();
    await checkEdges();
    console.log('\n===== 5. the IPC handler =====');
    await checkIpc();
  } catch (e) {
    console.log('FATAL: ' + (e && e.stack ? e.stack : e));
    fail++;
  }
  shutdown(fail ? 1 : 0);
}).catch((e) => { console.log('FATAL: ' + (e && e.stack ? e.stack : e)); shutdown(1); });
