// Explicit reply edges only. Reading a discussion never supplies model context.
(function (root) {
  function replyReference(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw Error('无效的回复关联。');
    return value;
  }
  function threadIndex(messages) {
    const rows = new Map(messages.map(m => [m.id, m])), roots = new Map(), groups = new Map();
    for (const message of messages) {
      let row = message;
      const seen = new Set();
      while (row.replyTo && rows.has(row.replyTo) && !seen.has(row.id)) {
        seen.add(row.id); row = rows.get(row.replyTo);
      }
      // Corrupt cycles must not merge unrelated discussion trees. Missing
      // parents remain separate visible roots rather than disappearing.
      const id = seen.has(row.id) ? message.id : row.id;
      roots.set(message.id, id);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(message);
    }
    return { rows, roots, groups };
  }
  const api = { replyReference, threadIndex };
  if (typeof module !== 'undefined') module.exports = api;
  else root.nativeWorkspaceThreads = api;
})(globalThis);
