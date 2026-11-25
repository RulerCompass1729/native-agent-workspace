const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { StewardWake, FILE, PATROL_MAX, patrolText } = require('../steward-wake.cjs');
const stewardRecords = require('../steward-record.cjs');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const { uiError } = require('../ui-errors.cjs');
const { Workspace } = require('../workspace.cjs');
const wake = require('../session-wake.cjs');

// R120 (PM brief 2026-11-23): with the event wake on and a patrol interval set, a butler idle that long while work is
// unfinished gets one 【NAW 巡查】 with counts only; unchanged work doubles the interval up to 4 hours. Synthetic data only.
const NOW = 1_800_000_000_000, MIN = 60000;
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };

class FakeClient extends EventEmitter {
  constructor(sessions, order) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [rules.CAPABILITY] };
    this.calls = []; this.order = order;
  }
  snapshot() { return structuredClone(this.state); }
  async refresh() { return this.snapshot(); }
  close() {}
  route(id) {
    if (!this.state.sessions.some(s => s.id === id)) throw Error('unknown session');
    return { client: this, state: { capabilities: [rules.CAPABILITY] } };
  }
  async call(method, ...args) {
    this.calls.push([method, ...args]);
    if (method === 'initial') return this.snapshot();
    if (method === 'dispatch') {
      this.order.push(['send', args[3]]);
      this.state.sessions.find(s => s.id === args[0]).state = 'working';
      return `tag-${this.calls.length}`;
    }
    throw Error(`unexpected ${method}`);
  }
  dispatches() { return this.calls.filter(call => call[0] === 'dispatch'); }
}
const base = { provider: 'claude', model: 'claude-test-model', state: 'idle', createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false,
  chatAvailable: true, liveDraft: '', serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [] };
const butler = (extra = {}) => ({ ...base, id: 'butler', name: 'Synthetic butler', nativeId: 'native-butler', roomIds: [], roomId: null, ...extra });
const member = (id, extra = {}) => ({ ...base, id, name: `SECRET member ${id}`, nativeId: `native-${id}`, roomIds: ['shared'], roomId: 'shared', ...extra });

function fixture(t, sessions = [butler()], options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-patrol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: NOW }, order = [];
  const env = { dir, clock, order, recordBroken: false };
  env.ledger = new ButlerLedger(dir, { now: () => clock.now });
  env.record = new stewardRecords.StewardRecord(dir, { steward: () => BUTLER, now: () => clock.now });
  env.wake = new StewardWake(dir, { ledger: () => env.ledger, selected: () => BUTLER, now: () => clock.now,
    record: line => { if (env.recordBroken) throw Error('PRIVATE RECORD ERROR'); order.push(['record', line.kind]); env.record.append(line); } });
  env.client = new FakeClient(sessions, order);
  env.roomState = new RoomState(dir);
  env.dispatcher = new rules.QueueDispatcher({ roomState: env.roomState, dataDir: dir, connect: async () => env.client, now: () => clock.now,
    settleMs: 8000, tickMs: 3600000, steward: () => ({ ...BUTLER, duty: '' }), stewardWake: env.wake, transcriptRoot: path.join(dir, 'none'), ...options });
  env.dispatcher.client = env.client;
  t.after(() => env.dispatcher.close());
  // The butler's turn ends now: idle from this moment, as the dispatcher's own view would record it.
  env.idleFrom = (at = clock.now) => { env.client.state.sessions.find(s => s.id === 'butler').state = 'idle'; env.dispatcher.idleSince.set('butler', at); };
  env.pass = (holding = []) => env.dispatcher.wakeSteward({ snapshot: env.dispatcher.roomState.apply(env.client.snapshot()), now: clock.now }, holding);
  env.patrols = () => env.client.dispatches().filter(call => call[4].startsWith('steward-patrol:'));
  env.queue = (text = 'SYNTHETIC ITEM TEXT', room = 'shared') => env.roomState.queueAdd(text, null, room);
  return env;
}
// Turned on by the person, patrol every `minutes`; idle from `idle` minutes ago.
function on(env, minutes = 30) { env.wake.set(true); env.wake.setPatrol(minutes); }

test('a migration quiet window: no patrol is due inside it, so none is shown as held; the idle time counts once it closes', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' })]);
  on(env, 30);
  env.dispatcher.quietWindows = { sessionIds: () => new Map([['butler', 'synthetic-window']]) };
  env.dispatcher.view();
  assert.equal(env.dispatcher.idleSince.get('butler'), NOW, 'idle in the window');
  for (const minutes of [31, 45]) { env.clock.now = NOW + minutes * MIN; await env.dispatcher.wakeSteward(env.dispatcher.view(), []); }
  assert.deepEqual(env.patrols(), []); assert.equal(env.wake.blocked, null);
  env.dispatcher.quietWindows = null;
  await env.dispatcher.wakeSteward(env.dispatcher.view(), []);
  assert.equal(env.patrols().length, 1);
});

test('open work and 30 idle minutes with no event: one patrol, its line written before the send, counts only', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' }), member('m2', { state: 'idle', approval: { id: 'synthetic-approval' } }),
    member('m3', { state: 'idle' }), member('m4', { state: 'working', archived: true })]);
  on(env);
  const room = env.roomState.create('SECRET space name');
  env.queue(); env.queue('SYNTHETIC ITEM TEXT 2', room);
  const sent = env.queue('SYNTHETIC SENT ITEM');
  env.roomState.queueMarkSent('shared', sent, 'm1', 'SECRET member m1', NOW, false, 'native-m1');
  const done = env.queue('SYNTHETIC DONE ITEM');
  env.roomState.queueMarkSent('shared', done, 'm3', 'SECRET member m3', NOW, false, 'native-m3');
  env.roomState.queueSettle('shared', done, 'done', '', 'SECRET member m3', 'PASS');
  env.roomState.value.archivedSessions.push('m4');
  env.idleFrom(NOW - 30 * MIN + 1); await env.pass();
  assert.equal(env.patrols().length, 0, 'a millisecond short of the interval');
  env.idleFrom(NOW - 30 * MIN); await env.pass();
  const patrols = env.patrols();
  assert.equal(patrols.length, 1);
  const [, id, text, nativeId, itemId] = patrols[0];
  assert.deepEqual([id, nativeId], ['butler', 'native-butler']);
  assert.match(itemId, /^steward-patrol:[0-9a-f-]{36}$/u);
  // Two sessions (working; approval), three items (two queued in two spaces, one sent); done, archived and idle do not count.
  assert.equal(text, patrolText(30, 2, 3));
  assert.equal(text, '【NAW 巡查】大管家已空闲至少 30 分钟，还有 5 件没结的活（2 个会话在跑或等批准，3 件在队列里）。用 workspace_control snapshot 看。');
  assert.doesNotMatch(text, /SECRET|SYNTHETIC|m1|m2|shared|stewardEvents/u, 'no name, item text, space or id');
  assert.deepEqual(env.order, [['record', 'patrol'], ['send', itemId], ['record', 'outcome']], 'the line comes first');
  const line = env.record.entries().find(entry => entry.kind === 'patrol');
  assert.deepEqual({ ...line, at: 0 }, { at: 0, kind: 'patrol', id: itemId.slice('steward-patrol:'.length), session: { id: 'butler', nativeId: 'native-butler' },
    minutes: 30, sessions: 2, items: 3, state: 'sent', error: null, operationId: line.operationId, recorded: true });
  assert.doesNotMatch(JSON.stringify(env.record.entries()), /SECRET|SYNTHETIC/u, 'the record keeps counts only');
  assert.deepEqual(stewardRecords.view(env.record, { sessions: [] }).entries,
    [{ at: line.at, kind: 'patrol', target: 'butler', minutes: 30, sessions: 2, items: 3, state: 'sent', error: null, recorded: true }]);
  assert.equal(env.client.calls.some(call => ['send', 'queue', 'claim', 'input'].includes(call[0])), false, 'no human send, no takeover');
  await env.pass();
  assert.equal(env.patrols().length, 1, 'the butler at work again is not called');
});

// The dispatcher's own passes (schedule): an active wake keeps them going, and the idle time survives until the patrol.
test('through the dispatcher passes themselves: a butler idle for the interval with a member at work gets one patrol', async t => {
  const env = fixture(t, [butler({ state: 'working' }), member('m1', { state: 'working' })]);
  await env.dispatcher.start();
  on(env, 30);
  assert.equal(env.dispatcher.hasOpenWork(), true, 'the active wake keeps the passes going');
  await env.dispatcher.schedule();
  env.client.state.sessions[0].state = 'idle'; env.client.emit('state', env.client.snapshot());
  await env.dispatcher.schedule();
  env.clock.now += 29 * MIN;
  await env.dispatcher.schedule();
  assert.equal(env.patrols().length, 0, 'not before the interval');
  env.clock.now += MIN;
  await env.dispatcher.schedule();
  assert.equal(env.patrols().length, 1);
  assert.equal(env.patrols()[0][2], patrolText(30, 1, 0));
  assert.equal(env.client.dispatches().length, 1, 'nothing else was sent');
});

test('no open work, or only items waiting on the person: no patrol', async t => {
  const env = fixture(t, [butler(), member('m1'), member('m2', { state: 'ended' })]);
  on(env);
  env.idleFrom(NOW - 240 * MIN); await env.pass();
  const item = env.queue();
  env.roomState.queueMarkSent('shared', item, 'm1', 'SECRET member m1', NOW, false, 'native-m1');
  env.roomState.queueSettle('shared', item, 'waiting', '', 'SECRET member m1', 'Needs your decision: synthetic');
  assert.equal(env.roomState.queueFind('shared', item).status, 'waiting');
  await env.pass();
  assert.deepEqual(env.client.dispatches(), []);
  assert.deepEqual(env.order, [], 'nothing recorded either');
  assert.equal(env.wake.view().blocked, undefined, 'nothing waits to go out, so nothing is shown as held');
});

test('the butler itself at work is not counted as open work', async t => {
  const env = fixture(t, [butler()]);
  on(env); env.idleFrom(NOW - 60 * MIN);
  assert.deepEqual(env.dispatcher.openWork({ snapshot: { sessions: [butler({ state: 'working' })] }, now: NOW }).sessions, 0);
  await env.pass();
  assert.deepEqual(env.client.dispatches(), []);
});

test('an event during idle goes first as an event wake; the patrol counts from the next idle', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' })]);
  on(env);
  env.idleFrom(NOW - 31 * MIN);
  env.ledger.ingest({ eventId: 'butler-source:1', sourceRef: 'queue-outcome:space-1:1', kind: 'failure', payload: { spaceId: 'space-1', itemId: 'item-1', reason: 'Synthetic' } });
  await env.pass();
  assert.deepEqual(env.client.dispatches().map(call => call[4].split(':')[0]), ['steward-wake'], 'the event, not the patrol');
  assert.equal(env.dispatcher.idleSince.has('butler'), false, 'sending ended its idle time');
  env.clock.now += 2 * MIN; env.idleFrom(); env.clock.now += 29 * MIN; await env.pass();
  assert.equal(env.patrols().length, 0, '29 minutes of the new idle');
  env.clock.now += MIN; await env.pass();
  assert.equal(env.patrols().length, 1);
  assert.equal(env.patrols()[0][2], patrolText(30, 1, 0));
});

test('unchanged work doubles the interval 30, 60, 120, 240 and stays at 240; a change starts again at 30', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' })]);
  on(env); env.queue();
  const minutes = [];
  for (const interval of [30, 60, 120, 240, 240]) {
    env.idleFrom(); env.clock.now += interval * MIN - 1; await env.pass();
    assert.equal(env.patrols().length, minutes.length, `not before ${interval} minutes`);
    env.clock.now += 1; await env.pass();
    assert.equal(env.patrols().length, minutes.length + 1, `at ${interval} minutes`);
    minutes.push(Number(/空闲至少 (\d+) 分钟/u.exec(env.patrols().at(-1)[2])[1]));
  }
  assert.deepEqual(minutes, [30, 60, 120, 240, 240]);
  assert.equal(PATROL_MAX, 240);
  // A session's state changing is a change: its id and state are in the hash, nothing else.
  env.client.state.sessions.find(s => s.id === 'm1').approval = { id: 'synthetic-approval' };
  env.idleFrom(); env.clock.now += 30 * MIN; await env.pass();
  assert.equal(env.patrols().at(-1)[2], patrolText(30, 1, 1));
  env.idleFrom(); env.clock.now += 30 * MIN; await env.pass();
  assert.equal(env.patrols().length, 6, 'unchanged again: 60 next');
  // Only ids and states count: another name for the same work is no change.
  env.client.state.sessions.find(s => s.id === 'm1').name = 'SECRET renamed';
  env.clock.now += 30 * MIN; await env.pass();
  assert.equal(env.patrols().length, 7);
  assert.equal(env.patrols().at(-1)[2], patrolText(60, 1, 1));
  // A new item is a change.
  env.queue('SYNTHETIC NEW ITEM');
  env.idleFrom(); env.clock.now += 30 * MIN; await env.pass();
  assert.equal(env.patrols().at(-1)[2], patrolText(30, 1, 2));
});

test('patrol off, wake off, a butler on DeepSeek, in a space or rotating: no patrol', async t => {
  const cases = [
    ['patrol off', [butler()], env => env.wake.setPatrol(null)],
    ['wake off', [butler()], env => env.wake.set(false)],
    ['wake off and on again', [butler()], env => { env.wake.set(false); env.wake.set(true); }],
    ['on DeepSeek', [butler({ model: 'deepseek-v4-pro' })], () => {}],
    ['codex on DeepSeek', [butler({ provider: 'codex', model: null, nativeSettings: { model: 'deepseek-v4-flash' } })], () => {}],
    ['in a space', [butler({ roomIds: ['shared'], roomId: 'shared' })], () => {}],
    ['rotating', [butler()], env => { env.dispatcher.rotations = { butler: { phase: 'requested' } }; }],
    ['held by the integration engine', [butler()], env => { env.holding = ['butler']; }],
    ['automatic messages off', [butler()], env => { env.client.state.wakePolicy = { enabled: false }; }],
    ['the person typing to it', [butler({ liveDraft: 'SECRET half a sentence' })], () => {}],
  ];
  for (const [name, sessions, arrange] of cases) {
    const env = fixture(t, [...sessions, member('m1', { state: 'working' })]);
    on(env); env.queue();
    arrange(env);
    env.idleFrom(NOW - 240 * MIN); await env.pass(env.holding);
    env.clock.now += 10 * MIN; await env.pass(env.holding);
    assert.deepEqual(env.patrols(), [], name);
    assert.equal(env.record.entries().some(entry => entry.kind === 'patrol'), false, name);
    if (rotating(name)) assert.equal(env.wake.view().blocked?.reason, 'engaged', `${name}: held, shown with the existing banner`);
  }
  function rotating(name) { return name === 'rotating' || name === 'held by the integration engine'; }
});

test('a held patrol is shown with the existing banner after ten minutes, and clears once it goes out', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' })]);
  on(env); env.idleFrom(NOW - 30 * MIN);
  await env.pass(['butler']);
  assert.equal(env.wake.view().blocked, undefined, 'not yet ten minutes');
  env.clock.now += 10 * MIN; await env.pass(['butler']);
  assert.deepEqual(env.wake.view().blocked, { since: NOW, reason: 'engaged', minutes: 10 });
  assert.deepEqual(env.record.entries().filter(entry => entry.kind === 'wakeBlocked').map(entry => entry.reason), ['engaged']);
  await env.pass();
  assert.equal(env.patrols().length, 1);
  assert.equal(env.wake.view().blocked, undefined);
});

test('the minute between wakes holds for a patrol, and a patrol line that cannot be written is not sent', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' })]);
  on(env);
  env.ledger.ingest({ eventId: 'butler-source:1', sourceRef: 'queue-outcome:space-1:1', kind: 'failure', payload: { spaceId: 'space-1', itemId: 'item-1', reason: 'Synthetic' } });
  env.idleFrom(NOW - 9000); await env.pass();
  assert.equal(env.client.dispatches().length, 1, 'the event wake');
  env.idleFrom(NOW - 30 * MIN); env.clock.now += 59999; await env.pass();
  assert.equal(env.patrols().length, 0, 'within the minute');
  env.recordBroken = true; env.clock.now += 1; await env.pass();
  assert.equal(env.patrols().length, 0, 'no line, no send');
  env.recordBroken = false; await env.pass();
  assert.equal(env.patrols().length, 1);
});

test('a patrol not known to have arrived is recorded so and tried again on a later pass', async t => {
  const env = fixture(t, [butler(), member('m1', { state: 'working' })]);
  on(env); env.idleFrom(NOW - 30 * MIN);
  const call = env.client.call.bind(env.client);
  env.client.call = async (method, ...args) => { if (method === 'dispatch') throw Object.assign(Error('SYNTHETIC refused'), { notSent: true }); return call(method, ...args); };
  await env.pass();
  assert.deepEqual(env.record.entries().filter(entry => entry.kind === 'patrol').map(entry => entry.state), ['not-sent']);
  env.client.call = call; env.clock.now += MIN; await env.pass();
  assert.equal(env.patrols().length, 1);
  assert.equal(env.patrols()[0][2], patrolText(30, 1, 0), 'a failed patrol does not double the interval');
});

// The streak budget (session-wake.cjs MAX_STREAK) bounds agent-to-agent wakes; NAW's own send, a queue item's path,
// is not one of them, so a butler whose senders reached three still gets the patrol.
test('a butler session whose sender streak is at the limit still receives the patrol', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-patrol-ws-'));
  const sent = [];
  const host = { binaries: {}, close() {}, create(record) {
    const runtime = new EventEmitter();
    runtime.send = async (text, tag, guard) => { assert.ok(guard()); sent.push({ id: record.id, text, tag }); };
    runtime.start = async () => runtime.emit('state', 'idle');
    return runtime;
  } };
  const w = new Workspace(host, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const id = await w.create('claude', directory, 'person', 'Synthetic butler');
  const s = w.sessions.get(id);
  s.wakeBudget = { version: 2, lastAt: Date.now() - 2 * wake.COOLDOWN, humanRevision: s.wakeHumanRevision || 0, senders: { 'native-sender': { id: 'earlier', streak: wake.MAX_STREAK } } };
  assert.equal(wake.budgetAllows(s, 'next', 'sender', 'native-sender'), false, 'an agent sender is at its limit');
  const text = patrolText(30, 1, 2), itemId = `steward-patrol:${randomUUID()}`;
  const tag = await w.send(id, text, 'naw-dispatcher', null, null, null, null, null, null, null, { itemId });
  assert.deepEqual(sent.map(x => [x.id, x.text]), [[id, text]]);
  const row = w.get(id).messages.find(m => m.id === tag);
  assert.deepEqual([row.origin, row.dispatchItem], ['naw-dispatch', itemId]);
  assert.equal(w.sessions.get(id).wakeBudget.senders['native-sender'].streak, wake.MAX_STREAK, 'the agent streak is left as it was');
});

test('the interval is one of off, 15, 30 or 60, only while the wake is on; it is saved, and a file from before patrol reads as off', t => {
  const env = fixture(t);
  assert.deepEqual(env.wake.view(), { on: false, at: null, failed: false });
  assert.throws(() => env.wake.setPatrol(30), { code: 'STEWARD_PATROL_WAKE_OFF' });
  assert.deepEqual(env.wake.setPatrol(null), { on: false, at: null, failed: false }, 'off needs nothing');
  env.wake.set(true);
  assert.equal(env.wake.view().patrol, undefined, 'off by default');
  for (const bad of [0, 45, 240, '30', true, undefined, 30.5, -15]) assert.throws(() => env.wake.setPatrol(bad), { code: 'STEWARD_PATROL_INVALID' }, String(bad));
  const keys = () => Object.keys(JSON.parse(fs.readFileSync(path.join(env.dir, FILE), 'utf8'))).sort().join(',');
  assert.equal(keys(), 'at,designation,on,version,woken', 'with patrol off an earlier version still reads the file');
  for (const minutes of [15, 60, 30]) assert.equal(env.wake.setPatrol(minutes).patrol, minutes);
  assert.equal(keys(), 'at,designation,on,patrol,version,woken');
  const reopened = new StewardWake(env.dir, { ledger: () => env.ledger, selected: () => BUTLER, now: () => env.clock.now, record: () => {} });
  assert.equal(reopened.view().patrol, 30, 'survives a restart');
  assert.equal(env.wake.set(false).patrol, undefined, 'turning the wake off turns the patrol off');
  assert.equal(env.wake.set(true).patrol, undefined, 'and on again leaves it off');
  assert.equal(keys(), 'at,designation,on,version,woken');
  const file = path.join(env.dir, FILE), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.patrol; fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  const old = new StewardWake(env.dir, { ledger: () => env.ledger, selected: () => BUTLER, now: () => env.clock.now, record: () => {} });
  assert.deepEqual([old.view().on, old.view().failed, old.view().patrol], [true, false, undefined]);
  for (const bad of [{ ...saved, patrol: 45 }, { ...saved, on: false, designation: null, woken: null, patrol: 30 }]) {
    fs.writeFileSync(file, JSON.stringify(bad), { mode: 0o600 });
    const broken = new StewardWake(env.dir, { ledger: () => env.ledger, selected: () => BUTLER, now: () => env.clock.now, record: () => {} });
    assert.deepEqual([broken.view().on, broken.view().failed], [false, true]);
  }
});

// main.cjs stewardPatrol: the same two callers as the wake switch.
function handler({ isButler = true, person = true, wake: target } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  register('stewardPatrol'"), end = source.indexOf("  // What the butler reads to report to the person only what is new", start);
  assert.ok(start > 0 && end > start);
  let registered;
  vm.runInContext(source.slice(start, end), vm.createContext({
    register: (name, fn) => { assert.equal(name, 'stewardPatrol'); registered = fn; },
    stewardCaller: async c => (c.background && isButler ? { id: 'butler', name: 'Synthetic butler' } : null),
    isCurrentHumanContext: c => !c.background && person, stewardWake: target, uiError,
  }));
  return { agent: (...args) => registered({ background: true }, ...args), person: (...args) => registered({ background: false }, ...args) };
}
const refusal = key => error => error?.uiMessage?.key === key;

test('only the person in their window and the designated butler change the interval, to one of the four values', async t => {
  const changes = [], target = { view: () => ({ on: true, patrol: 30 }), setPatrol: minutes => { changes.push(minutes); return { on: true, patrol: minutes }; } };
  await assert.rejects(handler({ isButler: false, wake: target }).agent(30), refusal('error.steward.wakeOnly'), 'a background member');
  await assert.rejects(handler({ isButler: false, wake: target }).agent(), refusal('error.steward.wakeOnly'));
  await assert.rejects(handler({ person: false, wake: target }).person(30), refusal('error.steward.wakeOnly'), 'not the person\'s current window');
  for (const bad of [45, '30', true, 0, 240, undefined]) await assert.rejects(handler({ wake: target }).agent(bad), refusal('error.steward.patrolInvalid'), String(bad));
  await assert.rejects(handler({ wake: target }).agent(30, 1), refusal('error.steward.patrolInvalid'));
  assert.deepEqual(changes, [], 'a refused call changes nothing');
  assert.deepEqual(await handler({ wake: target }).agent(15), { on: true, patrol: 15 });
  assert.deepEqual(await handler({ wake: target }).person(null), { on: true, patrol: null });
  assert.deepEqual(await handler({ wake: target }).person(60), { on: true, patrol: 60 });
  assert.deepEqual(await handler({ wake: target }).agent(), { on: true, patrol: 30 }, 'no argument only says how it stands');
  assert.deepEqual(changes, [15, null, 60]);
  await assert.rejects(handler({ wake: null }).person(30), refusal('error.steward.wakeUnavailable'));
  const env = fixture(t);
  await assert.rejects(handler({ wake: env.wake }).person(30), refusal('error.steward.patrolWakeOff'));
  env.wake.set(true);
  assert.equal((await handler({ wake: env.wake }).person(30)).patrol, 30);
});

test('the interval is a local call the butler finds in the catalog and the page can reach', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const local = main.slice(main.indexOf('const local = new Set(['), main.indexOf(']);', main.indexOf('const local = new Set([')));
  assert.ok(local.includes("'stewardPatrol'"));
  assert.ok(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8').includes("'stewardPatrol'"));
  const { BackgroundControl } = require('../background-control.cjs');
  const entry = new BackgroundControl({ dataDir: os.tmpdir(), handlers: new Map([['stewardPatrol', () => null]]) }).catalog().find(item => item.method === 'stewardPatrol');
  assert.match(entry.parameters[0], /null[\s\S]*15[\s\S]*30[\s\S]*60[\s\S]*【NAW 巡查】[\s\S]*4 hours/u);
});

test('the record takes a patrol line only as NAW writes it, and shows the butler\'s own interval calls', t => {
  const line = { kind: 'patrol', at: NOW, id: 'p1', session: { id: 'butler', nativeId: 'native-butler' }, minutes: 30, sessions: 2, items: 0 };
  stewardRecords.check(line);
  for (const bad of [{ ...line, text: 'SECRET' }, { ...line, minutes: undefined }, { ...line, sessions: -1 }, { ...line, items: 1.5 }, { ...line, session: { id: 'butler' } }, { ...line, id: '' }])
    assert.throws(() => stewardRecords.check(bad), /Invalid steward record line/u);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-patrol-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = new stewardRecords.StewardRecord(dir, { steward: () => BUTLER, now: () => NOW });
  const step = args => record.append({ kind: 'step', id: randomUUID(), session: { id: 'butler', nativeId: 'native-butler', provider: 'claude', name: 'Synthetic butler' },
    action: 'invoke', method: 'stewardPatrol', arguments: JSON.stringify(args), operationId: null });
  step([]); step([null]); step([30]); step([45]);
  const shown = stewardRecords.view(record, { sessions: [] }).entries.map(entry => JSON.stringify(Object.hasOwn(entry, 'patrol') ? entry.patrol : 'none'));
  assert.deepEqual(shown.sort(), ['"check"', '"none"', '30', 'null'], 'looked, off, 30; a value it does not take shows none');
  const wake = stewardRecords.view(record, { sessions: [] }, { wake: { on: true, at: NOW, failed: false, patrol: 60 } }).wake;
  assert.deepEqual(wake, { on: true, at: NOW, failed: false, patrol: 60 });
  assert.deepEqual(stewardRecords.view(record, { sessions: [] }, { wake: { on: true, at: NOW, failed: false } }).wake, { on: true, at: NOW, failed: false });
});

// alpha.289 integration: the butler's own unresolved handoff (R117/R129, steward-wake.cjs hold) holds the patrol as it
// holds an event wake; once the person's step resolves it, the patrol goes out.
test('a butler held by its own unresolved handoff gets no patrol, and gets one once the handoff is resolved', async t => {
  const episode = { nativeId: 'native-butler', epoch: 'epoch-a', tag: 'tag-a', state: 'invalid' };
  const env = fixture(t, [butler({ rotationEpisode: { ...episode } }), member('m1', { state: 'working' })]);
  on(env); env.queue();
  env.idleFrom(NOW - 240 * MIN); await env.pass();
  assert.deepEqual(env.patrols(), [], 'held');
  assert.deepEqual([env.wake.view().blocked?.reason, env.wake.view().blocked?.step], ['rotation-control-unresolved', 'release']);
  env.client.state.sessions.find(s => s.id === 'butler').rotationEpisode.state = 'released';
  await env.pass();
  assert.equal(env.patrols().length, 1, 'the patrol once the handoff is resolved');
  assert.equal(env.wake.view().blocked, undefined);
});
