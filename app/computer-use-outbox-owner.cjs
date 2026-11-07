// Binds the restricted UI to existing, authenticated retained transports.
// No new Workspace connection, initial snapshot, private input claim or terminal.
const { validateOutboxArgs, nativeOutboxCall, nativeOutboxReceipt, outboxError, classifyOutboxFailure } = require('./computer-use-outbox-native.cjs');
const { isMember, membershipRevision } = require('./collaboration-spaces.cjs');
const { consumeRootOutboxProof } = require('./claude-submit.cjs');
const FAIL = 'The original agent or its authorized space transport is unavailable; no resend.';
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
  return { original, member, reason() {
    try {
      const record = peer.entry.state.sessions.find(s => s.id === original.id);
      if (!available().includes(peer.context) || peer.context.client !== client || client.control !== control ||
          peer.entry.client !== entryClient || peer.entry.closed || control.maintenance.has(peer.entry.key) ||
          (control.generations.get(peer.entry.key) || 0) !== generation ||
          record?.nativeId !== original.nativeId || record.pid !== original.pid || record.provider !== original.provider ||
          record.archived || record.nativeContextPending || client.route(original.id).client !== entryClient) return unavailable;
      if (control.manualEpoch !== epoch || record.owner !== original.owner || record.controlRevision !== original.controlRevision) return 'control-changed';
      if (membershipRevision(record, spaceId) !== member) return 'membership-changed';
      if (!isMember(record, spaceId)) return 'membership-unconfirmed';
      return null;
    } catch { return unavailable; }
  } };
}
function existingTransports(contexts) {
  const available = () => [...contexts()].filter(c => !c.win.isDestroyed() && !c.client.closing && !c.client.socket.destroyed);
  function find(predicate, reason = 'recipient-unavailable', requireNative = true) {
    const found = [];
    for (const context of available()) for (const entry of context.client.entries) {
      for (const record of entry.state.sessions) if (predicate(record)) {
        const bridge = context.client.control.legacyInput, root = bridge?.target(record), native = root?.native;
        if (!requireNative || native?.connected && !native.closed && native.adapter || root?.retainedReader && !root.disposed)
          found.push({ context, entry, record, bridge, native, root });
      }
    }
    // Several windows may observe the same thread. They must agree on identity.
    if (!found.length || new Set(found.map(f => `${f.entry.key}:${f.record.id}:${f.record.nativeId}:${f.record.pid}`)).size !== 1) throw outboxError(reason, 'binding', FAIL);
    return found[0];
  }
  return { available, find };
}
async function bindOriginalOutbox(deps, identity, args, signal) {
  args = validateOutboxArgs(args);
  const transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'codex' && s.nativeId === identity.nativeId, 'caller-unavailable');
  const authority = pinAuthority(caller, transports.available, args.space_id, 'caller-unavailable');
  let selectedTarget, targetError;
  try {
    const target = transports.find(s => s.id === args.recipient_id && s.provider === 'codex', 'recipient-unavailable', false);
    selectedTarget = { target, authority: pinAuthority(target, transports.available, args.space_id, 'recipient-unavailable') };
  } catch (error) { targetError = error; }
  const runtime = caller.native?.adapter;
  if (!runtime) throw outboxError('caller-unavailable', 'binding', FAIL);
  const proof = await nativeOutboxCall(runtime, identity, args, signal);
  const reason = authority.reason();
  if (reason) throw outboxError(reason, 'binding', FAIL);
  // A caller must prove its live call before learning any recipient refusal.
  if (targetError) throw targetError;
  return bindRecipient(deps, transports, caller, proof, authority, selectedTarget);
}
function bindClaudeOutbox(deps, credential, signal) {
  let proof;
  try { proof = consumeRootOutboxProof(credential); }
  catch { throw outboxError('provenance-unconfirmed', 'binding', 'Native root outbox call could not be verified'); }
  const transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'claude' && s.nativeId === proof.target.record.nativeId, 'caller-unavailable');
  if (caller.root !== proof.target) throw outboxError('provenance-unconfirmed', 'binding', FAIL);
  const valid = proof.valid;
  proof.valid = () => !signal?.aborted && valid() && caller.bridge.target(caller.record) === caller.root;
  return bindRecipient(deps, transports, caller, proof,
    pinAuthority(caller, transports.available, proof.args.space_id, 'caller-unavailable'));
}
function bindRecipient({ roomState }, { available, find }, caller, proof, sourceAuthority, selectedTarget) {
  const spaceId = proof.args.space_id;
  // Retained alpha.2 forwarding is explicitly shared-space only. No silent
  // fallback from a requested non-default space into the default one.
  if (spaceId !== 'shared') throw outboxError('space-unavailable', 'binding', FAIL);
  const selected = selectedTarget?.target || find(s => s.id === proof.args.recipient_id && s.provider === 'codex');
  const authority = selectedTarget?.authority || pinAuthority(selected, available, spaceId, 'recipient-unavailable');
  const reason = sourceAuthority.reason() || authority.reason();
  if (reason) throw outboxError(reason, 'binding', FAIL);
  // Resolve only an already connected original transport. This integration does
  // not add managed subscription, lazy native connection or receiver preparation.
  const target = find(s => s.id === selected.record.id && s.provider === 'codex');
  if (target.context !== selected.context || target.entry !== selected.entry || target.bridge !== selected.bridge || !target.native?.adapter)
    throw outboxError('recipient-unavailable', 'binding', FAIL);
  const original = authority.original, source = sourceAuthority.original;
  const member = authority.member, sourceMember = sourceAuthority.member;
  const entryClient = target.entry.client, targetAdapter = target.native.adapter;
  const generation = target.context.client.control.generations.get(target.entry.key) || 0;
  const control = original.controlRevision, epoch = target.context.client.control.manualEpoch;
  let lastReason;
  function facts(phase = 'binding') {
    const record = target.entry.state.sessions.find(s => s.id === original.id);
    const sender = caller.entry.state.sessions.find(s => s.id === source.id);
    const client = target.context.client;
    try { roomState.assertAvailable(original.id, true, spaceId); roomState.assertAvailable(source.id, true, spaceId); }
    catch { lastReason = 'space-unavailable'; throw outboxError(lastReason, phase, FAIL); }
    const originValid = proof.valid();
    const pinnedReason = sourceAuthority.reason() || authority.reason();
    const callerValid = originValid && !pinnedReason && available().includes(caller.context) && caller.entry.client === caller.context.client.route(source.id).client &&
      sender?.nativeId === source.nativeId && sender.pid === source.pid && !sender.nativeContextPending && !sender.archived && isMember(sender, spaceId) && membershipRevision(sender, spaceId) === sourceMember;
    const stable = callerValid && available().includes(target.context) && target.entry.client === entryClient &&
      !target.entry.closed && !client.control.maintenance.has(target.entry.key) && (client.control.generations.get(target.entry.key) || 0) === generation &&
      client.control.manualEpoch === epoch && record?.nativeId === original.nativeId && record.pid === original.pid &&
      typeof original.owner === 'string' && original.owner.length > 0 && record.owner === original.owner &&
      record.controlRevision === control && !record.archived && !record.nativeContextPending &&
      isMember(record, spaceId) && membershipRevision(record, spaceId) === member && target.bridge.target(record)?.native === target.native &&
      target.native.connected && !target.native.closed && target.native.adapter === targetAdapter;
    const ready = stable && target.native.state === 'idle' && !target.native.pending && !target.native.approval && !target.native.nativeInputRequired &&
      !record.approval && !record.nativeApproval && !record.pendingQueue && !record.pendingSteer && !record.interruptPending &&
      !target.entry.state.room?.run?.status?.includes('running') && !target.entry.state.room?.run?.pausePending && !target.entry.state.room?.run?.pauseUnconfirmed &&
      !target.entry.state.peerLeases?.some(g => g.status === 'running');
    // Classify only the guards just observed, never a private error string.
    // These codes do not assert whether a prior native send happened.
    lastReason = null;
    if (!ready) {
      if (!originValid) lastReason = 'provenance-unconfirmed';
      else if (pinnedReason) lastReason = pinnedReason;
      else if (sender && membershipRevision(sender, spaceId) !== sourceMember || record && membershipRevision(record, spaceId) !== member) lastReason = 'membership-changed';
      else if (sender && !isMember(sender, spaceId) || record && !isMember(record, spaceId)) lastReason = 'membership-unconfirmed';
      else if (record && (client.control.manualEpoch !== epoch || record.owner !== original.owner || record.controlRevision !== control)) lastReason = 'control-changed';
      else if (typeof original.owner !== 'string' || !original.owner) lastReason = 'control-unconfirmed';
      else lastReason = !callerValid ? 'caller-unavailable' : !stable ? 'recipient-unavailable' : 'recipient-not-idle';
    }
    return { callerValid: Boolean(callerValid && stable), callerId: source.id, callerNativeId: source.nativeId,
      nativeId: original.nativeId, memberRevision: member, ready: Boolean(ready) };
  }
  if (!facts().ready || source.id === original.id) throw outboxError(lastReason || 'recipient-unavailable', 'binding', FAIL);
  const monitor = nativeOutboxReceipt(targetAdapter, original.nativeId);
  return { grant: { callerId: source.id, callerNativeId: source.nativeId, spaceId, recipientId: original.id,
      recipientName: original.name, nativeId: original.nativeId, memberRevision: member, text: proof.args.message },
    inspectGrant: facts,
    async forwardOnce() {
      if (!facts('view-send').ready) throw outboxError(lastReason || 'recipient-unavailable', 'view-send', FAIL);
      const valid = () => { try { return facts('view-send').ready; } catch { return false; } };
      // Existing LegacyInput owns the recorded shared message and native tag.
      // Source attribution is held by the live native call, never by model args.
      let tag;
      try {
        tag = await target.bridge.send(original, proof.args.message, async () => { if (!valid()) throw outboxError(lastReason || 'send-unconfirmed', 'view-send', FAIL); }, valid,
          true, undefined, undefined, false, undefined,
          () => proof.valid() ? { id: source.id, nativeId: source.nativeId, name: source.name } : null);
      } catch (error) {
        const detail = classifyOutboxFailure(error, 'view-send', lastReason || 'send-unconfirmed');
        throw outboxError(detail.failureReason, detail.failurePhase, FAIL);
      }
      monitor.bind(tag); return tag;
    },
    watchReceipt(scope, listener) {
      return monitor.subscribe(value => listener({ ...value, messageId: scope.messageId, recipientId: original.id }));
    }, close: () => monitor.close() };
}
module.exports = { bindOriginalOutbox, bindClaudeOutbox };
