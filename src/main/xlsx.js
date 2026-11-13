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
 *
 * Everything the customer complained about is handled here:
 *  - a sheet name Excel accepts (no ":" and no more than 31 characters),
 *  - Arabic digits ("١٢٣") stay 123 instead of becoming 0,
 *  - a broken value never becomes a fake zero,
 *  - a wide report is landscape and is NOT shrunk onto one page width,
 *  - a long text is wrapped instead of being cut,
 *  - an empty report says «لا توجد بيانات»,
 *  - a failure carries an Arabic sentence, and the file is written through
 *    a temporary name so a half-written workbook is never left behind.
 */

const fs = require('fs');

const BRAND = '2563EB';
const BRAND_DARK = '1D4ED8';
const INK = '1E293B';
const MUTED = '64748B';
const LINE = 'E2E8F0';

/** the height of one line of a report row */
const ROW_HEIGHT = 19;
/** what Excel accepts as a sheet name */
const MAX_SHEET_NAME = 31;
const ILLEGAL_SHEET_CHARS = /[\\/?*:\[\]]/g;
/** from this many columns on the sheet is wide (landscape) */
const WIDE_COLUMNS = 8;
/** ... and the same when the columns are wide enough */
const WIDE_WIDTH = 120;
/** what an A4 page takes in column units */
const ONE_PAGE_WIDTH = 100;

/** exceljs is required lazily so a missing dependency never blocks app start */
function loadExcelJS() {
  try {
    return require('exceljs');
  } catch (e) {
    throw new Error('مكتبة exceljs غير مثبتة — شغّل npm install exceljs');
  }
}

/* ------------------------------------------------------------------ *
 * the sheet name — Excel is strict about it
 * ------------------------------------------------------------------ */

/**
 * A worksheet name may not hold `: \ / ? * [ ]`, may not start or end with
 * an apostrophe and may not be longer than 31 characters. A report title
 * that breaks the rules used to throw an English exceljs error and the
 * export died — so the name is cleaned up instead.
 */
function safeSheetName(name, fallback = 'التقرير') {
  let s = String(name == null ? '' : name)
    .replace(ILLEGAL_SHEET_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  if (!s) s = fallback;
  if (s.length > MAX_SHEET_NAME) s = s.slice(0, MAX_SHEET_NAME).trim();
  return s || fallback;
}

/* ------------------------------------------------------------------ *
 * the numbers — they must stay numbers
 * ------------------------------------------------------------------ */

const AR_DIGITS = /[٠-٩]/g;
const FA_DIGITS = /[۰-۹]/g;

/**
 * Turn whatever the report carries into a real number.
 *  · Arabic-Indic (١٢٣) and Persian (۱۲۳) digits become 123
 *  · the thousands separators (1,234 / 1٬234) are dropped
 *  · an empty value stays empty
 *  · NaN / Infinity stay empty — they are NOT zero
 *  · a text that carries no number at all is kept as text (never 0)
 */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return { kind: 'empty' };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', value: v } : { kind: 'empty' };
  if (typeof v === 'boolean') return { kind: 'text', value: String(v) };
  const raw = String(v).trim();
  if (!raw) return { kind: 'empty' };
  const clean = raw
    .replace(AR_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(FA_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[,٬\s]/g, '')
    .replace(/[^\d.\-]/g, '');
  if (!/\d/.test(clean)) return { kind: 'text', value: raw };
  if (clean === '-' || clean === '.') return { kind: 'text', value: raw };
  const n = Number(clean);
  if (!Number.isFinite(n)) return { kind: 'text', value: raw };
  return { kind: 'number', value: n };
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

/** the values of one column, taken from the report — the widths need them
 *  before the sheet even exists */
function sampleOf(col, rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const raw = r[col.key];
    if (raw === null || raw === undefined) continue;
    if (col.num) {
      const n = toNumber(raw);
      out.push(n.kind === 'empty' ? '' : n.value);
    } else {
      out.push(String(raw));
    }
  }
  return out;
}

/** how many lines a text needs inside a column of that width */
function linesNeeded(text, width) {
  const len = String(text == null ? '' : text)
    .split('')
    .reduce((a, ch) => a + (/[^\x00-\x7F]/.test(ch) ? 1.9 : 1.05), 0);
  const perLine = Math.max(1, (width || 10) - 1);
  return Math.max(1, Math.ceil(len / perLine));
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
 * @param {boolean} [spec.landscape]    force the orientation (default: a wide report is landscape)
 */
async function writeWorkbook(spec) {
  const ExcelJS = loadExcelJS();
  const s = (spec && typeof spec === 'object') ? spec : {};
  const columns = Array.isArray(s.columns) ? s.columns : [];
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const meta = Array.isArray(s.meta) ? s.meta : [];
  const totals = Array.isArray(s.totals) ? s.totals : [];
  const target = String(s.filePath || '').trim();
  if (!target) throw new Error('لم يُحدَّد مسار حفظ ملف Excel');

  const sheetName = safeSheetName(s.sheetName, 'التقرير');

  /* ---- the layout is known before the sheet is created ---- */
  const hasTitle = !!s.title;
  const hasSubtitle = !!s.subtitle;
  const brandRows = (hasTitle ? 1 : 0) + (hasSubtitle ? 1 : 0) + meta.length;
  /* the brand block, then one empty line, then the header */
  const headerRow = 1 + brandRows + (brandRows ? 1 : 0);

  /* ---- the widths, so the page can be prepared for them ---- */
  const widths = columns.map((col) => {
    const w = Number(col.width);
    return w > 0 ? w : widthOf(col.header, sampleOf(col, rows));
  });
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  /* a wide report is printed sideways — and it is NOT squeezed onto one
     page width, which is what made the Arabic tiny and washed out */
  const wide = columns.length >= WIDE_COLUMNS || totalWidth > WIDE_WIDTH;
  const landscape = (s.landscape === undefined || s.landscape === null) ? wide : !!s.landscape;
  const onePage = totalWidth <= ONE_PAGE_WIDTH && !wide;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'SAM Management System';
  wb.company = 'SAM 775158678';
  wb.created = new Date();

  const ws = wb.addWorksheet(sheetName, {
    /* the header row stays on the screen while the report scrolls */
    views: [{
      state: 'frozen', xSplit: 0, ySplit: headerRow,
      topLeftCell: `A${headerRow + 1}`, activeCell: `A${headerRow + 1}`,
      rightToLeft: true
    }],
    pageSetup: {
      paperSize: 9, // A4
      orientation: landscape ? 'landscape' : 'portrait',
      /* one page wide only when the report really fits on it */
      fitToPage: onePage,
      fitToWidth: onePage ? 1 : 0,
      fitToHeight: 0,
      scale: 100,
      horizontalCentered: true,
      verticalCentered: false,
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 }
    }
  });

  let cursor = 1;

  /* ---- brand block ---- */
  if (hasTitle) {
    ws.mergeCells(cursor, 1, cursor, Math.max(columns.length, 1));
    const c = ws.getCell(cursor, 1);
    c.value = s.title;
    c.font = { name: 'Arial', size: 18, bold: true, color: { argb: BRAND_DARK } };
    c.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
    ws.getRow(cursor).height = 28;
    cursor += 1;
  }
  if (hasSubtitle) {
    ws.mergeCells(cursor, 1, cursor, Math.max(columns.length, 1));
    const c = ws.getCell(cursor, 1);
    c.value = s.subtitle;
    c.font = { name: 'Arial', size: 12, color: { argb: MUTED } };
    c.alignment = { horizontal: 'center', readingOrder: 'rtl' };
    cursor += 1;
  }
  meta.forEach(([k, v]) => {
    ws.getCell(cursor, 1).value = String(k);
    ws.getCell(cursor, 1).font = { name: 'Arial', size: 10, bold: true, color: { argb: MUTED } };
    ws.mergeCells(cursor, 2, cursor, Math.max(columns.length, 2));
    const cell = ws.getCell(cursor, 2);
    cell.value = v == null ? '' : String(v);
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: INK } };
    cell.alignment = { horizontal: 'right', readingOrder: 'rtl' };
    cursor += 1;
  });
  if (brandRows) cursor += 1;

  /* ---- header row ---- */
  const headR = ws.getRow(headerRow);
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
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;

  /* ---- body ---- */
  const numFmtFor = (col) => (col.fmt || (col.pct ? '0.00%' : '#,##0'));
  for (const r of rows) {
    const row = ws.addRow([]);
    let height = ROW_HEIGHT;
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const raw = r && typeof r === 'object' ? r[col.key] : null;
      if (col.num) {
        const n = toNumber(raw);
        if (n.kind === 'number') {
          cell.value = n.value;
          cell.numFmt = numFmtFor(col);
        } else if (n.kind === 'text') {
          /* not a number — keep it as it is, never as a fake zero */
          cell.value = n.value;
        } else {
          cell.value = null;
        }
        /* the numbers sit on the same edge as the Arabic text, but they keep
           their own direction so «-500» does not become «500-» */
        cell.alignment = { horizontal: 'right', readingOrder: 'ltr' };
      } else {
        const text = raw == null ? '' : String(raw);
        cell.value = text;
        const lines = linesNeeded(text, widths[i]);
        cell.alignment = { horizontal: 'right', readingOrder: 'rtl', wrapText: lines > 1 };
        if (lines > 1) height = Math.max(height, ROW_HEIGHT * lines);
      }
      cell.font = { name: 'Arial', size: 12, color: { argb: INK } };
    });
    row.height = height;
  }

  /* ---- an empty report says so, instead of showing a bare header ---- */
  if (!rows.length) {
    const row = ws.addRow([]);
    const last = Math.max(columns.length, 1);
    if (last > 1) ws.mergeCells(row.number, 1, row.number, last);
    const cell = row.getCell(1);
    cell.value = 'لا توجد بيانات';
    cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: MUTED } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } };
    row.height = 26;
  }

  /* ---- totals: only the columns the report actually shows ---- */
  if (totals.length && rows.length) {
    const summed = new Set(totals.map((t) => t && t.key));
    /* the caption goes to the first column that does not carry a total,
       so it is never pushed out by the numbers */
    let captionCol = columns.findIndex((c) => !summed.has(c.key));
    const caption = (totals.find((t) => t && t.label) || {}).label || 'الإجمالي';
    if (captionCol < 0) {
      /* every column is summed — the caption gets its own line above */
      const capRow = ws.addRow([]);
      if (columns.length > 1) ws.mergeCells(capRow.number, 1, capRow.number, columns.length);
      const capCell = capRow.getCell(1);
      capCell.value = caption;
      capCell.font = { name: 'Arial', size: 12, bold: true, color: { argb: BRAND_DARK } };
      capCell.alignment = { horizontal: 'right', readingOrder: 'rtl' };
      capRow.height = 22;
      captionCol = -1;
    }
    const row = ws.addRow([]);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const hit = totals.find((t) => t && t.key === col.key);
      if (hit) {
        const n = toNumber(hit.value);
        if (n.kind === 'number') {
          cell.value = n.value;
          cell.numFmt = numFmtFor(col);
        } else if (n.kind === 'text') {
          cell.value = n.value;
        } else {
          cell.value = null;
        }
        cell.alignment = { horizontal: 'right', readingOrder: 'ltr' };
      } else if (i === captionCol) {
        cell.value = caption;
        cell.alignment = { horizontal: 'right', readingOrder: 'rtl' };
      }
      cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: BRAND_DARK } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EFF6FF' } };
      cell.border = { top: { style: 'thin', color: { argb: BRAND } }, bottom: { style: 'double', color: { argb: BRAND } } };
    });
    row.height = 22;
  }

  /* ---- widths + banding + autofilter ---- */
  columns.forEach((col, i) => { ws.getColumn(i + 1).width = widths[i]; });
  const lastRow = ws.rowCount;
  for (let r = headerRow + 1; r <= lastRow; r++) {
    if ((r - headerRow) % 2 === 0) {
      /* the empty cells count too — otherwise the stripe has holes in it */
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        if (!cell.fill || cell.fill.pattern !== 'solid') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } };
        }
        cell.border = Object.assign({ bottom: { style: 'hair', color: { argb: LINE } } }, cell.border || {});
      });
    }
  }
  if (columns.length) {
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: Math.max(lastRow, headerRow), column: columns.length }
    };
  }

  /* ---- write it — through a temporary name, so a half-written workbook
         is never left where the customer expects his file ---- */
  const tmp = `${target}.part.tmp`;
  try {
    await wb.xlsx.writeFile(tmp);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* nothing to clean */ }
    /* the customer must see the file he asked for, not the temporary name */
    const reason = String((err && err.message) || err).split(tmp).join(target);
    throw new Error(`تعذّر حفظ ملف Excel: ${reason}`);
  }
  return { path: target, size: fs.statSync(target).size, rows: rows.length, columns: columns.length };
}

module.exports = { writeWorkbook, safeSheetName, toNumber };
