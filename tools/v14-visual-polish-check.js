/**
 * tools/v14-visual-polish-check.js — consistent icons, focus and reduced motion.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron tools/v14-visual-polish-check.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '.tmp', `v14-visual-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SAM_DATA_DIR = DATA;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}
process.on('unhandledRejection', (error) => {
  console.log('UNHANDLED: ' + (error && error.stack ? error.stack : error));
  console.log('\n==== ' + pass + ' passed, ' + (fail + 1) + 'failed ====');
  app.exit(1);
});

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
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(DATA, { recursive: true });
    db = require(path.join(ROOT, 'src', 'main', 'db.js'));
    const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
    db.init(DATA);
    session.ensureSeed();

    require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
    require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
    require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);
    win = new BrowserWindow({ width: 1440, height: 900, show: false,
      webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[0] === 'object' && args[0] ? args[0] : { level: args[1], message: args[2] };
      const level = typeof d.level === 'string' ? ({ error: 3, warning: 2 })[d.level] ?? 0 : d.level;
      if (level >= 2) errors.push(String(d.message || ''));
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadFile(path.join(RENDERER, 'login.html'));
    await sleep(800);
    await js(`sam.auth.login('admin','admin123')`);
    await sleep(1600);

    const icons = await js(`(() => {
      const vis=(e)=>!!e && e.getClientRects().length>0;
      const tiles=[...document.querySelectorAll('.t3d')].filter(vis);
      const btn=tiles.find(e=>e.closest('.btn'));
      const info=tiles.filter(e=>e.classList.contains('tone-info'));
      const style=(e)=>{const c=getComputedStyle(e);return {display:c.display,bg:c.backgroundImage,radius:c.borderRadius,shadow:c.boxShadow,userSelect:c.userSelect,transition:c.transitionProperty,duration:c.transitionDuration};};
      return {count:tiles.length,all:tiles.map(style),button:btn?style(btn):null,info:info.slice(0,2).map(style)};
    })()`);
    check('الأيقونات المرئية تحمل نمط اللوحة الموحد', icons && icons.count > 0
      && icons.all.every((s) => (s.display === 'inline-grid' || s.display === 'grid') && /linear-gradient/.test(s.bg) && parseFloat(s.radius) > 0), icons && icons.count);
    check('نفس درجة اللون تعطي نفس مظهر الأيقونة', icons && icons.info.length === 2
      && icons.info[0].bg === icons.info[1].bg && icons.info[0].shadow === icons.info[1].shadow, icons && icons.info);
    check('نص الأيقونة لا يُحدد بالخطأ', icons && icons.all.every((s) => s.userSelect === 'none'), icons && icons.all.slice(0, 3));
    check('أيقونة الزر تملك انتقال رفع قابلاً للحركة', icons && icons.button && /transform/.test(icons.button.transition), icons && icons.button);

    let focus = null;
    const focusDebugger = win.webContents.debugger;
    focusDebugger.attach('1.3');
    try {
      for (let i = 0; i < 24; i++) {
        await focusDebugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await focusDebugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        focus = await js(`(() => {
          const nav=document.activeElement;
          if(!nav || !nav.matches('.nav-item') || nav.classList.contains('active')) return null;
          const c=getComputedStyle(nav); return {shadow:c.boxShadow,outline:c.outlineStyle,width:c.outlineWidth};
        })()`);
        if (focus) break;
      }
    } finally {
      try { focusDebugger.detach(); } catch (e) { /* ignore */ }
    }
    check('عنصر التنقل غير النشط يظهر إطار تركيز واضحاً', focus && (focus.shadow !== 'none' || (focus.outline !== 'none' && parseFloat(focus.width) > 0)), focus);

    const debuggerApi = win.webContents.debugger;
    debuggerApi.attach('1.3');
    try {
      await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(100);
      const reduced = await js(`(() => {
        const btn=document.querySelector('.btn'); const view=document.querySelector('.view.active'); const tile=document.querySelector('.nav-item .t3d');
        const sec=(v)=>{const n=parseFloat(v||'0');return v&&String(v).includes('ms')?n/1000:n;};
        return {button:sec(getComputedStyle(btn).transitionDuration),view:sec(getComputedStyle(view).animationDuration),tile:sec(getComputedStyle(tile).transitionDuration)};
      })()`);
      check('وضع تقليل الحركة يلغي انتقالات الأزرار', reduced && reduced.button <= 0.001, reduced);
      check('وضع تقليل الحركة يلغي حركة دخول الشاشة', reduced && reduced.view <= 0.001, reduced);
      check('وضع تقليل الحركة يلغي حركة الأيقونات', reduced && reduced.tile <= 0.001, reduced);
    } finally {
      try { await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } catch (e) { /* ignore */ }
      try { debuggerApi.detach(); } catch (e) { /* ignore */ }
    }

    check('لا أخطاء في وحدة التحكم', errors.length === 0, errors);
    await shutdown(fail ? 1 : 0);
  } catch (error) {
    console.log('FATAL: ' + (error && error.stack ? error.stack : error));
    await shutdown(1);
  }
});
