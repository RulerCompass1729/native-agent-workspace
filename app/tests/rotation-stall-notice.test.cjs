// A session due for rotation that stays put says where it is held (the person, 2026-11-23: 「为啥以前的继任会话不需要点?
// 都已经正常工作很久了,为啥突然又不工作了?而且以后咋办」). The butler went four days and the members a day with no word.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs');
const NOW = 1800000000000, MINUTE = 60000, HOUR = 60 * MINUTE, ROTATION = /^【NAW 换会话】/;
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };

function session(id, nativeId, extra = {}) {
  return { id, nativeId, provider: 'claude', model: 'claude-test-model', state: 'idle', roomIds: [], roomId: null,
    serviceCapabilities: [rules.CAPABILITY], chatAvailable: true, background: 0, scheduled: 0, messages: [], fleet: [], liveDraft: '', cwd: '/tmp',
    createdAt: NOW - 3600000, lastActivityAt: NOW - HOUR, ...extra };
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-rotation-stall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// One backend whose sessions the test changes in place; a rotation request leaves its session working.
// Compactions are counted only for the sessions the dispatcher asks about.
function dispatcher(t, f) {
  const capabilities = [rules.CAPABILITY, rules.ROTATION_CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY];
  const client = Object.assign(new EventEmitter(), {
    close() {}, refresh: async () => {},
    snapshot: () => ({ sessions: f.sessions, rooms: f.rooms, capabilities, wakePolicy: f.wakePolicy || { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client, state: { capabilities } }),
    call: async (method, ...args) => {
      if (method === 'dispatch') {
        f.sends.push({ at: f.clock.now, to: args[0], text: args[1] });
        f.sessions.find(s => s.id === args[0]).state = 'working';
        return 'receipt-' + f.sends.length;
      }
      if (method === 'initial') return client.snapshot();
      throw Error(method);
    },
  });
  // A window is open: with no queued work, the minute's rotation check reads through it.
  const d = new rules.QueueDispatcher({ roomState: f.roomState, dataDir: f.dir, connect: async () => client, clients: () => client, steward: () => f.steward,
    now: () => f.clock.now, settleMs: 8000, tickMs: 3600000, transcriptRoot: path.join(f.dir, 'none'), sampleProcesses: async () => '', samplePressure: async () => '',
    compactions: { async sample(subjects) { return new Map(subjects.filter(s => Object.hasOwn(f.compactions, s.id)).map(s => [s.id, f.compactions[s.id]])); } },
    rotationStalled: stall => f.ingress.rotationStalled(stall) });
  t.after(() => d.close());
  return d;
}
function setup(t, { sessions, compactions, rooms = [], steward = BUTLER }) {
  const dir = temp(t), clock = { now: NOW };
  const roomState = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const f = { dir, clock, roomState, ledger, sessions, compactions, rooms, steward, sends: [] };
  f.ingress = new ButlerIngress(dir, { roomState, ledger, now: () => clock.now });
  f.d = dispatcher(t, f);
  return f;
}
// The app started again over the same records: a new dispatcher and intake.
function restart(t, f) {
  f.ingress = new ButlerIngress(f.dir, { roomState: f.roomState, ledger: new ButlerLedger(f.dir, { now: () => f.clock.now }), now: () => f.clock.now });
  f.d = dispatcher(t, f);
}
async function run(f, ms, step = 10 * MINUTE) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await f.d.schedule();
    f.clock.now += step;
  }
}
function stalls(f) {
  return f.ingress.ledger.snapshot().events.filter(e => e.eventId.startsWith('rotation-stalled:')).map(e => ({ kind: e.kind, ...e.payload }));
}

test('the butler held four days by the rotation an interruption left unresolved: one line, after the first hour', async t => {
  const episode = { nativeId: BUTLER.nativeId, epoch: 7, state: 'invalid', tag: 'rotation-tag' };
  const f = setup(t, { sessions: [session(BUTLER.sessionId, BUTLER.nativeId, { rotationEpisode: episode })], compactions: { butler: 52 } });
  await run(f, 50 * MINUTE);
  assert.deepEqual(stalls(f), [], 'nothing within the first hour');
  await run(f, 4 * 24 * HOUR, 30 * MINUTE);
  assert.deepEqual(stalls(f), [{ kind: 'blocked', memberId: 'butler', reason: 'rotation-stalled', outcome: 'compact:rotation-control-unresolved',
    title: new Date(NOW).toISOString() }]);
  assert.deepEqual(f.sends, [], 'only told: nothing was sent to it');
});

test('a member held by the planner\'s own waiting kind: told with the gate that holds it', async t => {
  const episode = { nativeId: 'native-m1', epoch: 3, state: 'invalid', tag: 'rotation-tag' };
  // The default space, which RoomState always holds.
  const member = session('m1', 'native-m1', { roomIds: ['shared'], roomId: 'shared', rotationEpisode: episode });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  await run(f, 90 * MINUTE);
  assert.deepEqual(stalls(f).map(s => [s.memberId, s.outcome]), [['m1', 'compact:rotation-control-unresolved']]);
});

test('the butler never idle: told it is held at not-idle, once', async t => {
  const f = setup(t, { sessions: [session(BUTLER.sessionId, BUTLER.nativeId, { state: 'working' })], compactions: { butler: 5 } });
  await run(f, 5 * HOUR);
  assert.deepEqual(stalls(f).map(s => s.outcome), ['compact:not-idle']);
});

test('a normal rotation says nothing', async t => {
  const f = setup(t, { sessions: [session(BUTLER.sessionId, BUTLER.nativeId)], compactions: { butler: 3 } });
  await run(f, 3 * HOUR, MINUTE);
  assert.ok(f.sends.some(s => ROTATION.test(s.text)), 'the rotation request went out');
  assert.deepEqual(stalls(f), []);
});

test('the same stall seen on every pass and after a restart: one line; a new gate: one more', async t => {
  const f = setup(t, { sessions: [session(BUTLER.sessionId, BUTLER.nativeId, { liveDraft: 'x' })], compactions: { butler: 52 } });
  await run(f, 3 * HOUR);
  restart(t, f);
  await run(f, 3 * HOUR);
  assert.deepEqual(stalls(f).map(s => s.outcome), ['compact:person-typing']);
  // The draft is sent and the butler works for over an hour; then a draft again.
  f.sessions[0].liveDraft = '';
  f.sessions[0].state = 'working';
  await run(f, 2 * HOUR);
  f.sessions[0].state = 'idle';
  f.sessions[0].liveDraft = 'y';
  await run(f, 2 * HOUR);
  assert.deepEqual(stalls(f).map(s => s.outcome), ['compact:person-typing', 'compact:not-idle']);
  assert.deepEqual(f.sends, []);
});

test('a designation that no longer matches the butler\'s native session: told, and still not rotated', async t => {
  const f = setup(t, { sessions: [session(BUTLER.sessionId, 'native-butler-after-clear')], compactions: { butler: 52 } });
  await run(f, 2 * HOUR);
  assert.deepEqual(stalls(f).map(s => [s.memberId, s.outcome]), [['butler', 'compact:designation-mismatch']]);
  assert.deepEqual(f.sends, []);
});

function failedRotation(f, member, extra = {}) {
  f.d.rotations[member.id] = { phase: 'failed', reason: 'rotation-failed', oldId: member.id, oldNativeId: member.nativeId,
    episodeEpoch: 'episode-1', tag: 'rotation-tag', roomIds: ['shared'], roomId: 'shared', failedAt: NOW, ...extra };
}

for (const provider of ['claude', 'codex']) test(`ended ${provider} member is not a stalled rotation`, async t => {
  const member = session('m1', 'native-m1', { provider, state: 'ended', roomIds: ['shared'], roomId: 'shared' });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  await run(f, 3 * HOUR);
  assert.deepEqual(stalls(f), []);
  assert.deepEqual(f.sends, []);
});

for (const pause of ['member', 'automatic messages']) test(`intentionally paused ${pause} does not report a rotation stall`, async t => {
  const member = session('m1', 'native-m1', { roomIds: ['shared'], roomId: 'shared', ...(pause === 'member' ? { wakeDisabled: true } : {}) });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  if (pause === 'automatic messages') f.wakePolicy = { enabled: false };
  await run(f, 3 * HOUR);
  assert.deepEqual(stalls(f), []);
  assert.deepEqual(f.sends, []);
});

for (const state of ['complete', 'released']) test(`a failed record for the same ${state} episode is not still stalled`, async t => {
  const member = session('m1', 'native-m1', { roomIds: ['shared'], roomId: 'shared', rotationEpisode: {
    nativeId: 'native-m1', epoch: 'episode-1', tag: 'rotation-tag', state } });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  failedRotation(f, member);
  await run(f, 3 * HOUR);
  assert.deepEqual(stalls(f), []);
});

for (const key of ['nativeId', 'epoch', 'tag']) test(`completion of a different ${key} does not hide a real failed rotation`, async t => {
  const episode = { nativeId: 'native-m1', epoch: 'episode-1', tag: 'rotation-tag', state: 'complete' };
  episode[key] = 'different';
  const member = session('m1', 'native-m1', { roomIds: ['shared'], roomId: 'shared', rotationEpisode: episode });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  failedRotation(f, member);
  await run(f, 3 * HOUR);
  assert.deepEqual(stalls(f).map(s => s.outcome), ['compact:rotation-failed']);
  assert.deepEqual(f.sends, []);
});

for (const reason of ['handoff-missing', 'cannot-carry:collaboration-mode']) test(`an idle active member held by ${reason} still reports its real failed rotation`, async t => {
  const member = session('m1', 'native-m1', { roomIds: ['shared'], roomId: 'shared' });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  failedRotation(f, member, { reason });
  await run(f, 3 * HOUR);
  assert.deepEqual(stalls(f).map(s => s.outcome), ['compact:rotation-failed']);
  assert.deepEqual(f.sends, []);
});

test('pausing clears elapsed stall time; resuming waits a fresh hour', async t => {
  const member = session('m1', 'native-m1', { roomIds: ['shared'], roomId: 'shared', liveDraft: 'synthetic draft' });
  const f = setup(t, { sessions: [member], compactions: { m1: 5 }, steward: null });
  await run(f, 50 * MINUTE);
  member.wakeDisabled = true;
  await run(f, 2 * HOUR);
  assert.deepEqual(stalls(f), []);
  member.wakeDisabled = false;
  await run(f, 50 * MINUTE);
  assert.deepEqual(stalls(f), []);
  await run(f, 20 * MINUTE);
  assert.deepEqual(stalls(f).map(s => s.outcome), ['compact:person-typing']);
});
