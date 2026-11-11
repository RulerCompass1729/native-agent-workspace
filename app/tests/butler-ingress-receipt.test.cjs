'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress, queueOutcomeSource, bindQueueOutcomes } = require('../butler-ingress.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-ingress-receipt-'));
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const roomState = new RoomState(directory), ledger = new ButlerLedger(directory);
  const ingress = new ButlerIngress(directory, { roomState, ledger });
  const settle = () => {
    const id = roomState.queueAdd('Synthetic task', null);
    roomState.queueMarkSent('shared', id, 'member-a', 'Member A', Date.now());
    roomState.queueSettle('shared', id, 'waiting', '', 'Member A', '', 'Approve this synthetic choice?');
    return roomState.metadata().events.at(-1);
  };
  return { directory, roomState, ledger, ingress, settle };
}

test('a B1 decision receipt uses canonical source, question and delivery IDs instead of the room event UUID', t => {
  const f = fixture(t), calls = [];
  bindQueueOutcomes(f.roomState, f.ingress, (outcome, receipt) => calls.push({ outcome, receipt }));
  const parent = f.settle(), state = f.ledger.snapshot(), [call] = calls;
  assert.equal(calls.length, 1);
  assert.equal(call.outcome.eventId, parent.id);
  assert.equal(call.receipt.eventId, parent.butlerSource.eventId);
  assert.notEqual(call.receipt.eventId, parent.id);
  assert.deepEqual(call.receipt, { status: 'recorded', eventId: state.events[0].eventId,
    questionId: state.questions[0].questionId, deliveryId: state.deliveries[0].deliveryId });
  assert.equal(state.deliveries[0].status, 'unknown', 'The existing logical acknowledgement is unchanged');
  assert.equal(state.questions[0].text, call.outcome.question);
});

test('duplicate capture and restart return the original canonical question and delivery receipt', t => {
  const f = fixture(t), calls = [];
  bindQueueOutcomes(f.roomState, f.ingress, (outcome, receipt) => calls.push({ outcome, receipt }));
  const parent = f.settle(), original = calls[0].receipt;
  assert.deepEqual(f.ingress.record(parent.butlerSource), original);
  assert.deepEqual(f.ingress.captureOutcome('shared', parent.id), original);
  const ledger = new ButlerLedger(f.directory), ingress = new ButlerIngress(f.directory, { roomState: new RoomState(f.directory), ledger });
  assert.deepEqual(ingress.captureOutcome('shared', parent.id), original);
  f.roomState.onQueueOutcome(calls[0].outcome);
  assert.deepEqual(calls[1].receipt, original, 'The B1 callback receives the same attribution on event replay');
  assert.equal(ledger.snapshot().questions.length, 1); assert.equal(ledger.snapshot().deliveries.length, 1);
});

for (const kind of ['failure', 'blocked']) test(`${kind} source receipts do not invent question or delivery identities`, t => {
  const f = fixture(t), source = queueOutcomeSource({ roomId: 'shared', itemId: 'item-a', eventId: 'room-event-a',
    status: 'failed', reason: kind === 'failure' ? 'send-unconfirmed' : 'Authorization: Bearer not-a-secret', task: 'Synthetic task' });
  assert.equal(source.kind, kind);
  const receipt = f.ingress.record(source);
  assert.deepEqual(receipt, { status: 'recorded', eventId: source.eventId });
  assert.equal(Object.hasOwn(receipt, 'questionId'), false); assert.equal(Object.hasOwn(receipt, 'deliveryId'), false);
  assert.equal(f.ledger.snapshot().questions.length, 0); assert.equal(f.ledger.snapshot().deliveries.length, 0);
});

test('a failed intake still invokes the B1 notifier with an undefined receipt and keeps the durable source', t => {
  const f = fixture(t), calls = [];
  t.mock.method(f.ingress, 'captureOutcome', () => { throw Error('Synthetic intake unavailable'); });
  bindQueueOutcomes(f.roomState, f.ingress, (outcome, receipt) => calls.push({ outcome, receipt }));
  const parent = f.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].outcome.eventId, parent.id);
  assert.equal(calls[0].receipt, undefined);
  assert.equal(f.ledger.snapshot().events.length, 0);
  assert.equal(new RoomState(f.directory).butlerSources()[0].eventId, parent.butlerSource.eventId);
});

test('an absent intake keeps the existing B1 notification path and supplies no synthetic receipt', () => {
  const roomState = {}, outcome = { roomId: 'shared', eventId: 'room-event-a' }, calls = [];
  bindQueueOutcomes(roomState, null, (...args) => calls.push(args));
  roomState.onQueueOutcome(outcome);
  assert.deepEqual(calls, [[outcome, undefined]]);
});
