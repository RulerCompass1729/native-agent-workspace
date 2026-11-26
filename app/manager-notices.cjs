'use strict';
// Telling a space's project manager what changed in its space (R253, the person, 2026-11-25, after two sessions they
// opened joined a space and were sent its manager's items while the manager sat idle: 「你咋没反应?我已经点了卡了」
// 「或者是你没有感知到这个变动,需要修」). Told: a session joined or left the space; an item in its queue, whoever added
// it (the review of 8f89855a: the acceptance names the queue's sends and deliveries, not who added them), was sent, came
// back (done, waiting, failed), was cancelled or went back to the queue. Nothing else.
//
// What is owed to whom, as answer-notices.cjs keeps it: the queue dispatcher looks at the spaces (observe) and sends
// what is owed through the same send as an answer (queue-dispatch.cjs notifyAnswers): to a manager ready and settled,
// the person quiet in it, under the automatic-message switch. Each message is one turn of the manager's model, so it
// goes only after a change; changes HOLD_MS apart go together; at most one every GAP_MS to a manager; and the first
// look at a space, or at a new manager, is no news. In memory only: NAW restarting starts from what it sees then.
const { roomIds } = require('./collaboration-spaces.cjs');

const HOLD_MS = 10 * 1000, GAP_MS = 60 * 1000, RETRY_MS = 60 * 1000, MAX_AGE_MS = 24 * 60 * 60 * 1000, MAX_EVENTS = 20, TEXT_MAX = 40;
// As long as queue-dispatch.cjs INTEGRATOR_ABSENT_MS: a backend restarting, moving or updating is away for a moment.
const ABSENT_MS = 10 * 60 * 1000;
// An item NAW sends and its member refuses goes out and back each pass; the manager hears that so often, then its end.
const BOUNCES = 3;
const ENDS = new Set(['done', 'waiting', 'failed', 'cancelled']);
const key = (sessionId, nativeId) => JSON.stringify([sessionId, nativeId]);

function shortText(text) {
  const line = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return line.length <= TEXT_MAX ? line : line.slice(0, TEXT_MAX - 1) + '…';
}

function stateOf(item) {
  return JSON.stringify([item.status, item.sentTo || null, item.ready?.branch || null, item.ready?.commit || null]);
}

function adder(item, manager) {
  if (item.addedBy === 'steward') {
    return 'butler';
  }
  if (item.creator?.kind !== 'secretary') {
    return 'person';
  }
  return item.creator.sessionId === manager.sessionId ? 'manager' : 'earlier';
}

class ManagerNotices {
  constructor({ now = Date.now, holdMs = HOLD_MS, gapMs = GAP_MS, retryMs = RETRY_MS, maxAgeMs = MAX_AGE_MS, absentMs = ABSENT_MS } = {}) {
    Object.assign(this, { now, holdMs, gapMs, retryMs, maxAgeMs, absentMs });
    // Space → what was seen there last: its manager, its other members (and since when each unlisted one is missing),
    // its items, and how often each item's going out and back was told.
    this.seen = new Map();
    // Space → its manager's key at the last look; null before the first.
    this.managing = null;
    // Manager → { sessionId, nativeId, events: subject → event, retryAt }. A later event of the same subject replaces it.
    this.owed = new Map();
    this.lastSent = new Map();
  }

  // `rooms` and `sessions` as the dispatcher sees them now; `managers`: { roomId: { sessionId, nativeId } }.
  // Whether anything new is owed.
  observe(rooms, sessions, managers, now = this.now()) {
    let added = false;
    const watched = new Set();
    const list = Array.isArray(sessions) ? sessions : [];
    const listed = new Set(list.map(s => s?.id));
    const names = new Map(list.map(s => [s?.id, s?.name || s?.id]));
    this.managing = new Map();
    for (const [roomId, manager] of Object.entries(managers || {})) {
      if (manager?.sessionId && manager.nativeId) {
        this.managing.set(roomId, key(manager.sessionId, manager.nativeId));
      }
    }
    for (const [roomId, manager] of Object.entries(managers || {})) {
      const room = (Array.isArray(rooms) ? rooms : []).find(r => r?.id === roomId);
      if (!room || room.archived || room.unavailable || !manager?.sessionId || !manager.nativeId) {
        continue;
      }
      watched.add(roomId);
      const k = key(manager.sessionId, manager.nativeId);
      const before = this.seen.get(roomId);
      const members = new Map(), absent = new Map();
      for (const s of list) {
        if (!s || s.archived || s.id === manager.sessionId) {
          continue;
        }
        let ids;
        try {
          ids = roomIds(s);
        } catch {
          continue;
        }
        if (ids.includes(roomId)) {
          members.set(s.id, s.name || s.id);
        }
      }
      // A member missing from the list is gone only once missing for absentMs, as integrationView counts it. One in the
      // list is the record's to judge: archived or out of the space is gone now.
      for (const [id, name] of before?.members || []) {
        if (members.has(id) || listed.has(id)) {
          continue;
        }
        const since = before.absent.get(id) ?? now;
        if (now - since < this.absentMs) {
          members.set(id, name);
          absent.set(id, since);
        }
      }
      const items = (Array.isArray(room.queue) ? room.queue : []).filter(item => typeof item?.id === 'string');
      const present = new Set(items.map(item => item.id));
      const bounced = new Map([...(before?.bounced || [])].filter(([id]) => present.has(id)));
      this.seen.set(roomId, { manager: k, members, absent, items: new Map(items.map(item => [item.id, stateOf(item)])), bounced });
      if (!before || before.manager !== k) {
        continue;
      }
      const events = [];
      for (const [id, name] of members) {
        if (!before.members.has(id)) events.push(['m:' + id, { kind: 'joined', id, name }]);
      }
      for (const [id, name] of before.members) {
        if (!members.has(id)) events.push(['m:' + id, { kind: 'left', id, name }]);
      }
      for (const item of items) {
        const was = before.items.get(item.id);
        // An item just added is no news; nor one sent to the manager itself, which it was given and answered.
        if ((was === undefined ? item.status === 'queued' : was === stateOf(item)) || item.sentTo === manager.sessionId) {
          continue;
        }
        const told = bounced.get(item.id) || 0, bounce = !ENDS.has(item.status);
        if (bounce && told >= BOUNCES) {
          continue;
        }
        events.push(['i:' + item.id, { kind: 'item', id: item.id, text: shortText(item.text), status: item.status, by: adder(item, manager),
          to: item.sentTo ? names.get(item.sentTo) || item.sentTo : null, reason: item.reason ? shortText(item.reason) : null,
          ready: item.ready ? { branch: item.ready.branch, commit: item.ready.commit } : null, bounce, last: bounce && told === BOUNCES - 1 }]);
      }
      if (events.length && this.add(manager, roomId, room.name || roomId, events, now)) {
        added = true;
      }
    }
    for (const roomId of [...this.seen.keys()]) {
      if (!watched.has(roomId)) this.seen.delete(roomId);
    }
    return added;
  }

  add(manager, roomId, roomName, events, now) {
    const k = key(manager.sessionId, manager.nativeId);
    const entry = this.owed.get(k) || { sessionId: manager.sessionId, nativeId: manager.nativeId, events: new Map(), retryAt: 0, dropped: 0 };
    for (const [id, event] of events) {
      // One manager may have two spaces.
      const subject = JSON.stringify([roomId, id]), was = entry.events.get(subject);
      entry.events.delete(subject);
      // Out and back in (or in and out) before it was told: nothing to tell.
      if (was && [was.kind, event.kind].sort().join() === 'joined,left') {
        continue;
      }
      entry.events.set(subject, { ...event, subject, roomId, roomName, at: now });
    }
    for (const subject of [...entry.events.keys()].slice(0, Math.max(0, entry.events.size - MAX_EVENTS))) {
      entry.events.delete(subject);
      entry.dropped += 1;
    }
    if (!entry.events.size) {
      this.owed.delete(k);
      return false;
    }
    this.owed.set(k, entry);
    return true;
  }

  waiting() { return this.owed.size > 0; }

  // When each manager's message may go: the hold after its latest change, a failed send's retry and the gap after its
  // last message all over.
  opensAt(k, entry) {
    const latest = Math.max(...[...entry.events.values()].map(e => e.at));
    return Math.max(latest + this.holdMs, entry.retryAt, (this.lastSent.get(k) ?? -Infinity) + this.gapMs);
  }

  due(now = this.now()) {
    const due = [];
    for (const [k, entry] of this.owed) {
      if (now >= this.opensAt(k, entry)) due.push({ sessionId: entry.sessionId, nativeId: entry.nativeId });
    }
    return due;
  }

  endingSoon(now, windowMs) {
    for (const [k, entry] of this.owed) {
      const end = this.opensAt(k, entry);
      if (now >= end && now - end <= windowMs) return true;
    }
    return false;
  }

  take(target) {
    const entry = this.owed.get(key(target.sessionId, target.nativeId));
    if (!entry) return [];
    const events = [...entry.events.values()].sort((a, b) => a.at - b.at);
    if (events.length && entry.dropped) events[0] = { ...events[0], dropped: entry.dropped };
    return events;
  }

  // One that changed while the send was on its way stays owed.
  sent(target, events) {
    const k = key(target.sessionId, target.nativeId), entry = this.owed.get(k);
    this.lastSent.set(k, this.now());
    if (!entry) return;
    for (const e of events) {
      if (e.bounce) {
        const bounced = this.seen.get(e.roomId)?.bounced;
        bounced?.set(e.id, (bounced.get(e.id) || 0) + 1);
      }
    }
    const told = new Set(events.map(e => JSON.stringify([e.subject, e.at])));
    for (const [subject, event] of [...entry.events]) {
      if (told.has(JSON.stringify([subject, event.at]))) entry.events.delete(subject);
    }
    entry.dropped = 0;
    if (!entry.events.size) this.owed.delete(k);
  }

  failed(target) {
    const entry = this.owed.get(key(target.sessionId, target.nativeId));
    if (entry) entry.retryAt = this.now() + this.retryMs;
  }

  // Nobody is left to tell: archived, or another native conversation now. One missing from the list keeps it until maxAgeMs.
  // A space it no longer manages (revoked or replaced, at the last look) is not its news.
  prune(sessions, now = this.now()) {
    const listed = new Map((Array.isArray(sessions) ? sessions : []).map(s => [s?.id, s]));
    for (const [k, entry] of this.owed) {
      const session = listed.get(entry.sessionId);
      for (const [subject, event] of entry.events) {
        if (now - event.at > this.maxAgeMs || this.managing && this.managing.get(event.roomId) !== k) entry.events.delete(subject);
      }
      if (!entry.events.size || session && (session.archived || session.nativeId !== entry.nativeId)) this.owed.delete(k);
    }
  }
}

const ADDERS = { manager: '你加的', butler: '大管家加的', earlier: '之前的项目经理加的', person: '人加的' };

function itemLine(e) {
  const head = `- ${ADDERS[e.by] || ADDERS.manager}队列项 ${e.id}「${e.text}」：`;
  const line = itemState(e, head);
  return e.last ? `${line}（这一项已来回多次，之后它再派出或退回不再告诉你，做完或停下时再说）` : line;
}

function itemState(e, head) {
  if (e.status === 'sent') return `${head}派给了 ${e.to}`;
  if (e.status === 'done') return e.ready ? `${head}${e.to} 交付了：READY ${e.ready.branch} ${e.ready.commit}` : `${head}${e.to} 做完了`;
  if (e.status === 'waiting') return e.reason ? `${head}${e.to} 那边停下了，等人看（${e.reason}）` : `${head}${e.to} 在等人决定`;
  if (e.status === 'failed') return `${head}没做成${e.reason ? `（${e.reason}）` : ''}`;
  if (e.status === 'cancelled') return `${head}已取消`;
  return `${head}退回了队列${e.reason ? `（${e.reason}）` : ''}`;
}

// In the language of NAW's other automatic messages to agents (answer-notices.cjs noticeText).
function eventLine(e) {
  if (e.kind === 'joined') {
    return `- ${e.name}（${e.id}）进了空间`;
  }
  return e.kind === 'left' ? `- ${e.name}（${e.id}）离开了空间` : itemLine(e);
}

function managerText(events) {
  const rooms = new Map();
  for (const e of events) {
    rooms.set(e.roomId, [...(rooms.get(e.roomId) || []), e]);
  }
  let head = `【NAW 空间变动】你管的空间「${events.at(-1)?.roomName || ''}」有变动：`, lines = events.map(eventLine);
  if (rooms.size > 1) {
    head = `【NAW 空间变动】你管的 ${rooms.size} 个空间有变动：`;
    lines = [...rooms.values()].flatMap(own => [`「${own.at(-1).roomName}」：`, ...own.map(eventLine)]);
  }
  const dropped = events[0]?.dropped ? [`（还有 ${events[0].dropped} 条更早的变动没列出）`] : [];
  return [head, ...lines, ...dropped,
    'NAW 只告诉你发生了什么，不替你做任何事；要不要接着安排照你项目经理的职责来，没有要做的就直接结束本轮。'].join('\n');
}

module.exports = Object.freeze({ ManagerNotices, managerText, HOLD_MS, GAP_MS, MAX_EVENTS, ABSENT_MS, BOUNCES });
