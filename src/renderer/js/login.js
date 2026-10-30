'use strict';

/* =====================================================================
   Login / intro timeline
   bottle rises -> floats -> rotates -> charges -> explodes (sound)
   -> wordmark + number glow in -> form appears
   particles keep drifting in the background until the user logs in.
   ===================================================================== */

const $ = (id) => document.getElementById(id);

const bottle = $('bottle');
const brand = $('brand');
const panel = $('panel');
const loginCard = $('loginCard');
const flash = $('flash');
const skipBtn = $('skipBtn');
const field = new SamParticles($('fx'));
const sfx = {
  boom: new Audio('assets/sfx/explosion.wav'),
  tick: new Audio('assets/sfx/tick.wav')
};
sfx.boom.volume = 0.72;
sfx.tick.volume = 0.25;

let muted = false;
let exploded = false;
let timers = [];
const at = (ms, fn) => timers.push(setTimeout(fn, ms));
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

/* ---------- silhouette sampling (particles inherit the bottle colours) ---------- */
let silhouette = [];
function sampleSilhouette() {
  const iw = bottle.naturalWidth, ih = bottle.naturalHeight;
  if (!iw || !ih) return;
  const scale = 110 / iw;
  const w = Math.max(8, Math.round(iw * scale));
  const h = Math.max(8, Math.round(ih * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, w, h);
  g.drawImage(bottle, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  silhouette = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 130) continue;
      if (Math.random() > 0.34) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      let key = 'water';
      if (sat > 0.45 && b >= r && b >= gg) key = Math.random() < 0.5 ? 'cyan' : 'blue';
      else if (sat > 0.4 && r > b) key = 'gold';
      else if (Math.random() < 0.14) key = 'gold';
      silhouette.push({ nx: x / w, ny: y / h, key });
    }
  }
}

function explode() {
  if (exploded) return;
  exploded = true;
  const rect = bottle.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  if (!muted) {
    try { sfx.boom.currentTime = 0; sfx.boom.play().catch(() => {}); } catch (e) {}
  }

  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');

  brand.classList.add('shake');
  setTimeout(() => brand.classList.remove('shake'), 500);

  bottle.classList.remove('s-charge');
  bottle.classList.add('s-gone');

  const budget = 720;
  const step = Math.max(1, Math.round(silhouette.length / budget));
  for (let i = 0; i < silhouette.length; i += step) {
    const p = silhouette[i];
    field.explodePoint(rect.left + p.nx * rect.width, rect.top + p.ny * rect.height, p.key);
  }
  for (let i = 0; i < 180; i++) {
    field.explodePoint(cx + (Math.random() - 0.5) * rect.width * 0.6, cy + (Math.random() - 0.5) * rect.height * 0.8);
  }
  field.ring(cx, cy, { r0: 12, vr: 1150, max: 0.8, color: SamPalette.goldHot, w: 4 });
  field.ring(cx, cy, { r0: 6, vr: 700, max: 1.1, color: SamPalette.cyan, w: 2.4 });

  field.setAmbient(34);
  setTimeout(() => field.setAmbient(12), 2600);

  panel.classList.add('revealed');
  skipBtn.classList.add('gone');
  setTimeout(() => { $('intro').style.display = 'none'; }, 300);
  setTimeout(() => $('username').focus({ preventScroll: true }), 1500);
}

function setStage(cls) {
  bottle.classList.remove('s-enter', 's-float', 's-spin', 's-charge', 's-gone');
  bottle.classList.add(cls);
}

function runTimeline() {
  field.start();
  field.setAmbient(5);
  at(120, () => setStage('s-enter'));
  at(2280, () => setStage('s-float'));
  at(3700, () => setStage('s-spin'));
  at(5250, () => setStage('s-charge'));
  at(5740, explode);
}

function skipIntro() {
  clearTimers();
  $('intro').style.display = 'none';
  if (!exploded) {
    exploded = true;
    field.setAmbient(14);
    panel.classList.add('revealed');
    skipBtn.classList.add('gone');
    setTimeout(() => $('username').focus({ preventScroll: true }), 400);
  }
}

/* ---------- mute ---------- */
$('muteBtn').addEventListener('click', (e) => {
  muted = !muted;
  e.currentTarget.classList.toggle('muted', muted);
  sfx.boom.muted = muted;
  sfx.tick.muted = muted;
  e.currentTarget.title = muted ? 'تشغيل الصوت' : 'كتم الصوت';
});

/* ---------- password reveal ---------- */
$('pwToggle').addEventListener('click', () => {
  const pw = $('password');
  pw.type = pw.type === 'password' ? 'text' : 'password';
  pw.focus();
});

/* ---------- login ---------- */
let busy = false;

function fail(msg) {
  const err = $('loginError');
  err.textContent = msg;
  loginCard.classList.remove('shake');
  void loginCard.offsetWidth;
  loginCard.classList.add('shake');
  $('loginBtn').disabled = false;
  busy = false;
}

loginCard.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  const u = $('username').value.trim();
  const p = $('password').value;
  if (!u || !p) return fail('يرجى إدخال اسم المستخدم وكلمة المرور');
  $('loginBtn').disabled = true;
  $('loginError').textContent = '';
  let res;
  try {
    res = await window.sam.auth.login(u, p);
  } catch (err) {
    return fail('تعذّر الاتصال بالنظام: ' + err.message);
  }
  if (!res || !res.ok) return fail(res && res.error ? res.error : 'بيانات الدخول غير صحيحة');
  // the main process loads the app window on success
  if (!muted) { sfx.tick.currentTime = 0; sfx.tick.play().catch(() => {}); }
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  for (let i = 0; i < 160; i++) field.explodePoint(cx + (Math.random() - .5) * 320, cy + (Math.random() - .5) * 220);
  field.ring(cx, cy, { r0: 20, vr: 900, max: .7 });
  document.body.classList.add('leaving');
});

/* ---------- boot ---------- */
let booted = false;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') skipIntro();
});

function boot() {
  if (booted) return;
  booted = true;
  field.resize();
  if (bottle.complete && bottle.naturalWidth) {
    sampleSilhouette();
    runTimeline();
  } else {
    bottle.addEventListener('load', () => { sampleSilhouette(); runTimeline(); }, { once: true });
    bottle.addEventListener('error', () => { setStage('s-float'); skipIntro(); }, { once: true });
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
