'use strict';

/* =====================================================================
   Transactions — purchase / sale / returns / warehouse transfers + permits
   Every quantity is in the item's BASE UNIT. invoice_value is a free,
   comma-formatted amount labelled in ريال يمني and never used in math.
   Parties, items and warehouses are always picked with the searchable combo.

   V3:
   · the document mirrors an invoice coming from another system — the
     external invoice number and the party name are mandatory.
   · EVERY LINE carries its own warehouse, so one invoice may leave from
     several warehouses at once (each with its own keeper and gate).
   · each warehouse involved gets its own permit printed from the document.
   ===================================================================== */
(function () {
  const {
    el, icon, esc, toast, bindRow, modal, input, numInput, affixInput, textarea,
    confirmHardDelete, confirmWarning, emptyState, toggleEmpty, combo, tableHtml, printPreview, CURRENCY
  } = SamUI;

  const state = {
    docs: [], items: [], warehouses: [], parties: [],
    kinds: { purchase: 'مشتريات', sale: 'مبيعات', sale_return: 'مرتجع مبيعات', purchase_return: 'مرتجع مشتريات', transfer: 'نقل بين المخازن' },
    filter: { kind: '', search: '' }
  };
  const BUCKETS = [['good', 'سليم'], ['defect', 'تالف'], ['held', 'محرز']];
  const bucketAr = (b) => ({ good: 'سليم', defect: 'تالف', held: 'محرز' }[b] || b);
  /** kinds that ADD stock — a shortage warning makes no sense for them */
  const ADDS_STOCK = ['purchase', 'sale_return'];
  /** kinds that need an external invoice number + a party */
  const isExternal = (kind) => kind !== 'transfer';

  const itemById = (id) => state.items.find((i) => i.id === Number(id)) || null;
  const unitOf = (id) => (itemById(id) || {}).base_unit || 'حبة';
  const whById = (id) => state.warehouses.find((w) => w.id === Number(id)) || null;

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
  const whOptions = () => activeWh().map((w) => ({ id: w.id, label: w.name, code: w.code }));
  const itemOptions = () => state.items
    .filter((i) => i.is_active)
    .map((i) => ({ id: i.id, label: i.name, code: i.code, sub: `${SamDB.fmt(i.mainStock.good)} ${i.base_unit}` }));

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
      const srcs = d.warehouseNames || d.warehouseName || '';
      const dests = d.destWarehouseNames || '';
      const whCell = d.kind === 'transfer' && dests
        ? `${esc(srcs)} ← ${esc(dests)}`
        : esc(srcs || '—');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(d.doc_no)}</td>
        <td><span class="chip ${kindChip(d.kind)}">${esc(d.kindAr)}</span></td>
        <td>${esc(d.doc_date)}</td>
        <td>${esc(d.partyName || '—')}</td>
        <td>${whCell}</td>
        <td class="num">${SamDB.fmt(d.lineCount)}</td>
        <td class="num qty">${SamDB.fmt(d.totalPieces)}</td>
        <td class="num">${d.invoice_value ? `${SamDB.money(d.invoice_value)} <span class="chip sub">${esc(CURRENCY)}</span>` : '—'}</td>`;
      bindRow(tr, {
        view: () => viewDoc(d.id),
        edit: () => openEditor(d.id),
        del: () => removeDoc(d),
        extra: permitMenuItems(d)
      });
      tb.appendChild(tr);
    });
    emptyState('docsEmpty', {
      icon: 'i-swap',
      title: 'لا توجد مستندات',
      hint: 'أنشئ مستنداً جديداً — المشتريات تزيد الرصيد والمبيعات تخفضه بالوحدة الأساسية.',
      actionLabel: 'مستند جديد',
      onAction: () => openEditor(null)
    });
    toggleEmpty('docsEmpty', state.docs.length > 0);
  }

  function kindChip(kind) {
    return { purchase: 'ok', sale: 'main', sale_return: 'warn', purchase_return: 'warn', transfer: 'sub' }[kind] || 'sub';
  }

  /** the context-menu entry that prints the permits of a document */
  function permitMenuItems(d) {
    if (d.kind === 'sale') return [{ label: 'طباعة تصاريح الخروج', icon: 'i-print', onClick: () => printPermits(d.id) }];
    if (d.kind === 'transfer') return [{ label: 'طباعة تصريح الانتقال', icon: 'i-print', onClick: () => printPermits(d.id) }];
    return [{ label: 'طباعة المستند', icon: 'i-print', onClick: () => printInvoice(d.id) }];
  }

  /* ---------------- editor ---------------- */
  async function openEditor(docId) {
    // the editor is often opened by a shortcut before the list has arrived
    if (!state.items.length || !state.warehouses.length || !state.parties.length) await load();
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

    /* the external invoice number — the one printed on the customer's paper */
    const docNo = input({
      class: 'input',
      value: doc ? doc.doc_no : '',
      placeholder: 'رقم الفاتورة من النظام الآخر'
    });
    const docDate = input({ class: 'input', type: 'date', value: doc ? doc.doc_date : SamUI.today() });
    // empty by default, grouped with commas, currency spelled out beside it
    const invoiceValue = numInput({ value: doc ? doc.invoice_value : 0, placeholder: '0' });
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

    /* the top combos are DEFAULTS for newly added lines — every line keeps
       its own warehouse so one invoice can leave from several of them. */
    const whCombo = combo(whHost, {
      placeholder: 'المخزن الافتراضي…',
      emptyText: 'لا توجد مخازن',
      items: whOptions(),
      onChange: (v) => {
        /* a line that has no warehouse of its own follows the document default */
        lines.forEach((l) => { if (l.whCombo && l.whCombo.getValue() == null) l.whCombo.setValue(v, false); });
      }
    });
    whCombo.setValue(doc ? doc.warehouse_id : (activeWh()[0] || {}).id || null, false);

    const destCombo = combo(destHost, {
      placeholder: 'الوجهة الافتراضية…',
      emptyText: 'لا توجد مخازن',
      items: whOptions(),
      onChange: (v) => {
        /* the editor opens with one empty line, so the destination picked here
           must reach it — otherwise saving a transfer fails with a confusing
           "الوجهة في السطر 1" and the user has to guess why */
        lines.forEach((l) => { if (l.destCombo && l.destCombo.getValue() == null) l.destCombo.setValue(v, false); });
      }
    });
    destCombo.setValue(doc ? doc.dest_warehouse_id : null, false);

    const cell = (label, node, cls) => {
      const c = el('div', `ed-cell ${cls || ''}`);
      c.appendChild(el('label', '', esc(label)));
      c.appendChild(node);
      return c;
    };
    /* a "apply to every line" button under a default combo */
    const defaultCell = (label, node, cls, pick, what) => {
      const c = cell(label, node, cls);
      const b = el('button', 'btn btn-sm btn-ghost', `${icon('i-swap')}<span>تطبيق على كل الأسطر</span>`);
      b.type = 'button';
      b.addEventListener('click', () => {
        const v = pick();
        if (v == null) return toast(`اختر ${what} أولاً`, 'warn');
        lines.forEach((l) => {
          if (l.whCombo) l.whCombo.setValue(v, false);
          refreshAvail(l);
        });
        toast(`تم تطبيق ${what} على كل الأسطر`, 'ok');
      });
      c.appendChild(b);
      return c;
    };

    const grid = el('div', 'ed-grid');
    grid.append(
      cell('رقم الفاتورة', docNo),
      cell('التاريخ', docDate),
      cell('العميل / المورد', partyHost, 'party-cell'),
      defaultCell('المخزن (للسطور الجديدة)', whHost, 'wh-default', () => whCombo.getValue(), 'المخزن'),
      defaultCell('الوجهة (للسطور الجديدة)', destHost, 'dest-cell', () => destCombo.getValue(), 'الوجهة'),
      cell(`قيمة الفاتورة (${CURRENCY})`, affixInput(invoiceValue, CURRENCY)),
      cell('ملاحظات', notes, 'full')
    );
    body.appendChild(grid);

    /* --- lines table --- */
    body.appendChild(el('div', 'ed-sec', `${icon('i-box')}<span>أسطر المستند — لكل سطر مخزنه، والكمية بالوحدة الأساسية</span>`));
    const linesTbl = el('table', 'tbl lines-tbl');
    linesTbl.innerHTML = `<thead><tr>
        <th>الصنف</th>
        <th style="width:152px">المخزن</th>
        <th style="width:152px" class="dest-col">الوجهة</th>
        <th class="unit-h" style="width:74px">الوحدة</th>
        <th style="width:138px">الحالة</th>
        <th style="width:100px">الكمية</th>
        <th style="width:80px" title="معلوماتي فقط">كراتين</th><th style="width:80px" title="معلوماتي فقط">أكياس</th>
        <th style="width:88px">المتاح</th><th style="width:36px"></th></tr></thead><tbody></tbody>`;
    const linesBody = linesTbl.querySelector('tbody');
    body.appendChild(linesTbl);

    const totals = el('div', 'totals-bar');
    body.appendChild(totals);

    const addRow = el('button', 'btn btn-sm btn-ghost', `${icon('i-plus')}<span>إضافة سطر</span>`);
    addRow.type = 'button';
    addRow.addEventListener('click', () => addLine());
    body.appendChild(el('div', 'row-add').appendChild(addRow).parentNode);
    body.appendChild(el('p', 'foot-note', 'الرقم والعميل مطلوبان لأن المستند يعكس فاتورة نظام آخر. لكل سطر مخزنه — قد تخرج فاتورة واحدة من عدة مخازن. الكمية أكبر من المتاح؟ يظهر تحذير ويمكن الحفظ.'));

    const foot = el('div', 'modal-foot');
    box.appendChild(body);
    box.appendChild(foot);

    /* --- line model --- */
    const lines = [];

    function recomputeTotals() {
      const pieces = lines.reduce((a, l) => a + SamDB.n(l.piecesEl.value), 0);
      const cartons = lines.reduce((a, l) => a + SamDB.n(l.cartonsEl.value), 0);
      const bags = lines.reduce((a, l) => a + SamDB.n(l.bagsEl.value), 0);
      const units = new Set(lines.map((l) => unitOf(l.itemCombo.getValue())));
      totals.innerHTML = `<span>الأسطر: <b>${lines.length}</b></span>
        <span>إجمالي الكمية: <b class="big">${SamDB.fmt(pieces)}</b> <span class="chip sub">${esc([...units].join(' / ') || 'حبة')}</span></span>
        <span>كراتين: <b>${SamDB.fmt(cartons)}</b></span>
        <span>أكياس: <b>${SamDB.fmt(bags)}</b></span>`;
    }

    function setUnit(l) {
      const has = !!l.itemCombo.getValue();
      l.unitEl.innerHTML = has ? `<span class="unit-chip">${esc(unitOf(l.itemCombo.getValue()))}</span>` : '<span class="muted">—</span>';
      if (!l.piecesEl.placeholder || !has) l.piecesEl.placeholder = '0';
    }

    /** availability inside the line's own warehouse */
    async function refreshAvail(l) {
      setUnit(l);
      const itemId = l.itemCombo.getValue();
      if (!itemId) { l.availEl.textContent = '—'; l.availEl.className = 'avail'; l.avail = null; return; }
      const whId = l.whCombo ? l.whCombo.getValue() : null;
      try {
        const avail = whId
          ? await SamDB.call('availableInLocation', itemId, whId, l.bucket, doc ? doc.id : null)
          : await SamDB.call('availablePieces', itemId, l.bucket, doc ? doc.id : null);
        l.avail = avail;
        l.availEl.textContent = SamDB.fmt(avail);
        l.availEl.className = SamDB.n(l.piecesEl.value) > avail ? 'avail low' : 'avail';
      } catch (e) { l.avail = null; l.availEl.textContent = '—'; }
    }

    function addLine(data) {
      const tr = el('tr');
      const itemHost = el('div');
      const whLineHost = el('div');
      const destLineHost = el('div');
      const unitBox = el('div');
      const bucketBox = el('div', 'bucket-seg');
      const piecesEl = numInput({ value: data ? data.pieces : 0, placeholder: '0' });
      const cartonsEl = numInput({ value: data ? data.cartons : 0, placeholder: '0' });
      const bagsEl = numInput({ value: data ? data.bags : 0, placeholder: '0' });
      const availEl = el('span', 'avail', '—');
      const del = el('button', 'row-del', '×');
      del.type = 'button';

      const l = { itemCombo: null, whCombo: null, destCombo: null, bucket: data ? data.bucket : 'good', piecesEl, cartonsEl, bagsEl, availEl, unitEl: unitBox };
      l.itemCombo = combo(itemHost, {
        placeholder: 'اكتب حرفين من اسم الصنف أو الكود…',
        emptyText: 'لا يوجد صنف مطابق',
        items: itemOptions(),
        onChange: () => refreshAvail(l)
      });
      if (data) l.itemCombo.setValue(data.item_id, false);

      /* the line's own warehouse — the heart of V3 */
      l.whCombo = combo(whLineHost, {
        placeholder: 'المخزن…',
        emptyText: 'لا توجد مخازن',
        items: whOptions(),
        onChange: () => refreshAvail(l)
      });
      l.whCombo.setValue(data ? data.warehouse_id : (whCombo.getValue() || (activeWh()[0] || {}).id || null), false);

      /* the destination of this line (transfers only) */
      l.destCombo = combo(destLineHost, {
        placeholder: 'الوجهة…',
        emptyText: 'لا توجد مخازن',
        items: whOptions()
      });
      l.destCombo.setValue(data ? data.dest_warehouse_id : (destCombo.getValue() || null), false);

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

      [piecesEl, cartonsEl, bagsEl].forEach((n) => n.addEventListener('input', () => {
        recomputeTotals();
        const avail = l.avail;
        if (avail != null) l.availEl.className = SamDB.n(l.piecesEl.value) > avail ? 'avail low' : 'avail';
      }));
      del.addEventListener('click', () => {
        const i = lines.indexOf(l);
        if (i >= 0) lines.splice(i, 1);
        tr.remove();
        recomputeTotals();
      });

      tr.append(el('td', '', '').appendChild(itemHost).parentNode,
        el('td', '').appendChild(whLineHost).parentNode,
        el('td', 'dest-col').appendChild(destLineHost).parentNode,
        el('td', 'unit-c').appendChild(unitBox).parentNode,
        el('td').appendChild(bucketBox).parentNode,
        el('td').appendChild(piecesEl).parentNode,
        el('td').appendChild(cartonsEl).parentNode,
        el('td').appendChild(bagsEl).parentNode,
        el('td').appendChild(availEl).parentNode,
        el('td').appendChild(del).parentNode);
      linesBody.appendChild(tr);
      lines.push(l);
      recomputeTotals();
      setUnit(l);
      if (data) refreshAvail(l);
      return l;
    }

    /* --- kind visibility --- */
    function syncKindVisibility() {
      const isTransfer = kind === 'transfer';
      grid.querySelector('.party-cell').style.display = isTransfer ? 'none' : '';
      grid.querySelector('.dest-cell').style.display = isTransfer ? '' : 'none';
      /* the destination column of the lines table exists only for transfers */
      linesTbl.querySelectorAll('.dest-col').forEach((n) => { n.style.display = isTransfer ? '' : 'none'; });
      const wantCustomer = kind === 'sale' || kind === 'sale_return';
      partyCombo.setItems(partyOptions(wantCustomer));
      docNo.placeholder = isTransfer ? 'رقم مستند النقل (اختياري)' : 'رقم الفاتورة من النظام الآخر';
      const gateBtn = foot.querySelector('[data-act="gate"]');
      if (gateBtn) {
        const show = kind === 'sale' || kind === 'transfer';
        gateBtn.classList.toggle('hidden', !show);
        const span = gateBtn.querySelector('span');
        if (span) span.textContent = kind === 'transfer' ? 'حفظ وطباعة تصريح الانتقال' : 'حفظ وطباعة تصاريح الخروج';
      }
      errBar.innerHTML = '';
      lines.forEach((l) => refreshAvail(l));
    }

    /* --- footer buttons --- */
    const mkBtn = (act, label, cls, kbd) => {
      const b = el('button', `btn ${cls}`, `${act === 'cancel' ? '' : icon(act === 'gate' || act === 'print' ? 'i-print' : 'i-check')}<span>${esc(label)}</span>${kbd ? `<span class="kbd">${kbd}</span>` : ''}`);
      b.type = 'button';
      b.dataset.act = act;
      b.addEventListener('click', () => (act === 'cancel' ? close(null) : submit(act)));
      foot.appendChild(b);
      return b;
    };
    mkBtn('save', doc ? 'حفظ التعديلات' : 'حفظ المستند', 'btn-primary', 'Ctrl+S');
    mkBtn('print', 'حفظ وطباعة المستند', 'btn-gold');
    mkBtn('gate', 'حفظ وطباعة تصاريح الخروج', 'btn-ghost');
    mkBtn('cancel', 'إغلاق', 'btn-ghost');

    /* --- what would go negative if we save as typed --- */
    function shortages() {
      const out = [];
      for (const l of lines) {
        const id = l.itemCombo.getValue();
        const qty = SamDB.n(l.piecesEl.value);
        if (!id || qty <= 0) continue;
        if (ADDS_STOCK.includes(kind)) continue; // these add stock
        if (l.avail == null) continue;
        if (qty > l.avail) {
          const w = whById(l.whCombo ? l.whCombo.getValue() : null);
          out.push({
            item: `${(itemById(id) || {}).code || ''} — ${(itemById(id) || {}).name || ''}`,
            text: `المخزن «${w ? w.name : '—'}» — المتاح ${SamDB.fmt(l.avail)} والكمية ${SamDB.fmt(qty)} → الرصيد يصبح ${SamDB.fmt(l.avail - qty)}`
          });
        }
      }
      return out;
    }

    /* --- missing fields the user must fill before saving --- */
    function missingFields() {
      const miss = [];
      if (isExternal(kind)) {
        if (!docNo.value.trim()) miss.push('رقم الفاتورة (من النظام الآخر)');
        if (!partyCombo.getValue()) miss.push(kind === 'purchase' || kind === 'purchase_return' ? 'اسم المورد' : 'اسم العميل');
      }
      if (!docDate.value) miss.push('التاريخ');
      lines.forEach((l, i) => {
        const at = i + 1;
        if (!l.itemCombo.getValue()) miss.push(`الصنف في السطر ${at}`);
        if (!l.whCombo || !l.whCombo.getValue()) miss.push(`المخزن في السطر ${at}`);
        if (kind === 'transfer') {
          const dst = l.destCombo ? l.destCombo.getValue() : null;
          if (!dst) miss.push(`الوجهة في السطر ${at}`);
          else if (dst === l.whCombo.getValue()) miss.push(`الوجهة في السطر ${at} (نفس المخزن)`);
        }
        if (SamDB.n(l.piecesEl.value) <= 0) miss.push(`الكمية في السطر ${at}`);
      });
      return miss;
    }

    /* --- submit --- */
    let asking = false;
    async function submit(action, skipWarning) {
      if (asking) return;
      errBar.innerHTML = '';
      if (!lines.length) {
        errBar.innerHTML = `${icon('i-warn')}<span>أضف سطراً واحداً على الأقل</span>`;
        return;
      }
      const miss = missingFields();
      if (miss.length) {
        errBar.innerHTML = `${icon('i-warn')}<span>أكمل الحقول التالية: ${esc(miss.join(' · '))}</span>`;
        return;
      }
      if (!skipWarning) {
        const bad = shortages();
        if (bad.length) {
          asking = true;
          const yes = await confirmWarning({
            title: 'الرصيد غير كافٍ',
            note: 'النظام يسمح بالحفظ برصيد سالب. راجع الأرقام التالية قبل المتابعة:',
            lines: bad
          });
          asking = false;
          if (yes !== 'yes') return;
          return submit(action, true);
        }
      }
      const payload = {
        id: doc ? doc.id : null,
        kind,
        doc_no: docNo.value.trim(),
        doc_date: docDate.value,
        party_id: kind === 'transfer' ? null : partyCombo.getValue(),
        /* the header keeps the first line's warehouse — the lines carry the truth */
        warehouse_id: lines[0] ? lines[0].whCombo.getValue() : null,
        dest_warehouse_id: kind === 'transfer' && lines[0] ? lines[0].destCombo.getValue() : null,
        invoice_value: SamDB.n(invoiceValue.value) ? SamDB.money(invoiceValue.value) : '',
        notes: notes.value,
        lines: lines.map((l) => ({
          item_id: l.itemCombo.getValue(),
          bucket: l.bucket,
          pieces: SamDB.n(l.piecesEl.value),
          cartons: SamDB.n(l.cartonsEl.value),
          bags: SamDB.n(l.bagsEl.value),
          warehouse_id: l.whCombo.getValue(),
          dest_warehouse_id: kind === 'transfer' ? l.destCombo.getValue() : null
        }))
      };
      foot.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
      try {
        const saved = await SamDB.call('saveDocument', payload);
        toast(`تم حفظ ${state.kinds[kind]} رقم ${saved.doc_no}`, 'ok');
        if (saved.warnings && saved.warnings.length) {
          toast(`${saved.warnings.length} صنف سيصبح رصيده سالباً — ستراه في التقارير`, 'warn', 5200);
        }
        SamUI.bus.emit();
        close(saved);
        if (action === 'print') printInvoice(saved.id);
        if (action === 'gate') printPermits(saved.id);
      } catch (e) {
        errBar.innerHTML = `${icon('i-warn')}<span>${esc(e.message)}</span>`;
      } finally {
        foot.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
      }
    }

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    let pop = null;
    let closed = false;
    function close(val) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (pop) pop();
      ov.remove();
      resolve(val);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    head.innerHTML = `<h3>${doc ? `تعديل ${state.kinds[doc.kind]} — ${esc(doc.doc_no)}` : 'مستند جديد'}</h3>`;
    head.appendChild(seg);

    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);
    pop = SamUI.pushKeys({
      save: () => submit('save'),
      print: () => (doc ? printInvoice(doc.id) : submit('print'))
    });

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
      bucket: bucketAr(l.bucket),
      pieces: SamDB.fmt(l.pieces),
      cartons: SamDB.fmt(l.cartons),
      bags: SamDB.fmt(l.bags),
      wh: l.warehouseName || '—',
      dest: l.destWarehouseName ? `← ${l.destWarehouseName}` : ''
    }));
    const html = SamUI.tableHtml(
      [
        { key: 'no', label: 'م' },
        { key: 'item', label: 'الصنف' },
        { key: 'bucket', label: 'الحالة' },
        { key: 'cartons', label: 'كراتين' },
        { key: 'bags', label: 'أكياس' },
        { key: 'pieces', label: 'الكمية' },
        { key: 'wh', label: 'المخزن' },
        { key: 'dest', label: 'الوجهة' }
      ],
      rows,
      SamDB.fmt(d.totalPieces)
    );
    const whSummary = [...new Set(d.lines.map((l) => l.warehouseName).filter(Boolean))].join(' · ');
    const v = await modal({
      title: `${d.kindAr} — ${d.doc_no}`,
      width: 'min(860px, 95vw)',
      body: `<dl class="info">
          <dt>التاريخ</dt><dd>${esc(d.doc_date)}</dd>
          <dt>العميل / المورد</dt><dd>${esc(d.partyName || '—')}</dd>
          <dt>المخازن</dt><dd>${esc(whSummary || '—')}</dd>
          <dt>قيمة الفاتورة</dt><dd>${d.invoice_value ? `${esc(d.invoice_value)} ${esc(CURRENCY)}` : '—'}</dd>
          <dt>ملاحظات</dt><dd>${esc(d.notes || '—')}</dd>
        </dl><div style="margin-top:14px">${html}</div>`,
      actions: [
        { label: 'طباعة المستند', value: 'print', kind: 'btn-primary', icon: 'i-print' },
        ...(d.kind === 'sale' ? [{ label: 'تصاريح الخروج', value: 'gate', kind: 'btn-gold', icon: 'i-print' }] : []),
        ...(d.kind === 'transfer' ? [{ label: 'تصريح الانتقال', value: 'gate', kind: 'btn-gold', icon: 'i-print' }] : []),
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    });
    if (v === 'edit') openEditor(id);
    if (v === 'print') printInvoice(id);
    if (v === 'gate') printPermits(id);
  }

  /* ---------------- printing ---------------- */
  function partyLabel(d) {
    if (d.kind === 'purchase' || d.kind === 'purchase_return') return 'المورد';
    if (d.kind === 'sale' || d.kind === 'sale_return') return 'العميل';
    return 'الجهة';
  }

  /** the invoice itself — every line shows its own warehouse */
  async function printInvoice(id) {
    const d = await SamDB.call('getDocument', id);
    const isTransfer = d.kind === 'transfer';
    const rows = d.lines.map((l, i) => ({
      no: i + 1,
      item: `${l.itemCode} — ${l.itemName}`,
      warehouse: l.warehouseName || '—',
      dest: l.destWarehouseName || '',
      unit: l.baseUnit,
      cartons: SamDB.fmt(l.cartons),
      bags: SamDB.fmt(l.bags),
      pieces: SamDB.fmt(l.pieces)
    }));
    const cols = [
      { key: 'no', label: 'م', align: 'center' },
      { key: 'item', label: 'الصنف' },
      { key: 'warehouse', label: 'المخزن' },
      ...(isTransfer ? [{ key: 'dest', label: 'الوجهة' }] : []),
      { key: 'unit', label: 'الوحدة', align: 'center' },
      { key: 'cartons', label: 'كراتين', align: 'center' },
      { key: 'bags', label: 'أكياس', align: 'center' },
      { key: 'pieces', label: 'الكمية', align: 'end' }
    ];
    printPreview({
      title: d.kindAr,
      subtitle: `مستند رقم ${d.doc_no}`,
      docRef: d.doc_no,
      docRefLabel: 'رقم الفاتورة',
      // centred block above the table: party, document number, date
      head: [
        { k: partyLabel(d), v: d.partyName || '—' },
        { k: 'رقم الفاتورة', v: d.doc_no },
        { k: 'التاريخ', v: d.doc_date }
      ],
      bodyHtml: `${tableHtml(cols, rows, SamDB.fmt(d.totalPieces))}
        <p class="doc-note" style="margin-top:4mm">
          <b>قيمة الفاتورة:</b> ${d.invoice_value ? `${esc(d.invoice_value)} ${esc(CURRENCY)}` : '—'}
          ${d.notes ? `<br><b>ملاحظات:</b> ${esc(d.notes)}` : ''}
        </p>`,
      footer: 'SAM Management System — جميع الكميات بالوحدة الأساسية',
      signatures: ['السائق', 'أمين المخزن', 'المدير']
    });
  }

  /**
   * One permit page per warehouse involved in the document.
   *  · sale     → exit permit (customer + that warehouse's quantities)
   *  · transfer → movement permit (source warehouse → destination)
   * The quantities on all permits add up to the document total, and no
   * price ever appears on a permit.
   */
  function permitPages(d) {
    const isTransfer = d.kind === 'transfer';
    const groups = new Map();
    d.lines.forEach((l) => {
      const key = l.warehouse_id || 0;
      if (!groups.has(key)) {
        groups.set(key, {
          name: l.warehouseName || '—',
          location: l.warehouseLocation || '',
          dests: new Map(),
          lines: []
        });
      }
      const g = groups.get(key);
      g.lines.push(l);
      if (isTransfer && l.dest_warehouse_id) {
        g.dests.set(l.dest_warehouse_id, `${l.destWarehouseName || '—'}${l.destWarehouseLocation ? ' — ' + l.destWarehouseLocation : ''}`);
      }
    });

    const count = groups.size;
    const pages = [...groups.values()].map((g, gi) => {
      const rows = g.lines.map((l, i) => ({
        no: i + 1,
        item: `${l.itemCode} — ${l.itemName}`,
        unit: l.baseUnit,
        cartons: SamDB.fmt(l.cartons),
        bags: SamDB.fmt(l.bags),
        pieces: SamDB.fmt(l.pieces)
      }));
      const total = g.lines.reduce((a, l) => a + SamDB.n(l.pieces), 0);
      const cols = [
        { key: 'no', label: 'م', align: 'center' },
        { key: 'item', label: 'الصنف' },
        { key: 'unit', label: 'الوحدة', align: 'center' },
        { key: 'cartons', label: 'كراتين', align: 'center' },
        { key: 'bags', label: 'أكياس', align: 'center' },
        { key: 'pieces', label: 'الكمية', align: 'end' }
      ];
      const head = isTransfer
        ? [
          { k: 'من مخزن', v: `${g.name}${g.location ? ' — ' + g.location : ''}` },
          { k: 'إلى مخزن', v: [...g.dests.values()].join(' / ') || '—' },
          { k: 'رقم المستند', v: d.doc_no },
          { k: 'التاريخ', v: d.doc_date }
        ]
        : [
          { k: 'العميل / الجهة', v: d.partyName || '—' },
          { k: 'رقم المستند', v: d.doc_no },
          { k: 'التاريخ', v: d.doc_date },
          { k: 'المخزن', v: `${g.name}${g.location ? ' — ' + g.location : ''}` }
        ];
      return {
        title: isTransfer ? 'تصريح انتقال بين المخازن' : 'تصريح خروج للبوابة',
        subtitle: `مرفق بمستند ${d.kindAr || ''} رقم ${d.doc_no} — تصريح ${gi + 1} من ${count}`,
        docRef: `GP-${d.doc_no}-${gi + 1}`,
        docRefLabel: 'رقم التصريح',
        head,
        bodyHtml: `
          <p class="doc-note">${isTransfer
            ? 'صرح بانتقال الكميات المذكورة من المخزن المصدر أعلاه إلى الوجهة المذكورة، ويمنع الخروج بأي كمية غير مذكورة.'
            : 'صرح بخروج الكميات المذكورة من هذا المخزن فقط إلى العميل أعلاه، ويمنع الخروج بأي بضاعة غير مذكورة.'}
            <b>لا تظهر الأسعار في هذا التصريح.</b></p>
          <p class="doc-note">وسيلة النقل: .......................... &nbsp;&nbsp; اسم السائق: .......................... &nbsp;&nbsp; رقم اللوحة: .................</p>
          ${tableHtml(cols, rows, SamDB.fmt(total))}
          <p class="doc-note" style="margin-top:3mm"><b>إجمالي هذا التصريح:</b> ${SamDB.fmt(total)} · <b>إجمالي المستند:</b> ${SamDB.fmt(d.totalPieces)}</p>`,
        footer: 'SAM Management System — تصريح (كميات فقط)',
        signatures: ['أمين المخازن', 'السائق', 'حارس البوابة']
      };
    });

    /* the permits must add up to the document — never silently differ */
    const sum = [...groups.values()].reduce((a, g) => a + g.lines.reduce((x, l) => x + SamDB.n(l.pieces), 0), 0);
    if (sum !== SamDB.n(d.totalPieces)) console.warn('permit reconciliation mismatch', sum, d.totalPieces);
    return pages;
  }

  /** print the permits of a document — one page per warehouse */
  async function printPermits(id) {
    const d = await SamDB.call('getDocument', id);
    if (!d) return toast('المستند غير موجود', 'bad');
    const pages = permitPages(d);
    if (!pages.length) return toast('لا توجد أصناف في المستند', 'warn');
    printPreview({
      title: `${d.kind === 'transfer' ? 'تصاريح انتقال' : 'تصاريح خروج'} (${pages.length})`,
      pages
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

  window.SamDocs = { load, openEditor, viewDoc, printInvoice, printPermits, permitPages };
  SamUI.bus.on(load);
})();
