'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerBusiness, MAX_BYTES, MAX_LIMIT, MAX_WINDOW, MAX_SCAN_RECORDS, MAX_SPACES } = require('../butler-business.cjs');
const { RoomState } = require('../room-state.cjs');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerReadAudit } = require('../butler-read-audit.cjs');
const { QUEUE_LIMIT } = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000, SECRET_SHAPE = 'Authorization: Bearer synthetic-placeholder';
const runner = { runnerRef: 'butler-runner', backendRef: 'butler-backend', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const code = expected => error => error.code === expected;
// Contract literals deliberately do not reuse implementation fields or derive
// an expected shape from another projected row.
const ROW_KEYS = {
  space: ['archived', 'metadataRevision', 'name', 'queueCounts', 'readOnly', 'recordRef', 'spaceId', 'spaceRecordRef', 'time', 'writable'],
  unavailable: ['archived', 'metadataRevision', 'readOnly', 'recordRef', 'spaceId', 'spaceRecordRef', 'status', 'time', 'writable'],
  queue: ['archived', 'assignee', 'itemId', 'metadataRevision', 'readOnly', 'recordRef', 'spaceId', 'spaceRecordRef', 'status', 'text', 'time', 'writable'],
  queueTimed: ['archived', 'assignee', 'finishedAt', 'itemId', 'metadataRevision', 'readOnly', 'recordRef', 'sentAt', 'spaceId', 'spaceRecordRef', 'status', 'text', 'time', 'writable'],
  queueReady: ['archived', 'assignee', 'finishedAt', 'itemId', 'metadataRevision', 'readOnly', 'ready', 'recordRef', 'sentAt', 'spaceId', 'spaceRecordRef', 'status', 'text', 'time', 'writable'],
  queueReadyUnavailable: ['archived', 'assignee', 'finishedAt', 'itemId', 'metadataRevision', 'readOnly', 'readyStatus', 'recordRef', 'sentAt', 'spaceId', 'spaceRecordRef', 'status', 'text', 'time', 'writable'],
  readyTyped: ['archived', 'branch', 'commit', 'eventId', 'itemId', 'itemRecordRef', 'kind', 'metadataRevision', 'readOnly', 'recordRef', 'sourceTask', 'sourceTaskStatus', 'spaceId', 'spaceRecordRef', 'status', 'time', 'writable'],
  readyLegacy: ['archived', 'branch', 'commit', 'eventId', 'itemId', 'itemRecordRef', 'kind', 'metadataRevision', 'readOnly', 'recordRef', 'sourceTaskStatus', 'spaceId', 'spaceRecordRef', 'status', 'time', 'writable'],
  outcome: ['archived', 'eventId', 'itemId', 'itemRecordRef', 'kind', 'metadataRevision', 'readOnly', 'recordRef', 'spaceId', 'spaceRecordRef', 'status', 'time', 'writable'],
};
const PAGE_KEYS = {
  spaces: ['activation', 'kind', 'limit', 'nextCursor', 'readOnly', 'recordPeriod', 'records', 'scanned', 'truncated'],
  queue: ['activation', 'archived', 'kind', 'limit', 'metadataRevision', 'nextCursor', 'readOnly', 'recordPeriod', 'records', 'scanned', 'spaceId', 'spaceRecordRef', 'truncated', 'writable'],
  deliveries: ['activation', 'archived', 'coverage', 'fromTime', 'kind', 'legacyDetails', 'limit', 'metadataRevision', 'nextCursor', 'readOnly', 'recordPeriod', 'records', 'scanned', 'spaceId', 'spaceRecordRef', 'throughTime', 'truncated', 'writable'],
};
const READY_KEYS = ['branch', 'commit'];
const COUNT_KEYS = ['cancelled', 'done', 'failed', 'queued', 'sent', 'waiting'];
const HIDDEN_FIELDS = { reason: 'Synthetic private reason', question: 'Synthetic private question?',
  reply: 'Synthetic private native reply', memberName: 'Synthetic private member', privateHistory: 'Synthetic private history', privateExtra: 'Synthetic private extension' };
function rowKeys(row, expected) { assert.deepEqual(Object.keys(row).sort(), expected); }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-business-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW; t.mock.method(Date, 'now', () => now);
  const person = Symbol('person'), role = new ButlerRole(directory, { authorizePerson: value => value === person });
  const actor = { id: 'butler-a', nativeId: 'native-a', provider: 'dsh', state: 'idle', roomIds: [], runner };
  role.set(person, { identity: { sessionId: actor.id, nativeId: actor.nativeId }, runner }, 0);
  const room = new RoomState(directory), records = [actor], expected = { selectionRevision: 1, runnerRef: runner.runnerRef };
  const view = () => ({ records });
  const readAudit = new ButlerReadAudit(directory, { authorizePerson: value => value === person, now: () => now });
  const bind = () => new ButlerBusiness({ role, roomState: room, view, readAudit, dataDir: directory }).bind(actor, expected);
  return { directory, person, role, actor, records, expected, room, view, bind, readAudit, at: value => { now = value; } };
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
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [...files, 'butler-business-reads.jsonl'].sort());
  assert.deepEqual(fs.readFileSync(f.role.file), roleBefore);
});

test('only an exact designated record binds, and each old closure rechecks native identity and designation', t => {
  const f = fixture(t), business = new ButlerBusiness({ role: f.role, roomState: f.room, view: f.view, readAudit: f.readAudit, dataDir: f.directory });
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

test('a bad rotation tail blocks both old business closures and new bindings while human snapshot/revoke remain usable', t => {
  const f = fixture(t), bound = f.bind(); assert.equal(bound.catalog().readOnly, true);
  fs.writeFileSync(f.role.logFile, '{partial-tail\n', { mode: 0o600 });
  assert.throws(() => bound.catalog(), code('ERR_BUTLER_STATE'));
  assert.throws(() => read(bound, { kind: 'spaces' }), code('ERR_BUTLER_STATE'));
  assert.throws(() => f.bind(), code('ERR_BUTLER_STATE'));
  assert.equal(f.role.snapshot().revision, 1); f.role.revoke(f.person, 1);
  assert.throws(() => bound.catalog(), code('ERR_BUTLER_UNAUTHORIZED'));
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

test('space rows have exactly their public keys; invalid names yield only the nine unavailable metadata keys', t => {
  const f = fixture(t); f.room.value.queue = [];
  for (const status of ['queued', 'sent', 'waiting', 'done', 'failed', 'cancelled'])
    f.room.value.queue.push({ id: 'synthetic-' + status, text: 'Synthetic task', status, assignee: null, createdAt: NOW, ...HIDDEN_FIELDS });
  Object.assign(f.room.value, HIDDEN_FIELDS);
  const capability = f.bind(), healthy = read(capability, { kind: 'spaces' }).records[0];
  rowKeys(healthy, ROW_KEYS.space); rowKeys(healthy.queueCounts, COUNT_KEYS);
  assert.deepEqual(healthy.queueCounts, { queued: 1, sent: 1, waiting: 1, done: 1, failed: 1, cancelled: 1 });
  for (const name of ['', ' \t ', SECRET_SHAPE]) {
    f.room.value.name = name;
    const [unavailable] = read(capability, { kind: 'spaces' }).records;
    rowKeys(unavailable, ROW_KEYS.unavailable);
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.time, null);
    assert.equal(Object.hasOwn(unavailable, 'name'), false);
    assert.equal(Object.hasOwn(unavailable, 'queueCounts'), false);
    assert.equal(JSON.stringify(unavailable).includes(SECRET_SHAPE), false);
  }
});

test('queue rows pin all optional timestamp and READY variants without exporting stored reason, question or reply', t => {
  const f = fixture(t), itemId = f.room.queueAdd('Approved synthetic task', null), item = f.room.queueFind('shared', itemId);
  Object.assign(item, HIDDEN_FIELDS);
  const capability = f.bind(), projected = () => read(capability, { kind: 'queue', spaceId: 'shared' }).records[0];
  rowKeys(projected(), ROW_KEYS.queue);
  item.sentAt = NOW + 1; item.finishedAt = NOW + 2;
  const timed = projected(); rowKeys(timed, ROW_KEYS.queueTimed);
  assert.equal(timed.sentAt, NOW + 1); assert.equal(timed.finishedAt, NOW + 2);
  item.ready = { branch: 'lane/synthetic', commit: 'abcdef1234567', ...HIDDEN_FIELDS };
  const withReady = projected(); rowKeys(withReady, ROW_KEYS.queueReady); rowKeys(withReady.ready, READY_KEYS);
  assert.deepEqual(withReady.ready, { branch: 'lane/synthetic', commit: 'abcdef1234567' });
  item.ready = { branch: 'invalid branch', commit: 'abcdef1234567' };
  const invalidReady = projected(); rowKeys(invalidReady, ROW_KEYS.queueReadyUnavailable);
  assert.equal(invalidReady.readyStatus, 'unavailable');
  item.text = SECRET_SHAPE;
  const unavailable = projected(); rowKeys(unavailable, ROW_KEYS.unavailable);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.time, null);
  assert.equal(JSON.stringify(unavailable).includes(SECRET_SHAPE), false);
});

test('typed, legacy and rejected READY rows expose exactly their respective source and metadata keys', t => {
  const f = fixture(t), saved = ready(f, 'Approved full source task');
  const item = f.room.queueFind('shared', saved.itemId), parent = saved.event, typedSource = structuredClone(parent.butlerSource);
  Object.assign(item, HIDDEN_FIELDS); Object.assign(parent, HIDDEN_FIELDS);
  const capability = f.bind(), projected = () => read(capability, { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW }).records[0];
  const typed = projected(); rowKeys(typed, ROW_KEYS.readyTyped);
  assert.equal(typed.sourceTask, 'Approved full source task'); assert.equal(typed.sourceTaskStatus, 'available');
  delete parent.butlerSource;
  const legacy = projected(); rowKeys(legacy, ROW_KEYS.readyLegacy);
  assert.equal(legacy.sourceTaskStatus, 'unavailable'); assert.equal(Object.hasOwn(legacy, 'sourceTask'), false);
  parent.butlerSource = { ...typedSource, payload: { ...typedSource.payload, question: 'Rejected auxiliary question' } };
  const invalidSource = projected(); rowKeys(invalidSource, ROW_KEYS.readyLegacy);
  assert.equal(invalidSource.sourceTaskStatus, 'unavailable'); assert.equal(Object.hasOwn(invalidSource, 'sourceTask'), false);
  assert.equal(JSON.stringify(invalidSource).includes('Rejected auxiliary question'), false);
  parent.monitor.key = 'ready:shared:wrong-item';
  const unavailable = projected(); rowKeys(unavailable, ROW_KEYS.unavailable);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.time, NOW);
});

test('decision and failure delivery rows have only the exact ID, status and shared metadata fields', t => {
  const f = fixture(t);
  for (const status of ['waiting', 'failed']) {
    const itemId = f.room.queueAdd('Synthetic outcome task ' + status, null);
    f.room.queueMarkSent('shared', itemId, 'worker-a', 'Synthetic worker name', NOW);
    f.room.queueSettle('shared', itemId, status, status === 'failed' ? 'Synthetic private failure detail' : '',
      'Synthetic worker name', 'Synthetic private native reply', 'Synthetic question for the person?');
    Object.assign(f.room.queueFind('shared', itemId), HIDDEN_FIELDS);
  }
  for (const parent of f.room.value.events) if (parent.butlerSource) Object.assign(parent, HIDDEN_FIELDS);
  const rows = read(f.bind(), { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW }).records;
  assert.equal(rows.length, 2);
  for (const row of rows) rowKeys(row, ROW_KEYS.outcome);
  assert.deepEqual(rows.map(row => [row.kind, row.status]), [['decision', 'waiting'], ['failure', 'failed']]);
  for (const hidden of ['title', 'reason', 'question', 'reply', 'memberName', 'privateHistory', 'privateExtra'])
    assert.ok(rows.every(row => !Object.hasOwn(row, hidden)));
});

test('the literal key contract rejects an extra reason or question in an in-memory negative control', t => {
  const f = fixture(t); f.room.queueAdd('Synthetic task', null);
  const [row] = read(f.bind(), { kind: 'queue', spaceId: 'shared' }).records;
  rowKeys(row, ROW_KEYS.queue);
  for (const extra of [{ reason: 'Synthetic accidental field' }, { question: 'Synthetic accidental question?' }])
    assert.throws(() => rowKeys({ ...row, ...extra }, ROW_KEYS.queue), assert.AssertionError);
});

test('business page envelopes have literal keys and never gain human audit storage or log capabilities', t => {
  const f = fixture(t), capability = f.bind();
  for (const query of [{ kind: 'spaces' }, { kind: 'queue', spaceId: 'shared' },
    { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW }]) {
    const result = read(capability, query); rowKeys(result, PAGE_KEYS[query.kind]);
    assert.equal(result.activation, 'off'); assert.equal(result.recordPeriod, 'off');
    assert.equal(Object.hasOwn(result, 'storage'), false); assert.equal(Object.hasOwn(result, 'audit'), false);
    assert.throws(() => rowKeys({ ...result, storage: { usedBytes: 0 } }, PAGE_KEYS[query.kind]), assert.AssertionError);
  }
  assert.deepEqual(capability.catalog().methods.map(value => value.name), ['readBusiness']);
});

test('rejected decision and failure sources retain only the literal unavailable metadata keys', t => {
  const f = fixture(t);
  for (const status of ['waiting', 'failed']) {
    const id = f.room.queueAdd('Synthetic source ' + status, null);
    f.room.queueMarkSent('shared', id, 'worker-a', 'Synthetic worker', NOW);
    f.room.queueSettle('shared', id, status, status === 'failed' ? 'Synthetic failure' : '', 'Synthetic worker', '', 'Synthetic decision?');
  }
  const sources = f.room.value.events.filter(event => ['decision', 'failure'].includes(event.butlerSource?.kind));
  assert.deepEqual(sources.map(event => event.butlerSource.kind), ['decision', 'failure']);
  for (const source of sources) source.butlerSource.payload.unrecognized = 'Synthetic rejected private detail';
  const result = read(f.bind(), { kind: 'deliveries', spaceId: 'shared', fromTime: NOW, throughTime: NOW });
  assert.equal(result.records.length, 2);
  for (const row of result.records) { rowKeys(row, ROW_KEYS.unavailable); assert.equal(row.status, 'unavailable'); assert.equal(row.time, NOW); }
  assert.equal(JSON.stringify(result).includes('Synthetic rejected private detail'), false);
});
