'use strict';
const policy = require('./goal-continuation.cjs');

// The Workspace remains the single durable writer. No clock, model prompt,
// Markdown watcher or retry loop: only an authenticated handoff event can run.
const initial = () => ({ version: 1, authorization: null, authorityVersion: 0,
  policy: policy.createState(), bindings: {}, pending: {} });
const map = value => value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = reason => ({ status: 'denied', reason });
class GoalContinuation {
  constructor(workspace, saved) {
    this.w = workspace; this.hasJournal = saved !== undefined;
    if (saved !== undefined && (saved?.version !== 1 || !map(saved.policy) || saved.policy.version !== 1 ||
        typeof saved.policy.enabled !== 'boolean' || !map(saved.policy.waits) || !map(saved.policy.events) ||
        !map(saved.bindings) || !map(saved.pending) ||
        Object.entries(saved.policy.waits).some(([id, row]) => !row || row.id !== id ||
          !map(row.expected) || typeof row.expected.nativeId !== 'string' || !map(row.expected.goal) ||
          !Array.isArray(row.triggers)))) {
      this.error = 'invalid-continuation-journal';
      this.invalidSaved = copy(saved);
    }
    this.data = this.error ? initial() : copy(saved || initial());
    this.data.authorityVersion ??= this.data.authorization?.version || 0;
    this.running = new Map();
    // An uncertain write is never replayed after restart.
    for (const row of Object.values(this.data.policy.waits || {})) {
      if (row.status === 'attempting') {
        row.status = 'unconfirmed';
        const room = this.w.rooms.get(row.scopeId);
        if (room) room.messages.push({ id: `goal-continuation:${row.intent?.id || row.id}:recovered`,
          role: 'system', kind: 'notice', name: 'NAW', time: Date.now(),
          text: 'Goal continuation: unconfirmed (service restarted; no replay)',
          goalContinuation: { id: row.intent?.id || row.id, scopeId: row.scopeId,
            status: 'unconfirmed', nativeId: row.expected.nativeId, taskId: row.taskId,
            reason: 'service-restarted' } });
      }
    }
  }
  journal() { return this.invalidSaved !== undefined ? this.invalidSaved : this.hasJournal ? this.data : undefined; }
  save(next, receipt) {
    if (this.error || this.w.closed || this.w.storageWarning) throw Error('Continuation storage unavailable');
    this.hasJournal = true; this.data = next;
    for (const row of receipt ? Array.isArray(receipt) ? receipt : [receipt] : []) {
      const room = this.w.rooms.get(row.scopeId);
      if (!room) throw Error('Continuation space no longer exists');
      room.messages.push({ id: `goal-continuation:${row.id}:${row.status}`,
        role: 'system', kind: 'notice', name: 'NAW', time: Date.now(),
        text: `Goal continuation: ${row.status}${row.reason ? ` (${row.reason})` : ''}`,
        goalContinuation: copy(row) });
    }
    this.w.changed();
    if (!this.w.persist() || this.w.storageWarning) {
      this.error = 'continuation-record-not-saved';
      throw Error(this.error);
    }
  }
  configure(authorization) {
    // Only the authenticated human control route may call this method. It is
    // intentionally absent from ordinary messages and automatic peer transfers.
    if (authorization !== null && (!authorization || authorization.source !== 'human' ||
        authorization.status !== 'granted' || authorization.capability !== policy.CAPABILITY ||
        typeof authorization.id !== 'string' || !authorization.id ||
        !(Number.isSafeInteger(authorization.version) && authorization.version > 0) ||
        !this.w.rooms.has(authorization.scopeId))) return fail('invalid-human-authority');
    if (authorization && authorization.version <= this.data.authorityVersion) return fail('authority-version-not-newer');
    const next = copy(this.data);
    const receipts = this.invalidateRows(next, () => true, 'authority-changed');
    next.authorization = copy(authorization);
    if (authorization) next.authorityVersion = authorization.version;
    next.policy.enabled = authorization !== null;
    this.save(next, receipts);
    return { status: authorization ? 'enabled' : 'revoked' };
  }
  invalidateRows(data, matches, reason) {
    const receipts = [];
    for (const row of Object.values(data.policy.waits)) {
      if (!['waiting', 'attempting'].includes(row.status) || !matches(row)) continue;
      const wasWaiting = row.status === 'waiting';
      if (wasWaiting) row.status = 'invalidated';
      // An in-flight native call may already have written. Withdraw its guard,
      // but retain the unresolved attempt until the actual result arrives.
      row.cancelled = true; row.reason = reason; delete data.pending[row.id];
      receipts.push({ id: row.intent?.id || row.id, scopeId: row.scopeId,
        status: wasWaiting ? 'invalidated' : 'cancelling', reason,
        nativeId: row.expected.nativeId, taskId: row.taskId });
    }
    return receipts;
  }
  invalidate(scopeId, sessionId) {
    if (this.error) return;
    const next = copy(this.data);
    const receipts = this.invalidateRows(next, row => (!scopeId || row.scopeId === scopeId) &&
      (!sessionId || next.bindings[row.id]?.sessionId === sessionId), 'human-or-handoff-boundary');
    if (receipts.length) this.save(next, receipts);
  }
  binding(id, scopeId) {
    const s = this.w.sessions.get(id), r = this.w.runtimes.get(id);
    if (!s || !r || s.provider !== 'codex' || !this.w.rooms.has(scopeId) ||
        !require('./collaboration-spaces.cjs').isMember(s, scopeId) ||
        r.stopped || r.transportDisconnected || r.backendExitConfirmed || s.nativeContextPending) return null;
    let wakeBoundary;
    try { if (!require('./session-wake.cjs').enabled(this.w)) return null;
      wakeBoundary = require('./session-wake.cjs').boundary(this.w); } catch { return null; }
    return { sessionId: id, nativeId: s.nativeId, scopeId, wakeBoundary,
      memberRevision: require('./collaboration-spaces.cjs').membershipRevision(s, scopeId),
      controlRevision: s.controlRevision || 0, draftRevision: this.w.draftRevisions.get(id) || 0 };
  }
  current(binding) {
    const now = this.binding(binding.sessionId, binding.scopeId);
    return now && JSON.stringify(now) === JSON.stringify(binding);
  }
  async observe(id) {
    const r = this.w.runtimes.get(id), s = this.w.sessions.get(id);
    if (!r || typeof r.goalContinuationObserve !== 'function') return null;
    const observed = await r.goalContinuationObserve();
    // Adapter facts cannot override the Workspace's current human boundaries.
    if (this.w.runtimes.get(id) !== r || !s || observed?.nativeId !== s.nativeId) return null;
    return { ...observed, known: observed?.known === true && observed.state === s.state,
      state: observed?.state, controlRevision: s.controlRevision || 0,
      approvalPending: observed?.approvalPending !== false || !!(s.approval || s.claudeQuestion || r.nativeInputRequired || r.nativeAbortRequest),
      inputPending: observed?.inputPending !== false || !!(s.pendingTag || s.terminalInputPending || r.pendingQueue || r.pendingSteer ||
        this.w.drafts.get(id)),
      waitingOnUser: observed?.waitingOnUser === false ? false : true };
  }
  async register(id, wait) {
    if (!wait || wait.blockedSnapshot !== undefined || ['__proto__', 'constructor', 'prototype'].includes(wait.id)) return fail('caller-snapshot-not-authority');
    const binding = this.binding(id, wait.scopeId);
    if (!binding) return fail('native-binding-unavailable');
    const snapshot = await this.observe(id);
    if (!this.current(binding)) return fail('human-or-membership-changed');
    const next = policy.registerWait(this.data.policy, { authorization: this.data.authorization,
      snapshot, wait: { ...wait, blockedSnapshot: snapshot } });
    if (next.status !== 'waiting') return next;
    const data = copy(this.data); data.policy = next.state; data.bindings[wait.id] = binding;
    this.save(data, { id: wait.id, status: 'waiting', scopeId: wait.scopeId,
      sessionId: id, nativeId: binding.nativeId, taskId: wait.taskId });
    return { status: 'waiting', waitId: wait.id };
  }
  async event(event) {
    // Caller supplies a structured, durably accepted assignment/adoption. This
    // method is NOT an RPC receiving untrusted model text or task-board mtimes.
    if (!event || event.source !== 'task-board' || event.confirmed !== true ||
        typeof event.id !== 'string' || !event.id || event.id.length > 512 ||
        !['dependency-completed', 'task-assigned'].includes(event.kind) ||
        typeof event.subjectId !== 'string' || !event.subjectId ||
        event.scopeId !== this.data.authorization?.scopeId) return fail('event-not-authorized');
    const matches = Object.values(this.data.policy.waits).filter(row => row.status === 'waiting' &&
      row.scopeId === event.scopeId && row.triggers.some(t => t.kind === event.kind && t.subjectId === event.subjectId));
    const next = copy(this.data);
    for (const row of matches) if (!Object.hasOwn(next.pending, row.id)) next.pending[row.id] = copy(event);
    this.save(next);
    return Promise.all(matches.map(row => this.drain(row.id)));
  }
  boundary(id) {
    return Promise.all(Object.entries(this.data.bindings).filter(([key, b]) => b.sessionId === id &&
      Object.hasOwn(this.data.pending, key))
      .map(([waitId]) => this.drain(waitId)));
  }
  drain(waitId) {
    if (this.running.has(waitId)) return this.running.get(waitId);
    const promise = this.attempt(waitId).finally(() => this.running.delete(waitId));
    this.running.set(waitId, promise); return promise;
  }
  async attempt(waitId) {
    const binding = this.data.bindings[waitId], event = this.data.pending[waitId];
    if (!binding || !event || this.data.policy.waits[waitId]?.status !== 'waiting') return fail('no-pending-handoff');
    const s = this.w.sessions.get(binding.sessionId), r = this.w.runtimes.get(binding.sessionId);
    if (s?.state === 'working') return { status: 'deferred' };
    if (!this.current(binding)) return fail('human-or-membership-changed');
    const snapshot = await this.observe(binding.sessionId);
    if (!this.current(binding)) return fail('human-or-membership-changed');
    const next = policy.receiveEvent(this.data.policy, { authorization: this.data.authorization,
      snapshot, waitId, event });
    if (next.status !== 'intent') {
      if (next.state !== this.data.policy) { const data = copy(this.data); data.policy = next.state; this.save(data); }
      return { status: next.status, reason: next.reason };
    }
    // Missing execution capability is admission failure, not a native attempt.
    // Keep the confirmed event pending until the port is actually available.
    const canResume = () => typeof r.goalContinuationResume === 'function' &&
      policy.REQUIREMENTS.every(cap => r.goalContinuationCapabilities?.includes(cap));
    if (!canResume()) {
      if (!this.data.policy.waits[waitId].capabilityUnavailable) {
        const held = copy(this.data); held.policy.waits[waitId].capabilityUnavailable = true;
        this.save(held, { id: `${waitId}:native-capability`, scopeId: binding.scopeId,
          nativeId: binding.nativeId, taskId: this.data.policy.waits[waitId].taskId,
          status: 'waiting', reason: 'conditional-native-resume-unavailable' });
      }
      return fail('conditional-native-resume-unavailable');
    }
    const intent = next.intent, data = copy(this.data); data.policy = next.state;
    delete data.pending[waitId];
    const receipt = { id: intent.id, scopeId: binding.scopeId, taskId: intent.taskId,
      sessionId: binding.sessionId, nativeId: intent.nativeId, trigger: intent.trigger };
    // State and visible space receipt are durable BEFORE the sole native call.
    this.save(data, { ...receipt, status: 'attempting' });
    const valid = () => !this.error && !this.w.closed && !this.w.storageWarning && this.current(binding) &&
      JSON.stringify(this.data.authorization && { id: this.data.authorization.id,
        version: this.data.authorization.version, scopeId: this.data.authorization.scopeId }) === JSON.stringify(intent.authorization) &&
      this.data.authorization?.status === 'granted' && this.data.policy.enabled &&
      this.data.policy.waits[waitId]?.status === 'attempting' && !this.data.policy.waits[waitId]?.cancelled &&
      this.w.runtimes.get(binding.sessionId) === r;
    let result;
    try {
      if (!valid()) result = { status: 'rejected', reason: 'authority-or-control-changed' };
      else if (!canResume()) {
        result = { status: 'rejected', reason: 'conditional-native-resume-unavailable' };
      } else {
        const native = await r.goalContinuationResume(intent, { valid });
        const after = await this.observe(binding.sessionId);
        result = native?.status === 'confirmed' && valid() ? { status: 'confirmed', snapshot: after } :
          { status: 'unconfirmed', reason: native?.reason || 'native-result-unconfirmed' };
      }
    } catch { result = { status: 'unconfirmed', reason: 'native-result-unconfirmed' }; }
    let recorded = policy.recordResult(this.data.policy, { intentId: intent.id, result });
    if (recorded.status === 'denied') {
      result = { status: 'unconfirmed', reason: recorded.reason };
      recorded = policy.recordResult(this.data.policy, { intentId: intent.id, result });
    }
    const final = copy(this.data); final.policy = recorded.state;
    this.save(final, { ...receipt, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
    return { status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
  }
}
module.exports = { GoalContinuation };
