const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { WebSocketServer } = require('ws');
const { LegacyCodex, retainedSocket } = require('../legacy-codex.cjs');
const { LegacyInput } = require('../legacy-input.cjs');
const { processIdentity } = require('../platform.cjs');

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-codex-'));
  const socket = path.join(directory, 'codex.sock'), server = http.createServer(), sockets = new Set();
  const record = { id: crypto.randomUUID(), nativeId: crypto.randomUUID(), provider: 'codex', pid: process.pid, processIdentity: processIdentity(process.pid), serverIdentity: processIdentity(process.pid) };
  const calls = [];
  const wss = new WebSocketServer({ server });
  let connection, started = false;
  wss.on('connection', ws => {
    connection = ws; sockets.add(ws); ws.on('close', () => sockets.delete(ws));
    ws.on('message', bytes => {
      const m = JSON.parse(bytes); calls.push(m);
      const reply = result => ws.send(JSON.stringify({ id: m.id, result }));
      if (m.method === 'initialize') reply({ userAgent: 'codex/0.163.0' });
      if (m.method === 'turn/steer') { if (options.steer) options.steer(m, reply, event); else reply({ turnId: m.params.expectedTurnId }); }
      if (m.method === 'thread/loaded/list') {
        const result = { data: options.notLoaded ? [] : [record.nativeId], nextCursor: null };
        if (options.loaded) options.loaded(() => reply(result)); else reply(result);
      }
      if (m.method === 'thread/read') reply({ thread: { id: record.nativeId, status: { type: options.notLoaded ? 'notLoaded' : 'idle' } } });
      if (m.method === 'thread/resume') {
        if (options.empty && !started) ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: 'no rollout found for thread id ' + record.nativeId } }));
        else if (options.resume) options.resume(reply, event, error => ws.send(JSON.stringify({ id: m.id, error })));
        else reply({ model: 'synthetic-small', thread: { id: record.nativeId, status: { type: 'idle' } } });
      }
      if (m.method === 'thread/items/list') {
        if (options.items) options.items(m, reply, event);
        else reply({ data: [], nextCursor: null });
      }
      if (m.method === 'thread/turns/list') reply({ data: options.turns || [{ id: 'owned-turn', status: 'completed', items: [{ id: 'final', type: 'agentMessage', text: 'first reply' }] }] });
      if (m.method === 'turn/start') {
        started = true;
        if (options.start) options.start(m, reply, event);
        else reply({ turn: { id: 'owned-turn' } });
      }
    });
  });
  const event = (method, params) => connection.send(JSON.stringify({ method, params: { threadId: record.nativeId, ...params } }));
  await new Promise(resolve => server.listen(socket, resolve));
  fs.chmodSync(socket, 0o600);
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, pid: process.pid, endpoint: path.join(directory, 'desktop.sock') }), { mode: 0o600 });
  const entry = { key: '.', state: { runtimeVersion: '0.1.0-alpha.2', servicePid: process.pid } };
  t.after(async () => { for (const ws of sockets) ws.terminate(); wss.close(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, socket, record, calls, event, entry, request: m => connection.send(JSON.stringify(m)) };
}
const tick = () => new Promise(r => setTimeout(r, 20));

test('retained connection preserves settings and only closes its own transport', async t => {
  const f = await fixture(t), target = new LegacyCodex(f.record);
  t.after(() => target.close());
  await target.connect(retainedSocket(f.directory, f.entry, f.record));
  assert.equal(target.connected, true);
  assert.deepEqual(f.calls.find(c => c.method === 'thread/resume').params, { threadId: f.record.nativeId, excludeTurns: true });
  assert.equal(f.calls.some(c => ['thread/start', 'turn/start', 'turn/interrupt'].includes(c.method)), false);
  target.close(); await tick();
  assert.equal(f.calls.some(c => c.method === 'thread/unsubscribe'), false);
});

test('unloaded native identity is rejected without resume or model requests', async t => {
  const f = await fixture(t, { notLoaded: true }), target = new LegacyCodex(f.record); t.after(() => target.close());
  await assert.rejects(target.connect(f.socket), /未处于可连接/);
  assert.equal(f.calls.some(c => c.method === 'thread/resume' || c.method === 'turn/start'), false);
});

test('retained native history, live deltas and input share one reader without changing the writer or creating a turn', async t => {
  let release;
  const f = await fixture(t, { items(_request, reply) { release = reply; } });
  const target = new LegacyCodex(f.record); t.after(() => target.close());
  const connecting = target.connect(f.socket); while (!release) await tick();
  f.event('item/agentMessage/delta', { turnId: 'live-turn', itemId: 'live-answer', delta: 'new live text' }); await tick();
  release({ data: [
    { turnId: 'old', item: { type: 'userMessage', id: 'old-human', content: [{ type: 'text', text: 'hello' }] } },
    { turnId: 'old', item: { type: 'agentMessage', id: 'old-answer', text: 'hello back' } },
    { turnId: 'live-turn', item: { type: 'agentMessage', id: 'live-answer', text: 'stale prefix' } },
  ], nextCursor: null }); await connecting;
  assert.deepEqual(target.record.messages.map(m => m.text), ['hello', 'hello back', 'new live text']);
  assert.equal(target.model, 'synthetic-small');
  f.event('item/agentMessage/delta', { turnId: 'live-turn', itemId: 'live-answer', delta: ' more' }); await tick();
  assert.equal(target.record.messages.at(-1).text, 'new live text more');
  f.event('item/completed', { turnId: 'live-turn', item: { type: 'agentMessage', id: 'live-answer', text: 'final live answer' } }); await tick();
  assert.equal(target.record.messages.at(-1).text, 'final live answer');
  assert.equal(target.record.messages.filter(m => m.id === 'live-answer').length, 1);
  assert.equal(f.calls.some(c => ['thread/start', 'turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(c.method)), false);
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1);
});

test('retained GUI input is immediately visible and later exact native echo does not duplicate it', async t => {
  let release;
  const f = await fixture(t, { start(_request, reply) { release = reply; } });
  const target = new LegacyCodex(f.record); t.after(() => target.close()); await target.connect(f.socket);
  const sending = target.send('visible input', 'gui-input', async () => {}, () => true);
  while (!release) await tick();
  assert.equal(target.record.messages.at(-1).text, 'visible input');
  assert.equal(target.record.messages.at(-1).status, 'awaiting-native');
  f.event('item/completed', { turnId: 'owned-turn', item: { type: 'userMessage', id: 'native-input', clientId: 'gui-input', content: [{ type: 'text', text: 'visible input' }] } });
  release({ turn: { id: 'owned-turn' } }); await sending; await tick();
  assert.equal(target.record.messages.filter(m => m.text === 'visible input').length, 1);
  assert.equal(target.record.messages.at(-1).status, 'submitted');
});

test('retained nonempty cache reconciles native history once, replaces stale partials and retains newer live completion', async t => {
  let release;
  const f = await fixture(t, { items(_request, reply) { release = reply; } });
  const target = new LegacyCodex({ ...f.record, messages: [
    { id: 'legacy-random-user', role: 'user', origin: 'native', text: 'same question', status: 'submitted' },
    { id: 'cached-answer', role: 'assistant', text: 'stale partial', status: 'streaming' },
    { id: 'live-answer', role: 'assistant', text: 'old live cache', status: 'streaming' },
  ] }); t.after(() => target.close());
  const connecting = target.connect(f.socket); while (!release) await tick();
  f.event('item/agentMessage/delta', { turnId: 'old', itemId: 'cached-answer', delta: 'unknown overlapping suffix' });
  f.event('item/completed', { turnId: 'live', item: { type: 'agentMessage', id: 'live-answer', text: 'newest live completion' } }); await tick();
  release({ data: [
    { turnId: 'old', item: { type: 'userMessage', id: 'actual-user', content: [{ type: 'text', text: 'same question' }] } },
    { turnId: 'old', item: { type: 'agentMessage', id: 'cached-answer', text: 'complete native history' } },
    { turnId: 'live', item: { type: 'agentMessage', id: 'live-answer', text: 'outdated snapshot' } },
  ] }); await connecting;
  assert.deepEqual(target.record.messages.map(m => m.text), ['same question', 'complete native history', 'newest live completion']);
  assert.equal(target.record.messages[0].id, 'actual-user');
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});

test('empty retained thread receives exactly the requested first turn, then joins its native events', async t => {
  const f = await fixture(t, { empty: true }), target = new LegacyCodex({ ...f.record, messages: [] }), completed = [];
  t.after(() => target.close()); target.on('complete', r => completed.push(r));
  await target.connect(f.socket);
  assert.equal(target.subscribed, false);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  await target.send('first real task', 'first-tag', async () => {}, () => true);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(f.calls.find(c => c.method === 'turn/start').params.threadId, f.record.nativeId);
  assert.equal(target.subscribed, true);
  assert.equal(completed.find(r => r.tag === 'first-tag').text, 'first reply');
});

for (const mode of ['before-ack', 'after-error', 'foreign-input', 'other-turn', 'permission', 'disconnect', 'other-error']) test(`first retained shared input with unsupported live turn listing: ${mode}`, async t => {
  let tag, native;
  const accepted = event => {
    event('item/completed', { turnId: mode === 'other-turn' ? 'foreign-turn' : 'owned-turn',
      item: { type: 'userMessage', id: 'native-input', clientId: mode === 'foreign-input' ? 'foreign-tag' : tag, content: [{ type: 'text', text: 'shared first task' }] } });
  };
  const f = await fixture(t, { empty: true, start(m, reply, event) {
    tag = m.params.clientUserMessageId;
    event('turn/started', { turn: { id: 'owned-turn' } });
    if (mode === 'before-ack') accepted(event);
    reply({ turn: { id: 'owned-turn' } });
  }, resume(_reply, event, reject) {
    reject({ code: -32601, message: mode === 'other-error' ? 'unrelated native failure' : 'list_turns is not supported yet' });
    if (mode !== 'before-ack') setTimeout(() => {
      if (mode === 'disconnect') { native.close(); return; }
      if (mode === 'permission') native.adapter.emit('approval', { requestId: 'permission' });
      accepted(event);
    }, 20);
  } });
  Object.assign(f.record, { name: 'Codex A', roomId: 'shared', state: 'idle', messages: [] });
  const bridge = new LegacyInput(f.directory); t.after(() => bridge.close()); await bridge.prepare(f.entry, f.record);
  native = bridge.target(f.record).native;
  await bridge.send(f.record, 'shared first task', async () => {}, () => true, true, undefined, undefined, false, () => true);
  await tick();
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(bridge.records[0].status, 'accepted', 'Observation failure must not turn accepted input into a retry');
  if (mode !== 'disconnect') {
    f.event('item/started', { turnId: 'owned-turn', item: { id: 'answer', type: 'agentMessage' } });
    f.event('item/agentMessage/delta', { turnId: 'owned-turn', itemId: 'answer', delta: 'first shared answer' });
    await tick();
    f.event('item/completed', { turnId: 'owned-turn', item: { id: 'answer', type: 'agentMessage', text: 'first shared answer complete' } });
    f.event('turn/completed', { turn: { id: 'owned-turn', status: 'completed' } }); await tick();
  }
  const shared = bridge.sharedMessages().filter(m => m.role === 'assistant');
  if (['before-ack', 'after-error'].includes(mode)) {
    assert.equal(native.subscribed, true); assert.equal(shared.length, 1);
    assert.equal(shared[0].text, 'first shared answer complete'); assert.equal(shared[0].finalReply, true);
  } else assert.equal(shared.length, 0, 'Unverified input or revoked authority cannot share a reply');
  assert.equal(native.adapter.listenerCount('nativeAcceptedInput'), 0);
});

test('provider socket redirect requires a private owned endpoint', async t => {
  const f = await fixture(t);
  const native = path.join(f.directory, 'native'); fs.mkdirSync(native, { mode: 0o700 });
  const target = path.join(native, 'transport.sock');
  fs.renameSync(f.socket, target); fs.symlinkSync(target, f.socket);
  assert.equal(retainedSocket(f.directory, f.entry, f.record), fs.realpathSync(target));
  fs.chmodSync(native, 0o755);
  assert.throws(() => retainedSocket(f.directory, f.entry, f.record), /接口不可用/);
});

test('closing a pending manager connection never resumes after the loaded reply', async t => {
  let release;
  const f = await fixture(t, { loaded: r => { release = r; } }), manager = new LegacyInput(f.directory);
  t.after(() => manager.close());
  const pending = manager.prepare(f.entry, f.record);
  const rejected = assert.rejects(pending);
  while (!release) await new Promise(r => setImmediate(r));
  manager.close();
  await rejected; await tick();
  assert.equal(f.calls.some(c => c.method === 'thread/resume'), false);
  assert.equal(manager.targets.size, 0);
  assert.equal(manager.connecting.size, 0);
});

test('parallel Codex and Claude connections both retain their restart links', async t => {
  let release;
  const f = await fixture(t, { loaded: r => { release = r; } }), manager = new LegacyInput(f.directory);
  t.after(() => manager.close());
  const connecting = manager.prepare(f.entry, f.record);
  while (!release) await new Promise(r => setImmediate(r));
  const cwd = path.join(f.directory, 'claude-work'); fs.mkdirSync(cwd);
  const claude = { ...f.record, id: crypto.randomUUID(), nativeId: crypto.randomUUID(), provider: 'claude', terminalAvailable: true, cwd };
  await manager.prepare(f.entry, claude);
  release(); await connecting;
  const links = JSON.parse(fs.readFileSync(path.join(f.directory, 'legacy-links.json'), 'utf8'));
  assert.deepEqual(new Set(links.map(link => link.id)), new Set([f.record.id, claude.id]));
});

test('a late first-turn subscription reply cannot overwrite a newer approval', async t => {
  let f;
  f = await fixture(t, { empty: true, turns: [], resume(reply, event) {
    event('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    reply({ thread: { id: f.record.nativeId, status: { type: 'idle' } } });
  } });
  const target = new LegacyCodex({ ...f.record, messages: [] }); t.after(() => target.close());
  await target.connect(f.socket);
  await target.send('first task', 'tag', async () => {}, () => true);
  assert.equal(target.state, 'approval');
});

test('GUI approval reaches its original native transport and rejects stale or other-window decisions', async t => {
  const { WorkspaceClient } = require('../workspace-client.cjs'), { EventEmitter } = require('node:events');
  const f = await fixture(t); f.record.state = 'idle'; f.record.owner = 'window';
  const transport = new EventEmitter(), oldCalls = [];
  const state = { ...f.entry.state, sessions: [f.record], owner: 'window', capabilities: [], room: { messages: [] }, diagnostics: {} };
  transport.call = async method => { oldCalls.push(method); return state; };
  transport.close = () => transport.emit('closed');
  const client = new WorkspaceClient([{ ...f.entry, state, client: transport }], '.', f.directory);
  t.after(() => client.close());
  await client.call('prepareInput', f.record.id);
  f.request({ id: 94, method: 'item/commandExecution/requestApproval', params: { threadId: f.record.nativeId, command: 'synthetic command' } });
  await tick();
  const approval = client.snapshot().sessions[0].approval;
  assert.match(approval.requestId, /^legacy:/);
  f.record.owner = 'other';
  await assert.rejects(client.call('approve', f.record.id, approval.requestId, 'accept'), /控制权/);
  assert.equal(f.calls.some(c => c.id === 94 && c.result), false);
  f.record.owner = 'window';
  await client.call('approve', f.record.id, approval.requestId, 'decline'); await tick();
  assert.deepEqual(f.calls.find(c => c.id === 94 && c.result).result, { decision: 'decline' });
  assert.equal(oldCalls.includes('approve'), false);
  await assert.rejects(client.call('approve', f.record.id, approval.requestId, 'accept'), /权限请求已变化/);
  f.request({ id: 95, method: 'item/commandExecution/requestApproval', params: { threadId: f.record.nativeId, command: 'second command' } });
  await tick();
  const next = client.snapshot().sessions[0].approval;
  f.event('serverRequest/resolved', { requestId: 95 }); await tick();
  await assert.rejects(client.call('approve', f.record.id, next.requestId, 'accept'), /权限请求已变化/);
});

test('retained native permission scope and available decisions cannot be bypassed with a direct GUI call', async t => {
  const f = await fixture(t), target = new LegacyCodex(f.record); t.after(() => target.close()); await target.connect(f.socket);
  let id = 200;
  for (const params of [
    { networkApprovalContext: { host: 'synthetic.example', protocol: 'https' } },
    { additionalPermissions: { fileSystem: { write: ['/synthetic/extra'] } } },
    { kind: 'writeStdin' }, { environmentId: 'remote-environment' }, { availableDecisions: ['decline'] },
  ]) {
    f.request({ id: ++id, method: 'item/commandExecution/requestApproval', params: { threadId: f.record.nativeId, command: 'Synthetic command', cwd: '/synthetic', ...params } }); await tick();
    assert.throws(() => target.approve(target.approval.requestId, 'accept'), /原生终端|不支持/);
    f.event('serverRequest/resolved', { requestId: id }); await tick();
  }
  assert.equal(f.calls.some(c => c.result?.decision === 'accept'), false);
});

test('legacy resolved or disconnected approval cannot fall back to an old daemon request', async t => {
  const { WorkspaceClient } = require('../workspace-client.cjs'), { EventEmitter } = require('node:events');
  const f = await fixture(t); Object.assign(f.record, { state: 'approval', owner: 'window',
    approval: { requestId: 42, method: 'item/commandExecution/requestApproval', params: { command: 'obsolete daemon request' } } });
  const transport = new EventEmitter(), oldCalls = [];
  const state = { ...f.entry.state, sessions: [f.record], owner: 'window', capabilities: [], room: { messages: [] }, diagnostics: {} };
  transport.call = async method => { oldCalls.push(method); return state; };
  transport.close = () => transport.emit('closed');
  const client = new WorkspaceClient([{ ...f.entry, state, client: transport }], '.', f.directory);
  t.after(() => client.close());
  assert.equal(client.snapshot().sessions[0].approval, null);
  await assert.rejects(client.call('approve', f.record.id, 42, 'accept'), /原生确认/);
  await client.call('prepareInput', f.record.id);
  f.request({ id: 94, method: 'item/commandExecution/requestApproval', params: { threadId: f.record.nativeId, command: 'current request' } }); await tick();
  const key = client.snapshot().sessions[0].approval.requestId;
  await client.call('approve', f.record.id, key, 'decline'); await tick();
  assert.equal(client.snapshot().sessions[0].approval.pending, true);
  f.request({ id: 94, method: 'item/commandExecution/requestApproval', params: { threadId: f.record.nativeId, command: 'current request' } }); await tick();
  assert.equal(client.snapshot().sessions[0].approval.requestId, key);
  assert.equal(client.snapshot().sessions[0].approval.pending, true);
  await assert.rejects(client.call('approve', f.record.id, key, 'accept'), /权限请求已变化/);
  assert.equal(f.calls.filter(c => c.id === 94 && c.result).length, 1);
  f.event('serverRequest/resolved', { requestId: 94 }); await tick();
  assert.equal(client.snapshot().sessions[0].approval, null);
  await assert.rejects(client.call('approve', f.record.id, 42, 'accept'), /原生确认/);
  client.control.legacyInput.target(f.record).native.close();
  assert.equal(client.snapshot().sessions[0].approval, null);
  await assert.rejects(client.call('approve', f.record.id, key, 'accept'), /权限请求已变化/);
  assert.equal(oldCalls.includes('approve'), false);
});

for (const empty of [false, true]) test('native completion before acknowledgement is matched once to its turn, including an empty retained thread: ' + empty, async t => {
  const f = await fixture(t, { empty, start(m, reply, event) {
    event('turn/started', { turn: { id: 'owned-turn' } });
    event('item/completed', { turnId: 'other-turn', item: { id: 'other-answer', type: 'agentMessage', text: 'private other reply' } });
    event('turn/completed', { turn: { id: 'other-turn', status: 'completed' } });
    event('item/completed', { turnId: 'owned-turn', item: { id: 'owned-answer', type: 'agentMessage', text: 'authorized reply' } });
    event('turn/completed', { turn: { id: 'owned-turn', status: 'completed' } });
    reply({ turn: { id: 'owned-turn' } });
  } });
  const target = new LegacyCodex({ ...f.record, messages: [] }), completed = []; t.after(() => target.close());
  await target.connect(f.socket); target.on('complete', result => completed.push(result));
  await target.send('synthetic task', 'owned-tag', async () => {}, () => true); await tick();
  assert.equal(completed.find(r => r.text === 'private other reply').tag, undefined);
  assert.equal(completed.find(r => r.tag === 'owned-tag').text, 'authorized reply');
  assert.equal(completed.length, 2);
  assert.equal(target.subscribed, true);
  assert.equal(target.state, 'idle');
  assert.equal(target.pending, null);
  assert.equal(f.calls.find(c => c.method === 'turn/start').params.clientUserMessageId, 'owned-tag');
  await target.send('next synthetic task', 'next-tag', async () => {}, () => true); await tick();
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 2);
  assert.equal(target.state, 'idle');
});

test('human native messages invalidate a pending dispatch; progress needs no terminal operation', async t => {
  const f = await fixture(t), target = new LegacyCodex(f.record); t.after(() => target.close());
  await target.connect(f.socket);
  await assert.rejects(target.send('do not send', 'tag', async () => {
    f.event('item/completed', { turnId: 'human-turn', item: { id: 'human-message', type: 'userMessage', content: [{ type: 'text', text: 'new direction' }] } });
    await tick();
  }, () => true), /状态已变化/);
  f.event('item/started', { turnId: 'human-turn', item: { id: 'cmd', type: 'commandExecution', command: 'printf synthetic' } });
  f.event('item/commandExecution/outputDelta', { turnId: 'human-turn', itemId: 'cmd', delta: 'intermediate output' }); await tick();
  assert.equal(target.observe().progress.items[0].text, 'intermediate output');
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});
test('native error freezes retained partial text and inline tool status without claiming the native turn stopped', async t => {
  const f = await fixture(t), target = new LegacyCodex(f.record); t.after(() => target.close());
  await target.connect(f.socket);
  f.event('turn/started', { turn: { id: 'active-turn' } });
  f.event('item/agentMessage/delta', { turnId: 'active-turn', itemId: 'partial', delta: 'partial text' });
  f.event('item/started', { turnId: 'active-turn', item: { id: 'cmd', type: 'commandExecution', command: 'synthetic command' } });
  f.event('item/commandExecution/outputDelta', { turnId: 'active-turn', itemId: 'cmd', delta: 'intermediate tool text' }); await tick();
  assert.equal(target.record.messages.find(m => m.kind === 'tool').text, 'intermediate tool text');
  f.event('error', {}); await tick();
  assert.equal(target.record.messages.find(m => m.id === 'partial').status, 'unconfirmed');
  assert.equal(target.record.messages.find(m => m.kind === 'tool').status, 'unconfirmed');
  assert.equal(target.observe().progress.items.find(m => m.id === 'cmd').status, 'unknown');
  assert.equal(target.state, 'working');
  assert.equal(f.calls.some(c => ['turn/start', 'turn/interrupt'].includes(c.method)), false);
});

test('manager records only metadata, preserves native history writer and refuses insecure connection files', async t => {
  const f = await fixture(t), manager = new LegacyInput(f.directory); t.after(() => manager.close());
  fs.chmodSync(path.join(f.directory, 'connection.json'), 0o644);
  await assert.rejects(manager.prepare(f.entry, f.record), /权限不安全/);
  fs.chmodSync(path.join(f.directory, 'connection.json'), 0o600);
  await manager.prepare(f.entry, f.record);
  await manager.send(f.record, 'synthetic private prompt', async () => {}, () => true);
  assert.equal(manager.records[0].status, 'accepted');
  assert.equal(fs.readFileSync(path.join(f.directory, 'legacy-dispatches.json'), 'utf8').includes('synthetic private prompt'), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'workspace.json')), false);
  assert.equal(fs.existsSync(path.join(f.directory, '.claude')), false);
});
test('failed retained reconnect keeps the read-only cache; successful reconnect reconciles that same history', async t => {
  let fail = false;
  const options = { items(_request, reply) {
    reply({ data: [{ turnId: 'old', item: { type: 'agentMessage', id: 'old-answer', text: 'known native history' } }], nextCursor: null });
  }, resume(reply) {
    reply({ model: 'synthetic-small', thread: { id: fail ? 'wrong-thread' : f.record.nativeId, status: { type: 'idle' } } });
  } };
  const f = await fixture(t, options), manager = new LegacyInput(f.directory); t.after(() => manager.close());
  await manager.prepare(f.entry, f.record);
  const old = manager.target(f.record);
  old.native.record.messages.push({ id: 'uncertain-input', role: 'user', origin: 'human', text: 'pending human input', status: 'unconfirmed' });
  old.native.close(); fail = true;
  await assert.rejects(manager.prepare(f.entry, f.record), /连接未确认/);
  assert.equal(manager.target(f.record), old);
  assert.equal(manager.connected(f.record), false);
  assert.deepEqual(old.native.record.messages.map(m => m.text), ['known native history', 'pending human input']);
  fail = false;
  await manager.prepare(f.entry, f.record);
  const replacement = manager.target(f.record);
  assert.notEqual(replacement, old);
  assert.equal(manager.connected(f.record), true);
  assert.deepEqual(replacement.native.record.messages.map(m => m.text), ['known native history', 'pending human input']);
  assert.equal(replacement.native.record.nativeId, f.record.nativeId);
  assert.equal(replacement.native.record.pid, f.record.pid);
  assert.equal(f.calls.some(c => ['thread/start', 'turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(c.method)), false);
});
test('closing while the empty first turn is acknowledged cannot start another observer request', async t => {
  let acknowledge;
  const f = await fixture(t, { empty: true, start(_m, reply) { acknowledge = () => reply({ turn: { id: 'late-accepted' } }); } });
  const target = new LegacyCodex({ ...f.record, messages: [] }); t.after(() => target.close());
  await target.connect(f.socket);
  // Marking closed is the synchronous portion of close(); keep the test socket
  // just long enough to deliver the late ACK instead of a transport failure.
  const pending = target.send('one input', 'late-tag', async () => {}, () => true);
  while (!acknowledge) await new Promise(resolve => setImmediate(resolve));
  target.closed = true; target.connected = false; target.adapter.stopped = true;
  const before = f.calls.filter(c => c.method === 'thread/resume').length;
  acknowledge(); await pending; await tick();
  assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, before);
});


test('retained working turn accepts one native steer without a new turn or duplicate echo', async t => {
  const f = await fixture(t), target = new LegacyCodex(f.record); t.after(() => target.close());
  await target.connect(f.socket);
  f.event('turn/started', { turn: { id: 'active' } }); await tick();
  assert.equal(target.steerAvailable, true); assert.equal(target.turnId, 'active');
  await target.steer('adjust requirement', 'steering-input', 'active', async () => {}, () => true);
  f.event('item/completed', { turnId: 'active', item: { id: 'native-steering-input', clientId: 'steering-input', type: 'userMessage', content: [{ type: 'text', text: 'adjust requirement' }] } }); await tick();
  assert.equal(target.record.messages.filter(m => m.text === 'adjust requirement').length, 1);
  assert.equal(target.record.messages.at(-1).status, 'submitted');
  assert.equal(target.state, 'working');
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
  assert.equal(f.calls.some(c => ['turn/start', 'turn/interrupt'].includes(c.method)), false);
  await assert.rejects(target.steer('stale', 'bad', 'old', async () => {}, () => true));
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
});

for (const boundary of ['complete', 'permission', 'private-input', 'failure', 'departure', 'clear', 'reconnect']) test(`retained Codex room projection binds only the native ACK and respects ${boundary}`, async t => {
  let accept;
  const f = await fixture(t, { start(_m, reply) { accept = reply; } });
  Object.assign(f.record, { name: 'Codex A', roomId: 'shared', state: 'idle', memberRevision: 1, controlRevision: 2 });
  const bridge = new LegacyInput(f.directory); t.after(() => bridge.close());
  await bridge.prepare(f.entry, f.record);
  const native = bridge.target(f.record).native; let authorized = true;
  const pending = bridge.send(f.record, 'shared task', async () => {}, () => true, true, undefined, undefined, false, () => authorized);
  while (!accept) await tick();
  f.event('turn/started', { turn: { id: 'owned-turn' } });
  f.event('item/agentMessage/delta', { turnId: 'private-turn', itemId: 'private-answer', delta: 'PRIVATE HISTORY' });
  f.event('item/agentMessage/delta', { turnId: 'owned-turn', itemId: 'answer', delta: 'visible prefix' });
  await tick();
  assert.equal(bridge.sharedMessages().filter(m => m.role === 'assistant').length, 0);
  accept({ turn: { id: 'owned-turn' } }); await pending; await tick();
  const row = bridge.sharedMessages().find(m => m.role === 'assistant');
  assert.equal(row.text, 'visible prefix'); assert.equal(row.sessionId, f.record.id);
  assert.equal(bridge.sharedMessages().find(m => m.role === 'human').manualReply, false);
  if (boundary === 'permission') native.adapter.emit('approval', { requestId: 'permission-1' });
  if (boundary === 'private-input') f.event('item/completed', { turnId: 'owned-turn', item: { id: 'other-input', type: 'userMessage', content: [{ type: 'text', text: 'private instruction' }] } });
  if (boundary === 'failure') f.event('error', {});
  if (boundary === 'departure') { authorized = false; bridge.sharedMessages(); authorized = true; }
  if (boundary === 'clear') bridge.clearSharedHistory();
  if (boundary === 'reconnect') { native.close(); bridge.sharedMessages(); }
  await tick();
  if (boundary !== 'reconnect') {
    f.event('item/completed', { turnId: 'owned-turn', item: { id: 'answer', type: 'agentMessage', text: 'visible prefix LATER' } });
    f.event('turn/completed', { turn: { id: 'owned-turn', status: 'completed' } });
    await tick();
    assert.ok(native.record.messages.some(m => m.text === 'visible prefix LATER'));
  }
  const shared = bridge.sharedMessages();
  if (boundary === 'complete') { assert.equal(row.text, 'visible prefix LATER'); assert.equal(row.finalReply, true); }
  else assert.ok(!JSON.stringify(shared).includes('LATER'));
  assert.ok(!JSON.stringify(shared).includes('PRIVATE HISTORY'));
  assert.equal(f.calls.filter(m => m.method === 'turn/start').length, 1);
  bridge.sharedReplies.save();
  const { LegacyShared } = require('../legacy-shared.cjs'), reopened = new LegacyShared(f.directory, () => {});
  assert.equal(reopened.grants.size, 0); reopened.dispose();
});

test('retained Codex permission before ACK cannot publish cached output or fabricate a final', async t => {
  let accept;
  const f = await fixture(t, { start(_m, reply) { accept = reply; } });
  Object.assign(f.record, { name: 'Codex A', roomId: 'shared', state: 'idle' });
  const bridge = new LegacyInput(f.directory); t.after(() => bridge.close()); await bridge.prepare(f.entry, f.record);
  const send = bridge.send(f.record, 'task', async () => {}, () => true, true, undefined, undefined, false, () => true);
  while (!accept) await tick();
  f.event('turn/started', { turn: { id: 'owned-turn' } });
  f.event('item/agentMessage/delta', { turnId: 'owned-turn', itemId: 'answer', delta: 'PRIVATE before ACK' }); await tick();
  bridge.target(f.record).native.adapter.emit('approval', { requestId: 'permission-2' });
  accept({ turn: { id: 'owned-turn' } }); await send;
  f.event('turn/completed', { turn: { id: 'owned-turn', status: 'completed' } }); await tick();
  assert.equal(bridge.sharedMessages().filter(m => m.role !== 'human').length, 0);
});

test('retained Codex completed-before-ACK publishes exactly one verified final and no other turn', async t => {
  let accept;
  const f = await fixture(t, { start(_m, reply) { accept = reply; } });
  Object.assign(f.record, { name: 'Codex A', roomId: 'shared', state: 'idle' });
  const bridge = new LegacyInput(f.directory); t.after(() => bridge.close()); await bridge.prepare(f.entry, f.record);
  const send = bridge.send(f.record, 'task', async () => {}, () => true, true, undefined, undefined, false, () => true);
  while (!accept) await tick();
  f.event('turn/started', { turn: { id: 'owned-turn' } });
  f.event('item/completed', { turnId: 'private-turn', item: { id: 'private', type: 'agentMessage', text: 'UNRELATED' } });
  f.event('item/completed', { turnId: 'owned-turn', item: { id: 'answer', type: 'agentMessage', text: 'ACK_LATE_FINAL' } });
  f.event('turn/completed', { turn: { id: 'owned-turn', status: 'completed' } }); await tick();
  assert.equal(bridge.sharedMessages().filter(m => m.role !== 'human').length, 0);
  accept({ turn: { id: 'owned-turn' } }); await send; await tick();
  const rows = bridge.sharedMessages().filter(m => m.role === 'assistant');
  assert.equal(rows.length, 1); assert.equal(rows[0].text, 'ACK_LATE_FINAL'); assert.equal(rows[0].finalReply, true);
  assert.equal(f.calls.filter(m => m.method === 'turn/start').length, 1);
});

async function routerFixture(t, options) {
  const f = await fixture(t, options), { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs');
  Object.assign(f.record, { owner: 'view', name: 'Codex A', state: 'working', messages: [] });
  const bridge = new LegacyInput(f.directory); t.after(() => bridge.close());
  await bridge.prepare(f.entry, f.record);
  const client = new EventEmitter(), state = { ...f.entry.state, owner: 'view', capabilities: [], sessions: [f.record], room: { messages: [] }, diagnostics: {} };
  client.call = async (method, ...args) => { if (method === 'initial') return structuredClone(state); if (method === 'draft') f.record.liveDraft = args[1]; return true; };
  client.close = () => client.emit('closed');
  const entry = { key: '.', state: structuredClone(state), client };
  const router = new WorkspaceClient([entry], '.'); router.control.legacyInput = bridge; t.after(() => router.close());
  f.event('turn/started', { turn: { id: 'active' } }); await tick();
  return { ...f, bridge, router, state };
}

for (const change of ['peer-leave-rejoin', 'peer-archive', 'own-leave', 'room-pause', 'room-archive']) test(`real room membership path preserves only unaffected retained sharing: ${change}`, async t => {
  const f = await routerFixture(t, { steer(m, reply, event) {
    event('item/completed', { turnId: 'active', item: { type: 'userMessage', id: 'steer-user', clientId: m.params.clientUserMessageId, content: [{ type: 'text', text: 'shared work' }] } });
    reply({ turnId: 'active' });
  } });
  Object.assign(f.record, { roomId: 'shared', memberRevision: 1 });
  f.state.sessions.push({ id: 'peer', provider: 'claude', name: 'Peer', roomId: 'shared', state: 'working' });
  const transport = f.router.entries[0].client, original = transport.call;
  transport.call = async (method, ...args) => {
    if (method === 'join') { const row = f.state.sessions.find(s => s.id === args[0]); row.roomId = args[1] ? 'shared' : null; row.memberRevision = (row.memberRevision || 0) + 1; }
    return original(method, ...args);
  };
  await f.router.refresh();
  const { RoomState } = require('../room-state.cjs'), room = new RoomState(f.directory);
  await f.router.call('steerShared', f.record.id, 'shared work', f.record.nativeId, 'active');
  f.event('item/started', { turnId: 'active', item: { id: 'answer', type: 'agentMessage' } });
  f.event('item/agentMessage/delta', { turnId: 'active', itemId: 'answer', delta: 'before' }); await tick();
  assert.equal(f.bridge.sharedMessages().find(m => m.role === 'assistant').text, 'before');
  if (change === 'peer-leave-rejoin') { await room.membership(f.router, 'peer', false); await room.membership(f.router, 'peer', true); }
  if (change === 'peer-archive') await room.archiveSession(f.router, 'peer');
  if (change === 'own-leave') await room.membership(f.router, f.record.id, false);
  if (change === 'room-pause') await f.router.call('pause');
  if (change === 'room-archive') await room.archiveRoom(f.router);
  f.event('item/completed', { turnId: 'active', item: { id: 'answer', type: 'agentMessage', text: 'before after' } });
  f.event('turn/completed', { turn: { id: 'active', status: 'completed' } }); await tick();
  const row = f.bridge.sharedMessages().find(m => m.role === 'assistant');
  assert.equal(row.text, change.startsWith('peer-') ? 'before after' : 'before');
  assert.equal(Boolean(row.finalReply), change.startsWith('peer-'));
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
  assert.equal(f.calls.some(c => ['turn/start', 'turn/interrupt'].includes(c.method)), false);
});

test('retained solo steer passes through the real router while its own native send is pending', async t => {
  const f = await routerFixture(t), { router } = f;
  await router.call('steer', f.record.id, 'adjust requirement', f.record.nativeId, 'active');
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
  assert.equal(f.calls.some(c => ['turn/start', 'turn/interrupt'].includes(c.method)), false);
});

for (const order of ['ack-first', 'input-first']) test(`retained shared steer projects only newly attributed items: ${order}`, async t => {
  let acknowledge, inputTag;
  const f = await routerFixture(t, { steer(m, reply) { inputTag = m.params.clientUserMessageId; acknowledge = () => reply({ turnId: 'active' }); } });
  const { router, bridge } = f;
  f.record.roomId = 'shared'; await router.refresh();
  f.event('item/started', { turnId: 'active', item: { id: 'old', type: 'agentMessage' } });
  f.event('item/agentMessage/delta', { turnId: 'active', itemId: 'old', delta: 'OLD PRIVATE' }); await tick();
  const pending = router.call('steerShared', f.record.id, 'new shared instruction', f.record.nativeId, 'active');
  while (!acknowledge) await tick();
  const acceptedInput = () => f.event('item/completed', { turnId: 'active', item: { id: 'accepted-input', clientId: inputTag, type: 'userMessage', content: [{ type: 'text', text: 'new shared instruction' }] } });
  if (order === 'input-first') { acceptedInput(); await tick(); }
  acknowledge(); await pending;
  if (order === 'ack-first') { acceptedInput(); await tick(); }
  f.event('item/completed', { turnId: 'active', item: { id: 'old', type: 'agentMessage', text: 'OLD PRIVATE LATE' } });
  f.event('item/started', { turnId: 'active', item: { id: 'new', type: 'agentMessage' } });
  f.event('item/agentMessage/delta', { turnId: 'active', itemId: 'new', delta: 'SHARED PREFIX' }); await tick();
  const row = bridge.sharedMessages().find(m => m.role === 'assistant'); assert.equal(row.text, 'SHARED PREFIX');
  f.event('item/completed', { turnId: 'active', item: { id: 'new', type: 'agentMessage', text: 'SHARED FINAL' } });
  f.event('turn/completed', { turn: { id: 'active', status: 'completed' } }); await tick();
  assert.equal(row.finalReply, true); assert.equal(row.text, 'SHARED FINAL');
  assert.ok(!JSON.stringify(bridge.sharedMessages()).includes('OLD PRIVATE'));
  assert.equal(bridge.sharedMessages().find(m => m.role === 'human').inputMode, 'steer');
  assert.equal(f.calls.filter(m => m.method === 'turn/steer').length, 1);
  assert.equal(f.calls.some(m => ['turn/start', 'turn/interrupt'].includes(m.method)), false);
});

for (const change of ['owner', 'turn', 'native', 'pid', 'permission', 'leave', 'rejoin', 'intervention']) test(`retained shared steer refuses a changed ${change} before native delivery`, async t => {
  const f = await routerFixture(t); f.record.roomId = 'shared'; await f.router.refresh();
  let release; f.router.pauseExcept = async () => new Promise(resolve => { release = resolve; });
  const pending = f.router.call('steerShared', f.record.id, 'stale instruction', f.record.nativeId, 'active');
  assert.equal(typeof release, 'function');
  if (change === 'owner') f.record.owner = 'other';
  if (change === 'native') f.record.nativeId = crypto.randomUUID();
  if (change === 'pid') f.record.pid++;
  if (change === 'turn') f.event('turn/started', { turn: { id: 'next' } });
  if (change === 'permission') f.bridge.target(f.record).native.adapter.emit('approval', { requestId: 'permission' });
  if (change === 'leave') f.record.roomId = null;
  if (change === 'rejoin') f.record.memberRevision = 99;
  if (change === 'intervention') await f.router.intervene(() => Promise.resolve(), f.record.id);
  await tick(); release(); await assert.rejects(pending);
  assert.equal(f.calls.some(m => ['turn/steer', 'turn/start', 'turn/interrupt'].includes(m.method)), false);
});

for (const boundary of ['none', 'permission', 'private-input', 'clear']) test(`retained shared steer completion and idle before ACK: ${boundary}`, async t => {
  let acknowledge, inputTag;
  const f = await routerFixture(t, { steer(m, reply) { inputTag = m.params.clientUserMessageId; acknowledge = () => reply({ turnId: 'active' }); } });
  f.record.roomId = 'shared'; await f.router.refresh();
  const pending = f.router.call('steerShared', f.record.id, 'finish before ack', f.record.nativeId, 'active');
  while (!acknowledge) await tick();
  f.event('item/completed', { turnId: 'active', item: { id: 'accepted-input', clientId: inputTag, type: 'userMessage', content: [{ type: 'text', text: 'finish before ack' }] } });
  f.event('item/started', { turnId: 'active', item: { id: 'answer', type: 'agentMessage' } });
  f.event('item/completed', { turnId: 'active', item: { id: 'answer', type: 'agentMessage', text: 'EARLY_FINAL' } });
  f.event('turn/completed', { turn: { id: 'active', status: 'completed' } });
  f.event('thread/status/changed', { status: { type: 'idle' } }); await tick();
  assert.equal(f.bridge.sharedMessages().filter(m => m.role === 'assistant').length, 0);
  if (boundary === 'permission') f.bridge.target(f.record).native.adapter.emit('approval', { requestId: 'late-permission' });
  if (boundary === 'private-input') f.event('item/completed', { turnId: 'active', item: { id: 'private-input', type: 'userMessage', content: [{ type: 'text', text: 'PRIVATE' }] } });
  if (boundary === 'clear') f.bridge.clearSharedHistory();
  await tick(); acknowledge(); await pending; await tick();
  const rows = f.bridge.sharedMessages().filter(m => m.role === 'assistant');
  if (boundary === 'none') { assert.equal(rows.length, 1); assert.equal(rows[0].text, 'EARLY_FINAL'); assert.equal(rows[0].finalReply, true); }
  else assert.equal(rows.length, 0);
  assert.equal(f.calls.filter(m => m.method === 'turn/steer').length, 1);
  assert.equal(f.calls.some(m => ['turn/start', 'turn/interrupt'].includes(m.method)), false);
});

for (const newer of [false, true]) test(`retained solo steer clears the pre-send saved draft, preserving newer same-text edits: ${newer}`, async t => {
  let acknowledge;
  const f = await routerFixture(t, { steer(m, reply) { acknowledge = () => reply({ turnId: 'active' }); } });
  // The existing native write completes during the send's refresh, after the
  // initial UI/route snapshot. A later human edit has a separate revision.
  f.router.pauseExcept = async () => { f.record.liveDraft = 'adjust requirement'; };
  const pending = f.router.call('steer', f.record.id, 'adjust requirement', f.record.nativeId, 'active');
  while (!acknowledge) await tick();
  if (newer) await f.router.call('draft', f.record.id, 'adjust requirement');
  acknowledge(); await pending;
  assert.equal(f.record.liveDraft, newer ? 'adjust requirement' : '');
});
