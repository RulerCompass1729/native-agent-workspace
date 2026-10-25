const test = require('node:test'), assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { trackKeyboardModes } = require('../terminal-keyboard.cjs');
function fixture(t) {
  const terminal = new Terminal({ allowProposedApi: true });
  const modes = trackKeyboardModes(terminal);
  t.after(() => { modes.dispose(); terminal.dispose(); });
  return { terminal, modes, write: text => new Promise(resolve => terminal.write(text, resolve)) };
}
test('native push/set/pop controls disambiguation, including split output and editor handoff', async t => {
  const { modes, write } = fixture(t);
  assert.equal(modes.flags, 0);
  await write('\x1b[>'); await write('5u'); assert.equal(modes.flags, 5);
  await write('\x1b[>0u'); assert.equal(modes.flags, 0, 'A legacy child may suspend enhanced keys');
  await write('\x1b[<u'); assert.equal(modes.flags, 5, 'Returning restores the native parent mode');
  await write('\x1b[=1;3u'); assert.equal(modes.flags, 4);
  await write('\x1b[=1;2u'); assert.equal(modes.flags, 5);
  await write('\x1b[=0u'); assert.equal(modes.flags, 0);
  await write('\x1b[<999u'); assert.equal(modes.flags, 0);
});
test('normal and alternate screens retain separate native keyboard stacks', async t => {
  const { modes, write } = fixture(t);
  await write('\x1b[>5u\x1b[?1049h'); assert.equal(modes.flags, 0);
  await write('\x1b[>3u'); assert.equal(modes.flags, 3);
  await write('\x1b[?1049l'); assert.equal(modes.flags, 5);
  await write('\x1b[?1049h'); assert.equal(modes.flags, 3);
});
test('observing modes neither advertises keyboard support nor changes display text', async t => {
  const { terminal, modes, write } = fixture(t), replies = [];
  terminal.onData(data => replies.push(data));
  await write('original\x1b[>5u\x1b[?u\x1b[>1;2u');
  assert.equal(modes.flags, 1); assert.deepEqual(replies, []);
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), 'original');
});
