'use strict';

/* =====================================================================
   Items screen — master data + opening balances (the piece is king)
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, bindRow, modal, form, field, input, textarea, confirmHardDelete } = SamUI;

  const state = { items: [], warehouses: [], search: '' };
  const BUCKETS = ['good', 'defect', 'held'];
  const AR = { good: 'سليم', defect: 'تالف', held: 'محجوز' };

  async function load() {
    try {
      state.warehouses = await SamDB.call('listWarehouses');
      state.items = await SamDB.call('listItems', state.search);
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  function render() {
    const tb = document.querySelector('#itemsTbl tbody');
    tb.innerHTML = '';
    state.items.forEach((it, idx) => {
      const tr = el('tr');
      const alert = it.alertLowGood
        ? '<span class="chip bad">تحت الحد الأدنى</span>'
        : it.alertHighDefect
          ? '<span class="chip warn">تالف تجاوز الحد</span>'
          : '<span class="chip ok">سليم</span>';
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(it.code)}</td>
        <td>${esc(it.name)}${it.category ? ` <span class="chip sub">${esc(it.category)}</span>` : ''}${it.is_active ? '' : ' <span class="chip off">موقوف</span>'}</td>
        <td>${esc(it.base_unit)}</td>
        <td class="num">${SamDB.fmt(it.pieces_per_carton)}</td>
        <td class="num">${SamDB.fmt(it.pieces_per_bag)}</td>
        <td class="num qty">${SamDB.fmt(it.mainStock.good)}</td>
        <td class="num qty">${SamDB.fmt(it.mainStock.defect)}</td>
        <td class="num qty">${SamDB.fmt(it.mainStock.held)}</td>
        <td class="num qty">${SamDB.fmt(it.totalPieces)}</td>
        <td>${alert}</td>`;
      bindRow(tr, {
        view: () => view(it),
        edit: () => openForm(it),
        del: () => remove(it)
      });
      tb.appendChild(tr);
    });
    document.getElementById('itemsEmpty').style.display = state.items.length ? 'none' : 'block';
  }

  /* ---------------- form ---------------- */
  async function openForm(item) {
    const editing = !!item;
    let openings = {};
    if (editing) {
      try { openings = await SamDB.call('openingBalances', item.id); } catch (e) { /* keep empty */ }
    }

    const body = el('div');
    const grid = el('div', 'form-grid');

    const code = input({ placeholder: 'مثال: 0001', value: item ? item.code : '' });
    const name = input({ placeholder: 'مثال: مياه جلدلة 1.5 لتر', value: item ? item.name : '' });
    const unit = input({ placeholder: 'حبة — اكتب قيمة جديدة أو اختر من المقترحات', value: item ? item.base_unit : 'حبة' });
    const cat = input({ placeholder: 'مثال: خام / منتج تام / ملحقات', value: item ? item.category || '' : '' });
    const perCtn = input({ type: 'number', min: '0', step: '1', value: item ? item.pieces_per_carton : '' , placeholder:'0'});
    const perBag = input({ type: 'number', min: '0', step: '1', value: item ? item.pieces_per_bag : '', placeholder: '0' });
    const minGood = input({ type: 'number', min: '0', step: '1', value: item ? item.min_good_alert : '', placeholder: '0' });
    const maxDefect = input({ type: 'number', min: '0', step: '1', value: item ? item.max_defect_alert : '', placeholder: '0' });

    grid.append(
      field('كود الصنف', code),
      field('اسم الصنف', name),
      field('الوحدة الأساسية', unit, 'الوحدة التي يُحتسب بها المخزون'),
      field('الفئة', cat),
      field('عدد حبات الكرتونة', perCtn, 'معلوماتي — لا يؤثر على الحساب'),
      field('عدد حبات الكيس', perBag, 'معلوماتي'),
      field('حد التنبيه الأدنى للجيد', minGood, 'تنبيه إذا قلّ الجيد عن هذا الرقم'),
      field('حد التالف الأقصى', maxDefect, 'تنبيه إذا زاد التالف عن هذا الرقم')
    );
    body.appendChild(grid);

    // free-text fields stay text inputs but suggest values already stored in the DB
    SamSuggest.attach(unit, 'base_unit');
    SamSuggest.attach(cat, 'category');

    /* ---- opening balances ---- */
    body.appendChild(el('div', 'form-sec', `${icon('i-wh')}<span>الأرصدة الافتتاحية (حبة)</span>`));
    const bal = el('div', 'bal-grid');
    bal.append(
      el('div', 'hd', 'المخزن'),
      el('div', 'hd', 'سليم'),
      el('div', 'hd', 'تالف'),
      el('div', 'hd', 'محجوز')
    );
    state.warehouses.forEach((w) => {
      const saved = openings[w.id] || {};
      const nameCell = el('div', 'wh-name',
        `<span>${esc(w.name)}</span><span class="chip ${w.kind === 'main' ? 'main' : 'sub'}">${w.kind === 'main' ? 'رئيسي' : 'فرعي'}</span>`);
      bal.appendChild(nameCell);
      for (const b of BUCKETS) {
        const i = input({
          type: 'number', min: '0', step: '1', class: 'input bal-in',
          'data-wh': w.id, 'data-bucket': b,
          value: saved[b] || 0, placeholder: '0'
        });
        bal.appendChild(i);
      }
    });
    body.appendChild(bal);
    body.appendChild(el('p', 'foot-note', 'الحبة هي وحدة الحساب. الكرتونة والكيس تُسجَّل لأغراض العرض فقط.'));

    const ok = await form({
      title: editing ? `تعديل الصنف: ${item.code}` : 'إضافة صنف جديد',
      body,
      wide: true,
      submitLabel: editing ? 'حفظ التعديلات' : 'حفظ الصنف',
      async onSubmit() {
        const payload = {
          code: code.value.trim(),
          name: name.value.trim(),
          base_unit: unit.value.trim() || 'حبة',
          category: cat.value.trim(),
          pieces_per_carton: SamDB.n(perCtn.value),
          pieces_per_bag: SamDB.n(perBag.value),
          min_good_alert: SamDB.n(minGood.value),
          max_defect_alert: SamDB.n(maxDefect.value),
          is_active: true
        };
        if (!payload.code) throw new Error('كود الصنف مطلوب');
        if (!payload.name) throw new Error('اسم الصنف مطلوب');

        const balances = [];
        bal.querySelectorAll('.bal-in').forEach((inp) => {
          const v = SamDB.n(inp.value);
          const row = balances.find((x) => x.warehouseId === Number(inp.dataset.wh));
          if (v !== 0) {
            if (row) row[inp.dataset.bucket] = v;
            else balances.push({ warehouseId: Number(inp.dataset.wh), [inp.dataset.bucket]: v });
          } else if (row) {
            row[inp.dataset.bucket] = 0;
          }
        });
        const clean = balances.filter((b) => BUCKETS.some((k) => SamDB.n(b[k]) !== 0));

        if (editing) {
          await SamDB.call('updateItem', item.id, payload, clean);
          toast(`تم تحديث «${payload.name}»`, 'ok');
        } else {
          await SamDB.call('addItem', payload, clean);
          toast(`تم إضافة «${payload.name}»${clean.length ? ' مع الأرصدة الافتتاحية' : ''}`, 'ok');
        }
        SamSuggest.invalidate('base_unit');
        SamSuggest.invalidate('category');
        SamUI.bus.emit();
        return true;
      }
    });
    if (ok) await load();
  }

  /* ---------------- view ---------------- */
  async function view(item) {
    let rows = [];
    try { rows = await SamDB.call('itemStock', item.id); } catch (e) { toast(e.message, 'bad'); return; }
    const total = rows.reduce((a, r) => a + r.good + r.defect + r.held, 0);
    const table = SamUI.tableHtml(
      [
        { key: 'name', label: 'المخزن' },
        { key: 'kind', label: 'النوع' },
        { key: 'good', label: 'سليم' },
        { key: 'defect', label: 'تالف' },
        { key: 'held', label: 'محجوز' },
        { key: 'tot', label: 'الإجمالي' }
      ],
      rows.map((r, i) => ({ ...r, no: i + 1, kind: r.kind === 'main' ? 'رئيسي' : 'فرعي', tot: r.good + r.defect + r.held })),
      SamDB.fmt(total)
    );
    const body = `
      <dl class="info">
        <dt>الكود</dt><dd>${esc(item.code)}</dd>
        <dt>الاسم</dt><dd>${esc(item.name)}</dd>
        <dt>الفئة</dt><dd>${esc(item.category || '—')}</dd>
        <dt>الوحدة الأساسية</dt><dd>${esc(item.base_unit)}</dd>
        <dt>حبة / كرتونة</dt><dd>${SamDB.fmt(item.pieces_per_carton)}</dd>
        <dt>حبة / كيس</dt><dd>${SamDB.fmt(item.pieces_per_bag)}</dd>
        <dt>حد الجيد الأدنى</dt><dd>${SamDB.fmt(item.min_good_alert)}</dd>
        <dt>حد التالف الأقصى</dt><dd>${SamDB.fmt(item.max_defect_alert)}</dd>
      </dl>
      <div style="margin-top:14px">${table}</div>`;
    const v = await modal({
      title: `بطاقة الصنف — ${item.code}`,
      body,
      width: 'min(760px, 94vw)',
      actions: [
        { label: 'طباعة بطاقة الصنف', value: 'print', kind: 'btn-primary', icon: 'i-print' },
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    });
    if (v === 'edit') openForm(item);
    if (v === 'print') printCard(item, rows, total);
  }

  function printCard(item, rows, total) {
    const html = SamUI.tableHtml(
      [
        { key: 'name', label: 'المخزن' },
        { key: 'good', label: 'سليم' },
        { key: 'defect', label: 'تالف' },
        { key: 'held', label: 'محجوز' },
        { key: 'tot', label: 'الإجمالي (حبة)' }
      ],
      rows.map((r) => ({ name: `${r.code} — ${r.name}`, good: SamDB.fmt(r.good), defect: SamDB.fmt(r.defect), held: SamDB.fmt(r.held), tot: SamDB.fmt(r.good + r.defect + r.held) })),
      SamDB.fmt(total)
    );
    SamUI.printPreview({
      title: 'بطاقة رصيد صنف',
      subtitle: 'كشف مخزون داخلي',
      head: [
        { k: 'الكود', v: item.code },
        { k: 'الصنف', v: item.name },
        { k: 'الوحدة', v: item.base_unit },
        { k: 'التاريخ', v: new Date().toLocaleDateString('ar-EG-u-nu-latn') }
      ],
      bodyHtml: html,
      footer: 'SAM Management System — الأرصدة بالحبة',
      signatures: ['أمين المخزن', 'المراجع']
    });
  }

  /* ---------------- hard delete ---------------- */
  async function remove(item) {
    let impact;
    try { impact = await SamDB.call('deleteItemImpact', item.id); } catch (e) { return toast(e.message, 'bad'); }
    if (!impact) return;
    const lines = impact.lines.map((l) => ({ ...l, dir: 'خصم من الرصيد' }));
    const yes = await confirmHardDelete({
      docNo: `${item.code} — ${item.name}`,
      docType: 'صنف',
      lines,
      extra: `<p style="margin-top:10px;font-size:13px">عدد حركات المخزون المرتبطة: <b>${impact.moves}</b> — إجمالي ما سيُخصم من الأرصدة: <b>${SamDB.fmt(impact.totalPieces)} حبة</b></p>`
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteItem', item.id);
      toast(`تم حذف «${item.name}» نهائياً وعكس أرصدته`, 'bad', 4200);
      SamUI.bus.emit();
      await load();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /* ---------------- smart searchable lookup (uses SamUI.combo) ---------------- */
  async function smartSearch() {
    const itemHost = el('div');
    const whHost = el('div');
    const out = el('div', 'combo-result', '<span class="muted">اختر صنفاً ومخزناً لعرض الرصيد بالحبة.</span>');

    const refresh = async () => {
      const itemId = itemCombo.getValue();
      const whId = whCombo.getValue();
      if (!itemId || !whId) return;
      try {
        const rows = await SamDB.call('itemStock', itemId);
        const r = rows.find((x) => x.warehouseId === whId) || { good: 0, defect: 0, held: 0 };
        out.innerHTML = `
          <div class="cr-row"><span>سليم</span><b>${SamDB.fmt(r.good)}</b></div>
          <div class="cr-row"><span>تالف</span><b>${SamDB.fmt(r.defect)}</b></div>
          <div class="cr-row"><span>محجوز</span><b>${SamDB.fmt(r.held)}</b></div>
          <div class="cr-row total"><span>الإجمالي (حبة)</span><b>${SamDB.fmt(r.good + r.defect + r.held)}</b></div>`;
      } catch (e) { out.innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
    };

    const itemCombo = SamUI.combo(itemHost, {
      placeholder: 'اكتب جزءاً من الاسم أو الكود…',
      emptyText: 'لا يوجد صنف مطابق',
      onChange: refresh,
      items: state.items.map((i) => ({ id: i.id, label: i.name, code: i.code, sub: i.base_unit }))
    });
    const whCombo = SamUI.combo(whHost, {
      placeholder: 'اختر المخزن…',
      emptyText: 'لا توجد مخازن',
      onChange: refresh,
      items: state.warehouses.map((w) => ({ id: w.id, label: w.name, code: w.kind === 'main' ? 'رئيسي' : 'فرعي' }))
    });

    const grid = el('div', 'form-grid');
    const outWrap = el('div', 'full');
    outWrap.appendChild(out);
    grid.append(field('الصنف', itemHost), field('المخزن', whHost), outWrap);

    const body = el('div');
    body.appendChild(el('p', 'tip', 'هذه القائمة المنسدلة الذكية هي نفسها المستخدمة في الأصناف والعملاء والموردين والفلاتر: اكتب حرفين فقط، ثم Enter أو الفأرة.'));
    body.appendChild(grid);

    await modal({ title: 'بحث ذكي عن رصيد صنف', body, width: 'min(560px, 94vw)' });
  }

  /* ---------------- wiring ---------------- */
  let t = null;
  document.getElementById('btnAddItem').addEventListener('click', () => openForm(null));
  document.getElementById('btnSmartSearch').addEventListener('click', () => smartSearch());
  document.getElementById('itemSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = e.target.value;
      load();
    }, 180);
  });

  window.SamItems = { load, openForm };
  SamUI.bus.on(load);
})();
