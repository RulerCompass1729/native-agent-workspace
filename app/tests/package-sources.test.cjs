const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every module the packaged main process loads must be in package-mac.cjs's explicit list;
// a missing one only fails when the signed app starts (found by review 2026-11-08).
test('every local module reachable from main.cjs is packaged', () => {
  const root = path.resolve(__dirname, '../..');
  const app = path.join(root, 'app');
  const packager = fs.readFileSync(path.join(root, 'scripts/package-mac.cjs'), 'utf8');
  const start = packager.indexOf('const sources = [');
  const end = packager.indexOf('];', start);
  assert.ok(start > 0 && end > start, 'package-mac.cjs keeps an explicit sources list');
  const listed = new Set();
  for (const match of packager.slice(start, end).matchAll(/'([^']+)'/g)) {
    listed.add(match[1]);
  }
  const seen = new Set();
  const missing = [];
  function visit(relative) {
    if (seen.has(relative)) {
      return;
    }
    seen.add(relative);
    const file = path.join(app, relative);
    if (!fs.existsSync(file)) {
      return;
    }
    if (!listed.has(relative)) {
      missing.push(relative);
    }
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.relative(app, path.resolve(path.dirname(file), match[1]));
      if (!target.startsWith('..')) {
        visit(target);
      }
    }
  }
  visit('main.cjs');
  assert.ok(seen.size > 50, 'the require walk reached the application modules');
  assert.deepEqual(missing, []);
});
