// R255.1: an old backend that holds records but nothing running retires; its records stay in its store.
// Synthetic records only. These tests start their own daemons and never inherit the developer's backend.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test');
const vm = require('node:vm');
const { createInspector } = require('../../scripts/install-runtime.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const { OperatorControl } = require('../operator-control.cjs');
const { createReconnector } = require('../service-reconnect.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { connect, ensureService, ensureServiceAt, connectService, connectProfileBackend, retireHistoryService } = require('../service-client.cjs');
const { maintenanceProof, writeSettings } = require('../backend-switch.cjs');
const { readLayout, writeLayout } = require('../service-layout.cjs');
const { readLock, ownerMayBeAlive } = require('../service-lock.cjs');

const ACTIVE = `backends/${'b'.repeat(20)}`, VERSION = 'retire-v1';

// The current backend: a socket that answers like an empty service of this version.
async function currentService(directory, sessions = []) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-fixture-')), endpoint = path.join(transport, 's.sock'), sockets = new Set();
  const state = { runtimeVersion: VERSION, capabilities: ['agentWakeV1'], sessions, room: { messages: [], run: null } };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '', ready = false;
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!ready) { ready = true; socket.write(JSON.stringify({ ready: true }) + '\n'); continue; }
        socket.write(JSON.stringify({ id: request.id, ok: true, value: request.method === 'initial' ? state : true }) + '\n');
      }
    });
  });
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic-local-auth' }), { mode: 0o600 });
  await new Promise(resolve => server.listen(endpoint, resolve));
  return { close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(transport, { recursive: true, force: true }); } };
}
// Stops only the daemon this test started in its own directory.
async function stopOwnService(directory) {
  const file = path.join(directory, 'service.lock'), owner = readLock(file);
  if (owner?.pid && ownerMayBeAlive(owner, directory, 'service')) process.kill(owner.pid, 'SIGTERM');
  for (let n = 0; n < 60; n++) {
    if (!fs.existsSync(file) && !ownerMayBeAlive(owner, directory, 'service')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Test backend did not finish shutdown');
}
// The old backend is the root store with these records; the current one is a separate slot.
async function oldBackend(t, stored, realCurrent = false, currentSessions) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retire-')), oldVersion = process.env.NAW_APP_VERSION;
  let current;
  t.after(async () => {
    await stopOwnService(directory); await current?.close();
    if (realCurrent) await stopOwnService(path.join(directory, ACTIVE));
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (typeof stored === 'string') fs.writeFileSync(path.join(directory, 'workspace.json'), stored, { mode: 0o600 });
  else fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(stored), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'runtime-locations.json'), JSON.stringify({ claude: '/usr/bin/false', codex: '/usr/bin/false' }), { mode: 0o600 });
  process.env.NAW_APP_VERSION = VERSION; await ensureService(directory, process.execPath);
  if (realCurrent) {
    const active = path.join(directory, ACTIVE);
    fs.mkdirSync(active, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(directory, 'runtime-locations.json'), path.join(active, 'runtime-locations.json'));
    await ensureService(active, process.execPath);
  } else current = await currentService(path.join(directory, ACTIVE), currentSessions);
  writeLayout(directory, { format: 1, active: ACTIVE, entries: ['.', ACTIVE] });
  return directory;
}
async function snapshot(directory) {
  const client = await connectService(directory, 'test');
  try { return await client.call('initial'); } finally { client.close(); }
}
async function retire(directory) {
  const { pid, started } = readLock(path.join(directory, 'service.lock'));
  const state = await snapshot(directory);
  return retireHistoryService(directory, '.', { pid, started, sessions: state.sessions.map(maintenanceProof) });
}

const records = (state = 'ended', extra = {}) => ({
  sessions: [{ id: 'old-session', nativeId: 'old-native', provider: 'claude', state, name: 'Synthetic old task', cwd: os.tmpdir(), messages: [{ role: 'user', text: 'synthetic history' }], ...extra }],
  room: { messages: [{ id: 'old-reply', text: 'synthetic shared reply' }] },
  drafts: { 'old-session': 'synthetic retained draft' },
});

test('an old backend with only ended sessions, replies and drafts retires, and its store keeps them', async t => {
  const directory = await oldBackend(t, records());
  const before = await snapshot(directory);
  assert.equal(before.sessions[0].state, 'ended');
  await retire(directory);
  assert.deepEqual(readLayout(directory), { format: 1, active: ACTIVE, entries: ['.', ACTIVE], retired: ['.'] });
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'));
  assert.deepEqual(stored.sessions.map(s => [s.id, s.nativeId, s.state, s.messages]), [['old-session', 'old-native', 'ended', [{ role: 'user', text: 'synthetic history' }]]]);
  assert.deepEqual(stored.room.messages.map(m => [m.id, m.text]), [['old-reply', 'synthetic shared reply']]);
  assert.deepEqual(stored.drafts, { 'old-session': 'synthetic retained draft' });
});

test('normal desktop reconnect reads retired history without booting its daemon', async t => {
  const directory = await oldBackend(t, records());
  assert.equal(await retire(directory), true);
  await ensureService(directory, process.execPath);
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  const client = await connect(directory, 'desktop-reconnect');
  try {
    const state = await client.call('initial');
    assert.equal(state.sessions.find(s => s.id === 'old-session')?.messages[0]?.text, 'synthetic history');
    assert.equal(state.sessions.find(s => s.id === 'old-session')?.liveDraft, 'synthetic retained draft');
    assert.equal(state.room.messages.find(m => m.id === 'old-reply')?.text, 'synthetic shared reply');
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  } finally {
    client.close();
  }
});

test('the install inspector keeps retired records and still refuses a missing live backend', async t => {
  const directory = await oldBackend(t, records(), true);
  fs.writeFileSync(path.join(directory, 'views.json'), '[]', { mode: 0o600 });
  writeSettings(directory, false, false);
  const inspector = createInspector({ data: directory, release: path.resolve(__dirname, '../..'),
    resultDir: directory, newVersion: VERSION }, { run: () => '' });
  const live = await inspector.capture();
  assert.equal(await retire(directory), true);
  const before = await inspector.capture();
  const historical = before.state.services.find(service => service.key === '.');
  assert.deepEqual([historical.retired, historical.pid, historical.identity, historical.sessions, historical.messages], [true, null, null, 1, live.state.services.find(service => service.key === '.').messages]);
  assert.ok(!before.restarting.includes('.'));
  assert.equal(before.expectedActive, ACTIVE);
  assert.equal(before.state.sessions.find(s => s.id === 'old-session').nativeId, 'old-native');
  assert.equal(fs.existsSync(path.join(directory, 'connection.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);

  await inspector.verifyUpgrade(before);
  const file = path.join(directory, 'workspace.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, room: { messages: [] } }));
  const after = await inspector.capture();
  assert.throws(() => inspector.retained(before, after), /Room records kept/);
  await assert.rejects(inspector.verifyUpgrade(before), /Room records kept/);
  fs.writeFileSync(file, JSON.stringify(saved));
  const layout = readLayout(directory);
  writeLayout(directory, { ...layout, retired: [] });
  await assert.rejects(inspector.capture(), { code: 'ENOENT', path: path.join(directory, 'connection.json') });
});

test('wake lookup reaches a live recipient with retired entries and refuses an ambiguous or dormant target', async t => {
  const target = { id: 'live-session', nativeId: 'live-native', state: 'idle' };
  const directory = await oldBackend(t, records(), false, [target]);
  const site = path.join(directory, ACTIVE), runner = new PeerRunner({ room: {}, on() {} }, site);
  assert.equal(await retire(directory), true);
  assert.deepEqual((await runner.lookupWake(target.id)).session, target);
  const metadata = await OperatorControl.prototype.visibleSessions.call({ w: { peerRunner: runner, dataDir: site } }, []);
  assert.equal(metadata.metadataIncomplete, false);
  const historical = metadata.sessions.find(s => s.id === 'old-session');
  assert.deepEqual([historical?.state, historical?.canReport], ['unknown', false]);
  await assert.rejects(runner.lookupWake('old-session'), error => error.uiMessage?.key === 'error.peer.recipientBackendUnavailable');
  const file = path.join(directory, 'workspace.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, sessions: [{ ...saved.sessions[0], id: target.id }] }));
  await assert.rejects(runner.lookupWake(target.id), error => error.uiMessage?.key === 'error.peer.recipientBackendUnavailable');
  fs.writeFileSync(file, '{}');
  await assert.rejects(runner.lookupWake(target.id), error => error.uiMessage?.key === 'error.service.invalidLayout');
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
});

test('Main hands off a retired backend to all surviving GUI connections even if a window closes during replacement', async t => {
  const directory = await oldBackend(t, records());
  const views = await Promise.all(['closed-view', 'retained-view', 'retained-background'].map(async (owner, i) => {
    const client = await connect(directory, owner, { page: i !== 2 });
    t.after(() => client.close());
    let closed = false;
    return { client, view: { owner }, background: i === 2, win: { isDestroyed: () => closed }, close() { closed = true; client.close(); } };
  }));
  const [, retained] = views, previous = retained.client.active.client;
  const raw = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const box = { exports: {} };
  vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
  const functions = box.exports.parse(raw, { ecmaVersion: 'latest' }).body.filter(node =>
    ['historyRetirementCandidates', 'runHistoryRetirements', 'replaceBackendSockets', 'reconnectClosed'].includes(node.id?.name));
  const connectionEvents = [], notices = [];
  const scope = vm.createContext({ require: require('node:module').createRequire(require.resolve('../main.cjs')), path, dataDir: directory, windows: new Map(views.map(v => [v.view.owner, v])),
    connectionEvents: { add: e => connectionEvents.push(e) }, reconnector: null, backendSwitching: null,
    backendSwitch: { maintenanceProof }, canRetire: require('../service-client.cjs').canRetire, retireHistoryService,
    connectProfileBackend: async (root, key, owner, options) => {
      if (owner === retained.view.owner && key === '.') views[0].close();
      return connectProfileBackend(root, key, owner, options);
    },
    createReconnector: args => createReconnector({ ...args, delays: [0] }),
    displayState: value => value, omitHidden: value => value, broadcastRoom: async () => {},
    sendToPage: (view, name) => notices.push([view.view.owner, name]), noticeDisconnected: () => assert.fail('GUI became disconnected'),
  });
  vm.runInContext(functions.map(node => raw.slice(node.start, node.end)).join('\n'), scope);
  const { candidates } = scope.historyRetirementCandidates(retained.client, true);
  assert.equal(candidates.length, 1);
  assert.equal((await scope.runHistoryRetirements(retained.client, candidates)).retired, 1);
  for (const { client } of views.slice(1)) {
    assert.equal(client.entries.find(e => e.key === '.').closed, false);
    assert.equal(client.snapshot().sessions.find(s => s.id === 'old-session').nativeId, 'old-native');
  }
  assert.equal(retained.client.active.client, previous);
  assert.ok(notices.some(([, name]) => name === 'workspace:reconnected'));

  const closed = new Promise(resolve => retained.client.once('closed', resolve));
  previous.socket.destroy();
  await closed;
  assert.equal(await scope.reconnectClosed(retained, retained.client), 'restored');
  assert.deepEqual(connectionEvents.map(e => [e.event, [...e.backends]]), [['closed', [ACTIVE]], ['restored', [ACTIVE]]]);
  assert.equal(retained.client.socket.destroyed, false);
  assert.equal(fs.existsSync(path.join(directory, 'connection.json')), false);
});

test('an explicit desktop action wakes one retired store and preserves the original record', async t => {
  const directory = await oldBackend(t, records());
  await retire(directory);
  const first = await connect(directory, 'first-view');
  const second = await connect(directory, 'second-view');
  try {
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
    await first.call('claim', 'old-session', 'chat');
    assert.ok(readLock(path.join(directory, 'service.lock')));
    await first.call('draft', 'old-session', 'synthetic changed draft');
    const state = await second.call('initial');
    assert.equal(state.sessions.find(s => s.id === 'old-session')?.nativeId, 'old-native');
    assert.equal(state.sessions.find(s => s.id === 'old-session')?.liveDraft, 'synthetic changed draft');
    assert.equal(state.room.messages.find(m => m.id === 'old-reply')?.text, 'synthetic shared reply');
    assert.equal(readLayout(directory).retired.length, 0);
    assert.deepEqual(readLayout(directory).entries, ['.', ACTIVE]);
  } finally {
    first.close();
    second.close();
  }
});

test('a stale native identity cannot retire the old service', async t => {
  const directory = await oldBackend(t, records());
  const { pid, started } = readLock(path.join(directory, 'service.lock'));
  const state = await snapshot(directory);
  const [old] = state.sessions.map(maintenanceProof);
  assert.equal(await retireHistoryService(directory, '.', { pid, started, sessions: [{ ...old, nativeId: 'earlier-context' }] }), false);
  assert.equal(readLock(path.join(directory, 'service.lock')).pid, pid);
  assert.equal(readLayout(directory).retired, undefined);
});

test('a window-side bootstrap cannot retire a backend with records', async t => {
  const directory = await oldBackend(t, records());
  await ensureService(directory, process.execPath);
  assert.ok(readLock(path.join(directory, 'service.lock')));
  assert.deepEqual(readLayout(directory).entries, ['.', ACTIVE]);
  assert.equal(readLayout(directory).retired, undefined);
});

test('after it retires, the existing service start on its store reads the replies and drafts again', async t => {
  const directory = await oldBackend(t, records());
  await retire(directory);
  assert.deepEqual(readLayout(directory).retired, ['.']);
  await ensureServiceAt(directory, process.execPath, path.join(directory, 'workspace'));
  const again = await snapshot(directory);
  assert.equal(again.sessions.length, 1);
  assert.equal(again.sessions[0].nativeId, 'old-native'); assert.equal(again.sessions[0].state, 'ended');
  assert.equal(again.sessions[0].messages[0].text, 'synthetic history');
  assert.equal(again.sessions[0].liveDraft, 'synthetic retained draft');
  assert.deepEqual(again.room.messages.map(m => [m.id, m.text]), [['old-reply', 'synthetic shared reply']]);
  assert.equal(again.diagnostics.dispatches, 0);
});

test('suspending a stopped store preserves the recoverable session and its draft', async t => {
  const directory = await oldBackend(t, records('idle'));
  assert.equal((await snapshot(directory)).sessions[0].state, 'recoverable');
  assert.equal(await retire(directory), true);
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  const client = await connect(directory, 'reopen-recoverable');
  try {
    const state = await client.call('initial');
    const row = state.sessions.find(s => s.id === 'old-session');
    assert.deepEqual([row.state, row.nativeId, row.liveDraft], ['recoverable', 'old-native', 'synthetic retained draft']);
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  } finally { client.close(); }
});

test('global automatic-message and operator settings survive a cold store reopening', async t => {
  const directory = await oldBackend(t, records(), true);
  assert.equal(await retire(directory), true);
  const stored = fs.readFileSync(path.join(directory, 'workspace.json'));
  const client = await connect(directory, 'settings-while-cold');
  try {
    const before = await client.call('initial');
    assert.equal(before.wakePolicy.enabled, true);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'workspace.json')), stored);
    assert.equal(await client.call('wakePolicy', null, false), true);
    assert.equal(await client.call('operatorAction', null, 'enabled', true), true);
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
    assert.deepEqual((await client.call('initial')).operatorPolicy.backends.map(row => row.enabled), [true, true]);
    assert.equal(await client.call('operatorAction', null, 'enabled', false), true);
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
    await client.call('claim', 'old-session', 'chat');
    const after = await client.call('initial');
    assert.equal(after.wakePolicy.enabled, false);
    assert.deepEqual(after.operatorPolicy.backends.map(row => row.enabled), [false, false]);
  } finally { client.close(); }
});

test('an unapproved background invocation cannot wake a dormant backend', async t => {
  const directory = await oldBackend(t, records());
  assert.equal(await retire(directory), true);
  const client = await connect(directory, 'synthetic-background', { page: false });
  try {
    const cold = client.entries.find(entry => entry.key === '.').client;
    const background = require('../background-operation.cjs');
    const actor = { id: 'caller', name: 'Synthetic agent', nativeId: 'original', provider: 'codex', turnId: 'turn', callId: 'call', operationId: 'operation' };
    await assert.rejects(background.run(actor, () => cold.call('claim', 'old-session', 'chat')), {
      uiMessage: { version: 1, key: 'error.client.connectionUpdatingNoInput', params: {} },
    });
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  } finally { client.close(); }
});

test('a native process that may still run, a different operator setting or an unreadable store keeps the old backend', async t => {
  await t.test('process may run', async t => {
    const directory = await oldBackend(t, records('ended', { processIdentity: { pid: process.pid } }));
    await retire(directory);
    assert.deepEqual(readLayout(directory), { format: 1, active: ACTIVE, entries: ['.', ACTIVE] });
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), true);
  });
  await t.test('operator setting differs from the active backend', async t => {
    const directory = await oldBackend(t, records());
    const client = await connectService(directory, 'test');
    try { assert.equal(await client.call('operatorAction', null, 'enabled', true), true); } finally { client.close(); }
    await retire(directory);
    assert.deepEqual(readLayout(directory), { format: 1, active: ACTIVE, entries: ['.', ACTIVE] });
  });
  await t.test('unreadable store', async t => {
    const directory = await oldBackend(t, '{ not json');
    assert.ok((await snapshot(directory)).storageWarning);
    await retire(directory);
    assert.deepEqual(readLayout(directory), { format: 1, active: ACTIVE, entries: ['.', ACTIVE] });
  });
});
