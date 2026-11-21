// Waiting cards that one "Confirm all" may answer together: the same agent, the same reversible method with no risk
// mark, each actionable on its own. Creation may carry its permission risk: it is part of the shared configuration
// shown once, and every card is still checked and receipted one by one in the main process.
(function (root) {
  const METHODS = new Set(['archiveSession', 'create']);
  function batchable(card) {
    const op = card?.message?.backgroundOperation, summary = card?.summary;
    const riskless = Array.isArray(summary?.risks) && (summary.risks.length === 0 || summary.method === 'create');
    return Boolean(card && op && card.state === 'confirmation-required' && card.actionable === true && !card.replacedBy && !op.replacedBy &&
      !op.repeated && !op.answer && !op.disposition && op.confirmation?.kind === 'message' && METHODS.has(summary?.method) &&
      riskless && (summary.method !== 'create' || typeof summary.createKey === 'string' && summary.createKey));
  }
  // `started`: batches the person already answered, by the card keys they covered, kept together until they are gone.
  function plan(cards, started = []) {
    const list = Array.isArray(cards) ? cards : [], byKey = new Map(list.map(card => [card.key, card])), used = new Set(), out = [];
    for (const batch of started) {
      const members = batch.keys.map(key => byKey.get(key)).filter(Boolean);
      if (!members.length) continue;
      for (const card of members) used.add(card.key);
      out.push({ key: batch.key, cards: members, started: true, submitting: Boolean(batch.submitting) });
    }
    const groups = new Map();
    for (const card of list) {
      if (used.has(card.key) || !batchable(card)) continue;
      const key = card.summary.method === 'create'
        ? [card.sessionId, card.nativeId, 'create', card.summary.createKey].join('\n')
        : [card.sessionId, card.nativeId, card.summary.method].join('\n');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      members.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
      out.push({ key, cards: members, started: false });
    }
    return out;
  }
  // The batch is drawn once, on its newest card still waiting; cards run oldest first, so that card holds it to the end.
  function find(batches, key) {
    const batch = batches.find(item => item.cards.some(card => card.key === key));
    if (!batch) return null;
    const waiting = batch.cards.filter(card => card.state === 'confirmation-required'), holder = (waiting.length ? waiting : batch.cards).at(-1);
    return { batch, anchor: holder.key === key };
  }
  function itemState(card) {
    const op = card.message?.backgroundOperation || {};
    if (op.state === 'unconfirmed') return 'unconfirmed';
    if (op.answer === 'queued') return 'queued';
    if (op.answer === 'running' || op.state === 'running' || op.state === 'awaiting-native') return 'running';
    if (op.state === 'confirmation-required' && !op.disposition) return 'waiting';
    if (op.state === 'complete' || op.state === 'received') return 'done';
    if (op.state === 'cancelled' && !op.disposition) return 'cancelled';
    return op.disposition || op.replacedBy || card.replacedBy || ['not-executed', 'expired'].includes(op.state) ? 'void' : 'unconfirmed';
  }
  root.nativeWorkspaceConfirmationBatch = { METHODS, batchable, plan, find, itemState };
})(globalThis);
