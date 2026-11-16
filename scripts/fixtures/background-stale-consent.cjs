// Only a synthetic terminal's journal and lifecycle; no provider process or model.
require('./background-control.cjs');
const path = require('node:path');
const { Workspace } = require(path.join(process.env.NAW_TEST_APP_ROOT, 'app/workspace.cjs'));
const bind = Workspace.prototype.bind, runtimes = new Map();
Workspace.prototype.bind = function (record, runtime) {
  runtime.terminal.journal = { epoch: 'consent-fixture-' + record.id, index: 1 };
  runtimes.set(record.id, runtime); return bind.call(this, record, runtime);
};
process.on('message', request => {
  if (request.method === 'consentState') runtimes.get(request.target).emit('state', request.value);
});
