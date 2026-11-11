'use strict';

/* =====================================================================
   Settings — users & roles, local backup, Google Drive sync
   ===================================================================== */
(function () {
  const { el, icon, esc, toast, bindRow, modal, form, field, input, emptyState, toggleEmpty } = SamUI;

  const state = { users: [], meta: { screens: [], perms: [] }, backup: null, sync: null, datadir: null, cloud: null, tab: 'general' };

  /* ---------------- tabs ---------------- */
  function showTab(tab) {
    state.tab = tab;
    ['general', 'users', 'backup', 'data', 'update'].forEach((t) => {
      const box = document.getElementById(`set-${t}`);
      if (box) box.classList.toggle('hidden', t !== tab);
    });
    document.querySelectorAll('#settingsTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'users') loadUsers();
    if (tab === 'backup') loadBackup();
    if (tab === 'data') loadDataTab();
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
      field('اسم المستخدم', username, '', 'i-user'),
      field('الاسم الكامل', fullName, '', 'i-user'),
      field('كلمة المرور', password, '', 'i-lock'),
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
    grid.append(field(`كلمة المرور الجديدة لـ ${u.username}`, pw, '', 'i-lock'), field('تأكيد كلمة المرور', pw2, '', 'i-lock'));
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

  /* ---------------- backup ---------------- */
  async function loadBackup() {
    try {
      const [info, list] = await Promise.all([sam.sync.info(), sam.backup.list()]);
      if (!info.ok) return toast(info.error, 'bad');
      state.sync = info.data;
      document.getElementById('backupInfo').innerHTML = rows([
        ['ملف قاعدة البيانات', state.sync.dbFile],
        ['حجم الملف', `${SamDB.fmt(Math.round(state.sync.dbSize / 1024))} ك.ب`],
        ['مجلد النسخ المحلية', state.sync.backupsDir],
        ['آخر نسخة', fmtStamp(state.sync.backupLast)]
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
  /* =====================================================================
     V4 — where the data lives, and the cloud sync by e-mail alone
     ===================================================================== */

  /* ---------------- the data folder ---------------- */
  async function loadDataTab() {
    try {
      const res = await sam.datadir.info();
      if (!res.ok) return toast(res.error, 'bad');
      const d = res.data;
      state.datadir = d;
      const badge = document.getElementById('ddBadge');
      badge.textContent = d.isCustom ? 'مجلد مخصص' : 'المجلد الافتراضي';
      badge.className = `badge ${d.isCustom ? 'ok' : ''}`;
      document.getElementById('ddInfo').innerHTML = rows([
        ['مجلد البيانات', d.dir],
        ['ملف قاعدة البيانات', d.dbFile],
        ['حجم قاعدة البيانات', `${SamDB.fmt(Math.round(d.dbSize / 1024))} ك.ب`],
        ['المساحة الحرة', d.freeSpaceMB == null ? '—' : `${SamDB.fmt(d.freeSpaceMB)} م.ب`],
        ['الوضع', d.isCustom ? 'مجلد تختاره أنت' : 'المجلد الافتراضي للبرنامج']
      ]);
    } catch (e) { toast(e.message, 'bad'); }
    loadCloud();
  }

  async function pickDataDir() {
    const res = await sam.datadir.pick();
    if (!res) return;
    if (res.canceled) return;
    if (!res.ok) return toast(res.error, 'bad');
    const d = res.data || {};
    const copy = d.copy || {};
    const info = d.info || {};
    const answer = await modal({
      title: 'تم نسخ البيانات إلى المجلد الجديد',
      body: `<p>أُنسخت قاعدة البيانات إلى:</p>
        <p style="direction:ltr;text-align:start"><b>${esc(info.dir || copy.dir || '')}</b></p>
        <p>الحجم المنسوخ: <b>${SamDB.fmt(Math.round((copy.size || 0) / 1024))} ك.ب</b></p>
        <p style="margin-top:10px">النسخة القديمة بقيت كما هي في مكانها. التعديل يسري بالكامل عند إعادة تشغيل البرنامج، وبعدها كل ما تدخله يُحفظ في المجلد الجديد.</p>`,
      actions: [
        { label: 'إعادة التشغيل الآن', value: 'relaunch', kind: 'btn-primary', icon: 'i-refresh' },
        { label: 'لاحقاً', value: 'later', kind: 'btn-ghost' }
      ]
    });
    if (answer === 'relaunch') sam.app.relaunch();
    loadDataTab();
  }

  async function openDataDir() {
    const d = state.datadir;
    if (d && d.dir) sam.app.openPath(d.dir);
    else toast('لم يتم تحديد المجلد بعد', 'warn');
  }

  async function resetDataDir() {
    const yes = await modal({
      title: 'العودة إلى المجلد الافتراضي',
      danger: true,
      body: '<p>سيعيش البرنامج من جديد في مجلده الافتراضي. بياناتك الحالية تبقى في المجلد المختار كنسخة احتياطية، ولن يُحذف شيء.</p>',
      actions: [
        { label: 'العودة للمجلد الافتراضي', value: 'yes', kind: 'btn-danger', icon: 'i-refresh' },
        { label: 'إلغاء', value: 'no', kind: 'btn-ghost' }
      ]
    });
    if (yes !== 'yes') return;
    const res = await sam.datadir.reset();
    if (!res.ok) return toast(res.error, 'bad');
    toast('سيعود البرنامج إلى المجلد الافتراضي عند إعادة التشغيل', 'ok');
    loadDataTab();
  }

  async function exportDataDir() {
    const res = await sam.datadir.exportCopy();
    if (!res) return;
    if (res.canceled) return;
    if (!res.ok) return toast(res.error, 'bad');
    toast(`تم حفظ النسخة في ${res.data.path}`, 'ok', 5200);
  }

  /* ---------------- the cloud sync ---------------- */

  /**
   * The live note under the e-mail field: where the copy will land and
   * whether the typed address matches the account that is signed in.
   */
  function refreshCloudNote() {
    const c = state.cloud || {};
    const host = document.getElementById('cloudNote');
    if (!host) return;
    const field = document.getElementById('cloudEmail');
    const typed = ((field && field.value) || c.email || '').trim().toLowerCase();
    const clients = (c.clients || []).filter((cl) => cl.installed !== false);
    const suggested = c.suggestedClient || null;
    const target = clients.find((cl) => suggested && cl.id === suggested.id) || clients[0] || null;

    if (!target) {
      host.className = 'cloud-note';
      host.textContent = '';
      return;
    }
    if (!target.root) {
      host.className = 'cloud-note warn';
      host.textContent = `${target.label} مثبّت على الجهاز لكنه لم ينشئ مجلد التزامن بعد — افتحه مرة واحدة وسجّل الدخول بحسابك ثم عد هنا.`;
      return;
    }
    const acct = (target.account || '').toLowerCase();
    if (typed && acct && typed !== acct) {
      host.className = 'cloud-note warn';
      host.textContent = `الحساب المسجّل في ${target.label} هو «${target.account}» — سيُرفع الملف إلى هذا الحساب.`;
      return;
    }
    host.className = 'cloud-note ok';
    host.innerHTML = `ستُنسخ البيانات إلى <code>${esc(target.root)}\\SAM-Backups</code> — ويرفعها ${esc(target.label)} إلى حسابك.`;
  }

  async function loadCloud() {
    try {
      const res = await sam.cloud.status();
      if (!res.ok) return;
      const c = res.data || {};
      state.cloud = c;
      const email = document.getElementById('cloudEmail');
      const clients = c.clients || [];
      const gdrive = clients.find((cl) => cl.id === 'gdrive');

      /* the signed-in account — the user does not even have to type it */
      if (email && !email.value) {
        email.value = c.email || (gdrive && gdrive.account) || '';
        if (email.value && !email.dataset.touched) email.classList.add('is-auto');
      }
      if (email && !email.dataset.cloudBound) {
        email.dataset.cloudBound = '1';
        email.addEventListener('input', () => {
          email.dataset.touched = '1';
          email.classList.remove('is-auto');
          refreshCloudNote();
        });
      }

      /* the client the typed e-mail would use — no picking needed */
      const suggested = c.suggestedClient || null;
      const target = clients.find((cl) => suggested && cl.id === suggested.id)
        || clients.find((cl) => cl.id === 'gdrive')
        || null;

      document.getElementById('cloudInfo').innerHTML = rows([
        ['البريد المحفوظ', c.email || '—'],
        ['سيُستخدم مع بريدك', suggested ? suggested.label : (c.activeClient ? c.activeClient.label : '—')],
        ['الحساب المسجّل', (target && target.account) || c.account || '—'],
        ['مجلد النسخ', target && target.root ? target.root + '\\SAM-Backups' : '—'],
        ['آخر مزامنة', fmtStamp(c.last)],
        c.lastError ? ['آخر خطأ', c.lastError] : null
      ].filter(Boolean));

      const host = document.getElementById('cloudClients');
      host.innerHTML = '';
      const installed = clients.filter((cl) => cl.installed !== false);
      if (!installed.length) {
        const note = el('p', 'foot-note', 'لم يُعثر على Google Drive أو OneDrive أو Dropbox على هذا الجهاز. ثبّت واحداً منها وسجّل الدخول بحسابك ثم اضغط «مزامنة الآن».');
        const b = el('button', 'btn btn-primary');
        b.type = 'button';
        b.innerHTML = `${SamUI.iconTile('i-cloud', 'tone-info', 'xs')}<span class="btn-txt">تحميل Google Drive للكمبيوتر</span>`;
        b.addEventListener('click', async () => {
          const r = await sam.cloud.installPage('gdrive');
          if (r && r.ok) toast('فُتحت صفحة التحميل في المتصفح', 'ok');
        });
        host.append(note, b);
        refreshCloudNote();
        return;
      }

      /* one row per installed client — a shortcut, not a requirement */
      const list = el('div', 'row-btns');
      installed.forEach((cl) => {
        const b = el('button', 'col-check');
        b.type = 'button';
        b.innerHTML = `${SamUI.iconTile('i-cloud', cl.id === 'gdrive' ? 'tone-info' : 'tone-plain', 'xs')}<span class="btn-txt">${esc(cl.label)}${cl.account ? ` — ${esc(cl.account)}` : ''}</span>`;
        b.addEventListener('click', () => doCloudSync(cl.id));
        list.appendChild(b);
      });
      host.appendChild(list);

      /* open the folder the copies land in */
      if (target && target.root) {
        const openBtn = el('button', 'btn btn-ghost btn-sm');
        openBtn.type = 'button';
        openBtn.innerHTML = `${SamUI.iconTile('i-out', 'tone-gout', 'xs')}<span class="btn-txt">فتح مجلد النسخ</span>`;
        openBtn.addEventListener('click', () => sam.app.openPath(target.root));
        host.appendChild(openBtn);
      }

      /* the automatic backup on every start */
      const autoRow = el('label', 'check-row');
      autoRow.style.marginTop = '12px';
      const autoBox = document.createElement('input');
      autoBox.type = 'checkbox';
      autoBox.checked = c.auto !== false;
      autoBox.id = 'cloudAuto';
      autoBox.addEventListener('change', async () => {
        const r = await sam.cloud.auto(autoBox.checked);
        if (r && r.ok) toast(autoBox.checked ? 'ستتم المزامنة تلقائياً عند كل تشغيل' : 'أُوقفت المزامنة التلقائية', 'ok');
      });
      autoRow.append(autoBox, document.createTextNode('نسخة تلقائية إلى سحابتي عند كل تشغيل للبرنامج'));
      host.appendChild(autoRow);

      refreshCloudNote();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function doCloudSync(clientId) {
    const field = document.getElementById('cloudEmail');
    const email = (field.value || '').trim();
    if (!email) return toast('اكتب بريدك الإلكتروني أولاً', 'warn');
    const c = state.cloud || {};
    const clients = (c.clients || []).filter((cl) => cl.installed !== false);
    const picked = clients.find((cl) => cl.id === clientId)
      || clients.find((cl) => (cl.accounts || []).some((a) => a.toLowerCase() === email.toLowerCase()))
      || clients.find((cl) => c.suggestedClient && cl.id === c.suggestedClient.id)
      || clients[0];
    const folder = picked && picked.root ? picked.root + '\\SAM-Backups' : '';
    const ok = await modal({
      title: 'مزامنة البيانات إلى السحابة',
      body: `<p>ستُنسخ قاعدة البيانات إلى مجلد السحابة على جهازك، ويرفعها برنامج السحابة إلى حسابك.</p>
        <p style="margin-top:8px">البريد: <b>${esc(email)}</b></p>
        ${picked ? `<p style="margin-top:6px">البرنامج: <b>${esc(picked.label)}</b>${picked.account ? ` — الحساب المسجّل: <b>${esc(picked.account)}</b>` : ''}</p>` : ''}
        ${folder ? `<p style="margin-top:6px;direction:ltr;text-align:start">المجلد: <b>${esc(folder)}</b></p>` : ''}
        <p style="margin-top:8px;color:var(--muted-fg)">النسخة عملية及市场كة — بياناتك الأصلية لا تُمس.</p>`,
      actions: [
        { label: 'ابدأ المزامنة', value: 'yes', kind: 'btn-primary', icon: 'i-cloud' },
        { label: 'إلغاء', value: 'no', kind: 'btn-ghost' }
      ]
    });
    if (ok !== 'yes') return;
    const res = await sam.cloud.sync(email, clientId);
    if (!res) return;
    if (!res.ok) return toast(res.error, 'bad');
    const d = res.data || {};
    toast(`تمت المزامنة إلى ${d.folder || d.client || 'السحابة'}`, 'ok', 5200);
    if (d.warning) toast(d.warning, 'warn', 7000);
    loadCloud();
  }

  async function changeOwnPassword() {
    const body = el('div');
    const grid = el('div', 'form-grid');
    const oldPw = input({ type: 'password', placeholder: 'كلمة المرور الحالية' });
    const newPw = input({ type: 'password', placeholder: 'الجديدة — 6 أحرف على الأقل' });
    const newPw2 = input({ type: 'password', placeholder: 'تأكيد الجديدة' });
    grid.append(field('كلمة المرور الحالية', oldPw, '', 'i-lock'), field('كلمة المرور الجديدة', newPw, '', 'i-lock'), field('تأكيد الجديدة', newPw2, '', 'i-lock'));
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
  document.getElementById('btnGoCloud').addEventListener('click', () => showTab('data'));
  document.getElementById('btnOpenGuide').addEventListener('click', () => {
    if (window.SamGuide) window.SamGuide.open();
  });
  document.getElementById('btnPickDataDir').addEventListener('click', pickDataDir);
  document.getElementById('btnOpenDataDir').addEventListener('click', openDataDir);
  document.getElementById('btnResetDataDir').addEventListener('click', resetDataDir);
  document.getElementById('btnExportDataDir').addEventListener('click', exportDataDir);
  document.getElementById('btnCloudSync').addEventListener('click', () => doCloudSync(null));
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
