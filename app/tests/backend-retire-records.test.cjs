// R255.1: an old backend that holds records but nothing running retires; its records stay in its store.
// Synthetic records only. These tests start their own daemons and never inherit the developer's backend.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { connect, ensureService, ensureServiceAt, connectService, retireHistoryService } = require('../service-client.cjs');
const { maintenanceProof } = require('../backend-switch.cjs');
const { readLayout, writeLayout } = require('../service-layout.cjs');
const { readLock, ownerMayBeAlive } = require('../service-lock.cjs');

const ACTIVE = `backends/${'b'.repeat(20)}`, VERSION = 'retire-v1';

// The current backend: a socket that answers like an empty service of this version.
async function currentService(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-fixture-')), endpoint = path.join(transport, 's.sock'), sockets = new Set();
  const state = { runtimeVersion: VERSION, capabilities: [], sessions: [], room: { messages: [], run: null } };
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
async function oldBackend(t, stored) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retire-')), oldVersion = process.env.NAW_APP_VERSION;
  let current;
  t.after(async () => {
    await stopOwnService(directory); await current?.close();
    if (oldVersion === undefined) delete process.env.NAW_APP_VERSION; else process.env.NAW_APP_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (typeof stored === 'string') fs.writeFileSync(path.join(directory, 'workspace.json'), stored, { mode: 0o600 });
  else fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(stored), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'runtime-locations.json'), JSON.stringify({ claude: '/usr/bin/false', codex: '/usr/bin/false' }), { mode: 0o600 });
  process.env.NAW_APP_VERSION = VERSION; await ensureService(directory, process.execPath);
  current = await currentService(path.join(directory, ACTIVE));
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
