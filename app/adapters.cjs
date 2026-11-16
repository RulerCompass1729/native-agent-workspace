const { uiError, uiNotice, uiActivity } = require('./ui-errors.cjs');
const { readCodexProfile, catalogConfig } = require('./codex-profile.cjs');
const { claudeUsage, codexAccountUsage } = require('./native-usage.js');
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
const SerializeAddon = createTerminalSerializeAddon();
const { SubmissionChannel, createSubmissionServer } = require('./claude-submit.cjs');
const { installPlugin: refreshCompatPlugin } = require('./claude-compat-plugin.cjs');
const { TerminalJournal } = require('./observation.cjs');
const { serverVersion, verifiedCodexProtocol } = require('./native-history.cjs');
const codexQualification = require('./codex-qualification.cjs');
const claudeModCheck = require('./claude-mod-check.cjs');
const { toolContent, toolStatus, toolTypes, fileChanges, nativeTextContent, nativeTextItemId } = require('./codex-tool-content.cjs');
const { codexTurnBlock } = require('./native-blocks.cjs');
const { computerUseMcpServer, codexComputerUseMcpArgs } = require('./native-computer-use.cjs');
const { codexOutboxMcpArgs } = require('./computer-use-outbox-tool.cjs');

// The pinned MIT-licensed addon omits OSC8. Extend an isolated copy so other
// consumers keep the stock module. Private xterm interfaces and the minified
// class name require full source/version requalification when either changes.
function createTerminalSerializeAddon() {
  const { SerializeAddon: Stock } = require('@xterm/addon-serialize');
  let Candidate = Stock;
  try {
    const file = require.resolve('@xterm/addon-serialize'), source = fs.readFileSync(file, 'utf8');
    if (require('@xterm/addon-serialize/package.json').version !== '0.14.0' ||
        require('@xterm/headless/package.json').version !== '6.0.0' ||
        crypto.createHash('sha256').update(source).digest('hex') !== '65d8dd7c2b3b37a77f583ea5e0d14a23bbcc846e4ae0d6bb534ae12a380aea0d') throw Error('Unqualified serializer');
    const marker = 't.HTMLSerializeHandler=h';
    if (source.split(marker).length !== 2) throw Error('Unqualified serializer boundary');
    const Module = require('node:module'), isolated = new Module(file, module);
    isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file));
    // A zero C/D distance means one column; omit it when no move is needed.
    let snapshotSource = source;
    for (const [before, after] of [
      ["s+=`\u001b[${e.length-this._nullCellCount}C`", "e.length>this._nullCellCount&&(s+=`\u001b[${e.length-this._nullCellCount}C`)"],
      ["s+=`\u001b[${e.length-this._nullCellCount}D`", "e.length>this._nullCellCount&&(s+=`\u001b[${e.length-this._nullCellCount}D`)"]
    ]) {
      if (snapshotSource.split(before).length !== 2) throw Error('Unqualified serializer cursor boundary');
      snapshotSource = snapshotSource.replace(before, after);
    }
    isolated._compile(snapshotSource.replace(marker, marker + ';(' + installLinks.toString() + ')(u,t.SerializeAddon,require(' + JSON.stringify(require.resolve('./terminal-continuation.js')) + '));'), file);
    Candidate = isolated.exports.SerializeAddon;
  } catch {
    // Preserve service availability; the build and semantic tests reject this
    // degraded path. Never print native text, addresses, ids or error payloads.
    console.warn('Native hyperlink snapshot extension unavailable; using the stock terminal serializer.');
  }
  return class extends Candidate {
    activate(terminal) { super.activate(terminal); this.snapshotTerminal = terminal; }
    serialize(options) {
      try { return super.serialize(options); }
      catch (error) {
        if (error.code !== 'NAW_LINK_SNAPSHOT_BUDGET') throw error;
        this.warnLinkFallback(); return this.serializePlain(options);
      }
    }
    serializeSnapshot(options) {
      return typeof super.serializeSnapshot === 'function' ? super.serializeSnapshot(options) : { buffer: this.serialize(options) };
    }
    warnContinuationFallback() {
      if (!this.continuationFallbackWarned) console.warn('Native terminal continuation unavailable; retaining the legacy snapshot.');
      this.continuationFallbackWarned = true;
    }
    serializePlain(options) {
      const plain = new Stock(); plain.activate(this.snapshotTerminal);
      try { return plain.serialize(options); } finally { plain.dispose(); }
    }
    warnLinkFallback() {
      if (!this.linkFallbackWarned) console.warn('Native hyperlink metadata exceeds the snapshot budget; preserving the stock text snapshot.');
      this.linkFallbackWarned = true;
    }
  };

  function installLinks(Handler, Addon, continuation) {
    let context, paired;
    const serialize = Addon.prototype.serialize, next = Handler.prototype._nextCell;
    const diff = Handler.prototype._diffStyle, rowEnd = Handler.prototype._rowEnd;
    // Restore per-buffer regions before mode flags, retaining pending wrap when possible.
    let snapshotOptions, legacyCursorState = false;
    const originalOptions = () => snapshotOptions?.range || snapshotOptions?.excludeModes || snapshotOptions?.excludeAltBuffer || snapshotOptions?.scrollback !== undefined || legacyCursorState;
    const coreBuffer = (terminal, buffer) => terminal._core._bufferService.buffers[buffer.type === 'alternate' ? 'alt' : 'normal'];
    const erasedRow = (terminal, line) => {
      if (!line || line.length !== terminal.cols) return null;
      const cell = line.getCell(terminal.cols - 1);
      if (!cell || cell.getChars() || cell.getWidth() !== 1 || cell.fg !== 0 || (cell.bg & 0xFC000000) || cell.hasExtendedAttrs()) return null;
      for (let col = 0; col < terminal.cols; col++) {
        const blank = line.getCell(col);
        if (!blank || blank.getChars() || blank.getWidth() !== 1 || blank.fg !== 0 || blank.bg !== cell.bg || blank.hasExtendedAttrs()) return null;
      }
      return cell;
    };
    const pendingCell = (terminal, buffer) => {
      if (buffer.cursorX !== terminal.cols) return null;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      let x = terminal.cols - 1, cell = line?.getCell(x);
      if (cell?.getWidth() === 0) cell = line?.getCell(--x);
      if (!cell || x + cell.getWidth() !== terminal.cols) return null;
      if (cell.getChars()) return { cell, x };
      const erased = erasedRow(terminal, line);
      return erased ? { cell: erased, x, erased: true, wrapped: line.isWrapped } : null;
    };
    const cursor = (terminal, buffer, origin) => {
      const b = coreBuffer(terminal, buffer), e = String.fromCharCode(27), row = buffer.cursorY - (origin ? b.scrollTop : 0) + 1;
      const cup = col => e + '[' + row + ';' + (col + 1) + 'H';
      if (buffer.cursorX < terminal.cols) return cup(buffer.cursorX);
      const pending = pendingCell(terminal, buffer);
      if (!pending) return null;
      const { cell, x } = pending;
      const pen = terminal._core._inputHandler._curAttrData;
      const style = (to, from) => {
        const codes = diff.call(null, withoutLink(to), withoutLink(from));
        return codes.length ? e + '[' + codes.join(';') + 'm' : '';
      };
      // Absolute styles: a relative SGR 22 would clear both bold and dim.
      const defaults = buffer.getNullCell(), reset = e + '[0m';
      if (pending.erased) {
        return cup(x) + reset + style(cell, defaults) + ' ' + e + (pending.wrapped ? '[1K' : '[2K') + reset + style(pen, defaults);
      }
      const id = cell.hasExtendedAttrs() ? cell.extended.urlId : 0, data = id ? terminal._core._oscLinkService.getLinkData(id) : null;
      return cup(x) + reset + style(cell, defaults) + (data ? osc(id, data) : '') + cell.getChars() + (data ? close : '') + reset + style(pen, defaults);
    };
    const format = Handler.prototype._serializeString;
    Handler.prototype._serializeString = function (excludeFinalCursorPosition) {
      if (!excludeFinalCursorPosition && !originalOptions()) {
        for (let index = 0; index + 1 < this._allRows.length; index++) {
          const row = this._firstRow + index, line = this._buffer.getLine(row), nextLine = this._buffer.getLine(row + 1);
          if (!line || !nextLine || line.length !== this._terminal.cols || nextLine.length !== this._terminal.cols ||
              !nextLine.isWrapped || this._allRowSeparators[index] !== '') continue;
          const first = nextLine.getCell(0), last = line.getCell(this._terminal.cols - 1);
          if (!first || first.getChars() || first.getWidth() !== 1 || first.fg !== 0 || first.hasExtendedAttrs() ||
              !last || (!last.getChars() && last.getWidth() !== 0) || (first.bg & 0x3FFFFFF) !== (last.bg & 0x3FFFFFF)) continue;
          // A leading null cannot trigger the wrap; use the existing forced-wrap sequence.
          this._allRowSeparators[index] = '-' + String.fromCharCode(27) + '[1D' + String.fromCharCode(27) + '[1X';
          if (this._lastContentCursorRow < row + 1) {
            this._lastContentCursorRow = row + 1; this._lastContentCursorCol = 0;
          }
        }
        const firstScroll = this._terminal.rows;
        if (this._allRows.length > firstScroll) {
          const previous = this._buffer.getLine(this._firstRow + firstScroll - 1), line = this._buffer.getLine(this._firstRow + firstScroll);
          const before = previous?.getCell(this._terminal.cols - 1), tail = line?.getCell(this._terminal.cols - 1);
          if (previous?.length === this._terminal.cols && line?.length === this._terminal.cols &&
              before && (before.bg & 0x3FFFFFF) && tail && !tail.getChars() && tail.getWidth() === 1 &&
              tail.fg === 0 && tail.bg === 0 && !tail.hasExtendedAttrs()) {
            // The first replay scroll inherits the previous row's BCE colour.
            this._allRows[firstScroll] += String.fromCharCode(27) + '[' + this._terminal.cols + 'X';
          }
        }
        if (this._buffer.length - this._firstRow <= this._terminal.rows) {
          for (let index = this._allRows.length - 1; this._firstRow + index > this._lastContentCursorRow; index--) {
            const row = this._firstRow + index, blank = erasedRow(this._terminal, this._buffer.getLine(row));
            if (blank && blank.bg && this._allRows[index]) {
              // The row's BCE erase paints cells even though it prints no glyph.
              this._lastContentCursorRow = row; this._lastContentCursorCol = 0; break;
            }
          }
        }
      }
      const content = format.call(this, excludeFinalCursorPosition), x = this._buffer.cursorX;
      if (excludeFinalCursorPosition) return content;
      const move = x >= this._terminal.cols || this._lastCursorCol < this._terminal.cols ? content :
        content + String.fromCharCode(27) + '[' + (this._buffer.cursorY + 1) + ';' + (x + 1) + 'H';
      const legacy = this._terminal.modes.originMode ? content : move;
      if (originalOptions()) return legacy;
      const b = coreBuffer(this._terminal, this._buffer);
      if (b.scrollTop || b.scrollBottom !== this._terminal.rows - 1) {
        const position = cursor(this._terminal, this._buffer, false);
        return position === null ? legacy : content + String.fromCharCode(27) + '[' + (b.scrollTop + 1) + ';' + (b.scrollBottom + 1) + 'r' + position;
      }
      if (x >= this._terminal.cols && pendingCell(this._terminal, this._buffer)?.erased) return content + cursor(this._terminal, this._buffer, false);
      // Content precedes the origin flag, so this absolute move is still valid.
      return move;
    };
    const modes = Addon.prototype._serializeModes;
    Addon.prototype._serializeModes = function (terminal) {
      const content = modes.call(this, terminal);
      if (originalOptions() || !terminal.modes.originMode) return content;
      const position = cursor(terminal, terminal.buffer.active, true);
      return position === null ? content : content + position;
    };
    const close = '\x1b]8;;\x1b\\';
    const wireLink = (id, data) => ({ id: data.id === undefined ? context.prefix + '-' + id : data.id, uri: data.uri });
    const osc = (id, data) => {
      // Anonymous links need a snapshot-local wire id to preserve grouping
      // across rows and the open pen's later output, including mid-buffer pens.
      const wireId = wireLink(id, data).id;
      const bytes = Buffer.byteLength(wireId) + Buffer.byteLength(data.uri) + 12;
      if (context.bytes + bytes > 4 * 1024 * 1024) {
        const error = Error('Native hyperlink snapshot budget exceeded'); error.code = 'NAW_LINK_SNAPSHOT_BUDGET'; throw error;
      }
      context.bytes += bytes;
      return `\x1b]8;id=${wireId};${data.uri}\x1b\\`;
    };
    Addon.prototype.serialize = function (options) {
      const previous = context;
      context = { prefix: 'naw-snapshot-' + require('node:crypto').randomUUID(), bytes: 0 };
      try {
        const content = serialize.call(this, options);
        const pen = this._terminal._core._inputHandler._curAttrData;
        const id = pen.hasExtendedAttrs() ? pen.extended.urlId : 0;
        const data = this._terminal._core._oscLinkService.getLinkData(id);
        const buffer = content + (data ? osc(id, data) : '');
        if (paired && !snapshotOptions?.range && !snapshotOptions?.excludeModes && !snapshotOptions?.excludeAltBuffer && snapshotOptions?.scrollback === undefined) {
          try { paired.continuation = continuation.capture(this._terminal, wireLink); }
          catch { paired.unavailable = true; }
        }
        return buffer;
      } finally { context = previous; }
    };
    Addon.prototype.serializeSnapshot = function (options) {
      const previous = paired, capture = {};
      paired = capture;
      try {
        const buffer = this.serialize(options);
        if (capture.unavailable) this.warnContinuationFallback();
        return { buffer, ...(capture.continuation ? { continuation: capture.continuation } : {}) };
      } finally { paired = previous; }
    };
    const withoutLink = cell => {
      if (!cell.hasExtendedAttrs() || !cell.extended.urlId) return cell;
      const copy = cell.clone(); copy.extended.urlId = 0; copy.updateExtended(); return copy;
    };
    Handler.prototype._diffStyle = function (cell, old) {
      return diff.call(this, withoutLink(cell), withoutLink(old));
    };
    Handler.prototype._nextCell = function (cell, old, row, col) {
      if (cell.getWidth()) {
        // Reused cells retain stale extended fields when HAS_EXTENDED is clear.
        const id = cell.hasExtendedAttrs() ? cell.extended.urlId : 0;
        if (id !== this.snapshotSourceLink) {
          this.snapshotSourceLink = id;
          const data = this._terminal._core._oscLinkService.getLinkData(id);
          if (this.snapshotWrittenLink) this._currentRow += close;
          if (data) this._currentRow += osc(id, data);
          this.snapshotWrittenLink = data ? id : 0;
        }
      }
      return next.call(this, cell, old, row, col);
    };
    Handler.prototype._rowEnd = function (row, last) {
      // Keep close inside this row even when the addon trims empty tail rows;
      // its forced-wrap filler must not acquire a hyperlink.
      if (this.snapshotWrittenLink) this._currentRow += close;
      this.snapshotWrittenLink = 0; this.snapshotSourceLink = undefined;
      return rowEnd.call(this, row, last);
    };
    const beforeOptions = Addon.prototype.serialize;
    Addon.prototype.serialize = function (options) {
      const previousOptions = snapshotOptions, previousLegacy = legacyCursorState;
      try {
        snapshotOptions = options;
        const terminal = this._terminal;
        if (!terminal) return beforeOptions.call(this, options);
        const buffers = [terminal.buffer.normal];
        if (terminal.buffer.active.type === 'alternate') buffers.push(terminal.buffer.alternate);
        // Preserve legacy bytes for pending rows that cannot be reconstructed.
        legacyCursorState = buffers.some(buffer => buffer.cursorX >= terminal.cols && !pendingCell(terminal, buffer));
        return beforeOptions.call(this, options);
      }
      finally { snapshotOptions = previousOptions; legacyCursorState = previousLegacy; }
    };
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const { executable, pythonExecutable, nativeEnvironment } = require('./platform.cjs');

// Local receipt timing is an observation, never a native failure or authority
// to cancel/replay work. Keep the original activity and its identity intact.
const observedToolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall']);
function withObservedTool(runtime, activity, marker, progressAt) {
  if (!marker || !Number.isFinite(progressAt)) return activity;
  const toolWait = { source: 'live-observation', marker, progressAt };
  const notice = runtime.toolWaitNotice;
  return { ...activity, toolWait, ...(notice && notice.nativeId === activity.nativeId && notice.turnId === activity.turnId &&
    notice.marker === marker && notice.progressAt === progressAt ? { waitNotice: notice } : {}) };
}

class Terminal extends EventEmitter {
  constructor(argv, cwd, env = {}) {
    super();
    this.pid = null; this.alive = true; this.sequence = 0; this.nativeExited = false;
    this.screen = new HeadlessTerminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    this.keyboardModes = require('./terminal-keyboard.cjs').trackKeyboardModes(this.screen);
    this.cursorModes = require('./terminal-keyboard.cjs').trackCursorModes(this.screen);
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
            const observation = this.journal.append('output', data, this.screen.cols, this.screen.rows, () => this.serializeFrame());
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
    if (!this.alive || !this.worker.stdin.writable) throw uiError("error.nativeTerminalClosed");
    this.worker.stdin.write(JSON.stringify(message) + '\n');
  }
  input(data) { this.command({ type: 'input', data }); }
  serializeBuffer() { return Terminal.prototype.serializeFrame.call(this).buffer; }
  serializeFrame() {
    const cursor = this.cursorModes.snapshot();
    const frame = typeof this.serialize.serializeSnapshot === 'function'
      ? this.serialize.serializeSnapshot() : { buffer: this.serialize.serialize() };
    frame.buffer += cursor;
    const continuation = require('./terminal-continuation.js');
    if (continuation.frameBytes(frame.continuation ? frame : frame.buffer) > this.journal.maxCheckpointBytes) {
      const plain = this.serialize.serializePlain() + cursor;
      // Never combine a degraded buffer with continuation from another replay.
      const hadContinuation = Boolean(frame.continuation);
      delete frame.continuation;
      if (continuation.frameBytes(plain) <= this.journal.maxCheckpointBytes) {
        this.serialize.warnLinkFallback(); frame.buffer = plain;
      } else if (hadContinuation) this.serialize.warnContinuationFallback();
    }
    return frame;
  }
  resize(cols, rows) {
    cols = Math.max(20, Math.min(400, cols)); rows = Math.max(5, Math.min(200, rows));
    if (this.alive) this.screen.write('', () => {
      if (!this.alive || (cols === this.screen.cols && rows === this.screen.rows)) return;
      this.screen.resize(cols, rows); this.command({ type: 'resize', cols, rows });
      const observation = this.journal.append('resize', '', cols, rows, () => this.serializeFrame());
      this.emit('data', { ...observation, sequence: this.sequence });
    });
  }
  snapshot() { return new Promise(resolve => this.screen.write('', () => resolve({ ...this.serializeFrame(), sequence: this.sequence, epoch: this.journal.epoch, observationIndex: this.journal.index, cols: this.screen.cols, rows: this.screen.rows, pid: this.pid, keyboardFlags: this.keyboardModes.flags, cursorModesVersion: 1 }))); }
  observe() { return new Promise(resolve => this.screen.write('', () => resolve({ ...this.journal.snapshot(), alive: this.alive }))); }
  // The worker gives TERM the original five seconds, then has time to reap
  // the forced exit and confirm that the entire owned group is gone.
  stop(timeout = 8000) {
    if (this.stopPending) return this.stopPending;
    if (!this.alive) return this.nativeExited ? Promise.resolve() : Promise.reject(uiError("error.nativeExitUnconfirmed"));
    this.stopPending = new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); this.off('closed', closed); error ? reject(error) : resolve(); };
      const closed = result => finish(result.confirmed ? null : uiError("error.terminalClosedExitUnconfirmed"));
      const timer = setTimeout(() => finish(uiError("error.nativeExitStillUnconfirmed")), timeout);
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

// A Codex session NAW's rotation created starts with the old session's model and reasoning
// effort: as thread/start parameters in chat view, as command options for the native terminal.
// A session started from one of the person's Codex profiles (DeepSeek pro / flash) gets the
// profile's settings as its thread configuration (codex-profile.cjs); a model or effort asked
// for as well replaces the profile's.
function codexRequestedParams(record) {
  const requested = record.requestedSettings || {};
  const params = {};
  if (requested.profile) {
    params.config = { ...readCodexProfile(requested.profile) };
    if (requested.model) {
      params.config.model = requested.model;
    }
  } else if (requested.model) {
    params.model = requested.model;
  }
  if (requested.effort) {
    params.config = { ...params.config, model_reasoning_effort: requested.effort };
  }
  return params;
}

function codexRequestedArgs(record) {
  const requested = record.requestedSettings || {};
  const args = [];
  if (requested.profile) {
    for (const [key, value] of Object.entries(readCodexProfile(requested.profile))) {
      args.push('-c', `${key}=${JSON.stringify(value)}`);
    }
  }
  if (requested.model) {
    args.push('-m', requested.model);
  }
  if (requested.effort) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(requested.effort)}`);
  }
  return args;
}

// A thread Codex loads again (after its service restarted) keeps its provider, model and effort
// but not a profile's model catalog; it is given the catalog again. A profile that can no longer
// be read resumes the thread as Codex has it.
function codexResumeParams(record) {
  const profile = record.requestedSettings?.profile;
  if (!profile) {
    return {};
  }
  try {
    const config = catalogConfig(profile);
    return config ? { config } : {};
  } catch {
    return {};
  }
}
const FOLLOWED_ROOT_TRANSITIONS = { clear: 'clear', resume: 'fork' };
// Claude's generated title is native metadata with no API: scan a bounded
// transcript tail and extract the newest matching ai-title row.
// The inputs a root turn.start claims: native prompt ids and this mod's own
// `!` command rows, both taken while no root turn ran. Bounded, exact shapes.
// The mod's promptTextTag, verbatim (register.js cannot require; a test pins the two equal).
const promptTextTag = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); };
function nativeTurnTriggers(value, queuedOnly = false) {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => ['prompts', 'rows'].includes(k)) &&
    Array.isArray(value.prompts) && Array.isArray(value.rows) && value.prompts.length + value.rows.length > 0 && value.prompts.length + value.rows.length <= 8 &&
    value.prompts.every(id => typeof id === 'string' && new RegExp(`^${uuid}(?:-q[0-9a-f]{8})?$`, 'i').test(id)) &&
    value.rows.every(id => typeof id === 'string' && new RegExp(`^tool:shell-${uuid}$`, 'i').test(id)) &&
    (!queuedOnly || value.rows.length === 0 && value.prompts.length === 1 && /-q[0-9a-f]{8}$/.test(value.prompts[0])));
}
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
// 529 is a model at capacity. 403 is a request the server or the network edge in front of it refused: measured
// 2026-11-13 on 2.1.322 and 2.1.323 as an intermittent block that later requests of the same session passed. The
// status alone decides. Native's own `error` label says "authentication_failed" for that block and for a real
// sign-out alike, so it separates nothing. The 2.1.323 bundle also has a second label for an edge block, made only
// for HTTP 403 ("invalid_request" with apiError "network_edge_blocked"; read in the bundle, not seen in a saved
// row), which requiring the first label would drop. A 403 that does not pass is retried within the shared limit of
// three and then left to the person.
function claudeFailureCause(file, nativeId, messageId) {
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
        if (row.type !== 'assistant' || row.sessionId !== nativeId || row.isSidechain !== false ||
          row.isApiErrorMessage !== true || row.message?.model !== '<synthetic>') return false;
        return row.apiErrorStatus === 529 ? 'serverOverloaded' : row.apiErrorStatus === 403 ? 'requestForbidden' : false;
      } catch { /* torn line: no authority to retry */ }
    }
  } catch (error) { return error.code === 'ENOENT' ? null : false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null; // Native may flush the identified row just after its hooks.
}
// Native's accepted prompt UUID and its classic promptId are recorded together.
// Read only the current session's bounded journal tail; return no prose/history.
function claudePromptIdentity(file, nativeId, promptId) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(nativeId || '') || !uuid.test(promptId || '') || typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== `${nativeId}.jsonl`) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid()) return null;
    const length = Math.min(stat.size, 262144), buffer = Buffer.alloc(length), found = new Set();
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.includes(promptId)) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'user' && row.sessionId === nativeId && row.isSidechain === false && row.promptId === promptId && uuid.test(row.uuid || '')) found.add(row.uuid);
      } catch { /* a torn line carries no identity */ }
    }
    return found.size === 1 ? [...found][0] : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// A prompt typed during a turn waits in native's queue, and the person can take it back before it is read: ↑
// (popAll) or picking it (popOne) moves it into the editor, cancelling clears it (remove, cleared_on_cancel). Native
// journals each as a `queue-operation` row with the prompt's text (2.1.321–2.1.323 bundles; measured on 2.1.323,
// 11-15). Read this session's queue rows from `offset`, bounded, with where each starts. Delivery rows (dequeue)
// carry no text: the caller keeps any text with an enqueue left.
const QUEUE_TAKEN_BACK = new Set(['popAll', 'popOne']);
function claudeQueueRows(file, nativeId, offset) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(nativeId || '') || !Number.isSafeInteger(offset) || offset < 0 || typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== `${nativeId}.jsonl`) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size < offset || stat.size - offset > 8388608) return null;
    const buffer = Buffer.alloc(stat.size - offset), rows = [];
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    let at = 0;
    while (at < buffer.length) {
      const next = buffer.indexOf(10, at), end = next < 0 ? buffer.length : next, line = buffer.toString('utf8', at, end);
      if (line.includes('"queue-operation"')) {
        try {
          const row = JSON.parse(line);
          const kind = row.operation === 'enqueue' ? 'queued' : QUEUE_TAKEN_BACK.has(row.operation) || row.operation === 'remove' && row.reason === 'cleared_on_cancel' ? 'taken' : row.operation === 'remove' && row.reason === 'absorbed_mid_turn' ? 'read' : null;
          if (kind && row.type === 'queue-operation' && row.sessionId === nativeId && typeof row.content === 'string') rows.push({ at: offset + at, kind, text: row.content, time: Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : null });
        } catch { /* a torn line proves nothing */ }
      }
      at = end + 1;
    }
    return rows;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// A running claude process whose arguments name this native session ID.
function claudeHolder(nativeId, strict = false) {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId || '')) return null;
  // Without ps the check cannot run; recovery then proceeds as it did before.
  let lines; try { lines = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 }).split('\n'); } catch {
    if (strict) { const error = uiError("error.nativeProcessUnverifiable"); error.nativeImportRefused = true; throw error; }
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
    const error = uiError("error.claudeSessionUnverifiable"); error.nativeImportRefused = true; throw error;
  }
  if (rows.some(row => row.sessionId?.toLowerCase() === record.nativeId.toLowerCase())) {
    const error = uiError("error.claudeSessionStillActive"); error.nativeActiveWriter = true; throw error;
  }
}
class Claude extends EventEmitter {
  get turnId() { return this.liveTurn?.id || null; }
  get nativeActivity() {
    if (!this.liveTurn || this.rootEnding || this.disposed || !this.terminal?.alive) return null;
    const activity = { nativeId: this.record.nativeId, turnId: this.liveTurn.id, label: this.livePermissions?.size ? [...this.livePermissions.values()].map(r => r.title).join(', ') : this.liveTurn.label, phase: this.livePermissions?.size ? 'approval' : this.liveTurn.phase, observedAt: this.observationSeenAt };
    const turn = this.liveTurn, binding = turn.toolBinding;
    const tool = ['tool', 'tool-use'].includes(activity.phase) && !turn.question &&
      binding && binding.nativeId === this.record.nativeId && binding.epoch === this.observationEpoch &&
      Number.isFinite(this.observationSeenAt) && Date.now() - this.observationSeenAt <= 5000;
    return withObservedTool(this, activity, tool ? `${binding.epoch}:${turn.id}:${turn.toolPhaseSerial}` : null, turn.toolProgressAt);
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
    this.on('state', state => { this.localApprovalState = state; if (state !== 'approval') this.localApprovalPending = false; });
    this.submission = new SubmissionChannel();
    // Rows this adapter's own mid-turn deliveries stored, until the model read them.
    this.midturnRows = new Map();
    this.submission.on('read', read => this.midturnRead(read));
    this.submission.on('change', () => {
      this.chatAvailable = this.submission.connected;
      if (!this.chatAvailable && this.rootTurn?.status === 'error') this.rootTurn = null;
      if (!this.chatAvailable && this.startedRootTurn) this.startedRootTurn.inputRevoked = true;
      this.emit('capability');
    });
    this.token = crypto.randomBytes(32).toString('hex');
    // A retained reader uses these same native validators and channel, but
    // cannot write settings, register command hooks or launch another CLI.
    if (attachOnly) return;
    // Native has no lock: a second --resume writes the same transcript. Refuse
    // while another claude process (e.g. an external terminal) names this ID.
    const holder = record.recovering && claudeHolder(record.nativeId, record.externalHistory === true);
    if (holder) { const error = uiError("error.claudeOtherWriter", { arg1: holder }); error.nativeActiveWriter = true; throw error; }
    if (record.recovering && record.externalHistory) claudeImportAvailable(record, host);
    // Claude also loads the compat plugin a retained session once left in this
    // folder; refresh NAW's own byte-exact old copy before starting (T-100).
    try { refreshCompatPlugin(record.cwd, { existingOnly: true }); } catch { /* Edited or unsafe copies stay untouched. */ }
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
    // Automatic session recap, prompt suggestions, background memory consolidation (auto-dream) and a compaction
    // summary precomputed before it is needed are background model requests the person did not ask for (CL-X03).
    // /recap and compaction itself stay available; auto mode's classifier keeps its native behavior.
    fs.writeFileSync(settings, JSON.stringify({ teammateMode: 'in-process', awaySummaryEnabled: false, promptSuggestionEnabled: false,
      autoDreamEnabled: false, precomputeCompactionEnabled: false, hooks }), { mode: 0o600 });
    const mcp = JSON.stringify({ mcpServers: { native_workspace: { command: process.execPath,
      args: ['--disable-sigusr1', path.join(__dirname, 'claude-message-tool.cjs')], env: { ELECTRON_RUN_AS_NODE: '1' } },
      peekaboo: computerUseMcpServer() } });
    // Native --resume restores the saved model and every permission mode except
    // bypassPermissions, but resolves effort from settings again. Re-pass only
    // those two, as this session's own last native reports had them.
    // A new session starts in bypass only when the person chose it at creation;
    // later launches follow what the session last reported.
    // A session NAW's rotation created starts with the old session's model, effort and mode.
    const posture = !record.recovering ? [
      ...(record.skipPermissions ? ['--permission-mode', 'bypassPermissions']
        : record.requestedSettings?.permissionMode ? ['--permission-mode', record.requestedSettings.permissionMode]
          : record.operatorCreation?.permission === 'default' ? ['--permission-mode', 'default'] : []),
      ...(record.requestedSettings?.model ? ['--model', record.requestedSettings.model] : []),
      ...(record.requestedSettings?.effort ? ['--effort', record.requestedSettings.effort] : [])] : [
      ...(record.nativePermissionMode === 'bypassPermissions' ? ['--permission-mode', 'bypassPermissions'] : []),
      ...(EFFORT_LEVELS.includes(record.nativeEffort) ? ['--effort', record.nativeEffort] : [])];
    // A picker branch opens the native session picker once and forks the chosen
    // session into this row's pre-assigned ID; recovery always resumes that ID.
    const identity = record.recovering ? ['--resume', record.nativeId]
      : record.forkPicker ? ['--resume', '--fork-session', '--session-id', record.nativeId] : ['--session-id', record.nativeId];
    // An unqualified new Claude version: start with the newest qualified one still installed (claude-pin.cjs).
    const claudePin = require('./claude-pin.cjs'), fresh = !record.recovering && !record.forkPicker;
    const launch = claudePin.choose({ launcher: host.binaries.claude, fresh, lastVersion: record.nativeLaunchVersion,
      // Someone may have resumed this session elsewhere since: its own transcript says which version wrote last.
      lastWritten: fresh ? undefined : claudePin.lastWrittenVersion({ cwd: record.cwd, nativeId: record.nativeId, transcript: record.nativeTranscript }),
      stateFile: path.join(host.dataDir || host.privateDir, 'claude-pin.json') });
    if (launch.version) record.nativeLaunchVersion = launch.version; else delete record.nativeLaunchVersion;
    if (launch.pin) record.nativePin = launch.pin; else delete record.nativePin;
    host.checkClaudeVersion?.();
    this.terminal = new Terminal([launch.binary, ...identity, ...(record.autoName ? [] : ['--name', record.name]), '--prompt-suggestions', 'false', '--settings', settings, '--mcp-config', mcp, '--allowedTools', 'mcp__native_workspace__workspace_message,mcp__native_workspace__workspace_sessions,mcp__native_workspace__workspace_open,mcp__native_workspace__workspace_report', '--plugin-dir', path.join(__dirname, 'claude-bridge'), ...posture], record.cwd, {
      NAW_HOOK_TOKEN: this.token, NAW_HOOK_SOCKET: host.hookSocket, NAW_SUBMIT_SOCKET: host.submitSocket,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    });
    this.terminal.on('data', data => this.emit('terminal', data));
    this.terminal.on('started', pid => this.emit('pid', pid));
    this.terminal.on('closed', result => this.terminalClosed(result));
  }
  terminalClosed(result) {
    this.cancelQueueRefresh();
    this.cancelNativeAbort(); this.ready = false; this.submission.close();
    if (!result.confirmed) { this.emit('activity', ...uiActivity("notice.activity.terminalDisconnectedExitUnconfirmed")); this.emit('state', 'error'); return; }
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
      if (this.switchedTo) this.emit('activity', ...uiActivity("notice.activity.switchedTerminalExited", { arg1: this.switchedTo.slice(0, 8) }));
      else if (this.record.forkPicker) this.emit('activity', ...uiActivity("notice.activity.noBranchSelected"));
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
    if (this.startedRootTurn) this.startedRootTurn.inputRevoked = true;
    this.nativeBlocks = message.nativeBlocks === true;
    this.nativeMedia = this.nativeBlocks && message.nativeMedia === true;
    this.nativeQueue = message.nativeQueue === true;
    // Managed input needs both the accepted-row display and boundary-only hook
    // path. Old retained queues lack an attachment-to-app identity link.
    this.nativePromptInput = this.nativeBlocks && message.nativeInlineInput === true && message.nativePromptInput === true && !this.retainedReader;
    this.nativeInlineInput = this.nativeBlocks && message.nativeInlineInput === true && (this.retainedReader ? !this.nativeQueue : this.nativePromptInput);
    this.nativeAbortAvailable = message.nativeAbort === true && !this.retainedReader;
    // Recovery submits a new task only after a failed turn; it never needs abort.
    // Preserve the older mod contract only when the separate capability is absent.
    this.nativeCapacityAvailable = !this.retainedReader && (message.nativeCapacity === true ||
      message.nativeCapacity === undefined && this.nativeAbortAvailable);
    this.addressedSendAvailable = this.nativeBlocks && message.addressedTool === true && !this.retainedReader;
    this.nativeSharedDisplay = this.retainedReader && message.nativeSharedDisplay === true;
    // Native `!` commands, turn-start inputs and the turn's own clock (T-99).
    this.nativeTurnRecords = this.nativeBlocks && message.nativeTurnRecords === true && !this.retainedReader;
    this.nativeQueuedPromptLinks = this.nativeBlocks && message.nativeQueuedPromptLinks === true && !this.retainedReader;
    // 2.1.322 and 2.1.323 (measured): a queued message can enter the running turn at its next tool boundary.
    this.nativeMidturnAppend = this.nativeBlocks && message.nativeMidturnAppend === true && !this.retainedReader;
    // The model's running explanation, as the native terminal drew it (T-130).
    this.nativeNarration = this.nativeBlocks && message.nativeNarration === true && !this.retainedReader;
    this.displayProofs = new Map(); this.displayGap = false; this.gapFloor = 0;
    return { lease: this.rootLease, observationEpoch: this.observationEpoch, nativeBlocks: this.nativeBlocks, nativeInlineInput: this.nativeInlineInput, nativePromptInput: this.nativePromptInput, nativeMedia: this.nativeMedia, nativeTurnRecords: this.nativeTurnRecords, nativeQueuedPromptLinks: this.nativeQueuedPromptLinks, nativeMidturnAppend: this.nativeMidturnAppend, nativeNarration: this.nativeNarration };
  }
  validRootBinding(message) {
    return Boolean(this.rootLease && !this.rootEnding && message.lease === this.rootLease && message.sessionId === this.record.nativeId);
  }
  async promptIdentity(message) {
    // Native can flush the accepted user row just after the first display
    // hook. Bound this one metadata request to five reads with 25ms gaps,
    // rechecking
    // the original observer before every read; no standing watcher or send.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.validRootBinding(message) || message.epoch !== this.observationEpoch || this.disposed || !this.terminal?.alive || !this.nativeBlocks || !this.nativeQueuedPromptLinks || this.retainedReader) throw Error('Root unavailable');
      const uuid = claudePromptIdentity(this.nativeTranscript, this.record.nativeId, message.promptId);
      if (uuid) return { uuid };
      if (attempt < 4) await delay(25);
    }
    return { uuid: null };
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
      uiTitleMessage: uiNotice(message.kind === 'response' ? 'notice.legacy.replyTitle' : tool ? 'notice.legacy.toolOutput' : 'notice.legacy.unnamedToolOutput', message.kind !== 'response' && tool ? { tool } : undefined).uiMessage,
      ...(message.nonText === true ? { uiMessage: uiNotice('notice.legacy.nonText', { text: message.text }).uiMessage } : {}),
      text: message.text + (message.nonText === true ? '\n含非文本结果，请在原生终端查看。' : ''), truncated: message.truncated === true });
    return { observed: true };
  }
  observeBlock(message) {
    if (message.kind === 'prompt-media') {
      // T-133: an image in a prompt typed in the native terminal, named by prompt id and text tag. The
      // workspace gives it to that prompt's row with the same text. Only where prompt blocks are not shown themselves.
      const [, promptId, tag] = /^prompt:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-q([a-f0-9]{8})$/i.exec(message.id || '') || [];
      if (!this.nativeMedia || this.nativePromptInput || this.retainedReader || !this.validRootBinding(message) || message.epoch !== this.observationEpoch || !promptId ||
        message.mediaOnly !== true || message.status !== 'complete' || !require('./native-images.cjs').validImagePayload(message.imagePayload) ||
        !Number.isSafeInteger(message.sequence) || message.sequence <= (this.rootObservation?.sequence || 0) ||
        Object.keys(message).some(k => !['id', 'kind', 'status', 'mediaOnly', 'imagePayload', 'block', 'sessionId', 'lease', 'epoch', 'sequence', 'gap', 'gapThrough', 'replayed'].includes(k))) throw Error('Invalid native media');
      this.rootObservation = { lease: message.lease, sequence: message.sequence };
      if (!message.replayed) this.observationSeenAt = Date.now();
      if (message.gap) this.observeRootGap(message);
      this.emit('nativePromptImage', { promptId, tag: tag.toLowerCase(), nativeId: this.record.nativeId, imagePayload: message.imagePayload });
      return { observed: true };
    }
    if (message.mediaOnly === true) {
      const row = this.record.messages?.find(m => m.id === `native:${this.record.nativeId}:${message.id}`);
      if (!this.nativeMedia || !this.validRootBinding(message) || message.epoch !== this.observationEpoch ||
        !row || row.kind !== message.kind || !['tool', 'input'].includes(row.kind) || !['complete', 'submitted'].includes(row.status) ||
        message.status !== 'complete' || !require('./native-images.cjs').validImagePayload(message.imagePayload) ||
        Object.keys(message).some(key => !['id', 'kind', 'status', 'mediaOnly', 'imagePayload', 'block', 'sessionId', 'lease', 'epoch', 'sequence', 'gap', 'gapThrough', 'replayed'].includes(key))) throw Error('Invalid native media');
      // Media can enrich only an already accepted original. Derive all text
      // and attribution from that row, never from the metadata frame.
      message = { ...message, text: row.text, title: row.title, turnId: row.turnId,
        inputMode: row.inputMode, ...(row.kind === 'input' && !row.inputMode && row.inputTag ? { inputTag: row.inputTag } : {}) };
    } else if (message.imagePayload !== undefined) throw Error('Invalid native media');
    if (message.imageCount !== undefined && (!this.nativeMedia || !Number.isSafeInteger(message.imageCount) || message.imageCount < 1 || message.imageCount > 17 ||
      !['tool', 'input'].includes(message.kind) || message.status !== 'complete')) throw Error('Invalid native image count');
    const inline = message.kind === 'input' && message.inputMode === 'native-inline';
    const nativePrompt = message.kind === 'input' && message.inputMode === 'native-prompt';
    if ((!this.nativeBlocks && !(message.kind === 'control' && message.id === 'control:model')) || !this.validRootBinding(message) || message.epoch !== this.observationEpoch ||
      !/^(display|tool|turn|prompt|control|narration):[a-zA-Z0-9_:-]{1,160}$/.test(message.id || '') ||
      !['response', 'tool', 'turn', 'control', ...(this.retainedReader || this.nativeInlineInput ? ['input'] : []), ...(this.nativeNarration ? ['narration'] : [])].includes(message.kind) ||
      // The terminal's drawn explanation: its own id namespace and exact shape only.
      (message.kind === 'narration' || /^narration:/.test(message.id)) && (message.kind !== 'narration' ||
        !/^narration:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.id) || typeof message.text !== 'string' || !message.text.trim() ||
        typeof message.turnId !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(message.turnId) || message.status !== 'complete' ||
        !Number.isSafeInteger(message.order) || message.order < 0 ||
        message.beforeId !== undefined && (typeof message.beforeId !== 'string' || !/^(display|tool|turn|prompt):[a-zA-Z0-9_:-]{1,160}$/.test(message.beforeId)) ||
        Object.keys(message).some(key => !['id', 'kind', 'text', 'turnId', 'status', 'order', 'beforeId', 'block', 'sessionId', 'lease', 'epoch', 'sequence', 'gap', 'gapThrough', 'replayed'].includes(key))) ||
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
      !['text', 'delta', 'input', 'title'].every(k => message[k] === undefined || (typeof message[k] === 'string' && message[k].length <= 500000)) ||
      // A person's `!` command: only this mod's own id namespace, never a model tool.
      (message.userShell !== undefined || /^tool:shell-/.test(message.id)) && (!this.nativeTurnRecords || message.userShell !== true || message.kind !== 'tool' ||
        !/^tool:shell-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.id) || message.title !== 'Bash' ||
        typeof message.input !== 'string' || typeof message.text !== 'string' || !['complete', 'failed'].includes(message.status) ||
        message.incomplete !== undefined && message.incomplete !== true ||
        Object.keys(message).some(key => !['id', 'kind', 'title', 'userShell', 'input', 'text', 'status', 'incomplete', 'block', 'sessionId', 'lease', 'epoch', 'sequence', 'gap', 'gapThrough', 'replayed'].includes(key))) ||
      ['nativeDurationMs', 'nativeCompletedAt'].some(k => message[k] !== undefined) && (!this.nativeTurnRecords || message.kind !== 'turn' ||
        message.nativeDurationMs !== undefined && !(Number.isSafeInteger(message.nativeDurationMs) && message.nativeDurationMs >= 0) ||
        message.nativeCompletedAt !== undefined && !(Number.isFinite(message.nativeCompletedAt) && Math.abs(message.nativeCompletedAt) <= 8640000000000000)) ||
      message.triggers !== undefined && (!(this.nativeTurnRecords || this.nativeQueuedPromptLinks) || message.id !== 'control:turn-start' || !nativeTurnTriggers(message.triggers, !this.nativeTurnRecords))) throw Error('Invalid native block');
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
          // Steward step 2, batch 0: after a gap, a fresh start numbered above every declared loss (`gapFloor`) is where
          // NAW sees whole again, as after a bind: that turn began after each loss, and a later one is declared on the
          // next row or poll delivered. A start that carries a gap, or one numbered at or below a loss (a row of its own
          // turn can be dropped while it waits), restores nothing. Proofs the gap marked stay incomplete.
          if (!message.replayed && !message.gap && message.sequence > (this.gapFloor || 0)) this.displayGap = false;
          this.rootTurn = message.replayed || message.gap ? null : { id: message.turnId, promptId: message.promptId, status: 'working' };
          // T-138: the started root turn, kept apart from rootTurn (permission and input boundaries clear
          // that sharing authority); `announced` is how many prompts UserPromptSubmit had announced by then.
          this.startedRootTurn = message.replayed || message.gap ? null : { id: message.turnId, promptId: message.promptId, announced: this.announceCount || 0, completed: false };
          if (this.rootTurn) this.emit('nativeTurnStart', { nativeId: this.record.nativeId, turnId: message.turnId });
          if (message.triggers) {
            this.withdrawQueued();
            // The old text-only link cannot choose between equal queue entries.
            const prompts=message.triggers.prompts.filter(id=>!this.queuedRows?.get(`claude-prompt-${id}`)?.multiple);
            if(prompts.length||message.triggers.rows.length)this.emit('nativeTurnTriggers', { nativeId: this.record.nativeId, turnId: message.turnId, prompts, rows: message.triggers.rows });
          }
          this.liveTurn = this.rootTurn ? { id: message.turnId, promptId: message.promptId, phase: 'requesting', label: 'requesting' } : null;
          this.livePermissions.clear();
          if (this.rootTurn) { this.nativeInputRequired = false; this.emit('inputRequired', false); }
        }
      } else if (message.id === 'control:compact') {
        if (message.status !== 'complete') throw Error('Invalid native compact');
        // In order with the turn start that granted it, and also for a retained
        // reader, which has no settings hook. A replay retires too (fail closed).
        this.retireRootAuthority();
      } else if (message.id === 'control:heartbeat') {
        // The observation lease has its own liveness proof; a held native
        // submit may legitimately leave the independent input poll pending.
      } else if (message.id === 'control:activity') {
        const phases = ['requesting', 'thinking', 'text', 'input', 'tool', 'responding', 'tool-input', 'tool-use']; // Old mod phases remain readable during an exact-byte upgrade.
        if (!phases.includes(message.phase) || typeof message.turnId !== 'string') throw Error('Invalid native activity');
        if (!message.replayed && !message.gap && this.liveTurn?.id === message.turnId) {
          if (['tool', 'tool-use'].includes(message.phase) && !['tool', 'tool-use'].includes(this.liveTurn.phase)) {
            this.liveTurn.toolPhaseSerial = (this.liveTurn.toolPhaseSerial || 0) + 1;
            this.liveTurn.toolBinding = { nativeId: this.record.nativeId, epoch: this.observationEpoch };
            this.liveTurn.toolProgressAt = Date.now();
          }
          this.liveTurn.phase = message.phase; this.liveTurn.label = message.phase;
        }
      } else if (message.id === 'control:permission-end') {
        if (typeof message.permissionId !== 'string' || !/^permission:[a-zA-Z0-9_:-]{1,160}$/.test(message.permissionId)) throw Error('Invalid native permission');
        if (!message.replayed && !message.gap && this.livePermissions.delete(message.permissionId) && !this.livePermissions.size && this.liveTurn) this.emit('state', 'working');
      } else {
        if (!['control:permission', 'control:input'].includes(message.id)) throw Error('Invalid native control boundary');
        if (message.awaitingUser !== undefined && (message.id !== 'control:permission' || message.boundaryOnly !== true || message.awaitingUser !== false)) throw Error('Invalid native permission check');
        if (message.id === 'control:permission' && message.turnId &&
            (this.liveTurn && message.turnId !== this.liveTurn.id || this.displayProofs?.get(message.turnId)?.ended)) return { observed: true };
        if (message.id === 'control:permission' && !message.boundaryOnly && !message.replayed && !message.gap) {
          const id = message.permissionId || `permission:${message.sequence}`;
          if (!/^permission:[a-zA-Z0-9_:-]{1,160}$/.test(id) || this.livePermissions.size >= 16) throw Error('Invalid native permission');
          this.livePermissions.set(id, { id, title: message.title || '', input: message.input || '', incomplete: message.incomplete === true, turnId: message.turnId || this.liveTurn?.id });
          if (message.title === 'AskUserQuestion' && this.liveTurn && this.liveTurn.question !== false) this.liveTurn.question = true;
        }
        if (this.liveTurn && (message.id === 'control:input' || message.boundaryOnly && (!message.promptId || message.promptId !== this.liveTurn.promptId || message.turnId !== this.liveTurn.id))) this.liveTurn.question = false;
        if (this.startedRootTurn?.ended) this.startedRootTurn.inputRevoked = true;
        if (this.startedRootTurn) this.startedRootTurn.inputOnlyBoundary = this.startedRootTurn.inputOnlyBoundary !== false && message.id === 'control:input';
        this.rootTurn = null;
        // Current sessions need this boundary too: the classic permission/state
        // event can arrive later or be coalesced before a peer sees a snapshot.
        this.emit('nativeControlBoundary', message.id);
        if (this.nativeSharedDisplay) this.emit('sharingBoundary', message.id);
        // The ordered ingress owns the human boundary; accepted appends own
        // display. Settings hooks and later attachments must not repeat either.
        if (message.id === 'control:input' && this.nativePromptInput && !message.replayed) this.emit('nativeInput', '', { display: false });
        if (message.id === 'control:permission' && message.awaitingUser !== false && !message.replayed && !message.gap) this.emit('state', 'approval');
      }
      this.emit('capability'); return { observed: true };
    }
    if (message.kind === 'narration') {
      // Reading only: never part of a turn's final reply or its sharing proof.
      this.emit('nativeBlock', { id: message.id, nativeId: this.record.nativeId, kind: 'response', phase: 'commentary', turnId: message.turnId,
        text: message.text, status: 'complete', order: message.order, replayed: message.replayed === true, ...(message.beforeId ? { beforeId: message.beforeId } : {}) });
      return { observed: true };
    }
    const { id, kind, turnId, displayTurnId, promptId, text, delta, index, title, status, input, incomplete } = message;
    if (kind === 'tool' && !message.replayed && !message.gap && turnId && this.liveTurn?.id === turnId) {
      this.liveTurn.toolProgressAt = Date.now();
    }
    const freshInline = inline && !message.replayed && !this.record.messages?.some(row => row.id === `native:${this.record.nativeId}:${id}`);
    if (freshInline) {
      this.rootTurn = null;
      if (this.startedRootTurn?.ended) this.startedRootTurn.inputRevoked = true;
      if (this.startedRootTurn) this.startedRootTurn.inputOnlyBoundary = this.startedRootTurn.inputOnlyBoundary !== false;
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
      ...(message.imageCount !== undefined ? { imageCount: message.imageCount } : {}),
      ...(message.userShell === true ? { toolKind: 'commandExecution', commandSource: 'userShell' } : {}),
      ...(kind === 'turn' ? Object.fromEntries(['nativeDurationMs', 'nativeCompletedAt'].filter(k => message[k] !== undefined).map(k => [k, message[k]])) : {}) });
    // A tool permission boundary revokes rootTurn's sharing authority. The
    // independently observed root can still finish failed and accept a new
    // explicit input; this never recreates sharing or automatic-retry proof.
    if (kind === 'turn' && this.startedRootTurn?.id === turnId && !this.startedRootTurn.completed && !message.replayed && !message.gap) {
      this.startedRootTurn.ended = true;
      if (status === 'failed' && message.failedRequest === true) {
        this.startedRootTurn.status = 'error'; this.startedRootTurn.failedInput = true;
        this.startedRootTurn.failureCause = !incomplete && !turn.incomplete && message.failureCause === 'usageCredits' ? 'usageCredits' : null;
      }
      this.reportCreditFailure();
      this.emit('capability');
    }
    if (kind === 'turn' && this.rootTurn?.id === turnId && !this.rootTurn.completed && ['working', 'error', null].includes(this.rootTurn.status) && !message.replayed && !message.gap) {
      this.rootTurn.status = status === 'interrupted' ? 'idle' : status === 'failed' && message.failedRequest === true ? 'error' : null;
      this.rootTurn.completed = status === 'complete';
      if (this.rootTurn.completed && !incomplete && !turn.incomplete) {
        if (this.startedRootTurn?.id === turnId) this.startedRootTurn.endReported = true; // never a second, boundary end (T-141)
        this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId, status: 'completed' });
      } else if (this.rootTurn.completed && this.startedRootTurn?.id === turnId && !this.startedRootTurn.endReported) {
        // Ended but not seen whole (a display index missing, a turn too large to prove): reported once, never as
        // completed, so a wake staged in it is withdrawn with that reason instead of staying 已登记 for good.
        this.startedRootTurn.endReported = true;
        this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId, status: 'incomplete' });
      }
      if (status === 'failed' && message.failedRequest === true && !incomplete && !turn.incomplete && /^[a-f0-9-]{36}$/i.test(message.errorMessageId || '')) {
        // A row that replaces an unclassified one is read as if that one had never been named: its reads, its wait
        // for the saved row, a cancellation of that wait and the control posture of its first read decide nothing.
        if (this.rootTurn.errorRowUnclassified && this.rootTurn.errorMessageId !== message.errorMessageId && !this.rootTurn.endReported) Object.assign(this.rootTurn, { failureReads: 0, pendingFailure: false, failureCancelled: false, failurePosture: null });
        this.rootTurn.errorMessageId = message.errorMessageId;
        this.rootTurn.errorRowUnclassified = message.errorRowUnclassified === true;
      } else if (status === 'failed' && message.failedRequest === true && this.rootTurn.errorRowUnclassified) {
        // The bridge names an unclassified row only while it is the turn's single one. Once it stops (a second such
        // row followed, even after the end was reported), no row stands for this turn and a continuation scheduled
        // from the first one ends at the next tick, as it does for two rows in a known format.
        this.rootTurn.errorMessageId = null; this.rootTurn.pendingFailure = false;
      }
      if (status === 'failed' && message.failedRequest === true && !incomplete && !turn.incomplete && message.failureCause === 'usageCredits') this.rootTurn.failureCause = 'usageCredits';
      if (incomplete || turn.incomplete) this.rootTurn.errorMessageId = null;
      this.reportCapacityFailure();
      this.reportCreditFailure();
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
    // T-141: an input or permission boundary clears rootTurn (its sharing authority), so this turn's end was
    // never reported and a wake it staged stayed 已登记 for good (measured on 2.1.317). Report the end once,
    // without that authority, so the wake is withdrawn with its reason.
    if (kind === 'turn' && this.startedRootTurn?.id === turnId && !this.rootTurn && !this.startedRootTurn.endReported && !message.replayed && !message.gap) {
      this.startedRootTurn.endReported = true;
      this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId, status: 'boundary',
        ...(this.startedRootTurn.inputOnlyBoundary === true && status === 'complete' && !incomplete && !turn.incomplete ? { completedAfterInput: true } : {}) });
    }
    if (kind === 'turn' && status === 'complete' && this.startedRootTurn?.id === turnId && !message.replayed && !message.gap) {
      this.startedRootTurn.completed = true;
      if (this.unannouncedStop?.turnId === turnId) this.settleUnannounced(turnId);
    }
    if (kind === 'turn' && this.pending?.turnId === turnId && this.pending.stopEvent) this.finishReply(this.pending, this.pending.stopEvent);
    return { observed: true };
  }
  reportCapacityFailure(retry = false) {
    const turn = this.rootTurn;
    if (!this.nativeCapacityAvailable || this.retainedReader || !turn || turn.endReported || turn.completed || turn.inputUsed || turn.failureCancelled ||
      !turn.failedTranscript || !turn.errorMessageId || !this.failedTurnInputMatches(turn.id) || turn.failureReads && !retry) return;
    turn.failurePosture ||= { owner: this.record.owner, control: this.record.controlRevision, member: this.record.memberRevision };
    const same = turn.failurePosture.owner === this.record.owner && turn.failurePosture.control === this.record.controlRevision && turn.failurePosture.member === this.record.memberRevision;
    const cause = same ? claudeFailureCause(turn.failedTranscript, this.record.nativeId, turn.errorMessageId) : false;
    turn.failureReads = (turn.failureReads || 0) + 1;
    turn.pendingFailure = cause === null && turn.failureReads < 5;
    if (turn.pendingFailure) return;
    // The bridge passes on a failure row whose prose it does not know only so that this read can find a typed 403
    // (native words it "Please run /login · API Error: 403 …"). Any other such row leaves the turn as it was before
    // these rows were passed on: no failed end is reported from it, and an overload is not taken from it either.
    if (turn.errorRowUnclassified && cause !== 'requestForbidden') return;
    turn.endReported = true;
    if (this.startedRootTurn?.id === turn.id) this.startedRootTurn.endReported = true; // never a second, boundary end (T-141)
    this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId: turn.id, status: 'failed', errorInfo: cause || null });
  }
  reportCreditFailure() {
    const turn = this.failedInputTurn;
    if (turn?.failureCause !== 'usageCredits' || turn.creditsReported || !turn.failedTranscript || !this.failedTurnInputMatches(turn.id)) return;
    turn.creditsReported = true;
    const notice = uiNotice('notice.failure.usageCreditsUnavailable');
    this.emit('activity', notice.text, notice.uiMessage);
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
    request.reject(uiError("error.nativeInterruptUnconfirmed"));
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
    // A queued message still waiting for its own turn does not hold the stopped turn (T-133).
    if (!request.apiDone || !request.nativeDone || !request.submitSettled || (this.submission.pending && this.submission.pending.tag !== this.queued?.tag)) return;
    this.nativeAbortRequest = null; clearTimeout(request.timer);
    this.nativeInputRequired = false; this.emit('inputRequired', false); request.resolve({ interrupted: true });
  }
  // A native compaction keeps the session but ends the running turn's authority:
  // every issued root call, outbox proof and control scope checks these
  // references (native-root-proof.cjs). The next person or NAW turn re-authorizes;
  // its turn start is new, and the compacted turn's id stays tombstoned.
  retireRootAuthority() {
    this.rootTurn = null; this.liveTurn = null; this.startedRootTurn = null; this.livePermissions?.clear();
  }
  observeRootGap(message) {
    if (!this.validRootBinding(message) || !this.observationEpoch || message.epoch !== this.observationEpoch) throw Error('Invalid native observation');
    this.cancelNativeAbort(); this.rootTurn = null; this.liveTurn = null; this.livePermissions?.clear();
    if (this.startedRootTurn) this.startedRootTurn.inputRevoked = true;
    this.displayGap = true; for (const turn of this.displayProofs?.values() || []) turn.incomplete = true;
    // The last sequence the bridge had numbered when it lost something; a declaration without one (an older bridge)
    // holds until a rebind, as before.
    this.gapFloor = Math.max(this.gapFloor || 0, Number.isSafeInteger(message.gapThrough) && message.gapThrough >= 0 ? message.gapThrough : Infinity);
    this.emit('progress', { id: `claude-observation-gap-${this.record.nativeId}`,
      source: 'claude-native-message', kind: 'gap', status: 'unknown', title: '部分原生消息未能同步', uiTitleMessage: uiNotice('notice.legacy.gapTitle').uiMessage,
      text: '本地观察连接或队列出现缺口，请核对原生终端。没有重发任务。', uiMessage: uiNotice('notice.legacy.gapText').uiMessage });
    if (this.nativeBlocks) this.emit('nativeBlock', { id: `gap:${this.observationEpoch}`, nativeId: this.record.nativeId, kind: 'gap', status: 'unconfirmed', text: '部分原生内容未能同步，请在原生终端核对。没有重发任务。', uiMessage: uiNotice('notice.observation.nativeContentGap').uiMessage });
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
      return { lease: this.rootLease, observationEpoch: this.observationEpoch, nativeInlineInput: this.nativeInlineInput, nativePromptInput: this.nativePromptInput, nativeMedia: this.nativeMedia, nativeTurnRecords: this.nativeTurnRecords === true, nativeNarration: this.nativeNarration === true }; // Lost metadata ACK, never a second clear.
    }
    if (!this.rootLease || message.lease !== this.rootLease || this.rootEnding?.sessionId !== message.sessionId ||
      !FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason] || FOLLOWED_ROOT_TRANSITIONS[this.rootEnding.reason] !== message.source || this.rootEnding.unfollowed || message.agentId ||
      typeof message.nextSessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.nextSessionId) ||
      message.nextSessionId === message.sessionId || !this.terminal?.alive) throw Error('Unverified root transition');
    const change = { previousId: message.sessionId, nativeId: message.nextSessionId, reason: message.source === 'fork' ? 'branch' : 'clear',
      model: typeof message.model === 'string' && message.model.length <= 120 ? message.model : '原生未报告',
      modelUiMessage: typeof message.model === 'string' && message.model.length <= 120 ? null : uiNotice('notice.model.nativeUnreported').uiMessage, committed: false };
    this.emit('contextClear', change);
    if (!change.committed || this.record.nativeId !== change.nativeId) throw Error('Context not saved');
    this.lastRootTransition = { sessionId: message.sessionId, nextSessionId: message.nextSessionId, lease: message.lease };
    this.rootLease = crypto.randomBytes(32).toString('hex');
    this.observationEpoch = crypto.randomBytes(16).toString('hex'); this.rootObservation = null;
    this.rootEnding = null; this.lastPromptId = null; this.pending = null; this.ready = true;
    this.displayProofs = new Map(); this.displayGap = false; this.gapFloor = 0;
    this.emit('state', 'idle'); this.emit('model', change.model, change.modelUiMessage);
    const observed = (this.contextEvents || []).filter(e => e.session_id === change.nativeId);
    this.contextEvents = (this.contextEvents || []).filter(e => e.session_id !== change.nativeId);
    for (const event of observed) this.hook(event);
    return { lease: this.rootLease, observationEpoch: this.observationEpoch, nativeInlineInput: this.nativeInlineInput, nativePromptInput: this.nativePromptInput, nativeMedia: this.nativeMedia, nativeTurnRecords: this.nativeTurnRecords === true, nativeNarration: this.nativeNarration === true };
  }
  reconcileLocalApproval() {
    if (!this.localApprovalPending || this.localApprovalPending !== this.observationEpoch || this.displayGap ||
        !this.ready || this.rootEnding || this.disposed || this.liveTurn ||
        this.rootTurn?.status === 'working' || this.livePermissions?.size || this.pending || this.queued ||
        this.submission?.pending || this.nativeInputRequired || this.nativeAbortRequest) return;
    const { terminalDialogPrompt, claudeEmptyPrompt } = require('./native-terminal-dialog.cjs');
    if (terminalDialogPrompt(this.record, this) || !claudeEmptyPrompt(this)) return;
    this.localApprovalPending = false;
    this.emit('state', 'idle');
    return true;
  }
  hookApproval() {
    // Local slash commands can notify without ever starting/stopping a model
    // turn. Only that unbound hook state may be retired by the native editor.
    const idleHook = this.localApprovalState === 'idle' || this.localApprovalPending === this.observationEpoch;
    this.localApprovalPending = idleHook && this.nativeBlocks === true && !this.displayGap && !this.liveTurn && this.rootTurn?.status !== 'working' &&
      !this.pending && !this.queued && !this.submission?.pending ? this.observationEpoch : false;
    this.rootTurn = null;
    if (this.queued) this.queued.superseded = true;
    this.pending = null;
    if (!this.reconcileLocalApproval()) this.emit('state', 'approval');
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
        this.emit('activity', ...uiActivity("notice.activity.nativeContextSyncLimit"));
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
      nameUiMessage: event.teammate_name || event.agent_type || event.task_subject ? null : uiNotice('notice.fleet.nativeTeamActivity').uiMessage,
    });
    if (isChild) return;
    // Only an authenticated root settings event selects the journal. The
    // identity lookup route never accepts a caller-supplied filesystem path.
    if (event.session_id === this.record.nativeId && typeof event.transcript_path === 'string' &&
      path.isAbsolute(event.transcript_path) && path.basename(event.transcript_path) === `${this.record.nativeId}.jsonl`) {
      this.nativeTranscript = event.transcript_path;
      // Kept with the session, so a later resume can see which version wrote it last (claude-pin.cjs).
      if (this.record.nativeTranscript !== event.transcript_path) { this.record.nativeTranscript = event.transcript_path; this.emit('capability'); }
    }
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
    // At a turn's end the prompts typed during it were read, are still waiting, or were taken back.
    if (['Stop', 'StopFailure'].includes(event.hook_event_name)) this.withdrawQueued();
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
    // A background task is named when it starts. One that ends within the same turn is in no turn-end report,
    // and its notification arrives during that turn without a source (real 2.1.322, 11-12).
    if (event.hook_event_name === 'PostToolUse' && typeof event.background_task_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(event.background_task_id)) {
      this.emit('backgroundStarted', event.background_task_id);
    }
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) this.emit('progress', {
      id: event.tool_use_id, source: 'claude-hook', kind: 'tool', title: event.tool_name || '',
      status: event.hook_event_name === 'PreToolUse' ? 'running' : event.hook_event_name === 'PostToolUse' ? 'completed' : 'failed',
    });
    if (['PermissionRequest', 'Notification', 'StopFailure'].includes(event.hook_event_name)) this.emit('progress', {
      source: 'claude-hook', kind: event.hook_event_name, title: event.hook_event_name === 'PermissionRequest' ? '等待原生权限确认' : event.hook_event_name === 'StopFailure' ? '原生请求失败' : '原生通知',
      uiTitleMessage: uiNotice(event.hook_event_name === 'PermissionRequest' ? 'notice.run.approval' : event.hook_event_name === 'StopFailure' ? 'notice.hook.nativeFailure' : 'notice.hook.nativeNotification').uiMessage,
      text: event.message || '', status: event.hook_event_name === 'StopFailure' ? 'failed' : 'observed',
    });
    switch (event.hook_event_name) {
      case 'SessionStart':
        if (this.rootEnding) break;
        // A compaction restarts the context without ending the root. The ordered
        // observation also carries it (control:compact); this settings hook is the
        // second path, for a bridge copy that does not send it yet.
        if (event.source === 'compact') this.retireRootAuthority();
        this.ready = true; this.emit('state', 'idle'); if (!this.nativeModelEpoch || this.nativeModelEpoch !== this.observationEpoch) this.emit('model', event.model || '原生未报告', event.model ? undefined : uiNotice('notice.model.nativeUnreported').uiMessage); break;
      case 'UserPromptSubmit': {
        if (this.liveTurn && (!event.prompt_id || event.prompt_id !== this.liveTurn.promptId)) this.liveTurn.question = false;
        // A settings hook observing a prompt is not its acceptance. The native
        // structured submission result acknowledges our own sends separately.
        if (this.rootTurn?.promptId !== event.prompt_id) this.rootTurn = null;
        this.lastPromptId = event.prompt_id || null;
        const promptAlreadyAnnounced = Boolean(event.prompt_id && (this.announcedPrompts?.has(event.prompt_id) || this.firstPromptRow(event.prompt_id)));
        if (event.prompt_id) {
          this.announcedPrompts ||= new Set(); this.announcedPrompts.add(event.prompt_id); this.announceCount = (this.announceCount || 0) + 1;
          if (this.announcedPrompts.size > 64) this.announcedPrompts.delete(this.announcedPrompts.values().next().value);
        }
        // T-138 display: on 2.1.316/2.1.317 a prompt typed during a turn shares that turn's prompt id. Every
        // submit is recorded here, our own sends included, so the first text per id is known. A later,
        // different text gets its own row, `-q<tag>` from its text (the mod tags the turn it starts the same
        // way), and is not the running turn's input: T-141, it would re-capture that turn's wake authority.
        // Where this prompt's turn begins in the journal: queue rows of the prompts typed during it come later.
        if (event.prompt_id && !this.promptTexts?.has(event.prompt_id) && !this.firstPromptRow(event.prompt_id)) this.queueWindowStart(event.prompt_id);
        const firstText = event.prompt_id ? this.promptFirstText(event.prompt_id, event.prompt) : undefined;
        const laterText = Boolean(event.prompt_id) && typeof event.prompt === 'string' && typeof firstText === 'string' && event.prompt !== firstText;
        if(!this.nativePromptInput&&event.prompt_id&&typeof event.prompt==='string')
          this.queueOrigin(event,promptAlreadyAnnounced||laterText);
        // A typed prompt taken back before this one is not shown as sent (an edited one comes back as this one).
        this.withdrawQueued();
        const rowId = !event.prompt_id ? null : laterText ? `claude-prompt-${event.prompt_id}-q${promptTextTag(event.prompt)}` : `claude-prompt-${event.prompt_id}`;
        const entering = this.queued || this.pending;
        if (entering && !entering.accepted && this.submission.pending?.authorized && event.prompt === entering.text) {
          entering.prompts.add(event.prompt_id || null);
          if (entering === this.queued) this.emit('state', 'working');
        } else if (!this.pending || event.prompt !== this.pending.text || event.prompt_id !== this.pending.promptId) {
          // Input under the native prompt id our accepted send was given arrives inside that turn (2.1.316+;
          // on 2.1.322 a background task's own notification, 11-13). It displaced nothing and the turn is still ours;
          // a person's input there still pauses and moves the control revision, so the reply stays private.
          const inside = Boolean(this.pending?.promptId && event.prompt_id === this.pending.promptId);
          const superseded = Boolean(this.queued || (this.pending && !inside));
          if (this.queued) this.queued.superseded = true;
          if (!inside) this.pending = null;
          this.emit('state', 'working');
          // The first hook may follow turn-start. A repeated id is still input,
          // but must not recapture that turn's wake proof, even for identical text.
          if (!this.nativePromptInput) this.emit('nativeInput', event.prompt || '原生输入', event.prompt_id ? { id: rowId, ...(!laterText && !promptAlreadyAnnounced && this.liveTurn?.promptId === event.prompt_id ? { turnId: this.liveTurn.id } : {}), ...(typeof event.source === 'string' ? { source: event.source } : {}), ...(superseded ? { superseded } : {}) } : undefined);
        }
        if (!this.nativePromptInput && event.prompt_id && typeof event.prompt === 'string') {
          if(promptAlreadyAnnounced||laterText)this.refreshQueuedSoon();
        }
        break;
      }
      case 'PermissionRequest': if (this.liveTurn && (!event.prompt_id || event.prompt_id !== this.liveTurn.promptId)) this.liveTurn.question = false; this.hookApproval(); break;
      case 'Notification':
        if (/permission|elicitation|auth/.test(event.notification_type || '')) { if (this.liveTurn) this.liveTurn.question = false; this.hookApproval(); }
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
          // T-138: a queued prompt's own turn, or a `!` turn, stops under a prompt id no
          // UserPromptSubmit announced (2.1.316, 2.1.317). A late Stop of an earlier prompt
          // carries an announced id and stays dropped. The root turn's own end settles it.
          const started = this.startedRootTurn;
          if (!pending && !this.queued && this.nativeBlocks && !this.retainedReader && started && started.announced === (this.announceCount || 0) &&
            /^[a-f0-9-]{36}$/i.test(event.prompt_id || '') && !this.announcedPrompts?.has(event.prompt_id)) {
            this.unannouncedStop = { turnId: started.id, event };
            if (started.completed) this.settleUnannounced(started.id);
          }
          return;
        }
        this.finishReply(pending, event);
        break;
      }
      case 'StopFailure':
        if (this.liveTurn) this.liveTurn.question = false;
        if (this.rootTurn?.promptId !== event.prompt_id) this.rootTurn = null;
        clearTimeout(this.pending?.displayTimer); this.pending = null;
        this.emit('state', 'error'); { const notice = uiNotice(this.rootTurn?.failureCause === 'usageCredits' && this.failedTurnInputMatches(this.rootTurn.id)
          ? 'notice.failure.usageCreditsUnavailable' : 'notice.failure.nativeRequestIncomplete'); this.emit('failed', notice.text, undefined, notice.uiMessage); }
        if (this.rootTurn) this.rootTurn.failedTranscript = event.transcript_path;
        if (this.startedRootTurn && !this.startedRootTurn.completed && event.prompt_id === this.lastPromptId) this.startedRootTurn.failedTranscript = event.transcript_path;
        this.reportCapacityFailure(); this.reportCreditFailure(); break;
      case 'SessionEnd': this.contextEnding(event.reason); break;
    }
  }
  firstPromptRow(id) {
    return this.record.messages?.find(m => m.id === `claude-prompt-${id}` && m.role === 'user' && m.origin === 'native' &&
      this.record.nativeId && m.nativeId === this.record.nativeId && typeof m.text === 'string');
  }
  queueWindowStart(promptId) {
    let size = null;
    if (this.nativeTranscript) {
      try { const stat = fs.lstatSync(this.nativeTranscript); if (stat.isFile()) size = stat.size; } catch (error) { if (error.code === 'ENOENT') size = 0; }
    }
    this.queueWindows ||= new Map(); this.queueWindows.delete(promptId);
    if (size !== null) this.queueWindows.set(promptId, size);
    while (this.queueWindows.size > 4) this.queueWindows.delete(this.queueWindows.keys().next().value);
  }
  queueOrigin(event,queued) {
    const key=`claude-prompt-${event.prompt_id}-q${promptTextTag(event.prompt)}`;
    this.queuedRows ||= new Map();const prior=this.queuedRows.get(key);
    const row=prior?.nativeId===this.record.nativeId?prior:{promptId:event.prompt_id,text:event.prompt,nativeId:this.record.nativeId,origins:[]};
    this.queuedRows.delete(key);this.queuedRows.set(key,row);
    while(this.queuedRows.size>16)this.queuedRows.delete(this.queuedRows.keys().next().value);
    let human=false;
    this.emit('nativeInputOrigin',event.prompt,{source:event.source},value=>{human=value===true;});
    let at;
    try {const s=fs.lstatSync(this.nativeTranscript);if(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&Number.isSafeInteger(s.size))at=s.size;}
    catch(error){if(error.code==='ENOENT'&&this.queueWindows?.get(event.prompt_id)===0)at=0;}
    if(at===undefined){row.unverified=true;return;}
    // Byte boundaries bind source observations to later enqueues. A later
    // human hook cannot erase a peer/unknown interval, including equal text.
    const bits=human&&queued?1:2,last=row.origins.at(-1),anchor=this.record.messages?.at(-1);
    const afterId=anchor&&(!anchor.nativeId||anchor.nativeId===row.nativeId)?anchor.id:undefined;
    if(last&&at<last.at){row.unverified=true;return;}
    // Several hooks may precede one journal flush. Count equal observations,
    // keeping separate runs when the source or progress anchor changes.
    if(last?.at===at&&last.bits===bits&&last.afterId===afterId&&Number.isSafeInteger(last.count+1))last.count++;
    else if(row.origins.length<256)row.origins.push({at,bits,count:1,afterId});
    else row.origins[255].bits=2; // Unknown overflow never becomes another human copy.
  }
  cancelQueueRefresh() {
    clearTimeout(this.queueRefreshTimer);clearTimeout(this.queueRefreshDeadline);
    this.queueRefreshWatch?.close();this.queueRefreshWatch=null;
  }
  refreshQueuedSoon() {
    this.cancelQueueRefresh();const nativeId=this.record.nativeId;
    const refresh=()=>{
      if(this.disposed||!this.terminal?.alive||this.record.nativeId!==nativeId)return this.cancelQueueRefresh();
      try {this.withdrawQueued();} catch { /* Keep the existing display if its journal/view became unavailable. */ }
    };
    const soon=()=>{clearTimeout(this.queueRefreshTimer);this.queueRefreshTimer=setTimeout(refresh,50);this.queueRefreshTimer.unref?.();};
    // Enqueue is written after the settings hook returns. Observe its file,
    // coalesced and for at most the hook's two-second lifetime, not by polling.
    try {
      const s=fs.lstatSync(this.nativeTranscript);
      if(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()) {
        this.queueRefreshWatch=fs.watch(this.nativeTranscript,{persistent:false},soon);
        this.queueRefreshWatch.on('error',()=>this.cancelQueueRefresh());
      }
    } catch { /* A not-yet-created journal is checked once at the deadline. */ }
    soon();this.queueRefreshDeadline=setTimeout(()=>{this.cancelQueueRefresh();refresh();},2000);this.queueRefreshDeadline.unref?.();
  }
  // Queue occurrence offsets distinguish equal text; reading the same journal
  // twice does not create another input. No journal proof means no row removal.
  withdrawQueued() {
    if (!this.queuedRows?.size) return;
    for (const [id, row] of this.queuedRows) if (row.nativeId!==this.record.nativeId||this.queueWindows?.get(row.promptId) === undefined) this.queuedRows.delete(id);
    if (!this.queuedRows.size) return;
    const from = Math.min(...[...this.queuedRows.values()].map(row => this.queueWindows.get(row.promptId)));
    const rows = claudeQueueRows(this.nativeTranscript, this.record.nativeId, from);
    if (!rows) return;
    for (const [id, row] of [...this.queuedRows]) {
      const start = this.queueWindows.get(row.promptId),end=Math.min(Infinity,...[...this.queueWindows.values()].filter(at=>at>start));
      const mine = rows.filter(r => r.at >= start && r.at < end && r.text === row.text);
      const occurrences=[],origins=[],originsUsed=new Map();
      for(const observation of row.origins||[]) {
        let group=origins.at(-1);
        if(!group||group.at!==observation.at){group={at:observation.at,proofs:[],count:0,allHuman:true};origins.push(group);}
        if(Number.isSafeInteger(observation.count)&&observation.count>0&&Number.isSafeInteger(group.count+observation.count)) {
          group.count+=observation.count;group.proofs.push({through:group.count,afterId:observation.afterId});
        } else group.allHuman=false;
        if(observation.bits!==1)group.allHuman=false;
      }
      for(const entry of mine) {
        if(entry.kind==='queued') {
          const key=occurrences.length?`${id}-e${entry.at.toString(16)}`:id;
          const origin=origins.findLast(item=>item.at<=entry.at),used=originsUsed.get(origin)||0,proof=origin?.proofs.find(item=>item.through>used);
          const human=!row.unverified&&origin?.allHuman===true&&Boolean(proof);
          if(human)originsUsed.set(origin,used+1);
          occurrences.push({id:key,time:entry.time,human,afterId:proof?.afterId,
            read:false,taken:false,linked:this.record.messages?.some(m=>m.id===key&&m.turnId)});
        } else if(entry.kind==='read') {
          const read=occurrences.find(item=>!item.taken&&!item.read);if(read)read.read=true;
        } else {
          // Withdraw one still waiting copy, preserving delivered/turn-linked
          // rows. Equal text carries no native per-copy ID; never grant a turn
          // link from that ambiguity (multiple below).
          const taken=occurrences.findLast(item=>!item.taken&&!item.read&&!item.linked);if(taken)taken.taken=true;
        }
      }
      if(!occurrences.length)continue;
      row.multiple=occurrences.length>1;
      const taken=new Set(occurrences.filter(item=>item.taken).map(item=>item.id));
      const proven=occurrences.filter(item=>!item.taken&&item.human);
      // Each source observation proves at most one copy. An already displayed
      // human fallback also occupies a slot, even when its enqueue is unknown.
      const displayed=(this.record.messages||[]).filter(m=>m.role==='user'&&m.origin==='native'&&(!m.nativeId||m.nativeId===this.record.nativeId)&&
        m.text===row.text&&!m.inputSource&&(m.id===id||m.id?.startsWith(id+'-e'))&&(!taken.has(m.id)||m.turnId));
      let slots=Math.max(0,proven.length-displayed.length);
      for(const item of proven)if(!this.record.messages?.some(m=>m.id===item.id)&&slots>0) {
        this.emit('nativeQueuedInput',{id:item.id,baseId:id,nativeId:this.record.nativeId,text:row.text,time:item.time,afterId:item.afterId});slots--;
      }
      for(const message of [...(this.record.messages||[])])if(message.role==='user'&&message.origin==='native'&&message.text===row.text&&
          taken.has(message.id))this.emit('nativeInputWithdrawn',{id:message.id,nativeId:this.record.nativeId});
    }
  }
  promptFirstText(id, text) {
    this.promptTexts ||= new Map();
    if (!this.promptTexts.has(id)) {
      // A cold adapter can recover the original prompt's text, but only from this native context.
      const saved = this.firstPromptRow(id);
      this.promptTexts.set(id, saved ? saved.text : text);
      while (this.promptTexts.size > 64) this.promptTexts.delete(this.promptTexts.keys().next().value);
    }
    return this.promptTexts.get(id);
  }
  // Idle without a reply: nothing is shared or attributed, the session only stops showing work (T-138).
  settleUnannounced(turnId) {
    const stopped = this.unannouncedStop;
    const started = this.startedRootTurn;
    // Only the started root turn that ended, with no prompt announced since it started.
    if (!stopped || stopped.turnId !== turnId || started?.id !== turnId || !started.completed || started.announced !== (this.announceCount || 0) || this.pending || this.queued) return;
    this.unannouncedStop = null;
    const { background, scheduled, stopHookActive } = this.emitBackground(stopped.event);
    this.emit('state', 'idle');
    this.emit('complete', { text: '', background, scheduled, fleetPending: null, stopHookActive });
  }
  emitBackground(event) {
    const background = Array.isArray(event.background_tasks) ? event.background_tasks.length : null;
    const scheduled = Array.isArray(event.session_crons) ? event.session_crons.length : null;
    // Type labels only; task descriptions and commands stay in the native session.
    const kinds = background ? event.background_tasks.slice(0, 50).map(t => ['shell', 'subagent', 'monitor', 'workflow'].includes(t?.type) ? t.type : 'other') : null;
    // Opaque task IDs only, kept in memory: a later notification turn for one of them is machine input.
    const ids = background ? event.background_tasks.slice(0, 50).map(t => typeof t?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t.id) ? t.id : null).filter(Boolean) : [];
    this.emit('background', { count: background, scheduled, kinds, ids });
    return { background, scheduled, stopHookActive: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null };
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
        const { background, scheduled } = this.emitBackground(event);
        this.emit('state', 'idle');
        // Observed child hooks cannot certify that all descendants are idle.
        this.emit('complete', { messageId: displayConfirmed ? proof?.messageId : undefined, tag: accepted && displayConfirmed ? pending.tag : undefined, text: this.nativeBlocks ? displayConfirmed ? proof?.safeText || '' : '' : event.last_assistant_message || '', background, scheduled, fleetPending: null, stopHookActive: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null });
  }
  async send(text, tag, guard) {
    if (this.nativeAbortRequest) throw uiError("error.nativeInterruptPending");
    if (this.nativeInputRequired) throw uiError("error.claudePluginInputPaused");
    if (!this.ready || this.pending || this.queued) throw uiError("error.claudeInputNotReady");
    if (!guard()) throw uiError("error.handoffRevoked");
    const failedPromptId = this.failedTurnInputId ? this.failedInputTurn.promptId : null;
    this.claimFailedTurnInput();
    const pending = this.pending = { tag, text, guard, nativeId: this.record.nativeId, failedPromptId, accepted: false, promptId: null, prompts: new Set(), replies: new Map() };
    return this.deliver(pending);
  }
  get failedInputTurn() { return this.rootTurn?.status === 'error' ? this.rootTurn : this.startedRootTurn?.failedInput && !this.startedRootTurn.completed ? this.startedRootTurn : null; }
  failedTurnInputMatches(id) {
    const turn = this.failedInputTurn;
    return Boolean(id && turn?.id === id && turn.status === 'error' && !turn.inputRevoked &&
      this.rootLease && !this.rootEnding && !this.disposed && this.terminal?.alive && this.submission.connected &&
      !this.nativeInputRequired && !this.livePermissions?.size && (this.retainedReader || this.lastPromptId === turn.promptId));
  }
  get failedTurnInputId() { return !this.failedInputTurn?.inputUsed && this.failedTurnInputMatches(this.failedInputTurn?.id) ? this.failedInputTurn.id : null; }
  claimFailedTurnInput() {
    if (this.failedTurnInputId) {
      const turn = this.failedInputTurn; turn.inputUsed = true;
      if (this.startedRootTurn?.id === turn.id) this.startedRootTurn.inputUsed = true;
      this.emit('capability');
    }
  }
  get queueAvailable() { return Boolean(!this.nativeAbortRequest && !this.nativeInputRequired && this.nativeQueue && this.rootLease && !this.rootEnding && this.ready && this.chatAvailable); }
  // A queued message is read at the running turn's next tool boundary, or runs as its own turn.
  get midturnAvailable() { return this.queueAvailable && this.nativeMidturnAppend === true; }
  midturnRead(read) {
    if (!this.midturnRows?.has(read.tag) || this.midturnRows.get(read.tag) !== read.uuid) return;
    this.midturnRows.delete(read.tag); this.emit('midturnRead', read);
  }
  // midturnText: what the running turn reads instead, if it takes the message at a tool boundary.
  async queue(text, tag, guard, midturnText) {
    if (!this.queueAvailable || this.queued || this.submission.pending || !guard()) throw Object.assign(uiError("error.nativeWaitingInputUnavailable"), { notSent: true });
    const pending = this.queued = { tag, text, guard, midturnText, nativeId: this.record.nativeId, accepted: false, promptId: null, prompts: new Set(), replies: new Map() };
    try { return await this.deliver(pending, true); }
    finally { if (this.queued === pending) this.queued = null; }
  }
  async deliver(pending, queued = false) {
    const { text, tag, guard } = pending;
    try {
      const midturn = queued && this.nativeMidturnAppend === true;
      const receipt = await this.submission.request(text, tag, guard, queued, midturn, midturn ? pending.midturnText : undefined);
      pending.accepted = true;
      if (receipt?.mode === 'append') {
        // Stored in the running turn: no prompt of its own, so it heads no turn and binds no reply.
        (this.midturnRows ||= new Map()).set(tag, receipt.uuid);
        while (this.midturnRows.size > 16) this.midturnRows.delete(this.midturnRows.keys().next().value);
        this.emit('submitted', tag);
        return receipt;
      }
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
  stopForMaintenance(check) { check(); return this.stop(); }
  async stop() { this.cancelQueueRefresh(); this.cancelNativeAbort(); clearTimeout(this.closedAwaitingBackground); this.closedAwaitingBackground = null; await this.terminal.stop(); this.host.hookTargets.delete(this.token); return { state: 'ended' }; }
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
          const error = uiError("error.nativeRequestRejected", { arg1: message.error.code });
          error.nativeMissingHistory = message.error.code === -32600 && /^no rollout found for thread id /.test(message.error.message || '');
          if (error.nativeMissingHistory) error.nativeMissingHistoryThread = /^no rollout found for thread id ([^\s]+)$/.exec(message.error.message || '')?.[1];
          error.nativeUnsupportedTurns = message.error.code === -32601 && message.error.message === 'list_turns is not supported yet';
          error.nativeGoalsDisabled = message.error.code === -32600 && message.error.message === 'goals feature is disabled';
          if (message.error.code === -32600) error.nativeUnmaterializedThread =
            /^thread ([\da-f-]{36}) is not materialized yet; thread\/turns\/list is unavailable before first user message$/i.exec(message.error.message || '')?.[1];
          if (message.error.code === -32600 && /already has an active writer/.test(message.error.message || '')) {
            const display = uiError('error.nativeActiveWriter');
            error.message = display.message; error.uiMessage = display.uiMessage;
            error.nativeActiveWriter = true;
          }
          p.reject(error);
        } else p.resolve(message.result);
      }
    });
    ws.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(uiError("error.nativeDisconnectedNoReplay")); } this.pending.clear(); this.emit('closed'); });
    ws.on('error', () => {});
  }
  call(method, params) {
    if (this.ws.readyState !== undefined && this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(uiError("error.nativeDisconnectedNoReplay"));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(uiError("error.nativeRequestTimeout")); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  reply(id, result) {
    if (this.ws.readyState !== undefined && this.ws.readyState !== WebSocket.OPEN) throw uiError("error.nativeDisconnectedDecisionNotSent");
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
    if (!current()) throw uiError("error.backendChangedStartCancelled");
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
        result = await rpc.call('thread/resume', { threadId: this.record.nativeId, ...(!this.record.externalHistory ? { cwd: this.record.cwd } : {}), excludeTurns: true, ...codexResumeParams(this.record) });
        if (this.stopped) { this.finishRecoveryConnection?.(false); return; }
        if (!current()) throw uiError("error.backendChangedResumeCancelled");
        if (result.thread?.id !== this.record.nativeId) throw uiError("error.nativeResumeWrongIdentity");
        this.nativeSessionId = result.thread.sessionId; this.emit('workspaceMcpProof');
      } catch (error) {
        if (this.host.codexTargets.get(this.record.nativeId) === this) this.host.codexTargets.delete(this.record.nativeId);
        this.finishRecoveryConnection?.(false);
        throw error;
      }
      if (this.stopped) { this.finishRecoveryConnection?.(false); return; }
      this.hasHistory = true; this.addressedSendAvailable = this.record.addressedToolVersion === 1; this.finishRecoveryConnection?.(true);
      if (this.record.externalHistory && typeof result.thread.cwd === 'string' && path.isAbsolute(result.thread.cwd)) this.record.cwd = result.thread.cwd;
      this.emit('pid', this.host.codexProcess.pid); this.observeReplySettings(result, settings, rpc);
      if (revision === this.stateRevision) this.observeStatus(result.thread.status, rpc);
      // The TUI can display native history while the graphical copy is loading.
      if (this.record.view === 'terminal') await this.openTerminal();
      try {
        if (!await this.hydrateHistory(this.record.nativeId)) return;
        this.chatAvailable = true; this.emit('capability');
      } catch {
        if (!this.stopped) this.emit('activity', ...uiActivity("notice.activity.historySyncIncomplete"));
      }
      return;
    }
    if (this.record.view === 'terminal') {
      this.host.createCodex(() => this.startFromTerminal()).catch(error => { if (!this.stopped) { this.emit('activity', error.message, error.uiMessage); this.emit('state', 'error'); } });
      return;
    }
    await this.host.createCodex(async () => {
    if (!current()) throw uiError("error.backendChangedStartCancelled");
    // Native configuration/requirements choose permissions unless the person
    // chose to skip confirmations for this session when creating it.
    const settings = this.nativeSettings;
    const r = await rpc.call('thread/start', { cwd: this.record.cwd, ephemeral: false, experimentalRawEvents: false, dynamicTools: [require('./addressed-handoffs.cjs').codexTool],
      ...(this.record.operatorCreation?.permission === 'default' ? { approvalPolicy: 'on-request', sandbox: 'read-only' } : {}),
      ...(this.record.skipPermissions ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : {}), ...codexRequestedParams(this.record) });
    if (!current()) throw uiError("error.backendChangedStartResultIgnored");
    this.record.addressedToolVersion = 1; this.addressedSendAvailable = true;
    this.record.nativeId = r.thread.id; this.nativeSessionId = r.thread.sessionId; this.emit('workspaceMcpProof');
    this.host.codexTargets.set(this.record.nativeId, this);
    this.observeReplySettings(r, settings, rpc);
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
      const timeout = setTimeout(() => this.emit('activity', ...uiActivity("notice.activity.awaitingNativeLogin")), 120000);
      const cleanup = () => {
        clearTimeout(timeout);
        if (this.host.pendingCodex === started) this.host.pendingCodex = null;
        if (this.host.pendingCodexRuntime === this) this.host.pendingCodexRuntime = null;
        this.terminal?.off('closed', closed);
      };
      const closed = () => { cleanup(); reject(uiError("error.nativeInitializationExited")); };
      const started = (thread, model) => {
        cleanup();
        if (this.stopped || rpc !== this.host.rpc || child !== this.host.codexProcess) {
          reject(uiError("error.backendChangedStartResultIgnored")); return;
        }
        this.record.nativeId = thread.id; this.nativeSessionId = thread.sessionId; this.emit('workspaceMcpProof'); this.host.codexTargets.set(thread.id, this);
        this.observeModelProvider(thread.modelProvider);
        if (this.terminalNotificationSource) this.chatAvailable = true;
        this.emit('activity', ''); this.emit('model', model || thread.model || '原生未报告', model || thread.model ? undefined : uiNotice('notice.model.nativeUnreported').uiMessage); this.emit('state', 'idle'); resolve();
        if (!this.chatAvailable) this.observing = this.observeFirstTurn().catch(() => { if (!this.stopped) this.emit('activity', ...uiActivity("notice.activity.nativeConversationUnconfirmed")); });
      };
      this.host.pendingCodex = started;
      this.host.pendingCodexRuntime = this;
      this.initialTerminalThread = started;
      try {
        this.makeTerminal([this.host.codexBinary || this.host.binaries.codex, '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', '-c', 'notice.hide_rate_limit_model_nudge=true', ...(this.record.skipPermissions ? ['-a', 'never', '-s', 'danger-full-access'] : []), ...codexRequestedArgs(this.record), '--remote', `unix://${endpoint}`, '-C', this.record.cwd]).once('closed', closed);
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
      this.observeReplySettings(result, settings, rpc);
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
      if (!Array.isArray(result.data)) throw uiError("error.nativeHistoryUnknownFormat");
      for (const entry of result.data) {
        const item = entry.item || entry;
        if (!item || typeof item.id !== 'string' || !item.id) throw uiError("error.nativeHistoryMissingMessageId");
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
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw uiError("error.nativeHistoryPaginationUnconfirmed");
      cursors.add(cursor);
    }
    throw uiError("error.nativeHistoryReadLimit");
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
      this.emit('activity', ...uiActivity(this.backendExitConfirmed ? 'notice.activity.backendExited' : 'notice.activity.terminalExitedManaged'));
    });
    return this.terminal;
  }
  async terminalEndpoint() {
    // Native 0.166/0.167 use the same transparent terminal event stream. Observe it
    // from the first turn so native MCP provenance is not lost before a later
    // history attachment. This does not qualify unrelated history/steer APIs.
    if (!codexQualification.allows('terminalBridge', this.host.rpc?.nativeVersion)) return this.host.codexSocket;
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
  observeModelProvider(value) {
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) this.emit('modelProvider', value);
  }
  observeSettings(settings, sourceRpc = this.terminalNotificationSource ? this.terminalRpc : this.host?.rpc) {
    if (!settings || typeof settings.model !== 'string' || !settings.model) return;
    // Public effective settings only. Never copy developer instructions or the
    // wider settings object into the reader or room.
    const mode = settings.collaborationMode?.mode;
    this.nativeSettings = { nativeId: this.record.nativeId, model: settings.model,
      effort: typeof settings.effort === 'string' ? settings.effort : null,
      mode: ['plan', 'default'].includes(mode) ? mode : null };
    this.continuationSettingsSource = { value: this.nativeSettings, rpc: sourceRpc,
      lifecycle: this.lifecycleRevision, effortKnown: settings.effort === null || typeof settings.effort === 'string' && !!settings.effort };
    this.emit('model', settings.model); this.emit('capability');
  }
  observeReplySettings(result, previous, sourceRpc = this.terminalNotificationSource ? this.terminalRpc : this.host?.rpc) {
    if (typeof result?.thread?.id !== 'string' || !result.thread.id || result.thread.id !== this.record.nativeId) return;
    // The vendor Codex runs this thread's model with (openai, deepseek, ...): fixed for the thread.
    this.observeModelProvider(result.modelProvider || result.thread.modelProvider);
    if (this.nativeSettings !== previous) return;
    const model = result.model || result.thread.model;
    // A reply has effective model/effort, but no collaboration-mode report.
    // Keep a separately observed mode for this same native identity only.
    const mode = previous?.nativeId === this.record.nativeId ? previous.mode : null;
    this.observeSettings({ model, effort: result.reasoningEffort, collaborationMode: { mode } }, sourceRpc);
  }
  rememberQuestion(params) {
    if (typeof params.turnId !== 'string' || typeof params.itemId !== 'string' || !Array.isArray(params.questions)) return;
    const id = `notice:question:${params.turnId}:${params.itemId}`;
    const text = params.questions.map(q => [q.header, q.question,
      ...(q.options || []).map(option => [option.label, option.description].filter(v => typeof v === 'string').join(' — '))]
      .filter(v => typeof v === 'string' && v).join('\n')).join('\n\n');
    const question = { id, turnId: params.turnId, secret: params.questions.some(q => q.isSecret === true), questionIds: params.questions.map(q => q.id).filter(id => typeof id === 'string'), labels: params.questions.map(q => ({ id: q.id, text: q.header || q.question })) };
    this.emit('nativeBlock', { id, nativeId: this.record.nativeId, turnId: params.turnId, kind: 'notice', title: '原生问题', uiTitleMessage: uiNotice('notice.nativeQuestion.title').uiMessage, text, status: 'complete' });
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
        turnId: request.question.turnId, kind: 'notice', title: '原生终端提交的回答', uiTitleMessage: uiNotice('notice.nativeQuestion.terminalAnswer').uiMessage, text, status: 'submitted' });
      return;
    }
    if (event.kind === 'native') {
      if (this.terminalRpc === event.rpc && (this.terminalNotificationSource || event.message.id !== undefined || event.message.method === 'serverRequest/resolved')) this.event(event.message, event.rpc);
      return;
    }
    if (event.kind === 'disconnected') {
      if (this.terminalRpc !== event.rpc) return;
      const ownedNotifications = this.terminalNotificationSource;
      if (ownedNotifications) this.invalidateNativeGoal();
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
      if (this.turnId && !this.nativeTurnFinished) this.emit('nativeBlock', { id: `gap:source:${crypto.randomUUID()}`, nativeId: this.record.nativeId, turnId: this.turnId, kind: 'gap', status: 'complete', text: '原生显示连接已断开，正在核对图形连接；此间的临时变化可能未同步，原会话继续保留。', uiMessage: uiNotice('notice.observation.displayDisconnected').uiMessage });
      const rpc = this.host.rpc, id = this.record.nativeId, revision = this.lifecycleRevision, stateRevision = this.stateRevision, settings = this.nativeSettings;
      this.observing = rpc.call('thread/resume', { threadId: id, excludeTurns: true }).then(async result => {
        if (revision !== this.lifecycleRevision || this.stopped || this.transportDisconnected || this.host.rpc !== rpc || result.thread?.id !== id) return;
        this.nativeObservationPending = false;
        this.observeReplySettings(result, settings, rpc);
        if (stateRevision === this.stateRevision) this.observeStatus(result.thread.status, rpc);
        // Identity is confirmed even while history is still loading. Newer live
        // settings/state may have suppressed both other publication paths.
        this.emit('capability');
        if (await this.hydrateHistory(id, revision, true) && revision === this.lifecycleRevision && !this.stopped) { this.chatAvailable = true; this.emit('capability'); }
      }).catch(() => this.emit('activity', ...uiActivity("notice.activity.terminalExitedGuiUnconfirmed")));
      this.emit('capability'); return;
    }
    if (event.ephemeral) return; // Native title/Recap helpers are not the displayed root.
    if (event.kind === 'request') {
      this.invalidateNativeGoal();
      this.terminalSettingsRequest = { key: event.key, previous: this.nativeSettings };
      if (event.method === 'thread/resume' && event.threadId === this.record.nativeId && !this.terminalSwitch) return;
      if (!this.record.nativeId) return;
      this.pendingTerminalContext = null; this.terminalSwitch = event.key; this.chatAvailable = false;
      this.emit('contextEnd', { nativeId: this.record.nativeId, reason: 'terminal-switch' });
      this.emit('capability'); return;
    }
    if (event.kind === 'uncertain') {
      this.invalidateNativeGoal();
      this.chatAvailable = false;
      if (this.record.nativeId) this.emit('contextEnd', { nativeId: this.record.nativeId, reason: 'terminal-switch' });
      this.emit('capability'); return;
    }
    if (event.kind !== 'response') return;
    if (event.error) {
      if (this.terminalSwitch === event.key) this.emit('activity', ...uiActivity("notice.activity.nativeSwitchUnconfirmed"));
      return;
    }
    const thread = event.result?.thread;
    if (!thread || !/^[a-f0-9-]{36}$/i.test(thread.id || '') || thread.ephemeral || thread.parentThreadId) return;
    if (!this.record.nativeId) {
      this.terminalNotificationSource = true; this.terminalRpc = event.rpc;
      const settings = this.terminalSettingsRequest?.key === event.key ? this.terminalSettingsRequest.previous : this.nativeSettings;
      this.initialTerminalThread?.(thread, event.result.model); this.initialTerminalThread = null;
      this.observeReplySettings(event.result, settings, event.rpc); this.emit('capability'); return;
    }
    if (event.method === 'thread/resume' && thread.id === this.record.nativeId && !this.terminalSwitch) {
      this.terminalRpc = event.rpc;
      if (this.terminalSettingsRequest?.key === event.key) this.observeReplySettings(event.result, this.terminalSettingsRequest.previous, event.rpc);
      return;
    }
    if (this.terminalSwitch !== event.key) return;
    const existing = this.host.codexTargets.get(thread.id);
    if (existing && existing !== this) {
      this.emit('activity', ...uiActivity("notice.activity.switchedToListedSession")); return;
    }
    this.pendingTerminalContext = event;
    const previousId = this.record.nativeContextPending?.nativeId || this.record.nativeId;
    const info = { previousId, nativeId: thread.id, reason: 'terminal-switch', model: event.result.model || thread.model || '原生未报告', modelUiMessage: event.result.model || thread.model ? null : uiNotice('notice.model.nativeUnreported').uiMessage, cwd: thread.cwd };
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
    this.observeReplySettings(event.result, null, event.rpc);
    this.record.addressedToolVersion = null; this.addressedSendAvailable = false;
    this.hasHistory = Array.isArray(thread.turns) && thread.turns.length > 0;
    this.chatAvailable = false; this.observeStatus(thread.status, event.rpc);
    if (typeof thread.name === 'string') this.emit('nativeTitle', thread.name);
    const revision = this.lifecycleRevision;
    this.observing = (event.method === 'thread/start' && Array.isArray(thread.turns) && thread.turns.length === 0 ? Promise.resolve(true) : this.hydrateHistory(thread.id, revision, true)).then(ok => {
      if (ok && revision === this.lifecycleRevision && !this.stopped && !this.transportDisconnected) {
        this.hasHistory = this.record.messages.some(m => m.nativeId === thread.id && m.kind !== 'gap' && m.role !== 'system');
        this.chatAvailable = true; this.emit('capability');
      }
    }).catch(error => {
      if (revision !== this.lifecycleRevision || this.stopped || this.transportDisconnected) return;
      this.emit('activity', ...uiActivity("notice.activity.newContextGuiPending"));
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
    const activity = { nativeId: this.record.nativeId, turnId: this.turnId, startedAt: this.nativeStartedAt,
      label: this.nativeWait || (this.nativeRetry === this.turnId ? 'willRetry' : '') || labels[kind] || 'inProgress' };
    const binding = this.nativeToolBinding;
    let tool;
    if (this.latestState === 'working' && !this.nativeWait && this.nativeRetry !== this.turnId &&
        binding && binding.nativeId === this.record.nativeId && binding.turnId === this.turnId &&
        binding.lifecycle === this.lifecycleRevision && binding.rpc && this.currentRpc(binding.rpc)) {
      for (const [id, item] of binding.items) {
        if (item && !this.historyMessageItems.has(id) && this.activeNativeItems.get(id) === item.type &&
            (!tool || item.progressAt < tool.progressAt)) tool = item;
      }
    }
    return withObservedTool(this, activity, tool ? `${binding.lifecycle}:${this.turnId}:${tool.serial}` : null, tool?.progressAt);
  }
  publishNativeActivity() {
    const label = this.nativeActivity?.label || '';
    if (label !== this.publishedNativeActivity) { this.publishedNativeActivity = label; this.emit('activity', label); }
  }
  observeNativeItem(method, params, sourceRpc = this.host.rpc) {
    if (params.turnId !== this.turnId || !params.item?.id) return;
    this.stateRevision++; // A delayed resume status predates these native events.
    let binding = this.nativeToolBinding;
    if (typeof this.record.nativeId === 'string' && this.record.nativeId && params.threadId === this.record.nativeId && sourceRpc && this.currentRpc(sourceRpc) &&
        observedToolTypes.has(params.item.type) && !this.historyMessageItems.has(params.item.id)) {
      if (!binding || binding.nativeId !== this.record.nativeId || binding.turnId !== this.turnId ||
          binding.lifecycle !== this.lifecycleRevision || binding.rpc !== sourceRpc) {
        binding = this.nativeToolBinding = { nativeId: this.record.nativeId, turnId: this.turnId,
          lifecycle: this.lifecycleRevision, rpc: sourceRpc, items: new Map() };
      }
    } else binding = null;
    if (method === 'item/started') {
      if (this.activeNativeItems.size < 200) this.activeNativeItems.set(params.item.id, params.item.type);
      if (binding && params.item.status === 'inProgress' && !binding.items.has(params.item.id) && binding.items.size < 4096 &&
          this.activeNativeItems.get(params.item.id) === params.item.type) {
        const serial = this.nativeToolPhaseSerial = (this.nativeToolPhaseSerial || 0) + 1;
        binding.items.set(params.item.id, { type: params.item.type, progressAt: Date.now(), serial });
      }
      if (binding?.items.get(params.item.id) && params.item.status === 'inProgress' && params.item.type === 'mcpToolCall' && params.item.server === 'native_workspace' && params.item.tool === 'workspace_message') {
        this.workspaceMcpCalls ||= new Map();
        if (!this.workspaceMcpCalls.has(params.item.id) && this.workspaceMcpCalls.size < 64) this.workspaceMcpCalls.set(params.item.id, {
          nativeId: this.record.nativeId, turnId: params.turnId, lifecycle: this.lifecycleRevision, rpc: sourceRpc, arguments: params.item.arguments,
        });
        this.emit('workspaceMcpProof');
      }
    } else {
      if (binding) {
        // Keep a bounded tombstone: a late duplicate start is not new work.
        if (binding.items.has(params.item.id) || binding.items.size < 4096) binding.items.set(params.item.id, null);
      }
      this.activeNativeItems.delete(params.item.id); this.workspaceMcpCalls?.delete(params.item.id);
    }
    this.publishNativeActivity();
  }
  invalidateNativeGoal() {
    if (!this.nativeGoalObservation?.valid) return;
    this.nativeGoalObservation.valid = false; this.emit('nativeGoal');
  }
  observeNativeGoal(params, sourceRpc, cleared = false) {
    const source = this.terminalNotificationSource ? this.terminalRpc : this.host.rpc;
    // A resume snapshot may precede its Promise continuation. Retain the bound
    // notification; nativeGoalSnapshot still waits for observation confirmation.
    if (!sourceRpc || sourceRpc !== source || !this.currentRpc(sourceRpc) || this.stopped ||
        this.transportDisconnected || this.record.nativeContextPending) return;
    const nativeId = this.record.nativeId;
    if (params.threadId && params.threadId !== nativeId) return;
    const status = cleared ? null : params.goal?.status;
    if (typeof nativeId !== 'string' || !nativeId || params.threadId !== nativeId ||
        !cleared && (params.goal?.threadId !== nativeId || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(status))) {
      this.invalidateNativeGoal();
      return;
    }
    const previous = this.nativeGoalObservation;
    if (previous?.valid && previous.nativeId === nativeId && previous.status === status &&
        previous.sourceRpc === sourceRpc && previous.lifecycleRevision === this.lifecycleRevision) {
      previous.observedAt = Date.now(); return;
    }
    // Keep only display facts. Goal text, budget, counters and controls stay native.
    this.nativeGoalObservation = { nativeId, status, observedAt: Date.now(), sourceRpc,
      lifecycleRevision: this.lifecycleRevision, valid: true };
    this.emit('nativeGoal');
  }
  nativeGoalSnapshot() {
    const goal = this.nativeGoalObservation;
    if (!goal) return null; // Silence, including Goals off, makes no goal claim.
    const source = this.terminalNotificationSource ? this.terminalRpc : this.host.rpc;
    const current = goal.valid && goal.nativeId === this.record.nativeId && goal.sourceRpc === source &&
      goal.lifecycleRevision === this.lifecycleRevision && source && this.currentRpc(source) &&
      (!this.terminalNotificationSource || source.connected === true) && !this.stopped && !this.closed &&
      !this.transportDisconnected && !this.nativeObservationPending && !this.record.nativeContextPending;
    if (!current) return goal.status === null ? null : { nativeId: this.record.nativeId, known: false };
    return { nativeId: goal.nativeId, status: goal.status, observedAt: goal.observedAt };
  }
  // Private policy observation, not a display row or authority to resume. It
  // reads one existing thread's goal; no start/resume/set or history request.
  async goalContinuationObserve() {
    const nativeId = this.record.nativeId, rpc = this.terminalNotificationSource ? this.terminalRpc : this.host.rpc;
    const settings = this.nativeSettings, settingsSource = this.continuationSettingsSource, statusSource = this.continuationStatusSource;
    const lifecycle = this.lifecycleRevision, stateRevision = this.stateRevision, events = this.eventRevision;
    const controlRevision = this.record.controlRevision ?? 0, state = this.latestState, turnId = this.turnId;
    const unknown = reason => ({ known: false, nativeId, reason });
    const current = () => rpc && settingsSource && statusSource && typeof rpc.call === 'function' && this.currentRpc(rpc) &&
      rpc === (this.terminalNotificationSource ? this.terminalRpc : this.host.rpc) &&
      !this.stopped && !this.closed && !this.backendExitConfirmed && !this.transportDisconnected &&
      !this.terminalSwitch && !this.pendingTerminalContext &&
      !this.nativeObservationPending && !this.record.nativeContextPending && this.record.nativeId === nativeId &&
      this.lifecycleRevision === lifecycle && this.stateRevision === stateRevision && this.eventRevision === events && this.turnId === turnId &&
      (this.record.controlRevision ?? 0) === controlRevision && this.nativeSettings === settings &&
      this.continuationSettingsSource === settingsSource && settingsSource?.value === settings && settingsSource.rpc === rpc &&
      settingsSource.lifecycle === lifecycle && settingsSource.effortKnown && settings?.nativeId === nativeId &&
      this.continuationStatusSource === statusSource && statusSource?.rpc === rpc && statusSource.lifecycle === lifecycle &&
      statusSource.nativeId === nativeId && statusSource.state === state;
    if (typeof nativeId !== 'string' || !nativeId || !Number.isSafeInteger(controlRevision) || controlRevision < 0 ||
        !['idle', 'working', 'approval'].includes(state) || !current()) return unknown('native-observation-unavailable');
    let response;
    try { response = await rpc.call('thread/goal/get', { threadId: nativeId }); }
    catch { return unknown('native-goal-read-unavailable'); }
    if (!current()) return unknown('native-observation-changed');
    const goal = response?.goal, whole = value => Number.isSafeInteger(value) && value >= 0;
    const label = value => typeof value === 'string' && !!value && value.length <= 512;
    if (!goal || Array.isArray(goal) || goal.threadId !== nativeId ||
      !['active', 'blocked', 'paused', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status) ||
      typeof goal.objective !== 'string' || !goal.objective.trim() || !whole(goal.createdAt) || !whole(goal.updatedAt) || goal.updatedAt < goal.createdAt ||
      !Object.hasOwn(goal, 'tokenBudget') || !(goal.tokenBudget === null || Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0) ||
      !whole(goal.tokensUsed) || !whole(goal.timeUsedSeconds) ||
      Object.hasOwn(goal, 'id') && !(goal.id === null || label(goal.id)) ||
      Object.hasOwn(goal, 'timeBudgetSeconds') && !(goal.timeBudgetSeconds === null || Number.isFinite(goal.timeBudgetSeconds) && goal.timeBudgetSeconds > 0) ||
      !label(settings.model) || !(settings.effort === null || label(settings.effort))) return unknown('native-goal-shape-unproven');
    const projected = { threadId: goal.threadId, objective: goal.objective, status: goal.status, createdAt: goal.createdAt, updatedAt: goal.updatedAt,
      tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds };
    for (const key of ['id', 'timeBudgetSeconds']) if (Object.hasOwn(goal, key)) projected[key] = goal[key];
    return { known: true, nativeId, state, controlRevision,
      settings: { model: settings.model, effort: settings.effort }, goal: projected,
      approvalPending: this.nativeRequests.size > 0 || this.nativeWait === 'waitingOnApproval' || state === 'approval',
      inputPending: Boolean(this.pending || this.pendingQueue || this.pendingSteer || this.steering),
      waitingOnUser: this.nativeWait === 'waitingOnUserInput' || this.nativeInputRequired === true,
      usageLimited: goal.status === 'usageLimited', budgetLimited: goal.status === 'budgetLimited' ||
        goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget ||
        goal.timeBudgetSeconds != null && goal.timeUsedSeconds >= goal.timeBudgetSeconds };
  }
  observeStatus(status, sourceRpc = this.terminalNotificationSource ? this.terminalRpc : this.host?.rpc) {
    this.nativeWait = status?.activeFlags?.includes('waitingOnUserInput') ? 'waitingOnUserInput' : status?.activeFlags?.includes('waitingOnApproval') ? 'waitingOnApproval' : null;
    const state = status?.type === 'idle' ? 'idle' : status?.type === 'active' && Array.isArray(status.activeFlags) &&
      status.activeFlags.every(flag => ['waitingOnUserInput', 'waitingOnApproval'].includes(flag))
      ? this.nativeWait ? 'approval' : 'working' : null;
    this.continuationStatusSource = state ? { rpc: sourceRpc,
      lifecycle: this.lifecycleRevision, nativeId: this.record.nativeId, state } : null;
    if (status?.type === 'idle') this.emit('state', 'idle');
    else if (status?.type === 'active') this.emit('state', status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'approval' : 'working');
    else if (status?.type === 'systemError') this.emit('state', 'error');
    else { this.emit('state', 'starting'); this.emit('activity', ...uiActivity("notice.activity.nativeStateUnconfirmed")); return; }
    this.publishNativeActivity();
  }
  forgetNativeRequests() {
    for (const request of this.nativeRequests.values()) this.emit('progress', { id: request.id, source: 'codex-native', status: 'unknown', title: '原生确认结果未确认', uiTitleMessage: uiNotice('notice.nativeConfirm.unconfirmed').uiMessage });
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
    if (['item/started', 'item/completed'].includes(message.method) && typeof p.turnId === 'string' && p.turnId &&
        p.item?.type === 'mcpToolCall' && p.item.server === 'native_workspace' && p.item.tool === 'workspace_control' &&
        typeof p.item.id === 'string' && p.item.id && !this.stopped) {
      this.backgroundMcpCalls ||= new Map();
      if (message.method === 'item/started' && p.item.status === 'inProgress' && !this.backgroundMcpCalls.has(p.item.id) && this.backgroundMcpCalls.size < 256) {
        this.backgroundMcpCalls.set(p.item.id, { turnId: p.turnId, rpc: sourceRpc,
          lifecycle: this.lifecycleRevision, arguments: structuredClone(p.item.arguments) });
        this.emit('backgroundMcpProof');
      } else if (message.method === 'item/completed' && (this.backgroundMcpCalls.has(p.item.id)
          ? this.backgroundMcpCalls.get(p.item.id)?.turnId === p.turnId : this.backgroundMcpCalls.size < 256)) this.backgroundMcpCalls.set(p.item.id, null);
    }
    // A retained reader can attach after turn/started. Keep only this live
    // outbox candidate; its caller must separately verify unknown turn identity
    // using content-free native metadata. Never adopt UI turn state from it.
    if (['item/started', 'item/completed'].includes(message.method) && typeof p.turnId === 'string' && p.turnId &&
        p.item?.type === 'mcpToolCall' && p.item.server === 'native_outbox' && p.item.tool === 'workspace_outbox' &&
        typeof p.item.id === 'string' && p.item.id && !this.stopped) {
      this.outboxMcpCalls ||= new Map();
      if (message.method === 'item/started' && p.item.status === 'inProgress' && !this.outboxMcpCalls.has(p.item.id) && this.outboxMcpCalls.size < 64) {
        this.outboxMcpCalls.set(p.item.id, { turnId: p.turnId, rpc: sourceRpc,
          lifecycle: this.lifecycleRevision, arguments: structuredClone(p.item.arguments) });
        this.emit('outboxMcpProof');
      } else if (message.method === 'item/completed' && (this.outboxMcpCalls.has(p.item.id)
          ? this.outboxMcpCalls.get(p.item.id)?.turnId === p.turnId : this.outboxMcpCalls.size < 64)) {
        this.outboxMcpCalls.set(p.item.id, null); // A delayed start is not a new call.
      }
    }
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
    if (['item/started', 'item/completed'].includes(message.method)) this.observeNativeItem(message.method, p, sourceRpc);
    if (message.method === 'item/completed' && p.item?.type === 'userMessage' &&
      p.turnId && this.ownInputs.has(p.item.clientId)) {
      this.nativeAcceptedInput = { turnId: p.turnId, tag: p.item.clientId, rpc: sourceRpc, lifecycle: this.lifecycleRevision };
      this.emit('nativeAcceptedInput');
    }
    if (p.item?.type === 'commandExecution' &&
        (message.method === 'item/started' ||
          message.method === 'item/completed' && ['completed', 'failed'].includes(p.item.status) && Number.isSafeInteger(p.item.exitCode))) {
      this.emit('scopedOutboxCommand', { id: p.item.id, turnId: p.turnId, inputTag, source: 'codex-native', kind: 'commandExecution',
        ...(typeof p.item.command === 'string' && p.item.command && p.item.command.length <= 4096 ? { input: p.item.command } : {}),
        status: message.method === 'item/started' ? 'inProgress' : p.item.status,
        ...(message.method === 'item/completed' ? { exitCode: p.item.exitCode } : {}),
        rpc: sourceRpc, lifecycle: this.lifecycleRevision });
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
    const progressType = { 'item/commandExecution/outputDelta': 'commandExecution', 'item/mcpToolCall/progress': 'mcpToolCall', 'item/fileChange/patchUpdated': 'fileChange' }[message.method];
    const hasProgress = progressType === 'fileChange' ? Array.isArray(p.changes) && p.changes.length > 0 :
      progressType === 'mcpToolCall' ? typeof p.message === 'string' && p.message.length > 0 : typeof p.delta === 'string' && p.delta.length > 0;
    const binding = this.nativeToolBinding;
    const tool = binding?.items.get(p.itemId);
    if (progressType && hasProgress && p.threadId === this.record.nativeId && p.turnId === this.turnId &&
        binding && binding.nativeId === this.record.nativeId && binding.turnId === this.turnId && binding.lifecycle === this.lifecycleRevision &&
        binding.rpc === sourceRpc && tool?.type === progressType &&
        this.activeNativeItems.get(p.itemId) === progressType && !this.historyMessageItems.has(p.itemId)) tool.progressAt = Date.now();
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
    if (message.method === 'error') this.emit('progress', { source: 'codex-native', kind: message.method, title: '原生会话错误', uiTitleMessage: uiNotice('notice.nativeConfirm.sessionError').uiMessage, status: 'failed' });
    if (message.id !== undefined && message.method === 'item/tool/call' && p.tool === require('./addressed-handoffs.cjs').TOOL && p.namespace === require('./addressed-handoffs.cjs').NAMESPACE) {
      // Only the connected native root supplies identity. Never take a sender
      // ID from model arguments or treat another dynamic tool as ours.
      let result, success = false;
      try {
        if (!this.addressedSendAvailable || this.transportDisconnected || p.threadId !== this.record.nativeId || p.turnId !== this.turnId || !this.addressedCall) throw uiError("error.nativeDirectedUnsupported");
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
    // Other dynamic tools belong to the native client (for example codex_tui).
    // They are callbacks, not permission requests. The transparent terminal
    // bridge forwards them and the native client's reply without our decision.
    if (message.id !== undefined && message.method === 'item/tool/call') return;
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
          this.emit('progress', { id: request.id, source: 'codex-native', status: 'unknown', title: '原生确认需要核对', uiTitleMessage: uiNotice('notice.nativeConfirm.check').uiMessage });
          this.emit('approval', { requestId: message.id, method: 'native/requestAmbiguous', params: { reason: '原生确认标识重复且内容变化；请在原生终端核对。', reasonUiMessage: uiNotice('notice.nativeConfirm.ambiguous').uiMessage } }, sourceRpc);
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
      this.emit('progress', { id: request.id, source: 'codex-native', kind: message.method, title: nonBlocking ? '原生问题（此问题不阻塞本轮）' : '等待原生确认', uiTitleMessage: uiNotice(nonBlocking ? 'notice.nativeConfirm.nonBlocking' : 'notice.nativeConfirm.waiting').uiMessage, status: 'waiting' });
      this.emit('approval', { requestId: message.id, method: message.method, params: p }, sourceRpc); if (!nonBlocking) this.emit('state', 'approval'); this.publishNativeActivity(); return;
    }
    switch (message.method) {
      case 'thread/settings/updated': this.observeSettings(p.threadSettings, sourceRpc); break;
      case 'thread/goal/updated': if (message.id === undefined) this.observeNativeGoal(p, sourceRpc); break;
      case 'thread/goal/cleared': if (message.id === undefined) this.observeNativeGoal(p, sourceRpc, true); break;
      case 'serverRequest/resolved': {
        const key = this.nativeRequestKey(p.requestId, sourceRpc), request = this.nativeRequests.get(key);
        if (!request || request.rpc !== sourceRpc) break;
        this.nativeRequests.delete(key);
        if (request.question) this.emit('nativeBlock', { id: request.question.id, nativeId: this.record.nativeId,
          turnId: request.question.turnId, kind: 'notice', title: '原生问题 · 已处理', uiTitleMessage: uiNotice('notice.nativeQuestion.resolved').uiMessage, status: 'complete' });
        if (sourceRpc !== this.host.rpc) this.terminalRequestKeys?.delete(p.requestId);
        this.emit('progress', { id: request.id, source: 'codex-native', status: 'resolved', title: '原生确认已处理', uiTitleMessage: uiNotice('notice.nativeConfirm.resolved').uiMessage });
        this.emit('approvalResolved', p.requestId, sourceRpc);
        break;
      }
      case 'thread/status/changed': this.observeStatus(p.status, sourceRpc); break;
      // A native rename, or the TUI naming an unnamed thread with its generated title.
      case 'thread/name/updated': if (p.threadId === this.record.nativeId && typeof p.threadName === 'string') this.emit('nativeTitle', p.threadName); break;
      case 'turn/started':
        this.workspaceMcpCalls?.clear();
        this.outboxMcpCalls?.clear();
        this.backgroundMcpCalls?.clear();
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
          this.emit('fleet', { event: item.type, id: item.id, name: item.agentPath || 'Codex 原生子 agent', nameUiMessage: item.agentPath ? null : uiNotice('notice.fleet.codexNativeChild').uiMessage, kind: item.kind, tool: item.tool,
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
          const pending = this.pending;
          if (pending?.spaceImages && pending.imageRpc === sourceRpc && this.spaceImageCurrent(pending)) {
            pending.spaceImages.observe(p);
            const receipt = pending.spaceImages.confirm(pending.turnId);
            if (receipt) this.emit('spaceImagesAccepted', receipt);
          }
          const images = require('./native-images.cjs').userImageReferences(p.item.content);
          if (images.length) this.emit('nativeInputImages', { id: p.item.id, nativeId: this.record.nativeId,
            clientId: this.ownInputs.has(p.item.clientId) ? p.item.clientId : undefined,
            cwd: this.nativeSettings?.cwd || this.record.cwd, images });
        }
        break;
      case 'thread/tokenUsage/updated': this.emit('usage', p.tokenUsage ? { ...p.tokenUsage, threadId: p.threadId, turnId: p.turnId, reportedAt: Date.now() } : null); break;
      case 'turn/completed': {
        if (p.threadId !== this.record.nativeId) break;
        for (const [id, call] of this.outboxMcpCalls || []) if (call?.turnId === p.turn.id) this.outboxMcpCalls.set(id, null);
        for (const [id, call] of this.backgroundMcpCalls || []) if (call?.turnId === p.turn.id) this.backgroundMcpCalls.set(id, null);
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
          else { const notice = uiNotice("notice.failure.nativeError"); this.emit('failed', notice.text, undefined, notice.uiMessage); }
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
    if (turn.completed.status !== 'completed') { const notice = uiNotice("notice.failure.nativeTurnFailed"); this.emit('failed', notice.text, { tag: pending?.tag, supersededTag: pending?.supersededTag }, notice.uiMessage); }
    else this.emit('complete', { tag: pending?.tag, supersededTag: pending?.supersededTag, messageId: turn.messageId, inputTag: turn.itemInputs.get(turn.messageId) || '', text: turn.text, background: null, scheduled: null, fleetPending: null, stopHookActive: null });
    if (live) this.emit('nativeTurnEnd', { nativeId: this.record.nativeId, turnId: id, status: turn.completed.status, errorInfo: turn.completed.error?.codexErrorInfo, errorMessage: turn.completed.error?.message });
  }
  get steerAvailable() { return codexQualification.allows('steer', this.host.rpc?.nativeVersion) && this.chatAvailable && !this.stopped && !this.transportDisconnected; }
  async steer(text, tag, expectedTurnId, guard, shared = false, acceptedGuard = guard) {
    if (!this.steerAvailable || !expectedTurnId || this.turnId !== expectedTurnId || this.nativeRequests.size || this.steering || !guard()) throw uiError("error.nativeTurnChangedSteerNotSent");
    this.ownInputs.add(tag);
    const operation = this.steering = { tag, turnId: expectedTurnId, inputSeen: false };
    const previous = this.pending, lifecycle = this.lifecycleRevision;
    try {
      // Native expectedTurnId is the atomic precondition. No new-turn fallback.
      const receipt = await this.host.rpc.call('turn/steer', { threadId: this.record.nativeId, expectedTurnId, clientUserMessageId: tag, input: [{ type: 'text', text, text_elements: [] }] });
      if (receipt?.turnId !== expectedTurnId) throw uiError("error.nativeSteerUnconfirmed");
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
  get spaceImagesAvailable() { return codexQualification.allows('spaceImages', this.host.rpc?.nativeVersion) && this.host.rpc?.ws?.readyState === WebSocket.OPEN && this.chatAvailable && !this.stopped && !this.transportDisconnected; }
  scopedOutboxRpc() {
    const rpc = this.terminalNotificationSource ? this.terminalRpc : this.host.rpc;
    if (this.stopped || this.transportDisconnected || this.record.nativeContextPending || !this.currentRpc(rpc) ||
        typeof rpc?.call !== 'function' || this.terminalNotificationSource && !rpc.connected ||
        !this.terminalNotificationSource && (this.needsSubscription || !this.chatAvailable)) return null;
    return rpc;
  }
  async sendScopedOutbox(text, tag, guard, rpc) {
    if (!rpc || this.scopedOutboxRpc() !== rpc || this.pending || !guard()) throw uiError('error.nativeSendUnavailable');
    const pending = this.pending = { tag, turnId: null }; this.ownInputs.add(tag);
    const lifecycle = this.lifecycleRevision, revision = this.stateRevision;
    try {
      const result = await rpc.call('turn/start', { threadId: this.record.nativeId, clientUserMessageId: tag,
        input: [{ type: 'text', text, text_elements: [] }] });
      if (lifecycle !== this.lifecycleRevision || this.stopped || this.scopedOutboxRpc() !== rpc) throw uiError('error.nativeObservationChanged');
      if (typeof result.turn?.id !== 'string' || !result.turn.id) throw uiError('error.nativeObservationChanged');
      pending.turnId = result.turn.id;
      if (!this.turnId) this.turnId = result.turn.id;
      if (revision === this.stateRevision) this.emit('state', 'working');
      this.emit('submitted', tag); this.emit('replyBound', { tag, nativeId: this.record.nativeId, turnId: pending.turnId });
      for (const id of this.turns.keys()) this.finishTurn(id);
      return pending.turnId;
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      if (lifecycle === this.lifecycleRevision) for (const id of this.turns.keys()) this.finishTurn(id);
      throw error;
    }
    // Deliberately no observeAcceptedTurn/resume or new connection fallback.
  }
  spaceImageCurrent(pending) { return this.pending === pending && pending.imageRpc === this.host.rpc && pending.imageLifecycle === this.lifecycleRevision && pending.spaceImages.nativeId === this.record.nativeId && !this.stopped && !this.transportDisconnected; }
  async send(text, tag, guard, spaceImages) {
    if (!this.chatAvailable || this.pending || !guard()) throw uiError("error.nativeSendUnavailable");
    const { SpaceImageSubmission } = require('./space-images.cjs');
    if (spaceImages && (!(spaceImages instanceof SpaceImageSubmission) || !this.spaceImagesAvailable || spaceImages.nativeId !== this.record.nativeId || spaceImages.tag !== tag)) throw uiError('error.roomImages.deliveryUnavailable');
    const input = spaceImages ? spaceImages.input(text) : [{ type: 'text', text, text_elements: [] }];
    const pending = this.pending = { tag, turnId: null, ...(spaceImages ? { spaceImages, imageRpc: this.host.rpc, imageLifecycle: this.lifecycleRevision } : {}) }; this.ownInputs.add(tag);
    const lifecycle = this.lifecycleRevision, revision = this.stateRevision;
    try {
      const r = await this.host.rpc.call('turn/start', { threadId: this.record.nativeId, clientUserMessageId: tag, input });
      if (lifecycle !== this.lifecycleRevision || this.stopped) { this.emit('submitted', tag); return; }
      pending.turnId = r.turn.id;
      if (spaceImages && this.spaceImageCurrent(pending)) {
        const receipt = spaceImages.confirm(pending.turnId);
        if (receipt) this.emit('spaceImagesAccepted', receipt);
      }
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
          { const notice = uiNotice("notice.failure.acceptedStateUnsynced"); this.emit('failed', notice.text, undefined, notice.uiMessage); }
        }
      }
    }
    return pending.turnId;
  }
  async observeAcceptedTurn(turnId, inputTag) {
    if (this.stopped || !turnId) throw uiError("error.nativeObservationChanged");
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
    if (this.stopped || lifecycle !== this.lifecycleRevision || result.thread?.id !== this.record.nativeId) throw uiError("error.nativeObservationChanged");
    this.observeReplySettings(result, settings, rpc);
    this.needsSubscription = false; this.hasHistory = true;
    if (revision === this.stateRevision && this.latestState !== 'approval') this.observeStatus(result.thread.status, rpc);
    const page = await this.host.rpc.call('thread/turns/list', { threadId: this.record.nativeId, limit: 20, itemsView: 'full' });
    if (this.stopped || lifecycle !== this.lifecycleRevision) throw uiError("error.nativeObservationChanged");
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
    this.emit('activity', ...uiActivity("notice.activity.backendExited"));
    this.emit('state', 'error');
    this.retiringTerminal = Promise.resolve().then(async () => {
      // This is only the remote display client owned by this runtime. Never
      // signal native workers, descendants or another server during recovery.
      if (this.terminal) await this.terminal.stop();
      this.emit('state', this.record.nativeId ? 'recoverable' : 'ended');
      return { state: this.record.nativeId ? 'recoverable' : 'ended' };
    }).catch(error => {
      this.emit('activity', ...uiActivity("notice.activity.backendExitedTerminalUnconfirmed"));
      throw error;
    }).finally(() => { this.retiringTerminal = null; });
    return this.retiringTerminal;
  }
  async interrupt() {
    if (!this.turnId) throw uiError("error.nativeTurnUnconfirmedInterrupt");
    await this.host.rpc.call('turn/interrupt', { threadId: this.record.nativeId, turnId: this.turnId });
  }
  async openTerminal(guard = () => true) {
    if (!guard()) throw uiError("error.terminalOwnerChanged");
    if (this.recoveryReady && !this.hasHistory && !await this.recoveryReady) throw uiError("error.nativeResumeUnconfirmed");
    if (this.stopped) throw uiError("error.sessionDetachedHistoryRetained");
    if (this.terminal?.alive) return this.terminal;
    if (this.backendExitConfirmed || this.transportDisconnected) throw uiError("error.nativeDisconnectedResumeFirst");
    if (this.terminal && !this.terminal.nativeExited) throw uiError("error.previousTerminalExitUnconfirmed");
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
            if (!Array.isArray(page?.data) || page.data.length > 1) throw uiError("error.nativeHistoryUnconfirmedReopen");
            thread = { ...thread, turns: page.data };
          }
        }
      } catch (error) { if (!error.nativeMissingHistory || error.nativeMissingHistoryThread !== id) throw error; missingHistory = true; }
      if (this.stopped || this.transportDisconnected || this.host.rpc !== rpc || this.lifecycleRevision !== revision || this.record.nativeId !== id) throw uiError("error.nativeConnectionChangedReopen");
      if (missingHistory || thread?.id === id && Array.isArray(thread.turns) && !thread.turns.length) throw uiError("error.firstMessageBeforeTerminal");
      if (thread?.id !== id || !Array.isArray(thread.turns) || !thread.turns.every(turn => typeof turn?.id === 'string' && turn.id.trim())) throw uiError("error.nativeHistoryUnconfirmedReopen");
      this.hasHistory = true;
    }
    // Another attachment can finish while the initial rollout read is pending.
    if (!guard()) throw uiError("error.terminalOwnerChanged");
    if (this.terminal?.alive) return this.terminal;
    const endpoint = await this.terminalEndpoint();
    if (!guard() || this.stopped || this.transportDisconnected) throw uiError("error.terminalOwnerChanged");
    if (this.terminal?.alive) return this.terminal;
    return this.makeTerminal([this.host.codexBinary || this.host.binaries.codex, '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', '-c', 'notice.hide_rate_limit_model_nudge=true', 'resume', '--remote', `unix://${endpoint}`, '-C', this.record.cwd, this.record.nativeId]);
  }
  async reconnect() {
    const transportOnly = Boolean(this.transportDisconnected);
    if ((!this.stopped && !transportOnly) || this.closed || !this.record.nativeId) throw uiError("error.nativeConnectionStateChanged");
    const lifecycle = ++this.lifecycleRevision;
    let rpc, child;
    const current = () => lifecycle === this.lifecycleRevision && !this.stopped &&
      (!rpc || (this.host.rpc === rpc && this.host.codexProcess === child));
    // Re-subscribe to the owned thread. Omit every configuration override except a profile's
    // model catalog (codexResumeParams): thread/resume is not a new thread or a turn/start request.
    this.chatAvailable = false; this.stopped = false;
    this.pending = null; this.turnId = null; this.turns.clear();
    this.liveMessageItems.clear(); this.liveToolItems.clear(); this.liveTextItems.clear(); this.nativeTextParts.clear();
    this.rememberHistoryWatermarks();
    this.host.codexTargets.set(this.record.nativeId, this);
    const revision = this.stateRevision;
    try {
      if (transportOnly) await this.host.reconnectCodex();
      if (!current()) throw uiError("error.nativeConnectionChangedNoReplay");
      rpc = this.host.rpc; child = this.host.codexProcess;
      this.transportDisconnected = false;
      const settings = this.nativeSettings;
      let result;
      try { result = await rpc.call('thread/resume', { threadId: this.record.nativeId, excludeTurns: true, ...codexResumeParams(this.record) }); }
      catch (error) {
        if (!error.nativeMissingHistory || this.hasHistory || this.record.messages?.length || !current()) throw error;
        // Native creates its rollout on the first actual input. Confirm the
        // owned empty thread is still live; no synthetic turn to make history.
        const { thread } = await rpc.call('thread/read', { threadId: this.record.nativeId, includeTurns: false });
        if (!current() || thread?.id !== this.record.nativeId || thread.preview || thread.status?.type !== 'idle') throw error;
        this.needsSubscription = true; this.chatAvailable = true;
        if (revision === this.stateRevision) this.observeStatus(thread.status, rpc);
        this.emit('capability');
        return;
      }
      if (result.thread?.id !== this.record.nativeId) throw uiError("error.nativeResumeWrongIdentity");
      if (!current()) throw uiError("error.nativeConnectionClosedNoReplay");
      this.hasHistory = true; this.needsSubscription = false;
      this.emit('pid', this.terminal?.alive && this.terminal.pid ? this.terminal.pid : this.host.codexProcess.pid);
      this.observeReplySettings(result, settings, rpc);
      if (revision === this.stateRevision) this.observeStatus(result.thread.status, rpc);
      if (!await this.hydrateHistory(this.record.nativeId, lifecycle) || !current()) throw uiError("error.historySyncDisconnected");
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
      catch { this.emit('activity', ...uiActivity("notice.activity.connectedTerminalOpenFailed")); }
    }
  }
  transportClosed() {
    if (this.closed || this.backendExitConfirmed) return;
    this.forgetNativeRequests();
    this.transportDisconnected = true; this.chatAvailable = false; this.lifecycleRevision++;
    this.finishRecoveryConnection?.(false);
    this.emit('activity', ...uiActivity("notice.activity.guiDisconnected"));
    this.emit('state', this.stopped ? 'disconnected' : 'error');
  }
  async stopForMaintenance(check) {
    const lifecycle = this.lifecycleRevision, state = this.stateRevision, observing = this.observing;
    await observing;
    if (this.lifecycleRevision !== lifecycle || this.stateRevision !== state || this.observing !== observing || this.stopped || this.backendExitConfirmed || this.transportDisconnected ||
        this.turnId || this.pendingQueue || this.pendingSteer || this.nativeInputRequired || this.nativeAbortRequest) throw uiError('error.backendSwitchSessionChanged', { name: this.record.name || this.record.id });
    check();
    return this.stop({ maintenance: true });
  }
  async stop({ maintenance = false } = {}) {
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
      if (!maintenance) {
        await this.observing;
        if (this.turnId) await this.interrupt();
      }
      await this.terminal?.stop();
      const result = await this.host.rpc.call('thread/unsubscribe', { threadId: this.record.nativeId });
      if (!['notLoaded', 'notSubscribed', 'unsubscribed'].includes(result.status)) throw uiError("error.unknownNativeDisconnectState");
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
function currentWorkspaceMcpProof(runtime, identity, args, socket, call) {
  return Boolean(call && !runtime.stopped && !runtime.transportDisconnected && !socket.destroyed &&
    runtime.host.codexTargets.get(identity.nativeId) === runtime && runtime.record.nativeId === identity.nativeId &&
    identity.sessionId === runtime.nativeSessionId && identity.turnId === runtime.turnId &&
    call.nativeId === identity.nativeId && call.turnId === identity.turnId && call.lifecycle === runtime.lifecycleRevision &&
    runtime.currentRpc(call.rpc) && runtime.workspaceMcpCalls?.get(identity.callId) === call &&
    call.arguments?.recipient_id === args?.recipient_id && call.arguments?.message === args?.message);
}
async function workspaceMcpProof(runtime, identity, args, socket) {
  const check = () => {
    if (runtime.stopped || runtime.transportDisconnected || socket.destroyed) throw uiError("error.nativeConnectionChangedNoAutoMessage");
    const call = runtime.workspaceMcpCalls?.get(identity.callId);
    if (!call || !runtime.nativeSessionId) return false;
    if (!currentWorkspaceMcpProof(runtime, identity, args, socket, call)) throw uiError("error.nativeToolOriginUnconfirmed");
    return call;
  };
  const ready = check(); if (ready) return ready;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { runtime.off('workspaceMcpProof', observed); runtime.off('nativeTurnEnd', ended); socket.off('close', closed); error ? reject(error) : resolve(value); };
    const observed = () => { try { const value = check(); if (value) finish(null, value); } catch (e) { finish(e); } };
    const ended = info => { if (info.turnId === identity.turnId) finish(uiError("error.nativeTurnEndedNoAutoMessage")); };
    const closed = () => finish(uiError("error.automaticMessageOriginWaitEnded"));
    runtime.on('workspaceMcpProof', observed); runtime.on('nativeTurnEnd', ended); socket.once('close', closed);
    observed();
  });
}

class NativeHost {
  constructor(privateDir, dataDir = privateDir, binding = null) {
    this.serviceBinding = binding === null ? null : Object.freeze(require('./butler-backend.cjs').butlerBinding(binding));
    // privateDir is the per-start socket folder; dataDir persists across restarts.
    this.privateDir = privateDir; this.dataDir = dataDir; this.hookSocket = path.join(privateDir, 'hooks.sock');
    this.submitSocket = path.join(privateDir, 'submit.sock');
    this.codexSocket = path.join(privateDir, 'codex.sock'); this.hookTargets = new Map(); this.codexTargets = new Map();
    // Automatic Codex version decisions (B3) are kept in the persistent data directory.
    this.codexQualificationFile = path.join(dataDir, 'codex-qualification.json'); codexQualification.load(this.codexQualificationFile);
    this.claudeModChecks = new Map();
    this.codexMessageToken = crypto.randomBytes(32).toString('hex');
    this.submissions = createSubmissionServer(this.submitSocket, this.hookTargets);
    this.resolvePrograms();
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
            if (event.token !== this.codexMessageToken || !codexQualification.allows('addressedTool', this.rpc?.nativeVersion) || !runtime || !runtime.addressedCall) throw uiError("error.nativeToolOriginUnconfirmed");
            const call = await workspaceMcpProof(runtime, identity, args, socket);
            const valid = () => currentWorkspaceMcpProof(runtime, identity, args, socket, call);
            if (!valid()) throw uiError("error.nativeToolOriginUnconfirmed");
            return runtime.addressedCall({ ...identity, valid }, args);
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
      if (this.closed || rpc !== this.rpc || child !== this.codexProcess) throw uiError("error.backendChangedStartQueueCancelled");
      return operation();
    });
    this.creationQueue = next.catch(() => {}); return next;
  }
  watchCodexConnection(rpc, child) {
    const ws = rpc.ws;
    let initialized = false, retired = false;
    let accountRevision = 0, accountReading = false, accountReadAgain = false;
    const current = () => !retired && !this.closed && this.codexProcess === child && this.rpc === rpc;
    const publishAccount = value => {
      if (!current()) return;
      this.codexAccountUsage = value;
      for (const target of new Set(this.codexTargets.values())) if (target.host === this && !target.stopped && !target.transportDisconnected) target.emit('accountUsage');
    };
    const readAccount = async () => {
      if (!current() || ws.readyState !== WebSocket.OPEN) return;
      if (accountReading) { accountReadAgain = true; return; }
      accountReading = true;
      const revision = accountRevision;
      try {
        const value = await rpc.call('account/rateLimits/read');
        if (current() && ws.readyState === WebSocket.OPEN && revision === accountRevision) publishAccount(codexAccountUsage(value));
      } catch { /* Unsupported or unavailable native metadata remains unknown. */ }
      finally {
        accountReading = false;
        if (accountReadAgain) { accountReadAgain = false; readAccount(); }
      }
    };
    const dispose = () => {
      accountRevision++; accountReadAgain = false;
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
      if (message.id === undefined && ['account/rateLimits/updated', 'account/updated'].includes(message.method)) {
        accountRevision++;
        if (message.method === 'account/updated') { publishAccount(null); readAccount(); }
        else publishAccount(codexAccountUsage(p, this.codexAccountUsage));
        return;
      }
      if (message.method === 'warning' && !p.threadId) {
        for (const target of this.codexTargets.values()) if (!target.terminalNotificationSource) target.event(message);
        return;
      }
      if (message.method === 'thread/started' && !p.thread?.parentThreadId && this.pendingCodex && !this.pendingCodexRuntime?.terminalBridge) this.pendingCodex(p.thread);
      const target = this.codexTargets.get(p.threadId || p.thread?.id);
      if (target && (message.id !== undefined || !target.terminalNotificationSource)) target.event(message);
      else if (message.method === 'thread/started' && p.thread?.parentThreadId) {
        const parent = this.codexTargets.get(p.thread.parentThreadId);
        if (parent && !parent.transportDisconnected) parent.emit('fleet', { id: p.thread.id, event: 'thread/started', name: p.thread.agentNickname || 'Codex 子 agent', nameUiMessage: p.thread.agentNickname ? null : uiNotice('notice.fleet.codexChild').uiMessage });
      }
    };
    const closed = () => {
      if (!current()) return;
      accountRevision++; accountReadAgain = false; publishAccount(null);
      for (const target of this.codexTargets.values()) target.transportClosed();
      retire();
    };
    child.once('exit', retire); rpc.on('event', event); rpc.on('closed', closed);
    return {
      activate: () => {
        this.disposeCodexConnection?.();
        this.rpc = rpc; this.disposeCodexConnection = dispose;
        this.codexAccountUsage = null;
        initialized = true; retire();
        if (!this.serviceBinding) readAccount();
      },
      dispose,
    };
  }
  readCodexEndpoint() {
    const link = fs.lstatSync(this.codexSocket), resolved = fs.realpathSync(this.codexSocket);
    const socket = fs.lstatSync(resolved);
    if (link.uid !== process.getuid() || socket.uid !== process.getuid() || !socket.isSocket() ||
      (!link.isSocket() && !link.isSymbolicLink())) throw uiError("error.nativeInterfaceIdentityUnconfirmed");
    // Codex may publish a symlink. Keep both identities: an unchanged link
    // does not prove that its target still belongs to the original listener.
    return { resolved, linkDev: link.dev, linkIno: link.ino, socketDev: socket.dev, socketIno: socket.ino };
  }
  async reconnectCodex() {
    if (this.reconnecting) return this.reconnecting;
    const child = this.codexProcess, previous = this.rpc, endpoint = this.codexEndpoint;
    const owned = () => !this.closed && this.codexProcess === child && child &&
      child.exitCode === null && child.signalCode === null && this.rpc === previous;
    if (!owned()) throw uiError("error.nativeBackendIdentityChanged");
    if (previous?.ws.readyState === WebSocket.OPEN) return;
    if (previous?.ws.readyState !== WebSocket.CLOSED || !endpoint) throw uiError("error.nativeConnectionExitUnconfirmed");
    const sameEndpoint = () => {
      const now = this.readCodexEndpoint();
      if (Object.keys(endpoint).some(key => now[key] !== endpoint[key])) throw uiError("error.nativeInterfaceChangedNoConnection");
    };
    this.reconnecting = Promise.resolve().then(async () => {
      let ws, watcher;
      try {
        if (!owned()) throw uiError("error.nativeBackendChangedNoNewBackend");
        sameEndpoint();
        ws = new WebSocket('ws://localhost', { createConnection: () => net.connect(endpoint.resolved), maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD, handshakeTimeout: 10000 });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        const rpc = new Rpc(ws);
        watcher = this.watchCodexConnection(rpc, child);
        rpc.nativeVersion = serverVersion(await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } }));
        if (!owned() || ws.readyState !== WebSocket.OPEN) throw uiError("error.nativeConnectionChangedDuringConfirmation");
        sameEndpoint();
        ws.send(JSON.stringify({ method: 'initialized', params: {} }));
        watcher.activate();
        this.qualifyCodexVersion(rpc.nativeVersion);
      } catch (error) {
        watcher?.dispose(); ws?.terminate();
        // A failed observer connection cannot stop the existing native server.
        throw error;
      }
    }).finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }
  // An unqualified Claude version gets the managed mod's own tests run once in the background, without
  // network or a session (B3, claude-mod-check.cjs). The result is kept in the data directory for the
  // manual qualification; it opens nothing and does not change the fallback. The record file is the
  // only output in daily use: the service runs with its output discarded, so the line below shows
  // only when the service is started by hand.
  checkClaudeVersion() {
    if (this.serviceBinding || this.closed) return;
    const claudePin = require('./claude-pin.cjs'), current = claudePin.installed(this.binaries.claude);
    if (!current || claudePin.QUALIFIED.includes(current.version) || this.claudeModChecks.has(current.version)) return;
    const version = current.version, stop = new AbortController();
    const done = claudeModCheck.checkOnce({ file: path.join(this.dataDir, 'claude-mod-check.json'), binary: path.join(current.dir, version), version, privateDir: this.privateDir, signal: stop.signal })
      .then(record => { if (record) console.error(`[NAW] Claude ${version} is not qualified; its mod tests ran in the background: ${claudeModCheck.describe(record)}`); })
      .catch(error => console.error(`[NAW] Claude ${version} mod tests could not be recorded: ${String(error?.message).slice(0, 200)}`));
    // Once per version for this start; a run that did not finish is tried again after the next start.
    this.claudeModChecks.set(version, { stop, done });
  }
  // A Codex version newer than the qualified baseline is compared in the background (B3);
  // its gates stay closed until a decision opens them, and targets then recheck.
  qualifyCodexVersion(version) {
    if (this.serviceBinding) return;
    if (this.closed || !this.codexBinary || !codexQualification.needsCheck(version) || this.codexQualifying?.version === version) return;
    const job = this.codexQualifying = { version };
    job.done = codexQualification.qualify({ binary: this.codexBinary, version, privateDir: this.privateDir })
      .then(decision => {
        if (this.closed) return;
        // record() opens the version in memory before writing; a failed write is logged and targets still recheck.
        try { codexQualification.record(this.codexQualificationFile, decision); }
        catch (error) { console.error(`[NAW] Codex ${version} check could not be saved: ${String(error?.message).slice(0, 200)}`); }
        const held = codexQualification.held(version);
        console.error(`[NAW] Codex ${version} checked against ${decision.basis}: ${held.length ? 'held ' + held.join(', ') : 'all capabilities open'}; ${decision.records.length} record(s)`);
        for (const target of this.codexTargets.values()) target.emit('capability');
      })
      .catch(error => console.error(`[NAW] Codex ${version} check failed: ${String(error?.message).slice(0, 200)}`))
      .finally(() => { if (this.codexQualifying === job) this.codexQualifying = null; });
  }
  async startCodex() {
    if (this.closed) throw uiError("error.nativeServiceClosed");
    if (this.serviceBinding) require('./butler-runner.cjs').checkProfile();
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
        if (entry.uid !== process.getuid() || (!entry.isSocket() && !entry.isSymbolicLink())) throw uiError("error.nativeIdentityUnconfirmedNoDuplicate");
        const absent = await new Promise(resolve => {
          const socket = net.connect(this.codexSocket);
          const finish = value => { socket.destroy(); resolve(value); };
          socket.once('connect', () => finish(false));
          socket.once('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code)));
          socket.setTimeout(1000, () => finish(false));
        });
        if (!absent) throw uiError("error.nativeInterfaceStillRunning");
        try {
          const now = fs.lstatSync(this.codexSocket);
          if (now.dev !== entry.dev || now.ino !== entry.ino) throw uiError("error.nativeInterfaceChangedNoDuplicate");
          fs.unlinkSync(this.codexSocket);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.codexBinary = this.binaries.codex;
      const mcpArgs = ['--disable-sigusr1', path.join(__dirname, 'claude-message-tool.cjs'), '--codex'];
      const mcpConfig = [
        ['command', process.execPath], ['args', mcpArgs], ['env.ELECTRON_RUN_AS_NODE', '1'],
        ['env.NAW_MESSAGE_SOCKET', this.hookSocket], ['env.NAW_MESSAGE_TOKEN', this.codexMessageToken],
        ...(process.env.NAW_OUTBOX_DESCRIPTOR ? [['env.NAW_CONTROL_DESCRIPTOR', process.env.NAW_OUTBOX_DESCRIPTOR]] : []),
      ].flatMap(([key, value]) => ['-c', `mcp_servers.native_workspace.${key}=${JSON.stringify(value)}`]);
      const outboxConfig = process.env.NAW_OUTBOX_DESCRIPTOR ? codexOutboxMcpArgs(process.env.NAW_OUTBOX_DESCRIPTOR) : [];
      if (this.serviceBinding) {
        require('./service-binding.cjs').beginRunner(this.dataDir);
        const launched = require('./butler-runner.cjs').spawnRunner(this.codexBinary,
          ['-c', 'analytics.enabled=false', 'app-server', '--listen', `unix://${this.codexSocket}`], this.serviceBinding, this.binaries.python);
        child = this.codexProcess = launched.child;
        // Install listeners before awaiting the metadata-only child preflight.
        child.stderr.on('data', () => {}); child.on('error', error => { spawnError = error; });
        this.butlerCredentialPresent = await launched.preflight;
      } else {
        child = this.codexProcess = spawn(this.codexBinary, ['-c', 'analytics.enabled=false', ...mcpConfig, ...codexComputerUseMcpArgs(), ...outboxConfig, 'app-server', '--listen', `unix://${this.codexSocket}`], { stdio: ['ignore', 'ignore', 'pipe'], env: nativeEnvironment() });
      }
      child.stderr.on('data', () => {});
      child.on('error', error => { spawnError = error; });
      for (let i = 0; i < 100 && !fs.existsSync(this.codexSocket); i++) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw uiError("error.codexBackendStartFailed");
        await delay(100);
      }
      const endpoint = this.readCodexEndpoint();
      // The socket file appears at bind(), before the server listens. A loaded
      // machine can refuse a connection in between: retry only that refusal,
      // only while this child runs and the endpoint is unchanged.
      for (let attempt = 0; ; attempt++) {
        ws = new WebSocket('ws://localhost', { createConnection: () => net.connect(endpoint.resolved), maxPayload: CODEX_WEBSOCKET_MAX_PAYLOAD, handshakeTimeout: 10000 });
        try { await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); break; }
        catch (error) {
          if (error.code !== 'ECONNREFUSED' || attempt >= 50) throw error;
          await delay(100);
          if (spawnError || child.exitCode !== null || child.signalCode !== null) throw uiError("error.codexBackendStartFailed");
          const now = this.readCodexEndpoint();
          if (Object.keys(endpoint).some(key => now[key] !== endpoint[key])) throw uiError("error.nativeInterfaceChangedDuringStart");
        }
      }
      rpc = new Rpc(ws);
      watcher = this.watchCodexConnection(rpc, child);
      rpc.nativeVersion = serverVersion(await rpc.call('initialize', { clientInfo: { name: 'native_agent_workspace', version: '0.1.0' }, capabilities: { experimentalApi: true } }));
      if (ws.readyState !== WebSocket.OPEN) throw uiError("error.nativeConnectionClosedDuringStart");
      const verifiedEndpoint = this.readCodexEndpoint();
      if (Object.keys(endpoint).some(key => verifiedEndpoint[key] !== endpoint[key])) throw uiError("error.nativeInterfaceChangedDuringStart");
      if (this.serviceBinding) require('./service-binding.cjs').confirmRunner(this.dataDir, child.pid);
      this.codexEndpoint = endpoint;
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      watcher.activate();
      this.qualifyCodexVersion(rpc.nativeVersion);
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
  // Where the native programs are now: resolved at start, before each session starts, and whenever a client
  // asks for the initial state, so that state's `available` is current and not the answer from the last start.
  resolvePrograms() { this.binaries = { claude: executable('claude'), codex: executable('codex'), python: pythonExecutable() }; return this.binaries; }
  create(record) {
    if (this.serviceBinding) throw require('./service-binding.cjs').failure('butler-qualification-required');
    this.resolvePrograms();
    if (!this.binaries[record.provider] || !this.binaries.python) throw uiError("error.nativeRuntimeMissing");
    if (record.provider === 'codex' && this.codexBinary && this.codexBinary !== this.binaries.codex) throw uiError("error.codexLocationChanged");
    return record.provider === 'claude' ? new Claude(record, this) : new Codex(record, this);
  }
  close() { this.closed = true; for (const check of this.claudeModChecks.values()) check.stop.abort(); for (const target of this.hookTargets.values()) { target.submission?.close(); target.stop().catch(() => {}); } for (const target of this.codexTargets.values()) target.terminal?.stop().catch(() => {}); this.rpc?.ws.close(); this.codexProcess?.kill('SIGTERM'); this.hooks.close(); this.submissions.server.close(); }
}

module.exports = { claudeHolder, claudeImportAvailable, NativeHost, Terminal, Claude, Codex, Rpc, executable, delay, claudeGeneratedTitle, promptTextTag };
