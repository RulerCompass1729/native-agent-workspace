const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { BackgroundControl } = require('../background-control.cjs'), operation = require('../background-operation.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const begin = source.indexOf('      context.fingerprint = command =>'), end = source.indexOf('\n      context.delivery =', begin);
assert.ok(begin >= 0 && end > begin);
const order = { id: 'target', target: 'peer', after: true };
const cases = [
  ['foreign conversation', 'initial', []],
  ['foreign image', 'previewImage', [{ kind: 'session', sessionId: 'target', messageId: 'message' }]],
  ['runtime selection', 'runtimeLocation', ['claude', false]],
  ['local file selection', 'openLocalFile', ['target']],
  ['file save selection', 'saveLocalFile', ['preview-token']],
  ['foreign interrupt', 'interrupt', ['target']],
  ['foreign answer', 'answer', ['target', 'question', { choice: 'yes' }]],
  ['foreign terminal', 'terminal', ['target']],
  ['terminal input', 'input', ['target', '\x1b']],
  ['shared member order', 'roomMemberOrder', [order]],
  ['space member order', 'spaceAction', [A, 'memberOrder', [order]], A],
  ['space file', 'spaceFiles', [A, 'file-id']],
  ['message file', 'openMessageFile', [{ kind: 'session', sessionId: 'target', nativeId: 'native-target', messageId: 'message' }, '/synthetic/file.txt']],
];
function fixture(t, memberRoom = 'shared') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-consent-scope-'));
  const session = (id, roomId) => ({ id, nativeId: 'native-' + id, provider: 'claude', name: id, roomId: roomId === 'shared' ? 'shared' : null, roomIds: roomId ? [roomId] : [],
    connectionRevision: 0, memberRevision: 0, controlRevision: 0, state: 'idle', owner: 'window', messages: [] });
  const state = { sessions: [session('requester', null), session('target', memberRoom), session('peer', memberRoom), session('unrelated', B)],
    rooms: ['shared', A, B].map(id => ({ id, name: id, archived: false, memberOrder: id === memberRoom ? ['target', 'peer'] : [], restoreMembers: [], restorePlacements: {} })) };
  const actor = { id: 'requester', nativeId: 'native-requester', provider: 'claude', name: 'Requester' };
  const effects = [], archive = {}, roomState = { value: { sessionArchives: archive }, apply: value => value,
    metadata: id => state.rooms.find(r => r.id === id), mergePreviews: new Map(), mergeRecord: () => null };
  const client = { snapshot: () => state, refresh: async () => {}, close() {} };
  const context = { background: true, actor, client, view: { selected: 'target' }, win: { destroy() {} }, refresh: async () => {},
    confirmationActors: () => state.sessions, terminalConsentSnapshot: () => state,
    checkActor: async () => { const current = state.sessions.find(s => s.id === actor.id); if (!current || current.nativeId !== actor.nativeId || current.archived) throw Error('Actor changed'); } };
  vm.runInContext(source.slice(begin, end), vm.createContext({ context, client, actor, roomState, roomIds,
    backgroundOperation: operation, sessionLabels: { apply: value => value } }));
  const target = state.sessions[1];
  target.terminalState = { alive: true, epoch: 'terminal-epoch', observationIndex: 1 };
  target.nativeTerminalDialog = { kind: 'choice', title: 'Synthetic choice', since: 1, revision: 0 };
  target.approval = { requestId: 'question', options: ['yes', 'no'] };
  const handlers = new Map(cases.map(([, method]) => [method, (_c, ...args) => { effects.push({ method, args }); return { done: true }; }]));
  for (const method of ['pause', 'spaceMerge']) handlers.set(method, () => { effects.push({ method }); return true; });
  const control = new BackgroundControl({ dataDir: dir, handlers, context: () => context,
    confirmation: () => ({ message: 'Confirm synthetic operation?', buttons: ['Cancel', 'Confirm'], cancelId: 0 }), audit() {} });
  t.after(async () => { await control.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let next = 0;
  const ask = (method, args, id = 'operation-' + (++next)) => control.call({ sender: actor, identity: { callId: id, turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method, arguments: args, operation_id: id });
  return { state, context, control, target, actor, archive, effects, ask,
    confirm: card => control.decide(actor.id, actor.nativeId, card.id, 1) };
}
for (const [name, method, args, room] of cases) test(`PF10: ${name} survives only unrelated object changes`, async t => {
  const f = fixture(t, room), card = await f.ask(method, args);
  assert.equal(card.state, 'confirmation-required', card.error);
  const before = JSON.stringify([f.state.sessions[0], f.target, f.state.rooms.filter(r => r.id !== B)]);
  const other = f.state.sessions.find(s => s.id === 'unrelated'); other.nativeId = 'native-reconnected'; other.connectionRevision++;
  f.state.rooms.find(r => r.id === B).name = 'Unrelated renamed space';
  f.archive.unrelated = { rooms: [{ id: B }], at: 123 };
  assert.equal(JSON.stringify([f.state.sessions[0], f.target, f.state.rooms.filter(r => r.id !== B)]), before);
  const result = await f.confirm(card);
  assert.equal(result.state, 'complete', result.error); assert.equal(f.effects.length, 1);
  assert.equal((await f.ask(method, args, card.id)).duplicate, true); assert.equal(f.effects.length, 1);
});

for (const change of ['nativeId', 'connectionRevision', 'roomId', 'owner', 'controlRevision', 'activeTurnId', 'approval'])
  test(`PF10 control: foreign target ${change} change still refuses`, async t => {
    const f = fixture(t), card = await f.ask('interrupt', ['target']);
    if (change === 'approval') f.target.approval.requestId = 'new-question';
    else if (change === 'roomId') { f.target.roomId = null; f.target.roomIds = [B]; }
    else f.target[change] = ['connectionRevision', 'controlRevision'].includes(change) ? 1 : 'changed';
    const result = await f.confirm(card); assert.notEqual(result.state, 'complete'); assert.deepEqual(f.effects, []);
  });
for (const change of ['nativeId', 'connectionRevision', 'roomId']) test(`PF10 control: actor ${change} change still refuses`, async t => {
  const f = fixture(t), card = await f.ask('runtimeLocation', ['claude', false]);
  if (change === 'roomId') f.state.sessions[0].roomIds = [B];
  else f.state.sessions[0][change] = change === 'connectionRevision' ? 1 : 'changed';
  const result = await f.confirm(card); assert.notEqual(result.state, 'complete'); assert.deepEqual(f.effects, []);
});
for (const change of ['archived', 'memberOrder', 'roster']) test(`PF10 control: ordering space ${change} change still refuses`, async t => {
  const f = fixture(t, A), card = await f.ask('spaceAction', [A, 'memberOrder', [order]]), room = f.state.rooms.find(r => r.id === A);
  if (change === 'roster') { f.state.sessions[2].roomId = null; f.state.sessions[2].roomIds = [B]; }
  else if (change === 'memberOrder') room.memberOrder.reverse(); else room.archived = true;
  const result = await f.confirm(card); assert.notEqual(result.state, 'complete'); assert.deepEqual(f.effects, []);
});
for (const change of ['dialog', 'options']) test(`PF10 control: terminal ${change} change still refuses`, async t => {
  const f = fixture(t), card = await f.ask('input', ['target', '\x1b']);
  if (change === 'dialog') f.target.nativeTerminalDialog = { ...f.target.nativeTerminalDialog, revision: 1 };
  else f.target.approval.options = ['different', 'choices'];
  const result = await f.confirm(card); assert.notEqual(result.state, 'complete'); assert.deepEqual(f.effects, []);
});
for (const [method, args] of [['pause', []], ['spaceMerge', ['commit', { operationId: 'merge-preview' }]]]) test(`PF10 control: ${method} keeps its existing broad guard`, async t => {
  const f = fixture(t), card = await f.ask(method, args); f.state.sessions[3].connectionRevision++;
  const result = await f.confirm(card); assert.notEqual(result.state, 'complete'); assert.deepEqual(f.effects, []);
});
