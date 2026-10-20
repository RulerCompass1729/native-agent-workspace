// Search is a local reading action. Opening a result never restores, sends,
// changes membership or takes control of another window's native session.
let searchLimit = 60, searchTimer, searchOrigin, searchReturn;
const searchOptions = () => ({
  scope: $('search-scope').value, sessionId: searchOrigin?.sessionId || '',
  archived: $('search-archived').checked, limit: searchLimit,
});
function openSearch(scope = 'all') {
  if (!state || document.querySelector('dialog[open]')) return;
  captureReadingViews();
  searchOrigin = { selected, roomSession, mode, sessionId: activeSessionId(), reading: structuredClone(readingPositions),
    roomSearch: $('room-search').value, roomFilter: $('room-filter').value || pendingRoomFilter };
  const currentOption = $('search-scope').querySelector('[value="current"]');
  currentOption.disabled = !current();
  currentOption.textContent = current() ? `当前会话：${current().name}` : '当前会话';
  $('search-scope').value = scope === 'current' && !current() ? 'room' : scope;
  $('search-input').value = ''; $('search-archived').checked = Boolean(current()?.archived);
  searchLimit = 60; renderSearch(); $('search-dialog').showModal(); $('search-input').focus();
}
function renderSearch() {
  clearTimeout(searchTimer);
  if (!searchOrigin) return;
  ui.clearMarkdown($('search-preview-body')); $('search-preview').hidden = true; $('search-results').hidden = false;
  const { results, total } = window.nativeWorkspaceSearch.searchRecords(state, $('search-input').value, searchOptions());
  const list = $('search-results');
  list.replaceChildren();
  for (const result of results) {
    const row = button('', () => openSearchResult(result), 'search-result');
    row.dataset.searchKey = result.key;
    const source = result.provider ? `${result.provider === 'claude' ? 'Claude' : 'Codex'} · ${result.sessionId.slice(0, 6)}` : '协作空间';
    row.append(node('strong', result.name), node('small', `${source}${result.archived ? ' · 已归档' : ''}${result.role ? ` · ${result.role === 'user' || result.role === 'human' ? '你' : result.role === 'system' ? '事件' : 'Agent'}` : ''}`));
    if (result.kind === 'message' || result.kind === 'shared') row.append(node('span', result.text));
    list.append(row);
  }
  $('search-count').textContent = total ? `${Math.min(total, searchLimit)} / ${total} 条结果` : '没有匹配记录';
  $('search-more').hidden = total <= searchLimit;
  $('search-more').disabled = searchLimit >= 600;
  $('search-more').textContent = searchLimit >= 600 ? '请缩小搜索范围' : '显示更多';
  if (!total) list.append(node('p', '试试会话名称或正文中的关键词。归档内容可在上方勾选。', 'quiet'));
}
function pointToMessage(element, key, id, query = '') {
  const view = messageViews.get(element), entry = view?.entries.get(id);
  if (!view || view.key !== key || !entry) return false;
  const position = { top: element.scrollTop, follow: false, anchor: id, offset: 16 };
  view.intent = { position, searchQuery: query }; saveReading(view, position); scheduleReading(view);
  document.querySelectorAll('[data-search-target]').forEach(el => delete el.dataset.searchTarget);
  entry.item.dataset.searchTarget = 'true'; entry.item.tabIndex = -1; entry.item.focus({ preventScroll: true });
  return true;
}
async function openSearchResult(result) {
  clearTimeout(searchTimer);
  if (result.kind === 'shared' || result.kind === 'room') {
    if (result.messageId && !timeline().some(m => m.id === result.messageId)) { renderSearch(); toast('这条共享记录已移除，搜索结果已更新。'); return; }
    if (state.room.archived) {
      const message = result.messageId ? timeline().find(m => m.id === result.messageId) : null;
      const text = message?.text ?? `${state.room.name}\n\n${state.room.messages.length} 条共享消息。${state.room.notes ? `\n\n共享笔记：\n${state.room.notes}` : ''}`;
      const body = $('search-preview-body'); ui.clearMarkdown(body);
      body.textContent = text;
      $('search-preview-title').textContent = `${state.room.name} · 已归档，只读`;
      $('search-preview-copy').onclick = () => attempt(() => api.copy(text));
      $('search-results').hidden = true; $('search-more').hidden = true; $('search-preview').hidden = false;
      $('search-preview-back').focus();
      return;
    }
  } else {
    const s = state.sessions.find(s => s.id === result.sessionId);
    if (!s || (result.messageId && !s.messages.some(m => m.id === result.messageId))) { renderSearch(); toast('记录已变化，搜索结果已更新。'); return; }
  }
  const origin = searchOrigin, query = $('search-input').value;
  $('search-dialog').close();
  if (result.kind === 'shared' || result.kind === 'room') {
    $('room-search').value = ''; $('room-filter').value = ''; pendingRoomFilter = '';
    await selectRoom();
    if (result.messageId) pointToMessage($('room-messages'), 'room', result.messageId, query);
  } else {
    await select(result.sessionId, 'chat');
    if (result.messageId) pointToMessage($('messages'), result.sessionId, result.messageId, query);
  }
  searchReturn = origin;
  $('return-reading').hidden = false;
  await persistView();
}
async function returnToReading() {
  const target = searchReturn; if (!target) return;
  if (target.selected !== 'room' && target.selected && !state.sessions.some(s => s.id === target.selected)) { toast('原会话已移除。'); return; }
  if (target.selected === 'room' && state.room.archived) { toast('原工作区已归档。'); return; }
  searchReturn = null; $('return-reading').hidden = true;
  document.querySelectorAll('[data-search-target]').forEach(el => delete el.dataset.searchTarget);
  $('room-search').value = target.roomSearch;
  $('room-filter').value = target.roomFilter; pendingRoomFilter = target.roomFilter;
  await select(target.selected, target.mode, target.roomSession);
  // select() captures the outgoing view. Restore the original geometry only
  // after that capture, and only for the destination of this explicit action.
  const key = target.selected === 'room' && !target.roomSession ? 'room' : target.sessionId;
  const view = messageViews.get(key === 'room' ? $('room-messages') : $('messages'));
  if (target.reading[key] && view?.key === key) {
    saveReading(view, target.reading[key]); view.intent = { position: target.reading[key] }; scheduleReading(view);
  }
  await persistView();
}
function searchKey(event) {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  // Cmd-F on macOS does not steal native Ctrl-F. Windows/Linux Ctrl-F remains
  // available to a focused terminal; the visible Search action always works.
  const find = event.key.toLowerCase() === 'f' && (event.metaKey || (event.ctrlKey && mode !== 'terminal'));
  if (!find || event.altKey || event.shiftKey || document.querySelector('dialog[open]')) return;
  event.preventDefault(); openSearch(current() ? 'current' : selected === 'room' ? 'room' : 'all');
}
