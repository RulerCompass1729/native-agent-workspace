// A held synthetic ACK exercises the existing native send boundary, never a
// product inference/provider. All other runtime behavior uses the known fixture.
require('./collaboration-overview.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = NativeHost.prototype.create, next = new Set(), pending = new Map();
let ownedWorkspace;
const snapshot = Workspace.prototype.snapshot;
Workspace.prototype.snapshot = function(...args) { ownedWorkspace = this; return snapshot.apply(this, args); };
NativeHost.prototype.create = function(record) {
  const runtime = create.call(this, record), send = runtime.send;
  runtime.send = function(text, tag, guard) {
    if (!next.delete(record.id)) return send.call(this, text, tag, guard);
    return new Promise((resolve, reject) => pending.set(record.id, async () => {
      pending.delete(record.id);
      try { if (!guard()) throw Object.assign(Error('Synthetic authority expired'), { notSent: true }); resolve(await send.call(this, text, tag, guard)); }
      catch (error) { reject(error); }
    }));
  };
  return runtime;
};
process.on('message', async request => {
  if (request.channel !== 't69') return;
  try {
    if (request.method === 'holdSend') next.add(request.target);
    else if (request.method === 'releaseSend') { const release = pending.get(request.target); if (!release) throw Error('No held fixture send'); await release(); }
    else if (request.method === 'storageFailure') { ownedWorkspace.storageWarning = 'Synthetic space save failure'; ownedWorkspace.storageFailure = 'write'; ownedWorkspace.emit('change'); }
    else if (request.method === 'storageRecovered') { ownedWorkspace.storageWarning = null; ownedWorkspace.storageFailure = null; ownedWorkspace.changed(); }
    else if (request.method !== 'pending') throw Error('Unknown fixture action');
    process.send({ channel: 't69', requestId: request.id, pending: [...pending.keys()] });
  } catch (error) { process.send({ channel: 't69', requestId: request.id, error: error.message }); }
});
