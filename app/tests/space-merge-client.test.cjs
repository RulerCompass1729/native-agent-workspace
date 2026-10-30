const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { captureSource, prepareBatch, materializeBatch } = require('../space-merge.cjs');
const { withMembership } = require('../collaboration-spaces.cjs');
function fixture(t) {
  const a = randomUUID(), b = randomUUID(), calls = [], controls = {};
  const entries = ['one', 'two'].map((key, index) => {
    const client = new EventEmitter();
    const shared = { id: 'shared', messages: [], revision: 0 };
    const record = withMembership(withMembership({ id: key, nativeId: `native-${key}`, provider: 'codex', name: key, state: 'idle', owner: 'owner',
      controlRevision: 1, connectionRevision: 1, roomId: null, messages: [], liveDraft: 'UNSENT' }, a, true), b, true);
    const state = { owner: 'owner', runtimeVersion: 'development', capabilities: ['collaborationSpacesV1', 'spaceMergeV1'], sessions: [record],
      room: shared, rooms: [shared, { id: index ? b : a, revision: 0, messages: [{ id: key, role: 'assistant', sessionId: key, nativeId: record.nativeId,
        text: `Original ${key}`, status: 'complete', time: index ? 1 : 99 }] }], diagnostics: { shellModelCalls: 0, dispatches: 0 } };
    client.call = async (method, ...args) => {
      calls.push({ key, method });
      if (method === 'initial') return structuredClone(state);
      assert.equal(method, 'mergeSnapshot');
      if (controls.beforeImport) await controls.beforeImport();
      const batch = args[0], current = state.rooms.find(room => room.id === batch.targetId);
      if (!current) state.rooms.push({ id: batch.targetId, revision: 0, messages: materializeBatch(batch), snapshotBatches: [{ operationId: batch.operationId, binding: batch.binding }] });
      return { operationId: batch.operationId, binding: batch.binding, persisted: true };
    };
    client.close = () => client.emit('closed');
    return { key, client, state: structuredClone(state), actual: state };
  });
  const client = new WorkspaceClient(entries, 'one'); t.after(() => client.close());
  const source = id => captureSource({ ...client.snapshot(id).room, name: id === a ? 'A' : 'B', notes: '', events: [], files: [], metadataRevision: 0 }, client.snapshot().sessions);
  const batch = prepareBatch([source(a), source(b)], { operationId: randomUUID(), targetId: randomUUID(), name: 'C', memberIds: ['one', 'two'], disposition: 'keep' });
  return { a, b, entries, calls, controls, client, batch };
}
test('client routes a single immutable import to one owner and preserves source blocks before later C activity', async t => {
  const f = fixture(t); await f.client.call('mergeSnapshot', f.batch);
  assert.deepEqual(f.calls.filter(call => call.method === 'mergeSnapshot'), [{ key: 'one', method: 'mergeSnapshot' }]);
  const actual = f.entries[0].actual.rooms.find(room => room.id === f.batch.targetId);
  actual.messages.push({ id: 'later-C', role: 'human', text: 'Later', status: 'submitted', time: 0 });
  await f.client.refresh(); const room = f.client.snapshot(f.batch.targetId).room;
  assert.equal(room.snapshotBatches[0].binding, f.batch.binding);
  assert.deepEqual(room.messages.map(row => row.text), ['Original one', 'Original two', 'Later']);
  assert.ok(f.client.snapshot().sessions.every(session => session.liveDraft === 'UNSENT'));
  assert.equal(f.calls.some(call => ['send', 'queue', 'steer', 'input'].includes(call.method)), false);
});
test('a retry after selecting another active service still routes to the original saved batch owner', async t => {
  const f = fixture(t); await f.client.call('mergeSnapshot', f.batch); f.client.active = f.entries[1];
  await f.client.call('mergeSnapshot', f.batch);
  assert.deepEqual(f.calls.filter(call => call.method === 'mergeSnapshot').map(call => call.key), ['one', 'one']);
});
test('missing target capability or old selected member refuses import without sending to any backend', async t => {
  for (const kind of ['target', 'member']) {
    const f = fixture(t); const entry = f.entries[kind === 'target' ? 0 : 1];
    entry.state.capabilities = kind === 'target' ? ['collaborationSpacesV1'] : [];
    await assert.rejects(f.client.call('mergeSnapshot', f.batch), /尚不支持/);
    assert.equal(f.calls.some(call => call.method === 'mergeSnapshot'), false);
  }
});
test('maintenance and a changed source connection generation fail without automatic retry', async t => {
  const f = fixture(t); f.client.control.maintenance.add('two');
  await assert.rejects(f.client.call('mergeSnapshot', f.batch), /正在更新/);
  assert.equal(f.calls.some(call => call.method === 'mergeSnapshot'), false); f.client.control.maintenance.delete('two');
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  f.controls.beforeImport = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const pending = f.client.call('mergeSnapshot', f.batch); await started;
  f.client.control.generations.set('two', 1); release(); await assert.rejects(pending, /连接已变化/);
  assert.equal(f.calls.filter(call => call.method === 'mergeSnapshot').length, 1);
});
test('two backend ownership claims fail closed instead of deduplicating by equal batch hash', async t => {
  const f = fixture(t); await f.client.call('mergeSnapshot', f.batch);
  f.entries[1].state.rooms.push({ id: f.batch.targetId, revision: 0, messages: [], snapshotBatches: [{ operationId: f.batch.operationId, binding: f.batch.binding }] });
  assert.throws(() => f.client.snapshot(), /多个后台/);
  await assert.rejects(f.client.call('mergeSnapshot', f.batch), /归属冲突/);
});
