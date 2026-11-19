const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NativeHost } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const tui = require('../dsh-tui.cjs');
const { uiError } = require('../ui-errors.cjs');

function host(t, { installed = false, binaries = { python: '/synthetic/python' } } = {}) {
  t.mock.method(tui, 'installed', () => installed);
  return Object.assign(Object.create(NativeHost.prototype), {
    dataDir: '/synthetic/backend', serviceBinding: null, binaries,
    resolvePrograms() { return this.binaries; },
    createDsh() { throw Error('Runtime construction must not happen'); }, close() {},
  });
}
function workspace(t, native) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dsh-start-'));
  const ws = new Workspace(native, dir);
  t.after(async () => { await ws.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ws, dir };
}
async function failed(t, options) {
  const native = host(t, options), f = workspace(t, native);
  await assert.rejects(f.ws.create('dsh', f.dir, 'synthetic-owner'), e => Boolean(e.uiMessage));
  f.record = [...f.ws.sessions.values()][0];
  assert.equal(f.record.state, 'error'); assert.equal(f.ws.runtimes.size, 0);
  return f;
}

for (const [label, options, key] of [
  ['absent or unqualified pinned runtime', {}, 'error.dsh.runtimeUnqualified'],
  ['Node missing after the pinned runtime exists', { installed: true }, 'error.dsh.nodeMissing'],
  ['Python missing with the Node and pinned runtime present', { installed: true, binaries: { dsh: '/synthetic/node' } }, 'error.pythonMissing'],
]) test('preflight distinguishes ' + label, t => {
  const native = host(t, options);
  assert.throws(() => native.create({ id: 'synthetic', provider: 'dsh' }), e => e.uiMessage?.key === key);
});

test('other providers retain the native-CLI refusal', t => {
  assert.throws(() => host(t).create({ provider: 'claude' }), e => e.uiMessage?.key === 'error.nativeRuntimeMissing');
});
test('a qualified DSH path still constructs exactly once without reading a key', t => {
  const native = host(t, { installed: true, binaries: { dsh: '/synthetic/node', python: '/synthetic/python' } });
  const marker = {}; let calls = 0;
  native.createDsh = () => { calls++; return marker; };
  assert.equal(native.create({ provider: 'dsh' }), marker); assert.equal(calls, 1);
});

test('an authenticated preflight refusal can be stopped locally and keeps its failure evidence', async t => {
  const { ws, dir, record } = await failed(t);
  const old = { activity: record.activity, message: record.activityUiMessage };
  await ws.stop(record.id);
  assert.equal(record.state, 'ended'); assert.equal(record.owner, null);
  assert.equal(record.activity, old.activity); assert.deepEqual(record.activityUiMessage, old.message);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'))).sessions[0].state, 'ended');
  await ws.stop(record.id); assert.equal(record.state, 'ended');
});

for (const field of ['pid', 'processIdentity', 'serverIdentity']) test('a preflight mark cannot hide an attached ' + field, async t => {
  const { ws, record } = await failed(t);
  record[field] = field === 'pid' ? 12345 : { pid: 12345 };
  assert.throws(() => ws.stop(record.id), e => e.uiMessage?.key === 'error.sessionEnded');
  assert.equal(record.state, 'error');
});
test('a changed connection generation invalidates the local preflight proof', async t => {
  const { ws, record } = await failed(t);
  record.connectionRevision = (record.connectionRevision || 0) + 1;
  assert.throws(() => ws.stop(record.id), e => e.uiMessage?.key === 'error.sessionEnded');
  assert.equal(record.state, 'error');
});
test('an attached runtime keeps the real stop path', async t => {
  const { ws, record } = await failed(t); let calls = 0;
  ws.runtimes.set(record.id, { stop: async () => { calls++; return { state: 'ended' }; } });
  await ws.stop(record.id); assert.equal(calls, 1); assert.equal(record.state, 'ended');
});
test('maintenance does not bypass its native proof using the local preflight stop', async t => {
  const { ws, record } = await failed(t);
  assert.throws(() => ws.stop(record.id, { expected: {} }), e => e.uiMessage?.key === 'error.sessionEnded');
  assert.equal(record.state, 'error');
});

for (const kind of ['legacy row', 'forged error property', 'constructor failure']) test(kind + ' is not authenticated preflight proof', async t => {
  const native = host(t);
  native.create = () => { throw kind === 'constructor failure' ? Error('Constructor failed') : Object.assign(uiError('error.nativeRuntimeMissing'), { nativePreflightRefused: true }); };
  const { ws, dir } = workspace(t, native);
  if (kind === 'legacy row') ws.sessions.set('legacy', { id: 'legacy', provider: 'dsh', state: 'error', pid: null });
  else await assert.rejects(ws.create('dsh', dir, 'synthetic-owner'));
  const record = [...ws.sessions.values()][0];
  assert.throws(() => ws.stop(record.id), e => e.uiMessage?.key === 'error.sessionEnded');
  assert.equal(record.state, 'error');
});

test('failure after a runtime was returned never receives a local preflight end', async t => {
  const native = host(t), { ws, dir } = workspace(t, native); let calls = 0;
  native.create = () => {
    const { EventEmitter } = require('node:events'); const rt = new EventEmitter();
    rt.start = async () => { throw uiError('error.nativeRuntimeMissing'); };
    rt.stop = async () => { calls++; return { state: 'ended' }; }; return rt;
  };
  await assert.rejects(ws.create('dsh', dir, 'synthetic-owner'));
  const record = [...ws.sessions.values()][0];
  assert.equal(record.state, 'error'); await ws.stop(record.id); assert.equal(calls, 1);
});
