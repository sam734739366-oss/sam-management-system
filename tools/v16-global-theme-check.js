/**
 * tools/v16-global-theme-check.js — one accessible, resolved color system.
 *
 * Runs the real renderer with a temporary database and measures the shared
 * controls that every screen inherits. It catches unresolved design tokens,
 * low-contrast controls and table rules that are too faint to guide the eye.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v16-global-theme-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v16-theme-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

app.whenReady().then(async () => {
  let win, db;
  let cleaned = false;
  const errors = [];
  async function shutdown(code = 0) {
    if (cleaned) return;
    cleaned = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    try { if (db) db.close(); } catch (e) {}
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
    app.exit(code);
  }

  try {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    db = require(path.join(ROOT, 'src', 'main', 'db.js'));
    const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
    db.init(DATA);
    session.ensureSeed();
    require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

    win = new BrowserWindow({
      width: 1440, height: 900, show: false, frame: false, backgroundColor: '#f4f7fb',
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[0] === 'object' && args[0] ? args[0] : { level: args[1], message: args[2] };
      const level = typeof d.level === 'string' ? ({ error: 3, warning: 2 })[d.level] ?? 0 : d.level;
      if (level >= 2) errors.push(String(d.message || ''));
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadFile(path.join(RENDERER, 'login.html'));
    await sleep(700);
    await js(`sam.auth.login('admin','admin123')`);
    await sleep(1500);
    win.show();
    win.focus();
    await sleep(120);

    const theme = await js(`(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
      const gold = document.createElement('button');
      gold.className = 'btn btn-gold'; gold.textContent = 'زر';
      const primary = document.createElement('button');
      primary.className = 'btn btn-primary'; primary.textContent = 'زر';
      const input = document.createElement('input');
      input.className = 'input'; input.placeholder = 'نص توضيحي';
      const table = document.createElement('table');
      table.className = 'tbl';
      host.append(gold, primary, input, table); document.body.appendChild(host);

      const rgb = (value) => {
        const m = value.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map(Number);
        return { r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1 };
      };
      const hex = (value) => {
        const m = value.trim().match(/^#([0-9a-f]{6})$/i);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return { r:(n>>16)&255, g:(n>>8)&255, b:n&255, a:1 };
      };
      const lum = (c) => {
        const f = (v) => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
        return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);
      };
      const contrast = (a,b) => {
        const x=lum(a), y=lum(b); const hi=Math.max(x,y), lo=Math.min(x,y);
        return Math.round(((hi+0.05)/(lo+0.05))*100)/100;
      };
      const root = getComputedStyle(document.documentElement);
      const token = (name) => root.getPropertyValue(name).trim();
      const goldStyle = getComputedStyle(gold);
      const primaryStyle = getComputedStyle(primary);
      const inputStyle = getComputedStyle(input);
      const placeholderStyle = getComputedStyle(input, '::placeholder');
      const tableStyle = getComputedStyle(table);
      input.focus({ preventScroll: true });
      await new Promise(requestAnimationFrame);
      const focusStyle = getComputedStyle(input);
      const white = {r:255,g:255,b:255,a:1};
      const out = {
        tokens: Object.fromEntries(['--brand-200','--shadow-m','--info','--c-ok-dark','--focus','--control-border'].map(n=>[n,token(n)])),
        gold: { fg:goldStyle.color, bg:goldStyle.backgroundColor, contrast:contrast(rgb(goldStyle.color),rgb(goldStyle.backgroundColor)) },
        primary: { fg:primaryStyle.color, bg:primaryStyle.backgroundColor, contrast:contrast(rgb(primaryStyle.color),rgb(primaryStyle.backgroundColor)) },
        placeholder: { fg:placeholderStyle.color, bg:inputStyle.backgroundColor, contrast:contrast(rgb(placeholderStyle.color),rgb(inputStyle.backgroundColor)) },
        inputBorder: { fg:inputStyle.borderTopColor, bg:inputStyle.backgroundColor, contrast:contrast(rgb(inputStyle.borderTopColor),rgb(inputStyle.backgroundColor)) },
        table: {
          col:tableStyle.getPropertyValue('--tbl-col-line').trim(),
          row:tableStyle.getPropertyValue('--tbl-row-line').trim(),
          colContrast:contrast(hex(tableStyle.getPropertyValue('--tbl-col-line')),white),
          rowContrast:contrast(hex(tableStyle.getPropertyValue('--tbl-row-line')),white)
        },
        focus: { focused: document.activeElement === input, matchesFocus: input.matches(':focus'), hasFocus: document.hasFocus(), style:focusStyle.outlineStyle, width:focusStyle.outlineWidth, color:focusStyle.outlineColor, border:focusStyle.borderTopColor, shadow:focusStyle.boxShadow }
      };
      host.remove();
      return out;
    })()`);

    const missing = Object.entries(theme.tokens).filter(([,v]) => !v).map(([k]) => k);
    check('كل رموز الألوان والظلال المستخدمة لها قيمة فعلية', missing.length === 0, { missing, tokens: theme.tokens });
    check('نص الزر الثانوي يحقق تبايناً مناسباً', theme.gold.contrast >= 4.5, theme.gold);
    check('نص الزر الأساسي يحقق تبايناً مناسباً', theme.primary.contrast >= 4.5, theme.primary);
    check('النص التوضيحي داخل الحقول واضح', theme.placeholder.contrast >= 4.5, theme.placeholder);
    check('حدود الحقول واضحة على الخلفية', theme.inputBorder.contrast >= 3, theme.inputBorder);
    check('خطوط أعمدة الجداول لا تختفي', theme.table.colContrast >= 1.5, theme.table);
    check('خطوط صفوف الجداول أوضح من الخطوط الخفيفة', theme.table.rowContrast >= 2, theme.table);
    check('حقل الإدخال يعرض إطار تركيز واضحاً', theme.focus.style !== 'none' && parseFloat(theme.focus.width) >= 1.5, theme.focus);
    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);

    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
