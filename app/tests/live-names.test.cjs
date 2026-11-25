const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { RoomState } = require('../room-state.cjs');
const { SessionLabels } = require('../session-labels.cjs');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const section = (from, to) => {
  const start = main.indexOf(from), end = main.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return main.slice(start, end);
};

// The phone's workspace as Main makes it, once a run, with Main's own display state and the real names and records.
// The session has a name by then.
function phone(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-live-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sandbox = { roomState: new RoomState(dir), sessionLabels: new SessionLabels(dir), submissionState: state => state, confirmationInbox: require('../confirmation-inbox.cjs'),
    backgroundControl: null, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false, activeManagers: () => ({}), integratorRole: null, stewardRole: null,
    stewardWake: null, queueDispatcher: null, sessionModelChanges: null, butlerIngress: null, localVendorIcons: () => ({}), endedByMove: () => [], roomPeerIdentity: require('../peer-handoffs.cjs').identity,
    viewStorageWarning: '', viewStorageWarningUiMessage: null,
    require: name => { assert.equal(name, './mobile-workspace.cjs'); return require('../mobile-workspace.cjs'); } };
  vm.createContext(sandbox);
  vm.runInContext(require('./fixtures/main-person-actions.cjs')(main), sandbox);
  vm.runInContext(section('function confirmationSnapshot(', 'function appRecordsStatus(') + section('function appMobileWorkspace()', '// The listener stays open') +
    section('function displayState(', 'function reportViewStorage('), sandbox);
  const sessions = [{ id: 'a', nativeId: 'native-a', name: 'Synthetic', provider: 'codex', state: 'idle', roomIds: ['shared'], messages: [] }];
  const client = { async refresh() {}, route: () => ({ key: '.' }), snapshot: () => ({ sessions, rooms: [{ id: 'shared', messages: [] }] }) };
  sandbox.sessionLabels.set('a', 'Before');
  const workspace = sandbox.appMobileWorkspace(), grant = { roomIds: ['shared'], records: false };
  return {
    dir, sandbox,
    listed: async () => (await workspace.read(client, grant, [{ serviceKey: '.', sessionId: 'a', nativeId: 'native-a', actions: ['read'] }])).sessions.map(s => s.name),
    // Asked for someone outside the space, it answers with who is in it.
    members: () => workspace.action(client, grant, { requestId: randomUUID(), action: 'queueAdd', roomId: 'shared', text: 'Task', assignee: 'outside' }, () => {})
      .then(() => assert.fail('taken'), error => error.uiMessage.params.members),
  };
}

test('the phone names a session as the person renamed it since the start, in its list and in who it can give work to', async t => {
  for (const retried of [false, true]) {
    const h = phone(t);
    assert.deepEqual([await h.listed(), await h.members()], [['Before'], 'Before · a']);
    if (retried) h.sandbox.sessionLabels = new SessionLabels(h.dir);
    h.sandbox.sessionLabels.set('a', 'After');
    assert.deepEqual([await h.listed(), await h.members()], [['After'], 'After · a']);
    h.sandbox.sessionLabels.remove('a');
    assert.deepEqual([await h.listed(), await h.members()], [['Synthetic'], 'Synthetic · a']);
  }
});
