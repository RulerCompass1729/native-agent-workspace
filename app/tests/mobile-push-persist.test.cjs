const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
const { MobileAccess, SESSION_MS } = require('../mobile-access.cjs'), { PairingStore } = require('../mobile-pairing-store.cjs');
const { PushStore } = require('../mobile-push.cjs');
const actor = 'synthetic-human', origin = 'https://phone.example.test';
function fixture(t, asynchronous = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-b-push-')), owned = fs.statSync(root), values = new Map(), clients = [], brokers = [], stores = [], messages = [], expectedStoreFailures = new Set(), expectedRevokeFailures = new Set();
  const clock = { now: Date.now() }; let identity = 0, failure = false, code = 201;
  const memory = { get: a => structuredClone(values.get(a) ?? null), put(a, v) { if (failure) throw Error('Synthetic Keychain unavailable'); values.set(a, structuredClone(v)); } };
  const adapter = asynchronous ? require('../mobile-pairing-store.cjs').keychainAdapter({ platform: 'darwin', run(_bin, _args, options, done) {
    const request = JSON.parse(options.input);
    queueMicrotask(() => { try { const value = request.action === 'get' ? memory.get(request.account) : (memory.put(request.account, request.value), null); done(null, JSON.stringify({ value })); } catch { done(Error('Synthetic Keychain failure')); } });
    return { stdin: { end() {} } };
  } }) : memory;
  const record = { id: 'member', nativeId: 'native', provider: 'claude', state: 'idle', messages: [] }, entries = [{ key: '.', state: { capabilities: ['humanMobileV1', 'humanMobilePreparedV1'], sessions: [record] } }];
  class Access extends MobileAccess { constructor(r, options) { super(r, { ...options, now: () => clock.now, identity: { pid: process.pid, started: 'synthetic-' + ++identity } }); } }
  class Client extends EventEmitter { constructor() { super(); this.scope = root; this.entries = entries; this.closing = false; this.socket = { destroyed: false }; clients.push(this); } close() { this.closing = true; this.socket.destroyed = true; this.emit('closed'); } async refresh() {} }
  const file = require.resolve('../mobile-broker.cjs'), req = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, process, Buffer, URL, structuredClone, require(name) {
    if (name === './mobile-access.cjs') return { MobileAccess: Access, SESSION_MS };
    if (name === './workspace-client.cjs') return { WorkspaceClient: Client };
    if (name === './service-client.cjs') return { connect: async () => new Client() };
    return req(name);
  } });
  const desktop = { grant: (_c, g) => structuredClone(g), records: { status: () => ({ count: 3 }) } };
  const endpoint = { actor, origin, port: 48765, binding: { version: 1, actor, origin, port: 48765, userId: '7', topologyHash: '0'.repeat(64) } };
  function create() {
    const persistence = PushStore ? new PushStore(root, { adapter, now: () => clock.now }) : undefined; if (persistence) stores.push(persistence);
    const broker = new module.exports.MobileBroker(root, { exclusive: () => true, desktop, persistence: new PairingStore(root, { adapter, asynchronous }),
      pushOptions: { persistence, now: () => clock.now, transport: async (details, guard) => { assert.equal(guard.valid(), true); messages.push(details); return code; } } });
    broker.setEndpoint(endpoint); brokers.push(broker); return broker;
  }
  const first = create();
  async function pair(b = first) { const c = await b.beginCandidate({ actor, origin, replace: true }), p = await b.pair({ secret: c.secret, actor, origin }), a = { token: p.cookieValue, actor, origin }; a.csrf = b.session(a).csrf; await b.activateCandidate(a, { mode: 'basic' }); return a; }
  function subscription() { const dh = crypto.createECDH('prime256v1'); dh.generateKeys(); return { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null, keys: { p256dh: dh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }; }
  async function enable(b, a, sub = subscription()) { const info = b.pushInfo(a); await b.pushAction(a, { action: 'subscribe', subscription: sub }); await b.refreshPush(); return { info, sub }; }
  async function restart(b = first) { b.suspend(); await b.settlePersistence(true); const next = create(); await next.resume(async () => true); return next; }
  t.after(async () => { failure = false; for (const b of brokers) { if (expectedRevokeFailures.has(b)) await assert.rejects(() => b.revoke()); else await b.revoke(); } for (const s of stores) { if (expectedStoreFailures.has(s)) await assert.rejects(s.flush()); else await s.flush(); } const end = fs.statSync(root); assert.deepEqual([end.uid,end.dev,end.ino],[owned.uid,owned.dev,owned.ino]); fs.rmSync(root, { recursive: true }); });
  return { root, first, create, pair, enable, restart, clients, messages, values, stores, clock, adapter, expectedStoreFailures, expectedRevokeFailures, status: v => { code = v; }, fail: v => { failure = v; } };
}
test('same pairing restores its subscription and the original public key after a process lifetime ends', async t => {
  const f = fixture(t), a = await f.pair(), { info } = await f.enable(f.first, a), before = f.messages.length;
  const next = await f.restart(); a.csrf = next.session(a).csrf;
  assert.equal(next.pushInfo(a).enabled, true); assert.equal(next.pushInfo(a).publicKey, info.publicKey);
  await next.refreshPush(); assert.ok(f.messages.length > before, 'a restored sender works without tapping enable again');
});
test('subscription endpoint is private on disk; VAPID and browser auth secrets stay in the fake Keychain', async t => {
  const f = fixture(t), a = await f.pair(), { sub } = await f.enable(f.first, a), file = path.join(f.root, 'mobile-push.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const disk = fs.readFileSync(file, 'utf8'); assert.ok(disk.includes(sub.endpoint)); assert.equal(disk.includes(sub.keys.auth), false);
  const saved = [...f.values.values()].find(v => v?.vapid); assert.ok(saved); assert.equal(disk.includes(saved.vapid.privateKey), false);
});
test('disconnect does not prevent authenticated unsubscribe or let a restart resurrect it', async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); f.clients.at(-1).close();
  const out = await f.first.pushAction(a, { action: 'unsubscribe' }); assert.equal(out.enabled, false);
  const before = f.messages.length; await f.first.refreshPush(); assert.equal(f.messages.length, before);
  const next = await f.restart(); a.csrf = next.session(a).csrf; assert.equal(next.pushInfo(a).enabled, false);
  assert.equal([...f.values.values()].some(v => v?.vapid), false);
});
test('offline disable still requires the same pairing, actor, Origin and CSRF', async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); f.clients.at(-1).close();
  for (const bad of [{ ...a, token: 'x'.repeat(43) }, { ...a, csrf: 'x'.repeat(43) }, { ...a, actor: 'other' }, { ...a, origin: 'https://other.invalid' }])
    await assert.rejects(async () => f.first.pushAction(bad, { action: 'unsubscribe' }));
  await f.first.refreshSession(a); assert.equal(f.first.pushInfo(a).enabled, true);
});
for (const end of ['logout', 'revoke', 'replacement', 'expiry']) test('push credentials die with the pairing: ' + end, async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a);
  if (end === 'logout') await f.first.logout(a);
  if (end === 'revoke') await f.first.revoke();
  if (end === 'replacement') { const other = await f.pair(); assert.equal(f.first.pushInfo(other).enabled, false); }
  if (end === 'expiry') { f.clock.now += SESSION_MS + 1; await f.first.refreshPush(); }
  await f.first.settlePersistence();
  assert.equal([...f.values.values()].some(v => v?.vapid), false);
  const file = path.join(f.root, 'mobile-push.json'); if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8').includes('web.push.apple.com'), false);
});
for (const damage of ['permissions', 'symlink', 'mismatched-key', 'missing-key']) test('damaged saved push cannot enable itself or break pairing recovery: ' + damage, async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); f.first.suspend(); await f.first.settlePersistence(true);
  const file = path.join(f.root, 'mobile-push.json');
  if (damage === 'permissions') fs.chmodSync(file, 0o644);
  if (damage === 'symlink') { fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
  if (damage === 'mismatched-key') for (const [k,v] of f.values) if (v?.vapid) f.values.set(k, { ...v, descriptor: '0'.repeat(64) });
  // The missing push entry leaves the independently validated pairing record intact.
  if (damage === 'missing-key') for (const [k,v] of f.values) if (v?.vapid) f.values.set(k, null);
  const next = f.create(); await next.resume(async () => true); a.csrf = next.session(a).csrf;
  assert.equal(next.pushInfo(a).enabled, false);
  if (damage === 'permissions') fs.chmodSync(file, 0o600);
  if (damage === 'symlink') { fs.unlinkSync(file); fs.renameSync(file + '.original', file); }
});

test('a stale suspended issuer cannot clear the current issuer push credentials', async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); const next = await f.restart(); a.csrf = next.session(a).csrf;
  await f.first.revoke();
  assert.equal(next.pushInfo(a).enabled, true);
  assert.ok([...f.values.values()].some(v => v?.vapid));
});
test('unsubscribe invalidates a delayed subscription save before it can publish or send', async t => {
  const f = fixture(t), a = await f.pair(); f.first.pushInfo(a);
  const put = f.adapter.put; let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.adapter.put = async (account, value) => { if (value?.vapid) { entered(); await new Promise(resolve => { release = resolve; }); } return put(account, value); };
  const pending = f.first.pushAction(a, { action: 'subscribe', subscription: { endpoint: 'https://web.push.apple.com/pending', expirationTime: null, keys: (() => { const c=crypto.createECDH('prime256v1'); c.generateKeys(); return {p256dh:c.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}; })() } });
  const refusal = assert.rejects(pending); await started;
  const disabled = f.first.pushAction(a, { action: 'unsubscribe' }); release(); await refusal; assert.equal((await disabled).enabled, false);
  assert.equal(f.messages.length, 0); assert.equal([...f.values.values()].some(v => v?.vapid), false);
  const next = await f.restart(); a.csrf = next.session(a).csrf; assert.equal(next.pushInfo(a).enabled, false);
});
test('the real HTTP adapter returns the offline disable result, not an unresolved Promise', async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); f.clients.at(-1).close();
  const { createMobileHandler, COOKIE } = require('../mobile-http.cjs');
  const handler = createMobileHandler({ broker: f.first, actor, origin });
  const request = require('node:stream').Readable.from([Buffer.from(JSON.stringify({ action: 'unsubscribe' }))]);
  Object.assign(request, { method: 'POST', url: '/mobile/push', socket: { remoteAddress: '127.0.0.1' }, rawHeaders: [
    'Host', new URL(origin).host, 'Tailscale-User-Login', actor, 'Origin', origin, 'X-NAW-Mobile', '1', 'X-NAW-CSRF', a.csrf,
    'Cookie', `${COOKIE}=${a.token}`, 'Content-Type', 'application/json'] });
  const response = { setHeader() {}, end(body) { this.body = body; this.writableEnded = true; } };
  await handler(request, response);
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).enabled, false);
  assert.equal([...f.values.values()].some(v => v?.vapid), false);
});

test('the unchanged asynchronous Keychain adapter persists only through a fake helper across restart', async t => {
  const f = fixture(t, true), a = await f.pair(), { info } = await f.enable(f.first, a), next = await f.restart(); a.csrf = next.session(a).csrf;
  assert.equal(next.pushInfo(a).enabled, true); assert.equal(next.pushInfo(a).publicKey, info.publicKey);
  await next.pushAction(a, { action: 'unsubscribe' }); assert.equal([...f.values.values()].some(v => v?.vapid), false);
});
for (const expiry of ['time', 'service']) test('an expired browser subscription clears its saved credentials: ' + expiry, async t => {
  const f = fixture(t), a = await f.pair(), c = crypto.createECDH('prime256v1'); c.generateKeys();
  const sub = { endpoint: 'https://web.push.apple.com/expiring', expirationTime: f.clock.now + 1000, keys: { p256dh: c.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  if (expiry === 'service') f.status(410);
  await f.enable(f.first, a, sub);
  if (expiry === 'time') { f.clock.now += 1001; await f.first.refreshPush(); }
  await f.first.settlePersistence(); assert.equal([...f.values.values()].some(v => v?.vapid), false);
  const next = await f.restart(); a.csrf = next.session(a).csrf; assert.equal(next.pushInfo(a).enabled, false);
});
test('a saved subscription is erased at boot when its pairing expired while the app was off', async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); f.first.suspend(); await f.first.settlePersistence(true);
  f.clock.now += SESSION_MS + 1; const next = f.create(); await next.preparePersistence('boot');
  assert.equal([...f.values.values()].some(v => v?.vapid), false);
  const file = path.join(f.root, 'mobile-push.json'); assert.equal(fs.existsSync(file), false);
  await assert.rejects(next.resume(async () => true));
});
test('disable stops locally even if the Keychain is unavailable; boot later removes the orphaned secret', async t => {
  const f = fixture(t), a = await f.pair(); await f.enable(f.first, a); f.clients.at(-1).close();
  f.fail(true); const out = await f.first.pushAction(a, { action: 'unsubscribe' });
  assert.equal(out.enabled, false); assert.equal(out.storageWarning, 'MOBILE_PUSH_STORAGE_UNCONFIRMED'); f.expectedStoreFailures.add(f.stores[0]);
  const before = f.messages.length; await f.first.refreshPush(); assert.equal(f.messages.length, before);
  f.fail(false); const next = await f.restart(); a.csrf = next.session(a).csrf;
  assert.equal(next.pushInfo(a).enabled, false); assert.equal([...f.values.values()].some(v => v?.vapid), false);
});

test('C quitting keeps the existing five-second persistence deadline with slow bounded clears', async t => {
  const f = fixture(t, true), a = await f.pair(), { sub } = await f.enable(f.first, a), put = f.adapter.put.bind(f.adapter); let clears = 0;
  f.adapter.put = (account, value) => value === null ? new Promise((resolve, reject) => setTimeout(() => {
    try { clears++; resolve(put(account, value)); } catch (e) { reject(e); }
  }, 3000)) : put(account, value);
  const one = f.first.pushAction(a, { action: 'unsubscribe' });
  const middle = Promise.resolve(f.first.pushAction(a, { action: 'subscribe', subscription: sub })); middle.catch(() => {});
  const two = f.first.pushAction(a, { action: 'unsubscribe' });
  f.first.suspend(); const start = performance.now(); await f.first.settlePersistence(true); const elapsed = performance.now() - start;
  await Promise.allSettled([one, middle, two]);
  if (f.stores[0].failed) { f.expectedStoreFailures.add(f.stores[0]); f.expectedRevokeFailures.add(f.first); }
  t.diagnostic(JSON.stringify({ elapsedMs: elapsed, clears, pairingDeadlineMs: 5000, eachClearDelayMs: 3000 }));
  assert.ok(elapsed < 5200, 'quitting must retain the existing bounded persistence deadline');
});

test('pairing and push start within one common quit budget, rather than consecutive budgets', async t => {
  const f = fixture(t), { MobileBroker } = require('../mobile-broker.cjs'); let release, pairBudget, pushBudget;
  const pending = new Promise(resolve => { release = resolve; });
  const broker = new MobileBroker(f.root, { exclusive: () => true,
    persistence: { finish(ms) { pairBudget = ms; return pending; } },
    pushOptions: { persistence: { finish(ms) { pushBudget = ms; return Promise.resolve(); }, flush: () => Promise.resolve() } } });
  const finished = broker.settlePersistence(true);
  try {
    assert.ok(pairBudget > 0 && pairBudget <= 5000);
    assert.ok(pushBudget > 0 && pushBudget <= pairBudget, 'push starts before pairing finishes with only the remaining budget');
  } finally { release('ready'); }
  assert.equal(await finished, 'ready');
});

test('a quit deadline cancels owned helpers and prevents late saves or queued clears from restoring push', async t => {
  const f = fixture(t, true), a = await f.pair(); f.first.pushInfo(a);
  const put = f.adapter.put.bind(f.adapter); let release, entered, cancelled = 0, clears = 0;
  const started = new Promise(resolve => { entered = resolve; });
  f.adapter.put = async (account, value) => {
    if (value?.vapid) { entered(); await new Promise(resolve => { release = resolve; }); }
    if (value === null) clears++;
    return put(account, value);
  };
  f.adapter.cancel = () => { cancelled++; };
  const curve = crypto.createECDH('prime256v1'); curve.generateKeys();
  const pending = f.first.pushAction(a, { action: 'subscribe', subscription: { endpoint: 'https://web.push.apple.com/quit', expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });
  const rejected = assert.rejects(pending); await started;
  const disabled = f.first.pushAction(a, { action: 'unsubscribe' }); f.first.suspend();
  try {
    await assert.rejects(() => f.stores[0].finish(20));
    assert.equal(cancelled, 1); assert.equal(clears, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'mobile-push.json'))), { version: 1, enabled: false });
  } finally { release(); }
  await rejected; await disabled; f.expectedStoreFailures.add(f.stores[0]);
  assert.equal(clears, 0, 'expired queued work cannot start another helper');
  f.adapter.put = put;
  const next = f.create(); await next.resume(async () => true); a.csrf = next.session(a).csrf;
  assert.equal(next.pushInfo(a).enabled, false); assert.equal(f.messages.length, 0);
  assert.equal([...f.values.values()].some(v => v?.vapid), false, 'boot retries the disabled cleanup');
});

test('the existing Keychain adapter kills its own fake helper at the push quit deadline', async t => {
  const f = fixture(t), { keychainAdapter } = require('../mobile-pairing-store.cjs'); let started, killed = 0, active = 0;
  const entered = new Promise(resolve => { started = resolve; }), stop = new Set();
  const adapter = keychainAdapter({ platform: 'darwin', run(_bin, _args, _options, done) {
    active++; const kill = () => { if (!stop.delete(kill)) return; killed++; active--; done(Object.assign(Error('Synthetic helper cancelled'), { killed: true })); };
    stop.add(kill); started(); return { kill, stdin: { end() {} } };
  } });
  const store = new PushStore(f.root, { adapter }), clear = store.clear(), rejected = assert.rejects(clear);
  try {
    await entered; await assert.rejects(() => store.finish(20)); await rejected;
    assert.equal(killed, 1); assert.equal(active, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'mobile-push.json'))), { version: 1, enabled: false });
  } finally { for (const kill of stop) kill(); await rejected; }
});
