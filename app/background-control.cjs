// Application commands share the GUI's handlers. This module has no desktop,
// browser debugger, provider connection, synthetic keyboard or permission API.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const operation = require('./background-operation.cjs');
const { roomId: validRoomId, roomIds } = require('./collaboration-spaces.cjs');
const clone = v => JSON.parse(JSON.stringify(v));
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_PER_ACTOR = 32, MAX_PENDING = 128;
const REFUSAL_WINDOW_MS = 60000, MAX_REFUSAL_SUMMARIES = 128;
const REFUSAL_RETRY_HINT = 'invoke or snapshot: new operation_id or compacted refused ID is a fresh request.';
const refusalRetry = () => ({ retryWithNewOperationId: true, retryHint: REFUSAL_RETRY_HINT });
const summarizedReasons = new Set(['confirmation-limit', 'originating-session-unavailable']);
const positiveCount = n => Number.isSafeInteger(n) && n > 0;
const nextCount = n => { if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER) throw Error('Refusal counter is exhausted'); return n + 1; };
const terminalReads = new Set(['terminalSnapshot', 'observe', 'terminal']);
const privateReads = new Set(['initial', 'previewImage', 'expandImage', ...terminalReads]);
const spaceFileRead = command => command.method === 'spaceFiles' && command.arguments?.[1] !== undefined;
const privateRead = command => privateReads.has(command.method) || spaceFileRead(command);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function hideApprovalBodies(guard) {
  for (const session of Array.isArray(guard?.sessions) ? guard.sessions : []) for (const key of ['approval', 'nativeApproval'])
    if (session?.[key] != null) session[key] = digest(session[key]);
  return guard;
}
const controlGuard = (context, command) => hideApprovalBodies(clone(context.fingerprint?.(command) || null));
function compactRead(record) {
  if (record.guard?.auditRooms) record.guard = { auditRooms: record.guard.auditRooms };
  else delete record.guard;
}
function readTarget(record, value) {
  if (spaceFileRead(record.command)) return { roomId: record.command.arguments[0], fileId: record.command.arguments[1] };
  const source = record.command.arguments?.[0];
  const id = record.readAuthorization?.sessionId || (terminalReads.has(record.command.method) ? source : record.command.method === 'initial' ? source || value?.viewState?.selected || record.actor.id : source?.sessionId);
  if (typeof id !== 'string' || !id) return typeof source?.roomId === 'string' ? { roomId: source.roomId } : null;
  const session = value?.sessions?.find(s => s.id === id);
  let name = session?.name || (id === record.actor.id ? record.actor.name : null);
  if (!name) try { name = JSON.parse(record.confirmation?.options?.detail).references?.find(r => r.kind === 'session' && r.id === id)?.name; } catch { /* Legacy receipts may have no named reference. */ }
  return { sessionId: id, nativeId: record.readAuthorization?.nativeId || session?.nativeId || record.guard?.sessions?.find(s => s.id === id)?.nativeId || (id === record.actor.id ? record.actor.nativeId : null),
    ...(typeof name === 'string' ? { name: operation.visibleText(name) } : {}) };
}
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
// Parameters use the existing application's names and order. All values still
// pass its normal validators. Snapshot supplies current native/turn identities.
const parameters = {
  initial: ['Selected foreign conversation requires confirmation; read the resulting operation receipt after approval.'], preflight: [], dataDirectory: [], retrySave: [], reconnect: [], connectionUpdates: [], quitService: [],
  interfaceSettings: ['action: describe|update', 'namespace: locale|client-ui-theme (update only)', 'patch (update only)', 'current revision from describe (update only)'],
  prepareInput: ['sessionId'], observe: ['sessionId'], unobserve: ['sessionId'], claim: ['sessionId', 'mode: chat|terminal'],
  terminal: ['sessionId'], terminalSnapshot: ['sessionId'], input: ['sessionId', 'exact terminal input'], resize: ['sessionId', 'cols', 'rows'],
  interrupt: ['sessionId'], pause: [], approve: ['sessionId', 'requestId', 'decision: accept|decline|cancel'], answer: ['sessionId', 'requestId', 'answers'],
  wakePolicy: ['sessionId or null for global', 'enabled?'], operatorAction: ['sessionId', 'action', 'value?'],
  join: ['sessionId', 'join: boolean'], roomRename: ['name'], roomNotes: ['text', 'expectedRevision'], roomMemberOrder: ['change'],
  archiveSession: ['sessionId'], restoreSession: ['sessionId'], archiveRoom: [], restoreRoom: [],
  spaceCreate: ['name'], spaceMerge: ['action: preview|status|commit|recover|discard|undo', 'value'],
  spaceAction: ['roomId', 'action: join|rename|notes|memberOrder|archive|restore|stageImages|removeImage|acceptImages|removeFile|queueAdd|queueCancel|queueResolve|forward|queueShared|steerShared|run|pause|clearSharedHistory', 'queueAdd: [text, assignee or null]; only the person-designated secretary may add; queueCancel/queueResolve are person-only; other arguments in the corresponding command order'],
  queueSecretary: ['sessionId or null to revoke; person-only, agents cannot designate themselves'],
  spaceFiles: ['roomId', 'fileId?; omit to import the explicit paths'], gitWorktreePreview: ['selected repository path', 'nonce', 'relative path'],
  create: ['options: {provider,cwd,name,view?,gitWorktree?}'], nativeHistory: ['options?'], importHistory: ['nativeId', 'options'],
  rename: ['sessionId', 'name'], sidebar: ['change'],
  send: ['sessionId', 'exact message', 'expectedNativeId'], forward: ['sessionId', 'exact message', 'expectedNativeId', 'replyTo?'],
  queue: ['sessionId', 'exact message', 'expectedNativeId'], queueShared: ['sessionId', 'exact message', 'expectedNativeId', 'replyTo?'],
  steer: ['sessionId', 'exact message', 'expectedNativeId', 'expectedTurnId'], steerShared: ['sessionId', 'exact message', 'expectedNativeId', 'expectedTurnId', 'replyTo?'],
  run: ['sessionIds', 'goal text', 'turn budget', 'mode: replies|task', 'expected names?', 'expected native contexts?', 'replyTo?'],
  runtimeLocation: ['program: claude|codex|python3', 'reset: boolean?'], clearSharedHistory: [],
  draft: ['sessionId', 'text'], retainDraftRecovery: ['sessionId', 'text'], discardDraftRecovery: ['sessionId', 'text'],
  backendSwitchSettings: ['auto: boolean?'], switchBackend: ['expected option from connectionUpdates'], continueConnection: ['sessionId', 'expected continuation option'],
  resume: ['sessionId'], forget: ['sessionId'], stop: ['sessionId'], openExternal: ['http(s) URL; background returns the URL without opening the desktop browser'],
  openMessageFile: ['source: {kind,sessionId,messageId,nativeId,cwd,roomId?}', 'local path', '{line}?'],
  readingState: ['positions', 'panorama?'], viewState: ['{selected,mode,spaceId?,roomViews?,terminalLayout?,terminalDisplay?,...}; independent agent view only'],
  openLocalFile: ['sessionId?; supply paths on the invocation'], closeLocalFile: ['preview token'], saveLocalFile: ['preview token; supply a new destination in paths'],
  chooseFolder: [], newWindow: ['sessionId?; returns an independent hidden view_id'], copy: ['text; independent clipboard only'], pasteText: [],
  stageImages: ['sessionId', 'nativeId', 'files'], pasteNativeContent: ['sessionId', 'nativeId'], previewImage: ['source'], expandImage: ['token'], copyImage: ['token'], releaseImage: ['token'],
};
const tool = { name: 'workspace_control', description: 'Operate NAW in the background without moving the desktop pointer or changing the human window. Discover commands with catalog, inspect the independent view with snapshot, invoke an exact existing application command, and read durable receipts. Native permissions and human confirmations remain required. Refused invoke and snapshot requests may be summarized; reusing a summarized refused ID is a new request through current admission and any required human confirmation. Executed, uncertain and human-cancelled IDs never replay. Refused-ID receipt aliases retain at most 512 recent IDs, 128 per NAW session, while their summary remains; expired aliases return no receipt. Never resend an uncertain operation. This tool does not authorize new work.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['catalog', 'snapshot', 'invoke', 'receipt'] },
    view_id: { type: 'string', maxLength: 160 },
    method: { type: 'string', maxLength: 80 }, arguments: { type: 'array', maxItems: 12 },
    operation_id: { type: 'string', maxLength: 160 }, paths: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 8192 } },
  }, required: ['action'] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } };
function validate(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(tool.inputSchema.properties, k)) ||
      !['catalog', 'snapshot', 'invoke', 'receipt'].includes(value.action) || Buffer.byteLength(JSON.stringify(value)) > 131072) throw Error('Invalid background command');
  if (value.view_id !== undefined && !token(value.view_id)) throw Error('Invalid independent view');
  if (value.action === 'invoke') {
    if (typeof value.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.method) ||
        !Array.isArray(value.arguments) || value.arguments.length > 12 || !token(value.operation_id)) throw Error('An exact command, arguments and unique operation_id are required');
    if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.length > 16 || value.paths.some(p => typeof p !== 'string' || p.length > 8192 || !path.isAbsolute(p) || p.includes('\0')))) throw Error('Invalid explicit file selection');
  } else if (value.action === 'receipt') {
    if (!token(value.operation_id) || Object.keys(value).some(k => !['action', 'operation_id'].includes(k))) throw Error('Invalid receipt request');
  } else if (Object.keys(value).some(k => !['action', ...(value.action === 'snapshot' ? ['view_id', 'operation_id'] : [])].includes(k)) ||
    value.action === 'snapshot' && value.operation_id !== undefined && !token(value.operation_id)) throw Error('Read command does not accept mutation arguments');
  return clone(value);
}
class ConfirmationRequired extends Error {
  constructor(value) { super('This operation needs the existing human confirmation'); this.confirmation = clone(value); }
}
function refusalDetails(reason) {
  return { state: 'not-executed', reason, retry: false, ...(reason === 'originating-session-unavailable' ? {
    retryWithNewOperationId: true,
    retryHint: REFUSAL_RETRY_HINT,
  } : {}) };
}
const compactRefusal = row => { row.guard = { auditRooms: row.guard?.auditRooms || ['shared'] }; };
class BackgroundControl {
  constructor({ dataDir, handlers, context, confirmation, audit, confirmationPending, project = record => record, changed = () => {}, now = Date.now, readCopyBytes = MAX_RECORD_BYTES }) {
    if (!Number.isSafeInteger(readCopyBytes) || readCopyBytes < 1 || readCopyBytes > MAX_RECORD_BYTES) throw Error('Invalid read copy budget');
    this.file = path.join(dataDir, 'background-operations.json'); this.handlers = handlers; this.context = context; this.changed = changed; this.now = now;
    this.data = { version: 1, records: [], views: {}, refusals: [], refusalActors: {}, refusalReceipts: [] }; this.inflight = new Map(); this.contexts = new Map(); this.failed = false;
    this.confirmation = confirmation; this.audit = audit;
    this.confirmationPending = confirmationPending;
    this.project = project;
    this.readCopies = new Map(); this.readBytes = 0; this.readCopyBytes = readCopyBytes;
    try {
      const st = fs.lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || st.mode & 0o077 || st.size > MAX_RECORD_BYTES) throw Error('Unsafe background operation record');
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.data.version !== 1 || !Array.isArray(this.data.records) || this.data.records.some(r => !token(r.id) || !r.actor || !r.command || !token(r.state))) throw Error('Invalid background operation record');
      this.data.views ||= {};
      this.data.refusals ||= []; this.data.refusalActors ||= {}; this.data.refusalReceipts ||= [];
      const object = v => v && typeof v === 'object' && !Array.isArray(v);
      const counter = v => object(v) && token(v.id) && positiveCount(v.count) && object(v.rooms) && Object.entries(v.rooms).every(([id, r]) => validRoomId(id) && object(r) && positiveCount(r.count) && positiveCount(r.sequence) && token(r.lastMethod));
      if (!object(this.data.refusalActors) || Object.values(this.data.refusalActors).some(v => !object(v) || !positiveCount(v.sequence) || !Number.isSafeInteger(v.windowStart) || v.windowStart < 0 || !object(v.counts) || Object.entries(v.counts).some(([reason, c]) => !summarizedReasons.has(reason) || !counter(c))) ||
          !Array.isArray(this.data.refusals) || this.data.refusals.length > MAX_REFUSAL_SUMMARIES || this.data.refusals.some(r => !token(r.id) || !r.actor || r.state !== 'not-executed' || !r.command || !summarizedReasons.has(r.refusalSummary?.reason) || !counter(r.refusalSummary) || !this.data.refusalActors[this.key(r.actor)])) throw Error('Invalid refusal summaries');
      if (!Array.isArray(this.data.refusalReceipts) || this.data.refusalReceipts.length > 512 || this.data.refusalReceipts.some(a => !token(a.id) || !token(a.actor?.id) || !token(a.actor?.nativeId) || !['claude', 'codex'].includes(a.actor?.provider) || !token(a.summaryId) || !this.data.refusals.some(r => r.id === a.summaryId && this.key(r.actor) === this.key(a.actor)))) throw Error('Invalid refusal receipts');
      // A process died after recording intent. No automatic replay.
      if (this.data.refusals.some(r => Object.hasOwn(r, 'retryHint') && r.retryHint !== REFUSAL_RETRY_HINT) || operation.retainRefusalRows(this.data.refusals, 128, 32).length !== this.data.refusals.length ||
          operation.retainRefusalRows(this.data.refusalReceipts, 512, 128).length !== this.data.refusalReceipts.length ||
          this.data.records.some(r => r.state === 'running' || ['available', 'pending'].includes(r.readState) || privateRead(r.command) && Object.hasOwn(r, 'value') ||
          Array.isArray(r.guard?.sessions) && r.guard.sessions.some(s => ['approval', 'nativeApproval'].some(k => s?.[k] != null && s[k] !== digest(s[k]))))) this.commit(d => {
        for (const r of d.records) {
          if (r.state === 'running') r.state = 'unconfirmed';
          if (['available', 'pending'].includes(r.readState)) { r.readState = 'expired'; r.readReason = 'restart'; }
        }
      });
    } catch (e) { if (e.code !== 'ENOENT') { this.failed = true; throw e; } }
  }
  commit(change) {
    if (this.failed) throw Error('Background operation storage is unavailable');
    const next = clone(this.data); change(next);
    next.refusals = operation.retainRefusalRows(next.refusals, 128, 32);
    // Rewrite obsolete hints without adding fields to old, potentially full
    // files. New summaries already carry the same hint as their direct reply.
    for (const row of next.refusals) if (Object.hasOwn(row, 'retryHint')) row.retryHint = REFUSAL_RETRY_HINT;
    const summaries = new Set(next.refusals.map(r => this.key(r.actor) + ':' + r.id));
    const exact = new Set(next.records.map(r => this.key(r.actor) + ':' + r.id));
    next.refusalReceipts = operation.retainRefusalRows(next.refusalReceipts.filter(a => summaries.has(this.key(a.actor) + ':' + a.summaryId) && !exact.has(this.key(a.actor) + ':' + a.id)), 512, 128);
    // Read bodies never belong to the durable operation log, including legacy
    // values loaded from an earlier build. A bounded, one-use cache holds them.
    for (const r of next.records) {
      hideApprovalBodies(r.guard);
      if (privateRead(r.command) && Object.hasOwn(r, 'value')) {
        r.readTarget ||= readTarget(r, r.value); delete r.value;
        r.readState = 'expired'; r.readReason = 'legacy-copy';
      }
      if (privateRead(r.command) && ['available', 'consumed', 'expired'].includes(r.readState) && !['running', 'confirmation-required'].includes(r.state)) compactRead(r);
    }
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw Error('Background operation record is full; existing records are retained');
    const temporary = `${this.file}.${randomUUID()}.tmp`; let renamed = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file); renamed = true;
      const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.data = next; this.changed();
    } catch (error) {
      this.failed = true; if (!renamed) fs.rmSync(temporary, { force: true });
      throw Error('Background operation save is unconfirmed; no automatic replay', { cause: error });
    }
  }
  key(sender) { return `${sender.provider}:${sender.id}:${sender.nativeId}`; }
  catalog() { return [...this.handlers.keys()].filter(name => !['backgroundDecision', 'uiReady'].includes(name)).sort().map(name => ({ method: name, parameters: parameters[name] || [],
    ...( ['chooseFolder', 'openLocalFile', 'saveLocalFile', 'runtimeLocation', 'spaceFiles'].includes(name) ? { fileSelection: 'Supply explicit absolute paths on the invocation; no desktop file picker is opened.' } : {}) })); }
  async view(sender, viewId = 'default') {
    if (this.closed) throw Error('Background control is closing');
    const key = this.key(sender) + ':' + viewId;
    if (viewId !== 'default' && !this.data.views[key]) throw Error('Independent view does not exist');
    if (!this.contexts.has(key)) this.contexts.set(key, Promise.resolve(this.context(sender, this.data.views[key] && clone(this.data.views[key]))));
    return this.contexts.get(key);
  }
  async newView(sender, selected, mode) {
    if (this.closed) throw Error('Background control is closing');
    const viewId = randomUUID(), key = this.key(sender) + ':' + viewId;
    this.commit(d => { d.views[key] = { owner: randomUUID(), selected: selected || '', mode, preference: mode, active: false }; });
    await this.view(sender, viewId);
    return { view_id: viewId, visible: false };
  }
  receipt(sender, id, context = null, exact = false) {
    const own = r => r.id === id && this.key(r.actor) === this.key(sender);
    let record = this.data.records.find(own) || this.data.refusals.find(own);
    if (!record && !exact) {
      const alias = this.data.refusalReceipts.find(own);
      if (alias) record = this.data.refusals.find(r => r.id === alias.summaryId && this.key(r.actor) === this.key(sender));
    }
    return record ? this.project(clone(record), context) : null;
  }
  rememberRead(actor, id, value) {
    const key = this.key(actor) + ':' + id, bytes = Buffer.byteLength(JSON.stringify(value)), expired = [];
    let retained = this.readBytes;
    for (const [oldKey, entry] of !this.closed && bytes <= this.readCopyBytes ? this.readCopies : []) {
      if (retained + bytes <= this.readCopyBytes) break;
      expired.push(oldKey); retained -= entry.bytes;
    }
    this.commit(d => {
      for (const r of d.records) if (expired.includes(this.key(r.actor) + ':' + r.id)) { r.readState = 'expired'; r.readReason = 'copy-budget'; }
      const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(actor));
      r.readState = this.closed || bytes > this.readCopyBytes ? 'expired' : 'available';
      if (r.readState === 'expired') r.readReason = this.closed ? 'closed' : 'copy-budget';
    });
    for (const oldKey of expired) { this.readBytes -= this.readCopies.get(oldKey).bytes; this.readCopies.delete(oldKey); }
    if (!this.closed && bytes <= this.readCopyBytes) { this.readCopies.set(key, { value, bytes }); this.readBytes += bytes; }
  }
  takeReceipt(sender, id, context) {
    const key = this.key(sender) + ':' + id, copy = this.readCopies.get(key);
    if (!copy) return this.receipt(sender, id, context);
    // Persist consumption before exposing any body. A crash cannot replay it.
    this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(sender)); r.readState = 'consumed'; r.readConsumedAt = this.now(); });
    this.readCopies.delete(key); this.readBytes -= copy.bytes;
    return this.project({ ...this.receipt(sender, id), value: clone(copy.value) }, context);
  }
  async publish(record, context) {
    if (!record.refusalSummary && !operation.maintenanceAction(record.command.method, record.command.arguments, record.actor)) return;
    if (typeof this.audit !== 'function') throw Error('Maintenance event storage is unavailable');
    await this.audit(clone(record), context);
  }
  async finishAudit(actor, id, context) {
    const record = this.receipt(actor, id);
    try { await this.publish(record, context); }
    catch (error) {
      // Never rerun a side effect because its display journal failed. Retain the
      // actual result separately and make the incomplete audit visible.
      this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(actor));
        Object.assign(r, { resultState: r.state, state: 'unconfirmed', auditError: String(error.message).slice(0, 2048), error: 'The maintenance space event could not be saved; inspect the recorded result and do not repeat.' }); });
    }
    return this.receipt(actor, id);
  }
  async recordRefusal(actor, args, context, reason) {
    const key = this.key(actor), now = this.now(); let guard, id;
    try { guard = controlGuard(context, args); } catch { /* A failed refresh must still refuse safely. */ }
    let rooms = guard?.auditRooms;
    if (!Array.isArray(rooms)) try { rooms = roomIds(context.client.snapshot().sessions.find(s => s.id === actor.id && s.nativeId === actor.nativeId)); } catch { /* Metadata unavailable. */ }
    rooms = [...new Set((rooms || []).filter(validRoomId))]; if (!rooms.length) rooms = ['shared'];
    const start = Math.max(Math.floor(now / REFUSAL_WINDOW_MS) * REFUSAL_WINDOW_MS, this.data.refusalActors[key]?.windowStart || 0);
    this.commit(d => {
      const state = d.refusalActors[key] ||= { sequence: 0, windowStart: start, counts: {} };
      if (state.windowStart !== start) { state.windowStart = start; state.counts = {}; }
      state.sequence = nextCount(state.sequence);
      delete state.prefix; // The unpublished prefix-based candidate is no longer a protocol rule.
      if (!state.counts[reason]) {
        do { id = 'refusal:' + randomUUID(); } while (id === args.operation_id || [...d.records, ...d.refusals].some(r => r.id === id));
        state.counts[reason] = { id, count: 0, rooms: {} };
      }
      const count = state.counts[reason]; id = count.id; count.count = nextCount(count.count);
      for (const room of rooms) {
        const prior = count.rooms[room];
        count.rooms[room] = { count: nextCount(prior?.count || 0), sequence: state.sequence, lastMethod: args.method };
      }
      // Only the current, proven non-executed intent is replaced. Ordinary and
      // legacy history retains its original ID and replay semantics.
      d.records = d.records.filter(r => !(r.id === args.operation_id && this.key(r.actor) === key && r.state === 'running'));
      const prior = d.refusals.find(r => r.id === id);
      const record = { id, actor: { id: actor.id, nativeId: actor.nativeId, provider: actor.provider, name: actor.name },
        command: { action: 'invoke', method: 'backgroundRefusal', arguments: [], operation_id: id },
        ...refusalDetails(reason), ...refusalRetry(), at: prior?.at ?? now, finishedAt: now, guard: { auditRooms: Object.keys(count.rooms).sort() },
        refusalSummary: { ...clone(count), reason, windowStart: start, windowEnd: start + REFUSAL_WINDOW_MS, sequence: state.sequence } };
      d.refusals = [...d.refusals.filter(r => r.id !== id), record];
      d.refusalReceipts = [...d.refusalReceipts.filter(r => !(r.id === args.operation_id && this.key(r.actor) === key)),
        { id: args.operation_id, actor: { id: actor.id, nativeId: actor.nativeId, provider: actor.provider }, summaryId: id }];
    });
    const summary = clone(this.data.refusals.find(r => r.id === id)); let auditError;
    try { await this.publish(summary, context); }
    catch {
      auditError = 'The refusal summary space event could not be saved';
      this.commit(d => { const row = d.refusals.find(r => r.id === id); if (row) row.auditError = 'The refusal summary space event could not be saved'; });
    }
    return { ...refusalDetails(reason), ...refusalRetry(),
      id: args.operation_id, actor, method: args.method,
      guard: { auditRooms: rooms }, summaryId: id, count: summary.refusalSummary.count,
      ...(auditError ? { auditError } : {}) };
  }
  confirmationRefusal(actor, args, context, guard) {
    let sessions;
    try { sessions = typeof context.confirmationActors === 'function' ? context.confirmationActors() : guard?.sessions; }
    catch { return 'originating-session-unavailable'; }
    const requester = Array.isArray(sessions) && sessions.find(s => s.id === actor.id);
    if (!requester || requester.nativeId !== actor.nativeId || requester.archived || requester.nativeContextPending)
      return 'originating-session-unavailable';
    const key = this.key(actor), pending = this.data.records.filter(r =>
      !(r.id === args.operation_id && this.key(r.actor) === key) &&
      (r.state === 'confirmation-required' && r.confirmation?.kind === 'message' || r.state === 'running' && operation.maintenanceAction(r.command.method, r.command.arguments, r.actor)) &&
      sessions.some(s => s.id === r.actor.id && s.nativeId === r.actor.nativeId && !s.archived && !s.nativeContextPending));
    return pending.length >= MAX_PENDING || pending.filter(r => this.key(r.actor) === key).length >= MAX_PENDING_PER_ACTOR ? 'confirmation-limit' : null;
  }
  async call(binding, input) {
    if (this.closed) throw Error('Background control is closing');
    let args = validate(input); const { sender, identity } = binding;
    const valid = async () => { await binding.refresh?.(); if (!binding.valid()) throw Error('The originating native call is no longer valid'); };
    await valid();
    if (args.action === 'catalog') return { state: 'complete', commands: this.catalog(), background: true };
    if (args.action === 'receipt') {
      const saved = this.receipt(sender, args.operation_id);
      let context = null;
      if (saved) {
        context = await this.view(sender, saved.command.view_id);
        if (privateRead(saved.command)) { await context.refresh?.(); await valid(); }
        const delivery = await context.delivery?.(saved.command, saved.value, saved.actor, saved.guard);
        if (delivery) this.commit(d => { const r = d.records.find(r => r.id === saved.id && this.key(r.actor) === this.key(sender)); r.delivery = delivery; if (delivery.nativeReceived) r.state = 'received'; });
      }
      return { state: 'complete', receipt: this.takeReceipt(sender, args.operation_id, context), retry: false };
    }
    const context = await this.view(sender, args.view_id); await valid();
    const selected = args.action === 'snapshot' || args.method === 'initial' ? context.view.selected : null;
    const target = selected && selected !== sender.id && context.client.snapshot?.().sessions?.some(s => s.id === selected) ? selected : null;
    const implicitSnapshot = args.action === 'snapshot' && args.operation_id === undefined;
    if (args.action === 'snapshot' && (!target || context.metadataOnly?.())) {
      const actor = operation.actor({ ...sender, callId: identity.callId, turnId: identity.turnId, operationId: identity.callId });
      return operation.run(actor, async () => ({ state: 'complete', value: await this.handlers.get('initial')(context) }), { context, args, actor, valid });
    }
    if (args.action === 'snapshot') args = { action: 'invoke', method: 'initial', arguments: [], operation_id: args.operation_id || randomUUID(), ...(args.view_id ? { view_id: args.view_id } : {}) };
    // Selection is navigation, never authority. Pin the actual selected target,
    // including for invoke initial, rather than trusting caller-supplied args.
    if (args.method === 'initial') args = { ...args, arguments: [target || sender.id] };
    if (implicitSnapshot) {
      const sameView = r => this.key(r.actor) === this.key(sender) && (r.command.view_id || 'default') === (args.view_id || 'default');
      const changedSelection = this.data.records.findLastIndex(r => sameView(r) && r.state === 'complete' && r.command.method === 'viewState' &&
        Object.hasOwn(r.command.arguments?.[0] || {}, 'selected') && r.command.arguments[0].selected !== target);
      const guard = controlGuard(context, args);
      // A cancellation is the person's answer, not a request to prompt again.
      // Explicit IDs may ask again. Navigating away or changing the bound
      // consent target releases an implicit cancellation, including after restart.
      const previous = this.data.records.findLast((r, index) => sameView(r) &&
        (r.state === 'confirmation-required' || r.state === 'cancelled' && index > changedSelection) &&
        isDeepStrictEqual({ ...r.command, operation_id: args.operation_id }, args) && isDeepStrictEqual(r.guard, guard));
      if (previous) return { ...this.receipt(sender, previous.id), duplicate: true, retry: false };
    }
    // Receipt aliases explain compacted refusals; they never bind a new invoke.
    const existing = this.receipt(sender, args.operation_id, null, true);
    if (existing) {
      if (!isDeepStrictEqual(existing.command, args)) throw Error('operation_id already belongs to a different command');
      await this.publish(existing, context);
      if (privateRead(args)) { await context.refresh?.(); await valid(); }
      return { ...this.takeReceipt(sender, args.operation_id, context), duplicate: true, retry: false };
    }
    const handler = !['backgroundDecision', 'uiReady'].includes(args.method) && this.handlers.get(args.method);
    const key = this.key(sender);
    const actor = operation.actor({ ...sender, callId: identity.callId, turnId: identity.turnId, operationId: args.operation_id });
    const refuse = reason => {
      if (summarizedReasons.has(reason)) return this.recordRefusal(actor, args, context, reason);
      const refusal = { ...refusalDetails(reason), method: args.method };
      if (!operation.maintenanceAction(args.method, args.arguments, actor)) return refusal;
      const guard = controlGuard(context, args);
      this.commit(d => {
        const row = { id: args.operation_id, actor, command: args, guard, ...refusal, at: this.now() };
        if (['confirmation-limit', 'originating-session-unavailable'].includes(reason)) compactRefusal(row);
        d.records.push(row);
      });
      return this.finishAudit(actor, args.operation_id, context);
    };
    if (!handler || this.inflight.has(key)) return refuse(handler ? 'another-operation-running' : 'unknown-command');
    // Busy decisions reserve their actor before awaits. Refresh only an idle
    // independent view, then check the reservation again before saving intent.
    await context.refresh?.(); await valid();
    if (this.inflight.has(key)) return refuse('another-operation-running');
    const guard = controlGuard(context, args);
    if (operation.maintenanceAction(args.method, args.arguments, actor)) {
      const reason = this.confirmationRefusal(actor, args, context, guard);
      if (reason) return refuse(reason);
    }
    // Save intent before calling ANY mutation, including an independent draft.
    this.commit(d => d.records.push({ id: args.operation_id, actor, command: args, guard, state: 'running', at: this.now() }));
    return this.execute(actor, args, context, valid);
  }
  exclusive(actor, work) {
    const key = this.key(actor);
    if (this.closed || this.inflight.has(key)) throw Error('Another operation is running or background control is closing');
    // Reserve synchronously, before context lookup, identity refresh or prompts.
    const job = Promise.resolve().then(work);
    this.inflight.set(key, job);
    return job.finally(() => { if (this.inflight.get(key) === job) this.inflight.delete(key); });
  }
  execute(actor, args, context, valid, approved) {
    return this.exclusive(actor, () => this.perform(actor, args, context, valid, approved));
  }
  async perform(actor, args, context, valid, approved) {
    const key = this.key(actor), handler = this.handlers.get(args.method);
      let state, value, error, confirmation, delivery, refusal;
      try {
        await valid();
        if (this.closed) throw Error('Background control is closing');
        const row = this.receipt(actor, args.operation_id);
        if (row.guard && !isDeepStrictEqual(row.guard, controlGuard(context, args))) throw Error('The operation target changed before execution');
        const request = { context, args, actor, guard: row.guard, valid, approved, dialogIndex: 0 };
        value = await operation.run(actor, async () => {
          const action = operation.maintenanceAction(args.method, args.arguments, actor);
          let terminalTarget = null;
          if (action) {
            if (typeof this.confirmation !== 'function' || typeof this.audit !== 'function') throw Error('Human maintenance confirmation or event storage is unavailable');
            const answer = await dialog(context, 'message', this.confirmation(actor, args, action, context));
            if (answer.response !== 1) return { cancelled: true };
            request.maintenanceApproved = true;
            // If the event writer is broken, fail before an approved mutation.
            await this.publish({ ...row, state: 'running' }, context);
            if (spaceFileRead(args)) {
              this.commit(data => { data.records.find(r => r.id === row.id && this.key(r.actor) === key).readAuthorization = { roomId: args.arguments[0], fileId: args.arguments[1] }; });
            } else if (action === 'readConversation' || terminalReads.has(args.method)) {
              const targetId = terminalReads.has(args.method) ? args.arguments[0] : operation.conversationTarget(args.method, args.arguments, actor);
              const target = row.guard?.sessions?.find(s => s.id === targetId);
              if (!target) throw Error('The conversation target is unavailable');
              this.commit(data => { data.records.find(r => r.id === row.id && this.key(r.actor) === key).readAuthorization = { sessionId: target.id, nativeId: target.nativeId }; });
              if (terminalReads.has(args.method)) terminalTarget = target;
            }
          }
          if (!terminalTarget) return handler(context, ...args.arguments);
          const result = await handler(context, ...args.arguments), frozen = result === undefined ? undefined : clone(result);
          await context.refresh?.(); await valid();
          const current = context.client.snapshot().sessions.find(s => s.id === terminalTarget.id);
          if (!current || current.nativeId !== terminalTarget.nativeId) throw Error('The approved terminal target changed before the read completed');
          return frozen;
        }, request);
        delivery = await context.delivery?.(args, value, actor, row.guard);
        state = delivery ? delivery.nativeReceived ? 'received' : 'awaiting-native' : 'complete';
      } catch (e) {
        if (e instanceof ConfirmationRequired && e.confirmation?.kind === 'message') {
          // Refresh first; the quota decision and pending-row commit below have
          // no await between them. Concurrent actors cannot both take slot128.
          try {
            await context.refresh?.(); await valid();
            if (this.closed) throw Error('Background control is closing');
            const reason = this.confirmationRefusal(actor, args, context, controlGuard(context, args));
            if (reason) { refusal = refusalDetails(reason); state = refusal.state; }
            else { state = 'confirmation-required'; confirmation = e.confirmation; }
          } catch (refreshError) {
            refusal = refusalDetails('originating-session-unavailable'); state = refusal.state;
            error = String(refreshError.message || 'The originating session could not be refreshed').slice(0, 2048);
          }
        }
        else if (e instanceof ConfirmationRequired) {
          refusal = refusalDetails('explicit-paths-required'); state = refusal.state;
          error = 'Background file selection requires explicit absolute paths on a new operation_id.';
        }
        else { state = 'unconfirmed'; error = typeof e.message === 'string' ? e.message.slice(0, 2048) : 'Operation outcome is unconfirmed'; }
      }
      // A prior approval may already have allowed effects. Keep that original
      // operation and its unknown outcome instead of summarizing it as not run.
      if (refusal && approved) {
        refusal = { state: 'unconfirmed', reason: 'follow-up-confirmation-refused', confirmationRefusal: refusal.reason, retry: false };
        state = 'unconfirmed'; error = 'A follow-up confirmation was refused after approval; inspect the original operation and do not repeat it.';
      }
      if (refusal && summarizedReasons.has(refusal.reason)) return this.recordRefusal(actor, args, context, refusal.reason);
      const privateValue = value !== undefined && privateRead(args), readValue = privateValue ? clone(value) : null;
      const target = privateValue ? readTarget(this.data.records.find(r => r.id === args.operation_id && this.key(r.actor) === key), readValue) : null;
      this.commit(d => {
        const row = d.records.find(r => r.id === args.operation_id && this.key(r.actor) === key);
        d.views[key + ':' + (args.view_id || 'default')] = clone(context.view);
        delete row.confirmation;
        Object.assign(row, { state, finishedAt: this.now(), ...(privateValue ? { readTarget: target, readState: row.readAuthorization ? 'pending' : 'consumed',
          ...(!row.readAuthorization ? { readConsumedAt: this.now() } : {}) } : value === undefined ? {} : { value: clone(value) }),
          ...(delivery ? { delivery } : {}), ...(error ? { error } : {}), ...(confirmation ? { confirmation } : {}) });
        if (refusal) { Object.assign(row, refusal); if (!approved) compactRefusal(row); }
      });
      const result = await this.finishAudit(actor, args.operation_id, context);
      if (result.state === 'confirmation-required' && result.confirmation?.kind === 'message' && !Object.hasOwn(result, 'confirmationNotifiedAt') && this.confirmationPending) {
        const notified = this.data.records.find(r => r.id !== result.id && this.key(r.actor) === key && r.state === 'confirmation-required' &&
          Object.hasOwn(r, 'confirmationNotifiedAt') && isDeepStrictEqual({ ...r.command, operation_id: args.operation_id }, args) && isDeepStrictEqual(r.guard, result.guard));
        // Explicit operation IDs stay independent; a matching pending cohort
        // shares one system notification until every request has been handled.
        this.commit(d => { d.records.find(r => r.id === result.id && this.key(r.actor) === key).confirmationNotifiedAt = notified?.confirmationNotifiedAt ?? this.now(); });
        if (!notified) try { await this.confirmationPending(this.receipt(actor, result.id)); } catch { /* The durable confirmation remains available. */ }
      }
      if (privateValue && result.state === 'complete') {
        if (result.readAuthorization) this.rememberRead(actor, args.operation_id, readValue);
        else return { ...this.project({ ...this.receipt(actor, args.operation_id), value: readValue }, context), retry: false };
      }
      if (privateValue && result.state !== 'complete') this.commit(d => {
        const r = d.records.find(r => r.id === args.operation_id && this.key(r.actor) === key); r.readState = 'expired'; r.readReason = 'audit-failed';
      });
      return { ...this.receipt(actor, args.operation_id, context), retry: false };
  }
  async decide(sessionId, nativeId, id, response) {
    const row = this.data.records.find(r => r.actor.id === sessionId && r.actor.nativeId === nativeId && r.id === id);
    if (!row || row.state !== 'confirmation-required' || row.confirmation?.kind !== 'message' || !Array.isArray(row.confirmation.options.buttons) ||
        !Number.isSafeInteger(response) || response < 0 || response >= row.confirmation.options.buttons.length || this.inflight.has(this.key(row.actor))) throw Error('This confirmation is no longer current');
    return this.exclusive(row.actor, async () => {
    const context = await this.view(row.actor, row.command.view_id);
    try { await context.checkActor(); }
    catch (error) {
      this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(row.actor));
        delete r.confirmation;
        Object.assign(r, { state: 'unconfirmed', error: String(error.message).slice(0, 2048), finishedAt: this.now() }); });
      return this.finishAudit(row.actor, id, context);
    }
    const current = this.receipt(row.actor, id);
    if (!current || current.state !== 'confirmation-required' || !isDeepStrictEqual(current.confirmation, row.confirmation)) throw Error('This confirmation was already handled');
    if (response === (row.confirmation.options.cancelId ?? 0)) {
      this.commit(d => { const r = d.records.find(r => r.id === id && r.actor.id === sessionId && r.actor.nativeId === nativeId); Object.assign(r, { state: 'cancelled', humanDecision: response, finishedAt: this.now() }); });
      return this.finishAudit(row.actor, id, context);
    }
    this.commit(d => { const r = d.records.find(r => r.id === id && r.actor.id === sessionId && r.actor.nativeId === nativeId); Object.assign(r, { state: 'running', humanDecision: response, humanDecisionAt: this.now() }); });
    return this.perform(row.actor, row.command, context, () => context.checkActor(), { operationId: id, confirmation: row.confirmation, response });
    });
  }
  rows(sessionId) {
    return this.data.records.filter(r => r.actor.id === sessionId).map(r => ({ id: `background:${r.actor.nativeId}:${r.id}`, role: 'system', kind: 'background-operation',
      name: operation.visibleText(r.actor.name), time: r.at, status: ['running', 'awaiting-native'].includes(r.state) ? 'working' : ['complete', 'received', 'cancelled'].includes(r.state) ? 'complete' : 'error',
      text: operation.visibleText(`${r.actor.name} · ${r.command.method}\n${JSON.stringify(r.command.arguments)}\n${({ running: '正在执行', complete: '操作已执行', received: '原生会话已收到', 'awaiting-native': '已提交，原生收件待确认', 'confirmation-required': '等待你的确认', cancelled: '已取消，未执行', unconfirmed: '结果未确认' })[r.state] || r.state}${r.error ? `: ${r.error}` : ''}`),
      backgroundOperation: { id: r.id, sessionId: r.actor.id, nativeId: r.actor.nativeId, state: r.state,
        confirmation: r.confirmation ? { ...r.confirmation, options: visibleOptions(r.confirmation.options) } : null,
        resultNotice: r.command.method === 'restoreSession' && r.value?.placement === 'unavailable' ? r.value.uiMessage : null } }));
  }
  async close() {
    this.closed = true;
    this.readCopies.clear(); this.readBytes = 0;
    // Close our connections first so a queued native wait cannot hold GUI quit.
    // The native session and any input already accepted by it remain untouched.
    const contexts = await Promise.allSettled([...this.contexts.values()]);
    for (const item of contexts) if (item.status === 'fulfilled') {
      const c = item.value; c.client.close(); if (!c.win.isDestroyed?.()) c.win.destroy();
    }
    this.contexts.clear(); await Promise.allSettled([...this.inflight.values()]); this.readCopies.clear(); this.readBytes = 0;
  }
}
function visibleOptions(options) {
  if (!options || typeof options !== 'object') return options;
  options = { ...options };
  for (const key of ['title', 'message', 'detail']) if (typeof options[key] === 'string') options[key] = operation.visibleText(options[key]);
  if (Array.isArray(options.buttons)) options.buttons = Array.from(options.buttons, text => operation.visibleText(text));
  return options;
}
function dialog(context, kind, options, nativeDialog) {
  if (!context.background) return nativeDialog(context.win, options);
  options = visibleOptions(options);
  const request = operation.request();
  if (!request || request.context !== context) throw Error('Background dialog has no originating operation');
  if (request.approved?.operationId === request.actor.operationId && isDeepStrictEqual(request.approved.confirmation, { kind, options }) && request.dialogIndex++ === 0)
    return Promise.resolve({ response: request.approved.response });
  if (kind === 'open' || kind === 'save') {
    const paths = request.args.paths;
    if (!paths?.length || (kind === 'save' || !options.properties?.includes('multiSelections')) && paths.length !== 1) throw new ConfirmationRequired({ kind, options });
    if (kind === 'open') for (const selected of paths) {
      const st = fs.statSync(selected);
      if (options.properties?.includes('openDirectory') ? !st.isDirectory() : !st.isFile()) throw Error('Explicit file selection has the wrong type');
    }
    return Promise.resolve(kind === 'save' ? { canceled: false, filePath: paths[0] } : { canceled: false, filePaths: [...paths] });
  }
  throw new ConfirmationRequired({ kind, options });
}
module.exports = { BackgroundControl, ConfirmationRequired, validate, tool, dialog };
