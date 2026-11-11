'use strict';

/* =====================================================================
   Main window behaviour — navigation, chrome, dashboard, shortcuts
   ===================================================================== */

const { el, icon, esc, toast, bindRow, modal, confirmHardDelete } = SamUI;

/** what V5 changed — shown on the dashboard so the update is self-documenting */
const V5_CHANGES = [
  { t: 'التصميم انضغط: خطوط ومربعات أصغر في كل الشاشات — النصوص واضحة والمساحات مستعملة', view: null },
  { t: 'كل أيقونة صارت ثلاثية الأبعاد وملوّنة بلونها — والمربعات صغيرة ومنظمة', view: null },
  { t: 'الصفحات مرنة: تتكيّف مع عرض الشاشة بلا تمرير أفقي ولا عناصر مقصوصة', view: null },
  { t: 'معاينة الطباعة قبل الطباعة: ترى الورقة كما ستخرج تماماً، مع تكبير وتصغير', view: 'reports' },
  { t: 'الطباعة على A4 واضحة وداكنة، والتقرير يملأ صفحة واحدة مرتّبة', view: 'reports' },
  { t: 'التصريح الواحد بنصف ورقة A5 بالعرض — تصريحتان في ورقة واحدة', view: 'transactions' },
  { t: 'صفحة إدخال الصنف: كل المربعات متساوية في العرض والارتفاع ومنظمة', view: 'items' },
  { t: 'تعديل أي مستند يسجّل بتاريخ اليوم — وتاريخ الإنشاء الأصلي يبقى محفوظاً', view: 'transactions' },
  { t: 'مزامنة Google Drive: تكتب بريدك فقط فيكتشف البرنامج حسابك ويكتب النسخة فيه', view: 'settings' }
];

const VIEW_TITLE = {
  dashboard: 'لوحة التحكم',
  items: 'الأصناف',
  warehouses: 'المخازن',
  parties: 'العملاء والموردين',
  transactions: 'العمليات',
  production: 'الإنتاج',
  daily: 'التقرير اليومي',
  reports: 'التقارير',
  settings: 'الإعدادات'
};
/**
 * screens that borrow another screen's permission.
 * the daily report is part of «التقارير» — whoever may see the reports
 * may see the daily report, with no new checkbox in the user screen.
 */
const PERM_SCREEN = { daily: 'reports' };
const permScreen = (view) => PERM_SCREEN[view] || view;
const LOADERS = {
  items: () => window.SamItems && window.SamItems.load(),
  warehouses: () => window.SamWarehouses && window.SamWarehouses.load(),
  parties: () => window.SamParties && window.SamParties.load(),
  transactions: () => window.SamDocs && window.SamDocs.load(),
  production: () => window.SamProd && window.SamProd.load(),
  daily: () => window.SamDaily && window.SamDaily.load(),
  reports: () => window.SamReports && window.SamReports.load(),
  settings: () => SamSettings.showTab('general'),
  dashboard: () => loadDashboard()
};
/** Ctrl+N target per screen */
const NEW_ACTIONS = {
  items: () => window.SamItems && window.SamItems.openForm(null),
  warehouses: () => window.SamWarehouses && window.SamWarehouses.openForm(null),
  parties: () => window.SamParties && window.SamParties.openForm(null),
  transactions: () => window.SamDocs && window.SamDocs.openEditor(null),
  production: () => window.SamProd && window.SamProd.newFromTab(),
  daily: () => window.SamDaily && window.SamDaily.run(),
  reports: () => window.SamReports && window.SamReports.run()
};

/* ---------------- navigation ---------------- */
let currentView = 'dashboard';

function go(view) {
  if (!VIEW_TITLE[view]) return false;
  if (SamSession.user && !SamSession.can(permScreen(view), 'view')) {
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

/* global shortcuts: Ctrl+N follows the visible screen, F5 refreshes it */
SamUI.pushKeys({
  new: () => {
    const fn = NEW_ACTIONS[currentView];
    if (!fn) return toast('لا توجد شاشة «جديد» هنا', 'warn');
    if (!SamSession.can(currentView, 'add') && currentView !== 'reports' && currentView !== 'daily') return toast('لا تملك صلاحية الإضافة', 'bad');
    fn();
  },
  refresh: () => { if (LOADERS[currentView]) LOADERS[currentView](); }
});

/* ---------------- permissions in the UI ---------------- */
const PERM_BUTTONS = [
  ['#btnAddItem', 'items', 'add'],
  ['#btnSmartSearch', 'items', 'view'],
  ['#btnAddWh', 'warehouses', 'add'],
  ['#btnAddParty', 'parties', 'add'],
  ['#btnNewDoc', 'transactions', 'add'],
  ['#btnNewIssue', 'production', 'add'],
  ['#btnNewTolling', 'production', 'add'],
  ['#btnNewArchive', 'production', 'add'],
  ['#btnNewReceipt', 'production', 'add'],
  ['#btnSaveRouting', 'production', 'edit'],
  ['#btnGoItems', 'items', 'add'],
  ['#btnGoParties', 'parties', 'add'],
  ['#btnAddUser', 'settings', 'manage']
];

function applyPermissions() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const view = b.dataset.view;
    b.style.display = SamSession.can(permScreen(view), 'view') ? '' : 'none';
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

/* ---------------- dashboard changelog ---------------- */
function renderChanges() {
  const host = document.getElementById('roadmap');
  host.innerHTML = '';
  V5_CHANGES.forEach((c, i) => {
    const li = el('li', 'done');
    li.innerHTML = `<span class="n">${i + 1}</span><span>${esc(c.t)}</span><span class="st">${c.view ? 'افتح الشاشة' : 'جاهز'}</span>`;
    if (c.view) {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => go(c.view));
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
    `سليم ${SamDB.fmt(s.mainGood)} · تالف ${SamDB.fmt(s.mainDefect)}`
    + (s.customerPieces ? ` · مادة العملاء ${SamDB.fmt(s.customerPieces)}` : '');
  document.getElementById('kpiDocs').textContent = SamDB.fmt(s.todayMoves);
  document.getElementById('kpiAlerts').textContent = SamDB.fmt(s.alerts);
  document.getElementById('sbDb').textContent =
    `الأصناف ${s.items} · المخازن ${s.warehouses} · الأطراف ${s.parties} · الحركات ${s.moves}`;

  SamUI.emptyState('movesEmpty', {
    icon: 'i-swap',
    title: 'لا توجد حركات بعد',
    hint: 'ابدأ من «الأصناف» بإضافة صنف مع رصيده الافتتاحي، أو أنشئ مستند مشتريات.',
    actionLabel: 'إضافة صنف',
    onAction: () => { go('items'); window.SamItems.openForm(null); }
  });
  SamUI.emptyState('alertsEmpty', {
    icon: 'i-check',
    title: 'لا توجد تنبيهات',
    hint: 'كل الأصناف ضمن الحدود المحددة لها.'
  });
  renderMoves();
  renderAlerts();
}

const DOC_AR = {
  opening: 'رصيد افتتاحي', purchase: 'مشتريات', sale: 'مبيعات', sale_return: 'مرتجع مبيعات',
  purchase_return: 'مرتجع مشتريات', transfer: 'نقل بين المخازن', issue: 'صرف إنتاج', receipt: 'استلام إنتاج',
  bags: 'أكياس', tolling_in: 'استلام نفخ للغير', tolling_out: 'تسليم نفخ للغير', scrap: 'هدر'
};

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
      <td>${esc(DOC_AR[m.doc_type] || m.doc_type)} <span class="chip sub">${esc(bucketAr(m.bucket))}</span>${m.is_customer ? ' <span class="chip accent">مادة العميل</span>' : ''}</td>
      <td class="num qty ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${SamDB.fmt(Math.abs(m.piece_delta))}</td>
      <td>${esc(m.move_date || m.created_at)}</td>`;
    bindRow(tr, {
      view: () => viewMove(m),
      del: () => removeMove(m)
    });
    tb.appendChild(tr);
  });
  SamUI.toggleEmpty('movesEmpty', rows.length > 0);
}

function bucketAr(b) {
  return { good: 'سليم', defect: 'تالف' }[b] || b;
}

function viewMove(m) {
  modal({
    title: `حركة المخزون #${m.id}`,
    width: 'min(600px, 94vw)',
    body: `<dl class="info">
      <dt>الصنف</dt><dd>${esc(m.itemCode)} — ${esc(m.itemName)}</dd>
      <dt>المخزن</dt><dd>${esc(m.warehouseName)}</dd>
      <dt>النوع</dt><dd>${esc(DOC_AR[m.doc_type] || m.doc_type)}</dd>
      <dt>الحالة</dt><dd>${esc(bucketAr(m.bucket))}</dd>
      <dt>الكمية (${esc(m.baseUnit || 'حبة')})</dt><dd>${SamDB.fmt(m.piece_delta)}</dd>
      <dt>كراتين</dt><dd>${SamDB.fmt(m.carton_qty)}</dd>
      <dt>أكياس</dt><dd>${SamDB.fmt(m.bag_qty)}</dd>
      <dt>المالك</dt><dd>${m.is_customer ? 'العميل (نفخ للغير)' : 'المصنع'}</dd>
      <dt>رقم المستند</dt><dd>${esc(m.doc_no || '—')}</dd>
      <dt>التاريخ</dt><dd>${esc(m.move_date || m.created_at)}</dd>
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
      <td class="num"><bdi>${SamDB.fmt(i.mainStock.good)}</bdi> / <bdi>${SamDB.fmt(i.mainStock.defect)}</bdi></td>
      <td>${kind}</td>`;
    bindRow(tr, { view: () => go('items'), edit: () => { go('items'); window.SamItems.openForm(i); } });
    tb.appendChild(tr);
  });
  SamUI.toggleEmpty('alertsEmpty', rows.length > 0);
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

/* ---------------- the guide + the update window ----------------
   Two small windows that live in the title bar: the "?" opens the guide,
   the update arrow opens the updater. The update button wears the state —
   it turns gold the moment a new version is waiting. */
document.getElementById('btnHelp').addEventListener('click', () => {
  if (window.SamGuide) window.SamGuide.open();
});
document.getElementById('btnUpdate').addEventListener('click', () => {
  if (window.SamUpdateWindow) window.SamUpdateWindow.open();
});

const UPD_TITLES = {
  idle: 'تحديث البرنامج — اضغط للفحص عن الإصدارات المتاحة',
  checking: 'جارٍ فحص الإصدارات…',
  available: 'يتوفر تحديث جديد — اضغط للتحميل',
  'up-to-date': 'أنت على أحدث إصدار',
  downloading: 'جارٍ تحميل التحديث…',
  downloaded: 'التحديث جاهز للتثبيت',
  installing: 'جارٍ التثبيت…',
  error: 'حدث خطأ في التحديث — اضغط للتفاصيل'
};
function paintUpdateBtn(s) {
  const b = document.getElementById('btnUpdate');
  if (!b || !s) return;
  b.classList.toggle('has-update', s.status === 'available' || s.status === 'downloaded');
  b.title = UPD_TITLES[s.status] || UPD_TITLES.idle;
}
sam.on('app:update-state', paintUpdateBtn);
sam.update.state().then((r) => paintUpdateBtn(r && r.ok ? r.data : r)).catch(() => {});

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
    ['الجداول', 'items · warehouses · stock_moves · parties · documents · doc_lines · production · tolling · scrap · archive · users'],
    ['وحدة الحساب', 'الوحدة الأساسية لكل صنف (الحبة) — الكرتونة والكيس معلوماتيان']
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  document.getElementById('dbInfo').dataset.path = info.dbPath || '';

  document.getElementById('sbVer').textContent = `Electron ${info.electron}`;
  document.getElementById('tbVer').textContent = `v${info.version}`;
}

document.getElementById('btnOpenDbFolder').addEventListener('click', () => {
  const p = document.getElementById('dbInfo').dataset.path;
  if (p) sam.app.openPath(p.replace(/[\\/][^\\/]+$/, ''));
});
document.getElementById('btnReplayIntro').addEventListener('click', () => {
  if (!SamIntro.play({ force: true })) toast('المقدمة معطّلة لهذا الجهاز — فعّلها من نفس القائمة', 'warn');
});
document.getElementById('btnToggleSound').addEventListener('click', (e) => {
  const muted = SamIntro.toggleMute();
  e.currentTarget.textContent = muted ? 'تشغيل صوت المقدمة' : 'كتم صوت المقدمة';
  toast(muted ? 'تم كتم صوت الحركة التقديمية' : 'تم تشغيل الصوت', 'ok');
});
document.getElementById('btnToggleSound').textContent =
  SamIntro.isMuted() ? 'تشغيل صوت المقدمة' : 'كتم صوت المقدمة';

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
  applyPermissions();
  fillSysInfo();
  tickClock();
  setInterval(tickClock, 1000);

  // the post-login transition paints over the first screen for ~2 seconds
  const willAnimate = SamIntro.play();
  const startData = () => {
    renderChanges();
    if (SamSession.can('dashboard', 'view')) go('dashboard');
    else {
      const first = SamSession.meta.screens.find((s) => SamSession.can(s.key, 'view'));
      go(first ? first.key : 'settings');
    }
  };
  if (willAnimate) setTimeout(startData, 1700);
  else startData();
})();
