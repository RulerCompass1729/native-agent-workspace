'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerBusiness, MAX_BYTES, MAX_LIMIT, MAX_WINDOW, MAX_SCAN_RECORDS, MAX_SPACES } = require('../butler-business.cjs');
const { RoomState } = require('../room-state.cjs');
const { ButlerRole } = require('../butler-role.cjs');
const { QUEUE_LIMIT } = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000, SECRET_SHAPE = 'Authorization: Bearer synthetic-placeholder';
const runner = { runnerRef: 'butler-runner', backendRef: 'butler-backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const code = expected => error => error.code === expected;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-business-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW; t.mock.method(Date, 'now', () => now);
  const person = Symbol('person'), role = new ButlerRole(directory, { authorizePerson: value => value === person });
  const actor = { id: 'butler-a', nativeId: 'native-a', provider: 'dsh', state: 'idle', roomIds: [], runner };
  role.set(person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 0);
  const room = new RoomState(directory), records = [actor], expected = { selectionRevision: 1, runnerRef: runner.runnerRef };
  const view = () => ({ records });
  const bind = () => new ButlerBusiness({ role, roomState: room, view }).bind(actor, expected);
  return { directory, person, role, actor, records, expected, room, view, bind, at: value => { now = value; } };
}
function read(capability, query) { return capability.invoke('readBusiness', query); }
function ready(f, text = 'Full synthetic task', spaceId = 'shared') {
  const itemId = f.room.queueAdd(text, null, spaceId);
  f.room.queueMarkSent(spaceId, itemId, 'worker-a', 'Synthetic worker', Date.now());
  f.room.queueSettle(spaceId, itemId, 'done', '', 'Synthetic worker', 'Private native reply stays private', undefined, { branch: 'lane/synthetic', commit: 'abcdef1234567' });
  return { itemId, event: f.room.metadata(spaceId).events.findLast(event => event.monitor?.kind === 'ready') };
}
function poison(object, names, hit) {
  for (const name of names) Object.defineProperty(object, name, { configurable: true, enumerable: true,
    get() { hit(); throw Error('Private field accessed: ' + name); } });
}

test('dedicated catalog and invoke expose only the read capability, with no approval escape or new activation', t => {
  const f = fixture(t), capability = f.bind(), files = fs.readdirSync(f.directory), roleBefore = fs.readFileSync(f.role.file);
  assert.deepEqual(capability.catalog().methods.map(method => method.name), ['readBusiness']);
  for (const method of ['initial', 'nativeHistory', 'observe', 'terminalSnapshot', 'spaceFiles', 'ownSession', 'session', 'send', 'queueAdd'])
    assert.throws(() => capability.invoke(method, { approved: true, sessionId: f.actor.id }), code('ERR_BUTLER_BUSINESS_METHOD'));
  for (const query of [{ kind: 'session', sessionId: f.actor.id }, { kind: 'queue', spaceId: 'shared', approved: true }, { kind: 'spaces', actor: f.actor }])
    assert.throws(() => read(capability, query), code('ERR_BUTLER_BUSINESS_QUERY'));
  const result = read(capability, { kind: 'spaces' });
  assert.equal(result.activation, 'off'); assert.equal(result.recordPeriod, 'off'); assert.equal(f.role.current().mode, 'record-only');
  assert.deepEqual(fs.readdirSync(f.directory), files); assert.deepEqual(fs.readFileSync(f.role.file), roleBefore);
});

test('only an exact designated record binds, and each old closure rechecks native identity and designation', t => {
  const f = fixture(t), business = new ButlerBusiness({ role: f.role, roomState: f.room, view: f.view });
  assert.throws(() => business.bind({ ...f.actor }, f.expected), code('ERR_BUTLER_UNAUTHORIZED'));
  const other = { ...f.actor, id: 'other', nativeId: 'other-native' }; f.records.push(other);
  assert.throws(() => business.bind(other, f.expected), code('ERR_BUTLER_UNAUTHORIZED'));
  const bound = f.bind(); f.actor.nativeId = 'changed-native';
  assert.throws(() => bound.catalog(), code('ERR_BUTLER_UNAUTHORIZED')); f.actor.nativeId = 'native-a';
  f.role.set(f.person, { identity: { sessionId: other.id, nativeId: other.nativeId }, runner }, 1);
  assert.throws(() => read(bound, { kind: 'spaces' }), code('ERR_BUTLER_UNAUTHORIZED'));
  const replacement = business.bind(other, { ...f.expected, selectionRevision: 2 }); f.role.revoke(f.person, 2);
  assert.throws(() => replacement.catalog(), code('ERR_BUTLER_UNAUTHORIZED'));
});

test('a bound capability follows fresh trusted record objects but never a changed provider, membership or runner', t => {
  const f = fixture(t), bound = f.bind(), original = { ...f.actor };
  f.records[0] = { ...original }; assert.equal(bound.catalog().readOnly, true);
  for (const changed of [{ provider: 'claude' }, { roomIds: ['shared'] }, { runner: { ...runner, backendRef: 'other-backend' } }, { nativeContextPending: true }]) {
    f.records[0] = { ...original, ...changed };
    assert.throws(() => read(bound, { kind: 'spaces' }), code('ERR_BUTLER_UNAUTHORIZED'));
  }
});

test('active metadata index includes readonly spaces; archive and queue bodies require explicit requests', t => {
  const f = fixture(t), archived = f.room.create('Archived synthetic team'), readonly = f.room.create('Readonly synthetic team');
  const text = 'Complete synthetic archived task ' + '文'.repeat(5000);
  f.room.queueAdd(text, null, archived); f.room.update({ archived: true }, undefined, archived); f.room.gates.add(`room:${readonly}`);
  const capability = f.bind(), active = read(capability, { kind: 'spaces' });
  assert.deepEqual(active.records.map(row => row.spaceId), ['shared', readonly]);
  assert.equal(active.records.find(row => row.spaceId === readonly).writable, false);
  assert.equal(JSON.stringify(active).includes(text), false);
  const all = read(capability, { kind: 'spaces', includeArchived: true }); assert.equal(all.records.length, 3);
  const queue = read(capability, { kind: 'queue', spaceId: archived });
  assert.equal(queue.records[0].text, text); assert.equal(queue.archived, true); assert.equal(queue.writable, false); assert.equal(queue.readOnly, true);
  assert.equal(capability.queueAdd, undefined); assert.equal(f.room.metadata(archived).queue.length, 1);
});

test('index, queue and legacy delivery metadata never touch private getters or native reply text', t => {
  const f = fixture(t); f.room.queueAdd('The approved task body', null); let hits = 0;
  const item = f.room.value.queue[0], event = f.room.value.events[0], text = item.text;
  poison(f.actor, ['messages', 'nativeHistory', 'prompt', 'env', 'terminalSnapshot'], () => { hits++; });
  poison(f.room.value, ['messages', 'controlAudit', 'prompt'], () => { hits++; });
  poison(item, ['text', 'reply', 'privateHistory'], () => { hits++; });
  poison(event, ['text', 'controlAudit'], () => { hits++; });
  const capability = f.bind(); read(capability, { kind: 'spaces' }); assert.equal(hits, 0);
  Object.defineProperty(item, 'text', { value: text, configurable: true, enumerable: true });
  assert.equal(read(capability, { kind: 'queue', spaceId: 'shared' }).records[0].text, text);
  assert.deepEqual(read(capability, { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW }).records, []);
  assert.equal(hits, 0);
});

test('large full queue bodies paginate under the UTF8 byte cap without cutting text or changing stable references', t => {
  const f = fixture(t), body = '文'.repeat(6000), ids = [];
  for (let i = 0; i < 7; i++) ids.push(f.room.queueAdd(body, null));
  const capability = f.bind(), rows = []; let cursor, pages = 0;
  do {
    const page = read(capability, { kind: 'queue', spaceId: 'shared', ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_BYTES); assert.ok(page.records.length <= MAX_LIMIT);
    assert.ok(page.records.length > 0); rows.push(...page.records); cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.ok(pages > 1); assert.deepEqual(rows.map(row => row.itemId), ids); assert.ok(rows.every(row => row.text === body));
  assert.equal(new Set(rows.map(row => row.recordRef)).size, ids.length);
});

test('row cursors survive reconstruction, bind complete query and expire explicitly on metadata revision changes', t => {
  const f = fixture(t); for (let i = 0; i < 5; i++) f.room.queueAdd('Task ' + i, null);
  const query = { kind: 'queue', spaceId: 'shared', limit: 2 }, first = read(f.bind(), query);
  assert.equal(first.records.length, 2); assert.equal(first.truncated, true); assert.equal(read(f.bind(), query).nextCursor, first.nextCursor);
  const second = read(f.bind(), { ...query, cursor: first.nextCursor }); assert.equal(second.records.length, 2);
  assert.notEqual(second.records[0].recordRef, first.records[0].recordRef);
  assert.throws(() => read(f.bind(), { ...query, limit: 1, cursor: first.nextCursor }), code('ERR_BUTLER_BUSINESS_STALE'));
  const forged = JSON.parse(Buffer.from(first.nextCursor, 'base64url')); forged.position = 999999;
  assert.throws(() => read(f.bind(), { ...query, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }), code('ERR_BUTLER_BUSINESS_QUERY'));
  f.room.update({ queue: [] }, undefined);
  assert.throws(() => read(f.bind(), { ...query, cursor: first.nextCursor }), code('ERR_BUTLER_BUSINESS_STALE'));
});

test('delivery windows are inclusive, bounded and bound into paginated cursors', t => {
  const f = fixture(t); f.at(NOW - 1); ready(f, 'Before'); f.at(NOW); const middle = ready(f, 'Inside'); f.at(NOW + 1); ready(f, 'After');
  const capability = f.bind(), query = { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW };
  const exact = read(capability, query); assert.equal(exact.records.length, 1); assert.equal(exact.records[0].itemId, middle.itemId);
  assert.equal(exact.records[0].time, NOW); assert.equal(exact.records[0].sourceTask, 'Inside');
  const page = read(capability, { ...query, fromTime: NOW - 1, throughTime: NOW + 1, limit: 1 });
  assert.throws(() => read(capability, { ...query, limit: 1, cursor: page.nextCursor }), code('ERR_BUTLER_BUSINESS_STALE'));
  for (const invalid of [{ ...query, fromTime: -1 }, { ...query, throughTime: NOW - 1 }, { ...query, throughTime: NOW + MAX_WINDOW + 1 },
    { ...query, limit: 51 }, { kind: 'deliveries', spaceId: 'shared' }, { kind: 'spaces', includeArchived: 'true' }])
    assert.throws(() => read(capability, invalid), code('ERR_BUTLER_BUSINESS_QUERY'));
});

test('typed READY metadata and its complete task source remain readable after the completed queue item is trimmed', t => {
  const f = fixture(t), full = 'Preserved task ' + 'x'.repeat(5800), finished = ready(f, full), first = f.room.queueFind('shared', finished.itemId);
  const completed = [first];
  for (let i = 1; i < QUEUE_LIMIT; i++) completed.push({ id: 'finished-' + i, text: 'Synthetic done task', status: 'done', assignee: null, createdAt: NOW, finishedAt: NOW });
  f.room.update({ queue: completed }, undefined); f.room.queueAdd('Next task', null);
  assert.equal(f.room.queueItems('shared').some(item => item.id === finished.itemId), false);
  const result = read(f.bind(), { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW });
  const row = result.records.find(value => value.itemId === finished.itemId);
  assert.equal(row.branch, 'lane/synthetic'); assert.equal(row.commit, 'abcdef1234567'); assert.equal(row.sourceTask, full);
  assert.equal(row.eventId, finished.event.id); assert.match(row.itemRecordRef, /^naw:space:shared\/item:/u);
});

test('legacy valid READY monitor exposes only verified metadata; text alone and fake actor events never become delivery facts', t => {
  const f = fixture(t), saved = ready(f); delete saved.event.butlerSource;
  const ordinary = { id: 'legacy-unstructured', role: 'system', kind: 'queue', time: NOW, text: 'READY lane/guessed abcdef1' };
  const forged = { ...saved.event, id: 'fake-actor-event', role: 'assistant' };
  f.room.update({ events: [...f.room.value.events, ordinary, forged] }, undefined);
  let hits = 0; poison(ordinary, ['text'], () => { hits++; }); poison(forged, ['monitor', 'butlerSource'], () => { hits++; });
  const result = read(f.bind(), { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW });
  assert.equal(result.records.length, 1); assert.equal(result.records[0].sourceTask, undefined); assert.equal(result.records[0].sourceTaskStatus, 'unavailable');
  assert.equal(result.records[0].branch, 'lane/synthetic'); assert.equal(result.legacyDetails, 'unavailable'); assert.equal(hits, 0);
});

test('secret-shaped task bodies and rejected typed sources never appear in tool output', t => {
  const f = fixture(t); f.room.queueAdd(SECRET_SHAPE, null); const saved = ready(f, SECRET_SHAPE);
  const capability = f.bind(), queue = read(capability, { kind: 'queue', spaceId: 'shared' });
  assert.ok(queue.records.every(row => row.status === 'unavailable')); assert.equal(JSON.stringify(queue).includes(SECRET_SHAPE), false);
  const delivery = read(capability, { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW });
  assert.equal(delivery.records[0].itemId, saved.itemId); assert.equal(delivery.records[0].sourceTaskStatus, 'unavailable');
  assert.equal(JSON.stringify(delivery).includes(SECRET_SHAPE), false);
});

test('window misses have bounded metadata scans and advancing opaque cursors until the last READY is reached', t => {
  const f = fixture(t), saved = ready(f), source = [];
  for (let i = 0; i < MAX_SCAN_RECORDS * 2 + 500; i++) source.push({ id: 'unrelated-private-id-' + i, role: 'system', kind: 'control-audit', time: NOW - 1, text: 'Synthetic private history' });
  source.push(saved.event); f.room.update({ events: source }, undefined);
  let timeReads = 0, privateReads = 0;
  for (const event of source.slice(0, -1)) {
    Object.defineProperty(event, 'time', { get() { timeReads++; return NOW - 1; } });
    poison(event, ['id', 'text', 'controlAudit'], () => { privateReads++; });
  }
  const capability = f.bind(), query = { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW }; let cursor, pages = 0, found = [];
  do {
    const before = timeReads, page = read(capability, { ...query, ...(cursor ? { cursor } : {}) });
    assert.ok(page.scanned <= MAX_SCAN_RECORDS); assert.ok(timeReads - before <= MAX_SCAN_RECORDS);
    if (pages < 2) { assert.deepEqual(page.records, []); assert.equal(page.truncated, true); }
    assert.notEqual(page.nextCursor, cursor); assert.equal(JSON.stringify(page).includes('unrelated-private-id-'), false);
    found.push(...page.records); cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.equal(pages, 3); assert.equal(found.length, 1); assert.equal(found[0].itemId, saved.itemId); assert.equal(privateReads, 0);
});

test('an oversized space universe is refused before any per-space metadata enumeration', t => {
  const f = fixture(t), rooms = new Array(MAX_SPACES); let hits = 0;
  Object.defineProperty(rooms, 0, { get() { hits++; throw Error('Unbounded space scan'); } });
  f.room.spaces.rooms = rooms;
  assert.throws(() => read(f.bind(), { kind: 'spaces' }), code('ERR_BUTLER_BUSINESS_CAPACITY')); assert.equal(hits, 0);
});
