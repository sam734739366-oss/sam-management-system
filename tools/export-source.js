'use strict';

/**
 * tools/export-source.js — writes the whole source code of the project into a
 * single plain-text file on the Desktop for external review.
 *
 *   node tools/export-source.js
 *
 * Included : .js .html .css .json (except package-lock.json) .sql
 * Excluded : node_modules, dist, .git, .tmp, any "data" folder, images/binaries
 * Header   : a 64-char "=" rule, "FILE: <relative/path>", then the same rule
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_NAME = 'SAM_Code_Review.txt';

const INCLUDE_EXT = new Set(['.js', '.html', '.css', '.json', '.sql']);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.tmp', 'data', 'backups']);
const EXCLUDE_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const BINARY_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.db', '.db-wal', '.db-shm', '.exe', '.zip', '.node', '.pak', '.bin', '.dat', '.log', '.blockmap', '.yml', '.lockb']);

const RULE = '='.repeat(64);

function walk(dir, rel, acc) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.warn('  ! unreadable folder skipped: ' + rel);
    return acc;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const relPath = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(abs, relPath, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (BINARY_EXT.has(ext) && !INCLUDE_EXT.has(ext)) continue;
    if (!INCLUDE_EXT.has(ext)) continue;
    if (EXCLUDE_FILES.has(ent.name)) continue;
    if (path.basename(abs) === OUT_NAME) continue;
    acc.push({ abs, relPath, size: fs.statSync(abs).size });
  }
  return acc;
}

function desktopDir() {
  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'سطح المكتب'),
    path.join(os.homedir(), 'سطح المكتب')
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* try next */ }
  }
  return os.homedir();
}

(() => {
  const files = walk(ROOT, '', []);
  const target = path.join(desktopDir(), OUT_NAME);

  let lines = 0;
  let bytes = 0;
  const chunks = [];

  chunks.push(RULE);
  chunks.push('SAM MANAGEMENT SYSTEM — FULL SOURCE EXPORT');
  chunks.push('project : ' + path.basename(ROOT));
  chunks.push('version : ' + require(path.join(ROOT, 'package.json')).version);
  chunks.push('date    : ' + new Date().toISOString());
  chunks.push('files   : ' + files.length);
  chunks.push('');
  chunks.push('Included: .js .html .css .json (no package-lock.json) .sql');
  chunks.push('Excluded: node_modules, dist, .git, .tmp, data folders, images and binaries');
  chunks.push(RULE);
  chunks.push('');
  chunks.push('TABLE OF CONTENTS');
  files.forEach((f, i) => chunks.push(String(i + 1).padStart(3, ' ') + '. ' + f.relPath + '  (' + f.size.toLocaleString('en-US') + ' bytes)'));
  chunks.push('');

  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch (e) {
      content = '[unreadable file: ' + e.message + ']';
    }
    if (content.charCodeAt(content.length - 1) === 0xfeff) content = content.slice(1);
    chunks.push(RULE);
    chunks.push('FILE: ' + f.relPath);
    chunks.push(RULE);
    chunks.push(content.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n');
    chunks.push('');
    lines += content.split('\n').length;
    bytes += Buffer.byteLength(content);
  }

  fs.writeFileSync(target, chunks.join('\n'), 'utf8');

  const out = fs.statSync(target);
  console.log('exported ' + files.length + ' files, ' + lines.toLocaleString('en-US') + ' lines, ' + Math.round(bytes / 1024).toLocaleString('en-US') + ' KB of code');
  console.log('written to: ' + target);
  console.log('file size : ' + Math.round(out.size / 1024).toLocaleString('en-US') + ' KB');

  const groups = {};
  files.forEach((f) => {
    const top = f.relPath.split('/')[0];
    groups[top] = (groups[top] || 0) + 1;
  });
  console.log('by folder : ' + JSON.stringify(groups));
})();
