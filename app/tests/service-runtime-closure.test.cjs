const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scratch = require('../../scripts/fixtures/test-scratch.cjs');

test('the private runtime names copy can load Workspace and the mobile session module', t => {
  const app = path.resolve(__dirname, '..');
  const declaration = fs.readFileSync(path.join(app, 'service-client.cjs'), 'utf8').match(/const names = (\[[\s\S]*?\]);/);
  assert.ok(declaration, 'Read the production runtime-copy declaration');
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(names.length > 10);
  const runtime = scratch.directory(path.join(os.tmpdir(), 'naw-h-runtime-closure-'));
  t.after(() => scratch.release());
  for (const name of names) {
    const target = path.join(runtime, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(app, name), target);
  }
  fs.symlinkSync(fs.realpathSync(path.join(app, '../node_modules')), path.join(runtime, 'node_modules'), 'dir');
  assert.equal(typeof require(path.join(runtime, 'workspace.cjs')).Workspace, 'function');
  assert.equal(typeof require(path.join(runtime, 'mobile-session.cjs')).find, 'function');
});
