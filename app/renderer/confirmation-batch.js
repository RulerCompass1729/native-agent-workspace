// Waiting cards that one "Confirm all" may answer together: the same agent, the same reversible method with no risk
// mark, each actionable on its own. Creation may carry its permission risk: it is part of the shared configuration
// shown once, and every card is still checked and receipted one by one in the main process. Input joins a batch only
// with its complete text, which each row opens to. Stopping sessions may carry its own mark, shown once (on the phone, the
// question's own text); ending a session and disconnecting Codex, or two different answers, are never one card.
(function (root) {
  const METHODS = new Set(['archiveSession', 'create', 'resume', 'restoreSession', 'input', 'stop']);
  const STOPS = new Set(['endSession', 'disconnectCodex']);
  function riskless(summary) {
    if (!Array.isArray(summary?.risks)) return false;
    if (summary.method === 'stop') return STOPS.has(summary.action) && summary.risks.every(risk => risk === 'stopsWork');
    return summary.risks.length === 0 || summary.method === 'create';
  }
  function groupKey(card) {
    const { method, createKey, action } = card.summary, key = [card.sessionId, card.nativeId, method];
    if (method === 'create') key.push(createKey);
    if (method === 'stop') key.push(action, ...card.message.backgroundOperation.confirmation.options.buttons);
    return key.join('\n');
  }
  function batchable(card) {
    const op = card?.message?.backgroundOperation, summary = card?.summary;
    return Boolean(card && op && card.state === 'confirmation-required' && card.actionable === true && !card.replacedBy && !op.replacedBy &&
      !op.repeated && !op.answer && !op.disposition && op.confirmation?.kind === 'message' && METHODS.has(summary?.method) &&
      riskless(summary) && (summary.method !== 'create' || typeof summary.createKey === 'string' && summary.createKey) &&
      (summary.method !== 'stop' || Array.isArray(op.confirmation.options?.buttons)) &&
      (summary.method !== 'input' || typeof op.confirmation.options?.detail === 'string' && op.confirmation.options.detail !== ''));
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
      const key = groupKey(card);
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
  // Started batches retain their first card after it settles, so the group stays in place.
  function holder(batch) {
    return batch.cards[0];
  }
  function find(batches, key) {
    const batch = batches.find(item => item.cards.some(card => card.key === key));
    if (!batch) return null;
    return { batch, anchor: holder(batch).key === key };
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
  const api = { METHODS, batchable, plan, find, holder, itemState };
  root.nativeWorkspaceConfirmationBatch = api;
  // The phone service groups with this same rule (mobile-workspace.cjs).
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
