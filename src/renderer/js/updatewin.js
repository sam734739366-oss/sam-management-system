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
    preparing: 'جارٍ تجهيز التحميل…',
    'backing-up': 'جارٍ أخذ نسخة احتياطية…',
    downloading: 'جارٍ التحميل',
    downloaded: 'جاهز للتثبيت',
    installing: 'جارٍ التثبيت',
    error: 'خطأ',
    dev: 'وضع التطوير'
  };

  /* the phase says WHAT is happening RIGHT NOW — the badge follows it, so
     the customer never sees a key like «preparing» */
  const PHASE = {
    prepare: 'جارٍ تجهيز التحميل…',
    backup: 'جارٍ أخذ نسخة احتياطية…',
    download: 'جارٍ التحميل…'
  };

  const MB = (b) => (Number(b) || 0) / 1048576;
  const hasArabic = (s) => /[؀-ۿ]/.test(String(s || ''));

  let current = null;

  function open() {
    if (current) current.close();

    const ov = el('div', 'overlay updwin-overlay');
    const box = el('div', 'updwin-window');

    const head = el('div', 'updwin-head');
    head.innerHTML = `${SamUI.plate('uw-badge', 'i-update', 'tone-ok', 'xl')}
      <div class="uw-txt"><h3>تحديث البرنامج</h3>
      <span>نسخة احتياطية تلقائية قبل التثبيت — بياناتك لا تُمس</span></div>`;
    const x = el('button', 'updwin-x t3d tone-adjust xs', icon('i-x'));
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
        b.id = 'uwBtn' + key.charAt(0).toUpperCase() + key.slice(1);
        b.dataset.kind = key;
        b.innerHTML = `${SamUI.iconTile(ic, null, 'xs')}<span class="btn-txt">${esc(label)}</span>`;
        b.addEventListener('click', () => run(key));
        btns[key] = b;
        foot.appendChild(b);
      });

    /* ---------- state painting ---------- */
    let last = { status: 'idle' };
    let meta = { info: null, feed: null };

    /** the Arabic sentence of a state — never a raw key */
    function labelOf(s) {
      const st = (s && s.status) || 'idle';
      if (s && s.phase && PHASE[s.phase]) return PHASE[s.phase];
      if (STATUS[st]) return STATUS[st];
      return hasArabic(s && s.message) ? s.message : (s && s.message) || 'جارٍ العمل…';
    }

    function paint(s) {
      s = s || last;
      last = s;
      const st = s.status || 'idle';
      const pct = Math.max(0, Math.min(100, Number(s.percent) || 0));
      badge.textContent = labelOf(s);
      badge.className = `badge ${st === 'error' ? 'bad' : st === 'downloaded' || st === 'up-to-date' ? 'ok' : 'gold'}`;
      bar.classList.toggle('done', st === 'downloaded');
      bar.classList.toggle('err', st === 'error');
      /* the stripes move while the file is really coming down — and the bar
         breathes while the program prepares it, so it never looks frozen */
      const breathing = st === 'checking' || (st === 'downloading' && s.phase !== 'download');
      bar.classList.toggle('busy', st === 'downloading' && s.phase === 'download');
      bar.classList.toggle('checking', breathing);
      bar.querySelector('#uwFill').style.width = `${pct}%`;
      bar.querySelector('#uwPercent').textContent = `${pct.toFixed(1)}%`;
      bar.querySelector('#uwLabel').textContent = s.message || labelOf(s);
      bar.querySelector('#uwSize').textContent = `${MB(s.transferred).toFixed(1)} / ${MB(s.total).toFixed(1)} MB`;
      bar.querySelector('#uwSpeed').textContent = s.speed ? `${MB(s.speed).toFixed(2)} MB/ث` : '— MB/ث';

      /* the buttons follow the state — the download button NEVER vanishes
         while the customer is waiting for it */
      const busy = st === 'downloading';
      btns.download.classList.toggle('hidden', !(st === 'available' || st === 'error' || busy));
      btns.install.classList.toggle('hidden', st !== 'downloaded');
      btns.download.classList.toggle('busy', busy);
      const dlText = btns.download.querySelector('.btn-txt');
      if (dlText) {
        if (busy) {
          const pctText = `${Math.round(pct)}%`;
          dlText.textContent = s.phase === 'prepare' ? 'جارٍ التجهيز…'
            : s.phase === 'backup' ? 'جارٍ النسخ الاحتياطي…'
              : `جارٍ التحميل… ${pctText}`;
        } else if (st === 'error') {
          dlText.textContent = 'إعادة المحاولة';
        } else {
          dlText.textContent = 'تحميل التحديث';
        }
      }
      btns.download.title = busy ? 'اضغط لعرض نسبة التحميل الحالية' : '';
      renderInfo();
    }

    function renderInfo() {
      const rows = [
        ['الإصدار الحالي', `v${meta.info ? meta.info.version : '—'}`],
        ['الإصدار المتوفر', last.version ? `v${last.version}` : '—'],
        ['الحالة', labelOf(last)],
        ['مصدر التحديثات', meta.feed && meta.feed.provider ? `${meta.feed.provider} / ${meta.feed.owner || ''}/${meta.feed.repo || ''}` : '—']
      ];
      if (last.note) rows.push(['نسخة احتياطية', last.note]);
      info.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    }

    async function refresh() {
      try {
        const st = await sam.update.state();
        paint(st && st.ok ? st.data : st);
        const [info2, feed] = await Promise.all([sam.app.info(), sam.update.feed()]);
        meta = { info: info2, feed };
        renderInfo();
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
          /* a second press must not look dead: it reports where we are */
          if (last.status === 'downloading') {
            const pct = Math.max(0, Math.min(100, Number(last.percent) || 0));
            const speed = last.speed ? ` — ${MB(last.speed).toFixed(2)} MB/ث` : '';
            toast(`التحميل جارٍ… ${pct.toFixed(0)}% (${MB(last.transferred).toFixed(1)} من ${MB(last.total).toFixed(1)} MB)${speed}`, 'ok', 4000);
            return;
          }
          const r = await sam.update.download();
          const st = (r && r.ok) ? r.data : r;
          paint(st);
          if (r && !r.ok) toast(r.error, 'bad');
          else if (st && st.status === 'error') toast(st.message || 'تعذّر تحميل التحديث', 'bad', 5000);
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
