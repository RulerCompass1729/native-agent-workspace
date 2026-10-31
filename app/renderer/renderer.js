/* Views consume session capabilities; they never own native processes. */
const api = window.workspace;
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const button = (text, action, cls) => { const el = node('button', text, cls); el.type = 'button'; el.addEventListener('click', () => attempt(action)); return el; };
const states = { starting: '正在启动', idle: '就绪', working: '正在工作', approval: '等待确认', stopping: '等待原生退出确认', disconnected: '已断开 · 原生尚未释放', recoverable: '等待恢复', ended: '已结束', background: '已转到后台运行', error: '需要检查' };
// An unfollowed native /resume leaves the process running in another session.
const switchedAway = record => record.state === 'stopping' && record.nativeContextPending?.reason === 'resume';
const sessionStatus = (record, recoveryBadge = false) => {
  const status = window.nativeWorkspaceFleet.fleetStatus(record, switchedAway(record) ? '原生已切换会话' : record.claudeQuestion ? '等待回答' : states[record.state], !disconnected);
  const recovery = record.capacityRecovery;
  if (!recoveryBadge || disconnected || record.archived || record.backendUnavailable || record.transportDisconnected ||
      record.nativeContextPending || record.approval || record.approvalOverflow || record.claudeQuestion || record.nativeApproval || record.nativeInputRequired ||
      !['idle', 'error'].includes(record.state) || typeof record.nativeId !== 'string' || !record.nativeId ||
      recovery?.nativeId !== record.nativeId || typeof recovery.turnId !== 'string' || !recovery.turnId ||
      recovery.status !== 'exhausted' || recovery.attempt !== 3 || !['capacity', 'routing'].includes(recovery.reason)) return status;
  return status + ' · ' + (recovery.reason === 'routing' ? '路由超时停下' : '满载停下') + ' · 已重试 ' + recovery.attempt + ' 次';
};
let state, owner, selected = '', mode = 'terminal', preference = 'terminal', folder = '', disconnected = false;
let newDirectory = false, creatingSession = false;
let gitWorktreePlan = null, gitWorktreeNonce = '', gitPreviewRevision = 0, gitPreviewLoading = false, gitPreviewTimer;
let latestViewStorage;
let roomSession = '', selectionRevision = 0, pendingMode;
let roomSurface = 'overview', roomOverview;
let panorama, panoramaOrigin, roomReturnReading;
let panoramaView = { layout: 'list', query: '', spaceId: '', top: 0, returning: false };
let spaceId = 'shared', sidebarView = 'flat', sidebarSpaceFilter = '', hoverSpace = '';
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
async function addToSpace(id, destination) {
  const room = spaceRecord(destination), record = state.sessions.find(s => s.id === id);
  if (!room || room.archived || !record || record.archived) throw Error('空间或会话已变化，没有加入。');
  const receipt = await api.spaceAction(destination, 'join', [id, true]);
  updateState(await api.initial()); render();
  if (!receipt?.changed) return toast(`已在「${room.name}」中，其他归属保留。`);
  toast(`已加入「${room.name}」；原来的空间归属保留。`, { label: '撤销加入', name: `撤销加入「${room.name}」`, run: async () => {
    await api.spaceAction(destination, 'join', [id, false, { revision: receipt.revision, nativeId: receipt.nativeId }]);
    updateState(await api.initial()); render(); toast(`已撤销这次加入「${spaceRecord(destination)?.name || room.name}」。`);
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
    title: `${item.title || '原生过程'} · ${stale ? '最后记录' : '旧连接记录'}`, status: stale && ['running', 'streaming'].includes(item.status) ? 'unconfirmed' : item.status,
    volatile: true, incomplete: item.truncated }));
  if (stale) rows.push({ id: 'legacy-observation-offline', role: 'system', text: '连接状态尚未确认。保留最后收到的过程记录，当前运行情况未知。' });
  if (cache.unavailable || cache.truncated) rows.push({ id: 'legacy-observation-gap', role: 'system', text: '旧连接的过程记录不完整，请核对原生终端。', incomplete: true });
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
  binding.ui = window.nativeWorkspaceComposer.create({ form,
    onInput: () => saveSessionDraft(binding), onError: error => toast(error.message || '操作未完成。'),
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
    if (current()?.id === s.id && mode === 'terminal') toast('请在此会话运行 /reload-plugins；连接成功后即可切回对话输入。');
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
    if (visible) { if (binding.nativeHost.parentElement !== host) host.append(binding.nativeHost); if (binding.ui.form.parentElement !== host) host.append(binding.ui.form); }
    else if (binding.ui.form.parentElement !== composerParking) composerParking.append(binding.ui.form);
    updateSessionComposer(binding, record, true);
  }
  const nativeVisible = visible && record.view === 'terminal' && binding !== soloComposer;
  binding.nativeVisible = nativeVisible; binding.nativeHost.hidden = !nativeVisible;
  if (nativeVisible && nativeUsable(record) && record.terminalState?.alive) ensureTerminal(record.id).catch(error => toast(error.message));
  syncTerminalMount(record.id);
  return nativeVisible;
}
function removeColumnInput(id) {
  const binding = sessionComposers.get(id); if (!binding) return;
  binding.revision++; binding.visible = binding.nativeVisible = false; binding.resizeAllowed = false;
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
    host: $('panorama-view'), view: panoramaView,
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
      if (!record) throw Error('原会话已不可用，没有改为打开同名会话。');
      rememberPanoramaOrigin();
      await select(id, 'chat', roomSession, true);
      if (source && !pointToMessage($('messages'), id, source.messageId)) toast('原文已不在当前保留记录中，没有打开其他消息。');
    }),
    onSpace: id => attempt(async () => {
      if (!spaceRecord(id) || spaceRecord(id).archived) throw Error('原空间已不可用，没有改为打开其他空间。');
      rememberPanoramaOrigin(); await selectSpace(id);
    }),
    onReadingLost: () => toast('原文已变化，原选区没有替换成其他内容。'),
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
  const origin = document.activeElement, oldHeader = origin?.closest('.collaboration-member-status');
  const oldIndex = oldHeader ? [...$('collaboration-overview').querySelectorAll('.collaboration-member-status')].indexOf(oldHeader) : -1;
  const removedFocus = oldHeader && !members().some(s => s.id === oldHeader.dataset.memberId);
  if (!roomOverview) roomOverview = window.nativeWorkspaceCollaboration.create({
    host: $('collaboration-overview'), roomId: state.room.id,
    onMove: moveRoomMember,
    onOrderError: error => toast(error.message || '顺序未更改。'),
    label: s => participantLabel(s, state.sessions), messages: s => sessionMessages(s),
    renderMessages: (el, s, rows, key) => messageList(el, rows, false, key, { session: s, passive: true }),
    disposeMessages: el => { messageViews.get(el)?.dispose(); messageViews.delete(el); },
    renderInput: renderColumnInput, disposeInput: removeColumnInput,
    beforeInputLayout: suspendColumnInputs,
    beforeLayout: () => { captureReadingViews(); restoreOverviewReading(); }, onLayout: restoreOverviewReading, onFocus: focusRoomMember,
    decorateHeader: (handle, record) => draggableSession(handle, record.id),
    onMemberMenu: openMemberMenu,
    onSource: (el, key, source) => {
      if (!pointToMessage(el, key, source.messageId)) toast('这段原文已不在当前保留的记录中；没有改为打开其他消息。');
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
  if (latestViewStorage !== undefined) state.viewStorageWarning = latestViewStorage;
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
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()}${date.getFullYear() === now.getFullYear() ? '' : `/${date.getFullYear()}`} ${time}`;
}
function sessionActivityTime(s) {
  const reported = sessionTime(s.lastActivityAt);
  if (reported) return reported;
  let latest = null;
  for (const m of Array.isArray(s.messages) ? s.messages : []) {
    if (!m?.volatile && m?.kind !== 'gap' && Number.isFinite(m?.time) && Number.isFinite(new Date(m.time).getTime())) latest = latest === null ? m.time : Math.max(latest, m.time);
  }
  return latest === null ? '时间未知' : `推算 ${sessionTime(latest)}`;
}
const sessionTimes = s => `创建 ${sessionTime(s.createdAt) || '未记录'} · 最后活动 ${sessionActivityTime(s)}`;
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
    area.setAttribute('aria-label', `草稿副本 ${index + 1}`);
    row.append(area, button('复制副本', () => api.copy(text), 'small'), button('删除此副本', () => changeDraftRecovery(id, 'discardDraftRecovery', text), 'small'));
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
  if (!s || disconnected || s.archived) return { kind: 'none', label: s?.archived ? '已归档' : '未连接', hint: s?.archived ? '恢复会话后继续，草稿保留。' : '重新连接本机服务后继续，草稿保留。' };
  if (s.transportDisconnected && canResume(s)) return { kind: 'resume', label: '继续原生会话', hint: '图形连接已断开；重接同一后台与会话，已有终端和草稿保留，不重发任务。' };
  if (!nativeUsable(s)) return canResume(s)
    ? { kind: 'resume', label: '继续原生会话', hint: '记录和草稿已保留；恢复不会重发旧任务。' }
    : { kind: 'none', label: '暂不可发送', hint: '请检查原生会话状态。记录和草稿保留，不会自动重发。' };
  if (s.owner !== owner) return { kind: 'claim', label: '接管此窗口', hint: '此窗口只读。接管后继续使用原会话，草稿保留。' };
  if (interruptPending(s)) return { kind: 'send', label: '等待中断确认', hint: '正在等待原生中断确认，可以继续编辑草稿；不会自动发送。' };
  if (s.nativeInputRequired) return { kind: 'terminal', label: '打开原生终端', hint: 'Claude 已停止本轮，并暂停插件输入。请在原生终端输入一次后继续；这里的草稿保留，不会自动发送。' };
  if (s.state === 'error' && s.failedTurnInputAvailable) return { kind: 'send', label: '发送 ↑', hint: '上次请求失败。可以编辑并发送新消息；不会自动重试或继续交接。' };
  if (s.state === 'error' && (s.chatAvailable !== false || !s.legacyInputEligible || s.legacyInputPrepared)) return { kind: 'terminal', label: '打开原生终端', hint: '原生请求未完成。请查看上方的失败记录；草稿保留，不会自动重试。需要处理原生设置时可打开终端。' };
  if (s.chatAvailable === false && s.legacyInputEligible && s.provider === 'codex') return { kind: 'connect', label: '接通原会话输入', hint: '连接正在运行的原生 Codex 会话，保留上下文、模型与权限设置；不会新建对话。' };
  if (s.chatAvailable === false && s.legacyInputEligible) return s.legacyInputPrepared
    ? { kind: 'terminal', label: '打开原生终端', hint: '在此会话运行一次 /reload-plugins，即可回到这里输入；无需重启。若原生提示需要 --force，请先保留现状。' }
    : { kind: 'connect', label: '接通原会话输入', hint: '在当前工作目录添加本地输入插件，再在原生终端加载一次。保留当前进程、历史和草稿。' };
  if (s.chatAvailable === false || s.state === 'starting') return { kind: 'terminal', label: '打开原生终端', hint: '请在原生终端继续。这里的草稿保留，不会自动粘贴或发送。' };
  if ((context.column || focusedRoomMember()) && (context.mode || mode) === 'chat' && s.view !== 'chat') return { kind: 'chat', label: '启用对话输入', hint: '正在查看原会话；明确启用后可在这里输入，草稿保留。' };
  if (s.legacyReaderPending && s.state === 'idle') return { kind: 'send', label: '发送 ↑', hint: '输入已接通；实时过程尚待更新。在原生终端运行 /reload-plugins 后生效，无需重启。' };
  // Native runs a plugin's queued prompt only once idle; text typed in the TUI reaches the running turn.
  if (s.pendingQueue) return { kind: 'send', label: '等待原生接收', hint: '要等 Claude 空闲后才发送；想中途插话，请在原生终端输入。可先编辑后续草稿。' };
  if (s.state === 'working' && s.queueAvailable && !s.approval) return { kind: 'send', label: '等本轮结束后发送 ↑', hint: '使用原生等待队列；保留当前工作，不强制中断。' };
  if (s.state === 'working' && s.steerAvailable && s.activeTurnId && !s.approval) return { kind: 'send', label: '追加指令 ↑', hint: '发送到当前原生回合；不会另开回合或强制中断。' };
  return { kind: 'send', label: '发送 ↑', hint: s.state === 'approval'
    ? s.approvalResolved ? '确认已处理，等待原生状态更新；可以继续编辑草稿。'
      : s.approval?.pending ? '已提交决定，等待原生确认；可以继续编辑草稿。'
        : '请核对上方的原生确认；可以保留下一条草稿。'
    : s.state === 'working' || s.pendingTag ? '正在回复，可以先编辑下一条。' : 'Enter 发送 · Shift Enter 换行' };
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
  binding.ui.update({ readOnly: action.kind !== 'send' && !legacyDraft, submit: action.kind === 'send', disabled,
    label: action.label, actionLabel: column ? `${action.label}：${identity}` : '',
    placeholder: column ? `发送给 ${identity}…` : action.kind === 'send' ? '直接说你想做什么…' : legacyDraft ? '可以继续编辑草稿。' : '草稿保留在这里；请使用下方操作继续。',
    inputLabel: column ? `发送给 ${identity} 的消息` : '发送给当前 agent 的消息',
    hint: inputRecoveries.get(s.id)?.text.value ? '上一段原生输入未确认。草稿保留；请查看本会话的原生输入。' : binding.changing || pendingMode?.id === s.id ? '正在切换输入方式，草稿保留。' : column && action.hint === 'Enter 发送 · Shift Enter 换行' ? '' : action.hint,
    showNative: column && action.kind === 'send' && s.owner === owner, nativeDisabled: binding.changing || disconnected,
    nativeLabel: `${identity}：原生输入`,
  });
}
function toast(text, action) {
  clearTimeout(toastTimer);
  const old = $('toast').querySelector('.toast-action');
  if (old === document.activeElement) $('toast-close').focus({ preventScroll: true });
  old?.remove(); $('toast-text').textContent = text; $('toast').hidden = false;
  if (action) {
    const open = button(action.label, () => {
      if (!open.isConnected || $('toast').hidden) return;
      $('toast').hidden = true; return action.run();
    }, 'toast-action');
    open.setAttribute('aria-label', action.name || action.label); $('toast').insertBefore(open, $('toast-close'));
  } else toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
function sessionNotice(text, id) {
  const record = state.sessions.find(s => s.id === id);
  toast(text, record && selected !== id && { label: '打开', name: `打开 ${participantLabel(record, state.sessions)}`, run: () => {
    if (selected === id) return;
    if (!state.sessions.some(s => s.id === id)) throw Error('原会话记录已不可用。');
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
  try { await api.copy(text); toast('已复制'); }
  catch (error) { toast('复制失败，请重试。'); throw error; }
};
$('toast-close').onclick = () => { clearTimeout(toastTimer); $('toast').hidden = true; };
async function attempt(action) { try { return await action(); } catch (error) { toast(error.message || '操作未完成。'); } }
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
  }), room: room || { id: spaceId, name: '空间资料未能读取', archived: true, unavailable: true, messages: [], events: [], notes: '', files: [], memberOrder: [] } };
}
function persistView() { normalizeRoomMention(); captureReadingViews(); captureRoomView(); return api.viewState({ readingPositions, panorama: panoramaView, selected, mode, preference, roomSession, terminalLayout, terminalSplit, terminalDisplay, spaceId, sidebarView, sidebarSpaceFilter, roomViews: persistedRoomViews(), sharedDraft: $('shared-input').value, roomRecipient: roomRecipient(), roomMention, roomFilter: $('room-filter').value || pendingRoomFilter, roomSearch: $('room-search').value, roomThread, roomReplyTo }); }
async function selectSpace(id, filter = false) {
  if (!spaceRecord(id)) throw Error('这个空间的资料尚不可用，草稿保留。');
  if (filter) sidebarSpaceFilter = sidebarSpaceFilter === id ? '' : id;
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
        const element = node('div', undefined, 'room-row'), nav = button('', () => selectSpace(room.id, true), 'room-nav'), name = node('span', undefined, 'rail-label'), count = node('span');
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
    row.nav.className = `room-nav ${roomTone(room.id)}`; row.nav.classList.toggle('active', selected === 'room' && spaceId === room.id); row.nav.classList.toggle('space-filtered', sidebarSpaceFilter === room.id);
    row.nav.setAttribute('aria-pressed', String(sidebarSpaceFilter === room.id));
    if (selected === 'room' && spaceId === room.id) row.nav.setAttribute('aria-current', 'page'); else row.nav.removeAttribute('aria-current');
    row.nav.setAttribute('aria-label', `${room.name} · ${members(room.id).length} 位成员 · 点击筛选，再次点击显示全部`); row.nav.title = row.nav.getAttribute('aria-label');
    row.name.textContent = room.id === 'shared' ? `◉ ${room.name}` : room.name; row.count.textContent = members(room.id).length;
    row.more.setAttribute('aria-label', `空间操作：${room.name}`); row.more.title = row.more.getAttribute('aria-label');
  }
  const active = allSpaces().filter(r => !r.archived);
  $('workspace-empty').hidden = Boolean(active.length); document.querySelector('.drop-hint').hidden = !active.length;
  $('workspace-group-summary').textContent = `${active.length} 个空间`;
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
function mergeError(message) { $('space-merge-error').textContent = message || ''; $('space-merge-error').hidden = !message; }
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
    const field = mergeCheckbox(participantLabel(session, state.sessions) + (!available ? ' · 当前后台不可加入新空间' : ''), available && draft.memberChoices.get(session.id), checked => draft.memberChoices.set(session.id, checked));
    field.input.disabled = !available; field.input.dataset.mergeMember = session.id; $('space-merge-members').append(field.label);
  }
  for (const room of chosen) {
    const eligible = room.messages.filter(window.nativeWorkspaceSpaces.completedSharedRecord);
    if (!draft.selections.has(room.id)) draft.selections.set(room.id, { messages: new Set(eligible.map(message => message.id)), files: new Set((room.files || []).map(file => file.id)), events: new Set((room.events || []).map(event => event.id)), notes: true });
    const choice = draft.selections.get(room.id), details = node('details'), summary = node('summary', `${mergeSourceLabel(room, draft.rooms)} · ${eligible.length} 条完整记录`), body = node('div');
    details.append(summary, body); let built = false;
    details.ontoggle = () => {
      if (!details.open || built) return; built = true;
      if (room.notes) body.append(mergeCheckbox('原空间笔记', choice.notes, checked => choice.notes = checked).label);
      for (const [title, records, selectedIds, text] of [
        ['共享记录', eligible, choice.messages, message => `${message.name || message.role} · ${message.text.slice(0, 140) || '原生状态记录'}`],
        ['本机文件引用', room.files || [], choice.files, file => file.name],
        ['空间历史事件', room.events || [], choice.events, event => event.text.slice(0, 140)],
      ]) {
        if (!records.length) continue;
        const section = node('fieldset'), legend = node('legend', title), inputs = [];
        section.append(legend, mergeCheckbox('全部选择', records.every(record => selectedIds.has(record.id)), checked => {
          for (const record of records) checked ? selectedIds.add(record.id) : selectedIds.delete(record.id);
          for (const input of inputs) input.checked = checked;
        }).label);
        for (const record of records) {
          const field = mergeCheckbox(text(record), selectedIds.has(record.id), checked => checked ? selectedIds.add(record.id) : selectedIds.delete(record.id));
          field.input.setAttribute('aria-label', `导入 ${room.name} ${title} ${record.id}`); inputs.push(field.input); section.append(field.label);
          if (record.text) { const full = node('details'), label = node('summary', '原文'); full.append(label, node('pre', record.text)); section.append(full); }
        }
        body.append(section);
      }
      const omitted = room.messages.length - eligible.length;
      if (omitted) body.append(node('p', `${omitted} 条未完成或未确认的记录留在原空间。`, 'quiet'));
    };
    $('space-merge-selection').append(details);
  }
  $('preview-space-merge').disabled = chosen.length < 2 || disconnected;
}
function openSpaceMerge(origin = spaceId) {
  if (!state.capabilities?.includes('spaceMergeV1')) return toast('当前后台尚不支持合并快照；原空间与草稿保留。');
  const rooms = allSpaces().filter(room => !room.archived && !room.unavailable);
  if (rooms.length < 2) return toast('请先准备至少两个协作空间。');
  const ticket = openTransientDialog('space-merge-dialog');
  mergeDialog = { ticket, rooms: structuredClone(rooms), sourceInputs: new Map(), memberChoices: new Map(), selections: new Map(), batch: null, record: null };
  $('space-merge-title').textContent = '合并协作空间'; $('space-merge-name').value = '合并空间'; $('space-merge-disposition').value = 'keep';
  $('space-merge-sources').replaceChildren(); $('space-merge-preview').replaceChildren(); mergeError(''); mergeButtons(false);
  for (const room of rooms) {
    const label = mergeSourceLabel(room, rooms), field = mergeCheckbox(label, room.id === origin, renderMergeChoices); field.input.value = room.id;
    field.input.setAttribute('aria-label', `来源空间：${label}`); mergeDialog.sourceInputs.set(room.id, field.input); $('space-merge-sources').append(field.label);
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
  const element = $('space-merge-preview'); element.replaceChildren(node('h3', batch.name));
  element.append(node('p', `${batch.memberIds.length} 个成员 · ${batch.blocks.reduce((n, block) => n + block.entries.length, 0)} 条完整记录 · ${(batch.bytes / 1024).toFixed(1)} KB`));
  element.append(node('p', batch.disposition === 'archive' ? '确认后归档原空间，暂停它们的后续交接；已开始的工作可能继续。原记录可恢复。' : '原空间继续独立使用；后续新内容不会自动同步到新空间。'));
  for (const block of batch.blocks) {
    const section = node('details'), summary = node('summary', `${mergeSourceLabel({ id: block.roomId, name: block.name }, batch.sources)} · ${block.entries.length} 条记录 · ${block.files.length} 个文件引用`); section.append(summary);
    if (block.notes) { section.append(node('h4', '原笔记'), node('pre', block.notes)); }
    for (const entry of block.entries) { const original = node('details'); original.append(node('summary', `${entry.payload.name || entry.payload.role} · ${entry.payload.text.slice(0, 100) || '原生状态记录'}`), node('pre', entry.payload.text)); section.append(original); }
    for (const file of block.files) section.append(node('p', file.name));
    if (block.omitted.length) section.append(node('p', `${block.omitted.length} 条未完成或未确认记录留在来源中。`, 'quiet'));
    if (block.pending) section.append(node('p', '来源仍有工作；晚到输出不会补入这个快照。', 'quiet'));
    element.append(section);
  }
  $('confirm-space-merge').disabled = Boolean(batch.conflicts.length);
  if (batch.conflicts.length) element.append(node('p', '同一原生会话存在多个归属记录，请先核对；没有合并或派发。', 'warning'));
  if (record) {
    const stage = { preparing: '目标保存待核对', joining: '成员待核对', archiving: '来源归档中', ready: '新空间已保存', partial: '有步骤待核对', failed: '合并未完成', undoing: '正在撤销组织关系', undone: '已撤销合并组织，来源与后来工作保留' }[record.stage];
    element.prepend(node('p', stage || record.stage));
    for (const source of record.sources) element.append(node('p', `${batch.sources.find(value => value.id === source.id)?.name || '来源'}：${batch.disposition === 'keep' ? '保留使用' : ({ done: '已归档', restored: '已恢复', pending: '未归档', failed: '待核对', changed: '后来有变化，保留现状' }[source.status] || source.status)}${source.error ? ` · ${source.error}` : ''}`));
    $('recover-space-merge').hidden = !['failed', 'partial', 'preparing', 'joining'].includes(record.stage) || record.undoStarted;
    $('undo-space-merge').hidden = record.stage === 'undone';
    mergeError(record.warning || record.failures.join('\n'));
  }
}
async function openMergeRecord(id) {
  const room = spaceRecord(id); if (!room?.merge) return;
  const ticket = openTransientDialog('space-merge-dialog'); mergeDialog = { ticket, record: null, batch: null, targetId: id };
  $('space-merge-title').textContent = '合并详情'; mergeButtons(true, true); mergeError(''); $('space-merge-preview').textContent = '正在核对保存记录…';
  for (const key of ['open-space-merge-target', 'undo-space-merge', 'recover-space-merge']) $(key).disabled = true;
  try {
    const record = await api.spaceMerge('status', { operationId: room.merge.operationId });
    if (!currentDialogTicket(ticket)) return;
    mergeDialog.record = record; mergeDialog.batch = record.batch; renderMergeBatch(record.batch, record);
    for (const key of ['open-space-merge-target', 'undo-space-merge', 'recover-space-merge']) $(key).disabled = false;
  } catch (error) { if (currentDialogTicket(ticket)) mergeError(error.message); else toast(error.message); }
}
function openSpaceRegionMenu(point, anchor = $('new-space')) {
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  roomMenu = ui.menu({ items: [{ id: 'create', label: '新建协作空间…' }, { id: 'merge', label: '合并协作空间…', disabled: allSpaces().filter(room => !room.archived).length < 2 }], getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect(), onSelect: action => action === 'merge' ? openSpaceMerge() : openSpaceCreate(), onClose: () => { roomMenu = null; if (anchor.isConnected) anchor.focus({ preventScroll: true }); } });
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
  sessionNotice('已脱出协作', id);
}
function focusTerminal(id = activeSessionId()) {
  if ((terminalCanInput(id) || canCaptureTerminal(id)) && inputFocusAllowed()) terminals.get(id).term.focus();
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
function cancelViewInput(entry, error = new Error('切换已取消；这段输入没有发送。')) {
  const pending = entry?.viewInput; if (!pending) return;
  entry.viewInput = null; pending.cancelled = true;
  if (pending.text) entry.preserveUnconfirmed(pending.text, error);
  pending.reject(error);
}
function canFlushComposition(id, token = terminals.get(id)?.composition) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return Boolean(token && currentTerminalDisplay(entry, record) && !token.cancelled && !token.consumed && entry?.composition === token && !entry.composing && entry.ready && entry.generation === (record?.connectionRevision || 0) && nativeUsable(record) && record.owner === owner && record.view === 'terminal' && !state?.roomStorageWarning && !disconnected);
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
  if (!terminalCanInput(id)) throw new Error('请先连接并接管这个终端。');
  if (!text) return;
  if (text.length > 65500) throw new Error('粘贴内容过长，请分段粘贴。');
  if (/[\r\n]/.test(text) && !entry.term.modes.bracketedPasteMode) throw new Error('原生程序尚未启用多行粘贴保护，请先分行粘贴。');
  entry.term.paste(text); focusTerminal(id);
}
const imageFiles = transfer => Array.from(transfer?.files || []).filter(file => file.type.startsWith('image/'));
async function pasteImages(files, staged, id = activeSessionId()) {
  const binding = sessionComposers.get(id), column = Boolean(binding?.column), bindingRevision = binding?.revision;
  const revision = selectionRevision, intended = state.sessions.find(s => s.id === id);
  if (column) {
    const fresh = await api.initial();
    if (!composerCurrent(binding) || !binding.column || binding.revision !== bindingRevision) throw Error('此列已变化，图片没有放入。');
    updateState(fresh);
  }
  const s = state.sessions.find(s => s.id === id), nativeId = intended?.nativeId, control = s?.controlRevision, generation = intended?.connectionRevision || 0;
  const valid = () => {
    const fresh = state.sessions.find(s => s.id === id);
    return fresh?.nativeId === nativeId && fresh.controlRevision === control && (fresh.connectionRevision || 0) === generation && !fresh.nativeContextPending && fresh.owner === owner && fresh.terminalState?.alive && ['idle', 'working'].includes(fresh.state) &&
      (column ? composerCurrent(binding) && binding.column && binding.revision === bindingRevision : selectionRevision === revision && activeSessionId() === id);
  };
  if (!s || !['codex', 'claude'].includes(s.provider) || !valid()) throw Error('请先连接并接管原生终端；图片没有放入。');
  if (!staged && (files.length > 4 || files.reduce((n, file) => n + file.size, 0) > 20 * 1024 * 1024)) throw Error('每次可放入 1–4 张图片，总大小不超过 20 MB。');
  const paths = staged || await api.stageImages(id, nativeId, await Promise.all(files.map(async file => new Uint8Array(await file.arrayBuffer()))));
  if (!valid()) throw Error('会话或控制权已变化，图片没有放入终端。');
  let terminalRevision = revision;
  if (column) { if (!await activateColumnNative(binding)) throw Error('未能启用此列的原生输入，图片没有放入。'); }
  else { const switching = switchMode('terminal'); terminalRevision = selectionRevision; await switching; }
  const fresh = state.sessions.find(s => s.id === id);
  if (fresh?.nativeId !== nativeId || fresh.nativeContextPending || fresh.owner !== owner || !['idle', 'working'].includes(fresh.state) ||
      (column ? !composerCurrent(binding) || binding.revision !== bindingRevision : selectionRevision !== terminalRevision || activeSessionId() !== id) || !terminalCanInput(id)) throw Error('原生输入已变化，图片没有放入终端。');
  for (const file of paths) pasteTerminal(JSON.stringify(file), id);
  revealTerminalCursor(terminals.get(id));
  toast('图片已放入本会话的原生输入框，确认后发送。对话草稿保留，分开发送。');
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
  if (status === 'last-known') return `上次连接 Codex ${s.nativeVersion} · 当前未确认`;
  if (status === 'verified') return `Codex ${s.nativeVersion} · 核心接口已验证`;
  if (status === 'unverified') return `Codex ${s.nativeVersion || '版本未确认'} · 此版本尚未验证：工作中追加、原生上下文切换和历史同步请在终端核对`;
  return 'Codex 原生版本未报告';
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
  $('clear-shared-history').textContent = `清除「${spaceRecord(trustClearRoom)?.name || '空间'}」的共享记录…`;
  trustScope = scope; dialog.dataset.mode = scope ? 'usage' : 'privacy';
  dialog.querySelector('h2').textContent = scope ? `${scope.name} · 用量` : '隐私与用量';
  if (!wasOpen) dialog.showModal();
  trustLoading = true;
  $('refresh-trust').disabled = true; $('refresh-trust').textContent = '正在刷新…';
  $('trust-refresh-status').textContent = '正在读取本机状态…';
  dialog.setAttribute('aria-busy', 'true');
  const fresh = () => dialog.isConnected && dialog.open && generation === trustRevision;
  try {
  const snapshot = await api.initial();
  if (!fresh()) return;
  if (scope && revision !== selectionRevision) { $('trust-refresh-status').textContent = '查看范围已变化，请关闭后重新查看。'; return; }
  const content = $('trust-status'); content.replaceChildren();
  const section = (title, text) => { const item = node('section'); item.append(node('h3', title), node('p', text)); content.append(item); return item; };
  if (!scope) {
  section('数据去向', '会话副本和草稿保存在本机。原始终端画面只在本机内存暂存；对话中已显示的结构化工具输入与结果会随记录保存在本机，受保留上限约束，不自动分享。你发出的任务由所选原生服务处理；工具还可能访问其他网站。加入协作不会自动分享私人历史。');
  section('模型调用与费用', '外壳未启用自动标题、摘要或模型路由。每轮核查由你确认 2–6 次回复上限和 10 分钟期限；原生工具和子 agent 的用量不受这些交接限制约束。');
  const dispatches = snapshot.diagnostics?.dispatches;
  section('应用派发记录', `${Number.isSafeInteger(dispatches) ? dispatches + ' 次' : '未报告'}。包含未确认或被拒绝的尝试，不代表付费调用；不含原生终端直接输入，也不是总用量或账单。普通后台计数从本次运行开始，旧会话输入连接保留本地发送计数。`);
  if (snapshot.sessions.some(s => s.legacyInputEligible)) section('原会话输入连接', '接通 Claude 会在其工作目录添加本地插件，代码不含凭据；Codex 连接原生私有接口，不安装 Claude 插件。连接凭据留在本机私有目录。加载插件和切换界面不发起模型任务。独立输入仅记录派发元数据；你明确共享的正文、收件人名称会本地保存。清除共享记录会移除这些正文，保留派发计数；不会撤回 agent 已收到的内容。');
  }
  const usage = section(scope ? '原生读数' : '原生报告的用量', '来自原生接口的最近读数，可能延迟或缺少子任务。上下文占用、累计 token 和额度是不同指标；金额请在提供商账户核对。刷新此页不会发起模型请求。');
  const sessions = !scope ? snapshot.sessions : scope.kind === 'room'
    ? snapshot.sessions.filter(s => inSpace(s, scope.roomId) && !s.archived)
    : snapshot.sessions.filter(s => s.id === scope.id && s.nativeId === scope.nativeId && !s.nativeContextPending);
  for (const s of sessions) {
    const item = node('section'); item.dataset.usageSession = s.id;
    item.append(node('h4', participantLabel(s, snapshot.sessions)), node('p', s.nativeContextPending ? '原生上下文待核对' : s.model || '模型未报告'));
    for (const line of window.nativeWorkspaceUsage.usageLines(s.provider, s.nativeContextPending ? null : s.usage)) item.append(node('p', line));
    usage.append(item);
  }
  if (!sessions.length) usage.append(node('p', scope?.kind === 'session' ? '原会话或原生上下文已变化，请关闭后重新查看。' : '当前范围尚无会话。'));
  if (!scope) {
  section('后台与权限', `${snapshot.sessions.filter(s => !['ended', 'recoverable'].includes(s.state)).length} 个会话尚未确认结束。关闭窗口仍可能继续执行。原生进程、团队状态与权限请在终端核对；此处未测量 CPU、内存或完整网络出口。`);
  section('版本与核查', `应用 ${snapshot.appVersion || '未报告'} · 新会话后台 ${snapshot.runtimeVersion || '未报告'}。${snapshot.services?.length > 1 ? `另保留 ${snapshot.services.length - 1} 个后台连接原有会话；没有复制原生会话。` : ''}可查看本机数据和公开实现。本地版本号不是签名验证；独立安全审计、完整流量与费用对账尚未完成。`);
  }
  dialog.scrollTop = wasOpen ? scroll : 0;
  $('trust-refresh-status').textContent = '已刷新本机状态 · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (error) {
    if (fresh()) $('trust-refresh-status').textContent = '读取本机状态失败：' + (error.message || '请重试。');
  } finally {
    if (fresh()) {
      trustLoading = false; $('refresh-trust').disabled = false; $('refresh-trust').textContent = '刷新状态';
      dialog.removeAttribute('aria-busy');
    }
  }
}
$('privacy-dialog').addEventListener('close', event => {
  const dialog = event.currentTarget; if (dialog.open || !dialog.isConnected) return;
  trustRevision++; trustScope = null; trustLoading = false;
  $('trust-status').replaceChildren(); $('trust-refresh-status').textContent = '';
  $('refresh-trust').disabled = false; $('refresh-trust').textContent = '刷新状态';
  dialog.querySelector('h2').textContent = '隐私与用量'; dialog.scrollTop = 0; dialog.removeAttribute('aria-busy');
  for (const detail of dialog.querySelectorAll('details')) detail.open = false;
});

function openCreate(provider = 'claude') {
  if (creatingSession) return;
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
  $('initial-view').value = preference; $('session-name').value = ''; $('claude-history-id').value = ''; $('skip-permissions').checked = false;
  resetCreateDirectory(); $('create-error').textContent = ''; openTransientDialog('create-dialog'); createReadiness();
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
  gitPreviewLoading = true; $('git-worktree-preview').textContent = '正在读取已提交快照；尚未创建目录或分支。'; createReadiness();
  try {
    const plan = await api.gitWorktreePreview(source, nonce, relative);
    if (!current()) return;
    gitWorktreePlan = plan;
    $('git-worktree-preview').textContent = `来源：${plan.repository}\n提交：${plan.revision.slice(0, 12)} · 新分支：${plan.branch}\n工作目录：${plan.cwd}`;
    $('chosen-folder').textContent = plan.cwd;
  } catch (error) {
    if (current()) { gitWorktreePlan = null; $('git-worktree-preview').textContent = error.message; }
  } finally { if (current()) { gitPreviewLoading = false; createReadiness(); } }
}
function scheduleGitPreview() {
  invalidateGitPreview();
  $('chosen-folder').textContent = folder;
  if ($('git-worktree').checked) {
    $('git-worktree-preview').textContent = '等你填写后读取副本内目录…';
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
    const text = node('span'); text.append(node('strong', row.name || '未命名 Codex 会话'), node('small', row.cwd), node('small', `${row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleString() : '更新时间未报告'}${row.existingIds?.length ? ' · 已在工作台中' : ''}`));
    label.append(input, text); list.append(label);
    input.onchange = () => { historySelected = row.nativeId; updateNativeHistoryControls(); };
  }
  updateNativeHistoryControls();
}
function updateNativeHistoryControls() {
  if (!$('native-history-dialog').open) return;
  const row = historyRows.find(r => r.nativeId === historySelected), busy = historyLoading || historyImporting;
  $('confirm-native-history').disabled = busy || !row || row.existingIds?.length > 1;
  $('confirm-native-history').textContent = historyImporting ? '正在连接…' : row?.existingIds?.length ? '查看已有会话' : '继续所选会话';
  $('more-native-history').hidden = !historyCursor; $('more-native-history').disabled = busy;
  $('search-native-history').disabled = busy; $('native-history-search').disabled = busy;
  $('close-native-history').disabled = historyImporting;
}
async function loadNativeHistory(more = false) {
  if (historyLoading || historyImporting || !$('native-history-dialog').open) return;
  const generation = ++historyGeneration; historyLoading = true;
  if (!more) { historySearch = $('native-history-search').value; historyRows = []; historySelected = null; historyCursor = null; }
  renderNativeHistory(); $('native-history-status').textContent = '正在读取本机原生索引…';
  try {
    const result = await api.nativeHistory({ search: historySearch, ...(more ? { cursor: historyCursor } : {}) });
    if (generation !== historyGeneration || !$('native-history-dialog').open) return;
    const seen = new Set(historyRows.map(r => r.nativeId)); historyRows.push(...result.data.filter(r => !seen.has(r.nativeId))); historyCursor = result.nextCursor;
    $('native-history-status').textContent = historyRows.length ? `已显示 ${historyRows.length} 个会话` : '没有找到会话。可修改名称重试；这里只读取原生索引，不修复或扫描历史文件。';
  } catch (error) { if (generation === historyGeneration && $('native-history-dialog').open) $('native-history-status').textContent = error.message; }
  finally { if (generation === historyGeneration) { historyLoading = false; renderNativeHistory(); } }
}
$('open-native-history').onclick = () => {
  // Claude has no history API: its own session picker opens in the new row's
  // terminal, and the chosen session is forked while the original stays as is.
  if (document.querySelector('input[name="provider"]:checked').value === 'claude') return attempt(async () => {
    const ticket = dialogTickets.get($('create-dialog')), revision = selectionRevision;
    if (!currentDialogTicket(ticket) || creatingSession) return;
    if (newDirectory) throw Error('从历史会话分支或接管前，请先选择原工作目录。');
    const nativeId = $('claude-history-id').value.trim();
    if (nativeId && !state.capabilities?.includes('claudeHistory')) throw Error('当前后台尚不支持 Claude 接管；保留输入，请先连接新版后台。');
    creatingSession = true; createReadiness();
    try {
    const id = nativeId ? await api.importHistory(nativeId, { provider: 'claude', cwd: folder, name: $('session-name').value, skipPermissions: $('skip-permissions').checked })
      : await api.create({ provider: 'claude', cwd: folder, name: $('session-name').value, view: 'terminal', fork: 'picker', skipPermissions: $('skip-permissions').checked || undefined });
    updateState(await api.initial()); render();
    if (currentDialogTicket(ticket) && revision === selectionRevision) { $('create-dialog').close(); await select(id, 'terminal'); }
    else toast('此前请求的会话已保留在侧栏。');
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
  $('native-history-list').replaceChildren(); $('native-history-search').value = ''; $('native-history-status').textContent = '';
});
$('confirm-native-history').onclick = async () => {
  if (!$('native-history-dialog').open || historyImporting || historyLoading || !historyRows.some(r => r.nativeId === historySelected)) return;
  const generation = historyGeneration, revision = selectionRevision;
  const fresh = () => $('native-history-dialog').open && generation === historyGeneration;
  historyImporting = true; renderNativeHistory(); $('native-history-status').textContent = '正在连接所选原生历史；不会重发旧任务。';
  try {
    const id = await api.importHistory(historySelected); updateState(await api.initial()); render();
    if (fresh() && revision === selectionRevision) { $('native-history-dialog').close(); await select(id, 'chat'); }
    else toast('此前连接的原会话已保留在侧栏。');
    if (state.sessions.find(s => s.id === id)?.archived) toast('这是已归档的原会话；可从“归档”恢复，没有创建副本。');
  } catch (error) { if (fresh()) $('native-history-status').textContent = error.message; else toast(error.message); }
  finally { historyImporting = false; renderNativeHistory(); }
};
function openRename(id, origin, roomId = spaceId) {
  const record = id === 'room' ? spaceRecord(roomId) : state.sessions.find(s => s.id === id); if (!record) return;
  if (renaming) return toast('名称正在保存，请稍候。');
  if (renameTarget) {
    if (renameTarget.id === id && (id !== 'room' || renameTarget.roomId === roomId) || $('rename-name').value !== renameTarget.originalName) {
      ui.revealSidebar(); $('rename-name').focus(); return toast('请先保存或取消正在编辑的名称。');
    }
    closeRename(false);
  }
  const row = id === 'room' ? spaceRows.get(roomId)?.element : origin?.closest('.session-row') || sessionRow(id)?.element;
  if (!row || record.archived || id === 'room' && spaceRecord(roomId)?.archived) return;
  renameTarget = { id, roomId, origin, originalName: record.name, row, label: id === 'room' ? spaceRows.get(roomId).name : [...sessionRows.values()].find(r => r.element === row).name };
  renameRevision++; renameComposing = false; $('rename-name').value = record.name;
  $('rename-label').textContent = id === 'room' ? '工作区名称' : '会话名称';
  $('rename-error').hidden = true; $('rename-error').textContent = '';
  row.classList.add('is-renaming'); renameTarget.label.hidden = true;
  row.append($('rename-editor')); $('rename-editor').hidden = false; ui.revealSidebar();
  render(); $('rename-name').focus(); $('rename-name').select();
}
function renameProblem(target = renameTarget) {
  if (!target) return '';
  const record = target.id === 'room' ? spaceRecord(target.roomId) : state.sessions.find(s => s.id === target.id);
  if (!record || record.archived) return '原记录已归档或不可用。输入保留，可取消编辑或恢复原记录后重试。';
  if (record.name !== target.originalName) return '名称已在另一处更改。输入保留，请取消后重新编辑。';
  if (disconnected) return '本地服务未连接，名称输入已保留。';
  return '';
}
function showRenameError(message, kind = 'save') {
  if ($('rename-error').textContent !== message) $('rename-error').textContent = message;
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
    row.status.textContent = record?.archived ? '已归档 · 名称尚未保存' : '记录不可用 · 名称尚未保存';
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
    items: [{ id: 'create', label: '新建协作空间…' }, { id: 'merge', label: '合并协作空间…', disabled: allSpaces().filter(room => !room.archived).length < 2 }, ...(room.merge ? [{ id: 'merge-record', label: '合并详情…' }] : []), { id: 'rename', label: '重命名…' }, { id: 'notes', label: '共享笔记' }, { id: 'files', label: '空间文件…' }, { id: 'usage', label: '用量' }, { id: 'about', label: '协作说明' }, ...(state.wakePolicy ? [{ id: 'wake-global', label: state.wakePolicy.enabled ? '关闭所有 agent 自动消息' : '允许 agent 自动消息' }] : []), { id: 'archive', label: '归档工作区' }],
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
      else if (action === 'about') toast('你决定谁参与、分享什么、什么时候停。成员原文和状态分别来自各自的原生会话；子任务状态只包含已观察到的部分。');
      else if (action === 'archive') attempt(async () => { await api.spaceAction(id, 'archive', []); toast('工作区已归档。原生任务仍可能运行，可从归档列表恢复。'); });
    },
  });
  roomMenu.key = key; roomMenu.anchor = anchor; roomMenu.roomId = id;
}
function openSessionMenu(id, point, rowKey = id) {
  contentMenu?.close(); if (disconnected || !state.sessions.some(s => s.id === id)) return;
  if (!point && sessionMenu?.rowKey === rowKey && !sessionMenu.anchor) { sessionMenu.close(); return; }
  sessionMenu?.close(); roomMenu?.();
  const row = sessionRows.get(rowKey) || sessionRow(id); if (!row) return;
  row.more.focus(); row.more.setAttribute('aria-expanded', 'true');
  const record = state.sessions.find(s => s.id === id), group = row.spaceId;
  const visible = group ? orderedMembers(group) : sidebarSessions(), index = visible.findIndex(s => s.id === id);
  const roomItems = allSpaces().filter(r => !r.archived).map(r => ({ id: `membership:${r.id}`, label: `${inSpace(record, r.id) ? '离开' : '加入'}「${r.name}」` }));
  const close = ui.menu({
    items: [{ id: 'rename', label: '重命名…' }, ...(index > 0 ? [{ id: 'up', label: '上移' }] : []), ...(index < visible.length - 1 ? [{ id: 'down', label: '下移' }] : []), { id: 'copy-id', label: '复制完整 NAW ID' }, ...(record.nativeId ? [{ id: 'copy-native-id', label: '复制完整原生 ID' }] : []), ...roomItems, { id: 'window', label: '在独立窗口打开' }, ...((record.serviceCapabilities || state.capabilities || []).includes('agentWakeV1') ? [{ id: 'wake-session', label: record.wakeDisabled ? '允许其他 agent 叫醒' : '禁止其他 agent 叫醒' }] : []), ...((record.serviceCapabilities || state.capabilities || []).includes('observe') ? [] : [{ id: 'continue', label: '更新原会话连接' }]), { id: 'archive', label: '归档会话' }],
    getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : row.more.getBoundingClientRect(),
    onClose: () => { sessionMenu = null; row.more.setAttribute('aria-expanded', 'false'); if (row.more.isConnected && row.more.getClientRects().length) row.more.focus({ preventScroll: true }); else focusSessionAction(id); },
    onSelect: action => {
      if (action.startsWith('membership:')) {
        const destination = action.slice(11), person = state.sessions.find(s => s.id === id);
        attempt(() => inSpace(person, destination) ? detach(id, destination) : addToSpace(id, destination));
      } else if (action === 'wake-session') attempt(() => api.wakePolicy(id, Boolean(state.sessions.find(s => s.id === id)?.wakeDisabled)));
      else if (action === 'up' || action === 'down') attempt(() => group ? moveRoomMember(id, action === 'up' ? visible[index - 1]?.id : visible[index + 1]?.id, action === 'down', group) : moveSidebarSession(id, action === 'up' ? visible[index - 1]?.id : visible[index + 1]?.id, action === 'down'));
      else if (action === 'copy-id' || action === 'copy-native-id') attempt(() => api.copy(action === 'copy-id' ? id : state.sessions.find(s => s.id === id)?.nativeId));
      else if (action === 'rename') openRename(id, row.more);
      else if (action === 'continue') attempt(() => api.continueConnection(id));
      else if (action === 'window') attempt(() => api.newWindow(id));
      else if (action === 'archive') attempt(async () => { await api.archiveSession(id); toast('会话已归档。原生任务仍可能运行，可从归档列表恢复。'); });
    },
  });
  sessionMenu = { id, rowKey, close };
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
    items: [{ id: 'detach', label: '脱出协作' }, { id: 'copy-id', label: '复制完整 NAW ID' },
      ...(reorder && index > 0 ? [{ id: 'earlier', label: '上移' }] : []),
      ...(reorder && index < people.length - 1 ? [{ id: 'later', label: '下移' }] : [])],
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
      if (key !== memberMenuKey(id)) return toast('成员已变化，请重新打开菜单。');
      if (action === 'copy-id') attempt(() => api.copy(id));
      else if (action === 'detach') attempt(() => detach(id));
      else if (action === 'earlier' || action === 'later') {
        const people = orderedMembers(), index = people.findIndex(s => s.id === id), target = people[index + (action === 'earlier' ? -1 : 1)];
        if (!target) return toast('已经位于列表边界，顺序未更改。');
        attempt(async () => { captureReadingViews(); restoreOverviewReading(); toast(await moveRoomMember(id, target.id, action === 'later')); });
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
  return backend ? { kind: old ? 'old' : 'different', label: old ? '旧后台' : '版本不同', title: `后台 ${backend} · 应用 ${application || '版本未报告'}；${old ? '更新这个会话的后台后使用新版。' : '不能据此判断后台较旧。'}后台仅报告版本号。` }
    : { kind: 'unknown', label: '版本未知', title: '这个会话的后台未报告版本，不能用新会话后台的版本代替。' };
}
function backendVersionSummary(records, applicationVersion) {
  const unique = new Map(records.filter(record => !record.archived).map(record => [record.id, record]));
  const result = { old: 0, different: 0, unknown: 0, count: 0, label: '' };
  for (const record of unique.values()) {
    const notice = backendVersionNotice(record, applicationVersion);
    if (notice) { result[notice.kind]++; result.count++; }
  }
  result.label = [result.old && `${result.old} 个旧后台会话`, result.different && `${result.different} 个版本不同`, result.unknown && `${result.unknown} 个版本未知`].filter(Boolean).join(' · ');
  return result;
}
function appVersionReport(snapshot) {
  const version = versionValue(snapshot.appVersion) || '未报告', commit = snapshot.appBuild?.commit;
  const installedAt = snapshot.appBuild?.installedAt;
  const installation = typeof installedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(installedAt) &&
    Number.isFinite(Date.parse(installedAt)) && new Date(installedAt).toISOString() === installedAt ? installedAt : '未记录';
  const lines = ['Native Agent Workspace', '应用版本：' + version,
    '提交号：' + (typeof commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ? commit : '未记录'),
    '安装时间：' + installation, '后台仅报告版本号，未报告提交号。'];
  for (const [i, service] of (Array.isArray(snapshot.services) ? snapshot.services : []).entries()) {
    lines.push(`后台 ${i + 1}：${versionValue(service.version) || '未报告'} · ${service.active ? '新会话' : '保留会话'} · ${Number.isSafeInteger(service.sessions) && service.sessions >= 0 ? service.sessions : '未知'} 个会话`);
  }
  return lines.join('\n');
}
function renderVersions() {
  const version = versionValue(state.appVersion) || '未报告', control = $('app-version');
  $('app-version-label').textContent = 'v' + version;
  $('app-version-compact').textContent = compactAppVersion(state.appVersion);
  control.setAttribute('aria-label', `应用 ${version}，复制版本信息`);
  control.title = `应用 ${version} · 点击复制版本信息`;
  const summary = backendVersionSummary(state.sessions, state.appVersion), action = $('backend-version-summary');
  action.hidden = summary.count === 0;
  if (!summary.count || disconnected) { backendVersionTicket++; backendVersionMenu?.(); backendVersionMenu = null; }
  if (!checkingBackendVersions) action.textContent = summary.old ? `${summary.old} 旧版会话${summary.count > summary.old ? ` +${summary.count - summary.old}` : ''}` : `${summary.count} 会话待核对`;
  action.title = `${summary.label}；按未归档的独立会话计数。核对后仅能更新已结束的连接，其他原会话继续保留。`;
  action.setAttribute('aria-label', action.title); action.disabled = disconnected;
  action.setAttribute('aria-disabled', String(disconnected || checkingBackendVersions)); action.setAttribute('aria-busy', String(checkingBackendVersions));
}
$('app-version').onclick = () => { if (state) return ui.copyCode(appVersionReport(state)).catch(() => {}); };
let checkingBackendVersions = false, backendVersionMenu, backendVersionTicket = 0;
async function openBackendVersions() {
  const control = $('backend-version-summary');
  if (checkingBackendVersions || disconnected || !state) return;
  backendVersionMenu?.(); backendVersionMenu = null;
  const ticket = ++backendVersionTicket, revision = selectionRevision;
  checkingBackendVersions = true; control.setAttribute('aria-disabled', 'true'); control.setAttribute('aria-busy', 'true'); control.textContent = '正在核对后台…';
  try {
    const options = await api.connectionUpdates();
    if (ticket !== backendVersionTicket || revision !== selectionRevision || disconnected || !control.isConnected || document.activeElement !== control || document.querySelector('dialog[open]')) return;
    if (!options.length) return toast('当前没有需要核对的旧后台连接。');
    backendVersionMenu = ui.menu({
      items: options.map((option, index) => ({ id: String(index), label: `${versionValue(option.version) || '版本未知'} · ${option.count} 个会话 · ${option.ready ? '核对并更新连接…' : '保留连接，查看原因'}` })),
      getAnchorRect: () => control.getBoundingClientRect(),
      onClose: () => { backendVersionMenu = null; if (revision === selectionRevision && control.isConnected && !control.hidden) control.focus({ preventScroll: true }); },
      onSelect: key => {
        const option = options[Number(key)];
        if (!option || ticket !== backendVersionTicket) return;
        if (!option.ready) return toast(option.reason);
        attempt(async () => {
          const updated = await api.continueConnection(option.id, { backendKey: option.backendKey, nativeId: option.nativeId, version: option.version });
          if (updated) toast('这个后台的连接已更新；原生任务没有自动重发。');
        });
      },
    });
  } finally { checkingBackendVersions = false; renderVersions(); }
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
  const visible = state.sessions.filter(s => !s.archived);
  const working = visible.filter(s => s.state === 'working').length;
  $('session-group-summary').textContent = `${visible.length}${working ? ` · ${working} 工作中` : ''}`;
  $('workspace-group-summary').textContent = state.room.archived ? '0' : `${members().length} 成员`;
  for (const [section, control, body] of [['sessions', 'solo-drop', 'session-list'], ['workspace', 'workspace-toggle', 'workspace-group-body'], ['archive', 'archive-button', 'archive-group-body']]) {
    const collapsed = section === 'archive' ? state.sidebar?.archiveCollapsed !== false : Boolean(state.sidebar?.[section + 'Collapsed']), toggle = $(control);
    const name = { sessions: '会话', workspace: '协作空间', archive: '归档' }[section];
    toggle.setAttribute('aria-label', section === 'archive' ? `归档 · ${state.sessions.filter(s => s.archived).length + Number(Boolean(state.room.archived))} 项` : `${name} · ${$(section === 'sessions' ? 'session-group-summary' : 'workspace-group-summary').textContent}`);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.querySelector('.group-chevron').textContent = collapsed ? '▸' : '▾';
    if (collapsed && $(body).contains(document.activeElement)) { sessionMenu?.close(); roomMenu?.(); toggle.focus(); }
    $(body).hidden = collapsed;
    toggle.title = `${collapsed ? '展开' : '折叠'}${section === 'sessions' ? '会话；把协作成员拖到这里独立使用' : name}`;
  }
  sidebarLayout?.update(state.sidebar);
}
function renderSessions() {
  renderVersions(); renderSidebarGroups();
  const visible = sidebarSessions().filter(s => !sidebarSpaceFilter || inSpace(s, sidebarSpaceFilter));
  const grouped = sidebarView === 'grouped', occurrences = [], containers = new Map();
  const list = $('session-list');
  $('sessions-flat').setAttribute('aria-pressed', String(!grouped)); $('sessions-grouped').setAttribute('aria-pressed', String(grouped));
  $('clear-space-filter').hidden = !sidebarSpaceFilter;
  $('clear-space-filter').title = sidebarSpaceFilter ? `清除「${spaceRecord(sidebarSpaceFilter)?.name || '空间'}」筛选` : '';
  if (grouped) {
    const groups = allSpaces().filter(r => !r.archived && (!sidebarSpaceFilter || r.id === sidebarSpaceFilter)).map(r => ({ id: r.id, name: r.name, people: orderedMembers(r.id).filter(s => visible.includes(s)) }));
    if (!sidebarSpaceFilter) groups.push({ id: '', name: '独立会话', people: visible.filter(s => !window.nativeWorkspaceSpaces.roomIds(s).length) });
    groups.forEach((group, index) => {
      let entry = sidebarGroups.get(group.id);
      if (!entry) {
        const element = node('section', undefined, 'session-space-group'), heading = node('h3'), body = node('div');
        const title = group.id ? button('', () => selectSpace(group.id, true)) : node('span'); heading.append(title); element.append(heading, body); element.dataset.sessionGroup = group.id || 'independent';
        if (group.id) { bindSpaceHighlight(element, group.id); dropTarget(element, true, group.id); }
        entry = { element, title, body }; sidebarGroups.set(group.id, entry);
      }
      entry.title.textContent = `${group.name} · ${group.people.length}`; entry.title.className = group.id ? `session-space-heading ${roomTone(group.id)}` : 'session-space-heading';
      if (group.id) entry.title.setAttribute('aria-label', `打开协作空间「${group.name}」`);
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
      const label = node('span', undefined, 'label'), name = node('span'), shortId = node('span', undefined, 'session-short-id'), status = node('small'), badges = node('span', undefined, 'session-space-badges'), dot = node('span'), version = node('span', undefined, 'session-backend-version');
      version.setAttribute('aria-hidden', 'true'); label.append(name, version, shortId, badges, status); link.append(icon(record.provider), label, dot);
      const more = button('⋯', () => openSessionMenu(record.id, undefined, key), 'session-more'); more.dataset.sessionMenu = record.id;
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('pointerdown', event => { if (sessionMenu?.rowKey === key) event.stopPropagation(); });
      element.addEventListener('contextmenu', event => { if (event.target.closest('#rename-editor')) return; event.preventDefault(); openSessionMenu(record.id, { x: event.clientX, y: event.clientY }, key); });
      element.addEventListener('keydown', event => { if (event.target.closest('#rename-editor')) return; if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openSessionMenu(record.id, undefined, key); } });
      element.append(link, more); row = { element, link, more, name, shortId, badges, status, dot, version, sessionId: record.id, spaceId: group }; sessionRows.set(key, row);
    }
    const memberships = allSpaces().filter(r => !r.archived && inSpace(record, r.id)), membershipNames = memberships.map(r => r.name).join('、');
    const label = `${record.name} · ${record.provider === 'claude' ? 'Claude' : 'Codex'} · ${sessionShortId(record.id)} · ${sessionStatus(record, true)}`;
    const association = memberships.length ? `所属空间：${membershipNames}` : '独立会话';
    const occurrence = grouped && memberships.length > 1 ? ' · 同一会话在多个空间显示，原生身份相同' : '';
    const version = backendVersionNotice(record, state.appVersion);
    row.link.disabled = false; row.link.setAttribute('aria-label', `${label} · ${association}${occurrence} · ${sessionTimes(record)}${version ? ' · ' + version.title : ''}`); row.link.title = `${label}\n${association}${occurrence}\n${sessionTimes(record)}${version ? '\n' + version.title : ''}`;
    const badgeKey = JSON.stringify(memberships.map(r => [r.id, r.name]));
    if (row.badgeKey !== badgeKey) {
      row.badges.replaceChildren(...memberships.slice(0, 2).map(r => { const badge = node('span', r.name.length > 6 ? r.name.slice(0, 6) + '…' : r.name, `space-badge ${roomTone(r.id)}`); badge.title = r.name; return badge; }));
      if (memberships.length > 2) { const more = node('span', `+${memberships.length - 2}`, 'space-badge space-badge-more'); more.title = membershipNames; row.badges.append(more); }
      row.badges.setAttribute('aria-label', association); row.badgeKey = badgeKey;
    }
    row.version.textContent = version?.label || ''; row.version.title = version?.title || ''; row.version.hidden = !version;
    row.link.classList.toggle('active', record.id === selected); row.element.classList.toggle('active', record.id === selected);
    if (record.id === selected) row.link.setAttribute('aria-current', 'page'); else row.link.removeAttribute('aria-current');
    row.more.setAttribute('aria-label', `会话操作：${record.name} · ${sessionShortId(record.id)}${group ? ` · ${spaceRecord(group)?.name}` : ''}`); row.more.title = row.more.getAttribute('aria-label'); row.more.disabled = disconnected || renameTarget?.id === record.id;
    row.name.textContent = record.name; row.shortId.textContent = sessionShortId(record.id); row.status.textContent = `${sessionStatus(record, true)} · ${sessionActivityTime(record)}`; row.dot.className = `state-dot ${record.state}`;
    const index = positions.get(container) || 0, slot = container.children[index]; if (slot !== row.element) container.insertBefore(row.element, slot || null); positions.set(container, index + 1);
  }
  highlightSpace(hoverSpace);
}

function createReadiness() {
  if (!$('create-dialog').open) return;
  const historyProvider = document.querySelector('input[name="provider"]:checked').value;
  $('open-native-history').hidden = !state.capabilities?.includes(historyProvider === 'codex' ? 'nativeHistory' : 'claudeFork');
  $('claude-history-id-option').hidden = historyProvider !== 'claude' || !state.capabilities?.includes('claudeHistory');
  if ($('claude-history-id-option').hidden) $('claude-history-id').value = '';
  const takeover = historyProvider === 'claude' && $('claude-history-id').value.trim();
  const gitSelected = $('git-worktree').checked, gitSupported = state.capabilities?.includes('gitWorktreeV1');
  $('git-worktree-option').hidden = !gitSupported && !gitSelected;
  $('git-worktree').disabled = creatingSession || newDirectory || Boolean(takeover) || (!gitSupported && !gitSelected);
  $('git-worktree-details').hidden = !gitSelected;
  $('git-worktree-relative').disabled = creatingSession;
  if (gitSelected && !gitSupported) {
    invalidateGitPreview();
    $('chosen-folder').textContent = folder;
    $('git-worktree-preview').textContent = '后台不支持此工作副本。请重新连接，或明确取消这个选项后使用原目录；不会自动改用原目录。';
  }
  $('open-native-history').textContent = historyProvider === 'codex' ? '继续已有 Codex 会话…' : takeover ? '接管此 Claude 会话' : '从已有 Claude 会话分支…';
  $('open-native-history').disabled = creatingSession || gitSelected || (historyProvider === 'claude' && newDirectory);
  if (historyProvider === 'claude' && newDirectory) $('open-native-history').textContent = '选择原目录后分支或接管…';
  $('new-folder').hidden = !state.capabilities?.includes('newSessionDirectory');
  $('new-folder').disabled = $('choose-folder').disabled = creatingSession;
  $('cancel-create').disabled = false;
  // Only Codex starts differently: either this app or its TUI creates the native thread.
  // A Claude session opens in the last-used tab; both views stay available.
  $('initial-view').hidden = $('initial-view-label').hidden = historyProvider !== 'codex';
  // Only a service that applies the choice may offer it; an older one would silently ignore it.
  $('skip-permissions-option').hidden = !state.capabilities?.includes('createSkipPermissions');
  if ($('skip-permissions-option').hidden) $('skip-permissions').checked = false;
  const directoryNote = gitSelected ? '只在副本准备完成后启动一个新的原生会话。' : newDirectory ? '创建时自动新建此空目录。' : '使用上方已有目录，多个会话可能共用。';
  $('create-permission-note').textContent = directoryNote + ($('skip-permissions').checked
    ? '这个会话里 agent 运行命令、改文件都不再问你，plan 模式也不拦；只在信任的文件夹里使用。'
    : '原生可能要求确认文件夹信任；文件和命令权限仍由原生确认。');
  if (!state.capabilities?.includes('nativePermissionDefaults')) {
    $('confirm-create').disabled = true;
    $('create-readiness').textContent = '新版后台尚未连接，暂不能新建。请重新打开应用连接；已有原生会话会继续保留。';
    return;
  }
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const ready = state.preflight?.python && state.preflight?.[provider];
  $('confirm-create').disabled = creatingSession || !ready || Boolean(takeover && (newDirectory || gitSelected)) || (gitSelected && (newDirectory || !gitSupported || gitPreviewLoading || !gitWorktreePlan));
  $('create-readiness').textContent = takeover && (newDirectory || gitSelected) ? '接管历史会话前，请选择原工作目录并取消 Git 副本。' : ready ? '' : '还需要安装所选 agent 或 Python 3。点击“检查安装”查看入口。';
}
function renderArchives() {
  const records = state.sessions.filter(s => s.archived), archivedRooms = allSpaces().filter(r => r.archived), count = records.length + archivedRooms.length;
  const running = records.filter(s => ['working', 'approval', 'starting', 'stopping', 'disconnected'].includes(s.state)).length;
  $('archive-label').textContent = `归档${count ? ` · ${count}` : ''}${running ? ` · ${running} 个待查看` : ''}`;
  $('archive-button').title = `归档 ${count} 项${running ? `，${running} 个原生会话仍需查看状态` : ''}`;
  if ($('archive-group-body').hidden) return;
  const list = $('archive-list');
  const origin = document.activeElement, oldRow = origin?.closest('.archive-item'), oldIndex = oldRow ? [...list.children].indexOf(oldRow) : -1;
  const signature = JSON.stringify([archivedRooms.map(r => [r.id, r.name]), records.map(s => [s.id, s.name, s.state, sessionTimes(s)]), state.sessions.map(s => [s.id, s.name])]);
  if (list.dataset.signature === signature) return; list.dataset.signature = signature; list.replaceChildren();
  for (const room of archivedRooms) {
    const row = node('div', undefined, 'archive-item'); row.dataset.archivedRoom = room.id; row.append(node('strong', room.name), node('small', '工作区 · 记录与笔记已保留'), button('恢复工作区', () => restoreArchivedRoom(room.id))); list.append(row);
  }
  for (const s of records) {
    const row = node('div', undefined, 'archive-item'); row.dataset.archivedSession = s.id;
    row.append(node('strong', participantLabel(s, state.sessions)), node('small', `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${states[s.state]}${['ended', 'recoverable'].includes(s.state) ? ' · 需继续原生历史' : ' · 归档未结束原生进程'} · ${sessionTimes(s)}`), button('恢复会话', () => restoreArchivedSession(s.id))); list.append(row);
  }
  if (!count) list.append(node('p', '还没有归档内容。使用会话或工作区旁的 ⋯ 菜单归档。'));
  if (oldRow) {
    const rows = [...list.children], same = rows.find(row => oldRow.dataset.archivedSession ? row.dataset.archivedSession === oldRow.dataset.archivedSession : row.dataset.archivedRoom === oldRow.dataset.archivedRoom);
    focusAfterRemoval(origin, [same?.querySelector('button'), rows[oldIndex]?.querySelector('button'), rows[oldIndex - 1]?.querySelector('button'), $('archive-button')]);
  }
}
async function restoreArchivedSession(id) {
  const origin = document.activeElement, surface = JSON.stringify([selected, roomSession, roomSurface, mode]);
  await api.restoreSession(id); updateState(await api.initial()); render();
  if (surface === JSON.stringify([selected, roomSession, roomSurface, mode])) focusAfterRemoval(origin, [$('session-header-more'), $('archive-button')]);
  sessionNotice('会话已恢复', id);
}
async function restoreArchivedRoom(id = spaceId) {
  await api.spaceAction(id, 'restore', []); updateState(await api.initial()); render();
  toast('工作区已恢复', { label: '打开', name: `打开 ${spaceRecord(id)?.name || '空间'}`, run: () => selectSpace(id) });
}

async function showSetup() {
  const ticket = openTransientDialog('setup-dialog');
  $('setup-status').replaceChildren(node('p', '正在检查本机程序…'));
  try {
  const preflight = await api.preflight(); if (!currentDialogTicket(ticket)) return;
  state.preflight = preflight;
  const entries = [['claude', 'Claude Code', 'https://code.claude.com/docs/en/setup'], ['codex', 'Codex CLI', 'https://developers.openai.com/codex/cli/'], ['python', 'Python 3', 'https://www.python.org/downloads/macos/']];
  $('setup-status').replaceChildren(...entries.map(([key, label, url]) => {
    const setting = key === 'python' ? 'python3' : key;
    const row = node('div', undefined, 'setup-program');
    row.append(node('strong', `${label}：${state.preflight[key] ? '已找到' : '尚未找到'}`));
    const location = state.preflight.paths?.[key] || state.preflight.configured?.[setting];
    if (location) row.append(node('p', location, 'program-path'));
    const actions = node('div', undefined, 'actions');
    actions.append(button('安装说明', () => api.openExternal(url)), button('选择已有程序…', async () => { await api.runtimeLocation(setting); if (currentDialogTicket(ticket)) await showSetup(); }));
    if (state.preflight.configured?.[setting]) actions.append(button('自动查找', async () => { await api.runtimeLocation(setting, true); if (currentDialogTicket(ticket)) await showSetup(); }));
    row.append(actions); return row;
  }));
  if (state.preflight.error) $('setup-status').append(node('p', state.preflight.error));
  $('version-info').textContent = `应用 ${state.appVersion || '开发版'} · 后台 ${state.runtimeVersion || '旧版（会话保留中）'}。这里只检查程序文件，不代表已登录或版本兼容。已有会话保留原进程；Codex 后台已运行时，更换程序位置需先结束原会话并完全退出后台。`;
  createReadiness();
  } catch (error) { if (currentDialogTicket(ticket)) $('setup-status').replaceChildren(node('p', '检查失败：' + (error.message || '请重试。'))); }
}
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
    const placeholder = node('option', '请选择接收方'); placeholder.value = ''; placeholder.disabled = true;
    el.prepend(placeholder); el.value = '';
  }
  el.title = el.selectedOptions[0]?.textContent || '';
}
function participantLabel(session, people = members()) {
  return people.filter(s => s.name === session.name).length > 1 ? `${session.name} · ${session.provider === 'claude' ? 'Claude' : 'Codex'} · ${sessionShortId(session.id)}` : session.name;
}
function historicalParticipantLabel(name, id) {
  return `${name || '历史成员'}${typeof id === 'string' && id ? ` · ${id.slice(0, 6)}` : ' · 身份未记录'}`;
}
function roomMessageLabel(m) {
  if (m.snapshotBatch) {
    const id = m.role === 'human' ? m.recipientId : m.sessionId, label = m.name || (m.role === 'human' ? '你' : historicalParticipantLabel('', m.sessionId));
    const actors = new Set((state.room?.messages || []).filter(row => row.snapshotBatch && row.role === m.role && row.name === m.name)
      .map(row => row.role === 'human' ? row.recipientId : row.sessionId).filter(Boolean));
    return id && actors.size > 1 ? `${label} · ${id.slice(0, 8)}` : label;
  }
  // Run notices describe coordination; streamed native system rows still belong
  // to their exact agent. Reuse the same identity in reading and copied records.
  if (m.role === 'system' && m.runId && !m.sharedStream) return m.name || '协作';
  const person = state.sessions.find(s => s.id === (m.role === 'human' ? m.recipientId : m.sessionId));
  if (person) return (m.role === 'human' ? '你 → ' : '') + participantLabel(person, state.sessions);
  const id = m.role === 'human' ? m.recipientId : m.sessionId;
  if (id) return (m.role === 'human' ? '你 → ' : '') + historicalParticipantLabel(m.role === 'human' ? m.deliveries?.find(d => d.recipientId === id)?.recipientName || '历史接收者' : m.name, id);
  return m.name || (m.role === 'human' ? '你' : '工作区');
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
  row.append(node('span', merge.stage === 'undone' ? '合并组织已撤销，来源与后来工作保留' : ['ready', 'archiving'].includes(merge.stage) ? '来自所选空间的独立快照' : '合并有步骤待核对'), button('合并详情', () => openMergeRecord(state.room.id), 'small'));
  element.append(row);
  for (const source of merge.sources) {
    const note = merge.notes.find(note => note.roomId === source.id), events = merge.events.find(value => value.roomId === source.id)?.events || [];
    if (!note && !events.length) continue;
    const details = node('details'); details.append(node('summary', `${source.name} · 原笔记与空间记录`));
    if (note) details.append(node('pre', note.text));
    for (const event of events) details.append(node('p', event.text));
    element.append(details);
  }
}
function filteredTimeline() {
  const id = $('room-filter').value, query = $('room-search').value.trim().toLocaleLowerCase();
  return timeline().filter(m => (!roomThread || roomThreads.roots.get(m.id) === roomThread) && (!id || m.sessionId === id || m.recipientId === id || m.deliveries?.some(d => d.recipientId === id)) && (!query || m.text.toLocaleLowerCase().includes(query)));
}
function openThread(id) {
  const root = roomThreads.roots.get(id);
  if (!root) return toast('这条讨论已移除。草稿仍保留。');
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
  $('thread-title').textContent = roomThread ? (root ? `讨论 · ${root.text.slice(0, 80)}` : '原讨论已移除 · 返回全部讨论查看现有记录') : '';
  $('reply-context').hidden = !roomReplyTo;
  const reply = roomThreads.rows.get(roomReplyTo);
  $('reply-label').textContent = roomReplyTo ? (reply ? `回复讨论：${reply.text.slice(0, 80)} · 历史不会自动附上` : '原讨论已移除。取消回复后可将草稿作为新消息发送。') : '';
  const candidates = new Map();
  for (const s of members()) candidates.set(s.id, s.name);
  for (const m of timeline()) {
    const id = m.sessionId || m.recipientId;
    if (id && !candidates.has(id)) candidates.set(id, state.sessions.find(s => s.id === id)?.name || m.name || '历史成员');
    for (const d of m.deliveries || []) if (!candidates.has(d.recipientId)) candidates.set(d.recipientId, state.sessions.find(s => s.id === d.recipientId)?.name || d.recipientName || '历史成员');
  }
  const filter = $('room-filter'), chosen = filter.value || pendingRoomFilter; pendingRoomFilter = '';
  const filterSignature = JSON.stringify([...candidates]);
  if (filter.dataset.signature !== filterSignature) {
    filter.replaceChildren(node('option', '全部成员'));
    filter.firstChild.value = '';
    for (const [id, name] of candidates) { const option = node('option', `${name}${members().some(s => s.id === id) ? '' : ' · 已脱出'} · ${id.slice(0, 6)}`); option.value = id; filter.append(option); }
    filter.value = candidates.has(chosen) ? chosen : ''; filter.dataset.signature = filterSignature;
  }
  const messages = filteredTimeline();
  const signature = JSON.stringify([messages, state.sessions.map(s => [s.id, s.name]), filter.value, $('room-search').value, roomThread, [...roomThreads.groups].map(([id, rows]) => [id, rows.length])]);
  if (signature !== lastRoomMessages) { messageList($('room-messages'), messages, true, roomReadingKey()); lastRoomMessages = signature; }
  $('timeline-count').textContent = `${messages.length} 条`; $('copy-timeline').disabled = !messages.length;
}
async function moveRoomMember(id, target, after, destination = spaceId) {
  await api.spaceAction(destination, 'memberOrder', [{ id, target, after }]);
  const people = orderedMembers(destination), index = people.findIndex(s => s.id === id);
  if (index < 0) throw Error('成员已离开，顺序请以当前列表为准。');
  return `${participantLabel(people[index])} 已移到第 ${index + 1} 位，共 ${people.length} 位成员`;
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
      if (!source) return toast('请选择具体空间的“离开”操作；其他空间归属保留。');
      attempt(() => detach(id, source));
    }
  });
}
function openNotes(id = spaceId) {
  const room = spaceRecord(id); if (!room) return;
  notesRevision = room.metadataRevision;
  $('room-notes-text').value = room.notes || ''; $('notes-heading').textContent = `共享笔记 · ${room.name}`; $('notes-error').hidden = true; $('save-notes').disabled = false;
  const ticket = openTransientDialog('notes-dialog'); ticket.roomId = id;
}
let contextSnapshot = null;
function contextEdited() { return Boolean(contextSnapshot && $('context-text').value && $('context-text').value !== contextSnapshot.text); }
function contextProblem(text) { $('context-error').textContent = text; $('context-error').hidden = false; }
function updateContextControls() {
  const text = $('context-text').value, edited = contextEdited();
  $('context-spaces').disabled = edited;
  $('context-scope-note').textContent = edited ? '这份背景已编辑，空间选择已固定。内容仍可继续修改；加入草稿或取消后可重新选择。' : '';
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
    contextSnapshot = window.nativeWorkspaceContextSnapshot.build(state, ids, { connected: !disconnected });
    $('context-text').value = contextSnapshot.text;
    $('context-error').textContent = ''; $('context-error').hidden = true;
  } catch (error) {
    contextSnapshot = null; $('context-text').value = ''; contextProblem(error.message || '背景快照未生成。');
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
  if (!mentionOptions.length) $('mention-list').append(node('p', '没有匹配的成员。先邀请会话加入工作区。'));
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
  if (!person) { closeMentions(); return toast('这个会话已离开，请重新选择接收者。'); }
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
  if (next.length > 16000) return toast('草稿已达长度上限，请先缩短再选择成员。');
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
  if (!members().length) return toast('先把接收方加入共同工作，再分享选定内容。');
  shareRevision++;
  $('share-text').value = text; populateSelect($('share-recipient'), members()); $('share-dialog').showModal(); updateSharingControls();
}
function updateSharingControls() {
  if (!$('share-dialog').open) return;
  const target = members().find(s => s.id === $('share-recipient').value);
  $('confirm-share').disabled = Boolean(sharePending) || !$('share-text').value.trim() || !target || interruptPending(target) || target.nativeInputRequired || target.shareAvailable === false || target.chatAvailable === false || disconnected;
  $('confirm-share').textContent = sharePending ? '发送中…' : '发送这段内容';
  $('share-help').textContent = sharePending ? '正在发送刚才确认的内容；你可以继续编辑，新的修改不会随这次发送。' : interruptPending(target) ? '正在等待原生中断确认；所选内容保留，不会自动发送。' : target?.nativeInputRequired ? 'Claude 已停止本轮；请在原生终端输入一次后继续，所选内容保留。' : target?.sharingNotice || target?.submissionNotice || (target?.chatAvailable === false ? '请先在原生终端完成连接。' : '检查内容，选择共同工作中的接收方。');
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
  const actions = terminal ? [{ id: 'display', label: '显示…', control: $('terminal-display') }]
    : [{ id: 'membership', label: h.membership.textContent, control: h.membership }, { id: 'share', label: '分享选中内容', control: h.selectedText }, { id: 'usage', label: '用量', control: h.usage }];
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
  $('title').title = compact ? s.name : compactRoom ? state.room.name : '';
  $('title').onfocus = () => { if (header.classList.contains('compact-room')) { captureReadingViews(); restoreOverviewReading(); header.classList.add('reveal-room-title'); } };
  $('title').onblur = () => { if (header.classList.contains('reveal-room-title')) { captureReadingViews(); restoreOverviewReading(); header.classList.remove('reveal-room-title'); } };
  if (!compactRoom) header.classList.remove('reveal-room-title');
  const settings = s?.nativeSettings?.nativeId === s?.nativeId ? [s?.nativeSettings?.mode === 'plan' ? 'Plan' : '', s?.nativeSettings?.effort].filter(Boolean) : [];
  const values = s ? [s.provider === 'claude' ? 'Claude Code' : 'Codex', sessionShortId(s.id), s.model, ...settings, window.nativeWorkspaceSpaces.roomIds(s).length ? '参与协作，也可单独操作' : '独立会话'] : [];
  const subtitle = $('subtitle'), signature = JSON.stringify([compact, compactRoom, inRoom, values, compactRoom && members().length]);
  if (subtitle.dataset.identity !== signature) {
    if (compact) subtitle.replaceChildren(...values.map((value, index) => {
      const field = node('span', value, `identity-value${index === 2 ? ' identity-model' : ''}`);
      field.tabIndex = 0; field.title = value; field.setAttribute('aria-label', value); return field;
    }));
    else subtitle.textContent = compactRoom ? `${members().length} 位成员` : s ? values.join(' · ') : inRoom ? '你决定谁参与、分享什么、什么时候停。' : '从一个会话开始，需要时再邀请另一个。';
    subtitle.dataset.identity = signature;
  }
  if (sessionMenu?.anchor && sessionMenu.key !== (sessionMenu.kind === 'member' ? memberMenuKey(sessionMenu.id) : headerMenuKey())) sessionMenu.close();
  if (roomMenu?.key && roomMenu.key !== roomMenuKey(roomMenu.roomId)) roomMenu();
  if (moving) restoreOverviewReading();
}
function renderHeader(s, inRoom) {
  if (!headerControls) {
    const resume = button('继续原生会话', () => { const s = current(); if (s && canResume(s)) return api.resume(s.id); }, 'primary');
    const membership = button('', () => { const s = current(); if (s && !s.archived) return inSpace(s) ? detach(s.id) : addToSpace(s.id, spaceId); });
    const selectedText = button('分享选中内容', () => {
      const s = current(); if (!s || s.archived) return;
      const text = selectedSharingText();
      text?.trim() ? share(text) : toast('先用鼠标选择需要分享的文字。');
    });
    const usage = button('用量', () => {
      const target = current();
      if (!sharedSurface() && !target) return;
      return showTrust({ usageScope: sharedSurface() ? { kind: 'room', roomId: state.room.id, name: state.room.name }
        : { kind: 'session', id: target.id, nativeId: target.nativeId, name: target.name } });
    });
    usage.id = 'usage-button'; usage.setAttribute('aria-label', '查看原生用量');
    const restore = button('恢复会话', () => { const s = current(); if (s?.archived) return restoreArchivedSession(s.id); }, 'primary');
    const more = button('⋯', () => openRoomMenu(null, more)); more.id = 'room-header-more'; more.setAttribute('aria-label', '工作区菜单'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    more.onpointerdown = event => { if (roomMenu) event.stopPropagation(); };
    const compactMore = button('⋯', () => openHeaderMenu(compactMore));
    compactMore.id = 'session-header-more'; compactMore.setAttribute('aria-label', '会话更多操作'); compactMore.setAttribute('aria-haspopup', 'menu'); compactMore.setAttribute('aria-expanded', 'false');
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
  h.membership.textContent = s && inSpace(s) ? '离开此空间' : '加入此空间';
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
  const send = button('提交回答', () => submit(Object.fromEntries(questions.map(q => [key(q), values(q)]))));
  const update = () => { send.disabled = disabled || !ready(); };
  questions.forEach((q, index) => {
    const group = node('fieldset', undefined, 'native-question'), name = `native-question-${index}`;
    group.append(node('legend', q.header || `问题 ${index + 1}`), node('p', q.question));
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
      other.placeholder = (q.options || []).length ? '其他…' : '你的回答'; other.setAttribute('aria-label', `${q.header || q.question}：${other.placeholder}`);
      other.oninput = () => { if (!q.multiSelect) { for (const input of group.querySelectorAll('input[type="radio"]')) input.checked = false; chosen.delete(key(q)); } typed.set(key(q), other.value); update(); };
      group.append(other);
    }
    form.append(group);
  });
  form.onsubmit = event => { event.preventDefault(); if (!send.disabled) send.click(); };
  form.append(send); update(); parent.append(form);
}
function nativeApprovalPreview(request) {
  const raw = typeof request.input === 'string' ? request.input : '', title = request.title || '原生请求';
  let fields;
  try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) fields = value; } catch { /* Original native input remains readable. */ }
  let detail = '', kind = 'raw', before, after, command, scope = '';
  if (title === 'Edit' && typeof fields?.file_path === 'string' && typeof fields.old_string === 'string' && typeof fields.new_string === 'string') {
    detail = fields.file_path; kind = 'edit'; before = fields.old_string; after = fields.new_string;
    scope = fields.replace_all === true ? '全部匹配' : fields.replace_all === false ? '单处' : '';
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
      const status = node('span', request.title === 'AskUserQuestion' ? '待回答' : '待批准', 'native-approval-status');
      row.nativeAuthor = author; row.nativeLabel = label; row.dataset.incomplete = String(Boolean(request.incomplete)); summary.append(author, status, label); row.append(summary, content);
      if (request.incomplete) { summary.append(node('span', '内容未完整同步', 'native-approval-incomplete')); content.append(node('p', '请求内容未完整同步，请在原生终端核对。')); }
      const preview = nativeApprovalPreview(request);
      if (preview.kind === 'edit') {
        if (preview.scope) summary.append(node('span', preview.scope, 'native-approval-scope'));
        const excerpts = nativeApprovalChangeExcerpts(preview.before, preview.after);
        for (const [name, excerpt, cls] of [['修改前', excerpts.before, 'native-approval-before'], ['修改后', excerpts.after, 'native-approval-after']]) {
          const group = node('div', undefined, cls);
          group.append(node('strong', name + (excerpt.truncated ? '（节选）' : '')), node('pre', excerpt.text, 'approval-command')); content.append(group);
        }
      } else if (preview.kind === 'command') content.append(node('pre', preview.command, 'approval-command'));
      else if (preview.kind === 'questions') {
        if (!appendNativeQuestions(content, JSON.parse(preview.raw).questions)) content.append(node('pre', preview.raw, 'approval-command'));
      } else if (preview.raw) content.append(node('pre', preview.raw, 'approval-command native-approval-raw-body'));
      if (preview.kind !== 'raw') {
        const original = node('details', undefined, 'native-approval-original');
        original.append(node('summary', '完整原始请求'), node('pre', preview.raw, 'approval-command native-approval-raw-body')); content.append(original);
      }
    }
    const preview = nativeApprovalPreview(request), description = preview.label, caption = `${s.name} · ${request.title === 'AskUserQuestion' ? '等待你回答' : '等你批准'} · ${description}${preview.scope ? ' · ' + preview.scope : ''}`;
    if (row.nativeAuthor.textContent !== s.name) row.nativeAuthor.textContent = s.name;
    row.nativeAuthor.title = s.name;
    if (row.nativeLabel.textContent !== description) row.nativeLabel.textContent = description;
    row.firstChild.title = caption; row.firstChild.setAttribute('aria-label', caption); rows.push(row);
  }
  let terminal = el.querySelector(':scope > .native-approval-terminal');
  if (!terminal) terminal = button('', () => operateNative(s.id), 'native-approval-terminal');
  const action = `在 ${s.name} 的原生终端处理`; if (terminal.textContent !== '去终端') terminal.textContent = '去终端';
  terminal.setAttribute('aria-label', action);
  terminal.title = action + '；请求正在等待你处理，这里不会代发批准。'; rows.push(terminal);
  let notice = el.querySelector(':scope > .native-approval-stale');
  if (!notice) notice = node('p', '原生状态待核验，请在原生终端核对。', 'native-approval-stale');
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
  const signature = JSON.stringify([s?.id, s?.nativeId, s?.name, s?.state, own, s?.claudeQuestion, s?.approval, requests, s?.approvalOverflow, s?.approvalNotice, s?.approvalResolved, s?.approvalDecisions, s?.nativeApproval ? nativeApprovalContent : null, stale]);
  if (el.dataset.signature === signature) return;
  el.dataset.signature = signature;
  if (!nativeOnly || el.hidden) { el.replaceChildren(); delete el.nativeApprovalContext; }
  if (el.hidden) return;
  if (s.claudeQuestion) {
    // Held before the native dialog opens: answer here, or let the terminal ask it.
    const { requestId, questions } = s.claudeQuestion;
    el.append(node('strong', `${s.name} · 等待你回答`));
    appendQuestionForm(el, questions.map(q => ({ ...q, isOther: true })), !own, answers => api.answer(s.id, requestId, answers));
    el.append(button('去终端回答', async () => { await api.answer(s.id, requestId, null); await switchMode('terminal'); }));
    return;
  }
  if (s.nativeApproval?.nativeOnly) {
    renderNativeOnlyApproval(el, s, stale);
    return;
  }
  if (requests.length > 1) {
    const select = document.createElement('select'); select.id = 'approval-request'; select.setAttribute('aria-label', '待处理请求');
    requests.forEach((request, index) => {
      const text = request.method === 'item/tool/requestUserInput' ? '问题' : '确认';
      const detail = request.params?.command || request.params?.questions?.[0]?.header || request.params?.reason || '';
      const option = node('option', `${index + 1}. ${text}${detail ? ' · ' + detail.split('\n')[0].slice(0, 90) : ''}${request.pending ? ' · 已提交' : ''}`);
      option.value = request.requestId; select.append(option);
    });
    select.value = s.approval.requestId;
    select.onchange = () => { approvalViews.set(s.id, select.value); render(); $('approval-request')?.focus(); };
    el.append(select);
  }
  const heading = node('strong', `${s.name} · ${s.approvalNotice ? '原生确认状态待核对' : s.approvalResolved ? '这项原生确认已处理' : s.approval?.pending ? '等待原生确认结果' : '需要你确认'}`);
  el.append(heading);
  if (s.approvalOverflow) el.append(node('p', '待处理请求未完整同步，请在原生终端核对；这里不会代发决定。'));
  if (s.approvalNotice) el.append(node('p', s.approvalNotice));
  if (s.approvalResolved) el.append(node('p', '等待原生状态更新；已处理不代表工具执行成功。'));
  if (s.approval) {
    const policy = window.nativeWorkspaceApproval.nativeApprovalPolicy(s.approval);
    if (policy.questions) {
      heading.textContent = `${s.name} · ${s.approval.params.isBlocking === false ? '问题 · 不阻塞本轮' : '等待你回答'}`;
      const requestId = s.approval.requestId;
      if (s.provider === 'codex' && (s.serviceCapabilities || state.capabilities || []).includes('nativeQuestionAnswer') && !policy.questions.some(q => q.isSecret)) {
        appendQuestionForm(el, policy.questions, !own || Boolean(s.approval.pending) || s.state !== 'approval' || Boolean(s.approvalOverflow), answers => api.answer(s.id, requestId, answers));
      } else appendNativeQuestions(el, policy.questions);
    } else if (policy.notice) el.append(node('p', policy.notice));
    if (policy.command) el.append(node('pre', policy.command, 'approval-command'));
    if (policy.cwd) el.append(node('p', '工作目录：' + policy.cwd));
    if (policy.reason) el.append(node('p', '原因：' + policy.reason));
    const requestId = s.approval.requestId;
    if (s.approval.params?.environmentId === 'local') el.append(node('p', '执行位置：本机'));
    for (const decision of (s.approvalDecisions || []).filter(d => policy.decisions.includes(d))) {
      const action = button({ accept: '允许这一次', decline: '拒绝', cancel: '取消本轮' }[decision], () => api.approve(s.id, requestId, decision));
      action.disabled = !own || Boolean(s.approval.pending) || s.state !== 'approval' || Boolean(s.approvalOverflow); el.append(action);
    }
  }
  el.append(button(`在 ${s.name} 的原生终端处理`, () => operateNative(s.id)));
}
function renderAdvanced(s) {
  if (advancedControls?.id !== s.id) {
    const info = node('div'), usage = node('div'), fleet = node('div');
    const stop = button(s.provider === 'codex' ? '断开本应用连接…' : '结束这个原生会话…', () => api.stop(s.id), 'small');
    const forget = button('移除本应用记录…', () => api.forget(s.id), 'small');
    $('advanced-content').replaceChildren(info, usage, button('查看协作笔记', openNotes, 'small'), button('带上协作背景…', openContext, 'small'), fleet, stop, forget);
    advancedControls = { id: s.id, info, usage, fleet, stop, forget };
  }
  const a = advancedControls;
  a.info.textContent = `原生 ID：${s.nativeId || '正在建立'}\n运行进程：${s.pid || '未连接'}${s.provider === 'codex' ? '\n' + nativeVersionText(s) : ''}\n后台版本：${s.runtimeVersion || '未报告'}\n工作目录：${s.cwd}${s.nativeContexts?.length ? '\n此前上下文（仅历史）：' + s.nativeContexts.map(c => c.nativeId).join('、') : ''}\n后台工作：${s.background ?? '原生未报告'} · 定时任务：${s.scheduled ?? '原生未报告'}`;
  a.usage.hidden = false; a.usage.textContent = window.nativeWorkspaceUsage.usageLines(s.provider, s.usage).join('\n');
  a.fleet.replaceChildren(...s.fleet.slice(-8).map(event => node('div', `${event.event}${event.kind ? ' / ' + event.kind : event.tool ? ' / ' + event.tool : ''} · ${event.name}${event.model ? ' · ' + event.model : ''}`)));
  a.stop.hidden = !switchedAway(s) && ['ended', 'background', 'stopping', 'recoverable'].includes(s.state);
  a.forget.hidden = !(['ended', 'background', 'recoverable', 'error'].includes(s.state) && !s.backendUnavailable && !s.terminalAvailable && (s.serviceCapabilities || state.capabilities)?.includes('forget'));
}
// Native activity words as plain Chinese; a native permission title passes through.
const nativeActivityLabels = { requesting: '正在请求', thinking: '思考中', text: '正在输出', input: '正在准备工具', tool: '正在运行工具',
  inProgress: '工作中', commandExecution: '正在运行命令', fileChange: '正在修改文件', mcpToolCall: '正在调用工具', dynamicToolCall: '正在调用工具',
  webSearch: '正在搜索网页', reasoning: '思考中', plan: '正在更新计划', agentMessage: '正在输出', waitingOnUserInput: '等待回答', waitingOnApproval: '等待确认', willRetry: '正在重试' };
const elapsedText = seconds => seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
function renderNativeActivity(s) {
  const el = $('native-activity');
  const recovery = !disconnected && !s?.transportDisconnected && s?.capacityRecovery;
  if (recovery && ['scheduled', 'exhausted'].includes(recovery.status)) {
    el.hidden = false;
    $('native-phase').textContent = `${s.name} · ${recovery.reason === 'routing' ? '路由发现超时' : '模型满载'}${recovery.status === 'exhausted' ? '，自动继续已达上限，需要你处理' : ''}`;
    $('native-elapsed').textContent = recovery.status === 'scheduled' ? ` · ${new Date(recovery.due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 自动继续（第 ${recovery.attempt + 1}/3 次）` : '';
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
  const label = s.claudeQuestion ? '等待回答' : status && !nativeStatusFresh(status) ? '原生状态待同步' : matched && status.label ? (Object.hasOwn(nativeActivityLabels, status.label) ? nativeActivityLabels[status.label] : status.label) : waiting ? question ? '等待回答' : '等待原生确认' : '正在处理';
  const notice = matched && !waiting && !s.approvalOverflow && s.state === 'working' && status.waitNotice;
  const slow = notice?.kind === 'tool-wait' && notice.nativeId === s.nativeId && notice.turnId === s.activeTurnId && notice.marker === status.toolWait?.marker && notice.progressAt === status.toolWait?.progressAt;
  const text = (s.name || 'Codex') + ' · ' + label + (slow ? ' · 较长时间未收到工具进展，请检查原生界面或系统权限提示' : '');
  if ($('native-phase').textContent !== text) $('native-phase').textContent = text;
  const elapsed = seconds === null ? '' : ' · 已用 ' + elapsedText(seconds);
  if ($('native-elapsed').textContent !== elapsed) $('native-elapsed').textContent = elapsed;
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
    $('title').textContent = inRoom ? state.room.name : s?.name || '你的工作空间';
    const warning = [disconnected ? '本地服务断开。草稿已保留，不会自动重发输入。' : [state.storageWarning, state.sessionNameWarning, state.roomStorageWarning].filter(Boolean).join(' '), state.viewStorageWarning].filter(Boolean).join(' ');
    $('alert').hidden = !warning; $('alert').textContent = warning || '';
    $('reconnect-button').hidden = !disconnected;
    $('retry-save').hidden = !state.viewStorageWarning && (disconnected || !state.storageRetryable);
    renderSessions();
    renderArchives(); renderSpaceNavigation(); renderSpaceFiles();
    if ($('share-dialog').open) { populateSelect($('share-recipient'), members()); updateSharingControls(); }
    if ($('invite-dialog').open) for (const entry of $('invite-list').children) {
      const record = state.sessions.find(s => s.id === entry.dataset.inviteSession);
      if (record) entry.textContent = `加入 ${participantLabel(record, state.sessions)}`;
    }
    renderHeader(s, inRoom);
    if (inPanorama || panoramaView.returning) renderPanorama();
    if (inPanorama) {
      $('title').textContent = '全部空间'; $('subtitle').textContent = '';
      document.title = '全部空间 — Native Agent Workspace';
    }
    if (!s) renderNativeActivity(null);
    if (s) {
      const own = s.owner === owner; const alive = nativeUsable(s);
      $('native-pane-title').textContent = inRoom ? participantLabel(s, state.sessions) + ' · 原生终端' : '原生终端';
      $('native-pane-title').title = participantLabel(s, state.sessions) + ' · 原生终端';
      $('terminal-maximize').setAttribute('aria-label', terminalLayout === 'maximized' ? '恢复并排' : '放大终端');
      $('terminal-maximize').title = terminalLayout === 'maximized' ? '恢复并排' : '放大终端';
      $('chat-maximize').setAttribute('aria-label', terminalLayout === 'hidden' ? '恢复并排' : '放大对话'); $('chat-maximize').title = $('chat-maximize').getAttribute('aria-label');
      $('session-status').textContent = `${s.archived ? '已归档 · ' : ''}${sessionStatus(s)}${s.provider === 'codex' && s.nativeVersionStatus === 'unverified' && !disconnected ? ` · Codex ${s.nativeVersion || '版本未确认'} 尚未验证` : ''}${s.activity ? ' · ' + s.activity : ''}${!own && s.owner ? ' · 另一个窗口控制' : ''}${terminals.get(s.id)?.viewInput ? ' · 输入暂存，尚未发送' : ''}`;
      $('session-status').title = nativeVersionText(s);
      $('take-control').hidden = own || !alive;
      $('chat-tab').classList.toggle('active', mode === 'chat'); $('terminal-tab').classList.toggle('active', mode === 'terminal');
      $('terminal-controls').hidden = !terminalVisible;
      $('terminal-paste').disabled = !terminalCanInput(s.id) || !alive;
      $('messages').hidden = false; $('terminal-area').hidden = !terminalVisible; $('composer-wrap').hidden = false;
      renderComposer(s); renderNativeActivity(s);
      $('interrupt').hidden = !own || !(['working', 'approval'].includes(s.state) || s.capacityRecovery?.status === 'scheduled');
      $('interrupt').textContent = s.capacityRecovery?.status === 'scheduled' ? '取消自动继续' : '中断回复';
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
      const emptyText = alive ? '发送第一条消息后，这里会显示同一会话的原生终端。' : s.state === 'ended' ? '会话已结束，本窗口没有保留它的原生终端画面。' : '本窗口没有这个会话的原生终端画面。';
      if ($('terminal-empty').textContent !== emptyText) $('terminal-empty').textContent = emptyText;
      if (terminalVisible && alive && (mode === 'terminal' || s.terminalState?.alive || s.activeTurnId || s.messages.some(m => m.role === 'assistant'))) {
        // Mounting the same native display is passive; input still requires its
        // own focus/control claim. Never steal focus when the snapshot arrives.
        ensureTerminal(s.id).catch(error => { if (mode === 'terminal') toast(error.message); });
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
          const tab = button(label, () => selectRoom(m.id)); tab.dataset.roomSession = m.id; tab.title = `${label} · 拖回左侧独立使用`; draggableSession(tab, m.id); return tab;
        }));
        tabs.dataset.signature = tabSignature;
      }
      $('room-record').setAttribute('aria-pressed', String(roomSurface === 'records'));
      for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.roomSession === roomSession));
      for (const tab of tabs.children) {
        const member = people.find(m => m.id === tab.dataset.roomSession);
        const count = member.nativeApproval?.requests?.length || member.approvals?.length || (member.approval || member.approvalOverflow ? 1 : 0);
        const text = `${member.name} · ${sessionShortId(member.id)}` + (count ? ` · ${count} 待处理` : '');
        if (tab.textContent !== text) tab.textContent = text;
        tab.title = `${member.name} · ${sessionShortId(member.id)} · 拖回左侧独立使用`;
        tab.classList.toggle('needs-attention', Boolean(count));
      }
      let runText = run ? `${run.pausePending ? '正在撤销后续授权' : run.pauseUnconfirmed ? '部分后台未确认暂停' : { running: '正在核查', paused: '已暂停', completed: '本轮交接结束' }[run.status]} · ${run.steps}/${run.maxSteps} 次回复${run.reason ? ' · ' + run.reason : ''}` : '';
      const pendingRun = roomSubmitting?.automatic;
      const waiting = roomPendingRecipients.get($('recipient').value) || roomPendingRecipients.values().next().value;
      $('run-status').parentElement.hidden = !run && !roomSubmitting && !waiting;
      const next = state.sessions.find(m => m.id === run?.awaiting?.sessionId);
      if (run?.status === 'running' && next) runText += ` · 等待 ${next.name}`;
      if (pendingRun && roomSubmitting.cancelling) runText = '正在取消后续交接；草稿保留，已接收的任务仍在原会话中。';
      else if (pendingRun && run?.status !== 'running') runText = '正在准备核查，等待先前操作或原生接收确认。可取消本次等待；已开始的原生任务不受影响。';
      if (waiting && !pendingRun) runText = waiting.queued ? `已排队给 ${waiting.recipientName}：要等它空闲后才发送；想中途插话，请在它的原生终端输入。` : `正在发给 ${waiting.recipientName}，等待原生接收确认。可以选择其他成员继续输入。`;
      const active = people.filter(person => {
        const activity = person.sharedActivity;
        if (disconnected || person.transportDisconnected || !['working', 'approval'].includes(person.state) ||
          !activity || !nativeStatusFresh(activity) || activity.nativeId !== person.nativeId || activity.turnId !== person.activeTurnId) return false;
        return true;
      }).map(person => `${participantLabel(person, people)} · ${person.sharedActivity.label}`);
      if (active.length) {
        runText = [runText, ...active].filter(Boolean).join(' · ');
        $('run-status').parentElement.hidden = false;
      }
      if (state.room.merge && !['ready', 'undone'].includes(state.room.merge.stage)) {
        runText = [runText, '合并有步骤待核对，可从空间菜单查看详情'].filter(Boolean).join(' · '); $('run-status').parentElement.hidden = false;
      }
      if ($('run-status').textContent !== runText) $('run-status').textContent = runText;
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
      $('forward-button').textContent = nativeRoute ? (nativeUsable(recipient) ? '打开原生终端' : '查看会话') : interruptPending(recipient) ? '等待中断确认' : recipient?.pendingQueue ? '等待原生接收' : roomQueueAvailable(recipient) ? '等本轮结束后发送 ↑' : roomSteerAvailable(recipient) ? '追加指令 ↑' : '发送 ↑';
      const recipientPending = roomPendingRecipients.has(recipient?.id);
      const mergeBlocked = state.room.merge && (!state.room.merge.imported || ['preparing', 'joining', 'failed', 'undoing'].includes(state.room.merge.stage));
      const unavailable = mergeBlocked || roomSubmitting || recipientPending || disconnected || !nativeWorkspaceMentions.body(roomMention, $('shared-input').value).trim();
      const threadUnsupported = roomReplyTo && (!roomThreads.rows.has(roomReplyTo) || (recipient && !recipient.legacyShare && !recipient.serviceCapabilities?.includes('replyThreads')));
      const ready = s => s && !interruptPending(s) && s.state === 'idle' && !s.nativeInputRequired && !s.pendingTag && !s.pendingQueue && !s.approval && s.shareAvailable !== false && s.chatAvailable !== false;
      const manualErrorReady = !interruptPending(recipient) && recipient?.state === 'error' && recipient.failedTurnInputAvailable && !recipient.pendingTag && !recipient.pendingQueue && !recipient.approval;
      $('forward-button').disabled = nativeRoute ? mergeBlocked || roomSubmitting || recipientPending || disconnected : unavailable || (!ready(recipient) && !manualErrorReady && !roomQueueAvailable(recipient) && !roomSteerAvailable(recipient)) || Boolean(threadUnsupported);
      const otherRun = allSpaces().find(r => r.id !== spaceId && r.run?.status === 'running');
      $('run-button').disabled = unavailable || roomPendingRecipients.size > 0 || !recipient || !ready(recipient) || run?.status === 'running' || run?.pausePending || run?.pauseUnconfirmed || !safeHandoffs || Boolean(threadUnsupported) || Boolean(otherRun);
      $('run-help').textContent = recipient ? `只发给 ${participantLabel(recipient)} · Enter 发送，Shift Enter 换行` : roomMention?.active === false ? '接收者已变化，重新 @ 选择。正文保留，不会发送给旧成员。' : '@ 选择接收者。加入或查看工作区不会自动发送私人历史。';
      if (roomQueueAvailable(recipient) || recipient?.pendingQueue) $('run-help').textContent += ' · 等原生下一轮接收；当前工作继续，先前私人内容不会加入共享记录。';
      if (roomSteerAvailable(recipient)) $('run-help').textContent += ' · 追加到当前原生回合；接收后的新消息块进入共享记录，先前内容不补发。';
      if (manualErrorReady) $('run-help').textContent += ' · 上次请求失败，不会自动重试或继续交接。';
      if (recipient?.legacyShare && !recipient.legacySharedReply) $('run-help').textContent += ' · 回复在成员视图查看，由你选择后再分享。';
      $('run-button').title = otherRun ? `「${otherRun.name}」正在核查；请先在原空间明确暂停。定向发送给其他空闲成员仍可使用。` : safeHandoffs ? '预览任务后授权有限的回复交接；不代表全部原生团队结束。' : state.handoffNotice || '现有后台暂不支持这项核查，原生会话继续保留。';
      if (nativeRoute) $('run-help').textContent = recipient?.nativeInputRequired ? 'Claude 已停止本轮，并暂停插件输入。请在原生终端输入一次后继续；共享草稿保留，不会自动发送。' : '这个会话暂不能从这里接收消息。草稿保留，查看会话不会自动粘贴或发送。';
      if (interruptPending(recipient)) $('run-help').textContent = '正在等待原生中断确认，可以继续编辑草稿；不会自动发送。';
      if (threadUnsupported) $('run-help').textContent = roomThreads.rows.has(roomReplyTo) ? '此连接尚不支持讨论回复。草稿保留；取消回复可作为新消息发送。' : '原讨论已移除。草稿保留，请先取消回复。';
      $('pause-button').textContent = run?.pauseUnconfirmed ? '重新核对暂停' : pendingRun && run?.status !== 'running' ? '取消等待' : '暂停交接';
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
  let queued;
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
      try { if (text) await api.input(s.id, text); queued.resolve(); }
      catch (error) { queued.reject(error); if (text) entry.preserveUnconfirmed(text, error); throw error; }
    }
    if (!stillSelected()) return;
    mode = next; preference = next; clearFailedTerminal(s.id); render(); await persistView();
    if (!stillSelected()) return;
    if (next === 'terminal') { await ensureTerminal(s.id, true); if (stillSelected()) focusTerminal(s.id); }
    else if (inputFocusAllowed()) chatInput().focus();
  } finally {
    if (queued && entry.viewInput === queued) cancelViewInput(entry);
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
  if (old && (old.generation !== generation || old.nativeId !== record?.nativeId)) { old.term.dispose(); old.element.remove(); terminals.delete(id); cancelViewInput(old, new Error('原生连接已变化；旧输入没有发送。')); }
  if (old?.waitingForFirstTurn && terminals.get(id) === old &&
      (record?.activeTurnId && record.activeTurnId !== old.firstTurnAttemptId || record?.messages.some(message => message.role === 'assistant') && !old.firstTurnHadOutput)) {
    // A first-message instruction never launched a display. Once that same
    // native thread has real output, the visible pane can attach without a seed.
    old.term.dispose(); old.element.remove(); terminals.delete(id);
  }
  // A repaint never restarts a native display. Only an explicit view action can
  // replace its cached screen, after the backend reports the display lifetime.
  if (explicit && old?.ready && terminals.get(id) === old && !currentTerminalDisplay(old, record)) {
    if (record.owner !== owner || record.backendUnavailable || record.transportDisconnected || disconnected) throw new Error('请先连接并接管这个会话，再打开终端。');
    if (record.terminalState?.alive === false && !record.terminalState.exitConfirmed) throw new Error('旧终端退出尚未确认，暂不启动另一个终端。');
    cancelViewInput(old); old.term.dispose(); old.element.remove(); terminals.delete(id);
  }
  if (!explicit && !terminals.has(id) && record?.terminalState?.alive === false) return;
  if (terminals.has(id)) { const existing = terminals.get(id); syncTerminalMount(id); if (existing.ready) fitTerminal(id); return existing.pending; }
  const element = node('div', undefined, 'terminal-host'); element.dataset.terminalId = id; $('terminal-area').append(element);
  if (activeSessionId() === id) $('terminal-empty').hidden = true;
  const theme = terminalThemes[terminalDisplay.palette];
  $('terminal-area').style.backgroundColor = theme.background;
  const loading = node('p', '正在连接原生终端…', 'terminal-loading'); loading.setAttribute('role', 'status');
  const surface = node('div', undefined, 'terminal-surface'); surface.hidden = true; surface.inert = true; element.append(loading, surface);
  const term = new Terminal({ fontFamily: '"MesloLGS NF", Menlo, Monaco, monospace', fontSize: terminalDisplay.fontSize, lineHeight: 1, cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionClickForcesSelection: true, disableStdin: true, theme: { ...theme } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(surface);
  const intent = selectionRevision;
  const entry = { element, term, fit, generation, nativeId: record?.nativeId, ready: false, sequence: 0, queued: [], firstTurnAttemptId: record?.activeTurnId, firstTurnHadOutput: record?.messages.some(message => message.role === 'assistant') }; terminals.set(id, entry); syncTerminalMount(id);
  term.onSelectionChange(() => nativeSelectionChanged(id, term));
  let recovery = inputRecoveries.get(id);
  if (!recovery) {
    const panel = node('div', undefined, 'terminal-input-recovery'); panel.hidden = true;
    const text = node('textarea'); text.readOnly = true; text.setAttribute('aria-label', '未确认的终端输入');
    panel.append(node('strong', '这段输入尚未确认'), node('p', '不会自动重发。请先复制留存，再检查原生终端是否已收到；关闭应用会清除此处的临时副本。'), text,
      button('复制', () => api.copy(text.value)), button('关闭提示', () => { panel.hidden = true; text.value = ''; render(); focusTerminal(id); }));
    recovery = { panel, text }; inputRecoveries.set(id, recovery);
  }
  element.append(recovery.panel);
  const preserveUnconfirmed = entry.preserveUnconfirmed = (text, error) => {
    recovery.text.value += text; recovery.panel.hidden = false; render();
    toast(`${state.sessions.find(s => s.id === id)?.name || '原会话'}：${error.message || '输入未确认'}。文字保留在该原生终端的提示中，不会自动重发。`);
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
      const error = new Error('输入切换已失效；这段输入没有发送。');
      cancelViewInput(entry, error); preserveUnconfirmed(data, error);
      if (token) { token.consumed = true; token.input = Promise.reject(error); token.input.catch(() => {}); }
      return;
    }
    if (canCaptureTerminal(id)) {
      const pending = entry.viewInput;
      if (pending.text.length + data.length > 65536) { cancelViewInput(entry, new Error('切换等待期间输入过长，请复制后重试。')); preserveUnconfirmed(data, new Error('输入未发送。')); render(); return; }
      pending.text += data;
      if (token && !token.consumed) { token.consumed = true; token.input = pending.done; }
      return;
    }
    const finishing = canFlushComposition(id, token);
    if (terminals.get(id) !== entry || (!terminalCanInput(id) && !finishing)) return;
    if (finishing) token.consumed = true;
    const input = api.input(id, data);
    if (finishing) token.input = input;
    input.catch(error => { if (finishing) preserveUnconfirmed(data, error); else toast(error.message || '终端输入未确认；不会自动重发。'); });
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
          const error = new Error('输入未发送，请检查会话连接或控制权。');
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
    if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { attempt(() => api.copy(term.getSelection())); return false; }
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
      if (snapshot.epoch && live?.epoch && snapshot.epoch !== live.epoch) throw new Error('终端画面已变化，请重新选择这个视图。');
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
        loading.textContent = entry.waitingForFirstTurn ? firstMessage : '终端未连接，重新选择此会话或视图可重试。';
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
  api.onDisconnected(message => { disconnected = true; for (const s of state?.sessions || []) freezeLegacyProgress(s); render(); toast(message); }),
  api.onViewStorage(warning => { latestViewStorage = warning; if (state) { state.viewStorageWarning = warning; render(); } }),
  api.onReconnected(next => { for (const s of state?.sessions || []) freezeLegacyProgress(s); disconnected = false; updateState(next); render(); }),
  api.onNew(() => openCreate()),
];
sidebarLayout = window.nativeWorkspaceSidebar.bind({ navigation: document.querySelector('.sidebar-navigation'), groups: ['sessions-group', 'workspace-group', 'archive-group'].map($), sashes: ['sidebar-session-sash', 'sidebar-workspace-sash'].map($), onCommit: weights => api.sidebar({ type: 'resize', weights }), onError: error => toast(error.message || '未能保存侧栏高度。') });
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
    const returnFocus = mayRestoreFocus(); renaming = false; closeRename(returnFocus); toast('名称已保存。');
  } catch (error) { if (renameTarget === target) { showRenameError(error.message || '名称未能保存，请重试。'); if (mayRestoreFocus()) $('rename-name').focus({ preventScroll: true }); } }
  finally { renaming = false; if (renameTarget === target) renderRename(); }
};
$('choose-folder').onclick = () => attempt(async () => { const ticket = dialogTickets.get($('create-dialog')); const value = await api.chooseFolder(); if (value && currentDialogTicket(ticket)) { folder = value; newDirectory = false; invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder; if ($('git-worktree').checked) await refreshGitPreview(); else createReadiness(); } });
$('git-worktree').onchange = () => { invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder; if ($('git-worktree').checked) refreshGitPreview(); else createReadiness(); };
$('git-worktree-relative').oninput = scheduleGitPreview;
$('new-folder').onclick = () => { if (!creatingSession) { resetCreateDirectory(); createReadiness(); } };
$('create-form').onsubmit = event => { event.preventDefault();
  const ticket = dialogTickets.get($('create-dialog')), revision = selectionRevision;
  if (creatingSession || !currentDialogTicket(ticket)) return;
  if (document.querySelector('input[name="provider"]:checked').value === 'claude' && $('claude-history-id').value.trim()) { $('open-native-history').click(); return; }
  attempt(async () => {
  const worktree = $('git-worktree').checked ? gitWorktreePlan : null;
  if ($('git-worktree').checked && (!worktree || newDirectory || gitPreviewLoading || !state.capabilities?.includes('gitWorktreeV1'))) throw Error('请先完成 Git 副本预览；没有改用原目录启动。');
  creatingSession = true; $('create-error').textContent = ''; createReadiness();
  const submittedFolder = worktree?.cwd || folder, priorIds = new Set(state.sessions.map(s => s.id));
  try { const provider = document.querySelector('input[name="provider"]:checked').value, view = provider === 'codex' ? $('initial-view').value : preference; preference = view; const id = await api.create({ provider, cwd: worktree?.source || folder, name: $('session-name').value, view, ...(worktree ? { gitWorktree: worktree } : newDirectory ? { newDirectory: true } : {}), skipPermissions: $('skip-permissions').checked || undefined }); updateState(await api.initial()); render(); if (currentDialogTicket(ticket) && revision === selectionRevision) { $('create-dialog').close(); await select(id, view); } else toast('此前创建的会话已保留在侧栏。'); }
  catch (error) {
    try { updateState(await api.initial()); render(); } catch {}
    const created = state.sessions.find(s => s.cwd === submittedFolder && !priorIds.has(s.id));
    const message = created ? `会话“${created.name}”（${sessionShortId(created.id)}）已保留在侧栏。${error.message}` : error.message;
    if (currentDialogTicket(ticket)) $('create-error').textContent = message; else toast(message);
    if (worktree && currentDialogTicket(ticket)) { invalidateGitPreview(); $('chosen-folder').textContent = folder; $('git-worktree-preview').textContent = '若已生成副本，其路径和分支会保留。要再创建，请明确重新选择仓库或重新勾选副本；不会自动重试。'; }
    // A failed/uncertain start may already own the displayed path. Preserve
    // that record and any files; a new explicit submit gets a fresh preview.
    if (currentDialogTicket(ticket) && newDirectory) resetCreateDirectory();
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
  } catch (error) { if (currentDialogTicket(ticket)) mergeError(error.message); else toast(error.message); }
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
    if (!currentDialogTicket(ticket)) return toast('合并记录已保留，可从空间菜单查看详情。');
    draft.record = record; draft.targetId = batch.targetId;
    if (action === 'commit' && record.stage === 'ready' && revision === selectionRevision) {
      $('space-merge-dialog').close(); await selectSpace(batch.targetId);
      return toast(`已合并为「${batch.name}」`, { label: '查看详情', run: () => openMergeRecord(batch.targetId) });
    }
    mergeButtons(true, true); renderMergeBatch(batch, record);
  } catch (error) {
    try { updateState(await api.initial()); render(); } catch {}
    if (currentDialogTicket(ticket)) mergeError(error.message); else toast(error.message);
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
    else toast('此前新建的空间已保留在侧栏。');
  } catch (error) { if (currentDialogTicket(ticket)) { $('space-create-error').textContent = error.message; $('space-create-error').hidden = false; } else toast(error.message); }
  finally { if (currentDialogTicket(ticket)) $('confirm-space-create').disabled = false; }
}); };
$('workspace-group').addEventListener('contextmenu', event => {
  if (event.defaultPrevented || event.target.closest('.room-row, #rename-editor')) return;
  event.preventDefault(); event.stopPropagation(); openSpaceRegionMenu({ x: event.clientX, y: event.clientY });
});
$('workspace-toggle').addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); event.stopPropagation(); openSpaceRegionMenu(undefined, $('workspace-toggle')); } });
for (const [id, view] of [['sessions-flat', 'flat'], ['sessions-grouped', 'grouped']]) $(id).onclick = () => { sidebarView = view; sessionMenu?.close(); render(); attempt(persistView); $(id).focus(); };
$('clear-space-filter').onclick = () => { sidebarSpaceFilter = ''; render(); attempt(persistView); $('sessions-flat').focus(); };
$('room-nav').onclick = () => attempt(() => selectSpace('shared', true));
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
$('chat-maximize').onclick = () => attempt(async () => { if (terminalLayout === 'hidden') await switchMode('terminal'); else { terminalLayout = 'hidden'; await switchMode('chat'); } });
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
  if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) throw new Error('字号请设为 10–24。');
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
  $('space-files-title').textContent = `空间文件 · ${room.name}`;
  $('add-space-files').disabled = disconnected || room.archived;
  const signature = JSON.stringify(room.files || []), list = $('space-files-list');
  if (list.dataset.signature === signature) return; list.dataset.signature = signature;
  list.replaceChildren(...(room.files || []).map(file => {
    const row = node('div', undefined, 'space-file-row'), open = button(file.name, async () => { $('space-files-dialog').close(); if (spaceId !== filesSpace) await selectSpace(filesSpace); await openLocalFile(true, file.id); }); open.title = file.path;
    const remove = button('移除引用', async () => { await api.spaceAction(filesSpace, 'removeFile', [file.id, room.metadataRevision]); updateState(await api.initial()); renderSpaceFiles(); }); remove.disabled = room.archived; remove.setAttribute('aria-label', `从「${room.name}」移除「${file.name}」的引用，保留原文件`);
    row.append(open, remove); return row;
  }));
  if (!list.children.length) list.append(node('p', '这个空间还没有文件引用。', 'quiet'));
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
    $('file-info').textContent = `${preview.size} 字节 · 当前文件快照 · 支持 UTF-8 文本，最多 256 KB`;
    $('file-content').textContent = preview.text;
    $('file-error').hidden = true;
    $('insert-file').disabled = !target.room && mode !== 'chat' || fileDraftInput().readOnly;
    $('insert-file').title = $('insert-file').disabled ? '可在对话视图中加入草稿；文件仍可查看和保存副本。' : '只加入草稿，不会发送';
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
  for (const id of ['file-title', 'file-info', 'file-content', 'file-error']) $(id).textContent = '';
  $('file-error').hidden = true; $('save-file').disabled = false;
});
$('insert-file').onclick = async () => {
  try {
    if (!filePreview || !fileTargetMatches() || fileDraftInput().readOnly || (!fileTarget.room && mode !== 'chat')) throw Error('视图或控制权已变化，请回到要编辑的会话重新选择文件。');
    const input = fileDraftInput();
    const next = appendedDraft(input, `文件：${filePreview.name}\n${filePreview.text}`, fileTarget.room);
    if (next.length > 16000) throw Error('合并后超过 16000 字符。请缩短草稿或选择较小的材料；没有截断内容。');
    const room = fileTarget.room;
    input.value = next;
    // Insertion is synchronous and happens once. A failed persistence retry
    // must save this draft, never append the same material a second time.
    const token = filePreview.token; $('file-dialog').close(); filePreview = null; attempt(() => api.closeLocalFile(token));
    if (room) { roomDraftRevision++; render(); input.focus(); await persistView(); }
    else { input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
  } catch (error) {
    if ($('file-dialog').open) { $('file-error').textContent = error.message; $('file-error').hidden = false; }
    else toast(error.message);
  }
};
$('save-file').onclick = async () => {
  if (!filePreview) return;
  const preview = filePreview; $('save-file').disabled = true;
  try { if (await api.saveLocalFile(preview.token)) toast('已保存预览副本。'); }
  catch (error) { if (filePreview === preview && $('file-dialog').open) { $('file-error').textContent = error.message; $('file-error').hidden = false; } else toast(error.message); }
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
  if (prior && !roomMention) $('mention-status').textContent = `已移除收件人 ${prior.text.slice(1)}`;
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
  if (!recipient) throw Error('接收方已变化，请重新选择。');
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
  $('run-mode-help').textContent = directed ? (capable ? '只向成员明确选择的接收者发送；没有定向调用就结束。工具调用、工具说明及本轮成员表会计入原生用量；发送详情可核对实际内容。' : '所选会话中有原生连接尚不支持主动定向工具。可改用按顺序核查；不会重建或替换原会话。') : crossService ? '成员保留各自后台；按预览顺序转交完整回复，关闭界面后继续。暂停撤销后续授权，已经被原生接收的工作仍可能继续。' : '';
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
      up.setAttribute('aria-label', `提前 ${s.name} · ${sessionShortId(s.id)}`); row.append(up);
    }
    $('run-participants').append(row);
  }
  for (const option of $('run-limit').options) option.disabled = Number(option.value) < ids.length;
  if (Number($('run-limit').value) < ids.length) $('run-limit').value = String(ids.length);
  const sequence = Array.from({ length: Number($('run-limit').value) }, (_, i) => {
    const s = members().find(s => s.id === ids[i % ids.length]);
    return s ? `${s.name} (${sessionShortId(s.id)})` : '未选择';
  });
  $('run-order').textContent = directed ? `由第一位开始，在所选成员中明确选择下一位；上限 ${$('run-limit').value} 次回复，不广播私人历史。` : `转交顺序：${sequence.join(' → ')}。只转交任务与上一份回复，不附加私人历史。`;
  $('confirm-run').disabled = !$('run-consent').checked || ids.length < 2 || (directed && !capable);
}
$('run-button').onclick = () => {
  if ($('run-button').disabled) return;
  $('room-advanced').open = false;
  if (nativeWorkspaceMentions.body(roomMention, $('shared-input').value).length > 6000) { toast('一起核查的任务与材料合计最多 6000 字符。草稿保留；可缩短后核查，或定向发送。'); $('shared-input').focus(); return; }
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
  if (!same || !available || $('run-button').disabled) { $('run-error').textContent = '任务、成员或接收方已变化，请取消并重新预览。'; $('run-error').hidden = false; return; }
  const mode = $('run-mode').value, limit = Number($('run-limit').value), ids = [...runPreview.ids], labels = Object.fromEntries(runPreview.members.filter(m => ids.includes(m[0])).map(m => [m[0], m[2]]));
  const identities = Object.fromEntries(runPreview.ids.map(id => [id, runPreview.identities[id]]));
  const contexts = Object.fromEntries(runPreview.members.filter(m => ids.includes(m[0])).map(m => [m[0], m[3]]));
  $('run-dialog').close(); runPreview = null; attempt(() => submitRoom({ limit, ids, labels, contexts, mode, identities }));
};

$('room-search').oninput = $('room-filter').onchange = () => { renderTimeline(); attempt(persistView); };
$('thread-back').onclick = () => { captureReadingViews(); roomThread = ''; if (!$('shared-input').value.trim() && !roomSubmitting) roomReplyTo = ''; render(); attempt(persistView); };
$('cancel-reply').onclick = () => { roomReplyTo = ''; roomThread = ''; roomDraftRevision++; render(); attempt(persistView); $('shared-input').focus(); };
$('copy-timeline').onclick = () => attempt(() => api.copy(filteredTimeline().map(m => `${Number.isFinite(m.time) ? new Date(m.time).toLocaleString() : '时间未记录'} · ${roomMessageLabel(m)}\n${m.text}`).join('\n\n')));
$('room-notes').onclick = () => openNotes(); $('cancel-notes').onclick = () => $('notes-dialog').close();
$('notes-form').onsubmit = async event => {
  event.preventDefault(); const ticket = dialogTickets.get($('notes-dialog'));
  if (!currentDialogTicket(ticket) || $('save-notes').disabled) return;
  $('save-notes').disabled = true; $('notes-error').hidden = true;
  try {
    await api.spaceAction(ticket.roomId, 'notes', [$('room-notes-text').value, notesRevision]);
    if (currentDialogTicket(ticket)) $('notes-dialog').close(); else toast('此前提交的笔记已保存。');
  } catch (error) {
    if (currentDialogTicket(ticket)) { $('notes-error').textContent = error.message; $('notes-error').hidden = false; }
    else toast('此前提交的笔记未能保存：' + error.message);
  } finally { if (currentDialogTicket(ticket)) $('save-notes').disabled = false; }
};
$('attach-context').onclick = () => { $('room-advanced').open = false; openContext(); }; $('close-context').onclick = () => $('context-dialog').close();
$('context-text').addEventListener('input', updateContextControls);
$('copy-context').onclick = () => attempt(async () => {
  const text = $('context-text').value;
  if (!contextSnapshot || !text.trim() || text.length > 12000 || !text.isWellFormed()) return contextProblem('请先核对背景文字与所选空间。');
  await api.copy(text); toast('已复制，尚未发送给 agent。');
});
$('insert-context').onclick = () => attempt(async () => {
  const ticket = dialogTickets.get($('context-dialog')), revision = selectionRevision;
  if (!currentDialogTicket(ticket)) return;
  const target = contextTarget, text = $('context-text').value;
  if (!contextSnapshot || !text.trim() || text.length > 12000 || !text.isWellFormed()) return contextProblem('请先核对背景文字与所选空间。');
  if (!target?.room || target.roomId !== spaceId || selected !== 'room') return contextProblem('当前视图已变化，请重新打开协作背景。');
  const input = $('shared-input');
  const next = appendedDraft(input, text, true);
  if (next.length > 16000) { $('context-error').textContent = '合并后的草稿超过 16000 字符，请先缩短。'; $('context-error').hidden = false; return; }
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
      toast('已取消后续交接；草稿保留，已接收的原生任务仍在原会话中。');
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
  $('invite-list').replaceChildren(...state.sessions.filter(s => !inSpace(s, destination) && !s.archived && s.state !== 'ended').map(s => {
    const entry = button(`加入 ${participantLabel(s, state.sessions)}`, async () => {
      const current = state.sessions.find(record => record.id === s.id);
      if (!current || inSpace(current, destination) || current.archived || current.state === 'ended' || pairRevision(current, destination) !== pairRevision(s, destination) || current.nativeId !== s.nativeId) throw new Error('会话已变化，请关闭并重新打开邀请。');
      if (!currentDialogTicket(ticket) || entry.disabled) return;
      entry.disabled = true;
      try { await api.spaceAction(destination, 'join', [s.id, true]); if (currentDialogTicket(ticket) && revision === selectionRevision) $('invite-dialog').close(); }
      finally { if (currentDialogTicket(ticket)) entry.disabled = false; }
    });
    entry.dataset.inviteSession = s.id; return entry;
  }));
  if (!$('invite-list').children.length) $('invite-list').append(node('p', '所有可用会话已在这个空间中；可创建会话后邀请。'));
}
$('invite-dialog').addEventListener('close', () => {
  if ($('invite-dialog').open) return;
  $('invite-list').replaceChildren();
  const origin = inviteOrigin; inviteOrigin = null;
  if (origin?.revision === selectionRevision && selected === 'room') focusMemberAction(origin.anchor);
});
$('close-invite').onclick = () => $('invite-dialog').close();
$('cancel-share').onclick = () => $('share-dialog').close();
$('share-dialog').onclose = () => {
  if ($('share-dialog').open) return;
  shareRevision++; $('share-text').value = ''; $('share-help').textContent = '';
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
    toast('已定向发送。');
  } finally { sharePending = null; updateSharingControls(); }
});
$('privacy-button').onclick = $('refresh-trust').onclick = () => attempt(showTrust); $('quit-service').onclick = () => attempt(() => api.quitService());
$('privacy-source').onclick = () => attempt(() => api.openExternal('https://github.com/RulerCompass1729/native-agent-workspace/blob/main/docs/privacy.md'));
$('data-directory').onclick = () => attempt(() => api.dataDirectory());
$('clear-shared-history').onclick = () => attempt(async () => {
  const target = trustClearRoom, generation = trustRevision, control = $('clear-shared-history');
  if (control.disabled) return;
  if (target === 'shared' && !state.capabilities?.includes('clearSharedHistory')) throw Error('后台仍在保留旧版会话；结束它们并重开应用后可使用此功能。');
  control.disabled = true;
  try {
    const cleared = await api.spaceAction(target, 'clearSharedHistory', []);
    if (cleared && generation === trustRevision && $('privacy-dialog').open) $('trust-refresh-status').textContent = '这个空间的共享记录已清除；其他空间和未发送草稿保留。';
  } catch (error) {
    if (generation === trustRevision && $('privacy-dialog').open) $('trust-refresh-status').textContent = error.message;
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
      for (const id of ['chosen-folder', 'create-error', 'create-readiness', 'create-permission-note']) $(id).textContent = '';
      $('skip-permissions').checked = false; folder = ''; newDirectory = false;
      $('initial-view').value = '';
      for (const input of dialog.querySelectorAll('input[name="provider"]')) input.checked = false;
    } else if (dialog.id === 'setup-dialog') {
      $('setup-status').replaceChildren(); $('version-info').textContent = '';
    } else if (dialog.id === 'notes-dialog') {
      $('room-notes-text').value = ''; $('notes-error').textContent = ''; $('notes-error').hidden = true;
    } else if (dialog.id === 'context-dialog') {
      contextTarget = null; contextSnapshot = null;
      $('context-space-choices').replaceChildren(); $('context-spaces').disabled = false;
      $('context-scope-note').textContent = ''; $('context-scope-note').hidden = true;
      $('context-text').value = ''; $('context-text').disabled = false; $('context-error').textContent = ''; $('context-error').hidden = true;
      $('copy-context').disabled = false; $('insert-context').disabled = false;
    } else if (dialog.id === 'run-dialog') {
      runPreview = null; $('run-consent').checked = false; $('confirm-run').disabled = true;
      $('run-mode').value = 'replies'; $('run-limit').value = '3'; $('run-participants').replaceChildren();
      for (const id of ['run-preview', 'run-order', 'run-mode-help', 'run-error']) $(id).textContent = '';
      $('run-error').hidden = true;
    } else if (dialog.id === 'terminal-display-dialog') {
      $('terminal-font-size').value = ''; $('terminal-palette').value = '';
    }
  });
}
$('setup-button').onclick = $('create-setup').onclick = $('refresh-setup').onclick = () => attempt(showSetup);
$('close-setup').onclick = () => $('setup-dialog').close();
for (const input of document.querySelectorAll('input[name="provider"]')) input.onchange = createReadiness;
$('claude-history-id').oninput = createReadiness;
$('claude-history-id').onkeydown = event => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('open-native-history').click(); }
};
$('skip-permissions').onchange = createReadiness;
attempt(async () => {
  state = await api.initial();
  if (latestViewStorage !== undefined) state.viewStorageWarning = latestViewStorage;
  roomViews = state.viewState.roomViews || Object.create(null);
  if (!roomViews.shared) roomViews.shared = Object.fromEntries(roomViewFields.filter(k => state.viewState[k] !== undefined).map(k => [k, state.viewState[k]]));
  spaceId = state.viewState.spaceId || 'shared'; sidebarView = state.viewState.sidebarView || 'flat'; sidebarSpaceFilter = state.viewState.sidebarSpaceFilter || '';
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
  await select(state.viewState.selected || '', mode); await api.uiReady();
});
const disposeContentMenus = bindContentMenus();
return () => { clearInterval(nativeActivityClock); roomOverview?.dispose(); document.removeEventListener('toggle', updateSelectedSharing, true); document.removeEventListener('selectionchange', documentSelectionChanged); document.removeEventListener('keydown', searchKey); clearTimeout(searchTimer); disposeReadingViews(); disposeContentMenus(); sessionMenu?.close(); roomMenu?.(); for (const dispose of disposers) dispose(); observer.disconnect(); clearTimeout(toastTimer); for (const entry of terminals.values()) entry.term.dispose(); };
