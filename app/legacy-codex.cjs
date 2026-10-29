// Attach to the retained native server. This module never starts a process,
// changes native settings, writes native history, or calls the old send RPC.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { CODEX_WEBSOCKET_MAX_PAYLOAD } = require('./codex-terminal-bridge.cjs');
const { Codex, Rpc } = require('./adapters.cjs');
const { nativeTextItemId } = require('./codex-tool-content.cjs');
const { ProgressJournal } = require('./observation.cjs');
const { processMayBeAlive } = require('./platform.cjs');
const { nativeApprovalPolicy, ApprovalQueue } = require('./approval-policy.js');
const { applyNativeBlock, applyCodexHistory, applyCodexTurnHistory, applyCodexDelta, applyCodexMessage, applyCodexProgress } = require('./native-blocks.cjs');
const { readerPath, readReaderCache, writeReaderCache } = require('./reader-cache.cjs');

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
  constructor(record, dataDir) {
    super(); this.record = { ...record, recovering: true, messages: structuredClone(record.messages || []) }; this.progress = new ProgressJournal();
    this.closed = false; this.connected = false; this.revision = 0;
    this.approvalScope = crypto.randomUUID(); this.approval = null;
    this.pendingApprovals = new ApprovalQueue(() => `legacy:${this.approvalScope}:${crypto.randomUUID()}`);
    this.filename = dataDir && readerPath(dataDir, record.nativeId);
    const saved = this.filename && readReaderCache(this.filename, record);
    this.initialized = Boolean(saved);
    if (saved) {
      this.record.messages = saved.messages;
      for (const row of this.record.messages) if (['streaming', 'running', 'awaiting-native'].includes(row.status)) row.status = 'unconfirmed';
    }
    this.on('change', () => { if (!this.saving) this.scheduleSave(); });
  }
  get sharedReplyAvailable() { return this.connected && !this.closed && this.rpc?.nativeVersion === '0.163.0'; }
  get nativeActivity() { return this.adapter?.nativeActivity || null; }
  get nativeSettings() { return this.adapter?.nativeSettings || null; }
  get pending() { return this.adapter?.pending; }
  get steerAvailable() { return this.connected && !this.closed && this.adapter?.steerAvailable === true; }
  get turnId() { return this.adapter?.turnId || null; }
  async connect(socket) {
    const ws = this.ws = new WebSocket('ws://localhost', {
      createConnection: () => net.connect(socket), maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD, handshakeTimeout: 5000,
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
    adapter.recoveryNativeInputs = new Map(this.record.messages.filter(m => m.role === 'user' && m.origin === 'native').map(m => [m.id, m.text]));
    for (const m of this.record.messages) {
      if (m.role === 'assistant') adapter.historyMessageItems.add(nativeTextItemId(m, this.record.nativeId));
      if (m.role === 'user' && ['human', 'room'].includes(m.origin)) adapter.ownInputs.add(m.id);
    }
    // Retain the original native writer; consume the same event/history
    // reducers as the current service, rather than a second terminal image.
    adapter.on('history', (items, turns) => { applyCodexHistory(this.record, items, adapter, undefined, turns); this.emit('change'); });
    adapter.on('turnHistory', turns => { applyCodexTurnHistory(this.record, turns, adapter); this.emit('readerMetadata'); this.emit('change'); });
    adapter.on('delta', item => { this.emit('readerBlock', applyCodexDelta(this.record, item)); this.emit('change'); });
    adapter.on('messageItem', item => { this.emit('readerBlock', applyCodexMessage(this.record, item)); this.emit('change'); });
    adapter.on('nativeBlock', item => {
      if (applyNativeBlock(this.record, item)) this.emit('readerBlock', this.record.messages.find(m => m.id === `native:${item.nativeId}:${item.id}`));
      this.emit('change');
    });
    adapter.on('replyBound', identity => this.emit('replyBound', identity));
    adapter.on('usage', usage => { this.usage = usage; this.emit('change'); });
    adapter.on('model', model => { this.model = model; this.emit('change'); });
    adapter.on('activity', text => { this.activity = text; this.emit('change'); });
    adapter.on('nativeInput', (text, item) => {
      if (!item?.id || !this.record.messages.some(m => m.id === item.id)) this.record.messages.push({ id: item?.id || crypto.randomUUID(), role: 'user', origin: 'native', text, status: 'submitted' });
    });
    adapter.on('nativeInputImages', event => {
      if (require('./native-images.cjs').applyInputImages(this.record, event)) { this.scheduleSave(); this.emit('change'); }
    });
    for (const event of ['state', 'nativeInput', 'approval', 'failed', 'fleet', 'background', 'complete', 'submitted']) {
      adapter.on(event, (...args) => {
        if (event === 'state') {
          this.state = args[0]; if (this.state !== 'approval') this.approvalResolved = false;
          if (this.state === 'idle') this.activity = '';
          if (['disconnected', 'error', 'ended'].includes(this.state)) for (const m of this.record.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed';
        }
        if (event === 'approval') {
          this.pendingApprovals.add(args[0], args[1] || rpc, adapter);
          Object.assign(this, this.pendingApprovals.snapshot());
          this.approvalResolved = false;
        }
        if (event === 'failed') {
          this.activity = args[0];
          for (const m of this.record.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed';
          for (const item of this.progress.items.values()) if (['streaming', 'running'].includes(item.status)) {
            this.emit('progress', this.progress.update({ id: item.id, status: 'unknown' }));
          }
        }
        if (['nativeInput', 'approval', 'failed', 'fleet'].includes(event)) this.revision++;
        this.emit(event, ...args); this.emit('change');
      });
    }
    adapter.on('progress', item => {
      const update = this.progress.update(item); this.emit('progress', update);
      const row = applyCodexProgress(this.record, item);
      if (row) { this.emit('readerBlock', row); this.emit('change'); }
    });
    adapter.on('approvalResolved', (requestId, source = rpc) => {
      this.pendingApprovals.resolve(requestId, source); Object.assign(this, this.pendingApprovals.snapshot());
      this.approvalResolved = !this.approval && this.state === 'approval'; this.emit('change');
    });
    rpc.on('closed', () => { this.connected = false; this.revision++; adapter.transportClosed(); this.emit('change'); });
    rpc.on('event', message => {
      const p = message.params || {};
      if ((p.threadId || p.thread?.id) === this.record.nativeId) adapter.event(message);
      else if (message.method === 'thread/started' && p.thread?.parentThreadId === this.record.nativeId) {
        adapter.emit('fleet', { event: 'thread/started', id: p.thread.id, active: true });
      }
    });
    rpc.nativeVersion = require('./native-history.cjs').serverVersion(await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace_compat', version: '1' }, capabilities: { experimentalApi: true } }));
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
    if (this.closed) throw Error('连接操作已取消。');
    if (!loaded) throw Error('原生会话未处于可连接状态，没有恢复或重建它。');
    const revision = adapter.stateRevision;
    // No model/cwd/permission overrides. This is an explicit connection action
    // to an already loaded thread, not a background observer or cold recovery.
    try {
      const result = await rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true });
      if (this.closed || result.thread?.id !== this.record.nativeId) throw Error('原生会话连接未确认。');
      this.model = result.model || result.thread.model || null;
      if (revision === adapter.stateRevision) adapter.observeStatus(result.thread.status);
      this.subscribed = true;
    } catch (error) {
      if (!error.nativeMissingHistory || this.record.messages?.length || this.closed) throw error;
      // An empty live TUI has a loaded native ID but no rollout yet. Keep that
      // exact ID; only the person's first turn is allowed to create its history.
      this.subscribed = false; this.state = this.record.state || 'idle';
    }
    if (this.subscribed && !await adapter.hydrateHistory(this.record.nativeId)) throw Error('原生历史连接已变化，没有重发任务。');
    if (this.closed) throw Error('连接操作已取消。');
    this.record.recovering = false;
    adapter.chatAvailable = true; this.connected = true; this.initialized = true; this.save(); this.emit('change');
  }
  async send(text, tag, refresh, guard) {
    if (!this.connected || this.closed || this.pending) throw Error('原 Codex 输入连接未就绪。');
    const revision = this.revision;
    await refresh();
    const valid = () => this.connected && !this.closed && this.state === 'idle' && this.revision === revision && guard();
    if (!valid()) throw Error('原生状态已变化，输入未发送。');
    const message = { id: tag, role: 'user', text, status: 'awaiting-native', origin: 'human' };
    this.record.messages.push(message); this.emit('change');
    let turnId;
    try { turnId = await this.adapter.send(text, tag, valid); message.status = 'submitted'; }
    catch (error) { message.status = 'unconfirmed'; this.emit('change'); throw error; }
    this.emit('change');
    if (this.closed) return;
    if (!this.subscribed) {
      // The accepted first turn created native history. Rejoin for its events;
      // if it already ended, reconcile by the exact native turn ID.
      try {
        await this.adapter.observeAcceptedTurn(turnId, tag);
        if (this.closed) throw Error('原生观察连接已变化。');
        this.subscribed = true;
      } catch {
        // ACK was already received. Never turn a later observation failure
        // into a failed send that invites duplicate billing.
        this.state = 'error'; this.emit('failed', '消息已被原生接受，但后续状态尚未同步；请核对原生终端，不要重发。');
      }
    }
  }
  async steer(text, tag, expectedTurnId, refresh, guard, shared = false, sharingGuard = guard) {
    if (!this.steerAvailable || this.pendingSteer) throw Error('原生追加指令连接尚未就绪。');
    this.pendingSteer = tag;
    const revision = this.revision;
    let message;
    try {
      await refresh();
      const valid = () => this.steerAvailable && this.revision === revision && this.state === 'working' && !this.approval && this.turnId === expectedTurnId && guard();
      if (!valid()) throw Error('当前原生回合已变化，草稿保留。');
      message = { id: tag, role: 'user', text, status: 'awaiting-native', origin: 'human', inputMode: 'steer', turnId: expectedTurnId };
      this.record.messages.push(message); this.emit('change');
      // Native work can complete before the ACK. Sending still requires the
      // working turn; accepting its proven result only requires intact authority.
      const accepted = () => this.steerAvailable && this.revision === revision && ['idle', 'working'].includes(this.state) &&
        !this.approval && this.turnId === expectedTurnId && sharingGuard();
      await this.adapter.steer(text, tag, expectedTurnId, valid, shared, accepted); message.status = 'submitted';
    } catch (error) { if (message && message.status !== 'submitted') message.status = 'unconfirmed'; throw error; }
    finally { this.pendingSteer = null; this.emit('change'); }
  }
  observe() { return { terminal: null, progress: this.progress.snapshot() }; }
  approve(requestId, decision) {
    const route = this.pendingApprovals.get(requestId);
    if (!this.connected || this.closed || this.state !== 'approval' || !route || route.approval.pending || route.rpc !== this.rpc || this.pendingApprovals.overflow) throw Error('权限请求已变化，请重新查看。');
    if (!nativeApprovalPolicy(route.approval).decisions.includes(decision)) throw Error('请在原生终端核对；此界面不支持这项权限决定。');
    route.rpc.reply(route.nativeRequestId, { decision });
    if (this.pendingApprovals.get(requestId) === route) { route.approval = { ...route.approval, pending: true }; Object.assign(this, this.pendingApprovals.snapshot()); }
    this.emit('change');
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.connected = false; this.revision++;
    clearTimeout(this.saveTimer); this.saveTimer = null; this.save();
    if (this.adapter) { this.adapter.forgetNativeRequests(); this.adapter.stopped = true; }
    // Closing only this subscription must not invoke adapter.stop(), native
    // interrupt, thread/unsubscribe on another client, or server termination.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
    else this.ws?.terminate();
  }
  scheduleSave() {
    if (this.closed || this.saveTimer || !this.initialized || !this.filename) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 200);
  }
  save() {
    if (!this.initialized || !this.filename) return;
    this.saving = true;
    try { writeReaderCache(this.filename, this.record); this.storageError = false; }
    catch { this.storageError = true; this.emit('change'); }
    finally { this.saving = false; }
  }
}
module.exports = { LegacyCodex, eligibleCodex, retainedSocket };
