/* =====================================================================
   SamUI — shared building blocks used across every screen:
   toasts, right-click menus, modals, hard-delete warning,
   A4 print sheet with watermark + print preview.
   ===================================================================== */
(function (global) {
  'use strict';

  const WATERMARK = 'SAM 775158678';
  const APP_NAME = 'SAM Management System';

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

  /* ---------------- toasts ---------------- */
  function toast(msg, kind, ms = 3200) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const t = el('div', `toast ${kind || ''}`, `<span>${esc(msg)}</span>`);
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 320);
    }, ms);
  }

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

  /* ---------------- modal ---------------- */
  function modal(opts) {
    const {
      title = '',
      body = '',
      actions = [{ label: 'إغلاق', value: 'close', kind: 'btn-ghost' }],
      danger = false,
      width = null
    } = opts || {};

    return new Promise((resolve) => {
      const ov = el('div', 'overlay');
      const box = el('div', `modal ${danger ? 'danger' : ''}`);
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

      function done(val) {
        ov.remove();
        document.removeEventListener('keydown', onEsc, true);
        resolve(val);
      }
      function onEsc(e) { if (e.key === 'Escape') done('cancel'); }
      document.addEventListener('keydown', onEsc, true);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done('cancel'); });
      const first = foot.querySelector('.btn-primary, .btn-gold, .btn-danger') || foot.lastChild;
      if (first) first.focus();
    });
  }

  /**
   * Hard-delete confirmation: explains exactly what will happen to stock,
   * then the caller physically deletes the document and reverts quantities.
   */
  function confirmHardDelete({ docNo = '', docType = '', lines = [], extra = '' }) {
    const rows = lines.length
      ? `<table class="tbl" style="margin-top:10px">
           <thead><tr><th>الصنف</th><th>المخزن</th><th>الحركة</th><th>الكمية (حبة)</th></tr></thead>
           <tbody>${lines.map((l) => `<tr>
             <td>${esc(l.item)}</td><td>${esc(l.wh)}</td>
             <td>${esc(l.dir)}</td>
             <td style="font-weight:800;color:${l.dir === 'زيادة' ? 'var(--ok)' : 'var(--bad)'}">${esc(l.qty)}</td>
           </tr>`).join('')}</tbody></table>`
      : '';
    const body = `
      <div style="display:flex;gap:12px;align-items:center;background:var(--bad-bg);padding:12px 14px;border-radius:12px;border:1px solid #f3c4bd">
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

  /* ---------------- A4 sheet ---------------- */
  function sheet(o) {
    const s = el('section', `sheet ${o.landscape ? 'landscape' : ''}`);
    s.innerHTML = `
      <div class="wm">${esc(WATERMARK)}</div>
      <header class="doc-head">
        <div>
          <div style="font-family:var(--font-display);font-size:19pt;font-weight:800;color:#1e3a8a">SAM</div>
          <div style="font-size:10pt;color:#4a5b7c">نظام إدارة الأصناف والمخازن والإنتاج</div>
          <div style="font-size:10pt;color:#4a5b7c;margin-top:2px">775158678</div>
        </div>
        <div style="text-align:center">
          <div style="font-family:var(--font-display);font-size:16pt;font-weight:800">${esc(o.title || '')}</div>
          <div style="font-size:9.5pt;color:#4a5b7c;margin-top:2px">${esc(o.subtitle || '')}</div>
        </div>
        <div style="text-align:left;font-size:9.5pt;color:#25355c;line-height:1.9">
          ${o.head ? o.head.map((h) => `<div><b>${esc(h.k)}:</b> ${esc(h.v)}</div>`).join('') : ''}
        </div>
      </header>
      <div class="${o.dense ? 'dense' : ''}" style="margin-top:6mm">${o.bodyHtml || ''}</div>
      <footer class="doc-foot">
        ${esc(o.footer || `تم الطباعة بواسطة ${APP_NAME} — ${WATERMARK}`)}
        <br>${esc(new Date().toLocaleString('ar-EG-u-nu-latn'))}
      </footer>
      ${o.signatures ? `<div class="doc-foot" style="inset-inline-start:auto"><div class="sig-row">
        ${o.signatures.map((s2) => `<div style="text-align:center"><div style="border-bottom:1px solid #333;width:38mm;margin-bottom:3mm">&nbsp;</div>${esc(s2)}</div>`).join('')}
      </div></div>` : ''}
    `;
    return s;
  }

  function tableHtml(cols, rows, totals) {
    const th = cols.map((c) => `<th style="${c.align === 'start' ? 'text-align:right' : c.align === 'end' ? 'text-align:left' : ''}">${esc(c.label)}</th>`).join('');
    const tr = rows.map((r) => `<tr>${cols.map((c) => `<td style="${c.align === 'end' ? 'text-align:left' : ''}">${esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    const tot = totals ? `<tr style="font-weight:800;background:#eef3fb"><td colspan="${cols.length - 1}">الإجمالي</td><td style="text-align:left">${esc(totals)}</td></tr>` : '';
    return `<table class="tbl" style="font-size:10pt;border:1px solid #c9d6ee">
      <thead><tr>${th}</tr></thead><tbody>${tr}${tot}</tbody></table>`;
  }

  /* ---------------- print preview ---------------- */
  function printPreview(opts) {
    const built = sheet(opts);
    return new Promise((resolve) => {
      const ov = el('div', 'pv no-print');
      const bar = el('div', 'pv-bar');
      bar.innerHTML = `<span class="t">معاينة قبل الطباعة</span>
        <span class="pv-note">${esc(opts.title || '')} — A4 — علامة مائية في المنتصف</span>`;
      const bPdf = el('button', 'btn btn-sm btn-ghost', `${icon('i-print')}<span>حفظ PDF</span>`);
      const bXls = el('button', 'btn btn-sm btn-ghost', '<span>تصدير Excel</span>');
      bXls.disabled = true;
      bXls.title = 'متاح مع مركز التقارير في المرحلة 5';
      const bPrint = el('button', 'btn btn-sm btn-gold', `${icon('i-print')}<span>طباعة</span>`);
      const bClose = el('button', 'btn btn-sm btn-ghost', `${icon('i-x')}<span>إغلاق</span>`);
      bar.append(bPrint, bPdf, bXls, bClose);

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

      const close = () => {
        global.removeEventListener('resize', fit);
        ov.remove();
        resolve(false);
      };
      bClose.addEventListener('click', close);
      bPrint.addEventListener('click', async () => {
        await doPrint(built, opts.landscape ? { landscape: true } : {});
      });
      bPdf.addEventListener('click', async () => {
        const r = await global.sam.win.savePdf({ landscape: !!opts.landscape, fileName: `${opts.title || 'SAM'}.pdf` });
        if (r && r.ok) toast(`تم حفظ الملف: ${r.path}`, 'ok', 5200);
        else if (r && !r.canceled) toast('تعذّر حفظ الـ PDF', 'bad');
      });
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
    on(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
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
    const save = el('button', `btn ${opts.submitKind || 'btn-gold'}`, `${icon('i-check')}<span>${esc(opts.submitLabel || 'حفظ')}</span>`);
    const cancel = el('button', 'btn btn-ghost', `<span>${esc(opts.cancelLabel || 'إلغاء')}</span>`);
    foot.append(save, cancel);
    box.appendChild(foot);
    ov.appendChild(box);
    document.body.appendChild(ov);

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      opts.onClose && opts.onClose(val);
      resolve(val);
    };

    async function submit() {
      errBar.innerHTML = '';
      save.disabled = true;
      const label = save.querySelector('span').textContent;
      save.querySelector('span').textContent = 'جارٍ الحفظ…';
      try {
        const v = await opts.onSubmit();
        finish(v === undefined ? true : v);
      } catch (e) {
        errBar.innerHTML = `${icon('i-warn')}<span>${esc(e && e.message ? e.message : String(e))}</span>`;
        opts.onError && opts.onError(e);
      } finally {
        save.disabled = false;
        save.querySelector('span').textContent = label;
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && !e.target.classList.contains('combo-input')) {
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
    el, icon, esc,
    toast, menu, bindRow, modal, confirmHardDelete,
    form, field, input, textarea,
    sheet, tableHtml, printPreview, doPrint,
    bus
  };
})(window);
