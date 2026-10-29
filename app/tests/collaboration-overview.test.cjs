const test = require('node:test');
const assert = require('node:assert/strict');
const { statusFacts, excerpt, adjustedWidths } = require('../renderer/collaboration-overview.js');

test('root idle never conceals observed working or unknown native children', () => {
  const record = { id: 'fixture-member', nativeId: 'fixture-native', state: 'idle', fleet: [
    { event: 'SubagentStart', id: 'fixture-child-a', stale: false },
    { event: 'thread/started', id: 'fixture-child-b', stale: false },
    { event: 'TaskCompleted', id: 'fixture-task', stale: false },
  ] };
  const facts = statusFacts(record, true, 10000);
  assert.equal(facts.state, '会话就绪');
  assert.match(facts.child, /1 项进行中.*1 项状态未知.*部分观察/);
  assert.equal(facts.freshness, '更新时间未报告');
  assert.match(statusFacts(record, false, 10000).child, /2 项状态未知/);
  assert.equal(statusFacts(record, false, 10000).state, '连接状态待核对');
});

test('freshness uses only matching native observations, not old messages or foreign contexts', () => {
  const record = { state: 'working', nativeId: 'native-current', messages: [{ time: 10000 }],
    nativeActivity: { nativeId: 'native-other', observedAt: 9999 }, fleet: [] };
  assert.equal(statusFacts(record, true, 10000).freshness, '更新时间未报告');
  record.nativeActivity = { observedAt: 9999 };
  assert.equal(statusFacts(record, true, 10000).freshness, '更新时间未报告');
  record.activeTurnId = 'current-turn';
  record.nativeActivity = { nativeId: record.nativeId, turnId: 'old-turn', observedAt: 9999 };
  assert.equal(statusFacts(record, true, 10000).freshness, '更新时间未报告');
  record.nativeActivity = { nativeId: record.nativeId, observedAt: 5000 };
  assert.equal(statusFacts(record, true, 10000).freshness, '5 秒前更新');
  assert.equal(statusFacts(record, true, 12000).freshness, '最后观察 · 7 秒前更新');
  record.nativeActivity.observedAt = 13000;
  assert.equal(statusFacts(record, true, 12000).freshness, '更新时间未报告');
  record.nativeActivity = { nativeId: record.nativeId, observedAt: 11999, stale: true };
  assert.match(statusFacts(record, true, 12000).freshness, /^最后观察/);
});

test('no observed lifecycle is unknown; a task-completed event is not a child inventory', () => {
  for (const fleet of [[], [{ event: 'TaskCompleted', id: 'fixture-task', stale: false }]]) {
    assert.equal(statusFacts({ state: 'idle', fleet }).child, '子任务：未报告');
  }
});

test('compact facts omit empty rows without treating unobserved or partial children as complete', () => {
  const record = { state: 'idle', nativeId: 'compact-native', fleet: [] };
  const empty = statusFacts(record, true, 10000);
  assert.equal(empty.compactChild, ''); assert.equal(empty.freshnessReported, false);
  assert.equal(empty.child, '子任务：未报告'); assert.equal(empty.freshness, '更新时间未报告');
  record.fleet = [1, 2, 3].map(id => ({ event: 'thread/started', id: 'compact-child-' + id, stale: false }));
  const partial = statusFacts(record, true, 10000);
  assert.equal(partial.compactChild, '3 未知 · 部分观察');
  assert.match(partial.child, /3 项状态未知（部分观察）/); assert.equal(partial.state, '会话就绪');
  assert.equal(statusFacts(record, false, 10000).freshnessReported, true, 'Disconnection remains visible even without a timestamp');
  record.nativeActivity = { nativeId: record.nativeId, observedAt: 1000 };
  assert.equal(statusFacts(record, true, 10000).freshnessReported, true, 'Stale observed time remains visible');
  record.nativeActivity.observedAt = 9999;
  assert.equal(statusFacts(record, true, 10000).freshnessReported, true, 'Real current updates are retained');
});

test('native context uncertainty and blocking/nonblocking questions retain their actual meanings', () => {
  const record = { state: 'idle', fleet: [], nativeContextPending: { reason: 'resume' } };
  assert.equal(statusFacts(record).state, '原生上下文待核对');
  delete record.nativeContextPending;
  record.approval = { method: 'item/tool/requestUserInput', params: {} };
  assert.equal(statusFacts(record).state, '等待回答');
  record.approval.params.isBlocking = false;
  assert.equal(statusFacts(record).state, '会话就绪 · 有待回答问题');
  delete record.approval; record.state = 'constructor';
  assert.equal(statusFacts(record).state, '状态未报告');
  record.state = 'approval'; record.approvals = [{ requestId: 'first' }, { requestId: 'second' }];
  assert.equal(statusFacts(record).state, '等待确认 · 2 项待处理');
});

test('brief is a bounded exact original with its session/native/message/turn provenance', () => {
  const record = { id: 'member-a', nativeId: 'native-new', messages: [
    { id: 'first', role: 'assistant', text: 'Old message' },
    { id: 'latest', nativeId: 'native-before', turnId: 'turn-a', role: 'assistant', text: '原文🙂 line\n**unchanged**', time: 1234, incomplete: true },
    { id: 'tool', role: 'tool', text: 'a later command is not an assistant brief' },
    { id: 'empty', role: 'assistant', text: '  ' },
  ] };
  const result = excerpt(record, record.messages, 3);
  assert.deepEqual(result, { sessionId: record.id, messageId: 'latest', nativeId: 'native-before', turnId: 'turn-a',
    text: '原文🙂', truncated: true, incomplete: true, time: 1234, previousContext: true });
  assert.equal(excerpt(record, record.messages, 100).text, record.messages[1].text);
});

test('missing source stays absent; invalid timestamps are never invented', () => {
  assert.equal(excerpt({ id: 'empty', messages: [{ role: 'tool', text: 'output' }] }), null);
  assert.equal(excerpt({ id: 'bad-id', messages: [{ role: 'assistant', text: 'unaddressable' }] }), null);
  assert.equal(excerpt({ id: 'member', messages: [{ id: 'source', role: 'assistant', text: 'original', time: Infinity }] }).time, null);
  const legacy = excerpt({ id: 'member', nativeId: 'current-context', messages: [{ id: 'source', role: 'assistant', text: 'legacy original' }] });
  assert.equal(legacy.nativeId, null, 'Missing source native ID cannot be replaced by the current post-fork identity');
});

test('column resizing conserves neighboring area and clamps minimum without moving other members', () => {
  const original = [1, 1, 1];
  const moved = adjustedWidths(original, 0, 100, 900);
  assert.ok(Math.abs(moved[0] - 4 / 3) < 1e-12);
  assert.ok(Math.abs(moved[1] - 2 / 3) < 1e-12);
  assert.equal(moved[0] + moved[1], 2); assert.equal(moved[2], 1);
  const clamped = adjustedWidths(original, 0, 10000, 900);
  assert.ok(clamped[0] <= 1.4 + 1e-9); assert.ok(clamped[1] >= .6 - 1e-9);
  assert.equal(clamped[0] + clamped[1], 2); assert.equal(clamped[2], 1);
  assert.deepEqual(original, [1, 1, 1]);
  assert.deepEqual(adjustedWidths(original, 2, 10, 900), original);
  assert.deepEqual(adjustedWidths(original, 0, Infinity, 900), original);
});
