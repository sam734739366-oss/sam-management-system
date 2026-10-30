/**
 * tools/shot6.js — smoke test for phase 6: users, roles, permissions,
 * local backup and Google Drive folder sync.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'shots6');
const DATA = path.join(ROOT, '.tmp', 'data6');
const DRIVE = path.join(ROOT, '.tmp', 'drive');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const dbMod = require(path.join(ROOT, 'src', 'main', 'db.js'));
const session = require(path.join(ROOT, 'src', 'main', 'session.js'));
const backup = require(path.join(ROOT, 'src', 'main', 'backup.js'));

async function rmRetry(target, { tries = 8, base = 100, label = target } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return true;
    } catch (e) {
      if (attempt === tries) { console.warn(`WARN: ${label} still locked after ${tries} tries (${e.code})`); return false; }
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  return false;
}

let win;
let cleanedUp = false;
async function shutdown(code = 0) {
  if (!cleanedUp) {
    cleanedUp = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    dbMod.close();
    await rmRetry(DATA, { label: 'temp data dir' });
    await rmRetry(DRIVE, { label: 'fake drive dir' });
  }
  app.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('unhandledRejection', (e) => {
  console.log('UNHANDLED: ' + (e && e.message ? e.message : e));
  if (errors.length) console.log('RENDERER ERRORS:\n' + errors.join('\n'));
  shutdown(1);
});
app.on('will-quit', (e) => { if (!cleanedUp) { e.preventDefault(); shutdown(errors.length ? 1 : 0); } });

process.env.SAM_DATA_DIR = DATA;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(path.join(ROOT, 'src', 'main', 'ipc-db.js'))();
require(path.join(ROOT, 'src', 'main', 'ipc-auth.js'))(() => win);
require(path.join(ROOT, 'src', 'main', 'ipc.js'))(() => win);

async function shot(name, settle = 1200) {
  await sleep(settle);
  if (!win || win.isDestroyed()) return;
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log('shot ->', name);
}

app.whenReady().then(async () => {
  dbMod.close();
  await rmRetry(DATA);
  await rmRetry(OUT, { tries: 4 });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(DRIVE, { recursive: true });
  dbMod.init(DATA);
  const seeded = session.ensureSeed();
  console.log('default admin created:', seeded);

  /* master data so reports/permissions have something to touch */
  const main = dbMod.getMainWarehouse();
  dbMod.addItem({ code: '0001', name: 'مياه جلدلة 1.5 لتر', base_unit: 'حبة', category: 'خام', pieces_per_carton: 12, pieces_per_bag: 0, min_good_alert: 500, max_defect_alert: 200 },
    [{ warehouseId: main.id, good: 24000 }]);
  dbMod.addParty({ name: 'موزع الرياض', phone: '0555123456', type: 'customer' });

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#0b1433',
    webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && a[0].level != null ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], source: a[4] };
    const lvl = typeof d.level === 'string' ? ({ error: 3, warning: 2, log: 0, info: 0 })[d.level] ?? d.level : d.level;
    if (lvl >= 2) errors.push(`[console] ${d.source || ''}:${d.lineNumber || ''} ${d.message}`);
  });
  win.webContents.on('did-fail-load', (_e, c, m, u) => errors.push(`[load] ${c} ${m} ${u}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`[gone] ${JSON.stringify(d)}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const step = async (label, code) => {
    try { console.log('  ' + label + ' -> ' + JSON.stringify(await js(code))); }
    catch (e) { console.log('  ' + label + ' FAILED: ' + e.message); throw e; }
  };

  /* ---------- 1) wrong password must be rejected ---------- */
  await win.loadFile(path.join(RENDERER, 'login.html'));
  await sleep(1000);
  await step('wrong password', `(() => {
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'wrong';
    document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    return 'submitted';
  })()`);
  await sleep(900);
  await step('error shown', `document.getElementById('loginError').textContent`);
  await shot('p6-01-login-rejected');

  /* ---------- 2) real login as admin ---------- */
  await step('admin login', `sam.auth.login('admin','admin123').then(r => r.ok ? r.data.username + '/' + r.data.role : 'FAIL ' + r.error)`);
  await sleep(1500);
  await step('session + chip', `({ user: SamSession.user && SamSession.user.username, role: SamSession.user && SamSession.user.role, chip: document.getElementById('tbUser').textContent, isAdmin: SamSession.isAdmin() })`);
  await shot('p6-02-admin-dashboard');

  /* ---------- 3) create a restricted user through the UI ---------- */
  await js(`document.querySelector('.nav-item[data-view=settings]').click()`);
  await sleep(700);
  await js(`document.querySelector('#settingsTabs .tab[data-tab=users]').click()`);
  await sleep(900);
  await step('users table', `[...document.querySelectorAll('#usersTbl tbody tr')].map(t=>t.children[1].textContent.trim())`);
  await js(`document.getElementById('btnAddUser').click()`);
  await sleep(800);
  await step('fill new user', `(() => {
    const m = document.querySelector('.modal');
    const ins = [...m.querySelectorAll('.form-grid input.input')];
    ins[0].value = 'store1';
    ins[1].value = 'موظف المخزن';
    ins[2].value = 'store123';
    [...m.querySelectorAll('input[type=radio]')][1].checked = true;   // role = user
    const cells = [...m.querySelectorAll('.perm-grid')][0];
    [...cells.querySelectorAll('input')].forEach(c => { c.checked = ['items','reports'].includes(c.value); });
    const permCells = [...m.querySelectorAll('.perm-grid')][1];
    [...permCells.querySelectorAll('input')].forEach(c => { c.checked = ['view','add'].includes(c.value); });
    m.querySelector('.modal-foot .btn-primary').click();
    return 'saved';
  })()`);
  await sleep(1200);
  await step('users after add', `[...document.querySelectorAll('#usersTbl tbody tr')].map(t=>[t.children[1].textContent.trim(), t.children[3].textContent.trim(), t.children[4].textContent.trim(), t.children[5].textContent.trim()])`);
  await shot('p6-03-users-admin');

  /* ---------- 4) backup + sync ---------- */
  await js(`document.querySelector('#settingsTabs .tab[data-tab=backup]').click()`);
  await sleep(900);
  await step('backup now', `sam.backup.now().then(r => r.ok ? 'ok ' + r.data.path.split(/[\\\\/]/).pop() : 'FAIL ' + r.error)`);
  await step('list backups', `sam.backup.list().then(r => r.data.map(b => b.name))`);
  await step('configure sync folder', `sam.sync.setConfig({ folder: ${JSON.stringify(DRIVE)}, auto: true }).then(r => r.ok ? r.data.folder : 'FAIL ' + r.error)`);
  await step('sync now', `sam.sync.now().then(r => r.ok ? Object.keys(r.data).join(',') : 'FAIL ' + r.error)`);
  await sleep(600);
  await shot('p6-04-backup-sync');
  const driveFiles = fs.readdirSync(path.join(DRIVE, 'SAM-Backups'));
  console.log('  drive folder contains:', JSON.stringify(driveFiles));
  const localBackups = fs.readdirSync(path.join(DATA, 'backups'));
  console.log('  local backups:', JSON.stringify(localBackups));

  /* ---------- 5) logout, login as the restricted user ---------- */
  await step('logout', `sam.auth.logout().then(r => r.ok ? 'logged out' : 'FAIL')`);
  await sleep(1500);
  await step('restricted login', `sam.auth.login('store1','store123').then(r => r.ok ? r.data.role + ' screens=' + r.data.screens.join(',') : 'FAIL ' + r.error)`);
  await sleep(1600);
  await step('visible nav items', `[...document.querySelectorAll('.nav-item')].filter(b => b.style.display !== 'none').map(b => b.dataset.view)`);
  await step('permission checks', `({
    itemsView: SamSession.can('items','view'),
    itemsDelete: SamSession.can('items','delete'),
    warehousesView: SamSession.can('warehouses','view'),
    reportsAdd: SamSession.can('reports','add'),
    usersManage: SamSession.can('settings','manage')
  })`);
  await step('try a forbidden delete via IPC', `SamDB.call('deleteItem', 1).then(() => 'DELETED (BAD)').catch(e => 'DENIED: ' + e.message)`);
  await sleep(500);
  await step('stock still intact', `SamDB.call('listItems','').then(r => r.map(i => [i.code, i.mainStock.good]))`);
  await shot('p6-05-restricted-user');

  /* ---------- 6) change own password ---------- */
  await step('change own password', `sam.auth.changePassword('store123','newpass77').then(() => 'changed')`);
  await step('old password now fails', `sam.auth.login('store1','store123').then(r => r.ok ? 'ACCEPTED (BAD)' : 'REJECTED: ' + r.error)`);
  await sleep(700);
  await step('new password works', `sam.auth.login('store1','newpass77').then(r => r.ok ? 'ok' : 'FAIL ' + r.error)`);

  /* ---------- 7) guard: cannot delete the last admin ---------- */
  await js(`sam.auth.login('admin','admin123')`);
  await sleep(1400);
  const storeId = dbMod.getUserByUsername('store1').id;
  const adminId = dbMod.getUserByUsername('admin').id;
  await step('remove restricted user', `sam.users.remove(${storeId}).then(r => r.ok ? 'removed' : 'FAIL ' + r.error)`);
  await step('cannot remove last admin', `sam.users.remove(${adminId}).then(r => r.ok ? 'REMOVED (BAD)' : 'BLOCKED: ' + r.error)`);

  console.log('users left:', JSON.stringify(dbMod.listUsers().map((u) => [u.username, u.role])));
  const code = errors.length ? 1 : 0;
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no renderer errors');
  await shutdown(code);
});
