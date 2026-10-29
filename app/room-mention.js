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
  function atomicRange(binding, draft, edit) {
    if (!valid(binding, draft) || !edit || /history|Composition|^delete.*Line/u.test(edit.type || '')) return null;
    let { start, end } = edit;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > draft.length) return null;
    const atomEnd = binding.end + (draft[binding.end] === ' ' ? 1 : 0), type = edit.type || '';
    if (start === end && type === 'deleteWordBackward' && start >= atomEnd && /^\s*$/u.test(draft.slice(atomEnd, start))) start = binding.start;
    if (start === end && type === 'deleteWordForward' && end <= binding.start && /^\s*$/u.test(draft.slice(end, binding.start))) end = atomEnd;
    if (start === end) {
      if (/^delete.*Backward$/u.test(type)) start--;
      else if (/^delete.*Forward$/u.test(type)) end++;
      else if (!(start > binding.start && start < atomEnd)) return null;
    }
    if (start >= atomEnd || end <= binding.start) return null;
    return { start: Math.max(0, Math.min(start, binding.start)), end: Math.min(draft.length, Math.max(end, atomEnd)) };
  }
  function caretPosition(binding, draft, point, direction = 0) {
    if (!valid(binding, draft)) return point;
    const start = binding.start, end = binding.end + (draft[binding.end] === ' ' ? 1 : 0);
    if (direction > 0 && point >= start && point < end) return end;
    if (direction < 0 && point > start && point <= end) return start;
    if (!direction && point > start && point < end) return point - start < end - point ? start : end;
    return point;
  }
  // Metadata for observed edits only: Chromium owns text and undo grouping.
  // Equal text at different occurrences may have different (or no) authority.
  function editHistory(limit = 64) {
    let entries = [], cursor = -1;
    const copy = binding => binding ? { ...binding } : null;
    const key = binding => binding ? JSON.stringify([binding.id, binding.start, binding.end, binding.text, binding.active, binding.memberRevision]) : 'null';
    const state = (text, binding) => ({ text, binding: valid(binding, text) ? copy(binding) : null });
    function reset(text, binding) { entries = [{ ...state(text, binding), anchor: true }]; cursor = 0; }
    function sync(text, binding) {
      const next = state(text, binding), current = entries[cursor];
      if (!current || current.text !== next.text || key(current.binding) !== key(next.binding)) reset(text, binding);
    }
    return {
      sync,
      record(before, prior, after, binding) {
        sync(before, prior); entries.splice(cursor + 1);
        const next = state(after, binding); next.anchor = key(next.binding) !== key(entries[cursor].binding); entries.push(next);
        // Keep selection/revocation boundaries before pruning repeated body keys.
        while (entries.length > limit) {
          const index = entries.findIndex((row, i) => i > 0 && i < entries.length - 1 && !row.anchor);
          entries.splice(index < 0 ? 0 : index, 1);
        }
        cursor = entries.length - 1;
      },
      travel(type, before, prior, after, trusted) {
        sync(before, prior);
        const undo = type === 'historyUndo', redo = type === 'historyRedo';
        const candidates = entries.map((row, index) => ({ row, index })).filter(({ row, index }) => row.text === after && (undo ? index < cursor : redo && index > cursor));
        const match = undo ? candidates.at(-1) : candidates[0];
        if (trusted !== true || !match) { reset(after, null); return null; }
        // A direct edge is the actual last edit, even if older text repeats.
        // Coalesced text edits may skip states only inside one authority span.
        const crossed = entries.slice(Math.min(cursor, match.index), Math.max(cursor, match.index) + 1);
        if (Math.abs(cursor - match.index) !== 1 && crossed.some(row => key(row.binding) !== key(match.row.binding))) { reset(after, null); return null; }
        cursor = match.index; return copy(match.row.binding);
      },
    };
  }
  const api = { valid, validView, edited, body, atomicRange, caretPosition, editHistory };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nativeWorkspaceMentions = api;
})(typeof globalThis === 'object' ? globalThis : this);
