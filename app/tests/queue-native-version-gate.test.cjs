const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { QUALIFIED } = require('../claude-pin.cjs');

test('the real queue runner uses the canonical Claude qualification list and keeps unqualified versions out', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/test-queue-native.cjs'), 'utf8');
  const version = source.indexOf('const nativeVersion =');
  const start = source.indexOf("if (PROVIDER === 'codex')", version), end = source.indexOf('const RESPONSE_LIMIT =', start);
  assert.ok(version >= 0 && start > version && end > start, 'Locate only the version gate, never the native runner');
  const gate = new vm.Script(source.slice(start, end));
  const check = (nativeVersion, PROVIDER = 'claude', qualified = QUALIFIED) => gate.runInNewContext({
    assert, nativeVersion, PROVIDER,
    require(id) { assert.equal(id, '../app/claude-pin.cjs'); return { QUALIFIED: qualified }; },
  });
  for (const version of [...QUALIFIED].reverse()) {
    for (const suffix of ['', ' (Claude Code)']) assert.doesNotThrow(() => check(version + suffix), version + suffix);
    for (const suffix of ['-beta', '+local', '.1']) assert.throws(() => check(version + suffix), version + suffix);
  }
  for (const version of ['2.1.302', '2.1.320', '2.1.999', '3.0.0', 'unknown', ''])
    if (!QUALIFIED.includes(version)) assert.throws(() => check(version), version);
  // A changed source list must take effect without editing the runner's gate.
  assert.doesNotThrow(() => check('9.9.9 (Claude Code)', 'claude', ['9.9.9']));
  assert.throws(() => check(QUALIFIED.at(-1), 'claude', ['9.9.9']));
  for (const version of ['codex-cli 0.164.1', 'codex-cli 0.168.0']) assert.doesNotThrow(() => check(version, 'codex'));
  for (const version of ['codex-cli 0.169.0', 'codex-cli 0.168.0-beta']) assert.throws(() => check(version, 'codex'));
});
