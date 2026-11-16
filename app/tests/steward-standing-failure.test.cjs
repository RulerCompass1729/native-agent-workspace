const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl } = require('../background-control.cjs');
const { StewardStanding } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs');
const { RoomState } = require('../room-state.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-failure-'));
  const actor = { id: 'butler', nativeId: 'native-butler', provider: 'codex', name: 'Butler' }, human = {};
  const role = new StewardRole(dir); role.set({ sessionId: actor.id, nativeId: actor.nativeId });
  const policy = new StewardStanding(dir, { role, person: context => context === human }); policy.set(human, true);
  const state = { sessions: [{ ...actor, roomId: null }, { id: 'peer', provider: 'claude', roomId: 'shared',
    skipPermissions: true, nativePermissionMode: 'bypassPermissions' }], rooms: [] };
  const effects = [], handlers = new Map(), rooms = new RoomState(dir);
  for (const method of ['join', 'create', 'archiveSession']) handlers.set(method, () => { effects.push(method); return 'target'; });
  const context = { background: true, view: {}, fingerprint: () => ({ sessions: [actor], auditRooms: ['shared'] }),
    checkActor: async () => {}, client: { snapshot: () => state, close() {} }, win: { destroy() {} } };
  const config = { dataDir: dir, handlers, context: () => context,
    standing: (a, command) => policy.take(a, command, state, 'shared'),
    standingValid: (a, command, _context, grant) => policy.valid(a, command, state, 'shared', grant),
    confirmation: () => ({ message: 'Confirm', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    audit: row => rooms.recordControlOperation(row) };
  const f = { dir, policy, effects, handlers, controller: new BackgroundControl(config) };
  t.after(async () => { await f.controller.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  f.reopen = async () => { await f.controller.close(); f.controller = new BackgroundControl(config); };
  f.ask = (method, id) => f.controller.call({ sender: actor, identity: { callId: id, turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method, operation_id: id, arguments: method === 'join' ? ['target', true] : method === 'create' ?
      [{ provider: 'claude', name: 'New', cwd: '/synthetic', skipPermissions: true }] : ['target'] });
  return f;
}

// A real open() failure in this fixture's private store, without changing global fs
// or relying on chmod (which can behave differently under privileged test runners).
function unavailableWrite(policy, value) {
  const file = policy.file;
  policy.file = path.join(path.dirname(file), 'missing-parent', 'steward-standing.json');
  try { return StewardStanding.prototype.write.call(policy, value); }
  finally { policy.file = file; }
}

for (const method of ['join', 'create', 'archiveSession']) test(`PF07: ${method} reservation write failure is not executed and can retry with a new id`, async t => {
  const f = fixture(t), write = f.policy.write.bind(f.policy);
  f.policy.write = value => unavailableWrite(f.policy, value);
  const result = await f.ask(method, 'before-handler');
  assert.equal(result.state, 'not-executed');
  assert.equal(result.reason, 'standing-authorization-unavailable');
  assert.equal(result.retryWithNewOperationId, true); assert.match(result.retryHint, /new operation_id/);
  assert.deepEqual(f.effects, []); assert.equal(f.policy.read().used.length, 0);
  assert.equal(result.confirmation, undefined);
  const saved = JSON.parse(fs.readFileSync(f.controller.file, 'utf8')).records.find(r => r.id === 'before-handler');
  assert.equal(saved.state, 'not-executed'); assert.equal(saved.retryWithNewOperationId, true);
  f.policy.write = write; await f.reopen();
  const duplicate = await f.ask(method, 'before-handler');
  assert.equal(duplicate.state, 'not-executed'); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(f.effects, [], 'Re-reading the failed operation does not execute it');
  assert.equal((await f.ask(method, 'after-recovery')).state, 'complete');
  assert.deepEqual(f.effects, [method]); assert.equal(f.policy.read().used.length, 1);
});

test('PF07: failure after a durable reservation still means no handler effect and never refunds usage', async t => {
  const f = fixture(t), write = f.policy.write.bind(f.policy);
  f.policy.write = value => { write(value); unavailableWrite(f.policy, value); };
  const result = await f.ask('join', 'reservation-durable');
  assert.equal(result.state, 'not-executed'); assert.equal(result.retryWithNewOperationId, true);
  assert.deepEqual(f.effects, []); assert.equal(f.policy.read().used.length, 1);
  f.policy.write = write;
  assert.equal((await f.ask('join', 'after-recovery')).state, 'complete');
  assert.deepEqual(f.effects, ['join']); assert.equal(f.policy.read().used.length, 2);
});

test('PF07 boundary: the same storage failure after handler entry stays unconfirmed across restart', async t => {
  const f = fixture(t);
  f.handlers.set('join', () => { f.effects.push('join'); unavailableWrite(f.policy, f.policy.read()); });
  const result = await f.ask('join', 'after-handler');
  assert.equal(result.state, 'unconfirmed'); assert.notEqual(result.retryWithNewOperationId, true);
  assert.deepEqual(f.effects, ['join']); assert.equal(f.policy.read().used.length, 1);
  await f.reopen();
  const duplicate = await f.ask('join', 'after-handler');
  assert.equal(duplicate.state, 'unconfirmed'); assert.equal(duplicate.duplicate, true);
  assert.notEqual(duplicate.retryWithNewOperationId, true); assert.deepEqual(f.effects, ['join']);
});

test('PF07 boundary: final audit failure after a completed handler stays unconfirmed', async t => {
  const f = fixture(t), audit = f.controller.audit;
  f.controller.audit = row => { if (row.state === 'complete') throw Error('Synthetic final audit failure'); return audit(row); };
  const result = await f.ask('join', 'after-effect');
  assert.equal(result.state, 'unconfirmed'); assert.equal(result.resultState, 'complete');
  assert.notEqual(result.retryWithNewOperationId, true); assert.deepEqual(f.effects, ['join']);
  await f.reopen();
  assert.equal((await f.ask('join', 'after-effect')).state, 'unconfirmed'); assert.deepEqual(f.effects, ['join']);
});

for (const [label, failure] of [['string', 'Synthetic non-Error failure'], ['non-string message', { message: 42 }],
  ['null', null], ['undefined', undefined], ['false', false], ['zero', 0], ['NaN', NaN], ['empty string', '']])
  test(`PF07 follow-up: a pre-handler ${label} throw is recorded without a catch failure`, async t => {
    const f = fixture(t);
    f.controller.standing = () => { throw failure; };
    const result = await f.ask('join', 'non-error');
    assert.equal(result.state, 'not-executed'); assert.equal(result.retryWithNewOperationId, true);
    assert.equal(typeof result.error, 'string'); assert.ok(result.error.length);
    assert.deepEqual(f.effects, []); assert.equal(f.policy.read().used.length, 0);
    await f.reopen();
    const duplicate = await f.ask('join', 'non-error');
    assert.equal(duplicate.state, 'not-executed'); assert.equal(duplicate.duplicate, true);
    assert.deepEqual(f.effects, []);
    assert.equal((await f.ask('join', 'after-recovery')).state, 'complete');
    assert.deepEqual(f.effects, ['join']);
  });

test('PF07 follow-up: display preparation failure after take has a cause-neutral retry hint', async t => {
  const f = fixture(t), standing = f.controller.standing;
  f.controller.standing = (...args) => { standing(...args); throw Error('Synthetic display formatting failure'); };
  const result = await f.ask('join', 'display-failed');
  assert.equal(result.state, 'not-executed'); assert.deepEqual(f.effects, []);
  assert.equal(f.policy.read().used.length, 1, 'Storage succeeded before display preparation failed');
  assert.equal(result.retryHint, 'The operation did not execute. Retry with a new operation_id.');
  await f.reopen();
  const duplicate = await f.ask('join', 'display-failed');
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.retryHint, result.retryHint);
  assert.equal((await f.ask('join', 'after-recovery')).state, 'complete');
  assert.deepEqual(f.effects, ['join']); assert.equal(f.policy.read().used.length, 2);
});

test('PF07 follow-up boundary: a non-Error throw after handler entry remains unconfirmed', async t => {
  const f = fixture(t);
  f.handlers.set('join', () => { f.effects.push('join'); throw 'Synthetic non-Error failure'; });
  const result = await f.ask('join', 'after-handler');
  assert.equal(result.state, 'unconfirmed'); assert.notEqual(result.retryWithNewOperationId, true);
  await f.reopen();
  assert.equal((await f.ask('join', 'after-handler')).state, 'unconfirmed');
  assert.deepEqual(f.effects, ['join']);
});
