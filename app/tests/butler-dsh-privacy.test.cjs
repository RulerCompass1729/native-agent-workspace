const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { patchSource, VERSION } = require('../butler-dsh-privacy.cjs');
test('pinned DSH transport patch removes both headers and the only anonymous-ID resolver call', () => {
  const file = require.resolve('@deepseek-ai/dsh-llm-deepseek'), original = fs.readFileSync(file, 'utf8');
  const patched = patchSource(original, VERSION);
  assert.ok(original.includes('"x-deepseek-harness-user-id": this.dependencies.resolveUserId()'));
  assert.ok(original.includes('"x-deepseek-harness-session-id"'));
  assert.ok(!patched.includes('this.dependencies.resolveUserId('));
  assert.ok(!patched.includes('"x-deepseek-harness-user-id"'));
  assert.ok(!patched.includes('"x-deepseek-harness-session-id"'));
  assert.equal(original.split('\n').length - patched.split('\n').length, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('source drift, repeated patching, and unqualified provider versions fail closed', () => {
  const original = fs.readFileSync(require.resolve('@deepseek-ai/dsh-llm-deepseek'), 'utf8');
  for (const [source, version] of [[original + '\n', VERSION], [original, '0.2.1-rc.3'], [patchSource(original, VERSION), VERSION]]) {
    assert.throws(() => patchSource(source, version), /unqualified upstream source/);
  }
});
test('the privacy gate requires an actual intercepted import', async () => {
  const hook = require('../butler-dsh-privacy.cjs').install();
  try {
    assert.throws(() => hook.assertApplied(), /not applied/);
    await import('@deepseek-ai/dsh-llm-deepseek');
    assert.doesNotThrow(() => hook.assertApplied());
  } finally { hook.deregister(); }
});
test('all explicit DSH composition packages are exact production dependencies and the host is packaged', () => {
  const root = path.join(__dirname, '../..'), manifest = require('../../package.json');
  for (const name of ['agent','agent-loop','llm-deepseek','llm-deepseek-api-key','mcp-client','session','session-projection','system-prompt','llm','tools']) {
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-' + name], VERSION);
  }
  const source = fs.readFileSync(path.join(root, 'scripts/package-mac.cjs'), 'utf8');
  for (const file of ['butler-dsh-host.mjs','butler-dsh-launch.py','butler-dsh-privacy.cjs','butler-dsh-driver.cjs']) assert.ok(source.includes("'" + file + "'"));
});
