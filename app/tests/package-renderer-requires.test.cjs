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
