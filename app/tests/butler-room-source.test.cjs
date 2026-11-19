'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const { QUEUE_LIMIT } = require('../queue-dispatch.cjs');
const { queueOutcomeSource } = require('../butler-ingress.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-room-source-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), outcomes = [];
  room.onQueueOutcome = value => outcomes.push(value);
  const sent = (text = 'Synthetic task', roomId = 'shared') => {
    const id = room.queueAdd(text, null, roomId);
    room.queueMarkSent(roomId, id, 'member-a', 'Member A', Date.now());
    return id;
  };
  return { dir, room, outcomes, sent, reopen: () => new RoomState(dir) };
}

for (const [status, reason] of [['waiting', ''], ['failed', 'send-unconfirmed']]) {
  test(`a ${status} source shares the persisted B1 event identity and full approved task`, t => {
    const f = fixture(t), task = 'Synthetic task beyond the notification summary: ' + 'detail '.repeat(20);
    const id = f.sent(task), question = 'Proceed with this synthetic choice?';
    f.room.queueSettle('shared', id, status, reason, 'Member A', 'Synthetic first-line reply', question);
    assert.equal(f.outcomes.length, 1);
    const outcome = f.outcomes[0], event = f.room.metadata().events.at(-1);
    assert.equal(event.id, outcome.eventId);
    assert.equal(outcome.task.length <= 40, true, 'Existing B1 notification summary remains bounded');
    const expected = queueOutcomeSource({ ...outcome, task });
    assert.ok(expected);
    assert.deepEqual(event.butlerSource, expected);
    assert.deepEqual(f.room.butlerSources(), [expected]);
    assert.deepEqual(f.reopen().butlerSources(), [expected]);
    assert.equal(JSON.stringify(expected).includes(task), true, 'Source retains the approved full queue body');
    if (status === 'waiting') assert.equal(JSON.stringify(expected).includes(question), true, 'Source retains the actual B1 question');
    assert.equal(f.room.queueFind('shared', id).status, status);
  });
}

test('a failing notifier cannot lose the source across restart and source copies cannot mutate storage', t => {
  const f = fixture(t), id = f.sent();
  f.room.onQueueOutcome = () => { throw Error('Synthetic notification unavailable'); };
  f.room.queueSettle('shared', id, 'waiting', '', 'Member A', 'Short reply', 'Make this choice?');
  const sources = f.room.butlerSources(), original = structuredClone(sources);
  assert.equal(sources.length, 1);
  sources[0].payload.text = 'Changed returned copy';
  assert.deepEqual(f.room.butlerSources(), original);
  assert.deepEqual(f.reopen().butlerSources(), original);
});

test('trimming a settled queue item does not remove its durable B1 source', t => {
  const f = fixture(t), id = f.sent();
  f.room.queueSettle('shared', id, 'failed', 'send-unconfirmed', 'Member A');
  const expected = f.room.butlerSources();
  for (let index = 0; index < QUEUE_LIMIT; index++) f.room.queueAdd('Synthetic queued work ' + index, null);
  assert.equal(f.room.queueItems().length, QUEUE_LIMIT);
  assert.equal(f.room.queueItems().some(item => item.id === id), false);
  assert.deepEqual(f.room.butlerSources(), expected);
  assert.deepEqual(f.reopen().butlerSources(), expected);
});

test('ordinary completion and nondecision waiting outcomes create no READY or B4 source', t => {
  const f = fixture(t);
  for (const [status, reason] of [['done', ''], ['cancelled', ''], ['waiting', 'person-intervened']]) {
    f.room.queueSettle('shared', f.sent(), status, reason, 'Member A', 'READY is merely text here');
  }
  assert.deepEqual(f.room.butlerSources(), []);
  assert.deepEqual(f.reopen().butlerSources(), []);
  assert.equal(f.outcomes.length, 0);
});

test('all spaces retain detached sources, including an archived space', t => {
  const f = fixture(t), other = f.room.create('Another synthetic space');
  f.room.queueSettle('shared', f.sent(), 'waiting', '', 'Member A', '', 'First choice?');
  f.room.queueSettle(other, f.sent('Another synthetic task', other), 'failed', 'send-unconfirmed', 'Member A');
  const expected = f.room.butlerSources();
  f.room.update({ archived: true }, undefined, other);
  assert.equal(expected.length, 2);
  assert.deepEqual(f.reopen().butlerSources(), expected);
  const saved = f.room.butlerSources(); saved.pop();
  assert.equal(f.room.butlerSources().length, 2);
});

test('legacy events without B4 sources remain readable', t => {
  const f = fixture(t); f.room.rename('Legacy synthetic space');
  const saved = f.reopen();
  assert.equal(saved.warning, ''); assert.equal(saved.spacesWarning, '');
  assert.equal(saved.metadata().events.length, 1);
  assert.deepEqual(saved.butlerSources(), []);
});

const malformedSources = [null, 'Synthetic malformed auxiliary field',
  { eventId: 'bad', kind: 'ready', sourceRef: 'invented', payload: {}, authority: 'person' },
  { eventId: 'bad', kind: 'decision', sourceRef: 'invented', payload: { text: 'Authorization: Bearer SYNTHETIC_NOT_A_TOKEN' } },
  { eventId: 'bad', kind: 'decision', sourceRef: 'invented', payload: { text: 'x'.repeat(12001) } }];
for (const scope of ['shared', 'named']) for (const [index, invalid] of malformedSources.entries()) {
  test(`a bad auxiliary source ${index} leaves ${scope} and other spaces readable and writable`, t => {
    const f = fixture(t), other = f.room.create('Other synthetic space');
    const target = scope === 'shared' ? 'shared' : other, good = scope === 'shared' ? other : 'shared';
    f.room.queueSettle(good, f.sent('Good source task', good), 'waiting', '', 'Member A', '', 'Good source choice?');
    const [goodSource] = f.room.butlerSources();
    f.room.rename('Synthetic source validation', target);
    const file = target === 'shared' ? f.room.file : f.room.spacesFile;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const targetData = target === 'shared' ? data : data.rooms.find(value => value.id === target);
    const damaged = targetData.events.at(-1), parentId = damaged.id;
    damaged.butlerSource = invalid;
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    const saved = f.reopen();
    assert.equal(saved.warning, ''); assert.equal(saved.spacesWarning, '');
    assert.equal(saved.metadata(target).name, 'Synthetic source validation');
    const sources = saved.butlerSources(), blocked = sources.find(source => source.kind === 'blocked');
    assert.equal(sources.some(source => source.eventId === goodSource.eventId), true, 'Independent valid sources survive');
    assert.ok(blocked); assert.equal(blocked.payload.reason, 'source-invalid');
    assert.equal(blocked.payload.spaceId, target);
    assert.equal(JSON.stringify(blocked).includes(parentId), true, 'Blocked source retains the parent event reference');
    if (invalid?.payload?.text) assert.equal(JSON.stringify(blocked).includes(invalid.payload.text), false, 'Rejected bytes stay out of the compact source');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), data, 'Reading retains the raw auxiliary field');

    const notices = []; saved.onQueueOutcome = value => notices.push(value);
    const itemId = saved.queueAdd('Still writable synthetic task', null, target);
    saved.queueMarkSent(target, itemId, 'member-a', 'Member A', Date.now());
    saved.queueSettle(target, itemId, 'failed', 'send-unconfirmed', 'Member A');
    saved.queueAdd('Other space still writable', null, good);
    assert.equal(notices.length, 1, 'Existing B1 delivery still runs');
    assert.equal(saved.queueFind(target, itemId).status, 'failed');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawTarget = target === 'shared' ? raw : raw.rooms.find(value => value.id === target);
    assert.deepEqual(rawTarget.events.find(event => event.id === parentId).butlerSource, invalid, 'Ordinary writes retain raw source evidence');
    assert.equal(f.reopen().butlerSources().some(source => source.eventId === goodSource.eventId), true);
  });
}

test('secret-shaped queue text does not enter the compact B4 source', t => {
  const f = fixture(t), text = 'DEEPSEEK_API_KEY=SYNTHETIC_NOT_A_KEY';
  const id = f.sent(text);
  f.room.queueSettle('shared', id, 'waiting', '', 'Member A', '', 'Synthetic question?');
  const [source] = f.room.butlerSources();
  assert.ok(source); assert.equal(source.kind, 'blocked');
  assert.equal(source.payload.reason, 'input-rejected');
  assert.equal(JSON.stringify(source).includes(text), false);
  assert.equal(source.payload.itemId, id);
});

for (const scope of ['shared', 'named']) test(`the ${scope} renderer projection strips only internal B4 event fields`, t => {
  const f = fixture(t), other = f.room.create('Other synthetic space'), target = scope === 'shared' ? 'shared' : other;
  f.room.queueSettle(target, f.sent('Approved synthetic task', target), 'waiting', '', 'Member A', '', 'Synthetic choice?');
  f.room.rename('Synthetic outward projection', target);
  const events = f.room.metadata(target).events;
  const last = events.at(-1);
  last.butlerSource = { opaque: 'SYNTHETIC_INTERNAL_AUX_BYTES' };
  last.visibleExtra = { label: 'Preserve another event field' };
  f.room.update({}, undefined, target);
  const before = JSON.stringify(f.room.metadata(target)), file = target === 'shared' ? f.room.file : f.room.spacesFile;
  const disk = fs.readFileSync(file, 'utf8');
  const projected = f.room.apply({ sessions: [], rooms: [] }, target);
  const output = projected.rooms.find(value => value.id === target).events;
  assert.equal(output.length, events.length);
  for (const [index, event] of output.entries()) {
    const expected = { ...events[index] }; delete expected.butlerSource;
    assert.equal(Object.hasOwn(event, 'butlerSource'), false);
    assert.deepEqual(event, expected, 'Every other event field, identity and UI message is unchanged');
  }
  assert.equal(JSON.stringify(projected).includes('SYNTHETIC_INTERNAL_AUX_BYTES'), false);
  assert.equal(projected.room.events, output);
  assert.equal(JSON.stringify(f.room.metadata(target)), before);
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  assert.deepEqual(f.reopen().metadata(target).events.at(-1).butlerSource, last.butlerSource);
});

test('the merged-block renderer projection also strips B4 fields without changing stored block events', t => {
  const f = fixture(t), target = f.room.create('Synthetic merged target');
  const event = { id: 'synthetic-merged-event', role: 'system', kind: 'queue', time: 123, text: 'Visible original event',
    uiMessage: { key: 'notice.queue.waiting', params: { name: 'Member A', text: 'Synthetic task' } },
    visibleExtra: ['Keep this event property'], butlerSource: { opaque: 'SYNTHETIC_MERGED_INTERNAL_BYTES' } };
  // Exercise only the outward projection of already-held merge metadata. The
  // merge protocol and its binding checks have their own source/runtime suites.
  const merge = { stage: 'ready', imported: true, failures: [], sources: [], batch: {
    operationId: 'synthetic-merge', binding: 'synthetic-binding', sources: [], blocks: [
      { roomId: 'shared', name: 'Source', notes: null, events: [event] }] } };
  f.room.metadata(target).merge = merge;
  const before = structuredClone(merge);
  const projected = f.room.apply({ sessions: [], rooms: [] }, target);
  const [output] = projected.room.merge.events[0].events, expected = { ...event }; delete expected.butlerSource;
  assert.equal(Object.hasOwn(output, 'butlerSource'), false); assert.deepEqual(output, expected);
  assert.equal(JSON.stringify(projected).includes('SYNTHETIC_MERGED_INTERNAL_BYTES'), false);
  assert.deepEqual(f.room.metadata(target).merge, before);
  output.visibleExtra.push('Mutate detached output');
  assert.deepEqual(f.room.metadata(target).merge, before, 'Merged output retains its prior deep-copy boundary');
});
