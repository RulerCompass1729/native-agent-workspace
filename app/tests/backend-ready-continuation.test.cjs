const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const locale = require('../ui-locale.js');
const { uiError } = require('../ui-errors.cjs');
const { canRetire, continuationStatus } = require('../service-client.cjs');
const backendSwitch = require('../backend-switch.cjs');
const queueRules = require('../queue-dispatch.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
const ast = box.exports.parse(main, { ecmaVersion: 'latest' });
function source(name) {
  const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(node, `actual main function ${name}`);
  return main.slice(node.start, node.end);
}
const current = '0.1.0-alpha.227';
function fixture(settings = { auto: true, migrate: false }) {
  const events = [], notices = [], handlers = {};
  const old = { key: 'old', client: {}, state: { runtimeVersion: '0.1.0-alpha.226', capabilities: ['atomicShutdown', 'backendSwitchV1'],
    sessions: [{ id: 'ended', nativeId: 'native-ended', provider: 'claude', name: 'Ended task', state: 'ended' }], room: { messages: [] } } };
  const active = { key: 'current', client: {}, state: { runtimeVersion: current, capabilities: [], sessions: [], room: { messages: [] } } };
  const control = { maintenance: new Set(), generations: new Map(), revision: 0, manualEpoch: 0, views: new Set() };
  let refreshes = 0;
  const client = { entries: [old, active], active, control, socket: { destroyed: false },
    snapshot() { return { sessions: this.entries.flatMap(e => e.state.sessions) }; },
    sessionState: value => value.state,
    route(id) { const entry = this.entries.find(e => e.state.sessions.some(s => s.id === id)); assert.ok(entry); return entry; },
    async refresh() { events.push('refresh'); refreshes++; await f.onRefresh?.(refreshes); },
    operationGuard(entry) { const guard = WorkspaceClient.prototype.operationGuard.call(this, entry); return () => { events.push('guard'); guard(); }; },
    maintainService(key) { events.push(`maintain:${key}`); const finish = WorkspaceClient.prototype.maintainService.call(this, key); return () => { events.push(`finish:${key}`); finish(); }; },
  };
  control.views.add(client);
  const context = { client, view: { owner: 'synthetic-owner' }, win: { isDestroyed: () => false, webContents: { send: (event, notice) => notices.push({ event, notice }) } } };
  const scope = vm.createContext({ canRetire, continuationStatus, uiError, uiLocale: locale, roomState: { apply: state => state },
    app: { getVersion: () => current }, backendSwitch: { ...backendSwitch, readSettings: () => settings },
    windows: new Map([[1, context]]), backendSwitching: null, autoSwitchRunning: false, autoSwitchFailed: new Set(), quitting: false, quietWindows: null,
    lastAutomaticHistoryCandidate: null,
    async retireIdleSession(context) { await f.onRetireIdleSession?.(context); },
    queueDispatcher: null, queueRules: { ...queueRules, nextBackendMove(...args) { events.push('nextMove'); return queueRules.nextBackendMove(...args); } },
    migrateQuietMs: () => queueRules.MIGRATE_QUIET_MS, migrateUnprovenQuietMs: () => queueRules.MIGRATE_UNPROVEN_QUIET_MS,
    runningRelays: () => new Set(), dataDir: 'synthetic-profile', process: { execPath: 'synthetic-node' },
    async continueService(directory, executable, id) { events.push(`continue:${id}`); assert.equal(control.maintenance.has(old.key), true); if (f.fail === 'continue') throw Error('synthetic continuation failure'); old.state.runtimeVersion = current; return { key: old.key }; },
    async replaceBackendSockets(key) { events.push(`sockets:${key}`); assert.equal(control.maintenance.has(key), true); if (f.fail === 'sockets') throw Error('synthetic reconnect failure'); },
    async broadcastRoom() { assert.equal(scope.backendSwitching, null); assert.equal(control.maintenance.size, 0); events.push('broadcast'); },
    async runBackendSwitch(c, option) { events.push(`switch:${option.backendKey}`); return { resumed: [], left: [] }; },
    recordMigration() { throw Error('ready continuation must not write migration records'); },
    recordMigrationFailure() { throw Error('ready continuation must not write migration failures'); },
    showDialog: async () => { events.push('dialog'); return await f.answer(); },
    displayText: (key, params) => locale.format('zh', key, params), displayLanguage: () => 'zh',
    register: (name, handler) => handlers[name] = handler,
  });
  for (const name of ['sendToPage', 'connectionUpdateOptions', 'autoBackendSwitchOnce', 'autoBackendSwitch']) vm.runInContext(source(name), scope);
  // Without a quiet-window record, as when it could not be opened (quiet-windows.cjs).
  for (const name of ['passQuietWindows', 'quietWindowMoved']) if (ast.body.some(node => node.type === 'FunctionDeclaration' && node.id.name === name)) vm.runInContext(source(name), scope);
  // The baseline has no shared helper; the automatic-success assertions still expose its missing route.
  if (ast.body.some(node => node.type === 'FunctionDeclaration' && node.id.name === 'runConnectionContinuation')) vm.runInContext(source('runConnectionContinuation'), scope);
  for (const name of ['historyRetirementCandidates', 'runHistoryRetirements']) {
    if (ast.body.some(node => node.type === 'FunctionDeclaration' && node.id.name === name)) vm.runInContext(source(name), scope);
  }
  const start = main.indexOf("  register('continueConnection',"), end = main.indexOf("  for (const action of ['resume', 'forget'])", start);
  vm.runInContext(main.slice(start, end), scope);
  const f = { old, active, control, client, context, scope, events, notices, handlers, answer: () => { throw Error('automatic continuation must not ask for confirmation'); } };
  return f;
}
test('backend release requires the current desktop and confirmation of the same candidate', async () => {
  const path = require('node:path');
  for (const mode of ['background', 'cancel', 'stale', 'release', 'unreadable', 'partial']) {
    const f = fixture(), { old, context, scope, events, control } = f;
    old.state.servicePid = 518;
    const unreadable = { ...old, key: 'unreadable' };
    if (mode === 'unreadable') f.client.entries = [unreadable, f.active];
    if (mode === 'partial') f.client.entries.unshift(unreadable);
    Object.assign(scope, { path, isCurrentHumanContext: value => !value.background,
      require: name => {
        assert.equal(name, './service-lock.cjs');
        return { readLock(file) {
          if (file === path.join(scope.dataDir, unreadable.key, 'service.lock')) {
            throw Object.assign(Error('Synthetic unreadable lock'), { code: 'EIO' });
          }
          return { pid: 518, started: 'synthetic start' };
        } };
      },
      canRetire: state => state === old.state,
      retireHistoryService: async (_path, key, target) => {
        assert.equal(control.maintenance.has(key), true);
        assert.deepEqual([key, target.pid, target.started, target.sessions[0].nativeId], ['old', 518, 'synthetic start', 'native-ended']);
        events.push('retire');
        return true;
      },
    });
    vm.runInContext(source('retireHistoryBackends'), scope);
    f.answer = () => {
      if (mode === 'stale') control.generations.set('old', 1);
      return { response: mode === 'cancel' ? 0 : 1 };
    };
    if (mode === 'background') {
      context.background = true;
      await assert.rejects(scope.retireHistoryBackends(context));
      assert.deepEqual(events, []);
      continue;
    }
    const result = await scope.retireHistoryBackends(context);
    if (mode === 'cancel') { assert.equal(result, null); assert.deepEqual(events, ['dialog']); }
    if (mode === 'stale') { assert.deepEqual([result.retired, result.skipped], [0, 1]); assert.deepEqual(events, ['dialog', 'guard', 'broadcast']); }
    if (mode === 'unreadable') { assert.deepEqual([result.retired, result.skipped], [0, 1]); assert.deepEqual(events, []); }
    if (mode === 'release' || mode === 'partial') {
      assert.deepEqual([result.retired, result.skipped], [1, mode === 'partial' ? 1 : 0]);
      assert.deepEqual(events, ['dialog', 'guard', 'maintain:old', 'retire', 'sockets:old', 'finish:old', 'broadcast']);
    }
  }
});
test('ready all-ended backends use guarded continuation under either automatic setting, without stopping sessions or prompting', async () => {
  for (const settings of [{ auto: true, migrate: false }, { auto: false, migrate: true }]) {
    const f = fixture(settings);
    const [option] = f.scope.connectionUpdateOptions(f.client, current, f.scope.roomState);
    assert.equal(option.ready, true); assert.equal(option.switch, null);
    await f.scope.autoBackendSwitchOnce();
    assert.deepEqual(f.events, ['refresh', 'guard', 'refresh', 'guard', 'maintain:old', 'continue:ended', 'sockets:old', 'finish:old', 'broadcast']);
    assert.equal(f.control.maintenance.size, 0); assert.equal(f.scope.backendSwitching, null);
    assert.equal(f.notices.length, 1); assert.equal(f.notices[0].event, 'workspace:backend-switched');
    assert.equal(f.notices[0].notice.backend.version, '0.1.0-alpha.226');
    assert.equal(f.notices[0].notice.backend.sessions[0].name, 'Ended task');
    assert.equal(f.notices[0].notice.error, undefined);
    assert.equal(f.scope.connectionUpdateOptions(f.client, current, f.scope.roomState).length, 0);
  }
});
test('automatic maintenance releases an ended history backend and never prompts or stops a session', async () => {
  const f = fixture(), { old, active, scope, control, events } = f;
  let unreadableLock = false;
  old.state.runtimeVersion = current;
  old.state.capabilities.push('conditionalMaintenanceStopV1');
  old.state.servicePid = 519;
  active.state.capabilities.push('conditionalMaintenanceStopV1');
  active.state.sessions = [{ ...old.state.sessions[0], id: 'active-session', nativeId: 'active-native' }];
  Object.assign(scope, { path: require('node:path'), connectProfileBackend() {},
    require: name => {
      assert.equal(name, './service-lock.cjs');
      return { readLock: file => {
        assert.equal(file, require('node:path').join('synthetic-profile', 'old', 'service.lock'));
        if (unreadableLock) throw Object.assign(Error('Synthetic lock read failure'), { code: 'EIO' });
        return { pid: 519, started: 'synthetic start' };
      } };
    },
    async retireHistoryService(_path, key, target) {
      assert.equal(control.maintenance.has(key), true);
      assert.deepEqual([key, target.pid, target.started, target.sessions[0].nativeId], ['old', 519, 'synthetic start', 'native-ended']);
      events.push('retire');
      old.state.capabilities = [];
      return true;
    },
  });
  old.state.sessions.push({ ...old.state.sessions[0], id: 'still-native', state: 'disconnected' });
  await scope.autoBackendSwitchOnce();
  assert.equal(events.includes('retire'), false);
  old.state.sessions.pop();
  unreadableLock = true;
  events.length = 0;
  await scope.autoBackendSwitchOnce();
  assert.deepEqual(events, ['refresh', 'nextMove']);
  unreadableLock = false;
  events.length = 0;
  await scope.autoBackendSwitchOnce();
  assert.deepEqual(events, ['guard', 'maintain:old', 'retire', 'sockets:old', 'finish:old', 'broadcast']);
  assert.equal(scope.backendSwitching, null);
  await scope.autoBackendSwitchOnce();
  assert.equal(events.filter(event => event === 'retire').length, 1);
});
test('disabled settings, shutdown, another move and unavailable foreground connections make no automatic writes', async () => {
  const changes = [f => { f.scope.quitting = true; }, f => { f.scope.backendSwitching = 'another'; },
    f => { f.context.background = true; }, f => { f.context.win.isDestroyed = () => true; },
    f => { f.client.closing = true; }, f => { f.client.socket.destroyed = true; }];
  for (const change of changes) { const f = fixture(); change(f); await f.scope.autoBackendSwitchOnce(); assert.deepEqual(f.events, []); }
  const off = fixture({ auto: false, migrate: false });
  off.old.state.capabilities.push('conditionalMaintenanceStopV1');
  await off.scope.autoBackendSwitchOnce();
  assert.deepEqual(off.events, []);
});
test('disconnected and all other non-ended sessions remain ineligible, including hidden siblings and effective active state', async () => {
  for (const state of ['disconnected', 'idle', 'working', 'approval', 'error', 'stopping']) {
    const f = fixture(); f.old.state.sessions.push({ id: 'hidden', nativeId: 'native-hidden', provider: 'codex', name: 'Hidden task', archived: true, state });
    await f.scope.autoBackendSwitchOnce(); assert.ok(!f.events.some(e => e.startsWith('continue:') || e.startsWith('maintain:'))); assert.equal(f.notices.length, 0);
  }
  for (const change of [f => { f.old.state.storageWarning = 'synthetic persistence failure'; }, f => { f.old.state.capabilities = []; },
    f => { f.old.state.sessions[0].nativeId = null; }, f => { f.old.state.runtimeVersion = 'unknown'; },
    f => { f.old.state.runtimeVersion = current; }, f => { f.old.closed = true; },
    f => { f.control.maintenance.add('old'); }, f => { f.client.sessionState = () => 'working'; }]) {
    const f = fixture(); change(f); await f.scope.autoBackendSwitchOnce(); assert.ok(!f.events.some(e => e.startsWith('continue:') || e.startsWith('maintain:')));
  }
});
test('refresh rechecks the original backend, native identity, version, ended state and operation generation before maintenance', async () => {
  const changes = [f => { f.client.entries[0] = { ...f.old }; }, f => { f.old.state.sessions[0].nativeId = 'changed-native'; },
    f => { f.old.state.runtimeVersion = '0.1.0-alpha.225'; }, f => { f.old.state.sessions[0].state = 'disconnected'; },
    f => { f.old.state.storageWarning = 'synthetic write failure'; }, f => { f.control.generations.set('old', 1); },
    f => { f.client.sessionState = () => 'working'; }];
  for (const change of changes) {
    const f = fixture(); f.onRefresh = n => { if (n === 2) change(f); };
    await f.scope.autoBackendSwitchOnce();
    assert.ok(!f.events.some(e => e.startsWith('maintain:') || e.startsWith('continue:')));
    assert.equal(f.scope.autoSwitchFailed.has('old'), true); assert.equal(f.scope.backendSwitching, null);
    assert.equal(f.notices.length, 1); assert.ok(f.notices[0].notice.error);
  }
});
test('continuation and socket failures release maintenance and block this run from retrying; manual confirmation remains usable', async () => {
  for (const failure of ['continue', 'sockets']) {
    const f = fixture(); f.fail = failure; await f.scope.autoBackendSwitchOnce();
    assert.equal(f.control.maintenance.size, 0); assert.equal(f.scope.backendSwitching, null);
    assert.ok(f.events.indexOf('finish:old') < f.events.indexOf('broadcast')); assert.equal(f.scope.autoSwitchFailed.has('old'), true);
    assert.equal(f.notices[0].notice.backend.version, '0.1.0-alpha.226');
    assert.equal(f.notices[0].notice.backend.sessions[0].name, 'Ended task');
    if (failure === 'sockets') {
      assert.equal(f.notices[0].notice.error, undefined); assert.equal(f.notices[0].notice.reconnectFailed, true);
    } else assert.match(f.notices[0].notice.error, /synthetic/);
    // Keep an old eligible projection: even an uncertain failure must not be retried.
    f.old.state.runtimeVersion = '0.1.0-alpha.226'; const before = f.events.filter(e => e.startsWith('continue:')).length;
    f.fail = null; await f.scope.autoBackendSwitchOnce();
    assert.equal(f.events.filter(e => e.startsWith('continue:')).length, before);
    f.answer = () => ({ response: 1 });
    assert.equal(await f.handlers.continueConnection(f.context, 'ended', { backendKey: 'old', nativeId: 'native-ended', version: f.old.state.runtimeVersion }), true);
    assert.equal(f.events.filter(e => e.startsWith('continue:')).length, before + 1);
  }
});
test('a manual dialog keeps its pre-confirmation baseline and cancellation has no maintenance effects', async () => {
  const f = fixture(); f.answer = () => ({ response: 0 });
  assert.equal(await f.handlers.continueConnection(f.context, 'ended'), false); assert.deepEqual(f.events, ['refresh', 'dialog']);
  const changed = fixture(); changed.answer = () => { changed.old.state.sessions[0].nativeId = 'new-native'; return { response: 1 }; };
  await assert.rejects(changed.handlers.continueConnection(changed.context, 'ended'), /核对期间/);
  assert.ok(!changed.events.some(e => e.startsWith('maintain:')));
});
test('one tick continues only one ready backend, and the existing nonempty-stop automatic move remains selectable', async () => {
  const f = fixture();
  const second = { ...f.old, key: 'second', client: {}, state: { ...f.old.state, sessions: [{ ...f.old.state.sessions[0], id: 'second-ended' }] } };
  f.client.entries.push(second); await f.scope.autoBackendSwitchOnce();
  assert.equal(f.events.filter(e => e.startsWith('continue:')).length, 1); assert.equal(second.state.runtimeVersion, '0.1.0-alpha.226');
  const move = fixture(); move.old.state.sessions[0].state = 'idle';
  const plan = { backendKey: 'old', switch: { auto: true, ready: true, stops: [{ id: 'ended' }] } };
  move.scope.queueRules.nextBackendMove = (options, settings, sessions, humanAt, now, failed) => { assert.equal(options[0].ready, false); assert.equal(failed, move.scope.autoSwitchFailed); return plan; };
  await move.scope.autoBackendSwitchOnce(); assert.ok(move.events.includes('switch:old')); assert.ok(!move.events.some(e => e.startsWith('continue:')));
});
test('the automatic wrapper prevents overlapping ticks while a ready refresh is in flight', async () => {
  const f = fixture(); let release;
  f.onRefresh = n => n === 1 ? new Promise(resolve => { release = resolve; }) : undefined;
  const first = f.scope.autoBackendSwitch(); await f.scope.autoBackendSwitch(); assert.deepEqual(f.events, ['refresh']);
  release(); await first; assert.equal(f.events.filter(e => e.startsWith('continue:')).length, 1); assert.equal(f.scope.autoSwitchRunning, false);
});
test('automatic continuation runs the actual socket replacement in every window before releasing maintenance', async () => {
  const f = fixture(), replaced = [], connected = [];
  f.context.client.replaceService = (key, connection) => { assert.equal(f.control.maintenance.has(key), true); replaced.push([f.context.view.owner, key, connection]); };
  const other = { view: { owner: 'other-window' }, win: { isDestroyed: () => false, webContents: { send() {} } },
    client: { socket: { destroyed: false }, replaceService(key, connection) { assert.equal(f.control.maintenance.has(key), true); replaced.push(['other-window', key, connection]); }, async refresh() { return {}; } } };
  f.scope.windows.set(2, other);
  f.scope.path = require('node:path'); f.scope.displayState = state => state; f.scope.omitHidden = require('../shown-sessions.cjs').omitHidden;
  f.scope.connectService = async (directory, owner) => {
    assert.equal(directory, require('node:path').join('synthetic-profile', 'old'));
    const connection = { async call(method) { assert.equal(method, 'initial'); return { sessions: [] }; }, close() { throw Error('successful replacement must keep the new connection'); } };
    connected.push([owner, connection]); return connection;
  };
  vm.runInContext(source('replaceBackendSockets'), f.scope);
  await f.scope.autoBackendSwitchOnce();
  assert.equal(replaced.length, 2); assert.deepEqual(replaced.map(row => row.slice(0, 2)), [['synthetic-owner', 'old'], ['other-window', 'old']]);
  assert.equal(replaced[0][2], connected[0][1]); assert.equal(replaced[1][2], connected[1][1]);
  assert.equal(f.control.maintenance.size, 0); assert.equal(f.notices.at(-1).event, 'workspace:backend-switched');
  assert.equal(f.notices.at(-1).notice.error, undefined);
});

test('the existing maintenance pass reaches idle-session retirement only after refreshing and with maintenance enabled', async () => {
  const enabled = fixture();
  enabled.old.state.sessions = [];
  enabled.onRetireIdleSession = context => { assert.equal(context, enabled.context); enabled.events.push('retire-idle'); };
  await enabled.scope.autoBackendSwitchOnce();
  assert.deepEqual(enabled.events, ['refresh', 'nextMove', 'retire-idle']);

  const disabled = fixture({ auto: false, migrate: false });
  disabled.onRetireIdleSession = () => assert.fail('maintenance is off');
  await disabled.scope.autoBackendSwitchOnce();
  assert.deepEqual(disabled.events, []);
});
