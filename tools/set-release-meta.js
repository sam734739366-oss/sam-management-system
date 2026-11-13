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
  `الإصدار **v${VERSION}** — الإصدار السابع (V7): مسار «النفخ للغير» بأربع خطوات كما في الواقع، وفترة في التقارير، وعمود يجمع المخازن، وتذييل توقيع صحيح لكل مستند.`,
  '',
  '## الملفات',
  '- `SAM-Setup-' + VERSION + '.exe` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**',
  '- `SAM-Setup-' + VERSION + '.exe.blockmap` + `latest.yml` — ملفات التحديث التلقائي (electron-updater).',
  '- `SAM-Portable-' + VERSION + '.exe` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).',
  '',
  '## التحديث من الإصدار السابق',
  '- **ثبّت الملف فوق النسخة القديمة مباشرة** — لن يُطلب منك حذف أي شيء.',
  '- قاعدة البيانات تُرقّى تلقائياً عند أول تشغيل: **لا تُحذف ولا تُعدَّل أي بيانات مدخلة**، ولا يتغيّر أي رصيد.',
  '- إن كنت تستخدم مجلد بيانات خاصاً (الإعدادات ← مجلد البيانات) فمجلدك يبقى كما هو وتُقرأ بياناتك منه.',
  '',
  '## الجديد في V7',
  '',
  '### النفخ للغير — أربع خطوات كما في الواقع',
  '- **استلام خام العميل**: مستند مستقل باسم العميل والمخزن وصنف الخامة والكمية، ويطبع **تصريح دخول** معه.',
  '- **دفعة العميل**: كل استلام يأخذ رقم دفعة يتبع الخامة من باب المصنع حتى تسليم العلب — فيعرف البرنامج كم علبة خرجت من خامة كل عميل.',
  '- **صرف خام إلى الإنتاج**: مستند واحد لكل الحالات (شركة أو عميل) — اختفى التكرار بين «سند توريد الإنتاج» و«توريد الإنتاج».',
  '- **استلام المنتج التام**: العلب ترجع من الإنتاج إلى المخزن وهي مربوطة بنفس الدفعة.',
  '- **فاتورة مبيعات للعميل**: رقم الفاتورة من نظامك الآخر + **خانة «أجور نفخ»** تكتب فيها المبلغ بنفسك.',
  '',
  '### التقارير',
  '- **التقرير اليومي بفترة**: «من تاريخ» إلى «إلى تاريخ» بدل يوم واحد.',
  '- **عمود «إجمالي كل المخازن»**: في كل تقرير فيه تفصيل مخازن — مجموع كل المخازن لكل صنف.',
  '- **التقارير بلا تذييل توقيع**: التقرير ليس مستنداً ولا يُوقَّع.',
  '',
  '### الطباعة والتوقيع',
  '- **تذييل توقيع صحيح لكل نوع مستند**: تصريح الخروج (أمين المخازن + السائق + حارس البوابة) · استلام الإنتاج (أمين المخازن + مسؤول الإنتاج + المدير — بلا سائق) · الفواتير (أمين المخزن + المراجع + المدير).',
  '- **تختار بنفسك**: مفاتيح في نافذة الطباعة تضيف أو تشيل أي توقيع، وزر «رجوع للافتراضي»، والاختيار يُحفظ لكل نوع مستند.',
  '',
  '### تصدير Excel',
  '- **إصلاح كامل لمسارات التصدير**: ملفات xlsx حقيقية تفتح بأعمدة وأرقام صحيحة، بلا أخطاء ولا أعمدة مقطوعة.',
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
