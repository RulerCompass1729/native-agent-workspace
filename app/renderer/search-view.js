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
      const source = result.provider ? (result.provider === 'claude' ? 'Claude' : result.provider === 'dsh' ? 'DSH' : result.provider === 'agy' ? 'Antigravity' : result.provider === 'pi' ? 'pi' : 'Codex') + ' · ' + sessionShortId(result.sessionId) : uiText('search.sharedSpace');
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
  if (searchLimit >= 600) ui.display.text($('search-more'), 'search.narrow');
  else ui.display.text($('search-more'), 'disclosure.more', () => ({ count: Math.min(60, total - searchLimit), total }));
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
  if (entry.operatorTask) entry.operatorTask.open = true;
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
// Never equal to a composer's draft revision. The queue mark of this send lives apart from the composer's
// (deliverSessionInput's marks), so followQueuedInput neither sees it nor clears or refills a composer for it.
const SEARCH_SEND_REVISION = Symbol('search-send');
// Refused by the service before anything is recorded (with staleMethodRefusals): the same text may be sent again.
const searchSendRefusals = new Set(['error.nativeCommandUseTerminal', 'error.workspace.inputLimit']);
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
  // While a click waits (messages, the call) or its outcome is unconfirmed, the text and recipient stay as
  // confirmed; Cancel still works.
  const frozen = open.busy || Boolean(open.unconfirmed);
  $('send-text').readOnly = frozen;
  for (const row of open.rows) {
    const target = searchSendTarget(row), { label, radio, name, meta, detail } = row.ui;
    // A target that can no longer take it is let go, never swapped for another session.
    if (open.prefer === row.id && !target.blocked && !open.selected && !open.chosen) { open.selected = row.id; open.chosen = true; }
    if (target.blocked && open.selected === row.id && !frozen) {
      open.selected = '';
      if (!$('send-note').textContent || open.changed) ui.display.text($('send-note'), 'send.lost', () => ({ name: target.s ? participantLabel(target.s, state.sessions) : row.name }));
    }
    radio.disabled = target.blocked || frozen; radio.checked = open.selected === row.id;
    label.classList.toggle('blocked', target.blocked);
    const s = target.s;
    ui.display.computed(name, 'text', () => s?.name || row.name || sessionShortId(row.id));
    ui.display.computed(meta, 'text', () => {
      const status = target.blocked ? uiText('send.blocked') : target.method === 'send' ? stateText(s) : stateText(s) + ' · ' + searchSendLabel(target.action.labelKey);
      return [s && providerName(s.provider), sessionShortId(row.id), status].filter(Boolean).join(' · ');
    });
    if (target.hintKey && target.hintKey !== 'composer.keyboardHint') ui.display.text(detail, target.hintKey); else { ui.display.unbind(detail); detail.textContent = ''; }
  }
  open.newRow.ui.radio.checked = open.selected === 'new'; open.newRow.ui.radio.disabled = frozen;
  const chosen = open.rows.find(row => row.id === open.selected), target = chosen && searchSendTarget(chosen);
  const key = open.selected === 'new' ? 'send.next' : target && !target.blocked ? target.action.labelKey : 'composer.send';
  ui.display.computed($('send-confirm'), 'text', () => searchSendLabel(key));
  $('send-confirm').disabled = frozen || !text.trim() || (open.selected === 'new' ? creatingSession : !target || target.blocked);
  open.ui = true;
  const focused = document.activeElement;
  if ($('send-dialog').open && (!focused || focused === document.body || focused.disabled)) $('send-text').focus({ preventScroll: true });
}
function searchSendChoose(event) {
  if (!searchSend || event.target?.name !== 'send-target') return;
  if (searchSend.busy || searchSend.unconfirmed) return renderSearchSend();
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
  // An unconfirmed outcome was stated in the dialog; nothing more follows it once the dialog is gone.
  if (searchSendFollow?.phase === 'unconfirmed') searchSendFollow = null;
  $('send-list').replaceChildren(); $('send-text').value = ''; $('send-text').readOnly = false;
  ui.display.unbind($('send-note')); $('send-note').textContent = ''; ui.display.unbind($('send-confirm'));
  if ($('search-dialog').open) $('search-send').focus();
}
async function confirmSearchSend() {
  const open = searchSend;
  if (!open || open.busy || open.unconfirmed || !$('send-dialog').open || $('send-confirm').disabled) return;
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
    const receipt = await sendFollowStart(follow, s, pick, text, SEARCH_SEND_REVISION);
    if (searchSendFollow !== follow) return;
    sendFollowTag(follow, receipt);
    if (follow.phase === 'dialog') showSearchSendReceipt(follow); else updateSearchSendReceipt(follow);
  } catch (error) {
    if (follow?.phase === 'toast') {
      // The notice already names this message: its row records the outcome (not sent / unconfirmed) on the next state.
      await nextStateArrival(stateArrivals, Date.now() + 1500);
      if (searchSendFollow === follow) updateSearchSendReceipt(follow);
      if (searchSendFollow === follow) { searchSendFollow = null; toastError(error); }
      return;
    }
    // Only proof that nothing was sent offers the same words again. Otherwise the outcome stays unconfirmed:
    // its own row, whenever it reaches this window, decides (followSearchSend); no wait ends that by time.
    const failed = follow && searchSendFollow === follow && sendFollowFailure(follow, error);
    if (failed && !failed.notSent) {
      const queued = failed.row, shown = searchSend === open && $('send-dialog').open;
      // A row still awaiting native is about to record the outcome: the open dialog waits for it.
      if (queued && (queued.status !== 'awaiting-native' || !shown)) { showSearchSendReceipt(follow); return; }
      if (shown) { follow.phase = 'unconfirmed'; open.unconfirmed = true; ui.display.text($('send-note'), 'send.unconfirmed', () => ({ name: follow.name })); }
      else { searchSendFollow = null; toastMessage('send.unconfirmed', () => ({ name: follow.name })); }
      return;
    }
    if (follow && searchSendFollow === follow) searchSendFollow = null;
    if (searchSend === open && $('send-dialog').open) ui.showError($('send-note'), error);
    else toastError(error);
  } finally {
    if (searchSend === open) { open.busy = false; renderSearchSend(); }
  }
}
// One confirmed send, followed by its own message row: the send dialog's and a queue row's answer (follow: { id }).
// It keeps its own queue mark, never the composer's.
function sendFollowStart(follow, s, pick, text, revision) {
  const own = new Map(), call = deliverSessionInput(s, pick, text, revision, own);
  follow.mark = own.get(s.id);
  return call;
}
function sendFollowTag(follow, receipt) {
  follow.tag = typeof receipt === 'string' ? receipt : receipt?.tag || receipt?.id || follow.mark?.tag || '';
}
// This send's own queue row, found as followQueuedInput finds the composer's (queuedRowFor). The same words
// queued from the composer at the same moment are known only by this call's receipt.
function sendFollowRow(follow) {
  return queuedRowFor(state.sessions.find(x => x.id === follow.id), follow.mark);
}
// Proof that nothing was sent: this send's own row says so, or the service refused before recording anything.
function sendFollowNotSent(follow, error) {
  const row = follow.mark && sendFollowRow(follow);
  if (row) return row.status === 'not-sent';
  const key = error?.uiMessage?.key;
  return error?.notSent === true || Boolean(key) && (searchSendRefusals.has(key) || staleMethodRefusals.has(key));
}
// After a failed call: proven not sent (the same words may go again), or its own queue row, which then records the
// outcome; with neither, the outcome is unconfirmed and nothing sends it again.
function sendFollowFailure(follow, error) {
  if (sendFollowNotSent(follow, error)) return { notSent: true };
  const row = follow.mark && sendFollowRow(follow);
  if (row) follow.mark.tag = follow.tag = row.id;
  return { notSent: false, row };
}
// The notice reads the status of the message row itself (readingDeliveryStatusKey), never the fact that a call returned.
function sendFollowStatusKey(follow) {
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
  const key = sendFollowStatusKey(follow);
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
  const follow = searchSendFollow, row = (follow?.phase === 'dialog' || follow?.phase === 'unconfirmed') && follow.mark && sendFollowRow(follow);
  if (row) {
    follow.mark.tag = row.id;
    // Not sent: a waiting call's refusal follows and keeps the text; after an unconfirmed failure the text may go
    // again. A failed call's row still awaiting native records its outcome next.
    if (row.status === 'not-sent') {
      if (follow.phase === 'unconfirmed' && searchSend) {
        searchSendFollow = null; searchSend.unconfirmed = false;
        ui.display.text($('send-note'), 'delivery.recipient', () => ({ recipient: follow.name, status: uiText('delivery.notSent') }));
      }
    } else if (follow.phase === 'dialog' || row.status !== 'awaiting-native') showSearchSendReceipt(follow);
  } else if (follow?.phase === 'toast') updateSearchSendReceipt(follow);
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
// Answering a waiting queue row in place: the send dialog's confirmed send and receipt, to the session the item
// went to. Kept by item id across re-renders; a row handled without an answer in flight drops it.
const QUEUE_ANSWER_REVISION = Symbol('queue-answer');
const QUEUE_ANSWER_LIMIT = 6000;
const QUEUE_ANSWER_DELIVERED = new Set(['delivery.submitted', 'delivery.midturnRead', 'delivery.midturnStored']);
// Still on its way, as updateSearchSendReceipt reads the composer's send.
const QUEUE_ANSWER_PENDING = new Set(['delivery.awaiting', 'delivery.queued', 'delivery.queuedMidturn']);
const queueAnswers = new Map();
function queueAnswerItem(entry) {
  return (spaceRecord(entry.roomId)?.queue || []).find(item => item.id === entry.itemId) || null;
}
// The member is usually on its next item when the answer arrives: the first line says what it answers.
function queueAnswerQuote(item) {
  let head = globalThis.nativeWorkspaceTaskStream.decisionQuestion(item.reply).split(/[。！？；（(]|[.!?;](?:\s|$)/u)[0].trim();
  if (!head) return '';
  if (head.length > 40) head = head.slice(0, 39) + '…';
  return uiText('queue.answer.quote', { head }) + '\n';
}
// Only the session that holds the item, still running with the native session the item names and still in this
// space; otherwise the text goes only through the send dialog. A decision goes with its session to a successor
// (room-state.cjs queueCarry): the item then names the successor, and nothing here picks one by itself.
function queueAnswerTarget(entry, text = '.') {
  const s = state.sessions.find(x => x.id === entry.sentTo);
  if (!s || s.archived) return { gone: 'queue.answer.ended' };
  // An item sent before NAW kept sentNative cannot show which native session asked.
  if (!entry.nativeId) return { gone: 'queue.answer.unverified' };
  if (s.nativeId !== entry.nativeId) return { gone: 'queue.answer.ended' };
  if (!inSpace(s, entry.roomId)) return { gone: 'queue.answer.left' };
  if (!disconnected && ['none', 'resume'].includes(soloAction(s, { mode: 'chat' }).kind)) return { gone: 'queue.answer.ended' };
  return searchSendTarget({ id: s.id, nativeId: s.nativeId }, text);
}
// The row follows the item to the session that holds it now, with the words already typed; not while an answer
// is on its way, which stays with the session it was sent to.
function queueAnswerHolder(entry, item) {
  if (!item || entry.busy || entry.follow) return;
  entry.sentTo = item.sentTo; entry.nativeId = item.sentNative || '';
}
function queueAnswerNode(item, open) {
  let entry = queueAnswers.get(item.id);
  if (!open && !entry?.follow) return item.answer ? queueAnswerDelivered(item) : null;
  if (!entry) {
    entry = { roomId: queueSpace, itemId: item.id, sentTo: item.sentTo, nativeId: item.sentNative || '', text: queueAnswerQuote(item), follow: null, note: null };
    queueAnswers.set(item.id, entry);
  }
  queueAnswerHolder(entry, item);
  const block = node('div', undefined, 'queue-answer'), box = node('textarea');
  box.rows = 2; box.maxLength = QUEUE_ANSWER_LIMIT; box.value = entry.text; box.dataset.queueAnswer = item.id;
  ui.display.attribute(box, 'aria-label', 'queue.answer.label', () => ({ name: queueMemberName(entry.sentTo) }));
  box.addEventListener('input', () => { entry.text = box.value; entry.note = null; renderQueueAnswer(entry); });
  const foot = node('div', undefined, 'queue-answer-foot'), why = node('span', undefined, 'quiet'), send = node('button', undefined, 'small');
  send.type = 'button';
  send.addEventListener('click', () => attempt(() => queueAnswerSend(entry)));
  const line = node('div', undefined, 'queue-answer-line'), note = node('div', undefined, 'queue-answer-line warn');
  foot.append(why, send); block.append(box, foot, line, note);
  entry.ui = { box, foot, why, send, line, note };
  renderQueueAnswer(entry);
  return block;
}
// What the record keeps once native received the answer (room-state.cjs queueResolve).
function queueAnswerDelivered(item) {
  const block = node('div', undefined, 'queue-answer'), line = node('div', undefined, 'queue-answer-line'), strong = node('strong');
  ui.display.text(strong, 'delivery.row', () => ({ recipient: queueMemberName(item.sentTo), status: uiText('delivery.submitted') }));
  line.append(strong);
  block.append(line, node('div', item.answer.text, 'queue-answer-line'));
  return block;
}
function renderQueueAnswer(entry) {
  const parts = entry.ui;
  if (!parts) return;
  const { box, foot, why, send, line, note } = parts, follow = entry.follow;
  box.readOnly = Boolean(entry.busy || follow);
  foot.hidden = Boolean(follow); line.hidden = !follow;
  ui.display.unbind(note); note.textContent = ''; note.hidden = true;
  if (follow) {
    const key = follow.final || (follow.unconfirmed ? 'delivery.unconfirmed' : sendFollowStatusKey(follow));
    ui.display.text(line, 'delivery.row', () => ({ recipient: follow.name, status: uiText(key) }));
    line.classList.toggle('warn', key === 'delivery.unconfirmed');
    if (key === 'delivery.unconfirmed') { note.hidden = false; ui.display.text(note, 'send.unconfirmed', () => ({ name: follow.name })); }
    else if (entry.note?.error) { note.hidden = false; ui.showError(note, entry.note.error); }
    return;
  }
  const target = queueAnswerTarget(entry), name = () => ({ name: queueMemberName(entry.sentTo) });
  ui.display.unbind(why); why.textContent = '';
  why.classList.toggle('warn', Boolean(target.gone));
  if (target.gone) ui.display.text(why, target.gone, name);
  else if (target.blocked && target.hintKey && target.hintKey !== 'composer.keyboardHint') ui.display.text(why, target.hintKey);
  else if (entry.note?.error) ui.showError(why, entry.note.error);
  else if (entry.note) ui.display.text(why, entry.note.key, entry.note.params);
  send.classList.toggle('primary', !target.gone);
  if (target.gone) ui.display.text(send, 'search.send'); else ui.display.text(send, 'queue.answer.send', name);
  send.disabled = Boolean(entry.busy) || !entry.text.trim() || !target.gone && target.blocked;
}
async function queueAnswerSend(entry) {
  if (entry.busy || entry.follow) return;
  const text = entry.text;
  if (!text.trim() || queueAnswerItem(entry)?.status !== 'waiting') return;
  queueAnswerHolder(entry, queueAnswerItem(entry));
  const shown = queueAnswerTarget(entry);
  // The existing dialog with the text and no preferred session: the person picks one or 新开一个.
  if (shown.gone) return openSearchSend(text);
  if (shown.blocked) return;
  // What the button shows at this click: the recipient and the way it reaches them (as confirmSearchSend).
  const seen = { nativeId: shown.s.nativeId, method: shown.method, turnId: shown.turnId };
  entry.busy = true; entry.note = null; renderQueueAnswer(entry);
  try {
    const loading = ensureMessages([shown.s.id]);
    if (loading) await loading;
    const target = queueAnswerTarget(entry, text);
    if (target.gone || target.blocked || target.s.messagesOmitted || queueAnswerItem(entry)?.status !== 'waiting') return;
    const s = target.s, pick = sessionInputMethod(s);
    if (seen.nativeId !== s.nativeId || seen.method !== pick.method || seen.turnId !== (pick.turnId || '')) {
      entry.note = { key: 'send.changed', params: () => ({ name: participantLabel(s, state.sessions), action: searchSendLabel(soloAction(s, { mode: 'chat' }).labelKey) }) };
      return;
    }
    const follow = entry.follow = { id: s.id, name: participantLabel(s, state.sessions), text };
    reportShown();
    const call = sendFollowStart(follow, s, pick, text, QUEUE_ANSWER_REVISION);
    renderQueueAnswer(entry);
    try { sendFollowTag(follow, await call); }
    catch (error) {
      const failed = sendFollowFailure(follow, error);
      if (failed.notSent) { entry.follow = null; entry.note = { error }; reportShown(); }
      else if (!failed.row) follow.unconfirmed = true;
    }
  } finally {
    entry.busy = false;
    followQueueAnswer(entry);
  }
}
// Called after every state update (updateState), with followSearchSend.
function followQueueAnswers() {
  for (const entry of [...queueAnswers.values()]) followQueueAnswer(entry);
}
// Sessions whose receipt an answer still follows keep their messages, whatever the page shows (shownSessionIds).
function queueAnswerShownIds() {
  return [...queueAnswers.values()].filter(entry => entry.follow && !entry.follow.final).map(entry => entry.follow.id);
}
function followQueueAnswer(entry) {
  const item = queueAnswerItem(entry), follow = entry.follow;
  if (!item || item.status !== 'waiting' && (!follow || item.answer)) {
    queueAnswers.delete(entry.itemId);
    if (follow) reportShown();
    return;
  }
  if (follow?.final) return;
  if (follow?.mark && !follow.tag) { const row = sendFollowRow(follow); if (row) follow.mark.tag = follow.tag = row.id; }
  const row = follow?.tag && state.sessions.find(x => x.id === follow.id)?.messages?.find(m => m.id === follow.tag);
  // Its own row decides an unconfirmed call too; only a row that says not sent lets the same words go again.
  if (row?.status === 'not-sent') {
    entry.follow = null; reportShown();
    entry.note = { key: 'delivery.row', params: () => ({ recipient: follow.name, status: uiText('delivery.notSent') }) };
  } else if (follow?.unconfirmed && row && row.status !== 'awaiting-native') follow.unconfirmed = false;
  // Handled without this answer while it was on its way (the person's 已处理, which never reopens): once its own row
  // is final, the row keeps that status and the subscription ends.
  if (entry.follow && item.status !== 'waiting' && !QUEUE_ANSWER_PENDING.has(sendFollowStatusKey(follow))) {
    follow.final = sendFollowStatusKey(follow);
    reportShown();
  }
  if (entry.follow && !follow.unconfirmed && !entry.resolving && item.status === 'waiting' && QUEUE_ANSWER_DELIVERED.has(sendFollowStatusKey(follow))) queueAnswerResolve(entry);
  queueAnswerHolder(entry, item);
  renderQueueAnswer(entry);
}
// Handled as the person's 已处理 is, with the answer on the item; only once native received it.
async function queueAnswerResolve(entry) {
  entry.resolving = true;
  try {
    // With the session that received it (the item may name a successor by now) and the row it was delivered as.
    await api.spaceAction(entry.roomId, 'queueResolve', [entry.itemId, entry.follow.text, entry.follow.id, entry.follow.tag || entry.follow.mark?.tag || undefined]);
    updateState(await api.initial());
    renderQueue();
  } catch (error) {
    if (queueAnswerItem(entry)?.status === 'waiting') { entry.note = { error }; renderQueueAnswer(entry); }
  }
}
// Rows are rebuilt when the queue changes: the box being written in keeps its focus and selection.
function queueAnswerFocus() {
  const box = document.activeElement;
  return box?.dataset?.queueAnswer ? { id: box.dataset.queueAnswer, start: box.selectionStart, end: box.selectionEnd } : null;
}
function restoreQueueAnswerFocus(kept) {
  const box = kept && queueAnswers.get(kept.id)?.ui?.box;
  if (!box || !box.isConnected || document.activeElement === box) return;
  box.focus({ preventScroll: true });
  box.setSelectionRange(kept.start, kept.end);
}
