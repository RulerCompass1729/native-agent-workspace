const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const uiLocale = require('../ui-locale.js');
const { StewardRole } = require('../steward-role.cjs');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const AWAKE = { enabled: true };
const GUARDED_STOP = 'guardedSessionStopV1';
const CONDITIONAL_STOP = 'conditionalMaintenanceStopV1';
const PARTICIPANT_STOP = 'participantMaintenanceStopV1';
const { sessionPlan, sameStop } = require('../backend-switch.cjs');

function member(id, extra = {}) {
  return {
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
  // The person answers in that session, so NAW starts no new one while the decision is open: a member due for one
  // gets its next item where it is, and is not rotated when quiet either.
  const old = member('a', { createdAt: NOW - 25 * HOUR, messages: [...heavyMessages(), ...messages] });
  assert.deepEqual(plan(later, [old]), [next]);
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' })] }], [old]), []);
  // Once the person has handled it, the session is rotated as any other before its next item.
  const handled = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'done' }), item('2', { assignee: 'a' })] }];
  assert.deepEqual(plan(handled, [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'content' }]);
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

test('a decision on an item that was refused once before it went out is still a decision: no new session until it is handled', t => {
  // Since 11-13 the send drops the refusal (queueMarkSent); an item saved by an older build still carries it through
  // the decision's settle (independent review, 11-12). Both keep their member's session.
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
    assert.deepEqual(plan(rooms, [old]), [sent]);
    // With nothing queued behind it, the space can take more work.
    const open = [{ id: 'shared', name: 'Team', queue: [items[0]] }];
    const vacancy = rules.queueVacancies({ rooms: open, sessions: [member('a')], wakePolicy: AWAKE, idleSince: settledSince(['a']), now: NOW });
    assert.equal(vacancy[0].active, true);
    assert.deepEqual(vacancy[0].candidateIds, ['a']);
  }
});

test('a reply is found by send time when a native record replaced the NAW message id', () => {
  const messages = [
    { id: 'old', role: 'assistant', text: 'earlier work', time: NOW - 90000 },
    { id: 'native-user', role: 'user', text: 'NAW task', origin: 'naw-dispatch', time: NOW - 29000 },
    { id: 'r1', role: 'assistant', text: 'finished', time: NOW - 20000 },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'done', sessionId: 'a', reply: 'finished' },
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
  const waiting = item('2', { status: 'waiting', sentTo: 'a', sentAt: NOW - 2 * HOUR, tag: 't2' });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [waiting] }], [quiet]), []);
  // An item that asks the person nothing does not keep the member from its rotation either.
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
    this.capabilities = [rules.CAPABILITY, GUARDED_STOP, CONDITIONAL_STOP, PARTICIPANT_STOP];
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
    if (method === 'dispatch') {
      this.sequence += 1;
      const tag = `tag-${this.sequence}`;
      session.messages.push({ id: tag, role: 'user', text: args[1], origin: 'naw-dispatch', status: 'submitted' });
      session.state = 'working';
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
    session.messages.push({ id: `reply-${session.messages.length}`, role: 'assistant', text });
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
test('a claim with no stored turn input settles on what the member says from the claim\'s time on', async t => {
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
  assert.deepEqual([item.status, item.reason, item.reply], ['done', undefined, 'Done: the board task.'], 'the person\'s older request is not read as stepping in');
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

test('the pause counts from the session\'s own last activity, and the butler\'s compaction waits only its two minutes', t => {
  const { dispatcher } = dispatcherSetup(t, []);
  dispatcher.deferredAt.set('a', { at: NOW, due: 'compact' });
  dispatcher.deferredAt.set('b', { at: NOW, due: 'compact' });
  dispatcher.deferredAt.set('c', { at: NOW, due: 'memory' });
  dispatcher.deferredAt.set('gone', { at: NOW, due: 'compact' });
  const sessions = [member('a', { lastActivityAt: NOW + 25 * 60 * 1000 }), member('b'), member('c')];
  const at = minutes => [...dispatcher.personDeferred(sessions, 'b', NOW + minutes * 60 * 1000)].sort();
  assert.deepEqual(at(1), ['a', 'b', 'c']);
  assert.deepEqual(at(3), ['a', 'c'], 'the butler\'s compaction waits two minutes');
  assert.deepEqual(at(11), ['a'], 'memory waits ten');
  assert.deepEqual(at(54), ['a'], 'thirty minutes from its last activity, not from the pause');
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
  assert.equal(plan(rooms, [member('a', { messages: replaced })])[0].status, 'done');
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

test('while the old session waits for a collaboration, the new member already takes work, and the wait is bounded', async t => {
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
  assert.equal(dispatcher.rotations.a.phase, 'kept');
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

test('a rotation whose old session already ended finishes at once even while a collaboration runs', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  client.state.sessions[0].state = 'ended';
  client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a, undefined, 'record finished without waiting');
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
  const replies = ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;95;0c', '\x1b[0n', '\x1b[?2004;1$y', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[<35;10;5M'];
  for (const reply of replies) {
    assert.equal(isTerminalResponse(reply), true, JSON.stringify(reply));
    assert.equal(rules.terminalReplyOnly(reply), true, JSON.stringify(reply));
  }
  assert.equal(rules.terminalReplyOnly('\x1b[I'), true, 'focus in');
  assert.equal(rules.terminalReplyOnly('\x1b[O'), true, 'focus out');
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
  assert.deepEqual(rules.carrySettings(codex), { settings: { model: 'gpt-6.1-sol', effort: 'ultra' }, view: 'chat' }, 'a Codex successor starts in chat view');
  const planning = member('c', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'high', mode: 'plan' } });
  assert.deepEqual(rules.carrySettings(planning), { reason: 'collaboration-mode' });
  const twoSpaces = member('a', { roomIds: ['shared', '308f55b3-ec97-467c-a2b8-1ecc47562029'] });
  assert.deepEqual(rules.carrySettings(twoSpaces), { reason: 'several-spaces' });
  // DeepSeek through Codex: the successor starts from the same Codex profile, and must run the same vendor.
  const deepseek = member('d', { provider: 'codex', model: 'deepseek-v4-pro', modelProvider: 'deepseek', requestedSettings: { profile: 'deepseek-pro' }, nativeSettings: { model: 'deepseek-v4-pro', effort: 'high', mode: null } });
  assert.deepEqual(rules.carrySettings(deepseek), { settings: { model: 'deepseek-v4-pro', effort: 'high', profile: 'deepseek-pro' }, view: 'chat', modelProvider: 'deepseek' });
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
  assert.ok(client.calls.some(call => call[0] === 'stop' && call[1] === fresh.id), 'the successor is stopped');
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
  return { client, notices, dir };
}

// 换续前发送不丢话 (2026-11-14): a send the person makes after NAW's last check reaches the old session before
// the stop does. The stop is then refused by the service: the old session keeps the words and answers them,
// the rotation is recorded as kept, and the designation (which follows only done lines) stays with it.
for (const capable of [true, false]) test(`a send that reaches the old session just before its stop keeps it (${capable ? 'conditional stop' : 'old service'})`, async t => {
  const notices = [];
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })],
    { notify: kind => notices.push(kind) });
  fakeMembership(room, client);
  if (!capable) client.capabilities = [rules.CAPABILITY, GUARDED_STOP];
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
  assert.deepEqual(notices, ['kept']);
  const log = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const last = log.at(-1);
  assert.equal(last.event, 'kept');
  assert.equal(last.reason, capable ? 'changed-at-stop' : 'old-service', 'the log says why it was kept');
  assert.equal(last.new.id, newId);
  const { follow } = require('../queue-secretary.cjs');
  assert.equal(follow(path.join(dir, 'rotation-log.jsonl'), { sessionId: 'a', nativeId: old.nativeId }).sessionId, 'a', 'the designation stays with the old session');
  assert.equal(dispatcher.rotations.a.phase, 'kept');
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
  assert.match(handoff, /要是人这时还在用它，就留给人用完自己关，这个空间里没指定成员的活 NAW 之后派给你/);
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

test('finding 2: the butler\'s handoff says the designation stays with a kept old session', () => {
  const text = rules.handoffText('大管家', '交接', '', '【大管家职责】');
  assert.match(text, /要是人这时还在用旧会话，它就留给人用，大管家仍是它，直到人另行指定/);
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
  const { client, notices } = await rotateTypedSession(t, false, false, true);
  assert.equal(client.calls.some(call => call[0] === 'stop' && call[1] === 'a'), false);
  assert.deepEqual(notices, ['kept']);
});

test('a session the person starts using just before the stop keeps its spaces and process', async t => {
  const notices = [];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, messages: heavyMessages(), cwd: '/tmp' })], {
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
  const seen = [];
  return { seen, counts, async sample(sessions) { seen.push(sessions.map(session => session.id)); return new Map(Object.entries(counts)); } };
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
  assert.equal(client.sends('z').length, 0);
  assert.match(rules.handoffRequestText('X'), /^【NAW 换会话】X。为了释放内存，NAW 会开一个新会话接着做/);
  assert.match(rules.handoffRequestText('X', 'content'), /^【NAW 换会话】X。为了释放内存，/);
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
