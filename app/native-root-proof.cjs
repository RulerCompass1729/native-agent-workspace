// Fixed diagnostic names for the existing two root-call validity policies.
// Draft text and composer/IME state are not native identity or permission facts.
const FAILURE_CHECKS = Object.freeze(['aborted', 'target', 'retained-reader', 'native-blocks', 'disposed', 'stopped', 'root-ending',
  'terminal-alive', 'native-input-required', 'native-context-pending', 'native-id', 'root-binding', 'observation-epoch', 'display-gap',
  'root-turn-missing', 'root-turn-reference', 'root-turn-status', 'root-turn-id', 'root-prompt-id',
  'live-turn-missing', 'live-turn-reference', 'live-turn-id', 'live-prompt-id', 'native-permissions',
  'scope-workspace', 'scope-closed', 'scope-client', 'scope-wake-policy', 'scope-session', 'scope-runtime', 'scope-native-state',
  'scope-native-id', 'scope-pid', 'scope-owner', 'scope-control-revision', 'scope-connection', 'scope-peer-revision',
  'scope-rpc', 'scope-session-id', 'scope-lifecycle', 'scope-membership', 'scope-input-identity', 'scope-native-proof', 'scope-ready']);
function rootValidity(target, message, signal, stillTarget, retained = false) {
  const root = target.rootTurn, live = target.liveTurn, epoch = target.observationEpoch, nativeId = target.record.nativeId;
  const turnId = message.turnId, promptId = message.promptId;
  const conditions = [
    ['aborted', () => !signal.aborted], ['target', stillTarget],
    ...(retained ? [['retained-reader', () => target.retainedReader === true]] : []),
    ['native-blocks', () => target.nativeBlocks === true], ['disposed', () => !target.disposed],
    ...(!retained ? [['stopped', () => !target.stopped]] : []),
    ['root-ending', () => !target.rootEnding], ['terminal-alive', () => Boolean(target.terminal?.alive)],
    ...(retained ? [['native-input-required', () => !target.nativeInputRequired]] : []),
    ['native-context-pending', () => !target.record.nativeContextPending],
    ...(!retained ? [['native-id', () => target.record.nativeId === nativeId]] : []),
    ['root-binding', () => target.validRootBinding(message)],
    ['observation-epoch', () => retained ? message.epoch === target.observationEpoch : target.observationEpoch === epoch && message.epoch === epoch],
    ['display-gap', () => !target.displayGap],
    ...(retained ? [
      ['root-turn-missing', () => Boolean(root && target.rootTurn)], ['root-turn-reference', () => target.rootTurn === root],
      ['root-turn-status', () => root.status === 'working'], ['root-turn-id', () => root.id === message.turnId], ['root-prompt-id', () => root.promptId === message.promptId],
    ] : []),
    ['live-turn-missing', () => Boolean(live && target.liveTurn)], ['live-turn-reference', () => target.liveTurn === live],
    ['live-turn-id', () => live.id === (retained ? message.turnId : turnId)], ['live-prompt-id', () => live.promptId === (retained ? message.promptId : promptId)],
    ...(retained ? [['native-permissions', () => !target.livePermissions?.size]] : []),
  ];
  const failureCheck = () => {
    for (const [name, check] of conditions) { try { if (!check()) return name; } catch { return name; } }
    return null;
  };
  const valid = () => failureCheck() === null;
  valid.failureCheck = failureCheck;
  return valid;
}
module.exports = { rootValidity, FAILURE_CHECKS };
