const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { BackgroundControl, dialog } = require('../background-control.cjs'), operation = require('../background-operation.cjs');
const { RoomState } = require('../room-state.cjs'), { Workspace } = require('../workspace.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function part(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return main.slice(a, b); }
const methods = ['approve', 'operatorAction', 'wakePolicy', 'backendSwitchSettings', 'quitService', 'stop', 'forget', 'switchBackend', 'continueConnection', 'clearSharedHistory'];
const command = (method, n = 0, id = randomUUID()) => ({ action: 'invoke', method, operation_id: id, arguments:
  method === 'approve' ? ['target-' + n % 40, 'question-' + n, 'accept'] : method === 'operatorAction' ? ['target-' + n % 40, 'stop', null] :
  method === 'wakePolicy' ? ['target-' + n % 40, false] : method === 'backendSwitchSettings' ? [false, false] :
  ['quitService', 'clearSharedHistory'].includes(method) ? [] : method === 'switchBackend' ? [{ backendKey: 'backend', switch: { ready: true, stops: [], endsCodex: false } }] :
  method === 'continueConnection' ? ['target-' + n % 40] : ['target-' + n % 40] });
function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-all-confirmations-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actors = Array.from({ length: 5 }, (_, n) => ({ id: 'actor-' + n, nativeId: 'native-actor-' + n, provider, name: 'Actor ' + n }));
  const state = { sessions: [...actors, ...Array.from({ length: 40 }, (_, n) => ({ id: 'target-' + n, nativeId: 'native-target-' + n, provider, name: 'Target ' + n, messages: [] }))],
    room: { id: 'shared', run: null }, rooms: [], runtimeVersion: 'fixture', capabilities: [operation.CAPABILITY] };
  const effects = [], notices = [], reads = [], handlers = new Map(), contexts = new Map();
  const client = { snapshot: () => state, refresh: async () => { reads.push('refresh'); return state; }, close() {},
    call: async (method, ...args) => { if (method === 'initial') { reads.push('initial'); return state; } effects.push({ method, args }); return {}; },
    route: () => ({ key: 'backend', state }), operationGuard: () => () => {}, entries: [{ key: 'backend', state }] };
  const scope = { applicationHandlers: handlers, ipcMain: { handle() {} }, backgroundOperation: operation,
    showDialog: (c, kind, options) => dialog(c, kind, options), displayText: key => key, uiLocale: { displayText: (_lang, text) => text }, displayLanguage: () => 'en',
    uiError: require('../ui-errors.cjs').uiError, capabilitiesFor: () => ['forget', 'resume', 'transportReconnect', 'resubscribe'],
    roomState: { assertAvailable() {}, apply: value => value, value: { revision: 1 }, clear() { effects.push({ method: 'room.clear' }); } },
    sessionLabels: { remove() { effects.push({ method: 'removeLabel' }); } }, views: [], saveViews() { effects.push({ method: 'saveViews' }); }, forgetDraft() {},
    cleanupSpaceImageCopies: async () => ({ failed: false }), broadcastRoom: async () => {}, dataDir: dir,
    backendSwitch: { samePlan: () => true, readSettings: () => ({ auto: false, migrate: false }), writeSettings: (_dir, auto, migrate) => { effects.push({ method: 'settings.write' }); return { auto, migrate }; }, readRecords: () => ({}), clearRecord() { effects.push({ method: 'record.clear' }); } },
    backendSwitching: null, switchRecords: {}, notReconnected: () => false, endedByMove: () => [],
    connectionUpdateOptions: () => [{ id: 'target-0', backendKey: 'backend', ready: true, switch: { ready: true, stops: [], endsCodex: false } }],
    continuationStatus: () => ({ ready: true }), runBackendSwitch: async () => { effects.push({ method: 'backend.switch' }); return true; },
    runConnectionContinuation: async () => { effects.push({ method: 'backend.continue' }); return true; }, app: { getVersion: () => 'fixture', quit() { effects.push({ method: 'app.quit' }); } } };
  vm.createContext(scope);
  vm.runInContext(part('function register(', '\nasync function replaceBackendSockets('), scope);
  vm.runInContext(part("  for (const name of ['prepareInput'", "  register('retrySave',"), scope);
  vm.runInContext(part("  register('quitService',", "  register('draft',"), scope);
  vm.runInContext(part("  register('backendSwitchSettings',", "  register('openExternal',"), scope);
  const binding = (n = 0) => ({ sender: { id: actors[n].id, nativeId: actors[n].nativeId, provider: actors[n].provider, name: actors[n].name }, identity: { callId: 'native-call-' + n, turnId: 'native-turn' }, valid: () => true });
  const controller = new BackgroundControl({ dataDir: dir, handlers, confirmation: () => ({ message: 'Maintenance', buttons: ['Cancel', 'Confirm'], cancelId: 0 }), audit() {},
    confirmationPending: row => notices.push(row), context: async owner => {
      const c = { background: true, actor: owner, view: {}, client, checkActor() {}, refresh: client.refresh, win: { destroy() {}, isDestroyed: () => false },
        confirmationActors: () => state.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, archived: s.archived, nativeContextPending: s.nativeContextPending })),
        fingerprint: args => ({ sessions: state.sessions.filter(s => args.arguments.includes(s.id)).map(s => ({ id: s.id, nativeId: s.nativeId })), targetRevision: 1 }) };
      contexts.set(owner.id, c); return c;
    } });
  return { dir, actors, state, effects, notices, reads, handlers, scope, client, controller, binding, contexts };
}
async function seed(f, method, counts) {
  f.controller.commit(data => { data.records = []; });
  const template = await f.controller.call(f.binding(), command(method)); assert.equal(template.state, 'confirmation-required', JSON.stringify(template));
  f.controller.commit(data => {
    data.records = [];
    for (let actor = 0; actor < counts.length; actor++) for (let n = 0; n < counts[actor]; n++) {
      const row = JSON.parse(JSON.stringify(template)); row.id = `saved-${actor}-${n}`; row.actor = { ...row.actor, ...f.actors[actor], operationId: row.id }; row.command.operation_id = row.id;
      data.records.push(row);
    }
  });
}
for (const provider of ['claude', 'codex']) for (const method of methods) for (const limit of [32, 128]) test(`${provider} ${method}: actual handler honors the ${limit}-card boundary`, async t => {
  const f = fixture(t, provider); await seed(f, method, limit === 32 ? [31] : [32, 32, 32, 31]);
  const last = await f.controller.call(f.binding(limit === 32 ? 0 : 3), command(method, 31)); assert.equal(last.state, 'confirmation-required');
  const before = f.notices.length, refused = await f.controller.call(f.binding(limit === 32 ? 0 : 4), command(method, 32));
  assert.equal(refused.state, 'not-executed'); assert.equal(refused.reason, 'confirmation-limit'); assert.equal(refused.confirmation, undefined);
  assert.equal(f.notices.length, before); assert.equal(f.effects.length, 0);
  assert.equal((await f.controller.decide(last.actor.id, last.actor.nativeId, last.id, 1)).state, 'complete', 'An existing card can still be approved at the limit');
  assert.ok(f.effects.length > 0); const applied = f.effects.length;
  assert.equal((await f.controller.call(f.binding(limit === 32 ? 0 : 3), last.command)).duplicate, true); assert.equal(f.effects.length, applied);
});
for (const provider of ['claude', 'codex']) for (const method of methods) for (const mode of ['missing', 'replaced', 'archived', 'pending']) test(`${provider} ${method}: ${mode} requester cannot create a dynamic confirmation`, async t => {
  const f = fixture(t, provider), original = { ...f.actors[0] };
  if (mode === 'missing') f.state.sessions = f.state.sessions.filter(s => s.id !== original.id);
  if (mode === 'replaced') f.actors[0] = { ...original }; // The proof keeps its original native identity.
  if (mode === 'replaced') f.state.sessions.find(s => s.id === original.id).nativeId = 'replacement';
  if (mode === 'archived') f.state.sessions.find(s => s.id === original.id).archived = true;
  if (mode === 'pending') f.state.sessions.find(s => s.id === original.id).nativeContextPending = { reason: 'clear' };
  const result = await f.controller.call(f.binding(), command(method));
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'originating-session-unavailable');
  assert.equal(result.confirmation, undefined); assert.equal(f.notices.length, 0); assert.equal(f.effects.length, 0);
  assert.equal(result.retryWithNewOperationId, true); assert.match(result.retryHint, /new operation_id/);
  assert.deepEqual(result.guard, { auditRooms: ['shared'] });
});
test('the real desktop roster marks a backend session archived for admission and checkActor', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-real-archive-roster-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = { binaries: {}, close() {}, create(record) { record.nativeId = randomUUID(); const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' }); return runtime; } };
  const workspace = new Workspace(host, dir), rooms = new RoomState(dir); t.after(() => workspace.close());
  const id = await workspace.create('codex', dir, 'owner', 'Actor'), target = await workspace.create('codex', dir, 'owner', 'Target');
  const client = { snapshot: () => workspace.snapshot(), refresh: async () => workspace.snapshot(), close() {}, call: async (method, ...args) => {
    if (method === 'initial') return { ...workspace.snapshot(), capabilities: ['singleHomeMoveV1'] };
    if (method === 'pause') return;
    if (method === 'moveMembership') return workspace.moveMembership(...args);
    throw Error('Unexpected business call before confirmation: ' + method);
  } };
  await rooms.membership(client, id, true); await rooms.archiveSession(client, id);
  const raw = client.snapshot().sessions.find(s => s.id === id); assert.equal(Object.hasOwn(raw, 'archived'), false);
  const actor = { id, nativeId: raw.nativeId, provider: 'codex', name: 'Actor' }, c = { client, background: true, view: {}, refresh: client.refresh, win: { destroy() {} } };
  const scope = { context: c, client, actor, roomState: rooms, backgroundOperation: operation, roomIds: require('../collaboration-spaces.cjs').roomIds };
  vm.createContext(scope);
  if (main.includes('function controlRequestActors(')) vm.runInContext(part('function controlRequestActors(', '\nfunction projectBackgroundRecord('), scope);
  const start = main.indexOf('      context.confirmationActors =');
  if (start >= 0) vm.runInContext(main.slice(start, main.indexOf('      context.fingerprint =', start)), scope);
  else vm.runInContext(part('      context.checkActor =', '      context.fingerprint ='), scope);
  vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), scope);
  const maintenance = c.fingerprint({ method: 'spaceCreate', arguments: [] });
  assert.equal(maintenance.sessions.find(s => s.id === id).archived, true, 'The old maintenance fingerprint already uses desktop archive state');
  await assert.rejects(c.checkActor(), /originating native session changed/);
  const notices = [], handlers = new Map();
  client.entries = [{ key: 'backend', state: { ...client.snapshot(), capabilities: [operation.CAPABILITY] } }];
  Object.assign(scope, { applicationHandlers: handlers, ipcMain: { handle() {} }, showDialog: (context, kind, options) => dialog(context, kind, options), displayText: key => key, uiError: require('../ui-errors.cjs').uiError });
  vm.runInContext(part('function register(', '\nasync function replaceBackendSockets('), scope);
  vm.runInContext(part("  register('stop',", "  register('openExternal',"), scope);
  const controller = new BackgroundControl({ dataDir: dir, context: () => c, handlers, confirmationPending: row => notices.push(row) });
  const result = await controller.call({ sender: actor, identity: { callId: 'call', turnId: 'turn' }, valid: () => true }, { ...command('stop', 0, 'archived-raw-backend'), arguments: [target] });
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'originating-session-unavailable'); assert.equal(notices.length, 0);
});
for (const provider of ['claude', 'codex']) test(`${provider}: archiving a standalone target invalidates its pending stop`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-target-archive-'));
  const host = { binaries: {}, close() {}, create(record) { record.nativeId = randomUUID(); const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.stop = async () => ({ state: 'ended' }); return runtime; } };
  const workspace = new Workspace(host, dir), rooms = new RoomState(dir); let controller;
  t.after(async () => { await controller?.close(); workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await workspace.create(provider, dir, 'owner', 'Actor'), target = await workspace.create(provider, dir, 'owner', 'Target');
  const effects = [], handlers = new Map(), client = { snapshot: () => workspace.snapshot(), refresh: async () => workspace.snapshot(), close() {},
    callSpace() { throw Error('Standalone archive must not mutate a room'); }, call: async (method, ...args) => {
      if (method === 'initial') return { ...workspace.snapshot(), capabilities: ['singleHomeMoveV1'] };
      effects.push({ method, args }); return true;
    } };
  client.entries = [{ key: 'backend', state: { ...client.snapshot(), capabilities: [operation.CAPABILITY] } }];
  const actor = { id, nativeId: workspace.get(id).nativeId, provider, name: 'Actor' };
  const c = { background: true, actor, client, view: {}, refresh: client.refresh, win: { destroy() {}, isDestroyed: () => false } };
  const scope = vm.createContext({ context: c, client, actor, roomState: rooms, backgroundOperation: operation, roomIds: require('../collaboration-spaces.cjs').roomIds,
    applicationHandlers: handlers, ipcMain: { handle() {} }, showDialog: (context, kind, options) => dialog(context, kind, options), displayText: key => key, uiError: require('../ui-errors.cjs').uiError });
  vm.runInContext(part('function controlRequestActors(', '\nfunction projectBackgroundRecord('), scope);
  vm.runInContext(part('      context.confirmationActors =', '      context.fingerprint ='), scope);
  vm.runInContext(part('      context.fingerprint = command =>', '\n      context.delivery ='), scope);
  vm.runInContext(part('function register(', '\nasync function replaceBackendSockets('), scope);
  vm.runInContext(part("  register('stop',", "  register('openExternal',"), scope);
  controller = new BackgroundControl({ dataDir: dir, handlers, context: () => c });
  const pending = await controller.call({ sender: actor, identity: { callId: 'call', turnId: 'turn' }, valid: () => true },
    { action: 'invoke', method: 'stop', arguments: [target], operation_id: 'standalone-target-stop' });
  assert.equal(pending.state, 'confirmation-required');
  const before = structuredClone(workspace.get(target)); assert.deepEqual(scope.roomIds(before), []);
  await rooms.archiveSession(client, target);
  assert.deepEqual(workspace.get(target), before); assert.equal(Object.hasOwn(workspace.get(target), 'archived'), false);
  assert.equal(rooms.apply(client.snapshot()).sessions.find(s => s.id === target).archived, true);
  const result = await controller.decide(id, actor.nativeId, pending.id, 1);
  assert.equal(result.state, 'unconfirmed'); assert.match(result.error, /operation target changed/i); assert.deepEqual(effects, []);
});
test('all pending cards and maintenance reservations count; unrelated running work does not', async t => {
  const f = fixture(t); await seed(f, 'stop', [30]);
  f.controller.commit(data => {
    const original = data.records[0];
    for (let n = 0; n < 20; n++) data.records.push({ ...JSON.parse(JSON.stringify(original)), id: 'ordinary-' + n, state: 'running', command: { action: 'invoke', method: 'draft', arguments: [], operation_id: 'ordinary-' + n } });
    data.records.push({ ...JSON.parse(JSON.stringify(original)), id: 'maintenance', state: 'running', command: { action: 'invoke', method: 'spaceCreate', arguments: ['Space'], operation_id: 'maintenance' } });
  });
  assert.equal((await f.controller.call(f.binding(), command('stop', 30))).state, 'confirmation-required');
  const n = f.notices.length;
  assert.equal((await f.controller.call(f.binding(), command('stop', 31))).reason, 'confirmation-limit'); assert.equal(f.notices.length, n);
});
test('maintenance admission counts pending cards from other methods', async t => {
  const f = fixture(t); await seed(f, 'stop', [32]);
  f.handlers.set('spaceCreate', () => { f.effects.push({ method: 'must-not-execute' }); });
  const n = f.notices.length, result = await f.controller.call(f.binding(), { action: 'invoke', method: 'spaceCreate', arguments: ['Space'], operation_id: 'new-maintenance' });
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'confirmation-limit'); assert.equal(f.effects.length, 0); assert.equal(f.notices.length, n);
});
test('two dynamic confirmations competing for slot128 cannot overbook', { timeout: 10000 }, async t => {
  const f = fixture(t); await seed(f, 'stop', [32, 32, 32, 31]);
  let arrivals = 0, release; const barrier = new Promise(resolve => { release = resolve; });
  for (const actor of [3, 4]) {
    const c = await f.controller.view(f.actors[actor]); let refreshes = 0;
    c.refresh = async () => { if (++refreshes === 2) { if (++arrivals === 2) release(); await barrier; } };
  }
  const n = f.notices.length, results = await Promise.all([3, 4].map(actor => f.controller.call(f.binding(actor), command('stop', actor))));
  assert.equal(arrivals, 2); assert.deepEqual(results.map(r => r.state).sort(), ['confirmation-required', 'not-executed']);
  assert.equal(f.controller.data.records.filter(r => r.state === 'confirmation-required').length, 128); assert.equal(f.notices.length, n + 1); assert.equal(f.effects.length, 0);
});
test('failed refresh while admitting a dialog leaves a refusal, not a running operation', async t => {
  const f = fixture(t), c = await f.controller.view(f.actors[0]); let reads = 0;
  c.refresh = async () => { if (++reads === 2) throw Error('Synthetic refresh unavailable'); };
  const args = command('stop'), result = await f.controller.call(f.binding(), args);
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'originating-session-unavailable'); assert.equal(result.retryWithNewOperationId, true);
  assert.equal(result.confirmation, undefined); assert.deepEqual(result.guard, { auditRooms: ['shared'] }); assert.equal(f.notices.length, 0);
  c.refresh = async () => {};
  const duplicate = await f.controller.call(f.binding(), args); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.retryWithNewOperationId, true);
  assert.equal((await f.controller.call(f.binding(), { ...args, operation_id: 'fresh-after-refresh' })).state, 'confirmation-required');
});
for (const provider of ['claude', 'codex']) test(`${provider}: 33 real chooseFolder calls without paths leave normal confirmations available`, async t => {
  const f = fixture(t, provider);
  vm.runInContext(part("  register('chooseFolder',", "  register('newWindow',"), f.scope);
  const results = [];
  for (let n = 0; n < 33; n++) results.push(await f.controller.call(f.binding(), { action: 'invoke', method: 'chooseFolder', arguments: [], operation_id: 'folder-' + n }));
  const stop = await f.controller.call(f.binding(), command('stop')); assert.equal(stop.state, 'confirmation-required', 'A normal card remains available after all 33 selector attempts');
  for (const result of results) {
    assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'explicit-paths-required'); assert.equal(result.confirmation, undefined);
  }
  assert.equal(f.notices.length, 1); assert.equal(f.controller.data.records.filter(r => r.state === 'confirmation-required').length, 1);
  assert.equal((await f.controller.decide(stop.actor.id, stop.actor.nativeId, stop.id, 0)).state, 'cancelled');
  const chosen = await f.controller.call(f.binding(), { action: 'invoke', method: 'chooseFolder', arguments: [], operation_id: 'folder-with-path', paths: [f.dir] });
  assert.equal(chosen.state, 'complete'); assert.equal(chosen.value, f.dir); assert.equal(f.notices.length, 1);
});
for (const provider of ['claude', 'codex']) test(`${provider}: legacy open and save cards cannot exhaust the per-actor or global limit after restart`, async t => {
  const f = fixture(t, provider); await seed(f, 'stop', [32, 32, 32, 32]);
  f.controller.commit(data => { for (const [n, row] of data.records.entries()) {
    row.confirmation = { kind: n % 2 ? 'open' : 'save', options: {} }; delete row.confirmationNotifiedAt;
    row.command = { action: 'invoke', method: n % 2 ? 'chooseFolder' : 'saveSelector', arguments: [], operation_id: row.id };
  } });
  const cold = new BackgroundControl({ dataDir: f.dir, handlers: f.handlers, context: owner => f.controller.view(owner), confirmationPending: row => f.notices.push(row) });
  const pending = await cold.call(f.binding(), command('stop')); assert.equal(pending.state, 'confirmation-required'); assert.equal(f.notices.length, 2);
  assert.equal((await cold.decide(pending.actor.id, pending.actor.nativeId, pending.id, 0)).state, 'cancelled');
  assert.equal(f.effects.length, 0);
});
test('a missing save path returns a refusal instead of an unanswerable card', async t => {
  const f = fixture(t); f.handlers.set('saveSelector', c => dialog(c, 'save', { defaultPath: 'copy.txt' }));
  const args = { action: 'invoke', method: 'saveSelector', arguments: [], operation_id: 'missing-save-path' };
  const result = await f.controller.call(f.binding(), args);
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'explicit-paths-required'); assert.equal(result.confirmation, undefined);
  assert.match(result.error, /explicit.*paths/); assert.equal(f.notices.length, 0);
  assert.equal((await f.controller.call(f.binding(), args)).duplicate, true);
});
