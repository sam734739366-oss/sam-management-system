'use strict';

/**
 * tools/set-release-meta.js — gives the published release a proper Arabic
 * title and notes. Uses the git-stored credential for this request only and
 * never prints it.
 */
const { execFileSync } = require('child_process');
const https = require('https');

const OWNER = 'sam734739366-oss';
const REPO = 'sam-management-system';

function token() {
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
  `الإصدار **v${VERSION}** — تغيير جذري شامل (V2): تصميم فاتح، منطق مخزن واحد، وتصدير Excel حقيقي.`,
  '',
  '## الملفات',
  `- \`SAM-Setup-${VERSION}.exe\` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**`,
  `- \`SAM-Setup-${VERSION}.exe.blockmap\` + \`latest.yml\` — ملفات التحديث التلقائي (electron-updater).`,
  `- \`SAM-Portable-${VERSION}.exe\` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).`,
  '',
  '## الجديد في V2',
  '- **تصميم فاتح احترافي**: خلفية `#f8fafc`، أسطح بيضاء، أزرق `#2563eb`، لمسات تيل، ونص `#1e293b` — بلا أي ثيم كحلي وبلا دمج نصوص.',
  '- صناديق إدخال بحواف ناعمة وحلقة تركيز خفيفة، وكل الحقول الرقمية تبدأ **فارغة** (placeholder = 0) بدل الأصفار الافتراضية.',
  '- **فواصل الآلاف** في كل حقول الكميات والمبالغ عند مغادرة الحقل، وقيمة الفاتورة فارغة افتراضياً ومنسّقة بالريال اليمني.',
  '- الحركة التقديمية انتقلت إلى **ما بعد تسجيل الدخول**: شاشة دخول نظيفة وسريعة، ثم انفجار الزجاجة بجزيئات زرقاء/ذهبية مع صوت نجاح خلال ثانيتين.',
  '- **تصدير Excel حقيقي بصيغة xlsx** (exceljs): أرقام كأرقام، رؤوس ملوّنة، عروض أعمدة تلقائية، ورقة من اليمين لليسار، وصف إجمالي.',
  '- طباعة احترافية: ترويسة وسطى (العميل/المورد + رقم المستند + التاريخ) فوق الجدول، وتوقيعات السائق وأمين المخزن والمدير موزعة أسفل الصفحة، وعلامة `SAM 775158678` خفيفة.',
  '- **مخزن واحد**: ما كان يُسمى مخازن أصبح هناجر/مواقع داخل نفس المخزن، والتقارير تعرض الإجمالي مع تفصيل اختياري حسب الموقع.',
  '- توحيد المصطلح: «محجوز» → **«محرز»** في كل الشاشات والتقارير والطباعة.',
  '- كل شيء يُحتسب بالوحدة الأساسية للصنف، والكرتونة/الكيس «وحدات لكل كرتونة/كيس» معلوماتية فقط.',
  '- **النفخ للغير**: استلام مادة العميل، تسليم الجيد له، وتسجيل التالف في `scrap_movements` بعلامة `is_customer = 1` مع سجل هدر مستقل.',
  '- **أرشيف الإنتاج**: سجل أيام الإنتاج بلا أي أثر على المخزون، قابل للتعديل والطباعة.',
  '- حساب **الحبات الجيدة تلقائياً** من الأكياس والكسر (أكياس × وحدات الكيس − الكسر) في تقرير الإنتاج.',
  '- **نقص الرصيد لم يعد يمنع الحفظ**: يظهر تحذير تفصيلي ويمكن المتابعة، والرصيد السالب يُعرض كما هو.',
  '- تقارير: السليم افتراضياً والتالف/المحرز باختيارك، وأعمدة وارد/صادر، والإجمالي يجمع **الأعمدة الظاهرة فقط**.',
  '- تجربة استخدام: حالات فارغة أنيقة مع زر إضافة، إشعارات Toast بدل النوافذ، ومؤشر تحميل، واختصارات `Ctrl+S` حفظ و`Ctrl+N` جديد و`Ctrl+P` طباعة و`Esc` إغلاق.',
  '',
  '## ملاحظات',
  '- الملفات **غير موقّعة رقمياً** (لا توجد شهادة)، لذا قد يعرض Windows SmartScreen تحذيراً: More info → Run anyway.',
  '- المزامنة تتم عبر مجلد Google Drive على جهازك (بلا OAuth)، وقاعدة البيانات ترقّى تلقائياً من إصدار 0.1.0 عند أول تشغيل.',
  '- بيانات الدخول الافتراضية: `admin` / `admin123` — غيّرها من الإعدادات ← المستخدمون والصلاحيات.',
  '- قاعدة البيانات تُخزَّن في `%APPDATA%\\SAM Management System\\sam.db`.'
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
