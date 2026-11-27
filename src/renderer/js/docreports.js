'use strict';

/* =====================================================================
   تقارير المستندات — V9
   The screen that replaces the old catalogue of fourteen reports.

   One engine for document kinds and advanced reports, with «الكل» as a
   visible choice in every filter, the number HE wrote on the paper, and a
   total for every unit separately — 20,000 ريال beside 20,000 أمبول beside
   20,000 كرتون, never mixed.

   The screen, the paper and Excel are painted from ONE row list, so they
   can never disagree about a number.
   ===================================================================== */
(function () {
  const { el, esc, toast, combo, printPreview, emptyState, toggleEmpty, iconTile } = SamUI;

  const STORE = 'sam.docreports.v1';
  const CURRENCY = SamUI.CURRENCY || 'ريال يمني';

  /* document colours and icons; advanced reports use their own meaning */
  const KIND_META = {
    sale: { icon: 'i-cart', tone: 'tone-sell' },
    purchase: { icon: 'i-truck', tone: 'tone-buy' },
    prod_receipt: { icon: 'i-inbox', tone: 'tone-produce' },
    prod_issue: { icon: 'i-issue', tone: 'tone-issue' },
    sale_return: { icon: 'i-return', tone: 'tone-sreturn' },
    purchase_return: { icon: 'i-return', tone: 'tone-buy' },
    tolling_in: { icon: 'i-tolling', tone: 'tone-pretn' },
    customer_raw: { icon: 'i-tolling', tone: 'tone-pretn' },
    warehouse_flow: { icon: 'i-swap', tone: 'tone-move' },
    category: { icon: 'i-chart', tone: 'tone-info' },
    customer_statement: { icon: 'i-user', tone: 'tone-sell' },
    supplier_statement: { icon: 'i-truck', tone: 'tone-buy' },
    item_report: { icon: 'i-box', tone: 'tone-produce' }
  };

  const PERIODS = [
    { key: 'today', label: 'اليوم' },
    { key: 'd7', label: 'آخر ٧ أيام' },
    { key: 'd30', label: 'آخر ٣٠ يوم' },
    { key: 'month', label: 'هذا الشهر' },
    { key: 'all', label: 'كل الفترات' }
  ];

  const BUCKETS = [
    { key: 'good', label: 'سليم' },
    { key: 'defect', label: 'تالف' }
  ];

  const state = {
    kinds: [],
    kind: 'sale',
    mode: 'detail',
    from: SamUI.today(),
    to: SamUI.today(),
    /* V9 — every filter holds SEVERAL choices; an empty array means «الكل».
       The report opens on «كل الفترات»: opening on «اليوم» showed an EMPTY
       table whenever the last invoice was yesterday, and the customer read
       that as «the value and the notes do not show». */
    partyId: [],
    itemId: [],
    category: [],
    warehouseId: [],
    buckets: ['good'],
    docIds: [],
    batchIds: [],
    back: [],
    paper: 'a4',
    orient: 'portrait',
    cols: {},          // per «kind|mode» → { columnKey: bool }
    modes: {},         // per kind → 'detail' | 'summary'
    res: null,
    ran: false,
    period: 'all'
  };

  const ref = { items: [], byId: {}, parties: [], warehouses: [], categories: [] };
  const pic = { dir: '' };
  let combos = null;
  let refs = null;
  let wired = false;

  /* ---------------- what the customer chose, remembered ---------------- */
  function readStore() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(STORE) || '{}');
      if (raw && typeof raw === 'object') {
        if (raw.kind) state.kind = raw.kind;
        if (raw.paper) state.paper = raw.paper;
        if (raw.orient) state.orient = raw.orient;
        if (Array.isArray(raw.buckets)) state.buckets = raw.buckets;
        if (raw.cols && typeof raw.cols === 'object') state.cols = raw.cols;
        if (raw.modes && typeof raw.modes === 'object') state.modes = raw.modes;
      }
    } catch (e) { /* a blocked storage never breaks the report */ }
    state.mode = defaultMode(state.kind);
  }
  function writeStore() {
    try {
      window.localStorage.setItem(STORE, JSON.stringify({
        kind: state.kind, paper: state.paper, orient: state.orient,
        buckets: state.buckets, cols: state.cols, modes: state.modes
      }));
    } catch (e) { /* ignore */ }
  }
  const colKey = () => `${state.kind}|${state.mode}`;
  const isCustomerRaw = () => state.kind === 'customer_raw';
  const isAdvanced = () => ['category', 'customer_statement', 'supplier_statement', 'item_report'].includes(state.kind);
  const isStatement = () => state.kind === 'customer_statement' || state.kind === 'supplier_statement';
  const isItemReport = () => state.kind === 'item_report';
  const defaultMode = (kind) => {
    if (kind === 'customer_raw' || kind === 'category' || isStatementKind(kind)) return 'detail';
    if (kind === 'item_report') return state.modes[kind] || 'summary';
    return state.modes[kind] || 'detail';
  };
  const isStatementKind = (kind) => kind === 'customer_statement' || kind === 'supplier_statement';

  /* The tracking report has no document shape, bucket or warehouse filter:
     every visible control must answer a real question, so the irrelevant
     controls are hidden rather than left as decorations. */
  function paintSpecial() {
    if (!refs) return;
    const raw = isCustomerRaw();
    const fixedShape = raw || state.kind === 'category' || isStatement();
    const modeSection = document.getElementById('drModeSection');
    const bucketSection = document.getElementById('drBucketsSection');
    const whField = document.getElementById('drWhField');
    const docField = document.getElementById('drDocField');
    const batchField = document.getElementById('drBatchField');
    const back = document.getElementById('btnDocBack');
    if (modeSection) modeSection.style.display = fixedShape ? 'none' : '';
    if (bucketSection) bucketSection.style.display = raw ? 'none' : '';
    if (whField) whField.style.display = raw ? 'none' : '';
    if (docField) docField.style.display = state.docIds.length ? '' : 'none';
    if (batchField) batchField.style.display = state.batchIds.length ? '' : 'none';
    if (back) back.style.display = state.back.length ? '' : 'none';
    const detailMode = refs.mode.querySelector('[data-mode="detail"]');
    const summaryMode = refs.mode.querySelector('[data-mode="summary"]');
    if (detailMode) detailMode.textContent = isItemReport() ? 'تفصيلي — كل حركة' : 'تفصيلي — سطر لكل صنف';
    if (summaryMode) summaryMode.textContent = isItemReport() ? 'ملخّص — صنف ومخزن' : 'ملخّص — سطر لكل مستند';
    const explain = document.getElementById('drExplain');
    if (explain) {
      if (raw) explain.textContent = 'متابعة خام العميل تقرير تراكمي: المصروف للإنتاج − التام السليم = ما زال في الإنتاج، والخام غير المصروف + (التام السليم − المسلّم للعميل) = باقٍ في المخازن. الأمبول يساوي العلبة 1:1، والوحدات الأخرى لا تُخلط. الرصيد محسوب حتى نهاية الفترة المختارة.';
      else if (state.kind === 'category') explain.textContent = 'تقرير الفئات يجمع الوارد والصادر والصافي لكل فئة ووحدة. قيمة الفاتورة تظهر مرة واحدة للمستند على أول سطر داخل التقرير، ولا تتكرر بين الفئات. انقر على فئة أو صنف أو رقم مستند لفتح تقريره.';
      else if (isStatement()) explain.textContent = 'كشف الحساب يعرض مستندات الطرف بترتيب التاريخ مع الرصيد الافتتاحي المحسوب من مستندات ما قبل الفترة. المبيعات تزيد حساب العميل والمرتجع يخفضه؛ المشتريات تزيد حساب المورد ومرتجعها يخفضه. لا توجد دفعات نقدية غير مسجلة في البرنامج.';
      else if (isItemReport()) explain.textContent = 'تقرير الصنف يعرض الافتتاحي والوارد والصادر والمتبقي لكل صنف ومخزن. الافتتاحي يشمل رصيد البداية وكل الحركات السابقة للفترة، والتفصيلي يعرض الرصيد الجاري بعد كل حركة. الوحدات لا تُجمع معاً.';
      else explain.textContent = '«تفصيلي» يعرض كل صنف داخل كل مستند مع قيمة الفاتورة مرة واحدة للمستند، و«ملخّص» يعرض كل مستند على سطر. الرقم المعروض هو رقمك الخارجي؛ وإن لم يكن للمستند رقم خارجي يظهر رقمه الداخلي ومعه علامة «داخلي». انقر على العميل أو الصنف أو رقم المستند لفتح تقريره.';
    }
  }

  /* ---------------- the picture beside the name ---------------- */
  async function ensurePicDir() {
    if (pic.dir) return pic.dir;
    try {
      const P = window.SamItemPic;
      if (P && typeof P.ensure === 'function') { const d = await P.ensure(); if (d) { pic.dir = d; return d; } }
    } catch (e) { /* the shared helper is only a shortcut */ }
    try {
      const r = await sam.app.imagesDir();
      pic.dir = (r && r.ok && r.dir) ? r.dir : '';
    } catch (e) { pic.dir = ''; }
    return pic.dir;
  }
  function pictureUrl(item) {
    if (!item || !String(item.image || '').trim()) return '';
    try {
      if (window.SamItems && typeof window.SamItems.pictureUrl === 'function') {
        const u = window.SamItems.pictureUrl(item);
        if (u) return u;
      }
    } catch (e) { /* shortcut only */ }
    if (!pic.dir) return '';
    try { return sam.app.fileUrl(pic.dir + '/' + String(item.image).trim()); } catch (e) { return ''; }
  }
  function thumbHtml(item, size, print) {
    try {
      const P = window.SamItemPic;
      if (P && typeof P.thumbHtml === 'function' && P.has(item)) {
        const html = P.thumbHtml(item, size, print);
        if (html) return html;
      }
    } catch (e) { /* shortcut only */ }
    const url = pictureUrl(item);
    if (!url) return '';
    const px = Number(size) || 14;
    const frame = print ? 'border:1px solid #cfd6e0;' : 'border:1px solid var(--line);box-shadow:0 1px 3px rgba(15,23,42,.14);';
    return `<img class="sam-pic" src="${esc(url)}" alt="" style="width:${px}px;height:${px}px;object-fit:contain;border-radius:6px;${frame}background:#f1f5f9;flex:none;vertical-align:middle;">`;
  }
  /** the item cell: picture BESIDE a dark bold name — no empty box without a picture */
  function itemCell(row, size, print) {
    const it = ref.byId[row.itemId];
    const p = it ? thumbHtml(it, size, print) : '';
    const ink = print ? '#101828' : 'var(--ink)';
    return `<span class="sam-item" style="display:inline-flex;align-items:center;gap:6px">${p}`
      + `<span class="sam-item-name" style="font-weight:800;color:${ink}">${esc(row.itemName || '')}</span></span>`;
  }

  /* ---------------- the reference lists ---------------- */
  async function loadRef() {
    try {
      const items = await SamDB.call('listItems', '');
      ref.items = items || [];
      ref.byId = {};
      ref.items.forEach((i) => { ref.byId[i.id] = i; });
      const cats = new Set();
      ref.items.forEach((i) => { const c = String(i.category || '').trim(); if (c) cats.add(c); });
      ref.categories = [...cats].sort((a, b) => a.localeCompare(b, 'ar'));
    } catch (e) { if (!(e && e.denied)) toast(e.message || String(e), 'bad'); }
    /* listParties takes a SEARCH STRING, not an object: passing {} became
       '[object Object]' and the filter came back EMPTY without a word. */
    try { ref.parties = (await SamDB.call('listParties', '')) || []; }
    catch (e) { ref.parties = []; if (!(e && e.denied)) toast('تعذّر تحميل قائمة العملاء والموردين: ' + (e.message || e), 'bad', 5200); }
    try { ref.warehouses = (await SamDB.call('listWarehouses')) || []; }
    catch (e) { ref.warehouses = []; if (!(e && e.denied)) toast('تعذّر تحميل قائمة المخازن: ' + (e.message || e), 'bad', 5200); }
    try { state.kinds = (await SamDB.call('DOC_REPORT_KINDS')) || []; } catch (e) { state.kinds = []; }
    await ensurePicDir();
  }

  /* ---------------- the filters ---------------- */
  function filters() {
    return {
      kind: state.kind,
      mode: state.mode,
      dateFrom: state.period === 'all' ? '' : state.from,
      dateTo: state.period === 'all' ? '' : state.to,
      partyId: state.partyId || [],
      itemId: state.itemId || [],
      category: state.category || [],
      warehouseId: state.warehouseId || [],
      buckets: state.buckets.slice(),
      docIds: state.docIds.slice(),
      batchIds: state.batchIds.slice()
    };
  }

  function applyPeriod(key) {
    state.period = key;
    const t = SamUI.today();
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    if (key === 'today') { state.from = t; state.to = t; }
    else if (key === 'd7') { d.setDate(d.getDate() - 6); state.from = iso(d); state.to = t; }
    else if (key === 'd30') { d.setDate(d.getDate() - 29); state.from = iso(d); state.to = t; }
    else if (key === 'month') { state.from = `${t.slice(0, 7)}-01`; state.to = t; }
    else { state.from = ''; state.to = ''; }
    if (refs) { refs.from.value = state.from; refs.to.value = state.to; }
    paintPeriods();
  }

  function paintPeriods() {
    if (!refs) return;
    refs.periods.innerHTML = '';
    PERIODS.forEach((p) => {
      const b = el('button', `dr-chip ${state.period === p.key ? 'on' : ''}`, esc(p.label));
      b.type = 'button';
      b.addEventListener('click', () => { applyPeriod(p.key); run(); });
      refs.periods.appendChild(b);
    });
  }

  function selectKind(kind) {
    state.kind = kind;
    state.mode = defaultMode(kind);
    state.docIds = [];
    state.batchIds = [];
    state.back = [];
    writeStore();
    paintSpecial(); paintKinds(); paintMode(); fillCombos(); run();
  }

  function paintKinds() {
    if (!refs) return;
    refs.kinds.innerHTML = '';
    state.kinds.forEach((k) => {
      const m = KIND_META[k.key] || { icon: 'i-clipboard', tone: 'tone-plain' };
      const b = el('button', `dr-kind ${m.tone} ${state.kind === k.key ? 'on' : ''}`);
      b.type = 'button';
      b.dataset.kind = k.key;
      b.title = k.hint || '';
      b.innerHTML = `${iconTile(m.icon, m.tone, 'sm')}<span class="dr-kind-txt"><b>${esc(k.title)}</b><small>${esc(k.hint || '')}</small></span>`;
      b.addEventListener('click', () => selectKind(k.key));
      refs.kinds.appendChild(b);
    });
  }

  function paintMode() {
    if (!refs) return;
    [...refs.mode.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    refs.modeBadge.textContent = state.mode === 'summary' ? 'ملخّص' : 'تفصيلي';
  }

  function paintPaper() {
    if (!refs) return;
    [...refs.paper.querySelectorAll('button')].forEach((b) => {
      if (b.dataset.paper) b.classList.toggle('on', b.dataset.paper === state.paper);
      if (b.dataset.orient) b.classList.toggle('on', b.dataset.orient === state.orient);
    });
  }

  function paintBuckets() {
    if (!refs) return;
    refs.buckets.innerHTML = '';
    BUCKETS.forEach((b) => {
      const lab = el('label', 'col-check');
      const on = state.buckets.includes(b.key);
      lab.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span>${esc(b.label)}</span>`;
      lab.querySelector('input').addEventListener('change', (e) => {
        const set = new Set(state.buckets);
        if (e.target.checked) set.add(b.key); else set.delete(b.key);
        state.buckets = [...set];
        if (!state.buckets.length) { state.buckets = ['good']; paintBuckets(); }
        writeStore(); run();
      });
      refs.buckets.appendChild(lab);
    });
  }

  function initCombos() {
    if (combos || !refs) return;
    const ALL = 'الكل';
    /* multi: the customer asked to pick MORE THAN ONE choice in one filter */
    combos = {
      party: combo(refs.party, { placeholder: 'الكل…', allLabel: ALL, multi: true, emptyText: 'لا توجد أطراف' }),
      item: combo(refs.item, { placeholder: 'الكل…', allLabel: ALL, multi: true, emptyText: 'لا توجد أصناف' }),
      category: combo(refs.category, { placeholder: 'الكل…', allLabel: ALL, multi: true, emptyText: 'لا توجد فئات' }),
      wh: combo(refs.wh, { placeholder: 'الكل…', allLabel: ALL, multi: true, emptyText: 'لا توجد مخازن' })
    };
    combos.party.opts.onChange = (v) => { state.partyId = v; run(); };
    combos.item.opts.onChange = (v) => { state.itemId = v; run(); };
    combos.category.opts.onChange = (v) => { state.category = v; run(); };
    combos.wh.opts.onChange = (v) => { state.warehouseId = v; run(); };
    fillCombos();
  }

  function fillCombos() {
    if (!combos) return;
    combos.party.setItems(ref.parties.map((p) => ({ id: p.id, label: p.name, code: p.phone || '' })));
    combos.item.setItems(ref.items.map((i) => ({ id: i.id, label: i.name, code: i.code, sub: i.base_unit })));
    combos.category.setItems(ref.categories.map((c) => ({ id: c, label: c })));
    combos.wh.setItems(ref.warehouses.map((w) => ({ id: w.id, label: w.name, code: w.code })));
    combos.party.setValue(state.partyId, false);
    combos.item.setValue(state.itemId, false);
    combos.category.setValue(state.category, false);
    combos.wh.setValue(state.warehouseId, false);
  }

  /* ---------------- the columns ---------------- */
  function activeColumns() {
    const res = state.res;
    if (!res) return [];
    const saved = state.cols[colKey()];
    const on = res.columns.filter((c) => (saved ? saved[c.key] !== false : true));
    /* a report with no columns is not a report — keep the first one */
    return on.length ? on : res.columns.slice(0, 1);
  }

  function paintCols() {
    if (!refs || !state.res) return;
    const saved = state.cols[colKey()] || {};
    refs.cols.innerHTML = '';
    state.res.columns.forEach((c) => {
      const on = saved[c.key] !== undefined ? saved[c.key] !== false : true;
      const lab = el('label', 'col-check');
      lab.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span>${esc(c.label)}</span>`;
      lab.querySelector('input').addEventListener('change', (e) => {
        const cur = Object.assign({}, state.cols[colKey()]);
        state.res.columns.forEach((x) => { if (cur[x.key] === undefined) cur[x.key] = true; });
        /* the last visible column is never taken away silently */
        if (!e.target.checked && Object.values(cur).filter(Boolean).length <= 1) {
          e.target.checked = true;
          toast('أبقِ عموداً واحداً على الأقل — لا يمكن إخفاء كل الأعمدة', 'warn', 4200);
          return;
        }
        cur[c.key] = e.target.checked;
        state.cols[colKey()] = cur;
        writeStore(); paint();
      });
      refs.cols.appendChild(lab);
    });
  }

  function setAllCols(on) {
    if (!state.res) return;
    if (!on) {
      toast('أبقِ عموداً واحداً على الأقل — لا يمكن إخفاء كل الأعمدة', 'warn', 4200);
      return;
    }
    const cur = {};
    state.res.columns.forEach((c) => { cur[c.key] = true; });
    state.cols[colKey()] = cur;
    writeStore(); paintCols(); paint();
  }

  /* =====================================================================
     THE PAPER BUDGET — the preview must be the paper.
     A portrait A4 is 210mm wide; with 5mm margins only 200mm are left.
     Columns are kept in order until the budget runs out, and whatever does
     not fit is NAMED in an Arabic line instead of being squeezed into an
     overlap the customer cannot read.
     ===================================================================== */
  const COL_MM = {
    externalNo: 20, docDate: 20, moveDate: 20, docKindAr: 22, docTypeAr: 22, partyName: 28, warehouseName: 22,
    category: 22, unit: 12, documents: 16, lines: 14,
    itemName: 34, baseUnit: 12, bucketAr: 12, itemCount: 14, moves: 14, pieces: 16,
    inQty: 15, outQty: 15, delta: 15, net: 15, opening: 16, balance: 18, signedValue: 20, value: 20,
    cartons: 14, bags: 14, invoiceValue: 22, note: 26,
    batchNo: 18, unitLabel: 25, received: 18, issued: 18, producedGood: 18,
    delivered: 20, inWarehouse: 21, inProduction: 21, rawInWarehouse: 17,
    finishedInWarehouse: 17, producedDefect: 17, returned: 17
  };
  function paperWidthMM() {
    const w = state.paper === 'a5' ? 148 : 210;
    const h = state.paper === 'a5' ? 210 : 297;
    return (state.orient === 'landscape' ? h : w) - 10;
  }
  /* V9 — what the paper keeps when it cannot keep everything.
     The customer asked for the invoice value in so many words, so it is
     never the column that gets dropped: the money, the number of the
     document, the item and the quantity come first. A column that carries
     nothing but zeros is not worth paper at all and gives its room away. */
  /* the note is information the customer typed himself, so it outranks the
     derived pack columns — those are often zero and give their room away */
  const PAPER_PRIORITY = ['externalNo', 'docDate', 'moveDate', 'category', 'itemName', 'pieces', 'invoiceValue',
    'value', 'signedValue', 'balance', 'opening', 'note', 'docKindAr', 'docTypeAr', 'inQty', 'outQty', 'delta', 'net', 'baseUnit', 'partyName',
    'cartons', 'bags', 'bucketAr', 'warehouseName', 'itemCount', 'moves'];
  /* On a narrow sheet the customer's three answers must survive even when
     the explanatory columns do not: delivered, in warehouses, in production. */
  const RAW_PAPER_PRIORITY = ['batchNo', 'unitLabel', 'delivered', 'inWarehouse', 'inProduction',
    'received', 'issued', 'producedGood', 'itemName', 'partyName', 'docDate',
    'rawInWarehouse', 'finishedInWarehouse', 'producedDefect', 'returned', 'warehouseName', 'note'];
  /* A5 portrait is only 138mm inside the 5mm margins. The six batch
     quantities and their identity still fit when the columns are compact;
     none of the customer's answers is sacrificed to explanatory columns. */
  const RAW_A5_MM = {
    batchNo: 14, itemName: 20, unitLabel: 18, received: 13, issued: 13,
    producedGood: 13, delivered: 14, inWarehouse: 14, inProduction: 14,
    partyName: 20, docDate: 16, rawInWarehouse: 14, finishedInWarehouse: 14,
    producedDefect: 14, returned: 14, warehouseName: 18, note: 20
  };
  const narrowRaw = () => isCustomerRaw() && state.paper === 'a5' && state.orient !== 'landscape';
  const paperColMM = (c) => (narrowRaw() && RAW_A5_MM[c.key]) || COL_MM[c.key] || 24;
  const prio = (c) => {
    const i = (isCustomerRaw() ? RAW_PAPER_PRIORITY : PAPER_PRIORITY).indexOf(c.key);
    return i < 0 ? 99 : i;
  };

  function paperColumns() {
    const act = activeColumns();
    const rows = (state.res && state.res.rows) || [];
    const useful = act.filter((c) => {
      if (['cartons', 'bags', 'unitCount'].indexOf(c.key) < 0) return true;
      return rows.some((r) => SamDB.n(r[c.key]) !== 0);
    });
    const budget = paperWidthMM();
    const kept = new Set();
    let used = 0;
    useful.slice().sort((a, b) => prio(a) - prio(b)).forEach((c) => {
      const mm = paperColMM(c);
      if (used + mm <= budget) { kept.add(c.key); used += mm; }
    });
    const keep = useful.filter((c) => kept.has(c.key));
    if (!keep.length && act.length) { keep.push(act[0]); kept.add(act[0].key); }
    return { keep, hidden: act.filter((c) => !kept.has(c.key)) };
  }

  /* ---------------- one cell, one truth ---------------- */
  /* =====================================================================
     V9 — colour that MEANS something, on the screen AND on the paper.
     One source of colour (the same variables the document chips use), so
     what he sees in the preview is exactly what the printer delivers.
     ===================================================================== */
  const KIND_COLOR = {
    sale: 'var(--c-sell)', purchase: 'var(--c-buy)', sale_return: 'var(--c-sreturn)',
    purchase_return: 'var(--c-buy)', transfer: 'var(--c-move)', prod_receipt: 'var(--c-produce)',
    prod_issue: 'var(--c-issue)', gate_in: 'var(--c-gin)', gate_out: 'var(--c-gout)',
    adjustment: 'var(--c-adjust)', tolling_in: 'var(--c-pretn)', warehouse_flow: 'var(--c-move)',
    opening: 'var(--c-plain)', issue: 'var(--c-issue)', receipt: 'var(--c-produce)',
    bags: 'var(--c-move)', tolling_out: 'var(--c-pretn)', scrap: 'var(--c-warn)'
  };
  /* every number wears the colour of its own meaning: what came in is not
     what went out, and a carton is not a bag */
  const NUM_COLOR = {
    inQty: 'var(--c-ok)', outQty: 'var(--c-pretn)', pieces: 'var(--c-buy)',
    cartons: 'var(--c-sell)', bags: 'var(--c-gin)',
    itemCount: 'var(--c-plain)', moves: 'var(--c-plain)', documents: 'var(--c-plain)', lines: 'var(--c-plain)',
    opening: 'var(--c-plain)', balance: 'var(--c-ok)', signedValue: 'var(--c-ok)', value: 'var(--c-ok)',
    received: 'var(--c-ok)', issued: 'var(--c-issue)', producedGood: 'var(--c-produce)',
    delivered: 'var(--c-sell)', rawInWarehouse: 'var(--c-ok)',
    finishedInWarehouse: 'var(--c-ok)', producedDefect: 'var(--c-warn)', returned: 'var(--c-pretn)'
  };

  function cellHtml(row, c, print) {
    const v = row[c.key];
    if ((c.num || c.money) && v == null) {
      const why = row.unitCompatible === false ? 'الوحدة الخام والتام غير متطابقة — لا يوجد رصيد مجموع مؤكد' : 'لا توجد قيمة';
      return `<span title="${esc(why)}" style="opacity:.55;font-weight:800">—</span>`;
    }
    if (c.pic) return itemCell(row, print ? 17 : 14, print);
    if (c.key === 'batchNo') {
      return `<b style="color:${print ? '#6941c6' : 'var(--c-pretn)'};font-weight:800">${esc(String(v == null ? '—' : v))}</b>`;
    }
    if (c.key === 'unitLabel') {
      return `<b style="color:${print ? '#344054' : 'var(--label-fg)'};font-size:.94em">${esc(String(v == null ? '—' : v))}</b>`;
    }
    if (c.key === 'externalNo') {
      const mark = row.hasExternal === false
        ? ` <small style="color:${print ? '#667085' : '#94a3b8'};font-weight:700">داخلي</small>` : '';
      return `<b style="color:${print ? '#101828' : 'var(--ink)'}">${esc(String(v == null ? '—' : v))}</b>${mark}`;
    }
    if (c.key === 'docKindAr' || c.key === 'docTypeAr') {
      const key = row.docKind || row.docType || '';
      return `<b style="color:${KIND_COLOR[key] || 'var(--c-plain)'};font-weight:800">${esc(String(v == null ? '' : v))}</b>`;
    }
    if (c.money) return v == null ? '<span style="opacity:.45">—</span>' : `<b style="color:var(--c-ok)">${SamDB.fmt(SamDB.n(v))}</b>`;
    if (c.signed) {
      const n = SamDB.n(v);
      const col = n > 0 ? 'var(--c-ok)' : n < 0 ? 'var(--c-pretn)' : 'var(--c-plain)';
      return `<b style="color:${col}">${n > 0 ? '+' : ''}${SamDB.fmt(n)}</b>`;
    }
    if (c.num) return `<span class="num" style="font-weight:800;color:${NUM_COLOR[c.key] || 'var(--ink)'}">${SamDB.fmt(SamDB.n(v))}</span>`;
    if (c.key === 'bucketAr') return `<span class="chip ${row.bucket === 'defect' ? 'bad' : 'ok'}">${esc(String(v || ''))}</span>`;
    /* V9 — a long note must NOT blow up the row. Small writing, short lines,
       a capped box: two lines on the screen (the whole note is one hover
       away, and a double-click opens the document itself), and on the paper
       the same small hand with the full text wrapped inside a fixed column. */
    if (c.key === 'note') {
      const txt = String(v == null ? '' : v);
      if (!txt) return '<span style="opacity:.4">—</span>';
      if (print) {
        return `<span class="note-cell" style="display:block;font-size:8.5pt;line-height:1.3;font-weight:600;color:#33415a;`
          + 'white-space:normal;word-break:break-word;overflow-wrap:anywhere;text-align:center">' + esc(txt) + '</span>';
      }
      return `<span class="note-cell" title="${esc(txt)}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;`
        + 'overflow:hidden;font-size:11px;line-height:1.3;font-weight:600;color:var(--label-fg);white-space:normal;'
        + 'word-break:break-word;max-width:188px;text-align:center">' + esc(txt) + '</span>';
    }
    return esc(String(v == null || v === '' ? '—' : v));
  }

  /* ---------------- click a number to open its report ---------------- */
  function drillFor(row, col) {
    if (!row) return null;
    if (col.key === 'partyName' && row.partyId) {
      const supplier = row.partyType === 'supplier' || state.kind === 'supplier_statement'
        || row.docKind === 'purchase' || row.docKind === 'purchase_return';
      return { type: 'party', id: row.partyId, kind: supplier ? 'supplier_statement' : 'customer_statement' };
    }
    if (col.key === 'category' && row.category) return { type: 'category', id: row.category, kind: 'category' };
    if ((col.key === 'itemName' || col.key === 'itemCode') && row.itemId) return { type: 'item', id: row.itemId, kind: 'item_report' };
    if ((col.key === 'externalNo' || col.key === 'docNo') && row.docId) {
      const docKind = row.docKind || row.docType || '';
      const kind = state.kinds.some((k) => k.key === docKind) ? docKind : 'sale';
      return { type: 'doc', id: row.docId, kind };
    }
    return null;
  }

  function reportSnapshot() {
    return {
      kind: state.kind, mode: state.mode,
      partyId: state.partyId.slice(), itemId: state.itemId.slice(), category: state.category.slice(),
      warehouseId: state.warehouseId.slice(), buckets: state.buckets.slice(), docIds: state.docIds.slice(),
      batchIds: state.batchIds.slice(), period: state.period, from: state.from, to: state.to
    };
  }

  function openDrill(drill) {
    if (!drill || drill.id == null || drill.id === '') return;
    state.back.push(reportSnapshot());
    state.kind = drill.kind;
    state.mode = defaultMode(drill.kind);
    state.partyId = []; state.itemId = []; state.category = []; state.docIds = []; state.batchIds = [];
    if (drill.type === 'party') state.partyId = [drill.id];
    else if (drill.type === 'category') state.category = [drill.id];
    else if (drill.type === 'item') { state.itemId = [drill.id]; state.mode = 'summary'; }
    else if (drill.type === 'doc') state.docIds = [drill.id];
    paintSpecial(); paintKinds(); paintMode(); fillCombos(); run();
  }

  function goBack() {
    const prev = state.back.pop();
    if (!prev) return;
    state.kind = prev.kind; state.mode = prev.mode;
    state.partyId = prev.partyId; state.itemId = prev.itemId; state.category = prev.category;
    state.warehouseId = prev.warehouseId; state.buckets = prev.buckets; state.docIds = prev.docIds;
    state.batchIds = prev.batchIds || [];
    state.period = prev.period; state.from = prev.from; state.to = prev.to;
    if (refs) { refs.from.value = state.from; refs.to.value = state.to; }
    writeStore(); paintSpecial(); paintKinds(); paintMode(); paintPeriods(); fillCombos(); run();
  }

  /* ---------------- the totals: every thing in its own unit ---------------- */
  function advancedTotalsHtml(t) {
    const card = (label, value, unit, cls) => `<div class="dr-tot ${cls || ''}">`
      + `<span class="lbl">${esc(label)}</span><b>${SamDB.fmt(SamDB.n(value))}</b><span class="unit">${esc(unit)}</span></div>`;
    let html = '';
    if (state.kind === 'category') {
      html = card('قيمة الفواتير', t.value, CURRENCY, 'money')
        + card('عدد المستندات', t.documents, 'مستند', 'docs')
        + card('صفوف الفئات', t.rows, 'فئة / وحدة', 'lines');
    } else if (isStatement()) {
      const debitLabel = state.kind === 'supplier_statement' ? 'مشتريات / له' : 'مبيعات / عليه';
      html = card('الرصيد الافتتاحي', t.opening, CURRENCY, 'docs')
        + card(debitLabel, t.debit, CURRENCY, 'money')
        + card('مرتجع / خصم', t.credit, CURRENCY, 'lines')
        + card('الرصيد الختامي', t.balance, CURRENCY, 'money')
        + card('عدد المستندات', t.documents, 'مستند', 'docs');
    } else if (isItemReport()) {
      html = card('عدد الصفوف', t.rows, state.mode === 'summary' ? 'صنف / مخزن' : 'حركة', 'docs')
        + card('عدد الحركات', t.moves, 'حركة', 'lines');
    }
    (t.byUnit || []).forEach((u) => {
      if (state.kind === 'category') {
        html += `<div class="dr-tot unit"><span class="lbl">${esc(u.unit)}</span>`
          + `<b>${SamDB.fmt(SamDB.n(u.net))}</b><span class="unit">${esc(u.unit)} — صافي</span>`
          + `<small>وارد ${SamDB.fmt(u.inQty)} · صادر ${SamDB.fmt(u.outQty)}</small></div>`;
      } else if (isStatement()) {
        html += `<div class="dr-tot unit"><span class="lbl">${esc(u.unit)}</span>`
          + `<b>${SamDB.fmt(SamDB.n(u.net))}</b><span class="unit">${esc(u.unit)} — صافي</span>`
          + `<small>وارد ${SamDB.fmt(u.inQty)} · صادر ${SamDB.fmt(u.outQty)}</small></div>`;
      } else if (isItemReport()) {
        html += `<div class="dr-tot unit"><span class="lbl">${esc(u.unit)}</span>`
          + `<b>${SamDB.fmt(SamDB.n(u.balance))}</b><span class="unit">${esc(u.unit)} — متبقي</span>`
          + `<small>افتتاحي ${SamDB.fmt(u.opening)} · وارد ${SamDB.fmt(u.inQty)} · صادر ${SamDB.fmt(u.outQty)}</small></div>`;
      }
    });
    return html;
  }

  function totalsHtml() {
    const t = (state.res && state.res.totals) || null;
    if (!t) return '';
    const card = (label, value, unit, cls) => `<div class="dr-tot ${cls || ''}">`
      + `<span class="lbl">${esc(label)}</span><b>${SamDB.fmt(SamDB.n(value))}</b><span class="unit">${esc(unit)}</span></div>`;
    if (isAdvanced()) return advancedTotalsHtml(t);
    if (isCustomerRaw()) {
      let html = card('عدد الدفعات', t.batches, 'دفعة', 'docs');
      if (t.incompatibleBatches) {
        html += `<div class="dr-tot unit" style="border-color:var(--warn-line);background:var(--warn-bg)">`
          + `<span class="lbl">تنبيه الوحدات</span><b>${SamDB.fmt(t.incompatibleBatches)}</b>`
          + `<span class="unit">دفعات بوحدات مختلفة</span>`
          + '<small>لا تُجمع أرصدتها؛ تظهر كميات الخام والتام منفصلة، والرصيد المجموع بعلامة —.</small></div>';
      }
      (t.byUnit || []).forEach((u) => {
        html += `<div class="dr-tot unit"><span class="lbl">${esc(u.unit)}</span>`
          + `<small>مسلّم للعميل <b>${SamDB.fmt(u.delivered)}</b></small>`
          + `<small>باقٍ بالمخازن <b>${SamDB.fmt(u.inWarehouse)}</b></small>`
          + `<small>ما زال بالإنتاج <b>${SamDB.fmt(u.inProduction)}</b></small>`
          + `<span class="unit">مستلم ${SamDB.fmt(u.received)} · صرف ${SamDB.fmt(u.issued)} · تام ${SamDB.fmt(u.producedGood)}</span></div>`;
      });
      return html;
    }
    /* a flow report totals what entered and what left; a document report
       totals the money of the papers. Each in the unit of the thing. */
    const flow = t.inQty !== undefined;
    let html = flow
      ? card('إجمالي الوارد', t.inQty, 'كل الوحدات', 'docs')
        + card('إجمالي الصادر', t.outQty, 'كل الوحدات', 'lines')
        + card('الصافي', t.net, 'وارد − صادر', 'money')
      : card('قيمة الفواتير', t.value, CURRENCY, 'money');
    html += card(flow ? 'عدد الحركات' : 'عدد المستندات', flow ? t.moves : t.documents, flow ? 'حركة' : 'مستند', 'docs');
    html += card('عدد الأسطر', t.rows, 'سطر', 'lines');
    (t.byUnit || []).forEach((u) => {
      if (flow) {
        html += `<div class="dr-tot unit"><span class="lbl">${esc(u.unit)}</span>`
          + `<b>${SamDB.fmt(SamDB.n(u.net))}</b><span class="unit">${esc(u.unit)} — صافي</span>`
          + `<small>وارد ${SamDB.fmt(u.inQty)} · صادر ${SamDB.fmt(u.outQty)}</small></div>`;
        return;
      }
      const extra = [];
      if (u.cartons) extra.push(`${SamDB.fmt(u.cartons)} كرتون`);
      if (u.bags) extra.push(`${SamDB.fmt(u.bags)} كيس`);
      html += `<div class="dr-tot unit"><span class="lbl">${esc(u.unit)}</span>`
        + `<b>${SamDB.fmt(SamDB.n(u.pieces))}</b><span class="unit">${esc(u.unit)}</span>`
        + (extra.length ? `<small>${esc(extra.join(' · '))}</small>` : '') + '</div>';
    });
    return html;
  }

  /* ---------------- painting ---------------- */
  function paint() {
    const res = state.res;
    if (!res || !refs) return;
    const cols = activeColumns();
    refs.title.textContent = res.title;
    const countUnit = isCustomerRaw() ? 'دفعة'
      : state.kind === 'category' ? 'فئة / وحدة'
        : isItemReport() ? (state.mode === 'summary' ? 'صنف / مخزن' : 'حركة')
          : state.mode === 'summary' ? 'مستند' : 'سطر';
    refs.count.textContent = `${SamDB.fmt(res.rows.length)} ${countUnit}`;
    refs.totals.innerHTML = totalsHtml();

    const head = `<thead><tr>${cols.map((c) => `<th class="${c.pic ? 'pic' : ''} ${c.num || c.money ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
    const body = res.rows.map((r) => `<tr class="dr-row ${r.docFirst ? 'doc-first' : ''}" data-doc="${r.docId || ''}">`
      + cols.map((c) => {
        const d = drillFor(r, c);
        const attr = d ? ` data-drill="${d.type}" data-id="${esc(String(d.id))}" data-kind="${esc(d.kind)}" style="cursor:pointer"` : '';
        return `<td class="${c.num || c.money ? 'num' : ''}"${attr}>${cellHtml(r, c, false)}</td>`;
      }).join('') + '</tr>').join('');
    refs.tbl.innerHTML = head + `<tbody>${body}</tbody>`;
    toggleEmpty(refs.empty, refs.tbl, res.rows.length === 0);
    if (!res.rows.length) {
      if (isCustomerRaw()) emptyState(refs.empty, 'i-search', 'لا توجد دفعات خام عميل بهذه الخيارات', 'جرّب «كل الفترات» أو اختر «الكل» في الفلاتر.');
      else if (isAdvanced()) emptyState(refs.empty, 'i-search', 'لا توجد بيانات بهذه الخيارات', 'جرّب «كل الفترات» أو اختر «الكل» في الفلاتر.');
      else emptyState(refs.empty, 'i-search', 'لا توجد مستندات بهذه الخيارات', 'جرّب «كل الفترات» أو اختر «الكل» في الفلاتر.');
    }

    const per = state.period === 'all' ? 'كل الفترات' : `${state.from || '…'} ← ${state.to || '…'}`;
    const docFilter = state.docIds.length ? `<span>النطاق: <b>مستند محدد (${SamDB.fmt(state.docIds.length)})</b></span>` : '';
    const batchFilter = state.batchIds.length ? `<span>النطاق: <b>دفعة محددة (${SamDB.fmt(state.batchIds.length)})</b></span>` : '';
    refs.foot.innerHTML = isCustomerRaw()
      ? `<span>الفترة: <b>${esc(per)}</b></span>${batchFilter}<span>الرصيد: <b>تراكمي حتى نهاية الفترة</b></span>`
      : `<span>الفترة: <b>${esc(per)}</b></span>${docFilter}${batchFilter}`
        + `<span>الحالات: <b>${esc(state.buckets.map((b) => (BUCKETS.find((x) => x.key === b) || {}).label).join(' + '))}</b></span>`
        + `<span>الشكل: <b>${state.mode === 'summary' ? 'ملخّص' : 'تفصيلي'}</b></span>`;

    const fit = paperColumns();
    if (fit.hidden.length) {
      refs.fitNote.style.display = '';
      refs.fitNote.innerHTML = `${iconTile('i-warn', 'tone-warn', 'xs')}<span>على الورق (${state.paper.toUpperCase()} ${state.orient === 'landscape' ? 'أفقي' : 'عمودي'}) لا يسع العرض إلا ${fit.keep.length} عموداً، وأُخفي: <b>${esc(fit.hidden.map((c) => c.label).join(' · '))}</b>. وسّع الورق أو اختر «أفقي» أو أخفِ أعمدة أقل أهمية لتظهر كلها.</span>`;
    } else {
      refs.fitNote.style.display = 'none';
      refs.fitNote.innerHTML = '';
    }
    paintCols();
  }

  async function run() {
    if (!refs) return;
    try {
      state.res = await SamDB.call('docReport', filters());
      state.ran = true;
      paint();
    } catch (e) {
      state.res = null;
      refs.tbl.innerHTML = '';
      refs.totals.innerHTML = '';
      toggleEmpty(refs.empty, refs.tbl, true);
      emptyState(refs.empty, 'i-warn', 'تعذّر تشغيل التقرير', e && e.message ? e.message : String(e));
      toast(e && e.message ? e.message : 'تعذّر تشغيل التقرير', 'bad', 5200);
    }
  }

  /* ---------------- the paper: the SAME rows, the SAME columns ---------------- */
  function customerRawTotalsTable(t) {
    const rows = (t.byUnit || []).map((u) => `<tr><td>${esc(u.unit)}</td>`
      + `<td>${SamDB.fmt(u.batches)}</td><td>${SamDB.fmt(u.received)}</td>`
      + `<td>${SamDB.fmt(u.issued)}</td><td>${SamDB.fmt(u.producedGood)}</td>`
      + `<td>${SamDB.fmt(u.delivered)}</td><td>${SamDB.fmt(u.inWarehouse)}</td>`
      + `<td>${SamDB.fmt(u.inProduction)}</td></tr>`).join('');
    return `<div style="margin-top:4mm"><b>الإجماليات — كل وحدة على حدة</b>`
      + '<table class="tbl" style="width:100%;table-layout:fixed">'
      + '<thead><tr><th>الوحدة</th><th>الدفعات</th><th>مستلم</th><th>صرف</th><th>تام مستلم</th>'
      + '<th>مسلّم للعميل</th><th>بالمخازن</th><th>بالإنتاج</th></tr></thead>'
      + `<tbody>${rows}</tbody></table></div>`;
  }

  function advancedTotalsTable(t) {
    const rows = (t.byUnit || []).map((u) => {
      if (state.kind === 'category') return `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.inQty)}</td><td>${SamDB.fmt(u.outQty)}</td><td>${SamDB.fmt(u.net)}</td><td>${SamDB.fmt(u.value)}</td></tr>`;
      if (isStatement()) return `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.inQty)}</td><td>${SamDB.fmt(u.outQty)}</td><td>${SamDB.fmt(u.net)}</td></tr>`;
      return `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.opening)}</td><td>${SamDB.fmt(u.inQty)}</td><td>${SamDB.fmt(u.outQty)}</td><td>${SamDB.fmt(u.balance)}</td></tr>`;
    }).join('');
    const heads = state.kind === 'category'
      ? '<th>الوحدة</th><th>وارد</th><th>صادر</th><th>الصافي</th><th>قيمة الفواتير</th>'
      : isStatement()
        ? '<th>الوحدة</th><th>وارد</th><th>صادر</th><th>الصافي</th>'
        : '<th>الوحدة</th><th>افتتاحي</th><th>وارد</th><th>صادر</th><th>المتبقي</th>';
    return `<div style="margin-top:4mm"><b>الإجماليات — كل وحدة على حدة</b>`
      + `<table class="tbl" style="width:100%;table-layout:fixed"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function advancedSheetHead(t) {
    const per = state.period === 'all' ? 'كل الفترات' : `${state.from} ← ${state.to}`;
    if (state.kind === 'category') return [
      { k: 'الفترة', v: per },
      { k: 'عدد المستندات', v: SamDB.fmt(t.documents) },
      { k: 'قيمة الفواتير', v: `${SamDB.fmt(t.value)} ${CURRENCY}` }
    ];
    if (isStatement()) return [
      { k: 'الفترة', v: per },
      { k: 'الافتتاحي', v: `${SamDB.fmt(t.opening)} ${CURRENCY}` },
      { k: state.kind === 'supplier_statement' ? 'مشتريات / له' : 'مبيعات / عليه', v: `${SamDB.fmt(t.debit)} ${CURRENCY}` },
      { k: 'مرتجع / خصم', v: `${SamDB.fmt(t.credit)} ${CURRENCY}` },
      { k: 'الرصيد الختامي', v: `${SamDB.fmt(t.balance)} ${CURRENCY}` }
    ];
    return [
      { k: 'الفترة', v: per },
      { k: 'عدد الصفوف', v: SamDB.fmt(t.rows) },
      { k: 'عدد الحركات', v: SamDB.fmt(t.moves) },
      { k: 'الإجماليات', v: 'كل وحدة على حدة' }
    ];
  }

  function sheetOpts() {
    const res = state.res;
    const fit = paperColumns();
    const cols = fit.keep;
    const head = `<tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
    const body = res.rows.map((r) => `<tr class="${r.docFirst ? 'doc-first' : ''}">`
      + cols.map((c) => `<td>${cellHtml(r, c, true)}</td>`).join('') + '</tr>').join('');
    const t = res.totals;
    const per = state.period === 'all' ? 'كل الفترات' : `${state.from} ← ${state.to}`;
    if (isCustomerRaw()) {
      const one = (t.byUnit || []).length === 1 && !t.incompatibleBatches;
      const amount = (key) => one ? SamDB.fmt(t[key]) : 'بوحدته';
      const unitWarning = t.incompatibleBatches
        ? `<p style="margin:0 0 3mm;padding:2.5mm 3mm;border:1px solid #f3c58b;background:#fff8e8;border-radius:2mm;font-size:9pt;font-weight:700;text-align:center">تنبيه: ${SamDB.fmt(t.incompatibleBatches)} دفعات بوحدات مختلفة — لا تُجمع أرصدتها؛ تظهر كميات الخام والتام منفصلة، والرصيد المجموع بعلامة —.</p>`
        : '';
      const mmTotal = cols.reduce((sum, c) => sum + paperColMM(c), 0) || 1;
      const colgroup = `<colgroup>${cols.map((c) => `<col style="width:${(paperColMM(c) / mmTotal * 100).toFixed(2)}%">`).join('')}</colgroup>`;
      return {
        title: `تقرير ${res.title}`,
        subtitle: `سطر لكل دفعة · رصيد تراكمي حتى نهاية الفترة · ${per}`,
        docRef: `DR-${state.kind}-${state.from || 'all'}-${state.to || 'all'}`,
        docRefLabel: 'رقم التقرير',
        head: [
          { k: 'الفترة', v: per },
          { k: 'عدد الدفعات', v: SamDB.fmt(t.batches) },
          { k: 'مسلّم للعميل', v: amount('delivered') },
          { k: 'باقٍ بالمخازن', v: amount('inWarehouse') },
          { k: 'ما زال بالإنتاج', v: amount('inProduction') }
        ],
        bodyHtml: `
          ${unitWarning}
          <table class="tbl" style="width:100%;table-layout:fixed">
            ${colgroup}<thead>${head}</thead><tbody>${body}</tbody>
          </table>
          ${customerRawTotalsTable(t)}`,
        dense: false,
        landscape: state.orient === 'landscape',
        paper: state.paper,
        footer: `SAM Management System — تقرير ${res.title}`
          + (fit.hidden.length ? ` · أُخفي من الورق: ${fit.hidden.map((c) => c.label).join(' · ')}` : ''),
        kind: 'report'
      };
    }
    if (isAdvanced()) {
      const subtitle = state.kind === 'category' ? 'سطر لكل فئة ووحدة'
        : isStatement() ? 'سطر لكل صنف — القيمة مرة واحدة والرصيد جارٍ'
          : state.mode === 'summary' ? 'ملخّص — سطر لكل صنف ومخزن' : 'تفصيلي — كل حركة ورصيدها الجاري';
      return {
        title: isStatement() ? res.title : `تقرير ${res.title}`,
        subtitle: `${subtitle} · ${per}`,
        docRef: `DR-${state.kind}-${state.from || 'all'}-${state.to || 'all'}`,
        docRefLabel: 'رقم التقرير',
        head: advancedSheetHead(t),
        bodyHtml: `
          <table class="tbl" style="width:100%;table-layout:fixed">
            <thead>${head}</thead><tbody>${body}</tbody>
          </table>
          ${advancedTotalsTable(t)}`,
        dense: false,
        landscape: state.orient === 'landscape',
        paper: state.paper,
        footer: `SAM Management System — تقرير ${res.title}`
          + (fit.hidden.length ? ` · أُخفي من الورق: ${fit.hidden.map((c) => c.label).join(' · ')}` : ''),
        kind: 'report'
      };
    }
    const flow = t.inQty !== undefined;
    const unitRows = (t.byUnit || []).map((u) => (flow
      ? `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.inQty)}</td><td>${SamDB.fmt(u.outQty)}</td><td>${SamDB.fmt(u.net)}</td></tr>`
      : `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.pieces)}</td>`
        + `<td>${SamDB.fmt(u.cartons)}</td><td>${SamDB.fmt(u.bags)}</td></tr>`)).join('');
    return {
      title: `تقرير ${res.title}`,
      subtitle: `${state.mode === 'summary' ? 'ملخّص — سطر لكل مستند' : 'تفصيلي — سطر لكل صنف'} · ${per}`,
      docRef: `DR-${state.kind}-${state.from || 'all'}`,
      docRefLabel: 'رقم التقرير',
      head: flow
        ? [
          { k: 'الفترة', v: per },
          { k: 'إجمالي الوارد', v: SamDB.fmt(t.inQty) },
          { k: 'إجمالي الصادر', v: SamDB.fmt(t.outQty) },
          { k: 'الصافي', v: SamDB.fmt(t.net) }
        ]
        : [
          { k: 'الفترة', v: per },
          { k: 'عدد المستندات', v: SamDB.fmt(t.documents) },
          { k: 'عدد الأسطر', v: SamDB.fmt(t.rows) },
          { k: 'قيمة الفواتير', v: `${SamDB.fmt(t.value)} ${CURRENCY}` }
        ],
      bodyHtml: `
        <table class="tbl" style="width:100%;table-layout:fixed">
          <thead>${head}</thead><tbody>${body}</tbody>
        </table>
        <div style="margin-top:4mm"><b>الإجماليات — كل شيء بوحدته</b>
          <table class="tbl" style="width:100%">
            <thead><tr>${flow
              ? '<th>الوحدة</th><th>وارد</th><th>صادر</th><th>الصافي</th>'
              : '<th>الوحدة</th><th>الكمية</th><th>كراتين</th><th>أكياس</th>'}</tr></thead>
            <tbody>${unitRows}</tbody>
          </table>
        </div>`,
      dense: false,
      landscape: state.orient === 'landscape',
      paper: state.paper,
      footer: `SAM Management System — تقرير ${res.title}`
        + (fit.hidden.length ? ` · أُخفي من الورق: ${fit.hidden.map((c) => c.label).join(' · ')}` : ''),
      /* a report is not a document — the signature band stays OPTIONAL and
         empty until the customer adds the names he wants */
      kind: 'report'
    };
  }

  function doPrint() {
    if (!state.res) return toast('شغّل التقرير أولاً', 'bad');
    printPreview(sheetOpts());
  }

  async function doPdf() {
    if (!state.res) return toast('شغّل التقرير أولاً', 'bad');
    const node = SamUI.sheet(sheetOpts());
    const r = await SamUI.exportPdf(node, {
      landscape: state.orient === 'landscape',
      paper: state.paper,
      fileName: `SAM-${state.kind}-${state.from || 'all'}.pdf`
    });
    if (r && r.ok) toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200);
    else if (r && !r.canceled) toast(r.error || 'تعذّر حفظ الملف', 'bad');
  }

  /* ---------------- Excel: the same rows again ---------------- */
  function excelSpec() {
    const res = state.res;
    if (!res) return null;
    const cols = activeColumns();
    const columns = cols.map((c) => ({
      header: c.label, key: c.key, bold: c.pic || c.key === 'externalNo' || c.key === 'batchNo',
      num: !!(c.num || c.money), fmt: c.money ? '#,##0.00' : '#,##0'
    }));
    const withItemCode = state.mode === 'detail' && res.rows.some((r) => r.itemCode);
    if (withItemCode) columns.unshift({ header: 'كود الصنف', key: 'itemCode' });
    const rows = res.rows.map((r) => {
      const o = {};
      cols.forEach((c) => { o[c.key] = (c.num || c.money) ? (r[c.key] == null ? null : SamDB.n(r[c.key])) : (r[c.key] == null ? '' : String(r[c.key])); });
      if (withItemCode) o.itemCode = r.itemCode || '';
      return o;
    });
    if (isCustomerRaw()) {
      const t = res.totals;
      const one = (t.byUnit || []).length === 1 && !t.incompatibleBatches;
      const totals = one
        ? ['received', 'issued', 'producedGood', 'delivered', 'inWarehouse', 'inProduction',
          'rawInWarehouse', 'finishedInWarehouse', 'producedDefect', 'returned']
          .filter((key) => cols.some((c) => c.key === key))
          .map((key) => ({ key, value: t[key] }))
        : [];
      const meta = [
        ['الفترة', state.period === 'all' ? 'كل الفترات' : `${state.from} ← ${state.to}`],
        ['الشكل', 'سطر لكل دفعة — رصيد تراكمي حتى نهاية الفترة'],
        ['عدد الدفعات', SamDB.fmt(t.batches)],
        ['قاعدة الوحدة', 'الأمبول يساوي العلبة 1:1 — لا تُخلط الوحدات الأخرى'],
        ...(t.incompatibleBatches ? [['تنبيه الوحدات', `${SamDB.fmt(t.incompatibleBatches)} دفعات بوحدات مختلفة — أرصدتها المجمعة فارغة، وكميات الخام والتام منفصلة.`]] : [])
      ];
      (t.byUnit || []).forEach((u) => {
        meta.push([`إجمالي خام مستلم — ${u.unit}`, SamDB.fmt(u.received)]);
        meta.push([`إجمالي صرف للإنتاج — ${u.unit}`, SamDB.fmt(u.issued)]);
        meta.push([`إجمالي تام مستلم — ${u.unit}`, SamDB.fmt(u.producedGood)]);
        meta.push([`إجمالي مسلّم للعميل — ${u.unit}`, SamDB.fmt(u.delivered)]);
        meta.push([`إجمالي باقٍ بالمخازن — ${u.unit}`, SamDB.fmt(u.inWarehouse)]);
        meta.push([`إجمالي ما زال بالإنتاج — ${u.unit}`, SamDB.fmt(u.inProduction)]);
      });
      return {
        fileName: `SAM-${state.kind}-${state.from || 'all'}-${state.to || 'all'}.xlsx`,
        sheetName: res.title,
        title: `تقرير ${res.title}`,
        subtitle: 'SAM Management System — إجماليات كل وحدة على حدة',
        meta, columns, rows, totals
      };
    }
    if (isAdvanced()) {
      const t = res.totals;
      const totals = [];
      if (state.kind === 'category' && cols.some((c) => c.key === 'value')) totals.push({ key: 'value', value: t.value });
      if (isStatement()) {
        if (cols.some((c) => c.key === 'signedValue')) totals.push({ key: 'signedValue', value: t.debit - t.credit });
        if (cols.some((c) => c.key === 'balance')) totals.push({ key: 'balance', value: t.balance });
      }
      const meta = [
        ['الفترة', state.period === 'all' ? 'كل الفترات' : `${state.from} ← ${state.to}`],
        ['الشكل', state.kind === 'category' ? 'سطر لكل فئة ووحدة'
          : isStatement() ? 'كشف مستندات — القيمة مرة واحدة والرصيد جارٍ'
            : state.mode === 'summary' ? 'ملخّص صنف/مخزن' : 'تفصيل كل حركة']
      ];
      if (state.kind === 'category') {
        meta.push(['عدد المستندات', SamDB.fmt(t.documents)]);
        meta.push(['قيمة الفواتير', `${SamDB.fmt(t.value)} ${CURRENCY}`]);
      } else if (isStatement()) {
        meta.push(['الرصيد الافتتاحي', `${SamDB.fmt(t.opening)} ${CURRENCY}`]);
        meta.push(['الرصيد الختامي', `${SamDB.fmt(t.balance)} ${CURRENCY}`]);
      } else {
        meta.push(['عدد الصفوف', SamDB.fmt(t.rows)]);
        meta.push(['عدد الحركات', SamDB.fmt(t.moves)]);
      }
      (t.byUnit || []).forEach((u) => {
        if (state.kind === 'category') {
          meta.push([`إجمالي صافي ${u.unit}`, SamDB.fmt(u.net)]);
          meta.push([`إجمالي قيمة ${u.unit}`, `${SamDB.fmt(u.value)} ${CURRENCY}`]);
        } else if (isStatement()) {
          meta.push([`إجمالي وارد ${u.unit}`, SamDB.fmt(u.inQty)]);
          meta.push([`إجمالي صادر ${u.unit}`, SamDB.fmt(u.outQty)]);
        } else {
          meta.push([`افتتاحي ${u.unit}`, SamDB.fmt(u.opening)]);
          meta.push([`وارد ${u.unit}`, SamDB.fmt(u.inQty)]);
          meta.push([`صادر ${u.unit}`, SamDB.fmt(u.outQty)]);
          meta.push([`متبقي ${u.unit}`, SamDB.fmt(u.balance)]);
        }
      });
      return {
        fileName: `SAM-${state.kind}-${state.from || 'all'}-${state.to || 'all'}.xlsx`,
        sheetName: res.title, title: `تقرير ${res.title}`,
        subtitle: 'SAM Management System — إجماليات كل وحدة على حدة',
        meta, columns, rows, totals
      };
    }
    const totals = [{ key: 'pieces', value: res.totals.pieces }];
    if (res.totals.inQty !== undefined) {
      totals.push({ key: 'inQty', value: res.totals.inQty });
      totals.push({ key: 'outQty', value: res.totals.outQty });
      totals.push({ key: 'net', value: res.totals.net });
      totals.push({ key: 'delta', value: res.totals.net });
    }
    if (cols.some((c) => c.key === 'cartons')) totals.push({ key: 'cartons', value: res.totals.cartons });
    if (cols.some((c) => c.key === 'bags')) totals.push({ key: 'bags', value: res.totals.bags });
    if (cols.some((c) => c.key === 'invoiceValue')) totals.push({ key: 'invoiceValue', value: res.totals.value });
    return {
      fileName: `SAM-${state.kind}-${state.from || 'all'}.xlsx`,
      sheetName: res.title,
      title: `تقرير ${res.title}`,
      subtitle: `SAM Management System — ${SamUI.WATERMARK}`,
      meta: [
        ['الفترة', state.period === 'all' ? 'كل الفترات' : `${state.from} ← ${state.to}`],
        ['الشكل', state.mode === 'summary' ? 'ملخّص' : 'تفصيلي'],
        ['عدد المستندات', SamDB.fmt(res.totals.documents)],
        ...(res.totals.inQty !== undefined
          ? [['إجمالي الوارد', SamDB.fmt(res.totals.inQty)],
            ['إجمالي الصادر', SamDB.fmt(res.totals.outQty)],
            ['الصافي', SamDB.fmt(res.totals.net)]]
          : [['قيمة الفواتير', `${SamDB.fmt(res.totals.value)} ${CURRENCY}`]]),
        ...((res.totals.byUnit || []).map((u) => (res.totals.inQty !== undefined
          ? [`إجمالي ${u.unit} — صافي`, SamDB.fmt(u.net)]
          : [`إجمالي ${u.unit}`, SamDB.fmt(u.pieces)])))
      ],
      columns, rows, totals
    };
  }

  async function doExcel() {
    const spec = excelSpec();
    if (!spec) return toast('شغّل التقرير أولاً', 'bad');
    const out = await sam.app.saveXlsx(spec);
    if (out && out.ok) {
      toast(`تم حفظ ملف Excel: ${out.data.path} (${SamDB.fmt(out.data.rows)} سطر)`, 'ok', 5600);
      sam.app.openPath(out.data.path.replace(/[\\/][^\\/]+$/, ''));
    } else if (out && !out.canceled) toast(out.error || 'تعذّر حفظ الملف', 'bad', 5200);
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    if (wired || !refs) return;
    wired = true;
    document.getElementById('btnDocRun').addEventListener('click', run);
    document.getElementById('btnDocPrint').addEventListener('click', doPrint);
    document.getElementById('btnDocExcel').addEventListener('click', doExcel);
    document.getElementById('btnDocBack').addEventListener('click', goBack);
    document.getElementById('drDocClear').addEventListener('click', () => {
      state.docIds = [];
      paintSpecial(); run();
    });
    document.getElementById('drBatchClear').addEventListener('click', () => {
      state.batchIds = [];
      paintSpecial(); run();
    });
    refs.from.addEventListener('change', () => { state.from = refs.from.value; state.period = 'custom'; paintPeriods(); run(); });
    refs.to.addEventListener('change', () => { state.to = refs.to.value; state.period = 'custom'; paintPeriods(); run(); });
    [...refs.mode.querySelectorAll('button')].forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      state.modes[state.kind] = state.mode;
      writeStore(); paintMode(); run();
    }));
    [...refs.paper.querySelectorAll('button')].forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.paper) state.paper = b.dataset.paper;
      if (b.dataset.orient) state.orient = b.dataset.orient;
      writeStore(); paintPaper(); paint();
    }));
    document.getElementById('drAllCols').addEventListener('click', () => setAllCols(true));
    document.getElementById('drNoCols').addEventListener('click', () => setAllCols(false));
    refs.tbl.addEventListener('click', (e) => {
      const td = e.target.closest('td[data-drill]');
      if (!td) return;
      openDrill({ type: td.dataset.drill, id: td.dataset.id, kind: td.dataset.kind });
    });
    /* Reports stay read-only. A double-click explains where edits live and
       never opens the document editor with its hard-delete action. */
    refs.tbl.addEventListener('dblclick', (e) => {
      if (!e.target.closest('tr.dr-row')) return;
      toast('التقارير للقراءة فقط — افتح العمليات لتعديل المستندات', 'warn', 4600);
    });
  }

  function openReport(kind, options = {}) {
    if (!refs || !kind) return;
    const list = (v) => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    state.kind = kind;
    state.mode = defaultMode(kind);
    state.partyId = list(options.partyId);
    state.itemId = list(options.itemId);
    state.category = list(options.category);
    state.warehouseId = list(options.warehouseId);
    state.buckets = Array.isArray(options.buckets) && options.buckets.length ? options.buckets.slice() : ['good'];
    state.docIds = list(options.docIds);
    state.batchIds = list(options.batchIds);
    state.back = [];
    if (options.period === 'custom') {
      state.period = 'custom'; state.from = options.from || ''; state.to = options.to || '';
      if (refs) { refs.from.value = state.from; refs.to.value = state.to; }
    } else applyPeriod(options.period || 'all');
    writeStore();
    paintSpecial(); paintKinds(); paintMode(); paintBuckets(); fillCombos(); run();
  }

  async function load() {
    readStore();
    refs = {
      kinds: document.getElementById('drKinds'),
      periods: document.getElementById('drPeriods'),
      from: document.getElementById('drFrom'),
      to: document.getElementById('drTo'),
      party: document.getElementById('drParty'),
      item: document.getElementById('drItem'),
      category: document.getElementById('drCategory'),
      wh: document.getElementById('drWh'),
      mode: document.getElementById('drMode'),
      modeBadge: document.getElementById('drModeBadge'),
      buckets: document.getElementById('drBuckets'),
      paper: document.getElementById('drPaper'),
      cols: document.getElementById('drCols'),
      fitNote: document.getElementById('drFitNote'),
      totals: document.getElementById('drTotals'),
      title: document.getElementById('drTitle'),
      count: document.getElementById('drCount'),
      tbl: document.getElementById('drTbl'),
      empty: document.getElementById('drEmpty'),
      foot: document.getElementById('drFoot')
    };
    if (!refs.kinds) return;
    await loadRef();
    initCombos();
    wire();
    applyPeriod(state.period === 'custom' ? 'today' : state.period);
    paintSpecial(); paintKinds(); paintMode(); paintPaper(); paintBuckets();
    await run();
  }

  window.SamDocReports = { load, open: openReport, run, print: doPrint, pdf: doPdf, excel: doExcel, sheetOpts, excelSpec, state };
})();