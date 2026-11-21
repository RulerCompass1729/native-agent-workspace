// One "Confirm all" may answer several new-session cards only when they start the same thing. The main process
// builds that identity from the command it will actually run, so these tests read operationSummary directly.
const test = require('node:test'), assert = require('node:assert/strict');
const operation = require('../background-operation.cjs');
const actor = { id: 'butler', name: '大管家', nativeId: 'butler-native' };
function summary(options = {}) {
  return operation.operationSummary({ method: 'create', arguments: [{ provider: 'codex', cwd: '/work/one', view: 'terminal', ...options }] }, actor);
}
test('the same creation settings share one key; the name is not part of it', () => {
  const base = summary({ name: 'First', settings: { model: 'deepseek-v4', effort: 'max' } });
  const named = summary({ name: 'Second', settings: { model: 'deepseek-v4', effort: 'max' } });
  assert.equal(base.createKey, named.createKey);
  assert.equal(base.model, 'deepseek-v4'); assert.equal(base.effort, 'max');
  assert.equal(base.folder, 'one');
});
test('any setting that changes what starts changes the key', () => {
  const base = summary({ settings: { model: 'deepseek-v4', effort: 'max' } }).createKey;
  const changed = [
    summary({ cwd: '/work/two', settings: { model: 'deepseek-v4', effort: 'max' } }),
    summary({ settings: { model: 'sonnet', effort: 'max' } }),
    summary({ settings: { model: 'deepseek-v4', effort: 'high' } }),
    summary({ settings: { model: 'deepseek-v4', effort: 'max', profile: 'pro' } }),
    summary({ settings: { model: 'deepseek-v4', effort: 'max', permissionMode: 'acceptEdits' } }),
    summary({ view: 'chat', settings: { model: 'deepseek-v4', effort: 'max' } }),
    summary({ skipPermissions: true, settings: { model: 'deepseek-v4', effort: 'max' } }),
    summary({ newDirectory: true, settings: { model: 'deepseek-v4', effort: 'max' } }),
    { provider: 'claude', cwd: '/work/one', view: 'chat' },
  ];
  for (const item of changed) {
    const key = typeof item === 'string' ? item : operation.operationSummary({ method: 'create', arguments: [item] }, actor).createKey;
    assert.notEqual(key, base);
  }
});
test('same-named folders in different places do not share a key', () => {
  const one = summary({ cwd: '/work/one' }), two = summary({ cwd: '/other/one' });
  assert.equal(one.folder, two.folder); assert.notEqual(one.createKey, two.createKey);
});
test('one folder and the view a backend actually runs share one key', () => {
  const base = summary({ settings: { model: 'deepseek-v4' } }).createKey;
  assert.equal(summary({ cwd: '/work/one/', settings: { model: 'deepseek-v4' } }).createKey, base);
  assert.equal(summary({ cwd: '/work/two/../one', settings: { model: 'deepseek-v4' } }).createKey, base);
  const dsh = summary({ provider: 'dsh', view: 'terminal' });
  assert.equal(summary({ provider: 'dsh', view: 'chat' }).createKey, dsh.createKey);
  const fork = { provider: 'claude', fork: 'picker', view: 'terminal', settings: { model: 'sonnet' } };
  assert.equal(summary({ ...fork, view: 'chat' }).createKey, summary(fork).createKey);
});
test('a fork and a fresh folder are different creations even with the same settings', () => {
  const plain = summary({ settings: { model: 'deepseek-v4', effort: 'max' } }).createKey;
  const fork = summary({ provider: 'claude', view: 'terminal', fork: 'picker', settings: { model: 'deepseek-v4', effort: 'max' } }).createKey;
  const direct = summary({ provider: 'claude', view: 'terminal', settings: { model: 'deepseek-v4', effort: 'max' } }).createKey;
  assert.notEqual(fork, direct); assert.notEqual(fork, plain);
});
test('a prepared worktree card gets no batch key because each card creates its own target', () => {
  const plan = { source: '/work/one', target: '/work/one-lane', repository: '/work/one', branch: 'lane', revision: 'a'.repeat(40), nonce: 'n', relativeDirectory: '', cwd: '/work/one-lane' };
  const item = summary({ gitWorktree: plan });
  assert.equal(item.createKey, undefined); assert.equal(item.worktree, true);
});
test('permission risks keep their existing warning marks and DSH names its own approvals', () => {
  assert.deepEqual(summary({ settings: { permissionMode: 'acceptEdits' } }).risks, ['acceptEdits']);
  assert.deepEqual(summary({ settings: { permissionMode: 'auto' } }).risks, ['autoApprove']);
  assert.deepEqual(summary({ settings: { permissionMode: 'dontAsk' } }).risks, []);
  assert.deepEqual(summary({ skipPermissions: true, settings: { permissionMode: 'bypassPermissions' } }).risks, ['skipPermissions']);
  const dsh = summary({ provider: 'dsh', view: 'terminal', name: 'DSH 1' });
  assert.equal(dsh.provider, 'dsh'); assert.ok(dsh.createKey);
  assert.notEqual(summary({ provider: 'dsh', view: 'terminal', cwd: '/work/two' }).createKey, dsh.createKey);
});
