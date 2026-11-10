// Private service-side projection over the original runtime's existing RPC.
// No native connection, resume/history read, terminal access or approval reply.
const { randomUUID } = require('node:crypto');
const { isMember, membershipRevision } = require('./collaboration-spaces.cjs');
const { identity: sharedInputIdentity } = require('./peer-handoffs.cjs');
const { isDeepStrictEqual } = require('node:util');
const wake = require('./session-wake.cjs');
const { validateOutboxArgs, nativeOutboxCall, nativeOutboxReceipt, outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');
const CAPABILITY = 'scopedNativeOutboxV1';
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const exact = (v, keys) => v && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
class ScopedOutboxRuntime {
  constructor(workspace) {
    this.workspace = workspace; this.scopes = new Map();
    this.changed = () => { for (const scope of [...this.scopes.values()]) this.check(scope); };
    workspace.on('change', this.changed);
  }
  actor(id, reason = 'recipient-unavailable', control = false) {
    const w = this.workspace, s = w.sessions.get(id), runtime = w.runtimes.get(id);
    if (w.closed || !s || !(s.provider === 'codex' || control && s.provider === 'claude') || !runtime || runtime.stopped || runtime.transportDisconnected ||
        s.archived || s.nativeContextPending || runtime.record.nativeId !== s.nativeId || !token(s.nativeId) ||
        (s.provider === 'codex' && (!token(runtime.nativeSessionId) || !runtime.host?.rpc)) || !control && (!isMember(s, 'shared') || !wake.enabled(w))) throw outboxError(reason, 'binding');
    return { s, runtime, nativeId: s.nativeId, pid: s.pid, owner: s.owner, control: s.controlRevision,
      connection: s.connectionRevision, peer: s.peerRevision, member: membershipRevision(s, 'shared'), hostRpc: runtime.host.rpc,
      sessionId: runtime.nativeSessionId, lifecycle: runtime.lifecycleRevision, inputIdentity: sharedInputIdentity(s), wakeBoundary: wake.boundary(w) };
  }
  stable(scope) {
    try {
    const a = scope.actor, { s, runtime } = a, w = this.workspace;
    return !w.closed && !w.storageWarning && !scope.closed && !scope.client.destroyed &&
      (scope.control || wake.enabled(w) && wake.boundary(w) === a.wakeBoundary && (scope.kind === 'call' || !s.wakeDisabled)) && w.sessions.get(s.id) === s && w.runtimes.get(s.id) === runtime &&
      !runtime.stopped && !runtime.transportDisconnected && !s.archived && !s.nativeContextPending &&
      s.nativeId === a.nativeId && s.pid === a.pid && s.owner === a.owner && s.controlRevision === a.control &&
      s.connectionRevision === a.connection && s.peerRevision === a.peer && runtime.host.rpc === a.hostRpc && runtime.nativeSessionId === a.sessionId &&
      runtime.lifecycleRevision === a.lifecycle && (scope.control || isMember(s, 'shared') && membershipRevision(s, 'shared') === a.member) &&
      isDeepStrictEqual(sharedInputIdentity(s), a.inputIdentity);
    } catch { return false; }
  }
  ready(scope) {
    const { s, runtime } = scope.actor, w = this.workspace;
    // Native 0.167's held TUI RPC starts a separate task without submitting or
    // clearing its edit line (qualified with an actual native command and draft).
    // Keep the conservative marker for retirement and every unqualified route.
    // New typing still changes controlRevision and invalidates stable(scope).
    const preservesTerminalEdit = runtime.host?.rpc?.nativeVersion === '0.167.0' && scope.rpc?.nativeClientVersion === '0.167.0' &&
      runtime.terminalNotificationSource && runtime.terminalRpc === scope.rpc;
    return this.stable(scope) && wake.budgetAllows(s, scope.op) && runtime.scopedOutboxRpc?.() === scope.rpc &&
      (s.state === 'idle' || scope.sent && runtime.pending?.tag === scope.tag) &&
      (!s.pendingTag || scope.sent && s.pendingTag === scope.tag) && (!runtime.pending || scope.sent && runtime.pending.tag === scope.tag) &&
      !runtime.pendingQueue && !runtime.pendingSteer && !runtime.nativeAbortRequest && !runtime.nativeInputRequired &&
      !s.approval && !s.nativeApproval && (!s.terminalInputPending || preservesTerminalEdit) &&
      !w.roomFor('shared').run?.status?.includes('running') && !w.roomFor('shared').run?.pausePending && !w.roomFor('shared').run?.pauseUnconfirmed &&
      !w.peerLeases?.snapshot().some(p => p.status === 'running');
  }
  async checkGoal(scope, phase) {
    let status;
    try { status = await wake.nativeGoalStatus(scope.actor.s, scope.actor.runtime, () => this.ready(scope), scope.rpc); }
    catch { throw outboxError('native-goal-unconfirmed', phase); }
    if (!wake.goalAllows(status)) throw outboxError('native-goal-disallows', phase);
  }
  attach(client, p, actor, kind, notify) {
    if (!uuid(p.op) || this.scopes.size >= 64 || [...this.scopes.values()].filter(s => s.client === client).length >= 8 ||
        [...this.scopes.values()].some(s => s.client === client && s.op === p.op)) throw outboxError('busy', 'binding');
    const scope = { token: randomUUID(), op: p.op, client, actor, kind, notify, closed: false, pendingProof: kind === 'call', abort: new AbortController(), disposers: [] };
    this.scopes.set(scope.token, scope);
    scope.timer = setTimeout(() => this.close(scope), 120000); scope.timer.unref();
    const check = () => this.check(scope);
    for (const name of ['state', 'progress', 'nativeTurnEnd', 'nativeTurnStart', 'nativeInput', 'approval', 'failed', 'fleet']) {
      actor.runtime.on(name, check); scope.disposers.push(() => actor.runtime.off(name, check));
    }
    return scope;
  }
  emit(scope, value) {
    if (scope.closed || scope.client.destroyed) return;
    scope.notify({ op: scope.op, token: scope.token, ...value });
  }
  check(scope) {
    if (scope.closed) return false;
    let valid = false;
    try { valid = this.stable(scope) && (scope.kind === 'call' ? scope.pendingProof || scope.proof?.valid() : scope.sent || this.ready(scope)); } catch {}
    if (!valid) { this.emit(scope, { kind: 'invalidated' }); this.close(scope); }
    return valid;
  }
  close(scope) {
    if (!scope || scope.closed) return;
    scope.closed = true; clearTimeout(scope.timer); this.scopes.delete(scope.token); scope.abort.abort();
    for (const dispose of scope.disposers) dispose(); scope.monitor?.close();
  }
  owned(client, id) {
    const scope = this.scopes.get(id);
    if (!scope || scope.client !== client || !this.check(scope)) throw outboxError('grant-invalidated', 'binding');
    return scope;
  }
  async request(client, action, p, notify) {
    try {
      if (!p || client.destroyed) throw outboxError('owner-closed', 'binding');
      if (action === 'call' || action === 'controlCall') {
        if (!exact(p, 'op,callerId,identity,arguments')) throw outboxError('invalid-request', 'binding');
        const control = action === 'controlCall';
        const args = control ? require('./background-control.cjs').validate(p.arguments) : validateOutboxArgs(p.arguments);
        if (!control && args.space_id !== 'shared') throw outboxError('space-unavailable', 'binding');
        const actor = this.actor(p.callerId, 'caller-unavailable', control);
        if (actor.nativeId !== p.identity?.nativeId) throw outboxError('caller-unavailable', 'binding');
        const scope = this.attach(client, p, actor, 'call', notify);
        scope.control = control;
        try {
          scope.proof = control ? await require('./background-control-native.cjs').nativeCall(actor.runtime, p.identity, args, scope.abort.signal)
            : await nativeOutboxCall(actor.runtime, p.identity, args, scope.abort.signal); scope.pendingProof = false;
          if (!this.check(scope)) throw outboxError('provenance-unconfirmed', 'binding');
          return { ok: true, value: { token: scope.token, sender: { id: actor.s.id, nativeId: actor.nativeId,
            provider: actor.s.provider, name: actor.s.name || 'Agent' } } };
        } catch (error) { this.close(scope); throw error; }
      }
      if (action === 'prepare') {
        if (!exact(p, 'op,recipientId,expected,sender,text') || !exact(p.expected, 'nativeId,pid,owner,controlRevision,memberRevision,connectionRevision,peerRevision,backend') ||
            !exact(p.sender, 'id,nativeId,provider,name') || !['id', 'nativeId', 'name'].every(k => token(p.sender[k])) ||
            !['claude', 'codex'].includes(p.sender.provider) || p.sender.id === p.recipientId) throw outboxError('invalid-request', 'binding');
        validateOutboxArgs({ recipient_id: p.recipientId, message: p.text });
        const actor = this.actor(p.recipientId), e = p.expected;
        const { pid, ...inputIdentity } = e;
        if (actor.pid !== pid || !isDeepStrictEqual(actor.inputIdentity, inputIdentity) || !token(actor.owner))
          throw outboxError('control-changed', 'binding');
        const scope = this.attach(client, p, actor, 'recipient', notify);
        scope.text = p.text; scope.sender = { ...p.sender }; scope.rpc = actor.runtime.scopedOutboxRpc?.();
        try {
          if (!scope.rpc || !this.ready(scope)) throw outboxError('recipient-not-idle', 'binding');
          await this.checkGoal(scope, 'binding');
          scope.monitor = nativeOutboxReceipt(actor.runtime, actor.nativeId, { rpc: scope.rpc, scoped: true });
          scope.disposers.push(scope.monitor.subscribe(receipt => {
            if (this.stable(scope)) this.emit(scope, { kind: 'receipt', receipt });
          }));
          return { ok: true, value: { token: scope.token, nativeId: actor.nativeId } };
        } catch (error) { this.close(scope); throw error; }
      }
      if (action === 'close') {
        if (!exact(p, 'token') && !exact(p, 'op')) throw outboxError('invalid-request', 'cleanup');
        const scope = p.token ? this.scopes.get(p.token) : [...this.scopes.values()].find(s => s.client === client && s.op === p.op);
        if (scope && scope.client !== client) throw outboxError('grant-invalidated', 'cleanup');
        this.close(scope); return { ok: true, value: true };
      }
      const scope = this.owned(client, p.token);
      if (action === 'check') {
        if (!exact(p, 'token')) throw outboxError('invalid-request', 'binding');
        return { ok: true, value: { valid: true } };
      }
      if (action !== 'send' || !exact(p, 'token,tag,text') || scope.kind !== 'recipient' || scope.sent || !uuid(p.tag) || p.text !== scope.text ||
          scope.actor.runtime.ownInputs.has(p.tag)) throw outboxError('duplicate-call', 'view-send');
      if (!this.ready(scope)) throw outboxError('recipient-not-idle', 'view-send');
      await this.checkGoal(scope, 'view-send');
      if (!this.ready(scope)) throw outboxError('recipient-not-idle', 'view-send');
      wake.reserveBudget(scope.actor.s, scope.op);
      scope.sent = true; scope.tag = p.tag; scope.monitor.bind(p.tag);
      const tag = await this.workspace.sendScopedOutboxInput(scope.actor.s, scope.actor.runtime, p.text, p.tag, scope.sender, scope.rpc,
        () => this.ready(scope));
      return { ok: true, value: { tag } };
    } catch (error) {
      return { ok: false, status: 'unconfirmed', retry: false, ...classifyOutboxFailure(error, action === 'send' ? 'view-send' : 'binding',
        action === 'send' ? 'send-unconfirmed' : 'binding-unavailable') };
    }
  }
  disconnected(client) { for (const scope of [...this.scopes.values()]) if (scope.client === client) this.close(scope); }
  closeAll() { for (const scope of [...this.scopes.values()]) this.close(scope); this.workspace.off('change', this.changed); }
}
module.exports = { ScopedOutboxRuntime, CAPABILITY };
