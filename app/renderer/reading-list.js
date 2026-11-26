// Per-window reading state. Only IDs and geometry are persisted, never selection.
const messageViews = new Map();
let readingPositions = {};
let readingPayloadId = 0;
function readingDeliveryStatusKey(message, delivery) {
  if (message.imageDraftVersion && message.images?.length) return message.imageReceipt?.status === 'accepted' && message.imageReceipt.basis === 'native-local-image-echo' ? 'roomImages.accepted' : 'roomImages.receiptPending';
  return ({ submitted: message.deliveredInto ? message.nativeRead ? 'delivery.midturnRead' : 'delivery.midturnStored' : 'delivery.submitted', 'awaiting-native': message.inputMode === 'queue' ? message.midturn ? 'delivery.queuedMidturn' : 'delivery.queued' : 'delivery.awaiting', unconfirmed: 'delivery.unconfirmed', 'not-sent': 'delivery.notSent' }[delivery.status] || 'delivery.unknown');
}
// A sender's durable notice is not a room mirror or a native tool receipt.
function readingWakeIntent(message, room, session) {
  const wake = message.wake;
  return !room && session && typeof session.nativeId === 'string' && session.nativeId && typeof message.id === 'string' && message.id && message.role === 'system' && message.kind === 'notice' && message.origin === 'agent-wake-intent' &&
    wake && message.id === wake.id && wake.senderId === session.id && wake.nativeId === session.nativeId &&
    typeof wake.body === 'string' && wake.body.length <= 6000 && typeof wake.recipientId === 'string' && wake.recipientId ? wake : null;
}
function readingWakeStatus(wake) {
  const labels = { staged: 'reading.wakeRegistered', held: 'reading.wakeHeld', sending: 'delivery.awaiting', consumed: 'delivery.awaiting',
    submitted: 'delivery.submitted', unconfirmed: 'delivery.unconfirmed', cancelled: 'delivery.notSent', 'not-sent': 'delivery.notSent' };
  return typeof wake.status === 'string' && Object.hasOwn(labels, wake.status) ? labels[wake.status] : 'delivery.unknown';
}
// These are recorded communication shapes, not authentication of arbitrary text.
// A peer row proves the receiving native session observed input; its claimed
// sender remains independently marked unverified by roomMessageLabel.
function readingSpaceMessageKind(message) {
  const id = value => typeof value === 'string' && value.length > 0;
  if (message.role === 'system' && message.kind === 'agent-wake' &&
      id(message.wake?.id) && id(message.wake?.senderId) && id(message.wake?.recipientId)) return 'wake';
  if (message.role === 'system' && message.kind === 'agent-peer' && id(message.peerMessage?.recipientId)) return 'peer';
  if (['user', 'human'].includes(message.role) && id(message.agentControl?.id) && id(message.agentControl?.nativeId) && id(message.recipientId)) return 'control';
  return null;
}
function readingSpaceMessageStatus(message, room = false) {
  if (!room) return null;
  const kind = readingSpaceMessageKind(message);
  if (kind === 'wake') return readingWakeStatus({ status: message.wakeStatus });
  if (kind === 'peer') return 'delivery.peerReceived';
  if (kind !== 'control') return null;
  const receipts = (Array.isArray(message.deliveries) ? message.deliveries : []).filter(delivery => delivery?.recipientId === message.recipientId);
  const status = receipts.length === 1 ? readingDeliveryStatusKey(message, receipts[0]) : 'delivery.unknown';
  return typeof status === 'string' ? status : 'delivery.unknown';
}
// A row's own delivery or run state, as its line says it; the space's 信息流 uses it for a request too.
// Only Claude rows take queued input; native sends it once the agent is idle.
function readingMessageStatusKey(m, room = false, session = null) {
  const keys = { 'awaiting-native': m.inputMode === 'queue' ? m.midturn ? 'delivery.queuedMidturn' : 'delivery.queued' : 'delivery.awaiting', unconfirmed: 'reading.status.unconfirmed', 'not-sent': 'delivery.notSent', streaming: 'reading.status.streaming', running: !room && session?.provider === 'claude' && m.role === 'tool' ? 'reading.status.toolRequested' : 'reading.status.running', failed: 'reading.status.failed', declined: 'reading.status.declined', interrupted: 'reading.status.interrupted', 'reply-private': m.deliveredInto ? 'reading.status.midturnPrivate' : 'reading.status.private' };
  return typeof m.status === 'string' && Object.hasOwn(keys, m.status) ? keys[m.status] : undefined;
}
function readingSpaceMessageBody(message, room) {
  if (!room || readingSpaceMessageKind(message) !== 'wake') return null;
  const body = message.wake.body, text = ui.displayText(message.text, message.uiMessage);
  // Only separate an exact original suffix. Unexpected legacy text and every
  // recorded reason remain intact rather than being guessed from status.
  return typeof body === 'string' && body && text.endsWith(body)
    ? { body, notice: text.slice(0, text.length - body.length) } : null;
}
function cancelReadingWakeCollapse(entry) {
  if (entry.wakeTimer !== undefined) clearTimeout(entry.wakeTimer);
  delete entry.wakeTimer;
}
function readingWakeHeld(view, entry) {
  if (view.folds[entry.message.id] !== undefined || entry.item.dataset.searchTarget === 'true' ||
      view.intent?.searchQuery && view.intent.position.anchor === entry.message.id || entry.item.contains(document.activeElement)) return true;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  if (entry.item.contains(selection.anchorNode) || entry.item.contains(selection.focusNode)) return true;
  // A selection can span this record with both endpoints outside it.
  try { return selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(entry.item); }
  catch { return true; }
}
function updateReadingWake(view, entry, wake) {
  const previous = entry.wakeState, observed = entry.wakeObserved;
  if (previous === wake?.status && observed === Boolean(wake)) return;
  cancelReadingWakeCollapse(entry);
  entry.wakeState = wake?.status; entry.wakeObserved = Boolean(wake);
  // An already received history row does not replay a presentation timer.
  entry.wakeExpanded = Boolean(wake && (wake.status !== 'submitted' || observed && previous !== 'submitted'));
  if (!wake || wake.status !== 'submitted' || !entry.wakeExpanded || readingWakeHeld(view, entry)) return;
  const key = view.key, id = entry.message.id, callId = wake.callId, turnId = wake.turnId;
  const timer = setTimeout(() => {
    if (entry.wakeTimer !== timer) return;
    delete entry.wakeTimer;
    const current = readingWakeIntent(entry.message, false, view.session);
    if (view.key !== key || view.entries.get(id) !== entry || !view.el.isConnected || !view.el.clientHeight || !view.el.clientWidth || !entry.disclosure || !current ||
        current.status !== 'submitted' || current.callId !== callId || current.turnId !== turnId || readingWakeHeld(view, entry)) return;
    // This is layout, not a human fold. Preserve a newer Latest/search intent
    // and ignore the browser's clamp scroll until the existing follow frame.
    if (!view.intent) {
      captureReading(view);
      view.intent = { position: readingPositions[view.key] || { top: view.el.scrollTop, follow: true, anchor: '', offset: 0 } };
    }
    entry.wakeExpanded = false; view.pageChanging = true;
    entry.expectedOpen = false; entry.disclosure.open = false;
    updateProcessTail(entry); scheduleReading(view);
  }, 2500);
  entry.wakeTimer = timer;
}
function readingMessageClock(message, now = Date.now(), language = []) {
  const important = Boolean(readingSpaceMessageKind(message)) || ['user', 'human'].includes(message.role) || message.role === 'assistant' &&
    (!message.kind || message.kind === 'response') && message.phase !== 'commentary' && message.status !== 'streaming';
  if (!important || !Number.isFinite(message.time) || Math.abs(message.time) > 8640000000000000) return null;
  const date = new Date(message.time), today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { text: (sameDay ? '' : date.toLocaleDateString(language) + ' ') + time, dateTime: date.toISOString(), full: date.toLocaleString(language, { hourCycle: 'h23' }) };
}
function readingDisplayClock(message) { return readingMessageClock(message, Date.now(), ui.language.getSnapshot().active); }
// NAW's own tools, said as what they do rather than by their internal names (mcp__native_workspace__… from
// Claude, native_workspace.… from Codex). The full input stays in the expandable original.
function readingNawTool(message) {
  const match = typeof message.title === 'string' && /^(?:mcp__native_workspace__|native_workspace\.)workspace_(control|message|open|report|sessions)$/.exec(message.title);
  if (!match) return null;
  let input = {};
  try { const value = JSON.parse(message.input || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) input = value; } catch { /* shown as is when expanded */ }
  return { tool: match[1], input };
}
// The page's text lookup answers an unknown key with the key itself, so a name this build has no words for is
// checked here (the shared table throws on it) and said as a call instead.
function uiTextKnown(key) { try { window.nativeWorkspaceLocale.format('en', key); return true; } catch { return false; } }
function readingNawToolPreview(tool) {
  const { input } = tool, text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : '';
  if (tool.tool === 'control' && input.action === 'invoke' && text(input.method)) {
    const args = Array.isArray(input.arguments) ? input.arguments : [];
    if (input.method === 'clearSharedHistory' || input.method === 'spaceAction' && args[1] === 'clearSharedHistory') {
      const id = input.method === 'spaceAction' ? args[0] : 'shared', room = (state.rooms || [state.room]).find(room => room?.id === id);
      return room?.name ? uiText('background.card.clearSharedHistoryShort', { name: text(room.name) }) : uiText('background.action.clearSharedHistory');
    }
    const action = uiTextKnown('background.action.' + input.method) ? uiText('background.action.' + input.method) : uiText('background.card.call', { method: text(input.method) });
    const name = text(input.method === 'create' ? args[0]?.name : input.method === 'spaceCreate' ? args[0] : '');
    return name ? uiText('background.card.named', { action, name }) : action;
  }
  if (tool.tool === 'control') return ['catalog', 'snapshot', 'receipt'].includes(input.action) ? uiText('reading.nawTool.' + input.action) : '';
  if (tool.tool === 'message' && text(input.recipient_id)) {
    const target = state.sessions.find(s => s.id === input.recipient_id);
    return uiText('reading.nawTool.messageTo', { name: target ? participantLabel(target, state.sessions) : text(input.recipient_id) });
  }
  return tool.tool === 'open' && text(input.name) ? uiText('background.card.named', { action: uiText('background.action.create'), name: text(input.name) }) : '';
}
function readingActionLabel(message, author) {
  const key = message.toolKind === 'commandExecution' || message.title === 'Bash' ? 'reading.commandOutput'
    : ['user', 'human'].includes(message.role) ? 'reading.input'
    : message.role === 'assistant' && (!message.kind || message.kind === 'response') ? 'reading.reply'
    : message.kind === 'summary' ? 'reading.summary' : message.role === 'tool' ? 'reading.toolRecord' : 'reading.record';
  return uiText(key, { author });
}
async function copyReadingMessage(entry) {
  const text = entry.copyPayload ? entry.copyPayload() : entry.displayText ?? entry.message.text, label = entry.copyLabel;
  await api.copy(text);
  toastMessage('reading.copied', () => ({ label: label() }));
}
// Visual boundaries do not wrap rows or expand paging spans. A page can begin
// inside one native turn; that is a continuation, never a fabricated new input.
function readingTurnMarks(messages, room = false, originals = messages) {
  const counts = new Map(), marks = new Map(), positions = new Map();
  for (const m of originals) counts.set(m.id, (counts.get(m.id) || 0) + 1);
  const identity = m => {
    if (counts.get(m.id) !== 1 || typeof m.nativeId !== 'string' || !m.nativeId || typeof m.turnId !== 'string' || !m.turnId ||
      m.kind === 'gap' || m.kind === 'context' || m.incomplete || m.sharingStopped) return null;
    if (room && (!m.sharedStream || !m.sessionId || !m.nativeMessageId || !m.sourceTag || !Number.isFinite(m.time) || Math.abs(m.time) > 8640000000000000)) return null;
    return JSON.stringify([m.nativeId, m.turnId, room ? m.sessionId : null, room ? m.sourceTag : null, room ? m.replyTo : null]);
  };
  let previous;
  originals.forEach((m, index) => {
    const key = identity(m);
    if (key) marks.set(m.id, { start: key !== previous, continuation: false, key });
    positions.set(m.id, index);
    previous = m.status === 'interrupted' || m.kind === 'turn' && ['complete', 'failed'].includes(m.status) ? null : key;
  });
  const visible = new Map(); let priorIndex;
  for (const m of messages) {
    const mark = marks.get(m.id), index = positions.get(m.id);
    if (mark) visible.set(m.id, { ...mark, continuation: !mark.start && index !== priorIndex + 1 });
    priorIndex = index;
  }
  return visible;
}
function readingTurnFooter(message, now = Date.now()) {
  if (message.kind !== 'turn' || !message.nativeId || !message.turnId || !(message.nativeBlock || message.sharedStream) ||
    !['complete', 'failed', 'interrupted'].includes(message.status)) return null;
  let duration = '';
  if (Number.isSafeInteger(message.nativeDurationMs) && message.nativeDurationMs >= 0) {
    const seconds = Math.floor(message.nativeDurationMs / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    duration = hours ? `${hours}h ${minutes}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : seconds ? `${seconds}s` : '<1s';
  }
  const clock = readingMessageClock({ role: 'user', time: message.nativeCompletedAt }, now);
  return duration || clock ? { duration, clock } : null;
}
// Pages contain original records, without spacers for unloaded history. Native
// group plans supply atomic spans and aliases for saved process:<id> anchors.
function readingPageData(messages, plans = []) {
  const indices = new Map(messages.map((m, i) => [m.id, i])), spans = [];
  for (const plan of plans) {
    const members = plan.messages.map(m => indices.get(m.id)).filter(Number.isSafeInteger);
    if (!members.length) continue;
    let start = members[0], end = start + 1;
    for (const i of members) { start = Math.min(start, i); end = Math.max(end, i + 1); }
    if (plan.id && !indices.has(plan.id)) indices.set(plan.id, members[0]);
    spans.push({ start, end });
  }
  const merged = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return { messages, indices, spans: merged };
}
function readingPageRange(data, previous, request, position = {}, pinned = false) {
  const n = data.messages.length, size = 50, index = id => data.indices.get(id);
  let start = Math.max(0, n - size), end = n;
  const centred = i => { start = Math.max(0, Math.min(i - size / 2, n - size)); end = Math.min(n, start + size); };
  const anchor = index(position.anchor), first = index(previous?.firstId), last = index(previous?.lastId);
  if (previous) {
    if (Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last) { start = first; end = last + 1; }
    else if (Number.isSafeInteger(anchor)) centred(anchor);
    else if (Number.isSafeInteger(last)) { end = last + 1; start = Math.max(0, end - size); }
    else if (Number.isSafeInteger(first)) { start = first; end = Math.min(n, start + size); }
    if (previous.tail) {
      end = n;
      if (position.follow && !pinned) start = Math.max(0, n - size);
    }
  } else if (!position.follow && Number.isSafeInteger(anchor)) centred(anchor);
  if (request?.action === 'older') start = Math.max(0, start - size);
  else if (request?.action === 'newer') end = Math.min(n, end + size);
  else if (request?.action === 'first') { start = 0; end = Math.min(n, size); }
  else if (request?.action === 'latest') { start = Math.max(0, n - size); end = n; }
  else if (request?.action === 'target' && Number.isSafeInteger(index(request.id))) centred(index(request.id));
  for (const span of data.spans) if (span.start < end && span.end > start) { start = Math.min(start, span.start); end = Math.max(end, span.end); }
  return { start, end, firstId: data.messages[start]?.id || '', lastId: data.messages[end - 1]?.id || '', tail: end === n };
}
function readingFollow(tail, nearEnd, selecting) { return tail === true && nearEnd && !selecting; }
// What a render draws for one page of records, to tell a column whose rows changed
// from one drawn again unchanged (the grid redraws every column on any update).
function readingContentKey(messages) {
  return messages.map(m => [m.id, m.role, m.kind, m.status, m.phase, m.turnId, m.displayTurnId, m.title, m.incomplete, m.nativeIndex,
    typeof m.text === 'string' ? m.text.length : 0, typeof m.input === 'string' ? m.input.length : 0,
    Array.isArray(m.images) ? m.images.map(image => image?.pending ? 'p' : image?.unavailable ? 'u' : 'i').join('') : '', m.nativeDurationMs, m.nativeCompletedAt].join('\u0001')).join('\u0002');
}
// A following render ignores scrolls until its follow frame (T-134), except while the
// person is moving away: a held pointer, or shortly after a wheel-up or an away key.
function followRenderGuard(view, now = performance.now()) { return !view.onScrollbar?.() && now - (view.awayAt ?? -Infinity) > 500; }
function changeReadingPage(view, action, fromButton = false, automatic = false) {
  if (!view.reload || view.loadingPage || !view.el.isConnected) return;
  captureReading(view);
  // The initial following target may not have a saved position yet. Automatic
  // fill must carry the live target through a short, folded process page.
  const previous = view.intent?.position || readingPositions[view.key] || { top: 0, follow: false, anchor: '', offset: 0 };
  const pagerFocused = document.activeElement === view.older || document.activeElement === view.newer;
  const position = action === 'latest' ? { top: 0, follow: true, anchor: '', offset: 0 }
    : action === 'first' ? { top: 0, follow: false, anchor: view.pageData.messages[0]?.id || '', offset: 0 }
    : { ...previous, follow: Boolean(automatic && previous.follow && view.pageRange.tail) };
  // 跳到最新 and End (the only callers of 'latest') end a wheel-up's move away. Otherwise the
  // guard stayed aside for the rest of its 500ms, and a fold then ended the new following.
  if (action === 'latest') view.awayAt = undefined;
  view.intent = { position }; saveReading(view, position);
  view.pageRequest = { action }; view.pageChanging = true; view.loadingPage = true;
  try { view.reload(); } finally { view.loadingPage = false; }
  view.intent = { position }; scheduleReading(view);
  if (fromButton || pagerFocused) view.el.focus({ preventScroll: true });
  attempt(() => api.readingState(readingPositions));
}
function fillShortReadingPage(view) {
  if (!view.paged || view.pageChanging || view.autoPages <= 0 || !view.el.clientHeight || view.el.scrollHeight > view.el.clientHeight + 1) return;
  const action = view.pageRange.start ? 'older' : !view.pageRange.tail ? 'newer' : '';
  if (action) { view.autoPages--; changeReadingPage(view, action, false, true); }
}
function saveReading(view, position) {
  if (view.folds && Object.keys(view.folds).length) position.folds = { ...view.folds };
  else delete position.folds;
  readingPositions[view.key] = position;
  // Bound metadata even when old sessions have been removed or archived.
  if (window.nativeWorkspacePanorama) readingPositions = window.nativeWorkspacePanorama.pruneReading(readingPositions, activeReturnReadingKeys());
  else {
    const keys = Object.keys(readingPositions);
    for (const key of keys.slice(0, Math.max(0, keys.length - 128))) delete readingPositions[key];
  }
}
function captureReading(view) {
  const el = view.el;
  if (!view.key || !el.clientHeight || !el.getClientRects().length) return;
  // An asynchronous Markdown layout may still be completing. Preserve its
  // original anchor until an actual scroll/pointer/key action supersedes it.
  if (view.intent) return;
  updateJump(view);
  const selection = window.getSelection();
  const selecting = !selection.isCollapsed && el.contains(selection.anchorNode);
  const top = el.getBoundingClientRect().top;
  const anchor = [...el.querySelectorAll(':scope > [data-message-id]')].find(row => row.getBoundingClientRect().bottom > top);
  saveReading(view, { top: el.scrollTop, follow: readingFollow(view.pageRange?.tail, el.scrollHeight - el.scrollTop - el.clientHeight < 80, selecting), anchor: anchor?.dataset.messageId || '', offset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
  view.lastTop = el.scrollTop;
}
// Like the native terminal's "Jump to bottom": shown once the reader leaves the latest output.
// Its bar has no height, so showing it never moves the scroll position.
function updateJump(view) { view.jumpBar.hidden = !view.el.clientHeight || view.pageRange?.tail !== false && view.el.scrollHeight - view.el.scrollTop - view.el.clientHeight < 80; }
function captureReadingViews() { for (const view of messageViews.values()) captureReading(view); }
function readingEntry(view, id) { return view.entries.get(id) || view.groups?.get(id); }
function restoreVisibleReading() {
  for (const view of messageViews.values()) {
    const visible = Boolean(view.el.clientHeight && view.el.getClientRects().length);
    if (visible && !view.visible) {
      view.intent = { position: readingPositions[view.key] || { top: 0, follow: true, anchor: '', offset: 0 } };
      scheduleReading(view);
    }
    view.visible = visible;
  }
}
function readingMatch(body, query) {
  if (!query?.trim()) return null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = []; let text = '', current;
  while ((current = walker.nextNode())) {
    if (current.parentElement?.closest('button, svg, [hidden], script, style')) continue;
    nodes.push({ node: current, start: text.length }); text += current.textContent;
  }
  // Literal, Unicode-aware case matching retains UTF-16 positions in the
  // original text; lowercasing first can change their lengths.
  const match = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(text);
  if (!match) return null;
  const start = nodes.findLast(n => n.start <= match.index);
  const endIndex = match.index + match[0].length;
  const end = nodes.findLast(n => n.start < endIndex);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, match.index - start.start); range.setEnd(end.node, endIndex - end.start);
  return range;
}
function revealProcessAncestors(view, entry) {
  for (let parent = entry.item.parentElement?.closest('details.process-details'); parent && view.el.contains(parent); parent = parent.parentElement?.closest('details.process-details')) {
    const enclosing = readingEntry(view, parent.closest('[data-message-id]')?.dataset.messageId);
    if (enclosing) enclosing.expectedOpen = true; parent.open = true;
  }
}
// Rows laid out above the reading place (an older page, then its Markdown mounting) move the text under
// the pointer until the frame corrects it, and a press in between lands on another record (reading:107).
// The same anchor correction also runs when the current task ends, before any input is handled, but only
// while the reader is where it last captured or placed it (lastTop). Moved by other code since (a column
// reorder restores its own scroll), it is left to the scroll event and the frame, as before.
function keepReadingAnchorSoon(view) {
  if (view.anchorQueued) return;
  view.anchorQueued = true;
  Promise.resolve().then(() => {
    view.anchorQueued = false;
    const p = view.intent?.position, el = view.el, anchor = p && !p.follow && readingEntry(view, p.anchor)?.item;
    if (!anchor || el.scrollTop !== view.lastTop || !el.clientHeight || !el.getClientRects().length || !anchor.getClientRects().length) return;
    const top = el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - p.offset;
    if (Math.abs(top - el.scrollTop) >= 1) { el.scrollTop = top; view.assignedTop = el.scrollTop; }
    view.lastTop = el.scrollTop;
  });
}
function scheduleReading(view, intent = view.intent) {
  if (!intent || view.intent !== intent || view.loadingPage) return;
  // Load synchronously, before the frame: explicit search intent and its query
  // must survive the internal render and asynchronous Markdown callbacks.
  if (intent.position.follow && view.pageRange?.tail === false) {
    // Following means the real latest record, never the historical anchor
    // left at the viewport's top before streaming or an explicit search.
    const latest = view.pageData?.messages.at(-1)?.id;
    if (latest) view.loadMessage?.(latest);
    view.intent = intent;
  } else if (!intent.position.follow && intent.position.anchor && !readingEntry(view, intent.position.anchor)) {
    view.loadMessage?.(intent.position.anchor); view.intent = intent;
  }
  // Search focuses its original row immediately after scheduling. Reveal the
  // ancestors now, without turning that reveal into a saved manual choice.
  const target = readingEntry(view, intent.position.anchor);
  if (target && !intent.position.follow) revealProcessAncestors(view, target);
  if (target && !intent.position.follow) keepReadingAnchorSoon(view);
  if (view.frame) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = 0;
    // Without an intent no frame will clear the following-render guard later.
    if (!view.intent) { view.pageChanging = false; return; }
    if (!view.el.clientHeight || !view.el.getClientRects().length) return;
    const el = view.el, p = view.intent.position;
    const anchor = readingEntry(view, p.anchor)?.item;
    if (anchor && !p.follow) {
      const entry = readingEntry(view, p.anchor);
      revealProcessAncestors(view, entry);
    }
    if (anchor && view.intent.searchQuery) {
      const entry = readingEntry(view, p.anchor);
      if (entry.disclosure && !entry.disclosure.open) { entry.expectedOpen = true; entry.disclosure.open = true; }
      if (entry.operatorTask) entry.operatorTask.open = true;
      const range = entry.body && readingMatch(entry.body, view.intent.searchQuery);
      if (range) {
        const offset = 16 - (range.getBoundingClientRect().top - anchor.getBoundingClientRect().top);
        if (p.offset !== offset) {
          p.offset = offset;
          attempt(() => api.readingState(readingPositions));
        }
      }
    }
    el.scrollTop = p.follow ? el.scrollHeight : anchor ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - p.offset : p.top;
    view.assignedTop = view.lastTop = el.scrollTop; view.pageChanging = false; updateJump(view); fillShortReadingPage(view);
  });
}
function readingView(el, key, room = false) {
  let view = messageViews.get(el);
  if (!view) {
    view = { el, key: '', entries: new Map(), groups: new Map(), days: new Map(), assignedTop: el.scrollTop, frame: 0, intent: null };
    el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'region');
    if (!el.hasAttribute('aria-label')) ui.display.attribute(el, 'aria-label', 'reading.records');
    view.older = button('', () => changeReadingPage(view, 'older', true), 'reading-page');
    ui.display.text(view.older, 'disclosure.older', { count: 0, total: 0 });
    view.newer = button('', () => changeReadingPage(view, 'newer', true), 'reading-page');
    ui.display.text(view.newer, 'reading.newer', { count: 0, total: 0 });
    view.older.dataset.direction = 'older'; view.newer.dataset.direction = 'newer';
    view.jump = button('', () => changeReadingPage(view, 'latest'), 'jump-latest');
    ui.display.text(view.jump, 'reading.latest');
    view.jumpBar = node('div', undefined, 'jump-bar'); view.jumpBar.append(view.jump); view.jumpBar.hidden = true;
    // Keep the original scroll element, rows and reading intent. Only the
    // prompt moves to a permanent footer outside the conversation viewport.
    if (!room && el.parentElement) {
      view.readingSurface = node('div', undefined, 'reading-surface');
      view.jumpSlot = node('div', undefined, 'reading-slot');
      el.parentElement.insertBefore(view.readingSurface, el);
      view.readingSurface.append(el, view.jumpSlot);
      view.jumpSlot.append(view.jumpBar);
    }
    const interact = () => { view.intent = null; view.assignedTop = undefined; view.pageChanging = false; view.autoPages = 4; };
    // While following, moving toward the latest is not leaving it, and must not drop
    // the render guard above (T-134): a trackpad keeps sending wheel-downs at the end.
    const toward = event => view.intent?.position.follow && (event.type === 'wheel' ? event.deltaY > 0
      : ['ArrowDown', 'PageDown', ' '].includes(event.key) && !event.shiftKey && !event.target.closest?.('input,textarea,select,[contenteditable="true"]'));
    const away = event => event.type === 'wheel' ? event.deltaY < 0 : ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey;
    // Only a press on the reader's scrollbar strip holds; a press on a row, a button
    // such as 复制, or the padding between rows keeps the guard, so following
    // survives a click. The strip covers classic and overlay scrollbars alike. The
    // press only records where it was: reading the box here would force a layout
    // before the browser handles the scrollbar press, and could move the thumb.
    // A press on a row or button does not move the reader. While it is still where the reader last captured or
    // placed it (lastTop), the press keeps a non-follow anchor whose rows above may still be laying out, such as an older
    // page mounting its Markdown; dropping it shifts the text under the pointer (reading:107).
    const press = event => {
      if (event.target === el || !view.intent || view.intent.position.follow || el.scrollTop !== view.lastTop) interact();
      view.pointerHeld = event.target === el; view.pressX = event.clientX;
    };
    view.onScrollbar = () => Boolean(view.pointerHeld && view.pressX >= el.getBoundingClientRect().right - 16);
    // A scrollbar drag let go at the end starts following, like the wheel at the end.
    const release = () => {
      const bar = view.onScrollbar(); view.pointerHeld = false;
      if (!bar) return;
      view.intent = null; captureReading(view);
      if (readingPositions[view.key]?.follow) view.intent = { position: readingPositions[view.key] };
    };
    const hover = event => { if (!event.buttons) release(); };
    const wheel = event => {
      if (toward(event)) return;
      if (away(event)) view.awayAt = performance.now();
      interact();
      if (!view.paged) return;
      if (event.deltaY < 0 && el.scrollTop <= 1 && view.pageRange.start) changeReadingPage(view, 'older');
      else if (event.deltaY > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1 && !view.pageRange.tail) changeReadingPage(view, 'newer');
    };
    const keydown = event => {
      if (toward(event)) return;
      if (away(event)) view.awayAt = performance.now();
      interact();
      if (!view.paged || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey ||
          event.target.closest('input,textarea,select,[contenteditable="true"]') || !['Home', 'End'].includes(event.key)) return;
      event.preventDefault(); changeReadingPage(view, event.key === 'Home' ? 'first' : 'latest');
    };
    const scroll = () => {
      if (!el.clientHeight || view.pageChanging) return;
      const assigned = view.assignedTop; view.assignedTop = undefined;
      updateJump(view);
      if (el.scrollTop === assigned) return;
      view.intent = null; captureReading(view);
      // Hand the geometry to main now; it coalesces disk writes and flushes on
      // normal close. A renderer timer could lose the last scroll on close.
      attempt(() => api.readingState(readingPositions));
      if (view.paged && el.scrollTop <= 1 && view.pageRange.start) changeReadingPage(view, 'older');
      else if (view.paged && el.scrollHeight - el.scrollTop - el.clientHeight <= 1 && !view.pageRange.tail) changeReadingPage(view, 'newer');
    };
    el.addEventListener('pointerdown', press); el.addEventListener('pointermove', hover, { passive: true }); el.ownerDocument.addEventListener('pointerup', release, true); el.ownerDocument.addEventListener('pointercancel', release, true); el.addEventListener('wheel', wheel, { passive: true }); el.addEventListener('keydown', keydown); el.addEventListener('scroll', scroll, { passive: true });
    // A settled reader has no pending intent: a clamp scroll with no input ended it, and its saved
    // position still follows. A resize from outside (the window, a column terminal) fires no scroll, so
    // re-arm that saved target here, as restoreOverviewReading does on layout. A held scrollbar or a
    // move away within 500ms still wins (followRenderGuard); a reader read further up saved follow:false,
    // and one with a text selection in it does not follow (readingFollow), so neither is pulled to the end.
    view.observer = new ResizeObserver(() => {
      const selection = window.getSelection(), selecting = Boolean(selection && !selection.isCollapsed && el.contains(selection.anchorNode));
      if (!view.intent && !selecting && readingPositions[view.key]?.follow && followRenderGuard(view)) { view.intent = { position: readingPositions[view.key] }; view.pageChanging = true; }
      scheduleReading(view);
    });
    view.observer.observe(el);
    view.dispose = () => { for (const entry of view.entries.values()) { cancelReadingWakeCollapse(entry); entry.images?.dispose(); if (entry.imageReceipt) ui.display.unbind(entry.imageReceipt, 'text'); } view.observer.disconnect(); cancelAnimationFrame(view.frame); el.removeEventListener('pointerdown', press); el.removeEventListener('pointermove', hover); el.ownerDocument.removeEventListener('pointerup', release, true); el.ownerDocument.removeEventListener('pointercancel', release, true); el.removeEventListener('wheel', wheel); el.removeEventListener('keydown', keydown); el.removeEventListener('scroll', scroll); view.reload = null; view.loadMessage = null; view.pageData = null; if (view.jumpSlot) { if (view.readingSurface.parentElement) view.readingSurface.before(el); view.jumpBar.remove(); view.jumpSlot.remove(); view.readingSurface.remove(); ui.display.unbind(view.jump); } ui.clearMarkdown(el); };
    messageViews.set(el, view);
  }
  if (view.key !== key) {
    for (const entry of view.entries.values()) { cancelReadingWakeCollapse(entry); entry.images?.dispose(); if (entry.imageReceipt) ui.display.unbind(entry.imageReceipt, 'text'); }
    captureReading(view); ui.clearMarkdown(el); el.replaceChildren();
    view.entries.clear(); view.groups.clear(); view.days.clear(); view.key = key; view.contentKey = null; view.folds = Object.assign(Object.create(null), readingPositions[key]?.folds || {});
    view.pageRange = null; view.pageRequest = null; view.pageChanging = false; view.autoPages = 4; view.reload = null; view.loadMessage = null;
    // The new list is empty until Markdown mounts; never capture that temporary
    // zero as this session's saved reading position.
    view.intent = { position: readingPositions[key] || { top: 0, follow: true, anchor: '', offset: 0 } };
    el.scrollTop = 0; view.assignedTop = 0; view.lastTop = undefined;
  }
  return view;
}
function readingOwnMessage(message) {
  if (message.role !== 'system' && !(message.role === 'tool' && ['notice.legacy.nonText', 'notice.legacy.gapText'].includes(message.uiMessage?.key))) return null;
  const locale = window.nativeWorkspaceLocale;
  return locale.displayMessage(message.uiMessage, 'notice.', message.text) || locale.displayMessage(message.uiMessage, 'error.', message.text);
}
// The member a queue item went to, when that session is archived now: the line names it with the
// marker. The stored sentence is not rewritten, and restoring the session drops the marker again.
function readingDispatchMember(message, descriptor) {
  if (descriptor?.key !== 'notice.queue.dispatched' || !message.sessionId) return null;
  const record = state.sessions.find(s => s.id === message.sessionId);
  return record?.archived ? record : null;
}
function readingOwnText(message, descriptor) {
  const language = ui.language.getSnapshot().active;
  const archived = readingDispatchMember(message, descriptor);
  if (archived) return uiText(descriptor.key, { ...descriptor.params, name: archivedName(archived, descriptor.params.name) });
  if (['notice.capacityAutoContinueRouting', 'notice.capacityAutoContinueCapacity', 'notice.capacityAutoContinueForbidden', 'notice.capacityAutoContinueConnection'].includes(descriptor.key) && Number.isFinite(message.time) && Math.abs(message.time) <= 8640000000000000) {
    const time = new Date(message.time).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
    return uiText(descriptor.key, { ...descriptor.params, time });
  }
  return window.nativeWorkspaceLocale.displayText(language, message.text, descriptor);
}
function nativeCompletionText(message) {
  // A machine-injected input may carry a short display summary; its original text stays in the record.
  if (message.kind !== 'turn') return message.role === 'user' && typeof message.displayText === 'string' && message.displayText ? message.displayText : message.text;
  // Earlier releases invented these completion sentences. Keep native error
  // details, but do not translate or reconstruct a missing TUI footer from time.
  const text = (message.text || '').replace(/^原生(?:本轮已结束|已中断本轮|本轮未正常完成)(?: · [^\n]*)?(?:\n|$)/, '');
  return text.trim() ? text : ['interrupted', 'failed'].includes(message.status) ? message.status : '';
}
// Native 0.164 exploration semantics; never classify the shell command string.
function nativeExploration(message) {
  const actions = message.commandActions;
  return message.toolKind === 'commandExecution' && message.nativeId && message.turnId && !message.incomplete &&
    message.commandSource !== 'userShell' && Array.isArray(actions) && actions.length && actions.every(a => a && ['read', 'listFiles', 'search'].includes(a.type) && typeof a.command === 'string');
}
function commandExplorations(messages, room = false, originals = messages) {
  const indices = new Map(originals.map((m, index) => [m.id, index]));
  const groups = new Map(); let group, previousKey, previousIndex;
  for (const message of messages) {
    const eligible = nativeExploration(message);
    const key = JSON.stringify([message.nativeId, message.turnId, message.displayTurnId, message.sessionId, message.inputTag, message.promptId, message.sourceTag, message.replyTo, message.sharingStopped,
      room ? Number.isFinite(message.time) ? new Date(message.time).toLocaleDateString() : '' : '']);
    if (!eligible) { group = null; previousKey = null; continue; }
    if (!group || key !== previousKey || indices.get(message.id) !== previousIndex + 1) { group = { messages: [] }; groups.set(message.id, group); }
    group.messages.push(message); previousKey = key; previousIndex = indices.get(message.id);
    if (message.status === 'interrupted') { group = null; previousKey = null; }
  }
  for (const group of groups.values()) {
    const lines = [], counts = new Map(), exits = new Set(); let reads = [];
    const flush = () => { if (reads.length) lines.push('Read ' + [...new Set(reads)].join(', ')); reads = []; };
    for (const message of group.messages) {
      const actions = message.commandActions, nativeExit = Number.isSafeInteger(message.exitCode) && message.exitCode !== 0;
      for (const action of actions) counts.set(action.type, (counts.get(action.type) || 0) + 1);
      if (nativeExit) exits.add(message.exitCode);
      // Native marks all nonzero exits failed. Exploration keeps its native exit
      // annotation compact; a search exit1 can simply mean no matches.
      const error = ['failed', 'declined', 'interrupted', 'unconfirmed'].includes(message.status) && !(message.status === 'failed' && nativeExit) ? message.status : '';
      group.error ||= error;
      if (!error && !message.exitCode && actions.every(a => a.type === 'read')) { reads.push(...actions.map(a => a.name)); continue; }
      flush();
      for (const action of actions) lines.push(action.type === 'read' ? 'Read ' + action.name : action.type === 'listFiles' ? 'List ' + (action.path ?? action.command)
        : 'Search ' + (action.query === null ? action.command : action.query + (action.path === null ? '' : ' in ' + action.path)));
      if (message.exitCode) lines[lines.length - 1] += ` (${actions.length > 1 ? 'command exit' : 'exit'} ${message.exitCode})`;
      if (error) lines[lines.length - 1] += ' (' + error + ')';
    }
    flush(); group.summary = lines.join('\n'); group.active = group.messages.some(m => ['running', 'streaming'].includes(m.status));
    group.counts = Object.fromEntries(counts);
    group.captionRead = () => [...counts].map(([type, count]) => uiText({ read: 'process.read', search: 'process.search', listFiles: 'process.list' }[type], { count })).concat([...exits].map(code => `exit ${code}`)).join(' · ');
    group.caption = group.captionRead();
  }
  return groups;
}
// Group only observed native process records, never reconstructed terminal text.
function nativeProcessGroups(messages, room = false, originals = messages, sessions = [], explorations = commandExplorations(messages, room, originals)) {
  const indices = new Map(), duplicates = new Set(), ended = new Set();
  const turnKey = m => JSON.stringify([m.nativeId, m.turnId, room ? m.sessionId : null]);
  originals.forEach((m, i) => {
    if (indices.has(m.id)) duplicates.add(m.id); indices.set(m.id, i);
    if ((m.nativeBlock || m.sharedStream) && m.kind === 'turn' && ['complete', 'failed', 'interrupted'].includes(m.status)) ended.add(turnKey(m));
  });
  const eligible = m => typeof m.id === 'string' && `process:${m.id}`.length <= 100 && !duplicates.has(m.id) && indices.has(m.id) &&
      (m.nativeBlock === true || m.sharedStream === true) && typeof m.nativeId === 'string' && m.nativeId && typeof m.turnId === 'string' && m.turnId &&
      (m.role === 'tool' && m.kind === 'tool' || m.role === 'assistant' && m.kind === 'summary' && typeof m.text === 'string' && m.text.trim()) &&
      !m.incomplete && !m.sharingStopped && !(Array.isArray(m.images) && m.images.length) && m.commandSource !== 'userShell' && m.status !== 'unconfirmed' &&
      ['running', 'streaming', 'complete', 'failed', 'declined', 'interrupted'].includes(m.status) &&
      (!room || m.sharedStream === true && typeof m.nativeMessageId === 'string' && m.nativeMessageId &&
        typeof m.sourceTag === 'string' && m.sourceTag && m.sessionId && Number.isFinite(m.time) && Math.abs(m.time) <= 8640000000000000);
  // T29 nests its original members together. Never wrap just its eligible
  // prefix: that would hide an uncertain sibling and undercount the contents.
  const excluded = new Set();
  for (const exploration of explorations.values()) if (exploration.messages.some(m => !eligible(m))) {
    for (const m of exploration.messages) excluded.add(m.id);
  }
  const groups = new Map(); let group, previousKey, previousIndex;
  for (const m of messages) {
    const index = indices.get(m.id), id = `process:${m.id}`, allowed = eligible(m) && !excluded.has(m.id);
    const key = JSON.stringify([m.nativeId, m.turnId, m.displayTurnId, m.sessionId, m.inputTag, m.promptId, m.sourceTag, m.replyTo, m.sharingStopped,
      room && allowed ? new Date(m.time).toLocaleDateString() : '']);
    if (!allowed) { group = null; previousKey = null; continue; }
    if (!group || key !== previousKey || index !== previousIndex + 1) { group = { id, messages: [] }; groups.set(id, group); }
    group.messages.push(m); previousKey = key; previousIndex = index;
    if (m.status === 'interrupted') { group = null; previousKey = null; }
  }
  for (const group of groups.values()) {
    const first = group.messages[0], counts = new Map(), outcomes = new Map(), exits = new Set();
    const source = sessions.find(s => s.nativeId === first.nativeId && (!room || s.id === first.sessionId));
    group.active = !ended.has(turnKey(first)) && !group.messages.some(m => m.status === 'interrupted') && Boolean(source &&
      !source.transportDisconnected && !source.backendUnavailable && source.activeTurnId === first.turnId && ['working', 'approval'].includes(source.state));
    for (const m of group.messages) {
      const label = m.kind === 'summary' ? 'process.summary' : m.toolKind === 'commandExecution' || m.title === 'Bash' ? 'process.command'
        : m.title === 'Read' ? 'process.read' : m.toolKind === 'webSearch' || ['Grep', 'Glob'].includes(m.title) ? 'process.search' : 'process.tool';
      counts.set(label, (counts.get(label) || 0) + 1);
      // Keep T29's native nonzero exploration annotation, including search exit1.
      if (m.status === 'failed' && nativeExploration(m) && Number.isSafeInteger(m.exitCode) && m.exitCode !== 0) exits.add(m.exitCode);
      else if (['failed', 'declined', 'interrupted'].includes(m.status)) outcomes.set(m.status, (outcomes.get(m.status) || 0) + 1);
    }
    group.captionRead = () => [...counts].map(([key, count]) => uiText(key, { count })).join(' · ');
    group.caption = group.captionRead();
    group.outcomeRead = () => ['failed', 'declined', 'interrupted'].filter(status => outcomes.has(status)).map(status => uiText('process.' + status, { count: outcomes.get(status) }))
      .concat([...exits].map(code => `exit ${code}`)).join(' · ');
    group.outcome = group.outcomeRead();
  }
  return groups;
}
function nativeCommandPreview(message) {
  const actions = message.commandActions, original = message.input || message.title || '';
  if (Array.isArray(actions) && actions.length === 1) return actions[0].command;
  // A simple literal shlex launch wrapper can be removed without reconstructing
  // compound operators from actions. Ambiguous quoting remains verbatim.
  const literal = /^\/bin\/(?:zsh|bash) -lc '([^']*)'$/.exec(original);
  return literal ? literal[1] : original;
}
function updateProcessTail(entry) {
  const m = entry.message, open = entry.disclosure.open;
  // An open outer disclosure must not hide a closed original row's preview.
  entry.preview.style.display = open ? 'none' : 'inline';
  if (entry.exploration) {
    entry.tail.hidden = open;
    ui.display.computed(entry.tail, 'text', () => entry.exploration.captionRead ? entry.exploration.captionRead() : entry.exploration.caption);
    entry.more.hidden = true; return;
  }
  // Like the native TUIs: a folded command keeps two one-line rows of output (the
  // newest while it runs, the first once done) and says how many more there are.
  const lines = m.role === 'tool' && !open && m.text ? m.text.replace(/\n+$/, '').split('\n') : [];
  const shown = ['running', 'streaming'].includes(m.status) ? lines.slice(-2) : lines.slice(0, 2), more = lines.length - shown.length, tail = shown.join('\n');
  ui.display.unbind(entry.tail); entry.tail.hidden = !tail; if (entry.tail.textContent !== tail) entry.tail.textContent = tail;
  entry.more.hidden = !more; ui.display.computed(entry.more, 'text', () => uiText('reading.moreLines', { count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(more) }));
}
function processGroupRows(view, rows, plans, explorations, room, key) {
  const membership = new Map(), members = new Map(), retained = new Set(), output = [];
  for (const plan of plans.values()) for (const m of plan.messages) membership.set(m.id, plan);
  for (const row of rows) {
    const plan = membership.get(row.dataset.messageId);
    if (!plan) { output.push(row); continue; }
    let group = view.groups.get(plan.id);
    if (!group) {
      const item = node('section'), disclosure = node('details'), summary = node('summary'), heading = node('div', undefined, 'message-heading');
      const author = node('strong'), caption = node('span'), outcome = node('span'), content = node('div');
      author.style.cssText = 'flex:0 1 auto;max-width:30%;overflow:hidden;text-overflow:ellipsis';
      caption.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis';
      outcome.style.cssText = 'flex:0 1 auto;min-width:0;max-width:65%;overflow:hidden;text-overflow:ellipsis;color:var(--warning,#9a6700)';
      const latest = node('p', undefined, 'process-latest'); latest.hidden = true;
      heading.append(author, caption, outcome); summary.append(heading); disclosure.append(summary, content); item.append(disclosure, latest);
      item.dataset.messageId = plan.id; item.dataset.processGroup = plan.id;
      group = { item, disclosure, summary, author, caption, outcome, content, latest }; view.groups.set(plan.id, group);
      const remember = () => {
        if (!group.effective || view.key !== key) return;
        // A manual close after search is still a new reading intent even if
        // the saved choice was already closed before the automatic reveal.
        view.intent = null; delete view.folds[plan.id]; view.folds[plan.id] = disclosure.open;
        for (const id of Object.keys(view.folds).slice(0, Math.max(0, Object.keys(view.folds).length - 200))) delete view.folds[id];
        captureReading(view); saveReading(view, { ...(readingPositions[key] || { top: view.el.scrollTop, anchor: plan.id, offset: 0 }), follow: false });
        attempt(() => api.readingState(readingPositions));
      };
      summary.addEventListener('click', event => {
        if (event.target.closest('button,a,input')) return;
        event.preventDefault(); group.expectedOpen = !disclosure.open; disclosure.open = group.expectedOpen; remember();
      });
      disclosure.addEventListener('toggle', () => {
        if (group.expectedOpen === disclosure.open) { group.expectedOpen = undefined; return; }
        group.expectedOpen = undefined; remember();
      });
    }
    if (!retained.has(plan.id)) { retained.add(plan.id); members.set(plan.id, []); output.push(group.item); }
    members.get(plan.id).push(row);
  }
  for (const [id, children] of members) {
    const group = view.groups.get(id), plan = plans.get(id), first = plan.messages[0];
    const exploration = explorations.get(first.id);
    // One original process row, or one existing T29 exploration, already has
    // its own disclosure. Keep the stable wrapper but add no duplicate title.
    group.effective = plan.messages.length > 1 && exploration?.messages.length !== plan.messages.length;
    group.item.className = group.effective ? 'message process' : '';
    group.disclosure.className = group.effective ? 'process-details' : '';
    group.content.className = group.effective ? 'process-content' : '';
    group.summary.hidden = !group.effective;
    group.item.dataset.running = String(plan.active);
    const author = () => room ? roomMessageLabel(first) : first.name || (view.session?.provider === 'claude' ? 'Claude' : view.session?.provider === 'dsh' ? 'DSH' : view.session?.provider === 'agy' ? 'Antigravity' : view.session?.provider === 'pi' ? 'pi' : 'Codex');
    const caption = () => plan.captionRead ? plan.captionRead() : plan.caption, outcome = () => plan.outcomeRead ? plan.outcomeRead() : plan.outcome;
    ui.display.computed(group.author, 'text', author); ui.display.computed(group.caption, 'text', caption); ui.display.computed(group.outcome, 'text', outcome);
    const summary = () => `${author()} · ${plan.active ? uiText('process.active') : ''}${caption()}${outcome() ? ' · ' + outcome() : ''}`;
    ui.display.computed(group.summary, 'aria-label', summary); ui.display.computed(group.summary, 'title', summary);
    const position = view.intent?.position, selection = window.getSelection();
    const reading = group.disclosure.open && (selection && !selection.isCollapsed && group.item.contains(selection.anchorNode) ||
      position && !position.follow && (position.anchor === id || plan.messages.some(m => m.id === position.anchor)));
    const query = room ? $('room-search').value.trim().toLocaleLowerCase() : '';
    const reveal = query && plan.messages.some(m => [m.text, m.input].some(text => text?.toLocaleLowerCase().includes(query)));
    const choice = view.folds[id], saved = typeof choice === 'boolean' ? choice : choice?.open;
    const open = !group.effective || Boolean(saved !== undefined ? saved : reading || reveal);
    if (group.disclosure.open !== open) { group.expectedOpen = open; group.disclosure.open = open; }
    const last = view.entries.get(plan.messages.at(-1).id);
    const latestText = (last?.exploration ? last.tail.textContent : last?.preview?.textContent) || last?.heading?.querySelector(':scope > span:not(.process-label)')?.textContent || '';
    if (group.latest.textContent !== latestText) { group.latest.textContent = latestText; group.latest.title = latestText; }
    group.latest.hidden = !group.effective || !plan.active || open || !latestText;
    let cursor = group.content.firstChild;
    for (const child of children) { if (child === cursor) cursor = cursor.nextSibling; else group.content.insertBefore(child, cursor); }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  for (const [id, group] of view.groups) if (!retained.has(id)) { group.item.remove(); view.groups.delete(id); }
  return output;
}
// Only the current paging callback owns a complete source history. Define it
// outside messageList so retained row callbacks cannot share its closure and
// keep one old full snapshot per row after subsequent IPC updates.
function readingReload(view, el, messages, room, key, context) {
  return () => { if (view.key === key && el.isConnected) messageList(el, messages, room, key, context); };
}
function messageList(el, messages, room = false, key = 'room', context = {}) {
  // A member reader observes its own session without selecting it or claiming
  // its input. Existing solo/shared callers retain their original context.
  const session = context.session || (room ? null : current()), sourceMessages = messages;
  // Row labels need these scalar facts, never the session's full message array.
  const sessionName = session?.name, sessionProvider = session?.provider;
  const view = readingView(el, key, room);
  view.session = session;
  const selection = window.getSelection(), selected = selection && !selection.isCollapsed && el.contains(selection.anchorNode)
    ? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset } : null;
  captureReading(view);
  const intent = { position: readingPositions[key] || { top: 0, follow: true, anchor: '', offset: 0 } };
  view.intent = intent;
  let rows = []; const retained = new Set(), days = new Set(), originals = room ? state.room.messages : session?.messages || messages;
  messages = messages.filter(m => !(m.kind === 'turn' && !nativeCompletionText(m)?.trim() && !readingTurnFooter(m)) &&
    !(m.kind === 'summary' && !m.text?.trim() && !m.incomplete && !['failed', 'interrupted'].includes(m.status)));
  const explorations = commandExplorations(messages, room, originals), groups = nativeProcessGroups(messages, room, originals, room ? state.sessions : session ? [session] : [], explorations); let lastDay = '';
  view.paged = true;
  view.pageData = readingPageData(messages, [...explorations.values(), ...groups.values()]);
  const active = document.activeElement, pinned = Boolean(selected || active && el.contains(active) && active.closest('[data-message-id]'));
  const range = readingPageRange(view.pageData, view.pageRange, view.pageRequest, intent.position, pinned);
  // Removing an old top row triggers browser scroll anchoring before our next
  // frame. It is layout, not a human scroll that revokes the follow/anchor.
  // While following, any render can do the same: rows moved into a fold or a
  // reply re-laid out leave the content briefly shorter, the browser clamps the
  // position, and that scroll arrives before the follow frame (T-134). The
  // person's own wheel, pointer or key input clears this at once (interact).
  // Only a render that changes this reader's rows can do that; a column drawn
  // again unchanged keeps every scroll, including a screen reader's.
  const contentKey = readingContentKey(messages.slice(range.start, range.end)), contentChanged = contentKey !== view.contentKey;
  view.contentKey = contentKey;
  if ((view.pageRange?.firstId !== range.firstId || view.pageRange?.lastId !== range.lastId || intent.position.follow && contentChanged && followRenderGuard(view))) view.pageChanging = true;
  view.pageRange = range; view.pageRequest = null;
  const turnMarks = readingTurnMarks(messages.slice(range.start, range.end), room, originals);
  view.reload = readingReload(view, el, sourceMessages, room, key, context);
  view.loadMessage = id => {
    if (view.key !== key || !el.isConnected || view.loadingPage || !view.pageData.indices.has(id)) return false;
    if (readingEntry(view, id)) return true;
    const pending = view.intent;
    view.pageRequest = { action: 'target', id }; view.pageChanging = true; view.loadingPage = true;
    try { view.reload(); } finally { view.loadingPage = false; }
    view.intent = pending;
    return Boolean(readingEntry(view, id));
  };
  for (const m of messages.slice(range.start, range.end)) {
    if (room) {
      const day = Number.isFinite(m.time) && Math.abs(m.time) <= 8640000000000000 ? new Date(m.time).toLocaleDateString() : '时间未记录';
      if (day !== lastDay) {
        let divider = view.days.get(day); if (!divider) {
          divider = node('div', undefined, 'timeline-day');
          ui.display.computed(divider, 'text', () => Number.isFinite(m.time) && Math.abs(m.time) <= 8640000000000000 ? new Date(m.time).toLocaleDateString(ui.language.getSnapshot().active) : uiText('reading.unknownTime'));
          view.days.set(day, divider);
        }
        rows.push(divider); days.add(day); lastDay = day;
      }
    }
    const wake = readingWakeIntent(m, room, session);
    let entry = view.entries.get(m.id);
    if (!entry) {
      const item = node('article'), heading = node('div', undefined, 'message-heading'), body = node('div', undefined, 'message-body'), actions = node('div', undefined, 'message-actions');
      body.id = `reading-payload-${++readingPayloadId}`;
      item.dataset.messageId = m.id; item.append(heading, body, actions);
      entry = { item, heading, body, actions }; view.entries.set(m.id, entry);
      if (m.kind === 'operator-open' && m.operator) {
        const details = node('details', undefined, 'operator-task-details');
        details.append(uiNode('summary', 'operator.card.task'), body); heading.after(details);
        entry.operatorTask = details;
      }
      if ((wake || m.role === 'tool' || m.kind === 'summary') && (m.role === 'tool' || !(Array.isArray(m.images) && m.images.length))) {
        const disclosure = node('details', undefined, 'process-details'), summary = node('summary'), content = node('div', undefined, 'process-content');
        entry.wakeDisclosure = Boolean(wake); entry.disclosure = disclosure; entry.preview = node('span', undefined, 'process-label'); entry.tail = node('pre', undefined, 'process-tail'); entry.content = content;
        entry.more = node('button', undefined, 'process-more'); entry.more.type = 'button';
        summary.append(heading); content.append(body); disclosure.append(summary, content); item.replaceChildren(disclosure, entry.tail, entry.more, actions);
        const rememberFold = () => {
          cancelReadingWakeCollapse(entry);
          if (entry.wakeDisclosure) delete entry.item.dataset.searchTarget;
          updateProcessTail(entry);
          if (view.key !== key) return;
          // A manual choice belongs to this source record, not its latest status.
          view.intent = null; delete view.folds[m.id]; view.folds[m.id] = disclosure.open;
          for (const id of Object.keys(view.folds).slice(0, Math.max(0, Object.keys(view.folds).length - 200))) delete view.folds[id];
          captureReading(view); saveReading(view, { ...(readingPositions[key] || { top: el.scrollTop, anchor: m.id, offset: 0 }), follow: false });
          attempt(() => api.readingState(readingPositions));
        };
        summary.addEventListener('click', event => {
          if (event.target.closest('button,a,input')) return;
          event.preventDefault(); entry.expectedOpen = !disclosure.open; disclosure.open = entry.expectedOpen; rememberFold();
        });
        entry.more.onclick = () => { entry.expectedOpen = true; disclosure.open = true; rememberFold(); };
        disclosure.addEventListener('toggle', () => {
          if (entry.expectedOpen === disclosure.open) { entry.expectedOpen = undefined; return; }
          entry.expectedOpen = undefined; rememberFold();
        });
      }
      entry.copyText = button('', () => copyReadingMessage(entry)); actions.append(entry.copyText);
      entry.share = button('', () => share(entry.message.text)); actions.append(entry.share);
      for (const action of [entry.copyText, entry.share]) {
        action.setAttribute('aria-controls', body.id);
        const highlight = () => body.classList.add('copy-payload');
        const clear = () => { if (!actions.matches(':hover') && !actions.contains(document.activeElement)) body.classList.remove('copy-payload'); };
        action.addEventListener('pointerenter', highlight); action.addEventListener('focus', highlight);
        action.addEventListener('pointerleave', clear); action.addEventListener('blur', clear);
      }
      actions.addEventListener('pointerleave', () => { if (!actions.contains(document.activeElement)) body.classList.remove('copy-payload'); });
      if (room) {
        entry.reply = button('', () => openThread(entry.message.id)); actions.append(entry.reply);
        entry.delivery = node('details', undefined, 'message-delivery');
        entry.deliverySummary = node('summary'); entry.deliveryBody = node('div', undefined, 'delivery-body');
        entry.deliveryRows = new Map(); entry.deliveryNote = node('p'); entry.deliveryBody.append(entry.deliveryNote);
        entry.delivery.append(entry.deliverySummary, entry.deliveryBody); (entry.content || item).append(entry.delivery);
        entry.openRecipient = button('', () => {
          if (!state.sessions.some(s => s.id === entry.openSessionId)) return toast(uiText('reading.unavailable'));
          return select(entry.openSessionId, 'chat');
        }, 'message-session-link');
        ui.display.text(entry.openRecipient, 'reading.viewSession');
        entry.context = button('', () => {
          $('room-search').value = ''; $('room-filter').value = ''; renderTimeline();
          const original = view.entries.get(m.id)?.item;
          if (original) {
            // Newly unfiltered Markdown above this row can still be mounting.
            // Keep the explicit target anchored until the reader interacts.
            const position = { top: el.scrollTop, follow: false, anchor: m.id, offset: 16 };
            view.intent = { position }; saveReading(view, position); scheduleReading(view);
            revealProcessAncestors(view, view.entries.get(m.id));
            original.tabIndex = -1; original.focus({ preventScroll: true });
          }
          attempt(persistView);
        }); ui.display.text(entry.context, 'reading.context'); actions.append(entry.context);
        // Last, so it stays put when the row's other actions appear.
        actions.append(entry.openRecipient);
      }
    }
    if (entry.wakeDisclosure && !wake) {
      cancelReadingWakeCollapse(entry);
      entry.item.replaceChildren(...[entry.heading, entry.inputBody, entry.body, entry.actions].filter(Boolean));
      for (const field of ['disclosure', 'content', 'preview', 'tail', 'more', 'wakeDisclosure']) delete entry[field];
    }
    entry.message = m; entry.exploration = explorations.get(m.id); retained.add(m.id); rows.push(entry.item);
    entry.item.className = `message ${m.role}${m.kind === 'turn' ? ' native-turn' : ''}${entry.disclosure ? ' process' : ''}${room && readingSpaceMessageKind(m) ? ' space-message' : ''}`;
    if (m.operator || entry.operatorControls) renderOperatorControls(entry, m, context);
    if (m.backgroundOperation || entry.backgroundControls) renderBackgroundControls(entry, m);
    entry.item.classList.toggle('native-notice', Boolean(m.role === 'system' && (['notice', 'gap', 'context'].includes(m.kind) || !room && session?.nativeContexts?.some(c => c.boundaryId === m.id))));
    const nativeTitle = entry.exploration ? entry.exploration.active ? 'Exploring' : 'Explored' : m.toolKind === 'commandExecution' ? ['running', 'streaming'].includes(m.status) ? 'Running' : m.commandSource === 'userShell' ? 'You ran' : 'Ran' : m.kind === 'summary' && m.title === '过程摘要' || m.kind === 'plan' && m.title === '计划' || m.toolKind === 'webSearch' && ['搜索网页', '打开网页', '页内查找'].includes(m.title) || m.toolKind === 'fileChange' && m.title === '文件修改' ? '' : m.title;
    const nawTool = readingNawTool(m);
    const readMessageName = () => {
      if (wake) {
        const target = state.sessions.find(s => s.id === wake.recipientId);
        const recipient = target ? participantLabel(target, state.sessions) : wake.recipientId;
        return `${wake.senderName || sessionName || wake.senderId} → ${recipient}${recipient === wake.recipientId ? '' : ' · ' + wake.recipientId}`;
      }
      if (m.nativeBlock && m.kind === 'input' && m.inputMode === 'native-inline') return uiText('reading.nativeSession');
      if (!room && m.commandSource === 'userShell') return uiText('reading.you'); // the person's own `!` command
      if (!room && m.role === 'system' && !m.sessionId) return ui.displayText(m.name, m.uiNameMessage) || uiText('reading.nativeSession');
      // NAW waking the butler (steward-wake.cjs) goes out as a NAW message like a queue item; said as what it is.
      if (!room && m.origin === 'naw-dispatch' && typeof m.dispatchItem === 'string' && m.dispatchItem.startsWith('steward-wake:')) return uiText('reading.stewardWake');
      if (!room && m.origin === 'naw-dispatch' && typeof m.dispatchItem === 'string' && m.dispatchItem.startsWith('steward-patrol:')) return uiText('reading.stewardPatrol');
      return (room ? roomMessageLabel(m) : ui.displayText(m.name, m.uiNameMessage)) || (m.role === 'user' ? uiText('reading.you') : sessionProvider === 'claude' ? 'Claude' : sessionProvider === 'dsh' ? 'DSH' : sessionProvider === 'pi' ? 'pi' : 'Codex');
    };
    // Heading/action bindings share this synchronous author resolution. Release
    // it before painting content so retained getters stay live if painting fails.
    let drawnName = readMessageName();
    const messageName = () => { return drawnName ?? readMessageName(); };
    const name = drawnName;
    const messageTime = readingMessageClock(m);
    const spaceStatus = readingSpaceMessageStatus(m, room);
    const snapshotSource = room && m.snapshotSource && state.room.merge?.sources.find(source => source.id === m.snapshotSource.roomId);
    const snapshotName = snapshotSource ? mergeSourceLabel(snapshotSource, state.room.merge.sources) : '';
    const ownGap = m.kind === 'gap' && m.role === 'system' && Boolean(readingOwnMessage(m));
    // In a space's record, a row a session wrote (its reply or tool row) carries that session's vendor mark
    // before its name. NAW's own rows (dispatch, join, pause notices) name a session but were not written by it.
    const maker = room && (m.role === 'assistant' || m.role === 'tool') && m.sessionId ? state.sessions.find(x => x.id === m.sessionId) : null, makerMark = maker ? sessionMaker(maker) : null;
    const headingKey = JSON.stringify([ownGap, makerMark && [makerMark.vendor, makerMark.shell], name, m.uiNameMessage, m.uiTitleMessage, m.legacyOriginalTitleUiMessage, m.status, messageTime, spaceStatus, m.manualReply, nativeTitle, entry.exploration?.error, m.exitCode, m.incomplete, m.volatile, m.sharingStopped, m.sharingStoppedUiMessage, snapshotName]);
    if (entry.headingKey !== headingKey) {
      const authorId = room && (m.sessionId || m.recipientId);
      const author = authorId ? button(name, () => { $('room-filter').value = authorId; renderTimeline(); attempt(persistView); }, 'message-author') : node('strong', name);
      ui.display.computed(author, 'text', messageName);
      if (authorId) {
        const label = () => uiText('reading.trajectory', { author: messageName() });
        ui.display.computed(author, 'title', label); ui.display.computed(author, 'aria-label', label);
      }
      entry.heading.replaceChildren(author); entry.headingKey = headingKey;
      if (maker) {
        const mark = icon(maker, true); mark.setAttribute('role', 'img');
        ui.display.computed(mark, 'aria-label', () => makerLabel(maker)); ui.display.computed(mark, 'title', () => makerLabel(maker));
        entry.heading.prepend(mark);
      }
      if (snapshotSource) {
        const source = button('', () => {
          openSearch('all'); return openSearchResult({ kind: 'shared', roomId: m.snapshotSource.roomId, messageId: m.snapshotSource.messageId });
        }, 'snapshot-source');
        ui.display.text(source, 'reading.snapshotSource', { name: snapshotName });
        ui.display.attribute(source, 'aria-label', 'reading.snapshotSourceAction', { name: snapshotName }); entry.heading.append(source);
      }
      if (nativeTitle) {
        const title = node('span'), message = window.nativeWorkspaceLocale.displayMessage(m.uiTitleMessage, 'notice.');
        if (nawTool) ui.display.text(title, 'reading.nawTool.' + nawTool.tool);
        else if (message && message.key === 'notice.legacyTitle' && ['last', 'old'].includes(message.params.status)) ui.display.text(title, message.key, () => ({ title: ui.displayText(m.legacyOriginalTitle, m.legacyOriginalTitleUiMessage) || message.params.title || uiText('notice.legacyNative'), status: uiText(message.params.status === 'last' ? 'notice.legacyLast' : 'notice.legacyOld') }));
        else if (message && message.key !== 'notice.legacyTitle' && window.nativeWorkspaceLocale.displayMessage(message, 'notice.', nativeTitle)) ui.display.text(title, message.key, message.params); else title.textContent = nativeTitle;
        entry.heading.append(title);
      }
      if (m.incomplete) { const label = node('span'); ui.display.text(label, 'reading.incomplete'); entry.heading.append(label); }
      if (m.volatile && !entry.disclosure) { const label = node('span'); ui.display.text(label, (m.nativeMessageId || m.id || '').startsWith(`native:${m.nativeId}:tool:`) ? 'reading.tool' : 'reading.runRecord'); entry.heading.append(label); }
      if (m.sharingStopped) { const label = node('span'); ui.display.text(label, 'reading.sharingStopped', () => ({ reason: ui.displayText(m.sharingStopped, m.sharingStoppedUiMessage) })); entry.heading.append(label); }
      if (messageTime) {
        const time = node('time'); time.dateTime = messageTime.dateTime;
        ui.display.computed(time, 'text', () => readingDisplayClock(m).text);
        const label = () => uiText('reading.recordedAt', { time: readingDisplayClock(m).full });
        ui.display.computed(time, 'title', label); ui.display.computed(time, 'aria-label', label); entry.heading.append(time);
      } else if (spaceStatus) {
        const unknown = node('span', undefined, 'quiet'); ui.display.text(unknown, 'reading.unknownTime'); entry.heading.append(unknown);
      }
      if (spaceStatus) { const fact = node('span', undefined, 'space-message-status'); ui.display.text(fact, spaceStatus); entry.heading.append(fact); }
      // A stored fragment is not proof that its native turn is still running.
      // Current activity lives in the session/progress status, not this record.
      const status = readingMessageStatusKey(m, room, session);
      delete entry.wakeLabel;
      if (wake) { entry.wakeLabel = node('span'); entry.heading.append(entry.wakeLabel); }
      else if (entry.exploration) { if (entry.exploration.error) entry.heading.append(node('span', entry.exploration.error)); }
      else if (status && (ownGap || !m.nativeBlock && !m.sharedStream)) { const label = node('span'); ui.display.text(label, status); entry.heading.append(label); }
      else if ((m.nativeBlock || m.sharedStream) && ['failed', 'declined', 'interrupted', 'unconfirmed'].includes(m.status)) entry.heading.append(node('span', m.status));
      else if (m.manualReply && m.status === 'submitted') { const label = node('span'); ui.display.text(label, 'reading.manualReply'); entry.heading.append(label); }
      if (m.toolKind === 'commandExecution' && !entry.exploration && m.exitCode) entry.heading.append(node('span', 'exit ' + m.exitCode));
      if (entry.preview) entry.heading.append(entry.preview);
    }
    // Capture this original row's label function for an in-flight copy. A later
    // streaming row can replace entry.copyLabel, but cannot retarget that copy.
    entry.copyLabel = () => readingActionLabel(m, messageName());
    ui.display.computed(entry.copyText, 'aria-label', () => uiText('reading.copyAction', { label: readingActionLabel(m, messageName()) }));
    ui.display.computed(entry.share, 'aria-label', () => uiText('reading.shareAction', { label: readingActionLabel(m, messageName()) }));
    drawnName = null;
    // Keep tools' original disclosure and source IDs. The toolbar belongs to
    // this heading, rather than floating over the next record's content.
    if ((wake || m.role !== 'system') && entry.actions.parentElement !== entry.heading) entry.heading.append(entry.actions);
    if (wake && entry.wakeLabel) ui.display.computed(entry.wakeLabel, 'text', () => uiText(readingWakeStatus(entry.message.wake)));
    updateReadingWake(view, entry, wake);
    if (entry.disclosure) {
      const error = entry.exploration ? entry.exploration.error : m.incomplete ? 'incomplete' : ['failed', 'declined', 'interrupted', 'unconfirmed'].includes(m.status) ? m.status : '';
      entry.error = error;
      const query = room ? $('room-search').value.trim() : '';
      const reveal = query && [m.text, m.input].some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const choice = view.folds[m.id];
      const savedOpen = typeof choice === 'boolean' ? choice : choice?.open;
      const failedTool = m.role === 'tool' && (m.status === 'failed' || entry.exploration?.error === 'failed');
      const searchReveal = wake && entry.item.dataset.searchTarget === 'true';
      // Missing media is still announced in the heading; it must not force a
      // complete tool log open. Manual choices and search retain precedence.
      const open = Boolean(searchReveal || (savedOpen !== undefined ? savedOpen : reveal || (wake ? entry.wakeExpanded || entry.disclosure.open && readingWakeHeld(view, entry) : error && !failedTool && !(m.role === 'tool' && m.incomplete))));
      if (entry.disclosure.open !== open) { entry.expectedOpen = open; entry.disclosure.open = open; }
      entry.item.dataset.running = String(entry.exploration ? entry.exploration.active : ['running', 'streaming'].includes(m.status));
      let inputPreview = m.input;
      if (inputPreview?.trim().startsWith('{')) {
        try { const value = JSON.parse(inputPreview); inputPreview = [value.command, value.description, value.file_path, value.path, value.query].find(field => typeof field === 'string' && field.trim()) || inputPreview; }
        catch { /* The expandable original remains authoritative. */ }
      }
      const preview = wake ? '' : (failedTool && !entry.exploration && m.toolKind !== 'commandExecution' && m.title !== 'Bash' && m.text?.trim() ? m.text : entry.exploration || m.toolKind === 'webSearch' ? '' : m.toolKind === 'commandExecution' ? nativeCommandPreview(m) : inputPreview || m.text || '').split(/\r?\n/).find(line => line.trim()) || '';
      if (nawTool && !failedTool) ui.display.computed(entry.preview, 'text', () => readingNawToolPreview(nawTool));
      else { ui.display.unbind(entry.preview); if (entry.preview.textContent !== preview) entry.preview.textContent = preview; }
      updateProcessTail(entry);
    }
    entry.share.hidden = context.passive === true || m.role === 'system';
    if (entry.reply) {
      entry.reply.dataset.replyTo = m.id;
      const root = roomThreads.roots.get(m.id), count = roomThreads.groups.get(root)?.length || 1;
      entry.reply.hidden = m.role === 'system';
      ui.display.computed(entry.reply, 'text', () => count > 1 ? uiText('reading.responses', { count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(count) }) : uiText('reading.respond'));
    }
    if (entry.delivery) {
      entry.delivery.hidden = m.role === 'system';
      const deliveries = (m.deliveries || []).map(d => {
        const recipient = state.sessions.find(s => s.id === d.recipientId);
        return { ...d, label: m.snapshotBatch ? historicalParticipantLabel(d.recipientName, d.recipientId) : recipient ? participantLabel(recipient, state.sessions) : historicalParticipantLabel(d.recipientName, d.recipientId) };
      });
      const deliveryKey = JSON.stringify([m.deliveryTracked, deliveries, Boolean(m.snapshotBatch), m.imageReceipt]);
      if (entry.deliveryKey !== deliveryKey) {
        entry.deliveryKey = deliveryKey;
        const status = d => uiText(readingDeliveryStatusKey(m, d));
        ui.display.computed(entry.deliverySummary, 'text', () => deliveries.length
          ? uiText(m.snapshotBatch ? 'delivery.snapshotSummary' : 'delivery.summary', { recipients: deliveries.map(d => uiText('delivery.recipient', { recipient: d.label, status: status(d) })).join(ui.language.getSnapshot().active === 'zh' ? '；' : '; ') })
          : uiText(m.snapshotBatch ? 'delivery.snapshotNone' : m.deliveryTracked ? 'delivery.none' : 'delivery.legacy'));
        const retainedDeliveries = new Set();
        for (const d of deliveries) {
          let row = entry.deliveryRows.get(d.id);
          if (!row) {
            row = { item: node('div'), label: node('strong'), payload: node('pre', undefined, 'delivery-payload') };
            row.item.append(row.label, row.payload); entry.deliveryBody.insertBefore(row.item, entry.deliveryNote);
            entry.deliveryRows.set(d.id, row);
          }
          retainedDeliveries.add(d.id);
          ui.display.computed(row.label, 'text', () => uiText(m.snapshotBatch ? 'delivery.snapshotRow' : 'delivery.row', { recipient: d.label, status: status(d) }));
          if (row.payload.textContent !== d.text) row.payload.textContent = d.text;
        }
        for (const [id, row] of entry.deliveryRows) if (!retainedDeliveries.has(id)) { row.item.remove(); entry.deliveryRows.delete(id); }
        ui.display.text(entry.deliveryNote, m.snapshotBatch ? 'delivery.snapshotNote' : deliveries.length ? 'delivery.note' : m.deliveryTracked ? 'delivery.noteNone' : 'delivery.noteLegacy');
      }
    }
    if (entry.openRecipient) {
      // A paused handoff keeps only a reference, never a private answer or a
      // renewed sharing grant. Archived sessions use the existing read-only view.
      entry.openSessionId = m.manualReply || m.status === 'reply-private' ? m.recipientId : m.role === 'system' && m.runId ? m.sessionId : null;
      entry.openRecipient.hidden = !entry.openSessionId || !state.sessions.some(s => s.id === entry.openSessionId);
      entry.item.classList.toggle('has-session-link', !entry.openRecipient.hidden);
    }
    if (entry.context) entry.context.hidden = !($('room-search').value || $('room-filter').value);
    if (entry.input !== m.input) {
      entry.input = m.input;
      if (!entry.inputBody) { entry.inputBody = node('pre', undefined, 'native-tool-input'); entry.body.before(entry.inputBody); }
      entry.inputBody.textContent = m.input || ''; entry.inputBody.hidden = !m.input;
    }
    const wakeBody = wake && ['staged', 'held', 'sending', 'consumed', 'submitted'].includes(wake.status);
    const spaceBody = readingSpaceMessageBody(m, room);
    const displayText = spaceBody ? spaceBody.body : wakeBody ? wake.body : nativeCompletionText(m);
    if (spaceBody) {
      if (!entry.spaceNotice) { entry.spaceNotice = node('p', undefined, 'quiet space-message-notice'); entry.body.before(entry.spaceNotice); }
      ui.display.computed(entry.spaceNotice, 'text', () => readingSpaceMessageBody(entry.message, room)?.notice || '');
      entry.spaceNotice.hidden = !spaceBody.notice;
    } else if (entry.spaceNotice) { ui.display.unbind(entry.spaceNotice); entry.spaceNotice.remove(); delete entry.spaceNotice; }
    const ownNotice = readingOwnMessage(m);
    const noticeSignature = ownNotice ? JSON.stringify([ownNotice, Boolean(readingDispatchMember(m, ownNotice))]) : '';
    if (entry.noticeSignature !== noticeSignature) {
      // A generated delivery caption can change while the original body does not.
      // Keep its selected text nodes; copy metadata still follows the new notice.
      if (!wakeBody && !spaceBody) entry.text = undefined;
      entry.noticeSignature = noticeSignature;
    }
    entry.displayText = displayText;
    entry.copyPayload = ownNotice ? () => readingOwnText(m, ownNotice) : spaceBody ? () => nativeCompletionText(m) : null;
    const fileSession = room ? state.sessions.find(s => s.id === m.sessionId) : session;
    const fileCwdKnown = fileSession && !fileSession.nativeContextPending && (m.nativeId
      ? m.nativeId === fileSession.nativeId && !fileSession.nativeContexts?.some(c => c.nativeId === m.nativeId)
      : !fileSession.nativeContexts?.length);
    const fileSource = { kind: room ? 'room' : 'session', ...(room ? { roomId: state.room?.id || 'shared' } : {}), sessionId: room ? m.sessionId : session?.id,
      messageId: m.id, nativeId: m.nativeId || null, cwd: fileCwdKnown ? fileSession.cwd || null : null };
    const fileSourceKey = m.role === 'assistant' ? JSON.stringify(fileSource) : null;
    if (entry.text !== displayText || entry.role !== m.role || entry.streaming !== (m.status === 'streaming') || m.role === 'assistant' && entry.fileSourceKey !== fileSourceKey) {
      if (entry.role && entry.role !== m.role) ui.clearMarkdown(entry.body);
      entry.text = displayText; entry.role = m.role; entry.streaming = m.status === 'streaming'; entry.fileSourceKey = fileSourceKey;
      if (m.role === 'assistant') ui.markdown(entry.body, m.text, entry.streaming, () => { if (view.key === key) scheduleReading(view); }, fileSource);
      else if (ownNotice && !wakeBody && !spaceBody) ui.display.computed(entry.body, 'text', () => readingOwnText(m, ownNotice));
      else { ui.display.unbind(entry.body); entry.body.textContent = displayText; }
    }
    const footer = readingTurnFooter(m);
    entry.item.classList.toggle('native-metadata-only', m.kind === 'turn' && !displayText);
    entry.heading.hidden = m.kind === 'turn' && !displayText;
    // A background operation's sentence and folded details stand for its raw text (still what copy and search use).
    entry.body.hidden = entry.heading.hidden || Boolean(m.role === 'human' && m.imageDraftVersion && m.images?.length && !displayText) || Boolean(m.kind === 'background-operation' && m.backgroundOperation?.summary);
    if (footer) {
      if (!entry.footer) { entry.footer = node('footer', undefined, 'reading-turn-footer'); entry.item.append(entry.footer); }
      const finals = originals.filter(other => other.role === 'assistant' && (other.finalReply || ['final_answer', 'finalAnswer'].includes(other.phase)) &&
        other.nativeId === m.nativeId && other.turnId === m.turnId && (!room || other.sessionId === m.sessionId && other.sourceTag === m.sourceTag));
      const repeatedClock = finals.length === 1 && footer.clock && readingMessageClock(finals[0])?.text === footer.clock.text;
      const footerKey = JSON.stringify([footer, repeatedClock]);
      if (entry.footerKey !== footerKey) {
        entry.footer.replaceChildren();
        if (footer.duration) entry.footer.append(node('span', footer.duration));
        // The footer is native turn metadata, not the local receipt clock used
        // by ordinary message headings. Missing fields stay absent.
        if (footer.clock && !repeatedClock) {
          const time = node('time'); time.dateTime = footer.clock.dateTime;
          const clock = () => readingDisplayClock({ role: 'user', time: m.nativeCompletedAt });
          ui.display.computed(time, 'text', () => clock().text);
          ui.display.computed(time, 'title', () => clock().full); ui.display.computed(time, 'aria-label', () => clock().full);
          entry.footer.append(time);
        }
        const description = () => [footer.duration && uiText('reading.elapsed', { duration: footer.duration }), footer.clock && uiText('reading.completedAt', { time: readingDisplayClock({ role: 'user', time: m.nativeCompletedAt }).full })].filter(Boolean).join(' · ');
        ui.display.computed(entry.footer, 'title', description); ui.display.computed(entry.footer, 'aria-label', description);
        entry.footerKey = footerKey;
      }
    } else if (entry.footer) { entry.footer.remove(); delete entry.footer; delete entry.footerKey; }
    const hasImages = Array.isArray(m.images) && m.images.length > 0;
    if (hasImages && entry.disclosure && m.role !== 'tool') {
      // A late image reference is explicit native content. Keep its original
      // nodes while taking it out of the process disclosure.
      const disclosure = entry.disclosure;
      for (const child of [entry.heading, entry.inputBody, entry.body, entry.delivery]) if (child && disclosure.contains(child)) disclosure.before(child);
      disclosure.remove(); entry.tail?.remove(); entry.more?.remove();
      delete entry.disclosure; delete entry.content; delete entry.preview; delete entry.tail; delete entry.more;
      entry.item.classList.remove('process');
    }
    if (hasImages && !entry.images) {
      // Images keep their independent preview controls outside the folded log.
      const host = node('div', undefined, 'message-images'); (entry.more || entry.body).after(host);
      // Assistive activation may click without a preceding pointer/key event.
      host.addEventListener('click', event => {
        if (view.key === key && event.target.closest('.native-image-toggle')) view.intent = null;
      }, true);
      host.addEventListener('keydown', event => {
        if (view.key === key && event.key === 'Escape') view.intent = null;
      }, true);
      entry.images = window.nativeWorkspaceImages.mount(host, api, {
        display: ui.display, text: uiText, displayText: ui.displayText, createError: ui.createError,
        beforeLayout: () => { if (el.clientWidth && el.clientHeight) captureReading(view); }, onLayout: () => { if (view.key === key && el.clientWidth && el.clientHeight) scheduleReading(view); },
        isOpen: imageKey => view.folds[imageKey] === true,
        onOpen: (imageKey, open) => {
          if (view.key !== key) return;
          const pending = view.intent?.position;
          delete view.folds[imageKey]; view.folds[imageKey] = open;
          for (const id of Object.keys(view.folds).slice(0, Math.max(0, Object.keys(view.folds).length - 200))) delete view.folds[id];
          // A preview/expand reply is layout, not another manual activation.
          if (pending) saveReading(view, pending);
          else {
            captureReading(view); saveReading(view, { ...(readingPositions[key] || { top: el.scrollTop, anchor: m.id.length <= 100 ? m.id : '', offset: 0 }), follow: false });
          }
          attempt(() => api.readingState(readingPositions));
        },
      });
    }
    const uploadedSpaceImages = room && m.imageDraftVersion && m.role === 'human' && m.images?.every(ref => ref.kind === 'space-upload');
    entry.images?.update(m.images || [], uploadedSpaceImages
      ? { kind: 'space-message', roomId: state.room?.id || 'shared', messageId: m.id }
      : { kind: room ? 'room' : 'session', ...(room ? { roomId: state.room?.id || 'shared' } : {}), sessionId: room ? m.sessionId : session?.id, nativeId: m.nativeId, messageId: m.id },
      () => room ? m.name || messageName() : sessionName || messageName(), uploadedSpaceImages ? 'preview' : m.status);
    if (uploadedSpaceImages && hasImages) {
      if (!entry.imageReceipt) { entry.imageReceipt = node('p', undefined, 'native-image-note'); entry.body.after(entry.imageReceipt); }
      ui.display.text(entry.imageReceipt, m.imageReceipt?.status === 'accepted' && m.imageReceipt.basis === 'native-local-image-echo' ? 'roomImages.accepted' : 'roomImages.unconfirmed');
    } else if (entry.imageReceipt) { ui.display.unbind(entry.imageReceipt, 'text'); entry.imageReceipt.remove(); delete entry.imageReceipt; }
    if (entry.inputBody && hasImages && m.toolKind === 'imageView') entry.inputBody.hidden = true;
    if (entry.copyText) { entry.copyText.hidden = hasImages && !m.text || m.kind === 'turn' && !displayText; ui.display.text(entry.copyText, hasImages ? 'reading.copyText' : 'common.copy'); }
    entry.share.hidden ||= hasImages && !m.text;
    ui.display.text(entry.share, hasImages ? 'reading.shareText' : 'reading.share');
  }
  const nested = new Set();
  for (const [id, group] of explorations) {
    const first = view.entries.get(id); if (!first?.content) continue;
    let cursor = first.body.nextSibling;
    for (const message of group.messages.slice(1)) {
      const entry = view.entries.get(message.id); nested.add(entry.item);
      if (entry.item === cursor) cursor = cursor.nextSibling; else first.content.insertBefore(entry.item, cursor);
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) if (nested.has(rows[i])) rows.splice(i, 1);
  rows = processGroupRows(view, rows, groups, explorations, room, key);
  for (const row of rows) {
    const firstId = groups.get(row.dataset.processGroup)?.messages[0]?.id || row.dataset.messageId, mark = turnMarks.get(firstId);
    row.classList.toggle('reading-turn-start', mark?.start === true);
    if (mark) { row.dataset.readingTurnStart = String(mark.start); row.dataset.readingTurnContinuation = String(mark.continuation); }
    else { delete row.dataset.readingTurnStart; delete row.dataset.readingTurnContinuation; }
  }
  if (!sourceMessages.length) {
    const s = session;
    const empty = s?.state === 'approval' || s?.nativeApproval ? 'reading.emptyApproval' : s?.state === 'working' ? 'reading.emptyWorking' : 'reading.empty';
    const label = node('p', undefined, 'message empty');
    ui.display.text(label, room ? ($('room-search').value || $('room-filter').value ? 'reading.emptySharedMatch' : 'reading.emptyShared') : empty);
    rows.push(label);
  }
  view.older.hidden = !range.start; view.newer.hidden = range.tail;
  // Each button says how many records it brings and how many there are in all.
  const step = action => readingPageRange(view.pageData, range, { action });
  const counts = { older: range.start - step('older').start, newer: step('newer').end - range.end, total: view.pageData.messages.length };
  ui.display.text(view.older, 'disclosure.older', () => ({ count: counts.older, total: counts.total }));
  ui.display.text(view.newer, 'reading.newer', () => ({ count: counts.newer, total: counts.total }));
  rows.unshift(view.older); rows.push(view.newer);
  if (!view.jumpSlot) rows.push(view.jumpBar);
  // Do not detach/reinsert unchanged rows: that would destroy live selections.
  let cursor = el.firstChild;
  for (const row of rows) { if (row === cursor) cursor = cursor.nextSibling; else el.insertBefore(row, cursor); }
  while (cursor) { const next = cursor.nextSibling; ui.clearMarkdown(cursor); cursor.remove(); cursor = next; }
  // Move every retained original out of obsolete wrappers before disposing
  // their old parents, including filtered T29 descendants with live Markdown.
  for (const [id, entry] of view.entries) if (!retained.has(id)) { cancelReadingWakeCollapse(entry); entry.images?.dispose(); if (entry.imageReceipt) ui.display.unbind(entry.imageReceipt, 'text'); ui.clearMarkdown(entry.item); entry.item.remove(); view.entries.delete(id); }
  for (const [day, divider] of view.days) if (!days.has(day)) { divider.remove(); view.days.delete(day); }
  if (selected?.anchor.isConnected && selected.focus?.isConnected &&
      selected.anchorOffset <= (selected.anchor.nodeType === 3 ? selected.anchor.length : selected.anchor.childNodes.length) &&
      selected.focusOffset <= (selected.focus.nodeType === 3 ? selected.focus.length : selected.focus.childNodes.length) &&
      (selection.anchorNode !== selected.anchor || selection.anchorOffset !== selected.anchorOffset || selection.focusNode !== selected.focus || selection.focusOffset !== selected.focusOffset)) {
    selection.setBaseAndExtent(selected.anchor, selected.anchorOffset, selected.focus, selected.focusOffset);
  }
  updateJump(view); scheduleReading(view, intent);
}
function disposeReadingViews() { for (const view of messageViews.values()) view.dispose(); messageViews.clear(); }
