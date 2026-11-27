'use strict';

/**
 * tools/set-release-meta.js — updates the published GitHub Release title and
 * Arabic notes. Uses the git-stored credential for this request only and never
 * prints or stores it.
 */
const { execFileSync } = require('child_process');
const https = require('https');

const OWNER = 'sam734739366-oss';
const REPO = 'sam-management-system';

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 30000
  });
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('no github credential');
  return m[1].trim();
}

function req(method, url, body, tok) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'sam-management-system-publisher',
        'Authorization': 'token ' + tok,
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const VERSION = require('../package.json').version;
const TAG = `v${VERSION}`;

const notes = [
  `الإصدار **v${VERSION}** — تصحيح عرض متابعة خام العميل: أيقونة فقط في العمليات تفتح شاشة التقرير، مع بقاء تقارير الخام والتقارير المتقدمة وتحديثات المحرر.`,
  '',
  '## الملفات',
  '- `SAM-Setup-' + VERSION + '.exe` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**',
  '- `SAM-Setup-' + VERSION + '.exe.blockmap` + `latest.yml` — ملفات التحديث التلقائي (electron-updater).',
  '- `SAM-Portable-' + VERSION + '.exe` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).',
  '',
  '## الجديد في هذا الإصدار',
  '',
  '### متابعة خام العميل',
  '- تقرير يوضح المستلم والمصروف للإنتاج والتام السليم والمسلّم والمتبقي بالمخازن والمتبقي في الإنتاج.',
  '- الأمبول يساوي العلبة **1:1** فقط؛ الوحدات الأخرى لا تُجمع ولا تُطرح دون معادلة مؤكدة.',
  '- المرتجعات والتالف ظاهران منفصلين، والرصيد محسوب تراكمياً حتى نهاية الفترة.',
  '- **أيقونة متابعة فقط** في أعلى شاشة العمليات؛ عند الضغط تفتح شاشة متابعة خام العميل مباشرة، دون جدول أرشيف مضمّن في الصفحة.',
  '',
  '### تقارير متقدمة',
  '- تقرير الفئات: الوارد والصادر والصافي وقيمة الفواتير لكل فئة ووحدة.',
  '- كشف حساب العميل وكشف حساب المورد مع الرصيد الافتتاحي والجاري والختامي.',
  '- تقرير الصنف لكل صنف ومخزن: الافتتاحي والوارد والصادر والمتبقي، مع تفصيل الحركات.',
  '- النقر على العميل أو المورد أو الصنف أو رقم المستند يفتح التقرير المناسب بفلتر جاهز وزر رجوع.',
  '',
  '### شاشة العمليات والمحرر',
  '- نافذة إدخال المستندات ثابتة: الترويسة وأزرار الحفظ لا تتحرك، والجسم يتحرك عمودياً فقط.',
  '- عند ضيق الشاشة يتحرك جدول الأسطر وحده داخلياً مع تثبيت عمود الصنف، وكل صف جديد يطابق الصف الأول.',
  '- منع تداخل العناوين والحقول وتحسين الحدود والمسافات.',
  '',
  '### التلميع البصري',
  '- حركة رفع صغيرة وموحدة للأيقونات داخل الأزرار والبطاقات.',
  '- إطار تركيز واضح للوحة المفاتيح، وتوحيد ظلال الأيقونات.',
  '- احترام إعداد النظام «تقليل الحركة» وإلغاء الانتقالات غير الضرورية.',
  '',
  '## التحديث من الإصدار السابق',
  '- ثبّت `SAM-Setup-' + VERSION + '.exe` فوق النسخة القديمة مباشرة؛ لا حاجة لحذف البيانات.',
  '- لا توجد ترقية جديدة لقاعدة البيانات في هذا الإصدار، ولا تُحذف أو تُعدّل بيانات المدخلات.',
  '- إن كنت تستخدم مجلد بيانات خاصاً فسيستمر البرنامج بقراءة بياناتك منه.',
  '',
  '## ملاحظات',
  '- الملفات غير موقّعة رقمياً؛ قد يعرض Windows SmartScreen تحذيراً. من «خصائص» الملف يمكنك اختيار **Unblock** ثم تشغيله.',
  '- بيانات الدخول الافتراضية: `admin` / `admin123` — غيّرها من الإعدادات ← المستخدمون والصلاحيات.',
  '- قاعدة البيانات في `%APPDATA%\\SAM Management System\\sam.db` ويمكن تغيير المسار من الإعدادات.'
].join('\n');

(async () => {
  const tok = token();
  const found = await req('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, null, tok);
  if (found.status !== 200) throw new Error('release lookup failed: ' + found.status);
  const id = JSON.parse(found.body).id;
  const res = await req('PATCH', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${id}`, {
    name: `SAM Management System ${TAG}`,
    body: notes
  }, tok);
  console.log('PATCH release ->', res.status, res.status === 200 ? 'ok' : res.body.slice(0, 200));
  const j = JSON.parse(res.body);
  console.log('title:', j.name);
  console.log('url:', j.html_url);
  console.log('assets:', (j.assets || []).length);
})().catch((e) => { console.error(e.message); process.exit(1); });
