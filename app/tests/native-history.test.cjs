const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { NativeHistory, metadata } = require('../native-history.cjs');
const { Workspace } = require('../workspace.cjs');
const { Codex, Rpc } = require('../adapters.cjs');
const id = '00000000-0000-4000-8000-000000000001';
function nativeRecord(cwd = '/synthetic') { return { id, cwd, name: '学习笔记', model: 'original-model', preview: 'PRIVATE first message', path: '/private/rollout', updatedAt: 100, canAcceptDirectInput: true }; }
test('catalog is metadata-only, bounded and explicit; named records omit private previews and rollout paths', async () => {
  const calls = [], host = { rpc: { call: async (method, params) => { calls.push({ method, params }); return { data: [nativeRecord()], nextCursor: null }; } } };
  const history = new NativeHistory(host); history.ready = async () => host.rpc;
  assert.equal(calls.length, 0);
  const rows = await history.list({ search: ' 笔记 ' });
  assert.equal(rows.data[0].name, '学习笔记'); assert.ok(!JSON.stringify(rows).includes('PRIVATE')); assert.ok(!JSON.stringify(rows).includes('rollout'));
  assert.deepEqual(calls, [{ method: 'thread/list', params: { limit: 30, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true, searchTerm: '笔记' } }]);
  await assert.rejects(history.list({ cursor: {} }), /无效/); await assert.rejects(history.read('../history'), /标识/);
  assert.equal(calls.length, 1);
});
test('catalog rejects loops and read rejects identity substitution; children cannot be imported', async () => {
  const host = { rpc: { call: async () => ({ data: [nativeRecord()], nextCursor: 'loop' }) } }, history = new NativeHistory(host);
  history.ready = async () => host.rpc;
  await assert.rejects(history.list({ cursor: 'loop' }), /分页/);
  host.rpc.call = async () => ({ thread: { ...nativeRecord(), id: '00000000-0000-4000-8000-000000000002' } });
  await assert.rejects(history.read(id), /身份/);
  assert.throws(() => metadata({ ...nativeRecord(), parentThreadId: 'parent' }), /独立/);
});
function fixture(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-import-test-')), calls = [];
  const host = { binaries: {}, codexTargets: new Map(), codexProcess: { pid: process.pid }, startCodex: async () => {}, close() {},
    create(record) { return new Codex(record, this); }, rpc: { call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/resume') {
        if (mode === 'writer') { const error = Error('仍有活动连接'); error.nativeActiveWriter = true; throw error; }
        if (mode === 'uncertain') throw Error('原生请求确认超时；不会自动重发。');
        return { model: 'original-model', thread: { ...nativeRecord(directory), status: { type: 'idle' } } };
      }
      if (method === 'thread/items/list') {
        if (mode === 'page-failure') throw Error('page unavailable');
        return { data: [{ item: { id: 'answer', type: 'agentMessage', text: 'Existing result' } }], nextCursor: null };
      }
      throw Error('Unexpected native mutation: ' + method);
    } } };
  const w = new Workspace(host, directory);
  w.nativeHistory.read = async () => nativeRecord(directory); w.nativeHistory.ready = async () => host.rpc;
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { w, host, calls, directory };
}
test('selected history preserves native identity/settings, is saved before resume and imports once under concurrency', async t => {
  const f = fixture(t); const call = f.host.rpc.call;
  f.host.rpc.call = async (method, params) => {
    if (method === 'thread/resume') {
      const stored = JSON.parse(fs.readFileSync(path.join(f.directory, 'workspace.json')));
      assert.equal(stored.sessions[0].nativeId, id); assert.equal(stored.sessions[0].state, 'recoverable');
      assert.deepEqual(params, { threadId: id, excludeTurns: true });
    }
    return call(method, params);
  };
  const [a, b] = await Promise.all([f.w.importHistory(id, 'owner'), f.w.importHistory(id, 'other')]);
  assert.equal(a, b); assert.equal(f.w.sessions.size, 1); assert.equal(f.w.get(a).nativeId, id);
  assert.equal(f.w.get(a).messages[0].text, 'Existing result'); assert.equal(f.w.get(a).roomId, null);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1); assert.equal(f.w.versions.dispatches, 0);
  f.w.setDraft(a, 'Keep this unsent', 'owner'); f.w.persist();
  const cold = new Workspace({ binaries: {}, close() {} }, f.directory); t.after(() => cold.close());
  assert.equal(cold.get(a).nativeId, id); assert.equal(cold.drafts.get(a), 'Keep this unsent');
  assert.equal(cold.get(a).state, 'recoverable'); assert.equal(cold.versions.dispatches, 0);
});
for (const failure of ['uncertain', 'page-failure']) test('import retains one record without retry/fork on ' + failure, async t => {
  const f = fixture(t, failure); const local = await f.w.importHistory(id, 'owner');
  assert.equal(await f.w.importHistory(id, 'owner'), local);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1); assert.equal(f.w.sessions.size, 1);
  assert.equal(f.w.get(local).nativeId, id); assert.equal(f.w.snapshot().sessions[0].chatAvailable, failure === 'page-failure' ? false : true);
  if (failure === 'page-failure') { assert.ok(f.w.runtimes.get(local).hasHistory); assert.match(f.w.get(local).activity, /同步未完成/); }
  else { assert.equal(f.w.get(local).state, 'error'); assert.equal(f.w.runtimes.size, 0); }
  assert.ok(f.calls.every(c => ['thread/resume', 'thread/items/list'].includes(c.method)));
});
test('failed durable reservation prevents native resume', async t => {
  const f = fixture(t); t.mock.method(fs, 'renameSync', () => { throw Error('Disk full'); });
  const local = await f.w.importHistory(id, 'owner');
  assert.equal(f.calls.length, 0); assert.equal(f.w.get(local).state, 'error'); assert.equal(f.w.storageFailure, 'write');
});
test('save failure after native ACK retains the same live runtime and never resumes twice', async t => {
  const f = fixture(t), rename = fs.renameSync; let saves = 0;
  t.mock.method(fs, 'renameSync', (...args) => { if (++saves > 1) throw Error('Disk full'); return rename(...args); });
  const local = await f.w.importHistory(id, 'owner');
  assert.equal(f.w.storageFailure, 'write'); assert.ok(f.w.runtimes.get(local).hasHistory);
  assert.equal(await f.w.importHistory(id, 'owner'), local); assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
});
test('native writer rejection becomes a safe actionable message without raw private text', async () => {
  const socket = new EventEmitter(); let sent; socket.send = text => { sent = JSON.parse(text); };
  const rpc = new Rpc(socket), result = rpc.call('thread/resume', { threadId: id });
  socket.emit('message', JSON.stringify({ id: sent.id, error: { code: -32600, message: 'thread PRIVATE already has an active writer /private/rollout' } }));
  await assert.rejects(result, e => e.nativeActiveWriter && e.message.includes('其他原生连接') && !e.message.includes('PRIVATE'));
});

test('actual server handshake version cannot borrow the client version or allow unknown/prerelease runtimes', () => {
  const { serverVersion, verifiedCodexProtocol } = require('../native-history.cjs');
  for (const nativeVersion of ['0.163.0','0.164.0']) assert.equal(verifiedCodexProtocol({nativeVersion}), true);
  for (const nativeVersion of [undefined,'0.165.0','0.164.0-beta','unknown']) assert.equal(verifiedCodexProtocol({nativeVersion}), false);
  assert.equal(serverVersion({ userAgent: 'native_agent_workspace/0.163.0 (Mac OS; arm64) unknown (native_agent_workspace; 0.1.0)' }), '0.163.0');
  assert.equal(serverVersion({ userAgent: 'native_agent_workspace/0.162.0 (Mac OS; arm64) unknown (native_agent_workspace; 0.163.0)' }), '0.162.0');
  assert.equal(serverVersion({ userAgent: 'native_agent_workspace/0.163.0-beta (Mac OS)' }), null);
  assert.equal(serverVersion({}), null);
});
for (const intervention of ['second-resume', 'forget', 'stop', 'close']) test('external recovery validation cannot outlive ' + intervention, async t => {
  const f = fixture(t), local = await f.w.importHistory(id, 'owner');
  const s = f.w.get(local); f.w.runtimes.delete(local); s.state = 'ended'; s.processIdentity = null; s.serverIdentity = null;
  let release; f.w.nativeHistory.ready = () => new Promise(resolve => { release = resolve; });
  f.calls.length = 0; const pending = f.w.resume(local, 'owner');
  assert.equal(s.state, 'starting');
  if (intervention === 'second-resume') await assert.rejects(f.w.resume(local, 'other'), /目前不能恢复/);
  if (intervention === 'forget') f.w.forget(local);
  if (intervention === 'stop') await f.w.stop(local);
  if (intervention === 'close') f.w.close();
  release();
  if (intervention === 'second-resume') { await pending; assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1); }
  else { await assert.rejects(pending, /状态已变化/); assert.equal(f.calls.length, 0); assert.equal(f.w.runtimes.size, 0); }
});
test('pending metadata read prevents empty-service shutdown and cannot resume after service close', async t => {
  const f = fixture(t); let release;
  f.w.nativeHistory.read = () => new Promise(resolve => { release = resolve; });
  const pending = f.w.importHistory(id, 'owner');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.w.pendingNativeImports, 1);
  f.w.close(); release(nativeRecord(f.directory));
  await assert.rejects(pending, /后台已关闭/); assert.equal(f.calls.length, 0); assert.equal(f.w.sessions.size, 0); assert.equal(f.w.pendingNativeImports, 0);
});

test('definite active-writer rejection leaves no local copy and never retries automatically', async t => {
  const f = fixture(t, 'writer');
  await assert.rejects(f.w.importHistory(id, 'owner'), e => e.nativeActiveWriter);
  assert.equal(f.w.sessions.size, 0); assert.equal(f.w.runtimes.size, 0);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'workspace.json'))).sessions.length, 0);
});

test('new sessions during a history read do not block the selected native identity', async t => {
  const f = fixture(t); let release;
  f.w.nativeHistory.read = () => new Promise(resolve => { release = resolve; });
  const pending = f.w.importHistory(id, 'owner'); await new Promise(resolve => setImmediate(resolve));
  for (let n = 0; n < 6; n++) f.w.sessions.set('existing-' + n, { id: 'existing-' + n, nativeId: 'retained-' + n, provider: 'claude', state: 'idle', messages: [], model: 'retained', cwd: f.directory, owner: 'owner' });
  release(nativeRecord(f.directory)); const selected = await pending;
  assert.equal(f.w.sessions.size, 7); assert.equal(f.w.get(selected).nativeId, id);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
  for (let n = 0; n < 6; n++) assert.equal(f.w.get('existing-' + n).state, 'idle');
});

test('unnamed history reuses a bounded native preview instead of a generated title', () => {
  const row = metadata({ ...nativeRecord(), name: '', preview: '週末计划\n' + '资料'.repeat(100) });
  assert.equal(row.name.length, 60); assert.ok(row.name.startsWith('週末计划 '));
  assert.equal(Object.hasOwn(row, 'preview'), false); assert.equal(Object.hasOwn(row, 'path'), false);
});


test('native version display uses the running handshake and never certifies prerelease or disconnected data', () => {
  const { codexVersionInfo } = require('../native-history.cjs');
  const rpc = { nativeVersion: '0.163.0', ws: { readyState: 1 } };
  assert.deepEqual(codexVersionInfo(rpc), { nativeVersion: '0.163.0', nativeVersionStatus: 'verified' });
  rpc.nativeVersion = '0.164.0'; assert.equal(codexVersionInfo(rpc).nativeVersionStatus, 'verified');
  rpc.nativeVersion = '0.165.0'; assert.deepEqual(codexVersionInfo(rpc), { nativeVersion: '0.165.0', nativeVersionStatus: 'unverified' });
  for (const nativeVersion of ['0.164.0-beta', '0.164.0 secret', null, 164]) {
    rpc.nativeVersion = nativeVersion;
    assert.deepEqual(codexVersionInfo(rpc), { nativeVersion: null, nativeVersionStatus: 'unverified' });
  }
  rpc.nativeVersion = '0.163.0'; rpc.ws.readyState = 3;
  assert.deepEqual(codexVersionInfo(rpc), { nativeVersion: '0.163.0', nativeVersionStatus: 'last-known' });
  rpc.ws.readyState = 1; assert.equal(codexVersionInfo(rpc, false).nativeVersionStatus, 'last-known');
  assert.deepEqual(codexVersionInfo({ ws: { readyState: 1 } }), { nativeVersion: null, nativeVersionStatus: 'unreported' });
  assert.deepEqual(codexVersionInfo(null), { nativeVersion: null, nativeVersionStatus: 'unreported' });
});

test('workspace native version metadata follows its actual runtime RPC and never the replacement binary or another host', () => {
  const rpc = { nativeVersion: '0.163.0', ws: { readyState: 1 } };
  const runtime = { host: { rpc } };
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    sessions: new Map([['test', { id: 'test', provider: 'codex', nativeVersion: '0.164.0', nativeVersionStatus: 'verified' }]]),
    runtimes: new Map([['test', runtime]]), host: { binaries: {}, rpc: { nativeVersion: '0.164.0' } },
    sharedReplies: { activity: () => null }, drafts: new Map(), capacityRecoveries: new Map(), room: {}, versions: {},
  });
  assert.equal(workspace.snapshot().sessions[0].nativeVersion, '0.163.0');
  runtime.transportDisconnected = true;
  assert.equal(workspace.snapshot().sessions[0].nativeVersionStatus, 'last-known');
  workspace.runtimes.clear();
  assert.equal(workspace.snapshot().sessions[0].nativeVersion, null);
  assert.equal(workspace.snapshot().sessions[0].nativeVersionStatus, 'unreported');
});

function claudeImportFixture(t, refusal) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-import-')), calls = [];
  const host = { binaries: {}, close() {}, create(record) {
    calls.push({ ...record });
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))); assert.equal(saved.sessions.find(s => s.id === record.id).state, 'recoverable');
    if (refusal) { const error = Error('Controlled refusal'); error[refusal] = true; throw error; }
    const r = new EventEmitter(); r.start = async () => r.emit('state', 'idle'); return r;
  } };
  const w = new Workspace(host, directory); w.nativeHistory.read = w.nativeHistory.ready = async () => { throw Error('Claude must not query Codex'); };
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { w, calls, directory };
}
test('explicit Claude import reuses recovery, persists before launch, never queries Codex and deduplicates UUID/provider', async t => {
  const { w, calls, directory } = claudeImportFixture(t);
  w.sessions.set('codex-same-id', { id: 'codex-same-id', provider: 'codex', nativeId: id, messages: [], state: 'ended' });
  const options = { provider: 'claude', cwd: directory };
  const ids = await Promise.all([w.importHistory(id, 'owner', options), w.importHistory(id.toUpperCase(), 'owner', options)]);
  assert.equal(ids[0], ids[1]); assert.equal(calls.length, 1); assert.equal(w.sessions.size, 2);
  const row = w.get(ids[0]); assert.equal(row.nativeId, id); assert.equal(row.provider, 'claude'); assert.equal(row.externalHistory, true); assert.equal(row.view, 'terminal'); assert.equal(row.autoName, true); assert.equal(row.nativePermissionMode, undefined); assert.equal(w.versions.dispatches, 0);
});
for (const marker of ['nativeActiveWriter', 'nativeImportRefused']) test('Claude import refuses before native effects and removes reserved session and disk entry: ' + marker, async t => {
  const { w, calls, directory } = claudeImportFixture(t, marker);
  await assert.rejects(w.importHistory(id, 'owner', { provider: 'claude', cwd: directory }), e => e[marker]);
  assert.equal(calls.length, 1); assert.equal(w.sessions.size, 0); assert.equal(w.runtimes.size, 0); assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))).sessions.length, 0); assert.equal(w.versions.dispatches, 0);
});
test('Claude import validates input and applies only the current explicit permission checkbox', async t => {
  const { w, calls, directory } = claudeImportFixture(t);
  for (const options of [{ provider: 'other', cwd: directory }, { provider: 'claude', cwd: 'relative' }, { provider: 'claude', cwd: directory, skipPermissions: 'yes' }, { provider: 'claude', cwd: directory, name: 'bad\nname' }]) assert.throws(() => w.importHistory(id, 'owner', options));
  assert.throws(() => w.importHistory('invalid-id', 'owner', { provider: 'claude', cwd: directory })); assert.equal(calls.length, 0);
  const local = await w.importHistory(id, 'owner', { provider: 'claude', cwd: directory, name: 'Own label', skipPermissions: true });
  assert.equal(w.get(local).nativePermissionMode, 'bypassPermissions'); assert.equal(w.get(local).autoName, false);
});
