'use strict';

/* =====================================================================
   Report center — V2
     · one dynamic report, buckets picked by checkbox (Good only by default)
     · IN / OUT columns, optional per-warehouse breakdown
     · footer totals sum ONLY the columns that are visible
     · real .xlsx export (exceljs in the main process), no CSV
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, combo, printPreview, tableHtml, emptyState, toggleEmpty } = SamUI;

  const COLUMNS = [
    { key: 'moveDate', label: 'التاريخ', on: true },
    { key: 'createdAt', label: 'وقت التسجيل', on: false },
    { key: 'docNo', label: 'رقم المستند', on: true },
    { key: 'docTypeAr', label: 'نوع المستند', on: true },
    { key: 'partyName', label: 'العميل / المورد', on: true },
    { key: 'itemCode', label: 'كود الصنف', on: true },
    { key: 'itemName', label: 'اسم الصنف', on: true },
    { key: 'baseUnit', label: 'الوحدة', on: true },
    { key: 'warehouseName', label: 'المخزن', on: true },
    { key: 'bucketAr', label: 'الحالة', on: true },
    { key: 'cartons', label: 'كراتين', on: false, num: true },
    { key: 'bags', label: 'أكياس', on: false, num: true },
    { key: 'inQty', label: 'وارد', on: true, num: true },
    { key: 'outQty', label: 'صادر', on: true, num: true },
    { key: 'delta', label: 'صافي الحركة', on: true, num: true, signed: true, sum: 'net' },
    { key: 'mainBalance', label: 'الرصيد الحالي', on: true, num: true },
    { key: 'movingBalance', label: 'الرصيد المتحرك', on: true, num: true },
    { key: 'invoiceValue', label: 'قيمة الفاتورة', on: true, money: true, sum: 'value' },
    { key: 'isCustomer', label: 'مادة العميل', on: false },
    { key: 'note', label: 'ملاحظة', on: false }
  ];

  /** checkboxes that decide which buckets enter the report */
  const BUCKETS = [
    { key: 'good', label: 'سليم', on: true },
    { key: 'defect', label: 'تالف', on: false },
    { key: 'held', label: 'محرز', on: false }
  ];
  const OPTIONS = [
    { key: 'byLocation', label: 'تفصيل حسب المخزن', on: false },
    { key: 'includeCustomer', label: 'ضمّ مادة العملاء (النفخ للغير)', on: false }
  ];

  /* period presets — the report is date-driven, so the period is one click */
  const PERIODS = [
    { key: 'today', label: 'اليوم' },
    { key: 'd30', label: 'آخر ٣٠ يوم' },
    { key: 'month', label: 'هذا الشهر' },
    { key: 'all', label: 'كل الفترات' }
  ];

  /** shift a YYYY-MM-DD string by whole days, keeping it local */
  function shiftDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  /** the date range each preset stands for ('' means "no bound") */
  function periodRange(key) {
    const today = SamUI.today();
    if (key === 'today') return [today, today];
    if (key === 'd30') return [shiftDays(today, -29), today];
    if (key === 'month') return [today.slice(0, 8) + '01', today];
    return ['', ''];
  }

  /** paint the period chips and reflect the current one as active */
  function renderPeriods() {
    const host = document.getElementById('periodWrap');
    if (!host) return;
    host.innerHTML = '';
    PERIODS.forEach((p) => {
      const b = el('button', `period-chip${state.period === p.key ? ' on' : ''}`, esc(p.label));
      b.type = 'button';
      b.addEventListener('click', () => {
        state.period = p.key;
        const [from, to] = periodRange(p.key);
        document.getElementById('fFrom').value = from;
        document.getElementById('fTo').value = to;
        renderPeriods();
        if (state.ran) run();
      });
      host.appendChild(b);
    });
  }

  const DOC_LABELS = {
    opening: 'رصيد افتتاحي', purchase: 'مشتريات', sale: 'مبيعات', sale_return: 'مرتجع مبيعات',
    purchase_return: 'مرتجع مشتريات', transfer: 'نقل بين المخازن', issue: 'صرف إنتاج',
    receipt: 'استلام إنتاج', bags: 'أكياس مستخدمة',
    tolling_in: 'استلام نفخ للغير', tolling_out: 'إصدار نفخ للغير', scrap: 'هدر'
  };

  const state = { rows: [], totals: null, ran: false, period: 'd30' };
  let combos = null;

  /* ---------------- filter UI ---------------- */
  function initCombos() {
    if (combos) return;
    combos = {
      wh: combo(document.getElementById('fWh'), { placeholder: 'كل المخازن…', emptyText: 'لا توجد مخازن' }),
      kind: combo(document.getElementById('fKind'), { placeholder: 'كل الأنواع…', items: Object.entries(DOC_LABELS).map(([id, label]) => ({ id, label })) }),
      party: combo(document.getElementById('fParty'), { placeholder: 'كل الأطراف…', emptyText: 'لا توجد أطراف' }),
      item: combo(document.getElementById('fItem'), { placeholder: 'كل الأصناف…', emptyText: 'لا توجد أصناف' })
    };
    combos.kind.input.addEventListener('blur', () => {
      const v = combos.kind.getValue();
      combos.kind.input.value = v ? DOC_LABELS[v] || '' : '';
    });
  }

  async function refreshComboData() {
    try {
      const [items, whs, parties] = await Promise.all([
        SamDB.call('listItems', ''),
        SamDB.call('listWarehouses'),
        SamDB.call('listParties', '')
      ]);
      initCombos();
      combos.item.setItems(items.map((i) => ({ id: i.id, label: i.name, code: i.code, sub: i.base_unit })));
      combos.wh.setItems(whs.map((w) => ({ id: w.id, label: w.name, code: w.code })));
      combos.party.setItems(parties.map((p) => ({ id: p.id, label: p.name, code: p.phone || '', sub: SamParties.TYPE_AR[p.type] })));
    } catch (e) { toast(e.message, 'bad'); }
  }

  const activeBuckets = () => BUCKETS.filter((b) => b.on).map((b) => b.key);
  const optOn = (key) => (OPTIONS.find((o) => o.key === key) || {}).on;

  function collectFilters() {
    return {
      dateFrom: document.getElementById('fFrom').value,
      dateTo: document.getElementById('fTo').value,
      warehouseId: combos.wh.getValue(),
      kind: combos.kind.getValue(),
      partyId: combos.party.getValue(),
      itemId: combos.item.getValue(),
      buckets: activeBuckets(),
      byLocation: !!optOn('byLocation'),
      includeCustomer: !!optOn('includeCustomer')
    };
  }

  /* ---------------- checkbox groups ---------------- */
  function checkGroup(host, list, onChange, extraCls) {
    host.innerHTML = '';
    list.forEach((c) => {
      const box = el('label', `col-check ${extraCls || ''}`);
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!c.on;
      cb.addEventListener('change', () => {
        c.on = cb.checked;
        onChange(c);
      });
      box.append(cb, el('span', '', esc(c.label)));
      host.appendChild(box);
    });
  }

  function renderColumns() {
    checkGroup(document.getElementById('colsWrap'), COLUMNS, () => { if (state.ran) renderTable(); });
  }
  function renderBuckets() {
    checkGroup(document.getElementById('bucketWrap'), BUCKETS, () => { if (state.ran) run(); }, 'bucket');
  }
  function renderOptions() {
    checkGroup(document.getElementById('optWrap'), OPTIONS, () => { if (state.ran) run(); });
  }

  const visible = () => COLUMNS.filter((c) => c.on);

  /* ---------------- run + render ---------------- */
  async function run() {
    initCombos();
    const filters = collectFilters();
    if (!filters.buckets.length) {
      toast('حدّد حالة واحدة على الأقل (سليم / تالف / محرز)', 'warn');
      return;
    }
    let res;
    try {
      res = await SamDB.call('reportQuery', filters);
    } catch (e) { return toast(e.message, 'bad'); }
    state.rows = res.rows;
    state.totals = res.totals;
    state.filters = filters;
    state.ran = true;
    renderTable();
    toast(`التقرير: ${SamDB.fmt(state.rows.length)} سطر · الحالات: ${res.totals.bucketLabels.join(' + ')}`, 'ok');
  }

  function cellText(row, c) {
    const v = row[c.key];
    if (c.signed) {
      const n = SamDB.n(v);
      return `${n > 0 ? '+' : n < 0 ? '−' : ''}${SamDB.fmt(Math.abs(n))}`;
    }
    if (c.money) return v == null || v === '' ? '—' : SamDB.money(v);
    if (c.num) return SamDB.fmt(SamDB.n(v));
    if (c.key === 'isCustomer') return v ? 'نعم' : '—';
    if (v == null || v === '') return '—';
    return String(v);
  }

  /** footer sums ONLY the columns that are visible right now */
  function visibleTotals() {
    const cols = visible();
    const sums = {};
    cols.forEach((c) => {
      if (!c.num && !c.money) return;
      if (c.key === 'mainBalance' || c.key === 'movingBalance') return; // balances never add up
      sums[c.key] = state.rows.reduce((a, r) => a + SamDB.n(r[c.key]), 0);
    });
    const t = state.totals || {};
    return { sums, cols, net: t.qty || 0, value: t.value || 0 };
  }

  function renderTable() {
    const cols = visible();
    const tbl = document.getElementById('reportTbl');
    tbl.innerHTML = `
      <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${state.rows.map((r) => `<tr>${cols.map((c) => {
    const cls = c.signed ? `num qty ${SamDB.n(r[c.key]) >= 0 ? 'plus' : 'minus'}` : c.num ? 'num' : '';
    return `<td class="${cls}">${esc(cellText(r, c))}</td>`;
  }).join('')}</tr>`).join('')}</tbody>`;

    const hasRows = state.rows.length > 0;
    emptyState('reportEmpty', {
      icon: 'i-chart',
      title: hasRows ? '' : 'لا توجد حركات مطابقة',
      hint: hasRows ? '' : 'غيّر الفلاتر أو حدّد حالة إضافية (تالف / محرز) ثم اضغط «تشغيل التقرير».'
    });
    toggleEmpty('reportEmpty', hasRows);

    const { sums, cols: vis } = visibleTotals();
    const t = state.totals || {};
    const parts = [];
    vis.forEach((c) => {
      if (sums[c.key] === undefined) return;
      parts.push(`<span>${esc(c.label)}: <b class="${c.key === 'delta' ? 'big' : ''}">${SamDB.fmt(sums[c.key])}</b></span>`);
    });
    const bucketNote = (t.bucketLabels || []).join(' + ');
    const unitNote = [...new Set(state.rows.map((r) => r.baseUnit).filter(Boolean))].join(' / ');
    document.getElementById('reportFoot').innerHTML = `
      <span>عدد الأسطر: <b>${SamDB.fmt(t.rows || 0)}</b></span>
      ${parts.join('')}
      <span>إجمالي القيمة: <b class="big">${SamDB.money(t.value || 0)}</b> <span class="chip sub">${esc(SamUI.CURRENCY)}</span></span>
      <span class="dim">الحالات: ${esc(bucketNote || '—')}${t.locations && t.locations.length ? ' · تفصيل المخازن مفعّل' : ''}</span>
      ${unitNote ? `<span class="dim">الوحدة: ${esc(unitNote)}</span>` : ''}
      ${t.nonNumeric ? `<span class="warn-note">${t.nonNumeric} قيمة فاتورة نصية غير رقمية لم تُحتسب</span>` : ''}`;
  }

  /* ---------------- real xlsx export ---------------- */
  async function exportExcel() {
    if (!state.ran) return toast('شغّل التقرير أولاً', 'bad');
    const cols = visible();
    const { sums } = visibleTotals();
    const rows = state.rows.map((r) => {
      const o = {};
      cols.forEach((c) => {
        o[c.key] = c.num || c.money ? SamDB.n(r[c.key]) : (c.key === 'isCustomer' ? (r[c.key] ? 'نعم' : 'لا') : (r[c.key] == null ? '' : String(r[c.key])));
      });
      return o;
    });
    const totals = cols
      .filter((c) => sums[c.key] !== undefined)
      .map((c) => ({ key: c.key, value: sums[c.key] }));
    const t = state.totals || {};

    const r = await sam.app.saveXlsx({
      fileName: `SAM-Report-${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheetName: 'حركة المخزون',
      title: 'تقرير حركة المخزون',
      subtitle: `SAM Management System — ${SamUI.WATERMARK}`,
      meta: [
        ['الفترة', `${state.filters.dateFrom || 'البداية'} → ${state.filters.dateTo || 'اليوم'}`],
        ['الحالات', (t.bucketLabels || []).join(' + ')],
        ['عدد الأسطر', SamDB.fmt(t.rows || 0)],
        ['العميل / المورد', combos && combos.party.getValue() ? (combos.party.items.find((x) => x.id === combos.party.getValue()) || {}).label : 'الكل'],
        ['الصنف', combos && combos.item.getValue() ? (combos.item.items.find((x) => x.id === combos.item.getValue()) || {}).label : 'الكل']
      ],
      columns: cols.map((c) => ({
        header: c.label,
        key: c.key,
        num: !!(c.num || c.money),
        fmt: c.money ? '#,##0.00' : '#,##0'
      })),
      rows,
      totals
    });
    if (r && r.ok) {
      toast(`تم حفظ ملف Excel: ${r.data.path} (${SamDB.fmt(r.data.rows)} سطر)`, 'ok', 5600);
      sam.app.openPath(r.data.path.replace(/[\\/][^\\/]+$/, ''));
    } else if (r && !r.canceled) {
      toast(r.error || 'تعذّر حفظ الملف', 'bad', 5200);
    }
  }

  /* ---------------- print ---------------- */
  function printReport() {
    if (!state.ran) return toast('شغّل التقرير أولاً', 'bad');
    const cols = visible();
    const { sums } = visibleTotals();
    const rows = state.rows.map((r) => {
      const o = {};
      cols.forEach((c) => (o[c.key] = cellText(r, c)));
      return o;
    });
    const t = state.totals || {};
    const html = tableHtml(cols.map((c) => ({ key: c.key, label: c.label, align: c.num || c.money ? 'end' : undefined })), rows,
      `${SamDB.fmt(sums.delta || 0)} صافي · ${SamDB.money(t.value || 0)} ${SamUI.CURRENCY}`);
    const locs = (t.locations || []);
    printPreview({
      title: 'تقرير حركة المخزون',
      subtitle: reportRangeLabel(),
      docRef: `RPT-${new Date().toISOString().slice(0, 10)}`,
      docRefLabel: 'رقم التقرير',
      head: [
        { k: 'الفترة', v: `${state.filters.dateFrom || 'البداية'} → ${state.filters.dateTo || 'اليوم'}` },
        { k: 'الحالات', v: (t.bucketLabels || []).join(' + ') },
        { k: 'عدد الأسطر', v: SamDB.fmt(t.rows || 0) }
      ],
      bodyHtml: `${html}
        ${locs.length ? `<div style="margin-top:6mm"><b>تفصيل حسب المخزن (وارد / صادر / صافي)</b>${tableHtml(
    [{ key: 'name', label: 'المخزن' }, { key: 'inQty', label: 'وارد', align: 'end' }, { key: 'outQty', label: 'صادر', align: 'end' }, { key: 'net', label: 'صافي', align: 'end' }],
    locs.map((l) => ({ name: `${l.code} — ${l.name}`, inQty: SamDB.fmt(l.inQty), outQty: SamDB.fmt(l.outQty), net: SamDB.fmt(l.net) }))
  )}</div>` : ''}`,
      dense: true,
      landscape: true,
      footer: 'SAM Management System — تقرير حركة المخزون (الكميات بالوحدة الأساسية)',
      signatures: ['المعد', 'المراجع', 'المدير']
    });
  }

  function reportRangeLabel() {
    const f = document.getElementById('fFrom').value;
    const t = document.getElementById('fTo').value;
    const parts = [];
    if (f || t) parts.push(`${f || 'البداية'} → ${t || 'اليوم'}`);
    if (combos && combos.wh.getValue()) {
      const w = combos.wh.items.find((x) => x.id === combos.wh.getValue());
      if (w) parts.push(`المخزن: ${w.label}`);
    }
    if (combos && combos.kind.getValue()) parts.push(`النوع: ${DOC_LABELS[combos.kind.getValue()]}`);
    return parts.length ? parts.join(' · ') : 'كل الفترات وكل المخازن';
  }

  /* ---------------- wiring ---------------- */
  document.getElementById('btnRunReport').addEventListener('click', run);
  // typing a date by hand means "a custom period" — no preset chip stays lit
  ['fFrom', 'fTo'].forEach((id) => document.getElementById(id).addEventListener('change', () => {
    if (state.period) { state.period = null; renderPeriods(); }
  }));
  document.getElementById('btnPrintReport').addEventListener('click', printReport);
  document.getElementById('btnExcelReport').addEventListener('click', exportExcel);
  document.getElementById('btnAllCols').addEventListener('click', () => { COLUMNS.forEach((c) => (c.on = true)); renderColumns(); if (state.ran) renderTable(); });
  document.getElementById('btnNoCols').addEventListener('click', () => { COLUMNS.forEach((c) => (c.on = false)); renderColumns(); if (state.ran) renderTable(); });
  document.getElementById('btnResetFilters').addEventListener('click', async () => {
    ['fFrom', 'fTo'].forEach((id) => (document.getElementById(id).value = ''));
    state.period = 'all';
    renderPeriods();
    if (combos) Object.values(combos).forEach((c) => c.setValue(null, false));
    BUCKETS.forEach((b) => { b.on = b.key === 'good'; });
    OPTIONS.forEach((o) => { o.on = false; });
    renderBuckets();
    renderOptions();
    await run();
  });

  async function load() {
    initCombos();
    renderColumns();
    renderBuckets();
    renderOptions();
    await refreshComboData();
    if (!state.ran) {
      // sensible default: the last 30 days (local dates, not UTC) — a stock
      // report that opens on a single day is useless on the 1st of a month.
      state.period = 'd30';
      const [from, to] = periodRange('d30');
      document.getElementById('fFrom').value = from;
      document.getElementById('fTo').value = to;
      renderPeriods();
    }
  }

  // F5 / Ctrl+N both re-run the report when this screen is on top
  SamUI.pushKeys({ refresh: () => run(), new: () => run() });

  window.SamReports = { load, run, refreshComboData, columns: COLUMNS, buckets: BUCKETS, options: OPTIONS };
  SamUI.bus.on(() => { if (window.SamReports && document.getElementById('v-reports').classList.contains('active')) refreshComboData(); });
})();
