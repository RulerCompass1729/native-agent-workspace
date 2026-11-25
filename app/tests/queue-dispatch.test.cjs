const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const rules = require('../queue-dispatch.cjs');
const { CompactionCounter } = require('../compaction-count.cjs');
const { RoomState } = require('../room-state.cjs');
const uiLocale = require('../ui-locale.js');
const { StewardRole } = require('../steward-role.cjs');
const { QuietWindows } = require('../quiet-windows.cjs');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const AWAKE = { enabled: true };
const GUARDED_STOP = 'guardedSessionStopV1';
const CONDITIONAL_STOP = 'conditionalMaintenanceStopV1';
const PARTICIPANT_STOP = 'participantMaintenanceStopV1';
const { sessionPlan, sameStop } = require('../backend-switch.cjs');

function member(id, extra = {}) {
  const value = {
    id,
    name: `Agent ${id}`,
    provider: 'claude',
    nativeId: `native-${id}`,
    model: 'claude-test-model',
    state: 'idle',
    roomIds: ['shared'],
    roomId: 'shared',
    createdAt: NOW - HOUR,
    background: 0,
    scheduled: 0,
    backgroundStale: false,
    chatAvailable: true,
    liveDraft: '',
    controlRevision: 0,
    draftRevision: 0,
    placementRevision: 0,
    serviceCapabilities: [rules.CAPABILITY, GUARDED_STOP],
    fleet: [],
    messages: [],
    ...extra,
  };
  // t1/t2 are this fixture's queue item 1/2 inputs; real backend rows already carry these fields.
  value.messages = value.messages.map(m => /^t[12]$/.test(m.id) && m.role === 'user' ?
    { origin: 'naw-dispatch', dispatchItem: m.id.slice(1), ...m } : m);
  return value;
}

// A conversation with enough records to be due for a new session (rules.CONTENT_LIMITS).
function heavyMessages(provider = 'claude') {
  const messages = [];
  for (let index = 0; index < rules.CONTENT_LIMITS[provider]; index += 1) {
    messages.push({ id: `old-${index}`, role: 'assistant', text: 'earlier work' });
  }
  return messages;
}

function item(id, extra = {}) {
  return { id, text: `task ${id}`, assignee: null, status: 'queued', createdAt: NOW - 1000, ...extra };
}

function settledSince(ids) {
  const idle = new Map();
  for (const id of ids) {
    idle.set(id, NOW - 60000);
  }
  return idle;
}

function plan(rooms, sessions, extra = {}) {
  const ids = [];
  for (const session of sessions) {
    ids.push(session.id);
  }
  return rules.planDispatch({
    rooms,
    sessions,
    wakePolicy: AWAKE,
    idleSince: settledSince(ids),
    now: NOW,
    ...extra,
  });
}

function sentItem(extra = {}) {
  return item('1', { status: 'sent', sentTo: 'a', sentAt: NOW - 30000, tag: 't1', control: 0, ...extra });
}

test('a queue rejects malformed items instead of guessing', () => {
  assert.deepEqual(rules.validateQueue(undefined), []);
  assert.equal(rules.validateQueue([item('a')]).length, 1);
  assert.throws(() => rules.validateQueue([item('a'), item('a')]), /Duplicate/);
  assert.throws(() => rules.validateQueue([item('a', { status: 'running' })]), /Invalid/);
  assert.throws(() => rules.validateQueue([item('a', { text: 'bad\u0007bell' })]), /Invalid/);
  assert.throws(() => rules.validateQueue([item('a', { attempts: -1 })]), /Invalid/);
  assert.throws(() => rules.newItem('   ', null), /Invalid/);
  const fresh = rules.newItem('line one\nline two', null, NOW);
  assert.equal(fresh.status, 'queued');
  assert.equal(fresh.assignee, null);
});

test('only a truly idle, unpaused member on an updated backend with no draft or background work is ready', () => {
  assert.equal(rules.sessionReady(member('a'), AWAKE).ready, true);
  const cases = [
    [member('a', { state: 'working' }), 'not-idle'],
    [member('a', { wakeDisabled: true }), 'paused'],
    [member('a', { liveDraft: 'half typed' }), 'person-typing'],
    [member('a', { background: 2 }), 'background-work'],
    [member('a', { backgroundStale: true }), 'background-unconfirmed'],
    [member('a', { pendingTag: 'tag' }), 'busy'],
    [member('a', { approval: { id: 1 } }), 'busy'],
    [member('a', { chatAvailable: false }), 'unavailable'],
    [member('a', { archived: true }), 'archived'],
    [member('a', { serviceCapabilities: ['collaborationSpacesV1'] }), 'backend-update-needed'],
    [member('a', { provider: 'codex', nativeGoal: { status: 'active' } }), 'native-goal-active'],
  ];
  for (const [session, reason] of cases) {
    assert.deepEqual(rules.sessionReady(session, AWAKE), { ready: false, reason });
  }
  assert.equal(rules.sessionReady(member('a'), { enabled: false }).reason, 'automatic-messages-off');
  const runningChild = member('a', { fleet: [{ event: 'SubagentStart', id: 'child', stale: false, time: NOW }] });
  assert.equal(rules.sessionReady(runningChild, AWAKE).reason, 'team-running');
  // A child record from before a restart is unknown, not running: it must not block forever.
  const staleChild = member('a', { fleet: [{ event: 'SubagentStart', id: 'child', stale: true, time: NOW }] });
  assert.equal(rules.sessionReady(staleChild, AWAKE).ready, true);
});

test('each idle member gets exactly one next item; an assigned item waits for its member', () => {
  const rooms = [{ id: 'shared', name: 'Team', memberOrder: ['a', 'b'], queue: [item('1'), item('2'), item('3', { assignee: 'b' })] }];
  assert.deepEqual(plan(rooms, [member('a'), member('b')]), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' },
    { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'b' },
  ]);
});

test('a member that just became idle, or that the person just used, is not sent anything', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  assert.deepEqual(plan(rooms, [member('a')], { idleSince: new Map([['a', NOW - 1000]]) }), []);
  assert.deepEqual(plan(rooms, [member('a')], { humanAt: new Map([['a', NOW - 30000]]) }), []);
  assert.equal(plan(rooms, [member('a')], { humanAt: new Map([['a', NOW - 5 * 60000]]) }).length, 1);
});

test('a member taking part in a running space collaboration is left alone', () => {
  const rooms = [{ id: 'shared', name: 'Team', run: { status: 'running', ids: ['a'] }, queue: [item('1')] }];
  assert.deepEqual(plan(rooms, [member('a')]), []);
});

test('paused members are skipped; claimable work goes to the next ready member', () => {
  const rooms = [{ id: 'shared', name: 'Team', memberOrder: ['a', 'b'], queue: [item('1'), item('2', { assignee: 'a' })] }];
  assert.deepEqual(plan(rooms, [member('a', { wakeDisabled: true }), member('b')]), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'b' },
  ]);
});

test('a finished item settles as done and the same member gets the next item in the same pass', () => {
  const messages = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: 'Done: changed the file.' },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'done', sessionId: 'a', reply: 'Done: changed the file.' },
    { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a' },
  ]);
});

test('an interrupted or silent turn, or the person stepping in, is left for the person and holds the member for that pass only', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  const silent = [{ id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' }];
  assert.deepEqual(plan(rooms, [member('a', { messages: silent })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', reason: 'no-reply', sessionId: 'a' },
  ]);
  const personWrote = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'h1', role: 'user', text: 'stop, do it differently', origin: 'human' },
    { id: 'r1', role: 'assistant', text: 'OK, changed approach.' },
  ];
  assert.deepEqual(plan(rooms, [member('a', { messages: personWrote })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', reason: 'person-intervened', sessionId: 'a', reply: 'OK, changed approach.' },
  ]);
  // Interrupting from NAW or typing in the native terminal moves the control revision.
  const answered = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: 'partial work' },
  ];
  assert.deepEqual(plan(rooms, [member('a', { messages: answered, controlRevision: 3 })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', reason: 'person-intervened', sessionId: 'a', reply: 'partial work' },
  ]);
  // On the next pass such an item asks nothing of the member: it stays open for the person to look at,
  // and the member takes the next item, its own or anyone's (11-12: these held members until the person
  // pressed a button, and the items behind them never went out).
  for (const reason of ['person-intervened', 'no-reply']) {
    const later = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting', reason }), item('2', { assignee: 'a' }), item('3')] }];
    assert.deepEqual(plan(later, [member('a', { messages: answered, controlRevision: 3 }), member('b')]), [
      { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a' },
      { kind: 'dispatch', roomId: 'shared', itemId: '3', sessionId: 'b' },
    ], reason);
  }
});

test('a reply that asks for a decision is left for the person; its member takes the next item in the same session', () => {
  // 11-13: one member's 「需要你决定」 held it for 88 minutes while four unrelated items waited behind it. The person:
  // 「之后我不在,你要保证一直开发」. The item stays open as 等你决定 until they handle it; the member works on meanwhile.
  const messages = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: '需要你决定：要不要删旧分支？' },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2', { assignee: 'a' })] }];
  // The pass that settles it sends that member nothing more.
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', sessionId: 'a', question: '要不要删旧分支？', reply: '需要你决定：要不要删旧分支？' },
  ]);
  // From the next pass it takes its next item: its own, anyone's, or one in another of its spaces.
  const later = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' }), item('2', { assignee: 'a' }), item('3')] }];
  // Each is marked as sent while that decision is open (afterDecision; see the next test).
  const next = { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a', afterDecision: true };
  assert.deepEqual(plan(later, [member('a', { messages })]), [next]);
  const unassigned = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' }), item('2')] }];
  assert.deepEqual(plan(unassigned, [member('a', { messages })]), [next]);
  const two = 'abcdef01-2345-4678-9abc-def012345678';
  const elsewhere = [{ id: 'shared', name: 'One', queue: [sentItem({ status: 'waiting' })] }, { id: two, name: 'Two', queue: [item('2')] }];
  assert.deepEqual(plan(elsewhere, [member('a', { messages, roomIds: ['shared', two] })]), [{ ...next, roomId: two }]);
  // 11-23 (the person: 「否则会影响效率浪费 token」): an open decision no longer keeps the session. A member due for
  // a new one is rotated before its next item, and when quiet, like any other; the decision goes to the successor.
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: [...heavyMessages(), ...messages] });
  const rotate = [{ kind: 'rotate', sessionId: 'a', reason: 'content' }];
  assert.deepEqual(plan(later, [old]), rotate);
  const quiet = { ...old, lastActivityAt: NOW - 30 * 60000 };
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' })] }], [quiet]), rotate);
  // Once the person has handled it, nothing changes: the session is rotated before its next item.
  const handled = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'done' }), item('2', { assignee: 'a' })] }];
  assert.deepEqual(plan(handled, [old]), rotate);
  // The person's answer goes first: while they have just written to the member, NAW sends it nothing.
  assert.deepEqual(plan(later, [member('a', { messages })], { humanAt: new Map([['a', NOW - 30000]]) }), []);
  // A person-intervened or empty item asks nothing, so what follows it is sent as usual.
  const looked = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting', reason: 'no-reply' }), item('2')] }];
  assert.deepEqual(plan(looked, [member('a', { messages })]), [{ kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a' }]);
});

test('an item sent while its member\'s decision is open keeps its own reply and READY line when the person answers that decision', t => {
  // Independent review, 11-13: the person answering item 1 while the member works on item 2 made the answer's
  // reply and READY line item 2's, or lost item 2's own. Item 2 is still left for the person to look at.
  const messages = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: '需要你决定：要不要合并？' },
    { id: 't2', role: 'user', text: 'NAW task two', origin: 'naw-dispatch' },
    { id: 'r2', role: 'assistant', text: '任务二完成\nREADY lane/x abc1234' },
    { id: 'h1', role: 'user', text: '合并吧', origin: 'human' },
    { id: 'r3', role: 'assistant', text: '已合并\nREADY lane/y def5678' },
  ];
  const second = extra => item('2', { status: 'sent', sentTo: 'a', sentAt: NOW - 20000, tag: 't2', control: 0, ...extra });
  const rooms = extra => [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' }), second(extra)] }];
  const settle = { kind: 'settle', roomId: 'shared', itemId: '2', status: 'waiting', reason: 'person-intervened', sessionId: 'a' };
  assert.deepEqual(plan(rooms({ afterDecision: true }), [member('a', { messages })]), [
    { ...settle, reply: '任务二完成 READY lane/x abc1234', ready: { branch: 'lane/x', commit: 'abc1234' } },
  ]);
  // The person wrote before the member replied to item 2: it has no reply of its own yet.
  const early = [...messages.slice(0, 3), messages[4], messages[5]];
  assert.deepEqual(plan(rooms({ afterDecision: true }), [member('a', { messages: early })]), [settle]);
  // Sent with no decision open, the person writing is about this item, and the last reply stands, as before.
  assert.deepEqual(plan(rooms({}), [member('a', { messages })]), [
    { ...settle, reply: '已合并 READY lane/y def5678', ready: { branch: 'lane/y', commit: 'def5678' } },
  ]);
  // The send records the mark and a refusal drops it.
  const { room } = roomSetup(t);
  const id = room.queueAdd('任务二', 'a');
  room.queueMarkSent('shared', id, 'a', 'Agent a', NOW, true);
  assert.equal(room.queueItems('shared')[0].afterDecision, true);
  room.queueRequeue('shared', id, 'Synthetic refusal', 5, 'Agent a');
  assert.equal(room.queueItems('shared')[0].afterDecision, undefined);
  room.queueMarkSent('shared', id, 'a', 'Agent a', NOW);
  assert.equal(room.queueItems('shared')[0].afterDecision, undefined);
  assert.throws(() => rules.validateQueue([item('x', { afterDecision: 'yes' })]), /Invalid/);
});

// R141② acceptance 5 (the person, 11-23: 「要」; 「否则会影响效率浪费 token」). What a session wrote after the person
// answered its decision on the card was recorded on no item. The answered item stays handled and keeps the row the
// answer was delivered as (answerTag) until that reply is read.
const ANSWERED = [
  { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
  { id: 'r1', role: 'assistant', text: '需要你决定：要不要合并？' },
  { id: 'h1', role: 'user', text: '合并吧', origin: 'human' },
  { id: 'r3', role: 'assistant', text: '已合并\nREADY lane/y def5678' },
];
function answeredItem(extra = {}) {
  return sentItem({ status: 'done', finishedAt: NOW - 20000, answer: { text: '合并吧', deliveredAt: NOW - 20000 }, answerTag: 'h1', ...extra });
}

test('what a session writes after the person answered its decision on the card is recorded on that decision', () => {
  const rooms = queue => [{ id: 'shared', name: 'Team', queue }];
  const clear = { kind: 'answered', roomId: 'shared', itemId: '1', sessionId: 'a', tag: 'h1' };
  const record = { ...clear, reply: '已合并 READY lane/y def5678', ready: { branch: 'lane/y', commit: 'def5678' } };
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: ANSWERED })]), [record]);
  // Still working on the answer, or nothing written yet: nothing is recorded and the item keeps its mark.
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: ANSWERED, state: 'working' })]), []);
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: ANSWERED.slice(0, 3) })]), []);
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: ANSWERED })], { idleSince: new Map() }), [], 'not before the turn-end report settled');
  // A turn that failed left no reply of its own.
  const failed = [...ANSWERED.slice(0, 3), { id: 'r3', role: 'assistant', text: 'partial', nativeId: 'native-a', turnId: 'turn-9' },
    { id: 'turn-9', kind: 'turn', nativeId: 'native-a', turnId: 'turn-9', status: 'failed' }];
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: failed })]), []);
  // The session's own machinery (a background task reporting back) is part of the same work.
  const notified = [...ANSWERED.slice(0, 3), { id: 'n1', role: 'user', text: 'tests finished', origin: 'native', inputSource: 'task-notification' }, ANSWERED[3]];
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: notified })]), [record]);
  // The next item NAW sent, or another agent's message, starts something else: only what came before it counts.
  const nextItem = [...ANSWERED, { id: 't2', role: 'user', text: 'NAW task two', origin: 'naw-dispatch' }, { id: 'r4', role: 'assistant', text: '任务二完成\nREADY lane/x abc1234' }];
  const second = item('2', { status: 'done', sentTo: 'a', sentAt: NOW - 10000, tag: 't2', finishedAt: NOW - 5000 });
  assert.deepEqual(plan(rooms([answeredItem(), second]), [member('a', { messages: nextItem })]), [record]);
  const peer = [...ANSWERED, { id: 'w1', role: 'user', text: 'a colleague asks', origin: 'agent-wake' }, { id: 'r5', role: 'assistant', text: '回同事\nREADY lane/z 1234567' }];
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: peer })]), [record]);
  // Nothing of its own before that, the session gone, the row not the person's, or a day without a reply: the mark
  // is dropped and the item stays as the person left it. A row this record does not hold yet is waited for.
  const none = [...ANSWERED.slice(0, 3), nextItem[4], nextItem[5]];
  assert.deepEqual(plan(rooms([answeredItem(), second]), [member('a', { messages: none })]), [clear]);
  assert.deepEqual(plan(rooms([answeredItem()]), []), [clear]);
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: ANSWERED, archived: true })]), [clear]);
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: ANSWERED.slice(0, 2) })]), []);
  // Read only while the session rests: a row queued for a later turn is not yet where it will be.
  assert.deepEqual(plan(rooms([answeredItem(), second]), [member('a', { messages: nextItem, state: 'working' })]), []);
  // Another agent's message read inside the turn that works on the answer is part of that turn.
  const midturn = [...ANSWERED.slice(0, 3), { id: 'w2', role: 'user', text: 'a colleague asks', origin: 'agent-wake', deliveredInto: 'turn-3' }, ANSWERED[3]];
  assert.deepEqual(plan(rooms([answeredItem()]), [member('a', { messages: midturn })]), [record]);
  assert.deepEqual(plan(rooms([answeredItem({ answerTag: 't1' })]), [member('a', { messages: ANSWERED })]), [{ ...clear, tag: 't1' }]);
  const stale = answeredItem({ answer: { text: '合并吧', deliveredAt: NOW - 25 * HOUR } });
  assert.deepEqual(plan(rooms([stale]), [member('a', { messages: ANSWERED.slice(0, 3) })]), [clear]);
  assert.deepEqual(plan(rooms([stale]), [member('a', { messages: ANSWERED.slice(0, 3), state: 'working' })]), [clear]);
  assert.deepEqual(plan(rooms([stale]), [member('a', { messages: ANSWERED.slice(0, 2) })]), [clear]);
});

test('an answered decision and the item sent while it was open each keep their own reply and READY line', () => {
  // The 11-13 case above, once the person answered on the card: item 2 keeps what it wrote before the answer, and
  // the answer's reply, lost until now, goes on item 1.
  const messages = [
    ANSWERED[0], ANSWERED[1],
    { id: 't2', role: 'user', text: 'NAW task two', origin: 'naw-dispatch' },
    { id: 'r2', role: 'assistant', text: '任务二完成\nREADY lane/x abc1234' },
    ANSWERED[2], ANSWERED[3],
  ];
  const second = item('2', { status: 'sent', sentTo: 'a', sentAt: NOW - 20000, tag: 't2', control: 0, afterDecision: true });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [answeredItem(), second] }], [member('a', { messages })]), [
    { kind: 'answered', roomId: 'shared', itemId: '1', sessionId: 'a', tag: 'h1', reply: '已合并 READY lane/y def5678', ready: { branch: 'lane/y', commit: 'def5678' } },
    { kind: 'settle', roomId: 'shared', itemId: '2', status: 'waiting', reason: 'person-intervened', sessionId: 'a',
      reply: '任务二完成 READY lane/x abc1234', ready: { branch: 'lane/x', commit: 'abc1234' } },
  ]);
});

test('an answer read inside a turn that was already running is recorded on no item', () => {
  // The member was on item 2 when the person answered on the card, and read the answer inside that turn
  // (deliveredInto). What the turn ends with may be item 2's delivery: it must not become the decision's.
  const read = { ...ANSWERED[2], deliveredInto: 'turn-2' };
  const clear = { kind: 'answered', roomId: 'shared', itemId: '1', sessionId: 'a', tag: 'h1' };
  const messages = [
    ANSWERED[0], ANSWERED[1],
    { id: 't2', role: 'user', text: 'NAW task two', origin: 'naw-dispatch' },
    read,
    { id: 'r2', role: 'assistant', text: '任务二完成\nREADY lane/x abc1234' },
  ];
  const second = item('2', { status: 'sent', sentTo: 'a', sentAt: NOW - 20000, tag: 't2', control: 0, afterDecision: true });
  const cut = { kind: 'settle', roomId: 'shared', itemId: '2', status: 'waiting', reason: 'person-intervened', sessionId: 'a' };
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [answeredItem(), second] }], [member('a', { messages })]), [clear, cut]);
  // Item 2 is settled as it was before answers were marked.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [answeredItem({ answerTag: undefined }), second] }], [member('a', { messages })]), [cut]);
  // The same inside a turn another agent's message started.
  const peer = [ANSWERED[0], ANSWERED[1], { id: 'w1', role: 'user', text: 'a colleague asks', origin: 'agent-wake' }, read,
    { id: 'r5', role: 'assistant', text: '回同事\nREADY lane/z 1234567' }];
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [answeredItem()] }], [member('a', { messages: peer })]), [clear]);
  // The row says so as soon as it is read: the mark goes without waiting for the turn to end.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [answeredItem()] }], [member('a', { messages: peer, state: 'working' })]), [clear]);
});

test('a decision that went to a successor is recorded from the successor; an unanswered one is settled by nobody', () => {
  // The item names the successor (queueCarry), so the answer went there and its reply is read there.
  const carried = answeredItem({ sentTo: 'b', sentNative: 'native-b', askedBy: { id: 'a', nativeId: 'native-a' } });
  const successor = member('b', { messages: [{ id: 'handoff', role: 'user', text: '【NAW 换会话】…', origin: 'naw-dispatch' }, { id: 'ack', role: 'assistant', text: '接手了' }, ANSWERED[2], ANSWERED[3]] });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [carried] }], [member('a', { messages: ANSWERED, archived: true }), successor]), [
    { kind: 'answered', roomId: 'shared', itemId: '1', sessionId: 'b', tag: 'h1', reply: '已合并 READY lane/y def5678', ready: { branch: 'lane/y', commit: 'def5678' } },
  ]);
  // The person wrote in the session itself and never answered on the card: the decision stays open, as before.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' })] }], [member('a', { messages: ANSWERED })]), []);
  // An item the person marked 已处理 without an answer carries no mark: nothing is read for it.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'done' })] }], [member('a', { messages: ANSWERED })]), []);
});

test('an answer from the card marks the item with its row; the reply read later is added once, with its delivery line', t => {
  const { dir, room } = roomSetup(t);
  const asked = (text = '需要你决定：合吗？', ready) => {
    const id = room.queueAdd('任务', 'a');
    room.queueMarkSent('shared', id, 'a', 'Agent a', NOW - 60000, false, 'native-a');
    room.queueSetDelivery('shared', id, 't1', 0);
    room.queueSettle('shared', id, 'waiting', '', 'Agent a', text, '合吗？', ready);
    return id;
  };
  const deliveries = id => room.value.events.filter(e => e.monitor?.kind === 'ready' && e.monitor.itemId === id).map(e => [e.monitor.key, e.monitor.branch, e.monitor.commit, e.sessionId]);
  const id = asked();
  room.queueResolve(id, 'shared', null, '合并吧', 'a', 'h1');
  let item = room.queueFind('shared', id);
  assert.deepEqual([item.status, item.answer.text, item.answerTag, item.finishedAt === item.answer.deliveredAt], ['done', '合并吧', 'h1', true], 'handled at once, as before');
  assert.equal(new RoomState(dir).queueFind('shared', id).answerTag, 'h1', 'kept across a restart');
  assert.deepEqual(deliveries(id), []);
  assert.equal(room.queueAnswered('shared', id, 'other-row', 'x'), false, 'another row is not this answer');
  assert.equal(room.queueFind('shared', id).reply, '需要你决定：合吗？');
  const ready = { branch: 'lane/y', commit: 'def5678' };
  assert.equal(room.queueAnswered('shared', id, 'h1', '已合并 READY lane/y def5678', ready), true);
  item = room.queueFind('shared', id);
  assert.deepEqual([item.status, item.reply, item.ready, item.answerTag, item.answer.text], ['done', '已合并 READY lane/y def5678', ready, undefined, '合并吧']);
  assert.deepEqual(deliveries(id), [[`ready:shared:${id}`, 'lane/y', 'def5678', 'a']], 'the delivery is recorded in the space, once');
  assert.equal(room.queueAnswered('shared', id, 'h1', 'again', { branch: 'lane/q', commit: '7654321' }), false, 'read once');
  assert.deepEqual([room.queueFind('shared', id).reply, deliveries(id).length], ['已合并 READY lane/y def5678', 1]);
  // Nothing to read: only the mark goes.
  const quiet = asked();
  room.queueResolve(quiet, 'shared', null, '合并吧', 'a', 'h2');
  assert.equal(room.queueAnswered('shared', quiet, 'h2'), true);
  item = room.queueFind('shared', quiet);
  assert.deepEqual([item.status, item.reply, item.ready, item.answerTag], ['done', '需要你决定：合吗？', undefined, undefined]);
  // A question that carried a delivery line had it recorded when the person handled it: one delivery an item.
  const first = { branch: 'lane/w', commit: 'aaa1111' };
  const twice = asked('需要你决定：合吗？ READY lane/w aaa1111', first);
  room.queueResolve(twice, 'shared', null, '合并吧', 'a', 'h3');
  assert.equal(deliveries(twice).length, 1);
  room.queueAnswered('shared', twice, 'h3', '已合并 READY lane/y def5678', ready);
  item = room.queueFind('shared', twice);
  assert.deepEqual([item.reply, item.ready, deliveries(twice).length], ['已合并 READY lane/y def5678', first, 1]);
  // No row named (an older window, or the phone before it learns one): handled as before, with nothing to read.
  const plain = asked();
  room.queueResolve(plain, 'shared', null, '合并吧', 'a');
  assert.equal(room.queueFind('shared', plain).answerTag, undefined);
  // Received by the session before, after the decision moved: closed once there, and nothing more is read.
  const moved = asked();
  room.queueCarry('shared', 'a', 'b', 'native-b');
  room.queueResolve(moved, 'shared', null, '合并吧', 'a', 'h4');
  item = room.queueFind('shared', moved);
  assert.deepEqual([item.status, item.sentTo, item.answerTag], ['done', 'a', undefined]);
  // The person's 已处理 without an answer names no row either.
  const handled = asked();
  room.queueResolve(handled, 'shared', null);
  assert.equal(room.queueFind('shared', handled).answerTag, undefined);
  const bad = asked();
  assert.throws(() => room.queueResolve(bad, 'shared', null, '合并吧', 'a', 'bad\u0001row'), error => error.uiMessage?.key === 'error.queue.invalid');
  assert.equal(room.queueFind('shared', bad).status, 'waiting', 'a refused answer changes nothing');
  assert.throws(() => rules.validateQueue([answeredItem({ answerTag: 7 })]), /Invalid/);
  assert.throws(() => rules.validateQueue([answeredItem({ answerTag: '' })]), /Invalid/);
});

test('the dispatcher adds the answered session\'s reply and READY line to the decision; the item stays handled', async t => {
  // The space stamps the answer with the real clock, so the dispatcher reads the same one here.
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')], { now: () => Date.now() });
  const id = room.queueAdd('first task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '需要你决定：合吗？');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(room.queueFind('shared', id).status, 'waiting');
  // The person answers on the card: the text reaches the session as their own message, then the item is handled.
  const session = client.state.sessions[0];
  session.messages.push({ id: 'answer-row', role: 'user', text: '合并吧', origin: 'human', status: 'submitted' });
  session.state = 'working';
  room.queueResolve(id, 'shared', null, '合并吧', 'a', 'answer-row');
  dispatcher.dirty = true;
  await dispatcher.schedule();
  let item = room.queueFind('shared', id);
  assert.deepEqual([item.status, item.reply, item.answerTag], ['done', '需要你决定：合吗？', 'answer-row'], 'handled; nothing to read while the session works');
  client.reply('a', '已合并\nREADY lane/y def5678');
  await dispatcher.schedule();
  await dispatcher.schedule();
  item = room.queueFind('shared', id);
  assert.deepEqual([item.status, item.reply, item.ready, item.answerTag], ['done', '已合并 READY lane/y def5678', { branch: 'lane/y', commit: 'def5678' }, undefined]);
  assert.deepEqual(room.value.events.filter(e => e.monitor?.kind === 'ready').map(e => [e.monitor.itemId, e.monitor.branch, e.monitor.commit]), [[id, 'lane/y', 'def5678']]);
  assert.equal(client.sends().length, 1, 'nothing was sent to anyone for it');
});

test('a decision on an item that was refused once before it went out is still a decision: what follows is marked, and it goes with the session', t => {
  // Since 11-13 the send drops the refusal (queueMarkSent); an item saved by an older build still carries it through
  // the decision's settle (independent review, 11-12). Both are decisions: since 11-23 neither keeps the session.
  const { room } = roomSetup(t);
  const asked = room.queueAdd('任务一', 'a');
  room.queueMarkSent('shared', asked, 'a', 'Agent a', NOW - 60000);
  room.queueRequeue('shared', asked, 'Synthetic draft refusal', 5, 'Agent a');
  room.queueMarkSent('shared', asked, 'a', 'Agent a', NOW - 30000);
  room.queueSetDelivery('shared', asked, 't1', 0);
  // The planner passes '' as a decision's reason (QueueDispatcher, action.reason || '').
  room.queueSettle('shared', asked, 'waiting', '', 'Agent a', '需要你决定：合吗？', '合吗？');
  const next = room.queueAdd('任务二', 'a');
  const queue = room.queueItems('shared');
  assert.deepEqual([queue[0].status, queue[0].reason], ['waiting', undefined]);
  const saved = [{ ...queue[0], reason: 'Synthetic draft refusal' }, queue[1]];
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages() });
  for (const items of [queue, saved]) {
    const rooms = [{ id: 'shared', name: 'Team', queue: items }];
    const sent = { kind: 'dispatch', roomId: 'shared', itemId: next, sessionId: 'a', afterDecision: true };
    assert.deepEqual(plan(rooms, [member('a')]), [sent]);
    assert.deepEqual(plan(rooms, [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
    // With nothing queued behind it, the space can take more work.
    const open = [{ id: 'shared', name: 'Team', queue: [items[0]] }];
    const vacancy = rules.queueVacancies({ rooms: open, sessions: [member('a')], wakePolicy: AWAKE, idleSince: settledSince(['a']), now: NOW });
    assert.equal(vacancy[0].active, true);
    assert.deepEqual(vacancy[0].candidateIds, ['a']);
  }
});

test('a timestamp alone cannot settle an item when the original queue input is missing', () => {
  const messages = [
    { id: 'old', role: 'assistant', text: 'earlier work', time: NOW - 90000 },
    { id: 'native-user', role: 'user', text: 'NAW task', origin: 'naw-dispatch', time: NOW - 29000 },
    { id: 'r1', role: 'assistant', text: 'finished', time: NOW - 20000 },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'failed', reason: 'record-missing', sessionId: 'a' },
  ]);
  const silent = [{ id: 'old', role: 'assistant', text: 'earlier work', time: NOW - 90000 }];
  assert.deepEqual(plan(rooms, [member('a', { messages: silent })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'failed', reason: 'record-missing', sessionId: 'a' },
  ]);
});

test('a still-working member keeps its item in flight; an unconfirmed send is failed, never resent', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  assert.deepEqual(plan(rooms, [member('a', { state: 'working' })]), []);
  const lost = sentItem({ sentAt: NOW - 10 * 60000, tag: null });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [lost] }], [member('a')]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'failed', reason: 'send-unconfirmed', sessionId: 'a' },
  ]);
});

test('a member older than the rotation age is rotated before it receives its next item', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages() });
  assert.deepEqual(plan(rooms, [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  const failed = { a: { phase: 'failed' } };
  assert.deepEqual(plan(rooms, [old], { rotations: failed }), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' },
  ]);
  // With no queue the member is still rotated: it has been quiet since it was created a day ago.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [] }], [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
});

test('a session the caller names as engaged gets no queued item and is not rotated; the item goes to another member', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  assert.deepEqual(plan(rooms, [member('a'), member('b')], { engaged: ['a'] }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'b' }]);
  assert.deepEqual(plan(rooms, [member('a')], { engaged: ['a'] }), [], 'The item waits rather than go to it');
  // An item assigned to it by name waits as well.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [item('1', { assignee: 'a' })] }], [member('a'), member('b')], { engaged: ['a'] }), []);
  // It is not rotated either, with or without queued work.
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages() });
  assert.deepEqual(plan(rooms, [old], { engaged: ['a'] }), []);
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [] }], [old], { engaged: ['a'] }), []);
  // An item it was sent before is still settled.
  const sent = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  const replied = member('a', { messages: [{ id: 't1', role: 'user', text: 'task', origin: 'naw-dispatch', time: NOW - 30000 }, { id: 'r1', role: 'assistant', text: 'Done.', time: NOW - 20000 }] });
  assert.deepEqual(plan(sent, [replied], { engaged: ['a'] }).map(action => [action.kind, action.status]), [['settle', 'done']]);
  // Nobody named, or something that is not a list: the plan is as it always was.
  for (const engaged of [undefined, null, [], 'a', { a: true }]) {
    assert.deepEqual(plan(rooms, [member('a')], { engaged }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }], JSON.stringify(engaged));
  }
});

test('B2/B6: integration and trust holds are both busy while an unrelated member still gets work', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const sessions = ['integrator', 'successor', 'healthy'].map(id => member(id));
  const holds = { engaged: ['integrator'], heldSessions: new Set(['successor']) };
  assert.deepEqual(plan(rooms, sessions, holds), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'healthy' }]);
  for (const assignee of ['integrator', 'successor']) {
    assert.deepEqual(plan([{ ...rooms[0], queue: [item('1', { assignee })] }], sessions, holds), []);
  }
  const old = sessions.slice(0, 2).map(s => ({ ...s, createdAt: NOW - 25 * HOUR, messages: heavyMessages() }));
  assert.deepEqual(plan([{ ...rooms[0], queue: [] }], old, holds), [], 'neither reservation can be rotated away');
  assert.deepEqual(plan(rooms, sessions, { ...holds, quarantineUnknown: true }), [], 'unknown trust identity cannot be overridden by the other hold');
});

test('B2/B6: the vacancy projection retains both integration and trust holds', () => {
  const input = { rooms: [{ id: 'shared', name: 'Team', queue: [] }],
    sessions: ['integrator', 'successor', 'healthy'].map(id => member(id)), wakePolicy: AWAKE,
    idleSince: settledSince(['integrator', 'successor', 'healthy']), now: NOW,
    engaged: ['integrator'], heldSessions: new Set(['successor']) };
  const vacant = rules.queueVacancies(input)[0];
  assert.deepEqual(vacant.candidateIds, ['healthy']);
  assert.deepEqual(vacant.availableIds, ['healthy']);
  assert.equal(vacant.active, true);
  assert.equal(rules.queueVacancies({ ...input, quarantineUnknown: true })[0].active, false);
});

test('an old, quiet space member is rotated even with no work queued; a recent conversation is not cut off', () => {
  const finished = item('1', { status: 'done', sentTo: 'a', sentAt: NOW - 2 * HOUR, tag: 't1' });
  const rooms = [{ id: 'shared', name: 'Team', queue: [finished] }];
  const quiet = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(rooms, [quiet]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  const talking = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 10 * 60000 });
  assert.deepEqual(plan(rooms, [talking]), []);
  const young = member('a', { createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(rooms, [young]), []);
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [] }], [quiet]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  // A decision it asked goes with it to its successor: it does not keep the member from its rotation.
  const waiting = item('2', { status: 'waiting', sentTo: 'a', sentAt: NOW - 2 * HOUR, tag: 't2' });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [waiting] }], [quiet]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  // Nor does an item that asks the person nothing.
  const intervened = { ...waiting, reason: 'person-intervened' };
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [intervened] }], [quiet]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
});

test('only refusals raised before anything was written count as not sent', () => {
  assert.equal(rules.notSent({ uiMessage: { key: 'error.workspace.sessionNotReady' } }), true);
  assert.equal(rules.notSent({ notSent: true }), true);
  assert.equal(rules.notSent({ uiMessage: { key: 'error.workspace.receiptUnconfirmed' } }), false);
  assert.equal(rules.notSent(Error('send-timeout')), false);
});

function roomSetup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, room: new RoomState(dir) };
}

test('the person adds and cancels queue items; records persist and appear in the space record', t => {
  const { dir, room } = roomSetup(t);
  const first = room.queueAdd('第一件', null);
  const second = room.queueAdd('第二件', 'agent-b');
  room.queueCancel(second);
  const saved = new RoomState(dir);
  const queue = saved.value.queue;
  assert.equal(queue.length, 2);
  assert.equal(queue[0].id, first);
  assert.equal(queue[0].status, 'queued');
  assert.equal(queue[1].status, 'cancelled');
  const kinds = [];
  for (const event of saved.value.events) {
    kinds.push(event.uiMessage.key);
  }
  assert.deepEqual(kinds, ['notice.queue.added', 'notice.queue.added', 'notice.queue.cancelled']);
  assert.equal(saved.apply({ sessions: [], room: { messages: [] } }).rooms[0].queue.length, 2);
  assert.throws(() => room.queueAdd('', null), /1–6000/);
  assert.throws(() => room.queueCancel(second), /取消/);
});

test('dispatch and decision outcomes are written once to the space record with the member name', t => {
  const { room } = roomSetup(t);
  const id = room.queueAdd('改一下按钮', null);
  room.queueMarkSent('shared', id, 'agent-a', 'Claude 2', NOW);
  room.queueSetDelivery('shared', id, 'tag-1', 4);
  assert.equal(room.value.queue[0].control, 4);
  room.queueSettle('shared', id, 'waiting', '', 'Claude 2');
  // What NAW noticed by itself (queue-monitor-events.test.cjs) is recorded beside these, not instead of them.
  const outcomes = () => room.value.events.filter(event => !event.monitor);
  const events = outcomes();
  assert.equal(events[1].text, 'NAW 派活：改一下按钮 → Claude 2');
  assert.equal(events[1].sessionId, 'agent-a');
  assert.equal(events[2].text, 'Claude 2 需要你决定：改一下按钮');
  room.queueResolve(id);
  assert.equal(room.value.queue[0].status, 'done');
  assert.equal(outcomes().length, 4);
  assert.equal(outcomes()[3].text, '已处理：改一下按钮');
  assert.deepEqual(room.value.events.filter(event => event.monitor).map(event => event.monitor.kind), ['queue-dry']);
});

test('a settled item keeps one bounded line of the reply, it survives a reload, and the space record does not repeat it', t => {
  const { dir, room } = roomSetup(t);
  const raw = `收到\n\u001b[32m好了\u001b[0m\u0007 ${'细节'.repeat(200)}`;
  const messages = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: raw },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  const [action] = plan(rooms, [member('a', { messages })]);
  assert.equal(action.status, 'done');
  assert.equal(action.reply.length, 200);
  assert.ok(action.reply.startsWith('收到 好了 细节'), action.reply);
  assert.equal(/\[\d*m/.test(action.reply), false, 'no escape-sequence remains: ' + action.reply.slice(0, 40));
  assert.ok(action.reply.endsWith('…'));
  assert.equal(/[\u0000-\u001f\u007f]/u.test(action.reply), false, 'a terminal reply keeps no escape sequences');
  const id = room.queueAdd('改一下按钮', null);
  room.queueMarkSent('shared', id, 'agent-a', 'Claude 2', NOW);
  room.queueSetDelivery('shared', id, 'tag-1', 0);
  room.queueSettle('shared', id, 'waiting', '', 'Claude 2', action.reply);
  const saved = new RoomState(dir);
  assert.equal(saved.value.queue[0].reply, action.reply);
  for (const event of saved.value.events) {
    assert.equal(event.text.includes('细节'), false, 'the reply belongs to the item, not to the space record');
  }
  assert.throws(() => rules.validateQueue([item('x', { reply: 'bad\u0007line' })]), /reply/);
  assert.throws(() => rules.validateQueue([item('x', { reply: 'x'.repeat(201) })]), /reply/);
});

test('a refusal before sending returns the item to the queue, and fails it after five tries', t => {
  const { room } = roomSetup(t);
  const id = room.queueAdd('试一下', null);
  for (let attempt = 1; attempt < 5; attempt += 1) {
    room.queueMarkSent('shared', id, 'agent-a', 'A', NOW);
    room.queueRequeue('shared', id, 'busy', 5, 'A');
    assert.equal(room.value.queue[0].status, 'queued');
    assert.equal(room.value.queue[0].attempts, attempt);
    assert.equal(room.value.queue[0].sentTo, undefined);
  }
  room.queueMarkSent('shared', id, 'agent-a', 'A', NOW);
  room.queueRequeue('shared', id, 'busy', 5, 'A');
  assert.equal(room.value.queue[0].status, 'failed');
});

test('a send after a refusal drops the refusal reason and keeps the count, so the finished row shows no old error', t => {
  const { room } = roomSetup(t);
  const id = room.queueAdd('试一下', null);
  room.queueMarkSent('shared', id, 'agent-a', 'A', NOW);
  room.queueRequeue('shared', id, 'Synthetic refusal', 5, 'A');
  assert.equal(room.value.queue[0].reason, 'Synthetic refusal', 'a queued item still says why it came back');
  room.queueMarkSent('shared', id, 'agent-a', 'A', NOW + 1);
  assert.equal(Object.hasOwn(room.value.queue[0], 'reason'), false);
  assert.equal(room.value.queue[0].attempts, 1);
  room.queueSettle('shared', id, 'done', '', 'A');
  assert.equal(room.value.queue[0].status, 'done');
  assert.equal(Object.hasOwn(room.value.queue[0], 'reason'), false);
});

class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: AWAKE, capabilities: [rules.CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY, GUARDED_STOP] };
    this.calls = [];
    this.sequence = 0;
    this.reads = 0;
    this.capabilities = ['failedSuccessorCleanupV1', rules.CAPABILITY, rules.ROTATION_CAPABILITY, GUARDED_STOP, CONDITIONAL_STOP, PARTICIPANT_STOP];
  }
  snapshot() {
    this.reads += 1;
    return structuredClone(this.state);
  }
  async refresh() {
    if (this.busyOnRefresh) {
      // The person's message reaches the old session just as NAW reads fresh state.
      this.busyOnRefresh = false;
      this.state.sessions[0].state = 'working';
    }
    return this.snapshot();
  }
  close() {}
  route(id) {
    if (!this.state.sessions.some(s => s.id === id)) {
      throw Error('unknown session');
    }
    return { client: this, state: { capabilities: this.capabilities } };
  }
  async call(method, ...args) {
    this.calls.push([method, ...args]);
    // The room's own archive reads the backend's sessions this way.
    if (method === 'initial') return this.snapshot();
    const session = this.state.sessions.find(s => s.id === args[0]);
    if (method === 'completeRotation') {
      if (session.nativeId !== args[1] || session.rotationEpisode?.epoch !== args[2] || session.rotationEpisode.tag !== args[3] || session.rotationEpisode.responseTag !== args[3]) throw Error('control identity changed');
      session.rotationEpisode.state = 'complete'; return { epoch: args[2], state: 'complete' };
    }
    if (method === 'invalidateRotation') {
      const prototype = require('../workspace.cjs').Workspace.prototype;
      return prototype.invalidateRotation.call({ get: () => session, changed() {}, persist: () => true,
        retireRotation: prototype.retireRotation }, ...args);
    }
    if (method === 'dispatch') {
      this.sequence += 1;
      const tag = `tag-${this.sequence}`;
      if (args[4]) session.rotationEpisode = { nativeId: session.nativeId, epoch: args[4].epoch, state: 'open', tag };
      session.messages.push({ id: tag, role: 'user', text: args[1], origin: 'naw-dispatch', status: 'submitted', dispatchItem: args[3],
        dispatchPurpose: { kind: args[4]?.kind || (args[3]?.startsWith('rotation-handoff:') ? 'rotation-handoff' : 'queue'),
          itemId: args[3], nativeId: session.nativeId, epoch: session.rotationEpisode?.nativeId === session.nativeId ? session.rotationEpisode.epoch : null } });
      session.state = 'working';
      // Older journeys model a successful handoff; submission alone no longer proves it.
      if (args[3]?.startsWith('rotation-handoff:')) {
        Object.assign(session.messages.at(-1), { nativeId: session.nativeId, turnId: `turn-${tag}` });
        session.messages.push({ id: `boundary-${tag}`, role: 'system', kind: 'turn', nativeId: session.nativeId, turnId: `turn-${tag}`, status: 'complete' });
      }
      this.emit('state');
      return tag;
    }
    if (method === 'create') {
      // Like the native CLIs: the requested model, or the provider default (unlike the old session's).
      let model = 'claude-default-model';
      if (args[0].settings && args[0].settings.model && !this.ignoreSettings) {
        model = args[0].settings.model;
      }
      const created = member(`new-${this.sequence}`, { name: args[0].name, createdAt: NOW, roomIds: [], roomId: null, cwd: args[0].cwd, model, view: args[0].view });
      this.state.sessions.push(created);
      return created.id;
    }
    if (method === 'stop' || method === 'maintenanceStop') {
      if (this.sendBeforeStop) {
        // The person's send was on its way when NAW last checked: the service handles it before the stop.
        this.sendBeforeStop = false;
        session.peerRevision = (session.peerRevision || 0) + 1;
        session.pendingTag = 'person-send';
        session.messages.push({ id: 'person-send', role: 'user', text: 'one more thing', status: 'submitted' });
        session.state = 'working';
      }
    }
    if (method === 'maintenanceStop') {
      // As the service's conditional stop (workspace.cjs): refused, with nothing changed, unless the session
      // is still exactly as proven, and in no running relay.
      const running = new Set(this.state.rooms.flatMap(r => r.run && r.run.status === 'running' ? r.run.ids || [] : []));
      const plan = sessionPlan({ ...session, draftRevision: session.draftRevision || 0 }, session.state, running);
      if (!plan.stop || !sameStop(plan.stop, args[1]) || args[2] !== false) {
        throw Object.assign(Error('changed'), { uiMessage: { key: 'error.backendSwitchSessionChanged' } });
      }
      // Its stop pauses every relay the service holds, unless asked to pause only this session's
      // (participant scope, from participantMaintenanceStopV1 on).
      const scoped = this.capabilities.includes(PARTICIPANT_STOP) && args[3] === 'participant';
      for (const r of this.state.rooms) {
        if (r.run && r.run.status === 'running' && (!scoped || (r.run.ids || []).includes(session.id))) r.run.status = 'paused';
      }
      if (this.refusesOwnReceipt) {
        // As a real Claude stop on the service (maintenance-stop.test.cjs): the terminal's close ends the
        // session and drops its runtime, SessionEnd revokes control once more, and the service then refuses
        // its own receipt.
        session.state = 'ended';
        session.controlRevision = (session.controlRevision || 0) + 2;
        session.connectionRevision = (session.connectionRevision || 0) + 2;
        if (this.refusesOwnReceipt === 'other change') session.owner = 'another-window';
        throw Object.assign(Error('unconfirmed'), { uiMessage: { key: 'error.backendSwitchDisconnectUnconfirmed' } });
      }
      return this.call('stop', session.id);
    }
    if (method === 'stop') {
      session.state = 'ended';
      return { state: 'ended' };
    }
    if (method === 'stopFailedSuccessor') {
      assert.ok(require('../rotation-handoff.cjs').owned(session, args[1], args[2]));
      session.state = 'ended'; session.controlRevision++; session.pendingTag = null;
      const proof = { nativeId: session.nativeId, controlRevision: session.controlRevision, draftRevision: session.draftRevision, placementRevision: session.placementRevision };
      session.failedHandoffStop = { basis: 'stopped-by-this-attempt', tag: args[2], owner: args[1], proof };
      return { basis: 'stopped-by-this-attempt', state: session.state, receipt: session.failedHandoffStop };
    }
    if (method === 'stopUnusedSuccessor') {
      assert.deepEqual(args[1], trustProof(session), 'the server checks the exact current identity and person revisions');
      assert.ok(['starting', 'idle'].includes(session.state) && !session.pendingTag && !session.liveDraft && !session.nativeInputRequired &&
        !session.activeTurnId && !session.pendingQueue && !session.pendingSteer && session.nativeGoal?.status !== 'active' &&
        !(session.messages || []).some(m => m.role === 'user') && !(session.background > 0), 'the owned successor is still unused');
      return this.call('stop', session.id);
    }
    if (method === 'terminalSnapshot') {
      if (this.snapshotFails) {
        throw Error('terminal unavailable');
      }
      if (this.terminalClosed) {
        // As the backend answers a connection that does not own a terminal that is not open.
        throw Object.assign(Error('closed'), { uiMessage: { key: 'error.workspace.takeTerminalControlBeforeReconnect' } });
      }
      if (this.typeAfterSnapshot) {
        // The person types into the old terminal right after its screen was read.
        session.controlRevision = (session.controlRevision || 0) + 1;
      }
      // A serialized native screen: the prompt box still holds text typed but not sent.
      return { buffer: 'Claude Code\r\n> UNSENT_DRAFT_42', cols: 80, rows: 24 };
    }
    throw Error(`unexpected ${method}`);
  }
  reply(id, text) {
    const session = this.state.sessions.find(s => s.id === id);
    const inputTag = session.messages.findLast(m => m.role === 'user')?.id;
    if (session.rotationEpisode?.state === 'open' && session.rotationEpisode.tag === inputTag) session.rotationEpisode.responseTag = inputTag;
    session.messages.push({ id: `reply-${session.messages.length}`, role: 'assistant', text, inputTag });
    session.state = 'idle';
    this.emit('state');
  }
  sends(id) {
    const result = [];
    for (const call of this.calls) {
      if (call[0] === 'dispatch' && (!id || call[1] === id)) {
        result.push(call);
      }
    }
    return result;
  }
}

function fakeMembership(room, client) {
  const joins = [];
  room.membership = async (_client, id, join, label, roomId) => {
    joins.push([id, join, roomId]);
    const session = client.state.sessions.find(s => s.id === id);
    if (join) {
      session.roomIds = [roomId];
      session.roomId = roomId === 'shared' ? roomId : null;
    } else {
      session.roomIds = [];
      session.roomId = null;
    }
  };
  return joins;
}

function dispatcherSetup(t, sessions, options = {}) {
  const { dir, room } = roomSetup(t);
  const client = new FakeClient(sessions);
  let now = NOW;
  let connects = 0;
  // window: an open window serves the client, so the once-a-minute check of quiet members runs with no queued work.
  const { window: windowed, ...rest } = options;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    connect: async () => {
      connects += 1;
      return client;
    },
    ...(windowed ? { clients: () => client } : {}),
    now: () => now,
    settleMs: 0,
    tickMs: 3600000,
    ...rest,
  });
  t.after(() => dispatcher.close());
  return { room, client, dispatcher, advance: ms => { now += ms; }, dir, connects: () => connects };
}

test('the dispatcher sends through the backend dispatch input, waits for the reply, then sends the next', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  room.queueAdd('first task', null);
  room.queueAdd('second task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  const sends = client.sends();
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /【NAW 派活】[\s\S]*first task/);
  assert.equal(sends[0][4], room.value.queue[0].id, 'the backend learns which queue item this is');
  assert.equal(client.calls.some(call => call[0] === 'claim' || call[0] === 'send'), false, 'no takeover and no human send');
  assert.equal(room.value.queue[0].status, 'sent');
  assert.equal(room.value.queue[0].tag, 'tag-1');
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1, 'no second item while the member works');
  client.reply('a', 'first task finished');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].status, 'done');
  assert.equal(client.sends().length, 2);
  assert.match(client.sends()[1][2], /second task/);
});

// Queue item 6897c6e3, part 1: a member took the work from the board while the same item was queued for it (four
// sends of one item in the person's data). It claims the item mid-turn; NAW never sends it and settles it by the
// member's reply when the turn ends, as it would an item it sent; the member's next item then goes out as usual.
function claimSetup(t, extra = {}) {
  const input = { id: 'board-turn', role: 'user', text: 'take the board task', origin: 'human', status: 'submitted' };
  const setup = dispatcherSetup(t, [member('a', { state: 'working', messages: [{ id: 'earlier', role: 'assistant', text: 'earlier work' }, input], ...extra })]);
  const claimed = setup.room.queueAdd('board task', 'a');
  const next = setup.room.queueAdd('next task', 'a');
  setup.claim = (control = 0) => setup.room.queueClaim(claimed, 'shared', { name: 'Agent a', sessionId: 'a', control, input: 'board-turn' }, NOW);
  return { ...setup, claimed, next };
}
test('a claimed item is never sent; the member\'s reply at the end of its turn settles it, then its next item goes out', async t => {
  const { room, client, dispatcher, claimed, next, claim } = claimSetup(t);
  await dispatcher.start();
  assert.equal(client.sends().length, 0, 'the member is working');
  claim();
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0, 'nothing is sent while the claimed item is in flight');
  client.reply('a', 'Done: the board task.\nREADY lane/board-task 0123abcd');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const item = room.queueFind('shared', claimed);
  assert.deepEqual([item.status, item.reply, item.ready], ['done', 'Done: the board task. READY lane/board-task 0123abcd', { branch: 'lane/board-task', commit: '0123abcd' }]);
  assert.deepEqual(client.sends().map(call => call[4]), [next], 'only the next item was sent, once');
  assert.equal(room.queueFind('shared', next).status, 'sent');
});
test('a claimed item is left for the person when the person stepped in or took control during the turn', async t => {
  for (const change of ['typed', 'control']) {
    const { room, client, dispatcher, claimed, claim } = claimSetup(t, { controlRevision: 2 });
    await dispatcher.start();
    claim(2);
    const session = client.state.sessions[0];
    if (change === 'typed') session.messages.push({ id: 'person', role: 'user', text: 'wait, do it differently', origin: 'human' });
    else session.controlRevision = 3;
    client.reply('a', 'Done.');
    await dispatcher.schedule();
    await dispatcher.schedule();
    const item = room.queueFind('shared', claimed);
    assert.deepEqual([item.status, item.reason], ['waiting', 'person-intervened'], change);
    // As for an item NAW sent, the member is held for that pass only; the claimed item itself is never sent.
    assert.equal(client.sends().some(call => call[4] === claimed), false, change);
    await dispatcher.close();
  }
});

// Review note 4: without a stored turn input the claim's anchor is its time. Native-block sessions,
// the only ones background control serves, stamp each message with one.
test('a claim with no stored turn input cannot settle from later text alone', async t => {
  const earlier = [{ id: 'old-ask', role: 'user', text: 'an older request', origin: 'human', time: NOW - 2000 },
    { id: 'old-answer', role: 'assistant', text: 'earlier work', time: NOW - 1000 }];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { state: 'working', messages: earlier })]);
  const claimed = room.queueAdd('board task', 'a');
  await dispatcher.start();
  room.queueClaim(claimed, 'shared', { name: 'Agent a', sessionId: 'a', control: 0 }, NOW);
  assert.equal(room.queueFind('shared', claimed).tag, `claimed:${claimed}`);
  const session = client.state.sessions[0];
  session.messages.push({ id: 'late', role: 'assistant', text: 'Done: the board task.', time: NOW + 5 });
  session.state = 'idle';
  client.emit('state');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const item = room.queueFind('shared', claimed);
  assert.deepEqual([item.status, item.reason, item.reply], ['failed', 'record-missing', undefined], 'a claim timestamp cannot prove an input purpose');
  assert.equal(client.sends().length, 0);
});

test('a refused send goes back to the queue; an uncertain failure is recorded and never retried', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  const original = client.call.bind(client);
  let refusals = 1;
  client.call = async (method, ...args) => {
    if (method === 'dispatch' && refusals > 0) {
      refusals -= 1;
      throw Object.assign(Error('not ready'), { uiMessage: { key: 'error.workspace.sessionNotReady' } });
    }
    if (method === 'dispatch') {
      throw Error('backend went away');
    }
    return original(method, ...args);
  };
  room.queueAdd('only task', null);
  await dispatcher.start();
  assert.equal(room.value.queue[0].status, 'queued', 'a refusal before sending is not a failure');
  assert.equal(room.value.queue[0].attempts, 1);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].status, 'failed');
  assert.equal(room.value.queue[0].reason, 'backend went away');
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'dispatch').length, 0);
});

test('a member whose backend has not been updated gets nothing', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { serviceCapabilities: ['collaborationSpacesV1'] })]);
  room.queueAdd('only task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.calls.length, 0);
  assert.equal(room.value.queue[0].status, 'queued');
});

test('the person working in a session keeps NAW out of it for two minutes', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a')]);
  room.queueAdd('only task', null);
  dispatcher.noteHuman('a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0);
  advance(rules.HUMAN_QUIET_MS + 1000);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1);
});

test('with nothing queued the dispatcher reads no session state and opens no connection', async t => {
  const { client, dispatcher, connects } = dispatcherSetup(t, [member('a')]);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(connects(), 0);
  assert.equal(client.reads, 0);
  assert.equal(client.calls.length, 0);
});

test('with queued work that cannot move, unchanged state is not reread on every tick', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { state: 'working' })]);
  room.queueAdd('only task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  const reads = client.reads;
  for (let i = 0; i < 5; i += 1) {
    advance(3000);
    await dispatcher.schedule();
  }
  assert.equal(client.reads, reads, 'no state change, nothing settling: no reread');
  client.emit('state');
  await dispatcher.schedule();
  assert.ok(client.reads > reads, 'a state change is looked at');
});

test('an open window client is used instead of a second connection', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a')]);
  let connects = 0;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => {
      connects += 1;
      return new FakeClient([]);
    },
    now: () => NOW,
    settleMs: 0,
    tickMs: 3600000,
  });
  t.after(() => dispatcher.close());
  room.queueAdd('window task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(connects, 0);
  assert.equal(windowClient.sends().length, 1);
  assert.match(windowClient.sends()[0][2], /window task/);
});

test('an old member writes a handoff, a new member takes its queue, and the old process is stopped', async t => {
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  const joins = fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  const request = client.sends('a')[0];
  assert.match(request[2], /【NAW 换会话】[\s\S]*只写交接/);
  assert.equal(room.value.queue[0].status, 'queued', 'the queued item is not sent to the old member');
  client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
  await dispatcher.schedule();
  const created = client.calls.find(call => call[0] === 'create');
  assert.equal(created[1].provider, 'claude');
  assert.equal(created[1].cwd, '/tmp');
  assert.deepEqual(created[1].settings, { model: 'claude-test-model' }, 'the successor starts with the old model');
  assert.equal(created[1].view, 'chat');
  const newId = client.state.sessions[1].id;
  assert.equal(room.value.queue[0].assignee, newId);
  await dispatcher.schedule();
  const handoff = client.sends(newId);
  assert.equal(handoff.length, 1);
  assert.match(handoff[0][2], /交接：在 feature 分支 abc123/);
  await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  assert.deepEqual(joins, [[newId, true, 'shared'], ['a', false, 'shared']]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue-dispatch.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.rotations), [newId], 'only the successor rests, for a day');
  assert.equal(saved.rotations[newId].phase, 'kept');
  assert.equal(saved.rotations[newId].successorOf, 'a');
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const work = client.sends(newId);
  assert.equal(work.length, 2);
  assert.match(work[1][2], /next task/);
});

test('a handoff asked for before a migration quiet window is taken inside it; none is asked for inside one', async t => {
  const old = () => member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' });
  const held = new Map([['a', 'synthetic-window']]);
  const inside = dispatcherSetup(t, [old()]);
  inside.room.queueAdd('next task', 'a');
  inside.dispatcher.quietWindows = { sessionIds: () => held };
  await inside.dispatcher.start();
  await inside.dispatcher.schedule(); await inside.dispatcher.schedule();
  assert.deepEqual(inside.client.sends('a'), [], 'neither the item nor a handoff request');
  const { room, client, dispatcher } = dispatcherSetup(t, [old()]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.match(client.sends('a')[0][2], /【NAW 换会话】/);
  dispatcher.quietWindows = { sessionIds: () => held };
  client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1]?.id;
  assert.ok(newId, 'the successor is made'); assert.equal(room.value.queue[0].assignee, newId);
  await dispatcher.schedule();
  assert.match(client.sends(newId)[0][2], /交接：在 feature 分支 abc123/);
  await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  assert.equal(client.sends('a').length, 1);
});

test('an open decision goes with the session: the successor is told it whole, the row answers the successor, and what it is sent next is marked', async t => {
  // 11-23, the person: 「要不要改成把没答的决定带给继任会话，答复跟着换会话链走？要」.
  const asked = '需要你决定：要不要删旧分支？\n\nA：删。B：留。推荐 A，因为它已经合进 main。' + '补充'.repeat(150);
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  const decided = room.queueAdd('清理旧分支，然后报告。', 'a');
  room.queueMarkSent('shared', decided, 'a', 'Agent a', NOW - 60000, false, 'native-a');
  room.queueSetDelivery('shared', decided, 'tag-decision', 0);
  client.state.sessions[0].messages.push(
    { id: 'tag-decision', role: 'user', text: 'NAW task', origin: 'naw-dispatch', status: 'submitted', dispatchItem: decided },
    { id: 'asked', role: 'assistant', text: asked, inputTag: 'tag-decision' });
  room.queueSettle('shared', decided, 'waiting', '', 'Agent a', rules.replyLine(asked), '要不要删旧分支？');
  const next = room.queueAdd('next task', 'a');
  const find = id => room.queueItems('shared').find(entry => entry.id === id);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends('a').length, 1);
  assert.match(client.sends('a')[0][2], /【NAW 换会话】[\s\S]*只写交接/, 'its open decision does not keep the session');
  client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  const handoff = client.sends(newId);
  assert.equal(handoff.length, 1);
  for (const part of ['交接：在 feature 分支 abc123', decided, '清理旧分支，然后报告。', asked]) {
    assert.ok(handoff[0][2].includes(part), part.slice(0, 24));
  }
  assert.equal(find(decided).sentTo, 'a', 'until the successor has the handoff, the row still answers the old session');
  await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  const carried = find(decided);
  assert.deepEqual([carried.status, carried.sentTo, carried.sentNative], ['waiting', newId, `native-${newId}`]);
  assert.deepEqual([carried.askedBy, carried.carriedFrom], [{ id: 'a', nativeId: 'native-a' }, { id: 'a', nativeId: 'native-a' }]);
  assert.equal(room.queueItems('shared').filter(entry => entry.status === 'waiting').length, 1, 'one card, as before');
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.deepEqual([find(next).status, find(next).sentTo, find(next).afterDecision], ['sent', newId, true],
    'its next item is marked: what follows the person\'s answer there is not this item\'s reply');
  // The person answers on the card; the window sends to the successor and records it once.
  room.queueResolve(decided, 'shared', null, '删。', newId);
  assert.deepEqual([find(decided).status, find(decided).sentTo, find(decided).answer.text], ['done', newId, '删。']);
  assert.throws(() => room.queueResolve(decided, 'shared', null, '删。', newId), /./, 'never twice');
});

test('a space being updated as the successor takes over gives it the decision on a later pass: the old session is not ended first', async t => {
  const asked = '需要你决定：要不要删旧分支？';
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  const decided = room.queueAdd('清理旧分支，然后报告。', 'a');
  room.queueMarkSent('shared', decided, 'a', 'Agent a', NOW - 60000, false, 'native-a');
  room.queueSetDelivery('shared', decided, 'tag-decision', 0);
  client.state.sessions[0].messages.push(
    { id: 'tag-decision', role: 'user', text: 'NAW task', origin: 'naw-dispatch', status: 'submitted', dispatchItem: decided },
    { id: 'asked', role: 'assistant', text: asked, inputTag: 'tag-decision' });
  room.queueSettle('shared', decided, 'waiting', '', 'Agent a', rules.replyLine(asked), '要不要删旧分支？');
  const find = id => room.queueItems('shared').find(entry => entry.id === id);
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：没有别的。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  assert.equal(client.sends(newId).length, 1);
  // The pass that sees the handoff accepted cannot write the space's items (room-state.cjs writable).
  room.gates.add('room');
  await dispatcher.schedule();
  assert.equal(client.calls.some(call => call[0] === 'stop'), false, 'the old session stays while its decision has not moved');
  assert.equal(find(decided).sentTo, 'a');
  room.gates.delete('room');
  await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  assert.equal(find(decided).sentTo, newId);
});

test('a decision moved to a successor remembers who asked; an answer already on its way to the old session closes it there', t => {
  const { room, dir } = roomSetup(t);
  const add = (text, reason) => {
    const id = room.queueAdd(text, 'a');
    room.queueMarkSent('shared', id, 'a', 'Agent a', NOW - 60000, false, 'native-a');
    room.queueSettle('shared', id, 'waiting', reason, 'Agent a', '需要你决定：合吗？', '合吗？');
    return id;
  };
  const find = id => room.queueItems('shared').find(entry => entry.id === id);
  const decided = add('任务一', ''), second = add('任务二', ''), looked = add('任务三', 'no-reply');
  const queued = room.queueAdd('任务四', 'a');
  room.queueCarry('shared', 'a', 'b', 'native-b');
  const a = { id: 'a', nativeId: 'native-a' };
  assert.deepEqual([find(decided).sentTo, find(decided).sentNative, find(decided).askedBy, find(decided).carriedFrom], ['b', 'native-b', a, a]);
  assert.deepEqual([find(looked).sentTo, find(looked).askedBy], ['a', undefined], 'an item NAW left to look at asked nothing: it stays');
  assert.deepEqual([find(queued).status, find(queued).assignee], ['queued', 'a'], 'queued work moves by queueReassign, not here');
  const before = JSON.stringify(room.queueItems('shared'));
  room.queueCarry('shared', 'a', 'b', 'native-b');
  assert.equal(JSON.stringify(room.queueItems('shared')), before, 'a second pass changes nothing');
  // An answer sent to the old session just before the move, confirmed after it: recorded once, with that recipient.
  room.queueResolve(second, 'shared', null, '合。', 'a');
  assert.deepEqual([find(second).status, find(second).sentTo, find(second).sentNative, find(second).carriedFrom], ['done', 'a', 'native-a', undefined]);
  assert.equal(find(second).askedBy.id, 'a');
  // The next link of the chain: the first asker stays, the last holder is the one before.
  room.queueCarry('shared', 'b', 'c', null);
  assert.deepEqual([find(decided).sentTo, find(decided).sentNative, find(decided).askedBy, find(decided).carriedFrom],
    ['c', undefined, a, { id: 'b', nativeId: 'native-b' }]);
  assert.deepEqual(new RoomState(dir).queueItems('shared').find(entry => entry.id === decided).askedBy, a, 'kept across a restart');
  assert.throws(() => rules.validateQueue([{ ...find(decided), askedBy: { id: 'a', extra: 1 } }]), /Invalid/);
  assert.throws(() => rules.validateQueue([{ ...find(decided), carriedFrom: 'a' }]), /Invalid/);
});

// The 11-14 drill, finding 1: a person typing into the old session during its handoff rested the member a week.
const rotationTexts = events => events.filter(event => event.kind === 'rotation')
  .flatMap(event => ['zh', 'en'].map(locale => uiLocale.displayText(locale, event.text, event.uiMessage)));

test('the person using the old member during the handoff pauses the rotation: nothing rests, and it is asked again once quiet', async t => {
  const { room, client, dispatcher, advance, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], { window: true });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a.phase, 'requested');
  advance(1000);
  dispatcher.noteHuman('a');
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'create').length, 0);
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0);
  assert.equal(dispatcher.rotations.a, undefined, 'nothing failed, so nothing rests');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue-dispatch.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved.rotations || {}, 'a'), false);
  const keys = room.value.events.filter(event => event.kind === 'rotation').map(event => event.uiMessage.key);
  assert.deepEqual(keys, ['notice.rotation.requested', 'notice.rotation.deferred']);
  const texts = rotationTexts(room.value.events);
  assert.ok(texts.includes('NAW 换会话先停下：你在用「Agent a（a）」，等它安静下来再换；原会话保持不变'), texts.join('\n'));
  assert.ok(texts.some(text => text.startsWith('NAW session rotation paused: you were using “Agent a（a）”')));
  assert.equal(texts.some(text => /person-active/.test(text)), false);
  assert.deepEqual(dispatcher.rotationEntries().map(entry => entry.event), ['requested', 'waiting']);
  assert.equal(dispatcher.rotationEntries()[1].reason, 'person-active', 'the private log keeps the code');
  // Past the person's two minutes its queued item goes to it; the handoff is not asked for again yet.
  advance(3 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a, undefined);
  assert.equal(client.sends('a').length, 2, 'the durably discarded control no longer blocks its queued item');
  assert.equal(client.state.sessions[0].nativeId, 'native-a', 'resuming does not replace the native session');
  assert.equal(client.state.sessions[0].messages.find(m => m.id === 'tag-1').status, 'failed');
  await dispatcher.schedule();
  const sends = client.sends('a');
  assert.match(sends[sends.length - 1][2], /next task/);
  assert.equal(client.calls.filter(call => call[0] === 'dispatch' && call[1] === 'a').length, 2, 'one handoff request, then the item');
  client.reply('a', 'done');
  await dispatcher.schedule();
  advance(20 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a, undefined, 'still inside the member\'s thirty quiet minutes');
  // Thirty quiet minutes after it was paused, the member is rotated again.
  advance(11 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a?.phase, 'requested', 'asked again once quiet');
  assert.equal(dispatcher.rotationEntries().filter(entry => entry.event === 'requested').length, 2);
});

// 11-23: the NAW dev PM, paused at 25 compactions, was still not rotated two hours and two compactions later. The person
// had typed into it twice; NAW's own items and messages kept its last activity fresh.
test('a paused rotation waits for the person, not for NAW: a member NAW keeps busy is rotated once the person has been away thirty minutes', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], { window: true });
  fakeMembership(room, client);
  room.queueAdd('task 0', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a.phase, 'requested');
  advance(1000);
  dispatcher.noteHuman('a');
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a, undefined, 'paused for the person');
  const busy = client.state.sessions[0];
  const asked = [];
  for (let minute = 10; minute <= 60; minute += 10) {
    advance(10 * 60 * 1000);
    client.reply('a', `done at ${minute}`);
    busy.lastActivityAt = dispatcher.now();
    room.queueAdd(`task ${minute}`, 'a');
    await dispatcher.schedule();
    await dispatcher.schedule();
    if (dispatcher.rotations.a?.phase === 'requested') asked.push(minute);
  }
  assert.equal(asked[0], 30, `asked again at ${asked.join(',') || 'never'} minutes`);
});

test('the pause counts from the person\'s own last use, not the session\'s activity, and the butler\'s compaction waits only its two minutes', t => {
  const { dispatcher } = dispatcherSetup(t, []);
  dispatcher.deferredAt.set('a', { at: NOW, due: 'compact' });
  dispatcher.deferredAt.set('b', { at: NOW, due: 'compact' });
  dispatcher.deferredAt.set('c', { at: NOW, due: 'memory' });
  dispatcher.deferredAt.set('d', { at: NOW, due: 'compact' });
  dispatcher.deferredAt.set('gone', { at: NOW, due: 'compact' });
  dispatcher.humanAt.set('a', NOW + 25 * 60 * 1000);
  const sessions = [member('a'), member('b'), member('c'), member('d', { lastActivityAt: NOW + 25 * 60 * 1000 })];
  const at = minutes => [...dispatcher.personDeferred(sessions, 'b', NOW + minutes * 60 * 1000)].sort();
  assert.deepEqual(at(1), ['a', 'b', 'c', 'd']);
  assert.deepEqual(at(3), ['a', 'c', 'd'], 'the butler\'s compaction waits two minutes');
  assert.deepEqual(at(11), ['a', 'd'], 'memory waits ten');
  assert.deepEqual(at(31), ['a'], 'its own activity (NAW\'s items, its replies) does not extend the pause');
  assert.deepEqual(at(54), ['a'], 'thirty minutes from the person\'s last use, not from the pause');
  assert.deepEqual(at(56), []);
  assert.equal(dispatcher.deferredAt.size, 0, 'entries go once their quiet has passed or the session is gone');
});

test('a person-active failure saved by an older build before any successor no longer rests the member; other failures still do', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-defer-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue-dispatch.json');
  const failed = (reason, extra = {}) => ({ phase: 'failed', failedAt: NOW - 1000, reason, oldNativeId: 'native-x', provider: 'claude', cwd: '/tmp', name: 'Agent x', roomIds: ['shared'], ...extra });
  const moved = failed('person-active', { newId: 'made', newCwd: '/synthetic/new' });
  const unstopped = failed('person-active', { newId: 'left', newCwd: '/tmp' });
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: failed('person-active'), b: failed('new-session-not-ready'), c: failed('handoff-missing'), d: moved, e: unstopped } }), { mode: 0o600 });
  assert.deepEqual(Object.keys(rules.readRotations(file, NOW)).sort(), ['b', 'c', 'd', 'e'],
    'a successor in a moved directory keeps the record its hold names; one whose stop was not confirmed keeps its week across a restart');
});

test('a person-active failure whose successor is in a moved directory keeps its record, so its isolation hold keeps its anchor', async t => {
  const { dir, room } = roomSetup(t);
  const old = member('a', { cwd: '/synthetic/old' });
  const fresh = member('made', { name: 'Agent a · 续', cwd: '/synthetic/new', roomIds: [], roomId: null });
  const client = new FakeClient([old, fresh]); fakeMembership(room, client);
  const record = { phase: 'created', oldId: 'a', oldNativeId: old.nativeId, oldControl: 0, requestedAt: NOW - 60000, provider: 'claude',
    cwd: old.cwd, name: old.name, roomIds: ['shared'], newId: fresh.id, newCwd: fresh.cwd, newName: fresh.name, createdNewAt: NOW - 1000, handoff: 'Synthetic saved work', reason: 'compact' };
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const make = () => new rules.QueueDispatcher({ roomState: room, dataDir: dir, now: () => NOW, connect: async () => client, settleMs: 0, tickMs: 3600000, notify() {} });
  const dispatcher = make(); dispatcher.client = client; t.after(() => dispatcher.close());
  assert.ok(room.directoryTrustIsolation().holds.made, 'the moved successor is held while it is unconfirmed');
  await dispatcher.failRotation('a', dispatcher.rotations.a, 'person-active', NOW, client.snapshot());
  assert.equal(dispatcher.rotations.a.phase, 'failed', 'the record the hold names stays');
  assert.equal(dispatcher.deferredAt.has('a'), false);
  assert.ok(rotationTexts(room.value.events).some(text => text.includes('你正在用这个会话')), 'its reason is still in words');
  const restarted = make(); t.after(() => restarted.close());
  assert.equal(restarted.faultedRotations.has('a'), false, 'a restart finds the hold and its record together');
});

test('if the old member is in use when the handoff lands, it is kept running', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  assert.equal(client.sends(newId).length, 1, 'handoff sent to the new member');
  advance(1000);
  dispatcher.noteHuman('a');
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'the old member is not stopped while in use');
  const keys = [];
  for (const event of room.value.events) {
    keys.push(event.uiMessage.key);
  }
  assert.ok(keys.includes('notice.rotation.oldKept'));
});

test('a new member that never gets ready ends the rotation, is stopped, and the old member keeps its work', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  const original = client.call.bind(client);
  client.call = async (method, ...args) => {
    const result = await original(method, ...args);
    if (method === 'create') {
      // A startup prompt keeps the new native session from ever becoming idle.
      client.state.sessions.find(s => s.id === result).state = 'starting';
    }
    return result;
  };
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  assert.equal(room.value.queue[0].assignee, newId);
  advance(11 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].assignee, 'a', 'the work goes back to the old member');
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', newId]], 'only the unused new member is stopped');
  const keys = [];
  for (const event of room.value.events) {
    keys.push(event.uiMessage.key);
  }
  assert.ok(keys.includes('notice.rotation.failed'), 'the failure is recorded in the space');
  const sends = client.sends('a');
  assert.match(sends[sends.length - 1][2], /next task/, 'the old member then gets its next item');
  // The reason reads as words in both languages; the code stays in the private log.
  const texts = rotationTexts(room.value.events);
  assert.ok(texts.includes('NAW 换会话没有完成：「Agent a（a）」（新会话没能启动好）；原会话保持不变'), texts.join('\n'));
  assert.ok(texts.includes('NAW session rotation did not finish: “Agent a（a）” (the new session did not start properly); the original session is unchanged'));
  assert.equal(texts.some(text => /new-session-not-ready/.test(text)), false);
  assert.equal(dispatcher.rotationEntries().find(entry => entry.event === 'failed').reason, 'new-session-not-ready');
  // A real failure still rests the member: thirty quiet minutes later it is not asked again.
  client.reply('a', 'done');
  advance(31 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a.phase, 'failed');
  assert.equal(dispatcher.rotationEntries().filter(entry => entry.event === 'requested').length, 1);
});

test('after a restart mid-creation, the session already created is adopted instead of a second one', async t => {
  const { dir, room } = roomSetup(t);
  const existing = member('made', { name: 'Agent a · 续', cwd: '/tmp', createdAt: NOW - 1000, roomIds: [], roomId: null });
  const client = new FakeClient([member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' }), existing]);
  fakeMembership(room, client);
  const record = { phase: 'creating', requestedAt: NOW - 60000, creatingAt: NOW - 2000, tag: 'tag-0', oldNativeId: 'native-a', oldControl: 0, provider: 'claude', cwd: '/tmp', name: 'Agent a', roomIds: ['shared'], handoff: '交接：x' };
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'create').length, 0);
  assert.equal(dispatcher.rotations.a.newId, 'made');
});

function projectPlan(nonce = 'aabbccdd-1122-4333-8444-556677889900') {
  return { nonce, source: '/synthetic/repo', repository: '/synthetic/repo', revision: 'a'.repeat(40), relativeDirectory: '', target: `/synthetic/repo-lanes/${nonce}`, cwd: `/synthetic/repo-lanes/${nonce}`, branch: `naw/session-${nonce}` };
}
async function projectRotation(t, extra = {}) {
  const { dir, room } = roomSetup(t), automatic = path.join(dir, 'workspace');
  const oldCwd = extra.oldKind === 'uuid' ? path.join(dir, 'workspace-sessions', projectPlan().nonce) : extra.oldCwd || automatic;
  fs.mkdirSync(automatic); fs.mkdirSync(path.join(dir, 'workspace-sessions'));
  if (extra.oldKind === 'uuid') fs.mkdirSync(oldCwd);
  const old = member('a', { cwd: oldCwd, createdAt: NOW - 30 * HOUR, messages: heavyMessages() });
  const client = new FakeClient([old, ...(extra.sessions || [])]);
  Object.assign(client.state, { defaultWorkspace: automatic, newWorkspaceRoot: path.join(dir, 'workspace-sessions') });
  fakeMembership(room, client);
  const record = { phase: 'creating', requestedAt: NOW - 60000, creatingAt: NOW - 2000, tag: 'tag-0', oldNativeId: 'native-a', oldControl: 0, provider: 'claude', cwd: oldCwd, name: 'Agent a', roomIds: ['shared'], handoff: 'Saved handoff', ...extra.record };
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const original = client.call.bind(client);
  client.call = async (method, ...args) => {
    if (method === 'gitWorktreePreview') { client.calls.push([method, ...args]); return projectPlan(args[1]); }
    if (method === 'create') {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue-dispatch.json'))).rotations.a;
      extra.beforeCreate?.(saved, args[0]);
    }
    const result = await original(method, ...args);
    if (method === 'create') extra.afterCreate?.(client.state.sessions.find(session => session.id === result));
    return result;
  };
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000, creationDefaults: () => extra.defaults || { repository: '/synthetic/repo', directory: null }, migrateDirectories: extra.enabled !== false, notify: extra.notify, directoryTrustTimeoutMs: extra.directoryTrustTimeoutMs });
  t.after(() => dispatcher.close());
  await dispatcher.start(); await dispatcher.schedule();
  return { client, dispatcher, dir, record: dispatcher.rotations.a, automatic };
}
test('B2: creating restart adopts the saved worktree nonce despite a different real cwd, never previews or creates', async t => {
  const plan = projectPlan();
  const made = member('made', { name: 'Agent a · 续', cwd: '/real/location/for/worktree', worktreePreparation: { ...plan, status: 'preparing' }, createdAt: NOW - 1000, roomIds: [], roomId: null });
  const { client, record } = await projectRotation(t, { record: { newCwd: plan.cwd, newWorktree: plan }, sessions: [made] });
  assert.equal(record.newId, 'made');
  assert.equal(client.calls.filter(c => ['create', 'gitWorktreePreview'].includes(c[0])).length, 0);
});
test('B2: persist the successor directory and exact worktree plan before create', async t => {
  let checked = false;
  const { record } = await projectRotation(t, { beforeCreate(saved, options) {
    assert.ok(saved.newWorktree); assert.equal(saved.newCwd, saved.newWorktree.cwd);
    assert.deepEqual(options.gitWorktree, saved.newWorktree); assert.equal(options.cwd, saved.newWorktree.source); checked = true;
  } });
  assert.notEqual(record.phase, 'failed'); assert.equal(checked, true);
});
test('B2: old creating records adopt their old-directory successor before planning any move', async t => {
  const { dir, room } = roomSetup(t), cwd = path.join(dir, 'workspace');
  const made = member('made', { name: 'Agent a · 续', cwd, createdAt: NOW - 1000, roomIds: [], roomId: null });
  const client = new FakeClient([member('a', { cwd }), made]); client.state.defaultWorkspace = cwd; fakeMembership(room, client);
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: { phase: 'creating', oldNativeId: 'native-a', oldControl: 0, provider: 'claude', cwd, name: 'Agent a', roomIds: ['shared'], creatingAt: NOW - 2000 } } }), { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000, creationDefaults: () => ({ repository: '/synthetic/repo' }), migrateDirectories: true }); t.after(() => dispatcher.close());
  await dispatcher.start(); await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a.newId, 'made'); assert.equal(client.calls.some(c => ['create', 'gitWorktreePreview'].includes(c[0])), false);
});
test('B2: NAW directories are only the shared path or one direct UUID child', () => {
  const root = '/synthetic/workspace-sessions', id = projectPlan().nonce;
  assert.equal(rules.nawMadeDirectory('/synthetic/workspace', '/synthetic/workspace', root), true);
  assert.equal(rules.nawMadeDirectory(`${root}/${id}`, '/synthetic/workspace', root), true);
  for (const cwd of [root, `${root}/ordinary`, `${root}/nested/${id}`, `/synthetic/repo-lanes/${id}`, '/another/project', 'relative']) assert.equal(rules.nawMadeDirectory(cwd, '/synthetic/workspace', root), false, cwd);
});
for (const entry of [
  { name: 'ordinary selected directory', oldCwd: '/synthetic/project', expected: '/synthetic/project' },
  { name: 'lane', oldCwd: '/synthetic/repo-lanes/another', expected: '/synthetic/repo-lanes/another' },
  { name: 'directory fallback', defaults: { directory: '/synthetic/last-directory' }, expected: '/synthetic/last-directory' },
  { name: 'no defaults', defaults: {}, unchanged: true },
  { name: 'trust gate closed', enabled: false, unchanged: true },
]) test(`B2: directory planning preserves ${entry.name}`, async t => {
  const { client, record, automatic, dir } = await projectRotation(t, entry);
  assert.equal(record.newCwd, entry.unchanged ? automatic : entry.expected);
  assert.equal(record.newWorktree, undefined);
  assert.equal(client.calls.some(c => c[0] === 'gitWorktreePreview'), false);
  if (entry.name === 'no defaults') assert.match(fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8'), /no-default-directory/);
});
test('B2: a direct automatic UUID directory receives the saved default repository worktree', async t => {
  const { record, client } = await projectRotation(t, { oldKind: 'uuid' });
  assert.ok(record.newWorktree); assert.equal(record.newCwd, record.newWorktree.cwd);
  assert.equal(client.calls.filter(c => c[0] === 'create').length, 1);
});
test('B2: a persisted plan resumes creation once without generating a new nonce or preview', async t => {
  const plan = projectPlan();
  const { record, client } = await projectRotation(t, { enabled: false, record: { newCwd: plan.cwd, newWorktree: plan } });
  assert.deepEqual(record.newWorktree, plan); assert.equal(client.calls.some(c => c[0] === 'gitWorktreePreview'), false);
  assert.equal(client.calls.filter(c => c[0] === 'create').length, 1);
});
for (const outcome of ['reject', 'resolve']) test(`B2: closing the app during create retains the creating receipt on ${outcome}`, async t => {
  const { dir, room } = roomSetup(t), plan = projectPlan(), file = path.join(dir, 'queue-dispatch.json');
  const record = { phase: 'creating', oldNativeId: 'native-a', provider: 'claude', cwd: '/old', name: 'Agent a', roomIds: [], creatingAt: NOW, newCwd: plan.cwd, newWorktree: plan };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const client = new FakeClient([]), dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, now: () => NOW }); dispatcher.client = client;
  client.call = async method => { assert.equal(method, 'create'); dispatcher.close(); if (outcome === 'reject') throw Error('Owned window connection closed during create'); return 'made'; };
  await dispatcher.advanceRotations(client.snapshot(), NOW);
  const saved = JSON.parse(fs.readFileSync(file)).rotations.a;
  assert.equal(saved.phase, 'creating'); assert.deepEqual(saved.newWorktree, plan); assert.equal(saved.newCwd, plan.cwd);
});
for (const during of ['defaults', 'preview']) test(`B2: closing during ${during} cannot persist half a directory plan`, async t => {
  const { dir, room } = roomSetup(t), file = path.join(dir, 'queue-dispatch.json');
  const record = { phase: 'creating', oldNativeId: 'native-a', provider: 'claude', cwd: '/synthetic/automatic', name: 'Agent a', roomIds: [], creatingAt: NOW };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const client = new FakeClient([]);
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, now: () => NOW, migrateDirectories: true, creationDefaults: async () => {
    if (during === 'defaults') dispatcher.close(); return { repository: '/synthetic/repo' };
  } }); dispatcher.client = client;
  client.call = async method => { assert.equal(method, 'gitWorktreePreview'); dispatcher.close(); return projectPlan(); };
  await dispatcher.advanceRotations({ ...client.snapshot(), defaultWorkspace: record.cwd }, NOW);
  dispatcher.save(); // Another already-started callback may flush state after close.
  const saved = JSON.parse(fs.readFileSync(file)).rotations.a;
  assert.equal(saved.phase, 'creating'); assert.equal(saved.newCwd, undefined); assert.equal(saved.newWorktree, undefined);
});
test('B2: saved plans are adopted even when the migration gate is later closed', async t => {
  const plan = projectPlan(), made = member('made', { name: 'Agent a · 续', cwd: '/real/worktree', worktreePreparation: { ...plan, status: 'ready' }, createdAt: NOW - 1000, roomIds: [], roomId: null });
  const { client, record } = await projectRotation(t, { enabled: false, record: { newCwd: plan.cwd, newWorktree: plan }, sessions: [made] });
  assert.equal(record.newId, made.id); assert.equal(client.calls.some(c => ['create', 'gitWorktreePreview'].includes(c[0])), false);
});
test('B2: recovery rejects malformed successor paths and exact plan shapes', t => {
  const { dir } = roomSetup(t), file = path.join(dir, 'queue-dispatch.json'), plan = projectPlan();
  const valid = { phase: 'creating', oldNativeId: 'native-a', name: 'A', roomIds: [], newCwd: plan.cwd, newWorktree: plan };
  for (const extra of [{ newCwd: 'relative' }, { newCwd: '/different' }, { newWorktree: { ...plan, extra: 'bad' } }, { newWorktree: { ...plan, nonce: 7 } }, { newCwd: undefined }, { newWorktree: null }]) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: { ...valid, ...extra } } }), { mode: 0o600 });
    assert.deepEqual(rules.readRotations(file, NOW), {}, JSON.stringify(extra));
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: valid } }), { mode: 0o600 });
  assert.deepEqual(rules.readRotations(file, NOW).a.newWorktree, plan);
});
test('B2: migrated handoff lists names including hidden files, never reads their contents or changes the old folder', t => {
  const { dir } = roomSetup(t), old = path.join(dir, 'workspace');fs.mkdirSync(old);
  for (const name of ['.local', 'a', 'b', 'c']) fs.writeFileSync(path.join(old, name), 'PRIVATE_CONTENT_MUST_NOT_APPEAR');
  const record = { cwd: old, newCwd: projectPlan().cwd, newWorktree: projectPlan() }, snapshot = { defaultWorkspace: old };
  let note = rules.directoryHandoff(record, snapshot);
  for (const name of ['.local', 'a', 'b', 'c']) assert.ok(note.includes(JSON.stringify(name)));
  assert.equal(note.includes('PRIVATE_CONTENT'), false);assert.match(note, /CLAUDE\.md/);assert.equal(fs.readdirSync(old).length, 4);
  for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(old, `extra-${i}`), 'not read');
  note = rules.directoryHandoff(record, snapshot);assert.match(note, /等 25 项/);assert.equal((note.match(/"/g) || []).length, 40);
  assert.equal(rules.directoryHandoff({ ...record, newCwd: old }, snapshot), '');
  assert.equal(rules.directoryHandoff(record, { defaultWorkspace: '/different' }), '');
});

test('a rotation file that is not private or well formed is ignored', t => {
  const { dir } = roomSetup(t);
  const file = path.join(dir, 'queue-dispatch.json');
  const record = { phase: 'handed', oldNativeId: 'native-a', name: 'A', roomIds: ['shared'], newId: 'b' };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o644 });
  assert.deepEqual(rules.readRotations(file, NOW), {});
  fs.chmodSync(file, 0o600);
  assert.equal(rules.readRotations(file, NOW).a.phase, 'handed');
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: { phase: 'stop-everything' } } }), { mode: 0o600 });
  assert.deepEqual(rules.readRotations(file, NOW), {});
});

test('messages from a space handoff or NAW\'s own text are not read as the person stepping in', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  const handoff = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'x1', role: 'user', text: 'handoff from a teammate', origin: 'room' },
    { id: 'r1', role: 'assistant', text: 'done' },
  ];
  assert.equal(plan(rooms, [member('a', { messages: handoff })])[0].status, 'done');
  const replaced = [
    { id: 'native-user', role: 'user', text: '<system-reminder>native note</system-reminder>\n【NAW 派活】task', time: NOW - 29000 },
    { id: 'r1', role: 'assistant', text: 'finished', time: NOW - 20000 },
  ];
  assert.equal(plan(rooms, [member('a', { messages: replaced })])[0].reason, 'record-missing');
});

test('a kept old session is not asked to hand off again for a day', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const old = member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() });
  const kept = { a: { phase: 'kept', keptAt: NOW - 1000, oldNativeId: 'native-a', name: 'A', roomIds: ['shared'] } };
  assert.deepEqual(plan(rooms, [old], { rotations: kept }), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' },
  ]);
});

test('a kept record expires after a day and a failed one after a week', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-rotations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue-dispatch.json');
  const base = { oldNativeId: 'native-a', name: 'A', roomIds: ['shared'] };
  const rotations = {
    a: { ...base, phase: 'kept', keptAt: NOW - 25 * HOUR },
    b: { ...base, phase: 'kept', keptAt: NOW - HOUR },
    c: { ...base, phase: 'failed', failedAt: NOW - 8 * 24 * HOUR },
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations }), { mode: 0o600 });
  assert.deepEqual(Object.keys(rules.readRotations(file, NOW)), ['b']);
});

test('a connection being updated holds the item without recording a send or using up its retries', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  let updating = true;
  client.operationGuard = () => () => {
    if (updating) {
      throw Object.assign(Error('updating'), { uiMessage: { key: 'error.client.connectionUpdatingNoInput' } });
    }
  };
  room.queueAdd('only task', null);
  await dispatcher.start();
  for (let i = 0; i < 6; i += 1) {
    dispatcher.dirty = true;
    await dispatcher.schedule();
  }
  assert.equal(room.value.queue[0].status, 'queued');
  assert.equal(room.value.queue[0].attempts, undefined);
  assert.equal(client.sends().length, 0);
  updating = false;
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1);
});

test('the old session is not stopped while a space collaboration is running', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  client.state.rooms[0].run = { status: 'running', ids: ['someone-else', 'another'] };
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'waits while a collaboration runs');
  client.state.rooms[0].run = null;
  await dispatcher.schedule();
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', 'a']]);
});

test('while the old session waits for a collaboration, the new member already takes work, and the old one ends when it is over', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(client.sends(newId).length, 2, 'the new member got the queued item during the wait');
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0);
  advance(31 * 60 * 1000);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'never stopped while a collaboration runs');
  assert.equal(dispatcher.rotations.a.phase, 'handed');
  client.state.rooms[0].run = null;
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', 'a']]);
});

test('a native row NAW recognised as machine input is not the person stepping in (11-12)', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  const notice = '<task-notification>\n<task-id>bsynth001</task-id>\n<status>completed</status>\n<summary>Synthetic task completed</summary>\n</task-notification>';
  // Every source workspace.cjs records on a machine row: the member's own background task, a scheduled wake, another agent's message.
  for (const inputSource of ['task-notification', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event', 'naw-peer']) {
    const messages = [
      { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
      { id: 'r0', role: 'assistant', text: 'Started the build in the background.' },
      { id: 'n1', role: 'user', text: notice, origin: 'native', inputSource },
      { id: 'r1', role: 'assistant', text: 'Done: the build passed.' },
    ];
    assert.deepEqual(plan(rooms, [member('a', { messages })]), [
      { kind: 'settle', roomId: 'shared', itemId: '1', status: 'done', sessionId: 'a', reply: 'Done: the build passed.' },
      { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a' },
    ], inputSource);
  }
  // The same row without a source is the person, as before: NAW could not tell it from typing.
  const typed = [{ id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' }, { id: 'n1', role: 'user', text: notice, origin: 'native' }, { id: 'r1', role: 'assistant', text: 'Done.' }];
  assert.equal(plan(rooms, [member('a', { messages: typed })])[0].reason, 'person-intervened');
  // Only the sources workspace.cjs records count; any other value may not be machine input.
  for (const inputSource of ['', null, 7, 'user', 'made-up']) {
    const odd = typed.map(m => m.id === 'n1' ? { ...m, inputSource } : m);
    assert.equal(plan(rooms, [member('a', { messages: odd })])[0].reason, 'person-intervened', String(inputSource));
  }
});

test('the person quoting NAW text is still the person; an ended old session needs no wait', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  const quoted = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'h1', role: 'user', text: '关于【NAW 派活】那件，换个做法', origin: 'human' },
    { id: 'r1', role: 'assistant', text: 'OK' },
  ];
  assert.equal(plan(rooms, [member('a', { messages: quoted })])[0].reason, 'person-intervened');
});

test('a rotation whose old session already ended finishes in two minutes even while a collaboration runs', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  client.state.sessions[0].state = 'ended';
  client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  // Two minutes of it: a move of its backend shows the same for a moment (R206).
  for (const minutes of [0, 1, 1, 1]) { advance(minutes * MINUTE); dispatcher.dirty = true; await dispatcher.schedule(); }
  assert.equal(dispatcher.rotations.a, undefined, 'record finished without waiting for the collaboration');
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'nothing left to stop');
});

// cd3e2a8d (2026-11-14): the rotation's stop pauses only the old session's own relays. A relay in another space that
// the old session is not in no longer holds the rotation (it waited up to 30 minutes, then kept the old session) and
// keeps running. One with the old session in it, one in a space it leaves (the test above), or any beside a service
// that pauses every relay at a stop, still holds it.
function otherSpaceRelay(t, ids, participantStop = true) {
  const setup = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  const { room, client, dispatcher } = setup;
  fakeMembership(room, client);
  if (!participantStop) client.capabilities = client.capabilities.filter(cap => cap !== PARTICIPANT_STOP);
  const otherRoom = room.create('Another team');
  client.state.rooms.push({ id: otherRoom, revision: 0, run: null, messages: [] });
  room.queueAdd('next task', 'a');
  const run = { id: 'other-run', roomId: otherRoom, status: 'running', ids };
  return { ...setup, run: () => client.state.rooms.find(r => r.id === otherRoom).run, start: async () => {
    await dispatcher.start();
    client.reply('a', '交接：分支 abc。');
    await dispatcher.schedule();
    await dispatcher.schedule();
    client.state.rooms.find(r => r.id === otherRoom).run = run;
    await dispatcher.schedule();
  } };
}

test('a relay in another space without the old session does not hold its rotation, and keeps running', async t => {
  const f = otherSpaceRelay(t, ['x', 'y']);
  await f.start();
  const stops = f.client.calls.filter(call => call[0] === 'maintenanceStop');
  assert.equal(stops.length, 1, 'the old session is stopped now, not after the relay');
  assert.equal(stops[0][4], 'participant', 'the service is asked to pause only this session\'s relays');
  assert.equal(f.client.state.sessions[0].state, 'ended');
  assert.equal(f.run().status, 'running', 'the other space\'s relay goes on');
  assert.equal(f.dispatcher.rotations.a, undefined, 'the rotation is done');
});

for (const [label, ids, participantStop] of [['has the old session in it', ['a', 'y'], true], ['runs beside a service that pauses every relay at a stop', ['x', 'y'], false]]) {
  test(`a relay in another space that ${label} still holds the rotation`, async t => {
    const f = otherSpaceRelay(t, ids, participantStop);
    await f.start();
    assert.equal(f.client.calls.filter(call => call[0] === 'stop' || call[0] === 'maintenanceStop').length, 0, 'waits while the relay runs');
    assert.equal(f.run().status, 'running');
    assert.equal(f.dispatcher.rotations.a.phase, 'handed');
    f.run().status = 'completed';
    f.dispatcher.dirty = true;
    await f.dispatcher.schedule();
    assert.equal(f.client.state.sessions[0].state, 'ended', 'stopped once the relay ended');
  });
}

test('only a terminal\'s own replies are ignored; every key the person presses counts', () => {
  const { isTerminalResponse } = require('../workspace.cjs');
  const replies = ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;95;0c', '\x1b[0n', '\x1b[?2004;1$y', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[<35;10;5M', '\x1b[I', '\x1b[O'];
  for (const reply of replies) {
    assert.equal(isTerminalResponse(reply), true, JSON.stringify(reply));
    assert.equal(rules.terminalReplyOnly(reply), true, JSON.stringify(reply));
  }
  assert.deepEqual([isTerminalResponse('\x1b[<64;10;5M'), rules.terminalReplyOnly('\x1b[<64;10;5M')], [true, false], 'the wheel: the person may be reading here');
  const keys = ['a', '\r', '\x03', '\x7f', '\x1b[A', '\x1bOA', '\x1b[Z', '\x1b[3~', '\x1b[5~', '\x1b[1;5C', '\x1b[15~', '\x1b[<0;10;5M', 'hi\x1b[I'];
  for (const key of keys) {
    assert.equal(isTerminalResponse(key), false, JSON.stringify(key));
    assert.equal(rules.terminalReplyOnly(key), false, JSON.stringify(key));
  }
});

test('rotated names count up instead of piling suffixes', () => {
  assert.equal(rules.nextName('队员甲'), '队员甲 · 续');
  assert.equal(rules.nextName('队员甲 · 续'), '队员甲 · 续2');
  assert.equal(rules.nextName('队员甲 · 续9'), '队员甲 · 续10');
});

test('a rotation is announced and logged with every session id and native id, and chains show the sessions behind one conversation', async t => {
  const notices = [];
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], {
    notify: (outcome, record) => notices.push([outcome, record.name, record.newName]),
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  assert.deepEqual(notices, [['done', 'Agent a', 'Agent a · 续']]);
  const lines = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const events = [];
  for (const line of lines) {
    events.push(line.event);
  }
  // The person, 11-12: the replaced session is archived after a done rotation, and that is logged too.
  assert.deepEqual(events, ['requested', 'done', 'archived']);
  assert.deepEqual(lines[1].old, { id: 'a', nativeId: 'native-a', name: 'Agent a' });
  assert.equal(lines[1].new.id, newId);
  assert.equal(lines[1].new.nativeId, `native-${newId}`);
  assert.deepEqual(lines[1].spaces, ['shared']);
  const chains = dispatcher.rotationChains();
  assert.equal(chains.length, 1);
  const ids = [];
  for (const link of chains[0].sessions) {
    ids.push(link.id);
  }
  assert.deepEqual(ids, ['a', newId]);
  assert.deepEqual(chains[0].spaces, ['shared']);
  const doneEvent = room.value.events.find(event => event.uiMessage.key === 'notice.rotation.done');
  assert.match(doneEvent.text, /「Agent a（a）」的工作已交给「Agent a · 续（[^）]+）」/);
});

test('chains follow several rotations of one conversation in order', () => {
  const entries = [
    { time: 1, event: 'done', spaces: ['s'], old: { id: 'a', nativeId: 'na', name: 'A' }, new: { id: 'b', nativeId: 'nb', name: 'A · 续' } },
    { time: 2, event: 'failed', spaces: ['s'], old: { id: 'b', nativeId: 'nb', name: 'A · 续' }, new: null },
    { time: 3, event: 'kept', spaces: ['s'], old: { id: 'b', nativeId: 'nb', name: 'A · 续' }, new: { id: 'c', nativeId: 'nc', name: 'A · 续2' } },
  ];
  const chains = rules.rotationChains(entries);
  assert.equal(chains.length, 1);
  const summary = [];
  for (const link of chains[0].sessions) {
    summary.push([link.id, link.nativeId, link.outcome]);
  }
  assert.deepEqual(summary, [['a', 'na', null], ['b', 'nb', 'done'], ['c', 'nc', 'kept']]);
});

test('a kept session rotated again keeps both successors visible; malformed log lines are ignored', t => {
  const entries = [
    { time: 1, event: 'kept', spaces: ['s'], old: { id: 'a', nativeId: 'na', name: 'A' }, new: { id: 'b', nativeId: 'nb', name: 'A · 续' } },
    { time: 2, event: 'done', spaces: ['s'], old: { id: 'a', nativeId: 'na', name: 'A' }, new: { id: 'c', nativeId: 'nc', name: 'A · 续2' } },
    null,
    { time: 3, event: 'done', spaces: 'not-a-list', old: { id: 'x' }, new: null },
  ];
  const chains = rules.rotationChains(entries);
  const paths = [];
  for (const chain of chains) {
    const ids = [];
    for (const link of chain.sessions) {
      ids.push(link.id);
    }
    paths.push(ids.join('>'));
  }
  assert.deepEqual(paths.sort(), ['a>b', 'a>c']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-rotation-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'rotation-log.jsonl'), 'null\n{"event":"done","spaces":"x"}\nnot json\n' + JSON.stringify(entries[0]) + '\n', { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: new RoomState(dir), dataDir: dir, connect: async () => null });
  assert.equal(dispatcher.rotationEntries().length, 1);
  assert.equal(dispatcher.rotationChains().length, 1);
  assert.equal(dispatcher.rotationChains(), dispatcher.rotationChains(), 'cached until the log changes');
});

test('memory or age, whichever comes first, makes a member due; machine pressure lowers the memory bar', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const young = member('a', { createdAt: NOW - HOUR });
  const big = new Map([['a', 1600 * 1024 * 1024]]);
  assert.deepEqual(plan(rooms, [young], { memory: big }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const grown = new Map([['a', 900 * 1024 * 1024]]);
  assert.deepEqual(plan(rooms, [young], { memory: grown }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }]);
  assert.deepEqual(plan(rooms, [young], { memory: grown, memoryLimit: rules.PRESSURE_LIMIT_BYTES }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages() });
  assert.deepEqual(plan(rooms, [old], { memory: new Map() }), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  // A quiet member with no work is rotated for memory after 10 quiet minutes, not 30.
  const finished = [{ id: 'shared', name: 'Team', queue: [item('2', { status: 'done' })] }];
  const quiet = member('a', { lastActivityAt: NOW - 15 * 60000 });
  assert.deepEqual(plan(finished, [quiet], { memory: big }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const busyPerson = member('a', { lastActivityAt: NOW - 5 * 60000 });
  assert.deepEqual(plan(finished, [busyPerson], { memory: big }), []);
  // Under an hour old, a large session is not replaced: its successor would start as large.
  const newborn = member('a', { createdAt: NOW - 30 * 60000 });
  assert.deepEqual(plan(rooms, [newborn], { memory: big }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }]);
});

test('members of every space with a long conversation are rotated once quiet; a short one is not, however old', () => {
  const plain = [{ id: 'shared', name: 'Team' }];
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(plain, [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  const recent = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 10 * 60000 });
  assert.deepEqual(plan(plain, [recent]), []);
  const archived = [{ id: 'shared', name: 'Team', archived: true }];
  assert.deepEqual(plan(archived, [old]), []);
  const messages = [{ role: 'system', text: 'x' }, { role: 'user', text: 'y', time: NOW - 340 * HOUR }, { role: 'assistant', text: 'z', time: NOW - 2 * HOUR }];
  const unrecorded = member('a', { createdAt: undefined, lastActivityAt: NOW - 40 * 60000, messages });
  assert.equal(rules.sessionStart(unrecorded, NOW), NOW - 340 * HOUR);
  assert.deepEqual(plan(plain, [unrecorded]), [], 'three records, two weeks old: not replaced');
  const codexShort = member('c', { provider: 'codex', lastActivityAt: NOW - 40 * 60000, messages: heavyMessages('claude') });
  assert.deepEqual(plan(plain, [codexShort]), [], 'Codex records every step, so 1000 records is still short for it');
  const codexLong = member('c', { provider: 'codex', lastActivityAt: NOW - 40 * 60000, messages: heavyMessages('codex') });
  assert.deepEqual(plan(plain, [codexLong]), [{ kind: 'rotate', sessionId: 'c', reason: 'content' }]);
  const unknown = member('a', { createdAt: undefined, lastActivityAt: NOW - 40 * 60000, messages: [{ role: 'user', text: 'y' }, { role: 'user', text: 'w', time: 1234 }] });
  assert.equal(rules.sessionStart(unknown, NOW), null);
  assert.deepEqual(plan(plain, [unknown], { memory: new Map([['a', 4 * 1024 ** 3]]) }), []);
});

test('the butler named as outside is rotated once quiet like a member; no other session in no space is, nor one twice', () => {
  const plain = [{ id: 'shared', name: 'Team' }];
  const outsider = extra => member('b', { roomIds: [], roomId: null, createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 40 * 60000, ...extra });
  assert.deepEqual(plan(plain, [outsider()], { outside: ['b'] }), [{ kind: 'rotate', sessionId: 'b', reason: 'content' }]);
  assert.deepEqual(plan(plain, [outsider()]), [], 'a session in no space is rotated only as the butler');
  assert.deepEqual(plan(plain, [outsider({ lastActivityAt: NOW - 10 * 60000 })], { outside: ['b'] }), [], 'the same quiet time as a member');
  assert.deepEqual(plan(plain, [outsider({ state: 'working' })], { outside: ['b'] }), []);
  assert.deepEqual(plan(plain, [outsider({ archived: true })], { outside: ['b'] }), []);
  assert.deepEqual(plan(plain, [outsider({ messages: [] })], { outside: ['b'] }), [], 'a short conversation is kept');
  assert.deepEqual(plan(plain, [outsider()], { outside: ['missing'] }), []);
  assert.deepEqual(plan(plain, [outsider()], { outside: ['b'], humanAt: new Map([['b', NOW - 60000]]) }), [], 'the person just used it');
  // One in a space is a member there; naming it as outside too does not rotate it twice.
  const inside = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(plain, [inside], { outside: ['a'] }), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
});

test('the dispatcher names the butler only as the very native session designated, in no space', t => {
  let steward = { sessionId: 'b', nativeId: 'native-b', duty: 'D' };
  const { dispatcher } = dispatcherSetup(t, [], { steward: () => steward });
  const outside = member('b', { roomIds: [], roomId: null });
  assert.equal(dispatcher.stewardOutside([outside]), steward);
  assert.equal(dispatcher.stewardOutside([{ ...outside, nativeId: 'native-other' }]), null, 'another native session under that id');
  assert.equal(dispatcher.stewardOutside([member('b')]), null, 'in a space');
  assert.equal(dispatcher.stewardOutside([]), null);
  steward = null;
  assert.equal(dispatcher.stewardOutside([outside]), null);
  steward = () => { throw Error('unreadable'); };
  const broken = dispatcherSetup(t, [], { steward }).dispatcher;
  assert.equal(broken.stewardOutside([outside]), null, 'a designation that cannot be read names nobody');
  assert.equal(broken.stewardDuty('b', { oldNativeId: 'native-b' }), '');
});

test('the butler is replaced like a member: its duty statement goes with the handoff, and the designation follows once done', async t => {
  const butler = member('b', { roomIds: [], roomId: null, createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', lastActivityAt: NOW - 40 * 60000 });
  const other = member('o', { roomIds: [], roomId: null, createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', lastActivityAt: NOW - 40 * 60000 });
  const duty = '【NAW 职责说明】\n不要陷进执行。';
  let role = null;
  // With no queued work, rotation is checked through an open window (tick), as in the daily app.
  let window = null;
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [butler, other], {
    clients: () => window,
    steward: () => {
      const current = role.current();
      return current && { ...current, duty };
    },
  });
  window = client;
  role = new StewardRole(dir);
  role.set({ sessionId: 'b', nativeId: 'native-b' });
  const joins = fakeMembership(room, client);
  await dispatcher.start();
  await dispatcher.schedule();
  const request = client.sends('b');
  assert.equal(request.length, 1);
  assert.match(request[0][2], /【NAW 换会话】[\s\S]*只写交接/);
  assert.equal(client.sends('o').length, 0, 'another session in no space is not rotated');
  client.reply('b', '交接：在看三个 agent 的交付。');
  await dispatcher.schedule();
  const newId = client.state.sessions[2].id;
  await dispatcher.schedule();
  const handoff = client.sends(newId);
  assert.equal(handoff.length, 1);
  assert.match(handoff[0][2], /交接：在看三个 agent 的交付。[\s\S]*【NAW 职责说明】\n不要陷进执行。/);
  assert.deepEqual(role.current(), { sessionId: 'b', nativeId: 'native-b' }, 'the old session is the butler until the rotation is done');
  await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'b']);
  assert.deepEqual(joins, [], 'neither session joins or leaves a space');
  assert.deepEqual(role.current(), { sessionId: newId, nativeId: `native-${newId}` });
  const done = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(line => line.event === 'done');
  assert.deepEqual(done.spaces, []);
  // The successor rests for a day like a member's: it is not replaced again at once.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue-dispatch.json'), 'utf8')).rotations[newId].phase, 'kept');
});

test('a butler revoked after its handoff was asked for is still replaced, without the duty statement', async t => {
  const butler = member('b', { roomIds: [], roomId: null, createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', lastActivityAt: NOW - 40 * 60000 });
  let role = null, window = null;
  const { client, dispatcher, dir } = dispatcherSetup(t, [butler], {
    clients: () => window,
    steward: () => {
      const current = role.current();
      return current && { ...current, duty: '【NAW 职责说明】\nD' };
    },
  });
  window = client;
  role = new StewardRole(dir);
  role.set({ sessionId: 'b', nativeId: 'native-b' });
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends('b').length, 1);
  role.set(null);
  client.reply('b', '交接：x。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  const handoff = client.sends(newId);
  assert.equal(handoff.length, 1);
  assert.doesNotMatch(handoff[0][2], /职责说明/);
});

test('a handoff that would not fit the backend input is shortened, never the duty statement', () => {
  const duty = '【NAW 职责说明】\n' + 'd'.repeat(3000);
  const text = rules.handoffText('Claude manager', 'h'.repeat(rules.ITEM_TEXT_LIMIT * 2 + 4000), '旧目录说明', duty);
  assert.ok(text.length <= 16000, `${text.length}`);
  assert.ok(text.includes(duty) && text.includes('旧目录说明'));
  assert.match(text, /h…\n\n旧目录说明\n\n【NAW 职责说明】/);
  for (const pad of [0, 1]) {
    const cut = rules.handoffText('A', 'x'.repeat(pad) + '😀'.repeat(9000), '', duty);
    assert.ok(cut.length <= 16000 && cut.includes(duty));
    assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, 'never half a character before the cut');
  }
  const short = rules.handoffText('A', '交接', '', '');
  assert.equal(short, rules.handoffText('A', '交接'), 'no statement, no change');
});

test('a session\'s memory footprint includes its child processes; pressure is macOS\'s own level', () => {
  const top = ['Processes: 812 total', 'PID    PPID   MEM', '10     1      97M', '11     10     48M+', '12     11     2048K-', '20     1      1.5G', '99     1      976M'].join('\n');
  const memory = rules.processMemory([{ id: 'a', pid: 10 }, { id: 'b', pid: 20 }, { id: 'c', pid: 404 }], top);
  assert.equal(memory.get('a'), (97 + 48 + 2) * 1024 * 1024);
  assert.equal(memory.get('b'), 1.5 * 1024 ** 3);
  assert.equal(memory.has('c'), false);
  assert.equal(rules.memoryPressure('1\n'), false);
  assert.equal(rules.memoryPressure('2\n'), true);
  assert.equal(rules.memoryPressure('4'), true);
  assert.equal(rules.memoryPressure('nonsense'), false);
  const listing = require('node:child_process').execFileSync('/usr/bin/top', ['-l', '1', '-stats', 'pid,ppid,mem'], { encoding: 'utf8' });
  const real = rules.processMemory([{ id: 'self', pid: process.pid }], listing);
  assert.ok(real.get('self') > 1024 * 1024, 'measures a real process footprint with top');
  const level = require('node:child_process').execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' });
  assert.match(level.trim(), /^[124]$/, 'macOS reports a pressure level');
});

test('with no queued work, a quiet oversized member of a queue space is still rotated through an open window', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a', { pid: 4242, cwd: '/tmp', lastActivityAt: NOW - 20 * 60000 })]);
  fakeMembership(room, windowClient);
  const id = room.queueAdd('old task', null);
  room.queueMarkSent('shared', id, 'a', 'A', NOW - 3600000);
  room.queueSetDelivery('shared', id, 'tag-0', 0);
  room.queueSettle('shared', id, 'done', '', 'A');
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => null,
    now: () => NOW,
    settleMs: 0,
    tickMs: 3600000,
    sampleProcesses: async () => '4242 1 1660M\n',
    samplePressure: async () => '1\n',
  });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  const sends = windowClient.sends('a');
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /【NAW 换会话】这个会话（连同它的子进程）已占用约 1\.6 GB 内存/);
  const requested = room.value.events.find(event => event.uiMessage.key === 'notice.rotation.requested');
  assert.match(requested.text, /NAW 换会话（这个会话（连同它的子进程）已占用约 1\.6 GB 内存）/);
});

test('with the default settle time and no queued work, a quiet oversized member is rotated on the minute check', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a', { pid: 4242, cwd: '/tmp', lastActivityAt: NOW - 20 * 60000 })]);
  fakeMembership(room, windowClient);
  const id = room.queueAdd('old task', null);
  room.queueMarkSent('shared', id, 'a', 'A', NOW - 3600000);
  room.queueSetDelivery('shared', id, 'tag-0', 0);
  room.queueSettle('shared', id, 'done', '', 'A');
  let now = NOW;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => null,
    now: () => now,
    tickMs: 3600000,
    sampleProcesses: async () => '4242 1 1660M\n',
    samplePressure: async () => '1\n',
  });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  for (let second = 0; second < 70; second += 3) {
    now += 3000;
    await dispatcher.schedule();
  }
  assert.equal(windowClient.sends('a').length, 1, 'rotated within a minute without any queued work');
});

test('a process shared by two sessions is not charged to either', () => {
  const memory = rules.processMemory([{ id: 'a', pid: 10 }, { id: 'b', pid: 10 }, { id: 'c', pid: 20 }], '10 1 879M\n20 1 1000K\n');
  assert.equal(memory.has('a'), false);
  assert.equal(memory.has('b'), false);
  assert.equal(memory.get('c'), 1000 * 1024);
});

test('idle times seen by a minute check are not reused: work added later still waits the full settle time', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a', { pid: 4242, cwd: '/tmp' })]);
  fakeMembership(room, windowClient);
  const old = room.queueAdd('old task', null);
  room.queueMarkSent('shared', old, 'a', 'A', NOW - 3600000);
  room.queueSetDelivery('shared', old, 'tag-0', 0);
  room.queueSettle('shared', old, 'done', '', 'A');
  let now = NOW;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => null,
    now: () => now,
    tickMs: 3600000,
    sampleProcesses: async () => '4242 1 1M\n',
    samplePressure: async () => '1\n',
  });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  now += 30000;
  await dispatcher.schedule();
  room.queueAdd('next task', null);
  now += 1000;
  await dispatcher.schedule();
  assert.equal(windowClient.sends('a').length, 0, 'the member was seen idle 31 s ago, but only by the minute check');
  now += 9000;
  await dispatcher.schedule();
  assert.equal(windowClient.sends('a').length, 1, 'sent once the member has settled under observation');
});

test('only one rotation runs at a time; the largest quiet session goes first', () => {
  const rooms = [{ id: 'shared', name: 'Team' }];
  const quiet = { lastActivityAt: NOW - 40 * 60000 };
  const a = member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), ...quiet });
  const b = member('b', { createdAt: NOW - 26 * HOUR, messages: heavyMessages(), ...quiet });
  const c = member('c', { createdAt: NOW - 40 * HOUR, messages: heavyMessages(), ...quiet });
  const memory = new Map([['a', 200 * 1024 * 1024], ['b', 700 * 1024 * 1024], ['c', 300 * 1024 * 1024]]);
  assert.deepEqual(plan(rooms, [a, b, c], { memory }), [{ kind: 'rotate', sessionId: 'b', reason: 'content' }]);
  assert.deepEqual(plan(rooms, [a, b, c]), [{ kind: 'rotate', sessionId: 'c', reason: 'content' }], 'without a memory sample the oldest goes first');
  const running = { x: { phase: 'requested', oldId: 'x' } };
  assert.deepEqual(plan(rooms, [a, b, c], { memory, rotations: running }), []);
  // A due member that gets work while another rotation runs keeps working.
  const queued = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  assert.deepEqual(plan(queued, [a], { rotations: running }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }]);
});

test('an explicitly selected and persisted Codex chat view survives automatic successor settings', async t => {
  const { Workspace } = require('../workspace.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-explicit-chat-'));
  const record = { id: 'explicit-chat', nativeId: 'synthetic-native', provider: 'codex', view: 'chat', name: 'Synthetic member', cwd: dir,
    roomId: 'shared', messages: [], fleet: [], state: 'idle', model: 'gpt-6.1-sol', nativeSettings: { model: 'gpt-6.1-sol', effort: 'high', mode: null } };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ sessions: [record] }));
  const w = new Workspace({ close() {} }, dir);
  t.after(async () => { await w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(w.get(record.id).view, 'chat', 'load preserves explicit chat');
  const carry = rules.carrySettings(w.get(record.id));
  console.log('OBSERVED', JSON.stringify({ savedView: record.view, loadedView: w.get(record.id).view, successorView: carry.view, carry }));
  assert.equal(carry.view, 'chat', 'an explicit saved chat selection must not be replaced by the default TUI selection');
});

test('a successor carries the old model, effort, permission mode and view; what cannot be carried is named', () => {
  const claude = member('a', { model: 'claude-opus-5-5', nativeEffort: 'xhigh', nativePermissionMode: 'auto', view: 'terminal', roomIds: ['shared'] });
  assert.deepEqual(rules.carrySettings(claude), { settings: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' }, view: 'terminal' });
  const plain = member('a', { model: 'claude-opus-5-5', nativePermissionMode: 'default' });
  assert.deepEqual(rules.carrySettings(plain), { settings: { model: 'claude-opus-5-5' }, view: 'chat' });
  assert.deepEqual(rules.carrySettings(member('a', { nativePermissionMode: 'somethingNew' })), { reason: 'permission-mode' });
  assert.deepEqual(rules.carrySettings(member('a', { model: '原生默认' })), { reason: 'model-unknown' });
  assert.deepEqual(rules.carrySettings(member('a', { model: '原生未报告' })), { reason: 'model-unknown' });
  // Like the person's older Codex records: one space in roomId, no roomIds field.
  const codex = member('c', { provider: 'codex', model: 'gpt-6.1-sol', nativeSettings: { model: 'gpt-6.1-sol', effort: 'ultra', mode: null }, roomId: 'shared', view: 'terminal' });
  delete codex.roomIds;
  assert.deepEqual(rules.carrySettings(codex), { settings: { model: 'gpt-6.1-sol', effort: 'ultra' }, view: 'terminal' }, 'a Codex successor starts in its native TUI');
  const unspecified = { ...codex }; delete unspecified.view;
  assert.deepEqual(rules.carrySettings(unspecified), { settings: { model: 'gpt-6.1-sol', effort: 'ultra' }, view: 'terminal' }, 'a missing view still defaults Codex to terminal');
  const planning = member('c', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'high', mode: 'plan' } });
  assert.deepEqual(rules.carrySettings(planning), { reason: 'collaboration-mode' });
  const twoSpaces = member('a', { roomIds: ['shared', '308f55b3-ec97-467c-a2b8-1ecc47562029'] });
  assert.deepEqual(rules.carrySettings(twoSpaces), { reason: 'several-spaces' });
  // DeepSeek through Codex: the successor starts from the same Codex profile, and must run the same vendor.
  const deepseek = member('d', { provider: 'codex', model: 'deepseek-v4-pro', modelProvider: 'deepseek', requestedSettings: { profile: 'deepseek-pro' }, nativeSettings: { model: 'deepseek-v4-pro', effort: 'high', mode: null } });
  assert.deepEqual(rules.carrySettings(deepseek), { settings: { model: 'deepseek-v4-pro', effort: 'high', profile: 'deepseek-pro' }, view: 'terminal', modelProvider: 'deepseek' });
  assert.equal(rules.settingsMismatch({ model: 'deepseek-v4-pro', profile: 'deepseek-pro' }, member('n', { provider: 'codex', modelProvider: 'openai', nativeSettings: { model: 'deepseek-v4-pro', effort: 'high' } }), 'deepseek'), 'model-provider');
  assert.equal(rules.settingsMismatch({ model: 'deepseek-v4-pro', profile: 'deepseek-pro' }, member('n', { provider: 'codex', modelProvider: 'deepseek', nativeSettings: { model: 'deepseek-v4-pro', effort: 'high' } }), 'deepseek'), null);
  // The carried settings are what the backend accepts.
  const { createSettings } = require('../workspace.cjs');
  assert.deepEqual(createSettings('codex', rules.carrySettings(deepseek).settings), { model: 'deepseek-v4-pro', effort: 'high', profile: 'deepseek-pro' });
  // The lists match what the backend accepts.
  const workspace = require('../workspace.cjs');
  assert.deepEqual(rules.CLAUDE_PERMISSION_MODES, workspace.CLAUDE_PERMISSION_MODES);
  assert.deepEqual(rules.CLAUDE_EFFORTS, workspace.CLAUDE_EFFORTS);
});

test('a successor that reports other settings is caught; last activity falls back to the newest message', () => {
  const carry = { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' };
  assert.equal(rules.settingsMismatch(carry, member('n', { model: '原生默认' })), 'pending');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-sonnet-5-5' })), 'model');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-opus-5-5', nativePermissionMode: 'manual' })), 'permission-mode');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-opus-5-5', nativeEffort: 'low' })), 'effort');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-opus-5-5' })), null, 'effort and mode not reported yet');
  const codexCarry = { model: 'gpt-6.1-sol', effort: 'ultra' };
  assert.equal(rules.settingsMismatch(codexCarry, member('n', { provider: 'codex', nativeSettings: { model: 'gpt-6-astra', effort: 'xhigh' } })), 'model');
  assert.equal(rules.settingsMismatch(codexCarry, member('n', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'xhigh' } })), 'effort');
  assert.equal(rules.settingsMismatch(codexCarry, member('n', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'ultra' } })), null);
  const messages = [{ role: 'user', text: 'a', time: NOW - 340 * HOUR }, { role: 'assistant', text: 'b', time: NOW - 3 * HOUR }];
  assert.equal(rules.lastActivityOf(member('a', { lastActivityAt: NOW - HOUR, messages }), NOW), NOW - HOUR);
  assert.equal(rules.lastActivityOf(member('a', { lastActivityAt: undefined, messages }), NOW), NOW - 3 * HOUR);
});

test('a session whose model is known nowhere is not asked for a handoff or told; it keeps working and is asked again later', async t => {
  const notices = [];
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', model: '原生默认' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
    transcriptRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-')),
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.deepEqual(notices, [], 'no failure notice: its next turn reports the model');
  assert.equal(client.calls.some(call => call[0] === 'create'), false);
  assert.equal(dispatcher.rotations.a, undefined, 'no week of rest is recorded');
  await dispatcher.schedule();
  const sends = client.sends('a');
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /【NAW 派活】[\s\S]*next task/, 'the member simply gets its next item');
  assert.ok(dispatcher.waitingModel(NOW).has('a'), 'passed over while waiting');
  const waits = dispatcher.rotationEntries().filter(entry => entry.event === 'waiting');
  assert.equal(waits.length, 1, 'one log line, however often it is asked');
  assert.deepEqual([waits[0].old.id, waits[0].reason], ['a', 'model-unknown']);
  advance(11 * 60 * 1000);
  assert.equal(dispatcher.waitingModel(NOW + 11 * 60 * 1000).has('a'), false, 'considered again after ten minutes');
});
// The daily case (2026-11-09): a Claude session resumed by a move had not reported its model.
const TRANSCRIPT_ID = '3ab5e2fa-7e77-40f4-b766-561e7df1726b';
function transcriptAt(root, cwd, lines) {
  const folder = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${TRANSCRIPT_ID}.jsonl`), lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
}
test('a Claude transcript gives the model its session last used, read from the end', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/Native Agent Workspace/work_1';
  const session = { provider: 'claude', nativeId: TRANSCRIPT_ID, cwd };
  assert.equal(rules.transcriptModel(session, root), null, 'no transcript');
  const own = { sessionId: TRANSCRIPT_ID, isSidechain: false };
  transcriptAt(root, cwd, [
    { type: 'assistant', ...own, message: { model: 'claude-sonnet-5-5', content: [] } },
    { type: 'user', ...own, message: { content: 'x' } },
    { type: 'assistant', ...own, message: { model: 'claude-opus-5-5', content: [] } },
    { type: 'assistant', ...own, message: { model: '<synthetic>', content: [] } },
    { type: 'assistant', sessionId: TRANSCRIPT_ID, isSidechain: true, message: { model: 'claude-haiku-5-5', content: [] } },
    { type: 'assistant', sessionId: '00000000-0000-4000-8000-000000000000', isSidechain: false, message: { model: 'claude-sonnet-5-5', content: [] } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } },
    '{"type":"assistant","message":{"model":"cut off',
  ]);
  assert.equal(rules.transcriptModel(session, root), 'claude-opus-5-5', 'the last model of its own main conversation; subagent, other-session, unmarked, synthetic and broken lines are skipped');
  assert.equal(rules.transcriptModel(session, root, 120), null, 'only the end is read');
  assert.equal(rules.transcriptModel({ ...session, provider: 'codex' }, root), null);
  assert.equal(rules.transcriptModel({ ...session, nativeId: '../escape' }, root), null);
});
// Queue 794d3cd7 follow-up: the record is where Claude reported it, or under the folder as resolved (/var is
// /private/var on macOS), under CLAUDE_CONFIG_DIR when set; looked up as the compaction counter does.
test('794d3cd7: a transcript Claude reported, or under the resolved folder, gives the model too', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'projects');
  const own = { type: 'assistant', sessionId: TRANSCRIPT_ID, isSidechain: false };
  // Reported by the hook, under a folder no stored cwd names.
  const reported = path.join(base, 'elsewhere', `${TRANSCRIPT_ID}.jsonl`);
  fs.mkdirSync(path.dirname(reported), { recursive: true });
  fs.writeFileSync(reported, JSON.stringify({ ...own, message: { model: 'claude-opus-5-5', content: [] } }) + '\n');
  const session = { provider: 'claude', nativeId: TRANSCRIPT_ID, cwd: '/nowhere/work', nativeTranscript: reported };
  assert.equal(rules.transcriptModel(session, root), 'claude-opus-5-5');
  assert.equal(rules.transcriptModel({ ...session, cwd: undefined }, root), 'claude-opus-5-5', 'with no folder stored');
  assert.equal(rules.transcriptModel({ ...session, nativeTranscript: path.join(base, 'elsewhere', 'other.jsonl') }, root), null, 'another file name');
  assert.equal(rules.transcriptModel({ ...session, nativeTranscript: `elsewhere/${TRANSCRIPT_ID}.jsonl` }, root), null, 'a relative path');
  // Stored through a link, written under the folder it resolves to.
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link);
  transcriptAt(root, real, [{ ...own, message: { model: 'claude-sonnet-5-5', content: [] } }]);
  assert.equal(rules.transcriptModel({ provider: 'claude', nativeId: TRANSCRIPT_ID, cwd: link }, root), 'claude-sonnet-5-5');
  // The reported file comes first.
  assert.equal(rules.transcriptModel({ provider: 'claude', nativeId: TRANSCRIPT_ID, cwd: link, nativeTranscript: reported }, root), 'claude-opus-5-5');
});
test('794d3cd7: the dispatcher reads transcripts under CLAUDE_CONFIG_DIR when it is set', t => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  });
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'naw-claude-config');
  assert.equal(dispatcherSetup(t, []).dispatcher.transcriptRoot, path.join(os.tmpdir(), 'naw-claude-config', 'projects'));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(dispatcherSetup(t, []).dispatcher.transcriptRoot, path.join(os.homedir(), '.claude', 'projects'));
  assert.equal(dispatcherSetup(t, [], { transcriptRoot: '/given' }).dispatcher.transcriptRoot, '/given');
});
test('a resumed Claude session whose model is unreported continues with the model its transcript last used', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  transcriptAt(root, '/tmp', [{ type: 'assistant', sessionId: TRANSCRIPT_ID, isSidechain: false, message: { model: 'claude-opus-5-5', content: [] } }]);
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { nativeId: TRANSCRIPT_ID, createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', model: '原生未报告' })], {
    transcriptRoot: root,
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.match(client.sends('a')[0][2], /【NAW 换会话】[\s\S]*只写交接/);
  client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
  await dispatcher.schedule();
  const created = client.calls.find(call => call[0] === 'create');
  assert.deepEqual(created[1].settings, { model: 'claude-opus-5-5' }, 'the successor runs the model the old session last used');
});
test('a larger session waiting for its model does not hold back the next one in line', async t => {
  // The daily path: members of a space without a queue item, both quiet for two hours, checked
  // once a minute through the open window.
  const big = member('a', { createdAt: NOW - 30 * HOUR, lastActivityAt: NOW - 2 * HOUR, messages: heavyMessages(), cwd: '/tmp', model: '原生默认' });
  const next = member('b', { createdAt: NOW - 20 * HOUR, lastActivityAt: NOW - 2 * HOUR, messages: heavyMessages(), cwd: '/tmp' });
  const holder = {};
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [big, next], {
    clients: () => holder.client,
    sampleProcesses: async () => '',
    samplePressure: async () => '1\n',
    transcriptRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-')),
  });
  holder.client = client;
  fakeMembership(room, client);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.ok(dispatcher.waitingModel(NOW).has('a'), 'the larger one was considered first and is now waiting');
  advance(61000);
  await dispatcher.schedule();
  assert.equal(client.sends('a').length, 0, 'the one without a known model is not asked');
  assert.match((client.sends('b')[0] || [])[2] || '', /【NAW 换会话】[\s\S]*只写交接/, 'the next one is asked for its handoff');
});
test('a session asked again after its ten minutes, its model still unknown, is logged as waiting only once', async t => {
  const holder = {};
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, lastActivityAt: NOW - 2 * HOUR, messages: heavyMessages(), cwd: '/tmp', model: '原生默认' })], {
    clients: () => holder.client,
    sampleProcesses: async () => '',
    samplePressure: async () => '1\n',
    transcriptRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-')),
  });
  holder.client = client;
  fakeMembership(room, client);
  await dispatcher.start();
  await dispatcher.schedule();
  advance(11 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(dispatcher.unknownModelAt.get('a'), NOW + 11 * 60 * 1000, 'asked again once its ten minutes passed');
  assert.equal(dispatcher.rotationEntries().filter(entry => entry.event === 'waiting').length, 1);
  assert.equal(client.sends('a').length, 0);
});
test('the planner passes over a session waiting for its model and takes the next one', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [] }];
  const big = member('a', { createdAt: NOW - 30 * HOUR, lastActivityAt: NOW - 2 * HOUR, messages: heavyMessages() });
  const next = member('b', { createdAt: NOW - 20 * HOUR, lastActivityAt: NOW - 2 * HOUR, messages: heavyMessages() });
  assert.deepEqual(plan(rooms, [big, next]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }], 'the older one goes first');
  assert.deepEqual(plan(rooms, [big, next], { waitingModel: new Set(['a']) }), [{ kind: 'rotate', sessionId: 'b', reason: 'content' }]);
});

test('a week of rest recorded for an unknown model before this fix is dropped, so the session rotates', async t => {
  const { dir, room } = roomSetup(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-transcripts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  transcriptAt(root, '/tmp', [{ type: 'assistant', sessionId: TRANSCRIPT_ID, isSidechain: false, message: { model: 'claude-opus-5-5', content: [] } }]);
  const client = new FakeClient([member('a', { nativeId: TRANSCRIPT_ID, createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', model: '原生未报告' })]);
  fakeMembership(room, client);
  const resting = { phase: 'failed', failedAt: NOW - HOUR, reason: 'cannot-carry:model-unknown', oldId: 'a', oldNativeId: TRANSCRIPT_ID, provider: 'claude', cwd: '/tmp', name: 'Agent a', roomIds: ['shared'] };
  const other = { ...resting, reason: 'cannot-carry:several-spaces', oldId: 'b', oldNativeId: 'native-b', name: 'Agent b' };
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: resting, b: other } }), { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000, transcriptRoot: root });
  t.after(() => dispatcher.close());
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  assert.equal(dispatcher.rotations.b.reason, 'cannot-carry:several-spaces', 'other reasons still rest');
  await dispatcher.schedule();
  assert.match(client.sends('a')[0][2], /【NAW 换会话】[\s\S]*只写交接/, 'asked for its handoff');
});

test('a backend that ignores the settings gives a successor with another model: it is stopped, the old session stays', async t => {
  const notices = [];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  client.ignoreSettings = true;
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  assert.equal(client.sends(newId).length, 0, 'no handoff reaches a successor with another model');
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', newId]]);
  assert.deepEqual(notices, [['failed', 'settings-differ:model']]);
  assert.notEqual(client.state.sessions[0].state, 'ended', 'the old session keeps running');
  assert.ok(client.sends('a').some(call => /【NAW 派活】[\s\S]*next task/.test(call[2])), 'and gets its queued item back');
});

test('without the backend support for carried settings no rotation starts', async t => {
  const notices = [];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  client.state.capabilities = [rules.CAPABILITY];
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.deepEqual(notices, [['failed', 'cannot-carry:backend-cannot-carry-settings']]);
  assert.equal(client.sends('a').some(call => /【NAW 换会话】/.test(call[2])), false);
});

test('a DeepSeek member is not rotated by a backend that cannot start a session from a Codex profile', async t => {
  const notices = [];
  const deepseek = member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages('codex'), cwd: '/tmp', provider: 'codex', model: 'deepseek-v4-pro', modelProvider: 'deepseek', requestedSettings: { profile: 'deepseek-pro' }, nativeSettings: { model: 'deepseek-v4-pro', effort: 'high', mode: null } });
  const { room, client, dispatcher } = dispatcherSetup(t, [deepseek], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.deepEqual(notices, [['failed', 'cannot-carry:backend-cannot-carry-settings']]);
  assert.equal(client.calls.some(call => call[0] === 'create'), false, 'a successor without the profile would run another vendor');
});

test('a successor that reports another permission mode with its first prompt does not keep the work', async t => {
  const notices = [];
  const old = member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', nativePermissionMode: 'auto' });
  const { room, client, dispatcher } = dispatcherSetup(t, [old], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const created = client.calls.find(call => call[0] === 'create');
  assert.deepEqual(created[1].settings, { model: 'claude-test-model', permissionMode: 'auto' });
  const fresh = client.state.sessions[1];
  assert.equal(client.sends(fresh.id).length, 1, 'the handoff went out while the mode was still unreported');
  // The native CLI reports the mode it actually runs with the first prompt.
  fresh.nativePermissionMode = 'manual';
  await dispatcher.schedule();
  assert.deepEqual(notices, [['failed', 'settings-differ:permission-mode']]);
  assert.ok(client.calls.some(call => ['stop', 'stopFailedSuccessor'].includes(call[0]) && call[1] === fresh.id), 'the unused successor is stopped through its guarded path');
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false, 'the old session keeps running');
  assert.equal(room.value.queue[0].assignee, 'a', 'and gets its queued work back');
});

async function rotateTypedSession(t, snapshotFails, terminalClosed = false, typeAfterSnapshot = false) {
  const notices = [];
  const old = member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', terminalInputPending: true });
  const setup = dispatcherSetup(t, [old], { notify: (kind, record) => notices.push(kind) });
  const { room, client, dispatcher, dir } = setup;
  fakeMembership(room, client);
  client.snapshotFails = snapshotFails;
  client.terminalClosed = terminalClosed;
  client.typeAfterSnapshot = typeAfterSnapshot;
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  await dispatcher.schedule();
  return { client, notices, dir, dispatcher };
}

// 换续前发送不丢话 (2026-11-14): a send the person makes after NAW's last check reaches the old session before
// the stop does. The stop is then refused by the service: the old session keeps the words and answers them, the
// rotation waits for it (R206 below), and the designation (which follows only done lines) stays with it until then.
for (const capable of [true, false]) test(`a send that reaches the old session just before its stop keeps it (${capable ? 'conditional stop' : 'old service'})`, async t => {
  const notices = [];
  const { room, client, dispatcher, dir, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })],
    { notify: kind => notices.push(kind) });
  fakeMembership(room, client);
  if (!capable) client.capabilities = [rules.CAPABILITY, rules.ROTATION_CAPABILITY, GUARDED_STOP];
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  client.sendBeforeStop = capable;
  await dispatcher.schedule();
  const old = client.state.sessions.find(s => s.id === 'a');
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false, 'the old process is not ended');
  assert.equal(old.state, capable ? 'working' : 'idle');
  if (capable) {
    assert.equal(old.messages.at(-1).text, 'one more thing', 'the words are in the live session that answers them');
    const asked = client.calls.find(call => call[0] === 'maintenanceStop');
    assert.equal(asked[1], 'a');
    assert.equal(asked[2].peerRevision, null, 'the proof is the state NAW judged, before the send');
  } else {
    assert.equal(client.calls.some(call => call[0] === 'maintenanceStop'), false, 'an old service is never asked to stop unconditionally');
  }
  const log = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const last = log.at(-1);
  assert.equal(last.event, 'waiting');
  assert.equal(last.reason, capable ? 'changed-at-stop' : 'old-service', 'the log says what it waits for');
  assert.equal(last.new.id, newId);
  const { follow } = require('../queue-secretary.cjs');
  assert.equal(follow(path.join(dir, 'rotation-log.jsonl'), { sessionId: 'a', nativeId: old.nativeId }).sessionId, 'a', 'the designation stays with the old session');
  assert.equal(dispatcher.rotations.a.phase, 'handed');
  advance(31 * 60 * 1000); dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.deepEqual(notices, ['kept']);
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false);
});

// A Claude stop the service refuses its own receipt for (seen on the real 2.1.319 window, 2026-11-14): the
// session settled ended with nothing else changed, so the rotation is done. Anything else moved: not proven.
for (const refusal of ['own receipt', 'other change']) test(`a refused Claude stop receipt ${refusal === 'own receipt' ? 'that the settled session proves finishes the rotation' : 'with another change is not taken as done'}`, async t => {
  const notices = [];
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })],
    { notify: kind => notices.push(kind) });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  client.refusesOwnReceipt = refusal;
  await dispatcher.schedule();
  const old = client.state.sessions.find(s => s.id === 'a');
  assert.equal(old.state, 'ended');
  assert.ok(client.calls.some(call => call[0] === 'maintenanceStop' && call[1] === 'a'));
  const log = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  if (refusal === 'own receipt') {
    assert.ok(log.some(entry => entry.event === 'done' && entry.old.id === 'a'), 'the rotation is done');
    assert.deepEqual(notices, ['done']);
  } else {
    assert.equal(log.some(entry => entry.event === 'done'), false, 'an unproven end is not recorded as this rotation\'s');
    assert.equal(log.some(entry => entry.event === 'kept'), false);
  }
});

test('before ending a session typed into, its terminal screen (an unsent prompt included) is saved', async t => {
  const { client, notices, dir } = await rotateTypedSession(t, false);
  assert.ok(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), 'the old session ends');
  assert.deepEqual(notices, ['saved']);
  const files = fs.readdirSync(path.join(dir, 'rotation-terminals'));
  assert.equal(files.length, 1);
  const saved = fs.readFileSync(path.join(dir, 'rotation-terminals', files[0]), 'utf8');
  assert.match(saved, /> UNSENT_DRAFT_42/);
  assert.equal(fs.statSync(path.join(dir, 'rotation-terminals', files[0])).mode & 0o777, 0o600);
  const log = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const done = log.find(entry => entry.event === 'done');
  assert.equal(done.terminal, path.join('rotation-terminals', files[0]));
});

test('when the typed-into terminal cannot be saved, the old session is kept and the person is told', async t => {
  const { client, notices } = await rotateTypedSession(t, true);
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false, 'nothing typed is lost');
  assert.deepEqual(notices, ['keptUnsaved']);
});

// Rotation drill, finding 2 (2026-11-14, run2: an item added to 空间C without a member went to the kept old 辛):
// once the old session is kept beside its successor, the member's work goes to the successor only.
async function keptBesideSuccessor(t) {
  const notices = [];
  const old = member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp', terminalInputPending: true });
  const setup = dispatcherSetup(t, [old], { notify: kind => notices.push(kind) });
  const { room, client, dispatcher } = setup;
  fakeMembership(room, client);
  client.snapshotFails = true;
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.deepEqual(notices, ['keptUnsaved']);
  assert.ok(client.state.sessions[0].roomIds.includes('shared') && client.state.sessions[1].roomIds.includes('shared'), 'both stay in the space');
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  client.reply(newId, 'next task 做完了。');
  await dispatcher.schedule();
  return { ...setup, newId };
}

test('finding 2: after the old session is kept, an item added without a member goes to the successor, not the old one', async t => {
  const { room, client, dispatcher, newId } = await keptBesideSuccessor(t);
  const handoff = client.sends(newId)[0][2];
  assert.doesNotMatch(handoff, /旧会话已经结束/, 'the handoff, sent before the outcome, does not claim the old one ended');
  assert.match(handoff, /要是人这时还在用它，这个空间里没指定成员的活 NAW 先派给你，等人用完，NAW 把之后变了的补给你，再结束它/);
  const before = client.sends('a').length;
  room.queueAdd('C 的新一件（没指定成员）', null);
  await dispatcher.schedule();
  assert.equal(client.sends('a').length, before, 'the kept old session gets no new work');
  assert.match(client.sends(newId).at(-1)[2], /C 的新一件/);
  // While the successor is busy, the item waits for it rather than going to the old session.
  room.queueAdd('再一件', null);
  await dispatcher.schedule();
  assert.equal(client.sends('a').length, before);
  assert.equal(room.value.queue.at(-1).status, 'queued');
  const vacancy = rules.queueVacancies({ rooms: client.snapshot().rooms.map(r => ({ ...r, queue: [] })), sessions: client.snapshot().sessions,
    wakePolicy: AWAKE, idleSince: settledSince(['a', newId]), now: NOW, handedOff: dispatcher.handedOff() })[0];
  assert.equal(vacancy.candidateIds.includes('a'), false, 'nor is it shown as a free member of the space');
});

test('finding 2: an item assigned to the kept old session by name still goes to it, and once the successor ends the old one takes the space\'s work again', async t => {
  const { room, client, dispatcher, newId } = await keptBesideSuccessor(t);
  room.queueAdd('只给旧的', 'a');
  await dispatcher.schedule();
  assert.match(client.sends('a').at(-1)[2], /只给旧的/);
  client.reply('a', '好了。');
  await dispatcher.schedule();
  client.state.sessions.find(s => s.id === newId).state = 'ended';
  const before = client.sends('a').length;
  room.queueAdd('没指定成员的', null);
  await dispatcher.schedule();
  assert.equal(client.sends('a').length, before + 1);
  assert.match(client.sends('a').at(-1)[2], /没指定成员的/);
});

// Review of finding 2: a stopped Codex successor is 'disconnected', a crashed one 'recoverable'; neither carries the work.
for (const state of ['disconnected', 'recoverable', 'error', 'background', 'stopping']) {
  test(`finding 2: a successor that is ${state} no longer keeps the kept old session from the space's work`, async t => {
    const { room, client, dispatcher, newId } = await keptBesideSuccessor(t);
    client.state.sessions.find(s => s.id === newId).state = state;
    const before = client.sends('a').length;
    room.queueAdd('没指定成员的', null);
    await dispatcher.schedule();
    assert.equal(client.sends('a').length, before + 1);
    assert.match(client.sends('a').at(-1)[2], /没指定成员的/);
  });
}

test('the butler\'s handoff says the designation stays with an old session in use until that is ended', () => {
  const text = rules.handoffText('大管家', '交接', '', '【大管家职责】');
  assert.match(text, /要是人这时还在用旧会话，大管家先仍是它，等人用完，NAW 把之后变了的补给你，再结束它、由你接着当/);
  assert.doesNotMatch(text, /旧会话已经结束/);
});

test('a typed-into session whose terminal is no longer open is ended without reopening it', async t => {
  const { client, notices, dir } = await rotateTypedSession(t, false, true);
  assert.ok(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), 'nothing unsent remains, so it ends');
  assert.deepEqual(notices, ['done']);
  assert.equal(fs.existsSync(path.join(dir, 'rotation-terminals')), false, 'no screen was made up');
});

test('an unsent native prompt refuses the handoff request: no failure, no notice, asked again later', async t => {
  const notices = [];
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  const original = client.call.bind(client);
  let drafts = 1;
  client.call = async (method, ...args) => {
    if (method === 'dispatch' && drafts > 0) {
      drafts -= 1;
      client.calls.push([method, ...args]);
      throw Object.assign(Error('原生终端里还有未发送的草稿。'), { uiMessage: { key: 'error.submission.nativeDraft' } });
    }
    return original(method, ...args);
  };
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.deepEqual(notices, [], 'no failure is recorded or announced');
  assert.equal(client.calls.filter(call => call[0] === 'dispatch').length, 1);
  advance(60000);
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'dispatch').length, 1, 'the person is left alone for a while');
  advance(2 * 60000);
  await dispatcher.schedule();
  const sends = client.sends('a');
  assert.match(sends[sends.length - 1][2], /【NAW 换会话】/, 'asked again once the person has been quiet');
});

test('typing into the old terminal after its screen was saved keeps the old session', async t => {
  const { client, notices, dispatcher } = await rotateTypedSession(t, false, false, true);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false);
  assert.deepEqual(notices, ['kept']);
});

test('a session the person starts using just before the stop keeps its spaces and process', async t => {
  const notices = [];
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], {
    notify: (kind, record) => notices.push(kind),
  });
  const joins = fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  // The person sends the old session a message in chat view while the successor takes over.
  client.busyOnRefresh = true;
  await dispatcher.schedule();
  advance(31 * 60 * 1000);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false);
  assert.deepEqual(notices, ['kept']);
  assert.equal(joins.some(join => join[0] === 'a' && join[1] === false), false, 'it never left its spaces');
});

test('a prompt left unsent keeps an assigned item waiting instead of failing it', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a')]);
  const original = client.call.bind(client);
  let drafts = rules.NOT_SENT_ATTEMPTS + 2;
  client.call = async (method, ...args) => {
    if (method === 'dispatch' && drafts > 0) {
      drafts -= 1;
      client.calls.push([method, ...args]);
      throw Object.assign(Error('原生终端里还有未发送的草稿。'), { uiMessage: { key: 'error.submission.nativeDraft' } });
    }
    return original(method, ...args);
  };
  room.queueAdd('assigned task', 'a');
  await dispatcher.start();
  for (let attempt = 0; attempt < rules.NOT_SENT_ATTEMPTS + 2; attempt += 1) {
    await dispatcher.schedule();
    assert.notEqual(room.value.queue[0].status, 'failed', 'the item waits while the prompt holds text');
    advance(3 * 60000);
  }
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].status, 'sent', 'sent once the prompt is clear');
});

test('NAW moves an old backend by itself only as the person set it: proven with updates on, any once quiet with migration on', () => {
  const proven = { backendKey: 'b1', switch: { ready: true, auto: true, stops: [{ id: 'p' }] } };
  const unproven = { backendKey: 'b2', switch: { ready: true, auto: false, stops: [{ id: 'a' }] } };
  const blocked = { backendKey: 'b3', switch: { ready: false, auto: false, stops: [{ id: 'c' }] } };
  const quietSession = id => member(id, { lastActivityAt: NOW - 15 * 60000 });
  const sessions = [quietSession('p'), quietSession('a'), quietSession('c')];
  const none = new Map();
  const move = (options, settings, list = sessions, humanAt = none, failed = new Set()) => rules.nextBackendMove(options, settings, list, humanAt, NOW, failed);
  assert.equal(move([proven, unproven], { auto: false, migrate: false }), null);
  assert.equal(move([unproven, proven], { auto: true, migrate: false }), proven, 'updates alone never move a move that needs confirmation');
  assert.equal(move([unproven, blocked], { auto: false, migrate: true }), unproven);
  assert.equal(move([blocked], { auto: true, migrate: true }), null, 'a move that is not ready never runs');
  const busy = [quietSession('p'), member('a', { lastActivityAt: NOW - 5 * 60000 })];
  assert.equal(move([unproven], { auto: false, migrate: true }, busy), null, 'used five minutes ago: not yet');
  assert.equal(move([unproven], { auto: false, migrate: true }, sessions, new Map([['a', NOW - 60000]])), null, 'the person just used it');
  assert.equal(move([unproven], { auto: false, migrate: true }, sessions, none, new Set(['b2'])), null, 'a failed move is not retried in this run');
  assert.equal(move([unproven], { auto: false, migrate: true }, [quietSession('p')]), null, 'a session that cannot be read is not moved');
  assert.equal(rules.MIGRATE_QUIET_MS, 10 * 60000);
});

test('automatic migration accepts only typed-into terminals and Codex endings; teammates, children, unreported work and goals wait', () => {
  const { migrationSafe } = require('../backend-switch.cjs');
  const claude = extra => member('a', { backgroundStale: false, background: 0, scheduled: 0, terminalInputPending: true, ...extra });
  assert.equal(migrationSafe(claude()), true, 'only text perhaps typed in the terminal, saved first');
  assert.equal(migrationSafe(claude({ backgroundStale: false, background: null, scheduled: null })), true, 'nothing started since the process began');
  assert.equal(migrationSafe(claude({ fleet: [{ event: 'TeammateIdle' }] })), false, 'Agent Teams teammates may still run');
  assert.equal(migrationSafe(claude({ fleet: [{ event: 'SubagentStart', id: 'x', stale: true }] })), false, 'an earlier child may still run');
  assert.equal(migrationSafe(claude({ backgroundStale: true })), false, 'background work not yet reported');
  assert.equal(migrationSafe(claude({ background: null, scheduled: 0 })), false);
  assert.equal(migrationSafe(claude({ state: 'working' })), false);
  const codex = extra => member('c', { provider: 'codex', ...extra });
  assert.equal(migrationSafe(codex()), true, 'its native program ends, as the person accepted');
  assert.equal(migrationSafe(codex({ nativeGoal: { status: 'active' } })), false, 'an active goal is never ended by migration');
  assert.equal(migrationSafe(codex({ nativeGoal: { status: 'paused' } })), true);
});

test('migration moves an unproven backend only when every session is safe and provably quiet', () => {
  const plan = { backendKey: 'b', switch: { ready: true, auto: false, stops: [{ id: 'a' }] } };
  const settings = { auto: false, migrate: true };
  const safe = extra => member('a', { backgroundStale: false, background: 0, scheduled: 0, terminalInputPending: true, lastActivityAt: NOW - 15 * 60000, ...extra });
  const move = session => rules.nextBackendMove([plan], settings, [session], new Map(), NOW, new Set());
  assert.equal(move(safe()), plan);
  assert.equal(move(safe({ fleet: [{ event: 'TaskCompleted' }] })), null);
  assert.equal(move(safe({ provider: 'codex', nativeGoal: { status: 'active' } })), null);
  assert.equal(move(safe({ lastActivityAt: undefined, createdAt: undefined, messages: [] })), null, 'unknown activity is not quiet');
  const proven = { backendKey: 'p', switch: { ready: true, auto: true, stops: [{ id: 'a' }] } };
  assert.equal(rules.nextBackendMove([proven], settings, [safe({ fleet: [{ event: 'TaskCompleted' }] })], new Map(), NOW, new Set()), proven, 'a proven plan was already checked by the runtime');
});

// The person, 2026-11-09: 「那么多更新应该自动更新才对，避免问题，我一个个搞肯定来不及」.
test('with migration on, a backend whose teammates, earlier children or background NAW cannot see end moves after 30 quiet minutes', () => {
  const { migrationAcceptable } = require('../backend-switch.cjs');
  const claude = extra => member('a', { backgroundStale: false, background: 0, scheduled: 0, terminalInputPending: true, ...extra });
  assert.equal(migrationAcceptable(claude({ fleet: [{ event: 'TeammateIdle' }] })), true, 'teammates whose end is not reported');
  assert.equal(migrationAcceptable(claude({ fleet: [{ event: 'SubagentStart', id: 'x', stale: true }] })), true, 'a child seen before the process restarted');
  assert.equal(migrationAcceptable(claude({ backgroundStale: true, background: null, scheduled: null })), true, 'background work not reported');
  assert.equal(migrationAcceptable(claude({ fleet: [{ event: 'SubagentStart', id: 'x', stale: false }] })), false, 'a child running now');
  assert.equal(migrationAcceptable(claude({ background: 2 })), false, 'background work reported running');
  assert.equal(migrationAcceptable(claude({ backgroundStale: true, background: 2 })), false, 'even when that report is from before the last turn');
  assert.equal(migrationAcceptable(claude({ scheduled: 1 })), false, 'scheduled work reported');
  assert.equal(migrationAcceptable(claude({ state: 'working' })), false);
  assert.equal(migrationAcceptable(claude({ pendingTag: 'p' })), false, 'something waiting');
  assert.equal(migrationAcceptable(member('c', { provider: 'codex', nativeGoal: { status: 'active' } })), false, 'an active goal is never ended');
  assert.equal(migrationAcceptable(member('c', { provider: 'codex', fleet: [{ event: 'thread/started', id: 't', stale: true }] })), true);

  const plan = { backendKey: 'b', switch: { ready: true, auto: false, stops: [{ id: 'a' }] } };
  const settings = { auto: false, migrate: true };
  const team = minutes => claude({ fleet: [{ event: 'TeammateIdle' }], lastActivityAt: NOW - minutes * 60000 });
  const move = session => rules.nextBackendMove([plan], settings, [session], new Map(), NOW, new Set());
  assert.equal(move(team(15)), null, 'quiet 15 minutes: not yet');
  assert.equal(move(team(31)), plan, 'quiet 31 minutes: moved');
  const reporting = claude({ fleet: [{ event: 'TeammateIdle', time: NOW - 60000 }], lastActivityAt: NOW - 60 * 60000 });
  assert.equal(move(reporting), null, 'a teammate reported a minute ago: that is activity too');
  const reportedLongAgo = claude({ fleet: [{ event: 'TeammateIdle', time: NOW - 31 * 60000 }], lastActivityAt: NOW - 60 * 60000 });
  assert.equal(move(reportedLongAgo), plan);
  assert.equal(move(member('c', { provider: 'codex', nativeGoal: { status: 'active' }, lastActivityAt: NOW - 60 * 60000 })), null);
  assert.equal(rules.nextBackendMove([plan], { auto: false, migrate: false }, [team(60)], new Map(), NOW, new Set()), null, 'never without the person\'s setting');
  assert.equal(rules.nextBackendMove([plan], settings, [team(31)], new Map([['a', NOW - 60000]]), NOW, new Set()), null, 'the person just used it');
  assert.equal(rules.MIGRATE_UNPROVEN_QUIET_MS, 30 * 60000);
  // The re-check right before each stop uses the same rule.
  assert.equal(rules.migrationReady(team(31), new Map(), NOW), true);
  assert.equal(rules.migrationReady(team(15), new Map(), NOW), false);
  assert.equal(rules.migrationReady(claude({ lastActivityAt: NOW - 11 * 60000 }), new Map(), NOW), true, 'a proven-safe session still needs only 10 minutes');
  assert.equal(rules.migrationReady(claude({ state: 'working', lastActivityAt: NOW - 60 * 60000 }), new Map(), NOW), false);
});

test('only the conversation since the last /clear counts toward the record limit; dispatches carry the queue rule', () => {
  const before = heavyMessages();
  const boundary = { id: 'boundary', role: 'system', kind: 'context', text: '原生上下文' };
  const cleared = member('a', { lastActivityAt: NOW - 40 * 60000, messages: [...before, boundary, { id: 'n1', role: 'user', text: 'new' }] });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team' }], [cleared]), [], 'a just-cleared conversation is short');
  const text = rules.dispatchText('Team', item('1'));
  assert.match(text, /不留后台命令/);
  assert.match(text, /本轮最后一条回复的第一行/);
  assert.match(text, /不留运行中的队友/);
  assert.match(text, /不要自己去任务板认领/);
});

test('an old session that already handed off is not replaced again', () => {
  const rooms = [{ id: 'shared', name: 'Team' }];
  const kept = member('a', { lastActivityAt: NOW - 40 * 60000, messages: heavyMessages() });
  assert.deepEqual(plan(rooms, [kept]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  assert.deepEqual(plan(rooms, [kept], { handedOff: new Set(['a']) }), [], 'its successor already carries the work');
  assert.deepEqual(plan(rooms, [kept], { handedOff: new Set(['a']), memory: new Map([['a', 4 * 1024 ** 3]]) }), [], 'not for memory either: a third session would follow');
});

test('decision notification keeps only the first line before the queue summary flattens it', () => {
  const messages = [{id:'t1',role:'user',text:'NAW task',origin:'naw-dispatch'},
    {id:'r1',role:'assistant',text:'Needs your decision: Proceed?\nPrivate remainder'}];
  const actions = plan([{id:'shared',queue:[sentItem()]}],[member('a',{messages})]);
  assert.equal(actions[0].question, 'Proceed?');
  assert.ok(actions[0].reply.includes('Private remainder'), 'Existing in-app summary is retained');
});

for (const recordedDirectory of [false, true]) test(`B2: joining ${recordedDirectory ? 'the same directory' : 'a legacy record without a new directory'} never snapshots the client`, async t => {
  const old = member('a', { cwd: '/synthetic/unchanged' });
  const fresh = member('made', { cwd: old.cwd, roomIds: [], roomId: null });
  const { client, dispatcher, room } = dispatcherSetup(t, [old, fresh]);
  const joins = fakeMembership(room, client), next = room.queueAdd('ordinary queued work', old.id);
  const record = { phase: 'joining', oldNativeId: old.nativeId, provider: old.provider, cwd: old.cwd, name: old.name, roomIds: ['shared'], newId: fresh.id, newName: fresh.name,
    ...(recordedDirectory ? { newCwd: old.cwd } : {}) };
  const snapshot = structuredClone(client.state);
  dispatcher.client = client; dispatcher.rotations[old.id] = record;
  let reads = 0;
  client.snapshot = () => { reads++; throw Error('session ownership conflict'); };
  await dispatcher.advanceRotation(old.id, record, snapshot, NOW);
  assert.equal(reads, 0, 'same-directory joining must not add a fallible client read');
  assert.equal(record.phase, 'created');
  assert.deepEqual(joins, [[fresh.id, true, 'shared']]);
  assert.equal(room.queueItems('shared').find(item => item.id === next).assignee, fresh.id);
});

const trustPrompt = provider => ({ kind: 'directory-trust', provider, source: 'native-terminal' });
test('Codex TUI successor waits for native identity, live PTY and input readiness before queue transfer or handoff', async t => {
  const old = member('a', { provider: 'codex', cwd: '/synthetic/unchanged' });
  const fresh = member('made', { provider: 'codex', cwd: old.cwd, nativeId: null, state: 'starting', chatAvailable: false, view: 'terminal', roomIds: [], roomId: null });
  const { client, dispatcher, room } = dispatcherSetup(t, [old, fresh]); fakeMembership(room, client);
  const queued = room.queueAdd('keep this task exactly once', old.id);
  const record = { phase: 'joining', oldNativeId: old.nativeId, oldControl: 0, provider: 'codex', view: 'terminal', cwd: old.cwd, name: old.name, roomIds: ['shared'], newId: fresh.id, newName: fresh.name, createdNewAt: NOW, handoff: 'Actual handoff' };
  dispatcher.client = client; dispatcher.rotations[old.id] = record;
  for (const state of [
    {},
    { terminalState: { alive: true, epoch: 'owned-pty' }, nativeStartupPrompt: trustPrompt('codex') },
    { nativeId: 'new-native', nativeStartupPrompt: null, state: 'idle', chatAvailable: true, terminalState: { alive: false } },
    { terminalState: { alive: true, epoch: 'owned-pty' }, chatAvailable: false },
    { chatAvailable: true, nativeStartupPrompt: trustPrompt('codex') },
    { chatAvailable: false, nativeStartupPrompt: null },
  ]) {
    Object.assign(fresh, state);
    await dispatcher.advanceRotation(old.id, record, client.snapshot(), NOW);
    assert.equal(record.phase, 'joining');
    assert.equal(room.queueItems('shared').find(i => i.id === queued).assignee, old.id);
    assert.equal(client.calls.some(c => ['create', 'dispatch', 'stop', 'input', 'approve', 'answer'].includes(c[0])), false);
    assert.deepEqual(plan(room.apply(client.snapshot()).rooms, client.state.sessions, { rotations: dispatcher.rotations }), [], 'neither member can take a second task during native startup');
  }
  dispatcher.save();
  assert.equal(rules.readRotations(dispatcher.file, NOW)[old.id].phase, 'joining', 'a restart preserves the pending native wait and successor identity');
  await dispatcher.advanceRotation(old.id, record, client.snapshot(), NOW + HOUR);
  assert.equal(record.phase, 'joining', 'an unattended native wait has no model-request deadline');
  Object.assign(fresh, { chatAvailable: true });
  dispatcher.idleSince.set(fresh.id, NOW - 1);
  await dispatcher.advanceRotation(old.id, record, client.snapshot(), NOW + HOUR);
  assert.equal(record.phase, 'created'); assert.equal(room.queueItems('shared').find(i => i.id === queued).assignee, fresh.id);
  assert.equal(record.createdNewAt, NOW + HOUR, 'post-login readiness gets its own settle/model-observation deadline');
  await dispatcher.advanceRotation(old.id, record, client.snapshot(), NOW + HOUR);
  await dispatcher.advanceRotation(old.id, record, client.snapshot(), NOW + HOUR);
  assert.equal(client.sends(fresh.id).length, 1, 'the actual handoff is the only input, never a seed turn');
  assert.equal(client.state.sessions.length, 2); assert.equal(fresh.nativeId, 'new-native');
  assert.equal(room.queueItems('shared').filter(i => i.id === queued).length, 1);
});
test('a failed Codex TUI successor leaves the old task intact instead of waiting forever', async t => {
  const old = member('a', { provider: 'codex', cwd: '/synthetic/unchanged' });
  const fresh = member('made', { provider: 'codex', nativeId: null, state: 'error', view: 'terminal', roomIds: [], roomId: null });
  const { client, dispatcher, room } = dispatcherSetup(t, [old, fresh]); fakeMembership(room, client);
  const queued = room.queueAdd('Original task', old.id);
  const record = dispatcher.rotations[old.id] = { phase: 'joining', oldNativeId: old.nativeId, provider: 'codex', view: 'terminal', cwd: old.cwd, name: old.name, roomIds: ['shared'], newId: fresh.id, newName: fresh.name };
  dispatcher.client = client;
  await dispatcher.advanceRotations(client.snapshot(), NOW);
  assert.equal(record.phase, 'failed'); assert.equal(record.reason, 'new-session-not-ready');
  assert.equal(old.state, 'idle'); assert.equal(room.queueItems('shared').find(i => i.id === queued).assignee, old.id);
  assert.equal(client.calls.some(c => c[0] === 'dispatch' || c[0] === 'create' || c[0] === 'stop' && c[1] === old.id), false);
});
test('B2: a migrated successor asking directory trust pauses before joining, does not accept or send, and announces once', async t => {
  const notices = [];
  const { client, dispatcher, record } = await projectRotation(t, { directoryTrustTimeoutMs: 48 * HOUR, notify: (kind, value) => notices.push([kind, value.newId]), record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude'); } });
  const room = dispatcher.roomState, id = room.queueAdd('still owned by old member', 'a');
  assert.equal(record.phase, 'waiting-trust');
  assert.equal(client.state.sessions.find(s => s.id === record.newId).roomIds.length, 0, 'it has not joined or acquired the old queue');
  for (const elapsed of [1, 11 * 60000, 24 * HOUR]) await dispatcher.advanceRotations(client.snapshot(), NOW + elapsed);
  assert.equal(record.phase, 'waiting-trust', 'the explicitly configured two-day trust deadline has not expired');
  assert.equal(client.calls.some(c => ['stop', 'dispatch', 'approve', 'answer', 'input'].includes(c[0])), false);
  assert.equal(room.queueItems('shared').find(item => item.id === id).assignee, 'a');
  const decisions = room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.needsTrust');
  assert.equal(decisions.length, 1); assert.match(decisions[0].text, /^需要你决定：/);
  assert.equal(JSON.stringify(decisions).includes('/synthetic/'), false, 'native screen/cwd are not published in the space');
  assert.equal(dispatcher.rotationEntries().filter(e => e.event === 'waiting').length, 1);
  assert.deepEqual(notices, [['needsTrust', record.newId]], 'one decision notification for this successor');
});

test('B2: persisted trust wait survives restart without duplicate notices or a new successor, then resumes the same ready one', async t => {
  const { client, dispatcher, record, dir } = await projectRotation(t, { record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude'); } });
  const made = record.newId;
  dispatcher.close();
  const room = new RoomState(dir); fakeMembership(room, client);
  assert.equal(room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.needsTrust').length, 1, 'decision receipt reloads from the space file');
  const notifications = [], restored = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000, migrateDirectories: false, notify: kind => notifications.push(kind) });
  t.after(() => restored.close()); await restored.start(); await restored.schedule();
  assert.equal(restored.rotations.a.phase, 'waiting-trust');
  assert.equal(client.calls.filter(c => c[0] === 'create').length, 1); assert.deepEqual(notifications, []);
  assert.equal(room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.needsTrust').length, 1);
  const fresh = client.state.sessions.find(s => s.id === made); fresh.nativeStartupPrompt = null;
  await restored.advanceRotations(client.snapshot(), NOW + 1000);
  assert.equal(restored.rotations.a.phase, 'waiting-trust', 'a disappearing line alone does not resume anything');
  fresh.state = 'idle'; restored.idleSince.set(made, NOW); await restored.advanceRotations(client.snapshot(), NOW + 2000);
  assert.equal(restored.rotations.a.phase, 'created');
  await restored.advanceRotations(client.snapshot(), NOW + 3000);
  assert.equal(restored.rotations.a.phase, 'handed');
  assert.equal(client.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(client.sends(made).length, 1, 'one handoff only after real native readiness');
});

test('B2: a trust wait observed after joining returns only queued assignments to the old member; cancellation is retained', async t => {
  const { client, dispatcher, record } = await projectRotation(t, { record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; } });
  const room = dispatcher.roomState, id = room.queueAdd('cancel this before handoff', record.newId);
  const fresh = client.state.sessions.find(s => s.id === record.newId); fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude');
  await dispatcher.advanceRotations(client.snapshot(), NOW + 1000);
  assert.equal(room.queueItems('shared').find(item => item.id === id).assignee, 'a');
  room.queueCancel(id);
  await dispatcher.advanceRotations(client.snapshot(), NOW + 4 * 60000);
  assert.equal(room.queueItems('shared').find(item => item.id === id).status, 'cancelled');
  assert.equal(client.sends(record.newId).length, 0);
});

test('B2: the old member\'s own background task ending during the trust wait is not the person (11-12)', async t => {
  // NAW recognised the row as machine input, so it moved no control revision; only its source tells it from typing.
  const notice = '<task-notification>\n<task-id>bsynth002</task-id>\n<status>completed</status>\n<summary>Synthetic task completed</summary>\n</task-notification>';
  for (const inputSource of ['task-notification', undefined]) {
    const { client, dispatcher, record } = await projectRotation(t, { record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude'); } });
    await dispatcher.advanceRotations(client.snapshot(), NOW + 1000);
    assert.equal(record.phase, 'waiting-trust');
    client.state.sessions.find(s => s.id === 'a').messages.push({ id: 'n1', role: 'user', text: notice, origin: 'native', ...(inputSource ? { inputSource } : {}), time: NOW - 1000 },
      { id: 'r1', role: 'assistant', text: 'The synthetic task finished.', time: NOW - 500 });
    await dispatcher.advanceRotations(client.snapshot(), NOW + 2000);
    if (inputSource) assert.notEqual(record.reason, 'person-active', 'a recognised notification lets the rotation go on');
    else assert.deepEqual([record.phase, record.reason], ['failed', 'person-active'], 'the same row without a source is the person, as before');
    assert.equal(client.calls.some(c => c[0] === 'stop' && c[1] === 'a'), false);
  }
});

test('a background task\'s notification after the rotation request: its reply joins the handoff summary; without a source it is the person (11-12)', async t => {
  const notice = '<task-notification>\n<task-id>bsynth003</task-id>\n<status>completed</status>\n<summary>Synthetic task completed</summary>\n</task-notification>';
  for (const inputSource of ['task-notification', undefined]) {
    const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
    fakeMembership(room, client);
    room.queueAdd('next task', 'a');
    await dispatcher.start();
    assert.equal(dispatcher.rotations.a.phase, 'requested');
    const old = client.state.sessions.find(s => s.id === 'a');
    old.messages.push({ id: 'summary', role: 'assistant', text: '交接：分支 abc。' },
      { id: 'n1', role: 'user', text: notice, origin: 'native', ...(inputSource ? { inputSource } : {}) },
      { id: 'r1', role: 'assistant', text: 'The synthetic task finished.' });
    old.rotationEpisode.responseTag = old.rotationEpisode.tag; // The native control turn completed.
    old.state = 'idle';
    await dispatcher.schedule(); await dispatcher.schedule(); await dispatcher.schedule();
    const successor = client.state.sessions.find(s => s.id !== 'a');
    if (inputSource) {
      const sent = client.sends(successor.id).map(call => JSON.stringify(call)).join('\n');
      assert.ok(sent.includes('交接：分支 abc。') && sent.includes('The synthetic task finished.'), 'the summary is kept and the later reply joins it');
    } else {
      assert.equal(successor, undefined, 'no successor was made');
      assert.equal(client.calls.some(c => c[0] === 'stop' && c[1] === 'a'), false);
    }
  }
});

test('B2: person activity during the trust wait cancels the handoff without ending the old member', async t => {
  const { client, dispatcher, record } = await projectRotation(t, { record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude'); } });
  client.state.sessions.find(s => s.id === 'a').controlRevision++;
  await dispatcher.advanceRotations(client.snapshot(), NOW + 1000);
  assert.equal(record.phase, 'failed'); assert.equal(record.reason, 'person-active');
  assert.equal(client.calls.some(c => c[0] === 'stop' && c[1] === 'a'), false);
  assert.equal(client.calls.filter(c => c[0] === 'stop' && c[1] === record.newId).length, 1);
  assert.equal(client.calls.some(c => ['input', 'approve', 'answer'].includes(c[0])), false);
  assert.equal(client.sends(record.newId).length, 0);
});
for (const outcome of ['closed', 'missing']) test(`B2: ${outcome} successor while waiting for trust fails without ending the old member`, async t => {
  const { client, dispatcher, record } = await projectRotation(t, { record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude'); } });
  const made = record.newId;
  if (outcome === 'closed') client.state.sessions.find(s => s.id === made).state = 'ended';
  else client.state.sessions = client.state.sessions.filter(s => s.id !== made);
  await dispatcher.advanceRotations(client.snapshot(), NOW + 1000);
  assert.equal(record.phase, 'failed'); assert.equal(client.state.sessions.find(s => s.id === 'a').state, 'idle');
  assert.equal(client.calls.some(c => c[0] === 'stop' && c[1] === 'a'), false);
  assert.equal(client.sends(made).length, 0);
});

for (const moved of [false, true]) test(`B2: ${moved ? 'a moved directory with a wrong-provider' : 'a same-directory'} startup observation cannot take the migration trust path`, async t => {
  const { client, dispatcher, record } = await projectRotation(t, { enabled: moved, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('codex'); } });
  assert.equal(record.newCwd !== record.cwd, moved, 'exercise both directory and provider guards independently');
  await dispatcher.advanceRotations(client.snapshot(), NOW + 1000);
  assert.equal(record.phase, 'created');
  assert.equal(dispatcher.roomState.value.events.some(e => e.uiMessage?.key === 'notice.rotation.needsTrust'), false);
});

test('B2: startup trust replay fills an unannounced receipt without duplicating the stored space event', async t => {
  const { client, dispatcher, record, dir } = await projectRotation(t, { record: { oldControl: 0 }, afterCreate(fresh) { fresh.state = 'starting'; fresh.nativeStartupPrompt = trustPrompt('claude'); } });
  const file = path.join(dir, 'queue-dispatch.json');
  dispatcher.close(); delete record.trustNotified; delete record.trustEffects; delete record.trustOwner;
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const room = new RoomState(dir); fakeMembership(room, client);
  const notices = [], resumed = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000, notify: type => notices.push(type) }); t.after(() => resumed.close());
  await resumed.start(); await resumed.schedule();
  assert.deepEqual(notices, ['needsTrust']);
  assert.equal(room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.needsTrust').length, 1);
  assert.equal(resumed.rotationEntries().filter(e => e.event === 'waiting').length, 1);
});

test('B2: persisted directory-trust wait validates its successor and decision receipt fields', t => {
  const { dir, room } = roomSetup(t), file = path.join(dir, 'queue-dispatch.json');
  const valid = { phase: 'waiting-trust', oldNativeId: 'native-a', name: 'A', roomIds: [], provider: 'claude', cwd: '/old', newCwd: '/new', newId: 'made', trustNoticeId: projectPlan().nonce, trustWaitingAt: NOW };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: valid } }), { mode: 0o600 });
  assert.equal(rules.readRotations(file, NOW).a.phase, 'waiting-trust');
  for (const bad of [{ newId: undefined }, { trustNoticeId: 'not-a-receipt' }, { trustWaitingAt: -1 }, { trustNotified: 'yes' }, { provider: 'other' }, { newCwd: '/old' }]) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: { ...valid, ...bad } } }), { mode: 0o600 });
    assert.deepEqual(rules.readRotations(file, NOW), {}, JSON.stringify(bad));
  }
  assert.throws(() => room.rotationEvent(['shared'], 'needsTrust', 'A', 'B', {}), /Invalid rotation receipt/);
  room.rotationEvent(['shared'], 'needsTrust', 'A', 'B', valid.trustNoticeId);
  const damaged = structuredClone(room.value); damaged.events.at(-1).rotationReceipt = { invalid: true };
  fs.writeFileSync(room.file, JSON.stringify(damaged), { mode: 0o600 });
  assert.ok(new RoomState(dir).warning, 'malformed saved decision metadata is rejected on reload');
});

// Load the same persisted waiting receipt as production; no native create or model is needed.
function trustProof(session) {
  return { nativeId: session.nativeId, controlRevision: session.controlRevision, draftRevision: session.draftRevision, placementRevision: session.placementRevision };
}
const trustEffects = state => ({ v: 1, log: state, rooms: { shared: state }, os: state });
function trustTimeoutSetup(t, options = {}) {
  const { dir, room } = roomSetup(t), notifications = [];
  const old = member('a', { cwd: '/synthetic/old' });
  const fresh = member('trust-successor', { state: 'starting', cwd: '/synthetic/new', roomIds: [], roomId: null, nativeStartupPrompt: trustPrompt('claude') });
  const client = new FakeClient([old, fresh, ...(options.sessions || [])]); fakeMembership(room, client);
  const record = { phase: 'waiting-trust', oldId: old.id, oldNativeId: old.nativeId, oldControl: 0,
    requestedAt: NOW - 60000, provider: old.provider, cwd: old.cwd, name: old.name, roomIds: ['shared'],
    newId: fresh.id, newCwd: fresh.cwd, newName: 'Agent a · successor', createdNewAt: NOW, handoff: 'Synthetic saved work',
    trustWaitingAt: options.waitingAt ?? NOW, trustNoticeId: projectPlan().nonce, trustNotified: true,
    ...(options.legacy ? {} : { trustOwner: trustProof(fresh), trustEffects: trustEffects('attempted') }) };
  room.rotationEvent(record.roomIds, 'needsTrust', old.name, record.newName, record.trustNoticeId);
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  let now = NOW;
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, now: () => now,
    connect: async () => client, settleMs: 0, tickMs: 3600000, directoryTrustTimeoutMs: options.timeoutMs,
    notify: kind => notifications.push(kind) });
  dispatcher.client = client; dispatcher.idleSince.set(old.id, NOW - 60000); t.after(() => dispatcher.close());
  return { dir, room, client, old, fresh, notifications, dispatcher, record: dispatcher.rotations.a,
    async at(time) { now = time; await dispatcher.advanceRotations(client.snapshot(), now); } };
}

test('B2 timeout: a positive configured deadline waits through its last millisecond, then fails and stops only the successor once', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: '2500' }), queued = f.room.queueAdd('old work survives', f.fresh.id);
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => {
    if (method === 'stop') assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'))).rotations.a.phase, 'failed', 'persist failure before asking native to stop');
    return call(method, ...args);
  };
  await f.at(NOW + 2499);
  assert.equal(f.record.phase, 'waiting-trust'); assert.equal(f.client.calls.some(c => c[0] === 'stop'), false);
  await f.at(NOW + 2500);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'native-directory-trust-timeout');
  assert.equal(f.fresh.state, 'ended'); assert.equal(f.old.state, 'idle');
  assert.equal(f.room.queueItems('shared').find(i => i.id === queued).assignee, f.old.id);
  assert.deepEqual(f.client.calls.filter(c => c[0] === 'stop'), [['stop', f.fresh.id]]);
  assert.deepEqual(f.notifications, ['trustTimedOut']);
  assert.equal(f.room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.trustTimedOut').length, 1);
  await f.at(NOW + 10 * 60000);
  assert.deepEqual(f.notifications, ['trustTimedOut']);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
  assert.equal(f.client.calls.some(c => ['approve', 'answer', 'input'].includes(c[0])), false);
});

test('B2 timeout: omitted and invalid settings use the existing ten-minute readiness limit', async t => {
  for (const timeoutMs of [undefined, null, '', 'not-a-number', 'NaN', 'Infinity', '0', '-1', '1.5', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(timeoutMs), async t => {
      const f = trustTimeoutSetup(t, { timeoutMs });
      await f.at(NOW + 600000 - 1); assert.equal(f.record.phase, 'waiting-trust');
      await f.at(NOW + 600000); assert.equal(f.record.phase, 'failed');
      assert.equal(f.record.reason, 'native-directory-trust-timeout');
      assert.deepEqual(f.notifications, ['trustTimedOut']);
    });
  }
});

test('B2 timeout: restarting applies the current limit to the original wait, and failed cleanup is not replayed', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: '1000' });
  await f.at(NOW + 599); assert.equal(f.record.phase, 'waiting-trust'); f.dispatcher.close();
  const notices = [], room = new RoomState(f.dir); fakeMembership(room, f.client);
  const restore = (now, timeoutMs) => {
    const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: f.dir, now: () => now, settleMs: 0,
      directoryTrustTimeoutMs: timeoutMs, notify: kind => notices.push(kind) });
    dispatcher.client = f.client; t.after(() => dispatcher.close()); return dispatcher;
  };
  const resumed = restore(NOW + 600, '500');
  assert.equal(resumed.rotations.a.trustWaitingAt, NOW);
  await resumed.advanceRotations(f.client.snapshot(), NOW + 600);
  assert.equal(resumed.rotations.a.phase, 'failed', 'shorter current configuration must not start a fresh wait');
  assert.deepEqual(notices, ['trustTimedOut']); resumed.close();
  const again = restore(NOW + 1600, '2000');
  await again.advanceRotations(f.client.snapshot(), NOW + 1600);
  assert.deepEqual(notices, ['trustTimedOut']);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
  assert.equal(room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.trustTimedOut').length, 1);
});

test('B2 timeout: native readiness before expiry continues the saved successor and creates no replacement', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1000 });
  f.fresh.state = 'idle'; f.fresh.nativeStartupPrompt = null; f.dispatcher.idleSince.set(f.fresh.id, NOW - 60000);
  await f.at(NOW + 999); assert.equal(f.record.phase, 'created');
  await f.at(NOW + 999); assert.equal(f.record.phase, 'handed');
  assert.equal(f.client.sends(f.fresh.id).length, 1);
  assert.equal(f.client.calls.some(c => ['stop', 'create'].includes(c[0])), false);
  assert.deepEqual(f.notifications, []);
});

test('B2 timeout: expiry frees the original queue member and the global rotation slot', async t => {
  const other = member('b', { messages: heavyMessages(), lastActivityAt: NOW - HOUR });
  const f = trustTimeoutSetup(t, { timeoutMs: 1000, sessions: [other] }), queued = f.room.queueAdd('continue the original task', f.old.id);
  const actions = () => plan([{ id: 'shared', name: 'Team', queue: f.room.queueItems('shared') }], f.client.state.sessions,
    { now: NOW + 1000, rotations: f.dispatcher.rotations, quietMs: 0 });
  assert.equal(actions().some(a => a.kind === 'rotate'), false, 'the pending wait owns the global slot');
  await f.at(NOW + 1000);
  assert.deepEqual(f.dispatcher.activeRotations(), []);
  const ready = actions(), dispatch = ready.find(a => a.kind === 'dispatch' && a.sessionId === f.old.id), rotate = ready.find(a => a.kind === 'rotate' && a.sessionId === other.id);
  assert.ok(dispatch); assert.ok(rotate, 'another member may rotate after this wait is released');
  await f.dispatcher.dispatch(dispatch);
  assert.equal(f.room.queueItems('shared').find(i => i.id === queued).status, 'sent');
  assert.equal(f.client.sends(f.old.id).length, 1, 'the old native session receives its queued work');
  await f.dispatcher.requestHandoff(rotate);
  assert.equal(f.dispatcher.rotations[other.id].phase, 'requested');
  assert.equal(f.client.sends(other.id).length, 1);
  assert.equal(f.client.calls.some(c => c[0] === 'stop' && c[1] === f.old.id), false);
});

test('B2 timeout: a refused successor stop reports unconfirmed cleanup once and retains the original session', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }), call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => {
    if (method === 'stop') { f.client.calls.push([method, ...args]); throw Error('synthetic stop refusal'); }
    return call(method, ...args);
  };
  await f.at(NOW + 1);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'native-directory-trust-timeout-stop-unconfirmed');
  assert.equal(f.fresh.state, 'starting', 'a rejected stop is not evidence of native termination');
  assert.equal(f.old.state, 'idle'); assert.deepEqual(f.notifications, ['trustTimeoutUnconfirmed']);
  assert.equal(f.room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.trustTimeoutUnconfirmed').length, 1);
  await f.at(NOW + 2);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
  assert.deepEqual(f.notifications, ['trustTimeoutUnconfirmed']);
});

test('B2 timeout: a successor stop that never confirms reaches the existing bounded RPC timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }), call = f.client.call.bind(f.client);
  let stopReached; const stopped = new Promise(resolve => { stopReached = resolve; });
  f.client.call = (method, ...args) => {
    if (method === 'stop') { f.client.calls.push([method, ...args]); stopReached(); return new Promise(() => {}); }
    return call(method, ...args);
  };
  const expired = f.at(NOW + 1);
  assert.equal(await Promise.race([stopped.then(() => true), expired.then(() => false)]), true, 'expiry asks the successor to stop');
  t.mock.timers.tick(60000); await expired;
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'native-directory-trust-timeout-stop-unconfirmed');
  assert.equal(f.fresh.state, 'starting'); assert.equal(f.old.state, 'idle');
  assert.deepEqual(f.notifications, ['trustTimeoutUnconfirmed']);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
});

function saveTrustFixture(f) {
  fs.writeFileSync(path.join(f.dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: f.dispatcher.rotations }), { mode: 0o600 });
}
function restoreTrustFixture(t, f, time = NOW) {
  f.dispatcher.close();
  const room = new RoomState(f.dir), notifications = []; fakeMembership(room, f.client);
  let now = time;
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: f.dir, connect: async () => f.client, now: () => now,
    settleMs: 0, tickMs: 3600000, directoryTrustTimeoutMs: 1000, notify: kind => notifications.push(kind) });
  dispatcher.client = f.client; t.after(() => dispatcher.close());
  return { ...f, room, dispatcher, notifications, record: dispatcher.rotations.a,
    async at(value) { now = value; await dispatcher.advanceRotations(f.client.snapshot(), now); } };
}
function expiredTrustCleanup(f, stop = 'pending', attempts = 0) {
  Object.assign(f.record, { phase: 'failed', failedAt: NOW, reason: 'native-directory-trust-timeout',
    trustCleanup: { v: 1, id: 'bbccddee-1122-4333-8444-556677889900', proof: structuredClone(f.record.trustOwner),
      stop: { state: stop, attempts }, rooms: { shared: 'pending' }, notices: trustEffects('pending') } });
  saveTrustFixture(f);
}
function trimTrustLog(f) {
  const noise = f.dispatcher.appendLog('failed', { oldId: 'other', oldNativeId: 'native-other', name: 'Other', roomIds: ['shared'] }, { reason: 'later synthetic event' });
  fs.appendFileSync(f.dispatcher.logFile, (JSON.stringify(noise) + '\n').repeat(1001), { mode: 0o600 });
}

test('B2 receipt: clear and log retention followed by a real restart never replay an attempted trust decision', async t => {
  const f = trustTimeoutSetup(t);
  f.dispatcher.appendLog('waiting', f.record, { noticeId: f.record.trustNoticeId, reason: 'native-directory-trust' });
  trimTrustLog(f); f.room.clear(); saveTrustFixture(f);
  const resumed = restoreTrustFixture(t, f);
  assert.equal(resumed.dispatcher.rotationEntries().some(e => e.noticeId === f.record.trustNoticeId), false, 'the old log receipt is outside the retained view');
  await resumed.dispatcher.waitForDirectoryTrust(f.old.id, resumed.record, NOW + 1, f.fresh);
  assert.equal(resumed.room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.needsTrust').length, 0, 'clear is respected after restart');
  const matching = fs.readFileSync(resumed.dispatcher.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.noticeId === f.record.trustNoticeId);
  assert.equal(matching.length, 1); assert.deepEqual(resumed.notifications, []);
  assert.equal(f.client.calls.some(c => ['create', 'stop', 'approve', 'answer', 'input', 'dispatch'].includes(c[0])), false);
});

test('B2 receipt: an old log/space-written but OS-flag-not-written crash is migrated without replay after clear and trim', async t => {
  const f = trustTimeoutSetup(t, { legacy: true }); delete f.record.trustNotified;
  f.dispatcher.appendLog('waiting', f.record, { noticeId: f.record.trustNoticeId, reason: 'native-directory-trust' });
  trimTrustLog(f); f.room.clear(); saveTrustFixture(f);
  const resumed = restoreTrustFixture(t, f);
  await resumed.at(NOW + 1);
  assert.deepEqual(resumed.notifications, ['needsTrust'], 'the old source saved its flag before OS attempt; only the missing OS attempt is due');
  assert.equal(resumed.room.value.events.length, 0);
  assert.equal(fs.readFileSync(resumed.dispatcher.logFile, 'utf8').split('\n').filter(line => line.includes(f.record.trustNoticeId)).length, 1);
  const again = restoreTrustFixture(t, resumed); await again.at(NOW + 2);
  assert.deepEqual(again.notifications, []); assert.equal(again.room.value.events.length, 0);
  assert.equal(f.client.calls.some(c => ['create', 'stop', 'approve', 'answer', 'input', 'dispatch'].includes(c[0])), false);
});

for (const action of ['log', 'space', 'os']) for (const boundary of ['before', 'after']) test(`B2 receipt: ${action} ${boundary}-call interruption keeps its durable attempt and never replays it`, async t => {
  const f = trustTimeoutSetup(t); f.record.trustEffects = trustEffects('pending'); delete f.record.trustNotified;
  f.room.clear(); saveTrustFixture(f);
  let attempted = 0;
  const interrupt = run => (...args) => {
    attempted++;
    const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'))).rotations.a;
    const state = action === 'space' ? saved.trustEffects.rooms.shared : saved.trustEffects[action];
    assert.equal(state, 'attempted', 'attempt is persisted before making the side effect');
    if (boundary === 'after') run(...args);
    f.dispatcher.closed = true; throw Error('synthetic interruption at the external boundary');
  };
  if (action === 'log') f.dispatcher.appendLog = interrupt(f.dispatcher.appendLog.bind(f.dispatcher));
  else if (action === 'space') f.room.rotationEvent = interrupt(f.room.rotationEvent.bind(f.room));
  else f.dispatcher.notify = interrupt(f.dispatcher.notify);
  await f.dispatcher.waitForDirectoryTrust(f.old.id, f.record, NOW + 1, f.fresh).catch(() => {});
  assert.equal(attempted, 1, 'the selected action boundary was reached');
  const resumed = restoreTrustFixture(t, f);
  let replayed = 0;
  if (action === 'log') { const base = resumed.dispatcher.appendLog.bind(resumed.dispatcher); resumed.dispatcher.appendLog = (...args) => { replayed++; return base(...args); }; }
  else if (action === 'space') { const base = resumed.room.rotationEvent.bind(resumed.room); resumed.room.rotationEvent = (...args) => { replayed++; return base(...args); }; }
  else resumed.dispatcher.notify = () => { replayed++; };
  await resumed.dispatcher.waitForDirectoryTrust(f.old.id, resumed.record, NOW + 2, f.fresh);
  assert.equal(replayed, 0, 'an attempted action is never inferred to be unsent because a receipt is absent');
  assert.equal(f.client.calls.some(c => ['stop', 'create', 'dispatch', 'approve', 'answer', 'input'].includes(c[0])), false);
});

test('B2 receipt: an effects-save failure prevents the subsequent external actions', async t => {
  const f = trustTimeoutSetup(t); f.record.trustEffects = trustEffects('pending'); delete f.record.trustNotified; saveTrustFixture(f);
  let effects = 0;
  f.dispatcher.appendLog = () => { effects++; }; f.room.rotationEvent = () => { effects++; }; f.dispatcher.notify = () => { effects++; };
  f.dispatcher.save = () => { throw Error('synthetic write failure'); };
  await assert.rejects(f.dispatcher.waitForDirectoryTrust(f.old.id, f.record, NOW + 1, f.fresh), /write failure/);
  assert.equal(effects, 0); assert.equal(f.client.calls.length, 0);
});

test('B2 receipt: failed cleanup intent is saved before stop and a restart completes the known-pending cleanup once', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }); f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared';
  const save = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => {
    save();
    if (f.record.phase === 'failed') {
      assert.equal(f.record.trustCleanup?.stop.state, 'pending', 'the same failed write retains cleanup intent');
      f.dispatcher.closed = true; throw Error('synthetic crash after failed intent save');
    }
  };
  await f.at(NOW + 1);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 0);
  const resumed = restoreTrustFixture(t, f, NOW + 2), order = [], call = f.client.call.bind(f.client), membership = resumed.room.membership.bind(resumed.room);
  f.client.call = async (method, ...args) => { if (method === 'stopUnusedSuccessor') order.push('stop'); return call(method, ...args); };
  resumed.room.membership = async (...args) => {
    const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'))).rotations.a;
    assert.equal(saved.trustCleanup.rooms.shared, 'started', 'leave attempt is saved before changing membership');
    order.push('leave'); return membership(...args);
  };
  await resumed.at(NOW + 2);
  assert.deepEqual(order, ['stop', 'leave']);
  assert.equal(resumed.record.trustCleanup.stop.state, 'confirmed');
  assert.equal(resumed.record.trustCleanup.rooms.shared, 'confirmed');
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1); assert.equal(f.old.state, 'idle');
  const again = restoreTrustFixture(t, resumed, NOW + 3); await again.at(NOW + 3);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1); assert.deepEqual(again.notifications, []);
});

for (const inactive of ['ended', 'disconnected']) test(`B2 receipt: a started stop observes ${inactive} and does not stop again`, async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'started', 1); f.fresh.state = inactive;
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1);
  assert.equal(resumed.record.trustCleanup.stop.state, 'confirmed');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
});

test('B2 receipt: a started stop with unchanged unused ownership may retry once through the guarded capability', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'started', 1);
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1);
  assert.equal(resumed.record.trustCleanup.stop.state, 'confirmed'); assert.equal(resumed.record.trustCleanup.stop.attempts, 2);
  assert.deepEqual(f.client.calls.find(c => c[0] === 'stopUnusedSuccessor'), ['stopUnusedSuccessor', f.fresh.id, trustProof(f.fresh)]);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
});

for (const changed of ['nativeId', 'controlRevision', 'draftRevision', 'placementRevision', 'draft', 'working', 'pending', 'goal']) test(`B2 receipt: a ${changed} change blocks an interrupted cleanup from stopping the successor`, async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'started', 1);
  if (changed === 'nativeId') f.fresh.nativeId = 'a-different-native-thread';
  else if (changed.endsWith('Revision')) f.fresh[changed]++;
  else if (changed === 'draft') f.fresh.liveDraft = 'a new unsent person draft';
  else if (changed === 'working') f.fresh.state = 'working';
  else if (changed === 'pending') f.fresh.pendingTag = 'a-new-person-turn';
  else f.fresh.nativeGoal = { status: 'active' };
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1);
  assert.equal(resumed.record.trustCleanup.stop.state, 'unknown');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'input', 'approve', 'answer'].includes(c[0])), false);
});

test('B2 receipt: missing guarded capability never falls back to unguarded stop', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f); f.client.capabilities = [rules.CAPABILITY];
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1);
  assert.equal(resumed.record.trustCleanup.stop.state, 'unknown');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
});

test('B2 receipt: an interrupted leave is observed and never blindly repeated while membership remains', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'confirmed', 1); f.record.trustCleanup.rooms.shared = 'started';
  f.fresh.state = 'ended'; f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared'; saveTrustFixture(f);
  const resumed = restoreTrustFixture(t, f); let leaves = 0; resumed.room.membership = async () => { leaves++; };
  await resumed.at(NOW + 1); assert.equal(leaves, 0); assert.equal(resumed.record.trustCleanup.rooms.shared, 'unknown');
  f.fresh.roomIds = []; f.fresh.roomId = null; await resumed.at(NOW + 2);
  assert.equal(resumed.record.trustCleanup.rooms.shared, 'confirmed'); assert.equal(leaves, 0);
});

test('B2 receipt: ready without a visible prompt wins over an elapsed trust deadline', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }); f.fresh.state = 'idle'; f.fresh.nativeStartupPrompt = null; f.dispatcher.idleSince.set(f.fresh.id, NOW - 60000);
  await f.at(NOW + 2); assert.equal(f.record.phase, 'created');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
  assert.deepEqual(f.notifications, []);
});

test('B2 receipt: a new visible prompt after readiness starts a fresh cycle, clock and notice', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1000 }), earlier = f.record.trustNoticeId;
  f.fresh.state = 'idle'; f.fresh.nativeStartupPrompt = null; f.dispatcher.idleSince.set(f.fresh.id, NOW - 60000);
  await f.at(NOW + 500); assert.equal(f.record.phase, 'created');
  f.fresh.state = 'starting'; f.fresh.nativeStartupPrompt = trustPrompt('claude');
  await f.at(NOW + 900);
  assert.equal(f.record.phase, 'waiting-trust'); assert.notEqual(f.record.trustNoticeId, earlier); assert.equal(f.record.trustWaitingAt, NOW + 900);
  assert.deepEqual(f.record.trustOwner, trustProof(f.fresh)); assert.deepEqual(f.notifications, ['needsTrust']);
  assert.equal(f.room.value.events.filter(e => e.uiMessage?.key === 'notice.rotation.needsTrust').length, 2);
  await f.at(NOW + 1001); assert.equal(f.record.phase, 'waiting-trust', 'the original cycle deadline cannot expire a new prompt');
});

for (const failed of ['stop', 'leave']) test(`B2 receipt: ${failed} failure keeps only the successor quarantined after trust is accepted and beyond seven days`, async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }); f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared';
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => {
    if (method === 'stop' && failed === 'stop') { f.client.calls.push([method, ...args]); throw Error('synthetic stop refusal'); }
    return call(method, ...args);
  };
  if (failed === 'leave') f.room.membership = async () => { throw Error('synthetic leave failure'); };
  await f.at(NOW + 1); assert.equal(f.record.phase, 'failed');
  f.fresh.state = 'idle'; f.fresh.nativeStartupPrompt = null; f.fresh.controlRevision++;
  const next = f.room.queueAdd('must not reach the quarantined successor', f.fresh.id), oldNext = f.room.queueAdd('old member continues', f.old.id);
  f.dispatcher.pruneRotations(NOW + 8 * 24 * HOUR);
  assert.ok(f.dispatcher.rotations.a?.trustCleanup, 'unfinished cleanup is not lost to failed-record pruning');
  const resumed = restoreTrustFixture(t, f, NOW + 8 * 24 * HOUR); await resumed.at(NOW + 8 * 24 * HOUR);
  const actions = plan([{ id: 'shared', name: 'Team', queue: resumed.room.queueItems('shared') }], f.client.state.sessions,
    { rotations: resumed.dispatcher.rotations, now: NOW + 8 * 24 * HOUR });
  assert.equal(actions.some(a => a.kind === 'dispatch' && a.sessionId === f.fresh.id), false);
  assert.ok(actions.some(a => a.kind === 'dispatch' && a.itemId === next && a.sessionId === f.old.id), 'the earlier reassigned task reaches the old member first');
  assert.equal(resumed.room.queueItems('shared').find(i => i.id === oldNext).assignee, f.old.id, 'later queued work remains owned by the original member');
  assert.deepEqual(resumed.dispatcher.activeRotations(), [], 'cleanup does not occupy the global rotation slot');
  await resumed.dispatcher.dispatch({ kind: 'dispatch', roomId: 'shared', itemId: next, sessionId: f.fresh.id });
  assert.equal(f.client.sends(f.fresh.id).length, 0, 'a stale pre-cleanup action cannot bypass quarantine');
});

test('B2 receipt: legacy failed cleanup is unknown and never manufactures another stop or notice', async t => {
  const f = trustTimeoutSetup(t, { legacy: true }); Object.assign(f.record, { phase: 'failed', failedAt: NOW, reason: 'native-directory-trust-timeout' }); saveTrustFixture(f);
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'dispatch', 'input', 'approve', 'answer'].includes(c[0])), false);
  assert.deepEqual(resumed.notifications, []);
});

test('B2 receipt: malformed new receipt fields do not throw away an unrelated valid rotation', t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f);
  const valid = structuredClone(f.record), file = path.join(f.dir, 'queue-dispatch.json');
  const unrelated = { phase: 'kept', oldNativeId: 'native-unrelated', name: 'Unrelated', roomIds: ['shared'], keptAt: NOW };
  const damaged = [
    r => { r.trustNoticeId = 'damaged'; }, r => { r.newId = r.oldId; }, r => { r.roomIds = null; }, r => { r.newCwd = 'relative'; },
    r => { r.trustOwner.controlRevision = -1; }, r => { delete r.trustOwner.draftRevision; }, r => { r.trustOwner.nativeId = null; },
    r => { r.trustEffects.v = 2; }, r => { r.trustEffects.log = 'delivered'; }, r => { r.trustEffects.rooms.shared = 'done'; },
    r => { r.trustEffects.os = true; }, r => { r.trustCleanup.id = 'not-a-receipt'; }, r => { r.trustCleanup.proof = {}; },
    r => { r.trustCleanup.stop.state = 'delivered'; }, r => { r.trustCleanup.stop.attempts = 3; }, r => { r.trustCleanup.rooms.shared = 'attempted'; },
    r => { r.trustCleanup.notices.os = 'delivered'; },
  ];
  for (const mutate of damaged) {
    const record = structuredClone(valid); mutate(record);
    fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: record, unrelated } }), { mode: 0o600 });
    let rotations;
    assert.doesNotThrow(() => { rotations = rules.readRotations(file, NOW); });
    assert.deepEqual(rotations.unrelated, unrelated, 'one bad trust record does not hide another rotation');
  }
});

// Enter through the product's wait/save path before corrupting its primary file.
// No test knows how the independent successor quarantine is stored.
async function trustFaultSetup(t) {
  const healthy = member('healthy-worker');
  const f = trustTimeoutSetup(t, { sessions: [healthy] });
  const otherRoom = f.room.create('Unaffected team');
  healthy.roomIds = [otherRoom]; healthy.roomId = null;
  f.client.state.rooms.push({ id: otherRoom, revision: 0, run: null, messages: [] });
  f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared';
  f.record.phase = 'joining';
  await f.dispatcher.waitForDirectoryTrust(f.old.id, f.record, NOW, f.fresh);
  const unrelated = { phase: 'kept', oldNativeId: healthy.nativeId, name: healthy.name, roomIds: [otherRoom], keptAt: NOW };
  f.dispatcher.rotations.unrelated = unrelated; f.dispatcher.save();
  const heldItem = f.room.queueAdd('must stay with the quarantined successor', f.fresh.id);
  const healthyItem = f.room.queueAdd('unrelated space continues', healthy.id, otherRoom);
  f.fresh.state = 'idle'; f.fresh.nativeStartupPrompt = null;
  return { ...f, healthy, otherRoom, unrelated, heldItem, healthyItem };
}

async function assertFaultDoesNotStopOtherSpace(t, f) {
  const restored = restoreTrustFixture(t, f);
  await restored.dispatcher.start();
  assert.equal(f.client.sends(f.healthy.id).length, 1, 'a different space really receives its queued task');
  assert.equal(restored.room.queueItems(f.otherRoom).find(i => i.id === f.healthyItem).status, 'sent');
  assert.equal(f.client.sends(f.fresh.id).length, 0, 'the unhanded successor remains quarantined');
  assert.equal(restored.room.queueItems('shared').find(i => i.id === f.heldItem).status, 'queued');
  await restored.dispatcher.dispatch({ kind: 'dispatch', roomId: 'shared', itemId: f.heldItem, sessionId: f.fresh.id });
  assert.equal(f.client.sends(f.fresh.id).length, 0, 'a stale direct dispatch cannot bypass restored quarantine');
  await assert.rejects(restored.dispatcher.send(f.fresh, 'synthetic integration handoff', 'integration-handoff'), error => error.notSent === true);
  assert.equal(f.client.sends(f.fresh.id).length, 0, 'the shared send boundary also fences non-queue automatic senders');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'approve', 'answer', 'input'].includes(c[0])), false,
    'unreadable bookkeeping grants no native cleanup or input authority');
  assert.ok(restored.notifications.length > 0, 'the person is told about the quarantined record');
  const notices = restored.notifications.length;
  restored.dispatcher.dirty = true; await restored.dispatcher.schedule();
  assert.equal(restored.notifications.length, notices, 'the same unresolved fault does not notify on each pass');
  const again = restoreTrustFixture(t, restored);
  await again.dispatcher.start();
  assert.equal(f.client.sends(f.fresh.id).length, 0, 'quarantine also survives a second restart');
  assert.equal(again.notifications.length, 0, 'restarting does not repeat the same fault notice');
  return again;
}

for (const [name, damage] of [
  ['owner revision', r => { r.trustOwner.controlRevision = -1; }],
  ['notice effects', r => { r.trustEffects.os = 'delivered'; }],
  ['cleanup state', r => { r.phase = 'failed'; r.failedAt = NOW; r.reason = 'native-directory-trust-timeout'; r.trustCleanup = { v: 2 }; }],
  ['missing successor id', r => { delete r.newId; }],
  ['repointed successor id', r => { r.newId = 'healthy-worker'; }],
  ['unknown phase', r => { r.phase = 'damaged-phase'; }],
]) test(`B2 fault isolation: a malformed ${name} holds only its original successor and keeps a valid record`, async t => {
  const f = await trustFaultSetup(t);
  const stored = JSON.parse(fs.readFileSync(f.dispatcher.file, 'utf8')); damage(stored.rotations.a);
  fs.writeFileSync(f.dispatcher.file, JSON.stringify(stored), { mode: 0o600 });
  const restored = await assertFaultDoesNotStopOtherSpace(t, f);
  assert.deepEqual(restored.dispatcher.rotations.unrelated, f.unrelated);
});

for (const [name, damage] of [
  ['truncated JSON', file => fs.writeFileSync(file, '{"version":1,"rotations":', { mode: 0o600 })],
  ['invalid top-level shape', file => fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: [] }), { mode: 0o600 })],
  ['missing primary file', file => fs.unlinkSync(file)],
  ['unsafe primary permissions', file => fs.chmodSync(file, 0o644)],
  ['a primary symlink', file => { const target = file + '.owned-target'; fs.renameSync(file, target); fs.symlinkSync(target, file); }],
]) test(`B2 fault isolation: ${name} cannot make a previously quarantined successor eligible`, async t => {
  const f = await trustFaultSetup(t); damage(f.dispatcher.file);
  await assertFaultDoesNotStopOtherSpace(t, f);
});

test('B2 fault isolation: one persistently throwing cleanup does not block an ordinary joining rotation or another space', async t => {
  const f = await trustFaultSetup(t); expiredTrustCleanup(f);
  const old = member('ordinary-old', { cwd: '/synthetic/ordinary', roomIds: [f.otherRoom], roomId: null });
  const successor = member('ordinary-successor', { cwd: old.cwd, roomIds: [], roomId: null });
  f.client.state.sessions.push(old, successor);
  const ordinary = { phase: 'joining', oldId: old.id, oldNativeId: old.nativeId, oldControl: 0, provider: 'claude', cwd: old.cwd,
    newCwd: old.cwd, newId: successor.id, newName: successor.name, name: old.name, roomIds: [f.otherRoom], createdNewAt: NOW,
    requestedAt: NOW - 1000, handoff: 'saved ordinary handoff' };
  f.dispatcher.rotations[old.id] = ordinary;
  const resume = f.dispatcher.resumeTrustCleanup.bind(f.dispatcher); let errors = 0;
  f.dispatcher.resumeTrustCleanup = async (id, ...args) => {
    if (id === f.old.id) { errors++; throw Error('Synthetic persistent cleanup fault'); }
    return resume(id, ...args);
  };
  await f.dispatcher.start();
  assert.ok(errors > 0); assert.equal(ordinary.phase, 'created', 'ordinary same-directory joining is still advanced');
  assert.deepEqual(successor.roomIds, [f.otherRoom]);
  assert.equal(f.client.sends(f.healthy.id).length, 1); assert.equal(f.client.sends(f.fresh.id).length, 0);
  successor.state = 'starting';
  const next = member('another-worker', { roomIds: [f.otherRoom], roomId: null }); f.client.state.sessions.push(next);
  f.room.queueAdd('a later pass still dispatches', next.id, f.otherRoom);
  f.dispatcher.dirty = true; await f.dispatcher.schedule();
  assert.equal(f.client.sends(next.id).length, 1, 'a later pass is not starved by the same cleanup fault');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'input', 'approve', 'answer'].includes(c[0]) && c[1] === f.fresh.id), false);
});

test('B2 fault isolation: a real cleanup save failure leaves other-space queue dispatch working', async t => {
  const f = await trustFaultSetup(t); expiredTrustCleanup(f, 'confirmed', 1); f.fresh.state = 'ended';
  f.dispatcher.save = () => { throw Error('Synthetic rotation-store write failure'); };
  await f.dispatcher.start();
  assert.equal(f.client.sends(f.healthy.id).length, 1, 'RoomState can still persist and deliver the unrelated task');
  f.fresh.state = 'idle';
  await f.dispatcher.dispatch({ kind: 'dispatch', roomId: 'shared', itemId: f.heldItem, sessionId: f.fresh.id });
  assert.equal(f.client.sends(f.fresh.id).length, 0);
  assert.deepEqual(f.fresh.roomIds, ['shared'], 'membership is untouched when its started marker cannot be saved');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'input', 'approve', 'answer'].includes(c[0])), false);
});

async function assertUnknownIdentityIsHeld(t, f, recoversFromPrimary = false) {
  const restored = restoreTrustFixture(t, f);
  await restored.dispatcher.start();
  assert.equal(f.client.sends().length, 0, 'no unproven identity is treated as safe after losing the anchor');
  assert.equal(restored.room.queueItems('shared').find(i => i.id === f.heldItem).status, 'queued');
  await restored.dispatcher.dispatch({ kind: 'dispatch', roomId: 'shared', itemId: f.heldItem, sessionId: f.fresh.id });
  assert.equal(f.client.sends(f.fresh.id).length, 0);
  assert.equal(restored.notifications.filter(kind => kind === 'trustStateUnknown').length, 1);
  restored.dispatcher.dirty = true; await restored.dispatcher.schedule();
  assert.equal(restored.notifications.filter(kind => kind === 'trustStateUnknown').length, 1, 'the unknown identity notice is not repeated each pass');
  const again = restoreTrustFixture(t, restored); await again.dispatcher.start();
  assert.equal(again.notifications.length, 0, 'the unknown identity notice is not repeated after restart');
  if (recoversFromPrimary) {
    assert.equal(f.client.sends(f.healthy.id).length, 1, 'a valid primary reconstructs identities on restart and frees the unrelated worker');
    assert.equal(f.client.sends(f.fresh.id).length, 0, 'the reconstructed successor stays held');
  }
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'input', 'approve', 'answer'].includes(c[0])), false);
}

for (const [field, damaged] of [['holds', 'damaged'], ['faults', { damaged: 'invalid receipt' }], ['notices', { 'fault:@unknown': false }]]) test(`B2 fault isolation boundary: malformed auxiliary ${field} holds unproven sessions and reports one unknown notice`, async t => {
  const f = await trustFaultSetup(t);
  f.room.saveDirectoryTrustIsolation({ ...f.room.directoryTrustIsolation(), [field]: damaged });
  await assertUnknownIdentityIsHeld(t, f, true);
});

test('B2 fault isolation boundary: a rejected primary record without an independent anchor cannot authorize its successor hint', async t => {
  const f = await trustFaultSetup(t);
  const metadata = JSON.parse(fs.readFileSync(f.room.file, 'utf8')); delete metadata.directoryTrustIsolation;
  fs.writeFileSync(f.room.file, JSON.stringify(metadata), { mode: 0o600 });
  const primary = JSON.parse(fs.readFileSync(f.dispatcher.file, 'utf8')); primary.rotations.a.trustOwner.controlRevision = -1;
  fs.writeFileSync(f.dispatcher.file, JSON.stringify(primary), { mode: 0o600 });
  await assertUnknownIdentityIsHeld(t, f);
});

test('B2 fault isolation boundary: a saved completed cleanup recovers its matching hold release after a crash', async t => {
  const f = await trustFaultSetup(t); expiredTrustCleanup(f, 'confirmed', 1);
  f.record.trustCleanup.rooms.shared = 'confirmed'; f.record.trustCleanup.notices = trustEffects('attempted'); saveTrustFixture(f);
  assert.ok(f.room.directoryTrustIsolation().holds[f.fresh.id], 'the independent hold still predates its release');
  const restored = restoreTrustFixture(t, f);
  await restored.dispatcher.start();
  assert.equal(f.client.sends(f.fresh.id).length, 1, 'the completed matching receipt does not create a permanent silent hold');
  assert.equal(f.client.sends(f.healthy.id).length, 1);
  assert.deepEqual(restored.notifications, []);
  assert.equal(Object.hasOwn(new RoomState(f.dir).directoryTrustIsolation().holds, f.fresh.id), false, 'the recovered release is persisted');
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'input', 'approve', 'answer'].includes(c[0])), false);
});

test('B2 fault isolation boundary: a valid confirmed handoff receipt recovers its matching hold release after a crash', async t => {
  const f = await trustFaultSetup(t);
  Object.assign(f.record, { phase: 'handed', handoffConfirmed: true, handoffTag: 'accepted-handoff-tag', handedAt: NOW }); saveTrustFixture(f);
  assert.ok(f.room.directoryTrustIsolation().holds[f.fresh.id]);
  const restored = restoreTrustFixture(t, f);
  // Test restoration without advancing the ordinary handed phase or stopping its old session.
  await restored.dispatcher.dispatch({ kind: 'dispatch', roomId: 'shared', itemId: f.heldItem, sessionId: f.fresh.id });
  assert.equal(f.client.sends(f.fresh.id).length, 1);
  assert.equal(Object.hasOwn(new RoomState(f.dir).directoryTrustIsolation().holds, f.fresh.id), false);
  assert.deepEqual(restored.notifications, []);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'input', 'approve', 'answer'].includes(c[0])), false);
});

test('B2 fault isolation boundary: an auxiliary save failure during cleanup does not poison an ordinary joining save', async t => {
  const f = await trustFaultSetup(t); expiredTrustCleanup(f);
  const old = member('ordinary-old', { cwd: '/synthetic/ordinary', roomIds: [f.otherRoom], roomId: null });
  const successor = member('ordinary-successor', { cwd: old.cwd, roomIds: [], roomId: null }); f.client.state.sessions.push(old, successor);
  const ordinary = { phase: 'joining', oldId: old.id, oldNativeId: old.nativeId, oldControl: 0, provider: 'claude', cwd: old.cwd,
    newCwd: old.cwd, newId: successor.id, newName: successor.name, name: old.name, roomIds: [f.otherRoom], createdNewAt: NOW,
    requestedAt: NOW - 1000, handoff: 'saved ordinary handoff' };
  f.dispatcher.rotations[old.id] = ordinary;
  const save = f.dispatcher.save.bind(f.dispatcher), resume = f.dispatcher.resumeTrustCleanup.bind(f.dispatcher); let insideCleanup = false;
  f.dispatcher.resumeTrustCleanup = async (...args) => { insideCleanup = true; try { return await resume(...args); } finally { insideCleanup = false; } };
  f.dispatcher.save = () => { if (insideCleanup) throw Error('Synthetic cleanup marker save failure'); return save(); };
  f.room.saveDirectoryTrustIsolation = () => { throw Error('Synthetic persistent auxiliary save failure'); };
  await f.dispatcher.start();
  assert.equal(ordinary.phase, 'created', 'the already-persisted hold does not prevent an unrelated same-directory save');
  assert.deepEqual(successor.roomIds, [f.otherRoom]);
  assert.equal(f.client.sends(f.healthy.id).length, 1); assert.equal(f.client.sends(f.fresh.id).length, 0);
  assert.equal(f.record.trustCleanup.stop.state, 'pending'); assert.equal(f.record.trustCleanup.stop.attempts, 0);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'create', 'input', 'approve', 'answer'].includes(c[0])), false,
    'no cleanup native mutation precedes its failed started-marker save');
});

for (const contents of ['{"version":', '{"version":2,"rotations":{}}']) test(`B2 fault recovery: ordinary queue dispatch survives an unreadable primary without any saved trust identity (${contents})`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-no-trust-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), client = new FakeClient([member('ordinary-worker')]);
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), contents, { mode: 0o600 });
  room.queueAdd('ordinary work without migration', 'ordinary-worker');
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
  t.after(() => dispatcher.close()); await dispatcher.start();
  assert.equal(client.sends('ordinary-worker').length, 1);
  assert.equal(room.directoryTrustIsolation(), undefined, 'the default path does not latch a new trust hold');
});

test('B2 fault recovery: the held successor accepts only its matching created-stage rotation handoff', async t => {
  const f = await trustFaultSetup(t); f.record.phase = 'created'; f.dispatcher.save();
  assert.ok(f.room.directoryTrustIsolation().holds[f.fresh.id]);
  await assert.rejects(f.dispatcher.send(f.fresh, 'ordinary automatic work', 'integration-handoff'), error => error.notSent === true);
  assert.equal(f.client.sends(f.fresh.id).length, 0);
  await f.dispatcher.send(f.fresh, 'the saved rotation handoff', `rotation-handoff:${f.old.id}`);
  assert.equal(f.client.sends(f.fresh.id).length, 1, 'quarantine permits the specific handoff needed to complete this rotation');
});

test('B2 fault recovery: restoring a valid primary re-evaluates unknown identities but keeps its successor held', async t => {
  const f = await trustFaultSetup(t), primary = fs.readFileSync(f.dispatcher.file, 'utf8');
  const metadata = JSON.parse(fs.readFileSync(f.room.file, 'utf8')); delete metadata.directoryTrustIsolation;
  fs.writeFileSync(f.room.file, JSON.stringify(metadata), { mode: 0o600 });
  const bad = JSON.parse(primary); bad.rotations.a.trustOwner.controlRevision = -1;
  fs.writeFileSync(f.dispatcher.file, JSON.stringify(bad), { mode: 0o600 });
  const held = restoreTrustFixture(t, f); await held.dispatcher.start();
  assert.equal(f.client.sends().length, 0); assert.equal(held.notifications.filter(n => n === 'trustStateUnknown').length, 1);
  await held.dispatcher.close();
  fs.writeFileSync(f.dispatcher.file, JSON.stringify({ version: 1, rotations: {} }), { mode: 0o600 });
  const empty = restoreTrustFixture(t, f); await empty.dispatcher.start();
  assert.equal(f.client.sends().length, 0, 'an empty rewritten primary cannot prove lost identities');
  await empty.dispatcher.close();
  fs.writeFileSync(f.dispatcher.file, primary, { mode: 0o600 });
  const recovered = restoreTrustFixture(t, f); await recovered.dispatcher.start();
  assert.equal(f.client.sends(f.healthy.id).length, 1, 'unrelated work resumes from restored identity evidence');
  assert.equal(f.client.sends(f.fresh.id).length, 0, 'recovery does not authorize the unhanded successor');
  assert.equal(recovered.room.directoryTrustIsolation().unknown, false);
  assert.equal(recovered.notifications.filter(n => n === 'trustStateUnknown').length, 0);
});

for (const action of ['log', 'space', 'os']) for (const boundary of ['before', 'after']) test(`B2 receipt: timeout ${action} ${boundary}-call interruption never replays that cleanup notice`, async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'confirmed', 1);
  f.record.trustCleanup.rooms.shared = 'confirmed'; f.fresh.state = 'ended'; saveTrustFixture(f);
  let attempted = 0;
  const interrupt = run => (...args) => {
    attempted++;
    const notices = JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'))).rotations.a.trustCleanup.notices;
    assert.equal(action === 'space' ? notices.rooms.shared : notices[action], 'attempted');
    if (boundary === 'after') run(...args);
    f.dispatcher.closed = true; throw Error('synthetic interruption at timeout notice boundary');
  };
  if (action === 'log') f.dispatcher.appendLog = interrupt(f.dispatcher.appendLog.bind(f.dispatcher));
  else if (action === 'space') f.room.rotationEvent = interrupt(f.room.rotationEvent.bind(f.room));
  else f.dispatcher.notify = interrupt(f.dispatcher.notify);
  await f.at(NOW + 1).catch(() => {}); assert.equal(attempted, 1);
  const resumed = restoreTrustFixture(t, f); let replayed = 0;
  if (action === 'log') { const base = resumed.dispatcher.appendLog.bind(resumed.dispatcher); resumed.dispatcher.appendLog = (...args) => { replayed++; return base(...args); }; }
  else if (action === 'space') { const base = resumed.room.rotationEvent.bind(resumed.room); resumed.room.rotationEvent = (...args) => { replayed++; return base(...args); }; }
  else resumed.dispatcher.notify = () => { replayed++; };
  await resumed.at(NOW + 2);
  assert.equal(replayed, 0); assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor', 'input', 'approve', 'answer', 'create'].includes(c[0])), false);
});

test('B2 receipt: two started guarded stop attempts are the hard limit, even with unchanged ownership', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'started', 2);
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1); await resumed.at(NOW + 2);
  assert.equal(resumed.record.trustCleanup.stop.state, 'unknown'); assert.equal(resumed.record.trustCleanup.stop.attempts, 2);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
});

test('B2 receipt: an uninitialized Codex successor keeps an explicit null native identity in its guarded proof', async t => {
  const f = trustTimeoutSetup(t); f.old.provider = f.fresh.provider = f.record.provider = 'codex'; f.fresh.nativeId = null;
  f.record.trustOwner = trustProof(f.fresh); expiredTrustCleanup(f);
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 1);
  assert.equal(resumed.record.trustCleanup.stop.state, 'confirmed');
  assert.deepEqual(f.client.calls.find(c => c[0] === 'stopUnusedSuccessor'), ['stopUnusedSuccessor', f.fresh.id, { nativeId: null, controlRevision: 0, draftRevision: 0, placementRevision: 0 }]);
});

test('B2 receipt boundary: a crash after the started-stop save recovers with exactly one guarded retry', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f);
  const save = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => {
    save();
    if (f.record.trustCleanup.stop.state === 'started') { f.dispatcher.closed = true; throw Error('synthetic crash after started-stop save'); }
  };
  await f.at(NOW + 1);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 2);
  assert.equal(resumed.record.trustCleanup.stop.state, 'confirmed'); assert.equal(resumed.record.trustCleanup.stop.attempts, 2);
  assert.equal(f.client.calls.filter(c => c[0] === 'stopUnusedSuccessor').length, 1);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
});

test('B2 receipt boundary: a stop applied before its confirmation save is observed after restart and is never repeated', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f); const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => {
    const value = await call(method, ...args);
    if (method === 'stopUnusedSuccessor') f.dispatcher.closed = true;
    return value;
  };
  await f.at(NOW + 1);
  assert.equal(f.fresh.state, 'ended');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'))).rotations.a.trustCleanup.stop.state, 'started');
  const resumed = restoreTrustFixture(t, f); await resumed.at(NOW + 2);
  assert.equal(resumed.record.trustCleanup.stop.state, 'confirmed');
  assert.equal(f.client.calls.filter(c => c[0] === 'stopUnusedSuccessor').length, 1);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1);
});

test('B2 receipt boundary: an unsuccessful started-stop write cannot launch the native mutation', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f); const save = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => { if (f.record.trustCleanup.stop.state === 'started') throw Error('synthetic stop-state write failure'); return save(); };
  await assert.doesNotReject(f.at(NOW + 1), 'one cleanup write failure is isolated from the dispatcher pass');
  assert.equal(f.record.trustCleanup.stop.state, 'pending'); assert.equal(f.record.trustCleanup.stop.attempts, 0);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
});

test('B2 receipt boundary: a crash after the started-leave save does not blindly repeat membership removal', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'confirmed', 1); f.fresh.state = 'ended'; f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared'; saveTrustFixture(f);
  let leaves = 0; f.room.membership = async () => { leaves++; };
  const save = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => {
    save();
    if (f.record.trustCleanup.rooms.shared === 'started') { f.dispatcher.closed = true; throw Error('synthetic crash after started-leave save'); }
  };
  await f.at(NOW + 1); assert.equal(leaves, 0);
  const resumed = restoreTrustFixture(t, f); resumed.room.membership = async () => { leaves++; };
  await resumed.at(NOW + 2);
  assert.equal(resumed.record.trustCleanup.rooms.shared, 'unknown'); assert.equal(leaves, 0);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
});

test('B2 receipt boundary: a leave applied before its confirmation save is observed after restart without another leave', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'confirmed', 1); f.fresh.state = 'ended'; f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared'; saveTrustFixture(f);
  let leaves = 0; const membership = f.room.membership.bind(f.room);
  f.room.membership = async (...args) => { leaves++; await membership(...args); f.dispatcher.closed = true; throw Error('synthetic reply lost after leave'); };
  await f.at(NOW + 1);
  assert.deepEqual(f.fresh.roomIds, []); assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'))).rotations.a.trustCleanup.rooms.shared, 'started');
  const resumed = restoreTrustFixture(t, f); resumed.room.membership = async () => { leaves++; };
  await resumed.at(NOW + 2);
  assert.equal(resumed.record.trustCleanup.rooms.shared, 'confirmed'); assert.equal(leaves, 1);
  assert.equal(f.client.calls.some(c => ['stop', 'stopUnusedSuccessor'].includes(c[0])), false);
});

test('B2 receipt boundary: a failed leave-state save leaves native membership untouched and pending', async t => {
  const f = trustTimeoutSetup(t); expiredTrustCleanup(f, 'confirmed', 1); f.fresh.state = 'ended'; f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared'; saveTrustFixture(f);
  let leaves = 0; f.room.membership = async () => { leaves++; }; const save = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => { if (f.record.trustCleanup.rooms.shared === 'started') throw Error('synthetic leave-state write failure'); return save(); };
  await assert.doesNotReject(f.at(NOW + 1), 'one cleanup write failure is isolated from the dispatcher pass');
  assert.equal(f.record.trustCleanup.rooms.shared, 'pending'); assert.equal(leaves, 0); assert.deepEqual(f.fresh.roomIds, ['shared']);
});

const unrelatedRun = () => ({ id: 'other-members-run', status: 'running', ids: ['peer-x', 'peer-y'], awaiting: { sessionId: 'peer-y' }, steps: 3 });
test('B2 receipt isolation: cleanup preserves a running exchange between unrelated members in the same space', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }); f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared';
  f.client.state.rooms[0].run = unrelatedRun(); const before = structuredClone(f.client.state.rooms[0]);
  let leaves = 0; const membership = f.room.membership.bind(f.room);
  f.room.membership = async (...args) => { leaves++; f.client.state.rooms[0].run.status = 'paused'; return membership(...args); };
  await f.at(NOW + 1);
  assert.equal(f.record.trustCleanup.stop.state, 'confirmed'); assert.equal(f.record.trustCleanup.rooms.shared, 'pending');
  assert.equal(leaves, 0); assert.deepEqual(f.client.state.rooms[0], before);
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1); assert.equal(f.client.calls.find(c => c[0] === 'stop')[1], f.fresh.id);
  f.client.state.rooms[0].run.status = 'completed';
  await f.at(NOW + 2);
  assert.equal(leaves, 1); assert.equal(f.record.trustCleanup.rooms.shared, 'confirmed');
  assert.equal(f.client.calls.filter(c => c[0] === 'stop').length, 1, 'finishing the space run cannot re-stop the successor');
});

test('B2 receipt isolation: a new unrelated exchange that starts during the stop RPC is preserved after refresh', async t => {
  const f = trustTimeoutSetup(t, { timeoutMs: 1 }); f.fresh.roomIds = ['shared']; f.fresh.roomId = 'shared'; const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => { const result = await call(method, ...args); if (method === 'stopUnusedSuccessor') f.client.state.rooms[0].run = unrelatedRun(); return result; };
  let leaves = 0; f.room.membership = async () => { leaves++; f.client.state.rooms[0].run.status = 'paused'; };
  await f.at(NOW + 1);
  assert.equal(leaves, 0, 'the room run is checked after the asynchronous stop, before membership can pause it');
  assert.deepEqual(f.client.state.rooms[0].run, unrelatedRun());
  assert.equal(f.record.trustCleanup.rooms.shared, 'pending'); assert.equal(f.old.state, 'idle');
});

function sharedWarningSetup(t, damage, primary) {
  const { dir, room } = roomSetup(t);
  room.rename('Shared metadata before damage');
  const otherRoom = room.create('Independent healthy space');
  const worker = member('warning-worker', { cwd: '/synthetic/project', roomIds: [otherRoom], roomId: null });
  const old = member('warning-old', { cwd: '/synthetic/project', roomIds: [otherRoom], roomId: null,
    createdAt: NOW - 30 * HOUR, lastActivityAt: NOW - HOUR, messages: heavyMessages() });
  const queued = room.queueAdd('continue independent work', worker.id, otherRoom);
  const priorEvents = room.metadata(otherRoom).events.map(event => event.id);
  const file = path.join(dir, 'queue-dispatch.json');
  const ordinary = { phase: 'kept', oldNativeId: 'native-unrelated-rest', name: 'Unrelated resting member', roomIds: [otherRoom], keptAt: NOW };
  if (primary === 'ordinary') fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { 'unrelated-rest': ordinary } }), { mode: 0o600 });
  else if (primary === 'ordinary-rejected') fs.writeFileSync(file, JSON.stringify({ version: 1,
    rotations: { 'unrelated-rest': ordinary, 'rejected-ordinary': { phase: 'invalid-phase', oldNativeId: 'native-rejected', name: 'Rejected ordinary record', roomIds: [otherRoom] } } }), { mode: 0o600 });
  else if (primary === 'unreadable') fs.writeFileSync(file, '{"version":', { mode: 0o600 });
  if (damage === 'corrupt shared JSON') fs.writeFileSync(room.file, '{"version":', { mode: 0o600 });
  else fs.chmodSync(room.file, 0o644);
  const damagedBytes = fs.readFileSync(room.file, 'utf8'), loaded = new RoomState(dir);
  assert.ok(loaded.warning, 'the warning comes from an actual failed shared metadata read');
  assert.equal(loaded.spacesWarning, '', 'the other-space store remains valid');
  const client = new FakeClient([worker, old]);
  client.state.rooms.push({ id: otherRoom, revision: 0, run: null, messages: [] });
  fakeMembership(loaded, client);
  const notifications = [], dispatcher = new rules.QueueDispatcher({ roomState: loaded, dataDir: dir,
    connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000,
    sampleProcesses: async () => '', samplePressure: async () => '1', notify: kind => notifications.push(kind) });
  dispatcher.idleSince.set(worker.id, NOW - 60000);
  t.after(() => dispatcher.close());
  return { dir, room: loaded, client, dispatcher, worker, old, otherRoom, queued, priorEvents, notifications, damagedBytes };
}

for (const damage of ['corrupt shared JSON', 'unsafe shared permissions']) for (const primary of ['missing', 'ordinary', 'ordinary-rejected']) test(`B2 shared warning: ${damage} with ${primary} primary does not quarantine another space`, async t => {
  const f = sharedWarningSetup(t, damage, primary);
  await f.dispatcher.start();
  assert.equal(f.client.sends(f.worker.id).length, 0, 'the existing shared-record permission check continues to refuse queue delivery');
  assert.throws(() => f.room.assertAvailable(f.worker.id, true, f.otherRoom), error => error.message === f.room.warning &&
    error.uiMessage?.key === f.room.warningUiMessage.key, 'the shared warning is still the reason queue delivery is refused');
  assert.equal(f.client.sends(f.old.id).length, 1, 'the other space can request its normal content rotation');
  assert.match(f.client.sends(f.old.id)[0][2], /【NAW 换会话】/);
  assert.equal(f.dispatcher.rotations[f.old.id].phase, 'requested');
  assert.equal(f.notifications.includes('trustStateUnknown'), false, 'ordinary metadata damage does not invent migration quarantine');
  if (typeof f.dispatcher.trustAdmission === 'function') assert.equal(f.dispatcher.trustAdmission().quarantineUnknown, false);
  assert.ok(f.room.warning, 'the shared-store warning remains visible');
  const persisted = new RoomState(f.dir), other = persisted.metadata(f.otherRoom);
  assert.ok(persisted.warning); assert.equal(persisted.spacesWarning, '');
  assert.equal(other.queue.find(item => item.id === f.queued).status, 'queued');
  for (const id of f.priorEvents) assert.ok(other.events.some(event => event.id === id), 'existing other-space events survive');
  assert.equal(other.events.some(event => event.uiMessage?.key === 'notice.queue.dispatched'), false);
  assert.ok(other.events.some(event => event.uiMessage?.key === 'notice.rotation.requested'));
  assert.equal(f.client.calls.some(call => call[0] !== 'dispatch' || call[1] !== f.old.id), false, 'only the already-authorized rotation request reaches a native session');
  assert.equal(fs.readFileSync(f.room.file, 'utf8'), f.damagedBytes, 'normal work does not repair or overwrite the unreadable shared store');
});

test('B2 shared warning: an unreadable primary plus shared metadata damage still holds unproven sessions', async t => {
  const f = sharedWarningSetup(t, 'corrupt shared JSON', 'unreadable');
  await f.dispatcher.start();
  assert.equal(f.client.calls.length, 0, 'unreadable migration evidence cannot authorize dispatch, creation, stop, or native input');
  assert.deepEqual(f.notifications, ['trustStateUnknown']);
  assert.ok(f.room.warning);
  const persisted = new RoomState(f.dir), other = persisted.metadata(f.otherRoom);
  assert.equal(other.queue.find(item => item.id === f.queued).status, 'queued');
  assert.deepEqual(other.events.map(event => event.id), f.priorEvents);
  assert.equal(fs.readFileSync(f.room.file, 'utf8'), f.damagedBytes);
});

// The person, 11-12: 「如果独立会话里还有不需要的会话就自动归档吧」 (rotation-auto-archive.md).
async function rotateOnce(t, extra = {}) {
  const setup = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], extra);
  fakeMembership(setup.room, setup.client);
  // The rotation is saved as settled before the archive starts: a quit while it waits leaves nothing to redo.
  const archive = setup.room.archiveSession.bind(setup.room);
  setup.savedAtArchive = [];
  setup.room.archiveSession = (...args) => {
    setup.savedAtArchive.push(Object.keys(JSON.parse(fs.readFileSync(path.join(setup.dir, 'queue-dispatch.json'), 'utf8')).rotations));
    return archive(...args);
  };
  setup.room.queueAdd('next task', 'a');
  await setup.dispatcher.start();
  await setup.dispatcher.schedule();
  setup.client.reply('a', '交接：分支 abc。');
  await setup.dispatcher.schedule(); // the successor starts
  await setup.dispatcher.schedule(); // it gets the handoff
  await setup.dispatcher.schedule(); // the old one leaves, stops and is archived
  return { ...setup, newId: setup.client.state.sessions[1].id };
}
const rotationLog = dir => fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const eventKeys = room => room.value.events.map(event => event.uiMessage?.key);

// As the window client refuses a space pause or a member move while NAW replaces one backend (workspace-client.cjs
// operationGuard and the scoped pause): the automatic move of backends after an install lasts a few minutes.
const BACKEND_UPDATING = ['error.client.connectionUpdatingNoInput', 'error.client.connectionChangedNoReplay', 'error.client.spacePauseUnconfirmed'];
async function rotateIntoRefusedJoin(t, refusal) {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  const joins = fakeMembership(f.room, f.client), join = f.room.membership.bind(f.room);
  f.refused = 0; f.refusing = true;
  f.room.membership = async (...args) => {
    if (f.refusing && args[2] === true) {
      f.refused += 1;
      throw refusal();
    }
    return join(...args);
  };
  f.room.queueAdd('next task', 'a');
  await f.dispatcher.start();
  await f.dispatcher.schedule();
  f.client.reply('a', '交接：分支 abc。');
  await f.dispatcher.schedule(); // the successor is created and its join is refused
  f.pass = async () => { f.dispatcher.dirty = true; await f.dispatcher.schedule(); };
  return Object.assign(f, { joins, successor: () => f.client.state.sessions[1], creates: () => f.client.calls.filter(call => call[0] === 'create').length });
}

for (const key of BACKEND_UPDATING) {
  test(`a successor's join refused while a backend is being updated is tried again, not failed (${key.split('.').at(-1)})`, async t => {
    const f = await rotateIntoRefusedJoin(t, () => Object.assign(Error('PRIVATE_UPDATING_TEXT'), { uiMessage: { key } }));
    const waiting = () => {
      assert.equal(f.dispatcher.rotations.a?.phase, 'joining', 'the rotation waits for the join');
      assert.equal(f.successor().state, 'idle', 'NAW does not stop the session it just created');
      assert.equal(f.client.calls.some(call => call[0] === 'stop' || call[0] === 'stopUnusedSuccessor'), false);
      assert.equal(rotationLog(f.dir).some(entry => entry.event === 'failed'), false);
      assert.equal(f.room.value.queue[0].assignee, 'a', 'the waiting task stays with the old member until the join');
      assert.equal(f.creates(), 1, 'one successor, however many passes');
    };
    assert.equal(f.refused, 1); waiting();
    await f.pass(); await f.pass();
    assert.equal(f.refused, 3, 'each pass asks again'); waiting();
    f.refusing = false;
    await f.pass();
    assert.deepEqual(f.joins, [[f.successor().id, true, 'shared']]);
    assert.equal(f.room.value.queue[0].assignee, f.successor().id);
    await f.pass(); await f.pass();
    assert.deepEqual(rotationLog(f.dir).filter(entry => ['failed', 'done'].includes(entry.event)).map(entry => [entry.event, entry.old.id, entry.new.id]),
      [['done', 'a', f.successor().id]], 'the rotation finishes as an ordinary one');
    assert.equal(JSON.stringify(f.room.value.events).includes('PRIVATE_UPDATING_TEXT'), false);
  });
}

test('a join still refused ten minutes after the successor started fails as a join timeout', async t => {
  const f = await rotateIntoRefusedJoin(t, () => Object.assign(Error('PRIVATE_UPDATING_TEXT'), { uiMessage: { key: BACKEND_UPDATING[0] } }));
  f.advance(10 * 60 * 1000); await f.pass();
  assert.equal(f.dispatcher.rotations.a.phase, 'joining', 'still within the limit');
  f.advance(1); await f.pass();
  assert.equal(f.dispatcher.rotations.a.phase, 'failed'); assert.equal(f.dispatcher.rotations.a.reason, 'join-timeout');
  assert.equal(f.room.value.queue[0].assignee, 'a'); assert.equal(f.creates(), 1);
  assert.equal(f.successor().state, 'ended', 'only now is the unused successor stopped');
  assert.equal(JSON.stringify(f.room.value.events).includes('PRIVATE_UPDATING_TEXT'), false);
});

test('a join refused for any other reason still fails the rotation at once', async t => {
  const f = await rotateIntoRefusedJoin(t, () => Object.assign(Error('PRIVATE_OTHER_TEXT'), { uiMessage: { key: 'error.sessionMissing' } }));
  assert.equal(f.dispatcher.rotations.a.phase, 'failed'); assert.equal(f.refused, 1);
  assert.equal(f.room.value.queue[0].assignee, 'a'); assert.equal(f.successor().state, 'ended');
});

test('a done rotation archives the old session it stopped, logs it and says so in the space', async t => {
  const { room, client, dir, newId, savedAtArchive } = await rotateOnce(t);
  assert.deepEqual(savedAtArchive, [[newId]], 'only the successor rests in the saved rotations when the archive starts');
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  assert.deepEqual(room.value.archivedSessions, ['a'], 'the old session, not its successor');
  assert.equal(client.calls.filter(call => call[0] === 'pause').length, 0, 'the automatic archive pauses nothing');
  const log = rotationLog(dir), doneAt = log.findIndex(entry => entry.event === 'done'), archivedAt = log.findIndex(entry => entry.event === 'archived');
  assert.ok(doneAt >= 0 && archivedAt > doneAt, 'the archive is logged after the done rotation');
  assert.equal(log[archivedAt].old.id, 'a'); assert.equal(log[archivedAt].new.id, newId);
  const keys = eventKeys(room);
  assert.ok(keys.indexOf('notice.rotation.archived') > keys.indexOf('notice.rotation.done'));
  // Archiving is undone from the sidebar, as for any session.
  await room.restoreSession(client, 'a', 'Agent a');
  assert.deepEqual(room.value.archivedSessions, []);
});

test('an old session kept because it is in use is not archived', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  const tried = []; const archive = room.archiveSession.bind(room);
  room.archiveSession = (...args) => { tried.push(args[1]); return archive(...args); };
  room.queueAdd('next task', 'a');
  await dispatcher.start(); await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule(); await dispatcher.schedule();
  advance(1000); dispatcher.noteHuman('a'); await dispatcher.schedule();
  assert.deepEqual(tried, [], 'not even tried');
  assert.deepEqual(room.value.archivedSessions, []);
  assert.ok(!eventKeys(room).includes('notice.rotation.archived'));
});

test('an archive that fails leaves the old session where it was and the rotation done', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.archiveSession = async () => { throw Error('archive refused'); };
  room.queueAdd('next task', 'a');
  await dispatcher.start(); await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule(); await dispatcher.schedule(); await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  assert.deepEqual(room.value.archivedSessions, []);
  const keys = eventKeys(room);
  assert.ok(keys.includes('notice.rotation.done')); assert.ok(!keys.includes('notice.rotation.archived'));
});

// Already in the list from rotations before this: the daily log's own shape (done, old ended, successor running).
function handedOffSetup(t, sessions, entries) {
  const { dir, room } = roomSetup(t);
  fs.writeFileSync(path.join(dir, 'rotation-log.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  const client = new FakeClient(sessions);
  const make = () => {
    // No queued work: a full pass is the once-a-minute check through an open window, as in the daily app.
    const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, clients: () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
    t.after(() => dispatcher.close());
    return dispatcher;
  };
  return { dir, room, client, make };
}
const doneEntry = (old, next, time = NOW - 10 * HOUR, extra = {}) => ({ time, event: 'done', spaces: ['shared'],
  old: { id: old, nativeId: `native-${old}`, name: `Agent ${old}` }, new: { id: next, nativeId: `native-${next}`, name: `Agent ${next}` }, ...extra });
const ended = (id, extra = {}) => member(id, { state: 'ended', roomIds: [], roomId: null, messages: [{ id: `${id}-1`, role: 'user', text: 'before', time: NOW - 20 * HOUR }], ...extra });

test('rotations from before are archived once: an ended old session in no space, untouched since, its successor still there', async t => {
  const { dir, room, client, make } = handedOffSetup(t, [ended('old1'), member('new1')], [doneEntry('old1', 'new1')]);
  const first = make();
  await first.start(); await first.schedule();
  assert.deepEqual(room.value.archivedSessions, ['old1']);
  const logged = rotationLog(dir).filter(entry => entry.event === 'archived');
  assert.equal(logged.length, 1); assert.equal(logged[0].old.id, 'old1'); assert.equal(logged[0].new.id, 'new1');
  assert.ok(eventKeys(room).includes('notice.rotation.archived'));
  // The person restores it: a later start never archives it again.
  await room.restoreSession(client, 'old1', 'Agent old1');
  first.close();
  const second = make();
  await second.start(); await second.schedule();
  assert.deepEqual(room.value.archivedSessions, []);
  assert.equal(rotationLog(dir).filter(entry => entry.event === 'archived').length, 1);
});

for (const [name, sessions, entries] of [
  ['used by the person after its rotation', [ended('old1', { messages: [{ id: 'm', role: 'user', text: 'later', time: NOW - 5 * HOUR }] }), member('new1')], [doneEntry('old1', 'new1')]],
  ['running again', [ended('old1', { state: 'idle' }), member('new1')], [doneEntry('old1', 'new1')]],
  ['back in a space', [ended('old1', { roomIds: ['shared'], roomId: 'shared' }), member('new1')], [doneEntry('old1', 'new1')]],
  ['its successor gone', [ended('old1')], [doneEntry('old1', 'new1')]],
  ['continued as another native session', [ended('old1', { nativeId: 'native-other' }), member('new1')], [doneEntry('old1', 'new1')]],
  ['kept, not done', [ended('old1'), member('new1')], [{ ...doneEntry('old1', 'new1'), event: 'kept' }]],
  ['the person\'s row has no time', [ended('old1', { messages: [{ id: 'm', role: 'user', text: 'when?' }] }), member('new1')], [doneEntry('old1', 'new1')]],
  ['already archived once and restored', [ended('old1'), member('new1')], [doneEntry('old1', 'new1'), { ...doneEntry('old1', 'new1', NOW - 9 * HOUR), event: 'archived' }]],
]) test(`a rotation from before is not archived: ${name}`, async t => {
  const { room, make } = handedOffSetup(t, sessions, entries);
  const dispatcher = make();
  let passes = 0; const original = dispatcher.archiveHandedOff.bind(dispatcher);
  dispatcher.archiveHandedOff = snapshot => { passes++; return original(snapshot); };
  const tried = []; const archive = room.archiveSession.bind(room);
  room.archiveSession = (...args) => { tried.push(args[1]); return archive(...args); };
  await dispatcher.start(); await dispatcher.schedule();
  assert.equal(passes, 1, 'the pass ran, once');
  assert.deepEqual(tried, [], 'not even tried');
  assert.deepEqual(room.value.archivedSessions, []);
  assert.ok(!eventKeys(room).includes('notice.rotation.archived'));
});
test('NAW\'s automatic archive pauses nothing and refuses a session still in a space; through a client without per-space calls the person\'s archive pauses first', async t => {
  const { room } = roomSetup(t);
  const client = new FakeClient([ended('gone'), member('inspace')]);
  const paused = [];
  const original = client.call.bind(client);
  client.call = async (method, ...args) => { if (method === 'pause') { paused.push(args); return; } return original(method, ...args); };
  await room.archiveSession(client, 'gone', 'Agent gone', { automatic: true });
  assert.deepEqual(room.value.archivedSessions, ['gone']); assert.deepEqual(paused, [], 'nobody intervened, so nothing is paused');
  await assert.rejects(room.archiveSession(client, 'inspace', 'Agent inspace', { automatic: true }), error => error.uiMessage?.key === 'error.room.sessionRestoreChanged');
  assert.equal(client.calls.filter(call => call[0] === 'moveMembership').length, 0, 'it never starts leaving the space');
  assert.deepEqual(room.value.archivedSessions, ['gone']); assert.deepEqual(paused, []);
  await room.restoreSession(client, 'gone', 'Agent gone');
  await room.archiveSession(client, 'gone', 'Agent gone');
  assert.deepEqual(paused, [['gone']], 'the person\'s own archive is unchanged');
});
test('an old session that was not running when its rotation finished is left to the next start\'s check', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  const tried = []; const archive = room.archiveSession.bind(room);
  room.archiveSession = (...args) => { tried.push(args[1]); return archive(...args); };
  room.queueAdd('next task', 'a');
  await dispatcher.start(); await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule(); await dispatcher.schedule();
  // Sent to the native background before NAW finishes: NAW does not stop it, so it does not archive it either.
  client.state.sessions[0].state = 'background';
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0);
  assert.deepEqual(tried, [], 'not even tried');
  assert.deepEqual(room.value.archivedSessions, []);
});

test('an archive that finishes after the wait gave up is still logged, so a restore stays restored', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { dir, room, client, make } = handedOffSetup(t, [ended('old1'), member('new1')], [doneEntry('old1', 'new1')]);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const archive = room.archiveSession.bind(room);
  room.archiveSession = async (...args) => { await gate; return archive(...args); };
  const dispatcher = make();
  const started = dispatcher.start();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60000);
  await started;
  assert.equal(rotationLog(dir).filter(entry => entry.event === 'archived').length, 0, 'not yet');
  release();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(room.value.archivedSessions, ['old1']);
  assert.equal(rotationLog(dir).filter(entry => entry.event === 'archived').length, 1, 'logged when it finished');
  room.archiveSession = archive;
  await room.restoreSession(client, 'old1', 'Agent old1');
  dispatcher.close();
  const again = make(); await again.start(); await again.schedule();
  assert.deepEqual(room.value.archivedSessions, [], 'a restored session stays restored');
});

test('archiving a session the snapshot does not hold leaves no gate behind', async t => {
  const { room } = roomSetup(t);
  const client = new FakeClient([member('present')]);
  await assert.rejects(room.archiveSession(client, 'missing', 'Missing'), error => error.uiMessage?.key === 'error.sessionMissing');
  await assert.rejects(room.archiveSession(client, 'missing', 'Missing'), error => error.uiMessage?.key === 'error.sessionMissing', 'not "updating" the second time');
});
test('archiveOld reports a session the person archived meanwhile as \'already\', without trying to archive it', async t => {
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [ended('gone')]);
  room.update({ archivedSessions: ['gone'] });
  let tried = 0; const archive = room.archiveSession.bind(room); room.archiveSession = async (...args) => { tried++; return archive(...args); };
  assert.equal(await dispatcher.archiveOld('gone', 'Agent gone', () => {}), 'already');
  assert.equal(tried, 0);
});
test('a rotation whose old session the person archived during the handoff settles quietly', async t => {
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start(); await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule(); await dispatcher.schedule();
  room.update({ archivedSessions: ['a'] });
  await dispatcher.schedule();
  const archived = rotationLog(dir).filter(entry => entry.event === 'archived');
  assert.equal(archived.length, 1); assert.equal(archived[0].by, 'other');
  assert.ok(!eventKeys(room).includes('notice.rotation.archived'), 'no line claims NAW archived it');
});
test('an earlier rotation\'s old session someone else archived is settled quietly; restoring it later sticks', async t => {
  const { dir, room, client, make } = handedOffSetup(t, [ended('old1'), member('new1')], [doneEntry('old1', 'new1')]);
  room.update({ archivedSessions: ['old1'] });
  const first = make(); await first.start(); await first.schedule();
  const archived = rotationLog(dir).filter(entry => entry.event === 'archived');
  assert.equal(archived.length, 1); assert.equal(archived[0].by, 'other');
  assert.ok(!eventKeys(room).includes('notice.rotation.archived'));
  await room.restoreSession(client, 'old1', 'Agent old1');
  first.close();
  const second = make(); await second.start(); await second.schedule();
  assert.deepEqual(room.value.archivedSessions, [], 'the restore stays');
});

// Follow-up 2 (11-12): the refusal for an assignee that is not a current member of the space.
test('assigneeRefusal: members in the person\'s order with name and id, kept short; nothing for no assignee or a member', () => {
  const R = '7b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8';
  const sessions = [
    { id: 'm-1', name: 'First', roomIds: [R] },
    { id: 'm-2', name: 'x'.repeat(80), roomIds: [R] },
    { id: 'm-3', name: 'Archived', roomIds: [R], archived: true },
    { id: 'm-4', roomIds: 'unreadable' },
    { id: 'm-5', roomIds: [R] },
  ];
  const room = { id: R, memberOrder: ['m-5', 'missing'] };
  assert.equal(rules.assigneeRefusal(null, room, sessions), null);
  assert.equal(rules.assigneeRefusal(undefined, room, sessions), null);
  assert.equal(rules.assigneeRefusal('m-1', room, sessions), null);
  for (const assignee of ['m-3', 'm-4', 'missing', 'M-1', 'm-1 ', 1]) {
    const error = rules.assigneeRefusal(assignee, room, sessions);
    assert.equal(error.uiMessage.key, 'error.queue.assigneeNotMember', String(assignee));
    assert.equal(error.uiMessage.params.members, `m-5 · m-5; First · m-1; ${'x'.repeat(59)}… · m-2`);
  }
  // Named the way the caller names sessions (the person's labels in the app).
  assert.match(rules.assigneeRefusal('missing', room, sessions, s => `Label ${s.id}`).uiMessage.params.members, /^Label m-5 · m-5; Label m-1 · m-1/);
  // A long list stops within what a background receipt keeps of an error, and says how many are left out.
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `member-${String(i).padStart(2, '0')}-${'0'.repeat(24)}`, name: 'N'.repeat(60), roomIds: [R] }));
  const long = rules.assigneeRefusal('missing', { id: R }, many);
  assert.ok(long.message.length <= 2048, String(long.message.length));
  const listed = long.uiMessage.params.members.split('; ');
  assert.match(listed.at(-1), /^… \+\d+$/);
  assert.equal(listed.length - 1 + Number(listed.at(-1).slice(3)), 80);
  assert.equal(rules.assigneeRefusal('missing', { id: R }, []).uiMessage.key, 'error.queue.assigneeNoMembers');
  assert.equal(rules.assigneeRefusal('m-1', { id: '7b1d2c3e-4f50-4a61-8b72-000000000000' }, sessions).uiMessage.key, 'error.queue.assigneeNoMembers');
});

// 11-12 (items 0bcc3c9c, 2829a073): the butler could mark handled only an item waiting for the person. An item already
// sent, whose work was done some other way, stayed open; the person or the butler may now mark it handled.
test('the person or the butler marks handled an item already sent; one still queued, or closed, is still refused', t => {
  const { room } = roomSetup(t);
  const queued = room.queueAdd('still queued', null), sent = room.queueAdd('sent but done elsewhere', null), other = room.queueAdd('sent, the butler closes it', null);
  room.queueMarkSent('shared', sent, 'agent-a', 'Claude 2', NOW);
  room.queueMarkSent('shared', other, 'agent-b', 'Codex 1', NOW);
  room.queueResolve(sent);
  room.queueResolve(other, 'shared', 'steward');
  const [, second, third] = room.value.queue;
  assert.deepEqual([second.status, second.finishedBy, second.sentTo], ['done', undefined, 'agent-a']);
  assert.deepEqual([third.status, third.finishedBy, third.sentTo], ['done', 'steward', 'agent-b']);
  const lines = room.value.events.filter(event => /^notice\.queue\.resolved/.test(event.uiMessage?.key || '')).map(event => event.text);
  assert.deepEqual(lines, ['已处理：sent but done elsewhere', '已处理：sent, the butler closes it · 大管家标的']);
  // A queued item for nobody is cancelled instead; marked done, it would name nobody in its row.
  for (const by of ['steward', null]) assert.throws(() => room.queueResolve(queued, 'shared', by), /不在等你决定/);
  assert.equal(room.queueFind('shared', queued).status, 'queued');
  const cancelled = room.queueAdd('cancelled one', null);
  room.queueCancel(cancelled);
  for (const id of [sent, other, cancelled]) assert.throws(() => room.queueResolve(id, 'shared', 'steward'), /不在等你决定/);
});

// 11-13 (items 61f9c09b, 862d6abb): an item still queued for a member who did the work from the board could only be
// cancelled, and the record said 「已取消」. The person or the butler may mark it handled; its row names that member.
test('an item still queued for a member who did it another way is marked handled, names that member, and is never sent', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a'), member('b')]);
  const done = room.queueAdd('merged from the board', 'a'), person = room.queueAdd('the person closes this one', 'b');
  room.queueResolve(done, 'shared', 'steward');
  room.queueResolve(person);
  assert.deepEqual(room.value.queue.map(item => [item.status, item.finishedBy, item.assignee, item.sentTo, Number.isFinite(item.finishedAt)]),
    [['done', 'steward', 'a', undefined, true], ['done', undefined, 'b', undefined, true]]);
  const lines = room.value.events.filter(event => /^notice\.queue\.(resolved|cancelled)/.test(event.uiMessage?.key || '')).map(event => event.text);
  assert.deepEqual(lines, ['已处理：merged from the board · 大管家标的', '已处理：the person closes this one'], 'handled, not cancelled');
  assert.equal(room.value.events.filter(event => event.monitor?.kind === 'queue-dry').length, 1, 'the queue ran dry once, as after a cancel');
  // Closed, it stays closed: marked again or cancelled, it is refused.
  assert.throws(() => room.queueResolve(done, 'shared', 'steward'), /不在等你决定/);
  assert.throws(() => room.queueCancel(done, 'shared', 'steward'));
  const faults = passFaults(dispatcher);
  await dispatcher.start();
  for (let i = 0; i < 3; i += 1) { dispatcher.dirty = true; await dispatcher.schedule(); }
  assert.equal(client.sends().length, 0, 'never sent');
  assert.deepEqual(room.value.queue.map(item => item.status), ['done', 'done']);
  assert.deepEqual(faults, []);
});

test('an item marked handled while the pass was planning to send it is not sent', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  const late = room.queueAdd('done from the board while NAW was planning', 'a'), faults = passFaults(dispatcher);
  const sample = dispatcher.memory.bind(dispatcher);
  dispatcher.memory = async (...args) => { if (room.queueFind('shared', late).status === 'queued') room.queueResolve(late, 'shared', 'steward'); return sample(...args); };
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0);
  assert.deepEqual([room.value.queue[0].status, room.value.queue[0].finishedBy], ['done', 'steward']);
  assert.deepEqual(faults, []);
});

test('an item the butler marked handled while sent stays handled when the member\'s turn ends, and is not sent again', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  const id = room.queueAdd('only task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].status, 'sent');
  room.queueResolve(id, 'shared', 'steward');
  // What would otherwise leave it waiting: the person typed in that session, and the member asks for a decision.
  client.state.sessions[0].messages.push({ id: 'person-1', role: 'user', text: 'the person types', time: NOW + 1 });
  client.reply('a', '需要你决定：要不要合？');
  for (let i = 0; i < 3; i += 1) { dispatcher.dirty = true; await dispatcher.schedule(); }
  const item = room.value.queue[0];
  assert.deepEqual([item.status, item.finishedBy, item.reason], ['done', 'steward', undefined]);
  assert.equal(room.value.events.some(event => ['notice.queue.waiting', 'notice.queue.failed'].includes(event.uiMessage?.key)), false);
  assert.equal(client.sends().length, 1, 'sent once, never again');
});

test('an item the butler closes while still queued is never sent, even when the pass had already planned to send it', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  const early = room.queueAdd('cancelled before NAW looked', null);
  room.queueCancel(early, 'shared', 'steward');
  const late = room.queueAdd('cancelled while NAW was planning', null), faults = passFaults(dispatcher);
  const sample = dispatcher.memory.bind(dispatcher);
  // The pass read the space before this await and plans from what it read; the butler closes the item meanwhile.
  dispatcher.memory = async (...args) => { if (room.queueFind('shared', late).status === 'queued') room.queueCancel(late, 'shared', 'steward'); return sample(...args); };
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0);
  assert.deepEqual(room.value.queue.map(item => item.status), ['cancelled', 'cancelled']);
  assert.deepEqual(faults, []);
});

// The dispatcher's loop swallows a pass that faults and tries again, which hides it from what a test can see otherwise.
function passFaults(dispatcher) {
  const faults = [], tick = dispatcher.tick.bind(dispatcher);
  dispatcher.tick = async () => { try { return await tick(); } catch (error) { faults.push(error.message); throw error; } };
  return faults;
}

test('an item marked handled after the pass read it is left as handled, and the rest of that pass goes on', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a'), member('b')]);
  const first = room.queueAdd('first, for a', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(room.queueFind('shared', first).status, 'sent');
  client.reply('a', '需要你决定：要不要合？');
  const second = room.queueAdd('second, for b', 'b'), faults = passFaults(dispatcher);
  const sample = dispatcher.memory.bind(dispatcher);
  dispatcher.memory = async (...args) => { if (room.queueFind('shared', first).status === 'sent') room.queueResolve(first, 'shared', 'steward'); return sample(...args); };
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.deepEqual([room.queueFind('shared', first).status, room.queueFind('shared', first).finishedBy], ['done', 'steward']);
  assert.equal(room.value.events.some(event => event.uiMessage?.key === 'notice.queue.waiting'), false);
  assert.equal(room.queueFind('shared', second).status, 'sent');
  assert.equal(client.sends('b').length, 1);
  assert.deepEqual(faults, [], 'the settle planned from the earlier read did not fault the pass');
});

for (const outcome of ['delivered', 'refused', 'uncertain']) test(`an item marked handled while its send was on the way stays as handled (${outcome}); the pass goes on`, async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a'), member('b')]);
  const first = room.queueAdd('first, for a', 'a'), second = room.queueAdd('second, for b', 'b'), faults = passFaults(dispatcher);
  const original = client.call.bind(client);
  client.call = async (method, ...args) => {
    if (method === 'dispatch' && args[0] === 'a') {
      room.queueResolve(first, 'shared', 'steward');
      if (outcome === 'refused') throw Object.assign(Error('not ready'), { uiMessage: { key: 'error.workspace.sessionNotReady' } });
      if (outcome === 'uncertain') throw Error('backend went away');
    }
    return original(method, ...args);
  };
  await dispatcher.start();
  await dispatcher.schedule();
  const item = room.queueFind('shared', first);
  assert.deepEqual([item.status, item.finishedBy, item.tag, item.attempts, item.reason], ['done', 'steward', null, undefined, undefined]);
  assert.equal(room.value.events.some(event => event.uiMessage?.key === 'notice.queue.failed'), false);
  assert.equal(room.queueFind('shared', second).status, 'sent');
  assert.equal(client.sends('b').length, 1);
  assert.deepEqual(faults, []);
});

// Queue 794d3cd7 (the person, 2026-11-13): a conversation compacted again and again continues in a new
// session through the same handoff, without waiting out a successor's day of rest, and the butler between turns.
function fakeCompactions(counts) {
  const seen = [], again = [];
  return {
    seen, again, counts,
    async sample(sessions) { seen.push(sessions.map(session => session.id)); return new Map(Object.entries(counts)); },
    async recheck(session) { again.push(session.id); },
  };
}

test('794d3cd7: a member compacted COMPACT_LIMIT times is rotated before its next item, or after thirty quiet minutes', () => {
  assert.equal(rules.COMPACT_LIMIT, 3);
  assert.equal(rules.QUIET_COMPACT_MS, 2 * 60000);
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const counted = n => ({ compactions: new Map([['a', n]]) });
  const dispatch = [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }];
  assert.deepEqual(plan(rooms, [member('a')], counted(3)), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  assert.deepEqual(plan(rooms, [member('a')], counted(7)), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 7 }]);
  assert.deepEqual(plan(rooms, [member('a')], counted(2)), dispatch);
  assert.deepEqual(plan(rooms, [member('a')]), dispatch, 'no count known');
  assert.deepEqual(plan(rooms, [member('a')], { compactions: new Map([['a', '5']]) }), dispatch, 'not a count');
  assert.deepEqual(plan(rooms, [member('a')], { ...counted(1), compactLimit: 1 }), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 1 }]);
  // A long conversation keeps its own reason and words when both apply.
  assert.deepEqual(plan(rooms, [member('a', { messages: heavyMessages() })], counted(3)), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  // With nothing queued, a member waits out the usual thirty quiet minutes: the person may be talking to it.
  const idle = [{ id: 'shared', name: 'Team', queue: [] }];
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 30 * 60000 })], counted(3)), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 29 * 60000 })], counted(3)), [], 'a member is not cut into at a pause');
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 2 * 60000 })], counted(3)), []);
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 2 * 60000 })], { ...counted(3), butler: 'other' }), [], 'only the butler itself');
  // The butler in a space: between two turns.
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 2 * 60000 })], { ...counted(3), butler: 'a' }), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 90000 })], { ...counted(3), butler: 'a' }), [], 'still within a pause between turns');
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 5 * 60000 })], { ...counted(3), butler: 'a', humanAt: new Map([['a', NOW - 60000]]) }), [], 'the person just wrote to it');
  assert.deepEqual(plan(idle, [member('a', { lastActivityAt: NOW - 5 * 60000, state: 'working' })], { ...counted(3), butler: 'a' }), []);
  // The butler's other reasons keep their thirty quiet minutes.
  assert.deepEqual(plan(idle, [member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 5 * 60000 })], { butler: 'a' }), []);
  // The other reasons keep their thirty and ten quiet minutes.
  const heavy = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages(), lastActivityAt: NOW - 5 * 60000 });
  assert.deepEqual(plan(idle, [heavy]), []);
});

// The person, 2026-11-24 (cache-aware handoff): a Claude member that is large and still warm continues in a new session
// before its next item, instead of being compacted in the middle of it. A cold one would pay for its whole conversation
// again just to write the handoff (97 of them in two weeks: median 227K input-equivalents cold, 21K warm).
test('cache-aware rotation: a large warm Claude member is rotated before its next item, a cold, small, young or idle one is not', () => {
  assert.deepEqual(rules.CONTEXT_LIMITS, { claude: 180000 });
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const dispatch = [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }];
  const rotate = [{ kind: 'rotate', sessionId: 'a', reason: 'context', contextTokens: 180000 }];
  const old = { createdAt: NOW - 2 * HOUR };
  const context = (extra = {}) => ({ contexts: new Map([['a', { tokens: 180000, at: NOW - 60000, ttlMs: HOUR, ...extra }]]) });
  assert.deepEqual(plan(rooms, [member('a', old)], context()), rotate);
  assert.deepEqual(plan(rooms, [member('a', old)], context({ tokens: 179999 })), dispatch, 'not large yet');
  assert.deepEqual(plan(rooms, [member('a', old)], context({ at: NOW - 53 * 60000 })), rotate, 'still warm');
  assert.deepEqual(plan(rooms, [member('a', old)], context({ at: NOW - 55 * 60000 })), dispatch, 'about to go cold: the handoff itself could miss the cache');
  assert.deepEqual(plan(rooms, [member('a', old)], context({ at: NOW - 3 * HOUR })), dispatch, 'cold');
  // A provider that shortens the lifetime (over the plan: five minutes) shortens the window with it.
  assert.deepEqual(plan(rooms, [member('a', old)], context({ at: NOW - 10 * 60000, ttlMs: 5 * 60000 })), dispatch);
  assert.deepEqual(plan(rooms, [member('a', old)], context({ at: NOW - 4 * 60000, ttlMs: 5 * 60000 })), rotate);
  assert.deepEqual(plan(rooms, [member('a', old)], context({ ttlMs: null })), dispatch, 'lifetime unknown');
  assert.deepEqual(plan(rooms, [member('a', old)], context({ at: NOW + 60000 })), dispatch, 'a time ahead of this clock');
  assert.deepEqual(plan(rooms, [member('a', old)], context({ tokens: '180000' })), dispatch, 'not a size');
  assert.deepEqual(plan(rooms, [member('a', old)]), dispatch, 'no size known');
  // A successor that read a lot in its first turn does its item first, or it would be replaced again and again.
  assert.deepEqual(plan(rooms, [member('a', { createdAt: NOW - 59 * 60000 })], context()), dispatch);
  assert.deepEqual(plan(rooms, [member('a', { ...old, provider: 'codex' })], context()), dispatch, 'Codex is not measured');
  // With nothing queued: not while its last request is this recent, however long NAW saw nothing (R221, below).
  const idle = [{ id: 'shared', name: 'Team', queue: [] }];
  for (const minutes of [2, 10, 30, 50]) {
    assert.deepEqual(plan(idle, [member('a', { ...old, lastActivityAt: NOW - minutes * 60000 })], context()), []);
    assert.deepEqual(plan(idle, [member('a', { ...old, lastActivityAt: NOW - minutes * 60000 })], { ...context(), butler: 'a' }), []);
  }
  // Another reason keeps its own words, and a successor's day of rest does not hold this one.
  assert.deepEqual(plan(rooms, [member('a', old)], { ...context(), compactions: new Map([['a', 3]]) }), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  const successor = { phase: 'kept', keptAt: NOW - HOUR, successorOf: 'before' };
  assert.deepEqual(plan(rooms, [member('a', old)], { ...context(), rotations: { a: successor } }), rotate);
  assert.deepEqual(plan(rooms, [member('a', old)], { ...context(), rotations: { a: { phase: 'kept', keptAt: NOW - HOUR } } }), dispatch, 'an old kept session');
  assert.deepEqual(plan(rooms, [member('a', old)], { ...context(), deferredRotations: new Set(['a']) }), dispatch, 'the person is using it');
  // One rotation at a time: the member works on meanwhile, and nothing is reported as stalled for this reason.
  const gates = new Map();
  const running = { z: { phase: 'requested', requestedAt: NOW } };
  assert.deepEqual(plan(rooms, [member('a', old), member('z', { state: 'working' })], { ...context(), rotations: running, rotationGates: gates }), dispatch);
  assert.equal(gates.has('a'), false);
  // Two due at once: one is rotated, the other does its item now; a turn that holds the one slot for its whole half
  // hour holds no item of anyone else's (the PM, 11-24).
  const two = [{ id: 'shared', name: 'Team', queue: [item('1', { assignee: 'a' }), item('2', { assignee: 'b' })] }];
  const both = { contexts: new Map(['a', 'b'].map(id => [id, { tokens: 200000, at: NOW - 60000, ttlMs: HOUR }])) };
  assert.deepEqual(plan(two, [member('a', old), member('b', old)], both).map(action => [action.kind, action.sessionId]), [['rotate', 'a'], ['dispatch', 'b']]);
  for (const requestedAt of [NOW, NOW - 29 * 60000]) {
    const busy = { z: { phase: 'handed', requestedAt, handedAt: requestedAt, newId: 'y' } };
    assert.deepEqual(plan(two, [member('a', old), member('b', old), member('y', { state: 'working' })], { ...both, rotations: busy })
      .map(action => [action.kind, action.sessionId]), [['dispatch', 'a'], ['dispatch', 'b']]);
  }
});

// 11-23: nobody was rotated for 14 hours. The four kinds added on 11-19 were not named beside person-intervened
// and no-reply, so each counted as a decision its member had asked.
const WAITING_KINDS = [
  'person-intervened',
  'no-reply',
  'input-purpose-unconfirmed',
  'rotation-control-unresolved',
  'native-turn-failed',
  'usage-limit-exceeded',
];
const COMPACTED = { compactions: new Map([['a', 3]]) };
const ROTATE_COMPACTED = [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }];

for (const reason of WAITING_KINDS) {
  test(`rotation-stalled 11-23: an item NAW left waiting as ${reason} does not keep its member's session`, () => {
    const left = sentItem({ status: 'waiting', reason });
    const queued = [{ id: 'shared', name: 'Team', queue: [left, item('2')] }];
    assert.deepEqual(plan(queued, [member('a')], COMPACTED), ROTATE_COMPACTED, 'before its next item');
    const idle = [{ id: 'shared', name: 'Team', queue: [left] }];
    const quiet = member('a', { lastActivityAt: NOW - 30 * 60000 });
    assert.deepEqual(plan(idle, [quiet], COMPACTED), ROTATE_COMPACTED, 'after thirty quiet minutes');
  });
}

test('a decision the member asked does not keep its session either: it is rotated when due, alone or beside such an item', () => {
  // 11-23, the person: 「要不要改成把没答的决定带给继任会话，答复跟着换会话链走？要」. Until then one open decision
  // kept its member's session however long the person took.
  const decision = sentItem({ status: 'waiting' });
  const refusedOnce = sentItem({ status: 'waiting', reason: 'Synthetic draft refusal' });
  const unverified = item('0', { status: 'waiting', reason: 'input-purpose-unconfirmed', sentTo: 'a', sentAt: NOW - 60000, tag: 't0', control: 0 });
  const quiet = member('a', { lastActivityAt: NOW - 30 * 60000 });
  for (const open of [[decision], [refusedOnce], [unverified, decision]]) {
    const queued = [{ id: 'shared', name: 'Team', queue: [...open, item('2')] }];
    assert.deepEqual(plan(queued, [member('a')], COMPACTED), ROTATE_COMPACTED, 'before its next item');
    const idle = [{ id: 'shared', name: 'Team', queue: open }];
    assert.deepEqual(plan(idle, [quiet], COMPACTED), ROTATE_COMPACTED, 'after thirty quiet minutes');
  }
  // A member not due for a new session takes its next item where it is, marked as before.
  const fresh = [{ id: 'shared', name: 'Team', queue: [decision, item('2')] }];
  assert.deepEqual(plan(fresh, [member('a')]), [{ kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a', afterDecision: true }]);
});

test('decisions too long to hand over whole keep the session: nothing of a decision is cut to make it fit', () => {
  // The handoff is one NAW message. The decisions in it are never shortened, so a member whose open decisions do
  // not fit beside a handoff is the one case left where a decision keeps its session.
  const long = n => sentItem({ id: `d${n}`, status: 'waiting', text: 'x'.repeat(rules.ITEM_TEXT_LIMIT), reply: '需要你决定：选哪个？' });
  const fits = [{ id: 'shared', name: 'Team', queue: [long(1), item('2')] }];
  assert.deepEqual(plan(fits, [member('a')], COMPACTED), ROTATE_COMPACTED);
  const over = [{ id: 'shared', name: 'Team', queue: [long(1), long(2), item('2')] }];
  assert.deepEqual(plan(over, [member('a')], COMPACTED), [{ kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a', afterDecision: true }]);
});

test('the handoff names every open decision whole: item id, the item\'s text and the member\'s full question; only the old session\'s own text is cut', () => {
  const asked = '需要你决定：要不要删旧分支？\n\nA：删，B：留。推荐 A，因为它已经合进 main。' + '补充'.repeat(1600);
  const old = member('a', { messages: [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: asked },
    { id: 't2', role: 'user', text: 'NAW task 2', origin: 'naw-dispatch' },
    { id: 'r2', role: 'assistant', text: '第二件做完了。' },
  ] });
  const open = sentItem({ id: 'item-one', status: 'waiting', text: '清理旧分支，然后报告。', reply: rules.replyLine(asked) });
  const other = sentItem({ id: 'item-two', status: 'waiting', reason: 'no-reply', tag: 't2' });
  const elsewhere = sentItem({ id: 'item-three', status: 'waiting', reply: '需要你决定：别的空间的事？' });
  const rooms = [{ id: 'shared', name: 'Team', queue: [open, other] }, { id: 'left-space', name: 'Left', queue: [elsewhere] }];
  assert.ok(open.reply.length < asked.length, 'the queue item keeps one cut line of the question');
  const decisions = rules.openDecisions(rooms, old, ['shared']);
  assert.deepEqual(decisions, [{ roomId: 'shared', roomName: 'Team', itemId: 'item-one', text: '清理旧分支，然后报告。', question: asked }]);
  const note = rules.decisionsNote('Agent a', decisions);
  for (const part of ['item-one', '清理旧分支，然后报告。', asked]) {
    assert.ok(note.includes(part), part.slice(0, 20));
  }
  assert.doesNotMatch(note, /item-two|item-three|第二件做完了/, 'only decisions this member asked, in the spaces it hands over');
  // The record that held the question is gone (a compacted session): the line NAW kept stands in.
  const forgotten = rules.openDecisions(rooms, { ...old, messages: [] }, ['shared']);
  assert.deepEqual(forgotten, [{ ...decisions[0], question: open.reply, cut: true }]);
  // The successor is told so, not left to take that line for the whole question.
  assert.match(rules.decisionsNote('Agent a', forgotten), /提问 200 字（只留下开头，全文没找到）。\n/);
  assert.doesNotMatch(note, /只留下开头/);
  // A short question the kept line holds entire is not marked.
  const brief = sentItem({ id: 'item-four', status: 'waiting', reply: '需要你决定：选哪个？' });
  assert.equal(rules.openDecisions([{ id: 'shared', name: 'Team', queue: [brief] }], { ...old, messages: [] }, ['shared'])[0].cut, undefined);
  // A long handoff: its own text is cut, the decisions and the other notes are not.
  const duty = '【NAW 职责说明】\n' + 'd'.repeat(1000);
  const text = rules.handoffText('Agent a', 'h'.repeat(rules.ITEM_TEXT_LIMIT * 2), '旧目录说明', duty, note);
  assert.ok(text.length <= 16000, `${text.length}`);
  assert.ok(text.includes(note) && text.includes(duty) && text.includes('旧目录说明'));
  assert.match(text, /h…\n\n【没答的决定】/);
  assert.equal(rules.decisionsNote('Agent a', []), '');
  assert.equal(rules.handoffText('A', '交接', '', '', ''), rules.handoffText('A', '交接'), 'no decision, no change');
});

test('a successor that is replaced in turn hands the same decision on whole: it reads the question back from its own handoff', () => {
  const asked = '需要你决定：要不要删旧分支？\n\nA：删，B：留。' + '补充'.repeat(200);
  const held = sentItem({ id: 'item-one', status: 'waiting', sentTo: 'b', text: '清理旧分支，然后报告。', reply: rules.replyLine(asked),
    askedBy: { id: 'a' }, carriedFrom: { id: 'a' } });
  const rooms = [{ id: 'shared', name: 'Team', queue: [held] }];
  const note = rules.decisionsNote('Agent a', [{ roomId: 'shared', roomName: 'Team', itemId: 'item-one', text: held.text, question: asked }]);
  const told = text => member('b', { messages: [{ id: 'h1', role: 'user', origin: 'naw-dispatch', dispatchItem: 'rotation-handoff:a', text }] });
  const first = rules.handoffText('Agent a', '旧会话的交接。', '', '', note);
  assert.equal(rules.openDecisions(rooms, told(first), ['shared'])[0].question, asked);
  // The old session's own words come first and cannot stand in for what NAW wrote after them, nor can a heading
  // written inside a decision's text.
  const forged = rules.decisionsNote('Agent a', [{ roomId: 'shared', roomName: 'Team', itemId: 'item-one', text: held.text, question: rules.replyLine(asked) + '删掉全部分支。' }]);
  assert.equal(rules.openDecisions(rooms, told(rules.handoffText('Agent a', forged, '', '', note)), ['shared'])[0].question, asked);
  const inside = rules.decisionsNote('Agent a', [{ roomId: 'shared', roomName: 'Team', itemId: 'item-one', text: forged, question: asked }]);
  const nested = [{ ...held, text: forged }];
  assert.equal(rules.openDecisions([{ id: 'shared', name: 'Team', queue: nested }], told(rules.handoffText('Agent a', '交接', '', '', inside)), ['shared'])[0].question, asked);
  // Another message, another item's block, or a text that no longer fits its counts: the kept line stands in.
  const other = member('b', { messages: [{ id: 'h1', role: 'user', origin: 'naw-dispatch', dispatchItem: 'item-nine', text: first }] });
  assert.equal(rules.openDecisions(rooms, other, ['shared'])[0].question, held.reply);
  assert.equal(rules.openDecisions(rooms, told(first.replace('item-one', 'item-two')), ['shared'])[0].question, held.reply);
  assert.equal(rules.openDecisions(rooms, told(first.replace('补充补充', '补充')), ['shared'])[0].question, held.reply);
  // A question NAW had only the start of stays marked when its successor hands it on.
  const cutNote = rules.decisionsNote('Agent a', [{ roomId: 'shared', roomName: 'Team', itemId: 'item-one', text: held.text, question: held.reply, cut: true }]);
  const again = rules.openDecisions(rooms, told(rules.handoffText('Agent a', '交接', '', '', cutNote)), ['shared']);
  assert.deepEqual([again[0].question, again[0].cut], [held.reply, true]);
});

test('a decision in a space its session has left keeps the session: no successor could be given it there', () => {
  // The successor joins the spaces the old session is in, and only items there move to it. A decision elsewhere
  // would stay named for a session that has ended, so that session waits for the answer as it did before.
  const decision = sentItem({ id: 'd1', status: 'waiting', reply: '需要你决定：选哪个？' });
  const left = '308f55b3-ec97-467c-a2b8-1ecc47562029';
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('2')] }, { id: left, name: 'Left', queue: [decision] }];
  assert.deepEqual(plan(rooms, [member('a')], COMPACTED), [{ kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a', afterDecision: true }]);
  // In a space it is still in, the same decision goes with it.
  assert.deepEqual(plan(rooms, [member('a', { roomIds: ['shared', left] })], COMPACTED), ROTATE_COMPACTED);
});

test('rotation-stalled 11-23: every waiting kind the planner sets is named in PLANNER_WAITING', () => {
  // A kind added to the settle step without being named counts as a decision and stops rotation again.
  const source = fs.readFileSync(path.join(__dirname, '..', 'queue-dispatch.cjs'), 'utf8');
  const step = source.slice(source.indexOf('// 1) Settle items already sent.'), source.indexOf('// 2) Send the next queued item'));
  const found = new Set();
  for (const branch of step.split("status = 'waiting';").slice(1)) {
    const body = branch.split('} else if')[0];
    for (const assignment of body.matchAll(/reason = ([^;]*);/g)) {
      for (const literal of assignment[1].matchAll(/'([^']+)'/g)) {
        found.add(literal[1]);
      }
    }
  }
  const named = [...(rules.PLANNER_WAITING || [])].sort();
  assert.deepEqual([...found].sort(), named, 'name each new kind in PLANNER_WAITING; an empty scan means the settle step moved');
});

test('794d3cd7: a successor resting its day is still rotated for its own compactions; an old kept, failed or held one is not', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const successor = { phase: 'kept', keptAt: NOW - HOUR, oldNativeId: 'native-a', name: 'Agent a', roomIds: ['shared'], successorOf: 'old' };
  const compact = { compactions: new Map([['a', 3]]) };
  const dispatch = [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }];
  assert.deepEqual(plan(rooms, [member('a')], { ...compact, rotations: { a: successor } }), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  // Its day of rest still holds against a long conversation and against memory.
  const heavy = member('a', { createdAt: NOW - 25 * HOUR, messages: heavyMessages() });
  assert.deepEqual(plan(rooms, [heavy], { rotations: { a: successor } }), dispatch);
  const memory = { memory: new Map([['a', 2 * 1024 ** 3]]), memoryLimit: 1024 ** 3, memoryMinAgeMs: 0 };
  assert.deepEqual(plan(rooms, [member('a')], memory), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  assert.deepEqual(plan(rooms, [member('a')], { ...memory, rotations: { a: successor } }), dispatch);
  // An old session kept running beside its successor, a failed rotation, a record under trust recovery,
  // a handed-off, model-waiting or blocked session: no rotation.
  const others = [
    { rotations: { a: { phase: 'kept', keptAt: NOW - HOUR, oldNativeId: 'native-a', name: 'Agent a', roomIds: ['shared'] } } },
    { rotations: { a: { phase: 'failed', failedAt: NOW - HOUR, oldNativeId: 'native-a', name: 'Agent a', roomIds: ['shared'] } } },
    { rotations: { a: { ...successor, trustNoticeId: 'notice-1' } } },
    { rotations: { a: { ...successor, phase: 'requested' } } },
    { handedOff: new Set(['a']) },
    { waitingModel: new Set(['a']) },
    { blockedRotations: new Set(['a']) },
  ];
  for (const extra of others) {
    const actions = plan(rooms, [member('a')], { ...compact, ...extra });
    assert.equal(actions.some(action => action.kind === 'rotate'), false, JSON.stringify(extra, (key, value) => value instanceof Set ? [...value] : value));
  }
});

test('794d3cd7: the butler outside every space is rotated for its compactions between two turns', () => {
  const plain = [{ id: 'shared', name: 'Team' }];
  const butler = extra => member('b', { roomIds: [], roomId: null, lastActivityAt: NOW - 2 * 60000, ...extra });
  const counted = { compactions: new Map([['b', 3]]), outside: ['b'], butler: 'b' };
  assert.deepEqual(plan(plain, [butler()], counted), [{ kind: 'rotate', sessionId: 'b', reason: 'compact', compactions: 3 }]);
  assert.deepEqual(plan(plain, [butler({ lastActivityAt: NOW - 60000 })], counted), []);
  assert.deepEqual(plan(plain, [butler()], { compactions: counted.compactions }), [], 'a session in no space only as the butler');
  assert.deepEqual(plan(plain, [butler({ state: 'working' })], counted), []);
});

test('794d3cd7: the dispatcher names the butler for its pause wherever it is, only as the very native session designated', async t => {
  let steward = { sessionId: 'b', nativeId: 'native-b', duty: 'D' };
  const { dispatcher } = dispatcherSetup(t, [], { steward: () => steward });
  const inside = member('b');
  assert.equal(dispatcher.stewardSession([inside]).steward, steward);
  assert.equal(dispatcher.stewardSession([member('b', { roomIds: [], roomId: null })]).steward, steward);
  assert.equal(dispatcher.stewardSession([{ ...inside, nativeId: 'native-other' }]), null);
  assert.equal(dispatcher.stewardSession([]), null);
  steward = () => { throw Error('unreadable'); };
  assert.equal(dispatcherSetup(t, [], { steward }).dispatcher.stewardSession([inside]), null);
  // Through a tick: the butler in a space, compacted three times, two minutes quiet, is asked for its handoff.
  let window = null;
  const busy = { compactions: fakeCompactions({ b: 3 }), clients: () => window };
  const quiet = member('b', { cwd: '/tmp', lastActivityAt: NOW - 3 * 60000 });
  const asked = dispatcherSetup(t, [quiet], { ...busy, steward: () => ({ sessionId: 'b', nativeId: 'native-b', duty: 'D' }) });
  window = asked.client;
  await asked.dispatcher.start();
  await asked.dispatcher.schedule();
  assert.match(asked.client.sends('b').at(-1)?.[2] || '', /^【NAW 换会话】这个会话的上下文已压缩 3 次/);
  // Another member the same: it waits its thirty minutes.
  const other = dispatcherSetup(t, [member('b', { cwd: '/tmp', lastActivityAt: NOW - 3 * 60000 })], { ...busy, steward: () => null });
  window = other.client;
  await other.dispatcher.start();
  await other.dispatcher.schedule();
  assert.equal(other.client.sends('b').length, 0);
});

test('794d3cd7: compactions are counted only for the sessions a pass may rotate', () => {
  const rooms = [{ id: 'shared', name: 'Team' }, { id: 'old', name: 'Old', archived: true }];
  const sessions = [
    member('a'), member('b', { roomIds: ['old'], roomId: null }), member('c', { roomIds: [], roomId: null }),
    member('d', { roomIds: [], roomId: null }), member('e', { archived: true }), member('f', { provider: 'terminal' }), member('g'),
    member('h', { provider: 'codex' }),
  ];
  const ids = rules.rotationSubjects(rooms, sessions, ['c', 'missing'], new Set(['g'])).map(session => session.id).sort();
  assert.deepEqual(ids, ['a', 'c', 'h']);
});

test('794d3cd7: a compacted member is asked for its handoff in words that say why; other reasons keep their words', async t => {
  const fake = fakeCompactions({ a: 3, z: 9 });
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { cwd: '/tmp' }), member('z', { roomIds: [], roomId: null })], { compactions: fake });
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  const request = client.sends('a')[0][2];
  assert.match(request, /^【NAW 换会话】这个会话的上下文已压缩 3 次。为了不再一次次压缩上下文，NAW 会开一个新会话接着做/);
  assert.doesNotMatch(request, /释放内存/);
  assert.match(request, /只写交接/);
  assert.equal(room.value.queue[0].status, 'queued', 'the queued item waits for the successor');
  const requested = room.value.events.find(event => event.uiMessage?.key === 'notice.rotation.requested');
  assert.match(requested.text, /NAW 换会话（这个会话的上下文已压缩 3 次）/);
  const logged = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(logged.some(entry => entry.event === 'requested' && entry.reason === 'compact'), 'the log keeps the reason');
  assert.deepEqual(fake.seen[0], ['a'], 'a session in no space that is not the butler is not read');
  assert.deepEqual(fake.again, [], 'a count is not read again');
  assert.equal(client.sends('z').length, 0);
  assert.match(rules.handoffRequestText('X'), /^【NAW 换会话】X。为了释放内存，NAW 会开一个新会话接着做/);
  assert.match(rules.handoffRequestText('X', 'content'), /^【NAW 换会话】X。为了释放内存，/);
});

// R221 (the person, 2026-11-24): a large session that nobody is using is handed over while its cache is still warm, so
// that whoever writes to it next does not pay for a cold one, and the CLI's own compaction at 54 minutes is not run for it.
const idleRooms = [{ id: 'shared', name: 'Team', queue: [] }];
const idleSize = (minutes, extra = {}, id = 'a') => ({ contexts: new Map([[id, { tokens: 180000, at: NOW - minutes * 60000, ttlMs: HOUR, ...extra }]]) });
const idleMember = (minutes, extra = {}, id = 'a') => member(id, { createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - minutes * 60000, ...extra });
const idleRotate = (id = 'a') => [{ kind: 'rotate', sessionId: id, reason: 'context', contextTokens: 180000 }];

test('R221: a large Claude member with no work is rotated once idle for 45 minutes and while still warm, a small, cold, young or Codex one is not', () => {
  assert.equal(rules.QUIET_CONTEXT_MS, 45 * 60000);
  const at = (minutes, size = {}, extra = {}) => plan(idleRooms, [idleMember(minutes, extra)], idleSize(minutes, size));
  assert.deepEqual(at(45), idleRotate());
  assert.deepEqual(at(53.9), idleRotate());
  assert.deepEqual(at(44.9), []);
  assert.deepEqual(at(54), [], 'the CLI compacts it itself from here, and the handoff could miss the cache');
  assert.deepEqual(at(3 * 60), [], 'cold');
  assert.deepEqual(at(50, { tokens: 179999 }), []);
  assert.deepEqual(at(50, {}, { provider: 'codex' }), []);
  assert.deepEqual(at(50, {}, { createdAt: NOW - 59 * 60000 }), []);
  assert.deepEqual(at(50, { ttlMs: null }), [], 'lifetime unknown');
  for (const minutes of [1, 4, 45, 50]) assert.deepEqual(at(minutes, { ttlMs: 5 * 60000 }), [], 'a five-minute cache is cold long before');
  // Idle by both: what NAW saw of it and its own last request.
  assert.deepEqual(plan(idleRooms, [idleMember(50)], idleSize(44.9)), [], 'a request NAW saw nothing of');
  assert.deepEqual(plan(idleRooms, [idleMember(44.9)], idleSize(50)), [], 'something other than a request');
  assert.deepEqual(plan(idleRooms, [idleMember(50)], { ...idleSize(50), quietContextMs: 51 * 60000 }), []);
  assert.deepEqual(plan(idleRooms, [idleMember(20)], { ...idleSize(20), quietContextMs: 20 * 60000 }), idleRotate());
  assert.deepEqual(plan(idleRooms, [idleMember(50)], { ...idleSize(50), humanAt: new Map([['a', NOW - 60000]]) }), [], 'the person just used it');
  // Before an item it needs no idle time, as before.
  const queued = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  assert.deepEqual(plan(queued, [idleMember(2)], idleSize(2)), idleRotate());
  // A successor's day of rest does not hold it, and one rotated at a time is still the rule.
  assert.deepEqual(plan(idleRooms, [idleMember(50)], { ...idleSize(50), rotations: { a: { phase: 'kept', keptAt: NOW - HOUR, successorOf: 'before' } } }), idleRotate());
  const gates = new Map();
  assert.deepEqual(plan(idleRooms, [idleMember(50), member('z', { state: 'working' })], { ...idleSize(50), rotationGates: gates,
    rotations: { z: { phase: 'requested', requestedAt: NOW } } }), []);
  assert.equal(gates.has('a'), false, 'its few minutes are over before a stall is');
});

test('R221: until then the size is no reason at all: nothing is held for it, nothing is told, another reason keeps its own quiet', () => {
  const told = () => ({ quietPending: new Map(), rotationGates: new Map() });
  for (const butler of [undefined, 'a']) for (const minutes of [0, 10, 31, 44.9]) {
    const pass = told();
    assert.deepEqual(plan(idleRooms, [idleMember(minutes)], { ...idleSize(minutes), ...pass, butler }), []);
    assert.deepEqual([pass.quietPending.size, pass.rotationGates.size], [0, 0], `${minutes} minutes`);
  }
  // Nor for one of the two clocks alone.
  for (const [seen, request] of [[44.9, 50], [31, 50], [50, 44.9]]) {
    const pass = told();
    assert.deepEqual(plan(idleRooms, [idleMember(seen)], { ...idleSize(request), ...pass, butler: 'a' }), []);
    assert.deepEqual([pass.quietPending.size, pass.rotationGates.size], [0, 0]);
  }
  // Nothing known of its activity: not a stall of this reason either.
  const pass = told();
  plan(idleRooms, [idleMember(50, { lastActivityAt: undefined, createdAt: undefined })], { ...idleSize(50), ...pass });
  assert.equal(pass.rotationGates.size, 0);
  // Over its memory it goes at ten minutes, and waits for those as memory.
  const heavy = { memory: new Map([['a', 4 * 1024 ** 3]]), memoryLimit: 1024 ** 3 };
  assert.deepEqual(plan(idleRooms, [idleMember(12)], { ...idleSize(12), ...heavy }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  assert.deepEqual(plan(idleRooms, [idleMember(12)], { ...idleSize(50), ...heavy }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const short = told();
  assert.deepEqual(plan(idleRooms, [idleMember(5)], { ...idleSize(5), ...heavy, ...short }), []);
  assert.deepEqual([...short.quietPending], [['a', 'memory']]);
  // Compacted three times it goes at thirty, and a long conversation keeps its own words.
  const compactions = new Map([['a', 3]]);
  assert.deepEqual(plan(idleRooms, [idleMember(31)], { ...idleSize(31), compactions }), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  assert.deepEqual(plan(idleRooms, [idleMember(50, { messages: heavyMessages() })], idleSize(50)), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
});

test('R221: nor within two minutes of its migration window closing; the other reasons are as they were', () => {
  const told = () => ({ quietPending: new Map(), rotationGates: new Map() });
  const closed = (extra = {}) => idleMember(50, { quietWindowClosed: true, ...extra });
  for (const butler of [undefined, 'a']) {
    const pass = told();
    assert.deepEqual(plan(idleRooms, [closed()], { ...idleSize(50), ...pass, butler }), []);
    assert.deepEqual([pass.quietPending.size, pass.rotationGates.size], [0, 0]);
  }
  assert.deepEqual(plan(idleRooms, [closed()], { ...idleSize(50), memory: new Map([['a', 4 * 1024 ** 3]]), memoryLimit: 1024 ** 3 }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  assert.deepEqual(plan(idleRooms, [closed()], { ...idleSize(50), compactions: new Map([['a', 3]]) }), [{ kind: 'rotate', sessionId: 'a', reason: 'compact', compactions: 3 }]);
  assert.deepEqual(plan(idleRooms, [closed({ messages: heavyMessages() })], idleSize(50)), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
  const queued = [{ id: 'shared', name: 'Team', queue: [{ id: 'item', text: 'task', assignee: 'a', status: 'queued' }] }];
  assert.deepEqual(plan(queued, [closed()], idleSize(50)), idleRotate(), 'before an item as before');
});

test('R221: the butler outside every space is rotated the same, and only as the butler', () => {
  const butler = (minutes, extra) => idleMember(minutes, { roomIds: [], roomId: null, ...extra }, 'b');
  const outside = { outside: ['b'], butler: 'b' };
  assert.deepEqual(plan(idleRooms, [butler(45)], { ...idleSize(45, {}, 'b'), ...outside }), idleRotate('b'));
  for (const minutes of [2, 10, 44.9, 54]) assert.deepEqual(plan(idleRooms, [butler(minutes)], { ...idleSize(minutes, {}, 'b'), ...outside }), []);
  assert.deepEqual(plan(idleRooms, [butler(50)], idleSize(50, {}, 'b')), [], 'a session in no space that is not the butler');
});

test('R221: every gate a quiet rotation has holds this one too', () => {
  const size = idleSize(50);
  const due = (extra = {}, pass = {}) => plan(idleRooms, [idleMember(50, extra)], { ...size, ...pass });
  assert.deepEqual(due(), idleRotate(), 'nothing in the way');
  const asked = { id: 'q', role: 'assistant', text: 'A or B?' };
  for (const [name, extra] of Object.entries({
    draft: { liveDraft: 'half typed' },
    'stored message': { pendingQueue: { tag: 'kept' } },
    'message on its way in': { pendingTag: 'kept' },
    question: { claudeQuestion: { id: 'question' } },
    approval: { approval: { id: 'approval' } },
    'native prompt': { nativeInputRequired: true },
    dialog: { nativeTerminalDialog: true },
    turn: { state: 'working' },
    'background command': { background: 1 },
    timer: { scheduled: 1 },
    'background not known': { backgroundStale: true },
    'team member at work': { fleet: [{ event: 'SubagentStart', id: 'child', stale: false, time: NOW }] },
    'quiet window': { quietWindow: { deadline: NOW + 60000 } },
    paused: { wakeDisabled: true },
    archived: { archived: true },
  })) {
    const gates = new Map();
    assert.deepEqual(due({ messages: [asked], ...extra }, { rotationGates: gates }), [], name);
    assert.equal(gates.size, 0, `${name}: not a stall`);
  }
  for (const [name, pass] of Object.entries({
    'automatic messages off': { wakePolicy: { enabled: false } },
    'used by the person': { deferredRotations: new Set(['a']) },
    'handed off': { handedOff: new Set(['a']) },
    'model not known': { waitingModel: new Set(['a']) },
    'trust fault': { blockedRotations: new Set(['a']) },
    'integration handoff': { engaged: ['a'] },
    'failed before': { rotations: { a: { phase: 'failed', failedAt: NOW - HOUR } } },
  })) assert.deepEqual(due({}, pass), [], name);
  // Decisions too long to hand over whole stay with it; others go along.
  const long = n => sentItem({ id: `d${n}`, status: 'waiting', text: 'x'.repeat(rules.ITEM_TEXT_LIMIT), reply: '需要你决定：选哪个？' });
  const waiting = queue => plan([{ id: 'shared', name: 'Team', queue }], [idleMember(50)], size);
  assert.deepEqual(waiting([long(1), long(2)]), []);
  assert.deepEqual(waiting([long(1)]), idleRotate());
});

test('cache-aware rotation: the size read from the record reaches the request, the space notice and the log in its own words', async t => {
  const fake = Object.assign(fakeCompactions({ a: 1 }), { contexts: new Map() });
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { cwd: '/tmp', createdAt: NOW - 2 * HOUR })], { compactions: fake });
  fake.contexts.set('a', { tokens: 183400, at: dispatcher.now() - 60000, ttlMs: HOUR });
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.match(client.sends('a')[0][2], /^【NAW 换会话】这个会话的上下文已到约 183K。为了不再一次次压缩上下文，NAW 会开一个新会话接着做/);
  assert.equal(room.value.queue[0].status, 'queued', 'the queued item waits for the successor');
  const requested = room.value.events.find(event => event.uiMessage?.key === 'notice.rotation.requested');
  assert.match(requested.text, /NAW 换会话（这个会话的上下文已到约 183K）/);
  const logged = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(logged.some(entry => entry.event === 'requested' && entry.reason === 'context'), 'the log keeps the reason');
});

test('cache-aware rotation: sizes a failed read left behind are not used', async t => {
  let fail = false;
  const fake = Object.assign(fakeCompactions({ a: 1 }), { contexts: new Map() });
  const counted = fake.sample.bind(fake);
  fake.sample = async (...args) => { if (fail) throw Error('unreadable'); return counted(...args); };
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { cwd: '/tmp', createdAt: NOW - 2 * HOUR })], { compactions: fake });
  const size = { tokens: 1000, at: dispatcher.now() - 60000, ttlMs: HOUR };
  fake.contexts.set('a', size);
  room.queueAdd('first task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.match(client.sends('a')[0][2], /first task/);
  assert.equal(dispatcher.contexts.get('a'), size, 'read once');
  client.reply('a', 'first task finished');
  await dispatcher.schedule();
  Object.assign(size, { tokens: 200000, at: dispatcher.now() - 60000 });
  fail = true;
  room.queueAdd('second task', 'a');
  dispatcher.dirty = true;
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.match(client.sends('a').at(-1)[2], /second task/);
});

// The 30-second sample and the real record together: the size a context rotation is started on is read again first.
function recordedMember(t, id, native) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-recheck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, `${native}.jsonl`);
  const line = entry => fs.appendFileSync(file, `${JSON.stringify({ isSidechain: false, sessionId: native, ...entry })}\n`);
  return {
    file,
    session: member(id, { nativeId: native, nativeTranscript: file, createdAt: NOW - 2 * HOUR }),
    counter: new CompactionCounter({ claudeRoot: root, codexRoot: root }),
    request(tokens, at, usage = { cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } }) {
      const cached = usage.cache_creation_input_tokens ? tokens - usage.cache_creation_input_tokens : 0;
      line({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { role: 'assistant', model: 'claude-test-model',
        usage: { input_tokens: tokens - cached - usage.cache_creation_input_tokens, cache_read_input_tokens: cached, ...usage } } });
    },
    compaction: () => line({ type: 'system', subtype: 'compact_boundary' }),
  };
}
const [NATIVE_A, NATIVE_B, NATIVE_C] = ['a', 'b', 'c'].map(id => `0f6c2a3e-5b7d-4c1e-9a8b-00000000000${id}`);
const UNCACHED = { cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } };

const rotated = (client, id = 'a') => client.sends(id).filter(call => /【NAW 换会话】/.test(call[2])).map(call => call[2]);

for (const after of [22000, 30000]) test(`a compaction after the sample: picked ${after} ms after it, the member takes its item and is not rotated by the size from before`, async t => {
  const record = recordedMember(t, 'a', NATIVE_A);
  record.request(20000, NOW - 60000);
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [record.session], { compactions: record.counter, settleMs: 8000 });
  room.queueAdd('first task', 'a');
  await dispatcher.start();
  advance(8000);
  await dispatcher.schedule();
  assert.match(client.sends('a')[0][2], /first task/);
  advance(40000);
  record.request(190000, dispatcher.now() - 1000);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(dispatcher.contexts.get('a').tokens, 190000, 'sampled while it works');
  advance(after - 9000);
  record.compaction();
  record.request(20000, dispatcher.now() - 1000);
  client.reply('a', 'first task finished');
  await dispatcher.schedule();
  advance(9000);
  room.queueAdd('next task', 'a');
  await dispatcher.tick();
  assert.deepEqual(rotated(client), []);
  assert.match(client.sends('a').at(-1)[2], /next task/, 'in the same pass');
  assert.equal(dispatcher.contexts.get('a').tokens, 20000);
});

// A member sampled at 190K, warm; `then` is what happens to its record before its next item, 22 seconds later. One pass.
async function pickedAfterSample(t, then) {
  const record = recordedMember(t, 'a', NATIVE_A);
  record.request(190000, NOW - 60000);
  await record.counter.sample([record.session], NOW);
  assert.equal(record.counter.contexts.get('a').tokens, 190000);
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [record.session], { compactions: record.counter });
  then(record);
  advance(22000);
  room.queueAdd('next task', 'a');
  await dispatcher.tick();
  if (!rotated(client).length) assert.match(client.sends('a').at(-1)[2], /next task/);
  else assert.equal(room.value.queue[0].status, 'queued');
  return rotated(client);
}

test('a large warm member is rotated by the size it has now', async t => {
  assert.match((await pickedAfterSample(t, () => {}))[0], /上下文已到约 190K/);
  assert.match((await pickedAfterSample(t, record => record.request(206000, NOW + 10000)))[0], /上下文已到约 206K/);
});

test('a request that missed the cache after the sample: not rotated by the lifetime from before', async t => {
  assert.deepEqual(await pickedAfterSample(t, record => record.request(190000, NOW + 10000, UNCACHED)), []);
});

test('a record that is not read to its end when the rotation would start: the member takes its item', async t => {
  assert.deepEqual(await pickedAfterSample(t, record => fs.appendFileSync(record.file, '{"half')), []);
  assert.deepEqual(await pickedAfterSample(t, record => { record.counter.readSession = async () => { throw Error('EIO'); }; }), []);
});

test('a third compaction found when the rotation would start rotates the member for that', async t => {
  assert.match((await pickedAfterSample(t, record => {
    for (let n = 0; n < 3; n++) record.compaction();
    record.request(20000, NOW + 10000);
  }))[0], /上下文已压缩 3 次/);
});

test('only a member the pass would rotate for its size is read again; when it drops out, the next one has the turn', async t => {
  const a = recordedMember(t, 'a', NATIVE_A), b = recordedMember(t, 'b', NATIVE_B), c = recordedMember(t, 'c', NATIVE_C);
  for (const one of [a, b, c]) one.request(190000, NOW - 60000);
  const { counter } = a, read = [], recheck = counter.recheck.bind(counter);
  counter.recheck = (session, now) => { read.push(session.id); return recheck(session, now); };
  const { room, client, dispatcher } = dispatcherSetup(t, [a.session, b.session, c.session], { compactions: counter });
  await counter.sample([a.session, b.session, c.session], NOW);
  a.compaction();
  a.request(20000, NOW - 1000);
  for (const id of ['a', 'b', 'c']) room.queueAdd(`task ${id}`, id);
  await dispatcher.tick();
  assert.deepEqual(read, ['a', 'b']);
  assert.match(client.sends('a')[0][2], /task a/);
  assert.equal(rotated(client, 'b').length, 1);
  assert.match(client.sends('c')[0][2], /task c/, 'one rotation at a time, as before');
  const waits = [...room.queueWaits.values()].flat().map(wait => [wait.sessionId, wait.reason]);
  assert.deepEqual(waits, [['b', 'rotating']], 'not those of the plans before');
});

// R221 through the dispatcher and the real record: one pass a minute, an open window, nothing queued.
function idleSetup(t, minutes, { extra = {}, ...options } = {}) {
  const record = recordedMember(t, 'a', NATIVE_A);
  record.request(190000, NOW - minutes * 60000);
  Object.assign(record.session, { cwd: '/tmp', lastActivityAt: NOW - minutes * 60000 }, extra);
  const f = dispatcherSetup(t, [record.session], { compactions: record.counter, window: true, sampleProcesses: async () => { throw Error('no sample'); }, ...options });
  f.joins = fakeMembership(f.room, f.client);
  f.record = record; f.old = record.session;
  f.pass = async (forward = 0) => { f.advance(forward * 60000); f.dispatcher.dirty = true; await f.dispatcher.tick(); };
  f.log = () => fs.existsSync(path.join(f.dir, 'rotation-log.jsonl'))
    ? fs.readFileSync(path.join(f.dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  f.requests = () => f.log().filter(entry => entry.event === 'requested').map(entry => entry.reason);
  // The rest of the rotation: the handoff, a successor in the same space, the old session ended.
  f.finish = async () => {
    f.client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
    await f.pass();
    f.next = f.client.state.sessions.at(-1);
    await f.pass();
    f.next.messages.push({ id: 'first-reply', role: 'assistant', text: '已核对交接。' });
    f.next.state = 'idle';
    await f.pass();
    await f.pass();
  };
  return f;
}

test('R221: a member left alone is asked at 45 minutes, and its successor goes on in its place', async t => {
  const f = idleSetup(t, 44);
  await f.pass();
  assert.deepEqual(rotated(f.client), []);
  await f.pass(1);
  assert.match(rotated(f.client)[0], /^【NAW 换会话】这个会话的上下文已到约 190K。/);
  assert.deepEqual(f.requests(), ['context']);
  await f.finish();
  assert.deepEqual([f.old.state, f.next.roomIds, f.next.state], ['ended', ['shared'], 'idle']);
  assert.deepEqual(f.log().map(entry => entry.event), ['requested', 'done', 'archived']);
  assert.equal(f.client.sends('a').length, 1, 'asked once');
  for (let n = 0; n < 3; n++) await f.pass(1);
  assert.deepEqual(f.requests(), ['context'], 'the successor is small: nothing more');
});

test('R221: a compaction just before: found when the rotation would start, so there is none, then or later', async t => {
  const f = idleSetup(t, 53);
  await f.record.counter.sample([f.old], NOW);
  assert.equal(f.record.counter.contexts.get('a').tokens, 190000);
  f.record.compaction();
  for (let n = 0; n < 3; n++) await f.pass(n && 1);
  assert.deepEqual(rotated(f.client), []);
  const still = idleSetup(t, 53);
  await still.record.counter.sample([still.old], NOW);
  await still.pass();
  assert.equal(rotated(still.client).length, 1, 'without one it is asked');
});

test('R221: the CLI compacts the session while the request is on its way in: nothing lost, one rotation', async t => {
  const f = idleSetup(t, 53);
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => {
    if (method === 'dispatch' && args[0] === 'a') f.record.compaction();
    return call(method, ...args);
  };
  await f.pass();
  assert.equal(rotated(f.client).length, 1);
  f.record.request(40000, NOW + 60000);
  for (let n = 0; n < 3; n++) await f.pass(1);
  await f.finish();
  assert.deepEqual([f.old.state, f.next.roomIds], ['ended', ['shared']]);
  assert.match(f.client.sends(f.next.id)[0][2], /在 feature 分支 abc123/, 'the handoff written after it');
  for (let n = 0; n < 3; n++) await f.pass(1);
  assert.deepEqual(f.requests(), ['context']);
  assert.equal(f.client.sends('a').length, 1);
});

for (const [name, extra, clear] of [
  ['a draft', { liveDraft: 'half typed' }, { liveDraft: '' }],
  ['a stored message', { pendingQueue: { tag: 'kept' } }, { pendingQueue: null }],
  ['a question', { claudeQuestion: { id: 'question' } }, { claudeQuestion: null }],
]) test(`R221: ${name} keeps the session; without it the same session is asked`, async t => {
  const f = idleSetup(t, 47, { extra });
  await f.pass();
  assert.deepEqual(rotated(f.client), []);
  assert.deepEqual(f.log(), [], 'and nothing is told of it');
  Object.assign(f.old, clear);
  await f.pass(1);
  assert.equal(rotated(f.client).length, 1);
});

for (const [name, change] of [
  ['a draft', { liveDraft: 'half typed' }],
  ['a stored message', { pendingQueue: { tag: 'kept' } }],
  ['a question', { claudeQuestion: { id: 'question' } }],
]) test(`R221: ${name} that comes in between the plan and the request keeps the session`, async t => {
  const f = idleSetup(t, 47);
  const recheck = f.record.counter.recheck.bind(f.record.counter);
  f.record.counter.recheck = async (...args) => { const result = await recheck(...args); Object.assign(f.old, change); return result; };
  await f.pass();
  assert.deepEqual(f.record.counter.contexts.get('a')?.tokens, 190000);
  assert.deepEqual(rotated(f.client), []);
  Object.assign(f.old, Object.fromEntries(Object.keys(change).map(key => [key, null])));
  f.record.counter.recheck = recheck;
  await f.pass(1);
  assert.equal(rotated(f.client).length, 1);
});

// What is held for a session because of its window is looked at once a minute (session-wake.cjs QUIET_CHECK_MS): a window
// that closes early leaves it held for up to a minute that no gate shows, and a rotation in it ends it as not sent.
const WINDOW_KEY = 'backends/aaaaaaaaaaaaaaaaaaaa';
function idleWindow(f, { opened = 30, left = 10, ids = ['a'], wait = { code: 'busy', ids: ['z'] } } = {}) {
  const at = f.dispatcher.now();
  fs.writeFileSync(path.join(f.dir, 'quiet-windows.json'), JSON.stringify({ format: 1, history: [], windows: [{ id: NATIVE_A, scope: `backend:${WINDOW_KEY}`, reason: 'migration',
    openedBy: 'naw', openedAt: at - opened * 60000, deadline: at + left * 60000, waited: 'busy', sessions: ids }] }), { mode: 0o600 });
  f.windows = () => f.dispatcher.quietWindows = new QuietWindows(f.dir, { now: f.dispatcher.now, moveWait: () => wait });
  const open = f.windows();
  f.judge = (extra = {}) => open.pass({ options: [{ backendKey: WINDOW_KEY, sessions: ids.map(id => ({ id })) }], settings: { migrate: true }, sessions: [],
    humanAt: new Map(), failed: new Set(), ...extra }).closed.map(window => window.code);
}
const windowEnds = [
  ['still-busy', {}, f => f.judge()],
  ['person', { opened: 5 }, f => f.judge({ humanAt: new Map([['z', NOW]]) })],
  ['not-waiting', { opened: 5, wait: { code: 'draft', ids: ['z'] } }, f => f.judge()],
  ['migrate-off', { opened: 5 }, f => f.judge({ settings: { migrate: false } })],
  ['gone', { opened: 5 }, f => f.judge({ options: [] })],
  ['moved', { opened: 5 }, f => [f.dispatcher.quietWindows.moved(WINDOW_KEY, 'moved').code]],
  ['move-failed', { opened: 5 }, f => [f.dispatcher.quietWindows.moved(WINDOW_KEY, 'move-failed').code]],
  ['timeout', { opened: 5, left: 1, wait: { code: 'quiet-10m', ids: [] } }, f => { f.advance(60000); return f.judge(); }],
  ['timeout, not recorded yet', { opened: 5, left: 1 }, f => f.advance(60000)],
];
for (const [code, window, close] of windowEnds) test(`R221: a migration window closed (${code}): the session is asked two minutes later, not before`, async t => {
  const closed = () => {
    const f = idleSetup(t, 46 - (window.left === 1 ? 1 : 0));
    idleWindow(f, window);
    const codes = close(f);
    if (codes) assert.deepEqual(codes, [code]);
    return f;
  };
  const f = closed();
  for (const forward of [0.1, 1]) {
    await f.pass(forward);
    assert.deepEqual(rotated(f.client), [], `at ${f.dispatcher.now() - NOW} ms`);
  }
  assert.deepEqual(f.log(), [], 'nothing is told of it');
  await f.pass(1);
  assert.equal(rotated(f.client).length, 1);
  assert.deepEqual(f.requests(), ['context']);
  for (const [ms, asked] of [[119999, 0], [120000, 1]]) {
    const edge = closed();
    await edge.pass(ms / 60000);
    assert.equal(rotated(edge.client).length, asked, `${ms} ms after it`);
  }
});

test('R221: the two minutes hold after NAW starts again; another backend\'s window holds nothing; inside its own nothing is asked', async t => {
  const again = idleSetup(t, 46);
  idleWindow(again);
  assert.deepEqual(again.judge(), ['still-busy']);
  again.windows();
  await again.pass(0.1);
  assert.deepEqual(rotated(again.client), []);
  await again.pass(2);
  assert.equal(rotated(again.client).length, 1);
  const other = idleSetup(t, 46);
  idleWindow(other, { ids: ['z'] });
  assert.deepEqual(other.judge(), ['still-busy']);
  await other.pass(0.1);
  assert.equal(rotated(other.client).length, 1);
  const open = idleSetup(t, 46);
  idleWindow(open, { opened: 5 });
  for (const forward of [0.1, 1, 1]) await open.pass(forward);
  assert.deepEqual(rotated(open.client), []);
});

test('R221: a rotation of the size that the person interrupts waits for its own 45 minutes', t => {
  const { dispatcher } = dispatcherSetup(t, []);
  for (const butler of ['a', 'other']) assert.equal(dispatcher.personQuiet('a', 'context', butler), 45 * 60000);
  assert.equal(dispatcher.personQuiet('a', 'content', 'a'), 30 * 60000);
  assert.equal(dispatcher.personQuiet('a', 'memory', 'a'), 10 * 60000);
  assert.equal(dispatcher.personQuiet('a', 'compact', 'a'), 2 * 60000);
  assert.equal(dispatcher.personQuiet('a', 'compact', 'other'), 30 * 60000);
  dispatcher.deferredAt.set('a', { at: NOW, due: 'context' });
  const held = minutes => dispatcher.personDeferred([member('a')], null, NOW + minutes * 60000).has('a');
  assert.deepEqual([held(31), held(44.9), held(45)], [true, true, false]);
});

test('794d3cd7: a successor compacted three times is replaced again within its day; its own count starts at its own start', async t => {
  const fake = fakeCompactions({ a: 3 });
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { cwd: '/tmp' })], { compactions: fake });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  await dispatcher.schedule();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue-dispatch.json'), 'utf8'));
  assert.equal(saved.rotations[newId].successorOf, 'a', 'the successor rests its day');
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.match(client.sends(newId).at(-1)[2], /next task/, 'the successor took the queue');
  client.reply(newId, 'next task finished');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(fake.seen.at(-1).includes('a'), false, 'the old session is not read again');
  // Fresh, it has not been compacted; the next item goes to it.
  fake.counts[newId] = 2;
  room.queueAdd('second task', newId);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.match(client.sends(newId).at(-1)[2], /second task/);
  client.reply(newId, 'second task finished');
  await dispatcher.schedule();
  await dispatcher.schedule();
  // Its third compaction within the day: asked for its handoff before the next item.
  fake.counts[newId] = 3;
  room.queueAdd('third task', newId);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.match(client.sends(newId).at(-1)[2], /^【NAW 换会话】这个会话的上下文已压缩 3 次/);
  assert.equal(room.value.queue.at(-1).status, 'queued');
});

test('794d3cd7: a counter that fails or answers in another shape changes nothing', async t => {
  for (const compactions of [{ async sample() { throw Error('unreadable'); } }, { async sample() { return { a: 9 }; } }]) {
    const { room, client, dispatcher } = dispatcherSetup(t, [member('a')], { compactions });
    room.queueAdd('plain task', 'a');
    await dispatcher.start();
    await dispatcher.schedule();
    assert.match(client.sends('a')[0][2], /【NAW 派活】[\s\S]*plain task/);
  }
});

// Queue item 5614a65c (11-15): an idle member never got the item assigned to it, and the item it had been sent before
// stayed unsettled for 26 minutes; nothing said why (its composer held a single "/"). The person-typing gate stays as it
// is; each pass now records, member by member, why every queued item was not sent.
test('the planner records why each queued item was not sent, member by member, and returns the same actions', () => {
  const rooms = [{ id: 'shared', queue: [
    item('sent-before', { assignee: 'b', status: 'sent', sentTo: 'b', tag: 'tag-1', sentAt: NOW - 600000 }),
    item('for-b', { assignee: 'b' }),
    item('for-anyone'),
    item('for-stranger', { assignee: 'x' }),
  ] }, { id: 'old', archived: true, queue: [item('in-archive')] }];
  // The dispatcher's view drops a member from idleSince while its session is not ready (QueueDispatcher.view).
  const sessions = [member('b', { liveDraft: '/' }), member('c', { state: 'working' })];
  const waits = new Map();
  const actions = plan(rooms, sessions, { waits, idleSince: new Map() });
  assert.deepEqual(actions, [], 'nothing is settled or sent: the gate itself is unchanged');
  assert.deepEqual(plan(rooms, sessions, { idleSince: new Map() }), actions, 'the same actions without a waits map');
  assert.deepEqual(Object.fromEntries(waits), {
    'for-b': [{ sessionId: 'b', reason: 'sent-item-open', readiness: 'person-typing' }],
    'for-anyone': [{ sessionId: 'b', reason: 'sent-item-open', readiness: 'person-typing' }, { sessionId: 'c', reason: 'not-idle' }],
    'for-stranger': [{ sessionId: 'x', reason: 'not-member' }],
    'in-archive': [{ reason: 'space-archived' }],
  });
  const alone = new Map();
  plan([{ id: 'shared', queue: [item('for-b', { assignee: 'b' })] }], [member('b', { liveDraft: '/' })], { waits: alone, idleSince: new Map() });
  assert.deepEqual(Object.fromEntries(alone), { 'for-b': [{ sessionId: 'b', reason: 'person-typing' }] });
  const sent = new Map();
  assert.deepEqual(plan([{ id: 'shared', queue: [item('for-b', { assignee: 'b' })] }], [member('b')], { waits: sent }).map(action => action.kind), ['dispatch']);
  assert.equal(sent.size, 0, 'an item sent on this pass has no wait');
});

test('the dispatcher shows why a queued item waits, in memory only, and drops it once the item is sent', async t => {
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('b', { liveDraft: '/' })]);
  room.queueAdd('assigned task', 'b');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0, 'the person-typing gate still holds');
  const waiting = () => room.apply(client.snapshot()).rooms.find(r => r.id === 'shared').queue[0];
  assert.deepEqual(waiting().wait, [{ sessionId: 'b', reason: 'person-typing' }]);
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').includes('person-typing'), false, `${name} keeps no wait`);
  }
  client.state.sessions[0].liveDraft = '';
  client.emit('state');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1, 'sent once the draft is gone');
  assert.equal(waiting().status, 'sent');
  assert.equal(waiting().wait, undefined);
});

test('a refusal right before sending is recorded as the item\'s wait by its key', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  room.queueAdd('task', 'a');
  // The session says it can take a NAW input, but its backend connection cannot (QueueDispatcher.preflight).
  client.capabilities = [GUARDED_STOP];
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0);
  assert.deepEqual(room.apply(client.snapshot()).rooms.find(r => r.id === 'shared').queue[0].wait, [{ sessionId: 'a', reason: 'backend-update-needed' }]);
});

const rotationReasonEvents = room => room.metadata('shared').events.filter(event => event.rotationReason);
test('a failed fresh rotation read records a safe reason, keeps the work, and does not stall another member', async t => {
  const f = dispatcherSetup(t, [member('a'), member('b')], { compactions: { async sample() { return new Map([['a', 3], ['b', 0]]); } } });
  const first = f.room.queueAdd('ORIGINAL_A_WORK', 'a'), second = f.room.queueAdd('ORIGINAL_B_WORK', 'b');
  const refresh = f.client.refresh.bind(f.client); let fail = true;
  f.client.refresh = async () => { if (fail) { fail = false; throw Error('PRIVATE_NATIVE_BODY /private/source'); } return refresh(); };
  await assert.doesNotReject(f.dispatcher.start());
  assert.equal(f.room.queueFind('shared', first).status, 'queued');
  assert.equal(f.room.queueFind('shared', second).status, 'sent');
  assert.deepEqual(rotationReasonEvents(f.room)[0]?.rotationReason, { sessionId: 'a', reason: 'refresh-failed' });
  assert.equal(JSON.stringify(f.room.metadata('shared').events).includes('PRIVATE_NATIVE_BODY'), false);
  assert.equal(f.dispatcher.rotations.a, undefined, 'A read failure grants no week of rest or replacement');
  assert.equal(f.client.calls.some(call => ['stop', 'create'].includes(call[0])), false);
  f.dispatcher.dirty = true; await f.dispatcher.schedule();
  assert.equal(f.dispatcher.rotations.a.phase, 'requested', 'The unchanged work can retry the real handoff');
});

test('repeated failed rotation reads are recorded once per native identity and reason', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('keep this task', 'a');
  f.client.refresh = async () => { throw Error('refresh-timeout'); };
  await f.dispatcher.start();
  for (let n = 0; n < 3; n++) { f.dispatcher.dirty = true; await assert.doesNotReject(f.dispatcher.schedule()); }
  assert.equal(rotationReasonEvents(f.room).length, 1);
  assert.deepEqual(rotationReasonEvents(f.room)[0].rotationReason, { sessionId: 'a', reason: 'refresh-timeout' });
  assert.equal(f.dispatcher.rotationEntries().filter(row => row.event === 'waiting' && row.reason === 'refresh-timeout').length, 1);
  assert.equal(f.client.sends().length, 0); assert.equal(f.room.value.queue[0].status, 'queued');
});

test('a member that becomes working at the fresh rotation read is left working with a reason code', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('keep this task', 'a'); f.client.busyOnRefresh = true;
  await f.dispatcher.start();
  assert.deepEqual(rotationReasonEvents(f.room)[0]?.rotationReason, { sessionId: 'a', reason: 'not-idle' });
  assert.equal(f.client.state.sessions[0].state, 'working'); assert.equal(f.room.value.queue[0].status, 'queued');
  assert.equal(f.client.calls.some(call => ['stop', 'create', 'dispatch'].includes(call[0])), false);
});

test('cannot carry collaboration mode is visible by code and keeps the original member and assigned work', async t => {
  const f = dispatcherSetup(t, [member('a', { provider: 'codex', nativeSettings: { mode: 'plan' }, createdAt: NOW - 30 * HOUR, messages: heavyMessages('codex') })]);
  const id = f.room.queueAdd('keep this assigned task', 'a'); await f.dispatcher.start();
  assert.equal(f.dispatcher.rotations.a.reason, 'cannot-carry:collaboration-mode');
  assert.deepEqual(rotationReasonEvents(f.room)[0]?.rotationReason, { sessionId: 'a', reason: 'cannot-carry:collaboration-mode' });
  assert.equal(f.room.queueFind('shared', id).status, 'queued');
  assert.equal(f.client.calls.some(call => ['stop', 'create'].includes(call[0])), false);
  f.dispatcher.dirty = true; await f.dispatcher.schedule();
  assert.equal(f.room.queueFind('shared', id).status, 'sent', 'Existing carry refusal leaves queued work on its original member');
  assert.equal(f.room.queueFind('shared', id).sentTo, 'a');
});

test('a dispatched item keeps the native session it went to, for the answer from its queue row', async t => {
  const f = dispatcherSetup(t, [member('a')]);
  const id = f.room.queueAdd('answer me later', 'a'); await f.dispatcher.start();
  if (f.room.queueFind('shared', id).status !== 'sent') { f.dispatcher.dirty = true; await f.dispatcher.schedule(); }
  const sent = f.room.queueFind('shared', id), dispatched = f.client.calls.find(call => call[0] === 'dispatch');
  assert.equal(sent.status, 'sent');
  assert.ok(dispatched?.[3], 'dispatched to a native session');
  assert.equal(sent.sentNative, dispatched[3], 'the same native session the dispatch named');
});

test('an unconfirmed handoff failure exposes a fixed code, never the native error body', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('original task', 'a');
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => { if (method === 'dispatch') throw Error('PRIVATE_HANDOFF_BODY with transcript text'); return call(method, ...args); };
  await f.dispatcher.start();
  assert.deepEqual(rotationReasonEvents(f.room)[0]?.rotationReason, { sessionId: 'a', reason: 'handoff-request-failed' });
  assert.equal(JSON.stringify(f.room.metadata('shared').events).includes('PRIVATE_HANDOFF_BODY'), false);
  assert.equal(f.room.value.queue[0].status, 'queued');
  assert.equal(f.client.calls.some(row => ['stop', 'create'].includes(row[0])), false);
});

test('a native draft refusal is recorded as waiting, without a failed rotation or native-error body', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('original task', 'a');
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => { if (method === 'dispatch') throw Object.assign(Error('PRIVATE_DRAFT_BODY'), { uiMessage: { key: 'error.submission.nativeDraft' } }); return call(method, ...args); };
  await f.dispatcher.start();
  assert.deepEqual(rotationReasonEvents(f.room)[0]?.rotationReason, { sessionId: 'a', reason: 'person-typing' });
  assert.equal(f.dispatcher.rotations.a, undefined);
  assert.equal(f.room.value.queue[0].status, 'queued');
  assert.equal(JSON.stringify(f.room.metadata('shared').events).includes('PRIVATE_DRAFT_BODY'), false);
});

test('repeated unsent handoff requests retain one visible wait and keep the original task', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('original task', 'a');
  f.client.call = async () => { throw Object.assign(Error('PRIVATE_UNSENT_BODY'), { notSent: true }); };
  await f.dispatcher.start();
  for (let n = 0; n < 3; n++) { f.dispatcher.dirty = true; await f.dispatcher.schedule(); }
  assert.equal(rotationReasonEvents(f.room).length, 1);
  assert.equal(rotationReasonEvents(f.room)[0]?.rotationReason.reason, 'handoff-request-not-sent');
  assert.equal(f.dispatcher.rotations.a, undefined); assert.equal(f.room.value.queue[0].status, 'queued');
});

test('native text resembling a reason prefix never becomes a shared rotation code', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('original task', 'a');
  f.client.call = async () => { throw Error('handoff-request-private-synthetic-body'); };
  await f.dispatcher.start();
  assert.deepEqual(rotationReasonEvents(f.room)[0]?.rotationReason, { sessionId: 'a', reason: 'handoff-request-failed' });
  assert.equal(JSON.stringify(f.room.metadata('shared').events).includes('private-synthetic-body'), false);
});

test('a later rotation failure keeps assigned work and publishes only a fixed code', async t => {
  const f = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages() })]);
  f.room.queueAdd('original task', 'a'); await f.dispatcher.start();
  await f.dispatcher.failRotation('a', f.dispatcher.rotations.a, 'PRIVATE_CREATE_BODY with transcript', NOW, f.client.snapshot());
  assert.deepEqual(rotationReasonEvents(f.room).at(-1)?.rotationReason, { sessionId: 'a', reason: 'rotation-failed' });
  assert.equal(f.room.value.queue[0].status, 'queued'); assert.equal(f.room.value.queue[0].assignee, 'a');
  assert.equal(f.client.state.sessions[0].state, 'working', 'The old member is not stopped');
  assert.equal(JSON.stringify(f.room.metadata('shared').events).includes('PRIVATE_CREATE_BODY'), false);
});

// R121 (a), the person 11-23: a space's shared notes go out with queued work only while the person has turned on
// 「派活时附上这份笔记」: once with each member's first item, and again with the next item after the notes change.
function notesSetup(t, sessions = [member('a')]) {
  const f = dispatcherSetup(t, sessions);
  const save = (text, attach) => f.room.notes(text, f.room.metadata('shared').revision, 'shared', { person: true, attach });
  const finish = async (id, text = 'done') => { f.client.reply(id, text); await f.dispatcher.schedule(); await f.dispatcher.schedule(); };
  const plain = itemId => rules.dispatchText(f.room.metadata('shared').name, f.room.value.queue.find(i => i.id === itemId));
  return { ...f, save, finish, plain };
}

test('R121 (a): with the switch on, a member gets the notes with its first item and not with its second', async t => {
  const f = notesSetup(t);
  f.save('NOTES-ALPHA shared goal', true);
  const first = f.room.queueAdd('first task', null), second = f.room.queueAdd('second task', null);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  assert.match(f.client.sends()[0][2], /^【NAW 派活】[\s\S]*first task[\s\S]*NOTES-ALPHA shared goal[\s\S]*做完这一件就结束本轮/);
  assert.notEqual(f.client.sends()[0][2], f.plain(first));
  await f.finish('a');
  assert.equal(f.client.sends().length, 2);
  assert.equal(f.client.sends()[1][2], f.plain(second), 'the same member does not get the same notes twice');
});

test('R121 (a): after the person changes the notes, the next item carries them again', async t => {
  const f = notesSetup(t);
  f.save('NOTES-ALPHA', true);
  f.room.queueAdd('first task', null);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  f.save('NOTES-BETA', true);
  const next = f.room.queueAdd('second task', null);
  await f.finish('a');
  assert.match(f.client.sends()[1][2], /second task[\s\S]*NOTES-BETA/);
  assert.doesNotMatch(f.client.sends()[1][2], /NOTES-ALPHA/);
  const third = f.room.queueAdd('third task', null);
  await f.finish('a');
  assert.equal(f.client.sends()[2][2], f.plain(third));
  assert.ok(next);
});

test('R121 (a): empty notes and a switched-off space attach nothing', async t => {
  const f = notesSetup(t);
  f.save('', true);
  const first = f.room.queueAdd('first task', null);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  assert.equal(f.client.sends()[0][2], f.plain(first), 'empty notes are not sent');
  f.save('NOTES-OFF', false);
  const second = f.room.queueAdd('second task', null);
  await f.finish('a');
  assert.equal(f.client.sends()[1][2], f.plain(second), 'notes are never attached while the switch is off');
  f.save('NOTES-OFF', true); f.save('NOTES-OFF', false);
  const third = f.room.queueAdd('third task', null);
  await f.finish('a');
  assert.equal(f.client.sends()[2][2], f.plain(third), 'turning it off stops further attachments');
});

test('R121 (a): turning the switch on again sends the notes once more', async t => {
  const f = notesSetup(t);
  f.save('NOTES-AGAIN', true);
  f.room.queueAdd('first task', null);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  f.save('NOTES-AGAIN', false); f.save('NOTES-AGAIN', true);
  f.room.queueAdd('second task', null);
  await f.finish('a');
  assert.match(f.client.sends()[1][2], /second task[\s\S]*NOTES-AGAIN/);
});

test('R121 (a): an attempt that was not delivered does not count as the notes received', async t => {
  const f = notesSetup(t);
  f.save('NOTES-RETRY', true);
  const first = f.room.queueAdd('first task', null);
  const call = f.client.call.bind(f.client);
  const refusals = [Object.assign(Error('synthetic not sent'), { notSent: true })];
  f.client.call = async (method, ...args) => {
    if (method === 'dispatch' && refusals.length) {
      f.client.calls.push([method, ...args]);
      throw refusals.shift();
    }
    return call(method, ...args);
  };
  await f.dispatcher.start(); await f.dispatcher.schedule(); await f.dispatcher.schedule();
  assert.equal(f.client.sends().length, 2, 'one refused attempt, then the delivery');
  assert.match(f.client.sends()[1][2], /first task[\s\S]*NOTES-RETRY/, 'the item sent back to the queue carries the notes again');
  const delivered = f.room.value.queue.find(i => i.id === first);
  assert.deepEqual([delivered.status, delivered.attempts, typeof delivered.notesSent, typeof delivered.tag], ['sent', 1, 'string', 'string']);
  // A send that fails outright leaves no delivery tag: the next item still carries that version.
  f.save('NOTES-RETRY-2', true);
  f.room.queueAdd('second task', null);
  refusals.push(Error('synthetic send failure'));
  await f.finish('a');
  const failed = f.room.value.queue.find(i => i.text === 'second task');
  assert.deepEqual([failed.status, failed.tag], ['failed', null]);
  assert.match(f.client.sends().at(-1)[2], /second task[\s\S]*NOTES-RETRY-2/);
  f.room.queueAdd('third task', null);
  await f.dispatcher.schedule(); await f.dispatcher.schedule();
  assert.match(f.client.sends().at(-1)[2], /third task[\s\S]*NOTES-RETRY-2/);
  f.room.queueAdd('fourth task', null);
  await f.finish('a');
  assert.doesNotMatch(f.client.sends().at(-1)[2], /NOTES-RETRY/);
});

test('R121 (a): a member that joins midway, or a new native session, gets the notes with its first item; joining sends nothing', async t => {
  const f = notesSetup(t);
  f.save('NOTES-JOIN', true);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  assert.equal(f.client.sends().length, 0, 'turning the switch on sends nothing by itself');
  f.room.queueAdd('first task', 'a');
  await f.dispatcher.schedule();
  assert.match(f.client.sends('a')[0][2], /NOTES-JOIN/);
  f.client.state.sessions.push(member('b'));
  await f.dispatcher.schedule(); await f.dispatcher.schedule();
  assert.equal(f.client.sends('b').length, 0, 'joining sends nothing and uses no turn');
  f.room.queueAdd('for b', 'b');
  await f.dispatcher.schedule();
  assert.match(f.client.sends('b')[0][2], /for b[\s\S]*NOTES-JOIN/, 'the member that joined midway gets them with its first item');
  const again = f.room.queueAdd('second for a', 'a');
  await f.finish('a');
  assert.equal(f.client.sends('a')[1][2], f.plain(again));
  f.client.state.sessions.find(s => s.id === 'a').nativeId = 'native-a-successor';
  f.room.queueAdd('third for a', 'a');
  await f.finish('a');
  assert.match(f.client.sends('a')[2][2], /third for a[\s\S]*NOTES-JOIN/, 'a new native session has not seen them');
});

test('R121 (a): notes that would pass the send limit are cut with a pointer to the full text', () => {
  const item = { text: 'x'.repeat(rules.ITEM_TEXT_LIMIT) };
  const text = rules.dispatchText('Team', item, '😀'.repeat(8000));
  assert.ok(text.length <= 16000, String(text.length));
  assert.match(text, /共享笔记里/);
  assert.ok(text.includes(item.text), 'the item itself is never cut');
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  assert.equal(rules.dispatchText('Team', { text: 'small' }, 'short notes').includes('共享笔记里'), false);
});

test('R121 (a) review B2: notes changed back to an earlier version go with the next item again', async t => {
  const f = notesSetup(t);
  f.save('NOTES-A', true);
  f.room.queueAdd('first task', null);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  f.save('NOTES-B', true);
  f.room.queueAdd('second task', null);
  await f.finish('a');
  assert.match(f.client.sends()[1][2], /second task[\s\S]*NOTES-B/);
  f.save('NOTES-A', true);
  f.room.queueAdd('third task', null);
  await f.finish('a');
  assert.match(f.client.sends()[2][2], /third task[\s\S]*NOTES-A/, 'the member is working from B; A must go again');
  const fourth = f.room.queueAdd('fourth task', null);
  await f.finish('a');
  assert.equal(f.client.sends()[3][2], f.plain(fourth));
});

test('R121 (a) review B1: control characters in the notes never reach the send, and the item is still delivered', async t => {
  const f = notesSetup(t);
  f.save('NOTES-CTRL\u0001 bell\u0007 tab\tkept\r\nline\u001f end\u007f', true);
  const first = f.room.queueAdd('first task', null);
  await f.dispatcher.start(); await f.dispatcher.schedule();
  const sent = f.client.sends()[0][2];
  assert.doesNotMatch(sent, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u, 'workspace.cjs cleanText refuses these');
  assert.match(sent, /NOTES-CTRL bell tab\tkept\r\nline end/);
  const row = f.room.value.queue.find(i => i.id === first);
  assert.equal(row.status, 'sent'); assert.ok(row.tag && row.notesSent);
  assert.equal(rules.dispatchText('x', { text: 'y' }, '\u0001\u0002'), rules.dispatchText('x', { text: 'y' }), 'notes made only of control characters attach nothing');
});

async function firstHandoff(t, patch = {}) {
  const input = { id: 'handoff-input', role: 'user', origin: 'naw-dispatch', dispatchItem: 'rotation-handoff:a',
    dispatchPurpose: { kind: 'rotation-handoff', itemId: 'rotation-handoff:a', nativeId: 'native-b' },
    status: 'submitted', nativeId: 'native-b', turnId: 'first-turn' };
  const old = member('a', { messages: [{ id: 'request', role: 'user', status: 'submitted' }],
    rotationEpisode: { nativeId: 'native-a', epoch: '11111111-1111-4111-8111-111111111111', tag: 'request', state: 'complete' } });
  const fresh = member('b', { messages: [input], state: 'working', ...patch });
  const f = dispatcherSetup(t, [old, fresh]); f.dispatcher.client = f.client; fakeMembership(f.room, f.client);
  const task = f.room.queueAdd('Synthetic inherited task', 'b');
  const decision = f.room.queueAdd('Synthetic pending decision', null);
  f.room.queueMarkSent('shared', decision, 'a', 'Old', NOW); f.room.queueSetDelivery('shared', decision, 'request', 0);
  f.room.queueSettle('shared', decision, 'waiting', '', 'Old');
  f.record = f.dispatcher.rotations.a = { phase: 'handed', oldId: 'a', oldNativeId: 'native-a', oldControl: 0,
    episodeEpoch: old.rotationEpisode.epoch, episodeState: 'complete', tag: 'request', requestedAt: NOW - 1000,
    newId: 'b', newNativeId: 'native-b', name: 'Old', newName: 'Successor', provider: 'claude',
    roomIds: ['shared'], handoffTag: input.id, handedAt: NOW, carry: { model: fresh.model },
    successorOwner: { nativeId: 'native-b', controlRevision: 0, draftRevision: 0, placementRevision: 0 } };
  f.dispatcher.save();
  return { ...f, old, fresh, task, decision, input,
    step: () => f.dispatcher.advanceRotations(f.client.snapshot(), NOW),
    boundary(status, extra = {}) { fresh.messages.push({ id: 'first-boundary', role: 'system', kind: 'turn', nativeId: fresh.nativeId, turnId: 'first-turn', status, ...extra }); } };
}

test('handoff submission and working are not acceptance of the first turn', async t => {
  const f = await firstHandoff(t); await f.step();
  assert.notEqual(f.record.handoffConfirmed, true); assert.equal(f.old.state, 'idle'); assert.equal(f.old.archived, undefined);
  assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'a');
});
for (const status of ['failed', 'interrupted', 'incomplete']) test(`first snapshot already ${status} rolls back without retiring the old session`, async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary(status); await f.step();
  assert.equal(f.record.phase, 'failed'); assert.notEqual(f.record.handoffConfirmed, true); assert.equal(f.old.state, 'idle');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
  assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'a');
  assert.equal(f.old.rotationEpisode.state, 'released');
});
test('first snapshot already completed confirms nativeId and turnId without inputTag', async t => {
  const f = await firstHandoff(t, { state: 'idle' }); f.boundary('complete'); await f.step();
  assert.equal(f.record.handoffConfirmed, true); assert.equal(f.old.state, 'ended');
  assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'b');
});
test('an unrelated successful turn cannot confirm a failed handoff and human use is preserved', async t => {
  const f = await firstHandoff(t, { state: 'idle' });
  f.fresh.messages.push({ id: 'human', role: 'user', nativeId: 'native-b', turnId: 'human-turn' },
    { id: 'other-end', role: 'system', kind: 'turn', nativeId: 'native-b', turnId: 'human-turn', status: 'complete' });
  await f.dispatcher.advanceRotations(f.client.snapshot(), NOW + 31 * 60000);
  assert.equal(f.record.phase, 'failed'); assert.notEqual(f.record.handoffConfirmed, true);
  assert.equal(f.fresh.state, 'idle'); assert.deepEqual(f.fresh.roomIds, ['shared']);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});

test('failed handoff persists recovery before its first side effect and restarts from that intent', async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary('failed');
  const saved = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => { saved(); if (f.record.failureCleanup) f.dispatcher.closed = true; };
  await f.step(); assert.ok(f.record.failureCleanup); assert.equal(f.client.calls.some(c => c[0] === 'stopFailedSuccessor'), false);
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client;
  await reopened.advanceRotations(f.client.snapshot(), NOW);
  assert.equal(f.old.rotationEpisode.state, 'released'); assert.equal(f.fresh.state, 'ended'); assert.deepEqual(f.fresh.roomIds, []);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
  await reopened.advanceRotations(f.client.snapshot(), NOW + 1);
  assert.equal(reopened.rotations.a.phase, 'failed', 'released snapshots do not remove the week of rest');
  reopened.pruneRotations(NOW + 6 * 24 * HOUR); assert.ok(reopened.rotations.a);
  reopened.pruneRotations(NOW + 8 * 24 * HOUR); assert.equal(reopened.rotations.a, undefined);
});
test('failed handoff recovery retains a missing successor with no recorded native id', async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary('failed');
  const saved = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => { saved(); if (f.record.failureCleanup) f.dispatcher.closed = true; };
  await f.step();
  f.record.successorOwner.nativeId = null;
  saved();
  f.client.state.sessions = f.client.state.sessions.filter(s => s.id !== 'b');
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client;
  await reopened.advanceRotations(f.client.snapshot(), NOW);
  assert.equal(reopened.rotations.a.failureCleanup.stop.state, 'retained');
  assert.equal(f.old.rotationEpisode.state, 'released');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
  assert.equal(f.client.calls.some(c => c[0] === 'stopFailedSuccessor'), false);
});
for (const use of ['draft', 'human turn']) test(`handoff timeout rolls back while preserving successor ${use}`, async t => {
  const f = await firstHandoff(t);
  if (use === 'draft') { f.fresh.liveDraft = 'synthetic draft'; f.fresh.draftRevision++; }
  else { f.fresh.activeTurnId = 'person-turn'; f.fresh.messages.push({ id: 'person', role: 'user', turnId: 'person-turn' }); }
  await f.dispatcher.advanceRotations(f.client.snapshot(), NOW + 31 * 60000);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.failureCleanup.stop.state, 'retained');
  assert.deepEqual(f.fresh.roomIds, ['shared']); assert.equal(f.fresh.state, 'working');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
const MINUTE = 60 * 1000;
const advanceTo = (f, minutes) => f.dispatcher.advanceRotations(f.client.snapshot(), NOW + minutes * MINUTE);
const stopsOf = f => f.client.calls.filter(c => c[0] === 'stopFailedSuccessor').length;
test('R183: a delivered first turn still running after 3 minutes is neither failed nor stopped, and then confirms', async t => {
  const f = await firstHandoff(t);
  for (const minutes of [1, 3, 13.3, 29]) {
    await advanceTo(f, minutes);
    assert.equal(f.record.phase, 'handed', `${minutes} minutes`); assert.equal(stopsOf(f), 0); assert.equal(f.fresh.state, 'working');
    assert.notEqual(f.record.handoffConfirmed, true);
    assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'b');
    assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'a', 'decisions move only with the confirmed turn');
  }
  f.boundary('complete'); f.fresh.state = 'idle'; await advanceTo(f, 29.5);
  assert.equal(f.record.handoffConfirmed, true); assert.equal(f.old.state, 'ended');
  assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'b');
});
test('R183: a first turn past its own limit rolls back as before', async t => {
  const f = await firstHandoff(t);
  await advanceTo(f, 30); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 30.1);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'handoff-unconfirmed');
  assert.equal(stopsOf(f), 1); assert.equal(f.fresh.state, 'ended'); assert.deepEqual(f.fresh.roomIds, []);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
  assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'a'); assert.equal(f.old.state, 'idle');
});
for (const [label, input] of [['unconfirmed', { status: 'unconfirmed', nativeId: undefined, turnId: undefined }],
  ['awaiting-native', { status: 'awaiting-native', nativeId: undefined, turnId: undefined }],
  ['bound to another native session', { nativeId: 'native-other' }]])
test(`R183: a handoff ${label} for 2 minutes still rolls back`, async t => {
  const f = await firstHandoff(t, { state: 'idle' });
  Object.assign(f.input, input);
  await advanceTo(f, 2); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 2.1);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'handoff-unconfirmed');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
test('R183: a handoff whose successor is missing from the start still rolls back after 2 minutes', async t => {
  const f = await firstHandoff(t);
  f.client.state.sessions = f.client.state.sessions.filter(s => s.id !== 'b');
  await advanceTo(f, 2); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 2.1); assert.equal(f.record.phase, 'failed'); assert.equal(stopsOf(f), 0);
});
for (const state of ['ended', 'recoverable', 'background'])
test(`R183: a delivered first turn whose successor is ${state} keeps the 2-minute limit`, async t => {
  const f = await firstHandoff(t);
  await advanceTo(f, 1); f.fresh.state = state;
  await advanceTo(f, 1.5); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 3); assert.equal(f.record.phase, 'failed'); assert.equal(stopsOf(f), f.record.failureCleanup.stop.state === 'done' ? 1 : 0);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
test('R183: a delivered first turn out of view for a pass, or in an app reopened meanwhile, keeps its limit', async t => {
  const f = await firstHandoff(t);
  await advanceTo(f, 1);
  const { sessions } = f.client.state;
  f.client.state.sessions = sessions.filter(s => s.id !== 'b');
  await advanceTo(f, 5); assert.equal(f.record.phase, 'handed', 'its backend is briefly away');
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client;
  await reopened.advanceRotations(f.client.snapshot(), NOW + 6 * MINUTE);
  assert.equal(reopened.rotations.a.phase, 'handed', 'delivery was recorded on disk');
  f.client.state.sessions = sessions; f.fresh.state = 'disconnected';
  await reopened.advanceRotations(f.client.snapshot(), NOW + 7 * MINUTE);
  assert.equal(reopened.rotations.a.phase, 'handed');
  await reopened.advanceRotations(f.client.snapshot(), NOW + 30.1 * MINUTE);
  assert.equal(reopened.rotations.a.phase, 'failed');
});
for (const failures of [1, Infinity])
test(`R183: a delivery that cannot be written to disk (${failures === 1 ? 'once' : 'for minutes'}) neither fails the rotation nor stops its successor`, async t => {
  const f = await firstHandoff(t), save = f.dispatcher.save;
  let left = failures;
  f.dispatcher.save = () => { if (left-- > 0) throw Object.assign(Error('no space left on device'), { code: 'ENOSPC' }); return save.call(f.dispatcher); };
  for (const minutes of [1, 3, 5]) {
    await advanceTo(f, minutes);
    assert.equal(f.record.phase, 'handed', `${minutes} minutes`); assert.equal(f.fresh.state, 'working'); assert.deepEqual(f.fresh.roomIds, ['shared']);
    assert.deepEqual(f.client.calls.filter(c => ['stop', 'stopFailedSuccessor'].includes(c[0])), []);
    assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'b');
  }
  f.dispatcher.save = save;
  f.boundary('complete'); f.fresh.state = 'idle'; await advanceTo(f, 6);
  assert.equal(f.record.handoffConfirmed, true); assert.equal(f.old.state, 'ended');
});
test('R183: a delivered first turn whose successor never comes back into view rolls back at its limit and stops nothing', async t => {
  const f = await firstHandoff(t);
  await advanceTo(f, 1);
  f.client.state.sessions = f.client.state.sessions.filter(s => s.id !== 'b');
  await advanceTo(f, 30); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 30.1);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'handoff-unconfirmed'); assert.equal(stopsOf(f), 0);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
// Undelivered at 119 s; native's receipt lands at 121 s; the next pass is at 125 s.
async function lateReceipt(t, patch, turnId = 'first-turn') {
  const f = await firstHandoff(t);
  const receipt = { status: 'submitted', nativeId: 'native-b', turnId };
  Object.assign(f.input, { status: 'awaiting-native', nativeId: undefined, turnId: undefined });
  await advanceTo(f, 119 / 60); assert.equal(f.record.phase, 'handed'); assert.notEqual(f.record.handoffDelivered, true);
  Object.assign(f.input, receipt); Object.assign(f.fresh, patch);
  return f;
}
for (const [label, patch] of [['working', {}], ['with background work, which a rollback may not stop', { background: 1 }], ['waiting on an approval', { state: 'approval', approval: { id: 'synthetic' } }]])
test(`R183: a receipt after the 2 minutes counts as delivered, its successor ${label}: one session has the work`, async t => {
  const f = await lateReceipt(t, patch), { state } = f.fresh;
  for (const minutes of [125 / 60, 10, 29]) {
    await advanceTo(f, minutes);
    assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'b', `${minutes} minutes`);
    assert.equal(f.record.phase, 'handed'); assert.equal(f.record.handoffDelivered, true);
    assert.equal(stopsOf(f), 0); assert.equal(f.fresh.state, state);
  }
  f.boundary('complete'); Object.assign(f.fresh, { state: 'idle', background: 0, approval: null }); await advanceTo(f, 29.5);
  assert.equal(f.record.handoffConfirmed, true);
  assert.equal(f.room.value.queue.find(i => i.id === f.decision).sentTo, 'b');
});
test('R183: a late receipt counts before native has named its turn', async t => {
  const f = await lateReceipt(t, {}, null);
  await advanceTo(f, 125 / 60); assert.equal(f.record.phase, 'handed'); assert.equal(f.record.handoffDelivered, true); assert.equal(stopsOf(f), 0);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'b');
});
test('R183: a late receipt adds no time: its limit too is counted from the handoff', async t => {
  const f = await lateReceipt(t);
  await advanceTo(f, 125 / 60); await advanceTo(f, 30); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 30.1); assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'handoff-unconfirmed');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
test('R183: a first turn that completed before the late receipt was seen confirms', async t => {
  const f = await lateReceipt(t, { state: 'idle' });
  f.boundary('complete'); await advanceTo(f, 125 / 60);
  assert.equal(f.record.handoffConfirmed, true); assert.equal(f.old.state, 'ended');
});
test('R183: delivered while no pass ran (app closed, Mac asleep): the reopened app keeps it', async t => {
  const f = await firstHandoff(t);
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client;
  await reopened.advanceRotations(f.client.snapshot(), NOW + 10 * MINUTE);
  assert.equal(reopened.rotations.a.phase, 'handed'); assert.equal(reopened.rotations.a.handoffDelivered, true); assert.equal(stopsOf(f), 0);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'b');
});
for (const state of ['ended', 'recoverable', 'background'])
test(`R183: a late receipt whose successor is already ${state} rolls back at that pass`, async t => {
  const f = await lateReceipt(t, { state });
  await advanceTo(f, 125 / 60); assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'handoff-unconfirmed');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
for (const wait of ['approval', 'nativeInputRequired'])
test(`R183: a first turn waiting on the person (${wait}) is bounded by the same limit and is not stopped`, async t => {
  const f = await firstHandoff(t, wait === 'approval' ? { state: 'approval', approval: { id: 'synthetic' } } : { nativeInputRequired: true });
  await advanceTo(f, 29); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 30.1);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.failureCleanup.stop.state, 'retained');
  assert.equal(stopsOf(f), 0); assert.deepEqual(f.fresh.roomIds, ['shared']);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
for (const status of ['failed', 'interrupted', 'incomplete'])
test(`R183: a first turn that ends ${status} after 3 minutes rolls back at once`, async t => {
  const f = await firstHandoff(t); await advanceTo(f, 3); assert.equal(f.record.phase, 'handed');
  f.boundary(status); f.fresh.state = 'idle'; await advanceTo(f, 3.1);
  assert.equal(f.record.phase, 'failed'); assert.equal(f.record.reason, 'successor-turn-failed');
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
test('R183: the wait for a collaboration is counted from the confirmed first turn', async t => {
  const f = await firstHandoff(t); f.dispatcher.view();
  f.client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  await advanceTo(f, 28); f.boundary('complete'); f.fresh.state = 'idle';
  await advanceTo(f, 29); assert.equal(f.record.handoffConfirmed, true); assert.equal(f.record.phase, 'handed');
  await advanceTo(f, 31); assert.equal(f.record.phase, 'handed', 'two minutes into the wait');
  assert.equal(f.old.state, 'idle');
  f.client.state.rooms[0].run = null; await advanceTo(f, 32);
  assert.equal(f.old.state, 'ended');
});
test('R183: that wait is told to the person after half an hour, and does not end (R206)', async t => {
  const f = await firstHandoff(t), told = []; f.dispatcher.notify = kind => told.push(kind);
  f.client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  await advanceTo(f, 28); f.boundary('complete'); f.fresh.state = 'idle'; await advanceTo(f, 29);
  await advanceTo(f, 59); assert.deepEqual(told, []);
  await advanceTo(f, 59.1); assert.deepEqual(told, ['kept']); assert.equal(f.dispatcher.rotations.a.phase, 'handed'); assert.equal(f.old.state, 'idle');
});
test('R183: a rotation an older version confirmed and left waiting is finished too (R206)', async t => {
  const f = await firstHandoff(t, { state: 'idle' }); f.boundary('complete');
  f.record.handoffConfirmed = true; f.dispatcher.save(); f.dispatcher.view();
  f.client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  await advanceTo(f, 29); await advanceTo(f, 60); assert.equal(f.record.phase, 'handed'); assert.equal(f.old.state, 'idle');
  f.client.state.rooms[0].run = null; await advanceTo(f, 61);
  assert.equal(f.old.state, 'ended'); assert.equal(f.dispatcher.rotations.a, undefined);
});

test('one space notice failing repeatedly does not block another space or duplicate its notice', async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary('failed');
  const other = f.room.create('Synthetic second space'); f.record.roomIds.push(other);
  const inherited = f.room.queueAdd('Synthetic second task', 'b', other);
  const event = f.room.rotationEvent.bind(f.room);
  f.room.rotationEvent = (ids, ...args) => { if (ids[0] === 'shared') throw Error('synthetic write failure'); return event(ids, ...args); };
  await f.step(); await f.step();
  assert.equal(f.room.queueItems(other).find(i => i.id === inherited).assignee, 'a');
  assert.equal(f.record.failureCleanup.rooms.shared.notice, 'pending');
  assert.equal(f.room.metadata(other).events.filter(e => e.rotationReceipt).length, 1);
  f.room.rotationEvent = event; await f.step();
  assert.equal(f.room.metadata('shared').events.filter(e => e.rotationReceipt).length, 1);
  assert.equal(f.record.failureCleanup.rooms.shared.notice, 'done');
});

test('a rolled back old member is eligible for its original queued work', async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary('failed'); await f.step();
  const actions = plan(f.room.apply(f.client.snapshot()).rooms, f.client.state.sessions, { rotations: f.dispatcher.rotations });
  assert.ok(actions.some(a => a.kind === 'dispatch' && a.sessionId === 'a' && a.itemId === f.task));
});
test('a stopped successor receipt reconciles a restart before the dispatcher saved the stop answer', async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary('failed');
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => { const result = await call(method, ...args); if (method === 'stopFailedSuccessor') { f.dispatcher.closed = true; throw Error('synthetic lost answer'); } return result; };
  await f.step(); assert.equal(f.record.failureCleanup.stop.state, 'started');
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client;
  await reopened.advanceRotations(f.client.snapshot(), NOW);
  assert.deepEqual(f.fresh.roomIds, []); assert.equal(reopened.rotations.a.failureCleanup.stop.state, 'done');
  assert.equal(f.client.calls.filter(c => c[0] === 'stopFailedSuccessor').length, 1);
});

for (const field of ['model', 'permission-mode']) for (const use of ['input', 'draft', 'active turn'])
test(`r3 ${field} mismatch preserves successor with person ${use}`, async t => {
  const f = await firstHandoff(t, { state: 'working' }); f.boundary('complete');
  if (field === 'model') f.fresh.model = 'different-model';
  else { f.record.carry.permissionMode = 'auto'; f.fresh.nativePermissionMode = 'manual'; }
  if (use === 'input') f.fresh.messages.push({ id: 'person-followup', role: 'user', turnId: 'person-turn' });
  if (use === 'draft') { f.fresh.liveDraft = 'Synthetic draft'; f.fresh.draftRevision++; }
  if (use === 'active turn') f.fresh.activeTurnId = 'person-turn';
  await f.step();
  assert.equal(f.record.reason, 'settings-differ:' + field); assert.equal(f.record.failureCleanup.stop.state, 'retained');
  assert.equal(f.fresh.state, 'working'); assert.deepEqual(f.fresh.roomIds, ['shared']);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a'); assert.equal(f.old.rotationEpisode.state, 'released');
});

test('r3 first intent restart retains an observed-inactive successor without a stop receipt', async t => {
  const f = await firstHandoff(t, { state: 'ended' }); f.boundary('failed');
  const saved = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => { saved(); if (f.record.failureCleanup) f.dispatcher.closed = true; };
  await f.step(); assert.equal(f.client.calls.some(c => c[0] === 'stopFailedSuccessor'), false);
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => method === 'stopFailedSuccessor'
    ? { basis: 'observed-inactive', state: 'ended', proof: { ...f.record.successorOwner } } : call(method, ...args);
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client;
  await reopened.advanceRotations(f.client.snapshot(), NOW);
  assert.equal(reopened.rotations.a.failureCleanup.stop.state, 'retained');
  assert.equal(reopened.rotations.a.failureCleanup.stop.receipt, null); assert.deepEqual(f.fresh.roomIds, ['shared']);
  assert.equal(f.room.value.queue.find(i => i.id === f.task).assignee, 'a');
});
for (const change of ['native context', 'person input', 'draft']) test(`r3 ${change} changed after first intent stays in the space`, async t => {
  const f = await firstHandoff(t, { state: 'error' }); f.boundary('failed');
  const saved = f.dispatcher.save.bind(f.dispatcher);
  f.dispatcher.save = () => { saved(); if (f.record.failureCleanup) f.dispatcher.closed = true; };
  await f.step();
  if (change === 'native context') f.fresh.nativeId = 'replacement-native';
  if (change === 'person input') f.fresh.messages.push({ id: 'person-after-intent', role: 'user' });
  if (change === 'draft') { f.fresh.liveDraft = 'Synthetic draft'; f.fresh.draftRevision++; }
  const reopened = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, now: () => NOW, tickMs: HOUR, connect: async () => f.client });
  t.after(() => reopened.close()); reopened.client = f.client; await reopened.advanceRotations(f.client.snapshot(), NOW);
  assert.equal(reopened.rotations.a.failureCleanup.stop.state, 'retained'); assert.deepEqual(f.fresh.roomIds, ['shared']);
  assert.equal(f.client.calls.some(c => c[0] === 'stopFailedSuccessor'), false);
});

// R206 (2026-11-24: 「这是个 bug:一旦错过就不再继续,这个肯定不行.」): a rotation kept from ending its old session waits
// for it and is then finished. The session under test is a, at the pass that has its handoff confirmed.
const ROWS = f => fs.readFileSync(path.join(f.dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').filter(line => line.startsWith('{"time"')).map(line => JSON.parse(line));
const eventsOf = (f, id = 'a') => ROWS(f).filter(e => e.old.id === id && ['kept', 'done', 'failed'].includes(e.event)).map(e => e.event);
const gatesOf = (f, id = 'a') => ROWS(f).filter(e => e.old.id === id && e.event === 'waiting').map(e => e.reason);
const NO_SAMPLES = { sampleProcesses: async () => { throw Error('no sample'); } };
const stewardFrom = role => () => { const at = role()?.current(); return at ? { ...at, duty: '【NAW 职责说明】\nD' } : null; };
async function handedOver(t, { butler = true, extra = {}, others = [] } = {}) {
  let f = null;
  const notices = [], due = { createdAt: NOW - 30 * HOUR, messages: heavyMessages(extra.provider), cwd: '/tmp', lastActivityAt: NOW - 40 * MINUTE };
  const old = member('a', { ...due, ...(butler ? { roomIds: [], roomId: null } : {}), ...extra });
  f = dispatcherSetup(t, [old, ...others], { clients: () => f?.window, notify: kind => notices.push(kind), steward: stewardFrom(() => f?.role), ...NO_SAMPLES });
  f.window = f.client; f.notices = notices; f.clock = NOW; f.old = old;
  f.role = new StewardRole(f.dir);
  if (butler) f.role.set({ sessionId: 'a', nativeId: 'native-a' });
  f.joins = fakeMembership(f.room, f.client);
  const advance = f.advance; f.advance = ms => { f.clock += ms; advance(ms); };
  f.pass = async (minutes = 0) => { f.advance(minutes * MINUTE); f.dispatcher.dirty = true; await f.dispatcher.schedule(); };
  f.session = id => f.client.state.sessions.find(s => s.id === id);
  f.stopped = id => f.client.calls.some(call => call[0] === 'stop' && call[1] === id);
  f.asks = () => f.client.sends('a').filter(call => call[4].startsWith('rotation-supplement:'));
  f.tells = id => f.client.sends(id ?? f.newId).filter(call => call[4].startsWith('rotation-handoff:a:'));
  // What the backend does with the person's message: the row, the control revision, and the turn it starts.
  f.person = (text = 'one more thing', state = 'idle') => {
    const n = old.messages.length;
    old.controlRevision += 1; old.state = state; f.dispatcher.noteHuman('a');
    old.messages.push({ id: `person-${n}`, role: 'user', text, origin: 'gui', status: 'submitted', time: f.clock });
    if (state === 'idle') old.messages.push({ id: `answer-${n}`, role: 'assistant', text: 'done', time: f.clock });
  };
  // NAW restarted: the same files, a new dispatcher with nothing in memory.
  f.restart = async () => {
    f.dispatcher.close();
    f.dispatcher = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, connect: async () => f.client, clients: () => f.window, now: () => f.clock,
      settleMs: 0, tickMs: HOUR, notify: kind => notices.push(kind), steward: stewardFrom(() => f.role), ...NO_SAMPLES });
    f.role = new StewardRole(f.dir);
    t.after(() => f.dispatcher.close());
    await f.dispatcher.start();
  };
  await f.dispatcher.start();
  await f.pass();
  f.client.reply('a', '交接：在看三个交付。');
  await f.pass();
  f.newId = f.client.state.sessions.at(-1).id;
  await f.pass();
  assert.equal(f.dispatcher.rotations.a.phase, 'handed');
  f.session(f.newId).messages.push({ id: 'first-reply', role: 'assistant', text: '已核对交接。' });
  f.session(f.newId).state = 'idle';
  return f;
}
// R221: the butler outside every space. After each pass there is exactly one designated session, and it is alive.
function idleButler(t, minutes) {
  let f = null;
  f = idleSetup(t, minutes, { extra: { roomIds: [], roomId: null }, steward: stewardFrom(() => f?.role) });
  f.role = new StewardRole(f.dir); f.role.set({ sessionId: 'a', nativeId: NATIVE_A });
  const pass = f.pass; f.seats = [];
  f.pass = async forward => {
    await pass(forward);
    const seat = f.role.current();
    assert.equal(f.client.state.sessions.filter(s => s.id === seat?.sessionId && s.nativeId === seat.nativeId && s.state !== 'ended').length, 1);
    f.seats.push(seat.sessionId);
  };
  return f;
}
test('R221: the butler left alone is asked at 45 minutes; the designation moves once, to its successor', async t => {
  const f = idleButler(t, 44);
  await f.pass();
  assert.deepEqual(rotated(f.client), []);
  await f.pass(1);
  assert.match(rotated(f.client)[0], /上下文已到约 190K/);
  await f.finish();
  assert.deepEqual(f.requests(), ['context']);
  assert.deepEqual([f.old.state, f.next.state, f.next.roomIds], ['ended', 'idle', []]);
  assert.deepEqual([...new Set(f.seats)], ['a', f.next.id]);
  assert.equal(f.role.current().sessionId, f.next.id);
  for (let n = 0; n < 3; n++) await f.pass(1);
  assert.equal(f.client.state.sessions.length, 2, 'one successor');
});
test('R221: the butler is asked two minutes after its migration window closed, not before', async t => {
  const f = idleButler(t, 46);
  idleWindow(f);
  assert.deepEqual(f.judge(), ['still-busy']);
  for (const forward of [0.1, 1]) {
    await f.pass(forward);
    assert.deepEqual(rotated(f.client), []);
  }
  await f.pass(1);
  assert.equal(rotated(f.client).length, 1);
  assert.deepEqual(f.requests(), ['context']);
});
for (const [name, fail] of [
  ['cannot be created', f => {
    const call = f.client.call.bind(f.client);
    f.client.call = async (method, ...args) => { if (method === 'create') throw Error('synthetic create failure'); return call(method, ...args); };
  }],
  ['fails in its first turn', f => {
    const call = f.client.call.bind(f.client);
    f.client.call = async (method, ...args) => {
      const tag = await call(method, ...args), target = f.client.state.sessions.find(s => s.id === args[0]);
      if (method === 'dispatch' && args[3]?.startsWith('rotation-handoff:')) { target.messages.at(-1).status = 'failed'; target.state = 'error'; }
      return tag;
    };
  }],
]) test(`R221: the butler whose successor ${name} stays the butler and is not asked again`, async t => {
  const f = idleButler(t, 46);
  fail(f);
  await f.pass();
  assert.equal(rotated(f.client).length, 1);
  f.client.reply('a', '交接：在看三个交付。');
  for (let n = 0; n < 4; n++) await f.pass(1);
  assert.ok(f.log().some(entry => entry.event === 'failed'), 'the rotation failed');
  assert.deepEqual([...new Set(f.seats)], ['a']);
  assert.deepEqual([f.old.state, f.old.archived], ['idle', undefined]);
  assert.equal(rotated(f.client).length, 1);
});

// The old session's one addition, told to the same successor and finished there.
async function supplemented(f, text = '交接之后：人改了主意。') {
  assert.equal(f.asks().length, 1, 'the old session is asked');
  f.client.reply('a', text);
  await f.pass();
  assert.equal(f.tells().length, 1);
  assert.match(f.tells()[0][2], new RegExp(text));
  f.client.reply(f.newId, '并进来了。');
  await f.pass();
}
const finished = (f, id = 'a') => {
  assert.equal(f.session(id).state, 'ended'); assert.equal(f.dispatcher.rotations[id], undefined);
  assert.deepEqual(eventsOf(f, id), ['done']); assert.equal(f.session(f.newId).state === 'ended', false);
};

test('R206: the person typing in the old session is waited for, and it is ended once they are done', async t => {
  const f = await handedOver(t);
  f.dispatcher.noteHuman('a'); f.old.liveDraft = '还没发'; f.old.draftRevision += 1;
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations[f.newId]?.phase, f.dispatcher.rotations[f.newId]?.successorOf], ['kept', 'a'], 'the successor rests as after any rotation');
  for (const minutes of [31, 25 * 60]) { await f.pass(minutes); assert.equal(f.stopped('a'), false, 'their draft is never cut off'); }
  assert.deepEqual(eventsOf(f), [], 'not over: nothing is recorded as kept');
  assert.deepEqual(gatesOf(f).slice(0, 1), ['person-input']); assert.ok(gatesOf(f).includes('person-typing'), 'the log names the gate, not the words');
  assert.deepEqual(f.role.current().sessionId, 'a', 'the butler until then');
  assert.deepEqual(f.dispatcher.rotationChains().map(chain => chain.sessions.map(x => [x.id, x.outcome])), [[['a', null], [f.newId, 'kept']]], 'the two are shown together meanwhile');
  const lines = gatesOf(f).length;
  for (const draft of ['', '又写', '', '还写']) { f.old.liveDraft = draft; f.dispatcher.noteHuman('a'); await f.pass(1); }
  assert.ok(gatesOf(f).length <= lines + 1); assert.deepEqual(gatesOf(f).length, new Set(gatesOf(f)).size, 'a gate it comes back to is not another line');
  f.old.liveDraft = ''; f.dispatcher.noteHuman('a');
  await f.pass(29); assert.equal(f.stopped('a'), false, 'the quiet time is not shorter');
  await f.pass(2);
  finished(f); assert.deepEqual(f.role.current(), { sessionId: f.newId, nativeId: `native-${f.newId}` });
  assert.equal(f.asks().length, 0, 'nothing was said: nothing to add');
  assert.equal(f.client.calls.filter(call => call[0] === 'create').length, 1, 'the same successor');
  assert.deepEqual(f.notices.filter(kind => kind === 'kept'), ['kept'], 'the person is told once');
});

test('R206: what the person said after the handoff reaches the successor before the old session is ended', async t => {
  const f = await handedOver(t);
  f.person(); await f.pass();
  assert.deepEqual(gatesOf(f), ['person-message']);
  await f.pass(29); assert.equal(f.asks().length, 0);
  await f.pass(2); assert.equal(f.stopped('a'), false);
  assert.match(f.asks()[0]?.[2] || '', /只补一段：交接之后变了什么/);
  await supplemented(f); finished(f);
  assert.deepEqual(f.role.current().sessionId, f.newId); assert.equal(f.asks().length, 1); assert.equal(f.tells().length, 1);
  assert.equal(f.client.calls.filter(call => call[0] === 'create').length, 1);
});

test('R206: an old session NAW woke ran another turn: that is added too, with no quiet to wait for', async t => {
  const f = await handedOver(t);
  f.old.messages.push({ id: 'wake', role: 'user', text: '【NAW 派活】看一下', origin: 'naw-dispatch', time: f.clock }); f.old.state = 'working';
  await f.pass(); assert.deepEqual(gatesOf(f), ['turn-running']);
  f.old.messages.push({ id: 'wake-reply', role: 'assistant', text: '看过了', time: f.clock }); f.old.state = 'idle';
  await f.pass(1); await supplemented(f); finished(f);
});

test('R206: what the person says in a space counts as use by its own time: it does not take control of the session', async t => {
  const f = await handedOver(t); f.dispatcher.noteHuman('a'); await f.pass(); await f.pass(20);
  f.old.messages.push({ id: 'space-words', role: 'user', text: '顺便看一下', origin: 'gui', status: 'submitted', time: f.clock }, { id: 'space-answer', role: 'assistant', text: 'ok', time: f.clock });
  await f.pass(20); assert.equal(f.asks().length, 0, 'their quiet starts again');
  await f.pass(11); await supplemented(f); finished(f);
});

test('R206: a successor with a queue item, in use by the person or in a turn is told once it is free', async t => {
  const f = await handedOver(t, { butler: false });
  f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。');
  const task = f.room.queueAdd('在做的一件', f.newId);
  f.room.queueMarkSent('shared', task, f.newId, f.newId, f.clock, false, `native-${f.newId}`);
  await f.pass(); assert.equal(f.tells().length, 0, 'its item first'); assert.ok(gatesOf(f).includes('successor-busy'));
  f.room.queueSettle('shared', task, 'done', undefined, f.newId);
  f.dispatcher.noteHuman(f.newId); await f.pass(1); assert.equal(f.tells().length, 0);
  f.session(f.newId).state = 'working'; await f.pass(10); assert.equal(f.tells().length, 0);
  f.session(f.newId).state = 'idle'; await f.pass(1); await f.pass(1); assert.equal(f.tells().length, 1); f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

test('R206: a collaboration is waited for however long it runs', async t => {
  const f = await handedOver(t, { butler: false });
  f.client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  await f.pass(); await f.pass(31); await f.pass(25 * 60);
  assert.deepEqual(eventsOf(f), []); assert.deepEqual(gatesOf(f), ['collaborating']); assert.deepEqual(f.notices, ['kept'], 'told once, after half an hour');
  f.client.state.rooms[0].run = null; await f.pass(1);
  finished(f);
});

test('R206: a terminal whose screen could not be saved is tried again', async t => {
  const f = await handedOver(t, { extra: { terminalInputPending: true } });
  const reads = () => f.client.calls.filter(call => call[0] === 'terminalSnapshot').length;
  f.client.snapshotFails = true; await f.pass(); await f.pass(2); const before = reads(); await f.pass(0.2); await f.pass(0.2); assert.equal(reads(), before, 'not on every pass');
  await f.pass(25 * 60);
  assert.deepEqual(eventsOf(f), []); assert.deepEqual(gatesOf(f), ['terminal-unsaved']); assert.deepEqual(f.notices, ['keptUnsaved']);
  f.client.snapshotFails = false; await f.pass(2);
  finished(f); assert.equal(fs.readdirSync(path.join(f.dir, 'rotation-terminals')).length, 1);
});

test('R206: keys left in the terminal hold it; Claude says when its prompt is empty, and NAW asks no more than that', async t => {
  const f = await handedOver(t);
  f.old.terminalInputPending = true; f.old.controlRevision += 1;
  let draft = true; const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => {
    if (draft && method === 'dispatch' && args[0] === 'a') throw Object.assign(Error('draft'), { uiMessage: { key: 'error.submission.nativeDraft' } });
    return call(method, ...args);
  };
  await f.pass(); assert.deepEqual(gatesOf(f), ['control-changed']);
  for (const minutes of [1, 31, 31, 24 * 60]) await f.pass(minutes);
  assert.equal(f.stopped('a'), false); assert.deepEqual(eventsOf(f), []); assert.ok(gatesOf(f).includes('terminal-input')); assert.equal(f.asks().length, 0);
  draft = false; await f.pass(31);
  await supplemented(f, '没有变化。'); finished(f);
});

test('R206: a Codex terminal cannot say so: it is held until the person sends', async t => {
  const f = await handedOver(t); f.old.provider = 'codex';
  f.old.terminalInputPending = true; f.old.controlRevision += 1;
  await f.pass(); await f.pass(1); await f.pass(31); await f.pass(25 * 60);
  assert.equal(f.stopped('a'), false); assert.equal(f.asks().length, 0); assert.ok(gatesOf(f).includes('terminal-input')); assert.deepEqual(eventsOf(f), []);
  f.person('发出去了'); await f.pass(1); await f.pass(31);
  await supplemented(f); finished(f);
});

test('R206: someone always at it is never cut off', async t => {
  const f = await handedOver(t), stalls = []; f.dispatcher.rotationStalled = stall => stalls.push([stall.memberId, stall.reason, stall.gate]);
  for (let i = 0; i < 60; i += 1) { f.person(`第 ${i} 句`); await f.pass(); await f.pass(29); }
  assert.equal(f.stopped('a'), false); assert.equal(f.asks().length, 0); assert.deepEqual(eventsOf(f), []); assert.equal(f.role.current().sessionId, 'a');
  assert.ok(ROWS(f).length < 12, 'a wait is not a line per pass');
  assert.deepEqual(stalls, [['a', 'content', 'person-quiet']], 'a long wait is one line in the butler\'s record');
});

test('R206: more from the person while the addition is written is the next interruption, asked for once too', async t => {
  const f = await handedOver(t);
  f.person('一'); await f.pass(); await f.pass(31); assert.equal(f.asks().length, 1);
  f.client.reply('a', '补：一。'); f.person('二'); await f.pass();
  assert.equal(f.tells().length, 1); assert.doesNotMatch(f.tells()[0][2], /二/);
  f.client.reply(f.newId, '收到。'); await f.pass(); assert.equal(f.stopped('a'), false, '「二」 is not told yet'); assert.equal(f.asks().length, 1);
  await f.pass(31); assert.equal(f.asks().length, 2);
  f.client.reply('a', '补：二。'); await f.pass(); assert.equal(f.tells().length, 2); f.client.reply(f.newId, '收到。'); await f.pass();
  finished(f);
});

test('R206: an addition that came to nothing is not asked for again at once', async t => {
  const f = await handedOver(t);
  f.person(); await f.pass(); await f.pass(31); assert.equal(f.asks().length, 1);
  f.old.state = 'idle'; // The turn failed: no words.
  for (const minutes of [1, 1, 10, 15]) { await f.pass(minutes); assert.equal(f.asks().length, 1); }
  assert.ok(gatesOf(f).includes('supplement-missing')); assert.equal(f.stopped('a'), false);
  await f.pass(5); assert.equal(f.asks().length, 2); f.old.state = 'idle'; await f.pass(1);
  await f.pass(45); assert.equal(f.asks().length, 2, 'twice as long the second time');
  await f.pass(20); assert.equal(f.asks().length, 3); f.client.reply('a', '补上了。'); await f.pass();
  f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

test('R206: an old session the person ended themselves is finished, and the successor is told it left something unsaid', async t => {
  const f = await handedOver(t);
  f.person(); await f.pass(); f.old.state = 'ended'; await f.pass(1); assert.equal(f.tells().length, 0); await f.pass(2);
  assert.equal(f.asks().length, 0); assert.match(f.tells()[0]?.[2] || '', /没有补写就结束了/);
  f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

for (const state of ['working', 'ended']) test(`R206: a successor turn on the addition that ${state === 'working' ? 'runs long is not told twice' : 'fails is tried again later'}`, async t => {
  const f = await handedOver(t), call = f.client.call.bind(f.client), hold = state === 'working' ? null : 'failed';
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'dispatch' && args[3].startsWith('rotation-handoff:a:')) {
      const rows = f.session(f.newId).messages;
      if (hold) { rows.at(-1).status = hold; f.session(f.newId).state = 'idle'; } else f.late = rows.pop();
    }
    return result;
  };
  f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.tells().length, 1);
  if (hold) {
    await f.pass(1); await f.pass(20); assert.equal(f.tells().length, 1); assert.ok(gatesOf(f).includes('successor-turn-failed')); assert.deepEqual(heldBack(f), []);
    f.session(f.newId).state = 'working'; await f.pass(11); assert.deepEqual(heldBack(f), [f.newId], 'from then on before its next item');
    f.session(f.newId).state = 'idle'; await f.pass(4); await f.pass(1); assert.equal(f.tells().length, 2); assert.equal(f.asks().length, 1, 'the old session is not asked again for it');
  } else {
    await f.pass(45); assert.equal(f.tells().length, 1); assert.equal(f.stopped('a'), false);
    f.session(f.newId).messages.push(f.late); f.session(f.newId).state = 'idle'; await f.pass(1); finished(f);
  }
});

// Every step is on disk before it has an effect: a restart asks nothing, tells nothing and creates nothing twice.
for (const at of ['waiting', 'asked', 'asking', 'ready', 'sending', 'sent']) test(`R206: NAW restarted while ${at}`, async t => {
  const f = await handedOver(t), call = f.client.call.bind(f.client);
  f.person(); await f.pass(); if (at === 'waiting') await f.restart();
  if (at === 'asking' || at === 'sending') f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'dispatch' && args[3].startsWith(at === 'asking' ? 'rotation-supplement:' : 'rotation-handoff:a:')) {
      f.client.call = call;
      f.onDisk = JSON.parse(fs.readFileSync(path.join(f.dir, 'queue-dispatch.json'), 'utf8')).rotations.a.supplement?.state;
      throw Error('synthetic lost answer');
    }
    return result;
  };
  await f.pass(31); if (['asked', 'asking'].includes(at)) { assert.equal(f.dispatcher.rotations.a?.supplement?.state, at); await f.restart(); }
  assert.equal(f.asks().length, 1); f.client.reply('a', '交接之后：改了。');
  if (at === 'ready') f.session(f.newId).state = 'working';
  await f.pass(1);
  if (['ready', 'sending', 'sent'].includes(at)) { assert.equal(f.dispatcher.rotations.a?.supplement?.state, at); await f.restart(); }
  if (['asking', 'sending'].includes(at)) assert.equal(f.onDisk, at, 'written before it is sent');
  if (at === 'ready') { f.session(f.newId).state = 'idle'; await f.pass(1); }
  await f.pass(1); assert.equal(f.tells().length, 1); f.client.reply(f.newId, '收到。');
  // A restart does not know when the person last used it: their quiet is counted from then.
  for (let i = 0; i < 3 && f.dispatcher.rotations.a; i += 1) await f.pass(31);
  finished(f);
  assert.equal(f.asks().length, 1); assert.equal(f.tells().length, 1); assert.equal(f.client.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.client.sends('a').filter(c => c[4] === 'rotation:a').length, 1); assert.equal(f.role.current().sessionId, f.newId);
});

test('R206: the person\'s quiet is counted across a restart too', async t => {
  const f = await handedOver(t);
  f.dispatcher.noteHuman('a'); await f.pass(); await f.restart();
  await f.pass(10); await f.pass(10); assert.equal(f.stopped('a'), false); await f.pass(11); finished(f);
});

for (const [what, change] of [['a key in its terminal', old => { old.controlRevision += 1; }], ['another row', old => { old.messages.push({ id: 'late', role: 'assistant', text: 'late' }); }]])
test(`R206: ${what} between the judgement and the step keeps the old session and is not skipped`, async t => {
  const f = await handedOver(t), refresh = f.client.refresh.bind(f.client); let once = null;
  f.client.refresh = async () => { if (once) { once(f.old); once = null; } return refresh(); };
  f.dispatcher.noteHuman('a'); await f.pass(); f.advance(31 * MINUTE); once = change;
  await f.pass(); assert.equal(f.stopped('a'), false, 'not ended');
  if (what === 'another row') { await f.pass(2); await supplemented(f); return finished(f); }
  f.person(); await f.pass(1); once = change;
  await f.pass(31); assert.equal(f.asks().length, 0, 'nor asked over the person');
});

// What a move of a backend shows of its sessions, and what one that failed leaves on record.
async function movable(t, options) {
  const f = await handedOver(t, options), route = f.client.route.bind(f.client);
  f.client.control = { maintenance: new Set() };
  f.client.route = id => ({ ...route(id), key: 'backend' });
  f.move = async (id, work) => {
    const session = f.session(id), state = session.state;
    f.client.control.maintenance.add('backend'); session.state = 'ended'; await work();
    f.client.control.maintenance.clear(); await f.pass(0.5); // a snapshot of that moment, seen after it
    session.state = state;
  };
  return f;
}
test('R206: an old session stopped for a move of its backend is not taken as ended', async t => {
  const f = await movable(t);
  f.person('移动前说的'); await f.pass();
  await f.move('a', async () => { for (const minutes of [1, 3, 3]) await f.pass(minutes); });
  await f.pass(1); assert.deepEqual(eventsOf(f), []); assert.equal(f.tells().length, 0, 'nor said to have left it unsaid'); assert.equal(f.role.current().sessionId, 'a');
  assert.ok(gatesOf(f).includes('backend-move'));
  await f.pass(31); assert.equal(f.asks().length, 1); await supplemented(f); finished(f);
});

test('R206: the same at the pass that has the handoff confirmed', async t => {
  const f = await movable(t);
  await f.move('a', async () => { for (const minutes of [0, 3]) await f.pass(minutes); });
  assert.deepEqual(eventsOf(f), []); await f.pass(1); finished(f); assert.equal(f.stopped('a'), true, 'ended by its own stop');
});

test('R206: a successor stopped for a move of its backend is not given up', async t => {
  const f = await movable(t, { butler: false });
  f.person(); await f.pass();
  await f.move(f.newId, async () => { for (const minutes of [1, 3, 3]) await f.pass(minutes); });
  await f.pass(31); assert.deepEqual(eventsOf(f), []); await supplemented(f); finished(f);
  assert.equal(f.client.calls.filter(call => call[0] === 'create').length, 1, 'no second successor');
});

test('R206: an old session a failed move left stopped is the person\'s to continue, until they put it away', async t => {
  const f = await handedOver(t), record = path.join(f.dir, 'backend-switch.json');
  f.person(); await f.pass(); f.old.state = 'ended';
  fs.writeFileSync(record, JSON.stringify({ format: 2, backends: { backend: { phase: 'stopped', failedAt: NOW, sessions: [{ id: 'a', nativeId: 'native-a', name: 'a' }] } } }));
  await f.pass(31); await f.pass(31); assert.deepEqual(eventsOf(f), []); assert.deepEqual(gatesOf(f).at(-1), 'backend-move'); assert.equal(f.tells().length, 0);
  f.room.update({ archivedSessions: ['a'] }); await f.pass(1); await f.pass(3); assert.match(f.tells()[0]?.[2] || '', /没有补写就结束了/);
  f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

const heldBack = f => ['a', f.newId].filter(id => !rules.queueVacancies({ rooms: [{ id: 'shared', name: 'Team', queue: [] }], sessions: [member(id)],
  wakePolicy: AWAKE, now: f.clock, rotations: f.dispatcher.rotations })[0].candidateIds.length);
// While the successor has the addition and cannot say it took it, the two are held back for ten minutes and no longer.
for (const state of ['error', 'recoverable', 'approval', 'working']) test(`R206: an addition held up by a successor in ${state} does not hold the two back, and is not told twice`, async t => {
  const f = await handedOver(t, { butler: false }); f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。'); await f.pass();
  assert.equal(f.tells().length, 1); assert.equal(f.dispatcher.rotations.a.supplement.state, 'sent');
  const held = () => heldBack(f), next = f.session(f.newId);
  if (state === 'error') next.messages.at(-1).status = 'failed'; else f.boundary = next.messages.pop();
  next.state = state;
  await f.pass(1); assert.deepEqual(held(), ['a', f.newId]);
  await f.pass(8); assert.deepEqual(held(), ['a', f.newId]); await f.pass(2); assert.deepEqual(held(), [], 'neither is held');
  await f.pass(45); assert.deepEqual(held(), []); assert.equal(f.tells().length, 1); assert.equal(f.stopped('a'), false);
  if (state === 'error') return;
  next.state = 'idle'; next.messages.push(f.boundary); await f.pass(1); await f.pass(1);
  assert.equal(f.tells().length, 1); finished(f);
});

test('R206: the butler is woken again when its addition is held up at a successor whose turn failed', async t => {
  const f = await handedOver(t); let event = false, woken = 0;
  f.dispatcher.stewardWake = { active: () => true, endHold() {}, hold() {}, due: () => event, patrolDue: () => null, clearBlocked() {}, skip() {}, controlSucceeded() {},
    wake: async (session, model, send) => { woken += session.id === 'a'; await send('【NAW】有新结果', `steward-wake:${woken}`); } };
  f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。'); await f.pass(); event = true;
  f.session(f.newId).messages.at(-1).status = 'failed'; f.session(f.newId).state = 'error';
  await f.pass(5); assert.equal(woken, 0); await f.pass(6); await f.pass(1); assert.equal(woken, 1); event = false; f.client.reply('a', '看过了。');
  // Once it can work again, the addition and then what that wake brought are told, each once.
  f.session(f.newId).state = 'idle'; await f.pass(1); await f.pass(31); assert.equal(f.tells().length, 2); f.client.reply(f.newId, '收到。');
  await f.pass(1); await f.pass(1); assert.equal(f.asks().length, 2); f.client.reply('a', '又补。'); await f.pass(); f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

test('R206: an addition whose sends leave nothing behind holds the two back once, not at every try', async t => {
  const f = await handedOver(t, { butler: false }), call = f.client.call.bind(f.client); let tries = 0;
  f.client.call = async (method, ...args) => {
    if (method === 'dispatch' && args[3].startsWith('rotation-handoff:a:')) { tries += 1; throw Error('send-timeout'); }
    return call(method, ...args);
  };
  f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(tries, 1);
  assert.deepEqual(heldBack(f), ['a', f.newId]);
  for (let i = 0; i < 8; i += 1) { await f.pass(1); if (i > 2) assert.deepEqual(heldBack(f), [], 'neither is held while it is tried again'); }
  assert.ok(tries > 2 && tries < 6, `${tries}`); f.client.call = call; await f.pass(3);
  assert.equal(f.tells().length, 1); assert.equal(f.asks().length, 1); assert.deepEqual(heldBack(f), ['a', f.newId], 'it is there now');
  f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

test('R206: a successor that is gone while the old session is out of view gives nothing up until it is back', async t => {
  const f = await handedOver(t, { butler: false });
  f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.dispatcher.rotations.a.supplement.state, 'sent');
  const task = f.room.queueAdd('给继任的', f.newId); f.client.state.sessions = f.client.state.sessions.filter(s => s.id !== 'a');
  f.room.update({ archivedSessions: [f.newId] }); await f.pass(1); await f.pass(5);
  assert.deepEqual(eventsOf(f), []); assert.equal(gatesOf(f).at(-1), 'old-missing');
  f.client.state.sessions.push(f.old); await f.pass(1);
  assert.deepEqual(eventsOf(f), ['failed']); assert.equal(f.room.value.queue.find(i => i.id === task).assignee, 'a');
});

test('R206: what the old session added is told while a failed move has it stopped, and holds no one after', async t => {
  const f = await handedOver(t, { butler: false });
  f.person(); await f.pass(); await f.pass(31); f.client.reply('a', '补。'); f.session(f.newId).state = 'working'; await f.pass();
  assert.equal(f.dispatcher.rotations.a.supplement.state, 'ready'); f.old.state = 'ended';
  fs.writeFileSync(path.join(f.dir, 'backend-switch.json'), JSON.stringify({ format: 2, backends: { b: { phase: 'stopped', sessions: [{ id: 'a', nativeId: 'native-a', name: 'a' }] } } }));
  await f.pass(1); await f.pass(11); f.session(f.newId).state = 'idle'; await f.pass(1); await f.pass(1); assert.equal(f.tells().length, 1);
  f.client.reply(f.newId, '收到。'); const task = f.room.queueAdd('下一件', f.newId); await f.pass(1); await f.pass(1);
  assert.equal(f.room.value.queue.find(i => i.id === task).status, 'sent'); assert.deepEqual(eventsOf(f), []); assert.equal(gatesOf(f).at(-1), 'backend-move');
  fs.unlinkSync(path.join(f.dir, 'backend-switch.json')); f.old.state = 'idle'; await f.pass(1); await f.pass(1); finished(f); assert.equal(f.asks().length, 1);
});

test('R206: more open decisions than fit in one message hold no one back', async t => {
  const f = await handedOver(t, { butler: false }); f.person(); await f.pass(); await f.pass(31);
  for (let i = 0; i < 12; i += 1) {
    const task = f.room.queueAdd(`${i}`.padEnd(1500, '长'), 'a'); f.room.queueMarkSent('shared', task, 'a', 'a', f.clock, false, 'native-a');
    f.room.queueSettle('shared', task, 'waiting', undefined, 'a', '', `需要你决定：${i}`.padEnd(1500, '问'));
  }
  f.client.reply('a', '补。'); await f.pass(); await f.pass(1);
  assert.equal(f.tells().length, 0); assert.ok(gatesOf(f).includes('decisions-stay'), gatesOf(f).join()); assert.deepEqual(heldBack(f), []);
  for (const item of f.room.value.queue) if (item.status === 'waiting') f.room.queueResolve(item.id);
  await f.pass(1); await f.pass(1); assert.equal(f.tells().length, 1); f.client.reply(f.newId, '收到。'); await f.pass(); finished(f);
});

test('R206: a successor that always has a next item is told between two of them', async t => {
  const f = await handedOver(t, { butler: false });
  f.person(); await f.pass(); const first = f.room.queueAdd('第一件', f.newId), second = f.room.queueAdd('第二件', f.newId);
  await f.pass(3); assert.equal(f.room.value.queue.find(i => i.id === first).status, 'sent');
  await f.pass(31); f.client.reply('a', '补。'); await f.pass(); await f.pass(11); await f.pass(11); assert.equal(f.tells().length, 0);
  assert.deepEqual(heldBack(f), [f.newId], 'the old one is not held for it');
  f.client.reply(f.newId, '第一件做完了。'); await f.pass(1); await f.pass(1); assert.equal(f.tells().length, 1); assert.equal(f.room.value.queue.find(i => i.id === second).status, 'queued');
  f.client.reply(f.newId, '收到。'); await f.pass(); finished(f); await f.pass(1); assert.equal(f.room.value.queue.find(i => i.id === second).status, 'sent');
});

test('R206: an old session no longer in view is finished after half an hour out of it, as it was at once before', async t => {
  const f = await handedOver(t);
  f.dispatcher.noteHuman('a'); await f.pass(); f.client.state.sessions = f.client.state.sessions.filter(s => s.id !== 'a');
  await f.pass(1); await f.pass(29); assert.deepEqual(eventsOf(f), []); assert.ok(gatesOf(f).includes('old-missing'));
  await f.pass(2); assert.deepEqual(eventsOf(f), ['done']); assert.equal(f.role.current().sessionId, f.newId);
});

test('R206: an old session the person archived while it runs is asked and ended too', async t => {
  const f = await handedOver(t), stalls = []; f.dispatcher.rotationStalled = stall => stalls.push(stall.memberId);
  f.person(); await f.pass(); f.room.update({ archivedSessions: ['a'] });
  await f.pass(31); await f.pass(1); await supplemented(f); finished(f);
  const g = await handedOver(t); g.dispatcher.rotationStalled = stall => stalls.push(stall.memberId);
  g.old.state = 'working'; await g.pass(); g.room.update({ archivedSessions: ['a'] }); await g.pass(1); await g.pass(120); await g.pass(120);
  assert.deepEqual(stalls, ['a'], 'a long wait is in the butler\'s record all the same');
});

for (const [what, change] of [['the person used it', f => f.dispatcher.noteHuman('a')], ['a dialog opened in it', f => { f.old.nativeTerminalDialog = true; }]])
test(`R206: an archived old session is not asked when ${what} between the judgement and the step`, async t => {
  const f = await handedOver(t), refresh = f.client.refresh.bind(f.client); let once = null;
  f.client.refresh = async () => { if (once) { once(f); once = null; } return refresh(); };
  f.person(); await f.pass(); f.room.update({ archivedSessions: ['a'] }); await f.pass(1); f.advance(31 * MINUTE); once = change;
  await f.pass(); assert.equal(once, null); assert.equal(f.asks().length, 0); f.old.nativeTerminalDialog = false; await f.pass(1);
  await f.pass(31); await supplemented(f); finished(f);
});

test('R206: a designation that cannot be read is waited for, and the person is told', async t => {
  const f = await handedOver(t), steward = f.dispatcher.steward;
  f.dispatcher.steward = () => { throw Error('unreadable'); };
  await f.pass(); await f.pass(1); await f.pass(31); assert.equal(f.stopped('a'), false); assert.deepEqual(eventsOf(f), []);
  assert.deepEqual(gatesOf(f).at(-1), 'designation-unreadable'); assert.ok(f.notices.includes('kept'));
  f.dispatcher.steward = steward; await f.pass(1); finished(f);
});

test('R206: an old session whose stop did not go through is back in its spaces when its successor is gone', async t => {
  const f = await handedOver(t, { butler: false }), call = f.client.call.bind(f.client); let refuse = true;
  f.client.call = async (method, ...args) => {
    if (refuse && method === 'maintenanceStop') { f.dispatcher.noteHuman('a'); throw Object.assign(Error('changed'), { uiMessage: { key: 'error.backendSwitchSessionChanged' } }); }
    return call(method, ...args);
  };
  await f.pass(); assert.deepEqual(gatesOf(f), ['changed-at-stop']); assert.deepEqual(f.old.roomIds, []);
  const task = f.room.queueAdd('给继任的', f.newId); refuse = false; f.dispatcher.noteHuman('a');
  f.room.update({ archivedSessions: [f.newId] }); await f.pass(1);
  assert.deepEqual(eventsOf(f), ['failed']); assert.deepEqual(f.old.roomIds, ['shared']); assert.equal(f.room.value.queue.find(i => i.id === task).assignee, 'a');
});

test('R206: what an unreadable waiting record loses is asked for again, and ends nothing', async t => {
  const f = await handedOver(t), file = path.join(f.dir, 'queue-dispatch.json');
  f.person(); await f.pass(); await f.pass(31); assert.equal(f.asks().length, 1); f.client.reply('a', '补。');
  f.dispatcher.close(); const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(saved.rotations.a, { usedAt: 'x', gates: [1], left: 'x', missed: { tries: 0 } }); delete saved.rotations.a.supplement.item;
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  await f.restart(); const { usedAt, gates, left, missed } = f.dispatcher.rotations.a;
  assert.deepEqual([Number.isFinite(usedAt), gates?.includes(1) ?? false, left, missed], [true, false, undefined, undefined]);
  await f.pass(31); assert.equal(f.stopped('a'), false); assert.equal(f.asks().length, 2);
});

test('R206: the whole change of a butler, interrupted and across a restart, has exactly one butler throughout and needs no one', async t => {
  const f = await handedOver(t), seen = [];
  const only = () => { seen.push(f.role.current().sessionId); return seen.at(-1); };
  assert.equal(only(), 'a'); f.person(); await f.pass(); assert.equal(only(), 'a');
  await f.restart(); assert.equal(only(), 'a'); await f.pass(31); assert.equal(only(), 'a');
  f.client.reply('a', '补。'); await f.pass(); assert.equal(only(), 'a'); f.client.reply(f.newId, '收到。');
  const call = f.client.call.bind(f.client);
  f.client.call = async (method, ...args) => { const result = await call(method, ...args); only(); return result; };
  for (let i = 0; i < 3 && f.dispatcher.rotations.a; i += 1) await f.pass(31);
  assert.equal(only(), f.newId); assert.deepEqual([...new Set(seen)], ['a', f.newId]);
  assert.deepEqual(f.role.current(), { sessionId: f.newId, nativeId: `native-${f.newId}` }); assert.equal(f.session('a').state, 'ended');
  assert.deepEqual(f.role.selected, { sessionId: 'a', nativeId: 'native-a' }, 'the person\'s own choice is not written by NAW');
});

test('R206: a rotation waiting for its old session takes no slot, holds no one, and another due session is changed meanwhile', async t => {
  const other = member('o', { createdAt: NOW - 29 * HOUR, messages: heavyMessages(), cwd: '/tmp', lastActivityAt: NOW - 40 * MINUTE });
  const f = await handedOver(t, { others: [other] });
  f.person(); await f.pass(); await f.pass(1);
  assert.equal(f.client.sends('o').filter(call => call[4] === 'rotation:o').length, 1, 'the second one due is asked for its handoff');
  const waiting = f.dispatcher.rotations.a;
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [item('1', { assignee: 'm' })] }], [member('m')], { rotations: { x: { ...waiting, newId: 'm' }, m: { phase: 'kept', keptAt: NOW } } }).map(x => x.kind), ['dispatch']);
  assert.deepEqual(rules.queueVacancies({ rooms: [{ id: 'shared', name: 'Team', queue: [] }], sessions: [member('x'), member('m')], wakePolicy: AWAKE, now: NOW,
    rotations: { x: { ...waiting, newId: 'm' } } })[0].candidateIds, ['m', 'x']);
});

test('R206: the butler is still woken while its change waits for the person, and not while its addition is on its way', async t => {
  const f = await handedOver(t), skips = []; let event = false, woken = 0;
  f.dispatcher.stewardWake = { active: () => true, endHold() {}, hold: reason => skips.push(reason), due: () => event, patrolDue: () => null, clearBlocked() {}, skip: reason => skips.push(reason), controlSucceeded() {},
    wake: async (session, model, send) => { woken += 1; await send('【NAW】有新结果', `steward-wake:${woken}`); } };
  f.person(); await f.pass(); await f.pass(3); event = true; await f.pass(1);
  assert.equal(woken, 1, skips.join()); event = false; f.client.reply('a', '看过了。');
  await f.pass(31); assert.equal(f.asks().length, 1); event = true; f.client.reply('a', '补。'); await f.pass();
  assert.equal(woken, 1); assert.equal(f.tells().length, 1); f.client.reply(f.newId, '收到。'); event = false; await f.pass(); finished(f);
});

test('R206: two sessions due at once are both finished, each interrupted in its own way', async t => {
  const other = member('o', { createdAt: NOW - 29 * HOUR, messages: heavyMessages(), cwd: '/tmp', lastActivityAt: NOW - 40 * MINUTE });
  const f = await handedOver(t, { others: [other] });
  f.person(); await f.pass(); await f.pass();
  f.client.reply('o', '交接：o。'); await f.pass(); const oNew = f.client.state.sessions.at(-1).id; await f.pass();
  f.client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] }; f.session(oNew).state = 'idle'; await f.pass(); await f.pass(31);
  assert.deepEqual([f.stopped('a'), f.stopped('o')], [false, false]); assert.deepEqual([eventsOf(f), eventsOf(f, 'o')], [[], []]);
  f.client.state.rooms[0].run = null; await f.pass(1); assert.equal(f.session('o').state, 'ended');
  await supplemented(f); finished(f);
  assert.deepEqual(ROWS(f).filter(e => e.event === 'done').map(e => [e.old.id, e.new.id]).sort(), [['a', f.newId], ['o', oNew]].sort());
});

for (const state of ['ended', 'archived']) test(`R206: a successor ${state} while its old session was in use gives the work back, and the old one is changed again`, async t => {
  const f = await handedOver(t, { butler: false });
  f.person(); await f.pass();
  const task = f.room.queueAdd('给继任的', f.newId);
  f.session(f.newId).serviceCapabilities = [];
  if (state === 'ended') f.session(f.newId).state = 'ended'; else f.room.update({ archivedSessions: [f.newId] });
  await f.pass(1); if (state === 'ended') await f.pass(2);
  assert.equal(f.dispatcher.rotations.a, undefined); assert.deepEqual(eventsOf(f), ['failed']); assert.equal(ROWS(f).findLast(e => e.event === 'failed').reason, 'successor-gone');
  assert.equal(f.room.value.queue.find(i => i.id === task).assignee, 'a'); assert.equal(f.stopped('a'), false);
  const { follow } = require('../queue-secretary.cjs');
  assert.equal(follow(path.join(f.dir, 'rotation-log.jsonl'), { sessionId: 'a', nativeId: 'native-a' }).sessionId, 'a', 'no edge to the one that is gone');
});

test('R206: a successor that is away for now is waited for', async t => {
  const f = await handedOver(t);
  f.dispatcher.noteHuman('a'); await f.pass(); f.session(f.newId).state = 'recoverable'; await f.pass(31); await f.pass(25 * 60);
  assert.equal(f.stopped('a'), false); assert.ok(gatesOf(f).includes('successor-unavailable'));
  f.session(f.newId).state = 'idle'; await f.pass(1); finished(f);
});

test('R206: a successor changed for another meanwhile: the old session is finished to the one that holds the work now', async t => {
  const f = await handedOver(t);
  f.person(); await f.pass(); await f.pass(1);
  const next = member('n2', { roomIds: [], roomId: null }); f.client.state.sessions.push(next);
  f.dispatcher.appendLog('done', { oldId: f.newId, oldNativeId: `native-${f.newId}`, name: 'x', newId: 'n2', newNativeId: 'native-n2', newName: 'y', roomIds: [] });
  f.session(f.newId).state = 'ended';
  await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.tells('n2').length, 1); assert.equal(f.tells().length, 0);
  f.client.reply('n2', '收到。'); await f.pass();
  assert.equal(f.session('a').state, 'ended'); assert.deepEqual(f.role.current(), { sessionId: 'n2', nativeId: 'native-n2' });
});

// Its own finished rotation replaced the confirmed successor with n2.
const ONWARD = f => ({ oldId: f.newId, oldNativeId: `native-${f.newId}`, name: 'x', newId: 'n2', newNativeId: 'native-n2', newName: 'y', roomIds: [] });
function replaced(f, edges = [['done', {}]], ids = ['n2']) {
  for (const id of ids) f.client.state.sessions.push(member(id, f.role.selected ? { roomIds: [], roomId: null } : {}));
  for (const [event, change] of edges) f.dispatcher.appendLog(event, { ...ONWARD(f), ...change });
  f.session(f.newId).state = 'ended';
}
const butlers = f => f.client.state.sessions.filter(s => s.state !== 'ended' && s.id === f.role.current().sessionId && s.nativeId === f.role.current().nativeId).length;

for (const at of ['waiting', 'asked', 'sent', 'ended']) for (const again of [false, true])
test(`R206: a successor replaced by its own rotation while the old one is ${at}${again ? ', across a restart' : ''}: what it added goes to the session that has the work now, once`, async t => {
  const f = await handedOver(t), on = async () => { if (again) await f.restart(); replaced(f); if (again) await f.restart(); };
  const call = f.client.call.bind(f.client); let boundary = null;
  f.client.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === 'dispatch' && args[0] === 'n2') boundary = f.session('n2').messages.pop();
    return result;
  };
  f.person(); await f.pass(); await f.pass(1);
  if (at === 'ended') f.old.state = 'ended';
  if (at === 'waiting' || at === 'ended') await on();
  await f.pass(31); await f.pass(1); await f.pass(1);
  if (at !== 'ended') {
    assert.equal(f.asks().length, 1); assert.ok(f.asks()[0][2].includes(`已经交给「${at === 'waiting' ? f.dispatcher.name(f.session('n2')) : f.session(f.newId).name}」`), 'it names the one that is told');
    if (at === 'asked') await on();
    f.client.reply('a', '补。'); await f.pass();
  }
  if (at === 'sent') { assert.equal(f.tells().length, 1); f.session(f.newId).messages.pop(); await on(); await f.pass(31); }
  for (let i = 0; i < 4 && !f.tells('n2').length; i += 1) await f.pass(31);
  assert.equal(f.tells('n2').length, 1); assert.equal(f.tells().length, at === 'sent' ? 1 : 0, 'nothing more to the one that is gone');
  assert.match(f.tells('n2')[0][2], at === 'ended' ? /没有补写就结束了/ : /补。/);
  await f.pass(1); await f.pass(1); assert.equal(f.stopped('a'), false, 'not ended before it is confirmed there'); assert.deepEqual(eventsOf(f), []);
  f.session('n2').messages.push(boundary); f.client.reply('n2', '收到。'); for (let i = 0; i < 3 && f.dispatcher.rotations.a; i += 1) await f.pass(1);
  assert.equal(f.session('a').state, 'ended'); assert.deepEqual(eventsOf(f), ['done']); assert.equal(f.asks().length, at === 'ended' ? 0 : 1);
  assert.deepEqual(f.role.current(), { sessionId: 'n2', nativeId: 'native-n2' }); assert.equal(butlers(f), 1); assert.equal(f.client.calls.filter(c => c[0] === 'create').length, 1);
});

// Who has the work now is read by the rule the designation follows: where that stops at one that is gone, nothing is
// sent, ended or given back, and the old session stays what it is.
for (const [what, edges, ids] of [
  ['kept, and then finished', f => [['kept', { newId: 'n1', newNativeId: 'native-n1' }], ['done', {}]], ['n1', 'n2']],
  ['finished to two', f => [['done', {}], ['done', { newId: 'n3', newNativeId: 'native-n3' }]], ['n2', 'n3']],
  ['finished to one that replaced another too', f => [['done', {}], ['done', { oldId: 'z', oldNativeId: 'native-z' }]], ['n2']],
  ['finished to one whose native session is not known', f => [['done', { newNativeId: null }]], ['n2']],
  ['finished, with a line that cannot be read', f => [['done', {}]], ['n2']],
]) for (const butler of [true, false])
test(`R206: a successor ${what}: nothing is chosen for the ${butler ? 'butler' : 'member'}, and it waits and says so`, async t => {
  const f = await handedOver(t, { butler });
  f.person(); await f.pass(); await f.pass(1);
  const task = butler ? null : f.room.queueAdd('给继任的', f.newId);
  replaced(f, edges(f), ids);
  if (what.includes('cannot be read')) fs.appendFileSync(path.join(f.dir, 'rotation-log.jsonl'), '{"event":"done"\n');
  const told = () => [f.newId, ...ids].flatMap(id => f.tells(id)).length;
  await f.pass(31); f.client.reply('a', '补。'); await f.pass(); await f.pass(1);
  if (!what.includes('cannot be read')) await f.restart();
  for (const minutes of [1, 31, 25 * 60]) await f.pass(minutes);
  assert.equal(told(), 0); assert.equal(f.asks().length, 0); assert.equal(f.stopped('a'), false); assert.deepEqual(eventsOf(f), []);
  assert.equal(gatesOf(f).at(-1), butler && what.includes('cannot be read') ? 'designation-unreadable' : 'identity-ambiguous'); assert.equal(f.dispatcher.rotations.a.phase, 'handed'); assert.ok(f.dispatcher.rotations.a.told, 'the person is told once');
  if (task) assert.equal(f.room.value.queue.find(i => i.id === task).assignee, f.newId);
  if (butler && !what.includes('cannot be read')) { assert.equal(f.role.current().sessionId, 'a'); assert.equal(butlers(f), 1); }
});

for (const [what, change] of [['another one now', s => { s.nativeId = 'native-other'; }], ['not known', s => { s.nativeId = null; }]])
for (const onward of [false, true]) test(`R206: ${onward ? 'the one that replaced the successor' : 'a successor'} whose native session is ${what} is not told`, async t => {
  const f = await handedOver(t); f.person(); await f.pass(); await f.pass(1);
  if (onward) replaced(f);
  const id = onward ? 'n2' : f.newId, native = f.session(id).nativeId; change(f.session(id));
  await f.pass(31); if (f.asks().length) f.client.reply('a', '补。'); await f.pass(); await f.pass(1); await f.pass(1);
  assert.equal(f.tells(id).length, 0); assert.equal(f.stopped('a'), false); assert.equal(f.role.current().sessionId, 'a'); assert.equal(butlers(f), 1);
  if (what === 'another one now') { assert.deepEqual(eventsOf(f), ['failed']); return; }
  assert.deepEqual(eventsOf(f), []); assert.equal(gatesOf(f).at(-1), 'successor-unavailable'); assert.equal(f.asks().length, 0);
  f.session(id).nativeId = native; await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.tells(id).length, 1);
});

test('R206: a successor that was another native session before its own rotation had the handoff no more: its replacement is not told', async t => {
  const f = await handedOver(t); f.person(); await f.pass(); await f.pass(1);
  replaced(f, [['done', { oldNativeId: 'native-other' }]]);
  for (const minutes of [1, 1, 1]) await f.pass(minutes);
  assert.deepEqual(eventsOf(f), ['failed']); assert.equal(f.tells('n2').length, 0); assert.equal(f.stopped('a'), false); assert.equal(f.role.current().sessionId, 'a'); assert.equal(butlers(f), 1);
});

test('R206: a successor whose own rotation was kept still has the handoff, as the designation says', async t => {
  const f = await handedOver(t); f.person(); await f.pass(); await f.pass(1);
  replaced(f, [['kept', { newId: 'n1', newNativeId: 'native-n1' }]], ['n1']); f.session(f.newId).state = 'idle';
  await f.pass(31); await supplemented(f); assert.equal(f.tells('n1').length, 0); finished(f); assert.equal(f.role.current().sessionId, f.newId);
});

test('R206: what the old session still had in its space\'s queue goes to the one that replaced its successor', async t => {
  const f = await handedOver(t, { butler: false }); f.person(); await f.pass(); await f.pass(1); replaced(f);
  await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.tells('n2').length, 1); f.client.reply('n2', '收到。');
  const task = f.room.queueAdd('给旧会话的', 'a'); await f.pass(); assert.equal(f.session('a').state, 'ended');
  assert.equal(f.room.value.queue.find(i => i.id === task).assignee, 'n2');
});

test('R206: a successor whose native session was never recorded is not told', async t => {
  const f = await handedOver(t, { butler: false }); f.person(); await f.pass(); f.dispatcher.rotations.a.newNativeId = null;
  await f.pass(31); if (f.asks().length) f.client.reply('a', '补。'); await f.pass(); await f.pass(1);
  assert.equal(f.tells().length, 0); assert.equal(f.asks().length, 0); assert.equal(f.stopped('a'), false); assert.equal(gatesOf(f).at(-1), 'identity-ambiguous');
});

// The looks finishRotation takes before it stops the old session: the first before it leaves its spaces, the last after.
function atLook(f, which, change) {
  const touched = f.dispatcher.touchedSince.bind(f.dispatcher), refresh = f.client.refresh.bind(f.client); let looks = 0, armed = false;
  f.looks = () => looks;
  f.dispatcher.touchedSince = async (...args) => { looks += 1; armed = looks === which; return touched(...args); };
  f.client.refresh = async () => { const value = await refresh(); if (armed) { armed = false; change(); } return value; };
}
const BECOMES = {
  'another native session': s => { s.nativeId = 'native-other'; },
  'a session with no native identity': s => { s.nativeId = null; },
  'an ended session': s => { s.state = 'ended'; },
  'a session out of view': (s, f) => { f.client.state.sessions = f.client.state.sessions.filter(x => x !== s); },
};
for (const [what, change] of Object.entries(BECOMES)) for (const when of ['its handoff', 'what was added']) for (const butler of [true, false]) for (const which of [1, 2])
test(`R206: a successor that becomes ${what} in look ${which}, once ${when} is confirmed, leaves the old ${butler ? 'butler' : 'member'} running`, async t => {
  const f = await handedOver(t, { butler }), home = butler ? [] : ['shared'];
  if (when === 'what was added') {
    f.person(); await f.pass(); await f.pass(1); await f.pass(31); f.client.reply('a', '补。'); await f.pass();
    assert.equal(f.tells().length, 1); f.client.reply(f.newId, '并进来了。');
  }
  const successor = f.session(f.newId), was = { nativeId: successor.nativeId, state: successor.state };
  atLook(f, which, () => change(successor, f));
  await f.pass();
  assert.equal(f.looks(), which); assert.equal(f.stopped('a'), false, 'the old session is not stopped'); assert.notEqual(f.session('a').state, 'ended');
  assert.deepEqual(eventsOf(f), []); assert.equal(gatesOf(f).at(-1), 'successor-unavailable'); assert.deepEqual(f.old.roomIds, which === 1 ? home : []);
  if (butler) { assert.equal(f.role.current().sessionId, 'a'); assert.equal(butlers(f), 1); }
  if (what !== 'another native session') {
    Object.assign(successor, was); if (!f.session(f.newId)) f.client.state.sessions.push(successor);
    await f.pass(2); finished(f); assert.equal(f.tells().length, when === 'what was added' ? 1 : 0, 'and told nothing more');
    return;
  }
  await f.pass(1);
  assert.deepEqual(eventsOf(f), ['failed']); assert.equal(f.stopped('a'), false); assert.deepEqual(f.old.roomIds, home, 'back in its spaces');
  assert.equal(f.client.sends('native-other').length, 0); if (butler) assert.equal(f.role.current().sessionId, 'a');
});

for (const [what, change] of [
  ['becomes another native session', f => { f.session('n2').nativeId = 'native-other'; }],
  ['is put away', f => { f.room.update({ archivedSessions: ['n2'] }); }],
  ['is itself replaced by one that is not certain', f => { for (const id of ['n3', 'n4']) f.dispatcher.appendLog('done', { ...ONWARD(f), oldId: 'n2', oldNativeId: 'native-n2', newId: id, newNativeId: `native-${id}` }); }],
])
test(`R206: the one that replaced the successor ${what} in the last look: the old session is not stopped`, async t => {
  const f = await handedOver(t, { butler: false }); f.person(); await f.pass(); await f.pass(1); replaced(f);
  await f.pass(31); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.tells('n2').length, 1); f.client.reply('n2', '收到。');
  atLook(f, 2, () => change(f)); await f.pass();
  assert.equal(f.looks(), 2); assert.equal(f.stopped('a'), false); assert.deepEqual(eventsOf(f), []);
  assert.equal(gatesOf(f).at(-1), what.includes('not certain') ? 'identity-ambiguous' : 'successor-unavailable');
  await f.pass(2); assert.equal(f.stopped('a'), false);
  assert.deepEqual(eventsOf(f), what.includes('not certain') ? [] : ['failed']);
});

test('R206: a successor that stays itself through both looks has the old session ended, as before', async t => {
  for (const butler of [true, false]) {
    const f = await handedOver(t, { butler }); atLook(f, 2, () => {}); await f.pass(); assert.equal(f.looks(), 2); assert.equal(f.stopped('a'), true); finished(f);
  }
});

test('R206: who replaced the successor is read from the whole log, not from its last thousand lines', async t => {
  const f = await handedOver(t); f.person(); await f.pass(); await f.pass(1); replaced(f);
  for (let i = 0; i < 1001; i += 1) f.dispatcher.appendLog('requested', { oldId: `o${i}`, oldNativeId: `native-o${i}`, name: 'x', roomIds: [] });
  await f.pass(31); await f.pass(1); assert.deepEqual(eventsOf(f), []); f.client.reply('a', '补。'); await f.pass(); assert.equal(f.tells('n2').length, 1);
  f.client.reply('n2', '收到。'); await f.pass(); assert.equal(f.session('a').state, 'ended'); assert.deepEqual(f.role.current(), { sessionId: 'n2', nativeId: 'native-n2' });
});

test('R206: an identity that does not match is never upgraded', async t => {
  const f = await handedOver(t);
  f.person(); await f.pass(); f.old.nativeId = 'native-other'; await f.pass(31);
  assert.equal(f.stopped('a'), false); assert.deepEqual(eventsOf(f), ['kept']); assert.equal(ROWS(f).at(-1).reason, 'identity-changed');
  assert.equal(f.role.current().sessionId, 'a'); assert.equal(f.dispatcher.rotations.a.phase, 'kept');
});

test('R206: two successors are never chosen between: the change waits and says so', async t => {
  const f = await handedOver(t);
  fs.appendFileSync(path.join(f.dir, 'rotation-log.jsonl'), JSON.stringify({ time: NOW - HOUR, event: 'kept', spaces: [], old: { id: 'a', nativeId: 'native-a', name: 'x' }, new: { id: 'earlier', nativeId: 'native-earlier', name: 'x' } }) + '\n');
  await f.pass(); await f.pass(25 * 60);
  assert.equal(f.stopped('a'), false, 'it would leave no butler'); assert.deepEqual(gatesOf(f), ['identity-ambiguous']); assert.equal(f.role.current().sessionId, 'a');
  assert.deepEqual(ROWS(f).filter(e => e.event === 'done'), []);
});

test('R206: a designation the person moved is theirs: no old kept or done line moves it, and their old session is left to them', async t => {
  const f = await handedOver(t);
  f.person(); await f.pass(); f.role.set({ sessionId: 'mine', nativeId: 'native-mine' });
  await f.pass(31); await f.pass(25 * 60);
  assert.equal(f.stopped('a'), false); assert.equal(f.old.archived, undefined); assert.equal(f.asks().length, 0);
  assert.deepEqual(eventsOf(f), ['kept']); assert.equal(ROWS(f).findLast(e => e.event === 'kept').reason, 'designation-changed');
  f.dispatcher.appendLog('done', { oldId: 'a', oldNativeId: 'native-a', name: 'x', newId: f.newId, newNativeId: `native-${f.newId}`, newName: 'y', roomIds: [] });
  assert.deepEqual(new StewardRole(f.dir).current(), { sessionId: 'mine', nativeId: 'native-mine' });
  // Once they chose the successor themselves, the old session is ended and the choice stays.
  const g = await handedOver(t);
  g.person(); await g.pass(); g.role.set({ sessionId: g.newId, nativeId: `native-${g.newId}` }); await g.pass(31);
  await supplemented(g); finished(g); assert.equal(g.role.current().sessionId, g.newId);
});

// What an earlier version left: the old session kept, its successor resting, the old one used since, one name for both.
test('R206: a kept record of an earlier version is read as it is, its old session is left alone, and the person\'s designation goes on from theirs', async t => {
  const same = '大管家续32', rows = [{ id: 'h', role: 'user', text: '后来的话', time: NOW - HOUR }, { id: 'h2', role: 'assistant', text: '好', time: NOW - HOUR }];
  const due = { createdAt: NOW - 30 * HOUR, cwd: '/tmp', lastActivityAt: NOW - 40 * MINUTE, roomIds: [], roomId: null };
  const old = member('k', { ...due, name: same, messages: [...heavyMessages(), ...rows] }), next = member('k2', { ...due, name: same }), mine = member('a', { ...due, name: same, messages: heavyMessages() });
  let f = null, clock = NOW;
  const s = dispatcherSetup(t, [old, next, mine], { clients: () => f?.client, steward: stewardFrom(() => f?.role) });
  f = { ...s, role: new StewardRole(s.dir) }; f.role.set({ sessionId: 'a', nativeId: 'native-a' }); fakeMembership(f.room, f.client);
  const line = { time: NOW - 3 * HOUR, event: 'kept', spaces: [], old: { id: 'k', nativeId: 'native-k', name: same }, new: { id: 'k2', nativeId: 'native-k2', name: same } };
  fs.writeFileSync(path.join(f.dir, 'rotation-log.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(f.dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: {
    k: { phase: 'kept', keptAt: NOW - 3 * HOUR, oldNativeId: 'native-k', name: same, roomIds: [] },
    k2: { phase: 'kept', keptAt: NOW - 3 * HOUR, oldNativeId: 'native-k2', name: same, roomIds: [], successorOf: 'k' } } }), { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: f.room, dataDir: f.dir, connect: async () => f.client, clients: () => f.client, now: () => clock, settleMs: 0, tickMs: HOUR, steward: stewardFrom(() => f.role) });
  t.after(() => dispatcher.close());
  const pass = async minutes => { clock += minutes * MINUTE; dispatcher.dirty = true; await dispatcher.schedule(); };
  await dispatcher.start(); await pass(0);
  assert.deepEqual(Object.keys(dispatcher.rotations).sort(), ['a', 'k', 'k2']);
  f.client.reply('a', '交接：x。'); await pass(0); const created = f.client.state.sessions.at(-1); await pass(0);
  assert.notEqual(created.name, same); assert.equal(f.client.state.sessions.filter(x => x.name === created.name).length, 1);
  created.state = 'idle'; dispatcher.noteHuman('a'); await pass(0); assert.equal(mine.state, 'idle'); await pass(31);
  assert.equal(mine.state, 'ended'); assert.deepEqual(f.role.current(), { sessionId: created.id, nativeId: created.nativeId });
  assert.deepEqual(f.role.selected, { sessionId: 'a', nativeId: 'native-a' });
  assert.equal(old.state, 'idle'); assert.equal(old.archived, undefined); assert.equal(f.client.sends('k').length, 0); assert.equal(f.client.sends('k2').length, 0);
});

test('R206: the successor is not given a name a session or an earlier successor has', async t => {
  const f = await handedOver(t, { others: [member('o', { name: rules.nextName('Agent a'), roomIds: [], roomId: null })] });
  assert.equal(f.session(f.newId).name, rules.nextName(rules.nextName('Agent a')));
  await f.pass(); finished(f); assert.equal(ROWS(f).find(e => e.event === 'done').new.id, f.newId, 'the line points at the one the change made');
});

test('R206: the change is not done while its line is not in the log the designation is read from', async t => {
  const f = await handedOver(t);
  const append = fs.appendFileSync; let refuse = true;
  fs.appendFileSync = (file, ...rest) => { if (refuse && String(file).endsWith('rotation-log.jsonl')) throw Error('disk full'); return append(file, ...rest); };
  t.after(() => { fs.appendFileSync = append; });
  await f.pass(); assert.equal(f.role.current().sessionId, 'a'); assert.equal(f.dispatcher.rotations.a?.phase, 'handed', 'kept on record, to be written');
  refuse = false; await f.pass(2); await f.pass(2);
  assert.equal(f.dispatcher.rotations.a, undefined); assert.equal(f.role.current().sessionId, f.newId);
});
