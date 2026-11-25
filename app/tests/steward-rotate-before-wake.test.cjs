// The butler compacted 52 times without a rotation (the person, 2026-11-23: 「为啥还在压缩?继任会话呢」). Each wake came
// 8 to 60 seconds after the butler went idle and its turn reset the 2 quiet minutes the compaction rotation waits for.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs'), { RoomState } = require('../room-state.cjs');
const { StewardWake } = require('../steward-wake.cjs'), rules = require('../queue-dispatch.cjs');
const NOW = 1800000000000, OLD = { sessionId: 'butler', nativeId: 'native-butler' }, NEXT = { sessionId: 'butler-2', nativeId: 'native-butler-2' };
const TURN_MS = 20000, ROTATION = /^【NAW 换会话】/;

function session(identity, extra = {}) {
  return { id: identity.sessionId, nativeId: identity.nativeId, provider: 'claude', model: 'claude-test-model', state: 'idle', roomIds: [], roomId: null,
    serviceCapabilities: [rules.CAPABILITY], chatAvailable: true, background: 0, scheduled: 0, messages: [], fleet: [], liveDraft: '', cwd: '/tmp',
    createdAt: NOW - 3600000, lastActivityAt: NOW, ...extra };
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-rotate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// One backend. A wake starts a TURN_MS turn that ends idle with new activity; the rotation request leaves it working.
function dispatcher(t, clock, sessions, { steward, wake, compactions, contexts = new Map() }) {
  const dir = temp(t), sends = [], capabilities = [rules.CAPABILITY, rules.ROTATION_CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY];
  const client = Object.assign(new EventEmitter(), {
    close() {}, refresh: async () => {},
    snapshot: () => ({ sessions, rooms: [], capabilities, wakePolicy: { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client, state: { capabilities } }),
    call: async (method, ...args) => {
      if (method === 'dispatch') {
        const target = sessions.find(s => s.id === args[0]);
        sends.push({ at: clock.now, to: args[0], text: args[1], itemId: args[3] });
        target.state = 'working'; target.turnEnds = ROTATION.test(args[1]) ? Infinity : clock.now + TURN_MS;
        return 'receipt-' + sends.length;
      }
      if (method === 'initial') return client.snapshot();
      throw Error(method);
    },
  });
  const d = new rules.QueueDispatcher({ roomState: new RoomState(dir), dataDir: dir, connect: async () => client, steward: () => steward, stewardWake: wake,
    now: () => clock.now, settleMs: 8000, sampleProcesses: async () => { throw Error('no sample'); }, tickMs: 3600000, transcriptRoot: path.join(dir, 'none'),
    compactions: { contexts, async sample() { return new Map(Object.entries(compactions)); }, async recheck() {} } });
  t.after(() => d.close());
  return { d, sends };
}
function setup(t, { compactions = { butler: 3 }, idle = 0, contexts } = {}) {
  const clock = { now: NOW }, dir = temp(t), records = [];
  const ledger = new ButlerLedger(dir, { now: () => clock.now });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => OLD, now: () => clock.now, record: line => records.push(line) });
  wake.set(true);
  const sessions = [session(OLD, { createdAt: NOW - 2 * 3600000, lastActivityAt: NOW - idle * 60000 })];
  let events = 0;
  const event = () => ledger.ingest({ eventId: `synthetic-${++events}`, kind: 'ready', sourceRef: 'synthetic', payload: { text: `synthetic event ${events}` } });
  return { clock, ledger, wake, records, sessions, event, ...dispatcher(t, clock, sessions, { steward: OLD, wake, compactions, contexts }) };
}
// Ten-second steps; a stewardEvent every 30 seconds; turns end on time.
async function run(f, ms, { events = true } = {}) {
  for (let elapsed = 0; elapsed < ms; elapsed += 10000) {
    if (events && elapsed % 30000 === 0) f.event();
    for (const s of f.sessions) if (s.state === 'working' && f.clock.now >= s.turnEnds) { s.state = 'idle'; s.lastActivityAt = f.clock.now; }
    await f.d.schedule();
    f.clock.now += 10000;
  }
}

test('the butler past its compaction limit, idle, the person quiet: the rotation goes out before the next wake', async t => {
  const f = setup(t), woken = f.wake.state.woken;
  await run(f, 10 * 60000);
  const first = f.sends.find(s => s.to === OLD.sessionId);
  assert.ok(first, 'something went to the butler');
  assert.match(first.text, ROTATION, `first send to the butler was a wake at +${(first.at - NOW) / 1000}s, not the rotation`);
  assert.ok(first.at - NOW >= 2 * 60000 && first.at - NOW <= 3 * 60000, 'the rotation waits its 2 quiet minutes, and no longer');
  assert.equal(f.sends.filter(s => !ROTATION.test(s.text)).length, 0, 'no wake reached the butler');
  // Nothing consumed: the held events wait at the same position for whoever is the butler next.
  assert.equal(f.wake.state.woken, woken);
  assert.equal(f.wake.due(), true);
});

test('the successor gets the held events in one wake, and they are not sent again', async t => {
  const f = setup(t);
  await run(f, 3 * 60000);
  assert.ok(f.sends.some(s => ROTATION.test(s.text)), 'the rotation request went out');
  // After the handoff: the successor is the butler, the old session has left, the same wake state carries on.
  const sessions = [session(NEXT, { lastActivityAt: f.clock.now })];
  const next = { ...f, sessions, ...dispatcher(t, f.clock, sessions, { steward: NEXT, wake: f.wake, compactions: {} }) };
  await run(next, 3 * 60000, { events: false });
  assert.deepEqual(next.sends.map(s => s.to), [NEXT.sessionId], 'one wake, to the successor');
  assert.doesNotMatch(next.sends[0].text, ROTATION);
  assert.equal(f.wake.due(), false, 'every held event was delivered');
});

test('below the compaction limit the wake is not held', async t => {
  const f = setup(t, { compactions: { butler: 2 } });
  await run(f, 60000);
  const first = f.sends.find(s => s.to === OLD.sessionId);
  assert.ok(first && !ROTATION.test(first.text) && first.at - NOW < 60000, 'woken within the first minute, as before');
});

test('a draft in the butler\'s input still holds both the rotation and the wake', async t => {
  const f = setup(t);
  f.sessions[0].liveDraft = 'x';
  await run(f, 10 * 60000);
  assert.deepEqual(f.sends, []);
});

// R221: a butler over the size a quiet rotation needs. Only the 45 minutes make that a reason, so until then it holds no wake.
const large = minutes => ({ compactions: { butler: 1 }, idle: minutes, contexts: new Map([['butler', { tokens: 190000, at: NOW - minutes * 60000, ttlMs: 3600000 }]]) });
for (const minutes of [0, 10, 31, 43]) test(`a large butler idle for ${minutes} minutes is woken as before`, async t => {
  const f = setup(t, large(minutes));
  await run(f, 60000);
  const first = f.sends.find(s => s.to === OLD.sessionId);
  assert.ok(first && !ROTATION.test(first.text) && first.at - NOW < 60000, 'woken within the first minute');
  assert.equal(f.sends.filter(s => ROTATION.test(s.text)).length, 0);
});

test('a large butler idle for 45 minutes is rotated when an event comes, and the event goes to its successor once', async t => {
  const f = setup(t, large(45)), woken = f.wake.state.woken;
  await run(f, 3 * 60000);
  assert.deepEqual(f.sends.map(s => ROTATION.test(s.text)), [true]);
  assert.equal(f.wake.state.woken, woken);
  const sessions = [session(NEXT, { lastActivityAt: f.clock.now })];
  const next = { ...f, sessions, ...dispatcher(t, f.clock, sessions, { steward: NEXT, wake: f.wake, compactions: {} }) };
  await run(next, 3 * 60000, { events: false });
  assert.deepEqual(next.sends.map(s => [s.to, ROTATION.test(s.text)]), [[NEXT.sessionId, false]]);
  assert.equal(f.wake.due(), false);
});
