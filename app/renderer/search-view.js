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
  searchShownSessions = new Set(results.map(result => result.sessionId).filter(Boolean));
  const list = $('search-results');
  list.replaceChildren();
  for (const result of results) {
    const row = button('', () => openSearchResult(result), 'search-result');
    row.dataset.searchKey = result.key;
    const metadata = node('small');
    ui.display.computed(metadata, 'text', () => {
      const source = result.provider ? (result.provider === 'claude' ? 'Claude' : result.provider === 'dsh' ? 'DSH' : 'Codex') + ' · ' + sessionShortId(result.sessionId) : uiText('search.sharedSpace');
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
// Send this to… (product V22 (a)): a sentence typed here reaches one session only after the person picks it in the
// send dialog and confirms, through deliverSessionInput like the composer. The sentence lives only in these variables:
// never in a draft, views.json or the create parameters. Candidates are a local string match, no model.
let searchShownSessions = new Set(), searchSend = null, searchSendFollow = null, searchSendNew = null, searchSendRetry = null;
// Never equal to a composer's draft revision, so followQueuedInput never clears or refills a composer for this send.
const SEARCH_SEND_REVISION = Symbol('search-send');
const searchSendLabel = key => uiText(key).replace(/\s*↑$/u, '');
function searchSendCandidates(text, first = '') {
  const lower = text.toLocaleLowerCase();
  const live = state.sessions.filter(s => s.id !== first && soloAction(s, { mode: 'chat' }).kind === 'send');
  const named = live.filter(s => {
    const name = (s.name || '').trim();
    return [...name].length >= 2 && lower.includes(name.toLocaleLowerCase());
  });
  const rest = live.filter(s => !named.includes(s)).sort((a, b) => {
    const shown = Number(searchShownSessions.has(b.id)) - Number(searchShownSessions.has(a.id));
    if (shown) return shown;
    return (Number.isFinite(b.lastActivityAt) ? b.lastActivityAt : 0) - (Number.isFinite(a.lastActivityAt) ? a.lastActivityAt : 0);
  });
  const forced = first ? state.sessions.filter(s => s.id === first) : [];
  return { named, rows: [...forced, ...named, ...rest].slice(0, 3) };
}
function updateSearchSend() {
  const control = $('search-send'), text = $('search-input').value.trim();
  ui.display.unbind(control);
  control.hidden = !state || !text;
  if (control.hidden) { control.textContent = ''; control.classList.remove('primary'); return; }
  const { named } = searchSendCandidates(text);
  control.classList.toggle('primary', named.length === 1);
  if (named.length === 1) ui.display.text(control, 'search.sendNamed', () => ({ name: participantLabel(named[0], state.sessions) }));
  else ui.display.text(control, 'search.send');
}
// One row of the send dialog, judged by the same gate as the composer (sessionSendDisabled). A placeholder text
// keeps an empty box from marking every row as unable to receive; the real text is checked at the click.
function searchSendTarget(row, text = '.') {
  const s = state.sessions.find(x => x.id === row.id);
  if (!s || row.nativeId && s.nativeId !== row.nativeId) return { s: null, blocked: true, hintKey: 'send.gone' };
  const action = soloAction(s, { mode: 'chat' }), changing = Boolean(sessionComposers.get(s.id)?.changing);
  const blocked = action.kind !== 'send' || sessionSendDisabled(s, action, text, changing);
  const hintKey = inputRecoveries.get(s.id)?.text.value ? 'composer.unconfirmedHint' : changing || pendingMode?.id === s.id ? 'composer.changingHint' : action.hintKey;
  const pick = sessionInputMethod(s);
  return { s, action, blocked, hintKey, method: pick.method, turnId: pick.turnId || '' };
}
function openSearchSend(text, first = '') {
  if (!state || $('send-dialog').open) return;
  const { named, rows } = searchSendCandidates(text, first);
  const open = searchSend = { rows: rows.map(s => ({ id: s.id, nativeId: s.nativeId, name: s.name })), selected: '', busy: false, prefer: first, chosen: false };
  const list = $('send-list');
  list.replaceChildren();
  for (const row of [...open.rows, { id: 'new' }]) {
    const label = node('label'), radio = node('input'), name = node('strong'), meta = node('small'), detail = node('span', undefined, 'send-detail');
    radio.type = 'radio'; radio.name = 'send-target'; radio.value = row.id;
    label.append(radio, name, meta);
    if (row.id === 'new') { ui.display.text(name, 'send.newSession'); ui.display.text(meta, 'send.newSessionHelp'); }
    else label.append(detail);
    row.ui = { label, radio, name, meta, detail };
    if (row.id === 'new') open.newRow = row;
    list.append(label);
  }
  const pick = first ? open.rows.find(row => row.id === first) : named.length === 1 ? open.rows.find(row => row.id === named[0].id) : null;
  if (pick && !searchSendTarget(pick).blocked) { open.selected = pick.id; open.chosen = true; }
  $('send-text').value = text;
  ui.display.unbind($('send-note')); $('send-note').textContent = '';
  renderSearchSend();
  $('send-dialog').showModal();
  $('send-text').focus();
}
function renderSearchSend() {
  const open = searchSend;
  if (!open || !state || !$('send-dialog').open && open.ui) return;
  const text = $('send-text').value;
  for (const row of open.rows) {
    const target = searchSendTarget(row), { label, radio, name, meta, detail } = row.ui;
    // A target that can no longer take it is let go, never swapped for another session.
    if (open.prefer === row.id && !target.blocked && !open.selected && !open.chosen) { open.selected = row.id; open.chosen = true; }
    if (target.blocked && open.selected === row.id && !open.busy) {
      open.selected = '';
      if (!$('send-note').textContent || open.changed) ui.display.text($('send-note'), 'send.lost', () => ({ name: target.s ? participantLabel(target.s, state.sessions) : row.name }));
    }
    radio.disabled = target.blocked; radio.checked = open.selected === row.id;
    label.classList.toggle('blocked', target.blocked);
    const s = target.s;
    ui.display.computed(name, 'text', () => s?.name || row.name || sessionShortId(row.id));
    ui.display.computed(meta, 'text', () => {
      const status = target.blocked ? uiText('send.blocked') : target.method === 'send' ? stateText(s) : stateText(s) + ' · ' + searchSendLabel(target.action.labelKey);
      return [s && providerName(s.provider), sessionShortId(row.id), status].filter(Boolean).join(' · ');
    });
    if (target.hintKey && target.hintKey !== 'composer.keyboardHint') ui.display.text(detail, target.hintKey); else { ui.display.unbind(detail); detail.textContent = ''; }
  }
  open.newRow.ui.radio.checked = open.selected === 'new';
  const chosen = open.rows.find(row => row.id === open.selected), target = chosen && searchSendTarget(chosen);
  const key = open.selected === 'new' ? 'send.next' : target && !target.blocked ? target.action.labelKey : 'composer.send';
  ui.display.computed($('send-confirm'), 'text', () => searchSendLabel(key));
  $('send-confirm').disabled = open.busy || !text.trim() || (open.selected === 'new' ? creatingSession : !target || target.blocked);
  open.ui = true;
  const focused = document.activeElement;
  if ($('send-dialog').open && (!focused || focused === document.body || focused.disabled)) $('send-text').focus({ preventScroll: true });
}
function searchSendChoose(event) {
  if (!searchSend || event.target?.name !== 'send-target') return;
  searchSend.selected = event.target.value; searchSend.chosen = true; searchSend.changed = false;
  ui.display.unbind($('send-note')); $('send-note').textContent = '';
  renderSearchSend();
}
function closeSearchSendDialogs() {
  searchNavigating = true; // the search dialog does not take focus back: what opens next does
  if ($('send-dialog').open) $('send-dialog').close();
  if ($('search-dialog').open) $('search-dialog').close();
}
function finishSearchSend() {
  if ($('send-dialog').open) return;
  searchSend = null;
  $('send-list').replaceChildren(); $('send-text').value = '';
  ui.display.unbind($('send-note')); $('send-note').textContent = ''; ui.display.unbind($('send-confirm'));
  if ($('search-dialog').open) $('search-send').focus();
}
async function confirmSearchSend() {
  const open = searchSend;
  if (!open || open.busy || !$('send-dialog').open || $('send-confirm').disabled) return;
  const text = $('send-text').value;
  if (!text.trim()) return;
  if (open.selected === 'new') return startSearchSendNew(open, text);
  const row = open.rows.find(row => row.id === open.selected);
  if (!row) return;
  // What the button shows at this click: the recipient and the way it reaches them.
  const shown = searchSendTarget(row), seen = shown.s && { nativeId: shown.s.nativeId, method: shown.method, turnId: shown.turnId };
  if (!seen) return;
  open.busy = true; renderSearchSend(); // set before any wait: a second click in the same task finds it locked
  let follow;
  try {
    const loading = ensureMessages([row.id]);
    if (loading) await loading;
    if (searchSend !== open || !$('send-dialog').open) return;
    // Checked again at the click: the state may have changed since the row was drawn.
    const target = searchSendTarget(row, text);
    if (target.blocked || target.s.messagesOmitted) {
      open.busy = false; renderSearchSend();
      if (open.selected === row.id) { open.selected = ''; ui.display.text($('send-note'), 'send.lost', () => ({ name: target.s ? participantLabel(target.s, state.sessions) : row.name })); }
      return;
    }
    const s = target.s, pick = sessionInputMethod(s);
    // The click confirms the way it showed, not what the session turned into while messages loaded: a changed way
    // (queue, steer, send) or turn sends nothing and asks again; it is never switched by itself.
    if (seen.nativeId !== s.nativeId || seen.method !== pick.method || seen.turnId !== (pick.turnId || '')) {
      open.busy = false; open.changed = true; renderSearchSend();
      ui.display.text($('send-note'), 'send.changed', () => ({ name: participantLabel(s, state.sessions), action: searchSendLabel(soloAction(s, { mode: 'chat' }).labelKey) }));
      return;
    }
    follow = searchSendFollow = { id: s.id, name: participantLabel(s, state.sessions), phase: 'dialog' };
    reportShown();
    const call = deliverSessionInput(s, pick, text, SEARCH_SEND_REVISION);
    if (pick.method === 'queue') follow.mark = queuedInputs.get(s.id);
    const receipt = await call;
    if (searchSendFollow !== follow) return;
    follow.tag = typeof receipt === 'string' ? receipt : receipt?.tag || receipt?.id || follow.mark?.tag || '';
    if (follow.phase === 'dialog') showSearchSendReceipt(follow); else updateSearchSendReceipt(follow);
  } catch (error) {
    if (follow?.phase === 'toast') {
      // The notice already names this message: its row records the outcome (not sent / unconfirmed) on the next state.
      await nextStateArrival(stateArrivals, Date.now() + 1500);
      if (searchSendFollow === follow) updateSearchSendReceipt(follow);
      if (searchSendFollow === follow) { searchSendFollow = null; toastError(error); }
      return;
    }
    // A queued message is recorded before native answers, and the refusal can come before its row reaches this
    // window. Unless the row proves it was not sent, the dialog closes on the row's status rather than offer the
    // same words a second time (as the composer clears an uncertain queued draft).
    if (follow?.mark && searchSendFollow === follow) {
      const until = Date.now() + 1500;
      let queued = searchSendQueuedRow(follow);
      while ((!queued || queued.status === 'awaiting-native') && Date.now() < until) { await nextStateArrival(stateArrivals, until); queued = searchSendQueuedRow(follow); }
      if (queued && queued.status !== 'not-sent' && searchSendFollow === follow) { follow.tag = queued.id; showSearchSendReceipt(follow); return; }
    }
    if (follow && searchSendFollow === follow) searchSendFollow = null;
    if (searchSend === open && $('send-dialog').open) ui.showError($('send-note'), error);
    else toastError(error);
  } finally {
    if (searchSend === open) { open.busy = false; renderSearchSend(); }
  }
}
// The new queue row for these words, found as followQueuedInput finds it; the mark itself is gone once the call ends.
function searchSendQueuedRow(follow) {
  const s = state.sessions.find(x => x.id === follow.id), mark = follow.mark;
  return s?.messages?.find(m => mark.tag ? m.id === mark.tag : m.inputMode === 'queue' && !mark.before.has(m.id) && [mark.text, mark.text.trim()].includes(m.text));
}
// The notice reads the status of the message row itself (readingDeliveryStatusKey), never the fact that a call returned.
function searchSendStatusKey(follow) {
  const s = state.sessions.find(x => x.id === follow.id), tag = follow.tag || follow.mark?.tag;
  const row = tag && s?.messages?.find(m => m.id === tag);
  return row ? readingDeliveryStatusKey(row, row) : 'delivery.awaiting';
}
function showSearchSendReceipt(follow) {
  follow.phase = 'toast';
  closeSearchSendDialogs();
  sessionNotice('', follow.id);
  follow.button = $('toast').querySelector('.toast-action');
  follow.key = '';
  updateSearchSendReceipt(follow);
}
function updateSearchSendReceipt(follow) {
  // The notice was closed or another one took its place: stop following.
  if (follow.key && ($('toast').hidden || $('toast').querySelector('.toast-action') !== follow.button || $('toast-text').textContent !== follow.render())) { if (searchSendFollow === follow) searchSendFollow = null; return; }
  const key = searchSendStatusKey(follow);
  if (key !== follow.key) {
    follow.key = key;
    follow.render = () => uiText('delivery.recipient', { recipient: follow.name, status: uiText(key) });
    ui.display.computed($('toast-text'), 'text', follow.render);
  }
  if (!['delivery.awaiting', 'delivery.queued', 'delivery.queuedMidturn'].includes(key) && searchSendFollow === follow) searchSendFollow = null;
}
function searchSendShownId() { return searchSendFollow?.id || searchSendNew?.id || ''; }
// Called after every state update (updateState).
function followSearchSend() {
  const follow = searchSendFollow;
  if (follow?.phase === 'dialog' && follow.mark?.tag) showSearchSendReceipt(follow);
  else if (follow?.phase === 'toast') updateSearchSendReceipt(follow);
  resumeSearchSendNew();
  if ($('search-dialog').open && !$('send-dialog').open) updateSearchSend();
  if ($('send-dialog').open) renderSearchSend();
}
// 新开一个: the existing create dialog, unchanged. The sentence waits in memory; a cancelled or failed create drops it.
function startSearchSendNew(open, text) {
  if (creatingSession) return;
  open.busy = true;
  const prior = new Set(state.sessions.map(s => s.id));
  closeSearchSendDialogs();
  openCreate();
  const ticket = dialogTickets.get($('create-dialog'));
  searchSendNew = $('create-dialog').open && ticket ? { text, ticket, prior, id: '' } : null;
}
function resumeSearchSendNew() {
  clearTimeout(searchSendRetry);
  const pending = searchSendNew;
  if (!pending || !state) return;
  if (!pending.id) {
    if (currentDialogTicket(pending.ticket)) return;
    const { created, creation } = pending.ticket;
    const id = typeof created === 'string' && created !== 'unconfirmed' ? created : creation?.sessionId || '';
    if (!id || pending.prior.has(id)) { searchSendNew = null; return; }
    pending.id = id;
  }
  const s = state.sessions.find(x => x.id === pending.id);
  if (!s) { searchSendNew = null; return; }
  // The create flow is still selecting the new session; it ends without a state push of its own.
  if (creatingSession) { searchSendRetry = setTimeout(resumeSearchSendNew, 100); return; }
  if (document.querySelector('dialog[open]') || s.state === 'starting') return;
  searchSendNew = null;
  openSearchSend(pending.text, pending.id);
}
