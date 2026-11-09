'use strict';
// Space task queues (board top 2026-11-08 16:12): when a member is truly idle,
// NAW itself sends that member's next queued item through the same send path as
// the person's input box. Long-lived members are rotated into a new session
// with a written handoff before their next item (user 2026-11-08).
// The policy functions are pure; QueueDispatcher runs them in the main process.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { roomIds } = require('./collaboration-spaces.cjs');
const fleet = require('./renderer/fleet-observation.js');

const ITEM_TEXT_LIMIT = 6000;
const QUEUE_LIMIT = 300;
const ITEM_STATUSES = ['queued', 'sent', 'done', 'waiting', 'cancelled', 'failed'];
const OPEN_STATUSES = ['queued', 'sent', 'waiting'];
// A member must stay idle this long before NAW sends, so a turn-end report can settle.
const IDLE_SETTLE_MS = 8000;
// A sent item whose send never returned a tag is not resent (no silent replay).
const UNCONFIRMED_SEND_MS = 120000;
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
// An idle old member with no work is rotated only after this long without activity,
// so a conversation the person is having is never cut off.
const QUIET_BEFORE_ROTATE_MS = 30 * 60 * 1000;
// A new member that never becomes ready (for example a startup prompt) ends the rotation.
const NEW_SESSION_READY_MS = 10 * 60 * 1000;
const TICK_MS = 3000;
const DECISION_MARKERS = ['需要你决定：', '需要你决定:', 'Needs your decision:'];

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

function startsWithDecision(text) {
  const trimmed = text.trimStart();
  for (const marker of DECISION_MARKERS) {
    if (trimmed.startsWith(marker)) {
      return true;
    }
  }
  return false;
}

// The assistant reply that followed a NAW message, or null when it is absent.
// When a native record replaced NAW's copy of the message, use the send time.
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
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant' || typeof message.text !== 'string' || !message.text.trim()) {
      continue;
    }
    let after = false;
    if (index >= 0) {
      after = i > index;
    } else if (Number.isFinite(sentAt) && Number.isFinite(message.time)) {
      after = message.time >= sentAt;
    }
    if (after) {
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
  return { found: true, text: parts.join('\n\n'), last };
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
  for (const id of Array.isArray(room.memberOrder) ? room.memberOrder : []) {
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

function rotationDue(session, now, rotateAfterMs, rotations) {
  if (!rotateAfterMs || !Number.isFinite(session.createdAt)) {
    return false;
  }
  if (!['claude', 'codex'].includes(session.provider)) {
    return false;
  }
  const record = rotations[session.id];
  if (record) {
    return false;
  }
  return now - session.createdAt >= rotateAfterMs;
}

// One pass over every space. Returns the actions in the order to run them.
function planDispatch(input) {
  const rooms = input.rooms || [];
  const sessions = input.sessions || [];
  const now = input.now;
  const settleMs = input.settleMs ?? IDLE_SETTLE_MS;
  const rotateAfterMs = input.rotateAfterMs ?? ROTATE_AFTER_MS;
  const rotations = input.rotations || {};
  const idleSince = input.idleSince || new Map();
  const byId = new Map();
  for (const session of sessions) {
    byId.set(session.id, session);
  }
  const actions = [];
  const busy = new Set();
  for (const id of Object.keys(rotations)) {
    if (rotations[id] && rotations[id].phase !== 'failed') {
      busy.add(id);
      if (rotations[id].newId) {
        busy.add(rotations[id].newId);
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
      const ready = sessionReady(member, input.wakePolicy).ready;
      if (!ready || !settled(member.id, idleSince, now, settleMs)) {
        busy.add(member.id);
        continue;
      }
      const reply = replyAfter(member, item.tag, item.sentAt);
      if (!reply) {
        actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'failed', reason: 'record-missing', sessionId: member.id });
      } else if (startsWithDecision(reply.last)) {
        actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'waiting', sessionId: member.id });
        busy.add(member.id);
      } else {
        actions.push({ kind: 'settle', roomId: room.id, itemId: item.id, status: 'done', sessionId: member.id });
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
        candidates = members.includes(item.assignee) ? [item.assignee] : [];
      }
      let target = null;
      for (const id of candidates) {
        if (busy.has(id)) {
          continue;
        }
        const session = byId.get(id);
        if (!sessionReady(session, input.wakePolicy).ready || !settled(id, idleSince, now, settleMs)) {
          continue;
        }
        target = session;
        break;
      }
      if (!target) {
        continue;
      }
      busy.add(target.id);
      if (rotationDue(target, now, rotateAfterMs, rotations)) {
        actions.push({ kind: 'rotate', sessionId: target.id });
      } else {
        actions.push({ kind: 'dispatch', roomId: room.id, itemId: item.id, sessionId: target.id });
      }
    }
  }
  // 3) Old members of queue spaces with no work are rotated too, once they have been quiet.
  const quietMs = input.quietMs ?? QUIET_BEFORE_ROTATE_MS;
  for (const room of rooms) {
    if (room.archived || !Array.isArray(room.queue) || !room.queue.length) {
      continue;
    }
    for (const id of memberIds(room, sessions)) {
      if (busy.has(id)) {
        continue;
      }
      const session = byId.get(id);
      if (!sessionReady(session, input.wakePolicy).ready || !settled(id, idleSince, now, settleMs)) {
        continue;
      }
      if (!rotationDue(session, now, rotateAfterMs, rotations)) {
        continue;
      }
      const lastActivity = Number.isFinite(session.lastActivityAt) ? session.lastActivityAt : session.createdAt;
      if (now - lastActivity < quietMs) {
        continue;
      }
      busy.add(id);
      actions.push({ kind: 'rotate', sessionId: id });
    }
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

function handoffRequestText(hours) {
  return [
    `【NAW 换会话】这个会话已经开了 ${hours} 小时以上。为了释放内存，NAW 会开一个新会话接着做，这个会话随后结束（记录保留，可以恢复）。`,
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
    this.rotateAfterMs = options.rotateAfterMs ?? ROTATE_AFTER_MS;
    this.quietMs = options.quietMs ?? QUIET_BEFORE_ROTATE_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.owner = options.owner || randomUUID();
    this.idleSince = new Map();
    this.pending = null;
    this.again = false;
    this.closed = false;
    this.client = null;
    this.own = null;
    this.timer = null;
    this.rotations = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && data.version === 1 && data.rotations && typeof data.rotations === 'object') {
        return data.rotations;
      }
    } catch {
      // Missing or damaged: no rotation is in progress.
    }
    return {};
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
    this.dropOwnClient();
  }

  dropOwnClient() {
    if (this.own) {
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

  // Metadata only, no session state: is there anything to send, settle or rotate?
  hasOpenWork() {
    for (const id of Object.keys(this.rotations)) {
      if (this.rotations[id] && this.rotations[id].phase !== 'failed') {
        return true;
      }
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
        if (item.status === 'queued' || item.status === 'sent') {
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
      this.own = await this.connect(this.owner);
    }
    return this.own;
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

  async tick() {
    if (!this.hasOpenWork()) {
      this.dropOwnClient();
      this.idleSince.clear();
      return;
    }
    this.client = await this.source();
    let current = this.view();
    if (Object.keys(this.rotations).length) {
      await this.advanceRotations(current.snapshot, current.now);
      current = this.view();
    }
    const actions = planDispatch({
      rooms: current.snapshot.rooms,
      sessions: current.snapshot.sessions,
      wakePolicy: current.snapshot.wakePolicy,
      idleSince: this.idleSince,
      now: current.now,
      settleMs: this.settleMs,
      rotateAfterMs: this.rotateAfterMs,
      quietMs: this.quietMs,
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
        await this.requestHandoff(action);
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
    await this.client.refresh();
    const current = this.view();
    const session = current.snapshot.sessions.find(s => s.id === sessionId);
    if (!session || !sessionReady(session, current.snapshot.wakePolicy).ready) {
      return null;
    }
    return current;
  }

  // Claim then send, exactly as the person's input box would.
  async send(session, text, roomId) {
    this.roomState.assertAvailable(session.id, Boolean(roomId), roomId);
    await this.client.call('claim', session.id, 'chat');
    const result = await this.client.call('send', session.id, text, session.nativeId);
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
    const session = current.snapshot.sessions.find(s => s.id === action.sessionId);
    let item = null;
    if (room) {
      item = (room.queue || []).find(i => i.id === action.itemId);
    }
    if (!room || !item || item.status !== 'queued') {
      return;
    }
    const name = this.name(session);
    // Record before sending: a crash after this point is never resent silently.
    this.roomState.queueMarkSent(room.id, item.id, session.id, name, this.now());
    await this.broadcast();
    try {
      const tag = await this.send(session, dispatchText(room.name || '', item), room.id);
      this.roomState.queueSetTag(room.id, item.id, tag);
    } catch (error) {
      this.roomState.queueSettle(room.id, item.id, 'failed', error.message || 'send-failed', name);
    }
    await this.broadcast();
  }

  async requestHandoff(action) {
    const current = await this.freshReady(action.sessionId);
    if (!current) {
      return;
    }
    const session = current.snapshot.sessions.find(s => s.id === action.sessionId);
    const hours = Math.floor((current.now - session.createdAt) / 3600000);
    const record = {
      phase: 'requested',
      requestedAt: current.now,
      tag: null,
      provider: session.provider,
      cwd: session.cwd,
      name: this.name(session),
      skipPermissions: session.skipPermissions === true,
      roomIds: roomIds(session),
    };
    this.rotations[session.id] = record;
    this.save();
    try {
      record.tag = await this.send(session, handoffRequestText(hours));
      this.save();
      this.roomState.rotationEvent(record.roomIds, 'requested', record.name, '');
    } catch (error) {
      record.phase = 'failed';
      record.reason = error.message || 'handoff-request-failed';
      this.save();
      this.roomState.rotationEvent(record.roomIds, 'failed', record.name, record.reason);
    }
    await this.broadcast();
  }

  async advanceRotations(snapshot, now) {
    for (const oldId of Object.keys(this.rotations)) {
      const record = this.rotations[oldId];
      if (!record || record.phase === 'failed') {
        continue;
      }
      try {
        await this.advanceRotation(oldId, record, snapshot, now);
      } catch (error) {
        const handedOver = record.phase === 'handed';
        record.phase = 'failed';
        record.reason = error.message || 'rotation-failed';
        this.save();
        // Before the handoff was sent the old member still owns its work: give it back.
        if (record.newId && !handedOver) {
          for (const roomId of record.roomIds) {
            try {
              this.roomState.queueReassign(roomId, record.newId, oldId);
            } catch {
              // The space may be gone; the record of the failure still stands.
            }
          }
        }
        this.roomState.rotationEvent(record.roomIds, 'failed', record.name, record.reason);
        await this.broadcast();
      }
    }
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
      if (!sessionReady(old, snapshot.wakePolicy).ready || !settled(oldId, this.idleSince, now, this.settleMs)) {
        return;
      }
      const reply = replyAfter(old, record.tag, record.requestedAt);
      if (!reply || !reply.text.trim()) {
        throw Error('handoff-missing');
      }
      record.handoff = reply.text.slice(0, ITEM_TEXT_LIMIT * 2);
      record.phase = 'creating';
      this.save();
    }
    if (record.phase === 'creating') {
      const options = { provider: record.provider, cwd: record.cwd, name: `${record.name} · 续`, view: 'chat' };
      if (record.skipPermissions) {
        options.skipPermissions = true;
      }
      record.newId = await this.client.call('create', options);
      record.createdNewAt = now;
      record.phase = 'joining';
      this.save();
      await this.client.refresh();
    }
    if (record.phase === 'joining') {
      for (const roomId of record.roomIds) {
        await this.roomState.membership(this.client, record.newId, true, `${record.name} · 续`, roomId);
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
      record.handoffTag = await this.send(fresh, handoffText(record.name, record.handoff));
      record.phase = 'handed';
      this.save();
    }
    if (record.phase === 'handed') {
      for (const roomId of record.roomIds) {
        try {
          await this.roomState.membership(this.client, oldId, false, record.name, roomId);
        } catch {
          // Leaving is cosmetic; ending the old process is what frees memory.
        }
      }
      if (old && !['ended', 'background'].includes(old.state)) {
        await this.client.call('stop', oldId);
      }
      this.roomState.rotationEvent(record.roomIds, 'done', record.name, `${record.name} · 续`);
      delete this.rotations[oldId];
      this.save();
      await this.client.refresh();
      await this.broadcast();
    }
  }
}

module.exports = {
  ITEM_TEXT_LIMIT,
  QUEUE_LIMIT,
  IDLE_SETTLE_MS,
  ROTATE_AFTER_MS,
  QUIET_BEFORE_ROTATE_MS,
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
  QueueDispatcher,
};
