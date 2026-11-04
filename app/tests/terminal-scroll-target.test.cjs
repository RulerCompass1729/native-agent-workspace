const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function setup({ focused = true, viewportY = 12, baseY = 100, pasted = false, allowInput = true, columnReading = false } = {}) {
  const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
  const take = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
  const textarea = {}, surface = { scrollTop: 190, scrollLeft: 0, clientHeight: 100, clientWidth: 160 };
  const buffer = { viewportY, baseY, cursorX: 0, cursorY: 4 };
  const frames = [], calls = [];
  const term = {
    textarea, buffer: { active: buffer }, cols: 80, rows: 30, modes: { bracketedPasteMode: false },
    paste(text) { calls.push(['paste', text]); },
    element: { querySelector: () => ({ clientWidth: 640, clientHeight: 390 }) },
    write(data, done) { calls.push(['write', data]); done(); },
    scrollToBottom() { calls.push(['bottom']); buffer.viewportY = buffer.baseY; },
  };
  const entry = { term, element: { dataset: { terminalId: 'original' }, querySelector: () => surface }, sequence: 0, columnReading };
  const context = vm.createContext({ document: { activeElement: focused ? textarea : {} },
    requestAnimationFrame: callback => frames.push(callback), columnTerminalBinding: () => ({}),
    terminalCanInput: () => allowInput, uiError: key => new Error(key),
    focusTerminal: id => calls.push(['focus', id]),
    terminals: new Map([['original', entry]]), Number, Math });
  vm.runInContext(take('function revealTerminalCursor(', 'function nativeVersionText(') + '\n' +
    take('function pasteTerminal(', 'const imageFiles') + '\n' + take('function writeTerminal(', 'const disposers'), context);
  if (pasted) {
    entry.columnReading = true;
    try { context.pasteTerminal('explicit text paste', 'original'); }
    catch (error) { return { error, buffer, surface, calls, entry }; }
  }
  context.writeTerminal(entry, { id: 'original', sequence: 1, data: 'fresh native output' });
  for (const frame of frames) frame();
  return { buffer, surface, calls, entry };
}

test('focused passive native output preserves manually selected xterm history', () => {
  const value = setup({ viewportY: 12, baseY: 100 });
  assert.equal(value.buffer.viewportY, 12);
  assert.equal(value.surface.scrollTop, 190);
  assert.deepEqual(value.calls, [['write', 'fresh native output']]);
  assert.equal(value.entry.sequence, 1, 'Original output is still consumed exactly once');
});

test('focused output preserves an outer column scroll even when xterm is at latest', () => {
  const value = setup({ viewportY: 100, baseY: 100, columnReading: true });
  assert.equal(value.buffer.viewportY, 100);
  assert.equal(value.surface.scrollTop, 190);
  assert.deepEqual(value.calls, [['write', 'fresh native output']]);
  assert.equal(value.entry.sequence, 1);
});

test('a focused terminal following live output can still reveal its native cursor', () => {
  const value = setup({ viewportY: 100, baseY: 100 });
  assert.equal(value.buffer.viewportY, 100);
  assert.equal(value.surface.scrollTop, 0);
  assert.deepEqual(value.calls, [['write', 'fresh native output'], ['bottom']]);
});

test('shared composer focus never makes output reposition the native viewport', () => {
  const value = setup({ focused: false, viewportY: 100, baseY: 100 });
  assert.equal(value.surface.scrollTop, 190);
  assert.deepEqual(value.calls, [['write', 'fresh native output']]);
});

test('explicit native paste restores cursor following after manual column reading', () => {
  const value = setup({ viewportY: 100, baseY: 100, pasted: true });
  assert.equal(value.error, undefined);
  assert.equal(value.surface.scrollTop, 0);
  assert.deepEqual(value.calls, [['paste', 'explicit text paste'], ['focus', 'original'], ['write', 'fresh native output'], ['bottom']]);
});

test('a refused paste neither leaves manual reading nor submits native input', () => {
  const value = setup({ viewportY: 100, baseY: 100, pasted: true, allowInput: false });
  assert.match(value.error.message, /terminalControl/);
  assert.equal(value.surface.scrollTop, 190);
  assert.equal(value.entry.columnReading, true);
  assert.deepEqual(value.calls, []);
});
