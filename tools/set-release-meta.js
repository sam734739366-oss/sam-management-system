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
  /* On the CI runner there is no stored credential — the workflow passes
     GH_TOKEN in the environment. Locally we fall back to git's store. */
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
  `الإصدار **v${VERSION}** — الإصدار السادس (V6): استعادة البيانات من ملف، فحص تحديث لا يعلّق أبداً، طباعة A4 كاملة بلا قصّ، رقم تلقائي لكل مستند، صفحة ملوّنة لكل نوع مستند، ومربعات أكبر وأوضح بلا تمرير أفقي.`,
  '',
  '## الملفات',
  `- \`SAM-Setup-${VERSION}.exe\` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**`,
  `- \`SAM-Setup-${VERSION}.exe.blockmap\` + \`latest.yml\` — ملفات التحديث التلقائي (electron-updater).`,
  `- \`SAM-Portable-${VERSION}.exe\` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).`,
  '',
  '## التحديث من الإصدار السابق',
  '- **ثبّت الملف فوق النسخة القديمة مباشرة** — لن يُطلب منك حذف أي شيء.',
  '- قاعدة البيانات تُرقّى تلقائياً عند أول تشغيل: **لا تُحذف ولا تُعدَّل أي بيانات مدخلة**، ولا يتغيّر أي رصيد.',
  '- إن كنت تستخدم مجلد بيانات خاصاً (الإعدادات ← مجلد البيانات) فمجلدك يبقى كما هو وتُقرأ بياناتك منه.',
  '',
  '## الجديد في V6',
  '',
  '### البيانات والاستعادة',
  '- **استعادة البيانات من ملف**: أيقونة «استعادة» في شريط العنوان، وزر «استعادة من ملف…» في الإعدادات ← النسخ الاحتياطي.',
  '- **سحب وإفلات**: اسحب ملف البيانات (sam.db) على نافذة البرنامج فيتعرّف عليه أولاً، ويأخذ نسخة من بياناتك الحالية، ثم يستعيد.',
  '- الملف يُفحص قبل أي تعديل: إن لم يكن قاعدة بيانات SAM تُرفض العملية برسالة واضحة، وبياناتك الحالية تبقى في نسخة `sam-pre-restore-*.db`.',
  '',
  '### التحديث التلقائي',
  '- **فحص التحديث ما يضلّ يبحث أبداً**: سؤال واحد إلى GitHub بمهلة 12 ثانية، وينتهي دائماً بحالة نهائية.',
  '- **الشريط يتوقّف دائماً**: لا خطوط متحرّكة بعد الخطأ، والنسبة ترجع صفراً، والمعاينة تنتهي عند 100٪.',
  '- الشاشة تقول لك **نسختك** و**الإصدار المنشور على GitHub** بالرقم الصحيح.',
  '',
  '### الطباعة',
  '- **لم تعد الورقة تُقصّ من اليسار**: التقرير اليومي وتقارير الحركات تملأ صفحة A4 كاملة (297×210 مم عرضي) بلا ربع ناقص.',
  '- **معاينة الطباعة قبل الطباعة**: ترى الورقة كما ستخرج تماماً، مع تكبير وتصغير وحفظ PDF.',
  '- **كل صفحة وكل مستند قابل للطباعة** — من شريط العنوان أو Ctrl+P، والخط في الورق أوضح وأكبر.',
  '',
  '### المستندات',
  '- **رقم النظام تلقائي** لكل مستند (‏SAL-0001، ‏PUR-0001 …) لا يتكرر ولا يتغيّر بعد الحفظ.',
  '- **خانة ثانية للرقم القادم من نظام آخر** (رقم الفاتورة في نظامك) — يظهر في كل المستندات والتصاريح والمطبوعة.',
  '- **كل نوع مستند له صفحته المنبثقة ولونه الخاص**: تختار النوع من صفحة «اختر نوع المستند»، والمحرر يلبس لون نوعه.',
  '- **مستند جديد: سند توريد الإنتاج** — يخصم من المخزن ويصدر «تصريح توريد إنتاج» قابل للطباعة.',
  '',
  '### التقارير',
  '- **التقرير اليومي** يعرض وارد وصادر ومتبقي **لكل مخزن** على حدة، مع صف «إجمالي كل المخازن» والمتبقي الإجمالي.',
  '',
  '### شكل البرنامج',
  '- **المربعات أكبر وأوضح**: حد واضح، زوايا ملوّنة، وظل خفيف — وخط مقروء في كل الشاشات.',
  '- **لا تمرير أفقي**: كل المربعات ظاهرة بلا تحريك يمين وشال، والجداول الطويلة تمرّر داخل إطارها.',
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
