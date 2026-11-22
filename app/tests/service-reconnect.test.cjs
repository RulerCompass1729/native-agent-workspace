const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), vm = require('node:vm');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { ServiceClient, connectService } = require('../service-connection.cjs');
const { createWriter, readFrames } = require('../service-transport.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { uiError } = require('../ui-errors.cjs');

// 2026-11-20: the service ended one of a window's backend connections and the whole window stayed 「本地服务断开」
// until the person pressed 「重新连接本机服务」, several times within minutes. Real service clients over local
// sockets; each backend is a synthetic stand-in that answers `initial`, holds `hold`, and can end a connection.
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const reconnectModule = (() => { try { return require('../service-reconnect.cjs'); } catch { return null; } })();
const settled = async (check, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 10)); } return check(); };
const channels = context => context.page.map(([channel]) => channel);

async function backend(dataDir, key, session, capabilities = []) {
  const dir = path.join(dataDir, key); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-')); fs.chmodSync(socketDir, 0o700);
  const endpoint = path.join(socketDir, 's.sock');
  fs.writeFileSync(path.join(dir, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic' }), { mode: 0o600 });
  const state = { owner: 'view', runtimeVersion: 'synthetic', capabilities, diagnostics: { dispatches: 0, shellModelCalls: 0 },
    sessions: [{ id: session, nativeId: 'native-' + session, provider: 'codex', state: 'idle', owner: 'view' }], room: { revision: 0, messages: [], run: null } };
  // Each accepted connection, in order, with its handshake and the methods it was asked.
  const accepted = [], told = { ready: null, initial: null };
  const serve = socket => {
    const connection = { socket, hello: null, methods: [] }; accepted.push(connection); let buffer = '';
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!connection.hello) { connection.hello = request; socket.write(JSON.stringify(told.ready || { ready: true }) + '\n'); told.ready = null; continue; }
        connection.methods.push(request.method);
        const respond = () => socket.write(JSON.stringify({ id: request.id, ok: true, value: request.method === 'initial' ? structuredClone(state) : true }) + '\n');
        if (request.method === 'initial' && told.initial) told.initial({ connection, socket, state, request, respond });
        else if (request.method !== 'hold') respond();
      }
    });
  };
  let server = null;
  const listen = async () => { server = net.createServer(serve); await new Promise(resolve => server.listen(endpoint, resolve)); };
  const stop = async () => { const old = server; server = null; for (const c of accepted) c.socket.destroy(); if (old) await new Promise(resolve => old.close(resolve)); };
  await listen();
  // tell: the ready frame of the next connection only. onInitial: the test answers every `initial` from then on.
  return { key, accepted, listen, stop, tell: ready => { told.ready = ready; }, onInitial: answer => { told.initial = answer; }, remove: () => fs.rmSync(socketDir, { recursive: true, force: true }) };
}

async function fixture(t, keys = ['.', 'backends/aaaaaaaaaaaaaaaaaaaa'], { capabilities = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-data-')); fs.chmodSync(dataDir, 0o700);
  const backends = [], scope = Symbol('synthetic workspace'), opened = [];
  // Windows first: a window still open when its service stops would start reconnecting.
  t.after(async () => {
    for (const context of opened) context.client.close();
    for (const b of backends) { await b.stop(); b.remove(); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (const [index, key] of keys.entries()) backends.push(await backend(dataDir, key, 'session-' + index, capabilities));
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
function mainWiring(dataDir, { delays, tried = [] } = {}) {
  const handler = main.match(/\n {2}client\.on\('closed', \(\) => \{.*\}\);\n\}\n/)?.[0];
  assert.ok(handler, 'main.cjs handles a closed window connection in bindClient');
  const start = main.indexOf('let connectionEvents = null'), end = start < 0 ? -1 : main.indexOf('let backendSwitching = null', start);
  const block = end < 0 ? '' : main.slice(start, end);
  // delays: the app's own wiring over shorter intervals. tried: each place it connected to, in order.
  const context = vm.createContext({ path, dataDir, uiError, displayState: state => state, omitHidden: display => display,
    connectService: (dir, ...rest) => { tried.push(dir); return connectService(dir, ...rest); },
    sendToPage: (target, channel, ...data) => { if (!target.background && !target.win.isDestroyed()) target.page.push([channel, ...data]); },
    createReconnector: delays ? options => reconnectModule.createReconnector({ ...options, delays }) : reconnectModule?.createReconnector, createEventLog: reconnectModule?.createEventLog });
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
  assert.equal('service' in events[1], false, 'no reason is recorded that the service did not give');
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

// The independent review of 8e00056b (2026-11-21, BLOCK): each case below went wrong in the first version.
const history = f => JSON.parse(fs.readFileSync(path.join(f.dataDir, 'connection-events.json'), 'utf8'));
const told = context => context.page.filter(([channel]) => channel === 'workspace:reconnected');
// The reply to `initial` and a newer state in one write: both arrive before anything listens to the connection.
const answersThenWorks = ({ socket, request, state }) => {
  const initial = JSON.stringify({ id: request.id, ok: true, value: state });
  state.sessions[0].state = 'working';
  socket.write(initial + '\n' + JSON.stringify({ event: 'state', data: state }) + '\n');
};

test('a backend that stays unreachable does not keep a reachable one from its own reconnection', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), window = await f.open(), [a, b] = f.backends;
  wire(window);
  await a.stop();
  assert.ok(await settled(() => window.client.entries[0].closed));
  b.accepted[0].socket.destroy();
  assert.ok(await settled(() => b.accepted.length === 2 && !window.client.entries[1].closed), 'the reachable backend was not connected again while the other one stayed unreachable');
  // The window works again only with both: its page hears of that once, for both.
  assert.deepEqual([window.client.entries[0].closed, window.client.socket.destroyed, told(window).length], [true, true, 0]);
  await a.listen();
  assert.ok(await settled(() => told(window).length > 0, 10000), 'the window stayed disconnected after its other backend came back');
  assert.deepEqual([told(window).length, [...told(window)[0][2]].sort(), window.client.socket.destroyed], [1, ['session-0', 'session-1'], false]);
  const events = history(f);
  assert.deepEqual(events.filter(e => e.event === 'closed').map(e => e.backends).sort(), [[a.key], [b.key]].sort());
  assert.deepEqual(events.filter(e => e.event === 'restored').map(e => e.backends), [[b.key], [a.key]]);
  assert.ok(events.find(e => e.event === 'restored' && e.backends[0] === b.key).attempts === 1 && events.find(e => e.event === 'restored' && e.backends[0] === a.key).attempts > 1);
});

test('each connection that closes has its own attempts and its own record', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), window = await f.open(), [a, b] = f.backends;
  wire(window);
  // The first one's new connection is still waiting for its `initial` when the second one closes.
  let answer = null;
  a.onInitial(({ respond }) => { answer = respond; });
  a.accepted[0].socket.destroy();
  assert.ok(await settled(() => answer));
  b.accepted[0].socket.destroy();
  assert.ok(await settled(() => window.client.entries[1].closed || b.accepted.length === 2));
  answer();
  assert.ok(await settled(() => told(window).length > 0));
  const events = history(f);
  assert.deepEqual(events.filter(e => e.event === 'closed').map(e => [e.backends, e.reasons]).sort(), [[[a.key], ['peer']], [[b.key], ['peer']]].sort());
  assert.deepEqual(events.filter(e => e.event === 'restored').map(e => [e.backends, e.attempts]).sort(), [[[a.key], 1], [[b.key], 1]].sort());
  assert.deepEqual([a.accepted.length, b.accepted.length, told(window).length, [...told(window)[0][2]].sort()], [2, 2, 1, ['session-0', 'session-1']]);
});

test('the page is told the newest state the new connection has received', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), window = await f.open(), b = f.backends[1];
  wire(window);
  b.onInitial(answersThenWorks);
  b.accepted[0].socket.destroy();
  assert.ok(await settled(() => told(window).length > 0));
  assert.deepEqual([told(window)[0][1].sessions.find(s => s.id === 'session-1').state, window.client.entries[1].state.sessions[0].state], ['working', 'working']);
});

test('a window that opens starts from the newest state each connection has received', async t => {
  const f = await fixture(t);
  f.backends[0].onInitial(answersThenWorks);
  const window = await f.open();
  assert.equal(window.client.snapshot().sessions.find(s => s.id === 'session-0').state, 'working');
});

test('a reconnection answered late leaves alone the connection a backend update installed meanwhile', async t => {
  const f = await fixture(t, ['.']), wire = mainWiring(f.dataDir), window = await f.open(), a = f.backends[0];
  wire(window);
  // The reconnection's `initial` is answered late, with the state as it was when it asked.
  let late = null;
  a.onInitial(({ connection, socket, state, request, respond }) => {
    if (connection !== a.accepted[1]) return respond();
    const frame = JSON.stringify({ id: request.id, ok: true, value: { ...state, runtimeVersion: 'early-snapshot' } });
    late = () => socket.write(frame + '\n');
  });
  a.accepted[0].socket.destroy();
  assert.ok(await settled(() => late));
  // As a backend update does it (runBackendSwitch): main.cjs's own replaceBackendSockets inside maintainService.
  const from = main.indexOf('async function replaceBackendSockets('), to = main.indexOf('let connectionEvents = null', from);
  assert.ok(from >= 0 && to > from, 'main.cjs replaces a backend\'s sockets in replaceBackendSockets');
  const replace = vm.runInNewContext(`${main.slice(from, to)}\nreplaceBackendSockets`, { windows: new Map([[1, window]]), connectService, dataDir: f.dataDir, path,
    displayState: state => state, omitHidden: display => display, sendToPage() {} });
  const finish = window.client.maintainService(a.key);
  try { await replace(a.key); } finally { finish(); }
  const entry = window.client.entries[0], installed = entry.client;
  assert.deepEqual([a.accepted.length, entry.state.runtimeVersion], [3, 'synthetic']);
  late();
  assert.ok(await settled(() => history(f).some(e => e.event !== 'closed')), 'the late reconnection never ended');
  // Only the socket the late reconnection made itself is closed.
  assert.ok(await settled(() => a.accepted[1].socket.destroyed), 'the late reconnection left its own socket open');
  assert.deepEqual([entry.client === installed, installed.socket.destroyed, a.accepted[2].socket.destroyed, entry.state.runtimeVersion, window.client.socket.destroyed],
    [true, false, false, 'synthetic', false]);
  assert.deepEqual(history(f).map(e => [e.event, e.backends]), [['closed', [a.key]], ['replaced', [a.key]]]);
  assert.equal(await entry.client.call('ping'), true);
});

test('one window\'s reconnection leaves another window\'s operation on its own live connection alone', async t => {
  const f = await fixture(t, ['.'], { capabilities: ['gitWorktreeV1'] }), wire = mainWiring(f.dataDir), a = f.backends[0];
  const page = await f.open(), hidden = await f.open({ background: true });
  wire(page); wire(hidden);
  const live = page.client.entries[0].client, preview = () => page.client.call('gitWorktreePreview', '/synthetic', 'synthetic-job', '');
  assert.equal(await preview(), true);
  // The page's operation is waiting for its own `initial` while the hidden window's connection closes and comes back.
  let answer = null;
  a.onInitial(({ connection, respond }) => { if (connection === a.accepted[0]) answer = respond; else respond(); });
  const pending = preview().then(result => ({ result }), error => ({ error: error.uiMessage?.key || error.message }));
  assert.ok(await settled(() => answer));
  a.accepted[1].socket.destroy();
  assert.ok(await settled(() => a.accepted.length === 3 && !hidden.client.socket.destroyed), 'the hidden window is still disconnected');
  a.onInitial(null); answer();
  assert.deepEqual([await pending, page.client.entries[0].client === live, live.socket.destroyed], [{ result: true }, true, false]);
  assert.equal(await preview(), true);
});

test('a reconnection refuses a service that is kept for another purpose, as the first connection does', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), window = await f.open(), b = f.backends[1];
  wire(window);
  // What a butler's service reports about itself (daemon.cjs `initial`).
  let bound = true;
  b.onInitial(({ socket, state, request, respond }) => bound ? socket.write(JSON.stringify({ id: request.id, ok: true, value: { ...state, serviceBinding: { runtimeVersion: 'synthetic', purpose: 'butler' } } }) + '\n') : respond());
  b.accepted[0].socket.destroy();
  assert.ok(await settled(() => b.accepted.length >= 2 && b.accepted[1].socket.destroyed), 'the connection to the other purpose\'s service was kept');
  assert.deepEqual([window.client.entries[1].closed, window.client.socket.destroyed, told(window).length, 'serviceBinding' in window.client.entries[1].state], [true, true, 0, false]);
  // The ordinary service at that place again: the next attempt takes it.
  bound = false;
  assert.ok(await settled(() => told(window).length > 0, 10000));
  assert.equal(window.client.socket.destroyed, false);
});

// The re-review of dfa418e5 (2026-11-21, BLOCK): a backend that had used every attempt was tried all over again,
// and recorded lost once more, each time another backend's connection closed. Short intervals here; the real ones
// take about two minutes for the same.
test('a backend that stayed unreachable through every attempt is not tried again when another backend closes', async t => {
  const f = await fixture(t), window = await f.open(), [a, b] = f.backends, tried = [];
  mainWiring(f.dataDir, { delays: [0, 20, 40], tried })(window);
  const of = backend => { try { return history(f).filter(e => e.backends[0] === backend.key).map(e => [e.event, e.attempts]); } catch { return []; } };
  await a.stop();
  assert.ok(await settled(() => of(a).some(([event]) => event === 'lost')));
  // The other backend's connection closes twice afterwards: each of its connections has attempts of its own.
  for (const count of [2, 3]) {
    b.accepted.at(-1).socket.destroy();
    assert.ok(await settled(() => b.accepted.length === count && !window.client.entries[1].closed), 'the reachable backend was not connected again');
  }
  // Longer than every attempt of a pass.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(of(a), [['closed', undefined], ['lost', 3]]);
  assert.equal(tried.filter(dir => dir === path.join(f.dataDir, a.key)).length, 3, 'the unreachable backend was connected to again');
  assert.deepEqual(of(b), [['closed', undefined], ['restored', 1], ['closed', undefined], ['restored', 1]]);
  assert.deepEqual([channels(window), window.client.socket.destroyed], [['workspace:disconnected'], true]);

  // An update of that backend whose handover could not connect ends by telling the window (maintainService):
  // that still gives the connection its attempts.
  const finish = window.client.maintainService(a.key);
  await a.listen();
  finish();
  assert.ok(await settled(() => told(window).length > 0), 'the end of a backend update did not reconnect the window');
  assert.deepEqual([channels(window), [...told(window)[0][2]].sort(), window.client.socket.destroyed, of(a).at(-1)],
    [['workspace:disconnected', 'workspace:reconnected'], ['session-0', 'session-1'], false, ['restored', 1]]);
});

// The retry rules, on stand-in windows: no sockets and no real time.
const { createReconnector, createEventLog } = reconnectModule || {};
function standIn({ keys = ['.', 'b'], closed = ['b'] } = {}) {
  const client = { closing: false, control: { maintenance: new Set(), generations: new Map() }, socket: { destroyed: closed.length > 0 }, replaced: [],
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
  // The update's end tells the window (workspace-client.cjs maintainService): attempts it held back were not used.
  maintained.client.control.maintenance.delete('b');
  assert.equal(await updating.run(maintained, maintained.client), 'restored');
  assert.deepEqual([updating.log.connects, maintained.client.replaced], [['b'], ['b']]);
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

test('a connection that never comes back leaves the other closed one its own attempts, and the window to the person', { skip: !reconnectModule }, async () => {
  const context = standIn({ keys: ['.', 'b', 'c'], closed: ['b', 'c'] }), events = [];
  const one = rules({ record: event => { events.push([event.event, event.backends, event.attempts]); },
    connect: async (c, key) => { one.log.connects.push(key); if (key === 'b') throw Error('not listening'); return { client: { close() {} }, state: {} }; } });
  assert.equal(await one.run(context, context.client), 'lost');
  assert.deepEqual([one.log.connects.filter(key => key === 'c'), one.log.connects.filter(key => key === 'b'), context.client.replaced, one.log.restored, one.log.lost],
    [['c'], ['b', 'b', 'b'], ['c'], [], 1]);
  assert.deepEqual(events, [['closed', ['b'], undefined], ['closed', ['c'], undefined], ['restored', ['c'], 1], ['lost', ['b'], 3]]);
});

test('a connection that used up its attempts is not tried again when another one closes', { skip: !reconnectModule }, async () => {
  const context = standIn({ keys: ['a', 'b'], closed: ['a'] }), events = [];
  // a never answers; b answers at once the first time it closes, and at its last attempt the second time.
  const answers = [true, false, false, true];
  const one = rules({ record: event => { events.push([event.event, event.backends[0], event.attempts]); },
    connect: async (c, key) => { one.log.connects.push(key); if (key === 'a' || !answers.shift()) throw Error('not listening'); return { client: { closeReason: 'peer', close() {} }, state: {} }; } });
  const closes = key => { context.client.entries.find(e => e.key === key).closed = true; context.client.socket.destroyed = true; return one.run(context, context.client); };
  assert.equal(await one.run(context, context.client), 'lost');
  assert.equal(await closes('b'), 'lost');
  assert.equal(await closes('b'), 'lost');
  assert.deepEqual(events, [['closed', 'a', undefined], ['lost', 'a', 3], ['closed', 'b', undefined], ['restored', 'b', 1], ['closed', 'b', undefined], ['restored', 'b', 3]]);
  assert.deepEqual([one.log.connects.filter(key => key === 'a').length, context.client.replaced, one.log.lost, one.log.restored], [3, ['b', 'b'], 1, []]);
  // The person's button gives the window a new client with new connections (main.cjs `reconnect`): one of those
  // that closes has its attempts.
  const pressed = standIn({ keys: ['a', 'b'], closed: ['a'] });
  assert.equal(await one.run(pressed, pressed.client), 'lost');
  assert.equal(one.log.connects.filter(key => key === 'a').length, 6);
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

// The service's own reason for ending a transport (C's review of 65c2d03e, C-TR-2): it cannot travel on the
// transport being ended, so the service hands it to the same owner's next one.
test('the record of a reconnection carries the reason the service gave for ending the transport', async t => {
  const f = await fixture(t), wire = mainWiring(f.dataDir), window = await f.open(), other = f.backends[1], at = Date.UTC(2026, 10, 20, 23, 0, 0);
  wire(window);
  other.tell({ ready: true, ended: { reason: 'write-queue-frames', at } });
  other.accepted[0].socket.destroy();
  assert.ok(await settled(() => channels(window).includes('workspace:reconnected')));
  const events = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'connection-events.json'), 'utf8'));
  assert.deepEqual(events.map(e => e.event), ['closed', 'restored']);
  assert.deepEqual(events[1].service, [{ backend: other.key, reason: 'write-queue-frames', endedAt: new Date(at).toISOString() }]);
  assert.deepEqual(events[0].reasons, ['peer'], 'what this process saw itself stays as it was');
});

test('a service client keeps only a known reason and a time from what the service says', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-told-')); fs.chmodSync(dir, 0o700);
  const endpoint = path.join(dir, 's.sock'); let ready = null;
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.write(JSON.stringify(ready) + '\n'); });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const kept = async frame => {
    ready = frame; const socket = net.connect(endpoint), client = new ServiceClient(socket);
    await once(client, 'ready'); socket.destroy(); return client.priorClose;
  };
  assert.equal(await kept({ ready: true }), undefined);
  assert.deepEqual(await kept({ ready: true, ended: { reason: 'write-queue-frames', at: 1763679600000, error: 'ENOENT: /private/place', path: '/private/place' } }), { reason: 'write-queue-frames', at: 1763679600000 });
  for (const ended of ['write-queue-frames', { reason: 'ENOENT: no such file /private/place', at: 1763679600000 }, { reason: 'write-queue-frames', at: 'now' }, { reason: 'write-queue-frames' }, { reason: ['write-queue-frames'], at: 1 }, null])
    assert.equal(await kept({ ready: true, ended }), undefined, JSON.stringify(ended));
});

test('the writer and the reader say why they end a transport, once, before ending it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-writer-')); fs.chmodSync(dir, 0o700);
  const endpoint = path.join(dir, 's.sock'), accepted = [], server = net.createServer(socket => { socket.on('error', () => {}); accepted.push(socket); });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const peers = [];
  t.after(async () => { for (const socket of [...accepted, ...peers]) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  // A real local socket whose other end never reads: what the service writes stays queued.
  const pair = async () => {
    const peer = net.connect(endpoint), index = accepted.length; peer.on('error', () => {}); peers.push(peer);
    await once(peer, 'connect'); peer.pause(); assert.ok(await settled(() => accepted.length > index));
    return accepted[index];
  };
  const frame = Buffer.alloc(256 * 1024, 'x');
  const written = async options => {
    const socket = await pair(), reasons = [], writer = createWriter(socket, { ...options, refused: reason => { reasons.push([reason, socket.destroyed]); } });
    let sent = 0; while (writer.sendFrame(frame) && sent < 64) sent++;
    return { reasons, destroyed: socket.destroyed };
  };
  assert.deepEqual(await written({ maxFrames: 4 }), { reasons: [['write-queue-frames', false]], destroyed: true });
  assert.deepEqual(await written({ maxBytes: 3 * frame.length }), { reasons: [['write-queue-bytes', false]], destroyed: true });
  const unencodable = await pair(), why = [];
  assert.equal(createWriter(unencodable, { refused: reason => why.push(reason) }).send({ value: 1n }), false);
  assert.deepEqual([why, unencodable.destroyed], [['encode-failed'], true]);

  const read = async text => {
    const socket = await pair(), reasons = []; readFrames(socket, 64, () => {}, reason => { reasons.push([reason, socket.destroyed]); });
    peers.at(-1).write(text); assert.ok(await settled(() => socket.destroyed, 2000));
    return reasons;
  };
  assert.deepEqual(await read('x'.repeat(200) + '\n'), [['too-large', false]]);
  assert.deepEqual(await read('not json\n'), [['unreadable', false]]);
  assert.deepEqual(await read('[1]\n'), [['unreadable', false]]);
});

// The real service process, owned by the test. Synthetic native host, no session and no model.
async function ownedService(t) {
  const root = path.resolve(__dirname, '../..'), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-service-')));
  const child = fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', path.join(root, 'scripts/fixtures/connection-drop.cjs')],
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: os.tmpdir(), NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: directory }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const open = [];
  t.after(async () => {
    for (const client of open) client.socket.destroy();
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(await settled(() => fs.existsSync(path.join(directory, 'connection.json')) || child.exitCode !== null, 10000) && child.exitCode === null, 'the owned synthetic service starts');
  return { child, connect: async owner => { const client = await connectService(directory, owner); open.push(client); return client; } };
}

// Two real transports of one owner.
test('the real service tells an owner\'s next transport why it ended the previous one, and only then', { timeout: 30000 }, async t => {
  const { child, connect } = await ownedService(t);
  const closed = client => client.socket.destroyed ? Promise.resolve() : once(client, 'closed');
  const reason = async owner => { const client = await connect(owner), prior = client.priorClose; client.close(); await closed(client); return prior?.reason; };

  // A request the service refuses.
  const first = await connect('window-a'), other = await connect('window-b'), before = Date.now();
  assert.equal(first.priorClose, undefined);
  first.socket.write(JSON.stringify({ id: 1, method: 'initial', args: 'not a list' }) + '\n');
  await closed(first);
  assert.equal(first.closeReason, 'peer', 'the ended transport itself still only says which side ended it');
  const second = await connect('window-a');
  assert.equal(second.priorClose?.reason, 'request-refused');
  assert.ok(second.priorClose.at >= before - 1000 && second.priorClose.at <= Date.now() + 1000);
  assert.equal(await other.call('ping').catch(error => error.message) !== undefined, true);
  assert.equal(other.socket.destroyed, false, 'another owner\'s transport is left alone');
  second.close(); await closed(second);
  assert.equal(await reason('window-a'), undefined, 'the reason is told once');
  assert.equal(await reason('window-b-new'), undefined, 'and to no other owner');

  // A reader that stopped: replies wait in the service until it ends the transport (createWriter, 1024 frames).
  const stalled = await connect('window-a');
  stalled.socket.pause();
  // Written raw: the client itself shares concurrent reads (service-connection.cjs readState).
  for (let index = 0; index < 1400; index++) stalled.socket.write(JSON.stringify({ id: 10000 + index, method: 'initial', args: [] }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 1500));
  stalled.socket.resume();
  await closed(stalled);
  assert.equal(await reason('window-a'), 'write-queue-frames');

  // Controls: a transport the client closes, and one the service's process drops without any of its rules.
  const leaving = await connect('window-a'); leaving.close(); await closed(leaving);
  assert.equal(await reason('window-a'), undefined);
  const dropped = await connect('window-a');
  // The fixture's native host answers every message as well; only the drop's own answer counts.
  const answer = new Promise(resolve => { const heard = m => { if (m.dropId === 1) { child.off('message', heard); resolve(m); } }; child.on('message', heard); });
  child.send({ id: 1, method: 'drop-connections', value: 0 });
  assert.ok((await answer).dropped >= 1); await closed(dropped);
  assert.equal(dropped.closeReason, 'peer');
  assert.equal(await reason('window-a'), undefined, 'an ending without a rule of the service stays unexplained');
});

// 2026-11-21: the butler's releaseRotation came back 「本地运行服务断开」 twice and wrote nothing. That call has six
// arguments, and the service ended every transport that sent more than five (seven for `run`).
test('the real service answers releaseRotation on the transport that asked', { timeout: 30000 }, async t => {
  const { connect } = await ownedService(t), client = await connect('window-a');
  const answer = await client.call('releaseRotation', 'no-such-session', 'native', 'epoch', 'tag', { kind: 'person', id: 'window-a' }, 'discard-unresolved-handoff')
    .then(value => ({ value }), error => ({ error: error.message }));
  assert.equal(client.socket.destroyed, false, `the service ended the transport that asked: ${JSON.stringify(answer)}`);
  assert.ok(answer.error && answer.error !== uiError('error.serviceClosed').message, JSON.stringify(answer));
  assert.equal((await client.call('initial')).protocol, 1);
  // One argument more is still refused, as for every other method.
  const more = client.call('releaseRotation', 1, 2, 3, 4, 5, 6, 7).catch(error => error.message);
  assert.equal(await more, uiError('error.serviceClosed').message);
});

// C's review of 65c2d03e, C-TR-1: a terminal marked failed that a late success brings back shows a first screen and
// then drops every later output. Here a failed terminal is never brought back: it is removed and loaded again.
test('a terminal that failed to load because the window was disconnected is loaded again after the reconnection', () => {
  const handler = renderer.match(/api\.onReconnected\((\(next, redraw = \[\]\) => \{\n.*?\n {2}\})\),\n/s)?.[1];
  const offlineRule = renderer.match(/entry\.offline = (.*);\n/)?.[1];
  assert.ok(handler && offlineRule, 'renderer.js marks and reloads terminals around a reconnection');
  const offline = vm.runInNewContext(`(error => ${offlineRule})`);
  const failedBy = key => offline(key ? { name: 'Error', message: 'x', uiMessage: { version: 1, key } } : new Error('x'));
  assert.deepEqual(['error.serviceClosed', 'error.client.serviceNotConnected', 'error.terminalViewChanged', 'error.confirmationTimeout', null].map(failedBy), [true, true, false, false, false]);
  const entry = extra => ({ term: { dispose() { this.disposed = true; } }, element: { remove() { this.removed = true; } }, ...extra });
  const terminals = new Map([
    ['restored-backend', entry({ ready: true })],
    ['failed-while-closed', entry({ failed: true, offline: failedBy('error.client.serviceNotConnected') })],
    ['failed-in-flight', entry({ failed: true, offline: failedBy('error.serviceClosed') })],
    ['failed-otherwise', entry({ failed: true, offline: failedBy('error.terminalViewChanged') })],
    ['first-message', entry({ failed: true, waitingForFirstTurn: true, offline: failedBy(null) })],
    ['live-backend', entry({ ready: true })],
  ]), all = new Map(terminals), log = [];
  const context = vm.createContext({ terminals, state: { sessions: [] }, freezeLegacyProgress() {}, updateState: next => log.push(['state', next]), render: () => log.push(['render', context.disconnected]), disconnected: true });
  vm.runInContext(`var run = ${handler}`, context);
  context.run('next state', ['restored-backend']);
  assert.deepEqual([...terminals.keys()], ['failed-otherwise', 'first-message', 'live-backend']);
  for (const [id, e] of all) assert.deepEqual([id, Boolean(e.term.disposed), Boolean(e.element.removed)], [id, !terminals.has(id), !terminals.has(id)]);
  assert.deepEqual(log, [['state', 'next state'], ['render', false]], 'the page counts as connected before it draws again');

  // A failed terminal takes no output, and only its own first load ever marks a terminal ready.
  assert.match(renderer, /api\.onTerminal\(event => \{ const entry = terminals\.get\(event\.id\); if \(!entry \|\| entry\.failed\) return;/);
  assert.equal(renderer.match(/entry\.ready = true/g).length, 1);
});
