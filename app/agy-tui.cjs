'use strict';
// Antigravity CLI (`agy`) TUI session run in NAW's PTY (terminal-only in UI).
// Known TUI trust boundary (accepted 2026-11-24): agy TUI has no in-process rootLease or external
// app-server socket, so same-OS-account commands share the hook/MCP boundary (not equivalent to Claude
// rootLease or Codex app-server); NAW standing wake switches, cooldown, streak and recipient gates still apply.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { uiError, uiActivity } = require('./ui-errors.cjs');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]() -]{0,119}$/;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DEFAULT_HUMAN_INPUT_QUIET_MS = 500;
const DEFAULT_MCP_AUTH_WAIT_MS = 3000;
const DEFAULT_MCP_WARM_TIMEOUT_MS = 8000;
const MCP_PROOF_WAIT_MS = 2500;
const DEFAULT_BRAIN_ROOT = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
const WORKSPACE_MESSAGE_MATCHER = '^(?:call_mcp_tool|.*workspace_message)$';
const TRANSCRIPT_BASENAMES = new Set(['transcript.jsonl', 'transcript_full.jsonl']);
const RULE_LINE = /^[─━═]{10,}$/;
const EMPTY_PROMPT_LINE = /^[>❯](?:\s*|\s+(?:Auto mode|Plan mode|Accept edits|Ask before edits|Default mode|Bypass permissions)\b.*\(shift\+tab to cycle\))$/;
// Keys that cannot insert text or recall history into an already-empty composer.
const EMPTY_NOOP_INPUT = /^(?:[\x7f\x08\x15\x0b\x17]|\x1b\[(?:3~|[CDHF]))+$/;
// Startup directory-trust prompt keys: Up/Down navigation before confirmation, and Enter confirmation (never text or post-Enter arrows).
const TRUST_NAV_KEYS = /^(?:\x1b\[[AB])+$/;
const TRUST_CONFIRM_KEYS = /^(?:\x1b\[[AB])*[\r\n]+$/;

function validConversationId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function stripAnsi(raw) {
  return String(raw || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ');
}

function screenLines(screen) {
  const buf = screen?.buffer?.active;
  const rows = Number.isInteger(screen?.rows) ? screen.rows : 0;
  if (!buf || rows <= 0 || typeof buf.getLine !== 'function') return null;
  const baseY = Number.isInteger(buf.baseY) ? buf.baseY : 0;
  const lines = [];
  for (let y = baseY; y < baseY + rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  }
  return { buf, lines };
}

function screenShowsModelFooter(screen) {
  const view = screenLines(screen);
  if (!view) return false;
  for (let i = view.lines.length - 1; i >= 0; i--) {
    const line = view.lines[i];
    if (line.includes('? for shortcuts')) return line.includes('·');
  }
  return false;
}

function screenShowsNawMcpReady(screen) {
  const view = screenLines(screen);
  if (!view) return false;
  let inMcp = false;
  for (const line of view.lines) {
    if (line.includes('MCP Servers')) inMcp = true;
    if (inMcp && line.includes('✓') && line.includes('naw_workspace') && line.includes('workspace_message')) return true;
  }
  return false;
}

function editorState(screen) {
  const view = screenLines(screen);
  if (!view) return 'unknown';
  const { buf, lines } = view;
  for (const line of lines) {
    if (line.includes('Do you trust the contents of this project?')) return 'blocked';
  }
  const cursorY = Number.isInteger(buf.cursorY) ? buf.cursorY : -1;
  let statusIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('? for shortcuts')) { statusIdx = i; break; }
  }
  if (statusIdx >= 3) {
    let trailingContent = false;
    for (let i = statusIdx + 1; i < lines.length; i++) {
      if (lines[i].trim()) { trailingContent = true; break; }
    }
    if (!trailingContent) {
      let bottomRule = -1;
      for (let i = statusIdx - 1; i >= 0; i--) {
        if (RULE_LINE.test(lines[i].trim())) { bottomRule = i; break; }
        if (lines[i].trim()) break;
      }
      if (bottomRule >= 2) {
        let topRule = -1;
        for (let i = bottomRule - 1; i >= 0; i--) {
          if (RULE_LINE.test(lines[i].trim())) { topRule = i; break; }
        }
        if (topRule >= 0 && bottomRule - topRule > 1 && cursorY > topRule && cursorY < bottomRule) {
          const box = lines.slice(topRule + 1, bottomRule).map(l => l.trim()).filter(Boolean);
          if (box.length && /^[>❯]/.test(box[0])) {
            if (box.length > 1) return 'draft';
            return EMPTY_PROMPT_LINE.test(box[0]) ? 'empty' : 'draft';
          }
        }
      }
    }
  }
  // When a user types in agy, ? for shortcuts hides; still detect active draft text inside the composer box.
  if (cursorY > 0 && cursorY < lines.length - 1) {
    let topRule = -1, bottomRule = -1;
    for (let i = cursorY - 1; i >= 0; i--) {
      if (RULE_LINE.test(lines[i].trim())) { topRule = i; break; }
    }
    for (let i = cursorY + 1; i < lines.length; i++) {
      if (RULE_LINE.test(lines[i].trim())) { bottomRule = i; break; }
    }
    if (topRule >= 0 && bottomRule > topRule + 1) {
      const box = lines.slice(topRule + 1, bottomRule).map(l => l.trim()).filter(Boolean);
      if (box.length && /^[>❯]/.test(box[0]) && (box.length > 1 || !EMPTY_PROMPT_LINE.test(box[0]))) {
        return 'draft';
      }
    }
  }
  return 'unknown';
}

function prepareBridge({ privateDir, sessionId, mcpToken, hookSocket, pythonBinary, execPath = process.execPath, appDir = __dirname }) {
  if (!privateDir || !sessionId || !mcpToken || !hookSocket || !pythonBinary) return null;
  const bridgeDir = path.join(privateDir, `agy-bridge-${sessionId}`);
  const pluginDir = path.join(bridgeDir, '.agents', 'plugins', 'naw');
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  const hookCommand = `${shellQuote(pythonBinary)} ${shellQuote(path.join(appDir, 'agy_hook.py'))}`;
  const flatHook = [{ type: 'command', command: hookCommand, timeout: 5 }];
  const toolHook = [{ matcher: WORKSPACE_MESSAGE_MATCHER, hooks: flatHook }];
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'naw' }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify({
    'naw-lifecycle': {
      SessionStart: flatHook,
      PreInvocation: flatHook,
      PostInvocation: flatHook,
      PreToolUse: toolHook,
      PostToolUse: toolHook,
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
          NAW_MESSAGE_TOKEN: mcpToken,
        },
      },
    },
  }) + '\n', { mode: 0o600 });
  return bridgeDir;
}

function resolveSessionTranscript(transcriptPath, nativeId, brainRoot = DEFAULT_BRAIN_ROOT) {
  if (!validConversationId(nativeId) || typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  try {
    const realRoot = fs.realpathSync(brainRoot);
    const sessionRoot = path.join(realRoot, nativeId);
    const realFile = fs.realpathSync(transcriptPath);
    if (!realFile.startsWith(sessionRoot + path.sep) || !TRANSCRIPT_BASENAMES.has(path.basename(realFile))) return null;
    const stat = fs.lstatSync(realFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    return realFile;
  } catch {
    return null;
  }
}

function readFinalReply(transcriptPath, minStep = 0, nativeId = null, brainRoot = DEFAULT_BRAIN_ROOT) {
  const safePath = resolveSessionTranscript(transcriptPath, nativeId, brainRoot);
  if (!safePath) return '';
  try {
    const lines = fs.readFileSync(safePath, 'utf8').split('\n');
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
  constructor(record, host, {
    Terminal,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    humanInputQuietMs = DEFAULT_HUMAN_INPUT_QUIET_MS,
    mcpAuthWaitMs = DEFAULT_MCP_AUTH_WAIT_MS,
    mcpWarmTimeoutMs = DEFAULT_MCP_WARM_TIMEOUT_MS,
    warmMcp = true,
    now = () => Date.now(),
    brainRoot = DEFAULT_BRAIN_ROOT,
  } = {}) {
    super();
    this.record = record;
    this.host = host;
    this.Terminal = Terminal;
    this.sendTimeoutMs = sendTimeoutMs;
    this.humanInputQuietMs = humanInputQuietMs;
    this.mcpAuthWaitMs = mcpAuthWaitMs;
    this.mcpWarmTimeoutMs = mcpWarmTimeoutMs;
    this.warmMcp = warmMcp;
    this.now = now;
    this.brainRoot = brainRoot;
    this.terminal = null;
    this.bridgeDir = null;
    this.stopped = false;
    this.promptReady = false;
    this.trustPromptActive = false;
    this.chatAvailable = false;
    this.addressedSendAvailable = false;
    this.liveTurn = null;
    this.pendingSend = null;
    this.humanInputState = 'none';
    this.trustConfirmSent = false;
    this.lastHumanInputAt = -Infinity;
    this.humanInputTimer = null;
    this.mcpWarmPhase = 'idle'; // 'idle' | 'pending' | 'opening' | 'closing' | 'ready' | 'failed' | 'aborted'
    this.mcpWarmTimer = null;
    this.mcpAuthTimer = null;
    this.mcpCalls = new Map();
    // Separate per-session secrets: hookToken is in the child env; mcpToken is written only to mcp_config.json.
    this.token = randomBytes(32).toString('hex');
    this.mcpToken = randomBytes(32).toString('hex');
  }
  clearHumanInputTimer() {
    if (this.humanInputTimer) { clearTimeout(this.humanInputTimer); this.humanInputTimer = null; }
  }
  clearMcpWarmTimers() {
    if (this.mcpWarmTimer) { clearTimeout(this.mcpWarmTimer); this.mcpWarmTimer = null; }
    if (this.mcpAuthTimer) { clearTimeout(this.mcpAuthTimer); this.mcpAuthTimer = null; }
  }
  needsMcpWarmup() {
    return Boolean(this.warmMcp && this.bridgeDir && this.terminal?.screen);
  }
  mcpWarmBusy() {
    return this.mcpWarmPhase === 'pending' || this.mcpWarmPhase === 'opening' || this.mcpWarmPhase === 'closing';
  }
  startMcpWarmup() {
    if (this.mcpWarmPhase !== 'pending' || this.stopped || !this.terminal?.alive || !this.terminal.screen) return;
    if (editorState(this.terminal.screen) !== 'empty' || this.humanInputUnconfirmed() || this.liveTurn || this.pendingSend) return;
    this.clearMcpWarmTimers();
    this.mcpWarmPhase = 'opening';
    this.syncCapabilities();
    // agy TUI skips plugin MCP loading before keyring auth finishes; opening /mcp once after auth
    // initializes naw_workspace so workspace_message is registered in the model's call_mcp_tool schema.
    try {
      this.terminal.input('/mcp\r');
    } catch {
      this.mcpWarmPhase = 'failed';
      this.syncCapabilities();
      return;
    }
    this.mcpWarmTimer = setTimeout(() => {
      this.mcpWarmTimer = null;
      if (this.mcpWarmPhase !== 'opening' && this.mcpWarmPhase !== 'closing') return;
      const shouldEsc = this.mcpWarmPhase === 'opening' && this.terminal?.alive;
      this.mcpWarmPhase = 'failed';
      if (shouldEsc) {
        try { this.terminal.input('\x1b'); } catch { /* Best effort. */ }
      }
      if (!this.stopped && this.terminal?.alive && this.terminal.screen) this.syncScreenState(this.terminal.screen);
      else this.syncCapabilities();
    }, this.mcpWarmTimeoutMs);
    this.mcpWarmTimer.unref?.();
  }
  advanceMcpWarmup(screen, state) {
    if (!this.needsMcpWarmup()) return;
    if (this.mcpWarmPhase === 'pending') {
      if (state !== 'empty' || this.humanInputUnconfirmed() || this.liveTurn || this.pendingSend) return;
      if (screenShowsModelFooter(screen)) {
        this.startMcpWarmup();
      } else if (!this.mcpAuthTimer) {
        this.mcpAuthTimer = setTimeout(() => {
          this.mcpAuthTimer = null;
          if (this.mcpWarmPhase === 'pending') this.startMcpWarmup();
        }, this.mcpAuthWaitMs);
        this.mcpAuthTimer.unref?.();
      }
    } else if (this.mcpWarmPhase === 'opening') {
      if (screenShowsNawMcpReady(screen)) {
        this.mcpWarmPhase = 'closing';
        try { this.terminal.input('\x1b'); } catch { /* Best effort. */ }
      }
    } else if (this.mcpWarmPhase === 'closing') {
      if (state === 'empty') {
        this.clearMcpWarmTimers();
        this.mcpWarmPhase = 'ready';
      }
    }
  }
  humanInputSettling() {
    return this.lastHumanInputAt >= 0 && (this.now() - this.lastHumanInputAt) < this.humanInputQuietMs;
  }
  humanInputUnconfirmed() {
    if (this.terminal?.screen && this.humanInputState === 'unseen') return true;
    return this.humanInputSettling();
  }
  noteHumanTerminalInput(data = '') {
    this.lastHumanInputAt = this.now();
    if (this.mcpWarmPhase === 'opening' || this.mcpWarmPhase === 'closing') {
      this.clearMcpWarmTimers();
      this.mcpWarmPhase = 'aborted';
    }
    const screen = this.terminal?.screen;
    const state = screen ? editorState(screen) : 'unknown';
    // Raw-PTY fail-closed boundary (accepted 2026-11-24): only an already-visible draft stays in 'editing';
    // typing on 'empty' or 'unknown' enters 'unseen' until a draft or turn is observed (sub-chunk coalesced
    // type+erase stays conservatively blocked rather than risking submission of an un-echoed draft).
    if (this.humanInputState === 'none' && screen && state === 'empty' && typeof data === 'string' && EMPTY_NOOP_INPUT.test(data)) {
      this.humanInputState = 'none';
    } else if (this.humanInputState !== 'unseen' && screen && state === 'draft') {
      this.humanInputState = 'editing';
    } else if (this.humanInputState !== 'unseen' && screen && state === 'blocked' && typeof data === 'string' && !this.trustConfirmSent &&
      (TRUST_NAV_KEYS.test(data) || TRUST_CONFIRM_KEYS.test(data))) {
      if (TRUST_CONFIRM_KEYS.test(data)) this.trustConfirmSent = true;
      this.humanInputState = 'editing';
    } else if (this.humanInputState !== 'unseen' && screen && state === 'blocked' && typeof data === 'string' && /^[\r\n]+$/.test(data)) {
      this.humanInputState = 'editing';
    } else {
      this.humanInputState = 'unseen';
    }
    this.promptReady = false;
    this.clearHumanInputTimer();
    this.syncCapabilities();
    if (this.humanInputQuietMs > 0 && !this.stopped && this.terminal?.alive) {
      this.humanInputTimer = setTimeout(() => {
        this.humanInputTimer = null;
        if (!this.stopped && this.terminal?.alive && this.terminal.screen) this.syncScreenState(this.terminal.screen);
      }, this.humanInputQuietMs);
      this.humanInputTimer.unref?.();
    }
  }
  cleanupBridge() {
    const dir = this.bridgeDir;
    this.bridgeDir = null;
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
  }
  clearTokens() {
    this.host.hookTargets?.delete(this.token);
    this.host.agyMcpTargets?.delete(this.mcpToken);
  }
  syncCapabilities() {
    const warming = this.mcpWarmBusy();
    const canSend = Boolean(!this.stopped && this.terminal?.alive && this.host.hookSocket && this.promptReady && !this.trustPromptActive && !warming);
    const canAddress = Boolean(!this.stopped && this.terminal?.alive && this.bridgeDir && (!this.needsMcpWarmup() || this.mcpWarmPhase === 'ready'));
    if (canSend !== this.chatAvailable || canAddress !== this.addressedSendAvailable) {
      this.chatAvailable = canSend;
      this.addressedSendAvailable = canAddress;
      this.emit('capability');
    }
  }
  rejectPendingSend(error) {
    const pending = this.pendingSend;
    if (!pending) return;
    this.pendingSend = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  closeTurnMcpCalls() {
    for (const entry of this.mcpCalls.values()) entry.active = false;
    this.mcpCalls.clear();
  }
  async start() {
    const binary = this.host.binaries?.agy;
    if (!binary) throw uiError('error.nativeRuntimeMissing');
    if (this.host.privateDir && this.host.hookSocket && this.host.binaries?.python) {
      this.bridgeDir = prepareBridge({
        privateDir: this.host.privateDir,
        sessionId: this.record.id,
        mcpToken: this.mcpToken,
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
    if (this.bridgeDir) this.host.agyMcpTargets?.set(this.mcpToken, this);
    try {
      this.attach(new this.Terminal(spec.argv, this.record.cwd, spec.env));
    } catch (error) {
      this.clearTokens();
      this.cleanupBridge();
      throw error;
    }
  }
  syncScreenState(screen) {
    const state = editorState(screen);
    if (state === 'draft' && this.humanInputState === 'unseen') this.humanInputState = 'editing';
    if (state === 'empty' && this.humanInputState === 'editing' && !this.humanInputSettling()) this.humanInputState = 'none';
    this.advanceMcpWarmup(screen, state);
    this.trustPromptActive = state === 'blocked';
    this.promptReady = state === 'empty' && !this.humanInputUnconfirmed() && !this.mcpWarmBusy();
    this.syncCapabilities();
  }
  observeTerminalText(text) {
    if (!text) return;
    if (text.includes('Do you trust the contents of this project?')) {
      this.trustPromptActive = true;
      this.promptReady = false;
      this.syncCapabilities();
      return;
    }
    if (text.includes('? for shortcuts')) {
      this.trustPromptActive = false;
      this.promptReady = true;
      this.syncCapabilities();
    }
  }
  attach(terminal) {
    this.terminal = terminal;
    this.promptReady = false;
    this.trustPromptActive = false;
    this.trustConfirmSent = false;
    this.clearMcpWarmTimers();
    this.mcpWarmPhase = this.needsMcpWarmup() ? 'pending' : 'idle';
    if (!validConversationId(this.record.nativeId)) this.record.nativeId = null;
    terminal.on('data', event => {
      if (this.terminal !== terminal) return;
      if (terminal.screen) this.syncScreenState(terminal.screen);
      else if (typeof event?.data === 'string') this.observeTerminalText(stripAnsi(event.data));
      this.emit('terminal', event);
    });
    terminal.on('started', pid => {
      if (this.terminal !== terminal) return;
      if (!validConversationId(this.record.nativeId)) {
        const epoch = terminal.journal?.epoch;
        this.record.nativeId = Number.isSafeInteger(pid) && pid > 1 && validConversationId(epoch) ? `naw-agy:${epoch}` : null;
      }
      this.syncCapabilities();
      this.emit('pid', pid);
      this.emit('state', 'idle');
    });
    terminal.on('closed', result => {
      if (this.terminal !== terminal) return;
      this.clearHumanInputTimer();
      this.clearMcpWarmTimers();
      this.mcpWarmPhase = 'idle';
      this.clearTokens();
      this.cleanupBridge();
      this.promptReady = false;
      this.trustPromptActive = false;
      this.chatAvailable = false;
      this.addressedSendAvailable = false;
      this.rejectPendingSend(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: false }));
      this.closeTurnMcpCalls();
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
    const screen = this.terminal?.screen;
    const promptBlocked = this.mcpWarmBusy() || this.humanInputUnconfirmed() || (screen ? editorState(screen) !== 'empty' : this.record.terminalInputPending === true);
    if (this.stopped || !this.terminal?.alive || !this.chatAvailable || !this.promptReady || this.trustPromptActive ||
      promptBlocked || this.pendingSend || this.liveTurn) {
      return Promise.reject(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: true }));
    }
    if (!guard()) return Promise.reject(Object.assign(uiError('error.workspace.handoffExpired'), { notSent: true }));
    const safe = String(text ?? '').replace(/\x1b/g, '');
    if (!safe.trim()) return Promise.reject(Object.assign(uiError('error.nativeSendUnavailable'), { notSent: true }));
    return new Promise((resolve, reject) => {
      const pending = { tag, guard, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        if (this.pendingSend !== pending) return;
        this.pendingSend = null;
        reject(uiError('error.nativeSendUnavailable'));
      }, this.sendTimeoutMs);
      pending.timer.unref?.();
      this.pendingSend = pending;
      // Atomic single write right after the final guard check prevents orphaned pasted text if authorization changes.
      if (!guard()) {
        this.rejectPendingSend(Object.assign(uiError('error.workspace.handoffExpired'), { notSent: true }));
        return;
      }
      try {
        this.terminal.input(`\x1b[200~${safe}\x1b[201~\r`);
      } catch (error) {
        this.rejectPendingSend(error);
      }
    });
  }
  claimWorkspaceMcpProof(args, socket) {
    const turnId = this.turnId, nativeId = this.record.nativeId;
    if (!this.addressedSendAvailable || this.stopped || !this.terminal?.alive || !turnId || !nativeId) {
      return Promise.reject(uiError('error.nativeToolOriginUnconfirmed'));
    }
    const recipientId = args?.recipient_id;
    const messageHash = typeof args?.message === 'string' ? sha256Hex(args.message) : null;
    if (typeof recipientId !== 'string' || !recipientId || !messageHash) {
      return Promise.reject(uiError('error.nativeToolOriginUnconfirmed'));
    }
    const findMatch = () => {
      for (const entry of this.mcpCalls.values()) {
        if (entry.active && !entry.used && entry.nativeId === nativeId && entry.turnId === turnId &&
          entry.recipientId === recipientId && entry.messageHash === messageHash) {
          return entry;
        }
      }
      return null;
    };
    const claim = entry => {
      entry.used = true;
      return {
        callId: entry.callId,
        nativeId,
        turnId,
        valid: () => !this.stopped && Boolean(this.terminal?.alive) && this.turnId === turnId &&
          this.record.nativeId === nativeId && entry.active === true && !socket.destroyed,
      };
    };
    const immediate = findMatch();
    if (immediate) return Promise.resolve(claim(immediate));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('agyMcpProof', onProof);
        this.off('nativeTurnEnd', onTurnEnd);
        socket.off('close', onClose);
      };
      const fail = err => { cleanup(); reject(err); };
      const onProof = () => {
        const match = findMatch();
        if (match) { cleanup(); resolve(claim(match)); }
      };
      const onTurnEnd = info => { if (info?.turnId === turnId) fail(uiError('error.nativeTurnEndedNoAutoMessage')); };
      const onClose = () => fail(uiError('error.nativeToolOriginUnconfirmed'));
      const timer = setTimeout(() => fail(uiError('error.nativeToolOriginUnconfirmed')), MCP_PROOF_WAIT_MS);
      timer.unref?.();
      this.on('agyMcpProof', onProof);
      this.on('nativeTurnEnd', onTurnEnd);
      socket.once('close', onClose);
    });
  }
  hook(event) {
    if (!event || typeof event !== 'object' || this.stopped || !this.terminal?.alive) return;
    const hasConversationId = Object.prototype.hasOwnProperty.call(event, 'conversationId') && event.conversationId !== undefined;
    if (hasConversationId && !validConversationId(event.conversationId)) return;
    const incomingId = hasConversationId ? event.conversationId : null;
    if (validConversationId(this.record.nativeId)) {
      if (incomingId !== this.record.nativeId) return;
    } else if (incomingId) {
      this.record.nativeId = incomingId;
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
        if (this.terminal?.screen) {
          this.syncScreenState(this.terminal.screen);
        } else {
          this.trustPromptActive = false;
          this.promptReady = true;
          this.syncCapabilities();
        }
        if (!this.liveTurn && this.record.state !== 'working') this.emit('state', 'idle');
        break;
      case 'PreInvocation': {
        if (this.humanInputState === 'unseen') this.humanInputState = 'editing';
        if (this.terminal?.screen) {
          this.syncScreenState(this.terminal.screen);
        } else {
          this.trustPromptActive = false;
          this.promptReady = true;
          this.syncCapabilities();
        }
        if (this.liveTurn) {
          if (!this.liveTurn.transcriptPath && typeof event.transcriptPath === 'string') {
            this.liveTurn.transcriptPath = resolveSessionTranscript(event.transcriptPath, this.liveTurn.nativeId, this.brainRoot);
          }
          this.emit('state', 'working');
          break;
        }
        const pending = this.pendingSend;
        if (pending) {
          this.pendingSend = null;
          clearTimeout(pending.timer);
        }
        const turnId = randomUUID();
        const nativeId = this.record.nativeId;
        this.closeTurnMcpCalls();
        this.liveTurn = {
          id: turnId,
          tag: pending?.tag || null,
          nativeId,
          minStep: Number.isInteger(event.initialNumSteps) ? event.initialNumSteps : 0,
          transcriptPath: resolveSessionTranscript(event.transcriptPath, nativeId, this.brainRoot),
        };
        if (pending) this.emit('submitted', pending.tag);
        if (nativeId) this.emit('nativeTurnStart', { nativeId, turnId });
        if (pending && nativeId) this.emit('replyBound', { tag: pending.tag, nativeId, turnId });
        this.emit('state', 'working');
        if (pending) pending.resolve();
        break;
      }
      case 'PreToolUse': {
        if (!this.liveTurn) break;
        const callId = event.toolCallId;
        if (typeof callId !== 'string' || !callId || callId.length > 160) break;
        if (typeof event.recipientId !== 'string' || !event.recipientId || typeof event.messageHash !== 'string' || !/^[0-9a-f]{64}$/.test(event.messageHash)) break;
        if (validConversationId(this.liveTurn.nativeId) && incomingId !== this.liveTurn.nativeId) break;
        if (!this.mcpCalls.has(callId)) {
          this.mcpCalls.set(callId, {
            callId,
            nativeId: this.liveTurn.nativeId,
            turnId: this.liveTurn.id,
            recipientId: event.recipientId,
            messageHash: event.messageHash,
            active: true,
            used: false,
          });
          this.emit('agyMcpProof');
        }
        break;
      }
      case 'PostToolUse': {
        const entry = typeof event.toolCallId === 'string' ? this.mcpCalls.get(event.toolCallId) : null;
        if (entry) entry.active = false;
        break;
      }
      case 'PostInvocation':
        this.emit('state', 'working');
        break;
      case 'Stop': {
        const reason = event.terminationReason;
        if (reason === 'NO_TOOL_CALL' && event.fullyIdle === false) {
          this.emit('state', 'working');
          break;
        }
        const turn = this.liveTurn;
        this.liveTurn = null;
        this.closeTurnMcpCalls();
        const nativeId = turn?.nativeId || this.record.nativeId;
        const turnId = turn?.id || null;
        if (reason === 'ERROR') {
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'failed' });
          this.emit('failed', 'Antigravity 回合出错。', turn?.tag ? { tag: turn.tag } : undefined);
          this.emit('state', 'error');
        } else if (reason === 'USER_CANCELED') {
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'interrupted' });
          this.emit('interrupted', { tag: turn?.tag || null });
          this.emit('state', 'idle');
          if (this.terminal?.screen) this.syncScreenState(this.terminal.screen);
        } else if (reason === 'NO_TOOL_CALL' && event.fullyIdle === true) {
          // Never let Stop override a pinned turn transcript with a different path.
          const stopPath = resolveSessionTranscript(event.transcriptPath, nativeId, this.brainRoot);
          const transcript = turn?.transcriptPath
            ? (!event.transcriptPath || stopPath === turn.transcriptPath ? turn.transcriptPath : null)
            : stopPath;
          const text = transcript ? readFinalReply(transcript, turn?.minStep ?? 0, nativeId, this.brainRoot) : '';
          this.emit('complete', { tag: turn?.tag || null, nativeId, turnId, text });
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'completed' });
          this.emit('activity', '');
          this.emit('state', 'idle');
          if (this.terminal?.screen) this.syncScreenState(this.terminal.screen);
        } else {
          if (nativeId && turnId) this.emit('nativeTurnEnd', { nativeId, turnId, status: 'incomplete' });
          this.emit('failed', 'Antigravity 回合未确认完成。', turn?.tag ? { tag: turn.tag } : undefined);
          this.emit('state', event.hasError ? 'error' : 'idle');
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
    this.clearHumanInputTimer();
    this.clearMcpWarmTimers();
    this.mcpWarmPhase = 'idle';
    this.promptReady = false;
    this.trustPromptActive = false;
    this.chatAvailable = false;
    this.addressedSendAvailable = false;
    this.clearTokens();
    this.closeTurnMcpCalls();
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
  editorState,
  prepareBridge,
  resolveSessionTranscript,
  readFinalReply,
  launchSpec,
  AgyTui,
};
