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
const { managerText } = require('./manager-notices.cjs');
const { codexQuotaBlock } = require('./native-usage.js');
const { rotationBlocked, rotationEpoch, queuePurposeValid } = require('./submission-policy.cjs');
const { detached } = require('./background-operation.cjs');
const { CompactionCounter, claudeFiles, claudeProjects } = require('./compaction-count.cjs');
const { sessionPlan, sameStop, endedByThisStop, readRecords } = require('./backend-switch.cjs');
const { successor, rotationEdges } = require('./queue-secretary.cjs');
const { interrupt: terminalInterrupt } = require('./terminal-interrupt.cjs');

const CAPABILITY = 'queueDispatchInputV1';
// Backends before the checked-input packet: lifecycle and integrator sends only, which keep the draft gate.
const LEGACY_CAPABILITY = 'queueDispatchV1';
const ROTATION_CAPABILITY = 'rotationControlEpochV1';
const ITEM_TEXT_LIMIT = 6000;
// Messages the person may leave with one handoff (holdMessage); past it they go on as before.
const HELD_LIMIT = 20;
// A held send that did not go is tried again after this.
const HELD_RETRY_MS = 30 * 1000;
// One message carries it all (workspace.cjs cleanText); past it the composer keeps the words.
const HELD_TEXT_LIMIT = 16000;
// Blocked this long (no window that controls the receiver, or refused), or nothing left to take it: given back.
const HELD_RETURN_MS = 10 * 60 * 1000;
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
// Keys in a terminal are written down at most this often.
const TYPED_SAVE_MS = 5000;
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
// A Claude member this large continues in a new session before its next item while its prompt cache is still warm
// (the person, 2026-11-24). A replay of seven days of the person's own records: 13-17% fewer compactions in the middle of
// work and 0.4-1.3% less cost where the CLI compacts at 267K, 7-8% and 0-0.5% at 217K; a smaller limit rotates more for
// the same. Codex is not listed: its cache is kept longer and what a rotation would save there is not measured.
const CONTEXT_LIMITS = { claude: 180000 };
// Of the cache lifetime its last request was billed at: past this the handoff itself could miss the cache.
const CONTEXT_WARM_SHARE = 0.9;
// With no item waiting it does, the butler too, only once idle for this long (R221): nearly cold, so that whoever writes to
// it next pays for a small conversation, and before the CLI compacts it by itself at 0.9 of an hour.
const QUIET_CONTEXT_MS = 45 * 60 * 1000;
// Two looks at what is held for a migration window (session-wake.cjs QUIET_CHECK_MS): from one that closed on, what
// was held for its sessions has reached them by then, and they are no longer idle.
const QUIET_WINDOW_CLOSED_MS = 2 * 60 * 1000;
// A new member that never becomes ready (for example a startup prompt) ends the rotation.
const NEW_SESSION_READY_MS = 10 * 60 * 1000;
// The window client refuses a space pause or a member move while NAW replaces one backend (after an install,
// one backend a minute). Nothing was changed, or the change is found again: the caller asks again later.
const BACKEND_UPDATING_KEYS = new Set(['error.client.connectionUpdatingNoInput', 'error.client.connectionChangedNoReplay',
  'error.client.spacePauseUnconfirmed']);
// A pass that finds the handoff message still undelivered, or its successor's process gone, after this long gives it up.
const HANDOFF_ACCEPT_MS = 2 * 60 * 1000;
// Once delivered, its first turn has this long, approvals included. 125 recorded first turns: median 0.6 minutes, longest 13.3.
const HANDOFF_TURN_MS = 30 * 60 * 1000;
// A confirmed rotation kept from ending its old session by NAW's own work or a space's is told to the person after this.
const STOP_WAIT_MS = 30 * 60 * 1000;
// A step of a waiting rotation that had an effect or was refused is tried again after this.
const FINISH_RETRY_MS = 60 * 1000;
// Each step of passing on what changed after the handoff holds the two sessions back for at most this long.
const TELL_HOLD_MS = 10 * 60 * 1000;
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
// A sent item's member this long in 'error' with nothing continuing it is told to the butler's record (noteErrorStalls).
const ERROR_STALL_MS = 3 * 60 * 1000;
// States a live session has only once it took something up again after 'error'.
const RAN_STATES = ['working', 'approval', 'background', 'idle'];
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
const PERSON_TYPING_KEY = 'error.queue.personTyping';
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
// Told to the person at once: they are using the old session, or it holds what they have not sent.
const PERSON_GATES = ['control-changed', 'person-input', 'person-message', 'person-typing', 'person-quiet', 'terminal-input', 'terminal-unsaved'];
const OUT_STATES = ['ended', 'background', 'recoverable'];
const TELL_STATES = ['asking', 'asked', 'ready', 'sending', 'sent'];
// A confirmed rotation whose old session could not be ended yet (R206, 2026-11-24: 「一旦错过就不再继续,这个肯定不行」).
// The phase stays one every version reads; what it waits for is on the record. It takes no rotation slot and keeps no
// work from either session, until the old one is free and is ended (advanceWaiting).
function waitingOld(record) {
  return record?.phase === 'handed' && record.handoffConfirmed === true && validTime(record.waitSince);
}
// Only while NAW passes on what changed after the handoff, and not for long, does it keep other work from the two.
function tellingSessions(id, record) {
  const s = waitingOld(record) ? record.supplement : undefined;
  if (!s) return [];
  const to = s.toId ?? record.newId;
  // In hand, it goes to the successor before its next item; a successor that cannot be sent a message gets no item either.
  if (s.state === 'ready') return s.failed || s.stays ? [] : s.released ? [to] : [id, to];
  if (s.released) return [];
  return ['asking', 'asked'].includes(s.state) ? [id] : [id, to];
}
// Rows of a conversation: the person's, NAW's and the agent's own.
function conversation(session) {
  return (session?.messages || []).filter(m => m && (m.role === 'user' || m.role === 'assistant'));
}
const personRow = m => m.role === 'user' && !automaticInput(m);
const personSince = (session, at) => conversation(session).some(m => personRow(m) && Number(m.time) > at);
function seenRow(session, now) {
  const last = conversation(session).at(-1);
  return { id: validId(last?.id) ? last.id : null, at: now };
}
// The last row a handoff covers, for a record written before it was kept: its request's own reply.
function handoffSeen(session, record) {
  const rows = conversation(session), at = record.creatingAt ?? record.requestedAt ?? 0;
  let end = rows.findLastIndex(m => m.id === record.tag);
  if (end < 0) return { id: null, at };
  while (rows[end + 1]?.role === 'assistant') end += 1;
  return { id: rows[end].id, at };
}
// Rows after it. A native record may have replaced that row: then by time, and one without a time counts.
function rowsSince(session, seen) {
  const rows = conversation(session), at = seen.id === null ? -1 : rows.findLastIndex(m => m.id === seen.id);
  return at >= 0 ? rows.slice(at + 1) : rows.filter(m => !(Number(m.time) <= seen.at));
}
// What the old session wrote to NAW's one request, up to the next input of any kind, and the last row that covers.
function supplementReply(session, ask, now) {
  const rows = conversation(session), at = rows.findLastIndex(m => m.id === ask.tag || m.dispatchItem === ask.item);
  let after = at >= 0 ? rows.slice(at + 1) : rows.filter(m => Number(m.time) >= ask.at);
  while (at < 0 && after[0]?.role === 'user') after = after.slice(1);
  const next = after.findIndex(m => m.role === 'user'), own = next < 0 ? after : after.slice(0, next);
  const last = own.at(-1) ?? rows[at], later = next < 0 ? NaN : Number(after[next].time);
  return { text: own.map(m => m.text).filter(text => typeof text === 'string' && text.trim()).join('\n\n'), more: next >= 0,
    seen: { id: validId(last?.id) ? last.id : null, at: Number.isFinite(later) ? Math.min(now, later - 1) : now } };
}
// A time shown to the minute: a windows' row does not change with every key the person types.
const wholeMinute = at => Math.ceil(at / 60000) * 60000;
// A rotation asked for by hand, or its withdrawal (R207): when, and by whom.
const validAsk = value => dictionary(value) && validTime(value.at) && ['person', 'steward'].includes(value.by);
function readRequests(value) {
  const requests = {};
  for (const [id, request] of Object.entries(dictionary(value) ? value : {})) {
    if (validId(id) && validAsk(request) && (request.nativeId === null || validId(request.nativeId))) {
      requests[id] = { at: request.at, by: request.by, nativeId: request.nativeId };
    }
  }
  return requests;
}
// When the person last typed in a Codex terminal (noteTyped).
function readTyped(value) {
  const typed = {};
  for (const [id, mark] of Object.entries(dictionary(value) ? value : {})) {
    if (validId(id) && dictionary(mark) && validTime(mark.at)) {
      typed[id] = { at: mark.at };
    }
  }
  return typed;
}
// What the person sent from NAW while a handoff was written, by the rotation's old id (holdMessage).
function readHeld(value) {
  const held = {};
  for (const [id, entry] of Object.entries(dictionary(value) ? value : {})) {
    if (!validId(id) || !dictionary(entry) || !Array.isArray(entry.items)) continue;
    const items = [];
    for (const item of entry.items) {
      if (dictionary(item) && validTime(item.at) && typeof item.text === 'string' && item.text.trim()) items.push(heldItem(item));
    }
    if (!items.length) continue;
    held[id] = { items, oldNativeId: validId(entry.oldNativeId) ? entry.oldNativeId : null };
    if (dictionary(entry.to) && validId(entry.to.id)) held[id].to = { id: entry.to.id, nativeId: validId(entry.to.nativeId) ? entry.to.nativeId : null };
    if (validTime(entry.tried)) held[id].tried = entry.tried;
    if (validTime(entry.blockedSince)) held[id].blockedSince = entry.blockedSince;
    if (typeof entry.name === 'string') held[id].name = entry.name;
    if (Array.isArray(entry.roomIds) && entry.roomIds.every(room => typeof room === 'string')) held[id].roomIds = [...entry.roomIds];
  }
  return held;
}
// Which session the person addressed and from which window (view owner): where the words go back if they cannot go.
function heldItem(item) {
  return { at: item.at, text: item.text, ...(validId(item.session) ? { session: item.session } : {}), ...(typeof item.from === 'string' && item.from ? { from: item.from } : {}),
    ...(typeof item.name === 'string' ? { name: item.name } : {}) };
}
// Words being given back to the person's window, one copy each (main.cjs giveBackHeld).
function readReturning(value) {
  return (Array.isArray(value) ? value : []).filter(item => dictionary(item) && validTime(item.at) && typeof item.text === 'string' && item.text.trim() && validId(item.session)).map(heldItem);
}
// How the person's composer would send to it now (renderer sessionInputMethod), or null while it can take nothing.
function heldMethod(session) {
  if (session.state === 'idle') return ['send'];
  if (session.state !== 'working') return null;
  if (session.queueAvailable) return ['queue'];
  if (session.steerAvailable && session.activeTurnId) return ['steer', session.activeTurnId];
  return null;
}
// The turn of NAW's own request to write the handoff, if it was interrupted.
function cutTurn(session, tag) {
  const input = session.messages.find(m => m.id === tag);
  return validId(input?.turnId) && session.messages.find(m => m.kind === 'turn' && m.nativeId === session.nativeId && m.turnId === input.turnId && m.status === 'interrupted');
}
// What an unreadable waiting record loses is asked for again; none of it ends a session on its own.
function cleanWait(record) {
  const seen = value => dictionary(value) && (value.id === null || validId(value.id)) && validTime(value.at);
  for (const key of ['waitSince', 'usedAt', 'typedAt', 'controlAt']) if (record[key] !== undefined && !validTime(record[key])) delete record[key];
  for (const key of ['person', 'withdrawn', 'stopped']) if (record[key] !== undefined && !validAsk(record[key])) delete record[key];
  if (record.seen !== undefined && !seen(record.seen)) delete record.seen;
  for (const key of ['gates', 'left']) if (!Array.isArray(record[key]) || !record[key].every(value => typeof value === 'string')) delete record[key];
  const m = record.missed, s = record.supplement;
  if (m !== undefined && !(dictionary(m) && validTime(m.at) && Number.isSafeInteger(m.tries) && m.tries > 0)) delete record.missed;
  if (s !== undefined && !(dictionary(s) && TELL_STATES.includes(s.state) && validTrustReceipt(s.id) && validTime(s.at) &&
      (['asking', 'asked'].includes(s.state) ? typeof s.item === 'string' : typeof s.text === 'string' && seen(s.seen)) &&
      (!['sending', 'sent'].includes(s.state) || typeof s.toItem === 'string'))) delete record.supplement;
}
// The active backend can start a session with given settings (workspace.cjs createSettings).
const CREATE_SETTINGS_CAPABILITY = 'createSettingsV1';
// ... and from one of the person's Codex profiles (DeepSeek pro / flash, codex-profile.cjs).
const CREATE_PROFILE_CAPABILITY = 'createSettingsProfileV1';
// What a new session can be started with; must match workspace.cjs (a test compares them).
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const BYPASS = 'bypassPermissions';
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
// Told of an item the butler queued that is done, it clears the butler's run to that member (session-wake.cjs queueDone).
const QUEUE_DONE_CAPABILITY = 'agentWakeQueueDoneV1';
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
function unusedRotationSuccessor(session) {
  return session?.nativeId && !session.nativeContextPending && !session.nativeContexts?.length &&
    !session.backendUnavailable && !session.transportDisconnected && !session.liveDraft &&
    !session.activeTurnId && !session.pendingTag && !session.pendingQueue && !session.pendingSteer &&
    !session.nativeInputRequired && !session.approval && !session.nativeApproval?.requests?.length && !session.interruptPending &&
    session.nativeGoal?.status !== 'active' && session.nativeGoal?.known !== false &&
    !(session.background > 0) && !(session.scheduled > 0) && !session.fleet?.length &&
    Array.isArray(session.messages) && session.messages.every(message => message.role === 'system' && !message.turnId);
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

// allowDraft: a queue item or butler wake, sent beside an unchanged composer draft (workspace.cjs expectedInput).
// An old-only backend cannot check the input, so it keeps alpha.307's rules: sent unchecked, and a draft holds it.
function sessionReady(session, wakePolicy, allowDraft = false) {
  if (!session) {
    return { ready: false, reason: 'missing' };
  }
  if (session.archived) {
    return { ready: false, reason: 'archived' };
  }
  if (!Array.isArray(session.serviceCapabilities) || !(session.serviceCapabilities.includes(CAPABILITY) ||
      session.serviceCapabilities.includes(LEGACY_CAPABILITY))) {
    return { ready: false, reason: 'backend-update-needed' };
  }
  const beside = allowDraft && session.serviceCapabilities.includes(CAPABILITY);
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
  if (!beside && typeof session.liveDraft === 'string' && session.liveDraft.trim()) {
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

// The session as if its backend were in no quiet window.
const pastWindow = session => session && { ...session, quietWindow: undefined };
// For the person's answer on its own card: nor a command or timer of its own in the background, reported or not.
const pastClick = session => session && { ...pastWindow(session), backgroundStale: false, background: 0, scheduled: 0 };
// Its turn, a question of its own on screen, or the moment after: the rest of not-idle and busy does not end by itself.
const ownTurn = (session, reason) => reason === 'not-settled' ||
  reason === 'not-idle' && ['working', 'approval'].includes(session?.state) ||
  reason === 'busy' && Boolean(session && (session.approval || session.claudeQuestion || session.nativeInputRequired));

// While a session works, what else holds it now (2026-11-23: a draft held the butler 258 minutes, read as not-idle in
// each of its own turns). busy stays not-idle: an approval or question flagged on the session belongs to the turn (a
// native permission prompt sets no flag). So do its own delivery and Claude's background report, stale until the turn
// ends (workspace.cjs 'working'); R198: they hid a quiet window.
function heldReason(session, wakePolicy, allowDraft = false) {
  const reason = sessionReady(session, wakePolicy, allowDraft).reason;
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
  const after = sessionReady(ended, wakePolicy, allowDraft).reason;
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
    ...(messages[index]?.status === 'unconfirmed' ? { unconfirmed: true } : {}),
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

// The mode Claude reports as 'default' is asked for as 'manual'; not asked for, it starts in the person's own default.
function launchMode(reported) {
  return reported === 'default' ? 'manual' : reported;
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
    const mode = launchMode(session.nativePermissionMode);
    if (mode) {
      if (!CLAUDE_PERMISSION_MODES.includes(mode)) {
        return { reason: 'permission-mode' };
      }
      settings.permissionMode = mode;
    }
  } else {
    const native = session.nativeSettings || {};
    // Native names its ordinary mode once the model has been changed in the thread.
    if (native.mode && native.mode !== 'default') {
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
    if (carry.permissionMode && fresh.nativePermissionMode && launchMode(fresh.nativePermissionMode) !== carry.permissionMode) {
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

// Why a member is due for rotation now: 'content', 'compact', 'context', 'memory' or null. `contextIdleMs`: how long ago the
// last request must be for 'context'; without it there is no such reason.
function rotationReason(session, now, options, rotations, contextIdleMs = null) {
  if (!['claude', 'codex'].includes(session.provider) || rotationHold(session, options, rotations)) {
    return null;
  }
  return dueReason(session, now, options, rotations[session.id], contextIdleMs);
}

// Large, still warm, and old enough to have done an item: a successor that read a lot in its first turn would
// otherwise be replaced before it does any.
function contextDue(session, now, options, idleMs) {
  const limit = options.contextLimits ? options.contextLimits[session.provider] : undefined;
  const context = options.contexts ? options.contexts.get(session.id) : undefined;
  if (!Number.isFinite(limit) || !context || !Number.isSafeInteger(context.tokens) || context.tokens < limit ||
      !Number.isFinite(context.at) || !Number.isFinite(context.ttlMs)) {
    return false;
  }
  const idle = now - context.at, start = sessionStart(session, now);
  return idle >= idleMs && idle < context.ttlMs * CONTEXT_WARM_SHARE && start !== null && now - start >= options.memoryMinAgeMs;
}

// The reason alone, whatever rotationHold says; `record` is the session's own resting record, if any.
function dueReason(session, now, options, record, contextIdleMs = null) {
  const limit = options.contentLimits ? options.contentLimits[session.provider] : undefined;
  if (!record && Number.isFinite(limit) && recordCount(session) >= limit) {
    return 'content';
  }
  const compactions = options.compactions ? options.compactions.get(session.id) : undefined;
  if (Number.isSafeInteger(compactions) && Number.isSafeInteger(options.compactLimit) && options.compactLimit > 0 && compactions >= options.compactLimit) {
    return 'compact';
  }
  if (contextIdleMs !== null && contextDue(session, now, options, contextIdleMs)) {
    return 'context';
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
// rotation that is not at rest or waiting for its old session (and a successor it has not confirmed), one in a running space
// exchange, and one a queue item holds (holdsMember). The same rule as the planner's and the vacancy
// projection's own.
function engagedSessions(rotations, rooms) {
  const busy = new Set();
  for (const [id, rotation] of Object.entries(rotations || {})) {
    if (quarantinedSuccessor(rotation) && rotation.newId !== id) busy.add(rotation.newId);
    for (const held of tellingSessions(id, rotation)) busy.add(held);
    if (rotation && !RESTING_PHASES.includes(rotation.phase) && !waitingOld(rotation)) {
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
  for (const id of Array.isArray(input.modelChanges) ? input.modelChanges : []) busy.add(id);
  for (const id of input.heldSessions || []) busy.add(id);
  if (input.quarantineUnknown) for (const session of input.sessions || []) busy.add(session.id);
  for (const [id, rotation] of Object.entries(input.rotations || {})) {
    if (quarantinedSuccessor(rotation) && rotation.newId !== id) busy.add(rotation.newId);
    for (const held of tellingSessions(id, rotation)) busy.add(held);
    if (rotation && !RESTING_PHASES.includes(rotation.phase) && !waitingOld(rotation)) {
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
        sessionReady(session, input.wakePolicy, true).ready &&
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
  const quietContextMs = input.quietContextMs ?? QUIET_CONTEXT_MS;
  const rotationOptions = {
    blockedRotations: input.blockedRotations,
    // Filled in step 1: members whose next item is marked afterDecision (asksPerson), and those whose open
    // decisions cannot all be handed over: too long to tell whole (DECISIONS_LIMIT), or in a space they have left.
    asking: new Set(),
    decisionsStay: new Set(),
    contentLimits,
    compactions: input.compactions,
    compactLimit: input.compactLimit ?? COMPACT_LIMIT,
    contexts: input.contexts,
    contextLimits: input.contextLimits ?? CONTEXT_LIMITS,
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
    if (!sessionReady(session, input.wakePolicy, true).ready) {
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
  // Sent items this pass leaves open because their member is not at rest (filled when the caller passes a Map).
  const openItems = input.openItems instanceof Map ? input.openItems : null;
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
  // The person is changing this session's model: it is about to be stopped and resumed.
  for (const id of Array.isArray(input.modelChanges) ? input.modelChanges : []) hold(id, 'model-change');
  for (const id of input.heldSessions || []) hold(id, 'trust-hold');
  if (input.quarantineUnknown) for (const session of sessions) hold(session.id, 'trust-unknown');
  let rotationSlots = MAX_ACTIVE_ROTATIONS;
  for (const id of Object.keys(rotations)) {
    const record = rotations[id];
    if (quarantinedSuccessor(record) && record.newId !== id) hold(record.newId, 'trust-hold');
    if (waitingOld(record)) {
      for (const held of tellingSessions(id, record)) hold(held, 'rotating');
      const session = byId.get(id);
      if (gates && session) gates.set(id, { gate: record.gate || 'old-session', reason: record.reason || 'content' });
    } else if (record && !RESTING_PHASES.includes(record.phase)) {
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
    const ready = sessionReady(byId.get(id), input.wakePolicy, true);
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
        openItems?.set(item.id, { member, tag: item.tag });
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
      } else if (reply.unconfirmed && !reply.last.trim()) {
        status = 'failed';
        reason = 'send-unconfirmed';
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
  // 1b) A rotation asked for by hand (R207) goes before queued items and before those that came due: no size check, no
  // quiet wait. Only what a rotation never cuts holds it. `requests`: id -> why no successor can match it, or ''.
  const requests = input.requests instanceof Map ? input.requests : new Map();
  function requestGate(id, refusal) {
    if (busy.has(id)) {
      return why.get(id) || 'busy';
    }
    if (rotationOptions.blockedRotations?.has(id)) {
      return 'trust-fault';
    }
    const session = byId.get(id);
    const readiness = sessionReady(session, input.wakePolicy);
    if (!readiness.ready) {
      return readiness.reason;
    }
    if (rotationOptions.decisionsStay.has(id)) {
      return 'decisions-stay';
    }
    if (refusal) {
      return refusal;
    }
    if (!settled(id, idleSince, now, settleMs) && !quietFor(session, new Map(), now, settleMs)) {
      return 'settling';
    }
    return rotationSlots > 0 ? '' : 'no-slot';
  }
  for (const [id, refusal] of requests) {
    const gate = requestGate(id, refusal);
    if (!gate) {
      rotationSlots -= 1;
      hold(id, 'rotating');
      actions.push({ kind: 'rotate', sessionId: id, reason: 'person' });
      continue;
    }
    input.requestGates?.set(id, gate);
    if (['settling', 'no-slot'].includes(gate)) {
      // About to be rotated: no new item, and no wake, first.
      input.quietPending?.set(id, 'person');
      hold(id, 'rotating');
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
      const allowed = candidates.filter(id => managerItemMayGo(item, id, input.managers, input.earlier?.(id)));
      if (candidates.length && !allowed.length) {
        waits?.set(item.id, candidates.map(sessionId => ({ sessionId, reason: 'manager-item' })));
        continue;
      }
      candidates = allowed;
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
      const asked = requests.has(target.id);
      // A member with a draft takes the item and is not rotated (R207): rotation keeps the strict readiness.
      const strict = sessionReady(target, input.wakePolicy);
      const reason = asked ? null : rotationReason(target, now, rotationOptions, rotations, 0);
      if (!asked) {
        stalled(target.id, !reason ? rotationHold(target, rotationOptions, rotations) : strict.ready ? 'no-slot' : strict.reason);
      }
      if (reason && strict.ready && rotationSlots > 0) {
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
      if (requests.has(id)) {
        continue;
      }
      if (busy.has(id)) {
        stalled(id, why.get(id) || 'busy');
        continue;
      }
      const session = byId.get(id);
      // Ten or thirty quiet minutes already settle the member; the 8-second idle timer is not needed.
      const readiness = sessionReady(session, input.wakePolicy);
      const ready = readiness.ready && !humanRecent(id, humanAt, now, humanQuietMs);
      const lastActivity = lastActivityOf(session, now);
      // No reason at all until it has been idle that long: it holds no wake, and no other reason's quiet.
      const contextIdleMs = lastActivity !== null && now - lastActivity >= quietContextMs && !session.quietWindowClosed ? quietContextMs : null;
      const reason = ready ? rotationReason(session, now, rotationOptions, rotations, contextIdleMs) : null;
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
      if (lastActivity === null) {
        stalled(id, 'activity-unknown');
        continue;
      }
      let quiet = quietMs;
      if (reason === 'memory') {
        quiet = quietMemoryMs;
      } else if (reason === 'compact' && id === input.butler) {
        quiet = quietCompactMs;
      } else if (reason === 'context') {
        quiet = quietContextMs;
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
  if (reason === 'context') action.contextTokens = options.contexts.get(sessionId).tokens;
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

// What a space's project manager added goes to no project manager and not back to itself: an agent's own item must
// not start it again, directly or through another manager. `managers`: session id → the space it manages; null, a
// record that cannot be read, holds such items. `earlier`: the sessions this one continues from.
function managerItemMayGo(item, sessionId, managers = new Map(), earlier = []) {
  if (item.creator?.kind !== 'secretary' || item.addedBy === 'steward') {
    return true;
  }
  return managers !== null && [sessionId, ...earlier].every(id => !managers.has(id) && item.creator.sessionId !== id);
}

// With every item sent to a space's project manager; nothing is sent to it only to say this.
const MANAGER_NOTE = '你是这个空间的项目经理（人指定的）：只管这个空间的事。要交给成员做的，用 workspace_control 的 spaceAction queueAdd 加到本空间队列（不能加给自己或别的项目经理），NAW 会派给空闲的成员；取消、标记已处理和成员管理归人和大管家。';

const NOTES_HEAD = '附：这个空间的共享笔记（人打开了「派活时附上这份笔记」；这是背景，要做的仍是上面这一件）：';
const NOTES_CUT = '（笔记太长，这里只附了开头；全文在这个空间的共享笔记里。）';

function dispatchText(roomName, item, notes = '', manager = false) {
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
    ...(manager ? [MANAGER_NOTE] : []),
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
  [/^handoff-interrupted$/, 'handoffInterrupted'],
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
// The old session is let go at once: nothing rests and nothing holds it (deferRotation).
const RELEASED_REASONS = ['person-active', 'handoff-interrupted'];
const ROTATION_FAILURE_CODES = new Set([...RELEASED_REASONS, 'handoff-missing', 'handoff-request-unconfirmed',
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
function rotationWhyNotice(reason, records, bytes, compactions, contextTokens, by) {
  if (reason === 'person') {
    return uiNotice(by === 'steward' ? 'notice.rotation.why.butler' : 'notice.rotation.why.person');
  }
  if (reason === 'memory') {
    return uiNotice('notice.rotation.why.memory', { gb: (bytes / 1073741824).toFixed(1) });
  }
  if (reason === 'compact') {
    return uiNotice('notice.rotation.why.compact', { count: String(compactions) });
  }
  if (reason === 'context') {
    return uiNotice('notice.rotation.why.context', { count: String(Math.round(contextTokens / 1000)) });
  }
  return uiNotice('notice.rotation.why.content', { count: String(records) });
}

function handoffRequestText(why, reason) {
  const purpose = reason === 'person' ? '' : ['compact', 'context'].includes(reason) ? '为了不再一次次压缩上下文，' : '为了释放内存，';
  return [
    `【NAW 换会话】${why}。${purpose}NAW 会开一个新会话接着做，这个会话随后结束（记录保留，可以恢复）。`,
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
// Sent before NAW knows when the old session ends: what it says about the old one holds either way. While the person
// uses the old one it waits for them (advanceWaiting); the space's work goes on to the successor (carriedOn), and the
// butler designation follows the rotation once that is done (queue-secretary.cjs successor).
// `decisions`: decisionsNote of the old session's open decisions. It stands right after the old session's own
// text, whole: only that text is shortened.
function handoffText(oldName, handoff, directoryNote = '', duty = '', decisions = '', solo = false) {
  const after = solo
    ? '旧会话交完就结束；要是它交接之后又有新内容，NAW 把之后变了的补给你，再结束它。'
    : duty
    ? '旧会话交完就结束，大管家由你接着当；要是人这时还在用旧会话，大管家先仍是它，等人用完，NAW 把之后变了的补给你，再结束它、由你接着当。'
    : '旧会话交完就结束；要是人这时还在用它，这个空间里没指定成员的活 NAW 先派给你，等人用完，NAW 把之后变了的补给你，再结束它。';
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
  return fitted(text, handoff);
}

function fitted(text, body) {
  const left = SEND_TEXT_LIMIT - text('').length;
  if (body.length <= left) {
    return text(body);
  }
  // Cut before a character, never between the two halves of one.
  let end = Math.max(0, left - 1);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(body[end - 1])) {
    end -= 1;
  }
  return text(body.slice(0, end) + '…');
}

// Asked of an old session that went on after its handoff, once for each time it did; its answer goes to the successor.
function supplementRequestText(newName) {
  return [
    `【NAW 换会话】你的工作已经交给「${newName}」，交接之后这个会话又有了新内容。`,
    '',
    '请现在只补一段：交接之后变了什么，包括人说了什么、你做了什么、还有什么没做完或待人决定。没有变化就直说没有。不要重写交接，不要开始新工作。',
    'NAW 会把这一段送给它，然后结束这个会话（记录保留，可以恢复）。',
  ].join('\n');
}

const SUPPLEMENT_NONE = '（旧会话没有补写就结束了；它交接之后的内容在它自己的记录里。）';
function supplementText(oldName, supplement, decisions = '') {
  return fitted(body => [
    `【NAW 换会话】你接手的「${oldName}」在交接之后又有新内容，它补的一段如下：`,
    '',
    body,
    '',
    ...(decisions ? [decisions, ''] : []),
    '把这一段并进你手上的交接（核对只读即可），然后结束本轮，不留后台等待。',
  ].join('\n'), supplement);
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

// The same rules as workspace.cjs isTerminalResponse (a unit test keeps them equal) except
// the wheel, which here still counts as the person using the session.
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
  // asked, withdrawn, dropped: a rotation asked for by hand (R207). handed: the successor confirmed its handoff (R254).
  if (!['asked', 'withdrawn', 'dropped', 'requested', 'handed', 'done', 'kept', 'failed', 'waiting', 'archived'].includes(entry.event) || !Number.isFinite(entry.time)) {
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
// (nextBackendMove) and for what version-events.cjs tells the butler and that manager each backend waits for.
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
  faults.requests = readRequests(data.requests);
  faults.withdrawals = readRequests(data.withdrawals);
  faults.typed = readTyped(data.typed);
  faults.held = readHeld(data.held);
  faults.returning = readReturning(data.returning);
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
    cleanWait(record);
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
    // Only the window that controls a session sends to it as the person (workspace.cjs send, takeControlFirst).
    this.ownerClient = options.ownerClient || (() => this.clients());
    this.connect = options.connect;
    this.labels = options.labels || new Map();
    this.creationDefaults = options.creationDefaults || (() => ({}));
    // The sessions whose model the person is changing (model-change.cjs): no new item or rotation meanwhile.
    this.modelChanges = options.modelChanges || (() => []);
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
    this.contextLimits = options.contextLimits ?? CONTEXT_LIMITS;
    this.quietCompactMs = options.quietCompactMs ?? QUIET_COMPACT_MS;
    this.quietContextMs = options.quietContextMs ?? QUIET_CONTEXT_MS;
    // Counts each member's own compactions from the native records (compaction-count.cjs); the app turns it on.
    this.compactions = options.compactions || (options.countCompactions === true ? new CompactionCounter() : null);
    // Told one line per stall and gate (noteRotationStalls); `stalls` holds since when, in memory only.
    this.rotationStalled = typeof options.rotationStalled === 'function' ? options.rotationStalled : null;
    this.stalls = new Map();
    // Told one line per stop of a sent item (noteErrorStalls); `errorStalls` holds since when, in memory only.
    this.errorStalled = typeof options.errorStalled === 'function' ? options.errorStalled : null;
    this.errorStalls = new Map();
    this.tickMs = options.tickMs ?? TICK_MS;
    this.transcriptRoot = options.transcriptRoot || claudeProjects();
    // Sessions whose model is known nowhere yet: asked again after a while, never rested for a week.
    this.unknownModelAt = new Map();
    // Rotations the person interrupted by using the old session: id -> { at, due } (in memory; see personDeferred).
    this.deferredAt = new Map();
    // When a waiting rotation's last step with an effect did not go through (FINISH_RETRY_MS).
    this.finishTried = new Map();
    // Since when a session of a waiting rotation has been out (outGate).
    this.outSince = new Map();
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
    // The last key the person typed in a session's terminal here.
    this.typedAt = new Map();
    this.typedSaved = new Map();
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
      // Kept for the next tick to look at managers' spaces with (observeManagers): no snapshot read of its own.
      if (this.managerNotices) this.stateSeen = snapshot;
      if (this.observePersonActions) this.observePersonActions(snapshot);
      if (this.observeQueueState) this.observeVacancyReadiness(snapshot, this.now());
    };
    this.rotationRead = {};
    this.rotations = readRotations(this.file, this.now(), this.rotationRead);
    this.rejectedRotations = { ...this.rotationRead.rejected };
    // Asked for by hand and not begun: id -> { at, by, nativeId }, kept in the rotations' file (R207).
    this.requests = this.rotationRead.requests || {};
    // What the person took back, kept until they next act on that session: the butler does not ask for it meanwhile.
    this.withdrawals = this.rotationRead.withdrawals || {};
    this.typed = this.rotationRead.typed || {};
    this.held = this.rotationRead.held || {};
    this.returning = this.rotationRead.returning || [];
    // Puts words back as a copy of that session's draft in the person's window; false while that window is closed.
    this.giveBack = options.giveBack || (() => false);
    this.requestGates = new Map();
    // When an unsent prompt in its own terminal refused the request (FINISH_RETRY_MS).
    this.requestTried = new Map();
    this.lastGates = new Map();
    this.rotationRows = {};
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
    // What a restart brought, owed to the former secretary's space's manager (version-events.cjs), or null; sent as answers are.
    this.versionNotices = options.versionNotices || null;
    // What changed in a space, owed to its project manager (manager-notices.cjs), or null; sent as answers are.
    this.managerNotices = options.managerNotices || null;
    // Each space's project manager now: { roomId: { sessionId, nativeId } } (space-managers.cjs). It may throw.
    this.managers = options.managers || (() => ({}));
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
    this.unlogged = null;
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      // The space record still carries the event when the private log cannot be written.
      this.unlogged = entry;
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
    // Its successor carries its work already, whatever its own session still waits for.
    for (const [id, record] of Object.entries(this.rotations)) {
      if (waitingOld(record) && !this.faultedRotations.has(id)) ids.set(id, (ids.get(id) || new Set()).add(record.newId));
    }
    return ids;
  }

  // The quiet the person's own use of a session is given before NAW replaces it.
  personQuiet(id, due, butler) {
    if (due === 'memory') return QUIET_MEMORY_MS;
    if (due === 'context') return this.quietContextMs;
    return due === 'compact' && id === butler ? this.quietCompactMs : this.quietMs;
  }

  // A rotation the person interrupted waits for the quiet that member's rotation already needs (30 minutes; 10 for
  // memory; 45 for its size; 2 for the butler's compaction), counted from the later of the interruption and the person's
  // own last use (noteHuman), so a queued item does not ask again while the person is still at it (the 11-14 drill,
  // finding 1). Not the session's last activity: NAW's own items kept a busy member fresh and it was never rotated (the
  // NAW dev PM, 11-23).
  personDeferred(sessions, butler, now) {
    const ids = new Set();
    for (const [id, entry] of this.deferredAt) {
      const session = sessions.find(s => s.id === id);
      const quiet = this.personQuiet(id, entry.due, butler);
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

  // Its successor in this space has its handoff and it is not ended yet.
  handingOver(id, roomId) {
    const record = this.rotations[id];
    return Boolean(record?.handoffConfirmed && !RESTING_PHASES.includes(record.phase) && record.roomIds?.includes(roomId));
  }

  // What `id` continues from, the sessions whose replacement is not finished included (waitingOld: one of them may wait
  // behind a successor that was itself replaced meanwhile).
  earlierSessions(id) {
    const ids = new Set([id]);
    // A Set goes on to what is added while it is walked.
    for (const at of ids) {
      for (const earlier of this.continuedFrom(at)) ids.add(earlier);
      for (const [oldId, record] of Object.entries(this.rotations)) {
        if (record.newId === at && !RESTING_PHASES.includes(record.phase)) ids.add(oldId);
      }
    }
    ids.delete(id);
    return [...ids];
  }

  // `steward` and the native sessions it continued from through done rotations, nearest first. A session whose native
  // session changed in place did not continue what that one had raised.
  holders(steward) {
    const line = [], listed = at => line.some(h => h.sessionId === at.sessionId && h.nativeId === at.nativeId);
    for (let at = steward; validId(at?.sessionId) && validId(at.nativeId) && !listed(at);) {
      const { sessionId, nativeId } = at;
      line.push({ sessionId, nativeId });
      const old = this.log.findLast(e => e.event === 'done' && e.new?.id === sessionId && e.new.nativeId === nativeId)?.old;
      at = old && { sessionId: old.id, nativeId: old.nativeId };
    }
    return line;
  }

  rotationChains() {
    if (!this.chainsCache) {
      try {
        const waiting = Object.entries(this.rotations).filter(([id, record]) => waitingOld(record) && !this.faultedRotations.has(id));
        this.chainsCache = rotationChains([...this.log, ...waiting.map(([id, record]) => ({ event: 'kept', time: record.confirmedAt ?? record.waitSince,
          spaces: record.roomIds, old: { id, nativeId: record.oldNativeId, name: record.name },
          new: { id: record.newId, nativeId: record.newNativeId || null, name: record.newName || null } }))]);
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
  async archiveOld(id, label, late, automaticCheck) {
    // Archived already (by the person, meanwhile): not NAW's to announce, but settled so a restore stays.
    if ((this.roomState.value.archivedSessions || []).includes(id)) {
      return 'already';
    }
    let waited = false;
    const archived = this.roomState.archiveSession(this.client, id, label, { automatic: true, automaticCheck })
      .then(() => (this.roomState.value.archivedSessions || []).includes(id), () => false);
    archived.then(done => {
      if (done && waited && !this.closed) {
        try {
          late?.();
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
      ...(Object.keys(this.requests).length ? { requests: this.requests } : {}),
      ...(Object.keys(this.withdrawals).length ? { withdrawals: this.withdrawals } : {}),
      ...(Object.keys(this.typed).length ? { typed: this.typed } : {}),
      ...(Object.keys(this.held).length ? { held: this.held } : {}),
      ...(this.returning.length ? { returning: this.returning } : {}),
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
    if (!this.closed && this.typedUnsaved) this.saveQuietly();
    this.closed = true;
    clearInterval(this.timer);
    this.listen(null);
    this.dropOwnClient();
  }

  // The person's own input, takeover or view of a session (main.cjs IPC); `viewOwner`: the window it came from.
  noteHuman(sessionId, method, data, viewOwner) {
    if (typeof sessionId === 'string' && sessionId) {
      const interrupt = method === 'interrupt' || method === 'input' && terminalInterrupt(data);
      this.humanAt.set(sessionId, this.now());
      if (method === 'input') this.typedAt.set(sessionId, this.now());
      if (method === 'input' && !interrupt) this.noteTyped(sessionId);
      if (interrupt || method === 'claim' && this.takenOver(sessionId, viewOwner)) this.noteStop(sessionId);
      // Their stop of a continuation the last pass saw scheduled is their decision, not a stall (noteErrorStalls).
      if (interrupt) {
        for (const stall of this.errorStalls.values()) if (stall.memberId === sessionId && stall.scheduled) stall.stopped = stall.scheduled;
      }
      this.vacancySince.delete(sessionId); this.vacancyIdentity.delete(sessionId);
      this.dirty = true;
    }
  }

  // Esc, an interrupt, or taking the session over from another window while the handoff is written: that rotation ends
  // with the turn. A look, keys and messages do not stop it (R207; for one that came due too, the person 2026-11-25:
  // 「hand over的时候要迅速，否则会被一直打断」). One asked for by hand is not asked for again; one that came due is,
  // once quiet (deferRotation).
  noteStop(sessionId) {
    const record = this.rotations[sessionId];
    if (record?.phase !== 'requested' || record.stopped) return;
    record.stopped = { at: this.now(), by: 'person' };
    // Whatever becomes of the record: not sent, not released, released by the butler.
    if (record.person) this.withdrawals[sessionId] = { ...record.stopped, nativeId: record.oldNativeId };
    this.saveQuietly();
  }

  // Claimed by another window than the one that has it; its own window only shows its other side.
  takenOver(sessionId, viewOwner) {
    if (this.rotations[sessionId]?.phase !== 'requested' || typeof viewOwner !== 'string') return false;
    const owner = this.knownSession(sessionId)?.owner;
    return typeof owner === 'string' && owner !== viewOwner;
  }

  // Keys in a Codex terminal may be a prompt not sent, which NAW cannot see there; a restart does not forget them.
  noteTyped(sessionId) {
    const now = this.now(), mark = this.typed[sessionId];
    if (mark) {
      mark.at = now;
      this.typedUnsaved = true;
    }
    if (now - (this.typedSaved.get(sessionId) ?? -Infinity) < TYPED_SAVE_MS) return;
    this.typedSaved.set(sessionId, now);
    const session = this.knownSession(sessionId);
    if (session && session.provider !== 'codex') return;
    this.typed[sessionId] = { at: now };
    this.saveQuietly();
  }

  // For the person's own key: a state that cannot be read is never in its way.
  knownSession(sessionId) {
    try {
      return (this.client || this.clients())?.snapshot().sessions.find(s => s.id === sessionId);
    } catch {
      return undefined;
    }
  }

  unsentTyping(session) {
    const mark = session.provider === 'codex' && this.typed[session.id];
    // A new native process starts with an empty prompt (workspace.cjs bind).
    return Boolean(mark) && session.terminalInputPending !== false && !personSince(session, mark.at);
  }

  // For the person's own key: a store that cannot be written is never in its way, and one that could not be read is left.
  saveQuietly() {
    if (this.rotationRead.error && this.rotationRead.error !== 'missing') return;
    try {
      this.save();
      this.typedUnsaved = false;
    } catch {
      // Held in memory.
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
    if (Object.keys(this.requests).length) {
      return true;
    }
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
    if (this.managerNotices && this.managerNotices.waiting()) {
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

  // The person answered a card of the butler's, or of one it continued from, since its last wake.
  cardClicked() {
    try { return this.stewardWake.personActed(this.holders(this.steward())); } catch { return false; }
  }

  // Such an answer may change no session, and time alone ends these holds: a pass then. Other holds end with a state
  // event, or are looked at by the next full pass.
  clickSoon() {
    return Boolean(this.stewardWake) && [undefined, 'not-settled', 'person-recent'].includes(this.clickHeld) && this.stewardWake.due() && this.cardClicked();
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
    const windows = this.quietWindows, closed = new Set();
    // One past its deadline that is not recorded as closed yet holds nothing either.
    for (const window of [...windows?.history || [], ...windows?.windows || []]) {
      if (now - (window.closedAt ?? window.deadline) < QUIET_WINDOW_CLOSED_MS) for (const id of window.sessions) closed.add(id);
    }
    if (closed.size) for (const session of snapshot.sessions) if (closed.has(session.id)) session.quietWindowClosed = true;
    for (const session of snapshot.sessions) {
      // A live control needs an idle clock; this does not grant delivery readiness.
      const ownRequest = this.rotations[session.id];
      const timingSession = session.archived && waitingOld(ownRequest) ? { ...session, archived: false } : ownRequest?.phase === 'requested' && ownRequest.episodeEpoch &&
        ['open', 'complete'].includes(session.rotationEpisode?.state) && session.rotationEpisode.nativeId === session.nativeId &&
        session.rotationEpisode.epoch === ownRequest.episodeEpoch
        ? { ...session, rotationEpisode: null } : session;
      // A quiet window keeps new work out (sessionReady); what its sessions finished is still settled.
      if (['', 'quiet-window'].includes(sessionReady(timingSession, snapshot.wakePolicy, true).reason)) {
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
            !sessionReady(session, snapshot.wakePolicy, true).ready || humanRecent(session.id, this.humanAt, now, this.humanQuietMs)) {
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

  // Compactions counted so far per member, and (this.contexts) its size; without a counter or a readable record, none.
  async compactionCounts(snapshot, steward, handedOff, now) {
    this.contexts = undefined;
    if (!this.compactions) return new Map();
    try {
      const subjects = rotationSubjects(snapshot.rooms, snapshot.sessions, steward ? [steward.sessionId] : [], handedOff);
      const counts = await this.compactions.sample(subjects, now);
      this.contexts = this.compactions.contexts;
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
        this.observeManagers(snapshot);
        this.idleSince.clear();
        return;
      }
      this.dropOwnClient();
      const watching = Boolean(windowClient);
      if (!watching || now - this.lastMaintenance < MAINTENANCE_MS) {
        if (watching) this.observeManagers();
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
    // A waiting old session is looked at on every pass there is, and at least on the full ones.
    const rotating = this.activeRotations().some(id => !waitingOld(this.rotations[id]));
    const recoveringTrust = Object.entries(this.rotations).some(([id, record]) => !this.faultedRotations.has(id) && (trustRecoveryPending(record) || failedHandoffPending(record)));
    const due = this.dirty || rotating || recoveringTrust || now - this.lastFullPass >= FULL_PASS_MS || this.settlingSoon(now) || now === this.lastMaintenance ||
      this.answerSoon(now) || this.clickSoon() || Boolean(this.managerNotices?.endingSoon(now, this.tickMs * 2));
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
    if (rotating || recoveringTrust || Object.values(this.rotations).some(record => record.phase === 'waiting-provider' || waitingOld(record) ||
        record.person && record.phase === 'failed' && RELEASED_REASONS.includes(record.reason))) {
      await this.advanceRotations(current.snapshot, current.now);
      current = this.view();
    }
    if (await this.finishDeferrals(current.snapshot, current.now)) current = this.view();
    if (this.returning.length) this.giveBackReturning();
    if (Object.keys(this.held).length) {
      await this.flushHeld(current.snapshot);
      current = this.view();
    }
    const sample = await this.memory(current.snapshot.sessions, current.now);
    const steward = this.stewardOutside(current.snapshot.sessions);
    const unmatched = steward ? null : this.stewardUnmatched(current.snapshot.sessions);
    const handedOff = this.handedOff();
    const compactions = await this.compactionCounts(current.snapshot, steward || (unmatched && { sessionId: unmatched }), handedOff, current.now);
    // B6: the session that holds an open handoff gets no queue work and is not rotated, so what
    // it writes until the handoff is closed is not a member's reply; it is not listed as vacant either.
    const butler = this.stewardSession(current.snapshot.sessions)?.steward.sessionId;
    const waits = new Map(), quietPending = new Map(), rotationGates = new Map(), openItems = new Map(), requestGates = new Map();
    this.pruneRequests(current.snapshot, handedOff, current.now);
    const engaged = this.integration ? this.integration.holding() : undefined;
    const input = {
      waits,
      quietPending,
      rotationGates,
      openItems,
      requestGates,
      requests: this.requestRefusals(current.snapshot, current.now),
      unmatched: unmatched ? [unmatched] : [],
      managers: this.managerRooms(current.snapshot.sessions),
      earlier: id => this.earlierSessions(id),
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
      contexts: this.contexts,
      contextLimits: this.contextLimits,
      quietCompactMs: this.quietCompactMs,
      quietContextMs: this.quietContextMs,
      memory: sample.memory,
      memoryLimit: sample.limit,
      memoryMinAgeMs: this.memoryMinAgeMs,
      rotations: Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id))),
      ...this.trustAdmission(),
      engaged,
      modelChanges: this.modelChanges(),
      outside: steward ? [steward.sessionId] : [],
      butler,
    };
    let actions = planDispatch(input);
    // The size a member would be rotated for is read again first, and the pass planned by what it is now.
    const checked = new Set();
    for (;;) {
      const rotation = actions.find(action => action.kind === 'rotate' && action.reason === 'context' && !checked.has(action.sessionId));
      if (!rotation) break;
      checked.add(rotation.sessionId);
      try {
        await this.compactions.recheck(current.snapshot.sessions.find(session => session.id === rotation.sessionId), current.now);
      } catch {
        // Its size was dropped before the read.
      }
      for (const told of [waits, quietPending, rotationGates, requestGates]) told.clear();
      actions = planDispatch(input);
    }
    this.requestGates = requestGates;
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
    this.lastGates = rotationGates;
    this.noteRotationStalls(rotationGates, current.snapshot.sessions, current.now);
    if (this.noteRotationRows(current.snapshot, current.now)) this.broadcast().catch(() => {});
    this.noteErrorStalls(openItems, current.now);
    // In memory only: the person and the butler read why each queued item is still waiting (queue item 5614a65c).
    if (this.roomState.setQueueWaits(waits)) this.broadcast().catch(() => {});
    if (this.observeQueueState) await this.observeQueueState(queueVacancies({ ...current.snapshot,
      idleSince: this.vacancySince, humanAt: this.humanAt, now: current.now,
      settleMs: this.settleMs, humanQuietMs: this.humanQuietMs,
      rotations: Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id))),
      actions, engaged, modelChanges: this.modelChanges(), handedOff, ...this.trustAdmission() }));
    if (this.integration && !this.closed) await this.integrate();
    if (this.stewardWake && !this.closed) await this.wakeSteward(current, engaged, quietPending);
    if ((this.answerNotices || this.versionNotices || this.managerNotices) && !this.closed) await this.notifyAnswers(current, engaged);
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
    const event = this.stewardWake.due(), click = event && this.cardClicked();
    this.clickHeld = click ? 'held' : undefined; this.stewardWake.clicked = click;
    try {
      // The butler's own handoff holds every wake, the patrol's included, until the person's step.
      const own = this.ownHandoffStep(current.snapshot.sessions);
      if (own) return this.stewardWake.hold('rotation-control-unresolved', own);
      this.stewardWake.endHold();
      const work = event ? null : this.openWork(current);
      const minutes = work ? this.stewardWake.patrolDue(work.idleMs, work) : null;
      if (!event && minutes === null) { this.stewardWake.clearBlocked(); return; }
      const steward = this.stewardOutside(current.snapshot.sessions);
      const listed = steward && current.snapshot.sessions.find(s => s.id === steward.sessionId), policy = current.snapshot.wakePolicy;
      const skip = (reason, session = listed) => {
        if (click) this.clickHeld = reason;
        this.stewardWake.skip(reason, reason === 'quiet-window' ? this.quietWindows?.windowOf(steward.sessionId, current.now)?.deadline : undefined, ownTurn(session, reason));
      };
      if (!steward) return skip(this.stewardSession(current.snapshot.sessions) ? 'in-space' : 'identity-unavailable');
      // The person's default (2026-11-25): woken beside an unchanged composer draft as a queue item is, where its backend
      // checks the input (an older one keeps the draft hold); a click waits for the draft's two quiet minutes.
      const beside = Boolean(listed?.serviceCapabilities?.includes(CAPABILITY));
      // The person's own act is told past a quiet window (R200), and their answer on its own card (R209) also past its
      // background work, the two minutes after they used it and the quiet a rotation waits for. The turn it starts makes
      // a move or rotation wait for its quiet again; a window's deadline stays, and it may close before. In a window its
      // last activity counts (the idle clock there misses a turn no pass saw), and where no idle clock runs. Anything else
      // waits for the window without reading the backends.
      const as = click ? pastClick : event && listed.quietWindow && this.stewardWake.personActed() ? pastWindow : null, butler = as ? as(listed) : listed;
      const idle = this.idleSince.has(steward.sessionId) && !listed.quietWindow ? settled(steward.sessionId, this.idleSince, current.now, this.settleMs)
        : Boolean(as) && sessionReady(butler, policy, beside).ready && quietFor(butler, new Map(), current.now, this.settleMs);
      if (!idle) return skip(heldReason(butler, policy, beside) || 'not-settled');
      const rotations = Object.fromEntries(Object.entries(this.rotations).filter(([id]) => !this.faultedRotations.has(id)));
      if (engagedSessions(rotations, current.snapshot.rooms).has(steward.sessionId) || Array.isArray(holding) && holding.includes(steward.sessionId)) return skip('engaged');
      if (!click && ['compact', 'person'].includes(quietPending?.get(steward.sessionId))) return skip('engaged');
      const why = {}, fresh = await this.freshReady(steward.sessionId, click ? 0 : this.humanQuietMs, why, as, beside);
      if (!fresh) return skip(why.reason || 'state-unavailable', why.session);
      if (click && beside && String(fresh.session.liveDraft ?? '').trim() &&
          humanRecent(steward.sessionId, this.humanAt, fresh.now, this.humanQuietMs)) return skip('person-recent');
      // Keys typed in its terminal may be an input on its way that no draft shows.
      if (click && humanRecent(steward.sessionId, this.typedAt, fresh.now, Math.min(this.humanQuietMs, ANSWER_QUIET_MS))) return skip('person-recent');
      if (this.stewardOutside(fresh.snapshot.sessions)?.sessionId !== steward.sessionId || fresh.session.nativeId !== steward.nativeId) return skip('identity-changed');
      // Condition 4 needs the model: as the session reports it, or for Claude as its own transcript last recorded it.
      const model = reportedModel(fresh.session) || transcriptModel(fresh.session, this.transcriptRoot);
      const send = (text, itemId) => this.send(fresh.session, text, itemId, beside).catch(error => {
        if (errorKey(error) === PERSON_TYPING_KEY) this.humanAt.set(steward.sessionId, this.now());
        throw error;
      });
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
    const own = this.stewardSession(current.snapshot.sessions)?.session, butler = own?.id ?? null, parts = [];
    let sessions = 0, items = 0;
    for (const s of current.snapshot.sessions || []) {
      if (!s || s.archived || s.id === butler) continue;
      if (['working', 'approval', 'background'].includes(s.state) || s.approval || s.nativeApproval) { sessions++; parts.push(`s\t${s.id}\t${s.state}\t${s.approval || s.nativeApproval ? 1 : 0}`); }
    }
    for (const room of [this.roomState.value, ...this.roomState.spaces.rooms]) {
      if (!room || room.archived || !Array.isArray(room.queue)) continue;
      for (const item of room.queue) if (['queued', 'sent'].includes(item.status)) { items++; parts.push(`i\t${item.id}\t${item.status}`); }
    }
    // A quiet window keeps a patrol out: none is due there.
    const since = butler === null || own.quietWindow ? undefined : this.idleSince.get(butler);
    return { sessions, items, hash: createHash('sha256').update(parts.sort().join('\n')).digest('hex'),
      idleMs: Number.isFinite(since) ? current.now - since : NaN };
  }

  managerRooms(sessions) {
    try {
      return new Map(Object.entries(this.managers(sessions)).map(([roomId, value]) => [value.sessionId, roomId]));
    } catch {
      return null;
    }
  }

  // The person's answers on an agent's confirmation cards, told to that agent (answer-notices.cjs). One message for
  // everything it is owed, once the answers stopped coming for a moment and the agent is ready and settled as a member
  // is before its next queue item, the person has not typed into it for ANSWER_QUIET_MS (not the two minutes queue work
  // waits: the person who sent a task and then answered the card wants the agent to go on), and it is in no rotation and
  // holding no handoff; then the same send as a queue item, a NAW message under the person's automatic-message switch.
  // An agent at work hears it after its turn: it is not ready until then.
  async notifyAnswers(current, holding) {
    if (this.answerNotices) await this.notifyOwed(this.answerNotices, told => noticeText(told), 'answer-notice', Math.min(this.humanQuietMs, ANSWER_QUIET_MS), current, holding);
    // The version a restart brought and the backends still on an old one, owed to the former secretary's
    // space's manager (version-events.cjs): the same send, after the two minutes queue work waits for the person.
    if (this.versionNotices && !this.closed) await this.notifyOwed(this.versionNotices, told => this.versionNotices.text(told), 'version-notice', this.humanQuietMs, current, holding);
    // What changed in a manager's space: read as the record is after this pass sent and settled its items.
    if (this.managerNotices && !this.closed) {
      this.observeManagers(this.client.snapshot());
      await this.notifyOwed(this.managerNotices, managerText, 'manager-notice', this.humanQuietMs, current, holding);
    }
  }

  // Between full passes too, from the last state event's snapshot (at most once a tick, only after an event): a session
  // joining a space with no queued work is a change.
  observeManagers(snapshot = this.stateSeen) {
    this.stateSeen = null;
    // A list marked unavailable says nothing about who is in a space.
    if (!this.managerNotices || !Array.isArray(snapshot?.sessions) || snapshot.unavailable) return;
    try {
      const view = this.roomState.apply(snapshot);
      if (this.managerNotices.observe(view.rooms, view.sessions, this.managers(view.sessions), this.now())) this.dirty = true;
    } catch {
      // A space or manager record that cannot be read now: looked at again on the next pass.
    }
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
        if (!session || session.nativeId !== target.nativeId || session.quietWindow || !settled(session.id, this.idleSince, current.now, this.settleMs)) continue;
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
    const item = this.roomState.queueFind(action.roomId, action.itemId);
    if (item.status !== 'sent') {
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
    if (action.status === 'done' && item.addedBy === 'steward') {
      this.clearButlerRun(session).catch(() => {});
    }
  }

  // Only after the item is recorded as done, so once an item. Not awaited and never tried again.
  async clearButlerRun(session) {
    const entry = this.client.route(session.id);
    if (!entry.state.capabilities?.includes(QUEUE_DONE_CAPABILITY)) {
      return;
    }
    this.client.operationGuard?.(entry)();
    await withTimeout(entry.client.call('wakeQueueDone', { sessionId: session.id, nativeId: session.nativeId }), CALL_TIMEOUT_MS, 'queue-done-timeout');
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

  // Sent items whose member has stood in 'error' three minutes, with no automatic continuation scheduled or going out
  // (2026-11-25, a member that stayed so with its item open and nobody told): one line to the butler's record each time
  // it stops. Only told: nothing is settled, sent again or continued. While the person is at that session (a draft, a
  // recent input) it waits; a continuation they stopped is not told (noteHuman). A spent retry limit and a Codex usage
  // limit have lines of their own.
  noteErrorStalls(items, now) {
    for (const id of [...this.errorStalls.keys()]) {
      if (!items.has(id)) this.errorStalls.delete(id);
    }
    for (const [id, { member, tag }] of items) {
      const recovery = member.capacityRecovery, nativeId = member.nativeId ?? null;
      let stall = this.errorStalls.get(id);
      if (stall && (stall.memberId !== member.id || stall.nativeId !== nativeId || stall.tag !== tag)) {
        this.errorStalls.delete(id);
        stall = undefined;
      }
      if (member.state !== 'error') {
        // At work again: what stops it next is another stop. Any other state (a lost connection) only restarts the time.
        if (stall) stall.since = null;
        if (stall && RAN_STATES.includes(member.state)) Object.assign(stall, { again: stall.again || stall.told, told: false, exhaustedTurnId: null, scheduled: null, stopped: null });
        continue;
      }
      if (!stall) {
        stall = { since: null, memberId: member.id, nativeId, tag, exhaustedTurnId: null, scheduled: null, stopped: null, again: false, told: false };
        this.errorStalls.set(id, stall);
      }
      stall.scheduled = recovery?.status === 'scheduled' ? recovery.turnId : null;
      if (member.pendingTag || stall.scheduled && stall.scheduled !== stall.stopped) stall.stopped = null;
      // Being continued, or its state is not known: the three minutes start again. One going out has its pending
      // input; 'sending' alone stays behind when the turn it started fails without a named end.
      if (stall.since === null || now < stall.since || recovery?.status === 'scheduled' || member.pendingTag || member.nativeContextPending || member.backendUnavailable || member.transportDisconnected) {
        stall.since = now;
        continue;
      }
      if (recovery?.status === 'exhausted') {
        stall.exhaustedTurnId = recovery.turnId;
        continue;
      }
      if (!this.errorStalled || stall.told || stall.stopped || now - stall.since < ERROR_STALL_MS || codexQuotaBlock(member) ||
          (typeof member.liveDraft === 'string' && member.liveDraft.trim()) || humanRecent(member.id, this.humanAt, now, this.humanQuietMs)) continue;
      try {
        this.errorStalled({ memberId: member.id, nativeId, itemId: id, tag, since: stall.since, again: stall.again, exhaustedTurnId: stall.exhaustedTurnId });
        stall.told = true;
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
  // `as`: the session as this send may see it, what does not hold it left out (wakeSteward).
  async freshReady(sessionId, quietMs = this.humanQuietMs, why = {}, as = null, allowDraft = false) {
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
    const session = why.session = current.snapshot.sessions.find(s => s.id === sessionId);
    const ready = sessionReady(as ? as(session) : session, current.snapshot.wakePolicy, allowDraft);
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

  // Asked again at the send: the change may have been asked for after the pass was planned.
  modelChanging(id) {
    const ids = this.modelChanges();
    return Array.isArray(ids) && ids.includes(id);
  }

  // The member's backend can take a NAW input and its connection is not being replaced.
  // checked: the send carries the input version it was read at, which only the current capability accepts.
  preflight(session, checked = false) {
    const entry = this.client.route(session.id);
    if (!entry.state.capabilities || !(entry.state.capabilities.includes(CAPABILITY) ||
        !checked && entry.state.capabilities.includes(LEGACY_CAPABILITY))) {
      throw Object.assign(Error('backend-update-needed'), { notSent: true });
    }
    if (this.client.operationGuard) {
      this.client.operationGuard(entry)();
    }
    return entry;
  }

  // The backend's own NAW input: no takeover, no human-input semantics.
  // checked: a queue item or butler wake beside a draft; the backend refuses it if the input changed since `session` was read.
  async send(session, text, itemId, checked = false) {
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
    const entry = this.preflight(session, checked);
    const record = this.rotations[session.id];
    let control;
    if (itemId === `rotation:${session.id}`) {
      if (!entry.state.capabilities?.includes(ROTATION_CAPABILITY) || !record?.episodeEpoch || record.oldNativeId !== session.nativeId)
        throw Object.assign(Error('backend-update-needed'), { notSent: true });
      control = { kind: 'rotation-request', epoch: record.episodeEpoch };
    }
    const packet = checked && !control ? { itemId, expectedInput: { nativeId: session.nativeId, draftRevision: session.draftRevision ?? 0,
      controlRevision: session.controlRevision ?? 0, connectionRevision: session.connectionRevision ?? 0 } } : itemId;
    const call = control ? entry.client.call('dispatch', session.id, text, session.nativeId, itemId, control)
      : entry.client.call('dispatch', session.id, text, session.nativeId, packet);
    let result;
    try { result = await withTimeout(call, CALL_TIMEOUT_MS, 'send-timeout'); }
    catch (error) {
      if (errorKey(error) === 'error.confirmationTimeout') result = await this.heldTag(session, itemId);
      if (!result) throw error;
    }
    this.idleSince.delete(session.id);
    if (typeof result === 'string') {
      return result;
    }
    if (result && typeof result.tag === 'string') {
      return result.tag;
    }
    throw Error('NAW did not receive a delivery tag');
  }

  // The call's own limit passed while the backend still waits for native (a member compacting its context,
  // claude-submit.cjs): its row for this very send, not yet settled, is what the item follows from here.
  async heldTag(session, itemId) {
    try { await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout'); } catch { return null; }
    const now = this.view().snapshot.sessions.find(s => s.id === session.id);
    const row = now?.pendingTag && now.nativeId === session.nativeId && (now.messages || []).find(m => m?.id === now.pendingTag);
    return row && row.dispatchItem === itemId && ['awaiting-native', 'submitted'].includes(row.status) ? row.id : null;
  }

  async dispatch(action, waits = null) {
    const why = {};
    const current = await this.freshReady(action.sessionId, this.humanQuietMs, why, null, true);
    if (!current) {
      waits?.set(action.itemId, [{ sessionId: action.sessionId, reason: why.reason }]);
      return;
    }
    if (this.modelChanging(action.sessionId)) {
      waits?.set(action.itemId, [{ sessionId: action.sessionId, reason: 'model-change' }]);
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
    // Checked only where the backend reads the packet; unchecked never goes beside a draft.
    let checked = false;
    try {
      this.roomState.assertAvailable(session.id, true, room.id);
      checked = Boolean(this.client.route(session.id).state.capabilities?.includes(CAPABILITY));
      if (!checked && typeof session.liveDraft === 'string' && session.liveDraft.trim()) {
        throw Object.assign(Error('person-typing'), { notSent: true });
      }
      this.preflight(session, checked);
    } catch (error) {
      // Nothing was recorded or sent; the next pass looks again. The refusal's key, never its text.
      const message = typeof error?.message === 'string' ? error.message : '';
      waits?.set(item.id, [{ sessionId: session.id, reason: errorKey(error) || (/^[a-z][a-z-]{0,60}$/.test(message) ? message : 'refused') }]);
      return;
    }
    // As it is now: the person may have made this member the project manager since the plan.
    const managers = this.managerRooms(current.snapshot.sessions);
    if (!managerItemMayGo(item, session.id, managers, this.earlierSessions(session.id))) {
      waits?.set(item.id, [{ sessionId: session.id, reason: 'manager-item' }]);
      return;
    }
    const name = this.name(session);
    // Record before sending: a crash after this point is never resent silently.
    const notes = notesDue(room, session);
    this.roomState.queueMarkSent(room.id, item.id, session.id, name, this.now(), action.afterDecision === true, session.nativeId || null, notes);
    try {
      const tag = await this.send(session, dispatchText(room.name || '', item, notes ? room.notes : '', managers?.get(session.id) === room.id), item.id, checked);
      if (this.stillSent(room.id, item.id)) this.roomState.queueSetDelivery(room.id, item.id, tag, session.controlRevision || 0);
    } catch (error) {
      const personInput = [NATIVE_DRAFT_KEY, PERSON_TYPING_KEY].includes(errorKey(error));
      if (personInput) {
        // Treated like the person typing: this member is left alone for a while.
        this.humanAt.set(session.id, this.now());
      }
      if (!this.stillSent(room.id, item.id)) {
        // Marked handled while the send was on its way: left as the person or the butler closed it.
      } else if (notSent(error)) {
        if (errorKey(error) === PERSON_TYPING_KEY) waits?.set(item.id, [{ sessionId: session.id, reason: 'person-recent' }]);
        // A prompt the person left unsent there, or their input since it was read, does not use up the item's attempts: it waits.
        let attempts = NOT_SENT_ATTEMPTS;
        if (personInput || errorKey(error) === 'error.queue.terminalDialog') {
          attempts = Infinity;
        }
        this.roomState.queueRequeue(room.id, item.id, error.message || 'not-sent', attempts, name);
      } else {
        this.roomState.queueSettle(room.id, item.id, 'failed', error.message || 'send-failed', name);
      }
    }
    await this.broadcast();
  }

  // A rotation of this session, or to it, whose handoff the person's words would cut into: written, or not yet taken
  // over. Not one they stopped or took back, nor one that waits for its provider.
  heldRotation(sessionId) {
    for (const oldId of this.activeRotations()) {
      const record = this.rotations[oldId];
      if (record.handoffConfirmed || record.stopped || record.withdrawn || waitingOld(record)) continue;
      if (oldId === sessionId || record.newId === sessionId) return oldId;
    }
    return null;
  }

  // The person 2026-11-25: 「在一个 agent 要 hand over 的时候把这个queue 启用，等 handover 之后把 queue 的里的内容发给继任，
  // 然后清空这个 queue」, 「hand over 的过程中发过来的消息不能丢」. What they send from NAW to either session meanwhile is
  // saved with that rotation and sent as written once it is over (flushHeld). Null: not held, it goes as before.
  holdMessage(sessionId, text, nativeId, from) {
    // What the send would refuse anyway is refused there, as before (cleanText).
    if (typeof text !== 'string' || !text.trim() || text.length > HELD_TEXT_LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
    if (/^\/[a-z-]+(?:\s|$)/i.test(text)) return null;
    const oldId = this.heldRotation(sessionId);
    if (!oldId) return null;
    const record = this.rotations[oldId];
    // Addressed to another native session than this one: the send's own check answers (contextChanged).
    const expected = sessionId === oldId ? record.oldNativeId : record.newNativeId;
    if (nativeId && expected && nativeId !== expected) return null;
    const entry = this.held[oldId] || { items: [], oldNativeId: record.oldNativeId || null };
    const length = entry.items.reduce((sum, item) => sum + item.text.length + 2, text.length);
    // Sent past the limit, it would land before the rest and cut into the handoff.
    if (entry.items.length >= HELD_LIMIT || length > HELD_TEXT_LIMIT) throw uiError('error.rotation.heldFull');
    entry.items.push(heldItem({ at: this.now(), text, session: sessionId, from }));
    entry.name = record.name || entry.name;
    entry.roomIds = [...(record.roomIds || [])];
    this.held[oldId] = entry;
    try {
      this.save();
    } catch (error) {
      entry.items.pop();
      if (!entry.items.length) delete this.held[oldId];
      throw error;
    }
    this.dirty = true;
    return { held: true };
  }

  // Once its rotation is over, what was held goes to the successor if that had the handoff, else back to the old
  // session; one message, the person's words in the order sent, through the window that controls that session.
  async flushHeld(snapshot) {
    for (const [oldId, entry] of Object.entries(this.held)) {
      if (this.heldRotation(oldId) === oldId) continue;
      const usable = target => {
        const session = target && snapshot.sessions.find(s => s.id === target.id);
        return session && session.state !== 'ended' ? session : null;
      };
      const session = usable(entry.to) || usable({ id: oldId });
      const text = entry.items.map(item => item.text).join('\n\n');
      if (!session) {
        this.returnHeld(oldId, entry, null);
        continue;
      }
      // It is itself being rotated now: the words wait for that one.
      const next = this.heldRotation(session.id);
      if (next) {
        if (next !== oldId) {
          const into = this.held[next] || { items: [], oldNativeId: this.rotations[next].oldNativeId || null };
          into.items.push(...entry.items);
          into.name = this.rotations[next].name || into.name;
          into.roomIds = [...(this.rotations[next].roomIds || [])];
          this.held[next] = into;
          delete this.held[oldId];
          this.save();
        }
        continue;
      }
      // A try whose answer was lost: the words in the session since then are the answer (sent trimmed, cleanText).
      if (entry.tried !== undefined && (session.messages || []).some(m => m.role === 'user' && typeof m.text === 'string' && m.text.trim() === text.trim() && !(m.time < entry.tried - 1000))) {
        this.sentHeld(oldId, entry, entry.items.length, null, null);
        continue;
      }
      if (entry.blockedSince !== undefined && this.now() - entry.blockedSince >= HELD_RETURN_MS) {
        this.returnHeld(oldId, entry, session);
        continue;
      }
      if (this.now() - (entry.tried ?? -Infinity) < HELD_RETRY_MS) continue;
      // Busy with its own turn, or the person typing there: waited for. Any other state that takes nothing (an error,
      // a stop) counts as blocked.
      const method = heldMethod(session);
      if (session.pendingTag || session.nativeContextPending || session.liveDraft?.trim() || !method && session.state === 'working') continue;
      let client = null;
      try {
        this.roomState.assertAvailable(session.id);
        if (method) client = await this.heldClient(session);
      } catch { /* As with no window that controls it: blocked. */ }
      const count = entry.items.length;
      entry.tried = this.now();
      if (client) {
        this.save();
        try {
          await withTimeout(client.call(method[0], session.id, text, session.nativeId, ...method.slice(1)), CALL_TIMEOUT_MS, 'send-timeout');
          this.sentHeld(oldId, entry, count, session.id, method[0]);
          continue;
        } catch { /* Refused or unanswered: tried again, and counted as blocked. */ }
      }
      entry.blockedSince ??= this.now();
      this.save();
    }
  }

  // The window that controls it, or NAW's own connection when that does (what source() created with no window).
  async heldClient(session) {
    const window = this.ownerClient(session.owner);
    if (window) return window;
    if (!this.connect || session.owner !== this.owner) return null;
    this.own ||= await withTimeout(this.connect(this.owner), CALL_TIMEOUT_MS, 'connect-timeout');
    return this.own;
  }

  // Only what went: words held meanwhile, for a rotation of the same session begun during the send, stay for it.
  sentHeld(oldId, entry, count, sessionId, method) {
    entry.items.splice(0, count);
    if (entry.items.length) {
      for (const key of ['to', 'tried', 'blockedSince']) delete entry[key];
    } else if (this.held[oldId] === entry) {
      delete this.held[oldId];
    }
    this.save();
    // Recorded as the person's own send is (main.cjs authorizeOperation).
    if (sessionId) this.noteHuman(sessionId, method);
  }

  // Not a silent retry, and only to the person (11-25 review: a space is read by its agents): each message goes back
  // as a draft copy in their window, on the session that should have taken it (an old session after a done handoff is
  // archived), else the one they addressed. It leaves the held words at once, so a new handoff starts with none.
  returnHeld(oldId, entry, receiver) {
    const name = receiver ? this.label(receiver.id, receiver.name || entry.name || '') : this.label(oldId, entry.name || '');
    this.returning.push(...entry.items.map(item => ({ ...item, session: receiver?.id || item.session || oldId, name })));
    delete this.held[oldId];
    this.save();
    this.giveBackReturning();
  }

  // What could not be put back yet (no window open) is tried again each pass, never dropped. The person is told once
  // a copy is there.
  giveBackReturning() {
    const placed = new Set();
    const left = this.returning.filter(item => {
      try {
        if (!this.giveBack(item.from, item.session, item.text, item.name || '')) return true;
        placed.add(item.name || '');
        return false;
      } catch {
        return true;
      }
    });
    if (left.length === this.returning.length) return;
    this.returning = left;
    this.save();
    for (const name of placed) {
      try { Promise.resolve(this.notify('heldReturned', { name })).catch(() => {}); } catch { /* The copy is there. */ }
    }
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

  // Whether what the person did since stops this rotation. Once its handoff is asked for it goes on, asked for by hand or
  // come due: a look, a click and what they type are no use of the session, and their messages are told to the
  // successor (R207; the person 2026-11-25, 「hand over 的过程中发过来的消息不能丢」); their stop is (noteStop).
  interrupted(old, record) {
    return Boolean(record.stopped) || old.nativeId !== record.oldNativeId;
  }

  // The handoff turn reports the mode the person left the session in: its successor has bypass only if it still has.
  leaveBypass(record, old) {
    if (record.provider !== 'claude') {
      return;
    }
    const mode = launchMode(old.nativePermissionMode), carried = record.carry?.permissionMode;
    if (mode !== BYPASS && CLAUDE_PERMISSION_MODES.includes(mode) && (carried === BYPASS || record.skipPermissions && !carried)) {
      record.carry = { ...record.carry, permissionMode: mode };
    }
    if (![undefined, BYPASS].includes(record.carry?.permissionMode)) {
      record.skipPermissions = false;
    }
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
  async touchedSince(oldId, old, seen = null, quietMs = this.humanQuietMs) {
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
    return humanRecent(oldId, this.humanAt, this.now(), quietMs);
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
      const receipt = await withTimeout(target.client.call('maintenanceStop', oldId, plan.stop, false, ...scope), CALL_TIMEOUT_MS, 'stop-timeout');
      const stopped = { ...plan.stop, controlRevision: (plan.stop.controlRevision || 0) + 1,
        connectionRevision: (plan.stop.connectionRevision || 0) + 1 };
      if (receipt?.stopped !== true || !sameStop(receipt.expected, plan.stop) || !sameStop(receipt.stoppedState, stopped) ||
          receipt.stoppedState.state !== 'ended') {
        return 'stop-unproven';
      }
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

  // What a successor must start with, or the `reason` no successor can match it.
  carryOf(session, capabilities) {
    let carry = carrySettings(session);
    if (carry.reason === 'model-unknown') {
      const model = transcriptModel(session, this.transcriptRoot);
      if (model) {
        carry = carrySettings({ ...session, model });
      }
    }
    const offered = capabilities || [];
    if (!carry.reason && (!offered.includes(CREATE_SETTINGS_CAPABILITY) || (carry.settings.profile && !offered.includes(CREATE_PROFILE_CAPABILITY)))) {
      return { reason: 'backend-cannot-carry-settings' };
    }
    return carry;
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
    const asked = action.reason === 'person' ? this.requests[action.sessionId] : null;
    if (action.reason === 'person' && !asked) {
      return;
    }
    let current;
    try { current = await this.freshReady(action.sessionId, asked ? 0 : this.humanQuietMs, whyReady); }
    catch (error) {
      if (!this.closed) this.rotationWait(expected, error?.message === 'refresh-timeout' ? 'refresh-timeout' : 'refresh-failed');
      return;
    }
    // Withdrawn while the state was read.
    if (asked && this.requests[action.sessionId] !== asked) {
      return;
    }
    if (!current) {
      if (asked) {
        this.requestGates.set(action.sessionId, whyReady.reason || 'not-idle');
      } else {
        this.rotationWait(expected, whyReady.reason || 'not-idle');
      }
      return;
    }
    if (this.modelChanging(action.sessionId)) return;
    const session = current.session;
    if (asked && session.nativeId !== asked.nativeId) {
      return;
    }
    const reason = action.reason || 'content';
    const whyNotice = rotationWhyNotice(reason, recordCount(session), bytes || 0, action.compactions, action.contextTokens, asked?.by);
    const why = whyNotice.text;
    // Decided before the old session is asked anything: a successor must match it.
    const carry = this.carryOf(session, current.snapshot.capabilities);
    const refusal = carry.reason;
    if (asked && refusal) {
      // It stays asked for: the row names what to change first.
      this.requestGates.set(session.id, refusal);
      return;
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
    if (asked) {
      record.person = { at: asked.at, by: asked.by };
      // In no space and not the butler: no designation goes with it (designationMoved).
      if (!record.roomIds.length && this.stewardSession(current.snapshot.sessions)?.session.id !== session.id) {
        record.solo = true;
      }
    }
    record.newName = nextName(record.name);
    // Two living sessions called the same cannot be told apart (2026-11-24): not a name in use or already given.
    const names = new Set([...current.snapshot.sessions.flatMap(s => [s.name, this.name(s)]), ...this.log.map(entry => entry.new?.name)]);
    while (names.has(record.newName)) record.newName = nextName(record.newName);
    this.rotations[session.id] = record;
    delete this.requests[session.id];
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
      if (notSent(error) && asked) {
        delete this.rotations[session.id];
        if (record.stopped) {
          // Stopped while it was being sent: ended, as one stopped in its turn is (deferRotation).
          this.appendLog('waiting', record, { reason: 'person-active' });
          this.roomState.rotationEvent(record.roomIds, 'withdrawn', this.label(session.id, record.name));
        } else if (!record.withdrawn) {
          this.requests[session.id] = { ...asked, ...record.person };
          this.requestTried.set(session.id, this.now());
          this.requestGates.set(session.id, errorKey(error) === NATIVE_DRAFT_KEY ? 'terminal-input'
            : error?.message === 'backend-update-needed' ? 'backend-update-needed' : 'handoff-request-not-sent');
        }
      } else if (notSent(error)) {
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
        // Released by NAW, whose answer was lost.
        if (record.phase === 'failed' && episode?.disposition?.actor?.kind === 'naw') this.keepAsked(id, record);
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
      if (record.phase === 'failed' && RELEASED_REASONS.includes(record.reason) && record.episodeEpoch &&
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
          // The successor has the handoff: nothing is undone, the old session is ended later.
          if (record.phase === 'handed' && record.handoffConfirmed) {
            if (this.rotations[oldId] === record) {
              this.finishTried.set(oldId, now);
              await this.holdOld(oldId, record, rotationReasonCode(errorKey(error) || error?.message, 'finish-failed'), now);
            }
            continue;
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
      let returned = true;
      for (const roomId of record.roomIds) {
        try {
          this.roomState.queueReassign(roomId, record.newId, oldId);
        } catch {
          returned = false;
        }
      }
      try {
        stopped = returned && await this.retireUnusedSuccessor(oldId, record);
      } catch {
        stopped = false;
      }
      if (!stopped && trustTimedOut) {
        record.reason = reason = 'native-directory-trust-timeout-stop-unconfirmed';
        this.save();
      }
    }
    if (!record.oldId) {
      record.oldId = oldId;
    }
    // A successor in a moved directory is held under this record (holdTrustSuccessor); it keeps the failed record.
    if (RELEASED_REASONS.includes(reason) && stopped && !record.handoffConfirmed && !movedSuccessor(record)) {
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

  async retireUnusedSuccessor(oldId, record) {
    // A dispatched handoff without a receipt is ambiguous. The failed-handoff cleanup still owns it.
    if (record.createdSuccessor !== true || Object.hasOwn(record, 'successorOwner') || record.handoffTag) return false;
    const id = record.newId, client = this.client;
    const restored = () => this.roomState.value.restoredSessions.includes(id);
    const read = async () => (await withTimeout(client.call('initial'), CALL_TIMEOUT_MS, 'refresh-timeout')).sessions.find(s => s.id === id);
    const before = await read();
    const proof = trustProof(before), revision = before?.connectionRevision ?? 0;
    if (this.closed || restored() || !proof || !unusedRotationSuccessor(before) || proof.controlRevision !== 0 || proof.draftRevision !== 0 ||
        revision !== 0 || before.provider !== record.provider || !['starting', 'idle', 'error', 'ended'].includes(before.state)) return false;
    const rooms = roomIds(before);
    if (rooms.length > 1 || (!rooms.length && proof.placementRevision !== 0)) return false;
    if (rooms.length && (!record.roomIds.includes(rooms[0]) || proof.placementRevision !== 1 || !record.successorJoin ||
        before.placementReceipt?.operationId !== record.successorJoin)) return false;

    const target = client.route(id), guard = client.operationGuard?.(target) || (() => {});
    let change = 0;
    if (before.state !== 'ended') {
      if (before.guardedSuccessorRestore !== true || !target.state.capabilities?.includes(GUARDED_STOP_CAPABILITY)) return false;
      guard();
      this.roomState.assertAvailable(id);
      const result = await withTimeout(target.client.call('stopUnusedSuccessor', id, proof), CALL_TIMEOUT_MS, 'stop-timeout');
      guard();
      if (result?.state !== 'ended') return false;
      change = 1;
    }

    let placement = proof.placementRevision;
    const ended = session => {
      guard();
      return !this.closed && this.rotations[oldId] === record && !restored() && session.state === 'ended' &&
        unusedRotationSuccessor(session) && session.nativeId === proof.nativeId &&
        (session.connectionRevision ?? 0) === revision + change && session.controlRevision === proof.controlRevision + change &&
        session.draftRevision === proof.draftRevision && placementRevision(session) === placement;
    };
    const stopped = await read();
    if (!stopped || !ended(stopped)) return false;
    if (rooms.length) {
      const roomId = rooms[0];
      const left = await withTimeout(this.roomState.membership(client, id, false, record.newName, roomId, {
        nativeId: proof.nativeId, placementRevision: placement, connectionRevision: revision + change, unusedSuccessor: true,
      }), CALL_TIMEOUT_MS, 'leave-timeout');
      if (!left?.changed || left.placementRevision !== placement + 1) return false;
      placement = left.placementRevision;
    }
    // This is the existing one-shot failed transition. Restoring an archived shell does not replay it.
    if (!RELEASED_REASONS.includes(record.reason)) await this.archiveOld(id, record.newName, undefined, ended);
    return true;
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

  // Still asked for: their message came before its handoff, so it is asked for again once the session is free.
  keepAsked(oldId, record) {
    if (record.person?.by === 'person' && !record.withdrawn && !record.stopped && record.reason === 'person-active') {
      this.requests[oldId] = { ...record.person, nativeId: record.oldNativeId };
    }
  }

  // The person used the old session while it was being rotated (the 11-14 drill, finding 1: a week's rest for it).
  // Nothing failed: the record goes, and the member is rotated again once quiet (personDeferred). No OS notice, since
  // the person is at that session; the space says why the request stopped. Each new attempt asks for a handoff again.
  async deferRotation(oldId, record, due, now) {
    const cut = record.reason === 'handoff-interrupted';
    if (cut && !record.cutReported) {
      // Not known to be the person's stop: they are told, also where the session is in no space, and may ask again.
      record.cutReported = true;
      this.save();
      this.appendLog('failed', record, { reason: record.reason });
      this.failedEvent(record.roomIds, oldId, record);
      this.notify('failed', record);
    }
    if (record.episodeEpoch) {
      const entry = this.client.route(oldId);
      const result = await withTimeout(entry.client.call('invalidateRotation', oldId, record.oldNativeId, record.episodeEpoch,
        { tag: record.tag, reason: 'person-active' }), CALL_TIMEOUT_MS, 'invalidate-timeout');
      if (result?.epoch !== record.episodeEpoch || result.tag !== record.tag || result.state !== 'released') throw Error('handoff-purpose-unconfirmed');
    }
    delete this.rotations[oldId];
    this.keepAsked(oldId, record);
    this.save();
    this.deferredAt.set(oldId, { at: now, due });
    if (!cut) {
      this.appendLog('waiting', record, { reason: record.withdrawn ? 'withdrawn' : 'person-active' });
      // A stopped one that came due is asked again once quiet: deferred, not undone.
      const undone = record.withdrawn || (record.stopped && record.person);
      this.roomState.rotationEvent(record.roomIds, undone ? 'withdrawn' : 'deferred', this.label(oldId, record.name));
    }
    await this.broadcast();
  }

  // 「现在就换」 (R207): a rotation asked for now by the person, or by the butler for itself. It is the same rotation as one
  // that came due, begun without the size check and the quiet wait; one already handed over is finished with its own
  // successor, never with another. Every request and withdrawal is written to the rotation log.
  async requestRotation(sessionId, by = 'person') {
    const session = await this.requested(sessionId);
    const record = this.rotations[sessionId], now = this.now();
    if (by === 'steward' && (record?.withdrawn || record?.stopped || this.takenBack(session) || this.unusedSuccessor(session))) {
      throw uiError('error.rotation.personFirst');
    }
    if (record && !RESTING_PHASES.includes(record.phase) && !waitingOld(record) && record.phase !== 'requested') {
      // Its successor is already taking over.
      if (record.phase === 'waiting-provider') throw uiError('error.rotation.unavailable');
      return this.rotationRow(sessionId, session, now);
    }
    const restore = this.askState(sessionId);
    if (record?.phase === 'requested' || waitingOld(record)) {
      if (record.person && !record.withdrawn && !record.stopped) return this.rotationRow(sessionId, session, now);
      record.person = { at: now, by };
      delete record.withdrawn;
      delete record.stopped;
    } else if (!this.requests[sessionId]) {
      if (record && (trustRecoveryPending(record) || failedHandoffPending(record))) throw uiError('error.rotation.unavailable');
      this.requests[sessionId] = { at: now, by, nativeId: session.nativeId || null };
      this.requestTried.delete(sessionId);
    } else if (by === 'person' && this.requests[sessionId].by === 'steward') {
      // Theirs from now on, whoever is the butler.
      this.requests[sessionId].by = 'person';
    } else {
      return this.rotationRow(sessionId, session, now);
    }
    if (by === 'person') {
      delete this.withdrawals[sessionId];
    }
    return this.requestSaved('asked', sessionId, session, by, now, restore);
  }

  // What a request or a withdrawal changes, to put back when it cannot be saved: the window reports that error.
  askState(sessionId) {
    const record = this.rotations[sessionId], request = this.requests[sessionId], by = request?.by;
    const kept = [[this.requests, sessionId], [this.withdrawals, sessionId], ...(record ? ['person', 'withdrawn', 'stopped'].map(key => [record, key]) : [])]
      .map(([map, key]) => [map, key, map[key]]);
    return () => {
      for (const [map, key, value] of kept) {
        if (value === undefined) delete map[key];
        else map[key] = value;
      }
      if (request) request.by = by;
    };
  }

  // 甲: what the person took back stays so until they next act on that session (a message there, or their own click).
  takenBack(session) {
    const taken = this.withdrawals[session.id];
    return Boolean(taken) && !personSince(session, taken.at);
  }

  // 甲: a new session does not ask because of what its handoff says: the person has written in it first.
  unusedSuccessor(session) {
    const rows = conversation(session);
    const told = rows.findLastIndex(m => typeof m.dispatchItem === 'string' && m.dispatchItem.startsWith('rotation-handoff:'));
    if (told >= 0) {
      return !rows.slice(told + 1).some(personRow);
    }
    const own = this.rotations[session.id];
    return Boolean(own?.successorOf) && !personSince(session, own.keptAt);
  }

  // Before the handoff is written; from then on a successor exists or is being made.
  async withdrawRotation(sessionId, by = 'person') {
    const record = this.rotations[sessionId], now = this.now();
    if (!this.requests[sessionId] && (record?.phase !== 'requested' || record.withdrawn)) throw uiError('error.rotation.cannotUndo');
    const session = await this.requested(sessionId);
    const restore = this.askState(sessionId);
    if (this.requests[sessionId]) {
      delete this.requests[sessionId];
      this.requestGates.delete(sessionId);
      // What came due for it on its own waits for quiet again.
      this.deferredAt.set(sessionId, { at: now, due: 'content' });
    } else if (this.rotations[sessionId]?.phase === 'requested') {
      // Its turn is never cut off: the request ends when that turn does (advanceRotation).
      this.rotations[sessionId].withdrawn = { at: now, by };
    } else {
      throw uiError('error.rotation.cannotUndo');
    }
    this.withdrawals[sessionId] = { at: now, by, nativeId: session.nativeId || null };
    return this.requestSaved('withdrawn', sessionId, session, by, now, restore);
  }

  async requested(sessionId) {
    const client = this.client || await this.source();
    const session = client.snapshot().sessions.find(s => s.id === sessionId);
    const record = this.rotations[sessionId];
    const open = record && !RESTING_PHASES.includes(record.phase);
    if (this.closed || !session || session.archived || !['claude', 'codex'].includes(session.provider) ||
        OUT_STATES.includes(session.state) || this.faultedRotations.has(sessionId) || Object.hasOwn(this.rejectedRotations, sessionId) ||
        !open && this.handedOff().has(sessionId)) {
      throw uiError('error.rotation.unavailable');
    }
    return session;
  }

  requestSaved(event, sessionId, session, by, now, restore) {
    let spaces = [];
    try {
      spaces = roomIds(session);
    } catch {
      // The line is still written without its spaces.
    }
    try {
      this.save();
    } catch (error) {
      restore();
      throw error;
    }
    this.appendLog(event, { oldId: sessionId, oldNativeId: session.nativeId, name: this.name(session), roomIds: spaces }, { by });
    const row = this.rotationRow(sessionId, session, now);
    if (row) {
      this.rotationRows = { ...this.rotationRows, [sessionId]: row };
    } else {
      const { [sessionId]: gone, ...rest } = this.rotationRows;
      this.rotationRows = rest;
    }
    this.dirty = true;
    this.broadcast().catch(() => {});
    this.schedule();
    return row;
  }

  // What is asked for no longer holds: the session is another conversation, is put away, is out for good, or handed over.
  pruneRequests(snapshot, handedOff, now) {
    let changed = false;
    for (const [id, request] of Object.entries(this.requests)) {
      const session = snapshot.sessions.find(s => s.id === id), record = this.rotations[id];
      let reason = '';
      if (session && !request.nativeId && validId(session.nativeId)) {
        request.nativeId = session.nativeId;
        changed = true;
      }
      if (record && !RESTING_PHASES.includes(record.phase)) {
        record.person ??= { at: request.at, by: request.by };
        reason = 'under-way';
      } else if (session && request.nativeId && session.nativeId && session.nativeId !== request.nativeId) {
        reason = 'identity-changed';
      } else if (session?.archived) {
        reason = 'archived';
      } else if (handedOff.has(id)) {
        reason = 'handed-off';
      } else if (request.by === 'steward' && session && this.stewardSession([session]) === null) {
        // Asked by the butler for itself, and it is not the butler any more.
        reason = 'designation-changed';
      } else if ((!session || OUT_STATES.includes(session.state)) && this.outGate(id, session, now) === '') {
        reason = 'session-ended';
      }
      if (!reason) continue;
      delete this.requests[id];
      this.requestGates.delete(id);
      changed = true;
      if (reason !== 'under-way') {
        this.appendLog('dropped', { oldId: id, oldNativeId: request.nativeId, name: session ? this.name(session) : id, roomIds: [] }, { reason, by: request.by });
      }
    }
    for (const id of Object.keys(this.typed)) {
      const session = snapshot.sessions.find(s => s.id === id);
      if (session && !this.unsentTyping(session)) {
        delete this.typed[id];
        this.typedSaved.delete(id);
        changed = true;
      }
    }
    for (const [id, taken] of Object.entries(this.withdrawals)) {
      const session = snapshot.sessions.find(s => s.id === id);
      const other = session && taken.nativeId && session.nativeId && session.nativeId !== taken.nativeId;
      if (session && (session.archived || other || personSince(session, taken.at))) {
        delete this.withdrawals[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // For planDispatch: what is asked for, each with why it cannot begin whatever its turn does, or ''.
  requestRefusals(snapshot, now) {
    const refusals = new Map();
    for (const [id, request] of Object.entries(this.requests)) {
      const session = snapshot.sessions.find(s => s.id === id);
      let refusal = '';
      if (!session) {
        refusal = 'missing';
      } else if (!request.nativeId) {
        refusal = 'model-unknown';
      } else if (now - (this.unknownModelAt.get(id) ?? -Infinity) < UNKNOWN_MODEL_RETRY_MS && !reportedModel(session)) {
        refusal = 'model-unknown';
      } else {
        refusal = this.carryOf(session, snapshot.capabilities).reason || '';
        if (refusal === 'model-unknown') this.unknownModelAt.set(id, now);
      }
      // A prompt not sent may be in its terminal.
      const tried = now - (this.requestTried.get(id) ?? -Infinity) < FINISH_RETRY_MS;
      if (!refusal && session && this.unsentTyping(session)) refusal = 'terminal-input';
      if (!refusal && (tried || humanRecent(id, this.typedAt, now, Math.min(this.humanQuietMs, ANSWER_QUIET_MS)))) {
        refusal = this.requestGates.get(id) === 'handoff-request-not-sent' ? 'handoff-request-not-sent' : 'terminal-input';
      }
      refusals.set(id, refusal);
    }
    return refusals;
  }

  // Where a session's rotation stands, for the person's windows (the row above its composer), or null. `gate`: what it
  // waits for; `at`: the earliest it goes on when that is their own quiet.
  rotationRow(id, session, now, policy = { enabled: true }) {
    const record = this.rotations[id], request = this.requests[id];
    if (request) {
      return { state: 'requested', gate: this.requestGates.get(id) || 'settling', undo: true };
    }
    if (record && this.faultedRotations.has(id)) return null;
    const butler = this.stewardSession([session])?.session.id === id;
    const next = record?.newId ? { id: record.newId, name: this.label(record.newId, record.newName || record.name) } : null;
    if (waitingOld(record)) {
      const row = { state: 'handed', gate: record.gate || 'settling', next, ...(butler ? { butler } : {}), ...(record.person ? {} : { now: true }) };
      if (row.gate === 'person-quiet') row.at = wholeMinute((record.usedAt ?? 0) + this.personQuiet(id, record.reason, butler ? id : null));
      return row;
    }
    if (record?.phase === 'requested') {
      if (record.withdrawn || record.stopped) return null;
      const ready = session.state === 'idle' ? sessionReady({ ...session, rotationEpisode: null }, policy).reason : '';
      return { state: 'writing', undo: true, ...(ready ? { gate: ready } : {}) };
    }
    if (record && ['creating', 'joining', 'created', 'handed', 'waiting-trust'].includes(record.phase)) {
      return { state: 'taking', ...(butler ? { butler } : {}) };
    }
    const held = this.lastGates.get(id);
    if (!held) return null;
    const row = { state: 'due', gate: held.gate, now: true };
    if (['quiet', 'human-recent', 'person-active', 'person-recent'].includes(held.gate)) {
      const last = Math.max(...[lastActivityOf(session, now), this.humanAt.get(id), this.deferredAt.get(id)?.at].filter(Number.isFinite));
      const quiet = this.personQuiet(id, held.reason, butler ? id : null);
      const used = conversation(session).findLast(m => m.role === 'user');
      // Quiet after work of its own or NAW's is not waiting for the person.
      if (held.gate === 'quiet' && !(used && personRow(used)) && !humanRecent(id, this.humanAt, now, quiet)) return null;
      row.gate = 'person-quiet';
      row.at = wholeMinute(last + quiet);
    }
    return row;
  }

  // Read by the windows with every state; computed once a pass. True when one of them changed.
  noteRotationRows({ sessions, wakePolicy }, now) {
    const rows = {};
    for (const id of new Set([...Object.keys(this.requests), ...Object.keys(this.rotations), ...this.lastGates.keys()])) {
      const session = sessions.find(s => s.id === id);
      const row = session && !session.archived && ['claude', 'codex'].includes(session.provider) ? this.rotationRow(id, session, now, wakePolicy) : null;
      if (row) rows[id] = row;
    }
    const changed = JSON.stringify(rows) !== JSON.stringify(this.rotationRows);
    this.rotationRows = rows;
    return changed;
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
      if (old && this.interrupted(old, record)) throw Error('person-active');
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
      const cut = cutTurn(old, record.tag);
      // A turn cut off does not settle: Claude reports its background work again only at the end of the next one.
      if (old.state !== 'idle' || old.pendingTag || !(record.withdrawn || record.stopped || cut) && !settled(oldId, this.idleSince, now, this.settleMs)) {
        return;
      }
      const reply = replyAfter(old, record.tag, record.requestedAt);
      // Interrupted where no window of this NAW saw a stop: a phone, the native CLI, an agent, a restart. A click after
      // it asks anew.
      if (cut && !record.withdrawn && !record.stopped && !(record.person?.at > cut.time)) {
        throw Error('handoff-interrupted');
      }
      if (record.withdrawn || cut || this.interrupted(old, record)) {
        throw Error('person-active');
      }
      // Asked for by hand: what the person sent meanwhile is told afterwards (record.seen), not taken as the handoff.
      const own = reply?.humanAfter ? replyAfter(old, record.tag, record.requestedAt, true) : reply;
      const during = Boolean(reply?.humanAfter) && Boolean(own?.text.trim());
      const handoff = during ? own.text : reply?.text || '';
      if (!handoff.trim()) {
        throw Error(reply?.humanAfter ? 'person-active' : 'handoff-missing');
      }
      try {
        await this.completeEpisode(oldId, record);
      } catch (error) {
        throw reply.humanAfter ? Error('person-active') : error;
      }
      this.leaveBypass(record, old);
      record.handoff = handoff.slice(0, ITEM_TEXT_LIMIT * 2);
      record.seen = during ? handoffSeen(old, record) : seenRow(old, now);
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
        record.createdSuccessor = true;
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
          if (terminalFirst && roomIds(latest || {}).includes(roomId)) continue;
          const placement = await withTimeout(this.roomState.membership(this.client, record.newId, true, record.newName, roomId), CALL_TIMEOUT_MS, 'join-timeout');
          if (record.createdSuccessor === true && placement?.changed && validId(placement.operationId)) {
            record.successorJoin = placement.operationId;
            this.save();
          }
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
      if (old && this.interrupted(old, record)) {
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
      record.handoffTag = await this.send(fresh, handoffText(record.name, record.handoff, directoryHandoff(record, snapshot), this.stewardDuty(oldId, record), decisions, record.solo === true), `rotation-handoff:${oldId}`);
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
          // A late receipt counts, as a late completion does: undoing what native has taken stops it midway or, when it
          // may not be stopped, leaves two sessions on the same work.
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
      if (record.handoffConfirmed) {
        // Confirmed on an earlier pass that did not finish it, by an older version or before a restart.
        if (!waitingOld(record)) await this.holdOld(oldId, record, 'settling', now);
        await this.advanceWaiting(oldId, record, snapshot, now);
        return;
      }
      // Effort and permission mode are often reported only with the first prompt: compare again.
      const mismatch = settingsMismatch(record.carry, fresh, record.modelProvider || null);
      if (mismatch && mismatch !== 'pending') {
        throw Error(`settings-differ:${mismatch}`);
      }
      record.confirmedAt = now;
      record.handoffConfirmed = true;
      if (fresh && fresh.nativeId) {
        record.newNativeId = fresh.nativeId;
      }
      if (this.held[oldId]) this.held[oldId].to = { id: record.newId, nativeId: record.newNativeId || null };
      this.save();
      // The successor has the handoff: the old session's open decisions are answered there from now on. A decision
      // already moved is left as it is.
      const updating = this.carryDecisions(oldId, record, { id: record.newId, nativeId: record.newNativeId || null });
      this.releaseTrustSuccessor(record);
      if (old && !record.seen) record.seen = handoffSeen(old, record);
      const gate = this.confirmedGate(oldId, record, old, snapshot, updating);
      if (gate === 'identity-changed') {
        await this.keepOld(oldId, record, gate, now);
        return;
      }
      const left = gate || await this.finishRotation(oldId, record, old, now);
      if (left) await this.holdOld(oldId, record, left, now, old);
    }
  }

  // Ending the old session is refused while, or pauses, the relays it is in, and leaving its spaces pauses theirs. A
  // service whose stop pauses only those (participantStop) leaves a relay elsewhere running, so that one does not hold
  // the rotation (cd3e2a8d); beside an older service, whose stop pauses every relay it holds, any running relay does.
  collaborating(oldId, record, snapshot) {
    const scoped = this.participantStop(oldId);
    return (snapshot.rooms || []).some(room => room.run?.status === 'running' &&
      (!scoped || !Array.isArray(record.roomIds) || record.roomIds.includes(room.id) || (room.run.ids || []).includes(oldId)));
  }

  // True while a space being updated refuses them: they go on a later pass. A space that is gone keeps its items.
  carryDecisions(oldId, record, to) {
    let updating = false;
    for (const roomId of record.roomIds || []) {
      try {
        this.roomState.queueCarry(roomId, oldId, to.id, to.nativeId);
      } catch (error) {
        if (error?.uiMessage?.key === 'error.room.updatingDraftRetained') updating = true;
      }
    }
    return updating;
  }

  // Why the old session is not ended on the pass that has its handoff confirmed, or ''.
  confirmedGate(oldId, record, old, snapshot, updating) {
    if (!old) return 'old-missing';
    // Out: for good, or while its backend is moved (outGate).
    if (['ended', 'background'].includes(old.state)) return 'settling';
    if (old.nativeId !== record.oldNativeId) return 'identity-changed';
    if (rowsSince(old, record.seen).some(personRow)) return 'person-message';
    if ((old.controlRevision || 0) !== record.oldControl) return 'control-changed';
    // Once the successor has the handoff, the old session used meanwhile waits for the person, as before (R206).
    if (record.person ? this.interrupted(old, record) : !this.untouched(old, record, replyAfter(old, record.tag, record.requestedAt))) return 'person-input';
    if (typeof old.liveDraft === 'string' && old.liveDraft.trim()) return 'person-typing';
    if (old.state !== 'idle' || old.pendingTag) return old.state === 'idle' || old.state === 'working' ? 'turn-running' : `state-${old.state}`;
    if (this.collaborating(oldId, record, snapshot)) return 'collaborating';
    if (updating) return 'space-updating';
    return rowsSince(old, record.seen).length ? 'new-content' : '';
  }

  // The rotation waits from here on for its old session (advanceWaiting); the successor has the work and rests as after
  // any rotation.
  async holdOld(oldId, record, gate, now, old = null) {
    this.noteHanded(oldId, record);
    if (!waitingOld(record)) {
      record.waitSince = now;
      record.oldId ??= oldId;
      record.control = record.oldControl;
      record.controlAt = record.creatingAt ?? record.requestedAt ?? now;
      record.gates = [];
      if (old) this.noteUse(old, record, now);
      this.restSuccessor(oldId, record, now);
      this.chainsCache = null;
    }
    this.noteGate(oldId, record, gate, now);
    this.save();
    await this.broadcast();
  }

  // A confirmed handoff whose old session is kept waiting: one line, which a space's project manager follows at once
  // (R254: the person kept talking in the old one for two hours while its successor already had the manager's work).
  noteHanded(oldId, record) {
    // A line without the successor's native session names no one to follow; it is written once that is known (review N6).
    if (record.handedLogged || !validId(record.newNativeId || '')) return;
    record.oldId ??= oldId;
    const entry = this.appendLog('handed', record);
    if (this.unlogged === entry) {
      this.log.splice(this.log.indexOf(entry), 1);
      return;
    }
    record.handedLogged = true;
    this.save();
  }

  restSuccessor(oldId, record, now) {
    // The successor is not rotated again for a day, whatever its size, except for its own compactions: no replacement loop.
    if (validId(record.newNativeId || '') && !Object.hasOwn(this.rotations, record.newId)) {
      this.rotations[record.newId] = { phase: 'kept', keptAt: now, oldNativeId: record.newNativeId, name: record.newName || record.name, roomIds: record.roomIds, successorOf: oldId };
    }
  }

  // Which gate a waiting rotation is at: one log line per gate, one notice to the person, and for a long wait a line
  // in the butler's record (planDispatch gates).
  noteGate(oldId, record, gate, now) {
    if (record.gate !== gate && gate !== 'settling') {
      record.gate = gate;
      record.gates ||= [];
      if (!record.gates.includes(gate) && record.gates.length < 40) {
        record.gates.push(gate);
        this.appendLog('waiting', record, { reason: gate });
      }
      this.save();
    }
    if (!record.told && (PERSON_GATES.includes(gate) && !record.person || now - record.waitSince > STOP_WAIT_MS)) {
      record.told = true;
      this.save();
      this.roomState.rotationEvent(record.roomIds, 'oldKept', this.label(oldId, record.name), this.label(record.newId, record.newName || record.name));
      this.notify(gate === 'terminal-unsaved' ? 'keptUnsaved' : 'kept', record);
      this.broadcast().catch(() => {});
    }
  }

  // Why a session that is not running, or not in view, is not taken as out for good, or ''. A move of its backend stops
  // it for a moment, a snapshot of that moment may come later, and a move that failed leaves it to be continued.
  outGate(id, session, now) {
    if (session && !OUT_STATES.includes(session.state)) { this.outSince.delete(id); return ''; }
    let entry = null;
    try { entry = this.client.route(id); } catch { /* Not in view. */ }
    const moved = value => value.id === id && (!session || value.nativeId === session.nativeId) && !session?.archived;
    if (entry && (entry.closed || this.client.control?.maintenance?.has(entry.key)) ||
        Object.values(readRecords(path.dirname(this.file))).some(record => record.sessions.some(moved))) {
      this.outSince.delete(id);
      return 'backend-move';
    }
    if (!this.outSince.has(id)) this.outSince.set(id, now);
    return now - this.outSince.get(id) < (session ? HANDOFF_ACCEPT_MS : STOP_WAIT_MS) ? 'settling' : '';
  }

  // The session that holds the handoff now: the confirmed successor, or the one its own finished rotation replaced it
  // with, by the rule the designation follows. null when that rule cannot say.
  handoffHolder(record) {
    let edges = [], at;
    try { edges = rotationEdges(this.logFile); } catch (error) { if (error.code !== 'ENOENT') return null; }
    try { at = successor({ sessionId: record.newId, nativeId: record.newNativeId }, edges); } catch { return null; }
    // It was replaced, and by whom is not certain.
    if (edges.some(e => e.event === 'done' && e.old?.id === at.sessionId && e.old.nativeId === at.nativeId)) return null;
    return { id: at.sessionId, nativeId: at.nativeId };
  }

  // When the person last used a waiting old session: kept on the record, so that a restart does not forget it.
  noteUse(old, record, now) {
    const rows = rowsSince(old, record.seen), before = record.usedAt ?? 0;
    let used = before, theirs = false, changed = false;
    for (const row of rows) {
      if (row.role === 'user') theirs = personRow(row);
      if (theirs && Number.isFinite(row.time)) used = Math.max(used, row.time);
    }
    // The turn they asked for ended when the session became idle again.
    for (const at of [theirs ? this.idleSince.get(old.id) : undefined, this.humanAt.get(old.id)]) {
      if (Number.isFinite(at)) used = Math.max(used, at);
    }
    const control = old.controlRevision || 0;
    if (control !== record.control) {
      // Keys in its terminal raise it, and so does a message, which is there to read. Keys alone may be a prompt not sent.
      const said = rows.some(row => personRow(row) && !(Number(row.time) < record.controlAt));
      if (old.terminalInputPending === true && !said) record.typedAt = now;
      record.control = control;
      record.controlAt = now;
      used = now;
      changed = true;
    }
    if (record.typedAt !== undefined && rows.some(row => personRow(row) && Number(row.time) >= record.typedAt)) {
      delete record.typedAt;
      changed = true;
    }
    record.usedAt = Math.min(used, now);
    if (changed || record.usedAt - before > FINISH_RETRY_MS) this.save();
  }

  // Why a waiting old session cannot be asked or ended now, or ''.
  oldGate(oldId, old, record, snapshot, now) {
    // Archived by the person while it still runs: put away, not in use.
    const ready = sessionReady({ ...old, archived: false }, snapshot.wakePolicy);
    if (!ready.ready) return ready.reason !== 'not-idle' ? ready.reason : old.state === 'working' ? 'turn-running' : `state-${old.state}`;
    // Claude's own prompt says whether it holds text when NAW asks it (NATIVE_DRAFT_KEY); Codex's cannot be asked.
    if (old.provider === 'codex' && (record.typedAt !== undefined || record.person && this.unsentTyping(old))) return 'terminal-input';
    const butler = this.stewardSession(snapshot.sessions)?.steward.sessionId;
    if (!record.person && now - (record.usedAt ?? 0) < this.personQuiet(oldId, record.reason, butler)) return 'person-quiet';
    if (this.collaborating(oldId, record, snapshot)) return 'collaborating';
    if (engagedSessions({}, snapshot.rooms).has(oldId)) return 'queue-item';
    if (!settled(oldId, this.idleSince, now, this.settleMs)) return 'settling';
    return '';
  }

  // Why the successor cannot be told now, or ''.
  holderGate(session, snapshot, now) {
    const own = this.rotations[session.id];
    if (own && !RESTING_PHASES.includes(own.phase) && !waitingOld(own)) return 'successor-rotating';
    const ready = sessionReady(session, snapshot.wakePolicy).ready && settled(session.id, this.idleSince, now, this.settleMs) &&
      !humanRecent(session.id, this.humanAt, now, this.humanQuietMs);
    return ready && !engagedSessions({}, snapshot.rooms).has(session.id) ? '' : 'successor-busy';
  }

  // A designation the person has since given to another session; 'unreadable' is not an answer.
  designationMoved(oldId, record, holder) {
    if (record.roomIds.length || record.solo) return false;
    let steward;
    try { steward = this.steward(); } catch { return 'unreadable'; }
    return Boolean(steward && ![oldId, record.newId, holder?.id].includes(steward.sessionId));
  }

  // Whether the newest state still shows the session that holds the handoff, as the one it was confirmed by.
  recipientGate(record) {
    const holder = this.handoffHolder(record);
    if (!holder) return 'identity-ambiguous';
    const fresh = this.view().snapshot.sessions.find(s => s.id === holder.id);
    return !fresh || fresh.archived || SUCCESSOR_GONE_STATES.includes(fresh.state) || fresh.nativeId !== holder.nativeId ? 'successor-unavailable' : '';
  }

  // For the designated butler: whether the change, once logged, moves the designation to the session that holds the
  // handoff now and nowhere else.
  designationFollows(oldId, record) {
    let steward;
    try { steward = this.steward(); } catch { return false; }
    if (!steward || steward.sessionId !== oldId) return true;
    let edges = [];
    try { edges = rotationEdges(this.logFile); } catch (error) { if (error.code !== 'ENOENT') return false; }
    const next = successor({ sessionId: steward.sessionId, nativeId: steward.nativeId }, [...edges, { event: 'done',
      old: { id: oldId, nativeId: record.oldNativeId }, new: { id: record.newId, nativeId: record.newNativeId || null } }]);
    return next.sessionId !== oldId;
  }

  // A waiting rotation, on each pass: nothing here is timed out. First whether it can still be finished at all, then
  // whether the old session is free, then what it did after its handoff is told to the successor, then it is ended.
  async advanceWaiting(oldId, record, snapshot, now) {
    // One already waiting when this version started, or whose line could not be written.
    this.noteHanded(oldId, record);
    const old = snapshot.sessions.find(s => s.id === oldId);
    const note = gate => this.noteGate(oldId, record, gate, now);
    // Whatever the step waits for, it goes on without holding them.
    if (record.supplement && !record.supplement.released && now - record.supplement.at > TELL_HOLD_MS) {
      record.supplement.released = true;
      this.save();
    }
    if (old && old.nativeId !== record.oldNativeId) return this.keepOld(oldId, record, 'identity-changed', now);
    const holder = this.handoffHolder(record), moved = this.designationMoved(oldId, record, holder);
    if (moved === true) return this.keepOld(oldId, record, 'designation-changed', now);
    if (moved) return note('designation-unreadable');
    if (!holder) return note('identity-ambiguous');
    const outGate = this.outGate(oldId, old, now), out = outGate && !old ? 'old-missing' : outGate;
    // What it added already is told all the same.
    if (out && !['ready', 'sending', 'sent'].includes(record.supplement?.state)) return note(out);
    const fresh = snapshot.sessions.find(s => s.id === holder.id);
    const away = this.outGate(holder.id, fresh, now);
    const gone = fresh && (fresh.archived || fresh.state === 'ended' && !away);
    // One whose native session is another one now no longer has the handoff, and keeps what it was given since.
    if (gone || fresh?.nativeId && fresh.nativeId !== holder.nativeId) {
      // Nothing can be given back to one that is out of view.
      if (out && !old) return note(out);
      return this.dropSuccessor(oldId, record, old, holder, gone, now);
    }
    if (!fresh || SUCCESSOR_GONE_STATES.includes(fresh.state) || fresh.nativeId !== holder.nativeId) return note('successor-unavailable');
    if (!record.seen) record.seen = handoffSeen(old, record);
    const live = old && !['ended', 'background'].includes(old.state);
    if (live) this.noteUse(old, record, now);
    if (record.supplement) {
      const gate = await this.tellSuccessor(oldId, record, old, fresh, snapshot, now, live);
      if (gate) return note(gate);
    }
    if (out) return note(out);
    const rows = rowsSince(old, record.seen);
    // Its handoff, or what was told after it, names every decision it holds open.
    const updating = !rows.length && this.carryDecisions(oldId, record, holder);
    if (live) {
      const gate = this.oldGate(oldId, old, record, snapshot, now);
      // Its process is gone and nothing is untold: there is nothing to ask or to end.
      const exited = gate === 'state-recoverable' && sessionPlan(old, old.state).carry && !rows.length;
      if (gate && !exited) return note(gate);
    }
    const tried = this.finishTried.get(oldId);
    if (tried !== undefined && now - tried < FINISH_RETRY_MS) return;
    if (rows.length || live && record.typedAt !== undefined) {
      const missed = record.missed;
      if (live && missed?.last === (rows.at(-1)?.id ?? null) && now - missed.at < HANDOFF_TURN_MS * 2 ** (missed.tries - 1)) return note('supplement-missing');
      if (live) return note(await this.askSupplement(oldId, record, holder.id === record.newId ? record.newName || record.name : this.name(fresh), now));
      record.supplement = { id: randomUUID(), state: 'ready', at: now, text: SUPPLEMENT_NONE, seen: seenRow(old, now) };
      this.save();
      return note(await this.tellSuccessor(oldId, record, old, fresh, snapshot, now, live) || 'supplement');
    }
    if (updating) return note('space-updating');
    const gate = await this.finishRotation(oldId, record, old, now);
    if (gate) {
      this.finishTried.set(oldId, now);
      note(gate);
    }
  }

  // The old session is asked once, for what its handoff does not cover. Written down before it is sent: a restart looks
  // for the row and does not send again.
  async askSupplement(oldId, record, holderName, now) {
    const why = {};
    let current = await this.freshReady(oldId, record.person ? 0 : this.humanQuietMs, why);
    if (why.reason === 'archived') {
      // One the person put away while it runs is asked too, if nothing else holds it.
      const view = this.view(), session = view.snapshot.sessions.find(s => s.id === oldId);
      this.noteUse(session, record, view.now);
      why.reason = this.oldGate(oldId, session, record, view.snapshot, view.now);
      if (!why.reason) current = { ...view, session };
    }
    if (!current) return why.reason === 'not-idle' ? 'turn-running' : why.reason;
    if (current.session.nativeId !== record.oldNativeId || (current.session.controlRevision || 0) !== record.control) return 'control-changed';
    const id = randomUUID(), ask = { id, state: 'asking', at: now, item: `rotation-supplement:${oldId}:${id}` };
    record.supplement = ask;
    this.save();
    try {
      ask.tag = await this.send(current.session, supplementRequestText(holderName), ask.item);
      ask.state = 'asked';
      // Its prompt held nothing of the person's.
      delete record.typedAt;
      this.save();
      return 'supplement';
    } catch (error) {
      if (!notSent(error)) return 'supplement';
      delete record.supplement;
      this.finishTried.set(oldId, now);
      if (errorKey(error) === NATIVE_DRAFT_KEY) {
        this.humanAt.set(oldId, this.now());
        record.usedAt = now;
      }
      this.save();
      return errorKey(error) === NATIVE_DRAFT_KEY ? 'terminal-input' : 'supplement-not-sent';
    }
  }

  // The old session's answer, taken to the session that holds the handoff now (handoffHolder) and confirmed there as
  // its handoff was. '' once it is.
  async tellSuccessor(oldId, record, old, fresh, snapshot, now, live) {
    const s = record.supplement, to = (state, released) => { s.state = state; s.at = now; if (released) s.released = true; else delete s.released; this.save(); };
    const sentRow = (session, item) => conversation(session).findLast(m => m.dispatchItem === item);
    if (s.state === 'asking') {
      const row = sentRow(old, s.item);
      // NAW's row is written before anything native is sent: without one, nothing was.
      if (!row && now - s.at <= UNCONFIRMED_SEND_MS) return 'supplement';
      if (!row) { delete record.supplement; this.save(); return ''; }
      s.tag = row.id;
      delete record.typedAt;
      to('asked');
    }
    if (s.state === 'asked') {
      if (live && (old.state !== 'idle' || old.pendingTag)) return 'supplement';
      if (live && !settled(oldId, this.idleSince, now, this.settleMs)) return 'settling';
      const reply = supplementReply(old, s, now);
      if (!reply.text) {
        // A turn that failed or wrote nothing: asked again at once only when there is more, else after twice as long each time.
        if (reply.more) delete record.missed;
        else record.missed = { at: now, tries: (record.missed?.tries || 0) + 1, last: rowsSince(old, record.seen).at(-1)?.id ?? null };
        delete record.supplement;
        this.save();
        return '';
      }
      s.text = reply.text.slice(0, ITEM_TEXT_LIMIT * 2);
      s.seen = reply.seen;
      to('ready');
    }
    if (['sending', 'sent'].includes(s.state) && (s.toId !== fresh.id || s.toNative !== fresh.nativeId)) to('ready');
    if (s.state === 'sending') {
      const row = sentRow(fresh, s.toItem);
      if (!row && now - s.at <= UNCONFIRMED_SEND_MS) return 'supplement';
      if (row) { s.toTag = row.id; to('sent'); } else to('ready', true);
    }
    if (s.state === 'sent') {
      const outcome = firstHandoff.outcome(fresh, s.toTag);
      if (outcome === 'complete') {
        record.seen = s.seen;
        delete record.supplement;
        delete record.missed;
        this.save();
        return '';
      }
      if (outcome !== 'failed' && (now - s.at <= HANDOFF_TURN_MS || fresh.state !== 'idle')) return 'supplement';
      s.tries = (s.tries || 0) + 1;
      s.failed = true;
      to('ready', true);
    }
    // Sent again after twice as long each time: a successor at its usage limit can take it once that is over.
    if (s.failed && now - s.at < HANDOFF_TURN_MS * 2 ** (s.tries - 1)) return 'successor-turn-failed';
    delete s.failed;
    const note = decisionsNote(record.name, openDecisions(snapshot.rooms || [], old || { id: oldId, nativeId: record.oldNativeId }, record.roomIds || []));
    s.toId = fresh.id;
    s.stays = note.length > DECISIONS_LIMIT;
    if (s.stays) return 'decisions-stay';
    const gate = this.holderGate(fresh, snapshot, now);
    if (gate) return gate;
    const tried = this.finishTried.get(oldId);
    if (tried !== undefined && now - tried < FINISH_RETRY_MS) return record.gate || 'supplement';
    const current = await this.freshReady(fresh.id);
    if (!current || current.session.nativeId !== fresh.nativeId) return 'successor-busy';
    Object.assign(s, { toId: fresh.id, toNative: fresh.nativeId, toItem: `rotation-handoff:${oldId}:${randomUUID()}` });
    // One more try after a send that left nothing holds no one again until it is there.
    to('sending', s.released);
    try {
      s.toTag = await this.send(current.session, supplementText(record.name, s.text, note), s.toItem);
      to('sent');
    } catch (error) {
      if (!notSent(error)) return 'supplement';
      this.finishTried.set(oldId, now);
      to('ready', true);
      return 'successor-busy';
    }
    return 'supplement';
  }

  // The change cannot be finished: the old session is the person's, and the log says why.
  async keepOld(oldId, record, reason, now) {
    record.oldId ??= oldId;
    this.appendLog('kept', record, { reason });
    if (!record.told) {
      this.roomState.rotationEvent(record.roomIds, 'oldKept', this.label(oldId, record.name), this.label(record.newId, record.newName || record.name));
      this.notify('kept', record);
    }
    this.rotations[oldId] = { phase: 'kept', keptAt: now, oldNativeId: record.oldNativeId, name: record.name, roomIds: record.roomIds };
    this.restSuccessor(oldId, record, now);
    this.finishTried.delete(oldId);
    this.save();
    await this.broadcast();
  }

  // The successor is gone before the old session could be ended: the old one has its work back, and is due again as
  // after any interruption.
  async dropSuccessor(oldId, record, old, holder, gone, now) {
    // A manager that followed the handed line comes back only with this one: nothing is given back before it is
    // written, and it is tried again on the next pass (review N1).
    const failed = { ...record, oldId, reason: 'successor-gone' };
    if (record.handedLogged && !record.failedLogged) {
      const entry = this.appendLog('failed', failed, { reason: failed.reason });
      if (this.unlogged === entry) {
        this.log.splice(this.log.indexOf(entry), 1);
        return this.noteGate(oldId, record, 'log-unwritten', now);
      }
      record.failedLogged = true;
      this.save();
    }
    const spaces = gone && old ? spacesOf(old) : [];
    // The spaces it left for a stop that did not go through.
    const home = old && spacesOf(old).every(id => record.roomIds.includes(id));
    for (const roomId of home ? (record.left || []).filter(id => !spacesOf(old).includes(id)) : []) {
      try {
        await withTimeout(this.roomState.membership(this.client, oldId, true, record.name, roomId), CALL_TIMEOUT_MS, 'join-timeout');
        if (gone) spaces.push(roomId);
      } catch { /* The space may be gone. */ }
    }
    for (const roomId of record.roomIds) {
      if (!spaces.includes(roomId)) continue;
      try {
        this.roomState.queueReassign(roomId, holder.id, oldId);
        this.roomState.queueCarry(roomId, holder.id, oldId, old.nativeId);
      } catch (error) {
        if (error?.uiMessage?.key === 'error.room.updatingDraftRetained') return this.noteGate(oldId, record, 'space-updating', now);
      }
    }
    delete this.rotations[oldId];
    this.finishTried.delete(oldId);
    this.deferredAt.set(oldId, { at: now, due: record.reason });
    this.save();
    if (!record.failedLogged) this.appendLog('failed', failed, { reason: failed.reason });
    this.failedEvent(record.roomIds, oldId, failed);
    this.notify('failed', failed);
    await this.broadcast();
  }

  // Ends the old session, if nothing moved since `old` was judged, and writes the change as done. Returns the gate that
  // kept it from that, or ''.
  async finishRotation(oldId, record, old, now) {
    if (!this.designationFollows(oldId, record)) return 'identity-ambiguous';
    const live = old && !['ended', 'background'].includes(old.state) && !(old.state === 'recoverable' && sessionPlan(old, old.state).carry);
    const scoped = this.participantStop(oldId);
    let stoppedHere = false;
    if (live) {
      const capabilities = this.client.route(oldId).state.capabilities || [];
      if (!capabilities.includes(CONDITIONAL_STOP_CAPABILITY)) return 'old-service';
      // NAW cannot see a prompt typed but not sent in the native terminal: keep the screen first,
      // and keep the old session if its screen cannot be saved.
      if (old.terminalInputPending === true) {
        try {
          record.terminalFile = await this.saveTerminal(oldId);
        } catch {
          return 'terminal-unsaved';
        }
      }
      // Fresh state before anything changes: a session used meanwhile keeps its spaces and process.
      const judged = seenRow(old, now), seen = {};
      const quietMs = record.person ? 0 : this.humanQuietMs;
      const moved = async () => await this.touchedSince(oldId, old, seen, quietMs) ? 'changed-before-stop' : seen.latest && rowsSince(seen.latest, judged).length ? 'new-content' : this.recipientGate(record);
      const before = await moved();
      if (before) return before;
      for (const roomId of record.roomIds) {
        try {
          await withTimeout(this.roomState.membership(this.client, oldId, false, record.name, roomId), CALL_TIMEOUT_MS, 'leave-timeout');
          record.left = [...new Set([...record.left || [], roomId])];
        } catch {
          // Leaving is cosmetic; ending the old process is what frees memory.
        }
      }
      const after = await moved() || await this.stopUnchanged(oldId, seen.latest, scoped);
      if (after) {
        this.save();
        return after;
      }
      stoppedHere = true;
    }
    if (!record.oldId) {
      record.oldId = oldId;
    }
    const oldLabel = this.label(oldId, record.name);
    const newLabel = this.label(record.newId, record.newName || record.name);
    const extra = {};
    if (record.terminalFile) {
      extra.terminal = record.terminalFile;
    }
    const doneEntry = this.appendLog('done', record, extra);
    if (this.unlogged === doneEntry) {
      // Who continues is read from that file: with the line missing, the change is not done yet.
      this.log.splice(this.log.indexOf(doneEntry), 1);
      return 'log-unwritten';
    }
    const holder = this.handoffHolder(record)?.id ?? record.newId;
    for (const roomId of record.roomIds) {
      try { this.roomState.queueReassign(roomId, oldId, holder); } catch { /* The space may be gone. */ }
    }
    this.roomState.rotationEvent(record.roomIds, 'done', oldLabel, newLabel);
    this.notify(record.terminalFile ? 'saved' : 'done', record);
    delete this.rotations[oldId];
    this.finishTried.delete(oldId);
    if (!waitingOld(record)) this.restSuccessor(oldId, record, now);
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
    return '';
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
  CONTEXT_LIMITS,
  QUIET_COMPACT_MS,
  QUIET_CONTEXT_MS,
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
  engagedSessions,
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
  terminalInterrupt,
  nextName,
  rotationChains,
  waitingOld,
  QueueDispatcher,
  nawMadeDirectory,
  directoryHandoff,
};
