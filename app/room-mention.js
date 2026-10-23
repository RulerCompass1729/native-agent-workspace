// A selected inline mention carries an explicit session identity. Ordinary
// typed/pasted @text never acquires routing authority by matching a name.
(function (root) {
  function valid(binding, draft) {
    return Boolean(binding && typeof binding === 'object' && typeof draft === 'string' &&
      typeof binding.id === 'string' && binding.id.length > 0 && binding.id.length <= 100 &&
      typeof binding.text === 'string' && binding.text.startsWith('@') && binding.text.length <= 240 &&
      Number.isSafeInteger(binding.start) && binding.start >= 0 && Number.isSafeInteger(binding.end) &&
      binding.end === binding.start + binding.text.length && draft.slice(binding.start, binding.end) === binding.text &&
      (!binding.start || /\s/u.test(draft[binding.start - 1])) &&
      (binding.end === draft.length || /\s/u.test(draft[binding.end])));
  }
  function edited(binding, before, after, edit) {
    if (!valid(binding, before) || !edit || /historyUndo|historyRedo/u.test(edit.type || '')) return null;
    let { start, end } = edit;
    const removed = before.length - after.length;
    if (start === end && removed > 0 && /Backward$/u.test(edit.type || '')) start -= removed;
    else if (start === end && removed > 0 && /Forward$/u.test(edit.type || '')) end += removed;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > before.length) return null;
    // Validate the actual replacement, rather than guessing which identical
    // occurrence changed from a longest-common-prefix diff.
    if (!after.startsWith(before.slice(0, start)) || !after.endsWith(before.slice(end))) return null;
    if (start < binding.end && end > binding.start || start === end && start > binding.start && start < binding.end) return null;
    const shift = end <= binding.start ? after.length - before.length : 0;
    const next = { ...binding, start: binding.start + shift, end: binding.end + shift };
    return valid(next, after) ? next : null;
  }
  function body(binding, draft) { return valid(binding, draft) ? draft.slice(0, binding.start) + draft.slice(binding.end).replace(/^ /u, '') : ''; }
  function validView(binding, draft, recipient) {
    return binding === null || valid(binding, draft) && typeof binding.active === 'boolean' && Number.isSafeInteger(binding.memberRevision) && binding.memberRevision >= 0 && (binding.active ? binding.id === recipient : recipient === '');
  }
  const api = { valid, validView, edited, body };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceMentions = api;
})(typeof globalThis === 'object' ? globalThis : this);
