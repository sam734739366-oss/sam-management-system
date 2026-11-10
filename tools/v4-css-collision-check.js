/**
 * tools/v4-css-collision-check.js — guards against CSS class collisions.
 *
 * A compound selector like `.tb-act.busy` silently inherits theme.css's
 * `.busy` layout (position:fixed; top:62px; z-index:9700) and floats the
 * button out of the title bar. This script reports every compound selector
 * whose modifier class already exists in theme.css so the clash is caught
 * before it reaches a screenshot.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CSS = path.join(ROOT, 'src', 'renderer', 'css');

function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ''); }

/* every class name that appears alone (not as part of a compound) in theme.css */
function standaloneClasses(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  const re = /(?<![\w-])\.([a-zA-Z][a-zA-Z0-9_-]*)(?![\w-])/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

/* every compound selector in a file: ".a.b" */
function compoundSelectors(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    const head = m[1].trim();
    if (!head || head.startsWith('@')) continue;
    head.split(',').forEach((sel) => {
      const s = sel.trim();
      const parts = s.split(/\s+/).pop();
      const cls = parts.match(/^\.[a-zA-Z][\w-]*(\.[a-zA-Z][\w-]*)+$/);
      if (cls) out.push({ selector: s, parts: cls[0].slice(1).split('.') });
    });
  }
  return out;
}

const themeClasses = standaloneClasses(path.join(CSS, 'theme.css'));
let bad = 0;
for (const f of fs.readdirSync(CSS).filter((x) => x.endsWith('.css') && x !== 'theme.css')) {
  for (const c of compoundSelectors(path.join(CSS, f))) {
    /* the LAST class in the compound is the modifier that must be unique */
    const modifier = c.parts[c.parts.length - 1];
    if (themeClasses.has(modifier)) {
      console.log('RISK  ' + f + '  ' + c.selector + '   (modifier "' + modifier + '" also exists in theme.css)');
      bad++;
    }
  }
}
console.log(bad === 0 ? 'OK — no compound selector reuses a theme.css class as its modifier' : bad + ' risky compound selectors');
