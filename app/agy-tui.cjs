'use strict';
// Antigravity CLI (`agy`) TUI session run in NAW's PTY.
// Starts in terminal view; wires per-session hooks and native_workspace MCP via --add-dir
// so NAW queue dispatch, @ mentions and workspace_message work without touching global config.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { uiError, uiActivity } = require('./ui-errors.cjs');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]() -]{0,119}$/;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DEFAULT_ENTER_DELAY_MS = 50;

function validConversationId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function prepareBridge({ privateDir, sessionId, token, hookSocket, pythonBinary, execPath = process.execPath, appDir = __dirname }) {
  if (!privateDir || !sessionId || !token || !hookSocket || !pythonBinary) return null;
  const bridgeDir = path.join(privateDir, `agy-bridge-${sessionId}`);
  const pluginDir = path.join(bridgeDir, '.agents', 'plugins', 'naw');
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  const hookCommand = `${shellQuote(pythonBinary)} ${shellQuote(path.join(appDir, 'agy_hook.py'))}`;
  const flatHook = [{ type: 'command', command: hookCommand, timeout: 5 }];
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'naw' }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify({
    'naw-lifecycle': {
      SessionStart: flatHook,
      PreInvocation: flatHook,
      PostInvocation: flatHook,
      Stop: flatHook,
    },
  }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(pluginDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      workspace: {
        command: execPath,
        args: ['--disable-sigusr1', path.join(appDir, 'claude-message-tool.cjs'), '--agy'],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          NAW_MESSAGE_SOCKET: hookSocket,
          NAW_MESSAGE_TOKEN: token,
        },
      },
    },
  }) + '\n', { mode: 0o600 });
  return bridgeDir;
}

function readFinalReply(transcriptPath, minStep = 0) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return '';
  try {
    const stat = fs.lstatSync(transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) return '';
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'PLANNER_RESPONSE') continue;
      if (Number.isInteger(entry.step_index) && entry.step_index < minStep) break;
      if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) continue;
      if (typeof entry.content === 'string' && entry.content.trim()) return entry.content;
    }
  } catch { /* Missing or unreadable transcript leaves reply empty. */ }
  return '';
}

function launchSpec({ record, binary, bridgeDir = null, hookToken = null, hookSocket = null }) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw uiError('error.nativeRuntimeMissing');
  const argv = [binary];
  if (typeof bridgeDir === 'string' && path.isAbsolute(bridgeDir)) {
    argv.push('--add-dir', bridgeDir);
  }
  if (record?.recovering && validConversationId(record.nativeId)) {
    argv.push('--conversation', record.nativeId);
  }
  if (record?.skipPermissions === true) {
    argv.push('--dangerously-skip-permissions');
  }
  const model = record?.requestedSettings?.model;
  if (typeof model === 'string' && MODEL_PATTERN.test(model)) {
    argv.push('--model', model);
  }
  const effort = record?.requestedSettings?.effort;
  if (typeof effort === 'string' && EFFORT_LEVELS.includes(effort)) {
    argv.push('--effort', effort);
  }
  const env = {};
  if (typeof hookToken === 'string' && hookToken && typeof hookSocket === 'string' && hookSocket) {
    env.NAW_HOOK_TOKEN = hookToken;
    env.NAW_HOOK_SOCKET = hookSocket;
  }
  return { argv, env };
}

class AgyTui extends EventEmitter {
  get turnId() { return this.liveTurn?.id || null; }
  constructor(record, host, { Terminal, sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS, enterDelayMs = DEFAULT_ENTER_DELAY_MS } = {}) {
    super();
    this.record = record;
    this.host = host;
    this.Terminal = Terminal;
    this.sendTimeoutMs = sendTimeoutMs;
    this.enterDelayMs = enterDelayMs;
    this.terminal = null;
    this.bridgeDir = null;
    this.stopped = false;
    this.chatAvailable = false;
    this.addressedSendAvailable = false;
    this.liveTurn = null;
    this.pendingSend = null;
    this.token = randomBytes(32).toString('hex');
  }
  cleanupBridge() {
    const dir = this.bridgeDir;
    this.bridgeDir = null;
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
  }
  rejectPendingSend(error) {
    const pending = this.pendingSend;
    if (!pending) return;
    this.pendingSend = null;
    clearTimeout(pending.timer);
    clearTimeout(pending.enterTimer);
    pending.reject(error);
  }
  async start() {
    const binary = this.host.binaries?.agy;
    if (!binary) throw uiError('error.nativeRuntimeMissing');
    if (this.host.privateDir && this.host.hookSocket && this.host.binaries?.python) {
      this.bridgeDir = prepareBridge({
        privateDir: this.host.privateDir,
        sessionId: this.record.id,
        token: this.token,
        hookSocket: this.host.hookSocket,
        pythonBinary: this.host.binaries.python,
      });
    }
    const spec = launchSpec({
      record: this.record,
      binary,
      bridgeDir: this.bridgeDir,
      hookToken: this.host.hookSocket ? this.token : null,
      hookSocket: this.host.hookSocket || null,
    });
    this.host.hookTargets?.set(this.token, this);
    try {
      this.attach(new this.Terminal(spec.argv, this.record.cwd, spec.env));
    } catch (error) {
      this.host.hookTargets?.delete(this.token);
      this.cleanupBridge();
      throw error;
    }
  }
  attach(terminal) {
    this.terminal = terminal;
    if (!validConversationId(this.record.nativeId)) this.record.nativeId = null;
    terminal.on('data', event => this.emit('terminal', event));
    terminal.on('started', pid => {
      if (this.terminal !== terminal) return;
      if (!validConversationId(this.record.nativeId)) {
        const epoch = terminal.journal?.epoch;
        this.record.nativeId = Number.isSafeInteger(pid) && pid > 1 && validConversationId(epoch) ? `naw-agy:${epoch}` : null;
      }
      this.chatAvailable = Boolean(this.host.hookSocket);
      this.addressedSendAvailable = Boolean(this.bridgeDir);
      this.emit('pid', pid);
      this.emit('capability');
      this.emit('state', 'idle');
    });
    terminal.on('closed', result => {
      if (this.terminal !== terminal) return;
      this.host.hookTargets?.delete(this.token);
      this.cleanupBridge();
      this.chatAvailable = false;
      this.addressedSendAvailable = false;
      this.rejectPendingSend(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: false }));
      if (this.liveTurn) {
        const turn = this.liveTurn;
        this.liveTurn = null;
        this.emit('nativeTurnEnd', { nativeId: turn.nativeId, turnId: turn.id, status: 'disconnected' });
      }
      if (!validConversationId(this.record.nativeId)) this.record.nativeId = null;
      this.emit('capability');
      if (!result?.confirmed) {
        this.emit('activity', ...uiActivity('notice.activity.terminalDisconnectedExitUnconfirmed'));
        this.emit('state', 'error');
        return;
      }
      this.emit('state', 'ended');
    });
  }
  send(text, tag, guard = () => true) {
    if (this.stopped || !this.terminal?.alive || !this.chatAvailable || this.pendingSend || this.liveTurn) {
      return Promise.reject(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: true }));
    }
    if (!guard()) return Promise.reject(Object.assign(uiError('error.workspace.handoffExpired'), { notSent: true }));
    const safe = String(text ?? '').replace(/\x1b/g, '');
    if (!safe.trim()) return Promise.reject(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: true }));
    return new Promise((resolve, reject) => {
      const pending = { tag, guard, resolve, reject, timer: null, enterTimer: null };
      pending.timer = setTimeout(() => {
        if (this.pendingSend !== pending) return;
        this.pendingSend = null;
        clearTimeout(pending.enterTimer);
        reject(uiError('error.nativeSendUnavailable'));
      }, this.sendTimeoutMs);
      pending.timer.unref?.();
      this.pendingSend = pending;
      try {
        this.terminal.input(`\x1b[200~${safe}\x1b[201~`);
        const submit = () => {
          if (this.pendingSend !== pending) return;
          if (!this.terminal?.alive || !guard()) {
            this.rejectPendingSend(uiError('error.workspace.handoffExpired'));
            return;
          }
          try { this.terminal.input('\r'); }
          catch (error) { this.rejectPendingSend(error); }
        };
        if (this.enterDelayMs > 0) {
          pending.enterTimer = setTimeout(submit, this.enterDelayMs);
          pending.enterTimer.unref?.();
        } else submit();
      } catch (error) {
        this.rejectPendingSend(error);
      }
    });
  }
  hook(event) {
    if (!event || typeof event !== 'object' || this.stopped || !this.terminal?.alive) return;
    if (validConversationId(event.conversationId) && this.record.nativeId !== event.conversationId) {
      this.record.nativeId = event.conversationId;
      this.emit('capability');
    }
    if (typeof event.modelName === 'string') {
      const clean = event.modelName.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
      if (clean && clean !== 'auto' && clean.length <= 120 && clean !== this.record.model) {
        this.emit('model', clean);
      }
    }
    switch (event.hookEventName) {
      case 'SessionStart':
        if (!this.liveTurn && this.record.state !== 'working') this.emit('state', 'idle');
        break;
      case 'PreInvocation': {
        if (this.liveTurn) {
          if (typeof event.transcriptPath === 'string' && !this.liveTurn.transcriptPath) {
            this.liveTurn.transcriptPath = event.transcriptPath;
          }
          this.emit('state', 'working');
          break;
        }
        const pending = this.pendingSend;
        if (pending) {
          this.pendingSend = null;
          clearTimeout(pending.timer);
          clearTimeout(pending.enterTimer);
        }
        const turnId = randomUUID();
        const nativeId = this.record.nativeId;
        this.liveTurn = {
          id: turnId,
          tag: pending?.tag || null,
          nativeId,
          minStep: Number.isInteger(event.initialNumSteps) ? event.initialNumSteps : 0,
          transcriptPath: typeof event.transcriptPath === 'string' ? event.transcriptPath : null,
        };
        if (pending) this.emit('accepted', pending.tag);
        if (nativeId) this.emit('nativeTurnStart', { nativeId, turnId });
        if (pending && nativeId) this.emit('replyBound', { tag: pending.tag, nativeId, turnId });
        this.emit('state', 'working');
        if (pending) pending.resolve();
        break;
      }
      case 'PostInvocation':
        this.emit('state', 'working');
        break;
      case 'Stop': {
        if (event.fullyIdle === false && event.terminationReason !== 'ERROR') {
          this.emit('state', 'working');
          break;
        }
        const turn = this.liveTurn;
        this.liveTurn = null;
        const nativeId = turn?.nativeId || this.record.nativeId;
        const turnId = turn?.id || null;
        const transcript = typeof event.transcriptPath === 'string' ? event.transcriptPath : turn?.transcriptPath;
        if (event.terminationReason === 'ERROR') {
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'failed' });
          this.emit('failed', 'Antigravity 回合出错。', turn?.tag ? { tag: turn.tag } : undefined);
          this.emit('state', 'error');
        } else if (event.terminationReason === 'USER_CANCELED') {
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'interrupted' });
          this.emit('interrupted', { tag: turn?.tag || null });
          this.emit('state', 'idle');
        } else {
          const text = readFinalReply(transcript, turn?.minStep ?? 0);
          this.emit('complete', { tag: turn?.tag || null, nativeId, turnId, text });
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'completed' });
          this.emit('activity', '');
          this.emit('state', 'idle');
        }
        break;
      }
      default:
        break;
    }
  }
  openTerminal() {
    if (!this.terminal) throw Object.assign(Error('Antigravity TUI terminal is not running'), { code: 'agy-terminal-missing' });
    return this.terminal;
  }
  async interrupt() {
    return { interrupted: false };
  }
  async stop() {
    this.stopped = true;
    this.chatAvailable = false;
    this.addressedSendAvailable = false;
    this.host.hookTargets?.delete(this.token);
    this.rejectPendingSend(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: false }));
    try {
      if (this.terminal?.alive) await this.terminal.stop();
    } finally {
      this.cleanupBridge();
    }
    return { state: 'ended' };
  }
}

module.exports = {
  validConversationId,
  prepareBridge,
  readFinalReply,
  launchSpec,
  AgyTui,
};
