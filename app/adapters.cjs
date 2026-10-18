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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const { executable, nativeEnvironment } = require('./platform.cjs');

class Terminal extends EventEmitter {
  constructor(argv, cwd, env = {}) {
    super();
    this.pid = null; this.alive = true; this.sequence = 0;
    this.screen = new HeadlessTerminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    this.serialize = new SerializeAddon(); this.screen.loadAddon(this.serialize);
    this.decoder = new StringDecoder('utf8');
    this.worker = spawn(executable('python3'), [path.join(__dirname, 'pty_host.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: nativeEnvironment(env) });
    let lines = '';
    this.worker.stdout.setEncoding('utf8');
    this.worker.stdout.on('data', chunk => {
      lines += chunk;
      for (let at; (at = lines.indexOf('\n')) >= 0;) {
        const line = lines.slice(0, at); lines = lines.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'started') { this.pid = message.pid; this.emit('started', this.pid); }
        if (message.type === 'data') {
          const data = this.decoder.write(Buffer.from(message.data, 'base64'));
          this.screen.write(data, () => this.emit('data', { data, sequence: ++this.sequence }));
        }
      }
    });
    // Native diagnostics stay in the terminal; do not persist or upload stderr.
    this.worker.stderr.on('data', () => {});
    this.worker.on('error', () => { this.alive = false; this.emit('closed'); });
    this.worker.on('exit', () => { this.alive = false; this.emit('closed'); });
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
  stop() { if (this.alive) this.command({ type: 'stop' }); }
}

class Claude extends EventEmitter {
  constructor(record, host) {
    super(); this.record = record; this.host = host; this.pending = null; this.ready = false;
    this.token = crypto.randomBytes(32).toString('hex');
    host.hookTargets.set(this.token, this);
    const command = `${quote(executable('python3'))} ${quote(path.join(__dirname, 'claude_hook.py'))}`;
    const hooks = {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted', 'SessionEnd']) {
      hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 2 }] }];
    }
    const settings = path.join(host.privateDir, `${record.id}.settings.json`);
    fs.writeFileSync(settings, JSON.stringify({ teammateMode: 'in-process', hooks }), { mode: 0o600 });
    this.terminal = new Terminal([host.binaries.claude, '--session-id', record.nativeId, '--name', record.name, '--permission-mode', 'manual', '--prompt-suggestions', 'false', '--settings', settings], record.cwd, {
      NAW_HOOK_TOKEN: this.token, NAW_HOOK_SOCKET: host.hookSocket,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    });
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => this.emit('pid', pid));
    this.terminal.on('closed', () => { this.ready = false; this.emit('state', 'ended'); });
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
        this.emit('state', 'working');
        if (this.pending) this.emit('submitted', this.pending.tag);
        else this.emit('nativeInput', event.prompt || '原生输入');
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
        this.emit('complete', { tag: pending?.tag, text: event.last_assistant_message || '', background, scheduled, stopHookActive: Boolean(event.stop_hook_active) });
        break;
      }
      case 'StopFailure': this.pending = null; this.emit('state', 'error'); this.emit('failed', '原生请求未完成，请在原生终端查看。'); break;
      case 'SessionEnd': this.ready = false; this.emit('state', 'ended'); break;
    }
  }
  async send(text, tag, guard) {
    if (!this.ready || this.pending) throw new Error('Claude 尚未就绪，或上一条输入仍待确认。');
    if (!guard()) throw new Error('这条交接已撤销。');
    this.pending = { tag };
    this.terminal.input(`\x1b[200~${text}\x1b[201~`);
    await delay(80);
    if (!guard()) { this.pending = null; throw new Error('提交前已暂停；文字留在原生输入框，请检查后继续。'); }
    this.terminal.input('\r');
  }
  interrupt() { this.pending = null; this.terminal.input('\x1b'); }
  async openTerminal() { return this.terminal; }
  stop() { this.terminal.stop(); this.host.hookTargets.delete(this.token); }
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
  constructor(record, host) { super(); this.record = record; this.host = host; this.pending = null; this.turnId = null; this.terminal = null; this.last = ''; this.hasHistory = false; this.chatAvailable = record.view !== 'terminal'; this.stopped = false; }
  async start() {
    await this.host.startCodex();
    if (this.record.view === 'terminal') {
      this.host.createCodex(() => this.startFromTerminal()).catch(error => { this.emit('activity', error.message); this.emit('state', 'error'); });
      return;
    }
    await this.host.createCodex(async () => {
    const r = await this.host.rpc.call('thread/start', { cwd: this.record.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', ephemeral: false, experimentalRawEvents: false });
    this.record.nativeId = r.thread.id;
    this.host.codexTargets.set(this.record.nativeId, this);
    this.emit('model', r.model || r.thread.model || '原生默认');
    this.emit('pid', this.host.codexProcess.pid); this.emit('state', 'idle');
    });
  }
  async startFromTerminal() {
    if (this.stopped) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.host.pendingCodex = null; reject(new Error('原生初始化尚未确认，请查看终端。')); }, 120000);
      this.host.pendingCodex = thread => {
        clearTimeout(timeout); this.host.pendingCodex = null;
        this.record.nativeId = thread.id; this.host.codexTargets.set(thread.id, this);
        this.emit('model', thread.model || '原生默认'); this.emit('state', 'idle'); resolve();
        this.observeFirstTurn().catch(() => this.emit('activity', '原生终端可继续；对话连接未确认。'));
      };
      this.makeTerminal([this.host.binaries.codex, '-c', 'analytics.enabled=false', '--remote', `unix://${this.host.codexSocket}`, '-C', this.record.cwd, '-s', 'workspace-write', '-a', 'on-request']);
    });
  }
  async observeFirstTurn() {
    // An empty native thread cannot be resumed. Wait for a real user turn;
    // never spend a model call to manufacture history for an attachment.
    while (!this.stopped && !this.chatAvailable) {
      await delay(1000);
      const { thread } = await this.host.rpc.call('thread/read', { threadId: this.record.nativeId, includeTurns: false });
      const nativeState = thread.status?.type;
      this.emit('state', nativeState === 'active' ? 'working' : nativeState === 'idle' ? 'idle' : 'starting');
      if (!thread.preview || nativeState !== 'idle') continue;
      await this.host.rpc.call('thread/resume', { threadId: thread.id, excludeTurns: true });
      const items = await this.host.rpc.call('thread/items/list', { threadId: thread.id, limit: 100 });
      for (const entry of items.data || []) {
        const item = entry.item || entry;
        if (item.type === 'agentMessage') this.emit('messageItem', { id: item.id, text: item.text, phase: item.phase });
        if (item.type === 'userMessage') this.emit('nativeInput', (item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'));
      }
      this.chatAvailable = true; this.hasHistory = true; this.emit('state', 'idle');
    }
  }
  makeTerminal(argv) {
    this.terminal = new Terminal(argv, this.record.cwd);
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => this.emit('pid', pid));
    this.terminal.on('closed', () => this.emit('activity', '原生终端已退出；已连接的会话仍由运行服务管理。'));
    return this.terminal;
  }
  event(message) {
    const p = message.params || {};
    if (message.id !== undefined) { this.emit('approval', { requestId: message.id, method: message.method, params: p }); this.emit('state', 'approval'); return; }
    switch (message.method) {
      case 'turn/started': this.turnId = p.turn.id; this.last = ''; this.emit('state', 'working'); break;
      case 'item/agentMessage/delta': this.emit('delta', { id: p.itemId, text: p.delta }); break;
      case 'item/started':
        if (p.item?.type && !['agentMessage', 'userMessage', 'reasoning'].includes(p.item.type)) this.emit('activity', p.item.type);
        if (/collab|agent/i.test(p.item?.type || '') && p.item.type !== 'agentMessage') this.emit('fleet', { event: p.item.type, id: p.item.id, name: 'Codex 原生子 agent' });
        break;
      case 'item/completed':
        if (p.item?.type === 'agentMessage') { this.last = p.item.text || ''; this.emit('messageItem', { id: p.item.id, text: this.last, phase: p.item.phase }); }
        if (p.item?.type === 'userMessage' && !this.pending) this.emit('nativeInput', (p.item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'));
        break;
      case 'thread/tokenUsage/updated': this.emit('usage', p.tokenUsage); break;
      case 'turn/completed': {
        const pending = this.pending; this.pending = null; this.turnId = null; this.hasHistory = true;
        if (p.turn.status !== 'completed') { this.emit('state', 'idle'); this.emit('failed', '原生回合中断或失败；协作已暂停。'); }
        else { this.emit('state', 'idle'); this.emit('complete', { tag: pending?.tag, text: this.last, background: null, scheduled: null }); }
        break;
      }
      case 'error': this.emit('failed', '原生会话返回错误，请检查终端。'); break;
    }
  }
  async send(text, tag, guard) {
    if (!this.chatAvailable || this.pending || !guard()) throw new Error('会话忙碌、原生对话接口尚未连接，或交接已失效。');
    this.pending = { tag }; this.last = '';
    try {
      const r = await this.host.rpc.call('turn/start', { threadId: this.record.nativeId, input: [{ type: 'text', text, text_elements: [] }] });
      this.turnId = r.turn.id; this.emit('submitted', tag);
    } catch (error) { this.pending = null; throw error; }
  }
  async interrupt() {
    if (this.turnId) await this.host.rpc.call('turn/interrupt', { threadId: this.record.nativeId, turnId: this.turnId });
  }
  async openTerminal() {
    if (this.terminal?.alive) return this.terminal;
    if (!this.record.nativeId) { for (let i = 0; i < 100 && !this.terminal; i++) await delay(50); if (this.terminal) return this.terminal; }
    if (!this.hasHistory) throw new Error('请先完成一条对话，再打开同一会话的原生终端。');
    return this.makeTerminal([this.host.binaries.codex, '-c', 'analytics.enabled=false', 'resume', '--remote', `unix://${this.host.codexSocket}`, this.record.nativeId]);
  }
  stop() {
    this.stopped = true;
    this.terminal?.stop();
    if (this.turnId) this.interrupt().catch(() => {});
    this.host.codexTargets.delete(this.record.nativeId);
    // Unsubscribe unloads only this session; it does not terminate the shared server.
    this.host.rpc?.call('thread/unsubscribe', { threadId: this.record.nativeId }).catch(() => {});
    this.emit('state', 'ended');
  }
}

class NativeHost {
  constructor(privateDir) {
    this.privateDir = privateDir; this.hookSocket = path.join(privateDir, 'hooks.sock');
    this.codexSocket = path.join(privateDir, 'codex.sock'); this.hookTargets = new Map(); this.codexTargets = new Map();
    this.binaries = { claude: executable('claude'), codex: executable('codex'), python: executable('python3') };
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
  async start() { await new Promise((resolve, reject) => { this.hooks.once('error', reject); this.hooks.listen(this.hookSocket, resolve); }); fs.chmodSync(this.hookSocket, 0o600); }
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
    if (!this.binaries[record.provider] || !this.binaries.python) throw new Error('未找到原生 CLI 或 Python 3，请先安装并完成原生登录。');
    return record.provider === 'claude' ? new Claude(record, this) : new Codex(record, this);
  }
  close() { for (const target of this.hookTargets.values()) target.stop(); for (const target of this.codexTargets.values()) target.terminal?.stop(); this.rpc?.ws.close(); this.codexProcess?.kill('SIGTERM'); this.hooks.close(); }
}

module.exports = { NativeHost, Terminal, executable, delay };
