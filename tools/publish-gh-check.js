'use strict';

/** tools/publish-gh-check.js — the tag preflight must create a missing tag. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'tools', 'publish-gh.js'), 'utf8');
const match = source.match(/function ensureTagOnRemote\(\) \{[\s\S]*?\n\}/);
if (!match) throw new Error('ensureTagOnRemote function not found');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  ok ? pass++ : fail++;
}

function run(localExists, remoteExists) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') {
      if (!localExists) throw new Error('missing tag');
      return 'abc123\n';
    }
    if (args[0] === 'ls-remote') return remoteExists ? 'abc123\trefs/tags/v0.9.2\n' : '';
    return '';
  };
  const fn = vm.runInNewContext(`(${match[0]})`, { git, TAG: 'v0.9.2', console });
  fn();
  return calls;
}

try {
  const created = run(false, false);
  check('missing local tag is created', created.some((c) => c.startsWith('tag -a v0.9.2')), created);
  check('new tag is pushed to origin', created.some((c) => c === 'push origin refs/tags/v0.9.2'), created);
} catch (e) {
  check('missing local tag is created', false, e.message);
  check('new tag is pushed to origin', false, e.message);
}

try {
  const existing = run(true, true);
  check('existing tag is not recreated', !existing.some((c) => c.startsWith('tag -a')), existing);
  check('existing remote tag is not repushed', !existing.some((c) => c.startsWith('push origin')), existing);
} catch (e) {
  check('existing tag is not recreated', false, e.message);
  check('existing remote tag is not repushed', false, e.message);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
