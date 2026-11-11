const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-trust-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, room: new RoomState(directory) };
}
const isolation = () => ({ v: 1, holds: { successor: { oldId: 'original', receiptId: 'synthetic-receipt' } }, faults: {}, notices: {} });

test('directory trust isolation survives restart independently of rotation storage, with detached input and reads', t => {
  const { directory, room } = setup(t), input = isolation();
  assert.equal(room.directoryTrustIsolation(), undefined);
  const revision = room.value.revision, events = [...room.value.events];
  room.saveDirectoryTrustIsolation(input);
  input.holds.successor.oldId = 'changed by caller';
  const read = room.directoryTrustIsolation(); read.holds.successor.oldId = 'changed by reader';
  assert.deepEqual(room.directoryTrustIsolation(), isolation());
  assert.deepEqual(new RoomState(directory).directoryTrustIsolation(), isolation());
  assert.equal(room.value.revision, revision); assert.deepEqual(room.value.events, events);
  assert.equal(fs.statSync(room.file).mode & 0o777, 0o600);
});

test('clearing shared and other-space history keeps root trust isolation without exposing it to renderer rooms', t => {
  const { directory, room } = setup(t), other = room.create('Synthetic other space');
  room.saveDirectoryTrustIsolation(isolation());
  room.update({ notes: 'Synthetic shared note' }); room.update({ notes: 'Synthetic other note' }, undefined, other);
  room.clear(); room.clear(undefined, other);
  const loaded = new RoomState(directory);
  assert.deepEqual(loaded.directoryTrustIsolation(), isolation());
  assert.equal(loaded.value.notes, ''); assert.equal(loaded.metadata(other).notes, '');
  for (const projected of loaded.apply({ sessions: [], rooms: [] }).rooms) assert.equal(Object.hasOwn(projected, 'directoryTrustIsolation'), false);
});

test('malformed isolation payloads remain raw recovery data without making room metadata unreadable', t => {
  const { directory, room } = setup(t);
  for (const raw of [null, 'damaged', [], { v: 'unknown', holds: { successor: 'damaged entry' } }]) {
    fs.writeFileSync(room.file, JSON.stringify({ ...room.value, directoryTrustIsolation: raw }), { mode: 0o600 });
    const loaded = new RoomState(directory);
    assert.equal(loaded.warning, ''); assert.equal(loaded.spacesWarning, '');
    assert.deepEqual(loaded.directoryTrustIsolation(), raw);
    assert.equal(loaded.metadata('shared').name, room.value.name);
  }
});

test('a failed isolation disk write leaves the prior in-memory and persisted value intact', t => {
  const { directory, room } = setup(t); room.saveDirectoryTrustIsolation(isolation());
  const before = room.value, bytes = fs.readFileSync(room.file, 'utf8');
  t.mock.method(room, 'write', () => { throw Error('Synthetic isolation write failure'); });
  assert.throws(() => room.saveDirectoryTrustIsolation({ ...isolation(), holds: {} }), /write failure/);
  assert.equal(room.value, before); assert.deepEqual(room.directoryTrustIsolation(), isolation());
  assert.equal(fs.readFileSync(room.file, 'utf8'), bytes);
  assert.deepEqual(new RoomState(directory).directoryTrustIsolation(), isolation());
});

test('unserializable isolation saves fail before any mutation or disk write', t => {
  const { room } = setup(t), cycle = {}; cycle.self = cycle;
  const bad = [undefined, null, [], 'damaged', 1, true, cycle, { number: 1n }, { missing: undefined }, { method() {} }, { number: Infinity }, { date: new Date(0) }];
  let writes = 0; t.mock.method(room, 'write', () => { writes++; });
  const before = room.value;
  for (const payload of bad) assert.throws(() => room.saveDirectoryTrustIsolation(payload));
  assert.equal(writes, 0); assert.equal(room.value, before); assert.equal(room.directoryTrustIsolation(), undefined);
});
