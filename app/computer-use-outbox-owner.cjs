// Binds the restricted UI to existing, authenticated retained transports.
// No new Workspace connection, initial snapshot, private input claim or terminal.
const { validateOutboxArgs, nativeOutboxCall, nativeOutboxReceipt, outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');
const { isMember, membershipRevision } = require('./collaboration-spaces.cjs');
const { consumeRootOutboxProof } = require('./claude-submit.cjs');
const { identity: sharedInputIdentity } = require('./peer-handoffs.cjs');
const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const wake = require('./session-wake.cjs');
const { supported: managedOutbox, openManagedCall } = require('./managed-outbox-transport.cjs');
const FAIL = 'The original agent or its authorized space transport is unavailable; no resend.';
// A backend with native wake accounting must own every automatic input. Never
// fall back to a GUI ledger while that backend still runs an older producer.
function requiresManagedWake(entry, record) {
  return entry.state.capabilities?.includes('agentWakeV1') ||
    Object.hasOwn(record, 'wakeBudget') || Object.hasOwn(record, 'wakeHumanRevision');
}

function outboxRecord(record) {
  const result = {};
  for (const key of ['id', 'nativeId', 'pid', 'provider', 'name', 'owner', 'controlRevision', 'archived', 'nativeContextPending',
    'roomId', 'roomIds', 'memberRevision', 'roomMembershipRevisions'])
    if (Object.hasOwn(record, key)) result[key] = record[key];
  return result;
}
// Pin the existing control facts before any native proof or connection await.
// Reusing facts after an await must not silently authorize a newer owner.
function pinAuthority(peer, available, spaceId, unavailable) {
  const original = outboxRecord(peer.record), client = peer.context.client, control = client.control;
  const entryClient = peer.entry.client, generation = control.generations.get(peer.entry.key) || 0, epoch = control.manualEpoch;
  let member;
  try { member = membershipRevision(original, spaceId); }
  catch { throw outboxError('membership-unconfirmed', 'binding', FAIL); }
  const inputIdentity = sharedInputIdentity(peer.record);
  return { original, member, inputIdentity, reason() {
    try {
      const record = peer.entry.state.sessions.find(s => s.id === original.id);
      if (!available().includes(peer.context) || peer.context.client !== client || client.control !== control ||
          peer.entry.client !== entryClient || peer.entry.closed || peer.entry.closing || entryClient.socket?.destroyed || control.maintenance.has(peer.entry.key) ||
          (control.generations.get(peer.entry.key) || 0) !== generation ||
          record?.nativeId !== original.nativeId || record.pid !== original.pid || record.provider !== original.provider ||
          record.archived || record.nativeContextPending || client.route(original.id).client !== entryClient) return unavailable;
      if (control.manualEpoch !== epoch || record.owner !== original.owner || record.controlRevision !== original.controlRevision) return 'control-changed';
      if (membershipRevision(record, spaceId) !== member) return 'membership-changed';
      if (!isMember(record, spaceId)) return 'membership-unconfirmed';
      if (!isDeepStrictEqual(sharedInputIdentity(record), inputIdentity)) return 'control-changed';
      return null;
    } catch { return unavailable; }
  } };
}
function existingTransports(contexts) {
  const available = () => [...contexts()].filter(c => !c.win.isDestroyed() && !c.client.closing &&
    (!c.client.socket.destroyed || c.client.entries.some(e => e.closed || e.client.socket?.destroyed)));
  function select(found, reason, requireNative = false) {
    // Count conflicting identities before discarding dead transports.
    const unique = new Set(found.map(f => `${f.entry.key}:${f.record.id}:${f.record.nativeId}:${f.record.pid}`));
    if (unique.size !== 1) throw outboxError(reason, 'binding', FAIL);
    const live = found.find(f => !f.entry.closed && !f.entry.closing && !f.entry.client.socket?.destroyed &&
      (!requireNative || f.native?.connected && !f.native.closed && (f.native.adapter || f.root.managed) || f.root?.retainedReader && !f.root.disposed));
    if (!live) throw outboxError(reason, 'binding', FAIL);
    return live;
  }
  function find(predicate, reason = 'recipient-unavailable', requireNative = true) {
    const found = [];
    for (const context of available()) for (const entry of context.client.entries) {
      for (const record of entry.state.sessions) if (predicate(record)) {
        const bridge = context.client.control.legacyInput, root = bridge?.outboxTarget?.(record) || bridge?.target(record), native = root?.native;
        found.push({ context, entry, record, bridge, native, root });
      }
    }
    // Several windows may observe the same thread. They must agree on identity.
    return select(found, reason, requireNative);
  }
  async function prepareRecipient(id, spaceId, source, grant) {
    const found = [];
    for (const context of available()) for (const entry of context.client.entries) for (const record of entry.state.sessions)
      if (record.id === id && record.provider === 'codex') found.push({ context, entry, record });
    const { context, entry, record } = select(found, 'recipient-unavailable'), bridge = context.client.control.legacyInput;
    if (!isMember(record, spaceId) || !isMember(source, spaceId)) throw outboxError('membership-unconfirmed', 'binding', FAIL);
    if (entry.state.wakePolicy?.enabled !== true) throw outboxError('wake-policy-unavailable', 'binding', FAIL);
    if (requiresManagedWake(entry, record) && !managedOutbox(entry)) throw outboxError('wake-policy-unavailable', 'binding', FAIL);
    if (record.wakeDisabled) throw outboxError('recipient-not-idle', 'binding', FAIL);
    const root = bridge?.outboxTarget?.(record) || bridge?.target(record);
    if (managedOutbox(entry) || !root?.native?.connected || root.native.closed) {
      if (record.state !== 'idle' || record.archived || record.nativeContextPending || !record.owner || record.approval ||
          record.nativeApproval || record.pendingQueue || record.pendingSteer || record.interruptPending || record.pendingTag)
        throw outboxError('recipient-not-idle', 'binding', FAIL);
      try { return { bridge, record, target: await bridge.prepareOutbox(entry, record, grant) }; }
      catch (error) {
        const detail = classifyOutboxFailure(error, 'binding', 'recipient-unavailable');
        throw outboxError(detail.failureReason, detail.failurePhase, FAIL, detail.cleanupUnconfirmed, detail.failureCheck);
      }
    }
  }
  return { available, find, prepareRecipient };
}
async function bindOriginalOutbox(deps, identity, args, signal) {
  args = validateOutboxArgs(args);
  const transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'codex' && s.nativeId === identity.nativeId, 'caller-unavailable', false);
  const authority = pinAuthority(caller, transports.available, args.space_id, 'caller-unavailable');
  let selectedTarget, targetError;
  try {
    const target = transports.find(s => s.id === args.recipient_id && s.provider === 'codex', 'recipient-unavailable', false);
    selectedTarget = { target, authority: pinAuthority(target, transports.available, args.space_id, 'recipient-unavailable') };
  } catch (error) { targetError = error; }
  let proof;
  try {
    if (managedOutbox(caller.entry)) proof = await openManagedCall(caller.entry, caller.record, identity, args, signal);
    else {
      const runtime = caller.native?.adapter;
      if (!runtime) throw outboxError('caller-unavailable', 'binding', FAIL);
      proof = await nativeOutboxCall(runtime, identity, args, signal);
    }
    proof.signal = signal;
    const reason = authority.reason();
    if (reason) throw outboxError(reason, 'binding', FAIL);
    // A caller must prove its live call before learning any recipient refusal.
    if (targetError) throw targetError;
    return await bindRecipient(deps, transports, caller, proof, authority, selectedTarget);
  } catch (error) {
    try { await proof?.close?.(); } catch {
      const detail = classifyOutboxFailure(error, 'binding', 'binding-unavailable');
      throw outboxError(detail.failureReason, detail.failurePhase, FAIL, true, detail.failureCheck);
    }
    throw error;
  }
}
async function bindOriginalControl(deps, identity, args, signal) {
  args = require('./background-control.cjs').validate(args);
  const transports = existingTransports(deps.contexts);
  const provider = identity.provider === 'claude' ? 'claude' : 'codex';
  const caller = transports.find(s => s.provider === provider && s.nativeId === identity.nativeId, 'caller-unavailable', false);
  const proof = await openManagedCall(caller.entry, caller.record, identity, args, signal, true);
  return { ...proof, identity: { ...identity } };
}
async function bindClaudeControl(deps, credential, signal) {
  const proof = require('./background-control-native.cjs').consumeCredential(credential);
  const transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'claude' && s.nativeId === proof.identity.nativeId, 'caller-unavailable');
  if (caller.root !== proof.target) throw Error('Native control root changed');
  return { args: proof.args, identity: proof.identity,
    sender: { id: caller.record.id, nativeId: caller.record.nativeId, provider: 'claude', name: caller.record.name || 'Agent' },
    valid: () => !signal?.aborted && proof.valid() && caller.bridge.target(caller.record) === caller.root };
}
function bindClaudeOutbox(deps, credential, signal) {
  let proof;
  try { proof = consumeRootOutboxProof(credential); }
  catch (error) { const detail = classifyOutboxFailure(error, 'binding', 'provenance-unconfirmed');
    throw outboxError(detail.failureReason, detail.failurePhase, 'Native root outbox call could not be verified', detail.cleanupUnconfirmed === true, detail.failureCheck); }
  const transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'claude' && s.nativeId === proof.target.record.nativeId, 'caller-unavailable');
  if (caller.root !== proof.target) throw outboxError('provenance-unconfirmed', 'binding', FAIL);
  const valid = proof.valid;
  proof.valid = () => !signal?.aborted && valid() && caller.bridge.target(caller.record) === caller.root;
  return bindRecipient(deps, transports, caller, proof,
    pinAuthority(caller, transports.available, proof.args.space_id, 'caller-unavailable'));
}
async function bindRecipient({ roomState }, { available, find, prepareRecipient }, caller, proof, sourceAuthority, selectedTarget) {
  const spaceId = proof.args.space_id;
  // Retained alpha.2 forwarding is explicitly shared-space only. No silent
  // fallback from a requested non-default space into the default one.
  if (spaceId !== 'shared') throw outboxError('space-unavailable', 'binding', FAIL);
  if (!proof.valid()) throw outboxError('provenance-unconfirmed', 'binding', FAIL);
  try { roomState.assertAvailable(proof.args.recipient_id, true, spaceId); roomState.assertAvailable(caller.record.id, true, spaceId); }
  catch { throw outboxError('space-unavailable', 'binding', FAIL); }
  const target = selectedTarget?.target || find(s => s.id === proof.args.recipient_id && s.provider === 'codex', 'recipient-unavailable', false);
  const authority = selectedTarget?.authority || pinAuthority(target, available, spaceId, 'recipient-unavailable');
  const reason = sourceAuthority.reason() || authority.reason();
  if (reason) throw outboxError(reason, 'binding', FAIL);
  const original = authority.original, source = sourceAuthority.original;
  const member = authority.member;
  const sender = proof.sender || { id: source.id, nativeId: source.nativeId, provider: source.provider, name: source.name };
  const prepared = await prepareRecipient(proof.args.recipient_id, spaceId, caller.record, { text: proof.args.message, sender, signal: proof.signal,
    expected: { ...authority.inputIdentity, pid: original.pid } });
  try {
  const resolved = find(s => s.id === original.id && s.provider === 'codex');
  if (resolved.context !== target.context || resolved.entry !== target.entry || resolved.bridge !== target.bridge)
    throw outboxError('recipient-unavailable', 'binding', FAIL);
  target.native = resolved.native; target.root = resolved.root;
  if (!target.native?.adapter && !target.root?.managed) throw outboxError('recipient-unavailable', 'binding', FAIL);
  const targetAdapter = target.native.adapter;
  const wakeId = randomUUID();
  // Retained transports have no service-side scoped sender. Persist their
  // reservation on the existing shared input row, before its native write.
  function budgetState(record) {
    const row = target.bridge.records.findLast(row => row.sessionId === original.id && row.nativeId === original.nativeId && row.agentWakeBudget);
    return { wakeHumanRevision: record.wakeHumanRevision || 0, wakeBudget: row?.agentWakeBudget || record.wakeBudget };
  }
  async function checkGoal(phase) {
    if (target.root.managed) return; // The original service checks its held RPC.
    let status;
    try { status = await wake.nativeGoalStatus(original, targetAdapter, () => facts(phase).ready); }
    catch { throw outboxError('native-goal-unconfirmed', phase, FAIL); }
    if (!wake.goalAllows(status)) throw outboxError('native-goal-disallows', phase, FAIL);
  }
  let lastReason;
  function facts(phase = 'binding') {
    const record = target.entry.state.sessions.find(s => s.id === original.id);
    const sender = caller.entry.state.sessions.find(s => s.id === source.id);
    try { roomState.assertAvailable(original.id, true, spaceId); roomState.assertAvailable(source.id, true, spaceId); }
    catch { lastReason = 'space-unavailable'; throw outboxError(lastReason, phase, FAIL); }
    const originValid = proof.valid();
    const callerReason = sourceAuthority.reason(), targetReason = authority.reason();
    const callerValid = originValid && !callerReason;
    const stable = callerValid && !targetReason &&
      typeof original.owner === 'string' && original.owner.length > 0 && record.owner === original.owner &&
      (target.bridge.outboxTarget?.(record) || target.bridge.target(record))?.native === target.native &&
      target.native.connected && !target.native.closed && (target.root.managed || target.native.adapter === targetAdapter);
    const policyReady = target.entry.state.wakePolicy?.enabled === true &&
      (target.root.managed || !requiresManagedWake(target.entry, record));
    const budgetReady = target.root.managed || wake.budgetAllows(budgetState(record), wakeId, source.id, source.nativeId);
    const ready = stable && policyReady && budgetReady && !record.wakeDisabled && target.native.state === 'idle' && !target.native.pending && !target.native.approval && !target.native.nativeInputRequired &&
      !record.approval && !record.nativeApproval && !record.pendingQueue && !record.pendingSteer && !record.interruptPending &&
      !target.entry.state.room?.run?.status?.includes('running') && !target.entry.state.room?.run?.pausePending && !target.entry.state.room?.run?.pauseUnconfirmed &&
      !target.entry.state.peerLeases?.some(g => g.status === 'running');
    // Classify only the guards just observed, never a private error string.
    // These codes do not assert whether a prior native send happened.
    lastReason = null;
    if (!ready) {
      if (!originValid) lastReason = 'provenance-unconfirmed';
      else if (callerReason || targetReason) lastReason = callerReason || targetReason;
      else if (typeof original.owner !== 'string' || !original.owner) lastReason = 'control-unconfirmed';
      else if (!policyReady) lastReason = 'wake-policy-unavailable';
      else if (!budgetReady) lastReason = 'wake-limited';
      else lastReason = !callerValid ? 'caller-unavailable' : !stable ? 'recipient-unavailable' : 'recipient-not-idle';
    }
    return { callerValid: Boolean(callerValid && stable), callerId: source.id, callerNativeId: source.nativeId,
      nativeId: original.nativeId, memberRevision: member, ready: Boolean(ready) };
  }
  if (!facts().ready || source.id === original.id) throw outboxError(lastReason || 'recipient-unavailable', 'binding', FAIL);
  await checkGoal('binding');
  // Local LegacyCodex sends and observes on host.rpc; keep its first started item,
  // including when a later command completes first or the first cannot be exposed.
  const monitor = target.root.managed ? target.root.monitor :
    nativeOutboxReceipt(targetAdapter, original.nativeId, { rpc: targetAdapter.host.rpc, scoped: true });
  return { grant: { callerId: source.id, callerNativeId: source.nativeId, spaceId, recipientId: original.id,
      recipientName: original.name, nativeId: original.nativeId, memberRevision: member, text: proof.args.message },
    inspectGrant: facts,
    async forwardOnce() {
      if (proof.refresh) await proof.refresh();
      if (!facts('view-send').ready) throw outboxError(lastReason || 'recipient-unavailable', 'view-send', FAIL);
      const valid = () => { try { return facts('view-send').ready; } catch { return false; } };
      // Existing LegacyInput owns the recorded shared message and native tag.
      // Source attribution is held by the live native call, never by model args.
      let tag;
      try {
        tag = await target.bridge.send(original, proof.args.message, async () => { await checkGoal('view-send'); if (!valid()) throw outboxError(lastReason || 'send-unconfirmed', 'view-send', FAIL); }, valid,
          true, undefined, undefined, false, undefined,
          () => {
            if (!proof.valid() || !valid()) return null;
            const sender = { id: source.id, nativeId: source.nativeId, name: source.name };
            if (!target.root.managed) sender.agentWakeBudget = wake.reserveBudget(
              budgetState(target.entry.state.sessions.find(s => s.id === original.id)), wakeId, source.id, source.nativeId);
            return sender;
          });
      } catch (error) {
        const detail = classifyOutboxFailure(error, 'view-send', lastReason || 'send-unconfirmed');
        throw outboxError(detail.failureReason, detail.failurePhase, FAIL, false, detail.failureCheck);
      }
      monitor.bind(tag); return tag;
    },
    watchReceipt(scope, listener) {
      return monitor.subscribe(value => listener({ ...value, messageId: scope.messageId, recipientId: original.id }));
    }, async close() { monitor.close();
      const results = await Promise.allSettled([target.bridge.releaseOutbox?.(original, target.root), proof.close?.()]);
      if (results.some(result => result.status === 'rejected')) throw outboxError('cleanup-unconfirmed', 'cleanup', FAIL, true);
    } };
  } catch (error) {
    try { await prepared?.bridge.releaseOutbox?.(prepared.record, prepared.target); }
    catch {
      const detail = classifyOutboxFailure(error, 'binding', 'binding-unavailable');
      throw outboxError(detail.failureReason, detail.failurePhase, FAIL, true, detail.failureCheck);
    }
    throw error;
  }
}
module.exports = { bindOriginalOutbox, bindClaudeOutbox, bindOriginalControl, bindClaudeControl };
