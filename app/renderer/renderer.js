/* Views consume session capabilities; they never own native processes. */
const api = window.workspace;
const uiText = (key, params) => ui.language.text(key, params);
const uiError = (key, params) => ui.createError(key, params);
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const button = (text, action, cls) => { const el = node('button', text, cls); el.type = 'button'; el.addEventListener('click', () => attempt(action)); return el; };
const uiNode = (tag, key, params, cls) => { const el = node(tag, undefined, cls); ui.display.text(el, key, params); return el; };
const uiButton = (key, action, cls, params) => { const el = button('', action, cls); ui.display.text(el, key, params); return el; };
const states = { starting: 'state.starting', idle: 'state.idle', working: 'state.working', approval: 'state.approval', stopping: 'state.stopping', disconnected: 'state.disconnected', recoverable: 'state.recoverable', ended: 'state.ended', background: 'state.background', error: 'state.error' };
const stateText = record => uiText(states[record.state] || 'state.unknown');
// An unfollowed native /resume leaves the process running in another session.
const switchedAway = record => record.state === 'stopping' && record.nativeContextPending?.reason === 'resume';
function exhaustedRecovery(record) {
  const recovery = record.capacityRecovery;
  if (disconnected || record.archived || record.backendUnavailable || record.transportDisconnected ||
      record.nativeContextPending || record.approval || record.approvalOverflow || record.claudeQuestion || record.nativeApproval || record.nativeInputRequired ||
      !['idle', 'error'].includes(record.state) || typeof record.nativeId !== 'string' || !record.nativeId ||
      recovery?.nativeId !== record.nativeId || typeof recovery.turnId !== 'string' || !recovery.turnId ||
      recovery.status !== 'exhausted' || recovery.attempt !== 3 || !['capacity', 'routing'].includes(recovery.reason)) return null;
  return recovery;
}
function recoveryStatusSuffix(recovery, prefix = true) {
  return recovery ? (prefix ? ' · ' : '') + uiText(recovery.reason === 'routing' ? 'capacityBadge.routingStopped' : 'capacityBadge.capacityStopped') + uiText('capacityBadge.retried', { count: recovery.attempt }) : '';
}
const sessionStatus = (record, recoveryBadge = false) => {
  const status = window.nativeWorkspaceFleet.fleetStatus(record, switchedAway(record) ? uiText('state.switched') : record.claudeQuestion ? uiText('state.question') : stateText(record), !disconnected, uiText);
  return status + recoveryStatusSuffix(recoveryBadge && exhaustedRecovery(record));
};
let state, owner, selected = '', mode = 'terminal', preference = 'terminal', folder = '', disconnected = false;
let newDirectory = false, creatingSession = false;
let gitWorktreePlan = null, gitWorktreeNonce = '', gitPreviewRevision = 0, gitPreviewLoading = false, gitPreviewTimer;
let latestViewStorage, latestViewStorageUiMessage;
let roomSession = '', selectionRevision = 0, pendingMode;
let roomSurface = 'overview', roomOverview;
let panorama, panoramaOrigin, roomReturnReading;
let panoramaView = { layout: 'list', query: '', spaceId: '', top: 0, returning: false };
let spaceId = 'shared', sidebarView = 'flat', hoverSpace = '';
let sidebarCollapsedGroups = new Set();
// T-135: each grid column's terminal height, by session, saved with this window's view.
let columnTerminalHeights = {};
const COLUMN_TERMINAL = { initial: 112, min: 64, most: 4000, step: 16, conversation: 80 };
let roomViews = Object.create(null);
const roomHistories = new Map(), spaceRows = new Map(), sidebarGroups = new Map();
const inSpace = (s, id = spaceId) => window.nativeWorkspaceSpaces.isMember(s, id);
const pairRevision = (s, id = spaceId) => window.nativeWorkspaceSpaces.membershipRevision(s, id);
const allSpaces = () => state?.rooms || (state?.room ? [state.room] : []);
const spaceRecord = id => allSpaces().find(r => r.id === id);
const spaceCall = (action, ...args) => api.spaceAction(spaceId, action, args);
const roomViewFields = ['sharedDraft', 'roomSession', 'roomRecipient', 'roomMention', 'roomFilter', 'roomSearch', 'roomThread', 'roomReplyTo', 'roomSurface'];
const focusedRoomMember = () => selected === 'room' && roomSurface === 'overview' && Boolean(roomSession);
const sharedSurface = () => selected === 'room' && !focusedRoomMember();
const focusedReadingKey = id => focusedRoomMember() ? spaceId === 'shared' ? `collaboration-focus:${id}` : `focus:${spaceId}:${id}` : id;
let terminalLayout = 'split';
// Chat share of a side-by-side split; dragging the divider near the centre snaps to half.
let terminalSplit = 0.5, splitDragging = false;
const chatInput = () => sharedSurface() ? $('shared-input') : $('message-input');
const nativeStatusFresh = value => value?.stale !== true && (!Number.isFinite(value?.observedAt) || Date.now() - value.observedAt <= 5000);
let roomSubmitting = null;
const roomPendingRecipients = new Map();
const pendingInterrupts = new Set();
const interruptPending = s => Boolean(s && (s.interruptPending || pendingInterrupts.has(s.id)));
const approvalViews = new Map();
let shareRevision = 0, sharePending = null, shareSpaceId = 'shared';
let runPreview = null;
let renameTarget = null, renaming = false, renameRevision = 0, renameComposing = false;
let sessionMenu;
let roomMenu, mentionOptions = [], mentionIndex = 0, mentionRange = null, mentionRoster = '', roomMention = null, roomMentionEdit = null, notesRevision, contextTarget = null;
let roomDraftRevision = 0;
let roomMentionHistory = nativeWorkspaceMentions.editHistory();
let mentionChanging = false, mentionComposing = false;
let pendingRoomFilter = '';
let roomThread = '', roomReplyTo = '';
let roomThreads = window.nativeWorkspaceThreads.threadIndex([]);
const roomReadingKey = () => spaceId === 'shared' ? roomThread ? `room:${roomThread}` : 'room' : `room:${spaceId}:${roomThread || 'main'}`;
const sessionRows = new Map();
const sessionRow = id => sessionRows.get(id) || [...sessionRows.values()].find(row => row.sessionId === id && row.element.getClientRects().length) || [...sessionRows.values()].find(row => row.sessionId === id);
const roomTone = id => `space-tone-${Math.max(0, allSpaces().findIndex(r => r.id === id)) % 6}`;
function highlightSpace(id) {
  hoverSpace = id;
  for (const row of sessionRows.values()) {
    const s = state.sessions.find(s => s.id === row.sessionId), member = s && id && inSpace(s, id);
    row.element.classList.toggle('space-highlight', Boolean(member)); row.element.classList.toggle('space-dim', Boolean(id && !member));
  }
}
function bindSpaceHighlight(element, id) {
  element.addEventListener('pointerenter', () => highlightSpace(id)); element.addEventListener('pointerleave', () => highlightSpace(''));
  element.addEventListener('focusin', () => highlightSpace(id)); element.addEventListener('focusout', event => { if (!element.contains(event.relatedTarget)) highlightSpace(''); });
}
function oldBackendJoin(record) {
  const version = versionValue(record.runtimeVersion);
  return uiError(version ? 'error.legacySpaceJoinVersion' : 'error.legacySpaceJoin', { name: participantLabel(record, state.sessions), ...(version ? { version } : {}) });
}
async function addToSpace(id, destination) {
  const room = spaceRecord(destination), record = state.sessions.find(s => s.id === id);
  if (!room || room.archived || !record || record.archived) throw uiError("error.spaceChanged");
  if (!window.nativeWorkspaceSpaces.canJoin(record, destination)) throw oldBackendJoin(record);
  const receipt = await api.spaceAction(destination, 'join', [id, true]);
  updateState(await api.initial()); render();
  if (!receipt?.changed) return toastMessage("toast.alreadyMember", { arg1: room.name });
  toastMessage("toast.joinedSpace", { arg1: room.name }, { label: uiText('action.undoJoin'), labelKey: 'action.undoJoin', nameKey: 'action.undoJoinName', params: { name: room.name }, run: async () => {
    await api.spaceAction(destination, 'join', [id, false, { revision: receipt.revision, nativeId: receipt.nativeId }]);
    updateState(await api.initial()); render(); toastMessage("toast.undoJoinDone", { arg1: spaceRecord(destination)?.name || room.name });
  } });
}
let sidebarLayout;
let inviteOrigin;
let headerControls, advancedControls;
let terminalDisplay = { fontSize: 13, palette: 'dark' };
const terminalThemes = {
  // The maintainer's iTerm2 default profile, dark-mode colours (user request, T-14).
  // Native programs' own truecolour output is drawn as sent, never remapped.
  dark: { background: '#15191f', foreground: '#dcdcdc', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#b3d7ff', selectionForeground: '#000000',
    black: '#14191e', red: '#b43c2a', green: '#00c200', yellow: '#c7c400', blue: '#2744c7', magenta: '#c040be', cyan: '#00c5c7', white: '#c7c7c7',
    brightBlack: '#686868', brightRed: '#dd7975', brightGreen: '#58e790', brightYellow: '#ece100', brightBlue: '#a7abf2', brightMagenta: '#e17ee1', brightCyan: '#60fdff', brightWhite: '#ffffff' },
  green: { background: '#20261f', foreground: '#eef2e8', cursor: '#e0edc9', selectionBackground: '#637a5988' },
};
let toastTimer, lastMessages = '', lastRoomMessages = '', rendering = false;
const terminals = new Map();

// Older retained services expose a bounded progress journal, not native blocks.
// Read its existing records inline without creating a second terminal surface.
const legacyProgress = new Map();
const legacyProgressGeneration = s => JSON.stringify([s.nativeId, s.connectionRevision, s.backendId, s.runtimeVersion]);
const legacyProgressOffline = s => disconnected || !s || s.transportDisconnected || s.backendUnavailable || ['disconnected', 'error', 'recoverable', 'ended', 'background'].includes(s.state) ||
  (!s.legacyProgress && !(s.serviceCapabilities || state.capabilities || []).includes('observe'));
function freezeLegacyProgress(s) {
  const cache = legacyProgress.get(s.id);
  if (!cache) return;
  cache.suspended = true; cache.loading = false; cache.pending = []; cache.pendingBytes = 0;
}
function applyLegacyProgress(cache, event) {
  if (event.revision <= cache.revision) return;
  if (cache.revision >= 0 && event.revision !== cache.revision + 1) cache.truncated = true;
  cache.revision = event.revision; cache.truncated ||= event.truncated;
  for (const id of event.removed || []) cache.items.delete(id);
  if (event.item) cache.items.set(event.item.id, event.item);
  let bytes = [...cache.items.values()].reduce((n, item) => n + JSON.stringify(item).length, 0);
  while (cache.items.size > 200 || bytes > 1024 * 1024) {
    const first = cache.items.keys().next().value; bytes -= JSON.stringify(cache.items.get(first)).length;
    cache.items.delete(first); cache.truncated = true;
  }
}
function readLegacyProgress(s) {
  if (s.nativeBlockMapping) return;
  if (legacyProgressOffline(s)) { freezeLegacyProgress(s); return; }
  const generation = legacyProgressGeneration(s);
  const previous = legacyProgress.get(s.id);
  if (previous?.generation === generation && !previous.suspended) return;
  const cache = { items: new Map(previous?.generation === generation ? previous.items : []), revision: -1, truncated: false, generation, loading: true, pending: [], pendingBytes: 0, refreshing: !!previous?.suspended }; legacyProgress.set(s.id, cache);
  while (legacyProgress.size > 12) legacyProgress.delete(legacyProgress.keys().next().value);
  api.observe(s.id).then(value => {
    const latest = state?.sessions.find(item => item.id === s.id);
    if (legacyProgress.get(s.id) !== cache || cache.suspended || !latest || legacyProgressGeneration(latest) !== generation) return;
    if (legacyProgressOffline(latest)) { freezeLegacyProgress(latest); return; }
    if (!value?.progress) throw new Error('Missing progress snapshot');
    const progress = value.progress;
    cache.items = new Map(progress.items.map(item => [item.id, item])); cache.revision = progress.revision; cache.truncated ||= progress.truncated;
    for (const event of cache.pending) applyLegacyProgress(cache, event);
    cache.pending = []; cache.pendingBytes = 0; cache.loading = false; cache.refreshing = false; render();
  }).catch(() => { if (legacyProgress.get(s.id) !== cache || cache.suspended) return; cache.pending = []; cache.pendingBytes = 0; cache.loading = false; cache.unavailable = true; render(); });
}
function sessionMessages(s) {
  const cache = legacyProgress.get(s.id);
  if (s.nativeBlockMapping || !cache) return s.messages;
  if (legacyProgressOffline(s)) freezeLegacyProgress(s);
  const stale = cache.suspended || cache.refreshing || cache.unavailable;
  const rows = [...cache.items.values()].map(item => ({ ...item, id: `legacy-observation:${item.id}`, role: 'tool',
    title: `${item.title || '原生过程'} · ${stale ? '最后记录' : '旧连接记录'}`, legacyOriginalTitle: item.title || '', legacyOriginalTitleUiMessage: item.uiTitleMessage, uiTitleMessage: ui.createNotice('notice.legacyTitle', { title: '', status: stale ? 'last' : 'old' }).uiMessage, status: stale && ['running', 'streaming'].includes(item.status) ? 'unconfirmed' : item.status,
    volatile: true, incomplete: item.truncated }));
  if (stale) rows.push({ id: 'legacy-observation-offline', role: 'system', ...ui.createNotice('notice.legacyOffline') });
  if (cache.unavailable || cache.truncated) rows.push({ id: 'legacy-observation-gap', role: 'system', ...ui.createNotice('notice.legacyGap'), incomplete: true });
  // Legacy records have no authoritative ordering against saved final replies.
  // Keep their own original order, rather than inventing a merged chronology.
  return s.messages.concat(rows);
}
function updateLegacyProgress(event) {
  const s = state?.sessions.find(s => s.id === event.id);
  if (!s || s.nativeBlockMapping) return;
  if (legacyProgressOffline(s)) { freezeLegacyProgress(s); return; }
  let cache = legacyProgress.get(s.id);
  if (!cache || cache.suspended || cache.generation !== legacyProgressGeneration(s)) { readLegacyProgress(s); cache = legacyProgress.get(s.id); }
  if (!cache || event.revision <= cache.revision) return;
  if (cache.loading) {
    cache.pending.push(event); cache.pendingBytes += JSON.stringify(event).length;
    while (cache.pending.length > 200 || cache.pendingBytes > 1024 * 1024) { cache.pendingBytes -= JSON.stringify(cache.pending.shift()).length; cache.truncated = true; }
  }
  applyLegacyProgress(cache, event);
  if (activeSessionId() === s.id && mode === 'chat' || selected === 'room' && members().some(member => member.id === s.id)) render();
}

const inputRecoveries = new Map();
const draftRevisions = new Map();
const pendingDrafts = new Map();
const sessionComposers = new Map();
const composerPlaceholder = { form: $('composer'), input: $('message-input'), send: $('send-button'), hint: $('compose-hint') };
const composerTemplate = composerPlaceholder.form.cloneNode(true), composerInterrupt = $('interrupt');
let soloComposer = null, inputFocusRevision = 0;
document.addEventListener('focusin', () => { inputFocusRevision++; });
const composerParking = node('div'); composerParking.hidden = true; document.querySelector('.naw').append(composerParking);
const terminalParking = node('div'); terminalParking.hidden = true; document.querySelector('.naw').append(terminalParking);
function composerIds(parts, active) {
  for (const [part, id] of [['form', 'composer'], ['input', 'message-input'], ['send', 'send-button'], ['hint', 'compose-hint']]) {
    if (active) parts[part].id = id; else parts[part].removeAttribute('id');
  }
}
function getSessionComposer(id) {
  let binding = sessionComposers.get(id); if (binding) return binding;
  const form = composerTemplate.cloneNode(true); form.querySelector('#interrupt').remove();
  for (const el of [form, ...form.querySelectorAll('[id]')]) el.removeAttribute('id');
  form.dataset.composerSession = id;
  binding = { id, column: false, visible: false, revision: 0, changing: false };
  binding.ui = window.nativeWorkspaceComposer.create({ form, nativeText: uiText('composer.nativeInput'),
    onInput: () => saveSessionDraft(binding), onError: error => toastError(error),
    onFocus: () => { if (!binding.column && mode !== 'chat' && inputFocusAllowed()) attempt(() => switchMode('chat')); },
    onCompositionEnd: () => { if (binding.syncAfterComposition) { binding.syncAfterComposition = false; binding.ui.setValue(state.sessions.find(s => s.id === id)?.liveDraft || ''); } },
    onSubmit: () => submitSession(binding), onAction: () => sessionComposerAction(binding),
    onNative: () => activateColumnNative(binding), onImages: (_, files) => pasteImages(files, undefined, id),
  });
  binding.ui.input.dataset.composerSession = id;
  binding.ui.setValue(pendingDrafts.get(id)?.text ?? state?.sessions.find(s => s.id === id)?.liveDraft ?? '');
  sessionComposers.set(id, binding); composerParking.append(form); return binding;
}
function activateSoloComposer(id) {
  const next = id ? getSessionComposer(id) : null;
  if (soloComposer === next) return next;
  if (soloComposer) { composerIds(soloComposer.ui, false); composerParking.append(soloComposer.ui.form); }
  composerIds(composerPlaceholder, false); composerPlaceholder.form.hidden = true;
  soloComposer = next;
  if (next) {
    next.column = false; next.visible = true; composerIds(next.ui, true);
    next.ui.send.before(composerInterrupt); $('composer-wrap').append(next.ui.form);
  } else {
    composerIds(composerPlaceholder, true); composerPlaceholder.send.before(composerInterrupt);
  }
  return next;
}
function composerCurrent(binding) {
  return sessionComposers.get(binding.id) === binding && binding.visible && binding.ui.form.isConnected &&
    (binding.column ? selected === 'room' && !roomSession && roomSurface === 'overview' && members().some(s => s.id === binding.id) : activeSessionId() === binding.id);
}
function saveSessionDraft(binding) {
  const s = state?.sessions.find(s => s.id === binding.id);
  if (!s || s.owner !== owner || !composerCurrent(binding)) return;
  const revision = (draftRevisions.get(s.id) || 0) + 1; draftRevisions.set(s.id, revision);
  const pending = { text: binding.ui.input.value, revision }; pendingDrafts.set(s.id, pending); s.liveDraft = pending.text;
  attempt(async () => {
    try { await api.draft(s.id, pending.text); }
    catch (error) { if (draftRevisions.get(s.id) === revision && pending.text) rememberDraftRecovery(s.id, pending.text); throw error; }
    finally { if (pendingDrafts.get(s.id) === pending) pendingDrafts.delete(s.id); if (activeSessionId() === s.id) renderDraftRecovery(s.id); }
  });
  updateSessionComposer(binding, s, binding.column);
}
async function submitSession(binding) {
  const s = state.sessions.find(s => s.id === binding.id), action = soloAction(s, { column: binding.column, mode: binding.column ? 'chat' : mode });
  if (!composerCurrent(binding) || binding.ui.send.disabled || binding.ui.composing || action.kind !== 'send') return;
  if (inputFocusAllowed()) binding.ui.input.focus();
  const { id, nativeId } = s, text = binding.ui.input.value, revision = draftRevisions.get(id);
  const mark = s.state === 'working' && s.queueAvailable && { text, revision, before: new Set(s.messages.map(m => m.id)) };
  if (mark) queuedInputs.set(id, mark);
  let receipt;
  try { receipt = mark ? await api.queue(id, text, nativeId) : s.state === 'working' && s.steerAvailable && s.activeTurnId
    ? await api.steer(id, text, nativeId, s.activeTurnId) : await api.send(id, text, nativeId); }
  finally { if (mark && !mark.tag && queuedInputs.get(id) === mark) queuedInputs.delete(id); }
  const fresh = state.sessions.find(s => s.id === id);
  if (!receipt?.contextChanged && fresh?.owner === owner && fresh?.nativeId === nativeId && !fresh.nativeContextPending && draftRevisions.get(id) === revision && binding.ui.input.value === text) binding.ui.setValue('');
}
async function sessionComposerAction(binding) {
  if (!composerCurrent(binding) || binding.ui.send.disabled) return;
  const s = state.sessions.find(s => s.id === binding.id), action = soloAction(s, { column: binding.column, mode: binding.column ? 'chat' : mode });
  if (binding.column) {
    if (action.kind === 'terminal') return activateColumnNative(binding);
    if (['claim', 'chat'].includes(action.kind)) return changeColumnView(binding, 'chat', action.kind === 'claim');
    if (action.kind === 'connect') {
      await api.prepareInput(s.id); if (!composerCurrent(binding)) return;
      updateState(await api.initial()); render();
      if (s.provider === 'claude') await activateColumnNative(binding); return;
    }
    if (action.kind === 'resume') { await api.resume(s.id); return; }
    return;
  }
  if (action.kind === 'terminal') await switchMode('terminal');
  else if (action.kind === 'chat') await switchMode('chat');
  else if (action.kind === 'connect') {
    const revision = selectionRevision; await api.prepareInput(s.id);
    if (revision !== selectionRevision || !composerCurrent(binding)) return;
    if (s.provider === 'codex') { updateState(await api.initial()); render(); if (composerCurrent(binding) && !binding.ui.input.readOnly && inputFocusAllowed()) binding.ui.input.focus(); return; }
    await switchMode('terminal');
    if (current()?.id === s.id && mode === 'terminal') toastMessage("toast.reloadInputPlugin");
  } else if (action.kind === 'claim') await switchMode(s.chatAvailable === false && !s.legacyInputEligible ? 'terminal' : 'chat', true);
  else if (action.kind === 'resume') await api.resume(s.id);
}
function cancelColumnComposition(entry) {
  if (!entry) return;
  if (entry.composing && entry.compositionOrigin) entry.compositionOrigin.cancelled = true;
  if (entry.composition && !entry.composition.consumed) entry.composition.cancelled = true;
}
function suspendColumnInputs() {
  for (const binding of sessionComposers.values()) if (binding.column && binding.visible) {
    binding.revision++; binding.resizeAllowed = false; cancelViewInput(terminals.get(binding.id));
    const entry = terminals.get(binding.id);
    if (entry) { cancelColumnComposition(entry); if (entry.composing) entry.term.blur(); }
    binding.ui.suspend();
  }
}
function renderColumnInput(host, record, visible) {
  const binding = getSessionComposer(record.id);
  const wasVisible = binding.column && binding.visible;
  binding.columnHost = host; binding.nativeHost ||= node('div', undefined, 'column-native-host');
  if (binding !== soloComposer) {
    binding.column = true; binding.visible = visible;
    if (wasVisible && !visible) { binding.revision++; binding.resizeAllowed = false; cancelViewInput(terminals.get(record.id)); binding.ui.suspend(); const entry = terminals.get(record.id); if (entry) { cancelColumnComposition(entry); entry.term.blur(); } }
    if (visible) {
      if (binding.nativeHost.parentElement !== host) host.append(binding.nativeHost); if (binding.ui.form.parentElement !== host) host.append(binding.ui.form);
      const sash = columnTerminalSash(binding);
      if (sash.nextSibling !== binding.nativeHost) host.insertBefore(sash, binding.nativeHost);
    }
    else if (binding.ui.form.parentElement !== composerParking) composerParking.append(binding.ui.form);
    updateSessionComposer(binding, record, true);
  }
  const nativeVisible = visible && record.view === 'terminal' && binding !== soloComposer;
  binding.nativeVisible = nativeVisible; binding.nativeHost.hidden = !nativeVisible;
  if (binding.nativeSash) {
    binding.nativeSash.hidden = !nativeVisible;
    ui.display.attribute(binding.nativeSash, 'aria-label', 'terminal.heightName', { name: participantLabel(record, state.sessions) });
    if (!nativeVisible) binding.terminalDrag = null;
    else if (!binding.terminalDrag) applyColumnTerminalHeight(binding, columnTerminalHeight(record.id));
  }
  if (nativeVisible && nativeUsable(record) && record.terminalState?.alive) ensureTerminal(record.id).catch(error => toastError(error));
  syncTerminalMount(record.id);
  return nativeVisible;
}
// T-135: a column's terminal can be made taller or shorter by dragging the line above it or
// with the keys. While the person changes it, it stays between 64px and the height that leaves
// the conversation 80px and the column's input whole; on release the native terminal is fitted once.
function columnTerminalLimits(binding) {
  const input = binding.columnHost, reader = input?.closest('.collaboration-member-reader');
  // Everything else in the column below the conversation: the line, the input, gaps and any footer.
  const others = input ? input.offsetHeight - binding.nativeHost.offsetHeight + (reader.querySelector('.column-native-footer:not([hidden])')?.offsetHeight || 0) : 0;
  const room = reader ? reader.clientHeight - COLUMN_TERMINAL.conversation - others : COLUMN_TERMINAL.initial;
  return { min: COLUMN_TERMINAL.min, max: Math.min(COLUMN_TERMINAL.most, Math.max(COLUMN_TERMINAL.min, Math.floor(room))) };
}
function columnTerminalHeight(id) { return Number.isSafeInteger(columnTerminalHeights[id]) ? columnTerminalHeights[id] : COLUMN_TERMINAL.initial; }
// The most recently changed heights are kept, at most 200 (the saved view refuses more).
function rememberColumnTerminalHeight(id, value) {
  delete columnTerminalHeights[id]; columnTerminalHeights[id] = value;
  const ids = Object.keys(columnTerminalHeights); for (const old of ids.slice(0, Math.max(0, ids.length - 200))) delete columnTerminalHeights[old];
}
function fitColumnTerminal(binding) { binding.resizeAllowed = true; fitTerminal(binding.id); revealTerminalCursor(terminals.get(binding.id)); }
// The tallest is what the limits allow, but never below the old 112px, so a small window
// keeps the terminal as it was before heights could change. 'adjust' and 'save' are the
// person's changes; 'save' also remembers the height and fits the native terminal to it. A
// 'redraw' shows the remembered height and never resizes the native terminal: an undersized
// box shows the terminal through its own scrolling, with the cursor kept in view.
function columnTerminalTallest(binding) { return Math.max(columnTerminalLimits(binding).max, COLUMN_TERMINAL.initial); }
function applyColumnTerminalHeight(binding, height, mode = 'redraw') {
  const { min } = columnTerminalLimits(binding), top = columnTerminalTallest(binding);
  const value = Math.max(min, Math.min(top, Math.round(height))), before = binding.terminalHeight;
  binding.terminalHeight = value; binding.nativeHost.style.height = `${value}px`;
  const sash = binding.nativeSash;
  if (sash) { sash.setAttribute('aria-valuemin', String(min)); sash.setAttribute('aria-valuemax', String(top)); sash.setAttribute('aria-valuenow', String(value)); }
  if (mode === 'save') { rememberColumnTerminalHeight(binding.id, value); attempt(persistView); fitColumnTerminal(binding); }
  else if (mode === 'redraw' && before !== undefined && before !== value) revealTerminalCursor(terminals.get(binding.id));
  return value;
}
function columnTerminalSash(binding) {
  if (binding.nativeSash) return binding.nativeSash;
  const sash = node('div', undefined, 'column-terminal-sash'); sash.tabIndex = 0;
  sash.setAttribute('role', 'separator'); sash.setAttribute('aria-orientation', 'horizontal');
  // The drag is kept on the binding so a redraw in the middle of it leaves the dragged height alone.
  const finish = event => {
    const drag = binding.terminalDrag; if (drag?.pointerId !== event.pointerId) return;
    binding.terminalDrag = null; if (drag.value !== undefined && binding.nativeVisible) applyColumnTerminalHeight(binding, drag.value, 'save');
  };
  sash.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); sash.setPointerCapture(event.pointerId);
    binding.terminalDrag = { pointerId: event.pointerId, y: event.clientY, height: binding.terminalHeight ?? columnTerminalHeight(binding.id) };
  });
  sash.addEventListener('pointermove', event => {
    const drag = binding.terminalDrag; if (drag?.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) return finish(event);
    drag.value = applyColumnTerminalHeight(binding, drag.height + drag.y - event.clientY, 'adjust');
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) sash.addEventListener(type, finish);
  sash.addEventListener('keydown', event => {
    const now = binding.terminalHeight ?? columnTerminalHeight(binding.id);
    const next = { ArrowUp: now + COLUMN_TERMINAL.step, ArrowDown: now - COLUMN_TERMINAL.step, Home: columnTerminalTallest(binding), End: COLUMN_TERMINAL.min }[event.key];
    if (next === undefined) return;
    event.preventDefault(); applyColumnTerminalHeight(binding, next, 'save');
  });
  return binding.nativeSash = sash;
}
// A smaller window lowers a tall terminal (not below 112px) so the input stays in the column.
window.addEventListener('resize', () => {
  for (const binding of sessionComposers.values()) if (columnTerminalBinding(binding.id) && !binding.terminalDrag) applyColumnTerminalHeight(binding, columnTerminalHeight(binding.id));
});
function removeColumnInput(id) {
  const binding = sessionComposers.get(id); if (!binding) return;
  binding.revision++; binding.visible = binding.nativeVisible = false; binding.resizeAllowed = false; binding.terminalDrag = null;
  binding.ui.suspend(); if (binding !== soloComposer) composerParking.append(binding.ui.form);
  const entry = terminals.get(id); cancelViewInput(entry); if (entry) { cancelColumnComposition(entry); entry.term.blur(); } syncTerminalMount(id);
}
async function changeColumnView(binding, next, takeControl = false) {
  if (!composerCurrent(binding) || !binding.column || binding.changing) return false;
  const revision = binding.revision, record = state.sessions.find(s => s.id === binding.id), nativeId = record?.nativeId, generation = record?.connectionRevision || 0;
  const valid = () => { const fresh = state.sessions.find(s => s.id === binding.id); return composerCurrent(binding) && binding.column && binding.revision === revision && fresh?.nativeId === nativeId && !fresh.nativeContextPending && (fresh.connectionRevision || 0) === generation; };
  if (!takeControl && record?.owner === owner && record.view === next && valid()) return true;
  binding.changing = true; render();
  try {
    if (!await claimView(binding.id, next, selectionRevision, takeControl, valid) || !valid()) return false;
    render(); return true;
  } finally { binding.changing = false; render(); }
}
async function activateColumnNative(binding) {
  if (!composerCurrent(binding) || !binding.column) return false;
  const focusIntent = inputFocusRevision;
  if (!await changeColumnView(binding, 'terminal')) return false;
  const revision = binding.revision;
  clearFailedTerminal(binding.id); await ensureTerminal(binding.id, true);
  if (!composerCurrent(binding) || binding.revision !== revision || !binding.nativeVisible) return false;
  binding.resizeAllowed = true;
  fitTerminal(binding.id); await new Promise(requestAnimationFrame); if (!composerCurrent(binding) || binding.revision !== revision) return false; if (inputFocusRevision === focusIntent) focusTerminal(binding.id); return true;
}
function columnTerminalBinding(id) {
  const binding = sessionComposers.get(id);
  return binding?.column && binding.nativeVisible && composerCurrent(binding) ? binding : null;
}
function terminalContextVisible(id) {
  return Boolean(columnTerminalBinding(id) || id === activeSessionId() && mode === 'terminal' && selected !== 'room' || id === activeSessionId() && mode === 'terminal' && focusedRoomMember());
}
function syncTerminalMount(id) {
  const entry = terminals.get(id); if (!entry) return;
  const binding = columnTerminalBinding(id), solo = activeSessionId() === id && (selected !== 'room' || focusedRoomMember());
  const parent = binding ? binding.nativeHost : solo ? $('terminal-area') : terminalParking;
  if (entry.element.parentElement !== parent) parent.append(entry.element);
  entry.element.hidden = parent === terminalParking;
}
const queuedInputs = new Map(), queuedRoomInputs = new Map();
const draftRecoveries = new Map();
const draftRecoveryQueues = new Map();
const viewClaims = new Map();
const activeSessionId = () => selected === 'room' ? roomSession : selected;
const current = () => state?.sessions.find(s => s.id === activeSessionId());
const members = (id = spaceId) => spaceRecord(id)?.archived ? [] : state?.sessions.filter(s => inSpace(s, id) && !s.archived) || [];
function orderedMembers(id = spaceId) {
  const people = members(id), ranks = new Map((spaceRecord(id)?.memberOrder || []).map((id, index) => [id, index]));
  const fallback = ranks.size;
  return people.map((record, index) => ({ record, rank: ranks.get(record.id) ?? fallback + index }))
    .sort((a, b) => a.rank - b.rank).map(item => item.record);
}
function focusRoomMember(id, previous, originKey) {
  if (selected !== 'room' || id && !members().some(s => s.id === id)) return;
  if (id && !previous && readingPositions[originKey]) roomReturnReading = { spaceId, key: originKey, position: structuredClone(readingPositions[originKey]) };
  if (!id && roomReturnReading?.spaceId === spaceId) {
    readingPositions[roomReturnReading.key] = structuredClone(roomReturnReading.position);
    roomReturnReading = null;
  }
  const leaving = terminals.get(activeSessionId()); cancelViewInput(leaving);
  if (leaving?.composing) leaving.term.blur();
  selectionRevision++;
  if (id && id !== previous && readingPositions[originKey]) readingPositions[spaceId === 'shared' ? `collaboration-focus:${id}` : `focus:${spaceId}:${id}`] = structuredClone(readingPositions[originKey]);
  roomSurface = 'overview'; roomSession = id; mode = 'chat';
  activateSoloComposer(id);
  lastMessages = ''; render(); attempt(persistView);
}
function activeReturnReadingKeys() {
  const keys = [];
  if (selected === 'panorama' || panoramaView.returning) keys.push('panorama');
  if (selected === 'room' && roomSession && roomReturnReading?.spaceId === spaceId) keys.push(roomReturnReading.key);
  return keys;
}
function rememberPanoramaOrigin() {
  panoramaOrigin = panorama.captureOrigin();
  panoramaView = { ...panoramaOrigin.view, focusId: panoramaOrigin.focusId, returning: true };
}
async function openPanorama() {
  if (panoramaView.returning) return returnToPanorama();
  roomReturnReading = null;
  return select('panorama', 'chat', roomSession, true);
}
async function returnToPanorama() {
  const point = panoramaOrigin || { view: { ...panoramaView }, focusId: panoramaView.focusId || '' };
  panoramaView.returning = false;
  await select('panorama', 'chat', roomSession, true);
  panorama.restoreOrigin(point);
  panoramaOrigin = null;
  await persistView();
}
function renderPanorama() {
  if (!panorama) panorama = window.nativeWorkspacePanorama.create({
    host: $('panorama-view'), view: panoramaView, display: ui.display, language: ui.language,
    label: s => participantLabel(s, state.sessions),
    onChange: next => {
      if (selected !== 'panorama' || panoramaView.returning) return;
      panoramaView = { ...next, returning: false };
      readingPositions.panorama = { top: next.top, follow: false, anchor: '', offset: 0 };
      readingPositions = window.nativeWorkspacePanorama.pruneReading(readingPositions, activeReturnReadingKeys());
      attempt(() => api.readingState(readingPositions, panoramaView));
    },
    onSession: (id, source) => attempt(async () => {
      const record = state.sessions.find(s => s.id === id && !s.archived);
      if (!record) throw uiError('error.originalSessionUnavailable');
      rememberPanoramaOrigin();
      await select(id, 'chat', roomSession, true);
      if (source && !pointToMessage($('messages'), id, source.messageId)) toastMessage('toast.selectionMissing');
    }),
    onSpace: id => attempt(async () => {
      if (!spaceRecord(id) || spaceRecord(id).archived) throw uiError('error.originalSpaceUnavailable');
      rememberPanoramaOrigin(); await selectSpace(id);
    }),
    onReadingLost: () => toastMessage('toast.selectionChanged'),
  });
  panorama.update(state, !disconnected);
}
function restoreOverviewReading() {
  for (const view of messageViews.values()) {
    if (!view.key.startsWith('collaboration:') || !view.el.clientHeight) continue;
    // Layout and hiding can emit scroll events before our restoration frame.
    // Keep the saved source anchor authoritative until that frame completes.
    view.pageChanging = true;
    view.intent = { position: readingPositions[view.key] || { top: 0, follow: true, anchor: '', offset: 0 } }; scheduleReading(view);
  }
}
function renderRoomOverview() {
  const origin = document.activeElement, oldReader = origin?.closest('.collaboration-messages, .collaboration-brief, .collaboration-resize')?.closest('.collaboration-member-reader');
  const oldHeader = origin?.closest('.collaboration-member-status') || (oldReader && [...$('collaboration-overview').querySelectorAll('.collaboration-member-status')].find(header => header.dataset.memberId === oldReader.dataset.memberId));
  const oldIndex = oldHeader ? [...$('collaboration-overview').querySelectorAll('.collaboration-member-status')].indexOf(oldHeader) : -1;
  const removedFocus = oldHeader && !members().some(s => s.id === oldHeader.dataset.memberId);
  if (!roomOverview) roomOverview = window.nativeWorkspaceCollaboration.create({
    host: $('collaboration-overview'), roomId: state.room.id,
    display: ui.display, language: ui.language, showError: ui.showError,
    onMove: moveRoomMember,
    onOrderError: error => error.message ? toastError(error) : toastMessage('collab.orderUnchanged'),
    label: s => participantLabel(s, state.sessions), messages: s => sessionMessages(s),
    renderMessages: (el, s, rows, key) => messageList(el, rows, false, key, { session: s, passive: true }),
    disposeMessages: el => { messageViews.get(el)?.dispose(); messageViews.delete(el); },
    renderInput: renderColumnInput, disposeInput: removeColumnInput,
    beforeInputLayout: suspendColumnInputs,
    beforeLayout: () => { captureReadingViews(); restoreOverviewReading(); }, onLayout: restoreOverviewReading, onFocus: focusRoomMember,
    decorateHeader: (handle, record) => draggableSession(handle, record.id),
    onMemberMenu: openMemberMenu,
    onSource: (el, key, source) => {
      if (!pointToMessage(el, key, source.messageId)) toastMessage("toast.originalRemoved");
      attempt(persistView);
    },
  });
  const focused = focusedRoomMember(), records = roomSurface === 'records';
  $('collaboration-overview').hidden = false;
  for (const person of members()) readLegacyProgress(person);
  roomOverview.update(orderedMembers(), !disconnected, !records, focused ? roomSession : '');
  renderHeaderLayout(current(), selected === 'room');
  $('room-overview').setAttribute('aria-pressed', String(!records)); $('room-record').setAttribute('aria-pressed', String(records));
  $('room-member-tabs').hidden = true;
  $('room-record-view').querySelector('.timeline-tools').hidden = !records;
  $('room-messages').hidden = !records;
  if (!records) $('thread-heading').hidden = true;
  $('room-composer').hidden = focused;
  $('room-layout').classList.toggle('collaboration-focus', focused);
  if (removedFocus) focusRemainingMember(origin, oldIndex);
}
const nativeUsable = s => s && !s.archived && !s.backendUnavailable && (['starting', 'idle', 'working', 'approval'].includes(s.state) || ((s.state === 'error' || s.nativeContextPending) && s.terminalAvailable));
const canResume = s => s?.nativeId && !s.nativeContextPending && !s.backendUnavailable &&
  ((s.provider === 'codex' && s.transportDisconnected && ['error', 'disconnected'].includes(s.state) && (s.serviceCapabilities || state.capabilities || []).includes('transportReconnect')) ||
  (!s.terminalAvailable && (['ended', 'recoverable', 'error'].includes(s.state) || (s.provider === 'codex' && s.state === 'disconnected' && (s.serviceCapabilities || state.capabilities || []).includes('resubscribe'))))) &&
  ['resume', 'nativePermissionDefaults'].every(c => (s.serviceCapabilities || state.capabilities || []).includes(c));
const inputFocusAllowed = () => !sessionMenu && !roomMenu && !contentMenu && !renameTarget && !document.querySelector('dialog[open]');
function updateState(next) {
  const before = new Map((state?.sessions || []).map(s => [s.id, s]));
  state = projectSpace({ ...state, ...next });
  for (const s of state.sessions || []) if (legacyProgressOffline(s)) freezeLegacyProgress(s);
  if (latestViewStorage !== undefined) { state.viewStorageWarning = latestViewStorage; state.viewStorageWarningUiMessage = latestViewStorageUiMessage; }
  for (const [id, binding] of sessionComposers) {
    const previous = before.get(id), after = state.sessions.find(s => s.id === id);
    if (previous && after && (previous.owner !== owner || after.owner !== owner)) {
      const pending = pendingDrafts.get(id);
      if (pending && pending.text !== after.liveDraft) rememberDraftRecovery(id, pending.text);
      // An owning editor keeps its node/value across ordinary snapshots.
      // Ownership changes read the current draft, after IME has committed.
      if (!binding.ui.setValue(after.liveDraft || '')) binding.syncAfterComposition = true;
    }
  }
  for (const [queuedId, mark] of queuedInputs) followQueuedInput(queuedId, mark);
  for (const [queuedId, mark] of queuedRoomInputs) followQueuedRoomInput(queuedId, mark);
}
// Like a native TUI queue, a queued Claude message leaves the composer once
// the service records it. Only a proven non-send comes back, and only into an
// untouched composer; an uncertain one stays in the record so it is not resent.
function followQueuedInput(id, mark) {
  const s = state.sessions?.find(x => x.id === id);
  const row = s?.messages.find(m => mark.tag ? m.id === mark.tag : m.inputMode === 'queue' && !mark.before.has(m.id));
  if (!row) { if (!s) queuedInputs.delete(id); return; }
  mark.tag = row.id;
  const input = sessionComposers.get(id)?.ui.input, untouched = input && draftRevisions.get(id) === mark.revision;
  if (!mark.cleared && row.status === 'awaiting-native' && !s.liveDraft && untouched && input.value === mark.text) { sessionComposers.get(id).ui.setValue(''); mark.cleared = true; }
  if (row.status === 'awaiting-native') return;
  if (row.status === 'not-sent' && mark.cleared && untouched && !input.value && s.liveDraft) sessionComposers.get(id).ui.setValue(s.liveDraft);
  queuedInputs.delete(id);
}
function writeRoomDraft(id, view) {
  if (id === spaceId) { $('shared-input').value = view.sharedDraft || ''; roomMention = view.roomMention && { ...view.roomMention }; roomDraftRevision = view.draftRevision || 0; }
  attempt(persistView);
}
function followQueuedRoomInput(id, mark) {
  const row = spaceRecord(mark.spaceId)?.messages.find(m => mark.tag ? m.id === mark.tag : m.inputMode === 'queue' && m.recipientId === id && !mark.before.has(m.id));
  if (!row) return;
  mark.tag = row.id;
  const view = mark.spaceId === spaceId ? captureRoomView() : roomViews[mark.spaceId]; if (!view) return;
  if (!mark.cleared && row.status === 'awaiting-native' && mark.revision === view.draftRevision && view.sharedDraft === mark.raw && view.roomRecipient === id && view.roomMention?.text === mark.address?.text) {
    view.sharedDraft = ''; view.roomMention = null; view.roomRecipient = ''; mark.cleared = ++view.draftRevision; writeRoomDraft(mark.spaceId, view);
  }
  if (row.status === 'awaiting-native') return;
  if (row.status === 'not-sent' && mark.cleared === view.draftRevision) { view.sharedDraft = mark.raw; view.roomMention = mark.address; view.roomRecipient = id; view.draftRevision++; writeRoomDraft(mark.spaceId, view); }
  queuedRoomInputs.delete(id);
}
// Recorded times only; message-derived activity is labelled as an estimate.
function sessionTime(value) {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value), now = new Date();
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString(ui.language.getSnapshot().active, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()}${date.getFullYear() === now.getFullYear() ? '' : `/${date.getFullYear()}`} ${time}`;
}
function sessionActivityTime(s) {
  const reported = sessionTime(s.lastActivityAt);
  if (reported) return reported;
  let latest = null;
  for (const m of Array.isArray(s.messages) ? s.messages : []) {
    if (!m?.volatile && m?.kind !== 'gap' && Number.isFinite(m?.time) && Number.isFinite(new Date(m.time).getTime())) latest = latest === null ? m.time : Math.max(latest, m.time);
  }
  return latest === null ? uiText('time.unknown') : uiText('time.estimated', { time: sessionTime(latest) });
}
const sessionTimes = s => uiText('time.session', { created: sessionTime(s.createdAt) || uiText('time.unrecorded'), activity: sessionActivityTime(s) });
function renderDraftRecovery(id) {
  const copies = draftRecoveries.get(id) || [], list = $('draft-recovery-list');
  $('draft-recovery').hidden = !copies.length;
  const signature = JSON.stringify([id, copies]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature; list.replaceChildren();
  copies.forEach((text, index) => {
    const row = node('div', undefined, 'draft-recovery-copy'), area = node('textarea');
    area.value = text; area.readOnly = true; area.rows = 3; area.className = 'draft-recovery-text';
    if (!index) area.id = 'draft-recovery-text';
    ui.display.attribute(area, 'aria-label', 'draft.copyAria', { index: index + 1 });
    row.append(area, uiButton('draft.copy', () => api.copy(text), 'small'), uiButton('draft.discard', () => changeDraftRecovery(id, 'discardDraftRecovery', text), 'small'));
    list.append(row);
  });
}
function rememberDraftRecovery(id, text) {
  if (!text || draftRecoveries.get(id)?.includes(text)) return;
  attempt(() => changeDraftRecovery(id, 'retainDraftRecovery', text));
}
function changeDraftRecovery(id, method, text) {
  // Show a saved copy only after local persistence. Serializing recovery edits
  // also prevents a late retain response from resurrecting an explicit deletion.
  const task = (draftRecoveryQueues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
    draftRecoveries.set(id, await api[method](id, text));
    if (activeSessionId() === id) renderDraftRecovery(id);
  });
  draftRecoveryQueues.set(id, task);
  const clear = () => { if (draftRecoveryQueues.get(id) === task) draftRecoveryQueues.delete(id); };
  task.then(clear, clear);
  return task;
}
function claimView(id, next, revision, takeControl = false, contextCurrent) {
  const intent = state.sessions.find(s => s.id === id);
  const expectedOwner = intent?.owner, expectedControl = intent?.controlRevision;
  const pending = viewClaims.get(id);
  const isCurrent = contextCurrent || (() => selectionRevision === revision && activeSessionId() === id);
  // Serialize only this session's view changes. Other sessions remain usable.
  const operation = (pending || Promise.resolve()).catch(() => {}).then(async () => {
    if (!isCurrent()) return false;
    const fresh = await api.initial();
    if (!isCurrent()) return false;
    const target = fresh.sessions.find(s => s.id === id);
    updateState(fresh);
    // Waiting is not renewed consent to override a more recent human action.
    // Older native services have no atomic conditional-claim protocol; this
    // cancels stale queued intent, not changes after this local observation.
    if (!target || target.owner !== expectedOwner || ((pending || contextCurrent) && target.controlRevision !== expectedControl) || (!takeControl && target.owner !== owner)) { render(); return false; }
    await api.claim(id, next);
    if (!isCurrent()) return false;
    const acknowledged = await api.initial();
    if (!isCurrent()) return false;
    updateState(acknowledged);
    if (state.sessions.find(s => s.id === id)?.owner !== owner) { render(); return false; }
    return true;
  });
  viewClaims.set(id, operation);
  const clear = () => { if (viewClaims.get(id) === operation) viewClaims.delete(id); };
  operation.then(clear, clear); return operation;
}
function soloAction(s, context = {}) {
  const choice = value => ({ ...value, label: uiText(value.labelKey), hint: uiText(value.hintKey) });
  if (!s || disconnected || s.archived) return choice({ kind: 'none', labelKey: s?.archived ? 'composer.archived' : 'composer.disconnected', hintKey: s?.archived ? 'composer.archivedHint' : 'composer.disconnectedHint' });
  if (s.transportDisconnected && canResume(s)) return choice({ kind: 'resume', labelKey: 'composer.resume', hintKey: 'composer.connectionLostHint' });
  if (!nativeUsable(s)) return choice(canResume(s)
    ? { kind: 'resume', labelKey: 'composer.resume', hintKey: 'composer.resumeHint' }
    : { kind: 'none', labelKey: 'composer.unavailable', hintKey: 'composer.unavailableHint' });
  if (s.owner !== owner) return choice({ kind: 'claim', labelKey: 'composer.claim', hintKey: 'composer.readOnlyHint' });
  if (interruptPending(s)) return choice({ kind: 'send', labelKey: 'composer.waitInterrupt', hintKey: 'composer.interruptHint' });
  if (s.nativeInputRequired) return choice({ kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.nativeInputHint' });
  if (s.state === 'error' && s.failedTurnInputAvailable) return choice({ kind: 'send', labelKey: 'composer.send', hintKey: 'composer.failedHint' });
  if (s.state === 'error' && (s.chatAvailable !== false || !s.legacyInputEligible || s.legacyInputPrepared)) return choice({ kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.errorHint' });
  if (s.chatAvailable === false && s.legacyInputEligible && s.provider === 'codex') return choice({ kind: 'connect', labelKey: 'composer.connect', hintKey: 'composer.codexConnectHint' });
  if (s.chatAvailable === false && s.legacyInputEligible) return choice(s.legacyInputPrepared
    ? { kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.reloadHint' }
    : { kind: 'connect', labelKey: 'composer.connect', hintKey: 'composer.pluginHint' });
  if (s.chatAvailable === false || s.state === 'starting') return choice({ kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.useTerminalHint' });
  if ((context.column || focusedRoomMember()) && (context.mode || mode) === 'chat' && s.view !== 'chat') return choice({ kind: 'chat', labelKey: 'composer.enableChat', hintKey: 'composer.enableChatHint' });
  if (s.legacyReaderPending && s.state === 'idle') return choice({ kind: 'send', labelKey: 'composer.send', hintKey: 'composer.readerPendingHint' });
  // Native runs a plugin's queued prompt only once idle; text typed in the TUI reaches the running turn.
  if (s.pendingQueue) return choice({ kind: 'send', labelKey: 'composer.waitNative', hintKey: 'composer.queuePendingHint' });
  if (s.state === 'working' && s.queueAvailable && !s.approval) return choice({ kind: 'send', labelKey: 'composer.queue', hintKey: 'composer.queueHint' });
  if (s.state === 'working' && s.steerAvailable && s.activeTurnId && !s.approval) return choice({ kind: 'send', labelKey: 'composer.steer', hintKey: 'composer.steerHint' });
  return choice({ kind: 'send', labelKey: 'composer.send', hintKey: s.state === 'approval'
    ? s.approvalResolved ? 'composer.approvedHint'
      : s.approval?.pending ? 'composer.decisionPendingHint'
        : 'composer.approvalHint'
    : s.state === 'working' || s.pendingTag ? 'composer.workingHint' : 'composer.keyboardHint' });
}
function renderComposer(s) {
  renderDraftRecovery(s?.id);
  if (s) updateSessionComposer(activateSoloComposer(s.id), s, false);
}
function updateSessionComposer(binding, s, column) {
  const action = soloAction(s, { column, mode: column ? 'chat' : mode });
  const legacyDraft = (s?.legacyInputEligible || s?.nativeInputRequired) && s.owner === owner && !disconnected && !s.archived && ['connect', 'terminal'].includes(action.kind);
  const disabled = action.kind === 'none' || (action.kind === 'send' && (interruptPending(s) || s.pendingQueue || (s.state === 'working' && s.queueAvailable ? false : (s.state === 'working' && s.steerAvailable && s.activeTurnId ? s.pendingSteer : (s.state !== 'idle' && !(s.state === 'error' && s.failedTurnInputAvailable)) || s.pendingTag)) || s.approval || !binding.ui.input.value.trim() || pendingMode?.id === s.id || binding.changing || inputRecoveries.get(s.id)?.text.value));
  const identity = participantLabel(s, state.sessions);
  const placeholderKey = column ? 'composer.placeholderName' : action.kind === 'send' ? 'composer.placeholder' : legacyDraft ? 'composer.editableDraft' : 'composer.preservedDraft';
  const inputKey = column ? 'composer.inputName' : 'composer.input';
  const hintKey = inputRecoveries.get(s.id)?.text.value ? 'composer.unconfirmedHint' : binding.changing || pendingMode?.id === s.id ? 'composer.changingHint' : column && action.hintKey === 'composer.keyboardHint' ? null : action.hintKey;
  const actionName = () => ({ action: uiText(action.labelKey), name: identity });
  binding.ui.update({ readOnly: action.kind !== 'send' && !legacyDraft, submit: action.kind === 'send', disabled,
    label: action.label, actionLabel: column ? uiText('composer.actionName', actionName()) : '',
    placeholder: uiText(placeholderKey, { name: identity }),
    inputLabel: uiText(inputKey, { name: identity }),
    hint: hintKey ? uiText(hintKey) : '',
    showNative: column && action.kind === 'send' && s.owner === owner, nativeDisabled: binding.changing || disconnected,
    nativeLabel: uiText('composer.nativeName', { name: identity }),
  });
  // Only presentation is subscribed. Never re-run this update or a native
  // action when the locale changes; the same input and composition stay live.
  ui.display.text(binding.ui.send, action.labelKey);
  if (column) ui.display.attribute(binding.ui.send, 'aria-label', 'composer.actionName', actionName);
  else ui.display.unbind(binding.ui.send, 'aria-label');
  ui.display.attribute(binding.ui.input, 'placeholder', placeholderKey, { name: identity });
  ui.display.attribute(binding.ui.input, 'aria-label', inputKey, { name: identity });
  if (hintKey) ui.display.text(binding.ui.hint, hintKey);
  else ui.display.unbind(binding.ui.hint);
  ui.display.text(binding.ui.native, 'composer.nativeInput');
  ui.display.attribute(binding.ui.native, 'aria-label', 'composer.nativeName', { name: identity });
}
function toast(text, action) {
  clearTimeout(toastTimer);
  const old = $('toast').querySelector('.toast-action');
  if (old === document.activeElement) $('toast-close').focus({ preventScroll: true });
  old?.remove(); ui.display.unbind($('toast-text')); $('toast-text').textContent = text; $('toast').hidden = false;
  if (action) {
    const open = button(action.label, () => {
      if (!open.isConnected || $('toast').hidden) return;
      $('toast').hidden = true; return action.run();
    }, 'toast-action');
    if (action.labelKey) ui.display.text(open, action.labelKey, action.params);
    if (action.nameKey) ui.display.attribute(open, 'aria-label', action.nameKey, action.params);
    else if (action.labelKey && !action.name) ui.display.attribute(open, 'aria-label', action.labelKey, action.params);
    else open.setAttribute('aria-label', action.name || action.label);
    $('toast').insertBefore(open, $('toast-close'));
  } else toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
function sessionNotice(text, id) {
  const record = state.sessions.find(s => s.id === id);
  toast(text, record && selected !== id && { label: uiText('common.open'), labelKey: 'common.open', nameKey: 'action.openSession', params: { name: participantLabel(record, state.sessions) }, run: () => {
    if (selected === id) return;
    if (!state.sessions.some(s => s.id === id)) throw uiError("error.recordMissing");
    return select(id);
  } });
}
function focusAfterRemoval(origin, candidates) {
  if (!origin || origin.isConnected && origin.getClientRects().length) return;
  const surface = JSON.stringify([selected, roomSession, roomSurface, mode]);
  requestAnimationFrame(() => {
    if (surface !== JSON.stringify([selected, roomSession, roomSurface, mode]) || document.activeElement && document.activeElement !== document.body) return;
    candidates.find(el => el?.isConnected && !el.disabled && el.getClientRects().length)?.focus({ preventScroll: true });
  });
}
function focusRemainingMember(origin, index) {
  const cards = [...$('collaboration-overview').querySelectorAll('.collaboration-member-status')];
  focusAfterRemoval(origin, [cards[index]?.querySelector('.collaboration-member-more'), cards[index - 1]?.querySelector('.collaboration-member-more'), $('manage-members')]);
}
ui.copyCode = async text => {
  try { await api.copy(text); toastMessage("toast.copied"); }
  catch (error) { toastMessage("toast.copyFailed"); throw error; }
};
$('toast-close').onclick = () => { clearTimeout(toastTimer); $('toast').hidden = true; };
// T-128: a notice with an action keeps no time limit, so keyboard and screen-
// reader users can still reach it, but it never stays in the way: any press
// that is not on one of its own buttons ends it, on the notice or elsewhere.
// The press is not passed on, so nothing hidden beneath it is triggered.
document.addEventListener('pointerdown', event => {
  if ($('toast').hidden || !$('toast').querySelector('.toast-action')) return;
  if (!(event.target instanceof Element && $('toast').contains(event.target) && event.target.closest('button'))) $('toast').hidden = true;
}, true);
function toastMessage(key, params, action) { toast('', action); ui.display.text($('toast-text'), key, params); }
function toastError(error) { toast(''); ui.showError($('toast-text'), error); }
function sessionNoticeMessage(key, params, id) { sessionNotice('', id); ui.display.text($('toast-text'), key, params); }
async function attempt(action) { try { return await action(); } catch (error) { toastError(error); } }
function captureRoomView() {
  const view = roomViews[spaceId] ||= {};
  Object.assign(view, { sharedDraft: $('shared-input').value, roomSession, roomRecipient: roomRecipient(), roomMention: roomMention && { ...roomMention }, roomFilter: $('room-filter').value || pendingRoomFilter, roomSearch: $('room-search').value, roomThread, roomReplyTo, roomSurface, draftRevision: roomDraftRevision, submitting: roomSubmitting });
  roomHistories.set(spaceId, roomMentionHistory); return view;
}
function restoreRoomView() {
  const view = roomViews[spaceId] ||= {};
  $('shared-input').value = view.sharedDraft || ''; roomSession = view.roomSession || '';
  roomMention = view.roomMention ? { ...view.roomMention } : null;
  pendingRoomFilter = view.roomFilter || ''; $('room-filter').value = pendingRoomFilter; $('room-search').value = view.roomSearch || '';
  roomThread = view.roomThread || ''; roomReplyTo = view.roomReplyTo || ''; roomSurface = view.roomSurface || 'overview';
  roomDraftRevision = view.draftRevision || 0; roomSubmitting = view.submitting || null;
  roomMentionHistory = roomHistories.get(spaceId) || nativeWorkspaceMentions.editHistory(); roomHistories.set(spaceId, roomMentionHistory);
  normalizeRoomMention(); populateSelect($('recipient'), members()); $('recipient').value = roomRecipient();
}
function persistedRoomViews() {
  return Object.fromEntries(Object.entries(roomViews).map(([id, value]) => [id, Object.fromEntries(roomViewFields.filter(k => value[k] !== undefined).map(k => [k, value[k]]))]));
}
function projectSpace(next) {
  const room = (next.rooms || [next.room]).find(r => (r?.id || 'shared') === spaceId);
  return { ...next, sessions: next.sessions.map(s => {
    const { roomId: _oldRoom, roomMemberRevision: _oldMember, ...identity } = s.peerIdentity || {};
    return { ...s, peerIdentity: { ...identity, ...(spaceId === 'shared' ? {} : { roomId: spaceId, roomMemberRevision: pairRevision(s) }) }, sharedActivity: s.sharedActivities?.[spaceId] || (spaceId === 'shared' ? s.sharedActivity : null) };
  }), room: room || { id: spaceId, name: uiText('sidebar.spaceUnavailableName'), archived: true, unavailable: true, messages: [], events: [], notes: '', files: [], memberOrder: [] } };
}
function persistView() { normalizeRoomMention(); captureReadingViews(); captureRoomView(); return api.viewState({ readingPositions, panorama: panoramaView, selected, mode, preference, roomSession, terminalLayout, terminalSplit, terminalDisplay, spaceId, sidebarView, sidebarCollapsedGroups: [...sidebarCollapsedGroups], columnTerminalHeights, roomViews: persistedRoomViews(), sharedDraft: $('shared-input').value, roomRecipient: roomRecipient(), roomMention, roomFilter: $('room-filter').value || pendingRoomFilter, roomSearch: $('room-search').value, roomThread, roomReplyTo }); }
// Opening a space never changes which sessions the sidebar lists (T-132).
async function selectSpace(id) {
  if (!spaceRecord(id)) throw uiError("error.spaceUnavailable");
  if (spaceId !== id) {
    captureReadingViews(); captureRoomView(); closeMentions(); suspendColumnInputs();
    roomOverview?.dispose(); roomOverview = null; spaceId = id; state = projectSpace(state); restoreRoomView();
    runPreview = null; shareRevision++; lastRoomMessages = ''; lastMessages = '';
  }
  return selectRoom(roomSession);
}
function renderSpaceNavigation() {
  for (const room of allSpaces()) {
    let row = spaceRows.get(room.id);
    if (!row) {
      if (room.id === 'shared') row = { element: $('room-nav').parentElement, nav: $('room-nav'), name: $('room-nav-name'), count: $('member-count'), more: $('room-more') };
      else {
        const element = node('div', undefined, 'room-row'), nav = button('', () => selectSpace(room.id), 'room-nav'), name = node('span', undefined, 'rail-label space-name'), count = node('span', undefined, 'space-count');
        nav.append(node('span', '◉', 'rail-icon'), name, count);
        const more = button('⋯', () => openRoomMenu(undefined, more, room.id), 'session-more'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        element.append(nav, more); $('additional-spaces').append(element); row = { element, nav, name, count, more };
        nav.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); openRoomMenu({ x: event.clientX, y: event.clientY }, more, room.id); });
        nav.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); event.stopPropagation(); openRoomMenu(undefined, more, room.id); } });
        dropTarget(nav, true, room.id);
      }
      row.element.dataset.spaceId = room.id; bindSpaceHighlight(row.element, room.id); spaceRows.set(room.id, row);
    }
    row.element.hidden = Boolean(room.archived) && !(renameTarget?.id === 'room' && renameTarget.roomId === room.id);
    row.nav.disabled = Boolean(room.archived); row.more.disabled = disconnected || Boolean(room.archived) || renameTarget?.id === 'room' && renameTarget.roomId === room.id;
    row.nav.className = `room-nav ${roomTone(room.id)}`; row.nav.classList.toggle('active', selected === 'room' && spaceId === room.id);
    if (selected === 'room' && spaceId === room.id) row.nav.setAttribute('aria-current', 'page'); else row.nav.removeAttribute('aria-current');
    const navParams = () => ({ name: room.name, count: members(room.id).length }); ui.display.attribute(row.nav, 'aria-label', 'sidebar.spaceNav', navParams); ui.display.attribute(row.nav, 'title', 'sidebar.spaceNav', navParams);
    row.name.textContent = room.name; row.count.textContent = members(room.id).length;
    ui.display.attribute(row.more, 'aria-label', 'sidebar.spaceActions', { name: room.name }); ui.display.attribute(row.more, 'title', 'sidebar.spaceActions', { name: room.name });
  }
  const active = allSpaces().filter(r => !r.archived);
  $('workspace-empty').hidden = Boolean(active.length);
  ui.display.text($('workspace-group-summary'), 'sidebar.spaceCount', { count: active.length });
}
function openSpaceCreate() {
  $('space-create-name').value = ''; $('space-create-error').hidden = true; $('confirm-space-create').disabled = false;
  openTransientDialog('space-create-dialog'); $('space-create-name').focus();
}
let mergeDialog;
function mergeSourceLabel(room, choices) {
  return choices.filter(value => value.name === room.name).length > 1 ? `${room.name} · ${room.id.slice(0, 8)}` : room.name;
}
function mergeCheckbox(text, checked, change) {
  const label = node('label', undefined, 'merge-option'), input = node('input'); input.type = 'checkbox'; input.checked = checked;
  input.onchange = () => change(input.checked); label.append(input, node('span', text)); return { label, input };
}
function mergeError(message) { if (message && typeof message !== 'string') ui.showError($('space-merge-error'), message); else { ui.display.unbind($('space-merge-error')); $('space-merge-error').textContent = message || ''; } $('space-merge-error').hidden = !message; }
function mergeButtons(preview, record = false) {
  $('space-merge-options').hidden = preview; $('space-merge-preview').hidden = !preview;
  $('preview-space-merge').hidden = preview; $('back-space-merge').hidden = !preview || record;
  $('confirm-space-merge').hidden = !preview || record; $('open-space-merge-target').hidden = !record;
  $('undo-space-merge').hidden = !record; $('recover-space-merge').hidden = !record;
}
function renderMergeChoices() {
  const draft = mergeDialog; if (!draft || draft.record) return;
  const chosen = draft.rooms.filter(room => draft.sourceInputs.get(room.id)?.checked);
  $('space-merge-members').replaceChildren(); $('space-merge-selection').replaceChildren();
  for (const session of state.sessions.filter(session => !session.archived && chosen.some(room => inSpace(session, room.id)))) {
    const available = Boolean(session.nativeId) && (!Array.isArray(session.serviceCapabilities) || session.serviceCapabilities.includes('collaborationSpacesV1'));
    if (!draft.memberChoices.has(session.id)) draft.memberChoices.set(session.id, available);
    const field = mergeCheckbox('', available && draft.memberChoices.get(session.id), checked => draft.memberChoices.set(session.id, checked));
    ui.display.computed(field.label.lastElementChild, 'text', () => participantLabel(session, state.sessions) + (!available ? uiText('merge.memberUnavailable') : ''));
    field.input.disabled = !available; field.input.dataset.mergeMember = session.id; $('space-merge-members').append(field.label);
  }
  for (const room of chosen) {
    const eligible = room.messages.filter(window.nativeWorkspaceSpaces.completedSharedRecord);
    if (!draft.selections.has(room.id)) draft.selections.set(room.id, { messages: new Set(eligible.map(message => message.id)), files: new Set((room.files || []).map(file => file.id)), events: new Set((room.events || []).map(event => event.id)), notes: true });
    const choice = draft.selections.get(room.id), details = node('details'), summary = uiNode('summary', 'merge.selectionSummary', () => ({ name: mergeSourceLabel(room, draft.rooms), count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(eligible.length) })), body = node('div');
    details.append(summary, body); let built = false;
    details.ontoggle = () => {
      if (!details.open || built) return; built = true;
      if (room.notes) { const field = mergeCheckbox('', choice.notes, checked => choice.notes = checked); ui.display.text(field.label.lastElementChild, 'merge.sourceNotes'); body.append(field.label); }
      for (const [title, records, selectedIds, text] of [
        ['merge.records', eligible, choice.messages, message => `${message.name || message.role} · ${message.text.slice(0, 140) || uiText('merge.nativeStatus')}`],
        ['merge.files', room.files || [], choice.files, file => file.name],
        ['merge.events', room.events || [], choice.events, event => ui.displayText(event.text, event.uiMessage).slice(0, 140)],
      ]) {
        if (!records.length) continue;
        const section = node('fieldset'), legend = uiNode('legend', title), inputs = [];
        const all = mergeCheckbox('', records.every(record => selectedIds.has(record.id)), checked => {
          for (const record of records) checked ? selectedIds.add(record.id) : selectedIds.delete(record.id);
          for (const input of inputs) input.checked = checked;
        });
        ui.display.text(all.label.lastElementChild, 'merge.selectAll'); section.append(legend, all.label);
        for (const record of records) {
          const field = mergeCheckbox(text(record), selectedIds.has(record.id), checked => checked ? selectedIds.add(record.id) : selectedIds.delete(record.id));
          ui.display.computed(field.label.lastElementChild, 'text', () => text(record));
          ui.display.attribute(field.input, 'aria-label', 'merge.importAction', () => ({ name: room.name, kind: uiText(title), id: record.id })); inputs.push(field.input); section.append(field.label);
          if (record.text) { const full = node('details'), label = uiNode('summary', 'merge.original'); full.append(label, node('pre', record.text)); section.append(full); }
        }
        body.append(section);
      }
      const omitted = room.messages.length - eligible.length;
      if (omitted) body.append(uiNode('p', 'merge.omitted', () => ({ count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(omitted) }), 'quiet'));
    };
    $('space-merge-selection').append(details);
  }
  $('preview-space-merge').disabled = chosen.length < 2 || disconnected;
}
function openSpaceMerge(origin = spaceId) {
  if (!state.capabilities?.includes('spaceMergeV1')) return toastMessage('merge.unsupported');
  const rooms = allSpaces().filter(room => !room.archived && !room.unavailable);
  if (rooms.length < 2) return toastMessage('merge.needTwo');
  const ticket = openTransientDialog('space-merge-dialog');
  mergeDialog = { ticket, rooms: structuredClone(rooms), sourceInputs: new Map(), memberChoices: new Map(), selections: new Map(), batch: null, record: null };
  ui.display.text($('space-merge-title'), 'merge.title'); $('space-merge-name').value = uiText('merge.defaultName'); $('space-merge-disposition').value = 'keep';
  $('space-merge-sources').replaceChildren(); ui.display.unbind($('space-merge-preview')); $('space-merge-preview').replaceChildren(); mergeError(''); mergeButtons(false);
  for (const room of rooms) {
    const label = mergeSourceLabel(room, rooms), field = mergeCheckbox(label, room.id === origin, renderMergeChoices); field.input.value = room.id;
    ui.display.attribute(field.input, 'aria-label', 'merge.sourceAction', { name: label }); mergeDialog.sourceInputs.set(room.id, field.input); $('space-merge-sources').append(field.label);
  }
  renderMergeChoices(); $('space-merge-name').focus();
}
function mergeSpec() {
  const draft = mergeDialog, sourceIds = [...draft.sourceInputs].filter(([, input]) => input.checked).map(([id]) => id);
  return { sourceIds, name: $('space-merge-name').value, disposition: $('space-merge-disposition').value,
    memberIds: [...$('space-merge-members').querySelectorAll('input[data-merge-member]:checked')].map(input => input.dataset.mergeMember),
    selections: sourceIds.map(roomId => { const choice = draft.selections.get(roomId); return { roomId, messageIds: [...choice.messages], fileIds: [...choice.files], eventIds: [...choice.events], includeNotes: choice.notes }; }) };
}
function renderMergeBatch(batch, record) {
  const element = $('space-merge-preview'); ui.display.unbind(element); element.replaceChildren(node('h3', batch.name));
  element.append(uiNode('p', 'merge.previewSummary', () => { const number = new Intl.NumberFormat(ui.language.getSnapshot().active); return { members: number.format(batch.memberIds.length), records: number.format(batch.blocks.reduce((n, block) => n + block.entries.length, 0)), size: new Intl.NumberFormat(ui.language.getSnapshot().active, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(batch.bytes / 1024) }; }));
  element.append(uiNode('p', batch.disposition === 'archive' ? 'merge.archiveHelp' : 'merge.keepHelp'));
  for (const block of batch.blocks) {
    const section = node('details'), summary = uiNode('summary', 'merge.blockSummary', () => { const number = new Intl.NumberFormat(ui.language.getSnapshot().active); return { name: mergeSourceLabel({ id: block.roomId, name: block.name }, batch.sources), records: number.format(block.entries.length), files: number.format(block.files.length) }; }); section.append(summary);
    if (block.notes) { section.append(uiNode('h4', 'merge.originalNotes'), node('pre', block.notes)); }
    for (const entry of block.entries) { const original = node('details'); const label = node('summary'); ui.display.computed(label, 'text', () => (entry.payload.name || entry.payload.role) + ' · ' + (entry.payload.text.slice(0, 100) || uiText('merge.nativeStatus'))); original.append(label, node('pre', entry.payload.text)); section.append(original); }
    for (const file of block.files) section.append(node('p', file.name));
    if (block.omitted.length) section.append(uiNode('p', 'merge.omittedSource', () => ({ count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(block.omitted.length) }), 'quiet'));
    if (block.pending) section.append(uiNode('p', 'merge.pending', undefined, 'quiet'));
    element.append(section);
  }
  $('confirm-space-merge').disabled = Boolean(batch.conflicts.length);
  if (batch.conflicts.length) element.append(uiNode('p', 'merge.conflict', undefined, 'warning'));
  if (record) {
    const stage = ['preparing', 'joining', 'archiving', 'ready', 'partial', 'failed', 'undoing', 'undone'].includes(record.stage) ? 'merge.stage.' + record.stage : null;
    element.prepend(stage ? uiNode('p', stage) : node('p', record.stage));
    for (const source of record.sources) element.append(uiNode('p', 'merge.sourceStatus', () => ({
      name: batch.sources.find(value => value.id === source.id)?.name || uiText('merge.sourceFallback'),
      status: batch.disposition === 'keep' ? uiText('merge.source.kept') : ['done', 'restored', 'pending', 'failed', 'changed'].includes(source.status) ? uiText('merge.source.' + source.status) : source.status,
      error: source.error ? ' · ' + (source.errorUiMessage ? ui.displayText(source.error, source.errorUiMessage) : source.error) : '',
    })));
    $('recover-space-merge').hidden = !['failed', 'partial', 'preparing', 'joining'].includes(record.stage) || record.undoStarted;
    $('undo-space-merge').hidden = record.stage === 'undone';
    const failureText = record.warning || record.failures.join('\n'), failureMessage = record.warning ? record.warningUiMessage : record.failuresUiMessage;
    mergeError(failureText && failureMessage ? { message: failureText, uiMessage: failureMessage } : failureText);
  }
}
async function openMergeRecord(id) {
  const room = spaceRecord(id); if (!room?.merge) return;
  const ticket = openTransientDialog('space-merge-dialog'); mergeDialog = { ticket, record: null, batch: null, targetId: id };
  ui.display.text($('space-merge-title'), 'merge.details'); mergeButtons(true, true); mergeError('');
  ui.display.unbind($('space-merge-preview')); $('space-merge-preview').replaceChildren(); ui.display.text($('space-merge-preview'), 'merge.checking');
  for (const key of ['open-space-merge-target', 'undo-space-merge', 'recover-space-merge']) $(key).disabled = true;
  try {
    const record = await api.spaceMerge('status', { operationId: room.merge.operationId });
    if (!currentDialogTicket(ticket)) return;
    mergeDialog.record = record; mergeDialog.batch = record.batch; renderMergeBatch(record.batch, record);
    for (const key of ['open-space-merge-target', 'undo-space-merge', 'recover-space-merge']) $(key).disabled = false;
  } catch (error) { if (currentDialogTicket(ticket)) mergeError(error); else toastError(error); }
}
function openSpaceRegionMenu(point, anchor = $('new-space')) {
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  roomMenu = ui.menu({ items: [{ id: 'create', label: uiText('menu.newSpace'), labelKey: 'menu.newSpace' }, { id: 'merge', label: uiText('menu.mergeSpaces'), labelKey: 'menu.mergeSpaces', disabled: allSpaces().filter(room => !room.archived).length < 2 }], getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect(), onSelect: action => action === 'merge' ? openSpaceMerge() : openSpaceCreate(), onClose: () => { roomMenu = null; if (anchor.isConnected) anchor.focus({ preventScroll: true }); } });
}
function icon(provider) { return node('span', provider === 'claude' ? 'Cl' : 'Cx', `agent-icon ${provider}`); }
async function select(id, requestedMode, member = roomSession, passive = false) {
  captureReadingViews(); suspendColumnInputs();
  const revision = ++selectionRevision;
  const leaving = terminals.get(activeSessionId());
  cancelViewInput(leaving);
  if (leaving?.composing) leaving.term.blur();
  if (revision !== selectionRevision) return;
  if (id === 'room') roomSession = member;
  selected = id; const s = current();
  if (selected === 'room') mode = roomSurface === 'overview' ? 'chat' : s ? 'terminal' : 'chat'; else if (requestedMode) mode = requestedMode; else if (s) mode = s.owner === owner ? s.view : preference;
  if (mode === 'terminal' && terminalLayout === 'hidden') terminalLayout = 'split';
  activateSoloComposer(s?.id);
  clearFailedTerminal(s?.id);
  lastMessages = ''; lastRoomMessages = ''; render(); attempt(persistView);
  // Reveal only deliberate navigation (including search/restore/reopen).
  // Native state updates must not pull the person's sidebar scroll back.
  const entry = sessionRow(selected)?.element, list = $('session-list');
  if (entry) {
    const row = entry.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }
  if (!passive && mode === 'chat' && !chatInput().readOnly && inputFocusAllowed()) chatInput().focus();
  if (s && mode === 'terminal' && (switchedAway(s) || !['ended', 'background', 'stopping', 'disconnected', 'recoverable'].includes(s.state))) attempt(async () => { await ensureTerminal(s.id, true); focusTerminal(s.id); });
  if (selected === 'room' && mode === 'terminal' && s?.owner === owner && s.view !== 'terminal') attempt(async () => {
    const revision = selectionRevision;
    const stillSelected = () => revision === selectionRevision && selected === 'room' && roomSession === s.id && mode === 'terminal';
    if (!await claimView(s.id, 'terminal', revision) || !stillSelected()) return;
    render();
    await ensureTerminal(s.id, true);
    if (stillSelected()) focusTerminal(s.id);
  });
}
function selectRoom(id = '') { if (id) roomSurface = 'overview'; return select('room', undefined, id); }
async function operateNative(id) {
  if (activeSessionId() !== id) {
    const selection = selected === 'room' ? selectRoom(id) : select(id, 'terminal');
    const revision = selectionRevision;
    await selection;
    if (revision !== selectionRevision) return;
  }
  if (activeSessionId() === id) await switchMode('terminal');
}
async function detach(id, source = spaceId) {
  await api.spaceAction(source, 'join', [id, false]);
  // State reconciliation removes the reader in place. Opening its original
  // session is a separate human action, never another input/view claim.
  sessionNoticeMessage("toast.detached", undefined, id);
}
function focusTerminal(id = activeSessionId()) {
  if ((terminalCanInput(id) || canCaptureTerminal(id)) && inputFocusAllowed()) terminals.get(id).term.focus();
}
// 原生终端 is shown for a session this window controls, but the native view is not the terminal: a control change
// failed, or the saved view was restored at start without one. The terminal takes no keys until 原生终端 is chosen
// again, so the status says so (T-154) instead of a plain 「就绪」.
function terminalUnclaimed(s, own, visible) {
  return Boolean(own && visible && mode === 'terminal' && s.view !== 'terminal' && terminals.get(s.id)?.ready && !terminals.get(s.id)?.viewInput && !viewClaims.has(s.id) && !disconnected && nativeUsable(s));
}
function terminalCanInput(id) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return Boolean(entry?.ready && currentTerminalDisplay(entry, record) && terminalContextVisible(id) && nativeUsable(record) && record?.owner === owner && record?.view === 'terminal' && !state?.roomStorageWarning && !disconnected);
}
function currentTerminalDisplay(entry, record) {
  if (columnTerminalBinding(record?.id) && (!entry?.epoch || !record?.terminalState?.epoch || entry.nativeId !== record.nativeId || record.nativeContextPending)) return false;
  return entry?.generation === (record?.connectionRevision || 0) && (!record?.recovering || record.terminalState?.alive === true) &&
    record?.terminalState?.alive !== false && (!entry?.epoch || !record?.terminalState?.epoch || entry.epoch === record.terminalState.epoch);
}
function canCaptureTerminal(id) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id), pending = entry?.viewInput;
  return Boolean(pending && currentTerminalDisplay(entry, record) && pending.revision === selectionRevision && id === activeSessionId() && mode === 'terminal' && entry.ready && entry.generation === (record?.connectionRevision || 0) && nativeUsable(record) && record.owner === pending.owner && !state?.roomStorageWarning && !disconnected);
}
function cancelViewInput(entry, error = uiError("error.switchCancelled")) {
  const pending = entry?.viewInput; if (!pending) return;
  entry.viewInput = null; pending.cancelled = true;
  if (pending.text) entry.preserveUnconfirmed(pending.text, error);
  pending.reject(error);
}
function canFlushComposition(id, token = terminals.get(id)?.composition) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return Boolean(token && currentTerminalDisplay(entry, record) && !token.cancelled && !token.consumed && entry?.composition === token && !entry.composing && entry.ready && entry.generation === (record?.connectionRevision || 0) && nativeUsable(record) && record.owner === owner && record.view === 'terminal' && !state?.roomStorageWarning && !disconnected);
}
// Input held while a terminal's view was being switched is over without being sent: the switch failed, another
// view took control, or the session or connection changed. Redraw now, so the status stops saying it is held and
// the terminal stops taking keys. If the keyboard is still in that terminal, which can no longer take it, move it to
// the native pane itself: nothing there can be pressed, so the rest of what is being typed cannot retry the switch
// and reach the terminal after all. Choosing 原生终端 again retries.
function releaseHeldTerminal(id, entry) {
  render();
  const surface = entry?.element.isConnected && entry.element.querySelector('.terminal-surface');
  if (!surface?.contains(document.activeElement) || terminalCanInput(id) || canCaptureTerminal(id) || canFlushComposition(id)) return;
  entry.term.blur();
  const pane = $('native-pane');
  if (!pane.getClientRects().length) return;
  if (!pane.hasAttribute('tabindex')) { pane.tabIndex = -1; pane.addEventListener('blur', () => pane.removeAttribute('tabindex'), { once: true }); }
  pane.focus({ preventScroll: true });
}
function clearFailedTerminal(id) {
  const entry = terminals.get(id);
  if (entry?.failed) { entry.term.dispose(); entry.element.remove(); terminals.delete(id); }
}
function applyTerminalDisplay() {
  const theme = terminalThemes[terminalDisplay.palette];
  $('terminal-area').style.backgroundColor = theme.background;
  for (const entry of terminals.values()) { entry.term.options.fontSize = terminalDisplay.fontSize; entry.term.options.theme = { ...theme }; }
  fitTerminal(activeSessionId());
}
function pasteTerminal(text, id = activeSessionId()) {
  const entry = terminals.get(id);
  if (!terminalCanInput(id)) throw uiError("error.terminalControl");
  if (!text) return;
  if (text.length > 65500) throw uiError("error.pasteTooLong");
  if (/[\r\n]/.test(text) && !entry.term.modes.bracketedPasteMode) throw uiError("error.multilineProtection");
  entry.term.paste(text); focusTerminal(id);
}
const imageFiles = transfer => Array.from(transfer?.files || []).filter(file => file.type.startsWith('image/'));
async function pasteImages(files, staged, id = activeSessionId()) {
  const binding = sessionComposers.get(id), column = Boolean(binding?.column), bindingRevision = binding?.revision;
  const revision = selectionRevision, intended = state.sessions.find(s => s.id === id);
  if (column) {
    const fresh = await api.initial();
    if (!composerCurrent(binding) || !binding.column || binding.revision !== bindingRevision) throw uiError("error.imageColumnChanged");
    updateState(fresh);
  }
  const s = state.sessions.find(s => s.id === id), nativeId = intended?.nativeId, control = s?.controlRevision, generation = intended?.connectionRevision || 0;
  const valid = () => {
    const fresh = state.sessions.find(s => s.id === id);
    return fresh?.nativeId === nativeId && fresh.controlRevision === control && (fresh.connectionRevision || 0) === generation && !fresh.nativeContextPending && fresh.owner === owner && fresh.terminalState?.alive && ['idle', 'working'].includes(fresh.state) &&
      (column ? composerCurrent(binding) && binding.column && binding.revision === bindingRevision : selectionRevision === revision && activeSessionId() === id);
  };
  if (!s || !['codex', 'claude'].includes(s.provider) || !valid()) throw uiError("error.imageNeedsControl");
  if (!staged && (files.length > 4 || files.reduce((n, file) => n + file.size, 0) > 20 * 1024 * 1024)) throw uiError("error.imageSize");
  const paths = staged || await api.stageImages(id, nativeId, await Promise.all(files.map(async file => new Uint8Array(await file.arrayBuffer()))));
  if (!valid()) throw uiError("error.imageOwnerChanged");
  let terminalRevision = revision;
  if (column) { if (!await activateColumnNative(binding)) throw uiError("error.imageInputUnavailable"); }
  else { const switching = switchMode('terminal'); terminalRevision = selectionRevision; await switching; }
  const fresh = state.sessions.find(s => s.id === id);
  if (fresh?.nativeId !== nativeId || fresh.nativeContextPending || fresh.owner !== owner || !['idle', 'working'].includes(fresh.state) ||
      (column ? !composerCurrent(binding) || binding.revision !== bindingRevision : selectionRevision !== terminalRevision || activeSessionId() !== id) || !terminalCanInput(id)) throw uiError("error.imageInputChanged");
  for (const file of paths) pasteTerminal(JSON.stringify(file), id);
  revealTerminalCursor(terminals.get(id));
  toastMessage("toast.imageStaged");
}
function bindImageInput(element, id) {
  element.addEventListener('paste', event => {
    const files = imageFiles(event.clipboardData); if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); attempt(() => pasteImages(files, undefined, id));
  }, true);
  element.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  element.addEventListener('drop', event => {
    const files = imageFiles(event.dataTransfer); if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); attempt(() => pasteImages(files, undefined, id));
  });
}
function revealTerminalCursor(entry) {
  if (!entry || !columnTerminalBinding(entry.element.dataset.terminalId)) return;
  entry.term.scrollToBottom();
  requestAnimationFrame(() => {
    const surface = entry.element.querySelector('.terminal-surface'), buffer = entry.term.buffer.active;
    const cell = entry.term.element.querySelector('.xterm-screen')?.clientWidth / entry.term.cols;
    const line = entry.term.element.querySelector('.xterm-screen')?.clientHeight / entry.term.rows;
    if (surface && cell && line) { surface.scrollLeft = Math.max(0, (buffer.cursorX + 1) * cell - surface.clientWidth); surface.scrollTop = Math.max(0, (buffer.cursorY + 1) * line - surface.clientHeight); }
  });
}
function nativeVersionText(s) {
  if (s?.provider !== 'codex') return '';
  const status = disconnected && s.nativeVersion ? 'last-known' : s.nativeVersionStatus;
  if (status === 'last-known') return uiText('native.versionLast', { version: s.nativeVersion });
  if (status === 'verified') return uiText('native.versionVerified', { version: s.nativeVersion });
  if (status === 'unverified') return uiText('native.versionUnverified', { version: s.nativeVersion || uiText('native.versionMissing') });
  return uiText('native.versionNotReported');
}
// A late acknowledgement belongs to the opening that submitted it.
const dialogTickets = new WeakMap();
function openTransientDialog(id) {
  const dialog = $(id), ticket = { dialog }; dialogTickets.set(dialog, ticket);
  if (!dialog.open) dialog.showModal(); return ticket;
}
function currentDialogTicket(ticket) {
  return Boolean(ticket && ticket.dialog.isConnected && ticket.dialog.open && dialogTickets.get(ticket.dialog) === ticket);
}
let trustScope = null, trustRevision = 0, trustLoading = false, trustClearRoom = 'shared';
async function showTrust(options) {
  const dialog = $('privacy-dialog'), wasOpen = dialog.open, scroll = dialog.scrollTop, revision = selectionRevision;
  if (wasOpen && trustLoading) return;
  const generation = ++trustRevision;
  const scope = options?.usageScope || (wasOpen ? trustScope : null);
  if (!wasOpen) trustClearRoom = spaceId;
  ui.display.text($('clear-shared-history'), 'trust.clearSpace', () => ({ name: spaceRecord(trustClearRoom)?.name || uiText('sidebar.space') }));
  trustScope = scope; dialog.dataset.mode = scope ? 'usage' : 'privacy';
  ui.display.text(dialog.querySelector('h2'), scope ? 'trust.namedUsage' : 'privacy.open', scope ? () => ({ name: scope.kind === 'room' && scope.unavailable ? uiText('space.unavailable') : scope.name }) : undefined);
  if (!wasOpen) dialog.showModal();
  trustLoading = true;
  $('refresh-trust').disabled = true; ui.display.text($('refresh-trust'), 'trust.refreshing');
  ui.display.text($('trust-refresh-status'), 'trust.reading');
  dialog.setAttribute('aria-busy', 'true');
  const fresh = () => dialog.isConnected && dialog.open && generation === trustRevision;
  try {
  const snapshot = await api.initial();
  if (!fresh()) return;
  if (scope && revision !== selectionRevision) { ui.display.text($('trust-refresh-status'), 'trust.scopeChanged'); return; }
  const content = $('trust-status'); content.replaceChildren();
  const section = (titleKey, textKey, params) => { const item = node('section'); item.append(uiNode('h3', titleKey), uiNode('p', textKey, params)); content.append(item); return item; };
  if (!scope) {
  section('trust.destinations', 'trust.destinationsHelp');
  section('trust.modelCosts', 'trust.modelCostsHelp');
  const dispatches = snapshot.diagnostics?.dispatches;
  section('trust.dispatches', 'trust.dispatchesHelp', () => ({ count: Number.isSafeInteger(dispatches) ? uiText('trust.dispatchCount', { count: dispatches.toLocaleString(ui.language.getSnapshot().active) }) : uiText('version.unreported') }));
  if (snapshot.sessions.some(s => s.legacyInputEligible)) section('trust.originalInput', 'trust.originalInputHelp');
  }
  const usage = section(scope ? 'trust.readings' : 'trust.nativeUsage', 'trust.usageHelp');
  const sessions = !scope ? snapshot.sessions : scope.kind === 'room'
    ? snapshot.sessions.filter(s => inSpace(s, scope.roomId) && !s.archived)
    : snapshot.sessions.filter(s => s.id === scope.id && s.nativeId === scope.nativeId && !s.nativeContextPending);
  for (const s of sessions) {
    const item = node('section'); item.dataset.usageSession = s.id;
    const model = s.model ? node('p') : null; if (model) ui.display.computed(model, 'text', () => ui.displayText(s.model, s.modelUiMessage));
    item.append(node('h4', participantLabel(s, snapshot.sessions)), s.nativeContextPending ? uiNode('p', 'trust.contextPending') : model || uiNode('p', 'trust.modelMissing'));
    const usageValue = s.nativeContextPending ? null : s.usage;
    for (const [index] of window.nativeWorkspaceUsage.usageLines(s.provider, usageValue).entries()) { const line = node('p'); ui.display.computed(line, 'text', () => window.nativeWorkspaceUsage.usageLines(s.provider, usageValue, ui.language.getSnapshot().active)[index]); item.append(line); }
    usage.append(item);
  }
  if (!sessions.length) usage.append(uiNode('p', scope?.kind === 'session' ? 'trust.sessionChanged' : 'trust.noSessions'));
  if (!scope) {
  section('trust.permissions', 'trust.permissionsHelp', { count: snapshot.sessions.filter(s => !['ended', 'recoverable'].includes(s.state)).length });
  section('trust.versions', 'trust.versionsHelp', () => ({ app: snapshot.appVersion || uiText('version.unreported'), backend: snapshot.runtimeVersion || uiText('version.unreported'), retained: snapshot.services?.length > 1 ? uiText('trust.retainedBackends', { count: snapshot.services.length - 1 }) : '' }));
  }
  dialog.scrollTop = wasOpen ? scroll : 0;
  const refreshedAt = Date.now(); ui.display.text($('trust-refresh-status'), 'trust.refreshed', () => ({ time: new Date(refreshedAt).toLocaleTimeString(ui.language.getSnapshot().active, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }));
  } catch (error) {
    if (fresh()) ui.display.text($('trust-refresh-status'), 'trust.failed', () => ({ error: error.message ? ui.errorText(error) : uiText('trust.retry') }));
  } finally {
    if (fresh()) {
      trustLoading = false; $('refresh-trust').disabled = false; ui.display.text($('refresh-trust'), 'trust.refresh');
      dialog.removeAttribute('aria-busy');
    }
  }
}
$('privacy-dialog').addEventListener('close', event => {
  const dialog = event.currentTarget; if (dialog.open || !dialog.isConnected) return;
  trustRevision++; trustScope = null; trustLoading = false;
  $('trust-status').replaceChildren(); ui.display.unbind($('trust-refresh-status')); $('trust-refresh-status').textContent = '';
  $('refresh-trust').disabled = false; ui.display.text($('refresh-trust'), 'trust.refresh');
  ui.display.text(dialog.querySelector('h2'), 'privacy.open'); dialog.scrollTop = 0; dialog.removeAttribute('aria-busy');
  for (const detail of dialog.querySelectorAll('details')) detail.open = false;
});

function openCreate(provider = 'claude') {
  if (creatingSession) return;
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
  $('initial-view').value = preference; $('session-name').value = ''; $('claude-history-id').value = ''; $('skip-permissions').checked = false;
  $('create-space-kind').value = 'independent'; $('create-space-existing').value = ''; $('create-space-name').value = ''; delete $('create-space-name').dataset.edited;
  resetCreateDirectory(); ui.display.unbind($('create-error')); $('create-error').textContent = ''; openTransientDialog('create-dialog'); createReadiness();
}
// T-115: 开始一个会话 can also put the new session in a collaboration space. The order is session, then the space if it
// is new, then the join. Each finished step stays on this opening's receipt, so 仅继续加入 runs only the steps left and
// never creates the session or the space again. A choice that can't be valid creates nothing.
function createSpaceChoice() {
  const kind = $('create-space-kind').value;
  if (kind === 'independent') return { kind };
  if (kind === 'existing') {
    const room = spaceRecord($('create-space-existing').value);
    if (!room || room.archived) throw uiError('error.chooseLiveSpace');
    return { kind, roomId: room.id, name: room.name };
  }
  if (kind !== 'new') throw uiError('error.chooseSpaceAgain');
  // The same rules as the space service (session-labels validateName), checked before anything is created.
  const name = $('create-space-name').value.trim();
  if (!name) throw uiError('error.newSpaceName');
  if (name.length > 60) throw uiError('error.spaceNameLength');
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) throw uiError('error.spaceNameControls');
  return { kind, name };
}
function renderCreateSpaces() {
  if (!$('create-dialog').open) return;
  const kind = $('create-space-kind').value, select = $('create-space-existing'), rooms = allSpaces().filter(room => !room.archived);
  const roster = JSON.stringify(rooms.map(room => [room.id, room.name]));
  if (select.dataset.roster !== roster) {
    const chosen = select.value, named = name => rooms.filter(room => room.name === name).length > 1;
    const placeholder = new Option('', ''); ui.display.text(placeholder, 'create.spacePlaceholder');
    select.replaceChildren(placeholder);
    for (const room of rooms) select.add(new Option(named(room.name) ? `${room.name} · ${room.id.slice(0, 6)}` : room.name, room.id));
    select.value = rooms.some(room => room.id === chosen) ? chosen : ''; select.dataset.roster = roster;
    if (chosen && !select.value) createReadiness(); // the chosen space went away: 创建 must reflect it now
  }
  $('create-space-existing-wrap').hidden = kind !== 'existing'; $('create-space-new-wrap').hidden = kind !== 'new';
  const ticket = dialogTickets.get($('create-dialog')), locked = creatingSession || Boolean(ticket?.creation || ticket?.created);
  for (const id of ['create-space-kind', 'create-space-existing', 'create-space-name']) $(id).disabled = locked;
}
async function finishCreateSpace(ticket, revision) {
  const creation = ticket.creation, fresh = () => currentDialogTicket(ticket) && revision === selectionRevision;
  const kept = () => { const record = state.sessions.find(s => s.id === creation.sessionId), room = creation.roomId && spaceRecord(creation.roomId);
    return uiText('create.keptSession', { name: record?.name || sessionShortId(creation.sessionId), space: room ? uiText('create.keptSpace', { name: room.name }) : '' }); };
  // Not fresh means either the dialog closed or (still open) the selection moved; say which, and offer the retry if open.
  const paused = step => {
    const open = currentDialogTicket(ticket), key = open ? 'create.pausedChanged' : 'create.pausedClosed';
    const params = () => ({ kept: kept(), step: uiText(step) });
    if (open) ui.display.text($('create-error'), key, params); else toastMessage(key, params);
  };
  creatingSession = true; ui.display.unbind($('create-error')); $('create-error').textContent = ''; createReadiness();
  try {
    updateState(await api.initial()); render(); // a retry starts from the current records: an earlier join or space may have landed
    if (!creation.roomId) {
      if (!fresh()) return paused('create.stepNewSpace');
      // An error reply can follow a write that did happen. Spaces are compared with those before the first attempt, so a
      // retry keeps the one new space with this name instead of creating another; several are never guessed between.
      const adopted = () => {
        const added = allSpaces().filter(room => !creation.priorRooms.includes(room.id) && room.name === creation.choice.name);
        if (added.length > 1) throw uiError('error.ambiguousCreatedSpace');
        return added[0]?.id || '';
      };
      if (creation.priorRooms) creation.roomId = adopted(); else creation.priorRooms = allSpaces().map(room => room.id);
      if (!creation.roomId) {
        try { creation.roomId = await api.spaceCreate(creation.choice.name); }
        catch (error) { try { updateState(await api.initial()); render(); } catch {} creation.roomId = adopted(); if (!creation.roomId) throw error; }
        updateState(await api.initial()); render();
      }
    }
    const record = state.sessions.find(s => s.id === creation.sessionId), room = spaceRecord(creation.roomId);
    // These won't change by retrying, so they end the retry (final).
    if (!record || record.archived) throw Object.assign(uiError('error.createdSessionGone'), { final: true });
    if (!room || room.archived) throw Object.assign(uiError('error.createdSpaceGone'), { final: true });
    if (!window.nativeWorkspaceSpaces.canJoin(record, room.id)) throw Object.assign(oldBackendJoin(record), { final: true });
    if (!inSpace(record, room.id)) {
      if (!fresh()) return paused('create.stepJoinSpace');
      await api.spaceAction(room.id, 'join', [record.id, true]); updateState(await api.initial()); render();
      if (!inSpace(state.sessions.find(s => s.id === record.id), room.id)) throw uiError('error.spaceJoinDidNotApply');
    }
    // Joined. If the selection moved meanwhile the dialog may still be open: close it too, since nothing is left to do here
    // (branch table: E2, the join while the selection moved).
    if (fresh()) { $('create-dialog').close(); await select(record.id, creation.view); }
    else if (currentDialogTicket(ticket)) $('create-dialog').close();
    toastMessage('toast.createdSessionJoined', { name: room.name });
  } catch (error) {
    if (error.final) creation.blocked = true;
    // Whether the dialog is still open decides where the message goes and which retry it offers (a moved selection keeps
    // it open; only a closed dialog points to the session menu).
    const open = currentDialogTicket(ticket);
    const next = error.final ? 'create.joinFinalNext' : open ? 'create.joinRetryNext' : 'create.joinClosedNext';
    const params = () => ({ kept: kept(), reason: String(ui.errorText(error) || uiText('create.operationIncomplete')).replace(/[。.！!]?$/u, ui.language.getSnapshot().active === 'en' ? '. ' : '。'), next: uiText(next) });
    if (open) ui.display.text($('create-error'), 'create.joinFailure', params); else toastMessage('create.joinFailure', params);
  } finally { creatingSession = false; createReadiness(); }
}
function resetCreateDirectory() {
  invalidateGitPreview(true); $('git-worktree').checked = false; $('git-worktree-relative').value = '';
  newDirectory = state.capabilities?.includes('newSessionDirectory') && typeof state.newWorkspaceRoot === 'string';
  folder = newDirectory ? `${state.newWorkspaceRoot}/${crypto.randomUUID()}` : state.defaultWorkspace;
  $('chosen-folder').textContent = folder;
}
function invalidateGitPreview(newNonce = false) {
  clearTimeout(gitPreviewTimer); gitPreviewTimer = null; gitPreviewRevision++;
  gitWorktreePlan = null; gitPreviewLoading = false;
  if (newNonce) gitWorktreeNonce = crypto.randomUUID();
}
async function refreshGitPreview() {
  invalidateGitPreview();
  if (!$('git-worktree').checked || newDirectory || !$('create-dialog').open) { createReadiness(); return; }
  const ticket = dialogTickets.get($('create-dialog')), revision = gitPreviewRevision;
  const source = folder, relative = $('git-worktree-relative').value, nonce = gitWorktreeNonce;
  const current = () => currentDialogTicket(ticket) && revision === gitPreviewRevision && folder === source && $('git-worktree').checked;
  gitPreviewLoading = true; ui.display.text($('git-worktree-preview'), 'create.gitReading'); createReadiness();
  try {
    const plan = await api.gitWorktreePreview(source, nonce, relative);
    if (!current()) return;
    gitWorktreePlan = plan;
    ui.display.text($('git-worktree-preview'), 'create.gitPlan', { repository: plan.repository, revision: plan.revision.slice(0, 12), branch: plan.branch, cwd: plan.cwd });
    $('chosen-folder').textContent = plan.cwd;
  } catch (error) {
    if (current()) { gitWorktreePlan = null; ui.showError($('git-worktree-preview'), error); }
  } finally { if (current()) { gitPreviewLoading = false; createReadiness(); } }
}
function scheduleGitPreview() {
  invalidateGitPreview();
  $('chosen-folder').textContent = folder;
  if ($('git-worktree').checked) {
    ui.display.text($('git-worktree-preview'), 'create.gitWaiting');
    gitPreviewTimer = setTimeout(() => { gitPreviewTimer = null; refreshGitPreview(); }, 250);
  }
  createReadiness();
}
$('create-dialog').addEventListener('close', event => {
  if (!event.currentTarget.open) invalidateGitPreview();
});
let historySearch = '', historyRows = [], historyCursor = null, historySelected = null, historyLoading = false, historyImporting = false, historyGeneration = 0;
function renderNativeHistory() {
  if (!$('native-history-dialog').open) return;
  const list = $('native-history-list'); list.replaceChildren();
  for (const row of historyRows) {
    const label = node('label', undefined, 'native-history-row'), input = document.createElement('input');
    input.type = 'radio'; input.name = 'native-history-choice'; input.value = row.nativeId; input.checked = row.nativeId === historySelected;
    input.disabled = historyLoading || historyImporting || row.existingIds?.length > 1;
    const text = node('span'), stamp = node('small');
    ui.display.computed(stamp, 'text', () => {
      const time = Number.isFinite(row.updatedAt) && Math.abs(row.updatedAt * 1000) <= 8640000000000000 ? new Date(row.updatedAt * 1000).toLocaleString(ui.language.getSnapshot().active) : uiText('history.unknownTime');
      return [time, row.existingIds?.length && uiText('history.inWorkspace')].filter(Boolean).join(' · ');
    });
    text.append(row.name ? node('strong', row.name) : uiNode('strong', 'history.unnamed'), node('small', row.cwd), stamp);
    label.append(input, text); list.append(label);
    input.onchange = () => { historySelected = row.nativeId; updateNativeHistoryControls(); };
  }
  updateNativeHistoryControls();
}
function updateNativeHistoryControls() {
  if (!$('native-history-dialog').open) return;
  const row = historyRows.find(r => r.nativeId === historySelected), busy = historyLoading || historyImporting;
  $('confirm-native-history').disabled = busy || !row || row.existingIds?.length > 1;
  ui.display.text($('confirm-native-history'), historyImporting ? 'history.connecting' : row?.existingIds?.length ? 'history.existing' : 'history.continue');
  $('more-native-history').hidden = !historyCursor; $('more-native-history').disabled = busy;
  $('search-native-history').disabled = busy; $('native-history-search').disabled = busy;
  $('close-native-history').disabled = historyImporting;
}
async function loadNativeHistory(more = false) {
  if (historyLoading || historyImporting || !$('native-history-dialog').open) return;
  const generation = ++historyGeneration; historyLoading = true;
  if (!more) { historySearch = $('native-history-search').value; historyRows = []; historySelected = null; historyCursor = null; }
  renderNativeHistory(); ui.display.text($('native-history-status'), 'history.loading');
  try {
    const result = await api.nativeHistory({ search: historySearch, ...(more ? { cursor: historyCursor } : {}) });
    if (generation !== historyGeneration || !$('native-history-dialog').open) return;
    const seen = new Set(historyRows.map(r => r.nativeId)); historyRows.push(...result.data.filter(r => !seen.has(r.nativeId))); historyCursor = result.nextCursor;
    ui.display.text($('native-history-status'), historyRows.length ? 'history.count' : 'history.empty', historyRows.length ? () => ({ count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(historyRows.length) }) : undefined);
  } catch (error) { if (generation === historyGeneration && $('native-history-dialog').open) ui.showError($('native-history-status'), error); }
  finally { if (generation === historyGeneration) { historyLoading = false; renderNativeHistory(); } }
}
$('open-native-history').onclick = () => {
  // Claude has no history API: its own session picker opens in the new row's
  // terminal, and the chosen session is forked while the original stays as is.
  if (document.querySelector('input[name="provider"]:checked').value === 'claude') return attempt(async () => {
    const ticket = dialogTickets.get($('create-dialog')), revision = selectionRevision;
    if (!currentDialogTicket(ticket) || creatingSession || ticket.created || ticket.creation) return;
    if (newDirectory) throw uiError("error.historyDirectory");
    const nativeId = $('claude-history-id').value.trim();
    if (nativeId && !state.capabilities?.includes('claudeHistory')) throw uiError("error.takeoverUnsupported");
    creatingSession = true; createReadiness();
    const priorIds = new Set(state.sessions.map(s => s.id)); let forkId = '';
    try {
    const id = forkId = nativeId ? await api.importHistory(nativeId, { provider: 'claude', cwd: folder, name: $('session-name').value, skipPermissions: $('skip-permissions').checked })
      : await api.create({ provider: 'claude', cwd: folder, name: $('session-name').value, view: 'terminal', fork: 'picker', skipPermissions: $('skip-permissions').checked || undefined });
    // I161: like 创建, once the branched or taken-over session exists this opening makes no other, even if it stays open
    // (the selection moved) or the next read fails; set before that read so the id is never lost.
    ticket.created = id;
    updateState(await api.initial()); render();
    if (currentDialogTicket(ticket) && revision === selectionRevision) { $('create-dialog').close(); await select(id, 'terminal'); }
    else toastMessage("toast.requestedSessionRetained");
    } catch (error) {
      // I161: a branch whose reply failed may still have made its session; the same rule as 创建's catch. Exactly one new
      // working Claude session in this folder stops the dialog; without a fresh read nobody can tell (a chosen folder).
      if (!forkId) {
        let reread = true; try { updateState(await api.initial()); render(); } catch { reread = false; }
        const found = state.sessions.filter(s => s.provider === 'claude' && s.cwd === folder && !priorIds.has(s.id));
        if (!reread) ticket.created = 'unconfirmed';
        else if (found.length === 1 && found[0].state !== 'error') ticket.created = found[0].id;
      }
      throw error;
    } finally { creatingSession = false; createReadiness(); }
  });
  if (historyImporting) return;
  $('create-dialog').close(); historyRows = []; historySelected = null; historyCursor = null; historyLoading = false;
  $('native-history-search').value = ''; $('native-history-dialog').showModal(); loadNativeHistory();
};
$('native-history-search-form').onsubmit = event => { event.preventDefault(); loadNativeHistory(); };
$('more-native-history').onclick = () => loadNativeHistory(true);
$('close-native-history').onclick = () => $('native-history-dialog').close();
$('native-history-dialog').addEventListener('cancel', event => { if (historyImporting) event.preventDefault(); });
$('native-history-dialog').addEventListener('close', () => {
  if ($('native-history-dialog').open) return;
  historyGeneration++; historyLoading = false; historyRows = []; historySelected = null; historyCursor = null; historySearch = '';
  $('native-history-list').replaceChildren(); $('native-history-search').value = ''; ui.display.unbind($('native-history-status')); $('native-history-status').textContent = '';
});
$('confirm-native-history').onclick = async () => {
  if (!$('native-history-dialog').open || historyImporting || historyLoading || !historyRows.some(r => r.nativeId === historySelected)) return;
  const generation = historyGeneration, revision = selectionRevision;
  const fresh = () => $('native-history-dialog').open && generation === historyGeneration;
  historyImporting = true; renderNativeHistory(); ui.display.text($('native-history-status'), 'history.importing');
  try {
    const id = await api.importHistory(historySelected); updateState(await api.initial()); render();
    if (fresh() && revision === selectionRevision) { $('native-history-dialog').close(); await select(id, 'chat'); }
    else toastMessage('history.retained');
    if (state.sessions.find(s => s.id === id)?.archived) toastMessage('history.archived');
  } catch (error) { if (fresh()) ui.showError($('native-history-status'), error); else toastError(error); }
  finally { historyImporting = false; renderNativeHistory(); }
};
function openRename(id, origin, roomId = spaceId) {
  const record = id === 'room' ? spaceRecord(roomId) : state.sessions.find(s => s.id === id); if (!record) return;
  if (renaming) return toastMessage("toast.nameSaving");
  if (renameTarget) {
    if (renameTarget.id === id && (id !== 'room' || renameTarget.roomId === roomId) || $('rename-name').value !== renameTarget.originalName) {
      ui.revealSidebar(); $('rename-name').focus(); return toastMessage("toast.finishRename");
    }
    closeRename(false);
  }
  // A space's editor opens in its row in the 协作空间 section, which is hidden while that section is folded; the heading's
  // and the header's ⋯ are reachable then. Unfold the section first, as the person would (T-155).
  if (id === 'room' && state.sidebar?.workspaceCollapsed) {
    const revision = ++renameRevision;
    return attempt(async () => {
      await api.sidebar({ type: 'collapse', section: 'workspace', collapsed: false });
      if (revision !== renameRevision) return;
      if (state.sidebar?.workspaceCollapsed) state.sidebar = { ...state.sidebar, workspaceCollapsed: false };
      openRename(id, origin, roomId);
    });
  }
  const row = id === 'room' ? spaceRows.get(roomId)?.element : origin?.closest('.session-row') || sessionRow(id)?.element;
  if (!row || record.archived || id === 'room' && spaceRecord(roomId)?.archived) return;
  renameTarget = { id, roomId, origin, originalName: record.name, row, label: id === 'room' ? spaceRows.get(roomId).name : [...sessionRows.values()].find(r => r.element === row).name };
  renameRevision++; renameComposing = false; $('rename-name').value = record.name;
  ui.display.text($('rename-label'), id === 'room' ? 'rename.workspace' : 'rename.session');
  $('rename-error').hidden = true; ui.display.unbind($('rename-error')); $('rename-error').textContent = '';
  row.classList.add('is-renaming'); renameTarget.label.hidden = true;
  row.append($('rename-editor')); $('rename-editor').hidden = false; ui.revealSidebar();
  render(); $('rename-name').focus(); $('rename-name').select();
}
function renameProblem(target = renameTarget) {
  if (!target) return '';
  const record = target.id === 'room' ? spaceRecord(target.roomId) : state.sessions.find(s => s.id === target.id);
  if (!record || record.archived) return uiError('error.renameUnavailable');
  if (record.name !== target.originalName) return uiError('error.renameChanged');
  if (disconnected) return uiError('error.renameDisconnected');
  return '';
}
function showRenameError(message, kind = 'save') {
  if (typeof message === 'string') { ui.display.unbind($('rename-error')); if ($('rename-error').textContent !== message) $('rename-error').textContent = message; }
  else ui.showError($('rename-error'), message);
  $('rename-error').dataset.kind = kind; $('rename-error').hidden = false;
}
function renderRename() {
  if (!renameTarget) return;
  const problem = renaming ? '' : renameProblem();
  if (problem) showRenameError(problem, 'state');
  else if ($('rename-error').dataset.kind === 'state') $('rename-error').hidden = true;
  $('confirm-rename').disabled = renaming || Boolean(problem); $('cancel-rename').disabled = renaming;
  $('rename-name').readOnly = renaming; $('rename-form').setAttribute('aria-busy', String(renaming));
  const record = state.sessions.find(s => s.id === renameTarget.id), row = sessionRow(renameTarget.id);
  if (row && (!record || record.archived)) {
    ui.display.text(row.status, record?.archived ? 'rename.archivedPending' : 'rename.unavailablePending');
    row.link.disabled = !record; row.more.disabled = true;
  }
}
function closeRename(returnFocus = true) {
  if (!renameTarget || renaming) return;
  const target = renameTarget; renameTarget = null; renameRevision++; renameComposing = false;
  $('rename-editor').hidden = true; $('header').parentElement.append($('rename-editor'));
  target.row.classList.remove('is-renaming'); target.label.hidden = false; render();
  if (returnFocus) {
    const action = target.origin?.isConnected && target.origin.getClientRects().length ? target.origin : target.id === 'room' ? $('room-more') : sessionRow(target.id)?.more;
    (action?.getClientRects().length && !action.disabled ? action : $(target.id === 'room' ? 'workspace-toggle' : 'solo-drop')).focus({ preventScroll: true });
  }
}
function focusSessionAction(id) { if (id === 'room') $('room-more').focus(); else sessionRow(id)?.more.focus(); }
const roomMenuKey = (id = spaceId) => JSON.stringify([id, selectionRevision, disconnected, spaceRecord(id)?.name, spaceRecord(id)?.archived]);
function openRoomMenu(point, anchor, id = spaceId) {
  const room = spaceRecord(id); anchor ||= spaceRows.get(id)?.more || $('room-more');
  contentMenu?.close(); if (!room || room.archived || disconnected || anchor.disabled) return;
  if (!point && roomMenu?.anchor === anchor) { roomMenu(); return; }
  roomMenu?.(); sessionMenu?.close(); anchor.focus(); anchor.setAttribute('aria-expanded', 'true');
  const key = roomMenuKey(id);
  roomMenu = ui.menu({
    items: [{ id: 'create', label: uiText('menu.newSpace'), labelKey: 'menu.newSpace' }, { id: 'merge', label: uiText('menu.mergeSpaces'), labelKey: 'menu.mergeSpaces', disabled: allSpaces().filter(room => !room.archived).length < 2 }, ...(room.merge ? [{ id: 'merge-record', label: uiText('menu.mergeDetails'), labelKey: 'menu.mergeDetails' }] : []), { id: 'rename', label: uiText('menu.rename'), labelKey: 'menu.rename' }, { id: 'notes', label: uiText('menu.notes'), labelKey: 'menu.notes' }, { id: 'files', label: uiText('menu.spaceFiles'), labelKey: 'menu.spaceFiles' }, { id: 'usage', label: uiText('header.usage'), labelKey: 'header.usage' }, { id: 'about', label: uiText('menu.collaborationAbout'), labelKey: 'menu.collaborationAbout' }, ...(state.wakePolicy ? [{ id: 'wake-global', label: uiText(state.wakePolicy.enabled ? 'menu.wakeDisableAll' : 'menu.wakeEnableAll'), labelKey: state.wakePolicy.enabled ? 'menu.wakeDisableAll' : 'menu.wakeEnableAll' }] : []), { id: 'archive', label: uiText('menu.archiveWorkspace'), labelKey: 'menu.archiveWorkspace' }],
    getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect(),
    onClose: () => { roomMenu = null; anchor.setAttribute('aria-expanded', 'false'); if (key === roomMenuKey(id) && anchor.isConnected && anchor.getClientRects().length && !anchor.disabled) anchor.focus({ preventScroll: true }); },
    onSelect: action => {
      if (key !== roomMenuKey(id)) return;
      if (action === 'create') openSpaceCreate();
      else if (action === 'merge') openSpaceMerge(id);
      else if (action === 'merge-record') attempt(() => openMergeRecord(id));
      else if (action === 'wake-global') attempt(() => api.wakePolicy(null, !state.wakePolicy?.enabled));
      else if (action === 'rename') openRename('room', anchor, id);
      else if (action === 'notes') openNotes(id);
      else if (action === 'files') attempt(async () => { await selectSpace(id); openSpaceFiles(); });
      else if (action === 'usage') attempt(() => showTrust({ usageScope: { kind: 'room', roomId: id, name: room.name } }));
      else if (action === 'about') toastMessage("toast.collaborationAbout");
      else if (action === 'archive') attempt(async () => { await api.spaceAction(id, 'archive', []); toastMessage("toast.workspaceArchived"); });
    },
  });
  roomMenu.key = key; roomMenu.anchor = anchor; roomMenu.roomId = id;
}
// Facts refresh in place while the menu is open; a changed action list or order closes it, because
// onSelect acts on the neighbours and memberships captured when it opened.
function sessionMenuModel(id, row) {
  const record = state.sessions.find(s => s.id === id), group = row.spaceId;
  const visible = group ? orderedMembers(group) : sidebarSessions(), index = visible.findIndex(s => s.id === id);
  const roomItems = allSpaces().filter(r => !r.archived).map(r => ({ id: `membership:${r.id}`, label: uiText(inSpace(record, r.id) ? 'menu.leaveSpace' : 'menu.joinSpace', { name: r.name }), labelKey: inSpace(record, r.id) ? 'menu.leaveSpace' : 'menu.joinSpace', labelParams: { name: r.name } }));
  // Right under the version fact that says this backend is older (T-131).
  const update = backendVersionNotice(record, state.appVersion)?.kind === 'old' && !record.archived ? [{ id: 'update-backend', label: uiText('menu.updateThisBackend'), labelKey: 'menu.updateThisBackend' }] : [];
  const actions = [...update, { id: 'rename', label: uiText('menu.rename'), labelKey: 'menu.rename' }, ...(index > 0 ? [{ id: 'up', label: uiText('menu.moveUp'), labelKey: 'menu.moveUp' }] : []), ...(index < visible.length - 1 ? [{ id: 'down', label: uiText('menu.moveDown'), labelKey: 'menu.moveDown' }] : []), { id: 'copy-id', label: uiText('menu.copyNawId'), labelKey: 'menu.copyNawId' }, ...(record.nativeId ? [{ id: 'copy-native-id', label: uiText('menu.copyNativeId'), labelKey: 'menu.copyNativeId' }] : []), ...roomItems, { id: 'window', label: uiText('menu.separateWindow'), labelKey: 'menu.separateWindow' }, ...((record.serviceCapabilities || state.capabilities || []).includes('agentWakeV1') ? [{ id: 'wake-session', label: uiText(record.wakeDisabled ? 'menu.wakeAllow' : 'menu.wakeDisallow'), labelKey: record.wakeDisabled ? 'menu.wakeAllow' : 'menu.wakeDisallow' }] : []), ...((record.serviceCapabilities || state.capabilities || []).includes('observe') ? [] : [{ id: 'continue', label: uiText('menu.refreshConnection'), labelKey: 'menu.refreshConnection' }]), { id: 'archive', label: uiText('menu.archiveSession'), labelKey: 'menu.archiveSession' }].map(item => ({ ...item, disabled: disconnected || item.disabled }));
  return { record, group, visible, index, actionsKey: JSON.stringify([actions.map(({ label, ...action }) => action.labelKey ? action : { ...action, label }), visible.map(s => s.id)]),
    items: [...sidebarDetails(record).map((text, index) => ({ type: 'label', id: 'session-fact-' + index, text, labelRead: () => sidebarDetails(record)[index] })), { type: 'separator', id: 'session-facts-actions' }, ...actions] };
}
function openSessionMenu(id, point, rowKey = id) {
  contentMenu?.close(); if (!state.sessions.some(s => s.id === id)) return;
  if (!point && sessionMenu?.rowKey === rowKey && !sessionMenu.anchor) { sessionMenu.close(); return; }
  sessionMenu?.close(); roomMenu?.();
  const row = sessionRows.get(rowKey) || sessionRow(id); if (!row) return;
  row.more.focus(); row.more.setAttribute('aria-expanded', 'true');
  const model = sessionMenuModel(id, row), { record, group, visible, index } = model;
  const close = ui.menu({
    // Read-only facts first (full name, IDs, status, spaces, times, versions), then the original actions.
    items: model.items,
    // The facts make this menu taller than the window can fit above or below the row; anchoring at the
    // trigger's right edge keeps the clamped menu beside ⋯, so a second click still closes it.
    getAnchorRect: () => { if (point) return { left: point.x, right: point.x, top: point.y, bottom: point.y }; const box = row.more.getBoundingClientRect(); return { left: box.right, right: box.right, top: box.top, bottom: box.bottom, width: 0, height: box.height }; },
    onClose: () => { sessionMenu = null; row.more.setAttribute('aria-expanded', 'false'); if (row.more.isConnected && row.more.getClientRects().length) row.more.focus({ preventScroll: true }); else focusSessionAction(id); },
    onSelect: action => {
      if (disconnected || !state.sessions.some(s => s.id === id)) return;
      if (action.startsWith('membership:')) {
        const destination = action.slice(11), person = state.sessions.find(s => s.id === id);
        attempt(() => inSpace(person, destination) ? detach(id, destination) : addToSpace(id, destination));
      } else if (action === 'wake-session') attempt(() => api.wakePolicy(id, Boolean(state.sessions.find(s => s.id === id)?.wakeDisabled)));
      else if (action === 'update-backend') attempt(() => updateSessionBackend(id));
      else if (action === 'up' || action === 'down') attempt(() => group ? moveRoomMember(id, action === 'up' ? visible[index - 1]?.id : visible[index + 1]?.id, action === 'down', group) : moveSidebarSession(id, action === 'up' ? visible[index - 1]?.id : visible[index + 1]?.id, action === 'down'));
      else if (action === 'copy-id' || action === 'copy-native-id') attempt(() => api.copy(action === 'copy-id' ? id : state.sessions.find(s => s.id === id)?.nativeId));
      else if (action === 'rename') openRename(id, row.more);
      else if (action === 'continue') attempt(() => api.continueConnection(id));
      else if (action === 'window') attempt(() => api.newWindow(id));
      else if (action === 'archive') attempt(async () => { await api.archiveSession(id); toastMessage("toast.sessionArchived"); });
    },
  });
  sessionMenu = { id, rowKey, row, close, kind: 'session', factsKey: sidebarFactsKey(record), actionsKey: model.actionsKey };
}

function memberMenuKey(id) {
  const record = members().find(s => s.id === id);
  return selected === 'room' && !disconnected && !state.room.archived && record
    ? JSON.stringify([selectionRevision, roomSurface, roomSession, id, spaceId, pairRevision(record), record.nativeId, record.archived]) : null;
}
function focusMemberAction(anchor) {
  const visible = element => element?.isConnected && !element.disabled && element.getClientRects().length;
  const target = visible(anchor) ? anchor : visible($('manage-members')) ? $('manage-members') : $('room-nav');
  target.focus({ preventScroll: true });
}
function openMemberMenu(id, anchor) {
  if (sessionMenu?.anchor === anchor) return sessionMenu.close();
  const key = memberMenuKey(id);
  if (!key || !anchor.isConnected) return;
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  anchor.focus({ preventScroll: true }); anchor.setAttribute('aria-expanded', 'true');
  const people = orderedMembers(), index = people.findIndex(s => s.id === id), reorder = roomSurface === 'overview' && !roomSession;
  const close = ui.menu({
    contextElement: anchor,
    items: [{ id: 'detach', label: uiText('menu.detach'), labelKey: 'menu.detach' }, { id: 'copy-id', label: uiText('menu.copyNawId'), labelKey: 'menu.copyNawId' },
      ...(columnTerminalBinding(id) ? [{ id: 'terminal-height-all', label: uiText('menu.terminalHeightAll'), labelKey: 'menu.terminalHeightAll' }] : []),
      ...(reorder && index > 0 ? [{ id: 'earlier', label: uiText('menu.moveUp'), labelKey: 'menu.moveUp' }] : []),
      ...(reorder && index < people.length - 1 ? [{ id: 'later', label: uiText('menu.moveDown'), labelKey: 'menu.moveDown' }] : [])],
    getAnchorRect: () => {
      const rect = anchor.getBoundingClientRect(), band = (anchor.closest('.collaboration-statuses') || anchor.closest('.collaboration-member-status') || anchor).getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: band.bottom, bottom: band.bottom };
    },
    onClose: () => {
      if (sessionMenu?.close === close) sessionMenu = null;
      anchor.setAttribute('aria-expanded', 'false');
      focusMemberAction(key === memberMenuKey(id) ? anchor : null);
    },
    onSelect: action => {
      if (key !== memberMenuKey(id)) return toastMessage("toast.memberChanged");
      if (action === 'copy-id') attempt(() => api.copy(id));
      else if (action === 'terminal-height-all') {
        const source = columnTerminalBinding(id); if (!source) return toastMessage('toast.terminalHidden');
        const height = source.terminalHeight ?? columnTerminalHeight(id), lower = [];
        for (const member of orderedMembers()) {
          const binding = columnTerminalBinding(member.id), value = binding ? applyColumnTerminalHeight(binding, height, 'adjust') : height;
          rememberColumnTerminalHeight(member.id, value); if (binding) fitColumnTerminal(binding);
          if (value !== height) lower.push(participantLabel(member, state.sessions));
        }
        attempt(persistView);
        toastMessage(lower.length ? 'toast.terminalHeightLimited' : 'toast.terminalHeightAll', { height, names: lower.join('、') });
      }
      else if (action === 'detach') attempt(() => detach(id));
      else if (action === 'earlier' || action === 'later') {
        const people = orderedMembers(), index = people.findIndex(s => s.id === id), target = people[index + (action === 'earlier' ? -1 : 1)];
        if (!target) return toastMessage("toast.orderBoundary");
        attempt(async () => { captureReadingViews(); restoreOverviewReading(); toastMessage('collab.memberMoved', await moveRoomMember(id, target.id, action === 'later')); });
      }
    },
  });
  sessionMenu = { id, anchor, key, kind: 'member', close };
}
function sidebarSessions() {
  const ranks = new Map((state.sidebar?.order || []).map((id, index) => [id, index]));
  return state.sessions.filter(s => !s.archived).sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}
function versionValue(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9.+_-]{0,95}$/i.test(value) ? value : null;
}
function compactAppVersion(value) {
  const version = versionValue(value), alpha = version?.match(/^\d+\.\d+\.\d+-alpha\.(\d+)$/);
  return alpha ? 'α' + alpha[1] : version || '?';
}
function backendVersionNotice(record, applicationVersion) {
  const backend = versionValue(record.runtimeVersion), application = versionValue(applicationVersion);
  if (backend && backend === application) return null;
  const alpha = value => value?.match(/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-alpha\.(0|[1-9]\d*)$/);
  const from = alpha(backend), to = alpha(application);
  const old = from && to && from[1] === to[1] && Number.isSafeInteger(Number(from[2])) && Number.isSafeInteger(Number(to[2])) && Number(from[2]) < Number(to[2]);
  return backend ? { kind: old ? 'old' : 'different', label: uiText(old ? 'version.oldLabel' : 'version.differentLabel'), title: uiText('version.comparisonTitle', { backend, app: application || uiText('version.appUnknown'), advice: uiText(old ? 'version.oldAdvice' : 'version.differentAdvice') }) }
    : { kind: 'unknown', label: uiText('version.kindUnknown'), title: uiText('version.backendUnknownHelp') };
}
function backendVersionSummary(records, applicationVersion) {
  const unique = new Map(records.filter(record => !record.archived).map(record => [record.id, record]));
  const result = { old: 0, different: 0, unknown: 0, count: 0, label: '' };
  for (const record of unique.values()) {
    const notice = backendVersionNotice(record, applicationVersion);
    if (notice) { result[notice.kind]++; result.count++; }
  }
  result.label = [result.old && uiText('version.oldSessions', { count: result.old }), result.different && uiText('version.differentSessions', { count: result.different }), result.unknown && uiText('version.unknownSessions', { count: result.unknown })].filter(Boolean).join(' · ');
  return result;
}
// Presentation only: existing native observation facts remain the source of truth.
// The background work Claude reports at turn end (T-117) keeps its own text and dot.
function sidebarPresentation(record) {
  const live = Object.hasOwn(states, record.state) && !disconnected && !record.backendUnavailable && !record.transportDisconnected &&
    !['disconnected', 'recoverable', 'ended', 'stopping'].includes(record.state);
  const facts = window.nativeWorkspaceCollaboration.statusFacts(record, !disconnected, Date.now(), ui.language.getSnapshot().active);
  const fleet = window.nativeWorkspaceFleet.currentFleet(record, !disconnected, uiText), work = fleet.work, recovery = exhaustedRecovery(record);
  const workTone = window.nativeWorkspaceFleet.workTone(record, !disconnected);
  const waiting = Boolean(record.approval || record.approvalOverflow || record.claudeQuestion || record.nativeApproval?.requests?.length || record.nativeInputRequired);
  const question = Boolean(record.claudeQuestion || record.approval?.method === 'item/tool/requestUserInput');
  const reported = record.state === 'idle' && (work.count > 0 || work.unconfirmed);
  let base = switchedAway(record) ? uiText('state.switched') : facts.state;
  if (live && !record.nativeContextPending) {
    if (record.nativeInputRequired) base = uiText('composer.nativeInput');
    else if (waiting && !question) base = uiText('state.approval');
  }
  // An interrupt or a question can coincide with reported or unconfirmed background work; keep both facts.
  if (reported && work.text && !base.includes(work.text)) base += ' · ' + work.text;
  const childrenActive = fleet.running > 0 || fleet.unknown > 0;
  const compact = recovery ? (reported ? work.text + ' · ' : '') + recoveryStatusSuffix(recovery, false) : (record.state === 'idle' && childrenActive && !reported && !waiting && live && !record.nativeContextPending
    ? facts.compactChild : base + (childrenActive ? ' · ' + facts.compactChild : '')) + recoveryStatusSuffix(recovery);
  const root = record.state === 'idle' && !reported && fleet.observed && live && !record.nativeContextPending && !waiting ? uiText('fleet.rootReady') : base;
  const full = [root, facts.child, record.provider === 'claude' && record.nativeInputRequired && uiText('sidebar.nativeStoppedHelp')].filter(Boolean).join(' · ') + recoveryStatusSuffix(recovery);
  // Red (approval) is only for something that needs the person or failed (T-145): sub-tasks whose end was
  // not observed are not that. An idle row with them, or with unconfirmed background work, gets the grey
  // hollow mark and a ◌ in the rail (? is the rail's mark for an unreported backend version), so a folded
  // group does not count it as needing attention.
  const tone = !live || record.nativeContextPending ? 'disconnected' : waiting || recovery || record.state === 'error'
    ? 'approval' : fleet.running || ['working', 'starting', 'background'].includes(record.state) ? 'working' : record.state === 'idle' ? 'idle' : record.state || 'disconnected';
  const childTone = workTone || (tone === 'idle' && fleet.unknown ? 'bg-unknown' : '');
  const marker = tone === 'approval' || tone === 'disconnected' ? '!' : tone === 'working' || childTone === 'bg-work' ? '…' : childTone === 'bg-unknown' ? '◌' : '○';
  return { compact, full, tone, workTone: childTone, marker,
    detail: Boolean(waiting || childrenActive || reported || recovery || !['idle', 'working', 'starting'].includes(record.state) || !live || record.nativeContextPending || record.nativeInputRequired) };
}
function sidebarDetails(record) {
  const memberships = allSpaces().filter(room => !room.archived && inSpace(record, room.id));
  const notice = backendVersionNotice(record, state.appVersion), provider = record.provider === 'claude' ? 'Claude' : 'Codex';
  return [record.name, provider, 'NAW ' + record.id, provider + ' ' + (record.nativeId || uiText('advanced.establishing')), sidebarPresentation(record).full,
    memberships.length ? uiText('sidebar.membershipFacts', { names: memberships.map(room => room.name).join('、') }) : uiText('sidebar.independent'), sessionTimes(record),
    notice?.title || uiText('sidebar.versionFacts', { backend: versionValue(record.runtimeVersion) || uiText('version.unreported'), app: versionValue(state.appVersion) || uiText('version.unreported') })];
}
function sidebarFactsKey(record) {
  return JSON.stringify([disconnected, sidebarDetails(record)]);
}
function appVersionReport(snapshot) {
  const version = versionValue(snapshot.appVersion) || uiText('version.unreported'), commit = snapshot.appBuild?.commit;
  const installedAt = snapshot.appBuild?.installedAt;
  const installation = typeof installedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(installedAt) &&
    Number.isFinite(Date.parse(installedAt)) && new Date(installedAt).toISOString() === installedAt ? installedAt : uiText('time.unrecorded');
  const lines = ['Native Agent Workspace', uiText('version.appReport', { version }),
    uiText('version.commit', { commit: typeof commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ? commit : uiText('time.unrecorded') }),
    uiText('version.installed', { time: installation }), uiText('version.backendReportHelp')];
  for (const [i, service] of (Array.isArray(snapshot.services) ? snapshot.services : []).entries()) {
    lines.push(uiText('version.service', { index: i + 1, version: versionValue(service.version) || uiText('version.unreported'), kind: uiText(service.active ? 'version.newSessions' : 'version.retainedSessions'), count: Number.isSafeInteger(service.sessions) && service.sessions >= 0 ? service.sessions : uiText('version.unknown') }));
  }
  return lines.join('\n');
}
function renderVersions() {
  const version = () => versionValue(state.appVersion) || uiText('version.unreported'), control = $('app-version');
  ui.display.computed($('app-version-label'), 'text', () => 'v' + version());
  $('app-version-compact').textContent = compactAppVersion(state.appVersion);
  ui.display.attribute(control, 'aria-label', 'version.copyAria', () => ({ version: version() }));
  ui.display.attribute(control, 'title', 'version.copyTitle', () => ({ version: version() }));
  const summary = backendVersionSummary(state.sessions, state.appVersion), action = $('backend-version-summary');
  // Sessions an unfinished move ended keep the control reachable even with no old backend left.
  const ended = Array.isArray(state.switchEnded) ? state.switchEnded.length : 0;
  action.hidden = summary.count === 0 && !ended;
  if ((!summary.count && !ended) || disconnected) { backendVersionTicket++; backendVersionMenu?.(); backendVersionMenu = null; }
  if (!checkingBackendVersions) ui.display.computed(action, 'text', () => summary.old ? uiText('version.summaryOld', { old: summary.old, more: summary.count > summary.old ? ` +${summary.count - summary.old}` : '' }) : uiText(summary.count ? 'version.summaryCheck' : 'version.summaryReconnect', { count: summary.count || ended }));
  const title = () => summary.count ? uiText('version.liveSummaryHelp', { summary: backendVersionSummary(state.sessions, state.appVersion).label }) : uiText('version.summaryEnded', { count: ended });
  ui.display.computed(action, 'title', title); ui.display.computed(action, 'aria-label', title); action.disabled = disconnected;
  action.setAttribute('aria-disabled', String(disconnected || checkingBackendVersions)); action.setAttribute('aria-busy', String(checkingBackendVersions));
}
$('app-version').onclick = () => { if (state) return ui.copyCode(appVersionReport(state)).catch(() => {}); };
let checkingBackendVersions = false, backendVersionMenu, backendVersionTicket = 0;
async function openBackendVersions() {
  const control = $('backend-version-summary');
  if (checkingBackendVersions || disconnected || !state) return;
  backendVersionMenu?.(); backendVersionMenu = null;
  const ticket = ++backendVersionTicket, revision = selectionRevision;
  checkingBackendVersions = true; control.setAttribute('aria-disabled', 'true'); control.setAttribute('aria-busy', 'true'); ui.display.text(control, 'version.checking');
  try {
    const [options, settings] = await Promise.all([api.connectionUpdates(), api.backendSwitchSettings()]);
    if (ticket !== backendVersionTicket || revision !== selectionRevision || disconnected || !control.isConnected || document.activeElement !== control || document.querySelector('dialog[open]')) return;
    const interrupted = settings.interrupted.length ? () => uiText('version.interruptedSessions', { names: settings.interrupted.join('、') }) : null;
    if (!options.length && !interrupted) return toastMessage('version.noneToCheck');
    backendVersionMenu = ui.menu({
      items: [...options.map((option, index) => ({ id: String(index), labelRead: () => backendOptionLabel(option) })),
        ...(interrupted ? [{ id: 'interrupted', labelRead: interrupted }] : []),
        { id: 'auto', label: uiText(settings.auto ? 'version.autoOn' : 'version.autoOff'), labelKey: settings.auto ? 'version.autoOn' : 'version.autoOff' }],
      getAnchorRect: () => control.getBoundingClientRect(),
      onClose: () => { backendVersionMenu = null; if (revision === selectionRevision && control.isConnected && !control.hidden) control.focus({ preventScroll: true }); },
      onSelect: key => {
        if (ticket !== backendVersionTicket) return;
        if (key === 'interrupted') return toastMessage('version.interruptedSessions', { names: settings.interrupted.join('、') });
        if (key === 'auto') return attempt(async () => { const next = await api.backendSwitchSettings(!settings.auto); toastMessage(next.auto ? 'toast.autoBackendOn' : 'toast.autoBackendOff'); });
        const option = options[Number(key)];
        if (option) return runBackendOption(option);
      },
    });
  } finally { checkingBackendVersions = false; renderVersions(); }
}
// One label and one action per old backend, shared by the sidebar's old-sessions
// menu and a session's own ⋯ menu (T-131), so each backend says whose it is.
function backendOptionLabel(option) {
  // Names as this window shows them (renames included); the action comes first so
  // a narrow menu never hides what a click does.
  const shown = id => state.sessions?.find(record => record.id === id)?.name;
  const short = name => name.length > 16 ? name.slice(0, 16) + '…' : name;
  const names = [...new Set(Array.isArray(option.sessions) ? option.sessions.map(s => shown(s.id) || s.name).filter(Boolean) : [])].slice(0, 3);
  const who = names.length ? uiText('version.optionNames', { names: names.map(short).join('、'), more: option.count > names.length ? uiText('version.moreNames') : '' }) : '';
  return uiText('version.connectionOption', { version: option.version ? compactAppVersion(option.version) : uiText('version.kindUnknown'), action: uiText(option.ready ? 'version.updateAction' : option.switch?.ready ? 'version.endUpdateAction' : 'version.keepAction'), count: option.count, who });
}
function runBackendOption(option) {
  if (!option.ready && option.switch?.ready) return attempt(async () => { const result = await api.switchBackend({ backendKey: option.backendKey, switch: option.switch }); if (result) { toast(''); ui.display.computed($('toast-text'), 'text', () => backendSwitchedText(result)); } });
  if (!option.ready) {
    const switchBlocked = option.switch?.reason && !option.switch.ready, message = switchBlocked ? option.switch.reason : option.reason;
    toast(message); ui.showError($('toast-text'), { message, uiMessage: switchBlocked ? option.switch.reasonUiMessage : option.reasonUiMessage }); return;
  }
  return attempt(async () => {
    const updated = await api.continueConnection(option.id, { backendKey: option.backendKey, nativeId: option.nativeId, version: option.version });
    if (updated) toastMessage('version.updated');
  });
}
// From a session's own menu: find the backend that holds it now, then act as the sidebar would.
async function updateSessionBackend(id) {
  const options = await api.connectionUpdates();
  const option = options.find(o => Array.isArray(o.sessions) && o.sessions.some(s => s.id === id));
  if (!option) return toastMessage('version.noUpdateNeeded');
  return runBackendOption(option);
}
function backendSwitchedText(result) {
  if (result.error) return uiText('version.autoFailed', { error: ui.displayText(result.error, result.errorUiMessage) });
  const left = Array.isArray(result.left) ? result.left.length : Number(result.left) || 0;
  const reconnect = result.reconnectFailed ? uiText('version.reconnectWindowFailed') : '';
  return uiText(left ? 'version.updatedSomeLeft' : 'version.updatedAll', { count: left }) + reconnect;
}
$('backend-version-summary').onclick = () => attempt(openBackendVersions);
$('backend-version-summary').addEventListener('keydown', event => { if (event.key === 'Escape') { backendVersionTicket++; backendVersionMenu?.(); } });
function sessionShortId(id) {
  let length = Math.min(6, id.length);
  while (length < id.length && state.sessions.some(s => s.id !== id && s.id.startsWith(id.slice(0, length)))) length++;
  return id.slice(0, length);
}
async function moveSidebarSession(id, target, after) {
  if (!target || id === target) return;
  await api.sidebar({ type: 'move', id, target, after });
}
function renderSidebarGroups() {
  // T-145: the grouped view's headings are the space list; the layout gives 协作空间 only its content height.
  $('workspace-group').dataset.groupedSessions = String(sidebarView === 'grouped');
  const visible = state.sessions.filter(s => !s.archived);
  const working = visible.filter(s => s.state === 'working').length;
  ui.display.computed($('session-group-summary'), 'text', () => working ? uiText('sidebar.workingCount', { count: visible.length, working }) : String(visible.length));
  ui.display.computed($('workspace-group-summary'), 'text', () => state.room.archived ? '0' : uiText('sidebar.memberCount', { count: members().length }));
  // The drop hint counts toward the section's fixed height, so it is shown or hidden before the layout measures (T-136).
  document.querySelector('.drop-hint').hidden = !allSpaces().some(r => !r.archived);
  for (const [section, control, body] of [['sessions', 'solo-drop', 'session-list'], ['workspace', 'workspace-toggle', 'workspace-group-body'], ['archive', 'archive-button', 'archive-group-body']]) {
    const collapsed = section === 'archive' ? state.sidebar?.archiveCollapsed !== false : Boolean(state.sidebar?.[section + 'Collapsed']), toggle = $(control);
    const name = () => uiText({ sessions: 'sidebar.sessions', workspace: 'sidebar.spaces', archive: 'sidebar.archive' }[section]);
    ui.display.computed(toggle, 'aria-label', () => section === 'archive' ? uiText('sidebar.archiveAria', { count: state.sessions.filter(s => s.archived).length + Number(Boolean(state.room.archived)) }) : uiText('sidebar.groupAria', { name: name(), summary: section === 'sessions' ? working ? uiText('sidebar.workingCount', { count: visible.length, working }) : String(visible.length) : uiText('sidebar.spaceCount', { count: allSpaces().filter(room => !room.archived).length }) }));
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.querySelector('.group-chevron').textContent = collapsed ? '▸' : '▾';
    if (collapsed && $(body).contains(document.activeElement)) { sessionMenu?.close(); roomMenu?.(); toggle.focus(); }
    $(body).hidden = collapsed;
    ui.display.attribute(toggle, 'title', collapsed ? 'sidebar.expand' : 'sidebar.collapse', () => ({ name: section === 'sessions' ? uiText('sidebar.sessionDrop') : name() }));
  }
  sidebarLayout?.update(state.sidebar);
}
// Each grouped-view section (space or independent) folds on its own; the choice is saved with the view.
function toggleSidebarGroup(id) {
  const key = id || 'independent';
  if (sidebarCollapsedGroups.has(key)) sidebarCollapsedGroups.delete(key);
  else {
    if (sidebarCollapsedGroups.size >= 1000) { toastMessage('toast.foldLimit'); return; }
    sidebarCollapsedGroups.add(key);
  }
  renderSessions(); attempt(persistView);
}
function renderSessions() {
  renderVersions(); renderSidebarGroups();
  // An open session menu keeps its facts current in place; it closes only when its actions or order change.
  if (sessionMenu?.kind === 'session') {
    const current = state.sessions.find(record => record.id === sessionMenu.id), model = current && sessionMenuModel(current.id, sessionMenu.row);
    if (!model || model.actionsKey !== sessionMenu.actionsKey) sessionMenu.close();
    else if (sessionMenu.factsKey !== sidebarFactsKey(current)) { sessionMenu.factsKey = sidebarFactsKey(current); sessionMenu.close.update(model.items); }
  }
  const visible = sidebarSessions();
  const grouped = sidebarView === 'grouped', occurrences = [], containers = new Map();
  const list = $('session-list');
  $('sessions-flat').setAttribute('aria-pressed', String(!grouped)); $('sessions-grouped').setAttribute('aria-pressed', String(grouped));
  if (grouped) {
    const groups = allSpaces().filter(r => !r.archived).map(r => ({ id: r.id, name: r.name, people: orderedMembers(r.id).filter(s => visible.includes(s)) }));
    // Every listed session appears at least once: a session left only in an archived or unknown space counts as independent.
    const independent = visible.filter(s => !groups.some(group => inSpace(s, group.id)));
    if (independent.length) groups.push({ id: '', name: null, people: independent });
    groups.forEach((group, index) => {
      let entry = sidebarGroups.get(group.id);
      if (!entry) {
        const element = node('section', undefined, 'session-space-group'), heading = node('h3'), body = node('div');
        const title = group.id ? button('', () => selectSpace(group.id)) : node('span');
        const toggle = button('▾', () => toggleSidebarGroup(group.id), 'session-space-toggle'), attention = node('span', undefined, 'session-space-attention');
        body.id = `session-space-members-${crypto.randomUUID()}`; attention.id = `${body.id}-attention`;
        toggle.setAttribute('aria-controls', body.id); heading.append(toggle, title, attention); element.append(heading, body); element.dataset.sessionGroup = group.id || 'independent';
        let more = null;
        if (group.id) {
          more = button('⋯', () => openRoomMenu(undefined, more, group.id), 'session-more space-group-more'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
          // As on the 协作空间 row: right-click or Shift+F10 on the space's name opens the same menu.
          title.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); if (!more.disabled) openRoomMenu({ x: event.clientX, y: event.clientY }, more, group.id); });
          title.addEventListener('keydown', event => { if ((event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') && !more.disabled) { event.preventDefault(); event.stopPropagation(); openRoomMenu(undefined, more, group.id); } });
          heading.append(more); bindSpaceHighlight(element, group.id); dropTarget(element, true, group.id);
        }
        entry = { element, title, body, toggle, attention, more }; sidebarGroups.set(group.id, entry);
      }
      // Group spaces are never archived (archived ones get no group), as on the 协作空间 row's ⋯.
      if (entry.more) {
        ui.display.attribute(entry.more, 'aria-label', 'sidebar.spaceActions', { name: group.name }); ui.display.attribute(entry.more, 'title', 'sidebar.spaceActions', { name: group.name });
        entry.more.disabled = disconnected || renameTarget?.id === 'room' && renameTarget.roomId === group.id;
      }
      ui.display.text(entry.title, 'sidebar.groupCount', () => ({ name: group.name ?? uiText('sidebar.independent'), count: group.people.length })); entry.title.className = group.id ? `session-space-heading ${roomTone(group.id)}` : 'session-space-heading';
      // The open space is marked on its heading, as on its 协作空间 row (hidden in this view).
      const open = Boolean(group.id) && selected === 'room' && spaceId === group.id;
      entry.title.classList.toggle('active', open); if (open) entry.title.setAttribute('aria-current', 'page'); else entry.title.removeAttribute('aria-current');
      if (group.id) ui.display.attribute(entry.title, 'aria-label', 'sidebar.openSpace', { name: group.name });
      // A folded group hides only its own rows; its name, count and any rows needing attention stay visible.
      const closed = sidebarCollapsedGroups.has(group.id || 'independent');
      // The narrow rail still lists a folded group's rows (T-132), so an open menu or focus there stays put.
      const rowsHidden = closed && list.closest('.naw')?.dataset.collapsed !== 'true';
      const menuRow = sessionMenu?.kind === 'session' && sessionRows.get(sessionMenu.rowKey);
      const closeMenu = rowsHidden && sessionMenu?.kind === 'session' && entry.body.contains(menuRow?.element || sessionMenu.anchor);
      const hiddenFocus = rowsHidden && (entry.body.contains(document.activeElement) || closeMenu);
      entry.body.hidden = closed; entry.toggle.textContent = closed ? '▸' : '▾'; entry.toggle.setAttribute('aria-expanded', String(!closed));
      const groupLabel = () => ({ name: group.name ?? uiText('sidebar.independent') });
      ui.display.attribute(entry.toggle, 'aria-label', closed ? 'sidebar.expand' : 'sidebar.collapse', groupLabel); ui.display.attribute(entry.toggle, 'title', closed ? 'sidebar.expand' : 'sidebar.collapse', groupLabel);
      const attention = group.people.map(record => ({ record, presentation: sidebarPresentation(record) })).filter(item => item.presentation.marker === '!');
      entry.attention.hidden = !closed || !attention.length; entry.attention.textContent = attention.length ? `!${attention.length}` : '';
      const attentionText = () => uiText('sidebar.attentionFacts', { count: attention.length, facts: attention.map(item => `${item.record.name} · ${sidebarPresentation(item.record).full}`).join('; ') });
      ui.display.computed(entry.attention, 'aria-label', attentionText); ui.display.computed(entry.attention, 'title', attentionText);
      if (entry.attention.hidden) entry.toggle.removeAttribute('aria-describedby'); else entry.toggle.setAttribute('aria-describedby', entry.attention.id);
      if (closeMenu) sessionMenu.close();
      if (hiddenFocus) entry.toggle.focus({ preventScroll: true });
      const slot = list.children[index]; if (slot !== entry.element) list.insertBefore(entry.element, slot || null);
      containers.set(group.id, entry.body);
      for (const record of group.people) occurrences.push({ record, key: `group:${group.id || 'independent'}:${record.id}`, group: group.id, container: entry.body });
    });
    for (const [id, group] of sidebarGroups) if (!containers.has(id)) group.element.remove();
  } else {
    for (const group of sidebarGroups.values()) group.element.remove();
    for (const record of visible) occurrences.push({ record, key: record.id, group: null, container: list });
  }
  const keys = new Set(occurrences.map(row => row.key));
  if (sessionMenu && !sessionMenu.anchor && sessionMenu.rowKey && !keys.has(sessionMenu.rowKey)) sessionMenu.close();
  for (const [key, row] of sessionRows) if (!keys.has(key) && renameTarget?.row !== row.element) { row.element.remove(); sessionRows.delete(key); }
  const positions = new Map();
  for (const { record, key, group, container } of occurrences) {
    let row = sessionRows.get(key);
    if (!row) {
      const element = node('div', undefined, 'session-row'); element.dataset.sessionRow = record.id; element.dataset.occurrence = key;
      const link = button('', () => select(record.id), 'session-link'); link.dataset.sessionId = record.id;
      draggableSession(link, record.id, true, group || ''); sidebarDropRow(element, record.id, group);
      const label = node('span', undefined, 'label'), name = node('span', undefined, 'session-title'), shortId = node('span', undefined, 'session-short-id'), status = node('small'), badges = node('span', undefined, 'session-space-badges'), dot = node('span'), version = node('span', undefined, 'session-backend-version');
      const metadata = node('span', undefined, 'session-metadata'), time = node('time', undefined, 'session-time'), marker = node('span', undefined, 'sidebar-state-marker');
      version.setAttribute('aria-hidden', 'true'); dot.setAttribute('aria-hidden', 'true'); marker.setAttribute('aria-hidden', 'true');
      metadata.append(badges, status, time); label.append(name, version, shortId, metadata);
      // T-142: the status mark sits on the avatar's top-right corner, where a glance finds it.
      const avatar = icon(record.provider); avatar.append(dot); link.append(avatar, label, marker);
      const more = button('⋯', () => openSessionMenu(record.id, undefined, key), 'session-more'); more.dataset.sessionMenu = record.id;
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('pointerdown', event => { if (sessionMenu?.rowKey === key) event.stopPropagation(); });
      element.addEventListener('contextmenu', event => { if (event.target.closest('#rename-editor')) return; event.preventDefault(); openSessionMenu(record.id, { x: event.clientX, y: event.clientY }, key); });
      element.addEventListener('keydown', event => { if (event.target.closest('#rename-editor')) return; if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openSessionMenu(record.id, undefined, key); } });
      element.append(link, more); row = { element, link, more, name, shortId, badges, status, dot, marker, time, version, sessionId: record.id, spaceId: group }; sessionRows.set(key, row);
    }
    const memberships = allSpaces().filter(r => !r.archived && inSpace(record, r.id)), membershipNames = memberships.map(r => r.name).join('、');
    const presentation = sidebarPresentation(record);
    const label = () => `${record.name} · ${record.provider === 'claude' ? 'Claude' : 'Codex'} · ${sessionShortId(record.id)} · ${sidebarPresentation(record).full}`;
    const association = () => memberships.length ? uiText('sidebar.memberships', { names: membershipNames }) : uiText('sidebar.independent');
    const occurrence = () => grouped && memberships.length > 1 ? uiText('sidebar.sameIdentity') : '';
    const version = () => backendVersionNotice(record, state.appVersion);
    row.link.disabled = false; ui.display.computed(row.link, 'aria-label', () => `${label()} · ${association()}${occurrence()} · ${sessionTimes(record)}${version() ? ' · ' + version().title : ''}`); ui.display.computed(row.link, 'title', () => `${label()}\n${association()}${occurrence()}\n${sessionTimes(record)}${version() ? '\n' + version().title : ''}`);
    const badgeKey = JSON.stringify(memberships.map(r => [r.id, r.name]));
    row.badges.hidden = Boolean(grouped && group);
    if (row.badgeKey !== badgeKey) {
      // One badge plus a count keeps membership on its line; the badge shows the space's whole name and CSS
      // shortens it only by the width it has (T-144). The full list is in the title and details.
      row.badges.replaceChildren(...memberships.slice(0, 1).map(r => { const badge = node('span', r.name, `space-badge ${roomTone(r.id)}`); ui.display.attribute(badge, 'title', 'sidebar.spaceBadge', { name: r.name }); return badge; }));
      if (memberships.length > 1) { const more = node('span', `+${memberships.length - 1}`, 'space-badge space-badge-more'); more.title = membershipNames; row.badges.append(more); }
      row.badgeKey = badgeKey;
    }
    ui.display.computed(row.badges, 'aria-label', association);
    // Compact version marks keep the three cases apart: older alpha, different, unreported.
    const notice = version(), versionMark = notice ? { old: '↑', different: '≠', unknown: '?' }[notice.kind] : '';
    row.version.textContent = versionMark; row.version.dataset.marker = versionMark; ui.display.computed(row.version, 'title', () => version()?.title || ''); row.version.hidden = !notice;
    row.link.classList.toggle('active', record.id === selected); row.element.classList.toggle('active', record.id === selected);
    if (record.id === selected) row.link.setAttribute('aria-current', 'page'); else row.link.removeAttribute('aria-current');
    const moreParams = { name: record.name, id: sessionShortId(record.id), space: group ? ` · ${spaceRecord(group)?.name}` : '' }; ui.display.attribute(row.more, 'aria-label', 'sidebar.sessionActions', moreParams); ui.display.attribute(row.more, 'title', 'sidebar.sessionActions', moreParams); row.more.disabled = renameTarget?.id === record.id;
    row.more.setAttribute('aria-description', sidebarDetails(record).join(' · '));
    row.name.textContent = record.name; row.shortId.textContent = sessionShortId(record.id); ui.display.computed(row.status, 'text', () => sidebarPresentation(record).compact);
    row.time.textContent = sessionActivityTime(record); row.time.title = sessionTimes(record);
    row.dot.className = `state-dot ${presentation.tone}${presentation.workTone ? ' ' + presentation.workTone : ''}`; ui.display.computed(row.dot, 'title', () => sidebarPresentation(record).full); row.dot.dataset.nativeState = record.state;
    row.marker.textContent = presentation.marker; ui.display.computed(row.marker, 'title', () => sidebarPresentation(record).full); row.element.classList.toggle('has-status-detail', presentation.detail);
    const index = positions.get(container) || 0, slot = container.children[index]; if (slot !== row.element) container.insertBefore(row.element, slot || null); positions.set(container, index + 1);
  }
  highlightSpace(hoverSpace);
}

function createReadiness() {
  if (!$('create-dialog').open) return;
  renderCreateSpaces();
  const historyProvider = document.querySelector('input[name="provider"]:checked').value;
  $('open-native-history').hidden = !state.capabilities?.includes(historyProvider === 'codex' ? 'nativeHistory' : 'claudeFork');
  $('claude-history-id-option').hidden = historyProvider !== 'claude' || !state.capabilities?.includes('claudeHistory');
  if ($('claude-history-id-option').hidden) $('claude-history-id').value = '';
  const takeover = historyProvider === 'claude' && $('claude-history-id').value.trim();
  const gitSelected = $('git-worktree').checked, gitSupported = state.capabilities?.includes('gitWorktreeV1');
  $('git-worktree-option').hidden = !gitSupported && !gitSelected;
  $('git-worktree').disabled = creatingSession || newDirectory || Boolean(takeover) || (!gitSupported && !gitSelected);
  $('git-worktree-details').hidden = !gitSelected;
  // T-96: the option is off while the folder is a new empty one; say why and what to do (the person: 「貌似没法点新建 Git」).
  // Not during a takeover (which needs the original folder) or once T-115's session exists, being joined or already
  // kept (the form is locked either way); the help is emptied while hidden, so the checkbox's description is never stale.
  const createTicket = dialogTickets.get($('create-dialog'));
  const gitHelp = !$('git-worktree-option').hidden && !gitSelected && newDirectory && !takeover && !createTicket?.creation && !createTicket?.created;
  $('git-worktree-source-help').hidden = !gitHelp;
  if (gitHelp) ui.display.text($('git-worktree-source-help'), 'create.gitSourceHelp');
  else { ui.display.unbind($('git-worktree-source-help')); $('git-worktree-source-help').textContent = ''; }
  $('git-worktree-relative').disabled = creatingSession;
  if (gitSelected && !gitSupported) {
    invalidateGitPreview();
    $('chosen-folder').textContent = folder;
    ui.display.text($('git-worktree-preview'), 'create.gitUnsupported');
  }
  ui.display.text($('open-native-history'), historyProvider === 'codex' ? 'create.codexHistory' : takeover ? 'create.claudeTakeover' : 'create.claudeFork');
  $('open-native-history').disabled = creatingSession || gitSelected || (historyProvider === 'claude' && newDirectory);
  if (historyProvider === 'claude' && newDirectory) ui.display.text($('open-native-history'), 'create.chooseOriginal');
  $('new-folder').hidden = !state.capabilities?.includes('newSessionDirectory');
  $('new-folder').disabled = $('choose-folder').disabled = creatingSession;
  $('cancel-create').disabled = false;
  // Only Codex starts differently: either this app or its TUI creates the native thread.
  // A Claude session opens in the last-used tab; both views stay available.
  $('initial-view').hidden = $('initial-view-label').hidden = historyProvider !== 'codex';
  // Only a service that applies the choice may offer it; an older one would silently ignore it.
  $('skip-permissions-option').hidden = !state.capabilities?.includes('createSkipPermissions');
  if ($('skip-permissions-option').hidden) $('skip-permissions').checked = false;
  const directoryKey = gitSelected ? 'create.directoryCopy' : newDirectory ? 'create.directoryNew' : 'create.directoryExisting';
  const permissionKey = $('skip-permissions').checked ? 'create.permissionsSkipped' : 'create.permissionsNative';
  ui.display.computed($('create-permission-note'), 'text', () => uiText('create.permissionNote', { directory: uiText(directoryKey), permission: uiText(permissionKey) }));
  createSpaceReadiness();
  if (!state.capabilities?.includes('nativePermissionDefaults')) {
    $('confirm-create').disabled = true;
    ui.display.text($('create-readiness'), 'create.backendMissing');
    return;
  }
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const ready = state.preflight?.python && state.preflight?.[provider];
  $('confirm-create').disabled = creatingSession || !ready || Boolean(takeover && (newDirectory || gitSelected)) || (gitSelected && (newDirectory || !gitSupported || gitPreviewLoading || !gitWorktreePlan));
  const readinessKey = takeover && (newDirectory || gitSelected) ? 'create.takeoverDirectory' : ready ? null : 'create.missingPrograms';
  ui.display.computed($('create-readiness'), 'text', () => readinessKey ? uiText(readinessKey) : '');
  createSpaceReadiness(true);
}
// T-115: a space choice locks nothing until the session exists; then everything but 仅继续加入 and 关闭 is locked.
function createSpaceReadiness(final = false) {
  const ticket = dialogTickets.get($('create-dialog')), creation = ticket?.creation, spaced = $('create-space-kind').value !== 'independent';
  const takeover = document.querySelector('input[name="provider"]:checked').value === 'claude' && $('claude-history-id').value.trim();
  const stopped = Boolean(creation || ticket?.created); // a session from this opening exists, or may (I159)
  for (const input of $('create-dialog').querySelectorAll('input[name="provider"], #session-name, #claude-history-id, #skip-permissions, #initial-view')) input.disabled = stopped;
  ui.display.text($('cancel-create'), stopped ? 'create.closeKeep' : 'common.cancel');
  // Continuing an existing session doesn't take the space choice yet; say so rather than drop it.
  $('create-space-help').hidden = !spaced;
  if (spaced) ui.display.text($('create-space-help'), 'create.spaceHelpForExisting');
  else { ui.display.unbind($('create-space-help')); $('create-space-help').textContent = ''; }
  if (spaced || stopped) $('open-native-history').disabled = true; // continuing or branching would add another session
  if (stopped) for (const id of ['choose-folder', 'new-folder', 'git-worktree', 'git-worktree-relative']) $(id).disabled = true;
  if (creation) {
    ui.display.text($('confirm-create'), 'create.joinOnly'); $('confirm-create').disabled = creatingSession || Boolean(creation.blocked);
    if (final) { ui.display.unbind($('create-readiness'), 'text'); $('create-readiness').textContent = ''; }
    return;
  }
  ui.display.text($('confirm-create'), spaced ? 'create.spaceConfirm' : 'create.confirm');
  if (!final) return;
  if (ticket?.created) { $('confirm-create').disabled = true; ui.display.text($('create-readiness'), ticket.created === 'unconfirmed' ? 'create.startedUnconfirmed' : 'create.startedRetained'); return; }
  let problem = spaced && takeover ? uiError('error.takeoverSpaceChoice') : null;
  if (!problem) try { createSpaceChoice(); } catch (error) { problem = error; }
  if (problem) { $('confirm-create').disabled = true; if (!$('create-readiness').textContent) ui.showError($('create-readiness'), problem); }
}
function renderArchives() {
  const records = state.sessions.filter(s => s.archived), archivedRooms = allSpaces().filter(r => r.archived), count = records.length + archivedRooms.length;
  const running = records.filter(s => ['working', 'approval', 'starting', 'stopping', 'disconnected'].includes(s.state)).length;
  ui.display.text($('archive-label'), 'archive.label', () => ({ count: count ? ` · ${count}` : '', running: running ? uiText('archive.pending', { count: running }) : '' }));
  ui.display.attribute($('archive-button'), 'title', 'archive.title', () => ({ count, running: running ? uiText('archive.runningHelp', { count: running }) : '' }));
  if ($('archive-group-body').hidden) return;
  const list = $('archive-list');
  const origin = document.activeElement, oldRow = origin?.closest('.archive-item'), oldIndex = oldRow ? [...list.children].indexOf(oldRow) : -1;
  const signature = JSON.stringify([archivedRooms.map(r => [r.id, r.name]), records.map(s => [s.id, s.name, s.state, sessionTimes(s)]), state.sessions.map(s => [s.id, s.name])]);
  if (list.dataset.signature === signature) return; list.dataset.signature = signature; list.replaceChildren();
  for (const room of archivedRooms) {
    const row = node('div', undefined, 'archive-item'); row.dataset.archivedRoom = room.id; row.append(node('strong', room.name), uiNode('small', 'archive.roomInfo'), uiButton('archive.restoreRoom', () => restoreArchivedRoom(room.id))); list.append(row);
  }
  for (const s of records) {
    const row = node('div', undefined, 'archive-item'); row.dataset.archivedSession = s.id;
    const info = node('small'); ui.display.computed(info, 'text', () => `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${stateText(s)}${uiText(['ended', 'recoverable'].includes(s.state) ? 'archive.continueHistory' : 'archive.processRetained')} · ${sessionTimes(s)}`);
    row.append(node('strong', participantLabel(s, state.sessions)), info, uiButton('archive.restoreSession', () => restoreArchivedSession(s.id))); list.append(row);
  }
  if (!count) list.append(uiNode('p', 'archive.empty'));
  if (oldRow) {
    const rows = [...list.children], same = rows.find(row => oldRow.dataset.archivedSession ? row.dataset.archivedSession === oldRow.dataset.archivedSession : row.dataset.archivedRoom === oldRow.dataset.archivedRoom);
    focusAfterRemoval(origin, [same?.querySelector('button'), rows[oldIndex]?.querySelector('button'), rows[oldIndex - 1]?.querySelector('button'), $('archive-button')]);
  }
}
async function restoreArchivedSession(id) {
  const origin = document.activeElement, surface = JSON.stringify([selected, roomSession, roomSurface, mode]);
  await api.restoreSession(id); updateState(await api.initial()); render();
  if (surface === JSON.stringify([selected, roomSession, roomSurface, mode])) focusAfterRemoval(origin, [$('session-header-more'), $('archive-button')]);
  sessionNoticeMessage("toast.sessionRestored", undefined, id);
}
async function restoreArchivedRoom(id = spaceId) {
  await api.spaceAction(id, 'restore', []); updateState(await api.initial()); render();
  toastMessage("toast.workspaceRestored", undefined, { label: uiText('common.open'), labelKey: 'common.open', nameKey: 'action.openSession', params: () => ({ name: spaceRecord(id)?.name || uiText('sidebar.space') }), run: () => selectSpace(id) });
}

// Language controls use the existing Host mirror; no native/session operations.
let changingLanguage = false, languageFailed = false, languageWarning = null, notifiedLanguageWarning;
function reportLanguageWarning() {
  if (!state || !languageWarning || languageWarning === notifiedLanguageWarning) return;
  notifiedLanguageWarning = languageWarning;
  toast(uiText(languageWarning === 'migrationNotSaved' ? 'locale.migrationNotSaved' : 'locale.unavailable'));
}
let setupTicket, setupLoading = false, setupFailure = null, setupRows = [];
function renderInterfaceLanguage() {
  const control = $('ui-language');
  control.value = ui.language.getSnapshot().active;
  control.setAttribute('aria-busy', String(changingLanguage));
  control.setAttribute('aria-disabled', String(changingLanguage));
  $('ui-language-label').textContent = uiText('locale.language');
  for (const option of control.options) option.textContent = uiText(option.value === 'zh' ? 'locale.chinese' : 'locale.english');
  const warningKey = languageFailed ? 'locale.notSaved' : languageWarning === 'migrationNotSaved' ? 'locale.migrationNotSaved' : languageWarning === 'unavailable' ? 'locale.unavailable' : null;
  const status = $('ui-language-status');
  status.textContent = warningKey ? uiText(warningKey) : ''; status.hidden = !warningKey;
  $('setup-title').textContent = uiText('common.settings');
  $('setup-intro').textContent = uiText('setup.intro');
  $('refresh-setup').textContent = uiText('setup.recheck'); $('close-setup').textContent = uiText('common.done');
  const entry = $('setup-button');
  entry.querySelector('.rail-label').textContent = uiText('common.settings');
  entry.setAttribute('aria-label', uiText('common.settings')); entry.title = uiText('common.settings');
}
async function changeInterfaceLanguage(value) {
  if (changingLanguage) { renderInterfaceLanguage(); return; }
  changingLanguage = true; languageFailed = false; renderInterfaceLanguage();
  try { await ui.language.set(value); languageWarning = null; }
  catch { languageFailed = true; }
  finally { changingLanguage = false; renderInterfaceLanguage(); }
}
function renderSetupPrograms(localeOnly = false) {
  if (!setupTicket || !currentDialogTicket(setupTicket)) return;
  if (setupLoading) { $('setup-status').replaceChildren(node('p', uiText('setup.checking'))); return; }
  if (setupFailure) { $('setup-status').replaceChildren(node('p', uiText('setup.failed', { error: typeof setupFailure === 'string' ? setupFailure : setupFailure.message ? ui.displayText(String(setupFailure.message), setupFailure.uiMessage) : uiText('common.retry') }))); return; }
  const ticket = setupTicket;
  const versionText = () => { $('version-info').textContent = uiText('setup.version', { app: state.appVersion || uiText('setup.development'), backend: state.runtimeVersion || uiText('setup.oldBackend') }); };
  if (localeOnly) {
    for (const row of setupRows) { row.heading.textContent = uiText('setup.program', { program: row.label, status: uiText(row.found ? 'setup.found' : 'setup.missing') }); for (const [control, key] of row.actions) control.textContent = uiText(key); }
    versionText(); return;
  }
  setupRows = [];
  const entries = [['claude', 'Claude Code', 'https://code.claude.com/docs/en/setup'], ['codex', 'Codex CLI', 'https://developers.openai.com/codex/cli/'], ['python', 'Python 3', 'https://www.python.org/downloads/macos/']];
  $('setup-status').replaceChildren(...entries.map(([key, label, url]) => {
    const setting = key === 'python' ? 'python3' : key;
    const row = node('div', undefined, 'setup-program');
    const heading = node('strong', uiText('setup.program', { program: label, status: uiText(state.preflight[key] ? 'setup.found' : 'setup.missing') }));
    row.append(heading);
    const display = { heading, label, found: Boolean(state.preflight[key]), actions: [] }; setupRows.push(display);
    const location = state.preflight.paths?.[key] || state.preflight.configured?.[setting];
    if (location) row.append(node('p', location, 'program-path'));
    const actions = node('div', undefined, 'actions');
    const install = button(uiText('setup.install'), () => api.openExternal(url));
    const choose = button(uiText('setup.choose'), async () => { await api.runtimeLocation(setting); if (currentDialogTicket(ticket)) await showSetup(); });
    actions.append(install, choose); display.actions.push([install, 'setup.install'], [choose, 'setup.choose']);
    if (state.preflight.configured?.[setting]) { const automatic = button(uiText('setup.automatic'), async () => { await api.runtimeLocation(setting, true); if (currentDialogTicket(ticket)) await showSetup(); }); actions.append(automatic); display.actions.push([automatic, 'setup.automatic']); }
    row.append(actions); return row;
  }));
  if (state.preflight.error) { const error = node('p'); ui.display.computed(error, 'text', () => ui.displayText(state.preflight.error, state.preflight.errorUiMessage)); $('setup-status').append(error); }
  versionText();
}
async function showSetup() {
  const ticket = setupTicket = openTransientDialog('setup-dialog');
  setupLoading = true; setupFailure = null;
  renderInterfaceLanguage(); renderSetupPrograms();
  try {
    const preflight = await api.preflight(); if (!currentDialogTicket(ticket)) return;
    state.preflight = preflight; setupLoading = false; renderSetupPrograms(); createReadiness();
  } catch (error) {
    if (currentDialogTicket(ticket)) { setupLoading = false; setupFailure = { message: error.message || '', uiMessage: error.uiMessage || null }; renderSetupPrograms(); }
  }
}
// End language/settings display controls.

function populateSelect(el, items) {
  const old = el.value;
  const hadChoices = el.dataset.hadChoices === 'true';
  const signature = JSON.stringify(items.map(s => [s.id, s.name]));
  if (el.dataset.signature === signature) return;
  if (!el.dataset.signature) el.addEventListener('change', () => { el.title = el.selectedOptions[0]?.textContent || ''; });
  el.replaceChildren(...items.map(s => { const option = node('option', participantLabel(s, items)); option.value = s.id; return option; }));
  el.dataset.signature = signature;
  if (items.length) el.dataset.hadChoices = 'true';
  if (items.some(s => s.id === old)) el.value = old;
  else if (hadChoices) {
    // Losing a recipient must not silently redirect a private draft.
    const placeholder = uiNode('option', 'room.pickRecipient'); placeholder.value = ''; placeholder.disabled = true;
    el.prepend(placeholder); el.value = '';
  }
  el.title = el.selectedOptions[0]?.textContent || '';
}
function participantLabel(session, people = members()) {
  return people.filter(s => s.name === session.name).length > 1 ? `${session.name} · ${session.provider === 'claude' ? 'Claude' : 'Codex'} · ${sessionShortId(session.id)}` : session.name;
}
function historicalParticipantLabel(name, id) {
  return `${name || uiText('identity.historicalMember')}${typeof id === 'string' && id ? ` · ${id.slice(0, 6)}` : uiText('identity.unrecorded')}`;
}
function roomMessageLabel(m) {
  const displayName = ui.displayText(m.name, m.uiNameMessage);
  if (m.snapshotBatch) {
    const id = m.role === 'human' ? m.recipientId : m.sessionId, label = displayName || (m.role === 'human' ? uiText('reading.you') : historicalParticipantLabel('', m.sessionId));
    const actors = new Set((state.room?.messages || []).filter(row => row.snapshotBatch && row.role === m.role && row.name === m.name)
      .map(row => row.role === 'human' ? row.recipientId : row.sessionId).filter(Boolean));
    return id && actors.size > 1 ? `${label} · ${id.slice(0, 8)}` : label;
  }
  // Run notices describe coordination; streamed native system rows still belong
  // to their exact agent. Reuse the same identity in reading and copied records.
  if (m.role === 'system' && m.runId && !m.sharedStream) return displayName || uiText('identity.collaboration');
  if (m.role === 'system' && m.wake) {
    // An agent wake row: current names by ID, the stored names only when a session is gone (T-137).
    const name = (id, stored) => { const s = state.sessions.find(x => x.id === id); return s ? participantLabel(s, state.sessions) : historicalParticipantLabel(stored || uiText('identity.historicalSession'), id); };
    return `${name(m.wake.senderId, m.wake.senderName)} → ${name(m.wake.recipientId, m.wake.recipientName)}`;
  }
  if (m.role === 'system' && m.peerMessage) {
    // A cross-session message: the recipient by its current name; the sender is never verified (T-137).
    const p = m.peerMessage, s = p.senderId && state.sessions.find(x => x.id === p.senderId), r = state.sessions.find(x => x.id === p.recipientId);
    // A name the sender only claimed stays inside 「」, so nothing in it can pass for NAW's own marker.
    const sender = s ? participantLabel(s, state.sessions) : p.senderId ? historicalParticipantLabel(p.senderName || uiText('identity.historicalSession'), p.senderId) : p.senderName ? `「${p.senderName}」` : uiText('identity.unknownSession');
    return uiText('identity.unverifiedSender', { name: sender, recipient: r ? participantLabel(r, state.sessions) : historicalParticipantLabel(p.recipientName || uiText('identity.historicalSession'), p.recipientId) });
  }
  const person = state.sessions.find(s => s.id === (m.role === 'human' ? m.recipientId : m.sessionId));
  if (person) return (m.role === 'human' ? uiText('identity.youTo') : '') + participantLabel(person, state.sessions);
  const id = m.role === 'human' ? m.recipientId : m.sessionId;
  if (id) return (m.role === 'human' ? uiText('identity.youTo') : '') + historicalParticipantLabel(m.role === 'human' ? m.deliveries?.find(d => d.recipientId === id)?.recipientName || uiText('identity.historicalRecipient') : m.name, id);
  return displayName || uiText(m.role === 'human' ? 'reading.you' : 'identity.workspace');
}
function timeline() {
  const imported = state.room.messages.filter(message => message.snapshotBatch);
  const current = [...state.room.messages.filter(message => !message.snapshotBatch), ...(state.room.events || [])].sort((a, b) => (a.time || 0) - (b.time || 0));
  return [...imported, ...current].map(message => message.snapshotReplyTo ? { ...message, replyTo: message.snapshotReplyTo } : message);
}
function renderSnapshotMaterials() {
  const element = $('space-snapshot-materials'), merge = state.room.merge;
  element.hidden = !merge || roomSurface !== 'records';
  const signature = JSON.stringify(merge || null); if (element.dataset.signature === signature) return;
  element.dataset.signature = signature; element.replaceChildren();
  if (!merge) return;
  const row = node('div', undefined, 'snapshot-origin');
  row.append(uiNode('span', merge.stage === 'undone' ? 'snapshot.undone' : ['ready', 'archiving'].includes(merge.stage) ? 'snapshot.independent' : 'snapshot.pending'), uiButton('snapshot.details', () => openMergeRecord(state.room.id), 'small'));
  element.append(row);
  for (const source of merge.sources) {
    const note = merge.notes.find(note => note.roomId === source.id), events = merge.events.find(value => value.roomId === source.id)?.events || [];
    if (!note && !events.length) continue;
    const details = node('details'); details.append(uiNode('summary', 'snapshot.sourceRecords', { name: source.name }));
    if (note) details.append(node('pre', note.text));
    for (const event of events) { const text = node('p'); ui.display.computed(text, 'text', () => ui.displayText(event.text, event.uiMessage)); details.append(text); }
    element.append(details);
  }
}
function filteredTimeline() {
  const id = $('room-filter').value, query = $('room-search').value.trim().toLocaleLowerCase();
  return timeline().filter(m => (!roomThread || roomThreads.roots.get(m.id) === roomThread) && (!id || m.sessionId === id || m.recipientId === id || m.deliveries?.some(d => d.recipientId === id) || m.wake?.senderId === id || m.wake?.recipientId === id || m.peerMessage?.recipientId === id || (m.peerMessage?.senderId && m.peerMessage.senderId === id)) && (!query || m.text.toLocaleLowerCase().includes(query)));
}
function openThread(id) {
  const root = roomThreads.roots.get(id);
  if (!root) return toastMessage("toast.threadRemoved");
  captureReadingViews(); roomThread = root; roomReplyTo = root;
  // Reply chooses an association, never a new recipient or extra model context.
  roomDraftRevision++; $('room-search').value = ''; $('room-filter').value = ''; pendingRoomFilter = '';
  render(); attempt(persistView); $('shared-input').focus();
}
function renderTimeline() {
  renderSnapshotMaterials();
  roomThreads = window.nativeWorkspaceThreads.threadIndex(timeline());
  $('thread-heading').hidden = !roomThread;
  const root = roomThreads.rows.get(roomThread);
  ui.display.computed($('thread-title'), 'text', () => roomThread ? root ? uiText('room.threadTitle', { text: root.text.slice(0, 80) }) : uiText('room.threadMissingTitle') : '');
  $('reply-context').hidden = !roomReplyTo;
  const reply = roomThreads.rows.get(roomReplyTo);
  ui.display.computed($('reply-label'), 'text', () => roomReplyTo ? reply ? uiText('room.replyTitle', { text: reply.text.slice(0, 80) }) : uiText('room.replyMissing') : '');
  const candidates = new Map();
  for (const s of members()) candidates.set(s.id, s.name);
  for (const m of timeline()) {
    const id = m.sessionId || m.recipientId;
    if (id && !candidates.has(id)) candidates.set(id, state.sessions.find(s => s.id === id)?.name || m.name || null);
    for (const d of m.deliveries || []) if (!candidates.has(d.recipientId)) candidates.set(d.recipientId, state.sessions.find(s => s.id === d.recipientId)?.name || d.recipientName || null);
  }
  const filter = $('room-filter'), chosen = filter.value || pendingRoomFilter; pendingRoomFilter = '';
  const filterSignature = JSON.stringify([...candidates]);
  if (filter.dataset.signature !== filterSignature) {
    filter.replaceChildren(uiNode('option', 'room.allMembers'));
    filter.firstChild.value = '';
    for (const [id, name] of candidates) { const option = node('option'); ui.display.computed(option, 'text', () => `${name || uiText('identity.historicalMember')}${members().some(s => s.id === id) ? '' : uiText('room.detachedSuffix')} · ${id.slice(0, 6)}`); option.value = id; filter.append(option); }
    filter.value = candidates.has(chosen) ? chosen : ''; filter.dataset.signature = filterSignature;
  }
  const messages = filteredTimeline();
  const signature = JSON.stringify([messages, state.sessions.map(s => [s.id, s.name]), filter.value, $('room-search').value, roomThread, [...roomThreads.groups].map(([id, rows]) => [id, rows.length])]);
  if (signature !== lastRoomMessages) { messageList($('room-messages'), messages, true, roomReadingKey()); lastRoomMessages = signature; }
  ui.display.text($('timeline-count'), 'room.recordCount', { count: messages.length }); $('copy-timeline').disabled = !messages.length;
}
async function moveRoomMember(id, target, after, destination = spaceId) {
  await api.spaceAction(destination, 'memberOrder', [{ id, target, after }]);
  const people = orderedMembers(destination), index = people.findIndex(s => s.id === id);
  if (index < 0) throw uiError("error.memberOrderChanged");
  return { name: participantLabel(people[index]), index: index + 1, count: people.length };
}
function draggableSession(element, id, reorder = false, sourceSpace = selected === 'room' ? spaceId : '') {
  element.draggable = true;
  element.addEventListener('dragstart', event => {
    event.dataTransfer.setData('application/x-native-session', id); event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('application/x-native-source-space', sourceSpace);
    if (reorder) event.dataTransfer.setData('application/x-native-session-order', id);
    document.querySelector('.sidebar').classList.add('dragging-session');
  });
  element.addEventListener('dragend', () => { document.querySelector('.sidebar').classList.remove('dragging-session'); document.querySelectorAll('.drag-over, .drop-before, .drop-after').forEach(el => el.classList.remove('drag-over', 'drop-before', 'drop-after')); });
}
function sidebarDropRow(element, target, group = null) {
  const accepts = event => !disconnected && event.dataTransfer.types.includes('application/x-native-session-order');
  const after = event => event.clientY >= element.getBoundingClientRect().top + element.offsetHeight / 2;
  element.addEventListener('dragover', event => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    element.classList.toggle('drop-before', !after(event)); element.classList.toggle('drop-after', after(event));
  });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drop-before', 'drop-after'); });
  element.addEventListener('drop', event => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); element.classList.remove('drop-before', 'drop-after');
    const id = event.dataTransfer.getData('application/x-native-session-order'), source = event.dataTransfer.getData('application/x-native-source-space');
    if (group && source !== group) attempt(() => addToSpace(id, group));
    else attempt(() => group ? moveRoomMember(id, target, after(event), group) : moveSidebarSession(id, target, after(event)));
  });
}
function dropTarget(element, join, destination = 'shared') {
  element.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-native-session')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('drag-over'); } });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over'); });
  element.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation(); element.classList.remove('drag-over');
    const id = event.dataTransfer.getData('application/x-native-session');
    if (!join && element.id === 'session-list' && sidebarView === 'grouped') return;
    if (!join && element.id === 'session-list' && event.dataTransfer.types.includes('application/x-native-session-order')) {
      attempt(() => moveSidebarSession(id, sidebarSessions().at(-1)?.id, true)); return;
    }
    const record = state.sessions.find(s => s.id === id); if (!record) return;
    if (join) attempt(() => addToSpace(id, destination));
    else {
      const source = event.dataTransfer.getData('application/x-native-source-space') || (inSpace(record) ? spaceId : window.nativeWorkspaceSpaces.roomIds(record).length === 1 ? window.nativeWorkspaceSpaces.roomIds(record)[0] : '');
      if (!source) return toastMessage("toast.chooseSpaceToLeave");
      attempt(() => detach(id, source));
    }
  });
}
function openNotes(id = spaceId) {
  const room = spaceRecord(id); if (!room) return;
  notesRevision = room.metadataRevision;
  $('room-notes-text').value = room.notes || ''; ui.display.text($('notes-heading'), 'notes.titleName', { name: room.name }); $('notes-error').hidden = true; $('save-notes').disabled = false;
  const ticket = openTransientDialog('notes-dialog'); ticket.roomId = id;
}
let contextSnapshot = null;
function contextEdited() { return Boolean(contextSnapshot && $('context-text').value && $('context-text').value !== contextSnapshot.text); }
function contextProblem(problem) { ui.showError($('context-error'), problem); $('context-error').hidden = false; }
function updateContextControls() {
  const text = $('context-text').value, edited = contextEdited();
  $('context-spaces').disabled = edited;
  if (edited) ui.display.text($('context-scope-note'), 'context.scopeLocked');
  else { ui.display.unbind($('context-scope-note')); $('context-scope-note').textContent = ''; }
  $('context-scope-note').hidden = !edited;
  $('context-text').disabled = !contextSnapshot;
  const unavailable = !contextSnapshot || !text.trim() || text.length > 12000 || !text.isWellFormed();
  $('copy-context').disabled = unavailable; $('insert-context').disabled = unavailable;
}
function generateContextPreview() {
  if (contextEdited()) {
    for (const check of $('context-space-choices').querySelectorAll('input')) check.checked = contextSnapshot.spaceIds.includes(check.dataset.contextSpace);
    updateContextControls(); return;
  }
  const ids = [...$('context-space-choices').querySelectorAll('input:checked')].map(check => check.dataset.contextSpace);
  try {
    contextSnapshot = window.nativeWorkspaceContextSnapshot.build(state, ids, { connected: !disconnected, language: ui.language.getSnapshot().active });
    $('context-text').value = contextSnapshot.text;
    ui.display.unbind($('context-error')); $('context-error').textContent = ''; $('context-error').hidden = true;
  } catch (error) {
    contextSnapshot = null; $('context-text').value = ''; contextProblem(error.message ? error : uiError('error.contextPreviewFailed'));
  }
  updateContextControls();
}
function openContext() {
  if ($('context-dialog').open) { $('context-text').focus(); return; }
  const s = sharedSurface() ? null : current();
  contextTarget = s ? { id: s.id, mode } : { room: true, roomId: spaceId };
  contextSnapshot = null;
  const rooms = allSpaces().filter(room => !room.archived && !room.unavailable);
  $('context-space-choices').replaceChildren(...rooms.map(room => {
    const row = node('div', undefined, 'run-person'), label = node('label'), check = document.createElement('input');
    check.type = 'checkbox'; check.dataset.contextSpace = room.id; check.checked = room.id === spaceId;
    const duplicate = rooms.some(other => other.id !== room.id && other.name === room.name);
    label.append(check, document.createTextNode(room.name + (duplicate ? ' · ' + room.id : '')));
    check.onchange = generateContextPreview; row.append(label); return row;
  }));
  // Solo drafts are owned by the native session's active window. Copying lets
  // the person paste into that window without racing a concurrent takeover.
  $('context-error').hidden = true; $('insert-context').hidden = Boolean(s);
  generateContextPreview();
  openTransientDialog('context-dialog');
}
function appendedDraft(input, text, room) {
  if (room && roomRecipient() && !nativeWorkspaceMentions.body(roomMention, input.value).trim()) return input.value + (/\s$/u.test(input.value) ? '' : ' ') + text;
  return [input.value, text].filter(Boolean).join('\n\n');
}
function mentionRosterKey() { return JSON.stringify([spaceId, members().map(s => [s.id, s.name, s.provider, pairRevision(s)])]); }
function closeMentions() { mentionRoster = ''; mentionOptions = []; mentionRange = null; $('mention-list').hidden = true; $('shared-input').setAttribute('aria-expanded', 'false'); $('shared-input').removeAttribute('aria-activedescendant'); }
function showMentions(force = false) {
  const input = $('shared-input'), before = input.value.slice(0, input.selectionStart);
  if (mentionComposing || input.readOnly || document.activeElement !== input || input.selectionStart !== input.selectionEnd) return closeMentions();
  if (!force && nativeWorkspaceMentions.valid(roomMention, input.value) && input.selectionStart === roomMention.end) return closeMentions();
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!force && !match) return closeMentions();
  mentionRoster = mentionRosterKey();
  mentionRange = match ? { start: before.lastIndexOf('@'), end: input.selectionStart } : null;
  const query = match ? match[1].toLocaleLowerCase() : '';
  mentionOptions = members().filter(s => `${s.name} ${s.provider}`.toLocaleLowerCase().includes(query)); mentionIndex = 0;
  $('mention-list').replaceChildren(...mentionOptions.map((s, i) => {
    const entry = button(`${s.name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${sessionShortId(s.id)}`, () => chooseMention(s.id), 'mention-option');
    entry.id = `mention-${i}`; entry.setAttribute('role', 'option'); entry.dataset.mentionId = s.id;
    entry.addEventListener('mousedown', event => event.preventDefault()); return entry;
  }));
  if (!mentionOptions.length) $('mention-list').append(uiNode('p', 'mention.noMatches'));
  $('mention-list').hidden = false; input.setAttribute('aria-expanded', 'true'); highlightMention();
}
function highlightMention() {
  [...$('mention-list').querySelectorAll('[role="option"]')].forEach((el, i) => el.setAttribute('aria-selected', String(i === mentionIndex)));
  if (mentionOptions.length) $('shared-input').setAttribute('aria-activedescendant', `mention-${mentionIndex}`);
  else $('shared-input').removeAttribute('aria-activedescendant');
}
function roomRecipient() {
  const person = members().find(s => s.id === roomMention?.id);
  return person && roomMention.active === true && roomMention.memberRevision === pairRevision(person) && (roomMention.roomId || 'shared') === spaceId && roomMention.text === '@' + participantLabel(person) && nativeWorkspaceMentions.valid(roomMention, $('shared-input').value) ? roomMention.id : '';
}
function normalizeRoomMention() {
  if (!roomMention) return;
  if (!nativeWorkspaceMentions.valid(roomMention, $('shared-input').value)) roomMention = null;
  else if (!roomRecipient()) roomMention = { ...roomMention, active: false };
}
function chooseMention(id) {
  const person = members().find(s => s.id === id);
  if (!person) { closeMentions(); return toastMessage("toast.recipientLeft"); }
  const input = $('shared-input'), old = nativeWorkspaceMentions.valid(roomMention, input.value) ? roomMention : null;
  let range = mentionRange || (old ? { start: old.start, end: old.end } : { start: input.selectionStart, end: input.selectionEnd });
  let text = input.value;
  if (old && (old.start !== range.start || old.end !== range.end)) {
    text = text.slice(0, old.start) + text.slice(old.end);
    if (old.end <= range.start) range = { start: range.start - old.text.length, end: range.end - old.text.length };
  }
  const token = '@' + participantLabel(person);
  const suffix = text.slice(range.end), separator = suffix && /^\s/u.test(suffix) ? '' : ' ';
  const next = text.slice(0, range.start) + token + separator + suffix;
  if (next.length > 16000) return toastMessage("toast.draftLimit");
  const before = input.value, prior = roomMention && { ...roomMention };
  input.focus(); input.setSelectionRange(0, input.value.length);
  // Chromium owns text and undo. Record this explicit identity occurrence,
  // including an unbound before-state; equal text alone never grants routing.
  mentionChanging = true;
  try { if (!document.execCommand('insertText', false, next)) input.value = next; }
  finally { mentionChanging = false; }
  roomMention = { id, active: true, roomId: spaceId, memberRevision: pairRevision(person), start: range.start, end: range.start + token.length, text: token };
  roomMentionHistory.record(before, prior, input.value, roomMention);
  $('mention-status').textContent = '';
  roomMentionEdit = null; roomDraftRevision++;
  input.setSelectionRange(roomMention.end + separator.length, roomMention.end + separator.length);
  closeMentions(); attempt(persistView); render(); input.focus();
}
function share(text) {
  shareSpaceId = spaceId;
  if (!members().length) return toastMessage("toast.addShareRecipient");
  shareRevision++;
  $('share-text').value = text; populateSelect($('share-recipient'), members()); $('share-dialog').showModal(); updateSharingControls();
}
function updateSharingControls() {
  if (!$('share-dialog').open) return;
  const target = members().find(s => s.id === $('share-recipient').value);
  $('confirm-share').disabled = Boolean(sharePending) || !$('share-text').value.trim() || !target || interruptPending(target) || target.nativeInputRequired || target.shareAvailable === false || target.chatAvailable === false || disconnected;
  ui.display.text($('confirm-share'), sharePending ? 'common.sending' : 'share.send');
  const key = sharePending ? 'share.sendingHelp' : interruptPending(target) ? 'share.interruptHelp' : target?.nativeInputRequired ? 'share.nativeInputHelp' : null;
  const raw = !key && (target?.sharingNotice || target?.submissionNotice);
  const message = target?.sharingNotice ? target.sharingNoticeUiMessage : target?.submissionNoticeUiMessage;
  if (raw && message) ui.display.computed($('share-help'), 'text', () => ui.displayText(raw, message));
  else if (raw) { ui.display.unbind($('share-help')); $('share-help').textContent = raw; }
  else ui.display.text($('share-help'), key || (target?.chatAvailable === false ? 'share.connectHelp' : 'share.help'));
}
function visibleSelectionTerminal() {
  const s = current(); if (!s || s.archived) return null;
  const entry = terminals.get(s.id);
  return terminalLayout !== 'hidden' && entry?.ready && entry.element.checkVisibility() ? entry.term : null;
}
function selectedSharingText() {
  const s = current(); if (!s || s.archived || renameTarget) return '';
  {
    const selection = window.getSelection(), text = selection?.toString() || '';
    if (text) {
      // Only the displayed conversation/trace/permission content is a source.
      // A selection in another pane or dialog must not become this agent's text.
      const visible = value => (value?.nodeType === Node.ELEMENT_NODE ? value : value?.parentElement)?.getClientRects().length > 0;
      const inside = visible(selection.anchorNode) && visible(selection.focusNode) && ['messages', 'approval'].some(id => {
        const el = $(id);
        return !el.hidden && el.contains(selection.anchorNode) && el.contains(selection.focusNode);
      });
      return inside ? text : '';
    }
  }
  return visibleSelectionTerminal()?.getSelection() || '';
}
function updateSelectedSharing() {
  if (headerControls) headerControls.selectedText.disabled = !selectedSharingText().trim();
}
function nativeSelectionChanged(id, term) {
  if (current()?.id !== id || visibleSelectionTerminal() !== term) return;
  if (term.hasSelection() && term.element.contains(document.activeElement)) window.getSelection()?.removeAllRanges();
  updateSelectedSharing();
}
function documentSelectionChanged() {
  // Choosing ordinary text supersedes an older terminal selection. No selection
  // is cached or transferred between sessions; sharing always reads it afresh.
  if (window.getSelection()?.toString()) visibleSelectionTerminal()?.clearSelection();
  updateSelectedSharing();
}
document.addEventListener('selectionchange', documentSelectionChanged);
document.addEventListener('toggle', updateSelectedSharing, true);
const headerMenuKey = () => JSON.stringify([selectionRevision, selected, current()?.id, current()?.nativeId, spaceId, current() ? pairRevision(current()) : null, current()?.archived, current()?.owner, disconnected]);
function openHeaderMenu(anchor, terminal = false) {
  if (!current()) return;
  if (sessionMenu?.anchor === anchor) return sessionMenu.close();
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  const key = headerMenuKey(), h = headerControls;
  const actions = terminal ? [{ id: 'display', label: uiText('header.display'), labelKey: 'header.display', control: $('terminal-display') }]
    : [{ id: 'membership', label: h.membership.textContent, labelRead: () => h.membership.textContent, control: h.membership }, { id: 'share', label: uiText('header.share'), labelKey: 'header.share', control: h.selectedText }, { id: 'usage', label: uiText('header.usage'), labelKey: 'header.usage', control: h.usage }];
  const items = actions.filter(item => terminal || !current().archived || item.id === 'usage');
  anchor.focus(); anchor.setAttribute('aria-expanded', 'true');
  const close = ui.menu({
    items: items.map(({ control, ...item }) => ({ ...item, disabled: control.disabled })),
    getAnchorRect: () => anchor.getBoundingClientRect(),
    onClose: () => {
      if (sessionMenu?.close === close) sessionMenu = null;
      anchor.setAttribute('aria-expanded', 'false');
      if (key === headerMenuKey() && anchor.isConnected) anchor.focus({ preventScroll: true });
    },
    onSelect: action => { if (key === headerMenuKey()) items.find(item => item.id === action)?.control.click(); },
  });
  sessionMenu = { id: current().id, anchor, key, close };
}
function renderHeaderLayout(s, inRoom) {
  const compact = Boolean(s && !inRoom), toolbar = $('session-toolbar');
  const compactRoom = Boolean(inRoom && !s), header = $('header'), tabs = $('room-tabs'), band = $('run-status').parentElement;
  const moving = compactRoom !== header.classList.contains('compact-room') || roomOverview && (roomOverview.toolbar.parentElement === tabs) !== compactRoom;
  if (moving) { captureReadingViews(); restoreOverviewReading(); }
  header.classList.toggle('compact-room', compactRoom);
  $('room-view').classList.toggle('compact-room-surface', inRoom);
  const relocate = (element, parent, before = null) => {
    if (element.parentElement === parent) return;
    const active = element.contains(document.activeElement) ? document.activeElement : null;
    parent.insertBefore(element, before);
    if (active?.getClientRects().length && !active.hidden) active.focus({ preventScroll: true });
  };
  if (compactRoom) { relocate(band, header, $('header-actions')); relocate(tabs, header); }
  else { relocate(band, $('room-view'), $('room-layout')); relocate(tabs, $('room-view'), $('room-layout')); }
  if (roomOverview) {
    relocate(roomOverview.toolbar, compactRoom ? tabs : $('collaboration-overview'), compactRoom ? $('manage-members') : $('collaboration-overview').firstChild);
    $('collaboration-overview').dataset.externalToolbar = String(compactRoom);
  }
  $('header').classList.toggle('compact-session', compact);
  $('session-view').classList.toggle('compact-session-surface', compact);
  if (compact) {
    if (toolbar.parentElement !== $('header')) $('header').insertBefore(toolbar, $('header-actions'));
    if ($('session-files').parentElement !== $('conversation-pane-toolbar')) $('conversation-pane-toolbar').append($('session-files'), $('chat-maximize'));
  } else {
    if (toolbar.parentElement !== $('session-view')) $('session-view').prepend(toolbar);
    if ($('session-files').parentElement !== toolbar) toolbar.insertBefore($('session-files'), $('session-status'));
    if ($('chat-maximize').parentElement !== toolbar) toolbar.insertBefore($('chat-maximize'), $('session-status'));
  }
  $('conversation-pane-toolbar').hidden = !compact;
  $('terminal-more').hidden = !compact;
  $('title').tabIndex = compact || compactRoom ? 0 : -1;
  ui.display.computed($('title'), 'title', () => compact ? s.name : compactRoom ? state.room.unavailable ? uiText('space.unavailable') : state.room.name : '');
  $('title').onfocus = () => { if (header.classList.contains('compact-room')) { captureReadingViews(); restoreOverviewReading(); header.classList.add('reveal-room-title'); } };
  $('title').onblur = () => { if (header.classList.contains('reveal-room-title')) { captureReadingViews(); restoreOverviewReading(); header.classList.remove('reveal-room-title'); } };
  if (!compactRoom) header.classList.remove('reveal-room-title');
  const settings = s?.nativeSettings?.nativeId === s?.nativeId ? [s?.nativeSettings?.mode === 'plan' ? 'Plan' : '', s?.nativeSettings?.effort].filter(Boolean) : [];
  const values = s ? [s.provider === 'claude' ? 'Claude Code' : 'Codex', sessionShortId(s.id), s.model, ...settings, window.nativeWorkspaceSpaces.roomIds(s).length ? 'header.collaborating' : 'header.independent'] : [];
  const subtitle = $('subtitle'), signature = JSON.stringify([compact, compactRoom, inRoom, values, s?.modelUiMessage, compactRoom && members().length]);
  if (subtitle.dataset.identity !== signature) {
    ui.display.unbind(subtitle); subtitle.replaceChildren();
    if (compact) subtitle.replaceChildren(...values.map((value, index) => {
      const field = node('span', index === values.length - 1 ? undefined : value, `identity-value${index === 2 ? ' identity-model' : ''}`);
      field.tabIndex = 0;
      if (index === values.length - 1) { ui.display.text(field, value); ui.display.attribute(field, 'title', value); ui.display.attribute(field, 'aria-label', value); }
      else if (index === 2) for (const slot of ['text', 'title', 'aria-label']) ui.display.computed(field, slot, () => ui.displayText(value, s.modelUiMessage));
      else { field.title = value; field.setAttribute('aria-label', value); }
      return field;
    }));
    else ui.display.computed(subtitle, 'text', () => compactRoom ? uiText('header.members', { count: members().length }) : s ? values.slice(0, -1).map((value, index) => index === 2 ? ui.displayText(value, s.modelUiMessage) : value).concat(uiText(values.at(-1))).join(' · ') : uiText(inRoom ? 'header.roomHelp' : 'header.welcomeHelp'));
    subtitle.dataset.identity = signature;
  }
  if (sessionMenu?.anchor && sessionMenu.key !== (sessionMenu.kind === 'member' ? memberMenuKey(sessionMenu.id) : headerMenuKey())) sessionMenu.close();
  if (roomMenu?.key && roomMenu.key !== roomMenuKey(roomMenu.roomId)) roomMenu();
  if (moving) restoreOverviewReading();
}
function renderHeader(s, inRoom) {
  if (!headerControls) {
    const resume = uiButton('header.resume', () => { const s = current(); if (s && canResume(s)) return api.resume(s.id); }, 'primary');
    const membership = button('', () => { const s = current(); if (s && !s.archived) return inSpace(s) ? detach(s.id) : addToSpace(s.id, spaceId); });
    const selectedText = uiButton('header.share', () => {
      const s = current(); if (!s || s.archived) return;
      const text = selectedSharingText();
      text?.trim() ? share(text) : toastMessage('header.selectFirst');
    });
    const usage = uiButton('header.usage', () => {
      const target = current();
      if (!sharedSurface() && !target) return;
      return showTrust({ usageScope: sharedSurface() ? { kind: 'room', roomId: state.room.id, name: state.room.name, unavailable: state.room.unavailable === true }
        : { kind: 'session', id: target.id, nativeId: target.nativeId, name: target.name } });
    });
    usage.id = 'usage-button'; ui.display.attribute(usage, 'aria-label', 'header.usageAria');
    const restore = uiButton('archive.restoreSession', () => { const s = current(); if (s?.archived) return restoreArchivedSession(s.id); }, 'primary');
    const more = button('⋯', () => openRoomMenu(null, more)); more.id = 'room-header-more'; ui.display.attribute(more, 'aria-label', 'header.roomMenu'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    more.onpointerdown = event => { if (roomMenu) event.stopPropagation(); };
    const compactMore = button('⋯', () => openHeaderMenu(compactMore));
    compactMore.id = 'session-header-more'; ui.display.attribute(compactMore, 'aria-label', 'header.sessionMenu'); compactMore.setAttribute('aria-haspopup', 'menu'); compactMore.setAttribute('aria-expanded', 'false');
    compactMore.onpointerdown = event => { if (sessionMenu?.anchor === compactMore) event.stopPropagation(); };
    for (const control of [membership, selectedText, usage]) control.classList.add('header-secondary');
    headerControls = { resume, membership, selectedText, restore, more, usage, compactMore };
    $('header-actions').append(resume, membership, selectedText, usage, restore, more, compactMore);
  }
  const h = headerControls;
  const membershipAction = JSON.stringify([spaceId, s?.id, s ? inSpace(s) : false, !!s?.archived]);
  // A peer can change membership while this control is focused. Preserve focus
  // for output updates, never for a newly opposite join/leave action.
  if (h.membership.dataset.action !== membershipAction && document.activeElement === h.membership) h.membership.blur();
  h.membership.dataset.action = membershipAction;
  h.usage.hidden = !s && !inRoom;
  h.resume.hidden = !s || !canResume(s) || mode !== 'terminal';
  h.membership.hidden = h.selectedText.hidden = !s || !!s.archived;
  ui.display.text(h.membership, s && inSpace(s) ? 'header.leave' : 'header.join');
  h.restore.hidden = !s?.archived;
  h.more.hidden = !inRoom || !!s;
  h.more.disabled = disconnected || state.room.archived || renameTarget?.id === 'room' && renameTarget.roomId === spaceId;
  h.compactMore.hidden = !s || inRoom;
  renderHeaderLayout(s, inRoom);
}
function appendNativeQuestions(parent, questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 20) return false;
  if (!questions.every(q => q && typeof q.question === 'string' && q.question.length <= 16000 &&
    (q.header == null || typeof q.header === 'string' && q.header.length <= 16000) &&
    (q.options == null || Array.isArray(q.options) && q.options.length <= 100 && q.options.every(o => o && typeof o.label === 'string' && o.label.length <= 16000 && (o.description == null || typeof o.description === 'string' && o.description.length <= 16000))))) return false;
  for (const question of questions) {
    const group = node('div', '', 'native-question');
    if (question.header) group.append(node('strong', question.header));
    group.append(node('p', question.question));
    const options = node('ol');
    for (const option of question.options || []) {
      const item = node('li'); item.append(node('span', option.label));
      if (option.description) item.append(node('p', option.description));
      options.append(item);
    }
    if (options.children.length) group.append(options); parent.append(group);
  }
  return true;
}
// A native question answered here: one choice per question (several for a
// multi-select), or the native "other" text. Codex keys answers by question id,
// Claude by the question text.
function appendQuestionForm(parent, questions, disabled, submit) {
  const form = node('form', undefined, 'question-form'), chosen = new Map(), typed = new Map(), key = q => q.id ?? q.question;
  const values = q => [...(chosen.get(key(q)) || []), ...(typed.get(key(q))?.trim() ? [typed.get(key(q)).trim()] : [])];
  const ready = () => questions.every(q => values(q).length);
  const send = uiButton('approval.submit', () => submit(Object.fromEntries(questions.map(q => [key(q), values(q)]))));
  const update = () => { send.disabled = disabled || !ready(); };
  questions.forEach((q, index) => {
    const group = node('fieldset', undefined, 'native-question'), name = `native-question-${index}`;
    group.append(q.header ? node('legend', q.header) : uiNode('legend', 'approval.questionNumber', { index: index + 1 }), node('p', q.question));
    let other = null;
    for (const option of q.options || []) {
      const label = node('label'), input = document.createElement('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio'; input.name = name; input.value = option.label; input.disabled = disabled;
      input.onchange = () => {
        const set = q.multiSelect ? new Set(chosen.get(key(q))) : new Set();
        if (input.checked) set.add(option.label); else set.delete(option.label);
        chosen.set(key(q), set); if (!q.multiSelect && other) { other.value = ''; typed.delete(key(q)); } update();
      };
      label.append(input, node('span', option.label)); if (option.description) label.append(node('small', option.description));
      group.append(label);
    }
    if (q.isOther || !(q.options || []).length) {
      other = document.createElement('input'); other.type = 'text'; other.disabled = disabled;
      const placeholderKey = (q.options || []).length ? 'approval.other' : 'approval.answer';
      ui.display.attribute(other, 'placeholder', placeholderKey); ui.display.attribute(other, 'aria-label', 'approval.answerAria', () => ({ question: q.header || q.question, placeholder: uiText(placeholderKey) }));
      other.oninput = () => { if (!q.multiSelect) { for (const input of group.querySelectorAll('input[type="radio"]')) input.checked = false; chosen.delete(key(q)); } typed.set(key(q), other.value); update(); };
      group.append(other);
    }
    form.append(group);
  });
  form.onsubmit = event => { event.preventDefault(); if (!send.disabled) send.click(); };
  form.append(send); update(); parent.append(form);
}
function nativeApprovalPreview(request) {
  const raw = typeof request.input === 'string' ? request.input : '', title = request.title || uiText('approval.nativeRequest');
  let fields;
  try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) fields = value; } catch { /* Original native input remains readable. */ }
  let detail = '', kind = 'raw', before, after, command, scope = '';
  if (title === 'Edit' && typeof fields?.file_path === 'string' && typeof fields.old_string === 'string' && typeof fields.new_string === 'string') {
    detail = fields.file_path; kind = 'edit'; before = fields.old_string; after = fields.new_string;
    scope = fields.replace_all === true ? uiText('approval.replaceAll') : fields.replace_all === false ? uiText('approval.replaceOne') : '';
  } else if (title === 'Bash' && typeof fields?.command === 'string') {
    detail = fields.command; kind = 'command'; command = fields.command;
  } else if (title === 'AskUserQuestion' && Array.isArray(fields?.questions)) {
    const question = fields.questions[0]; detail = question?.header || question?.question || ''; kind = 'questions';
  }
  const text = String(detail).replace(/[\r\n\t]/g, ' '), chars = Array.from(text);
  return { label: title + (text ? ' ' + chars.slice(0, 240).join('') + (chars.length > 240 ? '…' : '') : ''), kind, raw, before, after, command, scope };
}
function nativeApprovalExcerpt(text) {
  const prefix = Array.from(text.split('\n').slice(0, 8).join('\n')).slice(0, 1200).join('');
  return { text: prefix, truncated: prefix !== text };
}
function nativeApprovalChangeExcerpts(before, after) {
  const left = Array.from(before), right = Array.from(after);
  let changed = 0;
  while (changed < left.length && changed < right.length && left[changed] === right[changed]) changed++;
  const excerpt = (points, original) => {
    const anchor = Math.min(changed, points.length); let start = Math.max(0, anchor - 48);
    for (let i = anchor - 1; i >= start; i--) if (points[i] === '\n') { start = i + 1; break; }
    // Start on the changed line, retaining only literal nearby context. A long
    // common prefix must not push the actual change outside the short preview.
    const text = nativeApprovalExcerpt(points.slice(start, start + 1200).join('')).text;
    return { text, truncated: start > 0 || text !== original };
  };
  return { before: excerpt(left, before), after: excerpt(right, after) };
}
function renderNativeOnlyApproval(el, s, stale) {
  const context = JSON.stringify([s.id, s.nativeId]);
  if (el.nativeApprovalContext !== context) { el.replaceChildren(); el.nativeApprovalContext = context; }
  const requests = Array.isArray(s.nativeApproval.requests) ? s.nativeApproval.requests : [];
  if (!requests.length) { el.replaceChildren(); el.hidden = true; return; }
  const previous = new Map([...el.querySelectorAll(':scope > .native-approval-request')].map(row => [row.nativeRequestSignature, row])), rows = [];
  for (const request of requests) {
    const signature = JSON.stringify([request.id, request.turnId, request.title, request.input, request.incomplete]);
    let row = previous.get(signature);
    if (!row) {
      row = node('details', undefined, 'native-approval-request process-details');
      row.nativeRequestSignature = signature; row.dataset.nativeRequestId = request.id || '';
      const summary = node('summary'), author = node('span', undefined, 'native-approval-author'), label = node('span', undefined, 'native-approval-label'), content = node('div', undefined, 'native-approval-content');
      const status = uiNode('span', request.title === 'AskUserQuestion' ? 'approval.waitAnswer' : 'approval.waitApprove', undefined, 'native-approval-status');
      row.nativeAuthor = author; row.nativeLabel = label; row.dataset.incomplete = String(Boolean(request.incomplete)); summary.append(author, status, label); row.append(summary, content);
      if (request.incomplete) { summary.append(uiNode('span', 'approval.incomplete', undefined, 'native-approval-incomplete')); content.append(uiNode('p', 'approval.incompleteHelp')); }
      const preview = nativeApprovalPreview(request);
      if (preview.kind === 'edit') {
        if (preview.scope) { const scope = node('span', undefined, 'native-approval-scope'); ui.display.computed(scope, 'text', () => nativeApprovalPreview(request).scope); summary.append(scope); }
        const excerpts = nativeApprovalChangeExcerpts(preview.before, preview.after);
        for (const [name, excerpt, cls] of [['approval.before', excerpts.before, 'native-approval-before'], ['approval.after', excerpts.after, 'native-approval-after']]) {
          const group = node('div', undefined, cls);
          const label = node('strong'); ui.display.computed(label, 'text', () => excerpt.truncated ? uiText('approval.excerpt', { label: uiText(name) }) : uiText(name));
          group.append(label, node('pre', excerpt.text, 'approval-command')); content.append(group);
        }
      } else if (preview.kind === 'command') content.append(node('pre', preview.command, 'approval-command'));
      else if (preview.kind === 'questions') {
        if (!appendNativeQuestions(content, JSON.parse(preview.raw).questions)) content.append(node('pre', preview.raw, 'approval-command'));
      } else if (preview.raw) content.append(node('pre', preview.raw, 'approval-command native-approval-raw-body'));
      if (preview.kind !== 'raw') {
        const original = node('details', undefined, 'native-approval-original');
        original.append(uiNode('summary', 'approval.original'), node('pre', preview.raw, 'approval-command native-approval-raw-body')); content.append(original);
      }
    }
    const description = () => nativeApprovalPreview(request).label, caption = () => { const preview = nativeApprovalPreview(request); return `${s.name} · ${uiText(request.title === 'AskUserQuestion' ? 'approval.yourAnswer' : 'approval.yourApproval')} · ${description()}${preview.scope ? ' · ' + preview.scope : ''}`; };
    if (row.nativeAuthor.textContent !== s.name) row.nativeAuthor.textContent = s.name;
    row.nativeAuthor.title = s.name;
    ui.display.computed(row.nativeLabel, 'text', description);
    ui.display.computed(row.firstChild, 'title', caption); ui.display.computed(row.firstChild, 'aria-label', caption); rows.push(row);
  }
  let terminal = el.querySelector(':scope > .native-approval-terminal');
  if (!terminal) terminal = button('', () => operateNative(s.id), 'native-approval-terminal');
  ui.display.text(terminal, 'approval.goTerminal');
  ui.display.attribute(terminal, 'aria-label', 'approval.inTerminal', { name: s.name });
  ui.display.attribute(terminal, 'title', 'approval.inTerminalHelp', { name: s.name }); rows.push(terminal);
  let notice = el.querySelector(':scope > .native-approval-stale');
  if (!notice) notice = uiNode('p', 'approval.stale', undefined, 'native-approval-stale');
  notice.hidden = !stale; rows.push(notice);
  // Keep unchanged native request nodes connected: receipt/owner updates must
  // not collapse an open request or discard a selection in its original text.
  let cursor = el.firstChild;
  for (const row of rows) { if (row === cursor) cursor = cursor.nextSibling; else el.insertBefore(row, cursor); }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
function renderApproval(s, own) {
  const el = $('approval');
  const requests = s?.approvals?.length ? s.approvals : s?.approval ? [s.approval] : [];
  const requested = approvalViews.get(s?.id), chosen = requests.find(a => requested && a.requestId === requested);
  if (requested && !chosen) approvalViews.delete(s.id);
  if (chosen) s = { ...s, approval: chosen, approvalDecisions: chosen.decisions || s.approvalDecisions };
  const nativeOnly = Boolean(s?.nativeApproval?.nativeOnly && !s?.claudeQuestion);
  el.hidden = !s || (s.state !== 'approval' && !s.nativeApproval && !s.approval && !s.claudeQuestion) ||
    nativeOnly && (!Array.isArray(s.nativeApproval.requests) || !s.nativeApproval.requests.length);
  const stale = !nativeStatusFresh(s?.nativeApproval);
  const { observedAt, ...nativeApprovalContent } = s?.nativeApproval || {};
  el.classList.toggle('native-only', nativeOnly);
  const signature = JSON.stringify([s?.id, s?.nativeId, s?.name, s?.state, own, s?.claudeQuestion, s?.approval, requests, s?.approvalOverflow, s?.approvalNotice, s?.approvalNoticeUiMessage, s?.approvalResolved, s?.approvalDecisions, s?.nativeApproval ? nativeApprovalContent : null, stale]);
  if (el.dataset.signature === signature) return;
  el.dataset.signature = signature;
  if (!nativeOnly || el.hidden) { el.replaceChildren(); delete el.nativeApprovalContext; }
  if (el.hidden) return;
  if (s.claudeQuestion) {
    // Held before the native dialog opens: answer here, or let the terminal ask it.
    const { requestId, questions } = s.claudeQuestion;
    el.append(uiNode('strong', 'approval.namedStatus', () => ({ name: s.name, status: uiText('approval.yourAnswer') })));
    appendQuestionForm(el, questions.map(q => ({ ...q, isOther: true })), !own, answers => api.answer(s.id, requestId, answers));
    el.append(uiButton('approval.terminalAnswer', async () => { await api.answer(s.id, requestId, null); await switchMode('terminal'); }));
    return;
  }
  if (s.nativeApproval?.nativeOnly) {
    renderNativeOnlyApproval(el, s, stale);
    return;
  }
  if (requests.length > 1) {
    const select = document.createElement('select'); select.id = 'approval-request'; ui.display.attribute(select, 'aria-label', 'approval.pending');
    requests.forEach((request, index) => {
      const textKey = request.method === 'item/tool/requestUserInput' ? 'approval.question' : 'approval.confirm';
      const detail = () => request.params?.command || request.params?.questions?.[0]?.header || ui.displayText(request.params?.reason, request.method === 'native/requestAmbiguous' ? request.params?.reasonUiMessage : undefined) || '';
      const option = node('option'); ui.display.computed(option, 'text', () => `${index + 1}. ${uiText(textKey)}${detail() ? ' · ' + detail().split('\n')[0].slice(0, 90) : ''}${request.pending ? uiText('approval.submitted') : ''}`);
      option.value = request.requestId; select.append(option);
    });
    select.value = s.approval.requestId;
    select.onchange = () => { approvalViews.set(s.id, select.value); render(); $('approval-request')?.focus(); };
    el.append(select);
  }
  const heading = uiNode('strong', 'approval.namedStatus', () => ({ name: s.name, status: uiText(s.approvalNotice ? 'approval.unverified' : s.approvalResolved ? 'approval.resolved' : s.approval?.pending ? 'approval.waitResult' : 'approval.needed') }));
  el.append(heading);
  if (s.approvalOverflow) el.append(uiNode('p', 'approval.overflow'));
  if (s.approvalNotice) { const notice = node('p'); ui.display.computed(notice, 'text', () => ui.displayText(s.approvalNotice, s.approvalNoticeUiMessage)); el.append(notice); }
  if (s.approvalResolved) el.append(uiNode('p', 'approval.resolvedHelp'));
  if (s.approval) {
    const policy = window.nativeWorkspaceApproval.nativeApprovalPolicy(s.approval);
    if (policy.questions) {
      ui.display.text(heading, 'approval.namedStatus', () => ({ name: s.name, status: uiText(s.approval.params.isBlocking === false ? 'approval.nonBlocking' : 'approval.yourAnswer') }));
      const requestId = s.approval.requestId;
      if (s.provider === 'codex' && (s.serviceCapabilities || state.capabilities || []).includes('nativeQuestionAnswer') && !policy.questions.some(q => q.isSecret)) {
        appendQuestionForm(el, policy.questions, !own || Boolean(s.approval.pending) || s.state !== 'approval' || Boolean(s.approvalOverflow), answers => api.answer(s.id, requestId, answers));
      } else appendNativeQuestions(el, policy.questions);
    } else if (policy.notice) el.append(policy.noticeKey ? uiNode('p', policy.noticeKey) : node('p', policy.notice));
    if (policy.command) el.append(node('pre', policy.command, 'approval-command'));
    if (policy.cwd) el.append(uiNode('p', 'approval.cwd', { cwd: policy.cwd }));
    if (policy.reason) el.append(uiNode('p', 'approval.reason', () => ({ reason: ui.displayText(policy.reason, policy.reasonUiMessage) })));
    const requestId = s.approval.requestId;
    if (s.approval.params?.environmentId === 'local') el.append(uiNode('p', 'approval.local'));
    for (const decision of (s.approvalDecisions || []).filter(d => policy.decisions.includes(d))) {
      const action = uiButton({ accept: 'approval.accept', decline: 'approval.decline', cancel: 'approval.cancel' }[decision], () => api.approve(s.id, requestId, decision));
      action.disabled = !own || Boolean(s.approval.pending) || s.state !== 'approval' || Boolean(s.approvalOverflow); el.append(action);
    }
  }
  el.append(uiButton('approval.inTerminal', () => operateNative(s.id), undefined, { name: s.name }));
}
function renderAdvanced(s) {
  if (advancedControls?.id !== s.id) {
    const info = node('div'), usage = node('div'), fleet = node('div');
    const stop = uiButton(s.provider === 'codex' ? 'advanced.disconnect' : 'advanced.end', () => api.stop(s.id), 'small');
    const forget = uiButton('advanced.forget', () => api.forget(s.id), 'small');
    $('advanced-content').replaceChildren(info, usage, uiButton('advanced.notes', openNotes, 'small'), uiButton('advanced.context', openContext, 'small'), fleet, stop, forget);
    advancedControls = { id: s.id, info, usage, fleet, stop, forget };
  }
  const a = advancedControls;
  ui.display.text(a.info, 'advanced.info', () => ({ id: s.nativeId || uiText('advanced.establishing'), pid: s.pid || uiText('advanced.disconnected'), version: s.provider === 'codex' ? '\n' + nativeVersionText(s) : '', backend: s.runtimeVersion || uiText('version.unreported'), cwd: s.cwd, contexts: s.nativeContexts?.length ? uiText('advanced.oldContexts', { ids: s.nativeContexts.map(c => c.nativeId).join('、') }) : '', background: s.background ?? uiText('advanced.nativeMissing'), scheduled: s.scheduled ?? uiText('advanced.nativeMissing') }));
  a.usage.hidden = false; ui.display.computed(a.usage, 'text', () => window.nativeWorkspaceUsage.usageLines(s.provider, s.usage, ui.language.getSnapshot().active).join('\n'));
  a.fleet.replaceChildren(...s.fleet.slice(-8).map(event => { const label = node('div'); ui.display.computed(label, 'text', () => `${event.event}${event.kind ? ' / ' + event.kind : event.tool ? ' / ' + event.tool : ''} · ${ui.displayText(event.name, event.nameUiMessage)}${event.model ? ' · ' + event.model : ''}`); return label; }));
  a.stop.hidden = !switchedAway(s) && ['ended', 'background', 'stopping', 'recoverable'].includes(s.state);
  a.forget.hidden = !(['ended', 'background', 'recoverable', 'error'].includes(s.state) && !s.backendUnavailable && !s.terminalAvailable && (s.serviceCapabilities || state.capabilities)?.includes('forget'));
}
// Only known activity enums are localized; native titles pass through unchanged.
const nativeActivityLabels = {"requesting": "activity.requesting", "thinking": "activity.thinking", "text": "activity.text", "input": "activity.input", "tool": "activity.tool", "inProgress": "activity.inProgress", "commandExecution": "activity.commandExecution", "fileChange": "activity.fileChange", "mcpToolCall": "activity.mcpToolCall", "dynamicToolCall": "activity.dynamicToolCall", "webSearch": "activity.webSearch", "reasoning": "activity.reasoning", "plan": "activity.plan", "agentMessage": "activity.agentMessage", "waitingOnUserInput": "activity.waitingOnUserInput", "waitingOnApproval": "activity.waitingOnApproval", "willRetry": "activity.willRetry"};
const elapsedText = seconds => seconds < 60 ? uiText('native.seconds', { seconds }) : seconds < 3600 ? uiText('native.minutes', { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, '0') }) : uiText('native.hours', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds % 3600 / 60) });
function renderNativeActivity(s) {
  const el = $('native-activity');
  const recovery = !disconnected && !s?.transportDisconnected && s?.capacityRecovery;
  if (recovery && ['scheduled', 'exhausted'].includes(recovery.status)) {
    el.hidden = false;
    ui.display.computed($('native-phase'), 'text', () => `${s.name} · ${uiText(recovery.reason === 'routing' ? 'native.routingTimeout' : 'native.capacity')}${recovery.status === 'exhausted' ? uiText('native.capacityLimit') : ''}`);
    ui.display.computed($('native-elapsed'), 'text', () => recovery.status === 'scheduled' ? uiText('native.recovery', { time: new Date(recovery.due).toLocaleTimeString(ui.language.getSnapshot().active, { hour: '2-digit', minute: '2-digit' }), attempt: recovery.attempt + 1 }) : '');
    return;
  }
  const question = s?.approval?.method === 'item/tool/requestUserInput';
  const waiting = s?.claudeQuestion || s?.state === 'approval' || s?.nativeApproval || s?.approval && !(question && s.approval.params?.isBlocking === false);
  const live = s && !disconnected && !s.transportDisconnected && (waiting || ['working', 'approval'].includes(s.state) || s.nativeActivity && !nativeStatusFresh(s.nativeActivity));
  el.hidden = !live;
  if (!live) return;
  const status = s.nativeActivity;
  const matched = status && nativeStatusFresh(status) && status.nativeId === s.nativeId && status.turnId === s.activeTurnId;
  const seconds = matched && Number.isFinite(status.startedAt) && status.startedAt <= Date.now() ? Math.floor((Date.now() - status.startedAt) / 1000) : null;
  const label = () => s.claudeQuestion ? uiText('state.question') : status && !nativeStatusFresh(status) ? uiText('native.stale') : matched && status.label ? (Object.hasOwn(nativeActivityLabels, status.label) ? uiText(nativeActivityLabels[status.label]) : status.label) : uiText(waiting ? question ? 'state.question' : 'native.approval' : 'native.processing');
  const notice = matched && !waiting && !s.approvalOverflow && s.state === 'working' && status.waitNotice;
  const slow = notice?.kind === 'tool-wait' && notice.nativeId === s.nativeId && notice.turnId === s.activeTurnId && notice.marker === status.toolWait?.marker && notice.progressAt === status.toolWait?.progressAt;
  ui.display.computed($('native-phase'), 'text', () => (s.name || 'Codex') + ' · ' + label() + (slow ? uiText('native.slowTool') : ''));
  ui.display.computed($('native-elapsed'), 'text', () => seconds === null ? '' : uiText('native.used', { elapsed: elapsedText(seconds) }));
}
const nativeActivityClock = setInterval(() => {
  if (!state) return;
  renderNativeActivity(current());
  if (selected === 'room') roomOverview?.refresh();
  if (selected === 'panorama') panorama?.refresh();
  if (state.sessions.some(s => s.sharedActivity && !nativeStatusFresh(s.sharedActivity) || s.nativeApproval && !nativeStatusFresh(s.nativeApproval))) render();
}, 1000);
function render() {
  if (!state || rendering) return;
  captureReadingViews();
  rendering = true;
  let removedRoomFocus;
  try {
    if (selected === 'room' && state.room.archived) { selected = ''; roomSession = ''; attempt(persistView); }
    // A member may leave in another window. Stay in the room, returning through
    // the same input/composition guards as the explicit overview Back action.
    if (selected === 'room' && roomSession && !members().some(s => s.id === roomSession)) {
      const id = roomSession, cards = [...$('collaboration-overview').querySelectorAll('.collaboration-member-status')];
      removedRoomFocus = { origin: document.activeElement, index: cards.findIndex(el => el.dataset.memberId === id) };
      focusRoomMember('', id, roomOverview?.key(id));
    }
    const s = current(); const inRoom = selected === 'room', memberFocus = focusedRoomMember(), inPanorama = selected === 'panorama';
    activateSoloComposer(s?.id);
    if (!inRoom) for (const binding of sessionComposers.values()) if (binding.column && binding.visible) removeColumnInput(binding.id);
    const slot = inRoom ? $('room-session') : $('solo-session');
    if ($('session-view').parentElement !== slot) slot.append($('session-view'));
    $('solo-session').hidden = inRoom || !s;
    $('room-session').hidden = !s;
    $('room-record-view').hidden = false;
    $('room-scope').hidden = !inRoom || !s;
    const terminalVisible = Boolean(s && terminalLayout !== 'hidden' && (!memberFocus || mode === 'terminal'));
    if ($('terminal-display-dialog').open && (!terminalVisible || terminalDisplayKey !== headerMenuKey())) $('terminal-display-dialog').close();
    $('native-pane').hidden = !terminalVisible;
    $('room-layout').classList.toggle('has-terminal', inRoom && terminalVisible);
    $('room-layout').classList.toggle('terminal-maximized', inRoom && terminalVisible && terminalLayout === 'maximized');
    $('session-layout').classList.toggle('has-terminal', (!inRoom || memberFocus) && terminalVisible);
    $('session-layout').classList.toggle('terminal-maximized', (!inRoom || memberFocus) && terminalVisible && terminalLayout === 'maximized');
    $('session-layout').classList.toggle('native-only', inRoom && !memberFocus);
    $('conversation-pane').hidden = inRoom && !memberFocus;
    $('chat-tab').parentElement.hidden = inRoom && !memberFocus;
    $('session-files').hidden = inRoom && !memberFocus;
    document.title = `${s?.name || 'Native Workspace'} — Native Agent Workspace`;
    $('welcome').hidden = Boolean(s || inRoom || inPanorama); $('session-view').hidden = !s; $('room-view').hidden = !inRoom;
    $('panorama-view').hidden = !inPanorama;
    $('panorama-nav').classList.toggle('active', inPanorama);
    $('panorama-nav').setAttribute('aria-pressed', String(inPanorama));
    $('return-panorama').hidden = !panoramaView.returning || inPanorama;
    if (inRoom && state.room.unavailable) ui.display.text($('title'), 'space.unavailable');
    else if (inRoom || s?.name) { ui.display.unbind($('title')); $('title').textContent = inRoom ? state.room.name : s.name; }
    else ui.display.text($('title'), 'header.workspace');
    const warningText = (raw, message) => message ? ui.displayText(raw, message) : raw;
    const warning = () => [disconnected ? uiText('error.serviceDisconnectedNotice') : [warningText(state.storageWarning, state.storageWarningUiMessage), warningText(state.sessionNameWarning, state.sessionNameWarningUiMessage), warningText(state.roomStorageWarning, state.roomStorageWarningUiMessage)].filter(Boolean).join(' '), warningText(state.viewStorageWarning, state.viewStorageWarningUiMessage)].filter(Boolean).join(' ');
    $('alert').hidden = !warning(); ui.display.computed($('alert'), 'text', warning);
    $('reconnect-button').hidden = !disconnected;
    $('retry-save').hidden = !state.viewStorageWarning && (disconnected || !state.storageRetryable);
    renderSessions(); renderCreateSpaces();
    renderArchives(); renderSpaceNavigation(); renderSpaceFiles();
    if ($('share-dialog').open) { populateSelect($('share-recipient'), members()); updateSharingControls(); }
    if ($('invite-dialog').open) for (const entry of $('invite-list').children) {
      const record = state.sessions.find(s => s.id === entry.dataset.inviteSession);
      if (record) ui.display.text(entry, 'invite.joinName', { name: participantLabel(record, state.sessions) });
    }
    renderHeader(s, inRoom);
    if (inPanorama || panoramaView.returning) renderPanorama();
    if (inPanorama) {
      ui.display.text($('title'), 'panorama.title'); $('subtitle').textContent = '';
      document.title = uiText('panorama.windowTitle');
    }
    if (!s) renderNativeActivity(null);
    if (s) {
      const own = s.owner === owner; const alive = nativeUsable(s);
      ui.display.text($('native-pane-title'), inRoom ? 'terminal.named' : 'terminal.native', { name: participantLabel(s, state.sessions) });
      ui.display.attribute($('native-pane-title'), 'title', 'terminal.named', { name: participantLabel(s, state.sessions) });
      // A focused member's conversation tab also shows the chat alone, whatever the saved split.
      for (const [id, key] of [['terminal-maximize', terminalLayout === 'maximized' ? 'terminal.restoreSplit' : 'terminal.maximize'], ['chat-maximize', !terminalVisible ? 'terminal.restoreSplit' : 'terminal.maximizeChat']]) {
        ui.display.attribute($(id), 'aria-label', key); ui.display.attribute($(id), 'title', key);
      }
      // The graphic follows the same layout state as the accessible name.
      $('terminal-maximize').toggleAttribute('data-restore', terminalLayout === 'maximized'); $('chat-maximize').toggleAttribute('data-restore', !terminalVisible);
      ui.display.computed($('session-status'), 'text', () => `${s.archived ? uiText('native.archived') : ''}${sessionStatus(s)}${s.provider === 'codex' && s.nativeVersionStatus === 'unverified' && !disconnected ? uiText('native.codexUnverified', { version: s.nativeVersion || uiText('native.versionMissing') }) : ''}${s.activity ? ' · ' + (s.activityUiMessage ? ui.displayText(s.activity, s.activityUiMessage) : s.activity) : ''}${!own && s.owner ? uiText('native.otherWindow') : ''}${terminals.get(s.id)?.viewInput ? uiText('native.inputBuffered') : terminalUnclaimed(s, own, terminalVisible) ? uiText('native.terminalUnclaimed') : ''}`);
      ui.display.computed($('session-status'), 'title', () => nativeVersionText(s));
      $('take-control').hidden = own || !alive;
      $('chat-tab').classList.toggle('active', mode === 'chat'); $('terminal-tab').classList.toggle('active', mode === 'terminal');
      $('terminal-controls').hidden = !terminalVisible;
      $('terminal-paste').disabled = !terminalCanInput(s.id) || !alive;
      $('messages').hidden = false; $('terminal-area').hidden = !terminalVisible; $('composer-wrap').hidden = false;
      renderComposer(s); renderNativeActivity(s);
      $('interrupt').hidden = !own || !(['working', 'approval'].includes(s.state) || s.capacityRecovery?.status === 'scheduled');
      ui.display.text($('interrupt'), s.capacityRecovery?.status === 'scheduled' ? 'native.cancelContinue' : 'native.interrupt');
      $('interrupt').disabled = interruptPending(s);
      readLegacyProgress(s);
      const visibleMessages = sessionMessages(s);
      const signature = JSON.stringify([visibleMessages, !visibleMessages.length && [s.state, Boolean(s.nativeApproval)]]);
      const readingKey = focusedReadingKey(s.id);
      if (signature !== lastMessages || messageViews.get($('messages'))?.key !== readingKey) { messageList($('messages'), visibleMessages, false, readingKey); lastMessages = signature; }
      renderAdvanced(s);
      for (const id of terminals.keys()) syncTerminalMount(id);
      $('terminal-empty').hidden = terminals.has(s.id);
      // Without a terminal in this window: not started yet, ended, or (status line says
      // which: archived, background, disconnected…) simply none here.
      ui.display.text($('terminal-empty'), alive ? 'terminal.notStarted' : s.state === 'ended' ? 'terminal.endedEmpty' : 'terminal.noScreen');
      if (terminalVisible && alive && (mode === 'terminal' || s.terminalState?.alive || s.activeTurnId || s.messages.some(m => m.role === 'assistant'))) {
        // Mounting the same native display is passive; input still requires its
        // own focus/control claim. Never steal focus when the snapshot arrives.
        ensureTerminal(s.id).catch(error => { if (mode === 'terminal') toastError(error); });
      }
    }
    if (inRoom) {
      const run = state.room.run;
      const people = members();
      const tabs = $('room-member-tabs');
      const tabSignature = JSON.stringify(people.map(m => [m.id, m.name]));
      if (tabs.dataset.signature !== tabSignature) {
        tabs.replaceChildren(...people.map(m => {
          const label = `${m.name} · ${sessionShortId(m.id)}`;
          const tab = button(label, () => selectRoom(m.id)); tab.dataset.roomSession = m.id; ui.display.attribute(tab, 'title', 'room.tabHint', { label }); draggableSession(tab, m.id); return tab;
        }));
        tabs.dataset.signature = tabSignature;
      }
      $('room-record').setAttribute('aria-pressed', String(roomSurface === 'records'));
      for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.roomSession === roomSession));
      for (const tab of tabs.children) {
        const member = people.find(m => m.id === tab.dataset.roomSession);
        const count = member.nativeApproval?.requests?.length || member.approvals?.length || (member.approval || member.approvalOverflow ? 1 : 0);
        ui.display.computed(tab, 'text', () => `${member.name} · ${sessionShortId(member.id)}` + (count ? uiText('room.pendingCount', { count }) : ''));
        ui.display.attribute(tab, 'title', 'room.tabHint', { label: `${member.name} · ${sessionShortId(member.id)}` });
        tab.classList.toggle('needs-attention', Boolean(count));
      }
      const pendingRun = roomSubmitting?.automatic;
      const waiting = roomPendingRecipients.get($('recipient').value) || roomPendingRecipients.values().next().value;
      $('run-status').parentElement.hidden = !run && !roomSubmitting && !waiting;
      const active = people.filter(person => {
        const activity = person.sharedActivity;
        if (disconnected || person.transportDisconnected || !['working', 'approval'].includes(person.state) ||
          !activity || !nativeStatusFresh(activity) || activity.nativeId !== person.nativeId || activity.turnId !== person.activeTurnId) return false;
        return true;
      }).map(person => `${participantLabel(person, people)} · ${person.sharedActivity.label}`);
      const mergePending = state.room.merge && !['ready', 'undone'].includes(state.room.merge.stage);
      if (active.length || mergePending) $('run-status').parentElement.hidden = false;
      ui.display.computed($('run-status'), 'text', () => {
        const statusKey = run?.pausePending ? 'room.revoking' : run?.pauseUnconfirmed ? 'room.pauseUnconfirmed' : { running: 'room.running', paused: 'room.paused', completed: 'room.completed' }[run?.status] || 'room.runUnknown';
        let text = run ? uiText('room.replies', { status: uiText(statusKey), steps: run.steps, max: run.maxSteps, reason: run.reason ? ' · ' + ui.displayText(run.reason, run.reasonUiMessage) : '' }) : '';
        const next = state.sessions.find(member => member.id === run?.awaiting?.sessionId);
        if (run?.status === 'running' && next) text += uiText('room.awaiting', { name: next.name });
        if (pendingRun && roomSubmitting.cancelling) text = uiText('room.cancelling');
        else if (pendingRun && run?.status !== 'running') text = uiText('room.preparing');
        if (waiting && !pendingRun) text = uiText(waiting.queued ? 'room.queued' : 'room.sending', { name: waiting.recipientName });
        if (active.length) text = [text, ...active].filter(Boolean).join(' · ');
        if (mergePending) text = [text, uiText('room.mergePending')].filter(Boolean).join(' · ');
        return text;
      });
      $('pause-button').hidden = !run && !roomSubmitting;
      renderTimeline();
      const previousRecipient = $('recipient').value;
      normalizeRoomMention();
      $('recipient').dataset.hadChoices = 'true';
      populateSelect($('recipient'), members());
      $('recipient').value = roomRecipient();
      if (previousRecipient && !$('recipient').value) attempt(persistView);
      const safeHandoffs = handoffCandidates($('recipient').value).length >= 2;
      const recipient = people.find(s => s.id === $('recipient').value);
      const nativeRoute = recipient && (recipient.nativeInputRequired || recipient.shareAvailable === false || recipient.chatAvailable === false || !nativeUsable(recipient));
      $('shared-input').readOnly = false;
      $('forward-button').type = nativeRoute ? 'button' : 'submit';
      ui.display.text($('forward-button'), nativeRoute ? (nativeUsable(recipient) ? 'composer.terminal' : 'reading.viewSession') : interruptPending(recipient) ? 'composer.waitInterrupt' : recipient?.pendingQueue ? 'composer.waitNative' : roomQueueAvailable(recipient) ? 'composer.queue' : roomSteerAvailable(recipient) ? 'composer.steer' : 'composer.send');
      const recipientPending = roomPendingRecipients.has(recipient?.id);
      const mergeBlocked = state.room.merge && (!state.room.merge.imported || ['preparing', 'joining', 'failed', 'undoing'].includes(state.room.merge.stage));
      const unavailable = mergeBlocked || roomSubmitting || recipientPending || disconnected || !nativeWorkspaceMentions.body(roomMention, $('shared-input').value).trim();
      const threadUnsupported = roomReplyTo && (!roomThreads.rows.has(roomReplyTo) || (recipient && !recipient.legacyShare && !recipient.serviceCapabilities?.includes('replyThreads')));
      const ready = s => s && !interruptPending(s) && s.state === 'idle' && !s.nativeInputRequired && !s.pendingTag && !s.pendingQueue && !s.approval && s.shareAvailable !== false && s.chatAvailable !== false;
      const manualErrorReady = !interruptPending(recipient) && recipient?.state === 'error' && recipient.failedTurnInputAvailable && !recipient.pendingTag && !recipient.pendingQueue && !recipient.approval;
      $('forward-button').disabled = nativeRoute ? mergeBlocked || roomSubmitting || recipientPending || disconnected : unavailable || (!ready(recipient) && !manualErrorReady && !roomQueueAvailable(recipient) && !roomSteerAvailable(recipient)) || Boolean(threadUnsupported);
      const otherRun = allSpaces().find(r => r.id !== spaceId && r.run?.status === 'running');
      $('run-button').disabled = unavailable || roomPendingRecipients.size > 0 || !recipient || !ready(recipient) || run?.status === 'running' || run?.pausePending || run?.pauseUnconfirmed || !safeHandoffs || Boolean(threadUnsupported) || Boolean(otherRun);
      ui.display.computed($('run-help'), 'text', () => {
        let text = recipient ? uiText('room.sendHint', { name: participantLabel(recipient) }) : uiText(roomMention?.active === false ? 'room.recipientChanged' : 'room.chooseRecipientHelp');
        if (roomQueueAvailable(recipient) || recipient?.pendingQueue) text += uiText('room.queueHelp');
        if (roomSteerAvailable(recipient)) text += uiText('room.steerHelp');
        if (manualErrorReady) text += uiText('room.failedHelp');
        if (recipient?.legacyShare && !recipient.legacySharedReply) text += uiText('room.legacyReplyHelp');
        if (nativeRoute) text = uiText(recipient?.nativeInputRequired ? 'room.nativeInputRequired' : 'room.nativeRouteHelp');
        if (interruptPending(recipient)) text = uiText('composer.interruptHint');
        if (threadUnsupported) text = uiText(roomThreads.rows.has(roomReplyTo) ? 'room.threadUnsupported' : 'room.threadMissingHelp');
        return text;
      });
      ui.display.computed($('run-button'), 'title', () => otherRun ? uiText('room.otherReview', { name: otherRun.name }) : safeHandoffs ? uiText('room.runPreviewHelp') : state.handoffNotice ? ui.displayText(state.handoffNotice, state.handoffNoticeUiMessage) : uiText('room.runUnsupported'));
      ui.display.text($('pause-button'), run?.pauseUnconfirmed ? 'room.recheckPause' : pendingRun && run?.status !== 'running' ? 'room.cancelWait' : 'room.pauseHandoffs');
      $('pause-button').disabled = Boolean(roomSubmitting?.cancelling) || Boolean(run?.pausePending) || (!pendingRun && run?.status !== 'running' && !run?.pauseUnconfirmed);
      if (!$('mention-list').hidden && mentionRoster !== mentionRosterKey()) showMentions();
      renderRoomOverview();
    }
    for (const [id, entry] of terminals) entry.term.options.disableStdin = !(terminalCanInput(id) || canCaptureTerminal(id) || canFlushComposition(id));
    const approvalTarget = sharedSurface() ? (s?.nativeApproval || s?.approval || s?.state === 'approval' ? s : members().find(person => person.id === roomRecipient())) : s;
    const approvalParent = sharedSurface() ? $('room-record-view') : $('conversation-pane');
    if ($('approval').parentElement !== approvalParent) approvalParent.prepend($('approval'));
    renderApproval(approvalTarget, approvalTarget?.owner === owner);
    renderRename(); updateSelectedSharing();
    if (removedRoomFocus) focusRemainingMember(removedRoomFocus.origin, removedRoomFocus.index);
  } finally { restoreVisibleReading(); rendering = false; }
}
async function switchMode(next, takeControl = false) {
  captureReadingViews();
  const s = current(); if (!s) return;
  if (next === 'terminal' && terminalLayout === 'hidden' || next === 'chat' && terminalLayout === 'maximized') terminalLayout = 'split';
  const revision = ++selectionRevision;
  const entry = terminals.get(s.id);
  cancelViewInput(entry);
  if (entry?.composing) entry.term.blur();
  const ending = entry?.composition;
  const stillSelected = () => revision === selectionRevision && activeSessionId() === s.id;
  let queued, delivered = false;
  if (next === 'terminal' && !ending && entry?.ready && currentTerminalDisplay(entry, s) && s.owner === owner) {
    queued = { revision, owner: s.owner, text: '' };
    queued.done = new Promise((resolve, reject) => { queued.resolve = resolve; queued.reject = reject; });
    queued.done.catch(() => {});
    entry.viewInput = queued; mode = 'terminal'; render(); focusTerminal(s.id);
  }
  if (next === 'terminal' && ending && s.view === 'terminal' && s.owner === owner) { mode = 'terminal'; render(); focusTerminal(s.id); }
  // Editing a GUI draft needs no native control change. Offer its focus now,
  // while the native view acknowledgement or origin composition finishes.
  if (next === 'chat') {
    pendingMode = { id: s.id, revision }; mode = 'chat'; render();
    if (inputFocusAllowed()) chatInput().focus();
  }
  // Save the surface already shown to the person before waiting for native
  // control. Closing now must reopen this view; input remains separately gated.
  if (mode === next) { preference = next; attempt(persistView); }
  try {
    if (ending) await ending.done;
    if (!stillSelected()) return;
    if ((takeControl || s.owner === owner) && !await claimView(s.id, next, revision, takeControl)) return;
    if (!stillSelected()) return;
    if (queued && (terminals.get(s.id) !== entry || entry.generation !== (state.sessions.find(x => x.id === s.id)?.connectionRevision || 0) || !terminalCanInput(s.id))) { render(); focusTerminal(s.id); return; }
    if (queued && entry.viewInput === queued) {
      const text = queued.text;
      entry.viewInput = null;
      try { if (text) await api.input(s.id, text); queued.resolve(); delivered = true; }
      catch (error) { queued.reject(error); if (text) entry.preserveUnconfirmed(text, error); throw error; }
    }
    if (!stillSelected()) return;
    mode = next; preference = next; clearFailedTerminal(s.id); render(); await persistView();
    if (!stillSelected()) return;
    if (next === 'terminal') { await ensureTerminal(s.id, true); if (stillSelected()) focusTerminal(s.id); }
    else if (inputFocusAllowed()) chatInput().focus();
  } finally {
    if (queued && entry.viewInput === queued) cancelViewInput(entry);
    if (queued && !delivered) releaseHeldTerminal(s.id, entry);
    if (pendingMode?.revision === revision) { pendingMode = undefined; render(); }
  }
}
async function ensureTerminal(id, explicit = false) {
  const record = state.sessions.find(s => s.id === id);
  // Recovery can announce its new generation before the runtime is installed.
  // Wait for its runtime, while preserving an already-live native display.
  if (record?.recovering && !record.terminalAvailable && !record.terminalState?.alive) return;
  const generation = record?.connectionRevision || 0;
  const old = terminals.get(id);
  if (old && (old.generation !== generation || old.nativeId !== record?.nativeId)) { old.term.dispose(); old.element.remove(); terminals.delete(id); cancelViewInput(old, uiError("error.nativeConnectionChanged")); }
  if (old?.waitingForFirstTurn && terminals.get(id) === old &&
      (record?.activeTurnId && record.activeTurnId !== old.firstTurnAttemptId || record?.messages.some(message => message.role === 'assistant') && !old.firstTurnHadOutput)) {
    // A first-message instruction never launched a display. Once that same
    // native thread has real output, the visible pane can attach without a seed.
    old.term.dispose(); old.element.remove(); terminals.delete(id);
  }
  // A repaint never restarts a native display. Only an explicit view action can
  // replace its cached screen, after the backend reports the display lifetime.
  if (explicit && old?.ready && terminals.get(id) === old && !currentTerminalDisplay(old, record)) {
    if (record.owner !== owner || record.backendUnavailable || record.transportDisconnected || disconnected) throw uiError("error.sessionControl");
    if (record.terminalState?.alive === false && !record.terminalState.exitConfirmed) throw uiError("error.oldTerminalPending");
    cancelViewInput(old); old.term.dispose(); old.element.remove(); terminals.delete(id);
  }
  if (!explicit && !terminals.has(id) && record?.terminalState?.alive === false) return;
  if (terminals.has(id)) { const existing = terminals.get(id); syncTerminalMount(id); if (existing.ready) fitTerminal(id); return existing.pending; }
  const element = node('div', undefined, 'terminal-host'); element.dataset.terminalId = id; $('terminal-area').append(element);
  if (activeSessionId() === id) $('terminal-empty').hidden = true;
  const theme = terminalThemes[terminalDisplay.palette];
  $('terminal-area').style.backgroundColor = theme.background;
  const loading = uiNode('p', 'terminal.connecting', undefined, 'terminal-loading'); loading.setAttribute('role', 'status');
  const surface = node('div', undefined, 'terminal-surface'); surface.hidden = true; surface.inert = true; element.append(loading, surface);
  // Option-drag selects text even when the program takes the mouse. Option-click must not
  // move the cursor: xterm would type arrow keys into the native program and clear the selection.
  const term = new Terminal({ fontFamily: '"MesloLGS NF", Menlo, Monaco, monospace', fontSize: terminalDisplay.fontSize, lineHeight: 1, cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionClickForcesSelection: true, altClickMovesCursor: false, disableStdin: true, theme: { ...theme } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(surface);
  // Fullscreen Claude turns on mouse reporting, so xterm hands a drag to the program. A view
  // that cannot send input (another window's session, a space member column) would drop
  // that drag, so it selects locally instead. A view that can send input, or is switching to
  // it on this press, still forwards the drag; the program selects and copies as in iTerm2.
  // A view rebuilt from an older backend's snapshot can track the mouse without SGR. xterm sends
  // those legacy reports through onBinary, which NAW never forwards (and Claude ignores them), so
  // that view also selects locally rather than dropping the drag.
  const selection = term._core?._selectionService, mouse = term._core?.coreMouseService;
  if (typeof selection?.shouldForceSelection === 'function') {
    const nativeForce = selection.shouldForceSelection.bind(selection);
    selection.shouldForceSelection = event => (!terminalCanInput(id) && !canCaptureTerminal(id)) || mouse?.activeEncoding === 'DEFAULT' || nativeForce(event);
  }
  const intent = selectionRevision;
  const entry = { element, term, fit, generation, nativeId: record?.nativeId, ready: false, sequence: 0, queued: [], firstTurnAttemptId: record?.activeTurnId, firstTurnHadOutput: record?.messages.some(message => message.role === 'assistant') }; terminals.set(id, entry); syncTerminalMount(id);
  term.onSelectionChange(() => nativeSelectionChanged(id, term));
  let recovery = inputRecoveries.get(id);
  if (!recovery) {
    const panel = node('div', undefined, 'terminal-input-recovery'); panel.hidden = true;
    const text = node('textarea'); text.readOnly = true; ui.display.attribute(text, 'aria-label', 'terminal.unconfirmedInput');
    panel.append(uiNode('strong', 'terminal.inputUnconfirmed'), uiNode('p', 'terminal.inputUnconfirmedHelp'), text,
    uiButton('common.copy', () => api.copy(text.value)), uiButton('terminal.closeNotice', () => { panel.hidden = true; text.value = ''; render(); focusTerminal(id); }));
    recovery = { panel, text }; inputRecoveries.set(id, recovery);
  }
  element.append(recovery.panel);
  const preserveUnconfirmed = entry.preserveUnconfirmed = (text, error) => {
    recovery.text.value += text; recovery.panel.hidden = false; render();
    toastMessage("toast.nativeInputRetained", () => ({ arg1: state.sessions.find(s => s.id === id)?.name || uiText('terminal.originalSession'), arg2: error.message ? ui.errorText(error) : uiText('terminal.inputUnknown') }));
  };
  const claimTerminalFocus = () => {
    const binding = columnTerminalBinding(id);
    if (binding) return;
    if (mode !== 'terminal' && activeSessionId() === id && state.sessions.find(s => s.id === id)?.owner === owner && inputFocusAllowed()) attempt(() => switchMode('terminal'));
  };
  surface.addEventListener('pointerdown', event => { if (event.button === 0) claimTerminalFocus(); }, true);
  surface.addEventListener('focusin', claimTerminalFocus);
  surface.addEventListener('wheel', event => {
    // Keep horizontal reading of an oversized native frame local. xterm's
    // mouse-mode wheel listener otherwise prevents the browser's default scroll.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && surface.scrollWidth > surface.clientWidth) { event.stopPropagation(); return; }
    // These paths scroll inside the native program. Prepare the same guarded
    // view as a click; ordinary local scrollback needs no native input/control.
    if (event.deltaY && (['vt200', 'drag', 'any'].includes(term.modes.mouseTrackingMode) || term.buffer.active.type === 'alternate')) {
      // Another window owns this native grid. Read its oversized frame locally;
      // xterm would otherwise consume the wheel even with native input disabled.
      if (state?.sessions.find(s => s.id === id)?.owner !== owner && surface.scrollHeight > surface.clientHeight) { event.stopPropagation(); return; }
      claimTerminalFocus();
    }
  }, { capture: true, passive: true });
  bindImageInput(surface, id);
  surface.addEventListener('paste', event => { if (imageFiles(event.clipboardData).length) return; event.preventDefault(); event.stopPropagation(); attempt(() => { pasteTerminal(event.clipboardData?.getData('text/plain') || '', id); }); }, true);
  term.onData(data => {
    // The service's canonical terminal answers device queries, once. Focus
    // reports belong to this observing view, not to the native input stream:
    // changing tabs or windows must not impersonate a human intervention.
    if (/^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\[[IO]$/.test(data) || /^\x1b\]/.test(data)) return;
    const token = entry.composition;
    if (token?.cancelled) return;
    if (entry.viewInput && !canCaptureTerminal(id)) {
      const error = uiError("error.inputSwitchExpired");
      cancelViewInput(entry, error); preserveUnconfirmed(data, error);
      if (token) { token.consumed = true; token.input = Promise.reject(error); token.input.catch(() => {}); }
      return;
    }
    if (canCaptureTerminal(id)) {
      const pending = entry.viewInput;
      if (pending.text.length + data.length > 65536) { cancelViewInput(entry, uiError("error.bufferTooLong")); preserveUnconfirmed(data, uiError("error.inputNotSent")); render(); return; }
      pending.text += data;
      if (token && !token.consumed) { token.consumed = true; token.input = pending.done; }
      return;
    }
    const finishing = canFlushComposition(id, token);
    if (terminals.get(id) !== entry || (!terminalCanInput(id) && !finishing)) return;
    if (finishing) token.consumed = true;
    const input = api.input(id, data);
    if (finishing) token.input = input;
    input.catch(error => { if (finishing) preserveUnconfirmed(data, error); else toastError(error.message ? error : uiError('error.nativeInputUnconfirmed')); });
  });
  let confirmingEnter = false, blurValue, compositionSequence = 0;
  element.addEventListener('compositionstart', () => { entry.composing = true; compositionSequence++; entry.compositionIntent = entry.viewInput; entry.compositionOrigin = { cancelled: false }; }, true);
  element.addEventListener('compositionend', event => {
    entry.composing = false;
    // Bubble after xterm's target listener: its textarea commit timer must run
    // before this barrier. Microtasks can run between native event listeners.
    const token = { sequence: compositionSequence, consumed: false, text: event.data, cancelled: Boolean(entry.compositionIntent?.cancelled || entry.compositionOrigin?.cancelled) };
    token.done = new Promise((resolve, reject) => setTimeout(async () => {
      try {
        if (!token.consumed && token.text) {
          const error = uiError("error.inputNotSentCheck");
          preserveUnconfirmed(token.text, error); throw error;
        }
        await token.input; resolve();
      } catch (error) { reject(error); }
      finally { if (entry.composition === token) { entry.composition = null; render(); if (entry.fitPending) { entry.fitPending = false; fitTerminal(id); } } }
    }, 0));
    token.done.catch(() => {}); // Navigation may not be awaiting this origin.
    entry.composition = token;
  });
  element.addEventListener('blur', () => {
    confirmingEnter = false;
    // A column can be reordered/parked after its header receives focus, before
    // the layout callback runs. Cancel at the origin blur, ahead of xterm's
    // deferred commit, so that navigation retains this text without writing it.
    if (columnTerminalBinding(id) && (entry.composing || entry.composition && !entry.composition.consumed)) {
      cancelColumnComposition(entry);
    }
    blurValue = entry.composition && !entry.composing ? term.textarea.value : undefined;
  }, true);
  term.textarea.addEventListener('blur', () => {
    // Registered after xterm's blur listener, which clears the textarea before
    // its deferred composition commit. Preserve only that already-ended commit.
    if (blurValue === undefined || !entry.composition || entry.composing || terminals.get(id) !== entry) return;
    const textarea = term.textarea, value = blurValue, token = entry.composition;
    blurValue = undefined;
    if (!textarea.value) textarea.value = value;
    token.done.then(() => {
      if (compositionSequence === token.sequence && document.activeElement !== textarea && textarea.value === value && !entry.composing) textarea.value = '';
    }, () => {});
  });
  term.attachCustomKeyEventHandler(event => {
    // The same Enter may reach keypress after compositionend. Ignore that key's
    // terminal encoding, but leave browser defaults intact so IME can commit.
    if (event.key === 'Enter') {
      if (event.type === 'keydown' && !event.repeat) confirmingEnter = entry.composing || event.isComposing;
      const confirming = confirmingEnter || event.isComposing;
      if (event.type === 'keyup') confirmingEnter = false;
      if (confirming) return false;
    }
    // xterm 6 loses Shift+Enter and cannot encode Ctrl+/ or Ctrl+Shift+letters.
    // Preserve those native Codex bindings with standard CSI-u through xterm's
    // normal input path, after the composition-confirmation barrier above.
    let extendedKey, nativeKey;
    const composing = entry.composing || event.isComposing;
    if (record.provider === 'codex' && !composing && !event.metaKey && event.ctrlKey && event.altKey && !event.shiftKey && /^[a-z]$/i.test(event.key)) {
      nativeKey = '\x1b' + String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96);
    }
    const enhanced = !composing && (entry.keyboardFlags & 1) && !event.altKey && !event.metaKey;
    if (record.provider === 'codex' && enhanced) {
      if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey)) extendedKey = 13;
      else if (event.ctrlKey && event.key === '/') extendedKey = 47;
      else if (event.ctrlKey && event.shiftKey && /^[a-z]$/i.test(event.key)) extendedKey = event.key.toLowerCase().charCodeAt(0);
    }
    // Claude 2.1.310 also pushes CSI-u and reads Shift+Enter (13;2u) as a newline; a plain CR submits.
    else if (record.provider === 'claude' && enhanced && event.key === 'Enter' && event.shiftKey && !event.ctrlKey) extendedKey = 13;
    // Claude asks for CSI-u only in terminals it recognises. Elsewhere its own
    // /terminal-setup binds Shift+Enter to ESC CR, which it reads as a newline.
    else if (record.provider === 'claude' && !composing && !(entry.keyboardFlags & 1) && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) nativeKey = '\x1b\r';
    if (extendedKey !== undefined) nativeKey = `\x1b[${extendedKey};${1 + (event.shiftKey ? 1 : 0) + (event.ctrlKey ? 4 : 0)}u`;
    if (nativeKey !== undefined) {
      event.preventDefault();
      if (event.type === 'keydown') term.input(nativeKey, true);
      return false;
    }
    if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { event.preventDefault(); attempt(() => api.copy(term.getSelection())); return false; }
    return true;
  });
  entry.pending = (async () => {
    try {
      const snapshot = await api.terminalSnapshot(id);
      if (terminals.get(id) !== entry) return;
      let live = state.sessions.find(s => s.id === id)?.terminalState;
      // A new display snapshot can precede the batched state notification.
      // Confirm the current display before enabling input or moving focus.
      if (snapshot.epoch && live && (!live.alive || snapshot.epoch !== live.epoch)) {
        updateState(await api.initial());
        if (terminals.get(id) !== entry) return;
        live = state.sessions.find(s => s.id === id)?.terminalState;
      }
      if (snapshot.epoch && live?.epoch && snapshot.epoch !== live.epoch) throw uiError("error.terminalViewChanged");
      entry.epoch = snapshot.epoch;
      term.resize(snapshot.cols || 100, snapshot.rows || 30);
      if (snapshot.cursorModesVersion === 1) term.options.cursorBlink = false;
      await new Promise(resolve => term.write(snapshot.buffer, resolve));
      entry.keyboardFlags = snapshot.keyboardFlags || 0;
      if (terminals.get(id) !== entry) return;
      entry.observationIndex = Number.isSafeInteger(snapshot.observationIndex) && snapshot.observationIndex >= 0 && Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 0 && typeof snapshot.epoch === 'string' && snapshot.epoch ? snapshot.observationIndex : undefined;
      entry.sequence = snapshot.sequence; entry.ready = true;
      for (const event of entry.queued) writeTerminal(entry, event);
      entry.queued = []; loading.remove(); surface.hidden = false; surface.inert = false;
      render(); if (!columnTerminalBinding(id)) { fitTerminal(id); if (intent === selectionRevision) focusTerminal(id); } else revealTerminalCursor(entry);
    } catch (error) {
      if (terminals.get(id) === entry) {
        entry.failed = true; entry.ready = false; entry.queued = []; entry.pending = Promise.resolve();
        // Only this known local instruction may replace the generic failure.
        // Never persist a raw native error (which can contain private paths).
        const firstMessage = '请先在对话中发送第一条消息，再打开同一会话的原生终端。';
        entry.waitingForFirstTurn = Boolean(error.message?.includes(firstMessage));
        ui.display.text(loading, entry.waitingForFirstTurn ? 'terminal.firstMessage' : 'terminal.connectFailed');
        throw error;
      }
    }
  })();
  return entry.pending;
}
function fitTerminal(id) {
  const entry = terminals.get(id); const s = state.sessions.find(s => s.id === id);
  if (!entry?.ready) return;
  if (s?.owner !== owner) { entry.nativeSize = undefined; return; }
  const column = columnTerminalBinding(id);
  if (column ? !column.resizeAllowed : activeSessionId() !== id || terminalLayout === 'hidden') return;
  if (entry.composing || entry.composition) { entry.fitPending = true; return; }
  if (entry.fitScheduled) return;
  entry.fitScheduled = true;
  requestAnimationFrame(() => {
    entry.fitScheduled = false;
    const latest = state.sessions.find(s => s.id === id);
    const binding = columnTerminalBinding(id);
    if (terminals.get(id) !== entry || (column ? binding !== column || !column.resizeAllowed : activeSessionId() !== id || terminalLayout === 'hidden') || !entry.element.isConnected || !entry.element.checkVisibility() || latest?.owner !== owner) return;
    if (entry.composing || entry.composition) { entry.fitPending = true; return; }
    const dimensions = entry.fit.proposeDimensions();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
    // Keep the display and native PTY on the same bounded grid. An undersized
    // pane reads that original grid through the surface's local overflow.
    if (column) column.resizeAllowed = false;
    entry.term.resize(Math.max(20, Math.min(400, dimensions.cols)), Math.max(5, Math.min(200, dimensions.rows)));
    revealTerminalCursor(entry);
    const size = JSON.stringify([entry.term.cols, entry.term.rows]);
    if (entry.nativeSize === size) return;
    entry.nativeSize = size;
    attempt(async () => {
      try { await api.resize(id, entry.term.cols, entry.term.rows); }
      catch (error) { if (entry.nativeSize === size) entry.nativeSize = undefined; throw error; }
    });
  });
}
// Follow the producer's journal order, including resizes with no new output.
// Keep legacy payloads; an unindexed event withdraws the optional ordering hint.
function writeTerminal(entry, event) { const indexed = Number.isSafeInteger(entry.observationIndex) && entry.observationIndex >= 0; if (indexed) { if (event.epoch !== entry.epoch || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return; if (!(event.index === undefined && event.kind !== 'resize' && typeof event.data === 'string' && event.sequence > entry.sequence)) { if (!Number.isSafeInteger(event.index) || event.index <= entry.observationIndex) return; if (event.kind === 'resize') { if (event.sequence < entry.sequence || !Number.isInteger(event.cols) || event.cols < 20 || event.cols > 400 || !Number.isInteger(event.rows) || event.rows < 5 || event.rows > 200 || terminals.get(event.id) !== entry) return; entry.observationIndex = event.index; entry.term.write('', () => { if (terminals.get(event.id) === entry && event.epoch === entry.epoch) entry.term.resize(event.cols, event.rows); }); return; } if (typeof event.data !== 'string' || event.sequence <= entry.sequence) return; } } if ((!entry.epoch || event.epoch === entry.epoch) && event.sequence > entry.sequence) { entry.term.write(event.data, () => { if (document.activeElement === entry.term.textarea) revealTerminalCursor(entry); }); entry.keyboardFlags = event.keyboardFlags || 0; entry.sequence = event.sequence; if (indexed) entry.observationIndex = event.index; } }
const disposers = [
  api.onProgress(updateLegacyProgress),
  api.onTerminal(event => { const entry = terminals.get(event.id); if (!entry || entry.failed) return; if (!entry.ready) entry.queued.push(event); else writeTerminal(entry, event); }),
  api.onState(next => { updateState(next); render(); }),
  api.onSessionName(({ id, name }) => {
    const record = state?.sessions.find(s => s.id === id);
    if (record) { record.name = name; render(); }
  }),
  api.onDisconnected((message, uiMessage) => { disconnected = true; for (const s of state?.sessions || []) freezeLegacyProgress(s); render(); toastError({ message, uiMessage }); }),
  api.onViewStorage((warning, uiMessage) => { latestViewStorage = warning; latestViewStorageUiMessage = uiMessage; if (state) { state.viewStorageWarning = warning; state.viewStorageWarningUiMessage = uiMessage; render(); } }),
  api.onReconnected(next => { for (const s of state?.sessions || []) freezeLegacyProgress(s); disconnected = false; updateState(next); render(); }),
  api.onBackendSwitched(notice => { toast(''); ui.display.computed($('toast-text'), 'text', () => backendSwitchedText(notice)); }),
  api.onNew(() => openCreate()),
];
sidebarLayout = window.nativeWorkspaceSidebar.bind({ navigation: document.querySelector('.sidebar-navigation'), groups: ['sessions-group', 'workspace-group', 'archive-group'].map($), sashes: ['sidebar-session-sash', 'sidebar-workspace-sash'].map($), onCommit: weights => api.sidebar({ type: 'resize', weights }), displayTitle: (element, params) => ui.display.attribute(element, 'title', 'sidebar.resizeHelp', params), onError: toastError });
disposers.push(() => sidebarLayout.dispose());
// A drag resizes the native terminal once, on release, not on every move.
const observer = new ResizeObserver(() => { if (activeSessionId() && !splitDragging) fitTerminal(activeSessionId()); }); observer.observe($('terminal-area'));
function applySplit() {
  for (const id of ['session-layout', 'room-layout']) $(id).style.setProperty('--split-left', `${(terminalSplit * 100).toFixed(2)}%`);
  for (const divider of document.querySelectorAll('.split-divider')) { divider.setAttribute('aria-valuenow', String(Math.round(terminalSplit * 100))); divider.setAttribute('aria-valuemin', '20'); divider.setAttribute('aria-valuemax', '80'); }
}
const SPLIT_SNAP_PX = 16;
function setSplit(x, width) { terminalSplit = Math.abs(x - width / 2) <= SPLIT_SNAP_PX ? 0.5 : Math.min(0.8, Math.max(0.2, x / width)); applySplit(); }
for (const divider of document.querySelectorAll('.split-divider')) {
  divider.addEventListener('pointerdown', event => {
    const box = divider.parentElement.getBoundingClientRect();
    event.preventDefault(); divider.setPointerCapture(event.pointerId); splitDragging = true;
    const move = e => setSplit(e.clientX - box.left, box.width);
    const end = () => { divider.removeEventListener('pointermove', move); splitDragging = false; fitTerminal(activeSessionId()); attempt(persistView); };
    divider.addEventListener('pointermove', move); divider.addEventListener('lostpointercapture', end, { once: true });
  });
  divider.addEventListener('dblclick', () => { terminalSplit = 0.5; applySplit(); attempt(persistView); });
  divider.addEventListener('keydown', event => {
    const step = { ArrowLeft: -0.02, ArrowRight: 0.02 }[event.key];
    if (step === undefined && event.key !== 'Home') return;
    // Keys step without the drag snap, which would undo a 2% step on a narrow window.
    event.preventDefault();
    terminalSplit = event.key === 'Home' ? 0.5 : Math.min(0.8, Math.max(0.2, Math.round((terminalSplit + step) * 100) / 100)); applySplit();
    attempt(persistView);
  });
}
$('new-session').onclick = () => openCreate(); $('start-claude').onclick = () => openCreate('claude'); $('start-codex').onclick = () => openCreate('codex');
$('cancel-create').onclick = () => $('create-dialog').close();
$('cancel-rename').onclick = () => closeRename();
$('rename-name').oninput = () => { renameRevision++; $('rename-error').hidden = true; };
$('rename-name').addEventListener('compositionstart', () => { renameComposing = true; });
$('rename-name').addEventListener('compositionend', () => { renameComposing = false; });
$('rename-name').onkeydown = event => {
  if (event.key === 'Enter' && (renameComposing || event.isComposing || event.keyCode === 229 || renaming)) event.preventDefault();
};
$('rename-editor').onkeydown = event => {
  if (event.key !== 'Escape' || renameComposing || event.isComposing || event.keyCode === 229) return;
  event.preventDefault(); if (!renaming) closeRename();
};
$('rename-form').onsubmit = async event => {
  event.preventDefault(); const target = renameTarget; if (!target || renaming || renameComposing) return;
  const problem = renameProblem(target); if (problem) return showRenameError(problem, 'state');
  const hadEditorFocus = $('rename-editor').contains(document.activeElement);
  const mayRestoreFocus = () => hadEditorFocus && (document.activeElement === document.body || $('rename-editor').contains(document.activeElement));
  renaming = true; renderRename();
  try {
    await (target.id === 'room' ? api.spaceAction(target.roomId, 'rename', [$('rename-name').value]) : api.rename(target.id, $('rename-name').value));
    if (renameTarget !== target) return;
    const returnFocus = mayRestoreFocus(); renaming = false; closeRename(returnFocus); toastMessage("toast.nameSaved");
  } catch (error) { if (renameTarget === target) { showRenameError(error.message ? error : uiError('error.renameSave')); if (mayRestoreFocus()) $('rename-name').focus({ preventScroll: true }); } }
  finally { renaming = false; if (renameTarget === target) renderRename(); }
};
$('choose-folder').onclick = () => attempt(async () => { const ticket = dialogTickets.get($('create-dialog')); const value = await api.chooseFolder(); if (value && currentDialogTicket(ticket)) { folder = value; newDirectory = false; invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder; if ($('git-worktree').checked) await refreshGitPreview(); else createReadiness(); } });
$('git-worktree').onchange = () => { invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder; if ($('git-worktree').checked) refreshGitPreview(); else createReadiness(); };
$('git-worktree-relative').oninput = scheduleGitPreview;
$('new-folder').onclick = () => { if (!creatingSession) { resetCreateDirectory(); createReadiness(); } };
$('create-form').onsubmit = event => { event.preventDefault();
  const ticket = dialogTickets.get($('create-dialog')), revision = selectionRevision;
  if (creatingSession || !currentDialogTicket(ticket)) return;
  if (ticket.created) return; // T-115: this opening already created its session
  if (ticket.creation) { attempt(() => finishCreateSpace(ticket, revision)); return; }
  if (document.querySelector('input[name="provider"]:checked').value === 'claude' && $('claude-history-id').value.trim()) { $('open-native-history').click(); return; }
  let choice; // T-115: an invalid space choice creates nothing, and its reason stays in the dialog
  try { choice = createSpaceChoice(); } catch (error) { ui.showError($('create-error'), error); return; }
  attempt(async () => {
  const worktree = $('git-worktree').checked ? gitWorktreePlan : null;
  if ($('git-worktree').checked && (!worktree || newDirectory || gitPreviewLoading || !state.capabilities?.includes('gitWorktreeV1'))) throw uiError("error.gitPreviewRequired");
  creatingSession = true; ui.display.unbind($('create-error')); $('create-error').textContent = ''; createReadiness();
  const submittedFolder = worktree?.cwd || folder, priorIds = new Set(state.sessions.map(s => s.id));
  let createdId = ''; // T-115: once the service returns the new session's id, a later failed read can't lose it
  try { const provider = document.querySelector('input[name="provider"]:checked').value, view = provider === 'codex' ? $('initial-view').value : preference; preference = view; const id = createdId = await api.create({ provider, cwd: worktree?.source || folder, name: $('session-name').value, view, ...(worktree ? { gitWorktree: worktree } : newDirectory ? { newDirectory: true } : {}), skipPermissions: $('skip-permissions').checked || undefined }); updateState(await api.initial()); render();
    if (choice.kind !== 'independent') { ticket.creation = { choice, sessionId: id, view, roomId: choice.roomId || '' }; creatingSession = false; await finishCreateSpace(ticket, revision); return; }
    // I160: the session exists from here on, so this opening creates no other, even if it stays open (the selection moved).
    ticket.created = id;
    if (currentDialogTicket(ticket) && revision === selectionRevision) { $('create-dialog').close(); await select(id, view); } else toastMessage("toast.createdSessionRetained"); }
  catch (error) {
    let reread = true; try { updateState(await api.initial()); render(); } catch { reread = false; }
    const created = createdId ? state.sessions.find(s => s.id === createdId) : state.sessions.find(s => s.cwd === submittedFolder && !priorIds.has(s.id));
    // T-115: a session kept despite the error still gets the chosen space. A returned id is used as is; without one,
    // only exactly one new session at this path is adopted. 仅继续加入 then joins it instead of starting another session.
    const keptId = createdId || (created && state.sessions.filter(s => s.cwd === submittedFolder && !priorIds.has(s.id)).length === 1 ? created.id : '');
    // A session whose start failed (state error) is never adopted, with or without a space: the dialog stays retryable in a
    // new folder and the failed record stays out of the space (branch table E2 F9, the same rule as E1 F9).
    const usable = Boolean(createdId) || created?.state !== 'error';
    if (choice.kind !== 'independent' && keptId && usable) ticket.creation = { choice, sessionId: keptId, view: preference, roomId: choice.roomId || '' };
    // An independent session that exists stops this dialog: by its returned id, or (I160) found again without one, unless
    // its start failed (state error), which stays retryable in a new folder as before.
    else if (keptId && usable) ticket.created = keptId;
    // Without an id and without a fresh read, nobody can tell whether the session exists: ask for a look, don't invite a retry.
    const unknown = !createdId && !reread;
    // I159: cases where a session may exist without an id, so this dialog stops (ticket.created = 'unconfirmed'):
    // a chosen existing folder, which other sessions may share, or a Git copy, whose retry needs a new preview at a new
    // path, so neither can be told apart from a failure and a retry could add a second; and a retry after an unknown
    // result in the automatic folder that finds its own new folder already there (已存在), made by the first attempt.
    const ownFolderTaken = !createdId && ticket.unsurePath === submittedFolder && /已存在/u.test(error.message || '');
    const sharedFolder = unknown && !newDirectory;
    if (!ticket.creation && !ticket.created && (ownFolderTaken || sharedFolder)) ticket.created = 'unconfirmed';
    if (unknown && newDirectory) ticket.unsurePath = submittedFolder;
    const kept = () => created ? uiText('create.keptNamedId', { name: created.name, id: sessionShortId(created.id) }) : createdId ? uiText('create.keptId', { id: sessionShortId(createdId) })
      : ownFolderTaken ? uiText('create.folderTakenKept') : sharedFolder ? uiText('create.sharedFolderUnknown') : unknown ? uiText('create.creationUnknown') : '';
    // A space was chosen but no session can be named: the space can still be joined later from the session menu.
    const spaceLater = ticket.created === 'unconfirmed' && choice.kind !== 'independent';
    const join = !ticket.creation ? null : currentDialogTicket(ticket) ? 'create.joinRetryKept' : 'create.joinLaterKept';
    // Stopped at its own folder, the service's 已存在 advice (use another folder) would contradict the locked form (I160).
    const message = () => kept() + (ownFolderTaken ? '' : ui.errorText(error)) + (join ? uiText(join) : '') + (spaceLater ? uiText('create.spaceLater') : '');
    if (currentDialogTicket(ticket)) ui.display.computed($('create-error'), 'text', message);
    else { toast(''); ui.display.computed($('toast-text'), 'text', message); }
    if (worktree && currentDialogTicket(ticket) && !ticket.creation && !ticket.created) { invalidateGitPreview(); $('chosen-folder').textContent = folder; ui.display.text($('git-worktree-preview'), 'create.copyRetained'); }
    // A failed/uncertain start may already own the displayed path. Preserve
    // that record and any files; a new explicit submit gets a fresh preview.
    // A known id means the session owns this path; keeping it makes another 创建 fail as 已存在 rather than add a second one.
    if (currentDialogTicket(ticket) && newDirectory && !ticket.creation && !ticket.created && !createdId && !unknown) resetCreateDirectory();
  }
  finally { creatingSession = false; createReadiness(); }
}); };
$('new-space').onclick = openSpaceCreate;
$('close-space-merge').onclick = () => $('space-merge-dialog').close();
$('space-merge-dialog').addEventListener('close', () => {
  if ($('space-merge-dialog').open) return;
  const draft = mergeDialog; mergeDialog = null;
  if (draft?.batch && !draft.record) api.spaceMerge('discard', { operationId: draft.batch.operationId }).catch(() => {});
});
$('back-space-merge').onclick = () => {
  if (!mergeDialog?.batch) return;
  api.spaceMerge('discard', { operationId: mergeDialog.batch.operationId }).catch(() => {});
  mergeDialog.batch = null; mergeButtons(false); mergeError('');
};
$('preview-space-merge').onclick = () => attempt(async () => {
  const draft = mergeDialog, ticket = draft?.ticket;
  if (!currentDialogTicket(ticket) || $('preview-space-merge').disabled) return;
  $('preview-space-merge').disabled = true; mergeError('');
  try {
    const batch = await api.spaceMerge('preview', mergeSpec());
    if (!currentDialogTicket(ticket)) { api.spaceMerge('discard', { operationId: batch.operationId }).catch(() => {}); return; }
    draft.batch = batch; mergeButtons(true); renderMergeBatch(batch); $('confirm-space-merge').focus();
  } catch (error) { if (currentDialogTicket(ticket)) mergeError(error); else toastError(error); }
  finally { if (currentDialogTicket(ticket)) $('preview-space-merge').disabled = false; }
});
async function submitSpaceMerge(action) {
  const draft = mergeDialog, ticket = draft?.ticket, batch = draft?.batch, revision = selectionRevision;
  if (!batch || !currentDialogTicket(ticket)) return;
  const controls = ['confirm-space-merge', 'undo-space-merge', 'recover-space-merge'];
  for (const key of controls) $(key).disabled = true; mergeError('');
  try {
    // A newly typed C draft is a reason to retain C during organization undo.
    if (action === 'undo') await persistView();
    const record = await api.spaceMerge(action, { operationId: batch.operationId, binding: batch.binding });
    updateState(await api.initial()); render();
    if (!currentDialogTicket(ticket)) return toastMessage("toast.mergeRetained");
    draft.record = record; draft.targetId = batch.targetId;
    if (action === 'commit' && record.stage === 'ready' && revision === selectionRevision) {
      $('space-merge-dialog').close(); await selectSpace(batch.targetId);
      return toastMessage("toast.mergeDone", { arg1: batch.name }, { label: uiText('merge.viewDetails'), labelKey: 'merge.viewDetails', run: () => openMergeRecord(batch.targetId) });
    }
    mergeButtons(true, true); renderMergeBatch(batch, record);
  } catch (error) {
    try { updateState(await api.initial()); render(); } catch {}
    if (currentDialogTicket(ticket)) mergeError(error); else toastError(error);
  } finally { if (currentDialogTicket(ticket)) for (const key of controls) $(key).disabled = false; }
}
$('confirm-space-merge').onclick = () => attempt(() => submitSpaceMerge('commit'));
$('recover-space-merge').onclick = () => attempt(() => submitSpaceMerge('recover'));
$('undo-space-merge').onclick = () => attempt(() => submitSpaceMerge('undo'));
$('open-space-merge-target').onclick = () => attempt(async () => {
  const id = mergeDialog?.targetId || mergeDialog?.batch?.targetId;
  if (!id) return; $('space-merge-dialog').close(); await selectSpace(id);
});
$('cancel-space-create').onclick = () => $('space-create-dialog').close();
$('space-create-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  const ticket = dialogTickets.get($('space-create-dialog')); if (!currentDialogTicket(ticket) || $('confirm-space-create').disabled) return;
  $('confirm-space-create').disabled = true; $('space-create-error').hidden = true;
  try {
    const id = await api.spaceCreate($('space-create-name').value); updateState(await api.initial()); render();
    if (currentDialogTicket(ticket)) { $('space-create-dialog').close(); await selectSpace(id); }
    else toastMessage("toast.createdSpaceRetained");
  } catch (error) { if (currentDialogTicket(ticket)) { ui.showError($('space-create-error'), error); $('space-create-error').hidden = false; } else toastError(error); }
  finally { if (currentDialogTicket(ticket)) $('confirm-space-create').disabled = false; }
}); };
$('workspace-group').addEventListener('contextmenu', event => {
  if (event.defaultPrevented || event.target.closest('.room-row, #rename-editor')) return;
  event.preventDefault(); event.stopPropagation(); openSpaceRegionMenu({ x: event.clientX, y: event.clientY });
});
$('workspace-toggle').addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); event.stopPropagation(); openSpaceRegionMenu(undefined, $('workspace-toggle')); } });
for (const [id, view] of [['sessions-flat', 'flat'], ['sessions-grouped', 'grouped']]) $(id).onclick = () => { sidebarView = view; sessionMenu?.close(); render(); attempt(persistView); $(id).focus(); };
$('room-nav').onclick = () => attempt(() => selectSpace('shared'));
$('panorama-nav').onclick = () => attempt(openPanorama);
$('return-panorama').onclick = () => attempt(returnToPanorama);
$('room-more').onclick = () => openRoomMenu(undefined, $('room-more'), 'shared');
$('room-more').onpointerdown = event => { if (roomMenu) event.stopPropagation(); };
$('room-nav').oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); openRoomMenu({ x: event.clientX, y: event.clientY }, $('room-more'), 'shared'); };
$('room-nav').onkeydown = event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openRoomMenu(undefined, $('room-more'), 'shared'); } };
$('room-overview').onclick = () => attempt(() => { roomSurface = 'overview'; return selectRoom(); });
$('room-record').onclick = () => attempt(() => { roomSurface = 'records'; return selectRoom(); });
$('manage-members').onclick = () => openInvite($('manage-members'));
dropTarget($('room-nav'), true, 'shared'); dropTarget($('solo-drop'), false); dropTarget($('session-list'), false);
for (const [section, id] of [['sessions', 'solo-drop'], ['workspace', 'workspace-toggle'], ['archive', 'archive-button']]) {
  const toggle = $(id);
  const collapse = collapsed => { if (section === 'archive' && !collapsed) ui.revealSidebar(); return api.sidebar({ type: 'collapse', section, collapsed }); };
  toggle.onclick = () => attempt(() => collapse(section === 'archive' && toggle.closest('.naw')?.dataset.collapsed === 'true' ? false : toggle.getAttribute('aria-expanded') === 'true'));
  toggle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.isComposing) return;
    event.preventDefault(); attempt(() => collapse(event.key === 'ArrowLeft'));
  };
}
$('chat-tab').onclick = () => attempt(() => switchMode('chat')); $('terminal-tab').onclick = () => attempt(() => switchMode('terminal'));
$('terminal-maximize').onclick = () => attempt(async () => { terminalLayout = terminalLayout === 'maximized' ? 'split' : 'maximized'; await switchMode('terminal'); });
// The chat's own full-width toggle: hide the terminal, or bring it back beside the chat.
$('chat-maximize').onclick = () => attempt(async () => { if ($('native-pane').hidden) { terminalLayout = 'split'; await switchMode('terminal'); } else { terminalLayout = 'hidden'; await switchMode('chat'); } });
$('close-native-terminal').onclick = () => attempt(async () => {
  if (selected === 'room') return selectRoom('');
  terminalLayout = 'hidden'; await switchMode('chat');
});
for (const input of [$('shared-input')]) input.addEventListener('focus', () => {
  if (mode !== 'chat' && current() && inputFocusAllowed()) attempt(() => switchMode('chat'));
});
$('take-control').onclick = () => attempt(() => switchMode(mode, true));
$('terminal-copy').onclick = () => attempt(() => copyTerminalContext());
$('terminal-paste').onclick = () => attempt(() => pasteTerminalContext());
let terminalDisplayKey;
$('terminal-display').onclick = () => {
  if (!current() || $('native-pane').hidden) return;
  const dialog = $('terminal-display-dialog');
  terminalDisplayKey = headerMenuKey();
  $('terminal-font-size').value = terminalDisplay.fontSize; $('terminal-palette').value = terminalDisplay.palette;
  dialog.show();
};
const dismissTerminalDisplayOnFocus = event => {
  const dialog = $('terminal-display-dialog');
  if (dialog.open && !dialog.contains(event.target)) dialog.close();
};
document.addEventListener('focusin', dismissTerminalDisplayOnFocus, true);
disposers.push(() => document.removeEventListener('focusin', dismissTerminalDisplayOnFocus, true));
$('terminal-more').onclick = () => openHeaderMenu($('terminal-more'), true);
$('terminal-more').onpointerdown = event => { if (sessionMenu?.anchor === $('terminal-more')) event.stopPropagation(); };
const saveTerminalDisplay = () => attempt(async () => {
  if (!$('terminal-display-dialog').open) return;
  const fontSize = Number($('terminal-font-size').value);
  if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) throw uiError('error.nativeFontRange');
  terminalDisplay = { fontSize, palette: $('terminal-palette').value }; applyTerminalDisplay(); await persistView();
});
$('terminal-font-size').onchange = $('terminal-palette').onchange = saveTerminalDisplay;
$('reset-terminal-display').onclick = () => { $('terminal-font-size').value = 13; $('terminal-palette').value = 'dark'; saveTerminalDisplay(); };
$('close-terminal-display').onclick = () => { $('terminal-display-dialog').close(); focusTerminal(); };
let filePreview = null, fileTarget = null, fileChoosing = false, filesSpace = '';
function openSpaceFiles() {
  filesSpace = spaceId; $('space-files-list').dataset.signature = ''; renderSpaceFiles(); openTransientDialog('space-files-dialog');
}
function renderSpaceFiles() {
  if (!filesSpace) return;
  const room = spaceRecord(filesSpace); if (!room) return;
  ui.display.text($('space-files-title'), 'files.titleName', { name: room.name });
  $('add-space-files').disabled = disconnected || room.archived;
  const signature = JSON.stringify(room.files || []), list = $('space-files-list');
  if (list.dataset.signature === signature) return; list.dataset.signature = signature;
  list.replaceChildren(...(room.files || []).map(file => {
    const row = node('div', undefined, 'space-file-row'), open = button(file.name, async () => { $('space-files-dialog').close(); if (spaceId !== filesSpace) await selectSpace(filesSpace); await openLocalFile(true, file.id); }); open.title = file.path;
    const remove = uiButton('files.remove', async () => { await api.spaceAction(filesSpace, 'removeFile', [file.id, room.metadataRevision]); updateState(await api.initial()); renderSpaceFiles(); }); remove.disabled = room.archived; ui.display.attribute(remove, 'aria-label', 'files.removeAction', { space: room.name, file: file.name });
    row.append(open, remove); return row;
  }));
  if (!list.children.length) list.append(uiNode('p', 'files.empty', undefined, 'quiet'));
}
$('close-space-files').onclick = () => $('space-files-dialog').close();
$('add-space-files').onclick = () => attempt(async () => { const id = filesSpace; await api.spaceFiles(id); updateState(await api.initial()); if (filesSpace === id) renderSpaceFiles(); });
function fileTargetMatches() {
  return fileTarget && (!fileTarget.room || fileTarget.roomId === spaceId) && fileTarget.revision === selectionRevision && fileTarget.mode === mode &&
    (fileTarget.room ? sharedSurface() && fileTarget.id === roomRecipient() : !sharedSurface() && fileTarget.id === activeSessionId());
}
function fileDraftInput() { return fileTarget?.room ? $('shared-input') : $('message-input'); }
async function openLocalFile(room = false, reference) {
  if (fileChoosing) return;
  fileChoosing = true;
  const target = { id: room ? roomRecipient() : activeSessionId(), roomId: room ? spaceId : null, room, mode, revision: selectionRevision };
  try {
    const preview = reference ? await api.spaceFiles(target.roomId, reference) : await api.openLocalFile(target.id || null);
    if (!preview) return;
    if (document.querySelector('dialog[open]')) { await api.closeLocalFile(preview.token); return; }
    fileTarget = target;
    if (!fileTargetMatches()) { fileTarget = null; await api.closeLocalFile(preview.token); return; }
    filePreview = preview;
    $('file-title').textContent = preview.name;
    ui.display.text($('file-info'), 'file.snapshot', () => ({ size: preview.size.toLocaleString(ui.language.getSnapshot().active) }));
    $('file-content').textContent = preview.text;
    $('file-error').hidden = true;
    $('insert-file').disabled = !target.room && mode !== 'chat' || fileDraftInput().readOnly;
    ui.display.attribute($('insert-file'), 'title', $('insert-file').disabled ? 'file.insertUnavailable' : 'file.insertOnly');
    $('file-dialog').showModal();
  } finally { fileChoosing = false; }
}
$('session-files').onclick = () => attempt(() => openLocalFile(false));
$('room-files').onclick = openSpaceFiles;
$('close-file').onclick = () => $('file-dialog').close();
$('file-dialog').addEventListener('close', () => {
  if ($('file-dialog').open) return;
  if (filePreview) attempt(() => api.closeLocalFile(filePreview.token));
  filePreview = null; fileTarget = null;
  for (const id of ['file-title', 'file-info', 'file-content', 'file-error']) { ui.display.unbind($(id)); $(id).textContent = ''; }
  $('file-error').hidden = true; $('save-file').disabled = false;
});
$('insert-file').onclick = async () => {
  try {
    if (!filePreview || !fileTargetMatches() || fileDraftInput().readOnly || (!fileTarget.room && mode !== 'chat')) throw uiError("error.fileViewChanged");
    const input = fileDraftInput();
    const next = appendedDraft(input, uiText('files.material', { name: filePreview.name, text: filePreview.text }), fileTarget.room);
    if (next.length > 16000) throw uiError("error.draftMaterialTooLong");
    const room = fileTarget.room;
    input.value = next;
    // Insertion is synchronous and happens once. A failed persistence retry
    // must save this draft, never append the same material a second time.
    const token = filePreview.token; $('file-dialog').close(); filePreview = null; attempt(() => api.closeLocalFile(token));
    if (room) { roomDraftRevision++; render(); input.focus(); await persistView(); }
    else { input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
  } catch (error) {
    if ($('file-dialog').open) { ui.showError($('file-error'), error); $('file-error').hidden = false; }
    else toastError(error);
  }
};
$('save-file').onclick = async () => {
  if (!filePreview) return;
  const preview = filePreview; $('save-file').disabled = true;
  try { if (await api.saveLocalFile(preview.token)) toastMessage("toast.previewSaved"); }
  catch (error) { if (filePreview === preview && $('file-dialog').open) { ui.showError($('file-error'), error); $('file-error').hidden = false; } else toastError(error); }
  finally { if (filePreview === preview && $('file-dialog').open) $('save-file').disabled = false; }
};
$('interrupt').onclick = () => {
  const id = activeSessionId();
  if (mode === 'chat' && inputFocusAllowed() && !$('message-input').readOnly) $('message-input').focus();
  if (pendingInterrupts.has(id)) return;
  pendingInterrupts.add(id); render();
  attempt(async () => { try { await api.interrupt(id); } finally { pendingInterrupts.delete(id); render(); } });
};
function roomMentionSelectionChanged() {
  const input = $('shared-input');
  if (mentionChanging || mentionComposing || document.activeElement !== input) return;
  if (input.selectionStart === input.selectionEnd) {
    const point = nativeWorkspaceMentions.caretPosition(roomMention, input.value, input.selectionStart);
    if (point !== input.selectionStart) input.setSelectionRange(point, point);
  }
  showMentions();
}
$('shared-input').onbeforeinput = event => {
  if (mentionChanging) return;
  const input = $('shared-input');
  const edit = { before: input.value, binding: roomMention && { ...roomMention }, start: input.selectionStart, end: input.selectionEnd, type: event.inputType };
  if (!mentionComposing && !event.isComposing) {
    const range = nativeWorkspaceMentions.atomicRange(roomMention, input.value, edit);
    if (range) { input.setSelectionRange(range.start, range.end); Object.assign(edit, range); }
  }
  roomMentionHistory.sync(edit.before, edit.binding); roomMentionEdit = edit;
};
$('shared-input').oninput = event => {
  if (mentionChanging) return;
  const input = $('shared-input'), edit = roomMentionEdit; roomMentionEdit = null;
  const prior = edit?.binding;
  if (edit && /^(historyUndo|historyRedo)$/u.test(event.inputType)) roomMention = roomMentionHistory.travel(event.inputType, edit.before, prior, input.value, event.isTrusted);
  else {
    roomMention = edit ? nativeWorkspaceMentions.edited(prior, edit.before, input.value, edit) : null;
    if (edit) roomMentionHistory.record(edit.before, prior, input.value, roomMention); else roomMentionHistory.sync(input.value, null);
  }
  if (prior && !roomMention) ui.display.text($('mention-status'), 'mention.removed', { name: prior.text.slice(1) });
  else if (roomMention) $('mention-status').textContent = '';
  roomDraftRevision++; attempt(persistView); render();
  if (event.isComposing || mentionComposing) closeMentions(); else showMentions();
};
$('shared-input').oncompositionstart = () => { mentionComposing = true; closeMentions(); };
$('shared-input').oncompositionend = () => { mentionComposing = false; roomMentionSelectionChanged(); };
$('shared-input').addEventListener('selectionchange', roomMentionSelectionChanged);
$('shared-input').onclick = $('shared-input').onfocus = roomMentionSelectionChanged;
$('shared-input').onkeyup = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) roomMentionSelectionChanged(); };
$('shared-input').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (!$('mention-list').hidden) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % (mentionOptions.length || 1); highlightMention(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMentions(); return; }
    if (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey && mentionOptions[mentionIndex]) { event.preventDefault(); if (mentionOptions[mentionIndex]) chooseMention(mentionOptions[mentionIndex].id); return; }
    if (event.key === 'Tab') closeMentions();
  }
  if (!event.metaKey && !event.ctrlKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    const input = $('shared-input'), direction = event.key === 'ArrowLeft' ? -1 : 1;
    const backward = input.selectionDirection === 'backward', anchor = backward ? input.selectionEnd : input.selectionStart;
    const point = event.shiftKey ? backward ? input.selectionStart : input.selectionEnd : direction < 0 ? input.selectionStart : input.selectionEnd;
    const target = nativeWorkspaceMentions.caretPosition(roomMention, input.value, point, direction);
    if (target !== point) {
      event.preventDefault();
      if (event.shiftKey) input.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? 'backward' : 'forward');
      else input.setSelectionRange(target, target);
      roomMentionSelectionChanged(); return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !$('shared-input').readOnly) { event.preventDefault(); if (!$('forward-button').disabled) { if ($('forward-button').type === 'button') $('forward-button').click(); else $('room-composer').requestSubmit(); } }
};
$('shared-input').onblur = event => { if (!event.relatedTarget?.closest('#mention-list')) closeMentions(); };
async function submitRoom(automatic) {
  if (roomSubmitting || (automatic ? roomPendingRecipients.size > 0 : roomPendingRecipients.has($('recipient').value)) || $('shared-input').readOnly || $(automatic ? 'run-button' : 'forward-button').disabled) return;
  const first = roomRecipient(), raw = $('shared-input').value, text = nativeWorkspaceMentions.body(roomMention, raw), revision = roomDraftRevision, address = roomMention && { ...roomMention };
  const sendingSpace = spaceId, view = captureRoomView();
  const ids = automatic?.ids;
  const recipient = members().find(s => s.id === first);
  if (!recipient) throw uiError("error.recipientChanged");
  if (recipient.nativeInputRequired || recipient.shareAvailable === false || recipient.chatAvailable === false || !nativeUsable(recipient)) return;
  // Return focus before the clicked control becomes disabled. Never steal it
  // back asynchronously after the person has opened another view or dialog.
  $('shared-input').focus();
  const submission = { spaceId: sendingSpace, automatic: Boolean(automatic), recipientName: participantLabel(recipient), queued: !automatic && roomQueueAvailable(recipient), cancelling: false, cancelRequested: false };
  if (automatic) { roomSubmitting = submission; view.submitting = submission; }
  else roomPendingRecipients.set(first, submission);
  const queuedMark = submission.queued && { spaceId: sendingSpace, raw, address, revision, before: new Set(state.room.messages.map(m => m.id)) };
  if (queuedMark) queuedRoomInputs.set(first, queuedMark);
  render();
  try {
    const receipt = await (automatic ? api.spaceAction(sendingSpace, 'run', [ids, text, automatic.limit, automatic.mode || 'replies', automatic.labels, automatic.contexts, roomReplyTo || undefined, automatic.identities]) : roomQueueAvailable(recipient) ? api.spaceAction(sendingSpace, 'queueShared', [first, text, recipient.nativeId, roomReplyTo || undefined]) : roomSteerAvailable(recipient) ? api.spaceAction(sendingSpace, 'steerShared', [first, text, recipient.nativeId, recipient.activeTurnId, roomReplyTo || undefined]) : api.spaceAction(sendingSpace, 'forward', [first, text, recipient.nativeId, roomReplyTo || undefined]));
    if (submission.cancelRequested || receipt?.contextChanged) return;
    const original = sendingSpace === spaceId ? captureRoomView() : view;
    if (revision === original.draftRevision && original.sharedDraft === raw && original.roomRecipient === first && original.roomMention?.memberRevision === address?.memberRevision && original.roomMention?.text === address?.text) { original.sharedDraft = ''; original.roomMention = null; original.roomRecipient = ''; original.draftRevision++; writeRoomDraft(sendingSpace, original); }
  }
  catch (error) { if (!submission.cancelRequested) throw error; }
  finally {
    if (queuedMark && !queuedMark.tag && queuedRoomInputs.get(first) === queuedMark) queuedRoomInputs.delete(first);
    submission.settled = true; if (view.submitting === submission && !submission.cancelling) view.submitting = null;
    if (roomSubmitting === submission && !submission.cancelling) roomSubmitting = null;
    if (roomPendingRecipients.get(first) === submission) roomPendingRecipients.delete(first);
    render();
  }
}
$('room-composer').onsubmit = event => { event.preventDefault(); attempt(() => submitRoom(false)); };
$('forward-button').onclick = () => {
  if ($('forward-button').disabled || $('forward-button').type !== 'button') return;
  const recipient = members().find(s => s.id === $('recipient').value);
  if (!recipient) return;
  if (nativeUsable(recipient)) attempt(() => operateNative(recipient.id)); else select(recipient.id, 'chat');
};
function roomSteerAvailable(s) {
  return Boolean(!interruptPending(s) && s?.state === 'working' && s.steerAvailable && s.activeTurnId && !s.pendingSteer && !s.approval && (s.legacySharedSteer || s.serviceCapabilities?.includes('nativeSharedSteer')));
}
function roomQueueAvailable(s) {
  return Boolean(!interruptPending(s) && !s?.nativeInputRequired && s?.state === 'working' && s.queueAvailable && !s.pendingQueue && !s.approval && (s.legacySharedQueue || s.serviceCapabilities?.includes('nativeSharedQueue')));
}
function handoffCandidates(firstId) {
  const first = members().find(s => s.id === firstId);
  if (!first) return [];
  return members().filter(s => {
    const caps = s.serviceCapabilities || state.capabilities || [];
    return (s.handoffGroup === first.handoffGroup || state.peerHandoffsAvailable && caps.includes('peerReplyHandoffsV1') && first.serviceCapabilities?.includes('peerReplyHandoffsV1')) && caps.includes('boundedReplyHandoffs') &&
      s.state === 'idle' && !interruptPending(s) && !s.nativeInputRequired && !s.pendingTag && !s.approval && s.shareAvailable !== false && s.chatAvailable !== false &&
      ![s.background, s.scheduled].some(n => Number.isSafeInteger(n) && n > 0);
  });
}
function renderRunChoices() {
  if (!runPreview) return;
  const ids = runPreview.ids, eligible = handoffCandidates(runPreview.recipient);
  const crossService = new Set(ids.map(id => members().find(s => s.id === id)?.handoffGroup)).size > 1;
  const peerDirected = state.peerDirectedAvailable && ids.every(id => members().find(s => s.id === id)?.serviceCapabilities?.includes('peerDirectedHandoffsV2'));
  for (const option of $('run-mode').options) option.disabled = crossService && option.value !== 'replies' && !peerDirected;
  if (crossService && !peerDirected) $('run-mode').value = 'replies';
  const directed = $('run-mode').value === 'directed';
  const capable = ids.every(id => { const s = members().find(m => m.id === id); return s?.addressedSendAvailable === true && (s.serviceCapabilities || state.capabilities || []).includes('agentAddressedHandoffs'); });
  const helpKey = directed ? (capable ? 'run.directedHelp' : 'run.unsupportedHelp') : crossService ? 'run.crossServiceHelp' : null;
  if (helpKey) ui.display.text($('run-mode-help'), helpKey);
  else { ui.display.unbind($('run-mode-help')); $('run-mode-help').textContent = ''; }
  const multi = eligible.every(s => (s.serviceCapabilities || state.capabilities || []).includes('multiSessionHandoffs'));
  $('run-participants').replaceChildren();
  for (const s of members()) {
    const row = node('div', undefined, 'run-person');
    const label = node('label'), check = document.createElement('input'); check.type = 'checkbox';
    check.dataset.runMember = s.id; check.checked = ids.includes(s.id);
    check.disabled = s.id === runPreview.recipient || !eligible.some(m => m.id === s.id) || (!check.checked && !multi && ids.length >= 2);
    label.append(check, document.createTextNode(`${s.name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${sessionShortId(s.id)}`));
    check.onchange = () => {
      runPreview.ids = check.checked ? [...ids, s.id] : ids.filter(id => id !== s.id);
      $('run-consent').checked = false; renderRunChoices();
      document.querySelector(`[data-run-member="${s.id}"]`)?.focus();
    };
    row.append(label);
    const position = ids.indexOf(s.id);
    if (position > 1) {
      const up = button('↑', () => { [ids[position - 1], ids[position]] = [ids[position], ids[position - 1]]; $('run-consent').checked = false; renderRunChoices(); });
      ui.display.attribute(up, 'aria-label', 'run.moveUp', { name: s.name, id: sessionShortId(s.id) }); row.append(up);
    }
    $('run-participants').append(row);
  }
  for (const option of $('run-limit').options) option.disabled = Number(option.value) < ids.length;
  if (Number($('run-limit').value) < ids.length) $('run-limit').value = String(ids.length);
  const sequence = () => Array.from({ length: Number($('run-limit').value) }, (_, i) => {
    const s = members().find(s => s.id === ids[i % ids.length]);
    return s ? `${s.name} (${sessionShortId(s.id)})` : uiText('run.notSelected');
  });
  ui.display.text($('run-order'), directed ? 'run.directedOrder' : 'run.order', () => directed ? { count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(Number($('run-limit').value)) } : { sequence: sequence().join(' → ') });
  $('confirm-run').disabled = !$('run-consent').checked || ids.length < 2 || (directed && !capable);
}
$('run-button').onclick = () => {
  if ($('run-button').disabled) return;
  $('room-advanced').open = false;
  if (nativeWorkspaceMentions.body(roomMention, $('shared-input').value).length > 6000) { toastMessage("toast.runMaterialLimit"); $('shared-input').focus(); return; }
  const recipient = roomRecipient(), candidates = handoffCandidates(recipient);
  runPreview = { spaceId, text: nativeWorkspaceMentions.body(roomMention, $('shared-input').value), recipient, revision: roomDraftRevision, selectionRevision,
    members: members().map(s => [s.id, pairRevision(s), s.name, s.nativeId]), identities: Object.fromEntries(members().map(s => [s.id, s.peerIdentity])), ids: [recipient, candidates.find(s => s.id !== recipient)?.id].filter(Boolean) };
  $('run-preview').textContent = runPreview.text;
  $('run-mode').value = 'replies'; $('run-limit').value = '3';
  $('run-consent').checked = false; $('run-error').hidden = true; renderRunChoices();
  $('run-dialog').showModal();
};
$('run-consent').onchange = renderRunChoices;
$('run-mode').onchange = () => { $('run-consent').checked = false; renderRunChoices(); };
$('run-limit').onchange = () => { $('run-consent').checked = false; renderRunChoices(); };
$('cancel-run').onclick = () => { $('run-dialog').close(); runPreview = null; $('shared-input').focus(); };
$('run-form').onsubmit = event => {
  event.preventDefault();
  if (!$('run-consent').checked || !runPreview || $('confirm-run').disabled) return;
  const eligible = handoffCandidates(runPreview.recipient);
  const same = selected === 'room' && runPreview.spaceId === spaceId && runPreview.selectionRevision === selectionRevision && runPreview.text === nativeWorkspaceMentions.body(roomMention, $('shared-input').value) && runPreview.recipient === $('recipient').value && runPreview.revision === roomDraftRevision && JSON.stringify(runPreview.members) === JSON.stringify(members().map(s => [s.id, pairRevision(s), s.name, s.nativeId]));
  const available = runPreview.ids.length >= 2 && runPreview.ids.every(id => JSON.stringify(runPreview.identities[id]) === JSON.stringify(members().find(s => s.id === id)?.peerIdentity)) && runPreview.ids.every(id => eligible.some(s => s.id === id)) &&
    (runPreview.ids.length <= 2 || eligible.filter(s => runPreview.ids.includes(s.id)).every(s => (s.serviceCapabilities || state.capabilities || []).includes('multiSessionHandoffs')));
  if (!same || !available || $('run-button').disabled) { ui.display.text($('run-error'), 'run.changed'); $('run-error').hidden = false; return; }
  const mode = $('run-mode').value, limit = Number($('run-limit').value), ids = [...runPreview.ids], labels = Object.fromEntries(runPreview.members.filter(m => ids.includes(m[0])).map(m => [m[0], m[2]]));
  const identities = Object.fromEntries(runPreview.ids.map(id => [id, runPreview.identities[id]]));
  const contexts = Object.fromEntries(runPreview.members.filter(m => ids.includes(m[0])).map(m => [m[0], m[3]]));
  $('run-dialog').close(); runPreview = null; attempt(() => submitRoom({ limit, ids, labels, contexts, mode, identities }));
};

$('room-search').oninput = $('room-filter').onchange = () => { renderTimeline(); attempt(persistView); };
$('thread-back').onclick = () => { captureReadingViews(); roomThread = ''; if (!$('shared-input').value.trim() && !roomSubmitting) roomReplyTo = ''; render(); attempt(persistView); };
$('cancel-reply').onclick = () => { roomReplyTo = ''; roomThread = ''; roomDraftRevision++; render(); attempt(persistView); $('shared-input').focus(); };
$('copy-timeline').onclick = () => attempt(() => api.copy(filteredTimeline().map(m => `${Number.isFinite(m.time) ? new Date(m.time).toLocaleString(ui.language.getSnapshot().active) : uiText('reading.unknownTime')} · ${roomMessageLabel(m)}\n${m.text}`).join('\n\n')));
$('room-notes').onclick = () => openNotes(); $('cancel-notes').onclick = () => $('notes-dialog').close();
$('notes-form').onsubmit = async event => {
  event.preventDefault(); const ticket = dialogTickets.get($('notes-dialog'));
  if (!currentDialogTicket(ticket) || $('save-notes').disabled) return;
  $('save-notes').disabled = true; $('notes-error').hidden = true;
  try {
    await api.spaceAction(ticket.roomId, 'notes', [$('room-notes-text').value, notesRevision]);
    if (currentDialogTicket(ticket)) $('notes-dialog').close(); else toastMessage("toast.notesSavedEarlier");
  } catch (error) {
    if (currentDialogTicket(ticket)) { ui.showError($('notes-error'), error); $('notes-error').hidden = false; }
    else toastMessage('toast.notesFailedEarlier', () => ({ error: ui.errorText(error) }));
  } finally { if (currentDialogTicket(ticket)) $('save-notes').disabled = false; }
};
$('attach-context').onclick = () => { $('room-advanced').open = false; openContext(); }; $('close-context').onclick = () => $('context-dialog').close();
$('context-text').addEventListener('input', updateContextControls);
$('copy-context').onclick = () => attempt(async () => {
  const text = $('context-text').value;
  if (!contextSnapshot || !text.trim() || text.length > 12000 || !text.isWellFormed()) return contextProblem(uiError('error.contextCheckPreview'));
  await api.copy(text); toastMessage("toast.contextCopied");
});
$('insert-context').onclick = () => attempt(async () => {
  const ticket = dialogTickets.get($('context-dialog')), revision = selectionRevision;
  if (!currentDialogTicket(ticket)) return;
  const target = contextTarget, text = $('context-text').value;
  if (!contextSnapshot || !text.trim() || text.length > 12000 || !text.isWellFormed()) return contextProblem(uiError('error.contextCheckPreview'));
  if (!target?.room || target.roomId !== spaceId || selected !== 'room') return contextProblem(uiError('error.contextViewChanged'));
  const input = $('shared-input');
  const next = appendedDraft(input, text, true);
  if (next.length > 16000) { ui.display.text($('context-error'), 'context.tooLong'); $('context-error').hidden = false; return; }
  input.value = next;
  roomDraftRevision++; await persistView();
  if (currentDialogTicket(ticket) && revision === selectionRevision) { $('context-dialog').close(); render(); input.focus(); }
});
$('share-recipient').onchange = $('share-text').oninput = () => { shareRevision++; updateSharingControls(); };
$('pause-button').onclick = () => attempt(async () => {
  const submission = roomSubmitting?.automatic ? roomSubmitting : null;
  if (submission?.cancelling) return;
  if (selected === 'room' && !roomSession && inputFocusAllowed()) $('shared-input').focus();
  if (submission) { submission.cancelRequested = true; submission.cancelling = true; render(); }
  try {
    // Pause invalidates pending authorization in the shared client before its
    // native ACK arrives. A later completion must not clear a newer draft/run.
    await api.spaceAction(submission?.spaceId || spaceId, 'pause', []);
    if (submission) {
      if (roomSubmitting === submission) roomSubmitting = null;
      toastMessage("toast.handoffCancelled");
    }
  } finally {
    if (submission) {
      submission.cancelling = false;
      if (submission.settled && roomSubmitting === submission) roomSubmitting = null;
    }
    render();
  }
});
function openInvite(anchor) {
  if (disconnected || state.room.archived || $('invite-dialog').open) return;
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  inviteOrigin = { anchor, revision: selectionRevision };
  const destination = spaceId;
  const ticket = openTransientDialog('invite-dialog'), revision = selectionRevision;
  const candidates = state.sessions.filter(s => !inSpace(s, destination) && !s.archived && s.state !== 'ended');
  const blocked = s => !window.nativeWorkspaceSpaces.canJoin(s, destination);
  $('invite-error').hidden = true; ui.display.unbind($('invite-error')); $('invite-error').textContent = '';
  $('invite-list').replaceChildren(...candidates.map(s => {
    if (blocked(s)) {
      // Stay focusable so keyboard and reader users can reach the exact reason.
      const entry = button('', () => {
        if (!currentDialogTicket(ticket)) return;
        ui.showError($('invite-error'), oldBackendJoin(s)); $('invite-error').hidden = false;
      });
      ui.display.text(entry, 'invite.legacyBlocked', { name: participantLabel(s, state.sessions) });
      entry.setAttribute('aria-disabled', 'true'); ui.display.computed(entry, 'title', () => ui.errorText(oldBackendJoin(s))); entry.dataset.inviteSession = s.id; return entry;
    }
    const entry = button('', async () => {
      try {
        const current = state.sessions.find(record => record.id === s.id);
        if (!current || inSpace(current, destination) || current.archived || current.state === 'ended' || pairRevision(current, destination) !== pairRevision(s, destination) || current.nativeId !== s.nativeId) throw uiError("error.inviteSessionChanged");
        if (!currentDialogTicket(ticket) || entry.disabled) return;
        entry.disabled = true; $('invite-error').hidden = true;
        try { await api.spaceAction(destination, 'join', [s.id, true]); if (currentDialogTicket(ticket) && revision === selectionRevision) $('invite-dialog').close(); }
        finally { if (currentDialogTicket(ticket)) entry.disabled = false; }
      } catch (error) {
        // The modal hides ordinary toasts; keep the reason beside the choice.
        if (!currentDialogTicket(ticket)) throw error;
        ui.showError($('invite-error'), error.message ? error : uiError('error.spaceJoinFailed')); $('invite-error').hidden = false;
      }
    });
    ui.display.text(entry, 'invite.joinName', { name: participantLabel(s, state.sessions) }); entry.dataset.inviteSession = s.id; return entry;
  }));
  if (candidates.some(blocked)) $('invite-list').append(uiNode('p', 'invite.legacyHelp'));
  if (!$('invite-list').children.length) $('invite-list').append(uiNode('p', 'invite.allJoined'));
}
$('invite-dialog').addEventListener('close', () => {
  if ($('invite-dialog').open) return;
  $('invite-list').replaceChildren(); $('invite-error').hidden = true; ui.display.unbind($('invite-error')); $('invite-error').textContent = '';
  const origin = inviteOrigin; inviteOrigin = null;
  if (origin?.revision === selectionRevision && selected === 'room') focusMemberAction(origin.anchor);
});
$('close-invite').onclick = () => $('invite-dialog').close();
$('cancel-share').onclick = () => $('share-dialog').close();
$('share-dialog').onclose = () => {
  if ($('share-dialog').open) return;
  shareRevision++; $('share-text').value = ''; ui.display.unbind($('share-help')); $('share-help').textContent = '';
  const recipient = $('share-recipient'); recipient.replaceChildren(); recipient.title = '';
  delete recipient.dataset.signature; delete recipient.dataset.hadChoices;
};
$('confirm-share').onclick = () => attempt(async () => {
  updateSharingControls();
  if ($('confirm-share').disabled) return;
  const request = { roomId: shareSpaceId, revision: shareRevision, recipient: $('share-recipient').value, text: $('share-text').value };
  sharePending = request; updateSharingControls();
  try {
    const nativeId = members().find(s => s.id === request.recipient)?.nativeId;
    const receipt = await api.spaceAction(request.roomId, 'forward', [request.recipient, request.text, nativeId]);
    if (receipt?.contextChanged) return;
    // An old acceptance must not close a reopened preview or discard edits,
    // including a new edit whose text happens to match the submitted text.
    if ($('share-dialog').open && shareRevision === request.revision &&
        $('share-recipient').value === request.recipient && $('share-text').value === request.text) $('share-dialog').close();
    toastMessage("toast.directedSent");
  } finally { sharePending = null; updateSharingControls(); }
});
$('privacy-button').onclick = $('refresh-trust').onclick = () => attempt(showTrust); $('quit-service').onclick = () => attempt(() => api.quitService());
$('privacy-source').onclick = () => attempt(() => api.openExternal('https://github.com/RulerCompass1729/native-agent-workspace/blob/main/docs/privacy.md'));
$('data-directory').onclick = () => attempt(() => api.dataDirectory());
$('clear-shared-history').onclick = () => attempt(async () => {
  const target = trustClearRoom, generation = trustRevision, control = $('clear-shared-history');
  if (control.disabled) return;
  if (target === 'shared' && !state.capabilities?.includes('clearSharedHistory')) throw uiError("error.oldBackendFeature");
  control.disabled = true;
  try {
    const cleared = await api.spaceAction(target, 'clearSharedHistory', []);
    if (cleared && generation === trustRevision && $('privacy-dialog').open) ui.display.text($('trust-refresh-status'), 'trust.cleared');
  } catch (error) {
    if (generation === trustRevision && $('privacy-dialog').open) ui.showError($('trust-refresh-status'), error);
    else throw error;
  } finally { if (generation === trustRevision) control.disabled = false; }
});
$('close-privacy').onclick = () => { $('privacy-dialog').close(); focusTerminal(); };
$('reconnect-button').onclick = () => attempt(async () => { $('reconnect-button').disabled = true; try { await api.reconnect(); } finally { $('reconnect-button').disabled = false; } });
$('retry-save').onclick = () => attempt(async () => {
  $('retry-save').disabled = true;
  try { await api.retrySave(); if (!disconnected) updateState(await api.initial()); render(); }
  finally { $('retry-save').disabled = false; }
});
$('search-button').onclick = () => openSearch();
$('close-search').onclick = () => $('search-dialog').close();
$('search-preview-back').onclick = renderSearch;
$('search-dialog').addEventListener('close', finishSearch);
$('search-input').oninput = event => { clearTimeout(searchTimer); if (!event.isComposing) searchTimer = setTimeout(() => { searchLimit = 60; renderSearch(); }, 100); };
$('search-input').oncompositionend = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchLimit = 60; renderSearch(); }, 100); };
$('search-input').onkeydown = searchInputKey;
$('search-results').onkeydown = searchResultKey;
$('search-scope').onchange = $('search-archived').onchange = () => { searchLimit = 60; renderSearch(); };
$('search-more').onclick = () => { searchLimit += 60; renderSearch(); };
$('return-reading').onclick = () => attempt(returnToReading);
document.addEventListener('keydown', searchKey);
// Electron's native light dismiss keeps an inside-origin drag from cancelling.
// Escape during composition commits/cancels the IME, not the surrounding dialog.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (event.isComposing || event.keyCode === 229)) { event.preventDefault(); event.stopPropagation(); }
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return; // A queued old close must not clear a new opening.
    dialogTickets.delete(dialog); dialog.scrollTop = 0;
    if (dialog.id === 'create-dialog') {
      for (const id of ['session-name', 'claude-history-id']) $(id).value = '';
      for (const id of ['chosen-folder', 'create-error', 'create-readiness', 'create-permission-note', 'create-space-help', 'git-worktree-source-help', 'git-worktree-preview']) { ui.display.unbind($(id)); $(id).textContent = ''; }
      $('skip-permissions').checked = false; folder = ''; newDirectory = false;
      $('initial-view').value = '';
      for (const input of dialog.querySelectorAll('input[name="provider"]')) input.checked = false;
    } else if (dialog.id === 'setup-dialog') {
      $('setup-status').replaceChildren(); $('version-info').textContent = '';
    } else if (dialog.id === 'notes-dialog') {
      $('room-notes-text').value = ''; ui.display.unbind($('notes-error')); $('notes-error').textContent = ''; $('notes-error').hidden = true;
    } else if (dialog.id === 'context-dialog') {
      contextTarget = null; contextSnapshot = null;
      $('context-space-choices').replaceChildren(); $('context-spaces').disabled = false;
      ui.display.unbind($('context-scope-note')); $('context-scope-note').textContent = ''; $('context-scope-note').hidden = true;
      $('context-text').value = ''; $('context-text').disabled = false; ui.display.unbind($('context-error')); $('context-error').textContent = ''; $('context-error').hidden = true;
      $('copy-context').disabled = false; $('insert-context').disabled = false;
    } else if (dialog.id === 'run-dialog') {
      runPreview = null; $('run-consent').checked = false; $('confirm-run').disabled = true;
      $('run-mode').value = 'replies'; $('run-limit').value = '3'; $('run-participants').replaceChildren();
      for (const id of ['run-preview', 'run-order', 'run-mode-help', 'run-error']) { ui.display.unbind($(id)); $(id).textContent = ''; }
      $('run-error').hidden = true;
    } else if (dialog.id === 'terminal-display-dialog') {
      $('terminal-font-size').value = ''; $('terminal-palette').value = '';
    }
  });
}
$('setup-button').onclick = $('create-setup').onclick = $('refresh-setup').onclick = () => attempt(showSetup);
$('close-setup').onclick = () => $('setup-dialog').close();
$('ui-language').onchange = event => { void changeInterfaceLanguage(event.target.value); };
disposers.push(ui.language.subscribe(() => { renderInterfaceLanguage(); renderSetupPrograms(true); if (selected === 'panorama') document.title = uiText('panorama.windowTitle'); }));
disposers.push(api.onLocale(value => { if (!value || typeof value !== 'object') return; languageWarning = ['unavailable', 'migrationNotSaved'].includes(value.warning) ? value.warning : null; if (!languageWarning) notifiedLanguageWarning = undefined; renderInterfaceLanguage(); reportLanguageWarning(); }));
renderInterfaceLanguage();

for (const input of document.querySelectorAll('input[name="provider"]')) input.onchange = createReadiness;
$('claude-history-id').oninput = createReadiness;
$('create-space-kind').onchange = () => { if ($('create-space-kind').value === 'new' && !$('create-space-name').dataset.edited) $('create-space-name').value = $('session-name').value.trim(); createReadiness(); };
$('create-space-existing').onchange = createReadiness;
$('create-space-name').oninput = () => { $('create-space-name').dataset.edited = 'true'; createReadiness(); };
$('claude-history-id').onkeydown = event => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('open-native-history').click(); }
};
$('skip-permissions').onchange = createReadiness;
attempt(async () => {
  state = await api.initial();
  languageWarning = ['unavailable', 'migrationNotSaved'].includes(state.localeWarning) ? state.localeWarning : null; renderInterfaceLanguage();
  if (latestViewStorage !== undefined) { state.viewStorageWarning = latestViewStorage; state.viewStorageWarningUiMessage = latestViewStorageUiMessage; }
  roomViews = state.viewState.roomViews || Object.create(null);
  if (!roomViews.shared) roomViews.shared = Object.fromEntries(roomViewFields.filter(k => state.viewState[k] !== undefined).map(k => [k, state.viewState[k]]));
  spaceId = state.viewState.spaceId || 'shared'; sidebarView = state.viewState.sidebarView || 'flat';
  sidebarCollapsedGroups = new Set(state.viewState.sidebarCollapsedGroups || []);
  columnTerminalHeights = { ...(state.viewState.columnTerminalHeights || {}) };
  state = projectSpace(state); const savedRoomView = roomViews[spaceId] || {};
  owner = state.owner; folder = state.defaultWorkspace; preference = state.viewState.preference || 'terminal'; mode = state.viewState.mode || preference;
  terminalLayout = ['hidden', 'split', 'maximized'].includes(state.viewState.terminalLayout) ? state.viewState.terminalLayout : 'split';
  terminalSplit = Number.isFinite(state.viewState.terminalSplit) && state.viewState.terminalSplit >= 0.2 && state.viewState.terminalSplit <= 0.8 ? state.viewState.terminalSplit : 0.5; applySplit();
  readingPositions = state.viewState.readingPositions || {};
  if (state.viewState.panorama) panoramaView = structuredClone(state.viewState.panorama);
  roomSession = typeof savedRoomView.roomSession === 'string' ? savedRoomView.roomSession : '';
  const display = state.viewState.terminalDisplay;
  if (display && Number.isInteger(display.fontSize) && display.fontSize >= 10 && display.fontSize <= 24 && terminalThemes[display.palette]) terminalDisplay = display;
  $('shared-input').value = typeof savedRoomView.sharedDraft === 'string' ? savedRoomView.sharedDraft : '';
  $('room-search').value = savedRoomView.roomSearch || ''; pendingRoomFilter = savedRoomView.roomFilter || '';
  roomThread = savedRoomView.roomThread || ''; roomReplyTo = savedRoomView.roomReplyTo || '';
  const savedRecipient = savedRoomView.roomRecipient;
  const savedMention = savedRoomView.roomMention;
  if (savedMention && nativeWorkspaceMentions.validView(savedMention, $('shared-input').value, savedRecipient)) roomMention = savedMention;
  roomSurface = savedRoomView.roomSurface || 'overview';
  normalizeRoomMention();
  if (typeof savedRecipient === 'string' || $('shared-input').value.trim()) {
    // Older views have a draft but no recipient: require an explicit choice.
    $('recipient').dataset.hadChoices = 'true'; populateSelect($('recipient'), members());
    $('recipient').value = roomRecipient();
    $('recipient').title = $('recipient').selectedOptions[0]?.textContent || '';
  }
  for (const [id, backup] of Object.entries(state.viewState.draftBackups || {})) {
    const saved = state.sessions.find(s => s.id === id);
    if (!saved) continue;
    draftRecoveries.set(id, Array.isArray(backup.recoveries) ? backup.recoveries : []);
    if (!backup.discarded && (backup.acknowledged !== true || saved.state === 'recoverable' || state.storageWarning) && typeof backup.text === 'string' && backup.text && backup.text !== saved.liveDraft) {
      draftRecoveries.set(id, await api.retainDraftRecovery(id, backup.text));
    }
  }
  await select(state.viewState.selected || '', mode); await api.uiReady(); reportLanguageWarning();
});
const disposeContentMenus = bindContentMenus();
return () => { clearInterval(nativeActivityClock); roomOverview?.dispose(); document.removeEventListener('toggle', updateSelectedSharing, true); document.removeEventListener('selectionchange', documentSelectionChanged); document.removeEventListener('keydown', searchKey); clearTimeout(searchTimer); disposeReadingViews(); disposeContentMenus(); sessionMenu?.close(); roomMenu?.(); for (const dispose of disposers) dispose(); observer.disconnect(); clearTimeout(toastTimer); for (const entry of terminals.values()) entry.term.dispose(); };
