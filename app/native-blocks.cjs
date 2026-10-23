// Native display records are private session history. They never authorize a
// send, a shared reply, or completion of background work.
function applyNativeBlock(session, event) {
  if (!event || typeof event.id !== 'string' || !event.id || event.nativeId !== session.nativeId) return false;
  const id = `native:${event.nativeId}:${event.id}`;
  let row = session.messages.find(m => m.id === id);
  if (row?.turnId && event.turnId && row.turnId !== event.turnId) { row.incomplete = true; return true; }
  const boundary = event.turnId && session.messages.find(m => m.nativeId === event.nativeId && m.kind === 'turn' && m.turnId === event.turnId);
  if (!row) {
    row = { id, role: event.kind === 'input' ? 'user' : ['response', 'summary', 'plan'].includes(event.kind) ? 'assistant' : event.kind === 'tool' ? 'tool' : 'system',
      nativeId: event.nativeId, nativeBlock: true, volatile: event.kind === 'tool', kind: event.kind, turnId: event.turnId, text: '', time: Date.now() };
    session.messages.push(row);
  }
  if (Number.isSafeInteger(event.index)) {
    if (Number.isSafeInteger(row.nativeIndex) && event.index <= row.nativeIndex) return false;
    if (event.index !== (row.nativeIndex ?? -1) + 1) row.incomplete = true;
    row.nativeIndex = event.index;
  }
  if (typeof event.text === 'string') row.text = event.text;
  if (typeof event.delta === 'string') row.text += event.delta;
  for (const field of ['title', 'status', 'turnId', 'displayTurnId', 'promptId', 'inputTag']) if (typeof event[field] === 'string') row[field] = event[field];
  if (typeof event.input === 'string') row.input = event.input;
  if (event.incomplete) row.incomplete = true;
  if (['response', 'summary', 'plan'].includes(event.kind) && boundary && row.status === 'streaming') row.status = boundary.status === 'interrupted' ? 'interrupted' : 'unconfirmed';
  if (event.kind === 'turn') {
    // Only a native boundary ends a streamed response. A completed text block
    // does not finish its turn, and a finished turn does not finish its fleet.
    for (const other of session.messages) if (other.role === 'assistant' && other.nativeId === event.nativeId &&
      other.turnId === event.turnId && other.status === 'streaming') {
      other.status = event.status === 'interrupted' ? 'interrupted' : 'unconfirmed';
    }
  }
  // Retain the previous observation privacy/memory boundary even though tool
  // rows now sit in the main reader. Never silently pass an evicted body off
  // as a complete tool result.
  session.messages = trimVolatileRows(session.messages);
  return true;
}
function trimVolatileRows(messages, gapId = 'native-cache-gap') {
  const tools = messages.filter(m => m.volatile);
  const size = m => Buffer.byteLength(JSON.stringify(m));
  let bytes = tools.reduce((n, m) => n + size(m), 0), count = tools.length;
  const removed = new Set();
  // Reserve room for one gap marker. Count all fields, not just body text.
  for (const tool of tools) {
    if (bytes <= 1024 * 1024 - 2048 && count < 200) break;
    removed.add(tool.id); bytes -= size(tool); count--;
  }
  if (removed.size) {
    messages = messages.filter(m => !removed.has(m.id));
    let gap = messages.find(m => m.id === gapId);
    if (!gap) { gap = { id: gapId, role: 'system', volatile: true, kind: 'gap', time: Date.now() }; messages.push(gap); }
    gap.text = '部分工具记录超过本地保留上限，请在原生终端核对。'; gap.incomplete = true;
  }
  return messages;
}
// Retain the bounded structured trajectory the person already read. Raw legacy
// observations/terminal bytes remain ephemeral. Saved rows never grant delivery.
function persistedMessages(messages, gapId = 'native-cache-gap') {
  return trimVolatileRows(messages.filter(row => !row.volatile ||
    row.role === 'tool' && typeof row.nativeId === 'string' &&
      (row.nativeBlock === true && row.kind === 'tool' && row.id?.startsWith(`native:${row.nativeId}:tool:`) ||
        row.sharedStream === true && row.nativeMessageId?.startsWith(`native:${row.nativeId}:tool:`)) ||
    row.kind === 'gap' && row.id === gapId).map(row => ({ ...row })), gapId);
}
function applyCodexHistory(s, items, runtime, submitted = () => {}) {
  const { toolContent, toolStatus, nativeTextContent } = require('./codex-tool-content.cjs');
  const existing = new Map(s.messages.map(m => [m.id, m])), imported = [], used = new Set(), replacements = new Map();
  const exactIds = new Set(items.flatMap(item => [item.id, ...(item.clientId ? [item.clientId] : [])]));
  const legacyInputs = new Map();
  if (s.provider === 'codex' && s.recovering) {
    for (const [id, text] of runtime.recoveryNativeInputs || []) {
      const cached = existing.get(id);
      if (!cached || exactIds.has(id) || cached.text !== text || cached.role !== 'user' || cached.origin !== 'native') continue;
      if (!legacyInputs.has(text)) legacyInputs.set(text, { ids: [], next: 0 });
      legacyInputs.get(text).ids.push(id);
    }
  }
  for (const item of items) {
    const content = nativeTextContent(item);
    if (content) {
      const { text, kind, title } = content, id = `native:${s.nativeId}:${kind}:${item.id}`, cached = existing.get(id);
      if (!text && !cached) continue;
      const interrupted = cached?.status === 'interrupted';
      const row = (runtime.liveTextItems?.has(item.id) || runtime.nativeTextParts?.has(item.id)) && cached || {
        id, role: 'assistant', nativeId: s.nativeId, nativeBlock: true, kind, turnId: item.turnId,
        title, text: interrupted ? cached.text : text,
        status: interrupted ? 'interrupted' : item.turnId && item.turnId === runtime.turnId ? 'streaming' : 'complete',
      };
      if (!used.has(id)) { imported.push(row); used.add(id); }
      continue;
    }
    const tool = toolContent(item);
    if (tool) {
      const id = `native:${s.nativeId}:tool:${item.id}`;
      // History has no live watermark or submission attribution. Keep a newer
      // live row and never fabricate an inputTag that could authorize sharing.
      const row = (runtime.liveToolItems?.has(item.id) && existing.get(id)) || { id, role: 'tool', nativeId: s.nativeId,
        nativeBlock: true, volatile: true, kind: 'tool', turnId: item.turnId, text: '',
        ...tool, status: toolStatus(item, item.type === 'functionCallOutput' || item.status === 'completed' || typeof item.success === 'boolean') };
      if (row.status === 'completed') row.status = 'complete';
      if (!used.has(id)) { imported.push(row); used.add(id); }
      continue;
    }
    if (!['userMessage', 'agentMessage'].includes(item.type)) continue;
    const own = item.type === 'userMessage' && item.clientId && existing.get(item.clientId)?.role === 'user' ? existing.get(item.clientId) : existing.get(item.id);
    // A cold connection's persisted partial text is not newer than native
    // history. Live items received on this connection still take precedence.
    if (own && s.recovering && item.type === 'agentMessage' && !runtime.liveMessageItems?.has(item.id)) {
      const interrupted = own.status === 'interrupted';
      Object.assign(own, { text: interrupted ? own.text : item.text || '',
        status: interrupted ? 'interrupted' : item.turnId && item.turnId === runtime.turnId ? 'streaming' : 'complete', phase: item.phase });
    }
    if (own && s.recovering && item.type === 'userMessage' && item.clientId === own.id) { own.status = 'submitted'; submitted(own.id); }
    const m = own || (item.type === 'userMessage'
      ? { id: item.id, role: 'user', text: (item.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n'), status: 'submitted', origin: 'native' }
      : { id: item.id, role: 'assistant', text: item.text || '', status: item.turnId && item.turnId === runtime.turnId ? 'streaming' : 'complete', phase: item.phase });
    // Early backends assigned random display IDs to native user input.
    // One unmatched pure-text history item may replace one pre-recovery
    // cache row. This is display reconciliation, never reply attribution.
    if (!own && s.provider === 'codex' && s.recovering && item.type === 'userMessage' &&
      item.content?.length && item.content.every(i => i.type === 'text' && typeof i.text === 'string')) {
      const queue = legacyInputs.get(m.text);
      if (queue && queue.next < queue.ids.length) {
        const replaced = queue.ids[queue.next++]; used.add(replaced); replacements.set(replaced, m.id);
      }
    }
    if (!used.has(m.id)) { imported.push(m); used.add(m.id); }
  }
  // Native history orders its items. Preserve observed rows omitted by that
  // history (including interrupted replies) immediately after their previous
  // surviving display anchor, never after an unrelated later turn.
  const before = [], after = new Map(), unplaced = []; let anchor = null;
  for (const row of s.messages) {
    if (used.has(row.id)) { anchor = replacements.get(row.id) || row.id; continue; }
    if (!row.turnId || row.nativeId !== s.nativeId) { unplaced.push(row); continue; }
    if (anchor === null) before.push(row);
    else { if (!after.has(anchor)) after.set(anchor, []); after.get(anchor).push(row); }
  }
  // No complete/nativeInput events: hydration cannot route or pause a task.
  const ordered = imported.flatMap(row => [row, ...(after.get(row.id) || [])]);
  s.messages = trimVolatileRows((anchor === null ? ordered.concat(before) : before.concat(ordered)).concat(unplaced));
  runtime.recoveryNativeInputs?.clear();
}
// A native interrupt fixes the observed text cut. Late deltas/completion and
// reconnect history cannot silently rewrite that cut or create a final reply.
function codexInterrupted(s, item, row) {
  return row?.status === 'interrupted' || Boolean(item.turnId && s.messages.some(m =>
    m.kind === 'turn' && m.nativeId === (item.nativeId || s.nativeId) &&
    m.turnId === item.turnId && m.status === 'interrupted'));
}
function applyCodexDelta(s, item) {
  let message = s.messages.find(m => m.id === item.id);
  if (codexInterrupted(s, item, message)) return null;
  if (!message) { message = { id: item.id, role: 'assistant', text: '', status: 'streaming' }; s.messages.push(message); }
  message.text += item.text;
  if (item.turnId) message.turnId = item.turnId;
  message.nativeId = s.nativeId;
  if (typeof item.inputTag === 'string') message.inputTag = item.inputTag;
  const ended = s.messages.find(m => m.kind === 'turn' && m.nativeId === s.nativeId && m.turnId === item.turnId);
  if (ended) message.status = ended.status === 'interrupted' ? 'interrupted' : 'unconfirmed';
  return message;
}
function applyCodexProgress(s, item) {
  const id = `native:${s.nativeId}:tool:${item.id}`;
  if (!item.id || item.source !== 'codex-native' || (!item.turnId && !s.messages.some(m => m.id === id))) return null;
  applyNativeBlock(s, { ...item, id: `tool:${item.id}`, nativeId: s.nativeId, kind: 'tool',
    status: item.status === 'completed' ? 'complete' : item.status });
  return s.messages.find(m => m.id === id);
}
function applyCodexMessage(s, item) {
  let m = s.messages.find(m => m.id === item.id);
  if (codexInterrupted(s, item, m)) return null;
  if (!m) {
    m = { id: item.id, role: 'assistant' };
    if (item.nativeId && item.nativeId !== s.nativeId) {
      const context = s.nativeContexts?.find(c => c.nativeId === item.nativeId);
      const index = s.messages.findIndex(message => message.id === context?.boundaryId);
      if (index < 0) return null;
      s.messages.splice(index, 0, m);
    } else s.messages.push(m);
  }
  Object.assign(m, { text: item.text, status: 'complete', nativeId: item.nativeId || s.nativeId, phase: item.phase, ...(typeof item.inputTag === 'string' ? { inputTag: item.inputTag } : {}), ...(item.turnId ? { turnId: item.turnId } : {}) });
  return m;
}
module.exports = { applyNativeBlock, trimVolatileRows, persistedMessages, applyCodexHistory, applyCodexDelta, applyCodexMessage, applyCodexProgress };
