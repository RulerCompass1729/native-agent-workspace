// Owned synthetic daemon only: retain the normal service/IPC/renderer path.
if (typeof process.send !== 'function') throw Error('This fixture requires an owned IPC child');
const prior = new Set(process.listeners('message'));
require('./native-progress.cjs');
// Use one explicit control surface instead of two listeners racing their replies.
const controls = process.listeners('message').filter(fn => !prior.has(fn));
if (controls.length !== 1) throw Error('Requalify the synthetic daemon control listener');
process.off('message', controls[0]);
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { TerminalJournal } = require(path.join(root, 'app/observation.cjs'));
const calls = Object.create(null), runtimes = new Map();
for (const name of Object.getOwnPropertyNames(Workspace.prototype)) {
  const fn = Object.getOwnPropertyDescriptor(Workspace.prototype, name).value;
  if (name === 'constructor' || typeof fn !== 'function') continue;
  calls[name] = 0;
  Workspace.prototype[name] = function (...args) { calls[name]++; return fn.apply(this, args); };
}
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record);
  runtime.terminal.journal = runtime.journal;
  runtime.terminal.snapshot = async () => ({ buffer: runtime.serializer.serialize(), epoch: runtime.journal.epoch, observationIndex: runtime.journal.index, sequence: runtime.sequence, cols: runtime.screen.cols, rows: runtime.screen.rows });
  runtimes.set(record.id, runtime); return runtime;
};
const write = (screen, data) => new Promise(resolve => screen.write(data, resolve));
process.on('message', async q => {
  try {
    const runtime = runtimes.get(q.target);
    if (q.method === 'seed') {
      if (!runtime) throw Error('Unknown synthetic session');
      await write(runtime.screen, 'T79_EPOCH_A');
    } else if (q.method === 'output') {
      await write(runtime.screen, '\r\nT79_OLD_QUEUED');
      const event = runtime.journal.append('output', '\r\nT79_OLD_QUEUED', runtime.screen.cols, runtime.screen.rows, () => runtime.serializer.serialize());
      runtime.emit('terminal', { ...event, sequence: ++runtime.sequence });
    } else if (q.method === 'epoch') {
      // A new display lifetime on the same native identity/control binding.
      runtime.screen.reset(); await write(runtime.screen, 'T79_EPOCH_B');
      runtime.journal = new TerminalJournal(runtime.screen.cols, runtime.screen.rows);
      runtime.terminal.journal = runtime.journal; runtime.sequence = 0;
      runtime.emit('state', 'idle');
    } else if (q.method !== 'stats') throw Error('Unknown fixture command');
    process.send({ requestId: q.id, calls: { ...calls }, runtimes: [...runtimes].map(([id, r]) => ({ id, nativeId: r.record.nativeId, epoch: r.journal.epoch, alive: r.terminal.alive, sequence: r.sequence })) });
  } catch (e) { process.send({ requestId: q.id, error: e.message }); }
});
