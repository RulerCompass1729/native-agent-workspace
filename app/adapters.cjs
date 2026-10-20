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
const { TerminalJournal } = require('./observation.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const { executable, pythonExecutable, nativeEnvironment } = require('./platform.cjs');

class Terminal extends EventEmitter {
  constructor(argv, cwd, env = {}) {
    super();
    this.pid = null; this.alive = true; this.sequence = 0; this.nativeExited = false;
    this.screen = new HeadlessTerminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    this.serialize = new SerializeAddon(); this.screen.loadAddon(this.serialize);
    this.journal = new TerminalJournal(this.screen.cols, this.screen.rows);
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
          const receivedAt = Date.now();
          this.screen.write(data, () => {
            const observation = this.journal.append('output', data, this.screen.cols, this.screen.rows, () => this.serialize.serialize());
            this.emit('data', { ...observation, receivedAt, sequence: ++this.sequence });
          });
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
    if (this.alive) this.screen.write('', () => {
      if (!this.alive || (cols === this.screen.cols && rows === this.screen.rows)) return;
      this.screen.resize(cols, rows); this.command({ type: 'resize', cols, rows });
      const observation = this.journal.append('resize', '', cols, rows, () => this.serialize.serialize());
      this.emit('data', { ...observation, sequence: this.sequence });
    });
  }
  snapshot() { return new Promise(resolve => this.screen.write('', () => resolve({ buffer: this.serialize.serialize(), sequence: this.sequence, cols: this.screen.cols, rows: this.screen.rows, pid: this.pid }))); }
  observe() { return new Promise(resolve => this.screen.write('', () => resolve({ ...this.journal.snapshot(), alive: this.alive }))); }
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
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted', 'SessionEnd']) {
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
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) this.emit('progress', {
      id: event.tool_use_id, source: 'claude-hook', kind: 'tool', title: event.tool_name || '原生工具',
      status: event.hook_event_name === 'PreToolUse' ? 'running' : event.hook_event_name === 'PostToolUse' ? 'completed' : 'failed',
    });
    if (['PermissionRequest', 'Notification', 'StopFailure'].includes(event.hook_event_name)) this.emit('progress', {
      source: 'claude-hook', kind: event.hook_event_name, title: event.hook_event_name === 'PermissionRequest' ? '等待原生权限确认' : event.hook_event_name === 'StopFailure' ? '原生请求失败' : '原生通知',
      text: event.message || '', status: event.hook_event_name === 'StopFailure' ? 'failed' : 'observed',
    });
    switch (event.hook_event_name) {
      case 'SessionStart': this.ready = true; this.emit('state', 'idle'); this.emit('model', event.model || '原生未报告'); break;
      case 'UserPromptSubmit':
        // A settings hook observing a prompt is not its acceptance. The native
        // structured submission result acknowledges our own sends separately.
        this.lastPromptId = event.prompt_id || null;
        if (this.pending && !this.pending.accepted && this.submission.pending?.authorized && event.prompt === this.pending.text) {
          this.pending.prompts.add(event.prompt_id || null);
        } else if (!this.pending || event.prompt !== this.pending.text || event.prompt_id !== this.pending.promptId) {
          this.pending = null; this.emit('state', 'working'); this.emit('nativeInput', event.prompt || '原生输入');
        }
        break;
      case 'PermissionRequest': this.pending = null; this.emit('state', 'approval'); break;
      case 'Notification':
        if (/permission|elicitation|auth/.test(event.notification_type || '')) { this.pending = null; this.emit('state', 'approval'); }
        break;
      case 'PreToolUse':
        if (this.pending) this.pending.replies.delete(event.prompt_id);
        this.emit('activity', event.tool_name || '原生工具'); this.emit('state', 'working'); break;
      case 'Stop': {
        const pending = this.pending;
        // Native IDs, not arrival time or matching text, select the reply.
        if (pending && !pending.accepted) {
          if (pending.replies.size < 8 && event.prompt_id) pending.replies.set(event.prompt_id, event);
          return;
        }
        if ((pending && event.prompt_id !== pending.promptId) ||
          (!pending && this.lastPromptId && event.prompt_id !== this.lastPromptId)) {
          if (event.last_assistant_message) this.emit('messageItem', { id: `claude-stop-${event.prompt_id || crypto.randomUUID()}`, text: event.last_assistant_message });
          return;
        }
        this.finishReply(pending, event);
        break;
      }
      case 'StopFailure': this.pending = null; this.emit('state', 'error'); this.emit('failed', '原生请求未完成，请在原生终端查看。'); break;
      case 'SessionEnd': this.pending = null; this.ready = false; this.emit('state', 'stopping'); break;
    }
  }
  finishReply(pending, event) {
        if (pending && this.pending !== pending) {
          if (event.last_assistant_message) this.emit('messageItem', { id: crypto.randomUUID(), text: event.last_assistant_message });
          return;
        }
        const accepted = pending?.accepted && pending.promptId && event.prompt_id === pending.promptId && this.pending === pending && pending.guard();
        if (this.pending === pending) this.pending = null;
        const background = Array.isArray(event.background_tasks) ? event.background_tasks.length : null;
        const scheduled = Array.isArray(event.session_crons) ? event.session_crons.length : null;
        this.emit('background', { count: background, scheduled });
        this.emit('state', 'idle');
        // Observed child hooks cannot certify that all descendants are idle.
        this.emit('complete', { tag: accepted ? pending.tag : undefined, text: event.last_assistant_message || '', background, scheduled, fleetPending: null, stopHookActive: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null });
  }
  async send(text, tag, guard) {
    if (!this.ready || this.pending) throw new Error('Claude 尚未就绪，或上一条输入仍待确认。');
    if (!guard()) throw new Error('这条交接已撤销。');
    const pending = this.pending = { tag, text, guard, accepted: false, promptId: null, prompts: new Set(), replies: new Map() };
    try {
      const receipt = await this.submission.request(text, tag, guard);
      pending.accepted = true;
      pending.promptId = receipt?.promptId || null;
      this.emit('submitted', tag);
      if (!pending.promptId || [...pending.prompts].some(id => id !== pending.promptId)) {
        if (this.pending === pending) {
          this.pending = null;
          this.emit('unattributed', tag);
          const observed = this.lastPromptId && pending.replies.get(this.lastPromptId);
          if (observed) this.finishReply(null, observed);
          else this.emit('state', 'working');
        }
        return;
      }
      if (pending.replies.has(pending.promptId)) this.finishReply(pending, pending.replies.get(pending.promptId));
      else if (this.pending === pending) this.emit('state', 'working');
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      throw error;
    }
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
        if (message.error) {
          const error = new Error(`原生接口拒绝请求（${message.error.code}），请查看原生会话。`);
          error.nativeMissingHistory = message.error.code === -32600 && /^no rollout found for thread id /.test(message.error.message || '');
          p.reject(error);
        } else p.resolve(message.result);
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
    super(); this.record = record; this.host = host; this.pending = null; this.turnId = null; this.terminal = null; this.turns = new Map(); this.ownInputs = new Set(); this.hasHistory = false; this.chatAvailable = !record.recovering && record.view !== 'terminal'; this.stopped = false; this.lifecycleRevision = 0; this.eventRevision = 0; this.stateRevision = 0; this.on('state', state => { this.latestState = state; this.stateRevision++; }); this.inputItems = new Set(); this.liveMessageItems = new Set(); this.historyMessageItems = new Set();
    if (record.recovering) this.recoveryReady = new Promise(resolve => { this.finishRecoveryConnection = resolve; });
  }
  async start() {
    this.recoveryNativeInputs = new Map(this.record.recovering
      ? (this.record.messages || []).filter(m => m.role === 'user' && m.origin === 'native').map(m => [m.id, m.text])
      : []);
    try { await this.host.startCodex(); }
    catch (error) { this.finishRecoveryConnection?.(false); throw error; }
    const rpc = this.host.rpc, child = this.host.codexProcess;
    const current = () => !this.stopped && this.host.rpc === rpc && this.host.codexProcess === child;
    if (!current()) throw new Error('原生后台已变化，没有继续旧的启动请求。');
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
        result = await rpc.call('thread/resume', { threadId: this.record.nativeId, cwd: this.record.cwd, excludeTurns: true });
        if (this.stopped) { this.finishRecoveryConnection?.(false); return; }
        if (!current()) throw new Error('原生后台已变化，没有继续旧的恢复请求。');
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
    if (!current()) throw new Error('原生后台已变化，没有继续旧的启动请求。');
    // Let native configuration/requirements choose permissions for this cwd.
    const r = await rpc.call('thread/start', { cwd: this.record.cwd, ephemeral: false, experimentalRawEvents: false });
    if (!current()) throw new Error('原生后台已变化，没有接管旧的启动结果。');
    this.record.nativeId = r.thread.id;
    this.host.codexTargets.set(this.record.nativeId, this);
    this.emit('model', r.model || r.thread.model || '原生默认');
    this.emit('pid', this.host.codexProcess.pid); this.emit('state', 'idle');
    });
  }
  async startFromTerminal() {
    if (this.stopped) return;
    const rpc = this.host.rpc, child = this.host.codexProcess;
    await new Promise((resolve, reject) => {
      // Login/trust is a human decision, not a timed model request. Keep the
      // creation slot until that terminal starts a thread or actually exits.
      const timeout = setTimeout(() => this.emit('activity', '等待原生登录或文件夹确认，请在终端继续。'), 120000);
      const cleanup = () => {
        clearTimeout(timeout);
        if (this.host.pendingCodex === started) this.host.pendingCodex = null;
        if (this.host.pendingCodexRuntime === this) this.host.pendingCodexRuntime = null;
        this.terminal?.off('closed', closed);
      };
      const closed = () => { cleanup(); reject(new Error('原生初始化已退出；未发送模型任务。')); };
      const started = thread => {
        cleanup();
        if (this.stopped || rpc !== this.host.rpc || child !== this.host.codexProcess) {
          reject(new Error('原生后台已变化，没有接管旧的启动结果。')); return;
        }
        this.record.nativeId = thread.id; this.host.codexTargets.set(thread.id, this);
        this.emit('activity', ''); this.emit('model', thread.model || '原生默认'); this.emit('state', 'idle'); resolve();
        this.observing = this.observeFirstTurn().catch(() => { if (!this.stopped) this.emit('activity', '原生终端可继续；对话连接未确认。'); });
      };
      this.host.pendingCodex = started;
      this.host.pendingCodexRuntime = this;
      try {
        this.makeTerminal([this.host.codexBinary || this.host.binaries.codex, '-c', 'analytics.enabled=false', '--remote', `unix://${this.host.codexSocket}`, '-C', this.record.cwd]).once('closed', closed);
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
  async hydrateHistory(threadId, lifecycle = this.lifecycleRevision) {
    // Read all pages before committing a history snapshot. Live input/approval
    // still takes effect immediately; history itself must never take control.
    const items = new Map(), cursors = new Set(); let cursor;
    for (let page = 0; page < 1000; page++) {
      if (this.stopped || lifecycle !== this.lifecycleRevision) return false;
      const result = await this.host.rpc.call('thread/items/list', { threadId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      if (this.stopped || lifecycle !== this.lifecycleRevision) return false;
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
    this.terminal.on('closed', () => this.emit('activity', this.backendExitConfirmed
      ? '原生后台已退出；记录和草稿保留，任务不会自动重发。'
      : '原生终端已退出；已连接的会话仍由运行服务管理。'));
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
    if (['item/started', 'item/completed'].includes(message.method) && p.item?.type && !['agentMessage', 'userMessage', 'reasoning'].includes(p.item.type)) {
      const item = p.item;
      this.emit('progress', { id: item.id, turnId: p.turnId, source: 'codex-native', kind: item.type,
        title: item.command || item.tool || item.type, status: message.method === 'item/started' ? 'running' : item.status || 'completed',
        ...(typeof item.aggregatedOutput === 'string' ? { text: item.aggregatedOutput } : {}),
      });
    }
    if (['item/commandExecution/outputDelta', 'item/mcpToolCall/progress'].includes(message.method)) this.emit('progress', {
      id: p.itemId, turnId: p.turnId, source: 'codex-native', kind: message.method === 'item/commandExecution/outputDelta' ? 'commandExecution' : 'mcpToolCall',
      ...(typeof p.delta === 'string' ? { delta: p.delta } : { text: p.message || '' }),
    });
    if (message.id !== undefined || message.method === 'error') this.emit('progress', { source: 'codex-native', kind: message.method, title: message.id !== undefined ? '等待原生确认' : '原生会话错误', status: message.id !== undefined ? 'waiting' : 'failed' });
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
        if (/collab|agent/i.test(p.item?.type || '') && p.item.type !== 'agentMessage') {
          const item = p.item;
          this.emit('fleet', { event: item.type, id: item.id, name: item.agentPath || 'Codex 原生子 agent', kind: item.kind, tool: item.tool,
            nativeId: item.agentThreadId, model: item.model,
            active: (item.type === 'subAgentActivity' && ['started', 'interacted'].includes(item.kind)) ||
              (item.type === 'collabAgentToolCall' && ['spawnAgent', 'sendInput', 'resumeAgent', 'sendMessage', 'followupTask'].includes(item.tool)) });
        }
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
    const lifecycle = this.lifecycleRevision, revision = this.stateRevision;
    try {
      const r = await this.host.rpc.call('turn/start', { threadId: this.record.nativeId, clientUserMessageId: tag, input: [{ type: 'text', text, text_elements: [] }] });
      if (lifecycle !== this.lifecycleRevision || this.stopped) { this.emit('submitted', tag); return; }
      pending.turnId = r.turn.id;
      if (!this.turnId) this.turnId = r.turn.id;
      if (revision === this.stateRevision) this.emit('state', 'working');
      this.emit('submitted', tag);
      for (const id of this.turns.keys()) this.finishTurn(id);
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      if (lifecycle === this.lifecycleRevision) for (const id of this.turns.keys()) this.finishTurn(id);
      throw error;
    }
    if (this.needsSubscription) {
      try { await this.observeAcceptedTurn(pending.turnId); }
      catch {
        // The native ACK already accepted this one turn. An observation error
        // must never be returned as a send failure that invites a paid retry.
        if (lifecycle === this.lifecycleRevision && !this.stopped) {
          this.emit('state', 'error');
          this.emit('failed', '消息已被原生接受，但后续状态尚未同步；请核对原生终端，不要重发。');
        }
      }
    }
    return pending.turnId;
  }
  async observeAcceptedTurn(turnId) {
    if (this.stopped || !turnId) throw Error('原生观察连接已变化。');
    const revision = this.stateRevision, lifecycle = this.lifecycleRevision;
    const result = await this.host.rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true });
    if (this.stopped || lifecycle !== this.lifecycleRevision || result.thread?.id !== this.record.nativeId) throw Error('原生观察连接已变化。');
    this.needsSubscription = false; this.hasHistory = true;
    if (revision === this.stateRevision && this.latestState !== 'approval') this.observeStatus(result.thread.status);
    const page = await this.host.rpc.call('thread/turns/list', { threadId: this.record.nativeId, limit: 20, itemsView: 'full' });
    if (this.stopped || lifecycle !== this.lifecycleRevision) throw Error('原生观察连接已变化。');
    const turn = page.data?.find(t => t.id === turnId);
    // A live completion may have already finished this exact accepted input.
    // Re-subscribe, but never replay that reply as a second unowned completion.
    if (turn && turn.status !== 'inProgress' && this.pending?.turnId === turnId) {
      for (const item of turn.items || []) this.event({ method: 'item/completed', params: { threadId: this.record.nativeId, turnId, item } });
      this.event({ method: 'turn/completed', params: { threadId: this.record.nativeId, turn } });
    }
  }
  backendExited() {
    this.backendExitConfirmed = true;
    this.stopped = true; this.chatAvailable = false; this.lifecycleRevision++;
    this.finishRecoveryConnection?.(false);
    if (this.retiringTerminal) return this.retiringTerminal;
    this.emit('activity', '原生后台已退出；记录和草稿保留，任务不会自动重发。');
    this.emit('state', 'error');
    this.retiringTerminal = Promise.resolve().then(async () => {
      // This is only the remote display client owned by this runtime. Never
      // signal native workers, descendants or another server during recovery.
      if (this.terminal) await this.terminal.stop();
      this.emit('state', this.record.nativeId ? 'recoverable' : 'ended');
      return { state: this.record.nativeId ? 'recoverable' : 'ended' };
    }).catch(error => {
      this.emit('activity', '后台已退出，但终端进程退出尚未确认；请检查原生终端后重试断开。');
      throw error;
    }).finally(() => { this.retiringTerminal = null; });
    return this.retiringTerminal;
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
    return this.makeTerminal([this.host.codexBinary || this.host.binaries.codex, '-c', 'analytics.enabled=false', 'resume', '--remote', `unix://${this.host.codexSocket}`, this.record.nativeId]);
  }
  async reconnect() {
    if (!this.stopped || this.closed || !this.record.nativeId) throw new Error('原生连接状态已改变，请重新查看。');
    const lifecycle = ++this.lifecycleRevision;
    const current = () => lifecycle === this.lifecycleRevision && !this.stopped;
    // Re-subscribe to the owned thread. Omit every configuration override:
    // thread/resume is not a new thread or a turn/start request.
    this.chatAvailable = false; this.stopped = false;
    this.pending = null; this.turnId = null; this.turns.clear();
    this.liveMessageItems.clear();
    for (const message of this.record.messages || []) {
      if (message.role === 'assistant') this.historyMessageItems.add(message.id);
    }
    this.host.codexTargets.set(this.record.nativeId, this);
    const revision = this.stateRevision;
    try {
      let result;
      try { result = await this.host.rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true }); }
      catch (error) {
        if (!error.nativeMissingHistory || this.hasHistory || this.record.messages?.length || !current()) throw error;
        // Native creates its rollout on the first actual input. Confirm the
        // owned empty thread is still live; no synthetic turn to make history.
        const { thread } = await this.host.rpc.call('thread/read', { threadId: this.record.nativeId, includeTurns: false });
        if (!current() || thread?.id !== this.record.nativeId || thread.preview || thread.status?.type !== 'idle') throw error;
        this.needsSubscription = true; this.chatAvailable = true;
        if (revision === this.stateRevision) this.observeStatus(thread.status);
        this.emit('capability');
        return;
      }
      if (result.thread?.id !== this.record.nativeId) throw new Error('原生返回了不同的会话，恢复未确认。');
      if (!current()) throw new Error('原生连接已经关闭；没有重发任务。');
      this.hasHistory = true; this.needsSubscription = false;
      this.emit('pid', this.host.codexProcess.pid);
      if (result.model || result.thread.model) this.emit('model', result.model || result.thread.model);
      if (revision === this.stateRevision) this.observeStatus(result.thread.status);
      if (!await this.hydrateHistory(this.record.nativeId, lifecycle) || !current()) throw new Error('连接在同步记录时断开；没有重发任务。');
      this.chatAvailable = true; this.emit('capability');
    } catch (error) {
      if (lifecycle === this.lifecycleRevision) {
        this.chatAvailable = false; this.stopped = true;
        if (!this.closed) this.emit('state', 'disconnected');
      }
      throw error;
    }
    // A terminal is a view on this same thread. A failure to open that view
    // must not undo a confirmed subscription or disable graphical input.
    if (this.record.view === 'terminal') {
      try { await this.openTerminal(); }
      catch { this.emit('activity', '原会话已连接；原生终端未能打开，可切到对话继续或重试终端。'); }
    }
  }
  async stop() {
    if (this.backendExitConfirmed) return this.backendExited();
    ++this.lifecycleRevision;
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
  createCodex(operation) {
    const rpc = this.rpc, child = this.codexProcess;
    const next = (this.creationQueue || Promise.resolve()).then(() => {
      if (this.closed || rpc !== this.rpc || child !== this.codexProcess) throw new Error('原生后台已变化，没有继续旧的启动队列。');
      return operation();
    });
    this.creationQueue = next.catch(() => {}); return next;
  }
  async startCodex() {
    if (this.closed) throw new Error('原生服务已关闭。');
    if (this.rpc) return;
    if (this.starting) return this.starting;
    this.starting = Promise.resolve().then(async () => {
      let ws, rpc, child, spawnError;
      try {
      // A stale socket may remain after a crash. Never remove an endpoint that
      // still answers, or turn an uncertain connection into a second server.
      let entry;
      try { entry = fs.lstatSync(this.codexSocket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entry) {
        if (entry.uid !== process.getuid() || (!entry.isSocket() && !entry.isSymbolicLink())) throw new Error('原生接口身份未确认，没有启动重复后台。');
        const absent = await new Promise(resolve => {
          const socket = net.connect(this.codexSocket);
          const finish = value => { socket.destroy(); resolve(value); };
          socket.once('connect', () => finish(false));
          socket.once('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code)));
          socket.setTimeout(1000, () => finish(false));
        });
        if (!absent) throw new Error('原生接口仍在运行或无法确认；没有启动重复后台。');
        try {
          const now = fs.lstatSync(this.codexSocket);
          if (now.dev !== entry.dev || now.ino !== entry.ino) throw new Error('原生接口已变化，没有启动重复后台。');
          fs.unlinkSync(this.codexSocket);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.codexBinary = this.binaries.codex;
      child = this.codexProcess = spawn(this.codexBinary, ['-c', 'analytics.enabled=false', 'app-server', '--listen', `unix://${this.codexSocket}`], { stdio: ['ignore', 'ignore', 'pipe'], env: nativeEnvironment() });
      child.stderr.on('data', () => {});
      child.on('error', error => { spawnError = error; });
      for (let i = 0; i < 100 && !fs.existsSync(this.codexSocket); i++) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('Codex 后台未能启动，请在设置中检查所选程序。');
        await delay(100);
      }
      ws = new WebSocket('ws://localhost', { createConnection: () => net.connect(this.codexSocket), maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000 });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      rpc = new Rpc(ws);
      let initialized = false, retired = false;
      const retire = () => {
        if (!initialized || retired || this.closed || this.codexProcess !== child
          || (child.exitCode === null && child.signalCode === null) || ws.readyState !== WebSocket.CLOSED) return;
        retired = true; this.rpc = null; this.starting = null; this.codexProcess = null; this.codexBinary = null;
        const targets = new Set(this.codexTargets.values());
        if (this.pendingCodexRuntime) targets.add(this.pendingCodexRuntime);
        this.codexTargets.clear();
        for (const target of targets) target.backendExited().catch(() => {});
      };
      child.once('exit', retire);
      rpc.on('event', message => {
        if (retired || this.closed || this.codexProcess !== child) return;
        const p = message.params || {};
        if (message.method === 'thread/started' && !p.thread?.parentThreadId && this.pendingCodex) this.pendingCodex(p.thread);
        const target = this.codexTargets.get(p.threadId || p.thread?.id);
        if (target) target.event(message);
        else if (message.method === 'thread/started' && p.thread?.parentThreadId) this.codexTargets.get(p.thread.parentThreadId)?.emit('fleet', { id: p.thread.id, event: 'thread/started', name: p.thread.agentNickname || 'Codex 子 agent' });
      });
      rpc.on('closed', () => {
        if (retired || this.closed || this.codexProcess !== child || (this.rpc && this.rpc !== rpc)) return;
        for (const target of this.codexTargets.values()) target.emit('state', 'error');
        retire();
      });
      await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      this.rpc = rpc; initialized = true; retire();
      } catch (error) {
        ws?.terminate();
        // Only this unsuccessful startup's child can be terminated. No thread
        // has been exposed yet; an existing live server never enters this path.
        const exited = () => !child || (!child.pid && spawnError) || child.exitCode !== null || child.signalCode !== null;
        if (!exited()) {
          child.kill('SIGTERM');
          for (let i = 0; i < 20 && !exited(); i++) await delay(50);
        }
        if (exited()) {
          this.codexProcess = null; this.codexBinary = null; this.starting = null;
          // Leave the endpoint for the next validated probe. A failed spawn
          // does not prove ownership of a listener that appeared meanwhile.
        }
        // If exit cannot be confirmed, retain the failed lease and block reuse.
        throw error;
      }
    });
    return this.starting;
  }
  create(record) {
    this.binaries = { claude: executable('claude'), codex: executable('codex'), python: pythonExecutable() };
    if (!this.binaries[record.provider] || !this.binaries.python) throw new Error('未找到原生 CLI 或 Python 3，请先安装并完成原生登录。');
    if (record.provider === 'codex' && this.codexBinary && this.codexBinary !== this.binaries.codex) throw new Error('Codex 位置已修改，现有后台继续使用原程序。请恢复原位置，或结束原生会话并完全退出后台后再使用新位置。');
    return record.provider === 'claude' ? new Claude(record, this) : new Codex(record, this);
  }
  close() { this.closed = true; for (const target of this.hookTargets.values()) { target.submission?.close(); target.stop().catch(() => {}); } for (const target of this.codexTargets.values()) target.terminal?.stop().catch(() => {}); this.rpc?.ws.close(); this.codexProcess?.kill('SIGTERM'); this.hooks.close(); this.submissions.server.close(); }
}

module.exports = { NativeHost, Terminal, Claude, Codex, Rpc, executable, delay };
