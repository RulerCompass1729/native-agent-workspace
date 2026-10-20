const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const { ProgressJournal } = require('./observation.cjs');

const cleanText = (value, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('请输入有效文字；一次最多 16,000 个字符。');
  return value.trim();
};
const isTerminalResponse = data => /^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\](10|11);rgb:[\da-f/]+(\x07|\x1b\\)$/i.test(data);

class Workspace extends EventEmitter {
  constructor(host, dataDir) {
    super(); this.host = host; this.dataDir = dataDir; this.sessions = new Map(); this.runtimes = new Map(); this.drafts = new Map(); this.draftRevisions = new Map();
    this.room = { id: 'shared', name: '共同工作', revision: 0, run: null, messages: [] };
    this.versions = { shellModelCalls: 0, dispatches: 0 };
    this.saveTimer = null;
    this.deadlineTimer = setInterval(() => { if (this.room.run?.status === 'running' && Date.now() > this.room.run.deadline) this.pause('达到本轮 10 分钟期限。'); }, 1000);
    this.deadlineTimer.unref();
    this.forwards = new Map();
    this.stops = new Map();
    this.progress = new Map(); this.observedTerminals = new Map();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'));
      for (const record of stored.sessions || []) this.sessions.set(record.id, { ...record, state: record.state === 'ended' ? 'ended' : 'recoverable', owner: null, approval: null, pid: null, pendingTag: null, controlRevision: 0, liveDraft: '', activity: record.state === 'ended' ? '' : '运行服务曾中断；记录和草稿已保留，任务不会自动重发。' });
      this.room.messages = stored.room?.messages || [];
      if (stored.room?.run) this.room.run = { ...stored.room.run, awaiting: null, ...(stored.room.run.status === 'running' ? { status: 'paused', reason: '运行服务曾中断；未重发任务，请核对原生结果。' } : {}) };
      if (stored.drafts) for (const [key, value] of Object.entries(stored.drafts)) this.drafts.set(key, value);
    } catch (error) {
      if (error.code !== 'ENOENT') this.storageWarning = '本地记录未能读取，原文件已保留；请检查后再保存。';
    }
  }
  snapshot() {
    return { sessions: [...this.sessions.values()].map(s => ({ ...s, terminalAvailable: Boolean(this.runtimes.get(s.id)?.terminal?.alive || this.runtimes.get(s.id)?.hasHistory), chatAvailable: this.runtimes.get(s.id)?.chatAvailable !== false, liveDraft: this.drafts.get(s.id) || '' })), room: this.room, diagnostics: this.versions, available: Object.fromEntries(Object.entries(this.host.binaries).map(([k, v]) => [k, Boolean(v)])), storageWarning: this.storageWarning || null };
  }
  changed() {
    this.emit('change');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 150);
  }
  persist() {
    if (this.storageWarning) return;
    const target = path.join(this.dataDir, 'workspace.json'); const temp = `${target}.tmp`;
    try {
      // No terminal bytes, credentials, environment, hook secrets or raw protocol.
      const sessions = [...this.sessions.values()].map(({ owner, approval, pid, ...s }) => ({ ...s, pendingTag: null }));
      fs.writeFileSync(temp, JSON.stringify({ sessions, room: { messages: this.room.messages, ...(this.room.run ? { run: this.room.run } : {}) }, drafts: Object.fromEntries(this.drafts) }), { mode: 0o600 });
      fs.renameSync(temp, target); fs.chmodSync(target, 0o600);
    } catch { this.storageWarning = '本地保存失败，当前会话仍在内存中；请保留窗口并检查磁盘。'; this.emit('change'); }
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
    try {
      const runtime = this.host.create(record); this.runtimes.set(id, runtime); this.bind(record, runtime);
      if (runtime.start) await runtime.start();
      return id;
    } catch (error) { record.state = 'error'; record.activity = error.message; this.changed(); throw error; }
  }
  bind(s, runtime) {
    if (!this.progress.has(s.id)) this.progress.set(s.id, new ProgressJournal());
    for (const id of this.progress.keys()) {
      if (this.progress.size <= 12) break;
      if (!this.runtimes.has(id)) { this.progress.delete(id); this.observedTerminals.delete(id); }
    }
    runtime.on('progress', item => {
      const update = this.progress.get(s.id)?.update(item);
      if (update) this.emit('progress', { id: s.id, ...update });
    });
    runtime.on('capability', () => this.changed());
    runtime.on('pid', pid => { s.pid = pid; s.processIdentity = processIdentity(pid); s.serverIdentity = processIdentity(runtime.host?.codexProcess?.pid); this.changed(); });
    runtime.on('model', model => { s.model = model; this.changed(); });
    runtime.on('state', state => {
      if (this.stops.has(s.id) && !['ended', 'error', 'disconnected'].includes(state)) return;
      s.state = state;
      if (state !== 'starting' && s.activity === '正在连接原生历史') s.activity = '';
      if (state === 'ended') { s.pid = null; s.pendingTag = null; s.approval = null; this.runtimes.delete(s.id); }
      if (state === 'approval') this.pause('等待原生权限确认');
      if (state === 'working' && this.room.run?.status === 'running' && this.room.run.ids.includes(s.id) && this.room.run.awaiting?.sessionId !== s.id) this.pause('成员开始了本轮之外的原生工作，请核对后再交接。');
      if (state === 'ended' || state === 'error') this.pause('原生会话不可用'); this.changed();
    });
    runtime.on('terminal', event => {
      if (runtime.terminal) this.observedTerminals.set(s.id, runtime.terminal);
      this.emit('terminal', { id: s.id, ...event });
    });
    runtime.on('activity', text => { s.activity = text; this.changed(); });
    runtime.on('background', info => {
      s.background = info.count; s.scheduled = info.scheduled;
      if ([info.count, info.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) this.nativeWorkObserved(s.id, '原生报告仍有后台或定时工作，请核对后再交接。');
      this.changed();
    });
    runtime.on('usage', usage => { s.usage = usage; this.changed(); });
    runtime.on('fleet', item => {
      s.fleet.push({ ...item, time: Date.now() }); s.fleet = s.fleet.slice(-80);
      if (item.active === true || ['SubagentStart', 'thread/started', 'collabAgentSpawnToolCall'].includes(item.event)) this.nativeWorkObserved(s.id, '观察到原生团队活动，后续转交已暂停；原生团队继续保留。');
      this.changed();
    });
    runtime.on('approval', approval => { s.approval = approval; this.pause('等待原生权限确认'); this.changed(); });
    runtime.on('nativeInput', (text, item) => {
      this.pause('真人在原生终端输入'); s.controlRevision++;
      if (!item?.id || !s.messages.some(m => m.id === item.id)) s.messages.push({ id: item?.id || randomUUID(), role: 'user', text, status: 'submitted', origin: 'native' });
      this.changed();
    });
    runtime.on('history', items => {
      const existing = new Map(s.messages.map(m => [m.id, m])), imported = [], used = new Set();
      for (const item of items) {
        const own = item.type === 'userMessage' && item.clientId && existing.get(item.clientId)?.role === 'user' ? existing.get(item.clientId) : existing.get(item.id);
        // A cold connection's persisted partial text is not newer than native
        // history. Live items received on this connection still take precedence.
        if (own && s.recovering && item.type === 'agentMessage' && !runtime.liveMessageItems?.has(item.id)) {
          Object.assign(own, { text: item.text || '', status: item.turnId === runtime.turnId ? 'streaming' : 'complete', phase: item.phase });
        }
        if (own && s.recovering && item.type === 'userMessage' && item.clientId === own.id) own.status = 'submitted';
        const m = own || (item.type === 'userMessage'
          ? { id: item.id, role: 'user', text: (item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'), status: 'submitted', origin: 'native' }
          : { id: item.id, role: 'assistant', text: item.text || '', status: item.turnId === runtime.turnId ? 'streaming' : 'complete', phase: item.phase });
        if (!used.has(m.id)) { imported.push(m); used.add(m.id); }
      }
      // Keep live content and GUI submission status; only history supplies order.
      // No complete/nativeInput events: hydration cannot route or pause a task.
      s.messages = imported.concat(s.messages.filter(m => !used.has(m.id))); this.changed();
    });
    runtime.on('submitted', tag => { for (const list of [s.messages, this.room.messages]) { const m = list.find(m => m.id === tag); if (m) m.status = 'submitted'; } this.changed(); });
    runtime.on('delta', item => {
      let message = s.messages.find(m => m.id === item.id);
      if (!message) { message = { id: item.id, role: 'assistant', text: '', status: 'streaming' }; s.messages.push(message); }
      message.text += item.text; this.changed();
    });
    runtime.on('messageItem', item => { let m = s.messages.find(m => m.id === item.id); if (!m) { m = { id: item.id, role: 'assistant' }; s.messages.push(m); } Object.assign(m, { text: item.text, status: 'complete', phase: item.phase }); this.changed(); });
    runtime.on('complete', info => {
      // Claude's root Stop has no turn ID and loses its tag on human takeover
      // or interrupt. Codex has native turn IDs and must match its own pending.
      const forwardTag = info.tag || (s.provider === 'claude' ? s.pendingTag : null);
      if (s.provider === 'claude' || !s.pendingTag || s.pendingTag === info.tag) { s.pendingTag = null; s.activity = ''; s.approval = null; }
      if (s.provider === 'claude' && info.text) s.messages.push({ id: randomUUID(), role: 'assistant', text: info.text, status: 'complete' });
      const forward = this.forwards.get(forwardTag);
      if (forward && forwardTag === info.tag && s.roomId === 'shared' && forward.member === s.memberRevision && forward.control === s.controlRevision && info.text) this.room.messages.push({ id: randomUUID(), role: 'assistant', sessionId: s.id, name: s.name, text: info.text, time: Date.now() });
      else if (forward) { const message = this.room.messages.find(m => m.id === forwardTag); if (message) message.status = 'reply-private'; }
      this.forwards.delete(forwardTag);
      this.changed();
      this.advance(s, info).catch(error => { this.pause(error.message); });
    });
    runtime.on('failed', (reason, info) => { if (!info || s.pendingTag === info.tag) s.pendingTag = null; s.activity = reason; this.pause(reason); this.changed(); });
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
  async send(id, text, owner, route = null, forward = null) {
    text = cleanText(text); const s = this.get(id); const runtime = this.runtime(id);
    if (!route) { if (s.owner !== owner) throw new Error('请先接管这个会话。'); this.pause('真人输入优先'); }
    if (s.state !== 'idle' || s.pendingTag || s.approval) throw new Error('会话尚未就绪，请查看原生终端或等待当前回复。');
    if (runtime.chatAvailable === false) throw new Error(s.provider === 'claude' ? '安全发送接口尚未连接；请在原生终端继续，草稿已保留。' : '请先在原生终端完成第一条消息；草稿已保留。');
    const control = s.controlRevision; const member = s.memberRevision;
    const guard = () => s.state !== 'ended' && s.controlRevision === control && (!(route || forward) || (s.roomId === 'shared' && s.memberRevision === member)) && (!route || (this.room.run?.id === route.id && this.room.run.status === 'running'));
    if (!guard()) throw new Error('交接已经失效。');
    const tag = randomUUID(); s.pendingTag = tag;
    const draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    const clearedDraft = !route && !forward && typeof draft === 'string' && draft.trim() === text;
    s.messages.push({ id: tag, role: 'user', text, origin: route ? 'room' : 'human', status: 'awaiting-native' });
    if (forward) {
      this.forwards.set(tag, { ...forward, control });
      this.room.messages.push({ id: tag, role: 'human', recipientId: s.id, name: `你 → ${s.name}`, text, status: 'awaiting-native', time: Date.now() });
    }
    this.versions.dispatches++;
    if (route) route.awaiting = { sessionId: id, tag, member, control };
    else if (clearedDraft) this.drafts.set(id, '');
    this.changed();
    try { await runtime.send(text, tag, guard); }
    catch (error) {
      s.pendingTag = null; this.forwards.delete(tag);
      for (const list of [s.messages, this.room.messages]) { const m = list.find(m => m.id === tag); if (m) m.status = 'unconfirmed'; }
      if (clearedDraft && this.draftRevisions.get(id) === draftRevision) this.drafts.set(id, draft);
      this.pause(error.message); this.changed(); throw error;
    }
    return tag;
  }
  async terminal(id, owner) {
    this.claim(id, owner, 'terminal');
    const t = await this.runtime(id).openTerminal();
    return t.snapshot();
  }
  input(id, data, owner) {
    const s = this.get(id);
    if (typeof data !== 'string' || data.length > 65536) throw new Error('终端输入无效。');
    if (s.owner !== owner) throw new Error('另一个窗口正在控制这个会话。');
    // Terminal-generated device/cursor replies are not human instructions.
    const response = isTerminalResponse(data);
    if (!response && s.view !== 'terminal') throw new Error('请切换到原生终端后输入。');
    if (!response) { this.pause('真人在原生终端操作'); s.controlRevision++; }
    const t = this.runtime(id).terminal; if (!t?.alive) throw new Error('终端尚未连接。'); t.input(data);
  }
  resize(id, owner, cols, rows) { const s = this.get(id); if (s.owner === owner && Number.isInteger(cols) && Number.isInteger(rows)) this.runtime(id).terminal?.resize(cols, rows); }
  async interrupt(id, owner) { const s = this.get(id); this.claim(id, owner, s.view); s.controlRevision++; this.pause('真人中断当前回复'); await this.runtime(id).interrupt(); s.activity = '已请求原生中断；团队任务请在原生终端确认。'; this.changed(); }
  pause(reason = '已暂停交接') {
    const run = this.room.run;
    if (run?.status === 'running') { run.status = 'paused'; run.reason = reason; this.room.revision++; this.runEvent(reason); this.changed(); }
  }
  runEvent(text) {
    this.room.messages.push({ id: randomUUID(), role: 'system', name: '协作', text, time: Date.now(), runId: this.room.run?.id });
  }
  nativeWorkObserved(id, reason) {
    const run = this.room.run;
    if (run?.status !== 'running' || !run.ids.includes(id)) return;
    // Keep the current, already-authorized root reply. This observation only
    // blocks its next handoff; unrelated members must stop routing immediately.
    if (run.awaiting?.sessionId === id) { run.stopAfterReply = reason; run.reason = '本次回复返回后暂停后续转交；原生工作继续保留。'; }
    else this.pause(reason);
  }
  async startRun(ids, goal, maxSteps, mode = 'strict') {
    if (!['strict', 'replies'].includes(mode)) throw new Error('未知协作授权。');
    goal = cleanText(goal, 6000);
    if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || ![2, 3, 4, 5, 6].includes(maxSteps)) throw new Error('请选择两个不同会话和 2–6 次回复上限。');
    if (this.room.run?.status === 'running') throw new Error('已有协作正在运行。');
    for (const id of ids) { const s = this.get(id); if (s.roomId !== 'shared' || s.state !== 'idle' || s.pendingTag || s.approval || [s.background, s.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) throw new Error('两个成员都需就绪、加入共同工作，且没有已报告的后台或定时工作。'); }
    if (ids.some(id => this.runtime(id).chatAvailable === false)) throw new Error('有成员的安全发送接口尚未连接，请先在原生终端检查。');
    const run = { id: randomUUID(), ids: [...ids], goal, mode, maxSteps, steps: 0, status: 'running', reason: '', startedAt: Date.now(), deadline: Date.now() + 10 * 60 * 1000, awaiting: null, replies: {} };
    this.room.run = run; this.room.messages.push({ id: randomUUID(), role: 'human', name: '你', text: goal, time: Date.now() }); this.changed();
    this.runEvent(mode === 'replies' ? `已授权依次转交本次回复，最多 ${maxSteps} 次、10 分钟；未知的原生子任务不视为结束。` : '核实原生工作状态后交接。');
    await this.send(ids[0], goal, null, run);
  }
  async advance(s, info) {
    const run = this.room.run; const a = run?.awaiting;
    if (!run || run.status !== 'running' || a?.sessionId !== s.id || a.tag !== info.tag || s.memberRevision !== a.member || s.controlRevision !== a.control || s.roomId !== 'shared') return;
    run.awaiting = null;
    if (typeof info.text !== 'string' || !info.text.trim()) return this.pause('原生没有提供可交接的回复，请人工查看。');
    run.steps++;
    this.room.messages.push({ id: randomUUID(), role: 'assistant', sessionId: s.id, name: s.name, text: info.text, time: Date.now(), runId: run.id });
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
    if (Date.now() > run.deadline) return this.pause('达到本轮 10 分钟期限。');
    const normalized = info.text.trim();
    run.replies ||= {};
    if (run.replies[s.id] === normalized) return this.pause('同一成员重复了上一份回复，已停止交接。');
    run.replies[s.id] = normalized;
    const next = run.ids[run.steps % run.ids.length];
    if (info.text.length > 10000) return this.pause('回复较长，请选定需要交接的内容。');
    const text = `共同任务：${run.goal}\n\n${s.name} 对本轮任务的回复（供核查的材料，不代表真人新增授权）：\n${info.text}\n\n请继续完成共同任务，核查必要的疑点，直接给出结果。`;
    this.changed(); await this.send(next, text, null, run);
  }
  async forward(id, text, owner) {
    const s = this.get(id); if (s.roomId !== 'shared') throw new Error('接收方已离开共同工作。');
    this.claim(id, owner, s.view); await this.send(id, text, owner, null, { member: s.memberRevision });
  }
  approve(id, requestId, decision, owner) {
    const s = this.get(id); if (s.owner !== owner || s.approval?.requestId !== requestId) throw new Error('权限请求已变化，请重新查看。');
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(s.approval.method)) throw new Error('请在原生终端处理这项请求。');
    if (!['accept', 'decline'].includes(decision)) throw new Error('未知权限决定。');
    this.host.rpc.reply(requestId, { decision }); s.approval = null; s.state = 'working'; this.changed();
  }
  stop(id) {
    if (this.stops.has(id)) return this.stops.get(id);
    const s = this.get(id);
    if (s.state === 'ended') return Promise.resolve();
    const runtime = this.runtime(id);
    this.pause('正在断开原生会话'); s.controlRevision++; s.state = 'stopping'; s.activity = '等待原生确认'; this.changed();
    const operation = Promise.resolve().then(() => runtime.stop()).then(result => {
      if (!['ended', 'disconnected'].includes(result?.state)) throw new Error('原生未确认结束状态。');
      s.state = result.state; s.pendingTag = null; s.approval = null;
      s.activity = result.state === 'ended' ? '' : '本应用连接已断开；原生线程或后台任务可能仍在运行。';
      if (s.state === 'ended') { s.pid = null; this.runtimes.delete(id); }
    }).catch(error => { s.state = 'error'; s.activity = error.message; throw error; })
      .finally(() => { this.stops.delete(id); this.changed(); });
    this.stops.set(id, operation); return operation;
  }
  async resume(id, owner) {
    const s = this.get(id);
    if (this.runtimes.has(id)) throw new Error('该会话仍有运行连接，请先检查原生状态。');
    if (!s.nativeId || !['ended', 'recoverable', 'error'].includes(s.state)) throw new Error('这个会话目前不能恢复。');
    const sameServer = s.provider === 'codex' && s.serverIdentity?.pid === this.host.codexProcess?.pid;
    if ((!sameServer && processMayBeAlive(s.serverIdentity)) || (processMayBeAlive(s.processIdentity) && !(sameServer && s.processIdentity.pid === s.serverIdentity.pid))) throw new Error('之前的原生进程可能仍在运行。请先在原生界面检查，避免并行恢复同一个会话。');
    if (!fs.statSync(s.cwd).isDirectory()) throw new Error('原工作目录不可用，请先恢复该目录。');
    s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1; s.owner = owner; s.recovering = true; s.state = 'starting'; s.activity = '正在连接原生历史';
    // Membership is retained, but an interrupted automatic run never restarts.
    this.pause('恢复原生会话后，请重新选择本次协作任务。'); this.changed();
    try {
      const runtime = this.host.create(s); this.runtimes.set(id, runtime); this.bind(s, runtime);
      if (runtime.start) await runtime.start();
    } catch (error) {
      if (!this.runtimes.get(id)?.terminal?.alive && !this.runtimes.get(id)?.hasHistory) this.runtimes.delete(id);
      s.state = 'error'; s.activity = error.message; this.changed(); throw error;
    } finally { s.recovering = false; this.changed(); }
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
  close() { clearTimeout(this.saveTimer); clearInterval(this.deadlineTimer); this.persist(); this.host.close(); }
}

module.exports = { Workspace, cleanText, isTerminalResponse };
