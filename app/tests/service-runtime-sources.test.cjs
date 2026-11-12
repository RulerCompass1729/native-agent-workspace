// The service runs from a copy of a fixed list of modules (service-client.cjs). Every local module the daemon loads
// must be on that list, or the copied service cannot start ("运行服务未能启动"). Reads source only; starts nothing.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const app = path.resolve(__dirname, '..');
function copied() {
  const text = fs.readFileSync(path.join(app, 'service-client.cjs'), 'utf8'), start = text.indexOf('const names = ['), end = text.indexOf('];', start);
  assert.ok(start > 0 && end > start); return new Set([...text.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]));
}
function missing(names) {
  const seen = new Set(), out = [];
  const visit = relative => {
    if (seen.has(relative)) return; seen.add(relative);
    if (!names.has(relative)) out.push(relative);
    const source = fs.readFileSync(path.join(app, relative), 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.relative(app, path.resolve(path.dirname(path.join(app, relative)), match[1]));
      if (!target.startsWith('..') && /\.(c?js|json)$/.test(target)) visit(target);
    }
  };
  visit('daemon.cjs'); assert.ok(seen.size > 10, 'The walk reached the service modules'); return out;
}
test('every local module the service daemon loads is copied into its runtime', () => {
  assert.deepEqual(missing(copied()), []);
});
test('leaving one out is caught', () => {
  const names = copied(); names.delete('record-history.cjs');
  assert.deepEqual(missing(names), ['record-history.cjs']);
});
