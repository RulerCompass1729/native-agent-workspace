const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '..');
const packaging = fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8');

// Unit tests run from source, so only this check sees a renderer module the installed main process cannot load.
test('every renderer module main-process code requires is packaged', () => {
  const required = new Set();
  for (const file of fs.readdirSync(app).filter(name => name.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(app, file), 'utf8');
    for (const match of source.matchAll(/require\('\.\/(renderer\/[\w.-]+\.js)'\)/g)) required.add(match[1]);
  }
  assert.ok(required.has('renderer/confirmation-batch.js'));
  const missing = [...required].filter(name => !packaging.includes(`'${name}'`));
  assert.deepEqual(missing, []);
});


test('every local CommonJS dependency required by Main is in the production allowlist', () => {
  const source = fs.readFileSync(path.join(app, 'main.cjs'), 'utf8');
  const required = new Set([...source.matchAll(/require\(['"]\.\/([\w.-]+\.cjs)['"]\)/g)].map(match => match[1]));
  const declaration = packaging.match(/const sources = (\[[\s\S]*?\n    \]);/);
  assert.ok(declaration, 'The actual package source allowlist is readable');
  const included = new Set(require('node:vm').runInNewContext(declaration[1]));
  assert.ok(required.has('backend-switch.cjs'));
  assert.ok(included.size > 100);
  assert.deepEqual([...required].filter(name => !included.has(name)), []);
});
