'use strict';

/* =====================================================================
   Post-login transition — V2
   The intro animation moved OFF the login screen. It now runs once, in the
   app window, right after a successful login: the bottle rises, bursts into
   blue / teal / gold particles, a short success chime plays, and the
   dashboard is revealed. Whole thing is capped at ~2 seconds and skippable.
   ===================================================================== */
(function (global) {
  'use strict';

  const MAX_MS = 2000;
  const FLAG = 'sam.justLoggedIn';
  const MUTE_KEY = 'sam.muted';

  const reduced = () => {
    try { return localStorage.getItem('sam.noIntro') === '1'; } catch (e) { return false; }
  };

  let overlay = null;
  let field = null;
  let timers = [];
  let running = false;

  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clear = () => { timers.forEach(clearTimeout); timers = []; };

  /* ---------- silhouette sampling: particles inherit the bottle colours ---------- */
  function sampleBottle(img) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return [];
    const scale = 90 / iw;
    const w = Math.max(8, Math.round(iw * scale));
    const h = Math.max(8, Math.round(ih * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const pts = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 130) continue;
        if (Math.random() > 0.4) continue;
        const r = d[i], b = d[i + 2], gg = d[i + 1];
        const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        // brand palette only: blue / teal / gold
        let key = 'water';
        if (sat > 0.35 && b >= r) key = Math.random() < 0.55 ? 'blue' : 'cyan';
        else if (sat > 0.3 && r > b) key = 'gold';
        else if (Math.random() < 0.2) key = 'blue';
        pts.push({ nx: x / w, ny: y / h, key });
      }
    }
    return pts;
  }

  function build() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'intro-ov';
    overlay.innerHTML = `
      <canvas class="io-fx" id="ioFx"></canvas>
      <div class="io-stage">
        <div class="io-bottle-wrap">
          <div class="io-halo"></div>
          <img class="io-bottle" id="ioBottle" src="assets/img/bottle.png" alt="" draggable="false" />
        </div>
        <div class="io-brand" id="ioBrand">
          <div class="io-name">SAM</div>
          <div class="io-sub">نظام إدارة الأصناف والمخازن والإنتاج</div>
          <div class="io-ok" id="ioOk">
            <svg class="ic" viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></svg>
            <span>تم تسجيل الدخول بنجاح</span>
          </div>
        </div>
      </div>
      <button class="io-skip" id="ioSkip" type="button">تخطّي</button>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function sound(file, volume, delayMs) {
    try {
      if (localStorage.getItem(MUTE_KEY) === '1') return;
      const a = new Audio(`assets/sfx/${file}`);
      a.volume = volume;
      if (delayMs) setTimeout(() => a.play().catch(() => {}), delayMs);
      else a.play().catch(() => {});
    } catch (e) { /* audio is never fatal */ }
  }

  function burst(img, pts) {
    const rect = img.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const budget = 520;
    const step = Math.max(1, Math.round(pts.length / budget));
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      field.explodePoint(rect.left + p.nx * rect.width, rect.top + p.ny * rect.height, p.key);
    }
    for (let i = 0; i < 140; i++) {
      field.explodePoint(cx + (Math.random() - 0.5) * rect.width * 0.7, cy + (Math.random() - 0.5) * rect.height * 0.9);
    }
    field.ring(cx, cy, { r0: 10, vr: 1050, max: 0.7, color: global.SamPalette.blue, w: 4 });
    field.ring(cx, cy, { r0: 6, vr: 700, max: 0.95, color: global.SamPalette.gold, w: 2.6 });
  }

  function finish() {
    if (!overlay) return;
    overlay.classList.add('gone');
    setTimeout(() => {
      clear();
      if (field) { field.stop(); field = null; }
      if (overlay) overlay.remove();
      overlay = null;
      running = false;
    }, 330);
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.force] play even when the login flag is absent
   *                 (used by «إعادة عرض المقدمة» in Settings)
   */
  function play(opts = {}) {
    if (running) return false;
    if (!opts.force && (reduced() || global.__SAM_NO_INTRO__)) return false;
    if (!opts.force) {
      let seen = false;
      try { seen = sessionStorage.getItem(FLAG) === '1'; sessionStorage.removeItem(FLAG); } catch (e) { seen = false; }
      if (!seen) return false;
    }
    running = true;

    const node = build();
    const img = node.querySelector('#ioBottle');
    field = new global.SamParticles(node.querySelector('#ioFx'));
    field.start();
    field.setAmbient(10);

    const skip = node.querySelector('#ioSkip');
    skip.addEventListener('click', finish);
    const onKey = (e) => { if (e.key === 'Escape') { finish(); document.removeEventListener('keydown', onKey, true); } };
    document.addEventListener('keydown', onKey, true);
    at(MAX_MS + 900, () => document.removeEventListener('keydown', onKey, true));

    const start = () => {
      const pts = sampleBottle(img);
      img.classList.add('s-in');
      at(420, () => {
        sound('explosion.wav', 0.3, 0);
        sound('success.wav', 0.8, 120);
        img.classList.remove('s-in');
        img.classList.add('s-pop');
        burst(img, pts);
        field.setAmbient(6);
        node.querySelector('#ioBrand').classList.add('show');
        at(260, () => node.querySelector('#ioOk').classList.add('show'));
      });
      // hard cap: the dashboard is never hidden for longer than the budget
      at(Math.max(0, MAX_MS - 420), () => {
        finish();
        global.SamUI && global.SamUI.bus.emit();
      });
    };

    if (img.complete && img.naturalWidth) start();
    else {
      img.addEventListener('load', start, { once: true });
      img.addEventListener('error', () => { finish(); }, { once: true });
    }
    return true;
  }

  function toggleMute() {
    const next = localStorage.getItem(MUTE_KEY) === '1' ? '0' : '1';
    localStorage.setItem(MUTE_KEY, next);
    return next === '1';
  }

  global.SamIntro = { play, toggleMute, isMuted: () => localStorage.getItem(MUTE_KEY) === '1' };
})(window);
