const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const file = path.join(root, 'scripts/fixtures/collaboration-overview.cjs');

function setup({ missing = false, error = null } = {}) {
  const calls = [], packets = [], promise = Promise.resolve('original result'), sent = Symbol('original send');
  class Workspace {
    claim(...args) { calls.push({ method: 'claim', self: this, args }); return promise; }
  }
  if (!missing) Workspace.prototype.startRun = function (...args) {
    calls.push({ method: 'startRun', self: this, args });
    if (error) throw error;
    return promise;
  };
  class NativeHost { create() { return {}; } }
  const process = { env: { NAW_TEST_APP_ROOT: root }, send(...args) { packets.push({ self: this, args }); return sent; } };
  const context = vm.createContext({ __dirname: path.dirname(file), process,
    require(name) {
      if (name === './native-progress.cjs') return {};
      if (name === 'node:path') return path;
      if (name === path.join(root, 'app/workspace.cjs')) return { Workspace };
      if (name === path.join(root, 'app/adapters.cjs')) return { NativeHost };
      throw Error('Unexpected fixture dependency: ' + name);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  function stats() { const message = { stats: { witness: true } }; process.send(message); return message.overviewCalls; }
  return { Workspace, process, calls, packets, promise, sent, stats };
}

test('the run counter starts at zero without invoking a cooperation operation', () => {
  const h = setup();
  assert.equal(h.stats().run, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(typeof h.Workspace.prototype.run, 'undefined', 'The public action is not a Workspace method');
});

test('the run counter observes startRun once and preserves this, arguments and the original promise', () => {
  const h = setup(), receiver = { original: true }, args = [['a', 'b'], 'goal', 3, 'strict', { labels: true }, undefined, 'reply', 'space'];
  assert.equal(h.Workspace.prototype.startRun.apply(receiver, args), h.promise);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].self, receiver);
  assert.deepEqual(h.calls[0].args, args);
  assert.equal(h.stats().run, 1);
  assert.equal(h.stats().run, 1, 'Reading stats does not replay the operation');
  assert.equal(h.Workspace.prototype.claim.call(receiver, 'member', 'owner', 'chat'), h.promise);
  assert.equal(h.stats().claim, 1, 'Existing method counters keep their meaning');
});

test('a refused startRun is counted and its exact error propagates without retry', () => {
  const error = new Error('Original refusal'), h = setup({ error });
  assert.throws(() => new h.Workspace().startRun('invalid'), value => value === error);
  assert.equal(h.calls.length, 1);
  assert.equal(h.stats().run, 1);
});

test('an absent actual method stays unknown and stats transport keeps its original contract', () => {
  const h = setup({ missing: true });
  assert.equal(h.stats().run, undefined, 'An unobserved channel must not be fabricated as zero');
  const message = { stats: {} }, callback = () => {};
  assert.equal(h.process.send(message, callback), h.sent);
  const packet = h.packets.at(-1);
  assert.equal(packet.self, h.process);
  assert.equal(packet.args[0], message);
  assert.equal(packet.args[1], callback);
});
