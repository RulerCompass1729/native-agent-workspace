const test = require('node:test'), assert = require('node:assert/strict');
const stream = require('../task-stream.js');

// A synthetic space: the person, the butler (not a member) and members A and B, with NAW's own records mixed in.
const queueEvent = (id, time) => ({ id, kind: 'queue', role: 'system', time, uiMessage: { key: 'notice.queue.dispatched', params: { text: 'Task', name: 'A' } } });
function space() {
  const room = { id: 'r1', messages: [
    { id: 'h1', role: 'human', recipientId: 'A', name: '你 → A', text: 'A, please check the build.', time: 10, deliveries: [{ id: 'tagA1', recipientId: 'A', recipientName: 'A' }] },
    { id: 'sys', role: 'system', name: '协作', text: '协作已暂停', time: 11 },
    { id: 'card', role: 'system', kind: 'background-operation', text: 'Confirm rename', time: 12, backgroundOperation: { id: 'op' } },
    { id: 'tool', role: 'tool', sessionId: 'A', sharedStream: true, sourceTag: 'tagA1', nativeMessageId: 'a-tool', text: 'npm test', time: 13 },
    { id: 'mid', role: 'assistant', sessionId: 'A', sharedStream: true, sourceTag: 'tagA1', nativeMessageId: 'a-mid', status: 'streaming', text: 'Let me look', time: 14 },
    { id: 'fin', role: 'assistant', sessionId: 'A', sharedStream: true, sourceTag: 'tagA1', nativeMessageId: 'a-final', finalReply: true, status: 'complete', text: 'Build passes.', time: 15 },
    { id: 'w1', role: 'system', kind: 'agent-wake', name: 'A → B', text: '发给原会话的自动消息：原生已接收。\nB, take the docs.', time: 20,
      wake: { id: 'wake1', senderId: 'A', recipientId: 'B', senderName: 'A', recipientName: 'B', body: 'B, take the docs.' } },
    { id: 'p1', role: 'system', kind: 'agent-peer', name: '「X」（未核实） → B', text: '会话间消息（Claude Code 自带，未经 NAW 转交；发送方未核实）\nhello from outside', time: 30,
      peerMessage: { senderId: null, senderName: 'X', recipientId: 'B', recipientName: 'B' } },
  ], events: [queueEvent('q1', 9), queueEvent('q2', 16)] };
  const A = { id: 'A', name: 'A', nativeId: 'nA', state: 'idle', messages: [
    { id: 'tagA1', role: 'user', origin: 'room', name: '你', text: 'A, please check the build.', time: 10 },
    { id: 'a-tool', role: 'assistant', kind: 'tool', text: 'npm test', time: 13 },
    { id: 'a-mid', role: 'assistant', status: 'complete', text: 'Let me look', time: 14 },
    { id: 'a-final', role: 'assistant', status: 'complete', text: 'Build passes.', time: 15 },
    { id: 'd1', role: 'user', origin: 'naw-dispatch', name: 'NAW 派活', dispatchItem: 'item1', dispatchPurpose: { kind: 'queue' }, text: '【NAW 派活】Fix the input.', time: 40 },
    { id: 'a-com', role: 'assistant', status: 'complete', phase: 'commentary', text: 'Reading files', time: 41 },
    { id: 'a-done', role: 'assistant', status: 'complete', text: 'Fixed.\nREADY lane/x abc1234', time: 42 },
    { id: 'rec', role: 'user', origin: 'capacity-recovery', name: 'NAW', text: 'continue', time: 43 },
    { id: 'sw', role: 'user', origin: 'naw-dispatch', dispatchItem: 'steward-wake:1', dispatchPurpose: { kind: 'queue' }, text: '【NAW 事件】', time: 44 },
  ] };
  const B = { id: 'B', name: 'B', nativeId: 'nB', state: 'idle', messages: [
    { id: 'bw', role: 'user', origin: 'agent-wake', name: '来自 A', text: '[Workspace message from A · A at 2026-11-23T00:00:00.000Z]\nB, take the docs.', time: 20, wakeSource: { id: 'wake1', senderId: 'A' } },
    { id: 'bw2', role: 'user', origin: 'agent-wake', name: '来自 大管家', text: '[Workspace message from 大管家 · S at 2026-11-23T00:00:50.000Z]\nB, report status.', time: 50, wakeSource: { id: 'wake2', senderId: 'S' } },
    { id: 'b1', role: 'assistant', status: 'complete', text: 'Status: docs half done.', time: 51 },
    { id: 'bt', role: 'user', origin: 'native', inputSource: 'user', text: 'typed in the terminal', time: 60 },
    { id: 'bm', role: 'user', origin: 'native', inputSource: 'codex_wakeup', name: '定时唤醒', text: 'wake', time: 61 },
  ] };
  const S = { id: 'S', name: '大管家', nativeId: 'nS', state: 'idle', messages: [] };
  return { room, sessions: [A, B, S] };
}
const view = items => items.map(i => `${i.fromKind === 'person' ? '你' : i.fromKind === 'dispatch' ? 'NAW' : i.fromName} → ${i.to.map(t => t.name).join('、') || '-'}: ${i.text}`);

test('a space with the butler, A, B and NAW records shows only what was said, oldest first', () => {
  const { room, sessions } = space();
  assert.deepEqual(view(stream.speechStream(room, { sessions })), [
    '你 → A: A, please check the build.',
    'A → -: Build passes.',
    'A → B: B, take the docs.',
    '「X」 → B: hello from outside',
    'NAW → A: 【NAW 派活】Fix the input.',
    'A → -: Fixed.\nREADY lane/x abc1234',
    '大管家 → B: B, report status.',
    'B → -: Status: docs half done.',
    '你 → B: typed in the terminal',
  ]);
});
test('an outside sender stays marked unverified', () => {
  const { room, sessions } = space();
  const peer = stream.speechStream(room, { sessions }).find(i => i.text === 'hello from outside');
  assert.equal(peer.unverified, true);
  assert.equal(peer.fromId, '');
});
test('filtering to A keeps only what A said and what was sent to A', () => {
  const { room, sessions } = space();
  const items = stream.speechStream(room, { sessions }).filter(i => stream.speechInvolves(i, 'A'));
  assert.deepEqual(view(items), [
    '你 → A: A, please check the build.',
    'A → -: Build passes.',
    'A → B: B, take the docs.',
    'NAW → A: 【NAW 派活】Fix the input.',
    'A → -: Fixed.\nREADY lane/x abc1234',
  ]);
});
test('a turn still running shows no reply until it ends', () => {
  const { room, sessions } = space();
  sessions[1].messages = sessions[1].messages.slice(0, 3);
  sessions[1].state = 'working';
  const items = stream.speechStream(room, { sessions });
  assert.ok(!items.some(i => i.text === 'Status: docs half done.'));
  assert.ok(items.some(i => i.text === 'B, report status.'));
  sessions[1].state = 'idle';
  assert.ok(stream.speechStream(room, { sessions }).some(i => i.text === 'Status: docs half done.'));
});
test('without a member\'s messages, its final shared reply still shows from the space', () => {
  const { room, sessions } = space();
  sessions[0] = { ...sessions[0], messages: [], messagesOmitted: true };
  const items = stream.speechStream(room, { sessions });
  assert.deepEqual(items.filter(i => i.fromId === 'A' && i.fromKind === 'agent').map(i => i.text), ['Build passes.', 'B, take the docs.']);
  assert.ok(!items.some(i => i.text === 'Let me look'));
});
test('there is no 20-item cap', () => {
  const messages = Array.from({ length: 75 }, (_, n) => ({ id: 'h' + n, role: 'human', recipientId: 'A', text: 'm' + n, time: n }));
  assert.equal(stream.speechStream({ messages }, { sessions: [] }).length, 75);
});
test('each item points at its original message', () => {
  const { room, sessions } = space();
  const items = stream.speechStream(room, { sessions });
  const target = text => items.find(i => i.text === text).target;
  assert.deepEqual(target('Build passes.'), { sessionId: 'A', nativeId: 'nA', messageId: 'a-final' });
  assert.deepEqual(target('B, take the docs.'), { sessionId: 'A', nativeId: '', messageId: 'wake1' });
  assert.deepEqual(target('B, report status.'), { sessionId: 'B', nativeId: 'nB', messageId: 'bw2' });
  assert.deepEqual(target('A, please check the build.'), { sessionId: 'A', nativeId: '', messageId: 'tagA1' });
});
test('ids are unique and inputs are not changed', () => {
  const { room, sessions } = space(), before = JSON.stringify({ room, sessions });
  const items = stream.speechStream(room, { sessions });
  assert.equal(new Set(items.map(i => i.id)).size, items.length);
  assert.equal(JSON.stringify({ room, sessions }), before);
});

test('a saved space view may reopen on the conversation, and other surfaces stay invalid', () => {
  const { validViews } = require('../view-store.cjs');
  const view = surface => [{ owner: 'o', selected: 'room', roomViews: { shared: { roomSurface: surface } } }];
  assert.equal(validViews(view('conversation')), true);
  assert.equal(validViews(view('records')), true);
  assert.equal(validViews(view('bogus')), false);
});
