// GUI glue over existing authenticated service entries, never a native client.
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');
const CAPABILITY = 'scopedNativeOutboxV1';
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
function supported(entry) { return entry.state.capabilities?.includes(CAPABILITY) === true && !entry.closed; }
async function request(client, action, value) {
  let timer;
  try {
    const response = await Promise.race([client.call('scopedOutbox', action, value),
      new Promise((_, reject) => { timer = setTimeout(() => reject(outboxError(action === 'close' ? 'cleanup-unconfirmed' : 'operation-unconfirmed', action === 'close' ? 'cleanup' : action === 'send' ? 'view-send' : 'binding')), action === 'send' ? 35000 : 5000); timer.unref(); })]);
    if (response?.ok !== true) throw outboxError(response?.failureReason, response?.failurePhase);
    return response.value;
  } finally { clearTimeout(timer); }
}
class ScopeLink extends EventEmitter {
  constructor(client, nativeId, signal) {
    super(); this.client = client; this.nativeId = nativeId; this.op = randomUUID(); this.live = true; this.closed = false; this.early = [];
    this.received = data => {
      if (this.closed || data?.op !== this.op || !token(data.token)) return;
      if (!this.token) { if (this.early.length < 4) this.early.push(data); return; }
      if (data.token !== this.token) return;
      if (data.kind === 'invalidated') { this.live = false; this.serverClosed = true; this.emit('invalidated'); return; }
      if (data.kind !== 'receipt' || !this.tag) return;
      const r = data.receipt;
      if (r?.source !== 'codex-native' || r.nativeId !== this.nativeId || r.inputTag !== this.tag || r.nativeReceived !== true || !token(r.turnId)) return;
      const value = { source: 'codex-native', nativeId: this.nativeId, inputTag: this.tag, nativeReceived: true, turnId: r.turnId };
      const c = r.firstCommand;
      if (c && c.kind === 'commandExecution' && token(c.id) && c.inputTag === this.tag && c.turnId === r.turnId &&
          ['completed', 'failed'].includes(c.status) && Number.isSafeInteger(c.exitCode) && typeof c.command === 'string' && c.command && c.command.length <= 4096)
        value.firstCommand = { kind: c.kind, id: c.id, inputTag: c.inputTag, turnId: c.turnId, status: c.status, exitCode: c.exitCode, command: c.command };
      this.latest = value; this.emit('receipt', value);
    };
    this.disconnected = () => { this.live = false; this.emit('invalidated'); };
    this.aborted = () => { this.live = false; this.close().catch(() => {}); };
    this.signal = signal;
    client.on('scopedOutbox', this.received); client.on('closed', this.disconnected);
    signal?.addEventListener('abort', this.aborted, { once: true });
  }
  bind(value) {
    if (!token(value?.token) || this.closed || this.signal?.aborted) throw outboxError('grant-invalidated', 'binding');
    this.token = value.token;
    const early = this.early; this.early = []; for (const data of early) this.received(data);
    if (!this.live) throw outboxError('grant-invalidated', 'binding');
  }
  async check() {
    if (!this.live || this.closed) throw outboxError('grant-invalidated', 'binding');
    const result = await request(this.client, 'check', { token: this.token });
    if (!this.live || result?.valid !== true) throw outboxError('grant-invalidated', 'binding');
  }
  subscribe(listener) {
    this.on('receipt', listener); if (this.latest) listener(this.latest);
    return () => this.off('receipt', listener);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.live = false;
    this.client.off('scopedOutbox', this.received); this.client.off('closed', this.disconnected);
    this.signal?.removeEventListener('abort', this.aborted); this.removeAllListeners(); this.early = [];
    this.closing = this.serverClosed ? Promise.resolve() : request(this.client, 'close', this.token ? { token: this.token } : { op: this.op });
    this.closing.catch(() => {}); return this.closing;
  }
}
async function cleanupFailure(link, error) {
  try { await link.close(); } catch {
    const detail = classifyOutboxFailure(error, 'binding', 'binding-unavailable');
    throw outboxError(detail.failureReason, detail.failurePhase, undefined, true);
  }
  throw error;
}
async function openManagedCall(entry, caller, identity, args, signal, control = false) {
  if (!supported(entry)) throw outboxError('caller-unavailable', 'binding');
  if (control && !entry.state.capabilities?.includes(require('./background-operation.cjs').CAPABILITY)) throw outboxError('caller-unavailable', 'binding');
  const link = new ScopeLink(entry.client, identity.nativeId, signal);
  try {
    const value = await request(entry.client, control ? 'controlCall' : 'call', { op: link.op, callerId: caller.id, identity, arguments: args });
    link.bind(value);
    const s = value.sender;
    if (s?.id !== caller.id || s.nativeId !== identity.nativeId || s.provider !== (control ? caller.provider : 'codex') || !token(s.name)) throw outboxError('provenance-unconfirmed', 'binding');
    return { args, sender: { id: s.id, nativeId: s.nativeId, provider: s.provider, name: s.name },
      valid: () => link.live && !link.closed && !signal?.aborted, refresh: () => link.check(), close: () => link.close() };
  } catch (error) { return cleanupFailure(link, error); }
}
async function prepareManagedRecipient(entry, record, grant) {
  if (!supported(entry)) throw outboxError('recipient-unavailable', 'binding');
  const link = new ScopeLink(entry.client, record.nativeId, grant.signal);
  try {
    const value = await request(entry.client, 'prepare', { op: link.op, recipientId: record.id, expected: grant.expected,
      sender: grant.sender, text: grant.text });
    link.bind(value);
    if (value.nativeId !== record.nativeId) throw outboxError('recipient-unavailable', 'binding');
    const native = { state: 'idle', pending: null, sharedReplyAvailable: false,
      get connected() { return link.live && !link.closed; }, get closed() { return link.closed; },
      async send(text, tag, refresh, guard) {
        if (!this.connected || this.pending || link.tag) throw outboxError('duplicate-call', 'view-send');
        await refresh(); if (!this.connected || !guard()) throw outboxError('grant-invalidated', 'view-send');
        link.tag = tag; this.pending = { tag };
        try {
          const receipt = await request(entry.client, 'send', { token: link.token, tag, text });
          if (receipt?.tag !== tag) throw outboxError('send-unconfirmed', 'view-send');
          this.state = 'working'; return tag;
        } finally { this.pending = null; }
      }, close: () => link.close(),
    };
    return { record: { id: record.id, nativeId: record.nativeId, pid: record.pid }, managed: true, native, submission: native,
      monitor: { bind(tag) { if (link.tag !== tag) throw outboxError('receipt-unconfirmed', 'native-receipt'); },
        subscribe: listener => link.subscribe(listener), close() { link.removeAllListeners('receipt'); } },
      watchReceipt: listener => link.subscribe(listener) };
  } catch (error) { return cleanupFailure(link, error); }
}
module.exports = { CAPABILITY, supported, openManagedCall, prepareManagedRecipient };
