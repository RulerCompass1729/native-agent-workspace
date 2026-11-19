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
