const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const { Claude } = require('../adapters.cjs');
const { PeerLeases, PeerRunner, CAPABILITY, DIRECTED, identity, mergePeerMessages } = require('../peer-handoffs.cjs');
const tick = () => new Promise(r => setImmediate(r));
async function wait(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('Expected state did not settle'); }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-handoff-')), key = 'backends/' + 'a'.repeat(20);
  const paths = [path.join(root, key), root], services = new Map(), sends = [];
  fs.mkdirSync(paths[0], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(paths[0]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, entries: [key, '.'], active: '.' }), { mode: 0o600 });
  for (const dir of paths) {
    const runtimes = [], host = { binaries: {}, close() {}, create(record) {
      record.nativeId ||= randomUUID(); record.pid = dir === root ? 102 : 101;
      const r = new EventEmitter(); r.chatAvailable = true; r.nativeBlocks = true; r.addressedSendAvailable = true;
      r.start = async () => r.emit('state', 'idle');
      r.send = async (text, tag, valid) => { assert.ok(valid()); sends.push({ dir, text, tag, valid, r }); r.emit('submitted', tag); r.emit('state', 'working'); };
      runtimes.push(r); return r;
    } };
    const w = new Workspace(host, dir); w.peerLeases = new PeerLeases(w);
    const id = await w.create(dir === root ? 'codex' : 'claude', dir, 'owner', 'Same'); w.join(id, true);
    services.set(dir, { w, id, r: runtimes[0], clients: [] });
  }
  const connect = async (dir, owner) => {
    const service = services.get(dir), c = new EventEmitter(); c.destroyed = false; service.clients.push(c);
    c.call = async (method, spec) => {
      if (c.destroyed) throw Error('Disconnected');
      if (method === 'initial') return { ...service.w.snapshot(), capabilities: [CAPABILITY, DIRECTED], owner };
      if (method === 'peerPrepare') return service.w.peerLeases.prepare(c, owner, spec);
      if (method === 'peerTake') return service.w.peerLeases.take(c, spec);
      if (method === 'peerSend') return service.w.peerLeases.send(c, owner, spec);
      if (method === 'peerPause') return service.w.peerLeases.pause(c, spec.id);
      throw Error(method);
    };
    const changed = () => queueMicrotask(() => { if (!c.destroyed) c.emit('state', service.w.snapshot()); }); service.w.on('change', changed);
    c.close = () => { if (!c.destroyed) { c.destroyed = true; service.w.off('change', changed); service.w.peerLeases.disconnected(c); c.emit('closed'); } };
    return c;
  };
  const [a, b] = [...services.values()], runner = new PeerRunner(b.w, root, connect);
  const spec = { ids: [a.id, b.id], goal: 'Calculate 36 + 14, check it, conclude.', maxSteps: 3, mode: 'replies', labels: {},
    identities: { [a.id]: identity(a.w.get(a.id)), [b.id]: identity(b.w.get(b.id)) },
    contexts: { [a.id]: a.w.get(a.id).nativeId, [b.id]: b.w.get(b.id).nativeId }, routes: { [a.id]: key, [b.id]: '.' } };
  const finish = (sent, text, extra = {}) => {
    const service = services.get(sent.dir), s = [...service.w.sessions.values()].find(s => s.pendingTag === sent.tag), { turnId, promptId } = sent.identity ||= { turnId: randomUUID(), promptId: randomUUID() }, block = 'display:' + randomUUID();
    sent.r.emit('replyBound', { tag: sent.tag, nativeId: s.nativeId, turnId, promptId });
    sent.r.emit('nativeBlock', { id: block, kind: 'response', nativeId: s.nativeId, turnId, promptId, text, status: 'complete' });
    sent.r.emit('state', 'idle'); sent.r.emit('complete', { tag: sent.tag, messageId: `native:${s.nativeId}:${block}`, text, background: null, scheduled: null, fleetPending: null, stopHookActive: null, ...extra });
  };
  t.after(async () => { await runner.pause(); for (const service of services.values()) { for (const c of service.clients) c.close(); service.w.close(); } fs.rmSync(root, { recursive: true, force: true }); });
  const stage = (sent, recipient, message) => {
    const service = services.get(sent.dir), s = [...service.w.sessions.values()].find(s => s.pendingTag === sent.tag);
    sent.identity ||= { turnId: randomUUID(), promptId: randomUUID() };
    sent.r.emit('replyBound', { tag: sent.tag, nativeId: s.nativeId, ...sent.identity });
    return sent.r.addressedCall({ nativeId: s.nativeId, ...sent.identity, callId: 'call:' + sent.tag }, { recipient_id: recipient, message });
  };
  return { root, key, a, b, runner, spec, sends, connect, finish, stage };
}

for (const kind of ['different', 'empty', 'long']) test('directed peer intent keeps its exact body separate from the final reply: ' + kind, async t => {
  const f = await fixture(t); f.spec.mode = 'directed';
  await f.runner.start('owner', f.spec); const first = f.sends[0];
  assert.match(first.text, /At most 3 replies remain/); assert.doesNotMatch(first.text, /NaN/);
  assert.throws(() => f.stage(first, f.b.id, 'x'.repeat(6001)), /6000/);
  assert.equal(f.stage(first, f.b.id, 'Only this exact peer message goes to the second agent.').status, 'staged');
  assert.equal(f.sends.length, 1, 'Staging alone never delivers');
  f.finish(first, kind === 'empty' ? '' : kind === 'long' ? 'Human final answer. '.repeat(1000) : 'This final answer is for the human, and is different.'); await wait(() => f.sends.length === 2);
  assert.ok(f.sends[1].text.includes('Only this exact peer message')); assert.ok(!f.sends[1].text.includes('This final answer is for the human'));
  assert.match(f.sends[1].text, /At most 2 replies remain/);
  f.finish(f.sends[1], 'Final conclusion for the human. '.repeat(kind === 'long' ? 1000 : 1)); await wait(() => f.runner.run.status === 'completed');
  const rows = mergePeerMessages([...f.a.w.room.messages, ...f.b.w.room.messages]), routed = rows.filter(m => m.addressed);
  assert.equal(routed.length, 1); assert.equal(routed[0].text, 'Only this exact peer message goes to the second agent.');
  assert.equal(routed[0].deliveries[0].recipientId, f.b.id); assert.equal(f.sends.length, 2);
  if (kind === 'different') assert.ok(rows.some(m => m.finalReply && m.text === 'This final answer is for the human, and is different.'));
});
test('native recipient choice can skip the displayed peer order, with no synthetic remote session records', async t => {
  const f = await fixture(t), third = await f.a.w.create('claude', f.root, 'owner', 'Third'); f.a.w.join(third, true);
  f.spec.ids.push(third); f.spec.identities[third] = identity(f.a.w.get(third)); f.spec.contexts[third] = f.a.w.get(third).nativeId; f.spec.routes[third] = f.key; f.spec.maxSteps = 4; f.spec.mode = 'directed';
  await f.runner.start('owner', f.spec); f.stage(f.sends[0], third, 'Third member first.'); f.finish(f.sends[0], 'First final.'); await wait(() => f.sends.length === 2);
  assert.equal(f.runner.run.awaiting.sessionId, third); assert.equal(f.b.w.sessions.size, 1);
  f.stage(f.sends[1], f.b.id, 'Second backend next.'); f.finish(f.sends[1], 'Third member final.'); await wait(() => f.sends.length === 3);
  assert.equal(f.runner.run.awaiting.sessionId, f.b.id); f.finish(f.sends[2], 'Done.'); await wait(() => f.runner.run.status === 'completed');
});
test('directed peer stages cannot survive failed native tool policy or departure', async t => {
  for (const boundary of ['failed', 'departure']) {
    const f = await fixture(t); f.spec.mode = 'directed'; await f.runner.start('owner', f.spec); const sent = f.sends[0];
    f.stage(sent, f.b.id, 'This must not be delivered.');
    if (boundary === 'departure') f.b.w.join(f.b.id, false);
    else sent.r.addressedFailed({ nativeId: f.a.w.get(f.a.id).nativeId, ...sent.identity, callId: 'call:' + sent.tag });
    f.finish(sent, 'Native final after revocation.'); await wait(() => f.runner.run.status === 'paused'); assert.equal(f.sends.length, 1);
  }
});
test('V1 peers cannot be silently downgraded from directed intent', async t => {
  const f = await fixture(t), connect = f.runner.connect; f.spec.mode = 'directed';
  f.runner.connect = async (...args) => { const c = await connect(...args), call = c.call; c.call = async (method, ...args) => { const value = await call(method, ...args); if (method === 'initial') value.capabilities = [CAPABILITY]; return value; }; return c; };
  await assert.rejects(f.runner.start('owner', f.spec), /缺少本次/); assert.equal(f.sends.length, 0);
});
test('loss of the native addressing capability revokes a staged peer intent', async t => {
  const f = await fixture(t); f.spec.mode = 'directed'; await f.runner.start('owner', f.spec);
  f.stage(f.sends[0], f.b.id, 'Do not send after native tool retirement.'); f.a.r.addressedSendAvailable = false; f.a.r.emit('capability');
  f.finish(f.sends[0], 'Native final after tool retirement.'); await wait(() => f.runner.run.status === 'paused'); assert.equal(f.sends.length, 1);
});
test('bounded cross-service round binds exact native replies, preserves identity and merges receipts', async t => {
  const f = await fixture(t), ids = [f.a, f.b].map(s => identity(s.w.get(s.id)));
  await f.runner.start('owner', f.spec); assert.equal(f.sends.length, 1);
  f.finish(f.sends[0], 'Draft 50'); await wait(() => f.sends.length === 2);
  f.finish(f.sends[1], 'Checked 50'); await wait(() => f.sends.length === 3);
  f.finish(f.sends[2], 'Final 50'); await wait(() => f.runner.run.status === 'completed');
  assert.deepEqual([f.a, f.b].map(s => identity(s.w.get(s.id))), ids);
  const rows = mergePeerMessages([...f.a.w.room.messages, ...f.b.w.room.messages]);
  assert.equal(rows.filter(m => m.role === 'human').length, 1); assert.equal(rows.filter(m => m.finalReply).length, 3);
  assert.ok(rows.filter(m => m.deliveries).every(m => m.deliveries[0].status === 'submitted'));
  assert.ok(!f.sends[1].text.includes('PRIVATE')); assert.match(f.sends[1].text, /不代表真人新增授权/);
});
test('completion before the send ACK advances exactly once', async t => {
  const f = await fixture(t), original = f.a.r.send;
  f.a.r.send = async (...args) => { await original(...args); f.finish(f.sends.at(-1), 'Immediate 50'); };
  await f.runner.start('owner', f.spec); await wait(() => f.sends.length === 2);
  assert.equal(f.runner.run.steps, 1); await tick(); assert.equal(f.sends.length, 2);
});
for (const boundary of ['permission', 'human', 'departure', 'context', 'socket', 'expiry', 'clear-history']) test('lease revocation is irreversible: ' + boundary, async t => {
  const f = await fixture(t); await f.runner.start('owner', f.spec); const sent = f.sends[0], lease = [...f.a.w.peerLeases.leases.values()][0];
  if (boundary === 'permission') { f.a.r.emit('approval', { requestId: 1 }); f.a.r.emit('approvalResolved', 1); f.a.r.emit('state', 'idle'); }
  if (boundary === 'human') f.a.r.emit('sharingBoundary', 'control:input');
  if (boundary === 'departure') f.a.w.join(f.a.id, false);
  if (boundary === 'context') { f.a.w.get(f.a.id).nativeId = randomUUID(); f.a.w.changed(); }
  if (boundary === 'socket') lease.client.close();
  if (boundary === 'expiry') { lease.deadline = Date.now() - 1; f.a.w.changed(); }
  if (boundary === 'clear-history') f.a.w.clearSharedHistory();
  f.finish(sent, 'Late completion'); await wait(() => f.runner.run.status === 'paused');
  assert.equal(f.sends.length, 1); assert.equal(sent.valid(), false); assert.notEqual(lease.status, 'running');
});
test('pause before prepare ACK revokes the actual run and does not start a task', async t => {
  const f = await fixture(t); let release, prepared;
  const connect = f.runner.connect;
  f.runner.connect = async (...args) => { const c = await connect(...args), call = c.call; c.call = async (method, spec) => { const result = await call(method, spec); if (method === 'peerPrepare') { prepared = c; await new Promise(r => { release = r; }); } return result; }; return c; };
  const start = f.runner.start('owner', f.spec); await wait(() => !!prepared);
  await f.runner.pause('Human pause'); release(); await assert.rejects(start, /授权失效|连接|Disconnected/);
  assert.equal(f.sends.length, 0); assert.ok([...f.a.w.peerLeases.leases.values()].every(g => g.status === 'paused'));
});
test('accepted input with a late ACK stays recorded after pause and is never retried', async t => {
  const f = await fixture(t); let release; const original = f.a.r.send;
  f.a.r.send = async (...args) => { await original(...args); await new Promise(r => { release = r; }); };
  const start = f.runner.start('owner', f.spec); await wait(() => !!release);
  await f.runner.pause(); release(); await assert.rejects(start);
  assert.equal(f.sends.length, 1); assert.equal(f.a.w.get(f.a.id).messages.filter(m => m.role === 'user').length, 1);
});
test('known native background work prevents the next peer handoff', async t => {
  const f = await fixture(t); await f.runner.start('owner', f.spec);
  f.finish(f.sends[0], '50', { background: 1 }); await wait(() => f.runner.run.status === 'paused'); assert.equal(f.sends.length, 1);
});

test('opening Codex terminal changes display PID without retiring its backend lease', async t => {
  const f = await fixture(t), s = f.b.w.get(f.b.id);
  s.serverIdentity = { pid: 102, started: 'owned-backend-start' }; f.spec.identities[f.b.id] = identity(s);
  await f.runner.start('owner', f.spec);
  s.pid = 500; f.b.w.changed();
  assert.equal([...f.b.w.peerLeases.leases.values()][0].status, 'running');
  f.finish(f.sends[0], '50'); await wait(() => f.sends.length === 2);
  s.serverIdentity = { pid: 103, started: 'another-backend' }; f.b.w.changed();
  await wait(() => f.runner.run.status === 'paused'); assert.equal(f.sends[1].valid(), false);
});

test('held pause ACK stays visibly pending; confirmation does not resend a task', async t => {
  const f = await fixture(t); await f.runner.start('owner', f.spec);
  const c = f.runner.channels.get(f.key).client, call = c.call; let release;
  c.call = async (method, spec) => { const result = await call(method, spec); if (method === 'peerPause') await new Promise(r => { release = r; }); return result; };
  const paused = f.runner.pause(); await wait(() => !!release);
  assert.equal(f.runner.run.pausePending, true); assert.equal(f.runner.run.pauseUnconfirmed, undefined);
  assert.throws(() => f.b.w.clearSharedHistory(), /核对各后台/);
  await assert.rejects(f.b.w.startRun(f.spec.ids, f.spec.goal, 3, 'replies'), /核对各后台/);
  assert.equal(f.b.w.room.run, f.runner.run, 'Pending revocation and its record remain visible');
  release(); await paused; assert.equal(f.runner.run.pausePending, false); assert.equal(f.runner.run.pauseUnconfirmed, false); assert.equal(f.sends.length, 1);
});

test('rejected pause ACK stays unconfirmed until an explicit read-only recheck', async t => {
  const f = await fixture(t); await f.runner.start('owner', f.spec);
  const c = f.runner.channels.get(f.key).client, call = c.call;
  c.call = async (method, spec) => { const value = await call(method, spec); if (method === 'peerPause') throw Error('Lost ACK'); return value; };
  await f.runner.pause(); assert.equal(f.runner.run.pauseUnconfirmed, true); assert.equal(f.runner.run.pausePending, false);
  assert.throws(() => f.b.w.clearSharedHistory(), /核对各后台/);
  await assert.rejects(f.b.w.startRun(f.spec.ids, f.spec.goal, 3, 'replies'), /核对各后台/);
  assert.equal(f.b.w.room.run, f.runner.run, 'Unconfirmed revocation cannot lose its recheck entry');
  f.b.w.changed(); await tick(); assert.equal(f.runner.run.pauseUnconfirmed, true, 'Ordinary updates do not auto-confirm');
  await assert.rejects(f.runner.start('owner', f.spec));
  await f.runner.pause(); assert.equal(f.runner.run.pauseUnconfirmed, false); assert.equal(f.sends.length, 1);
});

for (const control of ['permission', 'input']) test('actual current Claude authenticated control revokes before classic state: ' + control, async t => {
  const f = await fixture(t), s = f.a.w.get(f.a.id), r = f.a.r;
  Object.setPrototypeOf(r, Claude.prototype); r.record = s; r.terminal = { alive: true }; r.pending = null;
  r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true });
  assert.equal(r.nativeSharedDisplay, undefined);
  await f.runner.start('owner', f.spec);
  r.observeRoot({ sessionId: s.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: 1,
    block: true, id: 'control:' + control, kind: 'control', status: 'complete' });
  assert.equal([...f.a.w.peerLeases.leases.values()][0].status, 'paused');
  f.finish(f.sends[0], 'Late after authenticated control');
  await wait(() => f.runner.run.status === 'paused'); assert.equal(f.sends.length, 1);
});


for (const boundary of ['gap', 'rebind', 'permission']) test('stale completed snapshot cannot hand off after native ' + boundary, async t => {
  const f = await fixture(t), s = f.a.w.get(f.a.id), r = f.a.r;
  Object.setPrototypeOf(r, Claude.prototype); r.record = s; r.terminal = { alive: true }; r.pending = null;
  r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true });
  await f.runner.start('owner', f.spec);
  const channel = f.runner.channels.get(f.key); channel.client.removeAllListeners('state');
  f.finish(f.sends[0], 'Completed but not yet consumed'); channel.state = structuredClone(f.a.w.snapshot());
  if (boundary === 'gap') r.observeRootGap({ sessionId: s.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
  if (boundary === 'rebind') r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true });
  if (boundary === 'permission') r.observeRoot({ sessionId: s.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: 1,
    block: true, id: 'control:permission', kind: 'control', status: 'complete' });
  assert.equal(channel.state.peerLeases[0].status, 'running', 'Observer is deliberately stale');
  f.runner.schedule(); await wait(() => f.runner.run.status === 'paused'); assert.equal(f.sends.length, 1);
});


test('native input ABA before the second initial read cannot refresh the authorization baseline', async t => {
  const f = await fixture(t), connect = f.runner.connect; let release, waiting;
  f.runner.connect = async (...args) => { const c = await connect(...args), call = c.call; c.call = async (method, spec) => {
    if (args[0] === f.root && method === 'initial') { waiting = true; await new Promise(r => { release = r; }); }
    return call(method, spec);
  }; return c; };
  const start = f.runner.start('owner', f.spec); await wait(() => waiting);
  f.b.w.get(f.b.id).controlRevision++; release(); await assert.rejects(start, /身份|控制权|就绪/); assert.equal(f.sends.length, 0);
});
