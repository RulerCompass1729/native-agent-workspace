const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), vm = require('node:vm');
const { ServiceClient, connectService } = require('../service-connection.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { uiError } = require('../ui-errors.cjs');

// 2026-11-20: the service ended one of a window's backend connections and the whole window stayed 「本地服务断开」
// until the person pressed 「重新连接本机服务」, several times within minutes. Real service clients over local
// sockets; each backend is a synthetic stand-in that answers `initial`, holds `hold`, and can end a connection.
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const reconnectModule = (() => { try { return require('../service-reconnect.cjs'); } catch { return null; } })();
const settled = async (check, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 10)); } return check(); };
const channels = context => context.page.map(([channel]) => channel);

async function backend(dataDir, key, session) {
  const dir = path.join(dataDir, key); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-')); fs.chmodSync(socketDir, 0o700);
  const endpoint = path.join(socketDir, 's.sock');
  fs.writeFileSync(path.join(dir, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic' }), { mode: 0o600 });
  const state = { owner: 'view', runtimeVersion: 'synthetic', capabilities: [], diagnostics: { dispatches: 0, shellModelCalls: 0 },
    sessions: [{ id: session, nativeId: 'native-' + session, provider: 'codex', state: 'idle', owner: 'view' }], room: { revision: 0, messages: [], run: null } };
  // Each accepted connection, in order, with its handshake and the methods it was asked.
  const accepted = [];
  const serve = socket => {
    const connection = { socket, hello: null, methods: [] }; accepted.push(connection); let buffer = '';
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!connection.hello) { connection.hello = request; socket.write('{"ready":true}\n'); continue; }
        connection.methods.push(request.method);
        if (request.method !== 'hold') socket.write(JSON.stringify({ id: request.id, ok: true, value: request.method === 'initial' ? structuredClone(state) : true }) + '\n');
      }
    });
  };
  let server = null;
  const listen = async () => { server = net.createServer(serve); await new Promise(resolve => server.listen(endpoint, resolve)); };
  const stop = async () => { const old = server; server = null; for (const c of accepted) c.socket.destroy(); if (old) await new Promise(resolve => old.close(resolve)); };
  await listen();
  return { key, accepted, listen, stop, remove: () => fs.rmSync(socketDir, { recursive: true, force: true }) };
}

async function fixture(t, keys = ['.', 'backends/aaaaaaaaaaaaaaaaaaaa']) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-data-')); fs.chmodSync(dataDir, 0o700);
  const backends = [], scope = Symbol('synthetic workspace'), opened = [];
  // Windows first: a window still open when its service stops would start reconnecting.
  t.after(async () => {
    for (const context of opened) context.client.close();
    for (const b of backends) { await b.stop(); b.remove(); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (const [index, key] of keys.entries()) backends.push(await backend(dataDir, key, 'session-' + index));
  // As main.cjs connects a window: one service client per backend, under the window's owner.
  const open = async ({ background = false } = {}) => {
    const view = { owner: 'owner-' + opened.length }, entries = [];
    for (const { key } of backends) { const client = await connectService(path.join(dataDir, key), view.owner, { page: !background }); entries.push({ key, client, state: await client.call('initial') }); }
    const context = { background, view, client: new WorkspaceClient(entries, '.', scope), page: [], shown: null, statePush: { discardWaiting() {} },
      win: { destroyed: false, isDestroyed() { return this.destroyed; } } };
    opened.push(context); return context;
  };
  return { dataDir, backends, open };
}

// main.cjs's own handler for a closed window connection, with what it uses there. The page is a list of what
// main would send to the window.
function mainWiring(dataDir) {
  const handler = main.match(/\n {2}client\.on\('closed', \(\) => \{.*\}\);\n\}\n/)?.[0];
  assert.ok(handler, 'main.cjs handles a closed window connection in bindClient');
  const start = main.indexOf('let connectionEvents = null'), end = start < 0 ? -1 : main.indexOf('let backendSwitching = null', start);
  const block = end < 0 ? '' : main.slice(start, end);
  const context = vm.createContext({ path, dataDir, connectService, uiError, displayState: state => state, omitHidden: display => display,
    sendToPage: (target, channel, ...data) => { if (!target.background && !target.win.isDestroyed()) target.page.push([channel, ...data]); },
    createReconnector: reconnectModule?.createReconnector, createEventLog: reconnectModule?.createEventLog });
  return vm.runInContext(`${block}\n(function wire(context) { const client = context.client; const send = (channel, ...data) => { if (context.client === client) sendToPage(context, channel, ...data); };${handler.replace(/\n\}\n$/, '\n')} })`, context);
}

test('a window whose backend connection the service ended works again without the person, and nothing is sent again', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), window = await f.open(), [root, other] = f.backends;
  wire(window);
  const service = window.client.entries[1].client;
  const held = service.call('hold', 'typed by the person');
  held.catch(() => {});
  assert.ok(await settled(() => other.accepted[0].methods.includes('hold')));
  other.accepted[0].socket.destroy();
  await assert.rejects(held, { message: uiError('error.serviceClosed').message });

  assert.ok(await settled(() => channels(window).includes('workspace:reconnected')), `the window is still disconnected; its page was sent ${JSON.stringify(channels(window))}`);
  assert.equal(window.client.socket.destroyed, false);
  assert.deepEqual(channels(window), ['workspace:reconnected'], 'the person is told nothing when the connection comes straight back');
  // The page redraws the terminals of that backend's sessions only: they missed output meanwhile.
  assert.deepEqual(window.page[0][2], ['session-1']);
  assert.deepEqual(window.page[0][1].sessions.map(s => s.id).sort(), ['session-0', 'session-1']);

  assert.equal(other.accepted.length, 2);
  assert.deepEqual({ owner: other.accepted[1].hello.owner, page: other.accepted[1].hello.page }, { owner: window.view.owner, page: undefined });
  assert.deepEqual(other.accepted[1].methods, ['initial'], 'the call that was in flight is not sent again');
  assert.equal(root.accepted.length, 1, 'the live backend connection is left alone');
  assert.equal(await window.client.entries[1].client.call('ping'), true);

  const events = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'connection-events.json'), 'utf8'));
  assert.deepEqual(events.map(e => [e.event, e.window, e.backends]), [['closed', 'page', [other.key]], ['restored', 'page', [other.key]]]);
  assert.deepEqual(events[0].reasons, ['peer']);
  assert.ok(Number.isInteger(events[0].loopDelayMs) && events[1].attempts === 1);
  assert.equal(fs.statSync(path.join(f.dataDir, 'connection-events.json')).mode & 0o777, 0o600);
});

test('an agent\'s hidden window reconnects the same way and sends its missing page nothing', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), person = await f.open(), hidden = await f.open({ background: true });
  wire(person); wire(hidden);
  f.backends[1].accepted[1].socket.destroy();
  assert.ok(await settled(() => f.backends[1].accepted.length === 3 && !hidden.client.socket.destroyed), 'the hidden window is still disconnected');
  assert.equal(f.backends[1].accepted[2].hello.page, false);
  assert.deepEqual([hidden.page, person.page, person.client.socket.destroyed], [[], [], false]);
});

// The retry rules, on stand-in windows: no sockets and no real time.
const { createReconnector, createEventLog } = reconnectModule || {};
function standIn({ keys = ['.', 'b'], closed = ['b'] } = {}) {
  const client = { closing: false, control: { maintenance: new Set() }, socket: { destroyed: closed.length > 0 }, replaced: [],
    entries: keys.map(key => ({ key, closed: closed.includes(key), closing: false, client: { closeReason: 'peer' } })),
    replaceService(key, service) { const entry = this.entries.find(e => e.key === key); entry.closed = false; entry.client = service; this.replaced.push(key); this.socket.destroyed = this.entries.some(e => e.closed); } };
  return { client, background: false, win: { isDestroyed: () => false } };
}
function rules(overrides = {}) {
  const log = { connects: [], restored: [], lost: 0, records: [], sleeps: [] };
  const run = createReconnector({ delays: [0, 5, 10], noticeMs: 60000, sleep: async ms => { log.sleeps.push(ms); },
    connect: async (context, key) => { log.connects.push(key); return { client: { close() { log.closedNew = (log.closedNew || 0) + 1; } }, state: {} }; },
    restored: (context, client, keys) => { log.restored.push(keys); }, lost: () => { log.lost++; }, record: event => { log.records.push(event.event); }, ...overrides });
  return { log, run };
}

test('keeps trying while the service does not answer, then leaves it to the person', { skip: !reconnectModule }, async () => {
  let failures = 2;
  const first = rules(), context = standIn();
  first.run = createReconnector({ delays: [0, 5, 10], noticeMs: 60000, sleep: async ms => { first.log.sleeps.push(ms); }, restored: (c, client, keys) => first.log.restored.push(keys), lost: () => first.log.lost++, record: e => first.log.records.push(e.event),
    connect: async (c, key) => { first.log.connects.push(key); if (failures-- > 0) throw Error('not listening'); return { client: { close() {} }, state: {} }; } });
  assert.equal(await first.run(context, context.client), 'restored');
  assert.deepEqual([first.log.connects, first.log.sleeps, first.log.restored, first.log.lost, first.log.records], [['b', 'b', 'b'], [5, 10], [['b']], 0, ['closed', 'restored']]);

  const never = rules({ connect: async () => { throw Error('not listening'); } }), gone = standIn();
  assert.equal(await never.run(gone, gone.client), 'lost');
  assert.deepEqual([never.log.lost, never.log.restored, never.log.records, gone.client.socket.destroyed], [1, [], ['closed', 'lost'], true]);
});

test('tells the page once a reconnection takes long, and only once', { skip: !reconnectModule }, async () => {
  let release;
  const slow = rules({ noticeMs: 20, connect: () => new Promise(resolve => { release = () => resolve({ client: { close() {} }, state: {} }); }) }), context = standIn();
  const run = slow.run(context, context.client);
  assert.ok(await settled(() => slow.log.lost === 1));
  release();
  assert.equal(await run, 'restored');
  assert.deepEqual([slow.log.lost, slow.log.restored], [1, [['b']]]);
});

test('leaves alone a window that closed as a whole, changed its connection, or has a backend being updated', { skip: !reconnectModule }, async () => {
  const why = [], whole = rules({ record: event => { why.push(event.reasons); } }), unassembled = standIn({ closed: [] });
  assert.equal(await whole.run(unassembled, unassembled.client), 'lost');
  assert.deepEqual([whole.log.connects, whole.log.lost, why], [[], 1, [['window-state']]]);

  // A window that is closing is not written down as a lost connection.
  const quitting = rules(), closing = standIn(); closing.client.closing = true;
  assert.equal(await quitting.run(closing, closing.client), 'stale');
  assert.deepEqual([quitting.log.records, quitting.log.connects, quitting.log.lost], [[], [], 0]);

  // The person pressed the button meanwhile: the window has another client and this one is closing.
  const changed = standIn(), replaced = rules({ connect: async (c, key) => { changed.client.closing = true; return { client: { close() { replaced.log.closedNew = 1; } }, state: {} }; } });
  assert.equal(await replaced.run(changed, changed.client), 'stale');
  assert.deepEqual([changed.client.replaced, replaced.log.closedNew, replaced.log.lost, replaced.log.restored], [[], 1, 0, []]);

  const updating = rules(), maintained = standIn(); maintained.client.control.maintenance.add('b');
  assert.equal(await updating.run(maintained, maintained.client), 'lost');
  assert.deepEqual([updating.log.connects, maintained.client.replaced], [[], []]);
});

test('a second connection that closes during a reconnection is reconnected too', { skip: !reconnectModule }, async () => {
  const context = standIn({ keys: ['.', 'b', 'c'] }), both = rules();
  let late = true;
  both.run = createReconnector({ delays: [0, 5], noticeMs: 60000, sleep: async () => {}, lost: () => both.log.lost++, record: () => {},
    connect: async (c, key) => { both.log.connects.push(key); return { client: { close() {} }, state: {} }; },
    restored: (c, client, keys) => {
      both.log.restored.push(keys);
      if (late) { late = false; const entry = client.entries[2]; entry.closed = true; client.socket.destroyed = true; both.run(c, client); }
    } });
  await both.run(context, context.client);
  assert.ok(await settled(() => both.log.restored.length === 2));
  assert.deepEqual([both.log.connects, both.log.restored, context.client.socket.destroyed, both.log.lost], [['b', 'c'], [['b'], ['c']], false, 0]);
});

test('the connection record keeps the newest events in a private file', { skip: !reconnectModule }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-log-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'connection-events.json'), log = createEventLog(file, { kept: 3 });
  for (let index = 0; index < 5; index++) log.add({ event: 'closed', index });
  const events = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(events.map(e => e.index), [2, 3, 4]);
  assert.ok(events.every(e => !Number.isNaN(Date.parse(e.at)) && Number.isInteger(e.loopDelayMs)));
  assert.deepEqual([fs.statSync(file).mode & 0o777, fs.readdirSync(dir)], [0o600, ['connection-events.json']]);
});

test('a service client says which side ended its connection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-why-')); fs.chmodSync(dir, 0o700);
  const endpoint = path.join(dir, 's.sock'), accepted = [], server = net.createServer(socket => { socket.on('error', () => {}); accepted.push(socket); });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => { for (const socket of accepted) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const reasonAfter = async act => {
    const socket = net.connect(endpoint), client = new ServiceClient(socket), index = accepted.length;
    await new Promise(resolve => socket.once('connect', resolve)); assert.ok(await settled(() => accepted.length > index));
    let closed = false; client.once('closed', () => { closed = true; });
    act(client, accepted[index]);
    if (!await settled(() => closed, 2000)) { socket.destroy(); return 'still open'; }
    return client.closeReason;
  };
  assert.equal(await reasonAfter((client, peer) => peer.destroy()), 'peer');
  assert.equal(await reasonAfter(client => client.close()), 'local-close');
  assert.equal(await reasonAfter((client, peer) => peer.write('not json\n')), 'local-destroy');
  assert.equal(await reasonAfter((client, peer) => peer.write(JSON.stringify({ event: 'state', delta: 1, data: null }) + '\n')), 'state-rebuild');
});
