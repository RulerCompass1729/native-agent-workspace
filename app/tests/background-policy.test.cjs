const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), operation = require('../background-operation.cjs'), wake = require('../session-wake.cjs');
const actor = { provider: 'codex', id: 'source', nativeId: 'source-native', name: 'Source', callId: 'call', turnId: 'turn', operationId: 'op' };
for (const off of ['global', 'recipient']) for (const [method, args] of [
  ['send', ['recipient', 'body', 'owner']], ['queue', ['recipient', 'body', 'owner']],
  ['steer', ['recipient', 'body', 'owner', 'turn']], ['input', ['recipient', 'body\r', 'owner']],
  ['startRun', [['source', 'recipient'], 'task', 2]],
]) test(`background ${method} refuses ${off} off before any native or ownership action`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-background-policy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { id: 'recipient', wakeDisabled: off === 'recipient' }, sessions = new Map([['recipient', target], ['source', { id: 'source' }]]);
  let touched = 0;
  const w = { dataDir: dir, sessions, get: id => sessions.get(id), runtime() { touched++; throw Error('Native path reached'); }, roomFor() { touched++; throw Error('Run path reached'); } };
  wake.initialize(w); if (off === 'global') fs.writeFileSync(path.join(dir, 'agent-wake-disabled'), '', { mode: 0o600 });
  await assert.rejects(operation.run(actor, async () => Workspace.prototype[method].call(w, ...args)), e => e.uiMessage?.key === 'error.backgroundMessagesDisabled');
  assert.equal(touched, 0);
});
test('all delivery entry points and explicit-space variants respect the same switch; reads and drafts remain available', () => {
  const state = { wakePolicy: { enabled: false }, sessions: [{ id: 'recipient' }, { id: 'second' }] };
  for (const method of ['send', 'forward', 'queue', 'queueShared', 'steer', 'steerShared', 'input', 'run']) {
    const args = method === 'run' ? [['recipient', 'second']] : ['recipient'];
    for (const [name, values] of [[method, args], ['spaceAction', ['space', method, args]]]) {
      assert.throws(() => operation.assertDeliveryPolicy(state, name, values), e => e.uiMessage?.key === 'error.backgroundMessagesDisabled');
      state.wakePolicy.enabled = true; state.sessions[0].wakeDisabled = true;
      assert.throws(() => operation.assertDeliveryPolicy(state, name, values), e => e.uiMessage?.key === 'error.backgroundMessagesDisabled');
      state.sessions[0].wakeDisabled = false; operation.assertDeliveryPolicy(state, name, values);
      state.wakePolicy.enabled = false;
    }
  }
  for (const method of ['initial', 'draft', 'rename', 'copy']) operation.assertDeliveryPolicy(state, method, ['recipient']);
});
test('a native guard captures background provenance and sees a later off switch outside AsyncLocalStorage', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-background-policy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = { id: 'recipient' }, w = { dataDir: dir, sessions: new Map([[s.id, s]]) }; wake.initialize(w);
  const valid = operation.run(actor, () => operation.inputGuard(w, [s.id]));
  assert.equal(operation.current(), null); assert.equal(valid(), true);
  s.wakeDisabled = true; assert.equal(valid(), false); s.wakeDisabled = false;
  fs.writeFileSync(path.join(dir, 'agent-wake-disabled'), '', { mode: 0o600 }); assert.equal(valid(), false);
  assert.equal(operation.inputGuard(w, [s.id])(), true, 'Human input keeps its existing behavior');
});
