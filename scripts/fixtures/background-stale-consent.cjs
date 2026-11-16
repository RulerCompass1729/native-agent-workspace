// Only a synthetic terminal's journal and lifecycle; no provider process or model.
require('./background-control.cjs');
const path = require('node:path');
const { Workspace } = require(path.join(process.env.NAW_TEST_APP_ROOT, 'app/workspace.cjs'));
const { TerminalJournal } = require(path.join(process.env.NAW_TEST_APP_ROOT, 'app/observation.cjs'));
const operation = require(path.join(process.env.NAW_TEST_APP_ROOT, 'app/background-operation.cjs'));
const bind = Workspace.prototype.bind, snapshot = Workspace.prototype.snapshot, runtimes = new Map();
Workspace.prototype.bind = function (record, runtime) {
  const journal = new TerminalJournal(100, 30);
  journal.append('output', 'Synthetic terminal', 100, 30, () => 'Synthetic terminal');
  runtime.terminal.journal = journal;
  runtime.terminal.resize = (cols, rows) => journal.append('resize', '', cols, rows, () => 'Synthetic terminal');
  runtimes.set(record.id, { runtime, workspace: this }); return bind.call(this, record, runtime);
};
// A single native snapshot supplies both the daemon conditional write and GUI.
// The 86545eab base predates the production dialog detector.
Workspace.prototype.snapshot = function (...args) {
  const value = snapshot.apply(this, args);
  return { ...value, sessions: value.sessions.map(s => ({ ...s, nativeTerminalDialog: runtimes.get(s.id)?.runtime.nativeTerminalDialog })) };
};
process.on('message', request => {
  if (!request.method?.startsWith('consent')) return;
  const entry = runtimes.get(request.target), runtime = entry?.runtime;
  if (!runtime) return process.send({ consentRequestId: request.id, error: 'Unknown synthetic terminal' });
  if (request.method === 'consentState') runtime.emit('state', request.value);
  if (request.method === 'consentDialog') runtime.nativeTerminalDialog = request.value;
  if (request.method === 'consentOutput') for (let n = 0; n < request.value; n++) runtime.terminal.journal.append('output', 'Synthetic redraw', 100, 30, () => 'Synthetic redraw');
  if (request.method === 'consentResize') runtime.terminal.resize(...request.value);
  const session = entry.workspace.snapshot().sessions.find(s => s.id === request.target);
  process.send({ consentRequestId: request.id, proof: operation.terminalInputProof(session), dialog: session.nativeTerminalDialog || null });
});
