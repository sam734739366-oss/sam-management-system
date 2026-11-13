'use strict';

/* =====================================================================
   THE SCREEN PRINTER — one printer for every screen in the program
   =====================================================================

   The customer asked for EVERY screen and EVERY document to be
   printable. The documents already had their own print (the invoice,
   the permits, the reports, the daily sheet, the item card). What was
   missing were the SCREENS themselves: the dashboard, the items, the
   warehouses, the parties, the operations list, the production boards,
   the users and the backups.

   This module is the missing printer. It reads the screen that is open
   right now — its title, its numbers (the KPI cards) and its tables —
   rebuilds them as a proper A4 sheet with the same masthead, watermark
   and footer as every document in the program, and hands it to the
   print preview. So the user sees the REAL paper before it leaves the
   printer, exactly like the documents do.

   Rules:
   · the printed sheet is never a screenshot — it is rebuilt from the
     real data, so the text is selectable and the numbers are exact;
   · a long list is split into pages of a size that FITS the paper —
     nothing is ever cut off at the bottom;
   · a wide table (8 columns or more) is printed on A4 LANDSCAPE;
   · the numbers are aligned to the end of the line and the total
     count is written in the footer of every page.
   ===================================================================== */

(function () {
  const { esc, toast, tableHtml, printPreview } = SamUI;

  /* ---- how many rows fit on one sheet -------------------------------
     The first page carries the masthead + the title + the numbers, so
     it holds fewer rows. A landscape sheet is shorter (210mm), so it
     holds fewer rows still. These numbers are deliberately CONSERVATIVE:
     a sheet that overflows would clip its last rows, and a clipped row
     is worse than an extra page. */
  const ROWS_FIRST = 17;
  const ROWS_NEXT = 25;
  const ROWS_LAND = 16;

  /* the friendly name of every table — the card head is not always
     enough (the daily table and the backups table have no head) */
  const TABLE_AR = {
    movesTbl: 'أحدث حركات المخزون',
    alertsTbl: 'تنبيهات الأصناف',
    itemsTbl: 'الأصناف',
    whTbl: 'المخازن',
    partiesTbl: 'العملاء والموردون',
    docsTbl: 'المستندات',
    prodDocsTbl: 'سندات استلام الإنتاج',
    prodIssueDocsTbl: 'سندات توريد الإنتاج',
    issuesTbl: 'صرف الخام',
    receiptsTbl: 'استلام الإنتاج',
    gapTbl: 'العجز والتالف',
    tollingTbl: 'نفخ للغير',
    scrapTbl: 'الهدر',
    archiveTbl: 'سجل الأرشيف',
    dailyTbl: 'حركة الصنف × المخزن',
    dailySumTbl: 'ملخص المخازن',
    usersTbl: 'المستخدمون',
    backupsTbl: 'النسخ الاحتياطي'
  };

  /* the screens that get their own «طباعة الشاشة» button. The daily
     report and the report centre already carry their own printing
     (they print a real report), so they are not repeated here — but
     the title-bar printer still works on them. */
  const VIEWS_WITH_BUTTON = ['dashboard', 'items', 'warehouses', 'parties', 'transactions', 'production', 'settings'];

  /* ---------------- small helpers ---------------- */
  function clean(txt) {
    return (txt || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function visible(node) {
    return !!(node && node.getClientRects().length);
  }
  function todayStr() {
    return new Date().toLocaleDateString('ar-EG-u-nu-latn');
  }
  /** a cell is a number when it holds digits only (Arabic or Latin) */
  function looksNumeric(v) {
    const t = clean(v);
    if (!t) return false;
    return /^[\d٠-٩.,٫\-+%٪\/\s]+$/.test(t);
  }

  /* ---------------- reading the screen ---------------- */
  function collectKpis(view) {
    const out = [];
    view.querySelectorAll('.kpi').forEach((k) => {
      if (!visible(k)) return;
      const label = clean(k.querySelector('.k-top') && k.querySelector('.k-top').textContent);
      const value = clean(k.querySelector('.k-val') && k.querySelector('.k-val').textContent);
      if (!label && !value) return;
      out.push({
        k: label || 'رقم',
        v: value || '—',
        note: clean(k.querySelector('.k-note') && k.querySelector('.k-note').textContent)
      });
    });
    return out;
  }

  function captionOf(tbl) {
    const card = tbl.closest('.card');
    const h = card && card.querySelector('.card-head h3');
    return h ? clean(h.textContent) : '';
  }

  /** the tables of the screen — every visible one becomes a printed table */
  function collectTables(view) {
    const out = [];
    view.querySelectorAll('table.tbl').forEach((t) => {
      if (!visible(t)) return;
      if (t.closest('.no-print')) return;
      const head = [];
      t.querySelectorAll('thead th').forEach((th) => head.push(clean(th.textContent)));
      if (!head.length) return;
      const rows = [];
      t.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = [];
        tr.querySelectorAll('td').forEach((td) => cells.push(clean(td.textContent)));
        if (!cells.length) return;
        rows.push(cells);
      });
      /* an empty table still prints — its header says WHAT the list is,
         and a note says it is empty. A list that does not exist on the
         screen must never appear on the paper. */
      out.push({ cap: captionOf(t) || TABLE_AR[t.id] || 'البيانات', head, rows });
    });
    return out;
  }

  /** the description lists (the settings screen has two of them) — they
      become a two-column table: البند / القيمة */
  function collectInfoLists(view) {
    const out = [];
    view.querySelectorAll('dl.info').forEach((d) => {
      if (!visible(d)) return;
      const rows = [];
      const dts = [...d.querySelectorAll('dt')];
      const dds = [...d.querySelectorAll('dd')];
      dts.forEach((dt, i) => {
        rows.push([clean(dt.textContent), dds[i] ? clean(dds[i].textContent) : '']);
      });
      if (!rows.length) return;
      out.push({ cap: captionOf(d) || 'المعلومات', head: ['البند', 'القيمة'], rows });
    });
    return out;
  }

  /** the column alignment: the row number sits in the middle, the
      numbers sit at the end of the line, the rest at the start */
  function alignOf(t, i) {
    const label = t.head[i] || '';
    if (label === '#' || label === 'م' || label === 'ت') return 'center';
    const vals = t.rows.map((r) => r[i]).filter((v) => clean(v));
    if (!vals.length) return 'start';
    const nums = vals.filter(looksNumeric).length;
    return nums === vals.length ? 'end' : 'start';
  }

  /* ---------------- building the pages ---------------- */
  function buildPages(view) {
    const h2 = view.querySelector('.view-head h2');
    const sub = view.querySelector('.view-head .sub');
    const title = clean(h2 && h2.textContent) || 'شاشة البرنامج';
    const subtitle = clean(sub && sub.textContent);
    const kpis = collectKpis(view);
    const tables = collectTables(view).concat(collectInfoLists(view));

    const maxCols = tables.reduce((a, t) => Math.max(a, t.head.length), 0);
    const land = maxCols >= 8;
    const perPage = land ? ROWS_LAND : ROWS_NEXT;

    /* how many pages in total — so every page can say «صفحة X من Y» */
    let total = 0;
    tables.forEach((t) => { total += Math.max(1, Math.ceil(t.rows.length / perPage)); });
    if (!total) total = 1;

    const notes = kpis.map((k) => k.note).filter(Boolean);
    const pages = [];
    let pageNo = 0;

    tables.forEach((t) => {
      const cols = t.head.map((label, i) => ({ key: 'c' + i, label, align: alignOf(t, i) }));
      const chunks = Math.max(1, Math.ceil(t.rows.length / perPage));
      for (let c = 0; c < chunks; c++) {
        const slice = t.rows.slice(c * perPage, (c + 1) * perPage);
        const rows = slice.map((cells) => {
          const o = {};
          cols.forEach((col, ci) => { o[col.key] = cells[ci] === undefined ? '' : cells[ci]; });
          return o;
        });
        pageNo++;
        const cont = c > 0;
        const cap = cont ? `${t.cap} — متابعة` : t.cap;
        const pageLabel = chunks > 1 ? `صفحة ${pageNo} من ${total}` : '';
        const body = [];
        if (pageNo === 1 && notes.length) {
          body.push(`<div class="doc-note"><b>ملاحظات:</b> ${notes.map((n) => esc(n)).join(' · ')}</div>`);
        }
        /* the page marker keeps the number in a Latin run, so it stays
           readable (and countable) in the right-to-left sheet */
        body.push(`<div class="doc-note"><b>${esc(cap)}</b>${pageLabel ? ` — <span class="pg-label" data-pg="${pageNo}/${total}">${esc(pageLabel)}</span>` : ''}</div>`);
        if (t.rows.length) {
          body.push(tableHtml(cols, rows));
        } else {
          body.push('<div class="doc-note">لا توجد بيانات في هذه القائمة.</div>');
        }
        pages.push({
          title,
          subtitle: cont ? `${cap}${pageLabel ? ` · ${pageLabel}` : ''}` : (subtitle || cap),
          printDate: todayStr(),
          docRefLabel: 'الشاشة',
          docRef: title,
          head: pageNo === 1 ? kpis.map((k) => ({ k: k.k, v: k.v })) : [],
          bodyHtml: body.join(''),
          signatures: [],
          footer: `SAM Management System — ${title}`
        });
      }
    });

    /* a screen with numbers but no table still prints its numbers */
    if (!pages.length) {
      const body = [];
      if (notes.length) body.push(`<div class="doc-note"><b>ملاحظات:</b> ${notes.map((n) => esc(n)).join(' · ')}</div>`);
      body.push('<div class="doc-note">لا توجد جداول في هذه الشاشة — هذه لقطة الأرقام الظاهرة فيها.</div>');
      pages.push({
        title,
        subtitle,
        printDate: todayStr(),
        docRefLabel: 'الشاشة',
        docRef: title,
        head: kpis.map((k) => ({ k: k.k, v: k.v })),
        bodyHtml: body.join(''),
        signatures: [],
        footer: `SAM Management System — ${title}`
      });
    }

    return { title, pages, land, total };
  }

  /* ---------------- the public entry ---------------- */
  function print(viewName) {
    const view = viewName
      ? document.getElementById('v-' + viewName)
      : document.querySelector('.view.active');
    if (!view) return toast('لا توجد شاشة جاهزة للطباعة', 'warn');
    const built = buildPages(view);
    if (!built.pages.length) return toast('لا يوجد محتوى قابل للطباعة في هذه الشاشة', 'warn');
    printPreview({
      title: built.title,
      pages: built.pages,
      landscape: built.land
    });
    return true;
  }

  /* ---------------- the buttons ---------------- */
  function screenButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost';
    b.innerHTML = `${SamUI.iconTile('i-print', 'tone-info', 'xs')}<span class="btn-txt">طباعة الشاشة</span>`;
    b.addEventListener('click', () => print());
    return b;
  }

  function injectButtons() {
    VIEWS_WITH_BUTTON.forEach((name) => {
      const view = document.getElementById('v-' + name);
      if (!view) return;
      const head = view.querySelector('.view-head');
      if (!head) return;
      let acts = head.querySelector('.view-actions');
      if (!acts) {
        acts = document.createElement('div');
        acts.className = 'view-actions';
        head.appendChild(acts);
      }
      if (acts.querySelector('.btn-print-screen')) return;
      const b = screenButton();
      b.classList.add('btn-print-screen');
      acts.appendChild(b);
    });
  }

  function wireTitleBar() {
    const b = document.getElementById('btnPrintScreen');
    if (!b) return;
    b.addEventListener('click', () => print());
  }

  injectButtons();
  wireTitleBar();

  window.SamPrintScreen = { print, injectButtons };
})();
