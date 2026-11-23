const { snapshotImageRoots } = require('./native-images.cjs');
const { uiError, uiNotice } = require('./ui-errors.cjs');
const liveUnsavedActivity = uiNotice('notice.activity.liveUnsaved');
const { codexVersionInfo } = require('./native-history.cjs');
const { EventEmitter } = require('node:events');
const { submissionState, assertSubmission, assertSharing, assertAutomaticRun, assertNativeCreation } = require('./submission-policy.cjs');
const { isTerminalResponse } = require('./workspace.cjs');
const { LegacyObservation, supportsLegacyObservation } = require('./legacy-observation.cjs');
const { LegacyInput, eligible: legacyInputEligible } = require('./legacy-input.cjs');
const { nativeApprovalPolicy } = require('./approval-policy.js');
const { CAPABILITY: PEER_HANDOFFS, DIRECTED: PEER_DIRECTED, identity: peerIdentity, mergePeerMessages } = require('./peer-handoffs.cjs');
const spaces = require('./collaboration-spaces.cjs');
const backendRooms = state => state.rooms || [state.room];
const backendRoom = (state, id) => backendRooms(state).find(r => (r?.id || 'shared') === id);
// Cache-eviction notices have a fixed service-local id, including in retained
// backends. Scope only that synthetic row in the combined display; real message
// ownership remains strict and original service records stay untouched.
const sharedDisplayMessage = (message, source) => message.id === 'shared-native-cache-gap' &&
  message.role === 'system' && message.kind === 'gap' && message.volatile === true && message.incomplete === true
  ? { ...message, id: `${message.id}:${encodeURIComponent(source)}` } : message;
// An older backend cannot verify an undo proof even for the original space.
const SPACE_METHODS = new Set(['join', 'forward', 'queueShared', 'steerShared', 'run', 'pause', 'clearSharedHistory']);
let creationQueue = Promise.resolve();
const controls = new Map();
// Input the person confirmed reaches its target whichever window holds it (2026-11-23). A backend from before
// consentedInputV1 takes input only from the holding window, so it goes through that window's connection; who
// holds the session does not change. null: no open window holds it there.
function inputCarrier(control, target, id) {
  const record = target.state.sessions.find(s => s.id === id);
  if (!record) return null;
  if (target.state.capabilities?.includes('consentedInputV1') || record.owner === target.state.owner) return target;
  if (record.owner == null) return null;
  for (const view of control?.views || []) {
    if (view.closing) continue;
    const entry = view.entries.find(e => e.key === target.key && !e.closed && !e.closing && e.state.owner === record.owner);
    if (entry) return entry;
  }
  return null;
}
// Why input confirmed for the view `owner` could not be delivered ('' when it could), asked before the card is
// shown. `seen` is the target as the asking window shows it: another view's copy can lag a state event behind.
// Only open views' state is read; nothing is sent.
function consentedInputBlocked(scope, id, owner, seen) {
  const control = controls.get(scope);
  for (const view of control?.views || []) {
    if (view.closing) continue;
    const entry = view.entries.find(e => !e.closed && !e.closing && e.state.sessions.some(s => s.id === id));
    if (!entry) continue;
    const record = seen?.id === id ? seen : entry.state.sessions.find(s => s.id === id);
    return inputCarrier(control, { ...entry, state: { ...entry.state, owner, sessions: [record] } }, id) ? '' : 'holder-unavailable';
  }
  return '';
}
// A state event can arrive with the reply to `initial`, before an entry listens to its client: the entry starts
// from that event, not from the older reply.
function newestState(entry) {
  entry.stateOrder = entry.client.receivedOrder?.(entry.state) || 0;
  const newer = entry.client.lastState, order = newer && entry.client.receivedOrder?.(newer);
  if (order > entry.stateOrder) { entry.state = { ...entry.state, ...newer }; entry.stateOrder = order; }
}

// A flat routing layer, not a second agent runtime. Each service remains the
// sole writer of its sessions, drafts and shared replies, even with no UI open.
class WorkspaceClient extends EventEmitter {
  constructor(entries, active, scope = Symbol()) {
    super(); this.entries = entries; this.active = entries.find(e => e.key === active); this.closing = false; this.legacyObservers = new Map();
    this.scope = scope;
    if (!controls.has(scope)) controls.set(scope, { revision: 0, manualEpoch: 0, sessionRevisions: new Map(), streamRevisions: new Map(), clients: 0, armed: new Map(), interventions: new Set(), views: new Set(), maintenance: new Set(), generations: new Map() });
    this.control = controls.get(scope); this.control.clients++; this.control.views.add(this);
    this.control.spaceRevisions ||= new Map();
    this.control.legacyOwners ||= new Map();
    for (const entry of entries) { newestState(entry); this.observeLegacyOwners(entry); }
    if (typeof scope === 'string' && !this.control.legacyInput) {
      this.control.legacyInput = new LegacyInput(scope);
      this.control.legacyInput.on('change', () => { for (const view of this.control.views) if (!view.closing) view.emit('state', view.snapshot()); });
      this.control.legacyInput.on('progress', update => { for (const view of this.control.views) if (!view.closing) view.emit('progress', update); });
    }
    for (const entry of entries) {
      entry.closed = false; entry.closing = false;
      entry.closedPromise = new Promise(resolve => { entry.confirmClosed = resolve; });
      if (backendRooms(entry.state).some(r => r?.run?.status === 'running') && !this.control.armed.has(entry.key)) this.control.armed.set(entry.key, { entry, roomId: backendRooms(entry.state).find(r => r?.run?.status === 'running').id || 'shared' });
    }
    this.socket = { destroyed: false };
    for (const entry of entries) {
      this.bindEntry(entry);
    }
    this.control.legacyInput?.restore(entries).catch(() => {});
  }
  bindEntry(entry) {
      const client = entry.client;
      client.on('state', state => {
        if (entry.client !== client) return;
        entry.stateOrder = client.receivedOrder?.(state) || entry.stateOrder;
        entry.state = { ...entry.state, ...state };
        this.observeLegacyOwners(entry);
        try { this.emit('state', this.snapshot()); }
        catch { this.socket.destroyed = true; this.emit('closed'); this.close(); }
      });
      client.on('terminal', data => { if (entry.client === client) { this.emit('terminal', data); this.legacyObservers.get(data.id)?.changed(); } });
      client.on('progress', data => { if (entry.client === client) this.emit('progress', data); });
      client.on('closed', () => {
        if (entry.client !== client) return;
        entry.closed = true; entry.confirmClosed();
        // A retired view's own sockets closing is not a change of control anywhere else.
        if (!this.retired) { this.control.revision++; this.control.manualEpoch++; }
        for (const s of entry.state.sessions) { this.legacyObservers.get(s.id)?.dispose(); this.legacyObservers.delete(s.id); }
        if (this.control.maintenance.has(entry.key)) return;
        this.socket.destroyed = true; if (!this.closing) this.emit('closed');
      });
  }
  // reconnected: this window's own transport to the same service came back (service-reconnect.cjs). The window's
  // operations on the closed one have failed already; the generation every window's operations are checked
  // against is for a backend that was replaced, and stays.
  replaceService(key, client, state, { reconnected = false } = {}) {
    const entry = this.entries.find(e => e.key === key);
    if (!entry || this.closing) { client.close(); throw uiError("error.client.windowConnectionChanged"); }
    const old = entry.client;
    for (const s of entry.state.sessions) { this.legacyObservers.get(s.id)?.dispose(); this.legacyObservers.delete(s.id); }
    if (!reconnected) this.control.generations.set(key, (this.control.generations.get(key) || 0) + 1);
    entry.client = client; entry.state = state; entry.closed = false; entry.closing = false;
    newestState(entry);
    this.observeLegacyOwners(entry);
    entry.closedPromise = new Promise(resolve => { entry.confirmClosed = resolve; });
    this.bindEntry(entry); old.close();
    this.socket.destroyed = this.entries.some(e => e.closed);
  }
  maintainService(key) {
    if (this.control.maintenance.has(key)) throw uiError("error.client.connectionAlreadyUpdating");
    this.control.maintenance.add(key);
    this.control.generations.set(key, (this.control.generations.get(key) || 0) + 1); this.control.revision++; this.control.manualEpoch++;
    return () => {
      this.control.maintenance.delete(key);
      for (const view of this.control.views) if (view.entries.some(e => e.closed && !this.control.maintenance.has(e.key))) {
        view.socket.destroyed = true; view.emit('closed');
      }
    };
  }
  operationGuard(entry) {
    const client = entry.client, generation = this.control.generations.get(entry.key) || 0;
    return () => {
      if (this.control.maintenance.has(entry.key)) throw uiError("error.client.connectionUpdatingNoInput");
      if (entry.client !== client || (this.control.generations.get(entry.key) || 0) !== generation || entry.closed || this.closing) throw uiError("error.client.connectionChangedNoReplay");
    };
  }
  sessionState(record) { return this.control.legacyInput?.effectiveState?.(record) || record?.state; }
  snapshot(roomId = 'shared') {
    const sessions = [], messages = new Map(), runs = [], additional = new Map();
    const ids = new Set();
    for (const e of this.entries) {
      const state = submissionState(e.state);
      for (const s of state.sessions) {
        if (ids.has(s.id)) throw uiError("error.client.sessionOwnershipConflict");
        const bridge = this.control.legacyInput;
        const failedTurnInputAvailable = s.state === 'error' && Boolean(bridge?.target(s)?.failedTurnInputId);
        const legacySubmit = legacyInputEligible(e.state, s) && (['idle', 'working', 'approval', 'starting'].includes(s.state) || failedTurnInputAvailable) && !!bridge?.connected(s);
        const native = bridge?.target(s)?.native;
        const reader = bridge?.reader?.(s);
        const legacyCodex = e.state.runtimeVersion === '0.1.0-alpha.2' && s.provider === 'codex';
        const approvalDecisionAvailable = legacyCodex ? Boolean(native?.connected) : Boolean(e.state.capabilities?.includes('nativeApprovalSync'));
        const approval = legacyCodex ? native?.approval : s.approval;
        const approvalDecisions = approvalDecisionAvailable ? nativeApprovalPolicy(approval, {
          localDecisions: legacyCodex || e.state.capabilities?.includes('nativeApprovalLocalDecisions') === true,
        }).decisions : [];
        const approvals = (legacyCodex ? native?.connected && native.approvals : s.approvals) || (approval ? [approval] : []);
        const approvalOverflow = legacyCodex ? Boolean(native?.connected && native.approvalOverflow) : Boolean(s.approvalOverflow);
        // freeClaim: this session's service takes it for a window only while no other open window holds it.
        // eitherViewInput: its service takes terminal keys from the controlling window on either side of the view; a
        // service from before that refuses them while the view is on the conversation side.
        ids.add(s.id); sessions.push({ ...s, peerIdentity: peerIdentity(s), freeClaim: e.state.runtimeVersion !== '0.1.0-alpha.2' && Boolean(e.state.capabilities?.includes('freeClaimV1')),
          eitherViewInput: e.state.runtimeVersion !== '0.1.0-alpha.2' && Boolean(e.state.capabilities?.includes('eitherViewInputV1')), legacyObservation: supportsLegacyObservation(e.state, s), legacyProgress: !!native?.connected,
          legacyInputEligible: legacyInputEligible(e.state, s), legacyInputPrepared: !!bridge?.prepared(s), legacySubmit,
          nativeInputRequired: Boolean(s.nativeInputRequired || reader?.nativeInputRequired),
          failedTurnInputAvailable: Boolean(s.failedTurnInputAvailable || failedTurnInputAvailable),
          legacyReaderPending: s.provider === 'claude' && legacySubmit && !reader?.initialized,
          legacyShare: legacySubmit,
          legacySharedReply: Boolean(legacySubmit && bridge.target(s)?.sharedReplyAvailable && !bridge.sharedReplies?.storageError),
          legacySharedSteer: Boolean(legacySubmit && native?.sharedReplyAvailable && native.steerAvailable && !bridge.sharedReplies?.storageError),
          legacySharedQueue: Boolean(legacySubmit && s.provider === 'claude' && bridge.target(s)?.sharedReplyAvailable && !bridge.sharedReplies?.storageError),
          ...(s.provider === 'claude' && legacySubmit ? { state: this.sessionState(s), nativeInputRequired: Boolean(bridge.target(s)?.nativeInputRequired), queueAvailable: Boolean(bridge.target(s)?.queueAvailable), pendingQueue: bridge.target(s)?.pendingQueue || null } : {}),
          ...(reader?.initialized ? { nativeBlockMapping: true, messages: reader.record.messages,
            ...(s.provider === 'claude' ? { model: reader.model || '原生未报告', modelUiMessage: reader.model ? reader.modelUiMessage || null : uiNotice('notice.model.nativeUnreported').uiMessage, usage: reader.usage || null, sharedActivity: bridge?.sharedReplies?.activity(reader.record) || null, nativeActivity: reader.nativeActivity, nativeApproval: reader.nativeApproval, activeTurnId: reader.turnId } : {}),
            ...(reader.storageError ? { activity: liveUnsavedActivity.text, activityUiMessage: liveUnsavedActivity.uiMessage } : {}) } : {}),
          ...(bridge?.readerUnavailable?.(s) ? { nativeBlockMapping: true, messages: [{ id: 'retained-reader-unavailable', role: 'system', kind: 'gap', incomplete: true,
            text: '原生阅读记录暂不可用；没有以旧后台内容替换，请在原生终端继续。', uiMessage: uiNotice('notice.client.readerUnavailable').uiMessage }] } : {}),
          ...(legacyCodex && native ? { ...codexVersionInfo(native.rpc, native.connected && !native.closed), nativeBlockMapping: true, nativeSettings: native.nativeSettings, sharedActivity: bridge?.sharedReplies?.activity(native.record) || null, nativeActivity: native.connected && !native.closed ? native.nativeActivity : null, steerAvailable: Boolean(native.steerAvailable), activeTurnId: native.turnId, pendingSteer: native.pendingSteer || null, messages: native.record.messages, model: native.model || '原生未报告', modelUiMessage: native.model ? native.modelUiMessage || null : uiNotice('notice.model.nativeUnreported').uiMessage, usage: native.usage || null,
            ...(native.storageError ? { activity: liveUnsavedActivity.text, activityUiMessage: liveUnsavedActivity.uiMessage } : native.connected ? { activity: native.activity || '', activityUiMessage: native.activityUiMessage || null } : {}) } : {}),
          ...(legacySubmit ? { chatAvailable: true, shareAvailable: true, submissionNotice: null, submissionNoticeUiMessage: null,
            sharingNotice: bridge.target(s)?.sharedReplyAvailable && !bridge.sharedReplies?.storageError
              ? '只发送选定的内容；对应的原生回复实时显示在共同消息流中，不自动交给其他 agent。'
              : '只发送你选定的内容。回复在成员视图查看；再次分享由你选择，不会自动转发私人回复。',
            sharingNoticeUiMessage: uiNotice(bridge.target(s)?.sharedReplyAvailable && !bridge.sharedReplies?.storageError ? 'notice.client.sharingLive' : 'notice.client.sharingPrivate').uiMessage, ...(native?.state ? { state: native.state } : {}),
            pendingTag: bridge.target(s)?.submission.pending?.tag || s.pendingTag } : {}),
          ...(legacyCodex
            ? { approval: native?.connected ? native.approval : null, approvalResolved: Boolean(native?.connected && native.approvalResolved) } : {}),
          approvals: approvals.map(request => ({ ...request, decisions: approvalDecisionAvailable && !approvalOverflow ? nativeApprovalPolicy(request, {
            localDecisions: legacyCodex || e.state.capabilities?.includes('nativeApprovalLocalDecisions') === true,
          }).decisions : [] })), approvalOverflow,
          approvalDecisionAvailable, approvalDecisions: approvalOverflow ? [] : approvalDecisions,
          approvalNotice: s.provider === 'codex' && !approvalDecisionAvailable ? '旧连接无法核实这项确认的最新状态，请在原生终端核对。原会话继续保留。' : null,
          approvalNoticeUiMessage: s.provider === 'codex' && !approvalDecisionAvailable ? uiNotice('notice.client.approvalUnverified').uiMessage : null,
          handoffGroup: this.entries.indexOf(e), serviceCapabilities: e.state.capabilities || [], runtimeVersion: e.state.runtimeVersion });
      }
      for (const original of state.room.messages || []) {
        const m = sharedDisplayMessage(original, e.key);
        if (messages.has(m.id)) throw uiError("error.client.sharedRecordOwnershipConflict");
        messages.set(m.id, m);
      }
      if (state.room.run) runs.push(state.room.run);
      for (const room of backendRooms(state)) if (room?.id && room.id !== 'shared') {
        if (!spaces.roomId(room.id) || !state.capabilities?.includes('collaborationSpacesV1')) throw uiError("error.client.spaceOwnershipUnverifiable");
        if (!additional.has(room.id)) additional.set(room.id, { id: room.id, revision: 0, messages: new Map(), runs: [], snapshotBatches: [] });
        const combined = additional.get(room.id); combined.revision += room.revision || 0;
        if (room.snapshotBatches !== undefined && !Array.isArray(room.snapshotBatches)) throw uiError("error.client.mergeSnapshotOwnershipUnverifiable");
        for (const marker of room.snapshotBatches || []) {
          if (combined.snapshotBatches.some(value => value.operationId === marker.operationId)) throw uiError("error.client.mergeSnapshotMultipleOwners");
          combined.snapshotBatches.push({ ...marker });
        }
        for (const original of room.messages || []) { const m = sharedDisplayMessage(original, e.key); if (combined.messages.has(m.id)) throw uiError("error.client.spaceRecordOwnershipConflict"); combined.messages.set(m.id, m); }
        if (room.run) combined.runs.push(room.run);
      }
    }
    for (const original of this.control.legacyInput?.sharedMessages?.() || []) {
      const message = sharedDisplayMessage(original, 'legacy-reader');
      if (messages.has(message.id)) throw uiError("error.client.sharedRecordOwnershipConflict");
      messages.set(message.id, message);
    }
    const memberServices = this.entries.filter(e => e.state.sessions.some(s => spaces.isMember(s, roomId)));
    const routingService = memberServices.length === 1 ? memberServices[0] : this.active;
    const capabilities = (this.active.state.capabilities || []).filter(cap => {
      if (['verifiedHandoffs', 'boundedReplyHandoffs', 'agentAddressedHandoffs'].includes(cap)) return memberServices.length <= 1 && routingService.state.capabilities?.includes(cap) && routingService.state.capabilities?.includes('nativeInputIsolation') &&
        (!routingService.state.sessions.some(s => spaces.isMember(s, roomId) && s.provider === 'claude') || routingService.state.capabilities?.includes('claudePromptIdentity'));
      if (cap === 'clearSharedHistory') return this.entries.every(e => e.state.capabilities?.includes(cap)
        || (e.state.runtimeVersion === '0.1.0-alpha.2' && !e.state.room.messages?.length));
      return true;
    });
    const sum = key => this.entries.every(e => Number.isSafeInteger(e.state.diagnostics?.[key])) ? this.entries.reduce((n, e) => n + e.state.diagnostics[key], 0) : null;
    const sortedRun = runs => runs.sort((a, b) => Boolean(b.pausePending || b.pauseUnconfirmed) - Boolean(a.pausePending || a.pauseUnconfirmed) || (b.status === 'running') - (a.status === 'running') || (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
    const rooms = [{ ...this.active.state.room, id: 'shared', revision: this.entries.reduce((n, e) => n + (e.state.room.revision || 0), 0), run: sortedRun(runs), messages: mergePeerMessages([...messages.values()]).sort((a, b) => (a.time || 0) - (b.time || 0)) },
      ...[...additional.values()].map(r => ({ id: r.id, revision: r.revision, run: sortedRun(r.runs), snapshotBatches: r.snapshotBatches,
        messages: mergePeerMessages([...r.messages.values()]).sort((a, b) =>
          Boolean(b.snapshotBatch) - Boolean(a.snapshotBatch) || (a.snapshotBatch && b.snapshotBatch
            ? r.snapshotBatches.findIndex(marker => marker.operationId === a.snapshotBatch) - r.snapshotBatches.findIndex(marker => marker.operationId === b.snapshotBatch) || a.snapshotOrder - b.snapshotOrder
            : (a.time || 0) - (b.time || 0))) }))];
    const warningParts = [...this.entries.map(e => ({ message: e.state.storageWarning, uiMessage: e.state.storageWarningUiMessage })),
      ...this.entries.map(e => ({ message: e.state.wakePolicy?.warning, uiMessage: e.state.wakePolicy?.warningUiMessage })),
      { message: this.control.legacyInput?.storageWarning, uiMessage: this.control.legacyInput?.storageWarningUiMessage },
      ...(this.control.legacyInput?.sharedReplies?.storageError ? [uiError('error.warning.sharedReplyUnsaved')] : [])].filter(part => part.message);
    const storageDisplay = uiError('error.warningLines', { warnings: warningParts.map(part => part.message).join('\n') }, { parts: warningParts, param: 'warnings', separator: '\n' });
    // The backend that takes new sessions cannot run a provider: shown as a standing notice, not left to fail at
    // the next session start. Only a backend that resolves its programs again on every initial state is believed.
    const programNames = { claude: 'Claude Code', codex: 'Codex', python: 'Python 3' };
    const programs = this.active.state.capabilities?.includes('programAvailabilityV1') ? this.active.state.available : null;
    const missingPrograms = programs ? Object.keys(programNames).filter(key => programs[key] === false) : [];
    const programDisplay = missingPrograms.length ? uiError('error.warning.programsMissing', { programs: missingPrograms.map(key => programNames[key]).join(', ') }) : null;
    const operators = this.entries.filter(e => e.state.capabilities?.includes('operatorControl1a'));
    const operatorPolicy = operators.length ? { enabled: operators.every(e => !e.closed && !e.closing && !this.control.maintenance.has(e.key) && e.state.operatorPolicy?.enabled === true && !e.state.operatorPolicy?.error),
      error: operators.find(e => e.state.operatorPolicy?.error)?.state.operatorPolicy.error || null, domains: operators.flatMap(e => e.state.operatorPolicy?.domains || []),
      // B5: sessions created under a grant that names a space, until the desktop has placed them (operator-control.cjs).
      placements: operators.flatMap(e => e.state.operatorPolicy?.placements || []),
      // B5: holders whose session has ended, until the desktop has carried their grant to the replacing session or found no one to carry it to.
      successions: operators.flatMap(e => e.state.operatorPolicy?.successions || []) } : null;
    return { ...this.active.state, operatorPolicy, nativeImageCacheRoots: snapshotImageRoots(this.entries.map(e => e.state.nativeImageCacheRoot).filter(Boolean)), wakePolicy: this.entries.find(e => e.state.capabilities?.includes('agentWakeV1'))?.state.wakePolicy, sessions, capabilities,
      rooms, room: rooms.find(r => r.id === roomId) || { id: roomId, revision: 0, run: null, messages: [] },
      diagnostics: { shellModelCalls: sum('shellModelCalls'), dispatches: sum('dispatches') === null ? null : sum('dispatches') + (this.control.legacyInput?.localDispatchCount?.() ?? this.control.legacyInput?.records.length ?? 0) },
      storageWarning: storageDisplay.message || null, storageWarningUiMessage: storageDisplay.uiMessage || null,
      programWarning: programDisplay?.message || null, programWarningUiMessage: programDisplay?.uiMessage || null,
      storageRetryable: this.entries.some(e => e.state.storageRetryable && e.state.capabilities?.includes('retrySave')),
      services: this.entries.map(e => ({ version: e.state.runtimeVersion, active: e === this.active, sessions: e.state.sessions.length })),
      peerHandoffsAvailable: this.active.state.capabilities?.includes(PEER_HANDOFFS) === true,
      peerDirectedAvailable: this.active.state.capabilities?.includes(PEER_DIRECTED) === true,
      handoffNotice: memberServices.length > 1 && !memberServices.every(e => e.state.capabilities?.includes(PEER_HANDOFFS)) ? '成员使用不同版本的后台，自动交接暂不可用。可在同一协作视图查看终端、选择内容并定向分享。' : null,
      handoffNoticeUiMessage: memberServices.length > 1 && !memberServices.every(e => e.state.capabilities?.includes(PEER_HANDOFFS)) ? uiError('error.client.mixedBackends').uiMessage : null,
    };
  }
  route(id) {
    const matches = this.entries.filter(e => e.state.sessions.some(s => s.id === id));
    if (matches.length !== 1) throw uiError("error.client.uniqueSessionOwnerMissing");
    return matches[0];
  }
  observeLegacyOwners(entry) {
    if (entry.state.runtimeVersion !== '0.1.0-alpha.2') return;
    for (const record of entry.state.sessions) {
      const previous = this.control.legacyOwners.get(record.id);
      const generation = this.control.generations.get(entry.key) || 0;
      const same = previous && previous.nativeId === record.nativeId && previous.pid === record.pid && previous.generation === generation;
      if (same && Number.isSafeInteger(record.controlRevision) && record.controlRevision < previous.controlRevision) {
        // Another view's older initial response must not reverse an observed
        // takeover. Native input advances this counter without changing owner.
        record.owner = previous.owner; record.controlRevision = previous.controlRevision;
        continue;
      }
      this.control.legacyOwners.set(record.id, { owner: record.owner, nativeId: record.nativeId, pid: record.pid, generation,
        controlRevision: record.controlRevision, revision: (previous?.revision || 0) + (!same || previous.owner !== record.owner ? 1 : 0) });
    }
  }
  async refresh(roomId = 'shared') {
    await Promise.all(this.entries.map(async e => {
      if (this.control.maintenance.has(e.key)) return;
      const client = e.client, generation = this.control.generations.get(e.key) || 0;
      const state = await client.call('initial');
      if (e.client !== client || generation !== (this.control.generations.get(e.key) || 0) || this.control.maintenance.has(e.key)) return;
      // An initial response may share a socket chunk with a later state event.
      // Resolving its promise must not roll that event (or a newer read) back.
      const order = client.receivedOrder?.(state);
      if (order && order < e.stateOrder) return;
      e.stateOrder = order || e.stateOrder;
      e.state = state;
      this.observeLegacyOwners(e);
      if (backendRooms(e.state).some(r => r?.run?.status === 'running') && !this.control.armed.has(e.key)) this.control.armed.set(e.key, { entry: e, roomId: backendRooms(e.state).find(r => r?.run?.status === 'running').id || 'shared' });
    }));
    return this.snapshot(roomId);
  }
  // The consent fingerprint and the actual control route share these branch
  // conditions. This describes side effects; it never grants control itself.
  controlPauseScope(method, args, target = this.route(args[0])) {
    if (method === 'interrupt') return 'all';
    if (method === 'input') return isTerminalResponse(args[1]) ? 'target' : 'all';
    if (method === 'claim' && args[2] === 'free') return 'target';
    if (!['claim', 'terminal'].includes(method)) return null;
    const record = target.state.sessions.find(s => s.id === args[0]);
    const owned = target.state.runtimeVersion === '0.1.0-alpha.2'
      ? record?.owner === target.state.owner
      : typeof target.state.owner === 'string' && record?.owner === target.state.owner;
    return owned ? 'target' : 'all';
  }
  async pauseExcept(target, roomId, participant) {
    // Run intent is shared by every window and registered before its RPC, not
    // inferred from a delayed display snapshot. Use the originating connection
    // so pause is ordered after run even when another window intervenes.
    await Promise.all([...this.control.armed].filter(([key, arm]) => key !== target?.key && (roomId === undefined || (arm.roomId || 'shared') === roomId || participant && backendRooms(arm.entry.state).some(r => r?.run?.status === 'running' && r.run.ids?.includes(participant)))).map(([, arm]) => this.pauseEntry(arm.entry, false, roomId !== undefined)));
  }
  async pauseEntry(entry, explicit = false, scoped = false) {
    const arm = this.control.armed.get(entry.key);
    if (!arm) return explicit ? entry.client.call('pause', { withdrawWakes: true }) : undefined;
    if (!arm.pause) arm.pause = (async () => {
      if (arm.entry.closing || arm.entry.closed) {
        // A normal window close is not a cancellation. Wait for its ordered
        // connection to close before another window sends the pause.
        if (!arm.entry.closed) {
          let timer;
          try { await Promise.race([arm.entry.closedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(uiError("error.client.originalWindowDisconnectUnconfirmed")), 2500); })]); }
          finally { clearTimeout(timer); }
        }
        const replacement = [...this.control.views].filter(view => !view.closing && !view.socket.destroyed).flatMap(view => view.entries).find(e => e.key === entry.key && !e.closed && !e.closing);
        if (!replacement) throw uiError("error.client.noPausableConnection");
        arm.entry = replacement;
      }
      return scoped ? this.invoke(arm.entry, arm.roomId || 'shared', 'pause', [], true) : arm.entry.client.call('pause', ...(explicit ? [{ withdrawWakes: true }] : []));
    })().then(result => {
      if (this.control.armed.get(entry.key) === arm) this.control.armed.delete(entry.key);
      return result;
    }).catch(error => { arm.pause = null; throw error; });
    return arm.pause;
  }
  manualGuard(id) {
    const epoch = this.control.manualEpoch, revision = this.control.sessionRevisions.get(id);
    return () => this.control.manualEpoch === epoch && this.control.sessionRevisions.get(id) === revision;
  }
  async intervene(operation, id, preserveManualStream = false, strictWake = false, roomId, revokeWakes = false) {
    if (roomId !== undefined) {
      // A membership/space pause revokes only that room's pending authority.
      // It is neither private native input nor a global agent-wake revocation.
      if (!id) this.control.spaceRevisions.set(roomId, (this.control.spaceRevisions.get(roomId) || 0) + 1);
      if (id) {
        this.control.sessionRevisions.set(id, (this.control.sessionRevisions.get(id) || 0) + 1);
        if (!preserveManualStream) this.control.streamRevisions.set(id, (this.control.streamRevisions.get(id) || 0) + 1);
      }
      const pending = operation(); this.control.interventions.add(pending);
      try { return await pending; } finally { this.control.interventions.delete(pending); }
    }
    // Input, takeover or interruption in one session is recorded by that session's
    // backend (its control/peer revisions are in both wake proofs), so it voids only
    // wakes involving that session. Pausing all follow-up handoffs, and the phone
    // path that requires a confirmed revocation, still withdraw every staged wake.
    if (strictWake || revokeWakes) {
      if (typeof this.scope === 'string' && (strictWake || this.entries.some(e => e.state.capabilities?.includes('agentWakeV1')))) {
        const confirmed = require('./session-wake.cjs').revoke({ dataDir: this.scope, sessions: new Map() });
        if (strictWake && confirmed !== true) throw Object.assign(uiError("error.client.mobileRevocationUnconfirmed"), { notSent: true });
      } else if (strictWake) throw Object.assign(uiError("error.client.mobileLocalScopeUnconfirmed"), { notSent: true });
    }
    this.control.revision++;
    // Waiting shared input is not a native interruption. Keep the original
    // explicitly shared stream until its native end/pickup boundary.
    if (id) {
      this.control.sessionRevisions.set(id, (this.control.sessionRevisions.get(id) || 0) + 1);
      if (!preserveManualStream) this.control.streamRevisions.set(id, (this.control.streamRevisions.get(id) || 0) + 1);
    } else this.control.manualEpoch++;
    const pending = operation(); this.control.interventions.add(pending);
    try { return await pending; } finally { this.control.interventions.delete(pending); }
  }
  legacyMutation(entry, operation) {
    // alpha.2 has no owner check/CAS for drafts. Order every portal window's
    // claim, terminal claim, interrupt (which implicitly claims) and draft
    // write on the same retained service.
    this.control.legacyWrites ||= new Map();
    const queues = this.control.legacyWrites;
    const pending = (queues.get(entry.key) || Promise.resolve()).then(operation);
    const tail = pending.catch(() => {}); queues.set(entry.key, tail);
    tail.finally(() => { if (queues.get(entry.key) === tail) queues.delete(entry.key); });
    return pending;
  }
  legacyDraft(entry, id, text, expected, valid = () => true) {
    const guard = this.operationGuard(entry);
    const ownerRevision = this.control.legacyOwners.get(id)?.revision;
    return this.legacyMutation(entry, async () => {
      guard(); await this.refresh(); guard(); this.authorizeOperation?.('draft', [id, text]);
      const current = entry.state.sessions.find(s => s.id === id);
      if (!current || current.owner !== entry.state.owner || current.owner !== expected.owner
        || current.nativeId !== expected.nativeId || current.pid !== expected.pid
        || this.control.legacyOwners.get(id)?.revision !== ownerRevision || !valid(current)) throw uiError("error.client.sessionOwnerOrDraftChanged");
      return entry.client.call('draft', id, text);
    });
  }
  legacyShareAuthority(entry, record) {
    const guard = this.operationGuard(entry), expected = { ...record };
    const failedTurn = record.state === 'error' ? this.control.legacyInput?.target(record)?.failedTurnInputId : null;
    const epoch = this.control.manualEpoch, revision = this.control.streamRevisions.get(record.id);
    return grant => {
      try { guard(); } catch { return false; }
      const current = entry.state.sessions.find(s => s.id === expected.id);
      const observed = this.control.legacyOwners.get(expected.id);
      return this.control.manualEpoch === epoch && this.control.streamRevisions.get(expected.id) === revision &&
        current?.nativeId === expected.nativeId && current.pid === expected.pid &&
        current.owner === entry.state.owner && current.controlRevision === expected.controlRevision && observed?.controlRevision === expected.controlRevision &&
        current.memberRevision === expected.memberRevision && current.roomId === 'shared' && !current.approval && !current.nativeContextPending &&
        (['idle', 'working'].includes(this.sessionState(current)) || current.state === 'error' && failedTurn &&
          grant?.failedTurnId === failedTurn && this.control.legacyInput.sharedReplies.recovering(grant)) && current;
    };
  }
  call(method, ...args) {
    // Compatibility aliases used only by the profile's single metadata writer.
    if (method === 'joinSpace') return this.callSpace(args[2], 'join', args[3] === undefined ? args.slice(0, 2) : [args[0], args[1], args[3]]);
    if (method === 'pauseSpace') return this.callSpace(args[0], 'pause', []);
    return this.callScoped('shared', method, args);
  }
  // A typed refusal across every backend ('' when clear would not be refused). The clear
  // below checks this again after its refresh; the window asks first, so a clear that will be refused is refused
  // before the person is asked to confirm it (T-149). Reading fresh state is the only side effect: no control
  // counters move. A closed service or a connection being updated or replaced throws, as the clear itself would.
  clearRefusal(roomId, state, entries = this.entries) {
    if (roomId !== 'shared') return entries.some(e => { const run = backendRoom(e.state, roomId)?.run; return run?.status === 'running' || run?.pausePending || run?.pauseUnconfirmed; }) ? uiError('error.client.pauseBeforeClear') : '';
    if (!state.capabilities.includes('clearSharedHistory') || state.room.run?.status === 'running') return uiError('error.client.pauseAndCheckClearSupport');
    if (this.entries.some(e => backendRooms(e.state).some(r => r?.run?.pausePending || r?.run?.pauseUnconfirmed))) return uiError('error.main.clearNeedsLeaseRevocation');
    return '';
  }
  async clearSharedHistoryProblem(roomId = 'shared') {
    if (!spaces.roomId(roomId)) return uiError('error.invalidSpaceAction');
    if (this.socket.destroyed) throw uiError("error.client.serviceNotConnected");
    const entries = this.entries.filter(e => roomId === 'shared' || e.state.capabilities?.includes('collaborationSpacesV1'));
    const guards = entries.map(e => this.operationGuard(e)); guards.forEach(check => check());
    const state = await this.refresh(roomId); guards.forEach(check => check());
    return this.clearRefusal(roomId, state, entries);
  }
  callSpace(roomId, method, args) {
    if (!spaces.roomId(roomId) || !SPACE_METHODS.has(method) || !Array.isArray(args)) return Promise.reject(uiError("error.invalidSpaceAction"));
    return this.callScoped(roomId, method, [...args], true);
  }
  sharedInputController(entry, record) {
    if (record?.owner === entry.state.owner) return entry.state.owner;
    if (!entry.state.capabilities?.includes('sharedInputOwnershipV1') || this.control.legacyInput?.connected(record)) throw uiError('error.sharedInputOwnershipUnavailable');
    return record.owner;
  }
  inputSender(target, args) {
    if (args[2] === undefined) return target;
    const sender = inputCarrier(this.control, target, args[0]);
    if (!sender) throw uiError('error.background.inputHolderUnavailable');
    return sender;
  }
  invoke(entry, roomId, method, args, scopedPause = false, inputProofs) {
    const sharedInput = ['forward', 'queueShared', 'steerShared'].includes(method) && entry.state.capabilities?.includes('sharedInputOwnershipV1');
    if (roomId === 'shared' && !sharedInput && !(method === 'join' && args[2] !== undefined) && (!scopedPause || !entry.state.capabilities?.includes('collaborationSpacesV1'))) return entry.client.call(method, ...args);
    if (!entry.state.capabilities?.includes('collaborationSpacesV1')) throw uiError(roomId === 'shared' ? 'error.client.legacyUndoUnsupported' : 'error.client.legacySpaceUnsupported');
    const ids = method === 'run' ? args[0] : ['forward', 'queueShared', 'steerShared'].includes(method) ? [args[0]] : [];
    const expected = Object.fromEntries(ids.map(id => [id, sharedInput ? inputProofs?.[id] || peerIdentity(entry.state.sessions.find(s => s.id === id), roomId) : spaces.membershipRevision(entry.state.sessions.find(s => s.id === id), roomId)]));
    return entry.client.call('spaceAction', roomId, method, args, expected);
  }
  async callScoped(roomId, method, args, scoped = false) {
    if (this.socket.destroyed) throw uiError("error.client.serviceNotConnected");
    this.authorizeOperation?.(method, args, roomId);
    if (method === 'moveMembership') {
      const entry = this.route(args[0]), guard = this.operationGuard(entry);
      guard();
      if (!entry.state.capabilities?.includes('singleHomeMoveV1')) throw uiError('error.movePlacementUnsupported');
      return this.intervene(async () => {
        guard(); const result = await entry.client.call(method, ...args);
        guard(); await this.refresh(); guard(); return result;
      }, args[0], false, false, args[1] || 'shared');
    }
    if (method === 'gitWorktreePreview') {
      const entry = this.active, guard = this.operationGuard(entry);
      guard(); await this.refresh(); guard();
      if (!entry.state.capabilities?.includes('gitWorktreeV1')) throw uiError("error.client.backendGitUnsupportedReconnect");
      const plan = await entry.client.call(method, ...args); guard(); return plan;
    }
    if (method === 'mergeSnapshot') {
      if (roomId !== 'shared' || args.length !== 1) throw uiError("error.client.invalidMergeSnapshot");
      const batch = require('./space-merge.cjs').validateBatch(args[0]);
      const owners = this.entries.filter(entry => backendRooms(entry.state).some(room => room?.snapshotBatches?.some(marker => marker.operationId === batch.operationId)));
      if (owners.length > 1) throw uiError("error.client.mergeSnapshotOwnershipConflict");
      const target = owners[0] || this.active;
      if (!target.state.capabilities?.includes('spaceMergeV1') || batch.memberIds.some(id => !this.route(id).state.capabilities?.includes('collaborationSpacesV1'))) throw uiError("error.client.mergeMultipleSpacesUnsupported");
      if (!target.state.nativeImageCacheRoot && batch.blocks.some(block => block.entries.some(entry =>
        Array.isArray(entry.payload.images) && entry.payload.images.some(ref => ref?.kind === 'native-pixels' && !ref.unavailable)))) throw uiError('error.client.mergeMultipleSpacesUnsupported');
      const guards = this.entries.map(entry => this.operationGuard(entry)); guards.forEach(check => check());
      const result = await target.client.call('mergeSnapshot', batch);
      guards.forEach(check => check()); await this.refresh(); guards.forEach(check => check());
      return result;
    }
    const spaceRevision = this.control.spaceRevisions.get(roomId) || 0;
    if (roomId !== 'shared') {
      const targets = ['pause', 'clearSharedHistory'].includes(method)
        ? this.entries.filter(e => e.state.capabilities?.includes('collaborationSpacesV1'))
        : (method === 'run' ? args[0] : [args[0]]).map(id => this.route(id));
      if (targets.some(e => !e.state.capabilities?.includes('collaborationSpacesV1'))) throw uiError('error.client.legacySpaceUnsupported');
    }
    if (method === 'operatorAction') {
      const global = args[0] === null && args[1] === 'enabled';
      const resolve = () => global ? this.entries.filter(e => e.state.capabilities?.includes('operatorControl1a')) : [this.route(args[0])];
      const targets = resolve();
      if (!targets.length || targets.some(e => !e.state.capabilities?.includes('operatorControl1a'))) throw Error('This backend does not support the operator interface');
      const guards = targets.map(e => this.operationGuard(e));
      const nativeId = global ? null : targets[0].state.sessions.find(s => s.id === args[0])?.nativeId;
      const changed = () => { throw Error('Operator backend or identity changed; this action may be partially applied. Do not retry automatically.'); };
      const check = () => {
        guards.forEach(guard => guard());
        this.authorizeOperation?.(method, args, roomId);
        const current = resolve();
        if (current.length !== targets.length || current.some(e => !targets.includes(e)) || targets.some(e => !e.state.capabilities?.includes('operatorControl1a')) ||
            !global && targets[0].state.sessions.find(s => s.id === args[0])?.nativeId !== nativeId) changed();
      };
      check();
      const results = [];
      for (const entry of targets) {
        check(); const result = await entry.client.call(method, ...args); check();
        if (global && result !== true) throw Error('The global operator setting is unconfirmed; it may be partially applied. Do not retry automatically.');
        results.push(result);
      }
      await this.refresh(roomId); check();
      if (global && targets.some(e => e.state.operatorPolicy?.enabled !== args[2] || e.state.operatorPolicy?.error)) {
        throw Error('The global operator setting is unconfirmed; it may be partially applied. Do not retry automatically.');
      }
      return results[0];
    }
    if (method === 'wakePolicy') {
      const entry = args[0] === null ? this.entries.find(e => e.state.capabilities?.includes('agentWakeV1')) : this.route(args[0]);
      if (!entry?.state.capabilities?.includes('agentWakeV1')) throw uiError("error.client.automaticMessagesUnsupported");
      const result = await entry.client.call(method, ...args); await this.refresh(roomId); return result;
    }
    if (['mobileRead', 'mobileSendReceipt', 'mobileAnswerReceipt', 'mobileSend', 'mobileAnswer'].includes(method)) {
      const [ticket, spec] = args, id = ticket?.sessionId, target = this.route(id), origin = target.client, guard = this.operationGuard(target);
      const check = () => {
        guard(); this.authorizeOperation?.(method, args, roomId);
        const current = target.state.sessions.find(s => s.id === id);
        if (this.route(id) !== target || target.key !== ticket.serviceKey || current?.nativeId !== ticket.nativeId || current.nativeContextPending || !target.state.capabilities?.includes('humanMobileV1')) throw uiError("error.client.mobileTargetChanged");
      };
      check();
      if (method !== 'mobileSend' && method !== 'mobileAnswer') return origin.call(method, ...args);
      if (!target.state.capabilities.includes('humanMobilePreparedV1')) throw uiError("error.client.mobilePreparationUnsupported");
      const action = method === 'mobileSend' ? 'Send' : 'Answer', originalManual = this.manualGuard(id);
      const ready = await origin.call('mobilePrepare' + action, ticket, spec);
      if (ready?.prepared !== true) {
        if (!ready || !Object.hasOwn(ready, 'receipt')) throw uiError("error.client.mobilePreparationUnconfirmed");
        return ready.receipt;
      }
      if (typeof ready.lease !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ready.lease)) throw uiError("error.client.mobileCredentialUnconfirmed");
      const checkProof = () => {
        const current = target.state.sessions.find(s => s.id === id), proof = spec?.proof;
        if (!proof || proof.nativeId !== current?.nativeId || proof.controlRevision !== (current.controlRevision ?? 0) || proof.connectionRevision !== (current.connectionRevision ?? 0)) throw uiError("error.client.mobileSessionChangedDuringPreparation");
        if (typeof this.scope !== 'string') throw uiError("error.client.mobileLocalScopeUnconfirmed");
        const layout = require('./service-layout.cjs').readLayout(this.scope);
        if (layout.pending || JSON.stringify([...layout.entries].sort()) !== JSON.stringify(this.entries.map(e => e.key).sort())) throw uiError("error.client.mobileBackendListChanged");
        // This broker runs in the issuing app itself. Its positive PID/start
        // identity is stable for this process lifetime; do not spawn ps per click.
        if (!Object.hasOwn(this.control, 'mobileIssuerIdentity')) this.control.mobileIssuerIdentity = require('./platform.cjs').processIdentity(process.pid);
        const own = this.control.mobileIssuerIdentity;
        require('./mobile-access.cjs').verifyTicket(this.scope, ticket, { serviceKey: target.key, sessionId: id, nativeId: current.nativeId }, action === 'Send' ? 'send' : 'answer', {
          alive: issuer => Boolean(own && own.pid === process.pid && issuer.pid === own.pid && issuer.started === own.started),
        });
      };
      let commitStarted = false;
      try {
        check(); checkProof(); if (!originalManual()) throw uiError("error.client.mobileHumanInputDuringPreparation");
        return await this.intervene(async () => {
          const manual = this.manualGuard(id);
          await this.pauseExcept(null); await this.refresh(roomId);
          check(); checkProof();
          if (!manual() || this.entries.some(e => e.state.room.run?.status === 'running' || e.state.room.run?.pausePending || e.state.room.run?.pauseUnconfirmed || e.state.peerLeases?.some(g => g.status === 'running'))) throw uiError("error.client.mobileRelayPauseUnconfirmed");
          commitStarted = true;
          return origin.call('mobileCommit' + action, ticket, ready.lease);
        }, id, false, true);
      } catch (error) {
        // After writing commit, its outcome may be native work. Never abort or replay.
        if (commitStarted) throw error;
        try { return await origin.call('mobileCancel' + action, ticket, ready.lease, String(error.message || error).slice(0, 16000)); }
        catch { throw Object.assign(uiError("error.mobileCancelUnconfirmed", { reason: error.message }, { cause: error, param: 'reason' }), { notSent: true }); }
      }
    }
    // Capture the context displayed when the human acted, before refresh,
    // pause or an earlier private ACK can yield to a native /clear.
    const replyTo = ['forward', 'run', 'queueShared', 'steerShared'].includes(method) ? require('./room-threads.js').replyReference(args[method === 'run' ? 6 : method === 'steerShared' ? 4 : 3]) : '';
    const imagePacket = method === 'forward' ? args[4] : undefined;
    const imageGuard = () => {
      if (!imagePacket) return;
      const entry = this.route(args[0]), record = entry.state.sessions.find(s => s.id === args[0]);
      if (!require('./space-images.cjs').validSpaceImagePacket(imagePacket, roomId) || !entry.state.capabilities?.includes('spaceImageInputV1') ||
          record?.spaceImagesAvailable !== true || this.control.legacyInput?.connected(record)) throw uiError('error.roomImages.deliveryUnavailable');
    };
    imageGuard();
    const replyGuard = () => {
      if (scoped && ['forward', 'run', 'queueShared', 'steerShared'].includes(method) && spaceRevision !== (this.control.spaceRevisions.get(roomId) || 0)) throw uiError("error.client.spaceAuthorizationChanged");
      if (replyTo && !this.snapshot(roomId).room.messages.some(m => m.id === replyTo)) throw uiError("error.client.originalDiscussionRemoved");
    };
    replyGuard();
    let contextGuard = replyGuard, runIdentities;
    const displayedIdentities = method === 'run' ? args[7] : undefined;
    let sharedInputProofs;
    if (['send', 'forward', 'run'].includes(method)) {
      const ids = method === 'run' ? args[0] : [args[0]], index = method === 'run' ? 5 : 2;
      if (!Array.isArray(ids)) throw uiError("error.invalidSessionSelection");
      const supplied = args[index];
      const expected = ids.flatMap(id => {
        // Retained pre-transition services historically discover run members
        // during refresh. They cannot rebind a root in place. New services and
        // explicit GUI context receipts always require an already known row.
        if (method === 'run' && supplied === undefined && !this.entries.some(e => e.state.sessions.some(s => s.id === id)) &&
          !this.entries.some(e => e.state.capabilities?.includes('nativeContextTransitions'))) return [];
        const entry = this.route(id), record = entry.state.sessions.find(s => s.id === id);
        const nativeId = supplied === undefined ? record?.nativeId : method === 'run' ? supplied?.[id] : supplied;
        return [{ id, entry, nativeId, member: spaces.membershipRevision(record, roomId), identity: displayedIdentities?.[id] || peerIdentity(record, roomId) }];
      });
      if (method === 'run') runIdentities = Object.fromEntries(expected.map(e => [e.id, e.identity]));
      if (method === 'forward') sharedInputProofs = Object.fromEntries(expected.map(e => [e.id, e.identity]));
      contextGuard = () => {
        replyGuard();
        imageGuard();
        for (const { id, entry, nativeId, member, identity } of expected) {
          const current = entry.state.sessions.find(s => s.id === id);
          if (method === 'run' && displayedIdentities && JSON.stringify(peerIdentity(current || {}, roomId)) !== JSON.stringify(runIdentities[id])) throw uiError("error.client.memberInputOrMembershipChanged");
          if (!current || current.nativeContextPending || current.nativeId !== nativeId) throw uiError("error.client.nativeContextChanged");
          if (method === 'forward') {
            this.sharedInputController(entry, current);
            if (entry.state.capabilities?.includes('sharedInputOwnershipV1') && JSON.stringify(peerIdentity(current, roomId)) !== JSON.stringify(identity)) throw uiError('error.client.memberInputOrControlChanged');
          }
          if (roomId !== 'shared' && ['forward', 'run'].includes(method) && (!spaces.isMember(current, roomId) || spaces.membershipRevision(current, roomId) !== member)) throw uiError("error.client.spaceMembershipChanged");
        }
      };
      contextGuard();
      // Optional local metadata must not lengthen a retained protocol's wire
      // frame when no thread was chosen (JSON encodes trailing undefined as null).
      args.length = method === 'run' ? Math.min(args.length, 6) : Math.min(args.length, 3);
      if (expected.length === ids.length && expected.every(e => e.entry.state.capabilities?.includes('nativeContextTransitions'))) {
        args[index] = method === 'run' ? Object.fromEntries(expected.map(e => [e.id, e.nativeId])) : expected[0].nativeId;
      } else args.splice(index); // Retained protocols accept at most five run arguments.
      if (replyTo) {
        const targets = expected.map(e => e.entry);
        const bridged = method === 'forward' && this.control.legacyInput?.connected(targets[0]?.state.sessions.find(s => s.id === args[0]));
        if (!bridged && targets.some(e => !e.state.capabilities?.includes('replyThreads'))) throw uiError("error.client.replyBindingUnsupported");
        if (!bridged) args[method === 'run' ? 6 : 3] = replyTo;
      }
      if (imagePacket) { args[3] = replyTo || null; args[4] = imagePacket; }
    }
    if (method === 'queue' || method === 'queueShared') {
      const [id, text, nativeId] = args, target = this.route(id), guard = this.operationGuard(target);
      const original = target.state.sessions.find(s => s.id === id);
      const shared = method === 'queueShared';
      const controller = shared ? this.sharedInputController(target, original) : target.state.owner;
      const inputProof = shared && target.state.capabilities?.includes('sharedInputOwnershipV1') ? peerIdentity(original, roomId) : null;
      const bridge = this.control.legacyInput;
      if (roomId === 'shared' && bridge?.target(original)?.queueAvailable) {
        const expected = { ...original };
        if (expected.nativeId !== nativeId || this.sessionState(expected) !== 'working' || (shared &&
          (expected.roomId !== 'shared' || !bridge.target(original).sharedReplyAvailable || bridge.sharedReplies.storageError))) throw uiError("error.client.nativeTurnOrSharedConnectionChanged");
        return this.intervene(async () => {
          const manualValid = this.manualGuard(id);
          const draftRevision = this.control.draftVersions?.get(id) || 0;
          const shareAuthority = shared ? this.legacyShareAuthority(target, expected) : undefined;
          const valid = () => {
            try { guard(); replyGuard(); this.authorizeOperation?.(method, args, roomId); } catch { return false; }
            const current = target.state.sessions.find(s => s.id === id);
            return manualValid() && current?.nativeId === nativeId && current.pid === expected.pid &&
              current.owner === target.state.owner && current.controlRevision === expected.controlRevision &&
              current.memberRevision === expected.memberRevision && !current.approval && !current.nativeContextPending &&
              ['idle', 'working'].includes(this.sessionState(current)) && bridge.target(current)?.queueAvailable &&
              (!shared || shareAuthority());
          };
          const refresh = async () => { await this.refresh(roomId); if (!valid()) throw uiError("error.client.originalSessionOrControlChanged"); };
          await this.pauseExcept(undefined, scoped && shared ? roomId : undefined, id); await refresh();
          const record = target.state.sessions.find(s => s.id === id);
          const draft = record.liveDraft;
          const tag = await bridge.send(record, text, refresh, valid, shared, replyTo, undefined, true, shareAuthority);
          if (!shared && draft?.trim() === text.trim()) await this.legacyDraft(target, id, '', record, current =>
            current.liveDraft === draft && (this.control.draftVersions?.get(id) || 0) === draftRevision).catch(() => {});
          return tag;
        }, id, shared, false, scoped && shared ? roomId : undefined);
      }
      if (!target.state.capabilities?.includes(shared ? 'nativeSharedQueue' : 'nativeQueue') || original?.nativeId !== nativeId || (shared && (!original || !spaces.isMember(original, roomId)))) throw uiError("error.client.nativeWaitingInputUnsupported");
      return this.intervene(async () => {
        const manualValid = this.manualGuard(id), control = original.controlRevision, member = spaces.membershipRevision(original, roomId);
        await this.pauseExcept(undefined, scoped && shared ? roomId : undefined, id); await this.refresh(roomId); guard(); replyGuard(); this.authorizeOperation?.(method, args, roomId);
        const current = target.state.sessions.find(s => s.id === id);
        if (!manualValid() || current?.controlRevision !== control || current?.nativeId !== nativeId || current?.nativeContextPending || current?.owner !== controller || (inputProof && JSON.stringify(peerIdentity(current, roomId)) !== JSON.stringify(inputProof)) || current?.state !== 'working' || current?.approval || current?.pendingQueue || !current?.queueAvailable ||
          (shared && (!spaces.isMember(current, roomId) || spaces.membershipRevision(current, roomId) !== member))) throw uiError("error.client.currentNativeSessionOrControlChanged");
        return this.invoke(target, roomId, method, [id, text, nativeId, ...(shared ? [replyTo] : [])], false, inputProof ? { [id]: inputProof } : undefined);
      }, id, shared, false, scoped && shared ? roomId : undefined);
    }
    if (method === 'steer' || method === 'steerShared') {
      const [id, text, nativeId, turnId] = args, target = this.route(id), guard = this.operationGuard(target);
      const original = target.state.sessions.find(s => s.id === id);
      if (typeof turnId !== 'string' || !turnId || turnId.length > 160 || original?.nativeId !== nativeId) throw uiError("error.client.nativeTurnChanged");
      const shared = method === 'steerShared';
      const controller = shared ? this.sharedInputController(target, original) : target.state.owner;
      const inputProof = shared && target.state.capabilities?.includes('sharedInputOwnershipV1') ? peerIdentity(original, roomId) : null;
      const bridged = roomId === 'shared' && target.state.runtimeVersion === '0.1.0-alpha.2' && this.control.legacyInput?.target(original)?.native;
      if (shared && (!(bridged?.sharedReplyAvailable && !this.control.legacyInput.sharedReplies.storageError || target.state.capabilities?.includes('nativeSharedSteer')) || (!original || !spaces.isMember(original, roomId)))) throw uiError("error.client.sharedSteeringUnsupported");
      if (!(bridged?.steerAvailable || target.state.capabilities?.includes('nativeSteer'))) throw uiError("error.client.workingSteeringUnsupported");
      return this.intervene(async () => {
        const manualValid = this.manualGuard(id), control = original.controlRevision, member = spaces.membershipRevision(original, roomId);
        const draftRevision = this.control.draftVersions?.get(id) || 0;
        const valid = () => {
          try { guard(); replyGuard(); this.authorizeOperation?.(method, args, roomId); } catch { return false; }
          const raw = target.state.sessions.find(s => s.id === id), current = this.snapshot(roomId).sessions.find(s => s.id === id);
          return manualValid() && raw?.controlRevision === control && raw.owner === controller && (!inputProof || JSON.stringify(peerIdentity(raw, roomId)) === JSON.stringify(inputProof)) &&
            raw.nativeId === nativeId && raw.pid === original.pid && !raw.nativeContextPending && current?.state === 'working' && !current.approval &&
            // The retained transport owns its pending-send lock. Once acquired,
            // this router must not mistake that same send for a competing one.
            (!current.pendingSteer || bridged) && current.activeTurnId === turnId &&
            (!shared || (spaces.isMember(raw, roomId) && spaces.membershipRevision(raw, roomId) === member));
        };
        await this.pauseExcept(null, scoped && shared ? roomId : undefined, id); await this.refresh(roomId);
        if (!valid()) throw uiError("error.client.currentTurnOrControlChanged");
        if (!bridged) return this.invoke(target, roomId, method, args, false, inputProof ? { [id]: inputProof } : undefined);
        // A draft write already queued before this send may have completed
        // during refresh. Read its text now, retaining the click-time revision.
        const draft = target.state.sessions.find(s => s.id === id)?.liveDraft;
        const refresh = async () => { await this.refresh(roomId); if (!valid()) throw uiError("error.client.nativeStateChanged"); };
        const shareAuthority = shared ? this.legacyShareAuthority(target, original) : undefined;
        const tag = await this.control.legacyInput.send(original, text, refresh, valid, shared, replyTo, turnId, false, shareAuthority);
        if (!shared && draft?.trim() === text.trim()) await this.legacyDraft(target, id, '', original, current =>
          current.liveDraft === draft && (this.control.draftVersions?.get(id) || 0) === draftRevision).catch(() => {});
        return tag;
      }, id, false, false, scoped && shared ? roomId : undefined);
    }
    if (method === 'initial') return this.refresh(roomId);
    if (method === 'nativeHistory') {
      const guard = this.operationGuard(this.active); guard();
      const provider = args[0]?.provider === 'claude' ? 'claude' : 'codex';
      if (!this.active.state.capabilities?.includes(provider === 'claude' ? 'claudeSessionList' : 'nativeHistory')) throw uiError("error.client.reopenForBackend");
      const result = await this.active.client.call(method, ...args); guard();
      const snapshot = await this.refresh(roomId); guard();
      return { ...result, data: result.data.map(row => ({ ...row, existingIds: snapshot.sessions.filter(s => s.provider === provider && s.nativeId === row.nativeId).map(s => s.id) })) };
    }
    if (method === 'importHistory') {
      if (args[1] != null && (typeof args[1] !== 'object' || Array.isArray(args[1]))) throw uiError("error.client.invalidHistoryImport");
      const options = args[1] == null ? undefined : { ...args[1] };
      const provider = options?.provider ?? 'codex';
      if (!['codex', 'claude'].includes(provider)) throw uiError("error.client.invalidNativeProvider");
      const native = provider === 'claude' && typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
      const guard = this.operationGuard(this.active);
      const operation = creationQueue.then(async () => {
        guard(); const snapshot = await this.refresh(roomId); guard();
        const existing = snapshot.sessions.filter(s => s.provider === provider && s.nativeId === native);
        if (existing.length > 1) throw uiError("error.client.existingRecordOwnershipConflict");
        if (existing.length) return existing[0].id;
        assertNativeCreation(snapshot);
        if (!snapshot.capabilities.includes(provider === 'claude' ? 'claudeHistory' : 'nativeHistory')) throw uiError("error.client.historyImportUnsupported");
        const id = await this.active.client.call(method, native, ...(options ? [options] : []));
        await this.refresh(roomId); return id;
      });
      creationQueue = operation.catch(() => {}); return operation;
    }
    if (method === 'retrySave') {
      const targets = this.entries.filter(e => e.state.storageRetryable && e.state.capabilities?.includes('retrySave'));
      if (!targets.length) throw uiError("error.client.noRetryableStorageFailure");
      const targetsWithGuards = targets.map(entry => ({ entry, guard: this.operationGuard(entry) }));
      let failed = false;
      for (const { entry, guard } of targetsWithGuards) {
        try { guard(); await entry.client.call('retrySave'); } catch { failed = true; }
      }
      await this.refresh(roomId);
      if (failed) throw uiError("error.client.recordsStillUnsaved");
      return true;
    }
    if (method === 'pause') {
      if (scoped) return this.intervene(async () => {
        const entries = this.entries.filter(e => roomId === 'shared' || e.state.capabilities?.includes('collaborationSpacesV1'));
        const guards = entries.map(e => this.operationGuard(e)); guards.forEach(check => check());
        const results = await Promise.allSettled(entries.map(e => this.invoke(e, roomId, 'pause', [], true)));
        if (results.some(r => r.status === 'rejected')) throw uiError("error.client.spacePauseUnconfirmed");
        for (const entry of entries) if (this.control.armed.get(entry.key)?.roomId === roomId) this.control.armed.delete(entry.key);
        await this.refresh(roomId); guards.forEach(check => check());
      }, undefined, false, false, roomId);
      // A member change stops automatic routing, but only invalidates that
      // member's manual input/reply. Explicit room pause remains global.
      const id = args[0]; if (id !== undefined) this.route(id);
      return this.intervene(() => {
        const entries = new Map(this.entries.map(e => [e.key, e]));
        for (const [key, arm] of this.control.armed) entries.set(key, arm.entry);
        return Promise.all([...entries.values()].map(e => this.pauseEntry(e, true)));
      }, id, false, false, undefined, true);
    }
    if (method === 'create') {
      const guard = this.operationGuard(this.active);
      const operation = creationQueue.then(async () => {
        guard();
        const state = await this.refresh(roomId); assertNativeCreation(state);
        guard();
        if (args[0]?.newDirectory != null && !state.capabilities?.includes('newSessionDirectory')) throw uiError("error.client.newDirectoryUnsupported");
        if (args[0]?.gitWorktree != null && !state.capabilities?.includes('gitWorktreeV1')) throw uiError("error.client.backendGitUnsupported");
        const id = await this.active.client.call(method, ...args); await this.refresh(roomId); return id;
      });
      creationQueue = operation.catch(() => {}); return operation;
    }
    if (method === 'shutdown' || method === 'clearSharedHistory') {
      if (roomId !== 'shared') {
        this.control.revision++; this.control.manualEpoch++;
        const entries = this.entries.filter(e => e.state.capabilities?.includes('collaborationSpacesV1'));
        const guards = entries.map(e => this.operationGuard(e)); guards.forEach(check => check());
        const refreshed = await this.refresh(roomId); guards.forEach(check => check());
        const refusal = this.clearRefusal(roomId, refreshed, entries); if (refusal) throw refusal;
        const results = await Promise.allSettled(entries.map(e => this.invoke(e, roomId, 'clearSharedHistory', [])));
        if (results.some(r => r.status === 'rejected')) throw uiError("error.client.clearPartiallyUnconfirmed");
        await this.refresh(roomId); return results.some(r => r.value?.imagesLeft) ? { imagesLeft: true } : true;
      }
      this.control.revision++; this.control.manualEpoch++;
      const sharedIds = this.control.legacyInput?.sharedMessages?.().map(message => message.id) || [];
      const guards = this.entries.map(e => this.operationGuard(e)); guards.forEach(check => check());
      const state = await this.refresh(roomId);
      if (method === 'shutdown' && state.sessions.some(s => !['ended', 'background'].includes(s.state))) throw uiError("error.endNativeSessionsBeforeBackend");
      if (method === 'clearSharedHistory') { const refusal = this.clearRefusal(roomId, state); if (refusal) throw refusal; }
      // These are explicit user actions. Partial failure must remain visible.
      guards.forEach(check => check());
      const results = await Promise.allSettled(this.entries.map(e => method === 'clearSharedHistory'
        && e.state.runtimeVersion === '0.1.0-alpha.2' && !e.state.room.messages?.length ? Promise.resolve() : e.client.call(method)));
      if (results.some(r => r.status === 'rejected')) throw uiError("error.client.actionPartiallyUnconfirmed");
      if (method === 'clearSharedHistory') this.control.legacyInput?.clearSharedHistory(sharedIds);
      // A service reports cached images of removed sessions it could not delete (T-140).
      return results.some(r => r.value?.imagesLeft) ? { imagesLeft: true } : true;
    }
    if (method === 'run') {
      const guards = new Map(this.entries.map(e => [e.key, this.operationGuard(e)]));
      const revision = ++this.control.revision;
      this.control.manualEpoch++;
      const interventions = [...this.control.interventions];
      const state = await this.refresh(roomId);
      if (scoped && state.rooms?.some(r => r.id !== roomId && r.run?.status === 'running')) throw uiError("error.client.anotherSpaceChecking");
      if (this.entries.some(e => backendRooms(e.state).some(r => r?.run?.pausePending || r?.run?.pauseUnconfirmed))) throw uiError("error.client.revokeBeforeNewCollaboration");
      if (!Array.isArray(args[0]) || args[0].length < 2 || args[0].length > 6 || new Set(args[0]).size !== args[0].length) throw uiError("error.client.selectDistinctSessions");
      const targets = args[0].map(id => this.route(id));
      const guard = guards.get(targets[0].key); guard();
      const crossService = targets.some(target => target !== targets[0]);
      if (crossService && (!['replies', 'directed'].includes(args[3]) || args[3] === 'directed' && (!this.active.state.capabilities?.includes(PEER_DIRECTED) || targets.some(t => !t.state.capabilities?.includes(PEER_DIRECTED))) || !this.active.state.capabilities?.includes(PEER_HANDOFFS) || targets.some(t => !t.state.capabilities?.includes(PEER_HANDOFFS)))) throw uiError("error.client.crossBackendRevocationUnsupported");
      assertAutomaticRun(state, args[3], args[0]); assertSharing(state, args[0]);
      await Promise.all(interventions);
      await this.pauseExcept(crossService ? null : targets[0]);
      const previousArm = this.control.armed.get(targets[0].key);
      if (previousArm?.entry.closing || previousArm?.entry.closed) await this.pauseEntry(targets[0]);
      const previousPause = this.control.armed.get(targets[0].key)?.pause;
      if (previousPause) await previousPause;
      if (revision !== this.control.revision || this.socket.destroyed) throw uiError("error.client.handoffInvalidatedByHuman");
      this.authorizeOperation?.(method, args, roomId);
      guard(); contextGuard();
      if (this.entries.some(e => backendRooms(e.state).some(r => r?.run?.pausePending || r?.run?.pauseUnconfirmed))) throw uiError("error.client.revokeBeforeNewCollaboration");
      if (crossService) {
        if (roomId !== 'shared' && !this.active.state.capabilities?.includes('collaborationSpacesV1')) throw uiError("error.client.coordinatorMultipleSpacesUnsupported");
        for (const id of args[0]) if (JSON.stringify(peerIdentity(this.route(id).state.sessions.find(s => s.id === id), roomId)) !== JSON.stringify(runIdentities[id])) throw uiError("error.client.memberInputOrControlChanged");
        const activeGuard = guards.get(this.active.key); activeGuard();
        const arm = { entry: this.active, roomId }; this.control.armed.set(this.active.key, arm);
        return this.active.client.call('peerRun', { ids: args[0], goal: args[1], maxSteps: args[2], mode: args[3], labels: args[4] || {},
          contexts: Object.fromEntries(args[0].map(id => [id, this.route(id).state.sessions.find(s => s.id === id).nativeId])),
          roomId, identities: runIdentities, routes: Object.fromEntries(args[0].map(id => [id, this.route(id).key])), replyTo });
      }
      const arm = this.control.armed.get(targets[0].key) || { entry: targets[0], roomId };
      this.control.armed.set(targets[0].key, arm);
      return this.invoke(arm.entry, roomId, method, args);
    }
    if (!['prepareInput', 'observe', 'unobserve', 'join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'forward', 'approve', 'answer', 'stop', 'resume', 'forget'].includes(method)) throw uiError("error.unsupportedLocalAction");
    const target = this.route(args[0]);
    const guard = this.operationGuard(target); guard();
    if (method === 'input') this.inputSender(target, args);
    if (method === 'join' && scoped) return this.intervene(async () => {
      guard(); this.authorizeOperation?.(method, args, roomId); return this.invoke(target, roomId, method, args);
    }, undefined, false, false, roomId);
    const legacy = target.state.runtimeVersion === '0.1.0-alpha.2';
    // Taking a session no open window holds (the renderer's takeFreeSession) is no takeover: nothing here is
    // paused and no queued work is held back as the person's. The service takes it only while it is still
    // free; a service without that check is left to the explicit takeover.
    if (method === 'claim' && args[2] === 'free') return !legacy && target.state.capabilities?.includes('freeClaimV1') ? target.client.call(method, ...args) : false;
    if (legacy && ['claim', 'terminal', 'interrupt'].includes(method)) {
      const expected = { ...target.state.sessions.find(s => s.id === args[0]) };
      const owned = expected.owner === target.state.owner;
      const pauseScope = this.controlPauseScope(method, args, target);
      const ownerRevision = this.control.legacyOwners.get(args[0])?.revision;
      if (method === 'interrupt' && !owned) throw uiError("error.client.takeControlBeforeInterrupt");
      const operation = () => this.legacyMutation(target, async () => {
        if (pauseScope === 'all') await this.pauseExcept(null);
        guard(); await this.refresh(roomId); guard(); this.authorizeOperation?.(method, args, roomId);
        const current = target.state.sessions.find(s => s.id === args[0]);
        if (!current || current.owner !== expected.owner || current.nativeId !== expected.nativeId || current.pid !== expected.pid
          || this.control.legacyOwners.get(args[0])?.revision !== ownerRevision) throw uiError("error.client.sessionTakenElsewhere");
        const result = await target.client.call(method, ...args);
        await this.refresh(roomId); guard(); return result;
      });
      return owned && method !== 'interrupt' ? operation() : this.intervene(operation, args[0]);
    }
    if (method === 'prepareInput') {
      await this.refresh(roomId); guard();
      const record = target.state.sessions.find(s => s.id === args[0]);
      if (record?.owner !== target.state.owner || !this.control.legacyInput) throw uiError("error.client.takeControlHere");
      return this.control.legacyInput.prepare(target, record);
    }
    if (method === 'approve' && legacy && target.state.sessions.find(s => s.id === args[0])?.provider === 'codex' &&
      !(typeof args[1] === 'string' && args[1].startsWith('legacy:'))) throw uiError("error.client.nativeApprovalConnectionChanged");
    if (method === 'approve' && typeof args[1] === 'string' && args[1].startsWith('legacy:')) {
      await this.refresh(roomId); guard(); this.authorizeOperation?.(method, args, roomId);
      const record = target.state.sessions.find(s => s.id === args[0]);
      if (record?.owner !== target.state.owner) throw uiError("error.client.sessionControlChanged");
      const native = this.control.legacyInput?.target(record)?.native;
      if (!native) throw uiError("error.client.nativeApprovalConnectionChangedNoReroute");
      return native.approve(args[1], args[2]);
    }
    if (method === 'answer' && !target.state.capabilities?.includes('nativeQuestionAnswer')) throw uiError("error.client.nativeQuestionGuiUnsupported");
    if (method === 'approve' && !target.state.capabilities?.includes('nativeApprovalSync')) {
      throw uiError("error.client.legacyApprovalUnverifiable");
    }
    if (method === 'approve' && !target.state.capabilities?.includes('nativeApprovalLocalDecisions')) {
      const approval = target.state.sessions.find(s => s.id === args[0])?.approval;
      if (!nativeApprovalPolicy(approval, { localDecisions: false }).decisions.includes(args[2])) {
        throw uiError("error.client.legacyApprovalModeUnsupported");
      }
    }
    if (roomId === 'shared' && ['send', 'forward'].includes(method) && this.control.legacyInput?.connected(target.state.sessions.find(s => s.id === args[0]))) {
      const shared = method === 'forward';
      return this.intervene(async () => {
        const manualValid = this.manualGuard(args[0]);
        await this.pauseExcept(null, scoped && shared ? roomId : undefined, args[0]); await this.refresh(roomId); guard();
        contextGuard();
        const record = target.state.sessions.find(s => s.id === args[0]);
        if (shared && record?.roomId !== 'shared') throw uiError("error.client.recipientLeftSharedWork");
        const control = record.controlRevision, member = record.memberRevision;
        const failedTurn = record.state === 'error' ? this.control.legacyInput.target(record)?.failedTurnInputId : null;
        const draft = record.liveDraft, draftRevision = this.control.draftVersions?.get(record.id) || 0;
        const valid = () => {
          try { guard(); contextGuard(); this.authorizeOperation?.(method, args, roomId); } catch { return false; }
          const current = target.state.sessions.find(s => s.id === record.id);
          return manualValid() && current?.pid === record.pid && current.nativeId === record.nativeId
            && current.owner === target.state.owner && current.controlRevision === control && current.memberRevision === member
            && (!shared || current.roomId === 'shared')
            && (this.sessionState(current) === 'idle' || current.state === 'error' && failedTurn && this.control.legacyInput.target(current)?.failedTurnInputMatches(failedTurn))
            && !this.control.legacyInput.target(current)?.nativeInputRequired && !current.pendingTag && !current.approval;
        };
        if (!valid()) throw uiError("error.client.originalSessionStateChanged");
        const refresh = async () => { await this.refresh(roomId); if (!valid()) throw uiError("error.client.originalSessionChanged"); };
        // Native hooks remain the sole writer of conversation history.
        // Never call the old paste/Enter sender or launch a replacement CLI.
        const shareAuthority = this.legacyShareAuthority(target, record);
        const tag = await this.control.legacyInput.send(record, args[1], refresh, valid, shared, replyTo, undefined, false, shareAuthority);
        // An accepted native submission stays accepted even if cleanup loses
        // ownership or the connection. Never report that as a failed send.
        if (!shared && draft?.trim() === args[1].trim()) await this.legacyDraft(target, record.id, '', record, current =>
          current.liveDraft === draft && (this.control.draftVersions?.get(record.id) || 0) === draftRevision).catch(() => {});
        return tag;
      }, args[0], false, false, scoped && shared ? roomId : undefined);
    }
    if (method === 'unobserve') { this.legacyObservers.get(args[0])?.release(); return true; }
    if (method === 'draft') { this.control.draftVersions ||= new Map(); this.control.draftVersions.set(args[0], (this.control.draftVersions.get(args[0]) || 0) + 1); }
    if (legacy && method === 'draft') {
      const expected = { ...target.state.sessions.find(s => s.id === args[0]) };
      return this.legacyDraft(target, args[0], args[1], expected);
    }
    if (method === 'observe' && !target.state.capabilities?.includes('observe')) {
      const id = args[0], record = target.state.sessions.find(s => s.id === id);
      const native = this.control.legacyInput?.target(record)?.native;
      if (native?.connected) return native.observe();
      if (!supportsLegacyObservation(target.state, record)) throw uiError("error.client.safeObservationUnavailable");
      let observer = this.legacyObservers.get(id);
      if (!observer) {
        for (const [oldId, oldObserver] of this.legacyObservers) if (!oldObserver.watching && this.legacyObservers.size >= 12) { oldObserver.dispose(); this.legacyObservers.delete(oldId); }
        if (this.legacyObservers.size >= 12) throw uiError("error.client.observationLimit");
        const source = target.client;
        observer = new LegacyObservation(async () => { guard(); const frame = await source.call('terminalSnapshot', id); guard(); return frame; }, event => { if (!this.closing && !target.closed && target.client === source) this.emit('terminal', { id, ...event }); });
        this.legacyObservers.set(id, observer);
      }
      return observer.observe();
    }
    if (method === 'resize') {
      const result = await target.client.call(method, ...args);
      for (const view of this.control.views) view.legacyObservers.get(args[0])?.changed();
      return result;
    }
    if (method === 'resume') assertNativeCreation(target.state);
    if (method === 'forget') {
      const record = target.state.sessions.find(s => s.id === args[0]);
      const result = await target.client.call(method, ...args);
      try { this.control.legacyInput?.forgetReader(record); }
      catch { throw uiError("error.client.forgottenReadingCleanupFailed"); }
      return result;
    }
    if (['send', 'forward'].includes(method)) assertSubmission(target.state, [args[0]]);
    if (method === 'forward') assertSharing(target.state, [args[0]]);
    const ownView = ['claim', 'terminal'].includes(method) && this.controlPauseScope(method, args, target) === 'target';
    if (ownView) return target.client.call(method, ...args);
    if (['join', 'claim', 'terminal', 'send', 'interrupt', 'forward', 'stop', 'resume'].includes(method) || (method === 'input' && this.controlPauseScope(method, args, target) === 'all')) return this.intervene(async () => {
      await this.pauseExcept(null, scoped && method === 'forward' ? roomId : undefined, args[0]); guard(); contextGuard(); this.authorizeOperation?.(method, args, roomId);
      return this.invoke(method === 'input' ? this.inputSender(target, args) : target, roomId, method, args, false, sharedInputProofs);
    }, args[0], false, false, scoped && method === 'forward' ? roomId : undefined);
    return (method === 'input' ? this.inputSender(target, args) : target).client.call(method, ...args);
  }
  // leave: the person closed this window. Each service is told before its connection ends, so the window
  // holds none of its sessions against the windows still open.
  close({ leave = false } = {}) {
    if (this.closing) return;
    this.closing = true; this.socket.destroyed = true; this.control.revision++; this.control.manualEpoch++;
    for (const observer of this.legacyObservers.values()) observer.dispose(); this.legacyObservers.clear();
    for (const e of this.entries) { e.closing = true; if (leave) e.client.call('leave').catch(() => {}); e.client.close(); }
    this.control.views.delete(this);
    if (--this.control.clients === 0) { this.control.legacyInput?.close(); controls.delete(this.scope); }
  }
  // Closes a view nothing uses any more (an agent's background window) without voiding the
  // manual input, shared-reply authority or bindings that other views hold: close() above
  // counts as a change of control for every view. Refused, and nothing closed, while this
  // view is the last one (the native input bridge would close with it), while a run or a
  // directed discussion is running (the connection that started it holds it), while the
  // shared pause list points at this view's connections, while a backend is being updated
  // (its new sockets are being handed to every view), or while a retained Claude session's
  // reader reads through this view's connection.
  retire() {
    if (this.closing) return true;
    if (this.control.clients <= 1 || this.control.maintenance.size || [...this.control.armed.values()].some(arm => this.entries.includes(arm.entry)) ||
        [...(this.control.legacyInput?.targets?.values() || [])].some(target => this.entries.includes(target.readsThrough)) ||
        this.entries.some(e => backendRooms(e.state).some(r => r?.run?.status === 'running') || e.state.peerLeases?.some(p => p.status === 'running'))) return false;
    this.retired = true; this.closing = true; this.socket.destroyed = true;
    for (const observer of this.legacyObservers.values()) observer.dispose(); this.legacyObservers.clear();
    for (const e of this.entries) { e.closing = true; e.client.close(); }
    this.control.views.delete(this); this.control.clients--;
    return true;
  }
}
module.exports = { WorkspaceClient, consentedInputBlocked };
