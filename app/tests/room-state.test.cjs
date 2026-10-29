const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, room: new RoomState(dir) };
}
test('room metadata persists privately, conflicts preserve edits, native records are untouched', t => {
  const { dir, room } = setup(t);
  const original = { room: { messages: [{ id: 'shared', text: 'selected' }] }, sessions: [{ id: 'one', nativeId: 'native', messages: ['private'], roomId: null }] };
  const copy = structuredClone(original);
  room.rename('项目核查'); const revision = room.value.revision; room.notes('共同目标', revision);
  assert.throws(() => room.notes('stale edit', revision), /另一个窗口/);
  const saved = new RoomState(dir); assert.equal(saved.value.notes, '共同目标');
  assert.equal(saved.value.name, '项目核查'); assert.equal(fs.statSync(room.file).mode & 0o777, 0o600);
  assert.equal(saved.apply(original).room.messages, original.room.messages); assert.deepEqual(original, copy);
});
test('confirmed membership transitions serialize across windows, deduplicate repeat drops and never send prompts', async t => {
  const { room } = setup(t), record = { id: 'one', name: 'Agent', roomId: null, nativeId: 'native', pid: 123 };
  const calls = [], client = { call: async (method, id, join) => {
    calls.push(method);
    if (method === 'initial') return { sessions: [{ ...record }] };
    if (method === 'join') record.roomId = join ? 'shared' : null;
  } };
  const first = room.membership(client, 'one', true, 'Display');
  assert.equal(calls[0], 'pause', 'Human intervention registered before waiting');
  await Promise.all([first, room.membership(client, 'one', true), room.membership(client, 'one', false)]);
  assert.deepEqual(room.value.events.map(e => e.kind), ['join', 'leave']);
  assert.equal(record.roomId, null); assert.equal(record.nativeId, 'native'); assert.equal(record.pid, 123);
  assert.ok(calls.every(method => ['initial', 'pause', 'join'].includes(method)));
});
test('failed or unconfirmed membership has no fabricated event; subsequent operation remains usable', async t => {
  const { room } = setup(t); let fail = true, roomId = null;
  const client = { call: async (method, id, join) => {
    if (method === 'initial') return { sessions: [{ id: 'one', roomId }] };
    if (method === 'join') { if (fail) throw Error('synthetic failure'); roomId = join ? 'shared' : null; }
  } };
  await assert.rejects(room.membership(client, 'one', true)); assert.equal(room.value.events.length, 0);
  fail = false; await room.membership(client, 'one', true); assert.equal(room.value.events.length, 1);
  client.call = async method => method === 'initial' ? { sessions: [{ id: 'one', roomId }] } : undefined;
  await assert.rejects(room.membership(client, 'one', false), /未确认/); assert.equal(room.value.events.length, 1);
});
test('clear removes timeline and all note revisions, retaining room name', t => {
  const { dir, room } = setup(t); room.rename('Keep'); room.notes('Sensitive synthetic note', room.value.revision); room.clear();
  const saved = new RoomState(dir); assert.equal(saved.value.name, 'Keep'); assert.equal(saved.value.notes, ''); assert.deepEqual(saved.value.events, []);
  assert.ok(!fs.readFileSync(room.file, 'utf8').includes('Sensitive'));
});
test('atomic save failure preserves existing file and reports membership already changed', async t => {
  const { room } = setup(t); room.rename('Original'); const before = fs.readFileSync(room.file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Error('Synthetic disk full'); });
  assert.throws(() => room.rename('Replacement'), /未能保存/); assert.equal(fs.readFileSync(room.file, 'utf8'), before);
  let roomId = null; const client = { call: async method => {
    if (method === 'initial') return { sessions: [{ id: 'one', name: 'Agent', roomId }] };
    if (method === 'join') roomId = 'shared';
  } };
  await assert.rejects(room.membership(client, 'one', true), /成员关系已更新/); assert.equal(roomId, 'shared'); assert.equal(fs.readFileSync(room.file, 'utf8'), before);
});
test('damaged and symlinked metadata are not overwritten', t => {
  const { dir, room } = setup(t); fs.writeFileSync(room.file, '{broken', { mode: 0o600 });
  let loaded = new RoomState(dir); assert.match(loaded.warning, /无法读取/); assert.throws(() => loaded.rename('Lost')); assert.equal(fs.readFileSync(room.file, 'utf8'), '{broken');
  fs.unlinkSync(room.file); const other = path.join(dir, 'other'); fs.writeFileSync(other, 'original'); fs.symlinkSync(other, room.file);
  loaded = new RoomState(dir); assert.throws(() => loaded.clear()); assert.equal(fs.readFileSync(other, 'utf8'), 'original');
});
test('a late clear cannot erase notes saved after its confirmation', t => {
  const { room } = setup(t); room.notes('Earlier note', 0); const revision = room.value.revision;
  room.notes('Newer note', revision); assert.throws(() => room.clear(revision), /清除期间更新/);
  assert.equal(room.value.notes, 'Newer note'); assert.ok(room.value.events.some(e => e.text.includes('Newer note')));
});
function archiveFixture() {
  const records = [{ id: 'one', name: 'Duplicate', roomId: 'shared', nativeId: 'native-one', pid: 123, liveDraft: 'private' }, { id: 'two', name: 'Duplicate', roomId: 'shared', nativeId: 'native-two', pid: 456 }];
  const calls = [];
  const client = { call: async (method, id, join) => { calls.push([method, id, join]); if (method === 'initial') return { sessions: structuredClone(records) }; if (method === 'join') records.find(s => s.id === id).roomId = join ? 'shared' : null; } };
  return { records, calls, client };
}
test('member order persists independently of notes revisions, events, sidebar and native records', t => {
  const { dir, room } = setup(t), { records } = archiveFixture();
  records.push({ id: 'three', roomId: 'shared', nativeId: 'native-three', liveDraft: 'unsent' });
  const original = structuredClone(records);
  room.notes('An open note', room.value.revision); const revision = room.value.revision, events = [...room.value.events];
  room.moveMember({ id: 'one', target: 'three', after: true }, records);
  assert.deepEqual(room.value.memberOrder, ['two', 'three', 'one']); assert.equal(room.value.revision, revision); assert.deepEqual(room.value.events, events);
  assert.deepEqual(records, original);
  room.notes('Note edited before the display move', revision);
  const clearRevision = room.value.revision;
  room.moveMember({ id: 'one', target: 'two', after: false }, records); room.clear(clearRevision);
  const saved = new RoomState(dir); assert.equal(saved.warning, ''); assert.deepEqual(saved.value.memberOrder, ['one', 'two', 'three']);
  const snapshot = { sessions: records, sidebar: { order: ['three', 'two', 'one'] }, room: { messages: ['shared'] } };
  const display = saved.apply(snapshot); assert.deepEqual(display.sessions.map(s => s.id), ['one', 'two', 'three']);
  assert.equal(display.sidebar, snapshot.sidebar); assert.equal(display.room.messages, snapshot.room.messages);
  assert.deepEqual(display.room.memberOrder, saved.value.memberOrder); display.room.memberOrder.reverse(); assert.deepEqual(saved.value.memberOrder, ['one', 'two', 'three']);
});
test('member order validates current membership and archive gates without changing membership', t => {
  const { room } = setup(t), { records } = archiveFixture();
  records.push({ id: 'solo', roomId: null }, { id: 'archived', roomId: 'shared', archived: true });
  const original = JSON.stringify(room.value);
  for (const change of [null, [], 'one', new Date(), {}, { id: 'one', target: 'two', after: 1 },
    { id: 'one', target: 'missing', after: false }, { id: 'solo', target: 'two', after: false },
    { id: 'one', target: 'archived', after: true }, { id: 'x'.repeat(101), target: 'two', after: false }, { id: 'one\n', target: 'two', after: true }]) {
    assert.throws(() => room.moveMember(change, records)); assert.equal(JSON.stringify(room.value), original);
  }
  for (const id of ['one', 'two', 'room']) { room.gates.add(id); assert.throws(() => room.moveMember({ id: 'one', target: 'two', after: true }, records)); room.gates.delete(id); }
  room.value.archivedSessions = ['one']; assert.throws(() => room.moveMember({ id: 'one', target: 'two', after: true }, records)); room.value.archivedSessions = [];
  room.value.archived = true; assert.throws(() => room.moveMember({ id: 'one', target: 'two', after: true }, records)); room.value.archived = false;
  t.mock.method(room, 'commit', () => { throw Error('Must not write a no-op'); });
  assert.doesNotThrow(() => room.moveMember({ id: 'one', target: 'one', after: true }, records));
});
test('member display order retains existing detached/archived IDs, appends new IDs and prunes only absent records', t => {
  const { room } = setup(t), { records } = archiveFixture();
  room.value.memberOrder = ['absent', 'solo', 'one', 'archived', 'two']; room.value.restoreMembers = ['archived'];
  records.push({ id: 'solo', roomId: null }, { id: 'archived', archived: true }, { id: 'new', roomId: 'shared' });
  room.moveMember({ id: 'new', target: 'one', after: false }, records);
  assert.deepEqual(room.value.memberOrder, ['solo', 'new', 'one', 'archived', 'two']); assert.deepEqual(room.value.restoreMembers, ['archived']);
});
test('damaged display order falls back safely without blocking native authorization or overwriting notes', t => {
  const { dir, room } = setup(t); room.notes('Preserved note', 0);
  for (const order of [null, 'bad', {}, ['one', 'one', null, 'two', 'unsafe\n'], Array(10001).fill('one')]) {
    const saved = { ...room.value, memberOrder: order }; fs.writeFileSync(room.file, JSON.stringify(saved), { mode: 0o600 });
    const loaded = new RoomState(dir); assert.equal(loaded.warning, ''); assert.equal(loaded.value.notes, 'Preserved note');
    assert.deepEqual(loaded.value.events, room.value.events); assert.doesNotThrow(() => loaded.assertAvailable('one', true));
    assert.deepEqual(loaded.value.memberOrder, Array.isArray(order) && order.length < 10001 ? ['one', 'two'] : []);
    assert.equal(fs.readFileSync(room.file, 'utf8'), JSON.stringify(saved), 'Loading a preference never rewrites its source');
  }
});
test('failed member-order atomic save keeps original order and file while remaining independent of native calls', t => {
  const { dir, room } = setup(t), { records } = archiveFixture(); room.rename('Original');
  const original = fs.readFileSync(room.file, 'utf8'), value = structuredClone(room.value);
  t.mock.method(fs, 'renameSync', () => { throw Error('Synthetic disk full'); });
  assert.throws(() => room.moveMember({ id: 'one', target: 'two', after: true }, records), /未能保存/);
  assert.deepEqual(room.value, value); assert.equal(fs.readFileSync(room.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir), ['room-state.json']);
});
test('archive and restore retain identities and notes; session archive detaches; room restore excludes separately archived stable IDs', async t => {
  const { dir, room } = setup(t), { records, calls, client } = archiveFixture();
  room.notes('Shared note', 0); await room.archiveRoom(client); assert.equal(room.value.archived, true); assert.ok(records.every(s => s.roomId === null));
  await room.archiveSession(client, 'two'); assert.throws(() => room.assertAvailable('two'), /归档/);
  const cold = new RoomState(dir); assert.equal(cold.value.archived, true); assert.equal(cold.value.notes, 'Shared note');
  await cold.restoreRoom(client); assert.equal(records[0].roomId, 'shared'); assert.equal(records[1].roomId, null); assert.equal(cold.value.archived, false);
  cold.restoreSession('two'); assert.doesNotThrow(() => cold.assertAvailable('two')); assert.equal(records[1].roomId, null, 'Solo restore does not silently rejoin');
  assert.equal(records[0].nativeId, 'native-one'); assert.equal(records[0].pid, 123); assert.equal(records[0].liveDraft, 'private');
  assert.ok(calls.every(([method]) => ['pause', 'initial', 'join'].includes(method)));
});
test('archive gates apply before awaited pause; failure never claims successful archive and retry preserves original roster', async t => {
  const { room } = setup(t), { records, client } = archiveFixture();
  const original = client.call; let release, fail = true;
  client.call = async (method, ...args) => {
    if (method === 'pause') await new Promise(resolve => { release = resolve; });
    if (method === 'join' && args[0] === 'two' && fail) throw Error('Synthetic detach failure');
    return original(method, ...args);
  };
  const pending = room.archiveRoom(client); assert.throws(() => room.assertAvailable('one', true), /归档/); release(); await assert.rejects(pending, /detach failure/);
  assert.equal(room.value.archived, false); assert.equal(records[0].roomId, null); assert.equal(records[1].roomId, 'shared'); assert.deepEqual(room.value.restoreMembers, ['one', 'two']);
  fail = false; const retry = room.archiveRoom(client); release(); await retry; assert.equal(room.value.archived, true); assert.deepEqual(room.value.restoreMembers, ['one', 'two']);
});
test('partial room restore survives cold reopen and retry without duplicate joins or restoring a separately archived session', async t => {
  const { dir, room } = setup(t), { records, calls, client } = archiveFixture();
  records.push({ id: 'three', name: 'Duplicate', roomId: 'shared', nativeId: 'native-three', pid: 789 });
  await room.archiveRoom(client); await room.archiveSession(client, 'three');
  const original = client.call;
  client.call = async (method, ...args) => {
    if (method === 'join' && args[0] === 'two' && args[1]) throw Error('Synthetic restore failure');
    return original(method, ...args);
  };
  await assert.rejects(room.restoreRoom(client), /restore failure/);
  assert.equal(room.value.archived, true); assert.equal(records[0].roomId, 'shared');
  assert.equal(records[1].roomId, null); assert.equal(records[2].roomId, null);
  assert.deepEqual(room.value.restoreMembers, ['one', 'two', 'three']);
  const cold = new RoomState(dir); assert.equal(cold.value.archived, true);
  assert.throws(() => cold.assertAvailable('one', true), /归档/);
  client.call = original; await cold.restoreRoom(client);
  assert.equal(cold.value.archived, false); assert.deepEqual(cold.value.restoreMembers, []);
  assert.equal(records[0].roomId, 'shared'); assert.equal(records[1].roomId, 'shared'); assert.equal(records[2].roomId, null);
  assert.equal(cold.value.events.filter(e => e.kind === 'join' && e.sessionId === 'one').length, 1);
  assert.equal(calls.filter(([method, id, join]) => method === 'join' && id === 'one' && join).length, 1);
  assert.deepEqual(records.map(s => s.nativeId), ['native-one', 'native-two', 'native-three']);
  assert.ok(calls.every(([method]) => ['pause', 'initial', 'join'].includes(method)));
});
