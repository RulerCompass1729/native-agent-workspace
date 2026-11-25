const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const stream = require('../task-stream.js'), { omitHidden } = require('../shown-sessions.cjs');
const message = { id: 'operator:open:key', kind: 'operator-open', role: 'system', text: 'Unmodified creation record', time: 1,
  operator: { actionKey: 'key', initiatorId: 's', initiatorNativeId: 'n', creation: 'pending-authorization', actionable: true,
    args: { provider: 'codex', cwd: '/synthetic/project', permission: 'default', name: 'Code review', task: 'Full synthetic task <literal>' }, actual: { actionId: 'open-one' } } };
const session = () => ({ id: 's', nativeId: 'n', name: 'Initiator', state: 'idle', messages: [structuredClone(message)] });
function display(background = false) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const code = source.slice(source.indexOf('function displayState('), source.indexOf('function reportViewStorage('));
  const scope = { structuredClone, confirmationSnapshot: (_c, v) => v, roomState: { apply: v => structuredClone(v) }, sessionLabels: { apply: v => v }, submissionState: v => v,
    backgroundControl: null, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    activeManagers: () => ({}), integratorRole: null, stewardRole: null, queueDispatcher: null, butlerIngress: null, stewardWake: null, sessionModelChanges: null,
    localVendorIcons: () => ({}), viewStorageWarning: '', viewStorageWarningUiMessage: null, endedByMove: () => [], roomPeerIdentity: () => null,
    backgroundOperation: { conversationSnapshot: v => v }, conversationAccess: () => [], snapshot: { sessions: [session()], room: { id: 'shared', messages: [] }, rooms: [] },
    context: { background, actor: 's', view: { selected: 's' } } };
  return vm.runInNewContext(code + '\ndisplayState(snapshot,context)', scope);
}
test('the desktop keeps its pending creation card when the initiator conversation is omitted', () => {
  const shown = omitHidden(display(), new Set());
  assert.equal(shown.sessions[0].messagesOmitted, true); assert.deepEqual(shown.sessions[0].messages, []);
  assert.equal(shown.operatorCreations.length, 1);
  const items = stream.waitingItems({ sessions: shown.sessions, operatorCreations: shown.operatorCreations });
  assert.equal(items.length, 1); assert.equal(items[0].kind, 'operator-creation');
  assert.equal(items[0].message.operator.args.task, message.operator.args.task);
});
test('background and agent displays do not receive the new human creation-card projection', () => {
  assert.equal(Object.hasOwn(display(true), 'operatorCreations'), false);
});
test('one authoritative creation projection produces one waiting item, regardless of loaded messages', () => {
  const s = session(), item = { sessionId: s.id, nativeId: s.nativeId, message: s.messages[0] };
  const items = stream.waitingItems({ sessions: [s], operatorCreations: [item, item] });
  assert.equal(items.length, 1); assert.equal(items[0].actorName, 'Initiator');
  assert.equal(items[0].title, 'Code review');
});
test('an authoritative empty projection cannot resurrect a completed request from cached conversation text', () => {
  assert.deepEqual(stream.waitingItems({ sessions: [session()], operatorCreations: [] }), []);
});
test('legacy loaded conversations can still expose a pending creation card', () => {
  const items = stream.waitingItems({ sessions: [session()] }); assert.equal(items.length, 1);
});
for (const change of ['closed', 'archived', 'wrong-session', 'replaced-native']) test('creation-card projection rejects ' + change, () => {
  const s = session(), m = structuredClone(message);
  if (change === 'closed') m.operator.creation = 'created';
  if (change === 'archived') s.archived = true;
  if (change === 'wrong-session') m.operator.initiatorId = 'other';
  const nativeId = change === 'replaced-native' ? 'old-native' : s.nativeId;
  assert.deepEqual(stream.waitingItems({ sessions: [s], operatorCreations: [{ sessionId: s.id, nativeId, message: m }] }), []);
});
