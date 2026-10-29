const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
const tool = (id, extra = {}) => ({ id, nativeId: 'N', turnId: 'T', nativeBlock: true, kind: 'tool', role: 'tool', title: 'Bash', text: 'ORIGINAL ' + id, status: 'complete', ...extra });
const summary = (id, extra = {}) => tool(id, { role: 'assistant', kind: 'summary', title: '', text: 'PUBLIC ORIGINAL SUMMARY', ...extra });
function groups(messages, { originals = messages, room = false, sessions = [] } = {}) {
  Object.assign(context, { messages, originals, room, sessions });
  return JSON.parse(vm.runInContext('JSON.stringify([...nativeProcessGroups(messages, room, originals, sessions).values()])', context));
}
test('original thinking summaries and mixed tools share one truthful counted group without changing records', () => {
  const rows = [summary('s'), tool('a'), tool('b'), tool('r', { title: 'Read' }), tool('edit', { title: 'Edit', status: 'failed' }), tool('retry', { title: 'Edit' })];
  const copy = structuredClone(rows), result = groups(rows);
  assert.equal(result.length, 1); assert.deepEqual(rows, copy);
  assert.equal(result[0].caption, '1 段思考摘要 · 2 个命令 · 1 次读取 · 2 次工具调用');
  assert.equal(result[0].outcome, '失败 1'); assert.equal(result[0].messages[4].text, 'ORIGINAL edit');
  assert.equal(result[0].active, false, 'Completed tools do not claim that their native turn is active or finished');
});
for (const [label, record] of [
  ['answer', { id: 'answer', role: 'assistant', kind: 'response', text: 'Original answer' }],
  ['input', { id: 'input', role: 'user', text: 'User input' }],
  ['plan', summary('plan', { kind: 'plan' })], ['notice', { id: 'notice', role: 'system', kind: 'notice' }],
  ['gap', { id: 'gap', role: 'system', kind: 'gap', incomplete: true }],
  ['incomplete', tool('i', { incomplete: true })], ['missing native ID', tool('n', { nativeId: undefined })],
  ['missing turn', tool('t', { turnId: undefined })], ['legacy', tool('legacy', { nativeBlock: false })],
  ['user shell', tool('shell', { commandSource: 'userShell' })], ['uncertain', tool('u', { status: 'unconfirmed' })],
  ['unknown status', tool('unknown', { status: 'unrecognized' })], ['empty summary', summary('empty', { text: '' })],
]) test('group cannot cross ' + label, () => assert.equal(groups([tool('a'), record, tool('b')]).length, 2));
for (const change of [{ nativeId: 'other' }, { turnId: 'other' }, { displayTurnId: 'other' }, { sessionId: 'other' },
  { inputTag: 'other' }, { promptId: 'other' }, { sourceTag: 'other' }, { replyTo: 'other' }]) {
  test('group retains context/authorization boundary ' + JSON.stringify(change), () => assert.equal(groups([tool('a'), tool('b', change)]).length, 2));
}
test('revoked sharing records remain standalone so their existing warning cannot be hidden by an outer fold', () => {
  const stopped = tool('stopped', { sharingStopped: 'revoked' });
  const result = groups([tool('a'), stopped, tool('b')]);
  assert.equal(result.length, 2); assert.ok(result.every(group => group.messages.every(m => m.id !== stopped.id)));
});
test('an ineligible member keeps its whole existing T29 exploration outside adjacent process groups', () => {
  const read = (id, status = 'complete') => tool(id, { toolKind: 'commandExecution', commandSource: 'agent', status,
    commandActions: [{ type: 'read', command: 'cat ' + id, name: id, path: '/synthetic/' + id }] });
  const x = tool('x', { title: 'Edit' }), y = tool('y'), a = read('a'), u = read('u', 'unconfirmed'), b = read('b');
  const result = groups([x, y, a, u, b]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].messages.map(m => m.id), ['x', 'y']);
  assert.equal(result[0].caption, '1 次工具调用 · 1 个命令');
});
test('filtered and reordered source records cannot join across omitted content', () => {
  const a = tool('a'), b = tool('b'), answer = { id: 'answer', role: 'assistant', text: 'Must remain a boundary' };
  assert.equal(groups([a, b], { originals: [a, answer, b] }).length, 2);
  assert.equal(groups([b, a], { originals: [a, b] }).length, 2);
  assert.equal(groups([a, b], { originals: [a] }).length, 1);
});
test('active native turn remains active after tools complete; only the matching original boundary ends it', () => {
  const rows = [tool('a'), tool('b')], live = [{ nativeId: 'N', activeTurnId: 'T', state: 'working' }];
  assert.equal(groups(rows, { sessions: live })[0].active, true);
  const boundary = { id: 'end', nativeId: 'N', turnId: 'T', nativeBlock: true, kind: 'turn', status: 'complete' };
  assert.equal(groups(rows, { originals: [...rows, boundary], sessions: live })[0].active, false);
  assert.equal(groups(rows, { originals: [...rows, { ...boundary, turnId: 'foreign' }], sessions: live })[0].active, true);
  assert.equal(groups(rows, { originals: [...rows, { ...boundary, nativeBlock: false }], sessions: live })[0].active, true);
  assert.equal(groups(rows, { sessions: [{ ...live[0], transportDisconnected: true }] })[0].active, false);
  assert.equal(groups(rows, { sessions: [{ ...live[0], activeTurnId: 'next' }] })[0].active, false);
});
test('interrupted step remains visible and ends adjacency; successful retry never erases earlier failure', () => {
  const result = groups([tool('a'), tool('failed', { status: 'failed' }), tool('retry'), tool('interrupted', { status: 'interrupted' }), tool('next')]);
  assert.equal(result.length, 2); assert.equal(result[0].outcome, '失败 1 · 已中断 1');
  assert.equal(result[0].messages[1].status, 'failed');
});
test('shared records preserve source, date and missing-time boundaries', () => {
  const row = (id, extra) => tool(id, { nativeBlock: false, sharedStream: true, nativeMessageId: 'native:' + id, sourceTag: 'shared-grant', sessionId: 'A', time: new Date(2026, 9, 28, 12).getTime(), ...extra });
  assert.equal(groups([row('a'), row('b')], { room: true }).length, 1);
  assert.equal(groups([row('a'), row('b', { sessionId: 'B' })], { room: true }).length, 2);
  assert.equal(groups([row('a'), row('b', { time: new Date(2026, 9, 29, 12).getTime() })], { room: true }).length, 2);
  assert.equal(groups([row('a'), row('missing', { time: undefined }), row('b')], { room: true }).length, 2);
  assert.equal(groups([row('a'), row('missing', { sourceTag: undefined }), row('b')], { room: true }).length, 2);
});
test('native exploration keeps its exact nonzero exit annotation instead of inventing generic failure', () => {
  const native = tool('search', { toolKind: 'commandExecution', commandSource: 'agent', status: 'failed', exitCode: 1,
    commandActions: [{ type: 'search', command: 'rg absent src', query: 'absent', path: 'src' }] });
  const result = groups([summary('thought'), native, tool('edit', { title: 'Edit', status: 'failed' })])[0];
  assert.equal(result.outcome, '失败 1 · exit 1');
  assert.equal(result.messages[1].status, 'failed'); assert.equal(result.messages[1].exitCode, 1);
  assert.equal(groups([tool('ambiguous', { text: 'rg absent src', status: 'failed', exitCode: 1 })])[0].outcome, '失败 1');
});
test('duplicate IDs and overlong anchors cannot create ambiguous or invalid persisted group keys', () => {
  assert.equal(groups([tool('dup'), tool('dup')]).length, 0);
  assert.equal(groups([tool('x'.repeat(100))]).length, 0);
  const result = groups([tool('a')])[0]; assert.ok(result.id.length <= 100);
  const { readingState } = require('../reading-state.cjs');
  assert.equal(readingState({ view: { anchor: result.id, top: 0, follow: false, offset: 0, folds: { [result.id]: false, a: true } } }).view.folds[result.id], false);
});
