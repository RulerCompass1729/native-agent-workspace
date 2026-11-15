// Synthetic session state only; real daemon, placement writer and desktop store.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const bind = Workspace.prototype.bind;
let workspace;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
process.on('message', request => {
  if (request.method !== 'archiveFixture') return;
  try {
    const s = workspace.get(request.target);
    if (!['ended', 'working', 'unknown'].includes(request.value.state)) throw Error('Unexpected synthetic state');
    s.state = request.value.state;
    s.fleet = request.value.children ? Array.from({ length: request.value.children }, (_, n) =>
      ({ event: 'SubagentStart', id: `synthetic-child-${n}`, stale: true })) : [];
    workspace.changed(s.id);
    process.send({ archiveRequestId: request.id });
  } catch (error) { process.send({ archiveRequestId: request.id, error: error.message }); }
});
