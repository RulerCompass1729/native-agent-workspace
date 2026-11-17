const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Codex } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { BackgroundControl } = require('../background-control.cjs');
const { StewardStanding, creationCovered } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs'), { RoomState } = require('../room-state.cjs');

const effective = extra => ({ model: 'synthetic-model', effort: 'high', modelProvider: 'openai',
  approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
  activePermissionProfile: null, approvalsReviewer: 'user', ...extra });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-codex-'));
  const host = { binaries: {}, codexTargets: new Map(), rpc: { connected: true, nativeVersion: '0.168.0' },
    codexProcess: { pid: null }, startCodex: async () => {}, createCodex: operation => operation(), close() {} };
  const w = new Workspace(host, dir), nativeId = randomUUID();
  const peer = { id: 'peer', nativeId, provider: 'codex', roomId: 'shared', cwd: dir,
    owner: 'view', view: 'chat', state: 'idle', messages: [], controlRevision: 0, memberRevision: 0 };
  const runtime = new Codex(peer, host); w.sessions.set(peer.id, peer); w.runtimes.set(peer.id, runtime); w.bind(peer, runtime);
  const actor = { id: 'butler', nativeId: 'native-butler', name: 'Butler', provider: 'codex' };
  const role = new StewardRole(dir), human = {}; role.set({ sessionId: actor.id, nativeId: actor.nativeId });
  let offset = 0, seq = 0;
  const policy = new StewardStanding(dir, { role, person: c => c === human, now: () => Date.now() + offset }); policy.set(human, true);
  const state = () => { const snapshot = w.snapshot(); return { ...snapshot, sessions: [{ ...actor, roomId: null }, ...snapshot.sessions] }; };
  const auditDir = path.join(dir, 'audit'); fs.mkdirSync(auditDir); const rooms = new RoomState(auditDir), effects = [];
  const context = { background: true, view: {}, fingerprint: () => ({ sessions: [actor], auditRooms: ['shared'] }),
    checkActor: async () => {}, client: { snapshot: state, close() {} }, win: { destroy() {} } };
  const controller = new BackgroundControl({ dataDir: dir, context: () => context,
    handlers: new Map([['create', (_c, options) => { effects.push(options); return 'synthetic-created-id'; }]]),
    confirmation: () => ({ message: 'Confirm creation', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    standing: (a, c) => policy.take(a, c, state(), 'shared'),
    standingValid: (a, c, _context, grant) => policy.valid(a, c, state(), 'shared', grant),
    audit: row => rooms.recordControlOperation(row) });
  const options = { provider: 'codex', cwd: dir, name: 'Synthetic creation', skipPermissions: true,
    settings: { model: 'synthetic-model', effort: 'high' } };
  const observe = (settings = effective(), rpc = host.rpc, id = peer.nativeId) => runtime.event({
    method: 'thread/settings/updated', params: { threadId: id, threadSettings: settings },
  }, rpc);
  const ask = (change = {}) => { const id = 'create-' + (++seq); return controller.call({ sender: actor,
    identity: { callId: id, turnId: 'turn' }, valid: () => true },
  { action: 'invoke', method: 'create', arguments: [{ ...options, ...change }], operation_id: id }); };
  t.after(async () => { await controller.close(); w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, w, peer, runtime, host, actor, human, role, policy, state, effects, rooms, controller, options, observe, ask,
    shift: ms => { offset += ms; } };
}
async function requiresCard(f, options = {}) {
  const result = await f.ask(options);
  assert.equal(result.state, 'confirmation-required', result.error);
  assert.equal(result.approvedBy, undefined); assert.deepEqual(f.effects, []); assert.equal(f.policy.read().used.length, 0);
}

test('Q06 Codex: fresh effective same permissions execute once without a card and record standing approval', async t => {
  const f = fixture(t); f.observe(); const result = await f.ask();
  assert.equal(result.state, 'complete', result.error); assert.equal(result.approvedBy, 'standing');
  assert.equal(f.effects.length, 1); assert.equal(f.policy.read().used.length, 1);
  assert.equal(f.rooms.value.events.at(-1).controlAudit.approvedBy, 'standing');
});
for (const [label, settings] of [
  ['missing approval', effective({ approvalPolicy: undefined })],
  ['missing sandbox', effective({ sandboxPolicy: undefined })],
  ['approval still requires confirmation', effective({ approvalPolicy: 'on-request' })],
  ['sandbox permits only workspace writes', effective({ sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } })],
  ['sandbox is read only', effective({ sandboxPolicy: { type: 'readOnly', networkAccess: false } })],
  ['unknown sandbox', effective({ sandboxPolicy: { type: 'futureSandbox' } })],
  ['sandbox has unrecognized constraints', effective({ sandboxPolicy: { type: 'dangerFullAccess', constraints: ['unknown'] } })],
  ['named permissions profile', effective({ activePermissionProfile: { id: 'synthetic-profile', extends: null } })],
  ['profile observation missing', effective({ activePermissionProfile: undefined })],
  ['third party provider', effective({ modelProvider: 'third-party' })],
]) test('Q06 Codex asks: ' + label, async t => { const f = fixture(t); f.observe(settings); await requiresCard(f); });
for (const change of ['missing', 'aged', 'rollback', 'control', 'identity', 'disconnected', 'closed', 'pending', 'rpc', 'off', 'not-butler']) {
  test('Q06 Codex asks when observation/authority is ' + change, async t => {
    const f = fixture(t); if (change !== 'missing') f.observe();
    if (change === 'aged') f.shift(60001);
    if (change === 'rollback') f.shift(-1000);
    if (change === 'control') f.peer.controlRevision++;
    if (change === 'identity') f.peer.nativeId = randomUUID();
    if (change === 'disconnected') f.runtime.transportDisconnected = true;
    if (change === 'closed') f.runtime.closed = true;
    if (change === 'pending') f.runtime.nativeObservationPending = true;
    if (change === 'rpc') f.host.rpc = { connected: true, nativeVersion: '0.168.0' };
    if (change === 'off') f.policy.set(f.human, false);
    if (change === 'not-butler') f.role.set({ sessionId: 'other', nativeId: 'native-other' });
    await requiresCard(f);
  });
}
test('Q06 Codex: a current native restriction replaces earlier full-access evidence', async t => {
  const f = fixture(t); f.observe(); f.peer.skipPermissions = true;
  f.observe(effective({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }));
  await requiresCard(f);
});
test('Q06 Codex: foreign native or transport settings cannot manufacture evidence', async t => {
  const f = fixture(t); f.observe(effective(), {}, randomUUID()); await requiresCard(f);
});
test('Q06 Codex: default directory configuration is not an explicit creation permission', async t => {
  const f = fixture(t); f.observe(); await requiresCard(f, { skipPermissions: false });
});
for (const settings of [{ model: 'different-model', effort: 'high' }, { model: 'synthetic-model', effort: 'low' },
  { model: 'synthetic-model', effort: 'high', profile: 'third-party-profile' }]) {
  test('Q06 Codex asks for different cost settings or a named provider profile: ' + JSON.stringify(settings), async t => {
    const f = fixture(t); f.observe(); await requiresCard(f, { settings });
  });
}
test('Q06 Codex: permission changes while publishing the running audit prevent the handler', async t => {
  const f = fixture(t); f.observe(); const original = f.controller.audit;
  f.controller.audit = row => { const value = original(row); if (row.state === 'running') f.observe(effective({ approvalPolicy: 'on-request' })); return value; };
  assert.equal((await f.ask()).state, 'unconfirmed'); assert.deepEqual(f.effects, []);
});
test('Q06 Codex: whitelisted observations omit private configuration and writable paths', t => {
  const f = fixture(t); f.observe({ ...effective(), config: { secret: 'PRIVATE_SYNTHETIC_CONFIG' }, developerInstructions: 'PRIVATE_SYNTHETIC_CONFIG' });
  const observation = f.state().sessions.find(s => s.id === f.peer.id).nativeCreationSettings;
  assert.ok(observation); assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_SYNTHETIC_CONFIG|developerInstructions|config|writableRoots/);
});
test('Q06 policy: unknown providers and third-party profiles remain uncovered; Claude behavior remains', () => {
  assert.equal(creationCovered({ provider: 'unknown', skipPermissions: true }, [{ provider: 'unknown', skipPermissions: true }]), false);
  assert.equal(creationCovered({ provider: 'codex', skipPermissions: true, settings: { profile: 'third-party-profile' } }, []), false);
  assert.equal(creationCovered({ provider: 'claude', skipPermissions: true }, [{ provider: 'claude', nativePermissionMode: 'bypassPermissions' }]), true);
  assert.equal(creationCovered({ provider: 'claude', skipPermissions: true }, [{ provider: 'claude', nativePermissionMode: 'plan', skipPermissions: true }]), false);
});

function recoveryReply(f) {
  return { thread: { id: f.peer.nativeId, cwd: f.dir, status: { type: 'idle' }, turns: [] },
    model: 'synthetic-model', modelProvider: 'openai', reasoningEffort: 'high', approvalPolicy: 'never',
    sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, approvalsReviewer: 'user',
    config: { private: 'PRIVATE_SYNTHETIC_CONFIG' } };
}
function recovering(f, delayed = false) {
  f.peer.recovering = true;
  let resolve, enter;
  const entered = new Promise(r => { enter = r; }), reply = recoveryReply(f);
  f.host.rpc.call = async method => {
    if (method === 'thread/resume') { enter(); return delayed ? new Promise(r => { resolve = r; }) : reply; }
    if (['thread/items/list', 'thread/turns/list'].includes(method)) return { data: [], nextCursor: null };
    throw Error('Unexpected synthetic RPC: ' + method);
  };
  return { entered, reply, release: () => resolve(reply) };
}
test('Q06 Codex: effective thread/resume response reaches standing policy without a settings event', async t => {
  const f = fixture(t); recovering(f); await f.runtime.start();
  assert.equal((await f.ask()).state, 'complete'); assert.equal(f.effects.length, 1);
  assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE_SYNTHETIC_CONFIG/);
});
for (const change of ['restricted-event', 'incomplete-event', 'control']) test('Q06 Codex: a late full-access response cannot overwrite ' + change, async t => {
  const f = fixture(t), rpc = recovering(f, true), pending = f.runtime.start(); await rpc.entered;
  if (change === 'control') f.peer.controlRevision++;
  else f.observe(effective({ ...(change === 'incomplete-event' ? { model: undefined } : {}), approvalPolicy: 'on-request' }));
  rpc.release(); await pending; await requiresCard(f);
});
test('Q06 Codex: a pending TUI settings request cannot use earlier permission evidence', async t => {
  const f = fixture(t); f.observe();
  f.runtime.observeTerminalContext({ kind: 'request', method: 'thread/resume', threadId: f.peer.nativeId, key: 'synthetic-request', rpc: f.host.rpc });
  await requiresCard(f);
});
test('Q06 Codex: evidence expiring during the audit prevents the handler', async t => {
  const f = fixture(t); f.observe(); const original = f.controller.audit;
  f.controller.audit = row => { const value = original(row); if (row.state === 'running') f.shift(60001); return value; };
  assert.equal((await f.ask()).state, 'unconfirmed'); assert.deepEqual(f.effects, []);
});
test('Q06 Codex: a slow native settings response does not become fresh merely on arrival', async t => {
  let now = 1800000000000; t.mock.method(Date, 'now', () => now);
  const f = fixture(t), rpc = recovering(f, true), pending = f.runtime.start(); await rpc.entered;
  now += 60001; rpc.release(); await pending; await requiresCard(f);
});
test('Q06 Codex: the existing hourly limit still falls back to a card', async t => {
  const f = fixture(t); f.observe();
  for (let n = 0; n < 30; n++) assert.ok(f.policy.take(f.actor, { method: 'join', arguments: ['peer', true], operation_id: 'reserve-' + n }, f.state(), 'shared'));
  const result = await f.ask(); assert.equal(result.state, 'confirmation-required'); assert.deepEqual(f.effects, []);
});
