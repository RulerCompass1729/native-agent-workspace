const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const { randomUUID } = require('node:crypto');

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
    const state = { client, upstream, pending: new Map(), queue: [], queuedBytes: 0, appPending: new Map(), threadId: null };
    const appPrefix = `naw-outbox:${randomUUID()}:`; let appSequence = 0;
    const rpc = { reply(id, result) {
      if (upstream.readyState !== WebSocket.OPEN || client.readyState !== WebSocket.OPEN) throw uiError("error.terminalConnectionChangedNoDecision");
      upstream.send(JSON.stringify({ id, result }));
    }, call(method, params) {
      const keys = value => value && Object.keys(value).sort().join(',');
      const metadata = method === 'thread/turns/list' && keys(params) === 'itemsView,limit,sortDirection,threadId' &&
        params.limit === 1 && params.itemsView === 'notLoaded' && params.sortDirection === 'desc';
      const goal = method === 'thread/goal/get' && keys(params) === 'threadId';
      const input = params?.input?.[0];
      const task = method === 'turn/start' && keys(params) === 'clientUserMessageId,input,threadId' &&
        typeof params.clientUserMessageId === 'string' && /^[a-f0-9-]{36}$/i.test(params.clientUserMessageId) &&
        Array.isArray(params.input) && params.input.length === 1 && keys(input) === 'text,text_elements,type' && input.type === 'text' &&
        typeof input.text === 'string' && input.text.trim() && input.text.length <= 16000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text) &&
        Array.isArray(input.text_elements) && input.text_elements.length === 0;
      if ((!metadata && !task && !goal) || !rpc.connected || !state.threadId || params.threadId !== state.threadId ||
          [...state.pending.values()].some(p => !p.ephemeral) || state.appPending.size >= 8)
        return Promise.reject(uiError('error.nativeSendUnavailable'));
      return new Promise((resolve, reject) => {
        const id = appPrefix + (++appSequence);
        const timer = setTimeout(() => { state.appPending.delete(id); reject(uiError('error.nativeRequestTimeout')); }, 30000);
        timer.unref(); state.appPending.set(id, { resolve, reject, timer });
        upstream.send(JSON.stringify({ id, method, params }));
      });
    }, get connected() { return upstream.readyState === WebSocket.OPEN && client.readyState === WebSocket.OPEN; } };
    this.connections.add(state);
    const close = () => {
      if (!this.connections.delete(state)) return;
      for (const request of state.appPending.values()) { clearTimeout(request.timer); request.reject(uiError('error.nativeDisconnectedNoReplay')); }
      state.appPending.clear();
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
      if (response && !response.method && typeof response.id === 'string' && response.id.startsWith(appPrefix)) {
        const request = state.appPending.get(response.id); state.appPending.delete(response.id);
        if (request) {
          clearTimeout(request.timer);
          if (response.error) {
            const error = uiError('error.nativeRequestRejected', { arg1: response.error.code });
            // Match the existing host RPC contract without exposing native text.
            error.nativeGoalsDisabled = response.error.code === -32600 && response.error.message === 'goals feature is disabled';
            request.reject(error);
          } else request.resolve(response.result);
        }
        return; // Even a late private response must not reach the native TUI.
      }
      if (response && !response.method && state.pending.has(response.id)) {
        const metadata = state.pending.get(response.id); state.pending.delete(response.id);
        if (!metadata.ephemeral && !response.error && typeof response.result?.thread?.id === 'string') state.threadId = response.result.thread.id;
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
