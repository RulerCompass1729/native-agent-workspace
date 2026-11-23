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
    resumeInfo(){return context.savedEndpoint||null;}
    resumeBlocker(){return context.blocker||null;}
    async preparePersistence(){if(context.holdPrepare)await new Promise(r=>{context.releasePrepare=r;});}
    approvalStatus(){return {paired:false,enabled:false,registered:false,pending:null,...(context.savedEndpoint&&!context.blocker?{resumeRequired:true}:{})};}
    setEndpoint(value){this.endpoint=value;}
    async resume(validate){if(!await validate())throw Error('Synthetic changed carrier');calls.push({method:'resume'});return {restored:true};}
    suspend(){calls.push({method:'pause',quitting:context.quitting,exclusive:this.options.exclusive()});return {paused:true,connectionClosed:true};}
    async beginPairing(selection) {
      calls.push({ method: 'pair', selection });
      if (context.replaceRequired && !selection.replace) throw Error('Synthetic explicit replacement required');
      if (context.holdPair) await new Promise(resolve => { releasePair = resolve; });
      // The real broker revokes the old grant before connecting; a later failure leaves nothing open.
      if (context.failAfterRevoke) { context.openUntil = 0; throw Error('Synthetic connect failure after revoke'); }
      return { expiresAt: Date.now() + 120000, secret: 's'.repeat(43) };
    }
    async beginCandidate(value){this.validate=value.validate;const result=await this.beginPairing({actor:value.actor,origin:value.origin,replace:value.replace,all:true});this.setupId='11111111-1111-4111-8111-111111111111';return {...result,id:this.setupId};}
    cancelCandidate(id){calls.push({method:'cancelCandidate'});const cancelled=id===this.setupId;if(cancelled){this.setupId=null;context.openUntil=context.activeUntil||0;}return {cancelled};}
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
        if (context.listenFailure) this.emit('error', Object.assign(Error('/PRIVATE_BIND_PATH'), { code: context.listenCode }));
        else { this.listening = true; callback(); }
      });
    }
    address() { return this.listening ? { address: '127.0.0.1', port: 45123 } : null; }
    close(callback) { calls.push({ method: 'closeHTTP' }); this.listening = false; queueMicrotask(() => { this.emit('close'); callback?.(context.closeFailure ? Error('Synthetic close failure') : undefined); }); }
    closeAllConnections() { calls.push({ method: 'closeOwnHTTPConnections' }); if (context.closeAllFailure) throw Error('Synthetic close connections failure'); }
  }
  // Main state the current register() and before-quit read; no outbox broker in this fixture.
  const context = vm.createContext({ primary: true, quitting: false, dataDir: '/synthetic/profile', Error, AbortController, now: 1000, setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fs:{existsSync:()=>true},path:require('node:path'),applicationHandlers: new Map(), roomState: {}, sessionLabels: { labels: new Map() }, uiLocale: require('../ui-locale.js'), uiError: require('../ui-errors.cjs').uiError, butlerBackend: null, butlerClosing: false, butlerQuitAttempted: false, outboxClosing: false, outboxQuitFailed: false, outboxBroker: null, backgroundControl: null, tempReminders: null, tempQuitWaiting: false,
    require(name) {
      if (name === './mobile-carrier.cjs') return {
        sameBinding:require('../mobile-carrier.cjs').sameBinding,
        binding:value=>value.binding||{version:1,origin:'https://mobile.invalid',actor:'synthetic-human',port:45123,userId:'7',topologyHash:'0'.repeat(64)},
        detectRestored:async value=>{calls.push({method:'detectRestored',value});if(context.holdRecovery)await new Promise(r=>{context.releaseRecovery=r;});const next=context.recoveryErrors?.shift();if(next)throw next;if(context.recoveryFailure)throw Error('Synthetic changed topology');return {origin:'https://mobile.invalid',actor:'synthetic-human',port:45123};},
        detect: async value => { calls.push({ method: 'detectCarrier', value }); if (context.carrierFailure) throw Object.assign(Error('Synthetic unavailable carrier'), { code: 'MOBILE_SHARED_HOST',otherPorts:context.carrierPorts }); return { origin: 'https://mobile.invalid', actor: 'synthetic-human', port: 45123 }; }
      };
      if (name === './mobile-qr.cjs') return { generate: async link => { assert.ok(link.startsWith('https://mobile.invalid/mobile/#pair=')); if (context.qrFailure) throw Error('Synthetic local image failure'); calls.push({ method: 'localQR' }); return 'data:image/png;base64,c3ludGhldGlj'; } };
      if (name === './mobile-broker.cjs') return { MobileBroker: Broker };
      if (name === './mobile-pairing-store.cjs') return {PairingStore:class{constructor(root,options){this.options=options;}},keychainAdapter:()=>({get(){assert.fail('No real Keychain in Main fixture');}})};
      if (name === './mobile-workspace.cjs') return require('../mobile-workspace.cjs');
      if (name === './mobile-http.cjs') return { createMobileHandler(value) { calls.push({ method: 'fixedHandler', origin: value.origin, actor: value.actor }); return () => {}; } };
      if (name === 'node:http') return { createServer(options) { calls.push({ method: 'constructHTTP', options }); const server = new Server(); servers.push(server); return server; } };
      assert.fail('Unexpected Main dependency: ' + name);
    },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, windows: new Map(), trusted: value => value === 'https://ui.invalid/',
    viewStore: { loaded: true }, saveViews() { calls.push({ method: 'saveViews' }); if (context.saveFailure) throw Error('Synthetic view save failed'); },
    dsh: { stop() { calls.push({ method: 'stopUI' }); } }, app: { on(name, handler) { assert.equal(name, 'before-quit'); quit = handler; } },
  });
  vm.runInContext('let personActions = null;\n' + source.slice(source.indexOf('function recordPersonAction('), source.indexOf('function observePersonActions(')), context);
  vm.runInContext(source.slice(source.indexOf('let mobileBroker;'), source.indexOf('const startupFile =')), context);
  vm.runInContext(source.slice(source.indexOf('function register('), source.indexOf('async function boot(')), context);
  vm.runInContext(source.slice(source.indexOf('function isCurrentHumanContext('), source.indexOf('function showDialog(')), context);
  const start = source.indexOf("register('mobilePairing'");
  vm.runInContext(source.slice(start, source.indexOf("register('readingState'", start)), context);
  vm.runInContext(source.slice(source.lastIndexOf("app.on('before-quit'"), source.indexOf('// Deliberately no native shutdown')), context);
  const frame = { url: 'https://ui.invalid/' }, sender = { id: 7, mainFrame: frame }; context.windows.set(7, { win: { webContents: { id: 7 }, isDestroyed: () => false, getBounds: () => ({}) }, view: {} });
  const selection = { actor: 'synthetic-human', origin: 'https://mobile.invalid', selection: [{ sessionId: 'a', actions: ['read'] }], replace: false, port: 0, carrierConfirmed: true };
  context.Date = { now: () => context.now };
  const fire = () => { const due = [...timers]; timers.clear(); for (const [, timer] of due) timer.fn(); };
  return { context, calls, handlers, servers, timers, fire, selection, releasePair: () => releasePair(), quit: event => quit(event), event: { sender, senderFrame: frame } };
}
for (const method of ['mobilePairing', 'mobileRevoke', 'mobileDetect', 'mobileConnect','mobileResume','mobileCancelSetup', 'mobileSetupStatus', 'mobileApprovalStatus', 'mobileApprovalBegin', 'mobileApprovalConfirm', 'mobileApprovalEnable', 'mobileApprovalRevoke']) test(`${method} refuses an agent context before any mobile authority or listener change`, async () => {
  const f = fixture(); f.context.windows.get(7).background = true;
  const result = await f.handlers.get('workspace:' + method)(f.event, f.selection);
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.servers.length, 0);
});
test('mobile pairing and revocation are absent from the agent control catalog and invocation handlers', () => {
  const f = fixture(), { BackgroundControl } = require('../background-control.cjs');
  const methods = BackgroundControl.prototype.catalog.call({ handlers: f.context.applicationHandlers }).map(row => row.method);
  for (const method of ['mobilePairing', 'mobileRevoke', 'mobileDetect', 'mobileConnect','mobileResume','mobileCancelSetup', 'mobileSetupStatus', 'mobileApprovalStatus', 'mobileApprovalBegin', 'mobileApprovalConfirm', 'mobileApprovalEnable', 'mobileApprovalRevoke']) {
    assert.equal(methods.includes(method), false);
    assert.equal(f.context.applicationHandlers.has(method), false);
  }
});
test('one-step connection uses twice-verified native carrier metadata and returns pixels without the bearer link', async () => {
  const f=fixture(), result=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});
  assert.equal(result.ok,true);assert.ok(result.value.qr.startsWith('data:image/png;base64,'));
  assert.equal(Object.hasOwn(result.value,'secret'),false);assert.equal(f.calls.filter(x=>x.method==='detectCarrier').length,2);
  const pair=f.calls.find(x=>x.method==='pair');assert.equal(pair.selection.all,true);assert.equal(pair.selection.selection,undefined);
  assert.equal(pair.selection.actor,'synthetic-human');assert.equal(pair.selection.origin,'https://mobile.invalid');
});
test('caller supplied identity or a refused carrier cannot begin an authority or listener', async () => {
  const f=fixture();let r=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false,actor:'other'});assert.equal(r.ok,false);assert.deepEqual(f.calls,[]);
  f.context.carrierFailure=true;r=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});assert.equal(r.ok,false);assert.equal(f.calls.some(x=>x.method==='pair'),false);assert.equal(f.servers.length,0);
});
test('the legacy selected-pairing API cannot inject the internal all-scope flag', async () => {
  const f=fixture();
  for (const value of [{...f.selection,all:true},Object.assign(Object.create({all:true}),f.selection)]) {
    const result=await f.handlers.get('workspace:mobilePairing')(f.event,value);
    assert.equal(result.ok,false);assert.deepEqual(f.calls,[]);assert.equal(f.servers.length,0);
  }
});
test('local code generation failure revokes only the new candidate and closes its listener', async () => {
  const f=fixture();f.context.qrFailure=true;const r=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});assert.equal(r.ok,false);assert.ok(f.calls.some(x=>x.method==='cancelCandidate'));assert.equal(f.calls.some(x=>x.method==='revoke'),false);assert.equal(f.servers[0].listening,false);
});
test('replacement reuses the exact private listener and QR failure does not disconnect the existing phone',async()=>{
 const f=fixture();await f.handlers.get('workspace:mobilePairing')(f.event,f.selection);f.context.activeUntil=f.context.now+604800000;f.context.qrFailure=true;
 const result=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false,replace:true});assert.equal(result.ok,false);assert.equal(f.servers.length,1);assert.equal(f.servers[0].listening,true);assert.equal(f.calls.some(x=>x.method==='closeHTTP'),false);assert.equal(f.calls.some(x=>x.method==='revoke'),false);
});
test('only the matching current QR setup can be cancelled through the desktop-only method',async()=>{
 const f=fixture(),connected=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});assert.equal(connected.ok,true);
 const wrong=await f.handlers.get('workspace:mobileCancelSetup')(f.event,{setupId:'22222222-2222-4222-8222-222222222222'});assert.equal(wrong.ok,true);assert.equal(wrong.value.cancelled,false);
 const result=await f.handlers.get('workspace:mobileCancelSetup')(f.event,{setupId:connected.value.setupId});assert.equal(result.ok,true);assert.equal(result.value.cancelled,true);
});
test('candidate completion rechecks the originating human window as well as current carrier metadata',async()=>{
 const f=fixture(),connected=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});assert.equal(connected.ok,true);assert.equal(await f.context.broker.validate(),true);
 f.context.windows.delete(7);assert.equal(await f.context.broker.validate(),false);
});
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
test('quit first saves views, then pauses while exclusivity is still valid, and never calls native shutdown', () => {
  const f = fixture(); f.context.appMobileBroker();
  f.quit({ preventDefault() { assert.fail('Valid view save must not cancel quit'); } });
  assert.deepEqual(f.calls.map(call => call.method), ['construct', 'saveViews', 'pause', 'stopUI']);
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
test('preload exposes explicit desktop-only mobile management methods', async () => {
  const preload = fs.readFileSync(require.resolve('../preload.cjs'), 'utf8'), calls = []; let api;
  vm.runInNewContext(preload, { require(name) { assert.equal(name, 'electron'); return {
    // The preload also exposes the DSH locale bridge; only the workspace API is under test.
    contextBridge: { exposeInMainWorld(key, value) { assert.ok(['workspace', '__DSH_LOCALE__'].includes(key), key); if (key === 'workspace') api = value; } },
    ipcRenderer: { on() {}, invoke: async (...args) => { calls.push(args); return { ok: true, value: 'synthetic-result' }; } },
  }; } });
  assert.deepEqual(Object.keys(api).filter(key => key.startsWith('mobile')).sort(), ['mobileApprovalBegin', 'mobileApprovalConfirm', 'mobileApprovalEnable', 'mobileApprovalRevoke', 'mobileApprovalStatus','mobileCancelSetup', 'mobileConnect', 'mobileDetect', 'mobilePairing','mobileResume', 'mobileRevoke', 'mobileSetupStatus']);
  assert.equal(await api.mobileRevoke(), 'synthetic-result'); assert.deepEqual(calls, [['workspace:mobileRevoke']]);
});
test('the existing GUI payload list includes the app-local broker and its existing authority modules without running a package build', () => {
  const recipe = fs.readFileSync(require.resolve('../../scripts/package-mac.cjs'), 'utf8');
  const start = recipe.indexOf('const sources = ['), end = recipe.indexOf('for (const name of sources)', start);
  assert.ok(start > 0 && end > start);
  const names = vm.runInNewContext(recipe.slice(start, end) + ';sources');
  for (const name of ['mobile-broker.cjs', 'mobile-consent.cjs','mobile-pairing-store.cjs','mobile-pairing-keychain.jxa', 'mobile-web/passkeys.js', 'mobile-access.cjs', 'mobile-session.cjs', 'mobile-receipts.cjs', 'mobile-http.cjs', 'mobile-workspace.cjs', 'mobile-web/workspace.js', 'mobile-web/index.html', 'mobile-web/client.js', 'mobile-web/style.css']) {
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
  const week = 7 * 24 * 3600000, before = revokes();
  f.context.openUntil = f.context.now + week; f.context.broker.options.changed(); assert.equal(only(f).ms, 60000);
  f.context.now += 13 * 3600000; f.fire(); assert.equal(revokes(), before); assert.equal(server.listening, true, 'Still open past the former twelve hours');
  assert.equal(only(f).ms, 60000); f.context.now += week; f.context.openUntil = 0;
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
test('quitting with an open listener pauses access and closes the listener before the frontend stops', async () => {
  const { f, server } = await opened(); f.quit({ preventDefault() { assert.fail('Valid view save must not cancel quit'); } });
  assert.equal(server.listening, false); assert.equal(f.timers.size, 0);
  const order = f.calls.map(call => call.method).filter(m => ['saveViews', 'pause', 'stopUI'].includes(m)).slice(-3);
  assert.deepEqual(order, ['saveViews', 'pause', 'stopUI']);assert.equal(f.calls.some(c=>c.method==='revoke'),false);
});
test('saved pairing restores only after two fresh carrier checks and an exact endpoint match',async()=>{
 const f=fixture();f.context.savedEndpoint={origin:'https://mobile.invalid',actor:'synthetic-human',port:45123,binding:{version:1,origin:'https://mobile.invalid',actor:'synthetic-human',port:45123,userId:'7',topologyHash:'0'.repeat(64)}};
 const result=await f.handlers.get('workspace:mobileResume')(f.event,{sharedHostConfirmed:false});
 assert.equal(result.ok,true);assert.equal(result.value.restored,true);assert.equal(f.calls.filter(c=>c.method==='detectCarrier').length,2);
 assert.equal(f.calls.some(c=>c.method==='pair'||c.method==='localQR'),false);assert.equal(f.servers[0].options.host,'127.0.0.1');
});
test('an approved saved shared-host binding restores on boot without issuing another QR or general confirmation',async()=>{
 const f=fixture();f.context.savedEndpoint={origin:'https://mobile.invalid',actor:'synthetic-human',port:45123,binding:{version:1,origin:'https://mobile.invalid',actor:'synthetic-human',port:45123,userId:'7',topologyHash:'0'.repeat(64)}};
 f.context.carrierFailure=true;await f.context.resumeAppMobileOnBoot();
 assert.equal(f.calls.filter(c=>c.method==='resume').length,1);assert.equal(f.calls.filter(c=>c.method==='detectRestored').length,2);
 assert.equal(f.calls.some(c=>['detectCarrier','pair','localQR'].includes(c.method)),false);
 assert.equal(f.servers[0].options.host,'127.0.0.1');
});
test('changed recovery topology never opens a listener or silently retries with sharedHostConfirmed',async()=>{
 const f=fixture();f.context.savedEndpoint={origin:'https://mobile.invalid',actor:'synthetic-human',port:45123,binding:{}};f.context.recoveryFailure=true;
 await f.context.resumeAppMobileOnBoot();assert.equal(f.servers.length,0);assert.equal(f.calls.some(c=>['resume','detectCarrier','pair','localQR'].includes(c.method)),false);
});
test('shared-host restore requires this call confirmation and cannot write trust or issue a QR',async()=>{
 const f=fixture();f.context.savedEndpoint={origin:'https://mobile.invalid',actor:'synthetic-human',port:45123};f.context.carrierFailure=true;
 const result=await f.handlers.get('workspace:mobileResume')(f.event,{sharedHostConfirmed:false});assert.equal(result.ok,false);
 assert.equal(f.calls.some(c=>c.method==='resume'||c.method==='pair'),false);assert.equal(f.servers.length,0);
 assert.equal(f.calls.find(c=>c.method==='detectCarrier').value.sharedHostConfirmed,false);
});
test('a logout grace check that finds access open again keeps watching instead of stopping', async () => {
  const { f, server, revokes } = await opened(); f.context.openUntil = 0; f.context.broker.options.changed();
  f.context.openUntil = f.context.now + 120000; const before = revokes(); f.fire();
  assert.equal(revokes(), before); assert.equal(server.listening, true); assert.equal(only(f).ms, 60000);
});

test('closing an owning human window cancels only its candidate and clears the window-only identity',async()=>{const f=fixture(),connected=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});assert.equal(connected.ok,true);const c=f.context.windows.get(7);assert.equal(c.mobileSetupId,connected.value.setupId);f.context.closeAppMobileSetup(c);assert.equal(c.mobileSetupId,null);assert.equal(f.context.broker.setupId,null);assert.equal(f.calls.filter(x=>x.method==='revoke').length,0);});

test('shared-host IPC exposes only bounded numeric ports, never raw carrier text',async()=>{const f=fixture();f.context.carrierFailure=true;f.context.carrierPorts=[443,8443,443,'PRIVATE_CARRIER_TEXT',-1,65536];const result=await f.handlers.get('workspace:mobileConnect')(f.event,{sharedHostConfirmed:false});assert.equal(result.ok,false);assert.equal(result.uiMessage.key,'error.mobile.sharedHostPorts');assert.equal(result.uiMessage.params.ports,'443, 8443');assert.ok(!JSON.stringify(result).includes('PRIVATE_CARRIER_TEXT'));assert.equal(f.servers.length,0);});

test('boot recovery failures log only a fixed phase, category and elapsed time',async()=>{
 const f=fixture(),logs=[];f.context.console={warn:v=>logs.push(v)};await f.context.resumeAppMobileOnBoot();
 assert.equal(logs.length,1);assert.match(logs[0],/^\[mobile-pairing\] boot unavailable [0-9]+ms$/);
 assert.equal(logs[0].includes('/synthetic'),false);
});
test('quit drops live mobile authority before asynchronously settling persistence',async()=>{
 const f=fixture();f.context.appMobileBroker();let release,quits=0,prevented=0;
 f.context.broker.settlePersistence=()=>new Promise(r=>{release=r;});f.context.app.quit=()=>quits++;
 f.quit({preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(f.calls.filter(v=>v.method==='pause').length,1);assert.equal(quits,0);
 await new Promise(setImmediate);release();await new Promise(setImmediate);assert.equal(quits,1);
});

test('the production Main factory selects asynchronous persistence without calling a helper at construction',()=>{
 const f=fixture();f.context.appMobileBroker();assert.equal(f.context.broker.options.persistence.options.asynchronous,true);
});

// The person, 2026-11-23: after a power cut the phone stayed disconnected until someone clicked on the Mac. Boot
// recovery now waits for a carrier that is still starting, and says why it stopped otherwise.
const carrierModule = require('../mobile-carrier.cjs');
const notReady = () => { try { carrierModule.inspect({ BackendState: 'Starting' }, {}); } catch (error) { return error; } };
const changed = () => { try { carrierModule.inspectRestored({ BackendState: 'Running', Self: { DNSName: 'demo.example.ts.net.', UserID: 8 }, User: { 8: { LoginName: 'synthetic-human' } } },
  { TCP: { 10000: { HTTPS: true } }, Web: { 'demo.example.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:45123' } } } } }, savedBinding()); } catch (error) { return error; } };
const savedBinding = () => ({ version: 1, origin: 'https://mobile.invalid', actor: 'synthetic-human', port: 45123, userId: '7', topologyHash: '0'.repeat(64) });
function bootFixture() {
  const f = fixture(), logs = [];
  f.context.savedEndpoint = { origin: 'https://mobile.invalid', actor: 'synthetic-human', port: 45123, binding: savedBinding() };
  f.context.console = { warn: value => logs.push(value.replace(/ [0-9]+ms$/, '')) };
  const settle = () => new Promise(setImmediate);
  const fireRetry = async () => { const due = [...f.timers]; f.timers.clear(); for (const [, t] of due) t.fn(); await settle(); };
  const delays = () => [...f.timers.values()].map(t => t.ms);
  const status = async () => (await f.handlers.get('workspace:mobileApprovalStatus')(f.event)).value;
  const restored = () => f.calls.filter(c => c.method === 'detectRestored').length;
  return { ...f, logs, settle, fireRetry, delays, status, restored };
}
test('a carrier that is still starting at boot is waited for, then the full checks open the listener', async () => {
  const f = bootFixture(); f.context.recoveryErrors = [notReady(), notReady()];
  await f.context.resumeAppMobileOnBoot();
  assert.equal(f.servers.length, 0); assert.deepEqual(f.delays(), [5000]);
  assert.equal((await f.status()).resumeReason, 'not-ready'); assert.equal((await f.status()).resumeRequired, true);
  await f.fireRetry(); assert.equal(f.servers.length, 0); assert.deepEqual(f.delays(), [10000]);
  await f.fireRetry();
  assert.equal(f.servers.length, 1); assert.equal(f.servers[0].options.host, '127.0.0.1'); assert.equal(f.servers[0].listening, true);
  assert.equal(f.calls.filter(c => c.method === 'resume').length, 1); assert.equal(f.restored(), 4, 'two carrier checks on the attempt that opened');
  assert.equal(f.calls.some(c => ['detectCarrier', 'pair', 'localQR'].includes(c.method)), false);
  assert.equal((await f.status()).resumeReason, undefined);
  assert.deepEqual(f.logs, ['[mobile-pairing] boot not-ready', '[mobile-pairing] boot-retry ok']);
});
test('a changed carrier binding is not retried: no listener, and the person is told to pair again', async () => {
  const f = bootFixture(); f.context.recoveryErrors = [changed()];
  await f.context.resumeAppMobileOnBoot();
  assert.equal(f.servers.length, 0); assert.deepEqual(f.delays(), []);
  const value = await f.status();
  assert.equal(value.resumeRequired, false); assert.equal(value.reconnectRequired, true); assert.equal(value.resumeReason, 'changed');
  assert.deepEqual(f.logs, ['[mobile-pairing] boot changed']);
});
test('an expired or unbound saved pairing is not retried even when the carrier is also starting', async () => {
  for (const blocker of ['expired', 'unbound', 'refused']) {
    const f = bootFixture(); f.context.blocker = blocker; f.context.recoveryErrors = [notReady()];
    await f.context.resumeAppMobileOnBoot();
    assert.equal(f.servers.length, 0, blocker); assert.deepEqual(f.delays(), [], blocker); assert.deepEqual(f.logs, ['[mobile-pairing] boot ' + blocker]);
  }
});
test('a port taken by another program is not retried and names the port', async () => {
  const f = bootFixture(); f.context.listenFailure = true; f.context.listenCode = 'EADDRINUSE';
  await f.context.resumeAppMobileOnBoot();
  assert.deepEqual(f.delays(), []); assert.equal(f.calls.some(c => c.method === 'resume'), false);
  const value = await f.status(); assert.equal(value.resumeReason, 'port-in-use'); assert.equal(value.resumePort, 45123); assert.equal(value.resumeRequired, true);
});
test('without a saved authority file boot does nothing, as before', async () => {
  const f = bootFixture(); f.context.fs = { existsSync: () => false };
  await f.context.resumeAppMobileOnBoot();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.delays(), []); assert.deepEqual(f.logs, []);
});
test('the backoff doubles from five seconds and stays at one minute, and only a changed reason is logged again', async () => {
  const f = bootFixture(); f.context.recoveryErrors = Array.from({ length: 8 }, notReady);
  await f.context.resumeAppMobileOnBoot(); const seen = [...f.delays()];
  for (let i = 0; i < 7; i++) { await f.fireRetry(); seen.push(...f.delays()); }
  assert.deepEqual(seen, [5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000]);
  assert.equal(f.restored(), 8); assert.deepEqual(f.logs, ['[mobile-pairing] boot not-ready']);
  f.context.recoveryErrors = [changed()]; await f.fireRetry();
  assert.deepEqual(f.delays(), []); assert.deepEqual(f.logs, ['[mobile-pairing] boot not-ready', '[mobile-pairing] boot-retry changed']);
});
test('a manual restore, revoke or quit while waiting cancels the pending retry', async () => {
  for (const act of ['manual', 'revoke', 'quit']) {
    const f = bootFixture(); f.context.recoveryErrors = [notReady()];
    await f.context.resumeAppMobileOnBoot(); assert.deepEqual(f.delays(), [5000], act);
    if (act === 'manual') { f.context.carrierFailure = false; assert.equal((await f.handlers.get('workspace:mobileResume')(f.event, { sharedHostConfirmed: false })).ok, true); }
    if (act === 'revoke') f.context.revokeAppMobile();
    if (act === 'quit') f.quit({ preventDefault() {} });
    const before = f.restored(), servers = f.servers.length; await f.fireRetry();
    assert.equal(f.restored(), before, act); assert.equal(f.servers.length, servers, act);
    if (act !== 'quit') assert.equal((await f.status()).resumeReason, undefined, act);
    else assert.equal((await f.handlers.get('workspace:mobileApprovalStatus')(f.event)).ok, false, 'no status while quitting');
  }
});
test('a revoke during an attempt keeps a late "not ready" answer from scheduling another', async () => {
  const f = bootFixture(); f.context.holdRecovery = true; f.context.recoveryErrors = [notReady()];
  const attempt = f.context.resumeAppMobileOnBoot(); await f.settle();
  f.context.revokeAppMobile(); f.timers.clear(); f.context.releaseRecovery(); await attempt;
  assert.deepEqual(f.delays(), []); assert.equal(f.servers.length, 0); assert.deepEqual(f.logs, []);
});
test('a saved-pairing reason seen at boot is not shown once the broker says the pairing can resume', async () => {
  const f = bootFixture(); f.context.blocker = 'refused'; f.context.recoveryErrors = [notReady()];
  await f.context.resumeAppMobileOnBoot();
  assert.deepEqual(f.delays(), []); assert.deepEqual(f.logs, ['[mobile-pairing] boot refused']);
  f.context.blocker = null;
  const value = await f.status(); assert.equal(value.resumeRequired, true); assert.equal(value.resumeReason, undefined);
});
test('a person\'s action while the attempt is still preparing is newer, even when the attempt fails before its own step', async () => {
  const f = bootFixture(); f.context.holdPrepare = true;
  const attempt = f.context.resumeAppMobileOnBoot(); await f.settle();
  f.context.revokeAppMobile(); f.context.savedEndpoint = null; f.context.releasePrepare(); await attempt;
  assert.deepEqual(f.delays(), []); assert.deepEqual(f.logs, []); assert.equal((await f.status()).resumeReason, undefined);
});
test('waking from sleep runs a pending retry at once and starts its backoff over', async () => {
  const f = bootFixture(); f.context.recoveryErrors = Array.from({ length: 4 }, notReady);
  await f.context.resumeAppMobileOnBoot(); await f.fireRetry(); await f.fireRetry(); assert.deepEqual(f.delays(), [20000]);
  f.context.wakeAppMobileResume(); await f.settle();
  assert.equal(f.restored(), 4); assert.deepEqual(f.delays(), [10000]);
  f.context.wakeAppMobileResume(); await f.settle(); assert.equal(f.servers.length, 1);
  f.context.wakeAppMobileResume(); await f.settle(); assert.equal(f.restored(), 6, 'nothing pending after the listener opened');
});
