const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { outboxError, classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');
const source = fs.readFileSync(require.resolve('../computer-use-outbox-owner.cjs'), 'utf8');
const start = source.indexOf('function existingTransports(contexts) {'), end = source.indexOf('\nasync function bindOriginalOutbox', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ outboxError, FAIL: source.match(/const FAIL = '([^']+)';/)[1] });
vm.runInContext(source.slice(start, end) + '\nglobalThis.existing = existingTransports;', context);
function fixture() {
  const caller = { id: 'caller', nativeId: 'native-caller', provider: 'codex', pid: 900001 };
  const socket = () => { const c = new EventEmitter(); c.socket = { destroyed: false }; return c; };
  const good = { key: 'caller-backend', client: socket(), closed: false, state: { sessions: [caller] } };
  const other = { key: 'unrelated-backend', client: socket(), closed: false, state: { sessions: [] }, confirmClosed() {} };
  const client = Object.create(WorkspaceClient.prototype);
  Object.assign(client, { entries: [good, other], control: { revision: 0, manualEpoch: 0, maintenance: new Set() }, legacyObservers: new Map(), socket: { destroyed: false }, closing: false, emit() {} });
  const view = { win: { isDestroyed: () => false }, client };
  const views = [view], transport = context.existing(() => views);
  return { good, other, caller, client, view, views, transport, find: () => transport.find(s => s.nativeId === caller.nativeId, 'caller-unavailable', false) };
}
const unavailable = error => classifyOutboxFailure(error).failureReason === 'caller-unavailable';

test('H counterexample: unrelated closed entry does not exclude the healthy caller', () => {
  const f = fixture(); assert.equal(f.find().entry, f.good);
  f.client.bindEntry(f.other); f.other.client.socket.destroyed = true; f.other.client.emit('closed');
  assert.equal(f.client.socket.destroyed, true); assert.equal(f.client.control.manualEpoch, 1);
  assert.equal(f.good.closed, false); assert.equal(f.good.client.socket.destroyed, false);
  assert.equal(f.find().entry, f.good);
});
for (const [name, mutate] of [
  ['own closed entry', f => { f.good.closed = true; }],
  ['own closed socket before closed event', f => { f.good.client.socket.destroyed = true; }],
  ['own closing entry', f => { f.good.closing = true; }],
  ['retired context', f => { f.client.closing = true; }],
  ['unexplained aggregate failure', f => { f.client.socket.destroyed = true; }],
  ['destroyed window', f => { f.view.win.isDestroyed = () => true; }],
  ['missing native identity', f => { f.good.state.sessions = []; }],
]) test(name + ' still refuses caller lookup', () => {
  const f = fixture(); mutate(f); assert.throws(f.find, unavailable);
});

test('a conflicting identity on a closed backend is not hidden by health filtering', () => {
  const f = fixture(); f.other.state.sessions.push({ ...f.caller, pid: 900002 });
  f.other.closed = true; f.other.client.socket.destroyed = true; f.client.socket.destroyed = true;
  assert.throws(f.find, unavailable);
});
test('the same identity observed in two windows selects its healthy transport', () => {
  const f = fixture(); f.good.closed = true; f.good.client.socket.destroyed = true;
  const healthy = { ...f.good, closed: false, client: { socket: { destroyed: false } } };
  f.views.push({ win: f.view.win, client: { closing: false, socket: { destroyed: false }, entries: [healthy], control: f.client.control } });
  assert.equal(f.find().entry, healthy);
});

test('two real daemon backends keep healthy original control and proof guards after unrelated close', { timeout: 30000 }, async t => {
  const path = require('node:path'), os = require('node:os'), { fork } = require('node:child_process'), { once } = require('node:events');
  const { connectService } = require('../service-connection.cjs');
  const { bindOriginalControl } = require('../computer-use-outbox-owner.cjs');
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-caller-isolation-'));
  const children = [], clients = [], entries = [];
  const until = async f => { for (let i = 0; i < 200; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('isolated service did not settle'); };
  let serial = 0;
  const ipc = (child, action, extra = {}) => new Promise((resolve, reject) => {
    const isolation = ++serial, timer = setTimeout(() => reject(Error('fixture timeout')), 3000);
    const done = row => { if (row.isolation === isolation) { child.off('message', done); clearTimeout(timer); assert.equal(row.failure, undefined); resolve(row); } };
    child.on('message', done); child.send({ isolation, action, ...extra });
  });
  t.after(async () => {
    for (const c of clients) c.socket.destroy();
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { const end = once(c, 'exit'); c.kill('SIGTERM'); await end; }
    fs.rmSync(dir, { recursive: true });
  });
  for (const key of ['unrelated', 'caller']) {
    const store = path.join(dir, key); fs.mkdirSync(store, { mode: 0o700 });
    const child = fork(path.join(root, 'app/daemon.cjs'), [store], { execArgv: ['--require', path.join(root, 'scripts/fixtures/caller-isolation-native.cjs')], env: { ...process.env, HOME: store, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: store }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); await until(() => fs.existsSync(path.join(store, 'connection.json')));
    const c = await connectService(store, 'synthetic-existing-view', { page: false }); clients.push(c);
    entries.push({ key, client: c, state: await c.call('initial') });
  }
  const id = await clients[1].call('create', { provider: 'codex', cwd: dir, name: 'Synthetic caller', view: 'chat' });
  await clients[1].call('join', id, true); entries[1].state = await clients[1].call('initial');
  const composite = new WorkspaceClient(entries, 'caller');
  const view = { win: { isDestroyed: () => false }, client: composite }, deps = { contexts: () => [view] };
  const identity = (await ipc(children[1], 'arm', { session: id })).identity;
  const before = await bindOriginalControl(deps, identity, { action: 'catalog' }, AbortSignal.timeout(3000));
  await before.refresh(); await before.close();
  clients[0].socket.destroy(); await until(() => entries[0].closed);
  assert.equal(composite.socket.destroyed, true); assert.equal(entries[1].closed, false);
  const fresh = (await ipc(children[1], 'arm', { session: id })).identity;
  const binding = await bindOriginalControl(deps, fresh, { action: 'catalog' }, AbortSignal.timeout(3000));
  await binding.refresh(); assert.equal(binding.valid(), true); await binding.close();
  await assert.rejects(bindOriginalControl(deps, fresh, { action: 'catalog' }, AbortSignal.timeout(3000)), e => classifyOutboxFailure(e).failureReason === 'duplicate-call');
  const original = entries[1].state.sessions.find(s => s.id === id);
  for (const key of ['controlRevision', 'memberRevision', 'connectionRevision']) {
    const identity = (await ipc(children[1], 'arm', { session: id })).identity;
    const p = await bindOriginalControl(deps, identity, { action: 'catalog' }, AbortSignal.timeout(3000));
    await ipc(children[1], 'patch', { session: id, patch: { [key]: (original[key] || 0) + 1 } });
    await assert.rejects(p.refresh()); await p.close();
    await ipc(children[1], 'patch', { session: id, patch: { [key]: original[key] || 0 } });
  }
  const held = (await ipc(children[1], 'arm', { session: id })).identity;
  await assert.rejects(bindOriginalControl(deps, { ...held, sessionId: 'not-the-held-native-session' }, { action: 'catalog' }, AbortSignal.timeout(4000)), e => classifyOutboxFailure(e).failureReason === 'provenance-unconfirmed');
  const verified = await bindOriginalControl(deps, held, { action: 'catalog' }, AbortSignal.timeout(3000));
  await verified.refresh(); await verified.close();
  const writes = await ipc(children[1], 'stats'); assert.equal(writes.nativeWrites, 0);
  clients[1].socket.destroy(); await until(() => entries[1].closed);
  await assert.rejects(bindOriginalControl(deps, identity, { action: 'catalog' }, AbortSignal.timeout(3000)), unavailable);
  t.diagnostic(JSON.stringify({ backends: 2, originalScopedControl: true, healthyAfterOtherClosed: true, duplicateReplay: false, nativeWrites: 0, generationNegativeControls: 3 }));
});
