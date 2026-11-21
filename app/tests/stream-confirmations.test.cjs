const test = require('node:test'), assert = require('node:assert/strict');
const { BackgroundControl } = require('../background-control.cjs');
test('pending strip uses the conversation card and excludes replaced requests', () => {
  const record = (id, state = 'confirmation-required') => ({ id, state, at: 1,
    actor: { id: 'a', nativeId: 'native-a', name: 'Agent A' }, command: { method: 'rename', arguments: ['a', 'New name'] },
    confirmation: { kind: 'message', options: { message: 'Confirm rename', detail: 'Full warning', buttons: ['Cancel', 'Confirm'], cancelId: 0 } } });
  const f = Object.create(BackgroundControl.prototype); f.now = () => 1000; f.inflight = new Map();
  f.data = { records: [record('old'), record('current'), record('done', 'complete')] };
  f.archivedBySession = new Map(); f.replacement = r => r.id === 'old' ? { state: 'waiting' } : null;
  const cards = f.pending();
  assert.equal(cards.length, 1); assert.equal(cards[0].operationId, 'current');
  assert.equal(cards[0].detail, 'Full warning');
  assert.deepEqual(cards[0].message, f.rows('a').find(m => m.backgroundOperation.id === 'current'));
  assert.deepEqual(cards[0].buttons, ['Cancel', 'Confirm']);
});
test('actual replacement rules remove both a retried card and one answered on a newer card', () => {
  const f = Object.create(BackgroundControl.prototype); f.now = () => 1000; f.inflight = new Map(); f.archivedBySession = new Map();
  const record = (id, at) => ({ id, at, state: 'confirmation-required', actor: { id: 'a', nativeId: 'native-a', name: 'A' },
    command: { method: 'rename', arguments: ['target', 'New name'], operation_id: id }, guard: { revision: 1 },
    confirmation: { kind: 'message', options: { message: 'Confirm', detail: 'Full warning', buttons: ['Cancel', 'Confirm'] } } });
  const old = record('old', 1), next = record('new', 2); f.data = { records: [old, next] };
  assert.deepEqual(f.pending().map(c => c.operationId), ['new']);
  next.state = 'complete'; next.humanDecision = 1; next.humanDecisionAt = 3;
  assert.deepEqual(f.pending(), []);
});

test('pending confirmations are projected only into human windows, never agent snapshots', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function displayState('), source.indexOf('function reportViewStorage('));
  let reads = 0;
  const context = { roomState: { apply: x => x }, sessionLabels: { apply: x => x }, submissionState: x => x,
    confirmationInbox: require('../confirmation-inbox.cjs'), confirmationProjectionKey: '', recordsChanged() {},
    backgroundControl: { rows: () => [], confirmations: () => { reads++; return [{ id: 'human-card' }]; } },
    backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    queueSecretary: null, integratorRole: null, stewardRole: null, stewardWake: null, queueDispatcher: null, butlerIngress: null,
    viewStorageWarning: '', viewStorageWarningUiMessage: null, endedByMove: () => [], roomPeerIdentity: () => null,
    backgroundOperation: { conversationSnapshot: x => x }, conversationAccess: () => null,
    localVendorIcons: () => ({}) };
  vm.runInNewContext(body + ';this.displayState = displayState', context);
  const human = context.displayState({ sessions: [] }, { view: {} });
  assert.equal(human.backgroundConfirmations[0].id, 'human-card'); assert.equal(reads, 1);
  const agent = context.displayState({ sessions: [] }, { background: true, view: {} });
  assert.equal(Object.hasOwn(agent, 'backgroundConfirmations'), false);
  assert.equal(Object.hasOwn(agent, 'stewardDuty'), false); assert.equal(reads, 1, 'Agent reads never build the human list');
});

test('a reused operation ID after native replacement never picks an archived card', () => {
  const f = Object.create(BackgroundControl.prototype); f.now = () => 1000; f.inflight = new Map();
  const make = nativeId => ({ id: 'same-operation', at: 1, state: 'confirmation-required', actor: { id: 'a', nativeId, name: 'A' },
    command: { method: 'rename', arguments: ['target', nativeId] },
    confirmation: { kind: 'message', options: { message: 'Confirm', buttons: ['Cancel', 'Confirm'] } } });
  const old = make('native-old'), current = make('native-current');
  f.archivedBySession = new Map([['a', [old]]]); f.data = { records: [current] };
  const [card] = f.pending();
  assert.equal(card.nativeId, 'native-current');
  assert.equal(card.message.backgroundOperation.nativeId, 'native-current');
  assert.equal(card.id, 'background:native-current:same-operation');
});
