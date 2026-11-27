const fs = require('node:fs'), path = require('node:path');
const { uiError } = require('./ui-errors.cjs');
const { readLock } = require('./service-lock.cjs');
const { readLayout } = require('./service-layout.cjs');
const serviceBinding = require('./service-binding.cjs');
const { sessionPlan } = require('./backend-switch.cjs');
const { Workspace } = require('./workspace.cjs');

const retiredStates = new Map();
function retiredState(directory) {
  const workspace = fs.lstatSync(path.join(directory, 'workspace.json'));
  if (!workspace.isFile() || workspace.uid !== process.getuid() || (workspace.mode & 0o077)) throw uiError('error.service.invalidLayout');
  const files = ['room-records.json', 'operator-records.json'].map(name => {
    try { return fs.lstatSync(path.join(directory, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  const stamp = [workspace, ...files].map(stat => stat ? [stat.dev, stat.ino, stat.ctimeMs, stat.mtimeMs, stat.size].join(':') : '').join('/');
  const cached = retiredStates.get(directory);
  const cachedState = cached?.stamp === stamp ? cached.state.deref() : null;
  if (cachedState) return cachedState;
  const stored = Workspace.recordedSnapshot(directory);
  if (stored.storageWarning || !stored.sessions.every(session => ['ended', 'recoverable'].includes(session.state) &&
      sessionPlan(session, session.state).carry)) throw uiError('error.service.invalidLayout');
  const state = { ...stored, protocol: 1, capabilities: ['collaborationSpacesV1', 'clearSharedHistory', 'resume', 'operatorControl1a'],
    storageRetryable: false, wakePolicy: undefined };
  retiredStates.set(directory, { stamp, state: new WeakRef(state) });
  return state;
}

function hasServiceTransport(directory) {
  if (readLock(path.join(directory, 'service.lock')) !== undefined) return true;
  try { fs.lstatSync(path.join(directory, 'connection.json')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

function readRetiredBackend(dataDir, key, layout = readLayout(dataDir)) {
  if (!layout.retired?.includes(key)) return null;
  const directory = path.join(dataDir, key);
  if (hasServiceTransport(directory)) return null;
  serviceBinding.assertBinding(serviceBinding.readBinding(directory));
  const state = retiredState(directory);
  return hasServiceTransport(directory) ? null : state;
}

const invalidateRetiredState = directory => retiredStates.delete(directory);
module.exports = { retiredState, hasServiceTransport, readRetiredBackend, invalidateRetiredState };
