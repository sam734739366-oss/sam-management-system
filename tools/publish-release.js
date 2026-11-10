'use strict';

/**
 * tools/publish-release.js — ينشر ملفات البناء على GitHub في إصدارة واحدة.
 *
 * لماذا هذا الملف موجود:
 *
 * electron-builder ينشئ ناشراً (publisher) لكل هدف بناء على حدة — هدف
 * NSIS وهدف Portable. عندما يُشغَّل بـ --publish always يتسابق الناشران
 * على إنشاء الإصدار في GitHub في اللحظة نفسها، فينشئ GitHub نسختين من
 * الإصدار يحملان الوسم نفسه (v0.4.0). النتيجة: صفحة الإصدار تعرض
 * ملفاً واحداً فقط، بينما الملفات الأخرى تبقى في نسخة أخرى مخفية —
 * والعميل لا يرى المثبّت.
 *
 * الحل: نفصل البناء عن النشر.
 *   1) npx electron-builder --win --x64 --publish never   → يبني الملفات فقط
 *   2) node tools/publish-release.js                       → ينشرها في إصدار واحد
 *
 * وهذا السكربت آمن يُعاد تشغيله: الملف الموجود بالحجم نفسه يُتخطّى،
 * فلا تتكرر النسخ ولا تضيع البيانات.
 *
 * التوكن يقرأ من متغير البيئة GH_TOKEN فقط، ولا يُطبع ولا يُكتب في أي ملف.
 */

const fs = require('fs');
const path = require('path');

const OWNER = 'sam734739366-oss';
const REPO = 'sam-management-system';
const DIST = path.join(__dirname, '..', 'dist');

/* ما نرفعه من مجلد dist — كل ما يخص التوزيع، لا ملفات البناء-debug */
const WANTED = ['.exe', '.blockmap', '.yml'];
const SKIP = ['builder-debug.yml'];

function api(pathname, method, body, token, raw) {
  const url = raw || ('https://api.github.com' + pathname);
  const headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'sam-management-system-publisher'
  };
  let payload = null;
  if (body) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return fetch(url, { method, headers, body: payload }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: r.status, json, text };
  });
}

/** يرفع ملفاً واحداً إلى إصدار — يستعمل نقطة uploads الخاصة بـ GitHub */
function uploadFile(releaseId, filePath, name, token) {
  const data = fs.readFileSync(filePath);
  const url = 'https://uploads.github.com/repos/' + OWNER + '/' + REPO +
    '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(name);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'User-Agent': 'sam-management-system-publisher'
    },
    body: data
  }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: r.status, json, text };
  });
}

function wantedFiles(version) {
  const dist = process.env.SAM_DIST_DIR || DIST;
  if (!fs.existsSync(dist)) throw new Error('مجلد dist غير موجود — شغّل البناء أولاً');
  const names = fs.readdirSync(dist)
    .filter((n) => !SKIP.includes(n))
    .filter((n) => WANTED.some((e) => n.toLowerCase().endsWith(e)))
    /* ملفات الإصدار القديم قد تكون باقية في dist — لا ننشر إلا ما يخص
       هذا الإصدار تحديداً، عدا latest.yml فهو باسم ثابت. */
    .filter((n) => n === 'latest.yml' || n.indexOf(version) !== -1);

  const out = [];
  for (const n of names) {
    const p = path.join(dist, n);
    if (n === 'latest.yml') {
      /* ملف التحديث التلقائي يجب أن يشير إلى هذا الإصدار وإلا أخطأ
         البرنامج العميل في تحميل تحديث خاطئ */
      let body = '';
      try { body = fs.readFileSync(p, 'utf8'); } catch (e) { body = ''; }
      if (body.indexOf('version: ' + version) === -1) {
        console.log('skip (latest.yml describes another version)');
        continue;
      }
    }
    out.push(p);
  }
  return out.sort();
}

(async () => {
  const token = process.env.GH_TOKEN || '';
  if (!token) throw new Error('متغير البيئة GH_TOKEN غير موجود');

  const version = require('../package.json').version;
  const tag = 'v' + version;

  /* 1. الإصدار — نبحث أولاً حتى لا ننشئ نسخة ثانية */
  let rel = await api('/repos/' + OWNER + '/' + REPO + '/releases/tags/' + tag, 'GET', null, token);
  if (rel.status === 404) {
    console.log('the release does not exist yet — creating it once');
    rel = await api('/repos/' + OWNER + '/' + REPO + '/releases', 'POST', {
      tag_name: tag,
      name: 'SAM Management System ' + tag,
      body: '',
      draft: false,
      prerelease: false
    }, token);
    if (rel.status !== 201) throw new Error('creating the release failed: ' + rel.status + ' ' + rel.text.slice(0, 200));
  } else if (rel.status !== 200) {
    throw new Error('release lookup failed: ' + rel.status);
  }
  const release = rel.json;
  console.log('release id=' + release.id + ' tag=' + release.tag_name + ' assets=' + release.assets.length);

  /* 2. الملفات — نرفع ما هو ناقص فقط */
  const have = new Map((release.assets || []).map((a) => [a.name, a.size]));
  const files = wantedFiles(version);
  if (!files.length) throw new Error('لا توجد ملفات للنشر في dist');

  /* latest.yml هو ما يجعل التحديث التلقائي يعمل — لو غاب أو كان
     لإصدار آخر، نوقف بدل أن ننشر تحديثاً معطوباً على أجهزة العملاء */
  const manifest = files.find((f) => path.basename(f) === 'latest.yml');
  if (!manifest) {
    const dist = process.env.SAM_DIST_DIR || DIST;
    const names = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
    throw new Error(
      'latest.yml غير موجود في dist — لن يُنشر. ' +
      '(الملفات: ' + (names.join('، ') || 'لا شيء') + ')'
    );
  }

  for (const f of files) {
    const name = path.basename(f);
    const size = fs.statSync(f).size;
    if (have.get(name) === size) {
      console.log('skip (already uploaded) ' + name + ' (' + size + ' bytes)');
      continue;
    }
    const up = await uploadFile(release.id, f, name, token);
    if (up.status !== 201) throw new Error('upload failed for ' + name + ': ' + up.status + ' ' + up.text.slice(0, 200));
    console.log('uploaded ' + name + ' (' + size + ' bytes)');
  }

  /* 3. التقرير النهائي */
  const final = await api('/repos/' + OWNER + '/' + REPO + '/releases/' + release.id, 'GET', null, token);
  console.log('---');
  console.log('release page : ' + final.json.html_url);
  for (const a of final.json.assets || []) {
    console.log('  ' + a.name + '  ' + (a.size / 1048576).toFixed(2) + ' MB');
    console.log('    ' + a.browser_download_url);
  }
})().catch((e) => { console.error('PUBLISH FAILED: ' + e.message); process.exit(1); });
