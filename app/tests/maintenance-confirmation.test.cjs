const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { BackgroundControl } = require('../background-control.cjs');
const { RoomState } = require('../room-state.cjs');
const operation = require('../background-operation.cjs');
const cases = [
  ['create', [{ provider: 'codex', cwd: '/synthetic', name: 'Target' }]], ['spaceCreate', ['Space']],
  ['archiveSession', ['target']], ['restoreSession', ['target']], ['archiveRoom', []], ['restoreRoom', []],
  ['spaceAction', ['shared', 'join', ['target', true]]], ['spaceAction', ['shared', 'join', ['target', false]]],
  ['spaceAction', ['shared', 'archive', []]], ['spaceAction', ['shared', 'restore', []]],
  ['join', ['target', true]], ['join', ['target', false]], ['resume', ['target']], ['importHistory', ['native-target', {}]],
  ...['commit', 'recover', 'undo'].map(action => ['spaceMerge', [action, { operationId: 'merge', binding: 'binding' }]]),
  ...['runtimeLocation', 'openLocalFile', 'saveLocalFile', 'spaceFiles', 'openMessageFile'].map(method => [method, ['target']]),
  ...['interrupt', 'pause', 'claim', 'terminal', 'terminalSnapshot', 'resize', 'answer', 'input', 'prepareInput', 'observe', 'stageImages', 'pasteNativeContent', 'rename'].map(method => [method, ['target']]),
  ['pause', []], ['pause', ['agent']], ['spaceAction', ['shared', 'pause', []]],
  ['roomRename', ['Replacement']], ['spaceAction', ['shared', 'rename', ['Replacement']]],
];
function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-maintenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), writes = [], handlers = new Map();
  for (const [method] of cases) handlers.set(method, (_c, ...args) => { writes.push({ method, args }); return 'applied'; });
  const context = { background: true, view: {}, checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } };
  const snapshot = { sessions: [{ id: 'agent', nativeId: 'native-agent' }, { id: 'target', nativeId: 'native-target' }] };
  context.client.snapshot = () => snapshot;
  context.fingerprint = () => ({ sessions: snapshot.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, archived: s.archived, nativeContextPending: s.nativeContextPending })) });
  const sender = { id: 'agent', nativeId: 'native-agent', name: 'Agent', provider };
  const binding = { sender, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const config = { dataDir: dir, handlers, context: () => context,
    confirmation: (_actor, args) => ({ type: 'warning', message: args.method, detail: JSON.stringify(args.arguments), buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    audit: row => room.recordControlOperation(row, ['shared']),
  };
  return { dir, room, writes, context, binding, config, controller: new BackgroundControl(config) };
}
test('unanswered confirmations have per-actor and global bounds; cancellation releases a slot without replay', async t => {
  const f = fixture(t), ask = (binding, id) => f.controller.call(binding, { action: 'invoke', method: 'spaceCreate', arguments: ['Synthetic space'], operation_id: id });
  const bindings = Array.from({ length: 5 }, (_, n) => ({ ...f.binding, sender: { ...f.binding.sender, id: 'bounded-agent-' + n, nativeId: 'bounded-native-' + n } }));
  f.context.client.snapshot().sessions.push(...bindings.map(b => ({ id: b.sender.id, nativeId: b.sender.nativeId })));
  for (let actor = 0; actor < 4; actor++) {
    for (let n = 0; n < 32; n++) assert.equal((await ask(bindings[actor], `pending-${actor}-${n}`)).state, 'confirmation-required');
    const limited = await ask(bindings[actor], `actor-limit-${actor}`);
    assert.equal(limited.state, 'not-executed'); assert.equal(limited.reason, 'confirmation-limit');
  }
  const limited = await ask(bindings[4], 'global-limit');
  assert.equal(limited.state, 'not-executed'); assert.equal(limited.reason, 'confirmation-limit');
  assert.equal(f.controller.data.records.filter(r => r.state === 'confirmation-required').length, 128);
  assert.equal(f.writes.length, 0); assert.equal(f.room.value.events.at(-1).controlAudit.state, 'not-executed');
  await f.controller.decide('bounded-agent-0', 'bounded-native-0', 'pending-0-0', 0);
  assert.equal((await ask(bindings[4], 'new-global-slot')).state, 'confirmation-required');
  assert.equal((await ask(bindings[4], 'global-limit')).state, 'not-executed');
  assert.equal((await f.controller.call(bindings[4], { action: 'invoke', method: 'spaceCreate', arguments: ['Changed intent'], operation_id: 'global-limit' })).reason, 'confirmation-limit');
  assert.equal(f.writes.length, 0);
});
for (const mode of ['forgotten', 'native-replaced', 'archived', 'context-pending']) test(`unanswerable ${mode} actor confirmations cannot exhaust the global allowance`, async t => {
  const f = fixture(t), ask = (binding, id) => f.controller.call(binding, { action: 'invoke', method: 'spaceCreate', arguments: ['Synthetic space'], operation_id: id });
  const bindings = Array.from({ length: 5 }, (_, n) => ({ ...f.binding, sender: { ...f.binding.sender, id: 'orphan-agent-' + n, nativeId: 'orphan-native-' + n } }));
  const sessions = f.context.client.snapshot().sessions;
  sessions.push(...bindings.map(b => ({ id: b.sender.id, nativeId: b.sender.nativeId })));
  for (let n = 0; n < 4; n++) {
    const row = await ask(bindings[n], 'template-' + n); assert.equal(row.state, 'confirmation-required');
    f.controller.commit(data => {
      for (let index = 1; index < 32; index++) {
        const copy = JSON.parse(JSON.stringify(row)); copy.id = `saved-${n}-${index}`; copy.actor.operationId = copy.id; copy.command.operation_id = copy.id; data.records.push(copy);
      }
    });
  }
  const refused = await ask(bindings[4], 'before-orphan'); assert.equal(refused.reason, 'confirmation-limit');
  const prior = sessions.find(s => s.id === bindings[0].sender.id);
  if (mode === 'forgotten') sessions.splice(sessions.indexOf(prior), 1);
  if (mode === 'native-replaced') prior.nativeId = 'replacement-native';
  if (mode === 'archived') prior.archived = true;
  if (mode === 'context-pending') prior.nativeContextPending = true;
  const next = await ask(bindings[4], 'after-orphan');
  assert.equal(next.state, 'confirmation-required'); assert.equal(f.writes.length, 0);
  assert.equal(f.controller.data.records.find(r => r.id === 'template-0').state, 'confirmation-required', 'History is retained and never replayed or silently approved');
});
for (const provider of ['claude', 'codex']) for (const mode of ['missing', 'native-replaced', 'archived', 'context-pending', 'missing-roster']) test(`${provider}: a running ${mode} requester is refused before any maintenance confirmation`, async t => {
  const f = fixture(t, provider), notices = []; f.controller.confirmationPending = row => notices.push(row);
  const fingerprint = f.context.fingerprint;
  const sessions = f.context.client.snapshot().sessions, self = sessions.find(s => s.id === f.binding.sender.id);
  if (mode === 'missing') sessions.splice(sessions.indexOf(self), 1);
  if (mode === 'native-replaced') self.nativeId = 'replacement-native';
  if (mode === 'archived') self.archived = true;
  if (mode === 'context-pending') self.nativeContextPending = true;
  if (mode === 'missing-roster') f.context.fingerprint = () => ({});
  const rejected = { action: 'invoke', method: 'spaceCreate', arguments: ['No unusable prompt'], operation_id: 'invalid-requester' };
  const first = await f.controller.call(f.binding, rejected);
  assert.equal(first.state, 'not-executed'); assert.equal(first.reason, 'originating-session-unavailable');
  assert.equal(first.confirmation, undefined); assert.equal(f.writes.length, 0); assert.equal(notices.length, 0);
  assert.equal(f.controller.data.records.filter(r => r.state === 'confirmation-required').length, 0);
  assert.equal((await f.controller.call(f.binding, rejected)).reason, 'originating-session-unavailable');
  for (let n = 0; n < 33; n++) {
    const next = await f.controller.call(f.binding, { ...rejected, operation_id: 'blocked-' + n });
    assert.equal(next.state, 'not-executed'); assert.equal(next.confirmation, undefined);
  }
  assert.equal(notices.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.controller.data.records.filter(r => r.state === 'confirmation-required').length, 0);
  assert.equal(f.room.value.events.at(-1).controlAudit.state, 'not-executed');
  await assert.rejects(f.controller.decide(f.binding.sender.id, f.binding.sender.nativeId, first.id, 1), /no longer current/);
  const restored = { ...self, nativeId: f.binding.sender.nativeId, archived: false, nativeContextPending: false };
  if (mode === 'missing') sessions.push(restored); else Object.assign(self, restored);
  f.context.fingerprint = fingerprint;
  assert.equal((await f.controller.call(f.binding, rejected)).state, 'confirmation-required', 'A compacted refused ID becomes a new request and still needs consent');
  assert.equal(f.writes.length, 0); assert.equal(notices.length, 1);
  const fresh = await f.controller.call(f.binding, { ...rejected, operation_id: 'fresh-after-restoration' });
  assert.equal(fresh.state, 'confirmation-required'); assert.equal(notices.length, 1, 'Equivalent waiting requests share one notification');
});
for (const provider of ['claude', 'codex']) for (const [index, [method, args]] of cases.entries()) test(`${provider} ${method}[${index}]: pending and cancel have no effect, human approval executes once`, async t => {
  const f = fixture(t, provider), command = { action: 'invoke', operation_id: 'refuse', method, arguments: args };
  const pending = await f.controller.call(f.binding, command);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(f.writes.length, 0);
  assert.equal(f.room.value.events.at(-1).controlAudit.state, 'confirmation-required');
  assert.equal((await f.controller.decide('agent', 'native-agent', 'refuse', 0)).state, 'cancelled'); assert.equal(f.writes.length, 0);
  assert.equal(f.room.value.events.at(-1).controlAudit.state, 'cancelled');
  const approved = { ...command, operation_id: 'allow' };
  await f.controller.call(f.binding, approved);
  assert.equal((await f.controller.decide('agent', 'native-agent', 'allow', 1)).state, 'complete'); assert.equal(f.writes.length, 1);
  assert.equal(f.room.value.events.at(-1).controlAudit.state, 'complete');
  assert.equal((await f.controller.call(f.binding, approved)).duplicate, true); assert.equal(f.writes.length, 1);
  await assert.rejects(f.controller.decide('agent', 'native-agent', 'allow', 1));
});
test('read-only merge phases and unrelated queue metadata do not acquire a maintenance gate', () => {
  for (const phase of ['preview', 'status', 'discard']) assert.equal(operation.maintenanceAction('spaceMerge', [phase, {}]), null);
  for (const phase of ['queueAdd', 'queueCancel', 'queueResolve', 'notes', 'memberOrder']) assert.equal(operation.maintenanceAction('spaceAction', ['shared', phase, []]), null);
});
test('a confirmed operation refuses a changed fingerprint and records the refusal', async t => {
  const f = fixture(t), fingerprint = f.context.fingerprint; let placement = 1; f.context.fingerprint = () => ({ ...fingerprint(), placement });
  await f.controller.call(f.binding, { action: 'invoke', operation_id: 'changed', method: 'archiveSession', arguments: ['target'] });
  placement++;
  assert.equal((await f.controller.decide('agent', 'native-agent', 'changed', 1)).state, 'unconfirmed');
  assert.equal(f.writes.length, 0); assert.equal(f.room.value.events.at(-1).controlAudit.state, 'unconfirmed');
});
test('audit is one attributed event per operation and never shares raw arguments', async t => {
  const f = fixture(t), command = { action: 'invoke', operation_id: 'audit', method: 'create', arguments: [{ cwd: '/synthetic/PRIVATE_PATH', name: 'PRIVATE_ARGUMENT' }] };
  await f.controller.call(f.binding, command); const id = f.room.value.events[0].id;
  await f.controller.decide('agent', 'native-agent', 'audit', 1);
  assert.equal(f.room.value.events.length, 1); assert.equal(f.room.value.events[0].id, id);
  assert.equal(f.room.value.events[0].controlAudit.actor.id, 'agent');
  assert.equal(f.room.value.events[0].controlAudit.method, 'create');
  assert.ok(!JSON.stringify(f.room.value.events).includes('PRIVATE_'));
  const cold = new RoomState(f.dir); assert.equal(cold.value.events[0].controlAudit.state, 'complete');
});
test('missing confirmation or failed event storage cannot execute an approved maintenance action', async t => {
  const f = fixture(t), command = { action: 'invoke', operation_id: 'store', method: 'create', arguments: [] };
  await f.controller.call(f.binding, command);
  f.config.audit = () => { throw Error('Synthetic audit failure'); };
  const cold = new BackgroundControl(f.config);
  assert.equal((await cold.decide('agent', 'native-agent', 'store', 1)).state, 'unconfirmed'); assert.equal(f.writes.length, 0);
  const noConfirmation = new BackgroundControl({ ...f.config, audit() {}, confirmation: undefined });
  assert.equal((await noConfirmation.call(f.binding, { ...command, operation_id: 'missing' })).state, 'unconfirmed'); assert.equal(f.writes.length, 0);
});
test('a stale native actor cannot confirm and the space records the unconfirmed outcome', async t => {
  const f = fixture(t), command = { action: 'invoke', operation_id: 'stale', method: 'create', arguments: [] };
  await f.controller.call(f.binding, command); f.context.checkActor = () => { throw Error('Native identity changed'); };
  assert.equal((await f.controller.decide('agent', 'native-agent', 'stale', 1)).state, 'unconfirmed');
  assert.equal(f.writes.length, 0); assert.equal(f.room.value.events.at(-1).controlAudit.state, 'unconfirmed');
});
test('a protected invocation refused by the busy actor gate is durably attributed', async t => {
  const f = fixture(t); let release;
  f.config.handlers.set('rename', () => new Promise(r => { release = r; }));
  const running = f.controller.call(f.binding, { action: 'invoke', operation_id: 'busy', method: 'rename', arguments: ['agent'] });
  while (!release) await new Promise(r => setImmediate(r));
  try {
    const refused = await f.controller.call(f.binding, { action: 'invoke', operation_id: 'refused', method: 'create', arguments: [] });
    assert.equal(refused.state, 'not-executed'); assert.equal(refused.reason, 'another-operation-running');
    assert.equal(f.room.value.events.at(-1).controlAudit.state, 'not-executed'); assert.equal(f.writes.length, 0);
  } finally { release(); await running; }
});
test('own-session controls retain their ordinary path; pause remains global even with an own ID', async t => {
  const f = fixture(t);
  for (const method of ['interrupt', 'claim', 'terminal', 'terminalSnapshot', 'resize', 'answer', 'input', 'prepareInput', 'observe', 'stageImages', 'pasteNativeContent', 'rename']) {
    const result = await f.controller.call(f.binding, { action: 'invoke', operation_id: method, method, arguments: ['agent'] });
    assert.equal(result.state, 'complete');
    assert.equal(operation.maintenanceAction(method, ['agent'], f.binding.sender), null);
  }
  assert.equal(f.writes.length, 12);
  assert.equal(operation.maintenanceAction('pause', [], f.binding.sender), 'pause');
  assert.equal(operation.maintenanceAction('pause', ['agent'], f.binding.sender), 'pause');
  for (const method of ['unobserve', 'nativeHistory', 'pasteText']) assert.equal(operation.maintenanceAction(method, ['target'], f.binding.sender), null);
});
test('durable confirmation notifies once, binds selected paths, and cannot be replayed', async t => {
  const f = fixture(t), notices = [], controller = new BackgroundControl({ ...f.config, confirmationPending: row => notices.push(row) });
  const command = { action: 'invoke', operation_id: 'file', method: 'openLocalFile', arguments: [], paths: ['/synthetic/original.txt'] };
  assert.equal((await controller.call(f.binding, command)).state, 'confirmation-required');
  await controller.call(f.binding, command); assert.equal(notices.length, 1); assert.equal(f.writes.length, 0);
  assert.equal(notices[0].state, 'confirmation-required');
  await assert.rejects(controller.call(f.binding, { ...command, paths: ['/synthetic/other.txt'] }));
  assert.equal((await controller.decide('agent', 'native-agent', 'file', 1)).state, 'complete');
  assert.equal(notices.length, 1); assert.equal(f.writes.length, 1);
});
for (const [target, pending, expected] of [['agent', false, 'complete'], ['agent', true, 'confirmation-required'], ['target', true, 'confirmation-required']])
test(`actual main input wrapper preserves own pending-approval protection without a second cross-session dialog: ${target}/${pending}`, async t => {
  const f = fixture(t), handlers = new Map(), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), start = source.indexOf('function register('), end = source.indexOf('\nasync function replaceBackendSockets(', start);
  assert.ok(start > 0 && end > start);
  const state = { wakePolicy: { enabled: true }, sessions: [{ id: target, ...(pending ? { approval: { requestId: 'native-question' } } : {}) }] };
  Object.assign(f.context.client, { refresh: async () => {}, snapshot: () => state, call: async method => { assert.equal(method, 'initial'); return state; }, entries: [{ state: { ...state, capabilities: [operation.CAPABILITY] } }] });
  const scope = { applicationHandlers: handlers, backgroundOperation: operation, ipcMain: { handle() {} },
    showDialog: (context, kind, options) => require('../background-control.cjs').dialog(context, kind, JSON.parse(JSON.stringify(options))),
    displayText: key => ({ 'common.cancel': 'Cancel', 'background.confirm': 'Confirm' })[key] || key };
  vm.createContext(scope); vm.runInContext(source.slice(start, end), scope);
  scope.register('input', () => { f.writes.push('input'); return true; });
  const controller = new BackgroundControl({ ...f.config, handlers }), command = { action: 'invoke', operation_id: 'input-main', method: 'input', arguments: [target, 'Synthetic input'] };
  assert.equal((await controller.call(f.binding, command)).state, expected);
  if (pending) { assert.equal(f.writes.length, 0); assert.equal((await controller.decide('agent', 'native-agent', command.operation_id, 1)).state, 'complete'); }
  assert.equal(f.writes.length, 1);
});
test('the independent view is refreshed before saving a consent fingerprint', async t => {
  const f = fixture(t), fingerprint = f.context.fingerprint; let generation = 0;
  f.context.refresh = async () => { generation = 1; };
  f.context.fingerprint = () => { const read = { ...fingerprint(), generation }; generation = 1; return read; };
  const r = await f.controller.call(f.binding, { action: 'invoke', operation_id: 'fresh-view', method: 'openLocalFile', arguments: [] });
  assert.equal(r.state, 'confirmation-required'); assert.equal(r.guard.generation, 1); assert.equal(f.writes.length, 0);
});
test('an absent original space cannot block the audit or confirmation for releasing a session', async t => {
  const f = fixture(t), missing = require('node:crypto').randomUUID();
  const controller = new BackgroundControl({ ...f.config, audit: row => f.room.recordControlOperation(row, [missing]) });
  const command = { action: 'invoke', operation_id: 'missing-space', method: 'restoreSession', arguments: ['target'] };
  assert.equal((await controller.call(f.binding, command)).state, 'confirmation-required');
  assert.equal(f.room.value.events.at(-1).controlAudit.state, 'confirmation-required');
  assert.equal((await controller.decide('agent', 'native-agent', command.operation_id, 1)).state, 'complete');
  assert.equal(f.writes.length, 1);
});
test('a valid own message cannot authorize an unmentioned local file before human confirmation', async t => {
  const f = fixture(t), file = path.join(f.dir, 'separate.txt'); fs.writeFileSync(file, 'SYNTHETIC SEPARATE MATERIAL', { mode: 0o600 });
  const source = { kind: 'session', sessionId: 'agent', messageId: 'message', nativeId: 'native-agent', cwd: f.dir };
  const snapshot = { sessions: [{ id: 'agent', nativeId: 'native-agent', cwd: f.dir, messages: [{ id: 'message', nativeId: 'native-agent', role: 'assistant', text: 'No local file reference here.' }] }] };
  let reads = 0;
  f.config.handlers.set('openMessageFile', async (_c, ...args) => { reads++; return require('../local-files.cjs').openMessageFile({ snapshot: async () => snapshot, background: true, openPath() { throw Error('No desktop file open'); } }, ...args); });
  const command = { action: 'invoke', operation_id: 'unmentioned', method: 'openMessageFile', arguments: [source, file] };
  assert.equal((await f.controller.call(f.binding, command)).state, 'confirmation-required'); assert.equal(reads, 0);
  assert.equal((await f.controller.decide('agent', 'native-agent', command.operation_id, 0)).state, 'cancelled'); assert.equal(reads, 0);
  const approved = { ...command, operation_id: 'selected' }; await f.controller.call(f.binding, approved);
  const done = await f.controller.decide('agent', 'native-agent', approved.operation_id, 1);
  assert.equal(done.state, 'complete'); assert.equal(done.value.text, 'SYNTHETIC SEPARATE MATERIAL'); assert.equal(reads, 1);
});
test('a request sent again a minute later pops a new system notification; an immediate retry shares the one just shown', async t => {
  // The person (2026-11-13, queue a3519cb6): 「我还是找不到你的这个按钮」. The agent asked again, the first card
  // was still waiting, and the request sent again shared the first card's notification, so nothing popped up.
  const f = fixture(t), notices = []; let clock = Date.parse('2026-11-13T20:20:00Z');
  const controller = new BackgroundControl({ ...f.config, now: () => clock, confirmationPending: row => notices.push(row.id) });
  const ask = (id, name = 'Synthetic space') => controller.call(f.binding, { action: 'invoke', method: 'spaceCreate', arguments: [name], operation_id: id });
  assert.equal((await ask('first')).state, 'confirmation-required'); assert.deepEqual(notices, ['first']);
  clock += 5000;
  assert.equal((await ask('retry-burst')).state, 'confirmation-required');
  assert.deepEqual(notices, ['first'], 'An immediate retry shares the notification just shown');
  clock += 60000;
  assert.equal((await ask('sent-again')).state, 'confirmation-required');
  assert.deepEqual(notices, ['first', 'sent-again'], 'The first card is still waiting a minute later: the request sent again tells the person again');
  clock += 20000;
  assert.equal((await ask('sent-again-retry')).state, 'confirmation-required');
  assert.deepEqual(notices, ['first', 'sent-again'], 'A retry right after the second notification shares that one');
  assert.equal((await ask('other-request', 'Another space')).state, 'confirmation-required');
  assert.deepEqual(notices, ['first', 'sent-again', 'other-request'], 'A different request is told on its own');
  assert.equal((await ask('sent-again')).duplicate, true); assert.equal(notices.length, 3, 'The same operation id read back is not a new request');
  clock -= 10 * 60000;
  assert.equal((await ask('after-clock-back')).state, 'confirmation-required');
  assert.deepEqual(notices.at(-1), 'after-clock-back', 'After the clock went back the window is unknown: the person is told');
  assert.equal(controller.data.records.filter(r => r.state === 'confirmation-required').length, 6); assert.equal(f.writes.length, 0);
});
