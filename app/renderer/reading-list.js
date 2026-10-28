// Per-window reading state. Only IDs and geometry are persisted, never selection.
const messageViews = new Map();
let readingPositions = {};
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
  saveReading(view, { top: el.scrollTop, follow: !selecting && el.scrollHeight - el.scrollTop - el.clientHeight < 80, anchor: anchor?.dataset.messageId || '', offset: anchor ? anchor.getBoundingClientRect().top - top : 0 });
}
// Like the native terminal's "Jump to bottom": shown once the reader leaves the latest output.
// Its bar has no height, so showing it never moves the scroll position.
function updateJump(view) { view.jumpBar.hidden = !view.el.clientHeight || view.el.scrollHeight - view.el.scrollTop - view.el.clientHeight < 80; }
function captureReadingViews() { for (const view of messageViews.values()) captureReading(view); }
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
    const enclosing = view.entries.get(parent.closest('[data-message-id]')?.dataset.messageId);
    if (enclosing) enclosing.expectedOpen = true; parent.open = true;
  }
}
function scheduleReading(view, intent = view.intent) {
  if (!intent || view.intent !== intent || view.frame) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = 0;
    if (!view.intent || !view.el.clientHeight || !view.el.getClientRects().length) return;
    const el = view.el, p = view.intent.position;
    const anchor = view.entries.get(p.anchor)?.item;
    if (anchor) {
      const entry = view.entries.get(p.anchor);
      revealProcessAncestors(view, entry);
    }
    if (anchor && view.intent.searchQuery) {
      const entry = view.entries.get(p.anchor);
      if (entry.disclosure && !entry.disclosure.open) { entry.expectedOpen = true; entry.disclosure.open = true; }
      const range = readingMatch(entry.body, view.intent.searchQuery);
      if (range) {
        const offset = 16 - (range.getBoundingClientRect().top - anchor.getBoundingClientRect().top);
        if (p.offset !== offset) {
          p.offset = offset;
          attempt(() => api.readingState(readingPositions));
        }
      }
    }
    el.scrollTop = p.follow ? el.scrollHeight : anchor ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - p.offset : p.top;
    view.assignedTop = el.scrollTop; updateJump(view);
  });
}
function readingView(el, key) {
  let view = messageViews.get(el);
  if (!view) {
    view = { el, key: '', entries: new Map(), days: new Map(), assignedTop: el.scrollTop, frame: 0, intent: null };
    view.jump = button('↓ 跳到最新', () => {
      view.intent = { position: { top: 0, follow: true, anchor: '', offset: 0 } };
      saveReading(view, { ...view.intent.position }); attempt(() => api.readingState(readingPositions)); scheduleReading(view);
    }, 'jump-latest'); view.jumpBar = node('div', undefined, 'jump-bar'); view.jumpBar.append(view.jump); view.jumpBar.hidden = true;
    const interact = () => { view.intent = null; view.assignedTop = undefined; };
    const scroll = () => {
      if (!el.clientHeight) return;
      const assigned = view.assignedTop; view.assignedTop = undefined;
      updateJump(view);
      if (el.scrollTop === assigned) return;
      view.intent = null; captureReading(view);
      // Hand the geometry to main now; it coalesces disk writes and flushes on
      // normal close. A renderer timer could lose the last scroll on close.
      attempt(() => api.readingState(readingPositions));
    };
    el.addEventListener('pointerdown', interact); el.addEventListener('wheel', interact, { passive: true }); el.addEventListener('keydown', interact); el.addEventListener('scroll', scroll, { passive: true });
    view.observer = new ResizeObserver(() => scheduleReading(view)); view.observer.observe(el);
    view.dispose = () => { view.observer.disconnect(); cancelAnimationFrame(view.frame); el.removeEventListener('pointerdown', interact); el.removeEventListener('wheel', interact); el.removeEventListener('keydown', interact); el.removeEventListener('scroll', scroll); ui.clearMarkdown(el); };
    messageViews.set(el, view);
  }
  if (view.key !== key) {
    captureReading(view); ui.clearMarkdown(el); el.replaceChildren();
    view.entries.clear(); view.days.clear(); view.key = key; view.folds = Object.assign(Object.create(null), readingPositions[key]?.folds || {});
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
function commandExplorations(messages, room = false, originals = messages) {
  const indices = new Map(originals.map((m, index) => [m.id, index]));
  const groups = new Map(); let group, previousKey, previousIndex;
  for (const message of messages) {
    const actions = message.commandActions;
    const eligible = message.toolKind === 'commandExecution' && message.nativeId && message.turnId && !message.incomplete &&
      message.commandSource !== 'userShell' && Array.isArray(actions) && actions.length && actions.every(a => a && ['read', 'listFiles', 'search'].includes(a.type) && typeof a.command === 'string');
    const key = JSON.stringify([message.nativeId, message.turnId, message.displayTurnId, message.sessionId, message.inputTag, message.promptId, message.sourceTag, message.replyTo, message.sharingStopped,
      room ? Number.isFinite(message.time) ? new Date(message.time).toLocaleDateString() : '' : '']);
    if (!eligible) { group = null; previousKey = null; continue; }
    if (!group || key !== previousKey || indices.get(message.id) !== previousIndex + 1) { group = { messages: [] }; groups.set(message.id, group); }
    group.messages.push(message); previousKey = key; previousIndex = indices.get(message.id);
    if (message.status === 'interrupted') { group = null; previousKey = null; }
  }
  for (const group of groups.values()) {
    const lines = []; let reads = [];
    const flush = () => { if (reads.length) lines.push('Read ' + [...new Set(reads)].join(', ')); reads = []; };
    for (const message of group.messages) {
      const actions = message.commandActions, nativeExit = Number.isSafeInteger(message.exitCode) && message.exitCode !== 0;
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
  if (entry.exploration) {
    entry.tail.hidden = open; entry.tail.textContent = entry.exploration.summary; entry.more.hidden = true; return;
  }
  // Like the native TUIs: a folded command keeps two one-line rows of output (the
  // newest while it runs, the first once done) and says how many more there are.
  const lines = (m.toolKind === 'commandExecution' || (!m.toolKind && m.title === 'Bash')) && !open && m.text ? m.text.replace(/\n+$/, '').split('\n') : [];
  const shown = ['running', 'streaming'].includes(m.status) ? lines.slice(-2) : lines.slice(0, 2), more = lines.length - shown.length, tail = shown.join('\n');
  entry.tail.hidden = !tail; if (entry.tail.textContent !== tail) entry.tail.textContent = tail;
  entry.more.hidden = !more; const moreText = `+${more} 行`; if (entry.more.textContent !== moreText) entry.more.textContent = moreText;
}
function messageList(el, messages, room = false, key = 'room', context = {}) {
  // A member reader observes its own session without selecting it or claiming
  // its input. Existing solo/shared callers retain their original context.
  const session = context.session || (room ? null : current());
  const view = readingView(el, key);
  captureReading(view);
  const intent = { position: readingPositions[key] || { top: 0, follow: true, anchor: '', offset: 0 } };
  view.intent = intent;
  const rows = [], retained = new Set(), days = new Set(), explorations = commandExplorations(messages, room, room ? state.room.messages : session?.messages || messages); let lastDay = '';
  for (const m of messages) {
    if (m.kind === 'turn' && !nativeCompletionText(m)?.trim()) continue;
    if (m.kind === 'summary' && !m.text?.trim() && !m.incomplete && !['failed', 'interrupted'].includes(m.status)) continue;
    if (room) {
      const day = Number.isFinite(m.time) ? new Date(m.time).toLocaleDateString() : '时间未记录';
      if (day !== lastDay) {
        let divider = view.days.get(day); if (!divider) { divider = node('div', day, 'timeline-day'); view.days.set(day, divider); }
        rows.push(divider); days.add(day); lastDay = day;
      }
    }
    let entry = view.entries.get(m.id);
    if (!entry) {
      const item = node('article'), heading = node('div', undefined, 'message-heading'), body = node('div', undefined, 'message-body'), actions = node('div', undefined, 'message-actions');
      item.dataset.messageId = m.id; item.append(heading, body, actions);
      entry = { item, heading, body, actions }; view.entries.set(m.id, entry);
      if (m.role === 'tool' || m.kind === 'summary') {
        const disclosure = node('details', undefined, 'process-details'), summary = node('summary'), content = node('div', undefined, 'process-content');
        entry.disclosure = disclosure; entry.preview = node('span', undefined, 'process-label'); entry.tail = node('pre', undefined, 'process-tail'); entry.content = content;
        entry.more = node('button', undefined, 'process-more'); entry.more.type = 'button';
        summary.append(heading); content.append(body); disclosure.append(summary, content); item.replaceChildren(disclosure, entry.tail, entry.more, actions);
        const rememberFold = () => {
          updateProcessTail(entry);
          const previous = view.folds[m.id];
          const previousOpen = typeof previous === 'boolean' ? previous : previous?.open;
          if (view.key !== key || previousOpen === disclosure.open) return;
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
      actions.append(button('复制', () => api.copy(entry.displayText ?? entry.message.text)));
      entry.share = button('选择并分享', () => share(entry.message.text)); actions.append(entry.share);
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
    entry.item.classList.toggle('native-notice', m.role === 'system' && (['notice', 'gap', 'context'].includes(m.kind) || !room && session?.nativeContexts?.some(c => c.boundaryId === m.id)));
    const nativeTitle = entry.exploration ? entry.exploration.active ? 'Exploring' : 'Explored' : m.toolKind === 'commandExecution' ? ['running', 'streaming'].includes(m.status) ? 'Running' : m.commandSource === 'userShell' ? 'You ran' : 'Ran' : m.kind === 'summary' && m.title === '过程摘要' || m.kind === 'plan' && m.title === '计划' || m.toolKind === 'webSearch' && ['搜索网页', '打开网页', '页内查找'].includes(m.title) || m.toolKind === 'fileChange' && m.title === '文件修改' ? '' : m.title;
    let name = room ? roomMessageLabel(m) : m.name;
    name ||= m.role === 'user' ? '你' : session?.provider === 'claude' ? 'Claude' : 'Codex';
    if (!room && m.role === 'system' && !m.sessionId) name = m.name || '原生会话';
    const messageTime = room && m.kind !== 'turn' ? m.time : undefined;
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
      if (Number.isFinite(messageTime)) { const time = node('time', new Date(messageTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); time.dateTime = new Date(messageTime).toISOString(); time.title = new Date(messageTime).toLocaleString(); entry.heading.append(time); }
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
    if (entry.text !== displayText || entry.role !== m.role || entry.streaming !== (m.status === 'streaming')) {
      if (entry.role && entry.role !== m.role) ui.clearMarkdown(entry.body);
      entry.text = displayText; entry.role = m.role; entry.streaming = m.status === 'streaming';
      if (m.role === 'assistant') ui.markdown(entry.body, m.text, entry.streaming, () => { if (view.key === key) scheduleReading(view); });
      else entry.body.textContent = displayText;
    }
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
  for (const [id, entry] of view.entries) if (!retained.has(id)) { ui.clearMarkdown(entry.item); entry.item.remove(); view.entries.delete(id); }
  for (const [day, divider] of view.days) if (!days.has(day)) { divider.remove(); view.days.delete(day); }
  if (!messages.length) {
    const s = session;
    const empty = s?.state === 'approval' || s?.nativeApproval ? '原生会话正在等待确认，请核对上方请求或同屏终端。' : s?.state === 'working' ? '原生会话正在工作，输出会在这里出现。' : '从这里开始。你也可以随时使用同一个会话的原生终端。';
    rows.push(node('p', room ? ($('room-search').value || $('room-filter').value ? '没有匹配的共享记录。私人会话内容不会出现在这里。' : '从一句话开始合作\n@ 选择接收者；共享消息和成员变化会留在这里。') : empty, 'message empty'));
  }
  rows.push(view.jumpBar);
  // Do not detach/reinsert unchanged rows: that would destroy live selections.
  let cursor = el.firstChild;
  for (const row of rows) { if (row === cursor) cursor = cursor.nextSibling; else el.insertBefore(row, cursor); }
  while (cursor) { const next = cursor.nextSibling; ui.clearMarkdown(cursor); cursor.remove(); cursor = next; }
  updateJump(view); scheduleReading(view, intent);
}
function disposeReadingViews() { for (const view of messageViews.values()) view.dispose(); messageViews.clear(); }
