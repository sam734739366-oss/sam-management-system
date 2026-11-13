'use strict';

/* =====================================================================
   مركز التقارير — V4
     · الشاشة مُشغِّل: بطاقة لكل تقرير جاهز، والنقر يفتح النافذة
     · النافذة تحمل الفلاتر + المعاينة + أزرار التصدير والطباعة
     · كل التقارير تشترك في مسار واحد: معاينة ← تذييل ← Excel ← طباعة
     · دبل-كليك على السطر ⇒ المستند المصدر (تعديل / حذف نهائي)
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, combo, printPreview, emptyState, toggleEmpty, bindRow } = SamUI;

  /* ---------------- الأعمدة القابلة للاختيار في تقرير الحركة ---------------- */
  const COLUMNS = [
    { key: 'moveDate', label: 'التاريخ', on: true },
    { key: 'createdAt', label: 'وقت التسجيل', on: false },
    { key: 'docNo', label: 'رقم المستند', on: true },
    { key: 'docTypeAr', label: 'نوع المستند', on: true },
    { key: 'partyName', label: 'العميل / المورد', on: true },
    { key: 'itemCode', label: 'كود الصنف', on: true },
    { key: 'itemName', label: 'اسم الصنف', on: true },
    { key: 'baseUnit', label: 'الوحدة', on: true },
    { key: 'warehouseName', label: 'المخزن', on: true },
    { key: 'bucketAr', label: 'الحالة', on: true },
    { key: 'cartons', label: 'كراتين', on: false, num: true },
    { key: 'bags', label: 'أكياس', on: false, num: true },
    { key: 'inQty', label: 'وارد', on: true, num: true },
    { key: 'outQty', label: 'صادر', on: true, num: true },
    { key: 'delta', label: 'صافي الحركة', on: true, num: true, signed: true },
    { key: 'mainBalance', label: 'الرصيد الحالي', on: true, num: true },
    { key: 'movingBalance', label: 'الرصيد المتحرك', on: true, num: true },
    { key: 'invoiceValue', label: 'قيمة الفاتورة', on: true, money: true },
    { key: 'isCustomer', label: 'مادة العميل', on: false },
    { key: 'note', label: 'ملاحظة', on: false }
  ];

  /** الحالات القابلة للاختيار */
  const BUCKETS = [
    { key: 'good', label: 'سليم', on: true },
    { key: 'defect', label: 'تالف', on: false }
  ];
  /** الخيارات الإضافية */
  const OPTIONS = [
    { key: 'byLocation', label: 'تفصيل حسب المخزن', on: false },
    { key: 'includeCustomer', label: 'ضمّ مادة العملاء (النفخ للغير)', on: false }
  ];
  /** الفترات الجاهزة */
  const PERIODS = [
    { key: 'today', label: 'اليوم' },
    { key: 'd30', label: 'آخر ٣٠ يوم' },
    { key: 'month', label: 'هذا الشهر' },
    { key: 'all', label: 'كل الفترات' }
  ];

  /** أيقونة كل تقرير — التمييز البصري بين التقارير */
  const REPORT_ICONS = {
    movements: 'i-swap',
    stock_status: 'i-box',
    item_ledger: 'i-list',
    warehouse_flow: 'i-wh',
    movement_summary: 'i-chart',
    shortage: 'i-alert',
    damage: 'i-scrap',
    party_balance: 'i-users',
    production_gap: 'i-factory'
  };

  /** أعمدة لا تُجمع — الأرصدة ليست أرقاماً قابلة للجمع */
  const NO_SUM = ['mainBalance', 'movingBalance', 'balance', 'minAlert', 'maxDefect', 'alert', 'alertKind', 'invoiceValue'];

  /** أنواع حركات إضافية لا تندرج تحت مستندات الفواتير */
  const EXTRA_KINDS = {
    opening: 'رصيد افتتاحي',
    issue: 'صرف إنتاج (سجل قديم)',
    receipt: 'استلام إنتاج (سجل قديم)',
    tolling_in: 'استلام نفخ للغير',
    tolling_out: 'إصدار نفخ للغير',
    scrap: 'هدر'
  };

  /** بديل عن قاعدة البيانات لو لم يجهز الجسر بعد */
  const FALLBACK_CATALOGUE = [
    { key: 'movements', title: 'حركة المخزون', hint: 'كل حركات الدخول والخروج بالتفصيل', landscape: true },
    { key: 'stock_status', title: 'أرصدة الأصناف', hint: 'الرصيد الحالي لكل صنف في كل مخزن', landscape: false },
    { key: 'item_ledger', title: 'كشف حساب صنف', hint: 'حركة الصنف سطراً سطراً مع الرصيد الجاري', landscape: false },
    { key: 'warehouse_flow', title: 'حركة المخازن', hint: 'الداخل والخالص لكل مخزن خلال الفترة', landscape: false },
    { key: 'movement_summary', title: 'ملخص الحركات', hint: 'عدد وقيمة كل نوع مستند', landscape: false },
    { key: 'shortage', title: 'الأصناف الناقصة', hint: 'ما وصل حد التنبيه أو نفد من المخزون', landscape: false },
    { key: 'damage', title: 'التالف والهدر', hint: 'حركة التالف والهدر لكل صنف', landscape: false },
    { key: 'party_balance', title: 'حساب الأطراف', hint: 'ماذا دخل وماذا خرج لكل عميل أو مورد', landscape: false },
    { key: 'production_gap', title: 'عجز وتالف الإنتاج', hint: 'عجز الكراتين وتالفها — تقرير توثيقي بلا أثر على المخزون', landscape: true }
  ];

  const state = {
    catalogue: [],
    result: null,
    error: '',
    report: 'movements',
    period: 'd30',
    ran: false,
    packs: readPacks(),  // show the cartons/bags columns (remembered)
    win: null
  };

  /* =====================================================================
     الكراتين والأكياس — the packs of an item, for READING only:
     the accounting stays on the piece, the packs are only another way
     to say the same quantity («12 كيس + 12 حبة»). Every report that
     shows an item with a quantity gets them:
       · a report of MOVEMENTS describes that movement;
       · a report that only knows a BALANCE describes that balance.
     The switch is remembered (the same key the daily report uses).
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

  /** the kinds of packs, in the order they are shown */
  const PACK_KINDS = [
    { key: 'cartons', label: 'كرتون' },
    { key: 'bags', label: 'كيس' },
    { key: 'unit', label: 'وحدة الصنف' }
  ];

  /** the columns that carry the quantity of a movement */
  const MOVEMENT_QTY = ['inQty', 'outQty', 'delta'];

  /** what the packs of each report describe */
  const PACK_SPECS = {
    /* every line of the movement — the packs of THAT movement */
    movements: {
      label: 'الحركة',
      qty: (r) => Math.abs(SamDB.n(r.delta)),
      recorded: (r) => ({ cartons: r.cartons, bags: r.bags }),
      item: (r) => itemOfRow(r),
      /* the packs are the reading of the movement — they only stand beside
         the columns that show it */
      needs: (cols) => cols.some((c) => MOVEMENT_QTY.indexOf(c.key) >= 0)
    },
    /* the ledger of one item — the packs of every movement of it */
    item_ledger: {
      label: 'الحركة',
      qty: (r) => Math.abs(SamDB.n(r.delta)),
      item: () => itemById(filters.itemId)
    },
    /* the stock of an item in every warehouse — the packs of its balance */
    stock_status: {
      label: 'الرصيد',
      qty: (r) => SamDB.n(r.allTotal),
      item: (r) => itemById(r.itemId)
    },
    /* the damage of an item — the packs of what went out */
    damage: {
      label: 'صادر تالف',
      qty: (r) => SamDB.n(r.outQty),
      item: (r) => itemByCode(r.itemCode)
    },
    /* the shortage of an item — the packs of what is left */
    shortage: {
      label: 'سليم',
      qty: (r) => SamDB.n(r.good),
      item: (r) => itemById(r.itemId)
    }
  };

  /** the item of a row — its packs (how many pieces in a bag / carton) */
  function itemOfRow(row) {
    if (!row) return null;
    const byId = row.itemId ? itemById(row.itemId) : null;
    if (byId) return byId;
    const byCode = row.itemCode ? itemByCode(row.itemCode) : null;
    if (byCode) return byCode;
    /* the row itself carries the pack sizes of its item */
    if (row.perCarton || row.perBag) {
      return { pieces_per_carton: row.perCarton, pieces_per_bag: row.perBag };
    }
    return null;
  }

  function itemById(id) {
    if (id == null) return null;
    return (ref.byId && ref.byId[id]) || null;
  }
  function itemByCode(code) {
    if (code == null) return null;
    return (ref.byCode && ref.byCode[String(code)]) || null;
  }

  /** the packs of a quantity, written the way the customer counts them */
  function packText(item, key, pieces, recorded) {
    if (!item) return '';
    const u = SamUnits.unitsOf(item).find((x) => x.key === key);
    if (!u) return '';
    const q = Math.max(0, Math.round(SamDB.n(pieces)));
    const s = SamUnits.split(item, key, q);
    let count = s.count;
    let part = s.part;
    /* the line of the document carries the count the user typed — it wins
       when it still fits the quantity (the rest is the incomplete part) */
    const rec = Math.max(0, Math.round(SamDB.n(recorded)));
    if (rec > 0) {
      const rest = q - rec * u.pieces;
      if (rest >= 0 && rest < u.pieces) { count = rec; part = rest; }
    }
    return SamUnits.describe(item, key, count, part);
  }

  /**
   * Give the result its pack columns — one per kind the items really use —
   * and write the numbers of every row («12 كيس + 12 حبة»).
   */
  function applyPacks(res) {
    const spec = PACK_SPECS[res.report];
    const rows = res.rows || [];
    res.packColumns = [];
    if (!spec || !rows.length) return res;
    /* the packs describe the quantity of the report — when the table shows
       no quantity at all, they have nothing to stand beside */
    if (spec.needs && !spec.needs(res.columns || [])) return res;

    const used = {};
    rows.forEach((r) => {
      const it = spec.item(r);
      if (!it) return;
      SamUnits.unitsOf(it).forEach((u) => {
        if (!used[u.key]) used[u.key] = new Set();
        used[u.key].add(u.label);
      });
    });
    const kinds = PACK_KINDS.filter((k) => used[k.key]).map((k) => {
      const labels = [...used[k.key]];
      return { key: k.key, label: labels.length === 1 ? labels[0] : k.label };
    });
    if (!kinds.length) return res;

    res.packColumns = kinds.map((k) => ({
      key: `pack_${k.key}`,
      label: `${k.label} (${spec.label})`,
      pack: true
    }));
    rows.forEach((r) => {
      const it = spec.item(r);
      const rec = spec.recorded ? spec.recorded(r) : null;
      kinds.forEach((k) => {
        const txt = packText(it, k.key, spec.qty(r), rec ? rec[k.key] : null);
        r[`pack_${k.key}`] = txt || '';
      });
    });
    return res;
  }

  /** the columns the screen shows — the packs follow the switch */
  function activeColumns(res) {
    const base = (res && res.columns) || [];
    if (!state.packs) return base;
    return base.concat((res && res.packColumns) || []);
  }

  /** turn the packs on / off — the choice is remembered and shared */
  function setPacks(on) {
    state.packs = !!on;
    writePacks(state.packs);
    try { window.dispatchEvent(new CustomEvent('sam-packs-change', { detail: { on: state.packs } })); }
    catch (e) { /* an old runtime without the event still works */ }
    if (refs && refs.fPacks) refs.fPacks.checked = state.packs;
    /* the columns are already counted — only the painting changes */
    if (state.win) state.win.pick(state.win.activeKey || state.report);
  }

  /** حالة الفلاتر — تبقى كما هي عبر كل إعادة رسم للنافذة */
  const filters = {
    dateFrom: '',
    dateTo: '',
    warehouseId: null,
    kind: null,
    partyId: null,
    itemId: null,
    buckets: ['good'],
    byLocation: false,
    includeCustomer: false
  };

  /** البيانات المرجعية (المخازن / الأصناف / الأطراف) */
  const ref = { items: [], warehouses: [], parties: [], kinds: {}, byId: {}, byCode: {}, loaded: false };

  let combos = null;      // قوائم الفلاتر
  let filterHost = null;  // لوحة الفلاتر (تُعاد إضافتها بعد كل رسم)
  let refs = null;        // عناصر لوحة الفلاتر
  let winGen = 0;         // رقم النافذة الحالية — يمنع نافذة قديمة من تدمير حديثة

  /* ---------------- تواريخ ---------------- */
  function shiftDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function periodRange(key) {
    const today = SamUI.today();
    if (key === 'today') return [today, today];
    if (key === 'd30') return [shiftDays(today, -29), today];
    if (key === 'month') return [today.slice(0, 8) + '01', today];
    return ['', ''];
  }

  /* ---------------- البناء: لوحة الفلاتر ---------------- */
  function buildFilterHost() {
    const host = el('div', 'rw-panel');

    /* الصف 1 — الفترة */
    const r1 = el('div', 'rw-frow rw-f-period');
    r1.innerHTML = `<div class="rw-flabel">${SamUI.plate('rw-fic', 'i-calendar', null, 'xs')}<span>الفترة</span></div>`;
    const b1 = el('div', 'rw-fbody rw-dates');
    b1.innerHTML = `<div class="rw-chips" id="periodWrap"></div>
      <label class="field"><span>من تاريخ</span><input type="date" id="fFrom" class="input" /></label>
      <label class="field"><span>إلى تاريخ</span><input type="date" id="fTo" class="input" /></label>`;
    r1.appendChild(b1);

    /* الصف 2 — النطاق */
    const r2 = el('div', 'rw-frow rw-f-scope');
    r2.innerHTML = `<div class="rw-flabel">${SamUI.plate('rw-fic', 'i-search', null, 'xs')}<span>النطاق</span></div>`;
    const b2 = el('div', 'rw-fbody rw-scope');
    b2.innerHTML = `
      <div class="field"><span>المخزن</span><div id="fWh"></div></div>
      <div class="field"><span>نوع المستند</span><div id="fKind"></div></div>
      <div class="field"><span>العميل / المورد</span><div id="fParty"></div></div>
      <div class="field"><span>الصنف</span><div id="fItem"></div></div>`;
    r2.appendChild(b2);

    /* الصف 3 — الحالة والخيارات */
    const r3 = el('div', 'rw-frow rw-f-state');
    r3.innerHTML = `<div class="rw-flabel">${SamUI.plate('rw-fic', 'i-box', null, 'xs')}<span>الحالة</span></div>`;
    const b3 = el('div', 'rw-fbody rw-state');
    b3.innerHTML = `<div class="rw-chips" id="bucketWrap"></div><div class="rw-chips" id="optWrap"></div>
      <label class="col-check"><input type="checkbox" id="fPacks" /><span>إظهار الكراتين والأكياس</span></label>`;
    r3.appendChild(b3);

    /* الصف 4 — الأعمدة (تقرير الحركة فقط) */
    const r4 = el('div', 'rw-frow rw-f-cols');
    r4.innerHTML = `<div class="rw-flabel">${SamUI.plate('rw-fic', 'i-list', null, 'xs')}<span>الأعمدة</span></div>`;
    const b4 = el('div', 'rw-fbody');
    b4.innerHTML = `<div class="rw-col-tools">
        <button class="btn btn-sm btn-ghost" id="btnAllCols" type="button">تحديد الكل</button>
        <button class="btn btn-sm btn-ghost" id="btnNoCols" type="button">إلغاء الكل</button>
      </div><div class="rw-cols" id="colsWrap"></div>`;
    r4.appendChild(b4);

    /* الصف 5 — الأدوات */
    const r5 = el('div', 'rw-frow rw-f-tools');
    const b5 = el('div', 'rw-fbody rw-tools');
    b5.innerHTML = `<button class="btn btn-sm btn-ghost" id="btnResetFilters" type="button">تفريغ الفلاتر</button>
      <button class="btn btn-sm btn-primary" id="btnRunReport" type="button">${SamUI.iconTile('i-refresh', 'tone-info', 'xs')}<span class="btn-txt">تشغيل التقرير</span><span class="kbd">F5</span></button>`;
    r5.appendChild(b5);

    host.append(r1, r2, r3, r4, r5);

    refs = {
      node: host,
      periodWrap: host.querySelector('#periodWrap'),
      fFrom: host.querySelector('#fFrom'),
      fTo: host.querySelector('#fTo'),
      fWh: host.querySelector('#fWh'),
      fKind: host.querySelector('#fKind'),
      fParty: host.querySelector('#fParty'),
      fItem: host.querySelector('#fItem'),
      bucketWrap: host.querySelector('#bucketWrap'),
      optWrap: host.querySelector('#optWrap'),
      colsWrap: host.querySelector('#colsWrap'),
      fPacks: host.querySelector('#fPacks'),
      btnAllCols: host.querySelector('#btnAllCols'),
      btnNoCols: host.querySelector('#btnNoCols'),
      btnReset: host.querySelector('#btnResetFilters'),
      btnRun: host.querySelector('#btnRunReport'),
      colRow: r4
    };

    wireFilters();
    return host;
  }

  function wireFilters() {
    refs.fFrom.value = filters.dateFrom;
    refs.fTo.value = filters.dateTo;

    refs.fFrom.addEventListener('change', () => {
      filters.dateFrom = refs.fFrom.value;
      state.period = null;
      renderPeriods();
      rerun();
    });
    refs.fTo.addEventListener('change', () => {
      filters.dateTo = refs.fTo.value;
      state.period = null;
      renderPeriods();
      rerun();
    });
    refs.btnRun.addEventListener('click', () => rerun());
    refs.btnReset.addEventListener('click', () => resetFilters());
    refs.btnAllCols.addEventListener('click', () => {
      COLUMNS.forEach((c) => { c.on = true; });
      renderColumns();
      rerun();
    });
    refs.btnNoCols.addEventListener('click', () => {
      COLUMNS.forEach((c) => { c.on = false; });
      renderColumns();
      rerun();
    });
    /* the packs — a reading switch, not a filter: it changes the columns
       of the screen, of the print and of the Excel */
    if (refs.fPacks) {
      refs.fPacks.checked = state.packs;
      refs.fPacks.addEventListener('change', () => setPacks(refs.fPacks.checked));
    }

    renderPeriods();
    renderColumns();
    renderBuckets();
    renderOptions();
  }

  /* ---------------- مجموعات الاختيار ---------------- */
  function checkGroup(host, list, onChange, extraCls) {
    if (!host) return;
    host.innerHTML = '';
    list.forEach((c) => {
      const box = el('label', `col-check ${extraCls || ''}`);
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!c.on;
      cb.addEventListener('change', () => {
        c.on = cb.checked;
        onChange(c);
      });
      box.append(cb, el('span', '', esc(c.label)));
      host.appendChild(box);
    });
  }

  function renderPeriods() {
    if (!refs) return;
    const host = refs.periodWrap;
    host.innerHTML = '';
    PERIODS.forEach((p) => {
      const b = el('button', `period-chip${state.period === p.key ? ' on' : ''}`, esc(p.label));
      b.type = 'button';
      b.addEventListener('click', () => {
        state.period = p.key;
        const [from, to] = periodRange(p.key);
        filters.dateFrom = from;
        filters.dateTo = to;
        refs.fFrom.value = from;
        refs.fTo.value = to;
        renderPeriods();
        rerun();
      });
      host.appendChild(b);
    });
  }

  function renderColumns() {
    if (!refs) return;
    // الأعمدة تخصّ تقرير الحركة التفصيلي فقط
    refs.colRow.style.display = state.report === 'movements' ? '' : 'none';
    checkGroup(refs.colsWrap, COLUMNS, () => rerun());
  }

  function renderBuckets() {
    checkGroup(refs.bucketWrap, BUCKETS, () => { syncBuckets(); rerun(); }, 'bucket');
  }

  function renderOptions() {
    checkGroup(refs.optWrap, OPTIONS, () => { syncOptions(); rerun(); });
  }

  function syncBuckets() { filters.buckets = BUCKETS.filter((b) => b.on).map((b) => b.key); }
  function syncOptions() {
    filters.byLocation = !!(OPTIONS.find((o) => o.key === 'byLocation') || {}).on;
    filters.includeCustomer = !!(OPTIONS.find((o) => o.key === 'includeCustomer') || {}).on;
  }

  function resetFilters() {
    filters.dateFrom = '';
    filters.dateTo = '';
    filters.warehouseId = null;
    filters.kind = null;
    filters.partyId = null;
    filters.itemId = null;
    BUCKETS.forEach((b) => { b.on = b.key === 'good'; });
    OPTIONS.forEach((o) => { o.on = false; });
    state.period = 'all';
    if (refs) { refs.fFrom.value = ''; refs.fTo.value = ''; }
    renderPeriods();
    renderBuckets();
    renderOptions();
    syncCombos();
    rerun();
  }

  /* ---------------- القوائم المنسدلة ---------------- */
  function initCombos() {
    if (combos) return;
    if (!refs) return;
    combos = {
      wh: combo(refs.fWh, { placeholder: 'كل المخازن…', emptyText: 'لا توجد مخازن' }),
      kind: combo(refs.fKind, { placeholder: 'كل الأنواع…', emptyText: 'لا توجد أنواع مستندات' }),
      party: combo(refs.fParty, { placeholder: 'كل الأطراف…', emptyText: 'لا توجد أطراف' }),
      item: combo(refs.fItem, { placeholder: 'كل الأصناف…', emptyText: 'لا توجد أصناف' })
    };
    combos.wh.opts.onChange = (v) => { filters.warehouseId = v; rerun(); };
    combos.kind.opts.onChange = (v) => { filters.kind = v; rerun(); };
    combos.party.opts.onChange = (v) => { filters.partyId = v; rerun(); };
    combos.item.opts.onChange = (v) => { filters.itemId = v; rerun(); };
    fillComboItems();
    syncCombos();
  }

  function fillComboItems() {
    if (!combos) return;
    combos.item.setItems(ref.items.map((i) => ({ id: i.id, label: i.name, code: i.code, sub: i.base_unit })));
    combos.wh.setItems(ref.warehouses.map((w) => ({ id: w.id, label: w.name, code: w.code })));
    combos.party.setItems(ref.parties.map((p) => ({
      id: p.id, label: p.name, code: p.phone || '', sub: (window.SamParties && SamParties.TYPE_AR[p.type]) || ''
    })));
    const kinds = Object.assign({}, EXTRA_KINDS, ref.kinds);
    /* the DB catalogue carries {ar, sign, prefix} while the extra kinds are
       plain labels — both must end up as a readable name */
    combos.kind.setItems(Object.entries(kinds).map(([id, v]) => ({
      id,
      label: typeof v === 'string' ? v : ((v && v.ar) || id)
    })));
  }

  function syncCombos() {
    if (!combos) return;
    combos.wh.setValue(filters.warehouseId, false);
    combos.kind.setValue(filters.kind, false);
    combos.party.setValue(filters.partyId, false);
    combos.item.setValue(filters.itemId, false);
  }

  /* ---------------- البيانات المرجعية ---------------- */
  async function loadRef() {
    try {
      const [items, whs, parties, kinds] = await Promise.all([
        SamDB.call('listItems', ''),
        SamDB.call('listWarehouses'),
        SamDB.call('listParties', ''),
        SamDB.call('DOC_KINDS')
      ]);
      ref.items = items || [];
      ref.warehouses = whs || [];
      ref.parties = parties || [];
      ref.kinds = kinds || {};
      /* the items are needed for the packs — how many pieces in a bag */
      ref.byId = {};
      ref.byCode = {};
      ref.items.forEach((i) => {
        ref.byId[i.id] = i;
        if (i.code != null) ref.byCode[String(i.code)] = i;
      });
      ref.loaded = true;
    } catch (e) {
      toast(e && e.message ? e.message : String(e), 'bad');
    }
    if (combos) { fillComboItems(); syncCombos(); }
    return ref;
  }

  async function ensureCatalogue() {
    if (state.catalogue.length) return state.catalogue;
    try {
      const list = await SamDB.call('REPORTS');
      state.catalogue = (list && list.length) ? list : FALLBACK_CATALOGUE.slice();
    } catch (e) {
      state.catalogue = FALLBACK_CATALOGUE.slice();
    }
    renderCards();
    return state.catalogue;
  }

  /* ---------------- تشغيل التقرير ---------------- */
  function collectFilters() {
    syncBuckets();
    syncOptions();
    return {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      warehouseId: filters.warehouseId,
      kind: filters.kind,
      partyId: filters.partyId,
      itemId: filters.itemId,
      buckets: filters.buckets.slice(),
      byLocation: filters.byLocation,
      includeCustomer: filters.includeCustomer
    };
  }

  async function runReport(key) {
    state.report = key;
    state.error = '';
    const f = collectFilters();
    /* the packs are counted from the items — they are read in the
       background, so the report itself is never delayed by them */
    const needsItems = !ref.loaded;
    const itemsReady = needsItems ? loadRef() : null;
    try {
      if (key === 'movements') {
        const cols = COLUMNS.filter((c) => c.on);
        if (!cols.length) {
          state.result = null;
          state.error = 'اختر عموداً واحداً على الأقل من «الأعمدة» لعرض التقرير';
          return null;
        }
        const q = await SamDB.call('reportQuery', f);
        state.result = {
          report: 'movements',
          title: 'حركة المخزون',
          columns: cols,
          rows: q.rows || [],
          totals: q.totals || {},
          buckets: ((q.totals && q.totals.bucketLabels) || []).join(' + ')
        };
      } else {
        const r = await SamDB.call('runReport', Object.assign({ report: key }, f));
        state.result = {
          report: r.report || key,
          title: r.title || key,
          columns: (r.columns || []).map((c) => Object.assign({}, c)),
          rows: r.rows || [],
          totals: r.totals || {}
        };
      }
    } catch (e) {
      state.result = null;
      state.error = e && e.message ? e.message : String(e);
      return null;
    }
    /* the pack columns of the result — they are counted once, and the
       switch decides whether they are shown */
    applyPacks(state.result);
    state.ran = true;
    const result = state.result;
    /* when the items arrive, the packs are counted again — the report is
       repainted so the columns join the table */
    if (itemsReady) {
      itemsReady.then(() => {
        if (state.result !== result) return;
        applyPacks(result);
        if (state.win) state.win.pick(state.win.activeKey || state.report);
      });
    }
    return state.result;
  }

  /* ---------------- الرسم ---------------- */
  function cellText(row, c) {
    const v = row[c.key];
    if (c.signed) {
      const n = SamDB.n(v);
      return `${n > 0 ? '+' : n < 0 ? '−' : ''}${SamDB.fmt(Math.abs(n))}`;
    }
    if (c.money) return v == null || v === '' ? '—' : SamDB.money(v);
    if (c.num) return SamDB.fmt(SamDB.n(v));
    if (c.key === 'isCustomer') return v ? 'نعم' : '—';
    if (v == null || v === '') return '—';
    return String(v);
  }

  /** الأرقام القابلة للجمع في هذا التقرير */
  function sumParts(res) {
    const cols = res.columns || [];
    const rows = res.rows || [];
    const parts = [];
    cols.forEach((c) => {
      if (!c.num && !c.money) return;
      if (NO_SUM.indexOf(c.key) >= 0) return;
      const v = rows.reduce((a, r) => a + SamDB.n(r[c.key]), 0);
      parts.push({ key: c.key, label: c.label, value: v, money: !!c.money, signed: !!c.signed });
    });
    return parts;
  }

  function footHtml(res) {
    const rows = res.rows || [];
    const parts = sumParts(res).map((p) => {
      const txt = p.money ? SamDB.money(p.value) : SamDB.fmt(p.value);
      return `<span>${esc(p.label)}: <b class="${p.signed ? 'big' : ''}">${txt}</b></span>`;
    });
    const units = [...new Set(rows.map((r) => r.baseUnit).filter(Boolean))].join(' / ');
    const t = res.totals || {};
    const value = (t.value != null && res.report === 'movements')
      ? `<span>إجمالي القيمة: <b class="big">${SamDB.money(t.value)}</b> <span class="chip sub">${esc(SamUI.CURRENCY)}</span></span>`
      : '';
    return `<span>عدد الأسطر: <b>${SamDB.fmt(rows.length)}</b></span>
      ${parts.join('')}
      ${value}
      <span class="dim">${esc(periodLabel())}</span>
      ${units ? `<span class="dim">الوحدة: ${esc(units)}</span>` : ''}
      ${packsNote(res)}`;
  }

  /** the packs are a reading — the accounting stays on the piece */
  function packsNote(res) {
    if (!state.packs) return '';
    if (!(res && res.packColumns && res.packColumns.length)) return '';
    return '<span class="dim">الكراتين والأكياس: قراءة فقط — الحسبة على الحبة</span>';
  }

  /** جدول تفصيل الدخول والخروج لكل مخزن — يظهر في المعاينة وفي الطباعة */
  function locationHtml(res) {
    const locs = (res.totals && res.totals.locations) || [];
    if (!locs.length) return '';
    const rows = locs.map((l) => `<tr>
        <td>${esc(l.name)}</td>
        <td style="text-align:left">${SamDB.fmt(l.inQty)}</td>
        <td style="text-align:left">${SamDB.fmt(l.outQty)}</td>
        <td style="text-align:left">${SamDB.fmt(l.net)}</td>
      </tr>`).join('');
    const net = locs.reduce((a, l) => a + SamDB.n(l.net), 0);
    return `<div class="rw-loc">
      <h4 class="rw-loc-t">تفصيل حسب المخزن</h4>
      <table class="tbl" style="font-size:9pt;width:100%;margin-top:6px">
        <thead><tr><th>المخزن</th><th style="text-align:left">وارد</th><th style="text-align:left">صادر</th><th style="text-align:left">الصافي</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="tot-row"><td>الإجمالي</td><td colspan="3" style="text-align:left">صافي الحركة: ${SamDB.fmt(net)}</td></tr></tfoot>
      </table></div>`;
  }

  function previewNode() {
    const wrap = el('div', 'rw-preview');
    const res = state.result;

    const head = el('div', 'rw-phead');
    head.innerHTML = `
      <div class="rw-pt"><b>${esc(res ? res.title : 'التقرير')}</b><span>${esc(rangeLabel())}</span></div>
      <div class="rw-pmeta"></div>`;
    const meta = head.querySelector('.rw-pmeta');
    if (res) {
      meta.innerHTML = `<span class="chip">${esc(periodLabel())}</span>
        ${res.buckets ? `<span class="chip sub">${esc(res.buckets)}</span>` : ''}
        <span class="chip sub">${SamDB.fmt(res.rows.length)} سطر</span>`;
    }
    wrap.appendChild(head);

    if (state.error) {
      const err = el('div', 'rw-error');
      err.innerHTML = `${SamUI.iconTile('i-warn', 'tone-warn', 'xs')}<span>${esc(state.error)}</span>`;
      wrap.appendChild(err);
      return wrap;
    }
    if (!res) {
      const none = el('div', 'rw-error');
      none.innerHTML = `${SamUI.iconTile('i-inbox', 'tone-info', 'sm')}<span>اضغط «تشغيل التقرير» لعرض النتائج</span>`;
      wrap.appendChild(none);
      return wrap;
    }

    const body = el('div', 'rw-pbody');
    body.innerHTML = `<div class="tbl-wrap tall"><table class="tbl" id="reportTbl"></table></div>
      <div class="empty" id="reportEmpty"></div>
      <div id="reportLoc"></div>
      <div class="report-foot" id="reportFoot"></div>`;
    wrap.appendChild(body);
    paintTable(res, wrap);
    return wrap;
  }

  function paintTable(res, wrap) {
    const tbl = wrap.querySelector('#reportTbl');
    const emptyHost = wrap.querySelector('#reportEmpty');
    const footHost = wrap.querySelector('#reportFoot');
    if (!tbl) return;

    const cols = activeColumns(res);
    const rows = res.rows || [];

    tbl.innerHTML = `<thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => {
      const cls = c.signed
        ? `num qty ${SamDB.n(r[c.key]) >= 0 ? 'plus' : 'minus'}`
        : (c.num || c.money) ? 'num' : '';
      return `<td class="${cls}">${esc(cellText(r, c))}</td>`;
    }).join('')}</tr>`).join('')}</tbody>`;

    // السطر المزدوج يفتح المستند المصدر (فاتورة / مرتجع / سند …)
    [...tbl.querySelectorAll('tbody tr')].forEach((tr, i) => {
      const row = rows[i];
      if (!row) return;
      bindRow(tr, {
        view: () => openSource(row),
        del: row.docId
          ? () => SamDocs.removeDoc({ id: row.docId, kindAr: row.docTypeAr, doc_no: row.docNo })
          : null
      });
    });

    const hasRows = rows.length > 0;
    emptyState(emptyHost, {
      icon: 'i-inbox',
      title: hasRows ? '' : 'لا توجد نتائج مطابقة',
      hint: hasRows ? '' : 'وسّع الفترة أو غيّر الفلاتر — المعايير في الأعلى تؤثر على كل التقارير.'
    });
    toggleEmpty(emptyHost, hasRows);

    const locHost = wrap.querySelector('#reportLoc');
    if (locHost) locHost.innerHTML = locationHtml(res);

    if (footHost) footHost.innerHTML = footHtml(res);
  }

  /* ---------------- النزول إلى المصدر ---------------- */
  function openSource(row) {
    if (!row) return;
    if (row.docId) {
      SamDocs.viewDoc(row.docId);
      return;
    }
    if (row.itemId) {
      filters.itemId = row.itemId;
      filters.warehouseId = row.warehouseId || null;
      filters.partyId = null;
      syncCombos();
      toast('عرض حركة الصنف في المخزن المحدد', 'ok');
      rerun('movements');
      return;
    }
    if (row.partyId) {
      filters.partyId = row.partyId;
      filters.itemId = null;
      filters.warehouseId = null;
      syncCombos();
      toast('عرض حركة الطرف خلال الفترة المختارة', 'ok');
      rerun('movements');
      return;
    }
    toast('هذا التقرير تجميعي — لا يوجد مستند مصدر لهذا السطر', 'warn');
  }

  /* ---------------- التسميات ---------------- */
  function periodLabel() {
    if (filters.dateFrom || filters.dateTo) {
      return `${filters.dateFrom || 'البداية'} → ${filters.dateTo || 'اليوم'}`;
    }
    return 'كل الفترات';
  }

  function kindLabel(id) {
    const k = ref.kinds[id];
    if (k) return typeof k === 'string' ? k : (k.ar || id);
    return EXTRA_KINDS[id] || id;
  }

  function scopeLabel() {
    const parts = [];
    if (filters.warehouseId) {
      const w = ref.warehouses.find((x) => x.id === filters.warehouseId);
      if (w) parts.push(`المخزن: ${w.name}`);
    }
    if (filters.kind) parts.push(`النوع: ${kindLabel(filters.kind)}`);
    if (filters.partyId) {
      const p = ref.parties.find((x) => x.id === filters.partyId);
      if (p) parts.push(`الطرف: ${p.name}`);
    }
    if (filters.itemId) {
      const i = ref.items.find((x) => x.id === filters.itemId);
      if (i) parts.push(`الصنف: ${i.name}`);
    }
    return parts.length ? parts.join(' · ') : 'كل المخازن وكل الأصناف';
  }

  function rangeLabel() {
    return `${periodLabel()} · ${scopeLabel()}`;
  }

  /* ---------------- الطباعة والتصدير ---------------- */
  function isLandscape(res) {
    const cat = (state.catalogue || []).find((r) => r.key === (res ? res.report : state.report));
    if (cat && cat.landscape) return true;
    return ((res && activeColumns(res)) || []).length > 8;
  }

  /** حجم الخط يتقلص مع زيادة عدد الأعمدة — لا نصّ باهت ولا صغير */
  function fontFor(n) {
    if (n <= 6) return '10pt';
    if (n <= 10) return '8.5pt';
    return '7.5pt';
  }

  function printTable(res) {
    const cols = activeColumns(res);
    const rows = res.rows || [];
    const fs = fontFor(cols.length);
    const th = cols.map((c) => `<th${c.num || c.money ? ' style="text-align:left"' : ''}>${esc(c.label)}</th>`).join('');
    const tr = rows.map((r) => `<tr>${cols.map((c) => `<td${c.num || c.money ? ' style="text-align:left"' : ''}>${esc(cellText(r, c))}</td>`).join('')}</tr>`).join('');
    const parts = sumParts(res);
    const tot = parts.length
      ? `<tr class="tot-row"><td colspan="${cols.length}">${esc(parts.map((p) => `${p.label}: ${p.money ? SamDB.money(p.value) : SamDB.fmt(p.value)}`).join(' · '))}</td></tr>`
      : '';
    return `<table class="tbl" style="font-size:${fs};width:100%;table-layout:fixed">
      <thead><tr>${th}</tr></thead><tbody>${tr}${tot}</tbody></table>`;
  }

  function sheetOpts() {
    const res = state.result;
    return {
      title: res.title,
      subtitle: rangeLabel(),
      docRef: `RPT-${SamUI.today()}`,
      docRefLabel: 'رقم التقرير',
      head: [
        { k: 'الفترة', v: periodLabel() },
        { k: 'النطاق', v: scopeLabel() },
        { k: 'عدد الأسطر', v: SamDB.fmt(res.rows.length) }
      ],
      bodyHtml: printTable(res) + locationHtml(res),
      dense: true,
      landscape: isLandscape(res),
      footer: `SAM Management System — ${res.title} (الكميات بالوحدة الأساسية)`
        + (packsNote(res) ? ' · الكراتين والأكياس قراءة فقط' : ''),
      /* a report is not a document — nobody signs a report */
      kind: 'report'
    };
  }

  function printReport() {
    if (!state.result) return toast('شغّل التقرير أولاً', 'bad');
    printPreview(sheetOpts());
  }

  async function exportPdf() {
    if (!state.result) return toast('شغّل التقرير أولاً', 'bad');
    const res = state.result;
    const node = SamUI.sheet(sheetOpts());
    const r = await SamUI.exportPdf(node, {
      landscape: isLandscape(res),
      fileName: `SAM-${res.title.replace(/\s+/g, '-')}-${SamUI.today()}.pdf`
    });
    if (r && r.ok) toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200);
    else if (r && !r.canceled) toast(r.error || 'تعذّر حفظ الملف', 'bad');
  }

  /** the workbook of the report — the export and the checks share it */
  function excelSpec() {
    const res = state.result;
    if (!res) return null;
    const cols = activeColumns(res);
    const rows = res.rows.map((r) => {
      const o = {};
      cols.forEach((c) => {
        if (c.num || c.money) o[c.key] = SamDB.n(r[c.key]);
        else if (c.key === 'isCustomer') o[c.key] = r[c.key] ? 'نعم' : 'لا';
        else o[c.key] = r[c.key] == null ? '' : String(r[c.key]);
      });
      return o;
    });
    const totals = sumParts(res).map((p) => ({ key: p.key, value: p.value }));

    return {
      fileName: `SAM-${res.title.replace(/\s+/g, '-')}-${SamUI.today()}.xlsx`,
      sheetName: res.title.slice(0, 28),
      title: res.title,
      subtitle: `SAM Management System — ${SamUI.WATERMARK}`,
      meta: [
        ['الفترة', periodLabel()],
        ['النطاق', scopeLabel()],
        ['عدد الأسطر', SamDB.fmt(res.rows.length)]
      ],
      columns: cols.map((c) => ({
        header: c.label,
        key: c.key,
        num: !!(c.num || c.money),
        fmt: c.money ? '#,##0.00' : '#,##0'
      })),
      rows,
      totals
    };
  }

  async function exportExcel() {
    const res = state.result;
    if (!res) return toast('شغّل التقرير أولاً', 'bad');
    const spec = excelSpec();

    const out = await sam.app.saveXlsx(spec);
    if (out && out.ok) {
      toast(`تم حفظ ملف Excel: ${out.data.path} (${SamDB.fmt(out.data.rows)} سطر)`, 'ok', 5600);
      sam.app.openPath(out.data.path.replace(/[\\/][^\\/]+$/, ''));
    } else if (out && !out.canceled) {
      toast(out.error || 'تعذّر حفظ الملف', 'bad', 5200);
    }
  }

  /* ---------------- بطاقات التشغيل على الشاشة ---------------- */
  function renderCards() {
    const host = document.getElementById('rptCards');
    if (!host) return;
    host.innerHTML = '';
    (state.catalogue || []).forEach((r) => {
      const iconId = REPORT_ICONS[r.key] || 'i-chart';
      const b = el('button', 'rpt-card ' + SamUI.toneOf(iconId));
      b.type = 'button';
      b.dataset.report = r.key;
      b.innerHTML = `${SamUI.plate('rc-ic', iconId, null, 'lg')}
        <span class="rc-t"><b>${esc(r.title)}</b><i>${esc(r.hint || '')}</i></span>
        <span class="rc-go">${SamUI.iconTile('i-eye', 'tone-info', 'xs')}<span class="btn-txt">فتح</span></span>`;
      b.addEventListener('click', () => openWindow(r.key));
      host.appendChild(b);
    });
  }

  function railItems() {
    return (state.catalogue || []).map((r) => ({
      key: r.key,
      title: r.title,
      hint: r.hint,
      icon: REPORT_ICONS[r.key] || 'i-chart'
    }));
  }

  /* ---------------- النافذة ---------------- */
  function rerun(key) {
    if (!state.win) return;
    const k = key || state.win.activeKey || state.report;
    state.win.pick(k);
  }

  function openWindow(reportKey) {
    const key = reportKey || state.report || 'movements';
    const gen = ++winGen;
    /* a fresh window means fresh nodes — the old combo instances point at
       elements that no longer exist, so they are dropped */
    combos = null;
    filterHost = buildFilterHost();
    state.win = SamReportWindow.open({
      title: 'مركز التقارير',
      subtitle: 'اختر التقرير من القائمة، وحدّد الفترة، ثم عاين أو صدّر أو اطبع',
      icon: 'i-chart',
      reports: railItems(),
      active: key,
      onPick: (k) => runReport(k),
      render: () => {
        const wrap = el('div', 'rw-stack');
        wrap.appendChild(filterHost);
        initCombos();
        /* the columns row belongs to the detailed movement report only, so it
           is re-evaluated on every repaint — the rail can switch reports */
        renderColumns();
        wrap.appendChild(previewNode());
        return wrap;
      },
      actions: (api) => [
        { label: 'تصدير Excel', icon: 'i-archive', kind: 'btn-ghost', onClick: () => exportExcel() },
        { label: 'طباعة / معاينة', icon: 'i-print', kind: 'btn-ghost', onClick: () => printReport() },
        { label: 'تصدير PDF', icon: 'i-clipboard', kind: 'btn-primary', onClick: () => exportPdf() },
        { label: 'إغلاق', icon: 'i-x', kind: 'btn-ghost', onClick: () => api.close() }
      ],
      onClose: () => {
        /* a window that was replaced by a newer one must not clean up the
           newer window's state */
        if (gen !== winGen) return;
        state.win = null;
        filterHost = null;
        refs = null;
        combos = null;
      }
    });
    return state.win;
  }

  /* ---------------- التشغيل العام ---------------- */
  async function run() {
    await ensureCatalogue();
    if (!ref.loaded) await loadRef();
    /* the window is already open — re-run the current report inside it */
    if (state.win) {
      rerun(state.win.activeKey || state.report);
      return state.win;
    }
    return openWindow(state.report);
  }

  async function load() {
    await ensureCatalogue();
    if (!ref.loaded) await loadRef();
    if (!filters.dateFrom && !filters.dateTo) {
      state.period = 'd30';
      const [from, to] = periodRange('d30');
      filters.dateFrom = from;
      filters.dateTo = to;
    }
    renderCards();
  }

  /* ---------------- الربط ---------------- */
  const btnOpen = document.getElementById('btnOpenReports');
  if (btnOpen) btnOpen.addEventListener('click', () => run());

  SamUI.pushKeys({ refresh: () => run(), new: () => run() });

  window.SamReports = {
    load,
    run,
    openWindow,
    printReport,
    exportExcel,
    exportPdf,
    refreshComboData: loadRef,
    columns: COLUMNS,
    buckets: BUCKETS,
    options: OPTIONS,
    state,
    filters,
    /* the sheet and the workbook of the report — the checks read them */
    sheetSpec: () => (state.result ? sheetOpts() : null),
    excelSpec: () => excelSpec(),
    setPacks
  };

  /* the switch is shared with the daily report — whoever turns it off,
     every surface follows (and the choice is remembered) */
  window.addEventListener('sam-packs-change', (e) => {
    const on = !!(e && e.detail && e.detail.on);
    if (on === state.packs) return;
    state.packs = on;
    if (refs && refs.fPacks) refs.fPacks.checked = state.packs;
    if (state.win) state.win.pick(state.win.activeKey || state.report);
  });

  SamUI.bus.on(async () => {
    if (!window.SamReports) return;
    const v = document.getElementById('v-reports');
    if (v && !v.classList.contains('active') && !state.win) return;
    ref.loaded = false;
    await loadRef();
    if (state.win) rerun();
  });
})();
