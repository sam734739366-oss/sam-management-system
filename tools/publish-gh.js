'use strict';

/**
 * tools/publish-gh.js — publishes the built artifacts to a GitHub Release.
 *
 * It reads the credential git already has for github.com (via
 * `git credential fill`), passes it to electron-builder as GH_TOKEN for this
 * process only, and never prints or stores it.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readToken() {
  let out = '';
  try {
    out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 30000
    });
  } catch (e) {
    throw new Error('تعذّر قراءة بيانات اعتماد GitHub من git: ' + e.message);
  }
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('لا يوجد token محفوظ لـ github.com في git credential store');
  return m[1].trim();
}

const token = readToken();
console.log('credential loaded (length ' + token.length + ', not printed)');

const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
delete env.ELECTRON_RUN_AS_NODE;

const res = spawnSync(process.execPath, [builderCli, '--win', '--x64', '--publish', 'always'], {
  cwd: ROOT,
  env,
  stdio: 'inherit'
});
console.log('electron-builder exit code =', res.status);
process.exit(res.status || 0);
