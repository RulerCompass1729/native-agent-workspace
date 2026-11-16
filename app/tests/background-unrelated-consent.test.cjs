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
  ['foreign interrupt', 'interrupt', ['target'], undefined, false],
  ['foreign answer', 'answer', ['target', 'question', { choice: 'yes' }]],
  ['foreign terminal', 'terminal', ['target'], undefined, false],
  ['terminal input', 'input', ['target', '\x1b'], undefined, false],
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
  return { state, client, context, control, target, actor, archive, effects, ask,
    confirm: card => control.decide(actor.id, actor.nativeId, card.id, 1) };
}
for (const [name, method, args, room, unrelated = true] of cases) test(`PF10: ${name} guards its actual affected scope`, async t => {
  const f = fixture(t, room), card = await f.ask(method, args);
  assert.equal(card.state, 'confirmation-required', card.error);
  const before = JSON.stringify([f.state.sessions[0], f.target, f.state.rooms.filter(r => r.id !== B)]);
  const other = f.state.sessions.find(s => s.id === 'unrelated'); other.nativeId = 'native-reconnected'; other.connectionRevision++;
  f.state.rooms.find(r => r.id === B).name = 'Unrelated renamed space';
  f.archive.unrelated = { rooms: [{ id: B }], at: 123 };
  assert.equal(JSON.stringify([f.state.sessions[0], f.target, f.state.rooms.filter(r => r.id !== B)]), before);
  const result = await f.confirm(card);
  // These three original positives assumed an empty handler. The real routes
  // pause the other backend, so its changed identity is affected, not unrelated.
  if (!unrelated) {
    assert.notEqual(result.state, 'complete'); assert.deepEqual(f.effects, []);
    assert.equal((await f.ask(method, args, card.id)).duplicate, true); assert.deepEqual(f.effects, []);
    return;
  }
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



test('PF10 B1: global interrupt scope keeps unrelated backend routing protected', async t => {
  const { EventEmitter } = require('node:events'), { WorkspaceClient } = require('../workspace-client.cjs');
  const f = fixture(t), make = (key, record) => {
    const real = { owner: 'view', runtimeVersion: 'current-synthetic', capabilities: [], sessions: [{ ...record, messages: [] }], diagnostics: {}, room: { revision: 0, messages: [], run: null } };
    const client = new EventEmitter(), calls = [], entry = { key, client, real, state: structuredClone(real), calls };
    client.call = async (method, ...args) => {
      calls.push([method, ...args]);
      if (method === 'initial') return structuredClone(real);
      if (method === 'pause' && real.room.run) real.room.run.status = 'paused';
      return true;
    };
    client.close = () => client.emit('closed'); return entry;
  };
  const first = make('first', f.target), second = make('second', f.state.sessions[3]);
  const client = new WorkspaceClient([first, second], 'first', Symbol());
  t.after(() => client.close());
  second.real.room.run = { id: 'independent-run', ids: ['unrelated'], status: 'running' };
  client.control.armed.set(second.key, { entry: second, roomId: 'shared' });
  f.control.handlers.set('interrupt', (_c, id) => client.call('interrupt', id));
  const card = await f.ask('interrupt', ['target']); assert.equal(card.state, 'confirmation-required');
  f.state.sessions[3].nativeId = 'reconnected-unrelated'; f.state.sessions[3].connectionRevision++;
  second.real.sessions[0].nativeId = 'reconnected-unrelated'; second.real.sessions[0].connectionRevision++;
  second.state.sessions[0].nativeId = 'reconnected-unrelated'; second.state.sessions[0].connectionRevision++;
  const result = await f.confirm(card);
  t.diagnostic(JSON.stringify({ state: result.state, target: first.calls, other: second.calls, unrelatedRun: second.real.room.run.status }));
  assert.equal(second.calls.filter(([method]) => method === 'pause').length, 0, 'An old target-only card must not authorize pausing the changed other backend');
});

test('PF10 B2: omitted roomId still binds the actual shared message-file room', async t => {
  const { openMessageFile } = require('../local-files.cjs');
  const f = fixture(t, B), file = path.join(path.dirname(f.control.file), 'synthetic-material.txt');
  fs.writeFileSync(file, 'SYNTHETIC_PF10_MATERIAL');
  const shared = f.state.rooms.find(room => room.id === 'shared');
  shared.messages = [{ id: 'shared-history', sessionId: 'target', nativeId: null, role: 'assistant', text: 'Synthetic material ' + file }];
  const reference = { kind: 'room', sessionId: 'target', messageId: 'shared-history', nativeId: null, cwd: null };
  let reads = 0;
  f.control.handlers.set('openMessageFile', async (_c, ...args) => {
    const value = await openMessageFile({ snapshot: async () => f.state, openPath: () => assert.fail('No external app'), background: true }, ...args);
    reads++; return value;
  });
  const card = await f.ask('openMessageFile', [reference, file]); assert.equal(card.state, 'confirmation-required');
  shared.archived = true;
  const result = await f.confirm(card);
  t.diagnostic(JSON.stringify({ state: result.state, reads, archived: shared.archived, value: result.value }));
  assert.equal(reads, 0, 'The default shared-room target must invalidate its pending card when archived');
});

function routedFixture(t, { owned = false, legacy = false, owner = 'view' } = {}) {
  const { EventEmitter } = require('node:events'), { WorkspaceClient } = require('../workspace-client.cjs');
  const f = fixture(t); f.target.owner = owned ? owner : 'another-window';
  const make = (key, record, version) => {
    const real = { owner, runtimeVersion: version, capabilities: ['freeClaimV1'], sessions: [{ ...record, messages: [] }],
      diagnostics: {}, room: { revision: 0, messages: [], run: null } };
    const client = new EventEmitter(), calls = [], entry = { key, client, real, state: structuredClone(real), calls };
    client.call = async (method, ...args) => {
      calls.push([method, ...args]);
      if (method === 'initial') return structuredClone(real);
      if (method === 'pause' && real.room.run) real.room.run.status = 'paused';
      return true;
    };
    client.close = () => client.emit('closed'); return entry;
  };
  const first = make('target-backend', f.target, legacy ? '0.1.0-alpha.2' : 'current-synthetic');
  const second = make('other-backend', f.state.sessions[3], 'current-synthetic');
  second.real.room.run = { id: 'other-run', ids: ['unrelated'], status: 'running' };
  const router = new WorkspaceClient([first, second], first.key, Symbol()); t.after(() => router.close());
  router.control.armed.set(second.key, { entry: second, roomId: 'shared' });
  // Bind the real route query used by the production fingerprint; the handler
  // still executes WorkspaceClient.call/pauseExcept/pauseEntry unchanged.
  f.client.controlPauseScope = (method, args) => router.controlPauseScope(method, args);
  for (const method of ['interrupt', 'claim', 'terminal', 'input']) f.control.handlers.set(method, (_c, ...args) => router.call(method, ...args));
  const spoilOther = () => {
    for (const record of [f.state.sessions[3], second.real.sessions[0], second.state.sessions[0]]) {
      record.nativeId = 'reconnected-other'; record.connectionRevision++;
    }
  };
  return { ...f, first, second, router, spoilOther };
}
const routedCases = [
  ['modern own terminal', 'terminal', ['target'], { owned: true }, true],
  ['modern own claim', 'claim', ['target', 'chat'], { owned: true }, true],
  ['free claim', 'claim', ['target', 'chat', 'free'], {}, true],
  ['legacy own terminal', 'terminal', ['target'], { owned: true, legacy: true }, true],
  ['legacy own claim', 'claim', ['target', 'chat'], { owned: true, legacy: true }, true],
  ['terminal protocol response', 'input', ['target', '\x1b[1;1R'], {}, true],
  ['pointer hover response', 'input', ['target', '\x1b[<35;1;1M'], {}, true],
  ['modern takeover terminal', 'terminal', ['target'], {}, false],
  ['modern takeover claim', 'claim', ['target', 'chat'], {}, false],
  ['legacy takeover terminal', 'terminal', ['target'], { legacy: true }, false],
  ['legacy takeover claim', 'claim', ['target', 'chat'], { legacy: true }, false],
  ['ordinary Esc input', 'input', ['target', '\x1b'], {}, false],
  ['pointer press input', 'input', ['target', '\x1b[<0;1;1M'], {}, false],
  ['interrupt even in own view', 'interrupt', ['target'], { owned: true }, false],
  ['modern missing owner token', 'terminal', ['target'], { owned: true, owner: null }, false],
];
for (const [name, method, args, options, local] of routedCases) test(`PF10 B1 route: ${name} protects its actual pause scope`, async t => {
  const f = routedFixture(t, options), card = await f.ask(method, args);
  assert.equal(card.state, 'confirmation-required'); f.spoilOther();
  const result = await f.confirm(card);
  if (local) {
    assert.equal(result.state, 'complete', result.error);
    assert.equal(f.first.calls.filter(([m]) => m === method).length, 1);
  } else {
    assert.notEqual(result.state, 'complete'); assert.deepEqual(f.first.calls, []);
  }
  assert.deepEqual(f.second.calls.filter(([m]) => m !== 'initial'), [], 'Metadata refresh may read; it must never pause or write');
  assert.equal(f.second.real.room.run.status, 'running');
});
test('PF10 B1 route: an unchanged global interrupt still executes and pauses the other backend', async t => {
  const f = routedFixture(t), card = await f.ask('interrupt', ['target']);
  assert.equal((await f.confirm(card)).state, 'complete');
  assert.equal(f.first.calls.filter(([m]) => m === 'interrupt').length, 1);
  assert.equal(f.second.calls.filter(([m]) => m === 'pause').length, 1); assert.equal(f.second.real.room.run.status, 'paused');
});
test('PF10 B1 route: an own-view card cannot become a takeover when only the backend owner token changes', async t => {
  const f = routedFixture(t, { owned: true }), card = await f.ask('terminal', ['target']);
  f.first.real.owner = f.first.state.owner = 'replacement-window';
  assert.notEqual((await f.confirm(card)).state, 'complete');
  assert.deepEqual(f.first.calls, []); assert.deepEqual(f.second.calls, []);
});
for (const explicit of [false, true]) for (const archive of [false, true]) test(`PF10 B2 route: ${explicit ? 'explicit' : 'default'} shared file ${archive ? 'rejects archive' : 'survives another room change'}`, async t => {
  const { openMessageFile } = require('../local-files.cjs'), f = fixture(t, A);
  const file = path.join(path.dirname(f.control.file), 'synthetic-shared.txt'); fs.writeFileSync(file, 'SYNTHETIC_SHARED_FILE');
  const shared = f.state.rooms.find(r => r.id === 'shared');
  shared.messages = [{ id: 'history', sessionId: 'target', nativeId: null, role: 'assistant', text: 'File ' + file }];
  const ref = { kind: 'room', ...(explicit ? { roomId: 'shared' } : {}), sessionId: 'target', messageId: 'history', nativeId: null, cwd: null };
  let reads = 0;
  f.control.handlers.set('openMessageFile', async (_c, ...args) => {
    const result = await openMessageFile({ snapshot: async () => f.state, openPath: () => assert.fail('No external app'), background: true }, ...args);
    reads++; return result;
  });
  const card = await f.ask('openMessageFile', [ref, file]); assert.equal(card.state, 'confirmation-required');
  if (archive) shared.archived = true; else f.state.rooms.find(r => r.id === B).name = 'Unrelated room';
  const result = await f.confirm(card);
  assert.equal(reads, archive ? 0 : 1);
  if (archive) assert.notEqual(result.state, 'complete');
  else { assert.equal(result.state, 'complete'); assert.equal(result.value.text, 'SYNTHETIC_SHARED_FILE'); }
});
