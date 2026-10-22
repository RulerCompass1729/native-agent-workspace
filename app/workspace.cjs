const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const { ProgressJournal } = require('./observation.cjs');
const { applyNativeBlock } = require('./native-blocks.cjs');
const { nativeApprovalPolicy } = require('./approval-policy.js');
const { NativeHistory, nativeId } = require('./native-history.cjs');

const cleanText = (value, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`请输入有效文字；一次最多 ${max.toLocaleString('en-US')} 个字符。`);
  return value.trim();
};
const isTerminalResponse = data => /^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\](10|11);rgb:[\da-f/]+(\x07|\x1b\\)$/i.test(data);

class Workspace extends EventEmitter {
  constructor(host, dataDir) {
    super(); this.host = host; this.dataDir = dataDir; this.sessions = new Map(); this.runtimes = new Map(); this.drafts = new Map(); this.draftRevisions = new Map();
    this.room = { id: 'shared', name: '共同工作', revision: 0, run: null, messages: [] };
    this.versions = { shellModelCalls: 0, dispatches: 0 };
    this.saveTimer = null;
    this.deadlineTimer = setInterval(() => this.expireRun(), 1000);
    this.deadlineTimer.unref();
    this.forwards = new Map(); this.pendingDrafts = new Map();
    this.approvalRoutes = new Map();
    this.stops = new Map();
    this.progress = new Map(); this.observedTerminals = new Map();
    this.nativeHistory = new NativeHistory(host); this.historyQueue = Promise.resolve(); this.pendingNativeImports = 0;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'));
      for (const record of stored.sessions || []) this.sessions.set(record.id, { ...record, fleet: (record.fleet || []).map(item => ({ ...item, stale: true })), state: record.state === 'ended' ? 'ended' : 'recoverable', owner: null, approval: null, approvalResolved: false, pid: null, pendingTag: null, controlRevision: 0, liveDraft: '', activity: record.state === 'ended' ? '' : '运行服务曾中断；记录和草稿已保留，任务不会自动重发。' });
      for (const session of this.sessions.values()) for (const message of session.messages || []) {
        if (message.status === 'streaming') message.status = 'unconfirmed';
      }
      this.room.messages = stored.room?.messages || [];
      for (const m of this.room.messages) for (const delivery of m.deliveries || []) {
        if (delivery.status === 'awaiting-native') delivery.status = 'unconfirmed';
      }
      if (stored.room?.run) this.room.run = { ...stored.room.run, awaiting: null, ...(stored.room.run.status === 'running' ? { status: 'paused', reason: '运行服务曾中断；未重发任务，请核对原生结果。' } : {}) };
      if (stored.drafts) for (const [key, value] of Object.entries(stored.drafts)) this.drafts.set(key, value);
    } catch (error) {
      if (error.code !== 'ENOENT') { this.storageFailure = 'read'; this.storageWarning = '本地记录未能读取，原文件已保留；请检查后再保存。'; }
    }
  }
  snapshot() {
    return { sessions: [...this.sessions.values()].map(s => ({ ...s, nativeBlockMapping: true, backendUnavailable: Boolean(this.runtimes.get(s.id)?.backendExitConfirmed), transportDisconnected: Boolean(this.runtimes.get(s.id)?.transportDisconnected), terminalState: this.runtimes.get(s.id)?.terminal ? { alive: Boolean(this.runtimes.get(s.id).terminal.alive), exitConfirmed: this.runtimes.get(s.id).terminal.nativeExited === true, epoch: this.runtimes.get(s.id).terminal.journal?.epoch || null } : null, terminalAvailable: Boolean(this.runtimes.get(s.id)?.terminal?.alive || (!this.runtimes.get(s.id)?.stopped && this.runtimes.get(s.id)?.hasHistory)), chatAvailable: this.runtimes.get(s.id)?.chatAvailable !== false, liveDraft: this.drafts.get(s.id) || '' })), room: this.room, diagnostics: this.versions, available: Object.fromEntries(Object.entries(this.host.binaries).map(([k, v]) => [k, Boolean(v)])), storageWarning: this.storageWarning || null, storageRetryable: this.storageFailure === 'write' };
  }
  changed() {
    this.emit('change');
    if (this.storageWarning) return;
    // Keep burst coalescing, but a continuously streaming reply must not
    // postpone every checkpoint until the provider becomes quiet.
    if (!this.saveDeadline) this.saveDeadline = setTimeout(() => this.persist(), 1000);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 150);
  }
  persist() {
    clearTimeout(this.saveTimer); clearTimeout(this.saveDeadline);
    this.saveTimer = this.saveDeadline = null;
    if (this.storageWarning) return;
    const target = path.join(this.dataDir, 'workspace.json'); const temp = `${target}.tmp`;
    try {
      // No terminal bytes, credentials, environment, hook secrets or raw protocol.
      const sessions = [...this.sessions.values()].map(({ owner, approval, approvalResolved, pid, ...s }) => ({ ...s, messages: s.messages.filter(m => !m.volatile), pendingTag: null }));
      fs.writeFileSync(temp, JSON.stringify({ sessions, room: { messages: this.room.messages, ...(this.room.run ? { run: this.room.run } : {}) }, drafts: Object.fromEntries(this.drafts) }), { mode: 0o600 });
      fs.renameSync(temp, target); fs.chmodSync(target, 0o600);
    } catch { this.storageFailure = 'write'; this.storageWarning = '本地保存失败，当前会话仍在内存中；请保留窗口并检查磁盘，恢复后重试保存。'; this.emit('change'); }
  }
  retrySave() {
    // A failed read may hide existing records. Never overwrite it with the
    // incomplete in-memory state, even when the person requests a write retry.
    if (this.storageFailure !== 'write') throw new Error('没有可重试的写入；未读取的原文件不会被覆盖。');
    this.storageFailure = null; this.storageWarning = null;
    this.persist(); this.emit('change');
    if (this.storageWarning) throw new Error('仍未能保存，请保留窗口并检查磁盘空间和写入权限。');
    return true;
  }
  get(id) { const s = this.sessions.get(id); if (!s) throw new Error('找不到这个会话。'); return s; }
  runtime(id) { const r = this.runtimes.get(id); if (!r) throw new Error('会话已经结束；保存的记录仍可查看。'); return r; }
  async observe(id) {
    this.get(id);
    const terminal = this.runtimes.get(id)?.terminal || this.observedTerminals.get(id);
    return { terminal: terminal?.observe ? await terminal.observe() : null,
      progress: this.progress.get(id)?.snapshot() || { items: [], revision: 0, truncated: false } };
  }
  async create(provider, cwd, owner, name, view = 'chat') {
    if (!['chat', 'terminal'].includes(view)) throw new Error('未知视图。');
    if (!['claude', 'codex'].includes(provider) || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('请选择可用 agent 和工作目录。');
    if ([...this.sessions.values()].filter(s => s.state !== 'ended').length >= 6) throw new Error('Demo 最多同时运行 6 个会话，请先结束不需要的会话。');
    const id = randomUUID();
    const record = { id, nativeId: provider === 'claude' ? randomUUID() : null, name: name ? cleanText(name, 60) : `${provider === 'claude' ? 'Claude' : 'Codex'} ${[...this.sessions.values()].filter(s => s.provider === provider).length + 1}`, provider, cwd, roomId: null, memberRevision: 0, controlRevision: 0, owner, view, state: 'starting', messages: [], fleet: [], background: null, scheduled: null, model: '原生默认', usage: null, pendingTag: null, activity: '', approval: null, pid: null };
    this.sessions.set(id, record); this.changed();
    let runtime;
    try {
      runtime = this.host.create(record); this.runtimes.set(id, runtime); this.bind(record, runtime);
      if (runtime.start) await runtime.start();
      return id;
    } catch (error) {
      if (!runtime || this.runtimes.get(id) === runtime) { record.state = 'error'; record.activity = error.message; this.changed(); }
      throw error;
    }
  }
  importHistory(id, owner) {
    nativeId(id);
    if (this.closed) throw Error('后台已关闭，没有接入会话。');
    this.pendingNativeImports++;
    const operation = this.historyQueue.then(async () => {
      if (this.closed) throw Error('后台已关闭，没有接入会话。');
      const existing = [...this.sessions.values()].filter(s => s.provider === 'codex' && s.nativeId === id);
      if (existing.length > 1) throw Error('已有记录归属冲突；没有恢复第二个连接。');
      if (existing.length) return existing[0].id;
      if (this.storageWarning) throw Error('本地记录尚未安全保存，请先处理保存问题。');
      if ([...this.sessions.values()].filter(s => s.state !== 'ended').length >= 6) throw Error('Demo 最多同时运行 6 个会话，请先结束不需要的会话。');
      const info = await this.nativeHistory.read(id);
      if (this.closed) throw Error('后台已关闭，没有接入会话。');
      if (this.storageWarning) throw Error('本地保存状态已变化，没有恢复原生会话。');
      if ([...this.sessions.values()].filter(s => s.state !== 'ended').length >= 6) throw Error('会话数量已变化，请先结束不需要的会话。');
      if (!fs.statSync(info.cwd).isDirectory()) throw Error('原工作目录不可用，请先恢复该目录。');
      const localId = randomUUID();
      const record = { id: localId, nativeId: id, externalHistory: true, name: info.name || 'Codex 历史会话', provider: 'codex', cwd: info.cwd,
        roomId: null, memberRevision: 0, controlRevision: 0, owner, view: 'chat', state: 'recoverable', messages: [], fleet: [], background: null,
        scheduled: null, model: info.model, usage: null, pendingTag: null, activity: '', approval: null, pid: null };
      // Reserve and locally persist the identity before crossing the native side
      // effect boundary. An uncertain ACK is never retried or turned into a fork.
      this.sessions.set(localId, record); this.persist();
      if (this.storageWarning) { record.state = 'error'; record.activity = '历史接入尚未开始：请先重试本地保存。'; this.changed(); return localId; }
      try { await this.resume(localId, owner); }
      catch (error) {
        if (error.nativeActiveWriter && this.sessions.get(localId) === record && !this.runtimes.has(localId)) {
          // A definite refusal never acquired the native thread. Keep the
          // person's selection in the picker instead of adding a failed copy.
          this.sessions.delete(localId); this.progress.delete(localId); this.changed(); this.persist(); throw error;
        }
        if (this.sessions.get(localId) === record && record.state === 'recoverable' && !record.activity) { record.state = 'error'; record.activity = error.message; this.changed(); }
      }
      this.persist(); return localId;
    });
    const tracked = operation.finally(() => { this.pendingNativeImports--; });
    this.historyQueue = tracked.catch(() => {}); return tracked;
  }
  bind(s, runtime) {
    const on = (event, handler) => runtime.on(event, (...args) => {
      if (this.runtimes.get(s.id) === runtime) handler(...args);
    });
    if (!this.progress.has(s.id)) this.progress.set(s.id, new ProgressJournal());
    for (const id of this.progress.keys()) {
      if (this.progress.size <= 12) break;
      if (!this.runtimes.has(id)) { this.progress.delete(id); this.observedTerminals.delete(id); }
    }
    on('progress', item => {
      const update = this.progress.get(s.id)?.update(item);
      if (update) this.emit('progress', { id: s.id, ...update });
      if (update && !runtime.nativeBlocks && ['claude-native-message', 'claude-hook'].includes(item.source)) {
        const value = update.item;
        applyNativeBlock(s, { ...value, id: `observation:${value.id}`, nativeId: s.nativeId, kind: 'tool',
          incomplete: value.truncated, title: value.title || '原生过程记录', status: value.status === 'completed' ? 'complete' : value.status });
        this.changed();
      }
      if (item.id && item.source === 'codex-native' && (item.turnId || s.messages.some(m => m.id === `native:${s.nativeId}:tool:${item.id}`))) {
        applyNativeBlock(s, { ...item, id: `tool:${item.id}`, nativeId: s.nativeId, kind: 'tool',
          status: item.status === 'completed' ? 'complete' : item.status });
        this.changed();
      }
    });
    on('nativeBlock', item => { if (applyNativeBlock(s, item)) this.changed(); });
    on('contextEnd', info => this.endNativeContext(s, runtime, info));
    on('contextClear', info => this.clearNativeContext(s, runtime, info));
    on('capability', () => this.changed());
    on('pid', pid => { s.pid = pid; s.processIdentity = processIdentity(pid); s.serverIdentity = processIdentity(runtime.host?.codexProcess?.pid); this.changed(); });
    on('model', model => { s.model = model; this.changed(); });
    on('state', state => {
      if (this.stops.has(s.id) && !['ended', 'recoverable', 'error', 'disconnected'].includes(state)) return;
      s.state = state;
      if (['ended', 'recoverable', 'error', 'disconnected'].includes(state)) for (const m of s.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed';
      if (runtime.transportDisconnected || ['disconnected', 'ended', 'recoverable'].includes(state)) s.fleet = (s.fleet || []).map(item => ({ ...item, stale: true }));
      if (state !== 'approval') s.approvalResolved = false;
      if (runtime.transportDisconnected) { s.approval = null; this.approvalRoutes.delete(s.id); }
      if (state !== 'starting' && s.activity === '正在连接原生历史') s.activity = '';
      if (state === 'ended' || state === 'recoverable') {
        if (runtime.terminal) this.observedTerminals.set(s.id, runtime.terminal);
        if (s.pendingTag) this.deliveryStatus(s.pendingTag, 'unconfirmed');
        s.pid = null; s.pendingTag = null; s.approval = null; this.runtimes.delete(s.id);
        this.approvalRoutes.delete(s.id);
      }
      if (state === 'approval') this.pauseParticipant(s.id, '等待原生权限确认');
      if (state === 'working' && this.room.run?.status === 'running' && this.room.run.ids.includes(s.id) && this.room.run.awaiting?.sessionId !== s.id) this.pause('成员开始了本轮之外的原生工作，请核对后再交接。');
      if (['ended', 'recoverable', 'error'].includes(state)) this.pauseParticipant(s.id, '原生会话不可用'); this.changed();
    });
    on('terminal', event => {
      if (runtime.terminal) this.observedTerminals.set(s.id, runtime.terminal);
      this.emit('terminal', { id: s.id, ...event });
    });
    on('activity', text => { s.activity = text; this.changed(); });
    on('background', info => {
      s.background = info.count; s.scheduled = info.scheduled;
      if ([info.count, info.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) this.nativeWorkObserved(s.id, '原生报告仍有后台或定时工作，请核对后再交接。');
      this.changed();
    });
    on('usage', usage => { s.usage = usage; this.changed(); });
    on('fleet', item => {
      s.fleet.push({ ...item, time: Date.now(), stale: false }); s.fleet = s.fleet.slice(-80);
      if (item.active === true || ['SubagentStart', 'thread/started', 'collabAgentSpawnToolCall'].includes(item.event)) this.nativeWorkObserved(s.id, '观察到原生团队活动，后续转交已暂停；原生团队继续保留。');
      this.changed();
    });
    on('approval', approval => {
      // Native request numbers may be reused after a socket reconnect. The
      // visible decision is scoped to this request and its original RPC.
      const requestId = randomUUID();
      this.approvalRoutes.set(s.id, { runtime, rpc: this.host.rpc, requestId, nativeRequestId: approval.requestId });
      s.approval = { ...approval, requestId }; s.approvalResolved = false;
      this.pauseParticipant(s.id, '等待原生权限确认'); this.changed();
    });
    on('approvalResolved', nativeRequestId => {
      const route = this.approvalRoutes.get(s.id);
      if (!route || route.rpc !== this.host.rpc || route.nativeRequestId !== nativeRequestId) return;
      this.approvalRoutes.delete(s.id); s.approval = null;
      s.approvalResolved = s.state === 'approval';
      this.changed();
    });
    on('nativeInput', (text, item) => {
      this.pause('真人在原生终端输入'); s.controlRevision++;
      if (!item?.id || !s.messages.some(m => m.id === item.id)) s.messages.push({ id: item?.id || randomUUID(), role: 'user', text, status: 'submitted', origin: 'native' });
      this.changed();
    });
    on('history', items => {
      const existing = new Map(s.messages.map(m => [m.id, m])), imported = [], used = new Set();
      const exactIds = new Set(items.flatMap(item => [item.id, ...(item.clientId ? [item.clientId] : [])]));
      const legacyInputs = new Map();
      if (s.provider === 'codex' && s.recovering) {
        for (const [id, text] of runtime.recoveryNativeInputs || []) {
          const cached = existing.get(id);
          if (!cached || exactIds.has(id) || cached.text !== text || cached.role !== 'user' || cached.origin !== 'native') continue;
          if (!legacyInputs.has(text)) legacyInputs.set(text, { ids: [], next: 0 });
          legacyInputs.get(text).ids.push(id);
        }
      }
      for (const item of items) {
        const own = item.type === 'userMessage' && item.clientId && existing.get(item.clientId)?.role === 'user' ? existing.get(item.clientId) : existing.get(item.id);
        // A cold connection's persisted partial text is not newer than native
        // history. Live items received on this connection still take precedence.
        if (own && s.recovering && item.type === 'agentMessage' && !runtime.liveMessageItems?.has(item.id)) {
          Object.assign(own, { text: item.text || '', status: item.turnId && item.turnId === runtime.turnId ? 'streaming' : 'complete', phase: item.phase });
        }
        if (own && s.recovering && item.type === 'userMessage' && item.clientId === own.id) { own.status = 'submitted'; this.deliveryStatus(own.id, 'submitted'); }
        const m = own || (item.type === 'userMessage'
          ? { id: item.id, role: 'user', text: (item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'), status: 'submitted', origin: 'native' }
          : { id: item.id, role: 'assistant', text: item.text || '', status: item.turnId && item.turnId === runtime.turnId ? 'streaming' : 'complete', phase: item.phase });
        // Early backends assigned random display IDs to native user input.
        // One unmatched pure-text history item may replace one pre-recovery
        // cache row. This is display reconciliation, never reply attribution.
        if (!own && s.provider === 'codex' && s.recovering && item.type === 'userMessage' &&
          item.content?.length && item.content.every(i => i.type === 'text' && typeof i.text === 'string')) {
          const queue = legacyInputs.get(m.text);
          if (queue && queue.next < queue.ids.length) used.add(queue.ids[queue.next++]);
        }
        if (!used.has(m.id)) { imported.push(m); used.add(m.id); }
      }
      // Keep live content and GUI submission status; only history supplies order.
      // No complete/nativeInput events: hydration cannot route or pause a task.
      s.messages = imported.concat(s.messages.filter(m => !used.has(m.id)));
      runtime.recoveryNativeInputs?.clear();
      this.changed();
    });
    on('submitted', tag => { for (const list of [s.messages, this.room.messages]) { const m = list.find(m => m.id === tag); if (m) m.status = 'submitted'; } this.deliveryStatus(tag, 'submitted'); this.changed(); });
    on('unattributed', tag => {
      if (s.pendingTag !== tag) return;
      s.pendingTag = null;
      const shared = this.room.messages.find(m => m.id === tag);
      if (shared) shared.status = 'reply-private';
      this.forwards.delete(tag);
      s.activity = '输入已接收；回复归属未确认，请在原生会话核对。';
      this.pauseParticipant(s.id, s.activity); this.changed();
    });
    on('delta', item => {
      let message = s.messages.find(m => m.id === item.id);
      if (!message) { message = { id: item.id, role: 'assistant', text: '', status: 'streaming' }; s.messages.push(message); }
      message.text += item.text;
      if (item.turnId) message.turnId = item.turnId;
      message.nativeId = s.nativeId;
      const ended = s.messages.find(m => m.kind === 'turn' && m.nativeId === s.nativeId && m.turnId === item.turnId);
      if (ended) message.status = ended.status === 'interrupted' ? 'interrupted' : 'unconfirmed';
      this.changed();
    });
    on('messageItem', item => {
      let m = s.messages.find(m => m.id === item.id);
      if (!m) {
        m = { id: item.id, role: 'assistant' };
        if (item.nativeId && item.nativeId !== s.nativeId) {
          const context = s.nativeContexts?.find(c => c.nativeId === item.nativeId);
          const index = s.messages.findIndex(message => message.id === context?.boundaryId);
          if (index < 0) return;
          s.messages.splice(index, 0, m);
        } else s.messages.push(m);
      }
      Object.assign(m, { text: item.text, status: 'complete', nativeId: item.nativeId || s.nativeId, phase: item.phase, ...(item.turnId ? { turnId: item.turnId } : {}) }); this.changed();
    });
    on('complete', info => {
      // Only the adapter's verified native identity can authorize a forward.
      // An untagged completion can clear bookkeeping, never share its body.
      const forwardTag = info.tag || (s.provider === 'claude' ? s.pendingTag : null);
      if (s.provider === 'claude' || !s.pendingTag || s.pendingTag === info.tag) { s.pendingTag = null; s.activity = ''; s.approval = null; }
      if (s.provider === 'claude' && info.text && !runtime.nativeBlocks) s.messages.push({ id: randomUUID(), role: 'assistant', text: info.text, status: 'complete' });
      const forward = this.forwards.get(forwardTag);
      if (forward && forwardTag === info.tag && s.roomId === 'shared' && forward.member === s.memberRevision && forward.control === s.controlRevision && info.text) this.room.messages.push({ id: randomUUID(), role: 'assistant', sessionId: s.id, name: s.name, text: info.text, time: Date.now(), deliveryTracked: true });
      else if (forward) { const message = this.room.messages.find(m => m.id === forwardTag); if (message) message.status = 'reply-private'; }
      this.forwards.delete(forwardTag);
      this.changed();
      const run = this.room.run;
      this.advance(s, info).catch(error => { this.pause(error.message, run); });
    });
    on('failed', (reason, info) => { for (const m of s.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed'; this.deliveryStatus(info?.tag || s.pendingTag, 'unconfirmed'); if (!info || s.pendingTag === info.tag) s.pendingTag = null; s.activity = reason; this.pauseParticipant(s.id, reason); this.changed(); });
  }
  endNativeContext(s, runtime, info) {
    if (this.runtimes.get(s.id) !== runtime || info.nativeId !== s.nativeId) return;
    // send() may have cleared its draft before the native ACK. Preserve that
    // exact pending draft now, before revoking its control generation, but never
    // overwrite a newer human edit. A late acceptance will not clear it again.
    const pending = this.pendingDrafts.get(s.id);
    if (pending && pending.tag === s.pendingTag && this.draftRevisions.get(s.id) === pending.revision && !this.drafts.get(s.id)) {
      this.drafts.set(s.id, pending.text); this.draftRevisions.set(s.id, (pending.revision || 0) + 1);
    }
    if (s.pendingTag) {
      this.deliveryStatus(s.pendingTag, 'unconfirmed');
      for (const list of [s.messages, this.room.messages]) {
        const m = list.find(m => m.id === s.pendingTag);
        if (m?.status === 'awaiting-native') m.status = 'unconfirmed';
        else if (m && list === this.room.messages) m.status = 'reply-private';
      }
      this.forwards.delete(s.pendingTag);
    }
    s.pendingTag = null; s.approval = null; s.approvalResolved = false; this.approvalRoutes.delete(s.id);
    s.controlRevision++; s.memberRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1;
    s.fleet = (s.fleet || []).map(item => ({ ...item, stale: true }));
    s.nativeContextPending = ['clear', 'resume'].includes(info.reason) ? { nativeId: info.nativeId, reason: info.reason } : null;
    s.activity = info.reason === 'resume' ? '原生已切换会话，此连接尚不能同步新历史。请在原生终端继续；旧记录与草稿保留。' : info.reason === 'clear' ? '原生上下文已改变，正在核对连接。记录和草稿保留，未自动发送。' : '原生会话正在结束。';
    this.pauseParticipant(s.id, '成员的原生上下文已改变；请重新确认共享内容。'); this.changed();
  }
  clearNativeContext(s, runtime, info) {
    if (this.closed || this.stops.has(s.id) || this.runtimes.get(s.id) !== runtime ||
      s.nativeContextPending?.nativeId !== info.previousId || s.nativeContextPending.reason !== 'clear') return;
    if (this.storageWarning) return;
    if (s.nativeId === info.previousId) {
      const boundaryId = randomUUID(), time = Date.now();
      s.nativeContexts ||= [];
      s.nativeContexts.push({ nativeId: info.previousId, endedAt: time, boundaryId, reason: 'clear' });
      s.messages.push({ id: boundaryId, role: 'system', name: '原生上下文', text: '已在原生终端清空上下文。上方记录仅作为本机历史保留，不会自动发给新上下文。草稿保留，发送前请核对。', nativeId: info.nativeId, time });
      s.nativeId = info.nativeId; s.model = info.model; s.background = null; s.scheduled = null; s.usage = null;
    } else if (s.nativeId !== info.nativeId || s.nativeContexts?.at(-1)?.nativeId !== info.previousId) return;
    // Identity, old-context references and the boundary are one saved snapshot.
    // A failed write leaves GUI submission closed; retrying metadata cannot add
    // a second boundary or replay a model task.
    const pending = s.nativeContextPending; s.nativeContextPending = null; s.activity = ''; this.persist();
    if (this.storageWarning) s.nativeContextPending = pending;
    else info.committed = true;
    this.changed();
  }
  join(id, join) {
    const s = this.get(id);
    if (s.roomId === (join ? 'shared' : null)) return;
    this.pause(join ? '成员已加入' : '成员已退出');
    s.memberRevision++; s.roomId = join ? 'shared' : null; this.room.revision++;
    this.changed();
  }
  claim(id, owner, view = 'chat') {
    const s = this.get(id);
    if (!['chat', 'terminal'].includes(view)) throw new Error('未知视图。');
    if (s.owner !== owner || s.view !== view) {
      if (s.owner !== owner) { this.pause('真人接管会话'); s.controlRevision++; }
      // Viewing the same session is not a new instruction. Real terminal input
      // still invalidates queued work; taking control from another view does too.
      s.owner = owner; s.view = view; this.changed();
    }
  }
  release(owner) {
    // A disconnected view is not a stop instruction. Its stable owner ID may
    // reconnect after a UI update; another view can explicitly take control.
    this.changed();
  }
  setDraft(id, text, owner) {
    const s = this.get(id);
    if (owner !== undefined && s.owner !== owner) throw new Error('会话已由另一窗口控制；本窗口的草稿副本已保留。');
    if (typeof text !== 'string' || text.length > 16000) throw new Error('草稿过长。');
    this.drafts.set(id, text); this.draftRevisions.set(id, (this.draftRevisions.get(id) || 0) + 1); this.changed();
  }
  assertNativeContext(id, expected) {
    const s = this.get(id);
    if (s.nativeContextPending || (expected === undefined ? this.runtimes.get(id)?.rootLease : expected !== s.nativeId)) {
      throw Error('原生上下文已变化，请重新查看后发送；草稿保留。');
    }
  }
  deliveryStatus(tag, status) {
    if (!tag) return;
    for (const message of this.room.messages) for (const delivery of message.deliveries || []) {
      // Acceptance is independent of later reply-sharing revocation or failure.
      if (delivery.id === tag && (status === 'submitted' || delivery.status !== 'submitted')) delivery.status = status;
    }
  }
  async send(id, text, owner, route = null, forward = null, sourceMessage = null) {
    text = cleanText(text); const s = this.get(id); const runtime = this.runtime(id);
    if (!route) { if (s.owner !== owner) throw new Error('请先接管这个会话。'); this.pause('真人输入优先'); }
    if (s.state !== 'idle' || s.pendingTag || s.approval) throw new Error('会话尚未就绪，请查看原生终端或等待当前回复。');
    if (runtime.chatAvailable === false) throw new Error(s.provider === 'claude' ? '安全发送接口尚未连接；请在原生终端继续，草稿已保留。' : '请先在原生终端完成第一条消息；草稿已保留。');
    const control = s.controlRevision; const member = s.memberRevision; const connection = s.connectionRevision;
    const guard = () => {
      this.expireRun(route);
      return s.state !== 'ended' && s.controlRevision === control && (!(route || forward) || (s.roomId === 'shared' && s.memberRevision === member)) && (!route || (this.room.run?.id === route.id && this.room.run.status === 'running'));
    };
    if (!guard()) throw new Error('交接已经失效。');
    const tag = randomUUID(); s.pendingTag = tag;
    const draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    const clearedDraft = !route && !forward && typeof draft === 'string' && draft.trim() === text;
    s.messages.push({ id: tag, role: 'user', text, origin: route ? 'room' : 'human', status: 'awaiting-native' });
    if (forward) {
      this.forwards.set(tag, { ...forward, control });
      sourceMessage = { id: tag, role: 'human', recipientId: s.id, name: `你 → ${s.name}`, text, status: 'awaiting-native', time: Date.now(), deliveryTracked: true };
      this.room.messages.push(sourceMessage);
    }
    if (sourceMessage) {
      sourceMessage.deliveries ||= [];
      sourceMessage.deliveries.push({ id: tag, recipientId: s.id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() });
    }
    this.versions.dispatches++;
    if (route) route.awaiting = { sessionId: id, tag, member, control };
    else if (clearedDraft) { this.pendingDrafts.set(id, { tag, text: draft, revision: draftRevision }); this.drafts.set(id, ''); }
    this.changed();
    try { await runtime.send(text, tag, guard); }
    catch (error) {
      const current = this.runtimes.get(id) === runtime && s.connectionRevision === connection && s.pendingTag === tag;
      const sameControl = s.controlRevision === control;
      this.forwards.delete(tag);
      this.deliveryStatus(tag, 'unconfirmed');
      for (const list of [s.messages, this.room.messages]) { const m = list.find(m => m.id === tag); if (m?.status === 'awaiting-native') m.status = 'unconfirmed'; }
      if (current) {
        s.pendingTag = null;
        if (sameControl) {
          if (clearedDraft && this.draftRevisions.get(id) === draftRevision) this.drafts.set(id, draft);
          // A private send already stopped the previous exchange. Its late
          // rejection cannot revoke a later authorization for other sessions.
          if (route) this.pause(error.message, route);
        }
      } else if (!this.runtimes.has(id) && s.state === 'recoverable' && s.connectionRevision === connection
        && sameControl && !s.pendingTag && clearedDraft && this.draftRevisions.get(id) === draftRevision) {
        // Confirmed backend exit may retire the runtime before its rejected
        // ACK settles. Retain only this unchanged, still-owned draft.
        this.drafts.set(id, draft);
      }
      this.changed(); throw error;
    } finally { if (this.pendingDrafts.get(id)?.tag === tag) this.pendingDrafts.delete(id); }
    return tag;
  }
  async terminal(id, owner) {
    this.claim(id, owner, 'terminal');
    return this.terminalSnapshot(id, owner);
  }
  async terminalSnapshot(id, owner) {
    const s = this.get(id), runtime = this.runtime(id), control = s.controlRevision;
    const reopening = runtime.terminal?.alive === false;
    const guard = () => !reopening || (s.owner === owner && s.view === 'terminal' && s.controlRevision === control);
    if (!guard()) throw new Error('请先接管这个终端，再重新连接。');
    const t = await runtime.openTerminal(guard);
    if (!guard()) throw new Error('终端控制权已变化，请重新选择会话。');
    const snapshot = await t.snapshot();
    if (!guard()) throw new Error('终端控制权已变化，请重新选择会话。');
    return snapshot;
  }
  input(id, data, owner) {
    const s = this.get(id);
    if (typeof data !== 'string' || data.length > 65536) throw new Error('终端输入无效。');
    if (s.owner !== owner) throw new Error('另一个窗口正在控制这个会话。');
    const runtime = this.runtime(id);
    if (runtime.backendExitConfirmed) throw new Error('原生后台已退出；当前画面只读，输入未发送。');
    // Terminal-generated device/cursor replies are not human instructions.
    const response = isTerminalResponse(data);
    if (!response && s.view !== 'terminal') throw new Error('请切换到原生终端后输入。');
    if (!response) { this.pause('真人在原生终端操作'); s.controlRevision++; }
    const t = runtime.terminal; if (!t?.alive) throw new Error('终端尚未连接。'); t.input(data);
  }
  resize(id, owner, cols, rows) { const s = this.get(id); if (s.owner === owner && Number.isInteger(cols) && Number.isInteger(rows)) this.runtime(id).terminal?.resize(cols, rows); }
  async interrupt(id, owner) { const s = this.get(id); this.claim(id, owner, s.view); s.controlRevision++; this.pause('真人中断当前回复'); await this.runtime(id).interrupt(); s.activity = '已请求原生中断；团队任务请在原生终端确认。'; this.changed(); }
  expireRun(run = this.room.run) {
    // The interval is only a wake-up aid. Native delivery/completion must also
    // enforce the boundary, even if timers were delayed (for example, by sleep).
    if (!run || run.id !== this.room.run?.id || run.status !== 'running' || Date.now() < run.deadline) return false;
    this.pause('达到本轮 10 分钟期限。'); return true;
  }
  pause(reason = '已暂停交接', run = this.room.run) {
    if (run === this.room.run && run?.status === 'running') { run.status = 'paused'; run.reason = reason; this.room.revision++; this.runEvent(reason); this.changed(); }
  }
  pauseParticipant(id, reason) {
    // Native activity in another independent session does not revoke this
    // selected run. Explicit human interventions still use the global pause.
    if (this.room.run?.ids.includes(id)) this.pause(reason);
  }
  runEvent(text) {
    const run = this.room.run;
    // Preserve a navigation reference when sharing pauses before a reply. This
    // does not attribute the pause to that session or authorize another handoff.
    const sessionId = run?.status === 'paused' ? run.awaiting?.sessionId : null;
    this.room.messages.push({ id: randomUUID(), role: 'system', name: '协作', text, time: Date.now(), runId: run?.id, ...(sessionId ? { sessionId } : {}) });
  }
  nativeWorkObserved(id, reason) {
    const run = this.room.run;
    if (run?.status !== 'running' || !run.ids.includes(id)) return;
    // Keep the current, already-authorized root reply. This observation only
    // blocks its next handoff; unrelated members must stop routing immediately.
    if (run.awaiting?.sessionId === id) { run.stopAfterReply = reason; run.reason = '本次回复返回后暂停后续转交；原生工作继续保留。'; }
    else this.pause(reason);
  }
  async startRun(ids, goal, maxSteps, mode = 'strict', labels = {}) {
    if (!['strict', 'replies'].includes(mode)) throw new Error('未知协作授权。');
    goal = cleanText(goal, 6000);
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length || ![2, 3, 4, 5, 6].includes(maxSteps) || maxSteps < ids.length) throw new Error('请选择 2–6 个不同会话，回复上限需覆盖每位参与者且不超过 6 次。');
    if (this.room.run?.status === 'running') throw new Error('已有协作正在运行。');
    for (const id of ids) { const s = this.get(id); if (s.roomId !== 'shared' || s.state !== 'idle' || s.pendingTag || s.approval || [s.background, s.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) throw new Error('所选成员都需就绪、加入共同工作，且没有已报告的后台或定时工作。'); }
    if (ids.some(id => this.runtime(id).chatAvailable === false)) throw new Error('有成员的安全发送接口尚未连接，请先在原生终端检查。');
    // Freeze the human-visible names with this authorization, not native defaults.
    const names = Object.fromEntries(ids.map(id => {
      const s = this.get(id), name = labels && Object.hasOwn(labels, id) ? labels[id] : s.name;
      if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw new Error('参与者名称无效，请重新预览。');
      return [id, `${name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${id.slice(0, 6)}`];
    }));
    const run = { id: randomUUID(), ids: [...ids], names, goal, mode, maxSteps, steps: 0, status: 'running', reason: '', startedAt: Date.now(), deadline: Date.now() + 10 * 60 * 1000, awaiting: null, replies: {} };
    const sourceMessage = { id: randomUUID(), role: 'human', name: '你', text: goal, time: Date.now(), runId: run.id, deliveryTracked: true };
    this.room.run = run; this.room.messages.push(sourceMessage); this.changed();
    this.runEvent(mode === 'replies' ? `已授权依次转交本次回复，最多 ${maxSteps} 次、10 分钟；未知的原生子任务不视为结束。` : '核实原生工作状态后交接。');
    await this.send(ids[0], goal, null, run, null, sourceMessage);
  }
  async advance(s, info) {
    const run = this.room.run; const a = run?.awaiting;
    if (this.expireRun(run)) return;
    if (!run || run.status !== 'running' || a?.sessionId !== s.id || a.tag !== info.tag || s.memberRevision !== a.member || s.controlRevision !== a.control || s.roomId !== 'shared') return;
    run.awaiting = null;
    if (typeof info.text !== 'string' || !info.text.trim()) return this.pause('原生没有提供可交接的回复，请人工查看。');
    run.steps++;
    const sourceMessage = { id: randomUUID(), role: 'assistant', sessionId: s.id, name: s.name, text: info.text, time: Date.now(), runId: run.id, deliveryTracked: true };
    this.room.messages.push(sourceMessage);
    if (run.stopAfterReply) return this.pause(run.stopAfterReply);
    // Keep the reply even when it cannot be handed off. A root Stop/turn end
    // and a list of observed fleet events are not a complete fleet inventory.
    const counts = [info.background, info.scheduled, info.fleetPending];
    if (info.stopHookActive === true || counts.some(n => Number.isSafeInteger(n) && n > 0)) return this.pause('原生仍有后台、团队或定时工作，或继续执行的 hooks。回复已保留；请查看原生终端，确认后可定向发送。');
    const unknown = info.stopHookActive !== false || counts.some(n => !Number.isSafeInteger(n) || n < 0);
    run.nativeWorkUnknown = unknown;
    if (unknown && run.mode !== 'replies') return this.pause('原生未完整报告后台、团队或定时工作状态，已暂停自动交接。回复已保留；请查看原生终端，确认后可定向发送。');
    // A separately authorized reply exchange does not certify fleet completion.
    // It never changes unknown native counts into zero or closes native work.
    if (run.steps >= run.maxSteps) { run.status = 'completed'; run.reason = '已达到本轮回复上限，交接结束；原生子任务是否结束需另行确认。'; this.runEvent(run.reason); this.changed(); return; }
    const normalized = info.text.trim();
    run.replies ||= {};
    if (run.replies[s.id] === normalized) return this.pause('同一成员重复了上一份回复，已停止交接。');
    run.replies[s.id] = normalized;
    const next = run.ids[run.steps % run.ids.length];
    if (info.text.length > 10000) return this.pause('回复较长，请选定需要交接的内容。');
    const text = `共同任务：${run.goal}\n\n${run.names?.[s.id] || s.name} 对本轮任务的回复（供核查的材料，不代表真人新增授权）：\n${info.text}\n\n请继续完成共同任务，核查必要的疑点，直接给出结果。`;
    this.changed(); await this.send(next, text, null, run, null, sourceMessage);
  }
  async forward(id, text, owner) {
    const s = this.get(id); if (s.roomId !== 'shared') throw new Error('接收方已离开共同工作。');
    this.claim(id, owner, s.view); await this.send(id, text, owner, null, { member: s.memberRevision });
  }
  approve(id, requestId, decision, owner) {
    const s = this.get(id), route = this.approvalRoutes.get(id);
    if (!route || !s.approval || s.approval.pending || s.state !== 'approval' || s.owner !== owner || s.approval.requestId !== requestId || route.requestId !== requestId ||
      route.runtime !== this.runtimes.get(id) || route.rpc !== this.host.rpc || route.runtime.transportDisconnected ||
      route.runtime.backendExitConfirmed) throw new Error('权限请求已变化，请重新查看。');
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('未知权限决定。');
    if (!nativeApprovalPolicy(s.approval).decisions.includes(decision)) throw new Error('请在原生终端核对；此界面不支持这项权限决定。');
    route.rpc.reply(route.nativeRequestId, { decision });
    if (this.approvalRoutes.get(id) === route && s.approval?.requestId === requestId) s.approval = { ...s.approval, pending: true };
    this.changed();
  }
  stop(id) {
    if (this.stops.has(id)) return this.stops.get(id);
    const s = this.get(id);
    if (s.state === 'ended') return Promise.resolve();
    if (s.externalHistory && s.recovering && s.state === 'starting' && !this.runtimes.has(id)) {
      s.connectionRevision = (s.connectionRevision || 0) + 1; s.recovering = false; s.state = 'recoverable';
      s.activity = '已取消连接，原生历史保持原样。'; this.changed(); return Promise.resolve();
    }
    const runtime = this.runtime(id);
    this.pause('正在断开原生会话'); s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1; s.recovering = false; s.state = 'stopping'; s.activity = '等待原生确认'; this.changed();
    const operation = Promise.resolve().then(() => runtime.stop()).then(result => {
      if (!['ended', 'recoverable', 'disconnected'].includes(result?.state)) throw new Error('原生未确认结束状态。');
      s.state = result.state; s.pendingTag = null; s.approval = null; s.approvalResolved = false; this.approvalRoutes.delete(id);
      s.activity = result.state === 'ended' ? '' : result.state === 'recoverable'
        ? '原生后台已退出；记录和草稿保留，任务不会自动重发。'
        : '本应用连接已断开；原生线程或后台任务可能仍在运行。';
      if (['ended', 'recoverable'].includes(s.state)) { s.pid = null; this.runtimes.delete(id); }
    }).catch(error => { s.state = 'error'; s.activity = error.message; throw error; })
      .finally(() => { this.stops.delete(id); this.changed(); });
    this.stops.set(id, operation); return operation;
  }
  async resume(id, owner) {
    const s = this.get(id);
    if (s.nativeContextPending) throw Error('原生上下文已变化，但新身份尚未确认。请在原生终端核对；没有恢复旧上下文或重发任务。');
    const retained = this.runtimes.get(id);
    if ((s.state === 'disconnected' || (s.state === 'error' && retained?.transportDisconnected)) && s.provider === 'codex' && retained?.reconnect && !retained.backendExitConfirmed && !this.stops.has(id)) {
      if (s.pendingTag && s.messages.some(m => m.id === s.pendingTag && m.status === 'awaiting-native')) throw new Error('上一条输入的接收结果仍在核对；请稍后重连，不要重发。');
      // Reconnection observes current native work; it does not renew a previous
      // reply-sharing authorization or attach it to a later native completion.
      if (s.pendingTag) {
        const shared = this.room.messages.find(m => m.id === s.pendingTag);
        if (shared) shared.status = 'reply-private';
        this.forwards.delete(s.pendingTag);
      }
      s.pendingTag = null; s.approval = null; this.approvalRoutes.delete(id);
      s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1;
      const generation = s.connectionRevision;
      s.owner = owner; s.recovering = true; s.state = 'starting'; s.activity = '正在连接原生历史';
      this.pause('重新连接原会话；之前的交接不会自动继续。'); this.changed();
      try { await retained.reconnect(); }
      catch (error) {
        if (generation === s.connectionRevision && !['ended', 'recoverable'].includes(s.state) && this.runtimes.get(id) === retained && !this.stops.has(id)) { s.state = retained.transportDisconnected ? 'error' : 'disconnected'; s.activity = error.message; }
        throw error;
      } finally { if (generation === s.connectionRevision) { s.recovering = false; this.changed(); } }
      return;
    }
    if (this.runtimes.has(id)) throw new Error('该会话仍有运行连接，请先检查原生状态。');
    if (!s.nativeId || !['ended', 'recoverable', 'error'].includes(s.state)) throw new Error('这个会话目前不能恢复。');
    if (s.externalHistory) {
      if (this.storageWarning) throw Error('请先处理本地保存问题，再继续原生历史。');
    }
    const sameServer = s.provider === 'codex' && s.serverIdentity?.pid === this.host.codexProcess?.pid;
    if ((!sameServer && processMayBeAlive(s.serverIdentity)) || (processMayBeAlive(s.processIdentity) && !(sameServer && s.processIdentity.pid === s.serverIdentity.pid))) throw new Error('之前的原生进程可能仍在运行。请先在原生界面检查，避免并行恢复同一个会话。');
    if (!fs.statSync(s.cwd).isDirectory()) throw new Error('原工作目录不可用，请先恢复该目录。');
    s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1; s.owner = owner; s.recovering = true; s.state = 'starting'; s.activity = '正在连接原生历史';
    // Membership is retained, but an interrupted automatic run never restarts.
    this.pause('恢复原生会话后，请重新选择本次协作任务。'); this.changed();
    let runtime;
    const generation = s.connectionRevision;
    try {
      if (s.externalHistory) {
        await this.nativeHistory.ready();
        if (this.closed || this.storageWarning || this.sessions.get(id) !== s || generation !== s.connectionRevision || s.state !== 'starting' || this.runtimes.has(id) || this.stops.has(id)) throw Error('会话状态已变化，没有继续旧的恢复请求。');
      }
      runtime = this.host.create(s); this.runtimes.set(id, runtime); this.bind(s, runtime);
      if (runtime.start) await runtime.start();
    } catch (error) {
      if (this.sessions.get(id) === s && generation === s.connectionRevision && (runtime ? this.runtimes.get(id) === runtime : s.state === 'starting')) {
        if (!runtime?.terminal?.alive && !runtime?.hasHistory) this.runtimes.delete(id);
        s.state = 'error'; s.activity = error.message; this.changed();
      }
      throw error;
    } finally { if (generation === s.connectionRevision) { s.recovering = false; this.changed(); } }
  }
  clearSharedHistory() {
    if (this.room.run?.status === 'running') throw new Error('请先暂停本轮交接，再清除共享记录。');
    this.room.run = null; this.room.messages = []; this.forwards.clear(); this.room.revision++; this.changed(); this.persist();
  }
  forget(id) {
    const s = this.get(id);
    if (this.runtimes.has(id) || (s.state !== 'ended' && (processMayBeAlive(s.processIdentity) || processMayBeAlive(s.serverIdentity)))) throw new Error('原生连接仍存在，请先结束或检查会话。');
    this.sessions.delete(id); this.drafts.delete(id); this.draftRevisions.delete(id); this.changed(); this.persist();
    this.progress.delete(id); this.observedTerminals.delete(id);
  }
  close() { this.closed = true; clearTimeout(this.saveTimer); clearInterval(this.deadlineTimer); this.persist(); this.host.close(); }
}

module.exports = { Workspace, cleanText, isTerminalResponse };
