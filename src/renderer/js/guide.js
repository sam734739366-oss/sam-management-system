'use strict';

/* =====================================================================
   دليل الاستخدام — the in-app guide.
   Opened from the "?" button in the title bar (or from Settings).
   It answers the four questions a new user always has:
     · what does each document do to the stock?
     · what does every button in the program do?
     · how do I keep my data safe (folder · backup · cloud sync)?
     · how do I print and export a report?
   The content is Arabic, sectioned, and searchable by the rail on the
   right — the same shell the report window uses.
   ===================================================================== */
(function () {
  const { el, icon, esc, toast } = SamUI;

  /* ---------------- the sections ---------------- */
  const SECTIONS = [
    {
      key: 'start',
      title: 'البداية السريعة',
      icon: 'i-play',
      intro: 'ثلاث خطوات تختصر كل شيء: صنف، رصيد افتتاحي، ثم مستند.',
      body: [
        ['i-box', 'أضف الأصناف', 'من «الأصناف» ⇒ «إضافة صنف»: الكود، الاسم، والوحدة الأساسية (الحبة عادة). هذه الوحدة هي وحدة الحساب في كل الفواتير والتقارير والطباعة.'],
        ['i-in', 'رصيد افتتاحي', 'نفس شاشة إضافة الصنف: اكتب الرصيد الافتتاحي لكل مخزن. هذه الحركات تكوّن رصيد البداية ولا تُعدَّ مستنداً.'],
        ['i-cart', 'سجّل أول حركة', 'من «العمليات» ⇒ «مستند جديد»: اختر النوع، اكتب الرقم والتاريخ والطرف، أضف السطور مع المخزن والكمية، ثم احفظ.']
      ]
    },
    {
      key: 'docs',
      title: 'المستندات وأثرها على المخزون',
      icon: 'i-swap',
      intro: 'كل نوع مستند له لون وأيقونة ثابتة، وأثره على الرصيد محدد مسبقاً.',
      rows: [
        ['مشتريات', 'i-cart', 'يزيد الرصيد', 'استلام بضاعة من المورد وإضافتها إلى المخزن المُختار في كل سطر'],
        ['مبيعات', 'i-box', 'ينقص الرصيد', 'تخرج كميات من المخزن المُختار في كل سطر'],
        ['مرتجع مبيعات', 'i-return', 'يزيد الرصيد', 'ما رجع من العميل يعود إلى المخزن'],
        ['مرتجع مشتريات', 'i-return', 'ينقص الرصيد', 'ما رجع للمورد يخرج من المخزن'],
        ['نقل بين المخازن', 'i-truck', 'لا يغيّر الإجمالي', 'يخرج من مخزن ويدخل آخر — يحتفظ كل مخزن برصيده'],
        ['سند استلام الإنتاج', 'i-factory', 'يزيد الرصيد', 'ما أنتجه المصنع يدخل المخزن الذي تختاره'],
        ['إذن إدخال', 'i-gate-in', 'يزيد الرصيد', 'دخول بضاعة من خارج المخازن'],
        ['إذن خروج', 'i-gate-out', 'ينقص الرصيد', 'خروج بضاعة من المخازن'],
        ['تسوية جرد', 'i-scale', 'زيادة أو عجز', 'تصحيح الفرق بين الجرد الفعلي والرصيد الدفتري']
      ],
      note: 'الكرة والكرتونة: الحبة (الوحدة الأساسية) هي ما يُحسب. عدد الوحدات في الكرتونة والكيس معلوماتي فقط ولا يدخل في أي رصيد.'
    },
    {
      key: 'edit',
      title: 'التعديل والحذف النهائي',
      icon: 'i-edit',
      intro: 'لا يوجد «إلغاء» في هذا البرنامج — الحذف نهائي، وأثره محسوب قبل تنفيذه.',
      body: [
        ['i-eye', 'عرض', 'نقر مزدوج على أي سطر في أي جدول يفتح المستند كما هو.'],
        ['i-edit', 'تعديل', 'من الزر الأيمن ⇒ «تعديل»: يُعاد حساب الحركات من جديد، فالرصيد يبقى صحيحاً.'],
        ['i-trash', 'حذف نهائي', 'من الزر الأيمن ⇒ «حذف نهائي»: تظهر نافذة تحذير تذكر كل صنف ومخزن والكمية المتأثرة قبل التنفيذ.']
      ],
      note: 'بعد الحذف تعود حسابات المخزون كما لو أن المستند لم يوجد من الأساس — لا يبقى أثر معلّق.'
    },
    {
      key: 'prod',
      title: 'الإنتاج',
      icon: 'i-factory',
      intro: 'ثلاثة أجزاء منفصلة: ما يخرج من المخزون، وما يدخل إليه، وما هو توثيق فقط.',
      body: [
        ['i-out', 'صرف المواد الخام', 'يخصم المادة الخام من مخزن المصدر — حركة حقيقية على المخزون.'],
        ['i-in', 'سند استلام الإنتاج', 'يزيد رصيد المنتج التام في المخزن الذي تختاره. يطبع «تصريح خروج» لأن المصنع خارج المخازن.'],
        ['i-scale', 'العجز والتالف', 'قسم مستقل بلا أي أثر على المخزون — يعرض العجز والتالف لكل كرتونة وله تقريره الخاص.']
      ],
      note: '«تقرير الإنتاج اليومي» و«سجل الأرشيف» توثيقيان فقط: لا يُنشئان حركة ولا يغيّران رصيداً.'
    },
    {
      key: 'reports',
      title: 'التقارير والطباعة',
      icon: 'i-chart',
      intro: 'كل تقرير يفتح في نافذة مستقلة: تختار الفترة والمخزن والصنف والطرف، ثم تعاين قبل التصدير.',
      body: [
        ['i-calendar', 'الفترة', 'كل تقرير مقيد بتاريخ من وإلى — التقارير لا تخلط حركات تاريخها مختلف.'],
        ['i-eye', 'المعاينة قبل الطباعة', 'زر «طباعة / معاينة» يعرض الشكل النهائي على ورق A4 قبل إرسال شيء إلى الطابعة.'],
        ['i-archive', 'تصدير Excel', 'ملف xlsx حقيقي يفتح في Excel بخط واضح واتجاه صحيح — لا صورة ولا نص عادي.'],
        ['i-print', 'طباعة أو PDF', 'اختر الطابعة المتصلة أو احفظ PDF. الهوامش صغيرة والورق A4 عمودي أو أفقي حسب عرض التقرير.']
      ],
      note: 'نقر مزدوج على أي بند داخل التقرير يفتح المستند المصدر مباشرةً للتعديل أو الحذف.'
    },
    {
      key: 'data',
      title: 'البيانات والنسخ الاحتياطي',
      icon: 'i-db',
      intro: 'بياناتك محفوظة في ملف واحد، ويمكنك أن تختار مكانه بنفسك.',
      body: [
        ['i-folder', 'مجلد البيانات', 'من «الإعدادات» ⇒ «مجلد البيانات» تختار المجلد الذي يحتفظ بقاعدة بياناتك. تُنسخ البيانات إلى المجلد الجديد فوراً، وتبقى النسخة القديمة سليمة كنسخة احتياطية.'],
        ['i-db', 'نسخة احتياطية', 'من «النسخ الاحتياطي» تحفظ نسخة في أي مكان تختاره. نسخة تلقائية تُؤخذ قبل كل تحديث للبرنامج.'],
        ['i-cloud', 'المزامنة السحابية', 'اكتب بريدك الإلكتروني فقط — يكتشف البرنامج Google Drive أو OneDrive أو Dropbox على جهازك ويكتب نسخة في مجلد السحابة مباشرة.']
      ],
      note: 'التحديث لا يمس بياناتك أبداً: قاعدة البيانات خارج مجلد التثبيت، وترحيل قاعدة البيانات إضافة فقط.'
    },
    {
      key: 'update',
      title: 'التحديث والاختصارات',
      icon: 'i-update',
      intro: 'البرنامج يعلمك بنفسه، ويصلح نفسه بلا أن تفقد شيئاً.',
      body: [
        ['i-update', 'زر التحديث', 'أيقونة التحديث بجانب الإصدار في شريط العنوان تفتح نافذة التحديث: الحالة، النسبة، السرعة، الحجم، وأزرار الفحص والتحميل والتثبيت.'],
        ['i-lock', 'قبل التثبيت', 'تُؤخذ نسخة احتياطية تلقائية من قاعدتك قبل تثبيت أي إصدار جديد.']
      ],
      shortcuts: [
        ['Ctrl + S', 'حفظ'], ['Ctrl + N', 'مستند جديد'], ['Ctrl + P', 'طباعة'], ['F5', 'تحديث الشاشة'], ['Esc', 'إغلاق النافذة']
      ]
    }
  ];

  /* ---------------- one section, rendered ---------------- */
  function renderSection(sec) {
    const box = el('div', 'guide-sec');

    const head = el('div', 'guide-head');
    head.innerHTML = `<span class="gh-ic">${icon(sec.icon)}</span>
      <div class="gh-txt"><b>${esc(sec.title)}</b><span>${esc(sec.intro || '')}</span></div>`;
    box.appendChild(head);

    /* the document table */
    if (sec.rows) {
      const t = el('table', 'tbl guide-tbl');
      t.innerHTML = `<thead><tr><th>المستند</th><th>الأثر على الرصيد</th><th>ماذا يحدث</th></tr></thead><tbody></tbody>`;
      const tb = t.querySelector('tbody');
      sec.rows.forEach(([name, ic, effect, what]) => {
        const tr = el('tr');
        tr.innerHTML = `<td><span class="gt-name"><span class="gt-ic">${icon(ic)}</span>${esc(name)}</span></td>
          <td><span class="chip ${effect.includes('يزيد') ? 'ok' : effect.includes('ينقص') ? 'bad' : 'accent'}">${esc(effect)}</span></td>
          <td>${esc(what)}</td>`;
        tb.appendChild(tr);
      });
      box.appendChild(el('div', 'tbl-wrap', '')).appendChild(t);
    }

    /* the bullet blocks */
    if (sec.body) {
      const list = el('div', 'guide-list');
      sec.body.forEach(([ic, title, text]) => {
        const item = el('div', 'guide-item');
        item.innerHTML = `<span class="gi-ic">${icon(ic)}</span>
          <div class="gi-txt"><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
        list.appendChild(item);
      });
      box.appendChild(list);
    }

    /* the shortcut table */
    if (sec.shortcuts) {
      const wrap = el('div', 'guide-keys');
      sec.shortcuts.forEach(([k, v]) => {
        const row = el('div', 'gk-row');
        row.innerHTML = `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`;
        wrap.appendChild(row);
      });
      box.appendChild(el('div', 'form-sec', `${icon('i-gear')}<span>اختصارات لوحة المفاتيح</span>`));
      box.appendChild(wrap);
    }

    if (sec.note) box.appendChild(el('p', 'foot-note', sec.note));
    return box;
  }

  /* ---------------- the window ---------------- */
  let current = null;

  function open() {
    if (current) current.close();
    const rail = el('div', 'guide-rail');
    const content = el('div', 'guide-content');
    const body = el('div', 'guide-body');
    body.append(content, rail);

    const ov = el('div', 'overlay guide-overlay');
    const box = el('div', 'guide-window');

    const head = el('div', 'guide-top');
    head.innerHTML = `<span class="gt-badge">${icon('i-help')}</span>
      <div class="gt-txt"><h3>دليل الاستخدام</h3>
      <span>كل ما تحتاج معرفته لتشغيل النظام SAM بثقة</span></div>`;
    const x = el('button', 'guide-x', icon('i-x'));
    x.type = 'button';
    x.title = 'إغلاق';
    head.appendChild(x);
    box.appendChild(head);
    box.appendChild(body);

    ov.appendChild(box);
    document.body.appendChild(ov);

    let active = SECTIONS[0].key;

    const paint = () => {
      content.innerHTML = '';
      const sec = SECTIONS.find((s) => s.key === active) || SECTIONS[0];
      content.appendChild(renderSection(sec));
      [...rail.children].forEach((n) => n.classList.toggle('on', n.dataset.key === sec.key));
    };

    SECTIONS.forEach((s) => {
      const b = el('button', 'guide-item-btn');
      b.type = 'button';
      b.dataset.key = s.key;
      b.innerHTML = `<span class="gib-ic">${icon(s.icon)}</span><span>${esc(s.title)}</span>`;
      b.addEventListener('click', () => { active = s.key; paint(); });
      rail.appendChild(b);
    });

    function close() {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (current === api) current = null;
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    x.addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey, true);

    const api = { overlay: ov, close };
    current = api;
    paint();
    return api;
  }

  window.SamGuide = {
    open,
    close() { if (current) current.close(); },
    get current() { return current; }
  };
})();
