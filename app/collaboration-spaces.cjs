(function (target) {
// Shared data contract only. Existing profile/service writers own persistence.
const DEFAULT_ROOM_ID = 'shared';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const roomId = value => value === DEFAULT_ROOM_ID || typeof value === 'string' && UUID.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => Error('协作空间成员记录无法核对；原记录已保留，没有更改成员或共享授权。');
function completedSharedRecord(message) {
  if (!message || message.incomplete || message.kind === 'gap') return false;
  if (message.role === 'human') {
    const deliveries = message.deliveries;
    if (deliveries !== undefined && (!Array.isArray(deliveries) || deliveries.some(delivery => !delivery || typeof delivery !== 'object' || Array.isArray(delivery) || delivery.status !== 'submitted'))) return false;
    return message.status === 'submitted' || message.status === undefined && !message.deliveryTracked ||
      [undefined, 'complete'].includes(message.status) && Boolean(deliveries?.length);
  }
  if (message.role === 'system' && message.status === undefined) return true;
  return ['complete', 'failed', 'interrupted'].includes(message.status);
}

function membership(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw invalid();
  const explicit = Object.hasOwn(session, 'roomIds');
  const ids = explicit ? session.roomIds : session.roomId === DEFAULT_ROOM_ID ? [DEFAULT_ROOM_ID] : [];
  if (!Array.isArray(ids) || [...ids].some(id => !roomId(id)) || new Set(ids).size !== ids.length) throw invalid();
  if (explicit && Object.hasOwn(session, 'roomId') && (session.roomId != null && session.roomId !== DEFAULT_ROOM_ID ||
      Boolean(session.roomId) !== ids.includes(DEFAULT_ROOM_ID))) throw invalid();
  if (!explicit && session.roomId != null && session.roomId !== DEFAULT_ROOM_ID) throw invalid();
  const revisions = Object.hasOwn(session, 'roomMembershipRevisions') ? session.roomMembershipRevisions : {};
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(revisions)) ||
      Object.entries(revisions).some(([id, value]) => !roomId(id) || !revision(value))) throw invalid();
  const legacyRevision = session.memberRevision ?? 0;
  if (!revision(legacyRevision)) throw invalid();
  if (Object.hasOwn(revisions, DEFAULT_ROOM_ID) && revisions[DEFAULT_ROOM_ID] !== legacyRevision) throw invalid();
  return { ids, revisions, legacyRevision };
}

function roomIds(session) { return [...membership(session).ids]; }
function isMember(session, id = DEFAULT_ROOM_ID) {
  if (!roomId(id)) throw invalid();
  return membership(session).ids.includes(id);
}
function membershipRevision(session, id = DEFAULT_ROOM_ID) {
  if (!roomId(id)) throw invalid();
  const state = membership(session);
  return Object.hasOwn(state.revisions, id) ? state.revisions[id] : id === DEFAULT_ROOM_ID ? state.legacyRevision : 0;
}
function withMembership(session, id, joined) {
  if (!roomId(id) || typeof joined !== 'boolean') throw invalid();
  const state = membership(session), present = state.ids.includes(id);
  if (present === joined) return session;
  const nextRevision = membershipRevision(session, id) + 1;
  if (!revision(nextRevision)) throw invalid();
  const ids = joined ? [...state.ids, id] : state.ids.filter(value => value !== id);
  return {
    ...session,
    roomIds: ids,
    // This compatibility field never makes another room look like shared.
    roomId: ids.includes(DEFAULT_ROOM_ID) ? DEFAULT_ROOM_ID : null,
    memberRevision: id === DEFAULT_ROOM_ID ? nextRevision : state.legacyRevision,
    // Retain departed pairs so leave/rejoin cannot revive an old grant (ABA).
    roomMembershipRevisions: { ...state.revisions, [id]: nextRevision },
  };
}

const contract = { DEFAULT_ROOM_ID, roomId, roomIds, isMember, membershipRevision, withMembership, completedSharedRecord };
if (typeof module !== 'undefined' && module.exports) module.exports = contract;
else target.nativeWorkspaceSpaces = contract;
})(typeof window === 'undefined' ? globalThis : window);
