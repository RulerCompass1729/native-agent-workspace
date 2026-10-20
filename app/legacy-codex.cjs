// Attach to the retained native server. This module never starts a process,
// changes native settings, writes native history, or calls the old send RPC.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { Codex, Rpc } = require('./adapters.cjs');
const { ProgressJournal } = require('./observation.cjs');
const { processMayBeAlive } = require('./platform.cjs');
const { nativeApprovalPolicy } = require('./approval-policy.js');

function eligibleCodex(state, record) {
  return state.runtimeVersion === '0.1.0-alpha.2' && record?.provider === 'codex'
    && /^[a-f0-9-]{36}$/i.test(record.nativeId || '')
    && Number.isSafeInteger(record.pid) && record.pid > 1
    && Number.isSafeInteger(record.serverIdentity?.pid) && record.serverIdentity.pid > 1;
}
function retainedSocket(dataDir, entry, record) {
  if (!eligibleCodex(entry.state, record) || record.processIdentity?.pid !== record.pid
    || !processMayBeAlive(record.processIdentity) || !processMayBeAlive(record.serverIdentity)) throw Error('原 Codex 进程已变化，没有启动替代会话。');
  const filename = path.join(dataDir, entry.key, 'connection.json');
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('原连接文件权限不安全。');
  const info = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (info.protocol !== 1 || info.pid !== entry.state.servicePid || !path.isAbsolute(info.endpoint)) throw Error('原连接身份已变化。');
  const directory = path.dirname(info.endpoint), parent = fs.lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw Error('原连接目录权限不安全。');
  const socket = path.join(directory, 'codex.sock'), link = fs.lstatSync(socket);
  // Native Codex can publish an owned symlink to its private daemon socket.
  // Validate the resolved endpoint and directory instead of banning the
  // provider's actual transport or trusting an arbitrary redirect.
  if (link.uid !== process.getuid()) throw Error('原 Codex 接口不可用。');
  const resolved = fs.realpathSync(socket), sock = fs.lstatSync(resolved);
  const container = fs.lstatSync(path.dirname(resolved));
  if (!sock.isSocket() || sock.uid !== process.getuid() || sock.mode & 0o077
    || !container.isDirectory() || container.isSymbolicLink() || container.uid !== process.getuid() || container.mode & 0o077) throw Error('原 Codex 接口不可用。');
  return resolved;
}

class LegacyCodex extends EventEmitter {
  constructor(record) {
    super(); this.record = { ...record }; this.progress = new ProgressJournal();
    this.closed = false; this.connected = false; this.revision = 0;
    this.approvalScope = crypto.randomUUID(); this.approval = null;
  }
  get pending() { return this.adapter?.pending; }
  async connect(socket) {
    const ws = this.ws = new WebSocket('ws://localhost', {
      createConnection: () => net.connect(socket), maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000,
    });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(Error('原生连接已关闭。'))); });
    if (this.closed) { ws.close(); throw Error('连接操作已取消。'); }
    const rpc = this.rpc = new Rpc(ws);
    const host = { rpc, codexTargets: new Map() };
    // Use the current event/turn correlation implementation, but never start()
    // it: start() owns native lifecycle and can launch or resume a TUI.
    const adapter = this.adapter = new Codex({ ...this.record, view: 'chat' }, host);
    adapter.chatAvailable = false;
    for (const event of ['state', 'nativeInput', 'approval', 'failed', 'fleet', 'background', 'complete', 'submitted']) {
      adapter.on(event, (...args) => {
        if (event === 'state') { this.state = args[0]; if (this.state !== 'approval') this.approvalResolved = false; }
        if (event === 'approval') {
          this.approval = { ...args[0], requestId: `legacy:${this.approvalScope}:${crypto.randomUUID()}` };
          this.approvalResolved = false;
          this.nativeRequestId = args[0].requestId;
        }
        if (['nativeInput', 'approval', 'failed', 'fleet'].includes(event)) this.revision++;
        this.emit(event, ...args); this.emit('change');
      });
    }
    adapter.on('progress', item => { const update = this.progress.update(item); this.emit('progress', update); });
    adapter.on('approvalResolved', requestId => {
      if (requestId !== this.nativeRequestId) return;
      this.approval = null; this.nativeRequestId = undefined; this.approvalResolved = this.state === 'approval'; this.emit('change');
    });
    rpc.on('closed', () => { this.connected = false; this.revision++; adapter.transportClosed(); this.emit('change'); });
    rpc.on('event', message => {
      const p = message.params || {};
      if ((p.threadId || p.thread?.id) === this.record.nativeId) adapter.event(message);
      else if (message.method === 'thread/started' && p.thread?.parentThreadId === this.record.nativeId) {
        adapter.emit('fleet', { event: 'thread/started', id: p.thread.id, active: true });
      }
    });
    await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace_compat', version: '1' }, capabilities: { experimentalApi: true } });
    if (this.closed) throw Error('连接操作已取消。');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    let loaded = false, cursor;
    for (let page = 0; page < 100 && !loaded; page++) {
      if (this.closed) throw Error('连接操作已取消。');
      const result = await rpc.call('thread/loaded/list', { ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw Error('原生会话列表无法确认。');
      loaded = result.data.includes(this.record.nativeId);
      if (!result.nextCursor) break;
      if (result.nextCursor === cursor) throw Error('原生会话列表无法确认。');
      cursor = result.nextCursor;
    }
    if (!loaded || this.closed) throw Error('原生会话未处于可连接状态，没有恢复或重建它。');
    const revision = adapter.stateRevision;
    // No model/cwd/permission overrides. This is an explicit connection action
    // to an already loaded thread, not a background observer or cold recovery.
    try {
      const result = await rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true });
      if (this.closed || result.thread?.id !== this.record.nativeId) throw Error('原生会话连接未确认。');
      if (revision === adapter.stateRevision) adapter.observeStatus(result.thread.status);
      this.subscribed = true;
    } catch (error) {
      if (!error.nativeMissingHistory || this.record.messages?.length || this.closed) throw error;
      // An empty live TUI has a loaded native ID but no rollout yet. Keep that
      // exact ID; only the person's first turn is allowed to create its history.
      this.subscribed = false; this.state = this.record.state || 'idle';
    }
    adapter.chatAvailable = true; this.connected = true; this.emit('change');
  }
  async send(text, tag, refresh, guard) {
    if (!this.connected || this.closed || this.pending) throw Error('原 Codex 输入连接未就绪。');
    const revision = this.revision;
    await refresh();
    const valid = () => this.connected && !this.closed && this.state === 'idle' && this.revision === revision && guard();
    if (!valid()) throw Error('原生状态已变化，输入未发送。');
    const turnId = await this.adapter.send(text, tag, valid);
    if (this.closed) return;
    if (!this.subscribed) {
      // The accepted first turn created native history. Rejoin for its events;
      // if it already ended, reconcile by the exact native turn ID.
      try {
        await this.adapter.observeAcceptedTurn(turnId);
        if (this.closed) throw Error('原生观察连接已变化。');
        this.subscribed = true;
      } catch {
        // ACK was already received. Never turn a later observation failure
        // into a failed send that invites duplicate billing.
        this.state = 'error'; this.emit('failed', '消息已被原生接受，但后续状态尚未同步；请核对原生终端，不要重发。');
      }
    }
  }
  observe() { return { terminal: null, progress: this.progress.snapshot() }; }
  approve(requestId, decision) {
    if (!this.connected || this.closed || this.state !== 'approval' || this.approval?.pending || this.approval?.requestId !== requestId) throw Error('权限请求已变化，请重新查看。');
    if (!nativeApprovalPolicy(this.approval).decisions.includes(decision)) throw Error('请在原生终端核对；此界面不支持这项权限决定。');
    this.rpc.reply(this.nativeRequestId, { decision });
    if (this.approval?.requestId === requestId) this.approval = { ...this.approval, pending: true };
    this.emit('change');
  }
  close() {
    this.closed = true; this.connected = false; this.revision++;
    if (this.adapter) { this.adapter.forgetNativeRequests(); this.adapter.stopped = true; }
    // Closing only this subscription must not invoke adapter.stop(), native
    // interrupt, thread/unsubscribe on another client, or server termination.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
    else this.ws?.terminate();
  }
}
module.exports = { LegacyCodex, eligibleCodex, retainedSocket };
