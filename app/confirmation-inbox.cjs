// One count and safe summary contract. No command arguments, terminal/native
// approval content, private guards or cleanup tickets enter the phone summary.
const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const locale = require('./ui-locale.js');
function confirmationSummary(card) {
  const out = { canDecide: false };
  for (const key of ['id', 'key', 'operationId', 'sessionId', 'nativeId', 'actorName', 'targetName', 'state', 'disposition', 'reason']) out[key] = text(card[key]);
  for (const key of ['time', 'expiresAt', 'finishedAt']) out[key] = Number.isSafeInteger(card[key]) ? card[key] : null;
  out.actionable = card.actionable === true; out.afterStart = card.afterStart === true;
  const summary = card.summary || {}; out.summary = {};
  for (const key of ['action', 'method', 'target', 'name', 'room']) if (typeof summary[key] === 'string') out.summary[key] = text(summary[key]);
  // Rebuild the heading from NAW's action catalog, never from a native prompt.
  out.titles = Object.fromEntries(['zh', 'en'].map(lang => {
    let title; try { if (summary.action) title = locale.format(lang, 'background.action.' + summary.action); } catch { /* Older/future catalog: keep a safe heading. */ }
    return [lang, title || locale.format(lang, 'records.confirmations.title')];
  }));
  out.title = out.titles.en;
  out.detail = [out.summary.target, out.summary.room, out.summary.name].filter(Boolean).join(' · ');
  return out;
}
// Kept with the card object: a settled card is the same object from one state to the next (background-control.cjs).
const texts = new WeakMap();
function summaryText(card) {
  let text = texts.get(card);
  if (text === undefined) texts.set(card, text = JSON.stringify(confirmationSummary(card)));
  return text;
}
function inboxStatus(records, temp, confirmations) {
  const confirmationCount = confirmations.filter(card => card.actionable === true).length;
  return { ...records, temp, confirmations, confirmationCount, count: records.count + (temp?.shown ? 1 : 0) + confirmationCount };
}
module.exports = { confirmationSummary, summaryText, inboxStatus };
