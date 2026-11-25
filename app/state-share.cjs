'use strict';
// Every window of this process connects to every backend itself and takes the backend's whole state, some twice
// (the reply to `initial` and the `state` broadcasts build on separate histories: state-delta.cjs). Nearly all of
// it is messages, and the windows' copies are identical, so each message's copies are kept as one object. Memory
// then grows with what the backends hold, not with how many windows are open (2026-11-24: two main-process crashes
// with the V8 heap full). Main only reads messages: a change in place would reach every window.
const LISTS = ['sessions', 'rooms'];
// A message nested deeper than this is never shared: it must not use up the stack inside a socket's data handler.
const DEEPEST = 100;

// Equal JSON values with the keys in the same order, so that a shared message still reads as its own frame wrote it.
function same(a, b, depth = 0) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth >= DEEPEST) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], depth + 1)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  if (keys.length !== other.length) return false;
  for (let i = 0; i < keys.length; i++) if (keys[i] !== other[i] || !same(a[keys[i]], b[keys[i]], depth + 1)) return false;
  return true;
}

// The messages of every record of a snapshot by its key; a key that names two records is left out.
function messageLists(snapshot) {
  const found = new Map(), twice = new Set();
  const note = (prefix, record) => {
    if (!record || typeof record !== 'object' || !Array.isArray(record.messages)) return;
    const id = record.id ?? 'shared';
    if (typeof id !== 'string') return;
    const key = prefix + id;
    if (found.has(key)) twice.add(key); else found.set(key, record.messages);
  };
  for (const list of LISTS) if (Array.isArray(snapshot?.[list])) for (const record of snapshot[list]) note(`${list}:`, record);
  note('room:', snapshot?.room);
  for (const key of twice) found.delete(key);
  return found;
}

// Replaces, in the snapshot just received, each message equal to one the given snapshot holds with that one.
function shareWith(snapshot, held) {
  const lists = messageLists(held);
  if (!lists.size) return;
  for (const [key, messages] of messageLists(snapshot)) {
    const before = lists.get(key);
    if (!before) continue;
    let byId = null;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message === before[i]) continue;
      if (!message || typeof message !== 'object') continue;
      let candidate = before[i];
      if (candidate?.id !== message.id) {
        byId ||= new Map(before.map(m => [m?.id, m]));
        candidate = byId.get(message.id);
      }
      if (candidate && same(candidate, message)) messages[i] = candidate;
    }
  }
}

// What the connections of one backend hold, newest arrival first.
const groups = new Map();
let arrivals = 0;
// A connection's part in the sharing for a backend, named by its endpoint. `take(snapshot)` keeps its messages as
// the group already holds them and records the snapshot as the newest; `leave()` ends this connection's part.
function join(endpoint, holds) {
  let group = groups.get(endpoint);
  if (!group) groups.set(endpoint, group = new Set());
  const member = { holds, snapshots: new Map() };
  group.add(member);
  return {
    take(name, snapshot) {
      let newest = null, at = -1;
      for (const other of group) for (const [held, arrived] of other.snapshots) if (arrived > at && !(other === member && held === name)) { newest = other.holds(held); at = arrived; }
      if (newest) shareWith(snapshot, newest);
      member.snapshots.set(name, ++arrivals);
    },
    leave() {
      group.delete(member);
      if (!group.size) groups.delete(endpoint);
    },
  };
}
module.exports = { join, shareWith, same };
