const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl } = require('../background-control.cjs');
const { RoomState } = require('../room-state.cjs');
function fixture(t, standing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actor = { id: 'butler', nativeId: 'native-butler', provider: 'codex', name: 'Butler' };
  const rooms = new RoomState(dir), effects = [], handlers = new Map();
  for (const method of ['join', 'create', 'archiveSession']) handlers.set(method, () => { effects.push(method); return 'target'; });
  const context = { background: true, view: {}, fingerprint: () => ({ sessions: [actor], auditRooms: ['shared'] }), checkActor: async () => {}, client: { snapshot: () => ({ sessions: [actor] }), close() {} }, win: { destroy() {} } };
  const config = { dataDir: dir, handlers, context: () => context, standing, standingValid: () => true,
    confirmation: () => ({ message: 'Confirm', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    audit: row => rooms.recordControlOperation(row) };
  const controller = new BackgroundControl(config); t.after(() => controller.close());
  const ask = (method, id = method) => controller.call({ sender: actor, identity: { callId: id, turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method, arguments: method === 'join' ? ['target', true] : method === 'create' ? [{ provider: 'codex', name: 'New', cwd: '/synthetic' }] : ['target'], operation_id: id });
  return { controller, effects, rooms, ask, config, actor, context };
}
for (const method of ['join', 'create', 'archiveSession']) test(`standing: ${method} executes without a card and records its authorization`, async t => {
  const f = fixture(t, () => ({ revision: 1, action: method, target: 'Target', undo: 'Restore the previous placement' }));
  const result = await f.ask(method);
  assert.equal(result.state, 'complete'); assert.equal(result.approvedBy, 'standing');
  assert.deepEqual(f.effects, [method]);
  const event = f.rooms.value.events.at(-1);
  assert.equal(event.controlAudit.approvedBy, 'standing'); assert.ok(event.uiMessage.params.undo);
  assert.equal((await f.ask(method)).duplicate, true); assert.equal(f.effects.length, 1);
});
test('standing: a refused policy still asks, and a failed audit never executes', async t => {
  const f = fixture(t, () => null);
  assert.equal((await f.ask('join')).state, 'confirmation-required'); assert.deepEqual(f.effects, []);
  f.controller.standing = () => ({ revision: 1, action: 'join', target: 'Target', undo: 'Leave' });
  f.controller.audit = () => { throw Error('Synthetic storage failure'); };
  const result = await f.ask('join', 'audit-fails');
  assert.equal(result.state, 'unconfirmed'); assert.deepEqual(f.effects, []);
});
test('standing: revocation while the durable running audit awaits prevents the mutation', async t => {
  const f = fixture(t, () => ({ revision: 1, action: 'join', target: 'Target', undo: 'Leave' }));
  f.controller.standingValid = () => false;
  assert.equal((await f.ask('join')).state, 'unconfirmed'); assert.deepEqual(f.effects, []);
});

const { StewardStanding } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs');
test('standing policy: person-only switch, role/native identity, exact allowlist, persistent hourly budget and off', async t => {
  const f = fixture(t), role = new StewardRole(f.config.dataDir), human = {};
  role.set({ sessionId: f.actor.id, nativeId: f.actor.nativeId });
  let now = 10000000;
  const policy = () => new StewardStanding(f.config.dataDir, { role, person: c => c === human, now: () => now });
  let p = policy(); const state = { sessions: [{ ...f.actor, roomId: null }, { id: 'peer', provider: 'codex', roomId: 'shared', skipPermissions: true }], rooms: [] };
  const cmd = (method, args = []) => ({ method, arguments: args, operation_id: method + now });
  assert.equal(p.take(f.actor, cmd('join'), state, 'shared'), null);
  assert.throws(() => p.set({}, true), /person window/); p.set(human, true);
  assert.equal(p.view().on, true);
  assert.equal(p.take({ ...f.actor, nativeId: 'other' }, cmd('join'), state, 'shared'), null);
  assert.equal(p.take({ ...f.actor, id: 'other' }, cmd('join'), state, 'shared'), null);
  for (const method of ['forget', 'initial', 'openLocalFile', 'saveLocalFile', 'runtimeLocation', 'pause', 'interrupt', 'input', 'answer', 'terminal', 'spaceMerge'])
    assert.equal(p.take(f.actor, cmd(method), state, 'shared'), null, method);
  assert.equal(p.take(f.actor, cmd('spaceAction', ['shared', 'clearSharedHistory', []]), state, 'shared'), null);
  assert.equal(p.take(f.actor, cmd('create', [{ provider: 'codex', skipPermissions: true }]), state, 'other-room'), null);
  const grant = p.take(f.actor, cmd('create', [{ provider: 'codex', skipPermissions: true }]), state, 'shared'); assert.ok(grant);
  state.sessions[1].skipPermissions = false;
  assert.equal(p.valid(f.actor, cmd('create', [{ provider: 'codex', skipPermissions: true }]), state, 'shared', grant), false);
  assert.equal(p.take(f.actor, cmd('create', [{ provider: 'codex', skipPermissions: true }]), state, 'shared'), null, 'Wider permission asks');
  assert.equal(p.take(f.actor, cmd('create', [{ provider: 'codex', settings: { profile: 'unverified' } }]), state, 'shared'), null);
  p.set(human, false); assert.equal(p.take(f.actor, cmd('join'), state, 'shared'), null);
  p.set(human, true);
  for (let n = 1; n < 30; n++) { now++; assert.ok(p.take(f.actor, cmd('join'), state, 'shared')); }
  p = policy(); assert.equal(p.take(f.actor, cmd('join'), state, 'shared'), null, 'Restart and toggling do not reset usage');
  now -= 60000; assert.equal(p.take(f.actor, cmd('join'), state, 'shared'), null, 'Clock rollback cannot reset usage');
  now += 3660001; assert.ok(p.take(f.actor, cmd('join'), state, 'shared'));
  role.set({ sessionId: 'replacement', nativeId: 'native-replacement' }); assert.equal(p.view().on, false);
  fs.writeFileSync(p.file, 'broken', { mode: 0o600 }); assert.equal(p.view().unavailable, true);
  assert.equal(p.take(f.actor, cmd('join'), state, 'shared'), null);
});
