const test = require('node:test'), assert = require('node:assert/strict');
const { conversationSnapshot } = require('../background-operation.cjs');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const actor = { id: 'agent', nativeId: 'native-agent' };
function fixture() {
  const room = id => ({ id, name: 'Space ' + id, archived: false, metadataRevision: 3, memberOrder: ['agent'],
    notes: id + '_NOTES', messages: [{ text: id + '_MESSAGE' }], events: [{ text: id + '_EVENT' }], files: [{ name: id + '_FILE' }],
    run: { goal: id + '_RUN' }, merge: { notes: id + '_MERGE', events: [{ text: id + '_MERGED_EVENT' }] },
    queue: [{ id: 'item', status: 'done', assignee: 'agent', sentTo: 'agent', createdAt: 1, finishedAt: 2, text: id + '_TASK', reply: id + '_REPLY', reason: id + '_REASON', futurePrivate: id + '_FUTURE_QUEUE', creator: { kind: 'secretary', name: 'Secretary', sessionId: 'secretary', futurePrivate: 'CREATOR_SECRET' } }], futurePrivate: id + '_FUTURE_ROOM' });
  const rooms = [room(A), room(B)];
  return { sessions: [{ ...actor, name: 'Agent', roomIds: [A], messages: [{ text: 'OWN' }] }, { id: 'other', nativeId: 'native-other', name: 'Other', roomIds: [B], messages: [{ text: 'FOREIGN' }] }], rooms, room: rooms[1],
    capabilities: ['backgroundControlV1'], runtimeVersion: 'fixture', protocol: 1, futurePrivate: 'TOP_LEVEL_SECRET',
    operatorPolicy: { enabled: true, domains: [{ text: 'OPERATOR_SECRET' }] }, peerLeases: [{ result: { intent: { text: 'LEASE_SECRET' } } }],
    rotationChains: [{ spaces: [A, B], sessions: [{ id: 'other', nativeId: 'native-other', name: 'Other', handedAt: 1, outcome: 'done', futurePrivate: 'ROTATION_SECRET' }], futurePrivate: 'CHAIN_SECRET' }],
    wakePolicy: { enabled: true, unavailable: false, warning: 'WAKE_SECRET' }, spaceManagers: { [B]: { sessionId: 'manager', nativeId: 'native-manager', futurePrivate: 'ROLE_SECRET' } },
    viewState: { selected: 'room', spaceId: B, mode: 'chat', preference: 'chat', sharedDraft: 'VIEW_SECRET', roomViews: { [B]: { roomSearch: 'QUERY_SECRET' } } },
    preflight: { claude: true, codex: false, python: true, paths: { codex: 'PATH_SECRET' }, configured: { future: 'CONFIG_SECRET' } },
    appBuild: { version: 'fixture', commit: 'abc', installedAt: null, futurePrivate: 'BUILD_SECRET' },
    butler: { intake: 'ready', activation: 'off', recordPeriod: 'off', errorCode: null, futurePrivate: 'BUTLER_SECRET' } };
}
test('a member sees its own space content; other spaces and their aliases expose metadata only', () => {
  const source = fixture(), result = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: false });
  assert.ok(JSON.stringify(result.rooms[0]).includes(A + '_REPLY')); assert.ok(JSON.stringify(result.rooms[0]).includes(A + '_MESSAGE'));
  assert.equal(JSON.stringify(result).includes(B + '_'), false, 'No foreign-space bodies, merge data, task text, files or future fields');
  assert.deepEqual(result.room, result.rooms[1]);
  assert.deepEqual(result.rooms[1].queue[0], { id: 'item', status: 'done', assignee: 'agent', sentTo: 'agent', createdAt: 1, finishedAt: 2, creator: { kind: 'secretary', name: 'Secretary', sessionId: 'secretary' } });
  assert.ok(source.rooms[1].queue[0].reply, 'Projection leaves source state intact');
});
test('a session whose role cannot be read gets queue metadata even in a joined space; approved foreign conversation access does not grant that space', () => {
  const source = fixture(), unknown = conversationSnapshot(source, actor, null, 'room', { roomIds: [A, B], metadataOnly: true });
  assert.equal(JSON.stringify(unknown).includes('_REPLY'), false); assert.equal(JSON.stringify(unknown).includes('_MESSAGE'), false); assert.equal(JSON.stringify(unknown).includes('_TASK'), false);
  assert.equal(unknown.rooms[0].queue[0].assignee, 'agent'); assert.equal(unknown.rooms[0].queue[0].status, 'done');
  const read = conversationSnapshot(source, actor, { sessionId: 'other', nativeId: 'native-other' }, 'other', { roomIds: [A], metadataOnly: false });
  assert.ok(JSON.stringify(read.sessions).includes('FOREIGN')); assert.equal(JSON.stringify(read.rooms).includes(B + '_'), false);
});
test('hosted top-level and nested metadata use explicit fields, including final initial extras', () => {
  const result = conversationSnapshot(fixture(), actor, null, 'room', { roomIds: [], metadataOnly: false });
  for (const text of ['TOP_LEVEL_SECRET','OPERATOR_SECRET','LEASE_SECRET','ROTATION_SECRET','CHAIN_SECRET','WAKE_SECRET','ROLE_SECRET','VIEW_SECRET','QUERY_SECRET','PATH_SECRET','CONFIG_SECRET','BUILD_SECRET','BUTLER_SECRET','CREATOR_SECRET'])
    assert.equal(JSON.stringify(result).includes(text), false, text);
  assert.deepEqual(result.operatorPolicy, { enabled: true }); assert.equal(result.peerLeases, undefined);
  assert.deepEqual(result.viewState, { selected: 'room', spaceId: B, mode: 'chat', preference: 'chat' });
  assert.deepEqual(result.preflight, { claude: true, codex: false, python: true });
  assert.deepEqual(result.spaceManagers, { [B]: { sessionId: 'manager', nativeId: 'native-manager' } });
  assert.equal(result.butler.intake, 'ready'); assert.equal(result.appBuild.version, 'fixture');
});
test('why a queued item waits is shown where its reason is: to members and the butler, never to a session whose role cannot be read', () => {
  const source = fixture();
  for (const room of source.rooms) room.queue[0] = { ...room.queue[0], status: 'queued', wait: [{ sessionId: 'agent', reason: 'person-typing', readiness: 'busy', note: 'WAIT_SECRET' }] };
  const result = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: false });
  assert.deepEqual(result.rooms[0].queue[0].wait, [{ sessionId: 'agent', reason: 'person-typing', readiness: 'busy' }]);
  assert.equal(result.rooms[1].queue[0].wait, undefined, 'not in a space it is not a member of');
  const unknown = conversationSnapshot(source, actor, null, 'room', { roomIds: [A, B], metadataOnly: true });
  assert.equal(JSON.stringify(unknown).includes('person-typing'), false);
  assert.equal(JSON.stringify(result).includes('WAIT_SECRET'), false);
});

test('rotation reason codes are shared only with space members and the designated butler access', () => {
  const source = fixture(), event = { kind: 'rotation', rotationReason: { sessionId: 'agent', reason: 'refresh-failed' } };
  source.rooms[0].events = [event];
  for (const access of [{ roomIds: [A], metadataOnly: false }, { roomIds: [A, B], metadataOnly: false }]) {
    assert.deepEqual(conversationSnapshot(source, actor, null, 'room', access).rooms[0].events, [event]);
  }
  for (const access of [{ roomIds: [], metadataOnly: false }, { roomIds: [A, B], metadataOnly: true }]) {
    assert.equal(conversationSnapshot(source, actor, null, 'room', access).rooms[0].events, undefined);
  }
});

// R162 (the person, 2026-11-23): 「保证不会让项目经理被其他空间的任务干扰」.
test("a project manager is shown its own space's board, queue and members, and nothing of another space", () => {
  const source = fixture();
  source.sessions.push({ id: 'member', nativeId: 'native-member', name: 'Member', roomIds: [A], messages: [{ text: 'MEMBER_BODY' }] });
  source.spaceManagers[A] = { sessionId: 'agent', nativeId: 'native-agent' };
  source.rotationChains.push({ spaces: [B], sessions: [{ id: 'gone', nativeId: 'native-gone', name: 'ELSEWHERE', handedAt: 1, outcome: 'done' }] });
  const result = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: false, limit: [A] });
  assert.deepEqual(result.rooms.map(room => room.id), [A]);
  assert.equal(result.rooms[0].queue[0].text, A + '_TASK');
  assert.equal(result.room, undefined, 'the space open in its own view is another one');
  assert.deepEqual(result.sessions.map(s => s.id), ['agent', 'member']);
  assert.deepEqual(result.sessions.find(s => s.id === 'member').messages, [], "a member's conversation stays its own");
  assert.deepEqual(result.spaceManagers, { [A]: { sessionId: 'agent', nativeId: 'native-agent' } });
  assert.deepEqual(result.rotationChains.map(chain => [chain.spaces, chain.sessions[0].id]), [[[A], 'other']], 'nor the other spaces one was in');
  for (const text of [B + '_', 'Space ' + B, 'FOREIGN', 'ELSEWHERE', 'native-manager']) assert.equal(JSON.stringify(result).includes(text), false, text);
});
test('an agent whose spaces are all it may be shown is shown those and itself, and with none only itself', () => {
  const source = fixture();
  source.room = source.rooms[0];
  source.spaceManagers[A] = { sessionId: 'agent', nativeId: 'native-agent' };
  const both = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: true, limit: [A, B] });
  assert.deepEqual([both.rooms.map(room => room.id), both.sessions.map(s => s.id), Object.keys(both.spaceManagers).length], [[A, B], ['agent', 'other'], 2]);
  const one = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: true, limit: [A] });
  assert.deepEqual([one.rooms.map(room => room.id), one.room.id, one.sessions.map(s => s.id)], [[A], A, ['agent']]);
  assert.equal(JSON.stringify(one).includes('_NOTES'), false);
  const none = conversationSnapshot(source, actor, null, 'room', { roomIds: [], metadataOnly: false, limit: [] });
  assert.deepEqual([none.rooms, none.room, none.sessions.map(s => s.id), none.spaceManagers, none.rotationChains], [[], undefined, ['agent'], {}, []]);
});

// R229 / 308: all events of every space were most of an agent's answer, and Claude Code drops one above 4 MiB.
test("an agent is told each space's newest 50 events and how many it was not told; the source keeps all", () => {
  const source = fixture(), many = Array.from({ length: 120 }, (_, n) => ({ id: 'e' + n, text: 'event ' + n }));
  source.rooms[0].events = many;
  const room = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: false }).rooms[0];
  assert.deepEqual(room.events, many.slice(-50)); assert.equal(room.eventsOmitted, 70);
  assert.equal(source.rooms[0].events.length, 120);
  source.rooms[0].events = many.slice(0, 50);
  const few = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], metadataOnly: false }).rooms[0];
  assert.equal(few.events.length, 50); assert.equal(Object.hasOwn(few, 'eventsOmitted'), false);
  const outside = conversationSnapshot(source, actor, null, 'room', { roomIds: [], metadataOnly: false }).rooms[0];
  assert.equal(outside.events, undefined); assert.equal(outside.eventsOmitted, undefined);
});
