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

const notes = [
  'الإصدار الأول — **نظام إدارة الأصناف والمخازن والإنتاج** (Electron + SQLite، واجهة عربية RTL).',
  '',
  '## الملفات',
  '- `SAM-Setup-0.1.0.exe` — المثبّت الكامل (NSIS) مع اختصار سطح المكتب. **هذا ما يفعّل التحديث التلقائي.**',
  '- `SAM-Setup-0.1.0.exe.blockmap` + `latest.yml` — ملفات التحديث التلقائي (electron-updater).',
  '- `SAM-Portable-0.1.0.exe` — نسخة محمولة بلا تثبيت (لا تتلقى تحديثات تلقائية).',
  '',
  '## أبرز المزايا',
  '- شاشة دخول متحركة: الزجاجة تطفو وتدور ثم تنفجر إلى جزيئات مع صوت، ويستمر تأثير الجزيئات حتى تسجيل الدخول.',
  '- **الحبة هي وحدة الحساب**؛ الكرتونة والكيس حقلان معلوماتيان فقط.',
  '- الأصناف مع أرصدة افتتاحية (سليم / تالف / محجوز) للمخزن الرئيسي والمخازن الفرعية.',
  '- المخازن + العملاء والموردون (`parties`)، وكل الاختيارات بقوائم منسدلة **searchable** بزر إضافة سريع.',
  '- العمليات: مشتريات / مبيعات / مرتجع مبيعات / مرتجع مشتريات / تحويلات بين المخازن.',
  '- **تصريح خروج** بالكميات فقط (بلا أسعار) مع أسطر توقيع للمستلم والسائق وأمين المخزن والحراسة.',
  '- الإنتاج: صرف الخام، وتقرير إنتاج يومي بتوجيه تلقائي — جيد ← منتج تام سليم، تالف علب ← منتج تام تالف، تالف أمبولة ← خام تالف — وحساب العجز/الزيادة.',
  '- مركز تقارير ديناميكي: فلاتر كاملة، أعمدة اختيارية، «رصيد المخزن الرئيسي الحالي»، «الرصيد المتحرك»، إجمالي الكمية والقيمة، تصدير PDF و Excel.',
  '- مستخدمون وأدوار (مدير / مستخدم مقيد بالشاشات والصلاحيات) مع تطبيق الصلاحيات في العملية الرئيسية.',
  '- نسخ احتياطي محلي (آخر 12 نسخة) + مزامنة مع مجلد Google Drive الذي تختاره.',
  '- حذف **نهائي** بلا حالة «ملغي»، مع نافذة تحذير تعرض الأثر على المخزون ثم تعكسه.',
  '- علامة مائية `SAM 775158678` في كل مخططات الطباعة + معاينة قبل الطباعة.',
  '',
  '## ملاحظات',
  '- الملفات **غير موقّعة رقمياً** (لا توجد شهادة)، لذا قد يعرض Windows SmartScreen تحذيراً: More info → Run anyway.',
  '- بيانات الدخول الافتراضية: `admin` / `admin123` — غيّرها من الإعدادات ← المستخدمون والصلاحيات.',
  '- قاعدة البيانات تُخزَّن في `%APPDATA%\\SAM Management System\\sam.db`.'
].join('\n');

(async () => {
  const tok = token();
  const found = await req('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/v0.1.0`, null, tok);
  if (found.status !== 200) throw new Error('release lookup failed: ' + found.status);
  const id = JSON.parse(found.body).id;
  const res = await req('PATCH', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${id}`, {
    name: 'SAM Management System v0.1.0',
    body: notes
  }, tok);
  console.log('PATCH release ->', res.status, res.status === 200 ? 'ok' : res.body.slice(0, 200));
  const j = JSON.parse(res.body);
  console.log('title:', j.name);
  console.log('url:', j.html_url);
  console.log('assets:', (j.assets || []).length);
})().catch((e) => { console.error(e.message); process.exit(1); });
