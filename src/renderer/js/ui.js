/* =====================================================================
   SamUI — shared building blocks used across every screen:
   toasts, empty states, loading pill, right-click menus, modals,
   hard-delete warning, thousands-aware number boxes, keyboard shortcuts,
   A4 print sheet with watermark + print preview.
   ===================================================================== */
(function (global) {
  'use strict';

  const WATERMARK = 'SAM 775158678';
  const APP_NAME = 'SAM Management System';
  const CURRENCY = 'ريال يمني';

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const icon = (id, cls) => `<svg class="${cls || 'ic'}" aria-hidden="true"><use href="#${id}"/></svg>`;

  /* ---------------- the 3D icon plate ----------------
     Every icon in the program can wear a small coloured 3D square. The
     colour is looked up from the icon id, so the same icon always wears
     the same colour everywhere — the user asked for that consistency. */
  const ICON_TONE = {
    'i-dash': 'tone-info',
    'i-box': 'tone-move',
    'i-pin': 'tone-warn',
    'i-warehouse': 'tone-warn',
    'i-users': 'tone-sreturn',
    'i-user': 'tone-sreturn',
    'i-swap': 'tone-gout',
    'i-factory': 'tone-produce',
    'i-issue': 'tone-issue',
    'i-day': 'tone-gin',
    'i-chart': 'tone-pretn',
    'i-gear': 'tone-plain',
    'i-cart': 'tone-buy',
    'i-in': 'tone-gin',
    'i-out': 'tone-gout',
    'i-gate-in': 'tone-gin',
    'i-gate-out': 'tone-gout',
    'i-return': 'tone-sreturn',
    'i-sigma': 'tone-produce',
    'i-archive': 'tone-plain',
    'i-archive-box': 'tone-move',
    'i-clipboard': 'tone-sell',
    'i-scale': 'tone-sell',
    'i-scrap': 'tone-adjust',
    'i-money': 'tone-sell',
    'i-tag': 'tone-sreturn',
    'i-hash': 'tone-plain',
    'i-list': 'tone-plain',
    'i-cloud': 'tone-info',
    'i-db': 'tone-info',
    'i-folder': 'tone-warn',
    'i-update': 'tone-ok',
    'i-refresh': 'tone-info',
    'i-download': 'tone-info',
    'i-print': 'tone-plain',
    'i-check': 'tone-ok',
    'i-alert': 'tone-warn',
    'i-warn': 'tone-warn',
    'i-info': 'tone-info',
    'i-help': 'tone-info',
    'i-book': 'tone-info',
    'i-tolling': 'tone-produce',
    'i-wh': 'tone-warn',
    'i-bell': 'tone-info',
    'i-calendar': 'tone-gout',
    'i-edit': 'tone-sell',
    'i-exit': 'tone-plain',
    'i-eye': 'tone-info',
    'i-inbox': 'tone-gin',
    'i-lock': 'tone-plain',
    'i-mail': 'tone-info',
    'i-max': 'tone-plain',
    'i-min': 'tone-plain',
    'i-play': 'tone-ok',
    'i-plus': 'tone-ok',
    'i-search': 'tone-info',
    'i-shrink': 'tone-plain',
    'i-trash': 'tone-adjust',
    'i-truck': 'tone-move',
    'i-x': 'tone-adjust'
  };
  const toneOf = (id) => ICON_TONE[id] || 'tone-plain';
  /** a 3D plate that carries an icon */
  const iconTile = (id, tone, size) =>
    `<span class="t3d ${tone || toneOf(id)}${size ? ' ' + size : ''}">${icon(id)}</span>`;
  /** the same plate, but it *becomes* an existing container element —
      the container itself is the 3D square, so we never get a frame
      inside a frame (which was what made the old icons look flat). */
  const plate = (cls, id, tone, size) =>
    `<span class="${cls} t3d ${tone || toneOf(id)}${size ? ' ' + size : ''}">${icon(id)}</span>`;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---------------- toasts (no blocking popups) ---------------- */
  const TOAST_ICON = { ok: 'i-check', bad: 'i-warn', warn: 'i-warn', info: 'i-bell' };
  const TOAST_TONE = { ok: 'tone-ok', bad: 'tone-adjust', warn: 'tone-warn', info: 'tone-info' };
  function toast(msg, kind, ms = 3200) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const k = kind || 'info';
    const t = el('div', `toast ${k}`, `${iconTile(TOAST_ICON[k] || 'i-bell', TOAST_TONE[k] || 'tone-info', 'xs')}<span>${esc(msg)}</span>`);
    host.appendChild(t);
    const kill = () => {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 320);
    };
    t.addEventListener('click', kill);
    setTimeout(kill, ms);
    // never let a burst of messages bury the screen
    while (host.children.length > 3) host.firstElementChild.remove();
  }

  /* ---------------- loading pill ---------------- */
  let busyCount = 0;
  function busy(on, label) {
    const node = document.getElementById('busyPill');
    if (!node) return;
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    if (label) node.lastElementChild.textContent = label;
    node.classList.toggle('on', busyCount > 0);
  }

  /* ---------------- empty states ---------------- */
  /**
   * Fill an `.empty` block with a real empty state instead of a bare sentence.
   * @param {HTMLElement|string} host
   * @param {{title?:string,hint?:string,actionLabel?:string,onAction?:Function,icon?:string}} o
   */
  function emptyState(host, o) {
    const node = typeof host === 'string' ? document.getElementById(host) : host;
    if (!node) return;
    node.innerHTML = `
      <span class="e-ic t3d ${o.tone || toneOf(o.icon || 'i-inbox')} xl">${icon(o.icon || 'i-inbox')}</span>
      <span class="e-title">${esc(o.title || 'لا توجد بيانات')}</span>
      ${o.hint ? `<span class="e-hint">${esc(o.hint)}</span>` : ''}
      ${o.actionLabel ? `<button class="btn btn-primary btn-sm" type="button">${iconTile('i-plus', 'tone-ok', 'xs')}<span class="btn-txt">${esc(o.actionLabel)}</span></button>` : ''}`;
    node.dataset.filled = '1';
    if (o.actionLabel && o.onAction) {
      node.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); o.onAction(); });
    }
    node._hidden = false;
  }
  /** show/hide an already-filled empty state */
  function toggleEmpty(host, hasRows) {
    const node = typeof host === 'string' ? document.getElementById(host) : host;
    if (!node) return;
    node.style.display = hasRows ? 'none' : 'flex';
  }

  /* ---------------- numbers: thousands separators ---------------- */
  const cleanNum = (s) => String(s == null ? '' : s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[,٬\s]/g, '')
    .replace(/[^\d.\-]/g, '');
  const parseNum = (v) => {
    if (typeof v === 'number') return v;
    const c = cleanNum(v);
    if (!c || c === '-' || c === '.') return 0;
    const n = Number(c);
    return Number.isFinite(n) ? n : 0;
  };
  /** 1234567.5 -> "1,234,567.5" (never Arabic digits: inputs stay LTR-readable) */
  const groupNum = (v) => {
    const c = cleanNum(v);
    if (!c || c === '-' || c === '.') return '';
    const n = Number(c);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  };

  /**
   * Turn a text box into a quantity / money field: raw digits while typing,
   * grouped with commas on blur. `unit` renders an affix (e.g. currency).
   */
  function makeNumInput(input, opts = {}) {
    input.dataset.num = '1';
    input.setAttribute('inputmode', 'decimal');
    input.classList.add('num-in');
    if (opts.placeholder !== undefined) input.placeholder = opts.placeholder;
    else input.placeholder = opts.decimals ? '0.00' : '0';
    if (!input.dataset.numBound) {
      input.dataset.numBound = '1';
      input.addEventListener('focus', () => {
        const raw = cleanNum(input.value);
        input.value = raw && raw !== '-' ? raw : '';
        input.select();
      });
      input.addEventListener('blur', () => {
        const raw = cleanNum(input.value);
        if (!raw || raw === '-' || raw === '.') { input.value = ''; return; }
        input.value = groupNum(raw);
        if (opts.onBlur) opts.onBlur(parseNum(input.value), input);
      });
      input.addEventListener('input', () => { if (opts.onInput) opts.onInput(parseNum(input.value), input); });
    }
    return input;
  }
  const numValue = (input) => parseNum(input.value);

  /* ---------------- context menu ---------------- */
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('blur', closeMenu);
    document.removeEventListener('keydown', onKey, true);
  }
  function onDocDown(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function onKey(e) { if (e.key === 'Escape') closeMenu(); }

  function menu(items, x, y, anchorEl) {
    closeMenu();
    const m = el('div', 'ctx');
    items.forEach((it) => {
      if (it === '-') { m.appendChild(el('div', 'ctx-sep')); return; }
      const row = el('div', `ctx-item ${it.danger ? 'danger' : ''}`);
      row.innerHTML = `${it.icon ? iconTile(it.icon, null, 'xs') : '<span style="width:18px"></span>'}<span>${esc(it.label)}</span>`;
      if (it.disabled) row.setAttribute('disabled', '1');
      else row.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
      m.appendChild(row);
    });
    m.style.left = '0px';
    m.style.top = '0px';
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    const px = Math.min(x, global.innerWidth - r.width - 8);
    const py = Math.min(y, global.innerHeight - r.height - 8);
    m.style.left = `${Math.max(6, px)}px`;
    m.style.top = `${Math.max(6, py)}px`;
    openMenu = m;
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('blur', closeMenu);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return m;
  }

  /** attach view/edit/delete style right-click + double-click to a row */
  function bindRow(node, actions) {
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [];
      if (actions.view) items.push({ label: 'عرض', icon: 'i-eye', onClick: actions.view });
      if (actions.edit) items.push({ label: 'تعديل', icon: 'i-edit', onClick: actions.edit });
      if (items.length) items.push('-');
      if (actions.del) items.push({ label: 'حذف نهائي', icon: 'i-trash', danger: true, onClick: actions.del });
      if (actions.extra) actions.extra.forEach((x) => items.push(x));
      menu(items, e.clientX, e.clientY);
    });
    node.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (actions.view) actions.view();
    });
    return node;
  }

  /* ---------------- keyboard shortcut stack ---------------- */
  /** screens push {save, isNew} while they are the top-most interactive layer */
  const keyStack = [];
  function pushKeys(handlers) {
    keyStack.push(handlers);
    return () => { const i = keyStack.indexOf(handlers); if (i >= 0) keyStack.splice(i, 1); };
  }
  function topKey(which) {
    for (let i = keyStack.length - 1; i >= 0; i--) {
      if (typeof keyStack[i][which] === 'function') return keyStack[i][which];
    }
    return null;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') {
      const fn = topKey('refresh');
      if (fn) { e.preventDefault(); fn(); }
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      const fn = topKey('save');
      if (fn) fn();
      else toast('لا يوجد نموذج مفتوح للحفظ', 'warn');
    } else if (k === 'n') {
      e.preventDefault();
      const fn = topKey('new');
      if (fn) fn();
    } else if (k === 'p') {
      e.preventDefault();
      const fn = topKey('print');
      if (fn) fn();
    }
  }, true);

  /* ---------------- modal ---------------- */
  function modal(opts) {
    const {
      title = '',
      body = '',
      actions = [{ label: 'إغلاق', value: 'close', kind: 'btn-ghost' }],
      danger = false,
      info = false,
      width = null
    } = opts || {};

    return new Promise((resolve) => {
      const ov = el('div', 'overlay');
      const box = el('div', `modal ${danger ? 'danger' : ''} ${info ? 'info' : ''}`);
      if (width) box.style.width = width;
      box.appendChild(el('h3', '', esc(title)));
      const b = el('div', 'modal-body');
      if (typeof body === 'string') b.innerHTML = body;
      else b.appendChild(body);
      box.appendChild(b);

      const foot = el('div', 'modal-foot');
      actions.forEach((a) => {
        const btn = el('button', `btn ${a.kind || 'btn-ghost'}`, `${a.icon ? iconTile(a.icon, null, 'xs') : ''}<span class="btn-txt">${esc(a.label)}</span>`);
        btn.addEventListener('click', () => done(a.value));
        foot.appendChild(btn);
      });
      box.appendChild(foot);
      ov.appendChild(box);
      document.body.appendChild(ov);

      let settled = false;
      function done(val) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onEsc, true);
        pop();
        ov.remove();
        resolve(val);
      }
      function onEsc(e) { if (e.key === 'Escape') done('cancel'); }
      const pop = pushKeys({ save: null });
      document.addEventListener('keydown', onEsc, true);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done('cancel'); });
      const first = foot.querySelector('.btn-primary, .btn-gold, .btn-danger') || foot.lastChild;
      if (first) first.focus();
    });
  }

  /**
   * Warning that does NOT block a save — used when stock is not enough:
   * the user confirms and the document is written anyway.
   */
  function confirmWarning({ title = 'تنبيه', lines = [], note = '', okLabel = 'متابعة الحفظ' }) {
    const rows = lines.length
      ? `<ul style="margin:10px 0 0;padding-inline-start:20px;display:flex;flex-direction:column;gap:6px">
           ${lines.map((l) => `<li><b>${esc(l.item)}</b> — ${esc(l.text)}</li>`).join('')}
         </ul>`
      : '';
    return modal({
      title,
      info: true,
      body: `<div style="display:flex;gap:12px;align-items:flex-start;background:var(--warn-bg);padding:12px 14px;border-radius:12px;border:1px solid var(--warn-line)">
          ${iconTile('i-warn', 'tone-warn', 'xs')}
          <div><b style="color:var(--warn)">الرصيد غير كافٍ</b><br>
          <span style="font-size:13.5px">${esc(note || 'يمكنك المتابعة؛ سيصبح الرصيد سالباً وستراه في التقارير كما هو.')}</span></div>
        </div>${rows}`,
      actions: [
        { label: okLabel, value: 'yes', kind: 'btn-gold', icon: 'i-check' },
        { label: 'رجوع', value: 'cancel', kind: 'btn-ghost' }
      ]
    });
  }

  /**
   * Hard-delete confirmation: explains exactly what will happen to stock,
   * then the caller physically deletes the document and reverts quantities.
   */
  function confirmHardDelete({ docNo = '', docType = '', lines = [], extra = '' }) {
    const rows = lines.length
      ? `<table class="tbl" style="margin-top:10px">
           <thead><tr><th>الصنف</th><th>الموقع</th><th>الحركة</th><th>الكمية (حبة)</th></tr></thead>
           <tbody>${lines.map((l) => `<tr>
             <td>${esc(l.item)}</td><td>${esc(l.wh)}</td>
             <td>${esc(l.dir)}</td>
             <td class="num qty">${esc(l.qty)}</td>
           </tr>`).join('')}</tbody></table>`
      : '';
    const body = `
      <div style="display:flex;gap:12px;align-items:center;background:var(--bad-bg);padding:12px 14px;border-radius:12px;border:1px solid var(--bad-line)">
        ${iconTile('i-warn', 'tone-adjust', 'xs')}
        <div><b style="color:var(--bad)">تحذير: حذف نهائي</b><br>
        <span style="font-size:13px">هذا المستند لن يُترك بحالة "ملغي" — سيُحذف من قاعدة البيانات نهائياً ولا يمكن التراجع.</span></div>
      </div>
      <p style="margin-top:14px">المستند: <b>${esc(docType)}</b> رقم <b>${esc(docNo)}</b></p>
      ${extra}
      ${rows}
      <p style="margin-top:14px;font-size:13px">عند المتابعة سيتم <b>عكس كل حركة مخزون</b> مسجلة لهذا المستند فوراً.</p>`;
    return modal({
      title: 'تأكيد الحذف النهائي',
      danger: true,
      body,
      actions: [
        { label: 'حذف نهائي وعكس المخزون', value: 'yes', kind: 'btn-danger', icon: 'i-trash' },
        { label: 'إلغاء', value: 'cancel', kind: 'btn-ghost' }
      ]
    });
  }

  /* ---------------- the signature footer (SamSignatures) ----------------
     Every printed document gets its signature footer from ONE system:
     the presets of the document kind (SamSignatures.SIGN_PRESETS) and
     the user's own choice for that kind. A print call may still pass
     an explicit array — that array is then the STARTING set of the
     print, and the user can change it in the preview.

     The module is loaded from here when the page does not include it,
     so the system works even before the <script> line is added to
     app.html. Everything below reads it lazily, never at load time. */
  function ensureSignatures() {
    if (global.SamSignatures || global.__samSignaturesLoading) return;
    global.__samSignaturesLoading = true;
    try {
      const s = document.createElement('script');
      s.src = 'js/signatures.js';
      s.onload = () => { global.__samSignaturesLoading = false; };
      s.onerror = () => { global.__samSignaturesLoading = false; };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      global.__samSignaturesLoading = false;
    }
  }
  ensureSignatures();

  /** the names of the signature footer of a sheet (a plain array) */
  function sigNamesFor(o) {
    if (o && Array.isArray(o.__sigs)) return o.__sigs;
    const S = global.SamSignatures;
    const fallback = (o && Array.isArray(o.signatures)) ? o.signatures : [];
    if (!S) return fallback;
    try { return S.namesFor(o) || []; } catch (e) { return fallback; }
  }
  const sigLabel = (sig) => (typeof sig === 'string' ? sig : (sig && sig.label) || '');

  /** the kind of a print — the caller's `kind`, else what the pages say */
  function primarySigKind(opts, pages) {
    const S = global.SamSignatures;
    if (!S) return 'default';
    let k = '';
    try { k = S.resolveKind(opts) || ''; } catch (e) { k = ''; }
    if (k && k !== 'default') return k;
    const list = Array.isArray(pages) ? pages : [];
    for (let i = 0; i < list.length; i++) {
      let pk = '';
      try { pk = S.resolveKind(list[i]) || ''; } catch (e) { pk = ''; }
      if (pk && pk !== 'default') return pk;
    }
    return k || 'default';
  }

  /* the signature band — the markup never changes, only the names in it */
  function sigBandHtml(o) {
    const list = sigNamesFor(o);
    if (!list || !list.length) return '';
    return `<div class="sig-band">
      ${list.map((sig) => {
        const label = sigLabel(sig);
        return `<div class="sig"><div class="line"></div><div class="nm">${esc(label)}</div><div class="sp">التوقيع</div><div class="line" style="height:6mm;border-bottom-style:dotted"></div></div>`;
      }).join('')}
    </div>`;
  }

  /* ---------------- print sheet (premium A4 layout) ---------------- */
  function sheet(o) {
    const s = el('section', `sheet${o.landscape ? ' landscape' : ''}${o.half ? ' half' : ''}`);
    const now = new Date().toLocaleString('ar-EG-u-nu-latn');
    const meta = o.head || [];
    s.innerHTML = `
      <div class="wm"><span>${esc(WATERMARK)}</span></div>
      <header class="doc-mast">
        <div class="m-side">
          <div><b>SAM</b> — 775158678</div>
          <div>${esc(o.orgLine || 'نظام إدارة الأصناف والمخازن والإنتاج')}</div>
        </div>
        <div class="m-brand">
          <div class="b-name">SAM</div>
          <div class="b-sub">${esc(o.brandLine || 'إدارة المخزون والإنتاج')}</div>
        </div>
        <div class="m-side right">
          <div>${esc(o.docRefLabel || 'رقم المستند')}: <b>${esc(o.docRef || '')}</b></div>
          <div>التاريخ: ${esc(o.printDate || now)}</div>
        </div>
      </header>

      <div class="doc-title">
        <h1>${esc(o.title || '')}</h1>
        ${o.subtitle ? `<div class="t-sub">${esc(o.subtitle)}</div>` : ''}
      </div>

      ${meta.length ? `<div class="doc-meta">
        ${meta.map((h) => `<div class="m-item"><span class="m-k">${esc(h.k)}</span><span>${esc(h.v)}</span></div>`).join('')}
      </div>` : ''}

      <div class="doc-body ${o.dense ? 'dense' : ''}">${o.bodyHtml || ''}</div>

      ${sigBandHtml(o)}

      <footer class="doc-foot">
        <span>${esc(o.footer || `${APP_NAME} — ${WATERMARK}`)}</span>
        <span class="f-left">تم الطباعة ${esc(now)}</span>
      </footer>`;
    return s;
  }

  function tableHtml(cols, rows, totals) {
    const th = cols.map((c) => `<th style="${c.align === 'start' ? 'text-align:right' : c.align === 'end' ? 'text-align:left' : c.align === 'center' ? 'text-align:center' : ''}">${esc(c.label)}</th>`).join('');
    const tr = rows.map((r) => `<tr>${cols.map((c) => `<td style="${c.align === 'end' ? 'text-align:left' : c.align === 'center' ? 'text-align:center' : ''}">${esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    const tot = totals
      ? `<tr class="tot-row"><td colspan="${cols.length - 1}">الإجمالي</td><td style="text-align:left">${esc(totals)}</td></tr>`
      : '';
    return `<table class="tbl" style="font-size:10pt">
      <thead><tr>${th}</tr></thead><tbody>${tr}${tot}</tbody></table>`;
  }

  /* ---------------- print preview ---------------- */
  function printPreview(opts) {
    /* opts.pages = array of sheet options → one printed page per entry
       (used for per-warehouse gate/transfer permits). Otherwise a single sheet.
       opts.half = true → every sheet is half an A4 (A5 landscape); two of them
       share one physical A4 page, so the paper can be cut in half and each
       half still carries a complete permit.
       The preview shows the real paper: a white sheet on a desk, with the
       page number and the paper size, exactly as it will be printed. */
    opts = opts || {};
    const pages = (Array.isArray(opts.pages) && opts.pages.length) ? opts.pages : [opts];
    const half = !!opts.half;
    const land = !!opts.landscape;

    /* ---- the signature footer of THIS print ----------------------------
       The names come from the system: the user's own choice for the kind
       of the document, else the array the caller passed (that array is
       the starting set), else the preset of the kind. The user can
       change the set in the row of chips under the toolbar — the change
       shows in the paper at once and is remembered for the next print
       of the same kind. */
    const S = global.SamSignatures;
    const sigKind = primarySigKind(opts, pages);
    const explicitSigs = Array.isArray(opts.signatures) ? opts.signatures
      : (pages[0] && Array.isArray(pages[0].signatures) ? pages[0].signatures : null);
    let sigSet = [];
    let sigPool = [];
    try {
      if (S) {
        sigSet = S.hasSignatureChoice(sigKind) ? S.signaturesFor(sigKind)
          : (explicitSigs || S.presetFor(sigKind));
        sigPool = Array.from(new Set([...S.presetFor(sigKind), ...sigSet]));
      } else {
        sigSet = explicitSigs || [];
        sigPool = sigSet.slice();
      }
      sigSet = (sigSet || []).map(sigLabel).filter(Boolean);
    } catch (e) {
      sigSet = (explicitSigs || []).map(sigLabel).filter(Boolean);
      sigPool = sigSet.slice();
    }

    /* group the sheets into physical A4 pages */
    const groupCount = half ? Math.ceil(pages.length / 2) : pages.length;

    const buildPreview = () => {
      const groups = [];
      if (half) {
        for (let i = 0; i < pages.length; i += 2) groups.push(pages.slice(i, i + 2));
      } else {
        pages.forEach((p) => groups.push([p]));
      }

      const built = el('div', 'pv-pages');
      groups.forEach((grp, gi) => {
        const frame = el('div', `pv-frame${land ? ' land' : ''}`);
        const cap = el('div', 'pv-cap');
        cap.innerHTML = `<b>صفحة ${gi + 1}</b> من ${groups.length} — ${land ? 'A4 عرضي' : 'A4'}` +
          (half ? ' — تصريحان بنصف ورقة' : '');
        frame.appendChild(cap);

        const page = el('div', `print-page${half ? ' perm' : ''}${land ? ' land' : ''}`);
        grp.forEach((p, i) => {
          if (half && i > 0) {
            const cut = el('div', 'pv-cut', '<span>خط القص</span>');
            page.appendChild(cut);
          }
          page.appendChild(sheet({
            ...p,
            half: half || !!p.half,
            landscape: land || !!p.landscape,
            __sigs: sigSet
          }));
        });
        frame.appendChild(page);
        built.appendChild(frame);
      });
      return built;
    };

    let built = buildPreview();

    const pageCount = groupCount;
    return new Promise((resolve) => {
      const ov = el('div', 'pv no-print');
      const bar = el('div', 'pv-bar');
      bar.innerHTML = `<span class="t">معاينة قبل الطباعة</span>
        <span class="pv-note">${esc(opts.title || '')} — ${land ? 'A4 عرضي' : 'A4'}${pageCount > 1 ? ` — ${pageCount} صفحات` : ''}</span>
        <span class="pv-fidelity" title="المعاينة بمقاس الورقة الحقيقي — ما تراه هنا هو ما سيُطبع">مطابق للمطبوع</span>`;

      /* zoom: the preview is scaled to fit the window, and the user can
         zoom in/out to check every detail before printing */
      const zoom = el('div', 'pv-zoom');
      const zOut = el('button', '', '−');
      const zVal = el('span', 'pv-zv', '100%');
      const zIn = el('button', '', '+');
      const zFit = el('button', '', 'ملاءمة');
      zOut.type = zIn.type = zFit.type = 'button';
      zOut.title = 'تصغير'; zIn.title = 'تكبير'; zFit.title = 'ملاءمة العرض';
      zoom.append(zOut, zVal, zIn, zFit);

      const bPdf = el('button', 'btn btn-sm btn-ghost', `${iconTile('i-print', 'tone-info', 'xs')}<span class="btn-txt">حفظ PDF</span>`);
      const bPrint = el('button', 'btn btn-sm btn-primary', `${iconTile('i-print', 'tone-plain', 'xs')}<span class="btn-txt">طباعة</span><span class="kbd">Ctrl+P</span>`);
      const bClose = el('button', 'btn btn-sm btn-ghost', `${iconTile('i-x', 'tone-plain', 'xs')}<span class="btn-txt">إغلاق</span>`);
      bar.append(zoom, bPrint, bPdf, bClose);

      /* ---- the signature controls ------------------------------------
         One chip per name of the footer: tap it to take the name out of
         the paper, tap it again to put it back. The «+» takes a name of
         its own, and «رجوع للافتراضي» brings the preset of the kind
         back. Every change shows in the paper at once. */
      const sigRow = el('div', 'pv-sigs no-print');
      sigRow.setAttribute('style', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 13px;background:var(--surface);border-bottom:1px solid var(--line);');
      const sigTitle = el('span', 'pv-sigs-title', 'تذييل التوقيع:');
      sigTitle.setAttribute('style', 'font-weight:800;font-size:12px;color:var(--ink);white-space:nowrap;');
      const sigChips = el('span', 'pv-sig-chips');
      sigChips.setAttribute('style', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;');
      const sigEmpty = el('span', 'pv-sigs-empty', 'لا يوجد تذييل توقيع — التقارير لا تُوقّع');
      sigEmpty.setAttribute('style', 'font-size:11px;color:var(--muted-fg);');
      sigEmpty.style.display = 'none';

      const sigAddBtn = el('button', 'pv-sig-add', '+');
      sigAddBtn.type = 'button';
      sigAddBtn.title = 'إضافة اسم توقيع';
      sigAddBtn.setAttribute('style', 'width:26px;height:26px;min-width:26px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:15px;font-weight:900;line-height:1;cursor:pointer;');
      const sigAddInput = el('input', 'pv-sig-input');
      sigAddInput.type = 'text';
      sigAddInput.placeholder = 'اسم التوقيع';
      sigAddInput.setAttribute('style', 'display:none;width:140px;padding:4px 9px;border:1px solid var(--brand-300);border-radius:8px;background:var(--surface);color:var(--ink);font-size:12px;');
      const sigReset = el('button', 'btn btn-sm btn-ghost pv-sig-reset', '<span class="btn-txt">رجوع للافتراضي</span>');
      sigReset.type = 'button';
      const sigHint = el('span', 'pv-sigs-hint', 'اضغط على الاسم لإزالته من التذييل — واضغط مرة أخرى لإعادته');
      sigHint.setAttribute('style', 'margin-inline-start:auto;font-size:11px;color:var(--muted-fg);');

      sigRow.append(sigTitle, sigChips, sigEmpty, sigAddBtn, sigAddInput, sigReset, sigHint);

      const scroll = el('div', 'pv-scroll');
      scroll.appendChild(built);
      ov.append(bar, sigRow, scroll);
      document.body.appendChild(ov);

      /* A half sheet has a fixed height — if the permit has many lines the
         block shrinks one step, so nothing is ever cut off the paper. */
      const fitHalves = () => {
        built.querySelectorAll('.sheet.half').forEach((s) => {
          s.classList.remove('tight');
          if (s.scrollHeight > s.clientHeight + 2) s.classList.add('tight');
        });
      };
      fitHalves();

      /* The preview must be honest: it shows the REAL paper, so the user
         sees exactly what the printer will deliver. When the content does
         not fit the sheet, the preview says so instead of quietly cutting
         a corner off. */
      const MM = 96 / 25.4;
      const markOverflow = () => {
        const overflowing = [];
        built.querySelectorAll('.print-page').forEach((p, i) => {
          const paperMm = p.classList.contains('land') ? 210 : 297;
          const used = [...p.querySelectorAll('.sheet')].reduce((a, s) => a + s.offsetHeight, 0);
          if (used > paperMm * MM + 2) overflowing.push(i + 1);
        });
        if (overflowing.length) {
          built.querySelectorAll('.pv-frame').forEach((f, i) => {
            if (!overflowing.includes(i + 1)) return;
            const cap = f.querySelector('.pv-cap');
            if (cap) cap.insertAdjacentHTML('beforeend', ' — <b class="over">⚠ المحتوى يتجاوز الورقة</b>');
          });
        }
      };
      markOverflow();

      let zoomPct = 100;
      let fitMode = true;
      const applyZoom = () => {
        built.style.transformOrigin = 'top center';
        built.style.transform = `scale(${zoomPct / 100})`;
        zVal.textContent = `${zoomPct}%`;
      };
      const fit = () => {
        if (!fitMode) return;
        const avail = scroll.clientWidth - 56;
        const natural = (built.querySelector('.print-page') || built.querySelector('.sheet') || built).offsetWidth || 794;
        zoomPct = Math.max(30, Math.min(150, Math.round((avail / natural) * 100)));
        applyZoom();
      };
      fit();
      global.addEventListener('resize', fit);

      /* the paper is rebuilt when the signature footer changes */
      function rebuild() {
        const next = buildPreview();
        scroll.innerHTML = '';
        scroll.appendChild(next);
        built = next;
        fitHalves();
        markOverflow();
        applyZoom();
        fit();
      }

      /* ---- the chips of the signature footer ---- */
      const chipOn = 'display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:999px;border:1px solid var(--brand-700);background:var(--brand-700);color:#fff;font-size:12px;font-weight:800;cursor:pointer;';
      const chipOff = 'display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--muted-fg);font-size:12px;font-weight:700;cursor:pointer;text-decoration:line-through;';

      const remember = () => {
        if (!S) return;
        try { S.setSignatureChoice(sigKind, sigSet); } catch (e) { /* the print must not break */ }
      };

      const renderChips = () => {
        sigChips.innerHTML = '';
        sigPool.forEach((name) => {
          const on = sigSet.indexOf(name) >= 0;
          const b = el('button', 'pv-sig-chip');
          b.type = 'button';
          b.dataset.name = name;
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.title = on ? 'اضغط لإزالة هذا التوقيع من التذييل' : 'اضغط لإضافة هذا التوقيع إلى التذييل';
          b.style.cssText = on ? chipOn : chipOff;
          b.innerHTML = `<span>${esc(name)}</span>`;
          b.addEventListener('click', () => {
            const i = sigSet.indexOf(name);
            if (i >= 0) sigSet.splice(i, 1); else sigSet.push(name);
            remember();
            renderChips();
            rebuild();
          });
          sigChips.appendChild(b);
        });
        sigEmpty.style.display = sigPool.length ? 'none' : 'inline';
      };

      const closeAdd = () => { sigAddInput.value = ''; sigAddInput.style.display = 'none'; };
      const commitAdd = () => {
        const name = (sigAddInput.value || '').trim();
        closeAdd();
        if (!name) return;
        if (sigPool.indexOf(name) < 0) sigPool.push(name);
        if (sigSet.indexOf(name) < 0) sigSet.push(name);
        remember();
        renderChips();
        rebuild();
      };

      sigAddBtn.addEventListener('click', () => {
        sigAddInput.style.display = 'inline-block';
        sigAddInput.focus();
      });
      sigAddInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
        if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
      });
      sigAddInput.addEventListener('blur', () => {
        if ((sigAddInput.value || '').trim()) commitAdd(); else closeAdd();
      });

      sigReset.addEventListener('click', () => {
        const preset = S ? S.presetFor(sigKind) : [];
        if (S) {
          try {
            /* the choice of the user is forgotten, and the default of the
               kind is pinned — so the next print of this kind shows it
               too, whatever the old print call passed */
            S.resetSignatureChoice(sigKind);
            S.setSignatureChoice(sigKind, preset);
          } catch (e) { /* the print must not break */ }
        }
        sigSet = preset.slice();
        sigPool = Array.from(new Set([...preset, ...sigPool]));
        renderChips();
        rebuild();
      });

      renderChips();

      zIn.addEventListener('click', () => { fitMode = false; zoomPct = Math.min(150, zoomPct + 10); applyZoom(); });
      zOut.addEventListener('click', () => { fitMode = false; zoomPct = Math.max(30, zoomPct - 10); applyZoom(); });
      zFit.addEventListener('click', () => { fitMode = true; fit(); });

      let pop = null;
      const close = () => {
        global.removeEventListener('resize', fit);
        if (pop) pop();
        ov.remove();
        resolve(false);
      };
      const doPrintNow = async () => { await doPrint(built, { landscape: land }); };
      pop = pushKeys({ save: null, print: doPrintNow });
      bClose.addEventListener('click', close);
      bPrint.addEventListener('click', doPrintNow);
      bPdf.addEventListener('click', async () => {
        /* the PDF is captured from the live page, so the document must be
           staged in the print host first — same path as the printer. */
        const release = stageForPrint(built);
        if (!release) return toast('تعذّر تجهيز الملف للطباعة', 'bad');
        try {
          const r = await global.sam.win.savePdf({
            landscape: land,
            fileName: `${opts.title || 'SAM'}${pageCount > 1 ? `-${pageCount} صفحات` : ''}.pdf`
          });
          if (r && r.ok) toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200);
          else if (r && !r.canceled) toast('تعذّر حفظ الـ PDF', 'bad');
        } finally {
          release();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        /* the name being typed has the first right on the Escape key */
        if (sigAddInput.style.display !== 'none') { closeAdd(); return; }
        close();
      }, true);
    });
  }

  /** stage the document in the print host so print / PDF capture only the sheet.
      returns a release function that restores the page. */
  function stageForPrint(node) {
    const host = document.getElementById('printHost');
    if (!host) return null;
    const clone = node.cloneNode(true);
    /* the preview scales the sheet to fit the window — that must not follow
       the document into the printed output */
    clone.style.transform = '';
    host.innerHTML = '';
    host.appendChild(clone);
    document.body.classList.add('is-printing');
    return () => {
      document.body.classList.remove('is-printing');
      host.innerHTML = '';
    };
  }

  /** export a sheet straight to a PDF file — no preview, the app asks where */
  async function exportPdf(node, opts = {}) {
    const release = stageForPrint(node);
    if (!release) return { ok: false, error: 'تعذّر تجهيز الملف للطباعة' };
    try {
      return await global.sam.win.savePdf({
        landscape: !!opts.landscape,
        fileName: opts.fileName || `SAM-${global.WATERMARK}.pdf`
      });
    } finally {
      release();
    }
  }

  /** print only the given sheet, hiding the whole app chrome */
  async function doPrint(node, opts = {}) {
    const release = stageForPrint(node);
    if (!release) return { ok: false };
    try {
      /* The paper comes from TWO places and both must agree:
         · the PDF path (printToPDF) reads the CSS page — print.css owns
           the @page rules, so the sheet comes out at the right size;
         · the printer path (webContents.print) does NOT read the CSS page
           at all — Chromium takes the paper from the print settings, so
           the orientation has to be passed here or a landscape sheet is
           printed on a portrait page and a quarter of it is cut off. */
      const printOpts = { landscape: !!opts.landscape, pageSize: 'A4' };
      if (opts.deviceName) printOpts.deviceName = opts.deviceName;
      if (opts.copies) printOpts.copies = opts.copies;
      const r = await global.sam.win.print(printOpts);
      if (r && !r.ok && r.error !== 'canceled') toast(r.error || 'الطباعة أُلغيت أو فشلت', 'bad');
      return r;
    } finally {
      setTimeout(release, 400);
    }
  }

  /* ---------------- data bus ---------------- */
  const listeners = [];
  const bus = {
    on(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
    emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }
  };

  /**
   * Form modal: keeps itself open when onSubmit() throws, and shows the
   * message inline — used by every add/edit screen in the app.
   */
  function form(opts) {
    const ov = el('div', 'overlay');
    const box = el('div', `modal ${opts.wide ? 'wide' : ''}`);
    box.appendChild(el('h3', '', esc(opts.title || '')));
    const bodyWrap = el('div', 'modal-body');
    bodyWrap.appendChild(opts.body);
    const errBar = el('div', 'form-err');
    bodyWrap.appendChild(errBar);
    box.appendChild(bodyWrap);

    const foot = el('div', 'modal-foot');
    const save = el('button', `btn ${opts.submitKind || 'btn-primary'}`, `${iconTile('i-check', 'tone-ok', 'xs')}<span class="btn-txt">${esc(opts.submitLabel || 'حفظ')}</span><span class="kbd">Ctrl+S</span>`);
    const cancel = el('button', 'btn btn-ghost', `<span class="btn-txt">${esc(opts.cancelLabel || 'إلغاء')}</span>`);
    foot.append(save, cancel);
    box.appendChild(foot);
    ov.appendChild(box);
    document.body.appendChild(ov);

    let done = false;
    let pop = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      if (pop) pop();
      ov.remove();
      opts.onClose && opts.onClose(val);
      resolve(val);
    };

    async function submit() {
      if (save.disabled) return;
      errBar.innerHTML = '';
      save.disabled = true;
      /* the plate is the first span of the button — the label has its own
         class, or the busy message would be written INTO the icon */
      const labelEl = save.querySelector('.btn-txt');
      const label = labelEl.textContent;
      labelEl.textContent = 'جارٍ الحفظ…';
      busy(true);
      try {
        const v = await opts.onSubmit();
        finish(v === undefined ? true : v);
      } catch (e) {
        errBar.innerHTML = `${iconTile('i-warn', 'tone-adjust', 'xs')}<span>${esc(e && e.message ? e.message : String(e))}</span>`;
        opts.onError && opts.onError(e);
      } finally {
        busy(false);
        save.disabled = false;
        labelEl.textContent = label;
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && !e.target.classList.contains('combo-input') && e.target.type !== 'date') {
        e.preventDefault();
        submit();
      }
    }

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    save.addEventListener('click', submit);
    cancel.addEventListener('click', () => finish(false));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(false); });
    document.addEventListener('keydown', onKey, true);
    pop = pushKeys({ save: submit });
    const first = box.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 60);
    return promise;
  }

  /**
   * labelled input block used inside form() bodies.
   * The optional icon is drawn INSIDE the label, on a fixed baseline, so
   * every field says what it is before you read the text.
   * @param {string} label
   * @param {HTMLElement} node
   * @param {string} [hint]
   * @param {string} [iconId] — a symbol id from the sprite (i-hash, i-user…)
   */
  function field(label, node, hint, iconId) {
    const f = el('label', 'field');
    const lab = el('span', 'field-label');
    if (iconId) lab.insertAdjacentHTML('afterbegin', plate('field-ic', iconId, null, 'xs'));
    lab.appendChild(el('span', 'field-txt', esc(label)));
    f.appendChild(lab);
    f.appendChild(node);
    if (hint) f.appendChild(el('em', 'hint-txt', esc(hint)));
    return f;
  }

  function input(attrs = {}) {
    const i = el('input', attrs.class || 'input');
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') return;
      if (k === 'value') i.value = v;
      else i.setAttribute(k, v);
    });
    return i;
  }

  /** quantity box: text under the hood so commas are legal, grouped on blur */
  function numInput(opts = {}) {
    const i = el('input', 'input num-in');
    i.type = 'text';
    i.placeholder = opts.placeholder || '0';
    if (opts.value != null && opts.value !== 0) i.value = groupNum(opts.value);
    if (opts.center) i.style.textAlign = 'center';
    makeNumInput(i, opts);
    return i;
  }

  /** money / quantity box with a unit label stuck on the end (e.g. ريال يمني) */
  function affixInput(i, unit) {
    const wrap = el('span', 'affix');
    wrap.appendChild(i);
    wrap.appendChild(el('span', 'affix-txt', esc(unit)));
    return wrap;
  }

  function textarea(attrs = {}) {
    const t = el('textarea', attrs.class || 'input');
    t.rows = attrs.rows || 3;
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class' || k === 'rows') return;
      if (k === 'value') t.value = v;
      else t.setAttribute(k, v);
    });
    return t;
  }

  /**
   * today's date in the LOCAL timezone (YYYY-MM-DD).
   * toISOString() returns UTC, which in Yemen (UTC+3) would give the
   * previous day after 21:00 — every default date must be local.
   */
  function today() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  global.SamUI = {
    WATERMARK,
    APP_NAME,
    CURRENCY,
    today,
    el, icon, esc, iconTile, plate, toneOf,
    toast, busy, emptyState, toggleEmpty, menu, bindRow, modal, confirmHardDelete, confirmWarning,
    form, field, input, textarea, numInput, affixInput,
    parseNum, groupNum, numValue, makeNumInput,
    pushKeys,
    sheet, tableHtml, printPreview, doPrint, exportPdf,
    bus
  };
})(window);
