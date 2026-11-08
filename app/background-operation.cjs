// One invocation's provenance. Never global mutable "current user" state.
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
function actor(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'callId,id,name,nativeId,operationId,provider,turnId' ||
      !['id', 'name', 'nativeId', 'callId', 'turnId', 'operationId'].every(k => token(value[k])) || !['claude', 'codex'].includes(value.provider)) throw Error('Background operation identity is unavailable');
  return Object.freeze({ ...value });
}
function current() { return scope.getStore()?.actor || null; }
function request() { return scope.getStore()?.request || null; }
function run(value, fn, request = null) { return scope.run({ actor: actor(value), request }, fn); }
function message(recipient) {
  const a = current();
  return a ? { origin: 'agent-control', name: recipient ? `${a.name} → ${recipient}` : a.name, agentControl: { ...a } } : {};
}
function activity(reason, uiMessage) {
  const a = current(), key = uiMessage?.key;
  if (a && /^notice\.run\.human(Control|Priority|Queue|Steer|TerminalAction|TerminalInput|Interrupt)$/.test(key))
    return require('./ui-errors.cjs').uiActivity(key.replace('.human', '.agent'), { name: a.name });
  return [reason, uiMessage];
}
function deliveryTargets(method, args) {
  if (method === 'spaceAction') return deliveryTargets(args[1], Array.isArray(args[2]) ? args[2] : []);
  if (!['send', 'forward', 'queue', 'queueShared', 'steer', 'steerShared', 'run', 'input'].includes(method)) return null;
  return method === 'run' ? Array.isArray(args[0]) ? args[0] : [] : [args[0]];
}
function assertDeliveryPolicy(snapshot, method, args) {
  const ids = deliveryTargets(method, args);
  if (ids && (snapshot?.wakePolicy?.enabled !== true || !ids.length || ids.some(id => {
    const target = snapshot.sessions?.find(s => s.id === id); return !target || target.wakeDisabled;
  }))) throw require('./ui-errors.cjs').uiError('error.backgroundMessagesDisabled');
}
function inputGuard(workspace, ids, origin = current()) {
  // Capture provenance: native may call the guard after this async scope exits.
  const valid = () => {
    if (!origin) return true;
    try { return ids.length > 0 && require('./session-wake.cjs').enabled(workspace) && ids.every(id => workspace.sessions.has(id) && !workspace.sessions.get(id).wakeDisabled); }
    catch { return false; }
  };
  if (!valid()) throw require('./ui-errors.cjs').uiError('error.backgroundMessagesDisabled');
  return valid;
}
module.exports = { actor, current, request, run, message, activity, deliveryTargets, assertDeliveryPolicy, inputGuard, CAPABILITY: 'backgroundControlV1' };
