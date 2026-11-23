// The person, 2026-11-23: after a power cut the phone stayed disconnected until someone clicked on the Mac. The
// carrier tells "still starting" from "changed"; the broker says when a saved pairing needs a new one.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const carrier = require('../mobile-carrier.cjs'), { MobileAccess, SESSION_MS } = require('../mobile-access.cjs');
const { MobileBroker } = require('../mobile-broker.cjs'), { PairingStore } = require('../mobile-pairing-store.cjs');
const host = 'demo.example.ts.net', actor = 'synthetic-person', origin = 'https://' + host + ':10000';
const status = (extra = {}) => ({ BackendState: 'Running', Self: { DNSName: host + '.', UserID: 7, ...extra }, User: { 7: { LoginName: actor } } });
const serve = () => ({ TCP: { 10000: { HTTPS: true } }, Web: { [host + ':10000']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:48765' } } } } });
const caught = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected a refusal'); };

test('a carrier still starting, logged out, offline or not yet serving is "not ready"; the same code as before', async () => {
  const cases = [
    () => carrier.inspect({ BackendState: 'Starting' }, serve()),
    () => carrier.inspect({ BackendState: 'NeedsLogin', Self: {} }, serve()),
    () => carrier.inspect(status({ Online: false }), serve()),
    () => carrier.inspect({ BackendState: 'Running', Self: { UserID: 7 }, User: {} }, serve()),
    () => carrier.inspect(status(), {}),
  ];
  for (const fn of cases) { const error = caught(fn); assert.equal(error.code, 'MOBILE_CARRIER_UNAVAILABLE'); assert.equal(error.carrierNotReady, true); }
  for (const run of [(p, a, o, cb) => cb(Object.assign(Error('exit 1'), { code: 1 })), (p, a, o, cb) => cb(null, 'not json')]) {
    const error = await carrier.detect({}, { run, executable: () => '/synthetic/tailscale' }).catch(e => e);
    assert.equal(error.carrierNotReady, true);
  }
  assert.equal(caught(() => carrier.findExecutable({ realpathSync() { throw Error('ENOENT'); } })).carrierNotReady, true);
});

test('a changed account, an entry moved to another port, a funnel, a second entry or a bad shape is never "not ready"', () => {
  const expected = carrier.binding(carrier.inspect(status(), serve()));
  const funnel = { ...serve(), AllowFunnel: { [host + ':10000']: true } };
  const twice = serve(); twice.TCP[10001] = { HTTPS: true }; twice.Web[host + ':10001'] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:48765' } } };
  const moved = serve(); moved.Web[host + ':10000'].Handlers['/'].Proxy = 'http://127.0.0.1:50000';
  const cases = [
    () => carrier.inspect(status(), moved),
    () => carrier.inspectRestored({ ...status({ UserID: 8 }), User: { 8: { LoginName: actor } } }, serve(), expected),
    () => carrier.inspect(status(), funnel),
    () => carrier.inspect(status(), twice),
    () => carrier.inspect(status({ Tags: ['tag:server'] }), serve()),
    () => carrier.inspect(status(), serve(), { port: 80 }),
    () => carrier.inspectRestored(status(), serve(), null),
  ];
  for (const fn of cases) { const error = caught(fn); assert.equal(error.carrierNotReady, undefined, String(fn)); }
});

function saved(t, { ago = 0, bound = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-e-boot-resume-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), file = path.join(root, 'fake-keychain.json'); fs.mkdirSync(profile, { mode: 0o700 });
  const adapter = { get: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null, put(_a, v) { fs.writeFileSync(file, JSON.stringify(v), { mode: 0o600 }); } };
  const store = new PairingStore(profile, { adapter });
  const binding = bound ? carrier.binding(carrier.inspect(status(), serve())) : null;
  const details = { endpoint: { origin, actor, port: 48765, binding }, all: false, workspace: null, consent: null, consentView: false };
  const access = new MobileAccess(profile, { exclusive: () => true, now: () => Date.now() - ago, transaction: (state, save) => store.commit(state, details, save),
    pauseTransaction: (state, mirror, save) => store.pause(state, details, mirror, save), recover: c => store.take(c) });
  access.initialize();
  const c = access.beginPairing({ actor, origin, scopes: [{ serviceKey: '.', sessionId: 'synthetic', nativeId: 'native', actions: ['read'] }] });
  access.pair({ secret: c.secret, actor, origin }); access.pause();
  return new MobileBroker(profile, { exclusive: () => true, persistence: new PairingStore(profile, { adapter }) });
}
test('a saved pairing within its seven days resumes; past them, or without a carrier binding, it asks for a new pairing', t => {
  const valid = saved(t);
  assert.equal(valid.resumeBlocker(), null); assert.equal(valid.approvalStatus().resumeRequired, true); assert.equal(valid.approvalStatus().resumeReason, undefined);
  const expired = saved(t, { ago: SESSION_MS + 60000 });
  assert.equal(expired.resumeInfo(), null); assert.equal(expired.resumeBlocker(), 'expired');
  assert.deepEqual(expired.approvalStatus(), { paired: false, enabled: false, registered: false, pending: null, reconnectRequired: true, resumeReason: 'expired' });
  const unbound = saved(t, { bound: false });
  assert.notEqual(unbound.resumeInfo(), null, 'it was offered as resumable before'); assert.equal(unbound.resumeBlocker(), 'unbound');
  assert.deepEqual(unbound.approvalStatus(), { paired: false, enabled: false, registered: false, pending: null, reconnectRequired: true, resumeReason: 'unbound' });
});
test('nothing saved, or a revoked pairing, claims no reason', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-e-boot-resume-none-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = new MobileBroker(root, { exclusive: () => true, persistence: new PairingStore(root, { adapter: { get: () => null, put() {} } }) });
  assert.equal(broker.resumeBlocker(), null); assert.equal(broker.approvalStatus().resumeReason, undefined);
  assert.equal(new MobileBroker(root, { exclusive: () => true }).resumeBlocker(), null);
});

test('the phone says an expired pairing needs a new scan, and after three minutes offline where the reason is shown', () => {
  const source = fs.readFileSync(path.join(__dirname, '../mobile-web/workspace.js'), 'utf8');
  const start = source.indexOf('    let offlineSince = 0;'), end = source.indexOf('    };\n', start) + 7;
  const context = { client: { state: { session: { expiresAt: 5000 } } }, Date: { now: () => 1000 } };
  const offlineWord = new Function('client', 'Date', source.slice(start, end) + 'return { word: offlineWord, set: v => { offlineSince = v; } };')(context.client, context.Date);
  assert.equal(offlineWord.word(), 'autoReconnect');
  offlineWord.set(1); context.Date.now = () => 1 + 179999; context.client.state.session.expiresAt = 1e12; assert.equal(offlineWord.word(), 'autoReconnect');
  context.Date.now = () => 1 + 180000; assert.equal(offlineWord.word(), 'longOffline');
  context.client.state.session.expiresAt = 1000; assert.equal(offlineWord.word(), 'pairExpired');
  for (const key of ['pairExpired', 'longOffline']) for (const lang of ['zh', 'en']) assert.ok(source.includes(`words.${lang}.${key}=`), key + lang);
});

test('a wake from sleep reaches a pending restore once, registered at readiness and not on each startup retry', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const lines = main.split('\n').filter(line => line.includes('wakeAppMobileResume') && line.includes('powerMonitor'));
  assert.deepEqual(lines, ["if (primary) app.whenReady().then(() => powerMonitor.on('resume', wakeAppMobileResume));"]);
});
