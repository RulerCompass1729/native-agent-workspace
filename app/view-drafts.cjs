const { uiError } = require('./ui-errors.cjs');
// Window copies are recovery data, never instructions to overwrite a session.
function backups(view) {
  if (!view.draftBackups || typeof view.draftBackups !== 'object' || Array.isArray(view.draftBackups)) view.draftBackups = {};
  const old = view.draft;
  if (typeof old?.id === 'string' && typeof old.text === 'string' && !Object.hasOwn(view.draftBackups, old.id)) {
    Object.defineProperty(view.draftBackups, old.id, { value: { text: old.text, acknowledged: false }, enumerable: true, writable: true, configurable: true });
  }
  return view.draftBackups;
}
function beginDraft(view, id, text) {
  const records = backups(view), entry = { text, acknowledged: false, recoveries: records[id]?.recoveries || [] };
  Object.defineProperty(records, id, { value: entry, enumerable: true, writable: true, configurable: true });
  view.draft = { id, text };
  return entry;
}
function acknowledgeDraft(view, id, entry) {
  if (backups(view)[id] !== entry) return false;
  entry.acknowledged = true;
  return true;
}
function acceptSentDraft(view, id, entry, text) {
  if (!entry || backups(view)[id] !== entry || entry.text.trim() !== text.trim()) return false;
  entry.text = ''; entry.acknowledged = true;
  if (view.draft?.id === id) view.draft = { id, text: '' };
  return true;
}
function forgetDraft(view, id) {
  delete backups(view)[id];
  if (view.draft?.id === id) delete view.draft;
}
function retainRecovery(view, id, text) {
  const entry = backups(view)[id];
  if (!entry || typeof text !== 'string' || !text || text.length > 16000) throw uiError("error.drafts.invalidRecoveryCopy");
  if (!Array.isArray(entry.recoveries)) entry.recoveries = [];
  if (entry.discarded && entry.text === text) return entry.recoveries;
  if (!entry.recoveries.includes(text)) entry.recoveries.push(text);
  return entry.recoveries;
}
function discardRecovery(view, id, text) {
  const entry = backups(view)[id];
  if (!entry) return [];
  entry.recoveries = (entry.recoveries || []).filter(value => value !== text);
  if (entry.text === text) entry.discarded = true;
  return entry.recoveries;
}
// Words NAW kept during a handoff and could not send (queue-dispatch.cjs returnHeld), back as a copy of this session's draft.
function returnCopy(view, id, text) {
  const records = backups(view);
  if (!Object.hasOwn(records, id)) Object.defineProperty(records, id, { value: { text: '', acknowledged: true, recoveries: [] }, enumerable: true, writable: true, configurable: true });
  return retainRecovery(view, id, text);
}
// The open window they were sent from, else any open window of the person's: a closed window's owner never returns
// (main.cjs gives a new window a new one). Agents' views are not passed in.
function returnWindow(contexts, owner) {
  return contexts.find(context => context.view?.owner === owner) || contexts[0] || null;
}
module.exports = { backups, beginDraft, acknowledgeDraft, acceptSentDraft, forgetDraft, retainRecovery, discardRecovery, returnCopy, returnWindow };
