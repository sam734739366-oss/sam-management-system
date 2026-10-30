'use strict';

/* =====================================================================
   Transactions — purchase / sale / returns / transfers + gate pass
   Every quantity is in PIECES. invoice_value is free text (no math).
   Parties and items are always picked with the searchable dropdown.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, bindRow, modal, input, textarea, confirmHardDelete, sheet, tableHtml, printPreview, combo } = SamUI;

  const state = {
    docs: [], items: [], warehouses: [], parties: [],
    kinds: { purchase: 'مشتريات', sale: 'مبيعات', sale_return: 'مرتجع مبيعات', purchase_return: 'مرتجع مشتريات', transfer: 'تحويل مخزن' },
    filter: { kind: '', search: '' }
  };
  const BUCKETS = [['good', 'سليم'], ['defect', 'تالف'], ['held', 'محجوز']];

  /* ---------------- data ---------------- */
  async function load() {
    try {
      const [items, whs, parties, docs] = await Promise.all([
        SamDB.call('listItems', ''),
        SamDB.call('listWarehouses'),
        SamDB.call('listParties', ''),
        SamDB.call('listDocuments', state.filter)
      ]);
      state.items = items;
      state.warehouses = whs;
      state.parties = parties;
      state.docs = docs;
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }

  const activeWh = () => state.warehouses.filter((w) => w.is_active);
  const itemOptions = () => state.items
    .filter((i) => i.is_active)
    .map((i) => ({ id: i.id, label: i.name, code: i.code, sub: `متاح ${SamDB.fmt(i.mainStock.good)} ${i.base_unit}` }));

  function partyOptions(wantCustomers) {
    return state.parties
      .filter((p) => p.is_active)
      .filter((p) => (wantCustomers ? p.type === 'customer' || p.type === 'both' : p.type === 'supplier' || p.type === 'both'))
      .map((p) => ({ id: p.id, label: p.name, code: p.phone || '', sub: SamParties.TYPE_AR[p.type] }));
  }

  function render() {
    const tb = document.querySelector('#docsTbl tbody');
    tb.innerHTML = '';
    state.docs.forEach((d, idx) => {
      const tr = el('tr');
      const whCell = d.kind === 'transfer'
        ? `${esc(d.warehouseName || '—')} ← ${esc(d.destWarehouseName || '—')}`
        : esc(d.warehouseName || '—');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(d.doc_no)}</td>
        <td><span class="chip ${kindChip(d.kind)}">${esc(d.kindAr)}</span></td>
        <td>${esc(d.doc_date)}</td>
        <td>${esc(d.partyName || '—')}</td>
        <td>${whCell}</td>
        <td class="num">${SamDB.fmt(d.lineCount)}</td>
        <td class="num qty">${SamDB.fmt(d.totalPieces)}</td>
        <td>${esc(d.invoice_value || '—')}</td>`;
      bindRow(tr, {
        view: () => viewDoc(d.id),
        edit: () => openEditor(d.id),
        del: () => removeDoc(d),
        extra: d.kind === 'sale'
          ? [{ label: 'طباعة تصريح خروج', icon: 'i-print', onClick: () => printGatePass(d.id) }]
          : [{ label: 'طباعة المستند', icon: 'i-print', onClick: () => printInvoice(d.id) }]
      });
      tb.appendChild(tr);
    });
    document.getElementById('docsEmpty').style.display = state.docs.length ? 'none' : 'block';
  }

  function kindChip(kind) {
    return { purchase: 'ok', sale: 'main', sale_return: 'warn', purchase_return: 'warn', transfer: 'sub' }[kind] || 'sub';
  }

  /* ---------------- editor ---------------- */
  async function openEditor(docId) {
    const doc = docId ? await SamDB.call('getDocument', docId) : null;
    let kind = doc ? doc.kind : 'purchase';

    const box = el('div', 'modal editor');
    const ov = el('div', 'overlay');
    ov.appendChild(box);

    const head = el('div', 'ed-head');
    box.appendChild(head);

    const errBar = el('div', 'form-err');
    const body = el('div', 'ed-body');
    body.appendChild(errBar);

    /* --- segmented kind picker --- */
    const seg = el('div', 'seg');
    Object.entries(state.kinds).forEach(([val, label]) => {
      const b = el('button', `seg-btn ${val === kind ? 'on' : ''}`, esc(label));
      b.type = 'button';
      b.addEventListener('click', () => {
        kind = val;
        seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
        syncKindVisibility();
      });
      seg.appendChild(b);
    });

    const docNo = input({ class: 'input', value: doc ? doc.doc_no : '', placeholder: 'يُولَّد تلقائياً' });
    const docDate = input({ class: 'input', type: 'date', value: doc ? doc.doc_date : new Date().toISOString().slice(0, 10) });
    const invoiceValue = input({ class: 'input', value: doc ? doc.invoice_value || '' : '', placeholder: 'نص حر — لا يُستخدم في أي حساب' });
    const notes = textarea({ rows: 2, value: doc ? doc.notes || '' : '', placeholder: 'ملاحظات المستند' });

    const partyHost = el('div');
    const whHost = el('div');
    const destHost = el('div');

    const partyCombo = combo(partyHost, {
      placeholder: 'ابحث بالاسم أو الهاتف…',
      emptyText: 'لا يوجد عملاء/موردين مطابقين',
      onAdd: async () => {
        const saved = await SamParties.quickAdd();
        if (saved) {
          await load();
          partyCombo.setItems(partyOptions(kind === 'purchase' || kind === 'purchase_return' ? false : true));
          partyCombo.setValue(saved.id, true);
        }
      }
    });
    partyCombo.setValue(doc ? doc.party_id : null, false);

    const whCombo = combo(whHost, {
      placeholder: 'اختر المخزن…',
      items: activeWh().map((w) => ({ id: w.id, label: w.name, code: w.kind === 'main' ? 'رئيسي' : 'فرعي' })),
      onChange: () => lines.forEach((l) => refreshAvail(l))
    });
    whCombo.setValue(doc ? doc.warehouse_id : (activeWh().find((w) => w.kind === 'main') || {}).id || null, false);

    const destCombo = combo(destHost, {
      placeholder: 'المخزن الوجهة…',
      items: activeWh().map((w) => ({ id: w.id, label: w.name, code: w.kind === 'main' ? 'رئيسي' : 'فرعي' }))
    });
    destCombo.setValue(doc ? doc.dest_warehouse_id : null, false);

    const grid = el('div', 'ed-grid');
    grid.append(
      el('div', 'ed-cell', `<label>رقم المستند</label>`).appendChild(docNo).parentNode,
      el('div', 'ed-cell', `<label>التاريخ</label>`).appendChild(docDate).parentNode,
      el('div', 'ed-cell party-cell', '<label>العميل / المورد</label>').appendChild(partyHost).parentNode,
      el('div', 'ed-cell', '<label>المخزن</label>').appendChild(whHost).parentNode,
      el('div', 'ed-cell dest-cell', '<label>المخزن الوجهة</label>').appendChild(destHost).parentNode,
      el('div', 'ed-cell', '<label>قيمة الفاتورة (نص)</label>').appendChild(invoiceValue).parentNode,
      el('div', 'ed-cell full', '<label>ملاحظات</label>').appendChild(notes).parentNode
    );
    body.appendChild(grid);

    /* --- lines table --- */
    body.appendChild(el('div', 'ed-sec', `${icon('i-box')}<span>أسطر المستند (الحبة هي الأساس)</span>`));
    const linesTbl = el('table', 'tbl lines-tbl');
    linesTbl.innerHTML = `<thead><tr>
        <th style="width:34%">الصنف</th><th>الحالة</th><th style="width:96px">حبة</th>
        <th style="width:92px">كراتين</th><th style="width:92px">أكياس</th>
        <th style="width:110px">متاح</th><th style="width:44px"></th></tr></thead><tbody></tbody>`;
    const linesBody = linesTbl.querySelector('tbody');
    body.appendChild(linesTbl);

    const totals = el('div', 'totals-bar');
    body.appendChild(totals);

    const addRow = el('button', 'btn btn-sm btn-ghost', `${icon('i-plus')}<span>إضافة سطر</span>`);
    addRow.type = 'button';
    addRow.addEventListener('click', () => addLine());
    body.appendChild(el('div', 'row-add').appendChild(addRow).parentNode);

    const foot = el('div', 'modal-foot');
    box.appendChild(body);
    box.appendChild(foot);

    /* --- line model --- */
    const lines = [];

    function recomputeTotals() {
      const pieces = lines.reduce((a, l) => a + SamDB.n(l.piecesEl.value), 0);
      const cartons = lines.reduce((a, l) => a + SamDB.n(l.cartonsEl.value), 0);
      const bags = lines.reduce((a, l) => a + SamDB.n(l.bagsEl.value), 0);
      totals.innerHTML = `<span>الأسطر: <b>${lines.length}</b></span>
        <span>إجمالي الحبة: <b class="big">${SamDB.fmt(pieces)}</b></span>
        <span>كراتين: <b>${SamDB.fmt(cartons)}</b></span>
        <span>أكياس: <b>${SamDB.fmt(bags)}</b></span>`;
    }

    async function refreshAvail(l) {
      const whId = whCombo.getValue();
      if (!l.itemCombo.getValue() || !whId) { l.availEl.textContent = '—'; return; }
      try {
        const avail = await SamDB.call('availablePieces', l.itemCombo.getValue(), whId, l.bucket, doc ? doc.id : null);
        l.availEl.textContent = SamDB.fmt(avail);
        l.availEl.className = SamDB.n(l.piecesEl.value) > avail ? 'avail low' : 'avail';
      } catch (e) { l.availEl.textContent = '—'; }
    }

    function addLine(data) {
      const tr = el('tr');
      const itemHost = el('div');
      const bucketBox = el('div', 'bucket-seg');
      const piecesEl = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.pieces : '' });
      const cartonsEl = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.cartons : '' });
      const bagsEl = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.bags : '' });
      const availEl = el('span', 'avail', '—');
      const del = el('button', 'row-del', '×');
      del.type = 'button';

      const l = { itemCombo: null, bucket: data ? data.bucket : 'good', piecesEl, cartonsEl, bagsEl, availEl };
      l.itemCombo = combo(itemHost, {
        placeholder: 'اكتب حرفين من اسم الصنف أو الكود…',
        emptyText: 'لا يوجد صنف مطابق',
        items: itemOptions(),
        onChange: () => refreshAvail(l)
      });
      if (data) l.itemCombo.setValue(data.item_id, false);

      BUCKETS.forEach(([val, label]) => {
        const b = el('button', `b-btn ${l.bucket === val ? 'on' : ''}`, label);
        b.type = 'button';
        b.addEventListener('click', () => {
          l.bucket = val;
          bucketBox.querySelectorAll('.b-btn').forEach((x) => x.classList.toggle('on', x === b));
          refreshAvail(l);
        });
        bucketBox.appendChild(b);
      });

      [piecesEl, cartonsEl, bagsEl].forEach((n) => n.addEventListener('input', () => { recomputeTotals(); refreshAvail(l); }));
      del.addEventListener('click', () => {
        const i = lines.indexOf(l);
        if (i >= 0) lines.splice(i, 1);
        tr.remove();
        recomputeTotals();
      });

      tr.append(el('td', '', '').appendChild(itemHost).parentNode,
        el('td').appendChild(bucketBox).parentNode,
        el('td').appendChild(piecesEl).parentNode,
        el('td').appendChild(cartonsEl).parentNode,
        el('td').appendChild(bagsEl).parentNode,
        el('td').appendChild(availEl).parentNode,
        el('td').appendChild(del).parentNode);
      linesBody.appendChild(tr);
      lines.push(l);
      recomputeTotals();
      if (data) refreshAvail(l);
      return l;
    }

    /* --- kind visibility --- */
    function syncKindVisibility() {
      const isTransfer = kind === 'transfer';
      grid.querySelector('.party-cell').style.display = isTransfer ? 'none' : '';
      grid.querySelector('.dest-cell').style.display = isTransfer ? '' : 'none';
      const wantCustomer = kind === 'sale' || kind === 'sale_return';
      partyCombo.setItems(partyOptions(wantCustomer));
      const gateBtn = foot.querySelector('[data-act="gate"]');
      if (gateBtn) gateBtn.classList.toggle('hidden', kind !== 'sale');
      errBar.innerHTML = '';
      lines.forEach((l) => refreshAvail(l));
    }

    /* --- footer buttons --- */
    const mkBtn = (act, label, cls) => {
      const b = el('button', `btn ${cls}`, `${act === 'cancel' ? '' : icon(act === 'gate' || act === 'print' ? 'i-print' : 'i-check')}<span>${esc(label)}</span>`);
      b.type = 'button';
      b.dataset.act = act;
      b.addEventListener('click', () => (act === 'cancel' ? close(null) : submit(act)));
      foot.appendChild(b);
      return b;
    };
    mkBtn('save', doc ? 'حفظ التعديلات' : 'حفظ المستند', 'btn-gold');
    mkBtn('print', 'حفظ وطباعة المستند', 'btn-primary');
    mkBtn('gate', 'حفظ وطباعة تصريح خروج', 'btn-primary');
    mkBtn('cancel', 'إغلاق', 'btn-ghost');

    /* --- submit --- */
    async function submit(action) {
      errBar.innerHTML = '';
      const payload = {
        id: doc ? doc.id : null,
        kind,
        doc_no: docNo.value.trim(),
        doc_date: docDate.value,
        party_id: kind === 'transfer' ? null : partyCombo.getValue(),
        warehouse_id: whCombo.getValue(),
        dest_warehouse_id: kind === 'transfer' ? destCombo.getValue() : null,
        invoice_value: invoiceValue.value,
        notes: notes.value,
        lines: lines.map((l) => ({
          item_id: l.itemCombo.getValue(),
          bucket: l.bucket,
          pieces: SamDB.n(l.piecesEl.value),
          cartons: SamDB.n(l.cartonsEl.value),
          bags: SamDB.n(l.bagsEl.value),
          warehouse_id: whCombo.getValue(),
          dest_warehouse_id: kind === 'transfer' ? destCombo.getValue() : null
        }))
      };
      if (!payload.lines.length) {
        errBar.innerHTML = `${icon('i-warn')}<span>أضف سطراً واحداً على الأقل</span>`;
        return;
      }
      foot.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
      try {
        const saved = await SamDB.call('saveDocument', payload);
        toast(`تم حفظ ${state.kinds[kind]} رقم ${saved.doc_no}`, 'ok');
        SamUI.bus.emit();
        close(saved);
        if (action === 'print') printInvoice(saved.id);
        if (action === 'gate') printGatePass(saved.id);
      } catch (e) {
        errBar.innerHTML = `${icon('i-warn')}<span>${esc(e.message)}</span>`;
      } finally {
        foot.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
      }
    }

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    function close(val) {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(val);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    head.innerHTML = `<h3>${doc ? `تعديل ${state.kinds[doc.kind]} — ${esc(doc.doc_no)}` : 'مستند جديد'}</h3>`;
    head.appendChild(seg);

    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);

    // initial lines: one empty row for a brand-new document
    if (doc) doc.lines.forEach((l) => addLine(l));
    else addLine();
    syncKindVisibility();
    recomputeTotals();

    return promise;
  }

  /* ---------------- view ---------------- */
  async function viewDoc(id) {
    const d = await SamDB.call('getDocument', id);
    const rows = d.lines.map((l, i) => ({
      no: i + 1,
      item: `${l.itemCode} — ${l.itemName}`,
      bucket: { good: 'سليم', defect: 'تالف', held: 'محجوز' }[l.bucket],
      pieces: SamDB.fmt(l.pieces),
      cartons: SamDB.fmt(l.cartons),
      bags: SamDB.fmt(l.bags),
      wh: l.warehouseName + (l.destWarehouseName ? ` ← ${l.destWarehouseName}` : '')
    }));
    const html = SamUI.tableHtml(
      [
        { key: 'no', label: 'م' },
        { key: 'item', label: 'الصنف' },
        { key: 'bucket', label: 'الحالة' },
        { key: 'cartons', label: 'كراتين' },
        { key: 'bags', label: 'أكياس' },
        { key: 'pieces', label: 'حبة' },
        { key: 'wh', label: 'المخزن' }
      ],
      rows,
      SamDB.fmt(d.totalPieces)
    );
    const v = await modal({
      title: `${d.kindAr} — ${d.doc_no}`,
      width: 'min(820px, 95vw)',
      body: `<dl class="info">
          <dt>التاريخ</dt><dd>${esc(d.doc_date)}</dd>
          <dt>العميل / المورد</dt><dd>${esc(d.partyName || '—')}</dd>
          <dt>المخزن</dt><dd>${esc(d.warehouseName || '—')}${d.destWarehouseName ? ` ← ${esc(d.destWarehouseName)}` : ''}</dd>
          <dt>قيمة الفاتورة</dt><dd>${esc(d.invoice_value || '—')}</dd>
          <dt>ملاحظات</dt><dd>${esc(d.notes || '—')}</dd>
        </dl><div style="margin-top:14px">${html}</div>`,
      actions: [
        { label: 'طباعة المستند', value: 'print', kind: 'btn-primary', icon: 'i-print' },
        ...(d.kind === 'sale' ? [{ label: 'تصريح خروج', value: 'gate', kind: 'btn-gold', icon: 'i-print' }] : []),
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    });
    if (v === 'edit') openEditor(id);
    if (v === 'print') printInvoice(id);
    if (v === 'gate') printGatePass(id);
  }

  /* ---------------- printing ---------------- */
  async function printInvoice(id) {
    const d = await SamDB.call('getDocument', id);
    const rows = d.lines.map((l, i) => ({
      no: i + 1,
      item: `${l.itemCode} — ${l.itemName}`,
      unit: l.baseUnit,
      cartons: SamDB.fmt(l.cartons),
      bags: SamDB.fmt(l.bags),
      pieces: SamDB.fmt(l.pieces)
    }));
    const cols = [
      { key: 'no', label: 'م' },
      { key: 'item', label: 'الصنف' },
      { key: 'unit', label: 'الوحدة' },
      { key: 'cartons', label: 'كراتين' },
      { key: 'bags', label: 'أكياس' },
      { key: 'pieces', label: 'حبة' }
    ];
    printPreview({
      title: d.kindAr,
      subtitle: `مستند رقم ${d.doc_no}`,
      head: [
        { k: 'التاريخ', v: d.doc_date },
        { k: d.kind === 'purchase' || d.kind === 'purchase_return' ? 'المورد' : 'العميل', v: d.partyName || '—' },
        { k: 'المخزن', v: d.warehouseName || '—' },
        { k: 'قيمة الفاتورة', v: d.invoice_value || '—' }
      ],
      bodyHtml: tableHtml(cols, rows, SamDB.fmt(d.totalPieces)),
      footer: 'SAM Management System — جميع الكميات بالحبة',
      signatures: ['المستلم', 'أمين المخزن', 'المحاسب']
    });
  }

  /** تصريح خروج — quantities only, never prices */
  async function printGatePass(id) {
    const d = await SamDB.call('getDocument', id);
    const rows = d.lines.map((l, i) => ({
      no: i + 1,
      item: `${l.itemCode} — ${l.itemName}`,
      cartons: SamDB.fmt(l.cartons),
      bags: SamDB.fmt(l.bags),
      pieces: SamDB.fmt(l.pieces)
    }));
    const html = tableHtml(
      [
        { key: 'no', label: 'م' },
        { key: 'item', label: 'الصنف' },
        { key: 'cartons', label: 'كراتين' },
        { key: 'bags', label: 'أكياس' },
        { key: 'pieces', label: 'حبة' }
      ],
      rows,
      SamDB.fmt(d.totalPieces)
    );
    printPreview({
      title: 'تصريح خروج',
      subtitle: `مرفق بمستند مبيعات رقم ${d.doc_no}`,
      head: [
        { k: 'رقم التصريح', v: `GP-${d.doc_no}` },
        { k: 'التاريخ', v: d.doc_date },
        { k: 'الجهة', v: d.partyName || '—' },
        { k: 'المخزن', v: d.warehouseName || '—' }
      ],
      bodyHtml: `
        <p style="font-size:11pt;line-height:1.9;margin:0 0 4mm">
          صرح بخروج الكميات التالية فقط، ويمنع خروج أي بضاعة غير مذكورة في هذا التصريح.
          <b>لا تظهر الأسعار في هذا المستند.</b>
        </p>
        <p style="font-size:10pt;margin:0 0 4mm">وسيلة النقل: .......................... &nbsp;&nbsp; اسم السائق: .......................... &nbsp;&nbsp; رقم اللوحة: .................</p>
        ${html}`,
      footer: 'SAM Management System — تصريح خروج (كميات فقط)',
      signatures: ['المستلم', 'السائق', 'أمين المخزن', 'حراسة البوابة']
    });
  }

  /* ---------------- hard delete ---------------- */
  async function removeDoc(d) {
    let impact;
    try { impact = await SamDB.call('documentImpact', d.id); } catch (e) { return toast(e.message, 'bad'); }
    if (!impact) return;
    const yes = await confirmHardDelete({
      docNo: impact.doc.doc_no,
      docType: impact.doc.kindAr,
      lines: impact.lines,
      extra: `<p style="margin-top:10px;font-size:13px">إجمالي ما سيرتد إلى الأرصدة: <b>${SamDB.fmt(impact.totalPieces)} حبة</b> على ${impact.lines.length} سطر.</p>`
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteDocument', d.id);
      toast(`تم حذف ${d.kindAr} ${d.doc_no} نهائياً وعكس المخزون`, 'bad', 4600);
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- wiring ---------------- */
  let t = null;
  document.getElementById('btnNewDoc').addEventListener('click', () => openEditor(null));
  document.getElementById('docSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.filter.search = e.target.value; load(); }, 200);
  });
  document.getElementById('docTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.filter.kind = b.dataset.kind;
    document.querySelectorAll('#docTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });

  window.SamDocs = { load, openEditor, printInvoice, printGatePass };
  SamUI.bus.on(load);
})();
