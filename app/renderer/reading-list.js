// Per-window reading state. Only IDs and geometry are persisted, never selection.
const messageViews = new Map();
let readingPositions = {};
let readingPayloadId = 0;
function readingMessageClock(message, now = Date.now()) {
  const important = ['user', 'human'].includes(message.role) || message.role === 'assistant' &&
    (!message.kind || message.kind === 'response') && message.phase !== 'commentary' && message.status !== 'streaming';
  if (!important || !Number.isFinite(message.time) || Math.abs(message.time) > 8640000000000000) return null;
  const date = new Date(message.time), today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { text: (sameDay ? '' : date.toLocaleDateString() + ' ') + time, dateTime: date.toISOString(), full: date.toLocaleString([], { hourCycle: 'h23' }) };
}
function readingActionLabel(message, author) {
  return message.toolKind === 'commandExecution' || message.title === 'Bash' ? '这条命令的输出'
    : ['user', 'human'].includes(message.role) ? `${author}的输入`
    : message.role === 'assistant' && (!message.kind || message.kind === 'response') ? `${author}的回复`
    : message.kind === 'summary' ? `${author}的思考摘要` : message.role === 'tool' ? '这条工具记录' : '这条记录';
}
async function copyReadingMessage(entry) {
  const text = entry.displayText ?? entry.message.text, label = entry.actionLabel;
  await api.copy(text);
  toast('已复制：' + label);
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
function changeReadingPage(view, action, fromButton = false, automatic = false) {
  if (!view.reload || view.loadingPage || !view.el.isConnected) return;
  captureReading(view);
  const previous = readingPositions[view.key] || { top: 0, follow: false, anchor: '', offset: 0 };
  const pagerFocused = document.activeElement === view.older || document.activeElement === view.newer;
  const position = action === 'latest' ? { top: 0, follow: true, anchor: '', offset: 0 }
    : action === 'first' ? { top: 0, follow: false, anchor: view.pageData.messages[0]?.id || '', offset: 0 }
    : { ...previous, follow: Boolean(automatic && previous.follow && view.pageRange.tail) };
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
  const keys = Object.keys(readingPositions);
  for (const key of keys.slice(0, Math.max(0, keys.length - 128))) delete readingPositions[key];
}
function captureReading(view) {
  const el = view.el;
  if (!view.key || !el.clientHeight || !el.getClientRects().length) return;
  // An asynchronous Markdown layout may still be completing. Preserve its
  // original anchor until an actual scroll/pointer/key action supersedes it.
  if (view.intent) return;
  const selection = window.getSelection();
  const selecting = !selection.isCollapsed && el.contains(selection.anchorNode);
  const top = el.getBoundingClientRect().top;
  const anchor = [...el.querySelectorAll(':scope > [data-message-id]')].find(row => row.getBoundingClientRect().bottom > top);
  saveReading(view, { top: el.scrollTop, follow: readingFollow(view.pageRange?.tail, el.scrollHeight - el.scrollTop - el.clientHeight < 80, selecting), anchor: anchor?.dataset.messageId || '', offset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
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
  if (view.frame) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = 0;
    if (!view.intent || !view.el.clientHeight || !view.el.getClientRects().length) return;
    const el = view.el, p = view.intent.position;
    const anchor = readingEntry(view, p.anchor)?.item;
    if (anchor && !p.follow) {
      const entry = readingEntry(view, p.anchor);
      revealProcessAncestors(view, entry);
    }
    if (anchor && view.intent.searchQuery) {
      const entry = readingEntry(view, p.anchor);
      if (entry.disclosure && !entry.disclosure.open) { entry.expectedOpen = true; entry.disclosure.open = true; }
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
    view.assignedTop = el.scrollTop; view.pageChanging = false; updateJump(view); fillShortReadingPage(view);
  });
}
function readingView(el, key) {
  let view = messageViews.get(el);
  if (!view) {
    view = { el, key: '', entries: new Map(), groups: new Map(), days: new Map(), assignedTop: el.scrollTop, frame: 0, intent: null };
    el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'region');
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', '会话记录');
    view.older = button('显示更早的记录', () => changeReadingPage(view, 'older', true), 'reading-page');
    view.newer = button('显示较新的记录', () => changeReadingPage(view, 'newer', true), 'reading-page');
    view.older.dataset.direction = 'older'; view.newer.dataset.direction = 'newer';
    view.jump = button('↓ 跳到最新', () => changeReadingPage(view, 'latest'), 'jump-latest');
    view.jumpBar = node('div', undefined, 'jump-bar'); view.jumpBar.append(view.jump); view.jumpBar.hidden = true;
    const interact = () => { view.intent = null; view.assignedTop = undefined; view.pageChanging = false; view.autoPages = 4; };
    const wheel = event => {
      interact();
      if (!view.paged) return;
      if (event.deltaY < 0 && el.scrollTop <= 1 && view.pageRange.start) changeReadingPage(view, 'older');
      else if (event.deltaY > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1 && !view.pageRange.tail) changeReadingPage(view, 'newer');
    };
    const keydown = event => {
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
    el.addEventListener('pointerdown', interact); el.addEventListener('wheel', wheel, { passive: true }); el.addEventListener('keydown', keydown); el.addEventListener('scroll', scroll, { passive: true });
    view.observer = new ResizeObserver(() => scheduleReading(view)); view.observer.observe(el);
    view.dispose = () => { for (const entry of view.entries.values()) entry.images?.dispose(); view.observer.disconnect(); cancelAnimationFrame(view.frame); el.removeEventListener('pointerdown', interact); el.removeEventListener('wheel', wheel); el.removeEventListener('keydown', keydown); el.removeEventListener('scroll', scroll); view.reload = null; view.loadMessage = null; view.pageData = null; ui.clearMarkdown(el); };
    messageViews.set(el, view);
  }
  if (view.key !== key) {
    for (const entry of view.entries.values()) entry.images?.dispose();
    captureReading(view); ui.clearMarkdown(el); el.replaceChildren();
    view.entries.clear(); view.groups.clear(); view.days.clear(); view.key = key; view.folds = Object.assign(Object.create(null), readingPositions[key]?.folds || {});
    view.pageRange = null; view.pageRequest = null; view.pageChanging = false; view.autoPages = 4; view.reload = null; view.loadMessage = null;
    // The new list is empty until Markdown mounts; never capture that temporary
    // zero as this session's saved reading position.
    view.intent = { position: readingPositions[key] || { top: 0, follow: true, anchor: '', offset: 0 } };
    el.scrollTop = 0; view.assignedTop = 0;
  }
  return view;
}
function nativeCompletionText(message) {
  if (message.kind !== 'turn') return message.text;
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
    group.caption = [...counts].map(([type, count]) => `${count} ${{ read: '次读取', search: '次搜索', listFiles: '次列目录' }[type]}`).concat([...exits].map(code => `exit ${code}`)).join(' · ');
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
      const label = m.kind === 'summary' ? '段思考摘要' : m.toolKind === 'commandExecution' || m.title === 'Bash' ? '个命令'
        : m.title === 'Read' ? '次读取' : m.toolKind === 'webSearch' || ['Grep', 'Glob'].includes(m.title) ? '次搜索' : '次工具调用';
      counts.set(label, (counts.get(label) || 0) + 1);
      // Keep T29's native nonzero exploration annotation, including search exit1.
      if (m.status === 'failed' && nativeExploration(m) && Number.isSafeInteger(m.exitCode) && m.exitCode !== 0) exits.add(m.exitCode);
      else if (['failed', 'declined', 'interrupted'].includes(m.status)) outcomes.set(m.status, (outcomes.get(m.status) || 0) + 1);
    }
    group.caption = [...counts].map(([label, count]) => `${count} ${label}`).join(' · ');
    group.outcome = ['failed', 'declined', 'interrupted'].filter(status => outcomes.has(status)).map(status => `${{ failed: '失败', declined: '已拒绝', interrupted: '已中断' }[status]} ${outcomes.get(status)}`)
      .concat([...exits].map(code => `exit ${code}`)).join(' · ');
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
    if (entry.tail.textContent !== entry.exploration.caption) entry.tail.textContent = entry.exploration.caption;
    entry.more.hidden = true; return;
  }
  // Like the native TUIs: a folded command keeps two one-line rows of output (the
  // newest while it runs, the first once done) and says how many more there are.
  const lines = (m.toolKind === 'commandExecution' || (!m.toolKind && m.title === 'Bash')) && !open && m.text ? m.text.replace(/\n+$/, '').split('\n') : [];
  const shown = ['running', 'streaming'].includes(m.status) ? lines.slice(-2) : lines.slice(0, 2), more = lines.length - shown.length, tail = shown.join('\n');
  entry.tail.hidden = !tail; if (entry.tail.textContent !== tail) entry.tail.textContent = tail;
  entry.more.hidden = !more; const moreText = `+${more} 行`; if (entry.more.textContent !== moreText) entry.more.textContent = moreText;
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
        event.preventDefault(); group.expectedOpen = undefined; disclosure.open = !disclosure.open; remember();
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
    const author = room ? roomMessageLabel(first) : first.name || (view.session?.provider === 'claude' ? 'Claude' : 'Codex');
    if (group.author.textContent !== author) group.author.textContent = author;
    if (group.caption.textContent !== plan.caption) group.caption.textContent = plan.caption;
    if (group.outcome.textContent !== plan.outcome) group.outcome.textContent = plan.outcome;
    group.summary.setAttribute('aria-label', `${author} · ${plan.active ? '进行中 · ' : ''}${plan.caption}${plan.outcome ? ' · ' + plan.outcome : ''}`);
    group.summary.title = group.summary.getAttribute('aria-label');
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
function messageList(el, messages, room = false, key = 'room', context = {}) {
  // A member reader observes its own session without selecting it or claiming
  // its input. Existing solo/shared callers retain their original context.
  const session = context.session || (room ? null : current()), sourceMessages = messages;
  const view = readingView(el, key);
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
  view.paged = !room;
  view.pageData = readingPageData(messages, [...explorations.values(), ...groups.values()]);
  const active = document.activeElement, pinned = Boolean(selected || active && el.contains(active) && active.closest('[data-message-id]'));
  const range = room ? { start: 0, end: messages.length, tail: true }
    : readingPageRange(view.pageData, view.pageRange, view.pageRequest, intent.position, pinned);
  // Removing an old top row triggers browser scroll anchoring before our next
  // frame. It is layout, not a human scroll that revokes the follow/anchor.
  if (!room && (view.pageRange?.firstId !== range.firstId || view.pageRange?.lastId !== range.lastId)) view.pageChanging = true;
  view.pageRange = range; view.pageRequest = null;
  const turnMarks = readingTurnMarks(messages.slice(range.start, range.end), room, originals);
  view.reload = () => { if (view.key === key && el.isConnected) messageList(el, sourceMessages, room, key, context); };
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
        let divider = view.days.get(day); if (!divider) { divider = node('div', day, 'timeline-day'); view.days.set(day, divider); }
        rows.push(divider); days.add(day); lastDay = day;
      }
    }
    let entry = view.entries.get(m.id);
    if (!entry) {
      const item = node('article'), heading = node('div', undefined, 'message-heading'), body = node('div', undefined, 'message-body'), actions = node('div', undefined, 'message-actions');
      body.id = `reading-payload-${++readingPayloadId}`;
      item.dataset.messageId = m.id; item.append(heading, body, actions);
      entry = { item, heading, body, actions }; view.entries.set(m.id, entry);
      if ((m.role === 'tool' || m.kind === 'summary') && !(Array.isArray(m.images) && m.images.length)) {
        const disclosure = node('details', undefined, 'process-details'), summary = node('summary'), content = node('div', undefined, 'process-content');
        entry.disclosure = disclosure; entry.preview = node('span', undefined, 'process-label'); entry.tail = node('pre', undefined, 'process-tail'); entry.content = content;
        entry.more = node('button', undefined, 'process-more'); entry.more.type = 'button';
        summary.append(heading); content.append(body); disclosure.append(summary, content); item.replaceChildren(disclosure, entry.tail, entry.more, actions);
        const rememberFold = () => {
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
          event.preventDefault(); entry.expectedOpen = undefined; disclosure.open = !disclosure.open; rememberFold();
        });
        entry.more.onclick = () => { entry.expectedOpen = undefined; disclosure.open = true; rememberFold(); };
        disclosure.addEventListener('toggle', () => {
          if (entry.expectedOpen === disclosure.open) { entry.expectedOpen = undefined; return; }
          entry.expectedOpen = undefined; rememberFold();
        });
      }
      entry.copyText = button('复制', () => copyReadingMessage(entry)); actions.append(entry.copyText);
      entry.share = button('选择并分享', () => share(entry.message.text)); actions.append(entry.share);
      for (const action of [entry.copyText, entry.share]) {
        action.setAttribute('aria-controls', body.id);
        const highlight = () => body.classList.add('copy-payload');
        const clear = () => { if (!actions.matches(':hover') && !actions.contains(document.activeElement)) body.classList.remove('copy-payload'); };
        action.addEventListener('pointerenter', highlight); action.addEventListener('focus', highlight);
        action.addEventListener('pointerleave', clear); action.addEventListener('blur', clear);
      }
      actions.addEventListener('pointerleave', () => { if (!actions.contains(document.activeElement)) body.classList.remove('copy-payload'); });
      if (room) {
        entry.reply = button('回复', () => openThread(entry.message.id)); actions.append(entry.reply);
        entry.delivery = node('details', undefined, 'message-delivery');
        entry.deliverySummary = node('summary'); entry.deliveryBody = node('div', undefined, 'delivery-body');
        entry.deliveryRows = new Map(); entry.deliveryNote = node('p'); entry.deliveryBody.append(entry.deliveryNote);
        entry.delivery.append(entry.deliverySummary, entry.deliveryBody); (entry.content || item).append(entry.delivery);
        entry.openRecipient = button('查看会话', () => {
          if (!state.sessions.some(s => s.id === entry.openSessionId)) return toast('这个会话当前不可用，记录仍保留。');
          return select(entry.openSessionId, 'chat');
        }, 'message-session-link');
        entry.context = button('查看上下文', () => {
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
        }); actions.append(entry.context);
        // Last, so it stays put when the row's other actions appear.
        actions.append(entry.openRecipient);
      }
    }
    entry.message = m; entry.exploration = explorations.get(m.id); retained.add(m.id); rows.push(entry.item);
    entry.item.className = `message ${m.role}${m.kind === 'turn' ? ' native-turn' : ''}${entry.disclosure ? ' process' : ''}`;
    entry.item.classList.toggle('native-notice', Boolean(m.role === 'system' && (['notice', 'gap', 'context'].includes(m.kind) || !room && session?.nativeContexts?.some(c => c.boundaryId === m.id))));
    const nativeTitle = entry.exploration ? entry.exploration.active ? 'Exploring' : 'Explored' : m.toolKind === 'commandExecution' ? ['running', 'streaming'].includes(m.status) ? 'Running' : m.commandSource === 'userShell' ? 'You ran' : 'Ran' : m.kind === 'summary' && m.title === '过程摘要' || m.kind === 'plan' && m.title === '计划' || m.toolKind === 'webSearch' && ['搜索网页', '打开网页', '页内查找'].includes(m.title) || m.toolKind === 'fileChange' && m.title === '文件修改' ? '' : m.title;
    let name = room ? roomMessageLabel(m) : m.name;
    if (m.nativeBlock && m.kind === 'input' && m.inputMode === 'native-inline') name = '原生会话';
    name ||= m.role === 'user' ? '你' : session?.provider === 'claude' ? 'Claude' : 'Codex';
    if (!room && m.role === 'system' && !m.sessionId) name = m.name || '原生会话';
    const messageTime = readingMessageClock(m);
    const headingKey = JSON.stringify([name, m.status, messageTime, m.manualReply, nativeTitle, entry.exploration?.error, m.exitCode, m.incomplete, m.volatile, m.sharingStopped]);
    if (entry.headingKey !== headingKey) {
      const authorId = room && (m.sessionId || m.recipientId);
      const author = authorId ? button(name, () => { $('room-filter').value = authorId; renderTimeline(); attempt(persistView); }, 'message-author') : node('strong', name);
      if (authorId) { author.title = `查看 ${name} 的共享轨迹`; author.setAttribute('aria-label', `查看 ${name} 的共享轨迹`); }
      entry.heading.replaceChildren(author); entry.headingKey = headingKey;
      if (nativeTitle) entry.heading.append(node('span', nativeTitle));
      if (m.incomplete) entry.heading.append(node('span', '内容未完整同步 · 请核对原生终端'));
      if (m.volatile && !entry.disclosure) entry.heading.append(node('span', (m.nativeMessageId || m.id || '').startsWith(`native:${m.nativeId}:tool:`) ? '工具记录' : '本次运行记录'));
      if (m.sharingStopped) entry.heading.append(node('span', `共享已停止 · ${m.sharingStopped}`));
      if (messageTime) { const time = node('time', messageTime.text); time.dateTime = messageTime.dateTime; time.title = '记录时间：' + messageTime.full; time.setAttribute('aria-label', time.title); entry.heading.append(time); }
      // A stored fragment is not proof that its native turn is still running.
      // Current activity lives in the session/progress status, not this record.
      // Only Claude rows take queued input; native sends it once the agent is idle.
      const status = { 'awaiting-native': m.inputMode === 'queue' ? '排队中，等空闲后发送' : '等待原生确认', unconfirmed: '结果未确认', 'not-sent': '没有发出', streaming: '正在输出', running: !room && session?.provider === 'claude' && m.role === 'tool' ? '已请求工具' : '正在运行', failed: '原生报告失败', declined: '原生已拒绝', interrupted: '原生已中断', 'reply-private': '分享已失效，回复保留在原会话' }[m.status];
      if (entry.exploration) { if (entry.exploration.error) entry.heading.append(node('span', entry.exploration.error)); }
      else if (status && !m.nativeBlock && !m.sharedStream) entry.heading.append(node('span', status));
      else if ((m.nativeBlock || m.sharedStream) && ['failed', 'declined', 'interrupted', 'unconfirmed'].includes(m.status)) entry.heading.append(node('span', m.status));
      else if (m.manualReply && m.status === 'submitted') entry.heading.append(node('span', '原生已接收 · 回复由你选定后分享'));
      if (m.toolKind === 'commandExecution' && !entry.exploration && m.exitCode) entry.heading.append(node('span', 'exit ' + m.exitCode));
      if (entry.preview) entry.heading.append(entry.preview);
    }
    entry.actionLabel = readingActionLabel(m, name);
    entry.copyText.setAttribute('aria-label', '复制：' + entry.actionLabel);
    entry.share.setAttribute('aria-label', '选择并分享：' + entry.actionLabel);
    // Keep tools' original disclosure and source IDs. The toolbar belongs to
    // this heading, rather than floating over the next record's content.
    if (m.role !== 'system' && entry.actions.parentElement !== entry.heading) entry.heading.append(entry.actions);
    if (entry.disclosure) {
      const error = entry.exploration ? entry.exploration.error : m.incomplete ? 'incomplete' : ['failed', 'declined', 'interrupted', 'unconfirmed'].includes(m.status) ? m.status : '';
      entry.error = error;
      const query = room ? $('room-search').value.trim() : '';
      const reveal = query && [m.text, m.input].some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const choice = view.folds[m.id];
      const savedOpen = typeof choice === 'boolean' ? choice : choice?.open;
      const failedTool = m.role === 'tool' && (m.status === 'failed' || entry.exploration?.error === 'failed');
      const open = Boolean(savedOpen !== undefined ? savedOpen : reveal || error && !failedTool);
      if (entry.disclosure.open !== open) { entry.expectedOpen = open; entry.disclosure.open = open; }
      entry.item.dataset.running = String(entry.exploration ? entry.exploration.active : ['running', 'streaming'].includes(m.status));
      let inputPreview = m.input;
      if (inputPreview?.trim().startsWith('{')) {
        try { const value = JSON.parse(inputPreview); inputPreview = [value.command, value.description, value.file_path, value.path, value.query].find(field => typeof field === 'string' && field.trim()) || inputPreview; }
        catch { /* The expandable original remains authoritative. */ }
      }
      const preview = (failedTool && !entry.exploration && m.toolKind !== 'commandExecution' && m.title !== 'Bash' && m.text?.trim() ? m.text : entry.exploration || m.toolKind === 'webSearch' ? '' : m.toolKind === 'commandExecution' ? nativeCommandPreview(m) : inputPreview || m.text || '').split(/\r?\n/).find(line => line.trim()) || '';
      if (entry.preview.textContent !== preview) entry.preview.textContent = preview;
      updateProcessTail(entry);
    }
    entry.share.hidden = context.passive === true || m.role === 'system';
    if (entry.reply) {
      entry.reply.dataset.replyTo = m.id;
      const root = roomThreads.roots.get(m.id), count = roomThreads.groups.get(root)?.length || 1;
      entry.reply.hidden = m.role === 'system';
      entry.reply.textContent = count > 1 ? `回复 · ${count} 条讨论记录` : '回复';
    }
    if (entry.delivery) {
      entry.delivery.hidden = m.role === 'system';
      const deliveries = (m.deliveries || []).map(d => {
        const recipient = state.sessions.find(s => s.id === d.recipientId);
        return { ...d, label: recipient ? participantLabel(recipient, state.sessions) : historicalParticipantLabel(d.recipientName, d.recipientId) };
      });
      const deliveryKey = JSON.stringify([m.deliveryTracked, deliveries]);
      if (entry.deliveryKey !== deliveryKey) {
        entry.deliveryKey = deliveryKey;
        const status = d => ({ submitted: '原生已接收', 'awaiting-native': m.inputMode === 'queue' ? '排队中，等空闲后发送' : '等待原生确认', unconfirmed: '接收结果未确认', 'not-sent': '没有发出' }[d.status] || '接收结果未记录');
        entry.deliverySummary.textContent = deliveries.length
          ? `发送详情 · ${deliveries.map(d => `${d.label}：${status(d)}`).join('；')}`
          : m.deliveryTracked ? '本条未由工作区转发' : '旧记录 · 发送详情未记录';
        const retainedDeliveries = new Set();
        for (const d of deliveries) {
          let row = entry.deliveryRows.get(d.id);
          if (!row) {
            row = { item: node('div'), label: node('strong'), payload: node('pre', undefined, 'delivery-payload') };
            row.item.append(row.label, row.payload); entry.deliveryBody.insertBefore(row.item, entry.deliveryNote);
            entry.deliveryRows.set(d.id, row);
          }
          retainedDeliveries.add(d.id);
          const label = `发给 ${d.label} · ${status(d)}`;
          if (row.label.textContent !== label) row.label.textContent = label;
          if (row.payload.textContent !== d.text) row.payload.textContent = d.text;
        }
        for (const [id, row] of entry.deliveryRows) if (!retainedDeliveries.has(id)) { row.item.remove(); entry.deliveryRows.delete(id); }
        const note = deliveries.length
          ? '以上是本次交给原生 agent 的正文，不是其完整模型上下文；原生历史、系统指令和 hooks 仍由原生管理。列入共享记录不会自动发送给其他成员。'
          : m.deliveryTracked ? '这条消息保留在共享记录中，工作区没有将本条转发给其他 agent。'
          : '这条旧记录没有完整的发送凭据，不能据此判断哪些 agent 已收到。';
        if (entry.deliveryNote.textContent !== note) entry.deliveryNote.textContent = note;
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
    const displayText = nativeCompletionText(m);
    entry.displayText = displayText;
    const fileSession = room ? state.sessions.find(s => s.id === m.sessionId) : session;
    const fileCwdKnown = fileSession && !fileSession.nativeContextPending && (m.nativeId
      ? m.nativeId === fileSession.nativeId && !fileSession.nativeContexts?.some(c => c.nativeId === m.nativeId)
      : !fileSession.nativeContexts?.length);
    const fileSource = { kind: room ? 'room' : 'session', sessionId: room ? m.sessionId : session?.id,
      messageId: m.id, nativeId: m.nativeId || null, cwd: fileCwdKnown ? fileSession.cwd || null : null };
    const fileSourceKey = m.role === 'assistant' ? JSON.stringify(fileSource) : null;
    if (entry.text !== displayText || entry.role !== m.role || entry.streaming !== (m.status === 'streaming') || m.role === 'assistant' && entry.fileSourceKey !== fileSourceKey) {
      if (entry.role && entry.role !== m.role) ui.clearMarkdown(entry.body);
      entry.text = displayText; entry.role = m.role; entry.streaming = m.status === 'streaming'; entry.fileSourceKey = fileSourceKey;
      if (m.role === 'assistant') ui.markdown(entry.body, m.text, entry.streaming, () => { if (view.key === key) scheduleReading(view); }, fileSource);
      else entry.body.textContent = displayText;
    }
    const footer = readingTurnFooter(m);
    entry.item.classList.toggle('native-metadata-only', m.kind === 'turn' && !displayText);
    entry.heading.hidden = entry.body.hidden = m.kind === 'turn' && !displayText;
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
        if (footer.clock && !repeatedClock) { const time = node('time', footer.clock.text); time.dateTime = footer.clock.dateTime; time.title = footer.clock.full; time.setAttribute('aria-label', footer.clock.full); entry.footer.append(time); }
        const description = [footer.duration && '用时 ' + footer.duration, footer.clock && '完成时间 ' + footer.clock.full].filter(Boolean).join(' · ');
        entry.footer.title = description; entry.footer.setAttribute('aria-label', description);
        entry.footerKey = footerKey;
      }
    } else if (entry.footer) { entry.footer.remove(); delete entry.footer; delete entry.footerKey; }
    const hasImages = Array.isArray(m.images) && m.images.length > 0;
    if (hasImages && entry.disclosure) {
      // A late image reference is explicit native content. Keep its original
      // nodes while taking it out of the process disclosure.
      const disclosure = entry.disclosure;
      for (const child of [entry.heading, entry.inputBody, entry.body, entry.delivery]) if (child && disclosure.contains(child)) disclosure.before(child);
      disclosure.remove(); entry.tail?.remove(); entry.more?.remove();
      delete entry.disclosure; delete entry.content; delete entry.preview; delete entry.tail; delete entry.more;
      entry.item.classList.remove('process');
    }
    if (hasImages && !entry.images) {
      const host = node('div', undefined, 'message-images'); entry.body.after(host);
      entry.images = window.nativeWorkspaceImages.mount(host, api, {
        beforeLayout: () => { if (el.clientWidth && el.clientHeight) captureReading(view); }, onLayout: () => { if (view.key === key && el.clientWidth && el.clientHeight) scheduleReading(view); },
        isOpen: imageKey => view.folds[imageKey] === true,
        onOpen: (imageKey, open) => {
          if (view.key !== key) return;
          view.intent = null; delete view.folds[imageKey]; view.folds[imageKey] = open;
          for (const id of Object.keys(view.folds).slice(0, Math.max(0, Object.keys(view.folds).length - 200))) delete view.folds[id];
          captureReading(view); saveReading(view, { ...(readingPositions[key] || { top: el.scrollTop, anchor: m.id.length <= 100 ? m.id : '', offset: 0 }), follow: false });
          attempt(() => api.readingState(readingPositions));
        },
      });
    }
    entry.images?.update(m.images || [], { kind: room ? 'room' : 'session', sessionId: room ? m.sessionId : session?.id,
      nativeId: m.nativeId, messageId: m.id }, room ? m.name || name : session?.name || name, m.status);
    if (entry.inputBody && hasImages && m.toolKind === 'imageView') entry.inputBody.hidden = true;
    if (entry.copyText) { entry.copyText.hidden = hasImages && !m.text || m.kind === 'turn' && !displayText; entry.copyText.textContent = hasImages ? '复制文字' : '复制'; }
    entry.share.hidden ||= hasImages && !m.text;
    entry.share.textContent = hasImages ? '选择并分享文字' : '选择并分享';
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
    const empty = s?.state === 'approval' || s?.nativeApproval ? '原生会话正在等待确认，请核对上方请求或同屏终端。' : s?.state === 'working' ? '原生会话正在工作，输出会在这里出现。' : '从这里开始。你也可以随时使用同一个会话的原生终端。';
    rows.push(node('p', room ? ($('room-search').value || $('room-filter').value ? '没有匹配的共享记录。私人会话内容不会出现在这里。' : '从一句话开始合作\n@ 选择接收者；共享消息和成员变化会留在这里。') : empty, 'message empty'));
  }
  view.older.hidden = room || !range.start; view.newer.hidden = room || range.tail;
  if (!room) { rows.unshift(view.older); rows.push(view.newer); }
  rows.push(view.jumpBar);
  // Do not detach/reinsert unchanged rows: that would destroy live selections.
  let cursor = el.firstChild;
  for (const row of rows) { if (row === cursor) cursor = cursor.nextSibling; else el.insertBefore(row, cursor); }
  while (cursor) { const next = cursor.nextSibling; ui.clearMarkdown(cursor); cursor.remove(); cursor = next; }
  // Move every retained original out of obsolete wrappers before disposing
  // their old parents, including filtered T29 descendants with live Markdown.
  for (const [id, entry] of view.entries) if (!retained.has(id)) { entry.images?.dispose(); ui.clearMarkdown(entry.item); entry.item.remove(); view.entries.delete(id); }
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
