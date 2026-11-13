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

  /* =====================================================================
     الكراتين والأكياس — the packs of an item, for READING only:
     the accounting stays on the piece, the packs are only another way
     to say the same quantity («12 كيس + 12 حبة»). The switch lives in
     the same key the reports centre uses, so the customer finds it the
     same way on every screen — and it is remembered between openings.
     ===================================================================== */
  const PACKS_KEY = 'sam.packs.v1';

  /** the customer's choice: on (the default) or off */
  function readPacks() {
    try {
      const v = window.localStorage.getItem(PACKS_KEY);
      return v === null ? true : v !== '0';
    } catch (e) { return true; }
  }
  function writePacks(on) {
    try { window.localStorage.setItem(PACKS_KEY, on ? '1' : '0'); }
    catch (e) { /* a blocked storage never breaks the report */ }
  }

  const state = {
    res: null,
    ran: false,
    whFilter: null,      // null = every warehouse
    showAll: false,      // show items with no movement and no balance
    includeCustomer: false,
    packs: readPacks(),  // show the cartons/bags columns (remembered)
    from: SamUI.today(),
    to: SamUI.today(),
    win: null
  };

  let whCombo = null;    // the screen's warehouse combo
  let winCombo = null;   // the window's warehouse combo
  let winNodes = null;   // the nodes of the window panel
  let winGen = 0;        // رقم النافذة الحالية — يمنع نافذة قديمة من تدمير حديثة

  /* ---------------- the items (the pack sizes live on them) ---------------- */
  const ref = { items: [], byId: {}, loaded: false };

  async function loadItems() {
    try {
      const items = await SamDB.call('listItems', '');
      ref.items = items || [];
      ref.byId = {};
      ref.items.forEach((i) => { ref.byId[i.id] = i; });
      ref.loaded = true;
    } catch (e) {
      /* a user without the items screen simply gets no packs — the report
         itself must not complain about it */
      if (!(e && e.denied)) toast(e && e.message ? e.message : String(e), 'bad');
    }
    return ref;
  }

  /** the item of a row — its packs (how many pieces in a bag / carton) */
  function itemOf(id) { return ref.byId[id] || null; }

  /* ---------------- the packs (كراتين وأكياس) ---------------- */

  /** the kinds of packs, in the order they are shown */
  const PACK_KINDS = [
    { key: 'cartons', label: 'كرتون' },
    { key: 'bags', label: 'كيس' },
    { key: 'unit', label: 'وحدة الصنف' }
  ];

  /** the pack kinds this report really needs — only the ones the items use */
  function packKinds() {
    const res = state.res;
    if (!res) return [];
    const used = {};
    (res.rows || []).forEach((r) => {
      const it = itemOf(r.itemId);
      if (!it) return;
      SamUnits.unitsOf(it).forEach((u) => {
        if (!used[u.key]) used[u.key] = new Set();
        used[u.key].add(u.label);
      });
    });
    return PACK_KINDS.filter((k) => used[k.key]).map((k) => {
      const labels = [...used[k.key]];
      return { key: k.key, label: labels.length === 1 ? labels[0] : k.label };
    });
  }

  /** the packs of a quantity, written the way the customer counts them */
  function packText(item, key, pieces) {
    if (!item) return '';
    const u = SamUnits.unitsOf(item).find((x) => x.key === key);
    if (!u) return '';
    const q = Math.max(0, Math.round(SamDB.n(pieces)));
    const s = SamUnits.split(item, key, q);
    return SamUnits.describe(item, key, s.count, s.part);
  }

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

  /** the switch row — «إظهار الكراتين والأكياس» */
  function packsRow(id) {
    const row = el('div', 'check-row');
    row.style.marginTop = '6px';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = state.packs;
    cb.addEventListener('change', () => setPacks(cb.checked));
    row.append(cb, el('span', '', 'إظهار الكراتين والأكياس'));
    return row;
  }

  /** the switch on every surface (the screen and the window) */
  function syncPacksInputs() {
    ['dPacks', 'dwPacks'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) n.checked = state.packs;
    });
  }

  /** turn the packs on / off — the choice is remembered and shared */
  function setPacks(on) {
    state.packs = !!on;
    writePacks(state.packs);
    try { window.dispatchEvent(new CustomEvent('sam-packs-change', { detail: { on: state.packs } })); }
    catch (e) { /* an old runtime without the event still works */ }
    syncPacksInputs();
    paint();
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
    /* the packs switch — the options card is part of the page, so the row
       is built here in the app's own look (the same check-row) */
    if (!document.getElementById('dPacks')) {
      const row = packsRow('dPacks');
      const cust = document.getElementById('dIncludeCustomer');
      if (cust && cust.parentElement) cust.parentElement.insertAdjacentElement('afterend', row);
      else {
        const host = document.getElementById('dBuckets');
        if (host && host.parentElement) host.parentElement.appendChild(row);
      }
    }
    syncPacksInputs();
  }

  /* ---------------- run ---------------- */
  async function run() {
    const buckets = activeBuckets();
    if (!buckets.length) return toast('حدّد حالة واحدة على الأقل (سليم / تالف)', 'warn');
    /* the pack sizes live on the items — they are read in the background, so
       the report itself is never delayed by them */
    const needsItems = !ref.loaded;
    const itemsReady = needsItems ? loadItems() : null;
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
    /* when the items arrive, the packs of the items join the table */
    if (itemsReady) {
      itemsReady.then(() => {
        if (state.res === res) paint();
      });
    }
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
       that gathers EVERY warehouse for the item: إجمالي كل المخازن —
       and finally the packs of the item (الكراتين والأكياس): they belong
       to the ITEM, not to a warehouse. */
    const kinds = packKinds();
    const packsOn = state.packs && kinds.length > 0;

    const head1 = `<th rowspan="2" style="min-width:170px">الصنف</th>
      <th rowspan="2" style="width:74px">الوحدة</th>
      ${whs.map((w) => `<th colspan="3" class="grp">${esc(w.name)}${w.location ? ` — ${esc(w.location)}` : ''}</th>`).join('')}
      <th colspan="3" class="grp">إجمالي كل المخازن</th>
      ${packsOn ? `<th colspan="${kinds.length}" class="grp">الكراتين والأكياس</th>` : ''}`;
    const head2 = whs.map(() => '<th style="width:96px">وارد الفترة</th><th style="width:96px">صادر الفترة</th><th style="width:96px">المتبقي</th>').join('')
      + '<th style="width:104px">وارد</th><th style="width:104px">صادر</th><th style="width:104px">المتبقي</th>'
      + (packsOn ? kinds.map((k) => `<th style="width:118px">${esc(k.label)}</th>`).join('') : '');

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
      /* the packs of the item — read from the quantity that stays in all
         the warehouses together (the accounting stays on the piece) */
      const packs = packsOn ? kinds.map((k) => {
        const txt = packText(itemOf(r.itemId), k.key, total);
        return `<td class="pack">${txt ? esc(txt) : '—'}</td>`;
      }).join('') : '';
      return `<tr>
        <td>${esc(r.itemCode)} — ${esc(r.itemName)}</td>
        <td class="center"><span class="unit-chip">${esc(r.baseUnit)}</span></td>
        ${cells}
        <td class="num ${totalIn ? 'qty plus' : 'dim'}">${totalIn ? SamDB.fmt(totalIn) : '—'}</td>
        <td class="num ${totalOut ? 'qty minus' : 'dim'}">${totalOut ? SamDB.fmt(totalOut) : '—'}</td>
        <td class="num qty"><b>${SamDB.fmt(total)}</b></td>
        ${packs}
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
        <span class="dim">الوحدة: ${esc([...new Set(rows.map((r) => r.baseUnit))].join(' / ') || '—')}</span>
        ${packsOn ? '<span class="dim">الكراتين والأكياس: قراءة فقط — الحسبة على الحبة</span>' : ''}`;
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
    const kinds = packKinds();
    const packsOn = state.packs && kinds.length > 0;

    const head1 = `<th rowspan="2">الصنف</th><th rowspan="2">الوحدة</th>`
      + whs.map((w) => `<th colspan="3">${esc(w.name)}</th>`).join('')
      + '<th colspan="3">إجمالي كل المخازن</th>'
      + (packsOn ? `<th colspan="${kinds.length}">الكراتين والأكياس</th>` : '');
    const head2 = whs.map(() => '<th>وارد الفترة</th><th>صادر الفترة</th><th>المتبقي</th>').join('')
      + '<th>وارد</th><th>صادر</th><th>المتبقي</th>'
      + (packsOn ? kinds.map((k) => `<th>${esc(k.label)}</th>`).join('') : '');
    const body = rows.map((r) => {
      const cells = whs.map((w) => {
        const c = r.cells[w.id] || {};
        return `<td>${SamDB.fmt(SamDB.n(c.inQty))}</td><td>${SamDB.fmt(SamDB.n(c.outQty))}</td><td>${SamDB.fmt(SamDB.n(c.balance))}</td>`;
      }).join('');
      const total = SamDB.n(r.totalBalance);
      const packs = packsOn ? kinds.map((k) => {
        const txt = packText(itemOf(r.itemId), k.key, total);
        return `<td>${txt ? esc(txt) : '—'}</td>`;
      }).join('') : '';
      return `<tr><td>${esc(r.itemCode)} — ${esc(r.itemName)}</td><td>${esc(r.baseUnit)}</td>${cells}
        <td>${SamDB.fmt(SamDB.n(r.totalIn))}</td><td>${SamDB.fmt(SamDB.n(r.totalOut))}</td><td>${SamDB.fmt(total)}</td>${packs}</tr>`;
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
      footer: 'SAM Management System — التقرير اليومي (الكميات بالوحدة الأساسية لكل صنف)'
        + (packsOn ? ' · الكراتين والأكياس قراءة فقط' : ''),
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

  /** the workbook of the daily report — the export and the checks share it */
  function excelSpec() {
    const res = state.res;
    if (!res) return null;
    const whs = shownWarehouses();
    const rows = visibleRows();
    const kinds = packKinds();
    const packsOn = state.packs && kinds.length > 0;

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
    /* the packs of the item — the same text the screen shows */
    if (packsOn) {
      kinds.forEach((k) => {
        columns.push({ header: `الكراتين والأكياس — ${k.label}`, key: `pack_${k.key}` });
      });
    }

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
      if (packsOn) {
        const it = itemOf(r.itemId);
        kinds.forEach((k) => { o[`pack_${k.key}`] = packText(it, k.key, r.totalBalance); });
      }
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

    return {
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
    };
  }

  async function exportExcel() {
    const spec = excelSpec();
    if (!spec) return toast('شغّل التقرير أولاً', 'bad');
    const out = await sam.app.saveXlsx(spec);
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
      <label class="col-check"><input type="checkbox" id="dwCust" /><span>ضمّ مادة العملاء</span></label>
      <label class="col-check"><input type="checkbox" id="dwPacks" /><span>إظهار الكراتين والأكياس</span></label>`;
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

    const packsEl = nodes.node.querySelector('#dwPacks');
    packsEl.checked = state.packs;
    packsEl.addEventListener('change', () => setPacks(packsEl.checked));

    if (state.res) paintInto(nodes);
    return state.win;
  }

  /* ---------------- wiring ---------------- */
  async function load() {
    initUi();
    if (!state.from) state.from = SamUI.today();
    if (!state.to) state.to = SamUI.today();
    /* the pack sizes live on the items — they are read again every time the
       screen is opened, so a new bag size shows up at once */
    ref.loaded = false;
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

  /* the switch is shared with the reports centre — whoever turns it off,
     every surface follows (and the choice is remembered) */
  window.addEventListener('sam-packs-change', (e) => {
    const on = !!(e && e.detail && e.detail.on);
    if (on === state.packs) return;
    state.packs = on;
    syncPacksInputs();
    paint();
  });

  window.SamDaily = {
    load, run, openWindow, printDaily, exportExcel, exportPdf, state,
    /* the sheet and the workbook of the report — the checks read them */
    sheetSpec: () => (state.res ? sheetOpts() : null),
    excelSpec: () => excelSpec(),
    setPacks,
    packKinds
  };
  SamUI.pushKeys({ refresh: () => run() });
})();
