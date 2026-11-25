// A sent item whose member stopped in 'error' with nothing continuing it: the butler is told once a stop, nothing else happens
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
  await run(f, MINUTE);
  assert.equal(f.d.errorStalls.size, 1);
  f.roomState.queueResolve(f.item, 'shared');
  f.roomState.queueAdd('Synthetic waiting task', 'm1', 'shared');
  await run(f, 10 * MINUTE);
  assert.deepEqual(stalls(f), []);
  assert.equal(f.d.errorStalls.size, 0);
});
// One going out has its pending input until native takes it.
for (const status of ['scheduled', 'sending'])
test(`an automatic continuation ${status}: nothing is told; once it is gone, three more minutes`, async t => {
  const f = setup(t, { capacityRecovery: retry(status), pendingTag: status === 'sending' ? 'capacity-tag' : null });
  await run(f, 15 * MINUTE);
  assert.deepEqual(stalls(f), []);
  Object.assign(f.member, { capacityRecovery: null, pendingTag: null });
  const since = f.clock.now - STEP;
  await run(f, 3 * MINUTE - STEP);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
  untouched(f);
});
test('a continuation whose record stays at sending after its turn failed is told', async t => {
  const f = setup(t, { capacityRecovery: retry('sending'), pendingTag: 'capacity-tag' });
  await run(f, MINUTE);
  f.member.pendingTag = null;
  const since = f.clock.now - STEP;
  await run(f, 3 * MINUTE);
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
const STOPS = [['interrupt'], ['input', '\x1b'], ['input', '\x03'], ['input', 'words\x03']];
for (const [method, data] of STOPS)
test(`the person stops the scheduled continuation (${method}${data ? ' ' + JSON.stringify(data) : ''}): nothing is told, until the member runs again`, async t => {
  const f = setup(t, { capacityRecovery: retry('scheduled') });
  await run(f, MINUTE);
  f.d.noteHuman('m1', method, data);
  f.d.noteHuman('m1', method, data);
  f.member.capacityRecovery = null;
  await run(f, 60 * MINUTE);
  assert.deepEqual(stalls(f), []);
  untouched(f);
  f.member.state = 'working';
  await run(f, MINUTE);
  f.member.state = 'error';
  const since = f.clock.now;
  await run(f, 3 * MINUTE + STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
// Opened, taken over, scrolled in its terminal, or other words typed: the person may not know it stopped.
for (const [method, data] of [['claim', 'window'], ['terminal', true], ['select', undefined], ['input', '\x1b[<64;10;10M'], ['input', '\x1b[A'], ['input', 'words'], ['draft', '\x1b'], [undefined, undefined]])
test(`no stop of the scheduled continuation (${method} ${JSON.stringify(data)}): told`, async t => {
  const f = setup(t, { capacityRecovery: retry('scheduled') });
  await run(f, MINUTE);
  f.d.noteHuman('m1', method, data);
  f.member.capacityRecovery = null;
  await run(f, 3 * MINUTE);
  assert.deepEqual(stalls(f), [line(f, NOW + MINUTE - STEP)]);
});
test('Esc while nothing is scheduled, ten minutes before the stop or in it: told', async t => {
  const before = setup(t, { state: 'working' });
  await run(before, MINUTE);
  before.d.noteHuman('m1', 'input', '\x1b');
  await run(before, 10 * MINUTE);
  before.member.state = 'error';
  const since = before.clock.now;
  await run(before, 3 * MINUTE + STEP);
  assert.deepEqual(stalls(before), [line(before, since)]);
  const during = setup(t);
  await run(during, MINUTE);
  for (const [method, data] of STOPS) during.d.noteHuman('m1', method, data);
  await run(during, 3 * MINUTE);
  assert.deepEqual(stalls(during), [line(during)]);
});
test('Esc once the continuation is gone, or once the member is at work: told', async t => {
  const gone = setup(t, { capacityRecovery: retry('scheduled') });
  await run(gone, MINUTE);
  gone.member.capacityRecovery = null;
  await run(gone, MINUTE);
  gone.d.noteHuman('m1', 'input', '\x1b');
  await run(gone, 2 * MINUTE + STEP);
  assert.deepEqual(stalls(gone), [line(gone, NOW + MINUTE - STEP)]);
  const working = setup(t, { capacityRecovery: retry('scheduled') });
  await run(working, MINUTE);
  Object.assign(working.member, { state: 'working', capacityRecovery: null });
  await run(working, MINUTE);
  working.d.noteHuman('m1', 'input', '\x1b');
  working.member.state = 'error';
  const since = working.clock.now;
  await run(working, 3 * MINUTE + STEP);
  assert.deepEqual(stalls(working), [line(working, since)]);
});
test('a pass between the stop and its effect still sees the continuation scheduled: nothing is told', async t => {
  const f = setup(t, { capacityRecovery: retry('scheduled') });
  await run(f, MINUTE);
  f.d.noteHuman('m1', 'interrupt');
  await run(f, STEP);
  f.member.capacityRecovery = null;
  await run(f, 60 * MINUTE);
  assert.deepEqual(stalls(f), []);
});
test('Esc ten minutes before, on the continuation of an earlier stop: told', async t => {
  const f = setup(t, { capacityRecovery: retry('scheduled') });
  await run(f, MINUTE);
  f.d.noteHuman('m1', 'input', '\x1b');
  Object.assign(f.member, { state: 'working', capacityRecovery: null });
  await run(f, 10 * MINUTE);
  f.member.state = 'error';
  const since = f.clock.now;
  await run(f, 3 * MINUTE + STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
test('a stop in another session is not one here', async t => {
  const f = setup(t, { capacityRecovery: retry('scheduled') });
  await run(f, MINUTE);
  f.d.noteHuman('m2', 'interrupt');
  f.member.capacityRecovery = null;
  await run(f, 3 * MINUTE);
  assert.deepEqual(stalls(f), [line(f, NOW + MINUTE - STEP)]);
});
test('a stop that did not stop it: what goes out, or is scheduled for a later turn, is told when it stays', async t => {
  const sent = setup(t, { capacityRecovery: retry('scheduled') });
  await run(sent, MINUTE);
  sent.d.noteHuman('m1', 'interrupt');
  await run(sent, MINUTE);
  Object.assign(sent.member, { capacityRecovery: retry('sending'), pendingTag: 'capacity-tag' });
  await run(sent, MINUTE);
  sent.member.pendingTag = null;
  const since = sent.clock.now - STEP;
  await run(sent, 3 * MINUTE);
  assert.deepEqual(stalls(sent), [line(sent, since)]);
  const later = setup(t, { capacityRecovery: retry('scheduled') });
  await run(later, MINUTE);
  later.d.noteHuman('m1', 'interrupt');
  later.member.capacityRecovery = retry('scheduled', { turnId: '22222222-2222-4222-8222-222222222222' });
  await run(later, MINUTE);
  later.member.capacityRecovery = null;
  const again = later.clock.now - STEP;
  await run(later, 3 * MINUTE);
  assert.deepEqual(stalls(later), [line(later, again)]);
});
test('what counts as a stop in the terminal is what the workspace takes for one, and the daily app passes it on', () => {
  const source = fs.readFileSync(path.join(__dirname, '../workspace.cjs'), 'utf8');
  const found = /const interrupt = (data === .+);/.exec(source);
  const workspace = Function('data', 'return ' + found[1]);
  for (const data of ['', '\x1b', '\x03', 'a\x03b', '\x1b\x1b', '\x1b[A', '\x1bOA', '\x1b[<64;10;10M', 'words', '\r', '\x04']) {
    assert.equal(rules.terminalInterrupt(data), workspace(data), JSON.stringify(data));
  }
  for (const data of [undefined, null, 3, {}, ['\x1b']]) assert.equal(rules.terminalInterrupt(data), false);
  for (const data of ['\x1b', '\x03']) assert.equal(rules.terminalReplyOnly(data), false);
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(main, /humanSessionWork\(method, args\)\) queueDispatcher\?\.noteHuman\(args\[0\], method, args\[1\], context\.view\?\.owner\);/);
});
test('the clock set back: the three minutes start again from there', async t => {
  const f = setup(t);
  await run(f, 2 * MINUTE);
  f.clock.now -= 24 * 60 * MINUTE;
  const since = f.clock.now;
  await run(f, 3 * MINUTE);
  assert.deepEqual(stalls(f), []);
  await run(f, STEP);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
test('each stop has its own line: seen at work, then three minutes in error again; one for each also after a restart', async t => {
  for (const state of ['working', 'approval', 'background', 'idle']) {
    const f = setup(t);
    await run(f, 4 * MINUTE);
    const lines = [line(f)];
    for (let stop = 0; stop < 2; stop++) {
      f.member.state = state;
      await run(f, state === 'idle' ? STEP : MINUTE);
      f.member.state = 'error';
      const since = f.clock.now;
      await run(f, 3 * MINUTE);
      assert.deepEqual(stalls(f), lines, state);
      lines.push(line(f, since));
      await run(f, 20 * MINUTE);
      assert.deepEqual(stalls(f), lines, state);
    }
    restart(t, f);
    await run(f, 20 * MINUTE);
    assert.deepEqual(stalls(f), lines, state);
    untouched(f);
  }
});
test('a stop too short to be told does not count: the first line of the item stays one after a restart', async t => {
  const f = setup(t);
  await run(f, MINUTE);
  f.member.state = 'working';
  await run(f, MINUTE);
  f.member.state = 'error';
  const since = f.clock.now;
  await run(f, 4 * MINUTE);
  restart(t, f);
  await run(f, 10 * MINUTE);
  assert.deepEqual(stalls(f), [line(f, since)]);
});
test('a connection lost and found, or a backend starting, is not another stop', async t => {
  const f = setup(t);
  await run(f, 4 * MINUTE);
  for (const state of ['disconnected', 'recoverable', 'starting', 'ended']) {
    f.member.state = state;
    await run(f, MINUTE);
    f.member.state = 'error';
    await run(f, 10 * MINUTE);
  }
  assert.deepEqual(stalls(f), [line(f)]);
  assert.equal(f.told, 1);
  const first = setup(t);
  await run(first, 2 * MINUTE);
  first.member.state = 'disconnected';
  await run(first, MINUTE);
  first.member.state = 'error';
  const since = first.clock.now;
  await run(first, 3 * MINUTE + STEP);
  assert.deepEqual(stalls(first), [line(first, since)], 'and the time starts after it');
});
test('a second stop also has its record tried again', async t => {
  const f = setup(t);
  await run(f, 4 * MINUTE);
  f.member.state = 'working';
  await run(f, MINUTE);
  f.member.state = 'error';
  const since = f.clock.now;
  f.throws = 2;
  await run(f, 4 * MINUTE);
  assert.deepEqual(stalls(f), [line(f), line(f, since)]);
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
