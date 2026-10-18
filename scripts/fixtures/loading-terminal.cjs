// No native processes or model calls. Hold terminal snapshots until the runner
// releases them, so first-mount and stale-completion races are deterministic.
const { EventEmitter } = require('node:events');
const { NativeHost } = require('../../app/adapters.cjs');
const pending = [], inputs = [], runtimes = new Map();
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const r = new EventEmitter(); r.chatAvailable = true; r.record = record;
  r.start = async () => r.emit('state', 'idle');
  r.stop = async () => ({ state: 'ended' });
  r.terminal = { alive: true, resize() {}, input(data) { inputs.push({ id: record.id, data }); }, snapshot() {
    return new Promise((resolve, reject) => pending.push({ id: record.id, resolve, reject }));
  } };
  r.openTerminal = async () => r.terminal;
  runtimes.set(record.id, r); return r;
};
process.on('message', q => {
  if (q.method === 'release') {
    const at = pending.findIndex(p => p.id === q.target);
    if (at >= 0) pending.splice(at, 1)[0].resolve({ buffer: 'Synthetic terminal ready\r\n> ', sequence: 0, cols: 100, rows: 30 });
  }
  if (q.method === 'state') runtimes.get(q.target).emit('state', 'idle');
  if (q.method === 'replace') {
    const r = runtimes.get(q.target); r.record.connectionRevision = (r.record.connectionRevision || 0) + 1; r.emit('state', 'idle');
  }
  if (q.method === 'fail') { const at = pending.findIndex(p => p.id === q.target); if (at >= 0) pending.splice(at, 1)[0].reject(Error('Synthetic snapshot failure')); }
  process.send({ requestId: q.id, pending: pending.map(p => p.id), inputs });
});
