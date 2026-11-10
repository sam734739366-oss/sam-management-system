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
  `الإصدار **v${VERSION}** — الإصدار الرابع (V4): إنتاج ومخزون مصحّح، طباعة A4 احترافية، تقارير داخل نوافذ، ومجلد بيانات ومزامنة سحابية تناسب تركيب البرنامج على جهاز جديد.`,
  '',
  '## الملفات',
  `- \`SAM-Setup-${VERSION}.exe\` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**`,
  `- \`SAM-Setup-${VERSION}.exe.blockmap\` + \`latest.yml\` — ملفات التحديث التلقائي (electron-updater).`,
  `- \`SAM-Portable-${VERSION}.exe\` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).`,
  '',
  '## التحديث من الإصدار السابق',
  '- **ثبّت الملف فوق النسخة القديمة مباشرة** — لن يُطلب منك حذف أي شيء.',
  '- قاعدة البيانات تُرقّى تلقائياً عند أول تشغيل: **لا تُحذف ولا تُعدَّل أي بيانات مدخلة**، ولا يتغيّر أي رصيد.',
  '- خانة «المحرز» اختفت من الواجهة (كما طلبت)، وأي كمية كانت فيها اندمجت تلقائياً في «سليم» حتى لا تضيع — إجمالي المخزون لم يتغيّر.',
  '- مجلد البيانات الافتراضي بقي كما هو `%APPDATA%\\SAM Management System\\sam.db`. إن نقلت مجلد البيانات إلى مكان آخر، يقرأ البرنامج من المسار الجديد تلقائياً.',
  '',
  '## الجديد في V4',
  '',
  '### الإنتاج والمخزون',
  '- **سند استلام الإنتاج صار مستنداً حقيقياً يزيد الرصيد**: تختار المخزن لكل سطر، ويُنشأ التصريح الذي يخرج به المنتج من المصنع — لأن الاستلام من مخزن وارد لا يكتمل إلا بتصريح خروج.',
  '- **قسم «العجز والتالف» مستقل تماماً**: تقرير الإنتاج اليومي (عجز الكراتين وتالفها) عاد بلا أي أثر على المخزون، وله تقاريره الخاصة.',
  '- كل تقرير واختيار مخزن داخل البرنامج: الإ生产能力 وحركة المخزون تُبنى على المستندات لا على جداول موازية.',
  '',
  '### الطباعة والتصدير',
  '- **الطباعة تعمل** — أُصلح الخلل الذي كان يُلغي الطباعة ويظهر رسالة «الغيت الطباعة».',
  '- **معاينة الطباعة على ورق A4** بهوامش صغيرة، واتجاه الصفحة يتكيّف مع عرض التقرير (عمودي أو أفقي).',
  '- **تصدير Excel حقيقي** بملف `.xlsx` يفتح بخط واضح وحجم مقروء — أُصلح التصدير إلى Excel وPDF.',
  '- البرنامج يطبع على **أي طابعة متصلة بالجهاز** — لا طابعة مرتبطة باسم واحد، فيعمل مع أي طابعة يركّبها العميل.',
  '',
  '### التقارير',
  '- **التقرير صار نافذة مستقلة**: زر «تشغيل التقرير» يفتح نافذة فيها المعاينة، وأزرار التصدير والطباعة، وزر طباعة يفتح معاينة الطباعة.',
  '- **ضغطة مزدوجة على أي بند في التقرير** تفتح صفحته الأصلية (فاتورة/مرتجع/سند) للتعديل أو الحذف.',
  '- قبل التعديل أو الحذف تظهر **تحذير بأثره الفعلي**، والحذف **حقيقي**: تُحذف كل الحركات التي أنشأها المستند، فتعود حسابات المخازن كما لو أن المستند لم يوجد.',
  '- تقارير جديدة جاهزة، كلها مقرونة بفترة من تاريخ إلى تاريخ: حركة المخزون، أرصدة الأصناف، كشف حساب صنف، حركة المخازن، ملخص الحركات، الأصناف الناقصة، التالف والهدر، حساب الأطراف، وعجز وتالف الإنتاج.',
  '',
  '### الإدخال الذكي',
  '- **قائمة منسدلة تظهر عند الضغط على العلامة** — بدون كتابة أي حرف — وتبقى ظاهرة بعد اختيار الصنف، فبإمكانك تغييره بسهولة.',
  '- **لا تداخل بين الرموز**: علامة `+` للإضافة، والسهم لفتح القائمة، لكل خانة أيقونتها الثابتة.',
  '- **لا قيم افتراضية في خانات الاسم والأصناف** — كل حقل يبدأ فارغاً (عدا الوحدة الأساسية «حبة» لأنها مرجع البرنامج).',
  '',
  '### هوية المستندات',
  '- كل مستند له **تروسته ولونه وأيقونته الخاصة** (شراء/بيع/مرتجع/نقل/إنتاج/تصريح دخول/تصريح خروج/تسوية) — تفرّقها من أول نظرة.',
  '- لكل خانة إدخال **أيقونة ثابتة** توضّح معناها، ودليل مدمج يشرح كل شاشة وأي زر يفعل ماذا.',
  '',
  '### بياناتك ونسخك الاحتياطي',
  '- **اختيار مجلد البيانات**: تختار أين تُحفظ بياناتك، فينتقل البرنامج إليها فوراً والنسخة القديمة تبقى سليمة — نسخ احتياطي بلا تعقيد.',
  '- **مزامنة سحابية بريدك فقط**: تكتب بريدك الإلكتروني، فيكتشف البرنامج Google Drive أو OneDrive أو Dropbox على جهازك ويكتب نسخة داخله. لا اختيار ملف ولا مفاتيح.',
  '- **دليل استخدام داخل البرنامج** (زر `?` في شريط العنوان)، و**نافذة تحديث** (زر التنزيل) تعرض حالة التحديث وشريط تقدّم.',
  '',
  '## ملاحظات',
  '- الملفات **غير موقّعة رقمياً** (لا توجد شهادة)، لذا قد يعرض Windows SmartScreen تحذيراً: More info → Run anyway.',
  '- إذا يظهر SmartScreen على جهاز العميل، افتح الملف من «التنزيلات» ← زر يمين ← «خصائص» ← ضع علامة على «إلغاء الحظر» (Unblock) ← Apply.',
  '- بيانات الدخول الافتراضية: `admin` / `admin123` — غيّرها من الإعدادات ← المستخدمون والصلاحيات.',
  '- قاعدة البيانات تُخزَّن في `%APPDATA%\\SAM Management System\\sam.db` — ويمكن تغيير المسار من الإعدادات ← مجلد البيانات والسحابة.'
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
