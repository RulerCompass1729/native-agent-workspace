const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs');
const spaces = require('../collaboration-spaces.cjs');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-session-archive-'));
  const host = { binaries: {}, close() {}, create(record) { record.nativeId = randomUUID(); const r = new EventEmitter(); r.start = async () => r.emit('state', 'idle'); r.stop = async () => ({ state: 'ended' }); return r; } };
  const w = new Workspace(host, dir), state = new RoomState(dir), a = state.create('A'), b = state.create('B'), ids = [];
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const name of ['First', 'Middle', 'Last']) ids.push(await w.create('codex', dir, 'owner', name));
  let moves = 0;
  const client = { snapshot: () => w.snapshot(), retainRestoredSuccessor: (id, observed) => w.retainRestoredSuccessor(id, observed.nativeId), call: async (method, ...args) => {
    if (method === 'initial') return { ...w.snapshot(), capabilities: ['singleHomeMoveV1', 'archiveIdleMoveV1'] };
    if (method === 'pause' || method === 'pauseSpace') return;
    if (method === 'moveMembership') { moves++; return w.moveMembership(...args); }
    throw Error('Unexpected model/native action: ' + method);
  } };
  for (const id of ids) await state.membership(client, id, true, null, a);
  state.moveMember({ id: ids[1], target: ids[2], after: true }, w.snapshot().sessions, a);
  return { dir, w, state, a, b, ids, client, get moves() { return moves; } };
}
for (const mode of ['prefix-archived', 'prefix-left', 'new-prefix', 'legacy-prefix-archived']) test(`restore stays before its saved successor when membership counts change: ${mode}`, async t => {
  const f = await fixture(t), [first, id, next] = f.ids;
  f.state.moveMember({ id, target: next, after: false }, f.w.snapshot().sessions, f.a);
  await f.state.archiveSession(f.client, id);
  let before = [first];
  if (mode === 'prefix-left') await f.state.membership(f.client, first, false, null, f.a);
  else if (mode === 'new-prefix') {
    const newcomer = await f.w.create('codex', f.dir, 'owner', 'New earlier neighbour');
    await f.state.membership(f.client, newcomer, true, null, f.a);
    f.state.moveMember({ id: newcomer, target: first, after: false }, f.w.snapshot().sessions, f.a);
    before = [newcomer, first];
  } else await f.state.archiveSession(f.client, first);
  if (mode === 'legacy-prefix-archived') {
    const disk = JSON.parse(fs.readFileSync(f.state.file)); delete disk.sessionArchives[id].rooms[0].next;
    fs.writeFileSync(f.state.file, JSON.stringify(disk), { mode: 0o600 });
  }
  const cold = new RoomState(f.dir);
  assert.equal((await cold.restoreSession(f.client, id)).placement, 'restored');
  const order = cold.metadata(f.a).memberOrder;
  assert.deepEqual(order.filter(member => [...before, id, next].includes(member)), [...before, id, next]);
});
test('a saved tail slot stays ahead of a member added while it was archived', async t => {
  const f = await fixture(t), id = f.ids[1], order = [...f.state.metadata(f.a).memberOrder];
  await f.state.archiveSession(f.client, id);
  const newcomer = await f.w.create('codex', f.dir, 'owner', 'New tail');
  await f.state.membership(f.client, newcomer, true, null, f.a);
  const cold = new RoomState(f.dir); await cold.restoreSession(f.client, id);
  assert.deepEqual(cold.metadata(f.a).memberOrder, [...order, newcomer]);
});
test('session archive saves location before detaching and cold restore returns exact room and order', async t => {
  const f = await fixture(t), id = f.ids[1], original = f.w.get(id), nativeId = original.nativeId;
  const order = [...f.state.metadata(f.a).memberOrder], call = f.client.call;
  f.client.call = async (method, ...args) => {
    if (method === 'moveMembership' && args[1] === null) {
      const disk = JSON.parse(fs.readFileSync(f.state.file)); assert.equal(disk.sessionArchives[id].rooms[0].id, f.a);
    }
    return call(method, ...args);
  };
  await f.state.archiveSession(f.client, id); assert.deepEqual(spaces.roomIds(original), []);
  const cold = new RoomState(f.dir); await cold.restoreSession(f.client, id);
  assert.deepEqual(spaces.roomIds(original), [f.a]); assert.deepEqual(cold.metadata(f.a).memberOrder, order);
  assert.equal(original.nativeId, nativeId); assert.equal(original.owner, 'owner'); assert.equal(cold.value.archivedSessions.includes(id), false);
});
for (const mode of ['other-room', 'ABA', 'native', 'archived-room', 'missing-room', 'multi-home', 'join-unconfirmed']) test(`restore releases the session despite ${mode}, without stealing a later placement`, async t => {
  const f = await fixture(t), id = f.ids[1]; await f.state.archiveSession(f.client, id);
  if (mode === 'other-room' || mode === 'ABA') {
    const s = f.w.get(id), proof = () => ({ operationId: randomUUID(), nativeId: s.nativeId, revision: spaces.placementRevision(s), connectionRevision: s.connectionRevision || 0 });
    f.w.moveMembership(id, f.b, proof()); if (mode === 'ABA') f.w.moveMembership(id, null, proof());
  }
  if (mode === 'native') f.w.get(id).nativeId = randomUUID();
  if (mode === 'archived-room') await f.state.archiveRoom(f.client, null, f.a);
  if (mode === 'missing-room') {
    f.state.spaces.rooms = f.state.spaces.rooms.filter(r => r.id !== f.a);
    fs.writeFileSync(f.state.spacesFile, JSON.stringify(f.state.spaces), { mode: 0o600 });
  }
  if (mode === 'multi-home') f.state.value.sessionArchives[id].rooms.push({ id: f.b, index: 0, expected: null, done: false });
  const call = f.client.call;
  if (mode === 'join-unconfirmed') f.client.call = async (method, ...args) => { if (method === 'moveMembership') throw Error('Synthetic uncertain join'); return call(method, ...args); };
  const before = spaces.roomIds(f.w.get(id)), result = await f.state.restoreSession(f.client, id);
  assert.equal(result.restored, true); assert.equal(result.placement, 'unavailable');
  assert.equal(result.uiMessage.key, 'notice.room.sessionRestoreFallback');
  assert.deepEqual(spaces.roomIds(f.w.get(id)), before); assert.equal(f.state.value.archivedSessions.includes(id), false);
  assert.equal(new RoomState(f.dir).value.sessionArchives[id], undefined); assert.doesNotThrow(() => f.state.assertAvailable(id));
});
test('restore keeps the archive while the session owner is unavailable and can retry', async t => {
  const f = await fixture(t), id = f.ids[1];
  await f.state.archiveSession(f.client, id);
  const saved = structuredClone(f.state.value.sessionArchives[id]), call = f.client.call;
  f.client.call = async () => { throw Error('Synthetic disconnected backend'); };
  await assert.rejects(f.state.restoreSession(f.client, id), /Synthetic disconnected backend/);
  const cold = new RoomState(f.dir);
  assert.ok(cold.value.archivedSessions.includes(id));
  assert.deepEqual(cold.value.sessionArchives[id], saved);
  assert.equal(cold.value.restoredSessions.includes(id), false);
  f.client.call = call;
  assert.equal((await f.state.restoreSession(f.client, id)).placement, 'restored');
  assert.equal(f.state.value.archivedSessions.includes(id), false);
});
test('archive then actual Workspace.stop still restores the same native identity to its original home', async t => {
  const f = await fixture(t), id = f.ids[1], nativeId = f.w.get(id).nativeId, order = [...f.state.metadata(f.a).memberOrder];
  await f.state.archiveSession(f.client, id); await f.w.stop(id);
  assert.ok(f.w.get(id).connectionRevision > 0);
  const result = await new RoomState(f.dir).restoreSession(f.client, id);
  assert.equal(result.placement, 'restored'); assert.deepEqual(spaces.roomIds(f.w.get(id)), [f.a]); assert.equal(f.w.get(id).nativeId, nativeId);
  const cold = new RoomState(f.dir); assert.equal(cold.value.archivedSessions.includes(id), false); assert.deepEqual(cold.metadata(f.a).memberOrder, order);
});
for (const middle of [false, true]) test(`restore preserves order entries of a temporarily absent backend: middle=${middle}`, async t => {
  const f = await fixture(t), id = f.ids[1], absent = f.ids[0];
  if (middle) f.state.moveMember({ id, target: f.ids[2], after: false }, f.w.snapshot().sessions, f.a);
  const order = [...f.state.metadata(f.a).memberOrder];
  await f.state.archiveSession(f.client, id);
  const call = f.client.call;
  f.client.call = async (method, ...args) => {
    const value = await call(method, ...args);
    return method === 'initial' ? { ...value, sessions: value.sessions.filter(s => s.id !== absent) } : value;
  };
  assert.equal((await f.state.restoreSession(f.client, id)).placement, 'restored');
  assert.deepEqual(new RoomState(f.dir).metadata(f.a).memberOrder, order);
  assert.deepEqual(spaces.roomIds(f.w.get(id)), [f.a]);
});
test('failed position persistence happens before detaching the session', async t => {
  const f = await fixture(t), id = f.ids[1], before = f.moves;
  t.mock.method(f.state, 'write', () => { throw Error('Synthetic disk full'); });
  await assert.rejects(f.state.archiveSession(f.client, id)); assert.equal(f.moves, before); assert.deepEqual(spaces.roomIds(f.w.get(id)), [f.a]);
});
test('control-only events do not invalidate unchanged merge sources or notes revisions', async t => {
  const f = await fixture(t), before = f.state.mergeSources(f.w.snapshot(), [f.a, f.b]), revision = f.state.metadata(f.a).revision;
  const row = { id: 'operation', actor: { id: f.ids[0], nativeId: 'native', name: 'Agent', provider: 'codex' }, command: { method: 'archiveRoom', arguments: [] }, state: 'confirmation-required', at: 1 };
  f.state.recordControlOperation(row, [f.a]);
  assert.equal(f.state.metadata(f.a).revision, revision); assert.deepEqual(f.state.mergeSources(f.w.snapshot(), [f.a, f.b]), before);
});
test('a cold archive retry reconciles the prepared detach after a metadata save failure without another move', async t => {
  const f = await fixture(t), id = f.ids[1], update = f.state.update.bind(f.state), moves = f.moves;
  t.mock.method(f.state, 'update', (fields, ...args) => {
    if (fields.sessionArchives?.[id]?.rooms[0].done) throw Error('Synthetic checkpoint save failure');
    return update(fields, ...args);
  });
  await assert.rejects(f.state.archiveSession(f.client, id), /checkpoint/); assert.equal(f.moves, moves + 1);
  const cold = new RoomState(f.dir); await cold.archiveSession(f.client, id);
  assert.equal(f.moves, moves + 1); assert.equal(cold.value.archivedSessions.includes(id), true);
  assert.equal(cold.metadata(f.a).events.filter(e => e.kind === 'leave' && e.sessionId === id).length, 1);
});
test('a cold restore retry reconciles the prepared join and keeps the saved member index', async t => {
  const f = await fixture(t), id = f.ids[1], order = [...f.state.metadata(f.a).memberOrder];
  await f.state.archiveSession(f.client, id); const update = f.state.update.bind(f.state), moves = f.moves;
  t.mock.method(f.state, 'update', (fields, ...args) => {
    if (fields.archivedSessions && !fields.archivedSessions.includes(id)) throw Error('Synthetic final save failure');
    return update(fields, ...args);
  });
  await assert.rejects(f.state.restoreSession(f.client, id), /final save/); assert.equal(f.moves, moves + 1);
  const cold = new RoomState(f.dir); await cold.restoreSession(f.client, id);
  assert.equal(f.moves, moves + 1); assert.deepEqual(cold.metadata(f.a).memberOrder, order); assert.deepEqual(spaces.roomIds(f.w.get(id)), [f.a]);
});
test('a new archive discards a stale failed plan and uses the current placement', async t => {
  const f = await fixture(t), id = f.ids[1], update = f.state.update.bind(f.state);
  t.mock.method(f.state, 'update', (fields, ...args) => {
    if (fields.archivedSessions?.includes(id)) throw Error('Synthetic final archive save failure');
    return update(fields, ...args);
  });
  await assert.rejects(f.state.archiveSession(f.client, id), /final archive/);
  const s = f.w.get(id), move = room => f.w.moveMembership(id, room, { operationId: randomUUID(), nativeId: s.nativeId, revision: spaces.placementRevision(s), connectionRevision: 0 });
  move(f.b); move(null); const moves = f.moves, cold = new RoomState(f.dir);
  await cold.archiveSession(f.client, id); assert.equal(f.moves, moves);
  assert.ok(cold.value.sessionArchives[id]); assert.equal(cold.value.archivedSessions.includes(id), true);
  assert.deepEqual(cold.value.sessionArchives[id].rooms, []);
});
test('legacy archives without saved placement restore standalone without inventing a room', async t => {
  const f = await fixture(t), id = f.ids[1]; await f.state.archiveSession(f.client, id);
  const data = JSON.parse(fs.readFileSync(f.state.file)); delete data.sessionArchives;
  fs.writeFileSync(f.state.file, JSON.stringify(data), { mode: 0o600 });
  const cold = new RoomState(f.dir), result = await cold.restoreSession(f.client, id); assert.equal(result.restored, true); assert.equal(result.placement, 'unavailable');
  assert.deepEqual(spaces.roomIds(f.w.get(id)), []);
});
for (const mode of ['forgotten-before', 'absent-before', 'returns-before-restore', 'forgotten-after']) test(`restore keeps its neighbours despite a stored unknown slot: ${mode}`, async t => {
  const f = await fixture(t), id = f.ids[1];
  f.state.moveMember({ id, target: f.ids[2], after: false }, f.w.snapshot().sessions, f.a);
  const ghost = await f.w.create('codex', f.dir, 'owner', 'Earlier member');
  await f.state.membership(f.client, ghost, true, null, f.a);
  f.state.moveMember({ id: ghost, target: f.ids[0], after: false }, f.w.snapshot().sessions, f.a);
  const order = [...f.state.metadata(f.a).memberOrder], call = f.client.call;
  const forget = async () => { await f.w.stop(ghost); f.w.forget(ghost); };
  if (mode === 'forgotten-before') await forget();
  let absent = ['absent-before', 'returns-before-restore'].includes(mode);
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    return method === 'initial' && absent ? { ...result, sessions: result.sessions.filter(s => s.id !== ghost) } : result;
  };
  await f.state.archiveSession(f.client, id);
  if (mode === 'forgotten-after') await forget();
  if (mode === 'returns-before-restore') absent = false;
  assert.equal((await new RoomState(f.dir).restoreSession(f.client, id)).placement, 'restored');
  const restored = new RoomState(f.dir).metadata(f.a).memberOrder;
  assert.deepEqual(restored, order);
  const visible = new Set(f.w.snapshot().sessions.map(s => s.id));
  assert.deepEqual(restored.filter(s => visible.has(s)), order.filter(s => visible.has(s)));
});
