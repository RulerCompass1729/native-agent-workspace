const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Include path-spawned entries as well as local require() dependencies.
function missingSources(entries) {
  const app = path.resolve(__dirname, '..'), listed = new Set(entries), seen = new Set(), missing = [];
  function visit(relative) {
    if (seen.has(relative)) return;
    seen.add(relative);
    const file = path.join(app, relative);
    assert.ok(fs.existsSync(file), 'Source entry exists: ' + relative);
    if (!listed.has(relative)) missing.push(relative);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.relative(app, path.resolve(path.dirname(file), match[1]));
      if (!target.startsWith('..')) visit(target);
    }
  }
  // dsh-tui-preload.mjs: loaded by path (--import) into the DSH TUI process.
  for (const root of ['main.cjs', 'butler-dsh-host.mjs', 'butler-dsh-launch.py', 'butler-dsh-privacy.cjs', 'dsh-tui-preload.mjs']) visit(root);
  assert.ok(seen.size > 50, 'the require walk reached the application modules');
  return missing;
}
test('every local module reachable from desktop and dedicated DSH entry points is packaged', () => {
  assert.deepEqual(missingSources(sourceList().entries), []);
});
test('omitting any independently loaded DSH entry fails the package closure guard', () => {
  for (const name of ['butler-dsh-host.mjs', 'butler-dsh-launch.py', 'butler-dsh-privacy.cjs', 'dsh-tui-preload.mjs']) {
    assert.ok(missingSources(sourceList().entries.filter(entry => entry !== name)).includes(name), name);
  }
});

// Captured from the resolved union of main 908005f and runner 6baa02a,
// before sorting/reformatting, plus the integration union. This is a retention
// floor: additions need no fixture edit; the dependency walk checks omissions.
function sourceList() {
  const text = fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8');
  const start = text.indexOf('const sources = [');
  const end = text.indexOf('];', start);
  assert.ok(start > 0 && end > start);
  const body = text.slice(start + 'const sources = ['.length, end);
  return { body, entries: [...body.matchAll(/'([^']+)'/g)].map(match => match[1]) };
}
test('the source allowlist retains the baseline while allowing new source entries', () => {
  const before = require('./fixtures/package-sources-before-format.json');
  const entries = new Set(sourceList().entries);
  for (const name of before) assert.ok(entries.has(name), 'Retained package source: ' + name);
});
test('the source allowlist is alphabetized with one file on each line', () => {
  const { body, entries } = sourceList();
  assert.equal(new Set(entries).size, entries.length, 'Each source is packaged once');
  assert.deepEqual(entries, [...entries].sort());
  const lines = body.split('\n').filter(line => line.trim());
  assert.equal(lines.length, entries.length);
  for (const line of lines) assert.match(line, /^      '[^']+',$/);
});
