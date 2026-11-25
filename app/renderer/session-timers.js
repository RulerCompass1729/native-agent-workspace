// The open conversation's timers beside its input box: confirmations counting down and confirmed operations
// still running. Built from the confirmation list the page already holds; it asks main for nothing.
(function (root) {
  const HOLD_MS = 5000, ORDER = { countdown: 0, expired: 1, running: 2 };
  // `place(card)` names the message a card is drawn on (a merged batch: its one card) and a title; null skips it.
  // `held` is the previous result: a countdown that reached zero says so for HOLD_MS even after its card is gone.
  function collect({ sessionId, cards = [], place, held = [], now }) {
    const live = new Map();
    const put = item => {
      const old = live.get(item.target);
      if (!old || ORDER[item.kind] < ORDER[old.kind] || old.kind === item.kind && item.at < old.at) live.set(item.target, item);
    };
    for (const card of cards) {
      const op = card?.message?.backgroundOperation;
      if (!op || card.sessionId !== sessionId) continue;
      const running = op.state === 'running' && Number.isSafeInteger(op.startedAt);
      const waiting = card.state === 'confirmation-required' && op.state === 'confirmation-required' && !op.answer && !op.disposition &&
        !op.replacedBy && !card.replacedBy && Number.isSafeInteger(card.expiresAt) && now < card.expiresAt + HOLD_MS;
      if (!running && !waiting) continue;
      const where = place(card);
      if (!where) continue;
      if (running) put({ target: where.id, title: where.title, kind: 'running', at: op.startedAt });
      else put({ target: where.id, title: where.title, kind: now < card.expiresAt ? 'countdown' : 'expired', at: card.expiresAt });
    }
    for (const item of held) {
      if (item.kind !== 'running' && item.at <= now && now < item.at + HOLD_MS && !live.has(item.target)) live.set(item.target, { ...item, kind: 'expired' });
    }
    return [...live.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.at - b.at);
  }
  // Display keys and parameters only. A countdown says where it leads, unlike the cards' own badge.
  function label(item, now) {
    if (item.kind === 'countdown') {
      const left = Math.max(0, Math.ceil((item.at - now) / 1000)), minutes = Math.floor(left / 60), seconds = left % 60;
      return { text: [['background.timer.countdown', { time: `${minutes}:${String(seconds).padStart(2, '0')}` }]], name: minutes ? ['background.timer.countdownName', { minutes, seconds }] : ['background.timer.countdownSecondsName', { seconds }] };
    }
    if (item.kind === 'expired') return { text: [['background.card.elapsed']], name: ['background.timer.expiredName'] };
    const seconds = Math.max(0, Math.floor((now - item.at) / 1000));
    return { text: [['background.card.executing'], ['background.card.executionElapsed', { seconds }]], name: ['background.timer.runningName', { seconds }] };
  }
  // Same targets and kinds in the same order: the tick rewrites text only.
  const shape = items => JSON.stringify(items.map(item => [item.target, item.kind]));
  root.nativeWorkspaceSessionTimers = { HOLD_MS, collect, label, shape };
})(globalThis);
