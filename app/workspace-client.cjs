const { EventEmitter } = require('node:events');
const { submissionState, assertSubmission, assertSharing, assertAutomaticRun, assertNativeCreation } = require('./submission-policy.cjs');
const { isTerminalResponse } = require('./workspace.cjs');
let creationQueue = Promise.resolve();
const controls = new Map();

// A flat routing layer, not a second agent runtime. Each service remains the
// sole writer of its sessions, drafts and shared replies, even with no UI open.
class WorkspaceClient extends EventEmitter {
  constructor(entries, active, scope = Symbol()) {
    super(); this.entries = entries; this.active = entries.find(e => e.key === active); this.closing = false;
    this.scope = scope;
    if (!controls.has(scope)) controls.set(scope, { revision: 0, clients: 0, armed: new Map(), interventions: new Set(), views: new Set() });
    this.control = controls.get(scope); this.control.clients++; this.control.views.add(this);
    for (const entry of entries) {
      entry.closed = false; entry.closing = false;
      entry.closedPromise = new Promise(resolve => { entry.confirmClosed = resolve; });
      if (entry.state.room.run?.status === 'running' && !this.control.armed.has(entry.key)) this.control.armed.set(entry.key, { entry });
    }
    this.socket = { destroyed: false };
    for (const entry of entries) {
      entry.client.on('state', state => {
        entry.state = { ...entry.state, ...state };
        try { this.emit('state', this.snapshot()); }
        catch { this.socket.destroyed = true; this.emit('closed'); this.close(); }
      });
      entry.client.on('terminal', data => this.emit('terminal', data));
      entry.client.on('closed', () => { entry.closed = true; entry.confirmClosed(); this.socket.destroyed = true; this.control.revision++; if (!this.closing) this.emit('closed'); });
    }
  }
  snapshot() {
    const sessions = [], messages = new Map(), runs = [];
    const ids = new Set();
    for (const e of this.entries) {
      const state = submissionState(e.state);
      for (const s of state.sessions) {
        if (ids.has(s.id)) throw new Error('会话归属冲突；未向任何原生会话发送输入。');
        ids.add(s.id); sessions.push({ ...s, serviceCapabilities: e.state.capabilities || [], runtimeVersion: e.state.runtimeVersion });
      }
      for (const m of state.room.messages || []) {
        if (messages.has(m.id)) throw new Error('共享记录归属冲突；原记录已保留。');
        messages.set(m.id, m);
      }
      if (state.room.run) runs.push(state.room.run);
    }
    const memberServices = this.entries.filter(e => e.state.sessions.some(s => s.roomId === 'shared'));
    const routingService = memberServices.length === 1 ? memberServices[0] : this.active;
    const capabilities = (this.active.state.capabilities || []).filter(cap => {
      if (cap === 'verifiedHandoffs') return memberServices.length <= 1 && routingService.state.capabilities?.includes(cap) && routingService.state.capabilities?.includes('nativeInputIsolation');
      if (cap === 'clearSharedHistory') return this.entries.every(e => e.state.capabilities?.includes(cap));
      return true;
    });
    const sum = key => this.entries.every(e => Number.isSafeInteger(e.state.diagnostics?.[key])) ? this.entries.reduce((n, e) => n + e.state.diagnostics[key], 0) : null;
    runs.sort((a, b) => (b.status === 'running') - (a.status === 'running') || (b.startedAt || 0) - (a.startedAt || 0));
    return { ...this.active.state, sessions, capabilities,
      room: { ...this.active.state.room, revision: this.entries.reduce((n, e) => n + (e.state.room.revision || 0), 0), run: runs[0] || null, messages: [...messages.values()].sort((a, b) => (a.time || 0) - (b.time || 0)) },
      diagnostics: { shellModelCalls: sum('shellModelCalls'), dispatches: sum('dispatches') },
      storageWarning: this.entries.map(e => e.state.storageWarning).filter(Boolean).join('\n') || null,
      services: this.entries.map(e => ({ version: e.state.runtimeVersion, active: e === this.active, sessions: e.state.sessions.length })),
      handoffNotice: memberServices.length > 1 ? '成员使用不同版本的后台，自动交接暂不可用。可在同一协作视图查看终端、选择内容并定向分享。' : null,
    };
  }
  route(id) {
    const matches = this.entries.filter(e => e.state.sessions.some(s => s.id === id));
    if (matches.length !== 1) throw new Error('找不到唯一的会话归属；没有发送输入。');
    return matches[0];
  }
  async refresh() {
    await Promise.all(this.entries.map(async e => {
      e.state = await e.client.call('initial');
      if (e.state.room.run?.status === 'running' && !this.control.armed.has(e.key)) this.control.armed.set(e.key, { entry: e });
    }));
    return this.snapshot();
  }
  async pauseExcept(target) {
    // Run intent is shared by every window and registered before its RPC, not
    // inferred from a delayed display snapshot. Use the originating connection
    // so pause is ordered after run even when another window intervenes.
    await Promise.all([...this.control.armed].filter(([key]) => key !== target?.key).map(([, arm]) => this.pauseEntry(arm.entry)));
  }
  async pauseEntry(entry, explicit = false) {
    const arm = this.control.armed.get(entry.key);
    if (!arm) return explicit ? entry.client.call('pause') : undefined;
    if (!arm.pause) arm.pause = (async () => {
      if (arm.entry.closing || arm.entry.closed) {
        // A normal window close is not a cancellation. Wait for its ordered
        // connection to close before another window sends the pause.
        if (!arm.entry.closed) {
          let timer;
          try { await Promise.race([arm.entry.closedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('原窗口尚未确认断开；输入未发送，请重新连接。')), 2500); })]); }
          finally { clearTimeout(timer); }
        }
        const replacement = [...this.control.views].filter(view => !view.closing && !view.socket.destroyed).flatMap(view => view.entries).find(e => e.key === entry.key && !e.closed && !e.closing);
        if (!replacement) throw new Error('没有可确认暂停的连接；输入未发送，请重新连接。');
        arm.entry = replacement;
      }
      return arm.entry.client.call('pause');
    })().then(result => {
      if (this.control.armed.get(entry.key) === arm) this.control.armed.delete(entry.key);
      return result;
    }).catch(error => { arm.pause = null; throw error; });
    return arm.pause;
  }
  async intervene(operation) {
    this.control.revision++;
    const pending = operation(); this.control.interventions.add(pending);
    try { return await pending; } finally { this.control.interventions.delete(pending); }
  }
  async call(method, ...args) {
    if (this.socket.destroyed) throw new Error('本地服务未连接；请重新连接，输入不会自动重发。');
    this.authorizeOperation?.(method, args);
    if (method === 'initial') return this.refresh();
    if (method === 'pause') return this.intervene(() => {
      const entries = new Map(this.entries.map(e => [e.key, e]));
      for (const [key, arm] of this.control.armed) entries.set(key, arm.entry);
      return Promise.all([...entries.values()].map(e => this.pauseEntry(e, true)));
    });
    if (method === 'create') {
      const operation = creationQueue.then(async () => {
        const state = await this.refresh(); assertNativeCreation(state);
        if (state.sessions.filter(s => s.state !== 'ended').length >= 6) throw new Error('Demo 最多同时运行 6 个会话，请先结束不需要的会话。');
        const id = await this.active.client.call(method, ...args); await this.refresh(); return id;
      });
      creationQueue = operation.catch(() => {}); return operation;
    }
    if (method === 'shutdown' || method === 'clearSharedHistory') {
      const state = await this.refresh();
      if (method === 'shutdown' && state.sessions.some(s => s.state !== 'ended')) throw new Error('请先结束各原生会话，再关闭运行服务。');
      if (method === 'clearSharedHistory' && (!state.capabilities.includes(method) || state.room.run?.status === 'running')) throw new Error('请先暂停交接，并确认各后台支持清除记录。');
      // These are explicit user actions. Partial failure must remain visible.
      const results = await Promise.allSettled(this.entries.map(e => e.client.call(method)));
      if (results.some(r => r.status === 'rejected')) throw new Error('部分后台未确认操作；请重新连接核对，未自动重试。');
      return true;
    }
    if (method === 'run') {
      const revision = ++this.control.revision;
      const interventions = [...this.control.interventions];
      const state = await this.refresh();
      if (!Array.isArray(args[0]) || args[0].length !== 2) throw new Error('请选择两个不同会话。');
      const targets = args[0].map(id => this.route(id));
      if (targets[0] !== targets[1]) throw new Error('跨版本自动交接暂不可用；请选择内容并定向分享。');
      assertAutomaticRun(state); assertSharing(state, args[0]);
      await Promise.all(interventions);
      await this.pauseExcept(targets[0]);
      const previousArm = this.control.armed.get(targets[0].key);
      if (previousArm?.entry.closing || previousArm?.entry.closed) await this.pauseEntry(targets[0]);
      const previousPause = this.control.armed.get(targets[0].key)?.pause;
      if (previousPause) await previousPause;
      if (revision !== this.control.revision || this.socket.destroyed) throw new Error('真人操作已使这次交接失效；请重新确认任务。');
      this.authorizeOperation?.(method, args);
      const arm = this.control.armed.get(targets[0].key) || { entry: targets[0] };
      this.control.armed.set(targets[0].key, arm);
      return arm.entry.client.call(method, ...args);
    }
    if (!['join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'forward', 'approve', 'stop', 'resume', 'forget'].includes(method)) throw new Error('不支持的本地操作。');
    const target = this.route(args[0]);
    if (method === 'resume') assertNativeCreation(target.state);
    if (['send', 'forward'].includes(method)) assertSubmission(target.state, [args[0]]);
    if (method === 'forward') assertSharing(target.state, [args[0]]);
    const ownView = ['claim', 'terminal'].includes(method) && typeof target.state.owner === 'string' && target.state.sessions.find(s => s.id === args[0])?.owner === target.state.owner;
    if (ownView) return target.client.call(method, ...args);
    if (['join', 'claim', 'terminal', 'send', 'interrupt', 'forward', 'stop', 'resume'].includes(method) || (method === 'input' && !isTerminalResponse(args[1]))) return this.intervene(async () => {
      await this.pauseExcept(null); this.authorizeOperation?.(method, args); return target.client.call(method, ...args);
    });
    return target.client.call(method, ...args);
  }
  close() {
    if (this.closing) return;
    this.closing = true; this.socket.destroyed = true; this.control.revision++;
    for (const e of this.entries) { e.closing = true; e.client.close(); }
    this.control.views.delete(this);
    if (--this.control.clients === 0) controls.delete(this.scope);
  }
}
module.exports = { WorkspaceClient };
