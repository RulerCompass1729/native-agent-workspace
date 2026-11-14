const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs'), { Workspace } = require('../workspace.cjs');
const { roomIds, withMembership } = require('../collaboration-spaces.cjs');

async function fixture(t, provider = 'codex', named = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-members-'));
  const host = { binaries: {}, close() {}, create(record) {
    record.nativeId ||= randomUUID(); const runtime = new EventEmitter();
    runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' }); return runtime;
  } };
  const workspace = new Workspace(host, dir), rooms = new RoomState(dir);
  t.after(() => { workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const room = named ? rooms.create('Original') : 'shared', other = rooms.create('Other');
  const ids = [], moves = [];
  const client = { snapshot: () => workspace.snapshot(), refresh: async () => workspace.snapshot(), call: async (method, ...args) => {
    if (method === 'initial') return { ...workspace.snapshot(), capabilities: ['singleHomeMoveV1'] };
    if (method === 'pause' || method === 'pauseSpace') return;
    if (method === 'moveMembership') { moves.push(args); return workspace.moveMembership(...args); }
    if (method === 'join' || method === 'joinSpace') {
      moves.push(args); const id = args[0], destination = method === 'join' ? 'shared' : args[2];
      workspace.sessions.set(id, withMembership(workspace.get(id), destination, args[1])); return;
    }
    throw Error('Unexpected native/model call: ' + method);
  } };
  for (const name of ['Idle', 'Ended', 'Working', 'Also elsewhere']) {
    const id = await workspace.create(provider, dir, 'owner', name); ids.push(id);
    await rooms.membership(client, id, true, undefined, room);
  }
  await workspace.stop(ids[1]); workspace.get(ids[2]).state = 'working';
  workspace.sessions.set(ids[3], withMembership(workspace.get(ids[3]), other, true));
  moves.length = 0;
  return { dir, workspace, rooms, room, other, ids, client, moves };
}
for (const provider of ['claude', 'codex']) for (const named of [false, true]) {
  test(`${provider}, ${named ? 'named' : 'default'} space: archive eligible members and restore them after reopening`, async t => {
    const f = await fixture(t, provider, named), [idle, ended, working, elsewhere] = f.ids;
    const before = new Map(f.workspace.snapshot().sessions.map(s => [s.id, { nativeId: s.nativeId, home: roomIds(s) }]));
    await f.rooms.archiveRoom(f.client, undefined, f.room);
    assert.equal(f.rooms.metadata(f.room).archived, true);
    for (const id of [idle, ended]) {
      assert.equal(f.rooms.value.archivedSessions.includes(id), true, 'Eligible member must not spill into Independent sessions');
      assert.deepEqual(roomIds(f.workspace.get(id)), []);
    }
    for (const id of [working, elsewhere]) {
      assert.equal(f.rooms.value.archivedSessions.includes(id), false);
      assert.deepEqual(roomIds(f.workspace.get(id)), before.get(id).home, 'Excluded member keeps its memberships');
      assert.ok(!f.moves.some(args => args[0] === id), 'Excluded member must receive no membership call');
    }
    const cold = new RoomState(f.dir); await cold.restoreRoom(f.client, undefined, f.room);
    assert.equal(cold.metadata(f.room).archived, false);
    for (const id of f.ids) {
      assert.equal(cold.value.archivedSessions.includes(id), false);
      assert.deepEqual(roomIds(f.workspace.get(id)), before.get(id).home);
      assert.equal(f.workspace.get(id).nativeId, before.get(id).nativeId);
    }
  });
}
test('restoring the space does not restore an independently archived member or steal a later home', async t => {
  const f = await fixture(t), [independent, grouped] = f.ids;
  await f.rooms.archiveSession(f.client, independent);
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  assert.equal(f.rooms.value.archivedSessions.includes(grouped), true);
  await f.rooms.restoreSession(f.client, grouped);
  await f.rooms.membership(f.client, grouped, true, undefined, f.other);
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.equal(new RoomState(f.dir).value.archivedSessions.includes(independent), true);
  assert.deepEqual(roomIds(f.workspace.get(grouped)), [f.other]);
});
test('a partial member archive retries from disk without repeating a completed detach', async t => {
  const f = await fixture(t), [first, second] = f.ids, call = f.client.call;
  f.client.call = async (method, ...args) => {
    if (method === 'moveMembership' && args[0] === second) throw Error('synthetic detach failure');
    return call(method, ...args);
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), /synthetic detach failure/);
  assert.equal(f.rooms.value.archivedSessions.includes(first), true);
  assert.equal(f.rooms.metadata(f.room).archived, false);
  f.client.call = call; const cold = new RoomState(f.dir);
  await cold.archiveRoom(f.client, undefined, f.room);
  assert.equal(f.moves.filter(args => args[0] === first && args[1] === null).length, 1);
  await cold.restoreRoom(f.client, undefined, f.room);
  for (const id of [first, second]) assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
});

const vm = require('node:vm'), main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function desktopHandlers(f, answer, language = 'en') {
  const handlers = new Map(), dialogs = [];
  const scope = vm.createContext({ roomState: f.rooms, sessionLabels: { labels: new Map() },
    backgroundOperation: require('../background-operation.cjs'), uiError: require('../ui-errors.cjs').uiError,
    displayText: (key, params) => require('../ui-locale.js').format(language, key, params),
    showDialog: async (_c, _kind, options) => { dialogs.push(options); return { response: await answer(options) }; },
    broadcastRoom: async () => {}, validRoomId: require('../collaboration-spaces.cjs').roomId,
    register: (name, handler) => handlers.set(name, handler) });
  const helper = main.indexOf('function roomArchiveDetail(');
  if (helper >= 0) vm.runInContext(main.slice(helper, main.indexOf('\nfunction register(', helper)), scope);
  for (const [start, end] of [["  register('archiveRoom',", "  register('spaceCreate',"], ["  register('spaceAction',", "  register('spaceFiles',"]]) {
    const a = main.indexOf(start); vm.runInContext(main.slice(a, main.indexOf(end, a)), scope);
  }
  return { dialogs, invoke: () => f.room === 'shared' ? handlers.get('archiveRoom')({ client: f.client }) : handlers.get('spaceAction')({ client: f.client }, f.room, 'archive', []) };
}
for (const named of [false, true]) test(`desktop ${named ? 'named' : 'shared'} archive requires confirmation and cancellation changes nothing`, async t => {
  const f = await fixture(t, 'codex', named), before = f.workspace.snapshot(), h = desktopHandlers(f, () => 0);
  assert.equal(await h.invoke(), false);
  assert.equal(h.dialogs.length, 1);
  assert.equal(f.rooms.metadata(f.room).archived, false);
  assert.deepEqual(f.workspace.snapshot(), before); assert.deepEqual(f.moves, []);
});
for (const language of ['zh', 'en']) test(`desktop confirmation lists included and excluded members in ${language}`, async t => {
  const f = await fixture(t), h = desktopHandlers(f, () => 1, language);
  await h.invoke(); assert.equal(h.dialogs.length, 1);
  for (const id of f.ids) assert.ok(h.dialogs[0].detail.includes(id), 'Full identity distinguishes duplicate names');
  assert.equal(h.dialogs[0].defaultId, 0); assert.equal(h.dialogs[0].cancelId, 0);
  assert.ok(!h.dialogs[0].detail.includes('archive.roomConfirmation'));
  assert.equal(f.rooms.value.archivedSessions.length, 2);
});
test('a member becoming idle while the desktop confirmation waits requires a new confirmation', async t => {
  const f = await fixture(t), h = desktopHandlers(f, () => { f.workspace.get(f.ids[2]).state = 'idle'; return 1; });
  await assert.rejects(h.invoke(), error => error.uiMessage?.key === 'error.room.sessionRestoreChanged');
  assert.equal(f.rooms.metadata(f.room).archived, false); assert.deepEqual(f.moves, []);
});

test('pending work, stale native identity, unknown state and observed teammates are excluded', async t => {
  const f = await fixture(t), id = f.ids[0], original = { ...f.workspace.get(id) };
  for (const change of [{ state: 'working' }, { state: 'approval' }, { state: 'starting' }, { state: 'stopping' }, { state: 'disconnected' },
    { state: undefined }, { activeTurnId: 'turn' }, { pendingTag: 'tag' }, { pendingQueue: true }, { pendingSteer: true },
    { nativeInputRequired: true }, { approval: { requestId: 'a' } }, { nativeApproval: { requests: [{ id: 'a' }] } },
    { nativeGoal: { status: 'active' } }, { background: 1 }, { scheduled: 1 }, { backgroundStale: true },
    { nativeContextPending: true }, { backendUnavailable: true }, { transportDisconnected: true },
    { fleet: [{ event: 'SubagentStart', id: 'child', stale: false }] }, { fleet: [{ event: 'SubagentStart', id: 'child', stale: true }] }]) {
    const snapshot = f.workspace.snapshot(); snapshot.sessions = snapshot.sessions.map(s => s.id === id ? { ...original, ...change } : s);
    const plan = f.rooms.roomArchivePlan(snapshot, f.room);
    assert.ok(!plan.archive.includes(id), JSON.stringify(change)); assert.ok(plan.keep.includes(id));
  }
});
test('archive restores remain compatible with the earlier room-only placement records', async t => {
  const f = await fixture(t), id = f.ids[0];
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  const proof = f.rooms.value.sessionArchives[id].detached;
  f.rooms.update({ archivedSessions: [], sessionArchives: {} });
  f.rooms.update({ restoreMembers: [id], restorePlacements: { [id]: proof } }, undefined, f.room);
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
});
test('a confirmed member becoming busy during another member archive is left in place', async t => {
  const f = await fixture(t), [first, second] = f.ids, call = f.client.call;
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'moveMembership' && args[0] === first) f.workspace.get(second).state = 'working';
    return result;
  };
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  assert.equal(f.rooms.value.archivedSessions.includes(first), true);
  assert.equal(f.rooms.value.archivedSessions.includes(second), false);
  assert.deepEqual(roomIds(f.workspace.get(second)), [f.room]);
  assert.ok(!f.moves.some(args => args[0] === second));
});
test('a member cannot change identity during an earlier member archive and inherit its consent', async t => {
  const f = await fixture(t), [first, second] = f.ids, call = f.client.call;
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'moveMembership' && args[0] === first) f.workspace.get(second).nativeId = randomUUID();
    return result;
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), error => error.uiMessage?.key === 'error.room.sessionRestoreChanged');
  assert.equal(f.rooms.value.archivedSessions.includes(second), false);
  assert.deepEqual(roomIds(f.workspace.get(second)), [f.room]);
});

for (const retry of ['archive', 'restore']) test(`a save failure after detach recovers from disk by explicit ${retry}`, async t => {
  const f = await fixture(t), id = f.ids[0], update = f.rooms.update.bind(f.rooms); let failed = false;
  f.rooms.update = (fields, ...args) => {
    if (!failed && fields.sessionArchives?.[id]?.rooms[0]?.done) { failed = true; throw Error('synthetic metadata save failure'); }
    return update(fields, ...args);
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), /metadata save failure/);
  assert.deepEqual(roomIds(f.workspace.get(id)), []);
  const cold = new RoomState(f.dir);
  if (retry === 'archive') await cold.archiveRoom(f.client, undefined, f.room);
  await cold.restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
  assert.equal(cold.value.archivedSessions.includes(id), false);
  assert.equal(f.moves.filter(args => args[0] === id && args[1] === null).length, 1);
});
