'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress, bindQueueOutcomes } = require('../butler-ingress.cjs');
const { QUEUE_LIMIT, trimQueue } = require('../queue-dispatch.cjs');
const NOW = Date.UTC(2026, 10, 10), READY = { branch: 'lane/synthetic-delivery', commit: 'a'.repeat(40) };
const TASK = 'Complete approved synthetic task body. '.repeat(40);
function fixture(t, { named = false, bind = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-ready-binding-'));
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const room = new RoomState(directory), roomId = named ? room.create('Synthetic delivery space') : 'shared';
  let time = NOW;
  const ledger = new ButlerLedger(directory, { now: () => time });
  const ingress = new ButlerIngress(directory, { roomState: room, ledger }), notices = [];
  if (bind) bindQueueOutcomes(room, ingress, outcome => notices.push(outcome));
  const sent = (text = TASK) => {
    const id = room.queueAdd(text, null, roomId);
    room.queueMarkSent(roomId, id, 'synthetic-member', 'Synthetic member', NOW);
    return id;
  };
  const done = id => room.queueSettle(roomId, id, 'done', '', 'Synthetic member', 'Short synthetic reply', undefined, READY);
  const readyFacts = () => room.metadata(roomId).events.filter(event => event.monitor?.kind === 'ready');
  return { directory, room, roomId, ledger, ingress, notices, sent, done, readyFacts, advance: ms => { time += ms; }, now: () => time };
}

for (const named of [false, true]) {
  const label = named ? 'named' : 'shared';
  test(`${label}: typed READY is durable with queue completion before the intake callback`, t => {
    const f = fixture(t, { named }), id = f.sent(), delivered = [], intake = f.room.onButlerReady;
    f.room.onButlerReady = (roomId, eventId) => {
      const disk = new RoomState(f.directory), event = disk.metadata(roomId).events.find(value => value.id === eventId);
      delivered.push({ roomId, eventId, status: disk.queueFind(roomId, id).status, event });
      return intake?.(roomId, eventId);
    };
    f.done(id);
    assert.equal(delivered.length, 1); assert.equal(delivered[0].roomId, f.roomId); assert.equal(delivered[0].status, 'done');
    const fact = f.readyFacts()[0], source = fact.butlerSource, saved = f.ledger.snapshot();
    assert.deepEqual(delivered[0].event, fact, 'The callback sees the same already committed parent and auxiliary source');
    assert.equal(delivered[0].eventId, fact.id); assert.equal(source.kind, 'ready');
    assert.equal(source.payload.text, TASK); assert.ok(source.payload.text.length > 200);
    assert.equal(source.payload.title, `READY ${READY.branch} ${READY.commit}`);
    assert.equal(source.payload.spaceId, f.roomId); assert.equal(source.payload.itemId, id);
    assert.equal(source.payload.memberId, 'synthetic-member'); assert.equal(source.payload.memberName, 'Synthetic member');
    assert.equal(source.sourceRef, `queue-ready:${f.roomId}:${id}`);
    assert.equal(saved.events.length, 1); assert.equal(saved.events[0].eventId, source.eventId);
    assert.equal(saved.events[0].sourceRef, source.sourceRef); assert.deepEqual(saved.events[0].payload, source.payload);
    assert.deepEqual(saved.pendingEvents.map(event => event.eventId), [source.eventId]);
    assert.equal(f.notices.length, 0, 'READY is not a B1 decision notification');
    assert.deepEqual(f.ingress.status(), { intake: 'ready', errorCode: null, activation: 'off', recordPeriod: 'off' });
  });

  test(`${label}: a failed queue commit invokes no READY callback and leaves the source absent`, t => {
    const f = fixture(t, { named }), id = f.sent(), before = structuredClone(f.room.metadata(f.roomId));
    const file = named ? f.room.spacesFile : f.room.file, bytes = fs.readFileSync(file);
    let callbacks = 0; f.room.onButlerReady = () => { callbacks++; };
    t.mock.method(f.room, 'write', () => { throw Error('Synthetic queue commit failure'); });
    assert.throws(() => f.done(id), /Synthetic queue commit failure/);
    assert.equal(callbacks, 0); assert.deepEqual(f.room.metadata(f.roomId), before); assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(f.ledger.snapshot().events.length, 0);
    assert.equal(new RoomState(f.directory).queueFind(f.roomId, id).status, 'sent');
  });

  test(`${label}: failed intake cannot undo a committed READY and its source recovers`, t => {
    const f = fixture(t, { named }), id = f.sent(); let attempts = 0;
    t.mock.method(f.ledger, 'ingest', () => { attempts++; throw Error('Synthetic intake unavailable'); });
    assert.doesNotThrow(() => f.done(id));
    assert.equal(attempts, 1); assert.equal(f.room.queueFind(f.roomId, id).status, 'done');
    const disk = new RoomState(f.directory), fact = disk.metadata(f.roomId).events.find(event => event.monitor?.kind === 'ready');
    assert.equal(fact.butlerSource.kind, 'ready'); assert.equal(f.ledger.snapshot().events.length, 0);
    assert.equal(f.ingress.status().intake, 'blocked');
    t.mock.restoreAll();
    const ledger = new ButlerLedger(f.directory), restored = new ButlerIngress(f.directory, { roomState: disk, ledger });
    restored.recover(); assert.equal(ledger.snapshot().events.length, 1);
    assert.equal(ledger.snapshot().events[0].eventId, fact.butlerSource.eventId);
    assert.equal(ledger.snapshot().events[0].payload.text, TASK); assert.equal(restored.status().intake, 'ready');
  });

  test(`${label}: restart recovers READY once after its completed queue item is trimmed`, t => {
    const f = fixture(t, { named, bind: false }), id = f.sent(); f.done(id);
    const fact = f.readyFacts()[0]; assert.equal(fact.butlerSource?.kind, 'ready');
    const retained = Array.from({ length: QUEUE_LIMIT }, (_, n) => ({ id: `synthetic-history-${n}`, text: 'Later synthetic completed item',
      assignee: null, status: 'done', createdAt: NOW + n + 1, finishedAt: NOW + n + 2 }));
    const trimmed = trimQueue([...f.room.queueItems(f.roomId), ...retained]);
    f.room.update({ queue: trimmed }, undefined, f.roomId);
    assert.equal(f.room.queueItems(f.roomId).length, QUEUE_LIMIT); assert.equal(f.room.queueItems(f.roomId).some(item => item.id === id), false);
    assert.equal(f.ledger.snapshot().events.length, 0);
    const room = new RoomState(f.directory), ledger = new ButlerLedger(f.directory), ingress = new ButlerIngress(f.directory, { roomState: room, ledger });
    ingress.recover(); assert.equal(ledger.snapshot().events.length, 1); assert.equal(ledger.snapshot().events[0].payload.text, TASK);
    const bytes = fs.readFileSync(ledger.file), first = ledger.snapshot();
    ingress.recover(); ingress.captureOutcome(f.roomId, fact.id);
    assert.deepEqual(ledger.snapshot(), first); assert.deepEqual(fs.readFileSync(ledger.file), bytes);
    const reopened = new ButlerLedger(f.directory); assert.deepEqual(reopened.snapshot(), first);
  });

  test(`${label}: malformed READY auxiliary data cannot disable the original room`, t => {
    const f = fixture(t, { named, bind: false }), id = f.sent(); f.done(id);
    const events = structuredClone(f.room.metadata(f.roomId).events), fact = events.find(event => event.monitor?.kind === 'ready');
    fact.butlerSource = { opaque: 'Synthetic malformed metadata' };
    f.room.update({ events }, undefined, f.roomId);
    const file = named ? f.room.spacesFile : f.room.file, bytes = fs.readFileSync(file), room = new RoomState(f.directory);
    assert.equal(room.warning, ''); assert.equal(room.spacesWarning, ''); assert.equal(room.queueFind(f.roomId, id).status, 'done');
    const ledger = new ButlerLedger(f.directory), ingress = new ButlerIngress(f.directory, { roomState: room, ledger });
    ingress.recover(); const saved = ledger.snapshot();
    assert.equal(saved.events.length, 1); assert.equal(saved.events[0].kind, 'blocked');
    assert.equal(saved.events[0].payload.reason, 'source-invalid'); assert.equal(saved.pendingEvents.length, 0);
    assert.equal(saved.events[0].payload.text, undefined); assert.equal(ingress.status().intake, 'blocked');
    assert.deepEqual(fs.readFileSync(file), bytes, 'Rejected auxiliary data stays available for local repair');
    assert.equal(room.metadata(f.roomId).events.find(event => event.id === fact.id).butlerSource.opaque, 'Synthetic malformed metadata');
  });

  test(`${label}: an older READY monitor without auxiliary source is not backfilled from queue history`, t => {
    const f = fixture(t, { named, bind: false }), id = f.sent(); f.done(id);
    const events = structuredClone(f.room.metadata(f.roomId).events), fact = events.find(event => event.monitor?.kind === 'ready');
    delete fact.butlerSource; f.room.update({ events }, undefined, f.roomId);
    const room = new RoomState(f.directory), ledger = new ButlerLedger(f.directory), ingress = new ButlerIngress(f.directory, { roomState: room, ledger });
    assert.deepEqual(room.queueFind(f.roomId, id).ready, READY); assert.deepEqual(room.butlerSources(), []);
    ingress.recover(); assert.deepEqual(ledger.snapshot().events, []);
    assert.equal(ingress.captureOutcome(f.roomId, fact.id).status, 'ignored');
  });
}

test('ordinary completion and READY-looking reply text without typed metadata create no butler source', t => {
  const f = fixture(t);
  for (const reply of ['Synthetic notes are done.', `READY ${READY.branch} ${READY.commit}`]) {
    const id = f.sent(); f.room.queueSettle(f.roomId, id, 'done', '', 'Synthetic member', reply);
  }
  f.ingress.recover(); assert.deepEqual(f.room.butlerSources(), []); assert.equal(f.readyFacts().length, 0);
  assert.deepEqual(f.ledger.snapshot().events, []); assert.equal(f.notices.length, 0);
});

for (const named of [false, true]) test(`${named ? 'named' : 'shared'}: waiting typed READY enters only after explicit queue resolution and leaves B1 intact`, t => {
  const f = fixture(t, { named }), id = f.sent();
  f.room.queueSettle(f.roomId, id, 'waiting', '', 'Synthetic member', 'Synthetic decision and READY', 'Approve synthetic delivery?', READY);
  assert.equal(f.readyFacts().length, 0); assert.equal(f.ledger.snapshot().events.filter(event => event.kind === 'ready').length, 0);
  assert.equal(f.notices.length, 1); assert.equal(f.ledger.snapshot().questions.length, 1);
  assert.equal(f.ledger.snapshot().questions[0].status, 'open'); assert.equal(f.ledger.snapshot().deliveries[0].status, 'unknown');
  const outcomeId = f.notices[0].eventId;
  assert.equal(f.room.metadata(f.roomId).events.find(event => event.id === outcomeId).uiMessage.key, 'notice.queue.waiting');
  f.room.queueResolve(id, f.roomId);
  assert.equal(f.readyFacts().length, 1); assert.equal(f.ledger.snapshot().events.filter(event => event.kind === 'ready').length, 1);
  assert.equal(f.notices.length, 1); assert.equal(f.ledger.snapshot().questions[0].status, 'open');
  const bytes = fs.readFileSync(f.ledger.file); assert.throws(() => f.room.queueResolve(id, f.roomId));
  f.ingress.recover(); assert.deepEqual(fs.readFileSync(f.ledger.file), bytes);
});

test('the real typed source can notify a dormant-controller fixture with one non-extending READY window', async t => {
  const { ButlerRole } = require('../butler-role.cjs'), { ButlerController } = require('../butler-controller.cjs');
  const f = fixture(t), person = Symbol('synthetic-person');
  const runner = { runnerRef: 'butler:synthetic-runner', backendRef: 'butler:synthetic-backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
  const role = new ButlerRole(f.directory, { authorizePerson: value => value === person });
  role.set(person, { identity: { sessionId: 'synthetic-butler', nativeId: 'synthetic-native' }, runner, budget: { limitMicros: 100 } }, 0);
  const records = [{ id: 'synthetic-butler', nativeId: 'synthetic-native', provider: 'codex', state: 'idle', roomIds: [], runner }];
  const timers = new Map(), calls = [], reports = [];
  const controller = new ButlerController({ role, ledger: f.ledger, backend: { ensure: async () => ({ ready: true, binding: runner }) },
    view: () => ({ records, spaces: [{ id: f.roomId, name: 'Synthetic space', archived: false, writable: true, members: [], queue: [] }] }),
    run: async (input, selection) => {
      const saved = new ButlerLedger(f.directory).snapshot();
      assert.ok(input.events.every(event => saved.events.some(row => row.eventId === event.eventId)), 'Every input was committed before the synthetic runner');
      calls.push(input); return { batchId: input.batchId, attempt: input.attempt, selection, reply: { actions: [] }, usage: { costMicros: 1 } };
    }, publish: async report => { reports.push(report); return { deliveryId: report.deliveryId, status: 'sent' }; },
    now: f.now, estimateBatchCost: () => 1,
    schedule: (fn, delay) => { const token = {}; timers.set(token, { fn, delay }); return token; }, cancel: token => timers.delete(token) });
  t.after(() => controller.close());
  const first = f.sent(); f.done(first);
  const one = f.ledger.snapshot().events[0]; assert.equal(one.kind, 'ready');
  assert.equal((await controller.notifyPersisted(one.eventId)).status, 'batched');
  const timer = [...timers.values()][0]; assert.equal(timer.delay, 30000);
  f.advance(10000); const second = f.sent('Second approved synthetic task'); f.done(second);
  const two = f.ledger.snapshot().events.find(event => event.payload.itemId === second);
  await controller.notifyPersisted(two.eventId); await controller.notifyPersisted(one.eventId);
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0], timer); assert.equal(calls.length, 0);
  assert.equal(f.ingress.status().activation, 'off'); assert.equal(f.ingress.status().recordPeriod, 'off');
  f.advance(20000); timers.clear(); timer.fn(); await controller.running;
  assert.equal(calls.length, 1); assert.equal(reports.length, 1); assert.deepEqual(calls[0].events.map(event => event.eventId), [one.eventId, two.eventId]);
  assert.equal(calls[0].events[0].payload.text, TASK); assert.equal(f.ledger.pendingEvents().length, 0);
  assert.equal((await controller.notifyPersisted(one.eventId)).status, 'duplicate'); assert.equal(timers.size, 0); assert.equal(calls.length, 1);
});
