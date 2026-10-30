'use strict';

/* =====================================================================
   Settings — users & roles, local backup, Google Drive sync
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, bindRow, modal, form, field, input, emptyState, toggleEmpty } = SamUI;

  const state = { users: [], meta: { screens: [], perms: [] }, backup: null, sync: null, tab: 'general' };

  /* ---------------- tabs ---------------- */
  function showTab(tab) {
    state.tab = tab;
    ['general', 'users', 'backup', 'update'].forEach((t) => {
      document.getElementById(`set-${t}`).classList.toggle('hidden', t !== tab);
    });
    document.querySelectorAll('#settingsTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'users') loadUsers();
    if (tab === 'backup') loadBackup();
    if (tab === 'update') loadUpdate();
  }

  /* ---------------- users ---------------- */
  async function loadUsers() {
    try {
      const [users, meta] = await Promise.all([sam.users.list(), sam.auth.meta()]);
      if (!users.ok) return toast(users.error, 'bad');
      state.users = users.data;
      state.meta = meta.data;
      renderUsers();
    } catch (e) { toast(e.message, 'bad'); }
  }

  function renderUsers() {
    const tb = document.querySelector('#usersTbl tbody');
    tb.innerHTML = '';
    state.users.forEach((u, idx) => {
      const tr = el('tr');
      const screens = u.role === 'admin' ? 'الكل' : u.screens.map((k) => labelOf(k)).join('، ') || '—';
      const perms = u.role === 'admin' ? 'كل الصلاحيات'
        : state.meta.perms.filter((p) => u.perms[p.key]).map((p) => p.label).join('، ') || '—';
      tr.innerHTML = `
        <td class="num">${idx + 1}</td>
        <td class="mono">${esc(u.username)}</td>
        <td>${esc(u.full_name || '—')}</td>
        <td><span class="chip ${u.role === 'admin' ? 'main' : 'sub'}">${u.role === 'admin' ? 'مدير' : 'مستخدم'}</span></td>
        <td>${esc(screens)}</td>
        <td>${esc(perms)}</td>
        <td>${u.is_active ? '<span class="chip ok">نشط</span>' : '<span class="chip off">موقوف</span>'}</td>
        <td>${esc(u.last_login || '—')}</td>`;
      bindRow(tr, {
        edit: () => openUserForm(u),
        del: () => removeUser(u),
        extra: [{ label: 'إعادة تعيين كلمة المرور', icon: 'i-edit', onClick: () => openUserForm(u, true) }]
      });
      tb.appendChild(tr);
    });
    emptyState('usersEmpty', {
      icon: 'i-users',
      title: 'لا يوجد مستخدمون',
      hint: 'أضف مستخدماً وحدّد شاشاته وصلاحياته — التحقق يتم في العملية الرئيسية.'
    });
    toggleEmpty('usersEmpty', state.users.length > 0);
  }

  const labelOf = (key) => (state.meta.screens.find((s) => s.key === key) || {}).label || key;

  function openUserForm(u, passwordOnly) {
    if (passwordOnly) return resetPassword(u);

    const body = el('div');
    const grid = el('div', 'form-grid');
    const username = input({ placeholder: 'مثال: warehouse1', value: u ? u.username : '' });
    const fullName = input({ placeholder: 'الاسم الكامل', value: u ? u.full_name || '' : '' });
    const password = input({ type: 'password', placeholder: u ? 'اتركها فارغة للإبقاء عليها' : '6 أحرف على الأقل' });

    const roleBox = el('div', 'radio-row');
    [['admin', 'مدير', 'صلاحية كاملة على كل الشاشات'], ['user', 'مستخدم', 'يُقيَّد بما تحدده أدناه']].forEach(([val, label, hint]) => {
      const r = input({ type: 'radio', name: 'user-role', value: val });
      r.checked = u ? u.role === val : val === 'user';
      const l = el('label', 'radio');
      l.append(r, el('span', 'rt', label), el('em', 'hint-txt', hint));
      roleBox.appendChild(l);
    });

    const screensBox = el('div', 'perm-grid');
    state.meta.screens.forEach((s) => {
      const cb = input({ type: 'checkbox', value: s.key });
      cb.checked = u ? (u.role === 'admin' || u.screens.includes(s.key)) : false;
      const lab = el('label', 'perm-cell');
      lab.append(cb, el('span', '', esc(s.label)));
      screensBox.appendChild(lab);
    });

    const permsBox = el('div', 'perm-grid');
    const permBoxes = {};
    state.meta.perms.forEach((p) => {
      const cb = input({ type: 'checkbox', value: p.key });
      cb.checked = u ? !!u.perms[p.key] : p.key === 'view';
      permBoxes[p.key] = cb;
      const lab = el('label', 'perm-cell');
      lab.append(cb, el('span', '', esc(p.label)));
      permsBox.appendChild(lab);
    });

    const activeWrap = el('label', 'check-row');
    const active = input({ type: 'checkbox' });
    active.checked = u ? !!u.is_active : true;
    activeWrap.append(active, el('span', '', 'الحساب نشط'));

    function blockField(label, node) {
      const f = el('div', 'full field');
      f.appendChild(el('span', '', label));
      f.appendChild(node);
      return f;
    }

    grid.append(
      field('اسم المستخدم', username),
      field('الاسم الكامل', fullName),
      field('كلمة المرور', password),
      blockField('الدور', roleBox),
      blockField('الشاشات المسموحة', screensBox),
      blockField('الصلاحيات', permsBox),
      activeWrap
    );
    body.appendChild(grid);
    body.appendChild(el('p', 'foot-note', 'للمدير: كل الشاشات والصلاحيات مفعّلة تلقائياً ولا تحتاج تحديداً.'));

    form({
      title: u ? `تعديل المستخدم ${u.username}` : 'إضافة مستخدم',
      body,
      wide: true,
      submitLabel: 'حفظ المستخدم',
      async onSubmit() {
        const role = (roleBox.querySelector('input:checked') || {}).value || 'user';
        const payload = {
          id: u ? u.id : null,
          username: username.value.trim(),
          full_name: fullName.value.trim(),
          password: password.value,
          role,
          is_active: active.checked,
          screens: [...screensBox.querySelectorAll('input:checked')].map((c) => c.value),
          perms: (() => {
            const out = {};
            Object.keys(permBoxes).forEach((k) => { out[k] = permBoxes[k].checked; });
            return out;
          })()
        };
        if (!payload.username) throw new Error('اسم المستخدم مطلوب');
        if (role === 'user' && !payload.screens.length) throw new Error('حدّد شاشة واحدة على الأقل للمستخدم');
        const res = await sam.users.save(payload);
        if (!res.ok) throw new Error(res.error);
        toast(u ? `تم تحديث «${payload.username}»` : `تم إضافة المستخدم «${payload.username}»`, 'ok');
        SamUI.bus.emit();
        return res.data;
      }
    }).then((v) => { if (v) loadUsers(); });
  }

  async function resetPassword(u) {
    const body = el('div');
    const grid = el('div', 'form-grid');
    const pw = input({ type: 'password', placeholder: 'كلمة مرور جديدة — 6 أحرف على الأقل' });
    const pw2 = input({ type: 'password', placeholder: 'تأكيد كلمة المرور' });
    grid.append(field(`كلمة المرور الجديدة لـ ${u.username}`, pw), field('تأكيد كلمة المرور', pw2));
    body.appendChild(grid);
    const ok = await form({
      title: 'إعادة تعيين كلمة المرور',
      body,
      submitLabel: 'تعيين',
      async onSubmit() {
        if (pw.value !== pw2.value) throw new Error('كلمتا المرور غير متطابقتين');
        const res = await sam.users.save({
          id: u.id, username: u.username, full_name: u.full_name, role: u.role,
          screens: u.screens, perms: u.perms, is_active: u.is_active, password: pw.value
        });
        if (!res.ok) throw new Error(res.error);
        toast(`تم تعيين كلمة مرور جديدة لـ «${u.username}»`, 'ok');
        return true;
      }
    });
    if (ok) loadUsers();
  }

  async function removeUser(u) {
    const yes = await modal({
      title: 'حذف مستخدم',
      danger: true,
      body: `<p>سيُحذف حساب <b>${esc(u.username)}</b> نهائياً ولن يستطيع الدخول. السجلات التي أنشأها تبقى كما هي.</p>`,
      actions: [
        { label: 'حذف الحساب', value: 'yes', kind: 'btn-danger', icon: 'i-trash' },
        { label: 'إلغاء', value: 'cancel', kind: 'btn-ghost' }
      ]
    });
    if (yes !== 'yes') return;
    const res = await sam.users.remove(u.id);
    if (!res.ok) return toast(res.error, 'bad');
    toast(`تم حذف المستخدم «${u.username}»`, 'bad');
    loadUsers();
  }

  /* ---------------- backup + sync ---------------- */
  async function loadBackup() {
    try {
      const [info, list] = await Promise.all([sam.sync.info(), sam.backup.list()]);
      if (!info.ok) return toast(info.error, 'bad');
      state.sync = info.data;
      document.getElementById('syncFolder').value = state.sync.folder || 'لم يتم اختيار مجلد';
      document.getElementById('syncAuto').checked = !!state.sync.auto;
      document.getElementById('backupInfo').innerHTML = rows([
        ['ملف قاعدة البيانات', state.sync.dbFile],
        ['حجم الملف', `${SamDB.fmt(Math.round(state.sync.dbSize / 1024))} ك.ب`],
        ['مجلد النسخ المحلية', state.sync.backupsDir],
        ['آخر نسخة', fmtStamp(state.sync.backupLast)]
      ]);
      document.getElementById('syncInfo').innerHTML = rows([
        ['مجلد Drive', state.sync.folder || '—'],
        ['المزامنة التلقائية', state.sync.auto ? 'مفعّلة' : 'متوقفة'],
        ['آخر مزامنة', fmtStamp(state.sync.last)],
        ['نسخ الاحتفاظ في Drive', 'آخر 12 نسخة']
      ]);
      const tb = document.querySelector('#backupsTbl tbody');
      tb.innerHTML = '';
      (list.data || []).forEach((b) => {
        const tr = el('tr');
        tr.innerHTML = `<td>${esc(b.name)}</td><td class="num">${SamDB.fmt(Math.round(b.size / 1024))} ك.ب</td><td>${esc(b.mtime)}</td>`;
        bindRow(tr, { view: () => sam.app.openPath(b.path) });
        tb.appendChild(tr);
      });
    } catch (e) { toast(e.message, 'bad'); }
  }

  const rows = (pairs) => pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const fmtStamp = (s) => {
    if (!s) return '—';
    const [iso, file] = s.split('|');
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ar-EG-u-nu-latn');
  };

  async function backupNow() {
    const res = await sam.backup.now();
    if (!res.ok) return toast(res.error, 'bad');
    toast('تم حفظ نسخة احتياطية محلية', 'ok');
    loadBackup();
  }
  async function backupSaveAs() {
    const res = await sam.backup.saveAs();
    if (res && res.canceled) return;
    if (!res.ok) return toast(res.error, 'bad');
    toast(`تم حفظ النسخة: ${res.data.path}`, 'ok', 5200);
    loadBackup();
  }
  async function pickFolder() {
    const res = await sam.sync.pickFolder();
    if (res && res.canceled) return;
    if (!res.ok) return toast(res.error, 'bad');
    toast('تم اختيار مجلد المزامنة', 'ok');
    loadBackup();
  }
  async function saveSyncCfg() {
    const res = await sam.sync.setConfig({ auto: document.getElementById('syncAuto').checked });
    if (!res.ok) return toast(res.error, 'bad');
    toast('تم حفظ إعدادات المزامنة', 'ok');
    loadBackup();
  }
  async function syncNow() {
    const res = await sam.sync.now();
    if (!res.ok) return toast(res.error, 'bad', 5200);
    toast(`تمت المزامنة إلى ${res.data.target}`, 'ok', 5200);
    loadBackup();
  }

  async function changeOwnPassword() {
    const body = el('div');
    const grid = el('div', 'form-grid');
    const oldPw = input({ type: 'password', placeholder: 'كلمة المرور الحالية' });
    const newPw = input({ type: 'password', placeholder: 'الجديدة — 6 أحرف على الأقل' });
    const newPw2 = input({ type: 'password', placeholder: 'تأكيد الجديدة' });
    grid.append(field('كلمة المرور الحالية', oldPw), field('كلمة المرور الجديدة', newPw), field('تأكيد الجديدة', newPw2));
    body.appendChild(grid);
    await form({
      title: 'تغيير كلمة مروري',
      body,
      submitLabel: 'تغيير',
      async onSubmit() {
        if (newPw.value !== newPw2.value) throw new Error('كلمتا المرور الجديدتان غير متطابقتين');
        const res = await sam.auth.changePassword(oldPw.value, newPw.value);
        if (!res.ok) throw new Error(res.error);
        toast('تم تغيير كلمة المرور', 'ok');
        return true;
      }
    });
  }

  /* ---------------- updater ---------------- */
  const UPD_STATUS = {
    idle: 'جاهز', checking: 'جارٍ الفحص…', available: 'يتوفر تحديث', 'up-to-date': 'أحدث إصدار',
    downloading: 'جارٍ التحميل', downloaded: 'جاهز للتثبيت', installing: 'جارٍ التثبيت',
    error: 'خطأ', dev: 'وضع التطوير'
  };
  const MB = (b) => SamDB.n(b) / 1048576;

  function renderUpdate(s) {
    s = s || {};
    const badge = document.getElementById('updStateBadge');
    badge.textContent = UPD_STATUS[s.status] || s.status || 'جاهز';
    badge.className = `badge ${s.status === 'error' ? 'bad' : s.status === 'downloaded' ? 'ok' : 'gold'}`;
    const wrap = document.getElementById('updBarWrap');
    wrap.classList.toggle('done', s.status === 'downloaded');
    wrap.classList.toggle('err', s.status === 'error');
    const pct = Math.max(0, Math.min(100, SamDB.n(s.percent)));
    document.getElementById('updFill').style.width = `${pct}%`;
    document.getElementById('updPercent').textContent = `${pct.toFixed(1)}%`;
    document.getElementById('updLabel').textContent = s.message || UPD_STATUS[s.status] || '';
    document.getElementById('updSize').textContent = `${MB(s.transferred).toFixed(1)} / ${MB(s.total).toFixed(1)} MB`;
    document.getElementById('updSpeed').textContent = s.speed ? `${MB(s.speed).toFixed(2)} MB/ث` : '— MB/ث';
    document.getElementById('btnDownloadUpdate').classList.toggle('hidden', s.status !== 'available');
    document.getElementById('btnInstallUpdate').classList.toggle('hidden', s.status !== 'downloaded');
  }

  async function loadUpdate() {
    try {
      const [st, feed, info] = await Promise.all([sam.update.state(), sam.update.feed(), sam.app.info()]);
      const s = st && st.ok ? st.data : st;
      renderUpdate(s);
      document.getElementById('updInfo').innerHTML = rows([
        ['الإصدار الحالي', `v${info.version}`],
        ['طريقة التشغيل', info.packaged ? 'نسخة مثبتة (exe)' : 'وضع تطوير (npm start)'],
        ['الحالة', UPD_STATUS[(s && s.status) || 'idle']],
        ['الإصدار المتوفر', (s && s.version) || '—']
      ]);
      document.getElementById('updFeed').innerHTML = rows([
        ['المزوّد', (feed && feed.provider) || 'github'],
        ['المالك (owner)', (feed && feed.owner) || '—'],
        ['المستودع (repo)', (feed && feed.repo) || '—'],
        ['القناة', (feed && feed.channel) || 'latest']
      ]);
      if (feed && feed.owner && /REPLACE/i.test(feed.owner)) {
        document.getElementById('updFeed').innerHTML += `<dt>تنبيه</dt><dd style="color:var(--bad)">عدّل updater.config.json قبل النشر</dd>`;
      }
    } catch (e) { toast(e.message, 'bad'); }
  }

  sam.on('app:update-state', renderUpdate);

  async function checkUpdate() {
    const r = await sam.update.check();
    renderUpdate(r && r.ok ? r.data : r);
    if (r && !r.ok) toast(r.error, 'bad');
  }
  async function downloadUpdate() {
    const r = await sam.update.download();
    renderUpdate(r && r.ok ? r.data : r);
  }
  async function installUpdate() {
    await sam.update.install();
  }
  async function simulateUpdate() {
    const r = await sam.update.simulate();
    renderUpdate(r && r.ok ? r.data : r);
  }

  /* ---------------- wiring ---------------- */
  document.getElementById('settingsTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) showTab(b.dataset.tab);
  });
  document.getElementById('btnAddUser').addEventListener('click', () => openUserForm(null));
  document.getElementById('btnBackupNow').addEventListener('click', backupNow);
  document.getElementById('btnBackupSaveAs').addEventListener('click', backupSaveAs);
  document.getElementById('btnBackupFolder').addEventListener('click', () => sam.app.openPath(state.sync ? state.sync.backupsDir : ''));
  document.getElementById('btnPickFolder').addEventListener('click', pickFolder);
  document.getElementById('btnSaveSyncCfg').addEventListener('click', saveSyncCfg);
  document.getElementById('btnSyncNow').addEventListener('click', syncNow);
  document.getElementById('btnChangeOwnPw').addEventListener('click', changeOwnPassword);
  document.getElementById('btnCheckUpdate').addEventListener('click', checkUpdate);
  document.getElementById('btnDownloadUpdate').addEventListener('click', downloadUpdate);
  document.getElementById('btnInstallUpdate').addEventListener('click', installUpdate);
  document.getElementById('btnSimulateUpdate').addEventListener('click', simulateUpdate);

  function applyPermissions() {
    const admin = SamSession.isAdmin();
    ['btnAddUser'].forEach((id) => { document.getElementById(id).style.display = admin ? '' : 'none'; });
    document.getElementById('btnChangeOwnPw').style.display = '';
    if (!admin) showTab('general');
    document.querySelectorAll('#settingsTabs .tab').forEach((b) => {
      if (b.dataset.tab === 'users') b.style.display = admin ? '' : 'none';
    });
  }

  window.SamSettings = { load: loadBackup, loadUsers, showTab, applyPermissions };
})();
