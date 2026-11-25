const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { omitHidden } = require('../shown-sessions.cjs');
function display(background = false) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const code = source.slice(source.indexOf('function displayState('), source.indexOf('function reportViewStorage('));
  const blocked = { reason: 'synthetic-native-wait', since: 123 }, reads = [];
  const message = { id: 'pending', kind: 'operator-open', operator: { creation: 'pending-authorization', actionable: true, initiatorId: 's', actionKey: 'key', args: { task: 'Synthetic original task' } } };
  const scope = { structuredClone, confirmationSnapshot: (_client, value) => value, roomState: { apply: value => structuredClone(value) }, sessionLabels: { apply: value => value }, submissionState: value => value,
    backgroundControl: null, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    activeManagers: () => ({}), integratorRole: null, stewardRole: null, queueDispatcher: null, butlerIngress: null,
    stewardWake: { view: () => { reads.push('view'); return { blocked }; } },
    localVendorIcons: () => ({}), viewStorageWarning: '', viewStorageWarningUiMessage: null, endedByMove: () => [], roomPeerIdentity: () => null,
    backgroundOperation: { conversationSnapshot: value => value }, conversationAccess: () => [],
    snapshot: { sessions: [{ id: 's', nativeId: 'n', messages: [message] }], room: { id: 'shared', messages: [] }, rooms: [] },
    context: { background, actor: 's', view: { selected: 's' } } };
  return { value: vm.runInNewContext(code + '\ndisplayState(snapshot,context)', scope), reads, blocked };
}
test('merged human display retains pending creation cards when conversation messages are omitted', () => {
  const { value } = display(), shown = omitHidden(value, new Set());
  assert.equal(shown.sessions[0].messagesOmitted, true);
  assert.deepEqual(shown.sessions[0].messages, []);
  assert.deepEqual(Array.from(shown.operatorCreations || [], item => item.message.id), ['pending']);
  assert.equal(shown.operatorCreations[0].message.operator.args.task, 'Synthetic original task');
});
test('merged human display retains the existing blocked steward-wake status', () => {
  const { value, reads, blocked } = display();
  assert.equal(value.stewardWakeStatus, blocked); assert.deepEqual(reads, ['view']);
});
test('merged background display excludes both human projections before downstream filtering', () => {
  const { value, reads } = display(true);
  assert.equal(Object.hasOwn(value, 'operatorCreations'), false);
  assert.equal(Object.hasOwn(value, 'stewardWakeStatus'), false);
  assert.deepEqual(reads, []);
});
