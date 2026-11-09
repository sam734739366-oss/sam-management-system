'use strict';

/**
 * tools/upload-release-assets.js — uploads the built artifacts to an existing
 * GitHub Release.
 *
 * Why this exists: electron-builder's own publisher streams the whole file into
 * a single request without a timeout, and on a slow link the ~95 MB installer
 * upload can hang forever (observed: zero bytes/sec, connection still open).
 * This uploader instead:
 *   - streams the file from disk with a known Content-Length
 *   - sets an explicit socket + idle timeout so a stalled transfer fails fast
 *   - retries with backoff
 *   - reports progress
 *
 * It also writes `latest.yml` using electron-builder's own serializer and
 * hasher, so the file is byte-identical to what electron-builder produces.
 *
 * The GitHub token is read from the git credential store and never printed.
 */
const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'sam734739366-oss';
const REPO = 'sam-management-system';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UPLOADS = `https://uploads.github.com/repos/${OWNER}/${REPO}`;

const VERSION = require(path.join(ROOT, 'package.json')).version;
const TAG = `v${VERSION}`;
const OUT_DIR = process.env.SAM_OUT_DIR || 'dist-pub';

// The link here sustains only ~50 KB/s. A short idle timeout kills the
// transfer even while bytes are still flowing, so the idle window is long.
const IDLE_MS = Number(process.env.SAM_UPLOAD_IDLE_MS || 300000);
const MAX_ATTEMPTS = Number(process.env.SAM_UPLOAD_ATTEMPTS || 5);

const { serializeToYaml } = require(path.join(ROOT, 'node_modules', 'builder-util', 'out', 'util.js'));
const { hashFile } = require(path.join(ROOT, 'node_modules', 'app-builder-lib', 'out', 'util', 'hash.js'));

function readToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 30000
  });
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('no github credential in git credential store');
  return m[1].trim();
}

const TOKEN = readToken();

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(url);
    const headers = {
      'User-Agent': 'sam-release-uploader',
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json, txt });
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('api request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Upload one file to a release, streaming it from disk. */
function upload(releaseId, filePath, name) {
  const stat = fs.statSync(filePath);
  return new Promise((resolve, reject) => {
    const u = new URL(`${UPLOADS}/releases/${releaseId}/assets`);
    u.searchParams.set('name', name);

    const started = Date.now();
    let sent = 0;
    let lastPrint = 0;

    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'sam-release-uploader',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* not json */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const secs = ((Date.now() - started) / 1000).toFixed(0);
          const kbps = ((sent / 1024) / Math.max(1, (Date.now() - started) / 1000)).toFixed(1);
          console.log(`   uploaded ${name} (${stat.size} bytes in ${secs}s, ${kbps} KB/s) -> asset ${json && json.id}`);
          resolve(json);
        } else {
          reject(new Error(`upload ${name} failed: ${res.statusCode} ${txt.slice(0, 300)}`));
        }
      });
    });

    // no Nagle: without this the kernel coalesces small writes and the
    // transfer crawls on a high-latency link
    req.on('socket', (s) => { s.setNoDelay(true); });

    // idle timeout: fires only when NO bytes flow at all
    req.setTimeout(IDLE_MS, () => req.destroy(new Error(`upload stalled (no data for ${IDLE_MS / 1000}s)`)));

    const src = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    src.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastPrint > 15000) {
        lastPrint = now;
        const pct = ((sent / stat.size) * 100).toFixed(1);
        const kbps = ((sent / 1024) / ((now - started) / 1000)).toFixed(1);
        console.log(`   ${name}: ${pct}% (${(sent / 1048576).toFixed(1)}/${(stat.size / 1048576).toFixed(1)} MB) ${kbps} KB/s`);
      }
    });
    src.on('error', (e) => req.destroy(e));
    req.on('error', (e) => { src.destroy(); reject(e); });

    src.pipe(req);
  });
}

async function uploadWithRetry(releaseId, filePath, name) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await upload(releaseId, filePath, name);
    } catch (e) {
      console.log(`   attempt ${attempt}/${MAX_ATTEMPTS} for ${name} failed: ${e.message}`);
      // a partially created asset with the same name blocks the next try
      await deleteAssetByName(releaseId, name);
      if (attempt === MAX_ATTEMPTS) throw e;
      const wait = attempt * 10000;
      console.log(`   retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function deleteAssetByName(releaseId, name) {
  const res = await api('GET', `${API}/releases/${releaseId}/assets?per_page=100`);
  if (res.status !== 200) return;
  for (const a of res.json || []) {
    if (a.name === name) {
      await api('DELETE', `${API}/releases/assets/${a.id}`);
      console.log(`   removed stale asset ${a.name} (${a.state})`);
    }
  }
}

/** Build latest.yml exactly like electron-builder's updateInfoBuilder does. */
async function writeLatestYml(dir, installerName) {
  const installer = path.join(dir, installerName);
  const sha512 = await hashFile(installer);
  const size = fs.statSync(installer).size;
  const info = {
    version: VERSION,
    files: [{ url: installerName, sha512, size }],
    path: installerName,
    sha512,
    releaseDate: new Date().toISOString()
  };
  const content = Buffer.from(serializeToYaml(info, false, true));
  const out = path.join(dir, 'latest.yml');
  fs.writeFileSync(out, content);
  console.log(`   wrote ${out}`);
  return out;
}

(async () => {
  const dir = path.join(ROOT, OUT_DIR);

  const rel = await api('GET', `${API}/releases/tags/${TAG}`);
  if (rel.status !== 200) throw new Error(`release lookup failed: ${rel.status}`);
  const release = rel.json;
  console.log(`release ${TAG} id=${release.id} draft=${release.draft} url=${release.html_url}`);

  const setupName = `SAM-Setup-${VERSION}.exe`;
  const portableName = `SAM-Portable-${VERSION}.exe`;
  const blockmapName = `${setupName}.blockmap`;

  for (const f of [setupName, portableName, blockmapName]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error(`missing build artifact: ${p}`);
  }

  // remove leftovers: probe files and any target asset that is not fully uploaded
  const before = await api('GET', `${API}/releases/${release.id}/assets?per_page=100`);
  const targets = new Set([setupName, portableName, blockmapName, 'latest.yml']);
  for (const a of before.json || []) {
    const isProbe = a.name.startsWith('probe');
    const isBadTarget = targets.has(a.name) && a.state !== 'uploaded';
    if (isProbe || isBadTarget) {
      await api('DELETE', `${API}/releases/assets/${a.id}`);
      console.log(`   removed ${a.name} (${a.state})`);
    }
  }

  await writeLatestYml(dir, setupName);

  // small files first (fast), then the two big binaries concurrently
  for (const f of [blockmapName, 'latest.yml']) {
    console.log(`uploading ${f} ...`);
    await uploadWithRetry(release.id, path.join(dir, f), f);
  }

  console.log('uploading the two large binaries concurrently ...');
  await Promise.all([
    uploadWithRetry(release.id, path.join(dir, setupName), setupName),
    uploadWithRetry(release.id, path.join(dir, portableName), portableName)
  ]);

  const final = await api('GET', `${API}/releases/${release.id}/assets?per_page=100`);
  console.log('--- assets on release ---');
  for (const a of final.json || []) {
    console.log(` - ${a.name} ${a.size} ${a.state}`);
  }
  const missing = [setupName, portableName, blockmapName, 'latest.yml']
    .filter((f) => !(final.json || []).some((a) => a.name === f && a.state === 'uploaded'));
  if (missing.length) {
    console.error('NOT fully uploaded:', missing.join(', '));
    process.exit(1);
  }
  console.log('all assets uploaded successfully');
})().catch((e) => { console.error('upload failed:', e.message); process.exit(1); });
