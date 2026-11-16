const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { creationCovered, StewardStanding } = require('../steward-standing.cjs');
const { StewardRole } = require('../steward-role.cjs');
const { BackgroundControl } = require('../background-control.cjs');
const { RoomState } = require('../room-state.cjs');
const peer = { id: 'peer', nativeId: 'native-peer', provider: 'claude', roomId: 'shared',
  skipPermissions: true, nativePermissionMode: 'bypassPermissions', model: 'synthetic-model-a', nativeEffort: 'low', cwd: '/synthetic/a' };
// Policy fixtures explicitly represent fresh native reports; the adapter and
// Workspace integration tests separately verify the observation pipeline.
function observed(p) {
  const observedAt = Date.now();
  return { ...p, nativeCreationSettings: { nativeId: p.nativeId, controlRevision: p.controlRevision ?? 0,
    model: p.model ? { value: p.model, observedAt } : null, effort: p.nativeEffort ? { value: p.nativeEffort, observedAt } : null } };
}
const options = (settings = {}) => ({ provider: 'claude', name: 'Synthetic session', cwd: '/synthetic/a', skipPermissions: true, settings });
for (const mode of ['bypassPermissions', 'plan']) for (const [label, settings, covered] of [
  ['provider defaults', {}, true], ['same observed settings', { model: peer.model, effort: 'low' }, true],
  ['different model', { model: 'synthetic-model-b' }, false], ['different effort', { effort: 'max' }, false],
  ['different model and effort', { model: 'synthetic-model-b', effort: 'max' }, false],
  ['same model, different effort', { model: peer.model, effort: 'max' }, false],
  ['different model, same effort', { model: 'synthetic-model-b', effort: 'low' }, false],
]) test(`standing creation: ${mode} ${label}`, () => {
  const baseline = observed({ ...peer, skipPermissions: mode === 'bypassPermissions', nativePermissionMode: mode });
  const request = { ...options({ ...settings, permissionMode: mode }), skipPermissions: mode === 'bypassPermissions' };
  assert.equal(creationCovered(request, [baseline]), covered);
});
test('both cost settings and permissions must match the same baseline member', () => {
  assert.equal(creationCovered(options({ model: peer.model, effort: 'max' }), [observed(peer), observed({ ...peer, model: 'synthetic-model-b', nativeEffort: 'max' })]), false);
  assert.equal(creationCovered(options({ model: 'synthetic-model-b' }), [observed(peer),
    observed({ ...peer, model: 'synthetic-model-b', skipPermissions: false, nativePermissionMode: 'plan' })]), false);
});
test('unknown native effort or earlier requested settings cannot prove an explicit selection', () => {
  assert.equal(creationCovered(options({ effort: 'max' }), [observed({ ...peer, nativeEffort: undefined, effort: 'max' })]), false);
  assert.equal(creationCovered(options({ model: 'synthetic-model-b', effort: 'max' }), [
    observed({ ...peer, requestedSettings: { model: 'synthetic-model-b', effort: 'max' } })]), false);
  assert.equal(creationCovered(options({ model: peer.model }), [observed({ ...peer, model: undefined })]), false);
});
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-standing-cost-'));
  const actor = { id: 'butler', nativeId: 'native-butler', provider: 'codex', name: 'Butler' }, human = {};
  const role = new StewardRole(dir); role.set({ sessionId: actor.id, nativeId: actor.nativeId });
  const policy = new StewardStanding(dir, { role, person: c => c === human }); policy.set(human, true);
  const state = { sessions: [{ ...actor, roomId: null }, observed(peer)], rooms: [] }, effects = [];
  const rooms = new RoomState(dir), context = { background: true, view: {}, fingerprint: () => ({ sessions: [actor], auditRooms: ['shared'] }),
    checkActor: async () => {}, client: { snapshot: () => ({ sessions: [actor] }), close() {} }, win: { destroy() {} } };
  const controller = new BackgroundControl({ dataDir: dir, context: () => context,
    handlers: new Map([['create', (_context, request) => { effects.push(request); return 'created'; }]]),
    confirmation: () => ({ message: 'Confirm configuration', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    standing: (a, c) => policy.take(a, c, state, 'shared'), standingValid: (a, c, _context, grant) => policy.valid(a, c, state, 'shared', grant),
    audit: row => rooms.recordControlOperation(row) });
  t.after(() => { controller.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ask = settings => controller.call({ sender: actor, identity: { callId: 'call', turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method: 'create', arguments: [options(settings)], operation_id: 'creation' });
  return { policy, state, controller, rooms, effects, ask };
}
test('different model/effort produces an actual confirmation card before any effect or usage reservation', async t => {
  const f = await fixture(t), result = await f.ask({ model: 'synthetic-model-b', effort: 'max' });
  assert.equal(result.state, 'confirmation-required'); assert.equal(result.approvedBy, undefined);
  assert.deepEqual(f.effects, []); assert.equal(f.policy.read().used.length, 0);
});
for (const settings of [{}, { model: peer.model, effort: 'low' }]) test(`standing create records requested model/effort ${JSON.stringify(settings)}`, async t => {
  const f = await fixture(t), result = await f.ask(settings), expected = { model: settings.model ?? null, effort: settings.effort ?? null };
  assert.equal(result.state, 'complete'); assert.equal(f.effects.length, 1);
  assert.deepEqual(result.standing.creation, expected);
  const use = f.policy.read().used[0]; assert.deepEqual(use.creation, expected);
  assert.deepEqual(f.rooms.value.events.at(-1).controlAudit.creation, expected);
});
test('a native model or effort change during the running audit revokes the pending standing create', async t => {
  const f = await fixture(t), audit = f.controller.audit;
  f.controller.audit = async (...args) => { await audit(...args); f.state.sessions[1] = observed({ ...f.state.sessions[1], nativeEffort: 'high' }); };
  const result = await f.ask({ model: peer.model, effort: 'low' });
  assert.equal(result.state, 'unconfirmed'); assert.deepEqual(f.effects, []);
});
