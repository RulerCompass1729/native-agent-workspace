// A developer may run this suite from inside NAW. These tests provide their
// own versions and directories; never inherit the live developer backend.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { ensureService, connect, connectService, continuationStatus, continueService } = require('../service-client.cjs');
const { readLayout, writeLayout } = require('../service-layout.cjs');

test('cold bootstrap stages the disabled local prepared-command service without provider inference', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-prepared-bootstrap-'));
  let client;
  try {
    await ensureService(directory, process.execPath);
    client = await connect(directory, 'bootstrap-check');
    const state = await client.call('initial');
    assert.ok(state.capabilities.includes('humanMobileV1'));
    assert.ok(state.capabilities.includes('humanMobilePreparedV1'));
    assert.deepEqual(state.sessions, []);
    assert.equal(state.diagnostics.dispatches, 0);
    assert.equal(fs.existsSync(path.join(directory, 'mobile-authority.json')), false);
    const runtimes = fs.readdirSync(path.join(directory, 'runtimes'));
    assert.equal(runtimes.length, 1);
    for (const name of ['mobile-access.cjs', 'mobile-session.cjs']) {
      assert.deepEqual(fs.readFileSync(path.join(directory, 'runtimes', runtimes[0], name)), fs.readFileSync(path.join(__dirname, '..', name)));
    }
  } finally {
    client?.close(); await stopOwnEmptyService(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation requires every session to end and rejects missing history or failed persistence', () => {
  const record = { id: 'old', nativeId: 'native', name: 'Old task', state: 'ended' };
  for (const state of ['idle', 'working', 'disconnected', 'recoverable', 'error', 'stopping']) {
    const status = continuationStatus({ sessions: [record, { id: 'sibling', state, name: 'Another task' }] }, 'old');
    assert.equal(status.ready, false); assert.match(status.reason, /Another task/);
  }
  assert.equal(continuationStatus({ sessions: [{ ...record, nativeId: null }] }, 'old').ready, false);
  assert.equal(continuationStatus({ sessions: [record], storageWarning: 'write failed' }, 'old').ready, false);
  const early = continuationStatus({ sessions: [record], capabilities: ['resume'] }, 'old');
  assert.equal(early.ready, false); assert.match(early.reason, /主动关闭运行服务/);
  assert.equal(continuationStatus({ sessions: [record], capabilities: ['atomicShutdown'] }, 'old').ready, true);
});
test('explicit ended-service continuation retains same store, native identity, membership, history and drafts without replay', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-continuation-')), oldVersion = process.env.NAW_APP_VERSION;
  const stored = { sessions: [{ id: 'retained', nativeId: 'retained-native', provider: 'claude', state: 'ended', name: 'Original', roomId: 'shared', messages: [{ role: 'user', text: 'Original private history' }] }], room: { messages: [{ id: 'shared', text: 'Explicit shared result' }] }, drafts: { retained: 'Unsent draft' } };
  let client;
  try {
    fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(stored), { mode: 0o600 });
    process.env.NAW_APP_VERSION = 'continuation-old'; await ensureService(directory, process.execPath);
    process.env.NAW_APP_VERSION = 'continuation-new'; await continueService(directory, process.execPath, 'retained');
    client = await connect(directory, 'test'); const state = await client.call('initial');
    assert.equal(state.runtimeVersion, 'continuation-new'); assert.deepEqual(readLayout(directory).entries, ['.']);
    const record = state.sessions[0];
    for (const key of ['id', 'nativeId', 'roomId', 'messages', 'name']) assert.deepEqual(record[key], stored.sessions[0][key]);
    assert.equal(record.liveDraft, 'Unsent draft'); assert.equal(record.state, 'ended'); assert.equal(record.terminalAvailable, false);
    assert.deepEqual(state.room.messages, stored.room.messages); assert.equal(state.diagnostics.dispatches, 0);
  } finally {
    client?.close(); await stopOwnEmptyService(directory);
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('continuation replaces only its target while an ended peer and live peer keep their sockets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-isolated-continuation-')), oldVersion = process.env.NAW_APP_VERSION;
  const peerDir = path.join(directory, 'backends/aaaaaaaaaaaaaaaaaaaa'), liveDir = path.join(directory, 'backends/bbbbbbbbbbbbbbbbbbbb');
  let peer, live;
  try {
    for (const [dir, id] of [[directory, 'target'], [peerDir, 'peer']]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ sessions: [{ id, nativeId: id + '-native', provider: 'claude', state: 'ended', messages: [] }], room: { messages: [] }, drafts: {} }), { mode: 0o600 });
      process.env.NAW_APP_VERSION = 'retained-old'; await ensureService(dir, process.execPath);
    }
    fs.mkdirSync(liveDir, { recursive: true, mode: 0o700 });
    live = await syntheticService(liveDir, { runtimeVersion: 'retained-old', capabilities: ['atomicShutdown'], sessions: [{ id: 'working', provider: 'claude', state: 'working' }], room: { messages: [], run: null } });
    writeLayout(directory, { format: 1, entries: ['.', 'backends/aaaaaaaaaaaaaaaaaaaa', 'backends/bbbbbbbbbbbbbbbbbbbb'], active: 'backends/bbbbbbbbbbbbbbbbbbbb' });
    peer = await connectService(peerDir, 'existing-peer-window'); const before = await peer.call('initial');
    let closed = false; peer.on('closed', () => { closed = true; });
    process.env.NAW_APP_VERSION = 'current-isolated'; await continueService(directory, process.execPath, 'target');
    const after = await peer.call('initial');
    assert.equal(closed, false); assert.equal(after.servicePid, before.servicePid); assert.equal(after.runtimeVersion, 'retained-old');
    assert.ok(live.calls.every(method => method === 'initial'), 'No pause, shutdown or action on the working peer');
    assert.deepEqual(readLayout(directory), { format: 1, entries: ['.', 'backends/aaaaaaaaaaaaaaaaaaaa', 'backends/bbbbbbbbbbbbbbbbbbbb'], active: 'backends/bbbbbbbbbbbbbbbbbbbb' });
  } finally {
    peer?.close(); await live?.close();
    await stopOwnEmptyService(peerDir); await stopOwnEmptyService(directory);
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reusing an older live service pauses unsafe routing without replacing its native sessions', async t => {
  for (const level of [0, 1, 2, 3]) await t.test(['legacy service', 'previous handoff checks', 'current Codex service', 'old Claude identity checks'][level], async () => {
    const verified = level === 2;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-test-'));
    const endpoint = path.join(directory, 's.sock'), calls = [], clients = new Set();
    const state = { capabilities: ['structuredClaudeSubmit', ...(level >= 1 ? ['verifiedHandoffs'] : []), ...(level >= 2 ? ['nativeInputIsolation'] : [])], sessions: [{ id: 'synthetic-native-session', state: 'idle', provider: level === 3 ? 'claude' : 'codex' }], room: { run: { status: 'running', ids: ['synthetic-native-session'] } } };
    const server = net.createServer(socket => {
      clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
      let buffer = '', authorized = false;
      socket.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!authorized) { authorized = true; socket.write(JSON.stringify({ ready: true }) + '\n'); continue; }
          calls.push(request.method);
          if (request.method === 'pause') state.room.run.status = 'paused';
          socket.write(JSON.stringify({ id: request.id, ok: true, value: request.method === 'initial' ? state : null }) + '\n');
        }
      });
    });
    try {
      fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic-local-auth' }), { mode: 0o600 });
      await new Promise(resolve => server.listen(endpoint, resolve));
      await ensureService(directory, '/nonexistent-test-executable');
      assert.deepEqual(calls, verified ? ['initial'] : ['initial', 'pause']);
      assert.equal(state.room.run.status, verified ? 'running' : 'paused');
      assert.equal(state.sessions[0].id, 'synthetic-native-session');
    } finally {
      for (const socket of clients) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('a live legacy socket survives an update, current service boot and repeated reconnect without replay', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-test-'));
  const endpoint = path.join(directory, 's.sock'), calls = [], clients = new Set();
  const oldVersion = process.env.NAW_APP_VERSION;
  const state = { runtimeVersion: 'previous-fixture', capabilities: ['resume', 'forget', 'clearSharedHistory'], owner: 'test', sessions: [{ id: 'retained', provider: 'claude', state: 'idle', nativeId: 'unchanged', pid: 321, messages: [], roomId: null }], room: { messages: [], run: null }, diagnostics: { dispatches: 0, shellModelCalls: 0 } };
  const server = net.createServer(socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
    let buffer = '', ready = false;
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const r = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!ready) { ready = true; socket.write(JSON.stringify({ ready: true }) + '\n'); continue; }
        calls.push(r.method); socket.write(JSON.stringify({ id: r.id, ok: true, value: r.method === 'initial' ? state : null }) + '\n');
      }
    });
  });
  let c;
  try {
    fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic-local-auth' }), { mode: 0o600 });
    await new Promise(resolve => server.listen(endpoint, resolve));
    process.env.NAW_APP_VERSION = 'current-fixture';
    await ensureService(directory, process.execPath);
    const layout = readLayout(directory); assert.equal(layout.entries.length, 2); assert.notEqual(layout.active, '.');
    assert.equal(fs.statSync(path.join(directory, 'services.json')).mode & 0o777, 0o600);
    c = await connect(directory, 'test'); let snapshot = await c.call('initial');
    const pid = snapshot.servicePid;
    assert.equal(snapshot.runtimeVersion, 'current-fixture');
    assert.equal(snapshot.defaultWorkspace, path.join(directory, 'workspace'));
    assert.equal(snapshot.sessions[0].nativeId, 'unchanged'); assert.equal(snapshot.sessions[0].pid, 321);
    assert.ok(snapshot.capabilities.includes('nativePermissionDefaults')); assert.equal(snapshot.sessions[0].chatAvailable, false);
    c.close(); c = null;
    await ensureService(directory, process.execPath);
    assert.deepEqual(readLayout(directory), layout);
    c = await connect(directory, 'test'); snapshot = await c.call('initial');
    assert.equal(snapshot.servicePid, pid); assert.equal(snapshot.diagnostics.dispatches, 0);
    assert.ok(calls.every(method => ['initial', 'pause'].includes(method)));
    assert.equal(calls.filter(method => method === 'pause').length, 1);
    await assert.rejects(c.call('shutdown'), /先结束/);
  } finally {
    c?.close();
    const layout = readLayout(directory);
    for (const key of layout.entries.filter(key => key !== '.')) {
      const own = await connectService(path.join(directory, key), 'test-cleanup');
      try { await own.call('shutdown'); await new Promise(resolve => own.socket.once('close', resolve)); } finally { own.close(); }
    }
    for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve));
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('routing manifests reject unsafe paths, symlinks and public permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-test-')), file = path.join(dir, 'services.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ format: 1, active: '../outside', entries: ['../outside'] }), { mode: 0o600 });
    assert.throws(() => readLayout(dir), /无效/);
    fs.writeFileSync(file, JSON.stringify({ format: 1, active: '.', entries: ['.'] })); fs.chmodSync(file, 0o644);
    assert.throws(() => readLayout(dir), /权限/);
    fs.rmSync(file); const target = path.join(dir, 'test-manifest'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, file);
    assert.throws(() => readLayout(dir), /权限/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function syntheticService(directory, state) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep the Unix socket short even when a backend directory is nested.
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-fixture-'));
  const endpoint = path.join(transport, 's.sock'), sockets = new Set(), calls = [];
  const service = { state, calls, pauseError: null };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '', ready = false;
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!ready) { ready = true; socket.write(JSON.stringify({ ready: true }) + '\n'); continue; }
        calls.push(request.method);
        const error = request.method === 'pause' ? service.pauseError : null;
        if (!error && request.method === 'pause' && state.room.run) state.room.run.status = 'paused';
        socket.write(JSON.stringify({ id: request.id, ok: !error, error, value: request.method === 'initial' ? state : true }) + '\n');
        if (request.method === 'shutdown' && service.onShutdown) setTimeout(service.onShutdown, 10);
      }
    });
  });
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic-local-auth' }), { mode: 0o600 });
  await new Promise(resolve => server.listen(endpoint, resolve));
  service.close = async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(transport, { recursive: true, force: true }); };
  return service;
}
async function stopOwnEmptyService(directory) {
  let client;
  try { client = await connectService(directory, 'test-cleanup'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try { await client.call('shutdown'); if (!client.socket.destroyed) await new Promise(resolve => client.socket.once('close', resolve)); }
  finally { client.close(); }
}
test('normal service bootstrap retains backend runtime paths across restarts without changing another profile', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-runtime-bootstrap-'));
  const key = 'backends/' + 'a'.repeat(20), retained = path.join(directory, key), ordinary = path.join(directory, 'ordinary');
  const old = { version: process.env.NAW_APP_VERSION, config: process.env.NAW_RUNTIME_CONFIG };
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.mkdirSync(retained, { recursive: true, mode: 0o700 }); fs.mkdirSync(ordinary, { mode: 0o700 });
  writeLayout(directory, { format: 1, entries: ['.', key], active: '.' });
  const globalFile = path.join(directory, 'runtime-locations.json'), localFile = path.join(retained, 'runtime-locations.json');
  fs.writeFileSync(globalFile, JSON.stringify({ codex: '/usr/bin/true' }), { mode: 0o600 });
  fs.writeFileSync(localFile, JSON.stringify({ codex: '/usr/bin/false' }), { mode: 0o600 });
  const launcher = path.join(directory, 'owned-node-launcher'), receipt = path.join(directory, 'launch-receipt');
  // Record only this one configuration key, then boot the real daemon. No
  // provider program, environment dump, model or person's profile is used.
  fs.writeFileSync(launcher, '#!/bin/sh\nprintf "%s" "$NAW_RUNTIME_CONFIG" > ' + quote(receipt) + '\nexec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o700 });
  process.env.NAW_RUNTIME_CONFIG = globalFile; process.env.NAW_APP_VERSION = 'runtime-path-fixture';
  try {
    for (let i = 0; i < 2; i++) {
      await ensureService(directory, launcher, key);
      assert.equal(fs.readFileSync(receipt, 'utf8'), localFile);
      const client = await connect(retained, 'runtime-path-test');
      try { const state = await client.call('initial'); assert.equal(state.sessions.length, 0); assert.equal(state.diagnostics.dispatches, 0); }
      finally { client.close(); }
      await stopOwnEmptyService(retained);
    }
    await ensureService(ordinary, launcher);
    assert.equal(fs.readFileSync(receipt, 'utf8'), globalFile);
    assert.equal(process.env.NAW_RUNTIME_CONFIG, globalFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile)), { codex: '/usr/bin/true' });
  } finally {
    await stopOwnEmptyService(retained); await stopOwnEmptyService(ordinary);
    if (old.version === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = old.version;
    if (old.config === undefined) delete process.env.NAW_RUNTIME_CONFIG; else process.env.NAW_RUNTIME_CONFIG = old.config;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('an invalid backend runtime override stops before launching a replacement daemon', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-runtime-invalid-'));
  const local = path.join(directory, 'runtime-locations.json'), marker = path.join(directory, 'unexpected-launch');
  const launcher = path.join(directory, 'must-not-run');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(launcher, '#!/bin/sh\ntouch ' + quote(marker) + '\nexit 99\n', { mode: 0o700 });
  try {
    for (const kind of ['unsafe-mode', 'invalid-json', 'dangling-link', 'directory']) {
      fs.rmSync(local, { recursive: true, force: true });
      if (kind === 'dangling-link') fs.symlinkSync(path.join(directory, 'missing'), local);
      else if (kind === 'directory') fs.mkdirSync(local);
      else fs.writeFileSync(local, kind === 'invalid-json' ? '{invalid' : '{}', { mode: kind === 'unsafe-mode' ? 0o644 : 0o600 });
      await assert.rejects(ensureService(directory, launcher), /后台程序位置配置无法读取/);
      assert.equal(fs.existsSync(marker), false, kind + ' must never launch a replacement');
      assert.equal(fs.existsSync(path.join(directory, 'services.lock')), false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('a damaged global Settings file still allows the root backend to open for repair', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-global-runtime-repair-'));
  const config = path.join(directory, 'runtime-locations.json'), oldConfig = process.env.NAW_RUNTIME_CONFIG;
  fs.writeFileSync(config, '{}', { mode: 0o644 }); process.env.NAW_RUNTIME_CONFIG = config;
  let client;
  try {
    await ensureService(directory, process.execPath);
    client = await connect(directory, 'repair-settings');
    assert.equal((await client.call('initial')).sessions.length, 0);
    assert.equal(fs.statSync(config).mode & 0o777, 0o644, 'Opening the app does not silently rewrite Settings');
  } finally {
    client?.close(); await stopOwnEmptyService(directory);
    if (oldConfig === undefined) delete process.env.NAW_RUNTIME_CONFIG; else process.env.NAW_RUNTIME_CONFIG = oldConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('updates reuse an ended slot, keep its records, and retire it only after explicit record removal', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-slot-'));
  const key = `backends/${'a'.repeat(20)}`, oldVersion = process.env.NAW_APP_VERSION;
  let legacy, client;
  const records = { sessions: [{ id: 'ended-record', nativeId: 'same-native-record', provider: 'claude', state: 'ended', messages: [{ role: 'user', text: 'synthetic private history' }] }], room: { messages: [{ id: 'shared-record', text: 'synthetic shared history' }] }, drafts: { 'ended-record': 'synthetic retained draft' } };
  try {
    fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(records), { mode: 0o600 });
    process.env.NAW_APP_VERSION = 'slot-v1'; await ensureService(directory, process.execPath);
    legacy = await syntheticService(path.join(directory, key), { runtimeVersion: 'slot-v1', capabilities: ['verifiedHandoffs'], sessions: [{ id: 'live-native-fixture', state: 'idle' }], room: { messages: [], run: null } });
    writeLayout(directory, { format: 1, active: key, entries: ['.', key] });
    for (const version of ['slot-v2', 'slot-v3']) {
      process.env.NAW_APP_VERSION = version; await ensureService(directory, process.execPath);
      assert.deepEqual(readLayout(directory), { format: 1, active: '.', entries: ['.', key] });
      client = await connectService(directory, 'test');
      const snapshot = await client.call('initial');
      assert.equal(snapshot.runtimeVersion, version); assert.equal(snapshot.sessions[0].nativeId, 'same-native-record');
      assert.equal(snapshot.sessions[0].state, 'ended'); assert.equal(snapshot.sessions[0].liveDraft, 'synthetic retained draft');
      assert.equal(snapshot.sessions[0].messages[0].text, 'synthetic private history');
      assert.equal(snapshot.room.messages[0].id, 'shared-record'); assert.equal(snapshot.diagnostics.dispatches, 0);
      client.close(); client = null;
    }
    // An ended history service is kept even when it is no longer the active slot.
    legacy.state.runtimeVersion = 'slot-v3';
    writeLayout(directory, { format: 1, active: key, entries: ['.', key] });
    await ensureService(directory, process.execPath); assert.equal(readLayout(directory).entries.length, 2);
    client = await connectService(directory, 'test');
    await client.call('forget', 'ended-record'); await client.call('clearSharedHistory'); client.close(); client = null;
    await ensureService(directory, process.execPath);
    assert.deepEqual(readLayout(directory), { format: 1, active: key, entries: [key] });
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
    assert.equal(fs.existsSync(path.join(directory, 'workspace.json')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8')), { sessions: [], room: { messages: [] }, drafts: {} });
    assert.ok(legacy.calls.every(method => ['initial', 'pause'].includes(method)));
  } finally {
    client?.close(); await stopOwnEmptyService(directory); await legacy?.close();
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('failed activation keeps its new service tracked and retries the same pending slot after another version', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-slot-')), oldVersion = process.env.NAW_APP_VERSION;
  let legacy;
  try {
    legacy = await syntheticService(directory, { runtimeVersion: 'previous-fixture', capabilities: ['verifiedHandoffs'], sessions: [{ id: 'retained', state: 'idle' }], room: { messages: [], run: null } });
    legacy.pauseError = 'synthetic pause acknowledgement failure';
    process.env.NAW_APP_VERSION = 'pending-v1';
    await assert.rejects(ensureService(directory, process.execPath), /acknowledgement failure/);
    const pending = readLayout(directory); assert.equal(pending.entries.length, 1); assert.equal(pending.active, '.'); assert.ok(pending.pending);
    const child = await connectService(path.join(directory, pending.pending), 'test');
    try { assert.equal((await child.call('initial')).sessions.length, 0); } finally { child.close(); }
    legacy.pauseError = null;
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === path.join(directory, 'services.json') && !JSON.parse(fs.readFileSync(source, 'utf8')).pending) throw new Error('synthetic activation write failure');
      return rename(source, destination);
    };
    try { await assert.rejects(ensureService(directory, process.execPath), /activation write failure/); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(readLayout(directory), pending);
    process.env.NAW_APP_VERSION = 'pending-v2'; await ensureService(directory, process.execPath);
    assert.deepEqual(readLayout(directory), { format: 1, active: pending.pending, entries: ['.', pending.pending] });
    assert.equal(fs.readdirSync(path.join(directory, 'backends')).length, 1);
  } finally {
    const layout = readLayout(directory);
    for (const key of new Set([...layout.entries, layout.pending].filter(key => key && key !== '.'))) await stopOwnEmptyService(path.join(directory, key));
    await legacy?.close();
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('returning to a retained live version reuses its existing slot even if activation is interrupted', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-slot-')), oldVersion = process.env.NAW_APP_VERSION;
  const key = `backends/${'b'.repeat(20)}`;
  let previous, active;
  try {
    const state = version => ({ runtimeVersion: version, capabilities: ['verifiedHandoffs'], sessions: [{ id: version, state: 'idle' }], room: { messages: [], run: null } });
    previous = await syntheticService(directory, state('rollback-v1')); active = await syntheticService(path.join(directory, key), state('rollback-v2'));
    const original = { format: 1, active: key, entries: ['.', key] }; writeLayout(directory, original);
    process.env.NAW_APP_VERSION = 'rollback-v1'; active.pauseError = 'synthetic activation interrupted';
    await assert.rejects(ensureService(directory, process.execPath), /activation interrupted/);
    assert.deepEqual(readLayout(directory), original);
    active.pauseError = null; await ensureService(directory, process.execPath);
    assert.deepEqual(readLayout(directory), { ...original, active: '.' });
    assert.equal(fs.readdirSync(path.join(directory, 'backends')).length, 1);
  } finally {
    await previous?.close(); await active?.close();
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('an acknowledged shutdown rejects new work during its delayed process-close window', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-gate-')), oldVersion = process.env.NAW_APP_VERSION;
  let client, pid, acknowledged = false;
  try {
    process.env.NAW_APP_VERSION = 'shutdown-fixture'; await ensureService(directory, process.execPath);
    client = await connectService(directory, 'test');
    pid = (await client.call('initial')).servicePid;
    const closing = client.call('shutdown');
    // An invalid provider would fail before any native launch even if the gate
    // regressed. The expected error must instead be the shutdown barrier.
    const rejected = assert.rejects(client.call('create', { provider: 'invalid-fixture', cwd: directory }), /后台正在关闭/);
    await closing; acknowledged = true; await rejected;
    if (!client.socket.destroyed) await new Promise(resolve => client.socket.once('close', resolve));
  } finally {
    client?.close();
    if (!acknowledged) await stopOwnEmptyService(directory);
    else {
      // Socket close can precede connection/lock deletion. Do not reconnect to
      // an already acknowledged shutdown just to clean up this fixture.
      let exited = false;
      for (let i = 0; i < 60; i++) {
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
        exited = !alive && !fs.existsSync(path.join(directory, 'connection.json')) && !fs.existsSync(path.join(directory, 'service.lock'));
        if (exited) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(exited, 'The owned shutdown fixture must release its process and files');
    }
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('one retained service uses the same guarded workspace client as multiple services', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'single-router-'));
  let service, client;
  try {
    service = await syntheticService(directory, { runtimeVersion: 'legacy-fixture', capabilities: [], sessions: [{ id: 'one', provider: 'claude', state: 'idle', roomId: 'shared' }, { id: 'two', provider: 'codex', state: 'idle', roomId: 'shared' }], room: { messages: [], run: null } });
    client = await connect(directory, 'view');
    assert.equal(client.constructor.name, 'WorkspaceClient');
    await assert.rejects(client.call('create', { provider: 'claude' }), /旧版会话/);
    await assert.rejects(client.call('send', 'one', 'must not be submitted'), /旧版会话/);
    await assert.rejects(client.call('run', ['one', 'two'], 'must not run', 3), /旧版后台/);
    await client.call('input', 'one', 'synthetic terminal key');
    assert.ok(service.calls.every(method => ['initial', 'input'].includes(method)));
  } finally { client?.close(); await service?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('an acknowledged ended-service shutdown waits for its lock after the socket has closed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-order-')), oldVersion = process.env.NAW_APP_VERSION;
  let service, closing, lockReleased = false, releaseTimer;
  try {
    service = await syntheticService(directory, { runtimeVersion: 'previous-fixture', capabilities: [], sessions: [], room: { messages: [], run: null } });
    fs.writeFileSync(path.join(directory, 'service.lock'), String(process.pid));
    service.onShutdown = () => {
      closing = service.close();
      releaseTimer = setTimeout(() => {
        fs.rmSync(path.join(directory, 'connection.json'), { force: true });
        fs.rmSync(path.join(directory, 'service.lock'), { force: true }); lockReleased = true;
      }, 150);
    };
    process.env.NAW_APP_VERSION = 'shutdown-order-current'; await ensureService(directory, process.execPath);
    assert.equal(lockReleased, true);
    const client = await connectService(directory, 'test');
    try { const state = await client.call('initial'); assert.equal(state.runtimeVersion, 'shutdown-order-current'); assert.equal(state.sessions.length, 0); }
    finally { client.close(); }
  } finally {
    clearTimeout(releaseTimer);
    if (closing) await closing; else await service?.close();
    if (lockReleased) await stopOwnEmptyService(directory);
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
