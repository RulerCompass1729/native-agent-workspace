'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const { ButlerIngress, bindQueueOutcomes, storedQueueSource } = require('../butler-ingress.cjs');
const { QueueDispatcher } = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-e-noreply-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), ingress = new ButlerIngress(dir, { roomState: room });
  let personNotices = 0;
  bindQueueOutcomes(room, ingress, () => { personNotices++; });
  const session = { id: 'member-a', nativeId: 'native-a', provider: 'codex', state: 'idle' };
  const itemId = room.queueAdd('PRIVATE TASK CANARY', null);
  room.queueMarkSent('shared', itemId, session.id, 'PRIVATE NAME CANARY', NOW, false, session.nativeId);
  const dispatcher = { roomState: room, client: { snapshot: () => ({ sessions: [session] }) },
    stillSent: (...args) => room.queueFind(...args).status === 'sent',
    name: () => 'PRIVATE NAME CANARY', broadcast: () => Promise.resolve(), clearRuns() {} };
  const settle = (status = 'waiting', reason = 'no-reply', planned = session) => QueueDispatcher.prototype.settle.call(dispatcher,
    { roomId: 'shared', itemId, sessionId: session.id, status, reason, reply: status === 'done' ? 'Synthetic complete reply' : '' }, { sessions: [planned] });
  return { dir, room, ingress, session, itemId, settle, client: dispatcher.client, events: () => ingress.ledger.snapshot().events,
    personNotices: () => personNotices, restart: () => new ButlerIngress(dir, { roomState: new RoomState(dir) }) };
}
function quota(f, turnId = 'quota-turn') {
  f.session.nativeQuota = { kind: 'usage_limit_exceeded', nativeId: f.session.nativeId, turnId, observedAt: NOW, model: null };
}
test('a dispatched no-reply keeps the task and records only identity plus the unconfirmed cause', t => {
  const f = fixture(t);
  for (const key of ['messages', 'liveDraft', 'reply']) Object.defineProperty(f.session, key, {
    get() { throw Error('No-reply intake must not read private ' + key); } });
  f.settle();
  assert.equal(f.room.queueFind('shared', f.itemId).status, 'waiting');
  assert.equal(f.room.queueFind('shared', f.itemId).reason, 'no-reply');
  assert.equal(f.room.queueFind('shared', f.itemId).text, 'PRIVATE TASK CANARY');
  assert.equal(f.room.queueFind('shared', f.itemId).reply, undefined);
  assert.equal(f.events().length, 1);
  assert.equal(f.events()[0].kind, 'failure');
  assert.deepEqual(f.events()[0].payload, { memberId: f.session.id, itemId: f.itemId, reason: 'no-reply-unconfirmed' });
  assert.equal(JSON.stringify(f.events()).includes('PRIVATE'), false);
  assert.equal(f.ingress.ledger.snapshot().questions.length, 0);
  assert.equal(f.personNotices(), 0, 'This is a butler notification, not a fabricated decision');
  const bytes = fs.readFileSync(f.ingress.ledger.file);
  f.settle(); f.ingress.captureOutcome('shared', f.room.metadata().events.at(-1).id); f.restart().recover();
  assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), bytes);
});
for (const first of ['quota', 'no-reply']) test(`current quota + no-reply is one episode, observed ${first} first`, t => {
  const f = fixture(t); quota(f);
  if (first === 'quota') f.ingress.observeRecoveryFailures([f.session]);
  f.settle(); f.ingress.observeRecoveryFailures([f.session]);
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].kind, 'blocked');
  assert.deepEqual(f.events()[0].payload, { memberId: f.session.id, reason: 'codex-usage-limit-exceeded' });
  const saved = f.room.butlerSources(); assert.equal(saved.length, 1);
  assert.equal(saved[0].eventId, f.events()[0].eventId, 'The task references the existing quota episode');
  const bytes = fs.readFileSync(f.ingress.ledger.file), restored = f.restart();
  restored.recover(); restored.observeRecoveryFailures([f.session]); restored.recover();
  assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), bytes);
});
test('no-reply survives notifier failure and restart without repeating or losing the task source', t => {
  const f = fixture(t); f.room.onButlerReady = () => { throw Error('Synthetic notifier failure'); };
  f.settle(); assert.equal(f.events().length, 0);
  const restored = f.restart(); restored.recover();
  assert.equal(restored.ledger.snapshot().events.length, 1);
  const bytes = fs.readFileSync(restored.ledger.file);
  restored.recover(); f.restart().recover();
  assert.deepEqual(fs.readFileSync(restored.ledger.file), bytes);
});
for (const change of ['other-native', 'other-member', 'unknown-kind', 'no-turn', 'archived', 'cleared'])
test('a stale/unverified quota cannot hide no-reply: ' + change, t => {
  const f = fixture(t); quota(f);
  f.ingress.observeRecoveryFailures([{ ...f.session, ...(change === 'other-member' ? { id: 'member-b' } : {}) }]);
  if (change === 'other-native') f.session.nativeId = 'replacement-native';
  if (change === 'other-member') f.session.nativeQuota = undefined;
  if (change === 'unknown-kind') f.session.nativeQuota.kind = 'other';
  if (change === 'no-turn') f.session.nativeQuota.turnId = '';
  if (change === 'archived') f.session.archived = true;
  if (change === 'cleared') delete f.session.nativeQuota;
  f.settle();
  assert.equal(f.events().length, 2);
  assert.deepEqual(f.events().at(-1).payload, { memberId: 'member-a', itemId: f.itemId, reason: 'no-reply-unconfirmed' });
});
test('a current quota belonging to a replacement native cannot explain the original dispatch', t => {
  const f = fixture(t); f.session.nativeId = 'replacement-native'; quota(f);
  f.ingress.observeRecoveryFailures([f.session]); f.settle();
  assert.equal(f.events().length, 2); assert.equal(f.events().at(-1).payload.reason, 'no-reply-unconfirmed');
});
test('a quota arriving after planning still deduplicates at settlement', t => {
  const f = fixture(t), planned = structuredClone(f.session);
  quota(f); f.ingress.observeRecoveryFailures([f.session]); f.settle('waiting', 'no-reply', planned);
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.reason, 'codex-usage-limit-exceeded');
});
test('a quota cleared after planning cannot suppress the unknown-cause outcome', t => {
  const f = fixture(t); quota(f); const planned = structuredClone(f.session);
  f.ingress.observeRecoveryFailures([f.session]); delete f.session.nativeQuota;
  f.settle('waiting', 'no-reply', planned);
  assert.equal(f.events().length, 2); assert.equal(f.events().at(-1).payload.reason, 'no-reply-unconfirmed');
});
test('an unreadable live cause still records the no-reply outcome without retrying the query', t => {
  const f = fixture(t); let calls = 0;
  f.client.snapshot = () => { calls++; throw Error('Synthetic cached observation unavailable'); };
  f.settle(); assert.equal(calls, 1);
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.reason, 'no-reply-unconfirmed');
});
test('Claude empty turns use the same unknown-cause notice without inventing a quota episode', t => {
  const f = fixture(t); f.session.provider = 'claude'; quota(f); f.settle();
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].payload.reason, 'no-reply-unconfirmed');
});
for (const [status, reason] of [['done', ''], ['waiting', 'person-intervened']])
test('normal reply and human intervention do not create A3 notifications: ' + status, t => {
  const f = fixture(t); f.settle(status, reason); f.restart().recover();
  assert.deepEqual(f.events(), []); assert.equal(f.personNotices(), 0);
});
test('two different no-reply items each retain one notification', t => {
  const f = fixture(t); f.settle();
  const id = f.room.queueAdd('SECOND PRIVATE TASK', null);
  f.room.queueMarkSent('shared', id, f.session.id, 'PRIVATE NAME', NOW, false, f.session.nativeId);
  f.room.queueSettle('shared', id, 'waiting', 'no-reply', 'PRIVATE NAME');
  const restored = f.restart(); restored.recover();
  assert.equal(restored.ledger.snapshot().events.length, 2);
  assert.deepEqual(new Set(restored.ledger.snapshot().events.map(e => e.payload.itemId)), new Set([f.itemId, id]));
});
test('a named space retains its no-reply source even after the space is archived', t => {
  const f = fixture(t), roomId = f.room.create('Synthetic team');
  const id = f.room.queueAdd('PRIVATE NAMED TASK', null, roomId);
  f.room.queueMarkSent(roomId, id, f.session.id, 'PRIVATE NAME', NOW, false, f.session.nativeId);
  f.room.queueSettle(roomId, id, 'waiting', 'no-reply', 'PRIVATE NAME');
  f.room.update({ archived: true }, undefined, roomId);
  assert.equal(f.events().length, 1);
  assert.deepEqual(f.events()[0].payload, { memberId: f.session.id, itemId: id, reason: 'no-reply-unconfirmed' });
  const bytes = fs.readFileSync(f.ingress.ledger.file); f.restart().recover();
  assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), bytes);
});
for (const change of ['member', 'item', 'kind', 'extra', 'quota'])
test('damaged no-reply auxiliary data cannot become an invented quota or copy content: ' + change, t => {
  const f = fixture(t); f.settle();
  const event = structuredClone(f.room.metadata().events.at(-1));
  if (change === 'member') event.butlerNoReplySource.memberId = 'someone-else';
  if (change === 'item') event.butlerNoReplySource.itemId = 'another-item';
  if (change === 'kind') event.kind = 'message';
  if (change === 'extra') event.butlerNoReplySource.text = 'PRIVATE EXTRA CANARY';
  if (change === 'quota') event.butlerNoReplySource.quota = { nativeId: 'native-a', turnId: 'quota-turn', text: 'PRIVATE EXTRA CANARY' };
  const result = storedQueueSource('shared', event);
  assert.equal(result.kind, 'blocked'); assert.equal(result.payload.reason, 'source-invalid');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
