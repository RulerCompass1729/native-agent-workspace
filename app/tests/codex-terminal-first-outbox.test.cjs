const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { Codex } = require('../adapters.cjs');
const { nativeOutboxCall } = require('../computer-use-outbox-native.cjs');
const { verifiedCodexProtocol } = require('../native-history.cjs');

for (const nativeVersion of ['0.166.0', '0.167.0']) test(`native ${nativeVersion} terminal-first startup observes first-turn outbox provenance on its own socket`, { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-first-outbox-'));
  const upstream = path.join(dir, 'native.sock'), server = http.createServer();
  const native = new WebSocket.Server({ server });
  const identity = { nativeId: '11111111-1111-4111-8111-111111111111', sessionId: 'native-session', turnId: 'first-turn', callId: 'first-call' };
  const args = { recipient_id: 'synthetic-recipient', message: '  Exact first task\n\tsecond line  ' };
  const host = { privateDir: dir, codexSocket: upstream, binaries: { codex: 'synthetic' },
    codexTargets: new Map(), codexProcess: { pid: 123 }, rpc: { nativeVersion, connected: true } };
  const r = new Codex({ cwd: dir, view: 'terminal', messages: [] }, host);
  let client, remote, fallback = 0;
  // The unobserved fallback must not be mistaken for first-turn delivery.
  r.observeFirstTurn = async () => { fallback++; };
  t.after(async () => {
    r.stopped = true; client?.terminate(); r.terminalBridge?.close();
    for (const socket of native.clients) socket.terminate();
    await new Promise(resolve => native.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  native.on('connection', socket => {
    remote = socket;
    socket.on('message', data => {
      const request = JSON.parse(data);
      if (request.method !== 'thread/start') return;
      const thread = { id: identity.nativeId, sessionId: identity.sessionId };
      socket.send(JSON.stringify({ id: request.id, result: { thread, model: 'synthetic-model', reasoningEffort: 'low' } }));
      // Mirrors the host's global thread/started fallback for unbridged TUI.
      if (!r.terminalBridge) host.pendingCodex(thread, 'synthetic-model');
    });
  });
  await new Promise(resolve => server.listen(upstream, resolve));
  r.makeTerminal = argv => {
    const endpoint = argv[argv.indexOf('--remote') + 1].slice('unix://'.length);
    client = new WebSocket('ws://localhost', { createConnection: () => net.connect(endpoint) });
    client.on('open', () => client.send(JSON.stringify({ id: 1, method: 'thread/start', params: { ephemeral: false } })));
    return new EventEmitter();
  };
  await r.startFromTerminal();
  const receive = method => new Promise(resolve => {
    const observe = data => { if (JSON.parse(data).method === method) { client.off('message', observe); resolve(); } };
    client.on('message', observe);
  });
  const turn = receive('turn/started');
  remote.send(JSON.stringify({ method: 'turn/started', params: { threadId: identity.nativeId, turn: { id: identity.turnId } } }));
  await turn;
  const item = { type: 'mcpToolCall', id: identity.callId, server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' };
  const started = receive('item/started');
  remote.send(JSON.stringify({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId, item } }));
  await started;
  const proof = await nativeOutboxCall(r, identity, args, AbortSignal.timeout(1000));
  assert.equal(proof.valid(), true);
  assert.equal(r.chatAvailable, true); assert.equal(fallback, 0);
  assert.notEqual(r.terminalRpc, host.rpc); assert.equal(native.clients.size, 1);
  assert.equal(verifiedCodexProtocol(host.rpc), false, 'Qualifying the terminal observer must not qualify unrelated history/steer APIs');
  const completed = receive('item/completed');
  remote.send(JSON.stringify({ method: 'item/completed', params: { threadId: identity.nativeId, turnId: identity.turnId, item: { ...item, status: 'completed' } } }));
  await completed; assert.equal(proof.valid(), false, 'Completion still retires the exact call; it cannot be replayed');
});

test('unknown and prerelease native versions retain the unqualified terminal fallback', async () => {
  for (const nativeVersion of [undefined, '0.168.0', '0.166.0-beta', '0.167.0-beta']) {
    const r = new Codex({ view: 'terminal' }, { codexSocket: '/synthetic/native.sock', rpc: { nativeVersion } });
    assert.equal(await r.terminalEndpoint(), '/synthetic/native.sock');
    assert.equal(r.terminalBridge, undefined);
  }
});
