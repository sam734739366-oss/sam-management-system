# V3 — مخازن متعددة وتقرير يومي وتصاريح خروج لكل مخزن — خطة التنفيذ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** تحويل النظام إلى مخازن متعددة متساوية يعرّفها المستخدم، مع تواريخ فعلية لكل حركة، تقرير يومي صنف×مخزن، فواتير نظام خارجي بمخزن لكل سطر، وتصريح خروج مستقل لكل مخزن مشتق من الفاتورة.

**Architecture:** الإبقاء على `stock_moves` كمصدر وحيد للحقيقة. إزالة قيد "المخزن الرئيسي الواحد"، إضافة `move_date` لكل حركة، فلترة التقارير بالتاريخ الفعلي، دالة `dailyReport` جديدة، ومساعد طباعة متعدد الصفحات لتصاريح الخروج.

**Tech Stack:** Electron 33.4.11، better-sqlite3 12.10.1 (electron-v130)، Vanilla JS، exceljs 4.4.0. الاختبارات عبر harness مخفي `env -u ELECTRON_RUN_AS_NODE npx electron tools/shotX.js`.

**Spec:** `docs/superpowers/specs/2026-11-09-multi-warehouse-daily-report-design.md`

## Global Constraints

- الرد والتواصل بالعربية؛ كل الأوامر والاختبارات ينفذها الوكيل بنفسه ولا يُطلب من المستخدم تشغيل شيء.
- لا رفع إلى GitHub حتى يقول المستخدم صراحة "ارفع التحديث".
- لا commits إلا بطلب صريح من المستخدم (قاعدة المستخدم تتقدم على مهارة writing-plans التي تقترح commits؛ لذا خطوات الالتزام اختيارية وتُنفّذ فقط عند الطلب).
- الحبة/وحدة الصنف هي وحدة الحقيقة؛ الكراتين/الأكياس معلوماتية فقط.
- الحذف نهائي يعكس المخزون؛ النقص لا يمنع الحفظ بل يحذّر.
- العملة: ريال يمني (YER). العلامة المائية "SAM 775158678".
- كل تشغيل Electron يستخدم `env -u ELECTRON_RUN_AS_NODE` (البيئة تورّث ELECTRON_RUN_AS_NODE=1).
- الأرقام في xlsx كأرقام حقيقية، رؤوس ملونة `2563EB`، RTL.

## خريطة الملفات

- `src/main/db.js`: نموذج المخازن، move_date، dailyReport، النقص لكل مخزن، الترحيل.
- `src/main/ipc-db.js`: expose `dailyReport` و`availableInLocation` في API/PERMS.
- `src/main/preload.js`: التأكد من مرور db:invoke (عام — لا تغيير غالبًا).
- `src/main/session.js`: SCREEN_LABELS (المخازن + التقرير اليومي).
- `src/renderer/js/warehouses.js`: شاشة مخازن مبسطة بلا نوع.
- `src/renderer/js/documents.js`: محرر الفاتورة (رقم خارجي، مخزن لكل سطر)، printInvoice، permitPages/printPermits (بيع + نقل).
- `src/renderer/js/ui.js`: printPreview متعدد الصفحات.
- `src/renderer/css/theme.css`: فواصل صفحات الطباعة `.print-page`.
- `src/renderer/js/daily.js`: شاشة التقرير اليومي (جديد).
- `src/renderer/app.html`: تنقل + قسم التقرير اليومي + عمود المخزن.
- `src/renderer/js/app.js`: VIEW_TITLE/LOADERS/NEW_ACTIONS + خريطة صلاحيات daily→reports.
- `src/renderer/js/reports.js`: تسميات وحدة دينيكية + فلترة move_date.
- `tools/shot8.js`، `tools/migrate-check.js`، `tools/shot9.js`: الاختبارات.

---

### Task 1: نموذج المخازن المتساوية (db.js)

**Files:**
- Modify: `src/main/db.js` (seedDefaults ~303، listWarehouses ~354، getMainWarehouse ~364، addWarehouse ~368، updateWarehouse ~379، validateWarehouse ~415، availableByLocation ~763، reportQuery locationTotals ~1774، summary ~1849)
- Test: `tools/shot8.js` (فحوص جديدة)

**Interfaces:**
- Produces: `listWarehouses()` يعيد كل المخازن متساوية مرتبة بـ id؛ لا `getMainWarehouse` (يزال من API لاحقًا)؛ `addWarehouse({code,name,location,note,is_active})` بلا kind مطلوب.

- [ ] **Step 1: اكتب الفحص الفاشل** — أضف في tools/shot8.js فحصًا: إنشاء مخزنين بلا kind، والتأكد أن كليهما مقبول وأن `listWarehouses` يعيدهما، وأن رصيد صنف موزع عليهما يظهر في `stockByWarehouse` ومجموعه في `stock.total`. شغّل `env -u ELECTRON_RUN_AS_NODE npx electron tools/shot8.js` وتوقع الفشل (قيد الرئيسي الواحد يرمي خطأ).

- [ ] **Step 2: عدّل seedDefaults**

```js
function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM warehouses').get().c;
  if (count === 0) {
    db.prepare("INSERT INTO warehouses(code,name,kind,location,note) VALUES('W01','المخزن 1','sub','الموقع الأساسي','مخزن افتراضي — أضف مخازنك من شاشة المخازن')").run();
  }
}
```

- [ ] **Step 3: أزل قيد الرئيسي الواحد** — في `addWarehouse` احذف كتلة `if (w.kind === 'main' && getMainWarehouse()) throw ...` واجعل الإدخال دائمًا `kind='sub'`:

```js
function addWarehouse(w) {
  validateWarehouse(w);
  const info = db
    .prepare('INSERT INTO warehouses(code,name,kind,location,note,is_active) VALUES(?,?,?,?,?,?)')
    .run(w.code.trim(), w.name.trim(), 'sub', str(w.location), w.note || null, w.is_active === false ? 0 : 1);
  return getWarehouse(info.lastInsertRowid);
}
```

في `updateWarehouse` احذف كتلة منع الرئيسي الآخر، وثبّت `kind='sub'` في UPDATE. في `validateWarehouse` احذف شرط `['main','sub'].includes(w.kind)` وأبقِ فحص الكود والاسم فقط:

```js
function validateWarehouse(w) {
  if (!w || !String(w.code || '').trim()) throw new Error('كود المخزن مطلوب');
  if (!String(w.name || '').trim()) throw new Error('اسم المخزن مطلوب');
}
```

- [ ] **Step 4: عدّل الترتيب والاستعلامات** — في `listWarehouses` استبدل `ORDER BY (w.kind='main') DESC, w.id` بـ `ORDER BY w.id`. في `availableByLocation` و`reportQuery` (locationTotals) استبدل `ORDER BY (w.kind='main') DESC, w.name` بـ `ORDER BY w.name`. أزل دالة `getMainWarehouse` entirely، واستبدل كل استخداماتها: في `saveDocument` السطر `|| (getMainWarehouse() || {}).id || null` يصبح `|| null` (المخزن إلزامي لكل سطر لاحقًا)؛ في `saveTolling` `const whId = int(payload.warehouse_id) || null`؛ في `summary` احذف `const main = getMainWarehouse()` و`mainWarehouse: main ? main.name : null` واستبدل بـ `mainWarehouse: null`.

- [ ] **Step 5: حدّث ipc-db.js** — احذف السطر `getMainWarehouse: () => d.getMainWarehouse(),` من API (إن بقي مستخدمًا في مكان آخر، أبقِه لكن اجعله يعيد null؛ الأفضل إزالته). تأكد أن `addWarehouse`/`updateWarehouse` يمرران كما هو.

- [ ] **Step 6: شغّل الفحص** — `env -u ELECTRON_RUN_AS_NODE npx electron tools/shot8.js` وتوقع نجاح فحوص المخازن الجديدة.

---

### Task 2: عمود move_date والترحيل (db.js)

**Files:**
- Modify: `src/main/db.js` (SCHEMA stock_moves ~74، migrate ~250، writeOpening ~542، saveDocument insMove ~846، saveIssue ~1168، saveReceipt ~1311، saveTolling ~1486)
- Test: `tools/migrate-check.js`، `tools/shot8.js`

**Interfaces:**
- Produces: `stock_moves.move_date TEXT` (YYYY-MM-DD) معبأ من تاريخ المستند؛ كل كاتب حركة يمرر التاريخ.

- [ ] **Step 1: اكتب الفحص الفاشل** — في shot8.js: احفظ فاتورة بتاريخ ماضٍ (مثل 2026-01-15) وتأكد أن حركة المخزون الناتجة `move_date='2026-01-15'` وليس تاريخ اليوم. شغّل وتوقع الفشل (العمود غير موجود).

- [ ] **Step 2: أضف العمود في SCHEMA** — في تعريف `stock_moves` أضف بعد `note TEXT,`:

```sql
  move_date TEXT NOT NULL DEFAULT (date('now','localtime')),
```

وأضف فهرسًا بعد idx_moves_created:

```sql
CREATE INDEX IF NOT EXISTS idx_moves_date ON stock_moves(move_date);
```

- [ ] **Step 3: أضف الترحيل والتعبئة** — في `migrate()` بعد فحص is_customer:

```js
  if (!cols.includes('move_date')) {
    db.exec("ALTER TABLE stock_moves ADD COLUMN move_date TEXT NOT NULL DEFAULT (date('now','localtime'))");
    // backfill from the source document's business date
    db.exec(`
      UPDATE stock_moves SET move_date = COALESCE(
        (SELECT d.doc_date FROM documents d WHERE d.id = stock_moves.doc_id AND d.kind = stock_moves.doc_type),
        (SELECT pi.doc_date FROM prod_issues pi WHERE pi.id = stock_moves.doc_id AND stock_moves.doc_type='issue'),
        (SELECT pr.doc_date FROM prod_receipts pr WHERE pr.id = stock_moves.doc_id AND stock_moves.doc_type IN ('receipt','bags')),
        (SELECT t.doc_date FROM tolling_orders t WHERE t.id = stock_moves.doc_id AND stock_moves.doc_type IN ('tolling_in','tolling_out','scrap')),
        substr(stock_moves.created_at,1,10)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_moves_date ON stock_moves(move_date)');
  }
```

- [ ] **Step 4: مرّر move_date في كل الكتّاب** —عدّل كل `INSERT INTO stock_moves` ليضمّن العمود:
  - `writeOpening` (~544): أضف `move_date` للأعمدة و`date('now','localtime')` كقيمة (الرصيد الافتتاحي تاريخه اليوم).
  - `saveDocument` insMove (~846): أضف العمود ومرّر `payload.doc_date` (متغير موجود).
  - `saveIssue` (~1169): أضف العمود ومرّر `payload.doc_date`.
  - `saveReceipt` insMove (~1311): أضف العمود ومرّر `payload.doc_date` في كل استدعاءات insMove.run.
  - `saveTolling` insMove (~1487): أضف العمود ومرّر `payload.doc_date` في كل استدعاءات insMove.run.

مثال saveDocument:

```js
    const insMove = db.prepare(
      `INSERT INTO stock_moves(item_id,warehouse_id,bucket,piece_delta,carton_qty,bag_qty,doc_type,doc_id,doc_no,party_id,note,move_date)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    // ... insMove.run(itemId, wh, bucket, meta.sign * pieces, cartons, bags, payload.kind, docId, docNo, int(payload.party_id) || null, l.note || null, payload.doc_date);
```

- [ ] **Step 5: وسّع migrate-check.js** — بعد init تحقق: `PRAGMA table_info(stock_moves)` يحوي move_date؛ `SELECT COUNT(*) FROM stock_moves WHERE move_date IS NULL OR move_date=''` = 0؛ قارن مجاميع piece_delta قبل/بعد (لا تغيير). شغّل `env -u ELECTRON_RUN_AS_NODE npx electron tools/migrate-check.js` وتوقع النجاح.

- [ ] **Step 6: شغّل shot8** — توقع نجاح فحص move_date.

---

### Task 3: فلترة التقارير بالتاريخ الفعلي + النقص لكل مخزن (db.js)

**Files:**
- Modify: `src/main/db.js` (reportQuery ~1680، saveDocument ~871)
- Test: `tools/shot8.js`

**Interfaces:**
- Consumes: `move_date` (Task 2)، `availableInLocation(itemId, warehouseId, bucket, ignoreDocId)` (موجودة ~897).
- Produces: reportQuery يفلتر بـ move_date؛ saveDocument يحذّر على مستوى مخزن كل سطر.

- [ ] **Step 1: اكتب الفحص الفاشل** — في shot8: فاتورة بتاريخ قديم + حركة اليوم؛ `reportQuery({dateFrom: اليوم, dateTo: اليوم})` يجب أن يعيد حركة اليوم فقط (لا القديمة). حاليًا يفلتر بـ created_at (كلاهما اليوم) → الفشل. وأضف فحص نقص: صنف رصيده في مخزن A = 10، بيع 20 من A → التحذير يذكر المخزن A والرصيد 10.

- [ ] **Step 2: عدّل reportQuery** — استبدل فلتر التاريخ. احذف كتلة `inRange` التي تستخدم `createdAt.slice` واستبدلها بفلتر SQL على move_date. أضف في بناء `where`:

```js
  if (from) { where.push('m.move_date >= ?'); params.push(from); }
  if (to) { where.push('m.move_date <= ?'); params.push(to); }
```

واجعل `const inRange = rows;` (الفلترة صارت في SQL). أبقِ حساب movingBalance كما هو. ملاحظة: الرصيد الحالي mainBal يبقى كليًا (كل التواريخ) لأنه "الرصيد الحالي".

- [ ] **Step 3: النقص لكل مخزن في saveDocument** — في فرع غير النقل (~871) استبدل فحص `availablePieces` بـ `availableInLocation`:

```js
        const wh = int(l.warehouse_id || payload.warehouse_id) || null;
        if (!wh) throw new Error(`اختر المخزن للسطر ${payload.lines.indexOf(l) + 1}`);
        if (meta.sign < 0) {
          const avail = availableInLocation(itemId, wh, bucket, docId);
          if (pieces > avail) {
            warnings.push(`رصيد «${item.name}» في ${whName(wh)} ${avail} ${item.base_unit} فقط والإصدار ${pieces} — الرصيد بعد الحفظ ${avail - pieces}.`);
          }
        }
```

تأكد أن `whName(id)` helper موجود (يُستخدم في النقل).

- [ ] **Step 4: شغّل shot8** — توقع نجاح الفحصين.

---

### Task 4: دالة التقرير اليومي dailyReport (db.js + ipc-db.js)

**Files:**
- Modify: `src/main/db.js` (أضف دالة قبل module.exports ~1888، وأضفها للتصدير)
- Modify: `src/main/ipc-db.js` (API + PERMS)
- Test: `tools/shot8.js`

**Interfaces:**
- Produces: `dailyReport({date, buckets, includeCustomer})` يعيد:

```ts
{
  date: string, buckets: string[], bucketLabels: string[],
  warehouses: [{id, code, name, location}],
  rows: [{ itemId, itemCode, itemName, baseUnit,
           cells: { [whId]: {inQty, outQty, balance} },
           totalIn, totalOut, totalBalance }],
  warehouseTotals: { [whId]: {inQty, outQty, balance} },
  grand: {inQty, outQty, balance}
}
```

- [ ] **Step 1: اكتب الفحص الفاشل** — في shot8: أنشئ مخزنين وصنفًا، حركة وارد 100 لمخزن A اليوم، وارد 50 لمخزن B اليوم، صادر 30 من A اليوم. `dailyReport({date: اليوم})` → صف الصنف: cells[A]={inQty:100,outQty:30,balance:70}، cells[B]={inQty:50,outQty:0,balance:50}، grand.balance=120. شغّل وتوقع الفشل (الدالة غير موجودة).

- [ ] **Step 2: اكتب الدالة** — أضف في db.js:

```js
function dailyReport(filters = {}) {
  const day = (filters.date || '').trim() || db.prepare("SELECT date('now','localtime') AS d").get().d;
  const wanted = Array.isArray(filters.buckets) && filters.buckets.length
    ? filters.buckets.filter((b) => BUCKETS.includes(b)) : ['good'];
  const buckets = wanted.length ? wanted : BUCKETS.slice();
  const ph = buckets.map(() => '?').join(',');
  const custWhere = filters.includeCustomer === true ? '' : 'AND m.is_customer = 0';

  const moves = db.prepare(`
    SELECT m.item_id AS itemId, m.warehouse_id AS warehouseId,
           SUM(CASE WHEN m.piece_delta>0 THEN m.piece_delta ELSE 0 END) AS inQty,
           SUM(CASE WHEN m.piece_delta<0 THEN -m.piece_delta ELSE 0 END) AS outQty
    FROM stock_moves m
    WHERE m.move_date = ? AND m.bucket IN (${ph}) ${custWhere}
    GROUP BY m.item_id, m.warehouse_id
  `).all(day, ...buckets);

  const bal = db.prepare(`
    SELECT m.item_id AS itemId, m.warehouse_id AS warehouseId,
           SUM(m.piece_delta) AS balance
    FROM stock_moves m
    WHERE m.bucket IN (${ph}) ${custWhere}
    GROUP BY m.item_id, m.warehouse_id
  `).all(...buckets);

  const mvMap = {}; moves.forEach((r) => (mvMap[`${r.itemId}:${r.warehouseId}`] = r));
  const balMap = {}; bal.forEach((r) => (balMap[`${r.itemId}:${r.warehouseId}`] = r.balance));

  const whs = listWarehouses().map((w) => ({ id: w.id, code: w.code, name: w.name, location: w.location || '' }));
  const items = db.prepare('SELECT id, code, name, base_unit FROM items WHERE is_active=1 ORDER BY code').all();

  const warehouseTotals = {}; whs.forEach((w) => (warehouseTotals[w.id] = { inQty: 0, outQty: 0, balance: 0 }));
  const grand = { inQty: 0, outQty: 0, balance: 0 };

  const rows = items.map((it) => {
    const cells = {}; let totalIn = 0, totalOut = 0, totalBalance = 0;
    for (const w of whs) {
      const mv = mvMap[`${it.id}:${w.id}`] || { inQty: 0, outQty: 0 };
      const balance = balMap[`${it.id}:${w.id}`] || 0;
      cells[w.id] = { inQty: mv.inQty, outQty: mv.outQty, balance };
      totalIn += mv.inQty; totalOut += mv.outQty; totalBalance += balance;
      warehouseTotals[w.id].inQty += mv.inQty;
      warehouseTotals[w.id].outQty += mv.outQty;
      warehouseTotals[w.id].balance += balance;
    }
    grand.inQty += totalIn; grand.outQty += totalOut; grand.balance += totalBalance;
    return { itemId: it.id, itemCode: it.code, itemName: it.name, baseUnit: it.base_unit, cells, totalIn, totalOut, totalBalance };
  });

  return { date: day, buckets, bucketLabels: buckets.map((b) => AR_BUCKET[b]), warehouses: whs, rows, warehouseTotals, grand };
}
```

أضف `dailyReport` إلى كائن module.exports.

- [ ] **Step 3: expose عبر IPC** — في ipc-db.js API أضف `dailyReport: (filters) => d.dailyReport(filters || {}),` وفي PERMS أضف `dailyReport: ['reports', 'view'],`.

- [ ] **Step 4: شغّل shot8** — توقع نجاح فحص dailyReport (الأرقام والإجماليات).

---

### Task 5: شاشة المخازن المبسطة (warehouses.js + session.js + app.js)

**Files:**
- Modify: `src/renderer/js/warehouses.js`
- Modify: `src/main/session.js` (SCREEN_LABELS.warehouses)
- Modify: `src/renderer/js/app.js` (VIEW_TITLE.warehouses، V2_CHANGES، statusbar)
- Modify: `src/renderer/app.html` (تسمية القسم/الأزرار إن وجدت "هنجر")
- Test: `tools/shot9.js` (لقطة شاشة المخازن)

**Interfaces:**
- Consumes: `addWarehouse/updateWarehouse` بلا kind (Task 1).

- [ ] **Step 1: أعد كتابة openForm بلا نوع** — في warehouses.js احذف `kindLabel`، وكتلة `kindBox/mk/mainTaken` entirety، وحقل `field('النوع', kindBox)`. اجعل الحقول: الكود، الاسم، الموقع، ملاحظة، نشط. في onSubmit احذف `kind` من payload:

```js
        const payload = {
          code: code.value.trim(),
          name: name.value.trim(),
          location: location.value.trim(),
          note: note.value.trim(),
          is_active: active.checked
        };
        if (!payload.code) throw new Error('كود المخزن مطلوب');
        if (!payload.name) throw new Error('اسم المخزن مطلوب');
```

- [ ] **Step 2: عدّل الجدول والعرض** — في render() احذف عمود النوع `<td>...kindLabel...</td>` (وترويسته في app.html `#whTbl thead`). في view(w) احذف `<dt>النوع</dt>...`. استبدل النصوص: "لا توجد هناجر"→"لا توجد مخازن"، "إضافة هنجر"→"إضافة مخزن"، "المخزن واحد..."→"أضف مخازنك؛ كل صنف ينطبق عليها جميعًا"، عنوان النموذج "إضافة مخزن"/"تعديل المخزن". استبدل كلمة "حبة في هذا الموقع" بـ "إجمالي الرصيد".

- [ ] **Step 3: التسميات** — session.js: `warehouses: 'المخازن'`. app.js: `VIEW_TITLE.warehouses = 'المخازن'`؛ عدّل بند V2_CHANGES الخاص بالمخزن الواحد إلى "مخازن متعددة متساوية يعرّفها المستخدم"؛ statusbar "الهناجر"→"المخازن". app.html: ترويسة عمود النوع احذفها، وأي نص "هنجر" في قسم المخازن →"مخزن".

- [ ] **Step 4: تحقق بصري** — شغّل shot9.js ولقطة شاشة المخازن؛ تأكد لا يوجد حقل نوع ولا كلمة "هنجر".

---

### Task 6: محرر الفاتورة — رقم خارجي + مخزن لكل سطر (documents.js + app.html)

**Files:**
- Modify: `src/renderer/js/documents.js` (openEditor ~99-404)
- Modify: `src/renderer/app.html` (لا تغيير بنيوي كبير؛ الشبكة تُبنى في JS)
- Test: `tools/shot8.js`، `tools/shot9.js`

**Interfaces:**
- Consumes: `availableInLocation` (عبر IPC — أضف expose إن لزم)، `saveDocument` (يقبل warehouse_id لكل سطر).
- Produces: محرر برقم فاتورة يدوي مطلوب للبيع/الشراء، وعمود مخزن لكل سطر.

- [ ] **Step 1: expose availableInLocation** — في ipc-db.js API أضف `availableInLocation: (itemId, whId, bucket, ignoreDocId) => d.availableInLocation(itemId, whId, bucket, ignoreDocId),` (بلا PERMS أو ['transactions','view']).

- [ ] **Step 2: رقم الفاتورة الخارجي** — في openEditor غيّر docNo placeholder إلى `'رقم الفاتورة من النظام الآخر'` وأزل reliance على التوليد. في submit() قبل payload أضف تحققًا:

```js
      if ((kind === 'sale' || kind === 'purchase') && !docNo.value.trim()) {
        errBar.innerHTML = `${icon('i-warn')}<span>أدخل رقم الفاتورة (${kind === 'sale' ? 'العميل' : 'المورد'} وارد من النظام الآخر)</span>`;
        return;
      }
```

- [ ] **Step 3: عمود المخزن لكل سطر** — في linesTbl thead أضف عمود `<th style="width:150px">المخزن</th>` بعد الصنف (وقبل الوحدة). في addLine أنشئ combo مخزن لكل سطر:

```js
      const whHost = el('div');
      const lWh = combo(whHost, {
        placeholder: 'المخزن…',
        items: activeWh().map((w) => ({ id: w.id, label: w.name, code: w.code })),
        onChange: () => refreshAvail(l)
      });
      lWh.setValue(data ? data.warehouse_id : (activeWh()[0] || {}).id || null, false);
```

أضف `l.whCombo = lWh;` إلى نموذج السطر، وأدرج الخلية في tr.append بالترتيب الصحيح (بعد itemHost). للنقل: استخدم lWh كمصدر وأضف combo وجهة لكل سطر (أو أبقِ وجهة عامة). اجعل refreshAvail يستخدم `availableInLocation(itemId, l.whCombo.getValue(), bucket, docId)`:

```js
        const whId = l.whCombo.getValue();
        const avail = whId
          ? await SamDB.call('availableInLocation', l.itemCombo.getValue(), whId, l.bucket, doc ? doc.id : null)
          : await SamDB.call('availablePieces', l.itemCombo.getValue(), l.bucket, doc ? doc.id : null);
```

- [ ] **Step 4: payload لكل سطر** — في submit() lines.map غيّر `warehouse_id: whCombo.getValue()` إلى `warehouse_id: l.whCombo.getValue()`. أزل الاعتماد على whCombo العام (يمكن إبقاء الخانة العلوية كافتراضي للأسطر الجديدة فقط).

- [ ] **Step 5: تحذير النقص لكل مخزن** — في shortages() استخدم `l.avail` (الذي صار per-location) كما هو؛ النص يذكر المخزن:

```js
            text: `${(state.warehouses.find((w) => w.id === l.whCombo.getValue()) || {}).name || ''} — المتاح ${SamDB.fmt(l.avail)} والكمية ${SamDB.fmt(qty)}`
```

- [ ] **Step 6: التاريخ افتراضيًا اليوم** — موجود (`new Date().toISOString().slice(0,10)`). تأكد أن حقل التاريخ بارز. لا تغيير إضافي.

- [ ] **Step 7: شغّل shot8 + shot9** — فحص: فاتورة بيع بمخزنين لسطرين مختلفين تُحفظ وتظهر حركة كل سطر في مخزنه؛ تحذير النقص يذكر المخزن؛ رقم الفاتورة مطلوب. لقطة للمحرر بعمود المخزن.

---

### Task 7: طباعة الفاتورة بعمود المخزن (documents.js)

**Files:**
- Modify: `src/renderer/js/documents.js` (printInvoice ~493)
- Test: `tools/shot9.js`

- [ ] **Step 1: أضف عمود المخزن** — في printInvoice rows أضف `warehouse: l.warehouseName || '—'`، وفي cols أضف `{ key: 'warehouse', label: 'المخزن' }` بعد الصنف. أزل سطر "الموقع" المفرد من bodyHtml (صار لكل سطر) وأبقِ قيمة الفاتورة والملاحظات:

```js
      bodyHtml: `${tableHtml(cols, rows, SamDB.fmt(d.totalPieces))}
        <p class="doc-note" style="margin-top:4mm">
          <b>قيمة الفاتورة:</b> ${d.invoice_value ? `${esc(d.invoice_value)} ${esc(CURRENCY)}` : '—'}
          ${d.notes ? `<br><b>ملاحظات:</b> ${esc(d.notes)}` : ''}
        </p>`,
```

- [ ] **Step 2: تحقق بصري** — shot9 لقطة معاينة الفاتورة؛ تأكد عمود المخزن يظهر لكل سطر.

---

### Task 8: طباعة متعددة الصفحات (ui.js + theme.css)

**Files:**
- Modify: `src/renderer/js/ui.js` (printPreview ~398، sheet)
- Modify: `src/renderer/css/theme.css` (أضف .print-page)
- Test: `tools/shot9.js`

**Interfaces:**
- Produces: `printPreview(opts)` يقبل `opts.pages` (مصفوفة خيارات sheet) فيعرض/يطبع كل صفحة منفصلة.

- [ ] **Step 1: أضف CSS فواصل الصفحات** — في theme.css قسم الطباعة:

```css
.print-page { page-break-after: always; break-after: page; }
.print-page:last-child { page-break-after: auto; break-after: auto; }
.pv-pages { display: flex; flex-direction: column; gap: 18px; align-items: center; }
```

- [ ] **Step 2: عدّل printPreview** — استبدل `const built = sheet(opts);` بـ:

```js
    let built;
    if (Array.isArray(opts.pages) && opts.pages.length) {
      built = el('div', 'pv-pages');
      opts.pages.forEach((p) => {
        const wrap = el('div', 'print-page');
        wrap.appendChild(sheet(p));
        built.appendChild(wrap);
      });
    } else {
      built = sheet(opts);
    }
```

عدّل fit() ليقيس عرض أول sheet: `const natural = (built.querySelector('.sheet') || built).offsetWidth || 794;`. عدّل doPrintNow ليمرر landscape من opts (كما هو). عنوان المعاينة `opts.title` يبقى.

- [ ] **Step 3: تحقق** — shot9: استدعاء printPreview بصفحتين تجريبيتين؛ تأكد ظهور صفحتين في المعاينة وأن الطباعة تفصلهما (فحص بصري + وجود .print-page بعدد 2).

---

### Task 9: تصاريح الخروج للبيع وتصاريح الانتقال للنقل (documents.js)

**Files:**
- Modify: `src/renderer/js/documents.js` (printGatePass ~534 → permitPages + printPermits، والتصدير ~613، وأزرار المحرر/العرض)
- Modify: `src/main/db.js` (getDocument lines JOIN: أضف w.location AS warehouseLocation, dw.location AS destWarehouseLocation)
- Test: `tools/shot8.js`، `tools/shot9.js`

**Interfaces:**
- Consumes: `printPreview({pages})` (Task 8)، `getDocument` (يعيد lines مع warehouseId/warehouseName/warehouseLocation/dest_warehouse_id/destWarehouseName/destWarehouseLocation).
- Produces: `permitPages(d)` تعيد صفحة لكل مخزن (للبيع: تجميع حسب المخزن؛ للنقل: تجميع حسب مخزن المصدر مع الوجهة)، مجموع الكميات = إجمالي المستند. `printPermits(id)` يطبعها. تعمل للبيع والنقل.

- [ ] **Step 1: اكتب الفحص الفاشل** — في shot8: (أ) فاتورة بيع بسطرين في مخزنين (40 + 60 = 100): `permitPages(d)` → صفحتين، مجموع total كل صفحة = 100 = d.totalPieces، كل صفحة أصناف مخزنها فقط. (ب) مستند نقل بسطرين من مصدرين مختلفين: `permitPages(d)` → صفحتين (واحدة لكل مصدر)، كل صفحة تذكر الوجهة، ومجموع الكميات = إجمالي النقل. شغّل وتوقع الفشل.

- [ ] **Step 2: اكتب permitPages + printPermits** — استبدل printGatePass:

```js
  /** one permit page per warehouse. sale: exit to customer (group by warehouse).
      transfer: exit to destination (group by SOURCE warehouse). quantities sum to the doc total. */
  function permitPages(d) {
    const isTransfer = d.kind === 'transfer';
    const groups = {};
    d.lines.forEach((l) => {
      const key = l.warehouse_id || 0; // source warehouse for transfers, warehouse for sales
      const g = groups[key] = groups[key] || {
        name: l.warehouseName || '—', location: l.warehouseLocation || '',
        dests: new Set(), lines: []
      };
      g.lines.push(l);
      if (isTransfer && l.destWarehouseName) g.dests.add(`${l.destWarehouseName}${l.destWarehouseLocation ? ' — ' + l.destWarehouseLocation : ''}`);
    });
    const count = Object.keys(groups).length;
    const pages = Object.values(groups).map((g, gi) => {
      const rows = g.lines.map((l, i) => ({
        no: i + 1, item: `${l.itemCode} — ${l.itemName}`, unit: l.baseUnit,
        cartons: SamDB.fmt(l.cartons), bags: SamDB.fmt(l.bags), pieces: SamDB.fmt(l.pieces)
      }));
      const total = g.lines.reduce((a, l) => a + SamDB.n(l.pieces), 0);
      const cols = [
        { key: 'no', label: 'م', align: 'center' },
        { key: 'item', label: 'الصنف' },
        { key: 'unit', label: 'الوحدة', align: 'center' },
        { key: 'cartons', label: 'كراتين', align: 'center' },
        { key: 'bags', label: 'أكياس', align: 'center' },
        { key: 'pieces', label: 'الكمية', align: 'end' }
      ];
      const head = [
        { k: isTransfer ? 'من مخزن' : 'العميل / الجهة', v: isTransfer ? `${g.name}${g.location ? ' — ' + g.location : ''}` : (d.partyName || '—') },
        { k: 'رقم المستند', v: d.doc_no },
        { k: 'التاريخ', v: d.doc_date }
      ];
      if (isTransfer) head.push({ k: 'إلى مخزن', v: [...g.dests].join(' / ') || '—' });
      else head.push({ k: 'المخزن', v: `${g.name}${g.location ? ' — ' + g.location : ''}` });
      return {
        title: isTransfer ? 'تصريح انتقال بين المخازن' : 'تصريح خروج للبوابة',
        subtitle: `مرفق بمستند ${d.kindAr || ''} رقم ${d.doc_no} — تصريح ${gi + 1} من ${count}`,
        docRef: `GP-${d.doc_no}-${gi + 1}`,
        docRefLabel: 'رقم التصريح',
        head,
        bodyHtml: `
          <p class="doc-note">${isTransfer ? 'صرح بانتقال الكميات التالية من مخزن المصدر إلى الوجهة المذكورة' : 'صرح بخروج الكميات التالية من هذا المخزن فقط'}، ويمنع خروج أي بضاعة غير مذكورة. <b>لا تظهر الأسعار.</b></p>
          <p class="doc-note">وسيلة النقل: .......................... &nbsp;&nbsp; اسم السائق: .......................... &nbsp;&nbsp; رقم اللوحة: .................</p>
          ${tableHtml(cols, rows, SamDB.fmt(total))}
          <p class="doc-note" style="margin-top:3mm"><b>إجمالي هذا التصريح:</b> ${SamDB.fmt(total)} · <b>إجمالي المستند:</b> ${SamDB.fmt(d.totalPieces)}</p>`,
        footer: 'SAM Management System — تصريح (كميات فقط)',
        signatures: ['أمين المخازن', 'السائق', 'حارس البوابة']
      };
    });
    const sum = Object.values(groups).reduce((a, g) => a + g.lines.reduce((x, l) => x + SamDB.n(l.pieces), 0), 0);
    if (sum !== SamDB.n(d.totalPieces)) console.warn('permit reconciliation mismatch', sum, d.totalPieces);
    return pages;
  }

  async function printPermits(id) {
    const d = await SamDB.call('getDocument', id);
    const pages = permitPages(d);
    if (!pages.length) return toast('لا توجد أصناف في المستند', 'warn');
    printPreview({ title: `${d.kind === 'transfer' ? 'تصاريح انتقال' : 'تصاريح خروج'} (${pages.length})`, pages });
  }
```

- [ ] **Step 3: أضف الموقع في getDocument** — في db.js استعلام lines (~918) عدّل JOIN warehouses لإضافة `w.location AS warehouseLocation, dw.location AS destWarehouseLocation` alongside warehouseName/destWarehouseName.

- [ ] **Step 4: حدّث المراجع والأزرار** — استبدل كل `printGatePass(` بـ `printPermits(` (render extra ~79، submit ~398، viewDoc ~483). حدّث التصدير: `window.SamDocs = { load, openEditor, viewDoc, printInvoice, printPermits };`. في المحرر: زر `gate` يظهر للبيع **والنقل** (`kind !== 'sale' && kind !== 'transfer'` للإخفاء)، وتسميته ديناميكية: للنقل "حفظ وطباعة تصريح الانتقال" وللبيع "حفظ وطباعة تصاريح الخروج". في render extra وviewDoc اجعل الخيار متاحًا لـ sale وtransfer مع تسمية مناسبة.

- [ ] **Step 5: شغّل shot8 + shot9** — توقع نجاح فحص المطابقة للبيع والنقل، ولقطة لتصريح انتقال (مصدر→وجهة) وتصريحَي بيع في صفحات منفصلة.

---

### Task 10: شاشة التقرير اليومي (daily.js + app.html + app.js + session.js)

**Files:**
- Create: `src/renderer/js/daily.js`
- Modify: `src/renderer/app.html` (عنصر تنقل + قسم `#v-daily` + script)
- Modify: `src/renderer/js/app.js` (VIEW_TITLE/LOADERS/NEW_ACTIONS + PERM_SCREEN)
- Modify: `src/main/session.js` (SCREEN_LABELS.daily)
- Test: `tools/shot9.js`، `tools/shot8.js`

**Interfaces:**
- Consumes: `dailyReport` (Task 4)، `SamUI.printPreview/tableHtml`، `SamDB.saveXlsx` (موجود).
- Produces: `window.SamDaily = { load, run }`.

- [ ] **Step 1: أضف القسم والتنقل في app.html** — في القائمة الجانبية أضف زر تنقل بعد التقارير:

```html
<button class="nav-item" data-view="daily"><svg class="ic"><use href="#i-chart"/></svg><span>التقرير اليومي</span></button>
```

وأضف قسمًا `<section id="v-daily" class="view">` يحوي: شريط أدوات (حقل تاريخ `#dailyDate`، زر `#btnRunDaily`، زر `#btnDailyXlsx`، زر `#btnDailyPrint`)، حاوية جدول `#dailyTbl`، حالة فارغة `#dailyEmpty`. وأضف `<script src="js/daily.js"></script>` قبل app.js.

- [ ] **Step 2: اكتب daily.js** — ملف IIFE على نمط reports.js:

```js
'use strict';
(function () {
  const { el, esc, toast, icon, emptyState, toggleEmpty, tableHtml, printPreview, CURRENCY } = SamUI;
  const state = { data: null, ran: false };

  async function load() {
    const d = document.getElementById('dailyDate');
    if (!d.value) d.value = new Date().toISOString().slice(0, 10);
    if (state.ran) run();
  }

  async function run() {
    const date = document.getElementById('dailyDate').value || new Date().toISOString().slice(0, 10);
    let res;
    try { res = await SamDB.call('dailyReport', { date, buckets: ['good'], includeCustomer: false }); }
    catch (e) { return toast(e.message, 'bad'); }
    state.data = res; state.ran = true;
    render();
    toast(`التقرير اليومى ${date}: ${SamDB.fmt(res.rows.length)} صنف · ${res.warehouses.length} مخزن`, 'ok');
  }

  function render() {
    const res = state.data;
    const whs = res.warehouses;
    const head = `<tr><th>الصنف</th><th>الوحدة</th>${whs.map((w) => `<th colspan="2">${esc(w.name)}<div class="dim">${esc(w.code)}</div></th>`).join('')}<th colspan="2">الإجمالي</th></tr>
      <tr><th></th><th></th>${whs.map(() => '<th>دخل اليوم</th><th>المتبقي</th>').join('')}<th>دخل اليوم</th><th>المتبقي</th></tr>`;
    const body = res.rows.map((r) => `<tr>
      <td>${esc(r.itemCode)} — ${esc(r.itemName)}</td><td class="num">${esc(r.baseUnit)}</td>
      ${whs.map((w) => { const c = r.cells[w.id] || { inQty: 0, balance: 0 }; return `<td class="num">${SamDB.fmt(c.inQty)}</td><td class="num qty">${SamDB.fmt(c.balance)}</td>`; }).join('')}
      <td class="num">${SamDB.fmt(r.totalIn)}</td><td class="num qty">${SamDB.fmt(r.totalBalance)}</td></tr>`).join('');
    const tot = `<tr class="tot-row"><td colspan="2">إجمالي كل مخزن</td>${whs.map((w) => { const t = res.warehouseTotals[w.id]; return `<td class="num">${SamDB.fmt(t.inQty)}</td><td class="num qty">${SamDB.fmt(t.balance)}</td>`; }).join('')}<td class="num">${SamDB.fmt(res.grand.inQty)}</td><td class="num qty">${SamDB.fmt(res.grand.balance)}</td></tr>`;
    document.getElementById('dailyTbl').innerHTML = `<thead>${head}</thead><tbody>${body}${tot}</tbody>`;
    const has = res.rows.length > 0;
    emptyState('dailyEmpty', { icon: 'i-chart', title: has ? '' : 'لا توجد أصناف', hint: has ? '' : 'أضف أصنافًا وحركات لعرض التقرير اليومي.' });
    toggleEmpty('dailyEmpty', has);
  }

  function xlsx() {
    if (!state.ran) return toast('شغّل التقرير أولاً', 'bad');
    const res = state.data; const whs = res.warehouses;
    const columns = [{ header: 'الصنف', key: 'item', width: 30 }, { header: 'الوحدة', key: 'unit', width: 10 }];
    whs.forEach((w) => { columns.push({ header: `${w.name} — دخل اليوم`, key: `in_${w.id}`, width: 16, numFmt: '#,##0' }); columns.push({ header: `${w.name} — المتبقي`, key: `bal_${w.id}`, width: 16, numFmt: '#,##0' }); });
    columns.push({ header: 'إجمالي دخل اليوم', key: 'totalIn', width: 18, numFmt: '#,##0' }, { header: 'إجمالي المتبقي', key: 'totalBalance', width: 18, numFmt: '#,##0' });
    const rows = res.rows.map((r) => { const o = { item: `${r.itemCode} — ${r.itemName}`, unit: r.baseUnit, totalIn: r.totalIn, totalBalance: r.totalBalance }; whs.forEach((w) => { o[`in_${w.id}`] = r.cells[w.id].inQty; o[`bal_${w.id}`] = r.cells[w.id].balance; }); return o; });
    SamDB.saveXlsx({ fileName: `التقرير-اليومي-${res.date}.xlsx`, title: 'التقرير اليومي للمخزون', subtitle: `بتاريخ ${res.date}`, columns, rows, totals: { totalIn: res.grand.inQty, totalBalance: res.grand.balance } });
  }

  function print() {
    if (!state.ran) return toast('شغّل التقرير أولاً', 'bad');
    const res = state.data;
    printPreview({ title: 'التقرير اليومي للمخزون', subtitle: `بتاريخ ${res.date}`, docRef: res.date, docRefLabel: 'التاريخ',
      head: [{ k: 'التاريخ', v: res.date }, { k: 'عدد المخازن', v: SamDB.fmt(res.warehouses.length) }, { k: 'إجمالي المتبقي', v: SamDB.fmt(res.grand.balance) }],
      bodyHtml: document.getElementById('dailyTbl').outerHTML, dense: true, landscape: true,
      footer: 'SAM Management System — التقرير اليومي (الكميات بالوحدة الأساسية)', signatures: ['المعد', 'المراجع', 'المدير'] });
  }

  document.getElementById('btnRunDaily').addEventListener('click', run);
  document.getElementById('btnDailyXlsx').addEventListener('click', xlsx);
  document.getElementById('btnDailyPrint').addEventListener('click', print);
  window.SamDaily = { load, run };
})();
```

ملاحظة: تحقق من توقيع `SamDB.saveXlsx`/`app.saveXlsx` spec في preload/xlsx.js وطابق مفاتيح الأعمدة (header/key/width/numFmt) لما يدعمه xlsx.js؛ عدّل إن اختلف.

- [ ] **Step 3: اربط app.js** — أضف `daily: 'التقرير اليومي'` إلى VIEW_TITLE، و`daily: () => window.SamDaily && window.SamDaily.load()` إلى LOADERS، و`daily: () => window.SamDaily && window.SamDaily.run()` إلى NEW_ACTIONS. أضف خريطة صلاحيات قبل go():

```js
const PERM_SCREEN = { daily: 'reports' };
```

وفي go() استبدل فحص الصلاحية بـ `const permView = PERM_SCREEN[view] || view; if (SamSession.user && !SamSession.can(permView, 'view')) {...}`. وفي applyPermissions() إخفاء التنقل استخدم `SamSession.can(PERM_SCREEN[b.dataset.view] || b.dataset.view, 'view')`. وفي NEW_ACTIONS shortcut تحقق الصلاحية استخدم PERM_SCREEN أيضًا.

- [ ] **Step 4: session.js** — أضف `daily: 'التقرير اليومي'` إلى SCREEN_LABELS (لرسائل الصلاحية؛ الوصول الفعلي عبر reports).

- [ ] **Step 5: شغّل shot8 + shot9** — فحص واجهة dailyReport عبر IPC؛ لقطة شاشة التقرير اليومي بجدول صنف×مخزن وإجماليات؛ تصدير xlsx وطباعة.

---

### Task 11: الوحدة الديناميكية في التقارير والصنف (reports.js + items.js)

**Files:**
- Modify: `src/renderer/js/reports.js` (COLUMNS ~25-26، cellText)
- Modify: `src/renderer/js/items.js` (حقل base_unit)
- Test: `tools/shot9.js`

- [ ] **Step 1: تسميات عامة** — في reports.js COLUMNS غيّر `{ key: 'inQty', label: 'وارد (حبة)' ...}` إلى `label: 'وارد'` و`outQty` إلى `'صادر'`. فعّل عمود الوحدة `{ key: 'baseUnit', label: 'الوحدة', on: true }` (كان false). في cellText تأكد أن baseUnit يعرض وحدة الصنف. هكذا الوحدة مرتبطة بالصنف لا ثابتة.

- [ ] **Step 2: حقل الوحدة في الصنف** — في items.js تأكد أن حقل base_unit له placeholder واضح `'مثال: حبة، علبة، أمبول'` ونص مساعد "هذه الوحدة تظهر في كل الفواتير والتقارير". (إن كان موجودًا، حسّن النص فقط.)

- [ ] **Step 3: تحقق بصري** — shot9 لقطة التقارير تظهر عمود الوحدة بقيم مختلفة حسب الصنف.

---

### Task 12: التحقق النهائي وتشغيل التطبيق

**Files:**
- Modify: `tools/shot8.js` (تجميع كل الفحوص)، `tools/shot9.js`، `tools/migrate-check.js`
- Test: تشغيل التطبيق الفعلي

- [ ] **Step 1: شغّل كل الاختبارات** — `env -u ELECTRON_RUN_AS_NODE npx electron tools/shot8.js` (كل الفحوص خضراء)، `env -u ELECTRON_RUN_AS_NODE npx electron tools/migrate-check.js` (لا فقدان بيانات + move_date معبأ)، `env -u ELECTRON_RUN_AS_NODE npx electron tools/shot9.js` (لا أخطاء renderer + لقطات).

- [ ] **Step 2: أصلح أي فشل** — شخّص وأصلح حتى الخضار الكامل.

- [ ] **Step 3: شغّل التطبيق للمستخدم** — `env -u ELECTRON_RUN_AS_NODE npx electron .` (خلفية)، تحقق من `C:/Users/Elite/AppData/Local/Temp/sam-startup.log` (database opened / window created / لا أخطاء).

- [ ] **Step 4: أبلغ بالعربية** — أخبر المستخدم أن التعديلات طُبقت والبرنامج مفتوح للتجربة، وأن الرفع إلى GitHub ينتظر أمره الصريح "ارفع التحديث".

---

## Self-Review (مراجعة ذاتية اجراها الكاتب)

- تغطية المواصفة: القسم 4.1→Task1/5؛ 4.2→Task2/3؛ 4.3→Task6/7؛ 4.4 و4.4ب→Task8/9؛ 4.5→Task4/10؛ 4.6→Task11؛ 4.7→موزع (افتراضيات Today/أول مخزن/سليم)؛ 5→Task2/12؛ 6→Task12. لا فجوات.
- اتساق الأنواع: `dailyReport` signature ثابت بين Task4 وTask10؛ `permitPages`/`printPermits` ثابتة في Task9 (بيع ونقل)؛ `availableInLocation` موجودة ومستخدمة في Task3/6؛ `opts.pages` معرف في Task8 ومستخدم في Task9.
- عناصر نائبة: لا TBD/TODO؛ كل خطوة كود حقيقي أو أمر تشغيل محدد.
- ملاحظة تحقق أثناء التنفيذ: توقيع saveXlsx spec (Task10) وwarehouseLocation في getDocument (Task9) يجب التأكد منهما من الكود الفعلي قبل التطبيق.