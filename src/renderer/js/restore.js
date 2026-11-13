'use strict';

/**
 * src/renderer/js/restore.js — bringing a data file back into the program.
 *
 * The file can arrive two ways: the customer picks it with a dialog (the
 * settings buttons) or he drops it on the window. Both roads end in the same
 * place — the file is looked at FIRST, its contents are shown, and only then
 * does he confirm the restore.
 */

(function () {
  const UI = window.SamUI;
  if (!UI) return;

  const esc = UI.esc;
  const toast = UI.toast;
  const modal = UI.modal;

  const fmtSize = (bytes) => {
    const kb = Math.round((Number(bytes) || 0) / 1024);
    if (kb < 1024) return `${kb} ك.ب`;
    return `${(kb / 1024).toFixed(1)} م.ب`;
  };

  function bodyOf(d) {
    return `
      <div style="display:flex;gap:12px;align-items:flex-start;background:var(--bad-bg);padding:12px 14px;border-radius:12px;border:1px solid var(--bad-line)">
        ${UI.iconTile('i-warn', 'tone-adjust', 'xs')}
        <div><b style="color:var(--bad)">تنبيه: استبدال البيانات</b><br>
        <span style="font-size:13px">سيُستبدل محتوى قاعدة البيانات بالكامل بالملف المختار، وتُؤخذ نسخة احتياطية من بياناتك الحالية أولاً — فلا تضيع بياناتك.</span></div>
      </div>
      <table class="tbl" style="margin-top:12px">
        <tbody>
          <tr><td>الملف</td><td>${esc(d.name)}</td></tr>
          <tr><td>الحجم</td><td>${esc(fmtSize(d.size))}</td></tr>
          <tr><td>تاريخ الملف</td><td>${esc(d.mtime)}</td></tr>
          <tr><td>عدد الأصناف داخله</td><td>${esc(String(d.items == null ? '—' : d.items))}</td></tr>
        </tbody>
      </table>
      <p class="foot-note">ستُعاد حسابات المستخدمين من الملف المستعاد. إن لم يكن فيه حساب «admin» فسيُنشأ واحد بكلمة المرور admin123 حتى لا يُغلق البرنامج على نفسه.</p>`;
  }

  /** the confirmation every restore goes through */
  async function confirmRestore(d, file) {
    const yes = await modal({
      title: 'استعادة البيانات من الملف',
      danger: true,
      body: bodyOf(d),
      actions: [
        { label: 'استعادة الآن', value: 'yes', kind: 'btn-danger', icon: 'i-restore' },
        { label: 'رجوع', value: 'cancel', kind: 'btn-ghost' }
      ]
    });
    if (yes !== 'yes') return false;

    const res = await sam.restore.fromPath(file);
    if (!res.ok) {
      toast(res.error || 'تعذّرت الاستعادة', 'bad', 5200);
      return false;
    }
    toast('تمت استعادة البيانات — سيُعاد تشغيل البرنامج', 'ok', 4000);
    return true;
  }

  /** a file the customer dropped on the window */
  async function fromPath(file) {
    if (!file) return false;
    let d;
    try {
      const res = await sam.restore.describe(file);
      if (!res.ok) { toast(res.error || 'تعذّر قراءة الملف', 'bad', 5200); return false; }
      d = res.data;
    } catch (e) {
      toast(e.message || 'تعذّر قراءة الملف', 'bad', 5200);
      return false;
    }
    return confirmRestore(d, file);
  }

  /** the settings button: pick the file with a dialog */
  async function pick() {
    const res = await sam.restore.pick();
    if (!res || res.canceled) return false;
    if (!res.ok) { toast(res.error || 'تعذّر قراءة الملف', 'bad', 5200); return false; }
    return confirmRestore(res.data, res.data.path);
  }

  window.SamRestore = { pick, fromPath, confirmRestore };

  /* ---------------- dropping a file on the window ---------------- */
  const veil = document.getElementById('dropRestore');
  if (veil) {
    let depth = 0;
    const show = (on) => veil.classList.toggle('on', on);

    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
      e.preventDefault();
      depth++;
      show(true);
    });
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) show(false);
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      show(false);
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      if (!files.length) return;
      const file = files[0];
      let p = '';
      try { p = window.sam.app.pathForFile(file); } catch (err) { p = ''; }
      if (!p) {
        toast('تعذّر قراءة الملف المسحوب — استخدم زر «استعادة من ملف…»', 'bad', 5200);
        return;
      }
      await fromPath(p);
    });
  }
})();
