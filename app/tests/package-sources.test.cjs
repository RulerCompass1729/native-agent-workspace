const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Include path-spawned entries as well as local require() dependencies.
// dsh-tui-preload.mjs: loaded by path (--import) into the DSH TUI process.
function missingSources(entries, roots = ['main.cjs', 'butler-dsh-host.mjs', 'butler-dsh-launch.py', 'butler-dsh-privacy.cjs', 'dsh-tui-preload.mjs']) {
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
  for (const root of roots) visit(root);
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

// The service hashes every names entry before it can start. A module need not be
// reachable by require() to be required in the installed payload.
function runtimeSources() {
  const text = fs.readFileSync(path.join(__dirname, '../service-client.cjs'), 'utf8');
  const declaration = text.match(/const names = (\[[\s\S]*?\]);/);
  assert.ok(declaration, 'Read the actual runtime-copy declaration');
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(names.length > 10, 'The runtime declaration contains its modules');
  return names;
}
test('the package contains every runtime-copy input and every local Main dependency', () => {
  assert.deepEqual(missingSources(sourceList().entries, ['main.cjs', ...runtimeSources()]), []);
});
test('omitting any runtime-copy input fails the package closure guard', () => {
  const roots = ['main.cjs', ...runtimeSources()], entries = sourceList().entries;
  for (const name of runtimeSources()) {
    assert.ok(missingSources(entries.filter(entry => entry !== name), roots).includes(name), name);
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
test('the local Core Image helper and its fixed adapter are both in the package', () => {
  const entries = new Set(sourceList().entries);
  for (const name of ['mobile-carrier.cjs', 'mobile-qr.cjs', 'mobile-qr.jxa']) assert.ok(entries.has(name), name);
  assert.match(fs.readFileSync(path.join(__dirname, '../mobile-qr.cjs'), 'utf8'), /path\.join\(__dirname, 'mobile-qr\.jxa'\)/);
});
test('the source allowlist is alphabetized with one file on each line', () => {
  const { body, entries } = sourceList();
  assert.equal(new Set(entries).size, entries.length, 'Each source is packaged once');
  assert.deepEqual(entries, [...entries].sort());
  const lines = body.split('\n').filter(line => line.trim());
  assert.equal(lines.length, entries.length);
  for (const line of lines) assert.match(line, /^      '[^']+',$/);
});
