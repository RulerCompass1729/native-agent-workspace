// Native display records are private session history. They never authorize a
// send, a shared reply, or completion of background work.
function applyNativeBlock(session, event) {
  if (!event || typeof event.id !== 'string' || !event.id || event.nativeId !== session.nativeId) return false;
  const id = `native:${event.nativeId}:${event.id}`;
  let row = session.messages.find(m => m.id === id);
  if (row?.turnId && event.turnId && row.turnId !== event.turnId) { row.incomplete = true; return true; }
  const boundary = event.turnId && session.messages.find(m => m.nativeId === event.nativeId && m.kind === 'turn' && m.turnId === event.turnId);
  if (!row) {
    row = { id, role: event.kind === 'response' ? 'assistant' : event.kind === 'tool' ? 'tool' : 'system',
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
  for (const field of ['title', 'status', 'turnId', 'displayTurnId']) if (typeof event[field] === 'string') row[field] = event[field];
  if (typeof event.input === 'string') row.input = event.input;
  if (event.incomplete) row.incomplete = true;
  if (event.kind === 'response' && boundary && row.status === 'streaming') row.status = boundary.status === 'interrupted' ? 'interrupted' : 'unconfirmed';
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
  const tools = session.messages.filter(m => m.volatile);
  const size = m => Buffer.byteLength(JSON.stringify(m));
  let bytes = tools.reduce((n, m) => n + size(m), 0), count = tools.length;
  const removed = new Set();
  // Reserve room for one gap marker. Count all fields, not just body text.
  for (const tool of tools) {
    if (bytes <= 1024 * 1024 - 2048 && count < 200) break;
    removed.add(tool.id); bytes -= size(tool); count--;
  }
  if (removed.size) {
    session.messages = session.messages.filter(m => !removed.has(m.id));
    const gapId = 'native-cache-gap';
    let gap = session.messages.find(m => m.id === gapId);
    if (!gap) { gap = { id: gapId, role: 'system', volatile: true, kind: 'gap', time: Date.now() }; session.messages.push(gap); }
    gap.text = '部分工具记录超过本次运行缓存上限，请在原生终端核对。'; gap.incomplete = true;
  }
  return true;
}
module.exports = { applyNativeBlock };
