const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const os = require('node:os');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const a = source.indexOf("app.on('before-quit', event => {"), b = source.indexOf('// Deliberately no native shutdown', a);
assert.ok(a >= 0 && b > a);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(close) {
  let listener, stops = 0, quits = 0, calls = 0; const scheduled = [];
  const context = vm.createContext({ setImmediate(callback) { scheduled.push(callback); }, app: { on(name, cb) { assert.equal(name, 'before-quit'); listener = cb; }, quit() { quits++; } },
    viewStore: undefined, windows: new Map(), saveViews() { throw Error('No GUI or view write in this test'); },
    dsh: { stop() { stops++; } }, backgroundControl: undefined, outboxBroker: close && { close() { calls++; return close(); } }, outboxUnavailable: false });
  vm.runInContext('let quitting=false, outboxClosing=false, outboxQuitFailed=false;\n' + source.slice(a, b), context);
  return { attempt() { let prevented = false; listener({ preventDefault() { prevented = true; } }); return prevented; }, facts: () => ({ stops, quits, calls }), advanceLoop() { for (const callback of scheduled.splice(0)) callback(); } };
}
test('failed owned outbox cleanup retains the frontend; a later explicit quit proceeds without replaying failed cleanup', async () => {
  const f = fixture(async () => { throw Error('Owned cleanup unconfirmed'); });
  assert.equal(f.attempt(), true); await tick(); assert.deepEqual(f.facts(), { stops: 0, quits: 0, calls: 1 });
  assert.equal(f.attempt(), false); await tick(); assert.deepEqual(f.facts(), { stops: 1, quits: 0, calls: 1 });
});
test('actual broker cached cleanup rejection cannot trap repeated explicit application quit requests', async t => {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-quit-')); fs.chmodSync(profile, 0o700);
  const descriptorFile = path.join(profile, 'owner.json');
  const broker = await createOutboxBroker({ descriptorFile, bind: async () => { throw Error('No native call'); }, createView: async () => { throw Error('No GUI'); } });
  const info = JSON.parse(fs.readFileSync(descriptorFile)), directory = path.dirname(info.socketPath), identity = fs.lstatSync(directory);
  t.after(async () => { await broker.close().catch(() => {}); const current = fs.lstatSync(directory); assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev); fs.rmSync(directory, { recursive: true }); fs.rmSync(profile, { recursive: true }); });
  fs.unlinkSync(descriptorFile); // Actual close will fail at its descriptor check.
  const f = fixture(() => broker.close()); assert.equal(f.attempt(), true);
  await broker.close().catch(() => {}); await tick(); assert.deepEqual(f.facts(), { stops: 0, quits: 0, calls: 1 });
  assert.equal(f.attempt(), false); assert.deepEqual(f.facts(), { stops: 1, quits: 0, calls: 1 });
});
test('repeated quit during pending cleanup cannot bypass cleanup or stop the frontend early', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; }), f = fixture(() => pending);
  assert.equal(f.attempt(), true); assert.equal(f.attempt(), true);
  await tick(); assert.deepEqual(f.facts(), { stops: 0, quits: 0, calls: 1 });
  release(); await tick(); assert.deepEqual(f.facts(), { stops: 1, quits: 0, calls: 1 }, 'Final quit must wait until Electron unwinds the prevented close event');
  f.advanceLoop(); assert.deepEqual(f.facts(), { stops: 1, quits: 1, calls: 1 });
});
test('normal quit without an outbox preserves the existing frontend shutdown path', () => {
  const f = fixture(null); assert.equal(f.attempt(), false); assert.deepEqual(f.facts(), { stops: 1, quits: 0, calls: 0 });
});
