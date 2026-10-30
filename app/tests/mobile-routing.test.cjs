const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { MobileAccess } = require('../mobile-access.cjs');
const { PeerLeases, PeerRunner, CAPABILITY, DIRECTED } = require('../peer-handoffs.cjs');
const { connectService } = require('../service-connection.cjs');
const { writeLayout } = require('../service-layout.cjs');
const caps = ['humanMobileV1', 'humanMobilePreparedV1', CAPABILITY, DIRECTED, 'agentWakeV1', 'nativeContextTransitions', 'structuredClaudeSubmit', 'claudePromptIdentity', 'verifiedHandoffs', 'boundedReplyHandoffs', 'multiSessionHandoffs', 'nativePermissionDefaults', 'nativeInputIsolation'];
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-routing-'))), services = new Map(), connections = [], keys = ['.', 'backends/' + 'a'.repeat(20), 'backends/' + 'b'.repeat(20)];
  for (const key of keys) fs.mkdirSync(path.join(root, key), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(root, 'backends'), 0o700);
  writeLayout(root, { format: 1, active: '.', entries: keys });
  for (const key of keys) {
    const calls = [], host = { binaries: {}, close() {}, create(record) {
      record.nativeId ||= randomUUID(); const r = new EventEmitter(); r.chatAvailable = true; r.addressedSendAvailable = true;
      r.start = async () => r.emit('state', 'idle');
      r.send = async (text, tag, valid) => { assert.equal(valid(), true); calls.push({ text, tag }); r.emit('submitted', tag); r.emit('state', 'working'); };
      return r;
    } };
    const w = new Workspace(host, path.join(root, key)), id = await w.create('claude', root, 'desktop-owner', key);
    w.peerLeases = new PeerLeases(w); services.set(key, { key, w, id, calls });
  }
  const connection = (key, owner = 'desktop-owner') => {
    const s = services.get(key), client = new EventEmitter(); client.destroyed = false; client.calls = [];
    client.call = async (method, ...args) => {
      client.calls.push(method);
      if (method === 'initial') return { ...s.w.snapshot(), owner, capabilities: caps, runtimeVersion: 'synthetic', defaultWorkspace: root };
      if (method === 'peerPrepare') return s.w.peerLeases.prepare(client, owner, args[0]);
      if (method === 'peerSend') return s.w.peerLeases.send(client, owner, args[0]);
      if (method === 'peerPause') { if (s.failPause) throw Error('Synthetic peer pause failed'); return s.w.peerLeases.pause(client, args[0]?.id); }
      if (method === 'peerRun') return s.w.peerRunner.start(owner, args[0]);
      if (method === 'pause') { await s.w.peerRunner.pause(); return s.w.pause('Synthetic human pause'); }
      if (method === 'mobileRead') return s.w.mobileRead(args[0]);
      if (method === 'mobilePrepareSend') { const ready = s.w.mobilePrepare(args[0], args[1], 'send', client); await s.afterPrepare?.(); return ready; }
      if (method === 'mobilePrepareAnswer') { const ready = s.w.mobilePrepare(args[0], args[1], 'answer', client); await s.afterPrepare?.(); return ready; }
      if (method === 'mobileCommitSend') { const result = await s.w.mobileCommit(args[0], args[1], 'send', client); if (s.loseCommit) throw Error('Synthetic lost commit acknowledgement'); return result; }
      if (method === 'mobileCommitAnswer') return s.w.mobileCommit(args[0], args[1], 'answer', client);
      if (method === 'mobileCancelSend') return s.w.mobileCancel(args[0], args[1], 'send', client, args[2]);
      if (method === 'mobileCancelAnswer') return s.w.mobileCancel(args[0], args[1], 'answer', client, args[2]);
      if (method === 'mobileSendReceipt') return s.w.mobileReceipt(args[0], args[1], 'send');
      if (method === 'send') return s.w.send(args[0], args[1], owner);
      throw Error('Unsupported synthetic operation');
    };
    client.close = () => { client.destroyed = true; s.w.peerLeases.disconnected(client); s.w.mobileDisconnected(client); client.emit('closed'); };
    connections.push(client); return client;
  };
  for (const s of services.values()) s.w.peerRunner = new PeerRunner(s.w, s.w.dataDir, async directory => connection(path.relative(root, directory) || '.'));
  const entries = await Promise.all(keys.map(async key => { const client = connection(key); return { key, client, state: await client.call('initial') }; }));
  const c = new WorkspaceClient(entries, '.', root), a = services.get('.'), b = services.get(keys[1]), d = services.get(keys[2]);
  const access = new MobileAccess(root, { exclusive: () => true }); access.initialize();
  const target = { serviceKey: '.', sessionId: a.id, nativeId: a.w.get(a.id).nativeId }, actor = 'synthetic-human', origin = 'https://mobile.invalid';
  const qr = access.beginPairing({ actor, origin, scopes: [{ ...target, actions: ['read', 'send', 'answer'] }] }), device = access.pair({ secret: qr.secret, actor, origin });
  const ticket = action => access.authorize({ token: device.cookieValue, actor, origin, csrf: device.csrf, action, target });
  const spec = text => ({ requestId: randomUUID(), text: text || 'Explicit phone original', proof: a.w.mobileRead(ticket('read')).proof });
  const start = async () => {
    b.w.join(b.id, true); d.w.join(d.id, true); await c.refresh();
    return c.call('run', [b.id, d.id], 'Original finite shared task', 2, 'replies');
  };
  t.after(async () => {
    b.failPause = false; d.failPause = false;
    for (const s of services.values()) await s.w.peerRunner.pause();
    c.close(); for (const client of connections) if (!client.destroyed) client.close();
    for (const s of services.values()) s.w.close(); fs.rmSync(root, { recursive: true });
  });
  return { root, services, c, a, b, d, entries, ticket, spec, start, access };
}
test('a fresh phone request pauses real cross-service peer routing before one private native send', async t => {
  const f = await fixture(t); await f.start(); assert.equal(f.a.w.room.run.status, 'running');
  const request = f.spec(); f.a.w.setDraft(f.a.id, request.text, 'desktop-owner');
  const result = await f.c.call('mobileSend', f.ticket('send'), request);
  assert.equal(result.status, 'submitted'); assert.equal(f.a.calls.length, 1); assert.equal(f.a.w.room.run.status, 'paused');
  for (const s of [f.b, f.d]) assert.equal(s.w.peerLeases.snapshot().some(g => g.status === 'running'), false);
  assert.equal(f.a.w.get(f.a.id).owner, 'desktop-owner'); assert.equal(f.a.w.drafts.get(f.a.id), request.text);
  assert.equal(Object.hasOwn(result, 'lease'), false);
});
test('phone input also pauses an ordinary two-member run on another single backend', async t => {
  const f = await fixture(t), other = await f.b.w.create('claude', f.root, 'desktop-owner', 'Second ordinary member');
  f.b.w.join(f.b.id, true); f.b.w.join(other, true);
  await f.b.w.startRun([f.b.id, other], 'Original ordinary shared task', 2, 'replies'); await f.c.refresh();
  assert.equal(f.b.w.room.run.status, 'running');
  const result = await f.c.call('mobileSend', f.ticket('send'), f.spec());
  assert.equal(result.status, 'submitted'); assert.equal(f.a.calls.length, 1); assert.equal(f.b.w.room.run.status, 'paused'); assert.equal(f.b.calls.length, 1);
});
test('a held native choice goes through the same strict pause and one-use answer path', async t => {
  const f = await fixture(t); await f.start(); const s = f.a.w.get(f.a.id), r = f.a.w.runtime(f.a.id), replies = []; let open = true;
  f.a.w.holdQuestion(s, r, { questions: [{ question: 'Only this original native question?', header: 'Choose', options: [{ label: 'Exact phone choice', description: 'Original choice' }] }], open: () => open, reply: answer => { replies.push(answer); open = false; } });
  s.state = 'working'; const q = s.claudeQuestion;
  const request = { requestId: randomUUID(), proof: f.a.w.mobileRead(f.ticket('read')).proof, questionId: q.requestId, answers: { 'Only this original native question?': ['Exact phone choice'] } };
  const result = await f.c.call('mobileAnswer', f.ticket('answer'), request);
  assert.equal(result.status, 'reply-written'); assert.deepEqual(replies, [{ answers: { 'Only this original native question?': 'Exact phone choice' } }]);
  assert.equal(f.a.w.room.run.status, 'paused'); assert.equal(s.owner, 'desktop-owner'); assert.equal(s.messages.length, 0);
  assert.equal(JSON.stringify(f.a.w.room.messages).includes('Exact phone choice'), false);
  assert.deepEqual(await f.c.call('mobileAnswer', f.ticket('answer'), request), result); assert.equal(replies.length, 1);
});
test('a fulfilled pause with actual pauseUnconfirmed refuses commit and keeps the phone not-sent', async t => {
  const f = await fixture(t); await f.start(); f.d.failPause = true;
  const result = await f.c.call('mobileSend', f.ticket('send'), f.spec());
  assert.equal(f.a.w.room.run.pauseUnconfirmed, true); assert.equal(result.status, 'not-sent'); assert.equal(f.a.calls.length, 0);
  assert.match(result.error, /旧接力尚未确认/); assert.equal(f.entries[0].client.calls.includes('mobileCommitSend'), false);
});
test('a duplicate phone request does not revoke a later explicit shared run', async t => {
  const f = await fixture(t), request = f.spec(), first = await f.c.call('mobileSend', f.ticket('send'), request);
  await f.start(); const revision = f.c.control.revision, boundary = fs.readFileSync(path.join(f.root, 'agent-wake-boundary'), 'utf8');
  assert.deepEqual(await f.c.call('mobileSend', f.ticket('send'), request), first);
  assert.equal(f.a.w.room.run.status, 'running'); assert.equal(f.c.control.revision, revision); assert.equal(f.a.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'agent-wake-boundary'), 'utf8'), boundary);
});
test('phone intervention invalidates an older frontend run still waiting on its first refresh', async t => {
  const f = await fixture(t); f.b.w.join(f.b.id, true); f.d.w.join(f.d.id, true); await f.c.refresh();
  const refresh = f.c.refresh.bind(f.c); let release, first = true;
  f.c.refresh = () => { if (first) { first = false; return new Promise(resolve => { release = () => refresh().then(resolve); }); } return refresh(); };
  const old = f.c.call('run', [f.b.id, f.d.id], 'Old delayed request', 2, 'replies');
  const rejected = assert.rejects(old, /真人操作/);
  const result = await f.c.call('mobileSend', f.ticket('send'), f.spec()); release(); await rejected;
  assert.equal(result.status, 'submitted'); assert.equal(f.a.calls.length, 1); assert.equal(f.b.calls.length + f.d.calls.length, 0);
});
test('new human action during prepare cancels the reservation without intervention or native input', async t => {
  const f = await fixture(t), revision = f.c.control.revision;
  f.a.afterPrepare = () => { f.c.control.sessionRevisions.set(f.a.id, 1); };
  const result = await f.c.call('mobileSend', f.ticket('send'), f.spec());
  assert.equal(result.status, 'not-sent'); assert.equal(f.a.calls.length, 0); assert.equal(f.c.control.revision, revision);
});
for (const phase of ['pauseExcept', 'refresh']) test('new human action during ' + phase + ' prevents the prepared native commit and preserves the newer draft', async t => {
  const f = await fixture(t); await f.start();
  const original = f.c[phase].bind(f.c); let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
  f.c[phase] = async (...args) => { const result = await original(...args); entered(); await resume; return result; };
  const request = f.spec(), sending = f.c.call('mobileSend', f.ticket('send'), request);
  t.after(() => release());
  await reached;
  assert.equal(f.a.w.mobileRequests[0].status, 'prepared'); assert.equal(f.a.calls.length, 0);
  await f.c.intervene(async () => f.a.w.setDraft(f.a.id, 'Newer explicit desktop draft', 'desktop-owner'), f.a.id);
  release(); const result = await sending;
  assert.equal(result.status, 'not-sent'); assert.equal(f.a.calls.length, 0);
  assert.equal(f.entries[0].client.calls.includes('mobileCommitSend'), false);
  assert.equal(f.entries[0].client.calls.includes('mobileCancelSend'), true);
  assert.equal(f.a.w.drafts.get(f.a.id), 'Newer explicit desktop draft');
  assert.equal(f.a.w.get(f.a.id).owner, 'desktop-owner');
});
test('an older backend refuses phone mutation without falling back to desktop ownership or agent wake', async t => {
  const f = await fixture(t), request = f.spec(), revision = f.c.control.revision;
  f.entries[0].state.capabilities = caps.filter(c => c !== 'humanMobilePreparedV1');
  await assert.rejects(f.c.call('mobileSend', f.ticket('send'), request), /预备确认/);
  assert.equal(f.a.calls.length, 0); assert.equal(f.a.w.mobileRequests.length, 0); assert.equal(f.c.control.revision, revision);
  assert.equal(f.a.w.get(f.a.id).owner, 'desktop-owner');
});
test('revocation during prepare cannot cancel another shared run or dispatch native input', async t => {
  const f = await fixture(t); await f.start(); const revision = f.c.control.revision, boundary = fs.readFileSync(path.join(f.root, 'agent-wake-boundary'), 'utf8');
  const ticket = f.ticket('send'), request = f.spec(); f.a.afterPrepare = () => { assert.equal(f.access.revoke().confirmed, true); };
  const result = await f.c.call('mobileSend', ticket, request);
  assert.equal(result.status, 'not-sent'); assert.equal(f.a.calls.length, 0); assert.equal(f.c.control.revision, revision);
  assert.equal(f.a.w.room.run.status, 'running'); assert.equal(fs.readFileSync(path.join(f.root, 'agent-wake-boundary'), 'utf8'), boundary);
});
test('a changed backend set after preparation cancels before global intervention', async t => {
  const f = await fixture(t), revision = f.c.control.revision, key = 'backends/' + 'c'.repeat(20);
  f.a.afterPrepare = () => { fs.mkdirSync(path.join(f.root, key), { mode: 0o700 }); writeLayout(f.root, { format: 1, active: '.', entries: ['.', ...[...f.services.keys()].filter(k => k !== '.'), key] }); };
  const result = await f.c.call('mobileSend', f.ticket('send'), f.spec());
  assert.equal(result.status, 'not-sent'); assert.equal(f.a.calls.length, 0); assert.equal(f.c.control.revision, revision); assert.match(result.error, /后台列表/);
});
test('a failed wake boundary blocks only phone commit, while ordinary desktop input still works', async t => {
  const f = await fixture(t), request = f.spec(); fs.chmodSync(path.join(f.root, 'agent-wake-boundary'), 0o644);
  const result = await f.c.call('mobileSend', f.ticket('send'), request);
  assert.equal(result.status, 'not-sent'); assert.equal(f.a.calls.length, 0); assert.match(result.error, /自动消息授权/);
  await f.c.call('send', f.a.id, 'Ordinary explicit desktop input', request.proof.nativeId); assert.equal(f.a.calls.length, 1);
});
test('a lost commit result is never cancelled or replayed; a receipt lookup finds native acceptance', async t => {
  const f = await fixture(t), request = f.spec(); f.a.loseCommit = true;
  await assert.rejects(f.c.call('mobileSend', f.ticket('send'), request), /lost commit acknowledgement/);
  assert.equal(f.a.calls.length, 1); assert.equal(f.entries[0].client.calls.includes('mobileCancelSend'), false);
  const result = await f.c.call('mobileSendReceipt', f.ticket('send'), request); assert.equal(result.status, 'submitted');
  assert.deepEqual(await f.c.call('mobileSend', f.ticket('send'), request), result); assert.equal(f.a.calls.length, 1);
});
test('real serialized Unix RPC binds preparations to their original socket and preserves native tag and draft', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-ipc-'))), cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  const child = fork(path.resolve(__dirname, '../daemon.cjs'), [root], { execArgv: ['--require', path.resolve(__dirname, 'fixtures/mobile-host.cjs')], env: { ...process.env, NAW_WORKSPACE: cwd, NAW_MOBILE_FIXTURE_ROOT: root, NAW_APP_VERSION: 'synthetic-mobile-test' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const clients = []; let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { for (const c of clients) c.close(); if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } fs.rmSync(root, { recursive: true }); });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(root, 'connection.json')); i++) { if (child.exitCode !== null) assert.fail(stderr); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(fs.existsSync(path.join(root, 'connection.json')), stderr);
  const client = await connectService(root, 'desktop-owner'), other = await connectService(root, 'desktop-owner'); clients.push(client, other);
  const id = await client.call('create', { provider: 'codex', cwd, name: 'Synthetic phone target', view: 'chat' });
  const second = await client.call('create', { provider: 'claude', cwd, name: 'Synthetic second target', view: 'chat' });
  const state = await client.call('initial'), session = state.sessions.find(s => s.id === id), secondSession = state.sessions.find(s => s.id === second);
  assert.ok(state.capabilities.includes('humanMobilePreparedV1'));
  const access = new MobileAccess(root, { exclusive: () => true }); access.initialize();
  const target = { serviceKey: '.', sessionId: id, nativeId: session.nativeId }, actor = 'synthetic-human', origin = 'https://mobile.invalid';
  const secondTarget = { serviceKey: '.', sessionId: second, nativeId: secondSession.nativeId };
  const qr = access.beginPairing({ actor, origin, scopes: [target, secondTarget].map(t => ({ ...t, actions: ['read', 'send'] })) }), device = access.pair({ secret: qr.secret, actor, origin });
  const ticket = (action, selected = target) => access.authorize({ token: device.cookieValue, actor, origin, csrf: device.csrf, action, target: selected });
  const view = await client.call('mobileRead', ticket('read')), spec = { requestId: randomUUID(), proof: view.proof, text: 'Exact synthetic IPC original' };
  await client.call('draft', id, spec.text);
  const ready = await client.call('mobilePrepareSend', ticket('send'), spec);
  assert.equal(ready.receipt.status, 'prepared'); assert.deepEqual(await other.call('mobilePrepareSend', ticket('send'), spec), { receipt: ready.receipt });
  await assert.rejects(other.call('mobileCommitSend', ticket('send'), ready.lease));
  const result = await client.call('mobileCommitSend', ticket('send'), ready.lease);
  assert.equal(result.status, 'submitted'); assert.equal(result.tag, ready.receipt.tag); assert.deepEqual(await client.call('mobileCommitSend', ticket('send'), ready.lease), result);
  const fresh = (await other.call('initial')).sessions.find(s => s.id === id); assert.equal(fresh.owner, 'desktop-owner'); assert.equal(fresh.liveDraft, spec.text);
  const closing = await connectService(root, 'desktop-owner'); clients.push(closing);
  const secondView = await closing.call('mobileRead', ticket('read', secondTarget)), next = { requestId: randomUUID(), proof: secondView.proof, text: 'Do not submit after disconnect' };
  const held = await closing.call('mobilePrepareSend', ticket('send', secondTarget), next); closing.close();
  let stored;
  for (let i = 0; i < 50; i++) {
    stored = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8')).mobileRequests.find(r => r.requestId === next.requestId);
    if (stored.status === 'not-sent') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(stored.status, 'not-sent', 'The actual daemon close callback persists invalidation');
  await assert.rejects(other.call('mobileCommitSend', ticket('send', secondTarget), held.lease));
  const duplicated = await other.call('mobilePrepareSend', ticket('send', secondTarget), next); assert.equal(duplicated.receipt.status, 'not-sent'); assert.equal(Object.hasOwn(duplicated, 'lease'), false);
  const count = await new Promise((resolve, reject) => {
    const key = randomUUID(), timer = setTimeout(() => reject(Error('Synthetic stats timeout')), 2000);
    const listener = value => { if (value?.mobileFixtureStats === key) { clearTimeout(timer); child.off('message', listener); resolve(value.calls); } };
    child.on('message', listener); child.send({ mobileFixture: 'stats', id: key });
  });
  assert.equal(count.length, 1); assert.equal(count[0].text, spec.text); assert.equal(count[0].tag, result.tag);
});
