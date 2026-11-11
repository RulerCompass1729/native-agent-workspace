'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress, bindQueueOutcomes } = require('../butler-ingress.cjs');
const SECRET_SHAPE = 'Authorization: Bearer synthetic-not-a-credential';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-recovery-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const room = new RoomState(directory), ledger = new ButlerLedger(directory);
  return { directory, room, ledger, ingress: new ButlerIngress(directory, { roomState: room, ledger }) };
}
function settle(room, status = 'waiting') {
  const itemId = room.queueAdd('Synthetic task', null); room.queueMarkSent('shared', itemId, 'member-a', 'Synthetic member', 100);
  room.queueSettle('shared', itemId, status, status === 'failed' ? 'Synthetic failure' : '', 'Synthetic member', '', 'Approve this synthetic task?');
  return room.value.events.at(-1);
}

test('unrelated B1 and vacancy successes cannot clear an unrecorded durable source failure', t => {
  const f = fixture(t), ingest = f.ledger.ingest.bind(f.ledger); let failedRef = null, storageBroken = true, notifications = 0;
  t.mock.method(f.ledger, 'ingest', event => {
    failedRef ||= event.sourceRef;
    if (storageBroken && event.sourceRef === failedRef) throw Error('Synthetic storage unavailable for one source');
    return ingest(event);
  });
  bindQueueOutcomes(f.room, f.ingress, () => { notifications++; });
  const first = settle(f.room), second = settle(f.room);
  f.ingress.observeQueues([{ roomId: 'shared', name: 'Synthetic team', active: true }]);
  assert.equal(f.ingress.status().errorCode, 'source-unavailable'); assert.equal(f.ingress.status().intake, 'blocked');
  assert.equal(f.ledger.snapshot().events.some(event => event.eventId === first.butlerSource.eventId), false);
  assert.equal(f.ledger.snapshot().events.some(event => event.eventId === second.butlerSource.eventId), true);
  assert.equal(notifications, 2); storageBroken = false;
  f.ingress.recover(); const saved = f.ledger.snapshot(); f.ingress.recover();
  assert.equal(f.ingress.status().intake, 'ready'); assert.deepEqual(f.ledger.snapshot(), saved);
  assert.equal(saved.questions.length, 2); assert.equal(saved.deliveries.length, 2); assert.equal(notifications, 2);
  assert.equal(f.ingress.run, undefined); assert.equal(f.ingress.status().activation, 'off'); assert.equal(f.ingress.status().recordPeriod, 'off');
});

test('a rejected first space label preserves later vacancies and repairs only its own error scope', t => {
  const f = fixture(t), good = f.room.create('Good synthetic team'), anotherBad = f.room.create('Another synthetic team');
  f.ingress.observeQueues([{ roomId: 'shared', name: SECRET_SHAPE, active: true },
    { roomId: good, name: 'Good synthetic team', active: true }, { roomId: anotherBad, name: SECRET_SHAPE, active: true }]);
  const events = f.ledger.snapshot().events;
  assert.equal(events.length, 3); assert.equal(events[0].payload.spaceName, undefined);
  assert.equal(events.find(event => event.payload.spaceId === good).payload.spaceName, 'Good synthetic team');
  assert.equal(fs.readFileSync(f.ledger.file, 'utf8').includes(SECRET_SHAPE), false);
  let notified = 0; bindQueueOutcomes(f.room, f.ingress, () => { notified++; }); settle(f.room, 'failed');
  f.ingress.observeQueues([{ roomId: good, name: 'Good synthetic team', active: true }]);
  assert.equal(f.ingress.status().errorCode, 'source-rejected');
  f.ingress.observeQueues([{ roomId: 'shared', name: 'Repaired synthetic team', active: true }]);
  assert.equal(f.ingress.status().intake, 'blocked', 'The other rejected label remains unresolved');
  f.ingress.observeQueues([{ roomId: anotherBad, name: 'Repaired other team', active: true }]);
  assert.equal(f.ingress.status().intake, 'ready'); assert.equal(notified, 1);
  assert.equal(f.ledger.snapshot().events.filter(event => event.kind === 'queue-empty').length, 3);
});

test('bad stored source metadata stays blocked across boots without suppressing a good source or its repair', t => {
  const f = fixture(t); let notifications = 0; bindQueueOutcomes(f.room, null, () => { notifications++; });
  const bad = settle(f.room), good = settle(f.room, 'failed'), original = structuredClone(bad.butlerSource);
  const raw = JSON.parse(fs.readFileSync(f.room.file, 'utf8'));
  raw.events.find(event => event.id === bad.id).butlerSource.payload.text = SECRET_SHAPE;
  fs.writeFileSync(f.room.file, JSON.stringify(raw));
  const reopen = () => {
    const room = new RoomState(f.directory), ledger = new ButlerLedger(f.directory);
    return { room, ledger, ingress: new ButlerIngress(f.directory, { roomState: room, ledger }) };
  };
  const first = reopen(); first.ingress.recover();
  assert.equal(first.room.warning, ''); first.room.queueAdd('Space remains writable', null);
  assert.equal(first.ledger.snapshot().events.some(event => event.eventId === good.butlerSource.eventId), true);
  assert.equal(first.ledger.snapshot().events.some(event => event.kind === 'blocked' && event.payload.reason === 'source-invalid'), true);
  assert.equal(first.ingress.status().errorCode, 'source-rejected');
  const next = reopen(); assert.equal(next.ingress.status().intake, 'blocked'); next.ingress.recover();
  assert.equal(next.ingress.status().errorCode, 'source-rejected'); assert.equal(notifications, 2);
  const repairedRaw = JSON.parse(fs.readFileSync(first.room.file, 'utf8'));
  repairedRaw.events.find(event => event.id === bad.id).butlerSource = original;
  fs.writeFileSync(first.room.file, JSON.stringify(repairedRaw));
  const repaired = reopen(); repaired.ingress.recover(); const saved = repaired.ledger.snapshot(); repaired.ingress.recover();
  assert.equal(repaired.ingress.status().intake, 'ready'); assert.deepEqual(repaired.ledger.snapshot(), saved);
  assert.equal(saved.questions.length, 1); assert.equal(saved.deliveries.length, 1); assert.equal(saved.deliveries[0].status, 'unknown');
  assert.equal(reopen().ingress.status().intake, 'ready'); assert.equal(notifications, 2); assert.equal(repaired.ingress.run, undefined);
});
