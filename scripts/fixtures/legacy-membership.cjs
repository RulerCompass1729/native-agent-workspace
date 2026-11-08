// Seed legacy overlapping space membership in an owned synthetic backend. Test only; production code never imports this.
// Since 3751738 a session has one home: Workspace.join refuses a second space (error.movePlacementUnsupported), while
// overlapping records saved before that change are retained for inspection (README). A GUI script that checks how such
// records look loads this with --require next to its backend fixture. A join into a further space then seeds the
// record exactly as app/tests/multispace-routing.test.cjs seedLegacyJoin does; every other join is the product's own.
// So a script that checks the refusal of a second home (error.movePlacementUnsupported) must not load it.
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT;
if (!root) throw Error('legacy-membership fixture: NAW_TEST_APP_ROOT is required');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { isMember, withMembership } = require(path.join(root, 'app/collaboration-spaces.cjs'));
const join = Workspace.prototype.join;
Workspace.prototype.join = function (id, wanted, roomId = 'shared') {
  const s = this.get(id);
  if (!wanted || !s?.roomIds?.length || isMember(s, roomId)) return join.call(this, id, wanted, roomId);
  Object.assign(s, withMembership(s, roomId, true)); this.roomFor(roomId, true);
  this.pauseRoom(roomId, 'Legacy fixture metadata changed'); this.sharedReplies.refresh(id); this.changed(); this.persist();
  if (this.storageWarning) throw Error(this.storageWarning);
};
