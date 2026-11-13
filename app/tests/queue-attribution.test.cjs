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

// Queue item 6897c6e3, part 1: a member claims an item queued for it that it is already doing.
test('room state lets only the item\'s assignee claim it, while it is queued, and keeps it as sent to that member', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-claim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const mine = room.queueAdd('Board task', 'session-one', 'shared', person());
  const anyone = room.queueAdd('For any member', null, 'shared', secretary());
  const member = { name: 'Builder <one>', sessionId: 'session-one', control: 4, input: 'turn-input' };
  const refused = key => error => error.uiMessage?.key === key;
  for (const who of [undefined, null, {}, { ...member, sessionId: '' }, { ...member, sessionId: 'session-two' }]) {
    assert.throws(() => room.queueClaim(mine, 'shared', who, NOW), refused('error.queue.claimOwnOnly'), JSON.stringify(who));
  }
  assert.throws(() => room.queueClaim(anyone, 'shared', member, NOW), refused('error.queue.claimOwnOnly'), 'an item for any member is not its own');
  room.queueClaim(mine, 'shared', member, NOW);
  const saved = new RoomState(dir).queueFind('shared', mine);
  assert.deepEqual([saved.status, saved.sentTo, saved.sentAt, saved.tag, saved.control, saved.creator.kind], ['sent', 'session-one', NOW, 'turn-input', 4, 'person']);
  const notice = room.value.events.at(-1).uiMessage;
  assert.equal(locale.format('zh', notice.key, notice.params), '队列认领：Board task → Builder <one>（session-one）已经在做这一件，NAW 不再派');
  assert.equal(locale.format('en', notice.key, notice.params), 'Claimed from queue: Board task → Builder <one> (session-one) is already doing it; NAW will not send it');
  assert.equal(locale.format('zh', 'error.queue.claimOwnOnly'), '会话只能认领指给自己、还在排队的任务。');
  assert.equal(locale.format('en', 'error.queue.claimOwnOnly'), 'A session can claim only an item queued for it that has not been sent yet.');
  assert.throws(() => room.queueClaim(mine, 'shared', member, NOW), refused('error.queue.notQueued'));
  // An input id the queue could not store is not used: the reply is then what follows the claim's time.
  for (const [index, input] of ['x'.repeat(101), 'line\nbreak', 7, ''].entries()) {
    const sessionId = `session-odd-${index}`;
    const id = room.queueAdd(`Odd ${String(input).length}`, sessionId);
    room.queueClaim(id, 'shared', { ...member, sessionId, input }, NOW);
    assert.equal(room.queueFind('shared', id).tag, `claimed:${id}`, JSON.stringify(input));
  }
  assert.doesNotThrow(() => rules.validateQueue(new RoomState(dir).queueItems('shared')));
});

// Review note: the planner settles every sent item on the member's reply after its anchor, so a
// member already holding a sent item, in any space, cannot claim another until that one settles.
test('a member with a sent item that has not settled, in any space, cannot claim another; once it settles it can', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-claim-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const other = room.create('Other');
  const member = { name: 'Builder <one>', sessionId: 'session-one', control: 0, input: 'turn-input' };
  const refused = key => error => error.uiMessage?.key === key;
  const first = room.queueAdd('Sent by NAW', 'session-one', 'shared', person());
  room.queueClaim(first, 'shared', member, NOW);
  const here = room.queueAdd('Same space', 'session-one', 'shared', person());
  const there = room.queueAdd('Other space', 'session-one', other, person());
  for (const [id, itemId] of [['shared', here], [other, there]]) {
    assert.throws(() => room.queueClaim(itemId, id, member, NOW), refused('error.queue.claimBusy'), id);
  }
  assert.deepEqual([room.queueFind('shared', here).status, new RoomState(dir).queueFind(other, there).status], ['queued', 'queued']);
  // Another member is not held by this one's item.
  const theirs = room.queueAdd('Theirs', 'session-two', other, person());
  room.queueClaim(theirs, other, { ...member, sessionId: 'session-two' }, NOW);
  assert.equal(room.queueFind(other, theirs).status, 'sent');
  assert.equal(locale.format('zh', 'error.queue.claimBusy'), '这个会话还有一件已派出、没结算的任务，等它结算后再认领。');
  assert.equal(locale.format('en', 'error.queue.claimBusy'), 'This session still has a sent item that has not settled; claim after it settles.');
  // Settled for the person to decide: it no longer settles on a reply, so it does not hold a claim back.
  room.queueSettle('shared', first, 'waiting', '', 'Builder <one>', 'Pick one');
  room.queueClaim(there, other, member, NOW + 1);
  assert.deepEqual([new RoomState(dir).queueFind(other, there).status, room.queueFind('shared', here).status], ['sent', 'queued']);
  assert.throws(() => room.queueClaim(here, 'shared', member, NOW + 2), refused('error.queue.claimBusy'));
});
