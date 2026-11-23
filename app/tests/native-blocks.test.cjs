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


test('replay preserves existing recorded clocks but never dates first-seen history as now', () => {
  const s = { nativeId: 'N', messages: [] }, event = { nativeId: 'N', id: 'display:old', kind: 'response', turnId: 'T', status: 'complete', text: 'Original' };
  applyNativeBlock(s, { ...event, replayed: true });
  assert.equal(s.messages[0].time, undefined); assert.equal(s.messages[0].text, 'Original');
  applyNativeBlock(s, { ...event, id: 'display:live' }); const time = s.messages[1].time;
  assert.ok(Number.isFinite(time));
  applyNativeBlock(s, { ...event, id: 'display:live', replayed: true });
  assert.equal(s.messages[1].time, time);
});


test('explicit own display metadata survives persistence while native bodies and titles clear stale descriptors', () => {
  const locale = require('../ui-locale.js'), blocks = require('../native-blocks.cjs'), own = locale.createNotice('notice.turnTimeUnavailable'), title = locale.createNotice('notice.nativeProcessTitle');
  const session = { nativeId: 'N', messages: [] };
  applyNativeBlock(session, { id: 'own', nativeId: 'N', kind: 'notice', ...own, title: title.text, uiTitleMessage: title.uiMessage });
  const row = session.messages[0]; assert.equal(locale.displayText('en', row.text, row.uiMessage), locale.format('en', 'notice.turnTimeUnavailable'));
  assert.equal(locale.displayText('en', row.title, row.uiTitleMessage), 'Native process record');
  assert.deepEqual(blocks.persistedMessages(session.messages)[0].uiMessage, row.uiMessage);
  applyNativeBlock(session, { id: 'own', nativeId: 'N', kind: 'notice', delta: ' RAW 中文', title: 'RAW native title', uiTitleMessage: title.uiMessage });
  assert.equal(row.text, own.text + ' RAW 中文'); assert.equal(row.uiMessage, undefined); assert.equal(row.uiTitleMessage, undefined); assert.equal(row.title, 'RAW native title');
  applyNativeBlock(session, { id: 'native', nativeId: 'N', kind: 'response', ...own }); assert.equal(session.messages[1].uiMessage, undefined);
  const candidate = { id: 'delta', nativeItemId: 'delta', nativeId: 'N', role: 'assistant', text: own.text, uiMessage: own.uiMessage }; session.messages.push(candidate);
  blocks.applyCodexDelta(session, { id: 'delta', text: ' RAW', turnId: 'T' }); assert.equal(candidate.uiMessage, undefined); assert.equal(candidate.text, own.text + ' RAW');
  candidate.uiMessage = own.uiMessage; blocks.applyCodexMessage(session, { id: 'delta', text: 'RAW final', turnId: 'T' }); assert.equal(candidate.uiMessage, undefined); assert.equal(candidate.text, 'RAW final');
});

test('own cache gaps, missing clocks and pending image descriptions localize without claiming native completion', () => {
  const locale = require('../ui-locale.js'), blocks = require('../native-blocks.cjs');
  const rows = Array.from({ length: 201 }, (_, index) => ({ id: 'tool-' + index, role: 'tool', volatile: true, text: 'RAW ' + index }));
  const trimmed = blocks.trimVolatileRows(rows), gap = trimmed.find(row => row.kind === 'gap'); assert.equal(gap.incomplete, true);
  assert.equal(locale.displayText('en', gap.text, gap.uiMessage), 'Some tool records exceed the local retention limit. Check them in the native terminal.');
  const session = { nativeId: 'N', messages: [] }; blocks.applyCodexTurnHistory(session, null);
  assert.equal(locale.displayText('en', session.messages[0].text, session.messages[0].uiMessage), 'Native turn timing has not synchronized yet. The original text is retained; check the native terminal.');
  applyNativeBlock(session, { id: 'image', nativeId: 'N', kind: 'tool', status: 'complete', imageCount: 1 });
  const image = session.messages[1].images[0]; assert.equal(image.pending, true); assert.equal(locale.displayText('en', image.unavailable, image.unavailableUiMessage), 'The image is not fully synchronized yet.');
  assert.equal(session.messages.some(row => row.kind === 'turn'), false);
});


test('localized gap metadata consumes its existing reservation once at count and oversized-marker boundaries', () => {
  const { trimVolatileRows } = require('../native-blocks.cjs');
  const rows = Array.from({ length: 201 }, (_, n) => ({ id: 'tool-' + n, role: 'tool', kind: 'tool', volatile: true, text: 'RAW ' + n }));
  const first = trimVolatileRows(rows), before = JSON.stringify(first);
  assert.equal(first.length, 200); assert.equal(first.filter(row => row.kind === 'gap').length, 1);
  assert.equal(JSON.stringify(trimVolatileRows(first)), before);
  const hugeGap = { id: 'native-cache-gap', role: 'system', kind: 'gap', volatile: true, text: 'X'.repeat(1024 * 1024) };
  const repaired = trimVolatileRows([hugeGap, ...rows.slice(0, 3)]);
  assert.ok(Buffer.byteLength(JSON.stringify(repaired)) <= 1024 * 1024); assert.ok(repaired.length <= 200);
  assert.equal(repaired.filter(row => row.kind === 'gap').length, 1); assert.deepEqual(repaired.filter(row => row.role === 'tool'), rows.slice(0, 3));
  assert.equal(JSON.stringify(trimVolatileRows(repaired)), JSON.stringify(repaired));
});


test('legacy and translated gap growth both fit the complete serialized array on the first trim', () => {
  const { trimVolatileRows, persistedMessages } = require('../native-blocks.cjs'), own = require('../ui-locale.js').createNotice('notice.nativeCacheGap');
  const size = row => Buffer.byteLength(JSON.stringify(row));
  const tool = (id, length) => ({ id: 'native:n:tool:' + id, role: 'tool', nativeId: 'n', nativeBlock: true, kind: 'tool', volatile: true, status: 'complete', text: 'x'.repeat(length) });
  for (const translated of [false, true]) {
    const gap = { id: 'native-cache-gap', role: 'system', kind: 'gap', volatile: true, time: 1, text: own.text, incomplete: true, ...(translated ? { uiMessage: own.uiMessage } : {}) };
    const rows = [...Array.from({ length: 100 }, (_, i) => tool(i, 9000)), gap], filler = tool(500, 1);
    filler.text = 'x'.repeat(1 + 1024 * 1024 - 1 - rows.reduce((n, row) => n + size(row), 0) - size(filler));
    rows.unshift(tool(999, 9000), filler);
    const alreadyFits = rows.slice(1).map(row => ({ ...row }));
    const excess = Buffer.byteLength(JSON.stringify(alreadyFits)) - (1024 * 1024 - 1);
    alreadyFits[0].text = alreadyFits[0].text.slice(0, -excess);
    assert.equal(Buffer.byteLength(JSON.stringify(alreadyFits)), 1024 * 1024 - 1);
    const untouched = JSON.stringify(alreadyFits);
    assert.equal(JSON.stringify(trimVolatileRows(alreadyFits)), untouched, 'A valid legacy record must not lose a tool merely to add display metadata.');
    const original = JSON.stringify(rows), first = trimVolatileRows(rows.map(row => ({ ...row })));
    assert.ok(Buffer.byteLength(JSON.stringify(first.filter(row => row.volatile))) <= 1024 * 1024, 'The first result, including array punctuation and new metadata, must already fit.');
    assert.ok(first.length <= 200); assert.equal(JSON.stringify(persistedMessages(first)), JSON.stringify(first)); assert.equal(JSON.stringify(rows), original);
  }
});
test('M58: live Codex replies carry their receive time; native history stays without one', () => {
  const { applyCodexDelta, applyCodexMessage, applyCodexHistory } = require('../native-blocks.cjs');
  const s = { nativeId: 'root', provider: 'codex', messages: [] }, before = Date.now();
  const streamed = applyCodexDelta(s, { id: 'live-a', text: 'he', turnId: 't1' });
  assert.equal(typeof streamed.time, 'number'); assert.ok(streamed.time >= before && streamed.time <= Date.now());
  const first = streamed.time;
  applyCodexDelta(s, { id: 'live-a', text: 'llo', turnId: 't1' }); applyCodexMessage(s, { id: 'live-a', text: 'hello', turnId: 't1' });
  assert.equal(s.messages[0].time, first, 'Later deltas and completion keep the first receive time.');
  const whole = applyCodexMessage(s, { id: 'live-b', text: 'done', turnId: 't1' });
  assert.equal(typeof whole.time, 'number');
  const h = { nativeId: 'root', provider: 'codex', messages: [] };
  applyCodexHistory(h, [{ type: 'agentMessage', id: 'old-a', text: 'old', turnId: 't0' }], {});
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].time, undefined, 'History has no native time; reconnect time is not its time.');
});
