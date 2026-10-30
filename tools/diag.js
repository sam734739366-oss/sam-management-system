const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'diag.txt');
const lines = [];
const log = (s) => { lines.push(s); fs.writeFileSync(OUT, lines.join('\n')); };

process.env.SAM_DATA_DIR = path.join(ROOT, '.tmp', 'datad');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => null);
require(path.join(ROOT, 'src', 'main', 'db.js')).init(process.env.SAM_DATA_DIR);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 880, show: false, webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    log(`[console L${d.level}] ${d.source}:${d.lineNumber} ${d.message}`);
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/app.html'));
  await new Promise((r) => setTimeout(r, 1500));
  const info = await win.webContents.executeJavaScript(`({
    SamUI: typeof SamUI,
    combo: typeof (window.SamUI && SamUI.combo),
    SamItems: typeof SamItems,
    SamWarehouses: typeof SamWarehouses,
    SamParties: typeof SamParties,
    SamDocs: typeof SamDocs,
    scripts: [...document.scripts].map(s => s.src.split('/').pop()),
    loadErrors: window.__loadErrors || null
  })`, true);
  log('globals: ' + JSON.stringify(info, null, 1));

  // now try openEditor synchronously and capture any thrown exception
  const err = await win.webContents.executeJavaScript(`(() => {
    try {
      window.SamDocs.openEditor(null);
      return 'called ok, modal.editor present = ' + !!document.querySelector('.modal.editor');
    } catch (e) { return 'THREW: ' + e.message + ' | ' + (e.stack || '').split('\\n').slice(0, 4).join(' << '); }
  })()`, true);
  log('openEditor -> ' + err);

  app.exit(0);
});
