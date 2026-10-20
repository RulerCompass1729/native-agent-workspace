const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex, Rpc } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { EventEmitter } = require('node:events');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-approval-')), replies = [];
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { reply: (id, result) => replies.push({ id, result }) } };
  const w = new Workspace(host, dir);
  const s = { id: 'synthetic', nativeId: 'native-synthetic', provider: 'codex', state: 'idle', owner: 'window', messages: [], fleet: [], controlRevision: 0, memberRevision: 0 };
  const r = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = id => r.event({ id, method: 'item/commandExecution/requestApproval', params: { threadId: s.nativeId, command: `Synthetic request ${id}`, cwd: '/synthetic' } });
  const resolve = id => r.event({ method: 'serverRequest/resolved', params: { threadId: s.nativeId, requestId: id } });
  const progress = () => w.progress.get(s.id).snapshot().items;
  return { w, s, r, host, replies, request, resolve, progress };
}
test('native resolution removes the exact old decision and updates the same progress record without claiming tool completion', t => {
  const f = fixture(t); f.request(7);
  const key = f.s.approval.requestId, initial = f.progress()[0];
  f.resolve(7);
  assert.equal(f.s.approval, null); assert.equal(f.s.approvalResolved, true);
  assert.equal(f.s.state, 'approval', 'Native status remains authoritative');
  assert.throws(() => f.w.approve(f.s.id, key, 'accept', 'window'), /权限请求已变化/);
  assert.deepEqual(f.replies, []);
  assert.equal(f.progress().length, 1); assert.equal(f.progress()[0].id, initial.id);
  assert.equal(f.progress()[0].status, 'resolved');
  f.r.event({ method: 'thread/status/changed', params: { status: { type: 'idle' } } });
  assert.equal(f.s.state, 'idle'); assert.equal(f.s.approvalResolved, false);
});
test('resolving one typed native ID cannot clear a newer distinct request', t => {
  const f = fixture(t); f.request(7); const first = f.progress()[0].id;
  f.request('7'); const current = f.s.approval.requestId;
  f.resolve(7);
  assert.equal(f.s.approval.requestId, current);
  assert.equal(f.progress().find(p => p.id === first).status, 'resolved');
  assert.equal(f.progress().filter(p => p.status === 'waiting').length, 1);
  f.resolve('7'); assert.equal(f.s.approval, null);
});
test('a decision is sent once and waits for native resolution and status', t => {
  const f = fixture(t); f.request(9); const key = f.s.approval.requestId;
  f.w.approve(f.s.id, key, 'decline', 'window');
  assert.equal(f.s.state, 'approval'); assert.equal(f.s.approval.pending, true);
  assert.throws(() => f.w.approve(f.s.id, key, 'accept', 'window'), /权限请求已变化/);
  assert.deepEqual(f.replies, [{ id: 9, result: { decision: 'decline' } }]);
  f.resolve(9); assert.equal(f.s.approval, null); assert.equal(f.s.state, 'approval');
  f.r.event({ method: 'thread/status/changed', params: { status: { type: 'active', activeFlags: [] } } });
  assert.equal(f.s.state, 'working');
});
test('a synchronous failed decision does not pretend to have reached the native service', t => {
  const f = fixture(t); f.request(9);
  f.host.rpc.reply = () => { throw Error('Synthetic closed connection'); };
  assert.throws(() => f.w.approve(f.s.id, f.s.approval.requestId, 'decline', 'window'), /Synthetic closed/);
  assert.equal(Boolean(f.s.approval.pending), false); assert.equal(f.s.state, 'approval');
});
test('unknown or duplicate resolution creates no invented request record', t => {
  const f = fixture(t); f.resolve(100);
  assert.deepEqual(f.progress(), []); assert.equal(f.s.state, 'idle');
  f.request(1); f.resolve(1); const resolved = structuredClone(f.progress());
  f.resolve(1); assert.deepEqual(f.progress(), resolved);
});
test('connection loss marks outstanding progress unknown and cannot mix reused request IDs', t => {
  const f = fixture(t); f.request(1); const first = f.progress()[0].id;
  f.r.transportClosed();
  assert.equal(f.progress()[0].status, 'unknown'); assert.equal(f.s.approval, null);
  f.r.transportDisconnected = false; f.request(1); f.resolve(1);
  assert.equal(f.progress().length, 2);
  assert.equal(f.progress().find(p => p.id === first).status, 'unknown');
  assert.equal(f.progress().filter(p => p.status === 'resolved').length, 1);
});
test('a closed transport rejects decisions before any socket write', () => {
  const ws = new EventEmitter(); ws.readyState = 3; let writes = 0;
  ws.send = () => { writes++; };
  const rpc = new Rpc(ws);
  assert.throws(() => rpc.reply(7, { decision: 'accept' }), /确认没有发送/);
  assert.equal(writes, 0);
});
test('an immediate native resolution cannot be overwritten by the local pending marker', t => {
  const f = fixture(t); f.request(1);
  f.host.rpc.reply = () => f.resolve(1);
  f.w.approve(f.s.id, f.s.approval.requestId, 'decline', 'window');
  assert.equal(f.s.approval, null); assert.equal(f.s.approvalResolved, true);
});
test('disconnecting the observer leaves unresolved permission history explicit and non-actionable', async t => {
  const f = fixture(t); f.request(1);
  f.host.rpc.call = async () => ({ status: 'unsubscribed' });
  await f.w.stop(f.s.id);
  assert.equal(f.s.state, 'disconnected'); assert.equal(f.s.approval, null);
  assert.equal(f.w.approvalRoutes.has(f.s.id), false);
  assert.equal(f.progress()[0].status, 'unknown');
});
test('repeated delivery of an unresolved native request preserves its decision and cannot submit twice', t => {
  const f = fixture(t); f.request(7); const key = f.s.approval.requestId;
  f.w.approve(f.s.id, key, 'decline', 'window');
  f.request(7);
  assert.equal(f.s.approval.requestId, key); assert.equal(f.s.approval.pending, true);
  assert.throws(() => f.w.approve(f.s.id, key, 'accept', 'window'), /权限请求已变化/);
  assert.equal(f.replies.length, 1); assert.equal(f.progress().length, 1);
});
test('conflicting contents for an unresolved native request disable GUI decisions without guessing the intended request', t => {
  const f = fixture(t); f.request(7); const key = f.s.approval.requestId;
  f.r.event({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: f.s.nativeId, command: 'Changed request' } });
  assert.throws(() => f.w.approve(f.s.id, key, 'accept', 'window'), /权限请求已变化/);
  assert.throws(() => f.w.approve(f.s.id, f.s.approval.requestId, 'accept', 'window'), /请在原生终端/);
  assert.deepEqual(f.replies, []); assert.equal(f.progress()[0].status, 'unknown');
});
test('GUI approval cannot bypass unrepresented permission scope or native available decisions', t => {
  const f = fixture(t);
  const requests = [
    { networkApprovalContext: { host: 'synthetic.example', protocol: 'https' } },
    { additionalPermissions: { fileSystem: { write: ['/synthetic/extra'] } } },
    { kind: 'writeStdin' }, { kind: 'future-native-kind' }, { environmentId: 'remote-environment' },
    { availableDecisions: ['decline'] }, { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['synthetic'] } }] },
    { command: '' }, { cwd: '' }, { method: 'item/fileChange/requestApproval' },
  ];
  let id = 100;
  for (const variant of requests) {
    const { method = 'item/commandExecution/requestApproval', ...params } = variant;
    f.r.event({ id: ++id, method, params: { threadId: f.s.nativeId, command: 'Synthetic command', cwd: '/synthetic', ...params } });
    assert.throws(() => f.w.approve(f.s.id, f.s.approval.requestId, 'accept', 'window'), /原生终端|不支持/);
    f.resolve(id);
  }
  assert.deepEqual(f.replies, []);
});
test('local command accept and cancel reach the exact native request without granting a policy', t => {
  const f = fixture(t);
  for (const [id, decision] of [[11, 'accept'], [12, 'cancel']]) {
    f.r.event({ id, method: 'item/commandExecution/requestApproval', params: { threadId: f.s.nativeId,
      kind: 'command', environmentId: 'local', command: 'synthetic', cwd: '/synthetic',
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'] } });
    const key = f.s.approval.requestId;
    assert.throws(() => f.w.approve(f.s.id, key, decision, 'another-window'), /权限请求已变化/);
    f.w.approve(f.s.id, key, decision, 'window');
    assert.equal(f.s.approval.pending, true);
    assert.throws(() => f.w.approve(f.s.id, key, decision, 'window'), /权限请求已变化/);
    f.resolve(id);
  }
  assert.deepEqual(f.replies, [{ id: 11, result: { decision: 'accept' } }, { id: 12, result: { decision: 'cancel' } }]);
});
