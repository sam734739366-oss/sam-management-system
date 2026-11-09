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
  `الإصدار **v${VERSION}** — الإصدار الثالث (V3): مخازن متساوية بلا مخزن رئيسي، تقرير يومي، وتصاريح لكل مخزن.`,
  '',
  '## الملفات',
  `- \`SAM-Setup-${VERSION}.exe\` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**`,
  `- \`SAM-Setup-${VERSION}.exe.blockmap\` + \`latest.yml\` — ملفات التحديث التلقائي (electron-updater).`,
  `- \`SAM-Portable-${VERSION}.exe\` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).`,
  '',
  '## الجديد في V3',
  '- **لا يوجد مخزن رئيسي**: كل المخازن متساوية، وأنت تعرّف مخازنك بنفسها من شاشة «المخازن» (الاسم + الموقع).',
  '- **الوحدة الأساسية هي المرجع**: الوحدة التي تدخلها عند إنشاء الصنف (حبة/علبة/أمبول/أي وحدة) ترتبط به في كل مكان — الفواتير والتقارير والتصاريح — والكراتين والأكياس معلوماتية فقط.',
  '- **مخزن لكل سطر**: في محرر الفاتورة لكل سطر صنف مخزنه الخاص، ففاتورة واحدة قد تخرج من عدة مخازن.',
  '- **مرآة نظام خارجي**: رقم الفاتورة (يدوي، إجباري) + اسم العميل/المورد + التاريخ — لأن الفواتير تأتي من نظام آخر.',
  '- **تقرير يومي** (صنف × مخزن): «دخل اليوم» و«المتبقي» لكل مخزن، مع إجمالي كل مخزن والإجمالي العام على الشاشة.',
  '- **تصاريح خروج للبوابة**: تصريح واحد لكل مخزن مشتق من الفاتورة، ببيانات العميل والرقم والتاريخ واسم المخزن وموقعه وأصنافه فقط — **بلا أسعار** — مع خانتي توقيع **أمين المخازن** و**السائق**. ومجموع كميات التصاريح = كمية الفاتورة (يُتحقق منه آلياً).',
  '- **تصريح انتقال بين المخازن** لكل نقل، يبيّن من مخزن إلى أي مخزن، مجمّعاً حسب المخزن المصدر.',
  '- **التواريخ في كل مكان**: كل حركة مخزون تحمل تاريخ العمل، والتقارير تُرشّح بالتاريخ لا بتاريخ الإدخال.',
  '- **مركز التقارير**: فترات جاهزة (اليوم / آخر ٣٠ يوماً / هذا الشهر / كل الفترات)، عمود الوحدة يبيّن وحدة كل صنف، وخيار «تفصيل حسب المخزن».',
  '- **تنبيه النقص لكل مخزن**: عند تجاوز الرصيد يظهر «رصيد «الصنف» في مخزن كذا س فقط» بدل رسالة عامة.',
  '- شاشة المخازن صارت مبسّطة: المخازن قائمة مستقلة، والمخازن القديمة تُرقّى تلقائياً إلى متساوية.',
  '',
  '## ملاحظات',
  '- الملفات **غير موقّعة رقمياً** (لا توجد شهادة)، لذا قد يعرض Windows SmartScreen تحذيراً: More info → Run anyway.',
  '- قاعدة البيانات تُرقّى تلقائياً من الإصدار السابق عند أول تشغيل — بياناتك لا تُفقد.',
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
