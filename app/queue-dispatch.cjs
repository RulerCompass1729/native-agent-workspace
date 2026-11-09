'use strict';
// Space task queues (board top 2026-11-08 16:12): when a member is truly idle,
// NAW itself sends that member's next queued item through the backend's own
// "dispatch" input, which is never a takeover or human input. Long-lived members
// are rotated into a new session with a written handoff (user 2026-11-08).
// The policy functions are pure; QueueDispatcher runs them in the main process.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { roomIds } = require('./collaboration-spaces.cjs');
const fleet = require('./renderer/fleet-observation.js');

const CAPABILITY = 'queueDispatchV1';
const ITEM_TEXT_LIMIT = 6000;
const QUEUE_LIMIT = 300;
const ITEM_STATUSES = ['queued', 'sent', 'done', 'waiting', 'cancelled', 'failed'];
const OPEN_STATUSES = ['queued', 'sent', 'waiting'];
// A member must stay idle this long before NAW sends, so a turn-end report can settle.
const IDLE_SETTLE_MS = 8000;
// The person's own activity in a session keeps NAW out of it for this long.
const HUMAN_QUIET_MS = 2 * 60 * 1000;
// A sent item whose send never returned a tag is not resent (no silent replay).
const UNCONFIRMED_SEND_MS = 120000;
// A refusal before anything was sent returns the item to the queue at most this often.
const NOT_SENT_ATTEMPTS = 5;
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
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
// A memory-triggered rotation waits for this much quiet instead of the 30 minutes for age.
const QUIET_MEMORY_MS = 10 * 60 * 1000;
// With no queued work, quiet members of every space are still checked this often.
const MAINTENANCE_MS = 60 * 1000;
const MEMORY_SAMPLE_MS = 30 * 1000;
// An idle old member with no work is rotated only after this long without activity.
const QUIET_BEFORE_ROTATE_MS = 30 * 60 * 1000;
// A new member that never becomes ready (for example a startup prompt) ends the rotation.
const NEW_SESSION_READY_MS = 10 * 60 * 1000;
const HANDOFF_ACCEPT_MS = 2 * 60 * 1000;
// The old session waits at most this long for running collaborations before it is kept instead.
const STOP_WAIT_MS = 30 * 60 * 1000;
const FAILED_ROTATION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 60000;
const CREATE_TIMEOUT_MS = 120000;
const TICK_MS = 3000;
// Without any state change, look again at least this often.
const FULL_PASS_MS = 30000;
const DECISION_MARKERS = ['需要你决定：', '需要你决定:', 'Needs your decision:'];
// Input written by NAW or another agent, not by the person.
const AUTOMATIC_ORIGINS = ['naw-dispatch', 'agent-wake', 'capacity-recovery', 'agent-control', 'room'];
// Refusals raised before the backend wrote anything: the item is still unsent.
const NOT_SENT_KEYS = [
  'error.workspace.sessionNotReady',
  'error.workspace.handoffExpired',
  'error.backgroundMessagesDisabled',
  'error.queue.personTyping',
  'error.workspace.claudeSubmitDisconnected',
  'error.workspace.nativeFirstMessageRequired',
  'error.nativeInterruptPending',
  'error.client.nativeContextChanged',
  'error.client.connectionUpdatingNoInput',
  'error.client.connectionChangedNoReplay',
  'error.room.sessionArchived',
  'error.room.workspaceArchived',
  'error.room.mergeStepsUnconfirmed',
  'error.room.updatingDraftRetained',
];
const ROTATION_PHASES = ['requested', 'creating', 'joining', 'created', 'handed', 'failed', 'kept'];
// Records that only stop a member from being rotated again for a while.
const RESTING_PHASES = ['failed', 'kept'];
// The active backend can start a session with given settings (workspace.cjs createSettings).
const CREATE_SETTINGS_CAPABILITY = 'createSettingsV1';
// What a new session can be started with; must match workspace.cjs (a test compares them).
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/;
const CODEX_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
// One rotation at a time: each starts a new native session, and several at once would raise
// memory just when the machine may be short of it.
const MAX_ACTIVE_ROTATIONS = 1;

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

function validTime(value) {
  return Number.isFinite(value) && value >= 0;
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
  return { ...item };
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

function newItem(text, assignee, now = Date.now()) {
  if (!validText(text, ITEM_TEXT_LIMIT)) {
    throw Error('Invalid queue text');
  }
  if (assignee !== null && !validId(assignee)) {
    throw Error('Invalid queue assignee');
  }
  return { id: randomUUID(), text, assignee, status: 'queued', createdAt: now };
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
  return { ready: true, reason: '' };
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
// in between. When a native record replaced NAW's copy, use the send time.
function replyAfter(session, tag, sentAt) {
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
  const parts = [];
  let humanAfter = false;
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
    // A row with an origin is judged by it; only native rows without one fall back to NAW's marker.
    let automatic = AUTOMATIC_ORIGINS.includes(message.origin);
    if (message.origin === undefined && typeof message.text === 'string') {
      automatic = message.text.includes('【NAW 派活】') || message.text.includes('【NAW 换会话】');
    }
    if (message.role === 'user' && !automatic) {
      humanAfter = true;
    }
    if (message.role === 'assistant' && typeof message.text === 'string' && message.text.trim()) {
      parts.push(message.text);
    }
  }
  if (index < 0 && !parts.length) {
    return null;
  }
  let last = '';
  if (parts.length) {
    last = parts[parts.length - 1];
  }
  return { found: true, text: parts.join('\n\n'), last, humanAfter };
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
  }
  // A Codex successor starts in chat view: a new native Codex terminal starts its thread only
  // after native prompts (trust, sign-in) that no one is there to answer, and chat view runs no
  // terminal process. The person's terminal tab then resumes the same thread.
  let view = 'chat';
  if (session.provider === 'claude' && session.view === 'terminal') {
    view = 'terminal';
  }
  return { settings, view };
}

// Does the new session report what it was started with? 'pending' until it reports a model.
function settingsMismatch(carry, fresh) {
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

// Why a member is due for rotation now: 'age', 'memory' or null.
function rotationReason(session, now, options, rotations) {
  if (!['claude', 'codex'].includes(session.provider) || rotations[session.id]) {
    return null;
  }
  const start = sessionStart(session, now);
  if (start === null) {
    return null;
  }
  if (options.rotateAfterMs && now - start >= options.rotateAfterMs) {
    return 'age';
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

// One pass over every space. Returns the actions in the order to run them.
function planDispatch(input) {
  const rooms = input.rooms || [];
  const sessions = input.sessions || [];
  const now = input.now;
  const settleMs = input.settleMs ?? IDLE_SETTLE_MS;
  const rotateAfterMs = input.rotateAfterMs ?? ROTATE_AFTER_MS;
  const quietMs = input.quietMs ?? QUIET_BEFORE_ROTATE_MS;
  const quietMemoryMs = input.quietMemoryMs ?? QUIET_MEMORY_MS;
  const rotationOptions = {
    rotateAfterMs,
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
  const busy = new Set();
  let rotationSlots = MAX_ACTIVE_ROTATIONS;
  for (const id of Object.keys(rotations)) {
    const record = rotations[id];
    if (record && !RESTING_PHASES.includes(record.phase)) {
      rotationSlots -= 1;
      busy.add(id);
      if (record.newId && !record.handoffConfirmed) {
        busy.add(record.newId);
      }
    }
  }
  // A member in a running space collaboration is taking part in that exchange.
  for (const room of rooms) {
    if (room.run && room.run.status === 'running' && Array.isArray(room.run.ids)) {
      for (const id of room.run.ids) {
        busy.add(id);
      }
    }
  }
  // 1) Settle items already sent.
  for (const room of rooms) {
    for (const item of room.queue || []) {
      if (item.status === 'waiting' && item.sentTo) {
        busy.add(item.sentTo);
      }
      if (item.status !== 'sent') {
        continue;
      }
      const member = byId.get(item.sentTo);
      if (!item.tag) {
        if (now - (item.sentAt || 0) > UNCONFIRMED_SEND_MS) {
          actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'failed', reason: 'send-unconfirmed', sessionId: item.sentTo });
        } else {
          busy.add(item.sentTo);
        }
        continue;
      }
      if (!member) {
        actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'failed', reason: 'member-missing', sessionId: item.sentTo });
        continue;
      }
      if (member.state !== 'idle' || member.pendingTag || !settled(member.id, idleSince, now, settleMs)) {
        busy.add(member.id);
        continue;
      }
      const reply = replyAfter(member, item.tag, item.sentAt);
      const controlChanged = Number.isSafeInteger(item.control) && (member.controlRevision || 0) !== item.control;
      let status = 'done';
      let reason = '';
      if (!reply) {
        status = 'failed';
        reason = 'record-missing';
      } else if (reply.humanAfter || controlChanged) {
        status = 'waiting';
        reason = 'person-intervened';
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
      actions.push(action);
      if (status !== 'done') {
        busy.add(member.id);
      }
    }
  }
  // 2) Send the next queued item to each ready member, one item per member.
  for (const room of rooms) {
    if (room.archived) {
      continue;
    }
    const members = memberIds(room, sessions);
    for (const item of room.queue || []) {
      if (item.status !== 'queued') {
        continue;
      }
      let candidates = members;
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
        continue;
      }
      busy.add(target.id);
      const reason = rotationReason(target, now, rotationOptions, rotations);
      if (reason && rotationSlots > 0) {
        rotationSlots -= 1;
        actions.push({ kind: 'rotate', sessionId: target.id, reason });
      } else {
        // Due but another rotation is running: it keeps working and is rotated later.
        actions.push({ kind: 'dispatch', roomId: room.id, itemId: item.id, sessionId: target.id });
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
  for (const room of rooms) {
    if (room.archived) {
      continue;
    }
    for (const id of memberIds(room, sessions)) {
      if (busy.has(id)) {
        continue;
      }
      const session = byId.get(id);
      // Ten or thirty quiet minutes already settle the member; the 8-second idle timer is not needed.
      const ready = sessionReady(session, input.wakePolicy).ready && !humanRecent(id, humanAt, now, humanQuietMs);
      const reason = ready ? rotationReason(session, now, rotationOptions, rotations) : null;
      if (!reason) {
        continue;
      }
      const lastActivity = lastActivityOf(session, now);
      let quiet = quietMs;
      if (reason === 'memory') {
        quiet = quietMemoryMs;
      }
      if (now - lastActivity < quiet) {
        continue;
      }
      busy.add(id);
      quietCandidates.push({ sessionId: id, reason, memory: memoryOf(id), start: sessionStart(session, now) });
    }
  }
  // The largest session goes first, then the oldest.
  quietCandidates.sort((a, b) => b.memory - a.memory || a.start - b.start);
  for (const candidate of quietCandidates.slice(0, Math.max(rotationSlots, 0))) {
    actions.push({ kind: 'rotate', sessionId: candidate.sessionId, reason: candidate.reason });
  }
  return actions;
}

function dispatchText(roomName, item) {
  return [
    `【NAW 派活】空间「${roomName}」队列里的下一件：`,
    '',
    item.text,
    '',
    '做完这一件就结束本轮，NAW 会接着派下一件。需要人来决定时，回复第一行写「需要你决定：」，NAW 会停派并提醒。',
  ].join('\n');
}

function rotationWhy(reason, hours, bytes) {
  if (reason === 'memory') {
    return `这个会话（连同它的子进程）已占用约 ${(bytes / 1073741824).toFixed(1)} GB 内存`;
  }
  return `这个会话已经开了 ${hours} 小时以上`;
}

function handoffRequestText(why) {
  return [
    `【NAW 换会话】${why}。为了释放内存，NAW 会开一个新会话接着做，这个会话随后结束（记录保留，可以恢复）。`,
    '',
    '请现在只写交接，不要开始新工作。交接写给接手的新会话，包括：',
    '1. 正在做的事和目标；',
    '2. 工作目录、分支、最近的提交；',
    '3. 没做完的事和下一步；',
    '4. 需要注意的约定、坑和待人决定的问题。',
  ].join('\n');
}

function handoffText(oldName, handoff) {
  return [
    `【NAW 换会话】你接手「${oldName}」的工作。旧会话已经结束，它写的交接如下：`,
    '',
    handoff,
    '',
    '先按交接核对现状（只读即可），然后结束本轮。队列里的下一件，NAW 会接着派给你。',
  ].join('\n');
}

function shortText(text, limit = 60) {
  const line = text.replace(/\s+/gu, ' ').trim();
  if (line.length <= limit) {
    return line;
  }
  return line.slice(0, limit - 1) + '…';
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
  if (!['requested', 'done', 'kept', 'failed'].includes(entry.event) || !Number.isFinite(entry.time)) {
    return false;
  }
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

function notSent(error) {
  if (error && error.notSent === true) {
    return true;
  }
  const key = error && error.uiMessage && error.uiMessage.key;
  return typeof key === 'string' && NOT_SENT_KEYS.includes(key);
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

// A private, owner-only file with well-formed records; anything else is ignored.
function readRotations(file, now) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return {};
  }
  const ownerOnly = (stat.mode & 0o077) === 0;
  const mine = !process.getuid || stat.uid === process.getuid();
  if (!stat.isFile() || !ownerOnly || !mine) {
    return {};
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!data || data.version !== 1 || !data.rotations || typeof data.rotations !== 'object' || Array.isArray(data.rotations)) {
    return {};
  }
  const result = {};
  for (const oldId of Object.keys(data.rotations)) {
    const record = data.rotations[oldId];
    if (!validId(oldId) || !record || typeof record !== 'object' || !ROTATION_PHASES.includes(record.phase)) {
      continue;
    }
    if (!validId(record.oldNativeId || '') || !Array.isArray(record.roomIds) || typeof record.name !== 'string') {
      continue;
    }
    if (record.newId !== undefined && !validId(record.newId)) {
      continue;
    }
    if (record.phase === 'failed' && now - (record.failedAt || 0) > FAILED_ROTATION_KEEP_MS) {
      continue;
    }
    if (record.phase === 'kept' && now - (record.keptAt || 0) > ROTATE_AFTER_MS) {
      continue;
    }
    result[oldId] = record;
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
    this.broadcast = options.broadcast || (async () => {});
    this.file = path.join(options.dataDir, 'queue-dispatch.json');
    this.now = options.now || Date.now;
    this.settleMs = options.settleMs ?? IDLE_SETTLE_MS;
    this.humanQuietMs = options.humanQuietMs ?? HUMAN_QUIET_MS;
    this.rotateAfterMs = options.rotateAfterMs ?? ROTATE_AFTER_MS;
    this.quietMs = options.quietMs ?? QUIET_BEFORE_ROTATE_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.memoryLimit = options.memoryLimit ?? MEMORY_LIMIT_BYTES;
    this.pressureLimit = options.pressureLimit ?? PRESSURE_LIMIT_BYTES;
    this.memoryMinAgeMs = options.memoryMinAgeMs ?? MEMORY_MIN_AGE_MS;
    this.sampleProcesses = options.sampleProcesses || (() => execText('/usr/bin/top', ['-l', '1', '-stats', 'pid,ppid,mem']));
    this.samplePressure = options.samplePressure || (() => execText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
    this.memorySample = null;
    this.lastMaintenance = 0;
    this.owner = options.owner || randomUUID();
    this.idleSince = new Map();
    this.humanAt = new Map();
    this.pending = null;
    this.again = false;
    this.closed = false;
    this.client = null;
    this.listening = null;
    this.own = null;
    this.timer = null;
    this.dirty = true;
    this.lastFullPass = 0;
    this.onState = () => {
      this.dirty = true;
    };
    this.rotations = readRotations(this.file, this.now());
    this.notify = options.notify || (() => {});
    this.logFile = path.join(options.dataDir, 'rotation-log.jsonl');
    this.log = this.loadLog();
    this.chainsCache = null;
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

  save() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, rotations: this.rotations }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  async start() {
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
      this.dirty = true;
    }
  }

  listen(client) {
    if (this.listening === client) {
      return;
    }
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
    this.pending = this.loop();
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
      const failedOver = record.phase === 'failed' && now - (record.failedAt || 0) > FAILED_ROTATION_KEEP_MS;
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
      if (this.rotations[id] && !RESTING_PHASES.includes(this.rotations[id].phase)) {
        ids.push(id);
      }
    }
    return ids;
  }

  // Metadata only, no session state: is there anything to send, settle or rotate?
  hasOpenWork() {
    if (this.activeRotations().length) {
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
        if (OPEN_STATUSES.includes(item.status)) {
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
    const now = this.now();
    for (const session of snapshot.sessions) {
      if (sessionReady(session, snapshot.wakePolicy).ready) {
        if (!this.idleSince.has(session.id)) {
          this.idleSince.set(session.id, now);
        }
      } else {
        this.idleSince.delete(session.id);
      }
    }
    return { snapshot, now };
  }

  name(session) {
    const label = this.labels.get(session.id);
    if (typeof label === 'string' && label) {
      return label;
    }
    return session.name || session.id;
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
    const due = this.dirty || rotating || now - this.lastFullPass >= FULL_PASS_MS || this.settlingSoon(now) || now === this.lastMaintenance;
    if (!due) {
      return;
    }
    this.dirty = false;
    this.lastFullPass = now;
    let current = this.view();
    if (rotating) {
      await this.advanceRotations(current.snapshot, current.now);
      current = this.view();
    }
    const sample = await this.memory(current.snapshot.sessions, current.now);
    const actions = planDispatch({
      rooms: current.snapshot.rooms,
      sessions: current.snapshot.sessions,
      wakePolicy: current.snapshot.wakePolicy,
      idleSince: this.idleSince,
      humanAt: this.humanAt,
      now: current.now,
      settleMs: this.settleMs,
      humanQuietMs: this.humanQuietMs,
      rotateAfterMs: this.rotateAfterMs,
      quietMs: this.quietMs,
      memory: sample.memory,
      memoryLimit: sample.limit,
      memoryMinAgeMs: this.memoryMinAgeMs,
      rotations: this.rotations,
    });
    for (const action of actions) {
      if (this.closed) {
        return;
      }
      if (action.kind === 'settle') {
        this.settle(action, current.snapshot);
      } else if (action.kind === 'dispatch') {
        await this.dispatch(action);
      } else if (action.kind === 'rotate') {
        await this.requestHandoff(action, sample.memory.get(action.sessionId));
      }
    }
  }

  settle(action, snapshot) {
    const session = snapshot.sessions.find(s => s.id === action.sessionId);
    let name = action.sessionId;
    if (session) {
      name = this.name(session);
    }
    this.roomState.queueSettle(action.roomId, action.itemId, action.status, action.reason || '', name);
    this.broadcast().catch(() => {});
  }

  // Read fresh state once, right before sending; skip quietly if the member moved on.
  async freshReady(sessionId) {
    await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
    const current = this.view();
    const session = current.snapshot.sessions.find(s => s.id === sessionId);
    if (!session || !sessionReady(session, current.snapshot.wakePolicy).ready) {
      return null;
    }
    if (humanRecent(sessionId, this.humanAt, current.now, this.humanQuietMs)) {
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
    const entry = this.preflight(session);
    const call = entry.client.call('dispatch', session.id, text, session.nativeId, itemId);
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

  async dispatch(action) {
    const current = await this.freshReady(action.sessionId);
    if (!current) {
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
    } catch {
      // Nothing was recorded or sent; the next pass looks again.
      return;
    }
    const name = this.name(session);
    // Record before sending: a crash after this point is never resent silently.
    this.roomState.queueMarkSent(room.id, item.id, session.id, name, this.now());
    try {
      const tag = await this.send(session, dispatchText(room.name || '', item), item.id);
      this.roomState.queueSetDelivery(room.id, item.id, tag, session.controlRevision || 0);
    } catch (error) {
      if (notSent(error)) {
        this.roomState.queueRequeue(room.id, item.id, error.message || 'not-sent', NOT_SENT_ATTEMPTS, name);
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
    this.roomState.rotationEvent(record.roomIds, 'failed', this.label(session.id, record.name), record.reason);
    this.notify('failed', record);
  }

  async requestHandoff(action, bytes) {
    const current = await this.freshReady(action.sessionId);
    if (!current) {
      return;
    }
    const session = current.session;
    const start = sessionStart(session, current.now);
    let hours = 0;
    if (start !== null) {
      hours = Math.floor((current.now - start) / 3600000);
    }
    const reason = action.reason || 'age';
    const why = rotationWhy(reason, hours, bytes || 0);
    // Decided before the old session is asked anything: a successor must match it.
    const carry = carrySettings(session);
    let refusal = carry.reason;
    if (!refusal && !(current.snapshot.capabilities || []).includes(CREATE_SETTINGS_CAPABILITY)) {
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
      view: carry.view,
      phase: 'requested',
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
      record.tag = await this.send(session, handoffRequestText(why), `rotation:${session.id}`);
      this.save();
      this.appendLog('requested', record, { reason, why });
      this.roomState.rotationEvent(record.roomIds, 'requested', this.label(session.id, record.name), why);
    } catch (error) {
      if (notSent(error)) {
        delete this.rotations[session.id];
      } else {
        record.phase = 'failed';
        record.failedAt = current.now;
        record.reason = error.message || 'handoff-request-failed';
        this.appendLog('failed', record, { reason: record.reason });
        this.roomState.rotationEvent(record.roomIds, 'failed', this.label(session.id, record.name), record.reason);
        this.notify('failed', record);
      }
      this.save();
    }
    await this.broadcast();
  }

  async advanceRotations(snapshot, now) {
    for (const oldId of this.activeRotations()) {
      const record = this.rotations[oldId];
      try {
        await this.advanceRotation(oldId, record, snapshot, now);
      } catch (error) {
        await this.failRotation(oldId, record, error.message || 'rotation-failed', now);
      }
    }
  }

  // Undo what a failed rotation started; the old member keeps its session and work.
  async failRotation(oldId, record, reason, now) {
    const phase = record.phase;
    record.phase = 'failed';
    record.failedAt = now;
    record.reason = reason;
    this.save();
    if (record.newId && !record.handoffConfirmed && ['joining', 'created', 'handed'].includes(phase)) {
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
      }
    }
    if (!record.oldId) {
      record.oldId = oldId;
    }
    this.appendLog('failed', record, { reason });
    this.roomState.rotationEvent(record.roomIds, 'failed', this.label(oldId, record.name), reason);
    this.notify('failed', record);
    await this.broadcast();
  }

  async advanceRotation(oldId, record, snapshot, now) {
    const old = snapshot.sessions.find(s => s.id === oldId);
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
      // After a restart, adopt a session this rotation already created.
      let existing = null;
      for (const session of snapshot.sessions) {
        const recent = Number.isFinite(session.createdAt) && session.createdAt >= (record.creatingAt || 0) - 5000;
        if (session.name === name && session.cwd === record.cwd && recent) {
          existing = session;
        }
      }
      if (existing) {
        record.newId = existing.id;
      } else {
        const options = { provider: record.provider, cwd: record.cwd, name, view: record.view || 'chat' };
        if (record.skipPermissions) {
          options.skipPermissions = true;
        }
        if (record.carry) {
          options.settings = record.carry;
        }
        record.newId = await withTimeout(this.client.call('create', options), CREATE_TIMEOUT_MS, 'create-timeout');
      }
      record.createdNewAt = now;
      record.phase = 'joining';
      this.save();
      await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
    }
    if (record.phase === 'joining') {
      for (const roomId of record.roomIds) {
        await withTimeout(this.roomState.membership(this.client, record.newId, true, record.newName, roomId), CALL_TIMEOUT_MS, 'join-timeout');
        this.roomState.queueReassign(roomId, oldId, record.newId);
      }
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
      if (!sessionReady(fresh, snapshot.wakePolicy).ready || !settled(fresh.id, this.idleSince, now, this.settleMs)) {
        if (now - (record.createdNewAt || now) > NEW_SESSION_READY_MS) {
          throw Error('new-session-not-ready');
        }
        return;
      }
      if (old && !this.untouched(old, record, replyAfter(old, record.tag, record.requestedAt))) {
        throw Error('person-active');
      }
      // The new session must report the old one's model (and, once reported, effort and mode).
      const mismatch = settingsMismatch(record.carry, fresh);
      if (mismatch === 'pending') {
        if (now - (record.createdNewAt || now) > NEW_SESSION_READY_MS) {
          throw Error('new-session-model-unreported');
        }
        return;
      }
      if (mismatch) {
        throw Error(`settings-differ:${mismatch}`);
      }
      record.handoffTag = await this.send(fresh, handoffText(record.name, record.handoff), `rotation-handoff:${oldId}`);
      record.handedAt = now;
      record.phase = 'handed';
      this.save();
      return;
    }
    if (record.phase === 'handed') {
      const fresh = snapshot.sessions.find(s => s.id === record.newId);
      let accepted = false;
      if (fresh) {
        const message = (fresh.messages || []).find(m => m.id === record.handoffTag);
        accepted = Boolean(message && message.status === 'submitted') || fresh.state === 'working';
      }
      if (!accepted) {
        if (now - (record.handedAt || now) > HANDOFF_ACCEPT_MS) {
          throw Error('handoff-unconfirmed');
        }
        return;
      }
      // Effort and permission mode are often reported only with the first prompt: compare again.
      const mismatch = settingsMismatch(record.carry, fresh);
      if (mismatch && mismatch !== 'pending') {
        throw Error(`settings-differ:${mismatch}`);
      }
      record.handoffConfirmed = true;
      if (fresh && fresh.nativeId) {
        record.newNativeId = fresh.nativeId;
      }
      this.save();
      // Ending a session pauses running collaborations; wait until none is running, but not forever.
      let collaborating = false;
      for (const room of snapshot.rooms || []) {
        if (room.run && room.run.status === 'running') {
          collaborating = true;
        }
      }
      const live = old && !['ended', 'background'].includes(old.state);
      const waitedTooLong = now - (record.handedAt || now) > STOP_WAIT_MS;
      if (live && collaborating && !waitedTooLong) {
        return;
      }
      let inUse = false;
      if (live) {
        const quiet = old.state === 'idle' && !old.pendingTag;
        inUse = collaborating || !quiet || !this.untouched(old, record, replyAfter(old, record.tag, record.requestedAt));
      }
      if (live && !inUse) {
        for (const roomId of record.roomIds) {
          try {
            await withTimeout(this.roomState.membership(this.client, oldId, false, record.name, roomId), CALL_TIMEOUT_MS, 'leave-timeout');
          } catch {
            // Leaving is cosmetic; ending the old process is what frees memory.
          }
        }
        await withTimeout(this.client.call('stop', oldId), CALL_TIMEOUT_MS, 'stop-timeout');
      }
      if (!record.oldId) {
        record.oldId = oldId;
      }
      const outcome = inUse ? 'kept' : 'done';
      const oldLabel = this.label(oldId, record.name);
      const newLabel = this.label(record.newId, record.newName || record.name);
      this.appendLog(outcome, record);
      this.roomState.rotationEvent(record.roomIds, inUse ? 'oldKept' : 'done', oldLabel, newLabel);
      this.notify(outcome, record);
      if (inUse) {
        this.rotations[oldId] = { phase: 'kept', keptAt: now, oldNativeId: record.oldNativeId, name: record.name, roomIds: record.roomIds };
      } else {
        delete this.rotations[oldId];
      }
      // The successor is not rotated again for a day, whatever its size: no replacement loop.
      if (validId(record.newNativeId || '')) {
        this.rotations[record.newId] = { phase: 'kept', keptAt: now, oldNativeId: record.newNativeId, name: record.newName || record.name, roomIds: record.roomIds, successorOf: oldId };
      }
      this.save();
      await withTimeout(this.client.refresh(), CALL_TIMEOUT_MS, 'refresh-timeout');
      await this.broadcast();
    }
  }
}

module.exports = {
  CAPABILITY,
  ITEM_TEXT_LIMIT,
  QUEUE_LIMIT,
  IDLE_SETTLE_MS,
  HUMAN_QUIET_MS,
  ROTATE_AFTER_MS,
  QUIET_BEFORE_ROTATE_MS,
  NOT_SENT_ATTEMPTS,
  validateQueue,
  newItem,
  trimQueue,
  sessionReady,
  planDispatch,
  replyAfter,
  dispatchText,
  handoffRequestText,
  handoffText,
  shortText,
  notSent,
  readRotations,
  processMemory,
  memoryPressure,
  sessionStart,
  lastActivityOf,
  reportedModel,
  carrySettings,
  settingsMismatch,
  CREATE_SETTINGS_CAPABILITY,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_EFFORTS,
  MEMORY_LIMIT_BYTES,
  PRESSURE_LIMIT_BYTES,
  MEMORY_MIN_AGE_MS,
  terminalReplyOnly,
  nextName,
  rotationChains,
  QueueDispatcher,
};
