const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness(pending, saved, tail = true) {
  const context = vm.createContext({ window: {}, document: { activeElement: null }, api: { readingState() {} }, attempt: fn => fn() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
  // Layout/frame restoration is covered by the renderer journey. Here exercise
  // the actual paging action at the missing-persisted-position boundary.
  context.scheduleReading = () => {};
  if (saved) { context.saved = saved; vm.runInContext('readingPositions.reader = saved', context); }
  const view = { key: 'reader', intent: { position: pending }, el: { isConnected: true, clientHeight: 600, getClientRects: () => [1] },
    pageRange: { tail }, pageData: { messages: [{ id: 'first' }] }, reload() {} };
  return { view, run(action, automatic = false) { context.changeReadingPage(view, action, false, automatic); return JSON.parse(JSON.stringify(view.intent.position)); } };
}
test('automatic fill of a newly opened, unsaved reader preserves its live follow intent', () => {
  const h = harness({ top: 0, follow: true, anchor: '', offset: 0 });
  assert.equal(h.run('older', true).follow, true);
});
test('automatic fill preserves the current manual anchor instead of an older saved position', () => {
  const position = { top: 431, follow: false, anchor: 'original-row', offset: -12 };
  const h = harness(position, { top: 0, follow: true, anchor: '', offset: 0 });
  assert.deepEqual(h.run('older', true), position);
});
test('manual paging still leaves follow, and an older segment never becomes follow-latest', () => {
  const position = { top: 300, follow: true, anchor: '', offset: 0 };
  assert.equal(harness(position).run('older').follow, false);
  assert.equal(harness(position, undefined, false).run('newer', true).follow, false);
});
test('explicit first and latest actions still replace the current reading target', () => {
  const position = { top: 431, follow: false, anchor: 'old-row', offset: -12 };
  assert.deepEqual(harness(position).run('latest'), { top: 0, follow: true, anchor: '', offset: 0 });
  assert.deepEqual(harness(position).run('first'), { top: 0, follow: false, anchor: 'first', offset: 0 });
});
