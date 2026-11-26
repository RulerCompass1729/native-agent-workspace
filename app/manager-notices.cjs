'use strict';
// Telling a space's project manager what changed in its space (R253, the person, 2026-11-25, after two sessions they
// opened joined a space and were sent its manager's items while the manager sat idle: 「你咋没反应?我已经点了卡了」
// 「或者是你没有感知到这个变动,需要修」). Told: a session joined or left the space; an item the space's manager added was
// sent, came back (done, waiting, failed), was cancelled or went back to the queue. Nothing else.
//
// What is owed to whom, as answer-notices.cjs keeps it: the queue dispatcher looks at the spaces (observe) and sends
// what is owed through the same send as an answer (queue-dispatch.cjs notifyAnswers): to a manager ready and settled,
// the person quiet in it, under the automatic-message switch. Each message is one turn of the manager's model, so it
// goes only after a change; changes HOLD_MS apart go together; at most one every GAP_MS to a manager; and the first
// look at a space, or at a new manager, is no news. In memory only: NAW restarting starts from what it sees then.
const { roomIds } = require('./collaboration-spaces.cjs');

const HOLD_MS = 10 * 1000, GAP_MS = 60 * 1000, RETRY_MS = 60 * 1000, MAX_AGE_MS = 24 * 60 * 60 * 1000, MAX_EVENTS = 20, TEXT_MAX = 40;
const key = (sessionId, nativeId) => JSON.stringify([sessionId, nativeId]);

function shortText(text) {
  const line = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return line.length <= TEXT_MAX ? line : line.slice(0, TEXT_MAX - 1) + '…';
}

function stateOf(item) {
  return JSON.stringify([item.status, item.sentTo || null, item.ready?.branch || null, item.ready?.commit || null]);
}

class ManagerNotices {
  constructor({ now = Date.now, holdMs = HOLD_MS, gapMs = GAP_MS, retryMs = RETRY_MS, maxAgeMs = MAX_AGE_MS } = {}) {
    Object.assign(this, { now, holdMs, gapMs, retryMs, maxAgeMs });
    // Space → what was seen there last: its manager, its other members, the manager's items.
    this.seen = new Map();
    // Manager → { sessionId, nativeId, events: subject → event, retryAt }. A later event of the same subject replaces it.
    this.owed = new Map();
    this.lastSent = new Map();
  }

  // `rooms` and `sessions` as the dispatcher sees them now; `managers`: { roomId: { sessionId, nativeId } }.
  // Whether anything new is owed.
  observe(rooms, sessions, managers, now = this.now()) {
    let added = false;
    const watched = new Set();
    const names = new Map((Array.isArray(sessions) ? sessions : []).map(s => [s?.id, s?.name || s?.id]));
    for (const [roomId, manager] of Object.entries(managers || {})) {
      const room = (Array.isArray(rooms) ? rooms : []).find(r => r?.id === roomId);
      if (!room || room.archived || room.unavailable || !manager?.sessionId || !manager.nativeId) {
        continue;
      }
      watched.add(roomId);
      const k = key(manager.sessionId, manager.nativeId);
      const members = new Map();
      for (const s of Array.isArray(sessions) ? sessions : []) {
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
      // The space's manager's own items; the butler's are marked secretary too (queue-dispatch.cjs managerItemMayGo).
      const items = (Array.isArray(room.queue) ? room.queue : []).filter(item => item?.creator?.kind === 'secretary' && item.addedBy !== 'steward');
      const before = this.seen.get(roomId);
      this.seen.set(roomId, { manager: k, members, items: new Map(items.map(item => [item.id, stateOf(item)])) });
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
        // Its own item just added is no news to it.
        if (was === undefined ? item.status === 'queued' : was === stateOf(item)) {
          continue;
        }
        events.push(['i:' + item.id, { kind: 'item', id: item.id, text: shortText(item.text), status: item.status,
          to: item.sentTo ? names.get(item.sentTo) || item.sentTo : null, reason: item.reason || null,
          ready: item.ready ? { branch: item.ready.branch, commit: item.ready.commit } : null }]);
      }
      if (events.length) {
        this.add(manager, room.name || roomId, events, now);
        added = true;
      }
    }
    for (const roomId of [...this.seen.keys()]) {
      if (!watched.has(roomId)) this.seen.delete(roomId);
    }
    return added;
  }

  add(manager, roomName, events, now) {
    const k = key(manager.sessionId, manager.nativeId);
    const entry = this.owed.get(k) || { sessionId: manager.sessionId, nativeId: manager.nativeId, events: new Map(), retryAt: 0, dropped: 0 };
    for (const [subject, event] of events) {
      entry.events.delete(subject);
      entry.events.set(subject, { ...event, roomName, at: now });
    }
    for (const subject of [...entry.events.keys()].slice(0, Math.max(0, entry.events.size - MAX_EVENTS))) {
      entry.events.delete(subject);
      entry.dropped += 1;
    }
    this.owed.set(k, entry);
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
    const told = new Set(events.map(e => JSON.stringify([e.kind === 'item' ? 'i' : 'm', e.id, e.at])));
    for (const [subject, event] of [...entry.events]) {
      if (told.has(JSON.stringify([event.kind === 'item' ? 'i' : 'm', event.id, event.at]))) entry.events.delete(subject);
    }
    entry.dropped = 0;
    if (!entry.events.size) this.owed.delete(k);
  }

  failed(target) {
    const entry = this.owed.get(key(target.sessionId, target.nativeId));
    if (entry) entry.retryAt = this.now() + this.retryMs;
  }

  // Nobody is left to tell: archived, or another native conversation now. One missing from the list keeps it until maxAgeMs.
  prune(sessions, now = this.now()) {
    const listed = new Map((Array.isArray(sessions) ? sessions : []).map(s => [s?.id, s]));
    for (const [k, entry] of this.owed) {
      const session = listed.get(entry.sessionId);
      for (const [subject, event] of entry.events) {
        if (now - event.at > this.maxAgeMs) entry.events.delete(subject);
      }
      if (!entry.events.size || session && (session.archived || session.nativeId !== entry.nativeId)) this.owed.delete(k);
    }
  }
}

function itemLine(e) {
  const head = `- 你加的队列项 ${e.id}「${e.text}」：`;
  if (e.status === 'sent') return `${head}派给了 ${e.to}`;
  if (e.status === 'done') return e.ready ? `${head}${e.to} 交付了：READY ${e.ready.branch} ${e.ready.commit}` : `${head}${e.to} 做完了`;
  if (e.status === 'waiting') return e.reason ? `${head}${e.to} 那边停下了，等人看（${e.reason}）` : `${head}${e.to} 在等人决定`;
  if (e.status === 'failed') return `${head}没做成${e.reason ? `（${e.reason}）` : ''}`;
  if (e.status === 'cancelled') return `${head}已取消`;
  return `${head}退回了队列${e.reason ? `（${e.reason}）` : ''}`;
}

// In the language of NAW's other automatic messages to agents (answer-notices.cjs noticeText).
function managerText(events) {
  const room = events.at(-1)?.roomName || '';
  const lines = events.map(e => e.kind === 'joined' ? `- ${e.name}（${e.id}）进了空间` : e.kind === 'left' ? `- ${e.name}（${e.id}）离开了空间` : itemLine(e));
  const dropped = events[0]?.dropped ? [`（还有 ${events[0].dropped} 条更早的变动没列出）`] : [];
  return [`【NAW 空间变动】你管的空间「${room}」有变动：`, ...lines, ...dropped,
    'NAW 只告诉你发生了什么，不替你做任何事；要不要接着安排照你项目经理的职责来，没有要做的就直接结束本轮。'].join('\n');
}

module.exports = Object.freeze({ ManagerNotices, managerText, HOLD_MS, GAP_MS, MAX_EVENTS });
