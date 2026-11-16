// B6 step 1, checkpoint A: what NAW records by itself at the queue's write points.
// E1: a space with nothing queued and nothing sent, once per round of work.
// E2: a member's delivery line (READY <branch> <commit>), once its item is done.
// Records only. No model, message, notification or dispatch decision is involved.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), locale = require('../ui-locale.js');

const NOW = 1_800_000_000_000, SHA = 'a'.repeat(40), READY = { branch: 'lane/member-task', commit: 'abc1234' };
function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-monitor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RoomState(dir), outcomes = [];
  state.onQueueOutcome = value => outcomes.push(value);
  const add = (text = 'Synthetic task', id = 'shared') => state.queueAdd(text, null, id);
  const send = (itemId, id = 'shared') => state.queueMarkSent(id, itemId, 'member', 'Member', NOW);
  const sent = (text, id) => { const itemId = add(text, id); send(itemId, id); return itemId; };
  const facts = (kind, id = 'shared') => state.metadata(id).events.filter(event => event.monitor?.kind === kind);
  return { state, dir, outcomes, add, send, sent, facts, reopen: () => new RoomState(dir) };
}

test('a delivery line is one whole line of exactly READY, a branch and a commit', () => {
  assert.deepEqual(rules.readyLine(`Done.\nREADY lane/member-task ${SHA}`), { branch: 'lane/member-task', commit: SHA });
  assert.deepEqual(rules.readyLine('READY a.b_c/d-e 0123abc'), { branch: 'a.b_c/d-e', commit: '0123abc' });
  assert.deepEqual(rules.readyLine('READY main ABCDEF1'), { branch: 'main', commit: 'abcdef1' }, 'Commit is stored lower-case');
  assert.deepEqual(rules.readyLine('  READY lane/x abc1234  \r\nTests 12/12'), { branch: 'lane/x', commit: 'abc1234' });
  assert.deepEqual(rules.readyLine('\x1b[32mREADY lane/x abc1234\x1b[0m'), { branch: 'lane/x', commit: 'abc1234' }, 'Terminal colour is not part of the line');
  assert.deepEqual(rules.readyLine('READY lane/old 1111111\nREADY lane/new 2222222'), { branch: 'lane/new', commit: '2222222' }, 'The last valid line wins');
  assert.deepEqual(rules.readyLine('READY lane/good 1111111\nREADY ../bad 2222222'), { branch: 'lane/good', commit: '1111111' }, 'An invalid later line is not a delivery');
  for (const reply of [
    '', 'All done, no code.', 'READY', 'READY lane/x', 'READY lane/x abc123', `READY lane/x ${'a'.repeat(41)}`, 'READY lane/x abc123g',
    'READY -rf abc1234', 'READY a..b abc1234', 'READY a;rm abc1234', 'READY $(id) abc1234', 'READY a b abc1234', `READY ${'b'.repeat(201)} abc1234`,
    'ready lane/x abc1234', 'READY  lane/x abc1234', 'READY\tlane/x\tabc1234', 'Now READY lane/x abc1234', 'READY lane/x abc1234 tests 3/3',
    '`READY lane/x abc1234`', '- READY lane/x abc1234', 'READY <branch> <commit>', 'READY lane/分支 abc1234',
  ]) assert.equal(rules.readyLine(reply), null, JSON.stringify(reply));
  for (const value of [undefined, null, 7, {}, ['READY lane/x abc1234']]) assert.equal(rules.readyLine(value), null);
});

test('a stored delivery line is validated like every other field of a queue item', () => {
  const item = { id: 'i', text: 'Task', assignee: null, status: 'done', createdAt: NOW };
  assert.deepEqual(rules.validateQueue([{ ...item, ready: READY }])[0].ready, READY);
  for (const ready of [null, 'READY lane/x abc1234', [], { branch: 'lane/x' }, { commit: 'abc1234' }, { branch: '-x', commit: 'abc1234' },
    { branch: 'a..b', commit: 'abc1234' }, { branch: 'a b', commit: 'abc1234' }, { branch: 'lane/x', commit: 'ABC1234' },
    { branch: 'lane/x', commit: 'abc123' }, { branch: 7, commit: 'abc1234' }, { branch: 'lane/x', commit: 1234567 }]) {
    assert.throws(() => rules.validateQueue([{ ...item, ready }]), /Invalid queue delivery line/, JSON.stringify(ready));
  }
  const later = { ...READY, addedByALaterBuild: ['kept'] };
  assert.deepEqual(rules.validateQueue([{ ...item, ready: later }])[0].ready, later, 'A key this build does not know never makes the queue unreadable');
});

test('settling reads the line from the whole reply, for a finished item and for one that waits for the person', () => {
  const member = (text, extra = {}) => ({ id: 'a', name: 'Agent a', provider: 'claude', nativeId: 'native-a', state: 'idle', roomIds: ['shared'], roomId: 'shared',
    createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', controlRevision: 0,
    serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [{ id: 't1', role: 'user', origin: 'queue', text: 'sent', time: NOW - 30000 },
      ...(text === null ? [] : [{ id: 'r1', role: 'assistant', text, time: NOW - 20000 }])], ...extra });
  const item = { id: '1', text: 'Synthetic task', assignee: null, status: 'sent', createdAt: NOW - 60000, sentTo: 'a', sentAt: NOW - 30000, tag: 't1', control: 0 };
  const settle = (text, extra) => rules.planDispatch({ rooms: [{ id: 'shared', queue: [item] }], sessions: [member(text, extra)], wakePolicy: { enabled: true },
    idleSince: new Map([['a', NOW - 60000]]), now: NOW }).find(action => action.kind === 'settle');
  const long = 'x'.repeat(400) + '\nREADY lane/member-task abc1234';
  assert.deepEqual(settle(long).ready, READY, 'The stored 200-character reply would have lost the line');
  assert.equal(settle(long).status, 'done');
  const decision = settle('需要你决定：merge now?\nREADY lane/member-task abc1234');
  assert.equal(decision.status, 'waiting'); assert.deepEqual(decision.ready, READY);
  const intervened = settle('READY lane/member-task abc1234', { controlRevision: 1 });
  assert.equal(intervened.reason, 'person-intervened'); assert.deepEqual(intervened.ready, READY);
  assert.equal(Object.hasOwn(settle('Finished the notes.'), 'ready'), false);
  assert.equal(Object.hasOwn(settle('READY ../x abc1234'), 'ready'), false);
  const missing = settle(null, { messages: [] });
  assert.equal(missing.reason, 'record-missing'); assert.equal(Object.hasOwn(missing, 'ready'), false);
});

test('the dispatcher hands the line to the space record with the outcome', () => {
  const calls = [];
  // settle() first asks, through its own stillSent, whether the item is still out (the person or the butler may have closed it).
  rules.QueueDispatcher.prototype.settle.call({ roomState: { queueFind: () => ({ status: 'sent' }), queueSettle: (...args) => calls.push(args) },
    stillSent: rules.QueueDispatcher.prototype.stillSent, name: () => 'Member', broadcast: async () => {} },
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'done', sessionId: 'a', reply: 'line', ready: READY }, { sessions: [{ id: 'a' }] });
  assert.deepEqual(calls, [['shared', '1', 'done', '', 'Member', 'line', undefined, READY]]);
  rules.QueueDispatcher.prototype.settle.call({ roomState: { queueFind: () => ({ status: 'sent' }), queueSettle: (...args) => calls.push(args) },
    stillSent: rules.QueueDispatcher.prototype.stillSent, name: () => 'Member', broadcast: async () => {} },
    { kind: 'settle', roomId: 'shared', itemId: '2', status: 'done', sessionId: 'a', reply: 'PASS More detail', reportTitle: 'PASS' }, { sessions: [{ id: 'a' }] });
  assert.deepEqual(calls[1], ['shared', '2', 'done', '', 'Member', 'PASS More detail', undefined, undefined, 'PASS']);
});

test('E2: a finished item with a delivery line is recorded once, with the write that finished it', t => {
  const f = room(t), id = f.sent('Build the synthetic thing');
  f.state.queueSettle('shared', id, 'done', '', 'Member', 'short reply', undefined, READY);
  const saved = f.reopen(), events = saved.metadata().events.filter(event => event.monitor?.kind === 'ready');
  assert.deepEqual(saved.queueFind('shared', id).ready, READY);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].monitor, { kind: 'ready', key: `ready:shared:${id}`, itemId: id, branch: READY.branch, commit: READY.commit });
  assert.equal(events[0].sessionId, 'member'); assert.equal(events[0].kind, 'queue'); assert.equal(events[0].role, 'system');
  assert.equal(events[0].uiMessage.key, 'notice.queue.ready');
  assert.deepEqual(events[0].uiMessage.params, { text: 'Build the synthetic thing', branch: READY.branch, commit: READY.commit, name: 'Member' });
  assert.equal(locale.format('en', events[0].uiMessage.key, events[0].uiMessage.params), 'Member delivered READY: lane/member-task abc1234 (Build the synthetic thing)');
  assert.equal(events[0].text, 'Member 交付 READY：lane/member-task abc1234（Build the synthetic thing）');
  assert.equal(f.outcomes.length, 0, 'A delivery is a record, not a decision notification');
  assert.throws(() => f.state.queueSettle('shared', id, 'done', '', 'Member', '', undefined, READY), 'A settled item cannot be settled, or recorded, again');
  assert.equal(f.facts('ready').length, 1);
});

test('E2: a person-assigned finished item without a delivery line stays a status only; a 40-character commit is shown short', t => {
  const f = room(t), plain = f.state.queueAdd('Write the notes', null, 'shared', { kind: 'person', name: 'Synthetic person', sessionId: null });
  f.send(plain); const before = f.state.metadata().events.length;
  f.add('Keeps the space busy');
  f.state.queueSettle('shared', plain, 'done', '', 'Member', 'Notes written.');
  assert.equal(f.state.metadata().events.length, before + 1, 'Only the added item wrote a record');
  assert.equal(f.state.queueFind('shared', plain).ready, undefined);
  const full = f.sent('Long commit');
  f.state.queueSettle('shared', full, 'done', '', 'Member', '', undefined, { branch: 'lane/x', commit: SHA });
  const event = f.facts('ready')[0];
  assert.equal(event.uiMessage.params.commit, 'a'.repeat(12)); assert.equal(event.monitor.commit, SHA);
});

test('E2: a delivery line on an item that waits for the person is kept, and recorded when the person marks it handled', t => {
  const f = room(t), id = f.sent('Needs a decision first'), other = f.sent('Waits without a delivery');
  f.state.queueSettle('shared', id, 'waiting', '', 'Member', '需要你决定：merge?', 'merge?', READY);
  f.state.queueSettle('shared', other, 'waiting', 'no-reply', 'Member');
  assert.deepEqual(f.reopen().queueFind('shared', id).ready, READY);
  assert.equal(f.facts('ready').length, 0, 'Not a delivery until the person has dealt with the item');
  f.state.queueResolve(other);
  assert.equal(f.facts('ready').length, 0, 'An item without a line records nothing when handled');
  f.state.queueResolve(id);
  const events = f.reopen().metadata().events;
  assert.equal(events.filter(event => event.monitor?.kind === 'ready').length, 1);
  assert.equal(events.at(-1).uiMessage.key, 'notice.queue.resolved', 'The write keeps its own record last');
  assert.equal(events.at(-2).monitor.key, `ready:shared:${id}`);
  assert.equal(events.at(-2).time, events.at(-1).time);
  assert.throws(() => f.state.queueResolve(id)); assert.equal(f.facts('ready').length, 1);
});

test('E2: a failed or cancelled item never records a delivery, and a bad line is refused before anything is saved', t => {
  const f = room(t), failed = f.sent('Fails'), cancelled = f.add('Cancelled');
  f.state.queueSettle('shared', failed, 'failed', 'send-unconfirmed', 'Member', '', undefined, READY);
  f.state.queueCancel(cancelled);
  assert.equal(f.facts('ready').length, 0);
  const bad = f.sent('Bad line'), before = JSON.stringify(f.state.metadata());
  for (const ready of [{ branch: '--upload-pack=x', commit: 'abc1234' }, { branch: 'lane/x', commit: 'not-hex' }, 'READY lane/x abc1234']) {
    assert.throws(() => f.state.queueSettle('shared', bad, 'done', '', 'Member', '', undefined, ready), /Invalid queue delivery line/);
  }
  assert.equal(JSON.stringify(f.state.metadata()), before); assert.equal(f.state.queueFind('shared', bad).status, 'sent');
  assert.equal(JSON.stringify(f.reopen().metadata()), before);
});

test('E2: when the dispatch record is gone the delivery is still recorded, without a name', t => {
  const f = room(t), id = f.sent('History cleared meanwhile');
  f.state.update({ events: [] });
  f.state.queueSettle('shared', id, 'done', '', 'Member', '', undefined, READY);
  const event = f.facts('ready')[0];
  assert.equal(event.uiMessage.key, 'notice.queue.readyUnnamed'); assert.equal(event.text, '交付 READY：lane/member-task abc1234（History cleared meanwhile）');
  assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), 'Delivered READY: lane/member-task abc1234 (History cleared meanwhile)');
});

for (const [name, sentFirst, close] of [
  ['finishes', true, (f, id) => f.state.queueSettle('shared', id, 'done', '', 'Member', 'ok')],
  ['fails', true, (f, id) => f.state.queueSettle('shared', id, 'failed', 'member-missing', 'Member')],
  ['is cancelled', false, (f, id) => f.state.queueCancel(id)],
]) {
  test(`E1: the space is recorded as out of work once when its last item ${name}`, t => {
    const f = room(t), first = f.add('First'), last = f.add('Last');
    if (sentFirst) { f.send(first); f.send(last); }
    close(f, first);
    assert.equal(f.facts('queue-dry').length, 0, 'Another item is still queued or sent');
    close(f, last);
    const events = f.reopen().metadata().events.filter(event => event.monitor?.kind === 'queue-dry');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].monitor, { kind: 'queue-dry', key: 'queue-dry:shared:1', round: 1, waiting: 0 });
    assert.equal(events[0].uiMessage.key, 'notice.queue.dry'); assert.equal(events[0].text, '这个空间的活清空了');
    assert.equal(locale.format('en', 'notice.queue.dry'), 'This space has no queued work left');
    assert.equal(events[0].sessionId, undefined);
    assert.equal(f.reopen().metadata().queueDryRound, 1);
  });
}

test('E1: items that only wait for the person do not hide that nothing is left to send; handling them is not a second record', t => {
  const f = room(t), a = f.sent('Decision A'), b = f.sent('Decision B');
  f.state.queueSettle('shared', a, 'waiting', '', 'Member', '需要你决定：A?', 'A?');
  assert.equal(f.facts('queue-dry').length, 0, 'B is still sent');
  f.state.queueSettle('shared', b, 'waiting', 'no-reply', 'Member');
  const [event] = f.facts('queue-dry');
  assert.deepEqual(event.monitor, { kind: 'queue-dry', key: 'queue-dry:shared:1', round: 1, waiting: 2 });
  assert.equal(event.uiMessage.key, 'notice.queue.dryWaiting'); assert.equal(event.text, '这个空间没有可派的活了，还有 2 项等你处理');
  assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), 'No work is left to send in this space. Waiting for you: 2');
  f.state.queueResolve(a); f.state.queueResolve(b);
  assert.equal(f.facts('queue-dry').length, 1);
  assert.equal(f.reopen().metadata().events.filter(e => e.monitor?.kind === 'queue-dry').length, 1);
});

test('E1: each new round of work is recorded once; a restart keeps the round and writes that close nothing record nothing', t => {
  const f = room(t), first = f.sent('Round one');
  f.state.queueSettle('shared', first, 'done', '', 'Member', 'ok');
  assert.deepEqual(f.facts('queue-dry').map(e => e.monitor.round), [1]);
  const restarted = f.reopen();
  assert.equal(restarted.metadata().queueDryRound, 1);
  const second = restarted.queueAdd('Round two', null);
  assert.equal(restarted.metadata().queueDryRound, 1);
  assert.equal(restarted.metadata().events.filter(e => e.monitor?.kind === 'queue-dry').length, 1, 'Adding work is not a record');
  restarted.queueMarkSent('shared', second, 'member', 'Member', NOW);
  restarted.queueSetDelivery('shared', second, 'tag-1', 0);
  restarted.queueRequeue('shared', second, 'busy', 5, 'Member');
  restarted.queueMarkSent('shared', second, 'member', 'Member', NOW);
  assert.equal(restarted.metadata().events.filter(e => e.monitor?.kind === 'queue-dry').length, 1, 'Sending, tagging and requeueing close nothing');
  restarted.queueSettle('shared', second, 'done', '', 'Member', 'ok');
  const again = new RoomState(f.dir);
  assert.deepEqual(again.metadata().events.filter(e => e.monitor?.kind === 'queue-dry').map(e => e.monitor.key), ['queue-dry:shared:1', 'queue-dry:shared:2']);
  assert.deepEqual(rules.planDispatch({ rooms: again.apply({ sessions: [], rooms: [] }, 'shared').rooms, sessions: [], wakePolicy: { enabled: true },
    idleSince: new Map(), now: NOW }).filter(action => action.kind !== 'rotate'), [], 'A pass over an empty queue plans no write');
});

test('E1: a refusal that exhausts its attempts closes the item, and each space keeps its own round', t => {
  const f = room(t), other = f.state.create('Other synthetic space');
  const stuck = f.sent('Never accepted');
  f.state.queueRequeue('shared', stuck, 'busy', 1, 'Member');
  assert.equal(f.state.queueFind('shared', stuck).status, 'failed');
  assert.deepEqual(f.facts('queue-dry').map(e => e.monitor.key), ['queue-dry:shared:1']);
  assert.equal(f.facts('queue-dry', other).length, 0);
  const there = f.sent('In the other space', other);
  f.state.queueSettle(other, there, 'done', '', 'Member', 'ok');
  assert.deepEqual(f.facts('queue-dry', other).map(e => e.monitor.key), [`queue-dry:${other}:1`]);
  assert.equal(f.facts('queue-dry').length, 1);
});

test('E1: a damaged counter never makes the space unreadable; the next emptied queue is recorded once', t => {
  const f = room(t), id = f.sent('Counter damaged on disk');
  const file = path.join(f.dir, 'room-state.json'), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.queueDryRound = 'damaged';
  fs.writeFileSync(file, JSON.stringify(raw));
  const old = f.reopen();
  assert.equal(old.warning, '');
  old.queueSettle('shared', id, 'waiting', 'no-reply', 'Member');
  old.queueResolve(id);
  assert.deepEqual(old.metadata().events.filter(e => e.monitor?.kind === 'queue-dry').map(e => e.monitor.key), ['queue-dry:shared:1']);
  assert.equal(old.metadata().queueDryRound, 1);
});

test('E1: a queue that was already dry before this build records nothing until a write takes its last item to send away', t => {
  const f = room(t), waiting = f.sent('Settled by an older build'), done = f.sent('Also settled earlier');
  f.state.queueSettle('shared', waiting, 'waiting', 'no-reply', 'Member');
  f.state.queueSettle('shared', done, 'done', '', 'Member', 'ok');
  const file = path.join(f.dir, 'room-state.json'), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.queueDryRound; raw.events = raw.events.filter(event => !event.monitor);
  fs.writeFileSync(file, JSON.stringify(raw));
  const old = f.reopen();
  old.queueResolve(waiting);
  assert.equal(old.metadata().events.filter(e => e.monitor).length, 0, 'Handling an old waiting item empties nothing');
  assert.equal(old.metadata().queueDryRound, undefined);
  // An older build adds and finishes items without knowing the counter; the next real emptying still gets its own key.
  const next = old.queueAdd('First item under this build', null);
  old.queueMarkSent('shared', next, 'member', 'Member', NOW);
  old.queueSettle('shared', next, 'done', '', 'Member', 'ok');
  assert.deepEqual(old.metadata().events.filter(e => e.monitor).map(e => e.monitor.key), ['queue-dry:shared:1']);
});

test('E3 unchanged: the decision notification still names the outcome record, which stays the last event of its write', t => {
  for (const [status, reason] of [['waiting', ''], ['failed', 'send-unconfirmed']]) {
    const f = room(t), id = f.sent('Decide and deliver');
    f.state.queueSettle('shared', id, status, reason, 'Member', '需要你决定：Proceed?', 'Proceed?', READY);
    const events = f.reopen().metadata().events, outcome = events.at(-1);
    assert.equal(f.outcomes.length, 1);
    assert.equal(f.outcomes[0].eventId, outcome.id);
    assert.equal(outcome.uiMessage.key, status === 'waiting' ? 'notice.queue.waiting' : 'notice.queue.failed');
    assert.equal(outcome.monitor, undefined);
    assert.equal(events.at(-2).monitor.kind, 'queue-dry', 'The same write also noticed that nothing is left to send');
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
  }
});

test('a detached queue copy does not share the stored delivery line', t => {
  const f = room(t), id = f.sent('Copy me');
  f.state.queueSettle('shared', id, 'done', '', 'Member', '', undefined, READY);
  const shown = f.state.apply({ sessions: [], rooms: [] }, 'shared').room.queue.find(item => item.id === id);
  assert.deepEqual(shown.ready, READY);
  shown.ready.branch = 'changed';
  assert.equal(f.state.queueFind('shared', id).ready.branch, READY.branch);
});

test('a member is told how to report a delivery in every dispatch and in the shared rules; the examples themselves are not deliveries', () => {
  const text = rules.dispatchText('Synthetic space', { text: 'Synthetic task' }), lines = text.split('\n');
  assert.equal(lines[0], '【NAW 派活】空间「Synthetic space」队列里的下一件：'); assert.equal(lines[2], 'Synthetic task');
  assert.equal(lines[4], '做完这一件就结束本轮：不留后台命令（要等审查或测试，就在本轮里用长等待等到它结束）、不留运行中的队友、不开 goal，也不要自己去任务板认领别的任务，NAW 会接着派下一件。需要人来决定时，本轮最后一条回复的第一行写「需要你决定：」，NAW 会提醒人，并接着给你派下一件；人的答复会直接发到你这里。',
    'What members were already told is unchanged');
  assert.equal(lines.length, 6);
  assert.ok(lines[5].includes('READY <分支名> <分支上最新的提交号，7 到 40 位>') && lines[5].includes('没有提交就不写这一行'));
  assert.equal(rules.readyLine(text), null, 'A member that quotes the instruction has not delivered anything');
  assert.equal(rules.readyLine(lines[5] + '\nREADY <分支名> <分支上最新的提交号，7 到 40 位>'), null);
  // Every form the instruction forbids is one that settling does not recognise, and each is named in the instruction.
  for (const [word, reply] of [
    ['反引号', '`READY lane/member-task 0123abc`'], ['反引号', 'READY `lane/member-task` `0123abc`'], ['加粗', '**READY** lane/member-task 0123abc'],
    ['加粗', '**READY lane/member-task 0123abc**'], ['不加引号、', '"READY lane/member-task 0123abc"'], ['不加引号、', '「READY lane/member-task 0123abc」'],
    ['列表符号', '- READY lane/member-task 0123abc'], ['列表符号', '1. READY lane/member-task 0123abc'], ['行尾不加句号', 'READY lane/member-task 0123abc。'],
    ['行尾不加句号', 'READY lane/member-task 0123abc.'], ['各用一个空格隔开', 'READY  lane/member-task 0123abc'], ['各用一个空格隔开', 'READY　lane/member-task　0123abc'],
    ['7 到 40 位', 'READY lane/member-task 0123ab'], ['7 到 40 位', `READY lane/member-task ${'a'.repeat(64)}`],
  ]) {
    assert.ok(lines[5].includes(word), word);
    assert.equal(rules.readyLine('改好了。\n' + reply), null, reply);
  }
  // The line goes after the first line: a decision request must stay first to be read as one.
  assert.ok(lines[5].includes('不要放在第一行'));
  // What the instruction asks for is what settling recognises, also after a decision request and before closing remarks.
  assert.deepEqual(rules.readyLine('改好了，测试 12/12。\nREADY lane/member-task 0123abc'), { branch: 'lane/member-task', commit: '0123abc' });
  assert.deepEqual(rules.readyLine('需要你决定：现在合并吗？\nREADY lane/member-task 0123abc\n我先停在这里。'), { branch: 'lane/member-task', commit: '0123abc' });
  const shared = fs.readFileSync(path.join(__dirname, '../../CLAUDE.md'), 'utf8');
  const rule = shared.slice(shared.indexOf('A member of a space whose NAW queue the person uses ends each turn idle'));
  assert.ok(rule.includes('`READY <branch> <commit>`') && rule.includes('an item without commits has no such'), 'The shared rule says the same');
  for (const word of ['after its first', 'single', 'no quotes, backticks,', 'bold, list marker or closing period', '7 to 40 hex characters']) assert.ok(rule.includes(word), word);
  assert.equal(rules.readyLine(shared), null, 'The shared rule holds no line that reads as a delivery');
});
