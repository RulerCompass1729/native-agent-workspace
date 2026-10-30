const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const { ProgressJournal } = require('./observation.cjs');
const { applyNativeBlock, applyCodexHistory, applyCodexTurnHistory, applyCodexDelta, applyCodexMessage, applyCodexProgress, persistedMessages } = require('./native-blocks.cjs');
const { SharedReplies } = require('./shared-replies.cjs');
const addressed = require('./addressed-handoffs.cjs');
const { nativeApprovalPolicy, ApprovalQueue } = require('./approval-policy.js');
const { NativeHistory, claudeMetadata, nativeId, codexVersionInfo } = require('./native-history.cjs');

const cleanText = (value, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`请输入有效文字；一次最多 ${max.toLocaleString('en-US')} 个字符。`);
  return value.trim();
};
// The newest kept message and its status. Volatile rows (native observations,
// tool progress) are display only and must not change saved state.
const activityMark = s => { const last = (s.messages || []).findLast(m => !m.volatile); return `${last?.id}:${last?.status}`; };
const wake = require('./session-wake.cjs');
const isTerminalResponse = data => /^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\](10|11);rgb:[\da-f/]+(\x07|\x1b\\)$/i.test(data);

class Workspace extends EventEmitter {
  constructor(host, dataDir, newWorkspaceRoot = path.join(dataDir, 'session-workspaces')) {
    super(); this.host = host; this.dataDir = dataDir; this.newWorkspaceRoot = newWorkspaceRoot; this.sessions = new Map(); this.runtimes = new Map(); this.drafts = new Map(); this.draftRevisions = new Map();
    this.claudeAsks = new Map();
    this.capacityRecoveries = new Map();
    this.room = { id: 'shared', name: '共同工作', revision: 0, run: null, messages: [] };
    this.versions = { shellModelCalls: 0, dispatches: 0 };
    this.saveTimer = null;
    this.deadlineTimer = setInterval(() => { this.expireRun(); this.tickCapacity(); }, 1000);
    this.deadlineTimer.unref();
    this.forwards = new Map(); this.pendingDrafts = new Map();
    this.sharedReplies = new SharedReplies(this);
    this.approvalRoutes = new Map();
    this.stops = new Map();
    this.progress = new Map(); this.observedTerminals = new Map();
    this.nativeHistory = new NativeHistory(host); this.historyQueue = Promise.resolve(); this.pendingNativeImports = 0;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    wake.initialize(this);
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'));
      for (const record of stored.sessions || []) this.sessions.set(record.id, { ...record, claudeQuestion: null, fleet: (record.fleet || []).map(item => ({ ...item, stale: true })), state: record.forkPicker ? 'ended' : ['ended', 'background'].includes(record.state) ? record.state : 'recoverable', owner: null, approval: null, approvals: [], approvalOverflow: false, approvalResolved: false, pid: null, pendingTag: null, controlRevision: 0, liveDraft: '', activity: record.forkPicker ? '没有确认创建分支。' : record.state === 'ended' ? '' : record.state === 'background' ? record.activity || '' : '运行服务曾中断；记录和草稿已保留，任务不会自动重发。' });
      for (const session of this.sessions.values()) for (const message of session.messages || []) {
        if (['streaming', 'running', 'awaiting-native'].includes(message.status)) message.status = 'unconfirmed';
        if (['staged', 'sending', 'consumed'].includes(message.wake?.status)) { message.wake.status = 'unconfirmed'; message.text = `自动消息接收结果未确认；不会重发。\n${message.wake.body}`; }
      }
      this.room.messages = stored.room?.messages || [];
      for (const m of this.room.messages) if (['streaming', 'running'].includes(m.status)) { m.status = 'unconfirmed'; m.sharingStopped = '运行连接曾中断，未重发任务'; }
      for (const m of this.room.messages) for (const delivery of m.deliveries || []) {
        if (delivery.status === 'awaiting-native') delivery.status = 'unconfirmed';
      }
      if (stored.room?.run) this.room.run = { ...stored.room.run, awaiting: null, ...(stored.room.run.status === 'running' ? { status: 'paused', reason: '运行服务曾中断；未重发任务，请核对原生结果。' } : {}) };
      if (this.room.run?.kind === 'cross-service' && (this.room.run.pausePending || stored.room.run.status === 'running')) Object.assign(this.room.run, { pausePending: false, pauseUnconfirmed: true, reason: '协调后台曾中断，未重发任务；请核对各后台授权与原生工作。' });
      if (stored.drafts) for (const [key, value] of Object.entries(stored.drafts)) this.drafts.set(key, value);
    } catch (error) {
      if (error.code !== 'ENOENT') { this.storageFailure = 'read'; this.storageWarning = '本地记录未能读取，原文件已保留；请检查后再保存。'; }
    }
    // Loading is not activity: start from each saved session's current mark.
    this.activityMarks = new Map([...this.sessions.values()].map(s => [s.id, activityMark(s)]));
  }
  snapshot() {
    return { wakePolicy: wake.snapshot(this), peerLeases: this.peerLeases?.snapshot() || [], sessions: [...this.sessions.values()].map(s => ({ ...s, capacityRecovery: this.capacityStatus(s.id), ...(s.provider === 'codex' ? codexVersionInfo(this.runtimes.get(s.id)?.host?.rpc, !this.runtimes.get(s.id)?.transportDisconnected && !this.runtimes.get(s.id)?.stopped && !this.runtimes.get(s.id)?.backendExitConfirmed) : {}), addressedSendAvailable: this.runtimes.get(s.id)?.addressedSendAvailable === true, nativeInputRequired: Boolean(this.runtimes.get(s.id)?.nativeInputRequired), interruptPending: Boolean(this.runtimes.get(s.id)?.nativeAbortRequest), nativeBlockMapping: true, nativeSettings: this.runtimes.get(s.id)?.nativeSettings || null, nativeActivity: this.runtimes.get(s.id)?.nativeActivity || null, nativeApproval: this.runtimes.get(s.id)?.nativeApproval || null, sharedActivity: this.sharedReplies.activity(s), failedTurnInputAvailable: Boolean(this.runtimes.get(s.id)?.failedTurnInputId), queueAvailable: Boolean(this.runtimes.get(s.id)?.queueAvailable), pendingQueue: this.runtimes.get(s.id)?.pendingQueue || null, steerAvailable: Boolean(this.runtimes.get(s.id)?.steerAvailable), activeTurnId: this.runtimes.get(s.id)?.turnId || null, pendingSteer: this.runtimes.get(s.id)?.pendingSteer || null, backendUnavailable: Boolean(this.runtimes.get(s.id)?.backendExitConfirmed), transportDisconnected: Boolean(this.runtimes.get(s.id)?.transportDisconnected), terminalState: this.runtimes.get(s.id)?.terminal ? { alive: Boolean(this.runtimes.get(s.id).terminal.alive), exitConfirmed: this.runtimes.get(s.id).terminal.nativeExited === true, epoch: this.runtimes.get(s.id).terminal.journal?.epoch || null } : null, terminalAvailable: Boolean(this.runtimes.get(s.id)?.terminal?.alive || (!this.runtimes.get(s.id)?.stopped && this.runtimes.get(s.id)?.hasHistory)), chatAvailable: this.runtimes.get(s.id)?.chatAvailable !== false, liveDraft: this.drafts.get(s.id) || '' })), room: this.room, diagnostics: this.versions, available: Object.fromEntries(Object.entries(this.host.binaries).map(([k, v]) => [k, Boolean(v)])), storageWarning: this.storageWarning || null, storageRetryable: this.storageFailure === 'write' };
  }
  changed() {
    for (const s of this.sessions.values()) {
      // An unnamed row shows its first request until a native title arrives.
      if (s.autoName && !s.nameSource) {
        const first = s.messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
        if (first) { s.name = `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${first.text.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim()}`.slice(0, 60); s.nameSource = 'preview'; }
      }
      // Last activity: a new message or a change of the newest one's status. A
      // session created here starts from its creation time.
      const mark = activityMark(s);
      if (this.activityMarks.has(s.id) && this.activityMarks.get(s.id) !== mark) s.lastActivityAt = Date.now();
      this.activityMarks.set(s.id, mark);
    }
    this.sharedReplies.refresh();
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
      const sessions = [...this.sessions.values()].map(({ owner, approval, approvals, approvalOverflow, approvalResolved, pid, ...s }) => ({ ...s, messages: persistedMessages(s.messages), pendingTag: null }));
      fs.writeFileSync(temp, JSON.stringify({ sessions, room: { messages: persistedMessages(this.room.messages, 'shared-native-cache-gap'), ...(this.room.run ? { run: this.room.run } : {}) }, drafts: Object.fromEntries(this.drafts) }), { mode: 0o600 });
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
    for (const runtime of this.runtimes.values()) runtime.retryContext?.();
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
  async create(provider, cwd, owner, name, view = 'chat', { fork, skipPermissions, newDirectory } = {}) {
    if (!['chat', 'terminal'].includes(view)) throw new Error('未知视图。');
    if (skipPermissions != null && skipPermissions !== true) throw new Error('无效的权限选项。');
    if (fork != null && (fork !== 'picker' || provider !== 'claude')) throw new Error('无效的分支请求。');
    if (newDirectory != null && newDirectory !== true) throw new Error('无效的新建目录选项。');
    if (fork && newDirectory) throw new Error('从历史会话分支前，请选择原工作目录。');
    // The native session picker that chooses what to branch needs the terminal.
    if (fork) view = 'terminal';
    if (!['claude', 'codex'].includes(provider) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('请选择可用 agent 和工作目录。');
    const sessionName = name ? cleanText(name, 60) : `${provider === 'claude' ? 'Claude' : 'Codex'} ${[...this.sessions.values()].filter(s => s.provider === provider).length + 1}`;
    if (newDirectory) {
      const leaf = path.basename(cwd), root = this.newWorkspaceRoot;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(leaf) || cwd !== path.join(root, leaf)) throw new Error('独立目录路径已变化，请重新打开新建窗口。');
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        if (!fs.lstatSync(root).isDirectory()) throw Error('Invalid root');
      } catch { throw new Error('独立目录的存放位置不可用，请检查磁盘空间和目录权限；未启动新会话。'); }
      try {
        // Never reuse an existing folder, file or symlink as an empty workspace.
        fs.mkdirSync(cwd, { mode: 0o700 }); fs.chmodSync(cwd, 0o700);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('独立目录已存在，未启动新会话；请改用新目录或选择已有目录。');
        throw new Error('无法创建独立目录，请检查磁盘空间和目录权限；未启动新会话。');
      }
    } else {
      try { if (!fs.statSync(cwd).isDirectory()) throw Error('Not a directory'); }
      catch { throw new Error('工作目录不可用，请选择已有文件夹。'); }
    }
    const id = randomUUID();
    const now = Date.now();
    const record = { id, nativeId: provider === 'claude' ? randomUUID() : null, name: sessionName, createdAt: now, lastActivityAt: now, ...(name ? {} : { autoName: true }), ...(skipPermissions ? { skipPermissions: true, ...(provider === 'claude' ? { nativePermissionMode: 'bypassPermissions' } : {}) } : {}), provider, cwd, roomId: null, memberRevision: 0, controlRevision: 0, owner, view, state: 'starting', messages: [], fleet: [], background: null, scheduled: null, model: '原生默认', usage: null, pendingTag: null, activity: '', approval: null, pid: null };
    if (fork) record.forkPicker = true;
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
  importHistory(id, owner, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('无效的历史接入请求。');
    const provider = options.provider ?? 'codex';
    if (!['codex', 'claude'].includes(provider)) throw Error('无效的原生会话类型。');
    nativeId(id);
    const claude = provider === 'claude' ? claudeMetadata(id, options) : null;
    if (claude) id = claude.nativeId;
    if (this.closed) throw Error('后台已关闭，没有接入会话。');
    this.pendingNativeImports++;
    const operation = this.historyQueue.then(async () => {
      if (this.closed) throw Error('后台已关闭，没有接入会话。');
      const existing = [...this.sessions.values()].filter(s => s.provider === provider && s.nativeId === id);
      if (existing.length > 1) throw Error('已有记录归属冲突；没有恢复第二个连接。');
      if (existing.length) return existing[0].id;
      if (this.storageWarning) throw Error('本地记录尚未安全保存，请先处理保存问题。');
      const info = claude || await this.nativeHistory.read(id);
      if (this.closed) throw Error('后台已关闭，没有接入会话。');
      if (this.storageWarning) throw Error('本地保存状态已变化，没有恢复原生会话。');
      if (!fs.statSync(info.cwd).isDirectory()) throw Error('原工作目录不可用，请先恢复该目录。');
      const localId = randomUUID();
      const record = { id: localId, nativeId: id, externalHistory: true, name: info.name || 'Codex 历史会话', provider, cwd: info.cwd,
        ...(claude ? { autoName: claude.autoName, nativePermissionMode: claude.skipPermissions ? 'bypassPermissions' : undefined } : {}),
        roomId: null, memberRevision: 0, controlRevision: 0, owner, view: claude ? 'terminal' : 'chat', state: 'recoverable', messages: [], fleet: [], background: null,
        scheduled: null, model: info.model, usage: null, pendingTag: null, activity: '', approval: null, pid: null };
      // Reserve and locally persist the identity before crossing the native side
      // effect boundary. An uncertain ACK is never retried or turned into a fork.
      this.sessions.set(localId, record); this.persist();
      if (this.storageWarning) { record.state = 'error'; record.activity = '历史接入尚未开始：请先重试本地保存。'; this.changed(); return localId; }
      try { await this.resume(localId, owner); }
      catch (error) {
        if ((error.nativeActiveWriter || error.nativeImportRefused) && this.sessions.get(localId) === record && !this.runtimes.has(localId)) {
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
  // Only a live native failed turn can arm this bounded recovery. Nothing is
  // restored from history or disk, and the original task is never replayed.
  capacityStatus(id) {
    const r = this.capacityRecoveries.get(id);
    return r ? { status: r.status, attempt: r.attempt, due: r.due, reason: r.reason } : null;
  }
  cancelCapacity(id) {
    const turn = this.runtimes.get(id)?.rootTurn;
    if (turn?.pendingFailure) { turn.pendingFailure = false; turn.failureCancelled = true; }
    if (this.capacityRecoveries.delete(id)) this.changed();
  }
  capacityValid(s, r) {
    const runtime = this.runtimes.get(s.id);
    return !this.closed && !this.storageWarning && this.capacityRecoveries.get(s.id) === r && runtime === r.runtime &&
      s.nativeId === r.nativeId && runtime.host?.rpc === r.rpc && runtime.lifecycleRevision === r.lifecycle && runtime.rootLease === r.lease && runtime.observationEpoch === r.epoch &&
      (s.provider !== 'claude' || runtime.rootTurn?.id === r.turnId && r.errorMessageId && runtime.rootTurn.errorMessageId === r.errorMessageId && runtime.rootTurn.failedTranscript === r.transcript && runtime.failedTurnInputMatches(r.turnId)) &&
      s.owner === r.owner && s.controlRevision === r.control && s.memberRevision === r.member &&
      this.draftRevisions.get(s.id) === r.draft && !this.drafts.get(s.id) && !s.archived && !s.nativeContextPending &&
      ['idle', 'error'].includes(s.state) && (!s.pendingTag || s.pendingTag === r.tag) && !s.approval && !s.approvalOverflow && !s.claudeQuestion &&
      !runtime.stopped && !runtime.transportDisconnected && !runtime.nativeObservationPending && !runtime.backendExitConfirmed && runtime.chatAvailable !== false &&
      !runtime.turnId && !runtime.pendingQueue && !runtime.pendingSteer && !runtime.nativeInputRequired && !runtime.nativeAbortRequest;
  }
  scheduleCapacity(s, runtime, turnId, reason = 'capacity') {
    const previous = this.capacityRecoveries.get(s.id);
    if (previous?.turnId === turnId) return;
    const r = { runtime, rpc: runtime.host?.rpc, lease: runtime.rootLease, epoch: runtime.observationEpoch, errorMessageId: runtime.rootTurn?.errorMessageId, transcript: runtime.rootTurn?.failedTranscript, lifecycle: runtime.lifecycleRevision, nativeId: s.nativeId, turnId, owner: s.owner, control: s.controlRevision, member: s.memberRevision,
      draft: this.draftRevisions.get(s.id), reason, attempt: previous?.attempt || 0, status: 'scheduled', due: 0 };
    this.capacityRecoveries.set(s.id, r);
    if (!this.capacityValid(s, r)) { this.capacityRecoveries.delete(s.id); return; }
    const delays = [120000, 300000, 600000];
    if (r.attempt >= delays.length) {
      r.status = 'exhausted';
      s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', text: `${reason === 'routing' ? '路由发现超时' : '模型满载'}自动继续已达 3 次上限，需要你处理。`, status: 'complete', time: Date.now() });
    } else r.due = Date.now() + delays[r.attempt];
    this.changed();
  }
  tickCapacity(now = Date.now()) {
    // Native failure hooks can precede the journal flush. This existing clock
    // allows at most five bounded reads of that exact current error UUID.
    for (const runtime of this.runtimes.values()) if (runtime.rootTurn?.pendingFailure) runtime.reportCapacityFailure?.(true);
    for (const [id, r] of this.capacityRecoveries) {
      if (r.status !== 'scheduled' || r.checking) continue;
      const s = this.sessions.get(id);
      if (!s || !this.capacityValid(s, r)) { this.cancelCapacity(id); continue; }
      if (now < r.due) continue;
      // Keep the existing cancel action available during this metadata read.
      r.checking = true;
      this.continueCapacity(s, r, now);
    }
  }
  async continueCapacity(s, r, now) {
    const stop = text => {
      if (this.capacityRecoveries.get(s.id) !== r) return;
      this.capacityRecoveries.delete(s.id);
      s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', text, status: 'complete', time: Date.now() });
      this.changed();
    };
    let goal;
    try {
      if (s.provider === 'codex') {
        const result = await r.rpc.call('thread/goal/get', { threadId: r.nativeId }).catch(error => {
          if (error?.nativeGoalsDisabled === true) return { goal: null };
          throw error;
        });
        if (!result || !Object.hasOwn(result, 'goal') || (result.goal !== null &&
            (result.goal?.threadId !== r.nativeId || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(result.goal?.status)))) throw Error('Unknown goal state');
        goal = result.goal;
      }
    } catch {
      if (this.capacityRecoveries.get(s.id) === r && !this.capacityValid(s, r)) { this.cancelCapacity(s.id); return; }
      stop('自动继续前无法核对原生 goal；已停止自动发送，请核对同屏终端。'); return;
    }
    if (this.capacityRecoveries.get(s.id) !== r) return;
    if (!this.capacityValid(s, r)) { this.cancelCapacity(s.id); return; }
    // A new ordinary input does not reactivate a blocked native goal. Do not
    // overwrite a concurrent native pause through an unconditional goal/set.
    if (goal && !['active', 'complete'].includes(goal.status)) {
      stop(`原生 goal 为 ${goal.status}；未自动发送继续。请在同屏终端${goal.status === 'blocked' ? '使用 /goal resume' : '核对目标状态'}。`); return;
    }
    r.attempt++; r.status = 'sending';
    const time = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', text: `${time} 因${r.reason === 'routing' ? '路由发现超时' : '模型满载'}自动继续（第 ${r.attempt} 次）`, status: 'complete', time: now });
    // send() and the adapter recheck the same identity/control before writing.
    try { await this.send(s.id, '继续', r.owner, null, null, null, r); }
    catch { stop('自动继续的接收结果未确认；已停止自动发送，请核对原生终端。'); }
  }
  bind(s, runtime) {
    runtime.addressedCall = (identity, args) => addressed.accept(this, s, runtime, identity, args);
    runtime.addressedFailed = identity => addressed.failed(this, s, runtime, identity);
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
      const nativeProgress = applyCodexProgress(s, item);
      if (nativeProgress) {
        this.sharedReplies.record(s, nativeProgress);
        this.changed();
      }
    });
    on('nativeBlock', item => { if (item.kind === 'gap') { s.peerRevision = (s.peerRevision || 0) + 1; this.peerLeases?.revoke('原生观察连接出现缺口；请核对后重新授权。', s.id); this.pauseParticipant(s.id, '原生观察连接出现缺口，请核对后重新授权。'); } if (applyNativeBlock(s, item, this.dataDir)) { this.sharedReplies.record(s, s.messages.find(m => m.id === `native:${item.nativeId}:${item.id}`)); this.changed(); } });
    on('replyBound', identity => { this.sharedReplies.bind(s, identity.tag, identity); this.changed(); });
    on('contextEnd', info => this.endNativeContext(s, runtime, info));
    on('contextClear', info => this.clearNativeContext(s, runtime, info));
    on('background', info => { if (this.runtimes.get(s.id) !== runtime || info.nativeId !== s.nativeId) return;
      s.activity = `已转到原生后台继续运行（会话 ${info.backgroundId.slice(0, 8)}）。可在终端用 claude agents 查看，claude attach ${info.backgroundId.slice(0, 8)} 接回。`; });
    on('sharingBoundary', reason => this.peerLeases?.revoke('原生输入或权限边界已变化：' + reason, s.id));
    on('nativeControlBoundary', reason => { s.peerRevision = (s.peerRevision || 0) + 1; this.peerLeases?.revoke('原生输入或权限边界已变化：' + reason, s.id); });
    on('capability', () => this.changed());
    on('nativeTurnStart', info => wake.nativeStart(this, runtime, info));
    on('nativeTurnEnd', info => {
      try { wake.complete(this, s, runtime, info); } catch { this.changed(); }
      const qualified = s.provider === 'codex' ? ['0.164.0', '0.165.0'].includes(runtime.host?.rpc?.nativeVersion) : s.provider === 'claude' && runtime.nativeAbortAvailable && !runtime.retainedReader;
      // Other is broad: admit only the observed native routing timeout verbatim.
      const reason = info.errorInfo === 'serverOverloaded' ? 'capacity' : s.provider === 'codex' && info.errorInfo === 'other' && info.errorMessage === 'workspace routing discovery timed out' ? 'routing' : null;
      if (qualified && info.nativeId === s.nativeId && info.status === 'failed' && reason) this.scheduleCapacity(s, runtime, info.turnId, reason);
      else this.cancelCapacity(s.id);
    });
    on('inputRequired', () => this.changed());
    on('pid', pid => { s.pid = pid; s.processIdentity = processIdentity(pid); s.serverIdentity = processIdentity(runtime.host?.codexProcess?.pid); this.changed(); });
    on('model', model => { s.model = model; this.changed(); });
    on('askQuestion', ask => this.holdQuestion(s, runtime, ask));
    // Only a session nobody named takes the native title; a rename is a desktop label and always wins.
    on('nativeTitle', title => { const clean = String(title).replace(/[\x00-\x1f\x7f]/g, ' ').trim(); const name = clean && `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${clean}`.slice(0, 60); if (s.autoName && name && (name !== s.name || s.nameSource !== 'native')) { s.name = name; s.nameSource = 'native'; this.changed(); } });
    on('state', state => {
      if (this.stops.has(s.id) && !['ended', 'recoverable', 'error', 'disconnected'].includes(state)) return;
      if (['approval', 'ended', 'background', 'recoverable', 'disconnected'].includes(state) || state === 'working' && this.capacityRecoveries.get(s.id)?.status === 'scheduled') this.cancelCapacity(s.id);
      s.state = state;
      if (['ended', 'background', 'recoverable', 'error', 'disconnected'].includes(state)) for (const m of s.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed';
      if (runtime.transportDisconnected || ['disconnected', 'ended', 'background', 'recoverable'].includes(state)) s.fleet = (s.fleet || []).map(item => ({ ...item, stale: true }));
      if (state !== 'approval') s.approvalResolved = false;
      if (['ended', 'background', 'recoverable', 'error', 'disconnected'].includes(state)) this.releaseQuestion(s, null);
      if (runtime.transportDisconnected) { s.approval = null; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(s.id); }
      if (state !== 'starting' && s.activity === '正在连接原生历史') s.activity = '';
      if (['ended', 'background', 'recoverable'].includes(state)) {
        if (runtime.terminal) this.observedTerminals.set(s.id, runtime.terminal);
        if (s.pendingTag) this.deliveryStatus(s.pendingTag, 'unconfirmed');
        s.pid = null; s.pendingTag = null; s.approval = null; s.approvals = []; s.approvalOverflow = false; this.runtimes.delete(s.id);
        this.approvalRoutes.delete(s.id);
      }
      if (state === 'working') this.peerLeases?.working(s.id);
      if (state === 'approval') { s.peerRevision = (s.peerRevision || 0) + 1; this.pauseParticipant(s.id, '等待原生权限确认'); }
      if (state === 'working' && this.room.run?.status === 'running' && this.room.run.ids.includes(s.id) && this.room.run.awaiting?.sessionId !== s.id) this.pause('成员开始了本轮之外的原生工作，请核对后再交接。');
      if (['ended', 'background', 'recoverable', 'error'].includes(state)) this.pauseParticipant(s.id, '原生会话不可用'); this.changed();
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
    on('approval', (approval, rpc = this.host.rpc) => {
      s.peerRevision = (s.peerRevision || 0) + 1;
      let queue = this.approvalRoutes.get(s.id);
      if (!queue) this.approvalRoutes.set(s.id, queue = new ApprovalQueue(randomUUID));
      queue.add(approval, rpc, runtime); Object.assign(s, queue.snapshot()); s.approvalResolved = false;
      this.pauseParticipant(s.id, '等待原生权限确认'); this.changed();
    });
    on('approvalResolved', (nativeRequestId, rpc = this.host.rpc) => {
      const queue = this.approvalRoutes.get(s.id);
      if (!queue || !queue.entries.some(r => r.rpc === rpc && r.nativeRequestId === nativeRequestId)) return;
      queue.resolve(nativeRequestId, rpc); Object.assign(s, queue.snapshot());
      if (!queue.entries.length && !queue.overflow) this.approvalRoutes.delete(s.id);
      s.approvalResolved = !s.approval && !queue.overflow && s.state === 'approval';
      this.changed();
    });
    on('approvalUnavailable', rpc => {
      const queue = this.approvalRoutes.get(s.id);
      if (!queue || (!queue.entries.some(r => r.rpc === rpc) && !queue.overflowSources.has(rpc))) return;
      queue.removeSource(rpc); Object.assign(s, queue.snapshot()); s.approvalResolved = false;
      if (!queue.entries.length && !queue.overflow) this.approvalRoutes.delete(s.id);
      s.activity = '原生确认连接已变化；正在核对原会话，未自动发送决定。'; this.changed();
    });
    on('nativeInput', (text, item) => {
      this.cancelCapacity(s.id);
      wake.human(this, s.id); this.pause('真人在原生终端输入'); s.controlRevision++;
      runtime.workspaceMcpCalls?.clear();
      if (item?.turnId && item.turnId === runtime.turnId) wake.nativeStart(this, runtime, { nativeId: s.nativeId, turnId: item.turnId });
      if (item?.display !== false && (!item?.id || !s.messages.some(m => m.id === item.id))) s.messages.push({ id: item?.id || randomUUID(), role: 'user', text, status: 'submitted', origin: 'native' });
      this.changed();
    });
    on('nativeInputImages', event => { if (require('./native-images.cjs').applyInputImages(s, event)) this.changed(); });
    on('history', (items, turns, recovery) => { applyCodexHistory(s, items, runtime, id => this.deliveryStatus(id, 'submitted'), turns, recovery); this.changed(); });
    on('turnHistory', turns => { applyCodexTurnHistory(s, turns, runtime); this.sharedReplies.restoreTurnMetadata(s); this.changed(); });
    on('submitted', tag => { for (const list of [s.messages, this.room.messages]) { const m = list.find(m => m.id === tag); if (m) m.status = 'submitted'; } this.deliveryStatus(tag, 'submitted'); this.changed(); });
    on('interrupted', ({ tag }) => {
      this.cancelCapacity(s.id);
      if (tag) {
        if (s.pendingTag === tag) s.pendingTag = null;
        this.forwards.delete(tag); this.sharedReplies.close(tag, '原生已中断本轮');
      }
      s.activity = ''; this.pauseParticipant(s.id, '原生已中断本轮'); this.changed();
    });
    on('unattributed', tag => {
      if (s.pendingTag !== tag && !this.forwards.has(tag)) return;
      if (s.pendingTag === tag) s.pendingTag = null;
      const shared = this.room.messages.find(m => m.id === tag);
      if (shared) shared.status = 'reply-private';
      this.forwards.delete(tag); this.sharedReplies.close(tag, '回复归属未确认');
      s.activity = '输入已接收；回复归属未确认，请在原生会话核对。';
      this.pauseParticipant(s.id, s.activity); this.changed();
    });
    on('delta', item => { this.sharedReplies.record(s, applyCodexDelta(s, item)); this.changed(); });
    on('messageItem', item => { this.sharedReplies.record(s, applyCodexMessage(s, item)); this.changed(); });
    on('complete', info => {
      this.cancelCapacity(s.id);
      // Only the adapter's verified native identity can authorize a forward.
      // An untagged completion can clear bookkeeping, never share its body.
      const forwardTag = info.tag || (s.provider === 'claude' ? s.pendingTag : null);
      if (s.provider === 'claude' || !s.pendingTag || s.pendingTag === info.tag || s.pendingTag === info.supersededTag) { s.pendingTag = null; s.activity = ''; if (!this.approvalRoutes.has(s.id)) s.approval = null; }
      if (s.provider === 'claude' && info.text && !runtime.nativeBlocks) s.messages.push({ id: randomUUID(), role: 'assistant', text: info.text, status: 'complete' });
      const forward = this.forwards.get(forwardTag);
      const shared = forward && forwardTag === info.tag && s.roomId === 'shared' && forward.member === s.memberRevision && forward.control === s.controlRevision && info.text && this.sharedReplies.final(s, info);
      const displayedPlan = forward && forwardTag === info.tag && !info.text && this.sharedReplies.hasCompletedPlan(s, forwardTag);
      if (forward && !shared && !displayedPlan) { const message = this.room.messages.find(m => m.id === forwardTag); if (message) message.status = 'reply-private'; }
      this.forwards.delete(forwardTag);
      this.changed();
      const run = this.room.run;
      this.peerLeases?.complete(s, info);
      this.advance(s, info).catch(error => { this.pause(error.message, run); });
      this.sharedReplies.close(forwardTag, displayedPlan ? '原生计划已显示，本轮已结束' : '原生回复已结束；未确认内容留在原会话');
    });
    on('failed', (reason, info) => {
      // An unscoped native error affects this observation connection, including
      // a shared input waiting for its ACK while the older private tag remains.
      if (!info) for (const grant of this.sharedReplies.grants.values()) {
        if (grant.sessionId === s.id && grant.runtime === runtime) this.sharedReplies.close(grant.tag, '原生状态未确认');
      }
      this.sharedReplies.close(info ? info.tag : s.pendingTag, '原生状态未确认'); for (const m of s.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed'; this.deliveryStatus(info?.tag || s.pendingTag, 'unconfirmed'); if (!info || s.pendingTag === info.tag || s.pendingTag === info.supersededTag) s.pendingTag = null; s.activity = reason; this.pauseParticipant(s.id, reason); this.changed(); });
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
    s.pendingTag = null; s.approval = null; s.approvalResolved = false; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(s.id);
    s.controlRevision++; s.memberRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1;
    s.fleet = (s.fleet || []).map(item => ({ ...item, stale: true }));
    s.nativeContextPending = ['clear', 'resume', 'terminal-switch'].includes(info.reason) ? { nativeId: info.nativeId, reason: info.reason } : null;
    s.activity = info.reason === 'resume' ? '原生已切换会话，此连接尚不能同步新历史。请在原生终端继续；旧记录与草稿保留。' : info.reason === 'terminal-switch' ? '正在核对原生上下文。记录和草稿保留，未自动发送。' : info.reason === 'clear' ? '原生上下文已改变，正在核对连接。记录和草稿保留，未自动发送。' : '原生会话正在结束。';
    this.pauseParticipant(s.id, '成员的原生上下文已改变；请重新确认共享内容。'); this.changed();
  }
  clearNativeContext(s, runtime, info) {
    if (this.closed || this.stops.has(s.id) || this.runtimes.get(s.id) !== runtime ||
      s.nativeContextPending?.nativeId !== info.previousId ||
      !(['clear', 'terminal-switch'].includes(s.nativeContextPending.reason) || (s.nativeContextPending.reason === 'resume' && info.reason === 'branch'))) return;
    if (this.storageWarning) return;
    if (s.nativeId === info.previousId) {
      for (const message of s.messages) if (!message.nativeId) message.nativeId = info.previousId;
      const boundaryId = randomUUID(), time = Date.now();
      s.nativeContexts ||= [];
      s.nativeContexts.push({ nativeId: info.previousId, endedAt: time, boundaryId, reason: info.reason || 'clear' });
      s.messages.push({ id: boundaryId, role: 'system', kind: 'context', name: '原生上下文', text: info.reason === 'terminal-switch' ? '已跟随原生终端切换上下文。上方记录仅作为本机历史保留，旧共享授权已停止。草稿保留，发送前请核对。' : info.reason === 'branch' ? '已在原生终端分支出新会话。上方记录是分支前的历史，旧共享授权已停止。草稿保留，发送前请核对。' : '已在原生终端清空上下文。上方记录仅作为本机历史保留，不会自动发给新上下文。草稿保留，发送前请核对。', nativeId: info.nativeId, time });
      s.nativeId = info.nativeId; s.model = info.model; s.nativeSettings = null; s.background = null; s.scheduled = null; s.usage = null;
      if (info.reason === 'terminal-switch' && typeof info.cwd === 'string' && path.isAbsolute(info.cwd)) s.cwd = info.cwd;
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
      if (s.owner !== owner) { if (s.owner !== null) wake.human(this, id); this.pause('真人接管会话'); s.controlRevision++; }
      // Viewing the same session is not a new instruction. Real terminal input
      // still invalidates queued work; taking control from another view does too.
      s.owner = owner; s.view = view; this.changed();
    }
    // A question held for the chat view goes back to the native dialog in the terminal.
    if (view === 'terminal') this.releaseQuestion(s, null);
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
    this.cancelCapacity(id);
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
  routeValid(route) { return route?.peerLease ? this.peerLeases?.valid(route) === true : this.room.run === route && route?.status === 'running' && Date.now() < route.deadline; }
  async send(id, text, owner, route = null, forward = null, sourceMessage = null, recovery = null, wakeTicket = null) {
    const originalText = text; text = cleanText(text); if (wakeTicket) text = originalText;
    const s = this.get(id); const runtime = this.runtime(id);
    if (runtime.nativeAbortRequest) throw Error('正在等待原生中断确认；草稿保留。');
    if (wakeTicket) {
      if (!wakeTicket.valid()) throw Error('自动消息授权已失效。');
      this.pauseParticipant(id, '原会话收到自动消息；旧协作交接已撤销', true);
    } else if (!route) {
      if (s.owner !== owner) throw new Error('请先接管这个会话。');
      s.peerRevision = (s.peerRevision || 0) + 1;
      if (recovery) this.pauseParticipant(id, `${recovery.reason === 'routing' ? '路由发现超时' : '模型满载'}自动继续；原协作交接保持暂停`, true);
      else { wake.human(this, id); this.pause('真人输入优先'); }
    }
    const failedTurn = !route && s.state === 'error' ? runtime.failedTurnInputId : null;
    if ((s.state !== 'idle' && !failedTurn && !(recovery && s.state === 'error')) || s.pendingTag || runtime.pendingQueue || s.approval || runtime.nativeInputRequired) throw new Error('会话尚未就绪，请查看原生终端或等待当前回复。');
    if (runtime.chatAvailable === false) throw new Error(s.provider === 'claude' ? '安全发送接口尚未连接；请在原生终端继续，草稿已保留。' : '请先在原生终端完成第一条消息；草稿已保留。');
    const control = s.controlRevision; const member = s.memberRevision; const connection = s.connectionRevision;
    const guard = () => {
      this.expireRun(route);
      return (!wakeTicket || wakeTicket.valid(wakeTicket.tag)) && (!recovery || this.capacityValid(s, recovery)) && !runtime.nativeInputRequired && s.state !== 'ended' && s.controlRevision === control &&
        (!failedTurn || runtime.submission?.pending?.authorized || runtime.pending?.accepted || runtime.failedTurnInputMatches(failedTurn)) &&
        (!(route || forward) || (s.roomId === 'shared' && s.memberRevision === member)) && (!route || (this.routeValid(route)));
    };
    if (!guard()) throw new Error('交接已经失效。');
    if (!recovery) this.cancelCapacity(id);
    const tag = randomUUID(); s.pendingTag = tag;
    if (recovery) recovery.tag = tag;
    if (wakeTicket) wakeTicket.tag = tag;
    const draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    const clearedDraft = !wakeTicket && !route && !forward && typeof draft === 'string' && draft.trim() === text;
    s.messages.push({ id: tag, role: 'user', text, ...(wakeTicket ? { name: `来自 ${wakeTicket.intent.senderName}`, origin: 'agent-wake', wakeSource: { id: wakeTicket.intent.id, senderId: wakeTicket.intent.senderId, nativeId: wakeTicket.intent.nativeId, turnId: wakeTicket.intent.turnId, time: wakeTicket.intent.time } } : recovery ? { name: 'NAW', origin: 'capacity-recovery' } : { origin: route ? 'room' : 'human' }), status: 'awaiting-native' });
    if (forward) {
      this.forwards.set(tag, { ...forward, control });
      sourceMessage = { id: tag, role: 'human', recipientId: s.id, name: `你 → ${s.name}`, text, status: 'awaiting-native', time: Date.now(), deliveryTracked: true, ...(forward.replyTo ? { replyTo: forward.replyTo } : {}) };
      this.room.messages.push(sourceMessage);
    }
    if (sourceMessage) {
      sourceMessage.deliveries ||= [];
      sourceMessage.deliveries.push({ id: tag, recipientId: s.id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() });
    }
    if ((route || forward) && sourceMessage) this.sharedReplies.authorize(s, runtime, tag, sourceMessage, route);
    this.versions.dispatches++;
    if (route) route.awaiting = { sessionId: id, tag, member, control };
    else if (clearedDraft) { this.pendingDrafts.set(id, { tag, text: draft, revision: draftRevision }); this.drafts.set(id, ''); }
    this.changed();
    try {
      if (wakeTicket) { this.persist(); if (this.storageWarning) throw Error('自动消息记录未能保存，没有派发。'); }
      if (recovery) { this.persist(); if (this.storageWarning) throw Error('自动继续记录未能保存，没有派发。'); }
      if (route?.peerLease) { this.persist(); if (this.storageWarning) throw Error('交接记录未能保存，没有向原生派发。'); }
      await runtime.send(text, tag, guard);
    }
    catch (error) {
      const current = this.runtimes.get(id) === runtime && s.connectionRevision === connection && s.pendingTag === tag;
      const sameControl = s.controlRevision === control;
      this.forwards.delete(tag); this.sharedReplies.close(tag, '接收结果未确认');
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
  async queue(id, text, owner, shared = null) {
    text = cleanText(text);
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw Error('原生命令请在终端执行；草稿已保留。');
    const s = this.get(id), runtime = this.runtime(id);
    const replyTo = shared && require('./room-threads.js').replyReference(shared.replyTo);
    if (shared && s.roomId !== 'shared') throw Error('接收方已离开共同工作。');
    if (s.owner !== owner || s.provider !== 'claude' || s.state !== 'working' || s.approval || !runtime.queueAvailable || runtime.pendingQueue) throw Error('原生会话当前不能接收等待输入，草稿保留。');
    s.peerRevision = (s.peerRevision || 0) + 1;
    this.pause('真人追加等待输入');
    // A shared queue continues the current public task until native pickup;
    // private input still revokes its output scope immediately.
    if (!shared) s.controlRevision++;
    const control = s.controlRevision, connection = s.connectionRevision, nativeId = s.nativeId, member = s.memberRevision;
    const valid = () => this.runtimes.get(id) === runtime && !runtime.nativeInputRequired && s.owner === owner && s.nativeId === nativeId && !s.nativeContextPending &&
      s.controlRevision === control && s.connectionRevision === connection && !s.approval && !['ended', 'recoverable', 'error', 'disconnected'].includes(s.state) &&
      (!shared || (s.roomId === 'shared' && s.memberRevision === member && this.sharedReplies.grants.has(tag) && !this.sharedReplies.grants.get(tag).closed));
    const tag = randomUUID(), draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    // Like a native TUI queue, the recorded message leaves the composer at once.
    const clearedDraft = !shared && typeof draft === 'string' && draft.trim() === text;
    runtime.pendingQueue = tag;
    const message = { id: tag, role: 'user', text, origin: 'human', status: 'awaiting-native', inputMode: 'queue' };
    if (shared) {
      const source = { id: tag, role: 'human', recipientId: id, name: `你 → ${s.name}`, text, status: 'awaiting-native', inputMode: 'queue', time: Date.now(), deliveryTracked: true,
        ...(replyTo ? { replyTo } : {}), deliveries: [{ id: tag, recipientId: id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() }] };
      this.room.messages.push(source); this.forwards.set(tag, { member, control, replyTo });
      // No running private turn is adopted. Only the next native prompt's
      // exact receipt can bind this grant; existing output stays private.
      this.sharedReplies.authorize(s, runtime, tag, source);
    }
    s.messages.push(message); if (clearedDraft) this.drafts.set(id, ''); this.versions.dispatches++; this.changed();
    try {
      await runtime.queue(text, tag, valid);
      message.status = 'submitted';
      this.deliveryStatus(tag, 'submitted');
      return tag;
    } catch (error) {
      // Only a proven non-send returns the text to an untouched draft. An
      // uncertain outcome stays in the record so it is not sent twice.
      const status = error.notSent === true ? 'not-sent' : 'unconfirmed';
      if (message.status !== 'submitted') message.status = status;
      if (status === 'not-sent' && clearedDraft && this.draftRevisions.get(id) === draftRevision && !this.drafts.get(id)) this.drafts.set(id, draft);
      if (shared) {
        this.forwards.delete(tag); this.sharedReplies.close(tag, status === 'not-sent' ? '没有发出' : '接收结果未确认'); this.deliveryStatus(tag, status);
        const source = this.room.messages.find(row => row.id === tag);
        if (source?.status === 'awaiting-native') source.status = status;
      }
      throw error;
    } finally { if (runtime.pendingQueue === tag) runtime.pendingQueue = null; this.changed(); }
  }
  async steer(id, text, owner, expectedTurnId, shared = null) {
    text = cleanText(text);
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw Error('原生命令请在终端执行；草稿已保留。');
    const s = this.get(id), runtime = this.runtime(id);
    const replyTo = shared && require('./room-threads.js').replyReference(shared.replyTo);
    if (shared && s.roomId !== 'shared') throw Error('接收方已离开共同工作。');
    if (s.owner !== owner || s.provider !== 'codex' || s.state !== 'working' || s.approval ||
      !runtime.steerAvailable || runtime.pendingSteer || typeof expectedTurnId !== 'string' || !expectedTurnId || runtime.turnId !== expectedTurnId) throw Error('当前原生回合或控制权已变化，草稿保留。');
    this.pause('真人追加指令'); s.controlRevision++;
    const control = s.controlRevision, connection = s.connectionRevision, nativeId = s.nativeId, member = s.memberRevision;
    const valid = () => this.runtimes.get(id) === runtime && !runtime.nativeInputRequired && s.owner === owner && s.nativeId === nativeId && !s.nativeContextPending && s.controlRevision === control &&
      s.connectionRevision === connection && !['ended', 'recoverable', 'error', 'disconnected', 'approval'].includes(s.state) && !s.approval && runtime.turnId === expectedTurnId &&
      (!shared || (s.roomId === 'shared' && s.memberRevision === member && this.sharedReplies.grants.has(tag) && !this.sharedReplies.grants.get(tag).closed));
    const tag = randomUUID(), draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    runtime.pendingSteer = tag;
    const message = { id: tag, role: 'user', text, origin: 'human', status: 'awaiting-native', inputMode: 'steer', turnId: expectedTurnId };
    if (shared) {
      const source = { id: tag, role: 'human', recipientId: id, name: `你 → ${s.name}`, text, status: 'awaiting-native', inputMode: 'steer', time: Date.now(), deliveryTracked: true,
        ...(replyTo ? { replyTo } : {}), deliveries: [{ id: tag, recipientId: id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() }] };
      this.room.messages.push(source); this.forwards.set(tag, { member, control, replyTo });
      this.sharedReplies.authorize(s, runtime, tag, source);
    }
    s.messages.push(message); this.versions.dispatches++; this.changed();
    try {
      await runtime.steer(text, tag, expectedTurnId, valid, Boolean(shared));
      message.status = 'submitted'; this.deliveryStatus(tag, 'submitted');
      if (!shared && s.controlRevision === control && this.draftRevisions.get(id) === draftRevision && draft?.trim() === text) this.drafts.set(id, '');
      return tag;
    } catch (error) {
      // Do not relabel ongoing output as cancelled or retry this input.
      if (message.status !== 'submitted') message.status = 'unconfirmed';
      if (shared) {
        this.forwards.delete(tag); this.sharedReplies.close(tag, '接收结果未确认'); this.deliveryStatus(tag, 'unconfirmed');
        const source = this.room.messages.find(row => row.id === tag);
        if (source?.status === 'awaiting-native') source.status = 'unconfirmed';
      }
      throw error;
    } finally { if (runtime.pendingSteer === tag) runtime.pendingSteer = null; this.changed(); }
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
    if (!response) { wake.human(this, id); this.cancelCapacity(id); this.pause('真人在原生终端操作'); s.controlRevision++; }
    const t = runtime.terminal; if (!t?.alive) throw new Error('终端尚未连接。'); t.input(data);
  }
  resize(id, owner, cols, rows) { const s = this.get(id); if (s.owner === owner && Number.isInteger(cols) && Number.isInteger(rows)) this.runtime(id).terminal?.resize(cols, rows); }
  async interrupt(id, owner) {
    const s = this.get(id); this.claim(id, owner, s.view); const runtime = this.runtime(id);
    if (this.capacityRecoveries.get(id)?.status === 'scheduled') { this.cancelCapacity(id); return; }
    // A held question is declined, like Esc on the native dialog, so native
    // neither waits on the hook nor opens the dialog; then the turn is aborted.
    if (this.claudeAsks.get(id)) this.releaseQuestion(s, null, { stop: true });
    if (runtime.nativeAbortRequest && runtime.nativeAbortCurrent?.(runtime.nativeAbortRequest)) return runtime.nativeAbortRequest.done;
    s.controlRevision++; this.pause('真人中断当前回复'); const result = await runtime.interrupt();
    s.activity = result?.interrupted ? '' : '已请求原生中断；团队任务请在原生终端确认。'; this.changed();
  }
  expireRun(run = this.room.run) {
    // The interval is only a wake-up aid. Native delivery/completion must also
    // enforce the boundary, even if timers were delayed (for example, by sleep).
    if (!run || run.id !== this.room.run?.id || run.status !== 'running' || Date.now() < run.deadline) return false;
    this.pause('达到本轮 10 分钟期限。'); return true;
  }
  pause(reason = '已暂停交接', run = this.room.run, automatic = false) {
    if (!automatic) wake.revoke(this);
    if (run?.peerLease) { this.peerLeases?.pause(run.client, run.id, reason); return; }
    if (run === this.room.run) this.peerLeases?.revoke(reason);
    if (run === this.room.run && run?.status === 'running') { if (run.kind === 'cross-service') run.pausePending = true; run.status = 'paused'; run.reason = reason; this.room.revision++; this.runEvent(reason); this.changed(); }
  }
  pauseParticipant(id, reason, automatic = false) {
    if (!automatic) wake.cancelParticipant(this, id);
    this.peerLeases?.revoke(reason, id);
    // Native activity in another independent session does not revoke this
    // selected run. Explicit human interventions still use the global pause.
    if (this.room.run?.ids.includes(id)) this.pause(reason, this.room.run, automatic);
  }
  runEvent(text) {
    const run = this.room.run;
    // Preserve a navigation reference when sharing pauses before a reply. This
    // does not attribute the pause to that session or authorize another handoff.
    const sessionId = run?.status === 'paused' ? run.awaiting?.sessionId : null;
    this.room.messages.push({ id: randomUUID(), role: 'system', name: '协作', text, time: Date.now(), runId: run?.id, ...(run?.sourceId ? { replyTo: run.sourceId } : {}), ...(sessionId ? { sessionId } : {}) });
  }
  nativeWorkObserved(id, reason) {
    this.peerLeases?.observedWork(id, reason);
    const run = this.room.run;
    if (run?.status !== 'running' || !run.ids.includes(id)) return;
    // Keep the current, already-authorized root reply. This observation only
    // blocks its next handoff; unrelated members must stop routing immediately.
    if (run.awaiting?.sessionId === id) { run.stopAfterReply = reason; run.reason = '本次回复返回后暂停后续转交；原生工作继续保留。'; }
    else this.pause(reason);
  }
  async startRun(ids, goal, maxSteps, mode = 'strict', labels = {}, _contexts, replyTo) {
    if (this.room.run?.pausePending || this.room.run?.pauseUnconfirmed) throw Error('请先核对各后台已撤销后续交接授权，再开始新的协作。');
    replyTo = require('./room-threads.js').replyReference(replyTo);
    if (!['strict', 'replies', 'directed'].includes(mode)) throw new Error('未知协作授权。');
    goal = cleanText(goal, 6000);
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length || ![2, 3, 4, 5, 6].includes(maxSteps) || maxSteps < ids.length) throw new Error('请选择 2–6 个不同会话，回复上限需覆盖每位参与者且不超过 6 次。');
    if (this.room.run?.status === 'running' || [...(this.peerLeases?.leases.values() || [])].some(g => g.status === 'running')) throw new Error('已有协作正在运行。');
    for (const id of ids) { const s = this.get(id); if (s.roomId !== 'shared' || s.state !== 'idle' || s.pendingTag || s.approval || [s.background, s.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) throw new Error('所选成员都需就绪、加入共同工作，且没有已报告的后台或定时工作。'); }
    if (ids.some(id => this.runtime(id).chatAvailable === false || this.runtime(id).nativeInputRequired)) throw new Error('有成员的安全发送接口尚未连接，请先在原生终端检查。');
    if (mode === 'directed' && ids.some(id => this.runtime(id).addressedSendAvailable !== true)) throw Error('所选会话尚未接通原生定向工具。原会话保持不变，仍可定向发送或按顺序核查。');
    // Freeze the human-visible names with this authorization, not native defaults.
    const names = Object.fromEntries(ids.map(id => {
      const s = this.get(id), name = labels && Object.hasOwn(labels, id) ? labels[id] : s.name;
      if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw new Error('参与者名称无效，请重新预览。');
      return [id, `${name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${id.slice(0, 6)}`];
    }));
    const run = { id: randomUUID(), ids: [...ids], names, goal, mode, maxSteps, steps: 0, status: 'running', reason: '', startedAt: Date.now(), deadline: Date.now() + 10 * 60 * 1000, awaiting: null, replies: {} };
    const sourceMessage = { id: randomUUID(), role: 'human', name: '你', text: goal, time: Date.now(), runId: run.id, deliveryTracked: true, ...(replyTo ? { replyTo } : {}) };
    run.sourceId = sourceMessage.id;
    this.room.run = run; this.room.messages.push(sourceMessage); this.changed();
    this.runEvent(mode === 'directed' ? `已授权成员选择接收者，最多 ${maxSteps} 次回复、10 分钟；没有定向调用就结束，不广播或轮询。` : mode === 'replies' ? `已授权依次转交本次回复，最多 ${maxSteps} 次、10 分钟；未知的原生子任务不视为结束。` : '核实原生工作状态后交接。');
    await this.send(ids[0], mode === 'directed' ? addressed.taskText(run, goal) : goal, null, run, null, sourceMessage);
  }
  async advance(s, info) {
    if (this.room.run?.kind === 'cross-service') return;
    const run = this.room.run; const a = run?.awaiting;
    if (this.expireRun(run)) return;
    if (!run || run.status !== 'running' || a?.sessionId !== s.id || a.tag !== info.tag || s.memberRevision !== a.member || s.controlRevision !== a.control || s.roomId !== 'shared') return;
    run.awaiting = null;
    if ((typeof info.text !== 'string' || !info.text.trim()) && !(run.mode === 'directed' && run.pendingHandoff)) return this.pause('原生没有提供可交接的回复，请人工查看。');
    const sourceMessage = this.sharedReplies.final(s, info, run);
    if (!sourceMessage) return this.pause('回复共享已失效，请在原会话核对。');
    run.steps++;
    if (run.stopAfterReply) return this.pause(run.stopAfterReply);
    // Keep the reply even when it cannot be handed off. A root Stop/turn end
    // and a list of observed fleet events are not a complete fleet inventory.
    const counts = [info.background, info.scheduled, info.fleetPending];
    if (info.stopHookActive === true || counts.some(n => Number.isSafeInteger(n) && n > 0)) return this.pause('原生仍有后台、团队或定时工作，或继续执行的 hooks。回复已保留；请查看原生终端，确认后可定向发送。');
    const unknown = info.stopHookActive !== false || counts.some(n => !Number.isSafeInteger(n) || n < 0);
    run.nativeWorkUnknown = unknown;
    if (unknown && !['replies', 'directed'].includes(run.mode)) return this.pause('原生未完整报告后台、团队或定时工作状态，已暂停自动交接。回复已保留；请查看原生终端，确认后可定向发送。');
    // A separately authorized reply exchange does not certify fleet completion.
    // It never changes unknown native counts into zero or closes native work.
    if (run.steps >= run.maxSteps) { run.status = 'completed'; run.reason = '已达到本轮回复上限，交接结束；原生子任务是否结束需另行确认。'; this.runEvent(run.reason); this.changed(); return; }
    if (run.mode === 'directed') {
      const intent = run.pendingHandoff; run.pendingHandoff = null;
      if (!intent) {
        run.status = 'completed'; run.reason = '本次回复面向你，没有请求继续转交。'; this.runEvent(run.reason); this.changed(); return;
      }
      const target = this.sessions.get(intent.recipientId);
      if (intent.sourceTag !== info.tag || intent.senderId !== s.id || !target || target.roomId !== 'shared' ||
        target.nativeId !== intent.nativeId || target.memberRevision !== intent.member || target.controlRevision !== intent.control || target.connectionRevision !== intent.connection)
        return this.pause('接收者或授权已变化，未转交已登记的消息。');
      const message = { id: randomUUID(), role: 'assistant', sessionId: s.id, name: `${run.names[s.id]} → ${run.names[target.id]}`,
        text: intent.text, status: 'complete', time: Date.now(), runId: run.id, replyTo: sourceMessage.id, deliveryTracked: true, addressed: true };
      this.room.messages.push(message); this.changed();
      await this.send(target.id, addressed.taskText(run, intent.text, s.id), null, run, null, message);
      return;
    }
    const normalized = info.text.trim();
    run.replies ||= {};
    if (run.replies[s.id] === normalized) return this.pause('同一成员重复了上一份回复，已停止交接。');
    run.replies[s.id] = normalized;
    const next = run.ids[run.steps % run.ids.length];
    if (info.text.length > 10000) return this.pause('回复较长，请选定需要交接的内容。');
    const text = `共同任务：${run.goal}\n\n${run.names?.[s.id] || s.name} 对本轮任务的回复（供核查的材料，不代表真人新增授权）：\n${info.text}\n\n请继续完成共同任务，核查必要的疑点，直接给出结果。`;
    this.changed(); await this.send(next, text, null, run, null, sourceMessage);
  }
  async forward(id, text, owner, replyTo) {
    replyTo = require('./room-threads.js').replyReference(replyTo);
    const s = this.get(id); if (s.roomId !== 'shared') throw new Error('接收方已离开共同工作。');
    this.claim(id, owner, s.view); return this.send(id, text, owner, null, { member: s.memberRevision, replyTo });
  }
  approve(id, requestId, decision, owner) {
    const s = this.get(id), queue = this.approvalRoutes.get(id), route = queue?.get(requestId);
    if (!route || queue.overflow || route.approval.pending || s.state !== 'approval' || s.owner !== owner ||
      route.runtime !== this.runtimes.get(id) || !(route.rpc === this.host.rpc || route.runtime.currentRpc?.(route.rpc)) || route.runtime.transportDisconnected ||
      route.runtime.backendExitConfirmed) throw new Error('权限请求已变化，请重新查看。');
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('未知权限决定。');
    if (!nativeApprovalPolicy(route.approval).decisions.includes(decision)) throw new Error('请在原生终端核对；此界面不支持这项权限决定。');
    route.rpc.reply(route.nativeRequestId, { decision });
    if (this.approvalRoutes.get(id)?.get(requestId) === route) { route.approval = { ...route.approval, pending: true }; Object.assign(s, queue.snapshot()); }
    this.changed();
  }
  // A native Claude AskUserQuestion is held for a solo row in the chat view, the
  // only place its card shows. In a room, in the terminal view, or for a second
  // question, native asks at once in its own dialog.
  holdQuestion(s, runtime, ask) {
    if (this.runtimes.get(s.id) !== runtime || s.view !== 'chat' || s.roomId || this.claudeAsks.has(s.id)) return ask.reply({});
    const requestId = randomUUID();
    this.claudeAsks.set(s.id, { requestId, reply: ask.reply, open: ask.open, questions: ask.questions });
    s.claudeQuestion = { requestId, questions: ask.questions }; this.changed();
    // Native ended the hook (timeout, interrupt, exit): the question is no longer answerable here.
    ask.onClose?.(() => { if (this.claudeAsks.get(s.id)?.requestId === requestId) { this.claudeAsks.delete(s.id); s.claudeQuestion = null; this.changed(); } });
  }
  releaseQuestion(s, answers, { stop = false } = {}) {
    const held = this.claudeAsks.get(s.id); if (!held) return;
    this.claudeAsks.delete(s.id); s.claudeQuestion = null;
    held.reply(answers ? { answers } : stop ? { stop: true } : {}); this.changed();
  }
  // Answers by question text; several choices are joined with commas, as native
  // reads them. null hands the question back to the native dialog.
  answerClaude(s, requestId, answers, owner) {
    const held = this.claudeAsks.get(s.id);
    if (!held || held.requestId !== requestId || s.owner !== owner || !held.open()) throw new Error('问题已变化，请重新查看。');
    if (answers === null) return this.releaseQuestion(s, null);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请回答每个问题。');
    const reply = {};
    for (const q of held.questions) {
      const given = answers[q.question];
      if (!Array.isArray(given) || !given.length || (!q.multiSelect && given.length !== 1) || given.length > q.options.length + 1 ||
        !given.every(a => typeof a === 'string' && a.trim() && a.length <= 16000)) throw new Error('请回答每个问题。');
      reply[q.question] = given.map(a => a.trim()).join(', ');
    }
    this.releaseQuestion(s, reply);
  }
  // A native Codex question answered here, with the reply native defines. The
  // terminal may answer the same request; native resolves it once, first wins.
  answer(id, requestId, answers, owner) {
    if (this.get(id).provider === 'claude') return this.answerClaude(this.get(id), requestId, answers, owner);
    const s = this.get(id), queue = this.approvalRoutes.get(id), route = queue?.get(requestId);
    if (!route || queue.overflow || route.approval.pending || s.state !== 'approval' || s.owner !== owner ||
      route.runtime !== this.runtimes.get(id) || !(route.rpc === this.host.rpc || route.runtime.currentRpc?.(route.rpc)) || route.runtime.transportDisconnected ||
      route.runtime.backendExitConfirmed) throw new Error('问题已变化，请重新查看。');
    const questions = nativeApprovalPolicy(route.approval).questions;
    if (s.provider !== 'codex' || !questions || questions.some(q => q.isSecret)) throw new Error('请在原生终端回答这个问题。');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请回答每个问题。');
    const reply = {};
    for (const q of questions) {
      const given = answers[q.id], labels = (q.options || []).map(o => o.label);
      if (!Array.isArray(given) || given.length !== 1 || typeof given[0] !== 'string' || !given[0].trim() || given[0].length > 16000) throw new Error('请回答每个问题。');
      if (labels.length && !q.isOther && !labels.includes(given[0])) throw new Error('只能从给出的选项中选择。');
      reply[q.id] = { answers: given };
    }
    route.rpc.reply(route.nativeRequestId, { answers: reply });
    if (this.approvalRoutes.get(id)?.get(requestId) === route) { route.approval = { ...route.approval, pending: true }; Object.assign(s, queue.snapshot()); }
    this.changed();
  }
  stop(id) {
    if (this.stops.has(id)) return this.stops.get(id);
    const s = this.get(id);
    if (['ended', 'background'].includes(s.state)) return Promise.resolve();
    if (s.externalHistory && s.recovering && s.state === 'starting' && !this.runtimes.has(id)) {
      s.connectionRevision = (s.connectionRevision || 0) + 1; s.recovering = false; s.state = 'recoverable';
      s.activity = '已取消连接，原生历史保持原样。'; this.changed(); return Promise.resolve();
    }
    const runtime = this.runtime(id);
    this.pause('正在断开原生会话'); s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1; s.recovering = false; s.state = 'stopping'; s.activity = '等待原生确认'; this.changed();
    const operation = Promise.resolve().then(() => runtime.stop()).then(result => {
      if (!['ended', 'recoverable', 'disconnected'].includes(result?.state)) throw new Error('原生未确认结束状态。');
      s.state = result.state; s.pendingTag = null; s.approval = null; s.approvalResolved = false; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(id);
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
      s.pendingTag = null; s.approval = null; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(id);
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
        if (s.provider === 'codex') await this.nativeHistory.ready();
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
    if (this.room.run?.pausePending || this.room.run?.pauseUnconfirmed) throw new Error('请先核对各后台已撤销后续交接授权，再清除共享记录。');
    for (const s of this.sessions.values()) s.peerRevision = (s.peerRevision || 0) + 1;
    this.peerLeases?.revoke('共享记录已清除，原交接授权已撤销。');
    this.room.run = null; this.room.messages = []; this.forwards.clear(); this.sharedReplies.grants.clear(); this.room.revision++; this.changed(); this.persist();
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
