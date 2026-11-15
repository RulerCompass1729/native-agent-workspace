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
    wakePolicy: { enabled: true, unavailable: false, warning: 'WAKE_SECRET' }, queueSecretary: { sessionId: 'secretary', nativeId: 'native-secretary', futurePrivate: 'ROLE_SECRET' },
    viewState: { selected: 'room', spaceId: B, mode: 'chat', preference: 'chat', sharedDraft: 'VIEW_SECRET', roomViews: { [B]: { roomSearch: 'QUERY_SECRET' } } },
    preflight: { claude: true, codex: false, python: true, paths: { codex: 'PATH_SECRET' }, configured: { future: 'CONFIG_SECRET' } },
    appBuild: { version: 'fixture', commit: 'abc', installedAt: null, futurePrivate: 'BUILD_SECRET' },
    butler: { intake: 'ready', activation: 'off', recordPeriod: 'off', errorCode: null, futurePrivate: 'BUTLER_SECRET' } };
}
test('a member sees its own space content; other spaces and their aliases expose metadata only', () => {
  const source = fixture(), result = conversationSnapshot(source, actor, null, 'room', { roomIds: [A], secretary: false });
  assert.ok(JSON.stringify(result.rooms[0]).includes(A + '_REPLY')); assert.ok(JSON.stringify(result.rooms[0]).includes(A + '_MESSAGE'));
  assert.equal(JSON.stringify(result).includes(B + '_'), false, 'No foreign-space bodies, merge data, task text, files or future fields');
  assert.deepEqual(result.room, result.rooms[1]);
  assert.deepEqual(result.rooms[1].queue[0], { id: 'item', status: 'done', assignee: 'agent', sentTo: 'agent', createdAt: 1, finishedAt: 2, creator: { kind: 'secretary', name: 'Secretary', sessionId: 'secretary' } });
  assert.ok(source.rooms[1].queue[0].reply, 'Projection leaves source state intact');
});
test('the secretary gets queue metadata even in a joined space; approved foreign conversation access does not grant that space', () => {
  const source = fixture(), secretary = conversationSnapshot(source, actor, null, 'room', { roomIds: [A, B], secretary: true });
  assert.equal(JSON.stringify(secretary).includes('_REPLY'), false); assert.equal(JSON.stringify(secretary).includes('_MESSAGE'), false); assert.equal(JSON.stringify(secretary).includes('_TASK'), false);
  assert.equal(secretary.rooms[0].queue[0].assignee, 'agent'); assert.equal(secretary.rooms[0].queue[0].status, 'done');
  const read = conversationSnapshot(source, actor, { sessionId: 'other', nativeId: 'native-other' }, 'other', { roomIds: [A], secretary: false });
  assert.ok(JSON.stringify(read.sessions).includes('FOREIGN')); assert.equal(JSON.stringify(read.rooms).includes(B + '_'), false);
});
test('hosted top-level and nested metadata use explicit fields, including final initial extras', () => {
  const result = conversationSnapshot(fixture(), actor, null, 'room', { roomIds: [], secretary: false });
  for (const text of ['TOP_LEVEL_SECRET','OPERATOR_SECRET','LEASE_SECRET','ROTATION_SECRET','CHAIN_SECRET','WAKE_SECRET','ROLE_SECRET','VIEW_SECRET','QUERY_SECRET','PATH_SECRET','CONFIG_SECRET','BUILD_SECRET','BUTLER_SECRET','CREATOR_SECRET'])
    assert.equal(JSON.stringify(result).includes(text), false, text);
  assert.deepEqual(result.operatorPolicy, { enabled: true }); assert.equal(result.peerLeases, undefined);
  assert.deepEqual(result.viewState, { selected: 'room', spaceId: B, mode: 'chat', preference: 'chat' });
  assert.deepEqual(result.preflight, { claude: true, codex: false, python: true });
  assert.equal(result.butler.intake, 'ready'); assert.equal(result.appBuild.version, 'fixture');
});

test('rotation reason codes are shared only with space members and the designated butler access', () => {
  const source = fixture(), event = { kind: 'rotation', rotationReason: { sessionId: 'agent', reason: 'refresh-failed' } };
  source.rooms[0].events = [event];
  for (const access of [{ roomIds: [A], secretary: false }, { roomIds: [A, B], secretary: false }]) {
    assert.deepEqual(conversationSnapshot(source, actor, null, 'room', access).rooms[0].events, [event]);
  }
  for (const access of [{ roomIds: [], secretary: false }, { roomIds: [A, B], secretary: true }]) {
    assert.equal(conversationSnapshot(source, actor, null, 'room', access).rooms[0].events, undefined);
  }
});
