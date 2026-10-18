// No native processes or model calls. Hold terminal snapshots until the runner
// releases them, so first-mount and stale-completion races are deterministic.
const { EventEmitter } = require('node:events');
const { NativeHost } = require('../../app/adapters.cjs');
const { Workspace } = require('../../app/workspace.cjs');
const pending = [], inputs = [], runtimes = new Map();
const heldClaims = new Set(), claims = [];
const claim = Workspace.prototype.claim;
Workspace.prototype.claim = function (id, ...args) {
  if (!heldClaims.delete(id)) return claim.call(this, id, ...args);
  return new Promise((resolve, reject) => claims.push({ id, release: method => {
    if (method === 'fail-claim') return reject(Error('Synthetic control failure'));
    claim.call(this, id, ...args);
    if (method === 'release-taken') claim.call(this, id, 'other-test-view', 'terminal');
    resolve();
  } }));
};
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
  if (q.method === 'hold-claim') heldClaims.add(q.target);
  if (['release-claim', 'fail-claim', 'release-taken'].includes(q.method)) { const at = claims.findIndex(c => c.id === q.target); if (at >= 0) claims.splice(at, 1)[0].release(q.method); }
  if (q.method === 'release') {
    const at = pending.findIndex(p => p.id === q.target);
    if (at >= 0) pending.splice(at, 1)[0].resolve({ buffer: 'Synthetic terminal ready\r\n> ', sequence: 0, cols: 100, rows: 30 });
  }
  if (q.method === 'state') runtimes.get(q.target).emit('state', 'idle');
  if (q.method === 'replace') {
    const r = runtimes.get(q.target); r.record.connectionRevision = (r.record.connectionRevision || 0) + 1; r.emit('state', 'idle');
  }
  if (q.method === 'fail') { const at = pending.findIndex(p => p.id === q.target); if (at >= 0) pending.splice(at, 1)[0].reject(Error('Synthetic snapshot failure')); }
  process.send({ requestId: q.id, pending: pending.map(p => p.id), claims: claims.map(c => c.id), inputs });
});
