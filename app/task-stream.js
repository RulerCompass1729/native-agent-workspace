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

  // The conversation in the space, without NAW's own records: what the person sent (role human, to a
  // recipient) and what members said back (role assistant). Newest last.
  function speech(room, limit = 20) {
    const messages = Array.isArray(room?.messages) ? room.messages : [];
    return messages.filter(m => m && !m.kind && typeof m.text === 'string' && m.text.trim() && (m.role === 'human' || m.role === 'assistant' && typeof m.sessionId === 'string'))
      .map(m => ({ id: m.id, from: m.role === 'human' ? 'person' : 'member', sessionId: m.role === 'human' ? '' : m.sessionId, recipientId: typeof m.recipientId === 'string' ? m.recipientId : '',
        text: m.text, time: Number.isFinite(m.time) ? m.time : 0 }))
      .sort((a, b) => a.time - b.time).slice(-limit);
  }

  // A permission request or a native question keeps the member's turn until the person answers.
  const needsApproval = s => Boolean(s && (s.nativeApproval?.requests?.length || s.approvals?.length || s.approval || s.approvalOverflow || s.state === 'approval' || s.claudeQuestion));
  const requests = s => Array.isArray(s?.approvals) ? s.approvals : s?.approval ? [s.approval] : [];
  // A Codex question with isBlocking false is listed on its own with its text, until it is answered (pending) or
  // native drops it. The rest of the session's requests keep the one approval row. Native may still report its turn
  // as waiting on that question (Codex 0.168, Default mode: waitingOnUserInput); that state alone adds no second row.
  const openQuestions = s => requests(s).filter(r => !r.pending && approvalPolicy.nonBlockingQuestion(r));
  const onlyQuestions = s => requests(s).length > 0 && requests(s).every(r => approvalPolicy.nonBlockingQuestion(r));
  const holdsTurn = s => Boolean(s && (s.nativeApproval?.requests?.length || requests(s).some(r => !approvalPolicy.nonBlockingQuestion(r)) ||
    s.approvalOverflow || s.state === 'approval' && !onlyQuestions(s) || s.claudeQuestion));

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
      if (!card || card.replacedBy || !live.has(card.sessionId) || live.get(card.sessionId).nativeId !== card.nativeId) continue;
      // The card's message starts with the asker's name, which the row already shows beside it.
      const title = String(card.title || ''), actor = String(card.actorName || '');
      list.push({ id: card.id, kind: 'background-confirmation', title: actor && title.startsWith(actor + ' ') ? title.slice(actor.length + 1) : title,
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
  const api = { ENDED, NEEDS_YOU, RANK, UNHELD_WAITING, DECISION_MARKERS, shortText, firstLine, plainName, taskTitle, decisionQuestion, taskStatus, roomTasks, speech, needsApproval, openQuestions, butlerQuestion, waitingItems, records, originalTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.nativeWorkspaceTaskStream = api;
})(globalThis);
