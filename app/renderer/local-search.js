// Search only the application's already-loaded records. No native calls,
// filesystem scan, durable index, draft inspection or query persistence.
(function (target) {
  function searchRecords(state, query, { scope = 'all', sessionId = '', archived = false, limit = 60 } = {}) {
    query = String(query || '').trim().toLocaleLowerCase();
    limit = Math.max(1, Math.min(600, Math.floor(limit) || 60));
    const results = []; let total = 0;
    const add = value => { total++; if (results.length < limit) results.push(value); };
    const matches = text => String(text || '').toLocaleLowerCase().includes(query);
    const snippet = text => {
      text = String(text || '');
      const start = Math.max(0, text.toLocaleLowerCase().indexOf(query) - 45);
      return (start ? '…' : '') + text.slice(start, start + 220).replace(/\s+/g, ' ') + (text.length > start + 220 ? '…' : '');
    };
    if (scope === 'all' || scope === 'current') for (const s of state.sessions || []) {
      if (scope === 'current' ? s.id !== sessionId : s.archived && !archived) continue;
      const base = { sessionId: s.id, name: s.name, provider: s.provider, archived: Boolean(s.archived) };
      if (!query || matches(s.name)) add({ ...base, kind: 'session', key: `session:${s.id}`, text: s.name });
      if (query) for (const m of s.messages || []) if (matches(m.text)) add({
        ...base, kind: 'message', key: `message:${s.id}:${m.id}`, messageId: m.id,
        role: m.role, text: snippet(m.text),
      });
    }
    const room = state.room;
    if (room && (scope === 'room' || scope === 'all') && (!room.archived || archived || scope === 'room')) {
      const base = { name: room.name || '共同工作', archived: Boolean(room.archived) };
      if (!query || matches(room.name)) add({ ...base, kind: 'room', key: 'room', text: room.name || '共同工作' });
      if (query) for (const m of [...(room.messages || []), ...(room.events || [])]) if (matches(m.text)) add({
        ...base, kind: 'shared', key: `shared:${m.id}`, messageId: m.id, role: m.role, text: snippet(m.text),
      });
    }
    return { results, total };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { searchRecords };
  else target.nativeWorkspaceSearch = { searchRecords };
})(typeof window === 'undefined' ? globalThis : window);
