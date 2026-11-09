const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');

// The actual spaceAction handler from main.cjs: only the person's window may change a queue.
function spaceAction() {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  register('spaceAction', async (c, roomId, action, args = []) => {");
  const end = source.indexOf("  register('spaceFiles',", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  let handler;
  const roomState = {
    metadata() {},
    queueAdd(...args) {
      calls.push(['queueAdd', ...args]);
      return 'item-1';
    },
    queueCancel(...args) {
      calls.push(['queueCancel', ...args]);
    },
    queueResolve(...args) {
      calls.push(['queueResolve', ...args]);
    },
  };
  const context = vm.createContext({
    register(name, fn) {
      handler = fn;
    },
    validRoomId: () => true,
    uiError,
    roomState,
    broadcastRoom: async () => {},
    queueDispatcher: { schedule() {} },
  });
  vm.runInContext(source.slice(start, end), context);
  return { handler, calls };
}

test('an agent working through background control cannot add, cancel or resolve queue items', async () => {
  const { handler, calls } = spaceAction();
  for (const action of ['queueAdd', 'queueCancel', 'queueResolve']) {
    await assert.rejects(handler({ background: true }, 'shared', action, ['x', null]), error => error.uiMessage?.key === 'error.queue.personOnly');
  }
  assert.deepEqual(calls, []);
});

test('the person\'s window adds, resolves and cancels queue items', async () => {
  const { handler, calls } = spaceAction();
  assert.equal(await handler({}, 'shared', 'queueAdd', ['task', null]), 'item-1');
  await handler({}, 'shared', 'queueResolve', ['item-1']);
  await handler({}, 'shared', 'queueCancel', ['item-1']);
  assert.deepEqual(calls, [['queueAdd', 'task', null, 'shared'], ['queueResolve', 'item-1', 'shared'], ['queueCancel', 'item-1', 'shared']]);
});
