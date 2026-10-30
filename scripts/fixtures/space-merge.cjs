// Owned synthetic fault controls only. No production imports this fixture.
require('./multispace.cjs');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
let workspace, failImport = 0, archiveFailure;
const faults = { targetWrites: 0, sourceLeaves: 0, aliasChanges: 0 };
const snapshot = Workspace.prototype.snapshot;
Workspace.prototype.snapshot = function(...args) { workspace = this; return snapshot.apply(this, args); };
const merge = Workspace.prototype.mergeSnapshot;
Workspace.prototype.mergeSnapshot = function(batch) {
  if (!failImport) return merge.call(this, batch);
  failImport--; const rename = fs.renameSync, target = path.join(this.dataDir, 'room-records.json');
  fs.renameSync = (from, to) => {
    if (path.resolve(to) === target) { faults.targetWrites++; throw Error('Synthetic owned merge write failure'); }
    return rename(from, to);
  };
  try { return merge.call(this, batch); } finally { fs.renameSync = rename; }
};
const join = Workspace.prototype.join;
Workspace.prototype.join = function(id, joined, room) {
  if (!joined && archiveFailure?.room === room && archiveFailure.count++ >= archiveFailure.after) {
    archiveFailure = null; faults.sourceLeaves++; throw Error('Synthetic source archive member failure');
  }
  return join.call(this, id, joined, room);
};
process.on('message', request => {
  if (request.channel !== 't69merge') return;
  try {
    if (!workspace) throw Error('Synthetic workspace is not ready');
    if (request.method === 'failImport') failImport = 1;
    else if (request.method === 'failArchive') archiveFailure = { room: request.target, after: request.value, count: 0 };
    else if (request.method === 'alias') {
      const session = workspace.sessions.get(request.target);
      if (!session || typeof request.value !== 'string') throw Error('Unknown owned synthetic alias');
      session.nativeId = request.value; faults.aliasChanges++; workspace.emit('change');
    } else if (request.method !== 'stats') throw Error('Unknown synthetic merge control');
    process.send({ channel: 't69merge', requestId: request.id, faults: { ...faults } });
  } catch (error) { process.send({ channel: 't69merge', requestId: request.id, error: error.message }); }
});
