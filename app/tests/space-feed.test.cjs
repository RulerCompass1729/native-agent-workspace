const test = require('node:test'), assert = require('node:assert/strict');
const stream = require('../task-stream.js');

// R249: a synthetic space with the person, two members, NAW's queue records and the space's own records.
const notice = (id, time, key, params, extra = {}) => ({ id, kind: 'queue', time, uiMessage: { key, params }, ...extra });
function space() {
  const room = { id: 'r1', queue: [
    { id: 'item1', text: '【NAW 派活】Fix the input box. Full task text here.', status: 'done', sentTo: 'A', createdAt: 30, sentAt: 40, finishedAt: 45, ready: { branch: 'lane/x', commit: 'abc1234def' } },
    { id: 'item2', text: 'Pick the icon style', status: 'waiting', sentTo: 'B', createdAt: 50, sentAt: 52, reply: '需要你决定：线框还是实心？推荐线框' },
  ], messages: [
    { id: 'h1', role: 'human', recipientId: 'A', text: 'A, please check the build.', time: 10, deliveries: [{ id: 'tagA1', recipientId: 'A', recipientName: 'A' }] },
    { id: 'sys', role: 'system', name: '协作', text: '协作已暂停', time: 11 },
    { id: 'tool', role: 'tool', sessionId: 'A', sharedStream: true, sourceTag: 'tagA1', nativeMessageId: 'a-tool', text: 'npm test', time: 13 },
    { id: 'fin', role: 'assistant', sessionId: 'A', sharedStream: true, finalReply: true, status: 'complete', nativeMessageId: 'a-final', text: 'Build passes.', time: 15 },
    { id: 'w1', role: 'system', kind: 'agent-wake', text: 'B, take the docs.', time: 20,
      wake: { id: 'wake1', senderId: 'A', recipientId: 'B', senderName: 'A', recipientName: 'B', body: 'B, take the docs.' } },
  ], events: [
    { id: 'j1', kind: 'join', sessionId: 'B', name: 'B', time: 5, uiMessage: { key: 'notice.room.joined' } },
    notice('q0', 30, 'notice.queue.added', { text: '【NAW 派活】Fix the input box. Full task text here.' }, { itemId: 'item1' }),
    notice('q1', 40, 'notice.queue.dispatched', { text: '【NAW 派活】Fix the input box. Full task text here.', name: 'A' }, { sessionId: 'A', itemId: 'item1' }),
    notice('q2', 45, 'notice.queue.ready', { text: 'Fix the input box', name: 'A', branch: 'lane/x', commit: 'abc1234def' }, { sessionId: 'A', itemId: 'item1' }),
    notice('q3', 52, 'notice.queue.dispatched', { text: 'Pick the icon style', name: 'B' }, { sessionId: 'B', itemId: 'item2' }),
    notice('q4', 55, 'notice.queue.waiting', { text: 'Pick the icon style', name: 'B' }, { sessionId: 'B', itemId: 'item2' }),
    { id: 'd1', kind: 'queue', sessionId: 'B', itemId: 'item0', text: 'Old item done', time: 3, monitor: { kind: 'done', itemId: 'item0' } },
  ] };
  const A = { id: 'A', name: 'A', nativeId: 'nA', state: 'idle', messages: [
    { id: 'tagA1', role: 'user', origin: 'room', text: 'A, please check the build.', time: 10 },
    { id: 'a-final', role: 'assistant', status: 'complete', text: 'Build passes.', time: 15 },
    { id: 'dsp', role: 'user', origin: 'naw-dispatch', dispatchItem: 'item1', dispatchPurpose: { kind: 'queue' }, text: '【NAW 派活】Fix the input box.', time: 40 },
    { id: 'a-done', role: 'assistant', status: 'complete', text: 'Fixed.\nREADY lane/x abc1234', time: 44 },
  ] };
  const B = { id: 'B', name: 'B', nativeId: 'nB', state: 'idle', messagesOmitted: true, messages: [] };
  return { room, sessions: [A, B] };
}
const line = i => `${i.kind}|${i.fromKind === 'person' ? '你' : i.fromKind === 'naw' ? 'NAW' : i.fromName}>${i.to.map(t => t.name).join(',')}|${i.text ?? '(record)'}`;

test('the feed is one line per thing, newest first, with each kind of record once', () => {
  const { room, sessions } = space();
  assert.deepEqual(stream.spaceFeed(room, { sessions }).map(line), [
    'wait|B>|线框还是实心？推荐线框',
    'dispatch|NAW>B|Pick the icon style',
    'ready|A>|READY lane/x abc1234def · Fix the input box. Full task text here.',
    'reply|A>|Fixed.\nREADY lane/x abc1234',
    'dispatch|NAW>A|【NAW 派活】Fix the input box. Full task text here.',
    'queue|>|(record)',
    'say|A>B|B, take the docs.',
    'reply|A>|Build passes.',
    'space|>|(record)',
    'say|你>A|A, please check the build.',
    'join|B>|(record)',
    'done|B>|Old item done',
  ]);
});

test('NAW dispatch input and mirrored tool rows are not lines of their own', () => {
  const { room, sessions } = space(), feed = stream.spaceFeed(room, { sessions });
  assert.equal(feed.filter(i => i.text?.includes('npm test')).length, 0);
  assert.equal(feed.filter(i => i.kind === 'dispatch' && i.to[0].id === 'A').length, 1);
  assert.equal(feed.filter(i => i.text === 'Build passes.').length, 1);
});

test('a line opens to the whole task, and a wait knows whether it still waits', () => {
  const { room, sessions } = space(), feed = stream.spaceFeed(room, { sessions });
  const dispatch = feed.find(i => i.kind === 'dispatch' && i.to[0].id === 'A');
  assert.equal(dispatch.body, '【NAW 派活】Fix the input box. Full task text here.');
  const wait = feed.find(i => i.kind === 'wait');
  assert.equal(wait.taskStatus, 'decide');
  assert.equal(wait.itemId, 'item2');
  assert.match(wait.body, /需要你决定：线框还是实心/);
  assert.deepEqual(wait.target, { sessionId: 'B', nativeId: '', messageId: '' });
});

test('filters: kind group, any of the chosen people, and words', () => {
  const { room, sessions } = space(), feed = stream.spaceFeed(room, { sessions });
  const pick = options => feed.filter(i => stream.feedMatches(i, options)).map(line);
  assert.deepEqual(pick({ group: 'wait' }), ['wait|B>|线框还是实心？推荐线框']);
  assert.deepEqual(pick({ group: 'say', people: ['B'] }), ['say|A>B|B, take the docs.']);
  assert.deepEqual(pick({ group: 'say', people: ['@person'] }), ['say|你>A|A, please check the build.']);
  assert.equal(pick({ people: ['A', 'B'] }).length, feed.filter(i => i.involved.some(id => id === 'A' || id === 'B')).length);
  assert.deepEqual(pick({ query: 'full task' }), ['ready|A>|READY lane/x abc1234def · Fix the input box. Full task text here.', 'dispatch|NAW>A|【NAW 派活】Fix the input box. Full task text here.']);
  assert.deepEqual(pick({ query: 'FULL TASK', words: i => i.row?.uiMessage?.params?.text || '' }).length, 3);
  assert.deepEqual(pick({ query: '暂停', words: i => i.row?.text || '' }), ['space|>|(record)']);
});

test('an empty or missing space has an empty feed', () => {
  assert.deepEqual(stream.spaceFeed(null), []);
  assert.deepEqual(stream.spaceFeed({ id: 'x' }), []);
});

// Rework 1, F1 (the person, 11-25 19:09: 「信息流能把所有 对应 agent 的消息包含进去」): a member still in its turn.
function working() {
  const { room, sessions } = space();
  const A = sessions[0];
  A.state = 'working';
  A.messages.push(
    { id: 'dsp2', role: 'user', origin: 'naw-dispatch', dispatchItem: 'item3', dispatchPurpose: { kind: 'queue' }, text: '【NAW 派活】Write the doc.', time: 60 },
    { id: 'a-1', role: 'assistant', status: 'complete', text: 'Plan: 1. input box 2. doc', time: 61 },
    { id: 'a-tool2', role: 'tool', kind: 'tool', volatile: true, text: 'npm test', time: 62 },
    { id: 'a-com2', role: 'assistant', kind: 'response', phase: 'commentary', status: 'complete', text: 'Reading files', time: 62.5 },
    { id: 'a-2', role: 'assistant', kind: 'response', status: 'complete', text: 'Doc half written.', time: 63 },
    { id: 'a-3', role: 'assistant', kind: 'response', status: 'streaming', text: 'Now the sec', time: 64 },
  );
  return { room, sessions };
}
const replies = (feed, id) => feed.filter(i => i.kind === 'reply' && i.fromId === id).map(i => i.text);

test('a working member: every reply it finished is in the feed, the half-written one is not', () => {
  const { room, sessions } = working(), feed = stream.spaceFeed(room, { sessions });
  assert.deepEqual(replies(feed, 'A'), ['Doc half written.', 'Plan: 1. input box 2. doc', 'Fixed.\nREADY lane/x abc1234', 'Build passes.']);
  assert.ok(!feed.some(i => /Now the sec|Reading files/.test(i.text ?? '')));
});

test('总览 「最后说的话」 is the newest reply the feed shows for that member', () => {
  const { room, sessions } = working(), feed = stream.spaceFeed(room, { sessions });
  assert.equal(stream.lastReply(sessions[0]).text, replies(feed, 'A')[0]);
  sessions[0].state = 'idle';
  assert.equal(stream.lastReply(sessions[0]).text, replies(stream.spaceFeed(room, { sessions }), 'A')[0]);
});

test('a member whose messages this window omits shows its last reply once, the same in 总览', () => {
  const { room, sessions } = space(), B = sessions[1];
  B.messageSummary = { lastAssistant: { id: 'b-last', role: 'assistant', status: 'complete', text: 'Icons drafted.', time: 54 } };
  const feed = stream.spaceFeed(room, { sessions });
  assert.deepEqual(replies(feed, 'B'), ['Icons drafted.']);
  assert.equal(stream.lastReply(B).text, 'Icons drafted.');
  B.messageSummary.lastAssistant = { id: 'b-com', role: 'assistant', phase: 'commentary', text: 'Looking', time: 56 };
  assert.deepEqual(replies(stream.spaceFeed(room, { sessions }), 'B'), []);
  assert.equal(stream.lastReply(B), null);
});

test('the phone keeps each turn\'s last reply: speechStream without every is unchanged', () => {
  const { room, sessions } = working();
  assert.ok(!stream.speechStream(room, { sessions }).some(i => i.text === 'Plan: 1. input box 2. doc'));
});

// Review 1, F8: an answered wait is no longer 「等你」, and the question is not shown twice.
test('the wait line carries the question once; the member\'s reply that asked it is not repeated', () => {
  const { room, sessions } = space(), B = sessions[1];
  B.messagesOmitted = false;
  B.messages = [{ id: 'b-ask', role: 'assistant', status: 'complete', text: '需要你决定：线框还是实心？推荐线框\n理由：和侧栏一致。', time: 54 }];
  const feed = stream.spaceFeed(room, { sessions });
  assert.deepEqual(feed.filter(i => i.fromId === 'B' && /线框还是实心/.test(i.text ?? '')).map(i => i.kind), ['wait']);
  assert.match(feed.find(i => i.kind === 'wait').body, /理由：和侧栏一致/);
});

test('a wait the person answered is a 「已处理」 line, not 「等你」; only the newest wait of an open item waits', () => {
  const { room } = space();
  room.queue[1].status = 'sent';
  let feed = stream.spaceFeed(room, { sessions: [] });
  assert.deepEqual(feed.filter(i => i.itemId === 'item2' && ['wait', 'answered'].includes(i.kind)).map(i => i.kind), ['answered']);
  assert.ok(!stream.feedMatches(feed.find(i => i.kind === 'answered'), { group: 'wait' }));
  room.queue[1].status = 'waiting';
  room.events.push(notice('q5', 58, 'notice.queue.waiting', { text: 'Pick the icon style', name: 'B' }, { sessionId: 'B', itemId: 'item2' }));
  feed = stream.spaceFeed(room, { sessions: [] });
  assert.deepEqual(feed.filter(i => i.itemId === 'item2' && ['wait', 'answered'].includes(i.kind)).map(i => i.kind), ['wait', 'answered']);
});
