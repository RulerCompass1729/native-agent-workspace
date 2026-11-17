const test = require('node:test');
const assert = require('node:assert/strict');
const { MobileWorkspace } = require('../mobile-workspace.cjs');

test('phone question indicator and current-native confirmation links coexist without sharing private fields', async () => {
  const session = { id: 'a', nativeId: 'current', name: 'Synthetic member', provider: 'codex', state: 'working', roomIds: [],
    approvals: [{ method: 'item/tool/requestUserInput', requestId: 'PRIVATE_REQUEST', params: { isBlocking: false,
      questions: [{ id: 'q', header: 'PRIVATE_HEADER', question: 'PRIVATE_QUESTION' }] } }],
    messages: [
      { id: 'human', role: 'user', text: 'Original human text' },
      { id: 'current-card', role: 'system', text: 'PRIVATE_CURRENT_BODY', backgroundOperation: { id: 'request:current', nativeId: 'current' } },
      { id: 'old-card', role: 'system', text: 'PRIVATE_OLD_CARD_BODY', backgroundOperation: { id: 'request:old', nativeId: 'previous' } },
      { id: 'old-message', role: 'assistant', text: 'PRIVATE_OLD_MESSAGE', nativeId: 'previous' },
    ] };
  let authorityCalls = 0;
  const adapter = new MobileWorkspace({ snapshot: () => ({ sessions: [session], rooms: [], backgroundConfirmations: [] }), roomState: {},
    records: { status: () => null, acknowledge() {} }, confirmation() { authorityCalls++; throw Error('No decision grant'); } });
  const client = { refresh: async () => {}, route: () => ({ key: '.' }) };
  const grant = { roomIds: [], records: false }, scopes = [{ sessionId: 'a', nativeId: 'current', serviceKey: '.', actions: ['read'] }];
  const view = await adapter.read(client, grant, scopes), row = view.sessions[0];
  assert.equal(row.question, true);
  assert.deepEqual(row.messages.map(message => message.id), ['human', 'current-card']);
  assert.equal(row.messages[0].text, 'Original human text');
  assert.equal(row.messages[1].text, '');
  assert.equal(row.messages[1].confirmationId, 'a:current:request:current');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|previous|request:old/);
  assert.equal(authorityCalls, 0);
  session.approvals[0].pending = true;
  assert.equal((await adapter.read(client, grant, scopes)).sessions[0].question, false);
});
