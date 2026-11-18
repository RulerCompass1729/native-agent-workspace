// Run the renderer's scheduling and fit path; GUI/PTY coverage lives in the isolated probe.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function harness() {
  const frames = [], sent = [], dimensions = { width: 364, height: 112 };
  const record = { id: 'a', owner: 'local', nativeId: 'native-a', connectionRevision: 1, terminalState: { alive: true, epoch: 'epoch-a' } };
  const binding = { id: 'a', column: true, visible: true, nativeVisible: true };
  const element = { isConnected: true, get clientWidth() { return dimensions.width; }, get clientHeight() { return dimensions.height; }, checkVisibility: () => binding.visible && binding.nativeVisible };
  const term = { cols: 100, rows: 30, resize(cols, rows) { this.cols = cols; this.rows = rows; } };
  const entry = { element, term, ready: true, nativeId: record.nativeId, generation: 1, epoch: record.terminalState.epoch,
    fit: { proposeDimensions: () => ({ cols: Math.floor(dimensions.width / 8), rows: Math.floor(dimensions.height / 16) }) } };
  const c = vm.createContext({ state: { sessions: [record] }, owner: 'local', terminals: new Map([['a', entry]]), sessionComposers: new Map([['a', binding]]),
    composerCurrent: b => b.visible, applyColumnTerminalHeight() {}, columnTerminalHeight: () => 112, revealTerminalCursor() {},
    attempt: fn => fn(), requestAnimationFrame: fn => frames.push(fn), activeSessionId: () => null, terminalLayout: 'hidden',
    api: { resize: async (id, cols, rows) => sent.push({ id, cols, rows }) } });
  vm.runInContext([
    between('function columnTerminalBinding(', 'function terminalContextVisible('),
    between('function currentTerminalDisplay(', 'function canFlushComposition('),
    between('function fitColumnTerminal(', '// The column budget'),
    between('// A smaller window lowers', "window.addEventListener('resize'"),
    between('function fitTerminal(id)', '// Follow the producer'),
  ].join('\n'), c);
  return { c, frames, sent, dimensions, record, binding, entry, refresh: () => c.refreshColumnTerminalHeights(), flush() { while (frames.length) frames.shift()(); } };
}
test('first visible owned snapshot fits, and width bursts share one next frame with the latest dimensions', () => {
  const h = harness(); h.entry.ready = false; h.refresh(); assert.equal(h.frames.length, 0);
  h.entry.ready = true; h.refresh(); h.dimensions.width = 444; h.refresh(); h.dimensions.width = 324; h.refresh();
  assert.equal(h.frames.length, 1); h.flush(); assert.deepEqual(h.sent, [{ id: 'a', cols: 40, rows: 7 }]);
});
test('unchanged-width output redraws and height-only layout do not resize, and subcell width changes deduplicate PTY sizes', () => {
  const h = harness(); h.refresh(); h.flush(); assert.equal(h.sent.length, 1);
  h.dimensions.height = 144; for (let i = 0; i < 20; i++) h.refresh(); assert.equal(h.frames.length, 0); assert.equal(h.sent.length, 1);
  h.dimensions.width = 444; h.refresh(); h.flush(); assert.deepEqual(h.sent.at(-1), { id: 'a', cols: 55, rows: 9 });
  h.dimensions.width = 445; h.refresh(); h.flush(); assert.equal(h.sent.length, 2); h.refresh(); assert.equal(h.frames.length, 0);
});
test('foreign ownership, parked/zero-sized views and pending restoration never fit; becoming visible and owned fits the latest width', () => {
  for (const block of [h => { h.record.owner = 'other'; }, h => { h.binding.visible = false; }, h => { h.dimensions.width = 0; }, h => { h.dimensions.height = 0; }, h => { h.entry.restoring = true; }]) {
    const h = harness(); block(h); h.refresh(); h.flush(); assert.deepEqual(h.sent, []);
  }
  const h = harness(); h.record.owner = 'other'; h.refresh(); h.record.owner = 'local'; h.binding.visible = false; h.refresh();
  h.dimensions.width = 244; h.binding.visible = true; h.refresh(); h.flush(); assert.equal(h.sent[0].cols, 30);
});
test('a scheduled fit cannot cross owner, native identity, epoch, generation, visibility or entry replacement', () => {
  for (const mutate of [h => { h.record.owner = 'other'; }, h => { h.record.nativeId = 'native-b'; }, h => { h.record.terminalState.epoch = 'epoch-b'; }, h => { h.record.connectionRevision++; }, h => { h.record.nativeContextPending = true; }, h => { h.record.terminalState.alive = false; }, h => { h.binding.visible = false; }, h => { h.dimensions.width = 0; }, h => { h.dimensions.height = 0; }, h => { h.entry.restoring = true; }, h => { h.c.terminals.delete('a'); }]) {
    const h = harness(); h.refresh(); mutate(h); h.flush(); assert.deepEqual(h.sent, []);
  }
});
test('IME composition defers width fitting through the existing pending-fit barrier', () => {
  for (const pending of ['composing', 'composition']) {
    const h = harness(); h.entry[pending] = true; h.refresh(); h.flush(); assert.deepEqual(h.sent, []); assert.equal(h.entry.fitPending, true);
    h.entry[pending] = false; h.entry.fitPending = false; h.c.fitTerminal('a'); h.flush(); assert.equal(h.sent[0].cols, 45);
  }
});
test('automatic width fitting keeps the native grid bounds', () => {
  const h = harness(); h.dimensions.width = 1; h.dimensions.height = 1; h.refresh(); h.flush(); assert.deepEqual(h.sent[0], { id: 'a', cols: 20, rows: 5 });
  h.dimensions.width = 9000; h.dimensions.height = 9000; h.refresh(); h.flush(); assert.deepEqual(h.sent[1], { id: 'a', cols: 400, rows: 200 });
});
