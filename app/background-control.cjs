// Application commands share the GUI's handlers. This module has no desktop,
// browser debugger, provider connection, synthetic keyboard or permission API.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const operation = require('./background-operation.cjs');
const { roomId: validRoomId, roomIds } = require('./collaboration-spaces.cjs');
const history = require('./record-history.cjs');
const clone = v => JSON.parse(JSON.stringify(v));
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
// Records kept whole (the person, 2026-11-11: 「全保留，然后切分成小块（比如按天保持）」). A record that has settled (it
// ended more than a day ago and nothing about it is still pending) moves from the state file, rewritten on every
// change, into the day's block under history/operations, which is only added to. Every record stays loaded, so
// receipts, repeated operation ids, the conversation rows and an earlier cancellation work as before. The state
// file is version 2: an older version refuses it (its background control is then unavailable) rather than starting
// empty and running an operation id again.
const STATE_VERSION = 2, SETTLE_MS = 24 * 3600 * 1000;
// An agent's background window unused this long is closed, looked for this often; its next call opens another.
const RETIRE_AFTER = 5 * 60 * 1000, RETIRE_EVERY = 60 * 1000;
const settledStates = new Set(['complete', 'received', 'awaiting-native', 'cancelled', 'not-executed', 'unconfirmed']);
const recordTime = r => Number.isSafeInteger(r.finishedAt) ? r.finishedAt : r.at;
const checkArchived = r => { if (!r || !token(r.id) || !r.actor || !token(r.actor.id) || !r.command || !token(r.state)) throw Error('Invalid archived operation'); };
const MAX_PENDING_PER_ACTOR = 32, MAX_PENDING = 128;
// Person-approved 2026-11-15: one policy point for new and retained pending cards.
const CONFIRMATION_TTL_MS = Object.freeze({ input: 2 * 60 * 1000, other: 10 * 60 * 1000 });
const confirmationExpiresAt = row => Number.isSafeInteger(row?.at) && row.at >= 0 ? row.at + (row.command?.method === 'input' ? CONFIRMATION_TTL_MS.input : CONFIRMATION_TTL_MS.other) : null;
const REFUSAL_WINDOW_MS = 60000, MAX_REFUSAL_SUMMARIES = 128, NOTIFY_SHARE_MS = 60000;
const REFUSAL_RETRY_HINT = 'invoke or snapshot: new operation_id or compacted refused ID is a fresh request.';
const refusalRetry = () => ({ retryWithNewOperationId: true, retryHint: REFUSAL_RETRY_HINT });
const admissionReasons = new Set(['confirmation-limit', 'originating-session-unavailable']);
// Fixed branch names only: backend errors can contain another session's text or paths.
const validOriginCheck = value => typeof value === 'string' && /^(?:(?:admission|confirmation)-(?:roster|missing|native-id|archived|context-pending)|confirmation-(?:refresh|native-call|closed|fingerprint))$/.test(value);
const preconditionReasons = new Set(['invalid-file-path-count', 'file-preview-changed', 'conversation-access-denied', 'space-file-membership-required', 'conversation-target-unavailable']);
const summarizedReasons = new Set([...admissionReasons, 'another-operation-running', 'explicit-paths-required', ...preconditionReasons]);
const positiveCount = n => Number.isSafeInteger(n) && n > 0;
const nextCount = n => { if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER) throw Error('Refusal counter is exhausted'); return n + 1; };
const terminalReads = new Set(['terminalSnapshot', 'observe', 'terminal']);
// What these return goes back in the same answer and is never kept in the durable operation log. stewardEvents is the
// butler's read of queue text, deliveries and failure reasons (main.cjs).
const privateReads = new Set(['initial', 'previewImage', 'expandImage', 'stewardEvents', ...terminalReads]);
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
// What goes back to the agent that called (main.cjs, at the outbox edge). `guard` is NAW's own copy of what was
// shown and of every target session, kept to bind a confirmation, deliver and route the audit; the agent never needs
// it, and it was most of the larger answers (queue 794d3cd7, measured on the person's 173 records on 2026-11-14: the
// 20 with a guard over 1 KB went from 9.3 KB median, 14.9 KB at most, to 1.1 KB and 1.2 KB). call() still returns it.
function agentReply(result) {
  const without = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'guard')) return value;
    const { guard: _guard, ...rest } = value; return rest;
  };
  const reply = without(result);
  return reply?.receipt && typeof reply.receipt === 'object' ? { ...reply, receipt: without(reply.receipt) } : reply;
}
function readTarget(record, value) {
  if (spaceFileRead(record.command)) return { roomId: record.command.arguments[0], fileId: record.command.arguments[1] };
  const source = record.command.arguments?.[0];
  const id = record.readAuthorization?.sessionId || (terminalReads.has(record.command.method) ? source : record.command.method === 'initial' ? source || value?.viewState?.selected || record.actor.id : source?.sessionId);
  if (typeof id !== 'string' || !id) return typeof source?.roomId === 'string' ? { roomId: source.roomId } : null;
  const session = value?.sessions?.find(s => s.id === id);
  let name = session?.name || (id === record.actor.id ? record.actor.name : null);
  if (!name) try { name = JSON.parse(record.confirmation?.options?.detail).references?.find(r => r.kind === 'session' && r.id === id)?.name; } catch { /* Legacy receipts may have no named reference. */ }
  // How far an approved read of another conversation went: how many of its messages it held, up to which one's time.
  const messages = record.readAuthorization?.sessionId === id && Array.isArray(session?.messages) ? session.messages : null;
  const through = messages?.findLast(m => Number.isSafeInteger(m?.time))?.time;
  return { sessionId: id, nativeId: record.readAuthorization?.nativeId || session?.nativeId || record.guard?.sessions?.find(s => s.id === id)?.nativeId || (id === record.actor.id ? record.actor.nativeId : null),
    ...(typeof name === 'string' ? { name: operation.visibleText(name) } : {}), ...(messages ? { messages: messages.length, ...(through !== undefined ? { through } : {}) } : {}) };
}
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
// Parameters use the existing application's names and order. All values still
// pass its normal validators. Snapshot supplies current native/turn identities.
const parameters = {
  initial: ['Selected foreign conversation requires confirmation; read the resulting operation receipt after approval. The designated butler in no space reads it without confirmation and gets it in the same answer.'], preflight: [], dataDirectory: [], retrySave: [], reconnect: [], connectionUpdates: [], quitService: [],
  interfaceSettings: ['action: describe|update', 'namespace: locale|client-ui-theme (update only)', 'patch (update only)', 'current revision from describe (update only)'],
  prepareInput: ['sessionId'], observe: ['sessionId'], unobserve: ['sessionId'], claim: ['sessionId', 'mode: chat|terminal'],
  backgroundWithdraw: ['operationId of your own pending confirmation; cancels without execution'],
  terminal: ['sessionId'], terminalSnapshot: ['sessionId'], input: ['sessionId', 'exact terminal input'], resize: ['sessionId', 'cols', 'rows'],
  interrupt: ['sessionId'], pause: [], approve: ['sessionId', 'requestId', 'decision: accept|decline|cancel'], answer: ['sessionId', 'requestId', 'answers'],
  wakePolicy: ['sessionId or null for global', 'enabled?'], operatorAction: ['sessionId', 'action', 'value?'],
  join: ['sessionId', 'join: boolean'], roomRename: ['name'], roomNotes: ['text', 'expectedRevision'], roomMemberOrder: ['change'],
  archiveSession: ['sessionId'], restoreSession: ['sessionId'], archiveRoom: [], restoreRoom: [],
  spaceCreate: ['name'], spaceMerge: ['action: preview|status|commit|recover|discard|undo', 'value'],
  spaceAction: ['roomId', 'action: join|rename|notes|memberOrder|archive|restore|stageImages|removeImage|acceptImages|removeFile|queueAdd|queueCancel|queueResolve|queueClaim|forward|queueShared|steerShared|run|pause|clearSharedHistory', 'queueAdd: [text, assignee or null]; only the person-designated secretary or the butler may add; queueCancel: the person or the butler, and a session for an item it added itself that is still queued (not yet sent); queueResolve: only the person or the butler; queueClaim: [itemId from initial rooms[].queue], a session already doing an item queued for it and not yet sent, so NAW does not send it again; NAW settles it by your reply when this turn ends; not while an item sent to you has not settled; other arguments in the corresponding command order'],
  queueSecretary: ['sessionId or null to revoke; person-only, agents cannot designate themselves'],
  stewardEvents: ['position from the last read (through), or null to read from the start; the designated butler only. Returns {events, through, more}: what NAW recorded since, oldest first, a few at a time; while more is true, read again from through'],
  stewardWake: ['on: true or false to turn waking on events on or off; omit it to see how it stands. The designated butler or the person only; off by default. While on, NAW sends the butler, once it is idle and at most once a minute, one 【NAW 事件】 message naming a position: read stewardEvents from that position'],
  spaceFiles: ['roomId', 'fileId?; omit to import the explicit paths'], gitWorktreePreview: ['selected repository path', 'nonce', 'relative path'],
  create: ['options: {provider,cwd,name,view?,gitWorktree?,skipPermissions?: true}', 'skipPermissions: true starts Claude with bypassPermissions, or Codex with approvalPolicy never and sandbox danger-full-access; omit for native permission defaults. False is not accepted. NAW human confirmation is still required.'], nativeHistory: ['options?'], importHistory: ['nativeId', 'options'],
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
const tool = { name: 'workspace_control', description: 'Operate NAW in the background without moving the desktop pointer or changing the human window. Discover commands with catalog, inspect the independent view with snapshot, invoke an exact existing application command, and read durable receipts. Native permissions and human confirmations remain required. Refused invoke and snapshot requests may be summarized; reusing a summarized refused ID is a new request through current admission and any required human confirmation. Executed, uncertain and human-cancelled IDs never replay. After execution and a successful audit, receipts may retain only audit routing and native target identities in guard; commands, IDs and results stay intact. Refused-ID receipt aliases retain at most 512 recent IDs, 128 per NAW session, while their summary remains; expired aliases return no receipt. Never resend an uncertain operation. This tool does not authorize new work.',
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
class PreconditionRefused extends Error {
  constructor(error, reason) {
    if (!preconditionReasons.has(reason)) throw Error('Invalid operation precondition reason');
    super(error.message); this.reason = reason;
  }
}
function refusalDetails(reason) {
  return { state: 'not-executed', reason, retry: false, ...(reason === 'originating-session-unavailable' ? {
    retryWithNewOperationId: true,
    retryHint: REFUSAL_RETRY_HINT,
  } : {}) };
}
// What a carried-out record keeps of its guard (the sessions' ids and native ids, and the audit spaces): enough
// to tell whether two cards asked about the same targets after one of them was answered.
const guardTargets = guard => guard && typeof guard === 'object' ? { auditRooms: guard.auditRooms ?? null,
  sessions: Array.isArray(guard.sessions) ? guard.sessions.map(s => [s?.id ?? null, s?.nativeId ?? null]) : null } : null;
const confirmedDecision = r => (!r.disposition || r.handlerStarted) && Number.isSafeInteger(r.humanDecision) && r.humanDecision !== (r.confirmation?.options?.cancelId ?? 0);
const compactRefusal = row => { row.guard = { auditRooms: row.guard?.auditRooms || ['shared'] }; };
// Input queued for a native session: answered once NAW recorded it, not when native took it.
const queuedDelivery = args => ['queue', 'queueShared'].includes(args.method === 'spaceAction' ? args.arguments?.[1] : args.method);
class BackgroundControl {
  constructor({ dataDir, handlers, context, confirmation, audit, confirmationPending, project = record => record, changed = () => {}, now = Date.now, readCopyBytes = MAX_RECORD_BYTES,
    retireAfter = RETIRE_AFTER, retireHold = () => false, unasked = () => false, standing = () => null, standingValid = () => false, stagedPollMs = 200, decided = () => {}, receiptRead = () => {}, confirmationFingerprint = null }) {
    if (!Number.isSafeInteger(readCopyBytes) || readCopyBytes < 1 || readCopyBytes > MAX_RECORD_BYTES) throw Error('Invalid read copy budget');
    this.file = path.join(dataDir, 'background-operations.json'); this.handlers = handlers; this.context = context; this.changed = changed; this.now = now;
    this.data = { version: STATE_VERSION, records: [], views: {}, refusals: [], refusalActors: {}, refusalReceipts: [] }; this.inflight = new Map(); this.contexts = new Map(); this.failed = false;
    // The person's answers by actor and operation, and the last one of each actor (see decide).
    this.decisions = new Map(); this.decisionTails = new Map();
    this.decisionsClosed = new Promise(resolve => { this.closeDecisions = resolve; });
    // Opened windows by view key with their agent, when each was last used, what a retired one hands to the next, calls under way.
    this.opened = new Map(); this.used = new Map(); this.kept = new Map(); this.busy = 0; this.retireAfter = retireAfter; this.retireHold = retireHold;
    // Queued deliveries whose operation has answered but whose native receipt is still awaited (they hold no slot).
    this.pendingDeliveries = new Set(); this.stagedPollMs = stagedPollMs;
    // Settled records, loaded whole: by session, and by the key a receipt or a repeated operation id is looked up with.
    this.archive = new history.BlockLog(dataDir, 'operations', checkArchived);
    try { this.loadHistory(); }
    catch (error) { this.failed = true; throw Error('The background operation history cannot be read; no operation is run', { cause: error }); }
    this.confirmation = confirmation; this.audit = audit;
    // Whether a read of another session's conversation runs without the person's confirmation: main.cjs answers yes
    // only for the designated butler in no space (the person, 2026-11-12 14:24). Its preconditions are still checked.
    this.unasked = unasked;
    this.standing = standing; this.standingValid = standingValid;
    this.confirmationPending = confirmationPending;
    this.confirmationFingerprint = confirmationFingerprint;
    // The person's answer on a card, once its outcome is recorded, and the agent reading a receipt itself: what main.cjs
    // tells the agent that asked (answer-notices.cjs). Neither can change an outcome.
    this.decided = decided; this.receiptRead = receiptRead;
    this.project = project;
    this.readCopies = new Map(); this.readBytes = 0; this.readCopyBytes = readCopyBytes;
    let st = null;
    try { st = fs.lstatSync(this.file); } catch (e) { if (e.code !== 'ENOENT') { this.failed = true; throw e; } }
    if (st) try {
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || st.mode & 0o077 || st.size > MAX_RECORD_BYTES) throw Error('Unsafe background operation record');
      const text = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(text);
      if (![1, STATE_VERSION].includes(this.data.version) || !Array.isArray(this.data.records) || this.data.records.some(r => !token(r.id) || !r.actor || !r.command || !token(r.state))) throw Error('Invalid background operation record');
      this.data.views ||= {};
      this.data.refusals ||= []; this.data.refusalActors ||= {}; this.data.refusalReceipts ||= [];
      const object = v => v && typeof v === 'object' && !Array.isArray(v);
      const counter = v => object(v) && token(v.id) && positiveCount(v.count) && object(v.rooms) && Object.entries(v.rooms).every(([id, r]) => validRoomId(id) && object(r) && positiveCount(r.count) && positiveCount(r.sequence) && token(r.lastMethod));
      if (!object(this.data.refusalActors) || Object.values(this.data.refusalActors).some(v => !object(v) || !positiveCount(v.sequence) || !Number.isSafeInteger(v.windowStart) || v.windowStart < 0 || !object(v.counts) || Object.entries(v.counts).some(([reason, c]) => !summarizedReasons.has(reason) || !counter(c))) ||
          !Array.isArray(this.data.refusals) || this.data.refusals.length > MAX_REFUSAL_SUMMARIES || this.data.refusals.some(r => !token(r.id) || !r.actor || r.state !== 'not-executed' || !r.command || !summarizedReasons.has(r.refusalSummary?.reason) || !counter(r.refusalSummary) || !this.data.refusalActors[this.key(r.actor)])) throw Error('Invalid refusal summaries');
      if (!Array.isArray(this.data.refusalReceipts) || this.data.refusalReceipts.length > 512 || this.data.refusalReceipts.some(a => !token(a.id) || !token(a.actor?.id) || !token(a.actor?.nativeId) || !['claude', 'codex'].includes(a.actor?.provider) || !token(a.summaryId) || !this.data.refusals.some(r => r.id === a.summaryId && this.key(r.actor) === this.key(a.actor)))) throw Error('Invalid refusal receipts');
      // The blocks must reach as far as the state file knows they did: a history folder moved away or shortened is not
      // an empty history, and an operation id in it must not run again.
      if (this.data.version === STATE_VERSION && (!Number.isSafeInteger(this.data.historyThrough ?? 0) || (this.data.historyThrough ?? 0) > history.lastSequence(this.archive.manifest)))
        throw Error('The background operation history cannot be read; it ends before what this record knows of', { cause: Object.assign(Error('History is shorter than recorded'), { code: 'HISTORY_SHORT' }) });
      // A record that reached its block before the state file was written again: the block's copy holds.
      this.data.records = this.data.records.filter(r => !this.archived.has(this.key(r.actor) + ':' + r.id));
      // An older version's file: its bytes are kept beside the blocks, then it becomes this version's state file,
      // its settled records moving to the blocks (one already there is kept as first recorded).
      if (this.data.version === 1) {
        this.keepLegacy(text); this.data.version = STATE_VERSION;
        const keys = [...this.data.records.map(r => this.key(r.actor) + ':' + r.id)];
        this.commit(() => {});
        const present = new Set([...this.archived.keys(), ...this.data.records.map(r => this.key(r.actor) + ':' + r.id)]);
        if (keys.some(key => !present.has(key))) { this.failed = true; throw Error('The background operation record could not be moved without loss'); }
      }
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
    } catch (e) { this.failed = true; throw e; }
    this.expirePending(); this.scheduleExpiry();
  }
  // Every settled record, and what deleted blocks held (operation ids that must never run again), read whole.
  loadHistory() {
    this.archived = new Map(); this.archivedBySession = new Map(); this.archivedIds = new Set(); this.deleted = new Map();
    for (const record of this.archive.load()) this.remember(record);
    for (const item of this.archive.kept()) {
      const key = this.key(item.actor) + ':' + item.id;
      if (!this.archived.has(key)) this.deleted.set(key, item);
      this.archivedIds.add(item.id);
    }
  }
  // Blocks the person exported and NAW checked, deleted at the person's word. What each held is kept without its
  // contents: who asked, the operation id, when and how it ended. Such an id is never run again.
  deleteBlocks(names) {
    if (this.failed || this.closed) throw Error('Background operation storage is unavailable');
    const keep = r => ({ id: r.id, actor: { id: r.actor.id, nativeId: r.actor.nativeId, provider: r.actor.provider }, at: r.at, state: r.state });
    try { this.archive.delete(names, keep, this.now()); }
    catch (error) {
      // Refused before anything was written: nothing changed, and background control goes on.
      if (error.code === 'REFUSED') throw error;
      this.failed = true; throw Error('The background operation history could not be changed; no operation is run', { cause: error });
    }
    try { this.loadHistory(); }
    catch (error) { this.failed = true; throw Error('The background operation history could not be changed; no operation is run', { cause: error }); }
    this.changed();
  }
  // An operation id whose record the person deleted: never run again, and said so.
  deletedReply(sender, id) {
    const gone = this.deleted.get(this.key(sender) + ':' + id);
    // The outcome it had when it was deleted: a refusal-like "not-executed" would invite running it again under a new id.
    return gone ? { id, state: gone.state, reason: 'record-deleted', deletedAt: gone.deletedAt, at: gone.at, retry: false,
      error: 'This operation was recorded with the state given; its record was exported and then deleted by the person. It is not run again.' } : null;
  }
  // A settled record held in memory; a later version of the same record replaces it.
  remember(record) {
    const key = this.key(record.actor) + ':' + record.id, prior = this.archived.get(key);
    this.archived.set(key, record); this.archivedIds.add(record.id);
    const rows = this.archivedBySession.get(record.actor.id) || [];
    if (prior) rows[rows.indexOf(prior)] = record; else rows.push(record);
    this.archivedBySession.set(record.actor.id, rows);
  }
  // A settled record that changes later (a send confirmed on a later receipt) is added to its block again.
  reappend(record) {
    if (this.failed) throw Error('Background operation storage is unavailable');
    try { this.archive.append([{ time: recordTime(record), value: record }], this.now()); }
    catch (error) { this.failed = true; throw Error('Background operation save is unconfirmed; no automatic replay', { cause: error }); }
    this.remember(record); this.changed();
  }
  // The older version's file kept as it was, beside the blocks (not read again).
  keepLegacy(text) {
    const store = history.ensureDirectory(history.ensureDirectory(path.dirname(this.file), history.HISTORY_DIR), 'operations'), bytes = Buffer.from(text);
    const digest = history.sha256().update(bytes).digest('hex');
    for (let n = 1; n < 10000; n++) {
      const name = `legacy-${String(n).padStart(4, '0')}.json`, target = path.join(store, name);
      let present = null; try { present = fs.readFileSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present) { if (history.sha256().update(present).digest('hex') === digest) return; continue; }
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target); history.syncDirectory(store); return;
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    throw Error('No place for the older background operation record');
  }
  commit(change) {
    const signature = records => records.filter(r => r.confirmation || r.confirmationRequestedAt != null || r.humanDecision != null)
      .map(r => [this.key(r.actor), r.id, r.state, r.disposition, r.reason, r.confirmation, r.confirmationSummary, r.humanDecision]);
    const before = signature(this.data.records);
    if (this.failed) throw Error('Background operation storage is unavailable');
    const next = clone(this.data); change(next);
    next.refusals = operation.retainRefusalRows(next.refusals, 128, 32);
    // Rewrite obsolete hints without adding fields to old, potentially full
    // files. New summaries already carry the same hint as their direct reply.
    for (const row of next.refusals) if (Object.hasOwn(row, 'retryHint')) row.retryHint = REFUSAL_RETRY_HINT;
    const summaries = new Set(next.refusals.map(r => this.key(r.actor) + ':' + r.id));
    const exact = new Set(next.records.map(r => this.key(r.actor) + ':' + r.id));
    next.refusalReceipts = operation.retainRefusalRows(next.refusalReceipts.filter(a => summaries.has(this.key(a.actor) + ':' + a.summaryId) && !exact.has(this.key(a.actor) + ':' + a.id) && !this.archived.has(this.key(a.actor) + ':' + a.id)), 512, 128);
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
    // Settled records go to their block first, synced; only then does the state file stop holding them.
    const now = this.now(), moving = next.records.filter(r => settledStates.has(r.state) && !['available', 'pending'].includes(r.readState) &&
      Number.isSafeInteger(recordTime(r)) && recordTime(r) < now - SETTLE_MS);
    // (A state record never shares an id with a settled one: loading drops such a copy, and a repeated id is a duplicate.)
    if (moving.length) {
      try { this.archive.append(moving.map(r => ({ time: recordTime(r), value: r })), now); }
      catch (error) { this.failed = true; throw Error('Background operation save is unconfirmed; no automatic replay', { cause: error }); }
      for (const r of moving) this.remember(clone(r));
      next.records = next.records.filter(r => !moving.includes(r));
      // In their block now: they leave this run's state too, whatever happens to the rest of this save.
      const moved = new Set(moving.map(r => this.key(r.actor) + ':' + r.id));
      this.data = { ...this.data, records: this.data.records.filter(r => !moved.has(this.key(r.actor) + ':' + r.id)) };
    }
    // How far the history goes: a state file that knows of more than the blocks hold stops the next start.
    next.historyThrough = history.lastSequence(this.archive.manifest);
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw Error('Background operation record is full; existing records are retained');
    const temporary = `${this.file}.${randomUUID()}.tmp`; let renamed = false;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file); renamed = true;
      const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.data = next; this.scheduleExpiry(); this.changed({ confirmations: !isDeepStrictEqual(before, signature(next.records)) });
    } catch (error) {
      this.failed = true; if (!renamed) fs.rmSync(temporary, { force: true });
      throw Error('Background operation save is unconfirmed; no automatic replay', { cause: error });
    }
  }
  settlementFields(row, disposition, reason) {
    // A follow-up question can be reached after effects. Only its remaining work is cancelled.
    return { state: row.handlerStarted ? 'unconfirmed' : disposition === 'withdrawn' ? 'cancelled' : 'not-executed', disposition, reason,
      stateUiMessage: { key: 'background.card.' + disposition + (row.handlerStarted ? 'AfterStart' : ''), params: {} },
      resultNotice: { key: row.handlerStarted ? 'background.card.reason.partial-operation' : 'background.card.reason.' + reason, params: {} }, finishedAt: this.now() };
  }
  settlePending(row, disposition, reason) {
    this.commit(data => {
      const current = data.records.find(r => this.key(r.actor) === this.key(row.actor) && r.id === row.id);
      if (!current || current.state !== 'confirmation-required') throw Error('This confirmation was already handled');
      Object.assign(current, this.settlementFields(current, disposition, reason));
    });
    return this.receipt(row.actor, row.id);
  }
  expired(row) { return row.state === 'confirmation-required' && confirmationExpiresAt(row) !== null && this.now() >= confirmationExpiresAt(row); }
  expiryFields(row) { return { ...this.settlementFields(row, 'expired', 'deadline-elapsed'), finishedAt: confirmationExpiresAt(row) }; }
  expirePending() {
    if (this.closed || this.failed) return;
    const now = this.now(), due = this.data.records.filter(r => r.state === 'confirmation-required' && !this.inflight.has(this.key(r.actor)) &&
      confirmationExpiresAt(r) !== null && now >= confirmationExpiresAt(r));
    if (!due.length) return;
    const keys = new Set(due.map(r => this.key(r.actor) + ':' + r.id));
    this.commit(data => { for (const row of data.records) if (keys.has(this.key(row.actor) + ':' + row.id)) {
      Object.assign(row, this.settlementFields(row, 'expired', 'deadline-elapsed'));
    } });
  }
  scheduleExpiry() {
    clearTimeout(this.expiryTimer); this.expiryTimer = null;
    if (this.closed || this.failed) return;
    const deadlines = this.data.records.filter(r => r.state === 'confirmation-required' && (!this.expired(r) || !this.inflight.has(this.key(r.actor)))).map(confirmationExpiresAt).filter(v => v !== null);
    if (!deadlines.length) return;
    this.expiryTimer = setTimeout(() => { try { this.expirePending(); } catch { /* The failed store blocks execution; stop its timer. */ } this.scheduleExpiry(); this.changed(); }, Math.max(1, Math.min(2147483647, Math.min(...deadlines) - this.now())));
    this.expiryTimer.unref?.();
  }
  terminalSnapshot(context) {
    try { return context.terminalConsentSnapshot?.() || context.client?.snapshot?.() || null; } catch { return null; }
  }
  async withdraw(actor, id, context) {
    const request = operation.request();
    if (!request || request.context !== context || request.args.method !== 'backgroundWithdraw' || this.key(request.actor) !== this.key(actor) || !token(id))
      throw require('./ui-errors.cjs').uiError('error.background.withdrawNotPending');
    // The enclosing perform owns this actor's slot, shared with human decide(). No await before mutation.
    const row = this.data.records.find(r => r.id === id && this.key(r.actor) === this.key(actor));
    if (!row || row.state !== 'confirmation-required') throw require('./ui-errors.cjs').uiError('error.background.withdrawNotPending');
    if (confirmationExpiresAt(row) !== null && this.now() >= confirmationExpiresAt(row)) return this.settlePending(row, 'expired', 'deadline-elapsed');
    return this.settlePending(row, 'withdrawn', 'withdrawn-by-originator');
  }
  key(sender) { return `${sender.provider}:${sender.id}:${sender.nativeId}`; }
  catalog() { return [...this.handlers.keys()].filter(name => !['backgroundDecision', 'uiReady'].includes(name)).sort().map(name => ({ method: name, parameters: parameters[name] || [],
    ...( ['chooseFolder', 'openLocalFile', 'saveLocalFile', 'runtimeLocation', 'spaceFiles'].includes(name) ? { fileSelection: 'Supply explicit absolute paths on the invocation; no desktop file picker is opened.' } : {}) })); }
  async view(sender, viewId = 'default') {
    if (this.closed) throw Error('Background control is closing');
    const key = this.key(sender) + ':' + viewId;
    if (viewId !== 'default' && !this.data.views[key]) throw Error('Independent view does not exist');
    // A window whose connection to a backend ended answers every call with 「本地服务未连接。」: nothing in it
    // reconnects, and while the agent keeps calling, retireIdle never finds it unused (E03, 2026-11-16). It is
    // replaced now under the same saved view and owner, unless something of this agent runs in it or waits on it.
    const open = this.opened.get(key);
    if (open && open.context.client?.socket?.destroyed && this.mayReplace(sender)) {
      try {
        this.retireWindow(key, open.context, false);
      } catch {
        // The window stays; this call fails in it as before, and the next one tries again.
      }
    }
    if (!this.contexts.has(key)) {
      const kept = this.kept.get(key); this.kept.delete(key);
      const opening = Promise.resolve(this.context(sender, this.data.views[key] && clone(this.data.views[key]), kept));
      this.contexts.set(key, opening);
      // A window that failed to open is not kept as failed: the agent's next call tries again.
      opening.then(context => { if (this.contexts.get(key) === opening) this.opened.set(key, { context, actor: sender }); },
        () => { if (this.contexts.get(key) === opening) this.contexts.delete(key); if (kept && !this.kept.has(key)) this.kept.set(key, kept); });
      // An error here must not reach the main process's event loop: the window simply stays.
      if (!this.sweeper) { this.sweeper = setInterval(() => { try { this.retireIdle(); } catch {} }, RETIRE_EVERY); this.sweeper.unref?.(); }
    }
    this.used.set(key, this.now());
    return this.contexts.get(key);
  }
  touch(sender) {
    if (!sender) return;
    const prefix = this.key(sender) + ':';
    for (const key of this.opened.keys()) if (key.startsWith(prefix)) this.used.set(key, this.now());
  }
  // Closes the background windows agents have not used for retireAfter, and soon after it ends or is replaced, the
  // windows of a native session. Only while nothing is in flight: no call here (counted from its first line), no
  // operation reserved, nothing in the outbox (retireHold), and no record of that agent running or waiting for the
  // person. Records and receipts live in this file, not in a window: the next call opens a window under the same
  // saved view and owner, and gets back what main.cjs kept of the old one (its private clipboard, an open preview).
  // Resolves { staged } once the recipient's record holds this operation's message waiting for native; stays
  // pending otherwise (the handler's own outcome then wins the race). Reads the window's current state only.
  watchStaged(actor, args, context, running) {
    const target = operation.deliveryTargets(args.method, args.arguments)?.[0];
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    return new Promise(resolve => {
      const look = () => {
        if (settled || this.closed) return;
        try {
          const session = context.client?.snapshot?.().sessions?.find(s => s.id === target);
          const message = session?.messages?.find(m => m.agentControl?.operationId === actor.operationId && m.agentControl?.id === actor.id && m.agentControl?.nativeId === actor.nativeId);
          if (message?.status === 'awaiting-native') {
            return resolve({ staged: { recipientId: session.id, nativeId: session.nativeId, messageId: message.id, nativeReceived: false, status: message.status, body: message.text } });
          }
        } catch { /* Looked at again shortly; the handler's own outcome still settles the operation. */ }
        const timer = setTimeout(look, this.stagedPollMs); timer.unref?.();
      };
      look();
    });
  }
  // Answers now with awaiting-native and settles the record when the handler ends: received, or as the ordinary
  // path would (unconfirmed on any failure). Nothing is sent again.
  async deferDelivery(actor, args, context, running, delivery) {
    const key = this.key(actor), id = args.operation_id, find = d => d.records.find(r => r.id === id && this.key(r.actor) === key);
    this.commit(d => {
      const row = find(d);
      d.views[key + ':' + (args.view_id || 'default')] = clone(context.view);
      delete row.confirmation;
      Object.assign(row, { state: 'awaiting-native', delivery, deferredAt: this.now() });
    });
    const guard = this.receipt(actor, id)?.guard;
    const unconfirmed = failure => ({ state: 'unconfirmed', error: typeof failure?.message === 'string' ? failure.message.slice(0, 2048) : 'Operation outcome is unconfirmed' });
    const pending = running.then(async value => {
      // As the ordinary path: a delivery that cannot be read leaves the outcome unconfirmed.
      try {
        const settled = await context.delivery?.(args, value, actor, guard);
        return { value, delivery: settled, state: settled ? settled.nativeReceived ? 'received' : 'awaiting-native' : 'complete' };
      } catch (failure) { return { value, ...unconfirmed(failure) }; }
    }, unconfirmed)
      .then(outcome => {
        try {
          this.commit(d => {
            const row = find(d); if (!row) return;
            Object.assign(row, { state: outcome.state, finishedAt: this.now(), ...(outcome.value === undefined ? {} : { value: clone(outcome.value) }),
              ...(outcome.delivery ? { delivery: outcome.delivery } : {}), ...(outcome.error ? { error: outcome.error } : {}) });
          });
          return this.finishAudit(actor, id, context);
        } catch { /* Closing, or the record could not be saved: the receipt keeps awaiting-native and is read again later. */ }
      })
      .catch(() => {})
      .finally(() => this.pendingDeliveries.delete(pending));
    this.pendingDeliveries.add(pending);
    await this.finishAudit(actor, id, context);
    return { ...this.receipt(actor, id, context), retry: false };
  }
  retireIdle() {
    // A queued delivery still waiting for its receipt keeps every window: closing one could revoke it.
    if (this.closed || this.busy || this.inflight.size || this.pendingDeliveries.size || this.retireHold()) return 0;
    const waiting = new Set(this.data.records.filter(r => ['running', 'confirmation-required'].includes(r.state)).map(r => this.key(r.actor)));
    let retired = 0;
    for (const [key, { context, actor }] of [...this.opened]) try {
      if (waiting.has(this.key(actor))) continue;
      let stale = false;
      try { const record = context.confirmationActors?.().find(s => s.id === actor.id); stale = !!context.confirmationActors && (!record || record.nativeId !== actor.nativeId || record.archived); } catch {}
      if (!stale && this.now() - (this.used.get(key) ?? 0) < this.retireAfter) continue;
      const outcome = this.retireWindow(key, context, stale);
      if (outcome === 'unsaved') return retired;
      if (outcome === 'retired') retired++;
    } catch {
      // This window stays, or its hidden window is left to app quit; the others are still looked at.
    }
    return retired;
  }
  // Closes one opened window: what it keeps goes to the next window of the same view, and retire() ends its
  // connections without counting as a change of control for the other windows. 'kept': refused, nothing closed.
  // 'unsaved': its view could not be saved, nothing closed.
  retireWindow(key, context, stale) {
    const kept = context.retain ? context.retain() : {};
    if (kept === null || typeof context.client?.retire !== 'function') return 'kept';
    // The view is saved first: an agent that only ever looked keeps its owner when the window comes back.
    if (!stale && context.view && !isDeepStrictEqual(this.data.views[key], context.view)) {
      try { this.commit(d => { d.views[key] = clone(context.view); }); } catch { return 'unsaved'; }
    }
    if (!context.client.retire()) return 'kept';
    this.contexts.delete(key); this.opened.delete(key); this.used.delete(key);
    if (!stale) this.kept.set(key, kept);
    try {
      if (!context.win?.isDestroyed?.()) context.win?.destroy?.();
    } catch {
      // Its hidden window is left to app quit.
    }
    return 'retired';
  }
  // retireIdle's protections, for one agent's window whose connection ended. Its busy and retireHold counts include
  // the asking call itself, so they would never let it go: no outbox call binds an ended window (existingTransports
  // skips it), and another call of this agent that holds the ended window fails in it either way.
  mayReplace(sender) {
    const key = this.key(sender);
    if (this.inflight.has(key) || this.pendingDeliveries.size) {
      return false;
    }
    return !this.data.records.some(r => ['running', 'confirmation-required'].includes(r.state) && this.key(r.actor) === key);
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
    let record = this.data.records.find(own) || this.archived.get(this.key(sender) + ':' + id) || this.data.refusals.find(own);
    if (!record && !exact) {
      const alias = this.data.refusalReceipts.find(own);
      if (alias) {
        record = this.data.refusals.find(r => r.id === alias.summaryId && this.key(r.actor) === this.key(sender));
        if (record && validOriginCheck(alias.originCheck)) record = { ...record, originCheck: alias.originCheck };
      }
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
      return this.receipt(actor, id);
    }
    // Only after the handler AND its audit succeeded can the consent snapshot
    // expire. Delivery still needs the original native identities. Keep every
    // command, result and ID, plus cancelled/pending/unknown guards, unchanged.
    const saved = this.data.records.find(r => r.id === id && this.key(r.actor) === this.key(actor)), guard = saved?.guard;
    if (['complete', 'received', 'awaiting-native'].includes(saved?.state) && guard && typeof guard === 'object' &&
        (!guard.sessions || Array.isArray(guard.sessions) && guard.sessions.every(s => s && typeof s === 'object'))) {
      const compact = { ...(guard.auditRooms ? { auditRooms: guard.auditRooms } : {}),
        ...(guard.sessions ? { sessions: guard.sessions.map(s => ({ id: s.id, nativeId: s.nativeId })) } : {}) };
      // An already empty ordinary guard is not worth another durable write.
      const empty = Object.keys(guard).every(k => ['auditRooms', 'sessions'].includes(k) || k === 'rooms' && Array.isArray(guard.rooms) && !guard.rooms.length) && isDeepStrictEqual(guard.sessions, compact.sessions);
      if (!empty && !isDeepStrictEqual(guard, compact)) this.commit(d => { d.records.find(r => r.id === id && this.key(r.actor) === this.key(actor)).guard = compact; });
    }
    return this.receipt(actor, id);
  }
  async recordRefusal(actor, args, context, reason, originCheck) {
    const diagnostic = reason === 'originating-session-unavailable' && validOriginCheck(originCheck) ? { originCheck } : {};
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
        do { id = 'refusal:' + randomUUID(); } while (id === args.operation_id || this.archivedIds.has(id) || [...d.records, ...d.refusals].some(r => r.id === id));
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
        { id: args.operation_id, actor: { id: actor.id, nativeId: actor.nativeId, provider: actor.provider }, summaryId: id, ...diagnostic }];
    });
    const summary = clone(this.data.refusals.find(r => r.id === id)); let auditError;
    try { await this.publish(summary, context); }
    catch {
      auditError = 'The refusal summary space event could not be saved';
      this.commit(d => { const row = d.refusals.find(r => r.id === id); if (row) row.auditError = 'The refusal summary space event could not be saved'; });
    }
    return { ...refusalDetails(reason), ...refusalRetry(),
      id: args.operation_id, actor, method: args.method,
      guard: { auditRooms: rooms }, summaryId: id, count: summary.refusalSummary.count, ...diagnostic,
      ...(auditError ? { auditError } : {}) };
  }
  confirmationRefusal(actor, args, context, guard, diagnostic = {}) {
    this.expirePending();
    const unavailable = cause => { diagnostic.cause = cause; return 'originating-session-unavailable'; };
    let sessions;
    try { sessions = typeof context.confirmationActors === 'function' ? context.confirmationActors() : guard?.sessions; }
    catch { return unavailable('roster'); }
    const requester = Array.isArray(sessions) && sessions.find(s => s.id === actor.id);
    if (!requester) return unavailable('missing');
    if (requester.nativeId !== actor.nativeId) return unavailable('native-id');
    if (requester.archived) return unavailable('archived');
    if (requester.nativeContextPending) return unavailable('context-pending');
    const key = this.key(actor), pending = this.data.records.filter(r =>
      !(r.id === args.operation_id && this.key(r.actor) === key) &&
      (r.state === 'confirmation-required' && !this.expired(r) && r.confirmation?.kind === 'message' || r.state === 'running' && operation.maintenanceAction(r.command.method, r.command.arguments, r.actor)) &&
      sessions.some(s => s.id === r.actor.id && s.nativeId === r.actor.nativeId && !s.archived && !s.nativeContextPending));
    return pending.length >= MAX_PENDING || pending.filter(r => this.key(r.actor) === key).length >= MAX_PENDING_PER_ACTOR ? 'confirmation-limit' : null;
  }
  async call(binding, input) {
    // Counted from the first line: no window is closed under a call, wherever the call is waiting.
    this.busy++;
    try { return await this.callHeld(binding, input); }
    finally { this.busy--; this.touch(binding?.sender); }
  }
  async callHeld(binding, input) {
    if (this.closed) throw Error('Background control is closing');
    let args = validate(input); const { sender, identity } = binding;
    const valid = async () => { await binding.refresh?.(); if (!binding.valid()) throw Error('The originating native call is no longer valid'); };
    await valid(); this.expirePending();
    if (args.action === 'catalog') return { state: 'complete', commands: this.catalog(), background: true };
    if (args.action === 'receipt') {
      const saved = this.receipt(sender, args.operation_id), gone = !saved && this.deletedReply(sender, args.operation_id);
      if (gone) return { state: 'complete', receipt: gone, retry: false };
      let context = null;
      if (saved) {
        context = await this.view(sender, saved.command.view_id);
        if (privateRead(saved.command)) { await context.refresh?.(); await valid(); }
        const delivery = await context.delivery?.(saved.command, saved.value, saved.actor, saved.guard);
        const archived = this.archived.get(this.key(sender) + ':' + saved.id);
        // A settled send is added again only when what is known about it changed: agents may ask often.
        const changedRecord = archived && delivery && { ...clone(archived), delivery, ...(delivery.nativeReceived ? { state: 'received' } : {}) };
        if (changedRecord && !isDeepStrictEqual(changedRecord, archived)) this.reappend(changedRecord);
        else if (delivery && !archived) this.commit(d => { const r = d.records.find(r => r.id === saved.id && this.key(r.actor) === this.key(sender)); r.delivery = delivery; if (delivery.nativeReceived) r.state = 'received'; });
      }
      const receipt = this.takeReceipt(sender, args.operation_id, context);
      if (receipt) try { this.receiptRead(clone(sender), args.operation_id); } catch { /* Only whether it is told again. */ }
      return { state: 'complete', receipt, retry: false };
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
      // Settled records of this view first, in the order they were made, then the state file's.
      const settledOwn = (this.archivedBySession.get(sender.id) || []).filter(sameView), records = settledOwn.length ?
        [...settledOwn, ...this.data.records].map((r, index) => ({ r, index })).sort((a, b) => (a.r.at - b.r.at) || (a.index - b.index)).map(item => item.r) : this.data.records;
      const changedSelection = records.findLastIndex(r => sameView(r) && r.state === 'complete' && r.command.method === 'viewState' &&
        Object.hasOwn(r.command.arguments?.[0] || {}, 'selected') && r.command.arguments[0].selected !== target);
      const guard = controlGuard(context, args);
      // A cancellation is the person's answer, not a request to prompt again.
      // Explicit IDs may ask again. Navigating away or changing the bound
      // consent target releases an implicit cancellation, including after restart.
      const previous = records.findLast((r, index) => sameView(r) &&
        (r.state === 'confirmation-required' || r.state === 'cancelled' && index > changedSelection) &&
        isDeepStrictEqual({ ...r.command, operation_id: args.operation_id }, args) && isDeepStrictEqual(r.guard, guard));
      if (previous) return { ...this.receipt(sender, previous.id), duplicate: true, retry: false };
    }
    // Receipt aliases explain compacted refusals; they never bind a new invoke.
    const duplicate = async existing => {
      if (!isDeepStrictEqual(existing.command, args)) throw Error('operation_id already belongs to a different command');
      await this.publish(existing, context);
      if (privateRead(args)) { await context.refresh?.(); await valid(); }
      return { ...this.takeReceipt(sender, args.operation_id, context), duplicate: true, retry: false };
    };
    const existing = this.receipt(sender, args.operation_id, null, true);
    if (existing) return duplicate(existing);
    const gone = this.deletedReply(sender, args.operation_id);
    if (gone) return { ...gone, duplicate: true };
    const handler = !['backgroundDecision', 'uiReady'].includes(args.method) && this.handlers.get(args.method);
    const key = this.key(sender);
    const actor = operation.actor({ ...sender, callId: identity.callId, turnId: identity.turnId, operationId: args.operation_id });
    const refuse = (reason, originCheck) => {
      if (admissionReasons.has(reason) || reason === 'another-operation-running' && operation.maintenanceAction(args.method, args.arguments, actor)) return this.recordRefusal(actor, args, context, reason, originCheck);
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
    // Another call may have bound this ID while refresh was awaiting. Never
    // summarize or replace its intent, including when its handler is running.
    const refreshed = this.receipt(sender, args.operation_id, null, true);
    if (refreshed) return duplicate(refreshed);
    const goneSince = this.deletedReply(sender, args.operation_id);
    if (goneSince) return { ...goneSince, duplicate: true };
    if (this.inflight.has(key)) return refuse('another-operation-running');
    const guard = controlGuard(context, args);
    if (operation.maintenanceAction(args.method, args.arguments, actor)) {
      const diagnostic = {}, reason = this.confirmationRefusal(actor, args, context, guard, diagnostic);
      if (reason) return refuse(reason, diagnostic.cause && 'admission-' + diagnostic.cause);
    }
    // The real folder handler's first action is this single-path open dialog.
    // Refuse before entering it; arbitrary handlers may have effects before a
    // selector, so their selector errors must retain their original records.
    if (args.method === 'chooseFolder' && args.paths?.length !== 1) return this.recordRefusal(actor, args, context, 'explicit-paths-required');
    // Save intent before calling ANY mutation, including an independent draft.
    this.commit(d => d.records.push({ id: args.operation_id, actor, command: args, guard, ...(args.method === 'input' ? { terminalConsent: operation.terminalInputProof(this.terminalSnapshot(context)?.sessions?.find(s => s.id === args.arguments[0])) } : {}), state: 'running', at: this.now() }));
    return this.execute(actor, args, context, valid);
  }
  exclusive(actor, work) {
    const key = this.key(actor);
    if (this.closed || this.inflight.has(key)) throw Error('Another operation is running or background control is closing');
    // Reserve synchronously, before context lookup, identity refresh or prompts.
    const job = Promise.resolve().then(work);
    this.inflight.set(key, job);
    return job.finally(() => { if (this.inflight.get(key) === job) this.inflight.delete(key); this.expirePending(); this.scheduleExpiry(); });
  }
  execute(actor, args, context, valid, approved) {
    return this.exclusive(actor, () => this.perform(actor, args, context, valid, approved));
  }
  async perform(actor, args, context, valid, approved) {
    const key = this.key(actor), handler = this.handlers.get(args.method);
    const checkDeadline = () => { if (approved && this.now() >= approved.expiresAt) throw require('./ui-errors.cjs').uiError('error.background.confirmationExpired'); };
      let state, value, error, confirmation, delivery, refusal, originCheck, preconditionError, standingFailure, disposition, reason, handlerEntered = false;
      try {
        await valid();
        checkDeadline();
        if (this.closed) throw Error('Background control is closing');
        const row = this.receipt(actor, args.operation_id);
        if (row.guard && !isDeepStrictEqual(row.guard, controlGuard(context, args))) throw Error('The operation target changed before execution');
        const request = { context, args, actor, guard: row.guard, valid, approved, dialogIndex: 0 };
        const running = operation.run(actor, async () => {
          const action = operation.maintenanceAction(args.method, args.arguments, actor);
          let terminalTarget = null;
          if (action) {
            if (typeof this.confirmation !== 'function' || typeof this.audit !== 'function') throw Error('Human maintenance confirmation or event storage is unavailable');
            let options;
            try { options = this.confirmation(actor, args, action, context); }
            catch (error) {
              if (error instanceof PreconditionRefused && !row.handlerStarted) preconditionError = error;
              throw error;
            }
            // A read the person already answered keeps that answer: it is theirs, released as an approved read.
            const unasked = !approved && action === 'readConversation' && this.unasked(actor, args, action, context) === true;
            let standing = null;
            try { if (!approved && !unasked) standing = this.standing(actor, args, context); }
            catch (failure) {
              // Reserving standing usage precedes the handler. A prior handler's
              // possible effects must never acquire a safe-to-retry receipt.
              if (!row.handlerStarted) standingFailure = { value: failure };
              throw failure;
            }
            if (!unasked && !standing) {
              const answer = await dialog(context, 'message', options);
              if (answer.response !== 1) return { cancelled: true };
            }
            request.maintenanceApproved = true;
            // Marked on the record itself: its audit line and the read's release say it was not confirmed by the person.
            if (unasked) this.commit(data => { data.records.find(r => r.id === row.id && this.key(r.actor) === key).unasked = true; });
            if (standing) this.commit(data => { Object.assign(data.records.find(r => r.id === row.id && this.key(r.actor) === key), { approvedBy: 'standing', standing }); });
            // If the event writer is broken, fail before an approved mutation.
            await this.publish({ ...row, state: 'running', ...(unasked ? { unasked: true } : {}), ...(standing ? { approvedBy: 'standing', standing } : {}) }, context);
            if (standing) {
              await context.refresh?.(); await valid();
              if (!this.standingValid(actor, args, context, standing) || !isDeepStrictEqual(row.guard, controlGuard(context, args))) throw Error('Standing permission or operation target changed before execution');
            }
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
          checkDeadline();
          approved?.authorize?.();
          handlerEntered = true;
          if (!terminalTarget) return handler(context, ...args.arguments);
          const result = await handler(context, ...args.arguments), frozen = result === undefined ? undefined : clone(result);
          await context.refresh?.(); await valid();
          const current = context.client.snapshot().sessions.find(s => s.id === terminalTarget.id);
          if (!current || current.nativeId !== terminalTarget.nativeId) throw Error('The approved terminal target changed before the read completed');
          return frozen;
        }, request);
        // A queued message waits for its native receipt, possibly for a whole turn. Once NAW has recorded it,
        // the operation answers awaiting-native and frees its agent's slot; the receipt is settled later.
        const staged = queuedDelivery(args) ? this.watchStaged(actor, args, context, running) : null;
        const first = staged ? await Promise.race([running.then(result => ({ result }), failure => ({ failure })), staged]) : null;
        if (first?.staged) return this.deferDelivery(actor, args, context, running, first.staged);
        if (first && 'failure' in first) throw first.failure;
        value = first ? first.result : await running;
        delivery = await context.delivery?.(args, value, actor, row.guard);
        state = delivery ? delivery.nativeReceived ? 'received' : 'awaiting-native' : 'complete';
      } catch (e) {
        if (approved && ['error.background.confirmationExpired', 'error.background.terminalInvalidated', 'error.background.terminalUnverifiable'].includes(e.uiMessage?.key)) {
          const unknown = e.uiMessage.key === 'error.background.terminalUnverifiable';
          disposition = unknown ? undefined : e.uiMessage.key === 'error.background.confirmationExpired' ? 'expired' : 'invalidated';
          reason = unknown ? 'temporarily-unavailable' : disposition === 'expired' ? 'deadline-elapsed' : 'state-changed';
          state = unknown ? 'confirmation-required' : 'not-executed'; confirmation = unknown ? approved.confirmation : undefined;
        }
        else if (standingFailure && Object.is(e, standingFailure.value) && !handlerEntered) {
          refusal = { ...refusalDetails('standing-authorization-unavailable'), retryWithNewOperationId: true,
            retryHint: 'The operation did not execute. Retry with a new operation_id.' };
          state = refusal.state; error = typeof e?.message === 'string' ? e.message.slice(0, 2048) : 'The operation did not execute.';
        }
        else if (preconditionError && e === preconditionError) { refusal = refusalDetails(e.reason); state = refusal.state; error = e.message.slice(0, 2048); }
        else if (e instanceof ConfirmationRequired && e.confirmation?.kind === 'message') {
          // Refresh first; the quota decision and pending-row commit below have
          // no await between them. Concurrent actors cannot both take slot128.
          let checking = 'refresh';
          try {
            await context.refresh?.(); checking = 'native-call'; await valid();
            checking = 'closed';
            if (this.closed) throw Error('Background control is closing');
            checking = 'fingerprint';
            const guard = controlGuard(context, args), diagnostic = {};
            checking = 'roster';
            const reason = this.confirmationRefusal(actor, args, context, guard, diagnostic);
            if (reason) { refusal = refusalDetails(reason); state = refusal.state; originCheck = diagnostic.cause && 'confirmation-' + diagnostic.cause; }
            else { state = 'confirmation-required'; confirmation = e.confirmation; }
          } catch (refreshError) {
            refusal = refusalDetails('originating-session-unavailable'); state = refusal.state;
            originCheck = 'confirmation-' + checking;
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
      if (refusal && approved && !preconditionError) {
        refusal = { state: 'unconfirmed', reason: 'follow-up-confirmation-refused', confirmationRefusal: refusal.reason, retry: false };
        state = 'unconfirmed'; error = 'A follow-up confirmation was refused after approval; inspect the original operation and do not repeat it.';
      }
      if (refusal && (admissionReasons.has(refusal.reason) || preconditionError && !approved)) {
        const result = await this.recordRefusal(actor, args, context, refusal.reason, originCheck);
        return { ...result, ...(preconditionError ? { error } : {}) };
      }
      const privateValue = value !== undefined && privateRead(args), readValue = privateValue ? clone(value) : null;
      const target = privateValue ? readTarget(this.data.records.find(r => r.id === args.operation_id && this.key(r.actor) === key), readValue) : null;
      this.commit(d => {
        const row = d.records.find(r => r.id === args.operation_id && this.key(r.actor) === key);
        d.views[key + ':' + (args.view_id || 'default')] = clone(context.view);
        delete row.confirmation;
        if (confirmation?.kind === 'message') {
          row.confirmationRequestedAt ??= this.now();
          row.confirmationTitle = operation.visibleText(confirmation.options?.message || '');
          row.confirmationSummary = operation.operationSummary(args, actor, this.terminalSnapshot(context) || {});
        }
        // Only a resumable handler needs this marker. A later approval cannot
        // claim non-execution if an earlier handler may already have had effects.
        if (handlerEntered && state === 'confirmation-required') row.handlerStarted = true;
        Object.assign(row, { state, ...(reason ? { reason, resultNotice: { key: 'background.card.reason.' + reason, params: {} } } : {}), ...(disposition ? this.settlementFields(row, disposition, reason) : {}), finishedAt: this.now(), ...(privateValue ? { readTarget: target, readState: row.readAuthorization ? 'pending' : 'consumed',
          ...(!row.readAuthorization ? { readConsumedAt: this.now() } : {}) } : value === undefined ? {} : { value: clone(value) }),
          ...(delivery ? { delivery } : {}), ...(error ? { error } : {}), ...(confirmation ? { confirmation } : {}) });
        if (refusal) { Object.assign(row, refusal); if (!approved || preconditionError) compactRefusal(row); }
      });
      const result = await this.finishAudit(actor, args.operation_id, context);
      if (result.state === 'confirmation-required' && result.confirmation?.kind === 'message' && !Object.hasOwn(result, 'confirmationNotifiedAt') && this.confirmationPending) {
        const now = this.now(), notified = this.data.records.find(r => r.id !== result.id && this.key(r.actor) === key && r.state === 'confirmation-required' &&
          Object.hasOwn(r, 'confirmationNotifiedAt') && now >= r.confirmationNotifiedAt && now - r.confirmationNotifiedAt < NOTIFY_SHARE_MS &&
          isDeepStrictEqual({ ...r.command, operation_id: args.operation_id }, args) && isDeepStrictEqual(r.guard, result.guard));
        // Explicit operation IDs stay independent. A matching request sent within
        // a minute of a notification shares it; one sent again later, while the
        // earlier card still waits, means the person missed it and is told again
        // (as is one after the clock went back: in doubt, tell).
        this.commit(d => { d.records.find(r => r.id === result.id && this.key(r.actor) === key).confirmationNotifiedAt = notified?.confirmationNotifiedAt ?? now; });
        if (!notified) try { await this.confirmationPending(this.receipt(actor, result.id)); } catch { /* The durable confirmation remains available. */ }
      }
      if (privateValue && result.state === 'complete') {
        if (result.readAuthorization) {
          this.rememberRead(actor, args.operation_id, readValue);
          // Nobody is waited for: what was read goes back in this same answer, taken as a receipt would take it.
          if (result.unasked === true) return { ...this.takeReceipt(actor, args.operation_id, context), retry: false };
        }
        else return { ...this.project({ ...this.receipt(actor, args.operation_id), value: readValue }, context), retry: false };
      }
      if (privateValue && result.state !== 'complete') this.commit(d => {
        const r = d.records.find(r => r.id === args.operation_id && this.key(r.actor) === key); r.readState = 'expired'; r.readReason = 'audit-failed';
      });
      return { ...this.receipt(actor, args.operation_id, context), retry: false };
  }
  mobileBinding(sessionId, nativeId, id, response, running = false) {
    const row = this.data.records.find(r => r.actor.id === sessionId && r.actor.nativeId === nativeId && r.id === id);
    if (!row || !['confirmation-required', ...(running ? ['running'] : [])].includes(row.state) || row.confirmation?.kind !== 'message' ||
        row.confirmation.options?.buttons?.length !== 2 || (row.confirmation.options.cancelId ?? 0) !== 0 || ![0, 1].includes(response) || this.closed || this.failed || this.expired(row) || this.replacement(row)) throw Error('This mobile confirmation is no longer current');
    const options = visibleOptions(row.confirmation.options);
    if (typeof options.message !== 'string' || !options.message.trim() || options.message.length > 2000 ||
        options.detail !== undefined && (typeof options.detail !== 'string' || options.detail.length > 16000)) throw Error('Read the complete confirmation on the Mac');
    return { sessionId, nativeId, operationId: id, decision: response, expiresAt: confirmationExpiresAt(row), presentation: digest([options.message || '', options.detail || '']),
      version: digest({ at: row.at, actor: row.actor, command: row.command, confirmation: row.confirmation, guard: row.guard, terminalConsent: row.terminalConsent }) };
  }
  // The person's answers to one agent's cards are carried out one at a time, in the order given. An answer given while
  // another operation of that agent runs is accepted and waits for it; it then goes through every check of carryOut, at
  // that time (expiry included), exactly as if it had been clicked then. The wait is held in memory only: if background
  // control closes first, the card is still waiting for the person and nothing was carried out.
  async decide(sessionId, nativeId, id, response, authorize) {
    if (this.closed) throw Error('Background control is closing');
    if (authorize !== undefined && typeof authorize !== 'function') throw Error('Invalid confirmation authority');
    authorize?.();
    const row = this.data.records.find(r => r.actor.id === sessionId && r.actor.nativeId === nativeId && r.id === id);
    const key = row && this.key(row.actor), slot = key + ':' + id, known = row && this.decisions.get(slot);
    // A second click on an answer that waits or runs is that same answer: carried out once.
    if (known) { if (known.response === response) return known.result; throw require('./ui-errors.cjs').uiError('error.background.answerPending', {}, { rawLanguage: 'en' }); }
    this.waitingCard(row, response);
    const ahead = this.decisionTails.get(key), entry = { response, waiting: Boolean(ahead || this.inflight.has(key)) };
    entry.result = entry.waiting ? this.afterCurrent(key, ahead, entry, () => this.carryOut(sessionId, nativeId, id, response, authorize, true))
      : this.carryOut(sessionId, nativeId, id, response, authorize, false);
    const tail = entry.result.then(() => {}, () => {});
    this.decisions.set(slot, entry); this.decisionTails.set(key, tail);
    tail.then(() => {
      if (this.decisions.get(slot) === entry) this.decisions.delete(slot);
      if (this.decisionTails.get(key) === tail) this.decisionTails.delete(key);
      this.changed();
    });
    this.changed();
    return entry.result;
  }
  async afterCurrent(key, ahead, entry, run) {
    await Promise.race([ahead, this.decisionsClosed]);
    if (this.closed) throw Error('Background control is closing');
    while (this.inflight.has(key)) {
      await Promise.race([this.inflight.get(key).then(() => {}, () => {}), this.decisionsClosed]);
      if (this.closed) throw Error('Background control is closing');
    }
    // No await between the check above and the synchronous reservation in carryOut.
    entry.waiting = false;
    return run();
  }
  // Why a card cannot take this answer, in the person's words; the raw message stays the one callers match.
  waitingCard(row, response) {
    const stale = key => require('./ui-errors.cjs').uiError(key, {}, { rawLanguage: 'en' });
    if (!row) throw stale('error.background.cardGone');
    if (row.state !== 'confirmation-required') throw stale(row.disposition === 'expired' ? 'error.background.cardExpired' : 'error.background.cardHandled');
    if (row.confirmation?.kind !== 'message' || !Array.isArray(row.confirmation.options.buttons) ||
        !Number.isSafeInteger(response) || response < 0 || response >= row.confirmation.options.buttons.length) throw Error('This confirmation is no longer current');
  }
  answerState(row) {
    const entry = row.state === 'confirmation-required' && this.decisions?.get(this.key(row.actor) + ':' + row.id);
    return entry ? (entry.waiting ? 'queued' : 'running') : null;
  }
  async carryOut(sessionId, nativeId, id, response, authorize, queued) {
    if (queued) authorize?.();
    const row = this.data.records.find(r => r.actor.id === sessionId && r.actor.nativeId === nativeId && r.id === id);
    // Settled while it waited (expired, withdrawn, answered elsewhere): its own receipt says how; nothing is carried out.
    if (queued && row && row.state !== 'confirmation-required') return this.receipt(row.actor, id);
    this.waitingCard(row, response);
    const decision = response === (row.confirmation.options.cancelId ?? 0) ? 'cancelled' : 'confirmed';
    if (decision === 'confirmed' && this.sameRequests(row).some(({ r, later }) => later && confirmedDecision(r))) throw require('./ui-errors.cjs').uiError('error.background.confirmedOnLaterCard');
    // Reserved synchronously, so no window is closed while the person's answer is carried out.
    return this.exclusive(row.actor, async () => {
    if (confirmationExpiresAt(row) !== null && this.now() >= confirmationExpiresAt(row)) return this.settlePending(row, 'expired', 'deadline-elapsed');
    const context = await this.view(row.actor, row.command.view_id);
    authorize?.();
    try { await context.checkActor(); }
    catch (error) {
      if (confirmationExpiresAt(row) !== null && this.now() >= confirmationExpiresAt(row)) return this.settlePending(row, 'expired', 'deadline-elapsed');
      if (row.command.method === 'input') {
        this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(row.actor)); Object.assign(r, { reason: 'temporarily-unavailable', resultNotice: { key: 'background.card.reason.temporarily-unavailable', params: {} } }); });
        return this.receipt(row.actor, id);
      }
      this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(row.actor));
        delete r.confirmation;
        Object.assign(r, { state: 'unconfirmed', error: String(error.message).slice(0, 2048), finishedAt: this.now() }); });
      return this.finishAudit(row.actor, id, context);
    }
    const current = this.receipt(row.actor, id);
    authorize?.();
    if (!current || current.state !== 'confirmation-required' || !isDeepStrictEqual(current.confirmation, row.confirmation)) throw Error('This confirmation was already handled');
    if (response === (row.confirmation.options.cancelId ?? 0)) {
      this.commit(d => { const r = d.records.find(r => r.id === id && r.actor.id === sessionId && r.actor.nativeId === nativeId); Object.assign(r, { state: 'cancelled', humanDecision: response, finishedAt: this.now() }); });
      return this.finishAudit(row.actor, id, context);
    }
    if (confirmationExpiresAt(row) === null) {
      this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(row.actor)); Object.assign(r, { reason: 'evidence-unavailable', resultNotice: { key: 'background.card.reason.evidence-unavailable', params: {} } }); });
      return this.receipt(row.actor, id);
    }
    if (this.now() >= confirmationExpiresAt(row)) return this.settlePending(row, 'expired', 'deadline-elapsed');
    if (row.command.method === 'input') {
      const check = operation.checkTerminalInput(row.terminalConsent, this.terminalSnapshot(context), row.command.arguments[0]);
      if (check.status === 'invalid') return this.settlePending(row, 'invalidated', check.reason);
      const snapshot = this.terminalSnapshot(context), target = snapshot?.sessions?.find(s => s.id === row.command.arguments[0]);
      const observable = target && !snapshot.unavailable && !target.transportDisconnected && !target.backendUnavailable && !target.nativeContextPending;
      if (observable) try { if (row.guard && !isDeepStrictEqual(row.guard, controlGuard(context, row.command))) return this.settlePending(row, 'invalidated', 'state-changed'); }
      catch { return this.receipt(row.actor, id); }
      if (check.status !== 'valid') {
        this.commit(d => { const r = d.records.find(r => r.id === id && this.key(r.actor) === this.key(row.actor)); Object.assign(r, { reason: check.reason, resultNotice: { key: 'background.card.reason.' + check.reason, params: {} } }); });
        return this.receipt(row.actor, id);
      }
    }
    this.commit(d => { const r = d.records.find(r => r.id === id && r.actor.id === sessionId && r.actor.nativeId === nativeId); delete r.reason; delete r.resultNotice; delete r.stateUiMessage; Object.assign(r, { state: 'running', humanDecision: response, humanDecisionAt: this.now() }); });
    return this.perform(row.actor, row.command, context, async () => { authorize?.(); await context.checkActor(); authorize?.(); }, { operationId: id, confirmation: row.confirmation, response, terminalConsent: row.terminalConsent, expiresAt: confirmationExpiresAt(row), authorize });
    }).then(result => {
      // Whatever came of it (carried out, cancelled, or not carried out because the asking session changed), the agent
      // that asked is told once it is recorded; an answer refused as no longer current changed nothing and tells nothing.
      // Only the id, the method and the state recorded go out: never a value read for the agent.
      if (result?.id === id) try { this.decided(clone(row.actor), { id, state: result.state, command: { method: row.command.method } }, decision); } catch { /* The receipt stays readable. */ }
      return result;
    }).finally(() => this.touch(row.actor));
  }
  // The same request asked on another card: the same agent, the same command under another operation id, against
  // the same targets (the guard the implicit-id reuse also compares). Explicit ids stay separate requests; this is
  // only what the person is told on the cards. The page answers only the newest waiting card, and a card whose
  // request was already confirmed on a later one is refused here, so one request is not carried out twice by mistake.
  sameRequests(row, all = [...(this.archivedBySession.get(row.actor.id) || []), ...this.data.records]) {
    const key = this.key(row.actor), own = all.indexOf(row);
    return all.map((r, index) => ({ r, later: r.at > row.at || r.at === row.at && index > own })).filter(({ r }) => r !== row && this.key(r.actor) === key &&
      r.command?.method === row.command.method && isDeepStrictEqual({ ...r.command, operation_id: row.command.operation_id }, row.command) &&
      (r.state === 'confirmation-required' ? isDeepStrictEqual(r.guard ?? null, row.guard ?? null) : isDeepStrictEqual(guardTargets(r.guard), guardTargets(row.guard))));
  }
  replacement(row, all) {
    if (row?.state !== 'confirmation-required') return null;
    const later = this.sameRequests(row, all).filter(item => item.later).map(item => item.r), newest = list => list.reduce((a, b) => (b.time > a.time ? b : a), list[0]);
    const waiting = later.filter(r => r.state === 'confirmation-required' && r.confirmation?.kind === 'message').map(r => ({ time: r.at, state: 'waiting' }));
    if (waiting.length) return newest(waiting);
    const answered = later.filter(r => Number.isSafeInteger(r.humanDecision)).map(r => ({ time: r.humanDecisionAt ?? r.finishedAt ?? r.at,
      state: confirmedDecision(r) ? 'confirmed' : 'cancelled' }));
    return answered.length ? newest(answered) : null;
  }
  // The person already confirmed this same request on an earlier card: confirming this one does it again.
  repeated(row, all) {
    if (row?.state !== 'confirmation-required') return null;
    const done = this.sameRequests(row, all).filter(({ r, later }) => !later && confirmedDecision(r))
      .map(({ r }) => r.humanDecisionAt ?? r.finishedAt ?? r.at);
    return done.length ? { time: Math.max(...done) } : null;
  }
  // `names` is the page's display state; an agent's own view (null) gets the rows as before, without the card's words.
  rows(sessionId, names = {}, { expire = true } = {}) {
    if (expire) this.expirePending();
    const own = [...(this.archivedBySession.get(sessionId) || []), ...this.data.records.filter(r => r.actor.id === sessionId)];
    return own.map(saved => { const r = this.expired(saved) ? { ...saved, ...this.expiryFields(saved) } : saved; return ({ id: `background:${r.actor.nativeId}:${r.id}`, role: 'system', kind: 'background-operation',
      name: operation.visibleText(r.actor.name), time: r.at, status: ['running', 'awaiting-native'].includes(r.state) ? 'working' : ['complete', 'received', 'cancelled'].includes(r.state) ? 'complete' : 'error',
      text: operation.visibleText(`${r.actor.name} · ${r.command.method}\n${JSON.stringify(r.command.arguments)}\n${r.disposition ? require('./ui-locale.js').format('zh', r.stateUiMessage.key) : ({ running: '正在执行', complete: '操作已执行', received: '原生会话已收到', 'awaiting-native': '已提交，原生收件待确认', 'confirmation-required': '等待你的确认', cancelled: '已取消，未执行', 'not-executed': '未执行', unconfirmed: '结果未确认' })[r.state] || r.state}${r.error ? `: ${r.error}` : ''}`),
      backgroundOperation: { id: r.id, sessionId: r.actor.id, nativeId: r.actor.nativeId, state: r.state, ...(r.disposition ? { disposition: r.disposition, stateUiMessage: r.stateUiMessage } : {}), ...(r.state === 'confirmation-required' ? { expiresAt: confirmationExpiresAt(r) } : {}), ...(this.answerState(r) ? { answer: this.answerState(r) } : {}),
        confirmation: r.confirmation ? { ...r.confirmation, options: visibleOptions(r.confirmation.options) } : null,
        resultNotice: r.resultNotice || (r.command.method === 'restoreSession' && r.value?.placement === 'unavailable' ? r.value.uiMessage : null),
        ...(names ? { summary: operation.operationSummary(r.command, r.actor, names), arguments: operation.visibleText(JSON.stringify(r.command.arguments ?? [], null, 2)),
          ...(r.error ? { error: operation.visibleText(String(r.error)) } : {}),
          ...(r.state === 'confirmation-required' ? { replacedBy: this.replacement(r, own), repeated: this.repeated(r, own) } : {}) } : {}) } }); });
  }
  // Human-window waiting strip: reuse the conversation card and its warnings.
  confirmationState(row, snapshot) {
    const unknown = reason => ({ state: 'unverifiable', actionable: false, reason: row.handlerStarted ? 'partial-operation' : reason });
    if (!snapshot || !Array.isArray(snapshot.sessions)) return unknown('evidence-unavailable');
    if (confirmationExpiresAt(row) === null) return unknown('evidence-unavailable');
    if (snapshot.unavailable) return unknown('temporarily-unavailable');
    const origin = snapshot.sessions.find(s => s.id === row.actor.id);
    if (!origin || origin.archived || origin.nativeId !== row.actor.nativeId) return unknown('temporarily-unavailable');
    if (origin.backendUnavailable || origin.transportDisconnected || origin.nativeContextPending) return unknown('temporarily-unavailable');
    for (const expected of row.guard?.sessions || []) {
      const target = snapshot.sessions.find(s => s.id === expected.id);
      if (!target) return unknown('temporarily-unavailable');
      if (target.archived) return unknown('temporarily-unavailable');
      if (target.backendUnavailable || target.transportDisconnected || target.nativeContextPending) return unknown('temporarily-unavailable');
      if (expected.nativeId && target.nativeId !== expected.nativeId) return unknown('temporarily-unavailable');
    }
    if (row.command.method === 'input') {
      const checked = operation.checkTerminalInput(row.terminalConsent, snapshot, row.command.arguments[0]);
      if (checked.status === 'invalid') return unknown('temporarily-unavailable');
      if (checked.status !== 'valid') return unknown(checked.reason);
    }
    if (!row.guard) return unknown('evidence-unavailable');
    if (row.guard) {
      const key = this.key(row.actor) + ':' + (row.command.view_id || 'default'), live = this.opened.get(key)?.context;
      try {
        const context = this.confirmationFingerprint ? { fingerprint: command => this.confirmationFingerprint(row, snapshot, live?.view || this.data.views[key] || { selected: row.actor.id }, live) } : live;
        if (!context?.fingerprint) return unknown('evidence-unavailable');
        if (!isDeepStrictEqual(row.guard, controlGuard(context, row.command))) return unknown('temporarily-unavailable');
      } catch (error) { return error.uiMessage?.key === 'error.planWorking' ? unknown('temporarily-unavailable') : unknown('evidence-unavailable'); }
    }
    return { state: 'confirmation-required', actionable: true, reason: null };
  }
  // One ledger projection for the bell, waiting strip and scoped phone reader.
  // No context is opened and no command is invoked while inspecting it.
  confirmations(names = {}, snapshot = names) {
    let unavailable = this.failed;
    // Expiry may persist a receipt. A failed write cannot take the person's
    // conversation down or make a pending card look executable.
    try { this.expirePending(); } catch { unavailable = true; }
    const all = () => [...this.archivedBySession.values()].flat().concat(this.data.records);
    const observed = { ...snapshot, ...(Array.isArray(names.sessions) ? { sessions: names.sessions } : {}) };
    const source = all(), messages = new Map();
    return source.filter(r => r.confirmation?.kind === 'message' || Number.isSafeInteger(r.confirmationRequestedAt) || Number.isSafeInteger(r.humanDecision))
      .map(row => {
        const replacedBy = this.replacement(row, source), expired = this.expired(row);
        const status = row.state === 'confirmation-required' && unavailable ? { state: 'unverifiable', actionable: false, reason: row.handlerStarted ? 'partial-operation' : 'evidence-unavailable' }
          : expired ? { state: 'expired', disposition: 'expired', actionable: false, reason: 'deadline-elapsed' }
          : replacedBy ? { state: 'replaced', actionable: false, reason: 'replaced' }
          : row.state === 'confirmation-required' ? this.confirmationState(row, observed)
          : { state: row.state, disposition: row.disposition || null, reason: row.reason || null, actionable: false };
        if (!messages.has(row.actor.id)) messages.set(row.actor.id, this.rows(row.actor.id, names, { expire: false }));
        const message = messages.get(row.actor.id).find(m => m.backgroundOperation.id === row.id && m.backgroundOperation.nativeId === row.actor.nativeId);
        const summary = row.confirmationSummary || operation.operationSummary(row.command, row.actor, names);
        return { id: message.id, key: [row.actor.id, row.actor.nativeId, row.id].join(':'), operationId: row.id, sessionId: row.actor.id, nativeId: row.actor.nativeId,
          actorName: operation.visibleText(row.actor.name), targetName: summary?.target || summary?.room || summary?.name || '',
          title: row.confirmationTitle || row.confirmation?.options?.message || summary?.method || '', summary,
          time: row.at, expiresAt: confirmationExpiresAt(row), finishedAt: replacedBy?.time || row.finishedAt || null,
          afterStart: row.handlerStarted === true, ...status, replacedBy, message };
      }).sort((a, b) => a.time - b.time || (a.sessionId + ':' + a.nativeId + ':' + a.operationId).localeCompare(b.sessionId + ':' + b.nativeId + ':' + b.operationId));
  }
  pending(names = {}) {
    this.expirePending();
    const rows = new Map();
    return this.data.records.filter(r => r.state === 'confirmation-required' && !this.expired(r) && r.confirmation?.kind === 'message' &&
      Array.isArray(r.confirmation.options?.buttons) && !this.replacement(r)).map(r => {
      if (!rows.has(r.actor.id)) rows.set(r.actor.id, this.rows(r.actor.id, names));
      const message = rows.get(r.actor.id).find(m => m.backgroundOperation.id === r.id && m.backgroundOperation.nativeId === r.actor.nativeId);
      const options = message.backgroundOperation.confirmation.options;
      return { id: message.id, operationId: r.id, sessionId: r.actor.id, nativeId: r.actor.nativeId,
        actorName: operation.visibleText(r.actor.name), title: options.message, detail: options.detail || '',
        buttons: options.buttons, cancelId: options.cancelId ?? 0, time: r.at, message };
    });
  }
  async close() {
    this.closed = true; this.closeDecisions();
    for (const [slot, entry] of this.decisions) if (entry.waiting) this.decisions.delete(slot);
    this.decisionTails.clear();
    clearTimeout(this.expiryTimer); this.expiryTimer = null; clearInterval(this.sweeper);
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
module.exports = { BackgroundControl, ConfirmationRequired, PreconditionRefused, validate, tool, dialog, agentReply, CONFIRMATION_TTL_MS, confirmationExpiresAt };
