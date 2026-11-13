'use strict';

/* =====================================================================
   التقرير اليومي — V4
     · صنف × مخزن: دخل اليوم والمتبقي، وإجمالي كل المخازن
     · the screen shows the live table; «فتح في نافذة» gives the same
       report inside the report window (Excel · Print · PDF)
     · one painting path serves both surfaces
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, combo, printPreview, emptyState, toggleEmpty } = SamUI;

  const BUCKETS = [
    { key: 'good', label: 'سليم', on: true },
    { key: 'defect', label: 'تالف', on: false }
  ];

  const state = {
    res: null,
    ran: false,
    whFilter: null,      // null = every warehouse
    showAll: false,      // show items with no movement and no balance
    includeCustomer: false,
    from: SamUI.today(),
    to: SamUI.today(),
    win: null
  };

  let whCombo = null;    // the screen's warehouse combo
  let winCombo = null;   // the window's warehouse combo
  let winNodes = null;   // the nodes of the window panel
  let winGen = 0;        // رقم النافذة الحالية — يمنع نافذة قديمة من تدمير حديثة

  /* ---------------- filters ---------------- */
  function activeBuckets() {
    return BUCKETS.filter((b) => b.on).map((b) => b.key);
  }

  /** the checkbox group (the screen's or the window's) */
  function paintBuckets(host) {
    if (!host) return;
    host.innerHTML = '';
    BUCKETS.forEach((b) => {
      const box = el('label', 'col-check bucket');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = b.on;
      cb.addEventListener('change', () => {
        b.on = cb.checked;
        run();
      });
      box.append(cb, el('span', '', esc(b.label)));
      host.appendChild(box);
    });
  }

  function initUi() {
    if (!whCombo) {
      whCombo = combo(document.getElementById('dWh'), {
        placeholder: 'كل المخازن…',
        emptyText: 'لا توجد مخازن',
        onChange: (v) => {
          state.whFilter = v;
          run();
        }
      });
      whCombo.setValue(null, false);
    }
    paintBuckets(document.getElementById('dBuckets'));
    /* the period: two dates, and either one runs the report again */
    const fromEl = document.getElementById('dFrom');
    const toEl = document.getElementById('dTo');
    if (fromEl) {
      if (!fromEl.value) fromEl.value = state.from;
      fromEl.addEventListener('change', () => {
        state.from = fromEl.value || state.from;
        run();
      });
    }
    if (toEl) {
      if (!toEl.value) toEl.value = state.to;
      toEl.addEventListener('change', () => {
        state.to = toEl.value || state.to;
        run();
      });
    }
    const allEl = document.getElementById('dAllItems');
    if (allEl) allEl.checked = state.showAll;
    const custEl = document.getElementById('dIncludeCustomer');
    if (custEl) custEl.checked = state.includeCustomer;
  }

  /* ---------------- run ---------------- */
  async function run() {
    const buckets = activeBuckets();
    if (!buckets.length) return toast('حدّد حالة واحدة على الأقل (سليم / تالف)', 'warn');
    let res;
    try {
      res = await SamDB.call('dailyReport', {
        dateFrom: state.from,
        dateTo: state.to,
        buckets,
        includeCustomer: state.includeCustomer
      });
    } catch (e) { return toast(e.message, 'bad'); }

    state.res = res;
    state.ran = true;

    // the combo lists the warehouses of this report (they can change any time)
    const whs = (res.warehouses || []).map((w) => ({ id: w.id, label: w.name, code: w.code }));
    if (whCombo) {
      whCombo.setItems(whs);
      whCombo.setValue(state.whFilter, false);
    }
    if (winCombo) {
      winCombo.setItems(whs);
      winCombo.setValue(state.whFilter, false);
    }

    paint();
    toast(`تقرير ${periodLabel(res)}: ${SamDB.fmt(visibleRows().length)} صنف · المتبقي في كل المخازن ${SamDB.fmt(res.grand.balance)}`, 'ok');
  }

  /** the period in one line: «2026-11-01 → 2026-11-13» or just the day */
  function periodLabel(res) {
    if (!res) return '';
    const from = res.from || res.date;
    const to = res.to || res.date;
    return from === to ? from : `${from} → ${to}`;
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

  /* ---------------- painting (one path for both surfaces) ---------------- */
  function paint() {
    const res = state.res;
    const screen = {
      kpis: document.getElementById('dailyKpis'),
      tbl: document.getElementById('dailyTbl'),
      sumTbl: document.getElementById('dailySumTbl'),
      foot: document.getElementById('dailyFoot'),
      empty: document.getElementById('dailyEmpty')
    };
    if (res) {
      paintInto(screen);
      if (winNodes) paintInto(winNodes);
    }
  }

  function paintInto(t) {
    const res = state.res;
    if (!res || !t.tbl) return;
    const whs = shownWarehouses();
    const rows = visibleRows();

    /* --- the header row: one group of THREE columns per warehouse —
       وارد (دخل الفترة) · صادر (خروج الفترة) · المتبقي — then a group
       that gathers EVERY warehouse for the item: إجمالي كل المخازن. */
    const head1 = `<th rowspan="2" style="min-width:170px">الصنف</th>
      <th rowspan="2" style="width:74px">الوحدة</th>
      ${whs.map((w) => `<th colspan="3" class="grp">${esc(w.name)}${w.location ? ` — ${esc(w.location)}` : ''}</th>`).join('')}
      <th colspan="3" class="grp">إجمالي كل المخازن</th>`;
    const head2 = whs.map(() => '<th style="width:96px">وارد الفترة</th><th style="width:96px">صادر الفترة</th><th style="width:96px">المتبقي</th>').join('')
      + '<th style="width:104px">وارد</th><th style="width:104px">صادر</th><th style="width:104px">المتبقي</th>';

    const body = rows.map((r) => {
      const cells = whs.map((w) => {
        const c = r.cells[w.id] || { inQty: 0, outQty: 0, balance: 0 };
        const inQ = SamDB.n(c.inQty);
        const outQ = SamDB.n(c.outQty);
        const bal = SamDB.n(c.balance);
        return `<td class="num ${inQ ? 'qty plus' : 'dim'}">${inQ ? SamDB.fmt(inQ) : '—'}</td>
          <td class="num ${outQ ? 'qty minus' : 'dim'}">${outQ ? SamDB.fmt(outQ) : '—'}</td>
          <td class="num qty ${bal < 0 ? 'minus' : ''}">${SamDB.fmt(bal)}</td>`;
      }).join('');
      /* the totals of every warehouse of this item — the column the user
         asked for: one number that gathers them all */
      const totalIn = SamDB.n(r.totalIn);
      const totalOut = SamDB.n(r.totalOut);
      const total = SamDB.n(r.totalBalance);
      return `<tr>
        <td>${esc(r.itemCode)} — ${esc(r.itemName)}</td>
        <td class="center"><span class="unit-chip">${esc(r.baseUnit)}</span></td>
        ${cells}
        <td class="num ${totalIn ? 'qty plus' : 'dim'}">${totalIn ? SamDB.fmt(totalIn) : '—'}</td>
        <td class="num ${totalOut ? 'qty minus' : 'dim'}">${totalOut ? SamDB.fmt(totalOut) : '—'}</td>
        <td class="num qty"><b>${SamDB.fmt(total)}</b></td>
      </tr>`;
    }).join('');

    t.tbl.innerHTML =
      `<thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${body}</tbody>`;

    /* --- the per-warehouse summary + the grand total --- */
    const sums = whs.map((w) => {
      const s = res.warehouseTotals[w.id] || { inQty: 0, outQty: 0, balance: 0 };
      const inQ = SamDB.n(s.inQty);
      const outQ = SamDB.n(s.outQty);
      const bal = SamDB.n(s.balance);
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

    if (t.sumTbl) {
      t.sumTbl.innerHTML =
        `<thead><tr><th>المخزن</th><th>وارد الفترة</th><th>صادر الفترة</th><th>المتبقي</th></tr></thead>
         <tbody>${sums}${grandRow}</tbody>`;
    }

    /* --- the headline numbers ---
       every tile carries its own colour and its own 3D plate, exactly
       like the tiles on the main board. */
    if (t.kpis) {
      t.kpis.innerHTML = `
        <div class="kpi gold tone-produce"><span class="t3d tone-produce"><svg class="ic"><use href="#i-archive-box"/></svg></span>
          <span class="k-top">إجمالي المتبقي في كل المخازن</span>
          <span class="k-val">${SamDB.fmt(grandBal)}</span>
          <span class="k-note">${esc(state.whFilter ? 'المخزن المختار' : `${whs.length} مخازن`)} · ${esc(periodLabel(res))}</span></div>
        <div class="kpi tone-gin"><span class="t3d tone-gin"><svg class="ic"><use href="#i-in"/></svg></span>
          <span class="k-top">وارد الفترة</span>
          <span class="k-val">${SamDB.fmt(grandIn)}</span>
          <span class="k-note">وارد من ${esc(periodLabel(res))}</span></div>
        <div class="kpi tone-gout"><span class="t3d tone-gout"><svg class="ic"><use href="#i-out"/></svg></span>
          <span class="k-top">صادر الفترة</span>
          <span class="k-val">${SamDB.fmt(grandOut)}</span>
          <span class="k-note">خروج من ${esc(periodLabel(res))}</span></div>
        <div class="kpi tone-move"><span class="t3d tone-move"><svg class="ic"><use href="#i-box"/></svg></span>
          <span class="k-top">الأصناف</span>
          <span class="k-val">${SamDB.fmt(rows.length)}</span>
          <span class="k-note">${esc((res.bucketLabels || []).join(' + '))}</span></div>`;
    }

    /* --- the footnote --- */
    if (t.foot) {
      t.foot.innerHTML = `
        <span>عدد الأصناف: <b>${SamDB.fmt(rows.length)}</b></span>
        <span>إجمالي المتبقي: <b class="big">${SamDB.fmt(grandBal)}</b></span>
        <span>وارد الفترة: <b>${SamDB.fmt(grandIn)}</b></span>
        <span>صادر الفترة: <b>${SamDB.fmt(grandOut)}</b></span>
        <span class="dim">الوحدة: ${esc([...new Set(rows.map((r) => r.baseUnit))].join(' / ') || '—')}</span>`;
    }

    const hasRows = rows.length > 0;
    emptyState(t.empty, {
      icon: 'i-chart',
      title: hasRows ? '' : 'لا توجد أصناف في هذا التقرير',
      hint: hasRows ? '' : 'غيّر الفترة أو أظهر كل الأصناف. «المتبقي» يحسب من كل الحركات السابقة، و«وارد/صادر الفترة» من حركات الفترة فقط.'
    });
    toggleEmpty(t.empty, hasRows);
  }

  /* ---------------- the print sheet ---------------- */
  function sheetOpts() {
    const res = state.res;
    const whs = shownWarehouses();
    const rows = visibleRows();

    const head1 = `<th rowspan="2">الصنف</th><th rowspan="2">الوحدة</th>`
      + whs.map((w) => `<th colspan="3">${esc(w.name)}</th>`).join('')
      + '<th colspan="3">إجمالي كل المخازن</th>';
    const head2 = whs.map(() => '<th>وارد الفترة</th><th>صادر الفترة</th><th>المتبقي</th>').join('')
      + '<th>وارد</th><th>صادر</th><th>المتبقي</th>';
    const body = rows.map((r) => {
      const cells = whs.map((w) => {
        const c = r.cells[w.id] || {};
        return `<td>${SamDB.fmt(SamDB.n(c.inQty))}</td><td>${SamDB.fmt(SamDB.n(c.outQty))}</td><td>${SamDB.fmt(SamDB.n(c.balance))}</td>`;
      }).join('');
      const total = SamDB.n(r.totalBalance);
      return `<tr><td>${esc(r.itemCode)} — ${esc(r.itemName)}</td><td>${esc(r.baseUnit)}</td>${cells}
        <td>${SamDB.fmt(SamDB.n(r.totalIn))}</td><td>${SamDB.fmt(SamDB.n(r.totalOut))}</td><td>${SamDB.fmt(total)}</td></tr>`;
    }).join('');

    const grandIn = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).inQty), 0);
    const grandOut = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).outQty), 0);
    const grandBal = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).balance), 0);

    const sumBody = whs.map((w) => {
      const s = res.warehouseTotals[w.id] || {};
      return `<tr><td>${esc(w.name)}</td><td>${SamDB.fmt(SamDB.n(s.inQty))}</td><td>${SamDB.fmt(SamDB.n(s.outQty))}</td><td>${SamDB.fmt(SamDB.n(s.balance))}</td></tr>`;
    }).join('')
      + `<tr class="tot-row"><td><b>إجمالي كل المخازن</b></td><td>${SamDB.fmt(grandIn)}</td><td>${SamDB.fmt(grandOut)}</td><td>${SamDB.fmt(grandBal)}</td></tr>`;

    return {
      title: 'التقرير اليومي',
      subtitle: `وارد وصادر ومتبقي كل مخزن — ${periodLabel(res)}`,
      docRef: `DR-${res.from || res.date}`,
      docRefLabel: 'رقم التقرير',
      head: [
        { k: 'الفترة', v: periodLabel(res) },
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
            <thead><tr><th>المخزن</th><th>وارد الفترة</th><th>صادر الفترة</th><th>المتبقي</th></tr></thead>
            <tbody>${sumBody}</tbody>
          </table>
        </div>`,
      dense: true,
      landscape: true,
      footer: 'SAM Management System — التقرير اليومي (الكميات بالوحدة الأساسية لكل صنف)',
      /* a report is not a document — nobody signs a report */
      kind: 'report'
    };
  }

  function printDaily() {
    if (!state.res) return toast('شغّل التقرير أولاً', 'bad');
    printPreview(sheetOpts());
  }

  async function exportPdf() {
    if (!state.res) return toast('شغّل التقرير أولاً', 'bad');
    const node = SamUI.sheet(sheetOpts());
    const r = await SamUI.exportPdf(node, {
      landscape: true,
      fileName: `SAM-Daily-${state.res.from || state.res.date}.pdf`
    });
    if (r && r.ok) toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200);
    else if (r && !r.canceled) toast(r.error || 'تعذّر حفظ الملف', 'bad');
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
      columns.push({ header: `${w.name} — وارد الفترة`, key: `w${w.id}in`, num: true, fmt: '#,##0' });
      columns.push({ header: `${w.name} — صادر الفترة`, key: `w${w.id}out`, num: true, fmt: '#,##0' });
      columns.push({ header: `${w.name} — المتبقي`, key: `w${w.id}bal`, num: true, fmt: '#,##0' });
    });
    /* the column that gathers every warehouse for the item */
    columns.push({ header: 'كل المخازن — وارد', key: 'allIn', num: true, fmt: '#,##0' });
    columns.push({ header: 'كل المخازن — صادر', key: 'allOut', num: true, fmt: '#,##0' });
    columns.push({ header: 'كل المخازن — المتبقي', key: 'total', num: true, fmt: '#,##0' });

    const data = rows.map((r) => {
      const o = { code: r.itemCode, name: r.itemName, unit: r.baseUnit };
      whs.forEach((w) => {
        const c = r.cells[w.id] || {};
        o[`w${w.id}in`] = SamDB.n(c.inQty);
        o[`w${w.id}out`] = SamDB.n(c.outQty);
        o[`w${w.id}bal`] = SamDB.n(c.balance);
      });
      o.allIn = SamDB.n(r.totalIn);
      o.allOut = SamDB.n(r.totalOut);
      o.total = SamDB.n(r.totalBalance);
      return o;
    });

    const totals = [];
    whs.forEach((w) => {
      totals.push({ key: `w${w.id}in`, value: whs.reduce((a, x) => a + SamDB.n((res.warehouseTotals[x.id] || {}).inQty), 0) });
      totals.push({ key: `w${w.id}out`, value: whs.reduce((a, x) => a + SamDB.n((res.warehouseTotals[x.id] || {}).outQty), 0) });
      totals.push({ key: `w${w.id}bal`, value: whs.reduce((a, x) => a + SamDB.n((res.warehouseTotals[x.id] || {}).balance), 0) });
    });
    /* the totals of every warehouse — the same three numbers the columns
       carry, summed over the whole report */
    const grandIn = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).inQty), 0);
    const grandOut = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).outQty), 0);
    const grandBal = whs.reduce((a, w) => a + SamDB.n((res.warehouseTotals[w.id] || {}).balance), 0);
    totals.push({ key: 'allIn', value: grandIn });
    totals.push({ key: 'allOut', value: grandOut });
    totals.push({ key: 'total', value: grandBal });

    const out = await sam.app.saveXlsx({
      fileName: `SAM-Daily-${res.from || res.date}.xlsx`,
      sheetName: 'التقرير اليومي',
      title: 'التقرير اليومي',
      subtitle: `SAM Management System — ${SamUI.WATERMARK}`,
      meta: [
        ['الفترة', periodLabel(res)],
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

  /* ---------------- the report window ---------------- */
  function buildWindowPanel() {
    const wrap = el('div', 'rw-stack');

    /* --- filters --- */
    const panel = el('div', 'rw-panel');
    const r1 = el('div', 'rw-frow rw-f-period');
    r1.innerHTML = `<div class="rw-flabel">${SamUI.plate('rw-fic', 'i-calendar', null, 'xs')}<span>التاريخ</span></div>`;
    const b1 = el('div', 'rw-fbody rw-dates');
    b1.innerHTML = `<label class="field"><span>من تاريخ</span><input type="date" id="dwFrom" class="input" /></label>
      <label class="field"><span>إلى تاريخ</span><input type="date" id="dwTo" class="input" /></label>
      <div class="field"><span>المخزن</span><div id="dwWh"></div></div>`;
    r1.appendChild(b1);

    const r2 = el('div', 'rw-frow rw-f-state');
    r2.innerHTML = `<div class="rw-flabel">${SamUI.plate('rw-fic', 'i-box', null, 'xs')}<span>الحالة</span></div>`;
    const b2 = el('div', 'rw-fbody rw-state');
    b2.innerHTML = `<div class="rw-chips" id="dwBuckets"></div>
      <label class="col-check"><input type="checkbox" id="dwAll" /><span>إظهار كل الأصناف</span></label>
      <label class="col-check"><input type="checkbox" id="dwCust" /><span>ضمّ مادة العملاء</span></label>`;
    r2.appendChild(b2);
    panel.append(r1, r2);
    wrap.appendChild(panel);

    /* --- KPIs --- */
    const kpis = el('div', 'kpi-row');
    wrap.appendChild(kpis);

    /* --- the table --- */
    const card = el('div', 'rw-pbody');
    card.innerHTML = `<div class="tbl-wrap tall"><table class="tbl" id="dwTbl"></table></div>
      <div class="empty" id="dwEmpty"></div>
      <div class="report-foot" id="dwFoot"></div>`;
    wrap.appendChild(card);

    /* --- the per-warehouse summary --- */
    const sum = el('div', 'rw-pbody');
    sum.innerHTML = `<div class="tbl-wrap"><table class="tbl" id="dwSumTbl"></table></div>`;
    wrap.appendChild(sum);

    const nodes = {
      node: wrap,
      kpis,
      tbl: card.querySelector('#dwTbl'),
      sumTbl: sum.querySelector('#dwSumTbl'),
      foot: card.querySelector('#dwFoot'),
      empty: card.querySelector('#dwEmpty')
    };
    winNodes = nodes;
    return nodes;
  }

  function openWindow() {
    const gen = ++winGen;
    const nodes = buildWindowPanel();

    state.win = SamReportWindow.open({
      title: 'التقرير اليومي',
      subtitle: 'ما دخل اليوم في كل مخزن وما هو المتبقي فيه',
      icon: 'i-day',
      render: () => nodes.node,
      actions: (api) => [
        { label: 'تصدير Excel', icon: 'i-archive', kind: 'btn-ghost', onClick: () => exportExcel() },
        { label: 'طباعة / معاينة', icon: 'i-print', kind: 'btn-ghost', onClick: () => printDaily() },
        { label: 'تصدير PDF', icon: 'i-clipboard', kind: 'btn-primary', onClick: () => exportPdf() },
        { label: 'إغلاق', icon: 'i-x', kind: 'btn-ghost', onClick: () => api.close() }
      ],
      onClose: () => {
        /* a window that was replaced by a newer one must not clean up the
           newer window's state */
        if (gen !== winGen) return;
        state.win = null;
        winNodes = null;
        winCombo = null;
      }
    });

    /* wire the window controls */
    const fromEl = nodes.node.querySelector('#dwFrom');
    const toEl = nodes.node.querySelector('#dwTo');
    if (fromEl) {
      fromEl.value = state.from;
      fromEl.addEventListener('change', () => {
        state.from = fromEl.value || SamUI.today();
        run();
      });
    }
    if (toEl) {
      toEl.value = state.to;
      toEl.addEventListener('change', () => {
        state.to = toEl.value || SamUI.today();
        run();
      });
    }
    winCombo = combo(nodes.node.querySelector('#dwWh'), {
      placeholder: 'كل المخازن…',
      emptyText: 'لا توجد مخازن',
      onChange: (v) => { state.whFilter = v; run(); }
    });
    winCombo.setItems((state.res && state.res.warehouses || []).map((w) => ({ id: w.id, label: w.name, code: w.code })));
    winCombo.setValue(state.whFilter, false);
    paintBuckets(nodes.node.querySelector('#dwBuckets'));

    const allEl = nodes.node.querySelector('#dwAll');
    allEl.checked = state.showAll;
    allEl.addEventListener('change', () => { state.showAll = allEl.checked; run(); });

    const custEl = nodes.node.querySelector('#dwCust');
    custEl.checked = state.includeCustomer;
    custEl.addEventListener('change', () => { state.includeCustomer = custEl.checked; run(); });

    if (state.res) paintInto(nodes);
    return state.win;
  }

  /* ---------------- wiring ---------------- */
  async function load() {
    initUi();
    if (!state.from) state.from = SamUI.today();
    if (!state.to) state.to = SamUI.today();
    await run();
  }

  document.getElementById('btnRunDaily').addEventListener('click', run);
  document.getElementById('btnPrintDaily').addEventListener('click', printDaily);
  document.getElementById('btnExcelDaily').addEventListener('click', exportExcel);
  document.getElementById('btnTodayDaily').addEventListener('click', async () => {
    state.from = SamUI.today();
    state.to = SamUI.today();
    const fromEl = document.getElementById('dFrom');
    const toEl = document.getElementById('dTo');
    if (fromEl) fromEl.value = state.from;
    if (toEl) toEl.value = state.to;
    await run();
  });
  document.getElementById('dAllItems').addEventListener('change', (e) => {
    state.showAll = e.target.checked;
    if (state.ran) paint();
  });
  document.getElementById('dIncludeCustomer').addEventListener('change', async (e) => {
    state.includeCustomer = e.target.checked;
    await run();
  });

  const btnWin = document.getElementById('btnDailyWindow');
  if (btnWin) btnWin.addEventListener('click', () => openWindow());

  window.SamDaily = { load, run, openWindow, printDaily, exportExcel, exportPdf, state };
  SamUI.pushKeys({ refresh: () => run() });
})();
