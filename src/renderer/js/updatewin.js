'use strict';

/* =====================================================================
   نافذة التحديث — opened from the update icon in the title bar.
   Shows the state, the percentage, the speed, the size and the buttons:
   فحص · تحميل · تثبيت · معاينة.
   The state itself lives in the main process (updater.js) — this window
   only reads it and paints it, so it never disagrees with the truth.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast } = SamUI;

  const STATUS = {
    idle: 'جاهز',
    checking: 'جارٍ الفحص…',
    available: 'يتوفر تحديث',
    'up-to-date': 'أحدث إصدار',
    downloading: 'جارٍ التحميل',
    downloaded: 'جاهز للتثبيت',
    installing: 'جارٍ التثبيت',
    error: 'خطأ',
    dev: 'وضع التطوير'
  };

  const MB = (b) => (Number(b) || 0) / 1048576;

  let current = null;

  function open() {
    if (current) current.close();

    const ov = el('div', 'overlay updwin-overlay');
    const box = el('div', 'updwin-window');

    const head = el('div', 'updwin-head');
    head.innerHTML = `<span class="uw-badge">${icon('i-update')}</span>
      <div class="uw-txt"><h3>تحديث البرنامج</h3>
      <span>نسخة احتياطية تلقائية قبل التثبيت — بياناتك لا تُمس</span></div>`;
    const x = el('button', 'updwin-x', icon('i-x'));
    x.type = 'button';
    x.title = 'إغلاق';
    head.appendChild(x);
    box.appendChild(head);

    const body = el('div', 'updwin-body');
    box.appendChild(body);

    const foot = el('div', 'updwin-foot');
    box.appendChild(foot);

    ov.appendChild(box);
    document.body.appendChild(ov);

    /* ---------- the widgets ---------- */
    const badge = el('span', 'badge gold', 'جاهز');
    const info = el('dl', 'info');
    const bar = el('div', 'upd-bar-wrap');
    bar.innerHTML = `
      <div class="upd-bar-top"><span id="uwLabel">لم يبدأ التحميل بعد</span><b id="uwPercent">0%</b></div>
      <div class="upd-track"><div class="upd-fill" id="uwFill"></div></div>
      <div class="upd-meta"><span id="uwSize">0.0 / 0.0 MB</span><span id="uwSpeed">— MB/ث</span></div>`;

    const statusRow = el('div', 'uw-status');
    statusRow.appendChild(badge);

    body.append(statusRow, info, bar);

    const btns = {};
    [['check', 'فحص التحديثات', 'i-search'], ['download', 'تحميل التحديث', 'i-download'],
     ['install', 'تثبيت وإعادة التشغيل', 'i-check'], ['simulate', 'معاينة شريط التقدم', 'i-eye']]
      .forEach(([key, label, ic]) => {
        const b = el('button', 'btn btn-ghost');
        b.type = 'button';
        b.innerHTML = `${icon(ic)}<span>${esc(label)}</span>`;
        b.addEventListener('click', () => run(key));
        btns[key] = b;
        foot.appendChild(b);
      });

    /* ---------- state painting ---------- */
    let last = { status: 'idle' };

    function paint(s) {
      s = s || last;
      last = s;
      const st = s.status || 'idle';
      badge.textContent = STATUS[st] || st;
      badge.className = `badge ${st === 'error' ? 'bad' : st === 'downloaded' || st === 'up-to-date' ? 'ok' : 'gold'}`;
      const pct = Math.max(0, Math.min(100, Number(s.percent) || 0));
      bar.classList.toggle('done', st === 'downloaded');
      bar.classList.toggle('err', st === 'error');
      bar.querySelector('#uwFill').style.width = `${pct}%`;
      bar.querySelector('#uwPercent').textContent = `${pct.toFixed(1)}%`;
      bar.querySelector('#uwLabel').textContent = s.message || STATUS[st] || '';
      bar.querySelector('#uwSize').textContent = `${MB(s.transferred).toFixed(1)} / ${MB(s.total).toFixed(1)} MB`;
      bar.querySelector('#uwSpeed').textContent = s.speed ? `${MB(s.speed).toFixed(2)} MB/ث` : '— MB/ث';

      btns.download.classList.toggle('hidden', st !== 'available');
      btns.install.classList.toggle('hidden', st !== 'downloaded');
    }

    async function refresh() {
      try {
        const st = await sam.update.state();
        paint(st && st.ok ? st.data : st);
        const [info2, feed] = await Promise.all([sam.app.info(), sam.update.feed()]);
        info.innerHTML = [
          ['الإصدار الحالي', `v${info2.version}`],
          ['الإصدار المتوفر', last.version ? `v${last.version}` : '—'],
          ['الحالة', STATUS[last.status] || 'جاهز'],
          ['مصدر التحديثات', feed && feed.provider ? `${feed.provider} / ${feed.owner || ''}/${feed.repo || ''}` : '—']
        ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
      } catch (e) { toast(e.message, 'bad'); }
    }

    async function run(kind) {
      try {
        if (kind === 'check') {
          const r = await sam.update.check();
          paint(r && r.ok ? r.data : r);
          if (r && !r.ok) toast(r.error, 'bad');
          else if (r && r.data && r.data.status === 'available') toast(`يتوفر إصدار ${r.data.version}`, 'ok');
          else if (r && r.data && r.data.status === 'up-to-date') toast('أنت على أحدث إصدار', 'ok');
          return;
        }
        if (kind === 'download') {
          const r = await sam.update.download();
          paint(r && r.ok ? r.data : r);
          return;
        }
        if (kind === 'install') { await sam.update.install(); return; }
        if (kind === 'simulate') {
          const r = await sam.update.simulate();
          paint(r && r.ok ? r.data : r);
        }
      } catch (e) { toast(e.message, 'bad'); }
    }

    /* the main process pushes the state on every change */
    const off = sam.on('app:update-state', (s) => paint(s));

    function close() {
      off && off();
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (current === api) current = null;
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    x.addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey, true);

    const api = { overlay: ov, close, refresh };
    current = api;
    refresh();
    return api;
  }

  window.SamUpdateWindow = {
    open,
    close() { if (current) current.close(); },
    get current() { return current; }
  };
})();
