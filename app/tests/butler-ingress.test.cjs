'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ButlerIngress, queueOutcomeSource, bindQueueOutcomes } = require('../butler-ingress.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { RoomState } = require('../room-state.cjs');
const { QueueDispatcher, queueVacancies, CAPABILITY } = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-ingress-'));
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const room = new RoomState(directory), ledger = new ButlerLedger(directory);
  return { directory, room, ledger, ingress: new ButlerIngress(directory, { roomState: room, ledger }) };
}
function exhaustedRecovery(extra = {}) {
  return { id: 'agent-a', provider: 'claude', nativeId: 'native-a', state: 'error', liveDraft: '',
    terminalState: { alive: true }, capacityRecovery: { nativeId: 'native-a', turnId: 'failed-a', reason: 'connection', status: 'exhausted', attempt: 3, due: 0 }, ...extra };
}
for (const [provider, reason, state] of [['claude', 'connection', 'error'], ['claude', 'capacity', 'error'], ['claude', 'forbidden', 'error'], ['codex', 'capacity', 'idle'], ['codex', 'routing', 'idle'], ['codex', 'capacity', 'error'], ['codex', 'routing', 'error']])
test(`a current exhausted ${provider}/${reason}/${state} reaches the existing failure ledger once, including after ingress restart`, t => {
  const f = fixture(t), member = exhaustedRecovery({ provider, state, ...(provider === 'codex' ? { terminalState: null } : {}) });
  member.capacityRecovery.reason = reason;
  f.ingress.observeRecoveryFailures([member]);
  const events = f.ledger.eventsAfter(null).events;
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'failure');
  assert.deepEqual(events[0].payload, { memberId: member.id, reason: `${reason}-retry-exhausted` });
  const bytes = fs.readFileSync(f.ledger.file);
  f.ingress.observeRecoveryFailures([member]);
  const restored = new ButlerIngress(f.directory, { roomState: f.room }); restored.observeRecoveryFailures([member]);
  assert.deepEqual(fs.readFileSync(f.ledger.file), bytes, 'Duplicate live snapshots never rewrite or requeue the episode');
  assert.equal(restored.ledger.eventsAfter(null).events.length, 1);
  restored.observeRecoveryFailures([exhaustedRecovery({ nativeId: 'native-b' })]);
  assert.equal(restored.ledger.eventsAfter(null).events.length, 1, 'The old native binding is rejected');
  restored.observeRecoveryFailures([{ ...member, capacityRecovery: { ...member.capacityRecovery, turnId: 'failed-b' } }]);
  assert.equal(restored.ledger.eventsAfter(null).events.length, 2, 'A different current failed turn is a new episode');
  const later = fs.readFileSync(restored.ledger.file);
  restored.observeRecoveryFailures([member]);
  assert.deepEqual(fs.readFileSync(restored.ledger.file), later, 'Delayed older snapshots do not re-record either episode');
});
test('the connection-only intake record still deduplicates after the shared intake upgrade', t => {
  const f = fixture(t), member = exhaustedRecovery();
  const identity = require('node:crypto').createHash('sha256').update(JSON.stringify([member.id, member.nativeId, member.capacityRecovery.turnId])).digest('hex');
  f.ingress.record({ eventId: `connection-exhausted:${identity}`, sourceRef: `connection-exhausted:${member.id}`, kind: 'failure', payload: { memberId: member.id, reason: 'connection-retry-exhausted' } });
  const bytes = fs.readFileSync(f.ledger.file), restored = new ButlerIngress(f.directory, { roomState: f.room });
  restored.observeRecoveryFailures([member]); assert.deepEqual(fs.readFileSync(restored.ledger.file), bytes);
});
for (const [label, change] of [
  ['another provider', { provider: 'codex' }], ['working', { state: 'working' }], ['idle', { state: 'idle' }],
  ['archived', { archived: true }], ['backend ended', { backendUnavailable: true }], ['disconnected', { transportDisconnected: true }],
  ['new context', { nativeContextPending: {} }], ['new input', { pendingTag: 'new-input' }], ['new native turn', { activeTurnId: 'new-turn' }],
  ['draft', { liveDraft: 'Unsent private words' }], ['approval', { approval: {} }], ['native approval', { nativeApproval: {} }],
  ['native input boundary', { nativeInputRequired: true }], ['not alive', { terminalState: { alive: false } }],
]) test('connection exhaustion cannot create a stale failure through ' + label, t => {
  const f = fixture(t); f.ingress.observeRecoveryFailures([exhaustedRecovery(change)]);
  assert.deepEqual(f.ledger.eventsAfter(null).events, []);
});
for (const change of [{ nativeId: 'old-native' }, { turnId: '' }, { attempt: 2 }, { attempt: '3' }, { status: 'scheduled' },
  { reason: 'Capacity' }, { reason: 'unknown' }, { reason: 'other' }, { reason: '__proto__' }, { reason: 'constructor' }, { due: 1 }])
test('only an exact current supported exhaustion descriptor is a failure: ' + JSON.stringify(change), t => {
  const f = fixture(t), row = exhaustedRecovery(); row.capacityRecovery = { ...row.capacityRecovery, ...change };
  f.ingress.observeRecoveryFailures([row]); assert.deepEqual(f.ledger.eventsAfter(null).events, []);
});
function settle(room, status = 'waiting', reason = '', question = 'Approve the synthetic change?') {
  const itemId = room.queueAdd('Synthetic task', null);
  room.queueMarkSent('shared', itemId, 'agent-a', 'Synthetic agent', NOW);
  room.queueSettle('shared', itemId, status, reason, 'Synthetic agent', '', question);
  return { itemId, event: room.value.events.at(-1) };
}
function ready(extra = {}) {
  return { id: 'agent-a', name: 'Synthetic agent', provider: 'codex', nativeId: 'native-a',
    model: 'synthetic-model', state: 'idle', roomId: 'shared', roomIds: ['shared'],
    createdAt: NOW - 1000, background: 0, scheduled: 0, backgroundStale: false,
    chatAvailable: true, liveDraft: '', serviceCapabilities: [CAPABILITY], fleet: [], messages: [], ...extra };
}
function vacancyInput(extra = {}) {
  return { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [] }], sessions: [ready()],
    wakePolicy: { enabled: true }, idleSince: new Map([['agent-a', NOW - 10000]]),
    humanAt: new Map(), now: NOW, settleMs: 1000, ...extra };
}
function passiveWindow(t, f, options = {}) {
  const client = new EventEmitter(), projections = []; let time = NOW, reads = 0;
  client.state = { sessions: [ready()], rooms: [{ id: 'shared', messages: [], run: null }], wakePolicy: { enabled: true } };
  client.snapshot = () => { reads++; return structuredClone(client.state); }; client.close = () => {};
  client.call = () => { throw Error('Unexpected native action during passive maintenance'); };
  const dispatcher = new QueueDispatcher({ roomState: f.room, dataDir: f.directory, clients: () => client,
    now: () => time, sampleProcesses: async () => '', samplePressure: async () => '',
    observeQueueState: states => { projections.push(states); f.ingress.observeQueues(states); }, ...options });
  t.after(() => dispatcher.close());
  return { client, dispatcher, projections, reads: () => reads,
    tick: elapsed => { time = NOW + elapsed; return dispatcher.tick(); } };
}

for (const notification of ['unsupported', 'throws']) test(`B1 facts persist when its notification is ${notification}`, t => {
  const f = fixture(t); let notified = 0;
  bindQueueOutcomes(f.room, f.ingress, () => { notified++; if (notification === 'throws') throw Error('Synthetic notification unavailable'); });
  const decision = settle(f.room), state = f.ledger.snapshot();
  assert.equal(notified, 1); assert.ok(decision.event.butlerSource);
  assert.equal(state.questions.length, 1); assert.equal(state.questions[0].status, 'open');
  assert.equal(state.questions[0].text, 'Approve the synthetic change?');
  assert.equal(state.deliveries.length, 1); assert.equal(state.deliveries[0].status, 'unknown');
  assert.deepEqual(state.pendingEvents, []); assert.equal(state.events[0].kind, 'decision');
  settle(f.room, 'failed', 'Synthetic failure');
  const restored = new ButlerLedger(f.directory).snapshot();
  assert.deepEqual(restored.events.map(e => e.kind), ['decision', 'failure']);
  assert.deepEqual(restored.pendingEvents, []); assert.equal(restored.questions.length, 1);
  assert.deepEqual(f.ingress.status(), { intake: 'ready', errorCode: null, activation: 'off', recordPeriod: 'off' });
});

test('a source committed before a failed callback recovers one question and never creates another delivery', t => {
  const f = fixture(t);
  f.room.onQueueOutcome = () => { throw Error('Synthetic interruption before intake'); };
  const { event } = settle(f.room); assert.equal(f.ledger.snapshot().events.length, 0);
  const room = new RoomState(f.directory), ledger = new ButlerLedger(f.directory);
  const restored = new ButlerIngress(f.directory, { roomState: room, ledger });
  assert.deepEqual(restored.recover(), { status: 'recorded', count: 1 });
  const saved = ledger.snapshot(), bytes = fs.readFileSync(ledger.file);
  assert.equal(saved.events[0].eventId, event.butlerSource.eventId);
  assert.equal(saved.questions.length, 1); assert.equal(saved.deliveries[0].status, 'unknown');
  assert.deepEqual(saved.pendingEvents, []);
  restored.recover(); restored.captureOutcome('shared', event.id);
  assert.deepEqual(ledger.snapshot(), saved); assert.deepEqual(fs.readFileSync(ledger.file), bytes);
});

test('a ledger intake failure retains the durable source and recovers without losing the B1 notification', t => {
  const f = fixture(t); let notified = 0;
  t.mock.method(f.ledger, 'ingest', () => { throw Error('Synthetic intake failure'); });
  bindQueueOutcomes(f.room, f.ingress, () => { notified++; });
  const { event } = settle(f.room); assert.equal(notified, 1);
  assert.deepEqual(f.ingress.status(), { intake: 'blocked', errorCode: 'source-unavailable', activation: 'off', recordPeriod: 'off' });
  assert.ok(new RoomState(f.directory).butlerSources().some(source => source.eventId === event.butlerSource.eventId));
  t.mock.restoreAll();
  const ledger = new ButlerLedger(f.directory), ingress = new ButlerIngress(f.directory, { roomState: new RoomState(f.directory), ledger });
  ingress.recover(); ingress.recover();
  assert.equal(ledger.snapshot().questions.length, 1); assert.equal(ledger.snapshot().deliveries.length, 1);
  assert.equal(ledger.snapshot().deliveries[0].status, 'unknown'); assert.deepEqual(ledger.pendingEvents(), []);
  assert.equal(ingress.status().intake, 'ready');
});

test('ordinary done and reasoned waiting outcomes are not promoted to READY or a new question', t => {
  const f = fixture(t); let notified = 0;
  bindQueueOutcomes(f.room, f.ingress, () => { notified++; });
  settle(f.room, 'done'); settle(f.room, 'waiting', 'person-intervened');
  f.ingress.recover();
  assert.equal(notified, 0); assert.deepEqual(f.room.butlerSources(), []);
  assert.deepEqual(f.ledger.snapshot().events, []); assert.deepEqual(f.ledger.snapshot().reports, []);
  assert.equal(queueOutcomeSource({ status: 'done', roomId: 'shared', eventId: 'finished', itemId: 'task' }), null);
  assert.equal(queueOutcomeSource({ status: 'waiting', reason: 'no-reply' }), null);
});

test('queue vacancy observations survive restart and create work only on a new empty episode', t => {
  const f = fixture(t), state = [{ roomId: 'shared', name: 'Synthetic team', active: true }];
  f.ingress.observeQueues(state); f.ingress.observeQueues(state);
  const first = f.ledger.snapshot().events[0], bytes = fs.readFileSync(f.ledger.file);
  const ledger = new ButlerLedger(f.directory), restored = new ButlerIngress(f.directory, { roomState: new RoomState(f.directory), ledger });
  restored.observeQueues(state); assert.deepEqual(fs.readFileSync(ledger.file), bytes);
  assert.equal(ledger.pendingEvents().length, 1); assert.equal(first.kind, 'queue-empty');
  restored.observeQueues([{ ...state[0], active: false }]); restored.observeQueues(state);
  const events = ledger.pendingEvents(); assert.equal(events.length, 2); assert.notEqual(events[0].eventId, events[1].eventId);
  assert.equal(ledger.snapshot().sourceStates[0].generation, 2);
  assert.equal(restored.status().activation, 'off'); assert.equal(restored.status().recordPeriod, 'off');
});

test('queue vacancies require an actually ready unoccupied member and an empty live queue', () => {
  assert.deepEqual(queueVacancies(vacancyInput()), [{ roomId: 'shared', name: 'Synthetic team', active: true, availableIds: ['agent-a'], candidateIds: ['agent-a'] }]);
  const cases = [
    { sessions: [ready({ state: 'working' })] },
    { sessions: [ready({ liveDraft: 'Synthetic private draft' })] },
    { sessions: [ready({ nativeContextPending: true })] },
    { sessions: [ready({ backgroundStale: true })] },
    { sessions: [ready({ nativeGoal: { status: 'active' } })] },
    { sessions: [ready({ roomId: null, roomIds: [] })] },
    { sessions: [] }, { wakePolicy: { enabled: false } },
    { humanAt: new Map([['agent-a', NOW - 1]]) },
    { idleSince: new Map([['agent-a', NOW]]) },
    { rooms: [{ id: 'shared', name: 'Synthetic team', archived: true, queue: [] }] },
    { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [{ status: 'queued' }] }] },
    { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [{ status: 'sent' }] }] },
    { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [], run: { status: 'running', ids: ['agent-a'] } }] },
    { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [] }, { id: 'other', queue: [], run: { status: 'running', ids: ['agent-a'] } }] },
    { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [] }, { id: 'other', queue: [{ status: 'sent', sentTo: 'agent-a' }] }] },
    { rotations: { 'agent-a': { phase: 'created' } } },
    { rotations: { previous: { phase: 'created', newId: 'agent-a' } } },
    { actions: [{ kind: 'dispatch', sessionId: 'agent-a' }] },
    { actions: [{ kind: 'rotate', sessionId: 'agent-a' }] },
  ];
  for (const changes of cases) assert.equal(queueVacancies(vacancyInput(changes))[0].active, false);
  assert.equal(queueVacancies(vacancyInput({ rooms: [{ id: 'shared', name: 'Synthetic team', queue: [{ status: 'done' }] }] }))[0].active, true);
  // An item left for the person to look at, the person having stepped in or no reply having come back,
  // asks nothing of its member, here or in another space: the space is empty (11-12). Nor does a decision
  // (11-13), one whose item kept an earlier refusal (queueRequeue) included: the person answers it while
  // the member takes more work.
  for (const reason of ['person-intervened', 'no-reply', undefined, 'Synthetic refusal']) {
    for (const rooms of [[{ id: 'shared', name: 'Synthetic team', queue: [{ status: 'waiting', reason, sentTo: 'agent-a' }] }],
      [{ id: 'shared', name: 'Synthetic team', queue: [] }, { id: 'other', queue: [{ status: 'waiting', reason, sentTo: 'agent-a' }] }]]) {
      assert.equal(queueVacancies(vacancyInput({ rooms }))[0].active, true, reason);
    }
  }
});

test('vacancy capacity identifies an additional eligible member while an empty room is already active', () => {
  const first = queueVacancies(vacancyInput())[0];
  const second = queueVacancies(vacancyInput({ sessions: [ready({ id: 'agent-b', nativeId: 'native-b' }), ready()],
    idleSince: new Map([['agent-a', NOW - 10000], ['agent-b', NOW - 10000]]) }))[0];
  assert.equal(first.active, true); assert.equal(second.active, true);
  assert.deepEqual(first.availableIds, ['agent-a']); assert.deepEqual(second.availableIds, ['agent-a', 'agent-b']);
  const settling = queueVacancies(vacancyInput({ idleSince: new Map() }))[0];
  assert.equal(settling.active, false); assert.deepEqual(settling.availableIds, []); assert.deepEqual(settling.candidateIds, ['agent-a']);
});

test('the real dispatcher forwards only vacancy facts without starting native work or another connection', async t => {
  const f = fixture(t), client = new EventEmitter(); let time = NOW, connects = 0;
  client.state = { sessions: [ready()], rooms: [{ id: 'shared', messages: [], run: null }], wakePolicy: { enabled: true } };
  client.snapshot = () => structuredClone(client.state); client.close = () => {};
  client.call = () => { throw Error('Unexpected native action in passive intake'); };
  const projections = [], dispatcher = new QueueDispatcher({ roomState: f.room, dataDir: f.directory,
    clients: () => client, connect: () => { connects++; throw Error('Unexpected second connection'); },
    now: () => time, settleMs: 0, sampleProcesses: async () => '', samplePressure: async () => '',
    observeQueueState: states => { projections.push(states); f.ingress.observeQueues(states); } });
  t.after(() => dispatcher.close());
  await dispatcher.tick(); time += 60001; await dispatcher.tick();
  assert.equal(connects, 0); assert.equal(projections.length, 2);
  assert.deepEqual(projections[0], [{ roomId: 'shared', name: f.room.value.name, active: true, availableIds: ['agent-a'], candidateIds: ['agent-a'] }]);
  assert.equal(f.ledger.pendingEvents().length, 1); assert.equal(f.ledger.pendingEvents()[0].kind, 'queue-empty');
  const noHook = fixture(t), ordinary = new QueueDispatcher({ roomState: noHook.room, dataDir: noHook.directory,
    clients: () => client, now: () => time, settleMs: 0, sampleProcesses: async () => '', samplePressure: async () => '' });
  t.after(() => ordinary.close()); await ordinary.tick(); assert.equal(noHook.ledger.snapshot().events.length, 0);
});

test('default settle time records one vacancy through ordinary empty-queue maintenance ticks', async t => {
  const f = fixture(t), window = passiveWindow(t, f);
  for (let elapsed = 0; elapsed <= 120000; elapsed += 3000) await window.tick(elapsed);
  assert.equal(f.ledger.snapshot().events.filter(event => event.kind === 'queue-empty').length, 1);
});

test('a restarted default dispatcher preserves its existing vacancy while fresh readiness settles', async t => {
  const f = fixture(t), first = passiveWindow(t, f);
  for (let elapsed = 0; elapsed <= 120000; elapsed += 3000) await first.tick(elapsed);
  first.dispatcher.close();
  const room = new RoomState(f.directory), ledger = new ButlerLedger(f.directory);
  const restored = { ...f, room, ledger, ingress: new ButlerIngress(f.directory, { roomState: room, ledger }) };
  const second = passiveWindow(t, restored), before = ledger.snapshot().events;
  for (let elapsed = 0; elapsed <= 120000; elapsed += 3000) await second.tick(elapsed);
  assert.equal(before.length, 1); assert.deepEqual(ledger.snapshot().events, before);
});

test('passive readiness resets for cached work, background, source absence, identity and human activity', async t => {
  for (const cause of ['work', 'background', 'absence', 'identity', 'human']) {
    const f = fixture(t), window = passiveWindow(t, f), session = window.client.state.sessions[0];
    await window.tick(0); await window.tick(3000);
    if (cause === 'work') session.state = 'working';
    if (cause === 'background') session.background = 1;
    if (cause === 'absence') window.client.state.sessions = [];
    let historyReads = 0;
    Object.defineProperty(session, 'messages', { configurable: true, get() { historyReads++; return []; } });
    window.client.emit('state', window.client.state); await window.tick(6000);
    assert.equal(window.reads(), 1, 'Skipped maintenance uses the existing state event, with no extra snapshot');
    await window.tick(57000); session.state = 'idle'; session.background = 0; window.client.state.sessions = [session];
    if (cause === 'identity') session.nativeId = 'replacement-native';
    if (cause === 'human') window.dispatcher.noteHuman(session.id);
    window.client.emit('state', window.client.state);
    assert.equal(historyReads, 0, `Passive observation must not read private history: ${cause}`);
    delete session.messages; session.messages = [];
    await window.tick(60000);
    assert.equal(window.projections.at(-1)[0].active, false, cause);
    assert.deepEqual(f.ledger.pendingEvents(), [], cause);
    for (const elapsed of [120000, 180000, 240000]) await window.tick(elapsed);
    assert.equal(f.ledger.pendingEvents().length, 1, cause);
  }
});

test('without a vacancy observer ordinary skipped maintenance adds no cached reads', async t => {
  const f = fixture(t), window = passiveWindow(t, f, { observeQueueState: null });
  for (let elapsed = 0; elapsed <= 120000; elapsed += 3000) await window.tick(elapsed);
  assert.equal(window.reads(), 3); assert.deepEqual(f.ledger.snapshot().events, []);
});

test('a member dispatched in another space in the same pass is not reported as spare capacity', async t => {
  const f = fixture(t), otherId = f.room.create('Another synthetic team');
  f.room.queueAdd('Another synthetic task', null, otherId);
  const client = new EventEmitter(), calls = [], projections = [];
  client.state = { sessions: [ready({ roomIds: ['shared', otherId] })],
    rooms: [{ id: 'shared', messages: [], run: null }, { id: otherId, messages: [], run: null }],
    wakePolicy: { enabled: true }, capabilities: [CAPABILITY] };
  client.snapshot = () => structuredClone(client.state); client.refresh = async () => client.snapshot(); client.close = () => {};
  client.route = () => ({ client, state: { capabilities: [CAPABILITY] } });
  client.call = async (method, ...args) => {
    assert.equal(method, 'dispatch'); calls.push([method, ...args]);
    const member = client.state.sessions[0]; member.state = 'working';
    member.messages.push({ id: 'synthetic-tag', role: 'user', text: args[1], origin: 'naw-dispatch', status: 'submitted' });
    return 'synthetic-tag';
  };
  const dispatcher = new QueueDispatcher({ roomState: f.room, dataDir: f.directory, clients: () => client,
    now: () => NOW, settleMs: 0, sampleProcesses: async () => '', samplePressure: async () => '',
    observeQueueState: states => { projections.push(states); f.ingress.observeQueues(states); } });
  t.after(() => dispatcher.close()); await dispatcher.tick();
  assert.equal(calls.length, 1); assert.equal(f.room.queueItems(otherId)[0].status, 'sent');
  assert.equal(projections[0].find(room => room.roomId === 'shared').active, false);
  assert.deepEqual(f.ledger.pendingEvents(), []);
});

test('passive intake never starts a timer or exposes a run API, and rejected text stays out of its journal', t => {
  const f = fixture(t);
  t.mock.method(global, 'setTimeout', () => { throw Error('Unexpected intake timer'); });
  t.mock.method(global, 'setInterval', () => { throw Error('Unexpected intake interval'); });
  const ingress = new ButlerIngress(f.directory, { roomState: f.room, ledger: f.ledger });
  bindQueueOutcomes(f.room, ingress, () => {});
  const syntheticSecret = 'Authorization: Bearer synthetic-placeholder';
  const itemId = f.room.queueAdd(syntheticSecret, null); f.room.queueMarkSent('shared', itemId, 'agent-a', 'Synthetic agent', NOW);
  f.room.queueSettle('shared', itemId, 'waiting', '', 'Synthetic agent', '', syntheticSecret);
  ingress.recover(); ingress.observeQueues([{ roomId: 'shared', active: false }]);
  assert.equal(ingress.run, undefined); assert.equal(ingress.status().activation, 'off'); assert.equal(ingress.status().recordPeriod, 'off');
  assert.deepEqual(f.ledger.snapshot().events.map(e => e.kind), ['blocked']);
  assert.equal(fs.readFileSync(f.ledger.file, 'utf8').includes(syntheticSecret), false);
});
