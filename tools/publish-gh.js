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
const VERSION = require(path.join(ROOT, 'package.json')).version;
const TAG = `v${VERSION}`;

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

/**
 * GitHub refuses to create a *published* release whose tag does not exist in
 * the repository ("Published releases must have a valid tag"). electron-builder
 * creates the release before it pushes anything, so we make sure the tag is
 * already on the remote before the publish starts.
 */
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, ...opts });
}

function ensureTagOnRemote() {
  const local = git(['rev-parse', '-q', '--verify', `refs/tags/${TAG}`], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!local) {
    // tag the current HEAD of the checked-out branch
    git(['tag', '-a', TAG, '-m', `SAM Management System ${TAG}`]);
    console.log(`created local tag ${TAG}`);
  }
  const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${TAG}`], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!remote) {
    git(['push', 'origin', `refs/tags/${TAG}`]);
    console.log(`pushed tag ${TAG} to origin`);
  } else {
    console.log(`tag ${TAG} already present on origin`);
  }
}

ensureTagOnRemote();

const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const env = {
  ...process.env,
  GH_TOKEN: token,
  GITHUB_TOKEN: token,
  // allow re-publishing into a release that is older than 2 hours
  EP_GH_IGNORE_TIME: 'true'
};
delete env.ELECTRON_RUN_AS_NODE;

/**
 * The build output directory can be overridden so a locked `dist/win-unpacked`
 * (e.g. held by a file scanner) does not block the publish. The artifacts are
 * named after the version, so the uploaded file names stay the same.
 */
const outDir = process.env.SAM_OUT_DIR || 'dist';
const args = [builderCli, '--win', '--x64', '--publish', 'always'];
if (outDir !== 'dist') args.push(`--config.directories.output=${outDir}`);

const res = spawnSync(process.execPath, args, {
  cwd: ROOT,
  env,
  stdio: 'inherit'
});
console.log('electron-builder exit code =', res.status);
process.exit(res.status || 0);
