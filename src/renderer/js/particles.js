/* =====================================================================
   SamParticles — lightweight additive particle field (canvas 2D)
   Used by the login intro: silhouette burst + endless ambient motes.
   ===================================================================== */
(function (global) {
  'use strict';

  const PALETTE = {
    water: '#eaf7ff',
    cyan: '#7fd8ff',
    gold: '#d9a441',
    goldHot: '#ffe6a8',
    blue: '#5b83ff'
  };

  function makeSprite(hex, softness) {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, hex);
    grd.addColorStop(0.28, hex);
    grd.addColorStop(softness == null ? 0.45 : softness, hexWithAlpha(hex, 0.35));
    grd.addColorStop(1, hexWithAlpha(hex, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return c;
  }

  function hexWithAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }

  class ParticleField {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.parts = [];
      this.rings = [];
      this.max = 1500;
      this.ambientRate = 0;
      this._acc = 0;
      this._raf = 0;
      this._last = 0;
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.sprites = {
        water: makeSprite(PALETTE.water),
        cyan: makeSprite(PALETTE.cyan),
        gold: makeSprite(PALETTE.gold),
        goldHot: makeSprite(PALETTE.goldHot),
        blue: makeSprite(PALETTE.blue)
      };
      this.resize();
      global.addEventListener('resize', () => this.resize());
    }

    resize() {
      const w = this.canvas.clientWidth || global.innerWidth;
      const h = this.canvas.clientHeight || global.innerHeight;
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.w = w;
      this.h = h;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    add(p) {
      if (this.parts.length >= this.max) return;
      this.parts.push(p);
    }

    /** one particle from a sampled silhouette point */
    explodePoint(x, y, color) {
      const ang = Math.atan2(y - this.h * 0.45, x - this.w * 0.5) + (Math.random() - 0.5) * 1.5;
      const sp = 90 + Math.random() * 620;
      const key = color || pickColor();
      this.add({
        x, y,
        px: x, py: y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - Math.random() * 120,
        g: 150 + Math.random() * 190,
        drag: 0.62 + Math.random() * 0.22,
        size: 1.4 + Math.random() * 5.2,
        life: 0,
        max: 1.1 + Math.random() * 1.9,
        sprite: this.sprites[key],
        tw: Math.random() * 6.28,
        tws: 5 + Math.random() * 9,
        streak: sp > 480
      });
    }

    ring(x, y, opts = {}) {
      this.rings.push({
        x, y,
        r: opts.r0 || 10,
        vr: opts.vr || 900,
        life: 0,
        max: opts.max || 0.7,
        color: opts.color || PALETTE.goldHot,
        w: opts.w || 3
      });
    }

    setAmbient(rate) {
      this.ambientRate = rate;
    }

    ambientSpawn(dt) {
      this._acc += this.ambientRate * dt;
      while (this._acc >= 1) {
        this._acc -= 1;
        const fromBottom = Math.random() < 0.72;
        const key = Math.random() < 0.34 ? 'gold' : (Math.random() < 0.5 ? 'cyan' : 'water');
        this.add({
          x: Math.random() * this.w,
          y: fromBottom ? this.h + 12 : Math.random() * this.h,
          px: 0, py: 0,
          vx: (Math.random() - 0.5) * 14,
          vy: fromBottom ? -(8 + Math.random() * 26) : (Math.random() - 0.5) * 12,
          g: -1.5,
          drag: 0.995,
          size: 1 + Math.random() * 2.6,
          life: 0,
          max: 6 + Math.random() * 9,
          sprite: this.sprites[key],
          tw: Math.random() * 6.28,
          tws: 1.2 + Math.random() * 3.4,
          sway: 8 + Math.random() * 26,
          swayF: 0.3 + Math.random() * 0.9,
          streak: false
        });
      }
    }

    start() {
      if (this._raf) return;
      this._last = performance.now();
      const loop = (t) => {
        const dt = Math.min(0.05, (t - this._last) / 1000);
        this._last = t;
        this.step(dt);
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }

    stop() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
    }

    clear() {
      this.parts.length = 0;
      this.rings.length = 0;
      this.ctx.clearRect(0, 0, this.w, this.h);
    }

    step(dt) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = 'lighter';

      this.ambientSpawn(dt);

      const arr = this.parts;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        p.life += dt;
        if (p.life >= p.max) { arr.splice(i, 1); continue; }

        p.px = p.x; p.py = p.y;
        const damp = Math.pow(p.drag, dt * 60 / 60);
        p.vy += p.g * dt;
        p.vx *= Math.pow(damp, dt * 3);
        p.vy *= Math.pow(damp, dt * 3);
        if (p.sway) p.x += Math.sin((p.life + p.tw) * p.swayF) * p.sway * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        const k = p.life / p.max;
        let a = k < 0.12 ? k / 0.12 : Math.pow(1 - (k - 0.12) / 0.88, 1.5);
        a *= 0.72 + 0.28 * Math.sin(p.tw + p.life * p.tws);
        if (a <= 0.004) continue;

        const size = p.size * (1 + k * 0.5) * 4.2;
        if (p.streak && k < 0.45) {
          ctx.globalAlpha = a * 0.42;
          ctx.strokeStyle = PALETTE.goldHot;
          ctx.lineWidth = Math.max(0.6, p.size * 0.5);
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        ctx.globalAlpha = a;
        ctx.drawImage(p.sprite, p.x - size / 2, p.y - size / 2, size, size);
      }

      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.life += dt;
        if (r.life >= r.max) { this.rings.splice(i, 1); continue; }
        r.r += r.vr * dt;
        r.vr *= Math.pow(0.22, dt);
        const k = r.life / r.max;
        ctx.globalAlpha = (1 - k) * 0.55;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = Math.max(0.5, r.w * (1 - k));
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, 6.2832);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function pickColor() {
    const r = Math.random();
    if (r < 0.36) return 'water';
    if (r < 0.62) return 'cyan';
    if (r < 0.84) return 'gold';
    if (r < 0.94) return 'blue';
    return 'goldHot';
  }

  global.SamParticles = ParticleField;
  global.SamPalette = PALETTE;
})(window);
