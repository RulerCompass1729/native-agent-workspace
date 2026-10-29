const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
const records = count => Array.from({ length: count }, (_, i) => ({ id: 'row-' + i, role: 'assistant', text: 'Original ' + i }));
const plain = value => JSON.parse(JSON.stringify(value));
function page(rows, previous, request, position = {}, groups = [], pinned = false) {
  return plain(context.readingPageRange(context.readingPageData(rows, groups), previous, request, position, pinned));
}
test('initial history and following append render only the recent fifty original records', () => {
  const rows = records(2480), snapshot = structuredClone(rows), first = page(rows);
  assert.equal(first.start, 2430); assert.equal(first.end, 2480); assert.equal(first.tail, true);
  const next = page([...rows, { id: 'new', text: 'New original' }], first, null, { follow: true });
  assert.equal(next.end - next.start, 50); assert.equal(next.firstId, 'row-2431'); assert.equal(next.lastId, 'new');
  assert.deepEqual(rows, snapshot);
});
test('older pages prepend without dropping loaded records; selection pins the followed range', () => {
  const rows = records(200), last = page(rows), older = page(rows, last, { action: 'older' });
  assert.equal(older.firstId, 'row-100'); assert.equal(older.lastId, last.lastId);
  const pinned = page([...rows, { id: 'new' }], last, null, { follow: true }, [], true);
  assert.equal(pinned.firstId, last.firstId); assert.equal(pinned.lastId, 'new');
});
test('target and restored old anchors load a centred segment, not every later record', () => {
  const rows = records(2480), last = page(rows), target = page(rows, last, { action: 'target', id: 'row-500' });
  assert.equal(target.start, 475); assert.equal(target.end, 525); assert.equal(target.tail, false);
  const restored = page(rows, null, null, { follow: false, anchor: 'row-500' });
  assert.deepEqual(restored, target);
});
test('the bottom of an older segment cannot become follow-latest on reload', () => {
  assert.equal(context.readingFollow(false, true, false), false);
  assert.equal(context.readingFollow(true, true, false), true);
  assert.equal(context.readingFollow(true, true, true), false);
  const rows = records(1000), old = page(rows, null, { action: 'target', id: 'row-200' });
  const changed = rows.map(r => r.id === 'row-200' ? { ...r, text: 'Original streaming update' } : r).concat({ id: 'new' });
  assert.deepEqual(page(changed, old, null, { follow: false, anchor: 'row-200' }), old);
});
test('older/newer and Home/End reach both history boundaries without full-history spacers', () => {
  const rows = records(1000), old = page(rows, null, { action: 'target', id: 'row-200' });
  const newer = page(rows, old, { action: 'newer' }); assert.equal(newer.start, old.start); assert.equal(newer.end, old.end + 50);
  assert.equal(page(rows, old, { action: 'first' }).firstId, 'row-0');
  const last = page(rows, old, { action: 'latest' }); assert.equal(last.firstId, 'row-950'); assert.equal(last.tail, true);
});
test('actual process-group plans are atomic and synthetic process anchors map to their original members', () => {
  const rows = records(200), members = rows.slice(110, 180), groups = [{ id: 'process:row-110', messages: members }];
  const last = page(rows, null, null, {}, groups);
  assert.equal(last.start, 110); assert.equal(last.end, 200);
  const restored = page(rows, null, null, { follow: false, anchor: 'process:row-110' }, groups);
  assert.ok(restored.start <= 110 && restored.end >= 180); assert.equal(restored.tail, false);
  assert.equal(groups[0].messages.length, 70);
});
test('overlapping native and exploration plans form one atomic interval without merging adjacent groups', () => {
  const rows = records(200), groups = [
    { id: 'process:a', messages: rows.slice(100, 140) }, { messages: rows.slice(120, 150) },
    { id: 'process:b', messages: rows.slice(150, 180) },
  ];
  const target = page(rows, null, { action: 'target', id: 'row-110' }, {}, groups);
  assert.equal(target.start, 85); assert.equal(target.end, 150);
});
test('deleted boundaries fall back to a surviving saved anchor or boundary; replaced histories never show stale IDs', () => {
  const rows = records(200), old = page(rows, null, { action: 'target', id: 'row-100' });
  const remaining = rows.filter(r => r.id !== old.firstId && r.id !== old.lastId);
  const restored = page(remaining, old, null, { follow: false, anchor: 'row-100' });
  assert.ok(remaining.slice(restored.start, restored.end).some(r => r.id === 'row-100'));
  const replacement = [{ id: 'replacement', text: 'Different native context' }];
  assert.deepEqual(page(replacement, old), { start: 0, end: 1, firstId: 'replacement', lastId: 'replacement', tail: true });
  assert.equal(page([], old).end, 0);
});
test('real T29/T67 plans retain complete members, captions, failures and observed running state across page boundaries', () => {
  const tools = Array.from({ length: 70 }, (_, i) => ({ id: 'tool-' + i, role: 'tool', kind: 'tool', nativeId: 'N', turnId: 'T',
    nativeBlock: true, title: i % 2 ? 'Read' : 'Bash', text: 'Exact original ' + i, status: i === 35 ? 'failed' : 'complete' }));
  const rows = records(100).concat(tools, records(20).map(r => ({ ...r, id: 'last-' + r.id })));
  const sessions = [{ nativeId: 'N', state: 'working', activeTurnId: 'T' }];
  const explorations = context.commandExplorations(rows, false, rows);
  const all = context.nativeProcessGroups(rows, false, rows, sessions, explorations);
  const before = plain([...all.values()]), segment = page(rows, null, null, {}, [...all.values(), ...explorations.values()]);
  assert.equal(segment.start, 100); assert.equal(segment.end, 190);
  const visible = rows.slice(segment.start, segment.end), after = plain([...context.nativeProcessGroups(visible, false, rows, sessions).values()]);
  assert.deepEqual(after, before); assert.equal(after[0].active, true); assert.equal(after[0].outcome, '失败 1');
  const restored = page(rows, null, null, { follow: false, anchor: before[0].id }, [...all.values()]);
  assert.ok(restored.start <= 100 && restored.end >= 170);
  const reads = tools.map((m, i) => ({ ...m, status: 'complete', toolKind: 'commandExecution', commandSource: 'agent',
    commandActions: [{ type: 'read', command: 'cat file-' + i, name: 'file-' + i }] }));
  const readRows = records(100).concat(reads, rows.slice(-20)), plans = context.commandExplorations(readRows, false, readRows);
  const range = page(readRows, null, null, {}, [...plans.values()]);
  assert.equal(range.start, 100); assert.equal(range.end, 190);
  assert.equal(context.commandExplorations(readRows.slice(range.start, range.end), false, readRows).get('tool-0').summary, plans.get('tool-0').summary);
});
