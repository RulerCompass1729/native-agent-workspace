// Current source with explicitly synthetic version reports; never an old binary.
require('./collaboration-overview.cjs');
const path = require('node:path');
const { Workspace } = require(path.join(process.env.NAW_TEST_APP_ROOT, 'app/workspace.cjs'));
const snapshot = Workspace.prototype.snapshot;
let owned;
Workspace.prototype.snapshot = function(...args) {
  owned = this;
  return { ...snapshot.apply(this, args), runtimeVersion: process.env.NAW_APP_VERSION };
};
process.on('message', request => {
  if (request.channel !== 't81compact') return;
  try {
    if (!owned) throw Error('Owned synthetic backend not ready');
    if (request.method === 'version') process.env.NAW_APP_VERSION = request.value;
    else if (request.method === 'ended') for (const session of owned.sessions.values()) session.state = 'ended';
    else throw Error('Unknown synthetic version control');
    owned.emit('change'); process.send({ channel: request.channel, requestId: request.id });
  } catch (error) { process.send({ channel: request.channel, requestId: request.id, error: error.message }); }
});
