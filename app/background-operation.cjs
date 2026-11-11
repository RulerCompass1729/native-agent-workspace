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
// Foreign conversations expose roster/capability metadata until one exact read
// is approved. Unknown future session fields are private by default.
const rosterFields = ['id', 'nativeId', 'name', 'provider', 'model', 'state', 'owner', 'cwd', 'archived', 'roomId', 'roomIds',
  'memberRevision', 'roomMembershipRevisions', 'placementRevision', 'connectionRevision', 'controlRevision', 'peerRevision',
  'pid', 'processIdentity', 'serverIdentity', 'peerIdentity', 'serviceCapabilities', 'runtimeVersion', 'backendKey',
  'nativeContextPending', 'wakeDisabled', 'terminalState', 'terminalAvailable', 'chatAvailable', 'spaceImagesAvailable',
  'addressedSendAvailable', 'nativeInputRequired', 'interruptPending', 'queueAvailable', 'steerAvailable', 'activeTurnId',
  'pendingTag', 'pendingQueue', 'pendingSteer', 'backendUnavailable', 'transportDisconnected', 'nativeBlockMapping',
  'nativeVersion', 'nativeVersionStatus', 'legacySubmit', 'legacyShare', 'failedTurnInputAvailable'];
function conversationTarget(method, args = [], actor) {
  const id = method === 'initial' ? args[0] : method === 'previewImage' && args[0]?.kind === 'session' ? args[0].sessionId : null;
  return actor && typeof id === 'string' && id && id !== actor.id ? id : null;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));
const scalars = (value, keys) => Object.fromEntries(Object.entries(pick(value, keys)).filter(([_key, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)));
const queueMetadata = ['id', 'status', 'assignee', 'sentTo', 'tag', 'control', 'attempts', 'createdAt', 'sentAt', 'finishedAt'];
function conversationSnapshot(value, actor, read = null, selected = value?.viewState?.selected, access = null) {
  if (!value || !Array.isArray(value.sessions)) return {};
  const owner = value.sessions.find(s => s.id === actor.id && s.nativeId === actor.nativeId);
  let rooms = [];
  try { rooms = access ? access.roomIds : require('./collaboration-spaces.cjs').roomIds(owner); } catch { /* Unknown membership grants nothing. */ }
  const secretary = access ? access.secretary : value.queueSecretary?.sessionId === actor.id && value.queueSecretary?.nativeId === actor.nativeId;
  const result = scalars(value, ['protocol', 'runtimeVersion', 'appVersion', 'storageRetryable', 'peerHandoffsAvailable', 'peerDirectedAvailable']);
  result.sessions = value.sessions.map(s => {
    const own = s.id === actor.id && s.nativeId === actor.nativeId;
    const authorized = read?.sessionId === s.id && read.nativeId === s.nativeId;
    if (own || authorized) return { ...s, messages: own && selected !== undefined && selected !== s.id ? [] : s.messages, liveDraft: '', draft: '' };
    return { ...Object.fromEntries(rosterFields.filter(key => Object.hasOwn(s, key)).map(key => [key, s[key]])), messages: [], liveDraft: '', draft: '' };
  });
  result.rooms = (value.rooms || []).map(room => {
    const member = !secretary && rooms?.includes(room.id);
    const projected = { ...pick(room, ['id', 'name', 'archived', 'unavailable', 'revision', 'metadataRevision', 'queueRevision', 'memberOrder']),
      ...(member ? pick(room, ['notes', 'messages', 'events', 'files', 'run', 'snapshotBatches', 'merge']) : {}) };
    if (Array.isArray(room.queue)) projected.queue = room.queue.map(item => ({ ...scalars(item, member ? [...queueMetadata, 'text', 'reply', 'reason'] : queueMetadata),
      ...(item.creator ? { creator: scalars(item.creator, ['kind', 'name', 'sessionId']) } : {}), ...(member ? pick(item, ['reasonUiMessage']) : {}) }));
    return projected;
  });
  if (value.room) result.room = result.rooms.find(room => room.id === value.room.id) || pick(value.room, ['id', 'name', 'archived', 'unavailable']);
  if (Array.isArray(value.capabilities)) result.capabilities = value.capabilities.filter(v => typeof v === 'string');
  if (value.wakePolicy) result.wakePolicy = Object.fromEntries(Object.entries(pick(value.wakePolicy, ['enabled', 'unavailable'])).filter(([_k, v]) => typeof v === 'boolean'));
  if (value.operatorPolicy) result.operatorPolicy = { enabled: value.operatorPolicy.enabled === true };
  if (value.queueSecretary) result.queueSecretary = scalars(value.queueSecretary, ['sessionId', 'nativeId']);
  if (value.butler) result.butler = scalars(value.butler, ['intake', 'errorCode', 'activation', 'recordPeriod']);
  if (value.viewState) result.viewState = scalars(value.viewState, ['selected', 'spaceId', 'mode', 'preference']);
  if (value.preflight) result.preflight = Object.fromEntries(Object.entries(pick(value.preflight, ['claude', 'codex', 'python'])).filter(([_k, v]) => typeof v === 'boolean'));
  if (value.appBuild) result.appBuild = scalars(value.appBuild, ['version', 'commit', 'installedAt']);
  if (value.diagnostics) result.diagnostics = scalars(value.diagnostics, ['shellModelCalls', 'dispatches']);
  if (Array.isArray(value.services)) result.services = value.services.map(service => scalars(service, ['version', 'active', 'sessions']));
  if (Array.isArray(value.rotationChains)) result.rotationChains = value.rotationChains.map(chain => ({ spaces: (chain.spaces || []).filter(id => typeof id === 'string'),
    sessions: (chain.sessions || []).map(s => scalars(s, ['id', 'nativeId', 'name', 'handedAt', 'outcome'])) }));
  return result;
}
// Display only: preserve the original command/name for identity and execution.
// Escape UTF-16 code units so supplementary format characters are visible too.
function visibleText(text) {
  return text.replace(/[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu, char => char.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}
function confirmationDetail(command, snapshot, context) {
  const ids = new Set(), references = [];
  const collect = value => {
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(command.arguments);
  // Legacy roomRename always targets the shared room, independent of view.
  if (command.method === 'roomRename') ids.add('shared');
  for (const s of snapshot.sessions || []) if (ids.has(s.id)) references.push({ kind: 'session', id: s.id, name: s.name, provider: s.provider });
  for (const room of snapshot.rooms || []) {
    if (ids.has(room.id)) references.push({ kind: 'space', id: room.id, name: room.name });
    if (command.method === 'spaceFiles' && room.id === command.arguments[0]) for (const file of room.files || [])
      if (ids.has(file.id)) references.push({ kind: 'file', id: file.id, name: file.name, roomId: room.id });
  }
  return visibleText(JSON.stringify({ method: command.method, arguments: command.arguments,
    ...(command.paths ? { paths: command.paths } : {}), ...(references.length ? { references } : {}),
    ...(command.method === 'pasteNativeContent' ? { clipboard: context?.clipboardImage && !context.clipboardImage.isEmpty()
      ? { kind: 'image', ...context.clipboardImage.getSize() } : { kind: 'text', text: context?.clipboardText || '' } } : {}) }, null, 2));
}
// One policy point for workspace_control maintenance. Native tool permission is
// not person consent for a new session, placement or archive. No role currently
// bypasses this gate; a future metered manager policy must be added here.
function maintenanceAction(method, args = [], actor) {
  if (conversationTarget(method, args, actor)) return 'readConversation';
  if (method === 'roomRename' || method === 'spaceAction' && args[1] === 'rename') return 'renameRoom';
  if (['create', 'spaceCreate', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom', 'resume', 'importHistory'].includes(method)) return method;
  if (['runtimeLocation', 'openLocalFile', 'saveLocalFile', 'spaceFiles', 'openMessageFile'].includes(method)) return method;
  // WorkspaceClient.pause stops routing across backends even when passed an ID;
  // that ID only scopes manual-input invalidation, not the affected sessions.
  if (method === 'pause') return method;
  if (actor && ['interrupt', 'claim', 'terminal', 'terminalSnapshot', 'resize', 'answer', 'input', 'prepareInput', 'observe', 'stageImages', 'pasteNativeContent', 'rename'].includes(method) && args[0] !== actor.id) return method;
  if (method === 'join') return args[1] === false ? 'leaveRoom' : 'joinRoom';
  if (method === 'spaceAction') {
    if (args[1] === 'join') return args[2]?.[1] === false ? 'leaveRoom' : 'joinRoom';
    if (args[1] === 'archive') return 'archiveRoom';
    if (args[1] === 'restore') return 'restoreRoom';
    if (args[1] === 'pause') return 'pause';
  }
  if (method === 'spaceMerge' && ['commit', 'recover', 'undo'].includes(args[0])) return { commit: 'mergeSpaces', recover: 'recoverMerge', undo: 'undoMerge' }[args[0]];
  return null;
}
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
module.exports = { actor, current, request, conversationTarget, conversationSnapshot, visibleText, confirmationDetail, maintenanceAction, run, message, activity, deliveryTargets, assertDeliveryPolicy, inputGuard, CAPABILITY: 'backgroundControlV1' };
