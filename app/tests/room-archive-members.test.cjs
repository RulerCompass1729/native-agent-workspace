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
  const client = { snapshot: () => workspace.snapshot(), refresh: async () => workspace.snapshot(),
    retainRestoredSuccessor: (id, observed) => workspace.retainRestoredSuccessor(id, observed.nativeId), call: async (method, ...args) => {
    if (method === 'initial') return { ...workspace.snapshot(), capabilities: ['singleHomeMoveV1', 'archiveIdleMoveV1'] };
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
  test(`${provider}, ${named ? 'named' : 'default'} space: becoming working at the archive receiver leaves placement and routing intact`, async t => {
    const f = await fixture(t, provider, named), id = f.ids[0], call = f.client.call;
    let before, disk, room, grant, injected = false;
    const pauses = [], pause = f.workspace.pauseRoom.bind(f.workspace);
    f.workspace.pauseRoom = (...args) => { pauses.push(args[0]); return pause(...args); };
    f.client.call = async (method, ...args) => {
      if (method === 'moveMembership' && args[0] === id && args[1] === null && !injected) {
        injected = true;
        const runtime = f.workspace.runtimes.get(id);
        runtime.emit('state', 'working');
        // Accepted shared work begins after the desktop's last idle snapshot.
        f.workspace.sharedReplies.authorize(f.workspace.get(id), runtime, 'accepted', { id: 'source' }, null, f.room);
        grant = f.workspace.sharedReplies.grants.get('accepted');
        assert.equal(f.workspace.sharedReplies.valid(grant), true);
        before = structuredClone(f.workspace.get(id));
        disk = fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8');
        room = structuredClone(f.workspace.rooms.get(f.room));
      }
      return call(method, ...args);
    };
    await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), error => error.uiMessage?.key === 'error.planWorking');
    assert.equal(injected, true);
    assert.deepEqual(roomIds(f.workspace.get(id)), [f.room], 'A refused archive must not detach the busy member');
    assert.deepEqual(f.workspace.get(id), before, 'No placement receipt or revision may change');
    assert.equal(fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8'), disk);
    assert.deepEqual(f.workspace.rooms.get(f.room), room);
    assert.deepEqual(pauses, [], 'No routing pause at the refused mutation');
    assert.equal(grant.closed, false); assert.equal(f.workspace.sharedReplies.valid(grant), true);
    assert.equal(f.rooms.metadata(f.room).archived, false);
    assert.deepEqual(f.rooms.value.archivedSessions, []);
    assert.ok(!f.rooms.metadata(f.room).events.some(e => e.kind === 'leave' && e.sessionId === id));
    // The persisted intent remains retryable; it cannot bypass the new guard.
    f.workspace.runtimes.get(id).emit('state', 'idle');
    if (provider === 'claude') f.workspace.runtimes.get(id).emit('background', { count: 0, scheduled: 0, kinds: [] });
    const cold = new RoomState(f.dir);
    await cold.archiveRoom(f.client, undefined, f.room);
    assert.equal(cold.value.archivedSessions.includes(id), true);
    await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
    assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
  });
}
for (const [name, change] of [
  ['active turn', (s, r) => { r.turnId = 'new-turn'; }],
  ['queued input', (s, r) => { r.pendingQueue = { tag: 'queued' }; }],
  ['pending steer', (s, r) => { r.pendingSteer = { tag: 'steer' }; }],
  ['native input', (s, r) => { r.nativeInputRequired = true; }],
  ['native approval', (s, r) => { r.nativeApproval = { requests: [{ id: 'approval' }] }; }],
  ['active goal', (s, r) => { r.nativeGoalSnapshot = () => ({ status: 'active' }); }],
  ['lost transport', (s, r) => { r.transportDisconnected = true; }],
  ['exited backend', (s, r) => { r.backendExitConfirmed = true; }],
  ['background work', s => { s.background = 1; }],
  ['unconfirmed work', s => { s.backgroundStale = true; }],
  ['scheduled work', s => { s.scheduled = 1; }],
  ['running teammate', s => { s.fleet = [{ event: 'SubagentStart', id: 'child', stale: false }]; }],
  ['unknown teammate', s => { s.fleet = [{ event: 'thread/started', id: 'child', stale: false }]; }],
]) test(`archive receiver checks live ${name} before touching placement`, async t => {
  const f = await fixture(t), id = f.ids[0], call = f.client.call, before = structuredClone(f.workspace.get(id));
  let injected = false;
  f.client.call = async (method, ...args) => {
    if (method === 'moveMembership' && args[0] === id && !injected) {
      injected = true; change(f.workspace.get(id), f.workspace.runtimes.get(id));
    }
    return call(method, ...args);
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), error => error.uiMessage?.key === 'error.planWorking');
  assert.equal(injected, true);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
  assert.deepEqual(f.workspace.get(id).placementReceipt, before.placementReceipt);
  assert.equal(f.workspace.get(id).placementRevision, before.placementRevision);
  assert.equal(f.rooms.metadata(f.room).archived, false);
  assert.deepEqual(f.rooms.value.archivedSessions, []);
});
for (const capabilities of [[], ['singleHomeMoveV1'], ['archiveIdleMoveV1']]) test(`space archive refuses a writer without both archive guards: ${capabilities}`, async t => {
  const f = await fixture(t), call = f.client.call, before = f.workspace.snapshot();
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    return method === 'initial' ? { ...result, capabilities } : result;
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), error => error.uiMessage?.key === 'error.movePlacementUnsupported');
  assert.deepEqual(f.workspace.snapshot(), before); assert.deepEqual(f.moves, []);
  assert.equal(f.rooms.metadata(f.room).archived, false); assert.deepEqual(f.rooms.value.archivedSessions, []);
});
test('space archive checks the member owning service capability, not another backend capability', async t => {
  const f = await fixture(t);
  f.workspace.get(f.ids[0]).serviceCapabilities = ['singleHomeMoveV1'];
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), error => error.uiMessage?.key === 'error.movePlacementUnsupported');
  assert.deepEqual(f.moves, []); assert.deepEqual(roomIds(f.workspace.get(f.ids[0])), [f.room]);
});
test('archive guard cannot authorize a join; a saved successful detach receipt can still reconcile after work starts', async t => {
  const f = await fixture(t), id = f.ids[0], s = f.workspace.get(id);
  const proof = { operationId: randomUUID(), nativeId: s.nativeId, revision: s.placementRevision,
    connectionRevision: s.connectionRevision || 0, archiveIdle: true };
  assert.throws(() => f.workspace.moveMembership(id, f.other, proof), error => error.uiMessage?.key === 'error.invalidMemberAction');
  assert.deepEqual(roomIds(s), [f.room]);
  const receipt = f.workspace.moveMembership(id, null, proof);
  f.workspace.runtimes.get(id).emit('state', 'working');
  const before = structuredClone(s);
  assert.deepEqual(f.workspace.moveMembership(id, null, proof), { ...receipt, replayed: true });
  assert.deepEqual(s, before);
});
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

const placement = s => ({ nativeId: s.nativeId ?? null, connectionRevision: s.connectionRevision || 0,
  revision: s.placementRevision || 0, signature: JSON.stringify([roomIds(s).sort(), s.memberRevision || 0,
    Object.entries(s.roomMembershipRevisions || {}).sort(([a], [b]) => a.localeCompare(b))]) });
const archiveNotice = (rooms, room, id) => rooms.metadata(room).events.find(e => e.kind === 'archive-member' && e.sessionId === id);

test('ended legacy records reported as unknown by workspace_sessions archive with historical unknown children', async t => {
  const f = await fixture(t, 'claude'), id = f.ids[1], s = f.workspace.get(id);
  s.fleet = Array.from({ length: 13 }, (_, n) => ({ event: 'SubagentStart', id: `historical-${n}`, stale: true }));
  const { OperatorControl } = require('../operator-control.cjs');
  assert.equal(OperatorControl.prototype.localMetadata.call({ w: f.workspace }, s).state, 'unknown');
  assert.equal(require('../renderer/fleet-observation.js').currentFleet(s).unknown, 13);
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  assert.equal(f.rooms.value.archivedSessions.includes(id), true, 'Ended history must not prevent archiving the conversation');
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
  assert.equal(require('../renderer/fleet-observation.js').currentFleet(s).unknown, 13, 'Archiving never declares old children complete');
});

test('an ended member of an older writer archives locally without an unguarded detach', async t => {
  const f = await fixture(t), id = f.ids[1], s = f.workspace.get(id);
  s.serviceCapabilities = []; s.fleet = [{ event: 'SubagentStart', id: 'old-child', stale: true }];
  const call = f.client.call;
  f.client.call = async (method, ...args) => {
    const value = await call(method, ...args);
    if (method === 'initial') value.sessions.find(s => s.id === id).backendUnavailable = true;
    return value;
  };
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  assert.equal(f.rooms.value.archivedSessions.includes(id), true);
  assert.ok(!f.moves.some(args => args[0] === id), 'No unguarded mutation is sent to an older writer');
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
  assert.equal(new RoomState(f.dir).value.archivedSessions.includes(id), false);
});

test('a retained writer with the older archive guard can archive ended historical fleet records locally', async t => {
  const f = await fixture(t), id = f.ids[1], call = f.client.call;
  f.workspace.get(id).fleet = [{ event: 'SubagentStart', id: 'historical-child', stale: true }];
  f.client.call = async (method, ...args) => {
    // The retained backend has the capability but its older predicate still
    // refuses every unknown child, including historical ones of an ended root.
    if (method === 'moveMembership' && args[0] === id && args[2].archiveIdle) throw require('../ui-errors.cjs').uiError('error.planWorking');
    return call(method, ...args);
  };
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  assert.equal(f.rooms.value.archivedSessions.includes(id), true);
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
});

test('historical observations arriving after a partial ended-member detach do not block its saved retry', async t => {
  const f = await fixture(t), id = f.ids[1], update = f.rooms.update.bind(f.rooms); let failed = false;
  f.rooms.update = (fields, ...args) => {
    if (!failed && fields.sessionArchives?.[id]?.rooms[0]?.done) { failed = true; throw Error('synthetic save failure'); }
    return update(fields, ...args);
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), /synthetic save failure/);
  f.workspace.get(id).fleet = [{ event: 'SubagentStart', id: 'historical-child', stale: true }];
  const cold = new RoomState(f.dir); await cold.archiveRoom(f.client, undefined, f.room);
  assert.equal(cold.value.archivedSessions.includes(id), true);
  assert.equal(f.moves.filter(args => args[0] === id && args[1] === null).length, 1);
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
});

async function oldRoomOnlyArchive(f, ids) {
  const proofs = {};
  for (const id of ids) {
    await f.rooms.changeMember(f.client, id, false, undefined, f.room, undefined, true);
    proofs[id] = placement(f.workspace.get(id));
  }
  f.rooms.update({ archived: true, restoreMembers: ids, restorePlacements: proofs }, undefined, f.room);
  f.moves.length = 0;
}
test('repeat archive repairs six old room-only spills from disk, is idempotent, and restores the group', async t => {
  const f = await fixture(t), ids = [...f.ids.slice(0, 2)];
  for (let n = 0; n < 4; n++) {
    const id = await f.workspace.create('claude', f.dir, 'owner', `Former member ${n}`);
    await f.rooms.membership(f.client, id, true, undefined, f.room); ids.push(id);
  }
  for (const id of ids) { await f.workspace.stop(id); f.workspace.get(id).fleet = [{ event: 'SubagentStart', id: 'historical', stale: true }]; }
  await oldRoomOnlyArchive(f, ids);
  const cold = new RoomState(f.dir);
  await cold.archiveRoom(f.client, undefined, f.room);
  assert.deepEqual(cold.value.archivedSessions.slice().sort(), ids.slice().sort());
  assert.equal(f.moves.length, 0, 'Already detached members need no backend move');
  await new RoomState(f.dir).archiveRoom(f.client, undefined, f.room);
  assert.equal(new RoomState(f.dir).value.archivedSessions.length, 6);
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  for (const id of ids) assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
  assert.deepEqual(new RoomState(f.dir).value.archivedSessions, []);
});

test('space archive records who stays working or genuinely unknown without changing their homes', async t => {
  const f = await fixture(t), [unknown, , working] = f.ids;
  f.workspace.get(unknown).state = 'unknown';
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  for (const [id, reason] of [[unknown, 'unconfirmed'], [working, 'working']]) {
    assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
    assert.equal(f.rooms.value.archivedSessions.includes(id), false);
    assert.equal(archiveNotice(f.rooms, f.room, id)?.archiveReason, reason);
  }
});

test('a late busy member is named in the successful archive record', async t => {
  const f = await fixture(t), [first, second] = f.ids, call = f.client.call;
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'moveMembership' && args[0] === first) f.workspace.get(second).state = 'working';
    return result;
  };
  await f.rooms.archiveRoom(f.client, undefined, f.room);
  assert.equal(archiveNotice(f.rooms, f.room, second)?.archiveReason, 'working');
  assert.deepEqual(roomIds(f.workspace.get(second)), [f.room]);
});

test('repeat archive refuses changed placement, a reused identity and missing former members with a named reason', async t => {
  const f = await fixture(t), ids = f.ids.slice(0, 3);
  await oldRoomOnlyArchive(f, ids);
  await f.rooms.membership(f.client, ids[0], true, undefined, f.other);
  f.workspace.get(ids[1]).nativeId = randomUUID();
  f.workspace.sessions.delete(ids[2]);
  const cold = new RoomState(f.dir); await cold.archiveRoom(f.client, undefined, f.room);
  assert.deepEqual(cold.value.archivedSessions, []);
  for (const id of ids) assert.equal(archiveNotice(cold, f.room, id)?.archiveReason, 'changed');
  assert.deepEqual(roomIds(f.workspace.get(ids[0])), [f.other]);
});

test('a failure after detach names the member, fails the receipt and remains restorable', async t => {
  const f = await fixture(t), id = f.ids[0], call = f.client.call;
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'moveMembership' && args[0] === id) f.workspace.get(id).state = 'working';
    return result;
  };
  await assert.rejects(f.rooms.archiveRoom(f.client, undefined, f.room), e => e.uiMessage?.key === 'error.planWorking');
  assert.equal(f.rooms.metadata(f.room).archived, false);
  assert.equal(archiveNotice(f.rooms, f.room, id)?.archiveReason, 'failed');
  await new RoomState(f.dir).restoreRoom(f.client, undefined, f.room);
  assert.deepEqual(roomIds(f.workspace.get(id)), [f.room]);
});
