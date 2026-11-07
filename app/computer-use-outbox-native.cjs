// Native provenance, never display-journal guesses or terminal inspection.
const FAIL = 'The original native outbox call could not be verified; no resend.';
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
function validateOutboxArgs(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !['recipient_id', 'message', 'space_id'].includes(k)) ||
      !token(value.recipient_id) || value.space_id !== undefined && !token(value.space_id) ||
      typeof value.message !== 'string' || !value.message.trim() || value.message.length > 16000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.message)) throw Error(FAIL);
  return { recipient_id: value.recipient_id, message: value.message, space_id: value.space_id || 'shared' };
}
async function nativeOutboxCall(runtime, identity, arguments_, signal) {
  const args = validateOutboxArgs(arguments_);
  if (!identity || !['nativeId', 'sessionId', 'turnId', 'callId'].every(k => token(identity[k]))) throw Error(FAIL);
  const rpc = runtime?.host?.rpc, lifecycle = runtime?.lifecycleRevision;
  let proof;
  const valid = () => {
    if (signal?.aborted || !rpc || runtime.stopped || runtime.transportDisconnected || runtime.record.nativeContextPending ||
        runtime.host.rpc !== rpc || runtime.lifecycleRevision !== lifecycle || runtime.record.nativeId !== identity.nativeId ||
        runtime.nativeSessionId !== identity.sessionId || runtime.turnId !== identity.turnId) return false;
    const call = runtime.outboxMcpCalls?.get(identity.callId);
    if (!call || call.turnId !== identity.turnId || call.rpc !== rpc || call.lifecycle !== lifecycle ||
        call.arguments?.recipient_id !== args.recipient_id || call.arguments?.message !== args.message ||
        (call.arguments?.space_id || 'shared') !== args.space_id || proof && call !== proof) return false;
    return call;
  };
  const first = valid();
  if (first) proof = first;
  else await new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); runtime?.off('outboxMcpProof', observed); runtime?.off('nativeTurnEnd', ended); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
    const observed = () => { const value = valid(); if (value) { proof = value; finish(); } };
    const ended = info => { if (info.turnId === identity.turnId) finish(Error(FAIL)); };
    const aborted = () => finish(Error(FAIL));
    const timer = setTimeout(aborted, 3000);
    if (!runtime || signal?.aborted) { aborted(); return; }
    runtime.on('outboxMcpProof', observed); runtime.on('nativeTurnEnd', ended); signal?.addEventListener('abort', aborted, { once: true }); observed();
  });
  if (!valid() || proof.outboxConsumed) throw Error(FAIL);
  // A repeated RPC for this still-active native call is not a second send.
  // Mark before opening any UI or awaiting its first action.
  proof.outboxConsumed = true;
  return { args, valid: () => Boolean(valid()) };
}
// Subscribe before forwarding: the native input can precede the forward ACK.
// Only the eventually returned tag is projected, without any command output.
function nativeOutboxReceipt(runtime, nativeId) {
  const rpc = runtime.host.rpc, lifecycle = runtime.lifecycleRevision, candidates = new Map(), listeners = new Set();
  let tag, closed = false;
  const current = () => !closed && !runtime.stopped && !runtime.transportDisconnected && runtime.host.rpc === rpc &&
    runtime.lifecycleRevision === lifecycle && runtime.record.nativeId === nativeId;
  const snapshot = () => {
    const record = current() && candidates.get(tag);
    return record ? { ...record, nativeId, inputTag: tag, nativeReceived: true, source: 'codex-native' } : null;
  };
  const publish = () => { const value = snapshot(); if (value) for (const listener of listeners) listener(value); };
  const accepted = () => {
    const input = runtime.nativeAcceptedInput;
    if (!current() || input?.rpc !== rpc || input.lifecycle !== lifecycle || !token(input.tag) || !token(input.turnId) ||
        !runtime.ownInputs.has(input.tag) || candidates.size >= 8 && !candidates.has(input.tag)) return;
    if (!candidates.has(input.tag)) candidates.set(input.tag, { turnId: input.turnId });
    publish();
  };
  const command = item => {
    if (!current() || item?.source !== 'codex-native' || item.kind !== 'commandExecution' || !token(item.id)) return;
    const record = candidates.get(item.inputTag);
    if (!record || record.turnId !== item.turnId || record.firstCommand || typeof item.input !== 'string' || !item.input || item.input.length > 4096) return;
    record.firstCommand = { kind: 'commandExecution', id: item.id, command: item.input, inputTag: item.inputTag, turnId: item.turnId };
    publish();
  };
  runtime.on('nativeAcceptedInput', accepted); runtime.on('progress', command);
  return { bind(messageId) { if (!token(messageId) || tag) throw Error(FAIL); tag = messageId; publish(); },
    subscribe(listener) { listeners.add(listener); const value = snapshot(); if (value) listener(value); return () => listeners.delete(listener); },
    close() { closed = true; listeners.clear(); candidates.clear(); runtime.off('nativeAcceptedInput', accepted); runtime.off('progress', command); } };
}
module.exports = { validateOutboxArgs, nativeOutboxCall, nativeOutboxReceipt };
