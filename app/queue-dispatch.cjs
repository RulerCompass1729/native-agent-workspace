const firstHandoff = require('./rotation-handoff.cjs');
'use strict';
// Space task queues (board top 2026-11-08 16:12): when a member is truly idle,
// NAW itself sends that member's next queued item through the backend's own
// "dispatch" input, which is never a takeover or human input. Long-lived members
// are rotated into a new session with a written handoff (user 2026-11-08).
// The policy functions are pure; QueueDispatcher runs them in the main process.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { roomIds, membershipRevision, placementRevision } = require('./collaboration-spaces.cjs');
const { uiError, uiNotice } = require('./ui-errors.cjs');
const { displayMessage } = require('./ui-locale.js');
const gitWorktree = require('./git-worktree.cjs');
const fleet = require('./renderer/fleet-observation.js');
const { noticeText } = require('./answer-notices.cjs');
const { codexQuotaBlock } = require('./native-usage.js');
const { rotationBlocked, rotationEpoch, queuePurposeValid } = require('./submission-policy.cjs');
const { detached } = require('./background-operation.cjs');
const { CompactionCounter, claudeFiles, claudeProjects } = require('./compaction-count.cjs');
const { sessionPlan, endedByThisStop } = require('./backend-switch.cjs');

const CAPABILITY = 'queueDispatchV1';
const ROTATION_CAPABILITY = 'rotationControlEpochV1';
const ITEM_TEXT_LIMIT = 6000;
const SEND_TEXT_LIMIT = 16000;
// The member's own reply, kept on the item so a settled queue row can show what came back.
const ITEM_REPLY_LIMIT = 200;
const QUEUE_LIMIT = 300;
const ITEM_STATUSES = ['queued', 'sent', 'done', 'waiting', 'cancelled', 'failed'];
const OPEN_STATUSES = ['queued', 'sent', 'waiting'];
// The waiting items that ask the person nothing: the person stepped in, or no reply came back. Such an
// item stays open in the list for the person to look at (11-12: they held their members until the person
// pressed a button).
const UNHELD_WAITING = ['person-intervened', 'no-reply'];
// Whether an item keeps its member from more queue work: only one still running. Every waiting item stays
// open for the person while its member takes the next one; a decision did hold its member until the person
// handled it, and on 11-13 one held a member for 88 minutes while four unrelated items waited (the person:
// 「之后我不在,你要保证一直开发」).
function holdsMember(item) {
  return Boolean(item) && item.status === 'sent';
}
// Whether an item asks the person to decide, until they handle it. The person answers in the session that
// holds it, so what that session is sent meanwhile is marked (asking in planDispatch). A decision is settled
// without a reason, but one saved by an older build
// can still carry an earlier refusal's (queueRequeue kept it through the send; queueMarkSent now drops it),
// so the two kinds above are named rather than told apart by having a reason.
function asksPerson(item) {
  return Boolean(item) && item.status === 'waiting' && !UNHELD_WAITING.includes(item.reason);
}
// The waiting kinds the planner itself sets when it settles an item; a decision has none. The member asked the
// person nothing in any of them. The last four came on 11-19 unnamed and counted as decisions: nobody holding
// one was rotated for 14 hours (11-23).
const PLANNER_WAITING = [...UNHELD_WAITING, 'input-purpose-unconfirmed', 'rotation-control-unresolved', 'native-turn-failed', 'usage-limit-exceeded'];
// Whether an open item is a decision its member asked the person. It kept the session until 11-23 (the person:
// 「否则会影响效率浪费 token」); now it goes with the session: the successor is told it whole (openDecisions) and
// the item points at the successor once the handoff is confirmed (room-state.cjs queueCarry).
function openDecision(item) {
  return Boolean(item) && item.status === 'waiting' && !PLANNER_WAITING.includes(item.reason);
}
// What a handoff may spend on open decisions. They are never cut, and the whole message is at most
// SEND_TEXT_LIMIT, so a member holding more than this keeps its session until the person answers some.
const DECISIONS_LIMIT = 10000;
// A member must stay idle this long before NAW sends, so a turn-end report can settle.
const IDLE_SETTLE_MS = 8000;
// The person's own activity in a session keeps NAW out of it for this long.
const HUMAN_QUIET_MS = 2 * 60 * 1000;
// What the person answered on an agent's own cards waits only this long after their last input to that session: the
// answer is for that agent to go on with, but a line half typed in its terminal leaves no draft (answer-notices.cjs).
const ANSWER_QUIET_MS = 20 * 1000;
// A sent item whose send never returned a tag is not resent (no silent replay).
const UNCONFIRMED_SEND_MS = 120000;
// A refusal before anything was sent returns the item to the queue at most this often.
const NOT_SENT_ATTEMPTS = 5;
// Kept and successor records rest this long before the session may be rotated again.
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
// A session is due for a new one when its conversation holds this many records: the person asked
// (2026-11-08) that short sessions not be replaced just for their age. Codex records every tool step,
// so its bar is higher. Daily sessions measured that day: heavy ones held 1768-1901 (Claude) and
// 17k-32k (Codex) records, light ones 309-466 (Claude) and 367-1501 (Codex).
const CONTENT_LIMITS = { claude: 1000, codex: 5000 };
// A session whose memory footprint (with its child processes) reaches this is rotated too;
// whichever of age and memory comes first. Footprint, like Activity Monitor's Memory column,
// counts compressed and swapped memory that resident size misses. Footprints measured 2026-11-08:
// Claude about 0.2 GB fresh and 0.35-0.4 GB on a long conversation; Codex 0.05 GB fresh and
// 0.2-0.3 GB on a long thread.
const MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;
// While macOS reports memory pressure (warning or critical), sessions twice a fresh one's size go.
const PRESSURE_LIMIT_BYTES = 600 * 1024 * 1024;
// A younger session is not rotated for memory: a new session would start as large, and a
// successor that starts above the limit must not be replaced again and again.
const MEMORY_MIN_AGE_MS = 60 * 60 * 1000;
// A backend NAW migrates without the person's click waits until its sessions were this quiet.
const MIGRATE_QUIET_MS = 10 * 60 * 1000;
// Teammates, earlier child agents or unreported background work: quiet three times as long first.
const MIGRATE_UNPROVEN_QUIET_MS = 30 * 60 * 1000;
// A memory-triggered rotation waits for this much quiet instead of the 30 minutes for age.
const QUIET_MEMORY_MS = 10 * 60 * 1000;
// With no queued work, quiet members of every space are still checked this often.
const MAINTENANCE_MS = 60 * 1000;
const MEMORY_SAMPLE_MS = 30 * 1000;
// An idle old member with no work is rotated only after this long without activity.
const QUIET_BEFORE_ROTATE_MS = 30 * 60 * 1000;
// A conversation compacted this many times continues in a new session (queue 794d3cd7, the person:
// 「compact conversation 的次数过多…也需要继承然后新开继承之后的会话了，否则太浪费了」). Measured
// 2026-11-13 in the person's own records: the third compaction came a median 2.4 hours into a session.
const COMPACT_LIMIT = 3;
// The butler is rotated for that at a pause between two turns: its own record had 18 pauses of two
// minutes or more in 5 hours and none of thirty. A member is rotated before its next item, or after
// the usual thirty quiet minutes, so a conversation the person is having is not cut into.
const QUIET_COMPACT_MS = 2 * 60 * 1000;
// A new member that never becomes ready (for example a startup prompt) ends the rotation.
const NEW_SESSION_READY_MS = 10 * 60 * 1000;
// The window client refuses a space pause or a member move while NAW replaces one backend (after an install,
// one backend a minute). Nothing was changed, or the change is found again: the caller asks again later.
const BACKEND_UPDATING_KEYS = new Set(['error.client.connectionUpdatingNoInput', 'error.client.connectionChangedNoReplay',
  'error.client.spacePauseUnconfirmed']);
const HANDOFF_ACCEPT_MS = 2 * 60 * 1000;
// Once delivered, its first turn has this long, approvals included. 125 recorded first turns: median 0.6 minutes, longest 13.3.
const HANDOFF_TURN_MS = 30 * 60 * 1000;
// The old session waits at most this long for running collaborations before it is kept instead.
const STOP_WAIT_MS = 30 * 60 * 1000;
const FAILED_ROTATION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// A session whose model is known nowhere is asked again after this, without a failure record.
const UNKNOWN_MODEL_RETRY_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 60000;
const CREATE_TIMEOUT_MS = 120000;
const TICK_MS = 3000;
// Without any state change, look again at least this often.
const FULL_PASS_MS = 30000;
// A session due for rotation this long and still not rotated is told to the butler's record (noteRotationStalls).
const ROTATION_STALL_MS = 60 * 60 * 1000;
// How long the designated integrator's session must be missing from every pass before it counts as gone.
const INTEGRATOR_ABSENT_MS = 10 * 60 * 1000;
const DECISION_MARKERS = ['需要你决定：', '需要你决定:', 'Needs your decision:'];
// Input written by NAW or another agent, not by the person.
// Read by the integration handoff as well; frozen, so that no module that reads it can change it for the queue.
const AUTOMATIC_ORIGINS = Object.freeze(['naw-dispatch', 'agent-wake', 'capacity-recovery', 'agent-control', 'room']);
// Whether a user-role row was written by NAW, another agent or the session's own machinery rather than the person:
// by its origin; a native row NAW recognised as machine input (a background task's notification, a scheduled wake)
// carries the source it was recognised by (workspace.cjs, on('nativeInput')); a native row without an origin falls
// back to NAW's marker.
// The sources workspace.cjs records on such a row; any other value is not trusted to be machine input.
const NATIVE_MACHINE_SOURCES = Object.freeze(['task-notification', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event', 'naw-peer']);
function automaticInput(message) {
  if (!message) return false;
  if (AUTOMATIC_ORIGINS.includes(message.origin)) return true;
  if (message.origin === 'native') return NATIVE_MACHINE_SOURCES.includes(message.inputSource);
  if (message.origin === undefined && typeof message.text === 'string') {
    return message.text.includes('【NAW 派活】') || message.text.includes('【NAW 换会话】');
  }
  return false;
}
// Refusals raised before the backend wrote anything: the item is still unsent.
const NATIVE_DRAFT_KEY = 'error.submission.nativeDraft';
// A terminal that is no longer open: only its owner may reopen it, and nothing unsent remains.
const TERMINAL_CLOSED_KEY = 'error.workspace.takeTerminalControlBeforeReconnect';
const NOT_SENT_KEYS = [
  'error.workspace.sessionNotReady',
  'error.workspace.handoffExpired',
  'error.backgroundMessagesDisabled',
  'error.queue.personTyping',
  'error.queue.terminalDialog',
  'error.workspace.claudeSubmitDisconnected',
  'error.workspace.nativeFirstMessageRequired',
  'error.nativeInterruptPending',
  'error.client.nativeContextChanged',
  'error.client.connectionUpdatingNoInput',
  'error.client.connectionChangedNoReplay',
  'error.room.sessionArchived',
  'error.room.workspaceArchived',
  'error.room.mergeStepsUnconfirmed',
  // Claude's native prompt holds text the person typed but did not send; nothing was submitted.
  NATIVE_DRAFT_KEY,
  'error.room.updatingDraftRetained',
];
const ROTATION_PHASES = ['requested', 'creating', 'joining', 'created', 'handed', 'waiting-trust', 'waiting-provider', 'failed', 'kept'];
// Records that only stop a member from being rotated again for a while.
const RESTING_PHASES = ['failed', 'kept'];
// The active backend can start a session with given settings (workspace.cjs createSettings).
const CREATE_SETTINGS_CAPABILITY = 'createSettingsV1';
// ... and from one of the person's Codex profiles (DeepSeek pro / flash, codex-profile.cjs).
const CREATE_PROFILE_CAPABILITY = 'createSettingsProfileV1';
// What a new session can be started with; must match workspace.cjs (a test compares them).
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/;
const CODEX_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
// One rotation at a time: each starts a new native session, and several at once would raise
// memory just when the machine may be short of it.
const MAX_ACTIVE_ROTATIONS = 1;
const GUARDED_STOP_CAPABILITY = 'guardedSessionStopV1';
// The service's stop that first checks the session is exactly as proven (workspace.cjs maintenanceStop).
const CONDITIONAL_STOP_CAPABILITY = 'conditionalMaintenanceStopV1';
// That stop pausing only the relays the stopped session is in, not every relay the service holds (cd3e2a8d).
const PARTICIPANT_STOP_CAPABILITY = 'participantMaintenanceStopV1';
// How long a refused receipt may take to settle into the end it proves (backend-switch.cjs settleMs).
const STOP_SETTLE_MS = 10000;
const NOTICE_STATES = ['pending', 'attempted', 'unknown'];
const CLEANUP_STATES = ['pending', 'started', 'confirmed', 'unknown'];

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function trustProof(session) {
  const proof = { nativeId: session?.nativeId, controlRevision: session?.controlRevision,
    draftRevision: session?.draftRevision, placementRevision: session && placementRevision(session) };
  return validTrustProof(proof, session?.provider) ? proof : null;
}
function validTrustProof(proof, provider) {
  return exactKeys(proof, ['nativeId', 'controlRevision', 'draftRevision', 'placementRevision']) &&
    (proof.nativeId === null ? provider === 'codex' : typeof proof.nativeId === 'string' && proof.nativeId.length > 0 && proof.nativeId.length <= 2000 && !/[\u0000-\u001f]/u.test(proof.nativeId)) &&
    ['controlRevision', 'draftRevision', 'placementRevision'].every(key => Number.isSafeInteger(proof[key]) && proof[key] >= 0);
}
function noticeEffects(ids, state = 'pending') {
  return { v: 1, log: state, rooms: Object.fromEntries(ids.map(id => [id, state])), os: state };
}
function validRoomStates(value, ids, states) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...new Set(ids)].sort().join('\0') && Object.values(value).every(state => states.includes(state));
}
function validNoticeEffects(value, ids) {
  return exactKeys(value, ['v', 'log', 'rooms', 'os']) && value.v === 1 && NOTICE_STATES.includes(value.log) &&
    NOTICE_STATES.includes(value.os) && validRoomStates(value.rooms, ids, NOTICE_STATES);
}
function validTrustCleanup(value, record) {
  const keys = ['v', 'id', 'proof', 'stop', 'rooms', 'notices'];
  if (value && Object.hasOwn(value, 'outcome')) keys.push('outcome');
  return exactKeys(value, keys) && value.v === 1 && validTrustReceipt(value.id) &&
    (value.outcome === undefined || value.outcome === null || ['failed', 'trustTimedOut', 'trustTimeoutUnconfirmed', 'trustCleanupUnconfirmed'].includes(value.outcome)) &&
    (value.proof === null || validTrustProof(value.proof, record.provider)) &&
    exactKeys(value.stop, ['state', 'attempts']) && CLEANUP_STATES.includes(value.stop.state) &&
    Number.isSafeInteger(value.stop.attempts) && value.stop.attempts >= 0 && value.stop.attempts <= 2 &&
    (!['pending', 'started'].includes(value.stop.state) || value.proof !== null) &&
    validRoomStates(value.rooms, record.roomIds, CLEANUP_STATES) && validNoticeEffects(value.notices, record.roomIds);
}
function trustFailure(record) {
  return record?.phase === 'failed' && !record.handoffConfirmed && validTrustReceipt(record.trustNoticeId) &&
    record.newId && record.newCwd && record.newCwd !== record.cwd;
}
function cleanupComplete(record) {
  if (record?.failureCleanup) return ['done', 'retained'].includes(record.failureCleanup.stop.state) &&
    Object.values(record.failureCleanup.rooms).every(row => row.leave !== 'pending');
  return record.trustCleanup?.stop.state === 'confirmed' && Object.values(record.trustCleanup.rooms).every(state => state === 'confirmed');
}
function noticesPending(effects) {
  return effects && [effects.log, effects.os, ...Object.values(effects.rooms)].includes('pending');
}
function trustRecoveryPending(record) {
  return !record?.failureCleanup && trustFailure(record) && (!cleanupComplete(record) || noticesPending(record.trustCleanup?.notices));
}
function failedHandoffPending(record) {
  const c = record?.failureCleanup;
  return Boolean(c && (c.log === 'pending' || c.os === 'pending' || c.release !== 'done' || ['pending', 'started'].includes(c.stop.state) ||
    Object.values(c.rooms).some(r => r.queue !== 'done' || r.notice !== 'done' || r.leave === 'pending')));
}
// Native has the handoff message. Kept on the record: a pass that cannot see the successor must not undo it.
function handoffDelivered(session, tag) {
  const input = firstHandoff.handoffInput(session, tag);
  return Boolean(input && (!input.nativeId || input.nativeId === session.nativeId) && (input.status === 'submitted' || input.turnId));
}
function quarantinedSuccessor(record) {
  return trustFailure(record) && !cleanupComplete(record) || Boolean(record?.failureCleanup && ['pending', 'started'].includes(record.failureCleanup.stop.state));
}
const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);
const trustRecord = record => dictionary(record) && (record.phase === 'waiting-trust' ||
  ['trustOwner', 'trustEffects', 'trustCleanup', 'trustNoticeId'].some(key => Object.hasOwn(record, key)));
const movedSuccessor = record => dictionary(record) && validId(record.newId) &&
  typeof record.newCwd === 'string' && record.newCwd !== record.cwd;
const validTrustFault = fault => dictionary(fault) && validId(fault.reason) && validTrustReceipt(fault.receiptId);
function trustIsolation(raw) {
  const valid = dictionary(raw) && raw.version === 1 && dictionary(raw.holds) &&
    dictionary(raw.faults) && Object.values(raw.faults).every(validTrustFault) &&
    dictionary(raw.notices) && Object.values(raw.notices).every(value => value === true) && typeof raw.unknown === 'boolean';
  return { version: 1, holds: dictionary(raw?.holds) ? { ...raw.holds } : {},
    faults: dictionary(raw?.faults) ? Object.fromEntries(Object.entries(raw.faults).filter(([, fault]) => validTrustFault(fault))) : {},
    notices: dictionary(raw?.notices) ? Object.fromEntries(Object.entries(raw.notices).filter(([, value]) => value === true)) : {},
    unknown: raw !== undefined && (!valid || raw.unknown),
    ...(raw !== undefined && !valid ? { unreadable: raw } : raw?.unreadable !== undefined ? { unreadable: raw.unreadable } : {}) };
}
function validTrustHold(hold) {
  const label = text => typeof text === 'string' && text.length <= 960 && !/[\u0000-\u001f]/u.test(text);
  return dictionary(hold) && validId(hold.oldId) && (hold.receiptId === null || validTrustReceipt(hold.receiptId)) &&
    Array.isArray(hold.roomIds) && hold.roomIds.every(validId) && label(hold.name) && label(hold.newName);
}

function validText(value, limit) {
  if (typeof value !== 'string') {
    return false;
  }
  if (!value.trim() || value.length > limit) {
    return false;
  }
  // Newlines and tabs are allowed; other control characters are not.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f]/u.test(value);
}

function validTrustReceipt(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0;
}

// A session a decision was with: its id and, when NAW knew it, the native session.
function validHolder(holder) {
  if (!holder || typeof holder !== 'object' || Array.isArray(holder) || !validId(holder.id)) {
    return false;
  }
  const keys = Object.keys(holder);
  if (keys.length === 1) {
    return true;
  }
  return keys.length === 2 && typeof holder.nativeId === 'string' && holder.nativeId.length > 0 &&
    holder.nativeId.length <= 2000 && !/[\u0000-\u001f]/u.test(holder.nativeId);
}

function validateCreator(creator) {
  if (!creator || typeof creator !== 'object' || Array.isArray(creator) ||
      Object.keys(creator).length !== 3 || !['kind', 'name', 'sessionId'].every(key => Object.hasOwn(creator, key)) ||
      !['person', 'secretary'].includes(creator.kind) ||
      typeof creator.name !== 'string' || !creator.name.trim() || creator.name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(creator.name) ||
      (creator.kind === 'person' ? creator.sessionId !== null :
        !validId(creator.sessionId) || !creator.sessionId.trim() || /\u007f/u.test(creator.sessionId))) {
    throw Error('Invalid queue creator');
  }
  return { kind: creator.kind, name: creator.name, sessionId: creator.sessionId };
}

function validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw Error('Invalid queue item');
  }
  if (!validId(item.id) || !validText(item.text, ITEM_TEXT_LIMIT) || !ITEM_STATUSES.includes(item.status)) {
    throw Error('Invalid queue item');
  }
  if (item.assignee !== null && !validId(item.assignee)) {
    throw Error('Invalid queue assignee');
  }
  if (!validTime(item.createdAt)) {
    throw Error('Invalid queue time');
  }
  for (const key of ['sentAt', 'finishedAt']) {
    if (item[key] !== undefined && !validTime(item[key])) {
      throw Error('Invalid queue time');
    }
  }
  for (const key of ['sentTo', 'tag']) {
    if (item[key] !== undefined && item[key] !== null && !validId(item[key])) {
      throw Error('Invalid queue delivery');
    }
  }
  for (const key of ['control', 'attempts']) {
    if (item[key] !== undefined && !(Number.isSafeInteger(item[key]) && item[key] >= 0)) {
      throw Error('Invalid queue counter');
    }
  }
  if (item.reason !== undefined && typeof item.reason !== 'string') {
    throw Error('Invalid queue reason');
  }
  if (item.reply !== undefined && !validText(item.reply, ITEM_REPLY_LIMIT)) {
    throw Error('Invalid queue reply');
  }
  if (item.ready !== undefined && !validReady(item.ready)) {
    throw Error('Invalid queue delivery line');
  }
  if (item.afterDecision !== undefined && item.afterDecision !== true) {
    throw Error('Invalid queue delivery');
  }
  if (item.claimed !== undefined && item.claimed !== true || item.claimEpoch !== undefined &&
      (item.claimed !== true || item.claimEpoch !== null && !validTrustReceipt(item.claimEpoch))) throw Error('Invalid queue claim');
  if (item.sentNative !== undefined && !(typeof item.sentNative === 'string' && item.sentNative.length > 0 &&
      item.sentNative.length <= 2000 && !/[\u0000-\u001f]/u.test(item.sentNative))) {
    throw Error('Invalid queue delivery');
  }
  // The person's answer from the queue row, once native received it (room-state.cjs queueResolve).
  if (item.answer !== undefined && !(item.answer && typeof item.answer === 'object' && !Array.isArray(item.answer) &&
      Object.keys(item.answer).length === 2 && validText(item.answer.text, ITEM_TEXT_LIMIT) && validTime(item.answer.deliveredAt))) {
    throw Error('Invalid queue answer');
  }
  // The row that answer was delivered as, kept until what the session wrote after it is read (queueAnswered).
  if (item.answerTag !== undefined && !validId(item.answerTag)) {
    throw Error('Invalid queue answer');
  }
  // A decision that went with its session to a successor (room-state.cjs queueCarry): who first asked it, and who
  // held it just before the session it points at now.
  for (const key of ['askedBy', 'carriedFrom']) {
    if (item[key] !== undefined && !validHolder(item[key])) {
      throw Error('Invalid queue holder');
    }
  }
  // Who acted when it was not the person or the item's creator: only the butler, for now.
  for (const key of ['addedBy', 'finishedBy']) {
    if (item[key] !== undefined && item[key] !== 'steward') {
      throw Error('Invalid queue actor');
    }
  }
  return { ...item, ...(Object.hasOwn(item, 'creator') ? { creator: validateCreator(item.creator) } : {}) };
}

function validateQueue(queue) {
  if (queue === undefined) {
    return [];
  }
  if (!Array.isArray(queue) || queue.length > QUEUE_LIMIT) {
    throw Error('Invalid queue');
  }
  const seen = new Set();
  const result = [];
  for (const item of queue) {
    const valid = validateItem(item);
    if (seen.has(valid.id)) {
      throw Error('Duplicate queue item');
    }
    seen.add(valid.id);
    result.push(valid);
  }
  return result;
}

function newItem(text, assignee, now = Date.now(), creator) {
  if (!validText(text, ITEM_TEXT_LIMIT)) {
    throw Error('Invalid queue text');
  }
  if (assignee !== null && !validId(assignee)) {
    throw Error('Invalid queue assignee');
  }
  return validateItem({ id: randomUUID(), text, assignee, status: 'queued', createdAt: now,
    ...(creator === undefined ? {} : { creator }) });
}

// Keep every open item; drop the oldest finished ones when the list is full.
function trimQueue(queue) {
  if (queue.length <= QUEUE_LIMIT) {
    return queue;
  }
  const result = [];
  let removable = queue.length - QUEUE_LIMIT;
  for (const item of queue) {
    if (removable > 0 && !OPEN_STATUSES.includes(item.status)) {
      removable -= 1;
      continue;
    }
    result.push(item);
  }
  return result;
}

function sessionReady(session, wakePolicy) {
  if (!session) {
    return { ready: false, reason: 'missing' };
  }
  if (session.archived) {
    return { ready: false, reason: 'archived' };
  }
  if (!Array.isArray(session.serviceCapabilities) || !session.serviceCapabilities.includes(CAPABILITY)) {
    return { ready: false, reason: 'backend-update-needed' };
  }
  if (!wakePolicy || wakePolicy.enabled !== true) {
    return { ready: false, reason: 'automatic-messages-off' };
  }
  if (session.wakeDisabled) {
    return { ready: false, reason: 'paused' };
  }
  if (rotationBlocked(session) && session.rotationEpisode.state === 'waiting-provider') return { ready: false, reason: 'waiting-provider' };
  if (codexQuotaBlock(session)) return { ready: false, reason: 'usage-limit-exceeded' };
  if (rotationBlocked(session)) return { ready: false, reason: 'rotation-control-unresolved' };
  if (session.nativeTerminalDialog) {
    return { ready: false, reason: 'native-terminal-dialog' };
  }
  if (session.state !== 'idle') {
    return { ready: false, reason: 'not-idle' };
  }
  const busyFlags = ['pendingTag', 'pendingQueue', 'approval', 'claudeQuestion', 'nativeInputRequired', 'interruptPending', 'nativeContextPending'];
  for (const flag of busyFlags) {
    if (session[flag]) {
      return { ready: false, reason: 'busy' };
    }
  }
  if (session.backendUnavailable || session.transportDisconnected || session.chatAvailable === false) {
    return { ready: false, reason: 'unavailable' };
  }
  if (session.backgroundStale === true) {
    return { ready: false, reason: 'background-unconfirmed' };
  }
  for (const key of ['background', 'scheduled']) {
    const count = session[key];
    if (count !== null && count !== undefined && !(Number.isSafeInteger(count) && count === 0)) {
      return { ready: false, reason: 'background-work' };
    }
  }
  if (typeof session.liveDraft === 'string' && session.liveDraft.trim()) {
    return { ready: false, reason: 'person-typing' };
  }
  if (session.provider === 'codex' && session.nativeGoal && session.nativeGoal.status === 'active') {
    return { ready: false, reason: 'native-goal-active' };
  }
  // Old child records turn "unknown" after a restart; only observed running ones block.
  const children = fleet.currentFleet(session, true);
  if (children.running) {
    return { ready: false, reason: 'team-running' };
  }
  // Its backend waits to be moved (quiet-windows.cjs): no new work there until the window closes.
  if (session.quietWindow) {
    return { ready: false, reason: 'quiet-window' };
  }
  return { ready: true, reason: '' };
}

// While a session works, what else holds it now (2026-11-23: a draft held the butler 258 minutes, read as not-idle in
// each of its own turns). busy stays not-idle: an approval or question flagged on the session belongs to the turn (a
// native permission prompt sets no flag). So do its own delivery and Claude's background report, stale until the turn
// ends (workspace.cjs 'working'); R198: they hid a quiet window.
function heldReason(session, wakePolicy) {
  const reason = sessionReady(session, wakePolicy).reason;
  if (reason !== 'not-idle') {
    return reason;
  }
  const ended = { ...session, state: 'idle' };
  if (['working', 'approval'].includes(session.state)) {
    ended.pendingTag = null;
    if (session.backgroundStale === true) {
      Object.assign(ended, { backgroundStale: false, background: 0, scheduled: 0 });
    }
  }
  const after = sessionReady(ended, wakePolicy).reason;
  return after && after !== 'busy' ? after : reason;
}

function settled(sessionId, idleSince, now, settleMs) {
  const since = idleSince.get(sessionId);
  return Number.isFinite(since) && now - since >= settleMs;
}

function humanRecent(sessionId, humanAt, now, quietMs) {
  const at = humanAt.get(sessionId);
  return Number.isFinite(at) && now - at < quietMs;
}

function startsWithDecision(text) {
  const trimmed = text.trimStart();
  for (const marker of DECISION_MARKERS) {
    if (trimmed.startsWith(marker)) {
      return true;
    }
  }
  return false;
}

// What followed a NAW message: the assistant replies and whether the person wrote
// in between. When a native record replaced NAW's copy, use the send time. With
// untilHuman, the reply is what came before the person's first message: in a session
// whose earlier decision is open, what the person writes may be its answer, and the
// reply and READY line that follow belong to that (independent review, 11-13).
function replyAfter(session, tag, sentAt, untilHuman = false, expected) {
  let messages = [];
  if (Array.isArray(session.messages)) {
    messages = session.messages;
  }
  let index = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i] && messages[i].id === tag) {
      index = i;
    }
  }
  if (expected && index < 0) return null;
  if (expected && !queuePurposeValid(session, messages[index], expected.itemId, expected.nativeId, expected.claim))
    return { found: false, text: '', last: '', humanAfter: false, parts: [], purposeInvalid: true };
  const failedTurns = new Set(expected ? messages.filter(m => m?.kind === 'turn' && m.nativeId === session.nativeId &&
    m.status === 'failed' && typeof m.turnId === 'string').map(m => m.turnId) : []);
  const failedReplies = new Set();
  const parts = [];
  const partIndices = [];
  let humanAfter = false;
  let own = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    let after = false;
    if (index >= 0) {
      after = i > index;
    } else if (Number.isFinite(sentAt) && Number.isFinite(message.time)) {
      after = message.time >= sentAt;
    }
    if (!after) {
      continue;
    }
    if (message.role === 'user' && !automaticInput(message)) {
      if (!humanAfter) {
        own = parts.length;
      }
      humanAfter = true;
    }
    if (message.role === 'assistant' && (!expected || (!message.inputTag || message.inputTag === tag) && (!message.status || message.status === 'complete')) && typeof message.text === 'string' && message.text.trim()) {
      if (message.nativeId === session.nativeId && failedTurns.has(message.turnId)) {
        failedReplies.add(message.turnId); continue;
      }
      parts.push(message.text);
      partIndices.push(i);
    }
  }
  if (index < 0 && !parts.length) {
    return null;
  }
  const kept = untilHuman && own >= 0 ? parts.slice(0, own) : parts;
  let last = '';
  if (kept.length) {
    last = kept[kept.length - 1];
  }
  const lastIndex = partIndices[kept.length - 1], lastMessage = messages[lastIndex], nativeId = lastMessage?.nativeId;
  // Only this delivery's completed native turn can supersede earlier failures.
  const recovered = failedReplies.size && typeof nativeId === 'string' && nativeId && nativeId === session.nativeId && lastMessage.status === 'complete' &&
    typeof lastMessage.turnId === 'string' && messages.some((m, i) => i > lastIndex && m?.kind === 'turn' &&
      m.nativeId === session.nativeId && m.turnId === lastMessage.turnId && m.status === 'complete' && (!m.inputTag || m.inputTag === tag)) &&
    !messages.some((m, i) => i >= lastIndex && m?.kind === 'turn' && m.nativeId === session.nativeId &&
      (m.status === 'failed' || m.status === 'interrupted') &&
      (failedReplies.has(m.turnId) || !m.inputTag || m.inputTag === tag));
  return { found: true, text: kept.join('\n\n'), last, humanAfter, parts: kept,
    ...(failedReplies.size && !recovered ? { failedTurnIds: [...failedReplies] } : {}) };
}

// How long a handled decision keeps the row its answer was delivered as, for what its session writes after it.
// Then the mark is dropped and the item stays as the person left it.
const ANSWER_REPLY_KEEP_MS = 24 * 60 * 60 * 1000;
// Input that starts something of its own in a session: an item or a handoff from NAW, or another agent's message.
// The session's own machinery (a background task reporting back, a scheduled wake) continues what it was doing, and
// a message read inside a running turn (deliveredInto) is part of that turn.
const OTHER_WORK_ORIGINS = ['naw-dispatch', 'agent-wake', 'agent-control', 'room'];
function startsOtherWork(message) {
  if (message.deliveredInto) {
    return false;
  }
  if (OTHER_WORK_ORIGINS.includes(message.origin)) {
    return true;
  }
  if (message.origin === 'native') {
    return message.inputSource === 'naw-peer';
  }
  return message.origin === undefined && automaticInput(message);
}

// What a session wrote after the row the person's answer to its decision was delivered as (item.answerTag), up to
// the next input that starts something else. found: the row is in this record; own: it is the person's message
// and started a turn of its own; closed: other work began after it. An answer read inside a turn that was already
// running (deliveredInto) is not own: what that turn ends with may belong to the work that started it. Read only
// while the session rests: a row still waiting for its turn sits where it was queued and moves when the turn
// starts (workspace.cjs).
function answeredReply(session, tag) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const index = messages.findIndex(message => message && message.id === tag);
  if (index < 0) {
    return { found: false };
  }
  const answer = messages[index];
  if (answer.role !== 'user' || automaticInput(answer) || answer.deliveredInto) {
    return { found: true, own: false };
  }
  const failedTurns = new Set(messages.filter(m => m?.kind === 'turn' && m.nativeId === session.nativeId &&
    m.status === 'failed' && typeof m.turnId === 'string').map(m => m.turnId));
  let last = '';
  for (let i = index + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.role === 'user' && startsOtherWork(message)) {
      return { found: true, own: true, last, closed: true };
    }
    const written = message.role === 'assistant' && (!message.status || message.status === 'complete') &&
      typeof message.text === 'string' && message.text.trim();
    if (written && !(message.nativeId === session.nativeId && failedTurns.has(message.turnId))) {
      last = message.text;
    }
  }
  return { found: true, own: true, last, closed: false };
}

function memberIds(room, sessions) {
  const ids = [];
  for (const session of sessions) {
    let rooms = [];
    try {
      rooms = roomIds(session);
    } catch {
      rooms = [];
    }
    if (rooms.includes(room.id) && !session.archived) {
      ids.push(session.id);
    }
  }
  // Prefer the person's member order, then the remaining members.
  const ordered = [];
  let order = [];
  if (Array.isArray(room.memberOrder)) {
    order = room.memberOrder;
  }
  for (const id of order) {
    if (ids.includes(id) && !ordered.includes(id)) {
      ordered.push(id);
    }
  }
  for (const id of ids) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

// A queue item's assignee must be a member of its space when the item is added. An id no session
// has (in the person's data on 11-12, one sharing only its first eight characters with a member) or
// a session outside the space would leave the item queued for nobody. The refusal names the members
// (name and id, in the person's order), so whoever added it can choose one or leave it unassigned.
// Kept within the 2048 characters a background caller's receipt keeps of an error.
const MEMBER_LIST_LIMIT = 1600;
function assigneeRefusal(assignee, room, sessions, name = session => session.name || session.id) {
  if (assignee === null || assignee === undefined) return null;
  const ids = memberIds(room, sessions);
  if (typeof assignee === 'string' && ids.includes(assignee)) return null;
  const listed = [];
  let length = 0;
  for (const id of ids) {
    const session = sessions.find(candidate => candidate.id === id);
    const entry = `${shortText(String(name(session) || id), 60)} · ${id}`;
    if (length + entry.length > MEMBER_LIST_LIMIT) {
      listed.push(`… +${ids.length - listed.length}`);
      break;
    }
    listed.push(entry);
    length += entry.length + 2;
  }
  if (!listed.length) return uiError('error.queue.assigneeNoMembers');
  return uiError('error.queue.assigneeNotMember', { members: listed.join('; ') });
}

// When a session began: its creation time or, for sessions recorded before NAW kept one, its
// earliest timed message (so its age is never overstated). Null when neither is known.
function sessionStart(session, now) {
  if (Number.isFinite(session.createdAt)) {
    return session.createdAt;
  }
  let earliest = null;
  for (const message of session.messages || []) {
    const time = message ? message.time : undefined;
    if (!Number.isFinite(time) || time < 1e12 || time > now) {
      continue;
    }
    if (earliest === null || time < earliest) {
      earliest = time;
    }
  }
  return earliest;
}

// The latest sign of use: the recorded last activity, else the newest timed message.
function lastActivityOf(session, now) {
  if (Number.isFinite(session.lastActivityAt)) {
    return session.lastActivityAt;
  }
  let latest = null;
  for (const message of session.messages || []) {
    const time = message ? message.time : undefined;
    if (!Number.isFinite(time) || time < 1e12 || time > now) {
      continue;
    }
    if (latest === null || time > latest) {
      latest = time;
    }
  }
  if (latest !== null) {
    return latest;
  }
  return sessionStart(session, now);
}

// The model a session last reported, or null while it has reported none.
function reportedModel(session) {
  let model = session.model;
  if (session.provider === 'codex' && session.nativeSettings && typeof session.nativeSettings.model === 'string') {
    model = session.nativeSettings.model;
  }
  if (typeof model === 'string' && MODEL_PATTERN.test(model)) {
    return model;
  }
  return null;
}

// The model a Claude session's own transcript last recorded. A resumed Claude session reports its model only
// with its next turn (SessionStart on --resume carries none), while --resume restores this one; a moved
// session is always resumed. The transcript is the one Claude reported for the session, else
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with every character other than a letter or digit as "-">/
// <native id>.jsonl for the folder as stored and as resolved (claudeFiles, compaction-count.cjs); only the
// end of the first one there is read.
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const NATIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function transcriptModel(session, root, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  if (!session || session.provider !== 'claude' || !NATIVE_ID_PATTERN.test(session.nativeId || '')) {
    return null;
  }
  let text = null;
  for (const file of claudeFiles(root, session)) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch {
      // Not there: the next place.
    }
  }
  if (text === null) {
    return null;
  }
  // From the end: the first line may be cut off, and synthetic entries carry no real model. Only the
  // session's own main conversation counts, as NAW's Claude reader filters (adapters.cjs): not a
  // subagent's row or another session's.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"assistant"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const own = entry && entry.type === 'assistant' && entry.sessionId === session.nativeId && entry.isSidechain === false;
    const model = own && entry.message ? entry.message.model : null;
    if (typeof model === 'string' && MODEL_PATTERN.test(model)) {
      return model;
    }
  }
  return null;
}

// What a successor must start with to continue like the old session: its model, effort,
// permission mode and view. { reason } when a new session could not match it.
function carrySettings(session) {
  let spaces = [];
  try {
    spaces = roomIds(session);
  } catch {
    return { reason: 'spaces-unreadable' };
  }
  if (spaces.length > 1) {
    return { reason: 'several-spaces' };
  }
  const model = reportedModel(session);
  if (!model) {
    return { reason: 'model-unknown' };
  }
  const settings = { model };
  if (session.provider === 'claude') {
    if (CLAUDE_EFFORTS.includes(session.nativeEffort)) {
      settings.effort = session.nativeEffort;
    }
    const mode = session.nativePermissionMode;
    if (mode && mode !== 'default') {
      if (!CLAUDE_PERMISSION_MODES.includes(mode)) {
        return { reason: 'permission-mode' };
      }
      settings.permissionMode = mode;
    }
  } else {
    const native = session.nativeSettings || {};
    if (native.mode) {
      return { reason: 'collaboration-mode' };
    }
    if (typeof native.effort === 'string' && CODEX_EFFORT_PATTERN.test(native.effort)) {
      settings.effort = native.effort;
    }
    // A session started from a Codex profile (DeepSeek) runs its successor from the same one:
    // the profile names the vendor and its model catalog, which a model name alone does not.
    const profile = session.requestedSettings && session.requestedSettings.profile;
    if (typeof profile === 'string' && profile) {
      settings.profile = profile;
    }
  }
  // Default Codex to its native TUI unless chat was recorded. Trust/sign-in stay human
  // decisions: joining exposes that terminal, but queue transfer and the real
  // handoff wait for its identity, live PTY and input capability below. Never
  // manufacture a first turn or use chat creation to bypass onboarding.
  let view = session.provider === 'codex' && session.view !== 'chat' ? 'terminal' : 'chat';
  if (session.provider === 'claude' && session.view === 'terminal') {
    view = 'terminal';
  }
  if (session.provider === 'codex' && typeof session.modelProvider === 'string' && session.modelProvider) {
    return { settings, view, modelProvider: session.modelProvider };
  }
  return { settings, view };
}

// Does the new session report what it was started with? 'pending' until it reports a model.
function settingsMismatch(carry, fresh, modelProvider = null) {
  if (!carry) {
    return null;
  }
  if (carry.model) {
    const model = reportedModel(fresh);
    if (!model) {
      return 'pending';
    }
    if (model !== carry.model) {
      return 'model';
    }
  }
  // The vendor the old session ran (DeepSeek through Codex) must be the successor's.
  if (modelProvider && fresh.modelProvider && fresh.modelProvider !== modelProvider) {
    return 'model-provider';
  }
  if (fresh.provider === 'claude') {
    if (carry.permissionMode && fresh.nativePermissionMode && fresh.nativePermissionMode !== carry.permissionMode) {
      return 'permission-mode';
    }
    if (carry.effort && fresh.nativeEffort && fresh.nativeEffort !== carry.effort) {
      return 'effort';
    }
  } else {
    const native = fresh.nativeSettings || {};
    if (carry.effort && native.effort && native.effort !== carry.effort) {
      return 'effort';
    }
  }
  return null;
}

// Records of the current native conversation: those after the last /clear (or terminal switch)
// boundary, which ends the conversation the native session carries.
function recordCount(session) {
  if (!Array.isArray(session.messages)) {
    return 0;
  }
  let count = 0;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message && message.role === 'system' && message.kind === 'context') {
      break;
    }
    count += 1;
  }
  return count;
}

// A successor's own kept record: it rests a day against the other reasons, while its own
// compactions are counted from its own start.
function restingSuccessor(record) {
  return Boolean(record) && record.phase === 'kept' && validId(record.successorOf || '') && !trustRecord(record);
}

// The rule that keeps a session from rotation however due it is, or null. Each also names the gate a stalled
// rotation is held at (planDispatch rotationGates).
function rotationHold(session, options, rotations) {
  const record = rotations[session.id];
  if (record && !restingSuccessor(record)) {
    return `rotation-${record.phase}`;
  }
  if (options.blockedRotations?.has(session.id)) {
    return 'trust-fault';
  }
  // Its open decisions cannot all go to a successor (step 1 of the plan): it stays until the person answers those.
  if (options.decisionsStay && options.decisionsStay.has(session.id)) {
    return 'decisions-stay';
  }
  // The person used it while it was being rotated: it waits until it is quiet again (see personDeferred).
  if (options.deferredRotations && options.deferredRotations.has(session.id)) {
    return 'person-active';
  }
  // A kept old session already has a successor carrying its work; the person ends it when done.
  if (options.handedOff && options.handedOff.has(session.id)) {
    return 'handed-off';
  }
  // Its model is known nowhere yet (see transcriptModel); the next session in line goes first.
  if (options.waitingModel && options.waitingModel.has(session.id)) {
    return 'waiting-model';
  }
  return null;
}

// Why a member is due for rotation now: 'content', 'compact', 'memory' or null.
function rotationReason(session, now, options, rotations) {
  if (!['claude', 'codex'].includes(session.provider) || rotationHold(session, options, rotations)) {
    return null;
  }
  return dueReason(session, now, options, rotations[session.id]);
}

// The reason alone, whatever rotationHold says; `record` is the session's own resting record, if any.
function dueReason(session, now, options, record) {
  const limit = options.contentLimits ? options.contentLimits[session.provider] : undefined;
  if (!record && Number.isFinite(limit) && recordCount(session) >= limit) {
    return 'content';
  }
  const compactions = options.compactions ? options.compactions.get(session.id) : undefined;
  if (Number.isSafeInteger(compactions) && Number.isSafeInteger(options.compactLimit) && options.compactLimit > 0 && compactions >= options.compactLimit) {
    return 'compact';
  }
  if (record) {
    return null;
  }
  const start = sessionStart(session, now);
  if (start === null) {
    return null;
  }
  const used = options.memory ? options.memory.get(session.id) : undefined;
  if (!Number.isFinite(used) || !options.memoryLimit || used < options.memoryLimit) {
    return null;
  }
  if (now - start < options.memoryMinAgeMs) {
    return null;
  }
  return 'memory';
}

// Whether an engine pass changed anything a window shows: a delivery taken in, a handoff settled,
// handed out or asked about, a space record or a notice. A result of the wrong shape throws
// here on purpose: the caller keeps that as a fault of the engine's step.
function integrationChanged(result) {
  const handed = result.handed && ['opened', 'refused', 'unconfirmed', 'ask-integrator'].includes(result.handed.kind);
  return Boolean(result.taken?.stored.length || result.settled?.kind === 'settled' || handed || result.told?.shown || result.told?.told.length);
}

// The sessions NAW itself is doing something with, for the integration handoff: one in a session
// rotation that is not at rest (and a successor it has not confirmed), one in a running space
// exchange, and one a queue item holds (holdsMember). The same rule as the planner's and the vacancy
// projection's own.
function engagedSessions(rotations, rooms) {
  const busy = new Set();
  for (const [id, rotation] of Object.entries(rotations || {})) {
    if (quarantinedSuccessor(rotation) && rotation.newId !== id) busy.add(rotation.newId);
    if (rotation && !RESTING_PHASES.includes(rotation.phase)) {
      busy.add(id);
      if (rotation.newId && !rotation.handoffConfirmed) busy.add(rotation.newId);
    }
  }
  for (const room of Array.isArray(rooms) ? rooms : []) {
    if (room?.run?.status === 'running' && Array.isArray(room.run.ids)) for (const id of room.run.ids) busy.add(id);
    for (const item of room?.queue || []) if (item.sentTo && holdsMember(item)) busy.add(item.sentTo);
  }
  return busy;
}

// A business-only projection, using the same readiness and human quiet gates
// as dispatch. No history or native output leaves the dispatcher through it.
function queueVacancies(input) {
  const busy = new Set((input.actions || []).filter(action => ['dispatch', 'rotate'].includes(action.kind)).map(action => action.sessionId));
  // The same sessions the planner was told are engaged (B6: the holder of an open handoff) are not vacant either.
  for (const id of Array.isArray(input.engaged) ? input.engaged : []) busy.add(id);
  for (const id of input.heldSessions || []) busy.add(id);
  if (input.quarantineUnknown) for (const session of input.sessions || []) busy.add(session.id);
  for (const [id, rotation] of Object.entries(input.rotations || {})) {
    if (quarantinedSuccessor(rotation) && rotation.newId !== id) busy.add(rotation.newId);
    if (rotation && !RESTING_PHASES.includes(rotation.phase)) {
      busy.add(id);
      if (rotation.newId && !rotation.handoffConfirmed) busy.add(rotation.newId);
    }
  }
  for (const room of input.rooms || []) {
    if (room.run?.status === 'running' && Array.isArray(room.run.ids)) for (const id of room.run.ids) busy.add(id);
    for (const item of room.queue || []) if (item.sentTo && holdsMember(item)) busy.add(item.sentTo);
  }
  const byId = new Map((input.sessions || []).map(session => [session.id, session]));
  return (input.rooms || []).map(room => {
    const members = new Set(memberIds(room, input.sessions || []));
    // A space with only items left for the person to look at has nothing to send or wait for.
    const candidates = !room.archived && !(room.queue || []).some(item => item.status === 'queued' || holdsMember(item))
      ? (input.sessions || []).filter(session => !busy.has(session.id) && roomIds(session).includes(room.id) &&
        !carriedOn(session.id, input.handedOff, members, byId) &&
        sessionReady(session, input.wakePolicy).ready &&
        !humanRecent(session.id, input.humanAt || new Map(), input.now, input.humanQuietMs ?? HUMAN_QUIET_MS))
      : [];
    const candidateIds = candidates.map(session => session.id).sort();
    const availableIds = candidates.filter(session => settled(session.id, input.idleSince || new Map(), input.now,
      input.settleMs ?? IDLE_SETTLE_MS)).map(session => session.id).sort();
    return { roomId: room.id, name: room.name, active: availableIds.length > 0, availableIds, candidateIds };
  });
}

// One pass over every space. Returns the actions in the order to run them.
// A kept old session handed its work to a successor and stays only for the person (rotation drill, finding 2,
// 2026-11-14: an item added without a member went to the old session, so two contexts did one member's work).
// While a successor of it (or of that successor) is still in the space, that space's unassigned items go there,
// never to the old one. An item the chooser assigned to the old session by name still goes to it.
// A successor in one of these states runs no native process that can take the work: stopped (a Codex stop ends
// 'disconnected', workspace.cjs:2010-2013), crashed ('recoverable'), failed, backgrounded or being stopped. The
// list is workspace.cjs:849's, plus 'stopping'. Independent review of this change, 2026-11-14: with 'ended' alone, a
// stopped Codex successor kept its old session from the space's work for good.
const SUCCESSOR_GONE_STATES = ['ended', 'stopping', 'background', 'recoverable', 'error', 'disconnected'];
function carriedOn(id, handedOff, members, byId) {
  if (!handedOff || typeof handedOff.get !== 'function') {
    return false;
  }
  const seen = new Set([id]);
  const next = [...(handedOff.get(id) || [])];
  while (next.length) {
    const to = next.shift();
    if (seen.has(to)) {
      continue;
    }
    seen.add(to);
    const session = byId.get(to);
    if (members.has(to) && session && !SUCCESSOR_GONE_STATES.includes(session.state)) {
      return true;
    }
    next.push(...(handedOff.get(to) || []));
  }
  return false;
}

function planDispatch(input) {
  const rooms = input.rooms || [];
  const sessions = input.sessions || [];
  const now = input.now;
  const settleMs = input.settleMs ?? IDLE_SETTLE_MS;
  const contentLimits = input.contentLimits ?? CONTENT_LIMITS;
  const quietMs = input.quietMs ?? QUIET_BEFORE_ROTATE_MS;
  const quietMemoryMs = input.quietMemoryMs ?? QUIET_MEMORY_MS;
  const quietCompactMs = input.quietCompactMs ?? QUIET_COMPACT_MS;
  const rotationOptions = {
    blockedRotations: input.blockedRotations,
    // Filled in step 1: members whose next item is marked afterDecision (asksPerson), and those whose open
    // decisions cannot all be handed over: too long to tell whole (DECISIONS_LIMIT), or in a space they have left.
    asking: new Set(),
    decisionsStay: new Set(),
    contentLimits,
    compactions: input.compactions,
    compactLimit: input.compactLimit ?? COMPACT_LIMIT,
    handedOff: input.handedOff,
    waitingModel: input.waitingModel,
    deferredRotations: input.deferredRotations,
    memory: input.memory,
    memoryLimit: input.memoryLimit ?? MEMORY_LIMIT_BYTES,
    memoryMinAgeMs: input.memoryMinAgeMs ?? MEMORY_MIN_AGE_MS,
  };
  const humanQuietMs = input.humanQuietMs ?? HUMAN_QUIET_MS;
  const rotations = input.rotations || {};
  const idleSince = input.idleSince || new Map();
  const humanAt = input.humanAt || new Map();
  const byId = new Map();
  for (const session of sessions) {
    byId.set(session.id, session);
  }
  function available(session) {
    if (!sessionReady(session, input.wakePolicy).ready) {
      return false;
    }
    if (!settled(session.id, idleSince, now, settleMs)) {
      return false;
    }
    return !humanRecent(session.id, humanAt, now, humanQuietMs);
  }
  const actions = [];
  // Why each queued item was not sent on this pass, member by member (input.waits, filled when the caller passes a
  // Map). Queue item 5614a65c, 11-15: a member sat idle for 43 minutes while an item assigned to it waited, and
  // nothing said why (its composer held one character). `why` keeps the first reason each busy member was held for.
  const waits = input.waits instanceof Map ? input.waits : null;
  const why = new Map();
  const busy = new Set();
  function hold(id, reason) {
    busy.add(id);
    if (!why.has(id)) why.set(id, reason);
  }
  // A session due for rotation that this pass leaves as it is, with the first gate that held it (input.rotationGates,
  // filled when the caller passes a Map). Not one: a session being rotated, rotated by this pass, or handed off.
  const gates = input.rotationGates instanceof Map ? input.rotationGates : null;
  function stalled(id, gate) {
    const session = byId.get(id);
    if (!gates || gates.has(id) || !gate || gate === 'rotating' || !session || session.archived ||
        session.state === 'ended' || session.wakeDisabled || input.wakePolicy?.enabled !== true) {
      return;
    }
    if (!['claude', 'codex'].includes(session.provider) || (input.handedOff && input.handedOff.has(id))) {
      return;
    }
    const prior = rotations[id], episode = session.rotationEpisode;
    // A writer's completed episode cannot still be this same failed attempt.
    if (prior?.phase === 'failed' && ['complete', 'released'].includes(episode?.state) &&
        validId(prior.oldNativeId) && validId(prior.episodeEpoch) && validId(prior.tag) &&
        prior.oldNativeId === session.nativeId && episode.nativeId === session.nativeId &&
        episode.epoch === prior.episodeEpoch && episode.tag === prior.tag) return;
    // A failed attempt leaves the reason it was due for.
    const record = prior?.phase === 'failed' ? undefined : prior;
    const reason = dueReason(session, now, rotationOptions, record);
    if (reason) {
      gates.set(id, { gate, reason });
    }
  }
  // Sessions the caller says are engaged in something else of NAW's own (B6: the session an open
  // integration handoff was sent to) start out busy: no queued item, no rotation.
  for (const id of Array.isArray(input.engaged) ? input.engaged : []) hold(id, 'integration');
  for (const id of input.heldSessions || []) hold(id, 'trust-hold');
  if (input.quarantineUnknown) for (const session of sessions) hold(session.id, 'trust-unknown');
  let rotationSlots = MAX_ACTIVE_ROTATIONS;
  for (const id of Object.keys(rotations)) {
    const record = rotations[id];
    if (quarantinedSuccessor(record) && record.newId !== id) hold(record.newId, 'trust-hold');
    if (record && !RESTING_PHASES.includes(record.phase)) {
      if (record.phase !== 'waiting-provider') rotationSlots -= 1;
      hold(id, record.phase === 'waiting-provider' ? 'waiting-provider' : 'rotating');
      if (record.newId && !record.handoffConfirmed) {
        hold(record.newId, 'rotating');
      }
    }
  }
  // A member in a running space collaboration is taking part in that exchange.
  for (const room of rooms) {
    if (room.run && room.run.status === 'running' && Array.isArray(room.run.ids)) {
      for (const id of room.run.ids) {
        hold(id, 'space-run');
      }
    }
  }
  // A member the pass did not send an item to: why it held (`reason`), and why its session is not ready to take
  // one (`readiness`, sessionReady's reason) when that is so too; a member held by an item it was sent and not yet
  // settled waits on the same readiness.
  function waitOf(id) {
    const ready = sessionReady(byId.get(id), input.wakePolicy);
    if (busy.has(id)) return ready.ready ? { sessionId: id, reason: why.get(id) } : { sessionId: id, reason: why.get(id), readiness: ready.reason };
    if (!ready.ready) return { sessionId: id, reason: ready.reason };
    if (!settled(id, idleSince, now, settleMs)) return { sessionId: id, reason: 'settling' };
    return { sessionId: id, reason: 'person-recent' };
  }
  // 1) Settle items already sent.
  const holders = new Set();
  for (const room of rooms) {
    for (const item of room.queue || []) {
      if (item.sentTo && asksPerson(item)) {
        rotationOptions.asking.add(item.sentTo);
      }
      const holder = item.sentTo && openDecision(item) ? byId.get(item.sentTo) : null;
      if (holder && !spacesOf(holder).includes(room.id)) {
        // A successor joins only the spaces its old session is in: this decision could not follow.
        rotationOptions.decisionsStay.add(holder.id);
      } else if (holder && !holders.has(holder.id)) {
        holders.add(holder.id);
        if (decisionsNote(holder.name || holder.id, openDecisions(rooms, holder, spacesOf(holder))).length > DECISIONS_LIMIT) {
          rotationOptions.decisionsStay.add(holder.id);
        }
      }
      if (item.status === 'done' && item.answerTag && !room.archived) {
        // R141② acceptance 5: the person answered this decision on its card. What its session wrote after the
        // answer goes on the item, which stays handled; nothing is sent and the member is not held for it.
        const action = { kind: 'answered', roomId: room.id, itemId: item.id, sessionId: item.sentTo, tag: item.answerTag };
        const session = byId.get(item.sentTo);
        const wrote = session && !session.archived ? answeredReply(session, item.answerTag) : null;
        const rested = session && session.state === 'idle' && !session.pendingTag && settled(session.id, idleSince, now, settleMs);
        if (!wrote || wrote.found && !wrote.own || now - (item.answer?.deliveredAt || 0) > ANSWER_REPLY_KEEP_MS) {
          // The session is gone, the row is not the person's, or a day passed: only the mark goes.
          actions.push(action);
        } else if (wrote.found && rested) {
          if (wrote.last.trim()) {
            const ready = readyLine(wrote.last);
            actions.push({ ...action, reply: replyLine(wrote.last), ...(ready ? { ready } : {}) });
          } else if (wrote.closed) {
            actions.push(action);
          }
        }
      }
      if (item.status !== 'sent') {
        continue;
      }
      const member = byId.get(item.sentTo);
      if (!item.tag) {
        if (now - (item.sentAt || 0) > UNCONFIRMED_SEND_MS) {
          actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'failed', reason: 'send-unconfirmed', sessionId: item.sentTo });
        } else {
          hold(item.sentTo, 'send-unconfirmed');
        }
        continue;
      }
      if (!member) {
        actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'failed', reason: 'member-missing', sessionId: item.sentTo });
        continue;
      }
      if (member.state !== 'idle' || member.pendingTag || !settled(member.id, idleSince, now, settleMs)) {
        hold(member.id, 'sent-item-open');
        continue;
      }
      const reply = replyAfter(member, item.tag, item.sentAt, item.afterDecision === true, { itemId: item.id, nativeId: item.sentNative, claim: item });
      const controlChanged = Number.isSafeInteger(item.control) && (member.controlRevision || 0) !== item.control;
      let status = 'done';
      let reason = '';
      if (reply?.purposeInvalid) {
        status = 'waiting'; reason = rotationBlocked(member) ? 'rotation-control-unresolved' : 'input-purpose-unconfirmed';
      } else if (!reply) {
        status = 'failed';
        reason = 'record-missing';
      } else if (reply.humanAfter || controlChanged) {
        status = 'waiting';
        reason = 'person-intervened';
      } else if (reply.failedTurnIds?.length) {
        status = 'waiting';
        const quota = codexQuotaBlock(member);
        reason = quota && reply.failedTurnIds.includes(quota.turnId) ? 'usage-limit-exceeded' : 'native-turn-failed';
      } else if (!reply.last.trim()) {
        status = 'waiting';
        reason = 'no-reply';
      } else if (startsWithDecision(reply.last)) {
        status = 'waiting';
      }
      const action = { kind: 'settle', roomId: room.id, itemId: item.id, status, sessionId: member.id };
      if (reason) {
        action.reason = reason;
      }
      let line = '';
      if (reply && !reply.failedTurnIds?.length) {
        line = replyLine(reply.last);
        // Capture the question before replyLine flattens the remaining reply.
        if (status === 'waiting' && !reason) action.question = decisionLine(reply.last, item.text);
      }
      if (line) {
        action.reply = line;
      }
      const ready = reply && !reply.failedTurnIds?.length ? readyLine(reply.last) : null;
      if (ready) {
        action.ready = ready;
      } else if (status === 'done' && item.addedBy === 'steward') {
        // Preserve the actual first line before the queue's compact reply is flattened.
        action.reportTitle = reportTitle(reply?.last);
      }
      actions.push(action);
      if (status !== 'done') {
        hold(member.id, 'previous-item');
      }
    }
  }
  // 2) Send the next queued item to each ready member, one item per member.
  for (const room of rooms) {
    if (room.archived) {
      if (waits) for (const item of room.queue || []) if (item.status === 'queued') waits.set(item.id, [{ reason: 'space-archived' }]);
      continue;
    }
    const members = memberIds(room, sessions);
    const memberSet = new Set(members);
    const unassigned = members.filter(id => !carriedOn(id, input.handedOff, memberSet, byId));
    for (const item of room.queue || []) {
      if (item.status !== 'queued') {
        continue;
      }
      let candidates = unassigned;
      if (item.assignee) {
        candidates = [];
        if (members.includes(item.assignee)) {
          candidates = [item.assignee];
        }
      }
      let target = null;
      for (const id of candidates) {
        if (busy.has(id)) {
          continue;
        }
        const session = byId.get(id);
        if (!available(session)) {
          continue;
        }
        target = session;
        break;
      }
      if (!target) {
        if (!waits) continue;
        if (candidates.length) waits.set(item.id, candidates.map(waitOf));
        else if (item.assignee) waits.set(item.id, [{ sessionId: item.assignee, reason: 'not-member' }]);
        else waits.set(item.id, [{ reason: 'no-members' }]);
        continue;
      }
      hold(target.id, 'took-item');
      const reason = rotationReason(target, now, rotationOptions, rotations);
      stalled(target.id, reason ? 'no-slot' : rotationHold(target, rotationOptions, rotations));
      if (reason && rotationSlots > 0) {
        rotationSlots -= 1;
        actions.push(rotateAction(target.id, reason, rotationOptions));
        // The member is replaced before it takes more work; the item waits for that.
        if (waits) waits.set(item.id, [{ sessionId: target.id, reason: 'rotating' }]);
      } else {
        // Due but another rotation is running: it keeps working and is rotated later.
        const action = { kind: 'dispatch', roomId: room.id, itemId: item.id, sessionId: target.id };
        // Sent while a decision it asked is open: the person's answer may arrive during this item (replyAfter).
        if (rotationOptions.asking.has(target.id)) {
          action.afterDecision = true;
        }
        actions.push(action);
      }
    }
  }
  // 3) Old or oversized members of every space are rotated too, once they have been quiet,
  // whether or not the space keeps a queue (the person asked for all long sessions, 2026-11-08).
  const quietCandidates = [];
  function memoryOf(id) {
    const used = input.memory ? input.memory.get(id) : undefined;
    if (Number.isFinite(used)) {
      return used;
    }
    return 0;
  }
  const quietGroups = [];
  for (const room of rooms) {
    if (!room.archived) {
      quietGroups.push(memberIds(room, sessions));
    }
  }
  // The butler the person designated stays in no space, and is rotated under the same rules by its own name
  // (`outside`; steward step 2, batch 3: 「让空间外的大管家也能被 NAW 换会话」). One in a space is a member above.
  for (const id of input.outside || []) {
    let spaces = null;
    try {
      spaces = byId.has(id) ? roomIds(byId.get(id)) : null;
    } catch {
      spaces = null;
    }
    if (spaces && !spaces.length && !byId.get(id).archived) {
      quietGroups.push([id]);
    }
  }
  for (const ids of quietGroups) {
    for (const id of ids) {
      if (busy.has(id)) {
        stalled(id, why.get(id) || 'busy');
        continue;
      }
      const session = byId.get(id);
      // Ten or thirty quiet minutes already settle the member; the 8-second idle timer is not needed.
      const readiness = sessionReady(session, input.wakePolicy);
      const ready = readiness.ready && !humanRecent(id, humanAt, now, humanQuietMs);
      const reason = ready ? rotationReason(session, now, rotationOptions, rotations) : null;
      if (!reason) {
        if (!readiness.ready) {
          stalled(id, readiness.reason);
        } else if (!ready) {
          stalled(id, 'human-recent');
        } else {
          stalled(id, rotationHold(session, rotationOptions, rotations));
        }
        continue;
      }
      const lastActivity = lastActivityOf(session, now);
      if (lastActivity === null) {
        stalled(id, 'activity-unknown');
        continue;
      }
      let quiet = quietMs;
      if (reason === 'memory') {
        quiet = quietMemoryMs;
      } else if (reason === 'compact' && id === input.butler) {
        quiet = quietCompactMs;
      }
      if (now - lastActivity < quiet) {
        // Short only of its quiet: the steward wake holds rather than reset it (a butler at 52 compactions, 2026-11-23).
        if (input.quietPending) input.quietPending.set(id, reason);
        stalled(id, 'quiet');
        continue;
      }
      busy.add(id);
      quietCandidates.push({ sessionId: id, reason, memory: memoryOf(id), start: sessionStart(session, now) });
    }
  }
  // The butler named by a designation that no longer matches its native session: nothing rotates it as the butler.
  for (const id of input.unmatched || []) {
    stalled(id, 'designation-mismatch');
  }
  // The largest session goes first, then the oldest.
  quietCandidates.sort((a, b) => b.memory - a.memory || a.start - b.start);
  for (const candidate of quietCandidates.slice(0, Math.max(rotationSlots, 0))) {
    actions.push(rotateAction(candidate.sessionId, candidate.reason, rotationOptions));
  }
  for (const candidate of quietCandidates.slice(Math.max(rotationSlots, 0))) {
    if (gates) gates.delete(candidate.sessionId);
    stalled(candidate.sessionId, 'no-slot');
  }
  if (gates) {
    for (const action of actions) {
      if (action.kind === 'rotate') gates.delete(action.sessionId);
    }
  }
  return actions;
}

function rotateAction(sessionId, reason, options) {
  const action = { kind: 'rotate', sessionId, reason };
  if (reason === 'compact') action.compactions = options.compactions.get(sessionId);
  return action;
}

// Sessions a pass may rotate, whose compactions are counted: members of a space in use and the butler
// outside every space (planDispatch steps 2 and 3), not an old session already handed off.
function rotationSubjects(rooms, sessions, outside, handedOff) {
  const byId = new Map((sessions || []).map(session => [session.id, session]));
  const ids = new Set();
  for (const room of rooms || []) {
    if (!room.archived) for (const id of memberIds(room, sessions || [])) ids.add(id);
  }
  for (const id of outside || []) if (byId.has(id) && !byId.get(id).archived) ids.add(id);
  return [...ids].filter(id => !(handedOff && handedOff.has(id))).map(id => byId.get(id))
    .filter(session => ['claude', 'codex'].includes(session.provider));
}

// R121 (a): the space's notes go with an item while the person has 「派活时附上这份笔记」 on. A member has them when
// the last notes delivered to its current native session were this version; a new version (the notes changed,
// changed back, or the switch was turned on again) goes once more. A requeue forgets it (room-state.cjs queueRequeue).
function notesDue(room, session) {
  if (room.notesToQueue !== true || !room.notes) {
    return null;
  }
  const version = createHash('sha256').update(`${room.notesToQueueSince || 0}\n${room.notes}`).digest('hex').slice(0, 16);
  let last = null;
  for (const i of room.queue || []) {
    if (i.notesSent && i.tag && i.sentTo === session.id && (i.sentNative || null) === (session.nativeId || null) &&
      (!last || (i.sentAt || 0) >= (last.sentAt || 0))) {
      last = i;
    }
  }
  return last?.notesSent === version ? null : version;
}

const NOTES_HEAD = '附：这个空间的共享笔记（人打开了「派活时附上这份笔记」；这是背景，要做的仍是上面这一件）：';
const NOTES_CUT = '（笔记太长，这里只附了开头；全文在这个空间的共享笔记里。）';

function dispatchText(roomName, item, notes = '') {
  // workspace.cjs cleanText refuses these, and the notes field does not; they are invisible in the dialog.
  notes = notes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const text = body => [
    `【NAW 派活】空间「${roomName}」队列里的下一件：`,
    '',
    item.text,
    '',
    ...(body ? [NOTES_HEAD, body, ''] : []),
    '做完这一件就结束本轮：不留后台命令（要等审查或测试，就在本轮里用长等待等到它结束）、不留运行中的队友、不开 goal，也不要自己去任务板认领别的任务，NAW 会接着派下一件。需要人来决定时，本轮最后一条回复的第一行写「需要你决定：」，NAW 会提醒人，并接着给你派下一件；人的答复会直接发到你这里。',
    // How a member reports a delivery (readyLine below reads it). The example is not itself a valid line.
    '这一件交付了提交的，本轮最后一条回复里另起一行（不要放在第一行），只写这三项、各用一个空格隔开：READY <分支名> <分支上最新的提交号，7 到 40 位>。这一行不加引号、反引号、加粗或列表符号，行尾不加句号。NAW 会把这次交付记到空间里；没有提交就不写这一行。',
  ].join('\n');
  const full = text(notes);
  if (full.length <= SEND_TEXT_LIMIT) {
    return full;
  }
  // Within the backend's limit (workspace.cjs cleanText): only the notes are cut, never between a surrogate pair.
  let end = Math.max(0, SEND_TEXT_LIMIT - text('\n' + NOTES_CUT).length);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(notes[end - 1])) {
    end -= 1;
  }
  return text(notes.slice(0, end) + '\n' + NOTES_CUT);
}

// Human-readable explanations for space/OS notices; structured reason codes are
// separate metadata. null: the supplied reason is already a sentence.
const ROTATION_CAUSES = [
  [/^person-active$/, 'personActive'],
  [/^handoff-missing$/, 'handoffMissing'],
  [/^handoff-request-/, 'handoffRequest'],
  [/^handoff-unconfirmed$/, 'handoffUnconfirmed'],
  [/^successor-turn-failed$/, 'successorTurnFailed'],
  [/^old-session-missing$/, 'oldMissing'],
  [/^(new-session-(missing|not-ready|ambiguous)|create-timeout)$/, 'newNotReady'],
  [/^(new-session-model-unreported|settings-differ:|cannot-carry:model-unknown$)/, 'settings'],
  [/^cannot-carry:backend-cannot-carry-settings$/, 'backend'],
  [/^cannot-carry:(permission-mode|collaboration-mode)$/, 'mode'],
  [/^cannot-carry:(several-spaces|spaces-unreadable)$/, 'spaces'],
  [/^(join|leave)-timeout$/, 'spaceMove'],
  [/^(stop-timeout|native-stop-unconfirmed|guarded-stop-unavailable)$/, 'stop'],
  [/^(invalid-worktree-directory|worktree-preview-timeout|new-session-directory-trust-unavailable|native-directory-trust)/, 'directory'],
];
function rotationCauseKey(code) {
  const text = typeof code === 'string' ? code : '';
  if (text && !/^[\w:.-]+$/.test(text)) {
    return null;
  }
  const found = ROTATION_CAUSES.find(([pattern]) => pattern.test(text));
  return `notice.rotation.cause.${found ? found[1] : 'other'}`;
}

function rotationCause(record) {
  const key = record.failureCleanup && record.reason === 'handoff-unconfirmed' ? 'notice.rotation.cause.successorTurnTimeout' : rotationCauseKey(record.reason);
  return key ? uiNotice(key, ['notice.rotation.cause.successorTurnFailed', 'notice.rotation.cause.successorTurnTimeout'].includes(key)
    ? { name: record.newName || record.name } : undefined) : null;
}

const ROTATION_WAIT_CODES = new Set(['missing', 'archived', 'backend-update-needed', 'automatic-messages-off', 'paused',
  'not-idle', 'busy', 'unavailable', 'background-unconfirmed', 'background-work', 'person-typing', 'native-goal-active',
  'team-running', 'quiet-window', 'person-recent', 'trust-unknown', 'trust-hold', 'refresh-failed', 'refresh-timeout',
  'handoff-request-not-sent', 'handoff-request-failed', 'rotation-failed']);
const ROTATION_FAILURE_CODES = new Set(['person-active', 'handoff-missing', 'handoff-request-unconfirmed',
  'handoff-request-timeout', 'handoff-unconfirmed', 'successor-turn-failed', 'old-session-missing', 'new-session-missing',
  'new-session-not-ready', 'new-session-ambiguous', 'create-timeout', 'new-session-model-unreported',
  'join-timeout', 'leave-timeout', 'stop-timeout', 'native-stop-unconfirmed', 'guarded-stop-unavailable',
  'invalid-worktree-directory', 'worktree-preview-timeout', 'new-session-directory-trust-unavailable',
  'native-directory-trust', 'native-directory-trust-timeout', 'native-directory-trust-timeout-stop-unconfirmed']);
// Public failure/wait metadata contains reason codes, never native error text.
function rotationReasonCode(value, fallback = 'rotation-failed') {
  if (typeof value !== 'string') return fallback;
  if (ROTATION_WAIT_CODES.has(value) || ROTATION_FAILURE_CODES.has(value) || displayMessage({ version: 1, key: value }, 'error.')) return value;
  if (/^cannot-carry:(model-unknown|backend-cannot-carry-settings|permission-mode|collaboration-mode|several-spaces|spaces-unreadable)$/.test(value) ||
      /^settings-differ:(pending|model|model-provider|permission-mode|effort)$/.test(value)) return value;
  return fallback;
}

// Why it is due, as the old session (in Chinese) and the spaces (in the reader's language) are told.
function rotationWhyNotice(reason, records, bytes, compactions) {
  if (reason === 'memory') {
    return uiNotice('notice.rotation.why.memory', { gb: (bytes / 1073741824).toFixed(1) });
  }
  if (reason === 'compact') {
    return uiNotice('notice.rotation.why.compact', { count: String(compactions) });
  }
  return uiNotice('notice.rotation.why.content', { count: String(records) });
}

function handoffRequestText(why, reason) {
  const purpose = reason === 'compact' ? '为了不再一次次压缩上下文' : '为了释放内存';
  return [
    `【NAW 换会话】${why}。${purpose}，NAW 会开一个新会话接着做，这个会话随后结束（记录保留，可以恢复）。`,
    '',
    '请现在只写交接，不要开始新工作。交接写给接手的新会话，包括：',
    '1. 正在做的事和目标；',
    '2. 工作目录、分支、最近的提交；',
    '3. 没做完的事和下一步；',
    '4. 需要注意的约定、坑和待人决定的问题。',
  ].join('\n');
}

function nawMadeDirectory(cwd, defaultWorkspace, newWorkspaceRoot) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const selected = path.resolve(cwd);
  if (typeof defaultWorkspace === 'string' && path.isAbsolute(defaultWorkspace) && selected === path.resolve(defaultWorkspace)) return true;
  return typeof newWorkspaceRoot === 'string' && path.isAbsolute(newWorkspaceRoot) &&
    path.dirname(selected) === path.resolve(newWorkspaceRoot) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(path.basename(selected));
}

function directoryHandoff(record, snapshot) {
  if (!record.newCwd || record.newCwd === record.cwd || !nawMadeDirectory(record.cwd, snapshot.defaultWorkspace, snapshot.newWorkspaceRoot)) return '';
  let entries;
  try {
    if (!fs.lstatSync(record.cwd).isDirectory()) throw Error('Directory unavailable');
    const names = fs.readdirSync(record.cwd).sort();
    entries = names.length ? names.slice(0, 20).map(name => JSON.stringify(name)).join('、') + (names.length > 20 ? `，等 ${names.length} 项` : '') : '（空）';
  } catch { entries = '（目录清单未能读取）'; }
  const copy = record.newWorktree ? `（仓库 ${record.newWorktree.repository} 的 worktree，分支 ${record.newWorktree.branch}）` : '';
  return `旧会话的工作目录 ${record.cwd} 是 NAW 自动建的，新会话改在 ${record.newCwd}${copy}，这样能读到项目的 CLAUDE.md。旧目录保留，没有删除，里面现有：${entries}。需要时按绝对路径读写。`;
}

// `duty`: the butler's duty statement, handed on with the handoff when the butler is replaced (steward step 2,
// batch 3; the activation checklist, item 6: 「换会话后再发一次」). The backend takes at most SEND_TEXT_LIMIT
// characters (workspace.cjs cleanText), so a handoff that would not fit is shortened, never the statement.
// Sent before NAW knows whether the old session ends: what it says about the old one holds either way. A kept
// old session stays for the person; the space's work goes on to the successor (carriedOn), while the butler
// designation, the person's own setting, stays where the person is using it (queue-secretary.cjs successor).
// `decisions`: decisionsNote of the old session's open decisions. It stands right after the old session's own
// text, whole: only that text is shortened.
function handoffText(oldName, handoff, directoryNote = '', duty = '', decisions = '') {
  const after = duty
    ? '旧会话交完就结束，大管家由你接着当；要是人这时还在用旧会话，它就留给人用，大管家仍是它，直到人另行指定。'
    : '旧会话交完就结束；要是人这时还在用它，就留给人用完自己关，这个空间里没指定成员的活 NAW 之后派给你。';
  const text = body => [
    `【NAW 换会话】你接手「${oldName}」的工作，它写的交接如下：`,
    '',
    body,
    '',
    ...(decisions ? [decisions, ''] : []),
    ...(directoryNote ? [directoryNote, ''] : []),
    ...(duty ? [duty, ''] : []),
    after,
    '先按交接核对现状（只读即可），然后结束本轮，不留后台等待；这个空间有队列时，NAW 会接着派下一件。',
  ].join('\n');
  const left = SEND_TEXT_LIMIT - text('').length;
  if (handoff.length <= left) {
    return text(handoff);
  }
  // Cut before a character, never between the two halves of one.
  let end = Math.max(0, left - 1);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(handoff[end - 1])) {
    end -= 1;
  }
  return text(handoff.slice(0, end) + '…');
}

function spacesOf(session) {
  try {
    return roomIds(session);
  } catch {
    return [];
  }
}

// A decision's text as a handoff carries it: line ends made one kind and characters a NAW message cannot hold
// replaced, nothing dropped. replyLine of it is replyLine of the original.
function wholeText(text) {
  return plainReply(text).replace(/\r\n?|[\u2028\u2029]/gu, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, ' ').trim();
}

const DECISIONS_HEAD = '【没答的决定】';
// Said of a question when only the line the item kept is left and that line was cut (decisionQuestion).
const QUESTION_CUT = '（只留下开头，全文没找到）';
function decisionHead(number, roomName, itemId, text, question, cut) {
  return `〔决定 ${number}〕空间「${shortText(roomName || '')}」的条目 ${itemId}；任务原文 ${text.length} 字，提问 ${question.length} 字${cut ? QUESTION_CUT : ''}。`;
}

// The question of one decision as an earlier handoff told it, or null. The two counts in its heading say exactly
// where each text ends: what a block counts is its own, so a heading written inside a text is not read as one.
// The last block for the item stands, since the old session's own words come before NAW's.
function toldQuestion(text, itemId) {
  const heading = /〔决定 \d+〕空间「[^\n]*」的条目 ([^\n；]+)；任务原文 (\d+) 字，提问 (\d+) 字(（只留下开头，全文没找到）)?。\n任务原文：\n/gu;
  const asked = '\n提问：\n';
  let found = null;
  for (let match = heading.exec(text); match; match = heading.exec(text)) {
    const from = heading.lastIndex + Number(match[2]);
    const end = from + asked.length + Number(match[3]);
    if (text.slice(from, from + asked.length) !== asked || end > text.length || (end < text.length && text[end] !== '\n')) {
      continue;
    }
    heading.lastIndex = end;
    if (match[1] === itemId) {
      found = { text: text.slice(from + asked.length, end), cut: match[4] === QUESTION_CUT };
    }
  }
  return found;
}

// What the member asked, whole. The item keeps one cut line of it (replyLine); the whole of it is the member's
// own reply to that item, or, in a successor, what its handoff told it. Either must start as the kept line does.
// When neither is found the kept line stands in, and `cut` says that line is not the whole question.
function decisionQuestion(item, session) {
  const kept = typeof item.reply === 'string' ? item.reply : '';
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (!kept) {
    return { text: '', cut: false };
  }
  let sent = -1;
  if (item.tag) {
    sent = messages.findLastIndex(message => message && message.id === item.tag);
  }
  for (let i = sent + 1; sent >= 0 && i < messages.length; i += 1) {
    const message = messages[i];
    if (message && message.role === 'assistant' && typeof message.text === 'string' && replyLine(message.text) === kept) {
      return { text: wholeText(message.text), cut: false };
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user' || message.origin !== 'naw-dispatch' || typeof message.text !== 'string' ||
        typeof message.dispatchItem !== 'string' || !message.dispatchItem.startsWith('rotation-handoff:')) {
      continue;
    }
    const told = toldQuestion(message.text, item.id);
    if (told !== null && replyLine(told.text) === kept) {
      return told;
    }
  }
  // shortText ends a line it cut with '…'.
  return { text: kept, cut: kept.length >= ITEM_REPLY_LIMIT && kept.endsWith('…') };
}

// The decisions a session holds open in the spaces it hands over, as its successor must be told them.
function openDecisions(rooms, session, spaceIds) {
  const found = [];
  for (const room of rooms || []) {
    if (!spaceIds.includes(room.id)) {
      continue;
    }
    for (const item of room.queue || []) {
      if (item.sentTo === session.id && openDecision(item)) {
        const question = decisionQuestion(item, session);
        const decision = { roomId: room.id, roomName: room.name, itemId: item.id, text: wholeText(item.text), question: question.text };
        if (question.cut) {
          decision.cut = true;
        }
        found.push(decision);
      }
    }
  }
  return found;
}

function decisionsNote(oldName, decisions) {
  if (!decisions.length) {
    return '';
  }
  const lines = [
    `${DECISIONS_HEAD}「${oldName}」名下问过人、人还没答的决定有 ${decisions.length} 条，现在归你。人的答复会直接发到你这里，收到后照答复接着做；人答之前不替人决定，也不用再问一遍。`,
  ];
  decisions.forEach((decision, index) => {
    lines.push(
      '',
      decisionHead(index + 1, decision.roomName, decision.itemId, decision.text, decision.question, decision.cut === true),
      '任务原文：',
      decision.text,
      '提问：',
      decision.question || '',
    );
  });
  return lines.join('\n');
}

function shortText(text, limit = 60) {
  const line = text.replace(/\s+/gu, ' ').trim();
  if (line.length <= limit) {
    return line;
  }
  return line.slice(0, limit - 1) + '…';
}

function decisionLine(reply, task = '') {
  // Normalize terminal escapes while retaining the first-line privacy boundary.
  const first = replyLine((typeof reply === 'string' ? reply : '').trimStart().split(/\r\n|[\n\r\u2028\u2029]/u)[0]);
  const marker = DECISION_MARKERS.find(value => first.startsWith(value));
  const question = (marker ? first.slice(marker.length) : first).trim();
  return shortText(question || task, 60);
}

function reportTitle(reply) {
  const first = typeof reply === 'string' ? plainReply(reply).trimStart().split(/\r\n|[\n\r\u2028\u2029]/u)[0] : '';
  return shortText(replyLine(first), 200) || 'Completed';
}

// A member that delivers code writes one line in its reply: READY <branch> <commit>.
// The names later become git arguments, so only this shape of them is ever stored. A build
// that later keeps more beside them must stay readable here, so other keys are not refused.
const READY_BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/u;
const READY_COMMIT = /^[0-9a-f]{7,40}$/u;
function validReady(ready) {
  return Boolean(ready) && typeof ready === 'object' && !Array.isArray(ready) &&
    typeof ready.branch === 'string' && READY_BRANCH.test(ready.branch) && !ready.branch.includes('..') && !ready.branch.startsWith('-') &&
    typeof ready.commit === 'string' && READY_COMMIT.test(ready.commit);
}

// The last whole line with that shape, wherever it stands in the reply, or null. Nothing else
// in the reply is read, and what the line names is checked again before anything acts on it.
function readyLine(reply) {
  if (typeof reply !== 'string') {
    return null;
  }
  const lines = plainReply(reply).split(/\r\n|[\n\r\u2028\u2029]/u);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parts = lines[i].trim().split(' ');
    if (parts.length !== 3 || parts[0] !== 'READY') {
      continue;
    }
    const ready = { branch: parts[1], commit: parts[2].toLowerCase() };
    if (validReady(ready)) {
      return ready;
    }
  }
  return null;
}

// One storable line of a member's reply. A terminal reply can carry escape sequences, which the
// queue item's own validation rejects, so they go before the length is cut.
function replyLine(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return shortText(plainReply(text).replace(/[\u0000-\u001f\u007f]+/gu, ' '), ITEM_REPLY_LIMIT);
}

// Terminal escape sequences out, line breaks kept.
function plainReply(text) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, ' ')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, ' ')
    .replace(/\u001b[@-Z\\-_]/gu, ' ');
}

// The same rules as workspace.cjs isTerminalResponse (a unit test keeps them equal),
// plus focus reports: a terminal's own replies are not the person typing.
function isPointerHover(data) {
  if (!/^(?:\x1b\[<\d+;\d+;\d+M)+$/.test(data)) {
    return false;
  }
  for (const match of data.matchAll(/\x1b\[<(\d+);/g)) {
    if ((Number(match[1]) & 35) !== 35) {
      return false;
    }
  }
  return true;
}

function isTerminalResponse(data) {
  if (/^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\[\??\d+;[0-4]\$y$/.test(data)) {
    return true;
  }
  return /^\x1b\](10|11);rgb:[\da-f/]+(\x07|\x1b\\)$/i.test(data) || isPointerHover(data);
}

function terminalReplyOnly(data) {
  if (typeof data !== 'string' || !data) {
    return false;
  }
  return isTerminalResponse(data) || /^\x1b\[[IO]$/.test(data);
}

// 「名字」→「名字 · 续」→「名字 · 续2」→「名字 · 续3」…
function nextName(name) {
  const match = /^(.*) · 续(\d*)$/u.exec(name);
  if (!match) {
    return `${name} · 续`;
  }
  let generation = 2;
  if (match[2]) {
    generation = Number(match[2]) + 1;
  }
  return `${match[1]} · 续${generation}`;
}

function shortId(id) {
  if (typeof id !== 'string') {
    return '';
  }
  return id.slice(0, 6);
}

function validLogEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  // archived: an old session NAW archived after its done rotation (only done and kept link sessions).
  if (!['requested', 'done', 'kept', 'failed', 'waiting', 'archived'].includes(entry.event) || !Number.isFinite(entry.time)) {
    return false;
  }
  if (entry.noticeId !== undefined && !validTrustReceipt(entry.noticeId)) return false;
  if (!Array.isArray(entry.spaces) || entry.spaces.some(space => typeof space !== 'string')) {
    return false;
  }
  if (!entry.old || typeof entry.old !== 'object' || typeof entry.old.id !== 'string') {
    return false;
  }
  return entry.new === null || (typeof entry.new === 'object' && typeof entry.new.id === 'string');
}

// Rotation log entries joined into chains: the sessions behind one continuing conversation.
// A session kept and rotated again has several successors; each path is its own chain.
function rotationChains(entries) {
  const nextOf = new Map();
  const previousOf = new Map();
  const sessionInfo = new Map();
  const spacesOf = new Map();
  for (const entry of entries) {
    if (!validLogEntry(entry)) {
      continue;
    }
    sessionInfo.set(entry.old.id, { ...sessionInfo.get(entry.old.id), ...entry.old });
    spacesOf.set(entry.old.id, entry.spaces);
    if (entry.new) {
      sessionInfo.set(entry.new.id, { ...sessionInfo.get(entry.new.id), ...entry.new });
      spacesOf.set(entry.new.id, entry.spaces);
    }
    if (['done', 'kept'].includes(entry.event) && entry.new) {
      if (!nextOf.has(entry.old.id)) {
        nextOf.set(entry.old.id, []);
      }
      nextOf.get(entry.old.id).push({ id: entry.new.id, time: entry.time, event: entry.event });
      previousOf.set(entry.new.id, entry.old.id);
    }
  }
  const chains = [];
  function walk(links, id, seen) {
    const nexts = nextOf.get(id) || [];
    if (!nexts.length) {
      const spaces = new Set();
      for (const link of links) {
        for (const space of spacesOf.get(link.id) || []) {
          spaces.add(space);
        }
      }
      chains.push({ spaces: [...spaces], sessions: links });
      return;
    }
    for (const next of nexts) {
      if (seen.has(next.id)) {
        continue;
      }
      const link = { ...sessionInfo.get(next.id), id: next.id, handedAt: next.time, outcome: next.event };
      walk([...links, link], next.id, new Set([...seen, next.id]));
    }
  }
  for (const id of nextOf.keys()) {
    if (previousOf.has(id)) {
      continue;
    }
    walk([{ ...sessionInfo.get(id), id, handedAt: null, outcome: null }], id, new Set([id]));
  }
  return chains;
}

const UNIT_BYTES = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

// One line of `top -l 1 -stats pid,ppid,mem`, such as '4325  4300  347M+': pid, parent, bytes.
function footprintLine(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)([BKMGT])[+-]?$/);
  if (!match) {
    return null;
  }
  return { pid: Number(match[1]), parent: Number(match[2]), bytes: Math.round(Number(match[3]) * UNIT_BYTES[match[4]]) };
}

// Memory footprint of each session's process and its children, from one top listing.
// A process shared by two sessions is charged to neither.
function processMemory(sessions, topOutput) {
  const children = new Map();
  const footprint = new Map();
  for (const line of topOutput.split('\n')) {
    const row = footprintLine(line);
    if (!row) {
      continue;
    }
    footprint.set(row.pid, row.bytes);
    if (!children.has(row.parent)) {
      children.set(row.parent, []);
    }
    children.get(row.parent).push(row.pid);
  }
  const owners = new Map();
  for (const session of sessions) {
    if (Number.isSafeInteger(session.pid)) {
      owners.set(session.pid, (owners.get(session.pid) || 0) + 1);
    }
  }
  const result = new Map();
  for (const session of sessions) {
    if (!Number.isSafeInteger(session.pid) || !footprint.has(session.pid) || owners.get(session.pid) > 1) {
      continue;
    }
    let total = 0;
    const stack = [session.pid];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      total += footprint.get(pid) || 0;
      for (const child of children.get(pid) || []) {
        stack.push(child);
      }
    }
    result.set(session.id, total);
  }
  return result;
}

// `sysctl -n kern.memorystatus_vm_pressure_level` is macOS's own judgment: 1 normal, 2 warning,
// 4 critical. Swap usage is not used: it stays high long after the pressure has passed.
function memoryPressure(text) {
  const level = Number(String(text || '').trim());
  return Number.isInteger(level) && level >= 2;
}

// The text a native terminal snapshot shows, as the person would read it on screen.
async function terminalText(snapshot) {
  const { Terminal } = require('@xterm/headless');
  let cols = 200;
  if (Number.isSafeInteger(snapshot.cols) && snapshot.cols > 0) {
    cols = snapshot.cols;
  }
  let rows = 60;
  if (Number.isSafeInteger(snapshot.rows) && snapshot.rows > 0) {
    rows = snapshot.rows;
  }
  const terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(snapshot.buffer, resolve));
    const lines = [];
    const buffer = terminal.buffer.active;
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    while (lines.length && !lines[lines.length - 1].trim()) {
      lines.pop();
    }
    return lines.join('\n') + '\n';
  } finally {
    terminal.dispose();
  }
}

// What a live native terminal shows, an unsent prompt included, saved as text in dir (owner-only).
// Read through a separate connection that owns nothing: a terminal that is no longer open is never
// reopened for this (only its owner could), and then nothing unsent remains (null).
async function saveTerminalScreen(connect, owner, dir, sessionId, now) {
  const connecting = Promise.resolve(connect(`${owner}-terminal`));
  let probe;
  try {
    probe = await withTimeout(connecting, CALL_TIMEOUT_MS, 'connect-timeout');
  } catch (error) {
    // A connection that arrives after the timeout is closed when it does.
    connecting.then(late => late.close()).catch(() => {});
    throw error;
  }
  let snapshot;
  try {
    snapshot = await withTimeout(probe.call('terminalSnapshot', sessionId), CALL_TIMEOUT_MS, 'snapshot-timeout');
  } catch (error) {
    if (errorKey(error) === TERMINAL_CLOSED_KEY) {
      return null;
    }
    throw error;
  } finally {
    try {
      probe.close();
    } catch {
      // The probe holds no state.
    }
  }
  if (!snapshot || typeof snapshot.buffer !== 'string') {
    throw Error('terminal-snapshot-missing');
  }
  const text = await terminalText(snapshot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${sessionId}-${now}.txt`;
  fs.writeFileSync(path.join(dir, name), text, { mode: 0o600, flag: 'wx' });
  return path.join(path.basename(dir), name);
}

// Provably quiet: a known last activity at least ms ago and no recent use from the person's window.
function quietFor(session, humanAt, now, ms) {
  const last = lastActivityOf(session, now);
  if (last === null || now - last < ms) {
    return false;
  }
  return !humanRecent(session.id, humanAt, now, ms);
}

// The next old backend NAW moves by itself. With automatic updates on, a move the runtime proved
// safe; with migration on (the person's standing confirmation), also a move that needs it, once
// every session it stops has been quiet for a while.
// The newest teammate or child report: activity the longer wait must also cover.
function lastFleetTime(session) {
  let newest = null;
  for (const item of session.fleet || []) {
    if (Number.isFinite(item.time) && (newest === null || item.time > newest)) {
      newest = item.time;
    }
  }
  return newest;
}

// One rule for choosing a move and for re-checking each session right before its stop.
function migrationReady(session, humanAt, now, quietMs = MIGRATE_QUIET_MS, unprovenQuietMs = MIGRATE_UNPROVEN_QUIET_MS) {
  const backendSwitch = require('./backend-switch.cjs');
  if (backendSwitch.migrationSafe(session)) {
    return quietFor(session, humanAt, now, quietMs);
  }
  if (backendSwitch.migrationAcceptable(session)) {
    const fleetAt = lastFleetTime(session);
    if (fleetAt !== null && now - fleetAt < unprovenQuietMs) {
      return false;
    }
    return quietFor(session, humanAt, now, unprovenQuietMs);
  }
  return false;
}

// Why NAW does not move this old backend by itself now, or null when it may: one rule for the move NAW chooses
// (nextBackendMove) and for what version-events.cjs tells the butler and the secretary each backend waits for.
// `waiting`: how many of the sessions it would stop are not quiet long enough yet.
function moveWait(option, settings, sessions, humanAt, now, failed, quietMs = MIGRATE_QUIET_MS, unprovenQuietMs = MIGRATE_UNPROVEN_QUIET_MS) {
  const plan = option.switch;
  const backendSwitch = require('./backend-switch.cjs');
  if (failed.has(option.backendKey)) {
    return { code: 'failed' };
  }
  if (plan && plan.blocked) {
    // At work (a turn, a question, a running child or background work) passes by itself; anything else needs the person.
    let busy = 0, stuck = false;
    const ids = [];
    for (const listed of option.sessions || []) {
      const session = sessions.find(s => s.id === listed.id);
      // Ended and background sessions are carried or block for a reason of their own.
      if (!session || ['ended', 'recoverable', 'background'].includes(session.state)) {
        continue;
      }
      // These block this backend for good (backend-switch.cjs sessionPlan): not to be told as passing by itself.
      if (['disconnected', 'error'].includes(session.state) || !['claude', 'codex'].includes(session.provider)) {
        stuck = true;
      } else if (!backendSwitch.migrationAcceptable(session)) {
        busy++;
        ids.push(session.id);
      } else if (!session.nativeId) {
        stuck = true;
      }
    }
    if (busy && !stuck) {
      return { code: settings.migrate ? 'busy' : 'busy-auto', waiting: busy, ids };
    }
    return withReason({ code: 'blocked' }, plan.reason);
  }
  // Told with its reason, so a backend that never moves says why.
  if (!plan || !plan.ready) {
    return withReason({ code: 'not-movable' }, option.moveRefused || option.reason);
  }
  if (plan.auto && settings.auto) {
    return null;
  }
  if (!settings.migrate) {
    return { code: 'needs-person' };
  }
  let missing = false, unacceptable = false, longer = false, waiting = 0;
  const ids = [];
  for (const stop of plan.stops || []) {
    const session = sessions.find(s => s.id === stop.id);
    if (!session) {
      missing = true;
      continue;
    }
    if (plan.auto) {
      if (!quietFor(session, humanAt, now, quietMs)) {
        waiting++;
        ids.push(session.id);
      }
    } else if (!migrationReady(session, humanAt, now, quietMs, unprovenQuietMs)) {
      waiting++;
      ids.push(session.id);
      if (!backendSwitch.migrationSafe(session)) {
        if (backendSwitch.migrationAcceptable(session)) {
          longer = true;
        } else {
          unacceptable = true;
        }
      }
    }
  }
  if (missing) {
    return { code: 'session-missing' };
  }
  if (unacceptable) {
    return { code: 'blocked' };
  }
  if (waiting) {
    return { code: longer ? 'quiet-30m' : 'quiet-10m', waiting, ids };
  }
  return null;
}
function withReason(wait, reason) {
  if (typeof reason === 'string' && reason) {
    wait.reason = reason;
  }
  return wait;
}

function nextBackendMove(options, settings, sessions, humanAt, now, failed, quietMs = MIGRATE_QUIET_MS, unprovenQuietMs = MIGRATE_UNPROVEN_QUIET_MS) {
  for (const option of options) {
    if (moveWait(option, settings, sessions, humanAt, now, failed, quietMs, unprovenQuietMs) === null) {
      return option;
    }
  }
  return null;
}

function execText(file, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function errorKey(error) {
  if (error && error.uiMessage && typeof error.uiMessage.key === 'string') {
    return error.uiMessage.key;
  }
  return '';
}

function notSent(error) {
  if (error && error.notSent === true) {
    return true;
  }
  const key = error && error.uiMessage && error.uiMessage.key;
  return typeof key === 'string' && NOT_SENT_KEYS.includes(key);
}

const RELEASE_RETRIES = 2, RELEASE_RETRY_MS = 3000;
const RELEASE_ANSWER_LOST = ['error.serviceClosed', 'error.serviceDisconnected', 'error.confirmationTimeout', 'release-timeout'];
function releaseBackendOutdated(version) {
  const match = /^0\.1\.0-alpha\.(\d+)$/.exec(typeof version === 'string' ? version : '');
  return Boolean(match && Number(match[1]) < 284);
}
function releaseSaved(entry, id, nativeId, epoch, tag) {
  const episode = entry?.state?.sessions?.find(s => s.id === id)?.rotationEpisode;
  return Boolean(episode && episode.nativeId === nativeId && episode.epoch === epoch && episode.tag === tag &&
    episode.state === 'released' && episode.disposition?.action === 'release');
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label)), ms);
    if (timer.unref) {
      timer.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Read each owner-only record independently; rejected rows retain their identity
// for quarantine rather than disabling unrelated queues or authorizing cleanup.
function readRotations(file, now, faults = {}) {
  faults.rejected = {};
  const reject = (id, record) => Object.defineProperty(faults.rejected, id, { value: record, enumerable: true, configurable: true, writable: true });
  const unreadable = reason => { faults.error = reason; return {}; };
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return unreadable(error.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  faults.identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, uid: stat.uid };
  const ownerOnly = (stat.mode & 0o077) === 0;
  const mine = !process.getuid || stat.uid === process.getuid();
  if (!stat.isFile() || !ownerOnly || !mine) {
    return unreadable('unsafe');
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return unreadable('invalid-json');
  }
  if (!data || data.version !== 1 || !data.rotations || typeof data.rotations !== 'object' || Array.isArray(data.rotations)) {
    return unreadable('invalid-envelope');
  }
  if (data.quarantinedRotations && typeof data.quarantinedRotations === 'object' && !Array.isArray(data.quarantinedRotations)) faults.rejected = { ...data.quarantinedRotations };
  const result = {};
  for (const oldId of Object.keys(data.rotations)) {
    const record = data.rotations[oldId];
    // New durable state can describe a live, quarantined successor. Corruption
    // must not silently drop that quarantine through the legacy skip rules.
    if (record && typeof record === 'object' && ['trustOwner', 'trustEffects', 'trustCleanup'].some(key => Object.hasOwn(record, key)) &&
        (!validId(oldId) || !ROTATION_PHASES.includes(record.phase) || !validId(record.oldNativeId) || !validId(record.newId) || record.newId === oldId ||
          !['claude', 'codex'].includes(record.provider) || !Array.isArray(record.roomIds) || !record.roomIds.every(validId) ||
          new Set(record.roomIds).size !== record.roomIds.length || typeof record.name !== 'string' || !validTrustReceipt(record.trustNoticeId) ||
          !validTime(record.trustWaitingAt) || typeof record.newCwd !== 'string' || !path.isAbsolute(record.newCwd) || record.newCwd === record.cwd || record.newCwd.includes('\0') || record.newCwd.length > 4096)) {
      reject(oldId, record); continue;
    }
    if (!validId(oldId) || !record || typeof record !== 'object' || !ROTATION_PHASES.includes(record.phase)) {
      reject(oldId, record); continue;
    }
    if (!validId(record.oldNativeId || '') || !Array.isArray(record.roomIds) || typeof record.name !== 'string') {
      reject(oldId, record); continue;
    }
    if (Object.hasOwn(record, 'failureCleanup') && (record.oldId !== oldId || !firstHandoff.validCleanup(record))) { reject(oldId, record); continue; }
    if (record.phase === 'waiting-trust' && (!validId(record.newId) || !validTrustReceipt(record.trustNoticeId) || !validTime(record.trustWaitingAt) || !['claude', 'codex'].includes(record.provider) || !record.newCwd || record.newCwd === record.cwd)) { reject(oldId, record); continue; }
    if (record.episodeEpoch !== undefined && (!validTrustReceipt(record.episodeEpoch) || !['open', 'invalid', 'complete', 'waiting-provider'].includes(record.episodeState))) { reject(oldId, record); continue; }
    if (record.phase === 'waiting-provider' && (!validTrustReceipt(record.episodeEpoch) || !validId(record.tag) ||
        record.episodeState !== 'waiting-provider' || record.providerBlock?.kind !== 'usage_limit_exceeded' ||
        !validId(record.providerBlock.turnId) || !validTime(record.providerBlock.observedAt))) { reject(oldId, record); continue; }
    if (record.trustNoticeId !== undefined && !validTrustReceipt(record.trustNoticeId)) { reject(oldId, record); continue; }
    if (record.trustNotified !== undefined && typeof record.trustNotified !== 'boolean') { reject(oldId, record); continue; }
    if (record.trustWaitingAt !== undefined && !validTime(record.trustWaitingAt)) { reject(oldId, record); continue; }
    if (record.newId !== undefined && !validId(record.newId)) {
      reject(oldId, record); continue;
    }
    if (record.newCwd !== undefined && (typeof record.newCwd !== 'string' || !path.isAbsolute(record.newCwd) || record.newCwd.includes('\0') || record.newCwd.length > 4096)) { reject(oldId, record); continue; }
    if (record.newWorktree !== undefined) {
      try { gitWorktree.planShape(record.newWorktree); } catch { reject(oldId, record); continue; }
      if (record.newCwd !== record.newWorktree.cwd) { reject(oldId, record); continue; }
    }
    if ((record.trustOwner !== undefined && record.trustOwner !== null && !validTrustProof(record.trustOwner, record.provider)) ||
        (record.trustEffects !== undefined && !validNoticeEffects(record.trustEffects, record.roomIds)) ||
        (record.trustCleanup !== undefined && (!trustFailure(record) || record.newId === oldId || !validTrustCleanup(record.trustCleanup, record)))) {
      reject(oldId, record); continue;
    }
    if (record.phase === 'failed' && now - (record.failedAt || 0) > FAILED_ROTATION_KEEP_MS && !trustRecoveryPending(record) && !failedHandoffPending(record)) {
      continue;
    }
    // Recorded before a resumed Claude session's model was read from its transcript; not a reason to rest.
    if (record.phase === 'failed' && record.reason === 'cannot-carry:model-unknown') {
      continue;
    }
    // The person used the old session before a successor was made (an older build rested it a week; see
    // deferRotation). Trust records and a record with a successor (its stop unconfirmed, its handoff confirmed, or
    // its isolation hold naming this record) keep theirs, as failRotation keeps them.
    if (record.phase === 'failed' && record.reason === 'person-active' && !record.episodeEpoch && !trustRecord(record) && !validId(record.newId)) {
      continue;
    }
    if (record.phase === 'kept' && now - (record.keptAt || 0) > ROTATE_AFTER_MS) {
      continue;
    }
    Object.defineProperty(result, oldId, { value: record, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

// Reads the state a window already holds; opens its own connection only when no
// window is open and queued work is waiting. Refreshes only right before it sends.
class QueueDispatcher {
  constructor(options) {
    this.roomState = options.roomState;
    this.clients = options.clients || (() => null);
    this.connect = options.connect;
    this.labels = options.labels || new Map();
    this.creationDefaults = options.creationDefaults || (() => ({}));
    // Native first-directory trust must be qualified before unattended moves.
    this.migrateDirectories = options.migrateDirectories === true;
    // Trust must not bypass the existing ten-minute startup readiness budget.
    // The production environment supplies decimal milliseconds; invalid limits
    // fall back instead of disabling cleanup. Keep the saved wait start.
    const trustTimeout = typeof options.directoryTrustTimeoutMs === 'string' && /^\d+$/.test(options.directoryTrustTimeoutMs)
      ? Number(options.directoryTrustTimeoutMs) : options.directoryTrustTimeoutMs;
    this.directoryTrustTimeoutMs = Number.isSafeInteger(trustTimeout) && trustTimeout > 0 ? trustTimeout : NEW_SESSION_READY_MS;
    this.broadcast = options.broadcast || (async () => {});
    this.observeQueueState = options.observeQueueState || null;
    this.observePersonActions = options.observePersonActions || null;
    // B6: the engine that hands delivered work to the person's designated integrator. The caller
    // builds it for this dispatcher, because it sends through the dispatcher's own send. Absent
    // unless given: without it nothing below runs. It is built at the end of this constructor.
    this.integration = null;
    this.integrationUnreadable = options.integrationUnreadable || (() => {});
    this.integrationFailed = options.integrationFailed || (() => {});
    // The last failure of the engine (while it was built, or in a pass), kept so that it is not
    // lost: { message, at, count }, and recoveredAt once a later step went through.
    // The person is told once per kind of failure in a run, so a new kind after a recovery is told too.
    this.integrationError = null;
    this.integrationTold = new Set();
    this.integratorAbsent = new Map();
    this.file = path.join(options.dataDir, 'queue-dispatch.json');
    this.now = options.now || Date.now;
    this.settleMs = options.settleMs ?? IDLE_SETTLE_MS;
    this.humanQuietMs = options.humanQuietMs ?? HUMAN_QUIET_MS;
    this.contentLimits = options.contentLimits ?? CONTENT_LIMITS;
    this.quietMs = options.quietMs ?? QUIET_BEFORE_ROTATE_MS;
    this.compactLimit = options.compactLimit ?? COMPACT_LIMIT;
    this.quietCompactMs = options.quietCompactMs ?? QUIET_COMPACT_MS;
    // Counts each member's own compactions from the native records (compaction-count.cjs); the app turns it on.
    this.compactions = options.compactions || (options.countCompactions === true ? new CompactionCounter() : null);
    // Told one line per stall and gate (noteRotationStalls); `stalls` holds since when, in memory only.
    this.rotationStalled = typeof options.rotationStalled === 'function' ? options.rotationStalled : null;
    this.stalls = new Map();
    this.tickMs = options.tickMs ?? TICK_MS;
    this.transcriptRoot = options.transcriptRoot || claudeProjects();
    // Sessions whose model is known nowhere yet: asked again after a while, never rested for a week.
    this.unknownModelAt = new Map();
    // Rotations the person interrupted by using the old session: id -> { at, due } (in memory; see personDeferred).
    this.deferredAt = new Map();
    // Each waits once in the log per app run, so a session that never reports is still traceable.
    this.loggedWaiting = new Set();
    this.memoryLimit = options.memoryLimit ?? MEMORY_LIMIT_BYTES;
    this.pressureLimit = options.pressureLimit ?? PRESSURE_LIMIT_BYTES;
    this.memoryMinAgeMs = options.memoryMinAgeMs ?? MEMORY_MIN_AGE_MS;
    this.sampleProcesses = options.sampleProcesses || (() => execText('/usr/bin/top', ['-l', '1', '-stats', 'pid,ppid,mem']));
    this.samplePressure = options.samplePressure || (() => execText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
    this.memorySample = null;
    this.lastMaintenance = 0;
    this.owner = options.owner || randomUUID();
    this.idleSince = new Map();
    // Passive business observations must survive skipped minute-maintenance
    // ticks. This clock never authorizes a native dispatch or rotation.
    this.vacancySince = new Map();
    this.vacancyIdentity = new Map();
    this.humanAt = new Map();
    this.rotationWaitReasons = new Map();
    this.pending = null;
    this.again = false;
    this.closed = false;
    this.client = null;
    this.listening = null;
    this.own = null;
    this.timer = null;
    this.dirty = true;
    this.lastFullPass = 0;
    this.onState = snapshot => {
      this.dirty = true;
      if (this.observePersonActions) this.observePersonActions(snapshot);
      if (this.observeQueueState) this.observeVacancyReadiness(snapshot, this.now());
    };
    this.rotationRead = {};
    this.rotations = readRotations(this.file, this.now(), this.rotationRead);
    this.rejectedRotations = { ...this.rotationRead.rejected };
    this.isolation = trustIsolation(this.roomState.directoryTrustIsolation?.());
    this.persistedTrustHolds = { ...this.isolation.holds };
    this.isolationDirty = false;
    this.faultedRotations = new Set();
    this.faultNoticed = new Set();
    this.notify = options.notify || (() => {});
    // The butler the person designated, as it is now: { sessionId, nativeId, duty } or null (steward step 2, batch 3).
    // A record that cannot be read names nobody here: the butler is then not rotated and gets no statement.
    this.steward = options.steward || (() => null);
    // Waking that butler when NAW has recorded something new (steward-wake.cjs), or null: it keeps the switch, the position
    // and the minute between wakes; a pass here finds the butler ready and sends (wakeSteward).
    this.stewardWake = options.stewardWake || null;
    // What the person answered on an agent's confirmation cards, owed to that agent (answer-notices.cjs), or null; a
    // pass here finds the agent ready and sends (notifyAnswers).
    this.answerNotices = options.answerNotices || null;
    // What a restart brought, owed to the queue secretary (version-events.cjs), or null; sent as answers are.
    this.versionNotices = options.versionNotices || null;
    // Migration quiet windows (quiet-windows.cjs), or null: their sessions get no new item or NAW message.
    this.quietWindows = options.quietWindows || null;
    this.logFile = path.join(options.dataDir, 'rotation-log.jsonl');
    this.log = this.loadLog();
    // finishDeferrals: one try per episode and backend version a run.
    this.deferralsTried = new Set();
    this.chainsCache = null;
    this.restoreTrustIsolation();
    // B6: the engine is built last, for a dispatcher that is complete. One that cannot be built
    // does not take the queue with it: the dispatcher runs without an engine, keeps the fault and
    // tells the person.
    if (typeof options.integration === 'function') {
      try { this.integration = options.integration(this); } catch (error) { this.integrationFault(error); }
    }
  }

  // Successor identity is in independent existing room metadata. A damaged
  // rotation row cannot move that identity to a different idle member.
  isolationWrite() {
    this.roomState.saveDirectoryTrustIsolation(this.isolation);
    this.persistedTrustHolds = { ...this.isolation.holds };
    this.isolationDirty = false;
  }
  holdTrustSuccessor(oldId, record) {
    if (!movedSuccessor(record) || record.newId === oldId || record.handoffConfirmed || cleanupComplete(record)) return;
    const hold = { oldId, receiptId: record.trustNoticeId || null, roomIds: [...record.roomIds],
      name: record.name || oldId, newName: record.newName || record.newId };
    if (!validTrustHold(hold)) throw Error('Invalid directory trust hold');
    const id = record.newId, prior = this.isolation.holds[id];
    if (this.isolation.unknown || Object.hasOwn(this.isolation.faults, id) ||
        prior && (!validTrustHold(prior) || prior.oldId !== oldId)) throw Error('Directory trust isolation needs a decision');
    if (JSON.stringify(prior) !== JSON.stringify(hold)) {
      this.isolation.holds = { ...this.isolation.holds, [id]: hold }; this.isolationDirty = true;
    }
  }
  faultTrustSuccessor(id, reason) {
    if (!Object.hasOwn(this.isolation.faults, id)) {
      this.isolation.faults = { ...this.isolation.faults, [id]: { reason, receiptId: randomUUID() } };
      this.isolationDirty = true;
    }
    const oldId = this.isolation.holds[id]?.oldId;
    if (validId(oldId)) this.faultedRotations.add(oldId);
  }
  restoreTrustIsolation() {
    const saved = this.roomState.directoryTrustIsolation?.();
    // With neither an index nor a readable trust row there is no evidence of
    // a migration in this installation. Preserve the ordinary legacy fallback.
    // A saved unknown decision can be re-evaluated after a complete, valid
    // primary record is restored; an automatically written empty store is not
    // identity evidence and cannot lift that hold.
    if (saved?.unknown === true && !this.roomState.warning && !this.rotationRead.error &&
        !Object.keys(this.rejectedRotations).length && Object.values(this.rotations).some(movedSuccessor) &&
        Object.entries(this.isolation.holds).every(([id, hold]) => validTrustHold(hold) &&
          this.rotations[hold.oldId]?.newId === id && (this.rotations[hold.oldId].trustNoticeId || null) === hold.receiptId)) {
      this.isolation.unknown = false;
      delete this.isolation.faults['@unknown']; delete this.isolation.notices['fault:@unknown'];
      this.isolationDirty = true;
    }
    const indexed = Object.entries(this.isolation.holds);
    for (const [id, hold] of indexed) {
      if (!validId(id)) { this.isolation.unknown = true; this.isolationDirty = true; continue; }
      const record = validId(hold?.oldId) && this.rotations[hold.oldId];
      if (!validTrustHold(hold) || !record || record.newId !== id || !movedSuccessor(record) ||
          (record.trustNoticeId || null) !== hold.receiptId) {
        this.faultTrustSuccessor(id, this.rotationRead.error ? 'rotation-store-unreadable' : 'record-invalid');
      } else if (Object.hasOwn(this.isolation.faults, id)) this.faultedRotations.add(hold.oldId);
      else if (cleanupComplete(record) && !trustRecoveryPending(record) && !failedHandoffPending(record) || record.handoffConfirmed === true &&
          ['handed', 'done', 'kept'].includes(record.phase) && validId(record.handoffTag) && validTime(record.handedAt)) {
        // A crash between the primary confirmation and its hold release is
        // recoverable only for this exact, still-valid saved identity pair.
        try { this.releaseTrustSuccessor(record); }
        catch { this.faultTrustSuccessor(id, 'release-unconfirmed'); }
      } else if (record.handoffConfirmed) this.faultTrustSuccessor(id, 'record-invalid');
    }
    for (const [oldId, record] of Object.entries(this.rejectedRotations)) {
      if (indexed.some(([, hold]) => hold?.oldId === oldId)) { this.faultedRotations.add(oldId); continue; }
      if (!trustRecord(record) && !movedSuccessor(record)) continue;
      // A rejected row's newId may itself be the damaged field. Without an
      // independent identity anchor, treating that hint as authoritative could
      // quarantine an innocent member and release the real successor.
      this.isolation.unknown = true; this.isolationDirty = true;
      this.faultedRotations.add(oldId);
    }
    // A shared-room read failure alone must not invent migration quarantine.
    // Existing availability and archive checks still apply independently.
    const migrationEvidence = Object.values(this.rotations).some(record => trustRecord(record) || movedSuccessor(record)) ||
      Object.values(this.rejectedRotations).some(record => trustRecord(record) || movedSuccessor(record)) ||
      Boolean(this.rotationRead.error && this.rotationRead.error !== 'missing');
    if (this.roomState.warning && migrationEvidence) {
      this.isolation.unknown = true; this.isolationDirty = true;
    }
    if (Object.keys(this.isolation.faults).some(id => id !== '@unknown' && !Object.hasOwn(this.isolation.holds, id))) {
      this.isolation.unknown = true; this.isolationDirty = true;
    }
    for (const [oldId, record] of Object.entries(this.rotations)) {
      if (this.faultedRotations.has(oldId)) {
        this.rejectedRotations = { ...this.rejectedRotations, [oldId]: record }; delete this.rotations[oldId]; continue;
      }
      try { this.holdTrustSuccessor(oldId, record); }
      catch { this.faultedRotations.add(oldId); this.isolation.unknown = true; this.isolationDirty = true; }
    }
    if (this.isolation.unknown) this.faultTrustSuccessor('@unknown', 'isolation-identity-unreadable');
    if (this.isolationDirty) {
      try { this.isolationWrite(); } catch { /* In-memory exclusion remains; no native authority is added. */ }
    }
  }
  trustAdmission() {
    return { heldSessions: new Set(Object.keys(this.isolation.holds)),
      blockedRotations: this.faultedRotations, quarantineUnknown: this.isolation.unknown };
  }
  async notifyTrustFaults() {
    let changed = false;
    for (const [id, fault] of Object.entries(this.isolation.faults)) {
      const key = `fault:${id}`;
      if (Object.hasOwn(this.isolation.notices, key) || this.faultNoticed.has(key)) continue;
      this.isolation.notices = { ...this.isolation.notices, [key]: true }; this.isolationDirty = true;
      // Saving first gives at most one attempt, not guaranteed delivery. If
      // saving is unavailable, still tell this running app once.
      try { this.isolationWrite(); } catch { /* Other spaces must keep working. */ }
      this.faultNoticed.add(key);
      changed = true;
      const hold = this.isolation.holds[id], known = validTrustHold(hold);
      const record = { oldId: known ? hold.oldId : 'NAW', newId: id, name: known ? hold.name : 'NAW', newName: known ? hold.newName : id };
      const outcome = id === '@unknown' ? 'trustStateUnknown' : 'trustStateInvalid';
      const spaces = known ? hold.roomIds : ['shared', ...this.roomState.spaces.rooms.map(room => room.id)];
      try { this.roomState.rotationEvent(spaces, outcome, this.label(record.oldId, record.name), this.label(id, record.newName), validTrustReceipt(fault?.receiptId) ? fault.receiptId : undefined); } catch { /* OS notice still gets its attempt. */ }
      try { await this.notify(outcome, record); } catch { /* Never re-arm a saved attempt. */ }
    }
    if (changed) try { await this.broadcast(); } catch { /* Keep the saved notice attempt and exclusion. */ }
  }
  async isolateTrustRecovery(oldId, record) {
    this.faultedRotations.add(oldId);
    if (validId(record?.newId) && record.newId !== oldId) {
      if (!Object.hasOwn(this.isolation.holds, record.newId)) {
        this.isolation.holds = { ...this.isolation.holds, [record.newId]: {
          oldId, receiptId: validTrustReceipt(record.trustNoticeId) ? record.trustNoticeId : null,
          roomIds: Array.isArray(record.roomIds) ? record.roomIds : [], name: record.name || oldId, newName: record.newName || record.newId } };
      }
      this.faultTrustSuccessor(record.newId, 'cleanup-failed');
    } else { this.isolation.unknown = true; this.faultTrustSuccessor('@unknown', 'isolation-identity-unreadable'); }
    this.isolationDirty = true;
    try { this.isolationWrite(); } catch { /* Memory still fences the affected record. */ }
    await this.notifyTrustFaults();
  }
  releaseTrustSuccessor(record) {
    const id = record.newId, hold = this.isolation.holds[id];
    if (!validTrustHold(hold) || Object.hasOwn(this.isolation.faults, id) || hold.receiptId !== (record.trustNoticeId || null)) return;
    const prior = this.isolation.holds, holds = { ...prior }; delete holds[id];
    this.isolation.holds = holds; this.isolationDirty = true;
    try { this.isolationWrite(); } catch (error) { this.isolation.holds = prior; throw error; }
  }

  // The append-only rotation record: every session id and native id involved.
  loadLog() {
    const entries = [];
    let text = '';
    try {
      text = fs.readFileSync(this.logFile, 'utf8');
    } catch {
      return entries;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (validLogEntry(entry)) {
          entries.push(entry);
        }
      } catch {
        // A damaged line is skipped; the rest of the record stays readable.
      }
    }
    return entries.slice(-1000);
  }

  appendLog(event, record, extra = {}) {
    const entry = {
      time: this.now(),
      event,
      spaces: record.roomIds || [],
      old: { id: record.oldId, nativeId: record.oldNativeId || null, name: record.name },
      new: null,
      ...extra,
    };
    if (record.newId) {
      entry.new = { id: record.newId, nativeId: record.newNativeId || null, name: record.newName || null };
    }
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      // The space record still carries the event when the private log cannot be written.
    }
    this.log.push(entry);
    if (this.log.length > 1000) {
      this.log.shift();
    }
    this.chainsCache = null;
    return entry;
  }

  rotationEntries() {
    return this.log.slice();
  }

  // Built once per log change: windows read it on every state event.
  // Old sessions that already handed their work to a successor (done or kept), from the log, each with the
  // successors it handed to (carriedOn).
  handedOff() {
    const ids = new Map();
    for (const entry of this.log) {
      if (['done', 'kept'].includes(entry.event) && entry.old && entry.old.id) {
        if (!ids.has(entry.old.id)) {
          ids.set(entry.old.id, new Set());
        }
        if (entry.new && validId(entry.new.id || '')) {
          ids.get(entry.old.id).add(entry.new.id);
        }
      }
    }
    return ids;
  }

  // A rotation the person interrupted waits for the quiet that member's rotation already needs (30 minutes; 10 for
  // memory; 2 for the butler's compaction), counted from the later of the interruption and the person's own last use
  // (noteHuman), so a queued item does not ask again while the person is still at it (the 11-14 drill, finding 1). Not
  // the session's last activity: NAW's own items kept a busy member fresh and it was never rotated (the NAW dev PM, 11-23).
  personDeferred(sessions, butler, now) {
    const ids = new Set();
    for (const [id, entry] of this.deferredAt) {
      const session = sessions.find(s => s.id === id);
      let quiet = this.quietMs;
      if (entry.due === 'memory') {
        quiet = QUIET_MEMORY_MS;
      } else if (entry.due === 'compact' && id === butler) {
        quiet = this.quietCompactMs;
      }
      const last = Math.max(entry.at, this.humanAt.get(id) ?? entry.at);
      if (session && now - last < quiet) {
        ids.add(id);
      } else {
        this.deferredAt.delete(id);
      }
    }
    return ids;
  }

  waitingModel(now) {
    const ids = new Set();
    for (const [id, at] of this.unknownModelAt) {
      if (now - at < UNKNOWN_MODEL_RETRY_MS) {
        ids.add(id);
      } else {
        this.unknownModelAt.delete(id);
      }
    }
    return ids;
  }

  // The sessions `id` continued from through done rotations, nearest first. A kept session goes on as itself.
  continuedFrom(id) {
    const ids = [], seen = new Set([id]);
    for (let at = id; ;) {
      const entry = this.log.findLast(e => e.event === 'done' && e.new?.id === at && typeof e.old?.id === 'string');
      if (!entry || seen.has(entry.old.id)) return ids;
      seen.add(entry.old.id); ids.push(entry.old.id); at = entry.old.id;
    }
  }

  rotationChains() {
    if (!this.chainsCache) {
      try {
        this.chainsCache = rotationChains(this.log);
      } catch {
        this.chainsCache = [];
      }
    }
    return this.chainsCache;
  }

  // Space record text: names with the short ids that make the chain searchable.
  label(id, name) {
    return `${name}（${shortId(id)}）`;
  }

  // The archive the person uses from the sidebar (keeps every record, undone from 归档), in its automatic form,
  // which refuses a session still in a space. Tidiness only: a failure leaves it where it was. An archive that
  // finishes after the wait gave up is recorded then (`late`), so a restore is never undone at a later start.
  // Resolves true (archived here), 'already' (archived by someone else: settle it quietly) or false.
  async archiveOld(id, label, late) {
    // Archived already (by the person, meanwhile): not NAW's to announce, but settled so a restore stays.
    if ((this.roomState.value.archivedSessions || []).includes(id)) {
      return 'already';
    }
    let waited = false;
    const archived = this.roomState.archiveSession(this.client, id, label, { automatic: true })
      .then(() => (this.roomState.value.archivedSessions || []).includes(id), () => false);
    archived.then(done => {
      if (done && waited && !this.closed) {
        try {
          late();
        } catch {
          // The archive stands; only its late line was not written.
        }
      }
    });
    try {
      return await withTimeout(archived, CALL_TIMEOUT_MS, 'archive-timeout');
    } catch {
      waited = true;
      return false;
    }
  }

  // The log line that settles an archive for good, and the line in its spaces. One someone else made is
  // settled quietly (`by: 'other'`): no line in the spaces, which would claim NAW archived it.
  recordArchive(entry, oldLabel, newLabel, other = false) {
    this.appendLog('archived', { roomIds: entry.spaces, oldId: entry.old.id, oldNativeId: entry.old.nativeId, name: entry.old.name,
      newId: entry.new.id, newNativeId: entry.new.nativeId, newName: entry.new.name }, other ? { by: 'other' } : {});
    if (!other) {
      this.roomState.rotationEvent(entry.spaces, 'archived', oldLabel, newLabel);
    }
  }

  // Old sessions rotated before NAW archived them (or whose archive did not happen then), once each:
  // only one that is still ended, in no space, unchanged by the person since its rotation, with its
  // successor still there. Its archive is logged, so one the person restores is never archived again.
  async archiveHandedOff(snapshot) {
    const sessions = new Map(snapshot.sessions.map(session => [session.id, session]));
    const settled = new Set();
    let archived = 0;
    for (const entry of this.log) {
      if (entry.event === 'archived') {
        settled.add(entry.old.id);
      }
    }
    // A person's row with no time cannot be placed before the rotation: it counts as use.
    const usedSince = (session, time) => (session.messages || []).some(m =>
      (m.role === 'user' || m.role === 'human' || m.origin === 'human') && !(Number(m.time) <= time));
    for (const entry of this.log) {
      if (this.closed || entry.event !== 'done' || !entry.new || settled.has(entry.old.id)) {
        continue;
      }
      const old = sessions.get(entry.old.id);
      if (old && old.archived) {
        // Archived by someone else since: settled quietly, so a later restore stays.
        settled.add(old.id);
        this.recordArchive(entry, '', '', true);
        continue;
      }
      if (!old || old.state !== 'ended' || roomIds(old).length || !sessions.has(entry.new.id) ||
          (entry.old.nativeId && old.nativeId !== entry.old.nativeId) || usedSince(old, entry.time)) {
        continue;
      }
      settled.add(old.id);
      const oldLabel = this.label(old.id, entry.old.name), newLabel = this.label(entry.new.id, entry.new.name || entry.old.name);
      const result = await this.archiveOld(old.id, oldLabel, () => this.recordArchive(entry, oldLabel, newLabel));
      if (result === true) {
        archived += 1;
      }
      if (result) {
        this.recordArchive(entry, oldLabel, newLabel, result === 'already');
      }
    }
    return archived;
  }

  save() {
    for (const [oldId, record] of Object.entries(this.rotations)) {
      if (!this.faultedRotations.has(oldId)) this.holdTrustSuccessor(oldId, record);
    }
    if (this.isolationDirty) {
      try { this.isolationWrite(); }
      catch (error) {
        // An unpersisted new hold must stop that trust operation before native
        // side effects. An old fault's unavailable notice/index write must not
        // stop an unrelated same-directory rotation from saving its own step.
        const unanchored = Object.entries(this.rotations).some(([oldId, record]) =>
          !this.faultedRotations.has(oldId) && movedSuccessor(record) && !record.handoffConfirmed && !cleanupComplete(record) &&
          JSON.stringify(this.isolation.holds[record.newId]) !== JSON.stringify(this.persistedTrustHolds[record.newId]));
        if (unanchored) throw error;
      }
    }
    // Keep unreadable bytes (or the unsafe link itself) for recovery before
    // replacing the primary store. Never follow a symlink or clobber a writer.
    if (this.rotationRead.error && this.rotationRead.error !== 'missing') {
      const current = fs.lstatSync(this.file), prior = this.rotationRead.identity;
      if (!prior || ['dev', 'ino', 'size', 'mtimeMs', 'uid'].some(key => current[key] !== prior[key]) ||
          process.getuid && current.uid !== process.getuid()) throw Error('Rotation store changed during recovery');
      fs.renameSync(this.file, `${this.file}.unreadable.${randomUUID()}`);
      this.rotationRead.error = null;
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, rotations: this.rotations,
      ...(Object.keys(this.rejectedRotations).length ? { quarantinedRotations: this.rejectedRotations } : {}) }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  async start() {
    await this.notifyTrustFaults();
    this.timer = setInterval(() => this.schedule(), this.tickMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
    await this.schedule();
    return this;
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.listen(null);
    this.dropOwnClient();
  }

  // The person's own input, takeover or view of a session (main.cjs IPC).
  noteHuman(sessionId) {
    if (typeof sessionId === 'string' && sessionId) {
      this.humanAt.set(sessionId, this.now());
      this.vacancySince.delete(sessionId); this.vacancyIdentity.delete(sessionId);
      this.dirty = true;
    }
  }

  listen(client) {
    if (this.listening === client) {
      return;
    }
    this.vacancySince.clear(); this.vacancyIdentity.clear();
    if (this.listening && this.listening.off) {
      this.listening.off('state', this.onState);
    }
    this.listening = client;
    if (client && client.on) {
      client.on('state', this.onState);
    }
  }

  dropOwnClient() {
    if (this.own) {
      if (this.listening === this.own) {
        this.listen(null);
      }
      this.own.close();
      this.own = null;
    }
  }

  // Passes never overlap: a request during a pass runs one more pass after it.
  schedule() {
    if (this.closed) {
      return this.pending || Promise.resolve();
    }
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    // A pass an agent's call asked for (queueAdd, queueClaim): run in that call's scope, each item it sent carried the
    // agent, so the input read as the agent's and its reply settled 'input-purpose-unconfirmed' (加项 3, 2026-11-23).
    this.pending = detached(() => this.loop());
    return this.pending;
  }

  async loop() {
    try {
      do {
        this.again = false;
        try {
          await this.tick();
        } catch {
          // A failed pass leaves records as they were; the next pass reads fresh state.
          this.stewardWake?.skip('source-unavailable');
        }
      } while (this.again && !this.closed);
    } finally {
      this.pending = null;
    }
  }

  // Kept records rest for a day and failed ones for a week, then the member may rotate again.
  pruneRotations(now) {
    let changed = false;
    for (const id of Object.keys(this.rotations)) {
      const record = this.rotations[id];
      const keptOver = record.phase === 'kept' && now - (record.keptAt || 0) > ROTATE_AFTER_MS;
      const failedOver = record.phase === 'failed' && now - (record.failedAt || 0) > FAILED_ROTATION_KEEP_MS && !trustRecoveryPending(record) && !failedHandoffPending(record);
      if (keptOver || failedOver) {
        delete this.rotations[id];
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  activeRotations() {
    const ids = [];
    for (const id of Object.keys(this.rotations)) {
      if (this.rotations[id] && !this.faultedRotations.has(id) && !RESTING_PHASES.includes(this.rotations[id].phase) && this.rotations[id].phase !== 'waiting-provider') {
        ids.push(id);
      }
    }
    return ids;
  }

  // Metadata only, no session state: is there anything to send, settle or rotate?
  hasOpenWork() {
    if (this.activeRotations().length || Object.entries(this.rotations).some(([id, record]) => !this.faultedRotations.has(id) && (trustRecoveryPending(record) || failedHandoffPending(record)))) {
      return true;
    }
    // Integration work that can move without the person keeps the passes going: a space record
    // that changed since it was last looked through, a handoff awaiting its answer, a delivery
    // for a designated integrator, a record or notice still owed.
    if (this.integration && this.integration.hasWork(this.integrationRooms())) {
      return true;
    }
    // Keep observing while enabled: the next queue event may not exist yet.
    if (this.stewardWake && this.stewardWake.active()) {
      return true;
    }
    // An agent owed the person's answers: passes go on until it is told.
    if (this.answerNotices && this.answerNotices.waiting()) {
      return true;
    }
    if (this.versionNotices && this.versionNotices.waiting()) {
      return true;
    }
    const rooms = [this.roomState.value];
    for (const room of this.roomState.spaces.rooms) {
      rooms.push(room);
    }
    for (const room of rooms) {
      if (room.archived || !Array.isArray(room.queue)) {
        continue;
      }
      for (const item of room.queue) {
        // A handled decision whose answer's reply is still to be read (answerTag) keeps the passes going.
        if (OPEN_STATUSES.includes(item.status) || item.answerTag) {
          return true;
        }
      }
    }
    return false;
  }

  async source() {
    const windowClient = this.clients();
    if (windowClient) {
      this.dropOwnClient();
      return windowClient;
    }
    if (!this.own) {
      this.own = await withTimeout(this.connect(this.owner), CALL_TIMEOUT_MS, 'connect-timeout');
      this.dirty = true;
    }
    return this.own;
  }

  // An answer owed to an agent may go once its hold and the person's short quiet in that session have both ended (the
  // agent settling is settlingSoon's): a pass then, not at the next full one.
  answerSoon(now) {
    if (!this.answerNotices) return false;
    if (this.answerNotices.endingSoon(now, this.tickMs * 2)) return true;
    const quietMs = Math.min(this.humanQuietMs, ANSWER_QUIET_MS);
    return this.answerNotices.due(now).some(({ sessionId }) => {
      const end = this.humanAt.get(sessionId) + quietMs;
      return Number.isFinite(end) && now >= end && now - end <= this.tickMs * 2;
    });
  }

  // Someone just became idle or stopped typing: their time arrives without a new state event.
  settlingSoon(now) {
    for (const since of this.idleSince.values()) {
      if (now - since <= this.settleMs + this.tickMs * 2) {
        return true;
      }
    }
    for (const at of this.humanAt.values()) {
      const end = at + this.humanQuietMs;
      if (now <= end + this.tickMs * 2 && now >= end - this.tickMs) {
        return true;
      }
    }
    return false;
  }

  view() {
    const snapshot = this.roomState.apply(this.client.snapshot());
    if (this.observePersonActions) this.observePersonActions(snapshot);
    const now = this.now();
    // Copies (room-state.cjs apply): marking them changes nothing a backend holds.
    const quiet = this.quietWindows ? this.quietWindows.sessionIds(now) : null;
    if (quiet && quiet.size) for (const session of snapshot.sessions) if (quiet.has(session.id)) session.quietWindow = quiet.get(session.id);
    for (const session of snapshot.sessions) {
      // A live control needs an idle clock; this does not grant delivery readiness.
      const ownRequest = this.rotations[session.id];
      const timingSession = ownRequest?.phase === 'requested' && ownRequest.episodeEpoch &&
        ['open', 'complete'].includes(session.rotationEpisode?.state) && session.rotationEpisode.nativeId === session.nativeId &&
        session.rotationEpisode.epoch === ownRequest.episodeEpoch
        ? { ...session, rotationEpisode: null } : session;
      if (sessionReady(timingSession, snapshot.wakePolicy).ready) {
        if (!this.idleSince.has(session.id)) {
          this.idleSince.set(session.id, now);
        }
      } else {
        this.idleSince.delete(session.id);
      }
    }
    if (this.observeQueueState) this.observeVacancyReadiness(snapshot, now);
    return { snapshot, now };
  }

  observeVacancyReadiness(snapshot, now) {
    if (!Array.isArray(snapshot?.sessions)) {
      this.vacancySince.clear(); this.vacancyIdentity.clear(); return;
    }
    const observed = new Set();
    for (const session of snapshot.sessions) {
      if (!session || typeof session.id !== 'string') continue;
      observed.add(session.id);
      let identity;
      try {
        if (this.roomState.value.archivedSessions?.includes(session.id) ||
            !sessionReady(session, snapshot.wakePolicy).ready || humanRecent(session.id, this.humanAt, now, this.humanQuietMs)) {
          this.vacancySince.delete(session.id); this.vacancyIdentity.delete(session.id); continue;
        }
        identity = JSON.stringify([session.nativeId, session.provider, session.connectionRevision || 0,
          session.controlRevision || 0, roomIds(session).sort()]);
      } catch { this.vacancySince.delete(session.id); this.vacancyIdentity.delete(session.id); continue; }
      if (this.vacancyIdentity.get(session.id) !== identity) {
        this.vacancyIdentity.set(session.id, identity); this.vacancySince.set(session.id, now);
      }
    }
    for (const id of this.vacancySince.keys()) if (!observed.has(id)) {
      this.vacancySince.delete(id); this.vacancyIdentity.delete(id);
    }
  }

  name(session) {
    const label = this.labels.get(session.id);
    if (typeof label === 'string' && label) {
      return label;
    }
    return session.name || session.id;
  }

  // Compactions counted so far per member; without a counter or a readable record, none.
  async compactionCounts(snapshot, steward, handedOff, now) {
    if (!this.compactions) return new Map();
    try {
      const subjects = rotationSubjects(snapshot.rooms, snapshot.sessions, steward ? [steward.sessionId] : [], handedOff);
      const counts = await this.compactions.sample(subjects, now);
      return counts instanceof Map ? counts : new Map();
    } catch {
      return new Map();
    }
  }

  // Session memory footprints and macOS memory pressure, sampled at most twice a minute.
  async memory(sessions, now) {
    if (this.memorySample && now - this.memorySample.at < MEMORY_SAMPLE_MS) {
      return this.memorySample;
    }
    let memory = new Map();
    let limit = this.memoryLimit;
    try {
      memory = processMemory(sessions, await this.sampleProcesses());
      if (memoryPressure(await this.samplePressure())) {
        limit = this.pressureLimit;
      }
    } catch {
      // Without a sample only the age rule applies this time.
    }
    this.memorySample = { at: now, memory, limit };
    return this.memorySample;
  }

  async tick() {
    this.pruneRotations(this.now());
    const now = this.now();
    if (!this.hasOpenWork()) {
      // No queued work: still check quiet space members for rotation once a minute, through a window only.
      const windowClient = this.clients();
      if (!windowClient && this.observePersonActions) {
        this.client = await this.source();
        this.listen(this.client);
        const snapshot = this.client.snapshot();
        if (this.observePersonActions) this.observePersonActions(snapshot);
        this.idleSince.clear();
        return;
      }
      this.dropOwnClient();
      const watching = Boolean(windowClient);
      if (!watching || now - this.lastMaintenance < MAINTENANCE_MS) {
        if (!watching) {
          this.listen(null);
        }
        // Idle times seen by the minute check go stale until the next one; queued work starts fresh.
        this.idleSince.clear();
        this.dirty = true;
        return;
      }
      this.lastMaintenance = now;
      this.client = windowClient;
    } else {
      this.client = await this.source();
    }
    this.listen(this.client);
    const rotating = this.activeRotations().length > 0;
    const recoveringTrust = Object.entries(this.rotations).some(([id, record]) => !this.faultedRotations.has(id) && (trustRecoveryPending(record) || failedHandoffPending(record)));
    const due = this.dirty || rotating || recoveringTrust || now - this.lastFullPass >= FULL_PASS_MS || this.settlingSoon(now) || now === this.lastMaintenance ||
      this.answerSoon(now);
    if (!due) {
      return;
    }
    this.dirty = false;
    this.lastFullPass = now;
    let current = this.view();
    if (!this.handedOffArchived) {
      this.handedOffArchived = true;
      // Read again only when something changed: an ordinary pass adds no snapshot read.
      if (await this.archiveHandedOff(current.snapshot)) {
        current = this.view();
      }
    }
    if (rotating || recoveringTrust || Object.values(this.rotations).some(record => record.phase === 'waiting-provider')) {
      await this.advanceRotations(current.snapshot, current.now);
      current = this.view();
    }
    if (await this.finishDeferrals(current.snapshot, current.now)) current = this.view();
    const sample = await this.memory(current.snapshot.sessions, current.now);
    const steward = this.stewardOutside(current.snapshot.sessions);
    const unmatched = steward ? null : this.stewardUnmatched(current.snapshot.sessions);
    const handedOff = this.handedOff();
    const compactions = await this.compactionCounts(current.snapshot, steward || (unmatched && { sessionId: unmatched }), handedOff, current.now);
    // B6: the session that holds an open handoff gets no queue work and is not rotated, so what
    // it writes until the handoff is closed is not a member's reply; it is not listed as vacant either.
    const butler = this.stewardSession(current.snapshot.sessions)?.steward.sessionId;
    const waits = new Map(), quietPending = new Map(), rotationGates = new Map();
    const engaged = this.integration ? this.integration.holding() : undefined;
    const actions = planDispatch({
      waits,
      quietPending,
      rotationGates,
      unmatched: unmatched ? [unmatched] : [],
      rooms: current.snapshot.rooms,
      sessions: current.snapshot.sessions,
      wakePolicy: current.snapshot.wakePolicy,
      idleSince: this.idleSince,
      humanAt: this.humanAt,
      now: current.now,
      settleMs: this.settleMs,
      humanQuietMs: this.humanQuietMs,
      contentLimits: this.contentLimits,
      handedOff,
      waitingModel: this.waitingModel(current.now),
      deferredRotations: this.personDeferred(current.snapshot.sessions, butler, current.now),
      quietMs: this.quietMs,
      compactions,
      compactLimit: this.compactLimit,
      quietCompactMs: this.quietCompactMs,
      memory: sample.memory,
      memoryLimit: sample.limit,
      memoryMinAgeMs: this.memoryMinAgeMs,
      rotations: Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id))),
      ...this.trustAdmission(),
      engaged,
      outside: steward ? [steward.sessionId] : [],
      butler,
    });
    for (const action of actions) {
      if (this.closed) {
        return;
      }
      if (action.kind === 'settle') {
        this.settle(action, current.snapshot);
      } else if (action.kind === 'answered') {
        this.answered(action);
      } else if (action.kind === 'dispatch') {
        await this.dispatch(action, waits);
      } else if (action.kind === 'rotate') {
        await this.requestHandoff(action, sample.memory.get(action.sessionId), current.snapshot);
      }
    }
    this.noteRotationStalls(rotationGates, current.snapshot.sessions, current.now);
    // In memory only: the person and the butler read why each queued item is still waiting (queue item 5614a65c).
    if (this.roomState.setQueueWaits(waits)) this.broadcast().catch(() => {});
    if (this.observeQueueState) await this.observeQueueState(queueVacancies({ ...current.snapshot,
      idleSince: this.vacancySince, humanAt: this.humanAt, now: current.now,
      settleMs: this.settleMs, humanQuietMs: this.humanQuietMs,
      rotations: Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id))),
      actions, engaged, handedOff, ...this.trustAdmission() }));
    if (this.integration && !this.closed) await this.integrate();
    if (this.stewardWake && !this.closed) await this.wakeSteward(current, engaged, quietPending);
    if ((this.answerNotices || this.versionNotices) && !this.closed) await this.notifyAnswers(current, engaged);
  }

  // The designated butler, woken when NAW has recorded something new (steward-wake.cjs keeps the switch, the position,
  // the minute between wakes and the line in its record). Here, condition 2: only the butler outside every space, in no
  // rotation and holding no handoff, ready and settled as a member is before its next item and not just used by the
  // person; then the same send as a queue item, a NAW message under the person's automatic-message switch. `holding` is
  // what the pass asked the integration engine before anything was sent (asked once a pass); a handoff given since then
  // left the butler at work, which the fresh read below sees.
  // With no event waiting, a patrol (steward-wake.cjs patrol) goes through the same checks once the butler has been
  // idle for its interval while work is unfinished; an event goes first.
  // `quietPending`: what the plan found short only of its quiet. A wake then would restart the butler's 2 quiet minutes
  // before its compaction rotation, so it waits for the rotation, which the successor's wake follows.
  async wakeSteward(current, holding, quietPending) {
    try {
      // The butler's own handoff holds every wake, the patrol's included, until the person's step.
      const own = this.ownHandoffStep(current.snapshot.sessions);
      if (own) return this.stewardWake.hold('rotation-control-unresolved', own);
      this.stewardWake.endHold();
      const event = this.stewardWake.due(), work = event ? null : this.openWork(current);
      const minutes = work ? this.stewardWake.patrolDue(work.idleMs, work) : null;
      if (!event && minutes === null) { this.stewardWake.clearBlocked(); return; }
      const steward = this.stewardOutside(current.snapshot.sessions);
      const skip = reason => this.stewardWake.skip(reason, reason === 'quiet-window' ? this.quietWindows?.windowOf(steward.sessionId, current.now)?.deadline : undefined);
      if (!steward) return skip(this.stewardSession(current.snapshot.sessions) ? 'in-space' : 'identity-unavailable');
      if (!settled(steward.sessionId, this.idleSince, current.now, this.settleMs)) return skip(heldReason(current.snapshot.sessions.find(s => s.id === steward.sessionId), current.snapshot.wakePolicy) || 'not-settled');
      const rotations = Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id)));
      if (engagedSessions(rotations, current.snapshot.rooms).has(steward.sessionId) || Array.isArray(holding) && holding.includes(steward.sessionId)) return skip('engaged');
      if (quietPending?.get(steward.sessionId) === 'compact') return skip('engaged');
      const why = {}, fresh = await this.freshReady(steward.sessionId, this.humanQuietMs, why);
      if (!fresh) return skip(why.reason || 'state-unavailable');
      if (this.stewardOutside(fresh.snapshot.sessions)?.sessionId !== steward.sessionId || fresh.session.nativeId !== steward.nativeId) return skip('identity-changed');
      // Condition 4 needs the model: as the session reports it, or for Claude as its own transcript last recorded it.
      const model = reportedModel(fresh.session) || transcriptModel(fresh.session, this.transcriptRoot);
      const send = (text, itemId) => this.send(fresh.session, text, itemId);
      if (event) await this.stewardWake.wake(fresh.session, model, send);
      else await this.stewardWake.patrol(fresh.session, model, send, work, minutes);
    } catch (error) {
      // Nothing was sent, or the wake kept its own outcome: the next pass looks again.
      this.stewardWake.skip(error?.code === 'STEWARD_WAKE_RECORD_UNAVAILABLE' ? 'record-unavailable' : 'source-unavailable');
    }
  }

  // The work a patrol counts: sessions not archived that are running or awaiting approval, and items queued or sent in
  // any space not archived (waiting on the person does not count); a hash over their ids and states only; and how long
  // the butler has been idle. Counts and the hash leave this function, no name or text.
  openWork(current) {
    const butler = this.stewardSession(current.snapshot.sessions)?.session?.id ?? null, parts = [];
    let sessions = 0, items = 0;
    for (const s of current.snapshot.sessions || []) {
      if (!s || s.archived || s.id === butler) continue;
      if (['working', 'approval', 'background'].includes(s.state) || s.approval || s.nativeApproval) { sessions++; parts.push(`s\t${s.id}\t${s.state}\t${s.approval || s.nativeApproval ? 1 : 0}`); }
    }
    for (const room of [this.roomState.value, ...this.roomState.spaces.rooms]) {
      if (!room || room.archived || !Array.isArray(room.queue)) continue;
      for (const item of room.queue) if (['queued', 'sent'].includes(item.status)) { items++; parts.push(`i\t${item.id}\t${item.status}`); }
    }
    const since = butler === null ? undefined : this.idleSince.get(butler);
    return { sessions, items, hash: createHash('sha256').update(parts.sort().join('\n')).digest('hex'),
      idleMs: Number.isFinite(since) ? current.now - since : NaN };
  }

  // The person's answers on an agent's confirmation cards, told to that agent (answer-notices.cjs). One message for
  // everything it is owed, once the answers stopped coming for a moment and the agent is ready and settled as a member
  // is before its next queue item, the person has not typed into it for ANSWER_QUIET_MS (not the two minutes queue work
  // waits: the person who sent a task and then answered the card wants the agent to go on), and it is in no rotation and
  // holding no handoff; then the same send as a queue item, a NAW message under the person's automatic-message switch.
  // An agent at work hears it after its turn: it is not ready until then.
  async notifyAnswers(current, holding) {
    if (this.answerNotices) await this.notifyOwed(this.answerNotices, told => noticeText(told), 'answer-notice', Math.min(this.humanQuietMs, ANSWER_QUIET_MS), current, holding);
    // The version a restart brought and the backends still on an old one, owed to the queue secretary
    // (version-events.cjs): the same send, after the two minutes queue work waits for the person.
    if (this.versionNotices && !this.closed) await this.notifyOwed(this.versionNotices, told => this.versionNotices.text(told), 'version-notice', this.humanQuietMs, current, holding);
  }

  async notifyOwed(notices, text, kind, quietMs, current, holding) {
    try { notices.prune(current.snapshot.sessions, current.now); } catch { return; }
    const due = notices.due(current.now);
    if (!due.length) return;
    const rotations = Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id)));
    // A queue item still running keeps its member out until its reply is settled; a member whose item waits for the
    // person to decide is idle and hears the answer like any agent (its item stays waiting for the person). Read as the
    // record is after this pass settled and sent its items (passes never overlap; only a pass sends an item).
    const recorded = this.view().snapshot.rooms;
    const rooms = (Array.isArray(recorded) ? recorded : []).map(room => ({ ...room, queue: (room?.queue || []).filter(item => item?.status === 'sent') }));
    const engaged = engagedSessions(rotations, rooms);
    for (const target of due) {
      if (this.closed) return;
      try {
        const session = current.snapshot.sessions.find(s => s.id === target.sessionId);
        if (!session || session.nativeId !== target.nativeId || !settled(session.id, this.idleSince, current.now, this.settleMs)) continue;
        if (engaged.has(session.id) || Array.isArray(holding) && holding.includes(session.id)) continue;
        const fresh = await this.freshReady(session.id, quietMs);
        if (!fresh || fresh.session.nativeId !== target.nativeId) continue;
        // Read after the wait: a receipt the agent read meanwhile is not told.
        const told = notices.take(target);
        if (!told.length) continue;
        try {
          await this.send(fresh.session, text(told), `${kind}:${randomUUID()}`);
          notices.sent(target, told);
        } catch { notices.failed(target); }
      } catch {
        // Nothing was sent: the next pass looks again.
      }
    }
  }

  // What the integration engine is shown: the sessions as the dispatcher sees them, with its own
  // idle and typing clocks. A session list cannot say by itself that it is complete (a backend
  // may be away for a moment), so a session that is missing from it counts as gone only after it
  // has been missing from every pass for a while. A session that is in the list is the record's
  // to judge (archived, or another native session under that id).
  integrationView(current) {
    const sessions = current.snapshot.sessions, now = current.now;
    const present = new Set(sessions.map(session => session.id));
    for (const id of this.integratorAbsent.keys()) if (present.has(id)) this.integratorAbsent.delete(id);
    const engaged = engagedSessions(this.rotations, current.snapshot.rooms);
    return { sessions, wakePolicy: current.snapshot.wakePolicy, now, idleSince: this.idleSince, humanAt: this.humanAt,
      settleMs: this.settleMs, humanQuietMs: this.humanQuietMs, review: 'off', busy: sessionId => engaged.has(sessionId),
      complete: sessionId => {
        if (typeof sessionId !== 'string') return false;
        if (present.has(sessionId)) return true;
        if (!this.integratorAbsent.has(sessionId)) this.integratorAbsent.set(sessionId, now);
        return now - this.integratorAbsent.get(sessionId) >= INTEGRATOR_ABSENT_MS;
      } };
  }

  // B6: one pass of the integration engine. The engine decides and records; the dispatcher gives
  // it the spaces' records as they are now (a delivery recorded earlier in this pass is in them),
  // its view, and a fresh look. A pass that fails keeps what its earlier steps recorded; the next
  // pass goes on from there. The failure is kept and the person is told once per run.
  integrationRooms() {
    return [{ ...this.roomState.value, id: 'shared' }, ...this.roomState.spaces.rooms];
  }

  // A fault of the engine: kept, and told to the person once per kind of fault while the app runs.
  integrationFault(error) {
    const message = String(error?.message || error).slice(0, 300);
    this.integrationError = { message, at: this.now(), count: (this.integrationError?.count || 0) + 1 };
    if (!this.integrationTold.has(message) && this.integrationTold.size < 20) {
      this.integrationTold.add(message);
      try { this.integrationFailed(error); } catch { /* The notice is best effort. */ }
    }
  }

  async integrate() {
    // Everything here is guarded, also what is done with the pass's result: a result that cannot
    // be read is a fault like a pass that throws, not something the queue's loop swallows.
    try {
      const rooms = this.integrationRooms();
      const look = async () => {
        await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
        return this.integrationView(this.view());
      };
      const result = await this.integration.pass(rooms, this.integrationView(this.view()), look);
      if (result.kind === 'unreadable') {
        // Told once per run; nothing is taken in or handed out until the person has looked at the record.
        if (!this.integrationWarned) {
          this.integrationWarned = true;
          try { this.integrationUnreadable(); } catch { /* The warning is best effort. */ }
        }
      }
      if (integrationChanged(result)) this.broadcast().catch(() => {});
      // The step went through: a fault kept from before stays readable, marked as over.
      if (this.integrationError && !this.integrationError.recoveredAt) this.integrationError.recoveredAt = this.now();
    } catch (error) {
      // A pass that faulted after it had changed something a window shows: the windows are told all the same.
      if (error?.done) { try { if (integrationChanged(error.done)) this.broadcast().catch(() => {}); } catch { /* The fault below is what is kept. */ } }
      this.integrationFault(error);
    }
  }

  // Whether the item is still out with its member: the person or the butler may have marked it handled since
  // (room-state.cjs queueResolve), and then nothing NAW learns later changes it (11-12, item 2829a073).
  stillSent(roomId, itemId) {
    return this.roomState.queueFind(roomId, itemId).status === 'sent';
  }

  // What the session wrote after the person's answer from the card, added to that handled decision (room-state.cjs
  // queueAnswered). A space that cannot be written just now keeps the mark for a later pass.
  answered(action) {
    try {
      if (this.roomState.queueAnswered(action.roomId, action.itemId, action.tag, action.reply || '', action.ready)) {
        this.broadcast().catch(() => {});
      }
    } catch { /* The mark stays. */ }
  }

  settle(action, snapshot) {
    if (!this.stillSent(action.roomId, action.itemId)) {
      return;
    }
    const session = snapshot.sessions.find(s => s.id === action.sessionId);
    let name = action.sessionId;
    if (session) {
      name = this.name(session);
    }
    const noReply = action.status === 'waiting' && action.reason === 'no-reply';
    let current;
    if (noReply) {
      try { current = this.client.snapshot().sessions.find(s => s.id === action.sessionId); }
      catch { /* An unreadable current cause stays unconfirmed. */ }
    }
    const report = noReply ? [action.reportTitle, current] :
      action.reportTitle === undefined ? [] : [action.reportTitle];
    this.roomState.queueSettle(action.roomId, action.itemId, action.status, action.reason || '', name, action.reply || '', action.question, action.ready, ...report);
    this.broadcast().catch(() => {});
  }

  // The designated butler when it is this very native session, in a space or not; anything else names nobody.
  stewardSession(sessions) {
    let steward = null;
    try {
      steward = this.steward();
    } catch {
      return null;
    }
    const session = steward && validId(steward.sessionId) && sessions.find(s => s.id === steward.sessionId);
    if (!session || !validId(steward.nativeId) || session.nativeId !== steward.nativeId) {
      return null;
    }
    return { steward, session };
  }

  // The step the person can take when the designated butler, in no space, is held by its own rotation episode left
  // invalid: the backend refuses every dispatch send to it (workspace.cjs send) until the person discards that handoff
  // (renderer.js rotationReleaseAction), on a backend before alpha.284 after updating it (releaseRotation). Null otherwise.
  ownHandoffStep(sessions) {
    const steward = this.stewardOutside(sessions), session = steward && sessions.find(s => s.id === steward.sessionId);
    if (!session || session.archived || rotationEpoch(session) === null || session.rotationEpisode.state !== 'invalid') return null;
    let version = session.runtimeVersion;
    try { version = this.client?.route(session.id)?.state?.runtimeVersion ?? version; } catch { /* The session's own field. */ }
    return releaseBackendOutdated(version) ? 'update-backend' : 'release';
  }

  // The session the designation names, in no space, when the designation no longer matches its native session
  // (stewardSession): nothing wakes or rotates it as the butler. Named only for noteRotationStalls.
  stewardUnmatched(sessions) {
    if (this.stewardSession(sessions)) return null;
    let steward = null;
    try {
      steward = this.steward();
    } catch {
      return null;
    }
    const session = steward && validId(steward.sessionId) && sessions.find(s => s.id === steward.sessionId);
    try {
      return session && !session.archived && !roomIds(session).length ? session.id : null;
    } catch {
      return null;
    }
  }

  // Sessions a pass found due for rotation and left as they were (planDispatch rotationGates), an hour or more since
  // this run first found each so: one line to the butler's record per stall and gate, again only when the gate
  // changes (the person, 2026-11-23: 「而且以后咋办」). Only told: nothing here rotates or relaxes a gate.
  noteRotationStalls(gates, sessions, now) {
    for (const id of [...this.stalls.keys()]) {
      if (!gates.has(id)) this.stalls.delete(id);
    }
    for (const [id, { gate, reason }] of gates) {
      const nativeId = sessions.find(s => s.id === id)?.nativeId ?? null;
      let stall = this.stalls.get(id);
      if (!stall || stall.nativeId !== nativeId) {
        stall = { since: now, nativeId, told: new Set() };
        this.stalls.set(id, stall);
      }
      const key = `${reason}:${gate}`;
      if (!this.rotationStalled || now - stall.since < ROTATION_STALL_MS || stall.told.has(key)) continue;
      try {
        this.rotationStalled({ memberId: id, nativeId, reason, gate, since: stall.since });
        stall.told.add(key);
      } catch { /* Tried again on the next pass; nothing else waits on it. */ }
    }
  }

  // The designated butler when it is this very native session and in no space; anything else names nobody.
  stewardOutside(sessions) {
    const found = this.stewardSession(sessions);
    if (!found) return null;
    try {
      return roomIds(found.session).length ? null : found.steward;
    } catch {
      return null;
    }
  }

  // The duty statement handed on to the session replacing the butler: only while the old session still holds the
  // designation (the person may have revoked or moved it since the handoff was asked for).
  stewardDuty(oldId, record) {
    let steward = null;
    try {
      steward = this.steward();
    } catch {
      return '';
    }
    if (!steward || steward.sessionId !== oldId || steward.nativeId !== record.oldNativeId || typeof steward.duty !== 'string') {
      return '';
    }
    return steward.duty;
  }

  // Read fresh state once, right before sending; skip if the member moved on (`why.reason` says how, when given).
  async freshReady(sessionId, quietMs = this.humanQuietMs, why = {}) {
    const held = () => {
      if (this.isolation.unknown) return 'trust-unknown';
      if (Object.hasOwn(this.isolation.holds, sessionId)) return 'trust-hold';
      return Object.values(this.rotations).some(record => quarantinedSuccessor(record) && record.newId === sessionId) ? 'trust-hold' : '';
    };
    why.reason = held();
    if (why.reason) return null;
    await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
    const current = this.view();
    why.reason = held();
    if (why.reason) return null;
    const session = current.snapshot.sessions.find(s => s.id === sessionId);
    const ready = sessionReady(session, current.snapshot.wakePolicy);
    if (!ready.ready) {
      why.reason = ready.reason;
      return null;
    }
    if (humanRecent(sessionId, this.humanAt, current.now, quietMs)) {
      why.reason = 'person-recent';
      return null;
    }
    return { ...current, session };
  }

  // The member's backend can take a NAW input and its connection is not being replaced.
  preflight(session) {
    const entry = this.client.route(session.id);
    if (!entry.state.capabilities || !entry.state.capabilities.includes(CAPABILITY)) {
      throw Object.assign(Error('backend-update-needed'), { notSent: true });
    }
    if (this.client.operationGuard) {
      this.client.operationGuard(entry)();
    }
    return entry;
  }

  // The backend's own NAW input: no takeover, no human-input semantics.
  async send(session, text, itemId) {
    if (this.isolation.unknown) throw Object.assign(Error('directory-trust-identity-unknown'), { notSent: true });
    if (Object.hasOwn(this.isolation.holds, session.id)) {
      // Other automatic senders use this same boundary. Only the rotation's
      // own validated handoff may enter its held successor, never a queue or
      // integration message that bypassed the queue planner.
      const handoff = Object.entries(this.rotations).some(([id, record]) => !this.faultedRotations.has(id) &&
        record.phase === 'created' && record.newId === session.id && itemId === `rotation-handoff:${id}` &&
        this.isolation.holds[session.id].receiptId === (record.trustNoticeId || null));
      if (!handoff) throw Object.assign(Error('directory-trust-successor-held'), { notSent: true });
    }
    const entry = this.preflight(session);
    const record = this.rotations[session.id];
    let control;
    if (itemId === `rotation:${session.id}`) {
      if (!entry.state.capabilities?.includes(ROTATION_CAPABILITY) || !record?.episodeEpoch || record.oldNativeId !== session.nativeId)
        throw Object.assign(Error('backend-update-needed'), { notSent: true });
      control = { kind: 'rotation-request', epoch: record.episodeEpoch };
    }
    const call = control ? entry.client.call('dispatch', session.id, text, session.nativeId, itemId, control)
      : entry.client.call('dispatch', session.id, text, session.nativeId, itemId);
    const result = await withTimeout(call, CALL_TIMEOUT_MS, 'send-timeout');
    this.idleSince.delete(session.id);
    if (typeof result === 'string') {
      return result;
    }
    if (result && typeof result.tag === 'string') {
      return result.tag;
    }
    throw Error('NAW did not receive a delivery tag');
  }

  async dispatch(action, waits = null) {
    const why = {};
    const current = await this.freshReady(action.sessionId, this.humanQuietMs, why);
    if (!current) {
      waits?.set(action.itemId, [{ sessionId: action.sessionId, reason: why.reason }]);
      return;
    }
    const room = current.snapshot.rooms.find(r => r.id === action.roomId);
    const session = current.session;
    let item = null;
    if (room) {
      item = (room.queue || []).find(i => i.id === action.itemId);
    }
    if (!room || !item || item.status !== 'queued') {
      return;
    }
    try {
      this.roomState.assertAvailable(session.id, true, room.id);
      this.preflight(session);
    } catch (error) {
      // Nothing was recorded or sent; the next pass looks again. The refusal's key, never its text.
      const message = typeof error?.message === 'string' ? error.message : '';
      waits?.set(item.id, [{ sessionId: session.id, reason: errorKey(error) || (/^[a-z][a-z-]{0,60}$/.test(message) ? message : 'refused') }]);
      return;
    }
    const name = this.name(session);
    // Record before sending: a crash after this point is never resent silently.
    const notes = notesDue(room, session);
    this.roomState.queueMarkSent(room.id, item.id, session.id, name, this.now(), action.afterDecision === true, session.nativeId || null, notes);
    try {
      const tag = await this.send(session, dispatchText(room.name || '', item, notes ? room.notes : ''), item.id);
      if (this.stillSent(room.id, item.id)) this.roomState.queueSetDelivery(room.id, item.id, tag, session.controlRevision || 0);
    } catch (error) {
      if (errorKey(error) === NATIVE_DRAFT_KEY) {
        // Treated like the person typing: this member is left alone for a while.
        this.humanAt.set(session.id, this.now());
      }
      if (!this.stillSent(room.id, item.id)) {
        // Marked handled while the send was on its way: left as the person or the butler closed it.
      } else if (notSent(error)) {
        // A prompt the person left unsent there does not use up the item's attempts: it waits.
        let attempts = NOT_SENT_ATTEMPTS;
        if ([NATIVE_DRAFT_KEY, 'error.queue.terminalDialog'].includes(errorKey(error))) {
          attempts = Infinity;
        }
        this.roomState.queueRequeue(room.id, item.id, error.message || 'not-sent', attempts, name);
      } else {
        this.roomState.queueSettle(room.id, item.id, 'failed', error.message || 'send-failed', name);
      }
    }
    await this.broadcast();
  }

  untouched(old, record, reply) {
    if (!old || old.nativeId !== record.oldNativeId) {
      return false;
    }
    if ((old.controlRevision || 0) !== record.oldControl) {
      return false;
    }
    const at = this.humanAt.get(old.id);
    if (Number.isFinite(at) && at >= record.requestedAt) {
      return false;
    }
    return !(reply && reply.humanAfter);
  }

  // Before an old session typed into since its process started ends, keep what its live terminal
  // shows, an unsent prompt included, in a private file beside the rotation log. Read through a
  // separate connection that owns nothing: a terminal no longer open is then never reopened, and
  // with no open terminal nothing unsent remains (null).
  async saveTerminal(oldId) {
    const dir = path.join(path.dirname(this.logFile), 'rotation-terminals');
    return saveTerminalScreen(this.connect, this.owner, dir, oldId, this.now());
  }

  // Used since this step read it (a keystroke in its terminal, the person's window)? Read fresh
  // state right before ending it.
  // `seen.latest` is then the state judged, for the stop that follows (stopUnchanged).
  async touchedSince(oldId, old, seen = null) {
    await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
    const latest = this.view().snapshot.sessions.find(s => s.id === oldId);
    if (seen) {
      seen.latest = latest;
    }
    if (!latest) {
      return false;
    }
    if (latest.state !== 'idle' || latest.pendingTag) {
      return true;
    }
    if ((latest.controlRevision || 0) !== (old.controlRevision || 0)) {
      return true;
    }
    return humanRecent(oldId, this.humanAt, this.now(), this.humanQuietMs);
  }

  // Ends the old process only if nothing moved since `latest`, the state the last check judged. The
  // service compares it when the request arrives and again just before it commits: a send, a draft,
  // a takeover or terminal input that reaches the service first (the window after that check) makes
  // it refuse with nothing changed, and the session is kept. A plain stop would end it with the person's
  // words unanswered. A service without that check is not stopped unconditionally either.
  // Returns null once ended, else why it was kept (the rotation log's reason).
  // `scoped`: the finish step waited only for the old session's own relays (participantStop), so the stop must
  // pause only those; a service that no longer offers that is not asked (relays elsewhere may be running).
  async stopUnchanged(oldId, latest, scoped = false) {
    const target = this.client.route(oldId);
    const guard = typeof this.client.operationGuard === 'function' ? this.client.operationGuard(target) : () => {};
    guard();
    if (!target.state.capabilities?.includes(CONDITIONAL_STOP_CAPABILITY)) {
      return 'old-service';
    }
    if (scoped && !target.state.capabilities.includes(PARTICIPANT_STOP_CAPABILITY)) {
      return 'old-service';
    }
    // The proof is the service's own: the same fields, normalised as its check computes them.
    const plan = latest && sessionPlan(latest, latest.state);
    if (!plan || !plan.stop) {
      return 'stop-unproven';
    }
    try {
      guard();
      const scope = scoped ? ['participant'] : [];
      await withTimeout(target.client.call('maintenanceStop', oldId, plan.stop, false, ...scope), CALL_TIMEOUT_MS, 'stop-timeout');
    } catch (error) {
      const key = error && error.uiMessage && error.uiMessage.key;
      if (key === 'error.backendSwitchSessionChanged') {
        return 'changed-at-stop';
      }
      // The service refuses its own receipt when a Claude terminal ends itself during the stop (the backend
      // switch meets the same): the settled session still proves this stop ended it and nothing else changed.
      if (key === 'error.backendSwitchDisconnectUnconfirmed') {
        guard();
        const settled = await endedByThisStop(target.client, plan.stop, STOP_SETTLE_MS).catch(() => null);
        if (settled) {
          return null;
        }
      }
      throw error;
    }
    return null;
  }

  // Does the old session's service stop it pausing only its own relays? Unknown counts as no.
  participantStop(oldId) {
    try {
      return Boolean(this.client.route(oldId).state.capabilities?.includes(PARTICIPANT_STOP_CAPABILITY));
    } catch {
      return false;
    }
  }

  // The old session is left as it is: one record, log line and notice, then a week's rest.
  skipRotation(session, now, reason) {
    const record = {
      phase: 'failed',
      failedAt: now,
      reason: `cannot-carry:${reason}`,
      oldId: session.id,
      oldNativeId: session.nativeId,
      provider: session.provider,
      cwd: session.cwd,
      name: this.name(session),
      roomIds: [],
    };
    try {
      record.roomIds = roomIds(session);
    } catch {
      // A record that cannot be read still gets its rest.
    }
    this.rotations[session.id] = record;
    this.save();
    this.appendLog('failed', record, { reason: record.reason });
    this.failedEvent(record.roomIds, session.id, record);
    this.notify('failed', record);
  }

  async requestHandoff(action, bytes, plannedSnapshot = this.client.snapshot()) {
    // Keep the last known membership: the fresh read itself can fail.
    const expected = plannedSnapshot.sessions.find(session => session.id === action.sessionId), whyReady = {};
    let current;
    try { current = await this.freshReady(action.sessionId, this.humanQuietMs, whyReady); }
    catch (error) {
      if (!this.closed) this.rotationWait(expected, error?.message === 'refresh-timeout' ? 'refresh-timeout' : 'refresh-failed');
      return;
    }
    if (!current) {
      this.rotationWait(expected, whyReady.reason || 'not-idle');
      return;
    }
    const session = current.session;
    const reason = action.reason || 'content';
    const whyNotice = rotationWhyNotice(reason, recordCount(session), bytes || 0, action.compactions);
    const why = whyNotice.text;
    // Decided before the old session is asked anything: a successor must match it.
    let carry = carrySettings(session);
    if (carry.reason === 'model-unknown') {
      const model = transcriptModel(session, this.transcriptRoot);
      if (model) {
        carry = carrySettings({ ...session, model });
      }
    }
    if (carry.reason === 'model-unknown') {
      // Its next turn reports the model; until then the session simply keeps working.
      this.unknownModelAt.set(session.id, current.now);
      if (!this.loggedWaiting.has(session.id)) {
        this.loggedWaiting.add(session.id);
        let spaces = [];
        try {
          spaces = roomIds(session);
        } catch {
          // The line is still written without its spaces.
        }
        this.appendLog('waiting', { oldId: session.id, oldNativeId: session.nativeId, name: this.name(session), roomIds: spaces }, { reason: 'model-unknown' });
      }
      return;
    }
    let refusal = carry.reason;
    const capabilities = current.snapshot.capabilities || [];
    if (!refusal && (!capabilities.includes(CREATE_SETTINGS_CAPABILITY) || (carry.settings.profile && !capabilities.includes(CREATE_PROFILE_CAPABILITY)))) {
      refusal = 'backend-cannot-carry-settings';
    }
    if (refusal) {
      this.skipRotation(session, current.now, refusal);
      await this.broadcast();
      return;
    }
    const record = {
      reason,
      why,
      carry: carry.settings,
      ...(carry.modelProvider ? { modelProvider: carry.modelProvider } : {}),
      view: carry.view,
      phase: 'requested',
      episodeEpoch: randomUUID(), episodeState: 'open',
      requestedAt: current.now,
      tag: null,
      oldId: session.id,
      oldNativeId: session.nativeId,
      oldControl: session.controlRevision || 0,
      provider: session.provider,
      cwd: session.cwd,
      name: this.name(session),
      skipPermissions: session.skipPermissions === true,
      roomIds: roomIds(session),
    };
    record.newName = nextName(record.name);
    this.rotations[session.id] = record;
    this.save();
    try {
      record.tag = await this.send(session, handoffRequestText(why, reason), `rotation:${session.id}`);
      this.rotationWaitReasons.delete(session.id);
      this.save();
      this.appendLog('requested', record, { reason, why });
      this.roomState.rotationEvent(record.roomIds, 'requested', this.label(session.id, record.name), why, undefined, whyNotice.uiMessage);
    } catch (error) {
      if (errorKey(error) === NATIVE_DRAFT_KEY) {
        // The person has an unsent prompt there: ask again later, record no failure.
        this.humanAt.set(session.id, this.now());
      }
      if (notSent(error)) {
        delete this.rotations[session.id];
        this.rotationWait(session, errorKey(error) === NATIVE_DRAFT_KEY ? 'person-typing'
          : rotationReasonCode(errorKey(error) || error?.message, 'handoff-request-not-sent'));
      } else {
        record.phase = 'failed';
        record.failedAt = current.now;
        record.reason = rotationReasonCode(errorKey(error) || error?.message, 'handoff-request-failed');
        await this.invalidateEpisode(session.id, record);
        this.appendLog('failed', record, { reason: record.reason });
        this.failedEvent(record.roomIds, session.id, record);
        this.notify('failed', record);
      }
      this.save();
    }
    await this.broadcast();
  }

  retiredProviderWait(session, record) {
    if (!session || session.nativeContextPending || record.phase !== 'waiting-provider') return false;
    const episode = session.rotationEpisode, disposition = episode?.disposition;
    if (episode?.state !== 'released' || episode.nativeId !== record.oldNativeId || episode.epoch !== record.episodeEpoch || episode.tag !== record.tag ||
        disposition?.action !== 'context-switch' || disposition.outcome !== 'failed' || disposition.reason !== 'native-context-changed' ||
        disposition.actor?.kind !== 'native-context' || disposition.actor.id !== record.oldNativeId) return false;
    const boundary = session.nativeContexts?.find(context => context.nativeId === record.oldNativeId && context.boundaryId === disposition.boundaryId);
    const audit = boundary?.rotationDisposition;
    return Boolean(boundary && boundary.endedAt === disposition.at && audit?.epoch === record.episodeEpoch && audit.tag === record.tag &&
      audit.action === 'context-switch' && audit.outcome === 'failed' && audit.boundaryId === boundary.boundaryId &&
      audit.nextNativeId === disposition.nextNativeId && audit.actor?.kind === 'native-context' && audit.actor.id === record.oldNativeId);
  }

  async advanceRotations(snapshot, now) {
    for (const [id, record] of Object.entries(this.rotations)) {
      const session = snapshot.sessions.find(s => s.id === id), episode = session?.rotationEpisode;
      if (!record.failureCleanup && (session?.nativeId === record.oldNativeId && episode?.state === 'released' && episode.nativeId === record.oldNativeId &&
          episode.epoch === record.episodeEpoch && episode.tag === record.tag || this.retiredProviderWait(session, record))) {
        delete this.rotations[id]; this.save();
      }
    }
    for (const [oldId, record] of Object.entries(this.rotations)) {
      if (this.closed) return;
      if (!this.faultedRotations.has(oldId) && record.failureCleanup) {
        try { await this.resumeFailedHandoff(oldId, record); } catch { /* Durable intent remains pending. */ }
      }
      if (!this.faultedRotations.has(oldId) && trustRecoveryPending(record)) {
        try { await this.resumeTrustCleanup(oldId, record, snapshot, now); }
        catch { if (!this.closed) await this.isolateTrustRecovery(oldId, record); }
      }
    }
    for (const [id, record] of Object.entries(this.rotations)) {
      if (record.phase === 'failed' && record.reason === 'person-active' && record.episodeEpoch &&
          !record.newId && !record.handoffConfirmed && !trustRecord(record)) {
        try { await this.deferRotation(id, record, null, now); }
        catch { /* Keep the exact unresolved record until its release is confirmed. */ }
      }
    }
    for (const oldId of this.activeRotations()) {
      if (this.closed) return;
      const record = this.rotations[oldId];
      try {
        await this.advanceRotation(oldId, record, snapshot, now);
      } catch (error) {
        // A closing window rejects its pending RPC; the next app must resume
        // the persisted creating receipt, not inherit a shutdown failure.
        if (!this.closed) {
          if (this.isolationDirty && Object.hasOwn(this.isolation.holds, record.newId)) {
            await this.isolateTrustRecovery(oldId, record); continue;
          }
          try { await this.failRotation(oldId, record, error.message || 'rotation-failed', now, snapshot); }
          catch (cleanupError) {
            if (!this.closed) {
              if (trustRecord(record)) await this.isolateTrustRecovery(oldId, record);
              else throw cleanupError;
            }
          }
        }
      }
    }
  }

  // A backend before alpha.284 closes the connection on this six-argument call (fixed in dfa418e5), so it is not
  // asked. An answer lost to a closed connection or a timeout is asked again, a bounded number of times: the backend
  // saves a release once, and a release already in its state is confirmed without asking.
  async releaseRotation(id, nativeId, epoch, tag, actor, reason) {
    let result;
    for (let attempt = 0; ; attempt++) {
      const client = this.client || await this.source();
      const entry = client.route(id);
      if (releaseBackendOutdated(entry?.state?.runtimeVersion)) throw Object.assign(uiError('error.queue.releaseBackendUpdate'), { notSent: true });
      if (releaseSaved(entry, id, nativeId, epoch, tag)) { result = { epoch, tag, state: 'released' }; break; }
      try {
        result = await withTimeout(entry.client.call('releaseRotation', id, nativeId, epoch, tag, actor, reason), CALL_TIMEOUT_MS, 'release-timeout');
        break;
      } catch (error) {
        let saved = false; try { saved = releaseSaved((this.client || await this.source()).route(id), id, nativeId, epoch, tag); } catch { /* Asked again below. */ }
        if (saved) { result = { epoch, tag, state: 'released' }; break; }
        if (!RELEASE_ANSWER_LOST.includes(error?.uiMessage?.key ?? error?.message) || attempt >= RELEASE_RETRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, this.releaseRetryMs ?? RELEASE_RETRY_MS));
      }
    }
    if (result?.epoch !== epoch || result.tag !== tag || result.state !== 'released') throw Error('handoff-purpose-unconfirmed');
    // A step the person or the butler took went through, as one of the butler's calls does (steward-wake.cjs).
    this.stewardWake?.controlSucceeded();
    const record = this.rotations[id];
    if (record?.oldNativeId === nativeId && record.episodeEpoch === epoch && record.tag === tag && !record.failureCleanup) { delete this.rotations[id]; this.save(); }
    this.schedule();
    return result;
  }

  async completeEpisode(oldId, record) {
    if (!record.episodeEpoch) return;
    const entry = this.client.route(oldId);
    const result = await withTimeout(entry.client.call('completeRotation', oldId, record.oldNativeId, record.episodeEpoch, record.tag), CALL_TIMEOUT_MS, 'complete-control-timeout');
    if (result?.epoch !== record.episodeEpoch || result.state !== 'complete') throw Error('handoff-purpose-unconfirmed');
    record.episodeState = 'complete'; this.save();
  }

  async invalidateEpisode(oldId, record) {
    if (!record.episodeEpoch || record.episodeState === 'complete') return;
    record.episodeState = 'invalid'; this.save();
    try {
      const entry = this.client.route(oldId);
      await withTimeout(entry.client.call('invalidateRotation', oldId, record.oldNativeId, record.episodeEpoch), CALL_TIMEOUT_MS, 'invalidate-timeout');
    } catch { /* The backend's unresolved request stays blocked when its receipt is unknown. */ }
  }

  providerWaitProof(session, record) {
    const episode = session?.rotationEpisode;
    if (!episode || session.nativeId !== record.oldNativeId || episode.nativeId !== record.oldNativeId ||
        episode.epoch !== record.episodeEpoch || episode.tag !== record.tag) return null;
    if (!(episode.state === 'waiting-provider' && episode.providerBlock?.kind === 'usage_limit_exceeded' &&
        validId(episode.providerBlock.turnId) && validTime(episode.providerBlock.observedAt))) return null;
    return { ...episode.providerBlock };
  }
  async waitForProvider(oldId, record, snapshot) {
    if (snapshot?.storageWarning) return false;
    const proof = this.providerWaitProof((snapshot?.sessions || []).find(s => s.id === oldId), record);
    if (!proof || !['requested', 'waiting-provider'].includes(record.phase)) return false;
    record.phase = 'waiting-provider'; record.episodeState = 'waiting-provider'; record.providerBlock = proof;
    this.save(); await this.broadcast(); return true;
  }

  // Undo what a failed rotation started; the old member keeps its session and work.
  async failRotation(oldId, record, reason, now, snapshot) {
    reason = rotationReasonCode(reason);
    if (reason === 'handoff-missing' && await this.waitForProvider(oldId, record, snapshot)) return;
    if (record.phase === 'handed' && !record.handoffConfirmed && firstHandoff.failedReason(reason)) {
      record.phase = 'failed'; record.failedAt = now; record.reason = reason; record.oldId = oldId;
      record.failureCleanup = { v: 1, id: randomUUID(), release: 'pending', log: 'pending', os: 'pending',
        stop: { state: 'pending', receipt: null, observation: null },
        rooms: Object.fromEntries(record.roomIds.map(id => [id, { queue: 'pending', leave: 'pending', notice: 'pending' }])) };
      this.save();
      if (!this.closed) await this.resumeFailedHandoff(oldId, record);
      return;
    }
    const phase = record.phase;
    const due = record.reason;
    const trustTimedOut = phase === 'waiting-trust' && reason === 'native-directory-trust-timeout';
    record.phase = 'failed';
    record.failedAt = now;
    record.reason = reason;
    await this.invalidateEpisode(oldId, record);
    if (trustFailure(record)) {
      record.oldId ??= oldId;
      record.trustCleanup = { v: 1, id: randomUUID(), proof: record.trustOwner ? { ...record.trustOwner } : null,
        stop: { state: record.trustOwner ? 'pending' : 'unknown', attempts: 0 },
        rooms: Object.fromEntries(record.roomIds.map(id => [id, 'pending'])), notices: noticeEffects(record.roomIds), outcome: null };
      this.save(); // Intent and failure are one write; a restart can finish it.
      if (!this.closed) await this.resumeTrustCleanup(oldId, record, snapshot, now);
      return;
    }
    this.save();
    let stopped = true;
    if (record.newId && !record.handoffConfirmed && ['joining', 'created', 'handed', 'waiting-trust'].includes(phase)) {
      for (const roomId of record.roomIds) {
        try {
          this.roomState.queueReassign(roomId, record.newId, oldId);
        } catch {
          // The space may be gone; the failure record still stands.
        }
        try {
          await withTimeout(this.roomState.membership(this.client, record.newId, false, record.newName || record.name, roomId), CALL_TIMEOUT_MS, 'leave-timeout');
        } catch {
          // Leaving is cosmetic; stopping the unused session is what frees memory.
        }
      }
      try {
        await withTimeout(this.client.call('stop', record.newId), CALL_TIMEOUT_MS, 'stop-timeout');
      } catch {
        // Left for the person; it holds no handoff and no queued work.
        stopped = false;
        if (trustTimedOut) {
          record.reason = reason = 'native-directory-trust-timeout-stop-unconfirmed';
          this.save();
        }
      }
    }
    if (!record.oldId) {
      record.oldId = oldId;
    }
    // A successor in a moved directory is held under this record (holdTrustSuccessor); it keeps the failed record.
    if (reason === 'person-active' && stopped && !record.handoffConfirmed && !movedSuccessor(record)) {
      await this.deferRotation(oldId, record, due, now);
      return;
    }
    this.appendLog('failed', record, { reason });
    const outcome = trustTimedOut ? (reason === 'native-directory-trust-timeout-stop-unconfirmed' ? 'trustTimeoutUnconfirmed' : 'trustTimedOut') : 'failed';
    if (trustTimedOut) {
      this.roomState.rotationEvent(record.roomIds, outcome, this.label(oldId, record.name), this.label(record.newId, record.newName));
    } else {
      this.failedEvent(record.roomIds, oldId, record);
    }
    this.notify(outcome, record);
    await this.broadcast();
  }

  async resumeFailedHandoff(oldId, record) {
    const c = record.failureCleanup;
    this.save(); // No effects until the recovery intent is durable.
    for (const key of ['log', 'os']) if (c[key] === 'pending') {
      this.saveTrustState(c, key, 'attempted');
      try { if (key === 'log') this.appendLog('failed', record, { reason: record.reason, noticeId: c.id }); else this.notify('failed', record); } catch { /* One attempt; space notices still recover. */ }
    }
    for (const roomId of record.roomIds) {
      const row = c.rooms[roomId];
      if (row.queue !== 'done') {
        try { this.roomState.queueReassign(roomId, record.newId, oldId); this.saveTrustState(row, 'queue', 'done'); } catch { /* Retry this space. */ }
      }
      if (row.notice !== 'done') {
        try { if (this.failedEvent([roomId], oldId, record, c.id) === 1) this.saveTrustState(row, 'notice', 'done'); } catch { /* Other spaces still recover. */ }
      }
    }
    if (c.release !== 'done') {
      try {
        const target = this.client.route(oldId);
        const result = await target.client.call('invalidateRotation', oldId, record.oldNativeId, record.episodeEpoch,
          { tag: record.tag, reason: record.reason });
        if (result?.state === 'released' && result.epoch === record.episodeEpoch && result.tag === record.tag) this.saveTrustState(c, 'release', 'done');
      } catch { /* The exact old episode remains pending, never replaced. */ }
    }
    if (this.closed) return;
    await this.client.refresh();
    let fresh = this.client.snapshot().sessions.find(s => s.id === record.newId);
    let owner = record.successorOwner;
    const input = firstHandoff.handoffInput(fresh, record.handoffTag);
    if (owner?.nativeId === null && input && input.nativeId === fresh.nativeId) owner = { ...owner, nativeId: input.nativeId };
    if (['pending', 'started'].includes(c.stop.state)) {
      const receipt = fresh?.failedHandoffStop;
      if (firstHandoff.validStopReceipt(receipt) && receipt.tag === record.handoffTag && JSON.stringify(receipt.owner) === JSON.stringify(owner) &&
          ['ended', 'recoverable', 'disconnected'].includes(fresh.state) && firstHandoff.owned(fresh, receipt.proof, record.handoffTag)) {
        this.saveTrustState(c.stop, 'receipt', receipt); this.saveTrustState(c.stop, 'state', 'done');
      } else if (!fresh || !firstHandoff.owned(fresh, owner, record.handoffTag)) this.saveTrustState(c.stop, 'state', 'retained');
      else {
        try {
          const target = this.client.route(record.newId);
          if (!target.state.capabilities?.includes('failedSuccessorCleanupV1')) return;
          const guard = this.client.operationGuard?.(target) || (() => {}); guard();
          this.saveTrustState(c.stop, 'state', 'started');
          const receipt = await withTimeout(target.client.call('stopFailedSuccessor', record.newId, owner, record.handoffTag), CALL_TIMEOUT_MS, 'stop-timeout');
          guard(); if (this.closed) return;
          if (firstHandoff.validObservation(receipt)) {
            this.saveTrustState(c.stop, 'observation', receipt); this.saveTrustState(c.stop, 'state', 'retained');
          } else if (receipt?.basis === 'stopped-by-this-attempt' && ['ended', 'recoverable', 'disconnected'].includes(receipt.state) &&
              firstHandoff.validStopReceipt(receipt.receipt) && receipt.receipt.tag === record.handoffTag &&
              JSON.stringify(receipt.receipt.owner) === JSON.stringify(owner)) {
            this.saveTrustState(c.stop, 'receipt', receipt.receipt); this.saveTrustState(c.stop, 'state', 'done');
          }
        } catch { /* Reconcile the same guarded stop on the next pass. */ }
      }
    }
    if (c.stop.state === 'retained') {
      for (const row of Object.values(c.rooms)) if (row.leave !== 'retained') this.saveTrustState(row, 'leave', 'retained');
      this.releaseTrustSuccessor(record); return;
    }
    if (c.stop.state !== 'done') return;
    await this.client.refresh(); fresh = this.client.snapshot().sessions.find(s => s.id === record.newId);
    for (const roomId of record.roomIds) {
      if (this.closed) return;
      const row = c.rooms[roomId]; if (row.leave !== 'pending') continue;
      if (fresh && !roomIds(fresh).includes(roomId)) { this.saveTrustState(row, 'leave', 'done'); continue; }
      if (!fresh || !firstHandoff.owned(fresh, c.stop.receipt.proof, record.handoffTag)) { this.saveTrustState(row, 'leave', 'retained'); continue; }
      try {
        const expected = { nativeId: fresh.nativeId, revision: membershipRevision(fresh, roomId), placementRevision: placementRevision(fresh),
          connectionRevision: fresh.connectionRevision || 0, unusedSuccessor: true, failedHandoff: { receipt: c.stop.receipt, tag: record.handoffTag } };
        await withTimeout(this.roomState.membership(this.client, record.newId, false, record.newName, roomId, expected), CALL_TIMEOUT_MS, 'leave-timeout');
        this.saveTrustState(row, 'leave', 'done');
      } catch { /* A changed or unavailable writer leaves the successor in place. */ }
    }
    if (cleanupComplete(record)) this.releaseTrustSuccessor(record);
  }

  // The person used the old session while it was being rotated (the 11-14 drill, finding 1: a week's rest for it).
  // Nothing failed: the record goes, and the member is rotated again once quiet (personDeferred). No OS notice, since
  // the person is at that session; the space says why the request stopped. Each new attempt asks for a handoff again.
  async deferRotation(oldId, record, due, now) {
    if (record.episodeEpoch) {
      const entry = this.client.route(oldId);
      const result = await withTimeout(entry.client.call('invalidateRotation', oldId, record.oldNativeId, record.episodeEpoch,
        { tag: record.tag, reason: 'person-active' }), CALL_TIMEOUT_MS, 'invalidate-timeout');
      if (result?.epoch !== record.episodeEpoch || result.tag !== record.tag || result.state !== 'released') throw Error('handoff-purpose-unconfirmed');
    }
    delete this.rotations[oldId];
    this.save();
    this.deferredAt.set(oldId, { at: now, due });
    this.appendLog('waiting', record, { reason: 'person-active' });
    this.roomState.rotationEvent(record.roomIds, 'deferred', this.label(oldId, record.name));
    await this.broadcast();
  }

  // Before alpha.284 (a73629ca) a deferral for the person dropped its record and left the backend episode invalid,
  // which then held the session for good: the butler from 11-19 21:13 PT, through every restart (R129). Its own log
  // still says what NAW did: the request, then the deferral, nothing after. Ended here as deferRotation ends one now,
  // on a backend that can; any other invalid episode stays the person's to release.
  async finishDeferrals(snapshot, now) {
    let changed = false;
    for (const s of snapshot?.sessions || []) {
      const episode = s?.rotationEpisode;
      if (episode?.state !== 'invalid' || episode.nativeId !== s.nativeId || s.archived || Object.hasOwn(this.rotations, s.id) ||
          Object.hasOwn(this.rejectedRotations, s.id) || this.faultedRotations.has(s.id)) continue;
      const input = (s.messages || []).find(m => m?.id === episode.tag), purpose = input?.dispatchPurpose;
      if (!input || input.dispatchItem !== `rotation:${s.id}` || purpose?.kind !== 'rotation-request' || purpose.epoch !== episode.epoch ||
          purpose.nativeId !== s.nativeId || !Number.isSafeInteger(input.time)) continue;
      const after = this.log.filter(e => e.old?.id === s.id && e.old.nativeId === s.nativeId && e.time >= input.time);
      if (after[0]?.event !== 'requested' || after[1]?.event !== 'waiting' || after[1].reason !== 'person-active' ||
          after.slice(1).some(e => e.event !== 'waiting')) continue;
      let entry;
      try { entry = this.client.route(s.id); } catch { continue; }
      const version = entry?.state?.runtimeVersion ?? s.runtimeVersion;
      // An older backend has no such step: the person updates it first (the banner's button).
      if (releaseBackendOutdated(version)) continue;
      const key = JSON.stringify([s.id, episode.epoch, episode.tag, version ?? null]);
      if (this.deferralsTried.has(key)) continue;
      this.deferralsTried.add(key);
      try {
        const result = await withTimeout(entry.client.call('invalidateRotation', s.id, s.nativeId, episode.epoch,
          { tag: episode.tag, reason: 'person-active' }), CALL_TIMEOUT_MS, 'invalidate-timeout');
        if (result?.epoch === episode.epoch && result.tag === episode.tag && result.state === 'released') {
          // It rests as deferRotation's would, before it is asked again.
          this.deferredAt.set(s.id, { at: now, due: after[0].reason });
          this.appendLog('waiting', { oldId: s.id, oldNativeId: s.nativeId, name: this.name(s), roomIds: roomIds(s) }, { reason: 'person-active', finished: true });
          changed = true;
        }
      } catch { /* Left as it is: the person's step still ends it. */ }
    }
    if (changed) await this.broadcast();
    return changed;
  }

  // A bounded record per changed wait. It never rests, stops or replaces the
  // old member. An accepted handoff request starts a new episode.
  rotationWait(session, reason) {
    if (!session || this.closed) return;
    const code = rotationReasonCode(reason), spaces = roomIds(session);
    const identity = JSON.stringify([session.nativeId, spaces.slice().sort(), code]);
    if (this.rotationWaitReasons.get(session.id) === identity) return;
    const record = { oldId: session.id, oldNativeId: session.nativeId, name: this.name(session), roomIds: spaces };
    this.appendLog('waiting', record, { reason: code });
    const key = ['refresh-failed', 'refresh-timeout'].includes(code) ? 'notice.rotation.cause.refresh'
      : ['person-typing', 'person-recent'].includes(code) ? 'notice.rotation.cause.personActive'
      : code.startsWith('handoff-request-') ? 'notice.rotation.cause.handoffRequest' : 'notice.rotation.cause.notReady';
    const cause = uiNotice(key);
    this.roomState.rotationEvent(spaces, 'waiting', this.label(session.id, record.name), cause.text, undefined, cause.uiMessage,
      { sessionId: session.id, reason: code });
    this.rotationWaitReasons.set(session.id, identity);
    this.broadcast().catch(() => {});
  }

  // Human-readable cause plus a structured code for space members/the butler.
  failedEvent(ids, oldId, record, receipt) {
    const reason = rotationReasonCode(record.reason), cause = rotationCause({ ...record, reason });
    return this.roomState.rotationEvent(ids, 'failed', this.label(oldId, record.name), cause.text, receipt, cause.uiMessage,
      { sessionId: oldId, reason });
  }

  // One durable decision per visible wait. Never send an answer to native here.
  async waitForDirectoryTrust(oldId, record, now, successor) {
    const entering = record.phase !== 'waiting-trust';
    record.oldId ??= oldId;
    if (entering) {
      record.trustWaitingAt = now;
      record.trustNoticeId = randomUUID();
      record.trustEffects = noticeEffects(record.roomIds);
      record.trustOwner = trustProof(successor);
    } else if (!record.trustEffects) {
      // An old marker's absence after trim/clear proves nothing. Only its OS
      // flag was written before that attempt; old log/room attempts are unknown.
      record.trustEffects = noticeEffects(record.roomIds, 'unknown');
      if (!record.trustNotified) record.trustEffects.os = 'pending';
      record.trustOwner ??= null;
    }
    record.phase = 'waiting-trust';
    record.trustWaitingAt ??= now;
    record.trustNoticeId ||= randomUUID();
    record.reason = 'native-directory-trust';
    record.trustNotified = true; // Compatibility suppression, never delivery evidence.
    this.save();
    // No queued work belongs to a successor that has not received its handoff.
    for (const roomId of record.roomIds) this.roomState.queueReassign(roomId, record.newId, oldId);
    await this.trustNotices(oldId, record, record.trustEffects, 'needsTrust', 'waiting', record.trustNoticeId);
    await this.broadcast();
  }

  saveTrustState(object, key, value) {
    const prior = object[key]; object[key] = value;
    try { this.save(); } catch (error) { object[key] = prior; throw error; }
  }

  async trustNotices(oldId, record, effects, outcome, event, receipt) {
    const attempt = async (object, key, action) => {
      if (this.closed || object[key] !== 'pending') return;
      this.saveTrustState(object, key, 'attempted');
      await action(); // At most one attempt, not an acknowledgement of delivery.
    };
    await attempt(effects, 'log', () => this.appendLog(event, record, { reason: record.reason, noticeId: receipt }));
    for (const id of record.roomIds) {
      await attempt(effects.rooms, id, () => outcome === 'failed' ? this.failedEvent([id], oldId, record, receipt)
        : this.roomState.rotationEvent([id], outcome, this.label(oldId, record.name), this.label(record.newId, record.newName), receipt));
    }
    await attempt(effects, 'os', () => this.notify(outcome, record));
  }

  async resumeTrustCleanup(oldId, record, snapshot, now) {
    if (this.closed) return;
    if (!record.trustCleanup) {
      // Older failed records do not reveal which calls ran before a crash.
      // Preserve quarantine without manufacturing another stop or notification.
      record.trustCleanup = { v: 1, id: randomUUID(), proof: record.trustOwner || null,
        stop: { state: 'unknown', attempts: 0 }, rooms: Object.fromEntries(record.roomIds.map(id => [id, 'unknown'])),
        notices: noticeEffects(record.roomIds, 'unknown'), outcome: null };
      this.save();
    }
    const cleanup = record.trustCleanup, proof = cleanup.proof;
    let observed = snapshot;
    let fresh = observed?.sessions.find(session => session.id === record.newId);
    const inactive = () => fresh && proof && fresh.nativeId === proof.nativeId && ['ended', 'recoverable', 'disconnected'].includes(fresh.state);
    const unchanged = () => fresh && proof && fresh.provider === record.provider && fresh.nativeId === proof.nativeId &&
      fresh.controlRevision === proof.controlRevision && fresh.draftRevision === proof.draftRevision && placementRevision(fresh) === proof.placementRevision &&
      ['starting', 'idle', 'error'].includes(fresh.state) && !fresh.pendingTag && !fresh.nativeContextPending && !fresh.liveDraft &&
      !(fresh.messages || []).some(message => ['user', 'assistant'].includes(message.role)) &&
      fresh.nativeGoal?.status !== 'active' && fresh.nativeGoal?.known !== false && !(fresh.background > 0) && !(fresh.scheduled > 0) && !fresh.fleet?.length;
    for (const id of record.roomIds) {
      try { this.roomState.queueReassign(id, record.newId, oldId); } catch { /* The space may have been removed or archived. */ }
    }
    if (inactive()) {
      if (cleanup.stop.state !== 'confirmed') this.saveTrustState(cleanup.stop, 'state', 'confirmed');
    } else if (['pending', 'started'].includes(cleanup.stop.state)) {
      if (!unchanged() || cleanup.stop.attempts >= 2) this.saveTrustState(cleanup.stop, 'state', 'unknown');
      else {
        let target, guard;
        try {
          target = this.client.route(record.newId);
          guard = typeof this.client.operationGuard === 'function' ? this.client.operationGuard(target) : () => {};
          guard();
          if (!target.state.capabilities?.includes(GUARDED_STOP_CAPABILITY)) throw Error('guarded-stop-unavailable');
        } catch { this.saveTrustState(cleanup.stop, 'state', 'unknown'); }
        if (cleanup.stop.state !== 'unknown') {
          const prior = { ...cleanup.stop };
          cleanup.stop.state = 'started'; cleanup.stop.attempts++;
          try { this.save(); } catch (error) { Object.assign(cleanup.stop, prior); throw error; }
          let result;
          try {
            guard();
            result = await withTimeout(target.client.call('stopUnusedSuccessor', record.newId, proof), CALL_TIMEOUT_MS, 'stop-timeout');
            guard();
            if (!['ended', 'recoverable', 'disconnected'].includes(result?.state)) throw Error('native-stop-unconfirmed');
          } catch { result = null; }
          if (this.closed) return;
          this.saveTrustState(cleanup.stop, 'state', result ? 'confirmed' : 'unknown');
          try { await this.client.refresh(); observed = this.client.snapshot(); fresh = observed.sessions.find(session => session.id === record.newId); } catch { fresh = null; }
        }
      }
    }
    // The existing membership mutation can pause that space. Do not interrupt
    // a collaboration that does not use this unused, now-stopped successor.
    for (const id of record.roomIds) {
      if (this.closed) return;
      if (fresh && !roomIds(fresh).includes(id)) {
        if (cleanup.rooms[id] !== 'confirmed') this.saveTrustState(cleanup.rooms, id, 'confirmed');
      } else if (cleanup.rooms[id] === 'started') this.saveTrustState(cleanup.rooms, id, 'unknown');
      else if (cleanup.rooms[id] === 'pending' && cleanup.stop.state === 'confirmed' && inactive() &&
          !observed?.rooms?.some(room => room.id === id && room.run?.status === 'running')) {
        const expected = { nativeId: fresh.nativeId, revision: membershipRevision(fresh, id),
          placementRevision: placementRevision(fresh), connectionRevision: fresh.connectionRevision || 0, unusedSuccessor: true };
        this.saveTrustState(cleanup.rooms, id, 'started');
        let left = false;
        try {
          const target = this.client.route(record.newId), guard = typeof this.client.operationGuard === 'function' ? this.client.operationGuard(target) : () => {};
          guard();
          const scoped = { call: (method, ...args) => { guard(); return target.client.call(method, ...args); } };
          await withTimeout(this.roomState.membership(scoped, record.newId, false, record.newName, id, expected), CALL_TIMEOUT_MS, 'leave-timeout');
          guard(); await this.client.refresh(); fresh = this.client.snapshot().sessions.find(session => session.id === record.newId);
          left = Boolean(fresh && !roomIds(fresh).includes(id));
        } catch { /* An unconfirmed leave keeps this successor out of every queue. */ }
        if (this.closed) return;
        this.saveTrustState(cleanup.rooms, id, left ? 'confirmed' : 'unknown');
      }
    }
    if (!cleanup.outcome && noticesPending(cleanup.notices)) {
      const timedOut = record.reason.startsWith('native-directory-trust-timeout');
      if (cleanup.stop.state !== 'confirmed' && timedOut) record.reason = 'native-directory-trust-timeout-stop-unconfirmed';
      this.saveTrustState(cleanup, 'outcome', cleanupComplete(record) ? (timedOut ? 'trustTimedOut' : 'failed')
        : (timedOut && cleanup.stop.state !== 'confirmed' ? 'trustTimeoutUnconfirmed' : 'trustCleanupUnconfirmed'));
    }
    await this.trustNotices(oldId, record, cleanup.notices, cleanup.outcome || 'trustCleanupUnconfirmed', 'failed', cleanup.id);
    if (cleanupComplete(record)) this.releaseTrustSuccessor(record);
    await this.broadcast();
  }

  async advanceRotation(oldId, record, snapshot, now) {
    if (this.closed) return;
    const old = snapshot.sessions.find(s => s.id === oldId);
    const successor = snapshot.sessions.find(s => s.id === record.newId);
    if (record.phase === 'waiting-provider') return;
    if (record.phase === 'requested' && await this.waitForProvider(oldId, record, snapshot)) return;
    if (record.phase === 'waiting-trust') {
      if (old && !this.untouched(old, record, replyAfter(old, record.tag, record.requestedAt))) throw Error('person-active');
      if (!successor || ['ended', 'background', 'recoverable', 'error'].includes(successor.state)) throw Error('new-session-directory-trust-unavailable');
      const prompt = successor.nativeStartupPrompt?.kind === 'directory-trust';
      const ready = !prompt && sessionReady(successor, snapshot.wakePolicy).ready;
      if (!ready) {
        if (now - record.trustWaitingAt >= this.directoryTrustTimeoutMs) throw Error('native-directory-trust-timeout');
        if (!record.trustEffects || noticesPending(record.trustEffects)) await this.waitForDirectoryTrust(oldId, record, now, successor);
        return;
      }
      // Native readiness, not a rendered line disappearing, resolves the wait.
      // Joining again is idempotent and reassigns queued items only at this point.
      record.phase = 'joining';
      record.createdNewAt = now;
      this.save();
    }
    if (record.newCwd && record.newCwd !== record.cwd && ['joining', 'created'].includes(record.phase) &&
        successor?.nativeStartupPrompt?.kind === 'directory-trust' && successor.nativeStartupPrompt.source === 'native-terminal' && successor.nativeStartupPrompt.provider === record.provider) {
      await this.waitForDirectoryTrust(oldId, record, now, successor);
      return;
    }
    if (record.phase === 'requested') {
      if (!record.tag) {
        if (now - record.requestedAt > UNCONFIRMED_SEND_MS) {
          throw Error('handoff-request-unconfirmed');
        }
        return;
      }
      if (!old) {
        throw Error('old-session-missing');
      }
      if (old.state !== 'idle' || old.pendingTag || !settled(oldId, this.idleSince, now, this.settleMs)) {
        return;
      }
      const reply = replyAfter(old, record.tag, record.requestedAt);
      if (!this.untouched(old, record, reply)) {
        throw Error('person-active');
      }
      if (!reply || !reply.text.trim()) {
        throw Error('handoff-missing');
      }
      await this.completeEpisode(oldId, record);
      record.handoff = reply.text.slice(0, ITEM_TEXT_LIMIT * 2);
      record.phase = 'creating';
      record.creatingAt = now;
      this.save();
    }
    if (record.phase === 'creating') {
      if (!record.newName) {
        record.newName = nextName(record.name);
      }
      const name = record.newName;
      // Legacy creating records may already own a successor at the old cwd.
      // Adopt it before selecting a different directory after an upgrade.
      const candidates = snapshot.sessions.filter(session => {
        const recent = Number.isFinite(session.createdAt) && session.createdAt >= (record.creatingAt || 0) - 5000;
        const sameDirectory = record.newWorktree ? session.worktreePreparation?.nonce === record.newWorktree.nonce : session.cwd === (record.newCwd || record.cwd);
        return session.id !== oldId && session.provider === record.provider && session.name === name && sameDirectory && recent;
      });
      if (candidates.length > 1) throw Error('new-session-ambiguous');
      const existing = candidates[0];
      if (existing) {
        record.newId = existing.id;
      } else {
        if (!record.newCwd) {
          let newCwd = record.cwd, newWorktree;
          if (this.migrateDirectories && nawMadeDirectory(record.cwd, snapshot.defaultWorkspace, snapshot.newWorkspaceRoot)) {
            const defaults = await this.creationDefaults(snapshot);
            if (this.closed) return;
            if (defaults?.repository) {
              const plan = await withTimeout(this.client.call('gitWorktreePreview', defaults.repository, randomUUID(), ''), CALL_TIMEOUT_MS, 'worktree-preview-timeout');
              if (this.closed) return;
              gitWorktree.planShape(plan);
              if (!path.isAbsolute(plan.cwd)) throw Error('invalid-worktree-directory');
              newWorktree = plan; newCwd = plan.cwd;
            } else if (typeof defaults?.directory === 'string' && path.isAbsolute(defaults.directory)) {
              newCwd = defaults.directory;
            } else this.appendLog('directory', record, { reason: 'no-default-directory' });
          }
          // This name, nonce and target are the recovery receipt, before create.
          record.newCwd = newCwd;
          if (newWorktree) record.newWorktree = newWorktree;
          this.save();
        }
        const options = { provider: record.provider, cwd: record.newWorktree?.source || record.newCwd, name, view: record.view || (record.provider === 'codex' ? 'terminal' : 'chat') };
        if (record.newWorktree) options.gitWorktree = record.newWorktree;
        if (record.skipPermissions) {
          options.skipPermissions = true;
        }
        if (record.carry) {
          options.settings = record.carry;
        }
        record.newId = await withTimeout(this.client.call('create', options), CREATE_TIMEOUT_MS, 'create-timeout');
      }
      if (this.closed) return;
      record.createdNewAt = now;
      record.phase = 'joining';
      this.save();
      await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
    }
    if (record.phase === 'joining') {
      const terminalFirst = record.provider === 'codex' && record.view !== 'chat';
      const latest = (terminalFirst || record.newCwd && record.newCwd !== record.cwd) ? this.client.snapshot().sessions.find(session => session.id === record.newId) : null;
      if (terminalFirst && latest && ['ended', 'background', 'recoverable', 'error'].includes(latest.state)) throw Error('new-session-not-ready');
      if (record.newCwd && record.newCwd !== record.cwd && latest?.nativeStartupPrompt?.kind === 'directory-trust' &&
          latest.nativeStartupPrompt.source === 'native-terminal' && latest.nativeStartupPrompt.provider === record.provider) {
        await this.waitForDirectoryTrust(oldId, record, now, latest); return;
      }
      try {
        for (const roomId of record.roomIds) {
          if (!terminalFirst || !roomIds(latest || {}).includes(roomId)) await withTimeout(this.roomState.membership(this.client, record.newId, true, record.newName, roomId), CALL_TIMEOUT_MS, 'join-timeout');
        }
      } catch (error) {
        if (!BACKEND_UPDATING_KEYS.has(errorKey(error))) throw error;
        // The successor and the waiting task stay as they are; a later pass joins (joining again changes nothing).
        if (now - (record.createdNewAt || now) > NEW_SESSION_READY_MS) throw Error('join-timeout');
        return;
      }
      if (terminalFirst && (!latest?.nativeId || latest.terminalState?.alive !== true || latest.nativeStartupPrompt || !sessionReady(latest, snapshot.wakePolicy).ready)) {
        // The original member and queued task stay put, even across an
        // unattended login/trust wait. The person can use the new native
        // terminal in the grid; no answer, input or permission change is sent.
        await this.broadcast();
        return;
      }
      for (const roomId of record.roomIds) this.roomState.queueReassign(roomId, oldId, record.newId);
      if (terminalFirst) record.createdNewAt = now;
      record.phase = 'created';
      this.save();
      await this.broadcast();
      return;
    }
    if (record.phase === 'created') {
      const fresh = snapshot.sessions.find(s => s.id === record.newId);
      if (!fresh) {
        throw Error('new-session-missing');
      }
      const waitingTerminal = record.provider === 'codex' && record.view !== 'chat' && (!fresh.nativeId || fresh.terminalState?.alive !== true || fresh.nativeStartupPrompt);
      if (waitingTerminal || !sessionReady(fresh, snapshot.wakePolicy).ready || !settled(fresh.id, this.idleSince, now, this.settleMs)) {
        if (now - (record.createdNewAt || now) > NEW_SESSION_READY_MS) {
          throw Error('new-session-not-ready');
        }
        return;
      }
      if (old && !this.untouched(old, record, replyAfter(old, record.tag, record.requestedAt))) {
        throw Error('person-active');
      }
      // The new session must report the old one's model (and, once reported, effort and mode).
      const mismatch = settingsMismatch(record.carry, fresh, record.modelProvider || null);
      if (mismatch === 'pending') {
        if (now - (record.createdNewAt || now) > NEW_SESSION_READY_MS) {
          throw Error('new-session-model-unreported');
        }
        return;
      }
      if (mismatch) {
        throw Error(`settings-differ:${mismatch}`);
      }
      // Its open decisions go in the same message, whole; the items move once the successor has it (below).
      const decisions = decisionsNote(record.name, openDecisions(snapshot.rooms || [], old || { id: oldId, messages: [] }, record.roomIds || []));
      record.successorOwner = trustProof(fresh); this.save();
      record.handoffTag = await this.send(fresh, handoffText(record.name, record.handoff, directoryHandoff(record, snapshot), this.stewardDuty(oldId, record), decisions), `rotation-handoff:${oldId}`);
      record.handedAt = now;
      record.phase = 'handed';
      this.save();
      return;
    }
    if (record.phase === 'handed') {
      const fresh = snapshot.sessions.find(s => s.id === record.newId);
      if (!record.handoffConfirmed) {
        const outcome = firstHandoff.outcome(fresh, record.handoffTag);
        if (outcome === 'failed') throw Error('successor-turn-failed');
        if (outcome !== 'complete') {
          if (record.handoffDelivered !== true && handoffDelivered(fresh, record.handoffTag)) {
            record.handoffDelivered = true;
            // An error here would stop the successor without the guards of a failed handoff; the next write has it.
            try { this.save(); } catch {}
          }
          // Its process is known to be gone: it finishes no turn. Disconnected or out of view, it may still be running.
          const running = record.handoffDelivered === true && !['ended', 'background', 'recoverable'].includes(fresh?.state);
          if (now - (record.handedAt || now) > (running ? HANDOFF_TURN_MS : HANDOFF_ACCEPT_MS)) throw Error('handoff-unconfirmed');
          return;
        }
      }
      // Effort and permission mode are often reported only with the first prompt: compare again.
      const mismatch = settingsMismatch(record.carry, fresh, record.modelProvider || null);
      if (mismatch && mismatch !== 'pending') {
        throw Error(`settings-differ:${mismatch}`);
      }
      if (!record.handoffConfirmed) record.confirmedAt = now;
      record.handoffConfirmed = true;
      if (fresh && fresh.nativeId) {
        record.newNativeId = fresh.nativeId;
      }
      this.save();
      // The successor has the handoff: the old session's open decisions are answered there from now on. Run on
      // every pass until the rotation ends; a decision already moved is left as it is.
      let updating = false;
      for (const roomId of record.roomIds || []) {
        try {
          this.roomState.queueCarry(roomId, oldId, record.newId, record.newNativeId || null);
        } catch (error) {
          // A space being updated takes them on a later pass, and the old session waits for that (below). A space
          // that is gone keeps its items; the rotation goes on.
          if (error?.uiMessage?.key === 'error.room.updatingDraftRetained') {
            updating = true;
          }
        }
      }
      this.releaseTrustSuccessor(record);
      // Ending the old session is refused while, or pauses, the relays it is in, and leaving its spaces pauses
      // theirs: wait until none of those is running, but not forever. A service whose stop pauses only those
      // (participantStop) leaves a relay elsewhere running, so that one no longer holds the rotation (cd3e2a8d);
      // beside an older service, whose stop pauses every relay it holds, any running relay still does.
      const scoped = this.participantStop(oldId);
      let collaborating = false;
      for (const room of snapshot.rooms || []) {
        const run = room.run;
        if (run && run.status === 'running' && (!scoped || !Array.isArray(record.roomIds) || record.roomIds.includes(room.id) || (run.ids || []).includes(oldId))) {
          collaborating = true;
        }
      }
      const live = old && !['ended', 'background'].includes(old.state);
      const waitedTooLong = now - (record.confirmedAt || record.handedAt || now) > STOP_WAIT_MS;
      if ((live && collaborating || updating) && !waitedTooLong) {
        return;
      }
      let inUse = false;
      if (live) {
        const quiet = old.state === 'idle' && !old.pendingTag;
        inUse = collaborating || !quiet || !this.untouched(old, record, replyAfter(old, record.tag, record.requestedAt));
      }
      // NAW cannot see a prompt typed but not sent in the native terminal: keep the screen first,
      // and keep the old session if its screen cannot be saved.
      let unsaved = false, stoppedHere = false, keptAtStop = null;
      if (live && !inUse && old.terminalInputPending === true) {
        try {
          record.terminalFile = await this.saveTerminal(oldId);
        } catch {
          inUse = true;
          unsaved = true;
        }
      }
      // Fresh state before anything changes: a session used meanwhile keeps its spaces and process.
      if (live && !inUse && await this.touchedSince(oldId, old)) {
        inUse = true;
      }
      if (live && !inUse) {
        for (const roomId of record.roomIds) {
          try {
            await withTimeout(this.roomState.membership(this.client, oldId, false, record.name, roomId), CALL_TIMEOUT_MS, 'leave-timeout');
          } catch {
            // Leaving is cosmetic; ending the old process is what frees memory.
          }
        }
        const seen = {};
        if (await this.touchedSince(oldId, old, seen)) {
          inUse = true;
        } else {
          keptAtStop = await this.stopUnchanged(oldId, seen.latest, scoped);
          inUse = Boolean(keptAtStop);
          stoppedHere = !inUse;
        }
      }
      if (!record.oldId) {
        record.oldId = oldId;
      }
      const outcome = inUse ? 'kept' : 'done';
      const oldLabel = this.label(oldId, record.name);
      const newLabel = this.label(record.newId, record.newName || record.name);
      const extra = {};
      if (record.terminalFile) {
        extra.terminal = record.terminalFile;
      }
      if (unsaved) {
        extra.reason = 'terminal-unsaved';
      }
      if (keptAtStop) {
        extra.reason = keptAtStop;
      }
      const doneEntry = this.appendLog(outcome, record, extra);
      this.roomState.rotationEvent(record.roomIds, inUse ? 'oldKept' : 'done', oldLabel, newLabel);
      let notice = outcome;
      if (outcome === 'done' && record.terminalFile) {
        notice = 'saved';
      }
      if (unsaved) {
        notice = 'keptUnsaved';
      }
      this.notify(notice, record);
      if (inUse) {
        this.rotations[oldId] = { phase: 'kept', keptAt: now, oldNativeId: record.oldNativeId, name: record.name, roomIds: record.roomIds };
      } else {
        delete this.rotations[oldId];
      }
      // The successor is not rotated again for a day, whatever its size, except for its own compactions: no replacement loop.
      if (validId(record.newNativeId || '')) {
        this.rotations[record.newId] = { phase: 'kept', keptAt: now, oldNativeId: record.newNativeId, name: record.newName || record.name, roomIds: record.roomIds, successorOf: oldId };
      }
      this.save();
      // Handed over and stopped here: out of the person's list of sessions too (11-12, 「独立会话里还有不需要的会话就自动归档吧」).
      // After the rotation is saved, so a quit while it waits leaves it to the next start's check. One that was not
      // running (ended, or in the native background) is left to that check too.
      const result = stoppedHere && await this.archiveOld(oldId, oldLabel, () => this.recordArchive(doneEntry, oldLabel, newLabel));
      if (result) {
        this.recordArchive(doneEntry, oldLabel, newLabel, result === 'already');
      }
      await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
      await this.broadcast();
    }
  }
}

module.exports = {
  CAPABILITY,
  ITEM_TEXT_LIMIT,
  ITEM_REPLY_LIMIT,
  QUEUE_LIMIT,
  IDLE_SETTLE_MS,
  HUMAN_QUIET_MS,
  ANSWER_QUIET_MS,
  ROTATE_AFTER_MS,
  CONTENT_LIMITS,
  QUIET_BEFORE_ROTATE_MS,
  COMPACT_LIMIT,
  QUIET_COMPACT_MS,
  PLANNER_WAITING,
  DECISIONS_LIMIT,
  openDecision,
  openDecisions,
  decisionsNote,
  replyLine,
  rotationSubjects,
  NOT_SENT_ATTEMPTS,
  NATIVE_DRAFT_KEY,
  INTEGRATOR_ABSENT_MS,
  validateQueue,
  newItem,
  trimQueue,
  sessionReady,
  queueVacancies,
  planDispatch,
  rotationCauseKey,
  rotationCause,
  replyAfter,
  startsWithDecision,
  AUTOMATIC_ORIGINS,
  automaticInput,
  assigneeRefusal,
  UNCONFIRMED_SEND_MS,
  dispatchText,
  handoffRequestText,
  handoffText,
  shortText,
  decisionLine,
  reportTitle,
  readyLine,
  validReady,
  notSent,
  readRotations,
  processMemory,
  memoryPressure,
  saveTerminalScreen,
  nextBackendMove,
  moveWait,
  quietFor,
  MIGRATE_QUIET_MS,
  MIGRATE_UNPROVEN_QUIET_MS,
  migrationReady,
  sessionStart,
  lastActivityOf,
  reportedModel,
  carrySettings,
  transcriptModel,
  settingsMismatch,
  ROTATION_CAPABILITY,
  CREATE_SETTINGS_CAPABILITY,
  CREATE_PROFILE_CAPABILITY,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_EFFORTS,
  MEMORY_LIMIT_BYTES,
  PRESSURE_LIMIT_BYTES,
  MEMORY_MIN_AGE_MS,
  terminalReplyOnly,
  nextName,
  rotationChains,
  QueueDispatcher,
  nawMadeDirectory,
  directoryHandoff,
};
