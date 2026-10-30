'use strict';

/* =====================================================================
   Main window behaviour — navigation, chrome, dashboard
   ===================================================================== */

const { el, icon, esc, toast, bindRow, modal, confirmHardDelete } = SamUI;

const PHASES = [
  { n: 1, t: 'الواجهة وشاشة الدخول المتحركة', view: 'dashboard', state: 'done' },
  { n: 2, t: 'قاعدة البيانات + الأصناف + المخازن + العملاء والموردون', view: 'items', state: 'done' },
  { n: 3, t: 'العمليات + تصريح الخروج + التحويلات', view: 'transactions', state: 'done' },
  { n: 4, t: 'الإنتاج: صرف واستلام بتوجيه تلقائي', view: 'production', state: 'done' },
  { n: 5, t: 'مركز التقارير الديناميكي', view: 'reports', state: 'done' },
  { n: 6, t: 'المستخدمون + الصلاحيات + النسخ الاحتياطي + Google Drive', view: 'settings', state: 'now' },
  { n: 7, t: 'البناء النهائي + التحديث التلقائي', view: null, state: 'next' }
];

const VIEW_PHASE = { dashboard: 1, items: 2, warehouses: 2, parties: 2, transactions: 3, production: 4, reports: 5, settings: 2 };
const VIEW_TITLE = {
  dashboard: 'لوحة التحكم',
  items: 'الأصناف',
  warehouses: 'المخازن',
  parties: 'العملاء والموردين',
  transactions: 'العمليات',
  production: 'الإنتاج',
  reports: 'التقارير',
  settings: 'الإعدادات'
};
const LOADERS = {
  items: () => window.SamItems && window.SamItems.load(),
  warehouses: () => window.SamWarehouses && window.SamWarehouses.load(),
  parties: () => window.SamParties && window.SamParties.load(),
  transactions: () => window.SamDocs && window.SamDocs.load(),
  production: () => window.SamProd && window.SamProd.load(),
  reports: () => window.SamReports && window.SamReports.load(),
  settings: () => window.SamSettings && SamSettings.showTab(SamSession.isAdmin() ? 'general' : 'general'),
  dashboard: () => loadDashboard()
};

/* ---------------- navigation ---------------- */
let currentView = 'dashboard';

function go(view) {
  if (!VIEW_TITLE[view]) return false;
  if (SamSession.user && !SamSession.can(view, 'view')) {
    toast(`لا تملك صلاحية الدخول إلى «${VIEW_TITLE[view]}»`, 'bad');
    return false;
  }
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = document.getElementById(`v-${view}`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('tbTitle').textContent = VIEW_TITLE[view];
  document.getElementById('content').scrollTop = 0;
  if (LOADERS[view]) LOADERS[view]();
  return true;
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  go(btn.dataset.view);
});

/* ---------------- permissions in the UI ---------------- */
const PERM_BUTTONS = [
  ['#btnAddItem', 'items', 'add'],
  ['#btnSmartSearch', 'items', 'view'],
  ['#btnAddWh', 'warehouses', 'add'],
  ['#btnAddParty', 'parties', 'add'],
  ['#btnNewDoc', 'transactions', 'add'],
  ['#btnNewIssue', 'production', 'add'],
  ['#btnNewReceipt', 'production', 'add'],
  ['#btnSaveRouting', 'production', 'edit'],
  ['#btnGoItems', 'items', 'add'],
  ['#btnGoParties', 'parties', 'add'],
  ['#btnAddUser', 'settings', 'manage']
];

function applyPermissions() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const view = b.dataset.view;
    b.style.display = SamSession.can(view, 'view') ? '' : 'none';
  });
  PERM_BUTTONS.forEach(([sel, screen, action]) => {
    const node = document.querySelector(sel);
    if (node) node.style.display = SamSession.can(screen, action) ? '' : 'none';
  });
  if (!SamSession.can('dashboard', 'view')) {
    const next = document.querySelector('.nav-item:not([style*="none"])');
    if (next) go(next.dataset.view);
  }
  if (window.SamSettings) SamSettings.applyPermissions();
}

function fillUserChip() {
  const u = SamSession.user;
  if (!u) return;
  document.getElementById('tbUser').textContent = u.username;
  document.getElementById('tbRole').textContent = u.role === 'admin' ? 'مدير النظام' : 'مستخدم';
  document.getElementById('userChip').title =
    `${u.full_name || u.username} — ${u.role === 'admin' ? 'صلاحيات كاملة' : `الشاشات: ${u.screens.join('، ')}`}`;
  document.querySelector('#userChip .avatar').textContent = (u.full_name || u.username).trim().charAt(0);
}

/* ---------------- placeholder screens ---------------- */
function renderPlaceholders() {
  document.querySelectorAll('.soon').forEach((box) => {
    const phase = box.dataset.phase;
    const points = (box.dataset.points || '').split('|').filter(Boolean);
    box.innerHTML = `
      <div class="s-ic">${icon('i-warn')}</div>
      <div>
        <h3>${esc(box.dataset.title || '')}</h3>
        <span class="s-phase">يتم بناؤها في المرحلة ${esc(phase)}</span>
      </div>
      <ul>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  });

  // every screen is live from phase 5 on: drop the "coming in phase N" badges
  document.querySelectorAll('.nav-item .ph').forEach((n) => n.remove());
}

/* ---------------- roadmap ---------------- */
function renderRoadmap() {
  const host = document.getElementById('roadmap');
  host.innerHTML = '';
  PHASES.forEach((p) => {
    const li = el('li', p.state === 'now' ? 'now' : p.state === 'done' ? 'done' : '');
    const st = p.state === 'done' ? 'مكتملة' : p.state === 'now' ? 'قيد المراجعة الآن' : 'قادمة';
    li.innerHTML = `<span class="n">${p.n}</span><span>${esc(p.t)}</span><span class="st">${st}</span>`;
    if (p.view) {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => go(p.view));
    }
    host.appendChild(li);
  });
}

/* ---------------- dashboard ---------------- */
async function loadDashboard() {
  let s;
  try { s = await SamDB.call('summary'); } catch (e) { return toast(e.message, 'bad'); }
  document.getElementById('kpiItems').textContent = SamDB.fmt(s.items);
  document.getElementById('kpiStock').textContent = SamDB.fmt(s.mainPieces);
  document.getElementById('kpiStockNote').textContent =
    `سليم ${SamDB.fmt(s.mainGood)} · تالف ${SamDB.fmt(s.mainDefect)} · محجوز ${SamDB.fmt(s.mainHeld)}`;
  document.getElementById('kpiDocs').textContent = SamDB.fmt(s.todayMoves);
  document.getElementById('kpiAlerts').textContent = SamDB.fmt(s.alerts);
  document.getElementById('sbDb').textContent = `الأصناف ${s.items} · المخازن ${s.warehouses} · الأطراف ${s.parties} · الحركات ${s.moves}`;

  renderMoves();
  renderAlerts();
}

const DOC_AR = { opening: 'رصيد افتتاحي', purchase: 'مشتريات', sale: 'مبيعات', sale_return: 'مرتجع مبيعات', purchase_return: 'مرتجع مشتريات', transfer: 'تحويل', issue: 'صرف إنتاج', receipt: 'استلام إنتاج' };

async function renderMoves() {
  let rows = [];
  try { rows = await SamDB.call('listRecentMoves', 12); } catch (e) { return toast(e.message, 'bad'); }
  const tb = document.querySelector('#movesTbl tbody');
  tb.innerHTML = '';
  rows.forEach((m, idx) => {
    const tr = el('tr');
    const plus = m.piece_delta >= 0;
    tr.innerHTML = `
      <td class="num">${idx + 1}</td>
      <td>${esc(m.itemCode)} — ${esc(m.itemName)}</td>
      <td>${esc(m.warehouseName)}</td>
      <td>${esc(DOC_AR[m.doc_type] || m.doc_type)} <span class="chip sub">${esc(bucketAr(m.bucket))}</span></td>
      <td class="num qty ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${SamDB.fmt(Math.abs(m.piece_delta))}</td>
      <td>${esc(m.created_at)}</td>`;
    bindRow(tr, {
      view: () => viewMove(m),
      del: () => removeMove(m)
    });
    tb.appendChild(tr);
  });
  document.getElementById('movesEmpty').style.display = rows.length ? 'none' : 'block';
}

function bucketAr(b) {
  return { good: 'سليم', defect: 'تالف', held: 'محجوز' }[b] || b;
}

function viewMove(m) {
  modal({
    title: `حركة المخزون #${m.id}`,
    width: 'min(600px, 94vw)',
    body: `<dl class="info">
      <dt>الصنف</dt><dd>${esc(m.itemCode)} — ${esc(m.itemName)}</dd>
      <dt>المخزن</dt><dd>${esc(m.warehouseName)}${m.warehouseKind === 'main' ? ' (رئيسي)' : ''}</dd>
      <dt>النوع</dt><dd>${esc(DOC_AR[m.doc_type] || m.doc_type)}</dd>
      <dt>الحالة</dt><dd>${esc(bucketAr(m.bucket))}</dd>
      <dt>الكمية (حبة)</dt><dd>${SamDB.fmt(m.piece_delta)}</dd>
      <dt>كراتين</dt><dd>${SamDB.fmt(m.carton_qty)}</dd>
      <dt>أكياس</dt><dd>${SamDB.fmt(m.bag_qty)}</dd>
      <dt>رقم المستند</dt><dd>${esc(m.doc_no || '—')}</dd>
      <dt>التاريخ</dt><dd>${esc(m.created_at)}</dd>
      <dt>ملاحظة</dt><dd>${esc(m.note || '—')}</dd>
    </dl>`,
    actions: [
      { label: 'حذف نهائي', value: 'del', kind: 'btn-danger', icon: 'i-trash' },
      { label: 'إغلاق', value: 'close', kind: 'btn-ghost' }
    ]
  }).then((v) => { if (v === 'del') removeMove(m); });
}

async function removeMove(m) {
  const yes = await confirmHardDelete({
    docNo: m.doc_no || `حركة #${m.id}`,
    docType: DOC_AR[m.doc_type] || m.doc_type,
    lines: [{
      item: `${m.itemCode} — ${m.itemName}`,
      wh: m.warehouseName,
      dir: m.piece_delta >= 0 ? 'خصم (عكس زيادة)' : 'إضافة (عكس خصم)',
      qty: SamDB.fmt(Math.abs(m.piece_delta))
    }],
    extra: `<p style="margin-top:10px;font-size:13px">الحذف يعكس أثر الحركة على رصيد «${esc(bucketAr(m.bucket))}» فوراً.</p>`
  });
  if (yes !== 'yes') return;
  try {
    await SamDB.call('deleteMove', m.id);
    toast('تم حذف الحركة نهائياً وعكس أثرها على المخزون', 'bad', 4200);
    SamUI.bus.emit();
    loadDashboard();
  } catch (e) { toast(e.message, 'bad'); }
}

async function renderAlerts() {
  let items = [];
  try { items = await SamDB.call('listItems', ''); } catch (e) { return; }
  const rows = items.filter((i) => i.alertLowGood || i.alertHighDefect);
  const tb = document.querySelector('#alertsTbl tbody');
  tb.innerHTML = '';
  rows.forEach((i) => {
    const tr = el('tr');
    const kind = i.alertLowGood
      ? `<span class="chip bad">جيد ${SamDB.fmt(i.mainStock.good)} تحت الحد ${SamDB.fmt(i.min_good_alert)}</span>`
      : `<span class="chip warn">تالف ${SamDB.fmt(i.mainStock.defect)} تجاوز الحد ${SamDB.fmt(i.max_defect_alert)}</span>`;
    tr.innerHTML = `<td>${esc(i.code)} — ${esc(i.name)}</td>
      <td class="num"><bdi>${SamDB.fmt(i.mainStock.good)}</bdi> / <bdi>${SamDB.fmt(i.mainStock.defect)}</bdi> / <bdi>${SamDB.fmt(i.mainStock.held)}</bdi></td>
      <td>${kind}</td>`;
    bindRow(tr, { view: () => go('items'), edit: () => { go('items'); window.SamItems.openForm(i); } });
    tb.appendChild(tr);
  });
  document.getElementById('alertsEmpty').style.display = rows.length ? 'none' : 'block';
  document.getElementById('alertCount').textContent = rows.length;
}

document.getElementById('btnGoItems').addEventListener('click', () => {
  go('items');
  window.SamItems.openForm(null);
});
document.getElementById('btnGoParties').addEventListener('click', () => {
  go('parties');
  window.SamParties.openForm(null);
});

/* ---------------- window chrome ---------------- */
document.getElementById('btnMin').addEventListener('click', () => sam.win.minimize());
document.getElementById('btnMax').addEventListener('click', () => sam.win.maximize());
document.getElementById('btnClose').addEventListener('click', () => sam.win.close());
sam.on('win:maximized', (max) => {
  document.getElementById('btnMax').title = max ? 'استعادة' : 'تكبير';
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  const v = await modal({
    title: 'تسجيل الخروج',
    body: '<p>سيتم إغلاق الجلسة الحالية والعودة لشاشة الدخول. البيانات محفوظة في قاعدة SQLite.</p>',
    actions: [
      { label: 'خروج', value: 'yes', kind: 'btn-danger', icon: 'i-exit' },
      { label: 'بقاء', value: 'no', kind: 'btn-ghost' }
    ]
  });
  if (v === 'yes') {
    const res = await sam.auth.logout();
    if (!res || !res.ok) sam.nav.toLogin();
  }
});

/* ---------------- settings ---------------- */
async function fillSysInfo() {
  const info = await sam.app.info();
  document.getElementById('sysInfo').innerHTML = [
    ['إصدار النظام', `v${info.version}`],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node', info.node],
    ['نظام التشغيل', info.platform]
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  document.getElementById('dbInfo').innerHTML = [
    ['الملف', info.dbPath || '—'],
    ['المحرك', 'SQLite (better-sqlite3)'],
    ['الجداول', 'items · warehouses · stock_moves · parties · documents · doc_lines · production · users'],
    ['وحدة الحساب', 'الحبة (الكرتونة والكيس معلوماتيتان)']
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  document.getElementById('dbInfo').dataset.path = info.dbPath || '';

  document.getElementById('sbVer').textContent = `Electron ${info.electron}`;
  document.getElementById('tbVer').textContent = `v${info.version}`;
}

document.getElementById('btnOpenDbFolder').addEventListener('click', () => {
  const p = document.getElementById('dbInfo').dataset.path;
  if (p) sam.app.openPath(p.replace(/[\\/][^\\/]+$/, ''));
});
document.getElementById('btnReplayIntro').addEventListener('click', () => sam.nav.toLogin());

/* ---------------- clock ---------------- */
function tickClock() {
  const now = new Date();
  document.getElementById('tbClock').textContent = now.toLocaleTimeString('ar-EG-u-nu-latn', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  document.getElementById('greetSub').textContent =
    `أهلاً بك في نظام SAM — ${now.toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
}

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    await SamSession.init();
  } catch (e) {
    console.error('session init failed', e);
  }
  if (!SamSession.user) {
    // opened without a session: back to the login screen
    sam.nav.toLogin();
    return;
  }
  fillUserChip();
  renderPlaceholders();
  renderRoadmap();
  applyPermissions();
  fillSysInfo();
  tickClock();
  setInterval(tickClock, 1000);
  if (SamSession.can('dashboard', 'view')) go('dashboard');
  else {
    const first = SamSession.meta.screens.find((s) => SamSession.can(s.key, 'view'));
    go(first ? first.key : 'settings');
  }
})();
