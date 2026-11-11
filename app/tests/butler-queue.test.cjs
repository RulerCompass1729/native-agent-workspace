'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerQueue } = require('../butler-queue.cjs');
const runner = { runnerRef: 'butler:runner', backendRef: 'butler:backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const denied = code => Object.assign(Error(code), { code });

// Synthetic atomic storage adapter only. The production RoomState is neither
// imported nor written. A restart round-trips this private in-memory store.
class FakeQueueAdapter {
  constructor(store = { value: { items: [], receipts: [] } }) { this.store = store; this.calls = 0; this.beforeCommit = null; this.loseReply = false; }
  async transact(request, guard) {
    this.calls++;
    if (this.beforeCommit) await this.beforeCommit();
    const state = this.store.value, existing = state.receipts.find(value => value.operationId === request.operationId);
    if (existing && (existing.fingerprint !== request.fingerprint || existing.spaceId !== request.spaceId)) throw denied('ERR_BUTLER_QUEUE_CONFLICT');
    if (!existing && state.items.filter(item => item.status === 'queued').length >= 300) throw denied('ERR_BUTLER_QUEUE_FULL');
    guard(); // Synchronous; no await or other user callback before commit/read.
    if (existing) return { ...existing, duplicate: true };
    const itemId = 'synthetic-item-' + (state.receipts.length + 1);
    const receipt = { operationId: request.operationId, fingerprint: request.fingerprint, spaceId: request.spaceId, itemId, duplicate: false };
    const item = { id: itemId, text: request.text, assignee: request.assignee, creator: { ...request.creator }, status: 'queued' };
    this.store.value = { items: [...state.items, item], receipts: [...state.receipts, receipt] };
    if (this.loseReply) { this.loseReply = false; throw Error('Synthetic lost transaction response'); }
    return { ...receipt };
  }
}
function fixture(t, action = { kind: 'queue', spaceId: 'shared', text: 'A synthetic task' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-queue-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('verified-person'), role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const identity = { sessionId: 'butler-original', nativeId: 'native-original' };
  role.set(person, { identity, runner }, 0);
  const record = { id: identity.sessionId, nativeId: identity.nativeId, name: 'Synthetic butler', provider: 'dsh', state: 'idle', roomIds: [], runner };
  const records = [record], spaces = [{ id: 'shared', archived: false, writable: true }];
  const ledger = new ButlerLedger(directory), selection = { selectionRevision: 1, identity, runnerRef: runner.runnerRef };
  ledger.ingest({ eventId: 'synthetic-event', sourceRef: 'person:request-one', kind: 'request', payload: { text: 'Original synthetic words' } });
  const batch = ledger.beginBatch(selection);
  ledger.completeBatch(batch.batchId, selection, { actions: [{ ...action, sourceRef: 'person:request-one' }] });
  const actionId = ledger.snapshot().actions[0].actionId, adapter = new FakeQueueAdapter();
  const expected = { selectionRevision: 1, runnerRef: runner.runnerRef }, view = () => ({ records, spaces });
  const bridge = overrides => new ButlerQueue({ role, ledger, view, adapter, ...overrides });
  return { directory, person, role, identity, record, records, spaces, ledger, actionId, adapter, expected, view, bridge };
}

test('record-only validates the canonical action but invokes no adapter and grants no queue-only role', async t => {
  const f = fixture(t), before = f.ledger.snapshot();
  const result = await f.bridge().add(f.record, f.expected, f.actionId);
  assert.equal(result.status, 'recorded'); assert.equal(result.effect, 'none');
  assert.equal(result.wouldQueue.sourceActionId, f.actionId); assert.equal(result.wouldQueue.assignee, null);
  assert.equal(f.adapter.calls, 0); assert.deepEqual(f.adapter.store.value, { items: [], receipts: [] });
  assert.deepEqual(f.ledger.snapshot(), before); assert.equal(f.role.current().mode, 'record-only');
});

test('explicit host grant queues one unassigned item with host provenance and no lifecycle effect', async t => {
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true });
  const first = await queue.add(f.record, f.expected, f.actionId), second = await queue.add(f.record, f.expected, f.actionId);
  assert.equal(first.status, 'queued'); assert.equal(first.duplicate, false); assert.equal(second.itemId, first.itemId); assert.equal(second.duplicate, true);
  assert.equal(f.adapter.store.value.items.length, 1);
  assert.deepEqual(f.adapter.store.value.items[0].creator, { kind: 'butler', name: f.record.name, sessionId: f.record.id });
  assert.equal(f.adapter.store.value.items[0].assignee, null); assert.equal(f.role.current().mode, 'record-only');
  assert.equal(f.ledger.snapshot().actions[0].effect, 'none', 'A proposal is never rewritten as a delivery receipt');
  assert.equal(queue.archive, undefined); assert.equal(queue.cancel, undefined); assert.equal(queue.resolve, undefined);
});

test('a lost response, reopened ledger and trimmed queue retain the same atomic operation receipt', async t => {
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true }); f.adapter.loseReply = true;
  const unknown = await queue.add(f.record, f.expected, f.actionId);
  assert.equal(unknown.status, 'unconfirmed'); assert.equal(unknown.effect, 'unknown'); assert.equal(f.adapter.store.value.items.length, 1);
  const originalId = f.adapter.store.value.items[0].id;
  // Simulate completed-row trimming and process restart without deleting the
  // separate receipt that was committed with the original queue item.
  const store = { value: JSON.parse(JSON.stringify({ ...f.adapter.store.value, items: [] })) }, adapter = new FakeQueueAdapter(store);
  const restored = f.bridge({ ledger: new ButlerLedger(f.directory), adapter, authorizeQueue: () => true });
  const retry = await restored.add(f.record, f.expected, f.actionId);
  assert.equal(retry.status, 'queued'); assert.equal(retry.duplicate, true); assert.equal(retry.itemId, originalId);
  assert.equal(store.value.items.length, 0); assert.equal(store.value.receipts.length, 1);
});

test('an operation whose stored fingerprint conflicts is rejected rather than producing another item', async t => {
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true }); await queue.add(f.record, f.expected, f.actionId);
  f.adapter.store.value.receipts[0].fingerprint = 'a-different-business-payload';
  await assert.rejects(queue.add(f.record, f.expected, f.actionId), { code: 'ERR_BUTLER_QUEUE_CONFLICT' });
  assert.equal(f.adapter.store.value.items.length, 1);
});

test('caller JSON, stale revisions, runner/native identity and membership never reach an adapter', async t => {
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true });
  await assert.rejects(queue.add({ ...f.record }, f.expected, f.actionId), { code: 'ERR_BUTLER_UNAUTHORIZED' });
  for (const expected of [{ ...f.expected, selectionRevision: 0 }, { ...f.expected, runnerRef: 'other' }, { ...f.expected, mode: 'queue-only' }])
    await assert.rejects(queue.add(f.record, expected, f.actionId), { code: 'ERR_BUTLER_UNAUTHORIZED' });
  const original = { ...f.record };
  for (const change of [{ nativeId: 'another-native' }, { runner: { ...runner, backendRef: 'wrong-backend' } }, { roomIds: ['shared'] }, { archived: true }]) {
    Object.assign(f.record, original, change);
    await assert.rejects(queue.add(f.record, f.expected, f.actionId), { code: 'ERR_BUTLER_UNAUTHORIZED' });
  }
  assert.equal(f.adapter.calls, 0); assert.equal(f.adapter.store.value.items.length, 0);
});

test('unverified, missing, duplicate and archived space routes are refused before adapter entry', async t => {
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true });
  for (const spaces of [[], [{ id: 'shared', archived: true, writable: true }], [{ id: 'shared', archived: false, writable: false }],
    [{ id: 'shared', writable: true }], [f.spaces[0], { ...f.spaces[0] }]]) {
    const saved = [...f.spaces]; f.spaces.splice(0, f.spaces.length, ...spaces);
    await assert.rejects(queue.add(f.record, f.expected, f.actionId), { code: 'ERR_BUTLER_QUEUE_SPACE' });
    f.spaces.splice(0, f.spaces.length, ...saved);
  }
  assert.equal(f.adapter.calls, 0);
});

test('only a completed canonical queue action from the current designation can execute', async t => {
  for (const kind of ['open', 'archive', 'report']) {
    const f = fixture(t, { kind, text: 'Another synthetic suggestion' });
    await assert.rejects(f.bridge({ authorizeQueue: () => true }).add(f.record, f.expected, f.actionId), { code: 'ERR_BUTLER_QUEUE_ACTION' });
    assert.equal(f.adapter.calls, 0);
  }
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true });
  await assert.rejects(queue.add(f.record, f.expected, { actionId: f.actionId, assignee: 'chosen-agent' }), { code: 'ERR_BUTLER_QUEUE_ACTION' });
  await assert.rejects(queue.add(f.record, f.expected, 'unknown-action'), { code: 'ERR_BUTLER_QUEUE_ACTION' });
  f.role.set(f.person, { identity: f.identity, runner }, 1);
  await assert.rejects(queue.add(f.record, { ...f.expected, selectionRevision: 2 }, f.actionId), { code: 'ERR_BUTLER_QUEUE_ACTION' });
  assert.equal(f.adapter.calls, 0);
});

test('async or nonboolean grants cannot activate even a fake transaction', async t => {
  const f = fixture(t);
  for (const authorizeQueue of [() => undefined, () => ({ mode: 'queue-only' }), () => 1, async () => true]) {
    await assert.rejects(f.bridge({ authorizeQueue }).add(f.record, f.expected, f.actionId), { code: 'ERR_BUTLER_QUEUE_GRANT' });
  }
  assert.equal(f.adapter.calls, 0);
});

for (const change of ['revoke', 'archive-space', 'grant', 'native']) test(`the synchronous transaction guard catches ${change} after an awaited adapter delay`, async t => {
  const f = fixture(t); let grant = true;
  const queue = f.bridge({ authorizeQueue: () => grant });
  f.adapter.beforeCommit = async () => {
    await Promise.resolve();
    if (change === 'revoke') f.role.revoke(f.person, 1);
    if (change === 'archive-space') f.spaces[0].archived = true;
    if (change === 'grant') grant = false;
    if (change === 'native') f.record.nativeId = 'changed-before-commit';
  };
  await assert.rejects(queue.add(f.record, f.expected, f.actionId));
  assert.equal(f.adapter.store.value.items.length, 0); assert.equal(f.adapter.store.value.receipts.length, 0);
});

test('a written done handoff can read the original receipt without changing its stable operation', async t => {
  const f = fixture(t), queue = f.bridge({ authorizeQueue: () => true });
  const first = await queue.add(f.record, f.expected, f.actionId);
  const next = { ...f.record, id: 'butler-successor', nativeId: 'native-successor' };
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), JSON.stringify({ event: 'done', old: { id: f.record.id, nativeId: f.record.nativeId }, new: { id: next.id, nativeId: next.nativeId } }) + '\n', { mode: 0o600 });
  f.records.splice(0, 1, next);
  const retry = await queue.add(next, f.expected, f.actionId);
  assert.equal(retry.itemId, first.itemId); assert.equal(retry.operationId, first.operationId); assert.equal(retry.duplicate, true);
  assert.equal(f.adapter.store.value.items.length, 1); assert.equal(f.adapter.store.value.items[0].creator.sessionId, f.record.id);
});

test('a response without a synchronous guard or with mismatched receipt never claims queue success', async t => {
  const f = fixture(t);
  for (const callsGuard of [false, true]) {
    const adapter = { transact: async (request, guard) => {
      if (callsGuard) guard();
      return { operationId: callsGuard ? 'wrong-operation' : request.operationId, fingerprint: request.fingerprint, spaceId: request.spaceId, itemId: 'item', duplicate: false };
    } };
    const result = await f.bridge({ adapter, authorizeQueue: () => true }).add(f.record, f.expected, f.actionId);
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.effect, 'unknown'); assert.equal(result.itemId, undefined);
  }
});
