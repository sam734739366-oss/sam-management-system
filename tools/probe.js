const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

ipcMain.handle('nav:toMain', (e) => { BrowserWindow.fromWebContents(e.sender).loadFile(path.join(ROOT, 'src/renderer/app.html')); return true; });
ipcMain.handle('nav:toLogin', (e) => { BrowserWindow.fromWebContents(e.sender).loadFile(path.join(ROOT, 'src/renderer/login.html')); return true; });
ipcMain.handle('app:info', () => ({ version: 'probe', electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, appData: ROOT }));
ipcMain.handle('win:minimize', () => true);
ipcMain.handle('win:maximize', () => true);
ipcMain.handle('win:close', () => true);
ipcMain.handle('win:isMaximized', () => false);
ipcMain.handle('win:print', () => ({ ok: true }));
ipcMain.handle('win:savePdf', () => ({ ok: false, canceled: true }));
ipcMain.handle('app:openPath', () => true);
ipcMain.handle('app:relaunch', () => true);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, frame: false, webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/login.html'));
  await sleep(1500);
  const out = await win.webContents.executeJavaScript(`(() => {
    const r = (s) => { const n = document.querySelector(s); if (!n) return null; const b = n.getBoundingClientRect(); const c = getComputedStyle(n); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), maxH: c.maxHeight, height: c.height, transform: c.transform.slice(0,24), blend: c.mixBlendMode }; };
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      wrap: r('.bottle-wrap'),
      bottle: r('.bottle'),
      stage: r('.stage'),
      brand: r('.brand'),
      card: r('.login-card'),
      natural: { w: document.getElementById('bottle').naturalWidth, h: document.getElementById('bottle').naturalHeight },
      sheets: [...document.styleSheets].map(s => { try { return { href: (s.href||'').split('/').pop(), rules: s.cssRules.length } } catch(e) { return { href: s.href, err: e.message } } })
    };
  })()`, true);
  console.log(JSON.stringify(out, null, 2));
  await win.webContents.executeJavaScript(`document.fonts.ready.then(()=>1)`);
  const fonts = await win.webContents.executeJavaScript(`[...document.fonts].map(f=>f.family+' '+f.weight+' '+f.status).join('\\n')`, true);
  console.log('FONTS:\n' + fonts);
  app.exit(0);
});
