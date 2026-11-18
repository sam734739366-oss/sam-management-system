/**
 * tools/v9-what-he-sees.js — evidence from HIS data, in the real window.
 *
 * He says the invoice value and the notes do not show. Before changing
 * anything, print exactly what the screen renders: the active period, the
 * row count, every header, and the text of the value and note cells.
 * Runs on a COPY of his data — the live file is never opened.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LIVE = path.join(process.env.APPDATA || '', 'SAM Management System');
const DATA = path.join(ROOT, '.tmp', `sees-${process.pid}`);
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.SAM_DATA_DIR = DATA;
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.message)); app.exit(1); });

app.whenReady().then(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of ['sam.db', 'sam.db-wal']) {
    const s = path.join(LIVE, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DATA, f));
  }
  if (fs.existsSync(path.join(LIVE, 'images'))) {
    fs.cpSync(path.join(LIVE, 'images'), path.join(DATA, 'images'), { recursive: true });
  }

  const db = require(path.join(ROOT, 'src', 'main', 'db.js'));
  db.init(DATA);
  let win;
  require(path.join(ROOT, 'src', 'main', 'ipc-db'))();
  require(path.join(ROOT, 'src', 'main', 'ipc-auth'))(() => win);
  require(path.join(ROOT, 'src', 'main', 'ipc'))(() => win);
  win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const js = (c) => win.webContents.executeJavaScript(c, true);

  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(900);
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(1800);
  await js(`localStorage.removeItem('sam.docreports.v1')`);
  await js(`document.querySelector('.nav-item[data-view=reports]').click()`);
  await sleep(2000);

  const dump = async (label) => {
    const d = await js(`(() => {
      const heads = [...document.querySelectorAll('#drTbl thead th')].map(t => t.textContent.trim());
      const rows = [...document.querySelectorAll('#drTbl tbody tr.dr-row')].slice(0, 3)
        .map(tr => [...tr.children].map(td => td.textContent.trim()));
      const st = SamDocReports.state;
      return {
        kind: st.kind, mode: st.mode, period: st.period, from: st.from, to: st.to,
        rowCount: document.querySelectorAll('#drTbl tbody tr.dr-row').length,
        heads, rows,
        totals: document.getElementById('drTotals').textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
        cols: [...document.querySelectorAll('#drCols .col-check')].map(l => [l.textContent.trim(), l.querySelector('input').checked]),
        fit: document.getElementById('drFitNote').textContent.replace(/\\s+/g, ' ').trim().slice(0, 200)
      };
    })()`);
    console.log('\n===== ' + label + ' =====');
    console.log(JSON.stringify(d, null, 1));
  };

  await dump('AS IT OPENS (default period)');
  await js(`(() => { const b=[...document.querySelectorAll('#drPeriods .dr-chip')].find(x=>/كل الفترات/.test(x.textContent)); if(b) b.click(); return 1; })()`);
  await sleep(1800);
  await dump('ALL PERIODS, sale, detail');
  await js(`(() => { const b=[...document.querySelectorAll('#drMode button')].find(x=>x.dataset.mode==='summary'); if(b) b.click(); return 1; })()`);
  await sleep(1500);
  await dump('ALL PERIODS, sale, summary');

  console.log('\n===== the raw values in his database =====');
  db.listDocuments({ kind: 'sale' }).slice(0, 5).forEach((d) => {
    const full = db.getDocument(d.id);
    console.log(`  ${d.doc_no} ext=${d.external_no} date=${d.doc_date} value=${JSON.stringify(full.invoice_value)} notes=${JSON.stringify(full.notes)} lineNotes=${JSON.stringify((full.lines || []).map((l) => l.note))}`);
  });

  try { db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.exit(0);
});