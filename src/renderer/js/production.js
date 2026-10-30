'use strict';

/* =====================================================================
   Production — issue raw material, then the daily production report
   with automatic routing:
     good              -> finished-goods GOOD warehouse
     defect cans       -> finished-goods DEFECT warehouse
     defect ampoules   -> RAW MATERIAL defect warehouse (on the raw item)
   Shortage / surplus is calculated automatically against the carton size.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, bindRow, modal, form, field, input, textarea, combo, confirmHardDelete, tableHtml, printPreview } = SamUI;

  const state = { items: [], warehouses: [], issues: [], receipts: [], routing: {}, tab: 'issues' };
  let rt = null;

  const whOptions = () => state.warehouses.filter((w) => w.is_active)
    .map((w) => ({ id: w.id, label: w.name, code: w.kind === 'main' ? 'رئيسي' : 'فرعي' }));
  const itemOptions = (onlyRaw) => state.items
    .filter((i) => i.is_active)
    .filter((i) => !onlyRaw || (i.pieces_per_carton > 0))
    .map((i) => ({ id: i.id, label: i.name, code: i.code, sub: `متاح ${SamDB.fmt(i.mainStock.good)} ${i.base_unit}` }));

  /* ---------------- load ---------------- */
  async function load() {
    try {
      const [items, whs, issues, receipts, routing] = await Promise.all([
        SamDB.call('listItems', ''),
        SamDB.call('listWarehouses'),
        SamDB.call('listIssues', 200),
        SamDB.call('listReceipts', 200),
        SamDB.call('prodRouting')
      ]);
      Object.assign(state, { items, warehouses: whs, issues, receipts, routing });
      initRoutingUI();
      renderIssues();
      renderReceipts();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- routing panel ---------------- */
  function initRoutingUI() {
    if (!rt) {
      rt = {
        fgGood: combo(document.getElementById('rtFgGood'), { placeholder: 'مخزن المنتج التام السليم…', items: whOptions() }),
        fgDefect: combo(document.getElementById('rtFgDefect'), { placeholder: 'مخزن المنتج التام التالف…', items: whOptions() }),
        rawDefect: combo(document.getElementById('rtRawDefect'), { placeholder: 'مخزن الخام التالف…', items: whOptions() }),
        bagItem: combo(document.getElementById('rtBagItem'), { placeholder: 'صنف الأكياس (اختياري)…', items: itemOptions(false) }),
        bagWh: combo(document.getElementById('rtBagWh'), { placeholder: 'مخزن خصم الأكياس…', items: whOptions() })
      };
    } else {
      Object.values(rt).forEach((c) => c.setItems(c === rt.bagItem ? itemOptions(false) : whOptions()));
    }
    rt.fgGood.setValue(state.routing.fgGoodWh || null, false);
    rt.fgDefect.setValue(state.routing.fgDefectWh || null, false);
    rt.rawDefect.setValue(state.routing.rawDefectWh || null, false);
    rt.bagItem.setValue(state.routing.bagItemId || null, false);
    rt.bagWh.setValue(state.routing.bagWhId || null, false);
  }

  async function saveRouting() {
    try {
      await SamDB.call('setProdRouting', {
        fgGoodWh: rt.fgGood.getValue(),
        fgDefectWh: rt.fgDefect.getValue(),
        rawDefectWh: rt.rawDefect.getValue(),
        bagItemId: rt.bagItem.getValue(),
        bagWhId: rt.bagWh.getValue()
      });
      toast('تم حفظ توجيه الأرصدة', 'ok');
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- issue to production ---------------- */
  function openIssueForm(row) {
    const editing = !!row;
    const body = el('div');
    const grid = el('div', 'form-grid');

    const docNo = input({ value: editing ? row.doc_no : '', placeholder: 'يُولَّد تلقائياً' });
    const docDate = input({ type: 'date', value: editing ? row.doc_date : new Date().toISOString().slice(0, 10) });
    const cartons = input({ type: 'number', min: '0', step: '1', value: editing ? row.cartons : '', placeholder: '0' });
    const pieces = input({ type: 'number', min: '0', step: '1', value: editing ? row.pieces : '', placeholder: '0' });
    const note = input({ value: editing ? row.note || '' : '', placeholder: 'ملاحظة' });

    const itemHost = el('div');
    const whHost = el('div');
    const itemCombo = combo(itemHost, { placeholder: 'اكتب جزءاً من اسم المادة الخام…', emptyText: 'لا يوجد صنف مطابق', items: itemOptions(true) });
    const whCombo = combo(whHost, { placeholder: 'المخزن المصدر…', items: whOptions() });
    itemCombo.setValue(editing ? row.item_id : null, false);
    whCombo.setValue(editing ? row.warehouse_id : (state.warehouses.find((w) => w.kind === 'main') || {}).id || null, false);

    const hint = el('p', 'foot-note');
    const syncPieces = () => {
      const it = state.items.find((i) => i.id === itemCombo.getValue());
      const c = SamDB.n(cartons.value);
      if (it && it.pieces_per_carton > 0 && c > 0) {
        pieces.value = it.pieces_per_carton * c;
        hint.textContent = `محسوب تلقائياً: ${SamDB.fmt(c)} كرتونة × ${SamDB.fmt(it.pieces_per_carton)} حبة = ${SamDB.fmt(pieces.value)} حبة — عدّله يدوياً إن لزم.`;
      } else if (it) {
        hint.textContent = 'هذا الصنف لا يحمل «حبات الكرتونة» — أدخل عدد الحبات يدوياً.';
      } else hint.textContent = '';
    };
    itemCombo.opts.onChange = syncPieces;
    cartons.addEventListener('input', syncPieces);
    syncPieces();

    const noteField = field('ملاحظة', note);
    noteField.classList.add('full');
    grid.append(
      field('رقم الصرف', docNo),
      field('التاريخ', docDate),
      field('المادة الخام', itemHost),
      field('المخزن المصدر', whHost),
      field('عدد الكراتين', cartons),
      field('عدد الحبات (الأساس)', pieces),
      noteField
    );
    body.appendChild(grid);
    body.appendChild(hint);

    form({
      title: editing ? `تعديل صرف ${row.doc_no}` : 'صرف مواد خام للمنتج',
      body,
      submitLabel: 'حفظ الصرف',
      async onSubmit() {
        const payload = {
          id: editing ? row.id : null,
          doc_no: docNo.value.trim(),
          doc_date: docDate.value,
          item_id: itemCombo.getValue(),
          warehouse_id: whCombo.getValue(),
          cartons: SamDB.n(cartons.value),
          pieces: SamDB.n(pieces.value),
          note: note.value
        };
        const saved = await SamDB.call(editing ? 'saveIssue' : 'saveIssue', payload);
        toast(`تم حفظ صرف ${saved.doc_no} (${SamDB.fmt(saved.pieces)} حبة)`, 'ok');
        SamUI.bus.emit();
        return saved;
      }
    }).then((v) => { if (v) load(); });
  }

  function renderIssues() {
    const tb = document.querySelector('#issuesTbl tbody');
    tb.innerHTML = '';
    state.issues.forEach((i, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(i.doc_no)}</td>
        <td>${esc(i.doc_date)}</td>
        <td>${esc(i.itemCode)} — ${esc(i.itemName)}</td>
        <td>${esc(i.warehouseName)}</td>
        <td class="num">${SamDB.fmt(i.cartons)}</td>
        <td class="num qty minus">−${SamDB.fmt(i.pieces)}</td>
        <td>${esc(i.note || '—')}</td>`;
      bindRow(tr, {
        view: () => viewIssue(i),
        edit: () => openIssueForm(i),
        del: () => removeIssue(i)
      });
      tb.appendChild(tr);
    });
    document.getElementById('issuesEmpty').style.display = state.issues.length ? 'none' : 'block';
  }

  function viewIssue(i) {
    modal({
      title: `صرف مواد خام — ${i.doc_no}`,
      body: `<dl class="info">
        <dt>التاريخ</dt><dd>${esc(i.doc_date)}</dd>
        <dt>المادة الخام</dt><dd>${esc(i.itemCode)} — ${esc(i.itemName)}</dd>
        <dt>المخزن المصدر</dt><dd>${esc(i.warehouseName)}</dd>
        <dt>الكراتين</dt><dd>${SamDB.fmt(i.cartons)}</dd>
        <dt>الحبة المصروفة</dt><dd>${SamDB.fmt(i.pieces)}</dd>
        <dt>ملاحظة</dt><dd>${esc(i.note || '—')}</dd>
      </dl>`,
      actions: [
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    }).then((v) => { if (v === 'edit') openIssueForm(i); });
  }

  async function removeIssue(i) {
    const impact = await SamDB.call('issueImpact', i.id);
    const yes = await confirmHardDelete({
      docNo: i.doc_no, docType: 'صرف مواد خام', lines: impact.lines,
      extra: `<p style="margin-top:10px;font-size:13px">سيُعاد <b>${SamDB.fmt(i.pieces)}</b> حبة إلى «${esc(i.warehouseName)}» فوراً.</p>`
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteIssue', i.id);
      toast('تم حذف الصرف نهائياً وإرجاع الخام للمخزن', 'bad', 4200);
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- daily production report ---------------- */
  async function openReceiptForm(id) {
    const doc = id ? await SamDB.call('getReceipt', id) : null;
    let issues = [];
    try { issues = await SamDB.call('listOpenIssues'); } catch (e) { /* optional */ }

    const box = el('div', 'modal editor');
    const ov = el('div', 'overlay');
    const head = el('div', 'ed-head');
    box.appendChild(head);
    const errBar = el('div', 'form-err');
    const body = el('div', 'ed-body');
    body.appendChild(errBar);
    box.appendChild(body);
    const foot = el('div', 'modal-foot');
    box.appendChild(foot);
    ov.appendChild(box);

    const docNo = input({ value: doc ? doc.doc_no : '', placeholder: 'يُولَّد تلقائياً' });
    const docDate = input({ type: 'date', value: doc ? doc.doc_date : new Date().toISOString().slice(0, 10) });
    const cartonNo = input({ value: doc ? doc.carton_no : '', placeholder: 'مثال: C-2026-10-301' });
    const cartonPieces = input({ type: 'number', min: '0', step: '1', value: doc ? doc.carton_pieces : '', placeholder: '0' });
    const note = input({ value: doc ? doc.notes || doc.note || '' : '', placeholder: 'ملاحظات' });

    const rawHost = el('div');
    const issueHost = el('div');
    const rawCombo = combo(rawHost, {
      placeholder: 'اكتب اسم المادة الخام…',
      emptyText: 'لا يوجد صنف مطابق',
      items: itemOptions(true)
    });
    const issueCombo = combo(issueHost, {
      placeholder: 'مرتبط بصرف (اختياري)…',
      emptyText: 'لا توجد مصروفات',
      items: issues.map((i) => ({ id: i.id, label: `${i.itemName} — ${SamDB.fmt(i.pieces)} حبة`, code: i.doc_no, sub: i.warehouseName }))
    });
    rawCombo.setValue(doc ? doc.raw_item_id : null, false);
    issueCombo.setValue(doc ? doc.issue_id : null, false);
    rawCombo.opts.onChange = (v) => {
      const it = state.items.find((x) => x.id === v);
      if (it && it.pieces_per_carton > 0 && !cartonPieces.value) cartonPieces.value = it.pieces_per_carton;
    };
    issueCombo.opts.onChange = (v) => {
      const i = issues.find((x) => x.id === v);
      if (!i) return;
      rawCombo.setValue(i.item_id, false);
      if (i.pieces) cartonPieces.value = i.pieces;
    };

    const grid = el('div', 'ed-grid');
    const cell = (label, node, cls) => {
      const c = el('div', `ed-cell ${cls || ''}`);
      c.appendChild(el('label', '', esc(label)));
      c.appendChild(node);
      return c;
    };
    grid.append(
      cell('رقم التقرير', docNo),
      cell('التاريخ', docDate),
      cell('رقم الكرتونة', cartonNo),
      cell('المادة الخام', rawHost),
      cell('حبات الكرتونة (المتوقع)', cartonPieces),
      cell('مرتبط بصرف', issueHost),
      cell('ملاحظات', note, 'full')
    );
    body.appendChild(grid);

    body.appendChild(el('div', 'ed-sec', `${icon('i-factory')}<span>المنتجات التامة — التوجيه تلقائي</span>`));
    const linesTbl = el('table', 'tbl lines-tbl');
    linesTbl.innerHTML = `<thead><tr>
        <th style="width:30%">المنتج التام</th>
        <th style="width:110px">جيد</th><th style="width:110px">تالف علب</th>
        <th style="width:120px">تالف أمبولة</th><th style="width:110px">أكياس مستخدمة</th>
        <th style="width:44px"></th></tr></thead><tbody></tbody>`;
    const linesBody = linesTbl.querySelector('tbody');
    body.appendChild(linesTbl);

    const flow = el('div', 'flow-bar');
    body.appendChild(flow);
    const totals = el('div', 'totals-bar');
    body.appendChild(totals);

    const addRow = el('button', 'btn btn-sm btn-ghost', `${icon('i-plus')}<span>إضافة منتج</span>`);
    addRow.type = 'button';
    addRow.addEventListener('click', () => addLine());
    body.appendChild(el('div', 'row-add').appendChild(addRow).parentNode);

    const lines = [];

    function addLine(data) {
      const tr = el('tr');
      const itemHost = el('div');
      const good = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.good : '' });
      const cans = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.defect_cans : '' });
      const amps = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.defect_ampoules : '' });
      const bags = input({ class: 'input num-in', type: 'number', min: '0', step: '1', value: data ? data.bags_used : '' });
      const del = el('button', 'row-del', '×');
      del.type = 'button';

      const l = { itemCombo: null, good, cans, amps, bags };
      l.itemCombo = combo(itemHost, {
        placeholder: 'اكتب اسم المنتج…',
        emptyText: 'لا يوجد صنف مطابق',
        items: itemOptions(false),
        onChange: () => recompute()
      });
      if (data) l.itemCombo.setValue(data.item_id, false);
      [good, cans, amps, bags].forEach((n) => n.addEventListener('input', recompute));
      del.addEventListener('click', () => {
        const i = lines.indexOf(l);
        if (i >= 0) lines.splice(i, 1);
        tr.remove();
        recompute();
      });
      tr.append(
        el('td').appendChild(itemHost).parentNode,
        el('td').appendChild(good).parentNode,
        el('td').appendChild(cans).parentNode,
        el('td').appendChild(amps).parentNode,
        el('td').appendChild(bags).parentNode,
        el('td').appendChild(del).parentNode
      );
      linesBody.appendChild(tr);
      lines.push(l);
      return l;
    }

    function recompute() {
      const good = lines.reduce((a, l) => a + SamDB.n(l.good.value), 0);
      const cans = lines.reduce((a, l) => a + SamDB.n(l.cans.value), 0);
      const amps = lines.reduce((a, l) => a + SamDB.n(l.amps.value), 0);
      const bags = lines.reduce((a, l) => a + SamDB.n(l.bags.value), 0);
      const produced = good + cans + amps;
      const expected = SamDB.n(cartonPieces.value);
      const shortage = Math.max(0, expected - produced);
      const surplus = Math.max(0, produced - expected);
      totals.innerHTML = `
        <span>المتوقع من الكرتونة: <b>${SamDB.fmt(expected)}</b></span>
        <span>المنتَج الكلي: <b>${SamDB.fmt(produced)}</b></span>
        <span>العجز: <b class="${shortage ? 'neg' : ''}">${SamDB.fmt(shortage)}</b></span>
        <span>الزيادة: <b class="${surplus ? 'pos' : ''}">${SamDB.fmt(surplus)}</b></span>
        <span>الأكياس المستخدمة: <b>${SamDB.fmt(bags)}</b></span>`;
      const wh = (id) => (state.warehouses.find((w) => w.id === id) || {}).name || 'غير محدد';
      flow.innerHTML = `
        <div class="fl"><span class="k good">جيد ${SamDB.fmt(good)}</span><span class="arrow">→</span><b>${esc(wh(state.routing.fgGoodWh))}</b> <em>سليم</em></div>
        <div class="fl"><span class="k bad">تالف علب ${SamDB.fmt(cans)}</span><span class="arrow">→</span><b>${esc(wh(state.routing.fgDefectWh))}</b> <em>تالف</em></div>
        <div class="fl"><span class="k bad">تالف أمبولة ${SamDB.fmt(amps)}</span><span class="arrow">→</span><b>${esc(wh(state.routing.rawDefectWh))}</b> <em>خام تالف</em></div>
        ${bags ? `<div class="fl"><span class="k">أكياس ${SamDB.fmt(bags)}</span><span class="arrow">→</span>خصم من صنف الأكياس</div>` : ''}`;
      return { good, cans, amps, bags, produced, expected, shortage, surplus };
    }
    cartonPieces.addEventListener('input', recompute);

    const mkBtn = (act, label, cls, ic) => {
      const b = el('button', `btn ${cls}`, `${ic ? icon(ic) : ''}<span>${esc(label)}</span>`);
      b.type = 'button';
      b.dataset.act = act;
      b.addEventListener('click', () => (act === 'cancel' ? close(null) : submit(act)));
      foot.appendChild(b);
    };
    mkBtn('save', doc ? 'حفظ التعديلات' : 'حفظ التقرير', 'btn-gold', 'i-check');
    mkBtn('print', 'حفظ وطباعة التقرير', 'btn-primary', 'i-print');
    mkBtn('cancel', 'إغلاق', 'btn-ghost');

    async function submit(action) {
      errBar.innerHTML = '';
      const t = recompute();
      const payload = {
        id: doc ? doc.id : null,
        doc_no: docNo.value.trim(),
        doc_date: docDate.value,
        issue_id: issueCombo.getValue(),
        raw_item_id: rawCombo.getValue(),
        carton_no: cartonNo.value,
        carton_pieces: SamDB.n(cartonPieces.value),
        bags_used: t.bags,
        note: note.value,
        lines: lines.map((l) => ({
          item_id: l.itemCombo.getValue(),
          good: SamDB.n(l.good.value),
          defect_cans: SamDB.n(l.cans.value),
          defect_ampoules: SamDB.n(l.amps.value),
          bags_used: SamDB.n(l.bags.value)
        }))
      };
      if (!payload.lines.length) {
        errBar.innerHTML = `${icon('i-warn')}<span>أضف منتجاً تاماً واحداً على الأقل</span>`;
        return;
      }
      foot.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
      try {
        const saved = await SamDB.call('saveReceipt', payload);
        toast(`تم حفظ تقرير الإنتاج ${saved.doc_no}`, 'ok');
        SamUI.bus.emit();
        close(saved);
        if (action === 'print') printReceipt(saved.id);
      } catch (e) {
        errBar.innerHTML = `${icon('i-warn')}<span>${esc(e.message)}</span>`;
      } finally {
        foot.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
      }
    }

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    let closed = false;
    function close(val) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(val);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    head.innerHTML = `<h3>${doc ? `تعديل تقرير الإنتاج ${esc(doc.doc_no)}` : 'تقرير الإنتاج اليومي'}</h3>`;
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);

    if (doc) doc.lines.forEach((l) => addLine(l));
    else addLine();
    recompute();
    return promise;
  }

  function renderReceipts() {
    const tb = document.querySelector('#receiptsTbl tbody');
    tb.innerHTML = '';
    state.receipts.forEach((r, idx) => {
      const sum = (k) => r.lines.reduce((a, l) => a + SamDB.n(l[k]), 0);
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(r.doc_no)}</td>
        <td>${esc(r.doc_date)}</td>
        <td class="mono">${esc(r.carton_no)}</td>
        <td>${esc(r.rawCode)} — ${esc(r.rawName)}</td>
        <td class="num">${SamDB.fmt(r.carton_pieces)}</td>
        <td class="num">${SamDB.fmt(r.produced_total)}</td>
        <td class="num qty plus">${SamDB.fmt(sum('good'))}</td>
        <td class="num qty">${SamDB.fmt(sum('defect_cans'))}</td>
        <td class="num qty">${SamDB.fmt(sum('defect_ampoules'))}</td>
        <td class="num">${SamDB.fmt(r.bags_used)}</td>
        <td class="num qty ${r.shortage ? 'minus' : ''}">${SamDB.fmt(r.shortage)}</td>
        <td class="num qty ${r.surplus ? 'plus' : ''}">${SamDB.fmt(r.surplus)}</td>`;
      bindRow(tr, {
        view: () => viewReceipt(r.id),
        edit: () => openReceiptForm(r.id),
        del: () => removeReceipt(r)
      });
      tb.appendChild(tr);
    });
    document.getElementById('receiptsEmpty').style.display = state.receipts.length ? 'none' : 'block';
  }

  async function viewReceipt(id) {
    const r = await SamDB.call('getReceipt', id);
    const html = tableHtml(
      [
        { key: 'no', label: 'م' },
        { key: 'item', label: 'المنتج التام' },
        { key: 'good', label: 'جيد' },
        { key: 'cans', label: 'تالف علب' },
        { key: 'amps', label: 'تالف أمبولة' },
        { key: 'bags', label: 'أكياس' }
      ],
      r.lines.map((l, i) => ({
        no: i + 1, item: `${l.itemCode} — ${l.itemName}`,
        good: SamDB.fmt(l.good), cans: SamDB.fmt(l.defect_cans),
        amps: SamDB.fmt(l.defect_ampoules), bags: SamDB.fmt(l.bags_used)
      })),
      SamDB.fmt(r.produced_total)
    );
    const v = await modal({
      title: `تقرير الإنتاج ${r.doc_no}`,
      width: 'min(820px, 95vw)',
      body: `<dl class="info">
          <dt>التاريخ</dt><dd>${esc(r.doc_date)}</dd>
          <dt>المادة الخام</dt><dd>${esc(r.rawCode)} — ${esc(r.rawName)}</dd>
          <dt>رقم الكرتونة</dt><dd>${esc(r.carton_no)}</dd>
          <dt>حبات الكرتونة</dt><dd>${SamDB.fmt(r.carton_pieces)}</dd>
          <dt>المنتَج الكلي</dt><dd>${SamDB.fmt(r.produced_total)}</dd>
          <dt>العجز</dt><dd>${SamDB.fmt(r.shortage)}</dd>
          <dt>الزيادة</dt><dd>${SamDB.fmt(r.surplus)}</dd>
          <dt>الأكياس المستخدمة</dt><dd>${SamDB.fmt(r.bags_used)}</dd>
          <dt>مرتبط بصرف</dt><dd>${esc(r.issueNo || '—')}</dd>
        </dl><div style="margin-top:14px">${html}</div>`,
      actions: [
        { label: 'طباعة التقرير', value: 'print', kind: 'btn-primary', icon: 'i-print' },
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    });
    if (v === 'edit') openReceiptForm(id);
    if (v === 'print') printReceipt(id);
  }

  async function printReceipt(id) {
    const r = await SamDB.call('getReceipt', id);
    const html = tableHtml(
      [
        { key: 'no', label: 'م' },
        { key: 'item', label: 'المنتج التام' },
        { key: 'good', label: 'جيد' },
        { key: 'cans', label: 'تالف علب' },
        { key: 'amps', label: 'تالف أمبولة' },
        { key: 'bags', label: 'أكياس مستخدمة' }
      ],
      r.lines.map((l, i) => ({
        no: i + 1, item: `${l.itemCode} — ${l.itemName}`,
        good: SamDB.fmt(l.good), cans: SamDB.fmt(l.defect_cans),
        amps: SamDB.fmt(l.defect_ampoules), bags: SamDB.fmt(l.bags_used)
      })),
      SamDB.fmt(r.produced_total)
    );
    const wh = (rid) => (state.warehouses.find((w) => w.id === rid) || {}).name || 'غير محدد';
    printPreview({
      title: 'تقرير الإنتاج اليومي',
      subtitle: `رقم التقرير ${r.doc_no} — كرتونة ${r.carton_no}`,
      head: [
        { k: 'التاريخ', v: r.doc_date },
        { k: 'المادة الخام', v: `${r.rawCode} — ${r.rawName}` },
        { k: 'حبات الكرتونة', v: SamDB.fmt(r.carton_pieces) },
        { k: 'المنتَج / العجز / الزيادة', v: `${SamDB.fmt(r.produced_total)} / ${SamDB.fmt(r.shortage)} / ${SamDB.fmt(r.surplus)}` }
      ],
      bodyHtml: `
        ${html}
        <div style="margin-top:6mm;font-size:10pt;line-height:1.9">
          <div><b>التوجيه التلقائي:</b></div>
          <div>الجيد → ${esc(wh(state.routing.fgGoodWh))} (سليم)</div>
          <div>تالف العلب → ${esc(wh(state.routing.fgDefectWh))} (تالف)</div>
          <div>تالف الأمبولة → ${esc(wh(state.routing.rawDefectWh))} (خام تالف)</div>
          <div>الأكياس المستخدمة → ${SamDB.fmt(r.bags_used)} كيس</div>
        </div>`,
      footer: 'SAM Management System — تقرير الإنتاج اليومي (الكميات بالحبة)',
      signatures: ['مشرف المناوبة', 'مراقب الجودة', 'أمين المخزن']
    });
  }

  async function removeReceipt(r) {
    const impact = await SamDB.call('receiptImpact', r.id);
    const yes = await confirmHardDelete({
      docNo: r.doc_no,
      docType: 'تقرير إنتاج يومي',
      lines: impact.lines,
      extra: `<p style="margin-top:10px;font-size:13px">المنتَج الكلي ${SamDB.fmt(r.produced_total)} حبة — عجز ${SamDB.fmt(r.shortage)} — زيادة ${SamDB.fmt(r.surplus)}. كل حركة مخزون ناتجة عن التقرير ستُحذف ويُعاد الرصيد فوراً.</p>`
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteReceipt', r.id);
      toast(`تم حذف التقرير ${r.doc_no} نهائياً وعكس كل حركاته`, 'bad', 4600);
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- wiring ---------------- */
  document.getElementById('btnNewIssue').addEventListener('click', () => openIssueForm(null));
  document.getElementById('btnNewReceipt').addEventListener('click', () => openReceiptForm(null));
  document.getElementById('btnSaveRouting').addEventListener('click', saveRouting);
  document.getElementById('prodTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll('#prodTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    document.getElementById('issuesPanel').classList.toggle('hidden', state.tab !== 'issues');
    document.getElementById('receiptsPanel').classList.toggle('hidden', state.tab !== 'receipts');
  });

  window.SamProd = { load, openIssueForm, openReceiptForm, printReceipt };
  SamUI.bus.on(load);
})();
