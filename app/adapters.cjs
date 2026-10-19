const { EventEmitter } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { SubmissionChannel, createSubmissionServer } = require('./claude-submit.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const { executable, pythonExecutable, nativeEnvironment } = require('./platform.cjs');

class Terminal extends EventEmitter {
  constructor(argv, cwd, env = {}) {
    super();
    this.pid = null; this.alive = true; this.sequence = 0; this.nativeExited = false;
    this.screen = new HeadlessTerminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    this.serialize = new SerializeAddon(); this.screen.loadAddon(this.serialize);
    this.decoder = new StringDecoder('utf8');
    this.worker = spawn(pythonExecutable(), [path.join(__dirname, 'pty_host.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: nativeEnvironment(env) });
    let lines = '';
    this.worker.stdout.setEncoding('utf8');
    this.worker.stdout.on('data', chunk => {
      lines += chunk;
      for (let at; (at = lines.indexOf('\n')) >= 0;) {
        const line = lines.slice(0, at); lines = lines.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'started') { this.pid = message.pid; this.emit('started', this.pid); }
        if (message.type === 'exit' && Number.isInteger(message.code)) this.nativeExited = true;
        if (message.type === 'data') {
          const data = this.decoder.write(Buffer.from(message.data, 'base64'));
          this.screen.write(data, () => this.emit('data', { data, sequence: ++this.sequence }));
        }
      }
    });
    // Native diagnostics stay in the terminal; do not persist or upload stderr.
    this.worker.stderr.on('data', () => {});
    this.worker.on('error', () => {});
    // close follows stdout drainage, including the worker's waitpid result.
    this.worker.on('close', () => { this.alive = false; this.emit('closed', { confirmed: this.nativeExited }); });
    this.worker.stdin.on('error', () => {});
    this.worker.stdin.write(JSON.stringify({ argv, cwd, env: { ...env, PWD: cwd } }) + '\n');
    // Only the canonical screen answers device queries, even with no GUI open.
    this.screen.onData(data => { if (this.alive) this.input(data); });
  }
  command(message) {
    if (!this.alive || !this.worker.stdin.writable) throw new Error('原生终端已经关闭。');
    this.worker.stdin.write(JSON.stringify(message) + '\n');
  }
  input(data) { this.command({ type: 'input', data }); }
  resize(cols, rows) {
    cols = Math.max(20, Math.min(400, cols)); rows = Math.max(5, Math.min(200, rows));
    if (this.alive && (cols !== this.screen.cols || rows !== this.screen.rows)) { this.screen.resize(cols, rows); this.command({ type: 'resize', cols, rows }); }
  }
  snapshot() { return new Promise(resolve => this.screen.write('', () => resolve({ buffer: this.serialize.serialize(), sequence: this.sequence, cols: this.screen.cols, rows: this.screen.rows, pid: this.pid }))); }
  stop(timeout = 5000) {
    if (this.stopPending) return this.stopPending;
    if (!this.alive) return this.nativeExited ? Promise.resolve() : Promise.reject(new Error('原生进程退出未获确认；请检查原生会话。'));
    this.stopPending = new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); this.off('closed', closed); error ? reject(error) : resolve(); };
      const closed = result => finish(result.confirmed ? null : new Error('终端连接断开，但原生进程退出未获确认。'));
      const timer = setTimeout(() => finish(new Error('原生进程仍未确认退出；保留状态，请检查后重试。')), timeout);
      this.once('closed', closed);
      try { this.command({ type: 'stop' }); } catch (error) { finish(error); }
    }).finally(() => { this.stopPending = null; });
    return this.stopPending;
  }
}

class Claude extends EventEmitter {
  constructor(record, host) {
    super(); this.record = record; this.host = host; this.pending = null; this.ready = false; this.chatAvailable = false;
    this.submission = new SubmissionChannel();
    this.submission.on('change', () => { this.chatAvailable = this.submission.connected; this.emit('capability'); });
    this.token = crypto.randomBytes(32).toString('hex');
    host.hookTargets.set(this.token, this);
    const command = `${quote(pythonExecutable())} ${quote(path.join(__dirname, 'claude_hook.py'))}`;
    const hooks = {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted', 'SessionEnd']) {
      hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 2 }] }];
    }
    const settings = path.join(host.privateDir, `${record.id}.settings.json`);
    fs.writeFileSync(settings, JSON.stringify({ teammateMode: 'in-process', hooks }), { mode: 0o600 });
    this.terminal = new Terminal([host.binaries.claude, record.recovering ? '--resume' : '--session-id', record.nativeId, '--name', record.name, '--prompt-suggestions', 'false', '--settings', settings, '--plugin-dir', path.join(__dirname, 'claude-bridge')], record.cwd, {
      NAW_HOOK_TOKEN: this.token, NAW_HOOK_SOCKET: host.hookSocket, NAW_SUBMIT_SOCKET: host.submitSocket,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    });
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => this.emit('pid', pid));
    this.terminal.on('closed', result => {
      this.ready = false; this.submission.close();
      if (result.confirmed) this.host.hookTargets.delete(this.token);
      else this.emit('activity', '终端连接断开，原生进程退出未确认。');
      this.emit('state', result.confirmed ? 'ended' : 'error');
    });
  }
  hook(event) {
    // Teammates inherit hooks. Never attribute a child's final reply to its lead.
    const isChild = Boolean(event.agent_id) || event.session_id !== this.record.nativeId;
    if (['SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted'].includes(event.hook_event_name)) this.emit('fleet', {
      event: event.hook_event_name, id: event.agent_id || event.task_id || '',
      name: event.teammate_name || event.agent_type || event.task_subject || '原生团队活动',
    });
    if (isChild) return;
    switch (event.hook_event_name) {
      case 'SessionStart': this.ready = true; this.emit('state', 'idle'); this.emit('model', event.model || '原生默认'); break;
      case 'UserPromptSubmit':
        // A settings hook observing a prompt is not its acceptance. The native
        // structured submission result acknowledges our own sends separately.
        if (!this.pending || event.prompt !== this.pending.text) { this.pending = null; this.emit('state', 'working'); this.emit('nativeInput', event.prompt || '原生输入'); }
        break;
      case 'PermissionRequest': this.emit('state', 'approval'); break;
      case 'Notification':
        if (/permission|elicitation|auth/.test(event.notification_type || '')) this.emit('state', 'approval');
        break;
      case 'PreToolUse': this.emit('activity', event.tool_name || '原生工具'); this.emit('state', 'working'); break;
      case 'Stop': {
        const pending = this.pending; this.pending = null;
        const background = Array.isArray(event.background_tasks) ? event.background_tasks.length : null;
        const scheduled = Array.isArray(event.session_crons) ? event.session_crons.length : null;
        this.emit('background', { count: background, scheduled });
        this.emit('state', 'idle');
        // Observed child hooks cannot certify that all descendants are idle.
        this.emit('complete', { tag: pending?.tag, text: event.last_assistant_message || '', background, scheduled, fleetPending: null, stopHookActive: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null });
        break;
      }
      case 'StopFailure': this.pending = null; this.emit('state', 'error'); this.emit('failed', '原生请求未完成，请在原生终端查看。'); break;
      case 'SessionEnd': this.ready = false; this.emit('state', 'stopping'); break;
    }
  }
  async send(text, tag, guard) {
    if (!this.ready || this.pending) throw new Error('Claude 尚未就绪，或上一条输入仍待确认。');
    if (!guard()) throw new Error('这条交接已撤销。');
    this.pending = { tag, text };
    try {
      await this.submission.request(text, tag, guard);
      this.emit('submitted', tag);
      if (this.pending?.tag === tag) this.emit('state', 'working');
    } catch (error) { if (this.pending?.tag === tag) this.pending = null; throw error; }
  }
  interrupt() { this.pending = null; this.terminal.input('\x1b'); }
  async openTerminal() { return this.terminal; }
  async stop() { await this.terminal.stop(); this.host.hookTargets.delete(this.token); return { state: 'ended' }; }
}

class Rpc extends EventEmitter {
  constructor(ws) {
    super(); this.ws = ws; this.sequence = 0; this.pending = new Map();
    ws.on('message', data => {
      let message; try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.method) this.emit('event', message);
      else if (this.pending.has(message.id)) {
        const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(new Error(`原生接口拒绝请求（${message.error.code}），请查看原生会话。`)) : p.resolve(message.result);
      }
    });
    ws.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('原生连接已断开；不会自动重发。')); } this.pending.clear(); this.emit('closed'); });
    ws.on('error', () => {});
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('原生请求确认超时；不会自动重发。')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  reply(id, result) { this.ws.send(JSON.stringify({ id, result })); }
}

class Codex extends EventEmitter {
  constructor(record, host) {
    super(); this.record = record; this.host = host; this.pending = null; this.turnId = null; this.terminal = null; this.turns = new Map(); this.ownInputs = new Set(); this.hasHistory = false; this.chatAvailable = !record.recovering && record.view !== 'terminal'; this.stopped = false; this.eventRevision = 0; this.stateRevision = 0; this.on('state', () => this.stateRevision++); this.inputItems = new Set(); this.liveMessageItems = new Set(); this.historyMessageItems = new Set();
    if (record.recovering) this.recoveryReady = new Promise(resolve => { this.finishRecoveryConnection = resolve; });
  }
  async start() {
    try { await this.host.startCodex(); }
    catch (error) { this.finishRecoveryConnection?.(false); throw error; }
    if (this.record.recovering) {
      // Subscribe locally before the request: native events may precede its ACK.
      // Persisted text has no delta watermark; wait for authoritative completion
      // rather than appending an unknown suffix/prefix to an old partial reply.
      for (const message of this.record.messages || []) {
        if (message.role === 'assistant') this.historyMessageItems.add(message.id);
        if (message.role === 'user' && ['human', 'room'].includes(message.origin)) this.ownInputs.add(message.id);
      }
      this.host.codexTargets.set(this.record.nativeId, this);
      const revision = this.stateRevision;
      let result;
      try {
        result = await this.host.rpc.call('thread/resume', { threadId: this.record.nativeId, cwd: this.record.cwd, excludeTurns: true });
        if (result.thread?.id !== this.record.nativeId) throw new Error('原生返回了不同的会话，恢复未确认。');
      } catch (error) {
        if (this.host.codexTargets.get(this.record.nativeId) === this) this.host.codexTargets.delete(this.record.nativeId);
        this.finishRecoveryConnection?.(false);
        throw error;
      }
      if (this.stopped) { this.finishRecoveryConnection?.(false); return; }
      this.hasHistory = true; this.finishRecoveryConnection?.(true);
      this.emit('pid', this.host.codexProcess.pid); this.emit('model', result.model || result.thread.model || '原生默认');
      if (revision === this.stateRevision) this.observeStatus(result.thread.status);
      // The TUI can display native history while the graphical copy is loading.
      if (this.record.view === 'terminal') await this.openTerminal();
      try {
        if (!await this.hydrateHistory(this.record.nativeId)) return;
        this.chatAvailable = true; this.emit('capability');
      } catch {
        if (!this.stopped) this.emit('activity', '对话历史同步未完成；已保存的记录和草稿仍保留，请在原生终端继续。');
      }
      return;
    }
    if (this.record.view === 'terminal') {
      this.host.createCodex(() => this.startFromTerminal()).catch(error => { if (!this.stopped) { this.emit('activity', error.message); this.emit('state', 'error'); } });
      return;
    }
    await this.host.createCodex(async () => {
    // Let native configuration/requirements choose permissions for this cwd.
    const r = await this.host.rpc.call('thread/start', { cwd: this.record.cwd, ephemeral: false, experimentalRawEvents: false });
    this.record.nativeId = r.thread.id;
    this.host.codexTargets.set(this.record.nativeId, this);
    this.emit('model', r.model || r.thread.model || '原生默认');
    this.emit('pid', this.host.codexProcess.pid); this.emit('state', 'idle');
    });
  }
  async startFromTerminal() {
    if (this.stopped) return;
    await new Promise((resolve, reject) => {
      // Login/trust is a human decision, not a timed model request. Keep the
      // creation slot until that terminal starts a thread or actually exits.
      const timeout = setTimeout(() => this.emit('activity', '等待原生登录或文件夹确认，请在终端继续。'), 120000);
      const cleanup = () => {
        clearTimeout(timeout);
        if (this.host.pendingCodex === started) this.host.pendingCodex = null;
        this.terminal?.off('closed', closed);
      };
      const closed = () => { cleanup(); reject(new Error('原生初始化已退出；未发送模型任务。')); };
      const started = thread => {
        cleanup();
        this.record.nativeId = thread.id; this.host.codexTargets.set(thread.id, this);
        this.emit('activity', ''); this.emit('model', thread.model || '原生默认'); this.emit('state', 'idle'); resolve();
        this.observing = this.observeFirstTurn().catch(() => { if (!this.stopped) this.emit('activity', '原生终端可继续；对话连接未确认。'); });
      };
      this.host.pendingCodex = started;
      try {
        this.makeTerminal([this.host.binaries.codex, '-c', 'analytics.enabled=false', '--remote', `unix://${this.host.codexSocket}`, '-C', this.record.cwd]).once('closed', closed);
      } catch (error) { cleanup(); reject(error); }
    });
  }
  async observeFirstTurn() {
    // An empty native thread cannot be resumed. Wait for a real user turn;
    // never spend a model call to manufacture history for an attachment.
    while (!this.stopped && !this.chatAvailable) {
      await delay(1000);
      if (this.stopped) return;
      const revision = this.eventRevision;
      const { thread } = await this.host.rpc.call('thread/read', { threadId: this.record.nativeId, includeTurns: false });
      if (this.stopped) return;
      const nativeState = thread.status?.type;
      if (revision === this.eventRevision) this.emit('state', nativeState === 'active' ? 'working' : nativeState === 'idle' ? 'idle' : 'starting');
      if (!thread.preview || nativeState !== 'idle') continue;
      await this.host.rpc.call('thread/resume', { threadId: thread.id, excludeTurns: true });
      if (this.stopped) return;
      if (!await this.hydrateHistory(thread.id)) return;
      this.chatAvailable = true; this.hasHistory = true; this.emit('capability');
    }
  }
  async hydrateHistory(threadId) {
    // Read all pages before committing a history snapshot. Live input/approval
    // still takes effect immediately; history itself must never take control.
    const items = new Map(), cursors = new Set(); let cursor;
    for (let page = 0; page < 1000; page++) {
      if (this.stopped) return false;
      const result = await this.host.rpc.call('thread/items/list', { threadId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      if (this.stopped) return false;
      if (!Array.isArray(result.data)) throw new Error('原生历史格式未能确认；请在原生终端继续。');
      for (const entry of result.data) {
        const item = entry.item || entry;
        if (!item || typeof item.id !== 'string' || !item.id) throw new Error('原生历史缺少消息标识；请在原生终端继续。');
        if (['agentMessage', 'userMessage'].includes(item.type)) items.set(item.id, { ...item, turnId: entry.turnId });
      }
      cursor = result.nextCursor;
      if (cursor == null) {
        for (const item of items.values()) {
          // A history snapshot has no delta watermark. If no live stream was
          // observed, wait for the authoritative completed item instead of
          // appending potentially overlapping deltas to that snapshot.
          if (item.type === 'agentMessage' && !this.liveMessageItems.has(item.id)) this.historyMessageItems.add(item.id);
        }
        this.emit('history', [...items.values()]); return true;
      }
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('原生历史分页未能确认；请在原生终端继续。');
      cursors.add(cursor);
    }
    throw new Error('原生历史超过本次读取上限；请在原生终端查看完整记录。');
  }
  makeTerminal(argv) {
    this.terminal = new Terminal(argv, this.record.cwd);
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => this.emit('pid', pid));
    this.terminal.on('closed', () => this.emit('activity', '原生终端已退出；已连接的会话仍由运行服务管理。'));
    return this.terminal;
  }
  observeStatus(status) {
    if (status?.type === 'idle') this.emit('state', 'idle');
    else if (status?.type === 'active') this.emit('state', status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'approval' : 'working');
    else if (status?.type === 'systemError') this.emit('state', 'error');
    else { this.emit('state', 'starting'); this.emit('activity', '原生状态尚未确认，请在原生终端查看。'); }
  }
  event(message) {
    const p = message.params || {};
    this.eventRevision++;
    if (message.method === 'thread/closed') {
      this.closed = true; this.stopped = true; this.finishRecoveryConnection?.(false); this.host.codexTargets.delete(this.record.nativeId); this.emit('state', 'ended'); return;
    }
    if (this.stopped) return;
    if (message.id !== undefined) { this.emit('approval', { requestId: message.id, method: message.method, params: p }); this.emit('state', 'approval'); return; }
    switch (message.method) {
      case 'thread/status/changed': this.observeStatus(p.status); break;
      case 'turn/started': this.turnId = p.turn.id; this.emit('state', 'working'); break;
      case 'item/agentMessage/delta':
        this.stateRevision++; // Live work invalidates an older resume status.
        if (!this.historyMessageItems.has(p.itemId)) { this.liveMessageItems.add(p.itemId); this.emit('delta', { id: p.itemId, text: p.delta }); }
        break;
      case 'item/started':
        if (p.item?.type && !['agentMessage', 'userMessage', 'reasoning'].includes(p.item.type)) this.emit('activity', p.item.type);
        if (/collab|agent/i.test(p.item?.type || '') && p.item.type !== 'agentMessage') this.emit('fleet', { event: p.item.type, id: p.item.id, name: 'Codex 原生子 agent' });
        break;
      case 'item/completed':
        if (['userMessage', 'agentMessage'].includes(p.item?.type)) this.stateRevision++;
        if (p.item?.type === 'agentMessage') { this.liveMessageItems.add(p.item.id); this.turn(p.turnId).text = p.item.text || ''; this.emit('messageItem', { id: p.item.id, text: p.item.text || '', phase: p.item.phase }); }
        // A human may steer an active GUI turn from the native terminal. Only
        // our explicitly identified echo is redundant; matching text is not ID.
        if (p.item?.type === 'userMessage' && !this.ownInputs.has(p.item.clientId) && (!p.item.id || !this.inputItems.has(p.item.id))) {
          if (p.item.id) this.inputItems.add(p.item.id);
          this.emit('nativeInput', (p.item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'), { id: p.item.id });
        }
        break;
      case 'thread/tokenUsage/updated': this.emit('usage', p.tokenUsage); break;
      case 'turn/completed': {
        this.turn(p.turn.id).completed = p.turn;
        // Events can arrive before the RPC acknowledgement names our turn.
        // Wait for that identity instead of assigning whichever turn finishes.
        if (!this.pending || this.pending.turnId) this.finishTurn(p.turn.id);
        break;
      }
      case 'error': this.emit('failed', '原生会话返回错误，请检查终端。'); break;
    }
  }
  turn(id) { if (!this.turns.has(id)) this.turns.set(id, { text: '' }); return this.turns.get(id); }
  finishTurn(id) {
    const turn = this.turns.get(id); if (!turn?.completed) return;
    const pending = this.pending?.turnId === id ? this.pending : null;
    if (pending) this.pending = null;
    this.turns.delete(id); this.hasHistory = true;
    if (this.turnId === id) { this.turnId = null; this.emit('state', 'idle'); }
    if (turn.completed.status !== 'completed') this.emit('failed', '原生回合中断或失败；协作已暂停。', { tag: pending?.tag });
    else this.emit('complete', { tag: pending?.tag, text: turn.text, background: null, scheduled: null, fleetPending: null, stopHookActive: null });
  }
  async send(text, tag, guard) {
    if (!this.chatAvailable || this.pending || !guard()) throw new Error('会话忙碌、原生对话接口尚未连接，或交接已失效。');
    const pending = this.pending = { tag, turnId: null }; this.ownInputs.add(tag);
    try {
      const r = await this.host.rpc.call('turn/start', { threadId: this.record.nativeId, clientUserMessageId: tag, input: [{ type: 'text', text, text_elements: [] }] });
      pending.turnId = r.turn.id;
      if (!this.turnId) this.turnId = r.turn.id;
      this.emit('submitted', tag);
      for (const id of this.turns.keys()) this.finishTurn(id);
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      for (const id of this.turns.keys()) this.finishTurn(id);
      throw error;
    }
  }
  async interrupt() {
    if (!this.turnId) throw new Error('尚未确认当前原生回合；请在原生终端中断。');
    await this.host.rpc.call('turn/interrupt', { threadId: this.record.nativeId, turnId: this.turnId });
  }
  async openTerminal() {
    if (this.recoveryReady && !this.hasHistory && !await this.recoveryReady) throw new Error('原生会话恢复尚未确认，请检查恢复状态后重试。');
    if (this.stopped) throw new Error('本应用已断开该会话；原生历史仍保留。');
    if (this.terminal?.alive) return this.terminal;
    if (!this.record.nativeId) { for (let i = 0; i < 100 && !this.terminal; i++) await delay(50); if (this.terminal) return this.terminal; }
    if (!this.hasHistory) throw new Error('请先完成一条对话，再打开同一会话的原生终端。');
    return this.makeTerminal([this.host.binaries.codex, '-c', 'analytics.enabled=false', 'resume', '--remote', `unix://${this.host.codexSocket}`, this.record.nativeId]);
  }
  async stop() {
    const previouslyStopped = this.stopped;
    this.stopped = true;
    try {
      if (!this.record.nativeId) {
        // Stop only this uninitialized terminal. If a thread started during
        // shutdown, follow the normal unsubscribe path below.
        await this.terminal?.stop();
        if (!this.record.nativeId) { this.emit('state', 'ended'); return { state: 'ended' }; }
      }
      await this.observing;
      if (this.turnId) await this.interrupt();
      await this.terminal?.stop();
      const result = await this.host.rpc.call('thread/unsubscribe', { threadId: this.record.nativeId });
      if (!['notLoaded', 'notSubscribed', 'unsubscribed'].includes(result.status)) throw new Error('原生返回了未知的断开状态。');
      // An unsubscribe acknowledgement is not thread termination. The server may
      // retain its thread or other subscribers; never kill the shared app-server.
      const state = this.closed || result.status === 'notLoaded' ? 'ended' : 'disconnected';
      if (state === 'ended') this.host.codexTargets.delete(this.record.nativeId);
      this.emit('state', state);
      return { state };
    } catch (error) {
      this.stopped = previouslyStopped;
      throw error;
    }
  }
}

class NativeHost {
  constructor(privateDir) {
    this.privateDir = privateDir; this.hookSocket = path.join(privateDir, 'hooks.sock');
    this.submitSocket = path.join(privateDir, 'submit.sock');
    this.codexSocket = path.join(privateDir, 'codex.sock'); this.hookTargets = new Map(); this.codexTargets = new Map();
    this.submissions = createSubmissionServer(this.submitSocket, this.hookTargets);
    this.binaries = { claude: executable('claude'), codex: executable('codex'), python: pythonExecutable() };
    this.hooks = net.createServer(socket => {
      socket.setEncoding('utf8');
      socket.setTimeout(2000, () => socket.destroy()); let data = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        data += chunk.toString(); if (data.length > 2 * 1024 * 1024) return socket.destroy();
        const end = data.indexOf('\n'); if (end < 0) return;
        try { const event = JSON.parse(data.slice(0, end)); this.hookTargets.get(event.token)?.hook(event); } catch {}
        socket.end();
      });
    });
  }
  async start() { await new Promise((resolve, reject) => { this.hooks.once('error', reject); this.hooks.listen(this.hookSocket, resolve); }); fs.chmodSync(this.hookSocket, 0o600); await this.submissions.start(); }
  createCodex(operation) { const next = (this.creationQueue || Promise.resolve()).then(operation); this.creationQueue = next.catch(() => {}); return next; }
  async startCodex() {
    if (this.rpc) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.codexProcess = spawn(this.binaries.codex, ['-c', 'analytics.enabled=false', 'app-server', '--listen', `unix://${this.codexSocket}`], { stdio: ['ignore', 'ignore', 'pipe'], env: nativeEnvironment() });
      this.codexProcess.stderr.on('data', () => {});
      this.codexProcess.on('error', () => {});
      for (let i = 0; i < 100 && !fs.existsSync(this.codexSocket); i++) await delay(100);
      const ws = new WebSocket('ws://localhost', { createConnection: () => net.connect(this.codexSocket), maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000 });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      this.rpc = new Rpc(ws);
      this.rpc.on('event', message => {
        const p = message.params || {};
        if (message.method === 'thread/started' && !p.thread?.parentThreadId && this.pendingCodex) this.pendingCodex(p.thread);
        const target = this.codexTargets.get(p.threadId || p.thread?.id);
        if (target) target.event(message);
        else if (message.method === 'thread/started' && p.thread?.parentThreadId) this.codexTargets.get(p.thread.parentThreadId)?.emit('fleet', { id: p.thread.id, event: 'thread/started', name: p.thread.agentNickname || 'Codex 子 agent' });
      });
      this.rpc.on('closed', () => { for (const target of this.codexTargets.values()) target.emit('state', 'error'); });
      await this.rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    })();
    return this.starting;
  }
  create(record) {
    this.binaries = { claude: executable('claude'), codex: executable('codex'), python: pythonExecutable() };
    if (!this.binaries[record.provider] || !this.binaries.python) throw new Error('未找到原生 CLI 或 Python 3，请先安装并完成原生登录。');
    return record.provider === 'claude' ? new Claude(record, this) : new Codex(record, this);
  }
  close() { for (const target of this.hookTargets.values()) { target.submission?.close(); target.stop().catch(() => {}); } for (const target of this.codexTargets.values()) target.terminal?.stop().catch(() => {}); this.rpc?.ws.close(); this.codexProcess?.kill('SIGTERM'); this.hooks.close(); this.submissions.server.close(); }
}

module.exports = { NativeHost, Terminal, Claude, Codex, executable, delay };
