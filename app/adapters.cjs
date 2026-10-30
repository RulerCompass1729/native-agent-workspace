const { claudeUsage } = require('./native-usage.js');
const { EventEmitter } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { CODEX_WEBSOCKET_MAX_PAYLOAD } = require('./codex-terminal-bridge.cjs');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { SubmissionChannel, createSubmissionServer } = require('./claude-submit.cjs');
const { TerminalJournal } = require('./observation.cjs');
const { serverVersion, verifiedCodexProtocol } = require('./native-history.cjs');
const { toolContent, toolStatus, toolTypes, fileChanges, nativeTextContent, nativeTextItemId } = require('./codex-tool-content.cjs');
const { codexTurnBlock } = require('./native-blocks.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const { executable, pythonExecutable, nativeEnvironment } = require('./platform.cjs');

class Terminal extends EventEmitter {
  constructor(argv, cwd, env = {}) {
    super();
    this.pid = null; this.alive = true; this.sequence = 0; this.nativeExited = false;
    this.screen = new HeadlessTerminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    this.keyboardModes = require('./terminal-keyboard.cjs').trackKeyboardModes(this.screen);
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
            this.emit('data', { ...observation, receivedAt, sequence: ++this.sequence, keyboardFlags: this.keyboardModes.flags });
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
  snapshot() { return new Promise(resolve => this.screen.write('', () => resolve({ buffer: this.serialize.serialize(), sequence: this.sequence, epoch: this.journal.epoch, cols: this.screen.cols, rows: this.screen.rows, pid: this.pid, keyboardFlags: this.keyboardModes.flags }))); }
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

// Native root transitions the GUI follows: SessionEnd reason -> SessionStart source
// of the same process. /clear ends with 'clear'; /branch ends with 'resume' and
// starts the branch as 'fork'. A plain /resume starts as 'resume' and is not followed.
// Claude Code's PermissionMode values and effort levels, as hook inputs report them.
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOLLOWED_ROOT_TRANSITIONS = { clear: 'clear', resume: 'fork' };
// Claude's generated title is native metadata with no API: scan a bounded
// transcript tail and extract the newest matching ai-title row.
function claudeGeneratedTitle(file, nativeId) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== `${nativeId}.jsonl`) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 262144), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'ai-title' && row.sessionId === nativeId && typeof row.aiTitle === 'string') return row.aiTitle.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) || null;
      } catch { /* a torn first line */ }
    }
  } catch { /* no transcript yet */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
// Correlate the ordered failure UUID with native's typed HTTP status, never
// the error prose. Reuse the bounded journal read used for native titles.
function claudeOverloaded(file, nativeId, messageId) {
  if (!/^[a-f0-9-]{36}$/i.test(messageId || '') || typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== `${nativeId}.jsonl`) return false;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid()) return false;
    const length = Math.min(stat.size, 262144), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      if (!line.includes(messageId)) continue;
      try {
        const row = JSON.parse(line);
        if (row.uuid !== messageId) continue;
        return row.type === 'assistant' && row.sessionId === nativeId && row.isSidechain === false &&
          row.isApiErrorMessage === true && row.message?.model === '<synthetic>' && row.apiErrorStatus === 529;
      } catch { /* torn line: no authority to retry */ }
    }
  } catch (error) { return error.code === 'ENOENT' ? null : false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null; // Native may flush the identified row just after its hooks.
}
// A running claude process whose arguments name this native session ID.
function claudeHolder(nativeId, strict = false) {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId || '')) return null;
  // Without ps the check cannot run; recovery then proceeds as it did before.
  let lines; try { lines = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 }).split('\n'); } catch {
    if (strict) { const error = Error('无法核对原生进程，没有接管。请稍后重试。'); error.nativeImportRefused = true; throw error; }
    return null;
  }
  for (const line of lines) {
    const [pid, ...args] = line.trim().split(/\s+/);
    if (Number(pid) !== process.pid && args.some(arg => path.basename(arg) === 'claude') && args.some(arg => [nativeId.toLowerCase(), '--resume=' + nativeId.toLowerCase(), '--session-id=' + nativeId.toLowerCase(), '-r' + nativeId.toLowerCase()].includes(arg.toLowerCase()))) return Number(pid);
  }
  return null;
}
function claudeImportAvailable(record, host) {
  let rows;
  try {
    rows = JSON.parse(execFileSync(host.binaries.claude, ['agents', '--json'], { env: nativeEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!Array.isArray(rows) || rows.length > 1000 || rows.some(row => !row || !['interactive', 'background'].includes(row.kind) || (row.sessionId !== undefined && (typeof row.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.sessionId))))) throw Error('Unknown native identity');
  } catch {
    const error = Error('无法核对 Claude 后台会话，没有接管。请先在原生界面确认并退出原连接。'); error.nativeImportRefused = true; throw error;
  }
  if (rows.some(row => row.sessionId?.toLowerCase() === record.nativeId.toLowerCase())) {
    const error = Error('Claude 仍报告这个会话有活动连接或后台工作。请先在那里退出；这里不会自动 attach 或停止它。'); error.nativeActiveWriter = true; throw error;
  }
}
class Claude extends EventEmitter {
  get turnId() { return this.liveTurn?.id || null; }
  get nativeActivity() {
    if (!this.liveTurn || this.rootEnding || this.disposed || !this.terminal?.alive) return null;
    return { nativeId: this.record.nativeId, turnId: this.liveTurn.id, label: this.livePermissions?.size ? [...this.livePermissions.values()].map(r => r.title).join(', ') : this.liveTurn.label, phase: this.livePermissions?.size ? 'approval' : this.liveTurn.phase, observedAt: this.observationSeenAt };
  }
  // A native AskUserQuestion held for the chat view (see the --ask hook). Only the
  // root's own questions; the workspace decides, and any doubt lets native ask.
  ask(event, reply, open, onClose = () => {}) {
    const questions = event.questions;
    const valid = Array.isArray(questions) && questions.length >= 1 && questions.length <= 4 && questions.every(q => q && typeof q.question === 'string' && q.question.length <= 16000 &&
      Array.isArray(q.options) && q.options.length >= 1 && q.options.length <= 10 && q.options.every(o => o && typeof o.label === 'string' && o.label.length <= 16000));
    if (!valid || event.agent_id || event.session_id !== this.record.nativeId || this.rootEnding || this.disposed || !this.terminal?.alive || !this.listenerCount('askQuestion')) return reply({});
    this.emit('askQuestion', { questions: questions.map(q => ({ question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: q.multiSelect === true,
      options: q.options.map(o => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })) })), reply, open, onClose });
  }
  get nativeApproval() {
    if (this.rootEnding || this.disposed || !this.terminal?.alive || !this.livePermissions?.size) return null;
    return { nativeOnly: true, observedAt: this.observationSeenAt, requests: [...this.livePermissions.values()].map(request => ({ ...request })) };
  }
  constructor(record, host, { attachOnly = false } = {}) {
    super(); this.record = record; this.host = host; this.pending = null; this.ready = false; this.chatAvailable = false;
    this.submission = new SubmissionChannel();
    this.submission.on('change', () => {
      this.chatAvailable = this.submission.connected;
      if (!this.chatAvailable && this.rootTurn?.status === 'error') this.rootTurn = null;
      this.emit('capability');
    });
    this.token = crypto.randomBytes(32).toString('hex');
    // A retained reader uses these same native validators and channel, but
    // cannot write settings, register command hooks or launch another CLI.
    if (attachOnly) return;
    // Native has no lock: a second --resume writes the same transcript. Refuse
    // while another claude process (e.g. an external terminal) names this ID.
    const holder = record.recovering && claudeHolder(record.nativeId, record.externalHistory === true);
    if (holder) { const error = Error(`另一个 claude 进程（PID ${holder}）引用了这个原生会话，可能正在写入。请先在那里退出，避免两个程序同时写同一会话。`); error.nativeActiveWriter = true; throw error; }
    if (record.recovering && record.externalHistory) claudeImportAvailable(record, host);
    host.hookTargets.set(this.token, this);
    const command = `${quote(pythonExecutable())} ${quote(path.join(__dirname, 'claude_hook.py'))}`;
    const hooks = {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted', 'SessionEnd']) {
      hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 2 }] }];
    }
    // A question may be answered in the chat view before the native dialog opens.
    // The hook waits for that answer; anything else lets native ask as usual.
    hooks.PreToolUse.push({ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `${command} --ask`, timeout: 3600 }] });
    const settings = path.join(host.privateDir, `${record.id}.settings.json`);
    // Automatic session recap and prompt suggestions are background model requests
    // the person did not ask for; /recap stays available on request.
    fs.writeFileSync(settings, JSON.stringify({ teammateMode: 'in-process', awaySummaryEnabled: false, promptSuggestionEnabled: false, hooks }), { mode: 0o600 });
    const mcp = JSON.stringify({ mcpServers: { native_workspace: { command: process.execPath,
      args: ['--disable-sigusr1', path.join(__dirname, 'claude-message-tool.cjs')], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
    // Native --resume restores the saved model and every permission mode except
    // bypassPermissions, but resolves effort from settings again. Re-pass only
    // those two, as this session's own last native reports had them.
    // A new session starts in bypass only when the person chose it at creation;
    // later launches follow what the session last reported.
    const posture = !record.recovering ? (record.skipPermissions ? ['--permission-mode', 'bypassPermissions'] : []) : [
      ...(record.nativePermissionMode === 'bypassPermissions' ? ['--permission-mode', 'bypassPermissions'] : []),
      ...(EFFORT_LEVELS.includes(record.nativeEffort) ? ['--effort', record.nativeEffort] : [])];
    // A picker branch opens the native session picker once and forks the chosen
    // session into this row's pre-assigned ID; recovery always resumes that ID.
    const identity = record.recovering ? ['--resume', record.nativeId]
      : record.forkPicker ? ['--resume', '--fork-session', '--session-id', record.nativeId] : ['--session-id', record.nativeId];
    this.terminal = new Terminal([host.binaries.claude, ...identity, ...(record.autoName ? [] : ['--name', record.name]), '--prompt-suggestions', 'false', '--settings', settings, '--mcp-config', mcp, '--allowedTools', 'mcp__native_workspace__workspace_message', '--plugin-dir', path.join(__dirname, 'claude-bridge'), ...posture], record.cwd, {
      NAW_HOOK_TOKEN: this.token, NAW_HOOK_SOCKET: host.hookSocket, NAW_SUBMIT_SOCKET: host.submitSocket,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    });
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => this.emit('pid', pid));
    this.terminal.on('closed', result => this.terminalClosed(result));
  }
  terminalClosed(result) {
    this.cancelNativeAbort(); this.ready = false; this.submission.close();
    if (!result.confirmed) { this.emit('activity', '终端连接断开，原生进程退出未确认。'); this.emit('state', 'error'); return; }
    // Native /background ends this root like /exit, then its daemon starts the
    // conversation under a new ID with this record's hook token. Briefly keep
    // the token routed so that start can arrive; otherwise this is a plain exit.
    if ((this.rootEnding?.reason === 'prompt_input_exit' || this.switchedEnding === 'prompt_input_exit') && !this.backgroundTo) {
      this.closedAwaitingBackground = setTimeout(() => this.finishClose(), this.backgroundHandoffMs ?? 3000);
      return;
    }
    this.finishClose();
  }
  finishClose() {
    clearTimeout(this.closedAwaitingBackground); this.closedAwaitingBackground = null;
    this.host.hookTargets.delete(this.token);
    if (this.backgroundTo) {
      this.emit('background', { nativeId: this.record.nativeId, backgroundId: this.backgroundTo });
      this.emit('state', 'background');
    } else {
      if (this.switchedTo) this.emit('activity', `原生终端已退出；它切换到的会话 ${this.switchedTo.slice(0, 8)} 是否在别处继续无法确认。`);
      else if (this.record.forkPicker) this.emit('activity', '未选择会话，没有创建分支。');
      this.emit('state', 'ended');
    }
  }
  bindRoot(message) {
    if (message.sessionId !== this.record.nativeId || this.rootEnding || !this.terminal?.alive) throw Error('Root unavailable');
    this.cancelNativeAbort?.();
    if (this.rootLease) this.submission?.close?.(); // Reload retires uncertain receipts, never the native task.
    // This credential stays in the root mod's memory. A child inheriting the
    // environment token cannot bind its different engine session identity.
    this.rootLease ||= crypto.randomBytes(32).toString('hex');
    // Reload can leave old unabortable HTTP observations in flight. Retire that
    // observer independently of the native submission/control credential.
    if (this.observationEpoch) this.observeRootGap({ sessionId: message.sessionId, lease: this.rootLease, epoch: this.observationEpoch });
    this.observationEpoch = crypto.randomBytes(16).toString('hex');
    this.rootObservation = null; this.rootTurn = null; this.liveTurn = null; this.livePermissions = new Map(); this.observationSeenAt = Date.now();
    this.nativeBlocks = message.nativeBlocks === true;
    this.nativeMedia = this.nativeBlocks && message.nativeMedia === true;
    this.nativeQueue = message.nativeQueue === true;
    // Managed input needs both the accepted-row display and boundary-only hook
    // path. Old retained queues lack an attachment-to-app identity link.
    this.nativePromptInput = this.nativeBlocks && message.nativeInlineInput === true && message.nativePromptInput === true && !this.retainedReader;
    this.nativeInlineInput = this.nativeBlocks && message.nativeInlineInput === true && (this.retainedReader ? !this.nativeQueue : this.nativePromptInput);
    this.nativeAbortAvailable = message.nativeAbort === true && !this.retainedReader;
    this.addressedSendAvailable = this.nativeBlocks && message.addressedTool === true && !this.retainedReader;
    this.nativeSharedDisplay = this.retainedReader && message.nativeSharedDisplay === true;
    this.displayProofs = new Map(); this.displayGap = false;
    return { lease: this.rootLease, observationEpoch: this.observationEpoch, nativeBlocks: this.nativeBlocks, nativeInlineInput: this.nativeInlineInput, nativePromptInput: this.nativePromptInput, nativeMedia: this.nativeMedia };
  }
  validRootBinding(message) {
    return Boolean(this.rootLease && !this.rootEnding && message.lease === this.rootLease && message.sessionId === this.record.nativeId);
  }
  observeRoot(message) {
    if (message.block === true) return this.observeBlock(message);
    if (!this.validRootBinding(message) || !this.observationEpoch || message.epoch !== this.observationEpoch || !/^[a-f0-9-]{36}(?::\d{1,5})?$/i.test(message.id || '') ||
      !['response', 'tool-output'].includes(message.kind) || typeof message.text !== 'string' || message.text.length > 12000 ||
      !Number.isSafeInteger(message.sequence) || message.sequence < 1) throw Error('Invalid native observation');
    const previous = this.rootObservation?.lease === message.lease ? this.rootObservation.sequence : 0;
    // A timed-out request can arrive after a newer one. Never present that old
    // text as the latest native state; the gap remains visible instead.
    if (message.sequence <= previous) throw Error('Stale native observation');
    this.rootObservation = { lease: message.lease, sequence: message.sequence };
    if (!message.replayed) this.observationSeenAt = Date.now();
    if (message.gap === true) this.observeRootGap(message);
    const tool = typeof message.title === 'string' ? message.title.slice(0, 200) : '';
    this.emit('progress', { id: `claude-row-${message.id}`, source: 'claude-native-message', kind: message.kind,
      status: 'observed', title: message.kind === 'response' ? '原生回复' : `${tool || '工具'} · 原生输出`,
      text: message.text + (message.nonText === true ? '\n含非文本结果，请在原生终端查看。' : ''), truncated: message.truncated === true });
    return { observed: true };
  }
  observeBlock(message) {
    if (message.mediaOnly === true) {
      const row = this.record.messages?.find(m => m.id === `native:${this.record.nativeId}:${message.id}`);
      if (!this.nativeMedia || !this.validRootBinding(message) || message.epoch !== this.observationEpoch ||
        !row || row.kind !== message.kind || !['tool', 'input'].includes(row.kind) || !['complete', 'submitted'].includes(row.status) ||
        message.status !== 'complete' || !require('./native-images.cjs').validImagePayload(message.imagePayload) ||
        Object.keys(message).some(key => !['id', 'kind', 'status', 'mediaOnly', 'imagePayload', 'block', 'sessionId', 'lease', 'epoch', 'sequence', 'gap', 'replayed'].includes(key))) throw Error('Invalid native media');
      // Media can enrich only an already accepted original. Derive all text
      // and attribution from that row, never from the metadata frame.
      message = { ...message, text: row.text, title: row.title, turnId: row.turnId,
        inputMode: row.inputMode, ...(row.kind === 'input' && !row.inputMode && row.inputTag ? { inputTag: row.inputTag } : {}) };
    } else if (message.imagePayload !== undefined) throw Error('Invalid native media');
    if (message.imageCount !== undefined && (!this.nativeMedia || !Number.isSafeInteger(message.imageCount) || message.imageCount < 1 || message.imageCount > 17 ||
      !['tool', 'input'].includes(message.kind) || message.status !== 'complete')) throw Error('Invalid native image count');
    const inline = message.kind === 'input' && message.inputMode === 'native-inline';
    const nativePrompt = message.kind === 'input' && message.inputMode === 'native-prompt';
    if (!this.nativeBlocks || !this.validRootBinding(message) || message.epoch !== this.observationEpoch ||
      !/^(display|tool|turn|prompt|control):[a-zA-Z0-9_:-]{1,160}$/.test(message.id || '') ||
      !['response', 'tool', 'turn', 'control', ...(this.retainedReader || this.nativeInlineInput ? ['input'] : [])].includes(message.kind) ||
      !Number.isSafeInteger(message.sequence) || message.sequence <= (this.rootObservation?.sequence || 0) ||
      !['streaming', 'running', 'complete', 'failed', 'interrupted'].includes(message.status) ||
      (message.id === 'control:model' && (message.kind !== 'control' || message.status !== 'complete' || typeof message.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,159}$/.test(message.model))) ||
      (message.kind === 'response' && (!Number.isSafeInteger(message.index) || message.index < 0 || typeof message.delta !== 'string')) ||
      (message.kind === 'input' && (!message.id.startsWith('prompt:') || typeof message.text !== 'string' || message.status !== 'complete')) ||
      (message.kind === 'input' && (inline || nativePrompt ? (inline ? !this.nativeInlineInput : !this.nativePromptInput) ||
        !/^prompt:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.id) ||
        (inline ? message.title !== '工作中插入' : message.title !== undefined) || message.inputTag !== undefined || message.promptId !== undefined ||
        message.delta !== undefined || message.index !== undefined || message.input !== undefined || message.displayTurnId !== undefined ||
        (message.incomplete !== undefined && typeof message.incomplete !== 'boolean') ||
        (message.turnId !== undefined && (typeof message.turnId !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(message.turnId)))
        : !this.retainedReader || message.inputMode !== undefined)) ||
      !['text', 'delta', 'input', 'title'].every(k => message[k] === undefined || (typeof message[k] === 'string' && message[k].length <= 500000))) throw Error('Invalid native block');
    const usage = message.id === 'control:usage' ? claudeUsage(message.usage) : null;
    if (message.id === 'control:usage' && (!usage || message.kind !== 'control' || message.status !== 'complete')) throw Error('Invalid native usage');
    this.rootObservation = { lease: message.lease, sequence: message.sequence };
    if (!message.replayed) this.observationSeenAt = Date.now();
    if (message.gap) this.observeRootGap(message);
    if (message.kind === 'control') {
      if (message.id === 'control:usage') {
        if (!message.replayed) this.emit('usage', usage);
        return { observed: true };
      } else if (message.id === 'control:model') {
        // Metadata is not an input/turn boundary and grants no sharing authority.
        if (!message.replayed) { this.nativeModelEpoch = this.observationEpoch; this.emit('model', message.model); }
        return { observed: true };
      } else if (message.id === 'control:turn-start') {
        if (!/^[a-zA-Z0-9_:-]{1,160}$/.test(message.turnId || '') || message.status !== 'running') throw Error('Invalid native turn start');
        this.seenRootTurns ||= new Set();
        // Replayed starts are history, never fresh authority to release input.
        // Keep bounded tombstones so a duplicate start cannot revive a stopped turn.
        if (!this.seenRootTurns.has(message.turnId)) {
          this.seenRootTurns.add(message.turnId);
          while (this.seenRootTurns.size > 256) this.seenRootTurns.delete(this.seenRootTurns.values().next().value);
          this.rootTurn = message.replayed || message.gap ? null : { id: message.turnId, promptId: message.promptId, status: 'working' };
          if (this.rootTurn) this.emit('nativeTurnStart', { nativeId: this.record.nativeId, turnId: message.turnId });
          this.liveTurn = this.rootTurn ? { id: message.turnId, promptId: message.promptId, phase: 'requesting', label: 'requesting' } : null;
          this.livePermissions.clear();
          if (this.rootTurn) { this.nativeInputRequired = false; this.emit('inputRequired', false); }
        }
      } else if (message.id === 'control:heartbeat') {
        // The observation lease has its own liveness proof; a held native
        // submit may legitimately leave the independent input poll pending.
      } else if (message.id === 'control:activity') {
        const phases = ['requesting', 'thinking', 'text', 'input', 'tool', 'responding', 'tool-input', 'tool-use']; // Old mod phases remain readable during an exact-byte upgrade.
        if (!phases.includes(message.phase) || typeof message.turnId !== 'string') throw Error('Invalid native activity');
        if (!message.replayed && !message.gap && this.liveTurn?.id === message.turnId) {
          this.liveTurn.phase = message.phase; this.liveTurn.label = message.phase;
        }
      } else if (message.id === 'control:permission-end') {
        if (typeof message.permissionId !== 'string' || !/^permission:[a-zA-Z0-9_:-]{1,160}$/.test(message.permissionId)) throw Error('Invalid native permission');
        if (!message.replayed && !message.gap && this.livePermissions.delete(message.permissionId) && !this.livePermissions.size && this.liveTurn) this.emit('state', 'working');
      } else {
        if (!['control:permission', 'control:input'].includes(message.id)) throw Error('Invalid native control boundary');
        if (message.id === 'control:permission' && message.turnId &&
            (this.liveTurn && message.turnId !== this.liveTurn.id || this.displayProofs?.get(message.turnId)?.ended)) return { observed: true };
        if (message.id === 'control:permission' && !message.boundaryOnly && !message.replayed && !message.gap) {
          const id = message.permissionId || `permission:${message.sequence}`;
          if (!/^permission:[a-zA-Z0-9_:-]{1,160}$/.test(id) || this.livePermissions.size >= 16) throw Error('Invalid native permission');
          this.livePermissions.set(id, { id, title: message.title || '', input: message.input || '', incomplete: message.incomplete === true, turnId: message.turnId || this.liveTurn?.id });
          if (message.title === 'AskUserQuestion' && this.liveTurn && this.liveTurn.question !== false) this.liveTurn.question = true;
        }
        if (this.liveTurn && (message.id === 'control:input' || message.boundaryOnly && (!message.promptId || message.promptId !== this.liveTurn.promptId || message.turnId !== this.liveTurn.id))) this.liveTurn.question = false;
        this.rootTurn = null;
        // Current sessions need this boundary too: the classic permission/state
        // event can arrive later or be coalesced before a peer sees a snapshot.
        this.emit('nativeControlBoundary', message.id);
        if (this.nativeSharedDisplay) this.emit('sharingBoundary', message.id);
        // The ordered ingress owns the human boundary; accepted appends own
        // display. Settings hooks and later attachments must not repeat either.
        if (message.id === 'control:input' && this.nativePromptInput && !message.replayed) this.emit('nativeInput', '', { display: false });
        if (message.id === 'control:permission' && !message.replayed && !message.gap) this.emit('state', 'approval');
      }
      this.emit('capability'); return { observed: true };
    }
    const { id, kind, turnId, displayTurnId, promptId, text, delta, index, title, status, input, incomplete } = message;
    const freshInline = inline && !message.replayed && !this.record.messages?.some(row => row.id === `native:${this.record.nativeId}:${id}`);
    if (freshInline) {
      this.rootTurn = null;
      this.emit('nativeControlBoundary', 'control:input');
      this.emit('sharingBoundary', 'control:input');
    }
    const inputTag = kind === 'input' && /^[a-f0-9-]{36}$/i.test(message.inputTag || '') ? message.inputTag : undefined;
    if (!['tool', 'input'].includes(kind) && (typeof turnId !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(turnId))) throw Error('Invalid native turn');
    this.displayProofs ||= new Map();
    let turn = this.displayProofs.get(turnId);
    if (!turn) { turn = { blocks: new Map(), incomplete: this.displayGap }; this.displayProofs.set(turnId, turn); }
    while (this.displayProofs.size > 8) this.displayProofs.delete(this.displayProofs.keys().next().value);
    if (kind === 'response') {
      let block = turn.blocks.get(id);
      if (!block) { block = { index: -1, text: '' }; turn.blocks.set(id, block); }
      if (block.index + 1 !== index || turn.ended || (turn.promptId && turn.promptId !== promptId)) turn.incomplete = true;
      turn.promptId = promptId;
      block.index = index; block.text += delta; block.final = status === 'complete';
      if (turn.blocks.size > 64 || [...turn.blocks.values()].reduce((n, b) => n + b.text.length, 0) > 500000) { turn.blocks.clear(); turn.incomplete = true; }
    }
    const endedLiveTurn = kind === 'turn' && this.liveTurn?.id === turnId;
    const endedQuestion = endedLiveTurn && this.liveTurn.question === true;
    if (kind === 'turn') {
      if (endedLiveTurn) this.liveTurn = null;
      for (const [key, request] of this.livePermissions) if (!request.turnId || request.turnId === turnId) this.livePermissions.delete(key);
      turn.ended = true;
      const block = turn.blocks.get(message.finalDisplayId);
      if (status === 'complete' && !turn.incomplete && block?.final) { turn.safeText = block.text; turn.messageId = `native:${this.record.nativeId}:${message.finalDisplayId}`; }
    }
    this.emit('nativeBlock', { id, nativeId: this.record.nativeId, kind, turnId, displayTurnId, promptId, text, delta, index, title, status, input, incomplete, inputTag, replayed: message.replayed === true,
      ...(inline || nativePrompt ? { inputMode: message.inputMode } : {}), ...(message.mediaOnly ? { imagePayload: message.imagePayload } : {}),
      ...(message.imageCount !== undefined ? { imageCount: message.imageCount } : {}) });
    if (kind === 'turn' && this.rootTurn?.id === turnId && !this.rootTurn.completed && ['working', 'error', null].includes(this.rootTurn.status) && !message.replayed && !message.gap) {
      this.rootTurn.status = status === 'interrupted' ? 'idle' : status === 'failed' && message.failedRequest === true ? 'error' : null;
      this.rootTurn.completed = status === 'complete';
      if (this.rootTurn.completed && !incomplete && !turn.incomplete) this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId, status: 'completed' });
      if (status === 'failed' && message.failedRequest === true && !incomplete && !turn.incomplete && /^[a-f0-9-]{36}$/i.test(message.errorMessageId || '')) this.rootTurn.errorMessageId = message.errorMessageId;
      if (incomplete || turn.incomplete) this.rootTurn.errorMessageId = null;
      this.reportCapacityFailure();
      if (status === 'interrupted') this.finishInterrupted(turnId);
      this.emit('capability');
    }
    // A native question revokes reply-sharing authority, not the independent
    // live turn identity. Cancelling that dialog can finish without classic.Stop.
    if (endedQuestion && !this.rootTurn && !message.replayed && !message.gap) {
      if (status === 'interrupted') {
        const pending = this.pending?.turnId === turnId ? this.pending : null;
        if (pending) { clearTimeout(pending.displayTimer); this.pending = null; }
        this.nativeInputRequired = true; this.emit('inputRequired', true);
        this.emit('interrupted', { turnId, tag: pending?.tag });
      }
      this.emit('state', status === 'failed' ? 'error' : 'idle');
    }
    if (kind === 'turn' && this.pending?.turnId === turnId && this.pending.stopEvent) this.finishReply(this.pending, this.pending.stopEvent);
    return { observed: true };
  }
  reportCapacityFailure(retry = false) {
    const turn = this.rootTurn;
    if (!this.nativeAbortAvailable || this.retainedReader || !turn || turn.endReported || turn.completed || turn.inputUsed || turn.failureCancelled ||
      !turn.failedTranscript || !turn.errorMessageId || !this.failedTurnInputMatches(turn.id) || turn.failureReads && !retry) return;
    turn.failurePosture ||= { owner: this.record.owner, control: this.record.controlRevision, member: this.record.memberRevision };
    const same = turn.failurePosture.owner === this.record.owner && turn.failurePosture.control === this.record.controlRevision && turn.failurePosture.member === this.record.memberRevision;
    const overloaded = same ? claudeOverloaded(turn.failedTranscript, this.record.nativeId, turn.errorMessageId) : false;
    turn.failureReads = (turn.failureReads || 0) + 1;
    turn.pendingFailure = overloaded === null && turn.failureReads < 5;
    if (turn.pendingFailure) return;
    turn.endReported = true;
    this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId: turn.id, status: 'failed', errorInfo: overloaded === true ? 'serverOverloaded' : null });
  }
  finishInterrupted(turnId) {
    if (this.rootTurn?.id !== turnId || this.rootTurn.status !== 'idle' || this.rootEnding ||
      (!this.retainedReader && this.lastPromptId && this.lastPromptId !== this.rootTurn.promptId)) return;
    const pending = this.pending?.turnId === turnId ? this.pending : null;
    if (pending) { clearTimeout(pending.displayTimer); this.pending = null; }
    this.nativeInputRequired = true; this.emit('inputRequired', true);
    this.emit('interrupted', { turnId, tag: pending?.tag });
    this.emit('state', 'idle'); // Root only: no successful reply or fleet completion.
    if (this.nativeAbortRequest?.turnId === turnId) { this.nativeAbortRequest.nativeDone = true; this.completeNativeAbort(); }
  }
  cancelNativeAbort() {
    const request = this.nativeAbortRequest; if (!request) return;
    this.nativeAbortRequest = null; clearTimeout(request.timer);
    this.emit('capability');
    request.reject(Error('原生中断结果未确认；没有重发或切换为终端按键，请核对原会话。'));
  }
  nativeAbortCurrent(request) {
    return this.nativeAbortRequest === request && !this.rootEnding && !this.disposed && this.terminal?.alive &&
      this.record.nativeId === request.nativeId && this.rootLease === request.lease && this.observationEpoch === request.epoch &&
      this.rootTurn?.id === request.turnId && this.record.controlRevision === request.control && Date.now() < request.deadline;
  }
  nativeAbortCommand() {
    const request = this.nativeAbortRequest; if (!request) return null;
    if (!this.nativeAbortCurrent(request)) { this.cancelNativeAbort(); return null; }
    if (request.delivered) return null;
    request.delivered = true;
    return { id: request.id, turnId: request.turnId, epoch: request.epoch };
  }
  nativeAbortResult(message) {
    const request = this.nativeAbortRequest;
    if (!request || !this.nativeAbortCurrent(request) || !this.validRootBinding(message) || message.epoch !== request.epoch ||
      message.id !== request.id || message.turnId !== request.turnId || !request.delivered) throw Error('Native abort changed');
    if (message.status !== 'aborted') { this.cancelNativeAbort(); return { received: true }; }
    request.apiDone = true;
    // This flag comes from the mod's actual prompt.submit finally, never a
    // local timeout/close of the application's submission promise.
    if (message.submitSettled === true) request.submitSettled = true;
    this.completeNativeAbort(); return { received: true };
  }
  completeNativeAbort() {
    const request = this.nativeAbortRequest; if (!request) return;
    if (!this.nativeAbortCurrent(request)) { this.cancelNativeAbort(); return; }
    if (!request.apiDone || !request.nativeDone || !request.submitSettled || this.submission.pending) return;
    this.nativeAbortRequest = null; clearTimeout(request.timer);
    this.nativeInputRequired = false; this.emit('inputRequired', false); request.resolve({ interrupted: true });
  }
  observeRootGap(message) {
    if (!this.validRootBinding(message) || !this.observationEpoch || message.epoch !== this.observationEpoch) throw Error('Invalid native observation');
    this.cancelNativeAbort(); this.rootTurn = null; this.liveTurn = null; this.livePermissions?.clear();
    this.displayGap = true; for (const turn of this.displayProofs?.values() || []) turn.incomplete = true;
    this.emit('progress', { id: `claude-observation-gap-${this.record.nativeId}`,
      source: 'claude-native-message', kind: 'gap', status: 'unknown', title: '部分原生消息未能同步',
      text: '本地观察连接或队列出现缺口，请核对原生终端。没有重发任务。' });
    if (this.nativeBlocks) this.emit('nativeBlock', { id: `gap:${this.observationEpoch}`, nativeId: this.record.nativeId, kind: 'gap', status: 'unconfirmed', text: '部分原生内容未能同步，请在原生终端核对。没有重发任务。' });
  }
  contextEnding(reason = 'other') {
    if (this.rootEnding?.sessionId === this.record.nativeId) return;
    this.cancelNativeAbort(); this.rootEnding = { sessionId: this.record.nativeId, reason };
    this.rootTurn = null; this.liveTurn = null; this.livePermissions?.clear(); this.pending = null; this.ready = false; this.lastPromptId = null;
    this.submission.close?.();
    this.emit('contextEnd', { nativeId: this.record.nativeId, reason });
    this.emit('state', 'stopping');
  }
  endRoot(message) {
    if (!this.rootLease || message.lease !== this.rootLease ||
      (message.sessionId !== this.record.nativeId && message.sessionId !== this.rootEnding?.sessionId) ||
      !['clear', 'resume', 'logout', 'prompt_input_exit', 'other'].includes(message.reason)) throw Error('Root changed');
    if (!this.rootEnding) this.contextEnding(message.reason);
    if (this.rootEnding?.sessionId === message.sessionId) this.rootEnding.reason = message.reason;
    return { ended: true };
  }
  clearRoot(message) {
    if (this.contextEventsOverflow) throw Error('Native context observation overflow');
    const previous = this.lastRootTransition;
    if (previous && previous.lease === message.lease && previous.sessionId === message.sessionId &&
      previous.nextSessionId === message.nextSessionId && this.record.nativeId === message.nextSessionId) {
      return { lease: this.rootLease, observationEpoch: this.observationEpoch, nativeInlineInput: this.nativeInlineInput, nativePromptInput: this.nativePromptInput, nativeMedia: this.nativeMedia }; // Lost metadata ACK, never a second clear.
    }
    if (!this.rootLease || message.lease !== this.rootLease || this.rootEnding?.sessionId !== message.sessionId ||
      !FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason] || FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason] !== message.source || this.rootEnding.unfollowed || message.agentId ||
      typeof message.nextSessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.nextSessionId) ||
      message.nextSessionId === message.sessionId || !this.terminal?.alive) throw Error('Unverified root transition');
    const change = { previousId: message.sessionId, nativeId: message.nextSessionId, reason: message.source === 'fork' ? 'branch' : 'clear',
      model: typeof message.model === 'string' && message.model.length <= 120 ? message.model : '原生未报告', committed: false };
    this.emit('contextClear', change);
    if (!change.committed || this.record.nativeId !== change.nativeId) throw Error('Context not saved');
    this.lastRootTransition = { sessionId: message.sessionId, nextSessionId: message.nextSessionId, lease: message.lease };
    this.rootLease = crypto.randomBytes(32).toString('hex');
    this.observationEpoch = crypto.randomBytes(16).toString('hex'); this.rootObservation = null;
    this.rootEnding = null; this.lastPromptId = null; this.pending = null; this.ready = true;
    this.displayProofs = new Map(); this.displayGap = false;
    this.emit('state', 'idle'); this.emit('model', change.model);
    const observed = (this.contextEvents || []).filter(e => e.session_id === change.nativeId);
    this.contextEvents = (this.contextEvents || []).filter(e => e.session_id !== change.nativeId);
    for (const event of observed) this.hook(event);
    return { lease: this.rootLease, observationEpoch: this.observationEpoch, nativeInlineInput: this.nativeInlineInput, nativePromptInput: this.nativePromptInput, nativeMedia: this.nativeMedia };
  }
  hook(event) {
    // A new root can already be receiving human input while its identity is
    // being saved. Buffer observations, but trust none until the mod proves the
    // exact new root. Child identities cannot authorize a context transition.
    if (this.rootEnding && FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason] && !this.rootEnding.unfollowed && !event.agent_id &&
      event.session_id !== this.rootEnding.sessionId && !this.record.nativeContexts?.some(c => c.nativeId === event.session_id)) {
      // A new root that starts another way (a plain /resume) is not followed; its
      // events are dropped as before instead of filling the buffer. A start whose
      // source does not match the ending is only unfollowed while no successor with
      // the expected source has been seen: after /branch admits its fork, the next
      // /clear start belongs to the queued chain, not to this ending.
      if (event.hook_event_name === 'SessionStart' && event.source !== FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason]) {
        const expected = FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason];
        const successorSeen = (this.contextEvents || []).some(e => e.hook_event_name === 'SessionStart' &&
          e.session_id !== this.rootEnding.sessionId && e.source === expected);
        if (!successorSeen) {
          this.rootEnding.unfollowed = true;
          // The same terminal now shows that session; its own exit-like end and a
          // following fork are still this window's background handoff.
          if (event.source === 'resume' && !event.agent_id) this.switchedTo = event.session_id;
          return;
        }
      }
      this.contextEvents ||= [];
      if (this.contextEvents.length >= 256 || this.contextEvents.reduce((n, e) => n + JSON.stringify(e).length, 0) + JSON.stringify(event).length > 1024 * 1024) {
        this.contextEventsOverflow = true;
        this.emit('activity', '原生上下文同步记录已达上限；请在原生终端继续，图形输入保持关闭。');
      } else this.contextEvents.push(event);
      return;
    }
    // A fork start right after this root ended like /exit is native /background:
    // the conversation continues in the native daemon under the new ID.
    if (this.switchedTo && event.hook_event_name === 'SessionEnd' && !event.agent_id && event.session_id === this.switchedTo) {
      this.switchedEnding = event.reason; return;
    }
    // A further /resume, /clear or /branch inside the switched session moves the
    // terminal on again; follow it so a later /background is still recognised.
    if (this.switchedTo && this.switchedEnding && this.switchedEnding !== 'prompt_input_exit' &&
      event.hook_event_name === 'SessionStart' && !event.agent_id && typeof event.session_id === 'string' &&
      event.session_id !== this.switchedTo && event.session_id !== this.record.nativeId) {
      this.switchedTo = event.session_id; this.switchedEnding = undefined; return;
    }
    const exitedHere = (this.rootEnding?.reason === 'prompt_input_exit' && this.rootEnding.sessionId === this.record.nativeId) ||
      (this.switchedTo && this.switchedEnding === 'prompt_input_exit');
    if (event.hook_event_name === 'SessionStart' && event.source === 'fork' && !event.agent_id && !this.backgroundTo && exitedHere &&
      typeof event.session_id === 'string' && event.session_id !== this.record.nativeId && event.session_id !== this.switchedTo) {
      this.backgroundTo = event.session_id;
      if (this.closedAwaitingBackground) this.finishClose();
      return;
    }
    // A /resume back to a retired context of this row (e.g. the original after a
    // /branch) is the same unfollowed switch; remember it before dropping its events.
    if (event.hook_event_name === 'SessionStart' && event.source === 'resume' && !event.agent_id &&
      this.rootEnding?.reason === 'resume' && !this.rootEnding.unfollowed && !this.switchedTo &&
      event.session_id !== this.rootEnding.sessionId && this.record.nativeContexts?.some(c => c.nativeId === event.session_id)) {
      this.rootEnding.unfollowed = true; this.switchedTo = event.session_id; return;
    }
    // Late events from a retired root must not become the current context's
    // replies, approvals, fleet or readiness. Its saved history stays intact.
    if (event.session_id !== this.record.nativeId && this.record.nativeContexts?.some(c => c.nativeId === event.session_id)) return;
    // Teammates inherit hooks. Never attribute a child's final reply to its lead.
    const isChild = Boolean(event.agent_id) || event.session_id !== this.record.nativeId;
    if (['SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted'].includes(event.hook_event_name)) this.emit('fleet', {
      event: event.hook_event_name, id: event.agent_id || event.task_id || '',
      name: event.teammate_name || event.agent_type || event.task_subject || '原生团队活动',
    });
    if (isChild) return;
    // The branch exists once its own session starts; later launches resume it.
    if (this.record.forkPicker && event.hook_event_name === 'SessionStart') { this.record.forkPicker = false; this.emit('capability'); }
    const mode = PERMISSION_MODES.includes(event.permission_mode) ? event.permission_mode : this.record.nativePermissionMode;
    const effort = EFFORT_LEVELS.includes(event.effort?.level) ? event.effort.level : this.record.nativeEffort;
    if (mode !== this.record.nativePermissionMode || effort !== this.record.nativeEffort) {
      this.record.nativePermissionMode = mode; this.record.nativeEffort = effort; this.emit('capability');
    }
    // An unnamed session gets Claude's own generated title (no --name was passed).
    if (this.record.autoName && event.session_id === this.record.nativeId && ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(event.hook_event_name)) {
      const title = claudeGeneratedTitle(event.transcript_path, this.record.nativeId);
      if (title && title !== this.generatedTitle) { this.generatedTitle = title; this.emit('nativeTitle', title); }
    }
    if (event.hook_event_name === 'StopFailure') {
      // Settings hooks may arrive after ordered native events, or after a
      // human has submitted B while A's failure is still being reported.
      const prompt = event.prompt_id, current = this.rootTurn?.promptId;
      if ((current && current !== prompt) ||
        (!current && this.lastPromptId && this.lastPromptId !== prompt) ||
        (this.pending && (this.pending.failedPromptId === prompt ||
          (this.rootTurn?.inputUsed && current === prompt) ||
          (this.pending.promptId && this.pending.promptId !== prompt)))) return;
    }
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) this.emit('progress', {
      id: event.tool_use_id, source: 'claude-hook', kind: 'tool', title: event.tool_name || '',
      status: event.hook_event_name === 'PreToolUse' ? 'running' : event.hook_event_name === 'PostToolUse' ? 'completed' : 'failed',
    });
    if (['PermissionRequest', 'Notification', 'StopFailure'].includes(event.hook_event_name)) this.emit('progress', {
      source: 'claude-hook', kind: event.hook_event_name, title: event.hook_event_name === 'PermissionRequest' ? '等待原生权限确认' : event.hook_event_name === 'StopFailure' ? '原生请求失败' : '原生通知',
      text: event.message || '', status: event.hook_event_name === 'StopFailure' ? 'failed' : 'observed',
    });
    switch (event.hook_event_name) {
      case 'SessionStart': if (this.rootEnding) break; this.ready = true; this.emit('state', 'idle'); if (!this.nativeModelEpoch || this.nativeModelEpoch !== this.observationEpoch) this.emit('model', event.model || '原生未报告'); break;
      case 'UserPromptSubmit': {
        if (this.liveTurn && (!event.prompt_id || event.prompt_id !== this.liveTurn.promptId)) this.liveTurn.question = false;
        // A settings hook observing a prompt is not its acceptance. The native
        // structured submission result acknowledges our own sends separately.
        if (this.rootTurn?.promptId !== event.prompt_id) this.rootTurn = null;
        this.lastPromptId = event.prompt_id || null;
        const entering = this.queued || this.pending;
        if (entering && !entering.accepted && this.submission.pending?.authorized && event.prompt === entering.text) {
          entering.prompts.add(event.prompt_id || null);
          if (entering === this.queued) this.emit('state', 'working');
        } else if (!this.pending || event.prompt !== this.pending.text || event.prompt_id !== this.pending.promptId) {
          if (this.queued) this.queued.superseded = true;
          this.pending = null; this.emit('state', 'working');
          if (!this.nativePromptInput) this.emit('nativeInput', event.prompt || '原生输入', event.prompt_id ? { id: `claude-prompt-${event.prompt_id}`, ...(this.liveTurn?.promptId === event.prompt_id ? { turnId: this.liveTurn.id } : {}) } : undefined);
        }
        break;
      }
      case 'PermissionRequest': if (this.liveTurn && (!event.prompt_id || event.prompt_id !== this.liveTurn.promptId)) this.liveTurn.question = false; this.rootTurn = null; if (this.queued) this.queued.superseded = true; this.pending = null; this.emit('state', 'approval'); break;
      case 'Notification':
        if (/permission|elicitation|auth/.test(event.notification_type || '')) { if (this.liveTurn) this.liveTurn.question = false; this.rootTurn = null; if (this.queued) this.queued.superseded = true; this.pending = null; this.emit('state', 'approval'); }
        break;
      case 'PreToolUse':
        if (this.pending) this.pending.replies.delete(event.prompt_id);
        if (this.queued) this.queued.replies.delete(event.prompt_id);
        this.emit('activity', event.tool_name || ''); this.emit('state', 'working'); break;
      case 'Stop': {
        const pending = this.queued?.prompts.has(event.prompt_id) ? this.queued : this.pending;
        // Native IDs, not arrival time or matching text, select the reply.
        if (pending && !pending.accepted) {
          if (pending.replies.size < 8 && event.prompt_id) pending.replies.set(event.prompt_id, event);
          return;
        }
        if ((pending && event.prompt_id !== pending.promptId) ||
          (!pending && this.lastPromptId && event.prompt_id !== this.lastPromptId)) {
          if (!this.nativeBlocks && event.last_assistant_message) this.emit('messageItem', { id: `claude-stop-${event.prompt_id || crypto.randomUUID()}`, text: event.last_assistant_message });
          return;
        }
        this.finishReply(pending, event);
        break;
      }
      case 'StopFailure':
        if (this.liveTurn) this.liveTurn.question = false;
        if (this.rootTurn?.promptId !== event.prompt_id) this.rootTurn = null;
        clearTimeout(this.pending?.displayTimer); this.pending = null;
        this.emit('state', 'error'); this.emit('failed', '原生请求未完成，请查看失败记录。');
        if (this.rootTurn) this.rootTurn.failedTranscript = event.transcript_path;
        this.reportCapacityFailure(); break;
      case 'SessionEnd': this.contextEnding(event.reason); break;
    }
  }
  finishReply(pending, event) {
        if (pending?.nativeId && (pending.nativeId !== this.record.nativeId || this.rootEnding?.sessionId === pending.nativeId)) {
          if (!this.nativeBlocks && event.last_assistant_message) this.emit('messageItem', { id: `claude-stop-${event.prompt_id}`, nativeId: pending.nativeId, text: event.last_assistant_message });
          return;
        }
        // A delayed completion of A cannot mark B idle once native has started
        // B. Private raw fallback is retained; shared attribution stays closed.
        if (pending?.promptId && this.lastPromptId && pending.promptId !== this.lastPromptId) {
          if (!this.nativeBlocks && event.last_assistant_message) this.emit('messageItem', { id: `claude-stop-${event.prompt_id}`, text: event.last_assistant_message });
          return;
        }
        if (pending && this.pending !== pending) {
          if (!this.nativeBlocks && event.last_assistant_message) this.emit('messageItem', { id: crypto.randomUUID(), text: event.last_assistant_message });
          return;
        }
        const accepted = pending?.accepted && !pending.interruptRequested && pending.promptId && event.prompt_id === pending.promptId && this.pending === pending && pending.guard();
        const proof = this.nativeBlocks && pending?.turnId ? this.displayProofs?.get(pending.turnId) : null;
        if (this.nativeBlocks && accepted && pending.turnId && !proof?.ended && !pending.displayTimedOut) {
          pending.stopEvent = event;
          pending.displayTimer ||= setTimeout(() => {
            pending.displayTimedOut = true;
            if (this.pending === pending) this.finishReply(pending, event);
          }, 2000).unref();
          return;
        }
        clearTimeout(pending?.displayTimer);
        const displayConfirmed = !this.nativeBlocks || (proof?.ended && !proof.incomplete && proof.promptId === pending?.promptId && typeof proof.safeText === 'string');
        if (this.pending === pending) this.pending = null;
        const background = Array.isArray(event.background_tasks) ? event.background_tasks.length : null;
        const scheduled = Array.isArray(event.session_crons) ? event.session_crons.length : null;
        this.emit('background', { count: background, scheduled });
        this.emit('state', 'idle');
        // Observed child hooks cannot certify that all descendants are idle.
        this.emit('complete', { messageId: displayConfirmed ? proof?.messageId : undefined, tag: accepted && displayConfirmed ? pending.tag : undefined, text: this.nativeBlocks ? displayConfirmed ? proof?.safeText || '' : '' : event.last_assistant_message || '', background, scheduled, fleetPending: null, stopHookActive: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null });
  }
  async send(text, tag, guard) {
    if (this.nativeAbortRequest) throw Error('正在等待原生中断确认；草稿保留。');
    if (this.nativeInputRequired) throw Error('Claude 已暂停插件输入；请在原生终端输入一次后继续，草稿保留。');
    if (!this.ready || this.pending || this.queued) throw new Error('Claude 尚未就绪，或上一条输入仍待确认。');
    if (!guard()) throw new Error('这条交接已撤销。');
    const failedPromptId = this.failedTurnInputId ? this.rootTurn.promptId : null;
    this.claimFailedTurnInput();
    const pending = this.pending = { tag, text, guard, nativeId: this.record.nativeId, failedPromptId, accepted: false, promptId: null, prompts: new Set(), replies: new Map() };
    return this.deliver(pending);
  }
  failedTurnInputMatches(id) {
    return Boolean(id && this.rootTurn?.id === id && this.rootTurn.status === 'error' &&
      this.rootLease && !this.rootEnding && !this.disposed && this.terminal?.alive && this.submission.connected &&
      !this.nativeInputRequired && (this.retainedReader || this.lastPromptId === this.rootTurn.promptId));
  }
  get failedTurnInputId() { return !this.rootTurn?.inputUsed && this.failedTurnInputMatches(this.rootTurn?.id) ? this.rootTurn.id : null; }
  claimFailedTurnInput() {
    if (this.failedTurnInputId) { this.rootTurn.inputUsed = true; this.emit('capability'); }
  }
  get queueAvailable() { return Boolean(!this.nativeAbortRequest && !this.nativeInputRequired && this.nativeQueue && this.rootLease && !this.rootEnding && this.ready && this.chatAvailable); }
  async queue(text, tag, guard) {
    if (!this.queueAvailable || this.queued || this.submission.pending || !guard()) throw Object.assign(Error('原生等待输入暂不可用；草稿保留。'), { notSent: true });
    const pending = this.queued = { tag, text, guard, nativeId: this.record.nativeId, accepted: false, promptId: null, prompts: new Set(), replies: new Map() };
    try { return await this.deliver(pending, true); }
    finally { if (this.queued === pending) this.queued = null; }
  }
  async deliver(pending, queued = false) {
    const { text, tag, guard } = pending;
    try {
      const receipt = await this.submission.request(text, tag, guard, queued);
      pending.accepted = true;
      pending.promptId = receipt?.promptId || null;
      pending.turnId = receipt?.turnId || null;
      // The older task keeps its pending identity until native starts this one.
      // A late receipt cannot overwrite unrelated newer work or a retired root.
      if (queued && !pending.superseded && pending.promptId && this.lastPromptId === pending.promptId && pending.nativeId === this.record.nativeId && !this.rootEnding) this.pending = pending;
      this.emit('submitted', tag);
      if (pending.nativeId !== this.record.nativeId || this.rootEnding?.sessionId === pending.nativeId) {
        // Correlation controls sharing, not retention of already observed old
        // private results. A missing promptId must not discard those results.
        for (const event of pending.replies.values()) this.finishReply(pending, event);
        return;
      }
      if (!pending.promptId || [...pending.prompts].some(id => id !== pending.promptId)) {
        if (this.pending === pending || (queued && !pending.superseded && this.lastPromptId && pending.prompts.has(this.lastPromptId))) {
          this.pending = null;
          this.emit('unattributed', tag);
          const observed = this.lastPromptId && pending.replies.get(this.lastPromptId);
          if (observed) this.finishReply(null, observed);
          else this.emit('state', 'working');
        }
        return;
      }
      if (pending.turnId) this.emit('replyBound', { tag, nativeId: pending.nativeId, turnId: pending.turnId, promptId: pending.promptId });
      if (this.rootTurn?.id === pending.turnId && this.rootTurn.status === 'idle') this.finishInterrupted(pending.turnId);
      else if (pending.replies.has(pending.promptId)) this.finishReply(pending, pending.replies.get(pending.promptId));
      else if (this.pending === pending) this.emit('state', 'working');
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      throw error;
    }
  }
  interrupt() {
    if (this.pending) this.pending.interruptRequested = true;
    if (this.nativeAbortRequest) {
      if (this.nativeAbortCurrent(this.nativeAbortRequest)) return this.nativeAbortRequest.done;
      this.cancelNativeAbort();
    }
    if (!this.nativeAbortAvailable || this.rootTurn?.status !== 'working' || this.rootEnding || this.displayGap) { this.terminal.input('\x1b'); return; }
    const request = { id: crypto.randomUUID(), nativeId: this.record.nativeId, turnId: this.rootTurn.id,
      lease: this.rootLease, epoch: this.observationEpoch, control: this.record.controlRevision, deadline: Date.now() + 8000 };
    request.done = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; }); request.done.catch(() => {});
    this.nativeAbortRequest = request; request.timer = setTimeout(() => { if (this.nativeAbortRequest === request) this.cancelNativeAbort(); }, 8000);
    this.emit('capability');
    return request.done;
  }
  async openTerminal() { return this.terminal; }
  async stop() { this.cancelNativeAbort(); clearTimeout(this.closedAwaitingBackground); this.closedAwaitingBackground = null; await this.terminal.stop(); this.host.hookTargets.delete(this.token); return { state: 'ended' }; }
}

class Rpc extends EventEmitter {
  constructor(ws) {
    super(); this.ws = ws; this.sequence = 0; this.pending = new Map();
    ws.on('message', data => {
      let message; try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.method) this.emit('event', message);
      else if (this.pending.has(message.id)) {
        const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) {
          const error = new Error(`原生接口拒绝请求（${message.error.code}），请查看原生会话。`);
          error.nativeMissingHistory = message.error.code === -32600 && /^no rollout found for thread id /.test(message.error.message || '');
          if (error.nativeMissingHistory) error.nativeMissingHistoryThread = /^no rollout found for thread id ([^\s]+)$/.exec(message.error.message || '')?.[1];
          error.nativeUnsupportedTurns = message.error.code === -32601 && message.error.message === 'list_turns is not supported yet';
          error.nativeGoalsDisabled = message.error.code === -32600 && message.error.message === 'goals feature is disabled';
          if (message.error.code === -32600) error.nativeUnmaterializedThread =
            /^thread ([\da-f-]{36}) is not materialized yet; thread\/turns\/list is unavailable before first user message$/i.exec(message.error.message || '')?.[1];
          if (message.error.code === -32600 && /already has an active writer/.test(message.error.message || '')) {
            error.message = '该会话仍在其他原生连接中使用。请先在那里结束连接，再继续；原连接未被修改。';
            error.nativeActiveWriter = true;
          }
          p.reject(error);
        } else p.resolve(message.result);
      }
    });
    ws.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('原生连接已断开；不会自动重发。')); } this.pending.clear(); this.emit('closed'); });
    ws.on('error', () => {});
  }
  call(method, params) {
    if (this.ws.readyState !== undefined && this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('原生连接已断开；不会自动重发。'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('原生请求确认超时；不会自动重发。')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  reply(id, result) {
    if (this.ws.readyState !== undefined && this.ws.readyState !== WebSocket.OPEN) throw new Error('原生连接已断开；确认没有发送。');
    this.ws.send(JSON.stringify({ id, result }));
  }
}

class Codex extends EventEmitter {
  constructor(record, host) {
    super(); this.record = record; this.host = host; this.pending = null; this.turnId = null; this.terminal = null; this.turns = new Map(); this.ownInputs = new Set(); this.hasHistory = false; this.chatAvailable = !record.recovering && record.view !== 'terminal'; this.stopped = false; this.lifecycleRevision = 0; this.eventRevision = 0; this.stateRevision = 0; this.on('state', state => { this.latestState = state; this.stateRevision++; }); this.inputItems = new Set(); this.liveMessageItems = new Set(); this.liveToolItems = new Set(); this.historyMessageItems = new Set();
    this.nativeRequests = new Map();
    this.activeNativeItems = new Map(); this.nativeStartedAt = null; this.nativeWait = null; this.nativeTurnFinished = false;
    this.nativeTextParts = new Map(); this.liveTextItems = new Set();
    this.textEndedTurns = new Set((record.messages || []).filter(m => m.kind === 'turn' || ['summary', 'plan'].includes(m.kind) && m.status === 'interrupted').map(m => m.turnId).filter(Boolean));
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
      this.rememberHistoryWatermarks();
      for (const message of this.record.messages || []) {
        if (message.role === 'user' && ['human', 'room', 'agent-wake'].includes(message.origin)) this.ownInputs.add(message.id);
      }
      this.host.codexTargets.set(this.record.nativeId, this);
      const revision = this.stateRevision, settings = this.nativeSettings;
      let result;
      try {
        result = await rpc.call('thread/resume', { threadId: this.record.nativeId, ...(!this.record.externalHistory ? { cwd: this.record.cwd } : {}), excludeTurns: true });
        if (this.stopped) { this.finishRecoveryConnection?.(false); return; }
        if (!current()) throw new Error('原生后台已变化，没有继续旧的恢复请求。');
        if (result.thread?.id !== this.record.nativeId) throw new Error('原生返回了不同的会话，恢复未确认。');
        this.nativeSessionId = result.thread.sessionId; this.emit('workspaceMcpProof');
      } catch (error) {
        if (this.host.codexTargets.get(this.record.nativeId) === this) this.host.codexTargets.delete(this.record.nativeId);
        this.finishRecoveryConnection?.(false);
        throw error;
      }
      if (this.stopped) { this.finishRecoveryConnection?.(false); return; }
      this.hasHistory = true; this.addressedSendAvailable = this.record.addressedToolVersion === 1; this.finishRecoveryConnection?.(true);
      if (this.record.externalHistory && typeof result.thread.cwd === 'string' && path.isAbsolute(result.thread.cwd)) this.record.cwd = result.thread.cwd;
      this.emit('pid', this.host.codexProcess.pid); this.observeReplySettings(result, settings);
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
    // Native configuration/requirements choose permissions unless the person
    // chose to skip confirmations for this session when creating it.
    const settings = this.nativeSettings;
    const r = await rpc.call('thread/start', { cwd: this.record.cwd, ephemeral: false, experimentalRawEvents: false, dynamicTools: [require('./addressed-handoffs.cjs').codexTool],
      ...(this.record.skipPermissions ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : {}) });
    if (!current()) throw new Error('原生后台已变化，没有接管旧的启动结果。');
    this.record.addressedToolVersion = 1; this.addressedSendAvailable = true;
    this.record.nativeId = r.thread.id; this.nativeSessionId = r.thread.sessionId; this.emit('workspaceMcpProof');
    this.host.codexTargets.set(this.record.nativeId, this);
    this.observeReplySettings(r, settings);
    this.emit('pid', this.host.codexProcess.pid); this.emit('state', 'idle');
    });
  }
  async startFromTerminal() {
    if (this.stopped) return;
    const rpc = this.host.rpc, child = this.host.codexProcess;
    const endpoint = await this.terminalEndpoint();
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
      const started = (thread, model) => {
        cleanup();
        if (this.stopped || rpc !== this.host.rpc || child !== this.host.codexProcess) {
          reject(new Error('原生后台已变化，没有接管旧的启动结果。')); return;
        }
        this.record.nativeId = thread.id; this.nativeSessionId = thread.sessionId; this.emit('workspaceMcpProof'); this.host.codexTargets.set(thread.id, this);
        if (this.terminalNotificationSource) this.chatAvailable = true;
        this.emit('activity', ''); this.emit('model', model || thread.model || '原生未报告'); this.emit('state', 'idle'); resolve();
        if (!this.chatAvailable) this.observing = this.observeFirstTurn().catch(() => { if (!this.stopped) this.emit('activity', '原生终端可继续；对话连接未确认。'); });
      };
      this.host.pendingCodex = started;
      this.host.pendingCodexRuntime = this;
      this.initialTerminalThread = started;
      try {
        this.makeTerminal([this.host.codexBinary || this.host.binaries.codex, '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', ...(this.record.skipPermissions ? ['-a', 'never', '-s', 'danger-full-access'] : []), '--remote', `unix://${endpoint}`, '-C', this.record.cwd]).once('closed', closed);
      } catch (error) { cleanup(); reject(error); }
    });
  }
  async observeFirstTurn() {
    // An empty native thread cannot be resumed. Wait for a real user turn;
    // never spend a model call to manufacture history for an attachment.
    const lifecycle = this.lifecycleRevision, rpc = this.host.rpc, child = this.host.codexProcess;
    const current = () => !this.stopped && !this.transportDisconnected && lifecycle === this.lifecycleRevision &&
      rpc === this.host.rpc && child === this.host.codexProcess;
    while (current() && !this.chatAvailable) {
      await delay(1000);
      if (!current()) return;
      const revision = this.eventRevision;
      const { thread } = await rpc.call('thread/read', { threadId: this.record.nativeId, includeTurns: false });
      if (!current()) return;
      const nativeState = thread.status?.type;
      if (revision === this.eventRevision) this.emit('state', nativeState === 'active' ? 'working' : nativeState === 'idle' ? 'idle' : 'starting');
      if (!thread.preview || nativeState !== 'idle') continue;
      const settings = this.nativeSettings;
      const result = await rpc.call('thread/resume', { threadId: thread.id, excludeTurns: true });
      if (!current()) return;
      this.observeReplySettings(result, settings);
      if (!await this.hydrateHistory(thread.id, lifecycle) || !current()) return;
      this.chatAvailable = true; this.hasHistory = true; this.emit('capability');
    }
  }
  async hydrateHistory(threadId, lifecycle = this.lifecycleRevision, recovery = false) {
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
        if (item.type === 'reasoning') items.set(item.id, { id: item.id, type: item.type, summary: Array.isArray(item.summary) && item.summary.every(part => typeof part === 'string') ? item.summary : [], turnId: entry.turnId });
        if (item.type === 'plan') items.set(item.id, { id: item.id, type: item.type, text: typeof item.text === 'string' ? item.text : '', turnId: entry.turnId });
        if (['agentMessage', 'userMessage'].includes(item.type) || toolTypes.has(item.type)) items.set(item.id, { ...item, turnId: entry.turnId });
      }
      cursor = result.nextCursor;
      if (cursor == null) {
        for (const item of items.values()) {
          // A history snapshot has no delta watermark. If no live stream was
          // observed, wait for the authoritative completed item instead of
          // appending potentially overlapping deltas to that snapshot.
          if ((item.type === 'agentMessage' && !this.liveMessageItems.has(item.id)) ||
              (toolTypes.has(item.type) && !this.liveToolItems.has(item.id)) ||
              (['reasoning', 'plan'].includes(item.type) && !this.liveTextItems.has(item.id) && !this.nativeTextParts.has(item.id))) this.historyMessageItems.add(item.id);
        }
        this.emit('history', [...items.values()], undefined, recovery);
        if (verifiedCodexProtocol(this.host.rpc)) {
          const previousMetadata = this.turnMetadataHydration;
          const rpc = this.host.rpc, revision = this.turnMetadataRevision = (this.turnMetadataRevision || 0) + 1;
          const current = () => !this.stopped && !this.transportDisconnected && lifecycle === this.lifecycleRevision && rpc === this.host.rpc &&
            revision === this.turnMetadataRevision && threadId === this.record.nativeId;
          // One bounded read-only enrichment per snapshot. Content and input
          // are ready immediately, even if this optional request is held.
          this.turnMetadataHydration = (async () => {
            try {
              await previousMetadata;
              const turns = [], seen = new Set(); let after;
              for (let page = 0; page < 1000; page++) {
                if (!current()) return;
                const result = await rpc.call('thread/turns/list', { threadId, limit: 100, sortDirection: 'asc', itemsView: 'notLoaded', ...(after ? { cursor: after } : {}) });
                if (!current()) return;
                if (!Array.isArray(result.data)) throw Error('Invalid native turn metadata');
                turns.push(...result.data);
                if (result.nextCursor == null) { this.emit('turnHistory', turns); return; }
                after = result.nextCursor;
                if (typeof after !== 'string' || !after || seen.has(after)) throw Error('Invalid native turn cursor');
                seen.add(after);
              }
              throw Error('Native metadata page limit');
            } catch { if (current()) this.emit('turnHistory', null); }
          })();
        }
        return true;
      }
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('原生历史分页未能确认；请在原生终端继续。');
      cursors.add(cursor);
    }
    throw new Error('原生历史超过本次读取上限；请在原生终端查看完整记录。');
  }
  makeTerminal(argv) {
    this.terminal = new Terminal(argv, this.record.cwd);
    const exitNotice = '原生终端已退出；已连接的会话仍由运行服务管理。';
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => {
      this.emit('pid', pid);
      if (this.record.activity === exitNotice) this.emit('activity', '');
    });
    this.terminal.on('closed', () => {
      this.terminalBridge?.close(); this.terminalBridge = null; this.terminalBridgeReady = null;
      this.emit('activity', this.backendExitConfirmed
        ? '原生后台已退出；记录和草稿保留，任务不会自动重发。'
        : exitNotice);
    });
    return this.terminal;
  }
  async terminalEndpoint() {
    // Older native services keep their original protocol; no speculative parser.
    if (!verifiedCodexProtocol(this.host.rpc)) return this.host.codexSocket;
    if (!this.terminalBridge) {
      const { CodexTerminalBridge } = require('./codex-terminal-bridge.cjs');
      const bridge = new CodexTerminalBridge(path.join(this.host.privateDir, `tui-${crypto.randomUUID()}.sock`), this.host.codexSocket, event => this.observeTerminalContext(event));
      this.terminalBridge = bridge;
      this.terminalBridgeReady = bridge.start();
      try { await this.terminalBridgeReady; }
      catch (error) { bridge.close(); if (this.terminalBridge === bridge) this.terminalBridge = null; throw error; }
    }
    await this.terminalBridgeReady;
    return this.terminalBridge.endpoint;
  }
  rememberHistoryWatermarks() {
    for (const message of this.record.messages || []) if ((!message.nativeId || message.nativeId === this.record.nativeId) && ['assistant', 'tool'].includes(message.role)) {
      const id = nativeTextItemId(message, this.record.nativeId);
      if (typeof id === 'string' && id) this.historyMessageItems.add(id);
    }
  }
  observeSettings(settings) {
    if (!settings || typeof settings.model !== 'string' || !settings.model) return;
    // Public effective settings only. Never copy developer instructions or the
    // wider settings object into the reader or room.
    const mode = settings.collaborationMode?.mode;
    this.nativeSettings = { nativeId: this.record.nativeId, model: settings.model,
      effort: typeof settings.effort === 'string' ? settings.effort : null,
      mode: ['plan', 'default'].includes(mode) ? mode : null };
    this.emit('model', settings.model); this.emit('capability');
  }
  observeReplySettings(result, previous) {
    if (typeof result?.thread?.id !== 'string' || !result.thread.id || result.thread.id !== this.record.nativeId || this.nativeSettings !== previous) return;
    const model = result.model || result.thread.model;
    // A reply has effective model/effort, but no collaboration-mode report.
    // Keep a separately observed mode for this same native identity only.
    const mode = previous?.nativeId === this.record.nativeId ? previous.mode : null;
    this.observeSettings({ model, effort: result.reasoningEffort, collaborationMode: { mode } });
  }
  rememberQuestion(params) {
    if (typeof params.turnId !== 'string' || typeof params.itemId !== 'string' || !Array.isArray(params.questions)) return;
    const id = `notice:question:${params.turnId}:${params.itemId}`;
    const text = params.questions.map(q => [q.header, q.question,
      ...(q.options || []).map(option => [option.label, option.description].filter(v => typeof v === 'string').join(' — '))]
      .filter(v => typeof v === 'string' && v).join('\n')).join('\n\n');
    const question = { id, turnId: params.turnId, secret: params.questions.some(q => q.isSecret === true), questionIds: params.questions.map(q => q.id).filter(id => typeof id === 'string'), labels: params.questions.map(q => ({ id: q.id, text: q.header || q.question })) };
    this.emit('nativeBlock', { id, nativeId: this.record.nativeId, turnId: params.turnId, kind: 'notice', title: '原生问题', text, status: 'complete' });
    return question;
  }
  observeTerminalContext(event) {
    if ((this.stopped || this.transportDisconnected) && event.kind !== 'disconnected') return;
    if (event.kind === 'reply') {
      if (this.terminalRpc !== event.rpc || !event.rpc.connected || this.record.nativeContextPending) return;
      const request = this.nativeRequests.get(this.nativeRequestKey(event.id, event.rpc));
      if (request?.rpc !== event.rpc || request.ambiguous || !request.question || request.question.secret || !event.result?.answers) return;
      const answers = Object.create(null);
      for (const id of request.question.questionIds) {
        const values = event.result.answers[id]?.answers;
        if (Array.isArray(values) && values.every(value => typeof value === 'string')) answers[id] = { answers: values };
      }
      if (!Object.keys(answers).length) return;
      const entries = Object.entries(answers);
      const text = entries.map(([id, value]) => (entries.length > 1 ? (request.question.labels.find(q => q.id === id)?.text || id) + '\n' : '') + value.answers.join('\n')).join('\n\n');
      this.emit('nativeBlock', { id: request.question.id + ':reply', nativeId: this.record.nativeId,
        turnId: request.question.turnId, kind: 'notice', title: '原生终端提交的回答', text, status: 'submitted' });
      return;
    }
    if (event.kind === 'native') {
      if (this.terminalRpc === event.rpc && (this.terminalNotificationSource || event.message.id !== undefined || event.message.method === 'serverRequest/resolved')) this.event(event.message, event.rpc);
      return;
    }
    if (event.kind === 'disconnected') {
      if (this.terminalRpc !== event.rpc) return;
      const ownedNotifications = this.terminalNotificationSource;
      this.emit('approvalUnavailable', event.rpc);
      for (const [key, request] of this.nativeRequests) if (request.rpc === event.rpc) this.nativeRequests.delete(key);
      this.terminalRequestKeys?.clear();
      this.terminalNotificationSource = false; this.terminalRpc = null;
      if (!ownedNotifications || this.stopped || this.transportDisconnected) return;
      this.chatAvailable = false;
      this.nativeObservationPending = true;
      this.rememberHistoryWatermarks();
      for (const row of this.record.messages || []) if (row.nativeId === this.record.nativeId && row.turnId === this.turnId && ['streaming', 'running'].includes(row.status)) row.incomplete = true;
      this.liveMessageItems.clear(); this.liveToolItems.clear(); this.liveTextItems.clear(); this.nativeTextParts.clear();
      if (this.turnId && !this.nativeTurnFinished) this.emit('nativeBlock', { id: `gap:source:${crypto.randomUUID()}`, nativeId: this.record.nativeId, turnId: this.turnId, kind: 'gap', status: 'complete', text: '原生显示连接已断开，正在核对图形连接；此间的临时变化可能未同步，原会话继续保留。' });
      const rpc = this.host.rpc, id = this.record.nativeId, revision = this.lifecycleRevision, stateRevision = this.stateRevision, settings = this.nativeSettings;
      this.observing = rpc.call('thread/resume', { threadId: id, excludeTurns: true }).then(async result => {
        if (revision !== this.lifecycleRevision || this.stopped || this.transportDisconnected || this.host.rpc !== rpc || result.thread?.id !== id) return;
        this.nativeObservationPending = false;
        this.observeReplySettings(result, settings);
        if (stateRevision === this.stateRevision) this.observeStatus(result.thread.status);
        if (await this.hydrateHistory(id, revision, true) && revision === this.lifecycleRevision && !this.stopped) { this.chatAvailable = true; this.emit('capability'); }
      }).catch(() => this.emit('activity', '原生终端已退出；图形连接尚未确认，记录和草稿保留。'));
      this.emit('capability'); return;
    }
    if (event.ephemeral) return; // Native title/Recap helpers are not the displayed root.
    if (event.kind === 'request') {
      this.terminalSettingsRequest = { key: event.key, previous: this.nativeSettings };
      if (event.method === 'thread/resume' && event.threadId === this.record.nativeId && !this.terminalSwitch) return;
      if (!this.record.nativeId) return;
      this.pendingTerminalContext = null; this.terminalSwitch = event.key; this.chatAvailable = false;
      this.emit('contextEnd', { nativeId: this.record.nativeId, reason: 'terminal-switch' });
      this.emit('capability'); return;
    }
    if (event.kind === 'uncertain') {
      this.chatAvailable = false;
      if (this.record.nativeId) this.emit('contextEnd', { nativeId: this.record.nativeId, reason: 'terminal-switch' });
      this.emit('capability'); return;
    }
    if (event.kind !== 'response') return;
    if (event.error) {
      if (this.terminalSwitch === event.key) this.emit('activity', '原生切换未确认，旧记录和草稿保留；请在同屏终端核对。');
      return;
    }
    const thread = event.result?.thread;
    if (!thread || !/^[a-f0-9-]{36}$/i.test(thread.id || '') || thread.ephemeral || thread.parentThreadId) return;
    if (!this.record.nativeId) {
      this.terminalNotificationSource = true; this.terminalRpc = event.rpc;
      const settings = this.terminalSettingsRequest?.key === event.key ? this.terminalSettingsRequest.previous : this.nativeSettings;
      this.initialTerminalThread?.(thread, event.result.model); this.initialTerminalThread = null;
      this.observeReplySettings(event.result, settings); this.emit('capability'); return;
    }
    if (event.method === 'thread/resume' && thread.id === this.record.nativeId && !this.terminalSwitch) {
      this.terminalRpc = event.rpc;
      if (this.terminalSettingsRequest?.key === event.key) this.observeReplySettings(event.result, this.terminalSettingsRequest.previous);
      return;
    }
    if (this.terminalSwitch !== event.key) return;
    const existing = this.host.codexTargets.get(thread.id);
    if (existing && existing !== this) {
      this.emit('activity', '终端已切换到另一个已列出的会话。请选择那个会话继续；旧记录与草稿保留。'); return;
    }
    this.pendingTerminalContext = event;
    const previousId = this.record.nativeContextPending?.nativeId || this.record.nativeId;
    const info = { previousId, nativeId: thread.id, reason: 'terminal-switch', model: event.result.model || thread.model || '原生未报告', cwd: thread.cwd };
    this.emit('contextClear', info);
    if (!info.committed || this.record.nativeId !== thread.id) return;
    this.pendingTerminalContext = null; this.terminalSwitch = null; ++this.lifecycleRevision;
    this.terminalNotificationSource = true; this.terminalRpc = event.rpc; this.nativeObservationPending = false;
    if (previousId !== thread.id && this.host.codexTargets.get(previousId) === this) this.host.codexTargets.delete(previousId);
    this.host.codexTargets.set(thread.id, this); this.nativeSessionId = thread.sessionId; this.emit('workspaceMcpProof');
    this.pending = null; this.turnId = null; this.turns.clear(); this.ownInputs.clear(); this.inputItems.clear();
    this.activeNativeItems.clear(); this.nativeTextParts.clear(); this.liveTextItems.clear();
    this.liveMessageItems.clear(); this.historyMessageItems.clear(); this.liveToolItems.clear(); this.textEndedTurns.clear();
    this.nativeStartedAt = null; this.nativeTurnFinished = false; this.nativeWait = null; this.forgetNativeRequests();
    this.nativeSettings = null;
    this.observeReplySettings(event.result, null);
    this.record.addressedToolVersion = null; this.addressedSendAvailable = false;
    this.hasHistory = Array.isArray(thread.turns) && thread.turns.length > 0;
    this.chatAvailable = false; this.observeStatus(thread.status);
    if (typeof thread.name === 'string') this.emit('nativeTitle', thread.name);
    const revision = this.lifecycleRevision;
    this.observing = (event.method === 'thread/start' && Array.isArray(thread.turns) && thread.turns.length === 0 ? Promise.resolve(true) : this.hydrateHistory(thread.id, revision, true)).then(ok => {
      if (ok && revision === this.lifecycleRevision && !this.stopped && !this.transportDisconnected) {
        this.hasHistory = this.record.messages.some(m => m.nativeId === thread.id && m.kind !== 'gap' && m.role !== 'system');
        this.chatAvailable = true; this.emit('capability');
      }
    }).catch(error => {
      if (revision !== this.lifecycleRevision || this.stopped || this.transportDisconnected) return;
      this.emit('activity', '新原生上下文已确认，图形连接尚未完成；请在同屏终端继续。');
      this.emit('capability');
    });
  }
  retryContext() {
    const candidate = this.pendingTerminalContext;
    if (candidate?.rpc?.connected && candidate.key === this.terminalSwitch) this.observeTerminalContext(candidate);
  }
  get nativeActivity() {
    if (!this.turnId || this.nativeTurnFinished || this.stopped || this.transportDisconnected || !['working', 'approval'].includes(this.latestState)) return null;
    if (this.nativeObservationPending) return { nativeId: this.record.nativeId, turnId: this.turnId, stale: true };
    const labels = { commandExecution: 'commandExecution', fileChange: 'fileChange', mcpToolCall: 'mcpToolCall', dynamicToolCall: 'dynamicToolCall', webSearch: 'webSearch', reasoning: 'reasoning', plan: 'plan', agentMessage: 'agentMessage' };
    const kinds = [...this.activeNativeItems.values()];
    const kind = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'reasoning', 'plan', 'agentMessage'].find(type => kinds.includes(type));
    return { nativeId: this.record.nativeId, turnId: this.turnId, startedAt: this.nativeStartedAt,
      label: this.nativeWait || (this.nativeRetry === this.turnId ? 'willRetry' : '') || labels[kind] || 'inProgress' };
  }
  publishNativeActivity() {
    const label = this.nativeActivity?.label || '';
    if (label !== this.publishedNativeActivity) { this.publishedNativeActivity = label; this.emit('activity', label); }
  }
  observeNativeItem(method, params) {
    if (params.turnId !== this.turnId || !params.item?.id) return;
    this.stateRevision++; // A delayed resume status predates these native events.
    if (method === 'item/started') {
      if (this.activeNativeItems.size < 200) this.activeNativeItems.set(params.item.id, params.item.type);
      if (params.item.type === 'mcpToolCall' && params.item.server === 'native_workspace' && params.item.tool === 'workspace_message') {
        this.workspaceMcpCalls ||= new Map();
        if (this.workspaceMcpCalls.size < 64) this.workspaceMcpCalls.set(params.item.id, { turnId: params.turnId, arguments: params.item.arguments });
        this.emit('workspaceMcpProof');
      }
    } else { this.activeNativeItems.delete(params.item.id); this.workspaceMcpCalls?.delete(params.item.id); }
    this.publishNativeActivity();
  }
  observeStatus(status) {
    this.nativeWait = status?.activeFlags?.includes('waitingOnUserInput') ? 'waitingOnUserInput' : status?.activeFlags?.includes('waitingOnApproval') ? 'waitingOnApproval' : null;
    if (status?.type === 'idle') this.emit('state', 'idle');
    else if (status?.type === 'active') this.emit('state', status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'approval' : 'working');
    else if (status?.type === 'systemError') this.emit('state', 'error');
    else { this.emit('state', 'starting'); this.emit('activity', '原生状态尚未确认，请在原生终端查看。'); return; }
    this.publishNativeActivity();
  }
  forgetNativeRequests() {
    for (const request of this.nativeRequests.values()) this.emit('progress', { id: request.id, source: 'codex-native', status: 'unknown', title: '原生确认结果未确认' });
    this.nativeRequests.clear();
    this.terminalRequestKeys?.clear();
  }
  currentRpc(rpc) { return rpc === this.host.rpc || Boolean(rpc && rpc === this.terminalRpc && rpc.connected); }
  nativeRequestKey(id, rpc, create = false) {
    if (rpc === this.host.rpc) return id;
    this.terminalRequestKeys ||= new Map();
    if (create && !this.terminalRequestKeys.has(id)) this.terminalRequestKeys.set(id, { id });
    return this.terminalRequestKeys.get(id);
  }
  event(message, sourceRpc = this.host.rpc) {
    const context = message.params?.threadId || message.params?.thread?.id;
    if (context && context !== this.record.nativeId) return;
    if (this.record.nativeContextPending || !this.currentRpc(sourceRpc)) return;
    if (this.transportDisconnected) return;
    const p = message.params || {};
    if (this.nativeRetry && p.turnId === this.nativeRetry && message.method.startsWith('item/') && message.id === undefined) {
      this.nativeRetry = null; this.publishNativeActivity();
    }
    this.eventRevision++;
    // Pin live item provenance at its first start. A later user input never
    // reassigns an old streaming item or a late completion to the new prompt.
    const liveTurn = p.turnId && p.turnId === this.turnId ? this.turn(p.turnId) : null;
    if (liveTurn && message.method === 'item/completed' && p.item?.type === 'userMessage' && p.item.id && !liveTurn.inputItems.has(p.item.id)) {
      liveTurn.inputItems.add(p.item.id);
      liveTurn.inputTag = this.ownInputs.has(p.item.clientId) ? p.item.clientId : '';
      if (this.steering?.tag === liveTurn.inputTag && this.steering.turnId === p.turnId) this.steering.inputSeen = true;
      if (this.pending?.steered && this.pending.tag === liveTurn.inputTag && this.pending.turnId === p.turnId) {
        this.emit('replyBound', { tag: this.pending.tag, nativeId: this.record.nativeId, turnId: p.turnId, inputTag: liveTurn.inputTag });
      }
    }
    const itemId = p.item?.id || p.itemId;
    if (liveTurn && typeof itemId === 'string' && itemId && p.item?.type !== 'userMessage' &&
      !liveTurn.itemInputs.has(itemId) && liveTurn.itemInputs.size < 4096) {
      // A missing/late start is not permission to reassign an existing item.
      // Pin unknown on its first delta, completion, progress, or history row.
      const existing = this.historyMessageItems.has(itemId) || this.record.messages?.some(row => row.id === itemId || row.id === `native:${this.record.nativeId}:tool:${itemId}` || row.id === `native:${this.record.nativeId}:summary:${itemId}` || row.id === `native:${this.record.nativeId}:plan:${itemId}`);
      liveTurn.itemInputs.set(itemId, message.method === 'item/started' && !existing ? liveTurn.inputTag || '' : '');
    }
    const inputTag = liveTurn?.itemInputs.get(itemId) || '';
    if (message.method === 'thread/closed') {
      this.forgetNativeRequests();
      this.closed = true; this.stopped = true; this.finishRecoveryConnection?.(false); this.host.codexTargets.delete(this.record.nativeId); this.emit('state', 'ended'); return;
    }
    if (this.stopped) return;
    if (['item/started', 'item/completed'].includes(message.method)) this.observeNativeItem(message.method, p);
    if (message.method === 'item/completed' && p.item?.type === 'userMessage' &&
      p.turnId && this.ownInputs.has(p.item.clientId)) {
      this.nativeAcceptedInput = { turnId: p.turnId, tag: p.item.clientId, rpc: this.host.rpc, lifecycle: this.lifecycleRevision };
      this.emit('nativeAcceptedInput');
    }
    if (['item/started', 'item/completed'].includes(message.method) && p.item?.type && !['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(p.item.type)) {
      const item = p.item;
      this.liveToolItems.add(item.id);
      const fleetActivity = item.type === 'subAgentActivity';
      const fleetTitle = item.kind || '';
      this.emit('progress', { id: item.id, turnId: p.turnId, inputTag, source: 'codex-native', kind: item.type,
        title: fleetActivity ? `${fleetTitle}${item.agentPath ? ' · ' + item.agentPath : ''}` : item.command || item.tool || item.type,
        status: fleetActivity ? 'observed' : toolStatus(item, message.method === 'item/completed'),
        ...toolContent(item, message.method === 'item/completed'),
        ...(item.type === 'imageView' ? { imageCwd: this.nativeSettings?.cwd || this.record.cwd } : {}),
      });
    }
    if (['item/commandExecution/outputDelta', 'item/mcpToolCall/progress'].includes(message.method) && !this.historyMessageItems.has(p.itemId)) {
      this.liveToolItems.add(p.itemId);
      this.emit('progress', {
        id: p.itemId, turnId: p.turnId, inputTag, source: 'codex-native', kind: message.method === 'item/commandExecution/outputDelta' ? 'commandExecution' : 'mcpToolCall',
        ...(typeof p.delta === 'string' ? { delta: p.delta } : { text: p.message || '' }),
      });
    }
    if (message.method === 'item/fileChange/patchUpdated') {
      this.liveToolItems.add(p.itemId);
      this.emit('progress', {
        id: p.itemId, turnId: p.turnId, inputTag, source: 'codex-native', kind: 'fileChange', title: '',
        ...fileChanges(p.changes),
      });
    }
    // Public native text items share one lifecycle. Raw reasoning is excluded;
    // a proposed plan is display content, never permission to execute it.
    const textLifecycle = ['item/started', 'item/completed'].includes(message.method) && ['reasoning', 'plan'].includes(p.item?.type);
    if (textLifecycle || ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/plan/delta'].includes(message.method)) {
      if (typeof itemId === 'string' && itemId && typeof p.turnId === 'string' && p.turnId && !this.textEndedTurns.has(p.turnId)) {
        this.stateRevision++; // Live text invalidates an older resume status.
        const type = textLifecycle ? p.item.type : message.method === 'item/plan/delta' ? 'plan' : 'reasoning';
        const content = nativeTextContent({ ...p.item, type });
        const completed = message.method === 'item/completed';
        let parts = this.nativeTextParts.get(itemId);
        if (parts && (parts.turnId !== p.turnId || parts.kind !== content.kind)) return;
        const emitText = (text, status) => this.emit('nativeBlock', { id: `${content.kind}:${itemId}`, nativeId: this.record.nativeId,
          kind: content.kind, turnId: p.turnId, inputTag, title: content.title, text, status });
        if (completed) {
          if (content.text || parts) emitText(content.text, 'complete');
          this.liveTextItems.add(itemId); this.nativeTextParts.delete(itemId);
        } else if (!this.historyMessageItems.has(itemId) && !this.liveTextItems.has(itemId)) {
          // Without a watermark, wait for the authoritative completed item.
          if (!parts && this.nativeTextParts.size < 4096) {
            parts = { turnId: p.turnId, kind: content.kind, sections: new Map() }; this.nativeTextParts.set(itemId, parts);
          }
          if (parts) {
            if (textLifecycle) {
              const sections = type === 'plan' ? [content.text] : p.item.summary;
              if (Array.isArray(sections)) sections.forEach((text, i) => { if (typeof text === 'string' && !parts.sections.has(i)) parts.sections.set(i, text); });
            }
            const index = type === 'plan' ? 0 : p.summaryIndex;
            if (Number.isSafeInteger(index) && index >= 0 && index < 4096 && typeof p.delta === 'string') {
              parts.sections.set(index, (parts.sections.get(index) || '') + p.delta);
            }
            const text = [...parts.sections].sort((a, b) => a[0] - b[0]).map(part => part[1]).join('\n\n');
            if (text) emitText(text, 'streaming');
          }
        }
      }
    }
    if (message.method === 'error') this.emit('progress', { source: 'codex-native', kind: message.method, title: '原生会话错误', status: 'failed' });
    if (message.id !== undefined && message.method === 'item/tool/call' && p.tool === require('./addressed-handoffs.cjs').TOOL && p.namespace === require('./addressed-handoffs.cjs').NAMESPACE) {
      // Only the connected native root supplies identity. Never take a sender
      // ID from model arguments or treat another dynamic tool as ours.
      let result, success = false;
      try {
        if (!this.addressedSendAvailable || this.transportDisconnected || p.threadId !== this.record.nativeId || p.turnId !== this.turnId || !this.addressedCall) throw Error('当前原生连接不支持定向协作。');
        result = this.addressedCall({ nativeId: p.threadId, turnId: p.turnId, callId: p.callId }, p.arguments); success = true;
        if (result?.then) {
          result.then(value => sourceRpc.reply(message.id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] }), error => sourceRpc.reply(message.id, { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'unconfirmed', message: error.message }) }] })).catch(() => {});
          return;
        }
      } catch (error) {
        try { this.addressedFailed?.({ nativeId: p.threadId, turnId: p.turnId, callId: p.callId }); } catch { /* Not this authorized root turn. */ }
        result = { status: 'not-sent', message: error.message };
      }
      sourceRpc.reply(message.id, { success, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] });
      return;
    }
    if (message.id !== undefined) {
      const key = this.nativeRequestKey(message.id, sourceRpc, true);
      let request = this.nativeRequests.get(key);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([message.method, p])).digest('hex');
      if (request?.rpc === sourceRpc) {
        // Duplicate delivery must not reopen a decision that is already pending.
        // A reused unresolved ID with different contents is ambiguous; only the
        // native client can safely interpret it.
        if (request.fingerprint !== fingerprint && !request.ambiguous) {
          request.ambiguous = true;
          this.emit('progress', { id: request.id, source: 'codex-native', status: 'unknown', title: '原生确认需要核对' });
          this.emit('approval', { requestId: message.id, method: 'native/requestAmbiguous', params: { reason: '原生确认标识重复且内容变化；请在原生终端核对。' } }, sourceRpc);
          this.emit('state', 'approval');
        }
        return;
      }
      if (!request || request.rpc !== sourceRpc) {
        request = { id: crypto.randomUUID(), rpc: sourceRpc, fingerprint };
        this.nativeRequests.set(key, request);
        // Match the bounded progress journal, without storing request bodies.
        while (this.nativeRequests.size > 200) {
          const oldest = this.nativeRequests.keys().next().value; this.nativeRequests.delete(oldest);
          if (oldest && typeof oldest === 'object' && this.terminalRequestKeys?.get(oldest.id) === oldest) this.terminalRequestKeys.delete(oldest.id);
        }
      }
      const nonBlocking = message.method === 'item/tool/requestUserInput' && p.isBlocking === false;
      if (message.method === 'item/tool/requestUserInput') request.question = this.rememberQuestion(p);
      if (!nonBlocking) this.nativeWait = message.method.endsWith('/requestUserInput') ? 'waitingOnUserInput' : 'waitingOnApproval';
      this.emit('progress', { id: request.id, source: 'codex-native', kind: message.method, title: nonBlocking ? '原生问题（此问题不阻塞本轮）' : '等待原生确认', status: 'waiting' });
      this.emit('approval', { requestId: message.id, method: message.method, params: p }, sourceRpc); if (!nonBlocking) this.emit('state', 'approval'); this.publishNativeActivity(); return;
    }
    switch (message.method) {
      case 'thread/settings/updated': this.observeSettings(p.threadSettings); break;
      case 'serverRequest/resolved': {
        const key = this.nativeRequestKey(p.requestId, sourceRpc), request = this.nativeRequests.get(key);
        if (!request || request.rpc !== sourceRpc) break;
        this.nativeRequests.delete(key);
        if (request.question) this.emit('nativeBlock', { id: request.question.id, nativeId: this.record.nativeId,
          turnId: request.question.turnId, kind: 'notice', title: '原生问题 · 已处理', status: 'complete' });
        if (sourceRpc !== this.host.rpc) this.terminalRequestKeys?.delete(p.requestId);
        this.emit('progress', { id: request.id, source: 'codex-native', status: 'resolved', title: '原生确认已处理' });
        this.emit('approvalResolved', p.requestId, sourceRpc);
        break;
      }
      case 'thread/status/changed': this.observeStatus(p.status); break;
      // A native rename, or the TUI naming an unnamed thread with its generated title.
      case 'thread/name/updated': if (p.threadId === this.record.nativeId && typeof p.threadName === 'string') this.emit('nativeTitle', p.threadName); break;
      case 'turn/started':
        this.workspaceMcpCalls?.clear();
        this.emit('nativeTurnStart', { nativeId: this.record.nativeId, turnId: p.turn.id });
        this.turnId = p.turn.id; this.activeNativeItems.clear(); this.nativeWait = null; this.nativeRetry = null; this.nativeTurnFinished = false;
        this.turn(p.turn.id).liveStarted = true;
        this.nativeStartedAt = Number.isFinite(p.turn.startedAt) && p.turn.startedAt > 0 ? p.turn.startedAt * 1000 : null;
        this.emit('state', 'working'); this.publishNativeActivity(); break;
      case 'item/agentMessage/delta':
        this.stateRevision++; // Live work invalidates an older resume status.
        if (!this.historyMessageItems.has(p.itemId)) { this.liveMessageItems.add(p.itemId); this.emit('delta', { id: p.itemId, text: p.delta, turnId: p.turnId, inputTag }); }
        break;
      case 'item/started':
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
        if (p.item?.type === 'agentMessage') { this.liveMessageItems.add(p.item.id); this.turn(p.turnId).text = p.item.text || ''; this.turn(p.turnId).messageId = p.item.id; this.emit('messageItem', { id: p.item.id, text: p.item.text || '', phase: p.item.phase, turnId: p.turnId, inputTag }); }
        // A human may steer an active GUI turn from the native terminal. Only
        // our explicitly identified echo is redundant; matching text is not ID.
        if (p.item?.type === 'userMessage' && !this.ownInputs.has(p.item.clientId) && (!p.item.id || !this.inputItems.has(p.item.id))) {
          if (p.item.id) this.inputItems.add(p.item.id);
          this.emit('nativeInput', (p.item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'), { id: p.item.id, turnId: p.turnId });
        }
        if (p.item?.type === 'userMessage' && p.item.id) {
          const images = require('./native-images.cjs').userImageReferences(p.item.content);
          if (images.length) this.emit('nativeInputImages', { id: p.item.id, nativeId: this.record.nativeId,
            clientId: this.ownInputs.has(p.item.clientId) ? p.item.clientId : undefined,
            cwd: this.nativeSettings?.cwd || this.record.cwd, images });
        }
        break;
      case 'thread/tokenUsage/updated': this.emit('usage', p.tokenUsage ? { ...p.tokenUsage, threadId: p.threadId, turnId: p.turnId, reportedAt: Date.now() } : null); break;
      case 'turn/completed': {
        if (p.threadId !== this.record.nativeId) break;
        if (p.turn.id === this.turnId) { this.nativeTurnFinished = true; this.activeNativeItems.clear(); this.nativeWait = null; this.publishNativeActivity(); }
        this.textEndedTurns.add(p.turn.id);
        for (const [id, parts] of this.nativeTextParts) if (parts.turnId === p.turn.id) this.nativeTextParts.delete(id);
        const block = codexTurnBlock(this.record.nativeId, p.turn);
        if (block) this.emit('nativeBlock', { ...block, inputTag: this.turn(p.turn.id).inputTag || '' });
        const turn = this.turn(p.turn.id);
        const errorText = [p.turn.error?.message, p.turn.error?.additionalDetails].filter(value => typeof value === 'string' && value).join('\n\n');
        // Completion can be our first observed error. Keep its native body;
        // an identical preceding error notice already carries the full text.
        if (errorText && errorText !== turn.errorText) this.emit('nativeBlock', { id: `notice:terminal-error:${p.turn.id}`, nativeId: this.record.nativeId, kind: 'notice', turnId: p.turn.id, title: '', text: errorText, status: 'complete' });
        turn.completed = p.turn;
        // Events can arrive before the RPC acknowledgement names our turn.
        // Wait for that identity instead of assigning whichever turn finishes.
        if (!this.pending || this.pending.turnId) this.finishTurn(p.turn.id);
        break;
      }
      case 'error': {
        const text = [p.error?.message, p.error?.additionalDetails].filter(value => typeof value === 'string' && value).join('\n\n');
        if (text) this.emit('nativeBlock', { id: `notice:error:${p.turnId || crypto.randomUUID()}`, nativeId: this.record.nativeId, kind: 'notice', turnId: p.turnId,
          title: '', text, status: 'complete' });
        const turn = this.turns.get(p.turnId); if (turn && text) turn.errorText = text;
        if (!p.turnId || p.turnId === this.turnId) {
          if (p.willRetry === true) { this.nativeRetry = this.turnId; this.publishNativeActivity(); }
          else this.emit('failed', '原生会话返回错误，请检查原文或同屏终端。');
        }
        break;
      }
      case 'warning':
        if (typeof p.message === 'string') this.emit('nativeBlock', { id: `notice:warning:${crypto.randomUUID()}`, nativeId: this.record.nativeId, kind: 'notice', title: '', text: p.message, status: 'complete' });
        break;
    }
  }
  turn(id) { if (!this.turns.has(id)) this.turns.set(id, { text: '', inputItems: new Set(), itemInputs: new Map(), inputTag: '' }); return this.turns.get(id); }
  finishTurn(id) {
    const turn = this.turns.get(id); if (!turn?.completed || this.steering?.turnId === id || this.pendingSteer && this.turnId === id) return;
    const live = turn.liveStarted === true && this.turnId === id && !this.stopped && !this.transportDisconnected;
    const pending = this.pending?.turnId === id ? this.pending : null;
    if (pending) this.pending = null;
    this.turns.delete(id); this.hasHistory = true;
    if (this.turnId === id) { this.turnId = null; this.emit('state', 'idle'); }
    if (turn.completed.status !== 'completed') this.emit('failed', '原生回合中断或失败；协作已暂停。', { tag: pending?.tag, supersededTag: pending?.supersededTag });
    else this.emit('complete', { tag: pending?.tag, supersededTag: pending?.supersededTag, messageId: turn.messageId, inputTag: turn.itemInputs.get(turn.messageId) || '', text: turn.text, background: null, scheduled: null, fleetPending: null, stopHookActive: null });
    if (live) this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId: id, status: turn.completed.status, errorInfo: turn.completed.error?.codexErrorInfo, errorMessage: turn.completed.error?.message });
  }
  get steerAvailable() { return verifiedCodexProtocol(this.host.rpc) && this.chatAvailable && !this.stopped && !this.transportDisconnected; }
  async steer(text, tag, expectedTurnId, guard, shared = false, acceptedGuard = guard) {
    if (!this.steerAvailable || !expectedTurnId || this.turnId !== expectedTurnId || this.nativeRequests.size || this.steering || !guard()) throw Error('当前原生回合已变化；追加指令未发送，草稿保留。');
    this.ownInputs.add(tag);
    const operation = this.steering = { tag, turnId: expectedTurnId, inputSeen: false };
    const previous = this.pending, lifecycle = this.lifecycleRevision;
    try {
      // Native expectedTurnId is the atomic precondition. No new-turn fallback.
      const receipt = await this.host.rpc.call('turn/steer', { threadId: this.record.nativeId, expectedTurnId, clientUserMessageId: tag, input: [{ type: 'text', text, text_elements: [] }] });
      if (receipt?.turnId !== expectedTurnId) throw Error('原生追加指令接收结果未确认；请核对终端，不会重发。');
      this.emit('submitted', tag);
      if (shared && this.pending === previous && lifecycle === this.lifecycleRevision && !this.stopped && !this.transportDisconnected && acceptedGuard()) {
        this.pending = { tag, turnId: expectedTurnId, steered: true, supersededTag: previous?.supersededTag || previous?.tag };
        if (operation.inputSeen && this.turns.get(expectedTurnId)?.inputTag === tag) this.emit('replyBound', { tag, nativeId: this.record.nativeId, turnId: expectedTurnId, inputTag: tag });
      }
      return expectedTurnId;
    } finally {
      if (this.steering === operation) this.steering = null;
      this.finishTurn(expectedTurnId);
    }
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
      this.emit('replyBound', { tag, nativeId: this.record.nativeId, turnId: pending.turnId });
      for (const id of this.turns.keys()) this.finishTurn(id);
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      if (lifecycle === this.lifecycleRevision) for (const id of this.turns.keys()) this.finishTurn(id);
      throw error;
    }
    if (this.needsSubscription) {
      try { await this.observeAcceptedTurn(pending.turnId, tag); }
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
  async observeAcceptedTurn(turnId, inputTag) {
    if (this.stopped || !turnId) throw Error('原生观察连接已变化。');
    const revision = this.stateRevision, lifecycle = this.lifecycleRevision, rpc = this.host.rpc, settings = this.nativeSettings;
    let result;
    try { result = await rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true }); }
    catch (error) {
      // Some retained TUI-backed 0.163.0 threads cannot list turns during their
      // first live input. The same connection can already deliver that input's
      // native events. Require its exact client ID and accepted turn, never an
      // ACK alone, arbitrary delta, private input, or a different connection.
      if (!error.nativeUnsupportedTurns || rpc?.nativeVersion !== '0.163.0' || !inputTag) throw error;
      const observed = () => !this.stopped && !this.transportDisconnected && lifecycle === this.lifecycleRevision &&
        this.host.rpc === rpc && this.nativeAcceptedInput?.rpc === rpc && this.nativeAcceptedInput.lifecycle === lifecycle &&
        this.nativeAcceptedInput.turnId === turnId && this.nativeAcceptedInput.tag === inputTag;
      if (!observed()) await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.off('nativeAcceptedInput', accepted); this.off('state', changed); };
        const accepted = () => { if (observed()) { cleanup(); resolve(); } };
        const changed = state => { if (['ended', 'disconnected', 'error'].includes(state)) { cleanup(); reject(error); } };
        const timer = setTimeout(() => { cleanup(); reject(error); }, 2000);
        this.on('nativeAcceptedInput', accepted); this.on('state', changed); accepted();
      });
      if (!observed()) throw error;
      this.needsSubscription = false; this.hasHistory = true;
      return;
    }
    if (this.stopped || lifecycle !== this.lifecycleRevision || result.thread?.id !== this.record.nativeId) throw Error('原生观察连接已变化。');
    this.observeReplySettings(result, settings);
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
    this.forgetNativeRequests();
    this.backendExitConfirmed = true;
    this.transportDisconnected = false;
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
  async openTerminal(guard = () => true) {
    if (!guard()) throw new Error('终端控制权已变化，请重新选择会话。');
    if (this.recoveryReady && !this.hasHistory && !await this.recoveryReady) throw new Error('原生会话恢复尚未确认，请检查恢复状态后重试。');
    if (this.stopped) throw new Error('本应用已断开该会话；原生历史仍保留。');
    if (this.terminal?.alive) return this.terminal;
    if (this.backendExitConfirmed || this.transportDisconnected) throw new Error('原生连接已断开，请先恢复会话。');
    if (this.terminal && !this.terminal.nativeExited) throw new Error('旧终端退出尚未确认，暂不启动另一个终端。');
    if (!this.record.nativeId) { for (let i = 0; i < 100 && !this.terminal; i++) await delay(50); if (this.terminal) return this.terminal; }
    if (!this.hasHistory) {
      // A first turn may already be waiting for a native-only permission. Read
      // its actual rollout rather than demanding that blocked turn finish.
      // Never create a seed turn or change native permissions to attach a TUI.
      const rpc = this.host.rpc, revision = this.lifecycleRevision, id = this.record.nativeId;
      let thread, missingHistory = false;
      try {
        const paginated = verifiedCodexProtocol(rpc);
        ({ thread } = await rpc.call('thread/read', { threadId: id, includeTurns: !paginated }));
        if (paginated) {
          // This native version paginates turns separately. Metadata alone
          // cannot prove a rollout exists or that a first turn has started.
          if (thread?.id === id) {
            let page;
            try { page = await rpc.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full' }); }
            catch (error) { if (error.nativeUnmaterializedThread !== id) throw error; page = { data: [] }; }
            if (!Array.isArray(page?.data) || page.data.length > 1) throw new Error('原生历史尚未确认，请重新打开终端。');
            thread = { ...thread, turns: page.data };
          }
        }
      } catch (error) { if (!error.nativeMissingHistory || error.nativeMissingHistoryThread !== id) throw error; missingHistory = true; }
      if (this.stopped || this.transportDisconnected || this.host.rpc !== rpc || this.lifecycleRevision !== revision || this.record.nativeId !== id) throw new Error('原生连接已变化，请重新打开终端。');
      if (missingHistory || thread?.id === id && Array.isArray(thread.turns) && !thread.turns.length) throw new Error('请先在对话中发送第一条消息，再打开同一会话的原生终端。');
      if (thread?.id !== id || !Array.isArray(thread.turns) || !thread.turns.every(turn => typeof turn?.id === 'string' && turn.id.trim())) throw new Error('原生历史尚未确认，请重新打开终端。');
      this.hasHistory = true;
    }
    // Another attachment can finish while the initial rollout read is pending.
    if (!guard()) throw new Error('终端控制权已变化，请重新选择会话。');
    if (this.terminal?.alive) return this.terminal;
    const endpoint = await this.terminalEndpoint();
    if (!guard() || this.stopped || this.transportDisconnected) throw new Error('终端控制权已变化，请重新选择会话。');
    if (this.terminal?.alive) return this.terminal;
    return this.makeTerminal([this.host.codexBinary || this.host.binaries.codex, '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', 'resume', '--remote', `unix://${endpoint}`, '-C', this.record.cwd, this.record.nativeId]);
  }
  async reconnect() {
    const transportOnly = Boolean(this.transportDisconnected);
    if ((!this.stopped && !transportOnly) || this.closed || !this.record.nativeId) throw new Error('原生连接状态已改变，请重新查看。');
    const lifecycle = ++this.lifecycleRevision;
    let rpc, child;
    const current = () => lifecycle === this.lifecycleRevision && !this.stopped &&
      (!rpc || (this.host.rpc === rpc && this.host.codexProcess === child));
    // Re-subscribe to the owned thread. Omit every configuration override:
    // thread/resume is not a new thread or a turn/start request.
    this.chatAvailable = false; this.stopped = false;
    this.pending = null; this.turnId = null; this.turns.clear();
    this.liveMessageItems.clear(); this.liveToolItems.clear(); this.liveTextItems.clear(); this.nativeTextParts.clear();
    this.rememberHistoryWatermarks();
    this.host.codexTargets.set(this.record.nativeId, this);
    const revision = this.stateRevision;
    try {
      if (transportOnly) await this.host.reconnectCodex();
      if (!current()) throw new Error('原生连接已经变化；没有重发任务。');
      rpc = this.host.rpc; child = this.host.codexProcess;
      this.transportDisconnected = false;
      const settings = this.nativeSettings;
      let result;
      try { result = await rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true }); }
      catch (error) {
        if (!error.nativeMissingHistory || this.hasHistory || this.record.messages?.length || !current()) throw error;
        // Native creates its rollout on the first actual input. Confirm the
        // owned empty thread is still live; no synthetic turn to make history.
        const { thread } = await rpc.call('thread/read', { threadId: this.record.nativeId, includeTurns: false });
        if (!current() || thread?.id !== this.record.nativeId || thread.preview || thread.status?.type !== 'idle') throw error;
        this.needsSubscription = true; this.chatAvailable = true;
        if (revision === this.stateRevision) this.observeStatus(thread.status);
        this.emit('capability');
        return;
      }
      if (result.thread?.id !== this.record.nativeId) throw new Error('原生返回了不同的会话，恢复未确认。');
      if (!current()) throw new Error('原生连接已经关闭；没有重发任务。');
      this.hasHistory = true; this.needsSubscription = false;
      this.emit('pid', this.terminal?.alive && this.terminal.pid ? this.terminal.pid : this.host.codexProcess.pid);
      this.observeReplySettings(result, settings);
      if (revision === this.stateRevision) this.observeStatus(result.thread.status);
      if (!await this.hydrateHistory(this.record.nativeId, lifecycle) || !current()) throw new Error('连接在同步记录时断开；没有重发任务。');
      this.nativeObservationPending = false; this.chatAvailable = true; this.emit('capability');
    } catch (error) {
      if (lifecycle === this.lifecycleRevision) {
        this.chatAvailable = false; this.stopped = !transportOnly;
        this.transportDisconnected = transportOnly;
        if (!this.closed) this.emit('state', transportOnly ? 'error' : 'disconnected');
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
  transportClosed() {
    if (this.closed || this.backendExitConfirmed) return;
    this.forgetNativeRequests();
    this.transportDisconnected = true; this.chatAvailable = false; this.lifecycleRevision++;
    this.finishRecoveryConnection?.(false);
    this.emit('activity', '图形连接已断开；原生任务可能仍在运行。可重新连接，已有终端保持原样，不会重发任务。');
    this.emit('state', this.stopped ? 'disconnected' : 'error');
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
      this.forgetNativeRequests();
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

// Native WS notifications and MCP stdio use different transports. Wait on the
// existing runtime events, within the socket deadline, rather than guessing a
// sender when the authoritative item notification has not arrived yet.
async function workspaceMcpProof(runtime, identity, args, socket) {
  const check = () => {
    if (runtime.stopped || runtime.transportDisconnected || socket.destroyed) throw Error('原生连接已变化，未登记自动消息。');
    const call = runtime.workspaceMcpCalls?.get(identity.callId);
    if (!call || !runtime.nativeSessionId) return false;
    if (identity.sessionId !== runtime.nativeSessionId || identity.turnId !== runtime.turnId || call.turnId !== identity.turnId ||
        !call.arguments || call.arguments.recipient_id !== args?.recipient_id || call.arguments.message !== args?.message) throw Error('本次原生主会话工具来源未能确认。');
    return call;
  };
  const ready = check(); if (ready) return ready;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { runtime.off('workspaceMcpProof', observed); runtime.off('nativeTurnEnd', ended); socket.off('close', closed); error ? reject(error) : resolve(value); };
    const observed = () => { try { const value = check(); if (value) finish(null, value); } catch (e) { finish(e); } };
    const ended = info => { if (info.turnId === identity.turnId) finish(Error('原生回合已结束，未登记自动消息。')); };
    const closed = () => finish(Error('自动消息来源等待已结束；接收结果未确认。'));
    runtime.on('workspaceMcpProof', observed); runtime.on('nativeTurnEnd', ended); socket.once('close', closed);
    observed();
  });
}

class NativeHost {
  constructor(privateDir) {
    this.privateDir = privateDir; this.hookSocket = path.join(privateDir, 'hooks.sock');
    this.submitSocket = path.join(privateDir, 'submit.sock');
    this.codexSocket = path.join(privateDir, 'codex.sock'); this.hookTargets = new Map(); this.codexTargets = new Map();
    this.codexMessageToken = crypto.randomBytes(32).toString('hex');
    this.submissions = createSubmissionServer(this.submitSocket, this.hookTargets);
    this.binaries = { claude: executable('claude'), codex: executable('codex'), python: pythonExecutable() };
    this.hooks = net.createServer(socket => {
      socket.setEncoding('utf8');
      socket.setTimeout(2000, () => socket.destroy()); let data = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        data += chunk.toString(); if (data.length > 2 * 1024 * 1024) return socket.destroy();
        const end = data.indexOf('\n'); if (end < 0) return;
        let event;
        try { event = JSON.parse(data.slice(0, end)); } catch { return socket.end(); }
        if (event.workspaceMessage === true) {
          socket.removeAllListeners('data');
          socket.setTimeout(0); const deadline = setTimeout(() => socket.destroy(), 10000);
          socket.once('close', () => clearTimeout(deadline));
          Promise.resolve().then(async () => {
            const identity = event.identity, runtime = this.codexTargets.get(identity?.nativeId);
            const args = event.arguments;
            if (event.token !== this.codexMessageToken || this.rpc?.nativeVersion !== '0.165.0' || !runtime || !runtime.addressedCall) throw Error('本次原生主会话工具来源未能确认。');
            const call = await workspaceMcpProof(runtime, identity, args, socket);
            return runtime.addressedCall({ ...identity, valid: () => !socket.destroyed && runtime.workspaceMcpCalls?.get(identity.callId) === call }, args);
          }).then(result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); }, error => { if (!socket.destroyed) socket.end(JSON.stringify({ status: 'unconfirmed', message: error.message }) + '\n'); });
          return;
        }
        const target = this.hookTargets.get(event.token);
        if (event.ask && target?.ask) {
          // Hold only this connection until the person answers or hands it back.
          socket.setTimeout(0); let open = true; const closers = [];
          socket.on('close', () => { open = false; for (const closed of closers) closed(); });
          return target.ask(event, reply => { if (open) socket.end(JSON.stringify(reply) + '\n'); }, () => open, closed => closers.push(closed));
        }
        try { target?.hook(event); } catch {}
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
  watchCodexConnection(rpc, child) {
    const ws = rpc.ws;
    let initialized = false, retired = false;
    const current = () => !retired && !this.closed && this.codexProcess === child && this.rpc === rpc;
    const dispose = () => {
      child.removeListener('exit', retire); rpc.removeListener('event', event); rpc.removeListener('closed', closed);
    };
    const retire = () => {
      if (!initialized || !current() || (child.exitCode === null && child.signalCode === null) || ws.readyState !== WebSocket.CLOSED) return;
      retired = true; dispose();
      this.rpc = null; this.starting = null; this.codexProcess = null; this.codexBinary = null; this.codexEndpoint = null;
      const targets = new Set(this.codexTargets.values());
      if (this.pendingCodexRuntime) targets.add(this.pendingCodexRuntime);
      this.codexTargets.clear();
      for (const target of targets) target.backendExited().catch(() => {});
    };
    const event = message => {
      if (!current()) return;
      const p = message.params || {};
      if (message.method === 'warning' && !p.threadId) {
        for (const target of this.codexTargets.values()) if (!target.terminalNotificationSource) target.event(message);
        return;
      }
      if (message.method === 'thread/started' && !p.thread?.parentThreadId && this.pendingCodex && !this.pendingCodexRuntime?.terminalBridge) this.pendingCodex(p.thread);
      const target = this.codexTargets.get(p.threadId || p.thread?.id);
      if (target && (message.id !== undefined || !target.terminalNotificationSource)) target.event(message);
      else if (message.method === 'thread/started' && p.thread?.parentThreadId) {
        const parent = this.codexTargets.get(p.thread.parentThreadId);
        if (parent && !parent.transportDisconnected) parent.emit('fleet', { id: p.thread.id, event: 'thread/started', name: p.thread.agentNickname || 'Codex 子 agent' });
      }
    };
    const closed = () => {
      if (!current()) return;
      for (const target of this.codexTargets.values()) target.transportClosed();
      retire();
    };
    child.once('exit', retire); rpc.on('event', event); rpc.on('closed', closed);
    return {
      activate: () => {
        this.disposeCodexConnection?.();
        this.rpc = rpc; this.disposeCodexConnection = dispose;
        initialized = true; retire();
      },
      dispose,
    };
  }
  readCodexEndpoint() {
    const link = fs.lstatSync(this.codexSocket), resolved = fs.realpathSync(this.codexSocket);
    const socket = fs.lstatSync(resolved);
    if (link.uid !== process.getuid() || socket.uid !== process.getuid() || !socket.isSocket() ||
      (!link.isSocket() && !link.isSymbolicLink())) throw new Error('原生接口身份未确认，没有连接其他后台。');
    // Codex may publish a symlink. Keep both identities: an unchanged link
    // does not prove that its target still belongs to the original listener.
    return { resolved, linkDev: link.dev, linkIno: link.ino, socketDev: socket.dev, socketIno: socket.ino };
  }
  async reconnectCodex() {
    if (this.reconnecting) return this.reconnecting;
    const child = this.codexProcess, previous = this.rpc, endpoint = this.codexEndpoint;
    const owned = () => !this.closed && this.codexProcess === child && child &&
      child.exitCode === null && child.signalCode === null && this.rpc === previous;
    if (!owned()) throw new Error('原生后台身份已变化；请重新查看状态。');
    if (previous?.ws.readyState === WebSocket.OPEN) return;
    if (previous?.ws.readyState !== WebSocket.CLOSED || !endpoint) throw new Error('原生连接退出尚未确认；请稍后重试。');
    const sameEndpoint = () => {
      const now = this.readCodexEndpoint();
      if (Object.keys(endpoint).some(key => now[key] !== endpoint[key])) throw new Error('原生接口已变化；没有连接其他后台。');
    };
    this.reconnecting = Promise.resolve().then(async () => {
      let ws, watcher;
      try {
        if (!owned()) throw new Error('原生后台身份已变化；没有新建后台。');
        sameEndpoint();
        ws = new WebSocket('ws://localhost', { createConnection: () => net.connect(endpoint.resolved), maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD, handshakeTimeout: 10000 });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        const rpc = new Rpc(ws);
        watcher = this.watchCodexConnection(rpc, child);
        rpc.nativeVersion = serverVersion(await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } }));
        if (!owned() || ws.readyState !== WebSocket.OPEN) throw new Error('原生连接在确认时已变化；没有重发任务。');
        sameEndpoint();
        ws.send(JSON.stringify({ method: 'initialized', params: {} }));
        watcher.activate();
      } catch (error) {
        watcher?.dispose(); ws?.terminate();
        // A failed observer connection cannot stop the existing native server.
        throw error;
      }
    }).finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }
  async startCodex() {
    if (this.closed) throw new Error('原生服务已关闭。');
    if (this.rpc) return;
    if (this.starting) return this.starting;
    this.starting = Promise.resolve().then(async () => {
      let ws, rpc, child, spawnError, watcher;
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
      const mcpArgs = ['--disable-sigusr1', path.join(__dirname, 'claude-message-tool.cjs'), '--codex'];
      const mcpConfig = [
        ['command', process.execPath], ['args', mcpArgs], ['env.ELECTRON_RUN_AS_NODE', '1'],
        ['env.NAW_MESSAGE_SOCKET', this.hookSocket], ['env.NAW_MESSAGE_TOKEN', this.codexMessageToken],
      ].flatMap(([key, value]) => ['-c', `mcp_servers.native_workspace.${key}=${JSON.stringify(value)}`]);
      child = this.codexProcess = spawn(this.codexBinary, ['-c', 'analytics.enabled=false', ...mcpConfig, 'app-server', '--listen', `unix://${this.codexSocket}`], { stdio: ['ignore', 'ignore', 'pipe'], env: nativeEnvironment() });
      child.stderr.on('data', () => {});
      child.on('error', error => { spawnError = error; });
      for (let i = 0; i < 100 && !fs.existsSync(this.codexSocket); i++) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('Codex 后台未能启动，请在设置中检查所选程序。');
        await delay(100);
      }
      const endpoint = this.readCodexEndpoint();
      ws = new WebSocket('ws://localhost', { createConnection: () => net.connect(endpoint.resolved), maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD, handshakeTimeout: 10000 });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      rpc = new Rpc(ws);
      watcher = this.watchCodexConnection(rpc, child);
      rpc.nativeVersion = serverVersion(await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } }));
      if (ws.readyState !== WebSocket.OPEN) throw new Error('原生连接在启动时已断开。');
      const verifiedEndpoint = this.readCodexEndpoint();
      if (Object.keys(endpoint).some(key => verifiedEndpoint[key] !== endpoint[key])) throw new Error('原生接口在启动时已变化。');
      this.codexEndpoint = endpoint;
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      watcher.activate();
      } catch (error) {
        watcher?.dispose(); ws?.terminate();
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

module.exports = { claudeHolder, claudeImportAvailable, NativeHost, Terminal, Claude, Codex, Rpc, executable, delay, claudeGeneratedTitle };
