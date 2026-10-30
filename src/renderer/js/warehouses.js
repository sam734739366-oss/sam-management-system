'use strict';

/* =====================================================================
   Hangars screen — V2: one warehouse, so these are locations inside it.
   ===================================================================== */
(function () {
  const { el, esc, toast, bindRow, modal, form, field, input, confirmHardDelete, emptyState, toggleEmpty } = SamUI;
  const state = { rows: [] };

  async function load() {
    try {
      state.rows = await SamDB.call('listWarehouses');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }

  const kindLabel = (k) => (k === 'main' ? 'المخزن الرئيسي' : 'هنجر');

  function render() {
    const tb = document.querySelector('#whTbl tbody');
    tb.innerHTML = '';
    state.rows.forEach((w, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(w.code)}</td>
        <td>${esc(w.name)}${w.note ? ` <span class="chip sub">${esc(w.note)}</span>` : ''}</td>
        <td>${esc(w.location || '—')}</td>
        <td><span class="chip ${w.kind === 'main' ? 'main' : 'sub'}">${kindLabel(w.kind)}</span></td>
        <td class="num">${SamDB.fmt(w.item_count)}</td>
        <td class="num qty ${w.total_pieces < 0 ? 'minus' : ''}">${SamDB.fmt(w.total_pieces)}</td>
        <td>${w.is_active ? '<span class="chip ok">نشط</span>' : '<span class="chip off">موقوف</span>'}</td>`;
      bindRow(tr, {
        view: () => view(w),
        edit: () => openForm(w),
        del: () => remove(w)
      });
      tb.appendChild(tr);
    });
    emptyState('whEmpty', {
      icon: 'i-pin',
      title: 'لا توجد هناجر',
      hint: 'المخزن واحد، وأنت هنا تحدد مواقع التخزين داخله للتفصيل في التقارير.',
      actionLabel: 'إضافة هنجر',
      onAction: () => openForm(null)
    });
    toggleEmpty('whEmpty', state.rows.length > 0);
  }

  function openForm(w) {
    const editing = !!w;
    const mainTaken = state.rows.some((x) => x.kind === 'main' && (!editing || x.id !== w.id));

    const code = input({ placeholder: 'مثال: H-02', value: editing ? w.code : '' });
    const name = input({ placeholder: 'مثال: هنجر المنتجات التامة', value: editing ? w.name : '' });
    const location = input({ placeholder: 'مثال: الدور الأرضي — قسم التعبئة', value: editing ? w.location || '' : '' });
    const note = input({ placeholder: 'ملاحظة اختيارية', value: editing ? w.note || '' : '' });

    const kindBox = el('div', 'radio-row');
    const mk = (val, label, hint) => {
      const r = input({ type: 'radio', name: 'wh-kind', value: val });
      const chosen = editing ? w.kind === val : val === 'sub';
      r.checked = chosen;
      const l = el('label', 'radio');
      if (val === 'main' && mainTaken) {
        l.classList.add('disabled');
        r.disabled = true;
        l.title = 'المخزن الرئيسي موجود بالفعل — للنظام مخزن واحد فقط';
      }
      l.append(r, el('span', 'rt', label), el('em', 'hint-txt', hint));
      kindBox.appendChild(l);
    };
    mk('main', 'المخزن الرئيسي', 'واحد فقط في النظام');
    mk('sub', 'هنجر / موقع', 'داخل نفس المخزن — للتفصيل فقط');

    const activeWrap = el('label', 'check-row');
    const active = input({ type: 'checkbox' });
    active.checked = editing ? !!w.is_active : true;
    activeWrap.append(active, el('span', '', 'الموقع نشط'));

    const grid = el('div', 'form-grid');
    grid.append(
      field('الكود', code),
      field('الاسم', name),
      field('العنوان داخل الموقع', location),
      field('النوع', kindBox),
      field('ملاحظة', note),
      activeWrap
    );
    const body = el('div');
    body.appendChild(grid);
    body.appendChild(el('p', 'foot-note', 'الأرصدة تُحسب على مستوى المخزن كله؛ اختيار الهنجر في التقارير يقلّص الحركة المعروضة فقط.'));
    SamSuggest.attach(location, 'wh_location');
    SamSuggest.attach(note, 'wh_note');

    form({
      title: editing ? `تعديل الموقع: ${w.code}` : 'إضافة هنجر / موقع',
      body,
      submitLabel: 'حفظ',
      async onSubmit() {
        const chosen = kindBox.querySelector('input:checked');
        if (!chosen) throw new Error('اختر نوع الموقع');
        const payload = {
          code: code.value.trim(),
          name: name.value.trim(),
          kind: chosen.value,
          location: location.value.trim(),
          note: note.value.trim(),
          is_active: active.checked
        };
        if (!payload.code) throw new Error('كود الموقع مطلوب');
        if (!payload.name) throw new Error('اسم الموقع مطلوب');
        if (editing) {
          await SamDB.call('updateWarehouse', w.id, payload);
          toast(`تم تحديث «${payload.name}»`, 'ok');
        } else {
          await SamDB.call('addWarehouse', payload);
          toast(`تم إضافة «${payload.name}»`, 'ok');
        }
        SamSuggest.invalidate('wh_location');
        SamSuggest.invalidate('wh_note');
        SamUI.bus.emit();
        return true;
      }
    }).then((ok) => { if (ok) load(); });
  }

  function view(w) {
    modal({
      title: `بطاقة الموقع — ${w.code}`,
      body: `<dl class="info">
        <dt>الكود</dt><dd>${esc(w.code)}</dd>
        <dt>الاسم</dt><dd>${esc(w.name)}</dd>
        <dt>العنوان</dt><dd>${esc(w.location || '—')}</dd>
        <dt>النوع</dt><dd>${kindLabel(w.kind)}</dd>
        <dt>عدد الأصناف</dt><dd>${SamDB.fmt(w.item_count)}</dd>
        <dt>حبة في هذا الموقع</dt><dd>${SamDB.fmt(w.total_pieces)}</dd>
        <dt>الحالة</dt><dd>${w.is_active ? 'نشط' : 'موقوف'}</dd>
        <dt>ملاحظة</dt><dd>${esc(w.note || '—')}</dd>
      </dl>
      <p class="foot-note">النقل بين المواقع يُسجَّل من شاشة «العمليات → نقل بين الهناجر» ولا يغيّر الرصيد الكلي.</p>`,
      actions: [
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    }).then((v) => { if (v === 'edit') openForm(w); });
  }

  async function remove(w) {
    let impact;
    try { impact = await SamDB.call('warehouseImpact', w.id); } catch (e) { return toast(e.message, 'bad'); }
    if (impact.moves > 0) {
      return modal({
        title: 'لا يمكن حذف الموقع',
        danger: true,
        body: `<p>«${esc(w.name)}» يحتوي على <b>${impact.moves}</b> حركة مخزون بإجمالي <b>${SamDB.fmt(impact.pieces)}</b> حبة.</p>
               <p style="margin-top:10px">احذف المستندات المرتبطة به أولاً (حذف نهائي يعكس المخزون)، ثم أعد المحاولة.</p>`,
        actions: [{ label: 'فهمت', value: 'ok', kind: 'btn-ghost' }]
      });
    }
    const yes = await confirmHardDelete({
      docNo: `${w.code} — ${w.name}`,
      docType: 'موقع تخزين',
      lines: [],
      extra: '<p style="margin-top:10px;font-size:13px">الموقع فارغ من الحركات — حذفه لا يغيّر أي رصيد.</p>'
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteWarehouse', w.id);
      toast(`تم حذف «${w.name}» نهائياً`, 'bad');
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  }

  document.getElementById('btnAddWh').addEventListener('click', () => openForm(null));
  window.SamWarehouses = { load, openForm };
  SamUI.bus.on(load);
})();
