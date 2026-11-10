'use strict';

/* =====================================================================
   نافذة التقارير — the shell every report opens in.
     · the ready-made reports live in a rail on the left (icon + title
       + what the report answers)
     · the owner paints the content (filters + preview) on the right
     · one action bar at the bottom: Excel · Print · PDF · Close
   The shell knows nothing about data — the owner (reports.js / daily.js)
   supplies the rail, the content and the buttons.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, pushKeys } = SamUI;

  let current = null;

  /**
   * open(opts)
   *   title     — عنوان النافذة
   *   subtitle  — سطر صغير تحته
   *   icon      — أيقونة العنوان
   *   reports   — [{key,title,hint,icon}] — قائمة التقارير الجاهزة
   *   active    — مفتاح التقرير المفتوح أولاً
   *   onPick(key, api) → Promise<data> — يحمّل صاحب النافذة البيانات
   *   render(api) → Node — يرسم المحتوى (الفلاتر + المعاينة)
   *   actions(api) → [{label,icon,kind,onClick}] — أزرار الأسفل
   *   onClose()
   */
  function open(opts = {}) {
    if (current) current.close();

    const ov = el('div', 'overlay rw-overlay');
    const box = el('div', 'rw-window');

    /* ---------------- header ---------------- */
    const head = el('div', 'rw-head');
    head.innerHTML = `
      <span class="rw-badge">${icon(opts.icon || 'i-chart')}</span>
      <div class="rw-txt">
        <h3>${esc(opts.title || 'التقارير')}</h3>
        <span class="rw-sub">${esc(opts.subtitle || '')}</span>
      </div>`;
    const xBtn = el('button', 'rw-x', icon('i-x'));
    xBtn.type = 'button';
    xBtn.title = 'إغلاق النافذة';
    head.appendChild(xBtn);
    box.appendChild(head);

    /* ---------------- body: content on the right, rail on the left ---------------- */
    const body = el('div', 'rw-body');
    const content = el('div', 'rw-content');
    const rail = el('div', 'rw-rail');
    /* a window without a report list (the daily report) has no rail at all */
    if (!opts.reports || !opts.reports.length) {
      rail.style.display = 'none';
      body.style.gridTemplateColumns = '1fr';
    }
    body.append(content, rail);
    box.appendChild(body);

    /* ---------------- action bar ---------------- */
    const foot = el('div', 'rw-foot');
    const actWrap = el('div', 'rw-actions');
    foot.appendChild(actWrap);
    box.appendChild(foot);

    ov.appendChild(box);
    document.body.appendChild(ov);

    let pop = null;
    const api = {
      overlay: ov,
      content,
      rail,
      actions: actWrap,
      data: null,
      activeKey: null,
      pick,
      close: closeWin
    };

    /* the rail: one card per ready-made report */
    function setRail(items, activeKey) {
      rail.innerHTML = '';
      (items || []).forEach((r) => {
        const b = el('button', `rw-item${r.key === activeKey ? ' on' : ''}`);
        b.type = 'button';
        b.dataset.key = r.key;
        b.innerHTML = `<span class="rw-ic">${icon(r.icon || 'i-chart')}</span>
          <span class="rw-t"><b>${esc(r.title)}</b><i>${esc(r.hint || '')}</i></span>`;
        b.addEventListener('click', () => pick(r.key));
        rail.appendChild(b);
      });
    }

    /** load a report and repaint the window */
    async function pick(key) {
      api.activeKey = key;
      [...rail.children].forEach((n) => n.classList.toggle('on', n.dataset.key === key));
      if (opts.onPick) {
        try {
          api.data = await opts.onPick(key, api);
        } catch (e) {
          api.data = null;
          toast(e && e.message ? e.message : String(e), 'bad');
        }
      }
      paint();
      return api.data;
    }

    /** repaint the content and the action bar */
    function paint() {
      content.innerHTML = '';
      const node = opts.render ? opts.render(api) : null;
      if (node) content.appendChild(node);
      actWrap.innerHTML = '';
      (opts.actions ? opts.actions(api) : []).forEach((a) => {
        const btn = el('button', `btn ${a.kind || 'btn-ghost'}`);
        btn.type = 'button';
        btn.innerHTML = `${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span>`;
        btn.addEventListener('click', () => a.onClick && a.onClick(api));
        actWrap.appendChild(btn);
      });
    }

    function closeWin() {
      document.removeEventListener('keydown', onKey, true);
      if (pop) pop();
      ov.remove();
      if (current === api) current = null;
      opts.onClose && opts.onClose();
    }

    function onKey(e) { if (e.key === 'Escape') closeWin(); }

    xBtn.addEventListener('click', closeWin);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeWin(); });
    document.addEventListener('keydown', onKey, true);
    pop = pushKeys({ save: null, refresh: () => pick(api.activeKey) });

    current = api;
    if (opts.reports) setRail(opts.reports, opts.active);
    if (opts.active) pick(opts.active); else paint();
    return api;
  }

  function close() { if (current) current.close(); }

  window.SamReportWindow = {
    open,
    close,
    get current() { return current; }
  };
})();
