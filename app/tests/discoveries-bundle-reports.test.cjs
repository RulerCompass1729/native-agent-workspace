'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { reportNames, reports } = require('../../scripts/test-discoveries-bundle.cjs');
const packaged = ['Native Agent Workspace Helper', 'Native Agent Workspace Helper (Renderer)', 'Native Agent Workspace Helper (GPU)', 'Native Agent Workspace Helper (Plugin)'];
const stems = reportNames('Native Agent Workspace', packaged);
for (const name of ['Electron Helper', 'Electron Helper (Renderer)', 'Electron Helper (GPU)', 'Electron Helper (Plugin)', 'Native Agent Workspace Helper', 'NAW Helper']) {
  test('H counterexample: a new ' + name + ' report is collected for refusal', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoveries-reports-')); t.after(() => fs.rmSync(root, { recursive: true }));
    const before = reports(stems, root), file = name + '-2099-01-01-000000.ips'; fs.writeFileSync(path.join(root, file), 'synthetic filename-only report');
    const added = reports(stems, root).filter(n => !before.includes(n));
    assert.deepEqual(added, [file]);
  });
}
test('all actual Helper roles, existing main families and node remain observable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoveries-reports-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const names = [...packaged, 'Electron', 'Native Agent Workspace', 'NAW', 'node'].map(n => n + '-2099.ips');
  for (const name of names) fs.writeFileSync(path.join(root, name), 'synthetic');
  assert.deepEqual(reports(stems, root), names.sort());
});
test('discovered Helper roles and executable names are included without accepting unrelated processes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoveries-reports-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const names = reportNames('Native Agent Workspace', [...packaged, 'Native Agent Workspace Helper (Utility)', 'Packaged Worker']);
  for (const file of ['NAW Helper (Utility)-2099.ips', 'Packaged Worker-2099.ips', 'NAW Helper Malware-2099.ips', 'Unrelated Helper-2099.ips', 'node-2099.txt']) fs.writeFileSync(path.join(root, file), 'synthetic');
  fs.mkdirSync(path.join(root, 'Electron-2099.ips'));
  fs.symlinkSync('Packaged Worker-2099.ips', path.join(root, 'Electron Helper-2099.ips'));
  assert.deepEqual(reports(names, root), ['NAW Helper (Utility)-2099.ips', 'Packaged Worker-2099.ips']);
});
test('old reports are baseline, and report bodies are never read', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoveries-reports-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'Electron Helper (Renderer)-2099.ips'); fs.writeFileSync(file, 'must not read'); fs.chmodSync(file, 0o000);
  const before = reports(stems, root); assert.deepEqual(reports(stems, root).filter(n => !before.includes(n)), []);
  fs.chmodSync(file, 0o600);
  assert.throws(() => reportNames('Native Agent Workspace', ['../escape']), /Invalid/);
});

function bundleFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoveries-inventory-')), bundle = path.join(root, 'Fixture.app');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value, mode = 0o600) => { const file = path.join(bundle, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode }); return file; };
  write('Contents/Info.plist', JSON.stringify({ CFBundleIdentifier: 'io.github.rulercompass1729.native-agent-workspace.fixture', NAWSourceRevision: 'a'.repeat(40), CFBundleExecutable: 'Fixture' }));
  write('Contents/MacOS/Fixture', 'synthetic executable', 0o700);
  for (const name of ['regular-popup.cjs', 'regular-popup-transport.cjs', 'regular-popup-worker.mjs', 'regular-popup-dsh.cjs']) write('Contents/Resources/app/app/' + name, 'synthetic');
  write('Contents/Frameworks/Fixture Helper.app/Contents/Info.plist', JSON.stringify({ CFBundleExecutable: 'Fixture Helper', CFBundleName: 'Fixture Helper' }));
  write('Contents/Frameworks/Fixture Helper.app/Contents/MacOS/Fixture Helper', 'synthetic executable', 0o700);
  const file = require.resolve('../../scripts/test-discoveries-bundle.cjs'), cached = require.cache[file];
  t.mock.method(require('node:child_process'), 'execFileSync', (command, args) => { assert.equal(command, '/usr/bin/plutil'); return fs.readFileSync(args.at(-1)); });
  delete require.cache[file]; const gate = require(file); t.after(() => { require.cache[file] = cached; });
  return { root, bundle, write, target: () => gate.target(bundle) };
}
for (const name of ['app_shim_loader', 'chrome_crashpad_handler']) test('H-F2: nested non-app executable '+name+' is discovered and its new report is collected', t => {
  const f = bundleFixture(t); f.write('Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/' + name, 'synthetic executable', 0o700);
  const names = f.target().reportNames; assert.ok(names.includes(name));
  const before = reports(names, f.root), report = name + '-2099-01-01-000000.ips'; fs.writeFileSync(path.join(f.root, report), 'synthetic');
  assert.deepEqual(reports(names, f.root).filter(n => !before.includes(n)), [report]);
});
test('executable inventory follows internal framework aliases without cycles and ignores non-executable data', t => {
  const f = bundleFixture(t), directory = 'Contents/Frameworks/Example.framework/Versions';
  f.write(directory + '/A/Helpers/Future-Worker', 'synthetic executable', 0o700); f.write(directory + '/A/Helpers/data', 'synthetic');
  fs.symlinkSync('A', path.join(f.bundle, directory, 'Current')); fs.symlinkSync('.', path.join(f.bundle, directory, 'A/loop'));
  const names = f.target().reportNames; assert.equal(names.filter(n => n === 'Future-Worker').length, 1); assert.ok(!names.includes('data'));
});
test('executable inventory refuses a symlink escaping the explicit bundle', t => {
  const f = bundleFixture(t), outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'never inspect', { mode: 0o700 });
  fs.symlinkSync(outside, path.join(f.bundle, 'Contents/Frameworks/escape')); assert.throws(f.target, /escaped/);
});
test('H-F3: complete stems exclude hyphenated unrelated processes while retaining timestamp and unique suffixes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discoveries-boundary-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const valid = ['Electron Helper-2099-01-01-000000.ips', 'node-2099-01-01-000000.1.ips', 'NAW-2099-01-01-000000_2.ips', 'Electron-12345678-abcd-abcd-abcd-123456789abc.ips'];
  const unrelated = ['Electron Helper-Unrelated-2099-01-01-000000.ips', 'node-other-2099.ips', 'NAW-Helper-Unrelated-2099-01-01-000000.ips', 'Electron Helper-2099-Unrelated.ips'];
  for (const file of [...valid, ...unrelated]) fs.writeFileSync(path.join(root, file), 'synthetic filename-only report');
  assert.deepEqual(reports(stems, root), valid.sort());
});
