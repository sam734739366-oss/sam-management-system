'use strict';

/* =====================================================================
   Items screen — master data + opening balances (the piece is king)
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, bindRow, modal, form, field, input, numInput, textarea, confirmHardDelete, emptyState, toggleEmpty } = SamUI;

  const state = { items: [], warehouses: [], search: '', imagesDir: '' };
  /* V4 has two buckets only — the third legacy bucket is gone for good */
  const BUCKETS = ['good', 'defect'];
  const AR = { good: 'سليم', defect: 'تالف' };

  /* =====================================================================
     The picture of the item
     A tiny photo that sits BESIDE the name of the item: in the list, in
     the smart search and on the printed card. The file lives in the data
     folder (with the database) — the item keeps only its NAME, and the
     renderer never writes a file: the picture travels as a data URL and
     the main process puts it on the disk.
     ===================================================================== */
  const appApi = () => (window.sam && window.sam.app) ? window.sam.app : null;

  /** the folder of the pictures — known only after the first call */
  async function imagesDir() {
    if (state.imagesDir) return state.imagesDir;
    const a = appApi();
    if (!a) return '';
    try {
      const r = await a.imagesDir();
      state.imagesDir = (r && r.ok && r.dir) ? r.dir : '';
    } catch (e) { state.imagesDir = ''; }
    return state.imagesDir;
  }

  /** the link of the picture of an item ('' when the item has no picture) */
  function pictureUrl(item) {
    if (!item) return '';
    const name = String(item.image || '').trim();
    if (!name || !state.imagesDir) return '';
    const a = appApi();
    if (!a) return '';
    try { return a.fileUrl(state.imagesDir + '/' + name); } catch (e) { return ''; }
  }

  /**
   * The tiny picture that sits beside the name.
   * Nothing at all when the item has no picture — no empty box, no broken image.
   */
  function thumbHtml(item, size, print) {
    const url = pictureUrl(item);
    if (!url) return '';
    const px = Number(size) || 30;
    const frame = print
      ? 'border:1px solid #cfd6e0;box-shadow:none;'
      : 'border:1px solid var(--line);box-shadow:0 1px 3px rgba(15,23,42,.14);';
    return `<img class="sam-pic" src="${esc(url)}" alt="" title="${esc(item.name || '')}"`
      /* the WHOLE picture — a photo that is taller than it is wide must not
         lose its top or its bottom; the frame grows around it */
      + ` style="width:${px}px;height:${px}px;object-fit:contain;border-radius:8px;${frame}`
      + 'background:#f1f5f9;flex:none;align-self:center;">';
  }

  /* =====================================================================
     The packs of an item — the carton, the bag and the unit of its own
     The piece is still the only truth: the packs are only ANOTHER way to
     read the same quantity, and an incomplete pack is counted in pieces.
     ===================================================================== */
  const U = () => (window.SamUnits || null);

  /** «كرتون 24 · كيس 12 · صندوق 6» — only the packs the item really uses */
  function packSummary(item) {
    const u = U();
    if (!u) return '';
    return u.unitsOf(item).map((x) => `${x.label} ${SamDB.fmt(x.pieces)}`).join(' · ');
  }

  /** the quantity written in the packs: «12 كيس + 12 حبة · 2 كرتون» */
  function packText(item, pieces) {
    const u = U();
    if (!u) return '';
    const line = {};
    u.unitsOf(item).forEach((x) => {
      const s = u.split(item, x.key, pieces);
      line[x.key] = s.count;
      line[x.key + '_part'] = s.part;
    });
    return u.describeAll(item, line);
  }

  /** the live preview of the editor: what one pack holds and an example */
  function packPreviewHtml(fake) {
    const u = U();
    if (!u) return '<span class="muted">—</span>';
    const units = u.unitsOf(fake);
    if (!units.length) {
      return '<span class="muted">لم تُحدَّد وحدة تغليف — الكمية بالحبة وحدها.</span>';
    }
    const bu = fake.base_unit || 'حبة';
    const one = units.map((x) => `${esc(x.label)} واحد = ${SamDB.fmt(x.pieces)} ${esc(bu)}`).join(' · ');
    const ex = 300;
    const t = packText(fake, ex);
    return `<div style="font-weight:800;color:var(--ink)">التغليف: ${one}</div>`
      + `<div style="color:var(--muted-fg)">مثال: ${SamDB.fmt(ex)} ${esc(bu)} = ${esc(t || '—')}</div>`
      + '<div style="color:var(--muted-fg);font-size:11.5px">الكسر يُحسب بالحبة: الكيس الناقص يُكتب «12 حبة».</div>';
  }

  async function load() {
    try {
      await imagesDir();
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
          : '<span class="chip ok">ضمن الحدود</span>';
      const zero = (v) => (v ? SamDB.fmt(v) : '—');
      const packs = packSummary(it);
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(it.code)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:9px">
            ${thumbHtml(it, 30)}
            <div style="min-width:0">
              <div>${esc(it.name)}${it.category ? ` <span class="chip sub">${esc(it.category)}</span>` : ''}${it.is_active ? '' : ' <span class="chip off">موقوف</span>'}</div>
              ${packs ? `<span class="sub">التغليف: ${esc(packs)}</span>` : ''}
            </div>
          </div>
        </td>
        <td><span class="unit-chip">${esc(it.base_unit)}</span></td>
        <td class="num">${zero(it.pieces_per_carton)}</td>
        <td class="num">${zero(it.pieces_per_bag)}</td>
        <td class="num qty ${it.mainStock.good < 0 ? 'minus' : ''}">${SamDB.fmt(it.mainStock.good)}</td>
        <td class="num qty">${SamDB.fmt(it.mainStock.defect)}</td>
        <td class="num qty ${it.totalPieces < 0 ? 'minus' : ''}">${SamDB.fmt(it.totalPieces)}</td>
        <td>${alert}</td>`;
      bindRow(tr, {
        view: () => view(it),
        edit: () => openForm(it),
        del: () => remove(it)
      });
      tb.appendChild(tr);
    });
    emptyState('itemsEmpty', {
      title: 'لا توجد أصناف',
      hint: 'أضف أول صنف مع وحدته الأساسية وأرصده الافتتاحي لتبدأ الحركات.',
      actionLabel: 'إضافة صنف',
      onAction: () => openForm(null)
    });
    toggleEmpty('itemsEmpty', state.items.length > 0);
  }

  /* ---------------- the picture field of the editor ---------------- */
  /**
   * «صورة الصنف» — a styled button over a hidden file input, a small
   * preview of the chosen picture and a button that takes it away.
   * The picture itself is written when the form is saved.
   */
  function pictureField(item) {
    const pic = { dataUrl: '', saved: item ? String(item.image || '') : '', removed: false };

    const wrap = el('div', 'sam-pic-field');
    wrap.setAttribute('style', 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;');

    const box = el('div', 'sam-pic-box');
    box.setAttribute('style', 'width:64px;height:64px;border-radius:12px;border:1px solid var(--line);'
      + 'background:var(--surface-2);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none;');
    const img = el('img', 'sam-pic-preview');
    img.id = 'fItemImagePreview';
    img.setAttribute('style', 'width:100%;height:100%;object-fit:contain;display:none;background:#f1f5f9;');
    box.appendChild(img);

    const file = el('input', 'sam-pic-file');
    file.id = 'fItemImage';
    file.type = 'file';
    file.accept = 'image/*';
    file.setAttribute('style', 'display:none;');

    const bPick = el('button', 'btn btn-sm btn-ghost',
      `${SamUI.iconTile('i-eye', 'tone-info', 'xs')}<span class="btn-txt">اختر صورة</span>`);
    bPick.type = 'button';
    bPick.id = 'fItemImagePick';
    const bClear = el('button', 'btn btn-sm btn-ghost',
      `${SamUI.iconTile('i-trash', 'tone-adjust', 'xs')}<span class="btn-txt">إزالة الصورة</span>`);
    bClear.type = 'button';
    bClear.id = 'fItemImageClear';

    const show = (url) => {
      if (url) { img.src = url; img.style.display = 'block'; }
      else { img.removeAttribute('src'); img.style.display = 'none'; }
    };
    show(pictureUrl(item));

    bPick.addEventListener('click', () => file.click());
    bClear.addEventListener('click', () => {
      pic.dataUrl = '';
      if (pic.saved) pic.removed = true;
      show('');
    });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type || '')) { toast('الملف المختار ليس صورة', 'bad'); return; }
      const fr = new FileReader();
      fr.onload = () => { pic.dataUrl = String(fr.result || ''); pic.removed = false; show(pic.dataUrl); };
      fr.onerror = () => toast('تعذّرت قراءة الصورة', 'bad');
      fr.readAsDataURL(f);
    });

    wrap.append(box, file, bPick, bClear);
    return { node: wrap, pic };
  }

  /* ---------------- form ---------------- */
  async function openForm(item) {
    const editing = !!item;
    await imagesDir();
    let openings = {};
    if (editing) {
      try { openings = await SamDB.call('openingBalances', item.id); } catch (e) { /* keep empty */ }
    }

    const body = el('div');

    /* --- section 1: the identity of the item --- */
    body.appendChild(el('div', 'form-sec', `${SamUI.iconTile('i-tag', 'tone-sreturn', 'sm')}<span>بيانات الصنف</span>`));
    const grid = el('div', 'form-grid form-grid-4');

    const code = input({ placeholder: 'مثال: 0001', value: item ? item.code : '' });
    const name = input({ placeholder: 'مثال: مياه جلدلة 1.5 لتر', value: item ? item.name : '' });
    const unit = input({ placeholder: 'مثال: حبة، علبة، أمبول', value: item ? item.base_unit : 'حبة' });
    const cat = input({ placeholder: 'مثال: خام / منتج تام / ملحقات', value: item ? item.category || '' : '' });
    // never pre-filled with 0: empty box + "0" placeholder
    const perCtn = numInput({ value: item ? item.pieces_per_carton : 0, placeholder: '0' });
    const perBag = numInput({ value: item ? item.pieces_per_bag : 0, placeholder: '0' });
    const minGood = numInput({ value: item ? item.min_good_alert : 0, placeholder: '0' });
    const maxDefect = numInput({ value: item ? item.max_defect_alert : 0, placeholder: '0' });
    /* the unit of its own — beside the carton and the bag */
    const unitLabel = input({
      placeholder: 'مثال: صندوق',
      value: item ? item.unit_label || '' : '',
      maxlength: 24,
      id: 'fUnitLabel'
    });
    const unitPieces = numInput({ value: item ? item.unit_pieces : 0, placeholder: '0' });
    unitPieces.id = 'fUnitPieces';

    grid.append(
      field('كود الصنف', code, 'كود فريد يميّز الصنف في كل الشاشات', 'i-hash'),
      field('اسم الصنف', name, 'الاسم الذي يظهر في الفواتير والتقارير', 'i-tag'),
      field('الوحدة الأساسية', unit, 'هذه الوحدة تظهر في كل الفواتير والتقارير', 'i-sigma'),
      field('الفئة', cat, 'تصنيف يجمع الصنف في التقارير', 'i-list')
    );

    /* the picture of the item — beside its name, wherever the name is */
    const pic = pictureField(item);
    const picField = el('div', 'field full');
    const picLab = el('span', 'field-label');
    picLab.insertAdjacentHTML('afterbegin', SamUI.plate('field-ic', 'i-eye', null, 'xs'));
    picLab.appendChild(el('span', 'field-txt', esc('صورة الصنف')));
    picField.appendChild(picLab);
    picField.appendChild(pic.node);
    picField.appendChild(el('em', 'hint-txt', esc('صورة مصغّرة تظهر ملاصقة لاسم الصنف في القائمة والبحث الذكي وبطاقة الصنف.')));
    grid.appendChild(picField);
    body.appendChild(grid);

    /* --- section 2: packing and the stock alerts --- */
    body.appendChild(el('div', 'form-sec', `${SamUI.iconTile('i-archive-box', 'tone-move', 'sm')}<span>التغليف وحدود التنبيه</span>`));
    const grid2 = el('div', 'form-grid form-grid-4');
    grid2.append(
      field('عدد الوحدات لكل كرتونة', perCtn, 'معلوماتي فقط — لا يدخل في أي حساب', 'i-archive-box'),
      field('عدد الوحدات لكل كيس', perBag, 'معلوماتي فقط — لا يدخل في أي حساب', 'i-archive'),
      field('اسم الوحدة', unitLabel, 'اسم مختصر لوحدة إضافية — مثال: صندوق', 'i-tag'),
      field('عدد الحبات فيها', unitPieces, 'كم حبة تحتوي الوحدة الواحدة', 'i-sigma'),
      field('حد التنبيه الأدنى للجيد', minGood, 'تنبيه إذا قلّ الجيد عن هذا الرقم', 'i-warn'),
      field('حد التالف الأقصى', maxDefect, 'تنبيه إذا زاد التالف عن هذا الرقم', 'i-alert')
    );
    body.appendChild(grid2);

    /* the live preview of the packs — it follows every number the user types */
    const packPrev = el('div', 'sam-pack-preview');
    packPrev.id = 'fPackPreview';
    packPrev.setAttribute('style', 'display:flex;flex-direction:column;gap:3px;margin-top:12px;padding:10px 12px;'
      + 'border:1px dashed var(--line);border-radius:11px;background:var(--surface-2);font-size:12.5px;line-height:1.7;');
    body.appendChild(packPrev);

    const fakeItem = () => ({
      base_unit: unit.value.trim() || 'حبة',
      pieces_per_carton: SamDB.n(perCtn.value),
      pieces_per_bag: SamDB.n(perBag.value),
      unit_label: unitLabel.value.trim(),
      unit_pieces: SamDB.n(unitPieces.value)
    });
    const refreshPreview = () => { packPrev.innerHTML = packPreviewHtml(fakeItem()); };
    [perCtn, perBag, unitPieces, unitLabel].forEach((inp) => {
      inp.addEventListener('input', refreshPreview);
      inp.addEventListener('blur', refreshPreview);
    });
    refreshPreview();

    // free-text fields stay text inputs but suggest values already stored in the DB
    SamSuggest.attach(unit, 'base_unit');
    SamSuggest.attach(cat, 'category');

    /* ---- opening balances ---- */
    body.appendChild(el('div', 'form-sec', `${SamUI.iconTile('i-pin', 'tone-warn', 'sm')}<span>الأرصدة الافتتاحية (حبة)</span>`));
    const bal = el('div', 'bal-grid');
    bal.append(
      el('div', 'hd', 'المخزن'),
      el('div', 'hd', 'سليم'),
      el('div', 'hd', 'تالف')
    );
    state.warehouses.forEach((w) => {
      const saved = openings[w.id] || {};
      const nameCell = el('div', 'wh-name',
        `<span>${esc(w.name)}</span><span class="chip sub">${esc(w.code)}</span>`);
      bal.appendChild(nameCell);
      for (const b of BUCKETS) {
        const cell = numInput({ value: saved[b] || 0, center: true, placeholder: '0' });
        cell.classList.add('bal-in');
        cell.dataset.wh = w.id;
        cell.dataset.bucket = b;
        bal.appendChild(cell);
      }
    });
    body.appendChild(bal);
    body.appendChild(el('p', 'foot-note', 'الحبة هي وحدة الحساب. الكرتونة والكيس والوحدة الخاصة تُسجَّل لأغراض العرض فقط، والحقول الفارغة تعني صفراً.'));

    const ok = await form({
      title: editing ? `تعديل الصنف: ${item.code}` : 'إضافة صنف جديد',
      body,
      wide: true,
      submitLabel: editing ? 'حفظ التعديلات' : 'حفظ الصنف',
      async onSubmit() {
        const label = unitLabel.value.trim();
        const payload = {
          code: code.value.trim(),
          name: name.value.trim(),
          base_unit: unit.value.trim() || 'حبة',
          category: cat.value.trim(),
          pieces_per_carton: SamDB.n(perCtn.value),
          pieces_per_bag: SamDB.n(perBag.value),
          unit_label: label,
          unit_pieces: label ? SamDB.n(unitPieces.value) : 0,
          min_good_alert: SamDB.n(minGood.value),
          max_defect_alert: SamDB.n(maxDefect.value),
          /* the picture that is already there stays — the change of the
             picture is written below, when the file is really on the disk */
          image: item ? String(item.image || '') : '',
          is_active: true
        };
        if (!payload.code) throw new Error('كود الصنف مطلوب');
        if (!payload.name) throw new Error('اسم الصنف مطلوب');

        const balances = [];
        bal.querySelectorAll('[data-bucket]').forEach((inp) => {
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

        let saved;
        if (editing) {
          saved = await SamDB.call('updateItem', item.id, payload, clean);
          toast(`تم تحديث «${payload.name}»`, 'ok');
        } else {
          saved = await SamDB.call('addItem', payload, clean);
          toast(`تم إضافة «${payload.name}»${clean.length ? ' مع الأرصدة الافتتاحية' : ''}`, 'ok');
        }

        /* ---- the picture: it is written AFTER the item, so the file can
           carry the id of the item and stay unique ---- */
        try {
          const oldName = item ? String(item.image || '') : '';
          let newName = oldName;
          if (pic.pic.dataUrl) {
            const a = appApi();
            if (!a) throw new Error('خدمة الصور غير متاحة');
            const r = await a.saveImage({ name: `item-${saved.id}`, dataUrl: pic.pic.dataUrl });
            if (!r || !r.ok) throw new Error((r && r.error) || 'تعذّر حفظ الصورة');
            newName = r.name;
            if (oldName && oldName !== newName) await a.removeImage(oldName);
          } else if (pic.pic.removed) {
            const a = appApi();
            if (a && oldName) await a.removeImage(oldName);
            newName = '';
          }
          if (newName !== String((saved && saved.image) || '')) {
            saved = await SamDB.call('updateItem', saved.id, { ...payload, image: newName }, null);
          }
        } catch (e) {
          toast(`حُفظ الصنف لكن تعذّر حفظ الصورة: ${e && e.message ? e.message : e}`, 'warn', 4200);
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
    const total = item.totalPieces;
    const table = SamUI.tableHtml(
      [
        { key: 'name', label: 'المخزن' },
        { key: 'code', label: 'الكود' },
        { key: 'good', label: 'سليم' },
        { key: 'defect', label: 'تالف' },
        { key: 'tot', label: 'الإجمالي' }
      ],
      rows.map((r, i) => ({ ...r, no: i + 1, tot: r.good + r.defect })),
      SamDB.fmt(total)
    );
    const packs = packSummary(item);
    const pic = thumbHtml(item, 56);
    const body = `
      <dl class="info">
        <dt>الكود</dt><dd>${esc(item.code)}</dd>
        <dt>الاسم</dt><dd>${pic ? `<span style="display:inline-flex;align-items:center;gap:8px;vertical-align:middle">${pic}<span>${esc(item.name)}</span></span>` : esc(item.name)}</dd>
        <dt>الفئة</dt><dd>${esc(item.category || '—')}</dd>
        <dt>الوحدة الأساسية</dt><dd>${esc(item.base_unit)}</dd>
        <dt>وحدات / كرتونة</dt><dd>${item.pieces_per_carton ? SamDB.fmt(item.pieces_per_carton) : '—'}</dd>
        <dt>وحدات / كيس</dt><dd>${item.pieces_per_bag ? SamDB.fmt(item.pieces_per_bag) : '—'}</dd>
        <dt>الوحدة الخاصة</dt><dd>${item.unit_label ? `${esc(item.unit_label)} — ${item.unit_pieces ? SamDB.fmt(item.unit_pieces) : '—'} ${esc(item.base_unit)}` : '—'}</dd>
        <dt>التغليف</dt><dd>${packs ? esc(packs) : '—'}</dd>
        <dt>حد الجيد الأدنى</dt><dd>${item.min_good_alert ? SamDB.fmt(item.min_good_alert) : '—'}</dd>
        <dt>حد التالف الأقصى</dt><dd>${item.max_defect_alert ? SamDB.fmt(item.max_defect_alert) : '—'}</dd>
        <dt>الرصيد الكلي</dt><dd>${SamDB.fmt(item.totalPieces)} ${esc(item.base_unit)}</dd>
      </dl>
      <div style="margin-top:14px">${rows.length ? table : '<p class="foot-note">لا رصيد مسجلاً لهذا الصنف في أي موقع.</p>'}</div>`;
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
        { key: 'tot', label: 'الإجمالي (حبة)' }
      ],
      rows.map((r) => ({ name: `${r.code} — ${r.name}`, good: SamDB.fmt(r.good), defect: SamDB.fmt(r.defect), tot: SamDB.fmt(r.good + r.defect) })),
      SamDB.fmt(total)
    );
    /* the picture of the item sits beside its name, and the packs are
       written under it — the paper carries the same truth as the screen */
    const packs = packSummary(item);
    const pic = thumbHtml(item, 44, true);
    const cardHead = `
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px">
        ${pic}
        <div>
          <div style="font-weight:800;font-size:12pt;color:#101828">${esc(item.name)}</div>
          <div style="font-size:9pt;color:#475467">${esc(item.code)}${packs ? ' — التغليف: ' + esc(packs) : ''}</div>
        </div>
      </div>`;
    SamUI.printPreview({
      title: 'بطاقة رصيد صنف',
      subtitle: 'كشف مخزون داخلي — الكميات بالوحدة الأساسية',
      docRef: item.code,
      docRefLabel: 'كود الصنف',
      head: [
        { k: 'الصنف', v: item.name },
        { k: 'الوحدة', v: item.base_unit },
        { k: 'التاريخ', v: new Date().toLocaleDateString('ar-EG-u-nu-latn') }
      ],
      bodyHtml: cardHead + html,
      footer: 'SAM Management System — الأرصدة بالوحدة الأساسية',
      kind: 'item_card'
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
      /* the picture of a deleted item is a file nobody needs any more */
      const a = appApi();
      if (a && item.image) { try { await a.removeImage(item.image); } catch (e) { /* the file may be gone */ } }
      toast(`تم حذف «${item.name}» نهائياً وعكس أرصدته`, 'bad', 4200);
      SamUI.bus.emit();
      await load();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /* ---------------- smart searchable lookup (uses SamUI.combo) ---------------- */
  /**
   * The dropdown of the smart search carries the picture of the item beside
   * its name and the packs it uses. The combo itself belongs to the shared
   * UI, so the picture is added here — after every repaint of the list.
   */
  function paintComboPics(combo) {
    if (!combo || typeof combo.renderList !== 'function') return;
    if (combo.__samPainted) return;
    combo.__samPainted = true;

    const paint = () => {
      const pop = combo.pop;
      if (!pop) return;
      pop.querySelectorAll('.combo-opt').forEach((opt) => {
        const labelEl = opt.querySelector('.label');
        if (!labelEl) return;
        const codeEl = opt.querySelector('.code');
        const code = codeEl ? (codeEl.textContent || '').trim() : '';
        const label = (labelEl.textContent || '').trim();
        const item = (code ? state.items.find((x) => x.code === code) : null)
          || state.items.find((x) => x.name === label);
        if (!item) return;
        if (!opt.querySelector('.sam-pic')) {
          const url = pictureUrl(item);
          if (url) {
            const img = document.createElement('img');
            img.className = 'sam-pic';
            img.src = url;
            img.alt = '';
            img.title = item.name || '';
            img.setAttribute('style', 'width:26px;height:26px;object-fit:contain;border-radius:7px;background:#f1f5f9;'
              + 'border:1px solid var(--line);box-shadow:0 1px 3px rgba(15,23,42,.14);background:#fff;flex:none;align-self:center;');
            labelEl.parentNode.insertBefore(img, labelEl);
          }
        }
        if (!opt.querySelector('.sam-pack')) {
          const packs = packSummary(item);
          if (packs) {
            const sp = document.createElement('span');
            sp.className = 'sam-pack';
            sp.setAttribute('style', 'font-size:11px;font-weight:800;color:var(--brand-600);white-space:nowrap;');
            sp.textContent = packs;
            const sub = opt.querySelector('.sub');
            if (sub) sub.parentNode.insertBefore(sp, sub);
            else labelEl.parentNode.appendChild(sp);
          }
        }
      });
    };

    const watch = () => {
      if (!combo.pop || combo.pop.__samWatched) return;
      combo.pop.__samWatched = true;
      try {
        const mo = new MutationObserver(() => { try { paint(); } catch (e) { /* the list stays usable */ } });
        mo.observe(combo.pop, { childList: true });
      } catch (e) { /* the observer is a safety net, not a must */ }
    };

    const base = combo.renderList.bind(combo);
    combo.renderList = function () {
      base();
      watch();
      try { paint(); } catch (e) { /* the list stays usable */ }
    };
    if (typeof combo.openList === 'function') {
      const baseOpen = combo.openList.bind(combo);
      combo.openList = function () {
        const r = baseOpen();
        watch();
        try { paint(); } catch (e) { /* the list stays usable */ }
        return r;
      };
    }
  }

  async function smartSearch() {
    await imagesDir();
    const itemHost = el('div');
    const whHost = el('div');
    const out = el('div', 'combo-result', '<span class="muted">اختر صنفاً لعرض رصيده بالحبة.</span>');

    const refresh = async () => {
      const itemId = itemCombo.getValue();
      const whId = whCombo.getValue();
      if (!itemId) return;
      try {
        const item = await SamDB.call('getItem', itemId);
        const s = whId ? (item.stockByWarehouse[whId] || { good: 0, defect: 0 }) : item.mainStock;
        const total = s.good + s.defect;
        const packs = packSummary(item);
        const goodTxt = packText(item, s.good);
        const totTxt = packText(item, total);
        out.innerHTML = `
          <div style="grid-column:1/-1;display:flex;align-items:center;gap:10px;margin-bottom:4px">
            ${thumbHtml(item, 40)}
            <div style="min-width:0">
              <div style="font-weight:800;color:var(--ink)">${esc(item.name)}</div>
              <div style="font-size:11.5px;color:var(--muted-fg);font-weight:600">${esc(item.code)}${packs ? ' · التغليف: ' + esc(packs) : ''}</div>
            </div>
          </div>
          <div class="cr-row"><span>سليم</span><b>${SamDB.fmt(s.good)}</b></div>
          ${goodTxt ? `<div class="cr-row"><span>بالتغليف</span><b>${esc(goodTxt)}</b></div>` : ''}
          <div class="cr-row"><span>تالف</span><b>${SamDB.fmt(s.defect)}</b></div>
          <div class="cr-row total"><span>الإجمالي (${esc(item.base_unit)})</span><b>${SamDB.fmt(total)}</b></div>
          ${totTxt ? `<div class="cr-row"><span>بالتغليف</span><b>${esc(totTxt)}</b></div>` : ''}`;
      } catch (e) { out.innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
    };

    const itemCombo = SamUI.combo(itemHost, {
      placeholder: 'اكتب جزءاً من الاسم أو الكود…',
      emptyText: 'لا يوجد صنف مطابق',
      onChange: refresh,
      items: state.items.map((i) => ({ id: i.id, label: i.name, code: i.code, sub: `${SamDB.fmt(i.mainStock.good)} ${i.base_unit}` }))
    });
    paintComboPics(itemCombo);
    const whCombo = SamUI.combo(whHost, {
      placeholder: 'كل المخازن (الإجمالي)…',
      emptyText: 'لا توجد مخازن',
      onChange: refresh,
      items: [{ id: 0, label: 'كل المخازن — الإجمالي', code: 'كلي' }].concat(
        state.warehouses.map((w) => ({ id: w.id, label: w.name, code: w.code }))
      )
    });

    const grid = el('div', 'form-grid');
    const outWrap = el('div', 'full');
    outWrap.appendChild(out);
    grid.append(field('الصنف', itemHost, '', 'i-box'), field('المخزن', whHost, '', 'i-warehouse'), outWrap);

    const body = el('div');
    body.appendChild(el('p', 'tip', 'اكتب حرفين من الاسم أو الكود ثم Enter — نفس القائمة المستخدمة في المستندات والفلاتر.'));
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

  window.SamItems = { load, openForm, smartSearch, packSummary, packText, pictureUrl };
  SamUI.bus.on(load);
})();
