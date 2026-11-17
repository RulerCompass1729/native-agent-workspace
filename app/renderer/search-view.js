// Search is a local reading action. Opening a result never restores, sends,
// changes membership or takes control of another window's native session.
// searchRevision: main runs the search (local-search.js), since the page holds the messages only of the
// sessions it shows; the newest call draws and an older reply is dropped.
let searchLimit = 60, searchTimer, searchOrigin, searchReturn, searchRevision = 0;
let searchOpener, searchNavigating = false;
const searchOptions = () => ({
  scope: $('search-scope').value, sessionId: searchOrigin?.sessionId || '',
  archived: $('search-archived').checked, limit: searchLimit,
});
function openSearch(scope = 'all') {
  if (!state || document.querySelector('dialog[open]')) return;
  searchOpener = document.activeElement; searchNavigating = false;
  captureReadingViews();
  searchOrigin = { spaceId, selected, roomSession, roomSurface, mode, sessionId: activeSessionId(), reading: structuredClone(readingPositions),
    roomSearch: $('room-search').value, roomFilter: $('room-filter').value || pendingRoomFilter, roomThread, roomRecordScope, roomRecordReturn: roomRecordReturn && { ...roomRecordReturn }, roomFilterHistory: roomFilterHistory && { ...roomFilterHistory } };
  const currentOption = $('search-scope').querySelector('[value="current"]');
  currentOption.disabled = !current();
  const focused = current();
  ui.display.computed(currentOption, 'text', () => focused ? uiText('search.currentName', { name: archivedName(focused) }) : uiText('search.current'));
  $('search-scope').value = scope === 'current' && !current() ? 'room' : scope;
  $('search-input').value = ''; $('search-archived').checked = Boolean(current()?.archived);
  $('search-options').open = false;
  searchLimit = 60; $('search-dialog').showModal(); renderSearch(); $('search-input').focus();
}
async function renderSearch() {
  clearTimeout(searchTimer);
  if (!searchOrigin || !$('search-dialog').open) return;
  ui.clearMarkdown($('search-preview-body')); $('search-preview').hidden = true; $('search-results').hidden = false;
  const revision = ++searchRevision;
  let found;
  try { found = await api.search($('search-input').value, { ...searchOptions(), spaceId }); }
  catch (error) { if (revision === searchRevision) toastError(error); return; }
  if (revision !== searchRevision || !searchOrigin || !$('search-dialog').open) return;
  const { results, total } = found;
  const list = $('search-results');
  list.replaceChildren();
  for (const result of results) {
    const row = button('', () => openSearchResult(result), 'search-result');
    row.dataset.searchKey = result.key;
    const metadata = node('small');
    ui.display.computed(metadata, 'text', () => {
      const source = result.provider ? (result.provider === 'claude' ? 'Claude' : 'Codex') + ' · ' + sessionShortId(result.sessionId) : uiText('search.sharedSpace');
      return [source, result.archived && uiText('search.archivedFlag'), result.role && uiText(['user', 'human'].includes(result.role) ? 'reading.you' : result.role === 'system' ? 'search.event' : 'search.agent')].filter(Boolean).join(' · ');
    });
    // A space's archived flag stays in the small line; an archived session's name carries the marker.
    const name = node('strong'); if (result.nameKey) ui.display.text(name, result.nameKey); else ui.display.computed(name, 'text', () => result.roomId ? result.name : archivedName(result, result.name));
    row.append(name, metadata);
    if (result.kind === 'message' || result.kind === 'shared') row.append(node('span', result.text));
    list.append(row);
  }
  const shown = Math.min(total, searchLimit);
  ui.display.computed($('search-count'), 'text', () => { const number = new Intl.NumberFormat(ui.language.getSnapshot().active); return total ? uiText('search.count', { shown: number.format(shown), total: number.format(total) }) : uiText('search.empty'); });
  ui.display.computed($('search-options-summary'), 'text', () => [uiText({ all: 'search.allRecords', current: 'search.current', room: 'search.shared' }[$('search-scope').value] || 'search.allRecords'), $('search-archived').checked && uiText('search.includeArchived')].filter(Boolean).join(' · '));
  $('search-more').hidden = total <= searchLimit;
  $('search-more').disabled = searchLimit >= 600;
  ui.display.text($('search-more'), searchLimit >= 600 ? 'search.narrow' : 'common.more');
  if (!total) { const label = node('p', undefined, 'quiet'); ui.display.text(label, 'search.emptyHelp'); list.append(label); }
  return true;
}
function searchInputKey(event) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('search-dialog').close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  event.preventDefault();
  const key = event.key;
  // Only on the list this key asked for: not an older one left after a failed or overtaken search.
  renderSearch().then(drawn => {
    if (!drawn) return;
    const rows = $('search-results').querySelectorAll('button');
    if (key === 'Enter') rows[0]?.click();
    else (key === 'ArrowUp' ? rows[rows.length - 1] : rows[0])?.focus();
  });
}
function searchResultKey(event) {
  if (event.isComposing || event.keyCode === 229 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = [...$('search-results').querySelectorAll('button')], index = rows.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  if (event.key === 'ArrowUp' && index === 0) { $('search-input').focus(); return; }
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1)) % rows.length;
  rows[next]?.focus();
}
function finishSearch() {
  if ($('search-dialog').open) return;
  clearTimeout(searchTimer); ui.clearMarkdown($('search-preview-body')); ui.display.unbind($('search-preview-body')); ui.display.unbind($('search-preview-title')); $('search-preview-body').textContent = '';
  $('search-input').value = ''; $('search-archived').checked = false; $('search-scope').value = 'all'; $('search-options').open = false;
  $('search-results').replaceChildren(); ui.display.unbind($('search-count')); $('search-count').textContent = ''; $('search-preview-title').textContent = '';
  $('search-preview-copy').onclick = null; $('search-preview').hidden = true; $('search-more').hidden = true;
  ui.display.text($('search-options-summary'), 'search.allRecords'); searchLimit = 60;
  if (!searchNavigating) (searchOpener?.isConnected && searchOpener.getClientRects().length ? searchOpener : $('search-button')).focus();
}
function pointToMessage(element, key, id, query = '') {
  const view = messageViews.get(element);
  if (!view || view.key !== key) return false;
  if (!readingEntry(view, id)) view.loadMessage?.(id);
  const entry = readingEntry(view, id);
  if (!entry) return false;
  const position = { top: element.scrollTop, follow: false, anchor: id, offset: 16 };
  view.intent = { position, searchQuery: query }; saveReading(view, position); scheduleReading(view);
  document.querySelectorAll('[data-search-target]').forEach(el => delete el.dataset.searchTarget);
  entry.item.dataset.searchTarget = 'true'; entry.item.tabIndex = -1; entry.item.focus({ preventScroll: true });
  return true;
}
async function openSearchResult(result) {
  clearTimeout(searchTimer); searchRevision++; // a list still on its way does not draw over what opens now
  if (result.kind === 'shared' || result.kind === 'room') {
    const room = spaceRecord(result.roomId || 'shared'), records = room ? [...room.messages, ...(room.events || [])] : [];
    if (!room || result.messageId && !records.some(m => m.id === result.messageId)) { renderSearch(); toast(uiText('search.sharedRemoved')); return; }
    if (room.archived) {
      const message = result.messageId ? records.find(m => m.id === result.messageId) : null;
      const previewText = () => message?.text ?? uiText('search.roomPreview', { name: spaceName(room), count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(room.messages.length), notes: room.notes ? uiText('search.notes', { notes: room.notes }) : '' });
      const body = $('search-preview-body'); ui.clearMarkdown(body); ui.display.unbind(body);
      if (message) body.textContent = message.text;
      else ui.display.computed(body, 'text', previewText);
      ui.display.text($('search-preview-title'), 'search.archivedTitle', () => ({ name: spaceName(room) }));
      // Copy the current visible summary. The original recorded body is never
      // translated, and an in-flight copy retains the text captured on click.
      $('search-preview-copy').onclick = () => attempt(() => api.copy(previewText()));
      $('search-results').hidden = true; $('search-more').hidden = true; $('search-preview').hidden = false;
      $('search-preview-back').focus();
      return;
    }
  } else {
    const loading = result.messageId && ensureMessages([result.sessionId]);
    if (loading) await loading;
    const s = state.sessions.find(s => s.id === result.sessionId);
    if (!s || (result.messageId && (s.messagesOmitted || !s.messages.some(m => m.id === result.messageId)))) { renderSearch(); toast(uiText('search.changed')); return; }
  }
  const origin = searchOrigin, query = $('search-input').value;
  searchNavigating = true;
  $('search-dialog').close();
  if (result.kind === 'shared' || result.kind === 'room') {
    await showRoomRecord(result.roomId || 'shared', result.messageId || '', query);
  } else if (origin.selected === 'room' && members().some(s => s.id === result.sessionId)) {
    roomSurface = 'overview';
    await select('room', 'chat', result.sessionId);
    if (result.messageId) pointToMessage($('messages'), focusedReadingKey(result.sessionId), result.messageId, query);
  } else {
    await select(result.sessionId, 'chat');
    if (result.messageId) pointToMessage($('messages'), result.sessionId, result.messageId, query);
  }
  searchReturn = origin;
  $('return-reading').hidden = false;
  await persistView();
}
async function showBackgroundConfirmation(target) {
  const loading = ensureMessages([target.sessionId]);
  if (loading) await loading;
  const record = state.sessions.find(s => s.id === target.sessionId && s.nativeId === target.nativeId);
  const row = record?.messagesOmitted ? null : record?.messages.find(m => m.id === target.messageId);
  if (!row?.backgroundOperation || !target.history && row.backgroundOperation.state !== 'confirmation-required' ||
      row.backgroundOperation.nativeId !== target.nativeId || target.operationId && row.backgroundOperation.id !== target.operationId) { toast(uiText('search.changed')); return false; }
  await select(record.id, 'chat');
  return pointToMessage($('messages'), record.id, row.id);
}
async function showRoomRecord(roomId, messageId, query = '') {
  const room = typeof roomId === 'string' && spaceRecord(roomId);
  const records = room ? [...(room.messages || []), ...(room.events || [])] : [];
  if (!room || room.archived || typeof messageId !== 'string' || messageId && !records.some(m => m.id === messageId)) {
    toast(uiText('search.sharedRemoved')); return false;
  }
  await selectSpace(roomId);
  const stream = getActivityStream();
  if (stream) { stream.open(roomId, '', messageId); return true; }
  roomRecordScope = ''; roomRecordReturn = null;
  $('room-search').value = ''; $('room-filter').value = ''; pendingRoomFilter = ''; roomThread = '';
  roomSurface = 'records';
  await selectRoom();
  if (messageId) pointToMessage($('room-messages'), roomReadingKey(), messageId, query);
  return true;
}
async function returnToReading() {
  const target = searchReturn; if (!target) return;
  if (target.selected !== 'room' && target.selected && !state.sessions.some(s => s.id === target.selected)) { toast(uiText('search.sessionRemoved')); return; }
  if (target.selected === 'room' && (!spaceRecord(target.spaceId || 'shared') || spaceRecord(target.spaceId || 'shared').archived)) { toast(uiText('search.roomUnavailable')); return; }
  searchReturn = null; $('return-reading').hidden = true;
  document.querySelectorAll('[data-search-target]').forEach(el => delete el.dataset.searchTarget);
  if (spaceId !== (target.spaceId || 'shared')) await selectSpace(target.spaceId || 'shared');
  $('room-search').value = target.roomSearch;
  roomThread = target.roomThread || '';
  $('room-filter').value = target.roomFilter; pendingRoomFilter = target.roomFilter;
  roomSurface = target.roomSurface || 'overview';
  await select(target.selected, target.mode, target.roomSession);
  if (target.selected === 'room' && roomSurface === 'records') {
    roomRecordScope = target.roomRecordScope || ''; roomRecordReturn = target.roomRecordReturn && { ...target.roomRecordReturn };
    roomFilterHistory = target.roomFilterHistory && { ...target.roomFilterHistory }; lastRoomMessages = ''; render();
  }
  // select() captures the outgoing view. Restore the original geometry only
  // after that capture, and only for the destination of this explicit action.
  const inRoom = target.selected === 'room' && !target.roomSession;
  const key = inRoom ? roomReadingKey() : focusedReadingKey(target.sessionId);
  const view = messageViews.get(inRoom ? $('room-messages') : $('messages'));
  if (target.reading[key] && view?.key === key) {
    saveReading(view, target.reading[key]); view.intent = { position: target.reading[key] }; scheduleReading(view);
  }
  if (target.selected === 'room' && roomSurface === 'overview' && !target.roomSession) {
    for (const pane of messageViews.values()) if (pane.key.startsWith('collaboration:') && target.reading[pane.key]) {
      saveReading(pane, target.reading[pane.key]); pane.intent = { position: target.reading[pane.key] }; scheduleReading(pane);
    }
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
