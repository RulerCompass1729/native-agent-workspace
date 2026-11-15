// Native provenance, never display-journal guesses or terminal inspection.
const FAIL = 'The original native outbox call could not be verified; no resend.';
// Process-local tags only. Error messages, model arguments and enumerable
// error properties never become diagnostics in the native tool's receipt.
const failures = new WeakMap();
const rootChecks = new Set(require('./native-root-proof.cjs').FAILURE_CHECKS);
const phases = new Set(['admission', 'binding', 'view-open', 'lease', 'view-snapshot', 'view-send', 'native-receipt', 'receipt-render', 'cleanup']);
const reasons = new Set(['invalid-request', 'cancelled', 'owner-closed', 'busy', 'binding-unavailable',
  'provenance-unconfirmed', 'duplicate-call', 'native-call-missing', 'native-call-invalidated',
  'native-call-identity-mismatch', 'native-call-arguments-mismatch', 'turn-metadata-unconfirmed', 'caller-unavailable', 'recipient-unavailable',
  'recipient-not-idle', 'native-goal-unconfirmed', 'native-goal-disallows', 'wake-policy-unavailable', 'wake-limited', 'membership-changed', 'membership-unconfirmed', 'control-changed', 'control-unconfirmed', 'space-unavailable', 'view-unavailable', 'lease-unavailable',
  'snapshot-unavailable', 'ambiguous-target', 'grant-invalidated', 'send-unconfirmed', 'receipt-unconfirmed',
  'command-unconfirmed', 'command-failed', 'render-unconfirmed', 'cleanup-unconfirmed', 'operation-unconfirmed']);
function outboxError(reason, phase, message = FAIL, cleanupUnconfirmed = false, failureCheck) {
  const error = new Error(message);
  failures.set(error, { failurePhase: phases.has(phase) ? phase : 'binding',
    failureReason: reasons.has(reason) ? reason : 'operation-unconfirmed', ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}), ...(rootChecks.has(failureCheck) ? { failureCheck } : {}) });
  return error;
}
function classifyOutboxFailure(error, phase, reason) {
  return { ...(error && failures.get(error) || { failurePhase: phases.has(phase) ? phase : 'binding',
    failureReason: reasons.has(reason) ? reason : 'operation-unconfirmed' }) };
}
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
function validateOutboxArgs(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !['recipient_id', 'message', 'space_id'].includes(k)) ||
      !token(value.recipient_id) || value.space_id !== undefined && !token(value.space_id) ||
      typeof value.message !== 'string' || !value.message.trim() || value.message.length > 16000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.message)) throw outboxError('invalid-request', 'binding');
  return { recipient_id: value.recipient_id, message: value.message, space_id: value.space_id || 'shared' };
}
async function nativeOutboxCall(runtime, identity, arguments_, signal, control = false) {
  const args = control ? require('./background-control.cjs').validate(arguments_) : validateOutboxArgs(arguments_);
  const calls = control ? 'backgroundMcpCalls' : 'outboxMcpCalls', event = control ? 'backgroundMcpProof' : 'outboxMcpProof';
  if (!identity || !['nativeId', 'sessionId', 'turnId', 'callId'].every(k => token(identity[k]))) throw outboxError('provenance-unconfirmed', 'binding');
  const hostRpc = runtime?.host?.rpc, lifecycle = runtime?.lifecycleRevision;
  let rpc;
  let proof, metadataVerified = false;
  const candidate = () => {
    if (signal?.aborted || !hostRpc || runtime.stopped || runtime.transportDisconnected || runtime.record.nativeContextPending ||
        runtime.host.rpc !== hostRpc || runtime.lifecycleRevision !== lifecycle || runtime.record.nativeId !== identity.nativeId ||
        runtime.nativeSessionId !== identity.sessionId || runtime.turnId != null && runtime.turnId !== identity.turnId ||
        runtime.turns?.get(identity.turnId)?.completed || runtime.turnId == null && runtime.latestState !== 'working') return false;
    const call = runtime[calls]?.get(identity.callId);
    if (!call || !(runtime.currentRpc ? runtime.currentRpc(call.rpc) : call.rpc === hostRpc) ||
        rpc && call.rpc !== rpc || call.turnId !== identity.turnId || call.lifecycle !== lifecycle ||
        (control ? !require('node:util').isDeepStrictEqual(call.arguments, args) :
          call.arguments?.recipient_id !== args.recipient_id || call.arguments?.message !== args.message ||
          (call.arguments?.space_id || 'shared') !== args.space_id) || proof && call !== proof) return false;
    rpc ||= call.rpc;
    return call;
  };
  const valid = () => candidate() && (runtime.turnId === identity.turnId || metadataVerified);
  const first = candidate();
  if (first) proof = first;
  else await new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); runtime?.off(event, observed); runtime?.off('nativeTurnEnd', ended); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
    const observed = () => { const value = candidate(); if (value) { proof = value; finish(); } };
    const ended = info => { if (info.turnId === identity.turnId) finish(outboxError('provenance-unconfirmed', 'binding')); };
    const aborted = () => finish(outboxError('provenance-unconfirmed', 'binding'));
    const timer = setTimeout(aborted, 3000);
    if (!runtime || signal?.aborted) { aborted(); return; }
    runtime.on(event, observed); runtime.on('nativeTurnEnd', ended); signal?.addEventListener('abort', aborted, { once: true }); observed();
  });
  if (!candidate()) throw outboxError('provenance-unconfirmed', 'binding');
  if (proof.outboxConsumed) throw outboxError('duplicate-call', 'binding');
  // A repeated RPC for this still-active native call is not a second send.
  // Mark before opening any UI or awaiting its first action.
  proof.outboxConsumed = true;
  if (runtime.turnId == null) {
    // Only the latest turn's ID/status, explicitly without loaded items. This
    // read does not resume a thread, inspect history content or set turnId.
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        if (error) {
          const detail = classifyOutboxFailure(error, 'binding', 'turn-metadata-unconfirmed');
          reject(outboxError(detail.failureReason, detail.failurePhase, undefined, detail.cleanupUnconfirmed === true, detail.failureCheck));
        } else resolve(value);
      };
      const aborted = () => finish(true), timer = setTimeout(aborted, 3000);
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => {
        if (!candidate()) throw outboxError('provenance-unconfirmed', 'binding');
        return rpc.call('thread/turns/list', { threadId: identity.nativeId,
          limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      }).then(value => finish(false, value), error => finish(error));
    });
    const turn = result?.data?.[0];
    if (!candidate()) throw outboxError('provenance-unconfirmed', 'binding');
    if (!Array.isArray(result?.data) || result.data.length !== 1 ||
        turn?.id !== identity.turnId || turn.status !== 'inProgress' || turn.itemsView !== 'notLoaded' ||
        !Array.isArray(turn.items) || turn.items.length !== 0) throw outboxError('turn-metadata-unconfirmed', 'binding');
    metadataVerified = true;
  }
  if (!valid()) throw outboxError('provenance-unconfirmed', 'binding');
  return { args, valid: () => Boolean(valid()) };
}
// Subscribe before forwarding: the native input can precede the forward ACK.
// Only the eventually returned tag is projected, without any command output.
function nativeOutboxReceipt(runtime, nativeId, options = {}) {
  const rpc = options.rpc || runtime.host.rpc, hostRpc = runtime.host.rpc, lifecycle = runtime.lifecycleRevision, candidates = new Map(), listeners = new Set();
  let tag, closed = false;
  const current = () => !closed && !runtime.stopped && !runtime.transportDisconnected && runtime.host.rpc === hostRpc &&
    (runtime.currentRpc ? runtime.currentRpc(rpc) : rpc === runtime.host.rpc) &&
    runtime.lifecycleRevision === lifecycle && runtime.record.nativeId === nativeId;
  const snapshot = () => {
    const record = current() && candidates.get(tag);
    return record ? { turnId: record.turnId, ...(record.firstCommand ? { firstCommand: { ...record.firstCommand } } : {}),
      nativeId, inputTag: tag, nativeReceived: true, source: 'codex-native' } : null;
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
    if (!current() || item?.source !== 'codex-native' || item.kind !== 'commandExecution' ||
        options.scoped && (item.rpc !== rpc || item.lifecycle !== lifecycle)) return;
    const record = candidates.get(item.inputTag);
    if (!record || record.turnId !== item.turnId || record.firstCommand) return;
    if (options.scoped && item.status === 'inProgress') {
      if (!Object.hasOwn(record, 'firstCommandId')) record.firstCommandId = token(item.id) ? item.id : null;
      return;
    }
    if (!token(item.id) || typeof item.input !== 'string' || !item.input || item.input.length > 4096 ||
        options.scoped && record.firstCommandId !== item.id ||
        !['completed', 'failed'].includes(item.status) || !Number.isSafeInteger(item.exitCode)) return;
    record.firstCommand = { kind: 'commandExecution', id: item.id, command: item.input, inputTag: item.inputTag,
      turnId: item.turnId, status: item.status, exitCode: item.exitCode };
    publish();
  };
  const event = options.scoped ? 'scopedOutboxCommand' : 'progress';
  runtime.on('nativeAcceptedInput', accepted); runtime.on(event, command);
  return { bind(messageId) { if (!token(messageId) || tag) throw Error(FAIL); tag = messageId; publish(); },
    subscribe(listener) { listeners.add(listener); const value = snapshot(); if (value) listener(value); return () => listeners.delete(listener); },
    close() { closed = true; listeners.clear(); candidates.clear(); runtime.off('nativeAcceptedInput', accepted); runtime.off(event, command); } };
}
module.exports = { validateOutboxArgs, nativeOutboxCall, nativeOutboxReceipt, outboxError, classifyOutboxFailure };
