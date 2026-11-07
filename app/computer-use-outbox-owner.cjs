// Binds the restricted UI to existing, authenticated retained transports.
// No new Workspace connection, initial snapshot, private input claim or terminal.
const { nativeOutboxCall, nativeOutboxReceipt } = require('./computer-use-outbox-native.cjs');
const { isMember, membershipRevision } = require('./collaboration-spaces.cjs');
const { consumeRootOutboxProof } = require('./claude-submit.cjs');
const FAIL = 'The original agent or its authorized space transport is unavailable; no resend.';
function existingTransports(contexts) {
  const available = () => [...contexts()].filter(c => !c.win.isDestroyed() && !c.client.closing && !c.client.socket.destroyed);
  function find(predicate, ownerRequired = false) {
    const found = [];
    for (const context of available()) for (const entry of context.client.entries) {
      for (const record of entry.state.sessions) if (predicate(record) && (!ownerRequired || record.owner === context.view.owner)) {
        const bridge = context.client.control.legacyInput, root = bridge?.target(record), native = root?.native;
        if (native?.connected && !native.closed && native.adapter || root?.retainedReader && !root.disposed)
          found.push({ context, entry, record, bridge, native, root });
      }
    }
    // Several windows may observe the same thread. They must agree on identity.
    if (!found.length || new Set(found.map(f => `${f.entry.key}:${f.record.id}:${f.record.nativeId}:${f.record.pid}`)).size !== 1) throw Error(FAIL);
    return found[0];
  }
  return { available, find };
}
async function bindOriginalOutbox(deps, identity, args, signal) {
  const transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'codex' && s.nativeId === identity.nativeId);
  const runtime = caller.native.adapter;
  const proof = await nativeOutboxCall(runtime, identity, args, signal);
  return bindRecipient(deps, transports, caller, proof);
}
function bindClaudeOutbox(deps, credential, signal) {
  const proof = consumeRootOutboxProof(credential), transports = existingTransports(deps.contexts);
  const caller = transports.find(s => s.provider === 'claude' && s.nativeId === proof.target.record.nativeId);
  if (caller.root !== proof.target) throw Error(FAIL);
  const valid = proof.valid;
  proof.valid = () => !signal?.aborted && valid() && caller.bridge.target(caller.record) === caller.root;
  return bindRecipient(deps, transports, caller, proof);
}
function bindRecipient({ roomState }, { available, find }, caller, proof) {
  const spaceId = proof.args.space_id;
  // Retained alpha.2 forwarding is explicitly shared-space only. No silent
  // fallback from a requested non-default space into the default one.
  if (spaceId !== 'shared') throw Error(FAIL);
  const target = find(s => s.id === proof.args.recipient_id && s.provider === 'codex', true);
  const original = { ...target.record }, source = { ...caller.record };
  const member = membershipRevision(original, spaceId), sourceMember = membershipRevision(source, spaceId);
  const entryClient = target.entry.client, targetAdapter = target.native.adapter;
  const generation = target.context.client.control.generations.get(target.entry.key) || 0;
  const control = original.controlRevision, epoch = target.context.client.control.manualEpoch;
  function facts() {
    const record = target.entry.state.sessions.find(s => s.id === original.id);
    const sender = caller.entry.state.sessions.find(s => s.id === source.id);
    const client = target.context.client;
    roomState.assertAvailable(original.id, true, spaceId); roomState.assertAvailable(source.id, true, spaceId);
    const callerValid = proof.valid() && available().includes(caller.context) && caller.entry.client === caller.context.client.route(source.id).client &&
      sender?.nativeId === source.nativeId && sender.pid === source.pid && !sender.nativeContextPending && !sender.archived && isMember(sender, spaceId) && membershipRevision(sender, spaceId) === sourceMember;
    const stable = callerValid && available().includes(target.context) && target.entry.client === entryClient &&
      !target.entry.closed && !client.control.maintenance.has(target.entry.key) && (client.control.generations.get(target.entry.key) || 0) === generation &&
      client.control.manualEpoch === epoch && record?.nativeId === original.nativeId && record.pid === original.pid &&
      record.owner === target.context.view.owner && record.controlRevision === control && !record.archived && !record.nativeContextPending &&
      isMember(record, spaceId) && membershipRevision(record, spaceId) === member && target.bridge.target(record)?.native === target.native &&
      target.native.connected && !target.native.closed && target.native.adapter === targetAdapter;
    const ready = stable && target.native.state === 'idle' && !target.native.pending && !target.native.approval && !target.native.nativeInputRequired &&
      !record.approval && !record.nativeApproval && !record.pendingQueue && !record.pendingSteer && !record.interruptPending &&
      !target.entry.state.room?.run?.status?.includes('running') && !target.entry.state.room?.run?.pausePending && !target.entry.state.room?.run?.pauseUnconfirmed &&
      !target.entry.state.peerLeases?.some(g => g.status === 'running');
    return { callerValid: Boolean(callerValid && stable), callerId: source.id, callerNativeId: source.nativeId,
      nativeId: original.nativeId, memberRevision: member, ready: Boolean(ready) };
  }
  if (!facts().ready || source.id === original.id) throw Error(FAIL);
  const monitor = nativeOutboxReceipt(targetAdapter, original.nativeId);
  return { grant: { callerId: source.id, callerNativeId: source.nativeId, spaceId, recipientId: original.id,
      recipientName: original.name, nativeId: original.nativeId, memberRevision: member, text: proof.args.message },
    inspectGrant: facts,
    async forwardOnce() {
      if (!facts().ready) throw Error(FAIL);
      const valid = () => { try { return facts().ready; } catch { return false; } };
      // Existing LegacyInput owns the recorded shared message and native tag.
      // Source attribution is held by the live native call, never by model args.
      const tag = await target.bridge.send(original, proof.args.message, async () => { if (!valid()) throw Error(FAIL); }, valid,
        true, undefined, undefined, false, undefined,
        () => proof.valid() ? { id: source.id, nativeId: source.nativeId, name: source.name } : null);
      monitor.bind(tag); return tag;
    },
    watchReceipt(scope, listener) {
      return monitor.subscribe(value => listener({ ...value, messageId: scope.messageId, recipientId: original.id }));
    }, close: () => monitor.close() };
}
module.exports = { bindOriginalOutbox, bindClaudeOutbox };
