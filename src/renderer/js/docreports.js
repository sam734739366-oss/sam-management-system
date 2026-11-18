'use strict';

/* =====================================================================
   تقارير المستندات — V9
   The screen that replaces the old catalogue of fourteen reports.

   One engine, the seven kinds the customer named, two shapes of the same
   truth (تفصيلي / ملخّص), «الكل» as a visible choice in every filter, the
   number HE wrote on the paper, and a total for every unit separately —
   20,000 ريال beside 20,000 أمبول beside 20,000 كرتون, never mixed.

   The screen, the paper and Excel are painted from ONE row list, so they
   can never disagree about a number.
   ===================================================================== */
(function () {
  const { el, esc, toast, combo, printPreview, emptyState, toggleEmpty, iconTile } = SamUI;

  const STORE = 'sam.docreports.v1';
  const CURRENCY = SamUI.CURRENCY || 'ريال يمني';

  /* the seven kinds, with the colour and the icon of the document itself */
  const KIND_META = {
    sale: { icon: 'i-cart', tone: 'tone-sell' },
    purchase: { icon: 'i-truck', tone: 'tone-buy' },
    prod_receipt: { icon: 'i-inbox', tone: 'tone-produce' },
    prod_issue: { icon: 'i-issue', tone: 'tone-issue' },
    sale_return: { icon: 'i-return', tone: 'tone-sreturn' },
    purchase_return: { icon: 'i-return', tone: 'tone-buy' },
    tolling_in: { icon: 'i-tolling', tone: 'tone-pretn' },
    warehouse_flow: { icon: 'i-swap', tone: 'tone-move' }
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
    state.mode = state.modes[state.kind] || 'detail';
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
      buckets: state.buckets.slice()
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
      b.addEventListener('click', () => {
        state.kind = k.key;
        state.mode = state.modes[k.key] || 'detail';
        writeStore();
        paintKinds(); paintMode(); run();
      });
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
    itemName: 34, baseUnit: 12, bucketAr: 12, itemCount: 14, moves: 14, pieces: 16,
    inQty: 15, outQty: 15, delta: 15, net: 15,
    cartons: 14, bags: 14, invoiceValue: 22, note: 26
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
  const PAPER_PRIORITY = ['externalNo', 'docDate', 'moveDate', 'itemName', 'pieces', 'invoiceValue',
    'note', 'docKindAr', 'docTypeAr', 'inQty', 'outQty', 'delta', 'net', 'baseUnit', 'partyName',
    'cartons', 'bags', 'bucketAr', 'warehouseName', 'itemCount', 'moves'];
  const prio = (c) => { const i = PAPER_PRIORITY.indexOf(c.key); return i < 0 ? 99 : i; };

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
      const mm = COL_MM[c.key] || 24;
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
    itemCount: 'var(--c-plain)', moves: 'var(--c-plain)'
  };

  function cellHtml(row, c, print) {
    const v = row[c.key];
    if (c.pic) return itemCell(row, print ? 17 : 14, print);
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

  /* ---------------- the totals: every thing in its own unit ---------------- */
  function totalsHtml() {
    const t = (state.res && state.res.totals) || null;
    if (!t) return '';
    const card = (label, value, unit, cls) => `<div class="dr-tot ${cls || ''}">`
      + `<span class="lbl">${esc(label)}</span><b>${SamDB.fmt(SamDB.n(value))}</b><span class="unit">${esc(unit)}</span></div>`;
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
    refs.count.textContent = `${SamDB.fmt(res.rows.length)} ${state.mode === 'summary' ? 'مستند' : 'سطر'}`;
    refs.totals.innerHTML = totalsHtml();

    const head = `<thead><tr>${cols.map((c) => `<th class="${c.pic ? 'pic' : ''} ${c.num || c.money ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
    const body = res.rows.map((r) => `<tr class="dr-row ${r.docFirst ? 'doc-first' : ''}" data-doc="${r.docId}">`
      + cols.map((c) => `<td class="${c.num || c.money ? 'num' : ''}">${cellHtml(r, c, false)}</td>`).join('') + '</tr>').join('');
    refs.tbl.innerHTML = head + `<tbody>${body}</tbody>`;
    toggleEmpty(refs.empty, refs.tbl, res.rows.length === 0);
    if (!res.rows.length) emptyState(refs.empty, 'i-search', 'لا توجد مستندات بهذه الخيارات', 'جرّب «كل الفترات» أو اختر «الكل» في الفلاتر.');

    const per = state.period === 'all' ? 'كل الفترات' : `${res.rows.length ? '' : ''}${state.from || '…'} ← ${state.to || '…'}`;
    refs.foot.innerHTML = `<span>الفترة: <b>${esc(per)}</b></span>`
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
  function sheetOpts() {
    const res = state.res;
    const fit = paperColumns();
    const cols = fit.keep;
    const head = `<tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
    const body = res.rows.map((r) => `<tr class="${r.docFirst ? 'doc-first' : ''}">`
      + cols.map((c) => `<td>${cellHtml(r, c, true)}</td>`).join('') + '</tr>').join('');
    const t = res.totals;
    const flow = t.inQty !== undefined;
    const unitRows = (t.byUnit || []).map((u) => (flow
      ? `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.inQty)}</td><td>${SamDB.fmt(u.outQty)}</td><td>${SamDB.fmt(u.net)}</td></tr>`
      : `<tr><td>${esc(u.unit)}</td><td>${SamDB.fmt(u.pieces)}</td>`
        + `<td>${SamDB.fmt(u.cartons)}</td><td>${SamDB.fmt(u.bags)}</td></tr>`)).join('');
    const per = state.period === 'all' ? 'كل الفترات' : `${state.from} ← ${state.to}`;
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
      header: c.label, key: c.key, bold: c.pic || c.key === 'externalNo',
      num: !!(c.num || c.money), fmt: c.money ? '#,##0.00' : '#,##0'
    }));
    if (state.mode === 'detail') columns.unshift({ header: 'كود الصنف', key: 'itemCode' });
    const rows = res.rows.map((r) => {
      const o = {};
      cols.forEach((c) => { o[c.key] = (c.num || c.money) ? SamDB.n(r[c.key]) : (r[c.key] == null ? '' : String(r[c.key])); });
      if (state.mode === 'detail') o.itemCode = r.itemCode || '';
      return o;
    });
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
    /* double-click a row → the document itself, with edit AND hard delete,
       exactly as the operations screen offers it */
    refs.tbl.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr.dr-row');
      if (!tr || !window.SamDocs) return;
      const id = Number(tr.dataset.doc);
      if (!id) return;
      if (typeof SamDocs.viewDoc === 'function') SamDocs.viewDoc(id);
      else SamDocs.openEditor(id);
    });
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
    paintKinds(); paintMode(); paintPaper(); paintBuckets();
    await run();
  }

  window.SamDocReports = { load, run, print: doPrint, pdf: doPdf, excel: doExcel, sheetOpts, excelSpec, state };
})();