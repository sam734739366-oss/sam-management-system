'use strict';

/**
 * tools/rebuild-sqlite.js — makes better-sqlite3 match Electron's ABI.
 *
 * better-sqlite3 v13 ships N-API builds, but v12 (which we use) ships V8-ABI
 * prebuilds, so the plain `npm install` binary does not load inside Electron.
 * This helper downloads the matching electron prebuild, and falls back to a
 * source rebuild when no prebuild exists for that Electron version.
 *
 * Run: npm run rebuild:native
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SQL_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3');
const BIN = process.platform === 'win32' ? 'node.cmd' : 'node';

const electronVersion = () => {
  const p = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(p)) throw new Error('electron is not installed');
  return require(p).version;
};

const prebuildPath = () => path.join(SQL_DIR, 'build', 'Release', 'better_sqlite3.node');

function runPrebuildInstall(version) {
  const cli = path.join(ROOT, 'node_modules', 'prebuild-install', 'bin.js');
  if (!fs.existsSync(cli)) throw new Error('prebuild-install missing — run npm i -D prebuild-install');
  execFileSync(BIN, [
    cli,
    '--runtime=electron',
    `--target=${version}`,
    '--arch=x64',
    `--platform=${process.platform}`,
    '--verbose'
  ], { cwd: SQL_DIR, stdio: 'inherit' });
}

function runElectronRebuild() {
  const cli = path.join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error('@electron/rebuild missing — run npm i -D @electron/rebuild');
  execFileSync(BIN, [cli, '-f', '-w', 'better-sqlite3'], { cwd: ROOT, stdio: 'inherit' });
}

(() => {
  const version = electronVersion();
  console.log(`electron ${version} — fetching the matching better-sqlite3 binary`);
  try {
    runPrebuildInstall(version);
  } catch (e) {
    console.warn('prebuild download failed, falling back to a source rebuild:', e.message);
    runElectronRebuild();
  }
  const target = prebuildPath();
  if (!fs.existsSync(target)) {
    console.error('FAILED: no better_sqlite3.node at', target);
    process.exit(1);
  }
  console.log('ok:', target, `${Math.round(fs.statSync(target).size / 1024)} KB`);
})();
