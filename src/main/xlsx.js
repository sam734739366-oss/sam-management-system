'use strict';

/**
 * src/main/xlsx.js — real .xlsx writer built on exceljs.
 *
 * The renderer sends plain data (columns + rows); everything here is about
 * making it look like a workbook somebody at the office would accept:
 *  - numbers stay numbers (never "1,234" text) so Excel can total them,
 *  - a frozen, coloured header row,
 *  - column widths that actually fit the Arabic captions,
 *  - right-to-left sheet view,
 *  - a totals line that only covers the columns the report shows.
 */

const fs = require('fs');

const BRAND = '2563EB';
const BRAND_DARK = '1D4ED8';
const INK = '1E293B';
const MUTED = '64748B';
const LINE = 'E2E8F0';

/** exceljs is required lazily so a missing dependency never blocks app start */
function loadExcelJS() {
  try {
    return require('exceljs');
  } catch (e) {
    throw new Error('مكتبة exceljs غير مثبتة — شغّل npm install exceljs');
  }
}

/** keep Arabic letters in one cell instead of letting Excel clip them */
function widthOf(header, values) {
  const len = (s) => String(s == null ? '' : s)
    .split('')
    .reduce((a, ch) => a + (/[^\x00-\x7F]/.test(ch) ? 1.9 : 1.05), 0);
  let max = len(header) + 2;
  for (const v of values) max = Math.max(max, len(v) + 1.5);
  return Math.max(9, Math.min(58, Math.round(max)));
}

/**
 * @param {object} spec
 * @param {string} spec.filePath        where to write
 * @param {string} [spec.sheetName]
 * @param {string} [spec.title]         big bold line at the top
 * @param {string} [spec.subtitle]
 * @param {Array<[string,string]>} [spec.meta]   key/value strip
 * @param {Array<{header:string,key:string,num?:boolean,fmt?:string,pct?:boolean}>} spec.columns
 * @param {Array<object>} spec.rows
 * @param {Array<{key:string,value:number|string,label?:string}>} [spec.totals]
 * @param {string[]} [spec.numberKeys]  extra keys forced to numeric cells
 */
async function writeWorkbook(spec) {
  const ExcelJS = loadExcelJS();
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SAM Management System';
  wb.company = 'SAM 775158678';
  wb.created = new Date();

  const ws = wb.addWorksheet(spec.sheetName || 'التقرير', {
    views: [{ state: 'frozen', ySplit: 0, rightToLeft: true }],
    /* V4: `fitToPage` alone makes Excel squeeze the WHOLE report onto ONE
       page — that is exactly what produced the tiny, washed-out Arabic the
       customer complained about. `fitToWidth: 1` + `fitToHeight: 0` means
       "one page wide, as many pages tall as needed", so the text keeps its
       size and only the number of pages grows. */
    pageSetup: {
      paperSize: 9, // A4
      orientation: spec.landscape ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      verticalCentered: false,
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 }
    }
  });

  let cursor = 1;
  const headerRow = () => cursor;

  /* ---- brand block ---- */
  if (spec.title) {
    ws.mergeCells(cursor, 1, cursor, Math.max(columns.length, 1));
    const c = ws.getCell(cursor, 1);
    c.value = spec.title;
    c.font = { name: 'Arial', size: 18, bold: true, color: { argb: BRAND_DARK } };
    c.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
    ws.getRow(cursor).height = 28;
    cursor += 1;
  }
  if (spec.subtitle) {
    ws.mergeCells(cursor, 1, cursor, Math.max(columns.length, 1));
    const c = ws.getCell(cursor, 1);
    c.value = spec.subtitle;
    c.font = { name: 'Arial', size: 12, color: { argb: MUTED } };
    c.alignment = { horizontal: 'center', readingOrder: 'rtl' };
    cursor += 1;
  }
  (spec.meta || []).forEach(([k, v]) => {
    ws.getCell(cursor, 1).value = String(k);
    ws.getCell(cursor, 1).font = { name: 'Arial', size: 10, bold: true, color: { argb: MUTED } };
    ws.mergeCells(cursor, 2, cursor, Math.max(columns.length, 2));
    const cell = ws.getCell(cursor, 2);
    cell.value = v == null ? '' : String(v);
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: INK } };
    cell.alignment = { horizontal: 'right', readingOrder: 'rtl' };
    cursor += 1;
  });
  if (spec.title || spec.subtitle || (spec.meta && spec.meta.length)) cursor += 1;

  /* ---- header row ---- */
  const headR = ws.getRow(headerRow());
  columns.forEach((col, i) => {
    const cell = headR.getCell(i + 1);
    cell.value = col.header;
    cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true, readingOrder: 'rtl' };
    cell.border = { bottom: { style: 'thin', color: { argb: BRAND_DARK } } };
  });
  headR.height = 26;
  // repeat the header on every printed page
  ws.pageSetup.printTitlesRow = `${headR.number}:${headR.number}`;

  /* ---- body ---- */
  const sample = [];
  const numFmtFor = (col) => (col.fmt || (col.pct ? '0.00%' : '#,##0'));
  for (const r of rows) {
    const row = ws.addRow([]);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const raw = r[col.key];
      if (col.num) {
        const n = raw == null || raw === '' ? null : Number(String(raw).replace(/[^\d.\-]/g, ''));
        cell.value = Number.isFinite(n) ? n : (raw == null ? null : String(raw));
        if (Number.isFinite(n)) cell.numFmt = numFmtFor(col);
        cell.alignment = { horizontal: 'left' };
      } else {
        cell.value = raw == null ? '' : String(raw);
        cell.alignment = { horizontal: 'right', readingOrder: 'rtl', wrapText: false };
      }
      cell.font = { name: 'Arial', size: 12, color: { argb: INK } };
      sample[i] = (sample[i] || []).concat([col.num ? cell.value : raw]);
    });
    row.height = 19;
  }

  /* ---- totals: only the columns the report actually shows ---- */
  const totals = spec.totals || [];
  if (totals.length) {
    const row = ws.addRow([]);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const hit = totals.find((t) => t.key === col.key);
      if (hit) {
        if (typeof hit.value === 'number') { cell.value = hit.value; cell.numFmt = numFmtFor(col); }
        else cell.value = hit.value == null ? '' : String(hit.value);
        cell.alignment = { horizontal: col.num ? 'left' : 'right' };
      } else if (i === 0) {
        cell.value = totals.find((t) => t.label) ? totals.find((t) => t.label).label : 'الإجمالي';
        cell.alignment = { horizontal: 'right', readingOrder: 'rtl' };
      }
      cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: BRAND_DARK } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EFF6FF' } };
      cell.border = { top: { style: 'thin', color: { argb: BRAND } }, bottom: { style: 'double', color: { argb: BRAND } } };
    });
    row.height = 22;
  }

  /* ---- widths + banding + autofilter ---- */
  columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width || widthOf(col.header, (sample[i] || []).slice(0, 400));
  });
  const lastRow = ws.rowCount;
  for (let r = headerRow() + 1; r <= lastRow; r++) {
    if ((r - headerRow()) % 2 === 0) {
      ws.getRow(r).eachCell((cell) => {
        if (!cell.fill || cell.fill.pattern !== 'solid') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } };
        }
        cell.border = Object.assign({ bottom: { style: 'hair', color: { argb: LINE } } }, cell.border || {});
      });
    }
  }
  ws.autoFilter = {
    from: { row: headerRow(), column: 1 },
    to: { row: headerRow(), column: Math.max(columns.length, 1) }
  };

  await wb.xlsx.writeFile(spec.filePath);
  return { path: spec.filePath, size: fs.statSync(spec.filePath).size, rows: rows.length, columns: columns.length };
}

module.exports = { writeWorkbook };
