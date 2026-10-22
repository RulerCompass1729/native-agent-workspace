const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { LegacyInput, installPlugin } = require('../legacy-input.cjs');
const { processIdentity } = require('../platform.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-input-')), directory = path.join(root, 'socket'), cwd = path.join(root, 'work');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({ pid: process.pid, endpoint: path.join(directory, 'desktop.sock') }), { mode: 0o600 });
  const record = { id: 'session', nativeId: crypto.randomUUID(), pid: process.pid, processIdentity: processIdentity(process.pid), provider: 'claude', terminalAvailable: true, cwd };
  const entry = { key: '.', state: { runtimeVersion: '0.1.0-alpha.2', servicePid: process.pid } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, cwd, record, entry };
}

test('compat installer refuses nested directory links without writing outside the plugin', t => {
  const { root, cwd } = fixture(t), plugin = path.join(cwd, '.claude/skills/native-workspace-compat');
  fs.mkdirSync(plugin, { recursive: true }); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(plugin, 'hooks'));
  assert.throws(() => installPlugin(cwd), /路径不安全/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('failed initialization never publishes a prepared target; fixing the store permits retry', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root); t.after(() => bridge.close());
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), 'invalid');
  await assert.rejects(bridge.prepare(f.entry, f.record)); assert.equal(bridge.prepared(f.record), false);
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), '[]');
  await bridge.prepare(f.entry, f.record); assert.equal(bridge.prepared(f.record), true);
  const descriptor = JSON.parse(fs.readFileSync(path.join(f.directory, `gui-${f.record.nativeId}.json`)));
  assert.equal(descriptor.sessionId, f.record.nativeId); assert.equal(fs.statSync(path.join(f.directory, `gui-${f.record.nativeId}.json`)).mode & 0o777, 0o600);
  assert.equal(bridge.connected(f.record), false); assert.equal(bridge.connected({ ...f.record, pid: process.pid + 1 }), false);
  const code = fs.readFileSync(path.join(f.cwd, '.claude/skills/native-workspace-compat/hooks/register.js'), 'utf8');
  assert.ok(code.includes('const legacyOnly = true;')); assert.equal(bridge.records.length, 0);
});

for (const cache of ['corrupt', 'missing', 'valid']) test(`restored ${cache} reader cannot expose raw old final in initial or later snapshots`, async t => {
  const f = fixture(t), { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs');
  const { readerPath } = require('../legacy-claude.cjs');
  f.record.messages = [{ id: 'old-raw', role: 'assistant', text: 'RAW_UNTRANSFORMED_FINAL' }]; f.record.state = 'idle';
  Object.assign(f.entry.state, { owner: 'test', sessions: [f.record], room: { messages: [], revision: 0 }, diagnostics: {}, capabilities: [] });
  const transport = new EventEmitter(); transport.call = async () => f.entry.state; transport.close = () => {};
  f.entry.client = transport;
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), JSON.stringify([{ id: f.record.id, pid: f.record.pid, nativeId: f.record.nativeId, key: '.', readerStarted: true }]), { mode: 0o600 });
  if (cache !== 'missing') fs.writeFileSync(readerPath(f.root, f.record.nativeId), cache === 'corrupt' ? '{}' : JSON.stringify({ nativeId: f.record.nativeId,
    processIdentity: f.record.processIdentity, messages: [{ id: 'visible', role: 'assistant', text: 'transformed visible text' }] }), { mode: 0o600 });
  const client = new WorkspaceClient([f.entry], '.', f.root); t.after(() => client.close());
  assert.ok(!JSON.stringify(client.snapshot().sessions[0].messages).includes('RAW_UNTRANSFORMED_FINAL'));
  await new Promise(resolve => setTimeout(resolve, 40));
  const rows = client.snapshot().sessions[0].messages;
  assert.ok(!JSON.stringify(rows).includes('RAW_UNTRANSFORMED_FINAL'));
  assert.ok(rows.some(m => cache === 'valid' ? m.text === 'transformed visible text' : m.kind === 'gap'));
});

test('explicit record removal also removes only its retained projection and connection metadata', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root); t.after(() => bridge.close());
  const { readerPath } = require('../legacy-claude.cjs');
  const file = readerPath(f.root, f.record.nativeId), other = readerPath(f.root, crypto.randomUUID());
  fs.writeFileSync(file, '{}', { mode: 0o600 }); fs.writeFileSync(other, '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), JSON.stringify([{ id: f.record.id, nativeId: f.record.nativeId }, { id: 'other' }]), { mode: 0o600 });
  bridge.forgetReader(f.record);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(other), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'legacy-links.json'))), [{ id: 'other' }]);
});

test('ended retained Claude keeps its projected history with a null PID and after reopening', async t => {
  const f = fixture(t), { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs');
  const { readerPath } = require('../legacy-claude.cjs');
  f.record.messages = [{ id: 'old-raw', role: 'assistant', text: 'RAW_UNTRANSFORMED_FINAL' }]; f.record.state = 'idle';
  Object.assign(f.entry.state, { owner: 'test', sessions: [f.record], room: { messages: [], revision: 0 }, diagnostics: {}, capabilities: [] });
  const transport = new EventEmitter(); transport.call = async () => f.entry.state; transport.close = () => {};
  f.entry.client = transport;
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), JSON.stringify([{ id: f.record.id, pid: f.record.pid, nativeId: f.record.nativeId, key: '.', readerStarted: true }]), { mode: 0o600 });
  fs.writeFileSync(readerPath(f.root, f.record.nativeId), JSON.stringify({ nativeId: f.record.nativeId, processIdentity: f.record.processIdentity,
    messages: [{ id: 'visible', role: 'assistant', text: 'transformed visible text' }] }), { mode: 0o600 });
  let client = new WorkspaceClient([f.entry], '.', f.root); t.after(() => client.close());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(client.control.legacyInput.target(f.record));
  f.record.pid = null; f.record.state = 'ended';
  await client.refresh();
  const check = () => {
    const session = client.snapshot().sessions[0];
    assert.equal(session.state, 'ended'); assert.equal(session.pid, null);
    assert.ok(!JSON.stringify(session.messages).includes('RAW_UNTRANSFORMED_FINAL'));
    assert.ok(session.messages.some(m => m.text === 'transformed visible text'));
    assert.equal(client.control.legacyInput.target(f.record), null);
  };
  check(); client.close();
  client = new WorkspaceClient([f.entry], '.', f.root);
  check(); await new Promise(resolve => setTimeout(resolve, 40)); check();
  assert.equal(client.control.legacyInput.servers.size, 0, 'Ended history needs no new input transport');
});

test('a second window keeps the live retained reader and receives later native output', async t => {
  const f = fixture(t), { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs');
  f.record.state = 'idle'; f.record.messages = [];
  Object.assign(f.entry.state, { owner: 'test', sessions: [f.record], room: { messages: [], revision: 0 }, diagnostics: {}, capabilities: [] });
  const transport = new EventEmitter(); transport.call = async () => f.entry.state; transport.close = () => {};
  f.entry.client = transport;
  const a = new WorkspaceClient([f.entry], '.', f.root); t.after(() => a.close());
  const bridge = a.control.legacyInput; await bridge.prepare(f.entry, f.record);
  const live = bridge.target(f.record), binding = await live.bindRoot({ sessionId: f.record.nativeId, nativeBlocks: true });
  const push = (sequence, index, delta) => live.observeRoot({ sessionId: f.record.nativeId, ...binding,
    epoch: binding.observationEpoch, sequence, block: true, id: 'display:live', kind: 'response', turnId: 'turn-live', promptId: 'prompt-live', index, delta, status: 'streaming' });
  push(1, 0, 'visible prefix'); live.save();
  const b = new WorkspaceClient([f.entry], '.', f.root); t.after(() => b.close());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(bridge.reader(f.record), live);
  push(2, 1, ' and fresh output');
  for (const view of [a, b]) assert.ok(view.snapshot().sessions[0].messages.some(m => m.text === 'visible prefix and fresh output'));
  assert.equal(bridge.readerUnavailable(f.record), false);
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.ok(fs.readFileSync(live.filename, 'utf8').includes('visible prefix and fresh output'));
});

test('closing while listen is pending cannot publish a late descriptor or listener', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root);
  const pending = bridge.prepare(f.entry, f.record); bridge.close();
  await assert.rejects(pending, /窗口连接已关闭/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bridge.targets.size, 0); assert.equal(bridge.servers.size, 0);
  assert.equal(fs.existsSync(path.join(f.directory, `gui-${f.record.nativeId}.json`)), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'gui-submit.sock')), false);
});

// Faithful alpha.2 draft semantics: the service does NOT check owner on setDraft.
function oldWindows(t) {
  const { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs');
  const scope = Symbol(), session = { id: 'legacy', provider: 'claude', pid: process.pid, nativeId: 'native', owner: 'A', controlRevision: 0, memberRevision: 0, liveDraft: '', state: 'idle' };
  const calls = [], windows = [];
  const open = owner => {
    const transport = new EventEmitter();
    const snapshot = () => ({ runtimeVersion: '0.1.0-alpha.2', owner, capabilities: [], sessions: [{ ...session }], room: { messages: [], revision: 0 }, diagnostics: { dispatches: 0, shellModelCalls: 0 } });
    transport.call = async (method, id, value) => {
      if (method === 'initial') return snapshot();
      calls.push([owner, method, value]);
      if (method === 'draft') session.liveDraft = value;
      if (['claim', 'terminal', 'interrupt'].includes(method) && session.owner !== owner) { session.owner = owner; session.controlRevision++; }
    };
    transport.close = () => transport.emit('closed');
    const entry = { key: '.', state: snapshot(), client: transport };
    const client = new WorkspaceClient([entry], '.', scope); windows.push(client);
    return { client, transport };
  };
  t.after(() => windows.forEach(w => w.close()));
  return { a: open('A'), b: open('B'), session, calls };
}

test('old unguarded draft service cannot receive a former portal owner write after takeover', async t => {
  const f = oldWindows(t);
  await f.b.client.call('claim', 'legacy', 'chat'); await f.b.client.call('draft', 'legacy', 'B new private draft');
  await assert.rejects(f.a.client.call('draft', 'legacy', 'A stale private draft'), /控制权或草稿已变化/);
  assert.equal(f.session.liveDraft, 'B new private draft');
  assert.equal(f.calls.some(([owner, method]) => owner === 'A' && method === 'draft'), false);
});

test('same-owner native input does not reject a GUI draft during a view switch', async t => {
  const f = oldWindows(t);
  // The native input advances controlRevision before its state broadcast.
  f.session.controlRevision++;
  await f.a.client.call('draft', 'legacy', 'new GUI draft');
  assert.equal(f.session.liveDraft, 'new GUI draft');
  f.session.controlRevision++;
  await f.a.client.call('claim', 'legacy', 'terminal');
  f.session.controlRevision++;
  await f.a.client.call('terminal', 'legacy');
  assert.equal(f.session.owner, 'A');
});

test('queued stale interrupt cannot silently take control back while another window edits', async t => {
  const f = oldWindows(t); let release;
  const gate = f.a.client.legacyMutation(f.a.client.entries[0], () => new Promise(r => { release = r; }));
  while (!release) await new Promise(r => setImmediate(r));
  const takeover = f.b.client.call('claim', 'legacy', 'chat');
  const interrupt = assert.rejects(f.a.client.call('interrupt', 'legacy'), /其他窗口接管/);
  release(); await gate; await takeover; await interrupt;
  await f.b.client.call('draft', 'legacy', 'B owns this draft');
  assert.equal(f.session.owner, 'B');
  assert.equal(f.calls.some(([, method]) => method === 'interrupt'), false);
  assert.equal(f.session.liveDraft, 'B owns this draft');
});

test('explicit A-B-A ownership round trip invalidates an already queued draft', async t => {
  const f = oldWindows(t); let release;
  const gate = f.a.client.legacyMutation(f.a.client.entries[0], () => new Promise(r => { release = r; }));
  while (!release) await new Promise(r => setImmediate(r));
  const takeover = f.b.client.call('claim', 'legacy', 'chat');
  // Queue a draft after the pending takeover, with the still-visible A epoch.
  const draft = assert.rejects(f.a.client.call('draft', 'legacy', 'old A text'), /控制权或草稿/);
  release(); await gate; await takeover; await draft;
  await f.a.client.refresh(); await f.a.client.call('claim', 'legacy', 'chat');
  assert.equal(f.session.owner, 'A');
  assert.equal(f.session.liveDraft, '');
});

test('late old initial cannot reverse observed ownership or reject the new owner draft', async t => {
  const f = oldWindows(t), original = f.a.transport.call; let release, held = false;
  f.a.transport.call = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'initial' && !held) { held = true; await new Promise(r => { release = r; }); }
    return result;
  };
  const stale = f.a.client.refresh();
  while (!release) await new Promise(r => setImmediate(r));
  await f.b.client.call('claim', 'legacy', 'chat');
  const epoch = f.b.client.control.legacyOwners.get('legacy').revision;
  release(); await stale;
  assert.equal(f.a.client.control.legacyOwners.get('legacy').revision, epoch);
  assert.equal(f.a.client.entries[0].state.sessions[0].owner, 'B');
  await f.b.client.call('draft', 'legacy', 'new owner text');
  assert.equal(f.session.liveDraft, 'new owner text');
});

test('accepted native message remains accepted when post-ACK storage fails', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root); t.after(() => bridge.close());
  let sends = 0, writes = 0;
  bridge.targets.set(f.record.id, { record: f.record, submission: { connected: true, close() {} },
    native: { async send() { sends++; } } });
  bridge.save = () => { if (++writes > 1) throw Error('Synthetic disk full'); };
  const tag = await bridge.send(f.record, 'one requested message', async () => {}, () => true);
  assert.equal(tag, bridge.records[0].id);
  assert.equal(bridge.records[0].status, 'accepted');
  assert.equal(sends, 1);
  assert.match(bridge.storageWarning, /已接收.*未能保存/);
  await assert.rejects(bridge.send(f.record, 'another message', async () => {}, () => true));
  assert.equal(sends, 1);
});

test('only explicitly shared text persists in the shared timeline; no automatic reply inference', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root); t.after(() => bridge.close());
  const target = { record: { ...f.record, name: 'Test agent' }, submission: { connected: true, close() {} },
    native: { async send() {} } };
  bridge.targets.set(f.record.id, target);
  await bridge.send(target.record, 'private conversation', async () => {}, () => true);
  await bridge.send(target.record, 'explicit shared task', async () => {}, () => true, true);
  const persisted = fs.readFileSync(bridge.filename, 'utf8');
  assert.equal(persisted.includes('private conversation'), false);
  const cold = new LegacyInput(f.root); t.after(() => cold.close());
  assert.deepEqual(cold.sharedMessages().map(m => [m.text, m.status, m.role, m.manualReply]),
    [['explicit shared task', 'submitted', 'human', true]]);
  const receipt = cold.sharedMessages()[0].deliveries[0];
  assert.equal(receipt.text, 'explicit shared task'); assert.equal(receipt.recipientId, f.record.id);
  assert.equal(receipt.recipientName, 'Test agent'); assert.equal(receipt.status, 'submitted');
  bridge.emit('complete', f.record.id, { text: 'private unrelated reply' });
  assert.equal(bridge.sharedMessages().length, 1);
  cold.clearSharedHistory();
  assert.equal(cold.sharedMessages().length, 0);
  assert.equal(fs.readFileSync(bridge.filename, 'utf8').includes('explicit shared task'), false);
  assert.equal(cold.records.length, 2, 'Dispatch accounting is retained');
});

test('clearing a pending shared row retains late ACK and never erases a newer share', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root); t.after(() => bridge.close());
  let accept, sent = 0;
  bridge.targets.set(f.record.id, { record: f.record, submission: { connected: true, close() {} },
    native: { async send() { if (++sent === 1) await new Promise(r => { accept = r; }); } } });
  const first = bridge.send(f.record, 'old explicit share', async () => {}, () => true, true);
  const selectedIds = bridge.sharedMessages().map(m => m.id);
  await bridge.send(f.record, 'new explicit share', async () => {}, () => true, true);
  bridge.clearSharedHistory(selectedIds);
  accept(); await first;
  const cold = new LegacyInput(f.root); t.after(() => cold.close());
  assert.deepEqual(cold.records.map(row => row.status), ['accepted', 'accepted']);
  assert.deepEqual(cold.sharedMessages().map(m => m.text), ['new explicit share']);
  assert.equal(fs.readFileSync(bridge.filename, 'utf8').includes('old explicit share'), false);
});

test('retained direct sharing uses the authorized bridge and keeps the solo draft', async t => {
  const f = oldWindows(t); f.session.roomId = 'shared'; await f.a.client.refresh();
  await f.a.client.call('draft', 'legacy', 'shared task');
  const sends = [];
  f.a.client.control.legacyInput = { target: () => null, connected: () => true, prepared: () => false, records: [], close() {},
    async send(record, text, refresh, guard, shared) { await refresh(); assert.equal(guard(), true); sends.push({ text, shared }); return 'accepted'; } };
  assert.equal(await f.a.client.call('forward', 'legacy', 'shared task'), 'accepted');
  assert.deepEqual(sends, [{ text: 'shared task', shared: true }]);
  assert.equal(f.session.liveDraft, 'shared task');
  assert.equal(f.calls.some(([, method]) => ['send', 'forward'].includes(method)), false, 'Never invoke old unsafe sender');
  f.session.roomId = null;
  await assert.rejects(f.a.client.call('forward', 'legacy', 'must stay private'), /离开/);
  assert.equal(sends.length, 1);
});

test('membership, ownership and human changes revoke direct share at the dispatch boundary', async t => {
  for (const change of ['membership', 'owner', 'human']) {
    const f = oldWindows(t); f.session.roomId = 'shared'; await f.a.client.refresh(); let dispatches = 0;
    f.a.client.control.legacyInput = { target: () => null, connected: () => true, prepared: () => false, records: [], close() {},
      async send(record, text, refresh, guard) {
        if (change === 'membership') { f.session.roomId = null; f.session.memberRevision++; }
        if (change === 'owner') { f.session.owner = 'B'; f.session.controlRevision++; }
        if (change === 'human') f.session.controlRevision++;
        await refresh(); if (guard()) dispatches++; return 'should-not-reach';
      } };
    await assert.rejects(f.a.client.call('forward', 'legacy', 'revoked task'), /已变化/);
    assert.equal(dispatches, 0);
  }
});

test('leaving and regaining ownership cannot revive an older queued draft', async t => {
  const f = oldWindows(t), original = f.a.transport.call; let release, held = false;
  f.a.transport.call = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'initial' && !held) { held = true; await new Promise(r => { release = r; }); }
    return result;
  };
  const pending = f.a.client.call('draft', 'legacy', 'stale draft');
  const rejected = assert.rejects(pending, /控制权或草稿已变化/);
  while (!release) await new Promise(r => setImmediate(r));
  f.session.owner = 'B'; await f.b.client.refresh();
  f.session.owner = 'A'; await f.b.client.refresh();
  release(); await rejected;
  assert.equal(f.session.liveDraft, '');
});

test('legacy draft refresh/write and another window takeover are ordered together', async t => {
  const f = oldWindows(t), call = f.a.transport.call; let release;
  f.a.transport.call = async (...args) => {
    const result = await call(...args);
    if (args[0] === 'initial') await new Promise(resolve => { release = resolve; });
    return result;
  };
  const oldDraft = f.a.client.call('draft', 'legacy', 'A queued');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const takeover = f.b.client.call('claim', 'legacy', 'chat').then(() => f.b.client.call('draft', 'legacy', 'B latest'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.owner, 'A');
  release(); await oldDraft; await takeover;
  assert.equal(f.session.owner, 'B'); assert.equal(f.session.liveDraft, 'B latest');
});

test('accepted legacy send never clears another owner or a newer same-text draft', async t => {
  for (const takeover of [false, true]) {
    const f = oldWindows(t); await f.a.client.call('draft', 'legacy', 'task'); let accepted;
    f.a.client.control.legacyInput = { target: () => null, connected: () => true, prepared: () => false, records: [], close() {}, send: async () => new Promise(resolve => { accepted = () => resolve('native-accepted'); }) };
    const sending = f.a.client.call('send', 'legacy', 'task');
    while (!accepted) await new Promise(resolve => setImmediate(resolve));
    if (takeover) await f.b.client.call('claim', 'legacy', 'chat');
    await (takeover ? f.b : f.a).client.call('draft', 'legacy', 'task');
    accepted(); assert.equal(await sending, 'native-accepted'); assert.equal(f.session.liveDraft, 'task');
  }
});

test('viewing an owned legacy session does not pause peer collaboration; stale view never reclaims', async t => {
  const f = oldWindows(t); let pauses = 0;
  f.a.client.pauseExcept = async () => { pauses++; };
  f.b.client.pauseExcept = async () => { pauses++; };
  await f.a.client.call('claim', 'legacy', 'terminal'); await f.a.client.call('terminal', 'legacy');
  assert.equal(pauses, 0);
  await f.b.client.call('claim', 'legacy', 'chat'); assert.equal(pauses, 1);
  await assert.rejects(f.a.client.call('claim', 'legacy', 'chat'), /其他窗口接管/);
  assert.equal(f.session.owner, 'B'); assert.equal(pauses, 1);
});

test('released alpha.51 compatibility hook upgrades, edited copies remain untouched', t => {
 const {cwd}=fixture(t),file=path.join(cwd,'.claude/skills/native-workspace-compat/hooks/register.js');
 const previous=fs.readFileSync(path.join(__dirname,'fixtures/claude-compat-alpha51.js'),'utf8');
 assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),'79a701e38fa7ab32e0551c2aa6c364bf34cd4ccd5942ab5ae899463f7b355cc6');
 installPlugin(cwd);const current=fs.readFileSync(file,'utf8');fs.writeFileSync(file,previous);installPlugin(cwd);assert.equal(fs.readFileSync(file,'utf8'),current);
 const edited=previous+'\n// Human customization\n';fs.writeFileSync(file,edited);assert.throws(()=>installPlugin(cwd),/未覆盖/);assert.equal(fs.readFileSync(file,'utf8'),edited);
});
