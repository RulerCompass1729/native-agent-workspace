// R186.1: a waiting stop card is bound to the session it names, not to who holds that session meanwhile.
// Taking a session into a window moves owner/controlRevision and state; none of that changes what stopping
// it means, and voiding the second merged card for it made "Confirm all" unclickable.
const test = require('node:test'), assert = require('node:assert/strict');
const { fingerprint } = require('../background-fingerprint.cjs');

const roomState = { apply: state => state, value: {}, metadata: id => ({ id, restoreMembers: [], restorePlacements: [] }), sessionArchives: {} };
const session = (changes = {}) => ({ id: 's1', nativeId: 'n1', pid: 10, owner: 'window-a', state: 'idle', activeTurnId: null, pendingTag: null,
  controlRevision: 0, connectionRevision: 0, archived: false, approval: null, nativeApproval: null, ...changes });
const print = state => fingerprint({ method: 'stop', arguments: ['s1'] }, { state, actor: { id: 'operator', nativeId: 'on' }, context: { view: {} }, roomState, sessionLabels: { apply: s => s }, client: null });

test('a stop card keeps its consent while another window holds the target; a replaced or archived target still voids it', () => {
  const asked = print({ sessions: [session()], rooms: [{ id: 'shared', memberIds: [] }] });
  const takenOver = print({ sessions: [session({ owner: 'window-b', controlRevision: 3, pid: 11, state: 'working' })], rooms: [{ id: 'shared', memberIds: [] }] });
  assert.deepEqual(takenOver, asked, 'owner, control revision, pid and state are not what stopping names');
  assert.notDeepEqual(print({ sessions: [session({ nativeId: 'other' })], rooms: [{ id: 'shared', memberIds: [] }] }), asked, 'another native session is another target');
  assert.notDeepEqual(print({ sessions: [session({ archived: true })], rooms: [{ id: 'shared', memberIds: [] }] }), asked, 'an archived target is void');
});
