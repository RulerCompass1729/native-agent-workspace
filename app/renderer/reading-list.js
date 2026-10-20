// Per-window reading state. Only IDs and geometry are persisted, never selection.
const messageViews = new Map();
let readingPositions = {};
function saveReading(view, position) {
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
function scheduleReading(view, intent = view.intent) {
  if (!intent || view.intent !== intent || view.frame) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = 0;
    if (!view.intent || !view.el.clientHeight || !view.el.getClientRects().length) return;
    const el = view.el, p = view.intent.position;
    const anchor = view.entries.get(p.anchor)?.item;
    el.scrollTop = p.follow ? el.scrollHeight : anchor ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - p.offset : p.top;
    view.assignedTop = el.scrollTop;
  });
}
function readingView(el, key) {
  let view = messageViews.get(el);
  if (!view) {
    view = { el, key: '', entries: new Map(), days: new Map(), assignedTop: el.scrollTop, frame: 0, intent: null };
    const interact = () => { view.intent = null; view.assignedTop = undefined; };
    const scroll = () => {
      if (!el.clientHeight) return;
      const assigned = view.assignedTop; view.assignedTop = undefined;
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
    view.entries.clear(); view.days.clear(); view.key = key;
    // The new list is empty until Markdown mounts; never capture that temporary
    // zero as this session's saved reading position.
    view.intent = { position: readingPositions[key] || { top: 0, follow: true, anchor: '', offset: 0 } };
    el.scrollTop = 0; view.assignedTop = 0;
  }
  return view;
}
function messageList(el, messages, room = false, key = 'room') {
  const view = readingView(el, key);
  captureReading(view);
  const intent = { position: readingPositions[key] || { top: 0, follow: true, anchor: '', offset: 0 } };
  view.intent = intent;
  const rows = [], retained = new Set(), days = new Set(); let lastDay = '';
  for (const m of messages) {
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
      actions.append(button('复制', () => api.copy(entry.message.text)));
      entry.share = button('选择并分享', () => share(entry.message.text)); actions.append(entry.share);
      if (room) {
        entry.openRecipient = button('查看会话', () => select(entry.message.recipientId, 'chat'));
        actions.append(entry.openRecipient);
        entry.context = button('查看上下文', () => {
          $('room-search').value = ''; $('room-filter').value = ''; renderTimeline();
          const original = view.entries.get(m.id)?.item;
          if (original) {
            // Newly unfiltered Markdown above this row can still be mounting.
            // Keep the explicit target anchored until the reader interacts.
            const position = { top: el.scrollTop, follow: false, anchor: m.id, offset: 16 };
            view.intent = { position }; saveReading(view, position); scheduleReading(view);
            original.tabIndex = -1; original.focus({ preventScroll: true });
          }
          attempt(persistView);
        }); actions.append(entry.context);
      }
    }
    entry.message = m; retained.add(m.id); rows.push(entry.item);
    entry.item.className = `message ${m.role}`;
    const participant = room && state.sessions.find(s => s.id === (m.role === 'human' ? m.recipientId : m.sessionId));
    let name = participant ? (m.role === 'human' ? `你 → ${participantLabel(participant, state.sessions)}` : participantLabel(participant, state.sessions)) : m.name;
    name ||= m.role === 'user' ? '你' : current()?.provider === 'claude' ? 'Claude' : 'Codex';
    if (m.role === 'system' && !m.sessionId) name = '工作区';
    const headingKey = JSON.stringify([name, m.status, room && m.time, m.manualReply]);
    if (entry.headingKey !== headingKey) {
      entry.heading.replaceChildren(node('strong', name)); entry.headingKey = headingKey;
      if (room && Number.isFinite(m.time)) { const time = node('time', new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); time.dateTime = new Date(m.time).toISOString(); time.title = new Date(m.time).toLocaleString(); entry.heading.append(time); }
      const status = { 'awaiting-native': '等待原生确认', unconfirmed: '提交结果未确认', streaming: '正在回复', 'reply-private': '分享已失效，回复保留在原会话' }[m.status];
      if (status) entry.heading.append(node('span', status));
      else if (m.manualReply && m.status === 'submitted') entry.heading.append(node('span', '原生已接收 · 回复由你选定后分享'));
    }
    entry.share.hidden = m.role === 'system';
    if (entry.openRecipient) entry.openRecipient.hidden = !m.manualReply || !state.sessions.some(s => s.id === m.recipientId && !s.archived);
    if (entry.context) entry.context.hidden = !($('room-search').value || $('room-filter').value);
    if (entry.text !== m.text || entry.role !== m.role || entry.streaming !== (m.status === 'streaming')) {
      if (entry.role && entry.role !== m.role) ui.clearMarkdown(entry.body);
      entry.text = m.text; entry.role = m.role; entry.streaming = m.status === 'streaming';
      if (m.role === 'assistant') ui.markdown(entry.body, m.text, entry.streaming, () => { if (view.key === key) scheduleReading(view); });
      else entry.body.textContent = m.text;
    }
  }
  for (const [id, entry] of view.entries) if (!retained.has(id)) { ui.clearMarkdown(entry.item); entry.item.remove(); view.entries.delete(id); }
  for (const [day, divider] of view.days) if (!days.has(day)) { divider.remove(); view.days.delete(day); }
  if (!messages.length) rows.push(node('p', room ? ($('room-search').value || $('room-filter').value ? '没有匹配的共享记录。私人会话内容不会出现在这里。' : '从一句话开始合作\n@ 选择接收者；共享消息和成员变化会留在这里。') : '从这里开始。你也可以随时使用同一个会话的原生终端。', 'message empty'));
  // Do not detach/reinsert unchanged rows: that would destroy live selections.
  let cursor = el.firstChild;
  for (const row of rows) { if (row === cursor) cursor = cursor.nextSibling; else el.insertBefore(row, cursor); }
  while (cursor) { const next = cursor.nextSibling; ui.clearMarkdown(cursor); cursor.remove(); cursor = next; }
  scheduleReading(view, intent);
}
function disposeReadingViews() { for (const view of messageViews.values()) view.dispose(); messageViews.clear(); }
