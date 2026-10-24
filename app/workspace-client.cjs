const { codexVersionInfo } = require('./native-history.cjs');
const { EventEmitter } = require('node:events');
const { submissionState, assertSubmission, assertSharing, assertAutomaticRun, assertNativeCreation } = require('./submission-policy.cjs');
const { isTerminalResponse } = require('./workspace.cjs');
const { LegacyObservation, supportsLegacyObservation } = require('./legacy-observation.cjs');
const { LegacyInput, eligible: legacyInputEligible } = require('./legacy-input.cjs');
const { nativeApprovalPolicy } = require('./approval-policy.js');
const { CAPABILITY: PEER_HANDOFFS, DIRECTED: PEER_DIRECTED, identity: peerIdentity, mergePeerMessages } = require('./peer-handoffs.cjs');
let creationQueue = Promise.resolve();
const controls = new Map();

// A flat routing layer, not a second agent runtime. Each service remains the
// sole writer of its sessions, drafts and shared replies, even with no UI open.
class WorkspaceClient extends EventEmitter {
  constructor(entries, active, scope = Symbol()) {
    super(); this.entries = entries; this.active = entries.find(e => e.key === active); this.closing = false; this.legacyObservers = new Map();
    this.scope = scope;
    if (!controls.has(scope)) controls.set(scope, { revision: 0, manualEpoch: 0, sessionRevisions: new Map(), streamRevisions: new Map(), clients: 0, armed: new Map(), interventions: new Set(), views: new Set(), maintenance: new Set(), generations: new Map() });
    this.control = controls.get(scope); this.control.clients++; this.control.views.add(this);
    this.control.legacyOwners ||= new Map();
    for (const entry of entries) this.observeLegacyOwners(entry);
    if (typeof scope === 'string' && !this.control.legacyInput) {
      this.control.legacyInput = new LegacyInput(scope);
      this.control.legacyInput.on('change', () => { for (const view of this.control.views) if (!view.closing) view.emit('state', view.snapshot()); });
      this.control.legacyInput.on('progress', update => { for (const view of this.control.views) if (!view.closing) view.emit('progress', update); });
    }
    for (const entry of entries) {
      entry.stateOrder = entry.client.receivedOrder?.(entry.state) || 0;
      entry.closed = false; entry.closing = false;
      entry.closedPromise = new Promise(resolve => { entry.confirmClosed = resolve; });
      if (entry.state.room.run?.status === 'running' && !this.control.armed.has(entry.key)) this.control.armed.set(entry.key, { entry });
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
        entry.closed = true; entry.confirmClosed(); this.control.revision++; this.control.manualEpoch++;
        for (const s of entry.state.sessions) { this.legacyObservers.get(s.id)?.dispose(); this.legacyObservers.delete(s.id); }
        if (this.control.maintenance.has(entry.key)) return;
        this.socket.destroyed = true; if (!this.closing) this.emit('closed');
      });
  }
  replaceService(key, client, state) {
    const entry = this.entries.find(e => e.key === key);
    if (!entry || this.closing) { client.close(); throw new Error('窗口连接已变化，请重新连接。'); }
    const old = entry.client;
    for (const s of entry.state.sessions) { this.legacyObservers.get(s.id)?.dispose(); this.legacyObservers.delete(s.id); }
    this.control.generations.set(key, (this.control.generations.get(key) || 0) + 1);
    entry.client = client; entry.state = state; entry.closed = false; entry.closing = false;
    entry.stateOrder = client.receivedOrder?.(state) || 0;
    this.observeLegacyOwners(entry);
    entry.closedPromise = new Promise(resolve => { entry.confirmClosed = resolve; });
    this.bindEntry(entry); old.close();
    this.socket.destroyed = this.entries.some(e => e.closed);
  }
  maintainService(key) {
    if (this.control.maintenance.has(key)) throw new Error('这个连接已在更新，请稍候。');
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
      if (this.control.maintenance.has(entry.key)) throw new Error('这个连接正在更新，请稍候；没有发送输入。');
      if (entry.client !== client || (this.control.generations.get(entry.key) || 0) !== generation || entry.closed || this.closing) throw new Error('连接已变化，原操作没有重发；请重新确认。');
    };
  }
  sessionState(record) { return this.control.legacyInput?.effectiveState?.(record) || record?.state; }
  snapshot() {
    const sessions = [], messages = new Map(), runs = [];
    const ids = new Set();
    for (const e of this.entries) {
      const state = submissionState(e.state);
      for (const s of state.sessions) {
        if (ids.has(s.id)) throw new Error('会话归属冲突；未向任何原生会话发送输入。');
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
        ids.add(s.id); sessions.push({ ...s, peerIdentity: peerIdentity(s), legacyObservation: supportsLegacyObservation(e.state, s), legacyProgress: !!native?.connected,
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
            ...(s.provider === 'claude' ? { model: reader.model || '原生未报告', usage: reader.usage || null, sharedActivity: bridge?.sharedReplies?.activity(reader.record) || null, nativeActivity: reader.nativeActivity, nativeApproval: reader.nativeApproval, activeTurnId: reader.turnId } : {}),
            ...(reader.storageError ? { activity: '实时内容尚未保存，请在原生终端核对；原会话继续保留。' } : {}) } : {}),
          ...(bridge?.readerUnavailable?.(s) ? { nativeBlockMapping: true, messages: [{ id: 'retained-reader-unavailable', role: 'system', kind: 'gap', incomplete: true,
            text: '原生阅读记录暂不可用；没有以旧后台内容替换，请在原生终端继续。' }] } : {}),
          ...(legacyCodex && native ? { ...codexVersionInfo(native.rpc, native.connected && !native.closed), nativeBlockMapping: true, nativeSettings: native.nativeSettings, sharedActivity: bridge?.sharedReplies?.activity(native.record) || null, nativeActivity: native.connected && !native.closed ? native.nativeActivity : null, steerAvailable: Boolean(native.steerAvailable), activeTurnId: native.turnId, pendingSteer: native.pendingSteer || null, messages: native.record.messages, model: native.model || '原生未报告', usage: native.usage || null,
            ...(native.storageError ? { activity: '实时内容尚未保存，请在原生终端核对；原会话继续保留。' } : native.connected ? { activity: native.activity || '' } : {}) } : {}),
          ...(legacySubmit ? { chatAvailable: true, shareAvailable: true, submissionNotice: null,
            sharingNotice: bridge.target(s)?.sharedReplyAvailable && !bridge.sharedReplies?.storageError
              ? '只发送选定的内容；对应的原生回复实时显示在共同消息流中，不自动交给其他 agent。'
              : '只发送你选定的内容。回复在成员视图查看；再次分享由你选择，不会自动转发私人回复。', ...(native?.state ? { state: native.state } : {}),
            pendingTag: bridge.target(s)?.submission.pending?.tag || s.pendingTag } : {}),
          ...(legacyCodex
            ? { approval: native?.connected ? native.approval : null, approvalResolved: Boolean(native?.connected && native.approvalResolved) } : {}),
          approvals: approvals.map(request => ({ ...request, decisions: approvalDecisionAvailable && !approvalOverflow ? nativeApprovalPolicy(request, {
            localDecisions: legacyCodex || e.state.capabilities?.includes('nativeApprovalLocalDecisions') === true,
          }).decisions : [] })), approvalOverflow,
          approvalDecisionAvailable, approvalDecisions: approvalOverflow ? [] : approvalDecisions,
          approvalNotice: s.provider === 'codex' && !approvalDecisionAvailable ? '旧连接无法核实这项确认的最新状态，请在原生终端核对。原会话继续保留。' : null,
          handoffGroup: this.entries.indexOf(e), serviceCapabilities: e.state.capabilities || [], runtimeVersion: e.state.runtimeVersion });
      }
      for (const m of state.room.messages || []) {
        if (messages.has(m.id)) throw new Error('共享记录归属冲突；原记录已保留。');
        messages.set(m.id, m);
      }
      if (state.room.run) runs.push(state.room.run);
    }
    for (const message of this.control.legacyInput?.sharedMessages?.() || []) {
      if (messages.has(message.id)) throw Error('共享记录归属冲突；原记录已保留。');
      messages.set(message.id, message);
    }
    const memberServices = this.entries.filter(e => e.state.sessions.some(s => s.roomId === 'shared'));
    const routingService = memberServices.length === 1 ? memberServices[0] : this.active;
    const capabilities = (this.active.state.capabilities || []).filter(cap => {
      if (['verifiedHandoffs', 'boundedReplyHandoffs', 'agentAddressedHandoffs'].includes(cap)) return memberServices.length <= 1 && routingService.state.capabilities?.includes(cap) && routingService.state.capabilities?.includes('nativeInputIsolation') &&
        (!routingService.state.sessions.some(s => s.roomId === 'shared' && s.provider === 'claude') || routingService.state.capabilities?.includes('claudePromptIdentity'));
      if (cap === 'clearSharedHistory') return this.entries.every(e => e.state.capabilities?.includes(cap)
        || (e.state.runtimeVersion === '0.1.0-alpha.2' && !e.state.room.messages?.length));
      return true;
    });
    const sum = key => this.entries.every(e => Number.isSafeInteger(e.state.diagnostics?.[key])) ? this.entries.reduce((n, e) => n + e.state.diagnostics[key], 0) : null;
    runs.sort((a, b) => Boolean(b.pausePending || b.pauseUnconfirmed) - Boolean(a.pausePending || a.pauseUnconfirmed) || (b.status === 'running') - (a.status === 'running') || (b.startedAt || 0) - (a.startedAt || 0));
    return { ...this.active.state, sessions, capabilities,
      room: { ...this.active.state.room, revision: this.entries.reduce((n, e) => n + (e.state.room.revision || 0), 0), run: runs[0] || null, messages: mergePeerMessages([...messages.values()]).sort((a, b) => (a.time || 0) - (b.time || 0)) },
      diagnostics: { shellModelCalls: sum('shellModelCalls'), dispatches: sum('dispatches') === null ? null : sum('dispatches') + (this.control.legacyInput?.records.length || 0) },
      storageWarning: [...this.entries.map(e => e.state.storageWarning), this.control.legacyInput?.storageWarning,
        this.control.legacyInput?.sharedReplies?.storageError ? '本地共享回复未能保存；后续内容留在原会话，请检查磁盘与文件权限。' : null].filter(Boolean).join('\n') || null,
      storageRetryable: this.entries.some(e => e.state.storageRetryable && e.state.capabilities?.includes('retrySave')),
      services: this.entries.map(e => ({ version: e.state.runtimeVersion, active: e === this.active, sessions: e.state.sessions.length })),
      peerHandoffsAvailable: this.active.state.capabilities?.includes(PEER_HANDOFFS) === true,
      peerDirectedAvailable: this.active.state.capabilities?.includes(PEER_DIRECTED) === true,
      handoffNotice: memberServices.length > 1 && !memberServices.every(e => e.state.capabilities?.includes(PEER_HANDOFFS)) ? '成员使用不同版本的后台，自动交接暂不可用。可在同一协作视图查看终端、选择内容并定向分享。' : null,
    };
  }
  route(id) {
    const matches = this.entries.filter(e => e.state.sessions.some(s => s.id === id));
    if (matches.length !== 1) throw new Error('找不到唯一的会话归属；没有发送输入。');
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
  async refresh() {
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
      if (e.state.room.run?.status === 'running' && !this.control.armed.has(e.key)) this.control.armed.set(e.key, { entry: e });
    }));
    return this.snapshot();
  }
  async pauseExcept(target) {
    // Run intent is shared by every window and registered before its RPC, not
    // inferred from a delayed display snapshot. Use the originating connection
    // so pause is ordered after run even when another window intervenes.
    await Promise.all([...this.control.armed].filter(([key]) => key !== target?.key).map(([, arm]) => this.pauseEntry(arm.entry)));
  }
  async pauseEntry(entry, explicit = false) {
    const arm = this.control.armed.get(entry.key);
    if (!arm) return explicit ? entry.client.call('pause') : undefined;
    if (!arm.pause) arm.pause = (async () => {
      if (arm.entry.closing || arm.entry.closed) {
        // A normal window close is not a cancellation. Wait for its ordered
        // connection to close before another window sends the pause.
        if (!arm.entry.closed) {
          let timer;
          try { await Promise.race([arm.entry.closedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('原窗口尚未确认断开；输入未发送，请重新连接。')), 2500); })]); }
          finally { clearTimeout(timer); }
        }
        const replacement = [...this.control.views].filter(view => !view.closing && !view.socket.destroyed).flatMap(view => view.entries).find(e => e.key === entry.key && !e.closed && !e.closing);
        if (!replacement) throw new Error('没有可确认暂停的连接；输入未发送，请重新连接。');
        arm.entry = replacement;
      }
      return arm.entry.client.call('pause');
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
  async intervene(operation, id, preserveManualStream = false) {
    // Every human action still invalidates pending automatic handoff intent.
    // Independent manual submissions only invalidate the same recipient.
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
        || this.control.legacyOwners.get(id)?.revision !== ownerRevision || !valid(current)) throw Error('会话控制权或草稿已变化；此窗口的草稿保留为恢复副本，没有覆盖原会话。');
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
  async call(method, ...args) {
    if (this.socket.destroyed) throw new Error('本地服务未连接；请重新连接，输入不会自动重发。');
    this.authorizeOperation?.(method, args);
    // Capture the context displayed when the human acted, before refresh,
    // pause or an earlier private ACK can yield to a native /clear.
    const replyTo = ['forward', 'run', 'queueShared', 'steerShared'].includes(method) ? require('./room-threads.js').replyReference(args[method === 'run' ? 6 : method === 'steerShared' ? 4 : 3]) : '';
    const replyGuard = () => {
      if (replyTo && !this.snapshot().room.messages.some(m => m.id === replyTo)) throw Error('原讨论记录已移除；草稿保留，没有发送。');
    };
    replyGuard();
    let contextGuard = replyGuard, runIdentities;
    const displayedIdentities = method === 'run' ? args[7] : undefined;
    if (['send', 'forward', 'run'].includes(method)) {
      const ids = method === 'run' ? args[0] : [args[0]], index = method === 'run' ? 5 : 2;
      if (!Array.isArray(ids)) throw Error('无效会话选择。');
      const supplied = args[index];
      const expected = ids.flatMap(id => {
        // Retained pre-transition services historically discover run members
        // during refresh. They cannot rebind a root in place. New services and
        // explicit GUI context receipts always require an already known row.
        if (method === 'run' && supplied === undefined && !this.entries.some(e => e.state.sessions.some(s => s.id === id)) &&
          !this.entries.some(e => e.state.capabilities?.includes('nativeContextTransitions'))) return [];
        const entry = this.route(id), record = entry.state.sessions.find(s => s.id === id);
        const nativeId = supplied === undefined ? record?.nativeId : method === 'run' ? supplied?.[id] : supplied;
        return [{ id, entry, nativeId, identity: displayedIdentities?.[id] || peerIdentity(record) }];
      });
      if (method === 'run') runIdentities = Object.fromEntries(expected.map(e => [e.id, e.identity]));
      contextGuard = () => {
        replyGuard();
        for (const { id, entry, nativeId } of expected) {
          const current = entry.state.sessions.find(s => s.id === id);
          if (method === 'run' && displayedIdentities && JSON.stringify(peerIdentity(current || {})) !== JSON.stringify(runIdentities[id])) throw Error('成员的输入、控制权或加入状态已变化，请重新预览授权。');
          if (!current || current.nativeContextPending || current.nativeId !== nativeId) throw Error('原生上下文已变化，请重新查看后发送；草稿保留。');
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
        if (!bridged && targets.some(e => !e.state.capabilities?.includes('replyThreads'))) throw Error('这个保留连接尚不支持回复关联；草稿保留，没有发送。');
        if (!bridged) args[method === 'run' ? 6 : 3] = replyTo;
      }
    }
    if (method === 'queue' || method === 'queueShared') {
      const [id, text, nativeId] = args, target = this.route(id), guard = this.operationGuard(target);
      const original = target.state.sessions.find(s => s.id === id);
      const shared = method === 'queueShared';
      const bridge = this.control.legacyInput;
      if (bridge?.target(original)?.queueAvailable) {
        const expected = { ...original };
        if (expected.nativeId !== nativeId || this.sessionState(expected) !== 'working' || (shared &&
          (expected.roomId !== 'shared' || !bridge.target(original).sharedReplyAvailable || bridge.sharedReplies.storageError))) throw Error('原生回合或共享连接已变化；草稿保留。');
        return this.intervene(async () => {
          const manualValid = this.manualGuard(id);
          const draftRevision = this.control.draftVersions?.get(id) || 0;
          const shareAuthority = shared ? this.legacyShareAuthority(target, expected) : undefined;
          const valid = () => {
            try { guard(); replyGuard(); this.authorizeOperation?.(method, args); } catch { return false; }
            const current = target.state.sessions.find(s => s.id === id);
            return manualValid() && current?.nativeId === nativeId && current.pid === expected.pid &&
              current.owner === target.state.owner && current.controlRevision === expected.controlRevision &&
              current.memberRevision === expected.memberRevision && !current.approval && !current.nativeContextPending &&
              ['idle', 'working'].includes(this.sessionState(current)) && bridge.target(current)?.queueAvailable &&
              (!shared || shareAuthority());
          };
          const refresh = async () => { await this.refresh(); if (!valid()) throw Error('原会话或控制权已变化；草稿保留。'); };
          await this.pauseExcept(); await refresh();
          const record = target.state.sessions.find(s => s.id === id);
          const draft = record.liveDraft;
          const tag = await bridge.send(record, text, refresh, valid, shared, replyTo, undefined, true, shareAuthority);
          if (!shared && draft?.trim() === text.trim()) await this.legacyDraft(target, id, '', record, current =>
            current.liveDraft === draft && (this.control.draftVersions?.get(id) || 0) === draftRevision).catch(() => {});
          return tag;
        }, id, shared);
      }
      if (!target.state.capabilities?.includes(shared ? 'nativeSharedQueue' : 'nativeQueue') || original?.nativeId !== nativeId || (shared && original?.roomId !== 'shared')) throw Error('此连接暂不支持原生等待输入；草稿保留。');
      return this.intervene(async () => {
        const manualValid = this.manualGuard(id), control = original.controlRevision, member = original.memberRevision;
        await this.pauseExcept(); await this.refresh(); guard(); replyGuard(); this.authorizeOperation?.(method, args);
        const current = target.state.sessions.find(s => s.id === id);
        if (!manualValid() || current?.controlRevision !== control || current?.nativeId !== nativeId || current?.nativeContextPending || current?.owner !== target.state.owner || current?.state !== 'working' || current?.approval || current?.pendingQueue || !current?.queueAvailable ||
          (shared && (current.roomId !== 'shared' || current.memberRevision !== member))) throw Error('当前原生会话或控制权已变化，草稿保留。');
        return target.client.call(method, id, text, nativeId, ...(shared ? [replyTo] : []));
      }, id, shared);
    }
    if (method === 'steer' || method === 'steerShared') {
      const [id, text, nativeId, turnId] = args, target = this.route(id), guard = this.operationGuard(target);
      const original = target.state.sessions.find(s => s.id === id);
      if (typeof turnId !== 'string' || !turnId || turnId.length > 160 || original?.nativeId !== nativeId) throw Error('当前原生回合已变化，草稿保留。');
      const shared = method === 'steerShared';
      const bridged = target.state.runtimeVersion === '0.1.0-alpha.2' && this.control.legacyInput?.target(original)?.native;
      if (shared && (!(bridged?.sharedReplyAvailable && !this.control.legacyInput.sharedReplies.storageError || target.state.capabilities?.includes('nativeSharedSteer')) || original?.roomId !== 'shared')) throw Error('此连接暂不支持共享追加指令；草稿保留。');
      if (!(bridged?.steerAvailable || target.state.capabilities?.includes('nativeSteer'))) throw Error('此连接暂不支持工作中追加指令；请在原生终端继续。');
      return this.intervene(async () => {
        const manualValid = this.manualGuard(id), control = original.controlRevision, member = original.memberRevision;
        const draftRevision = this.control.draftVersions?.get(id) || 0;
        const valid = () => {
          try { guard(); replyGuard(); this.authorizeOperation?.(method, args); } catch { return false; }
          const raw = target.state.sessions.find(s => s.id === id), current = this.snapshot().sessions.find(s => s.id === id);
          return manualValid() && raw?.controlRevision === control && raw.owner === target.state.owner &&
            raw.nativeId === nativeId && raw.pid === original.pid && !raw.nativeContextPending && current?.state === 'working' && !current.approval &&
            // The retained transport owns its pending-send lock. Once acquired,
            // this router must not mistake that same send for a competing one.
            (!current.pendingSteer || bridged) && current.activeTurnId === turnId &&
            (!shared || (raw.roomId === 'shared' && raw.memberRevision === member));
        };
        await this.pauseExcept(null); await this.refresh();
        if (!valid()) throw Error('当前回合或控制权已变化；草稿保留，没有另开回合。');
        if (!bridged) return target.client.call(method, ...args);
        // A draft write already queued before this send may have completed
        // during refresh. Read its text now, retaining the click-time revision.
        const draft = target.state.sessions.find(s => s.id === id)?.liveDraft;
        const refresh = async () => { await this.refresh(); if (!valid()) throw Error('原生状态已变化'); };
        const shareAuthority = shared ? this.legacyShareAuthority(target, original) : undefined;
        const tag = await this.control.legacyInput.send(original, text, refresh, valid, shared, replyTo, turnId, false, shareAuthority);
        if (!shared && draft?.trim() === text.trim()) await this.legacyDraft(target, id, '', original, current =>
          current.liveDraft === draft && (this.control.draftVersions?.get(id) || 0) === draftRevision).catch(() => {});
        return tag;
      }, id);
    }
    if (method === 'initial') return this.refresh();
    if (method === 'nativeHistory') {
      const guard = this.operationGuard(this.active); guard();
      if (!this.active.state.capabilities?.includes('nativeHistory')) throw Error('请重新打开应用连接新版后台；已有会话保持原样。');
      const result = await this.active.client.call(method, ...args); guard();
      const snapshot = await this.refresh(); guard();
      return { ...result, data: result.data.map(row => ({ ...row, existingIds: snapshot.sessions.filter(s => s.provider === 'codex' && s.nativeId === row.nativeId).map(s => s.id) })) };
    }
    if (method === 'importHistory') {
      const guard = this.operationGuard(this.active);
      const operation = creationQueue.then(async () => {
        guard(); const snapshot = await this.refresh(); guard();
        const existing = snapshot.sessions.filter(s => s.provider === 'codex' && s.nativeId === args[0]);
        if (existing.length > 1) throw Error('已有记录归属冲突；没有恢复第二个连接。');
        if (existing.length) return existing[0].id;
        assertNativeCreation(snapshot);
        if (!snapshot.capabilities.includes('nativeHistory')) throw Error('当前后台尚不支持原生历史接入。');
        if (snapshot.sessions.filter(s => s.state !== 'ended').length >= 6) throw Error('Demo 最多同时运行 6 个会话，请先结束不需要的会话。');
        const id = await this.active.client.call(method, ...args);
        await this.refresh(); return id;
      });
      creationQueue = operation.catch(() => {}); return operation;
    }
    if (method === 'retrySave') {
      const targets = this.entries.filter(e => e.state.storageRetryable && e.state.capabilities?.includes('retrySave'));
      if (!targets.length) throw new Error('当前没有支持重试的保存失败；原记录保持不变。');
      const targetsWithGuards = targets.map(entry => ({ entry, guard: this.operationGuard(entry) }));
      let failed = false;
      for (const { entry, guard } of targetsWithGuards) {
        try { guard(); await entry.client.call('retrySave'); } catch { failed = true; }
      }
      await this.refresh();
      if (failed) throw new Error('部分记录仍未保存，请保留窗口并检查磁盘空间和写入权限。');
      return true;
    }
    if (method === 'pause') {
      // A member change stops automatic routing, but only invalidates that
      // member's manual input/reply. Explicit room pause remains global.
      const id = args[0]; if (id !== undefined) this.route(id);
      return this.intervene(() => {
        const entries = new Map(this.entries.map(e => [e.key, e]));
        for (const [key, arm] of this.control.armed) entries.set(key, arm.entry);
        return Promise.all([...entries.values()].map(e => this.pauseEntry(e, true)));
      }, id);
    }
    if (method === 'create') {
      const guard = this.operationGuard(this.active);
      const operation = creationQueue.then(async () => {
        guard();
        const state = await this.refresh(); assertNativeCreation(state);
        if (state.sessions.filter(s => s.state !== 'ended').length >= 6) throw new Error('Demo 最多同时运行 6 个会话，请先结束不需要的会话。');
        guard();
        const id = await this.active.client.call(method, ...args); await this.refresh(); return id;
      });
      creationQueue = operation.catch(() => {}); return operation;
    }
    if (method === 'shutdown' || method === 'clearSharedHistory') {
      this.control.revision++; this.control.manualEpoch++;
      const sharedIds = this.control.legacyInput?.sharedMessages?.().map(message => message.id) || [];
      const guards = this.entries.map(e => this.operationGuard(e)); guards.forEach(check => check());
      const state = await this.refresh();
      if (method === 'shutdown' && state.sessions.some(s => s.state !== 'ended')) throw new Error('请先结束各原生会话，再关闭运行服务。');
      if (method === 'clearSharedHistory' && (!state.capabilities.includes(method) || state.room.run?.status === 'running')) throw new Error('请先暂停交接，并确认各后台支持清除记录。');
      if (method === 'clearSharedHistory' && this.entries.some(e => e.state.room.run?.pausePending || e.state.room.run?.pauseUnconfirmed)) throw new Error('请先核对各后台已撤销后续交接授权，再清除共享记录。');
      // These are explicit user actions. Partial failure must remain visible.
      guards.forEach(check => check());
      const results = await Promise.allSettled(this.entries.map(e => method === 'clearSharedHistory'
        && e.state.runtimeVersion === '0.1.0-alpha.2' && !e.state.room.messages?.length ? Promise.resolve() : e.client.call(method)));
      if (results.some(r => r.status === 'rejected')) throw new Error('部分后台未确认操作；请重新连接核对，未自动重试。');
      if (method === 'clearSharedHistory') this.control.legacyInput?.clearSharedHistory(sharedIds);
      return true;
    }
    if (method === 'run') {
      const guards = new Map(this.entries.map(e => [e.key, this.operationGuard(e)]));
      const revision = ++this.control.revision;
      this.control.manualEpoch++;
      const interventions = [...this.control.interventions];
      const state = await this.refresh();
      if (this.entries.some(e => e.state.room.run?.pausePending || e.state.room.run?.pauseUnconfirmed)) throw Error('请先核对各后台已撤销后续交接授权，再开始新的协作。');
      if (!Array.isArray(args[0]) || args[0].length < 2 || args[0].length > 6 || new Set(args[0]).size !== args[0].length) throw new Error('请选择 2–6 个不同会话。');
      const targets = args[0].map(id => this.route(id));
      const guard = guards.get(targets[0].key); guard();
      const crossService = targets.some(target => target !== targets[0]);
      if (crossService && (!['replies', 'directed'].includes(args[3]) || args[3] === 'directed' && (!this.active.state.capabilities?.includes(PEER_DIRECTED) || targets.some(t => !t.state.capabilities?.includes(PEER_DIRECTED))) || !this.active.state.capabilities?.includes(PEER_HANDOFFS) || targets.some(t => !t.state.capabilities?.includes(PEER_HANDOFFS)))) throw new Error('跨版本/跨后台协作尚不支持这些连接的可撤销顺序核查；原生会话保留，可人工分享。');
      assertAutomaticRun(state, args[3], args[0]); assertSharing(state, args[0]);
      await Promise.all(interventions);
      await this.pauseExcept(crossService ? null : targets[0]);
      const previousArm = this.control.armed.get(targets[0].key);
      if (previousArm?.entry.closing || previousArm?.entry.closed) await this.pauseEntry(targets[0]);
      const previousPause = this.control.armed.get(targets[0].key)?.pause;
      if (previousPause) await previousPause;
      if (revision !== this.control.revision || this.socket.destroyed) throw new Error('真人操作已使这次交接失效；请重新确认任务。');
      this.authorizeOperation?.(method, args);
      guard(); contextGuard();
      if (this.entries.some(e => e.state.room.run?.pausePending || e.state.room.run?.pauseUnconfirmed)) throw Error('请先核对各后台已撤销后续交接授权，再开始新的协作。');
      if (crossService) {
        for (const id of args[0]) if (JSON.stringify(peerIdentity(this.route(id).state.sessions.find(s => s.id === id))) !== JSON.stringify(runIdentities[id])) throw Error('成员输入或控制权已变化，请重新授权。');
        const activeGuard = guards.get(this.active.key); activeGuard();
        const arm = { entry: this.active }; this.control.armed.set(this.active.key, arm);
        return this.active.client.call('peerRun', { ids: args[0], goal: args[1], maxSteps: args[2], mode: args[3], labels: args[4] || {},
          contexts: Object.fromEntries(args[0].map(id => [id, this.route(id).state.sessions.find(s => s.id === id).nativeId])),
          identities: runIdentities, routes: Object.fromEntries(args[0].map(id => [id, this.route(id).key])), replyTo });
      }
      const arm = this.control.armed.get(targets[0].key) || { entry: targets[0] };
      this.control.armed.set(targets[0].key, arm);
      return arm.entry.client.call(method, ...args);
    }
    if (!['prepareInput', 'observe', 'unobserve', 'join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'forward', 'approve', 'stop', 'resume', 'forget'].includes(method)) throw new Error('不支持的本地操作。');
    const target = this.route(args[0]);
    const guard = this.operationGuard(target); guard();
    const legacy = target.state.runtimeVersion === '0.1.0-alpha.2';
    if (legacy && ['claim', 'terminal', 'interrupt'].includes(method)) {
      const expected = { ...target.state.sessions.find(s => s.id === args[0]) };
      const owned = expected.owner === target.state.owner;
      const ownerRevision = this.control.legacyOwners.get(args[0])?.revision;
      if (method === 'interrupt' && !owned) throw Error('请先接管会话，再停止原生任务。');
      const operation = () => this.legacyMutation(target, async () => {
        if (!owned || method === 'interrupt') await this.pauseExcept(null);
        guard(); await this.refresh(); guard(); this.authorizeOperation?.(method, args);
        const current = target.state.sessions.find(s => s.id === args[0]);
        if (!current || current.owner !== expected.owner || current.nativeId !== expected.nativeId || current.pid !== expected.pid
          || this.control.legacyOwners.get(args[0])?.revision !== ownerRevision) throw Error('会话已由其他窗口接管；请重新确认控制权。');
        const result = await target.client.call(method, ...args);
        await this.refresh(); guard(); return result;
      });
      return owned && method !== 'interrupt' ? operation() : this.intervene(operation, args[0]);
    }
    if (method === 'prepareInput') {
      await this.refresh(); guard();
      const record = target.state.sessions.find(s => s.id === args[0]);
      if (record?.owner !== target.state.owner || !this.control.legacyInput) throw Error('请先在此窗口接管原会话。');
      return this.control.legacyInput.prepare(target, record);
    }
    if (method === 'approve' && legacy && target.state.sessions.find(s => s.id === args[0])?.provider === 'codex' &&
      !(typeof args[1] === 'string' && args[1].startsWith('legacy:'))) throw Error('原生确认连接已变化；请在原生终端查看，不会执行旧后台的确认。');
    if (method === 'approve' && typeof args[1] === 'string' && args[1].startsWith('legacy:')) {
      await this.refresh(); guard(); this.authorizeOperation?.(method, args);
      const record = target.state.sessions.find(s => s.id === args[0]);
      if (record?.owner !== target.state.owner) throw Error('会话控制权已变化，请重新查看。');
      const native = this.control.legacyInput?.target(record)?.native;
      if (!native) throw Error('原生确认连接已变化，没有将确认交给其他连接。');
      return native.approve(args[1], args[2]);
    }
    if (method === 'approve' && !target.state.capabilities?.includes('nativeApprovalSync')) {
      throw Error('旧连接无法核实这项确认的最新状态，请在原生终端核对；没有发送决定。');
    }
    if (method === 'approve' && !target.state.capabilities?.includes('nativeApprovalLocalDecisions')) {
      const approval = target.state.sessions.find(s => s.id === args[0])?.approval;
      if (!nativeApprovalPolicy(approval, { localDecisions: false }).decisions.includes(args[2])) {
        throw Error('旧后台不支持这项确认方式，请在原生终端处理；没有发送决定。');
      }
    }
    if (['send', 'forward'].includes(method) && this.control.legacyInput?.connected(target.state.sessions.find(s => s.id === args[0]))) {
      const shared = method === 'forward';
      return this.intervene(async () => {
        const manualValid = this.manualGuard(args[0]);
        await this.pauseExcept(null); await this.refresh(); guard();
        contextGuard();
        const record = target.state.sessions.find(s => s.id === args[0]);
        if (shared && record?.roomId !== 'shared') throw Error('接收方已离开共同工作。');
        const control = record.controlRevision, member = record.memberRevision;
        const failedTurn = record.state === 'error' ? this.control.legacyInput.target(record)?.failedTurnInputId : null;
        const draft = record.liveDraft, draftRevision = this.control.draftVersions?.get(record.id) || 0;
        const valid = () => {
          try { guard(); contextGuard(); this.authorizeOperation?.(method, args); } catch { return false; }
          const current = target.state.sessions.find(s => s.id === record.id);
          return manualValid() && current?.pid === record.pid && current.nativeId === record.nativeId
            && current.owner === target.state.owner && current.controlRevision === control && current.memberRevision === member
            && (!shared || current.roomId === 'shared')
            && (this.sessionState(current) === 'idle' || current.state === 'error' && failedTurn && this.control.legacyInput.target(current)?.failedTurnInputMatches(failedTurn))
            && !this.control.legacyInput.target(current)?.nativeInputRequired && !current.pendingTag && !current.approval;
        };
        if (!valid()) throw Error('原会话状态或控制权已变化，草稿已保留。');
        const refresh = async () => { await this.refresh(); if (!valid()) throw Error('原会话已变化'); };
        // Native hooks remain the sole writer of conversation history.
        // Never call the old paste/Enter sender or launch a replacement CLI.
        const shareAuthority = this.legacyShareAuthority(target, record);
        const tag = await this.control.legacyInput.send(record, args[1], refresh, valid, shared, replyTo, undefined, false, shareAuthority);
        // An accepted native submission stays accepted even if cleanup loses
        // ownership or the connection. Never report that as a failed send.
        if (!shared && draft?.trim() === args[1].trim()) await this.legacyDraft(target, record.id, '', record, current =>
          current.liveDraft === draft && (this.control.draftVersions?.get(record.id) || 0) === draftRevision).catch(() => {});
        return tag;
      }, args[0]);
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
      if (!supportsLegacyObservation(target.state, record)) throw Error('此连接尚无安全的只读观察接口。');
      let observer = this.legacyObservers.get(id);
      if (!observer) {
        for (const [oldId, oldObserver] of this.legacyObservers) if (!oldObserver.watching && this.legacyObservers.size >= 12) { oldObserver.dispose(); this.legacyObservers.delete(oldId); }
        if (this.legacyObservers.size >= 12) throw Error('观察数量已达上限，请关闭不需要的视图。');
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
      catch { throw Error('会话已移除，但本地阅读副本未能全部清理。请检查本机数据权限与磁盘空间。'); }
      return result;
    }
    if (['send', 'forward'].includes(method)) assertSubmission(target.state, [args[0]]);
    if (method === 'forward') assertSharing(target.state, [args[0]]);
    const ownView = ['claim', 'terminal'].includes(method) && typeof target.state.owner === 'string' && target.state.sessions.find(s => s.id === args[0])?.owner === target.state.owner;
    if (ownView) return target.client.call(method, ...args);
    if (['join', 'claim', 'terminal', 'send', 'interrupt', 'forward', 'stop', 'resume'].includes(method) || (method === 'input' && !isTerminalResponse(args[1]))) return this.intervene(async () => {
      await this.pauseExcept(null); guard(); contextGuard(); this.authorizeOperation?.(method, args); return target.client.call(method, ...args);
    }, args[0]);
    return target.client.call(method, ...args);
  }
  close() {
    if (this.closing) return;
    this.closing = true; this.socket.destroyed = true; this.control.revision++; this.control.manualEpoch++;
    for (const observer of this.legacyObservers.values()) observer.dispose(); this.legacyObservers.clear();
    for (const e of this.entries) { e.closing = true; e.client.close(); }
    this.control.views.delete(this);
    if (--this.control.clients === 0) { this.control.legacyInput?.close(); controls.delete(this.scope); }
  }
}
module.exports = { WorkspaceClient };
