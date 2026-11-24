'use strict';
// Antigravity CLI (`agy`) TUI session run in NAW's PTY. Terminal-only in Step 1
// (chatAvailable = false); reports native conversationId and lifecycle state via hooks.
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { uiError, uiActivity } = require('./ui-errors.cjs');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]() -]{0,119}$/;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function validConversationId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function launchSpec({ record, binary, hookToken = null, hookSocket = null }) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw uiError('error.nativeRuntimeMissing');
  const argv = [binary];
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
  constructor(record, host, { Terminal } = {}) {
    super();
    this.record = record;
    this.host = host;
    this.Terminal = Terminal;
    this.terminal = null;
    this.stopped = false;
    this.chatAvailable = false;
    this.token = randomBytes(32).toString('hex');
  }
  async start() {
    const binary = this.host.binaries?.agy;
    if (!binary) throw uiError('error.nativeRuntimeMissing');
    const spec = launchSpec({
      record: this.record,
      binary,
      hookToken: this.host.hookSocket ? this.token : null,
      hookSocket: this.host.hookSocket || null,
    });
    this.host.hookTargets?.set(this.token, this);
    try {
      this.attach(new this.Terminal(spec.argv, this.record.cwd, spec.env));
    } catch (error) {
      this.host.hookTargets?.delete(this.token);
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
      this.emit('pid', pid);
      this.emit('state', 'idle');
    });
    terminal.on('closed', result => {
      if (this.terminal !== terminal) return;
      this.host.hookTargets?.delete(this.token);
      if (!validConversationId(this.record.nativeId)) this.record.nativeId = null;
      if (!result?.confirmed) {
        this.emit('activity', ...uiActivity('notice.activity.terminalDisconnectedExitUnconfirmed'));
        this.emit('state', 'error');
        return;
      }
      this.emit('state', 'ended');
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
        if (this.record.state !== 'working') this.emit('state', 'idle');
        break;
      case 'PreInvocation':
      case 'PostInvocation':
        this.emit('state', 'working');
        break;
      case 'Stop':
        if (event.terminationReason === 'ERROR') {
          this.emit('state', 'error');
        } else if (event.fullyIdle !== false) {
          this.emit('activity', '');
          this.emit('state', 'idle');
        }
        break;
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
    this.host.hookTargets?.delete(this.token);
    if (this.terminal?.alive) await this.terminal.stop();
    return { state: 'ended' };
  }
}

module.exports = {
  validConversationId,
  launchSpec,
  AgyTui,
};
