'use strict';
// Typed B6 READY facts only. No reply parsing, native history or execution.
const { createHash } = require('node:crypto');
const { validReady, ITEM_TEXT_LIMIT } = require('./queue-dispatch.cjs');
const { validateEvent } = require('./butler-policy.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyPart = value => typeof value === 'string' ? value : null;
const identity = (roomId, itemId) => [keyPart(roomId), keyPart(itemId)];
const eventId = (roomId, itemId) => `butler-ready:${hash(identity(roomId, itemId))}`;
const sourceRef = (roomId, itemId) => typeof roomId === 'string' && typeof itemId === 'string'
  ? `queue-ready:${roomId}:${itemId}` : `queue-ready-parent:${hash(identity(roomId, itemId))}`;
const parentRef = (roomId, parentId) => typeof roomId === 'string' && typeof parentId === 'string'
  ? `queue-ready-parent:${roomId}:${parentId}` : `queue-ready-parent:${hash(identity(roomId, parentId))}`;
const title = ready => `READY ${ready.branch} ${ready.commit}`;
const invalid = () => { throw Error('Invalid typed READY source'); };

function checkedIdentity(roomId, itemId) {
  return validateEvent({ eventId: 'ready-identity', sourceRef: 'ready-identity', kind: 'blocked',
    payload: { spaceId: roomId, itemId } }).payload;
}
function blocked(id, ref, reason, roomId, itemId) {
  // Keep individually valid IDs, never rejected business text or opaque data.
  const payload = { reason };
  for (const [field, value] of [['spaceId', roomId], ['itemId', itemId]]) {
    try {
      validateEvent({ eventId: 'ready-id', sourceRef: 'ready-id', kind: 'blocked', payload: { [field]: value } });
      payload[field] = value;
    } catch { /* A malformed ID is represented only by the stable fallback hash. */ }
  }
  try { return validateEvent({ eventId: id, sourceRef: ref, kind: 'blocked', payload }); }
  catch { return validateEvent({ eventId: id, sourceRef: `queue-ready-parent:${hash(identity(roomId, itemId))}`,
    kind: 'blocked', payload }); }
}

function queueReadySource(roomId, item, memberName) {
  if (!item || !Object.hasOwn(item, 'ready') || item.ready === undefined) return null;
  const itemId = item.id, id = eventId(roomId, itemId), ref = sourceRef(roomId, itemId);
  try {
    checkedIdentity(roomId, itemId);
    if (!validReady(item.ready) || typeof item.text !== 'string' || item.text.length > ITEM_TEXT_LIMIT) invalid();
    const payload = { spaceId: roomId, itemId, title: title(item.ready), text: item.text };
    if (item.sentTo !== undefined && item.sentTo !== null) payload.memberId = item.sentTo;
    if (memberName !== undefined) payload.memberName = memberName;
    return validateEvent({ eventId: id, sourceRef: ref, kind: 'ready', payload });
  } catch { return blocked(id, ref, 'input-rejected', roomId, itemId); }
}

function storedReadySource(roomId, parentEvent) {
  const parentId = parentEvent?.id, monitor = parentEvent?.monitor;
  let itemId, ref;
  try {
    if (parentEvent.role !== 'system' || parentEvent.kind !== 'queue' ||
        !monitor || monitor.kind !== 'ready' || !validReady(monitor)) invalid();
    itemId = monitor.itemId;
    checkedIdentity(roomId, itemId);
    if (monitor.key !== `ready:${roomId}:${itemId}`) invalid();
    ref = sourceRef(roomId, itemId);
    const value = validateEvent(parentEvent.butlerSource);
    if (value.eventId !== eventId(roomId, itemId) || value.sourceRef !== ref || value.payload.spaceId !== roomId ||
        value.payload.itemId !== itemId || value.payload.memberId !== undefined && value.payload.memberId !== parentEvent.sessionId) invalid();
    const keys = Object.keys(value.payload);
    if (value.kind === 'ready') {
      if (value.payload.title !== title(monitor) || typeof value.payload.text !== 'string' || value.payload.text.length > ITEM_TEXT_LIMIT ||
          keys.some(key => !['spaceId', 'itemId', 'title', 'text', 'memberId', 'memberName'].includes(key))) invalid();
    } else if (value.kind !== 'blocked' || value.payload.reason !== 'input-rejected' ||
        keys.some(key => !['spaceId', 'itemId', 'reason'].includes(key))) invalid();
    return value;
  } catch {
    const id = `butler-ready-rejected:${hash(identity(roomId, parentId))}`;
    // A valid monitor keeps its canonical source scope so a repaired auxiliary
    // field can resolve the blocked source without inventing a second READY.
    return blocked(id, ref || parentRef(roomId, parentId), 'source-invalid', roomId, itemId || parentId);
  }
}

module.exports = { queueReadySource, storedReadySource };
