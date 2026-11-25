// A sent item whose member stopped in 'error' with nothing continuing it: the butler is told once, nothing else happens
// (2026-11-25: a member stayed so for forty minutes; its item is settled only at 'idle', and no event named it).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs');
const NOW = 1800000000000, SECOND = 1000, MINUTE = 60 * SECOND, STEP = 10 * SECOND;
const TURN = '11111111-1111-4111-8111-111111111111';
const retry = (status, extra = {}) => ({ status, reason: 'connection', attempt: status === 'exhausted' ? 3 : 0,
  due: status === 'exhausted' ? 0 : NOW + 2 * MINUTE, nativeId: 'native-m1', turnId: TURN, ...extra });

function dispatcher(t, f) {
  const capabilities = [rules.CAPABILITY, rules.ROTATION_CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY];
  const client = Object.assign(new EventEmitter(), {
    close() {}, refresh: async () => {},
    snapshot: () => ({ sessions: f.sessions, rooms: [], capabilities, wakePolicy: { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client, state: { capabilities } }),
    call: async (method, ...args) => {
      if (method === 'initial') return client.snapshot();
      f.calls.push([method, ...args]);
      throw Error(method);
    },
  });
  const d = new rules.QueueDispatcher({ roomState: f.roomState, dataDir: f.dir, connect: async () => client, clients: () => client, steward: () => null,
    now: () => f.clock.now, settleMs: 8000, tickMs: 3600000, transcriptRoot: path.join(f.dir, 'none'), sampleProcesses: async () => '', samplePressure: async () => '',
    compactions: { async sample() { return new Map(); } },
    errorStalled: stall => { f.told++; if (f.throws > 0) { f.throws--; throw Error('not yet'); } return f.ingress.errorStalled(stall); } });
  t.after(() => d.close());
  return d;
}
function ingress(f) {
  return new ButlerIngress(f.dir, { roomState: f.roomState, ledger: new ButlerLedger(f.dir, { now: () => f.clock.now }), now: () => f.clock.now });
}
function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-error-stall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { dir, clock: { now: NOW }, roomState: new RoomState(dir), calls: [], throws: 0, told: 0 };
  f.member = { id: 'm1', nativeId: 'native-m1', name: 'Synthetic member', provider: 'claude', model: 'claude-test-model', state: 'error', roomIds: ['shared'], roomId: 'shared',
    serviceCapabilities: [rules.CAPABILITY], chatAvailable: true, terminalState: { alive: true }, background: 0, scheduled: 0, fleet: [], liveDraft: '', cwd: '/tmp',
    createdAt: NOW - 60 * MINUTE, lastActivityAt: NOW - MINUTE, capacityRecovery: null, messages: [], ...extra };
  f.sessions = [f.member];
  f.item = send(f, 'tag-1');
  f.ingress = ingress(f);
  f.d = dispatcher(t, f);
  return f;
}
function send(f, tag) {
  const id = f.roomState.queueAdd('Synthetic task ' + tag, null, 'shared');
  f.roomState.queueMarkSent('shared', id, 'm1', 'Synthetic member', f.clock.now - MINUTE, false, 'native-m1');
  f.roomState.queueSetDelivery('shared', id, tag, 0);
  f.member.messages.push({ id: tag, role: 'user', text: 'Synthetic task ' + tag, origin: 'naw-dispatch', time: f.clock.now - MINUTE });
  return id;
}
function restart(t, f) { f.d.close(); f.ingress = ingress(f); f.d = dispatcher(t, f); }
// A pass at every step, as after a state event; in quiet the dispatcher makes one every thirty seconds.
async function run(f, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) { f.d.dirty = true; await f.d.schedule(); f.clock.now += STEP; }
}
const events = f => f.ingress.ledger.snapshot().events;
const stalls = f => events(f).filter(e => e.eventId.startsWith('error-stalled:')).map(e => ({ kind: e.kind, sourceRef: e.sourceRef, ...e.payload }));
const line = (f, since = NOW, itemId = f.item) => ({ kind: 'blocked', sourceRef: 'error-stalled:m1', memberId: 'm1', itemId, reason: 'error-stalled', title: new Date(since).toISOString() });
function untouched(f) {
  assert.deepEqual(f.calls, [], 'nothing was sent, continued or stopped');
  const item = f.roomState.queueFind('shared', f.item);
  assert.deepEqual([item.status, item.tag, item.sentTo], ['sent', 'tag-1', 'm1']);
}

test('three minutes in error: one line, none before, none again on later passes or after a restart', async t => {
  const f = setup(t);
  await run(f, 3 * MINUTE);
  assert.deepEqual(stalls(f), [], 'not within three minutes');
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f)]);
  await run(f, 20 * MINUTE);
  assert.equal(f.told, 1);
  restart(t, f);
  await run(f, 20 * MINUTE);
  assert.deepEqual(stalls(f), [line(f)]);
  assert.equal(f.told, 2, 'asked once more after the restart, and answered from the record');
  untouched(f);
});
test('no state other than error is told', async t => {
  for (const state of ['working', 'idle', 'starting', 'ended']) {
    const f = setup(t, { state });
    await run(f, 10 * MINUTE);
    assert.deepEqual(stalls(f), [], state);
  }
});
test('in quiet, with a pass every thirty seconds, it is told within three and a half minutes', async t => {
  const f = setup(t);
  for (; f.clock.now <= NOW + 3.5 * MINUTE; f.clock.now += 3 * SECOND) await f.d.schedule();
  assert.deepEqual(stalls(f), [line(f)]);
});
test('only an item already sent counts', async t => {
  const f = setup(t);
  f.roomState.queueResolve(f.item, 'shared');
  f.roomState.queueAdd('Synthetic waiting task', 'm1', 'shared');
  await run(f, 10 * MINUTE);
  assert.deepEqual(stalls(f), []);
});
for (const status of ['scheduled', 'sending'])
test(`an automatic continuation ${status}: nothing is told; once it is gone, three more minutes`, async t => {
  const f = setup(t, { capacityRecovery: retry(status) });
  await run(f, 15 * MINUTE);
  assert.deepEqual(stalls(f), []);
  f.member.capacityRecovery = null;
  const since = f.clock.now - STEP;
  await run(f, 3 * MINUTE - STEP);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
  untouched(f);
});
test('a continuation that took the member back to work starts the three minutes over', async t => {
  const f = setup(t);
  await run(f, 2 * MINUTE);
  f.member.state = 'working';
  await run(f, 30 * SECOND);
  f.member.state = 'error';
  const since = f.clock.now;
  await run(f, 3 * MINUTE);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
test('the person pressed Esc: the member is idle, nothing is told', async t => {
  const f = setup(t);
  await run(f, 2 * MINUTE);
  f.member.state = 'idle';
  f.member.nativeInputRequired = true;
  await run(f, 10 * MINUTE);
  assert.deepEqual(stalls(f), []);
});
test('a draft in the session: nothing is told while it stays; blanks are no draft', async t => {
  const f = setup(t, { liveDraft: 'synthetic words' });
  await run(f, 30 * MINUTE);
  assert.deepEqual(stalls(f), []);
  f.member.liveDraft = ' \n';
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f)]);
});
test('the person at that session within two minutes: it waits; another session does not hold it', async t => {
  const f = setup(t);
  await run(f, 2 * MINUTE);
  f.d.noteHuman('m1');
  await run(f, 2 * MINUTE);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f)]);
  const other = setup(t);
  await run(other, 2 * MINUTE);
  other.d.noteHuman('m2');
  await run(other, MINUTE + STEP);
  assert.deepEqual(stalls(other), [line(other)]);
});
test('a Codex usage limit has a line of its own', async t => {
  const nativeQuota = { kind: 'usage_limit_exceeded', nativeId: 'native-m1', turnId: TURN, observedAt: NOW, model: null };
  const f = setup(t, { provider: 'codex', nativeQuota });
  await run(f, 10 * MINUTE);
  f.ingress.observeRecoveryFailures(f.sessions);
  assert.deepEqual(stalls(f), []);
  assert.deepEqual(events(f).map(e => e.payload.reason), ['codex-usage-limit-exceeded']);
});
test('retries spent: their own line stays the only one, also when the failure is cleared later', async t => {
  const f = setup(t, { capacityRecovery: retry('exhausted') });
  f.ingress.observeRecoveryFailures(f.sessions);
  await run(f, 10 * MINUTE);
  f.member.capacityRecovery = null;
  await run(f, 10 * MINUTE);
  assert.deepEqual(events(f).map(e => e.eventId.split(':')[0]), ['recovery-exhausted']);
});
test('retries spent and their line never recorded: told once the session lost that record', async t => {
  const f = setup(t, { capacityRecovery: retry('exhausted') });
  await run(f, 10 * MINUTE);
  assert.deepEqual(stalls(f), []);
  f.member.capacityRecovery = null;
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f)]);
});
test('a failure after the spent retries, in a later turn, is told', async t => {
  const f = setup(t, { capacityRecovery: retry('exhausted') });
  f.ingress.observeRecoveryFailures(f.sessions);
  await run(f, MINUTE);
  Object.assign(f.member, { state: 'working', capacityRecovery: null });
  await run(f, MINUTE);
  f.member.state = 'error';
  const since = f.clock.now;
  await run(f, 3 * MINUTE + STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
for (const [key, value] of [['backendUnavailable', true], ['transportDisconnected', true], ['nativeContextPending', true], ['pendingTag', 'tag-2']])
test(`${key}: what the member is doing is not known, so the three minutes start after it`, async t => {
  const f = setup(t, { [key]: value });
  await run(f, 10 * MINUTE);
  assert.deepEqual(stalls(f), []);
  f.member[key] = key === 'pendingTag' ? null : false;
  const since = f.clock.now - STEP;
  await run(f, 3 * MINUTE - STEP);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
test('a record that could not be written is tried again on the next pass', async t => {
  const f = setup(t);
  f.throws = 2;
  await run(f, 4 * MINUTE);
  assert.deepEqual(stalls(f), [line(f)]);
  assert.equal(f.told, 3);
});
test('each open item has its own line, and another native session starts over', async t => {
  const f = setup(t);
  const second = send(f, 'tag-2');
  await run(f, 2 * MINUTE);
  f.member.nativeId = 'native-m1-after-clear';
  const since = f.clock.now;
  await run(f, 3 * MINUTE);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f).map(s => s.itemId).sort(), [f.item, second].sort());
  assert.ok(stalls(f).every(s => s.title === new Date(since).toISOString()));
});
test('without the option nothing is noted and nothing fails', async t => {
  const f = setup(t);
  f.d.errorStalled = null;
  await run(f, 10 * MINUTE);
  assert.deepEqual(events(f), []);
  untouched(f);
});
test('the daily app passes it to the butler\'s record', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(main, /errorStalled: stall => butlerIngress\.errorStalled\(stall\),/);
});
