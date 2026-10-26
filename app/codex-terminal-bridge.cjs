const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');

// Match Codex 0.164 app-server-client's bounded native websocket limit.
// Plugin catalogs can legitimately exceed 16 MiB; rejecting one disconnects
// the TUI and restarts its bootstrap/clear cycle on every reconnect.
const CODEX_WEBSOCKET_MAX_PAYLOAD = 128 * 1024 * 1024;

// Reuse the native websocket protocol. Only this display's client requests can
// establish a context change; global thread/started notifications cannot.
// Frames and native decisions pass through unchanged. No task is synthesized.
class CodexTerminalBridge {
  constructor(endpoint, upstream, observe) {
    this.endpoint = endpoint; this.upstream = upstream; this.observe = observe;
    this.connections = new Set(); this.closed = false; this.sequence = 0;
    this.server = http.createServer();
    this.websocket = new WebSocket.Server({ server: this.server, maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD });
    this.websocket.on('connection', client => this.attach(client));
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(this.endpoint, resolve);
    });
    fs.chmodSync(this.endpoint, 0o600); return this;
  }
  attach(client) {
    if (this.closed || this.connections.size) { client.close(); return; }
    const upstream = new WebSocket('ws://localhost', {
      createConnection: () => net.connect(this.upstream), maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD, handshakeTimeout: 10000,
    });
    const state = { client, upstream, pending: new Map(), queue: [], queuedBytes: 0 };
    const rpc = { reply(id, result) {
      if (upstream.readyState !== WebSocket.OPEN || client.readyState !== WebSocket.OPEN) throw Error('原生终端连接已变化；没有发送决定。');
      upstream.send(JSON.stringify({ id, result }));
    }, get connected() { return upstream.readyState === WebSocket.OPEN && client.readyState === WebSocket.OPEN; } };
    this.connections.add(state);
    const close = () => {
      if (!this.connections.delete(state)) return;
      client.terminate(); upstream.terminate();
      this.observe({ kind: 'disconnected', rpc });
    };
    state.close = close;
    client.on('error', close); upstream.on('error', close);
    client.on('close', close); upstream.on('close', close);
    client.on('message', (data, binary) => {
      let request;
      try { request = JSON.parse(data.toString()); } catch {}
      if (request && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method) && request.id !== undefined) {
        if (state.pending.size >= 64 || state.pending.has(request.id)) { this.observe({ kind: 'uncertain' }); close(); return; }
        // Retain only routing metadata, never prompts, credentials or history.
        const metadata = { key: ++this.sequence, method: request.method, threadId: request.params?.threadId, ephemeral: request.params?.ephemeral === true };
        state.pending.set(request.id, metadata);
        this.observe({ kind: 'request', ...metadata });
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary });
        // The observer may retain an explicitly non-secret answer to a known
        // request. This is submission proof, never a claim that the model used it.
        if (request && !request.method && request.id !== undefined && request.result !== undefined) this.observe({ kind: 'reply', id: request.id, result: request.result, rpc });
      }
      else if (upstream.readyState === WebSocket.CONNECTING && state.queuedBytes + data.length <= 16 * 1024 * 1024 && state.queue.length < 64) {
        state.queue.push({ data, binary }); state.queuedBytes += data.length;
      } else { this.observe({ kind: 'uncertain' }); close(); }
    });
    upstream.on('open', () => {
      for (const frame of state.queue) upstream.send(frame.data, { binary: frame.binary });
      state.queue = []; state.queuedBytes = 0;
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) { close(); return; }
      let response;
      try { response = JSON.parse(data.toString()); } catch {}
      if (response && !response.method && state.pending.has(response.id)) {
        const metadata = state.pending.get(response.id); state.pending.delete(response.id);
        this.observe({ kind: 'response', ...metadata, result: response.result, error: Boolean(response.error), rpc });
      }
      if (response?.method) this.observe({ kind: 'native', message: response, rpc });
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const state of [...this.connections]) state.close();
    this.websocket.close(); this.server.close();
    try { fs.unlinkSync(this.endpoint); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
module.exports = { CodexTerminalBridge, CODEX_WEBSOCKET_MAX_PAYLOAD };
