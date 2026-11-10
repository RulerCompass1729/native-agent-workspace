const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function fixture() {
  const calls = [], handlers = new Map(), servers = [], timers = new Map(); let quit, releasePair, timerSeq = 0;
  class Broker {
    constructor(root, options) { calls.push({ method: 'construct', root }); this.options = options; context.broker = this; }
    // Until when a pairing link or paired device is open (the real one reads mobile-access state).
    openUntil() { return context.openUntil === undefined ? context.now + 120000 : context.openUntil; }
    async beginPairing(selection) {
      calls.push({ method: 'pair', selection });
      if (context.replaceRequired && !selection.replace) throw Error('Synthetic explicit replacement required');
      if (context.holdPair) await new Promise(resolve => { releasePair = resolve; });
      // The real broker revokes the old grant before connecting; a later failure leaves nothing open.
      if (context.failAfterRevoke) { context.openUntil = 0; throw Error('Synthetic connect failure after revoke'); }
      return { expiresAt: Date.now() + 120000, secret: 's'.repeat(43) };
    }
    revoke() {
      calls.push({ method: 'revoke', quitting: context.quitting, exclusive: this.options.exclusive() });
      if (context.revokeFailure) throw Error('Synthetic revocation failure');
      return { authorizationRevoked: true, connectionClosed: true, committedWorkMayContinue: true };
    }
  }
  class Server extends EventEmitter {
    listen(options, callback) {
      calls.push({ method: 'listen', options }); this.options = options;
      options.signal.addEventListener('abort', () => { this.listening = false; this.emit('close'); });
      if (!context.holdListen) queueMicrotask(() => {
        if (options.signal.aborted) return;
        if (context.listenFailure) this.emit('error', Error('/PRIVATE_BIND_PATH'));
        else { this.listening = true; callback(); }
      });
    }
    address() { return this.listening ? { address: '127.0.0.1', port: 45123 } : null; }
    close(callback) { calls.push({ method: 'closeHTTP' }); this.listening = false; queueMicrotask(() => { this.emit('close'); callback?.(context.closeFailure ? Error('Synthetic close failure') : undefined); }); }
    closeAllConnections() { calls.push({ method: 'closeOwnHTTPConnections' }); if (context.closeAllFailure) throw Error('Synthetic close connections failure'); }
  }
  // Main state the current register() and before-quit read; no outbox broker in this fixture.
  const context = vm.createContext({ primary: true, quitting: false, dataDir: '/synthetic/profile', Error, AbortController, now: 1000, setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    applicationHandlers: new Map(), uiLocale: require('../ui-locale.js'), uiError: require('../ui-errors.cjs').uiError, outboxClosing: false, outboxQuitFailed: false, outboxBroker: null, backgroundControl: null,
    require(name) {
      if (name === './mobile-broker.cjs') return { MobileBroker: Broker };
      if (name === './mobile-http.cjs') return { createMobileHandler(value) { calls.push({ method: 'fixedHandler', origin: value.origin, actor: value.actor }); return () => {}; } };
      if (name === 'node:http') return { createServer(options) { calls.push({ method: 'constructHTTP', options }); const server = new Server(); servers.push(server); return server; } };
      assert.fail('Unexpected Main dependency: ' + name);
    },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, windows: new Map(), trusted: value => value === 'https://ui.invalid/',
    viewStore: { loaded: true }, saveViews() { calls.push({ method: 'saveViews' }); if (context.saveFailure) throw Error('Synthetic view save failed'); },
    dsh: { stop() { calls.push({ method: 'stopUI' }); } }, app: { on(name, handler) { assert.equal(name, 'before-quit'); quit = handler; } },
  });
  vm.runInContext(source.slice(source.indexOf('let mobileBroker;'), source.indexOf('const startupFile =')), context);
  vm.runInContext(source.slice(source.indexOf('function register('), source.indexOf('async function boot(')), context);
  const start = source.indexOf("register('mobilePairing'");
  vm.runInContext(source.slice(start, source.indexOf("register('readingState'", start)), context);
  vm.runInContext(source.slice(source.lastIndexOf("app.on('before-quit'"), source.indexOf('// Deliberately no native shutdown')), context);
  const frame = { url: 'https://ui.invalid/' }, sender = { id: 7, mainFrame: frame }; context.windows.set(7, { win: { isDestroyed: () => false, getBounds: () => ({}) }, view: {} });
  const selection = { actor: 'synthetic-human', origin: 'https://mobile.invalid', selection: [{ sessionId: 'a', actions: ['read'] }], replace: false, port: 0, carrierConfirmed: true };
  context.Date = { now: () => context.now };
  const fire = () => { const due = [...timers]; timers.clear(); for (const [, timer] of due) timer.fn(); };
  return { context, calls, handlers, servers, timers, fire, selection, releasePair: () => releasePair(), quit: event => quit(event), event: { sender, senderFrame: frame } };
}
test('boot registration is lazy and stopping an unused mobile entry creates neither broker nor authorization', () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  assert.equal(f.context.revokeAppMobile().authorizationRevoked, true); assert.deepEqual(f.calls, []);
});
test('the exact app scope and current exclusive predicate bind one broker across explicit desktop requests', async () => {
  const f = fixture();
  assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, true);
  await f.handlers.get('workspace:mobilePairing')(f.event, f.selection);
  assert.equal(f.calls.filter(call => call.method === 'construct').length, 1); assert.equal(f.calls[0].root, '/synthetic/profile');
  assert.equal(f.calls.filter(call => call.method === 'pair').length, 2);
  assert.deepEqual(structuredClone(f.calls.find(call => call.method === 'pair').selection), { actor: f.selection.actor, origin: f.selection.origin, selection: f.selection.selection, replace: false });
});
test('foreign frames and nonprimary or quitting app state cannot begin pairing', async () => {
  const f = fixture();
  await assert.rejects(f.handlers.get('workspace:mobilePairing')({ ...f.event, senderFrame: { url: 'https://ui.invalid/' } }, {}), /Unexpected IPC/);
  f.context.primary = false; assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, false);
  f.context.primary = true; f.context.quitting = true; assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, false);
  assert.deepEqual(f.calls, []);
});
test('explicit setup binds only one owned loopback server with finite HTTP limits; no bootstrap listener', async () => {
  const f = fixture(); assert.equal(f.servers.length, 0);
  const r = await f.handlers.get('workspace:mobilePairing')(f.event, f.selection); assert.equal(r.ok, true); assert.equal(r.value.localAddress, 'http://127.0.0.1:45123/mobile/');
  const s = f.servers[0]; assert.equal(s.options.host, '127.0.0.1'); assert.equal(s.options.exclusive, true); assert.equal(s.options.port, 0);
  assert.equal(s.maxConnections, 8); assert.equal(s.maxRequestsPerSocket, 16); assert.equal(s.headersTimeout, 5000); assert.equal(s.requestTimeout, 5000);
  await f.handlers.get('workspace:mobileRevoke')(f.event); assert.equal(s.options.signal.aborted, true); assert.equal(s.listening, false);
});
test('bad port or missing carrier confirmation cannot create authority or a server', async () => {
  const f = fixture();
  for (const value of [{ ...f.selection, port: 80 }, { ...f.selection, port: -1 }, { ...f.selection, carrierConfirmed: false }, { ...f.selection, publicBind: true }]) {
    assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, value)).ok, false);
  }
  assert.deepEqual(f.calls, []); assert.equal(f.servers.length, 0);
});
test('a rejected implicit replacement preserves the original authorization and listener', async () => {
  const f = fixture(); assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, true);
  f.context.replaceRequired = true;
  assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, false);
  assert.equal(f.calls.filter(call => call.method === 'revoke').length, 0); assert.equal(f.servers.length, 1); assert.equal(f.servers[0].listening, true);
});
test('revoking an in-flight pair prevents a late listener; overlapping setup does not queue another pair', async () => {
  const f = fixture(); f.context.holdPair = true;
  const first = f.handlers.get('workspace:mobilePairing')(f.event, f.selection);
  assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, false);
  await f.handlers.get('workspace:mobileRevoke')(f.event); f.releasePair(); assert.equal((await first).ok, false); assert.equal(f.servers.length, 0);
  assert.equal(f.calls.filter(call => call.method === 'pair').length, 1);
});
test('revoking during a pending bind aborts only the owned listener and cannot return a usable pairing result', async () => {
  const f = fixture(); f.context.holdListen = true;
  const first = f.handlers.get('workspace:mobilePairing')(f.event, f.selection); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.servers.length, 1); await f.handlers.get('workspace:mobileRevoke')(f.event); assert.equal((await first).ok, false);
  assert.equal(f.servers[0].options.signal.aborted, true); assert.equal(f.servers[0].listening, false);
});
test('bind failure revokes the new grant and reports no private transport diagnostic', async () => {
  const f = fixture(); f.context.listenFailure = true;
  const r = await f.handlers.get('workspace:mobilePairing')(f.event, f.selection); assert.equal(r.ok, false); assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  assert.equal(f.calls.filter(call => call.method === 'revoke').length, 1); assert.equal(f.servers[0].listening, false);
});
test('an owned HTTP close failure cannot skip durable authorization revocation or permit another listener', async () => {
  const f = fixture(); await f.handlers.get('workspace:mobilePairing')(f.event, f.selection); f.context.closeAllFailure = true;
  await f.handlers.get('workspace:mobileRevoke')(f.event);
  assert.equal(f.calls.filter(call => call.method === 'revoke').length, 1);
  const next = await f.handlers.get('workspace:mobilePairing')(f.event, { ...f.selection, replace: true }); assert.equal(next.ok, false); assert.equal(f.servers.length, 1);
});
test('quit first saves views, then revokes while exclusivity is still valid, and never calls native shutdown', () => {
  const f = fixture(); f.context.appMobileBroker();
  f.quit({ preventDefault() { assert.fail('Valid view save must not cancel quit'); } });
  assert.deepEqual(f.calls.map(call => call.method), ['construct', 'saveViews', 'revoke', 'stopUI']);
  assert.equal(f.calls[2].quitting, false); assert.equal(f.calls[2].exclusive, true); assert.equal(f.context.quitting, true);
});
test('a cancelled quit retains the mobile connection and existing app state', () => {
  const f = fixture(); f.context.appMobileBroker(); f.context.saveFailure = true; let cancelled = false;
  f.quit({ preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true); assert.equal(f.context.quitting, false); assert.deepEqual(f.calls.map(call => call.method), ['construct', 'saveViews']);
});
test('an unconfirmed mobile revoke is returned honestly without crashing or closing native sessions', async () => {
  const f = fixture(); f.context.appMobileBroker(); f.context.revokeFailure = true;
  const result = await f.handlers.get('workspace:mobileRevoke')(f.event);
  assert.equal(result.ok, true); assert.equal(result.value.authorizationRevoked, false); assert.equal(result.value.connectionClosed, false); assert.equal(result.value.committedWorkMayContinue, true);
});
test('preload exposes only local pairing and revoke among the mobile methods', async () => {
  const preload = fs.readFileSync(require.resolve('../preload.cjs'), 'utf8'), calls = []; let api;
  vm.runInNewContext(preload, { require(name) { assert.equal(name, 'electron'); return {
    // The preload also exposes the DSH locale bridge; only the workspace API is under test.
    contextBridge: { exposeInMainWorld(key, value) { assert.ok(['workspace', '__DSH_LOCALE__'].includes(key), key); if (key === 'workspace') api = value; } },
    ipcRenderer: { on() {}, invoke: async (...args) => { calls.push(args); return { ok: true, value: 'synthetic-result' }; } },
  }; } });
  assert.deepEqual(Object.keys(api).filter(key => key.startsWith('mobile')).sort(), ['mobilePairing', 'mobileRevoke']);
  assert.equal(await api.mobileRevoke(), 'synthetic-result'); assert.deepEqual(calls, [['workspace:mobileRevoke']]);
});
test('the existing GUI payload list includes the app-local broker and its existing authority modules without running a package build', () => {
  const recipe = fs.readFileSync(require.resolve('../../scripts/package-mac.cjs'), 'utf8');
  const start = recipe.indexOf('const sources = ['), end = recipe.indexOf('for (const name of sources)', start);
  assert.ok(start > 0 && end > start);
  const names = vm.runInNewContext(recipe.slice(start, end) + ';sources');
  for (const name of ['mobile-broker.cjs', 'mobile-access.cjs', 'mobile-session.cjs', 'mobile-http.cjs', 'mobile-web/index.html', 'mobile-web/client.js', 'mobile-web/style.css']) {
    assert.equal(names.filter(value => value === name).length, 1); assert.ok(fs.statSync(require.resolve('../' + name)).isFile());
  }
});

// 11-09 (T-19/B10, user: the phone entry may open a local port): the listener stays open only while a pairing link or a
// paired device is unexpired. Logout from the phone, or expiry of either, revokes and closes it. Checks are at most a
// minute apart and re-read the state, so a sleeping Mac or a clock change delays closing by at most that minute.
async function opened() {
  const f = fixture(); const r = await f.handlers.get('workspace:mobilePairing')(f.event, f.selection); assert.equal(r.ok, true);
  f.context.openUntil = f.context.now + 120000;
  return { f, server: f.servers[0], revokes: () => f.calls.filter(c => c.method === 'revoke').length };
}
const only = f => { assert.equal(f.timers.size, 1); return [...f.timers.values()][0]; };
test('an unpaired link closes the listener when it expires, checking at least once a minute', async () => {
  const { f, server, revokes } = await opened(); assert.equal(server.listening, true); assert.equal(only(f).ms, 60000);
  f.context.now += 60000; f.fire(); assert.equal(only(f).ms, 60000, 'Still open: checked again within a minute');
  f.context.now += 59999; f.fire(); assert.equal(only(f).ms, 2, 'The last check lands right after the expiry');
  const before = revokes(); f.context.now += 2; f.context.openUntil = 0; f.fire(); f.fire();
  assert.equal(revokes(), before + 1); assert.equal(server.options.signal.aborted, true); assert.equal(server.listening, false);
});
test('a paired device keeps the listener until it expires, even when the Mac slept past that time', async () => {
  const { f, server, revokes } = await opened();
  f.context.openUntil = f.context.now + 12 * 3600000; f.context.broker.options.changed(); assert.equal(only(f).ms, 60000);
  f.context.now += 13 * 3600000; f.context.openUntil = 0; const before = revokes();
  f.fire(); f.fire(); assert.equal(revokes(), before + 1); assert.equal(server.listening, false);
});
test('a phone logout closes the listener after the short response grace, not before', async () => {
  const { f, server, revokes } = await opened();
  f.context.openUntil = 0; f.context.broker.options.changed();
  assert.equal(server.listening, true, 'The logout response can still leave'); assert.equal(only(f).ms, 1000);
  const before = revokes(); f.fire(); assert.equal(revokes(), before + 1); assert.equal(server.listening, false);
});
test('a desktop revoke cancels the pending check', async () => {
  const { f, server } = await opened(); assert.equal(f.timers.size, 1);
  await f.handlers.get('workspace:mobileRevoke')(f.event); assert.equal(f.timers.size, 0); assert.equal(server.listening, false);
});
test('a re-pairing that fails after the old grant was revoked closes the old listener', async () => {
  const { f, server, revokes } = await opened(); f.context.failAfterRevoke = true;
  const r = await f.handlers.get('workspace:mobilePairing')(f.event, { ...f.selection, replace: true }); assert.equal(r.ok, false);
  assert.equal(f.servers.length, 1, 'No new listener'); const before = revokes(); f.fire();
  assert.equal(revokes(), before + 1); assert.equal(server.listening, false);
});
test('a refused re-pairing that revoked nothing keeps the paired listener and its check', async () => {
  const { f, server, revokes } = await opened(); f.context.replaceRequired = true; const before = revokes();
  assert.equal((await f.handlers.get('workspace:mobilePairing')(f.event, f.selection)).ok, false);
  assert.equal(server.listening, true); assert.equal(revokes(), before); assert.equal(only(f).ms, 60000);
});
test('a check left from an earlier pairing cannot cancel a newer pairing in progress', async () => {
  const { f, revokes } = await opened(); f.context.openUntil = 0; f.context.broker.options.changed();
  f.context.holdPair = true; const pending = f.handlers.get('workspace:mobilePairing')(f.event, { ...f.selection, replace: true });
  await new Promise(resolve => setImmediate(resolve)); const before = revokes(); f.fire(); assert.equal(revokes(), before, 'The stale logout check is a no-op');
  f.context.holdPair = false; f.context.openUntil = f.context.now + 120000; f.releasePair(); assert.equal((await pending).ok, true);
});
test('quitting with an open listener revokes access and closes the listener before the frontend stops', async () => {
  const { f, server } = await opened(); f.quit({ preventDefault() { assert.fail('Valid view save must not cancel quit'); } });
  assert.equal(server.listening, false); assert.equal(f.timers.size, 0);
  const order = f.calls.map(call => call.method).filter(m => ['saveViews', 'revoke', 'stopUI'].includes(m)).slice(-3);
  assert.deepEqual(order, ['saveViews', 'revoke', 'stopUI']);
});
