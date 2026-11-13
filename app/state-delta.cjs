'use strict';
// Backend state frames for clients that said at their handshake that they can take them
// (stateDelta: 1). In such a frame a session's or space's messages may read
// { messagesKeep: k, messages: [rest] }: the first k messages are those of the client's
// previous state, the rest follow. ServiceClient rebuilds the whole snapshot before anything
// else sees it. Messages are compared by content, since the workspace changes some in place.
const crypto = require('node:crypto');
const { encodeFrame } = require('./service-transport.cjs');

const LISTS = ['sessions', 'rooms'];
const digest = text => crypto.hash('sha256', text, 'base64');

// Each record that carries messages, under a key that stays the same from one frame to the next.
// A key seen twice in one snapshot is never used for a delta.
function records(snapshot) {
  const found = new Map(), twice = new Set();
  const note = (key, record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    if (found.has(key)) twice.add(key);
    found.set(key, record);
  };
  for (const list of LISTS) {
    if (Array.isArray(snapshot?.[list])) for (const record of snapshot[list]) note(`${list}:${record?.id ?? 'shared'}`, record);
  }
  note('room', snapshot?.room);
  for (const key of twice) found.set(key, null);
  return found;
}
const keyOf = (list, record) => list === 'room' ? 'room' : `${list}:${record?.id ?? 'shared'}`;
// The same rule for every record of a snapshot: a list item or the single room.
function mapRecords(snapshot, change) {
  const out = { ...snapshot };
  for (const list of LISTS) if (Array.isArray(snapshot[list])) out[list] = snapshot[list].map(record => change(keyOf(list, record), record));
  if (Object.hasOwn(snapshot, 'room')) out.room = change('room', snapshot.room);
  return out;
}

// How long a session's digests may be carried from broadcast to broadcast before every record is
// digested again: a change that touched a session's messages without naming it reaches a delta
// client within this time.
const CARRY_MS = 2000;

function createStateEncoder(hash = digest, clock = Date.now) {
  // The digests of the broadcasts some client may still hold, by broadcast number.
  let generation = 0, digestedAll = -Infinity; const kept = new Map();
  // The digests of one snapshot's messages, by record key. `changed` names the sessions whose messages
  // may have changed since the broadcast before (a Set of ids; null: any record's). Every other session
  // keeps the digests of that broadcast; spaces are always digested again (workspace.changed).
  const digests = (snapshot, changed, before) => {
    const now = clock(), carry = Boolean(changed && before && now - digestedAll < CARRY_MS), result = new Map();
    if (!carry) digestedAll = now;
    for (const [key, record] of records(snapshot)) {
      if (!record || !Array.isArray(record.messages)) continue;
      const same = carry && key === `sessions:${record.id}` && typeof record.id === 'string' && !changed.has(record.id) ? before.get(key) : null;
      result.set(key, same || record.messages.map(message => hash(JSON.stringify(message) ?? 'null')));
    }
    return result;
  };
  return {
    // One broadcast. Every frame is encoded at most once, and only when asked for, within this
    // same synchronous turn: the snapshot shares message objects with the live workspace.
    frames(snapshot, withDelta, changed = null) {
      const current = ++generation, now = withDelta ? digests(snapshot, changed, kept.get(current - 1)) : null;
      if (now) kept.set(current, now);
      let full = null; const deltas = new Map();
      const whole = () => full ||= encodeFrame({ event: 'state', data: snapshot });
      return {
        generation: current,
        full: whole,
        // From the state of an earlier broadcast to this one; whole when that state is not known.
        delta(base) {
          const before = kept.get(base);
          if (!now || !before || base === current) return whole();
          if (!deltas.has(base)) deltas.set(base, encodeFrame({ event: 'state', delta: 1, data: mapRecords(snapshot, (key, record) => {
            const after = now.get(key), earlier = before.get(key);
            if (!after || !earlier || !record || !Array.isArray(record.messages)) return record;
            let keep = 0;
            while (keep < after.length && keep < earlier.length && after[keep] === earlier[keep]) keep++;
            return keep ? { ...record, messages: record.messages.slice(keep), messagesKeep: keep } : record;
          }) }));
          return deltas.get(base);
        },
      };
    },
    // Forget the digests of every broadcast not listed: no client can build on them any more.
    keep(generations) { for (const known of kept.keys()) if (!generations.has(known)) kept.delete(known); },
    held: () => kept.size,
  };
}

// One state broadcast. Each target is { writer, delta } where delta is null for a client that
// takes whole snapshots, and for one that takes deltas { sent, waiting }: the broadcast last
// queued for it, and the state that frame was built on. A queued state is dropped when the next
// one comes (createWriter), so the client then still holds what the dropped frame was built on.
// A client that holds nothing yet gets a whole snapshot.
// changed: the sessions whose messages changed since the broadcast before, or null (createStateEncoder).
function sendState(encoder, targets, snapshot, changed = null) {
  const frames = encoder.frames(snapshot, targets.some(target => target.delta), changed), held = new Set([frames.generation]);
  for (const { writer, delta } of targets) {
    if (!delta) { writer.sendFrame(frames.full(), 'state'); continue; }
    const base = writer.queued('state') ? delta.waiting : delta.sent;
    writer.sendFrame(base == null ? frames.full() : frames.delta(base), 'state');
    delta.waiting = base; delta.sent = frames.generation;
    if (base != null) held.add(base);
  }
  encoder.keep(held);
}

// The whole snapshot from a delta frame and the client's previous state. Throws when the frame
// does not fit that state: the caller closes the connection rather than guess.
function rebuildState(base, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid state delta');
  const from = base ? records(base) : new Map();
  return mapRecords(data, (key, record) => {
    if (!record || typeof record !== 'object' || !Object.hasOwn(record, 'messagesKeep')) return record;
    const keep = record.messagesKeep, earlier = from.get(key);
    if (!Number.isInteger(keep) || keep < 1 || !Array.isArray(record.messages) || !earlier || !Array.isArray(earlier.messages) || keep > earlier.messages.length) throw Error('Invalid state delta');
    // The keys in their original order, so that a rebuilt record reads as the whole one did.
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'messagesKeep').map(([name, value]) => [name, name === 'messages' ? earlier.messages.slice(0, keep).concat(value) : value]));
  });
}

module.exports = { createStateEncoder, sendState, rebuildState };
