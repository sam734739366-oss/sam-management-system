'use strict';

/* =====================================================================
   Production — V2
     صرف الخام        : deducts raw material (base units)
     التقرير اليومي   : auto-routed output + bag fractions (bags × units − breaks)
     النفخ للغير      : the customer's own material; defects → scrap_movements
     سجل الهدر         : every customer-owned scrap row
     أرشيف الإنتاج    : a written record with zero stock effect
   ===================================================================== */
(function () {
  const {
    el, icon, esc, toast, bindRow, modal, form, field, input, numInput, textarea, combo,
    confirmHardDelete, confirmWarning, emptyState, toggleEmpty, tableHtml, printPreview
  } = SamUI;

  const state = { items: [], warehouses: [], parties: [], issues: [], receipts: [], tolling: [], scrap: [], archive: [], routing: {}, prodDocs: [], gap: null, tab: 'issues' };
  let rt = null;

  /* An edit carries today's date, never the date the record was first made.
     The original date stays visible so nothing is lost. */
  function dateHint(original) {
    if (!original || original === SamUI.today()) return '';
    return `تاريخ الإنشاء الأصلي: ${original} — التعديل يُسجَّل بتاريخ اليوم`;
  }

  const itemById = (id) => state.items.find((i) => i.id === Number(id)) || null;
  const whName = (id) => (state.warehouses.find((w) => w.id === Number(id)) || {}).name || 'غير محدد';
  const whOptions = () => state.warehouses.filter((w) => w.is_active)
    .map((w) => ({ id: w.id, label: w.name, code: w.code }));
  const itemOptions = (onlyRaw) => state.items
    .filter((i) => i.is_active)
    .filter((i) => !onlyRaw || (i.pieces_per_carton > 0))
    .map((i) => ({ id: i.id, label: i.name, code: i.code, sub: `${SamDB.fmt(i.mainStock.good)} ${i.base_unit}` }));

  /* ---------------- load ---------------- */
  async function load() {
    try {
      const [items, whs, parties, issues, receipts, routing, tolling, scrap, archive, prodDocs] = await Promise.all([
        SamDB.call('listItems', ''),
        SamDB.call('listWarehouses'),
        SamDB.call('listParties', ''),
        SamDB.call('listIssues', 200),
        SamDB.call('listReceipts', 200),
        SamDB.call('prodRouting'),
        SamDB.call('listTolling', 200),
        SamDB.call('listScrap', { limit: 300 }),
        SamDB.call('listArchive', 300),
        SamDB.call('listProdReceipts', 200)
      ]);
      Object.assign(state, { items, warehouses: whs, parties, issues, receipts, routing, tolling, scrap, archive, prodDocs });
      initRoutingUI();
      renderIssues();
      renderReceipts();
      renderTolling();
      renderScrap();
      renderArchive();
      renderProdDocs();
      await loadGap();
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

  /* ---------------- issue raw material to production ---------------- */
  function openIssueForm(row) {
    const editing = !!row;
    const body = el('div');
    const grid = el('div', 'form-grid');

    const docNo = input({ value: editing ? row.doc_no : '', placeholder: 'يُولَّد تلقائياً' });
    const docDate = input({ type: 'date', value: SamUI.today() });
    const cartons = numInput({ value: editing ? row.cartons : 0, placeholder: '0' });
    const pieces = numInput({ value: editing ? row.pieces : 0, placeholder: '0' });
    const note = input({ value: editing ? row.note || '' : '', placeholder: 'ملاحظة' });

    const itemHost = el('div');
    const whHost = el('div');
    const itemCombo = combo(itemHost, { placeholder: 'اكتب جزءاً من اسم المادة الخام…', emptyText: 'لا يوجد صنف مطابق', items: itemOptions(true) });
    const whCombo = combo(whHost, { placeholder: 'مخزن المصدر…', items: whOptions() });
    itemCombo.setValue(editing ? row.item_id : null, false);
    whCombo.setValue(editing ? row.warehouse_id : (state.warehouses[0] || {}).id || null, false);

    const hint = el('p', 'foot-note');
    const syncPieces = () => {
      const it = itemById(itemCombo.getValue());
      const c = SamDB.n(cartons.value);
      if (it && it.pieces_per_carton > 0 && c > 0) {
        pieces.value = SamDB.fmt(it.pieces_per_carton * c);
        hint.textContent = `محسوب تلقائياً: ${SamDB.fmt(c)} كرتونة × ${SamDB.fmt(it.pieces_per_carton)} ${it.base_unit} = ${pieces.value} — عدّله يدوياً إن لزم.`;
      } else if (it) {
        hint.textContent = `هذا الصنف لا يحمل «وحدات لكل كرتونة» — أدخل الكمية بالوحدة الأساسية (${it.base_unit}) يدوياً.`;
      } else hint.textContent = '';
    };
    itemCombo.opts.onChange = syncPieces;
    cartons.addEventListener('input', syncPieces);

    const noteField = field('ملاحظة', note, '', 'i-clipboard');
    noteField.classList.add('full');
    grid.append(
      field('رقم الصرف', docNo, '', 'i-hash'),
      field('التاريخ', docDate, editing ? dateHint(row.doc_date) : '', 'i-calendar'),
      field('المادة الخام', itemHost, '', 'i-box'),
      field('مخزن المصدر', whHost, '', 'i-warehouse'),
      field('عدد الكراتين', cartons, 'معلوماتي', 'i-archive-box'),
      field('الكمية بالوحدة الأساسية', pieces, '', 'i-sigma'),
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
        if (!payload.item_id) throw new Error('اختر صنف المادة الخام');
        const avail = await SamDB.call('availablePieces', payload.item_id, 'good', payload.id);
        if (payload.pieces > avail) {
          const it = itemById(payload.item_id) || {};
          const yes = await confirmWarning({
            title: 'الرصيد غير كافٍ',
            lines: [{
              item: `${it.code} — ${it.name}`,
              text: `المتاح ${SamDB.fmt(avail)} والصرف ${SamDB.fmt(payload.pieces)} → الرصيد يصبح ${SamDB.fmt(avail - payload.pieces)}`
            }]
          });
          if (yes !== 'yes') throw new Error('أُلغيت العملية — الرصيد غير كافٍ');
        }
        const saved = await SamDB.call('saveIssue', payload);
        toast(`تم حفظ صرف ${saved.doc_no} (${SamDB.fmt(saved.pieces)} حبة)`, 'ok');
        if (saved.warning) toast(saved.warning, 'warn', 5200);
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
        <td class="num">${i.cartons ? SamDB.fmt(i.cartons) : '—'}</td>
        <td class="num qty minus">−${SamDB.fmt(i.pieces)}</td>
        <td>${esc(i.note || '—')}</td>`;
      bindRow(tr, {
        view: () => viewIssue(i),
        edit: () => openIssueForm(i),
        del: () => removeIssue(i)
      });
      tb.appendChild(tr);
    });
    emptyState('issuesEmpty', {
      title: 'لا توجد مصروفات خام',
      hint: 'اصرف الكراتين من المخزن إلى خط الإنتاج لتبدأ الدورة.',
      actionLabel: 'صرف خام جديد',
      onAction: () => openIssueForm(null)
    });
    toggleEmpty('issuesEmpty', state.issues.length > 0);
  }

  function viewIssue(i) {
    modal({
      title: `صرف مواد خام — ${i.doc_no}`,
      body: `<dl class="info">
        <dt>التاريخ</dt><dd>${esc(i.doc_date)}</dd>
        <dt>المادة الخام</dt><dd>${esc(i.itemCode)} — ${esc(i.itemName)}</dd>
        <dt>مخزن المصدر</dt><dd>${esc(i.warehouseName)}</dd>
        <dt>الكراتين (معلوماتي)</dt><dd>${i.cartons ? SamDB.fmt(i.cartons) : '—'}</dd>
        <dt>الكمية المصروفة</dt><dd>${SamDB.fmt(i.pieces)} حبة</dd>
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
    const docDate = input({ type: 'date', value: SamUI.today() });
    const cartonNo = input({ value: doc ? doc.carton_no : '', placeholder: 'مثال: C-2026-10-301' });
    const cartonPieces = numInput({ value: doc ? doc.carton_pieces : 0, placeholder: '0' });
    const note = input({ value: doc ? doc.note || '' : '', placeholder: 'ملاحظات' });

    const rawHost = el('div');
    const issueHost = el('div');
    const rawCombo = combo(rawHost, { placeholder: 'اكتب اسم المادة الخام…', emptyText: 'لا يوجد صنف مطابق', items: itemOptions(true) });
    const issueCombo = combo(issueHost, {
      placeholder: 'مرتبط بصرف (اختياري)…',
      emptyText: 'لا توجد مصروفات',
      items: issues.map((i) => ({ id: i.id, label: `${i.itemName} — ${SamDB.fmt(i.pieces)} حبة`, code: i.doc_no, sub: i.warehouseName }))
    });
    rawCombo.setValue(doc ? doc.raw_item_id : null, false);
    issueCombo.setValue(doc ? doc.issue_id : null, false);
    rawCombo.opts.onChange = (v) => {
      const it = itemById(v);
      if (it && it.pieces_per_carton > 0 && !cartonPieces.value) cartonPieces.value = SamDB.fmt(it.pieces_per_carton);
    };
    issueCombo.opts.onChange = (v) => {
      const i = issues.find((x) => x.id === v);
      if (!i) return;
      rawCombo.setValue(i.item_id, false);
      if (i.pieces) cartonPieces.value = SamDB.fmt(i.pieces);
    };

    const cell = (label, node, cls) => {
      const c = el('div', `ed-cell ${cls || ''}`);
      c.appendChild(el('label', '', esc(label)));
      c.appendChild(node);
      return c;
    };
    const grid = el('div', 'ed-grid');
    grid.append(
      cell('رقم التقرير', docNo),
      (() => { const c = cell('التاريخ', docDate); const h = dateHint(doc && doc.doc_date); if (h) c.appendChild(el('em', 'hint-txt', h)); return c; })(),
      cell('رقم الكرتونة', cartonNo),
      cell('المادة الخام', rawHost),
      cell('حبات الكرتونة (المتوقع)', cartonPieces),
      cell('مرتبط بصرف', issueHost),
      cell('ملاحظات', note, 'full')
    );
    body.appendChild(grid);

    body.appendChild(el('div', 'ed-sec', `${SamUI.iconTile('i-factory', 'tone-produce', 'sm')}<span>المنتجات التامة — الكيس × وحداته − الكسر = الجيد</span>`));
    const linesTbl = el('table', 'tbl lines-tbl');
    linesTbl.innerHTML = `<thead><tr>
        <th style="width:26%">المنتج التام</th>
        <th style="width:74px">الوحدة</th>
        <th style="width:92px">أكياس</th><th style="width:92px">كسر</th>
        <th style="width:104px">جيد</th>
        <th style="width:96px">تالف علب</th><th style="width:104px">تالف أمبولة</th>
        <th style="width:40px"></th></tr></thead><tbody></tbody>`;
    const linesBody = linesTbl.querySelector('tbody');
    body.appendChild(linesTbl);
    body.appendChild(el('p', 'foot-note', 'اكتب عدد الأكياس وعدد المكسور (الكسر)؛ يُحسب الجيد تلقائياً من «وحدات لكل كيس» المسجلة في الصنف. عدّل خانة الجيد يدوياً لتجاوز الحساب التلقائي.'));

    const flow = el('div', 'flow-bar');
    body.appendChild(flow);
    const totals = el('div', 'totals-bar');
    body.appendChild(totals);

    const addRow = el('button', 'btn btn-sm btn-ghost', `${SamUI.iconTile('i-plus', 'tone-ok', 'xs')}<span class="btn-txt">إضافة منتج</span>`);
    addRow.type = 'button';
    addRow.addEventListener('click', () => addLine());
    body.appendChild(el('div', 'row-add').appendChild(addRow).parentNode);

    const lines = [];

    function addLine(data) {
      const tr = el('tr');
      const itemHost = el('div');
      const unitBox = el('div');
      const bags = numInput({ value: data ? data.bags_used : 0, placeholder: '0' });
      const breaks = numInput({ value: data ? data.breaks : 0, placeholder: '0' });
      const good = numInput({ value: data ? data.good : 0, placeholder: '0' });
      const cans = numInput({ value: data ? data.defect_cans : 0, placeholder: '0' });
      const amps = numInput({ value: data ? data.defect_ampoules : 0, placeholder: '0' });
      const del = el('button', 'row-del', '×');
      del.type = 'button';

      const l = { itemCombo: null, bags, breaks, good, cans, amps, unitEl: unitBox, autoGood: !data || !SamDB.n(data.good) };
      l.itemCombo = combo(itemHost, {
        placeholder: 'اكتب اسم المنتج…',
        emptyText: 'لا يوجد صنف مطابق',
        items: itemOptions(false),
        onChange: () => { paintUnit(l); autoCompute(l); recompute(); }
      });
      if (data) l.itemCombo.setValue(data.item_id, false);

      const autoTick = () => { l.autoGood = true; autoCompute(l); recompute(); };
      bags.addEventListener('input', () => { autoTick(); });
      breaks.addEventListener('input', () => { autoTick(); });
      good.addEventListener('input', () => { l.autoGood = false; recompute(); });
      [cans, amps].forEach((n) => n.addEventListener('input', recompute));
      del.addEventListener('click', () => {
        const i = lines.indexOf(l);
        if (i >= 0) lines.splice(i, 1);
        tr.remove();
        recompute();
      });
      tr.append(
        el('td').appendChild(itemHost).parentNode,
        el('td', 'unit-c').appendChild(unitBox).parentNode,
        el('td').appendChild(bags).parentNode,
        el('td').appendChild(breaks).parentNode,
        el('td').appendChild(good).parentNode,
        el('td').appendChild(cans).parentNode,
        el('td').appendChild(amps).parentNode,
        el('td').appendChild(del).parentNode
      );
      linesBody.appendChild(tr);
      lines.push(l);
      paintUnit(l);
      return l;
    }

    function paintUnit(l) {
      const it = itemById(l.itemCombo.getValue());
      l.unitEl.innerHTML = it ? `<span class="unit-chip">${esc(it.base_unit)}</span>` : '<span class="muted">—</span>';
    }

    /** good = bags × units-per-bag − breaks, while the user lets us compute it */
    function autoCompute(l) {
      if (!l.autoGood) return;
      const it = itemById(l.itemCombo.getValue());
      const b = SamDB.n(l.bags.value);
      const k = SamDB.n(l.breaks.value);
      if (!it || !(it.pieces_per_bag > 0)) return;
      const g = Math.max(0, b * it.pieces_per_bag - k);
      l.good.value = g ? SamDB.fmt(g) : '';
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
        <span>الأكياس: <b>${SamDB.fmt(bags)}</b></span>`;
      flow.innerHTML = `
        <div class="fl"><span class="k good">جيد ${SamDB.fmt(good)}</span><span class="arrow">→</span><b>${esc(whName(state.routing.fgGoodWh))}</b> <em>سليم</em></div>
        <div class="fl"><span class="k bad">تالف علب ${SamDB.fmt(cans)}</span><span class="arrow">→</span><b>${esc(whName(state.routing.fgDefectWh))}</b> <em>تالف</em></div>
        <div class="fl"><span class="k bad">تالف أمبولة ${SamDB.fmt(amps)}</span><span class="arrow">→</span><b>${esc(whName(state.routing.rawDefectWh))}</b> <em>خام تالف</em></div>
        ${bags ? `<div class="fl"><span class="k">أكياس ${SamDB.fmt(bags)}</span><span class="arrow">→</span>خصم من صنف الأكياس</div>` : ''}`;
      return { good, cans, amps, bags, produced, expected, shortage, surplus };
    }
    cartonPieces.addEventListener('input', recompute);

    const mkBtn = (act, label, cls, ic, kbd) => {
      const b = el('button', `btn ${cls}`, `${ic ? SamUI.iconTile(ic, null, 'xs') : ''}<span class="btn-txt">${esc(label)}</span>${kbd ? `<span class="kbd">${kbd}</span>` : ''}`);
      b.type = 'button';
      b.dataset.act = act;
      b.addEventListener('click', () => (act === 'cancel' ? close(null) : submit(act)));
      foot.appendChild(b);
      return b;
    };
    mkBtn('save', doc ? 'حفظ التعديلات' : 'حفظ التقرير', 'btn-primary', 'i-check', 'Ctrl+S');
    mkBtn('print', 'حفظ وطباعة التقرير', 'btn-gold', 'i-print');
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
          bags_used: SamDB.n(l.bags.value),
          breaks: SamDB.n(l.breaks.value)
        }))
      };
      if (!payload.lines.length) {
        errBar.innerHTML = `${SamUI.iconTile('i-warn', 'tone-adjust', 'xs')}<span>أضف منتجاً تاماً واحداً على الأقل</span>`;
        return;
      }
      // consuming more raw than we have is allowed, but never silently
      const rawId = payload.raw_item_id;
      if (rawId) {
        const avail = await SamDB.call('availablePieces', rawId, 'good', payload.id);
        if (t.produced > avail) {
          const it = itemById(rawId) || {};
          const yes = await confirmWarning({
            title: 'الرصيد غير كافٍ',
            note: 'المنتَج أكبر من الخام المتاح. يمكنك المتابعة وسيصبح الرصيد سالباً.',
            lines: [{ item: `${it.code} — ${it.name}`, text: `المتاح ${SamDB.fmt(avail)} والمطلوب ${SamDB.fmt(t.produced)} → الرصيد ${SamDB.fmt(avail - t.produced)}` }]
          });
          if (yes !== 'yes') return;
        }
      }
      foot.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
      try {
        const saved = await SamDB.call('saveReceipt', payload);
        toast(`تم حفظ تقرير الإنتاج ${saved.doc_no}`, 'ok');
        SamUI.bus.emit();
        close(saved);
        if (action === 'print') printReceipt(saved.id);
      } catch (e) {
        errBar.innerHTML = `${SamUI.iconTile('i-warn', 'tone-adjust', 'xs')}<span>${esc(e.message)}</span>`;
      } finally {
        foot.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
      }
    }

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    let closed = false;
    let pop = null;
    function close(val) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (pop) pop();
      ov.remove();
      resolve(val);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    head.innerHTML = `<h3>${doc ? `تعديل تقرير الإنتاج ${esc(doc.doc_no)}` : 'تقرير الإنتاج اليومي'}</h3>`;
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);
    pop = SamUI.pushKeys({ save: () => submit('save'), print: () => (doc ? printReceipt(doc.id) : submit('print')) });

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
    emptyState('receiptsEmpty', {
      title: 'لا توجد تقارير إنتاج',
      hint: 'سجّل تقرير اليوم: رقم الكرتونة، الخام، والمنتجات التامة — تقرير توثيقي بلا أثر على المخزون.',
      actionLabel: 'تقرير إنتاج يومي',
      onAction: () => openReceiptForm(null)
    });
    toggleEmpty('receiptsEmpty', state.receipts.length > 0);
  }

  function receiptTable(r) {
    return tableHtml(
      [
        { key: 'no', label: 'م', align: 'center' },
        { key: 'item', label: 'المنتج التام' },
        { key: 'unit', label: 'الوحدة', align: 'center' },
        { key: 'bags', label: 'أكياس', align: 'center' },
        { key: 'breaks', label: 'كسر', align: 'center' },
        { key: 'good', label: 'جيد', align: 'end' },
        { key: 'cans', label: 'تالف علب', align: 'end' },
        { key: 'amps', label: 'تالف أمبولة', align: 'end' }
      ],
      r.lines.map((l, i) => ({
        no: i + 1, item: `${l.itemCode} — ${l.itemName}`, unit: l.baseUnit,
        bags: SamDB.fmt(l.bags_used), breaks: SamDB.fmt(l.breaks),
        good: SamDB.fmt(l.good), cans: SamDB.fmt(l.defect_cans),
        amps: SamDB.fmt(l.defect_ampoules)
      })),
      SamDB.fmt(r.produced_total)
    );
  }

  async function viewReceipt(id) {
    const r = await SamDB.call('getReceipt', id);
    const v = await modal({
      title: `تقرير الإنتاج ${r.doc_no}`,
      width: 'min(860px, 95vw)',
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
          <dt>ملاحظة</dt><dd>${esc(r.note || '—')}</dd>
        </dl><div style="margin-top:14px">${receiptTable(r)}</div>`,
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
    printPreview({
      title: 'تقرير الإنتاج اليومي',
      docRef: r.doc_no,
      docRefLabel: 'رقم التقرير',
      head: [
        { k: 'رقم الكرتونة', v: r.carton_no },
        { k: 'رقم التقرير', v: r.doc_no },
        { k: 'التاريخ', v: r.doc_date }
      ],
      bodyHtml: `
        ${receiptTable(r)}
        <div style="margin-top:6mm;font-size:10pt;line-height:1.9">
          <div><b>المادة الخام:</b> ${esc(r.rawCode)} — ${esc(r.rawName)} &nbsp;·&nbsp; <b>حبات الكرتونة:</b> ${SamDB.fmt(r.carton_pieces)}
          &nbsp;·&nbsp; <b>المنتَج:</b> ${SamDB.fmt(r.produced_total)} &nbsp;·&nbsp; <b>العجز:</b> ${SamDB.fmt(r.shortage)} &nbsp;·&nbsp; <b>الزيادة:</b> ${SamDB.fmt(r.surplus)}</div>
          <div style="margin-top:3mm"><b>ملاحظة:</b></div>
          <div>هذا التقرير توثيقي — لا يُنشئ أي حركة مخزون ولا يغيّر أي رصيد.</div>
          <div>دخول الإنتاج إلى المخزن يتم بـ«سند استلام الإنتاج» (مخزن لكل سطر + تصريح خروج).</div>
          ${r.note ? `<div style="margin-top:2mm"><b>ملاحظات:</b> ${esc(r.note)}</div>` : ''}
        </div>`,
      footer: 'SAM Management System — تقرير الإنتاج اليومي (الكميات بالوحدة الأساسية)',
      signatures: ['مشرف المناوبة', 'أمين المخزن', 'المدير']
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

  /* ---------------- tolling — النفخ للغير ---------------- */
  async function openTollingForm(id) {
    const doc = id ? await SamDB.call('getTolling', id) : null;
    let parties = [];
    try { parties = state.parties.length ? state.parties : await SamDB.call('listParties', ''); } catch (e) { parties = []; }

    const body = el('div');
    const grid = el('div', 'form-grid');

    const docNo = input({ value: doc ? doc.doc_no : '', placeholder: 'يُولَّد تلقائياً' });
    const docDate = input({ type: 'date', value: SamUI.today() });
    const piecesIn = numInput({ value: doc ? doc.pieces_in : 0, placeholder: '0' });
    const bagsIn = numInput({ value: doc ? doc.bags_in : 0, placeholder: '0' });
    const note = input({ value: doc ? doc.note || '' : '', placeholder: 'ملاحظات' });

    const partyHost = el('div');
    const rawHost = el('div');
    const whHost = el('div');
    const partyCombo = combo(partyHost, {
      placeholder: 'ابحث عن العميل صاحب المادة…',
      emptyText: 'لا يوجد عملاء مطابقون',
      items: parties.filter((p) => p.is_active && (p.type === 'customer' || p.type === 'both'))
        .map((p) => ({ id: p.id, label: p.name, code: p.phone || '', sub: SamParties.TYPE_AR[p.type] })),
      onAdd: async () => {
        const saved = await SamParties.quickAdd();
        if (saved) {
          await load();
          partyCombo.setItems(state.parties.filter((p) => p.is_active)
            .map((p) => ({ id: p.id, label: p.name, code: p.phone || '', sub: SamParties.TYPE_AR[p.type] })));
          partyCombo.setValue(saved.id, true);
        }
      }
    });
    partyCombo.setValue(doc ? doc.party_id : null, false);
    const rawCombo = combo(rawHost, { placeholder: 'صنف المادة الخام المستلمة…', emptyText: 'لا يوجد صنف مطابق', items: itemOptions(false) });
    rawCombo.setValue(doc ? doc.raw_item_id : null, false);
    const whCombo = combo(whHost, { placeholder: 'مخزن الاستلام…', items: whOptions() });
    whCombo.setValue(doc ? doc.warehouse_id : (state.warehouses[0] || {}).id || null, false);

    grid.append(
      field('رقم المستند', docNo, '', 'i-hash'),
      field('التاريخ', docDate, doc ? dateHint(doc.doc_date) : '', 'i-calendar'),
      field('العميل (صاحب المادة)', partyHost, '', 'i-user'),
      field('المادة الخام', rawHost, '', 'i-box'),
      field('مخزن الاستلام', whHost, '', 'i-warehouse'),
      field('الحبات المستلمة', piecesIn, '', 'i-sigma'),
      field('الأكياس المستلمة', bagsIn, 'معلوماتي', 'i-archive'),
      (() => { const f = field('ملاحظات', note, '', 'i-clipboard'); f.classList.add('full'); return f; })()
    );
    body.appendChild(grid);

    body.appendChild(el('div', 'form-sec', `${SamUI.iconTile('i-tolling', 'tone-produce', 'xs')}<span>ما سُلِّم للعميل وما هدر</span>`));
    const tbl = el('table', 'tbl lines-tbl');
    tbl.innerHTML = `<thead><tr>
      <th style="width:36%">المنتج المنفوخ</th><th style="width:80px">الوحدة</th>
      <th style="width:110px">جيد (يُسلَّم)</th><th style="width:110px">تالف (هدر)</th>
      <th style="width:100px">أكياس</th><th style="width:40px"></th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    body.appendChild(tbl);

    const out = el('div', 'totals-bar');
    body.appendChild(out);
    const addBtn = el('button', 'btn btn-sm btn-ghost', `${SamUI.iconTile('i-plus', 'tone-ok', 'xs')}<span class="btn-txt">إضافة سطر</span>`);
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => addLine());
    body.appendChild(el('div', 'row-add').appendChild(addBtn).parentNode);
    body.appendChild(el('p', 'foot-note', 'المادة ملك العميل: الجيد يخرج له، والتالف يُسجَّل في «سجل الهدر» معلَّماً كمادة العميل (is_customer = 1) ويبقى في المخزن بحالة تالف.'));

    const lines = [];
    function paintUnit(l) {
      const it = itemById(l.itemCombo.getValue());
      l.unitEl.innerHTML = it ? `<span class="unit-chip">${esc(it.base_unit)}</span>` : '<span class="muted">—</span>';
    }
    function recompute() {
      const good = lines.reduce((a, l) => a + SamDB.n(l.good.value), 0);
      const defect = lines.reduce((a, l) => a + SamDB.n(l.defect.value), 0);
      const inQty = SamDB.n(piecesIn.value);
      out.innerHTML = `<span>مستلم: <b>${SamDB.fmt(inQty)}</b></span>
        <span>مُسلَّم للعميل: <b class="big">${SamDB.fmt(good)}</b></span>
        <span>هدر: <b class="neg">${SamDB.fmt(defect)}</b></span>
        <span>باقٍ داخل المخزن: <b class="${inQty - good - defect < 0 ? 'neg' : ''}">${SamDB.fmt(inQty - good - defect)}</b></span>`;
    }
    function addLine(data) {
      const tr = el('tr');
      const host = el('div');
      const unitBox = el('div');
      const good = numInput({ value: data ? data.good : 0, placeholder: '0' });
      const defect = numInput({ value: data ? data.defect : 0, placeholder: '0' });
      const bags = numInput({ value: data ? data.bags : 0, placeholder: '0' });
      const del = el('button', 'row-del', '×');
      del.type = 'button';
      const l = { itemCombo: null, good, defect, bags, unitEl: unitBox };
      l.itemCombo = combo(host, {
        placeholder: 'اكتب اسم المنتج…',
        emptyText: 'لا يوجد صنف مطابق',
        items: itemOptions(false),
        onChange: () => { paintUnit(l); recompute(); }
      });
      if (data) l.itemCombo.setValue(data.item_id, false);
      [good, defect, bags].forEach((n) => n.addEventListener('input', recompute));
      del.addEventListener('click', () => {
        const i = lines.indexOf(l);
        if (i >= 0) lines.splice(i, 1);
        tr.remove();
        recompute();
      });
      tr.append(el('td').appendChild(host).parentNode,
        el('td', 'unit-c').appendChild(unitBox).parentNode,
        el('td').appendChild(good).parentNode,
        el('td').appendChild(defect).parentNode,
        el('td').appendChild(bags).parentNode,
        el('td').appendChild(del).parentNode);
      tb.appendChild(tr);
      lines.push(l);
      paintUnit(l);
      return l;
    }
    piecesIn.addEventListener('input', recompute);
    if (doc) doc.lines.forEach((l) => addLine(l));
    else addLine();
    recompute();

    const ok = await form({
      title: doc ? `تعديل نفخ للغير ${doc.doc_no}` : 'مستند نفخ للغير',
      body,
      wide: true,
      submitLabel: 'حفظ المستند',
      async onSubmit() {
        const payload = {
          id: doc ? doc.id : null,
          doc_no: docNo.value.trim(),
          doc_date: docDate.value,
          party_id: partyCombo.getValue(),
          raw_item_id: rawCombo.getValue(),
          warehouse_id: whCombo.getValue(),
          pieces_in: SamDB.n(piecesIn.value),
          bags_in: SamDB.n(bagsIn.value),
          note: note.value,
          lines: lines.map((l) => ({
            item_id: l.itemCombo.getValue(),
            good: SamDB.n(l.good.value),
            defect: SamDB.n(l.defect.value),
            bags: SamDB.n(l.bags.value)
          })).filter((l) => l.item_id || l.good || l.defect)
        };
        if (!payload.lines.length) throw new Error('أضف سطراً واحداً على الأقل');
        const saved = await SamDB.call('saveTolling', payload);
        toast(`تم حفظ ${saved.doc_no} — مُسلَّم ${SamDB.fmt(saved.totalGood)} وهدر ${SamDB.fmt(saved.totalDefect)}`, 'ok');
        if (saved.warnings && saved.warnings.length) toast(saved.warnings[0], 'warn', 5600);
        SamUI.bus.emit();
        return saved;
      }
    });
    if (ok) await load();
  }

  function renderTolling() {
    const tb = document.querySelector('#tollingTbl tbody');
    tb.innerHTML = '';
    state.tolling.forEach((t, idx) => {
      const good = t.lines.reduce((a, l) => a + SamDB.n(l.good), 0);
      const defect = t.lines.reduce((a, l) => a + SamDB.n(l.defect), 0);
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(t.doc_no)}</td>
        <td>${esc(t.doc_date)}</td>
        <td>${esc(t.partyName)}</td>
        <td>${esc(t.rawCode)} — ${esc(t.rawName)}</td>
        <td class="num qty plus">${SamDB.fmt(t.pieces_in)}</td>
        <td class="num qty">${SamDB.fmt(good)}</td>
        <td class="num qty ${defect ? 'minus' : ''}">${SamDB.fmt(defect)}</td>
        <td>${esc(t.warehouseName || '—')}</td>
        <td>${esc(t.note || '—')}</td>`;
      bindRow(tr, {
        view: () => viewTolling(t.id),
        edit: () => openTollingForm(t.id),
        del: () => removeTolling(t)
      });
      tb.appendChild(tr);
    });
    emptyState('tollingEmpty', {
      icon: 'i-tolling',
      title: 'لا توجد عمليات نفخ للغير',
      hint: 'استلم مادة العميل، نفخها، ثم سلّمه الجيد وسجّل التالف في سجل الهدر.',
      actionLabel: 'مستند نفخ للغير',
      onAction: () => openTollingForm(null)
    });
    toggleEmpty('tollingEmpty', state.tolling.length > 0);
  }

  async function viewTolling(id) {
    const t = await SamDB.call('getTolling', id);
    const html = tableHtml(
      [
        { key: 'no', label: 'م', align: 'center' },
        { key: 'item', label: 'المنتج المنفوخ' },
        { key: 'unit', label: 'الوحدة', align: 'center' },
        { key: 'good', label: 'جيد (مُسلَّم)', align: 'end' },
        { key: 'defect', label: 'تالف (هدر)', align: 'end' },
        { key: 'bags', label: 'أكياس', align: 'center' }
      ],
      t.lines.map((l, i) => ({
        no: i + 1, item: `${l.itemCode} — ${l.itemName}`, unit: l.baseUnit,
        good: SamDB.fmt(l.good), defect: SamDB.fmt(l.defect), bags: SamDB.fmt(l.bags)
      })),
      SamDB.fmt(t.totalGood)
    );
    const v = await modal({
      title: `نفخ للغير — ${t.doc_no}`,
      width: 'min(820px, 95vw)',
      body: `<dl class="info">
          <dt>التاريخ</dt><dd>${esc(t.doc_date)}</dd>
          <dt>العميل</dt><dd>${esc(t.partyName)}${t.partyPhone ? ` — ${esc(t.partyPhone)}` : ''}</dd>
          <dt>المادة الخام</dt><dd>${esc(t.rawCode)} — ${esc(t.rawName)}</dd>
          <dt>المخزن</dt><dd>${esc(t.warehouseName || '—')}</dd>
          <dt>المستلم</dt><dd>${SamDB.fmt(t.pieces_in)} ${esc(t.rawUnit)}</dd>
          <dt>المُسلَّم للعميل</dt><dd>${SamDB.fmt(t.totalGood)}</dd>
          <dt>الهدر (مادة العميل)</dt><dd>${SamDB.fmt(t.totalDefect)}</dd>
        </dl><div style="margin-top:14px">${html}</div>`,
      actions: [
        { label: 'طباعة المستند', value: 'print', kind: 'btn-primary', icon: 'i-print' },
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    });
    if (v === 'edit') openTollingForm(id);
    if (v === 'print') printTolling(id);
  }

  async function printTolling(id) {
    const t = await SamDB.call('getTolling', id);
    const html = tableHtml(
      [
        { key: 'no', label: 'م', align: 'center' },
        { key: 'item', label: 'المنتج' },
        { key: 'unit', label: 'الوحدة', align: 'center' },
        { key: 'good', label: 'جيد', align: 'end' },
        { key: 'defect', label: 'تالف', align: 'end' }
      ],
      t.lines.map((l, i) => ({
        no: i + 1, item: `${l.itemCode} — ${l.itemName}`, unit: l.baseUnit,
        good: SamDB.fmt(l.good), defect: SamDB.fmt(l.defect)
      })),
      SamDB.fmt(t.totalGood)
    );
    printPreview({
      title: 'مستند نفخ للغير',
      subtitle: 'مادة العميل — الكميات فقط',
      docRef: t.doc_no,
      docRefLabel: 'رقم المستند',
      head: [
        { k: 'العميل', v: t.partyName },
        { k: 'رقم المستند', v: t.doc_no },
        { k: 'التاريخ', v: t.doc_date }
      ],
      bodyHtml: `${html}
        <p class="doc-note" style="margin-top:4mm">
          <b>المستلم:</b> ${SamDB.fmt(t.pieces_in)} ${esc(t.rawUnit)} &nbsp;·&nbsp;
          <b>المُسلَّم:</b> ${SamDB.fmt(t.totalGood)} &nbsp;·&nbsp;
          <b>الهدر (يبقى بملكية العميل):</b> ${SamDB.fmt(t.totalDefect)}
          ${t.note ? `<br><b>ملاحظات:</b> ${esc(t.note)}` : ''}
        </p>`,
      footer: 'SAM Management System — نفخ للغير',
      signatures: ['السائق', 'أمين المخزن', 'المدير']
    });
  }

  async function removeTolling(t) {
    const impact = await SamDB.call('tollingImpact', t.id);
    const yes = await confirmHardDelete({
      docNo: t.doc_no,
      docType: 'نفخ للغير',
      lines: impact.lines,
      extra: `<p style="margin-top:10px;font-size:13px">مُسلَّم ${SamDB.fmt(impact.totalGood)} — هدر ${SamDB.fmt(impact.scrap)} حبة من مادة العميل. الحذف يعكس الحركات ويسجل الهدر المرتبط.</p>`
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteTolling', t.id);
      toast(`تم حذف مستند ${t.doc_no} نهائياً`, 'bad', 4400);
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- scrap register ---------------- */
  const SCRAP_SRC = { tolling: 'نفخ للغير', production: 'إنتاج', internal: 'داخلي' };

  function renderScrap() {
    const tb = document.querySelector('#scrapTbl tbody');
    tb.innerHTML = '';
    state.scrap.forEach((s, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td>${esc(s.created_at)}</td>
        <td><span class="chip sub">${esc(SCRAP_SRC[s.source] || s.source)}</span></td>
        <td>${s.is_customer ? `<span class="chip accent">${esc(s.partyName || 'العميل')}</span>` : '<span class="chip main">المصنع</span>'}</td>
        <td>${esc(s.itemCode || '—')} — ${esc(s.itemName || '—')}</td>
        <td class="num qty">${SamDB.fmt(s.pieces)}</td>
        <td><span class="chip ${s.bucket === 'defect' ? 'bad' : 'ok'}">${{ good: 'سليم', defect: 'تالف' }[s.bucket] || s.bucket}</span></td>
        <td class="mono">${esc(s.doc_no || '—')}</td>`;
      bindRow(tr, {
        view: () => modal({
          title: `سجل هدر #${s.id}`,
          body: `<dl class="info">
            <dt>المصدر</dt><dd>${esc(SCRAP_SRC[s.source] || s.source)}</dd>
            <dt>المالك</dt><dd>${s.is_customer ? 'العميل' : 'المصنع'}</dd>
            <dt>الطرف</dt><dd>${esc(s.partyName || '—')}</dd>
            <dt>الصنف</dt><dd>${esc(s.itemName || '—')}</dd>
            <dt>الكمية</dt><dd>${SamDB.fmt(s.pieces)} ${esc(s.baseUnit || '')}</dd>
            <dt>الحالة</dt><dd>${esc(s.bucket === 'defect' ? 'تالف' : s.bucket)}</dd>
            <dt>المستند</dt><dd>${esc(s.doc_no || '—')}</dd>
            <dt>التاريخ</dt><dd>${esc(s.created_at)}</dd>
          </dl>`,
          actions: [
            { label: 'حذف السجل', value: 'del', kind: 'btn-danger', icon: 'i-trash' },
            { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
          ]
        }).then(async (v) => {
          if (v !== 'del') return;
          try {
            await SamDB.call('deleteScrap', s.id);
            toast('تم حذف سجل الهدر وحركته المرتبطة', 'bad');
            await load();
          } catch (e) { toast(e.message, 'bad'); }
        })
      });
      tb.appendChild(tr);
    });
    emptyState('scrapEmpty', {
      icon: 'i-scrap',
      title: 'لا يوجد هدر مسجل',
      hint: 'كل تالف ينتج عن النفخ للغير يظهر هنا معلَّماً كمادة العميل.'
    });
    toggleEmpty('scrapEmpty', state.scrap.length > 0);
  }

  /* ---------------- archive (no stock effect) ---------------- */
  function openArchiveForm(row) {
    const editing = !!row;
    const body = el('div');
    const grid = el('div', 'form-grid');

    const docNo = input({ value: editing ? row.doc_no : '', placeholder: 'يُولَّد تلقائياً' });
    const docDate = input({ type: 'date', value: SamUI.today() });
    const shift = input({ value: editing ? row.shift || '' : '', placeholder: 'مثال: نهارية' });
    const machine = input({ value: editing ? row.machine || '' : '', placeholder: 'مثال: خط 2' });
    const cartons = numInput({ value: editing ? row.cartons : 0, placeholder: '0' });
    const bags = numInput({ value: editing ? row.bags : 0, placeholder: '0' });
    const good = numInput({ value: editing ? row.good : 0, placeholder: '0' });
    const defect = numInput({ value: editing ? row.defect : 0, placeholder: '0' });
    const note = input({ value: editing ? row.note || '' : '', placeholder: 'ملاحظة' });

    const rawHost = el('div');
    const prodHost = el('div');
    const rawCombo = combo(rawHost, { placeholder: 'المادة الخام (اختياري)…', emptyText: 'لا يوجد صنف مطابق', items: itemOptions(false) });
    const prodCombo = combo(prodHost, { placeholder: 'المنتج التام (اختياري)…', emptyText: 'لا يوجد صنف مطابق', items: itemOptions(false) });
    rawCombo.setValue(editing ? row.raw_item_id : null, false);
    prodCombo.setValue(editing ? row.product_item_id : null, false);

    grid.append(
      field('رقم السجل', docNo, '', 'i-hash'),
      field('التاريخ', docDate, editing ? dateHint(row.doc_date) : '', 'i-calendar'),
      field('الوردية', shift, '', 'i-day'),
      field('الماكينة', machine, '', 'i-gear'),
      field('المادة الخام', rawHost, '', 'i-box'),
      field('المنتج التام', prodHost, '', 'i-factory'),
      field('كراتين', cartons, '', 'i-archive-box'),
      field('أكياس', bags, '', 'i-archive'),
      field('جيد', good, '', 'i-check'),
      field('تالف', defect, '', 'i-warn'),
      (() => { const f = field('ملاحظة', note, '', 'i-clipboard'); f.classList.add('full'); return f; })()
    );
    body.appendChild(grid);
    body.appendChild(el('p', 'foot-note', 'هذا السجل للتوثيق فقط: لا ينشئ أي حركة مخزون ولا يغيّر أي رصيد.'));

    SamSuggest.attach(shift, 'shift');
    SamSuggest.attach(machine, 'machine');

    form({
      title: editing ? `تعديل سجل ${row.doc_no}` : 'سجل أرشيف إنتاج',
      body,
      wide: true,
      submitLabel: 'حفظ السجل',
      async onSubmit() {
        const payload = {
          id: editing ? row.id : null,
          doc_no: docNo.value.trim(),
          doc_date: docDate.value,
          shift: shift.value,
          machine: machine.value,
          raw_item_id: rawCombo.getValue(),
          product_item_id: prodCombo.getValue(),
          cartons: SamDB.n(cartons.value),
          bags: SamDB.n(bags.value),
          good: SamDB.n(good.value),
          defect: SamDB.n(defect.value),
          note: note.value
        };
        if (!payload.doc_date) throw new Error('تاريخ السجل مطلوب');
        const saved = await SamDB.call('saveArchive', payload);
        toast(`تم حفظ سجل الأرشيف ${saved.doc_no} (بلا أثر على المخزون)`, 'ok');
        SamSuggest.invalidate('shift');
        SamSuggest.invalidate('machine');
        SamUI.bus.emit();
        return saved;
      }
    }).then(async (v) => { if (v) await load(); });
  }

  function renderArchive() {
    const tb = document.querySelector('#archiveTbl tbody');
    tb.innerHTML = '';
    state.archive.forEach((a, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(a.doc_no)}</td>
        <td>${esc(a.doc_date)}</td>
        <td>${esc(a.shift || '—')}</td>
        <td>${esc(a.machine || '—')}</td>
        <td>${esc(a.rawName || '—')}</td>
        <td>${esc(a.productName || '—')}</td>
        <td class="num">${a.cartons ? SamDB.fmt(a.cartons) : '—'}</td>
        <td class="num">${a.bags ? SamDB.fmt(a.bags) : '—'}</td>
        <td class="num qty plus">${SamDB.fmt(a.good)}</td>
        <td class="num qty ${a.defect ? 'minus' : ''}">${SamDB.fmt(a.defect)}</td>
        <td>${esc(a.note || '—')}</td>`;
      bindRow(tr, {
        view: () => viewArchive(a),
        edit: () => openArchiveForm(a),
        del: () => removeArchive(a)
      });
      tb.appendChild(tr);
    });
    emptyState('archiveEmpty', {
      icon: 'i-archive',
      title: 'الأرشيف فارغ',
      hint: 'سجّل أيام الإنتاج التي لا تريد أن تمسّ المخزون — للرجوع إليها وطباعتها لاحقاً.',
      actionLabel: 'سجل أرشيف',
      onAction: () => openArchiveForm(null)
    });
    toggleEmpty('archiveEmpty', state.archive.length > 0);
  }

  function viewArchive(a) {
    modal({
      title: `سجل أرشيف — ${a.doc_no}`,
      body: `<dl class="info">
        <dt>التاريخ</dt><dd>${esc(a.doc_date)}</dd>
        <dt>الوردية</dt><dd>${esc(a.shift || '—')}</dd>
        <dt>الماكينة</dt><dd>${esc(a.machine || '—')}</dd>
        <dt>المادة الخام</dt><dd>${esc(a.rawName || '—')}</dd>
        <dt>المنتج التام</dt><dd>${esc(a.productName || '—')}</dd>
        <dt>كراتين</dt><dd>${SamDB.fmt(a.cartons)}</dd>
        <dt>أكياس</dt><dd>${SamDB.fmt(a.bags)}</dd>
        <dt>جيد</dt><dd>${SamDB.fmt(a.good)}</dd>
        <dt>تالف</dt><dd>${SamDB.fmt(a.defect)}</dd>
        <dt>الإجمالي</dt><dd>${SamDB.fmt(a.pieces)}</dd>
        <dt>ملاحظة</dt><dd>${esc(a.note || '—')}</dd>
      </dl>
      <p class="foot-note">بلا أثر على المخزون — للحفظ والطباعة فقط.</p>`,
      actions: [
        { label: 'طباعة', value: 'print', kind: 'btn-primary', icon: 'i-print' },
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    }).then((v) => {
      if (v === 'edit') openArchiveForm(a);
      if (v === 'print') printArchive(a);
    });
  }

  function printArchive(a) {
    printPreview({
      title: 'أرشيف الإنتاج',
      subtitle: 'سجل بلا أثر على المخزون',
      docRef: a.doc_no,
      docRefLabel: 'رقم السجل',
      head: [
        { k: 'الوردية', v: a.shift || '—' },
        { k: 'رقم السجل', v: a.doc_no },
        { k: 'التاريخ', v: a.doc_date }
      ],
      bodyHtml: tableHtml(
        [
          { key: 'k', label: 'البيان' },
          { key: 'v', label: 'القيمة', align: 'end' }
        ],
        [
          { k: 'الماكينة', v: a.machine || '—' },
          { k: 'المادة الخام', v: a.rawCode ? `${a.rawCode} — ${a.rawName}` : '—' },
          { k: 'المنتج التام', v: a.productCode ? `${a.productCode} — ${a.productName}` : '—' },
          { k: 'كراتين', v: SamDB.fmt(a.cartons) },
          { k: 'أكياس', v: SamDB.fmt(a.bags) },
          { k: 'جيد', v: SamDB.fmt(a.good) },
          { k: 'تالف', v: SamDB.fmt(a.defect) },
          { k: 'الإجمالي', v: SamDB.fmt(a.pieces) },
          { k: 'ملاحظة', v: a.note || '—' }
        ]
      ),
      footer: 'SAM Management System — أرشيف الإنتاج',
      signatures: ['مشرف المناوبة', 'أمين المخزن', 'المدير']
    });
  }

  async function removeArchive(a) {
    const yes = await modal({
      title: 'حذف سجل أرشيف',
      danger: true,
      body: `<p>سيُحذف السجل <b>${esc(a.doc_no)}</b> نهائياً. لا توجد حركات مخزون مرتبطة به، فلن يتغيّر أي رصيد.</p>`,
      actions: [
        { label: 'حذف', value: 'yes', kind: 'btn-danger', icon: 'i-trash' },
        { label: 'إلغاء', value: 'cancel', kind: 'btn-ghost' }
      ]
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteArchive', a.id);
      toast(`تم حذف السجل ${a.doc_no}`, 'bad');
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------------- سندات استلام الإنتاج — the documents that DID move the stock -------
     The daily production report only writes down what came out of a carton.
     This list is the other half: the document that really put the pieces
     into the warehouse — one row per document, with its warehouses. */
  function renderProdDocs() {
    const tb = document.querySelector('#prodDocsTbl tbody');
    if (!tb) return;
    tb.innerHTML = '';
    state.prodDocs.forEach((d, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(d.doc_no)}</td>
        <td>${esc(d.doc_date)}</td>
        <td>${esc(d.warehouseNames || '—')}</td>
        <td class="num">${SamDB.fmt(d.lineCount)}</td>
        <td class="num qty plus">${SamDB.fmt(d.totalPieces)}</td>`;
      bindRow(tr, {
        view: () => SamDocs.viewDoc(d.id),
        edit: () => SamDocs.openEditor(d.id),
        del: () => SamDocs.removeDoc(d)
      });
      tb.appendChild(tr);
    });
    emptyState('prodDocsEmpty', {
      icon: 'i-factory',
      title: 'لا توجد سندات استلام إنتاج',
      hint: 'السند هو المستند الذي يزيد رصيد المخزن — اختر المخزن لكل سطر، وبعد الحفظ اطبع تصريح الخروج.',
      actionLabel: 'سند استلام جديد',
      onAction: () => SamDocs.openEditor(null, 'prod_receipt')
    });
    toggleEmpty('prodDocsEmpty', state.prodDocs.length > 0);
  }

  /* ---------------- العجز والتالف — the documentation section ----------------
     Its own section, its own table, its own printed report and its own
     Excel export — exactly like a separate department inside the program,
     but fed by the very same items as the rest of the app. */
  async function loadGap() {
    const from = (document.getElementById('gapFrom') || {}).value || '';
    const to = (document.getElementById('gapTo') || {}).value || '';
    try {
      state.gap = await SamDB.call('productionGap', { dateFrom: from, dateTo: to });
    } catch (e) { state.gap = null; toast(e.message, 'bad'); }
    renderGap();
  }

  function gapRows() {
    return (state.gap && state.gap.rows) || [];
  }

  function renderGap() {
    const tb = document.querySelector('#gapTbl tbody');
    if (!tb) return;
    tb.innerHTML = '';
    gapRows().forEach((r, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td>${esc(r.docDate)}</td>
        <td class="mono">${esc(r.docNo)}</td>
        <td class="mono">${esc(r.cartonNo || '—')}</td>
        <td>${esc(r.rawItem)}</td>
        <td class="num">${SamDB.fmt(r.cartonPieces)}</td>
        <td class="num qty">${SamDB.fmt(r.produced)}</td>
        <td class="num qty ${r.shortage ? 'minus' : ''}">${SamDB.fmt(r.shortage)}</td>
        <td class="num qty ${r.surplus ? 'plus' : ''}">${SamDB.fmt(r.surplus)}</td>
        <td class="num qty">${SamDB.fmt(r.defectCans)}</td>
        <td class="num qty">${SamDB.fmt(r.defectAmpoules)}</td>
        <td class="num">${SamDB.fmt(r.breaks)}</td>
        <td>${esc(r.items || '—')}</td>`;
      bindRow(tr, {
        view: () => viewReceipt(r.id),
        edit: () => openReceiptForm(r.id),
        del: () => removeReceipt({
          id: r.id, doc_no: r.docNo, produced_total: r.produced,
          shortage: r.shortage, surplus: r.surplus
        })
      });
      tb.appendChild(tr);
    });
    emptyState('gapEmpty', {
      icon: 'i-scale',
      title: 'لا توجد تقارير إنتاج في هذه الفترة',
      hint: 'سجّل «تقرير إنتاج يومي» من تبويب تقارير الإنتاج ليظهر العجز والتالف هنا.'
    });
    toggleEmpty('gapEmpty', gapRows().length > 0);

    const t = (state.gap && state.gap.totals) || {};
    const foot = document.getElementById('gapFoot');
    if (foot) {
      foot.innerHTML = `
        <span>عدد التقارير: <b>${SamDB.fmt(t.rows || 0)}</b></span>
        <span>العجز: <b class="minus">${SamDB.fmt(t.shortage || 0)}</b></span>
        <span>الزيادة: <b class="plus">${SamDB.fmt(t.surplus || 0)}</b></span>
        <span>التالف: <b class="minus">${SamDB.fmt(t.defect || 0)}</b></span>
        <span class="dim">تقرير توثيقي — بلا أي أثر على المخزون</span>`;
    }
  }

  /** the printed report of the shortage section */
  function printGap() {
    const rows = gapRows();
    if (!rows.length) return toast('لا توجد بيانات للطباعة', 'warn');
    const t = (state.gap && state.gap.totals) || {};
    const from = (document.getElementById('gapFrom') || {}).value || '';
    const to = (document.getElementById('gapTo') || {}).value || '';
    const html = tableHtml(
      [
        { key: 'no', label: 'م', align: 'center' },
        { key: 'date', label: 'التاريخ' },
        { key: 'docNo', label: 'رقم التقرير' },
        { key: 'cartonNo', label: 'رقم الكرتون' },
        { key: 'raw', label: 'المادة الخام' },
        { key: 'cartonPieces', label: 'حبات الكرتون', align: 'end' },
        { key: 'produced', label: 'الإنتاج', align: 'end' },
        { key: 'shortage', label: 'العجز', align: 'end' },
        { key: 'surplus', label: 'الزيادة', align: 'end' },
        { key: 'cans', label: 'تالف علب', align: 'end' },
        { key: 'amps', label: 'تالف أمبولة', align: 'end' },
        { key: 'breaks', label: 'الكسر', align: 'end' }
      ],
      rows.map((r, i) => ({
        no: i + 1, date: r.docDate, docNo: r.docNo, cartonNo: r.cartonNo || '—',
        raw: r.rawItem, cartonPieces: SamDB.fmt(r.cartonPieces), produced: SamDB.fmt(r.produced),
        shortage: SamDB.fmt(r.shortage), surplus: SamDB.fmt(r.surplus),
        cans: SamDB.fmt(r.defectCans), amps: SamDB.fmt(r.defectAmpoules), breaks: SamDB.fmt(r.breaks)
      })),
      `العجز ${SamDB.fmt(t.shortage || 0)} · الزيادة ${SamDB.fmt(t.surplus || 0)} · التالف ${SamDB.fmt(t.defect || 0)}`
    );
    printPreview({
      title: 'تقرير عجز وتالف الإنتاج',
      subtitle: 'تقرير توثيقي — بلا أثر على المخزون',
      docRef: `GAP-${new Date().toISOString().slice(0, 10)}`,
      docRefLabel: 'رقم التقرير',
      head: [
        { k: 'الفترة', v: `${from || 'البداية'} → ${to || 'اليوم'}` },
        { k: 'عدد التقارير', v: SamDB.fmt(t.rows || 0) },
        { k: 'إجمالي العجز', v: `${SamDB.fmt(t.shortage || 0)} حبة` },
        { k: 'إجمالي التالف', v: `${SamDB.fmt(t.defect || 0)} حبة` }
      ],
      bodyHtml: html,
      dense: true,
      landscape: true,
      footer: 'SAM Management System — تقرير عجز وتالف الإنتاج (الكميات بالوحدة الأساسية)',
      signatures: ['مشرف المناوبة', 'أمين المخزن', 'المدير']
    });
  }

  /** the Excel export of the shortage section */
  async function exportGapExcel() {
    const rows = gapRows();
    if (!rows.length) return toast('لا توجد بيانات للتصدير', 'warn');
    const t = (state.gap && state.gap.totals) || {};
    const from = (document.getElementById('gapFrom') || {}).value || '';
    const to = (document.getElementById('gapTo') || {}).value || '';
    const r = await sam.app.saveXlsx({
      fileName: `SAM-Production-Gap-${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheetName: 'عجز وتالف الإنتاج',
      title: 'تقرير عجز وتالف الإنتاج',
      subtitle: `SAM Management System — ${SamUI.WATERMARK}`,
      meta: [
        ['الفترة', `${from || 'البداية'} → ${to || 'اليوم'}`],
        ['عدد التقارير', SamDB.fmt(t.rows || 0)],
        ['إجمالي العجز', SamDB.fmt(t.shortage || 0)],
        ['إجمالي الزيادة', SamDB.fmt(t.surplus || 0)],
        ['إجمالي التالف', SamDB.fmt(t.defect || 0)],
        ['ملاحظة', 'تقرير توثيقي — بلا أي أثر على المخزون']
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
        rawItem: x.rawItem, cartonPieces: SamDB.n(x.cartonPieces), produced: SamDB.n(x.produced),
        shortage: SamDB.n(x.shortage), surplus: SamDB.n(x.surplus),
        defectCans: SamDB.n(x.defectCans), defectAmpoules: SamDB.n(x.defectAmpoules),
        breaks: SamDB.n(x.breaks), items: x.items || ''
      })),
      totals: [
        { key: 'produced', value: rows.reduce((a, x) => a + SamDB.n(x.produced), 0) },
        { key: 'shortage', value: SamDB.n(t.shortage || 0) },
        { key: 'surplus', value: SamDB.n(t.surplus || 0) },
        { key: 'defectCans', value: SamDB.n(t.defect || 0) }
      ]
    });
    if (r && r.ok) {
      toast(`تم حفظ ملف Excel: ${r.data.path} (${SamDB.fmt(r.data.rows)} سطر)`, 'ok', 5600);
      sam.app.openPath(r.data.path.replace(/[\\/][^\\/]+$/, ''));
    } else if (r && !r.canceled) {
      toast(r.error || 'تعذّر حفظ الملف', 'bad', 5200);
    }
  }

  /* ---------------- tabs + wiring ---------------- */
  const PANELS = ['issues', 'receipts', 'tolling', 'scrap', 'archive', 'prodreceipts', 'gap'];
  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#prodTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    PANELS.forEach((p) => {
      const n = document.getElementById(`${p}Panel`);
      if (n) n.classList.toggle('hidden', p !== tab);
    });
    if (tab === 'gap') loadGap();
  }

  function newFromTab() {
    if (state.tab === 'receipts') return openReceiptForm(null);
    if (state.tab === 'tolling') return openTollingForm(null);
    if (state.tab === 'archive') return openArchiveForm(null);
    if (state.tab === 'prodreceipts') return SamDocs.openEditor(null, 'prod_receipt');
    if (state.tab === 'gap') return loadGap();
    return openIssueForm(null);
  }

  document.getElementById('btnNewIssue').addEventListener('click', () => openIssueForm(null));
  document.getElementById('btnNewReceipt').addEventListener('click', () => openReceiptForm(null));
  document.getElementById('btnNewTolling').addEventListener('click', () => openTollingForm(null));
  document.getElementById('btnNewArchive').addEventListener('click', () => openArchiveForm(null));
  const btnNewProdReceipt = document.getElementById('btnNewProdReceipt');
  if (btnNewProdReceipt) btnNewProdReceipt.addEventListener('click', () => SamDocs.openEditor(null, 'prod_receipt'));
  const btnNewProdReceipt2 = document.getElementById('btnNewProdReceipt2');
  if (btnNewProdReceipt2) btnNewProdReceipt2.addEventListener('click', () => SamDocs.openEditor(null, 'prod_receipt'));
  const btnPrintGap = document.getElementById('btnPrintGap');
  if (btnPrintGap) btnPrintGap.addEventListener('click', printGap);
  const btnExcelGap = document.getElementById('btnExcelGap');
  if (btnExcelGap) btnExcelGap.addEventListener('click', exportGapExcel);
  const btnGapRefresh = document.getElementById('btnGapRefresh');
  if (btnGapRefresh) btnGapRefresh.addEventListener('click', loadGap);
  ['gapFrom', 'gapTo'].forEach((id) => {
    const n = document.getElementById(id);
    if (n) n.addEventListener('change', loadGap);
  });
  document.getElementById('btnSaveRouting').addEventListener('click', saveRouting);
  document.getElementById('prodTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) showTab(b.dataset.tab);
  });

  window.SamProd = {
    load, showTab, newFromTab, openIssueForm, openReceiptForm, openTollingForm, openArchiveForm,
    printReceipt, printTolling, renderProdDocs, loadGap, printGap, exportGapExcel
  };
  SamUI.bus.on(load);
})();
