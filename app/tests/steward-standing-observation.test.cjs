const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');
const { BackgroundControl } = require('../background-control.cjs');
const { StewardStanding } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs');
const { RoomState } = require('../room-state.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-observation-'));
  const host = { binaries: {}, close() {} }, workspace = new Workspace(host, dir);
  const peer = { id: 'peer', nativeId: randomUUID(), provider: 'claude', roomId: 'shared', cwd: dir,
    owner: 'peer-window', view: 'terminal', controlRevision: 0, memberRevision: 0, messages: [], state: 'idle', skipPermissions: true };
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  Object.assign(r, { record: peer, host, terminal: { alive: true }, submission: new SubmissionChannel() });
  workspace.sessions.set(peer.id, peer); workspace.runtimes.set(peer.id, r); workspace.bind(peer, r);
  r.bindRoot({ sessionId: peer.nativeId, nativeBlocks: true });
  r.hook({ hook_event_name: 'SessionStart', session_id: peer.nativeId, model: 'model-old', effort: { level: 'low' } });
  const actor = { id: 'butler', nativeId: 'native-butler', provider: 'codex', name: 'Butler' }, human = {};
  const role = new StewardRole(dir); role.set({ sessionId: actor.id, nativeId: actor.nativeId });
  let offset = 0, sequence = 0;
  const policy = new StewardStanding(dir, { role, person: c => c === human, now: () => Date.now() + offset }); policy.set(human, true);
  const state = () => { const snapshot = workspace.snapshot(); return { ...snapshot, sessions: [{ ...actor, roomId: null }, ...snapshot.sessions] }; };
  const auditDir = path.join(dir, 'audit'); fs.mkdirSync(auditDir); const rooms = new RoomState(auditDir);
  const effects = [], context = { background: true, view: {}, checkActor: async () => {},
    fingerprint: () => ({ sessions: [actor], auditRooms: ['shared'] }), client: { snapshot: state, close() {} }, win: { destroy() {} } };
  const control = new BackgroundControl({ dataDir: dir, context: () => context,
    handlers: new Map([['create', (_c, options) => { effects.push(options); return 'created'; }]]),
    confirmation: () => ({ message: 'Confirm configuration', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    standing: (a, command) => policy.take(a, command, state(), 'shared'),
    standingValid: (a, command, _c, grant) => policy.valid(a, command, state(), 'shared', grant), audit: row => rooms.recordControlOperation(row) });
  t.after(async () => { await control.close(); workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const f = { peer, r, workspace, policy, control, effects, state,
    ask: (settings, id = 'create') => control.call({ sender: actor, identity: { callId: id, turnId: 'turn' }, valid: () => true },
      { action: 'invoke', method: 'create', operation_id: id, arguments: [{ provider: 'claude', name: 'New', cwd: dir, skipPermissions: true, settings }] }),
    model: (value, extra = {}) => r.observeBlock({ block: true, sessionId: peer.nativeId, lease: r.rootLease, epoch: r.observationEpoch,
      sequence: ++sequence, id: 'control:model', kind: 'control', status: 'complete', model: value, ...extra }),
    effort: value => r.hook({ hook_event_name: 'Notification', session_id: peer.nativeId, effort: { level: value } }),
    shift: ms => { offset = ms; } };
  return f;
}

async function asksWithoutEffect(f, settings) {
  const result = await f.ask(settings);
  assert.equal(result.state, 'confirmation-required');
  assert.deepEqual(f.effects, []); assert.equal(f.policy.read().used.length, 0);
}

test('PF08: a late startup effort cannot authorize creation against the newer native effort', async t => {
  const f = fixture(t); f.model('model-current'); f.effort('high');
  assert.equal(f.peer.nativeEffort, 'high');
  // The startup hook and ordered observation travel independently; the model
  // already protects against this late startup, while the old effort scalar does not.
  f.r.hook({ hook_event_name: 'SessionStart', session_id: f.peer.nativeId, model: 'model-old', effort: { level: 'low' } });
  assert.equal(f.peer.model, 'model-current');
  await asksWithoutEffect(f, { model: 'model-current', effort: 'low' });
});

for (const settings of [{ model: 'model-old' }, { effort: 'low' }]) test(`PF08: startup-only settings cannot authorize ${JSON.stringify(settings)}`, async t => {
  const f = fixture(t); await asksWithoutEffect(f, settings);
});

for (const invalidate of ['aged', 'clock-rollback', 'control', 'gap', 'rebind', 'closed', 'identity']) test(`PF08: ${invalidate} observation requires a card`, async t => {
  const f = fixture(t); f.model('model-current'); f.effort('high');
  if (invalidate === 'aged') f.shift(61000);
  if (invalidate === 'clock-rollback') f.shift(-1000);
  if (invalidate === 'control') f.peer.controlRevision++;
  if (invalidate === 'gap') f.r.observeRootGap({ sessionId: f.peer.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch });
  if (invalidate === 'rebind') f.r.bindRoot({ sessionId: f.peer.nativeId, nativeBlocks: true });
  if (invalidate === 'closed') f.r.terminal.alive = false;
  if (invalidate === 'identity') f.peer.nativeId = randomUUID();
  await asksWithoutEffect(f, { model: 'model-current', effort: 'high' });
});

test('PF08: replayed model metadata cannot promote a startup scalar to fresh authority', async t => {
  const f = fixture(t); f.model('model-old', { replayed: true });
  await asksWithoutEffect(f, { model: 'model-old' });
});

for (const setting of ['model', 'effort']) test(`PF08 control: unspecified settings do not require extra ${setting === 'model' ? 'effort' : 'model'} evidence`, async t => {
  const f = fixture(t);
  if (setting === 'model') f.model('model-current'); else f.effort('high');
  assert.equal((await f.ask(setting === 'model' ? { model: 'model-current' } : { effort: 'high' })).state, 'complete');
  assert.equal(f.effects.length, 1);
});

test('PF08: evidence expiring during the running audit prevents the handler', async t => {
  const f = fixture(t); f.model('model-current'); f.effort('high');
  const audit = f.control.audit;
  f.control.audit = row => { const result = audit(row); if (row.state === 'running') f.shift(61000); return result; };
  assert.equal((await f.ask({ model: 'model-current', effort: 'high' })).state, 'unconfirmed');
  assert.deepEqual(f.effects, []);
});

test('PF08 control: fresh root model and effort observations permit the exact same configuration', async t => {
  const f = fixture(t); f.model('model-current'); f.effort('high');
  const result = await f.ask({ model: 'model-current', effort: 'high' });
  assert.equal(result.state, 'complete'); assert.equal(result.approvedBy, 'standing');
  assert.equal(f.effects.length, 1); assert.equal(f.policy.read().used.length, 1);
});

test('PF08: the latest native effort is used even after an older startup changes the display scalar', async t => {
  const f = fixture(t); f.model('model-current'); f.effort('high');
  f.r.hook({ hook_event_name: 'SessionStart', session_id: f.peer.nativeId, model: 'model-old', effort: { level: 'low' } });
  assert.equal((await f.ask({ model: 'model-current', effort: 'high' })).state, 'complete');
  assert.equal(f.effects.length, 1);
});

test('PF08: a new native observation during the running audit revokes the original grant', async t => {
  const f = fixture(t); f.model('model-current'); f.effort('low');
  const audit = f.control.audit;
  f.control.audit = row => { const result = audit(row); if (row.state === 'running') f.effort('high'); return result; };
  assert.equal((await f.ask({ model: 'model-current', effort: 'low' })).state, 'unconfirmed');
  assert.deepEqual(f.effects, []);
});
