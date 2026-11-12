'use strict';
// Which words a delivery's space and the person are given about an integration handoff (B6,
// E2b). It only maps the record's states and reasons to message keys and their values: it
// writes nothing, shows nothing and knows no task text beyond the label it is handed.

// Reasons that say the same thing to a person share one sentence.
const PLAIN = {
  'review-off': 'reviewOff', 'review-cap': 'reviewCap', 'checkpoint-invalid': 'checkpointInvalid',
  'merge-unverified': 'unverified', 'main-unreadable': 'mainUnreadable',
  // Three different troubles with the message itself: sent but never confirmed; refused before
  // it was sent; delivered, but the reply could not be read afterwards.
  'send-unconfirmed': 'notDelivered', 'send-refused': 'sendRefused', 'record-missing': 'replyUnread',
  // No line for one delivery in an answer; no answer at all (which keeps the one place taken).
  'no-result': 'noAnswer', 'no-reply': 'noReply', 'person-intervened': 'personTyped', 'held-other': 'other',
  'integrator-unset': 'integratorUnset', 'integrator-in-space': 'integratorInSpace', 'backlog-full': 'backlogFull', 'repository-unset': 'repositoryUnset',
};
const WITH_SUBJECT = { 'lock-held': 'lockHeld', 'integrator-missing': 'integratorGone', conflict: 'conflict', installable: 'installable', 'returned-limit': 'returnedLimit' };
// What a held delivery, and one inside a waiting handoff, can be told.
const HELD = ['reviewOff', 'reviewCap', 'lockHeld', 'checkpointInvalid', 'unverified', 'mainUnreadable', 'notDelivered', 'sendRefused', 'replyUnread', 'noAnswer', 'noReply',
  'personTyped', 'integratorGone', 'integratorInSpace', 'conflict', 'other'];
const WAITING = ['noReply', 'personTyped', 'integratorInSpace', 'conflict'];

// The sentence group of a reason, with the reason's subject (a lock's owner, a commit, a branch).
function group(reason) {
  if (typeof reason !== 'string') return null;
  if (Object.hasOwn(PLAIN, reason)) return { name: PLAIN[reason], subject: '' };
  const split = reason.indexOf(':');
  const kind = split > 0 ? reason.slice(0, split) : '';
  return Object.hasOwn(WITH_SUBJECT, kind) && reason.length > split + 1 ? { name: WITH_SUBJECT[kind], subject: reason.slice(split + 1) } : null;
}
const text = (value, fallback) => (typeof value === 'string' && value ? value : fallback);
const short = value => (typeof value === 'string' ? value.slice(0, 12) : '');

// The space record for one fact of the record's showable() list: { key, params }, or null for
// a fact that has no sentence.
function spaceWords(fact) {
  if (!fact || typeof fact.branch !== 'string' || typeof fact.commit !== 'string') return null;
  // A delivery without a task label is named by its branch.
  const base = { text: text(fact.text, fact.branch), branch: fact.branch, commit: short(fact.commit) };
  if (fact.outcome === 'handed') return { key: 'notice.handoff.handed', params: base };
  if (fact.outcome === 'merged') {
    const passed = fact.tests?.passed, total = fact.tests?.total;
    if (typeof fact.as !== 'string' || !Number.isSafeInteger(passed) || !Number.isSafeInteger(total)) return null;
    return { key: 'notice.handoff.merged', params: { ...base, as: short(fact.as), passed, total } };
  }
  if (fact.outcome === 'returned') return { key: 'notice.handoff.returned', params: { ...base, note: text(fact.note, '—') } };
  if (fact.outcome !== 'held' && fact.outcome !== 'waiting') return null;
  const found = group(fact.reason);
  const allowed = fact.outcome === 'held' ? HELD : WAITING;
  // A reason without a sentence of its own is shown as the integrator's own words or as its name
  // (on hold), or without a cause (waiting): never as a cause it is not.
  const name = found && allowed.includes(found.name) ? found.name : 'other';
  const key = `notice.handoff.${fact.outcome}.${name}`;
  if (name === 'lockHeld') return { key, params: { ...base, owner: found.subject } };
  if (name === 'other' && fact.outcome === 'held') return { key, params: { ...base, note: text(fact.note, text(fact.reason, '—')) } };
  return { key, params: base };
}

// The notice for one reason, from the record's noticeInfo(): { title, key, params }, or null for
// a reason the person is not notified about. It carries a count, never a task's text.
function personWords(info) {
  const found = group(info?.reason);
  if (!found || found.name === 'personTyped') return null;
  const count = Number.isSafeInteger(info.count) && info.count >= 0 ? info.count : 0;
  const title = 'os.handoffTitle', key = `os.handoff.${found.name}`;
  if (found.name === 'backlogFull') return { title, key, params: {} };
  if (found.name === 'installable') return { title, key, params: { commit: short(found.subject) } };
  // The subject is "<space>:<branch>" (or the branch alone); a branch name holds no colon.
  if (found.name === 'returnedLimit') return { title, key, params: { branch: found.subject.slice(found.subject.lastIndexOf(':') + 1) } };
  if (found.name === 'lockHeld') return { title, key, params: { owner: found.subject, count } };
  // A handoff that waits with nothing left inside it still has a question for the person.
  if (found.name === 'conflict' && count === 0) return { title, key: 'os.handoff.decision', params: {} };
  return { title, key, params: { count } };
}

// The short cause on a held delivery's row in the queue panel: { key, params }. A reason without a
// sentence of its own is shown as the integrator's own words; with no words either, as not given.
function rowWords(item) {
  const found = group(item?.reason);
  const name = found && HELD.includes(found.name) ? found.name : 'other';
  if (name === 'lockHeld') return { key: 'queue.handoff.why.lockHeld', params: { owner: found.subject } };
  if (name !== 'other') return { key: `queue.handoff.why.${name}`, params: {} };
  return typeof item?.note === 'string' && item.note ? { key: 'queue.handoff.why.other', params: { note: item.note } } : { key: 'queue.handoff.why.unknown', params: {} };
}

module.exports = { spaceWords, personWords, rowWords, group };
