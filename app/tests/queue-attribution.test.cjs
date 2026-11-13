const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const locale = require('../ui-locale.js');

const NOW = 1_800_000_000_000;
const secretary = () => ({ kind: 'secretary', name: 'Secretary <one>', sessionId: 'session-one' });
const person = () => ({ kind: 'person', name: 'You', sessionId: null });
const legacy = () => ({ id: 'legacy', text: 'Existing task', assignee: null, status: 'queued', createdAt: NOW });

test('new queue items retain a validated, detached creator and the original constructor arguments', () => {
  const creator = secretary();
  const item = rules.newItem('Investigate the issue', null, NOW, creator);
  assert.deepEqual(item.creator, creator);
  assert.equal(item.createdAt, NOW);
  creator.name = 'Changed later';
  assert.equal(item.creator.name, 'Secretary <one>');
  const saved = rules.validateQueue([item])[0];
  saved.creator.name = 'Snapshot edit';
  assert.equal(item.creator.name, 'Secretary <one>');
  assert.deepEqual(rules.newItem('A direct request', 'agent-one', NOW, person()).creator, person());
});

test('malformed creator fields are rejected when creating and reading queue items', () => {
  const invalid = [null, [], 'secretary', {}, { ...secretary(), kind: 'agent' },
    { ...secretary(), name: '' }, { ...secretary(), name: '  ' },
    { ...secretary(), name: 'x'.repeat(101) }, { ...secretary(), name: 'Bad\nName' },
    { ...secretary(), name: 'Bad\u007fName' }, { ...secretary(), sessionId: null },
    { ...secretary(), sessionId: '' }, { ...secretary(), sessionId: '  ' },
    { ...secretary(), sessionId: 'x'.repeat(101) }, { ...secretary(), sessionId: 'bad\u007fid' },
    { ...person(), sessionId: 'not-a-person-session' }, { kind: 'person', name: 'You' },
    { ...secretary(), unvalidated: 'extra' }];
  for (const creator of invalid) {
    assert.throws(() => rules.newItem('Task', null, NOW, creator), /Invalid queue creator/);
    assert.throws(() => rules.validateQueue([{ ...legacy(), creator }]), /Invalid queue creator/);
  }
});

test('legacy queue items stay readable without a fabricated creator', () => {
  const item = legacy();
  assert.deepEqual(rules.validateQueue([item]), [item]);
  assert.equal(Object.hasOwn(rules.newItem('Legacy constructor', null, NOW), 'creator'), false);
});

test('person and secretary provenance persists and appears on the queue-add space notice', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-attribution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const secretaryId = room.queueAdd('Check the layout', null, 'shared', secretary());
  const personId = room.queueAdd('Check the menu', null, 'shared', person());
  const saved = new RoomState(dir);
  assert.equal(saved.warning, '');
  assert.deepEqual(saved.queueFind('shared', secretaryId).creator, secretary());
  assert.deepEqual(saved.queueFind('shared', personId).creator, person());
  const notices = saved.value.events.map(event => event.uiMessage);
  assert.deepEqual(notices.map(notice => notice.key), ['notice.queue.addedBySecretary', 'notice.queue.addedByPerson']);
  assert.deepEqual(notices[0].params, { text: 'Check the layout', name: 'Secretary <one>', sessionId: 'session-one' });
  assert.deepEqual(notices[1].params, { text: 'Check the menu' });
  assert.equal(locale.format('zh', notices[1].key, notices[1].params), '队列新增：Check the menu · 你添加');
  assert.equal(locale.format('en', notices[1].key, notices[1].params), 'Added to queue: Check the menu · added by you');
  const displayed = saved.apply({ sessions: [], room: { messages: [] } }).rooms[0];
  displayed.queue[0].creator.name = 'Display edit';
  assert.equal(saved.queueFind('shared', secretaryId).creator.name, 'Secretary <one>');
  saved.queueCancel(secretaryId);
  assert.deepEqual(saved.queueFind('shared', secretaryId).creator, secretary());
  assert.throws(() => saved.queueAdd('Bad creator', null, 'shared', { ...secretary(), sessionId: null }));
  assert.equal(saved.queueItems('shared').length, 2);
});

test('only an undispatched queued item can be cancelled; waiting items remain for resolution', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-cancellation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const queued = room.queueAdd('Not yet sent', null);
  const waiting = room.queueAdd('Needs a decision', null);
  room.queueMarkSent('shared', waiting, 'agent-one', 'Agent One', NOW);
  room.queueSetDelivery('shared', waiting, 'task-tag', 0);
  room.queueSettle('shared', waiting, 'waiting', '', 'Agent One');
  assert.throws(() => room.queueCancel(waiting), error => error.uiMessage?.key === 'error.queue.notCancellable');
  assert.equal(room.queueFind('shared', waiting).status, 'waiting');
  room.queueResolve(waiting);
  assert.equal(room.queueFind('shared', waiting).status, 'done');
  room.queueCancel(queued);
  assert.equal(room.queueFind('shared', queued).status, 'cancelled');
});

test('room state lets only the item\'s own adding session withdraw it, while it is queued', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-withdraw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const mine = room.queueAdd('Mine', null, 'shared', secretary());
  const persons = room.queueAdd('The person\'s', null, 'shared', person());
  const legacyItem = room.queueAdd('No creator', null);
  const author = { name: 'Secretary <one>', sessionId: 'session-one' };
  const refused = key => error => error.uiMessage?.key === key;
  for (const who of [undefined, null, {}, { name: 'x', sessionId: '' }, { name: 'x', sessionId: 'session-two' }]) {
    assert.throws(() => room.queueWithdraw(mine, 'shared', who), refused('error.queue.withdrawOwnOnly'), JSON.stringify(who));
  }
  for (const id of [persons, legacyItem]) assert.throws(() => room.queueWithdraw(id, 'shared', author), refused('error.queue.withdrawOwnOnly'));
  room.queueWithdraw(mine, 'shared', author);
  assert.deepEqual(new RoomState(dir).queueItems('shared').map(item => item.status), ['cancelled', 'queued', 'queued']);
  const notice = room.value.events.at(-1).uiMessage;
  assert.equal(locale.format('zh', notice.key, notice.params), '队列撤回：Mine · Secretary <one>（session-one）撤回了自己放进来的这一件');
  assert.equal(locale.format('en', notice.key, notice.params), 'Withdrawn from queue: Mine · taken back by Secretary <one> (session-one), who added it');
  assert.throws(() => room.queueWithdraw(mine, 'shared', author), refused('error.queue.notCancellable'));
});
