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
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---------------- toasts (no blocking popups) ---------------- */
  const TOAST_ICON = { ok: 'i-check', bad: 'i-warn', warn: 'i-warn', info: 'i-bell' };
  function toast(msg, kind, ms = 3200) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const k = kind || 'info';
    const t = el('div', `toast ${k}`, `${icon(TOAST_ICON[k] || 'i-bell')}<span>${esc(msg)}</span>`);
    host.appendChild(t);
    const kill = () => {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 320);
    };
    t.addEventListener('click', kill);
    setTimeout(kill, ms);
    // never stack more than four
    while (host.children.length > 4) host.firstElementChild.remove();
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
      <span class="e-ic">${icon(o.icon || 'i-inbox')}</span>
      <span class="e-title">${esc(o.title || 'لا توجد بيانات')}</span>
      ${o.hint ? `<span class="e-hint">${esc(o.hint)}</span>` : ''}
      ${o.actionLabel ? `<button class="btn btn-primary btn-sm" type="button">${icon('i-plus')}<span>${esc(o.actionLabel)}</span></button>` : ''}`;
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
      row.innerHTML = `${it.icon ? icon(it.icon) : '<span style="width:16px"></span>'}<span>${esc(it.label)}</span>`;
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
        const btn = el('button', `btn ${a.kind || 'btn-ghost'}`, `${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span>`);
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
          ${icon('i-warn')}
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
        ${icon('i-warn')}
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

  /* ---------------- print sheet (premium A4 layout) ---------------- */
  function sheet(o) {
    const s = el('section', `sheet ${o.landscape ? 'landscape' : ''}`);
    const now = new Date().toLocaleString('ar-EG-u-nu-latn');
    const meta = o.head || [];
    s.innerHTML = `
      <div class="wm">${esc(WATERMARK)}</div>
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

      ${o.signatures && o.signatures.length ? `<div class="sig-band">
        ${o.signatures.map((sig) => {
          const label = typeof sig === 'string' ? sig : sig.label;
          return `<div class="sig"><div class="line"></div><div class="nm">${esc(label)}</div><div class="sp">التوقيع</div><div class="line" style="height:6mm;border-bottom-style:dotted"></div></div>`;
        }).join('')}
      </div>` : ''}

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
    const built = sheet(opts);
    return new Promise((resolve) => {
      const ov = el('div', 'pv no-print');
      const bar = el('div', 'pv-bar');
      bar.innerHTML = `<span class="t">معاينة قبل الطباعة</span>
        <span class="pv-note">${esc(opts.title || '')} — ${opts.landscape ? 'A4 عرضي' : 'A4'} — علامة مائية خفيفة</span>`;
      const bPdf = el('button', 'btn btn-sm btn-ghost', `${icon('i-print')}<span>حفظ PDF</span>`);
      const bPrint = el('button', 'btn btn-sm btn-primary', `${icon('i-print')}<span>طباعة</span><span class="kbd">Ctrl+P</span>`);
      const bClose = el('button', 'btn btn-sm btn-ghost', `${icon('i-x')}<span>إغلاق</span>`);
      bar.append(bPrint, bPdf, bClose);

      const scroll = el('div', 'pv-scroll');
      scroll.appendChild(built);
      ov.append(bar, scroll);
      document.body.appendChild(ov);

      const fit = () => {
        const avail = scroll.clientWidth - 60;
        const natural = built.offsetWidth || 794;
        built.style.transform = `scale(${Math.min(1, Math.max(0.4, avail / natural))})`;
      };
      fit();
      global.addEventListener('resize', fit);

      let pop = null;
      const close = () => {
        global.removeEventListener('resize', fit);
        if (pop) pop();
        ov.remove();
        resolve(false);
      };
      const doPrintNow = async () => { await doPrint(built, opts.landscape ? { landscape: true } : {}); };
      pop = pushKeys({ save: null, print: doPrintNow });
      bClose.addEventListener('click', close);
      bPrint.addEventListener('click', doPrintNow);
      bPdf.addEventListener('click', async () => {
        const r = await global.sam.win.savePdf({ landscape: !!opts.landscape, fileName: `${opts.title || 'SAM'}.pdf` });
        if (r && r.ok) toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200);
        else if (r && !r.canceled) toast('تعذّر حفظ الـ PDF', 'bad');
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
    });
  }

  /** print only the given sheet, hiding the whole app chrome */
  async function doPrint(node, opts = {}) {
    const host = document.getElementById('printHost');
    if (!host) return { ok: false };
    const clone = node.cloneNode(true);
    host.innerHTML = '';
    host.appendChild(clone);
    document.body.classList.add('is-printing');
    try {
      const printOpts = opts.landscape
        ? { pageSize: { width: 29700, height: 21000 } }
        : {};
      const r = await global.sam.win.print(printOpts);
      if (r && !r.ok && r.error !== 'canceled') toast('الطباعة أُلغيت أو فشلت', 'bad');
      return r;
    } finally {
      document.body.classList.remove('is-printing');
      setTimeout(() => { host.innerHTML = ''; }, 400);
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
    const save = el('button', `btn ${opts.submitKind || 'btn-primary'}`, `${icon('i-check')}<span>${esc(opts.submitLabel || 'حفظ')}</span><span class="kbd">Ctrl+S</span>`);
    const cancel = el('button', 'btn btn-ghost', `<span>${esc(opts.cancelLabel || 'إلغاء')}</span>`);
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
      const label = save.querySelector('span').textContent;
      save.querySelector('span').textContent = 'جارٍ الحفظ…';
      busy(true);
      try {
        const v = await opts.onSubmit();
        finish(v === undefined ? true : v);
      } catch (e) {
        errBar.innerHTML = `${icon('i-warn')}<span>${esc(e && e.message ? e.message : String(e))}</span>`;
        opts.onError && opts.onError(e);
      } finally {
        busy(false);
        save.disabled = false;
        save.querySelector('span').textContent = label;
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

  /** labelled input block used inside form() bodies */
  function field(label, node, hint) {
    const f = el('label', 'field');
    f.appendChild(el('span', '', esc(label)));
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

  global.SamUI = {
    WATERMARK,
    APP_NAME,
    CURRENCY,
    el, icon, esc,
    toast, busy, emptyState, toggleEmpty, menu, bindRow, modal, confirmHardDelete, confirmWarning,
    form, field, input, textarea, numInput, affixInput,
    parseNum, groupNum, numValue, makeNumInput,
    pushKeys,
    sheet, tableHtml, printPreview, doPrint,
    bus
  };
})(window);
