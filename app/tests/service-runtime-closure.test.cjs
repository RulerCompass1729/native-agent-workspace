const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scratch = require('../../scripts/fixtures/test-scratch.cjs');

const app = path.resolve(__dirname, '..');
let copied = null;

// One copy for the file: scratch.release() runs once per process.
function runtimeCopy() {
  if (copied) return copied;
  const declaration = fs.readFileSync(path.join(app, 'service-client.cjs'), 'utf8').match(/const names = (\[[\s\S]*?\]);/);
  assert.ok(declaration, 'Read the production runtime-copy declaration');
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(names.length > 10);
  const runtime = scratch.directory(path.join(os.tmpdir(), 'naw-h-runtime-closure-'));
  for (const name of names) {
    const target = path.join(runtime, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(app, name), target);
  }
  fs.symlinkSync(fs.realpathSync(path.join(app, '../node_modules')), path.join(runtime, 'node_modules'), 'dir');
  copied = runtime;
  return runtime;
}

test.after(() => scratch.release());

test('the private runtime names copy can load Workspace and the mobile session module', () => {
  const runtime = runtimeCopy();
  assert.equal(typeof require(path.join(runtime, 'workspace.cjs')).Workspace, 'function');
  assert.equal(typeof require(path.join(runtime, 'mobile-session.cjs')).find, 'function');
});

// The service runs from this copy, while tests load app/ directly: a file read by path beside a
// module (pi's gate, the DSH preload) is missing only in daily use.
test('every file pi-tui loads or reads beside itself is in the private runtime copy', () => {
  const runtime = runtimeCopy();
  const seen = new Set();
  const absent = [];
  const local = [
    /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g,
    /path\.join\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  function visit(relative) {
    if (seen.has(relative)) return;
    seen.add(relative);
    if (!fs.existsSync(path.join(runtime, relative))) absent.push(relative);
    if (!/\.(?:cjs|js|mjs)$/.test(relative)) return;
    const file = path.join(app, relative);
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of local) {
      for (const match of source.matchAll(pattern)) {
        const target = path.relative(app, path.resolve(path.dirname(file), match[1]));
        if (!target.startsWith('..')) visit(target);
      }
    }
  }
  visit('pi-tui.cjs');
  assert.ok(seen.has('dsh-tui-preload.mjs'), 'the walk follows files read by path');
  const piTui = require(path.join(runtime, 'pi-tui.cjs'));
  const dataDir = path.join(runtime, 'data');
  fs.mkdirSync(dataDir);
  let gateError = null;
  try {
    piTui.prepareHome(piTui.paths(dataDir));
  } catch (error) {
    gateError = error.code || error.message;
  }
  console.log(JSON.stringify({ walked: [...seen], absent, gateError }));
  assert.deepEqual({ absent, gateError }, { absent: [], gateError: null });
  assert.equal(fs.readFileSync(piTui.paths(dataDir).gateFile, 'utf8'), fs.readFileSync(path.join(app, 'pi-confirm.mjs'), 'utf8'));
});
