'use strict';
// R209 (the person, 2026-11-24: 「比如点击卡之后我期望你这边应该有反应,但为啥每次都没反应」): a click on the butler's card waited
// behind the gates that keep the butler undisturbed. Now it wakes the butler at once unless it is at work or an input is
// on its way, and what holds it is shown and recorded at once. Synthetic sessions; no model, no daily data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), { QueueDispatcher, CAPABILITY } = rules;
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs');
const { PersonActions, asker } = require('../person-actions.cjs');
const { StewardWake } = require('../steward-wake.cjs');
const { QuietWindows } = require('../quiet-windows.cjs');
const { healthSummary } = require('../mobile-workspace.cjs');

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, START = 1_800_000_000_000, KEY = 'backends/bbbbbbbbbbbbbbbbbbbb';
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };
const CAPABILITIES = [CAPABILITY, rules.ROTATION_CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY];
const session = (id, extra = {}) => ({ id, name: `Synthetic ${id}`, provider: 'claude', nativeId: `native-${id}`, model: 'synthetic-model', state: 'idle', roomIds: [], roomId: null, cwd: '/tmp',
  createdAt: START - HOUR, lastActivityAt: START - MIN, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [CAPABILITY], fleet: [], messages: [], ...extra });
const quietWindow = () => ({ id: '00000000-0000-4000-8000-000000000001', scope: `backend:${KEY}`, reason: 'migration', openedBy: 'naw',
  openedAt: START, deadline: START + HOUR, waited: 'busy', sessions: ['butler'] });
const done = (from, to, event = 'done') => ({ time: START - HOUR, event, spaces: [], old: { id: from, nativeId: `native-${from}`, name: from }, new: { id: to, nativeId: `native-${to}`, name: to } });

// The real dispatcher, wake, window record and person-action intake over one synthetic backend.
function fixture(t, { butler = {}, windows = [], compactions = {}, log = [], steward = () => ({ ...BUTLER, duty: '' }), others = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-card-click-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (log.length) fs.writeFileSync(path.join(dir, 'rotation-log.jsonl'), `${log.map(e => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 });
  const clock = { now: START + MIN }, lines = [], sent = [], room = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: room, ledger, now: () => clock.now }), actions = new PersonActions({ ingress, now: () => clock.now });
  const sessions = [session('butler', butler), ...others];
  const client = Object.assign(new EventEmitter(), { state: { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, operatorPolicy: { domains: [] }, capabilities: CAPABILITIES },
    close() {}, snapshot: () => structuredClone(client.state), refresh: async () => client.snapshot(), route: () => ({ client, state: { capabilities: CAPABILITIES } }),
    call: async (method, ...args) => {
      if (method === 'initial') return client.snapshot();
      if (method !== 'dispatch') return undefined;
      if (f.refuse) throw Object.assign(Error('SYNTHETIC not sent'), f.refuse);
      sent.push({ id: args[0], text: args[1], kind: (args[3] || '').split(':')[0], at: clock.now });
      const s = sessions.find(x => x.id === args[0]); s.state = 'working'; s.lastActivityAt = clock.now;
      return `tag-${sent.length}`;
    } });
  let shown = 0;
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => BUTLER, now: () => clock.now, record: line => lines.push(line), changed: () => { shown++; },
    asker: event => asker(f.rows, event) });
  fs.writeFileSync(path.join(dir, 'quiet-windows.json'), JSON.stringify({ format: 1, windows, history: [] }), { mode: 0o600 });
  const quiet = new QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait });
  const dispatcher = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => clock.now, settleMs: 8000, tickMs: 3000,
    steward, stewardWake: wake, quietWindows: quiet, transcriptRoot: path.join(dir, 'none'),
    sampleProcesses: async () => '', samplePressure: async () => '', compactions: { async sample() { return new Map(Object.entries(compactions)); } } });
  t.after(() => dispatcher.close());
  wake.set(true);
  const f = { dir, clock, lines, sent, room, ledger, client, wake, quiet, dispatcher, actions, sessions, butler: sessions[0], refuse: null, rows: [] };
  // The card as BackgroundControl records the person's answer to it.
  f.click = (id = 'card-1', humanDecision = 1, actor = 'butler') => {
    f.rows.push({ id, actor: { id: actor, nativeId: `native-${actor}` }, command: { method: 'createSession' }, confirmation: { options: { cancelId: 0 } }, humanDecision, humanDecisionAt: clock.now, state: 'complete' });
    actions.observe({}, f.rows);
  };
  f.event = (n = 1) => ledger.ingest({ eventId: `butler-source:${n}`, sourceRef: `queue-outcome:space-1:${n}`, kind: 'failure', payload: { spaceId: 'space-1', itemId: `item-${n}`, reason: 'Synthetic failure' } });
  // Passes as the dispatcher's own timer makes them, every 3 seconds, for `ms`. A state change is pushed as a backend does.
  f.run = async (ms, step = 3 * SEC) => {
    const end = clock.now + ms;
    do { await dispatcher.schedule(); clock.now += step; } while (clock.now <= end);
  };
  f.push = (change = {}) => { Object.assign(f.butler, change); client.emit('state', client.snapshot()); };
  f.idle = async (ms = HOUR / 2) => { f.butler.lastActivityAt = START - HOUR; await f.run(ms); f.sent.length = 0; };
  f.wakes = () => f.sent.filter(s => s.kind === 'steward-wake');
  f.desk = () => wake.view({ early: true }).blocked ?? null;
  f.phone = () => wake.view().blocked ?? null;
  f.blockedLines = () => f.lines.filter(l => l.kind === 'wakeBlocked').map(l => l.reason);
  f.shown = () => shown;
  return f;
}
const soon = (f, at, ms = 6 * SEC) => { assert.equal(f.wakes().length, 1, `${f.wakes().length} wakes, held by ${f.wake.view({ held: true }).blocked?.reason}`); assert.ok(f.wakes()[0].at - at <= ms, `${f.wakes()[0].at - at} ms`); };

test('clicked just after the person wrote to the butler: woken at once, not two minutes later', async t => {
  for (const decision of [1, 0]) for (const method of ['send', 'claim', undefined]) {
    const f = fixture(t);
    await f.run(MIN);
    f.dispatcher.noteHuman('butler', method); await f.run(6 * SEC);
    f.click('card-1', decision); const at = f.clock.now;
    await f.run(30 * SEC);
    soon(f, at);
    assert.equal(f.desk(), null); assert.equal(f.wake.due(), false);
  }
});

test('an ordinary event just after the person wrote still waits the two minutes', async t => {
  const f = fixture(t);
  await f.run(MIN); f.dispatcher.noteHuman('butler', 'send'); const used = f.clock.now;
  f.event(); await f.run(5 * MIN);
  assert.equal(f.wakes().length, 1); assert.ok(f.wakes()[0].at - used >= 2 * MIN);
});

test('clicked while a compaction rotation waits for its quiet: woken at once, and the rotation follows its turn', async t => {
  const f = fixture(t, { compactions: { butler: 3 }, butler: { lastActivityAt: START + MIN } });
  f.event(); await f.run(30 * SEC);
  assert.deepEqual(f.sent, [], 'the ordinary event waits for the rotation');
  f.click(); const at = f.clock.now;
  await f.run(30 * SEC);
  soon(f, at);
  f.push({ state: 'idle', lastActivityAt: f.clock.now }); const ended = f.clock.now;
  await f.run(4 * MIN);
  const rotation = f.sent.find(s => /^【NAW 换会话】/u.test(s.text));
  assert.ok(rotation && rotation.at - ended >= 2 * MIN && rotation.at - ended <= 3 * MIN, 'the rotation waits its two quiet minutes after that turn');
});

test('clicked inside a migration quiet window: woken at once, also when the person just wrote', async t => {
  for (const used of [false, true]) {
    const f = fixture(t, { windows: [quietWindow()] });
    await f.run(MIN); if (used) { f.dispatcher.noteHuman('butler', 'send'); await f.run(3 * SEC); }
    f.click(); const at = f.clock.now;
    await f.run(30 * SEC);
    soon(f, at); assert.ok(f.quiet.windowOf('butler', f.clock.now), 'the window is still open');
  }
});

test('clicked while it works: woken as that turn ends, and nothing is shown meanwhile', async t => {
  const f = fixture(t, { butler: { state: 'working', backgroundStale: true, pendingTag: 'tag-of-this-turn' } });
  f.dispatcher.noteHuman('butler', 'send');
  f.click(); await f.run(5 * MIN);
  assert.deepEqual(f.sent, []); assert.equal(f.desk(), null); assert.deepEqual(f.blockedLines(), []);
  f.dispatcher.noteHuman('butler', 'send'); await f.run(3 * SEC);
  f.push({ state: 'idle', backgroundStale: false, pendingTag: null, lastActivityAt: f.clock.now }); const ended = f.clock.now;
  await f.run(30 * SEC);
  soon(f, ended, 8 * SEC + 6 * SEC);
  assert.ok(f.wakes()[0].at - ended >= 8 * SEC, 'its turn is known to have ended');
});

test('a click less than a minute after the last wake does not wait for that minute', async t => {
  const f = fixture(t);
  f.event(); await f.run(30 * SEC); assert.equal(f.wakes().length, 1);
  f.push({ state: 'idle', lastActivityAt: f.clock.now - 20 * SEC });
  f.click(); const at = f.clock.now; f.sent.length = 0;
  await f.run(15 * SEC);
  soon(f, at, 14 * SEC);
  // An ordinary event still does.
  f.push({ state: 'idle', lastActivityAt: f.clock.now - 20 * SEC }); f.sent.length = 0;
  f.event(2); const next = f.clock.now; await f.run(2 * MIN);
  assert.equal(f.wakes().length, 1); assert.ok(f.wakes()[0].at - next >= 40 * SEC);
});

test('an idle clock that runs decides, whatever the last activity says', async t => {
  const f = fixture(t, { butler: { state: 'working' } });
  await f.run(MIN); f.click();
  f.push({ state: 'idle', lastActivityAt: f.clock.now - 30 * SEC }); const ended = f.clock.now;
  await f.run(15 * SEC);
  soon(f, ended, 14 * SEC); assert.ok(f.wakes()[0].at - ended >= 8 * SEC);
});

test('a rotation record that cannot be read makes no event a click, and stops no pass', async t => {
  const f = fixture(t);
  f.dispatcher.holders = () => { throw Error('SYNTHETIC'); };
  await f.run(MIN); f.dispatcher.noteHuman('butler', 'send'); const used = f.clock.now;
  f.event(); await f.run(5 * MIN);
  assert.equal(f.wakes().length, 1); assert.ok(f.wakes()[0].at - used >= 2 * MIN);
});

test('every click is told once: several before a wake in one, one after it in the next', async t => {
  const f = fixture(t);
  await f.run(MIN);
  f.click('card-1'); f.click('card-2', 0); await f.run(15 * SEC);
  assert.equal(f.wakes().length, 1);
  f.click('card-3'); await f.run(MIN); assert.equal(f.wakes().length, 1, 'at work with the first');
  f.push({ state: 'idle', lastActivityAt: f.clock.now }); await f.run(30 * SEC);
  assert.equal(f.wakes().length, 2);
  f.push({ state: 'idle', lastActivityAt: f.clock.now }); f.actions.observe({}, f.rows); await f.run(10 * MIN);
  assert.equal(f.wakes().length, 2);
});

test('a draft is not interrupted: the hold is shown and recorded at once, and the wake follows the draft', async t => {
  const f = fixture(t);
  f.push({ liveDraft: 'SYNTHETIC PRIVATE DRAFT' }); await f.run(MIN);
  f.click(); await f.run(6 * SEC);
  assert.deepEqual(f.sent, []);
  assert.deepEqual([f.desk()?.reason, f.desk()?.card], ['person-typing', true]);
  assert.deepEqual(f.blockedLines(), ['person-typing']); assert.ok(f.shown() > 0);
  assert.doesNotMatch(JSON.stringify([f.lines, f.desk()]), /SYNTHETIC PRIVATE/u);
  const told = f.shown();
  await f.run(5 * MIN);
  assert.deepEqual(f.blockedLines(), ['person-typing'], 'one line for one reason'); assert.deepEqual(f.sent, []);
  assert.ok(f.shown() - told <= 6, 'the page is told once a minute, not each pass');
  const before = f.shown();
  f.push({ liveDraft: '' }); const at = f.clock.now;
  await f.run(30 * SEC);
  soon(f, at, 12 * SEC); assert.equal(f.desk(), null); assert.ok(f.shown() > before, 'the page is told it is over');
});

test('an ordinary event held by a draft is still said after ten minutes, not at once', async t => {
  const f = fixture(t, { butler: { liveDraft: 'x' } });
  f.event(); await f.run(9 * MIN);
  assert.equal(f.desk(), null); assert.deepEqual(f.blockedLines(), []);
  await f.run(2 * MIN);
  assert.equal(f.desk()?.reason, 'person-typing'); assert.equal(f.desk().card, undefined);
  // A click now is named at once, in a hold already shown.
  await f.run(3 * SEC); const told = f.shown();
  f.click(); await f.run(3 * SEC);
  assert.equal(f.desk().card, true); assert.ok(f.shown() > told);
});

test('its own handoff left unresolved takes over from a click held by something else', async t => {
  const f = fixture(t, { butler: { liveDraft: 'x' } });
  f.click(); await f.run(6 * SEC); assert.equal(f.desk()?.card, true);
  f.dispatcher.ownHandoffStep = () => 'release'; f.push(); await f.run(6 * SEC);
  assert.deepEqual([f.desk()?.step, f.desk()?.card], ['release', undefined]);
});

test('the phone is not alarmed before ten minutes, and its alarm keeps its form after', async t => {
  const f = fixture(t, { butler: { liveDraft: 'x' } });
  f.click(); await f.run(9 * MIN);
  assert.equal(f.phone(), null); assert.ok(f.desk());
  await f.run(2 * MIN);
  assert.equal(f.phone()?.reason, 'person-typing'); assert.equal(f.phone().card, undefined); assert.equal(f.wake.view({ held: true }).blocked.card, undefined);
  const health = healthSummary(f.wake.view(), require('../steward-wake.cjs').BLOCK_REASONS);
  assert.equal(health.available, true); assert.equal(health.alerts.length, 1);
  assert.doesNotMatch(JSON.stringify(health), /card/u);
});

test('a click that comes while an event is already held is shown at once, and work hides it again', async t => {
  const f = fixture(t, { butler: { liveDraft: 'x' } });
  f.event(); await f.run(3 * MIN); assert.equal(f.desk(), null);
  f.click(); await f.run(6 * SEC); assert.equal(f.desk()?.card, true);
  const before = f.shown();
  f.push({ state: 'working', liveDraft: '' }); await f.run(6 * SEC);
  assert.equal(f.desk(), null); assert.ok(f.shown() > before);
  f.push({ state: 'idle', lastActivityAt: f.clock.now }); const ended = f.clock.now; await f.run(30 * SEC);
  soon(f, ended, 14 * SEC);
});

test('typing in its terminal is an input on its way: twenty seconds after the last key, then the wake', async t => {
  const f = fixture(t);
  await f.run(MIN);
  f.dispatcher.noteHuman('butler', 'input'); const typed = f.clock.now;
  f.click(); await f.run(12 * SEC);
  assert.deepEqual(f.sent, []); assert.equal(f.desk()?.reason, 'person-recent');
  await f.run(30 * SEC);
  assert.equal(f.wakes().length, 1);
  assert.ok(f.wakes()[0].at - typed >= 20 * SEC && f.wakes()[0].at - typed <= 26 * SEC, `${f.wakes()[0].at - typed} ms`);
});

test('a key typed between the pass and the send holds the click too', async t => {
  const f = fixture(t), refresh = f.client.refresh;
  await f.run(MIN);
  f.click(); f.client.refresh = async () => { f.dispatcher.noteHuman('butler', 'input'); return refresh(); };
  await f.dispatcher.schedule();
  assert.deepEqual(f.sent, []);
});

test('its own background command or timer does not hold a click, only the other events', async t => {
  for (const extra of [{ background: 1 }, { scheduled: 1 }]) {
    const f = fixture(t, { butler: extra });
    f.event(); await f.run(2 * MIN); assert.deepEqual(f.sent, []);
    f.click(); const at = f.clock.now; await f.run(15 * SEC);
    soon(f, at);
  }
  // Interrupted, or moved to another context: no report of it comes before its next turn.
  const unread = fixture(t, { butler: { backgroundStale: true, background: null } });
  unread.event(); await unread.run(2 * MIN); assert.deepEqual(unread.sent, []);
  unread.click(); const at = unread.clock.now; await unread.run(15 * SEC);
  soon(unread, at);
});

test('every other gate still holds a click, and says so at once', async t => {
  const child = { event: 'SubagentStart', id: 'child', stale: false, time: START };
  for (const [name, set, reason] of [
    ['automatic messages off', f => { f.client.state.wakePolicy = { enabled: false }; }, 'automatic-messages-off'],
    ['the butler paused by the person', f => { f.butler.wakeDisabled = true; }, 'paused'],
    ['a native dialog open', f => { f.butler.nativeTerminalDialog = { kind: 'synthetic' }; }, 'native-terminal-dialog'],
    ['a child agent running', f => { f.butler.fleet = [child]; }, 'team-running'],
    ['a DeepSeek model', f => { f.butler.model = 'deepseek-flash'; }, 'model-excluded'],
    ['an unknown model', f => { f.butler.model = null; }, 'model-unknown'],
    ['a space it joined', f => { f.butler.roomIds = ['shared']; f.butler.roomId = 'shared'; }, 'in-space'],
    ['another native session', f => { f.butler.nativeId = 'native-other'; }, 'identity-unavailable'],
    ['an unavailable backend', f => { f.butler.backendUnavailable = true; }, 'unavailable'],
    ['a failed turn', f => { f.butler.state = 'error'; }, 'not-idle'],
    ['ended', f => { f.butler.state = 'ended'; }, 'not-idle'],
    ['recoverable', f => { f.butler.state = 'recoverable'; }, 'not-idle'],
    ['disconnected', f => { f.butler.state = 'disconnected'; }, 'not-idle'],
    ['a context not saved', f => { f.butler.nativeContextPending = true; }, 'busy'],
    ['an interrupt on its way', f => { f.butler.interruptPending = true; }, 'busy'],
    ['a message waiting in its queue', f => { f.butler.pendingQueue = [{ id: 'q' }]; }, 'busy'],
    ['a trust question', f => { f.dispatcher.isolation.holds = { butler: { reason: 'synthetic' } }; }, 'trust-hold'],
  ]) {
    const f = fixture(t);
    await f.run(MIN); set(f); f.client.emit('state', f.client.snapshot());
    f.click(); await f.run(9 * SEC);
    assert.deepEqual(f.sent, [], name); assert.deepEqual([f.desk()?.reason, f.desk()?.card], [reason, true], name);
    assert.deepEqual(f.blockedLines(), [reason], name);
    await f.run(2 * MIN); assert.deepEqual(f.sent, [], name);
  }
  const unread = fixture(t);
  await unread.run(MIN); unread.client.refresh = async () => { throw Error('SYNTHETIC PRIVATE REFRESH ERROR'); };
  unread.click(); await unread.run(9 * SEC);
  assert.deepEqual([unread.desk()?.reason, unread.desk()?.card], ['source-unavailable', true]); assert.deepEqual(unread.blockedLines(), ['source-unavailable']);
  for (const turn of [{ approval: { id: 'a' } }, { claudeQuestion: { id: 'q' } }, { nativeInputRequired: true }, { state: 'working' }, { state: 'approval' }]) {
    const busy = fixture(t);
    await busy.run(MIN); Object.assign(busy.butler, turn); busy.click(); await busy.run(MIN);
    assert.deepEqual(busy.sent, []); assert.equal(busy.desk(), null, 'its turn, or its own question on screen'); assert.deepEqual(busy.blockedLines(), []);
    // Started between the pass and the send: not shown either.
    const late = fixture(t), refresh = late.client.refresh;
    await late.run(MIN); late.client.refresh = async () => { Object.assign(late.butler, turn); return refresh(); };
    late.click(); await late.dispatcher.schedule();
    assert.deepEqual(late.sent, []); assert.equal(late.desk(), null); assert.deepEqual(late.blockedLines(), []);
  }
  const off = fixture(t);
  off.wake.set(false); off.click(); await off.run(5 * MIN);
  assert.deepEqual(off.sent, [], 'event wake off'); assert.equal(off.desk(), null);
});

test('a send that fails is shown at once and tried once a minute, not every three seconds', async t => {
  for (const [refuse, reason] of [[{ notSent: true }, 'send-not-sent'], [{}, 'send-unconfirmed']]) {
    const f = fixture(t);
    await f.run(MIN); f.refuse = refuse;
    f.click(); await f.run(45 * SEC);
    const tries = () => f.lines.filter(l => l.kind === 'wake').length;
    assert.equal(tries(), 1); assert.deepEqual([f.desk()?.reason, f.desk()?.card], [reason, true]); assert.deepEqual(f.blockedLines(), [reason]);
    f.click('card-2'); await f.run(9 * SEC); assert.equal(tries(), 1, 'another click does not hurry a send that fails');
    f.refuse = null; for (let i = 0; i < 30 && !f.sent.length; i++) await f.run(0);
    assert.equal(tries(), 2); assert.equal(f.wakes().length, 1); assert.equal(f.desk(), null);
    f.push({ state: 'idle', lastActivityAt: f.clock.now - 20 * SEC }); f.click('card-3'); const at = f.clock.now; f.sent.length = 0;
    await f.run(15 * SEC); soon(f, at, 14 * SEC);
  }
});

test('a patrol that failed is a failed attempt too', async t => {
  const f = fixture(t, { others: [session('worker', { state: 'working' })] });
  f.wake.setPatrol(15); f.refuse = {};
  for (let i = 0; i < 400 && !f.lines.some(l => l.kind === 'patrol'); i++) await f.run(0);
  assert.ok(f.lines.some(l => l.kind === 'patrol'));
  f.click(); await f.run(45 * SEC);
  assert.equal(f.lines.filter(l => l.kind === 'wake').length, 0); assert.deepEqual([f.desk()?.reason, f.desk()?.card], ['send-unconfirmed', true]);
  f.refuse = null; await f.run(MIN); assert.equal(f.wakes().length, 1);
});

test('only the butler\'s own card: another agent\'s card, an expired one and the person\'s other acts wait as before', async t => {
  for (const [name, act] of [
    ['another agent\'s card', f => f.click('card-1', 1, 'worker')],
    ['a card that ran out of time', f => f.ledger.ingest({ eventId: 'e1', sourceRef: 'e1', kind: 'request', payload: { reason: 'person-action:confirmation:expire', outcome: 'not-executed', memberId: 'butler' } })],
    ['an answer on a queue item', f => f.actions.call('spaceAction', ['space-1', 'queueResolve', ['item-1', 'SYNTHETIC']], true)],
    ['a native answer', f => f.actions.call('answer', ['butler', 'question-1'], true)],
    ['an event that only looks like it', f => f.ledger.ingest({ eventId: 'e2', sourceRef: 'e2', kind: 'blocked', payload: { reason: 'person-action:confirmation:confirm', memberId: 'butler' } })],
  ]) {
    const f = fixture(t);
    await f.run(MIN); f.dispatcher.noteHuman('butler', 'send'); const used = f.clock.now;
    act(f); await f.run(MIN);
    assert.deepEqual(f.sent, [], name); assert.equal(f.desk(), null, name);
    await f.run(3 * MIN); assert.equal(f.wakes().length, 1, name); assert.ok(f.wakes()[0].at - used >= 2 * MIN, name);
  }
});

test('a card of the session the butler continued from counts; of a session it only kept, or another chain, does not', async t => {
  const log = [done('first', 'second'), done('second', 'butler'), done('other', 'other-2'), done('kept', 'butler', 'kept')];
  for (const [actor, own] of [['second', true], ['first', true], ['other', false], ['other-2', false], ['kept', false]]) {
    const f = fixture(t, { log });
    await f.run(MIN); f.dispatcher.noteHuman('butler', 'send');
    f.click('card-1', 1, actor); await f.run(15 * SEC);
    assert.equal(f.wakes().length, own ? 1 : 0, actor);
  }
});

test('a rotation really under way, or a handoff it holds, still holds it and is shown at once', async t => {
  const f = fixture(t, { compactions: { butler: 3 }, butler: { lastActivityAt: START - HOUR } });
  await f.run(2 * MIN);
  assert.ok(f.sent.some(s => /^【NAW 换会话】/u.test(s.text)), 'the rotation went out'); f.sent.length = 0;
  f.push({ state: 'idle', lastActivityAt: f.clock.now - MIN });
  f.click(); await f.run(6 * SEC);
  assert.deepEqual(f.wakes(), []); assert.equal(f.desk(), null, 'its turn ended a moment ago');
  for (const [name, rotations, holding] of [['a rotation', { butler: { phase: 'requested', oldId: 'butler' } }, []], ['a handoff', {}, ['butler']]]) {
    const g = fixture(t), wakeSteward = g.dispatcher.wakeSteward.bind(g.dispatcher);
    g.dispatcher.wakeSteward = async (current, _, quiet) => {
      const kept = g.dispatcher.rotations; g.dispatcher.rotations = rotations;
      try { return await wakeSteward(current, holding, quiet); } finally { g.dispatcher.rotations = kept; }
    };
    await g.run(MIN); g.click(); await g.run(6 * SEC);
    assert.deepEqual(g.wakes(), [], name); assert.deepEqual([g.desk()?.reason, g.desk()?.card], ['engaged', true], name); assert.deepEqual(g.blockedLines(), ['engaged'], name);
  }
});

test('a click that changes no session is looked at within a tick, confirmed or cancelled', async t => {
  for (const decision of [1, 0]) for (let offset = 0; offset < 30; offset += 5) {
    const f = fixture(t);
    await f.run(2 * MIN + offset * SEC);
    f.click('card-1', decision); const at = f.clock.now;
    await f.run(6 * SEC);
    soon(f, at, 3 * SEC);
  }
});

test('where no idle clock runs, the eight seconds after its turn end with the next tick', async t => {
  for (const extra of [{ windows: [quietWindow()] }, { butler: { background: 1 } }]) for (let offset = 0; offset < 30; offset += 10) {
    const f = fixture(t, extra);
    await f.run(2 * MIN + offset * SEC);
    f.butler.lastActivityAt = f.clock.now; f.click(); const at = f.clock.now;
    await f.run(15 * SEC);
    soon(f, at, 8 * SEC + 3 * SEC); assert.ok(f.wakes()[0].at - at >= 8 * SEC);
    assert.deepEqual(f.blockedLines(), [], 'those seconds are its turn, not a hold to show'); assert.equal(f.shown(), 0);
  }
});

test('a held click does not make the dispatcher pass every three seconds', async t => {
  for (const [name, set] of [
    ['a draft', f => { f.butler.liveDraft = 'x'; }], ['a DeepSeek model', f => { f.butler.model = 'deepseek-flash'; }], ['a send that fails', f => { f.refuse = { notSent: true }; }],
    ['its own handoff', f => { f.dispatcher.ownHandoffStep = () => 'release'; }], ['a record that cannot be written', f => { f.wake.record = () => { throw Error('SYNTHETIC'); }; }],
  ]) {
    const f = fixture(t);
    await f.run(3 * MIN); set(f); f.click(); await f.run(2 * MIN);
    const wakeSteward = f.dispatcher.wakeSteward.bind(f.dispatcher); let passes = 0;
    f.dispatcher.wakeSteward = (...args) => { passes++; return wakeSteward(...args); };
    await f.run(5 * MIN);
    assert.ok(passes >= 8 && passes <= 12, `${name}: ${passes} passes in five minutes`); assert.deepEqual(f.sent, [], name);
  }
});

test('a patrol passes nothing more than before, and an unreadable record passes nothing', async t => {
  const f = fixture(t, { butler: { background: 1 }, others: [session('worker', { state: 'working' })] });
  f.wake.setPatrol(15); await f.run(40 * MIN);
  assert.deepEqual(f.sent, []);
  const g = fixture(t);
  await g.run(MIN); g.dispatcher.noteHuman('butler', 'send'); g.click();
  g.ledger.eventsAfter = () => { throw Error('SYNTHETIC PRIVATE LEDGER ERROR'); };
  await g.run(MIN);
  assert.deepEqual(g.sent, []); assert.equal(g.desk(), null);
});

const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..', '..');
const vm = require('node:vm'), locale = require('../ui-locale.js');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the desktop asks for a click held at once, the phone does not, and a typed key is told as one', () => {
  const main = read('app/main.cjs'), start = main.indexOf('function stewardWakeChanged() {'), asked = [];
  const context = vm.createContext({ stewardWake: { view: options => { asked.push(options); return {}; } }, windows: new Map(), sendToPage() {}, recordsChanged() {} });
  vm.runInContext(main.slice(start, main.indexOf('\nfunction ', start + 1)), context);
  context.stewardWakeChanged();
  assert.equal(JSON.stringify(asked), '[{"early":true}]');
  assert.match(main, /stewardWakeStatus: stewardWake\?\.view\(\{ early: true \}\)\.blocked \|\| null/u);
  assert.match(main, /healthSummary\(stewardWake\?\.view\(\), /u); assert.match(main, /if \(stewardWake\?\.view\(\)\.blocked\) alerts\.push\(\{ code: 'steward-wake-stalled' \}\)/u);
  assert.match(main, /else if \(humanSessionWork\(method, args\)\) queueDispatcher\?\.noteHuman\(args\[0\], method, args\[1\]\);/u);
});

test('the chip names the click and not a minute count; the person\'s own step keeps its text', () => {
  const source = read('app/renderer/renderer.js'), start = source.indexOf('function renderStewardWakeWarning('), end = source.indexOf('\n}\n', start) + 2;
  for (const language of ['zh', 'en']) {
    const say = (k, v) => locale.format(language, k, v), p = { textContent: '' }, step = { hidden: true }, button = {}, summary = { setAttribute(k, v) { this[k] = v; } };
    const text = { textContent: '', setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; } };
    const parts = { p, summary, '.wake-chip-text': text, '.steward-wake-step': step, '.steward-wake-record': button }, box = { hidden: true, open: false, dataset: {}, querySelector: tag => parts[tag] };
    const context = vm.createContext({ state: {}, disconnected: false, $: id => id === 'steward-wake-chip' ? box : null, stewardSteps: { open() {} }, uiText: say, rotationReleaseAction: () => [], backendUpdateAction: () => [] });
    vm.runInContext(source.slice(start, end), context);
    const reason = say('stewardWake.reason.person-typing');
    context.renderStewardWakeWarning({ since: 1, minutes: 0, reason: 'person-typing', card: true });
    assert.equal(box.hidden, false);
    assert.equal(text.textContent, say('stewardWake.chipCard')); assert.doesNotMatch(text.textContent, /\d|\{/u);
    assert.equal(summary['aria-label'], say('stewardWake.cardWaiting', { reason })); assert.ok(summary['aria-label'].includes(reason));
    assert.ok(p.textContent.includes(reason)); assert.equal(text.role, 'status');
    context.renderStewardWakeWarning({ since: 1, minutes: 12, reason: 'person-typing' });
    assert.equal(text.textContent, say('stewardWake.chip', { minutes: 12 })); assert.equal(summary['aria-label'], say('stewardWake.stalled', { minutes: 12, reason }));
    context.renderStewardWakeWarning({ since: 1, minutes: 3, reason: 'rotation-control-unresolved', step: 'release', card: true });
    assert.equal(text.textContent, say('stewardWake.chip', { minutes: 3 }));
    assert.equal(summary['aria-label'], say('stewardWake.ownHandoffButton.release', { minutes: 3 }));
    context.renderStewardWakeWarning(null); assert.equal(box.hidden, true);
  }
});

test('the record\'s line about a hold shown at once says no minute count', () => {
  assert.match(read('app/renderer/steward-record.js'), /entry\.minutes \? 'stewardWake\.stalled' : 'stewardWake\.notWoken'/u);
  for (const language of ['zh', 'en']) {
    const reason = locale.format(language, 'stewardWake.reason.person-typing'), text = locale.format(language, 'stewardWake.notWoken', { reason });
    assert.ok(text.includes(reason)); assert.doesNotMatch(text, /\d|\{/u);
  }
});
