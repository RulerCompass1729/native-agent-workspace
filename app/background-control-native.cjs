const { isDeepStrictEqual } = require('node:util');
const { validate } = require('./background-control.cjs');
const { outboxError } = require('./computer-use-outbox-native.cjs');
const credentials = new WeakMap();
function rootCall(target, message, signal, stillTarget) {
  const args = validate(message.arguments), live = target.liveTurn, epoch = target.observationEpoch;
  const identity = { provider: 'claude', nativeId: target.record.nativeId, sessionId: target.record.nativeId,
    turnId: message.turnId, promptId: message.promptId, callId: message.callId };
  if (Object.values(identity).some(v => typeof v !== 'string' || !v || v.length > 160)) throw Error('Native control identity is unavailable');
  const valid = () => !signal.aborted && stillTarget() && target.nativeBlocks === true && !target.disposed && !target.stopped && !target.rootEnding &&
    target.terminal?.alive && !target.record.nativeContextPending && target.record.nativeId === identity.nativeId &&
    target.validRootBinding(message) && target.observationEpoch === epoch && message.epoch === epoch && !target.displayGap &&
    live && target.liveTurn === live && live.id === identity.turnId && live.promptId === identity.promptId;
  if (!valid()) throw Error('Native root control call is unavailable');
  target.backgroundRootCalls ||= new Map();
  for (const [id, call] of target.backgroundRootCalls) if (call.identity.turnId !== identity.turnId) target.backgroundRootCalls.delete(id);
  if (target.backgroundRootCalls.has(identity.callId) || target.backgroundRootCalls.size >= 256) throw Error('Native control call already used');
  const call = { target, identity, args, valid, consumed: false };
  target.backgroundRootCalls.set(identity.callId, call);
  const credential = Object.freeze({}); credentials.set(credential, call);
  return { credential, identity, args };
}
function consume(call, identity, args) {
  // Keep the same admission checks, but distinguish their fixed refusal codes
  // on the existing native receipt. Never include identity or argument values.
  const refused = reason => outboxError(reason, 'binding', 'Native control proof is unavailable');
  if (!call) throw refused('native-call-missing');
  if (call.consumed) throw refused('duplicate-call');
  if (!call.valid()) throw refused('native-call-invalidated');
  if (!isDeepStrictEqual(call.identity, identity)) throw refused('native-call-identity-mismatch');
  if (!isDeepStrictEqual(call.args, validate(args))) throw refused('native-call-arguments-mismatch');
  call.consumed = true;
  return { args: call.args, identity: call.identity, target: call.target, valid: call.valid };
}
function consumeCredential(credential) {
  const call = credentials.get(credential);
  return consume(call, call?.identity, call?.args);
}
function nativeCall(runtime, identity, args, signal) {
  if (runtime.record.provider !== 'claude') return require('./computer-use-outbox-native.cjs').nativeOutboxCall(runtime, identity, args, signal, true);
  if (signal?.aborted) throw Error('Native control call cancelled');
  const proof = consume(runtime.backgroundRootCalls?.get(identity.callId), identity, args);
  return { ...proof, valid: () => !signal?.aborted && proof.valid() };
}
module.exports = { rootCall, consumeCredential, nativeCall };
