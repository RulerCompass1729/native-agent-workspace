const backgroundOperation = require('./background-operation.cjs');
const { copySnapshotImages } = require('./native-images.cjs');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { processIdentity, processMayBeAlive } = require('./platform.cjs');
const { ProgressJournal } = require('./observation.cjs');
const { applyNativeBlock, applyCodexHistory, applyCodexTurnHistory, applyCodexDelta, applyCodexMessage, applyCodexProgress, persistedMessages } = require('./native-blocks.cjs');
const { SharedReplies } = require('./shared-replies.cjs');
const addressed = require('./addressed-handoffs.cjs');
const { nativeApprovalPolicy, ApprovalQueue } = require('./approval-policy.js');
const { NativeHistory, claudeMetadata, nativeId, codexVersionInfo } = require('./native-history.cjs');
const spaces = require('./collaboration-spaces.cjs');
const { uiError, uiNotice, uiActivity, setActivity, setWarning } = require('./ui-errors.cjs');
const { displayMessage } = require('./ui-locale.js');
const { archiveIdle } = require('./renderer/fleet-observation.js');
// A person's row to one session keeps 「你 → 名字」 and carries its catalog name (T-60). Null when the name
// is not a plain string, so the raw text shows as before.
// The row fields of an automatic message from another agent (session-wake.cjs), whichever native way it went in.
const wakeOrigin = intent => ({ name: `来自 ${intent.senderName}`, uiNameMessage: displayMessage({ version: 1, key: 'notice.wake.from', params: { name: intent.senderName } }, 'notice.') || undefined, origin: 'agent-wake', wakeSource: { id: intent.id, senderId: intent.senderId, nativeId: intent.nativeId, turnId: intent.turnId, time: intent.time } });
const youToName = name => displayMessage({ version: 1, key: 'notice.name.youToNamed', params: { name } }, 'notice.', `你 → ${name}`) || undefined;
const gitWorktree = require('./git-worktree.cjs');
const { directoryTrustPrompt } = require('./native-directory-trust.cjs');
const { terminalDialogPrompt } = require('./native-terminal-dialog.cjs');
const { cachedImageKey, removeCachedImages } = require('./native-images.cjs');

const cleanText = (value, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw uiError("error.workspace.inputLimit", { arg1: max.toLocaleString('en-US') });
  return value.trim();
};
// The newest kept message and its status. Volatile rows (native observations,
// tool progress) are display only and must not change saved state.
const activityMark = s => { const last = (s.messages || []).findLast(m => !m.volatile); return `${last?.id}:${last?.status}`; };
const wake = require('./session-wake.cjs');
// An interrupt the native side has not confirmed. When observed background work keeps the turn running (11-09: a
// sub-agent held an interrupted Claude turn for 45 minutes behind a generic notice), say what, since when NAW saw
// it, and where it can be stopped. Only what NAW observed: agent names from hook events, counts from the last report.
// Running = a SubagentStart in this run with no later SubagentStop, as in renderer/fleet-observation.js.
function interruptActivity(s) {
  const children = new Map();
  for (const event of s.fleet || []) if (['SubagentStart', 'SubagentStop'].includes(event.event) && event.id) {
    children.delete(event.id);
    if (event.event === 'SubagentStart' && event.stale === false) children.set(event.id, event);
  }
  const running = [...children.values()], named = running.filter(event => !event.nameUiMessage && event.name && Number.isFinite(event.time));
  const first = named.sort((x, y) => x.time - y.time)[0];
  if (first) return uiActivity('notice.activity.interruptWaitsForSubagent', { name: first.name, since: new Date(first.time).toTimeString().slice(0, 5), count: running.length });
  const reported = !s.backgroundStale && Number.isSafeInteger(s.background) && s.background > 0 ? s.background : 0;
  if (running.length || reported) return uiActivity('notice.activity.interruptWaitsForBackground', { count: running.length || reported });
  return uiActivity('notice.activity.interruptRequested');
}
// B6 E4: an interrupt the native side still has not confirmed, or a permission prompt nobody has
// answered, counts as stuck once it has lasted this long. One timer per wait sends state again at
// that moment, and only if the wait is still on. Nothing polls, and nothing is stopped, approved
// or sent because of it; the space record is written by the desktop (room-state.cjs recordStuck).
const STUCK_AFTER_MS = 5 * 60 * 1000;
// A timed checkpoint writes again the saved messages of a session only after a change that may have touched them
// (Workspace.savedMessages); the rest of each record is serialised every time. A placeholder, random for each process,
// marks where kept JSON goes; if a record happens to hold it too, that snapshot is serialised whole.
const SAVED_MARK = `\u0000naw-saved-${randomUUID()}`, SAVED_MARK_JSON = JSON.stringify(SAVED_MARK);
const spliceSaved = (json, text) => {
  const at = json.indexOf(SAVED_MARK_JSON);
  return at < 0 || json.includes(SAVED_MARK_JSON, at + 1) ? null : json.slice(0, at) + text + json.slice(at + SAVED_MARK_JSON.length);
};
// Every persist(), and a timed checkpoint at least this often, serialises all messages again.
const SAVE_ALL_MS = 30 * 1000;
// Why a failed native turn is continued automatically: the suffix of its notice keys and the opening of its
// collaboration pause. All three share one timer, one limit and the same cancellations.
const RECOVERY_REASONS = Object.freeze({
  capacity: { key: 'Capacity', pause: '模型满载' },
  routing: { key: 'Routing', pause: '路由发现超时' },
  forbidden: { key: 'Forbidden', pause: '请求被拒绝（403）后' },
});
const { OperatorControl } = require('./operator-control.cjs');
const { GoalContinuation } = require('./goal-continuation-runner.cjs');
// Pointer motion with no button held (SGR any-event mouse tracking, e.g. fullscreen Claude)
// is hover, not a human instruction; presses, drags and releases still are.
const isPointerHover = data => /^(?:\x1b\[<\d+;\d+;\d+M)+$/.test(data) && [...data.matchAll(/\x1b\[<(\d+);/g)].every(m => (Number(m[1]) & 35) === 35);
const isTerminalResponse = data => /^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\[\??\d+;[0-4]\$y$/.test(data) || /^\x1b\](10|11);rgb:[\da-f/]+(\x07|\x1b\\)$/i.test(data) || isPointerHover(data);

// Settings a new session starts with instead of the provider defaults; NAW's session rotation
// carries the old session's. Absent fields keep the native defaults. queue-dispatch.cjs decides
// what it can carry from the same lists (CLAUDE_PERMISSION_MODES, CLAUDE_EFFORTS).
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/;
const CODEX_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const { readCodexProfile, PROFILE_PATTERN: CODEX_PROFILE_PATTERN } = require('./codex-profile.cjs');
// Who made the model a session runs (vendor) and which native program runs it (shell), for the
// interface to tell DeepSeek-through-Codex from Codex. A Codex vendor is the model provider
// Codex reports for the thread (or, before that, the one its profile names); null until known.
function sessionMaker(s) {
  const vendor = s.provider === 'claude' ? 'anthropic' : typeof s.modelProvider === 'string' ? s.modelProvider : null;
  return { vendor, shell: s.provider };
}
const otherVendor = s => s.provider === 'codex' && typeof s.modelProvider === 'string' && s.modelProvider !== 'openai';
function createSettings(provider, settings) {
  if (settings === undefined || settings === null) {
    return null;
  }
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw uiError("error.workspace.invalidSettings");
  }
  for (const key of Object.keys(settings)) {
    if (!['model', 'effort', 'permissionMode', 'profile'].includes(key)) {
      throw uiError("error.workspace.invalidSettings");
    }
  }
  const result = {};
  if (settings.model !== undefined) {
    if (typeof settings.model !== 'string' || !MODEL_PATTERN.test(settings.model)) {
      throw uiError("error.workspace.invalidSettings");
    }
    result.model = settings.model;
  }
  if (settings.effort !== undefined) {
    let valid = typeof settings.effort === 'string' && CODEX_EFFORT_PATTERN.test(settings.effort);
    if (provider === 'claude') {
      valid = CLAUDE_EFFORTS.includes(settings.effort);
    }
    if (!valid) {
      throw uiError("error.workspace.invalidSettings");
    }
    result.effort = settings.effort;
  }
  if (settings.permissionMode !== undefined) {
    if (provider !== 'claude' || !CLAUDE_PERMISSION_MODES.includes(settings.permissionMode)) {
      throw uiError("error.workspace.invalidSettings");
    }
    result.permissionMode = settings.permissionMode;
  }
  // One of the person's Codex profiles (DeepSeek pro / flash), see codex-profile.cjs.
  if (settings.profile !== undefined) {
    if (provider !== 'codex' || typeof settings.profile !== 'string' || !CODEX_PROFILE_PATTERN.test(settings.profile)) {
      throw uiError("error.workspace.invalidSettings");
    }
    result.profile = settings.profile;
  }
  if (!Object.keys(result).length) {
    return null;
  }
  return result;
}

// A space message read inside a running Claude turn (2.1.322, 2.1.323) gets no reply of its own, so the agent is told
// who sent it from which space and, when an agent sent it, how to answer that agent. The person's choice (b),
// 11-12. Nothing is claimed about where this turn's output goes: a turn an earlier space message started keeps
// sharing it. A message that runs as its own turn keeps its plain text.
const frameLabel = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff"\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
function spaceMidturnText(roomName, sender, text) {
  const space = frameLabel(roomName), id = sender && frameLabel(sender.id), name = sender && frameLabel(sender.name);
  // Only an ID that came through cleaning unchanged can be named as a recipient.
  const answer = sender && id === sender.id ? ` To answer ${name}, call mcp__native_workspace__workspace_message with recipient_id ${id}.` : '';
  const head = sender
    ? `[Workspace space message from ${name} · ${id} in the space "${space}", delivered into your running turn.${answer}]`
    : `[Workspace space message from the person in the space "${space}", delivered into your running turn.]`;
  // Input stops at 16,000 characters (cleanText), far below the bridge's 100,000 for mid-turn text.
  return `${head}\n${text}`;
}
class Workspace extends EventEmitter {
  constructor(host, dataDir, newWorkspaceRoot = path.join(dataDir, 'session-workspaces')) {
    super(); this.host = host; this.dataDir = dataDir; this.newWorkspaceRoot = newWorkspaceRoot; this.sessions = new Map(); this.runtimes = new Map(); this.drafts = new Map(); this.draftRevisions = new Map();
    // Open connections per view owner, and how many are pages a person sees. A window the person closed and
    // the hidden window an agent's request runs in are pageless: they hold no session against a window that
    // shows one (claim). Such an owner stays listed only while connected or holding a session.
    this.viewOwners = new Map(); this.pagelessOwners = new Set();
    this.claudeAsks = new Map();
    this.mobileRequests = [];
    this.capacityRecoveries = new Map();
    this.room = { id: 'shared', name: '共同工作', revision: 0, run: null, messages: [] };
    // The original file/room remains compatible with retained runtimes. Only
    // this existing Workspace writer owns the additional-room history file.
    this.rooms = new Map([['shared', this.room]]);
    this.versions = { shellModelCalls: 0, dispatches: 0 };
    this.saveTimer = null; this.saveSeq = 0; this.renamedSeq = 0; this.saveWriting = false; this.saveAgain = false;
    // Change counters: each session record's own (changed(id)) and the workspace's (changed() naming none).
    this.revisionAll = 0; this.revisions = new WeakMap(); this.savedJson = new WeakMap(); this.savedAllAt = -Infinity;
    this.deadlineTimer = setInterval(() => { for (const room of this.rooms.values()) this.expireRun(room.run); this.tickCapacity(); this.tickToolWait(); }, 1000);
    this.deadlineTimer.unref();
    this.forwards = new Map(); this.pendingDrafts = new Map();
    // Keys the person typed into each session's native terminal (not saved): see ownControl.
    this.terminalKeys = new Map();
    this.sharedReplies = new SharedReplies(this);
    this.approvalRoutes = new Map();
    // Waits that may become stuck, in memory only: a restart leaves no interrupt or approval pending.
    this.stuckWaits = new Map();
    this.stops = new Map();
    this.progress = new Map(); this.observedTerminals = new Map();
    this.nativeHistory = new NativeHistory(host); this.historyQueue = Promise.resolve(); this.pendingNativeImports = 0;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    wake.initialize(this);
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'));
      this.savedGoalContinuation = stored.goalContinuation;
      this.mobileRequests = Array.isArray(stored.mobileRequests) ? stored.mobileRequests.map(r => r && typeof r === 'object' && ['prepared', 'awaiting-native', 'reply-written'].includes(r.status) ? { ...r, status: 'unconfirmed' } : r) : stored.mobileRequests ?? [];
      for (const record of stored.sessions || []) {
        // Old Claude records could inherit the other provider's app-server PID.
        // Keep unknown legacy proof; discard that alias only with an own PID.
        const serverIdentity = record.provider === 'claude' && Number.isSafeInteger(record.processIdentity?.pid) && record.processIdentity.pid > 1 ? null : record.serverIdentity;
        this.sessions.set(record.id, { ...record, serverIdentity, claudeQuestion: null, fleet: (record.fleet || []).map(item => ({ ...item, stale: true })), state: record.forkPicker ? 'ended' : ['ended', 'background'].includes(record.state) ? record.state : 'recoverable', owner: null, approval: null, approvals: [], approvalOverflow: false, approvalResolved: false, pid: null, pendingTag: null, controlRevision: 0, liveDraft: '', activity: record.forkPicker ? '没有确认创建分支。' : record.state === 'ended' ? '' : record.state === 'background' ? record.activity || '' : '运行服务曾中断；记录和草稿已保留，任务不会自动重发。', activityUiMessage: record.forkPicker ? uiActivity('notice.activity.branchUnconfirmed')[1] : record.state === 'ended' ? null : record.state === 'background' ? record.activityUiMessage || null : uiActivity('notice.activity.serviceInterrupted')[1] });
      }
      for (const session of this.sessions.values()) for (const message of session.messages || []) {
        if (['streaming', 'running', 'awaiting-native'].includes(message.status)) message.status = 'unconfirmed';
        if (['staged', 'sending', 'consumed'].includes(message.wake?.status)) { message.wake.status = 'unconfirmed'; message.text = `自动消息接收结果未确认；不会重发。\n${message.wake.body}`; message.uiMessage = displayMessage({ version: 1, key: 'notice.wake.restored', params: { body: message.wake.body } }, 'notice.', message.text) || undefined; }
        // Held for the butler's 60-second limit, so never sent: reopening does not offer it again.
        if (message.wake?.status === 'held') { message.wake.status = 'cancelled'; message.text = `NAW 后台重开过；存着的自动消息没有补送。\n${message.wake.body}`; message.uiMessage = displayMessage({ version: 1, key: 'notice.wake.heldRestored', params: { body: message.wake.body } }, 'notice.', message.text) || undefined; }
      }
      this.room.messages = stored.room?.messages || [];
      for (const m of this.room.messages) if (['streaming', 'running'].includes(m.status)) { m.status = 'unconfirmed'; m.sharingStopped = '运行连接曾中断，未重发任务'; m.sharingStoppedUiMessage = uiActivity('notice.run.sharingInterrupted')[1]; }
      for (const m of this.room.messages) for (const delivery of m.deliveries || []) {
        if (delivery.status === 'awaiting-native') delivery.status = 'unconfirmed';
      }
      if (stored.room?.run) this.room.run = { ...stored.room.run, awaiting: null, ...(stored.room.run.status === 'running' ? { status: 'paused', reason: '运行服务曾中断；未重发任务，请核对原生结果。', reasonUiMessage: uiActivity('notice.run.serviceInterrupted')[1] } : {}) };
      if (this.room.run?.kind === 'cross-service' && (this.room.run.pausePending || stored.room.run.status === 'running')) Object.assign(this.room.run, { pausePending: false, pauseUnconfirmed: true, reason: '协调后台曾中断，未重发任务；请核对各后台授权与原生工作。', reasonUiMessage: uiActivity('notice.run.coordinatorInterrupted')[1] });
      if (stored.drafts) for (const [key, value] of Object.entries(stored.drafts)) this.drafts.set(key, value);
    } catch (error) {
      if (error.code !== 'ENOENT') { this.storageFailure = 'read'; setWarning(this, 'storageWarning', 'error.warning.workspaceRead'); }
    }
    try {
      const file = path.join(dataDir, 'room-records.json'), stat = fs.lstatSync(file);
      if (!stat.isFile() || process.getuid && stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Unsafe room records');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.rooms) || stored.rooms.some(r => !r || !spaces.roomId(r.id) || r.id === 'shared' || !Array.isArray(r.messages) || !Number.isSafeInteger(r.revision) || r.revision < 0) || new Set(stored.rooms.map(r => r.id)).size !== stored.rooms.length) throw Error('Invalid room records');
      for (const saved of stored.rooms) {
        const room = { ...saved, run: saved.run ? { ...saved.run, awaiting: null, ...(saved.run.status === 'running' ? { status: 'paused', reason: '运行服务曾中断；未重发任务，请核对原生结果。', reasonUiMessage: uiActivity('notice.run.serviceInterrupted')[1] } : {}) } : null };
        const imported = room.messages.filter(message => message.snapshotBatch !== undefined);
        if (imported.length || room.snapshotBatches !== undefined) {
          if (!Array.isArray(room.snapshotBatches) || room.snapshotBatches.some(marker => !marker || !spaces.roomId(marker.operationId) || marker.operationId === 'shared' || !/^[a-f0-9]{64}$/u.test(marker.binding)) ||
              new Set(room.snapshotBatches.map(marker => marker.operationId)).size !== room.snapshotBatches.length ||
              imported.some(message => !room.snapshotBatches.some(marker => marker.operationId === message.snapshotBatch))) throw Error('Invalid snapshot records');
          require('./space-merge.cjs').captureSource({ id: room.id, name: '快照记录', revision: 0, metadataRevision: 0, notes: '', files: [], events: [], messages: imported }, []);
        }
        if (room.run?.kind === 'cross-service' && (room.run.pausePending || saved.run.status === 'running')) Object.assign(room.run, { pausePending: false, pauseUnconfirmed: true });
        for (const m of room.messages) {
          if (['streaming', 'running'].includes(m.status)) { m.status = 'unconfirmed'; m.sharingStopped = '运行连接曾中断，未重发任务'; m.sharingStoppedUiMessage = uiActivity('notice.run.sharingInterrupted')[1]; }
          for (const delivery of m.deliveries || []) if (delivery.status === 'awaiting-native') delivery.status = 'unconfirmed';
        }
        this.rooms.set(room.id, room);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.storageFailure = 'read'; setWarning(this, 'storageWarning', 'error.warning.otherRoomsRead'); }
    }
    try {
      for (const session of this.sessions.values()) for (const id of spaces.roomIds(session)) if (!this.rooms.has(id)) throw Error('Missing room records');
    } catch {
      this.storageFailure = 'read'; setWarning(this, 'storageWarning', 'error.warning.membershipUnverifiable');
    }
    // Loading is not activity: start from each saved session's current mark.
    this.activityMarks = new Map([...this.sessions.values()].map(s => [s.id, activityMark(s)]));
    this.operator = new OperatorControl(this);
    this.goalContinuation = new GoalContinuation(this, this.savedGoalContinuation);
    delete this.savedGoalContinuation;
  }
  usageFor(s) {
    if (s.provider !== 'codex') return s.usage;
    const { account: _oldAccount, ...usage } = s.usage || {};
    const runtime = this.runtimes.get(s.id);
    // The account limits are those of the person's OpenAI sign-in; another vendor's session
    // (DeepSeek through Codex) does not use them, and shows its own tokens only.
    const account = runtime && !runtime.stopped && !runtime.transportDisconnected && !runtime.host?.closed && !otherVendor(s)
      ? runtime.host?.codexAccountUsage : null;
    return Object.keys(usage).length || account ? { ...usage, ...(account ? { account } : {}) } : null;
  }
  snapshot() {
    return this.operator.decorate({ nativeImageCacheRoot: path.join(this.dataDir, 'native-image-cache'), wakePolicy: wake.snapshot(this), peerLeases: this.peerLeases?.snapshot() || [], sessions: [...this.sessions.values()].map(s => ({ ...s, ...sessionMaker(s), ...(this.pagelessOwners.has(s.owner) ? { ownerPageless: true } : {}), ...this.stuckFor(s), usage: this.usageFor(s), capacityRecovery: this.capacityStatus(s.id), ...(s.provider === 'codex' ? codexVersionInfo(this.runtimes.get(s.id)?.host?.rpc, !this.runtimes.get(s.id)?.transportDisconnected && !this.runtimes.get(s.id)?.stopped && !this.runtimes.get(s.id)?.backendExitConfirmed) : {}), spaceImagesAvailable: this.runtimes.get(s.id)?.spaceImagesAvailable === true, addressedSendAvailable: this.runtimes.get(s.id)?.addressedSendAvailable === true, nativeInputRequired: Boolean(this.runtimes.get(s.id)?.nativeInputRequired), nativeStartupPrompt: directoryTrustPrompt(s, this.runtimes.get(s.id)), nativeTerminalDialog: terminalDialogPrompt(s, this.runtimes.get(s.id)), interruptPending: Boolean(this.runtimes.get(s.id)?.nativeAbortRequest), nativeBlockMapping: true, nativeSettings: this.runtimes.get(s.id)?.nativeSettings || null, nativeActivity: this.runtimes.get(s.id)?.nativeActivity || null, ...(s.provider === 'codex' ? { nativeGoal: this.runtimes.get(s.id)?.nativeGoalSnapshot?.() || null } : {}), nativeApproval: this.runtimes.get(s.id)?.nativeApproval || null, sharedActivity: this.sharedReplies.activity(s), sharedActivities: Object.fromEntries([...this.rooms.keys()].map(id => [id, this.sharedReplies.activity(s, id)])), failedTurnInputAvailable: Boolean(this.runtimes.get(s.id)?.failedTurnInputId), queueAvailable: Boolean(this.runtimes.get(s.id)?.queueAvailable), midturnAvailable: Boolean(this.runtimes.get(s.id)?.midturnAvailable), pendingQueue: this.runtimes.get(s.id)?.pendingQueue || null, steerAvailable: Boolean(this.runtimes.get(s.id)?.steerAvailable), activeTurnId: this.runtimes.get(s.id)?.turnId || null, pendingSteer: this.runtimes.get(s.id)?.pendingSteer || null, backendUnavailable: Boolean(this.runtimes.get(s.id)?.backendExitConfirmed), transportDisconnected: Boolean(this.runtimes.get(s.id)?.transportDisconnected), terminalState: this.runtimes.get(s.id)?.terminal ? { alive: Boolean(this.runtimes.get(s.id).terminal.alive), exitConfirmed: this.runtimes.get(s.id).terminal.nativeExited === true, epoch: this.runtimes.get(s.id).terminal.journal?.epoch || null } : null, terminalAvailable: Boolean(this.runtimes.get(s.id)?.terminal?.alive || (!this.runtimes.get(s.id)?.stopped && this.runtimes.get(s.id)?.hasHistory)), chatAvailable: this.runtimes.get(s.id)?.chatAvailable !== false, draftRevision: this.draftRevisions.get(s.id) || 0, liveDraft: this.drafts.get(s.id) || '' })), room: this.wakeView(this.room), rooms: [...this.rooms.values()].map(room => this.wakeView(room)), diagnostics: this.versions, available: Object.fromEntries(Object.entries(this.host.binaries).map(([k, v]) => [k, Boolean(v)])), storageWarning: this.storageWarning || null, storageWarningUiMessage: this.storageWarningUiMessage || null, storageRetryable: this.storageFailure === 'write' });
  }
  // kind is 'interrupt' or 'approval'.
  // An interrupt waits for as long as the turn it was sent to keeps running. A later tool or status
  // notice does not end it. With a native turn identity, the wait ends when that turn is no longer the
  // current one; without one, at the native interrupt or a completion (endUnidentifiedWait).
  // A confirmation wait lasts exactly as long as a prompt is open: a Codex request that blocks, a Claude
  // prompt the bridge reports (nativeApproval), or more requests than can be shown. The approval state
  // alone is not used: without the bridge it outlasts the prompt, so such a session is never marked.
  // A Codex request left behind by a backend that exited, or by a turn that is over, is not a prompt.
  stuckWaiting(s, kind, wait) {
    const runtime = this.runtimes?.get(s.id);
    if (kind === 'interrupt') return ['working', 'approval'].includes(s.state) && (wait?.turn == null || (runtime?.turnId || null) === wait.turn);
    return s.approvalOverflow === true || Boolean(runtime?.nativeApproval) ||
      Array.isArray(s.approvals) && ['working', 'approval'].includes(s.state) && Boolean(runtime) && !runtime.backendExitConfirmed && !runtime.transportDisconnected &&
        s.approvals.some(approval => approval?.params?.isBlocking !== false);
  }
  // Called where a wait begins or continues; the first call of a wait fixes when it began.
  noteWait(s, kind, turn = null) {
    const key = `${s.id}:${kind}`;
    if (this.stuckWaits.has(key)) return;
    const wait = { id: s.id, kind, since: Date.now(), due: false, timer: null, turn };
    wait.timer = setTimeout(() => {
      // The timer itself says the time has passed; the wall clock is not asked again, since it
      // may read a moment short and nothing would ask a second time.
      wait.timer = null; wait.due = true;
      const current = this.sessions.get(wait.id);
      if (!this.closed && current && this.stuckWaits.get(key) === wait && this.stuckWaiting(current, kind, wait)) this.changed();
    }, STUCK_AFTER_MS);
    wait.timer.unref?.();
    this.stuckWaits.set(key, wait);
  }
  endWait(s, kind) {
    const key = `${s.id}:${kind}`, wait = this.stuckWaits.get(key);
    if (wait) { clearTimeout(wait.timer); this.stuckWaits.delete(key); }
  }
  // A completion can be reported while its turn goes on, or for an earlier turn; it ends only a
  // wait that has no turn identity to go by.
  endUnidentifiedWait(s) {
    if (this.stuckWaits.get(`${s.id}:interrupt`)?.turn == null) this.endWait(s, 'interrupt');
  }
  stuckFor(s, now = Date.now()) {
    const stuck = [];
    for (const kind of ['interrupt', 'approval']) {
      const wait = this.stuckWaits?.get(`${s.id}:${kind}`);
      if (wait && this.stuckWaiting(s, kind, wait) && (wait.due || now - wait.since >= STUCK_AFTER_MS || kind === 'approval' && s.approvalOverflow === true)) {
        // What holds the interrupt is read now, from what NAW observed, not from a notice that may have been replaced.
        stuck.push({ kind, since: wait.since, key: `stuck:${s.id}:${kind}:${wait.since}`, ...(kind === 'interrupt' ? { held: interruptActivity(s)[1] } : {}) });
      }
    }
    return stuck.length ? { stuck } : {};
  }
  // session: the one session whose messages this change touched, as a streamed reply does; with none, any
  // session's may have changed. The daemon then digests only that session's messages again (state-delta.cjs),
  // with the spaces': every space is digested again on each change, since sharedReplies may rewrite its rows.
  // A timed checkpoint likewise serialises again only that session's saved messages (savedMessages).
  changed(session) {
    const named = typeof session === 'string' ? this.sessions.get(session) : undefined;
    if (named) this.revisions.set(named, (this.revisions.get(named) || 0) + 1); else this.revisionAll++;
    // A wait that has ended is forgotten at the first change after it, with its timer. An open
    // permission prompt starts its wait at the first change that shows it, whatever reported it.
    for (const [key, wait] of this.stuckWaits) {
      const current = this.sessions.get(wait.id);
      if (!current || !this.stuckWaiting(current, wait.kind, wait)) { clearTimeout(wait.timer); this.stuckWaits.delete(key); }
    }
    for (const s of this.sessions.values()) {
      if (this.stuckWaiting(s, 'approval')) this.noteWait(s, 'approval');
      // An unnamed row shows its first request until a native title arrives.
      if (s.autoName && !s.nameSource) {
        const first = s.messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
        if (first) { s.name = `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${first.text.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim()}`.slice(0, 60); s.nameSource = 'preview'; }
      }
      // Last activity: a new message or a change of the newest one's status. A
      // session created here starts from its creation time.
      const mark = activityMark(s);
      if (this.activityMarks.has(s.id) && this.activityMarks.get(s.id) !== mark) s.lastActivityAt = Date.now();
      this.activityMarks.set(s.id, mark);
    }
    this.sharedReplies.refresh();
    this.emit('change', session);
    if (this.storageWarning) return;
    // Keep burst coalescing, but a continuously streaming reply must not
    // postpone every checkpoint until the provider becomes quiet.
    if (!this.saveDeadline) this.saveDeadline = setTimeout(() => this.persistLater(), 1000);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persistLater(), 150);
  }
  // Both writers save one numbered snapshot of the same two files. persist() has renamed it before it returns, for
  // a caller that must know a record is on disk. A timed checkpoint (persistLater) writes off the event loop: at the
  // daily shape a 15 MB synchronous write held every terminal key and reply for tens of milliseconds each second.
  // A write renames only a snapshot newer than the one on disk, so an older one finishing late never replaces it.
  // The same JSON with reuse (a timed checkpoint) or without: kept JSON of a session's saved messages is spliced in.
  storeSnapshot(replacement, reuse = false) {
    const now = Date.now();
    if (!reuse || !(now - this.savedAllAt < SAVE_ALL_MS)) { reuse = false; this.savedAllAt = now; }
    // No terminal bytes, credentials, environment, hook secrets or raw protocol.
    const records = [...this.sessions.values()].map(record => {
      const { owner, approval, approvals, approvalOverflow, approvalResolved, pid, ...s } = replacement?.id === record.id ? replacement.next : record;
      return [record, s];
    });
    const mobile = Array.isArray(this.mobileRequests) && !this.mobileRequests.length ? {} : { mobileRequests: this.mobileRequests };
    const rest = { sessions: SAVED_MARK, room: { messages: persistedMessages(this.room.messages, 'shared-native-cache-gap'), ...(this.room.run ? { run: this.room.run } : {}) }, drafts: Object.fromEntries(this.drafts), ...(this.goalContinuation ? { goalContinuation: this.goalContinuation.journal() } : {}), ...mobile };
    const sessions = records.map(([record, s]) => spliceSaved(JSON.stringify({ ...s, messages: SAVED_MARK, pendingTag: null }),
      s.messages === record.messages ? this.savedMessages(record, reuse) : JSON.stringify(persistedMessages(s.messages))));
    const workspace = (!sessions.includes(null) && spliceSaved(JSON.stringify(rest), `[${sessions.join(',')}]`)) ||
      JSON.stringify({ ...rest, sessions: records.map(([, s]) => ({ ...s, messages: persistedMessages(s.messages), pendingTag: null })) });
    const rooms = this.rooms.size > 1 ? JSON.stringify({ version: 1, rooms: [...this.rooms.values()].filter(r => r.id !== 'shared').map(r => ({ ...r, messages: persistedMessages(r.messages, 'shared-native-cache-gap') })) }) : null;
    return { seq: ++this.saveSeq, workspace, rooms };
  }
  // The JSON of a session's saved messages, kept with the change counters it was taken at. It is used again only
  // while neither counter has moved and the record still holds the same messages array.
  savedMessages(record, reuse) {
    const own = this.revisions.get(record) || 0, kept = this.savedJson.get(record);
    if (reuse && kept && kept.all === this.revisionAll && kept.own === own && kept.messages === record.messages) return kept.json;
    const json = JSON.stringify(persistedMessages(record.messages));
    this.savedJson.set(record, { all: this.revisionAll, own, messages: record.messages, json });
    return json;
  }
  // A change to a session's rows that its caller reports later, or not at all, without naming the session (as
  // session-wake's revoke): its kept JSON is not used again.
  edited(record) { if (record) this.revisions.set(record, (this.revisions.get(record) || 0) + 1); }
  saveFailed() { this.storageFailure = 'write'; setWarning(this, 'storageWarning', 'error.warning.workspaceWrite'); this.emit('change'); }
  persist(replacement) {
    clearTimeout(this.saveTimer); clearTimeout(this.saveDeadline);
    this.saveTimer = this.saveDeadline = null;
    if (this.storageWarning) return false;
    let workspaceSaved = false;
    const target = path.join(this.dataDir, 'workspace.json'); const temp = `${target}.tmp`;
    try {
      const snapshot = this.storeSnapshot(replacement);
      fs.writeFileSync(temp, snapshot.workspace, { mode: 0o600 });
      // Numbered before the rename: a rename that fails after it took place still keeps an older checkpoint out.
      this.renamedSeq = snapshot.seq; fs.renameSync(temp, target); workspaceSaved = true; fs.chmodSync(target, 0o600);
      if (snapshot.rooms !== null) {
        const file = path.join(this.dataDir, 'room-records.json'), pending = `${file}.tmp`;
        fs.writeFileSync(pending, snapshot.rooms, { mode: 0o600 });
        fs.renameSync(pending, file); fs.chmodSync(file, 0o600);
      }
    } catch { this.saveFailed(); }
    return workspaceSaved;
  }
  persistLater() {
    clearTimeout(this.saveTimer); clearTimeout(this.saveDeadline);
    this.saveTimer = this.saveDeadline = null;
    if (this.storageWarning || this.closed) return;
    // One write at a time: a checkpoint due meanwhile is taken when it ends, from the state then.
    if (this.saveWriting) { this.saveAgain = true; return; }
    let snapshot;
    try { snapshot = this.storeSnapshot(undefined, true); } catch { this.saveFailed(); return; }
    this.saveWriting = true;
    const target = path.join(this.dataDir, 'workspace.json'), file = path.join(this.dataDir, 'room-records.json');
    const temp = `${target}.later.tmp`, pending = `${file}.later.tmp`;
    (async () => {
      await fs.promises.writeFile(temp, snapshot.workspace, { mode: 0o600 });
      // Check and rename in one turn of the event loop, so a persist() cannot land between them. After close
      // nothing is renamed: close() saved last, and another daemon may already own the directory.
      if (snapshot.seq < this.renamedSeq || this.closed) return fs.promises.rm(temp, { force: true });
      this.renamedSeq = snapshot.seq; fs.renameSync(temp, target); fs.chmodSync(target, 0o600);
      if (snapshot.rooms === null) return;
      await fs.promises.writeFile(pending, snapshot.rooms, { mode: 0o600 });
      // Room records pair with the workspace file of the same snapshot.
      if (this.renamedSeq !== snapshot.seq || this.closed) return fs.promises.rm(pending, { force: true });
      fs.renameSync(pending, file); fs.chmodSync(file, 0o600);
    })().catch(() => { if (this.renamedSeq <= snapshot.seq && !this.storageWarning && !this.closed) this.saveFailed(); })
      .finally(() => { this.saveWriting = false; if (this.saveAgain) { this.saveAgain = false; this.persistLater(); } });
  }
  retrySave() {
    // A failed read may hide existing records. Never overwrite it with the
    // incomplete in-memory state, even when the person requests a write retry.
    if (this.storageFailure !== 'write') throw uiError('error.saveNotRetryable');
    this.storageFailure = null; this.storageWarning = null; delete this.storageWarningUiMessage;
    this.persist(); this.emit('change');
    if (this.storageWarning) throw uiError('error.saveFailed');
    for (const runtime of this.runtimes.values()) runtime.retryContext?.();
    return true;
  }
  get(id) { const s = this.sessions.get(id); if (!s) throw uiError('error.sessionMissing'); return s; }
  runtime(id) { const r = this.runtimes.get(id); if (!r) throw uiError('error.sessionEnded'); return r; }
  async observe(id) {
    this.get(id);
    const terminal = this.runtimes.get(id)?.terminal || this.observedTerminals.get(id);
    return { terminal: terminal?.observe ? await terminal.observe() : null,
      progress: this.progress.get(id)?.snapshot() || { items: [], revision: 0, truncated: false } };
  }
  operatorAction(id, action, value) {
    // Only the existing authenticated desktop IPC reaches this human surface.
    // An agent's MCP endpoint never accepts these authorization operations.
    if (action === 'enabled') return this.operator.settings(id, value);
    this.get(id);
    // B5: a grant carried to a replacing session can still be revoked from the card of the session it came from.
    const domain = action === 'revoke' ? this.operator.data.domains[value] : null;
    if (action === 'revoke' && !domain?.initiators.some(i => i.id === id) && !domain?.carried?.some(c => c.from.id === id)) throw Error('Authorization domain belongs to another initiator');
    // (The desktop's own step; main.cjs refuses it from an agent's context.)
    if (action === 'succession') return this.operator.succession(id, value);
    if (['authorize', 'dismiss', 'placement', 'placed'].includes(action) && this.operator.data.actions[value?.key]?.initiatorId !== id) throw Error('Creation confirmation belongs to another initiator');
    if (action === 'placement') return this.operator.placement(value?.key);
    if (action === 'placed') return this.operator.placed(value?.key, value?.result);
    // (Both are the desktop's own steps; main.cjs refuses them, and a grant that names a space, from an agent's context.)
    if (['close', 'read'].includes(action) && this.operator.data.requests[action === 'read' ? value : value?.requestId]?.initiatorId !== id) throw Error('Request belongs to another initiator');
    if (action === 'grant') return this.operator.grant(id, value);
    if (action === 'revoke') return this.operator.revoke(value);
    if (action === 'authorize') return this.operator.authorize(value?.key, value?.domainId);
    if (action === 'dismiss') return this.operator.dismiss(value?.key);
    if (action === 'close') return this.operator.close(value?.requestId, value?.reason);
    if (action === 'read') return this.operator.markRead(value);
    throw Error('Unknown operator action');
  }
  operatorHuman(id) { try { this.operator.human(id); } catch { /* A failed operator journal must never block the person's input. */ } }
  async create(provider, cwd, owner, name, view = 'chat', { fork, skipPermissions, newDirectory, gitWorktree: worktreePlan, settings } = {}, reserve = null) {
    if (!['chat', 'terminal'].includes(view)) throw uiError("error.workspace.unknownView");
    const requestedSettings = createSettings(provider, settings);
    // The model vendor the session will run, until Codex reports the one it uses: a missing or
    // unreadable profile refuses the creation here, before any native process starts.
    const profileProvider = requestedSettings?.profile ? readCodexProfile(requestedSettings.profile).model_provider : undefined;
    if (skipPermissions != null && skipPermissions !== true) throw uiError("error.workspace.invalidPermissions");
    if (fork != null && (fork !== 'picker' || provider !== 'claude')) throw uiError("error.workspace.invalidBranch");
    if (newDirectory != null && newDirectory !== true) throw uiError("error.workspace.invalidNewDirectory");
    if (fork && newDirectory) throw uiError("error.workspace.branchNeedsOriginalDirectory");
    if (worktreePlan != null && (fork || newDirectory)) throw uiError("error.workspace.gitModeConflict");
    // The native session picker that chooses what to branch needs the terminal.
    if (fork) view = 'terminal';
    if (!['claude', 'codex'].includes(provider) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw uiError("error.workspace.selectAgentDirectory");
    const sessionName = name ? cleanText(name, 60) : `${provider === 'claude' ? 'Claude' : 'Codex'} ${[...this.sessions.values()].filter(s => s.provider === provider).length + 1}`;
    if (worktreePlan != null) {
      if (this.closed || this.storageWarning) throw uiError("error.workspace.gitBackendUnavailable");
      if (cwd !== worktreePlan?.source) throw uiError("error.workspace.gitRepositorySelectionChanged");
      worktreePlan = await gitWorktree.validate(worktreePlan);
      if (this.closed || this.storageWarning) throw uiError("error.workspace.gitBackendChanged");
      cwd = worktreePlan.cwd;
    } else if (newDirectory) {
      const leaf = path.basename(cwd), root = this.newWorkspaceRoot;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(leaf) || cwd !== path.join(root, leaf)) throw uiError("error.workspace.newDirectoryPathChanged");
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        if (!fs.lstatSync(root).isDirectory()) throw Error('Invalid root');
      } catch { throw uiError("error.workspace.newDirectoryRootUnavailable"); }
      try {
        // Never reuse an existing folder, file or symlink as an empty workspace.
        fs.mkdirSync(cwd, { mode: 0o700 }); fs.chmodSync(cwd, 0o700);
      } catch (error) {
        if (error.code === 'EEXIST') throw uiError("error.workspace.newDirectoryExists");
        throw uiError("error.workspace.newDirectoryCreateFailed");
      }
    } else {
      try { if (!fs.statSync(cwd).isDirectory()) throw Error('Not a directory'); }
      catch { throw uiError("error.workspace.directoryUnavailable"); }
    }
    const id = randomUUID();
    const now = Date.now();
    const record = { id, nativeId: provider === 'claude' ? randomUUID() : null, name: sessionName, createdAt: now, lastActivityAt: now, ...(name ? {} : { autoName: true }), ...(skipPermissions ? { skipPermissions: true, ...(provider === 'claude' ? { nativePermissionMode: 'bypassPermissions' } : {}) } : {}), provider, cwd, roomId: null, memberRevision: 0, controlRevision: 0, owner, view, state: 'starting', messages: [], fleet: [], background: null, scheduled: null, model: '原生默认', modelUiMessage: uiNotice('notice.model.nativeDefault').uiMessage, usage: null, pendingTag: null, activity: '', approval: null, pid: null, ...(requestedSettings ? { requestedSettings } : {}), ...(typeof profileProvider === 'string' ? { modelProvider: profileProvider } : {}) };
    if (fork) record.forkPicker = true;
    if (worktreePlan) {
      record.worktreePreparation = { ...worktreePlan, status: 'preparing' };
      setActivity(record, ...uiActivity("notice.activity.preparingGit"));
    }
    this.sessions.set(id, record); this.changed();
    let runtime;
    const currentPreparation = () => this.sessions.get(id) === record && record.state === 'starting';
    try {
      if (worktreePlan) {
        // Reserve a recoverable row before the first branch/path mutation.
        if (!currentPreparation()) throw uiError("error.workspace.gitPreparationCancelled");
        this.persist();
        if (this.storageWarning || this.closed) throw uiError("error.workspace.gitPreparationUnsaved");
        record.cwd = await gitWorktree.prepare(worktreePlan);
        record.worktreePreparation.status = 'ready';
        if (currentPreparation()) setActivity(record, '');
        this.persist();
        if (this.storageWarning || this.closed) throw uiError("error.workspace.gitReadyBackendChanged");
        if (!currentPreparation()) throw uiError("error.workspace.gitReadyPreparationCancelled");
      }
      if (reserve) reserve(record);
      runtime = this.host.create(record); this.runtimes.set(id, runtime); this.bind(record, runtime);
      if (runtime.start) await runtime.start();
      return id;
    } catch (error) {
      if (worktreePlan) {
        if (record.worktreePreparation.status !== 'ready') record.worktreePreparation.status = 'unconfirmed';
        const cause = { message: error.message, uiMessage: error.uiMessage };
        const display = uiError('error.workspace.gitFailureContext', { reason: cause.message, target: worktreePlan.target, branch: worktreePlan.branch }, { cause, param: 'reason' });
        error.message = display.message;
        if (display.uiMessage) error.uiMessage = display.uiMessage; else delete error.uiMessage;
      }
      if ((!runtime && (!worktreePlan || currentPreparation())) || (runtime && this.runtimes.get(id) === runtime)) { record.state = 'error'; setActivity(record, error.message, error.uiMessage); this.changed(); }
      if (worktreePlan) this.persist();
      throw error;
    }
  }
  importHistory(id, owner, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw uiError("error.client.invalidHistoryImport");
    const provider = options.provider ?? 'codex';
    if (!['codex', 'claude'].includes(provider)) throw uiError("error.client.invalidNativeProvider");
    nativeId(id);
    const claude = provider === 'claude' ? claudeMetadata(id, options) : null;
    if (claude) id = claude.nativeId;
    if (this.closed) throw uiError("error.workspace.backendClosedNoImport");
    this.pendingNativeImports++;
    const operation = this.historyQueue.then(async () => {
      if (this.closed) throw uiError("error.workspace.backendClosedNoImport");
      const existing = [...this.sessions.values()].filter(s => s.provider === provider && s.nativeId === id);
      if (existing.length > 1) throw uiError("error.client.existingRecordOwnershipConflict");
      if (existing.length) return existing[0].id;
      if (this.storageWarning) throw uiError("error.workspace.recordsUnsaved");
      const info = claude || await this.nativeHistory.read(id);
      if (this.closed) throw uiError("error.workspace.backendClosedNoImport");
      if (this.storageWarning) throw uiError("error.workspace.storageChangedNoResume");
      if (!fs.statSync(info.cwd).isDirectory()) throw uiError("error.workspace.originalDirectoryUnavailable");
      const localId = randomUUID();
      const record = { id: localId, nativeId: id, externalHistory: true, name: info.name || 'Codex 历史会话', provider, cwd: info.cwd,
        ...(claude ? { autoName: claude.autoName, nativePermissionMode: claude.skipPermissions ? 'bypassPermissions' : undefined } : {}),
        roomId: null, memberRevision: 0, controlRevision: 0, owner, view: claude ? 'terminal' : 'chat', state: 'recoverable', messages: [], fleet: [], background: null,
        scheduled: null, model: info.model, modelUiMessage: displayMessage(info.modelUiMessage, 'notice.', info.model) || undefined, usage: null, pendingTag: null, activity: '', approval: null, pid: null };
      // Reserve and locally persist the identity before crossing the native side
      // effect boundary. An uncertain ACK is never retried or turned into a fork.
      this.sessions.set(localId, record); this.persist();
      if (this.storageWarning) { record.state = 'error'; setActivity(record, ...uiActivity("notice.activity.historyNeedsSaveRetry")); this.changed(); return localId; }
      try { await this.resume(localId, owner); }
      catch (error) {
        if ((error.nativeActiveWriter || error.nativeImportRefused) && this.sessions.get(localId) === record && !this.runtimes.has(localId)) {
          // A definite refusal never acquired the native thread. Keep the
          // person's selection in the picker instead of adding a failed copy.
          this.sessions.delete(localId); this.progress.delete(localId); this.changed(); this.persist(); throw error;
        }
        if (this.sessions.get(localId) === record && record.state === 'recoverable' && !record.activity) { record.state = 'error'; setActivity(record, error.message, error.uiMessage); this.changed(); }
      }
      this.persist(); return localId;
    });
    const tracked = operation.finally(() => { this.pendingNativeImports--; });
    this.historyQueue = tracked.catch(() => {}); return tracked;
  }
  // Only a live native failed turn can arm this bounded recovery. Nothing is
  // restored from history or disk, and the original task is never replayed.
  capacityStatus(id) {
    const r = this.capacityRecoveries.get(id);
    return r ? { status: r.status, attempt: r.attempt, due: r.due, reason: r.reason, nativeId: r.nativeId, turnId: r.turnId } : null;
  }
  tickToolWait() {
    if (this.closed) return;
    const now = Date.now(); let changed = false;
    for (const [id, runtime] of this.runtimes) {
      const s = this.sessions.get(id), activity = runtime.nativeActivity, tool = activity?.toolWait;
      const fresh = !Number.isFinite(activity?.observedAt) || activity.observedAt <= now && now - activity.observedAt <= 5000;
      const valid = s?.state === 'working' && !this.stops.has(id) && !s.nativeContextPending && !s.approval && !s.approvalOverflow && !s.claudeQuestion &&
        !runtime.transportDisconnected && !runtime.stopped && !runtime.nativeObservationPending && activity?.stale !== true && fresh &&
        activity?.nativeId === s.nativeId && Boolean(s.nativeId) && activity.turnId === runtime.turnId && Boolean(activity.turnId) &&
        !['approval', 'waitingOnApproval', 'waitingOnUserInput', 'willRetry'].includes(activity.phase || activity.label) &&
        tool?.source === 'live-observation' && typeof tool.marker === 'string' && tool.marker.length > 0 && tool.marker.length <= 512 &&
        Number.isFinite(tool.progressAt) && tool.progressAt <= now;
      const quietSince = valid ? Math.max(tool.progressAt, runtime.toolWaitQuietResetAt || 0) : now;
      if (valid && now - quietSince >= 5 * 60 * 1000) {
        const prior = runtime.toolWaitNotice;
        if (prior?.nativeId === s.nativeId && prior.turnId === activity.turnId && prior.marker === tool.marker && prior.progressAt === tool.progressAt) continue;
        runtime.toolWaitNotice = { kind: 'tool-wait', nativeId: s.nativeId, turnId: activity.turnId, marker: tool.marker, progressAt: tool.progressAt, quietSince, createdAt: now };
        changed = true;
      } else if (runtime.toolWaitNotice) { runtime.toolWaitNotice = null; changed = true; }
      else runtime.toolWaitNotice = null;
    }
    // Runtime-only advisory: no saved native row, state transition, model call,
    // collaboration pause, input replay or new timer is created by the deadline.
    if (changed) this.emit('change');
  }
  // A scheduled automatic continuation that the person's own change ended says why and how to go on: an edit of the
  // message box, or a takeover or membership change. Nothing is added when the session already shows why it cannot
  // continue (stopping, disconnect, backend exit, approval, a new turn or send, archive, save failure), when its native
  // connection changed, after the limit was reached, or once it is in or moving to a new native context. A rebind adds
  // nothing either: each path shows its own state (starting, disconnect, exit), is a new native context, or, for a
  // Claude reload on the same thread, adds the existing gap row (adapters.cjs observeRootGap).
  capacityCancelled(s, r, why) {
    const keys = { draft: 'notice.capacityCancelledDraft', control: 'notice.capacityCancelledControl' };
    const runtime = s && this.runtimes.get(s.id);
    if (!s || !r || !keys[why] || this.capacityRecoveries.get(s.id) !== r || r.status !== 'scheduled') return;
    if (!runtime || runtime !== r.runtime || runtime.host?.rpc !== r.rpc || runtime.lifecycleRevision !== r.lifecycle || runtime.rootLease !== r.lease ||
      runtime.observationEpoch !== r.epoch || s.nativeId !== r.nativeId || s.nativeContextPending || this.closed || this.storageWarning || s.archived ||
      this.stops.has(s.id) || !['idle', 'error'].includes(s.state) || (s.pendingTag && s.pendingTag !== r.tag) || s.approval || s.approvalOverflow ||
      s.claudeQuestion || runtime.stopped || runtime.transportDisconnected || runtime.backendExitConfirmed || runtime.chatAvailable === false ||
      runtime.turnId || runtime.pendingQueue || runtime.pendingSteer || runtime.nativeInputRequired || runtime.nativeAbortRequest) return;
    s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', ...uiNotice(keys[why]), status: 'complete', time: Date.now() });
  }
  // The person's own edit reaches setDraft, which says so itself; a draft that changed any other way was restored by
  // the app, so it adds nothing here. A takeover or membership change by the person is the remaining case.
  dropCapacity(id, s, r) {
    const why = !s || !r || this.draftRevisions.get(s.id) !== r.draft || this.drafts.get(s.id) ? null
      : s.owner !== r.owner || s.controlRevision !== r.control || s.memberRevision !== r.member ? 'control' : null;
    this.capacityCancelled(s, r, why); this.cancelCapacity(id);
  }
  cancelCapacity(id) {
    const turn = this.runtimes.get(id)?.rootTurn;
    if (turn?.pendingFailure) { turn.pendingFailure = false; turn.failureCancelled = true; }
    if (this.capacityRecoveries.delete(id)) this.changed();
  }
  capacityValid(s, r) {
    const runtime = this.runtimes.get(s.id);
    return !this.closed && !this.storageWarning && this.capacityRecoveries.get(s.id) === r && runtime === r.runtime &&
      s.nativeId === r.nativeId && runtime.host?.rpc === r.rpc && runtime.lifecycleRevision === r.lifecycle && runtime.rootLease === r.lease && runtime.observationEpoch === r.epoch &&
      (s.provider !== 'claude' || runtime.rootTurn?.id === r.turnId && r.errorMessageId && runtime.rootTurn.errorMessageId === r.errorMessageId && runtime.rootTurn.failedTranscript === r.transcript && runtime.failedTurnInputMatches(r.turnId)) &&
      s.owner === r.owner && s.controlRevision === r.control && s.memberRevision === r.member &&
      this.draftRevisions.get(s.id) === r.draft && !this.drafts.get(s.id) && !s.archived && !s.nativeContextPending &&
      ['idle', 'error'].includes(s.state) && (!s.pendingTag || s.pendingTag === r.tag) && !s.approval && !s.approvalOverflow && !s.claudeQuestion &&
      !runtime.stopped && !runtime.transportDisconnected && !runtime.nativeObservationPending && !runtime.backendExitConfirmed && runtime.chatAvailable !== false &&
      !runtime.turnId && !runtime.pendingQueue && !runtime.pendingSteer && !runtime.nativeInputRequired && !runtime.nativeAbortRequest;
  }
  scheduleCapacity(s, runtime, turnId, reason = 'capacity') {
    const previous = this.capacityRecoveries.get(s.id);
    if (previous?.turnId === turnId) return;
    const r = { runtime, rpc: runtime.host?.rpc, lease: runtime.rootLease, epoch: runtime.observationEpoch, errorMessageId: runtime.rootTurn?.errorMessageId, transcript: runtime.rootTurn?.failedTranscript, lifecycle: runtime.lifecycleRevision, nativeId: s.nativeId, turnId, owner: s.owner, control: s.controlRevision, member: s.memberRevision,
      draft: this.draftRevisions.get(s.id), reason, attempt: previous?.attempt || 0, status: 'scheduled', due: 0 };
    this.capacityRecoveries.set(s.id, r);
    if (!this.capacityValid(s, r)) { this.capacityRecoveries.delete(s.id); return; }
    const delays = [120000, 300000, 600000];
    if (r.attempt >= delays.length) {
      r.status = 'exhausted';
      s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', ...uiNotice(`notice.capacityLimit${RECOVERY_REASONS[reason].key}`), status: 'complete', time: Date.now() });
    } else r.due = Date.now() + delays[r.attempt];
    this.changed();
  }
  tickCapacity(now = Date.now()) {
    // Native failure hooks can precede the journal flush. This existing clock
    // allows at most five bounded reads of that exact current error UUID.
    for (const runtime of this.runtimes.values()) if (runtime.rootTurn?.pendingFailure) runtime.reportCapacityFailure?.(true);
    for (const [id, r] of this.capacityRecoveries) {
      if (r.status !== 'scheduled' || r.checking) continue;
      const s = this.sessions.get(id);
      if (!s || !this.capacityValid(s, r)) { this.dropCapacity(id, s, r); continue; }
      if (now < r.due) continue;
      // Keep the existing cancel action available during this metadata read.
      r.checking = true;
      this.continueCapacity(s, r, now);
    }
  }
  async continueCapacity(s, r, now) {
    const stop = (text, uiMessage) => {
      if (this.capacityRecoveries.get(s.id) !== r) return;
      this.capacityRecoveries.delete(s.id);
      s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', text, ...(uiMessage ? { uiMessage } : {}), status: 'complete', time: Date.now() });
      this.changed();
    };
    let goal;
    try {
      if (s.provider === 'codex') {
        const result = await r.rpc.call('thread/goal/get', { threadId: r.nativeId }).catch(error => {
          if (error?.nativeGoalsDisabled === true) return { goal: null };
          throw error;
        });
        if (!result || !Object.hasOwn(result, 'goal') || (result.goal !== null &&
            (result.goal?.threadId !== r.nativeId || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(result.goal?.status)))) throw Error('Unknown goal state');
        goal = result.goal;
      }
    } catch {
      if (this.capacityRecoveries.get(s.id) === r && !this.capacityValid(s, r)) { this.dropCapacity(s.id, s, r); return; }
      stop(...uiActivity('notice.capacityGoalUnavailable')); return;
    }
    if (this.capacityRecoveries.get(s.id) !== r) return;
    if (!this.capacityValid(s, r)) { this.dropCapacity(s.id, s, r); return; }
    // A new ordinary input does not reactivate a blocked native goal. Do not
    // overwrite a concurrent native pause through an unconditional goal/set.
    if (goal && !['active', 'complete'].includes(goal.status)) {
      stop(...uiActivity(goal.status === 'blocked' ? 'notice.capacityGoalBlocked' : 'notice.capacityGoalInactive', { status: goal.status })); return;
    }
    r.attempt++; r.status = 'sending';
    const time = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    s.messages.push({ id: randomUUID(), role: 'system', name: 'NAW', kind: 'notice', ...uiNotice(`notice.capacityAutoContinue${RECOVERY_REASONS[r.reason].key}`, { time, attempt: r.attempt }), status: 'complete', time: now });
    // send() and the adapter recheck the same identity/control before writing.
    try { await this.send(s.id, '继续', r.owner, null, null, null, r); }
    catch { stop(...uiActivity('notice.capacityReceiptUnconfirmed')); }
  }
  bind(s, runtime) {
    // In-flight work belongs to the native process that reported it; a new process starts unreported.
    s.background = null; s.scheduled = null; s.backgroundKinds = null; s.backgroundAt = null; s.backgroundStale = false;
    // A new native process starts with an empty prompt. Any later keystroke may leave an unsent draft there;
    // only a new process clears this, since a submitted prompt may have been machine input, not the draft.
    s.terminalInputPending = false;
    runtime.addressedCall = (identity, args) => addressed.accept(this, s, runtime, identity, args);
    runtime.operatorCall = (identity, name, args) => this.operator.call(s, runtime, identity, name, args);
    runtime.addressedFailed = identity => addressed.failed(this, s, runtime, identity);
    const on = (event, handler) => runtime.on(event, (...args) => {
      if (this.runtimes.get(s.id) === runtime) handler(...args);
    });
    on('nativeGoal', () => { this.changed(); this.goalContinuationBoundary(s.id); });
    on('goalContinuationReady', () => this.goalContinuationBoundary(s.id));
    if (!this.progress.has(s.id)) this.progress.set(s.id, new ProgressJournal());
    for (const id of this.progress.keys()) {
      if (this.progress.size <= 12) break;
      if (!this.runtimes.has(id)) { this.progress.delete(id); this.observedTerminals.delete(id); }
    }
    on('progress', item => {
      const update = this.progress.get(s.id)?.update(item);
      if (update) this.emit('progress', { id: s.id, ...update });
      if (update && !runtime.nativeBlocks && ['claude-native-message', 'claude-hook'].includes(item.source)) {
        const value = update.item;
        applyNativeBlock(s, { ...value, id: `observation:${value.id}`, nativeId: s.nativeId, kind: 'tool',
          incomplete: value.truncated, title: value.title || '原生过程记录', uiTitleMessage: value.title ? value.uiTitleMessage : uiNotice('notice.nativeProcessTitle').uiMessage, status: value.status === 'completed' ? 'complete' : value.status });
        this.changed(s.id);
      }
      const nativeProgress = applyCodexProgress(s, item);
      if (nativeProgress) {
        this.sharedReplies.record(s, nativeProgress);
        this.changed(s.id);
      }
    });
    on('nativeBlock', item => { if (item.kind === 'gap') { s.peerRevision = (s.peerRevision || 0) + 1; this.peerLeases?.revoke('原生观察连接出现缺口；请核对后重新授权。', s.id, undefined, uiActivity('notice.peer.observationBoundary')[1]); this.pauseParticipant(s.id, '原生观察连接出现缺口，请核对后重新授权。', false, uiActivity('notice.run.observationGap')[1]); } if (applyNativeBlock(s, item, this.dataDir)) { this.sharedReplies.record(s, s.messages.find(m => m.id === `native:${item.nativeId}:${item.id}`)); this.changed(item.kind === 'gap' ? undefined : s.id); } });
    on('replyBound', identity => {
      // An accepted native receipt can annotate its exact existing input for
      // reading. This metadata grants no new sharing or execution authority.
      const input = s.messages.find(m => m.id === identity.tag && m.role === 'user');
      if (input && identity.nativeId === s.nativeId && typeof identity.turnId === 'string' && identity.turnId &&
        (!input.nativeId || input.nativeId === identity.nativeId) && (!input.turnId || input.turnId === identity.turnId)) {
        input.nativeId = identity.nativeId; input.turnId = identity.turnId;
      }
      this.sharedReplies.bind(s, identity.tag, identity); this.changed();
    });
    on('contextEnd', info => this.endNativeContext(s, runtime, info));
    on('contextClear', info => this.clearNativeContext(s, runtime, info));
    on('background', info => { if (this.runtimes.get(s.id) !== runtime || info.nativeId !== s.nativeId) return;
      setActivity(s, ...uiActivity("notice.activity.claudeBackground", { arg1: info.backgroundId.slice(0, 8), arg2: info.backgroundId.slice(0, 8) })); });
    on('sharingBoundary', reason => this.peerLeases?.revoke('原生输入或权限边界已变化：' + reason, s.id, undefined, { version: 1, key: 'notice.peer.nativeBoundary', params: { reason } }));
    on('nativeControlBoundary', reason => { s.peerRevision = (s.peerRevision || 0) + 1; if (reason === 'control:input') wake.messageInput(this, s, { peer: 1 }); this.peerLeases?.revoke('原生输入或权限边界已变化：' + reason, s.id, undefined, { version: 1, key: 'notice.peer.nativeBoundary', params: { reason } }); });
    on('capability', () => this.changed());
    on('nativeTurnStart', info => wake.nativeStart(this, runtime, info, s));
    // Reading only: the inputs a native turn started from head its group. A row
    // gains a missing turn and grants no sharing. It is not moved, except a prompt
    // typed during an earlier turn (`-q` row, T-138): it moves to where its own turn
    // begins, after the earlier turn's reply, as the native terminal shows it. A typed
    // prompt's row comes from the settings hook on its own socket and can land
    // after its turn start: that link waits, bounded, for the row.
    const pendingPrompts = new Map();
    const linkTurn = (m, turnId) => {
      if (!m || m.turnId || m.nativeId && m.nativeId !== s.nativeId) return false;
      m.nativeId = s.nativeId; m.turnId = turnId; return true;
    };
    const typedRow = id => s.messages.find(m => m.id === `claude-prompt-${id}` && m.role === 'user' && m.origin === 'native');
    on('nativeTurnTriggers', info => {
      if (info.nativeId !== s.nativeId) return;
      let linked = false;
      for (const id of info.prompts) {
        const m = typedRow(id);
        if (m && linkTurn(m, info.turnId)) {
          linked = true;
          if (/-q[0-9a-f]{8}$/.test(id)) { const i = s.messages.indexOf(m); if (i >= 0 && i < s.messages.length - 1) { s.messages.splice(i, 1); s.messages.push(m); } }
        }
        else { pendingPrompts.set(id, { nativeId: s.nativeId, turnId: info.turnId }); while (pendingPrompts.size > 16) pendingPrompts.delete(pendingPrompts.keys().next().value); }
      }
      const rows = new Set(info.rows.map(id => `native:${s.nativeId}:${id}`));
      for (const m of s.messages) if (rows.has(m.id) && m.commandSource === 'userShell') linked = linkTurn(m, info.turnId) || linked;
      if (linked) this.changed();
    });
    // T-133: an image in a prompt typed in the terminal (2.1.316/2.1.317) enriches that prompt's row: the row of
    // the same prompt id (claude-prompt-<id> or its -q<tag> row, T-138) whose text has the same tag. No
    // first-text memory is involved, so a reload or restart cannot misplace it. The row comes from the settings
    // hook on its own socket and can land after the image: that waits, bounded.
    const pendingPromptImages = new Map();
    const textTag = require('./adapters.cjs').promptTextTag;
    const promptRow = (promptId, tag) => s.messages.find(m => m.role === 'user' && m.origin === 'native' && typeof m.text === 'string' &&
      (m.id === `claude-prompt-${promptId}` || m.id === `claude-prompt-${promptId}-q${tag}`) && textTag(m.text) === tag);
    const applyPromptImage = (row, event) => {
      if (!row || event.nativeId !== s.nativeId || row.nativeId && row.nativeId !== event.nativeId) return false;
      // The image viewer checks the row's native session; set before the payload is checked, so counted here.
      row.nativeId = event.nativeId; this.edited(s);
      return require('./native-images.cjs').applyImagePayload(row, event.imagePayload, this.dataDir, s.id);
    };
    on('nativePromptImage', event => {
      const row = promptRow(event.promptId, event.tag);
      if (row) { if (applyPromptImage(row, event)) this.changed(); return; }
      if (event.nativeId !== s.nativeId) return;
      const key = `${event.promptId}:${event.tag}`;
      pendingPromptImages.set(key, [...(pendingPromptImages.get(key) || []), event].slice(0, 17));
      while (pendingPromptImages.size > 8) pendingPromptImages.delete(pendingPromptImages.keys().next().value);
    });
    on('nativeInput', (text, item) => {
      const promptId = /^claude-prompt-([a-f0-9-]{36})(?:-q[a-f0-9]{8})?$/i.exec(item?.id || '')?.[1], tag = promptId && typeof text === 'string' ? textTag(text) : null;
      const waiting = tag && pendingPromptImages.get(`${promptId}:${tag}`);
      if (!waiting) return;
      pendingPromptImages.delete(`${promptId}:${tag}`);
      // Runs after the input's own handler has stored its row.
      queueMicrotask(() => { let changed = false; for (const event of waiting) changed = applyPromptImage(promptRow(promptId, tag), event) || changed; if (changed) this.changed(); });
    });
    on('nativeInput', (text, item) => {
      const id = /^claude-prompt-(.+)$/.exec(item?.id || '')?.[1], pending = id && pendingPrompts.get(id);
      if (!pending) return;
      pendingPrompts.delete(id);
      // Runs after the input's own handler has stored its row.
      queueMicrotask(() => { if (pending.nativeId === s.nativeId && linkTurn(typedRow(id), pending.turnId)) this.changed(); });
    });
    on('nativeTurnEnd', info => {
      try { this.operator.turnEnd(s.id, info); } catch { /* Saved reports remain, even if the later annotation cannot be written. */ }
      try { wake.complete(this, s, runtime, info); } catch { this.changed(); }
      const codexVersion = runtime.host?.rpc?.nativeVersion;
      const qualified = s.provider === 'codex' ? require('./codex-qualification.cjs').allows('capacity', codexVersion) : s.provider === 'claude' && runtime.nativeCapacityAvailable && !runtime.retainedReader;
      // Other is broad: admit only the observed native routing timeout verbatim.
      // A refused request (typed HTTP 403) is Claude's own cause; a Codex error kind never arms it.
      const reason = info.errorInfo === 'serverOverloaded' ? 'capacity' : s.provider === 'codex' && info.errorInfo === 'other' && info.errorMessage === 'workspace routing discovery timed out' ? 'routing'
        : s.provider === 'claude' && info.errorInfo === 'requestForbidden' ? 'forbidden' : null;
      if (qualified && info.nativeId === s.nativeId && info.status === 'failed' && reason) this.scheduleCapacity(s, runtime, info.turnId, reason);
      else this.cancelCapacity(s.id);
    });
    on('inputRequired', () => this.changed());
    on('pid', pid => { s.pid = pid; s.processIdentity = processIdentity(pid); s.serverIdentity = s.provider === 'codex' ? processIdentity(runtime.host?.codexProcess?.pid) : null; this.changed(); });
    // Kept with the record: the vendor icon needs it before the session runs again.
    on('modelProvider', value => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || s.modelProvider === value) return;
      s.modelProvider = value; this.changed(); this.persist();
    });
    on('model', (model, uiMessage) => { s.model = model; const message = displayMessage(uiMessage, 'notice.', model); if (message) s.modelUiMessage = message; else delete s.modelUiMessage; this.changed(); });
    on('askQuestion', ask => this.holdQuestion(s, runtime, ask));
    // Only a session nobody named takes the native title; a rename is a desktop label and always wins.
    on('nativeTitle', title => { const clean = String(title).replace(/[\x00-\x1f\x7f]/g, ' ').trim(); const name = clean && `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${clean}`.slice(0, 60); if (s.autoName && name && (name !== s.name || s.nameSource !== 'native')) { s.name = name; s.nameSource = 'native'; this.changed(); } });
    on('state', state => {
      if (this.stops.has(s.id) && !['ended', 'recoverable', 'error', 'disconnected'].includes(state)) return;
      // A new Claude turn may start or stop background work; the previous turn-end report no longer confirms it.
      if (state === 'working' && s.provider === 'claude') s.backgroundStale = true;
      if (state !== s.state) { runtime.toolWaitQuietResetAt = Date.now(); runtime.toolWaitNotice = null; }
      if (['approval', 'ended', 'background', 'recoverable', 'disconnected'].includes(state) || state === 'working' && this.capacityRecoveries.get(s.id)?.status === 'scheduled') this.cancelCapacity(s.id);
      s.state = state;
      if (['ended', 'background', 'recoverable', 'error', 'disconnected'].includes(state)) for (const m of s.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed';
      if (runtime.transportDisconnected || ['disconnected', 'ended', 'background', 'recoverable'].includes(state)) s.fleet = (s.fleet || []).map(item => ({ ...item, stale: true }));
      if (state !== 'approval') s.approvalResolved = false;
      if (['ended', 'background', 'recoverable', 'error', 'disconnected'].includes(state)) this.releaseQuestion(s, null);
      if (runtime.transportDisconnected) { s.approval = null; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(s.id); }
      if (state !== 'starting' && s.activity === '正在连接原生历史') setActivity(s, '');
      if (['ended', 'background', 'recoverable'].includes(state)) {
        if (runtime.terminal) this.observedTerminals.set(s.id, runtime.terminal);
        if (s.pendingTag) this.deliveryStatus(s.pendingTag, 'unconfirmed');
        s.pid = null; s.pendingTag = null; s.approval = null; s.approvals = []; s.approvalOverflow = false; this.runtimes.delete(s.id);
        this.approvalRoutes.delete(s.id);
      }
      if (state === 'idle') this.goalContinuationBoundary(s.id);
      if (state === 'working') this.peerLeases?.working(s.id);
      if (state === 'approval') { s.peerRevision = (s.peerRevision || 0) + 1; this.pauseParticipant(s.id, '等待原生权限确认', false, uiActivity('notice.run.approval')[1]); }
      if (state === 'working' && this.activeRun(s.id) && this.activeRun(s.id).awaiting?.sessionId !== s.id) this.pause('成员开始了本轮之外的原生工作，请核对后再交接。', undefined, false, uiActivity('notice.run.outsideWork')[1]);
      if (['ended', 'background', 'recoverable', 'error'].includes(state)) this.pauseParticipant(s.id, '原生会话不可用', false, uiActivity('notice.run.nativeUnavailable')[1]);
      // 'working' changes no rows here; what it sets off elsewhere (a pause, a cancelled retry) reports its own change.
      this.changed(state === 'working' ? s.id : undefined);
    });
    on('terminal', event => {
      if (s.state === 'approval') runtime.reconcileLocalApproval?.();
      const dialog = terminalDialogPrompt(s, runtime);
      if (runtime.terminalDialogObserved !== dialog) { runtime.terminalDialogObserved = dialog; this.changed(); }
      const prompt = directoryTrustPrompt(s, runtime);
      if (Boolean(prompt) !== Boolean(runtime.directoryTrustObserved)) { runtime.directoryTrustObserved = prompt; this.changed(); }
      if (runtime.terminal) this.observedTerminals.set(s.id, runtime.terminal);
      this.emit('terminal', { id: s.id, ...event });
    });
    // A tool call's activity and its state 'working', and usage, touch no messages: they name their own session.
    on('activity', (text, uiMessage) => { setActivity(s, text, uiMessage); this.changed(s.id); });
    // Background task IDs this session started or last reported in flight. Kept across turn ends: a task listed once
    // may finish during a later turn, whose report no longer lists it. Used up when the task's notification says it
    // ended; a new native process starts with none.
    const rememberTasks = ids => {
      const known = runtime.backgroundTaskIds ||= new Set();
      for (const id of ids) { known.delete(id); known.add(id); }
      while (known.size > 200) known.delete(known.values().next().value);
    };
    on('backgroundStarted', id => rememberTasks([id]));
    on('background', info => {
      s.background = info.count; s.scheduled = info.scheduled; s.backgroundKinds = Array.isArray(info.kinds) ? info.kinds : null; s.backgroundAt = Date.now(); s.backgroundStale = false;
      rememberTasks(Array.isArray(info.ids) ? info.ids : []);
      if ([info.count, info.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) this.nativeWorkObserved(s.id, '原生报告仍有后台或定时工作，请核对后再交接。', uiActivity('notice.run.backgroundObserved')[1]);
      this.changed();
    });
    on('usage', usage => { s.usage = usage; this.changed(s.id); });
    on('accountUsage', () => this.changed());
    on('fleet', item => {
      s.fleet.push({ ...item, time: Date.now(), stale: false }); s.fleet = s.fleet.slice(-80);
      // A notice naming background work follows it while the interrupt waits.
      if (['notice.activity.interruptWaitsForSubagent', 'notice.activity.interruptWaitsForBackground'].includes(s.activityUiMessage?.key)) setActivity(s, ...interruptActivity(s));
      if (item.active === true || ['SubagentStart', 'thread/started', 'collabAgentSpawnToolCall'].includes(item.event)) this.nativeWorkObserved(s.id, '观察到原生团队活动，后续转交已暂停；原生团队继续保留。', uiActivity('notice.run.teamObserved')[1]);
      this.changed();
    });
    on('approval', (approval, rpc = this.host.rpc) => {
      s.peerRevision = (s.peerRevision || 0) + 1;
      let queue = this.approvalRoutes.get(s.id);
      if (!queue) this.approvalRoutes.set(s.id, queue = new ApprovalQueue(randomUUID));
      queue.add(approval, rpc, runtime); Object.assign(s, queue.snapshot()); s.approvalResolved = false;
      this.pauseParticipant(s.id, '等待原生权限确认', false, uiActivity('notice.run.approval')[1]); this.changed();
    });
    on('approvalResolved', (nativeRequestId, rpc = this.host.rpc) => {
      const queue = this.approvalRoutes.get(s.id);
      if (!queue || !queue.entries.some(r => r.rpc === rpc && r.nativeRequestId === nativeRequestId)) return;
      queue.resolve(nativeRequestId, rpc); Object.assign(s, queue.snapshot());
      if (!queue.entries.length && !queue.overflow) this.approvalRoutes.delete(s.id);
      s.approvalResolved = !s.approval && !queue.overflow && s.state === 'approval';
      this.changed();
    });
    on('approvalUnavailable', rpc => {
      const queue = this.approvalRoutes.get(s.id);
      if (!queue || (!queue.entries.some(r => r.rpc === rpc) && !queue.overflowSources.has(rpc))) return;
      queue.removeSource(rpc); Object.assign(s, queue.snapshot()); s.approvalResolved = false;
      if (!queue.entries.length && !queue.overflow) this.approvalRoutes.delete(s.id);
      setActivity(s, ...uiActivity("notice.activity.approvalConnectionChanged")); this.changed();
    });
    on('nativeInput', (text, item) => {
      // Machine-injected turns are not a person at the terminal. Claude 2.1.316 sends no hook source,
      // so a turn made only of notifications for tasks this session started or last reported in flight also counts.
      // On 2.1.322 most notifications arrive during the turn that started the task, before any turn-end report.
      const blocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/g), onlyBlocks = Boolean(blocks) && !text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
      const taskIds = onlyBlocks ? blocks.map(block => /<task-id>\s*([A-Za-z0-9_-]{1,64})\s*<\/task-id>/.exec(block)?.[1]) : [];
      // `naw-peer`: a Claude Code cross-session message, tagged by NAW's mod from the engine's origin (T-137).
      // Not the person: no wake.human, pause or controlRevision. Its submission still sends the mod's
      // control:input boundary (nativeControlBoundary below), which voids wakes staged by or for this session.
      const sourced = ['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event', 'naw-peer'].includes(item?.source);
      const reported = !sourced && !['user', 'sdk'].includes(item?.source) && onlyBlocks && taskIds.every(id => id && runtime.backgroundTaskIds?.has(id));
      // A monitor notifies once per event and once when it ends, with the same ID; only a block with a status ends the task
      // (real 2.1.322: an event carries task-id, summary and event; an end, like a finished Bash, a status). What a watched
      // command printed into an event or a summary is not the block's own status.
      if (reported) blocks.forEach((block, i) => { if (/<status>/.test(block.replace(/<(event|summary)>[\s\S]*?<\/\1>/g, ''))) runtime.backgroundTaskIds.delete(taskIds[i]); });
      const machine = sourced || reported, inputSource = sourced ? item.source : reported ? 'task-notification' : null;
      // Missing source is not proof of human authorship for report questions.
      if (!machine && item?.source === 'user') this.operatorHuman(s.id);
      this.cancelCapacity(s.id);
      // It still interrupts a desktop send it displaced; that send is not retried.
      if (!machine) { wake.human(this, s.id); this.pause('真人在原生终端输入', undefined, false, uiActivity('notice.run.humanTerminalInput')[1]); s.controlRevision++; wake.messageInput(this, s, { control: 1 }); }
      else if (item?.superseded) { this.pause('原生自动输入抢在交接发送之前开始；请核对后再继续。', undefined, false, uiActivity('notice.run.machineSuperseded')[1]); s.controlRevision++; }
      runtime.workspaceMcpCalls?.clear();
      if (item?.turnId && item.turnId === runtime.turnId) wake.nativeStart(this, runtime, { nativeId: s.nativeId, turnId: item.turnId }, s);
      // Machine turns keep their place but are not shown as the person's words.
      const summaries = machine && onlyBlocks ? blocks.map(block => /<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1]?.trim()).filter(Boolean) : [];
      // The original text is kept for search and history; the summary is only what the reader shows.
      const peer = inputSource === 'naw-peer' ? this.peerMessage(text) : null;
      const shown = summaries.length && summaries.length === blocks.length ? { name: '后台任务通知', uiNameMessage: uiNotice('notice.name.backgroundNotification').uiMessage, displayText: summaries.join('\n') }
        : peer ? { name: peer.name, uiNameMessage: peer.uiNameMessage, ...(peer.body !== null ? { displayText: peer.body } : {}) }
        : machine ? { name: inputSource.endsWith('_wakeup') ? '定时唤醒' : '原生自动输入', uiNameMessage: uiNotice(inputSource.endsWith('_wakeup') ? 'notice.name.scheduledWake' : 'notice.name.nativeAutomaticInput').uiMessage } : {};
      if (item?.display !== false && (!item?.id || !s.messages.some(m => m.id === item.id))) {
        s.messages.push({ id: item?.id || randomUUID(), role: 'user', text, ...shown, status: 'submitted', origin: 'native', ...(machine ? { inputSource } : {}), time: Date.now() });
        if (peer) this.mirrorPeer(s, peer, Date.now(), text);
      }
      this.changed();
    });
    // A prompt typed during a turn and taken back from native's queue unsent (edited with ↑, deleted, cleared on
    // cancel): the native terminal no longer shows it as sent, so neither does the conversation.
    on('nativeInputWithdrawn', ({ id, nativeId }) => {
      if (nativeId !== s.nativeId || !/^claude-prompt-[a-f0-9-]{36}-q[a-f0-9]{8}$/i.test(id || '')) return;
      const at = s.messages.findIndex(m => m.id === id && m.role === 'user' && m.origin === 'native' && (!m.nativeId || m.nativeId === nativeId) && !m.turnId);
      if (at < 0) return;
      s.messages.splice(at, 1); this.changed();
    });
    on('nativeInputImages', event => { if (require('./native-images.cjs').applyInputImages(s, event)) this.changed(); });
    on('spaceImagesAccepted', receipt => {
      if (receipt?.nativeId !== s.nativeId || receipt.basis !== 'native-local-image-echo') return;
      const room = this.rooms.get(receipt.roomId), row = room?.messages.find(m => m.id === receipt.tag);
      if (!row || row.recipientId !== s.id || row.imageReceipt?.nativeId !== s.nativeId || row.imageDraftVersion !== receipt.version ||
          JSON.stringify(row.images) !== JSON.stringify(receipt.images)) return;
      row.imageReceipt = { ...row.imageReceipt, status: 'accepted', nativeItemId: receipt.nativeItemId, turnId: receipt.turnId, basis: receipt.basis, time: receipt.time };
      this.changed(); this.persist();
    });
    on('history', (items, turns, recovery) => { applyCodexHistory(s, items, runtime, id => this.deliveryStatus(id, 'submitted'), turns, recovery); this.changed(); });
    on('turnHistory', turns => { applyCodexTurnHistory(s, turns, runtime); this.sharedReplies.restoreTurnMetadata(s); this.changed(); });
    on('midturnRead', ({ tag, turnId }) => {
      // The running turn's next model request carried it (bridge-observed, 2.1.322 and 2.1.323).
      let found = false;
      for (const list of this.messageLists(s)) for (const m of list) if (m.id === tag && m.deliveredInto) { m.nativeRead = true; found = true; }
      // The person's words read in the turn they were queued into: it may send again (the wake proposal, item 3).
      if (found) { wake.humanRead(this, runtime, s, tag, turnId); this.changed(); }
    });
    on('submitted', tag => {
      const input = s.messages.find(m => m.id === tag);
      // Only this runtime's own input can certify its shared delivery.
      if (!input) return;
      if (input && ['human', 'human-mobile'].includes(input.origin)) this.operatorHuman(s.id);
      for (const list of this.messageLists(s)) { const m = list.find(m => m.id === tag); if (m) m.status = 'submitted'; }
      this.deliveryStatus(tag, 'submitted'); this.changed();
    });
    on('interrupted', ({ tag }) => {
      this.cancelCapacity(s.id); this.endUnidentifiedWait(s);
      if (tag) {
        if (s.pendingTag === tag) s.pendingTag = null;
        this.forwards.delete(tag); this.sharedReplies.close(tag, '原生已中断本轮', uiActivity('notice.run.turnInterrupted')[1]);
      }
      setActivity(s, ''); this.pauseParticipant(s.id, '原生已中断本轮', false, uiActivity('notice.run.turnInterrupted')[1]); this.changed();
    });
    on('unattributed', tag => {
      if (s.pendingTag !== tag && !this.forwards.has(tag)) return;
      if (s.pendingTag === tag) s.pendingTag = null;
      const shared = this.sharedMessage(tag);
      if (shared) shared.status = 'reply-private';
      this.forwards.delete(tag); this.sharedReplies.close(tag, '回复归属未确认', uiActivity('notice.sharing.originUnconfirmed')[1]);
      setActivity(s, ...uiActivity("notice.activity.inputAcceptedReplyUnconfirmed"));
      this.pauseParticipant(s.id, s.activity, false, s.activityUiMessage); this.changed();
    });
    on('delta', item => { this.sharedReplies.record(s, applyCodexDelta(s, item)); this.changed(s.id); });
    on('messageItem', item => { this.sharedReplies.record(s, applyCodexMessage(s, item)); this.changed(s.id); });
    on('complete', info => {
      this.cancelCapacity(s.id); this.endUnidentifiedWait(s);
      // Only the adapter's verified native identity can authorize a forward.
      // An untagged completion can clear bookkeeping, never share its body.
      const forwardTag = info.tag || (s.provider === 'claude' ? s.pendingTag : null);
      if (s.provider === 'claude' || !s.pendingTag || s.pendingTag === info.tag || s.pendingTag === info.supersededTag) { s.pendingTag = null; setActivity(s, ''); if (!this.approvalRoutes.has(s.id)) s.approval = null; }
      if (s.provider === 'claude' && info.text && !runtime.nativeBlocks) s.messages.push({ id: randomUUID(), role: 'assistant', text: info.text, status: 'complete' });
      const forward = this.forwards.get(forwardTag);
      const shared = forward && forwardTag === info.tag && spaces.isMember(s, forward.roomId || 'shared') && forward.member === spaces.membershipRevision(s, forward.roomId || 'shared') && forward.control === s.controlRevision && info.text && this.sharedReplies.final(s, info);
      const displayedPlan = forward && forwardTag === info.tag && !info.text && this.sharedReplies.hasCompletedPlan(s, forwardTag);
      if (forward && !shared && !displayedPlan) { const message = this.sharedMessage(forwardTag); if (message) message.status = 'reply-private'; }
      this.forwards.delete(forwardTag);
      this.changed();
      const run = this.activeRun(s.id);
      this.peerLeases?.complete(s, info);
      this.advance(s, info).catch(error => { this.pause(error.message, run, false, error.uiMessage); });
      this.sharedReplies.close(forwardTag, displayedPlan ? '原生计划已显示，本轮已结束' : '原生回复已结束；未确认内容留在原会话', uiActivity(displayedPlan ? 'notice.sharing.planEnded' : 'notice.sharing.nativeReplyEnded')[1]);
    });
    on('failed', (reason, info, uiMessage) => {
      // An unscoped native error affects this observation connection, including
      // a shared input waiting for its ACK while the older private tag remains.
      if (!info) for (const grant of this.sharedReplies.grants.values()) {
        if (grant.sessionId === s.id && grant.runtime === runtime) this.sharedReplies.close(grant.tag, '原生状态未确认', uiActivity('notice.sharing.nativeUnconfirmed')[1]);
      }
      this.sharedReplies.close(info ? info.tag : s.pendingTag, '原生状态未确认', uiActivity('notice.sharing.nativeUnconfirmed')[1]); for (const m of s.messages) if (['streaming', 'running'].includes(m.status)) m.status = 'unconfirmed'; this.deliveryStatus(info?.tag || s.pendingTag, 'unconfirmed'); if (!info || s.pendingTag === info.tag || s.pendingTag === info.supersededTag) s.pendingTag = null; setActivity(s, reason, uiMessage); this.pauseParticipant(s.id, reason, false, uiMessage); this.changed(); });
  }
  endNativeContext(s, runtime, info) {
    if (this.runtimes.get(s.id) !== runtime || info.nativeId !== s.nativeId) return;
    // send() may have cleared its draft before the native ACK. Preserve that
    // exact pending draft now, before revoking its control generation, but never
    // overwrite a newer human edit. A late acceptance will not clear it again.
    const pending = this.pendingDrafts.get(s.id);
    if (pending && pending.tag === s.pendingTag && this.draftRevisions.get(s.id) === pending.revision && !this.drafts.get(s.id)) {
      this.drafts.set(s.id, pending.text); this.draftRevisions.set(s.id, (pending.revision || 0) + 1);
    }
    if (s.pendingTag) {
      this.deliveryStatus(s.pendingTag, 'unconfirmed');
      for (const list of this.messageLists(s)) {
        const m = list.find(m => m.id === s.pendingTag);
        if (m?.status === 'awaiting-native') m.status = 'unconfirmed';
        else if (m && list !== s.messages) m.status = 'reply-private';
      }
      this.forwards.delete(s.pendingTag);
    }
    s.pendingTag = null; s.approval = null; s.approvalResolved = false; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(s.id);
    s.controlRevision++; s.memberRevision++; if (s.roomMembershipRevisions) s.roomMembershipRevisions.shared = s.memberRevision; s.connectionRevision = (s.connectionRevision || 0) + 1;
    s.fleet = (s.fleet || []).map(item => ({ ...item, stale: true }));
    s.nativeContextPending = ['clear', 'resume', 'terminal-switch'].includes(info.reason) ? { nativeId: info.nativeId, reason: info.reason } : null;
    setActivity(s, ...uiActivity(info.reason === 'resume' ? 'notice.activity.contextResumeUnsupported' : info.reason === 'terminal-switch' ? 'notice.activity.contextChecking' : info.reason === 'clear' ? 'notice.activity.contextChangedChecking' : 'notice.activity.contextEnding'));
    this.pauseParticipant(s.id, '成员的原生上下文已改变；请重新确认共享内容。', false, uiActivity('notice.run.contextChanged')[1]); this.changed();
  }
  clearNativeContext(s, runtime, info) {
    if (this.closed || this.stops.has(s.id) || this.runtimes.get(s.id) !== runtime ||
      s.nativeContextPending?.nativeId !== info.previousId ||
      !(['clear', 'terminal-switch'].includes(s.nativeContextPending.reason) || (s.nativeContextPending.reason === 'resume' && info.reason === 'branch'))) return;
    if (this.storageWarning) return;
    if (s.nativeId === info.previousId) {
      for (const message of s.messages) if (!message.nativeId) message.nativeId = info.previousId;
      const boundaryId = randomUUID(), time = Date.now();
      s.nativeContexts ||= [];
      s.nativeContexts.push({ nativeId: info.previousId, endedAt: time, boundaryId, reason: info.reason || 'clear' });
      s.messages.push({ id: boundaryId, role: 'system', kind: 'context', name: '原生上下文', uiNameMessage: uiNotice('notice.name.nativeContext').uiMessage, ...uiNotice(info.reason === 'terminal-switch' ? 'notice.contextSwitched' : info.reason === 'branch' ? 'notice.contextBranched' : 'notice.contextCleared'), nativeId: info.nativeId, time });
      s.nativeId = info.nativeId; s.model = info.model; s.modelUiMessage = displayMessage(info.modelUiMessage, 'notice.', info.model) || undefined; s.nativeSettings = null; s.background = null; s.scheduled = null; s.usage = null;
      // Same native process: work started before the switch is not confirmed either way until the next turn-end report.
      s.backgroundStale = s.provider === 'claude';
      if (info.reason === 'terminal-switch' && typeof info.cwd === 'string' && path.isAbsolute(info.cwd)) s.cwd = info.cwd;
    } else if (s.nativeId !== info.nativeId || s.nativeContexts?.at(-1)?.nativeId !== info.previousId) return;
    // Identity, old-context references and the boundary are one saved snapshot.
    // A failed write leaves GUI submission closed; retrying metadata cannot add
    // a second boundary or replay a model task.
    const pending = s.nativeContextPending; s.nativeContextPending = null; setActivity(s, ''); this.persist();
    if (this.storageWarning) s.nativeContextPending = pending;
    else info.committed = true;
    this.changed();
  }
  // T-137: a resident wake also appears in the spaces its sender and recipient share (else in the
  // sender's own), so the person can follow agent-to-agent messages where they collaborate. Only the
  // sender's backend writes it. The row refers to the sender's wake record; its text, status and reason
  // are read from that record when shown. As a system row with a fresh id and no finalReply, sourceTag or
  // sessionId, no handoff or agent-input path reads it; clearing the space's shared history removes it.
  mirrorWake(s, intent, target, row) {
    // The sender's membership was checked when it loaded (a bad record blocks wakes); never let it fail staging.
    let own; try { own = spaces.roomIds(s); } catch { return; }
    // Another backend's record that cannot be read counts as sharing no space: fall back to the sender's own.
    let theirs = new Set(); try { theirs = new Set(spaces.roomIds(target || {})); } catch { /* no shared space */ }
    const common = own.filter(id => theirs.has(id));
    for (const id of common.length ? common : own) {
      const room = this.rooms.get(id);
      // Participant IDs live inside `wake`, never at the top level, so no reply or handoff path treats the row as an agent's.
      if (room) room.messages.push({ id: randomUUID(), role: 'system', kind: 'agent-wake', name: `${s.name || '会话'} → ${target?.name || '会话'}`,
        wake: { id: intent.id, senderId: s.id, recipientId: intent.recipientId, senderName: s.name || '', recipientName: target?.name || '', body: intent.body },
        text: String(row?.text || ''), time: intent.time });
    }
  }
  // T-137: the sender of a cross-session message, read only after the engine's origin proved it one.
  // `from` and `from-name` are text inside the message; nothing shows the engine sets them from the
  // connection, so every sender is marked 未核实. A `from` socket whose pid is a NAW Claude session here
  // is shown by that session's name, as a process-number match.
  peerMessage(text) {
    const outer = /^\s*<cross-session-message((?:\s+[a-z-]{1,20}="[^"<>]{0,512}")*)\s*>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/.exec(String(text));
    if (!outer) return { name: '会话间消息', uiNameMessage: uiNotice('notice.name.peerMessage').uiMessage, body: null, senderId: null, senderName: '' };
    const attrs = Object.fromEntries([...outer[1].matchAll(/([a-z-]{1,20})="([^"<>]{0,512})"/g)].map(m => [m[1], m[2]]));
    const pid = /^uds:\/tmp\/cc-socks\/(\d{1,10})\.sock$/.exec(attrs.from || '')?.[1];
    const sender = pid ? [...this.sessions.values()].find(s => s.provider === 'claude' && String(s.pid) === pid) : null;
    // No control, invisible or bidirectional-formatting characters: they could reorder, split or hide the marker.
    // A claimed name is shown inside 「」 (here, in mirrorPeer and in the renderer), so it cannot contain those quotes or their lookalikes:
    // anything in it that looks like NAW's marker then visibly sits inside the claim. Its own brackets stay.
    const claimed = (attrs['from-name'] || '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u300c\u300d\u3164\ufe41-\ufe44\ufeff\uff62\uff63\uffa0\ufff9-\ufffb]/g, '').trim().slice(0, 80);
    const who = sender ? `${sender.name || '会话'}（按进程号对应，未核实）` : claimed ? `「${claimed}」（未核实）` : '未知会话';
    const label = sender ? sender.name ? uiNotice('notice.name.peerPid', { name: sender.name }) : uiNotice('notice.name.peerPidUnnamed') : claimed ? uiNotice('notice.name.peerClaimed', { name: claimed }) : uiNotice('notice.name.peerUnknown');
    return { name: `会话间消息 · 来自 ${who}`, uiNameMessage: label.uiMessage, body: outer[2], senderId: sender?.id || null, senderName: sender ? sender.name || '' : claimed };
  }
  // T-137: a cross-session message also appears in the spaces of the session that received it (the ones
  // it shares with a local sender, else its own). Only the receiving backend writes it: it holds the proof
  // of delivery and covers senders NAW does not run. Same row rules as a wake: a system row with a fresh
  // id and the participants inside `peerMessage`, so no reply, share or handoff path reads it; final at arrival.
  mirrorPeer(s, peer, time, original) {
    let own; try { own = spaces.roomIds(s); } catch { return; }
    const sender = peer.senderId ? this.sessions.get(peer.senderId) : null;
    let theirs = new Set(); try { if (sender) theirs = new Set(spaces.roomIds(sender)); } catch { /* no shared space */ }
    const common = own.filter(id => theirs.has(id));
    for (const id of common.length ? common : own) {
      const room = this.rooms.get(id);
      // The stored name carries the mark too: merged copies keep `name` but not `peerMessage`.
      const senderName = peer.senderId ? peer.senderName || '会话' : peer.senderName ? `「${peer.senderName}」` : null;
      const name = `${senderName || '未知会话'}（未核实） → ${s.name || '会话'}`;
      const nameMessage = displayMessage({ version: 1, key: senderName ? 'notice.peer.mirroredName' : 'notice.peer.mirroredUnknown', params: { ...(senderName ? { sender: senderName } : {}), recipient: s.name || '会话' } }, 'notice.', name);
      if (room) room.messages.push({ id: randomUUID(), role: 'system', kind: 'agent-peer', name, ...(nameMessage ? { uiNameMessage: nameMessage } : {}),
        peerMessage: { senderId: peer.senderId, senderName: peer.senderName || '', recipientId: s.id, recipientName: s.name || '' },
        // A text that is not one strict wrapper keeps its original, so the space never loses the content.
        text: `会话间消息（Claude Code 自带，未经 NAW 转交；发送方未核实）\n${peer.body ?? String(original ?? '')}`, uiMessage: displayMessage({ version: 1, key: 'notice.peer.mirroredText', params: { body: peer.body ?? String(original ?? '') } }, 'notice.') || undefined, time });
    }
  }
  wakeView(room) {
    if (!Array.isArray(room?.messages) || !room.messages.some(m => m?.wake)) return room;
    return { ...room, messages: room.messages.map(m => {
      if (!m.wake) return m;
      const record = this.sessions.get(m.wake.senderId)?.messages?.find(x => x.id === m.wake.id && x.wake);
      // A missing original message does not prove that its sender session was removed.
      return { ...m, text: record ? record.text : `无法核对发送方的原消息，投递结果未确认。\n${m.wake.body || ''}`, uiMessage: record ? record.uiMessage : displayMessage({ version: 1, key: 'notice.wake.senderRemoved', params: { body: m.wake.body || '' } }, 'notice.') || undefined, wakeStatus: record ? record.wake.status : 'unknown' };
    }) };
  }
  roomFor(id = 'shared', create = false) {
    if (!spaces.roomId(id)) throw uiError("error.main.invalidSpace");
    let room = this.rooms.get(id);
    if (!room && create) { room = { id, revision: 0, run: null, messages: [] }; this.rooms.set(id, room); }
    if (!room) throw uiError("error.workspace.spaceBackendRecordMissing");
    return room;
  }
  mergeSnapshot(batch) {
    const { validateBatch, materializeBatch } = require('./space-merge.cjs');
    validateBatch(batch);
    if (this.storageWarning) throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage });
    const expected = materializeBatch(batch), existing = this.rooms.get(batch.targetId);
    const operation = [...this.rooms.values()].flatMap(room => (room.snapshotBatches || []).map(marker => ({ room, marker })))
      .find(({ marker }) => marker.operationId === batch.operationId);
    if (operation) {
      if (operation.room.id !== batch.targetId || operation.marker.binding !== batch.binding ||
          JSON.stringify(operation.room.messages.filter(message => message.snapshotBatch === batch.operationId)) !== JSON.stringify(expected)) throw uiError("error.workspace.mergeConfirmationMismatch");
      copySnapshotImages(this.dataDir, batch);
      return { operationId: batch.operationId, binding: batch.binding, persisted: true };
    }
    if (existing) throw uiError("error.workspace.mergeTargetHasRecords");
    const copiedImages = copySnapshotImages(this.dataDir, batch);
    const room = { id: batch.targetId, revision: 0, run: null, messages: expected,
      snapshotBatches: [{ operationId: batch.operationId, binding: batch.binding }] };
    this.rooms.set(room.id, room); this.persist();
    if (this.storageWarning) {
      this.rooms.delete(room.id);
      // A partial save may already retain the room; never remove pixels it can reference.
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'room-records.json'), 'utf8'));
        if (Array.isArray(saved.rooms) && !saved.rooms.some(r => r.snapshotBatches?.some(m => m.operationId === batch.operationId))) copiedImages.rollback();
      } catch (error) { if (error.code === 'ENOENT') copiedImages.rollback(); }
      this.emit('change'); throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage });
    }
    this.emit('change');
    return { operationId: batch.operationId, binding: batch.binding, persisted: true };
  }
  messageLists(s) { return [s.messages, ...[...this.rooms.values()].map(r => r.messages)]; }
  sharedMessage(id) { for (const room of this.rooms.values()) { const m = room.messages.find(m => m.id === id); if (m) return m; } }
  activeRun(id) { return [...this.rooms.values()].map(r => r.run).find(run => run?.status === 'running' && (!id || run.ids?.includes(id))); }
  moveMembership(id, destination, proof) {
    const s = this.get(id), generation = spaces.placementRevision(s);
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
        !spaces.roomId(proof.operationId) || proof.operationId === 'shared' ||
        proof.nativeId !== s.nativeId || !Number.isSafeInteger(proof.revision) || proof.revision < 0 ||
        proof.connectionRevision !== (s.connectionRevision || 0) || s.nativeContextPending || this.stops.has(id)) throw uiError('error.movePlacementChanged');
    if (destination !== null && !spaces.roomId(destination)) throw uiError('error.invalidMemberAction');
    if (proof.unusedSuccessor === true && destination !== null) throw uiError('error.invalidMemberAction');
    if (proof.archiveIdle === true && destination !== null) throw uiError('error.invalidMemberAction');
    const previous = spaces.roomIds(s), last = s.placementReceipt;
    if (previous.length > 1) throw uiError('error.movePlacementAmbiguous');
    if (last?.operationId === proof.operationId) {
      if (last.nativeId !== s.nativeId || last.roomId !== destination || last.beforeRevision !== proof.revision ||
          last.revision !== generation || last.connectionRevision !== proof.connectionRevision || (previous[0] || null) !== destination) throw uiError('error.movePlacementChanged');
      return { ...last, changed: true, replayed: true };
    }
    if (proof.revision !== generation) throw uiError('error.movePlacementChanged');
    if (this.storageWarning) throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage });
    if (proof.archiveIdle === true) {
      const runtime = this.runtimes.get(id);
      // Use live runtime fields, as initial/snapshot does. This check and the
      // write below have no await between them, and precede all routing changes.
      if (!archiveIdle({ ...s, activeTurnId: runtime?.turnId || null,
        pendingQueue: runtime?.pendingQueue || null, pendingSteer: runtime?.pendingSteer || null,
        nativeInputRequired: Boolean(runtime?.nativeInputRequired), nativeApproval: runtime?.nativeApproval || null,
        ...(s.provider === 'codex' ? { nativeGoal: runtime?.nativeGoalSnapshot?.() || null } : {}),
        backendUnavailable: Boolean(runtime?.backendExitConfirmed), transportDisconnected: Boolean(runtime?.transportDisconnected) })) throw uiError('error.planWorking');
    }
    const next = spaces.withPlacement(s, destination);
    if (next === s) return { changed: false, roomId: destination, nativeId: s.nativeId, revision: generation };
    const receipt = { operationId: proof.operationId, nativeId: s.nativeId,
      previousRoomId: previous[0] || null, roomId: destination, beforeRevision: generation,
      revision: next.placementRevision, connectionRevision: s.connectionRevision || 0 };
    next.placementReceipt = receipt;
    // Cleanup may only detach an already stopped successor. Check the owning
    // writer's current runs in this synchronous mutation, after any RPC wait.
    if (proof.unusedSuccessor === true && (!['ended', 'recoverable', 'disconnected'].includes(s.state) ||
        previous.some(room => this.rooms.get(room)?.run?.status === 'running'))) throw uiError('error.movePlacementChanged');
    // Revoke old routing before committing; accepted native work is not stopped.
    for (const room of new Set([...previous, ...(destination ? [destination] : [])])) {
      this.roomFor(room, true);
      this.pauseRoom(room, '会话位置正在改变，后续交接已暂停', uiActivity('notice.run.placementChanging')[1]);
      this.rooms.get(room).revision++;
    }
    // The entire membership vector and last receipt share one workspace rename.
    // Do not publish a transient standalone position or replace the runtime record.
    let saved = this.persist({ id, next });
    if (!saved) {
      // A save error may have occurred after rename. Reconcile once, never replay.
      try {
        const recorded = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'workspace.json'), 'utf8')).sessions.find(record => record.id === id);
        saved = recorded?.nativeId === s.nativeId && recorded.placementReceipt?.operationId === receipt.operationId &&
          recorded.placementReceipt.revision === receipt.revision && JSON.stringify(spaces.roomIds(recorded)) === JSON.stringify(spaces.roomIds(next));
      } catch { /* The existing storage warning keeps routing closed. */ }
    }
    if (!saved) throw uiError('error.movePlacementUnconfirmed');
    Object.assign(s, next);
    this.sharedReplies.refresh(); this.emit('change');
    return { ...receipt, changed: true };
  }
  join(id, join, roomId = 'shared') {
    const s = this.get(id);
    // Old clients may make a literal join/leave, but cannot append a second home.
    if (join && !spaces.isMember(s, roomId) && spaces.roomIds(s).length) throw uiError('error.movePlacementUnsupported');
    let next = spaces.withMembership(s, roomId, join);
    if (next === s) return;
    const generation = spaces.placementRevision(s) + 1;
    if (!Number.isSafeInteger(generation)) throw uiError('error.movePlacementChanged');
    next = { ...next, placementRevision: generation };
    if (this.storageWarning) throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage });
    const room = this.roomFor(roomId, true);
    this.pauseRoom(roomId, join ? '成员已加入' : '成员已退出', uiActivity(join ? 'notice.run.memberJoined' : 'notice.run.memberLeft')[1]);
    Object.assign(s, next); room.revision++;
    this.changed();
    // The caller must never acknowledge an extra membership that only exists
    // in volatile memory. Failure closes dispatch, with the original on disk.
    if (roomId !== 'shared') { this.persist(); if (this.storageWarning) throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage }); }
  }
  claim(id, owner, view = 'chat', roomId, free = false) {
    const s = this.get(id);
    if (!['chat', 'terminal'].includes(view)) throw uiError("error.workspace.unknownView");
    // Taking a session no open window holds is not a takeover: nothing is paused and no queued input is revoked.
    const heldOpen = s.owner !== owner && s.owner !== null && !this.pagelessOwners.has(s.owner);
    if (free && heldOpen) return false;
    if (s.owner !== owner || s.view !== view) {
      const previous = s.owner;
      if (heldOpen) { if (!backgroundOperation.current()) wake.human(this, id); if (roomId === undefined) this.pause('真人接管会话', undefined, false, uiActivity('notice.run.humanControl')[1]); else { this.pauseParticipant(id, '真人接管会话', false, uiActivity('notice.run.humanControl')[1]); this.pauseRoom(roomId, '真人接管会话', uiActivity('notice.run.humanControl')[1]); } s.controlRevision++; }
      // Viewing the same session is not a new instruction. Real terminal input
      // still invalidates queued work; taking control from another view does too.
      s.owner = owner; s.view = view;
      // A closed or hidden window that no longer holds anything is not kept.
      if (previous !== owner && this.pagelessOwners.has(previous) && !this.viewOwners.has(previous) && ![...this.sessions.values()].some(x => x.owner === previous)) this.pagelessOwners.delete(previous);
      this.changed();
    }
    // A question held for the chat view goes back to the native dialog in the terminal.
    if (view === 'terminal') this.releaseQuestion(s, null);
  }
  viewConnected(owner, page = true) {
    const open = this.viewOwners.get(owner) || { connections: 0, pages: 0, everPage: false };
    open.connections++; if (page) { open.pages++; open.everPage = true; }
    this.viewOwners.set(owner, open);
    const was = this.pagelessOwners.has(owner);
    if (open.everPage) this.pagelessOwners.delete(owner); else this.pagelessOwners.add(owner);
    if (was !== this.pagelessOwners.has(owner)) this.changed();
  }
  release(owner, page = true, gone = false) {
    // A disconnected view is not a stop instruction. A window that only lost its connection (the app quit,
    // or its UI updated) still holds its sessions and has them when its stable owner ID reconnects. One
    // the person closed (gone) holds none against the windows still open.
    const open = this.viewOwners.get(owner);
    if (open) {
      open.connections--; if (page) open.pages--;
      if (!open.connections) this.viewOwners.delete(owner);
      if (!open.pages) {
        const pageless = (gone || !open.everPage) && (open.connections || [...this.sessions.values()].some(s => s.owner === owner));
        if (pageless) this.pagelessOwners.add(owner); else this.pagelessOwners.delete(owner);
      }
    }
    this.changed();
  }
  setDraft(id, text, owner) {
    const s = this.get(id);
    if (owner !== undefined && s.owner !== owner) throw uiError("error.workspace.controlledElsewhere");
    if (typeof text !== 'string' || text.length > 16000) throw uiError("error.main.draftTooLong");
    this.capacityCancelled(s, this.capacityRecoveries.get(id), 'draft'); this.cancelCapacity(id);
    this.drafts.set(id, text); this.draftRevisions.set(id, (this.draftRevisions.get(id) || 0) + 1); this.changed();
  }
  assertNativeContext(id, expected) {
    const s = this.get(id);
    if (s.nativeContextPending || (expected === undefined ? this.runtimes.get(id)?.rootLease : expected !== s.nativeId)) {
      throw uiError("error.client.nativeContextChanged");
    }
  }
  deliveryStatus(tag, status) {
    if (!tag) return;
    for (const room of this.rooms.values()) for (const message of room.messages) for (const delivery of message.deliveries || []) {
      // Acceptance is independent of later reply-sharing revocation or failure.
      if (delivery.id === tag && (status === 'submitted' || delivery.status !== 'submitted')) delivery.status = status;
    }
  }
  routeValid(route) { return route?.peerLease ? this.peerLeases?.valid(route) === true : this.roomFor(route?.roomId || 'shared').run === route && route?.status === 'running' && Date.now() < route.deadline; }
  mobileRead(ticket) { return require('./mobile-session.cjs').read(this, ticket); }
  mobileSend(ticket, spec) { return require('./mobile-session.cjs').send(this, ticket, spec); }
  mobileAnswer(ticket, spec) { return require('./mobile-session.cjs').answer(this, ticket, spec); }
  mobileReceipt(ticket, spec, action) { return require('./mobile-session.cjs').find(this, ticket, spec, action); }
  mobilePrepare(ticket, spec, action, client) { return require('./mobile-session.cjs').prepare(this, ticket, spec, action, client); }
  mobileCommit(ticket, lease, action, client) { return require('./mobile-session.cjs').commit(this, ticket, lease, client, action); }
  mobileCancel(ticket, lease, action, client, reason) { return require('./mobile-session.cjs').cancel(this, ticket, lease, client, action, reason); }
  mobileDisconnected(client) { return require('./mobile-session.cjs').disconnected(this, client); }
  scopedOutboxRequest(client, action, request, notify) {
    this.scopedOutboxProducer ||= new (require('./scoped-outbox-runtime.cjs').ScopedOutboxRuntime)(this);
    return this.scopedOutboxProducer.request(client, action, request, notify);
  }
  scopedOutboxDisconnected(client) { this.scopedOutboxProducer?.disconnected(client); }
  closeScopedOutbox() { this.scopedOutboxProducer?.closeAll(); }
  async sendScopedOutboxInput(s, runtime, text, tag, sender, rpc, guard) {
    if (!guard() || this.runtimes.get(s.id) !== runtime) throw require('./computer-use-outbox-native.cjs').outboxError('grant-invalidated', 'view-send');
    // The shared source-attributed row is owned by the existing GUI ledger.
    // Only this exact native input is appended here; no private draft is read.
    const input = { id: tag, role: 'user', origin: 'room', name: sender.name, text, time: Date.now(), status: 'awaiting-native' };
    s.pendingTag = tag; s.messages.push(input); this.versions.dispatches++;
    this.cancelCapacity(s.id); this.changed(); this.persist();
    try {
      if (this.storageWarning || !guard()) throw require('./computer-use-outbox-native.cjs').outboxError('grant-invalidated', 'view-send');
      await runtime.sendScopedOutbox(text, tag, guard, rpc);
      return tag;
    } catch (error) {
      if (input.status === 'awaiting-native') input.status = 'unconfirmed';
      if (this.runtimes.get(s.id) === runtime && s.pendingTag === tag) s.pendingTag = null;
      this.changed(); this.persist(); throw error;
    }
  }
  // The person's own private message stays valid while they type in that session's native terminal (the person,
  // 2026-11-13: 两边的输入可以不要锁定): keys there raise controlRevision and terminalKeys together, so only
  // another control change (a takeover, an interrupt, a turn they submit in the terminal) takes the message back.
  // Automatic, queued and handoff messages keep the plain controlRevision check: a key still takes them back.
  // Keys an agent types into the terminal (a background operation) are not counted, so they still take it back.
  ownControl(s) {
    const control = s.controlRevision, keys = this.terminalKeys.get(s.id) || 0;
    return () => s.controlRevision - (this.terminalKeys.get(s.id) || 0) === control - keys;
  }
  async send(id, text, owner, route = null, forward = null, sourceMessage = null, recovery = null, wakeTicket = null, mobile = null, images = null, dispatch = null) {
    const backgroundValid = backgroundOperation.inputGuard(this, [id], backgroundOperation.current() || route?.agentControl);
    const originalText = text; text = images && typeof text === 'string' && text.length <= 16000 && !text.trim() ? '' : cleanText(text); if (wakeTicket || mobile || backgroundOperation.current()) text = originalText;
    const mobileSession = mobile && require('./mobile-session.cjs');
    if (mobile && (!mobileSession.valid(mobile) || route || forward || sourceMessage || recovery || wakeTicket)) throw uiError("error.workspace.mobileDelegationUnconfirmed");
    const s = this.get(id); const runtime = this.runtime(id);
    const media = require('./space-images.cjs');
    if (images && (!forward || route || mobile || wakeTicket || recovery || !media.validSpaceImagePacket(images, forward.roomId || 'shared') || !runtime.spaceImagesAvailable)) throw uiError('error.roomImages.deliveryUnavailable');
    const imageTag = images && randomUUID();
    const imageSubmission = images && new media.SpaceImageSubmission(media.spaceImageRoot(this.dataDir), forward.roomId || 'shared', images.version, images.refs, s.nativeId, imageTag);
    if (dispatch && terminalDialogPrompt(s, runtime)) throw uiError("error.queue.terminalDialog");
    if (runtime.nativeAbortRequest) throw uiError("error.nativeInterruptPending");
    if (forward && !wakeTicket && text) text = originalText;
    // A NAW queue item sent under the person's automatic-message switches: never a
    // takeover, never human input, refused while the person has a draft (queue-dispatch.cjs).
    const dispatchAllowed = () => { try { return wake.enabled(this) && !s.wakeDisabled && !(this.drafts.get(id) || '').trim(); } catch { return false; } };
    if (dispatch && (route || forward || sourceMessage || recovery || wakeTicket || mobile || images)) throw uiError("error.queue.invalid");
    if (mobile) mobile.human();
    else if (dispatch) {
      if ((this.drafts.get(id) || '').trim()) throw uiError("error.queue.personTyping");
      if (!dispatchAllowed()) throw uiError("error.backgroundMessagesDisabled");
      this.pauseParticipant(id, 'NAW 派活；原协作交接保持暂停', true, uiActivity('notice.run.queueDispatch')[1]);
    } else if (wakeTicket) {
      if (!wakeTicket.valid()) throw uiError("error.workspace.automaticAuthorizationExpired");
      this.pauseParticipant(id, '原会话收到自动消息；旧协作交接已撤销', true, uiActivity('notice.run.automaticInputBoundary')[1]);
    } else if (!route) {
      if (s.owner !== owner) throw uiError("error.workspace.takeControlFirst");
      s.peerRevision = (s.peerRevision || 0) + 1;
      if (!recovery && !backgroundOperation.current()) wake.messageInput(this, s, { peer: 1 });
      if (recovery) this.pauseParticipant(id, `${RECOVERY_REASONS[recovery.reason].pause}自动继续；原协作交接保持暂停`, true, uiActivity(`notice.run.automatic${RECOVERY_REASONS[recovery.reason].key}`)[1]);
      else { if (!backgroundOperation.current()) wake.human(this, id); if (forward) { this.pauseParticipant(id, '真人输入优先', false, uiActivity('notice.run.humanPriority')[1]); this.pauseRoom(forward.roomId || 'shared', '真人输入优先', uiActivity('notice.run.humanPriority')[1]); } else this.pause('真人输入优先', undefined, false, uiActivity('notice.run.humanPriority')[1]); }
    }
    const failedTurn = !route && !dispatch && s.state === 'error' ? runtime.failedTurnInputId : null;
    if ((s.state !== 'idle' && !failedTurn && !(recovery && s.state === 'error')) || s.pendingTag || runtime.pendingQueue || s.approval || runtime.nativeInputRequired) throw uiError("error.workspace.sessionNotReady");
    if (runtime.chatAvailable === false) throw uiError(s.provider === 'claude' ? 'error.workspace.claudeSubmitDisconnected' : 'error.workspace.nativeFirstMessageRequired');
    const roomId = route?.roomId || forward?.roomId || 'shared', room = this.roomFor(roomId);
    const control = s.controlRevision; const member = spaces.membershipRevision(s, roomId); const connection = s.connectionRevision;
    const own = !route && !forward && !dispatch && !wakeTicket && !recovery && !mobile && !backgroundOperation.current();
    const sameControl = own ? this.ownControl(s) : () => s.controlRevision === control;
    let terminalDialogBlocked = false;
    const guard = () => {
      this.expireRun(route);
      const blocked = Boolean(dispatch && terminalDialogPrompt(s, runtime));
      if (blocked) terminalDialogBlocked = true;
      return !blocked && backgroundValid() && (!dispatch || dispatchAllowed()) && (!mobile || mobileSession.valid(mobile)) && (!wakeTicket || wakeTicket.valid(wakeTicket.tag)) && (!recovery || this.capacityValid(s, recovery)) && !runtime.nativeInputRequired && s.state !== 'ended' && sameControl() &&
        (!failedTurn || runtime.submission?.pending?.authorized || runtime.pending?.accepted || runtime.failedTurnInputMatches(failedTurn)) &&
        (!(route || forward) || (spaces.isMember(s, roomId) && spaces.membershipRevision(s, roomId) === member)) && (!route || (this.routeValid(route))) && (roomId === 'shared' || !this.storageWarning);
    };
    // Claude's mod sends the person's own message beside a draft in the native prompt (claude-submit.cjs).
    if (own) guard.ownInput = true;
    if (!guard()) throw uiError("error.workspace.handoffExpired");
    if (!recovery) this.cancelCapacity(id);
    const tag = imageTag || mobile?.row?.tag || randomUUID(); s.pendingTag = tag;
    if (recovery) recovery.tag = tag;
    if (wakeTicket) wakeTicket.tag = tag;
    const draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    const clearedDraft = !backgroundOperation.current() && !mobile && !wakeTicket && !dispatch && !route && !forward && typeof draft === 'string' && draft.trim() === text;
    s.messages.push({ id: tag, role: 'user', text, time: Date.now(), ...(mobile ? { origin: 'human-mobile' } : wakeTicket ? wakeOrigin(wakeTicket.intent) : recovery ? { name: 'NAW', origin: 'capacity-recovery' } : dispatch ? { name: 'NAW 派活', uiNameMessage: displayMessage({ version: 1, key: 'notice.queue.senderName', params: {} }, 'notice.') || undefined, origin: 'naw-dispatch', dispatchItem: dispatch.itemId } : { origin: route ? 'room' : 'human' }), status: 'awaiting-native', ...backgroundOperation.message() });
    if (images) s.messages.at(-1).spaceUploads = images.refs.map(ref => ({ ...ref }));
    if (forward) {
      this.forwards.set(tag, { ...forward, roomId, control });
      sourceMessage = { id: tag, role: 'human', recipientId: s.id, name: `你 → ${s.name}`, uiNameMessage: backgroundOperation.current() ? undefined : youToName(s.name), ...backgroundOperation.message(s.name), text, status: 'awaiting-native', time: Date.now(), deliveryTracked: true, ...(forward.replyTo ? { replyTo: forward.replyTo } : {}) };
      if (images) Object.assign(sourceMessage, { images: images.refs.map(ref => ({ ...ref })), imageDraftVersion: images.version,
        imageReceipt: { status: 'awaiting-native', tag, nativeId: s.nativeId, recipientId: s.id } });
      room.messages.push(sourceMessage);
    }
    if (sourceMessage) {
      sourceMessage.deliveries ||= [];
      sourceMessage.deliveries.push({ id: tag, recipientId: s.id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() });
    }
    if ((route || forward) && sourceMessage) this.sharedReplies.authorize(s, runtime, tag, sourceMessage, route, roomId);
    this.versions.dispatches++;
    if (route) route.awaiting = { sessionId: id, tag, member, control };
    else if (clearedDraft) { this.pendingDrafts.set(id, { tag, text: draft, revision: draftRevision }); this.drafts.set(id, ''); }
    this.changed();
    try {
      if (mobile) mobile.reserve(tag);
      if (wakeTicket) { this.persist(); if (this.storageWarning) throw uiError("error.workspace.automaticRecordUnsaved"); }
      if (recovery) { this.persist(); if (this.storageWarning) throw uiError("error.workspace.continuationRecordUnsaved"); }
      if (route?.peerLease) { this.persist(); if (this.storageWarning) throw uiError("error.workspace.handoffRecordUnsaved"); }
      if (roomId !== 'shared' || images) { this.persist(); if (this.storageWarning) throw uiError("error.workspace.spaceRecordUnsaved"); }
      if (mobile) mobile.started = true;
      await runtime.send(text, tag, guard, imageSubmission || undefined);
    }
    catch (error) {
      // Preserve a proven pre-authorization dialog refusal across IPC.
      // An uncertain or already authorized send must never be relabelled.
      if (terminalDialogBlocked && error.notSent === true) error = uiError('error.queue.terminalDialog');
      const current = this.runtimes.get(id) === runtime && s.connectionRevision === connection && s.pendingTag === tag;
      const unchangedControl = sameControl();
      this.forwards.delete(tag); this.sharedReplies.close(tag, '接收结果未确认', uiActivity('notice.sharing.receiptUnconfirmed')[1]);
      this.deliveryStatus(tag, 'unconfirmed');
      for (const list of this.messageLists(s)) { const m = list.find(m => m.id === tag); if (m?.status === 'awaiting-native') m.status = mobile && (!mobile.started || error.notSent === true) ? 'not-sent' : 'unconfirmed'; }
      if (current) {
        s.pendingTag = null;
        if (unchangedControl) {
          if (clearedDraft && this.draftRevisions.get(id) === draftRevision) this.drafts.set(id, draft);
          // A private send already stopped the previous exchange. Its late
          // rejection cannot revoke a later authorization for other sessions.
          if (route) this.pause(error.message, route, false, error.uiMessage);
        }
      } else if (!this.runtimes.has(id) && s.state === 'recoverable' && s.connectionRevision === connection
        && unchangedControl && !s.pendingTag && clearedDraft && this.draftRevisions.get(id) === draftRevision) {
        // Confirmed backend exit may retire the runtime before its rejected
        // ACK settles. Retain only this unchanged, still-owned draft.
        this.drafts.set(id, draft);
      }
      this.changed(); throw error;
    } finally { if (this.pendingDrafts.get(id)?.tag === tag) this.pendingDrafts.delete(id); }
    return tag;
  }
  async queue(id, text, owner, shared = null) {
    const backgroundValid = backgroundOperation.inputGuard(this, [id]);
    const originalText = text; text = cleanText(text); if (backgroundOperation.current()) text = originalText;
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw uiError("error.nativeCommandUseTerminal");
    const s = this.get(id), runtime = this.runtime(id);
    // Public space input does not take over the private composer or terminal.
    const controller = shared ? s.owner : owner;
    const replyTo = shared && require('./room-threads.js').replyReference(shared.replyTo);
    const roomId = shared?.roomId || 'shared', room = this.roomFor(roomId);
    if (shared && !spaces.isMember(s, roomId)) throw uiError("error.workspace.recipientLeftSpace");
    if (s.owner !== controller || s.provider !== 'claude' || s.state !== 'working' || s.approval || !runtime.queueAvailable || runtime.pendingQueue) throw uiError("error.workspace.nativeWaitingInputUnavailable");
    s.peerRevision = (s.peerRevision || 0) + 1;
    if (shared) { this.pauseParticipant(id, '真人追加等待输入', false, uiActivity('notice.run.humanQueue')[1]); this.pauseRoom(roomId, '真人追加等待输入', uiActivity('notice.run.humanQueue')[1]); } else this.pause('真人追加等待输入', undefined, false, uiActivity('notice.run.humanQueue')[1]);
    // Private input still ends the old public reply scope; only the butler's wake permission survives.
    if (!shared) s.controlRevision++;
    if (!shared && !backgroundOperation.current()) wake.messageInput(this, s, { control: 1, peer: 1 });
    const control = s.controlRevision, connection = s.connectionRevision, nativeId = s.nativeId, member = spaces.membershipRevision(s, roomId);
    const sameControl = !shared && !backgroundOperation.current() ? this.ownControl(s) : () => s.controlRevision === control;
    const valid = () => backgroundValid() && this.runtimes.get(id) === runtime && !runtime.nativeInputRequired && s.owner === controller && s.nativeId === nativeId && !s.nativeContextPending &&
      sameControl() && s.connectionRevision === connection && !s.approval && !['ended', 'recoverable', 'error', 'disconnected'].includes(s.state) &&
      (!shared || (spaces.isMember(s, roomId) && spaces.membershipRevision(s, roomId) === member && this.sharedReplies.grants.has(tag) && !this.sharedReplies.grants.get(tag).closed)) && (roomId === 'shared' || !this.storageWarning);
    if (!shared && !backgroundOperation.current()) valid.ownInput = true;
    const tag = randomUUID(), draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    // Like a native TUI queue, the recorded message leaves the composer at once.
    const clearedDraft = !backgroundOperation.current() && !shared && typeof draft === 'string' && draft.trim() === text;
    runtime.pendingQueue = tag;
    // midturn: read at the running turn's next tool boundary, or as its own turn if the turn ends first.
    const midturn = runtime.midturnAvailable === true ? { midturn: true } : {};
    // The wake proposal, item 3: once the running turn reads the person's words, it may send automatic messages again.
    // Only words offered into the running turn can be read there; any other outcome leaves the turn revoked.
    const readable = !shared && !backgroundOperation.current() && midturn.midturn === true;
    if (readable) wake.humanQueued(this, runtime, s, tag);
    const message = { id: tag, role: 'user', text, origin: 'human', ...backgroundOperation.message(), status: 'awaiting-native', inputMode: 'queue', ...midturn, time: Date.now() };
    if (shared) {
      const source = { id: tag, role: 'human', recipientId: id, name: `你 → ${s.name}`, uiNameMessage: backgroundOperation.current() ? undefined : youToName(s.name), ...backgroundOperation.message(s.name), text, status: 'awaiting-native', inputMode: 'queue', ...midturn, time: Date.now(), deliveryTracked: true,
        ...(replyTo ? { replyTo } : {}), deliveries: [{ id: tag, recipientId: id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() }] };
      room.messages.push(source); this.forwards.set(tag, { roomId, member, control, replyTo });
      // No running private turn is adopted. Only the next native prompt's
      // exact receipt can bind this grant; existing output stays private.
      this.sharedReplies.authorize(s, runtime, tag, source, null, roomId);
    }
    s.messages.push(message); if (clearedDraft) this.drafts.set(id, ''); this.versions.dispatches++; this.changed();
    try {
      if (roomId !== 'shared') { this.persist(); if (this.storageWarning) throw uiError("error.workspace.spaceRecordUnsaved"); }
      const actor = backgroundOperation.current();
      const midturnText = shared && midturn.midturn ? spaceMidturnText(room.name || roomId, actor && { id: actor.id, name: actor.name }, text) : undefined;
      const receipt = await runtime.queue(text, tag, valid, midturnText);
      message.status = 'submitted';
      if (readable && receipt?.mode !== 'append') wake.humanNotRead(runtime, tag);
      if (receipt?.mode === 'append') {
        // Read inside the running turn at a tool boundary: it keeps its place in time. No prompt of its own
        // can carry a shared reply, so this message's grant closes (a grant an earlier message holds stays).
        message.deliveredInto = receipt.turnId;
        if (midturnText) message.deliveredFramed = 'space';
        this.deliveryStatus(tag, 'submitted');
        if (shared) {
          const source = room.messages.find(row => row.id === tag);
          if (source) { source.deliveredInto = receipt.turnId; source.status = 'reply-private'; }
          this.forwards.delete(tag); this.sharedReplies.close(tag, '送进了正在进行的回合，不单独回复到空间', uiActivity('notice.sharing.midturn')[1]);
        }
        this.changed();
        return tag;
      }
      // The receipt comes when native starts this message's own turn (on 2.1.316/2.1.317 after the running turn
      // ended, T-133). The conversation shows it there, after that turn's reply, as the native terminal does;
      // it keeps the time it was sent. The space record stays in time order, with replies naming what they answer.
      const at = s.messages.indexOf(message);
      if (at >= 0 && at < s.messages.length - 1) { s.messages.splice(at, 1); s.messages.push(message); this.changed(); }
      this.deliveryStatus(tag, 'submitted');
      return tag;
    } catch (error) {
      // Only a proven non-send returns the text to an untouched draft. An
      // uncertain outcome stays in the record so it is not sent twice.
      const status = error.notSent === true ? 'not-sent' : 'unconfirmed';
      if (message.status !== 'submitted') message.status = status;
      if (readable) wake.humanNotRead(runtime, tag);
      if (status === 'not-sent' && clearedDraft && this.draftRevisions.get(id) === draftRevision && !this.drafts.get(id)) this.drafts.set(id, draft);
      if (shared) {
        this.forwards.delete(tag); this.sharedReplies.close(tag, status === 'not-sent' ? '没有发出' : '接收结果未确认', uiActivity(status === 'not-sent' ? 'notice.sharing.notSent' : 'notice.sharing.receiptUnconfirmed')[1]); this.deliveryStatus(tag, status);
        const source = room.messages.find(row => row.id === tag);
        if (source?.status === 'awaiting-native') source.status = status;
      }
      throw error;
    } finally { if (runtime.pendingQueue === tag) runtime.pendingQueue = null; this.changed(); }
  }
  async steer(id, text, owner, expectedTurnId, shared = null) {
    const backgroundValid = backgroundOperation.inputGuard(this, [id]);
    const originalText = text; text = cleanText(text); if (backgroundOperation.current()) text = originalText;
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) throw uiError("error.nativeCommandUseTerminal");
    const s = this.get(id), runtime = this.runtime(id);
    // Public space input does not take over the private composer or terminal.
    const controller = shared ? s.owner : owner;
    const replyTo = shared && require('./room-threads.js').replyReference(shared.replyTo);
    const roomId = shared?.roomId || 'shared', room = this.roomFor(roomId);
    if (shared && !spaces.isMember(s, roomId)) throw uiError("error.workspace.recipientLeftSpace");
    if (s.owner !== controller || s.provider !== 'codex' || s.state !== 'working' || s.approval ||
      !runtime.steerAvailable || runtime.pendingSteer || typeof expectedTurnId !== 'string' || !expectedTurnId || runtime.turnId !== expectedTurnId) throw uiError("error.workspace.nativeTurnOrControlChanged");
    if (shared) { this.pauseParticipant(id, '真人追加指令', false, uiActivity('notice.run.humanSteer')[1]); this.pauseRoom(roomId, '真人追加指令', uiActivity('notice.run.humanSteer')[1]); } else this.pause('真人追加指令', undefined, false, uiActivity('notice.run.humanSteer')[1]); s.controlRevision++;
    if (!shared && !backgroundOperation.current()) wake.messageInput(this, s, { control: 1 });
    const control = s.controlRevision, connection = s.connectionRevision, nativeId = s.nativeId, member = spaces.membershipRevision(s, roomId);
    const sameControl = !shared && !backgroundOperation.current() ? this.ownControl(s) : () => s.controlRevision === control;
    const valid = () => backgroundValid() && this.runtimes.get(id) === runtime && !runtime.nativeInputRequired && s.owner === controller && s.nativeId === nativeId && !s.nativeContextPending && sameControl() &&
      s.connectionRevision === connection && !['ended', 'recoverable', 'error', 'disconnected', 'approval'].includes(s.state) && !s.approval && runtime.turnId === expectedTurnId &&
      (!shared || (spaces.isMember(s, roomId) && spaces.membershipRevision(s, roomId) === member && this.sharedReplies.grants.has(tag) && !this.sharedReplies.grants.get(tag).closed)) && (roomId === 'shared' || !this.storageWarning);
    const tag = randomUUID(), draft = this.drafts.get(id), draftRevision = this.draftRevisions.get(id);
    const message = { id: tag, role: 'user', text, origin: 'human', ...backgroundOperation.message(), status: 'awaiting-native', inputMode: 'steer', turnId: expectedTurnId, time: Date.now() };
    let accepted = false;
    try {
      runtime.pendingSteer = tag;
      if (shared) {
        const source = { id: tag, role: 'human', recipientId: id, name: `你 → ${s.name}`, uiNameMessage: backgroundOperation.current() ? undefined : youToName(s.name), ...backgroundOperation.message(s.name), text, status: 'awaiting-native', inputMode: 'steer', time: Date.now(), deliveryTracked: true,
          ...(replyTo ? { replyTo } : {}), deliveries: [{ id: tag, recipientId: id, recipientName: s.name, text, status: 'awaiting-native', time: Date.now() }] };
        room.messages.push(source); this.forwards.set(tag, { roomId, member, control, replyTo });
        this.sharedReplies.authorize(s, runtime, tag, source, null, roomId);
      }
      s.messages.push(message); this.versions.dispatches++; this.changed();
      if (roomId !== 'shared') { this.persist(); if (this.storageWarning) throw uiError("error.workspace.spaceRecordUnsaved"); }
      await runtime.steer(text, tag, expectedTurnId, valid, Boolean(shared));
      accepted = true;
      message.status = 'submitted'; this.deliveryStatus(tag, 'submitted');
      if (!backgroundOperation.current() && !shared && sameControl() && this.draftRevisions.get(id) === draftRevision && draft?.trim() === text) this.drafts.set(id, '');
      return tag;
    } catch (error) {
      // Do not relabel ongoing output as cancelled or retry this input.
      if (message.status !== 'submitted') message.status = 'unconfirmed';
      if (shared) {
        this.forwards.delete(tag); this.sharedReplies.close(tag, '接收结果未确认', uiActivity('notice.sharing.receiptUnconfirmed')[1]); this.deliveryStatus(tag, 'unconfirmed');
        const source = room.messages.find(row => row.id === tag);
        if (source?.status === 'awaiting-native') source.status = 'unconfirmed';
      }
      throw error;
    } finally {
      if (runtime.pendingSteer === tag) {
        runtime.pendingSteer = null;
        // Drain a completion received before the steer ACK only after its draft
        // and pending marker settle. Uncertain input or a newer human boundary
        // must still cancel recovery, including edits subsequently cleared.
        const unchanged = accepted && this.runtimes.get(id) === runtime && s.owner === controller &&
          s.nativeId === nativeId && sameControl() && spaces.membershipRevision(s, roomId) === member &&
          s.connectionRevision === connection && this.draftRevisions.get(id) === draftRevision;
        runtime.finishTurn(expectedTurnId);
        if (!unchanged) this.cancelCapacity(id);
      }
      this.changed();
    }
  }
  // An automatic message (session-wake.cjs) to a session in the middle of a turn, the native way the person's own
  // input takes there (the wake proposal, item 1, 2026-11-12): Claude's queue, read at the running turn's next tool
  // boundary or as its next turn, and Codex's steer into the running turn. Not the person: no takeover, no human
  // pause, no control or peer revision, so the ticket (identity, switches, slot, turn, limit) stands in for the
  // owner's check at every native step. A refusal before native holds it carries notSent.
  async wakeMidturn(id, text, ticket, route) {
    const backgroundValid = backgroundOperation.inputGuard(this, [id]);
    const s = this.get(id), runtime = this.runtime(id), steer = route?.mode === 'steer';
    if (!['queue', 'steer'].includes(route?.mode) || !ticket?.valid()) throw Object.assign(uiError("error.workspace.automaticAuthorizationExpired"), { notSent: true });
    this.pauseParticipant(id, '原会话收到自动消息；旧协作交接已撤销', true, uiActivity('notice.run.automaticInputBoundary')[1]);
    // The message is for this session only. As the person's private queue or steer ends what the turn still shows in a
    // space (their controlRevision++), so does this, without taking the person's control revision (review of item 1, B1).
    for (const grant of this.sharedReplies.grants.values()) if (grant.sessionId === id && !grant.closed) this.sharedReplies.close(grant.tag);
    const tag = randomUUID(), nativeId = s.nativeId, connection = s.connectionRevision;
    const valid = () => backgroundValid() && this.runtimes.get(id) === runtime && s.nativeId === nativeId && s.connectionRevision === connection && ticket.valid(tag);
    ticket.tag = tag;
    const message = { id: tag, role: 'user', text, time: Date.now(), ...wakeOrigin(ticket.intent), status: 'awaiting-native', inputMode: route.mode,
      ...(steer ? { turnId: route.turnId } : runtime.midturnAvailable === true ? { midturn: true } : {}), ...backgroundOperation.message() };
    if (steer) runtime.pendingSteer = tag; else runtime.pendingQueue = tag;
    s.messages.push(message); this.versions.dispatches++; this.changed();
    let accepted = false;
    try {
      this.persist(); if (this.storageWarning) throw Object.assign(uiError("error.workspace.automaticRecordUnsaved"), { notSent: true });
      if (steer) await runtime.steer(text, tag, route.turnId, valid);
      else {
        const receipt = await runtime.queue(text, tag, valid);
        if (receipt?.mode === 'append') message.deliveredInto = receipt.turnId;
        else {
          // Its own turn, after the one it waited behind: shown there, as the person's queued message is.
          const at = s.messages.indexOf(message);
          if (at >= 0 && at < s.messages.length - 1) { s.messages.splice(at, 1); s.messages.push(message); }
        }
      }
      accepted = true; message.status = 'submitted'; this.deliveryStatus(tag, 'submitted');
      return tag;
    } catch (error) {
      if (message.status !== 'submitted') message.status = error?.notSent === true ? 'not-sent' : 'unconfirmed';
      throw error;
    } finally {
      if (steer) {
        if (runtime.pendingSteer === tag) {
          // As steer(): a completion received before the ACK drains only now; uncertain input cancels recovery.
          const unchanged = accepted && ticket.valid(tag);
          runtime.pendingSteer = null; runtime.finishTurn(route.turnId);
          if (!unchanged) this.cancelCapacity(id);
        }
      } else if (runtime.pendingQueue === tag) runtime.pendingQueue = null;
      this.changed();
    }
  }
  async terminal(id, owner) {
    this.claim(id, owner, 'terminal');
    return this.terminalSnapshot(id, owner);
  }
  async terminalSnapshot(id, owner) {
    const s = this.get(id), runtime = this.runtime(id), control = s.controlRevision;
    const reopening = runtime.terminal?.alive === false;
    const guard = () => !reopening || (s.owner === owner && s.view === 'terminal' && s.controlRevision === control);
    if (!guard()) throw uiError("error.workspace.takeTerminalControlBeforeReconnect");
    const t = await runtime.openTerminal(guard);
    if (!guard()) throw uiError("error.terminalOwnerChanged");
    const snapshot = await t.snapshot();
    if (!guard()) throw uiError("error.terminalOwnerChanged");
    return snapshot;
  }
  input(id, data, owner) {
    backgroundOperation.inputGuard(this, [id]);
    const s = this.get(id);
    if (typeof data !== 'string' || data.length > 65536) throw uiError("error.workspace.invalidTerminalInput");
    if (s.owner !== owner) throw uiError("error.workspace.controlledByAnotherWindow");
    const runtime = this.runtime(id);
    if (runtime.backendExitConfirmed) throw uiError("error.workspace.nativeExitedReadOnly");
    // Terminal-generated device/cursor replies are not human instructions.
    // The window that controls the session types into its terminal whichever side its view is on (the person,
    // 2026-11-13: 两边的输入可以不要锁定); the view only routes a held question.
    const response = isTerminalResponse(data);
    if (!response) {
      if (!backgroundOperation.current()) wake.human(this, id);
      this.cancelCapacity(id); this.pause('真人在原生终端操作', undefined, false, uiActivity('notice.run.humanTerminalAction')[1]); s.controlRevision++;
      if (!backgroundOperation.current()) {
        this.terminalKeys.set(id, (this.terminalKeys.get(id) || 0) + 1);
        // Text, paste and editing keep the butler's wake permission; native Esc/Ctrl-C still withdraw it.
        if (data !== '\x1b' && !data.includes('\x03')) wake.messageInput(this, s, { control: 1 });
      }
      s.terminalInputPending = true;
    }
    const t = runtime.terminal; if (!t?.alive) throw uiError("error.workspace.terminalNotConnected"); t.input(data);
  }
  resize(id, owner, cols, rows) { const s = this.get(id); if (s.owner === owner && Number.isInteger(cols) && Number.isInteger(rows)) this.runtime(id).terminal?.resize(cols, rows); }
  async interrupt(id, owner) {
    const s = this.get(id); this.claim(id, owner, s.view); const runtime = this.runtime(id);
    if (this.capacityRecoveries.get(id)?.status === 'scheduled') { this.cancelCapacity(id); return; }
    // A held question is declined, like Esc on the native dialog, so native
    // neither waits on the hook nor opens the dialog; then the turn is aborted.
    if (this.claudeAsks.get(id)) this.releaseQuestion(s, null, { stop: true });
    if (runtime.nativeAbortRequest && runtime.nativeAbortCurrent?.(runtime.nativeAbortRequest)) return runtime.nativeAbortRequest.done;
    // The turn this interrupt is for; a turn that began while the native side was asked is not waiting on it.
    const turn = runtime.turnId || null;
    s.controlRevision++; this.pause('真人中断当前回复', undefined, false, uiActivity('notice.run.humanInterrupt')[1]); const result = await runtime.interrupt();
    setActivity(s, ...(result?.interrupted ? ['', null] : interruptActivity(s)));
    if (!result?.interrupted && (runtime.turnId || null) === turn) this.noteWait(s, 'interrupt', turn);
    this.changed();
  }
  expireRun(run = this.activeRun()) {
    // The interval is only a wake-up aid. Native delivery/completion must also
    // enforce the boundary, even if timers were delayed (for example, by sleep).
    if (!run || run.peerLease || run.id !== this.roomFor(run.roomId || 'shared').run?.id || run.status !== 'running' || Date.now() < run.deadline) return false;
    this.pause('达到本轮 10 分钟期限。', run, false, uiActivity('notice.run.deadline')[1]); return true;
  }
  // The person's explicit pause of all follow-up handoffs also withdraws every staged
  // workspace message. Input, takeover or interruption in one session is narrower:
  // it changes that session's control/peer revision, which both the sender and the
  // receiver proof of a wake carry, so only wakes involving that session are voided.
  pauseAll(reason, uiMessage) { wake.revoke(this); this.pause(reason, undefined, false, uiMessage); }
  goalContinuationCancel(scopeId, sessionId) {
    try { this.goalContinuation?.invalidate(scopeId, sessionId); }
    catch {
      // Reuse the existing durable automatic-input nonce. If allocation fails,
      // revoke already invalidates the owned marker rather than losing pause.
      wake.revoke(this);
      if (this.goalContinuation) this.goalContinuation.error = 'continuation-cancel-record-unconfirmed';
    }
  }
  pause(reason = '已暂停交接', run, automatic = false, uiMessage) {
    if (arguments[0] === undefined) uiMessage = uiActivity('notice.run.paused')[1];
    [reason, uiMessage] = backgroundOperation.activity(reason, uiMessage);
    uiMessage = displayMessage(uiMessage, 'notice.', reason) || displayMessage(uiMessage, 'error.', reason);
    if (!automatic) this.goalContinuationCancel(run ? run.roomId || 'shared' : undefined);
    if (run?.peerLease) { this.peerLeases?.pause(run.client, run.id, reason, uiMessage); return; }
    this.peerLeases?.revoke(reason, undefined, run ? run.roomId || 'shared' : undefined, uiMessage);
    for (const room of this.rooms.values()) if ((!run || room.run === run) && room.run?.status === 'running') {
      if (room.run.kind === 'cross-service') room.run.pausePending = true;
      room.run.status = 'paused'; room.run.reason = reason; if (uiMessage) room.run.reasonUiMessage = uiMessage; else delete room.run.reasonUiMessage; room.revision++; this.runEvent(reason, room.id, uiMessage); this.changed();
    }
  }
  pauseRoom(roomId, reason = '这个空间的后续交接已暂停', uiMessage) {
    if (arguments[1] === undefined) uiMessage = uiActivity('notice.run.spacePaused')[1];
    [reason, uiMessage] = backgroundOperation.activity(reason, uiMessage);
    this.goalContinuationCancel(roomId);
    this.peerLeases?.revoke(reason, undefined, roomId, uiMessage);
    const room = this.rooms.get(roomId);
    if (room?.run) this.pause(reason, room.run, false, uiMessage);
  }
  pauseParticipant(id, reason, automatic = false, uiMessage) {
    [reason, uiMessage] = backgroundOperation.activity(reason, uiMessage);
    if (!automatic) { this.goalContinuationCancel(undefined, id); wake.cancelParticipant(this, id, reason, uiMessage); }
    this.peerLeases?.revoke(reason, id, undefined, uiMessage);
    // Native activity in another independent session does not revoke this
    // selected run. Explicit human interventions still use the global pause.
    for (const room of this.rooms.values()) if (room.run?.ids.includes(id)) this.pause(reason, room.run, automatic, uiMessage);
  }
  runEvent(text, roomId = 'shared', uiMessage) {
    uiMessage = displayMessage(uiMessage, 'notice.', text) || displayMessage(uiMessage, 'error.', text);
    const room = this.roomFor(roomId), run = room.run;
    // Preserve a navigation reference when sharing pauses before a reply. This
    // does not attribute the pause to that session or authorize another handoff.
    const sessionId = run?.status === 'paused' ? run.awaiting?.sessionId : null;
    room.messages.push({ id: randomUUID(), role: 'system', name: '协作', uiNameMessage: uiNotice('notice.name.collaboration').uiMessage, text, ...(uiMessage ? { uiMessage } : {}), time: Date.now(), runId: run?.id, ...(run?.sourceId ? { replyTo: run.sourceId } : {}), ...(sessionId ? { sessionId } : {}) });
  }
  nativeWorkObserved(id, reason, uiMessage) {
    uiMessage = displayMessage(uiMessage, 'notice.', reason) || displayMessage(uiMessage, 'error.', reason);
    this.peerLeases?.observedWork(id, reason, uiMessage);
    const run = this.activeRun(id);
    if (run?.status !== 'running' || !run.ids.includes(id)) return;
    // Keep the current, already-authorized root reply. This observation only
    // blocks its next handoff; unrelated members must stop routing immediately.
    if (run.awaiting?.sessionId === id) { run.stopAfterReply = reason; if (uiMessage) run.stopAfterReplyUiMessage = uiMessage; else delete run.stopAfterReplyUiMessage; run.reason = '本次回复返回后暂停后续转交；原生工作继续保留。'; run.reasonUiMessage = uiActivity('notice.run.afterReply')[1]; }
    else this.pause(reason, run, false, uiMessage);
  }
  async startRun(ids, goal, maxSteps, mode = 'strict', labels = {}, _contexts, replyTo, roomId = 'shared') {
    backgroundOperation.inputGuard(this, Array.isArray(ids) ? ids : []);
    const room = this.roomFor(roomId);
    if ([...this.rooms.values()].some(r => r.run?.pausePending || r.run?.pauseUnconfirmed)) throw uiError("error.client.revokeBeforeNewCollaboration");
    replyTo = require('./room-threads.js').replyReference(replyTo);
    if (!['strict', 'replies', 'directed'].includes(mode)) throw uiError("error.policy.unknownAuthorization");
    goal = cleanText(goal, 6000);
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length || ![2, 3, 4, 5, 6].includes(maxSteps) || maxSteps < ids.length) throw uiError("error.workspace.selectFiniteParticipants");
    if (this.activeRun() || [...(this.peerLeases?.leases.values() || [])].some(g => g.status === 'running')) throw uiError("error.workspace.collaborationRunning");
    for (const id of ids) { const s = this.get(id); if (!spaces.isMember(s, roomId) || s.state !== 'idle' || s.pendingTag || s.approval || [s.background, s.scheduled].some(n => Number.isSafeInteger(n) && n > 0)) throw uiError("error.workspace.membersNotReady"); }
    if (ids.some(id => this.runtime(id).chatAvailable === false || this.runtime(id).nativeInputRequired)) throw uiError("error.workspace.safeSubmissionNotConnected");
    if (mode === 'directed' && ids.some(id => this.runtime(id).addressedSendAvailable !== true)) throw uiError("error.workspace.nativeDirectedToolsUnavailable");
    // Freeze the human-visible names with this authorization, not native defaults.
    const names = Object.fromEntries(ids.map(id => {
      const s = this.get(id), name = labels && Object.hasOwn(labels, id) ? labels[id] : s.name;
      if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw uiError("error.workspace.invalidParticipantNames");
      return [id, `${name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${id.slice(0, 6)}`];
    }));
    const run = { id: randomUUID(), roomId, ids: [...ids], names, goal, mode, maxSteps, steps: 0, status: 'running', reason: '', startedAt: Date.now(), deadline: Date.now() + 10 * 60 * 1000, awaiting: null, replies: {} };
    if (backgroundOperation.current()) run.agentControl = { ...backgroundOperation.current() };
    const sourceMessage = { id: randomUUID(), role: 'human', name: '你', uiNameMessage: backgroundOperation.current() ? undefined : uiNotice('notice.name.you').uiMessage, ...backgroundOperation.message(), text: goal, time: Date.now(), runId: run.id, deliveryTracked: true, ...(replyTo ? { replyTo } : {}) };
    run.sourceId = sourceMessage.id;
    room.run = run; room.messages.push(sourceMessage); this.changed();
    this.runEvent(mode === 'directed' ? `已授权成员选择接收者，最多 ${maxSteps} 次回复、10 分钟；没有定向调用就结束，不广播或轮询。` : mode === 'replies' ? `已授权依次转交本次回复，最多 ${maxSteps} 次、10 分钟；未知的原生子任务不视为结束。` : '核实原生工作状态后交接。', roomId, uiActivity(mode === 'directed' ? 'notice.run.authorizedDirected' : mode === 'replies' ? 'notice.run.authorizedReplies' : 'notice.run.authorizedStrict', mode === 'directed' || mode === 'replies' ? { maxSteps } : undefined)[1]);
    await this.send(ids[0], mode === 'directed' ? addressed.taskText(run, goal) : goal, null, run, null, sourceMessage);
  }
  async advance(s, info) {
    const run = this.activeRun(s.id), a = run?.awaiting;
    if (run?.kind === 'cross-service') return;
    const roomId = run?.roomId || 'shared', room = this.roomFor(roomId);
    if (this.expireRun(run)) return;
    if (!run || run.status !== 'running' || a?.sessionId !== s.id || a.tag !== info.tag || spaces.membershipRevision(s, roomId) !== a.member || s.controlRevision !== a.control || !spaces.isMember(s, roomId)) return;
    const pause = (reason, uiMessage) => this.pause(reason, run, false, uiMessage);
    run.awaiting = null;
    if ((typeof info.text !== 'string' || !info.text.trim()) && !(run.mode === 'directed' && run.pendingHandoff)) return pause('原生没有提供可交接的回复，请人工查看。', uiActivity('notice.run.noReply')[1]);
    const sourceMessage = this.sharedReplies.final(s, info, run);
    if (!sourceMessage) return pause('回复共享已失效，请在原会话核对。', uiActivity('notice.run.sharingInvalid')[1]);
    run.steps++;
    if (run.stopAfterReply) return pause(run.stopAfterReply, run.stopAfterReplyUiMessage);
    // Keep the reply even when it cannot be handed off. A root Stop/turn end
    // and a list of observed fleet events are not a complete fleet inventory.
    const counts = [info.background, info.scheduled, info.fleetPending];
    if (info.stopHookActive === true || counts.some(n => Number.isSafeInteger(n) && n > 0)) return pause('原生仍有后台、团队或定时工作，或继续执行的 hooks。回复已保留；请查看原生终端，确认后可定向发送。', uiActivity('notice.run.workPresent')[1]);
    const unknown = info.stopHookActive !== false || counts.some(n => !Number.isSafeInteger(n) || n < 0);
    run.nativeWorkUnknown = unknown;
    if (unknown && !['replies', 'directed'].includes(run.mode)) return pause('原生未完整报告后台、团队或定时工作状态，已暂停自动交接。回复已保留；请查看原生终端，确认后可定向发送。', uiActivity('notice.run.workUnknown')[1]);
    // A separately authorized reply exchange does not certify fleet completion.
    // It never changes unknown native counts into zero or closes native work.
    if (run.steps >= run.maxSteps) { run.status = 'completed'; run.reason = '已达到本轮回复上限，交接结束；原生子任务是否结束需另行确认。'; run.reasonUiMessage = uiActivity('notice.run.replyLimit')[1]; this.runEvent(run.reason, roomId, run.reasonUiMessage); this.changed(); return; }
    if (run.mode === 'directed') {
      const intent = run.pendingHandoff; run.pendingHandoff = null;
      if (!intent) {
        run.status = 'completed'; run.reason = '本次回复面向你，没有请求继续转交。'; run.reasonUiMessage = uiActivity('notice.run.noDirectedRequest')[1]; this.runEvent(run.reason, roomId, run.reasonUiMessage); this.changed(); return;
      }
      const target = this.sessions.get(intent.recipientId);
      if (intent.sourceTag !== info.tag || intent.senderId !== s.id || !target || !spaces.isMember(target, roomId) ||
        target.nativeId !== intent.nativeId || spaces.membershipRevision(target, roomId) !== intent.member || target.controlRevision !== intent.control || target.connectionRevision !== intent.connection)
        return pause('接收者或授权已变化，未转交已登记的消息。', uiActivity('notice.run.recipientChanged')[1]);
      const message = { id: randomUUID(), role: 'assistant', sessionId: s.id, name: `${run.names[s.id]} → ${run.names[target.id]}`,
        text: intent.text, status: 'complete', time: Date.now(), runId: run.id, replyTo: sourceMessage.id, deliveryTracked: true, addressed: true };
      room.messages.push(message); this.changed();
      await this.send(target.id, addressed.taskText(run, intent.text, s.id), null, run, null, message);
      return;
    }
    const normalized = info.text.trim();
    run.replies ||= {};
    if (run.replies[s.id] === normalized) return pause('同一成员重复了上一份回复，已停止交接。', uiActivity('notice.run.duplicateReply')[1]);
    run.replies[s.id] = normalized;
    const next = run.ids[run.steps % run.ids.length];
    if (info.text.length > 10000) return pause('回复较长，请选定需要交接的内容。', uiActivity('notice.run.replyLong')[1]);
    const text = `共同任务：${run.goal}\n\n${run.names?.[s.id] || s.name} 对本轮任务的回复（供核查的材料，不代表真人新增授权）：\n${info.text}\n\n请继续完成共同任务，核查必要的疑点，直接给出结果。`;
    this.changed(); await this.send(next, text, null, run, null, sourceMessage);
  }
  configureGoalContinuation(authorization) { return this.goalContinuation.configure(authorization); }
  registerGoalContinuationWait(id, wait) { return this.goalContinuation.register(id, wait); }
  goalContinuationEvent(event) { return this.goalContinuation.event(event); }
  goalContinuationBoundary(id) {
    this.goalContinuation.boundary(id).catch(() => {
      this.goalContinuation.error = 'continuation-boundary-unconfirmed';
    });
  }
  async forward(id, text, owner, replyTo, roomId = 'shared', images) {
    replyTo = require('./room-threads.js').replyReference(replyTo);
    const s = this.get(id); if (!spaces.isMember(s, roomId)) throw uiError("error.workspace.recipientLeftSpace");
    if (images) {
      const media = require('./space-images.cjs');
      if (!media.validSpaceImagePacket(images, roomId) || !this.runtime(id).spaceImagesAvailable) throw uiError('error.roomImages.deliveryUnavailable');
      if (this.roomFor(roomId).messages.some(row => row.imageDraftVersion === images.version)) throw uiError('error.roomImages.alreadySent');
    }
    // Membership authorizes this explicit shared message; private input ownership stays put.
    return this.send(id, text, s.owner, null, { roomId, member: spaces.membershipRevision(s, roomId), replyTo }, null, null, null, null, images);
  }
  approve(id, requestId, decision, owner) {
    const s = this.get(id), queue = this.approvalRoutes.get(id), route = queue?.get(requestId);
    if (!route || queue.overflow || route.approval.pending || s.state !== 'approval' || s.owner !== owner ||
      route.runtime !== this.runtimes.get(id) || !(route.rpc === this.host.rpc || route.runtime.currentRpc?.(route.rpc)) || route.runtime.transportDisconnected ||
      route.runtime.backendExitConfirmed) throw uiError("error.legacy.approvalChanged");
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw uiError("error.workspace.unknownPermissionDecision");
    if (!nativeApprovalPolicy(route.approval).decisions.includes(decision)) throw uiError("error.legacy.approvalDecisionUnsupported");
    route.rpc.reply(route.nativeRequestId, { decision });
    if (this.approvalRoutes.get(id)?.get(requestId) === route) { route.approval = { ...route.approval, pending: true }; Object.assign(s, queue.snapshot()); }
    this.changed();
  }
  // A native Claude AskUserQuestion is held for a solo row in the chat view, the
  // only place its card shows. In a room, in the terminal view, or for a second
  // question, native asks at once in its own dialog.
  holdQuestion(s, runtime, ask) {
    if (this.runtimes.get(s.id) !== runtime || s.view !== 'chat' || spaces.roomIds(s).length || this.claudeAsks.has(s.id)) return ask.reply({});
    const requestId = randomUUID();
    this.claudeAsks.set(s.id, { requestId, reply: ask.reply, open: ask.open, questions: ask.questions });
    s.claudeQuestion = { requestId, questions: ask.questions }; this.changed();
    // Native ended the hook (timeout, interrupt, exit): the question is no longer answerable here.
    ask.onClose?.(() => { if (this.claudeAsks.get(s.id)?.requestId === requestId) { this.claudeAsks.delete(s.id); s.claudeQuestion = null; this.changed(); } });
  }
  releaseQuestion(s, answers, { stop = false } = {}) {
    const held = this.claudeAsks.get(s.id); if (!held) return;
    this.claudeAsks.delete(s.id); s.claudeQuestion = null;
    held.reply(answers ? { answers } : stop ? { stop: true } : {}); this.changed();
  }
  // Answers by question text; several choices are joined with commas, as native
  // reads them. null hands the question back to the native dialog.
  answerClaude(s, requestId, answers, owner, mobile = null) {
    const held = this.claudeAsks.get(s.id);
    if (!held || held.requestId !== requestId || (!mobile && s.owner !== owner) || mobile && !require('./mobile-session.cjs').valid(mobile) || !held.open()) throw uiError("error.workspace.questionChanged");
    if (answers === null) { if (mobile) throw uiError("error.workspace.mobileCannotReturnQuestion"); return this.releaseQuestion(s, null); }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw uiError("error.workspace.answerEveryQuestion");
    const reply = {};
    for (const q of held.questions) {
      const given = answers[q.question];
      if (!Array.isArray(given) || !given.length || (!q.multiSelect && given.length !== 1) || given.length > q.options.length + 1 ||
        !given.every(a => typeof a === 'string' && a.trim() && a.length <= 16000)) throw uiError("error.workspace.answerEveryQuestion");
      reply[q.question] = given.map(a => a.trim()).join(', ');
    }
    if (mobile) { if (mobile.prepare() === false) return; if (!require('./mobile-session.cjs').valid(mobile)) throw uiError("error.workspace.mobileQuestionChanged"); }
    if (mobile) mobile.started = true;
    this.releaseQuestion(s, reply);
  }
  // A native Codex question answered here, with the reply native defines. The
  // terminal may answer the same request; native resolves it once, first wins.
  answer(id, requestId, answers, owner, mobile = null) {
    if (this.get(id).provider === 'claude') return this.answerClaude(this.get(id), requestId, answers, owner, mobile);
    const s = this.get(id), queue = this.approvalRoutes.get(id), route = queue?.get(requestId);
    if (!route || queue.overflow || route.approval.pending || s.state !== 'approval' || (!mobile && s.owner !== owner) || mobile && !require('./mobile-session.cjs').valid(mobile) ||
      route.runtime !== this.runtimes.get(id) || !(route.rpc === this.host.rpc || route.runtime.currentRpc?.(route.rpc)) || route.runtime.transportDisconnected ||
      route.runtime.backendExitConfirmed) throw uiError("error.workspace.questionChanged");
    const questions = nativeApprovalPolicy(route.approval).questions;
    if (s.provider !== 'codex' || !questions || questions.some(q => q.isSecret)) throw uiError("error.workspace.answerInNativeTerminal");
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw uiError("error.workspace.answerEveryQuestion");
    const reply = {};
    for (const q of questions) {
      const given = answers[q.id], labels = (q.options || []).map(o => o.label);
      if (!Array.isArray(given) || given.length !== 1 || typeof given[0] !== 'string' || !given[0].trim() || given[0].length > 16000) throw uiError("error.workspace.answerEveryQuestion");
      if (labels.length && !q.isOther && !labels.includes(given[0])) throw uiError("error.workspace.chooseProvidedOptions");
      reply[q.id] = { answers: given };
    }
    if (mobile) { if (mobile.prepare() === false) return; if (!require('./mobile-session.cjs').valid(mobile)) throw uiError("error.workspace.mobileQuestionChanged"); }
    if (mobile) mobile.started = true;
    route.rpc.reply(route.nativeRequestId, { answers: reply });
    if (this.approvalRoutes.get(id)?.get(requestId) === route) { route.approval = { ...route.approval, pending: true }; Object.assign(s, queue.snapshot()); }
    this.changed();
  }
  // `scope` 'participant' (participantMaintenanceStopV1): a rotation ends this one session, so its stop pauses
  // only the relays, grants and continuations this session is in; another space's relay keeps running. Without
  // it (the backend switch, which ends every session) the stop pauses all of them, as before.
  maintenanceStop(id, expected, requireAuto = false, scope = null) {
    const { sessionPlan, sameStop } = require('./backend-switch.cjs');
    const s = this.get(id), runtime = this.runtime(id);
    if (scope !== null && scope !== undefined && scope !== 'participant') throw uiError('error.backendSwitchSessionChanged', { name: s.name || id });
    const check = () => {
      const running = new Set();
      for (const room of this.rooms.values()) if (room.run?.status === 'running') for (const member of room.run.ids || []) running.add(member);
      const current = { ...s, draftRevision: this.draftRevisions.get(id) || 0,
        activeTurnId: runtime.turnId, pendingQueue: runtime.pendingQueue, pendingSteer: runtime.pendingSteer,
        nativeInputRequired: runtime.nativeInputRequired, interruptPending: runtime.nativeAbortRequest };
      const plan = sessionPlan(current, current.state, running);
      if (this.closed || this.storageWarning || this.sessions.get(id) !== s || this.runtimes.get(id) !== runtime || this.stops.has(id) ||
          !plan.stop || !sameStop(plan.stop, expected) || (requireAuto && !plan.auto) || typeof runtime.stopForMaintenance !== 'function') throw uiError('error.backendSwitchSessionChanged', { name: s.name || id });
    };
    check();
    return this.stop(id, { check, expected, participantOnly: scope === 'participant' });
  }
  async stopUnusedSuccessor(id, proof) {
    // Automatic cleanup has narrower authority than a person's Stop action.
    // A persisted caller proof cannot authorize stopping newer work or a new
    // native context, including while the adapter waits for observation.
    const refuse = () => uiError('error.backendSwitchSessionChanged', { name: this.sessions.get(id)?.name || id });
    if (typeof id !== 'string' || !id || id.length > 2000 || /[\u0000-\u001f]/u.test(id) ||
        !proof || typeof proof !== 'object' || Array.isArray(proof) ||
        Object.keys(proof).sort().join(',') !== 'controlRevision,draftRevision,nativeId,placementRevision' ||
        !(proof.nativeId === null || typeof proof.nativeId === 'string' && proof.nativeId.length > 0 && proof.nativeId.length <= 2000 && !/[\u0000-\u001f]/u.test(proof.nativeId)) ||
        !Number.isSafeInteger(proof.controlRevision) || proof.controlRevision < 0 || !Number.isSafeInteger(proof.draftRevision) || proof.draftRevision < 0 ||
        !Number.isSafeInteger(proof.placementRevision) || proof.placementRevision < 0) throw refuse();
    const s = this.get(id), { sameStop, maintenanceProof } = require('./backend-switch.cjs');
    if (s.nativeId !== proof.nativeId || spaces.placementRevision(s) !== proof.placementRevision ||
        !['claude', 'codex'].includes(s.provider) || proof.nativeId === null && s.provider !== 'codex') throw refuse();
    // This is an observed connection state, not a claim that our request ended
    // a provider thread. A disconnected Codex thread may still have subscribers.
    if (['ended', 'recoverable', 'disconnected'].includes(s.state)) return { state: s.state };
    const runtime = this.runtime(id), current = () => ({ ...s, draftRevision: this.draftRevisions.get(id) ?? 0 });
    const expected = maintenanceProof(current());
    const check = () => {
      const goal = runtime.nativeGoalSnapshot?.();
      if (this.closed || this.storageWarning || this.sessions.get(id) !== s || this.runtimes.get(id) !== runtime || this.stops.has(id) ||
          !sameStop(current(), expected) || s.nativeId !== proof.nativeId || s.controlRevision !== proof.controlRevision ||
          (this.draftRevisions.get(id) ?? 0) !== proof.draftRevision || spaces.placementRevision(s) !== proof.placementRevision || this.drafts.get(id) ||
          !['starting', 'idle', 'error'].includes(s.state) || s.nativeContextPending || s.pendingTag || s.approval ||
          !Array.isArray(s.messages) || s.messages.some(message => ['user', 'assistant'].includes(message?.role)) ||
          s.background > 0 || s.scheduled > 0 || s.fleet?.length ||
          runtime.turnId || runtime.rootTurn?.status === 'working' || runtime.pendingQueue || runtime.pendingSteer ||
          runtime.nativeInputRequired || runtime.nativeAbortRequest || goal?.status === 'active' || goal?.known === false ||
          [...this.rooms.values()].some(room => room.run?.status === 'running' && room.run.ids?.includes(id)) ||
          typeof runtime.stopForMaintenance !== 'function') throw refuse();
    };
    check();
    const result = await this.stop(id, { check, expected, participantOnly: true });
    if (result?.stopped !== true || this.sessions.get(id) !== s || !sameStop(current(), result.stoppedState) ||
        !['ended', 'recoverable', 'disconnected'].includes(s.state)) throw uiError('error.workspace.nativeEndUnconfirmed');
    return { state: s.state };
  }
  maintenanceResume(id, expected, owner) {
    const { sameStop } = require('./backend-switch.cjs'), s = this.get(id);
    if (!expected || s.state !== expected.state || !sameStop({ ...s, draftRevision: this.draftRevisions.get(id) || 0 }, expected)) throw uiError('error.backendSwitchSessionChanged', { name: s.name || id });
    return this.resume(id, owner);
  }
  assertMaintenanceShutdown(expected) {
    const { sameStop, sessionPlan } = require('./backend-switch.cjs');
    if (this.pendingNativeImports || this.stops.size || !Array.isArray(expected) || expected.length !== this.sessions.size || new Set(expected.map(s => s?.id)).size !== expected.length) throw uiError('error.backendSwitchOldPending');
    for (const room of this.rooms.values()) if (room.run?.status === 'running') throw uiError('error.backendSwitchOldPending');
    for (const proof of expected) {
      const s = this.sessions.get(proof?.id), runtime = this.runtimes.get(proof?.id);
      const carried = s && sessionPlan(s, s.state).carry;
      if (!s || !(carried || s.provider === 'codex' && s.state === 'disconnected') || s.state !== proof.state ||
          !sameStop({ ...s, draftRevision: this.draftRevisions.get(s.id) || 0 }, proof) || s.pendingTag || s.nativeContextPending || runtime?.turnId || runtime?.pendingQueue || runtime?.pendingSteer || runtime?.nativeInputRequired) throw uiError('error.backendSwitchOldPending');
    }
  }
  stop(id, maintenance = null) {
    if (this.stops.has(id)) return this.stops.get(id);
    const s = this.get(id);
    if (['ended', 'background'].includes(s.state)) return Promise.resolve();
    if (s.worktreePreparation && s.state === 'starting' && !this.runtimes.has(id)) {
      s.state = 'ended'; s.owner = null; s.controlRevision++;
      setActivity(s, ...uiActivity("notice.activity.gitStartCancelled", { arg1: s.worktreePreparation.target, arg2: s.worktreePreparation.branch }));
      this.changed(); this.persist(); return Promise.resolve();
    }
    if (s.externalHistory && s.recovering && s.state === 'starting' && !this.runtimes.has(id)) {
      s.connectionRevision = (s.connectionRevision || 0) + 1; s.recovering = false; s.state = 'recoverable';
      setActivity(s, ...uiActivity("notice.activity.connectionCancelled")); this.changed(); return Promise.resolve();
    }
    const runtime = this.runtime(id);
    let committed = false, stoppedState;
    const currentControl = () => ({ ...s, draftRevision: this.draftRevisions.get(id) || 0 });
    const stillOurs = () => !maintenance || this.sessions.get(id) === s && this.runtimes.get(id) === runtime && require('./backend-switch.cjs').sameStop(currentControl(), stoppedState);
    const begin = () => {
      maintenance?.check();
      committed = true;
      if (maintenance?.participantOnly) this.pauseParticipant(id, '正在断开原生会话', false, uiActivity('notice.run.disconnecting')[1]);
      else this.pause('正在断开原生会话', undefined, false, uiActivity('notice.run.disconnecting')[1]);
      s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1; s.recovering = false; s.state = 'stopping'; setActivity(s, ...uiActivity("notice.activity.waitingNativeConfirmation")); this.changed();
      stoppedState = { ...maintenance?.expected, controlRevision: s.controlRevision, connectionRevision: s.connectionRevision };
      this.stops.set(id, operation);
    };
    // A maintenance observer may await current native state. Keep those events
    // visible until its final synchronous check; the ordinary stop still reserves now.
    let operation;
    operation = Promise.resolve().then(() => maintenance ? runtime.stopForMaintenance(begin) : runtime.stop()).then(result => {
      if (!stillOurs()) throw uiError('error.backendSwitchDisconnectUnconfirmed', { name: s.name || id });
      if (!['ended', 'recoverable', 'disconnected'].includes(result?.state)) throw uiError("error.workspace.nativeEndUnconfirmed");
      s.state = result.state; s.pendingTag = null; s.approval = null; s.approvalResolved = false; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(id);
      setActivity(s, ...(result.state === 'ended' ? ['', null] : uiActivity(result.state === 'recoverable' ? 'notice.activity.backendExited' : 'notice.activity.connectionDetached')));
      if (['ended', 'recoverable'].includes(s.state)) { s.pid = null; this.runtimes.delete(id); }
      if (maintenance) return { stopped: true, expected: maintenance.expected, stoppedState: { ...stoppedState, state: s.state } };
    }).catch(error => { if (committed && stillOurs()) { s.state = 'error'; setActivity(s, error.message, error.uiMessage); } throw error; })
      .finally(() => { if (this.stops.get(id) === operation) { this.stops.delete(id); this.changed(); } });
    if (!maintenance) begin();
    return operation;
  }
  async resume(id, owner) {
    const s = this.get(id);
    if (s.worktreePreparation && s.worktreePreparation.status !== 'ready') throw uiError("error.workspace.gitRecoveryUnconfirmed", { arg1: s.worktreePreparation.target, arg2: s.worktreePreparation.branch });
    if (s.nativeContextPending) throw uiError("error.workspace.nativeContextIdentityUnconfirmed");
    const retained = this.runtimes.get(id);
    if ((s.state === 'disconnected' || (s.state === 'error' && retained?.transportDisconnected)) && s.provider === 'codex' && retained?.reconnect && !retained.backendExitConfirmed && !this.stops.has(id)) {
      if (s.pendingTag && s.messages.some(m => m.id === s.pendingTag && m.status === 'awaiting-native')) throw uiError("error.workspace.previousInputUnconfirmed");
      // Reconnection observes current native work; it does not renew a previous
      // reply-sharing authorization or attach it to a later native completion.
      if (s.pendingTag) {
        const shared = this.sharedMessage(s.pendingTag);
        if (shared) shared.status = 'reply-private';
        this.forwards.delete(s.pendingTag);
      }
      s.pendingTag = null; s.approval = null; s.approvals = []; s.approvalOverflow = false; this.approvalRoutes.delete(id);
      s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1;
      const generation = s.connectionRevision;
      s.owner = owner; s.recovering = true; s.state = 'starting'; setActivity(s, ...uiActivity("notice.activity.connectingHistory"));
      this.pause('重新连接原会话；之前的交接不会自动继续。', undefined, false, uiActivity('notice.run.reconnecting')[1]); this.changed();
      try { await retained.reconnect(); }
      catch (error) {
        if (generation === s.connectionRevision && !['ended', 'recoverable'].includes(s.state) && this.runtimes.get(id) === retained && !this.stops.has(id)) { s.state = retained.transportDisconnected ? 'error' : 'disconnected'; setActivity(s, error.message, error.uiMessage); }
        throw error;
      } finally { if (generation === s.connectionRevision) { s.recovering = false; this.changed(); } }
      return;
    }
    if (this.runtimes.has(id)) throw uiError("error.workspace.runningConnectionExists");
    if (!s.nativeId || !['ended', 'recoverable', 'error'].includes(s.state)) throw uiError("error.workspace.cannotResume");
    if (s.externalHistory) {
      if (this.storageWarning) throw uiError("error.workspace.storageIssueBeforeHistory");
    }
    const sameServer = s.provider === 'codex' && s.serverIdentity?.pid === this.host.codexProcess?.pid;
    if ((!sameServer && processMayBeAlive(s.serverIdentity)) || (processMayBeAlive(s.processIdentity) && !(sameServer && s.processIdentity.pid === s.serverIdentity.pid))) throw uiError("error.workspace.previousProcessMayRun");
    if (!fs.statSync(s.cwd).isDirectory()) throw uiError("error.workspace.originalDirectoryUnavailable");
    s.controlRevision++; s.connectionRevision = (s.connectionRevision || 0) + 1; s.owner = owner; s.recovering = true; s.state = 'starting'; setActivity(s, ...uiActivity("notice.activity.connectingHistory"));
    // Membership is retained, but an interrupted automatic run never restarts.
    this.pause('恢复原生会话后，请重新选择本次协作任务。', undefined, false, uiActivity('notice.run.resumedTask')[1]); this.changed();
    let runtime;
    const generation = s.connectionRevision;
    try {
      if (s.externalHistory) {
        if (s.provider === 'codex') await this.nativeHistory.ready();
        if (this.closed || this.storageWarning || this.sessions.get(id) !== s || generation !== s.connectionRevision || s.state !== 'starting' || this.runtimes.has(id) || this.stops.has(id)) throw uiError("error.workspace.resumeStateChanged");
      }
      runtime = this.host.create(s); this.runtimes.set(id, runtime); this.bind(s, runtime);
      if (runtime.start) await runtime.start();
    } catch (error) {
      if (this.sessions.get(id) === s && generation === s.connectionRevision && (runtime ? this.runtimes.get(id) === runtime : s.state === 'starting')) {
        if (!runtime?.terminal?.alive && !runtime?.hasHistory) this.runtimes.delete(id);
        s.state = 'error'; setActivity(s, error.message, error.uiMessage); this.changed();
      }
      throw error;
    } finally { if (generation === s.connectionRevision) { s.recovering = false; this.changed(); } }
  }
  clearSharedHistory(roomId = 'shared') {
    if (this.storageWarning) throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage });
    const room = this.roomFor(roomId);
    if (room.run?.status === 'running') throw uiError("error.workspace.pauseBeforeClear");
    if (room.run?.pausePending || room.run?.pauseUnconfirmed) throw uiError("error.main.clearNeedsLeaseRevocation");
    const retained = { run: room.run, messages: room.messages, revision: room.revision };
    for (const s of this.sessions.values()) if (spaces.isMember(s, roomId)) s.peerRevision = (s.peerRevision || 0) + 1;
    this.peerLeases?.revoke('共享记录已清除，原交接授权已撤销。', undefined, roomId, uiActivity('notice.peer.sharedCleared')[1]);
    for (const [tag, grant] of this.sharedReplies.grants) if ((grant.roomId || 'shared') === roomId) { this.sharedReplies.close(tag); this.sharedReplies.grants.delete(tag); this.forwards.delete(tag); }
    for (const [tag, forward] of this.forwards) if ((forward.roomId || 'shared') === roomId) this.forwards.delete(tag);
    room.run = null; room.messages = []; room.revision++; this.changed(); this.persist();
    if (this.storageWarning) { Object.assign(room, retained); this.emit('change'); throw Object.assign(Error(this.storageWarning), { uiMessage: this.storageWarningUiMessage }); }
    // Images kept only for these shared rows, from sessions whose records are already removed.
    const removed = new Set(retained.messages.filter(m => m.sessionId && !this.sessions.has(m.sessionId) && m.images?.some(cachedImageKey)).map(m => m.sessionId)), keep = this.sharedImageKeys();
    if ([...removed].map(id => removeCachedImages(this.dataDir, id, keep)).some(r => r.failed)) return { imagesLeft: true };
  }
  // Cached native images that a collaboration space's shared rows still show.
  sharedImageKeys() {
    const keys = new Set();
    for (const room of this.rooms.values()) for (const m of room.messages || []) for (const ref of Array.isArray(m.images) ? m.images : []) { const key = cachedImageKey(ref); if (key) keys.add(key); }
    return keys;
  }
  // T-140: removing a session's records also removes this app's copies of its native images,
  // once the removal is saved. Images its shared rows show stay with the shared record (the
  // removal dialog promises shared content stays) until that record is cleared. The records go
  // even when the files cannot; the caller reports it after its own cleanup.
  forget(id) {
    const s = this.get(id);
    if (this.runtimes.has(id) || (s.state !== 'ended' && (processMayBeAlive(s.processIdentity) || processMayBeAlive(s.serverIdentity)))) throw uiError("error.workspace.nativeConnectionExists");
    this.sessions.delete(id); this.drafts.delete(id); this.draftRevisions.delete(id); this.changed(); this.persist();
    this.progress.delete(id); this.observedTerminals.delete(id);
    if (!this.storageWarning && removeCachedImages(this.dataDir, id, this.sharedImageKeys()).failed) return { imagesLeft: true };
  }
  close() {
    this.closed = true; clearTimeout(this.saveTimer); clearInterval(this.deadlineTimer); clearTimeout(this.wakeHoldTimer);
    for (const wait of this.stuckWaits.values()) clearTimeout(wait.timer);
    this.stuckWaits.clear(); this.persist(); this.host.close();
  }
}

module.exports = { Workspace, cleanText, isTerminalResponse, createSettings, sessionMaker, CLAUDE_PERMISSION_MODES, CLAUDE_EFFORTS };
