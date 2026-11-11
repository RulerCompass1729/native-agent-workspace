// Read-only diagnostics for the real-CLI quota journey. Loaded only by its
// owned daemon through --require; never installed into a native provider.
const path = require('node:path');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Claude } = require(path.join(code, 'app/adapters.cjs'));
const emit = value => { if (process.connected) process.send({ quotaObservation: value }, () => {}); };
const observe = Claude.prototype.observeRoot, hook = Claude.prototype.hook;
Claude.prototype.observeRoot = function (message) {
  const result = observe.call(this, message);
  if (['turn', 'control', 'input'].includes(message.kind)) emit({ source: 'bridge', kind: message.kind, id: message.id, nativeId: this.record.nativeId, turnId: message.turnId,
    status: message.status, failedRequest: message.failedRequest, failureCause: message.failureCause,
    promptId: message.promptId, lastPromptId: this.lastPromptId, inputRevoked: this.startedRootTurn?.inputRevoked,
    errorMessageId: message.errorMessageId, rootStatus: this.rootTurn?.status,
    failedTurnInputAvailable: Boolean(this.failedTurnInputId) });
  return result;
};
Claude.prototype.hook = function (event) {
  const result = hook.call(this, event);
  if (['StopFailure', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'].includes(event.hook_event_name)) emit({ source: 'classic', event: event.hook_event_name,
    nativeId: event.session_id, promptId: event.prompt_id, lastPromptId: this.lastPromptId, inputRevoked: this.startedRootTurn?.inputRevoked,
    child: Boolean(event.agent_id), rootStatus: this.rootTurn?.status,
    failedTurnInputAvailable: Boolean(this.failedTurnInputId) });
  return result;
};
