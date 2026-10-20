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
      if (m.method === 'initialize') reply({});
      if (m.method === 'thread/loaded/list') {
        const result = { data: options.notLoaded ? [] : [record.nativeId], nextCursor: null };
        if (options.loaded) options.loaded(() => reply(result)); else reply(result);
      }
      if (m.method === 'thread/read') reply({ thread: { id: record.nativeId, status: { type: options.notLoaded ? 'notLoaded' : 'idle' } } });
      if (m.method === 'thread/resume') {
        if (options.empty && !started) ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: 'no rollout found for thread id ' + record.nativeId } }));
        else if (options.resume) options.resume(reply, event);
        else reply({ thread: { id: record.nativeId, status: { type: 'idle' } } });
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

test('native completion before acknowledgement is matched to its turn, never to a neighboring turn', async t => {
  const f = await fixture(t, { start(m, reply, event) {
    event('turn/started', { turn: { id: 'owned-turn' } });
    event('item/completed', { turnId: 'other-turn', item: { id: 'other-answer', type: 'agentMessage', text: 'private other reply' } });
    event('turn/completed', { turn: { id: 'other-turn', status: 'completed' } });
    event('item/completed', { turnId: 'owned-turn', item: { id: 'owned-answer', type: 'agentMessage', text: 'authorized reply' } });
    event('turn/completed', { turn: { id: 'owned-turn', status: 'completed' } });
    reply({ turn: { id: 'owned-turn' } });
  } });
  const target = new LegacyCodex(f.record), completed = []; t.after(() => target.close());
  await target.connect(f.socket); target.on('complete', result => completed.push(result));
  await target.send('synthetic task', 'owned-tag', async () => {}, () => true); await tick();
  assert.equal(completed.find(r => r.text === 'private other reply').tag, undefined);
  assert.equal(completed.find(r => r.tag === 'owned-tag').text, 'authorized reply');
  assert.equal(f.calls.find(c => c.method === 'turn/start').params.clientUserMessageId, 'owned-tag');
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
