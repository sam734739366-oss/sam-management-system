'use strict';

/* =====================================================================
   Parties — العملاء والموردون (table: parties)
   Exposes quickAdd() + options() so invoice screens in phase 3 can use
   the searchable dropdown with a [+] shortcut.
   ===================================================================== */
(function () {
  const { el, esc, toast, bindRow, modal, form, field, input, textarea } = SamUI;
  const TYPE_AR = { customer: 'عميل', supplier: 'مورد', both: 'عميل ومورد' };
  const TYPE_CHIP = { customer: 'main', supplier: 'sub', both: 'warn' };

  const state = { rows: [], search: '' };

  async function load() {
    try {
      state.rows = await SamDB.call('listParties', state.search);
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }

  function render() {
    const tb = document.querySelector('#partiesTbl tbody');
    tb.innerHTML = '';
    state.rows.forEach((p, idx) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td>${esc(p.name)}${p.is_active ? '' : ' <span class="chip off">موقوف</span>'}</td>
        <td><span class="chip ${TYPE_CHIP[p.type]}">${TYPE_AR[p.type]}</span></td>
        <td class="mono">${esc(p.phone || '—')}</td>
        <td class="num">${SamDB.fmt(p.doc_count)}</td>
        <td>${esc(p.notes || '—')}</td>`;
      bindRow(tr, {
        view: () => view(p),
        edit: () => openForm(p),
        del: () => remove(p)
      });
      tb.appendChild(tr);
    });
    document.getElementById('partiesEmpty').style.display = state.rows.length ? 'none' : 'block';
  }

  function openForm(p) {
    const editing = !!p;
    const name = input({ placeholder: 'مثال: موزع الرياض', value: editing ? p.name : '' });
    const phone = input({ placeholder: '05xxxxxxxx', value: editing ? p.phone || '' : '' });
    const notes = textarea({ placeholder: 'ملاحظات…', value: editing ? p.notes || '' : '', rows: 2 });

    const typeBox = el('div', 'radio-row');
    Object.entries(TYPE_AR).forEach(([val, label]) => {
      const r = input({ type: 'radio', name: 'party-type', value: val });
      r.checked = editing ? p.type === val : val === 'customer';
      const l = el('label', 'radio');
      l.append(r, el('span', 'rt', label));
      typeBox.appendChild(l);
    });

    const activeWrap = el('label', 'check-row');
    const active = input({ type: 'checkbox' });
    active.checked = editing ? !!p.is_active : true;
    activeWrap.append(active, el('span', '', 'الطرف نشط'));

    const grid = el('div', 'form-grid');
    grid.append(
      field('الاسم', name),
      field('الهاتف', phone),
      field('النوع', typeBox),
      field('ملاحظات', notes),
      activeWrap
    );

    const body = el('div');
    body.appendChild(grid);

    return form({
      title: editing ? `تعديل: ${p.name}` : 'إضافة عميل / مورد',
      body,
      submitLabel: 'حفظ',
      async onSubmit() {
        const chosen = typeBox.querySelector('input:checked');
        const payload = {
          name: name.value.trim(),
          phone: phone.value.trim(),
          type: chosen ? chosen.value : 'customer',
          notes: notes.value.trim(),
          is_active: active.checked
        };
        if (!payload.name) throw new Error('اسم العميل / المورد مطلوب');
        let saved;
        if (editing) {
          saved = await SamDB.call('updateParty', p.id, payload);
          toast(`تم تحديث «${payload.name}»`, 'ok');
        } else {
          saved = await SamDB.call('addParty', payload);
          toast(`تم إضافة «${payload.name}»`, 'ok');
        }
        SamUI.bus.emit();
        return saved;
      }
    });
  }

  function view(p) {
    modal({
      title: `بطاقة الطرف — ${p.name}`,
      body: `<dl class="info">
        <dt>الاسم</dt><dd>${esc(p.name)}</dd>
        <dt>النوع</dt><dd>${TYPE_AR[p.type]}</dd>
        <dt>الهاتف</dt><dd>${esc(p.phone || '—')}</dd>
        <dt>عدد المستندات</dt><dd>${SamDB.fmt(p.doc_count)}</dd>
        <dt>ملاحظات</dt><dd>${esc(p.notes || '—')}</dd>
        <dt>الحالة</dt><dd>${p.is_active ? 'نشط' : 'موقوف'}</dd>
      </dl>
      <p class="foot-note">ربط الطرف بالفواتير يتم في المرحلة 3 عبر قائمة منسدلة searchable.</p>`,
      actions: [
        { label: 'تعديل', value: 'edit', kind: 'btn-ghost', icon: 'i-edit' },
        { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
      ]
    }).then((v) => { if (v === 'edit') openForm(p); });
  }

  async function remove(p) {
    const yes = await confirmHardDelete({
      docNo: p.name,
      docType: TYPE_AR[p.type],
      lines: [],
      extra: `<p style="margin-top:10px;font-size:13px">عدد المستندات المرتبطة: <b>${p.doc_count}</b>. الحذف نهائي ولا يمكن التراجع.</p>`
    });
    if (yes !== 'yes') return;
    try {
      await SamDB.call('deleteParty', p.id);
      toast(`تم حذف «${p.name}» نهائياً`, 'bad');
      SamUI.bus.emit();
      await load();
    } catch (e) { toast(e.message, 'bad', 5200); }
  }

  /* -------- helpers for other screens -------- */
  async function options(type) {
    const rows = await SamDB.call('listParties', '', type || '');
    return rows
      .filter((r) => r.is_active)
      .map((r) => ({ id: r.id, label: r.name, code: r.phone || '', sub: TYPE_AR[r.type] }));
  }

  /** open the add-party form from inside another screen; resolves with the new party */
  async function quickAdd() {
    const saved = await openForm(null);
    await load();
    return saved;
  }

  let t = null;
  document.getElementById('btnAddParty').addEventListener('click', () => openForm(null));
  document.getElementById('partySearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.search = e.target.value; load(); }, 180);
  });

  window.SamParties = { load, openForm, quickAdd, options, TYPE_AR };
  SamUI.bus.on(load);
})();
