'use strict';

/* =====================================================================
   Daily report — V3
     · what entered each warehouse today (دخل اليوم)
     · what is still left in it (المتبقي)
     · the grand remaining across ALL warehouses (إجمالي المتبقي)
   The table is item × warehouse: two columns per warehouse, so one
   screen answers the question "where is my stock right now?" without
   any spreadsheet gymnastics. A per-warehouse summary sits under it,
   and the grand total closes the screen.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, combo, printPreview, emptyState, toggleEmpty } = SamUI;

  const BUCKETS = [
    { key: 'good', label: 'سليم', on: true },
    { key: 'defect', label: 'تالف', on: false },
    { key: 'held', label: 'محرز', on: false }
  ];

  const state = {
    res: null,
    ran: false,
    whFilter: null,      // null = every warehouse
    showAll: false,      // show items with no movement and no balance
    includeCustomer: false
  };

  let whCombo = null;

  /* ---------------- filters ---------------- */
  function initUi() {
    if (!whCombo) {
      whCombo = combo(document.getElementById('dWh'), {
        placeholder: 'كل المخازن…',
        emptyText: 'لا توجد مخازن',
        onChange: (v) => {
          state.whFilter = v;
          if (state.ran) render();
        }
      });
      whCombo.setValue(null, false);
    }
    const host = document.getElementById('dBuckets');
    if (host && !host.childElementCount) {
      BUCKETS.forEach((b) => {
        const box = el('label', 'col-check bucket');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = b.on;
        cb.addEventListener('change', () => {
          b.on = cb.checked;
          if (state.ran) run();
        });
        box.append(cb, el('span', '', esc(b.label)));
        host.appendChild(box);
      });
    }
  }

  function activeBuckets() {
    return BUCKETS.filter((b) => b.on).map((b) => b.key);
  }

  /* ---------------- run ---------------- */
  async function run() {
    initUi();
    const buckets = activeBuckets();
    if (!buckets.length) return toast('حدّد حالة واحدة على الأقل (سليم / تالف / محرز)', 'warn');
    const date = document.getElementById('dDate').value || SamUI.today();
    let res;
    try {
      res = await SamDB.call('dailyReport', { date, buckets, includeCustomer: state.includeCustomer });
    } catch (e) { return toast(e.message, 'bad'); }

    state.res = res;
    state.ran = true;
    state.whFilter = whCombo ? whCombo.getValue() : null;

    // the combo lists the warehouses of this report (they can change any time)
    if (whCombo) {
      whCombo.setItems((res.warehouses || []).map((w) => ({ id: w.id, label: w.name, code: w.code })));
      whCombo.setValue(state.whFilter, false);
    }

    render();
    toast(`تقرير ${res.date}: ${SamDB.fmt(visibleRows().length)} صنف · المتبقي في كل المخازن ${SamDB.fmt(res.grand.balance)}`, 'ok');
  }

  /** the warehouses this report shows (all of them, or the one picked) */
  function shownWarehouses() {
    const res = state.res;
    if (!res) return [];
    const all = res.warehouses || [];
    if (!state.whFilter) return all;
    return all.filter((w) => w.id === state.whFilter);
  }

  /** rows worth showing: anything that moved today or still has a balance */
  function visibleRows() {
    const res = state.res;
    if (!res) return [];
    const whs = shownWarehouses();
    if (state.showAll) return res.rows;
    return res.rows.filter((r) => {
      const moved = whs.some((w) => {
        const c = r.cells[w.id] || {};
        return SamDB.n(c.inQty) || SamDB.n(c.outQty);
      });
      const bal = whs.reduce((a, w) => a + SamDB.n((r.cells[w.id] || {}).balance), 0);
      return moved || bal !== 0;
    });
  }

  /* ---------------- rendering ---------------- */
  function render() {
    const res = state.res;
    const whs = shownWarehouses();
    const rows = visibleRows();

    /* --- the header row: one group of two columns per warehouse --- */
    const head1 = `<th rowspan="2" style="min-width:170px">الصنف</th>
      <th rowspan="2" style="width:74px">الوحدة</th>
      ${whs.map((w) => `<th colspan="2" class="grp">${esc(w.name)}${w.location ? ` — ${esc(w.location)}` : ''}</th>`).join('')}
      <th rowspan="2" style="width:120px">إجمالي المتبقي</th>`;
    const head2 = whs.map(() => '<th style="width:104px">دخل اليوم</th><th style="width:104px">المتبقي</th>').join('');

    const body = rows.map((r) => {
      const cells = whs.map((w) => {
        const c = r.cells[w.id] || { inQty: 0, balance: 0 };
        const inQ = SamDB.n(c.inQty);
        const bal = SamDB.n(c.balance);
        return `<td class="num ${inQ ? 'qty plus' : 'dim'}">${inQ ? SamDB.fmt(inQ) : '—'}</td>
          <td class="num qty ${bal < 0 ? 'minus' : ''}">${SamDB.fmt(bal)}</td>`;
      }).join('');
      const total = whs.reduce((a, w) => a + SamDB.n((r.cells[w.id] || {}).balance), 0);
      return `<tr>
        <td>${esc(r.itemCode)} — ${esc(r.itemName)}</td>
        <td class="center"><span class="unit-chip">${esc(r.baseUnit)}</span></td>
        ${cells}
        <td class="num qty"><b>${SamDB.fmt(total)}</b></td>
      </tr>`;
    }).join('');

    document.getElementById('dailyTbl').innerHTML =
      `<thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${body}</tbody>`;

    /* --- the per-warehouse summary + the grand total --- */
    const sums = whs.map((w) => {
      const t = res.warehouseTotals[w.id] || { inQty: 0, outQty: 0, balance: 0 };
      const inQ = SamDB.n(t.inQty);
      const outQ = SamDB.n(t.outQty);
      const bal = SamDB.n(t.balance);
      return `<tr>
        <td><b>${esc(w.name)}</b>${w.location ? ` <span class="dim">— ${esc(w.location)}</span>` : ''}</td>
        <td class="num ${inQ ? 'qty plus' : 'dim'}">${inQ ? SamDB.fmt(inQ) : '—'}</td>
        <td class="num ${outQ ? 'qty minus' : 'dim'}">${outQ ? SamDB.fmt(outQ) : '—'}</td>
        <td class="num qty"><b>${SamDB.fmt(bal)}</b></td>
      </tr>`;
    }).join('');

    const grandIn = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).inQty), 0);
    const grandOut = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).outQty), 0);
    const grandBal = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).balance), 0);
    const grandRow = `<tr class="tot-row">
      <td><b>إجمالي كل المخازن</b></td>
      <td class="num"><b>${SamDB.fmt(grandIn)}</b></td>
      <td class="num"><b>${SamDB.fmt(grandOut)}</b></td>
      <td class="num"><b>${SamDB.fmt(grandBal)}</b></td>
    </tr>`;

    document.getElementById('dailySumTbl').innerHTML =
      `<thead><tr><th>المخزن</th><th>دخل اليوم</th><th>صادر اليوم</th><th>المتبقي</th></tr></thead>
       <tbody>${sums}${grandRow}</tbody>`;

    /* --- the headline numbers --- */
    document.getElementById('dailyKpis').innerHTML = `
      <div class="kpi gold"><span class="k-top">إجمالي المتبقي في كل المخازن</span>
        <span class="k-val">${SamDB.fmt(grandBal)}</span>
        <span class="k-note">${esc(state.whFilter ? 'المخزن المختار' : `${whs.length} مخازن`)} · تاريخ ${esc(res.date)}</span></div>
      <div class="kpi"><span class="k-top">دخل اليوم</span>
        <span class="k-val">${SamDB.fmt(grandIn)}</span>
        <span class="k-note">وارد في تاريخ ${esc(res.date)}</span></div>
      <div class="kpi"><span class="k-top">صادر اليوم</span>
        <span class="k-val">${SamDB.fmt(grandOut)}</span>
        <span class="k-note">خروج في تاريخ ${esc(res.date)}</span></div>
      <div class="kpi"><span class="k-top">الأصناف</span>
        <span class="k-val">${SamDB.fmt(rows.length)}</span>
        <span class="k-note">${esc((res.bucketLabels || []).join(' + '))}</span></div>`;

    /* --- the footnote --- */
    document.getElementById('dailyFoot').innerHTML = `
      <span>عدد الأصناف: <b>${SamDB.fmt(rows.length)}</b></span>
      <span>إجمالي المتبقي: <b class="big">${SamDB.fmt(grandBal)}</b></span>
      <span>دخل اليوم: <b>${SamDB.fmt(grandIn)}</b></span>
      <span>صادر اليوم: <b>${SamDB.fmt(grandOut)}</b></span>
      <span class="dim">الوحدة: ${esc([...new Set(rows.map((r) => r.baseUnit))].join(' / ') || '—')}</span>`;

    const hasRows = rows.length > 0;
    emptyState('dailyEmpty', {
      icon: 'i-chart',
      title: hasRows ? '' : 'لا توجد أصناف في هذا التقرير',
      hint: hasRows ? '' : 'غيّر التاريخ أو أظهر كل الأصناف. «المتبقي» يحسب من كل الحركات السابقة، و«دخل اليوم» من حركات اليوم فقط.'
    });
    toggleEmpty('dailyEmpty', hasRows);
  }

  /* ---------------- print ---------------- */
  function printDaily() {
    const res = state.res;
    if (!res) return toast('شغّل التقرير أولاً', 'bad');
    const whs = shownWarehouses();
    const rows = visibleRows();

    const head1 = `<th rowspan="2">الصنف</th><th rowspan="2">الوحدة</th>`
      + whs.map((w) => `<th colspan="2">${esc(w.name)}</th>`).join('')
      + '<th rowspan="2">إجمالي المتبقي</th>';
    const head2 = whs.map(() => '<th>دخل اليوم</th><th>المتبقي</th>').join('');
    const body = rows.map((r) => {
      const cells = whs.map((w) => {
        const c = r.cells[w.id] || {};
        return `<td>${SamDB.fmt(SamDB.n(c.inQty))}</td><td>${SamDB.fmt(SamDB.n(c.balance))}</td>`;
      }).join('');
      const total = whs.reduce((a, w) => a + SamDB.n((r.cells[w.id] || {}).balance), 0);
      return `<tr><td>${esc(r.itemCode)} — ${esc(r.itemName)}</td><td>${esc(r.baseUnit)}</td>${cells}<td>${SamDB.fmt(total)}</td></tr>`;
    }).join('');

    const grandIn = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).inQty), 0);
    const grandOut = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).outQty), 0);
    const grandBal = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).balance), 0);

    const sumBody = whs.map((w) => {
      const t = res.warehouseTotals[w.id] || {};
      return `<tr><td>${esc(w.name)}</td><td>${SamDB.fmt(SamDB.n(t.inQty))}</td><td>${SamDB.fmt(SamDB.n(t.outQty))}</td><td>${SamDB.fmt(SamDB.n(t.balance))}</td></tr>`;
    }).join('')
      + `<tr class="tot-row"><td><b>إجمالي كل المخازن</b></td><td>${SamDB.fmt(grandIn)}</td><td>${SamDB.fmt(grandOut)}</td><td>${SamDB.fmt(grandBal)}</td></tr>`;

    printPreview({
      title: 'التقرير اليومي',
      subtitle: `ما دخل اليوم في كل مخزن وما هو المتبقي فيه — ${res.date}`,
      docRef: `DR-${res.date}`,
      docRefLabel: 'رقم التقرير',
      head: [
        { k: 'التاريخ', v: res.date },
        { k: 'الحالات', v: (res.bucketLabels || []).join(' + ') },
        { k: 'عدد الأصناف', v: SamDB.fmt(rows.length) },
        { k: 'إجمالي المتبقي', v: SamDB.fmt(grandBal) }
      ],
      bodyHtml: `
        <table class="tbl" style="font-size:8.5pt;width:100%;table-layout:fixed">
          <thead><tr>${head1}</tr><tr>${head2}</tr></thead>
          <tbody>${body}</tbody>
        </table>
        <div style="margin-top:5mm"><b>ملخص المخازن</b>
          <table class="tbl" style="font-size:9pt">
            <thead><tr><th>المخزن</th><th>دخل اليوم</th><th>صادر اليوم</th><th>المتبقي</th></tr></thead>
            <tbody>${sumBody}</tbody>
          </table>
        </div>`,
      dense: true,
      landscape: true,
      footer: 'SAM Management System — التقرير اليومي (الكميات بالوحدة الأساسية لكل صنف)',
      signatures: ['أمين المخازن', 'المعد', 'المدير']
    });
  }

  /* ---------------- real xlsx export ---------------- */
  async function exportExcel() {
    const res = state.res;
    if (!res) return toast('شغّل التقرير أولاً', 'bad');
    const whs = shownWarehouses();
    const rows = visibleRows();

    const columns = [
      { header: 'كود الصنف', key: 'code' },
      { header: 'اسم الصنف', key: 'name' },
      { header: 'الوحدة', key: 'unit' }
    ];
    whs.forEach((w) => {
      columns.push({ header: `${w.name} — دخل اليوم`, key: `w${w.id}in`, num: true, fmt: '#,##0' });
      columns.push({ header: `${w.name} — المتبقي`, key: `w${w.id}bal`, num: true, fmt: '#,##0' });
    });
    columns.push({ header: 'إجمالي المتبقي', key: 'total', num: true, fmt: '#,##0' });

    const data = rows.map((r) => {
      const o = { code: r.itemCode, name: r.itemName, unit: r.baseUnit };
      let total = 0;
      whs.forEach((w) => {
        const c = r.cells[w.id] || {};
        o[`w${w.id}in`] = SamDB.n(c.inQty);
        o[`w${w.id}bal`] = SamDB.n(c.balance);
        total += SamDB.n(c.balance);
      });
      o.total = total;
      return o;
    });

    const totals = [];
    whs.forEach((w) => {
      totals.push({ key: `w${w.id}in`, value: whs.reduce((a, x) => a + SamDB.n((res.warehouseTotals[x.id] || {}).inQty), 0) });
      totals.push({ key: `w${w.id}bal`, value: whs.reduce((a, x) => a + SamDB.n((res.warehouseTotals[x.id] || {}).balance), 0) });
    });
    totals.push({
      key: 'total',
      value: whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).balance), 0)
    });

    const out = await sam.app.saveXlsx({
      fileName: `SAM-Daily-${res.date}.xlsx`,
      sheetName: 'التقرير اليومي',
      title: 'التقرير اليومي',
      subtitle: `SAM Management System — ${SamUI.WATERMARK}`,
      meta: [
        ['التاريخ', res.date],
        ['الحالات', (res.bucketLabels || []).join(' + ')],
        ['المخازن', whs.map((w) => w.name).join(' · ')],
        ['عدد الأصناف', SamDB.fmt(rows.length)],
        ['إجمالي المتبقي في كل المخازن', SamDB.fmt(totals.find((t) => t.key === 'total').value)]
      ],
      columns,
      rows: data,
      totals
    });
    if (out && out.ok) {
      toast(`تم حفظ ملف Excel: ${out.data.path} (${SamDB.fmt(out.data.rows)} سطر)`, 'ok', 5600);
      sam.app.openPath(out.data.path.replace(/[\\/][^\\/]+$/, ''));
    } else if (out && !out.canceled) {
      toast(out.error || 'تعذّر حفظ الملف', 'bad', 5200);
    }
  }

  /* ---------------- wiring ---------------- */
  async function load() {
    initUi();
    const dateEl = document.getElementById('dDate');
    if (!dateEl.value) dateEl.value = SamUI.today();
    await run();
  }

  document.getElementById('btnRunDaily').addEventListener('click', run);
  document.getElementById('btnPrintDaily').addEventListener('click', printDaily);
  document.getElementById('btnExcelDaily').addEventListener('click', exportExcel);
  document.getElementById('btnTodayDaily').addEventListener('click', async () => {
    document.getElementById('dDate').value = SamUI.today();
    await run();
  });
  document.getElementById('dAllItems').addEventListener('change', (e) => {
    state.showAll = e.target.checked;
    if (state.ran) render();
  });
  document.getElementById('dIncludeCustomer').addEventListener('change', async (e) => {
    state.includeCustomer = e.target.checked;
    await run();
  });
  document.getElementById('dDate').addEventListener('change', run);

  window.SamDaily = { load, run, printDaily, exportExcel, state };
  SamUI.pushKeys({ refresh: () => run() });
})();
