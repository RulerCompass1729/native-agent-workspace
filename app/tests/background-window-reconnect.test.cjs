const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { BackgroundControl } = require('../background-control.cjs');
const { ServiceClient } = require('../service-connection.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { uiError } = require('../ui-errors.cjs');
const { classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');

// E03, 2026-11-16: an agent's background window whose backend connection had ended answered every later call with
// 「本地服务未连接。」 until the agent stopped calling for five minutes. Real service clients over a local socket; the
// service is a synthetic stand-in that answers `initial` and can end one connection, as a backend might.
const sender = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' };
const identity = { nativeId: 'native', sessionId: 'native-session', turnId: 'turn', callId: 'call' };
const binding = { sender, identity, valid: () => true };
const invoke = (id, text) => ({ action: 'invoke', operation_id: id, method: 'draft', arguments: [text] });
const disconnected = uiError('error.serviceDisconnected').message;

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-bg-reconnect-')); fs.chmodSync(dir, 0o700);
  const endpoint = path.join(dir, 's.sock'), state = {
    owner: 'view', runtimeVersion: 'synthetic', capabilities: [], diagnostics: { dispatches: 0, shellModelCalls: 0 },
    sessions: [{ id: 'agent', nativeId: 'native', provider: 'codex', state: 'idle', owner: 'view' }], room: { revision: 0, messages: [], run: null },
  };
  // Each accepted connection, in order; a test ends one from the service side.
  const accepted = [];
  const server = net.createServer(socket => {
    accepted.push(socket); let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        socket.write(JSON.stringify({ id: request.id, ok: true, value: request.method === 'initial' ? structuredClone(state) : true }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const scope = Symbol('synthetic workspace');
  const open = async () => {
    const socket = net.connect(endpoint); await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const client = new ServiceClient(socket), entry = { key: 'root', client };
    entry.state = await client.call('initial');
    return new WorkspaceClient([entry], 'root', scope);
  };
  // The person's own window: the background window is never the last view of this workspace.
  const person = await open();
  const contexts = [];
  // As main.cjs: a hidden window per agent view, its connection under the view's owner; closing the window closes it.
  const config = { dataDir: dir, handlers: new Map([['draft', (c, text) => { c.view.draft = text; return text; }]]),
    context: async (actor, saved, kept) => {
      const view = saved || { owner: randomUUID(), selected: actor.id, mode: 'chat', preference: 'chat', active: false };
      const client = await open();
      const win = { destroyed: false, isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; client.close(); } };
      const c = { background: true, actor, view, client, win, refresh: () => client.refresh(), confirmationActors: () => [actor], checkActor: async () => {} };
      Object.assign(c, kept);
      c.retain = () => c.fileChoosing ? null : { clipboard: c.clipboard };
      contexts.push(c); return c;
    } };
  const controller = new BackgroundControl(config);
  t.after(async () => {
    await controller.close();
    for (const c of contexts) c.client.close();
    person.close();
    for (const socket of accepted) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Ends the service side of the window's connection and waits until the window has seen it end.
  const endConnection = async c => {
    const closed = new Promise(resolve => c.client.entries[0].client.once('closed', resolve));
    accepted[accepted.length - 1].destroy(); await closed;
    assert.equal(c.client.socket.destroyed, true);
  };
  return { controller, contexts, person, accepted, endConnection };
}

test('a background window whose backend connection ended is replaced on the next call, under the same view and owner', async t => {
  const f = await fixture(t);
  assert.equal((await f.controller.call(binding, invoke('first', 'one'))).state, 'complete');
  assert.equal(f.contexts.length, 1); assert.equal(f.accepted.length, 2);
  const old = f.contexts[0]; old.clipboard = 'synthetic clipboard';
  await f.endConnection(old);
  const revision = f.person.control.revision;
  // Before the fix this call, and every retry after it, failed in refresh() before anything was recorded: the outbox
  // reported it as binding / binding-unavailable with no receipt, as the butler saw.
  let failure = null, reply = null;
  try { reply = await f.controller.call(binding, invoke('second', 'two')); } catch (error) { failure = error; }
  if (failure) {
    assert.equal(failure.message, disconnected);
    assert.deepEqual(classifyOutboxFailure(failure, 'binding', 'binding-unavailable'), { failurePhase: 'binding', failureReason: 'binding-unavailable' });
    assert.equal((await f.controller.call(binding, { action: 'receipt', operation_id: 'second' })).receipt, null);
  }
  assert.equal(failure, null, 'the next call after the connection ended runs in a new window');
  assert.equal(reply.state, 'complete'); assert.equal(reply.value, 'two');
  assert.equal(f.contexts.length, 2, 'one new window'); assert.equal(f.accepted.length, 3, 'one new connection');
  const fresh = f.contexts[1];
  assert.equal(fresh.view.owner, old.view.owner, 'the saved view keeps its owner');
  assert.equal(fresh.clipboard, 'synthetic clipboard', 'what the old window kept is carried over');
  assert.equal(old.client.retired, true, 'the old window is retired, not closed');
  assert.equal(old.win.isDestroyed(), true);
  assert.equal(f.person.control.revision, revision, 'replacing the window is no change of control for the person’s window');
  assert.equal(f.person.socket.destroyed, false);
  // The new window answers again; nothing else is opened.
  assert.equal((await f.controller.call(binding, invoke('third', 'three'))).state, 'complete');
  assert.equal(f.contexts.length, 2);
});

test('an ended window is kept while that agent has work running, waiting for the person or a delivery on its way', async t => {
  const f = await fixture(t);
  await f.controller.call(binding, invoke('first', 'one'));
  const holds = {
    // Rows of the operation store as an agent's running call or open confirmation card leaves them.
    'a running record': () => { const row = { id: 'held', actor: { ...sender }, command: invoke('held', 'x'), state: 'running', at: Date.now() }; f.controller.data.records.push(row); return () => f.controller.data.records.splice(f.controller.data.records.indexOf(row), 1); },
    'a confirmation card': () => { const row = { id: 'card', actor: { ...sender }, command: invoke('card', 'x'), state: 'confirmation-required', at: Date.now() }; f.controller.data.records.push(row); return () => f.controller.data.records.splice(f.controller.data.records.indexOf(row), 1); },
    'a delivery on its way': () => { const pending = new Promise(() => {}); f.controller.pendingDeliveries.add(pending); return () => f.controller.pendingDeliveries.delete(pending); },
    'an operation of this agent': () => { const key = f.controller.key(sender); f.controller.inflight.set(key, new Promise(() => {})); return () => f.controller.inflight.delete(key); },
    'a file being chosen': () => { f.contexts.at(-1).fileChoosing = true; const c = f.contexts.at(-1); return () => { c.fileChoosing = false; }; },
  };
  let n = 0;
  for (const [name, hold] of Object.entries(holds)) {
    const old = f.contexts.at(-1), opened = f.contexts.length;
    await f.endConnection(old);
    const release = hold();
    let failure = null;
    try { await f.controller.call(binding, invoke(`held-${++n}`, name)); } catch (error) { failure = error; }
    assert.ok(!failure || failure.message === disconnected, name + ': ' + failure?.message);
    assert.equal(f.contexts.length, opened, name + ': no new window');
    assert.notEqual(old.client.retired, true, name + ': the ended window is not retired');
    release();
    const reply = await f.controller.call(binding, invoke(`healed-${n}`, name));
    assert.equal(reply.state, 'complete', name + ': healed once released');
    assert.equal(f.contexts.length, opened + 1, name);
    assert.equal(old.client.retired, true, name);
  }
});
