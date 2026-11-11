'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerQueue } = require('../butler-queue.cjs');
const { interpretResult, rotationCandidates } = require('../butler-policy.cjs');
const runner = { purpose: 'butler', runnerRef: 'fixture-runner', backendRef: 'fixture-backend',
  profile: 'fixture-configuration', provider: 'fixture-vendor', model: 'fixture-model' };
const identity = { sessionId: 'designated-dsh', nativeId: 'actual-dsh-session' };
const source = { eventId: 'person-request', sourceRef: 'request:fixture', kind: 'request',
  payload: { text: 'Explicit synthetic person request', questionKey: 'fixture-decision', decisionKind: 'approval' } };
const spaces = [{ id: 'shared', name: 'Synthetic space', archived: false, writable: true, members: [], queue: [] }];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-instance-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('verified-person'), role = new ButlerRole(directory, { authorizePerson: value => value === person });
  const record = { id: identity.sessionId, nativeId: identity.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner: { ...runner } };
  const expected = { selectionRevision: 1, runnerRef: runner.runnerRef };
  return { directory, person, role, record, expected };
}
const denied = { code: 'ERR_BUTLER_UNAUTHORIZED' };

test('the person designates one actual DSH instance; a model vendor or harness label alone grants nothing', t => {
  const f = fixture(t);
  assert.equal(f.role.current(), null);
  f.role.set(f.person, { identity, runner }, 0);
  assert.equal(f.role.authorize(f.record, f.expected, [f.record]).mode, 'record-only');
  assert.deepEqual(f.role.current().runner, runner, 'Model configuration is a bound value, not a DeepSeek predicate');
  for (const patch of [{ id: 'other-dsh' }, { nativeId: 'other-session' }, { provider: 'codex' }, { provider: 'claude' },
    { runner: { ...runner, backendRef: 'other-backend' } }, { runner: { ...runner, runnerRef: 'other-runner' } },
    { runner: { ...runner, model: 'other-model' } }, { roomIds: ['shared'] }, { nativeContextPending: true }, { state: 'ended' }]) {
    const other = { ...f.record, ...patch };
    assert.throws(() => f.role.authorize(other, f.expected, [other]), denied);
  }
  assert.throws(() => f.role.authorize({ ...f.record }, f.expected, [f.record]), denied);
  assert.throws(() => f.role.authorize(f.record, { ...f.expected, selectionRevision: 0 }, [f.record]), denied);
});

test('rotation candidates change their harness identity, not their authority or instance matching', t => {
  const f = fixture(t); f.role.set(f.person, { identity, runner }, 0); const selected = f.role.current();
  assert.deepEqual(rotationCandidates(selected, [f.record]), [f.record.id]);
  for (const patch of [{ provider: 'codex' }, { provider: 'claude' }, { nativeId: 'other-native' }, { id: 'other-dsh' },
    { runner: { ...runner, runnerRef: 'other-runner' } }, { roomIds: ['shared'] }]) {
    assert.deepEqual(rotationCandidates(selected, [{ ...f.record, ...patch }]), []);
  }
  assert.deepEqual(rotationCandidates({ ...selected, mode: 'queue-only' }, [f.record]), []);
});

test('the accepted model action set remains exactly five record-only proposals, with no extra native controls', async t => {
  const f = fixture(t); f.role.set(f.person, { identity, runner }, 0);
  const allowed = ['queue', 'open', 'archive', 'question', 'report'];
  const deniedKinds = ['initial', 'nativeHistory', 'terminalSnapshot', 'approve', 'queueCancel', 'queueResolve',
    'changeBudget', 'setRole', 'shell', 'file', 'send', 'stop', 'publish'];
  const candidates = [...allowed, ...deniedKinds].map(kind => ({ kind, sourceRef: source.sourceRef, spaceId: 'shared', text: 'Synthetic proposal' }));
  const normalized = interpretResult({ actions: candidates }, { events: [source], catalog: spaces });
  assert.deepEqual(normalized.actions.map(action => action.kind), allowed);
  assert.equal(normalized.suspended.length, deniedKinds.length);
  const ledger = new ButlerLedger(f.directory); ledger.ingest(source);
  const selection = { selectionRevision: 1, identity, runnerRef: runner.runnerRef }, batch = ledger.beginBatch(selection);
  const completed = ledger.completeBatch(batch.batchId, selection, normalized);
  assert.deepEqual(completed.actions.map(action => action.effect), allowed.map(() => 'none'));
  let transactions = 0;
  const queue = new ButlerQueue({ role: f.role, ledger, view: () => ({ records: [f.record], spaces }),
    adapter: { transact() { transactions++; throw Error('Record-only must not invoke an adapter'); } } });
  const result = await queue.add(f.record, f.expected, completed.actions.find(action => action.kind === 'queue').actionId);
  assert.equal(result.status, 'recorded'); assert.equal(result.effect, 'none'); assert.equal(result.wouldQueue.assignee, null);
  assert.equal(transactions, 0); assert.deepEqual(spaces[0].queue, []); assert.equal(f.role.current().mode, 'record-only');
});

test('model-supplied grants, execution effects and identity fields cannot expand the unchanged proposal set', t => {
  const f = fixture(t); f.role.set(f.person, { identity, runner }, 0);
  for (const extra of [{ assignee: 'worker' }, { effect: 'queued' }, { authorizeQueue: true }, { actor: f.record },
    { mode: 'queue-only' }, { permission: 'all' }, { lifecycle: true }, { usage: { costMicros: 0 } }]) {
    const value = interpretResult({ actions: [{ kind: 'queue', sourceRef: source.sourceRef, text: 'Synthetic proposal', ...extra }] },
      { events: [source], catalog: spaces });
    assert.deepEqual(value.actions, []); assert.equal(value.suspended.length, 1);
  }
  for (const actor of [undefined, null, {}, { kind: 'person' }]) {
    assert.throws(() => f.role.set(actor, { identity, runner }, 1), { code: 'ERR_BUTLER_PERSON' });
    assert.throws(() => f.role.revoke(actor, 1), { code: 'ERR_BUTLER_PERSON' });
  }
  assert.throws(() => f.role.set(f.person, { identity, runner, mode: 'queue-only' }, 1), { code: 'ERR_BUTLER_INVALID' });
  assert.equal(f.role.current().mode, 'record-only');
});
