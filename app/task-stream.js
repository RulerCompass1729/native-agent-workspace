// Read-only projections for the time-ordered shared stream and the waiting strip.
// Waiting rules adapted from the earlier waiting-strip implementation (62f94f08).
(function (root) {
  const ENDED = ['ready', 'done', 'cancelled', 'failed'];
  const NEEDS_YOU = ['decide', 'look'];
  // 「等你」 order: a member's decision, the butler's question, confirmation cards, permission
  // requests, a question that does not block its turn, then things only left to look at.
  const RANK = { decide: 0, 'butler-question': 1, 'background-confirmation': 2, approval: 3, question: 4, look: 5 };
  const approvalPolicy = typeof module !== 'undefined' && module.exports ? require('./approval-policy.js') : root.nativeWorkspaceApproval;
  // The queue's own rules (app/queue-dispatch.cjs): the waiting items that ask nothing, and the
  // first-line markers of a decision.
  const UNHELD_WAITING = ['person-intervened', 'no-reply'];
  const DECISION_MARKERS = ['需要你决定：', '需要你决定:', 'Needs your decision:'];

  // Queue events carry the task text in this form (queue-dispatch.cjs shortText).
  function shortText(text, limit = 60) {
    const line = String(text ?? '').replace(/\s+/gu, ' ').trim();
    return line.length <= limit ? line : line.slice(0, limit - 1) + '…';
  }
  const firstLine = text => String(text ?? '').trim().split(/\r\n|[\n\r\u2028\u2029]/u)[0].replace(/\*\*/gu, '').trim();
  // Keep the person's full name, including continuation suffixes that distinguish sessions.
  const plainName = name => String(name ?? '').trim();
  // One line for a task: without the dispatch label, the requester's preface and lane notes, and cut
  // before the first full stop or quoted evidence. The full text stays in the row's detail.
  function taskTitle(text) {
    let line = firstLine(text);
    line = line.replace(/^【[^】]*】\s*/u, '').replace(/^（大管家[^）]*）\s*/u, '').replace(/（[^）]*lane\/[^）]*）/gu, '');
    const cut = line.search(/。|\s用户\s?\d|用户原话|\s实测/u);
    if (cut > 6) line = line.slice(0, cut);
    line = line.replace(/[：:，,\s]+$/u, '');
    return [...line].length > 90 ? [...line].slice(0, 89).join('') + '…' : line || shortText(text);
  }
  // The dispatcher's rule (queue-dispatch.cjs decisionLine): the reply's first line starts with a marker.
  // A stored item.reply is already one line (replyLine), so a caller cuts it as decisionLine does.
  function decisionQuestion(text) {
    const line = String(text ?? '').trimStart().split(/\r\n|[\n\r\u2028\u2029]/u)[0], marker = DECISION_MARKERS.find(value => line.startsWith(value));
    return marker ? line.slice(marker.length).replace(/\*\*/gu, '').trim() : '';
  }

  function taskStatus(item) {
    switch (item?.status) {
      case 'waiting': return UNHELD_WAITING.includes(item.reason) ? 'look' : 'decide';
      case 'sent': return 'active';
      case 'queued': return 'queued';
      case 'done': return item.ready?.commit ? 'ready' : 'done';
      case 'failed': return 'failed';
      default: return 'cancelled';
    }
  }

  // New events carry itemId. Old events remain readable: only an unambiguous
  // text match can associate one. Never guess which repeated task an event meant.
  function roomTasks(room, { nameOf = () => '' } = {}) {
    const queue = Array.isArray(room?.queue) ? room.queue : [], events = Array.isArray(room?.events) ? room.events : [];
    const byText = new Map();
    for (const item of queue) {
      const key = shortText(item.text);
      if (!byText.has(key)) byText.set(key, []);
      byText.get(key).push(item);
    }
    const history = new Map(queue.map(item => [item.id, []])), system = [];
    for (const event of events) {
      const key = event?.uiMessage?.key, text = event?.uiMessage?.params?.text;
      const candidates = typeof key === 'string' && key.startsWith('notice.queue.') && typeof text === 'string' ? byText.get(text) || [] : [];
      const time = Number.isFinite(event.time) ? event.time : Infinity;
      const eligible = candidates.filter(item => !(item.createdAt > time));
      const itemId = event.itemId || event.monitor?.itemId || event.butlerSource?.payload?.itemId;
      const owner = itemId ? queue.find(item => item.id === itemId) : eligible.length === 1 ? eligible[0] : null;
      if (owner) history.get(owner.id).push(event); else system.push(event);
    }
    const tasks = queue.map(item => {
      const own = history.get(item.id), status = taskStatus(item), ownerId = item.sentTo || item.assignee || '';
      const named = [...own].reverse().find(e => e.sessionId === ownerId && e.uiMessage?.params?.name)?.uiMessage.params.name;
      const time = Math.max(item.finishedAt || 0, item.sentAt || 0, item.createdAt || 0, ...own.map(e => Number.isFinite(e.time) ? e.time : 0));
      return {
        id: item.id, item, status, title: taskTitle(item.text), text: String(item.text ?? ''), time, history: own,
        ownerId, ownerName: plainName(nameOf(ownerId) || named || ''),
        creatorKind: item.addedBy === 'steward' ? 'steward' : item.creator?.kind || '', creatorName: plainName(item.creator?.name),
        question: status === 'decide' ? shortText(decisionQuestion(item.reply) || firstLine(item.reply)) : '',
        lookReason: status === 'look' ? item.reason : '',
        cancelledBySteward: own.some(e => e.uiMessage?.key === 'notice.queue.cancelledBySteward'),
      };
    });
    const counts = { all: tasks.length, mine: 0, active: 0, queued: 0, ended: 0 };
    for (const task of tasks) {
      if (NEEDS_YOU.includes(task.status)) counts.mine++;
      else if (task.status === 'active') counts.active++;
      else if (task.status === 'queued') counts.queued++;
      else counts.ended++;
    }
    return { tasks, system, counts };
  }

  // What was said in a space, oldest first: the person's, the butler's and the members' words to each other and
  // each member's last reply of a turn. NAW's own records (queue, delivery, timers, cards, tools, thinking,
  // automatic input) are left out. room: the space's record; sessions: its members' display sessions (a member's
  // replies and the words sent to it outside the space are read from its messages when shown).
  const WAKE_HEADER = /^\[Workspace message from [^\n]*\]\n/u;
  const PERSON_ORIGINS = ['human', 'human-mobile', 'room'];
  const said = m => typeof m?.text === 'string' && m.text.trim() !== '';
  const NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g;
  const onlyNotifications = text => Boolean(text.match(NOTIFICATION)) && !text.replace(NOTIFICATION, '').trim();
  function speechStream(room, { sessions = [] } = {}) {
    const items = [], byId = new Map(sessions.filter(Boolean).map(s => [s.id, s]));
    const nameOf = (id, fallback = '') => plainName(byId.get(id)?.name || fallback);
    const stamp = value => Number.isFinite(value) ? value : 0;
    const messages = Array.isArray(room?.messages) ? room.messages : [];
    // Session rows that the space already records: the person's words delivered from it and the agents' wakes.
    const delivered = new Set(), wakes = new Set();
    for (const m of messages) {
      if (m?.role === 'human') for (const d of m.deliveries || []) if (d?.id) delivered.add(d.id);
      if (m?.kind === 'agent-wake' && m.wake?.id) wakes.add(m.wake.id);
    }
    // A shown member's replies come from its own messages; the space's mirror is kept for what came before them.
    const shownSince = new Map();
    for (const s of byId.values()) {
      if (!Array.isArray(s.messages) || s.messagesOmitted) continue;
      shownSince.set(s.id, s.messages.length ? Math.min(...s.messages.map(m => stamp(m?.time) || Infinity)) : Infinity);
      let time = 0, last = null;
      const reply = () => {
        if (last) items.push({ id: `reply:${s.id}:${last.id}`, fromKind: 'agent', fromId: s.id, fromName: nameOf(s.id), to: [], text: last.text, time: stamp(last.time) || time,
          target: { sessionId: s.id, nativeId: s.nativeId || '', messageId: last.id } });
        last = null;
      };
      for (const m of s.messages) {
        if (!m) continue;
        time = stamp(m.time) || time;
        if (m.role === 'assistant') {
          if (!m.kind && !m.volatile && said(m) && m.status !== 'streaming' && m.phase !== 'commentary') last = m;
          continue;
        }
        if (m.role !== 'user') continue;
        reply();
        if (!said(m) || delivered.has(m.id) || m.backgroundOperation) continue;
        const to = [{ id: s.id, name: nameOf(s.id) }], target = { sessionId: s.id, nativeId: s.nativeId || '', messageId: m.id }, base = { id: `input:${s.id}:${m.id}`, to, text: m.text, time, target };
        if (m.origin === 'agent-wake' && m.wakeSource) {
          if (wakes.has(m.wakeSource.id)) continue;
          const id = m.wakeSource.senderId || '';
          items.push({ ...base, fromKind: 'agent', fromId: id, fromName: nameOf(id, String(m.name || '').replace(/^来自\s*/u, '')), text: m.text.replace(WAKE_HEADER, '') });
        } else if (m.origin === 'room' && typeof m.name === 'string' && m.name.trim()) {
          // Through a space with a sender's name: another agent's words (workspace.cjs sendScopedOutboxInput keeps only
          // its name); the person's own space sends carry none. A name proves nothing, so it stays unverified.
          const name = plainName(m.name), match = [...byId.values()].filter(x => x.id !== s.id && plainName(x.name) === name);
          items.push({ ...base, fromKind: 'agent', unverified: true, ...(match.length === 1 ? { fromId: match[0].id, fromName: name } : { fromId: '', fromName: `「${name}」` }) });
        } else if (PERSON_ORIGINS.includes(m.origin) || m.origin === 'native' && (m.inputSource === 'user' || m.inputSource === undefined && !onlyNotifications(m.text))) {
          // With no source, NAW's own display (workspace.cjs nativeInputOrigin) counts typed text, not a turn of notifications.
          items.push({ ...base, fromKind: 'person', fromId: '', fromName: '' });
        } else if (m.origin === 'naw-dispatch' && m.dispatchPurpose?.kind === 'queue' && !String(m.dispatchItem || '').startsWith('steward-wake:')) {
          items.push({ ...base, fromKind: 'dispatch', fromId: '', fromName: '' });
        } else if (m.origin === 'agent-control' && m.agentControl?.id) {
          items.push({ ...base, fromKind: 'agent', fromId: m.agentControl.id, fromName: nameOf(m.agentControl.id, m.agentControl.name) });
        }
      }
      // A turn that is still going has not given its reply yet.
      if (!['working', 'approval'].includes(s.state)) reply(); else last = null;
    }
    for (const m of messages) {
      if (!m || m.backgroundOperation) continue;
      const target = originalTarget(m), time = stamp(m.time);
      if (m.role === 'human' && !m.kind && said(m)) {
        const to = (m.deliveries?.length ? m.deliveries.map(d => ({ id: d.recipientId || '', name: nameOf(d.recipientId, d.recipientName) }))
          : m.recipientId ? [{ id: m.recipientId, name: nameOf(m.recipientId) }] : []);
        items.push({ id: `room:${m.id}`, fromKind: 'person', fromId: '', fromName: '', to, text: m.text, time, target });
      } else if (m.kind === 'agent-wake' && m.wake) {
        const w = m.wake;
        items.push({ id: `room:${m.id}`, fromKind: 'agent', fromId: w.senderId || '', fromName: nameOf(w.senderId, w.senderName),
          to: [{ id: w.recipientId || '', name: nameOf(w.recipientId, w.recipientName) }], text: String(w.body ?? ''), time, target });
      } else if (m.kind === 'agent-peer' && m.peerMessage) {
        const p = m.peerMessage, body = m.uiMessage?.params?.body ?? String(m.text || '').split('\n').slice(1).join('\n');
        items.push({ id: `room:${m.id}`, fromKind: 'agent', fromId: p.senderId || '', fromName: p.senderId ? nameOf(p.senderId, p.senderName) : p.senderName ? `「${p.senderName}」` : '',
          to: [{ id: p.recipientId || '', name: nameOf(p.recipientId, p.recipientName) }], text: body, time, target, unverified: true });
      } else if (m.role === 'assistant' && !m.kind && typeof m.sessionId === 'string' && said(m) && (m.finalReply || !m.sharedStream && m.status !== 'streaming')) {
        if (time >= (shownSince.get(m.sessionId) ?? Infinity)) continue;
        items.push({ id: `room:${m.id}`, fromKind: 'agent', fromId: m.sessionId, fromName: nameOf(m.sessionId, m.name), to: [], text: m.text, time, target });
      }
    }
    const seen = new Set();
    return items.filter(i => !seen.has(i.id) && seen.add(i.id)).map((item, order) => ({ item, order }))
      .sort((a, b) => a.item.time - b.item.time || a.order - b.order).map(({ item }) => item);
  }
  // A stream item that a named participant said or that was sent to it.
  const speechInvolves = (item, id) => Boolean(id) && (item.fromId === id || item.to.some(t => t.id === id));

  // A permission request or a native question keeps the member's turn until the person answers.
  const needsApproval = s => Boolean(s && (s.nativeApproval?.requests?.length || s.approvals?.length || s.approval || s.approvalOverflow || s.state === 'approval' || s.claudeQuestion));
  const requests = s => Array.isArray(s?.approvals) ? s.approvals : s?.approval ? [s.approval] : [];
  // A Codex question with isBlocking false is listed on its own with its text, until it is answered (pending) or
  // native drops it. The rest of the session's requests keep the one approval row. Native may still report its turn
  // as waiting on that question (Codex 0.168, Default mode: waitingOnUserInput); that state alone adds no second row.
  const openQuestions = s => requests(s).filter(r => !r.pending && approvalPolicy.nonBlockingQuestion(r));
  const holdsTurn = s => {
    if (!s) return false;
    const native = s.nativeApproval?.requests || [], known = [...native, ...requests(s), ...(s.claudeQuestion ? [s.claudeQuestion] : [])];
    // A stale approval state cannot turn an already submitted request into a new ask.
    return Boolean(native.some(r => !r.pending) || requests(s).some(r => !r.pending && !approvalPolicy.nonBlockingQuestion(r)) ||
      s.claudeQuestion && !s.claudeQuestion.pending || s.approvalOverflow || s.state === 'approval' && !known.length);
  };

  // The butler's newest reply asks for a decision and nothing came after it.
  function butlerQuestion(session) {
    if (!session) return null;
    const messages = Array.isArray(session.messages) && !session.messagesOmitted ? session.messages : null;
    const last = messages ? messages.findLast(m => m?.role === 'assistant' && typeof m.text === 'string' && m.text.trim()) : session.messageSummary?.lastAssistant;
    const question = last && decisionQuestion(last.text);
    if (!question) return null;
    // Anything recorded after it (the person's answer, a new turn) means the conversation moved on. The same rule as
    // messageSummary's latestAt (shown-sessions.cjs), so a shown and an omitted butler read alike.
    const later = messages ? messages.some(m => m && m !== last && !m.volatile && m.kind !== 'gap' && Number.isFinite(m.time) && m.time > last.time)
      : Number.isFinite(session.messageSummary?.latestAt) && Number.isFinite(last.time) && session.messageSummary.latestAt > last.time;
    return later ? null : { messageId: typeof last.id === 'string' ? last.id : '', title: question, time: Number.isFinite(last.time) ? last.time : 0 };
  }

  // Everything that waits for the person, across the spaces, in the order the strip shows it.
  // rooms: the spaces' records; sessions: display sessions; confirmations: main's pending cards;
  // butlerId: the designated butler's session; roomOf(sessionId): the space a member is in, or ''.
  function waitingItems({ rooms = [], sessions = [], confirmations = [], butlerId = '', roomOf = () => '', nameOf = () => '', now = Date.now() } = {}) {
    const live = new Map(sessions.filter(s => s && !s.archived).map(s => [s.id, s]));
    const list = [];
    for (const room of rooms) {
      if (!room || room.archived) continue;
      for (const task of roomTasks(room, { nameOf }).tasks) {
        if (!NEEDS_YOU.includes(task.status)) continue;
        list.push({ id: `queue:${room.id}:${task.id}`, kind: task.status, title: task.question || task.title, lookReason: task.lookReason,
          actorId: task.ownerId, actorName: task.ownerName, roomId: room.id, itemId: task.id, time: task.time });
      }
    }
    const butler = live.get(butlerId), question = butlerQuestion(butler);
    if (question) list.push({ id: `butler:${butler.id}:${question.messageId}`, kind: 'butler-question', title: question.title, actorId: butler.id, actorName: plainName(butler.name),
      sessionId: butler.id, messageId: question.messageId, roomId: roomOf(butler.id), time: question.time });
    for (const s of live.values()) {
      for (const r of openQuestions(s)) list.push({ id: `question:${s.id}:${r.requestId}`, kind: 'question', title: shortText(r.params.questions[0].question),
        actorId: s.id, actorName: plainName(s.name), sessionId: s.id, requestId: r.requestId, roomId: roomOf(s.id), time: Number.isFinite(r.receivedAt) ? r.receivedAt : now });
      if (!holdsTurn(s)) continue;
      list.push({ id: `approval:${s.id}`, kind: 'approval', title: '', actorId: s.id, actorName: plainName(s.name), sessionId: s.id, roomId: roomOf(s.id),
        time: Number.isFinite(s.nativeApproval?.observedAt) ? s.nativeApproval.observedAt : now });
    }
    for (const card of Array.isArray(confirmations) ? confirmations : []) {
      if (!card || card.actionable !== true || card.replacedBy || !live.has(card.sessionId) || live.get(card.sessionId).nativeId !== card.nativeId) continue;
      // The card's message starts with the asker's name, which the row already shows beside it.
      const title = String(card.title || ''), actor = String(card.actorName || '');
      list.push({ id: card.key || card.id, kind: 'background-confirmation', title: actor && title.startsWith(actor + ' ') ? title.slice(actor.length + 1) : title,
        actorId: card.sessionId, actorName: plainName(actor), sessionId: card.sessionId, roomId: roomOf(card.sessionId), card, time: Number.isFinite(card.time) ? card.time : now });
    }
    return list.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.time - a.time);
  }

  function records(room) {
    const time = row => Number.isFinite(row.time) && Math.abs(row.time) <= 8640000000000000 ? row.time : -Infinity;
    return [...(room?.messages || []), ...(room?.events || [])].sort((a, b) => time(b) - time(a));
  }
  function originalTarget(row, item) {
    if (row.controlAudit?.actor?.id) {
      const { actor, operationId } = row.controlAudit;
      return { sessionId: actor.id, nativeId: actor.nativeId || '', messageId: actor.nativeId && operationId ? `background:${actor.nativeId}:${operationId}` : '' };
    }
    if (row.wake?.senderId) return { sessionId: row.wake.senderId, nativeId: row.wake.nativeId || '', messageId: row.wake.id || '' };
    if (row.agentControl?.id) return { sessionId: row.agentControl.id, nativeId: row.agentControl.nativeId || '', messageId: '' };
    if (row.peerMessage) return row.peerMessage.senderId ? { sessionId: row.peerMessage.senderId, nativeId: '', messageId: '' } : null;
    const added = ['notice.queue.addedBySecretary', 'notice.queue.addedBySteward', 'notice.queue.withdrawn'].includes(row.uiMessage?.key);
    const sessionId = added ? row.uiMessage?.params?.sessionId || item?.creator?.sessionId : row.role === 'human' ? row.recipientId : row.sessionId;
    if (!sessionId) return null;
    return { sessionId, nativeId: row.nativeId || '', messageId: row.sharedStream ? row.nativeMessageId || '' :
      row.role === 'human' ? row.deliveries?.find(d => d.recipientId === sessionId)?.id || row.id || '' : '' };
  }
  const api = { ENDED, NEEDS_YOU, RANK, UNHELD_WAITING, DECISION_MARKERS, shortText, firstLine, plainName, taskTitle, decisionQuestion, taskStatus, roomTasks, speechStream, speechInvolves, needsApproval, openQuestions, butlerQuestion, waitingItems, records, originalTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.nativeWorkspaceTaskStream = api;
})(globalThis);
