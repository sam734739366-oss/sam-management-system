/**
 * tools/build-assets.js
 * Generates the app's binary assets from the source bottle image:
 *   1. build/bottle.png        -> true-transparent version of water-bottle.png
 *   2. build/icon.png          -> 1024x1024 app icon (bottle on navy + gold)
 *   3. build/icon.ico          -> multi-size Windows icon
 *   4. src/renderer/assets/sfx/explosion.wav  -> synthesised whoosh + boom
 * Run with: npm run assets
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SFX_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'sfx');
const IMG_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'img');

for (const dir of [BUILD, SFX_DIR, IMG_DIR]) fs.mkdirSync(dir, { recursive: true });

/* ------------------------------------------------------------------ *
 * 1. Transparent bottle
 * ------------------------------------------------------------------ */

function findSourceImage() {
  const candidates = fs
    .readdirSync(ROOT)
    .filter((f) => /\.png$/i.test(f) && /bottle/i.test(f));
  if (!candidates.length) throw new Error('No water-bottle png found in project root');
  // prefer the shortest name (water-bottle.png over water-bottle.png.png)
  candidates.sort((a, b) => a.length - b.length);
  return path.join(ROOT, candidates[0]);
}

function alphaStats(png) {
  let semi = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < 250) semi++;
  return semi / (png.width * png.height);
}

/** Magic-wand from the borders: any near-white pixel reachable from the edge
 *  (or reachable from an already-transparent pixel) becomes fully transparent.
 *  Interior highlights are preserved. */
function removeFlatBackground(png) {
  const { width: w, height: h, data } = png;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;

  const isBg = (p) => {
    const i = p * 4;
    if (data[i + 3] < 128) return true;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lo = Math.min(r, g, b);
    const hi = Math.max(r, g, b);
    return lo >= 214 && hi - lo <= 34; // near-white / very light grey
  };

  const push = (p) => {
    if (!seen[p]) {
      seen[p] = 1;
      if (isBg(p)) stack[top++] = p;
    }
  };

  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }

  while (top > 0) {
    const p = stack[--top];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  for (let p = 0; p < w * h; p++) {
    if (!seen[p]) continue;
    const i = p * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
    data[i + 3] = 0;
  }

  // Soft edge: one pass of neighbour averaging on the alpha channel,
  // then de-spill (undo the original white matte) on partly transparent pixels.
  const src = new Uint8Array(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const i = p * 4;
      const a0 = (src[i + 3] + src[i - 4 + 3] + src[i + 4 + 3] + src[i - w * 4 + 3] + src[i + w * 4 + 3]) / 5;
      if (a0 === 0 || a0 === 255) {
        data[i + 3] = src[i + 3];
        continue;
      }
      const a = a0 / 255;
      data[i + 3] = Math.round(a0);
      for (let c = 0; c < 3; c++) {
        const unmatte = (src[i + c] - (1 - a) * 255) / Math.max(a, 0.2);
        data[i + c] = Math.max(0, Math.min(255, Math.round(unmatte)));
      }
    }
  }
  return png;
}

function buildBottle() {
  const file = findSourceImage();
  const png = PNG.sync.read(fs.readFileSync(file));
  const existing = alphaStats(png);
  console.log(
    `source: ${path.basename(file)} ${png.width}x${png.height} ` +
      `(transparent-ish pixels: ${(existing * 100).toFixed(2)}%)`
  );
  if (existing < 0.02) removeFlatBackground(png);
  else console.log('source already carries real alpha -> copying as-is');

  // trim to the visible bounding box so the logo fills the frame nicely
  const { width: w, height: h, data } = png;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) throw new Error('bottle image is empty after background removal');
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const out = new PNG({ width: bw, height: bh });
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const s = ((y + minY) * w + (x + minX)) * 4;
      const d = (y * bw + x) * 4;
      out.data[d] = data[s];
      out.data[d + 1] = data[s + 1];
      out.data[d + 2] = data[s + 2];
      out.data[d + 3] = data[s + 3];
    }
  fs.writeFileSync(path.join(IMG_DIR, 'bottle.png'), PNG.sync.write(out));
  fs.writeFileSync(path.join(BUILD, 'bottle.png'), PNG.sync.write(out));
  console.log(`-> src/renderer/assets/img/bottle.png (${bw}x${bh})`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Icon canvas helpers
 * ------------------------------------------------------------------ */

function blank(size) {
  const png = new PNG({ width: size, height: size });
  return png;
}

function setPx(png, x, y, r, g, b, a) {
  const i = (y * png.width + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

/** rounded-rect distance test (SDF) */
function insideRoundRect(x, y, cx, cy, hw, hh, rad) {
  const dx = Math.abs(x - cx) - (hw - rad);
  const dy = Math.abs(y - cy) - (hh - rad);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - rad;
}

function drawBackground(png, size) {
  const navyTop = [0x12, 0x21, 0x4d];
  const navyMid = [0x1e, 0x3a, 0x8a];
  const navyBot = [0x0b, 0x14, 0x33];
  const gold = [0xd9, 0xa4, 0x41];
  const rad = size * 0.22;
  const hw = size / 2 - size * 0.01;
  const hh = size / 2 - size * 0.01;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = insideRoundRect(x, y, size / 2, size / 2, hw, hh, rad);
      if (d > 0.5) {
        setPx(png, x, y, 0, 0, 0, 0);
        continue;
      }
      const t = y / size;
      let c;
      if (t < 0.55) c = [mix(navyTop[0], navyMid[0], t / 0.55), mix(navyTop[1], navyMid[1], t / 0.55), mix(navyTop[2], navyMid[2], t / 0.55)];
      else c = [mix(navyMid[0], navyBot[0], (t - 0.55) / 0.45), mix(navyMid[1], navyBot[1], (t - 0.55) / 0.45), mix(navyMid[2], navyBot[2], (t - 0.55) / 0.45)];
      // gold hairline ring
      const ring = Math.abs(d + size * 0.012);
      if (ring < size * 0.0045) c = [mix(c[0], gold[0], 0.85), mix(c[1], gold[1], 0.85), mix(c[2], gold[2], 0.85)];
      // soft radial glow behind the bottle
      const g = Math.hypot(x - size * 0.5, y - size * 0.52) / size;
      const glow = Math.max(0, 1 - g * 2.1) ** 2;
      c = [mix(c[0], 0x3f, glow * 0.75), mix(c[1], 0x74, glow * 0.7), mix(c[2], 0xff, glow * 0.55)];
      const aa = d < -0.5 ? 255 : Math.round(255 * (0.5 - d));
      setPx(png, x, y, Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.max(0, Math.min(255, aa)));
    }
  }
}

function scaleOnto(base, sprite, opts = {}) {
  const { heightFraction = 0.8, cx = 0.5, cy = 0.5 } = opts;
  const size = base.width;
  const targetH = Math.round(size * heightFraction);
  const targetW = Math.round((sprite.width / sprite.height) * targetH);
  const ox = Math.round(size * cx - targetW / 2);
  const oy = Math.round(size * cy - targetH / 2);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      // box-filtered downsample for crispness
      const sx0 = (x / targetW) * sprite.width;
      const sy0 = (y / targetH) * sprite.height;
      const sx1 = Math.min(sprite.width, ((x + 1) / targetW) * sprite.width);
      const sy1 = Math.min(sprite.height, ((y + 1) / targetH) * sprite.height);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const X0 = Math.floor(sx0), Y0 = Math.floor(sy0);
      const X1 = Math.max(X0 + 1, Math.ceil(sx1)), Y1 = Math.max(Y0 + 1, Math.ceil(sy1));
      for (let sy = Y0; sy < Y1; sy++)
        for (let sx = X0; sx < X1; sx++) {
          const i = (sy * sprite.width + sx) * 4;
          const al = sprite.data[i + 3] / 255;
          r += sprite.data[i] * al;
          g += sprite.data[i + 1] * al;
          b += sprite.data[i + 2] * al;
          a += al;
          n++;
        }
      if (!a) continue;
      const dx = ox + x, dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= size || dy >= size) continue;
      const alpha = a / n;
      const di = (dy * size + dx) * 4;
      const sr = r / a, sg = g / a, sb = b / a;
      const da = base.data[di + 3] / 255;
      const outA = alpha + da * (1 - alpha);
      base.data[di] = Math.round((sr * alpha + base.data[di] * da * (1 - alpha)) / outA);
      base.data[di + 1] = Math.round((sg * alpha + base.data[di + 1] * da * (1 - alpha)) / outA);
      base.data[di + 2] = Math.round((sb * alpha + base.data[di + 2] * da * (1 - alpha)) / outA);
      base.data[di + 3] = Math.round(outA * 255);
    }
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * 3. ICO container (PNG payload per size is valid Vista+ ICO)
 * ------------------------------------------------------------------ */

function buildIco(sizes) {
  const count = sizes.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  const blobs = sizes.map(({ png, px }) => {
    const buf = PNG.sync.write(png, { resolution: 96 });
    return { buf, px };
  });
  let cursor = offset;
  blobs.forEach(({ buf, px }, idx) => {
    const e = 6 + idx * 16;
    header[e] = px >= 256 ? 0 : px;
    header[e + 1] = px >= 256 ? 0 : px;
    header.writeUInt16LE(0, e + 2);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt32LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(cursor, e + 12);
    cursor += buf.length;
  });
  return Buffer.concat([header, ...blobs.map((b) => b.buf)]);
}

async function buildIcon(bottle) {
  const master = blank(1024);
  drawBackground(master, 1024);
  scaleOnto(master, bottle, { heightFraction: 0.8 });
  fs.writeFileSync(path.join(BUILD, 'icon.png'), PNG.sync.write(master));

  const ladder = [256, 128, 64, 48, 32, 16];
  const entries = ladder.map((px) => {
    const png = blank(px);
    drawBackground(png, px);
    scaleOnto(png, bottle, { heightFraction: 0.8 });
    return { png, px };
  });
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(entries));
  console.log('-> build/icon.png + build/icon.ico');

  // 512 png is what electron-builder / the window chrome prefer
  const small = blank(512);
  drawBackground(small, 512);
  scaleOnto(small, bottle, { heightFraction: 0.8 });
  fs.writeFileSync(path.join(BUILD, 'icon@512.png'), PNG.sync.write(small));
}

/* ------------------------------------------------------------------ *
 * 4. Synthesised explosion (whoosh -> boom -> shimmer tail)
 * ------------------------------------------------------------------ */

function writeWav(file, samples, rate = 44100) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  writeUInt32(buf, rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}
function writeUInt32(buf, val, off) {
  buf.writeUInt32LE(val >>> 0, off);
}

function buildExplosion() {
  const rate = 44100;
  const dur = 2.6;
  const N = Math.floor(rate * dur);
  const out = new Float64Array(N);

  let seed = 20261030;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // --- whoosh: noise through a rising one-pole band, 0 -> 0.62s
  const W = 0.62;
  let lp = 0, lp2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / rate;
    if (t > W) break;
    const p = t / W;
    const noise = rnd() * 2 - 1;
    const k = 0.02 + p * p * 0.42;
    lp += (noise - lp) * k;
    lp2 += (lp - lp2) * k * 0.7;
    const env = Math.pow(p, 2.4) * (1 - Math.pow(p, 6));
    out[i] += lp2 * env * 0.9;
  }

  // --- boom at 0.6s: sub thump + burst of low-passed noise
  const t0 = 0.6;
  let n1 = 0, n2 = 0, n3 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / rate;
    const d = t - t0;
    if (d < 0) continue;
    const decay = Math.exp(-d * 4.6);
    const f = 58 * Math.exp(-d * 1.5) + 24;
    const sub = Math.sin(2 * Math.PI * f * d) * decay;
    const noise = rnd() * 2 - 1;
    const k = 0.16 * Math.exp(-d * 2.2) + 0.008;
    n1 += (noise - n1) * k;
    n2 += (n1 - n2) * k;
    n3 += (n2 - n3) * k;
    const crack = d < 0.05 ? (rnd() * 2 - 1) * (1 - d / 0.05) * 0.55 : 0;
    out[i] += sub * 0.62 + n3 * decay * 0.8 + crack;
  }

  // --- shimmer tail: detuned bell partials, 0.68 -> end
  const parts = [1180, 1570, 2093, 2637];
  for (let i = 0; i < N; i++) {
    const t = i / rate;
    const d = t - 0.68;
    if (d < 0) continue;
    const env = Math.exp(-d * 2.1) * 0.14;
    let s = 0;
    parts.forEach((f, idx) => {
      s += Math.sin(2 * Math.PI * f * d * (1 + 0.0015 * idx)) / (idx + 1.6);
    });
    out[i] += s * env * Math.min(1, d * 12);
  }

  // soft clip + fade out
  for (let i = 0; i < N; i++) {
    out[i] = Math.tanh(out[i] * 1.1) * 0.9;
    const t = i / rate;
    if (t > dur - 0.35) out[i] *= Math.max(0, (dur - t) / 0.35);
    if (t < 0.01) out[i] *= t / 0.01;
  }

  writeWav(path.join(SFX_DIR, 'explosion.wav'), Array.from(out), rate);
  console.log(`-> src/renderer/assets/sfx/explosion.wav (${dur}s)`);

  // a tiny UI "tick" for button presses later on
  const n2buf = new Float64Array(Math.floor(rate * 0.09));
  let bp = 0;
  for (let i = 0; i < n2buf.length; i++) {
    const t = i / rate;
    const v = Math.sin(2 * Math.PI * 1400 * t) * Math.exp(-t * 55) * 0.35;
    n2buf[i] = v;
  }
  writeWav(path.join(SFX_DIR, 'tick.wav'), Array.from(n2buf), rate);
  console.log('-> src/renderer/assets/sfx/tick.wav');
}

/* ------------------------------------------------------------------ *
 * 5. Post-login success chime — three rising notes plus a soft bell top
 * ------------------------------------------------------------------ */

function buildSuccess() {
  const rate = 44100;
  const dur = 1.5;
  const N = Math.floor(rate * dur);
  const out = new Float64Array(N);

  // C5 - E5 - G5 - C6, each a little later and a little brighter
  const notes = [
    { f: 523.25, at: 0.00, len: 0.62, gain: 0.34 },
    { f: 659.25, at: 0.13, len: 0.66, gain: 0.32 },
    { f: 783.99, at: 0.26, len: 0.74, gain: 0.30 },
    { f: 1046.5, at: 0.42, len: 1.02, gain: 0.26 }
  ];

  for (const n of notes) {
    const start = Math.floor(n.at * rate);
    const len = Math.floor(n.len * rate);
    for (let i = 0; i < len && start + i < N; i++) {
      const t = i / rate;
      // pluck-ish envelope: fast attack, long exponential tail
      const attack = Math.min(1, t / 0.012);
      const env = attack * Math.exp(-t * 3.1);
      // fundamental + two quiet partials = bell, not beep
      const s = Math.sin(2 * Math.PI * n.f * t)
        + 0.28 * Math.sin(2 * Math.PI * n.f * 2 * t) * Math.exp(-t * 5.5)
        + 0.12 * Math.sin(2 * Math.PI * n.f * 2.99 * t) * Math.exp(-t * 8);
      out[start + i] += s * env * n.gain;
    }
  }

  // a breath of noise under the last note so the chime feels airy
  let seed = 775158;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let lp = 0;
  for (let i = 0; i < N; i++) {
    const t = i / rate;
    if (t < 0.36 || t > 1.2) continue;
    lp += ((rnd() * 2 - 1) - lp) * 0.35;
    out[i] += lp * Math.exp(-Math.abs(t - 0.6) * 5) * 0.05;
  }

  for (let i = 0; i < N; i++) {
    out[i] = Math.tanh(out[i] * 1.15) * 0.86;
    const t = i / rate;
    if (t > dur - 0.3) out[i] *= Math.max(0, (dur - t) / 0.3);
    if (t < 0.008) out[i] *= t / 0.008;
  }

  writeWav(path.join(SFX_DIR, 'success.wav'), Array.from(out), rate);
  console.log(`-> src/renderer/assets/sfx/success.wav (${dur}s)`);
}

/* ------------------------------------------------------------------ */

(async () => {
  const bottle = buildBottle();
  await buildIcon(bottle);
  buildExplosion();
  buildSuccess();
  try {
    const fs2 = require('fs');
    fs2.copyFileSync(path.join(BUILD, 'icon.png'), path.join(IMG_DIR, 'icon.png'));
    console.log('-> src/renderer/assets/img/icon.png');
  } catch (e) {
    console.warn('icon.png copy skipped:', e.message);
  }
  console.log('assets done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
