'use strict';

/* =====================================================================
   Report center — one dynamic report:
   filters, user-picked columns, current main-warehouse balance,
   moving balance, totals (qty + invoice value), PDF & Excel export.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, combo, printPreview, tableHtml } = SamUI;

  const COLUMNS = [
    { key: 'createdAt', label: 'التاريخ والوقت', on: true },
    { key: 'docNo', label: 'رقم المستند', on: true },
    { key: 'docTypeAr', label: 'نوع المستند', on: true },
    { key: 'partyName', label: 'العميل / المورد', on: true },
    { key: 'itemCode', label: 'كود الصنف', on: true },
    { key: 'itemName', label: 'اسم الصنف', on: true },
    { key: 'warehouseName', label: 'المخزن', on: true },
    { key: 'bucketAr', label: 'الحالة', on: true },
    { key: 'cartons', label: 'كراتين', on: true, num: true },
    { key: 'bags', label: 'أكياس', on: true, num: true },
    { key: 'delta', label: 'الحركة (حبة)', on: true, num: true, signed: true },
    { key: 'mainBalance', label: 'رصيد المخزن الرئيسي الحالي', on: true, num: true },
    { key: 'movingBalance', label: 'الرصيد المتحرك', on: true, num: true },
    { key: 'invoiceValue', label: 'قيمة الفاتورة', on: true },
    { key: 'note', label: 'ملاحظة', on: false }
  ];

  const DOC_LABELS = {
    opening: 'رصيد افتتاحي', purchase: 'مشتريات', sale: 'مبيعات', sale_return: 'مرتجع مبيعات',
    purchase_return: 'مرتجع مشتريات', transfer: 'تحويل مخزن', issue: 'صرف إنتاج',
    receipt: 'استلام إنتاج', bags: 'أكياس مستخدمة'
  };
  const BUCKET_LABELS = { good: 'سليم', defect: 'تالف', held: 'محجوز' };

  const state = { rows: [], totals: null, ran: false };
  let combos = null;

  /* ---------------- filter UI ---------------- */
  function initCombos() {
    if (combos) return;
    combos = {
      wh: combo(document.getElementById('fWh'), { placeholder: 'كل المخازن…', emptyText: 'لا توجد مخازن' }),
      kind: combo(document.getElementById('fKind'), { placeholder: 'كل الأنواع…', items: Object.entries(DOC_LABELS).map(([id, label]) => ({ id, label })) }),
      party: combo(document.getElementById('fParty'), { placeholder: 'كل الأطراف…', emptyText: 'لا توجد أطراف' }),
      item: combo(document.getElementById('fItem'), { placeholder: 'كل الأصناف…', emptyText: 'لا توجد أصناف' }),
      bucket: combo(document.getElementById('fBucket'), { placeholder: 'كل الحالات…', items: Object.entries(BUCKET_LABELS).map(([id, label]) => ({ id, label })) })
    };
    // the kind / bucket lists are local dictionaries: keep the typed label visible
    ['kind', 'bucket'].forEach((k) => {
      combos[k].input.addEventListener('blur', () => {
        const v = combos[k].getValue();
        const map = k === 'kind' ? DOC_LABELS : BUCKET_LABELS;
        combos[k].input.value = v ? map[v] || '' : '';
      });
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
      combos.item.setItems(items.map((i) => ({ id: i.id, label: i.name, code: i.code })));
      combos.wh.setItems(whs.map((w) => ({ id: w.id, label: w.name, code: w.kind === 'main' ? 'رئيسي' : 'فرعي' })));
      combos.party.setItems(parties.map((p) => ({ id: p.id, label: p.name, code: p.phone || '', sub: SamParties.TYPE_AR[p.type] })));
    } catch (e) { toast(e.message, 'bad'); }
  }

  function collectFilters() {
    return {
      dateFrom: document.getElementById('fFrom').value,
      dateTo: document.getElementById('fTo').value,
      warehouseId: combos.wh.getValue(),
      kind: combos.kind.getValue(),
      partyId: combos.party.getValue(),
      itemId: combos.item.getValue(),
      bucket: combos.bucket.getValue()
    };
  }

  /* ---------------- columns UI ---------------- */
  function renderColumns() {
    const wrap = document.getElementById('colsWrap');
    wrap.innerHTML = '';
    COLUMNS.forEach((c) => {
      const box = el('label', 'col-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!c.on;
      cb.addEventListener('change', () => {
        c.on = cb.checked;
        if (state.ran) renderTable();
      });
      box.append(cb, el('span', '', esc(c.label)));
      wrap.appendChild(box);
    });
  }

  const visible = () => COLUMNS.filter((c) => c.on);

  /* ---------------- run + render ---------------- */
  async function run() {
    initCombos();
    const filters = collectFilters();
    let res;
    try {
      res = await SamDB.call('reportQuery', filters);
    } catch (e) { return toast(e.message, 'bad'); }
    state.rows = res.rows;
    state.totals = res.totals;
    state.ran = true;
    renderTable();
    toast(`التقرير: ${SamDB.fmt(state.rows.length)} سطر`, 'ok');
  }

  function cellText(row, c) {
    const v = row[c.key];
    if (c.signed) {
      const n = SamDB.n(v);
      return `${n > 0 ? '+' : n < 0 ? '−' : ''}${SamDB.fmt(Math.abs(n))}`;
    }
    if (c.num) return SamDB.fmt(SamDB.n(v));
    if (v == null || v === '') return '—';
    return String(v);
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
    document.getElementById('reportEmpty').style.display = state.rows.length ? 'none' : 'block';
    document.getElementById('reportEmpty').textContent = state.rows.length ? '' : 'لا توجد حركات مطابقة للفلاتر المحددة.';

    const t = state.totals || {};
    const foot = document.getElementById('reportFoot');
    foot.innerHTML = `
      <span>عدد الأسطر: <b>${SamDB.fmt(t.rows || 0)}</b></span>
      <span>إجمالي الكمية (حبة): <b class="big">${SamDB.fmt(t.qty || 0)}</b></span>
      <span>إجمالي قيمة الفواتير: <b class="big">${SamDB.money(t.value || 0)}</b></span>
      <span class="dim">المخزن الرئيسي: ${esc(t.mainWarehouse || '—')}</span>
      ${t.nonNumeric ? `<span class="warn-note">${t.nonNumeric} قيمة فاتورة نصية غير رقمية لم تُحتسب في الإجمالي</span>` : ''}`;
  }

  /* ---------------- exports ---------------- */
  function buildCsv() {
    const cols = visible();
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => q(c.label)).join(',')];
    state.rows.forEach((r) => lines.push(cols
      .map((c) => q(c.num ? SamDB.n(r[c.key]) : r[c.key]))
      .join(',')));
    const t = state.totals || {};
    lines.push('');
    lines.push(cols.map((c) => {
      if (c.key === 'delta') return q(SamDB.n(t.qty));
      if (c.key === 'invoiceValue') return q(SamDB.n(t.value));
      if (c.key === 'createdAt') return q(`${SamDB.n(t.rows)} سطر`);
      return q('');
    }).join(','));
    return '\uFEFF' + lines.join('\r\n');
  }

  async function exportExcel() {
    if (!state.ran) return toast('شغّل التقرير أولاً', 'bad');
    const name = `SAM-Report-${new Date().toISOString().slice(0, 10)}.csv`;
    const r = await sam.app.saveFile({
      title: 'تصدير Excel',
      fileName: name,
      filters: [{ name: 'Excel (CSV)', extensions: ['csv'] }],
      content: buildCsv()
    });
    if (r && r.ok) { toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200); sam.app.openPath(r.path.replace(/[\\/][^\\/]+$/, '')); }
    else if (r && !r.canceled) toast('تعذّر حفظ الملف', 'bad');
  }

  function printReport() {
    if (!state.ran) return toast('شغّل التقرير أولاً', 'bad');
    const cols = visible();
    const rows = state.rows.map((r) => {
      const o = {};
      cols.forEach((c) => (o[c.key] = cellText(r, c)));
      return o;
    });
    const t = state.totals || {};
    const html = tableHtml(cols.map((c) => ({ key: c.key, label: c.label, align: c.num ? 'end' : undefined })), rows,
      `${SamDB.fmt(t.qty || 0)} حبة · ${SamDB.money(t.value || 0)}`);
    printPreview({
      title: 'تقرير حركة المخزون',
      subtitle: reportRangeLabel(),
      head: [
        { k: 'من', v: document.getElementById('fFrom').value || 'البداية' },
        { k: 'إلى', v: document.getElementById('fTo').value || 'اليوم' },
        { k: 'عدد الأسطر', v: SamDB.fmt(t.rows || 0) },
        { k: 'إجمالي الكمية', v: `${SamDB.fmt(t.qty || 0)} حبة` },
        { k: 'إجمالي القيمة', v: SamDB.money(t.value || 0) }
      ],
      bodyHtml: html,
      dense: true,
      landscape: true,
      footer: 'SAM Management System — تقرير حركة المخزون (الكميات بالحبة)',
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
  document.getElementById('btnPrintReport').addEventListener('click', printReport);
  document.getElementById('btnExcelReport').addEventListener('click', exportExcel);
  document.getElementById('btnAllCols').addEventListener('click', () => { COLUMNS.forEach((c) => (c.on = true)); renderColumns(); if (state.ran) renderTable(); });
  document.getElementById('btnNoCols').addEventListener('click', () => { COLUMNS.forEach((c) => (c.on = false)); renderColumns(); if (state.ran) renderTable(); });
  document.getElementById('btnResetFilters').addEventListener('click', async () => {
    ['fFrom', 'fTo'].forEach((id) => (document.getElementById(id).value = ''));
    if (combos) Object.values(combos).forEach((c) => c.setValue(null, false));
    await run();
  });

  async function load() {
    initCombos();
    renderColumns();
    await refreshComboData();
    if (!state.ran) {
      // sensible default: today
      const today = new Date().toISOString().slice(0, 10);
      document.getElementById('fFrom').value = today;
      document.getElementById('fTo').value = today;
    }
  }

  window.SamReports = { load, run, refreshComboData, buildCsv, columns: COLUMNS };
  SamUI.bus.on(() => { if (window.SamReports && document.getElementById('v-reports').classList.contains('active')) refreshComboData(); });
})();
