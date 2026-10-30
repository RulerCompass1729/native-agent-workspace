const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { withMembership, membershipRevision } = require('../collaboration-spaces.cjs');
const caps = ['collaborationSpacesV1', 'nativeInputIsolation', 'claudePromptIdentity', 'structuredClaudeSubmit', 'replyThreads', 'nativeContextTransitions', 'verifiedHandoffs', 'boundedReplyHandoffs', 'multiSessionHandoffs', 'clearSharedHistory', 'peerReplyHandoffsV1'];
function service(key, room, options = {}) {
  const client = new EventEmitter(), calls = [], shared = { id: 'shared', messages: [{ id: `${key}-shared`, text: 'First space only' }] };
  let record = withMembership({ id: key, nativeId: `native-${key}`, roomId: null, memberRevision: 0, controlRevision: 0, connectionRevision: 1, provider: 'codex', state: 'idle', owner: 'owner', messages: [], liveDraft: 'unsent' }, room, true);
  const state = { owner: 'owner', capabilities: [...caps], runtimeVersion: 'development', sessions: [record], room: shared, rooms: [shared, { id: room, revision: 0, messages: [{ id: `${key}-space`, text: 'Selected space only' }] }], diagnostics: { shellModelCalls: 0, dispatches: 0 } };
  client.call = async (method, ...args) => {
    calls.push([method, ...structuredClone(args)]);
    if (method === 'initial') { await options.initial?.(); return structuredClone(state); }
    if (method === 'spaceAction' && args[1] === 'join') { record = withMembership(record, args[0], args[2][1]); state.sessions[0] = record; }
    if (method === 'spaceAction' && args[1] === 'clearSharedHistory') state.rooms.find(r => r.id === args[0]).messages = [];
    return 'receipt';
  };
  client.close = () => client.emit('closed');
  return { key, client, state: structuredClone(state), actual: state, calls };
}
function fixture(t, options = {}) {
  const a = randomUUID(), b = randomUUID(), one = service('one', a, options), two = service('two', a);
  for (const entry of [one, two]) {
    entry.actual.sessions[0] = withMembership(entry.actual.sessions[0], b, true);
    entry.actual.rooms.push({ id: b, revision: 0, messages: [{ id: `${entry.key}-b`, text: 'B only' }] }); entry.state = structuredClone(entry.actual);
  }
  const client = new WorkspaceClient([one, two], 'one'); t.after(() => client.close());
  return { a, b, one, two, client };
}
test('aggregating services partitions every history by space while retaining one logical/native session record', t => {
  const { a, b, client } = fixture(t), flat = client.snapshot(), selected = client.snapshot(a);
  assert.equal(flat.room.id, 'shared'); assert.equal(flat.sessions.length, 2);
  assert.deepEqual(selected.room.messages.map(m => m.id), ['one-space', 'two-space']);
  assert.deepEqual(client.snapshot(b).room.messages.map(m => m.id), ['one-b', 'two-b']);
  assert.ok(!JSON.stringify(selected.room).includes('First space only')); assert.ok(!JSON.stringify(flat.room).includes('Selected space only'));
  assert.deepEqual(selected.sessions.map(s => s.nativeId), ['native-one', 'native-two']); assert.ok(selected.sessions.every(s => s.liveDraft === 'unsent'));
});
test('explicit sharing emits one bounded room envelope with captured reply and membership proof; default wire stays unchanged', async t => {
  const { a, one, client } = fixture(t);
  await client.callSpace(a, 'forward', ['one', 'Selected request', 'native-one', 'one-space']);
  const request = one.calls.find(c => c[0] === 'spaceAction' && c[2] === 'forward');
  assert.deepEqual(request, ['spaceAction', a, 'forward', ['one', 'Selected request', 'native-one', 'one-space'], { one: membershipRevision(one.actual.sessions[0], a) }]);
  await client.call('forward', 'one', 'Original request', 'native-one', 'one-shared');
  assert.deepEqual(one.calls.find(c => c[0] === 'forward'), ['forward', 'one', 'Original request', 'native-one', 'one-shared']);
});
test('a reply parent from another space and an unsupported operation are rejected without a send', async t => {
  const { a, one, client } = fixture(t);
  await assert.rejects(client.callSpace(a, 'forward', ['one', 'Wrong parent', 'native-one', 'one-shared']), /原讨论记录/);
  await assert.rejects(client.callSpace(a, 'send', ['one', 'No new private route']), /无效协作/);
  assert.equal(one.calls.filter(c => c[0] === 'spaceAction').length, 0);
});
test('member ABA while waiting for pause prevents the stale selected-space send and keeps human draft', async t => {
  const { a, one, client } = fixture(t);
  client.pauseExcept = async () => {
    const s = one.actual.sessions[0]; one.actual.sessions[0] = withMembership(withMembership(s, a, false), a, true);
    await client.refresh();
  };
  await assert.rejects(client.callSpace(a, 'forward', ['one', 'Stale selected request', 'native-one']), /成员关系/);
  assert.equal(one.calls.some(c => c[0] === 'spaceAction' && c[2] === 'forward'), false);
  assert.equal(one.actual.sessions[0].liveDraft, 'unsent');
});
test('old retained services cannot be implicitly joined or sent selected-space content', async t => {
  const a = randomUUID(), old = service('old', a);
  old.state.capabilities = []; delete old.state.rooms; old.actual.capabilities = []; delete old.actual.rooms;
  old.state.sessions[0] = { ...old.state.sessions[0], roomId: null, roomIds: [], roomMembershipRevisions: {} }; old.actual.sessions = structuredClone(old.state.sessions);
  const client = new WorkspaceClient([old], 'old'); t.after(() => client.close());
  await assert.rejects(client.call('joinSpace', 'old', true, a), /原后台尚不支持/);
  await assert.rejects(client.callSpace(a, 'forward', ['old', 'Never fallback', 'native-old']), /原后台尚不支持/);
  assert.equal(old.calls.length, 0);
});
test('clearing selected-space history sends no default clear and preserves other histories and drafts', async t => {
  const { a, b, one, two, client } = fixture(t);
  await client.callSpace(a, 'clearSharedHistory', []);
  assert.equal(client.snapshot(a).room.messages.length, 0); assert.equal(client.snapshot(b).room.messages.length, 2); assert.equal(client.snapshot().room.messages.length, 2);
  for (const e of [one, two]) {
    assert.equal(e.calls.filter(c => c[0] === 'clearSharedHistory').length, 0);
    assert.equal(e.calls.filter(c => c[0] === 'spaceAction' && c[1] === a && c[2] === 'clearSharedHistory').length, 1);
    assert.equal(e.actual.sessions[0].liveDraft, 'unsent');
  }
});
for (const action of ['forward', 'queueShared', 'steerShared']) test(`selected ${action} in B cannot globally pause an armed A on another member service`, async t => {
  const a = randomUUID(), b = randomUUID(), one = service('one', a), two = service('two', a), third = service('third', b);
  one.actual.rooms[1].run = { id: 'finite-A', roomId: a, ids: ['one', 'two'], status: 'running', startedAt: 1 };
  one.state = structuredClone(one.actual);
  if (action !== 'forward') Object.assign(third.actual.sessions[0], { state: 'working', provider: action === 'queueShared' ? 'claude' : 'codex', queueAvailable: true, steerAvailable: true, activeTurnId: 'working-B' });
  third.actual.capabilities.push('nativeSharedQueue', 'nativeSharedSteer', 'nativeQueue', 'nativeSteer'); third.state = structuredClone(third.actual);
  const client = new WorkspaceClient([one, two, third], 'one'); t.after(() => client.close());
  await client.callSpace(b, action, ['third', 'Independent B request', 'native-third', ...(action === 'steerShared' ? ['working-B'] : [])]);
  assert.equal(one.calls.some(c => c[0] === 'pause' || c[0] === 'spaceAction' && c[2] === 'pause'), false);
  assert.equal(one.actual.rooms[1].run.status, 'running');
  assert.equal(third.calls.filter(c => c[0] === 'spaceAction' && c[1] === b && c[2] === action).length, 1);
});
