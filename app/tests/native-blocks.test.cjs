const test = require('node:test'), assert = require('node:assert/strict');
const { applyNativeBlock } = require('../native-blocks.cjs');
test('native display identity preserves batches, empty final, duplicate delivery and distinct identical messages', () => {
  const session = { nativeId: 'root', messages: [] }, send = e => applyNativeBlock(session, { nativeId: 'root', id: 'display:a', kind: 'response', turnId: 'turn-a', displayTurnId: 'native-display-turn', ...e });
  send({ index: 0, delta: '你好\n', status: 'streaming' });
  send({ index: 0, delta: '你好\n', status: 'streaming' });
  send({ index: 1, delta: '', status: 'complete' });
  send({ id: 'display:b', index: 0, delta: '你好\n', status: 'complete' });
  assert.equal(session.messages.length, 2); assert.equal(session.messages[0].text, '你好\n'); assert.equal(session.messages[0].status, 'complete');
  assert.equal(session.messages[0].incomplete, undefined);
  assert.equal(session.messages[0].turnId, 'turn-a'); assert.equal(session.messages[0].displayTurnId, 'native-display-turn');
});
test('native gaps remain explicit; old-root content cannot enter a new root', () => {
  const session = { nativeId: 'new-root', messages: [] };
  assert.equal(applyNativeBlock(session, { nativeId: 'old-root', id: 'display:a', delta: 'PRIVATE' }), false);
  applyNativeBlock(session, { nativeId: 'new-root', id: 'display:a', kind: 'response', index: 3, delta: 'tail' });
  assert.equal(session.messages[0].incomplete, true); assert.equal(session.messages[0].text, 'tail');
});
test('a late completed boundary cannot rewrite an interrupted native clock or observed cut', () => {
  const s = { nativeId: 'root', messages: [] };
  applyNativeBlock(s, { nativeId: 'root', id: 'turn:a', kind: 'turn', turnId: 'a', status: 'interrupted', nativeCompletedAt: 1000, nativeDurationMs: 900 });
  assert.equal(applyNativeBlock(s, { nativeId: 'root', id: 'turn:a', kind: 'turn', turnId: 'a', status: 'complete', nativeCompletedAt: 2000, nativeDurationMs: 1900 }), false);
  assert.equal(s.messages[0].status, 'interrupted'); assert.equal(s.messages[0].nativeCompletedAt, 1000); assert.equal(s.messages[0].nativeDurationMs, 900);
});
test('native interrupted boundary preserves text, leaves background tools running and never alters another turn', () => {
  const session = { nativeId: 'root', messages: [] }, send = e => applyNativeBlock(session, { nativeId: 'root', ...e });
  send({ id: 'display:a', kind: 'response', turnId: 'turn-a', delta: 'partial', status: 'streaming' });
  send({ id: 'tool:a', kind: 'tool', turnId: 'turn-a', title: 'Bash', input: 'command', status: 'running' });
  send({ id: 'display:b', kind: 'response', turnId: 'turn-b', delta: 'other', status: 'streaming' });
  send({ id: 'turn:a', kind: 'turn', turnId: 'turn-a', status: 'interrupted' });
  assert.equal(session.messages[0].text, 'partial'); assert.equal(session.messages[0].status, 'interrupted');
  assert.equal(session.messages[1].status, 'running'); assert.equal(session.messages[1].volatile, true);
  assert.equal(session.messages[2].status, 'streaming');
});
test('late native batches cannot reopen an interrupted turn, including native Codex delta rows', () => {
  const s = { nativeId: 'root', messages: [{ id: 'codex', role: 'assistant', nativeId: 'root', turnId: 'a', text: 'kept', status: 'streaming' }] };
  applyNativeBlock(s, { nativeId: 'root', id: 'turn:a', kind: 'turn', turnId: 'a', status: 'interrupted' });
  applyNativeBlock(s, { nativeId: 'root', id: 'display:a', kind: 'response', turnId: 'a', index: 0, delta: 'late native text', status: 'streaming' });
  assert.equal(s.messages[0].status, 'interrupted'); assert.equal(s.messages[2].status, 'interrupted');
  assert.equal(s.messages[2].text, 'late native text');
});
test('volatile cache bounds full serialized rows and count without unbounded placeholder accumulation', () => {
  const s = { nativeId: 'root', messages: [{ id: 'keep', role: 'user', text: 'persistent' }] };
  for (let i = 0; i < 600; i++) applyNativeBlock(s, { nativeId: 'root', id: 'tool:' + i, kind: 'tool', title: 'T'.repeat(6000), text: 'output', input: 'input' });
  const volatile = s.messages.filter(m => m.volatile);
  assert.ok(volatile.length <= 200); assert.ok(Buffer.byteLength(JSON.stringify(volatile)) <= 1024 * 1024);
  assert.equal(s.messages[0].text, 'persistent'); assert.equal(volatile.filter(m => m.kind === 'gap').length, 1);
});


test('durable trajectory retains only bounded structured native tools and its overflow marker', () => {
  const { persistedMessages } = require('../native-blocks.cjs');
  const rows = [{ id: 'chat', role: 'assistant', text: 'answer' },
    { id: 'legacy', volatile: true, role: 'system', text: 'RAW TERMINAL OBSERVATION' },
    { id: 'untyped', volatile: true, role: 'tool', text: 'UNATTRIBUTED TOOL' }];
  for (let n = 0; n < 220; n++) rows.push({ id: `native:native:tool:${n}`, nativeId: 'native', nativeBlock: true, volatile: true,
    kind: 'tool', role: 'tool', input: 'local input', text: '本地输出'.repeat(1000), status: 'complete' });
  const before = JSON.stringify(rows), saved = persistedMessages(rows);
  assert.equal(JSON.stringify(rows), before, 'Preparing persistence cannot mutate the live reader');
  assert.ok(!JSON.stringify(saved).includes('RAW TERMINAL')); assert.ok(!JSON.stringify(saved).includes('UNATTRIBUTED'));
  const tools = saved.filter(m => m.volatile);
  assert.ok(tools.length <= 200); assert.ok(Buffer.byteLength(JSON.stringify(tools)) <= 1024 * 1024);
  assert.equal(tools.filter(m => m.kind === 'gap').length, 1);
  assert.equal(saved.at(-2).id, 'native:native:tool:219'); assert.equal(saved[0].id, 'chat');
  assert.deepEqual(persistedMessages(saved), saved, 'Saving again neither grows nor drops the overflow marker');
});

test('native command interruption stops the displayed activity without losing command/actions or partial output', () => {
  const s = { nativeId: 'N', messages: [] };
  applyNativeBlock(s, { nativeId: 'N', id: 'tool:cmd', kind: 'tool', toolKind: 'commandExecution', turnId: 'T', status: 'running', input: 'cat file', commandActions: [{ type: 'read', command: 'cat file', name: 'file', path: '/file' }], text: 'partial' });
  applyNativeBlock(s, { nativeId: 'N', id: 'turn:T', kind: 'turn', turnId: 'T', status: 'interrupted' });
  assert.equal(s.messages[0].status, 'interrupted'); assert.equal(s.messages[0].text, 'partial'); assert.equal(s.messages[0].commandActions[0].name, 'file');
  applyNativeBlock(s, { nativeId: 'N', id: 'tool:cmd', kind: 'tool', toolKind: 'commandExecution', turnId: 'T', status: 'complete', text: 'late full output' });
  assert.equal(s.messages[0].status, 'interrupted'); assert.equal(s.messages[0].text, 'late full output');
});
