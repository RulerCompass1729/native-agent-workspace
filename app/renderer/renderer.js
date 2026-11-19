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
const stateText = record => record.nativeTerminalDialog ? uiText('state.terminalDialog', { title: record.nativeTerminalDialog.title }) : uiText(states[record.state] || 'state.unknown');
// An unfollowed native /resume leaves the process running in another session.
const switchedAway = record => record.state === 'stopping' && record.nativeContextPending?.reason === 'resume';
function exhaustedRecovery(record) {
  const recovery = record.capacityRecovery;
  if (disconnected || record.archived || record.backendUnavailable || record.transportDisconnected ||
      record.nativeContextPending || record.approval || record.approvalOverflow || record.claudeQuestion || record.nativeApproval || record.nativeInputRequired ||
      !['idle', 'error'].includes(record.state) || typeof record.nativeId !== 'string' || !record.nativeId ||
      recovery?.nativeId !== record.nativeId || typeof recovery.turnId !== 'string' || !recovery.turnId ||
      recovery.status !== 'exhausted' || recovery.attempt !== 3 || !['capacity', 'routing', 'forbidden', 'connection'].includes(recovery.reason)) return null;
  return recovery;
}
function recoveryStatusSuffix(recovery, prefix = true) {
  return recovery ? (prefix ? ' · ' : '') + uiText(recovery.reason === 'routing' ? 'capacityBadge.routingStopped' : recovery.reason === 'forbidden' ? 'capacityBadge.forbiddenStopped' : recovery.reason === 'connection' ? 'capacityBadge.connectionStopped' : 'capacityBadge.capacityStopped') + uiText('capacityBadge.retried', { count: recovery.attempt }) : '';
}
const sessionStatus = (record, recoveryBadge = false) => {
  if (record.state === 'stopping' && record.nativeContextPending && !switchedAway(record)) return uiText('collab.contextUnknown');
  const status = window.nativeWorkspaceFleet.fleetStatus(record, switchedAway(record) ? uiText('state.switched') : record.claudeQuestion ? uiText('state.question') : stateText(record), !disconnected, uiText);
  return status + recoveryStatusSuffix(recoveryBadge && exhaustedRecovery(record));
};
let state, owner, selected = '', mode = 'terminal', preference = 'terminal', folder = '', disconnected = false;
const mobileSetup = window.nativeWorkspaceMobileSetup.bind({ container: $('mobile-setup'), document, api, getSessions: () => state?.sessions || [], getRooms: () => state?.rooms || [], text: (key, params) => uiText(key, params), display: ui.display,
  // The address, Tailscale user and port live in this window's saved view, so a restart does not ask for them again.
  remembered: () => state?.viewState?.mobileEndpoint || null,
  remember: value => { if (!state?.viewState) return; state.viewState.mobileEndpoint = value; attempt(() => api.viewState({ selected, mode, preference, mobileEndpoint: value })); } });
// The butler's parts are optional to this window: if one cannot be set up (its module or its element is missing),
// the window starts without it instead of not starting at all, and what took its place says so when it is its turn.
// A read log page that could not be set up: asked for, it says that the page failed and why, in the page's own
// place. It is the interface that failed, not the log, so it never reads as "nothing was read" or "the log cannot
// be read". reason: 'module' (the page's program is not in this window), 'element' (its place in the page is
// missing), 'setup' (setting it up failed), 'open' (it was set up and failed when it was asked for).
function failedButlerReads(reason) {
  let dialog = null, made = false, parts = [];
  const close = () => { if (dialog?.open) dialog.close(); };
  return { failed: reason,
    open() {
      try {
        if (!dialog) {
          dialog = $('butler-reads-dialog');
          // Made in the page's own place for it, after the record table's dialog: the page's styles reach only there.
          if (!dialog) { dialog = node('dialog', undefined, 'butler-reads'); dialog.id = 'butler-reads-dialog'; dialog.setAttribute('closedby', 'any'); $('butler-review-dialog').after(dialog); made = true; }
        }
        const title = node('h2'), text = node('p', undefined, 'butler-reads-note'), actions = node('div', undefined, 'dialog-actions'), done = node('button');
        title.id = 'butler-reads-dialog-title'; dialog.setAttribute('aria-labelledby', title.id); text.setAttribute('role', 'alert');
        done.type = 'button'; done.dataset.action = 'done'; done.addEventListener('click', close);
        ui.display.text(title, 'butler.reads.title'); ui.display.text(text, 'butler.reads.pageFailed.' + reason); ui.display.text(done, 'common.done');
        for (const part of parts) ui.display.unbind(part);
        parts = [title, text, done]; actions.append(done); dialog.replaceChildren(title, text, actions);
        dialog.dataset.readsState = 'page-failed'; dialog.dataset.readsFailure = reason;
        if (!dialog.open) dialog.showModal();
        done.focus();
      } catch (error) { console.error(error); toastError(uiError('error.butler.readsPage')); }
    },
    dispose() { close(); for (const part of parts) ui.display.unbind(part); parts = []; if (dialog) { if (made) dialog.remove(); else dialog.replaceChildren(); } } };
}
// The read log names a space by this window's own name for it; the log itself holds ids only.
let butlerReads;
try { butlerReads = window.nativeWorkspaceButlerReads.bind({ dialog: $('butler-reads-dialog'), document, api, text: (key, params) => uiText(key, params), display: ui.display,
  spaceName: id => { const room = spaceRecord(id); return room ? spaceName(room) : null; } }); }
catch (error) { console.error(error); butlerReads = failedButlerReads(!window.nativeWorkspaceButlerReads ? 'module' : !$('butler-reads-dialog') ? 'element' : 'setup'); }
// Asking for the page. A page that was set up can still fail as it opens (its element gone from the window, an
// error before anything is drawn): that must not end in nothing on the screen, so the failure view takes its place.
function openButlerReads() {
  const failed = error => {
    console.error(error);
    try { butlerReads.dispose(); } catch { /* What is left of it is replaced below. */ }
    butlerReads = failedButlerReads('open'); butlerReads.open();
  };
  try { const opening = butlerReads.open(); if (typeof opening?.catch === 'function') opening.catch(failed); }
  catch (error) { failed(error); }
}
// The existing butler view owns visibility and state; the record table has no second sidebar entry.
const butlerReviewAdapter = window.nativeWorkspaceButlerReviewAdapter.create({ api, text: uiText });
const butlerReviewView = window.nativeWorkspaceButlerReview.create({ dialog: $('butler-review-dialog'),
  text: uiText, language: () => ui.language.getSnapshot().active,
  read: () => butlerReviewAdapter.open(), readNew: () => butlerReviewAdapter.freeze(), confirm: draft => butlerReviewAdapter.confirm(draft) });
let butlerReviewOpening = false, butlerReviewDisposed = false;
async function openButlerReview() {
  if (butlerReviewDisposed || butlerReviewOpening || $('butler-row')?.hidden !== false) return;
  butlerReviewOpening = true;
  try {
    const availability = await api.butlerReview('availability');
    if (butlerReviewDisposed || $('butler-row')?.hidden !== false) return;
    if (availability?.available !== true || availability.hasData !== true) throw uiError('error.butlerReview.unavailable');
    await butlerReviewView.open();
  } catch (error) { if (!butlerReviewDisposed) toastError(error); }
  finally { butlerReviewOpening = false; }
}
function returnFromButlerReview() {
  if (!butlerReviewDisposed && $('butler-row')?.hidden === false) $('butler-row').focus({ preventScroll: true });
}
function disposeButlerReview() {
  butlerReviewDisposed = true;
  $('butler-review-dialog').removeEventListener('close', returnFromButlerReview);
  butlerReviewView.dispose(); butlerReviewAdapter.dispose();
}
$('butler-review-dialog').addEventListener('close', returnFromButlerReview);
// The butler's row when the entry could not be set up. Like the entry, it shows nothing until the main process has
// answered that this window has an entry: with the switch closed its one question is refused, nothing more is
// asked and the window is as it was. With an entry, the row stays in its place and says that it is the interface
// that failed; its dialog says why and what cannot be done from here, and still opens the read log, which needs no
// entry. It asks for the state and for nothing else. reason: 'module' (the entry's program is not in this window),
// 'element' (the row or its dialog is missing from the page), 'setup' (setting it up failed).
function failedButlerEntry(reason) {
  let row = null, dialog = null, done = null, asked = false, gone = false, parts = [];
  const made = [];
  const close = () => { if (dialog?.open) dialog.close(); };
  const label = () => uiText('butler.rowLabel', { state: uiText('butler.row.failed') });
  const unseen = (cls, text) => { const part = node('span', text, cls); part.setAttribute('aria-hidden', 'true'); return part; };
  const said = (tag, key, cls) => { const part = node(tag, undefined, cls); ui.display.text(part, key); parts.push(part); return part; };
  const control = (key, action, press) => { const part = said('button', key); part.type = 'button'; part.dataset.action = action; part.addEventListener('click', press); return part; };
  function open() {
    try {
      if (!done) {
        dialog = $('butler-dialog');
        // Made in the page's own place for it, before the record table's dialog: the page's styles reach only there.
        if (!dialog) { dialog = node('dialog', undefined, 'butler-dialog'); dialog.id = 'butler-dialog'; dialog.setAttribute('closedby', 'any'); $('butler-review-dialog').before(dialog); made.push(dialog); }
        const title = said('h2', 'butler.name'), text = said('p', 'butler.entryFailed.' + reason, 'butler-note'), actions = node('div', undefined, 'dialog-actions');
        title.id = 'butler-dialog-title'; dialog.setAttribute('aria-labelledby', title.id); text.setAttribute('role', 'alert');
        // Reading the log changes nothing and needs no entry: the person can still see what the butler was given.
        const finish = control('common.done', 'done', close);
        actions.append(control('butler.action.reads', 'reads', () => { close(); openButlerReads(); }), finish);
        dialog.replaceChildren(title, text, actions); dialog.dataset.butlerState = 'failed'; dialog.dataset.butlerFailure = reason;
        done = finish;
      }
      if (!dialog.open) dialog.showModal();
      done.focus();
    } catch (error) { console.error(error); toastError(uiError('error.butler.entryRow')); }
  }
  function show() {
    row = $('butler-row');
    if (!row) { row = node('button', undefined, 'butler-row'); row.id = 'butler-row'; row.type = 'button'; row.setAttribute('aria-haspopup', 'dialog'); $('new-session').before(row); made.push(row); }
    const state = node('span', undefined, 'butler-state');
    state.append(unseen('butler-dot'), said('span', 'butler.row.failed'));
    // Whatever a setup that failed half way left in the row goes.
    row.replaceChildren(unseen('rail-icon', '◆'), said('span', 'butler.name', 'rail-label'), state);
    row.dataset.butlerState = 'failed'; row.dataset.butlerFailure = reason;
    for (const slot of ['aria-label', 'title']) ui.display.computed(row, slot, label);
    row.addEventListener('click', open); row.hidden = false;
  }
  return { failed: reason,
    // The window's one question, asked once: is there an entry in this window at all? An answer, or the refusal an
    // open entry gives when the state cannot be verified, says there is. Any other refusal shows nothing.
    // The answer itself is not looked at. The entry hides for an answer it does not understand, because it would
    // have to draw from it; this row draws nothing from it, and a row that vanished is what it is here to prevent.
    start() {
      if (asked) return undefined;
      asked = true;
      return (async () => {
        try { await api.butler('status'); }
        catch (error) { let key; try { key = error?.uiMessage?.key; } catch { /* No key: an unknown failure. */ } if (key !== 'error.butler.unavailable') return; }
        if (gone) return;
        try { show(); } catch (error) { console.error(error); toastError(uiError('error.butler.entryRow')); }
      })();
    },
    refresh() {},
    dispose() {
      gone = true; close(); for (const part of parts) ui.display.unbind(part); parts = [];
      if (row) { row.removeEventListener('click', open); for (const slot of ['aria-label', 'title']) ui.display.unbind(row, slot); row.hidden = true; row.replaceChildren(); }
      if (dialog) dialog.replaceChildren();
      for (const part of made) part.remove();
    } };
}
// The butler's row is drawn only from a view the main process gives this window; this version gives none.
let butlerEntry;
try { butlerEntry = window.nativeWorkspaceButlerEntry.bind({ row: $('butler-row'), dialog: $('butler-dialog'), document, api, text: (key, params) => uiText(key, params), display: ui.display, showError: ui.showError, openReview: openButlerReview,
  openReads: () => openButlerReads(),
  // Another window may have changed the designation: the entry asks again when this one comes back to the front.
  front: listener => { window.addEventListener('focus', listener); return () => window.removeEventListener('focus', listener); } }); }
catch (error) { console.error(error); butlerEntry = failedButlerEntry(!window.nativeWorkspaceButlerEntry ? 'module' : !$('butler-row') || !$('butler-dialog') ? 'element' : 'setup'); }
let newDirectory = false, creatingSession = false;
// The bell: reminders about records kept whole, asked for once as the window starts (nothing polls).
let recordReminders = null;
try { recordReminders = window.nativeWorkspaceRecordReminders.bind({ button: $('records-button'), badge: $('records-badge'), dialog: $('records-dialog'), document, api, confirmation: showBackgroundConfirmation, summaryText: summary => backgroundSummaryText(summary, true), text: (key, params) => uiText(key, params), display: ui.display });
  recordReminders.refresh(); }
catch (error) { console.error(error); }
let discoveriesView = null;
if (window.nativeWorkspaceRegularPopup && $('discoveries-button') && api.discoveries) {
  discoveriesView = window.nativeWorkspaceRegularPopup.bind({ host: $('discoveries-root'), button: $('discoveries-button'), badge: $('discoveries-badge'), document, api, text: uiText, subscribe: fn => ui.language.subscribe(fn) });
}
// 「大管家的记录」, opened from the butler's own menu.
let stewardSteps = null;
try { stewardSteps = window.nativeWorkspaceStewardRecord.bind({ dialog: $('steward-record-dialog'), document, api, text: (key, params) => uiText(key, params), display: ui.display,
  usageLines: (provider, usage, language) => window.nativeWorkspaceUsage.usageLines(provider, usage, language), language: () => ui.language.getSnapshot().active }); }
catch (error) { console.error(error); }
let gitWorktreePlan = null, gitWorktreeNonce = '', gitPreviewRevision = 0, gitPreviewLoading = false, gitPreviewTimer;
let latestViewStorage, latestViewStorageUiMessage;
let roomSession = '', selectionRevision = 0, pendingMode;
let roomSurface = 'overview', roomOverview;
let activityStream;
let panorama, panoramaOrigin, roomReturnReading;
let panoramaView = { layout: 'list', query: '', spaceId: '', top: 0, returning: false };
let spaceId = 'shared', sidebarView = 'flat', hoverSpace = '';
let spaceNavigationMenu = null, spaceRailBefore = null;
let sidebarCollapsedGroups = new Set();
let sidebarCollapsedFolders = new Set();
// T-135: each grid column's terminal height, by session, saved with this window's view.
let columnTerminalHeights = {};
const COLUMN_TERMINAL = { initial: 112, min: 64, most: 4000, step: 16, conversation: 80 };
let roomViews = Object.create(null);
const roomHistories = new Map(), spaceRows = new Map(), sidebarGroups = new Map();
const inSpace = (s, id = spaceId) => window.nativeWorkspaceSpaces.isMember(s, id);
const pairRevision = (s, id = spaceId) => window.nativeWorkspaceSpaces.membershipRevision(s, id);
const storedSpaces = () => state?.rooms || (state?.room ? [state.room] : []);
// The untouched legacy container is not a user-created space. Keep its data and
// reveal it as soon as it has members or any saved activity; never migrate it.
const allSpaces = () => storedSpaces().filter(r => r.id !== 'shared' || r.metadataRevision || r.revision || r.archived || r.notes || r.files?.length || r.messages?.length || r.events?.length || state?.sessions.some(s => inSpace(s, r.id)));
const spaceRecord = id => storedSpaces().find(r => r.id === id);
const taskBoard = window.nativeWorkspaceTaskBoard.bind({ host: $('task-board'), document, text: uiText, onQueue: id => openQueue(id), onSession: (id, nativeId) => attempt(async () => { const record = state?.sessions.find(s => s.id === id && !s.archived && (!nativeId || s.nativeId === nativeId)); if (!record) { toastMessage('toast.originalRemoved'); return; } await select(id, 'chat'); }), onConfirmation: request => attempt(async () => { if (await showBackgroundConfirmation(request) === false) toastMessage('records.confirmations.unavailable'); }) });
// A space's name as shown: the untouched default space follows the interface language; any name the person gave stays as is (T-60).
const spaceName = room => window.nativeWorkspaceSpaces.untouchedDefault(room) ? uiText('space.defaultName') : room?.name;
function updateTaskBoard() {
  if (!state) return;
  taskBoard.update({ rooms: allSpaces().map(r => ({ id: r.id, name: spaceName(r), archived: r.archived, unavailable: r.unavailable,
    queue: Array.isArray(r.queue) ? r.queue.filter(q => q && typeof q.id === 'string').map(q => ({ id: q.id, status: q.status, text: q.text,
      reason: q.reason, sentTo: q.sentTo, assignee: q.assignee, finishedAt: q.finishedAt, waiting: Array.isArray(q.wait) && q.wait.length > 0 })) : undefined })),
    sessions: state.sessions.map(s => {
      let roomIds; try { roomIds = window.nativeWorkspaceSpaces.roomIds(s); } catch {}
      const fleet = window.nativeWorkspaceFleet.currentFleet(s, !disconnected);
      return { id: s.id, nativeId: s.nativeId, name: s.name, state: s.state, roomIds, membershipUnknown: !roomIds, archived: s.archived, backendUnavailable: s.backendUnavailable,
        transportDisconnected: s.transportDisconnected, nativeContextPending: s.nativeContextPending,
        approval: s.approval ? { pending: s.approval.pending } : null, approvals: s.approvals?.map(a => ({ pending: a.pending })),
        claudeQuestion: s.claudeQuestion ? { pending: s.claudeQuestion.pending } : null, approvalOverflow: Boolean(s.approvalOverflow),
        nativeApproval: s.nativeApproval ? { requests: s.nativeApproval.requests?.map(a => ({ pending: a.pending })) } : null, nativeInputRequired: s.nativeInputRequired,
        background: s.background, backgroundStale: s.backgroundStale, runningChildren: fleet.running, unknownChildren: fleet.unknown, workUnconfirmed: fleet.work.unconfirmed };
    }), confirmations: state.backgroundConfirmations?.map(c => ({ key: c.key, id: c.id, sessionId: c.sessionId, nativeId: c.nativeId, operationId: c.operationId,
      state: c.state, actionable: c.actionable, expiresAt: c.expiresAt, replacedBy: Boolean(c.replacedBy), disposition: c.disposition })),
    confirmationsAvailable: state.backgroundConfirmationsAvailable, connected: !disconnected, activeSpace: spaceId });
}
const spaceCall = (action, ...args) => api.spaceAction(spaceId, action, args);
const roomViewFields = ['sharedDraft', 'roomSession', 'roomRecipient', 'roomMention', 'roomFilter', 'roomSearch', 'roomThread', 'roomReplyTo', 'roomSurface', 'roomImages', 'roomImageVersion', 'roomImageSend', 'roomMemberViews', 'roomRecordScope', 'roomRecordReturn', 'roomFilterHistory', 'draftRevision'];
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
let roomImagesWidget, roomImagePickerSpace;
let roomMentionHistory = nativeWorkspaceMentions.editHistory();
let mentionChanging = false, mentionComposing = false;
let pendingRoomFilter = '';
let roomThread = '', roomReplyTo = '';
let roomRecordScope = '', roomRecordReturn = null, roomFilterHistory = null;
const roomRecordSelections = new Map();
let roomThreads = window.nativeWorkspaceThreads.threadIndex([]);
const roomReadingKey = () => roomRecordScope ? `related:${spaceId}:${roomRecordScope}` : roomRecordReturn ? `related-all:${spaceId}:${roomRecordReturn.id}` : roomRecentPreview() ? `room-recent:${spaceId}` : spaceId === 'shared' ? roomThread ? `room:${roomThread}` : 'room' : `room:${spaceId}:${roomThread || 'main'}`;
const sessionRows = new Map();
const sessionRow = id => sessionRows.get(id) || [...sessionRows.values()].find(row => row.sessionId === id && row.element.getClientRects().length) || [...sessionRows.values()].find(row => row.sessionId === id);
const roomTone = id => `space-tone-${Math.max(0, allSpaces().findIndex(r => r.id === id)) % 6}`;
function roomRecentPreview() {
  return !roomRecordReturn && !roomRecordScope && Boolean(roomFilterHistory) && !($('room-filter').value || pendingRoomFilter || $('room-search').value || roomThread);
}
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
const placementProof = record => ({ nativeId: record.nativeId,
  placementRevision: window.nativeWorkspaceSpaces.placementRevision(record), connectionRevision: record.connectionRevision || 0 });
async function addToSpace(id, destination) {
  const room = spaceRecord(destination), record = state.sessions.find(s => s.id === id);
  if (!room || room.archived || !record || record.archived) throw uiError("error.spaceChanged");
  if (!window.nativeWorkspaceSpaces.canJoin(record, destination)) throw oldBackendJoin(record);
  if (window.nativeWorkspaceSpaces.roomIds(record).length && !inSpace(record, destination) && !record.serviceCapabilities?.includes('singleHomeMoveV1')) throw uiError('error.movePlacementUnsupported');
  const receipt = await api.spaceAction(destination, 'join', [id, true, placementProof(record)]);
  updateState(await api.initial()); render();
  if (!receipt?.changed) return toastMessage("toast.alreadyMember", { arg1: spaceName(room) });
  toastMessage("toast.joinedSpace", { arg1: spaceName(room) }, { label: uiText('action.undoJoin'), labelKey: 'action.undoJoin', nameKey: 'action.undoJoinName', params: () => ({ name: spaceName(room) }), run: async () => {
    const previous = receipt.previousRoomId || null;
    const proof = receipt.placementRevision !== undefined
      ? { nativeId: receipt.nativeId, placementRevision: receipt.placementRevision, connectionRevision: receipt.connectionRevision }
      : { revision: receipt.revision, nativeId: receipt.nativeId };
    await api.spaceAction(previous || destination, 'join', [id, Boolean(previous), proof]);
    updateState(await api.initial()); render(); toastMessage("toast.undoJoinDone", { arg1: spaceName(spaceRecord(destination) || room) });
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
const terminalRenderLoads = new Map();

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
// A session this page does not show comes without its messages (shown-sessions.cjs). What other places read
// from them, main has worked out into messageSummary; each reader checks messagesOmitted itself.
function hasAssistantMessage(s) { return s?.messagesOmitted ? Boolean(s.messageSummary?.hasAssistant) : Boolean(s?.messages.some(m => m.role === 'assistant')); }
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
  if (!s || !composerCurrent(binding)) return;
  // Text typed before this window has taken a free session becomes its draft once taken (updateState).
  if (s.owner !== owner) { if (!heldElsewhere(s)) binding.typedWhileFree = true; return; }
  const revision = (draftRevisions.get(s.id) || 0) + 1; draftRevisions.set(s.id, revision);
  const pending = { text: binding.ui.input.value, revision }; pendingDrafts.set(s.id, pending); s.liveDraft = pending.text;
  attempt(async () => {
    try { await api.draft(s.id, pending.text); }
    catch (error) { if (draftRevisions.get(s.id) === revision && pending.text) rememberDraftRecovery(s.id, pending.text); throw error; }
    finally { if (pendingDrafts.get(s.id) === pending) pendingDrafts.delete(s.id); if (activeSessionId() === s.id) renderDraftRecovery(s.id); }
  });
  updateSessionComposer(binding, s, binding.column);
}
// Refused before anything reached native because the method was picked on
// older state than the service's: a typing hold delays state pushes up to 1.5 s.
const staleMethodRefusals = new Set(['error.workspace.sessionNotReady', 'error.workspace.nativeWaitingInputUnavailable', 'error.workspace.nativeTurnOrControlChanged', 'error.client.currentNativeSessionOrControlChanged', 'error.client.currentTurnOrControlChanged']);
const STALE_METHOD_WAIT_MS = 1000;
let stateArrivals = 0;
const stateArrivalWaiters = new Set();
function stateArrived() { stateArrivals++; for (const wake of [...stateArrivalWaiters]) wake(); }
function nextStateArrival(seen, until) {
  if (stateArrivals !== seen) return Promise.resolve();
  return new Promise(resolve => {
    const wake = () => { clearTimeout(timer); stateArrivalWaiters.delete(wake); resolve(); };
    const timer = setTimeout(wake, Math.max(0, until - Date.now())); stateArrivalWaiters.add(wake);
  });
}
function sessionInputMethod(s) {
  if (s.state === 'working' && s.queueAvailable) return { method: 'queue' };
  if (s.state === 'working' && s.steerAvailable && s.activeTurnId) return { method: 'steer', turnId: s.activeTurnId };
  return { method: 'send' };
}
// marks: where this call's queue mark lives. The composer's is queuedInputs; another entry passes its own, so
// it never replaces or borrows the composer's.
async function deliverSessionInput(s, pick, text, revision, marks = queuedInputs) {
  const { id, nativeId } = s;
  const mark = pick.method === 'queue' && { id, text, revision, before: new Set(s.messages.map(m => m.id)) };
  if (mark) {
    for (const other of openQueueMarks) if (other.id === id && other.text.trim() === text.trim()) other.overlap = mark.overlap = true;
    openQueueMarks.add(mark); marks.set(id, mark);
  }
  try { return mark ? await api.queue(id, text, nativeId) : pick.method === 'steer' ? await api.steer(id, text, nativeId, pick.turnId) : await api.send(id, text, nativeId); }
  finally { if (mark) { openQueueMarks.delete(mark); if (!mark.tag && marks.get(id) === mark) marks.delete(id); } }
}
// Queue calls still open, from any entry. Two open at once to one session with the same words cannot tell their
// rows apart by the words (the service takes one at a time, refusing the other before recording it): neither takes
// a row by them.
const openQueueMarks = new Set();
async function submitSession(binding) {
  const s = state.sessions.find(s => s.id === binding.id), action = soloAction(s, { column: binding.column, mode: binding.column ? 'chat' : mode });
  // Until its messages are here (a member that just joined, a session opened before its state; reportShown) nothing
  // is sent and the text stays: a queue mark needs them.
  if (!composerCurrent(binding) || binding.ui.send.disabled || binding.ui.composing || action.kind !== 'send' || s.messagesOmitted) return;
  if (inputFocusAllowed()) binding.ui.input.focus();
  const { id, nativeId } = s, text = binding.ui.input.value, revision = draftRevisions.get(id);
  // Counted, not locked: a queued Claude message keeps its call open until its turn starts.
  const submit = binding.submits = (binding.submits || 0) + 1, pick = sessionInputMethod(s);
  const deliver = async (target, choice) => { binding.delivering = (binding.delivering || 0) + 1; try { return await deliverSessionInput(target, choice, text, revision); } finally { binding.delivering--; } };
  let seen = stateArrivals, receipt;
  try { receipt = await deliver(s, pick); }
  catch (error) {
    if (!staleMethodRefusals.has(error?.uiMessage?.key)) throw error;
    // A later Enter in this composer carries the same box; it reports its own outcome.
    if (binding.submits !== submit) return;
    // An earlier call from this composer still open may yet leave this same text in the box.
    if (binding.delivering) throw error;
    // Enter then means what it means on the newer state: pick again, send at most once more.
    const until = Date.now() + STALE_METHOD_WAIT_MS;
    let now, next;
    for (;;) {
      await nextStateArrival(seen, until); seen = stateArrivals;
      if (binding.submits !== submit) return;
      now = state.sessions.find(x => x.id === id);
      const again = now && soloAction(now, { column: binding.column, mode: binding.column ? 'chat' : mode });
      if (!again || again.kind !== 'send' || now.nativeId !== nativeId || now.nativeContextPending || !composerCurrent(binding) || binding.ui.send.disabled || binding.ui.composing || draftRevisions.get(id) !== revision || binding.ui.input.value !== text) throw error;
      next = sessionInputMethod(now);
      if (next.method !== pick.method || next.turnId !== pick.turnId) break;
      if (Date.now() >= until) throw error;
    }
    receipt = await deliver(now, next);
  }
  const fresh = state.sessions.find(s => s.id === id);
  if (!receipt?.contextChanged && fresh?.owner === owner && fresh?.nativeId === nativeId && !fresh.nativeContextPending && draftRevisions.get(id) === revision && binding.ui.input.value === text) binding.ui.setValue('');
}
async function sessionComposerAction(binding) {
  if (!composerCurrent(binding) || binding.ui.send.disabled) return;
  const s = state.sessions.find(s => s.id === binding.id), action = soloAction(s, { column: binding.column, mode: binding.column ? 'chat' : mode });
  if (binding.column) {
    if (action.kind === 'terminal') return activateColumnNative(binding);
    if (action.kind === 'claim') return changeColumnView(binding, 'chat', true);
    if (action.kind === 'connect') {
      await api.prepareInput(s.id); if (!composerCurrent(binding)) return;
      updateState(await api.initial()); render();
      if (s.provider === 'claude') await activateColumnNative(binding); return;
    }
    if (action.kind === 'resume') { await api.resume(s.id); return; }
    return;
  }
  if (action.kind === 'terminal') await switchMode('terminal');
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
    binding.revision++; binding.resizeAllowed = false;
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
    if (wasVisible && !visible) { binding.revision++; binding.resizeAllowed = false; binding.ui.suspend(); const entry = terminals.get(record.id); if (entry) { cancelColumnComposition(entry); entry.term.blur(); } }
    if (visible) {
      if (binding.nativeHost.parentElement !== host) host.append(binding.nativeHost); if (binding.ui.form.parentElement !== host) host.append(binding.ui.form);
      const sash = columnTerminalSash(binding);
      if (sash.nextSibling !== binding.nativeHost) host.insertBefore(sash, binding.nativeHost);
    }
    else if (binding.ui.form.parentElement !== composerParking) composerParking.append(binding.ui.form);
    updateSessionComposer(binding, record, true); takeFreeSession(binding, record);
  }
  const nativeVisible = visible && (record.view === 'terminal' || record.terminalState?.alive === true) && binding !== soloComposer;
  binding.nativeVisible = nativeVisible; binding.nativeHost.hidden = !nativeVisible;
  if (binding.nativeSash) {
    binding.nativeSash.hidden = !nativeVisible;
    ui.display.attribute(binding.nativeSash, 'aria-label', 'terminal.heightName', { name: participantLabel(record, state.sessions) });
    // Its height is measured with every other column once the whole space is drawn (refreshColumnTerminalHeights):
    // measuring here, between columns, laid the page out again for each column on every redraw.
    if (!nativeVisible) binding.terminalDrag = null;
  }
  if (nativeVisible && nativeUsable(record) && record.terminalState?.alive) renderTerminal(record.id, true);
  syncTerminalMount(record.id);
  return nativeVisible;
}
// T-135: a column's terminal can be made taller or shorter by dragging the line above it or
// with the keys. While the person changes it, it stays between 64px and the height that leaves
// the conversation up to 80px when space permits and the input whole, with a 64px terminal floor.
// On release the native terminal is fitted once.
function columnTerminalLimits(binding) {
  const input = binding.columnHost, reader = input?.closest('.collaboration-member-reader');
  // Everything else in the column below the conversation: the line, the input, gaps and any footer.
  const others = input ? input.offsetHeight - binding.nativeHost.offsetHeight + (reader.querySelector('.column-native-footer:not([hidden])')?.offsetHeight || 0) : 0;
  const room = reader ? reader.clientHeight - columnReadingFloor(reader) - others : COLUMN_TERMINAL.initial;
  return { min: COLUMN_TERMINAL.min, max: Math.min(COLUMN_TERMINAL.most, Math.max(COLUMN_TERMINAL.min, Math.floor(room))) };
}
// The viewport keeps its floor; a visible prompt slot needs additional room.
function columnReadingFloor(reader) { return COLUMN_TERMINAL.conversation + (reader?.querySelector('.reading-slot')?.offsetHeight || 0); }
function columnTerminalHeight(id) { return Number.isSafeInteger(columnTerminalHeights[id]) ? columnTerminalHeights[id] : COLUMN_TERMINAL.initial; }
// T-163: the hint under a column's input shows up to four of its lines, and never fewer than two.
const COLUMN_HINT = { line: 16, least: 2, most: 4 };
// How many lines of its hint a column shows: as many as fit beside an 80px conversation and a 64px terminal, up to
// four, and at least the two it always showed. A longer hint scrolls. Only the column's height and its fixed parts
// count, not the hint's own length, so the number does not move with what the hint says.
function fitColumnHint(binding) {
  const input = binding.columnHost, reader = input?.closest('.collaboration-member-reader'), hint = input?.querySelector('.session-compose-hint');
  if (!reader || !hint) return;
  const rest = input.offsetHeight - binding.nativeHost.offsetHeight - hint.offsetHeight + (reader.querySelector('.column-native-footer:not([hidden])')?.offsetHeight || 0);
  const fit = Math.floor((reader.clientHeight - columnReadingFloor(reader) - COLUMN_TERMINAL.min - rest) / COLUMN_HINT.line);
  const lines = String(Math.max(COLUMN_HINT.least, Math.min(COLUMN_HINT.most, fit)));
  if (input.style.getPropertyValue('--column-hint-lines') !== lines) input.style.setProperty('--column-hint-lines', lines);
}
// The most recently changed heights are kept, at most 200 (the saved view refuses more).
function rememberColumnTerminalHeight(id, value) {
  delete columnTerminalHeights[id]; columnTerminalHeights[id] = value;
  const ids = Object.keys(columnTerminalHeights); for (const old of ids.slice(0, Math.max(0, ids.length - 200))) delete columnTerminalHeights[old];
}
function fitColumnTerminal(binding) { binding.resizeAllowed = true; fitTerminal(binding.id); revealTerminalCursor(terminals.get(binding.id)); }
// The column budget also applies below the default height, leaving the conversation and
// input visible. 'adjust' and 'save' are the person's changes; 'save' remembers the height
// and fits the native terminal once. A redraw only clamps the displayed box: the saved
// choice and native grid stay unchanged, with scrolling and the cursor kept in view.
function columnTerminalTallest(binding) { return columnTerminalLimits(binding).max; }
function applyColumnTerminalHeight(binding, height, mode = 'redraw') {
  fitColumnHint(binding);
  const { min } = columnTerminalLimits(binding), top = columnTerminalTallest(binding);
  const value = Math.max(min, Math.min(top, Math.round(height))), before = binding.terminalHeight;
  binding.terminalHeight = value; binding.nativeHost.style.height = `${value}px`;
  const sash = binding.nativeSash;
  if (sash) { sash.setAttribute('aria-valuemin', String(min)); sash.setAttribute('aria-valuemax', String(top)); sash.setAttribute('aria-valuenow', String(value)); }
  if (mode === 'save') { rememberColumnTerminalHeight(binding.id, value); attempt(persistView); fitColumnTerminal(binding); }
  else if (mode === 'redraw' && before !== undefined && before !== value) {
    const entry = terminals.get(binding.id); if (!entry?.columnReading) revealTerminalCursor(entry);
  }
  return value;
}
// The source's screen line is shared, not its numeric height: forms and footers can differ.
function columnTerminalAlignment(source) {
  const key = memberMenuKey(source.id), room = spaceId;
  if (!key || columnTerminalBinding(source.id) !== source) return null;
  const targets = orderedMembers().map(member => ({ id: member.id, binding: columnTerminalBinding(member.id) }));
  for (const target of targets) if (target.binding) target.bottom = target.binding.nativeSash.getBoundingClientRect().top + target.binding.terminalHeight;
  return { source, key, room, targets };
}
function cancelColumnTerminalAlignment(group, message = 'toast.terminalAlignCancelled') {
  if (!group || group.cancelled) return false;
  group.cancelled = true;
  if (group.adjusted) for (const t of group.targets) {
    if (!t.binding || sessionComposers.get(t.id) !== t.binding) continue;
    if (columnTerminalBinding(t.id) === t.binding) applyColumnTerminalHeight(t.binding, columnTerminalHeight(t.id), 'adjust');
    else { t.binding.terminalHeight = undefined; t.binding.nativeHost.style.height = ''; }
  }
  if (group.source.terminalDrag?.group === group) group.source.terminalDrag = null;
  toastMessage(message); return false;
}
function alignColumnTerminals(group, requestedY, save = true) {
  if (!group || group.cancelled) return false;
  if (group.room !== spaceId || group.key !== memberMenuKey(group.source.id) || columnTerminalBinding(group.source.id) !== group.source) return cancelColumnTerminalAlignment(group);
  const membersNow = orderedMembers();
  if (membersNow.length !== group.targets.length || group.targets.some((t, i) => t.id !== membersNow[i]?.id || t.binding !== columnTerminalBinding(t.id))) return cancelColumnTerminalAlignment(group);
  const visible = group.targets.filter(t => t.binding);
  // A layout change during a captured drag is not permission to move a different line.
  if (visible.some(t => Math.abs(t.binding.nativeSash.getBoundingClientRect().top + t.binding.terminalHeight - t.bottom) > 1)) return cancelColumnTerminalAlignment(group);
  const minY = Math.max(...visible.map(t => t.bottom - columnTerminalTallest(t.binding)));
  const maxY = Math.min(...visible.map(t => t.bottom - columnTerminalLimits(t.binding).min));
  if (minY > maxY) return cancelColumnTerminalAlignment(group, 'toast.terminalAlignUnavailable');
  const y = Math.max(minY, Math.min(maxY, requestedY));
  for (const t of visible) applyColumnTerminalHeight(t.binding, t.bottom - y, 'adjust');
  group.adjusted = true;
  if (save) {
    for (const t of group.targets) {
      rememberColumnTerminalHeight(t.id, t.binding ? t.binding.terminalHeight : group.source.terminalHeight);
      if (t.binding) fitColumnTerminal(t.binding);
    }
    attempt(persistView);
    group.adjusted = false;
    toastMessage(Math.abs(y - requestedY) > 1 ? 'toast.terminalAlignLimited' : 'toast.terminalAligned');
  }
  return true;
}
let columnTerminalOverlay;
function hideColumnTerminalHint(binding) {
  if (!columnTerminalOverlay || binding && columnTerminalOverlay.binding !== binding) return;
  columnTerminalOverlay.hint.hidden = columnTerminalOverlay.guide.hidden = true; columnTerminalOverlay.binding = null;
}
function showColumnTerminalHint(binding) {
  if (!columnTerminalBinding(binding.id)) return hideColumnTerminalHint(binding);
  if (!columnTerminalOverlay) {
    const hint = node('div', undefined, 'column-terminal-hint'), guide = node('div', undefined, 'column-terminal-guide');
    hint.id = 'column-terminal-height-hint'; hint.setAttribute('role', 'tooltip'); guide.setAttribute('aria-hidden', 'true');
    (binding.nativeSash.closest('.naw') || document.body).append(hint, guide); columnTerminalOverlay = { hint, guide };
  }
  const { hint, guide } = columnTerminalOverlay, rect = binding.nativeSash.getBoundingClientRect();
  const area = binding.nativeSash.closest('.collaboration-readers')?.getBoundingClientRect() || binding.nativeSash.parentElement.getBoundingClientRect();
  hint.textContent = uiText('terminal.heightHint'); hint.hidden = guide.hidden = false;
  hint.style.left = `${Math.max(8, Math.min(window.innerWidth - hint.offsetWidth - 8, rect.left + (rect.width - hint.offsetWidth) / 2))}px`;
  hint.style.top = `${Math.max(8, rect.top - hint.offsetHeight - 8)}px`;
  guide.style.left = `${Math.max(0, area.left)}px`; guide.style.width = `${Math.max(0, Math.min(window.innerWidth, area.right) - Math.max(0, area.left))}px`;
  guide.style.top = `${rect.top + rect.height / 2}px`; columnTerminalOverlay.binding = binding;
}
function columnTerminalSash(binding) {
  if (binding.nativeSash) return binding.nativeSash;
  const sash = node('div', undefined, 'column-terminal-sash'); sash.tabIndex = 0;
  sash.setAttribute('role', 'separator'); sash.setAttribute('aria-orientation', 'horizontal');
  sash.setAttribute('aria-describedby', 'column-terminal-height-hint');
  const align = () => { binding.terminalDrag = null; const group = columnTerminalAlignment(binding); if (group) alignColumnTerminals(group, sash.getBoundingClientRect().top); showColumnTerminalHint(binding); };
  const finish = event => {
    const drag = binding.terminalDrag; if (drag?.pointerId !== event.pointerId) return;
    binding.terminalDrag = null;
    if (drag.value !== undefined && binding.nativeVisible) {
      if (drag.group) alignColumnTerminals(drag.group, drag.value, true);
      else applyColumnTerminalHeight(binding, drag.value, 'save');
    }
    if (sash.matches(':hover') || document.activeElement === sash) showColumnTerminalHint(binding); else hideColumnTerminalHint(binding);
  };
  sash.addEventListener('pointerenter', () => showColumnTerminalHint(binding));
  sash.addEventListener('focus', () => showColumnTerminalHint(binding));
  sash.addEventListener('pointerleave', () => { if (!binding.terminalDrag && document.activeElement !== sash) hideColumnTerminalHint(binding); });
  sash.addEventListener('blur', () => { if (!binding.terminalDrag) hideColumnTerminalHint(binding); });
  sash.addEventListener('dblclick', event => { event.preventDefault(); align(); });
  sash.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const group = event.shiftKey ? columnTerminalAlignment(binding) : null;
    if (event.shiftKey && !group) return;
    event.preventDefault(); sash.setPointerCapture(event.pointerId);
    binding.terminalDrag = { pointerId: event.pointerId, y: event.clientY, height: binding.terminalHeight ?? columnTerminalHeight(binding.id),
      line: sash.getBoundingClientRect().top, group };
  });
  sash.addEventListener('pointermove', event => {
    const drag = binding.terminalDrag;
    if (drag?.pointerId === event.pointerId) {
      if (!(event.buttons & 1)) return finish(event);
      if (drag.group) { drag.value = drag.line + event.clientY - drag.y; alignColumnTerminals(drag.group, drag.value, false); }
      else drag.value = applyColumnTerminalHeight(binding, drag.height + drag.y - event.clientY, 'adjust');
    }
    showColumnTerminalHint(binding);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) sash.addEventListener(type, finish);
  sash.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); align(); return; }
    const now = binding.terminalHeight ?? columnTerminalHeight(binding.id);
    const next = { ArrowUp: now + COLUMN_TERMINAL.step, ArrowDown: now - COLUMN_TERMINAL.step, Home: columnTerminalTallest(binding), End: COLUMN_TERMINAL.min }[event.key];
    if (next === undefined) return;
    event.preventDefault(); applyColumnTerminalHeight(binding, next, 'save'); showColumnTerminalHint(binding);
  });
  return binding.nativeSash = sash;
}
// A smaller window lowers a tall terminal (down to 64px) so the input stays in the column.
function fitColumnTerminalWidth(binding) {
  const entry = terminals.get(binding.id);
  if (!entry?.ready || entry.restoring) return;
  const record = state.sessions.find(s => s.id === binding.id);
  if (record?.owner !== owner) { entry.columnFit = undefined; entry.nativeSize = undefined; return; }
  if (!currentTerminalDisplay(entry, record) ||
      !entry.element.isConnected || !entry.element.checkVisibility() || entry.element.clientHeight <= 0) return;
  const width = entry.element.clientWidth, size = JSON.stringify([entry.term.cols, entry.term.rows]);
  // The same entry can return from a wider solo pane or a foreign canonical grid.
  // DOM-only height changes and ordinary output do not change this fit key.
  const key = JSON.stringify([width, entry.term.cols, entry.term.rows]);
  if (width > 0 && key !== entry.columnFit) {
    if (entry.nativeSize !== size) entry.nativeSize = undefined;
    fitColumnTerminal(binding);
  }
}
function refreshColumnTerminalHeights() {
  for (const binding of sessionComposers.values()) if (columnTerminalBinding(binding.id) && !binding.terminalDrag) {
    applyColumnTerminalHeight(binding, columnTerminalHeight(binding.id));
    fitColumnTerminalWidth(binding);
  }
}
window.addEventListener('resize', () => { hideColumnTerminalHint(); fitRoomTabs(true); refreshColumnTerminalHeights(); });
function removeColumnInput(id) {
  const binding = sessionComposers.get(id); if (!binding) return;
  hideColumnTerminalHint(binding);
  binding.revision++; binding.visible = binding.nativeVisible = false; binding.resizeAllowed = false; binding.terminalDrag = null;
  binding.ui.suspend(); if (binding !== soloComposer) composerParking.append(binding.ui.form);
  const entry = terminals.get(id); if (entry) { cancelColumnComposition(entry); entry.term.blur(); } syncTerminalMount(id);
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
  const moved = entry.element.parentElement !== parent;
  if (moved) parent.append(entry.element);
  entry.element.hidden = parent === terminalParking;
  if (moved && binding && !entry.columnReading) revealTerminalCursor(entry);
}
const queuedInputs = new Map(), queuedRoomInputs = new Map();
const draftRecoveries = new Map();
const draftRecoveryQueues = new Map();
const viewClaims = new Map();
const activeSessionId = () => selected === 'room' ? roomSession : selected;
const current = () => state?.sessions.find(s => s.id === activeSessionId());
const members = (id = spaceId) => spaceRecord(id)?.archived ? [] : state?.sessions.filter(s => inSpace(s, id) && !s.archived) || [];
// The sessions whose messages this page needs: main leaves out the rest (shown-sessions.cjs). One being
// opened counts from the moment it is asked for (shownPending) until the view that shows it is drawn.
// shownKnown: the ids of the newest report main has answered.
const shownPending = new Map();
let shownReported = null, shownReply = null, shownKnown = new Set();
function shownSessionIds(pending = true) {
  const ids = new Set(pending ? shownPending.keys() : []), active = activeSessionId();
  if (active) ids.add(active);
  if (selected === 'room') for (const s of members()) ids.add(s.id);
  for (const id of queuedInputs.keys()) ids.add(id);
  // A sent sentence whose notice still follows its row, or a new session waiting for it.
  if (typeof searchSendShownId === 'function' && searchSendShownId()) ids.add(searchSendShownId());
  // Queue answers still waiting for their own receipt, after the queue is closed or another session is shown.
  if (typeof queueAnswerShownIds === 'function') for (const id of queueAnswerShownIds()) ids.add(id);
  return [...ids].filter(id => state?.sessions.some(s => s.id === id)).sort();
}
function reportShown() {
  if (!state) return null;
  const ids = shownSessionIds(), key = ids.join('\n');
  if (key === shownReported) return shownReply;
  shownReported = key;
  return shownReply = api.shownSessions(ids).then(value => {
    shownKnown = new Set(ids);
    const patched = applyShownMessages(value), onScreen = new Set(shownSessionIds(false));
    if (patched.some(id => onScreen.has(id))) render();
  }, () => { if (shownReported === key) shownReported = null; });
}
function applyShownMessages(value) {
  const patched = [];
  for (const [id, messages] of Object.entries(value?.messages || {})) {
    const index = state?.sessions.findIndex(s => s.id === id) ?? -1, record = state?.sessions[index];
    if (!record?.messagesOmitted || !Array.isArray(messages)) continue;
    const { messagesOmitted: _omitted, messageSummary: _summary, ...rest } = record;
    state.sessions[index] = { ...rest, messages }; patched.push(id);
  }
  return patched;
}
// Before a view shows these sessions. Null when the page has their messages already, so that a switch
// between shown sessions stays as immediate as before.
function ensureMessages(ids) {
  const wanted = [...new Set(ids)].filter(id => state?.sessions.find(s => s.id === id)?.messagesOmitted);
  if (!wanted.length) return null;
  for (const id of wanted) shownPending.set(id, (shownPending.get(id) || 0) + 1);
  return Promise.resolve(reportShown()).finally(() => { for (const id of wanted) { const n = shownPending.get(id) - 1; if (n > 0) shownPending.set(id, n); else shownPending.delete(id); } });
}
function orderedMembers(id = spaceId) {
  const people = members(id), ranks = new Map((spaceRecord(id)?.memberOrder || []).map((id, index) => [id, index]));
  const fallback = ranks.size;
  return people.map((record, index) => ({ record, rank: ranks.get(record.id) ?? fallback + index }))
    .sort((a, b) => a.rank - b.rank).map(item => item.record);
}
function focusRoomMember(id, previous, originKey) {
  if (selected !== 'room' || id && !members().some(s => s.id === id)) return;
  rememberRoomMemberView(); captureReadingViews();
  if (id && !previous && readingPositions[originKey]) roomReturnReading = { spaceId, key: originKey, position: structuredClone(readingPositions[originKey]) };
  if (!id && roomReturnReading?.spaceId === spaceId) {
    readingPositions[roomReturnReading.key] = structuredClone(roomReturnReading.position);
    roomReturnReading = null;
  }
  const leaving = terminals.get(activeSessionId());
  if (leaving?.composing) leaving.term.blur();
  selectionRevision++;
  const key = spaceId === 'shared' ? `collaboration-focus:${id}` : `focus:${spaceId}:${id}`;
  if (id && id !== previous && !readingPositions[key] && readingPositions[originKey]) readingPositions[key] = structuredClone(readingPositions[originKey]);
  roomSurface = 'overview'; roomSession = id; roomRecordScope = ''; roomRecordReturn = null; restoreRoomMemberView(id);
  activateSoloComposer(id);
  lastMessages = ''; render(); attempt(persistView);
}
function rememberRoomMemberView() {
  if (!focusedRoomMember()) return;
  const view = roomViews[spaceId] ||= {}, saved = view.roomMemberViews ||= {};
  if (Object.hasOwn(saved, roomSession) || Object.keys(saved).length < 200) saved[roomSession] = { mode, terminalLayout, nativeId: current()?.nativeId || '' };
}
function restoreRoomMemberView(id) {
  const cached = roomViews[spaceId]?.roomMemberViews?.[id], record = state.sessions.find(s => s.id === id);
  const view = cached?.nativeId === (record?.nativeId || '') ? cached : null;
  mode = view?.mode === 'terminal' ? 'terminal' : 'chat';
  if (view && ['hidden', 'split', 'maximized'].includes(view.terminalLayout)) terminalLayout = view.terminalLayout;
}
function openRoomMember(id) {
  if (!members().some(s => s.id === id)) return;
  // The overview owns the existing selection/input suspension path. Viewing a
  // saved terminal mode is passive; only its explicit native control claims it.
  roomOverview?.focus(id);
  if (roomSession !== id || roomSurface !== 'overview') focusRoomMember(id, roomSession, roomOverview?.key(id));
  [...$('room-member-tabs').children].find(tab => tab.dataset.roomSession === id)?.focus({ preventScroll: true });
}
// T-121 A: the open member's own tab also returns to all members, through the overview's Back path, as its card name
// did before the tabs. The second click of a double-click and a Control-click (a context-menu gesture on macOS) never
// leave the member; Enter and Space do. Like Back, focus returns to that member's card in the overview.
function memberTabClick(id, event) {
  // A double-click acts once: its second click neither leaves nor reopens the member.
  if (event?.detail > 1) return;
  if (!(roomSurface === 'overview' && roomSession === id)) return openRoomMember(id);
  if (event?.ctrlKey) return;
  roomOverview?.focus('');
  if (focusedRoomMember()) focusRoomMember('', id, roomOverview?.key(id));
}
function roomMemberStateText(member) {
  const facts = window.nativeWorkspaceCollaboration.statusFacts(member, !disconnected, Date.now(), ui.language.getSnapshot().active);
  return [facts.state, facts.compactChild, facts.freshnessReported ? facts.freshness : ''].filter(Boolean).join(' · ');
}
function refreshRoomMemberTabs(people = orderedMembers()) {
  const tabs = $('room-member-tabs');
  let attention = people.filter(member => member.nativeApproval?.requests?.length || member.approvals?.length || member.approval || member.approvalOverflow).length;
  for (const tab of tabs.children) {
    const member = people.find(m => m.id === tab.dataset.roomSession);
    if (!member) continue;
    const count = member.nativeApproval?.requests?.length || member.approvals?.length || (member.approval || member.approvalOverflow ? 1 : 0);
    ui.display.computed(tab.querySelector('.room-member-name'), 'text', () => spaceMemberLabel(member, people));
    if (tab.querySelector('.room-member-id')) ui.display.computed(tab.querySelector('.room-member-id'), 'text', () => sessionShortId(member.id));
    ui.display.computed(tab.querySelector('.room-member-state'), 'text', () => roomMemberStateText(member));
    const mark = tab.querySelector('.vendor-mark'); if (mark) paintVendorMark(mark, member);
    ui.display.attribute(tab, 'title', tab.getAttribute('aria-pressed') === 'true' ? 'room.tabRestoreHint' : 'room.tabHint', () => ({ label: `${member.name} · ${makerLabel(member)} · ${sessionShortId(member.id)}` }));
    ui.display.computed(tab, 'aria-label', () => `${member.name} · ${makerLabel(member)} · ${sessionShortId(member.id)} · ${tab.querySelector('.room-member-state').textContent}`);
    tab.classList.toggle('needs-attention', Boolean(count));
  }
  ui.display.text($('room-member-status'), attention ? 'room.memberStatesAttention' : 'room.memberStatesCount', { count: people.length, attention });
  if ($('room-member-status-dialog').open) refreshRoomMemberStatus(people);
  fitRoomTabs();
}
let roomMemberStatusContext = null;
function roomMemberStatusKey() {
  return focusedRoomMember() ? JSON.stringify([spaceId, selectionRevision, roomSession, current()?.nativeId]) : null;
}
function refreshRoomMemberStatus(people = orderedMembers()) {
  const dialog = $('room-member-status-dialog'), context = roomMemberStatusContext;
  if (!dialog.open || !context) return;
  if (context.key !== roomMemberStatusKey()) { dialog.close(); return; }
  const list = $('room-member-status-list'), retained = new Map(context.rows);
  for (const [index, member] of people.entries()) {
    const identity = JSON.stringify([member.nativeId, pairRevision(member)]);
    let row = context.rows.get(member.id); retained.delete(member.id);
    if (row && row.dataset.identity !== identity) {
      if (row.contains(document.activeElement)) $('close-room-member-status').focus({ preventScroll: true });
      row.remove(); context.rows.delete(member.id); row = null;
    }
    if (!row) {
      row = node('button'); row.type = 'button'; row.dataset.roomStatusMember = member.id; row.dataset.identity = identity;
      row.append(node('span', undefined, 'room-member-name'), node('span', undefined, 'room-member-state'));
      row.addEventListener('click', event => {
        const latest = members().find(s => s.id === member.id);
        if (roomMemberStatusContext !== context || context.key !== roomMemberStatusKey() || !latest || JSON.stringify([latest.nativeId, pairRevision(latest)]) !== identity) return;
        dialog.close(); attempt(() => memberTabClick(member.id, event));
      });
      context.rows.set(member.id, row);
    }
    ui.display.computed(row.querySelector('.room-member-name'), 'text', () => `${member.name} · ${providerName(member.provider)} · ${sessionShortId(member.id)}`);
    ui.display.computed(row.querySelector('.room-member-state'), 'text', () => roomMemberStateText(member));
    row.setAttribute('aria-pressed', String(roomSession === member.id));
    row.classList.toggle('needs-attention', Boolean(member.nativeApproval?.requests?.length || member.approvals?.length || member.approval || member.approvalOverflow));
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  }
  for (const [id, row] of retained) {
    if (row.contains(document.activeElement)) $('close-room-member-status').focus({ preventScroll: true });
    row.remove(); context.rows.delete(id);
  }
}
function openRoomMemberStatus() {
  const key = roomMemberStatusKey(); if (!key) return;
  roomMemberStatusContext = { key, rows: new Map() };
  $('room-member-status-list').replaceChildren();
  openTransientDialog('room-member-status-dialog');
  $('room-member-status').setAttribute('aria-expanded', 'true');
  refreshRoomMemberStatus();
}
function renderRoomMemberTabs(people = orderedMembers()) {
  const tabs = $('room-member-tabs'), retained = new Map([...tabs.children].map(tab => [tab.dataset.roomSession, tab]));
  const focused = roomSurface === 'overview' ? people.filter(member => !member.archived && member.id === roomSession) : [];
  for (const [index, member] of focused.entries()) {
    let tab = retained.get(member.id); retained.delete(member.id);
    if (!tab) {
      tab = node('button'); tab.type = 'button'; tab.addEventListener('click', event => attempt(() => memberTabClick(member.id, event))); tab.dataset.roomSession = member.id;
      const heading = node('span', undefined, 'room-member-heading');
      const mark = icon(member, true); mark.setAttribute('aria-hidden', 'true');
      heading.append(mark, node('span', undefined, 'room-member-name'), node('span', undefined, 'room-member-id'));
      tab.append(heading, node('span', undefined, 'room-member-state'));
      draggableSession(tab, member.id);
    }
    tab.setAttribute('aria-pressed', String(roomSurface === 'overview' && roomSession === member.id));
    if (tabs.children[index] !== tab) tabs.insertBefore(tab, tabs.children[index] || null);
  }
  for (const tab of retained.values()) tab.remove();
  refreshRoomMemberTabs(people);
  const routes = [$('room-overview'), $('room-record')];
  const active = routes.includes(document.activeElement) ? document.activeElement : roomSurface === 'records' ? $('room-record') : $('room-overview');
  routes.forEach(route => { route.tabIndex = route === active ? 0 : -1; });
}
function roomNavigationKey(event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
  const routes = [$('room-overview'), $('room-record')], index = routes.indexOf(event.target);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? routes.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + routes.length) % routes.length;
  routes.forEach((route, i) => { route.tabIndex = i === next ? 0 : -1; });
  routes[next].focus({ preventScroll: true }); routes[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    label: s => participantLabel(s, state.sessions), spaceName, defaultSpace: window.nativeWorkspaceSpaces.untouchedDefault,
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
    host: $('collaboration-overview'), roomId: state.room.id, memberIndex: false, alignedTabs: true,
    display: ui.display, language: ui.language, showError: ui.showError,
    onMove: moveRoomMember,
    onOrderError: error => error.message ? toastError(error) : toastMessage('collab.orderUnchanged'),
    // A member whose messages have not arrived yet keeps its column as it was; its excerpt comes from the summary.
    label: s => spaceMemberLabel(s), fullLabel: s => participantLabel(s, state.sessions), messages: s => s.messagesOmitted ? undefined : sessionMessages(s),
    renderMessages: (el, s, rows, key) => { if (rows) messageList(el, rows, false, key, { session: s, passive: true }); },
    disposeMessages: el => { messageViews.get(el)?.dispose(); messageViews.delete(el); },
    renderInput: renderColumnInput, disposeInput: removeColumnInput,
    beforeInputLayout: suspendColumnInputs,
    beforeLayout: () => { captureReadingViews(); restoreOverviewReading(); }, onLayout: () => { refreshColumnTerminalHeights(); restoreOverviewReading(); }, onFocus: focusRoomMember,
    decorateHeader: (handle, record) => draggableSession(handle, record.id),
    renderIdentity: (handle, record) => {
      let mark = handle.querySelector('.vendor-mark');
      if (!mark) { mark = icon(record, true); handle.prepend(mark); }
      paintVendorMark(mark, record); mark.title = makerLabel(record);
    },
    onMemberMenu: openMemberMenu,
    onOpenSession: id => attempt(() => api.newWindow(id)),
    onSource: (el, key, source) => {
      if (!pointToMessage(el, key, source.messageId)) toastMessage("toast.originalRemoved");
      attempt(persistView);
    },
  });
  const focused = focusedRoomMember(), records = roomSurface === 'records';
  $('collaboration-overview').hidden = focused || records;
  for (const person of members()) readLegacyProgress(person);
  roomOverview.update(orderedMembers(), !disconnected, !records, focused ? roomSession : '');
  renderHeaderLayout(current(), selected === 'room');
  const overview = $('room-overview');
  overview.removeAttribute('aria-pressed');
  if (!records && !focused) overview.setAttribute('aria-current', 'page'); else overview.removeAttribute('aria-current');
  ui.display.text(overview, focused ? 'room.returnSpace' : 'room.overview', { name: spaceName(state.room) });
  $('room-record').setAttribute('aria-pressed', String(records));
  $('room-member-tabs').hidden = !focused;
  if (roomOverview) roomOverview.toolbar.hidden = focused || records;
  // The header's row now holds what this page shows of it.
  fitRoomTabs();
  $('member-related-records').hidden = !focused;
  $('room-record-view').querySelector('.timeline-tools').hidden = !records;
  $('room-messages').hidden = !records;
  if (!records) $('thread-heading').hidden = true;
  $('room-composer').hidden = focused;
  $('room-layout').classList.toggle('collaboration-focus', focused);
  // Header, footer and shared-composer layout must settle before measuring the columns.
  refreshColumnTerminalHeights();
  if (removedFocus) focusRemainingMember(origin, oldIndex);
}
const nativeUsable = s => s && !s.archived && !s.backendUnavailable && (['starting', 'idle', 'working', 'approval'].includes(s.state) || ((s.state === 'error' || s.nativeContextPending) && s.terminalAvailable));
const canResume = s => s?.nativeId && !s.nativeContextPending && !s.backendUnavailable &&
  ((s.provider === 'codex' && s.transportDisconnected && ['error', 'disconnected'].includes(s.state) && (s.serviceCapabilities || state.capabilities || []).includes('transportReconnect')) ||
  (!s.terminalAvailable && (['ended', 'recoverable', 'error'].includes(s.state) || (s.provider === 'codex' && s.state === 'disconnected' && (s.serviceCapabilities || state.capabilities || []).includes('resubscribe'))))) &&
  ['resume', 'nativePermissionDefaults'].every(c => (s.serviceCapabilities || state.capabilities || []).includes(c));
const inputFocusAllowed = () => !sessionMenu && !roomMenu && !contentMenu && !renameTarget && !document.querySelector('dialog:modal, dialog[open]:not(#setup-dialog)');
function updateState(next) {
  const before = new Map((state?.sessions || []).map(s => [s.id, s]));
  state = projectSpace({ ...state, ...next });
  // A state main made before it learned that this page shows a session can arrive after the reply that
  // brought that session's messages (reportShown): the messages the page holds stay until newer ones come.
  if (shownKnown.size) state.sessions = state.sessions.map(s => {
    const held = s.messagesOmitted && shownKnown.has(s.id) ? before.get(s.id) : null;
    if (!held || held.messagesOmitted) return s;
    const { messagesOmitted: _omitted, messageSummary: _summary, ...rest } = s;
    return { ...rest, messages: held.messages };
  });
  for (const s of state.sessions || []) if (legacyProgressOffline(s)) freezeLegacyProgress(s);
  if (latestViewStorage !== undefined) { state.viewStorageWarning = latestViewStorage; state.viewStorageWarningUiMessage = latestViewStorageUiMessage; }
  for (const [id, binding] of sessionComposers) {
    const previous = before.get(id), after = state.sessions.find(s => s.id === id);
    // Ownership can change while the column is parked, without recreating its terminal.
    if (previous?.owner !== after?.owner) {
      const entry = terminals.get(id); if (entry) entry.columnFit = undefined;
    }
    if (previous && after && (previous.owner !== owner || after.owner !== owner)) {
      if (binding.typedWhileFree && !heldElsewhere(after)) {
        if (after.owner === owner && composerCurrent(binding)) { binding.typedWhileFree = false; saveSessionDraft(binding); }
        continue;
      }
      // Text typed while the session was free is kept as a recovery copy when another window got it first.
      if (binding.typedWhileFree && binding.ui.input.value !== (after.liveDraft || '')) rememberDraftRecovery(id, binding.ui.input.value);
      binding.typedWhileFree = false;
      const pending = pendingDrafts.get(id);
      if (pending && pending.text !== after.liveDraft) rememberDraftRecovery(id, pending.text);
      // An owning editor keeps its node/value across ordinary snapshots.
      // Ownership changes read the current draft, after IME has committed.
      if (!binding.ui.setValue(after.liveDraft || '')) binding.syncAfterComposition = true;
    }
  }
  for (const [queuedId, mark] of queuedInputs) followQueuedInput(queuedId, mark);
  for (const [queuedId, mark] of queuedRoomInputs) followQueuedRoomInput(queuedId, mark);
  if (typeof followSearchSend === 'function') { followSearchSend(); followQueueAnswers(); }
}
// Like a native TUI queue, a queued Claude message leaves the composer once
// the service records it. Only a proven non-send comes back, and only into an
// untouched composer; an uncertain one stays in the record so it is not resent.
function followQueuedInput(id, mark) {
  const s = state.sessions?.find(x => x.id === id);
  const row = queuedRowFor(s, mark);
  if (!row) { if (!s) queuedInputs.delete(id); return; }
  mark.tag = row.id;
  const input = sessionComposers.get(id)?.ui.input, untouched = input && draftRevisions.get(id) === mark.revision;
  if (!mark.cleared && row.status === 'awaiting-native' && !s.liveDraft && untouched && input.value === mark.text) { sessionComposers.get(id).ui.setValue(''); mark.cleared = true; }
  if (row.status === 'awaiting-native') return;
  if (row.status === 'not-sent' && mark.cleared && untouched && !input.value && s.liveDraft) sessionComposers.get(id).ui.setValue(s.liveDraft);
  queuedInputs.delete(id);
}
// The row a queue mark's own call recorded: new since the call began and holding its words (the service stores
// them trimmed). Another entry's queued words are not this row; an overlapped mark waits for its call's outcome.
const queuedRowFor = (s, mark) => s?.messages.find(m => mark.tag ? m.id === mark.tag : !mark.overlap && m.inputMode === 'queue' && !mark.before.has(m.id) && m.text === mark.text.trim());
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
// The sidebar shows several times for every session on every draw. toLocaleTimeString with options builds a new
// formatter on each call, which was the page's largest single cost while agents worked; one formatter per language
// and time zone offset (sessionTimeFormats, below) gives the same text.
function sessionTime(value) {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value), now = new Date();
  if (!Number.isFinite(date.getTime())) return '';
  // A formatter keeps the time zone it was made in; the offset in the key gives a new one after the zone changes.
  const language = ui.language.getSnapshot().active, key = language + ' ' + now.getTimezoneOffset();
  let format = sessionTimeFormats.get(key);
  if (!format) { format = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }); sessionTimeFormats.set(key, format); }
  const time = format.format(date);
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()}${date.getFullYear() === now.getFullYear() ? '' : `/${date.getFullYear()}`} ${time}`;
}
const sessionTimeFormats = new Map();
function sessionMessagesLatest(s) {
  const summary = s.messagesOmitted ? s.messageSummary || {} : null;
  let latest = summary && Number.isFinite(summary.latestAt) ? summary.latestAt : null;
  if (!summary) for (const m of Array.isArray(s.messages) ? s.messages : []) {
    if (!m?.volatile && m?.kind !== 'gap' && Number.isFinite(m?.time) && Number.isFinite(new Date(m.time).getTime())) latest = latest === null ? m.time : Math.max(latest, m.time);
  }
  return latest;
}
function sessionActivityTime(s) {
  const reported = sessionTime(s.lastActivityAt);
  if (reported) return reported;
  const latest = sessionMessagesLatest(s);
  return latest === null ? uiText('time.unknown') : uiText('time.estimated', { time: sessionTime(latest) });
}
// The same activity as a number, for ordering; none recorded orders last.
function sessionActivityAt(s) {
  if (sessionTime(s.lastActivityAt)) return new Date(s.lastActivityAt).getTime();
  return sessionMessagesLatest(s) ?? -Infinity;
}
const sessionTimes = s => uiText('time.session', { created: sessionTime(s.createdAt) || uiText('time.unrecorded'), activity: sessionActivityTime(s) });
// Sidebar folder facts use only recorded paths and worktree preparation; no filesystem probes.
const hierBase = folder => String(folder).replace(/\/+$/, '').split('/').pop() || String(folder);
const hierText = () => ({
  folderView: uiText('sidebar.hierarchy.folderView'), made: uiText('sidebar.hierarchy.made'), madeOne: uiText('sidebar.hierarchy.madeOne'), main: uiText('sidebar.hierarchy.main'), unknown: uiText('sidebar.hierarchy.unknown'),
  steward: uiText('butler.name'), integrator: uiText('sidebar.hierarchy.integrator'), secretary: uiText('sidebar.hierarchy.secretary'), independent: uiText('sidebar.independent'),
  worktree: id => uiText('sidebar.hierarchy.worktree', { id }), parts: count => uiText('sidebar.hierarchy.parts', { count }), part: (index, count) => uiText('sidebar.hierarchy.part', { index, count }),
  partsTitle: count => uiText('sidebar.hierarchy.partsTitle', { count }), added: count => uiText('sidebar.hierarchy.added', { count }), addedTitle: list => uiText('sidebar.hierarchy.addedTitle', { list }),
  doingTitle: text => uiText('sidebar.hierarchy.doingTitle', { text }), folder: (path, branch) => uiText('sidebar.hierarchy.folderPath', { path }) + (branch ? '\n' + uiText('sidebar.hierarchy.folderBranch', { branch }) : ''),
  expand: name => uiText('sidebar.expand', { name }), collapse: name => uiText('sidebar.collapse', { name }), sessions: count => uiText('sidebar.hierarchy.sessions', { count }),
});
const hierFirstLine = text => { const line = String(text || '').split('\n').map(part => part.trim()).find(Boolean) || ''; return line.length > 80 ? line.slice(0, 79) + '…' : line; };
const hierFolderActive = () => sidebarView === 'folder';
// Disambiguate equal folder names using the shortest recorded parent suffix, never a filesystem probe.
function hierFolderName(folder) {
  const parts = folder.replace(/\/+$/, '').split('/').filter(Boolean);
  const peers = state.sessions.filter(s => !s.archived).map(s => s.worktreePreparation?.repository || s.cwd).filter(p => typeof p === 'string' && p.replace(/\/+$/, '') !== folder.replace(/\/+$/, '')).map(p => p.replace(/\/+$/, '').split('/').filter(Boolean));
  for (let n = 1; n <= parts.length; n++) {
    const label = parts.slice(-n).join('/');
    if (!peers.some(p => p.slice(-n).join('/') === label)) return label;
  }
  return folder;
}
// Where a session works, from its record. A NAW worktree's branch is NAW's own (naw/session-…), so the worktree is
// named by its short id; the full path and branch are in the tooltip.
function hierFolder(record) {
  const text = hierText(), cwd = typeof record.cwd === 'string' && record.cwd ? record.cwd.replace(/\/+$/, '') || '/' : '', plan = record.worktreePreparation;
  if (plan && typeof plan.repository === 'string' && plan.repository) {
    const short = String(plan.nonce || '').replace(/-/g, '').slice(0, 6);
    return { kind: 'worktree', group: plan.repository, name: hierFolderName(plan.repository), leaf: short ? text.worktree(short) : hierBase(cwd || plan.target || '') || text.worktree('').trim(), path: cwd || plan.target || '', branch: typeof plan.branch === 'string' ? plan.branch : '' };
  }
  const root = typeof state.newWorkspaceRoot === 'string' ? state.newWorkspaceRoot.replace(/\/+$/, '') : '';
  if (cwd && root && cwd.startsWith(root + '/') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cwd.slice(root.length + 1))) return { kind: 'made', group: ':made', name: text.made, leaf: '', path: cwd, branch: '' };
  if (cwd && state.sessions.some(s => s.worktreePreparation?.repository?.replace(/\/+$/, '') === cwd)) return { kind: 'main', group: cwd, name: hierFolderName(cwd), leaf: text.main, path: cwd, branch: '' };
  if (cwd) return { kind: 'folder', group: cwd, name: hierFolderName(cwd), leaf: '', path: cwd, branch: '' };
  return { kind: 'unknown', group: ':unknown', name: text.unknown, leaf: '', path: '', branch: '' };
}
// The queue item NAW sent this session and has not settled, and the open items this session added.
function hierQueueFacts(record) {
  let doing = null; const added = [];
  for (const room of allSpaces()) for (const item of room.queue || []) {
    if (!item || !['queued', 'sent', 'waiting'].includes(item.status)) continue;
    if (!doing && item.status !== 'queued' && item.sentTo === record.id) doing = item;
    if (item.creator?.kind === 'secretary' && item.creator.sessionId === record.id) added.push(item);
  }
  return { doing, added };
}
function hierRole(record) {
  const text = hierText();
  return state.steward?.sessionId === record.id ? text.steward : state.integrator?.sessionId === record.id ? text.integrator : state.queueSecretary?.sessionId === record.id ? text.secretary : '';
}
function hierPlace(folder) {
  return folder.kind === 'worktree' || folder.kind === 'main' ? `${folder.name} › ${folder.leaf}` : folder.kind === 'folder' ? folder.name : '';
}
function hierViewButton() {
  const folders = $('sessions-folders'), active = hierFolderActive();
  folders.setAttribute('aria-pressed', String(active));
  if (active) $('sessions-flat').setAttribute('aria-pressed', 'false');
}
function toggleSidebarFolder(key) {
  if (sidebarCollapsedFolders.has(key)) sidebarCollapsedFolders.delete(key);
  else {
    if (sidebarCollapsedFolders.size >= 200) { toastMessage('sidebar.hierarchy.folderFoldLimit'); return; }
    sidebarCollapsedFolders.add(key);
  }
  renderSessions(); attempt(persistView);
}
// Folder view: one foldable section per repository or folder, rows under it; called from renderSessions.
const hierSections = new Map();
function hierFolderContainers(visible, list) {
  if (!visible || !hierFolderActive()) { for (const section of hierSections.values()) section.element.remove(); hierSections.clear(); return null; }
  const text = hierText(), groups = new Map();
  for (const record of visible) {
    const folder = hierFolder(record);
    if (!groups.has(folder.group)) groups.set(folder.group, { folder, records: [] });
    const group = groups.get(folder.group); group.records.push(record);
    if (folder.kind === 'worktree' || folder.kind === 'main') group.folder = { ...folder, kind: 'repository', path: folder.kind === 'main' ? folder.path : folder.group };
  }
  const rank = { repository: 0, folder: 1, made: 2, unknown: 3 };
  const ordered = [...groups.entries()].sort(([, a], [, b]) => rank[a.folder.kind] - rank[b.folder.kind] || a.folder.name.localeCompare(b.folder.name));
  const containers = new Map(), keep = new Set();
  ordered.forEach(([key, group], index) => {
    let section = hierSections.get(key);
    if (!section) {
      const element = node('section', undefined, 'hier-folder-group'), heading = node('h3', undefined, 'hier-folder-heading'), body = node('div', undefined, 'hier-folder-body');
      const toggle = button('', () => toggleSidebarFolder(key), 'hier-folder-toggle');
      toggle.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
      const icon = node('span', undefined, 'hier-folder-icon'), name = node('span', undefined, 'hier-folder-name'), count = node('span', undefined, 'hier-folder-count'), attention = node('span', undefined, 'hier-folder-attention');
      icon.setAttribute('aria-hidden', 'true'); name.addEventListener('click', () => toggle.click()); icon.addEventListener('click', () => toggle.click());
      body.id = `hier-folder-${crypto.randomUUID()}`; attention.id = `${body.id}-attention`; toggle.setAttribute('aria-controls', body.id);
      heading.append(toggle, icon, name, attention, count); element.append(heading, body); element.dataset.hierFolder = key;
      section = { element, heading, toggle, icon, name, count, attention, body }; hierSections.set(key, section);
    }
    const folder = group.folder, closed = sidebarCollapsedFolders.has(key);
    section.element.dataset.kind = folder.kind;
    ui.display.computed(section.name, 'text', () => hierFolder(group.records[0]).name); section.count.textContent = String(group.records.length);
    ui.display.computed(section.heading, 'title', () => folder.kind === 'made' || folder.kind === 'unknown' ? `${hierFolder(group.records[0]).name} · ${hierText().sessions(group.records.length)}` : `${hierText().folder(folder.path)}\n${hierText().sessions(group.records.length)}`);
    section.toggle.setAttribute('aria-expanded', String(!closed));
    ui.display.computed(section.toggle, 'aria-label', () => closed ? hierText().expand(hierFolder(group.records[0]).name) : hierText().collapse(hierFolder(group.records[0]).name));
    // As with the space groups, hidden follows the fold and the narrow rail's CSS still lists a folded section's rows.
    const rowsHidden = closed && list.closest('.naw')?.dataset.collapsed !== 'true';
    const menuRow = sessionMenu?.kind === 'session' && sessionRows.get(sessionMenu.rowKey);
    const closeMenu = rowsHidden && sessionMenu?.kind === 'session' && section.body.contains(menuRow?.element || sessionMenu.anchor);
    const hiddenFocus = rowsHidden && (section.body.contains(document.activeElement) || closeMenu);
    section.body.hidden = closed;
    if (closeMenu) sessionMenu.close();
    if (hiddenFocus) section.toggle.focus({ preventScroll: true });
    // A folded section says how many of its sessions need attention, as a folded space group does.
    const attention = typeof sidebarPresentation === 'function' ? group.records.filter(record => sidebarPresentation(record).marker === '!') : [];
    section.attention.hidden = !closed || !attention.length; section.attention.textContent = attention.length ? `!${attention.length}` : '';
    if (section.attention.hidden) { section.attention.removeAttribute('title'); section.attention.removeAttribute('aria-label'); section.toggle.removeAttribute('aria-describedby'); }
    else { const facts = () => uiText('sidebar.attentionFacts', { count: attention.length, facts: attention.map(record => `${record.name} · ${sidebarPresentation(record).full}`).join('; ') }); ui.display.computed(section.attention, 'title', facts); ui.display.computed(section.attention, 'aria-label', facts); section.toggle.setAttribute('aria-describedby', section.attention.id); }
    const slot = list.children[index]; if (slot !== section.element) list.insertBefore(section.element, slot || null);
    keep.add(key);
    for (const record of group.records) containers.set(record.id, section.body);
  });
  for (const [key, section] of hierSections) if (!keep.has(key)) { section.element.remove(); hierSections.delete(key); }
  return containers;
}
function decorateSidebarHierarchy() {
  const text = hierText(), folderView = hierFolderActive();
  hierViewButton();
  $('session-list').dataset.hierView = folderView ? 'folder' : sidebarView === 'grouped' ? 'space' : 'flat';
  for (const row of sessionRows.values()) {
    const record = state.sessions.find(item => item.id === row.sessionId); if (!record) continue;
    if (!row.hier) {
      const parts = { tags: node('span', undefined, 'hier-tags'), role: node('span', undefined, 'hier-role'), parts: node('span', undefined, 'hier-parts'), added: node('span', undefined, 'hier-added'),
        task: node('span', undefined, 'hier-task'), line: node('span', undefined, 'hier-line'), folder: node('span', undefined, 'hier-folder') };
      parts.tags.append(parts.role, parts.parts, parts.added); row.name.after(parts.tags);
      row.status.after(parts.task);
      // The space badges move onto the folder line, so one line carries where the session is and works.
      parts.line.append(parts.folder, row.badges); row.time.after(parts.line);
      row.hier = parts;
    }
    const steward = row.element.classList.contains('steward-row'), folder = hierFolder(record), queue = hierQueueFacts(record), presentation = sidebarPresentation(record);
    const role = steward ? '' : hierRole(record);
    ui.display.computed(row.hier.role, 'text', () => steward ? '' : hierRole(record)); row.hier.role.hidden = !role;
    const chain = sessionChainModel(record.id), links = chain?.sessions || [], at = links.findIndex(link => link.id === record.id);
    const long = links.length > 1 && at >= 0;
    ui.display.computed(row.hier.parts, 'text', () => !long ? '' : at === links.length - 1 ? hierText().parts(links.length) : hierText().part(at + 1, links.length));
    ui.display.computed(row.hier.parts, 'title', () => long ? hierText().partsTitle(links.length) : ''); row.hier.parts.hidden = !long;
    ui.display.computed(row.hier.added, 'text', () => queue.added.length ? hierText().added(queue.added.length) : ''); row.hier.added.hidden = !queue.added.length;
    ui.display.computed(row.hier.added, 'title', () => queue.added.length ? hierText().addedTitle(queue.added.map(item => '· ' + hierFirstLine(item.text)).join('\n')) : '');
    const doing = queue.doing ? hierFirstLine(queue.doing.text) : '';
    row.hier.task.textContent = doing;
    // What needs the person, or failed, keeps its state words; otherwise the task says more than 「会话就绪」.
    row.element.dataset.hierShow = doing && presentation.marker !== '!' ? 'task' : 'status';
    const place = folderView ? folder.leaf : hierPlace(folder) || (folder.kind === 'made' ? text.madeOne : folder.name);
    ui.display.computed(row.hier.folder, 'text', () => { const f = hierFolder(record); return folderView ? f.leaf : hierPlace(f) || (f.kind === 'made' ? hierText().madeOne : f.name); }); row.hier.folder.hidden = !place;
    row.hier.folder.dataset.kind = folder.kind;
    row.hier.line.hidden = !place && (row.badges.hidden || !row.badges.childElementCount);
    const where = folder.path ? text.folder(folder.path, folder.branch) : folder.name;
    ui.display.computed(row.link, 'aria-description', () => [steward ? '' : hierRole(record), long && row.hier.parts.textContent, doing && hierText().doingTitle(doing), folder.path ? hierText().folder(folder.path, folder.branch) : hierFolder(record).name, queue.added.length && hierText().added(queue.added.length)].filter(Boolean).join(' · '));

  }
}
function hierHeaderCrumb(record) {
  let crumb = document.getElementById('sidebar-folder-path');
  if (!record) { if (crumb) crumb.hidden = true; return; }
  if (!crumb) { crumb = node('span', undefined, 'hier-crumb'); crumb.id = 'sidebar-folder-path'; }
  // Keep the path at the left of the existing conversation toolbar, before the view switch.
  const bar = $('conversation-pane-toolbar');
  if (bar.firstChild !== crumb) bar.insertBefore(crumb, bar.firstChild);
  ui.display.computed(crumb, 'text', () => {
    const text = hierText(), rooms = allSpaces().filter(room => !room.archived && inSpace(record, room.id)), folder = hierFolder(record);
    const space = rooms.length ? spaceName(rooms[0]) + (rooms.length > 1 ? ` +${rooms.length - 1}` : '') : text.independent;
    const place = hierPlace(folder) || (folder.kind === 'made' ? text.madeOne : folder.name);
    return [space, place].filter(Boolean).join(' › ');
  });
  ui.display.computed(crumb, 'title', () => { const folder = hierFolder(record); return folder.path ? hierText().folder(folder.path, folder.branch) : folder.name; });
  crumb.hidden = false;
}
function renderSidebarSpaceCard(entry, group) {
  ui.display.unbind(entry.title);
  if (!entry.card || !entry.title.contains(entry.card.tile)) {
    const tile = node('span', undefined, 'sidebar-space-tile'), lines = node('span', undefined, 'sidebar-space-lines'), name = node('span', undefined, 'sidebar-space-name'), meta = node('span', undefined, 'sidebar-space-meta');
    tile.setAttribute('aria-hidden', 'true'); lines.append(name, meta); entry.title.replaceChildren(tile, lines); entry.card = { tile, name, meta };
  }
  const name = () => group.room ? spaceName(group.room) : uiText('sidebar.independent');
  entry.title.classList.toggle('sidebar-independent', !group.room);
  entry.card.tile.hidden = !group.room;
  ui.display.computed(entry.card.tile, 'text', () => Array.from(name().trim())[0]?.toUpperCase() || '·');
  ui.display.computed(entry.card.name, 'text', name);
  ui.display.computed(entry.card.meta, 'text', () => {
    const working = group.people.filter(s => sidebarPresentation(s).tone === 'working').length;
    const waiting = group.people.filter(s => sidebarPresentation(s).marker === '!').length;
    return group.room ? working || waiting ? [uiText('sidebar.hierarchy.cardCount', { count: group.people.length }), working && uiText('sidebar.hierarchy.cardWorking', { count: working }), waiting && uiText('sidebar.hierarchy.cardWaiting', { count: waiting })].filter(Boolean).join(' · ') : uiText('sidebar.hierarchy.cardMembers', { count: group.people.length }) : String(group.people.length);
  });
}

// Hover details (11-15 round 2): what a row's tooltips carried, in one card, from the state the sidebar already has.
// No ids, version notice, chain parts or conversation text; the row keeps its full accessible name and description.
let sidebarHoverCard = null;
function hoverDetail(list, key, ...values) {
  const value = node('dd'); value.append(...values.filter(part => part !== null && part !== undefined && part !== ''));
  list.append(node('dt', uiText(key)), value);
}
function hoverAvatar(record, text) {
  const presentation = sidebarPresentation(record), avatar = paintVendorMark(node('span'), record, text), dot = node('span');
  dot.className = `state-dot ${presentation.tone}${presentation.workTone ? ' ' + presentation.workTone : ''}`; avatar.append(dot);
  return avatar;
}
function hoverSessionCard(record, steward) {
  const presentation = sidebarPresentation(record), head = node('div', undefined, 'hover-card-head'), lines = node('div', undefined, 'hover-card-lines');
  const title = node('div', undefined, 'hover-card-title'), role = hierRole(record), status = node('div', presentation.full, 'hover-card-status');
  title.append(node('span', record.name, 'hover-card-name')); if (role) title.append(node('span', role, 'hover-card-role'));
  status.dataset.tone = presentation.tone; lines.append(title, status); head.append(hoverAvatar(record, steward ? '◆' : undefined), lines);
  const facts = node('dl'), maker = sessionMaker(record), made = [maker.vendor ? maker.vendorName : '', maker.shellName].filter(Boolean).join(' · ');
  const model = record.model ? node('span', ui.displayText(record.model, record.modelUiMessage), 'hover-card-nowrap') : null;
  hoverDetail(facts, 'hover.backend', made + (made && model ? ' · ' : ''), model);
  const spaces = allSpaces().filter(room => !room.archived && inSpace(record, room.id)).map(room => spaceName(room));
  hoverDetail(facts, 'hover.spaces', spaces.length ? spaces.join(uiText('hover.separator')) : uiText('sidebar.independent'));
  const { doing } = hierQueueFacts(record);
  if (doing) hoverDetail(facts, 'hover.doing', hierFirstLine(doing.text), doing.status === 'waiting' ? node('span', ' · ' + uiText('hover.waiting'), 'hover-card-muted') : null);
  const folder = hierFolder(record);
  hoverDetail(facts, 'hover.folder', folder.path ? node('span', folder.path, 'hover-card-path') : node('span', uiText('hover.unrecorded'), 'hover-card-muted'),
    folder.branch ? node('span', uiText('hover.branch', { branch: folder.branch }), 'hover-card-sub') : null);
  hoverDetail(facts, 'hover.time', sessionTimes(record));
  return [head, facts];
}
function hoverSpaceCard(room) {
  const people = orderedMembers(room.id), head = node('div', undefined, 'hover-card-head hover-card-space'), lines = node('div', undefined, 'hover-card-lines'), title = node('div', undefined, 'hover-card-title');
  const tile = node('span', Array.from(spaceName(room).trim())[0]?.toUpperCase() || '·', `sidebar-space-tile ${roomTone(room.id)}`); tile.setAttribute('aria-hidden', 'true');
  title.append(node('span', spaceName(room), 'hover-card-name')); lines.append(title, node('div', uiText('hover.members', { count: people.length }), 'hover-card-status')); head.append(tile, lines);
  // Six rows at most: five members and 「还有 N 位」 when there are more.
  const list = node('ul', undefined, 'hover-card-members'), shown = people.length > 6 ? people.slice(0, 5) : people;
  for (const person of shown) {
    const presentation = sidebarPresentation(person), item = node('li'), state = node('span', presentation.compact, 'hover-card-member-state');
    state.dataset.tone = presentation.tone; item.append(hoverAvatar(person), node('span', person.name, 'hover-card-member-name'), state); list.append(item);
  }
  if (people.length > shown.length) list.append(node('li', uiText('hover.more', { count: people.length - shown.length }), 'hover-card-more'));
  const open = (room.queue || []).filter(item => item && ['queued', 'sent', 'waiting'].includes(item.status)), count = status => open.filter(item => item.status === status).length;
  const queue = node('dl');
  hoverDetail(queue, 'hover.queue', open.length ? uiText('hover.queueCounts', { queued: count('queued'), sent: count('sent'), waiting: count('waiting') }) : node('span', uiText('hover.queueEmpty'), 'hover-card-muted'));
  return [head, people.length ? list : null, queue];
}
// Which item an element belongs to: a session row (by its occurrence, so the same session in two spaces is two
// items) or a space heading. Keyboard focus counts only on the row's link and the heading's name button.
function sidebarHoverItem(element, how) {
  if (element.closest('#rename-editor')) return null;
  const row = element.closest(how === 'focus' ? '.session-link' : '[data-session-row]')?.closest('[data-session-row]');
  if (row?.dataset.occurrence) return { key: 'row:' + row.dataset.occurrence };
  const heading = how === 'focus' ? element.closest('.session-space-heading')?.closest('h3') : element.closest('.session-space-group > h3');
  const group = heading?.parentElement?.dataset.sessionGroup;
  return group && group !== 'independent' ? { key: 'space:' + group } : null;
}
function sidebarHoverBuild(key) {
  if (key.startsWith('row:')) {
    const row = sessionRows.get(key.slice(4)), record = row && state.sessions.find(item => item.id === row.sessionId);
    return record && row.element.isConnected && !row.element.closest('[hidden]') ? { anchor: row.element, kind: 'session', content: hoverSessionCard(record, row.element.classList.contains('steward-row')) } : null;
  }
  const id = key.slice(6), room = allSpaces().find(item => item.id === id && !item.archived), heading = sidebarGroups.get(id)?.title.closest('h3');
  return room && heading?.isConnected ? { anchor: heading, kind: 'space', content: hoverSpaceCard(room) } : null;
}

// Only recorded NAW handoffs connect sessions. Names and native resume actions do not.
function sessionChainModel(id) {
  const chains = state.rotationChains || [], ids = new Set([id]), included = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const chain of chains) {
      if (included.has(chain) || !chain.sessions?.some(link => ids.has(link.id))) continue;
      included.add(chain); changed = true;
      for (const link of chain.sessions) ids.add(link.id);
    }
  }
  if (!included.size) return null;
  const links = new Map();
  for (const chain of included) for (const [index, link] of chain.sessions.entries()) {
    if (!links.has(link.id)) links.set(link.id, { ...link, successors: [], incoming: [] });
    const item = links.get(link.id), next = chain.sessions[index + 1];
    if (index && Number.isFinite(link.handedAt)) item.incoming.push(link.handedAt);
    // handedAt belongs to the receiving link, not the old segment.
    if (next && Number.isFinite(next.handedAt) && !item.successors.some(edge => edge.id === next.id && edge.time === next.handedAt)) {
      item.successors.push({ id: next.id, time: next.handedAt });
    }
  }
  const sessions = [...links.values()].map(link => {
    const record = state.sessions.find(s => s.id === link.id), summary = record?.messagesOmitted ? record.messageSummary || {} : null;
    // Only the earliest and latest turn times are read below: a session left out gives just those.
    const messages = summary ? [summary.turnFirstAt, summary.turnLastAt].filter(Number.isFinite).map(time => ({ time }))
      : (record?.messages || []).filter(m => !m.volatile && m.kind !== 'gap' && ['user', 'assistant'].includes(m.role) && Number.isFinite(m.time));
    const handedAt = link.successors.length ? Math.min(...link.successors.map(edge => edge.time)) : null;
    const after = handedAt === null ? [] : messages.filter(m => m.time > handedAt);
    const starts = [...link.incoming, ...messages.map(m => m.time)];
    return { id: link.id, name: record?.name || link.name || link.id, record,
      startedAt: Number.isFinite(record?.createdAt) ? record.createdAt : starts.length ? Math.min(...starts) : null,
      successors: link.successors.sort((a, b) => a.time - b.time),
      continuedAt: after.length ? Math.max(...after.map(m => m.time)) : null };
  }).sort((a, b) => (a.startedAt ?? -Infinity) - (b.startedAt ?? -Infinity) || a.id.localeCompare(b.id));
  return { sessions, currentIds: sessions.filter(link => !link.successors.length).map(link => link.id) };
}
// A later segment names the segment(s) that handed over to it; the header chip opens the whole chain from there.
function sessionChainOrigin(id) {
  const model = sessionChainModel(id);
  const previous = model ? model.sessions.filter(link => link.successors.some(edge => edge.id === id)) : [];
  return previous.length ? { previous, count: model.sessions.length } : null;
}
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
    if (!target || target.owner !== expectedOwner || ((pending || contextCurrent) && target.controlRevision !== expectedControl) || (!takeControl && heldElsewhere(target))) { render(); return false; }
    // A session no open window holds is taken only while still free (takeFreeSession): no takeover.
    if (!takeControl && target.owner !== owner) await api.claim(id, next, 'free'); else await api.claim(id, next);
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
// Taking such a session pauses nothing (Workspace.claim). It keeps its view, except that the
// terminal tab takes it for the terminal, as choosing that tab does.
const freeSessionMisses = new Map(), freeMissKey = s => `${s.owner}:${s.controlRevision || 0}`;
function takeFreeSession(binding, s) {
  if (s?.owner === owner) freeSessionMisses.delete(s.id);
  if (!s || s.owner === owner || heldElsewhere(s) || disconnected || !nativeUsable(s) || viewClaims.has(s.id) || !composerCurrent(binding)) return;
  const view = !binding.column && mode === 'terminal' || s.view === 'terminal' ? 'terminal' : 'chat';
  attempt(async () => {
    let taken = false;
    try { taken = await claimView(s.id, view, selectionRevision, false, () => composerCurrent(binding)); }
    finally {
      // A composer that showed another session or was hidden meanwhile tries again when it shows this one.
      // A refusal or a failure shows 接管此窗口 (heldElsewhere) until the owner or control changes.
      if (taken || !composerCurrent(binding)) freeSessionMisses.delete(s.id); else { freeSessionMisses.set(s.id, freeMissKey(s)); render(); }
    }
    if (taken) render();
  });
}
function soloAction(s, context = {}) {
  const choice = value => ({ ...value, label: uiText(value.labelKey), hint: uiText(value.hintKey) });
  if (!s || disconnected || s.archived) return choice({ kind: 'none', labelKey: s?.archived ? 'composer.archived' : 'composer.disconnected', hintKey: s?.archived ? 'composer.archivedHint' : 'composer.disconnectedHint' });
  if (s.transportDisconnected && canResume(s)) return choice({ kind: 'resume', labelKey: 'composer.resume', hintKey: 'composer.connectionLostHint' });
  if (!nativeUsable(s)) return choice(canResume(s)
    ? { kind: 'resume', labelKey: 'composer.resume', hintKey: 'composer.resumeHint' }
    : { kind: 'none', labelKey: 'composer.unavailable', hintKey: 'composer.unavailableHint' });
  if (heldElsewhere(s)) return choice({ kind: 'claim', labelKey: 'composer.claim', hintKey: 'composer.readOnlyHint' });
  if (interruptPending(s)) return choice({ kind: 'send', labelKey: 'composer.waitInterrupt', hintKey: 'composer.interruptHint' });
  if (s.nativeInputRequired) return choice({ kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.nativeInputHint' });
  if (s.state === 'error' && s.failedTurnInputAvailable) return choice({ kind: 'send', labelKey: 'composer.send', hintKey: 'composer.failedHint' });
  if (s.state === 'error' && (s.chatAvailable !== false || !s.legacyInputEligible || s.legacyInputPrepared)) return choice({ kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.errorHint' });
  if (s.chatAvailable === false && s.legacyInputEligible && s.provider === 'codex') return choice({ kind: 'connect', labelKey: 'composer.connect', hintKey: 'composer.codexConnectHint' });
  if (s.chatAvailable === false && s.legacyInputEligible) return choice(s.legacyInputPrepared
    ? { kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.reloadHint' }
    : { kind: 'connect', labelKey: 'composer.connect', hintKey: 'composer.pluginHint' });
  if (s.chatAvailable === false || s.state === 'starting') return choice({ kind: 'terminal', labelKey: 'composer.terminal', hintKey: 'composer.useTerminalHint' });
  if (s.legacyReaderPending && s.state === 'idle') return choice({ kind: 'send', labelKey: 'composer.send', hintKey: 'composer.readerPendingHint' });
  // Native runs a plugin's queued prompt only once idle; text typed in the TUI reaches the running turn.
  if (s.pendingQueue) return choice({ kind: 'send', labelKey: 'composer.waitNative', hintKey: s.midturnAvailable ? 'composer.queueMidturnPendingHint' : 'composer.queuePendingHint' });
  if (s.state === 'working' && s.queueAvailable && !s.approval) return choice({ kind: 'send', labelKey: s.midturnAvailable ? 'composer.queueMidturn' : 'composer.queue', hintKey: s.midturnAvailable ? 'composer.queueMidturnHint' : 'composer.queueHint' });
  if (s.state === 'working' && s.steerAvailable && s.activeTurnId && !s.approval) return choice({ kind: 'send', labelKey: 'composer.steer', hintKey: s.pendingSteer ? 'composer.inputPendingHint' : 'composer.steerHint' });
  return choice({ kind: 'send', labelKey: 'composer.send', hintKey: s.state === 'approval'
    ? s.approvalResolved ? 'composer.approvedHint'
      : s.approval?.pending ? 'composer.decisionPendingHint'
        : 'composer.approvalHint'
    : s.state === 'working' ? 'composer.workingHint' : s.pendingTag ? 'composer.inputPendingHint' : 'composer.keyboardHint' });
}
// Only another window the person has open holds a session against this one. A session nobody
// holds, or one held by a closed window or by the hidden window an agent's request ran in, is
// taken by the window that shows it, without the takeover prompt (takeFreeSession). A service
// from before that check (no freeClaim) still has every other window's session taken over.
function heldElsewhere(s) { return Boolean(s && s.owner !== owner && (!s.freeClaim || s.owner != null && !s.ownerPageless || freeSessionMisses.get(s.id) === freeMissKey(s))); }
function renderComposer(s) {
  renderDraftRecovery(s?.id);
  if (s) updateSessionComposer(activateSoloComposer(s.id), s, false);
}
// The one send gate for typed text: the solo/column composer and the search send dialog.
function sessionSendDisabled(s, action, text, changing) {
  return action.kind === 'none' || (action.kind === 'send' && (interruptPending(s) || s.pendingQueue || (s.state === 'working' && s.queueAvailable ? false : (s.state === 'working' && s.steerAvailable && s.activeTurnId ? s.pendingSteer : (s.state !== 'idle' && !(s.state === 'error' && s.failedTurnInputAvailable)) || s.pendingTag)) || s.approval || !text.trim() || pendingMode?.id === s.id || changing || inputRecoveries.get(s.id)?.text.value));
}
function updateSessionComposer(binding, s, column) {
  if (state.rotationChains?.length || binding.chainNotice) renderSessionHandoff(binding, s);
  const action = soloAction(s, { column, mode: column ? 'chat' : mode });
  const legacyDraft = (s?.legacyInputEligible || s?.nativeInputRequired) && s.owner === owner && !disconnected && !s.archived && ['connect', 'terminal'].includes(action.kind);
  const disabled = sessionSendDisabled(s, action, binding.ui.input.value, binding.changing);
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
let toastFocusOrigin = null;
function rememberToastFocus(event) {
  const notice = $('toast');
  if (notice.contains(event.target) && !notice.contains(event.relatedTarget)) toastFocusOrigin = event.relatedTarget;
}
function dismissToastWithEscape(event) {
  const notice = $('toast');
  if (notice.hidden || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const focused = document.activeElement, ownsFocus = notice.contains(focused), origin = toastFocusOrigin;
  clearTimeout(toastTimer); notice.hidden = true; toastFocusOrigin = null;
  // Outside this non-modal notice, Escape still belongs to the native terminal,
  // editor or dialog. Do not consume it or change that surface's focus.
  if (!ownsFocus) return;
  event.preventDefault(); event.stopPropagation();
  if (origin instanceof Element && origin.isConnected && !origin.disabled && origin.getClientRects().length) origin.focus({ preventScroll: true });
  else focused?.blur?.();
}
function disposeToastKeyboard() {
  document.removeEventListener('focusin', rememberToastFocus, true);
  document.removeEventListener('keydown', dismissToastWithEscape, true);
  toastFocusOrigin = null;
}
document.addEventListener('focusin', rememberToastFocus, true);
document.addEventListener('keydown', dismissToastWithEscape, true);
function toastMessage(key, params, action) { toast('', action); ui.display.text($('toast-text'), key, params); }
function toastError(error) { toast(''); ui.showError($('toast-text'), error); }
function sessionNoticeMessage(key, params, id) { sessionNotice('', id); ui.display.text($('toast-text'), key, params); }
async function attempt(action) { try { return await action(); } catch (error) { toastError(error); } }
function captureRoomView() {
  rememberRoomMemberView();
  const view = roomViews[spaceId] ||= {};
  Object.assign(view, { sharedDraft: $('shared-input').value, roomSession, roomRecipient: roomRecipient(), roomMention: roomMention && { ...roomMention }, roomFilter: $('room-filter').value || pendingRoomFilter, roomSearch: $('room-search').value, roomThread, roomReplyTo, roomSurface, roomRecordScope, roomRecordReturn, roomFilterHistory, draftRevision: roomDraftRevision, submitting: roomSubmitting });
  if (roomRecentPreview()) for (const key of ['roomFilter', 'roomSearch', 'roomThread']) view[key] = roomFilterHistory[key] || '';
  roomHistories.set(spaceId, roomMentionHistory); return view;
}
function restoreRoomView() {
  const view = roomViews[spaceId] ||= {};
  $('shared-input').value = view.sharedDraft || ''; roomSession = view.roomSession || '';
  roomMention = view.roomMention ? { ...view.roomMention } : null;
  pendingRoomFilter = view.roomFilter || ''; $('room-filter').value = pendingRoomFilter; $('room-search').value = view.roomSearch || '';
  roomThread = view.roomThread || ''; roomReplyTo = view.roomReplyTo || ''; roomSurface = view.roomSurface || 'overview';
  roomRecordScope = view.roomRecordScope || ''; roomRecordReturn = view.roomRecordReturn || null; roomFilterHistory = view.roomFilterHistory || null;
  roomDraftRevision = view.draftRevision || 0; roomSubmitting = view.submitting || null;
  roomMentionHistory = roomHistories.get(spaceId) || nativeWorkspaceMentions.editHistory(); roomHistories.set(spaceId, roomMentionHistory);
  normalizeRoomMention(); populateSelect($('recipient'), members()); $('recipient').value = roomRecipient();
  if (roomSurface === 'overview' && roomSession) restoreRoomMemberView(roomSession); else mode = 'chat';
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
function persistView() { normalizeRoomMention(); captureReadingViews(); const view = captureRoomView(); return api.viewState({ readingPositions, panorama: panoramaView, selected, mode, preference, roomSession, terminalLayout, terminalSplit, terminalDisplay, spaceId, sidebarView, sidebarCollapsedGroups: [...sidebarCollapsedGroups], sidebarCollapsedFolders: [...sidebarCollapsedFolders], columnTerminalHeights, roomViews: persistedRoomViews(), sharedDraft: $('shared-input').value, roomRecipient: roomRecipient(), roomMention, roomFilter: view.roomFilter, roomSearch: view.roomSearch, roomThread: view.roomThread, roomReplyTo }); }
// Opening a space never changes which sessions the sidebar lists (T-132).
async function selectSpace(id) {
  if (!spaceRecord(id)) throw uiError("error.spaceUnavailable");
  // Its columns show every member: the current space stays on screen until they have their messages.
  const loading = spaceId !== id && ensureMessages(members(id).map(s => s.id));
  if (loading) { await loading; if (!spaceRecord(id)) throw uiError("error.spaceUnavailable"); }
  if (spaceId !== id) {
    captureReadingViews(); captureRoomView(); closeMentions(); suspendColumnInputs();
    roomOverview?.dispose(); roomOverview = null; spaceId = id; state = projectSpace(state); restoreRoomView();
    runPreview = null; shareRevision++; lastRoomMessages = ''; lastMessages = '';
  }
  return selectRoom(roomSession, true);
}
function renderSpaceNavigation() {
  $('room-nav').parentElement.hidden = !allSpaces().some(r => r.id === 'shared');
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
    const navParams = () => ({ name: spaceName(room), count: members(room.id).length }); ui.display.attribute(row.nav, 'aria-label', 'sidebar.spaceNav', navParams); ui.display.attribute(row.nav, 'title', 'sidebar.spaceNav', navParams);
    ui.display.computed(row.name, 'text', () => spaceName(room)); row.count.textContent = members(room.id).length;
    ui.display.attribute(row.more, 'aria-label', 'sidebar.spaceActions', () => ({ name: spaceName(room) })); ui.display.attribute(row.more, 'title', 'sidebar.spaceActions', () => ({ name: spaceName(room) }));
  }
  const active = allSpaces().filter(r => !r.archived);
  $('workspace-empty').hidden = Boolean(active.length) || !allSpaces().some(r => r.archived);
  ui.display.text($('workspace-group-summary'), 'sidebar.spaceCount', { count: active.length });
}
function openSpaceCreate() {
  const opener = document.activeElement;
  $('space-create-name').value = ''; $('space-create-error').hidden = true; $('confirm-space-create').disabled = false;
  const ticket = openTransientDialog('space-create-dialog'); ticket.spaceCreateOpener = opener;
  $('space-create-name').focus();
}
let mergeDialog;
function mergeSourceLabel(room, choices) {
  return choices.filter(value => value.name === room.name).length > 1 ? `${spaceName(room)} · ${room.id.slice(0, 8)}` : spaceName(room);
}
function mergeCheckbox(text, checked, change) {
  const label = node('label', undefined, 'merge-option'), input = node('input'); input.type = 'checkbox'; input.checked = checked;
  input.onchange = () => change(input.checked); label.append(input, node('span', text)); return { label, input };
}
function mergeError(message) { if (message && typeof message !== 'string') ui.showError($('space-merge-error'), message); else { ui.display.unbind($('space-merge-error')); $('space-merge-error').textContent = message || ''; } $('space-merge-error').hidden = !message; }
function updateMergePreview() {
  const draft = mergeDialog;
  $('preview-space-merge').disabled = !draft || Boolean(draft.previewPending) || disconnected ||
    draft.rooms.filter(room => draft.sourceInputs.get(room.id)?.checked).length < 2;
}
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
          ui.display.attribute(field.input, 'aria-label', 'merge.importAction', () => ({ name: spaceName(room), kind: uiText(title), id: record.id })); inputs.push(field.input); section.append(field.label);
          if (record.text) { const full = node('details'), label = uiNode('summary', 'merge.original'); full.append(label, node('pre', record.text)); section.append(full); }
        }
        body.append(section);
      }
      const omitted = room.messages.length - eligible.length;
      if (omitted) body.append(uiNode('p', 'merge.omitted', () => ({ count: new Intl.NumberFormat(ui.language.getSnapshot().active).format(omitted) }), 'quiet'));
    };
    $('space-merge-selection').append(details);
  }
  updateMergePreview();
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
// Native-reported vendor identity is independent of the program running it.
// Optional local PNGs stay outside the public repository; letters work without them.
const VENDOR_MARKS = { anthropic: ['A', 'Anthropic'], openai: ['O', 'OpenAI'], deepseek: ['D', 'DeepSeek'] };
const SHELL_NAMES = { claude: 'Claude Code', codex: 'Codex', dsh: 'DSH' };
function sessionMaker(record) {
  const shell = record?.shell || record?.provider;
  const vendor = typeof record?.vendor === 'string' && record.vendor ? record.vendor : shell === 'claude' ? 'anthropic' : null;
  const [mark, vendorName] = Object.hasOwn(VENDOR_MARKS, vendor) ? VENDOR_MARKS[vendor] : vendor ? [vendor[0].toUpperCase() + (vendor[1] || '·'), vendor] : [shell === 'claude' ? 'Cl' : 'Cx', ''];
  return { vendor, shell, shellName: SHELL_NAMES[shell] || '', mark, vendorName, tone: Object.hasOwn(VENDOR_MARKS, vendor) ? vendor : vendor ? 'other' : 'unknown' };
}
function makerLabel(record) {
  const maker = sessionMaker(record);
  return maker.vendor ? uiText('vendor.label', { vendor: maker.vendorName, shell: maker.shellName }) : uiText('vendor.unreported', { shell: maker.shellName });
}
// Paints the mark in place, so a row keeps its other children (the sidebar's state dot) when Codex
// reports the vendor later.
function paintVendorMark(element, record, text) {
  const maker = sessionMaker(record);
  element.className = `agent-icon vendor-mark vendor-${maker.tone}${element.classList.contains('small') ? ' small' : ''}`;
  element.dataset.vendor = maker.vendor || '';
  let label = element.firstChild;
  if (label?.nodeType !== Node.TEXT_NODE) { label = document.createTextNode(''); element.prepend(label); }
  label.nodeValue = text ?? maker.mark;
  const source = typeof state !== 'undefined' && state.vendorIcons?.[maker.vendor];
  let image = element.querySelector?.('.vendor-image');
  if (typeof source === 'string' && source.startsWith('data:image/png;base64,') && element.failedVendorSource !== source) {
    if (!image) { image = node('img', undefined, 'vendor-image'); image.alt = ''; image.setAttribute('aria-hidden', 'true'); element.append(image); }
    image.onerror = () => { element.failedVendorSource = source; image.remove(); label.nodeValue = text ?? maker.mark; };
    if (image.getAttribute('src') !== source) image.src = source;
    label.nodeValue = '';
  } else if (image) image.remove();
  return element;
}
function icon(record, small = false) { return paintVendorMark(node('span', undefined, small ? 'small' : ''), record); }
async function select(id, requestedMode, member = roomSession, passive = false) {
  // The old view stays until the new one has its messages; another selection meanwhile wins. Counted once,
  // before the wait: a caller reads selectionRevision right after calling (operateNative).
  const loading = ensureMessages(id === 'room' ? [member, ...members().map(s => s.id)] : [id]);
  let revision = loading ? ++selectionRevision : 0;
  if (loading) { await loading; if (revision !== selectionRevision) return; }
  rememberRoomMemberView();
  captureReadingViews(); suspendColumnInputs();
  if (!loading) revision = ++selectionRevision;
  const leaving = terminals.get(activeSessionId());
  if (leaving?.composing) leaving.term.blur();
  if (revision !== selectionRevision) return;
  if (id === 'room') roomSession = member;
  selected = id; const s = current();
  if (selected === 'room') { if (roomSurface === 'overview' && roomSession) restoreRoomMemberView(roomSession); else mode = 'chat'; }
  else if (requestedMode) mode = requestedMode; else if (s) mode = s.owner === owner ? s.view : preference;
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
  if (!passive && s && mode === 'terminal' && (switchedAway(s) || !['ended', 'background', 'stopping', 'disconnected', 'recoverable'].includes(s.state))) attempt(async () => { await ensureTerminal(s.id, true); focusTerminal(s.id); });
  if (!passive && selected === 'room' && mode === 'terminal' && s?.owner === owner && s.view !== 'terminal') attempt(async () => {
    const revision = selectionRevision;
    const stillSelected = () => revision === selectionRevision && selected === 'room' && roomSession === s.id && mode === 'terminal';
    if (!await claimView(s.id, 'terminal', revision) || !stillSelected()) return;
    render();
    await ensureTerminal(s.id, true);
    if (stillSelected()) focusTerminal(s.id);
  });
}
function selectRoom(id = '', passive = false) { if (id) roomSurface = 'overview'; return select('room', undefined, id, passive); }
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
  const record = state.sessions.find(s => s.id === id);
  if (!record) throw uiError('error.sessionMissing');
  await api.spaceAction(source, 'join', [id, false, placementProof(record)]);
  // State reconciliation removes the reader in place. Opening its original
  // session is a separate human action, never another input/view claim.
  sessionNoticeMessage("toast.detached", undefined, id);
}
function focusTerminal(id = activeSessionId()) {
  if (terminalCanInput(id) && inputFocusAllowed()) terminals.get(id).term.focus();
}
// For a session this window controls, the terminal takes keys whichever side the session's view is on, as the
// conversation box takes text: the person, 2026-11-13: 「对于 Claude 和 codex 这样支持的,我希望两边的输入可以不要锁定」.
// The view only says which side the person is on (where a held question goes); choosing a side gives no input right.
function terminalCanInput(id) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return Boolean(entry?.ready && currentTerminalDisplay(entry, record) && terminalContextVisible(id) && nativeUsable(record) && record?.owner === owner && terminalViewAccepts(record) && !state?.roomStorageWarning && !disconnected);
}
// The window that controls a session types into its terminal whichever side the view is on (the person, 2026-11-13:
// 两边的输入可以不要锁定). A service from before that (no eitherViewInput) still needs the view on the terminal side.
function terminalViewAccepts(record) { return Boolean(record && (record.eitherViewInput || record.view === 'terminal')); }
function currentTerminalDisplay(entry, record) {
  if (columnTerminalBinding(record?.id) && (!entry?.epoch || !record?.terminalState?.epoch || entry.nativeId !== record.nativeId || record.nativeContextPending)) return false;
  return entry?.generation === (record?.connectionRevision || 0) && (!record?.recovering || record.terminalState?.alive === true) &&
    record?.terminalState?.alive !== false && (!entry?.epoch || !record?.terminalState?.epoch || entry.epoch === record.terminalState.epoch);
}
function canFlushComposition(id, token = terminals.get(id)?.composition) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return Boolean(token && currentTerminalDisplay(entry, record) && !token.cancelled && !token.consumed && entry?.composition === token && !entry.composing && entry.ready && entry.generation === (record?.connectionRevision || 0) && nativeUsable(record) && record.owner === owner && terminalViewAccepts(record) && !state?.roomStorageWarning && !disconnected);
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
  entry.columnReading = false; entry.term.paste(text); focusTerminal(id);
}
const roomImageRefs = (id = spaceId) => roomViews[id]?.roomImages || [];
function roomImageForwardAvailable(recipient) {
  return recipient?.spaceImagesAvailable === true && recipient.serviceCapabilities?.includes('spaceImageInputV1') &&
    recipient.state === 'idle' && !recipient.pendingTag && !recipient.pendingQueue && !recipient.approval && !recipient.nativeInputRequired &&
    recipient.shareAvailable !== false && recipient.chatAvailable !== false && !interruptPending(recipient);
}
async function acknowledgeRoomImageReceipt(id, version, tag) {
  const view = roomViews[id];
  if (!view || view.roomImageVersion !== version || view.roomImageDispatching || view.roomImageAckAttempt === version + tag) return;
  view.roomImageAckAttempt = version + tag;
  const result = await api.spaceAction(id, 'acceptImages', [version, tag]);
  if (result?.accepted && view.roomImageVersion === version) {
    view.roomImages = result.refs; view.roomImageVersion = result.version; delete view.roomImageSend;
    const caption = result.caption, original = id === spaceId ? captureRoomView() : view;
    if (caption && original.draftRevision === caption.revision && original.sharedDraft === caption.raw && original.roomRecipient === caption.recipientId &&
        ['id', 'start', 'end', 'text', 'active', 'memberRevision'].every(key => original.roomMention?.[key] === caption.mention?.[key])) {
      original.sharedDraft = ''; original.roomMention = null; original.roomRecipient = ''; original.draftRevision++;
      writeRoomDraft(id, original);
    }
    render();
  }
}
function roomImageDraftEditable(id) {
  const merge = state?.room?.merge, blocked = merge && (!merge.imported || ['preparing', 'joining', 'failed', 'undoing'].includes(merge.stage));
  return selected === 'room' && sharedSurface() && spaceId === id && !disconnected && state?.room && !state.room.archived && !state.room.unavailable && !blocked && !roomViews[id]?.roomImageDispatching;
}
function renderRoomImageDraft() {
  const host = $('room-images'), view = roomViews[spaceId] ||= {}, refs = roomImageRefs();
  host.hidden = !refs.length;
  const sent = view.roomImageSend;
  if (sent && !view.roomImageDispatching) {
    const row = state.room.messages.find(m => m.imageDraftVersion === view.roomImageVersion && m.recipientId === sent.recipientId && m.imageReceipt?.nativeId === sent.nativeId && m.imageReceipt?.status === 'accepted');
    if (row) attempt(() => acknowledgeRoomImageReceipt(spaceId, view.roomImageVersion, row.id));
  }
  $('add-room-image').disabled = !roomImageDraftEditable(spaceId) || Boolean(view.roomImagesImporting) || refs.length >= 4;
  if (!roomImagesWidget) roomImagesWidget = window.nativeWorkspaceImages.mount(host, api, {
    display: ui.display, text: uiText, displayText: ui.displayText, createError: ui.createError,
    remove: ref => attempt(() => removeRoomImage(ref.roomId, ref.id)),
  });
  roomImagesWidget.update(refs, { kind: 'space-draft', roomId: spaceId, messageId: view.roomImageVersion }, () => uiText('roomImages.draft'), 'preview');
  for (const remove of host.querySelectorAll('.native-image-remove')) remove.disabled = !roomImageDraftEditable(spaceId) || Boolean(view.roomImagesImporting);
}
async function addRoomImages(files, id = spaceId) {
  const view = roomViews[id] ||= {};
  if (!roomImageDraftEditable(id)) throw uiError('error.roomImages.changed');
  if (view.roomImagesImporting) throw uiError('error.roomImages.busy');
  if (!files.length || files.length + roomImageRefs(id).length > 4 || files.reduce((n, file) => n + file.size, 0) + roomImageRefs(id).reduce((n, ref) => n + ref.size, 0) > 20 * 1024 * 1024) throw uiError('error.roomImages.limit');
  view.roomImagesImporting = true; render();
  try {
    const bytes = await Promise.all(files.map(async file => ({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name })));
    const result = await api.spaceAction(id, 'stageImages', [bytes, view.roomImageVersion]);
    view.roomImages = result.refs; view.roomImageVersion = result.version;
    delete view.roomImageSend;
    // The original space receives the result even after a view switch. The
    // current text, @ recipient and reading position are never replaced.
    if (spaceId === id) roomDraftRevision++;
  } finally { view.roomImagesImporting = false; render(); }
}
async function removeRoomImage(id, imageId) {
  const view = roomViews[id];
  if (!roomImageDraftEditable(id) || !view) throw uiError('error.roomImages.changed');
  if (view.roomImagesImporting) throw uiError('error.roomImages.busy');
  view.roomImagesImporting = true; render();
  try {
    const result = await api.spaceAction(id, 'removeImage', [imageId, view.roomImageVersion]);
    if (roomViews[id] !== view) return;
    view.roomImages = result.refs; view.roomImageVersion = result.version;
    delete view.roomImageSend;
    if (result.imagesLeft) toastMessage('roomImages.cacheRetained');
    if (spaceId === id) roomDraftRevision++;
  } finally { view.roomImagesImporting = false; render(); }
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
// A Claude session temporarily started with an older qualified version (claude-pin.cjs).
function claudePinText(s, detail = false) {
  const pin = s?.provider === 'claude' ? s.nativePin : null;
  if (!pin) return '';
  const date = new Date(pin.until).toLocaleDateString(ui.language.getSnapshot().active, { month: 'numeric', day: 'numeric' });
  const text = uiText(`native.claudePin${pin.expired ? 'Expired' : 'ned'}${detail ? 'Detail' : ''}`, { pinned: pin.pinned, requested: pin.requested, date });
  const check = pin.check;
  if (!check) return text;
  const reasons = ['mod-tests', 'solo-queue', 'shared-queue', 'shared-model', 'native-startup', 'binary-changed', 'cancelled', 'timed-out'];
  const reason = reasons.includes(check.reason) ? check.reason : 'native-startup';
  return text + ' · ' + uiText(check.status === 'passed' ? 'native.claudeCheckPassed' : check.status === 'failed' ? 'native.claudeCheckFailed' : 'native.claudeCheckPending', { reason: uiText('native.claudeCheckReason.' + reason) });
}
function nativeVersionText(s) {
  if (s?.provider === 'claude') return claudePinText(s, true);
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
function openSetupDialog() {
  const dialog = $('setup-dialog');
  // A settings link inside another modal (for example Create) keeps that
  // dialog's focus boundary and draft. Ordinary settings never make chat inert.
  const modal = Boolean(document.querySelector('dialog:modal:not(#setup-dialog)'));
  if (dialog.open && dialog.matches(':modal') !== modal) dialog.close();
  const ticket = { dialog }; dialogTickets.set(dialog, ticket);
  dialog.setAttribute('closedby', modal ? 'any' : 'none');
  $('header').closest('main').classList.toggle('settings-panel-open', !modal);
  if (!dialog.open) { if (modal) dialog.showModal(); else dialog.show(); }
  return ticket;
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
  ui.display.text($('clear-shared-history'), 'trust.clearSpace', () => ({ name: spaceName(spaceRecord(trustClearRoom)) || uiText('sidebar.space') }));
  trustScope = scope; dialog.dataset.mode = scope ? 'usage' : 'privacy';
  ui.display.text(dialog.querySelector('h2'), scope ? 'trust.namedUsage' : 'privacy.open', scope ? () => ({ name: scope.kind === 'room' && scope.unavailable ? uiText('space.unavailable') : scope.kind === 'room' ? spaceName({ id: scope.roomId, name: scope.name }) : scope.name }) : undefined);
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
  $('initial-view').value = preference; $('session-name').value = ''; $('claude-history-id').value = ''; $('skip-permissions').checked = false; $('create-profile').replaceChildren();
  $('create-space-kind').value = 'independent'; $('create-space-existing').value = ''; $('create-space-name').value = ''; delete $('create-space-name').dataset.edited;
  resetCreateDirectory(); ui.display.unbind($('create-error')); $('create-error').textContent = '';
  const ticket = openTransientDialog('create-dialog'); ticket.directoryDefaults = {}; createReadiness();
  return loadCreateDirectory(ticket);
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
  const roster = JSON.stringify(rooms.map(room => [room.id, room.name, spaceName(room)]));
  if (select.dataset.roster !== roster) {
    const chosen = select.value, named = name => rooms.filter(room => room.name === name).length > 1;
    const placeholder = new Option('', ''); ui.display.text(placeholder, 'create.spacePlaceholder');
    select.replaceChildren(placeholder);
    for (const room of rooms) select.add(new Option(named(room.name) ? `${spaceName(room)} · ${room.id.slice(0, 6)}` : spaceName(room), room.id));
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
    return uiText('create.keptSession', { name: record?.name || sessionShortId(creation.sessionId), space: room ? uiText('create.keptSpace', { name: spaceName(room) }) : '' }); };
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
      await api.spaceAction(room.id, 'join', [record.id, true, placementProof(record)]); updateState(await api.initial()); render();
      if (!inSpace(state.sessions.find(s => s.id === record.id), room.id)) throw uiError('error.spaceJoinDidNotApply');
    }
    // Joined. If the selection moved meanwhile the dialog may still be open: close it too, since nothing is left to do here
    // (branch table: E2, the join while the selection moved).
    if (fresh()) { $('create-dialog').close(); await select(record.id, creation.view); }
    else if (currentDialogTicket(ticket)) $('create-dialog').close();
    toastMessage('toast.createdSessionJoined', { name: spaceName(room) });
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
async function loadCreateDirectory(ticket) {
  const request = ticket.directoryDefaults;
  try {
    const defaults = await api.createDefaults();
    if (!currentDialogTicket(ticket) || ticket.directoryDefaults !== request) return;
    delete ticket.directoryDefaults;
    if (defaults?.repository && state.capabilities?.includes('gitWorktreeV1')) {
      folder = defaults.repository; newDirectory = false; $('git-worktree').checked = true;
      invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder;
      await refreshGitPreview();
    } else if (defaults?.directory) {
      folder = defaults.directory; newDirectory = false; $('chosen-folder').textContent = folder;
    }
  } catch (error) {
    // A failed read must not silently create in the temporary empty folder.
    // Choosing a folder or requesting a new empty one cancels this opening's read.
    if (currentDialogTicket(ticket) && ticket.directoryDefaults === request) ui.showError($('create-error'), error);
  } finally { if (currentDialogTicket(ticket)) createReadiness(); }
}
function invalidateGitPreview(newNonce = false) {
  const ticket = dialogTickets.get($('create-dialog')); if (ticket) delete ticket.directoryDefaults;
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
// Which provider the picker lists, and for Claude the name and permission choice made in 新建会话 before it opened.
let historyProvider = 'codex', historyOptions = {};
const historyText = key => historyProvider === 'claude' ? { 'history.title': 'history.claudeTitle', 'history.intro': 'history.claudeIntro', 'history.help': 'history.claudeHelp',
  'history.unnamed': 'history.claudeUnnamed', 'history.loading': 'history.claudeLoading', 'history.empty': 'history.claudeEmpty' }[key] || key : key;
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
      // A session already open here runs in NAW itself, not elsewhere.
      return [time, row.existingIds?.length && uiText('history.inWorkspace'), row.running && !row.existingIds?.length && uiText('history.claudeRunning')].filter(Boolean).join(' · ');
    });
    text.append(row.name ? node('strong', row.name) : uiNode('strong', historyText('history.unnamed')), node('small', row.cwd), stamp);
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
  renderNativeHistory(); ui.display.text($('native-history-status'), historyText('history.loading'));
  try {
    const claude = historyProvider === 'claude';
    const result = await api.nativeHistory({ ...(claude ? { provider: 'claude' } : {}), search: historySearch, ...(more ? { cursor: historyCursor } : {}) });
    if (generation !== historyGeneration || !$('native-history-dialog').open) return;
    const seen = new Set(historyRows.map(r => r.nativeId)); historyRows.push(...result.data.filter(r => !seen.has(r.nativeId))); historyCursor = result.nextCursor;
    const number = count => new Intl.NumberFormat(ui.language.getSnapshot().active).format(count);
    // Claude's own records could not be read as expected: say why and point to pasting the ID, without guessing.
    const unavailable = claude && result.unavailable;
    const skipped = claude && !unavailable && result.skipped > 0 ? result.skipped : 0, unknown = claude && !unavailable && result.runningUnknown === true;
    if (unavailable) ui.display.computed($('native-history-status'), 'text', () => unavailable.reason === 'format' ? uiText('history.claudeFormat', { count: number(unavailable.count) })
      : unavailable.version ? uiText('history.claudeVersion', { version: unavailable.version }) : uiText('history.claudeVersionUnknown'));
    else if (skipped || unknown) ui.display.computed($('native-history-status'), 'text', () => [historyRows.length ? uiText('history.count', { count: number(historyRows.length) }) : uiText('history.claudeEmpty'),
      skipped && uiText('history.claudeSkipped', { count: number(skipped) }), unknown && uiText('history.claudeRunningUnknown')].filter(Boolean).join(' '));
    else ui.display.text($('native-history-status'), historyRows.length ? 'history.count' : historyText('history.empty'), historyRows.length ? () => ({ count: number(historyRows.length) }) : undefined);
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
  openNativeHistory('codex');
};
function openNativeHistory(provider) {
  if (historyImporting) return;
  // The name and permission choice already made in 新建会话 apply to the session continued from the list.
  historyProvider = provider; historyOptions = provider === 'claude' ? { name: $('session-name').value, skipPermissions: $('skip-permissions').checked } : {};
  $('create-dialog').close(); historyRows = []; historySelected = null; historyCursor = null; historyLoading = false;
  for (const [id, key] of [['native-history-heading', 'history.title'], ['native-history-intro', 'history.intro'], ['native-history-help', 'history.help']]) ui.display.text($(id), historyText(key));
  $('native-history-search').value = ''; $('native-history-dialog').showModal(); loadNativeHistory();
}
$('open-claude-sessions').onclick = () => {
  const ticket = dialogTickets.get($('create-dialog'));
  if (!currentDialogTicket(ticket) || creatingSession || ticket.created || ticket.creation) return;
  openNativeHistory('claude');
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
    // A Claude row continues through the same import as a pasted ID, in the row's own folder.
    const row = historyRows.find(r => r.nativeId === historySelected), claude = historyProvider === 'claude';
    const id = claude ? await api.importHistory(row.nativeId, { provider: 'claude', cwd: row.cwd, name: historyOptions.name, skipPermissions: historyOptions.skipPermissions })
      : await api.importHistory(historySelected);
    updateState(await api.initial()); render();
    if (fresh() && revision === selectionRevision) { $('native-history-dialog').close(); await select(id, claude ? 'terminal' : 'chat'); }
    else toastMessage('history.retained');
    if (state.sessions.find(s => s.id === id)?.archived) toastMessage('history.archived');
  } catch (error) { if (fresh()) ui.showError($('native-history-status'), error); else toastError(error); }
  finally { historyImporting = false; renderNativeHistory(); }
};
function openRename(id, origin, roomId = spaceId) {
  const record = id === 'room' ? spaceRecord(roomId) : state.sessions.find(s => s.id === id); if (!record) return;
  const spaceHeading = id === 'room' && roomId === spaceId && spaceRows.get(roomId)?.nav?.getAttribute('aria-current') === 'page';
  if (renaming) return toastMessage("toast.nameSaving");
  if (renameTarget) {
    if (renameTarget.id === id && (id !== 'room' || renameTarget.roomId === roomId) || $('rename-name').value !== renameTarget.originalName) {
      revealRenameRow(renameTarget.row); $('rename-name').focus(); return toastMessage("toast.finishRename");
    }
    closeRename(false);
  }
  // A space's editor opens in its row in the 协作空间 section, which is hidden while that section is folded; the heading's
  // and the header's ⋯ are reachable then. Unfold the section first, as the person would (T-155).
  if (id === 'room' && !spaceHeading && state.sidebar?.workspaceCollapsed) {
    const revision = ++renameRevision;
    return attempt(async () => {
      await api.sidebar({ type: 'collapse', section: 'workspace', collapsed: false });
      if (revision !== renameRevision) return;
      if (state.sidebar?.workspaceCollapsed) state.sidebar = { ...state.sidebar, workspaceCollapsed: false };
      openRename(id, origin, roomId);
    });
  }
  const row = spaceHeading ? $('title').parentElement : id === 'room' ? spaceRows.get(roomId)?.element : origin?.closest('.session-row') || sessionRow(id)?.element;
  if (!row || record.archived || id === 'room' && spaceRecord(roomId)?.archived) return;
  renameTarget = { id, roomId, origin, originalName: record.name, row, label: spaceHeading ? $('title') : id === 'room' ? spaceRows.get(roomId).name : [...sessionRows.values()].find(r => r.element === row).name };
  renameRevision++; renameComposing = false; $('rename-name').value = record.name;
  ui.display.text($('rename-label'), id === 'room' ? 'rename.workspace' : 'rename.session');
  $('rename-error').hidden = true; ui.display.unbind($('rename-error')); $('rename-error').textContent = '';
  row.classList.add('is-renaming'); renameTarget.label.hidden = true;
  row.append($('rename-editor')); $('rename-editor').hidden = false; revealRenameRow(row);
  render(); $('rename-name').focus(); $('rename-name').select();
}
function revealRenameRow(row) {
  if (row === $('title').parentElement) return;
  const group = row.closest('.session-space-group');
  if (group && sidebarCollapsedGroups.has(group.dataset.sessionGroup)) toggleSidebarGroup(group.dataset.sessionGroup);
  const folder = row.closest('.hier-folder-group');
  if (folder && sidebarCollapsedFolders.has(folder.dataset.hierFolder)) toggleSidebarFolder(folder.dataset.hierFolder);
  ui.revealSidebar();
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
    // If the sidebar folded to the rail meanwhile, ⋯ is not drawn there (sidebar-look.css): the row's own button takes focus.
    const row = target.id === 'room' ? null : sessionRow(target.id);
    const action = target.origin?.isConnected && target.origin.getClientRects().length ? target.origin : target.id === 'room' ? $('room-more') : row?.link && !row.more?.getClientRects().length ? row.link : row?.more;
    (action?.getClientRects().length && !action.disabled ? action : $(target.id === 'room' ? 'workspace-toggle' : 'solo-drop')).focus({ preventScroll: true });
  }
}
// The collapsed rail does not draw ⋯ (sidebar-look.css); focus then goes back to the row's own button.
function focusSessionAction(id) { if (id === 'room') { $('room-more').focus(); return; } const row = sessionRow(id); if (!row) return; (row.link && !row.more.getClientRects().length ? row.link : row.more).focus(); }
async function setOperatorEnabled(id, enabled) {
  await api.operatorAction(id, 'enabled', enabled);
  toastMessage(enabled ? 'operator.enableNote' : 'operator.disabledNote');
}
// A background operation is said as one sentence: what the agent asks or did, with the names, folder and flags
// in its command, and the risks marked. The raw command shows once, folded under 「详情」. A card the agent asked
// again later is greyed with the reason and has no buttons: only the newest card can be answered (main refuses
// the old one too). Every line follows the display language; the stored card text stays what was asked.
function backgroundActionText(summary) {
  return summary.action && uiTextKnown('background.action.' + summary.action) ? uiText('background.action.' + summary.action) : uiText('background.card.call', { method: summary.method });
}
function backgroundSummaryText(summary, compact = false) {
  const action = backgroundActionText(summary);
  if (summary.action === 'clearSharedHistory' && summary.room) return uiText(compact ? 'background.card.clearSharedHistoryShort' : 'background.card.clearSharedHistory', { name: summary.room });
  const parts = [summary.name ? uiText('background.card.named', { action, name: summary.name }) : action];
  if (summary.target) parts.push(uiText('background.card.session', { name: summary.target }));
  if (summary.room) parts.push(uiText('background.card.room', { name: summary.room }));
  if (summary.provider) parts.push(summary.provider === 'codex' ? 'Codex' : 'Claude');
  if (summary.program) parts.push(summary.program);
  if (summary.folder) parts.push(uiText('background.card.folder', { name: summary.folder }));
  if (summary.risks?.includes('skipPermissions')) parts.push(uiText('background.card.skipPermissions'));
  if (summary.worktree) parts.push(uiText('background.card.worktree'));
  if (summary.file) parts.push(uiText(summary.files ? 'background.card.files' : 'background.card.file', { name: summary.file, count: summary.files || 1 }));
  return parts.join(' · ');
}
const backgroundStates = ['running', 'complete', 'received', 'awaiting-native', 'confirmation-required', 'cancelled', 'not-executed', 'unconfirmed'];
const backgroundClock = time => new Date(time).toLocaleTimeString(ui.language.getSnapshot().active, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// The two buttons main always asks with are said in the display language; any other set keeps its stored labels.
function backgroundButtonKeys(options, summary) {
  const keys = ['common.cancel', 'background.confirm'], format = window.nativeWorkspaceLocale.format;
  const sets = [keys];
  if (summary?.action === 'clearSharedHistory') sets.push(['common.cancel', 'os.clearSharedButton']);
  return options.buttons.length === 2 && (options.cancelId ?? 0) === 0 && sets.some(set => set.every((key, i) => ['zh', 'en'].some(locale => format(locale, key) === options.buttons[i]))) ? keys : null;
}
// One clock for the existing status spans; no state RPC or model work per tick.
let backgroundExpiryClock;
function backgroundRemaining(line) {
  const seconds = Math.max(0, Math.ceil((Number(line.dataset.expiresAt) - Date.now()) / 1000));
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  ui.display.text(line, seconds ? 'background.card.remaining' : 'background.card.elapsed', { time });
}
function scheduleBackgroundExpiryClock() {
  clearTimeout(backgroundExpiryClock);
  backgroundExpiryClock = setTimeout(() => {
    backgroundExpiryClock = undefined;
    // Cards may still be detached while rendering; inspect after they mount.
    // Cached conversation rows can outlive their confirmation. Only the current
    // human waiting list owns a countdown; never retain a row between ticks.
    const pending = new Set((state?.backgroundConfirmations || []).map(card => card.id));
    for (const line of document.querySelectorAll('.background-state[data-expires-at]')) {
      const row = line.closest('[data-message-id], [data-waiting-id]');
      if (!pending.has(row?.dataset.messageId || row?.dataset.waitingId)) { delete line.dataset.expiresAt; continue; }
      backgroundRemaining(line);
    }
    if (!document.querySelector('.background-state[data-expires-at]')) return;
    scheduleBackgroundExpiryClock();
  }, 1000);
}
// Batches the person answered with one click (kept until their cards are gone) and batches opened one by one; memory only.
const confirmationBatchStarted = new Map(), confirmationBatchOpen = new Set();
// Release only failed submissions that a later authoritative read still shows as unanswered and actionable.
function reconcileConfirmationBatch(started, cards) {
  const retryable = new Set(cards.filter(card => {
    const op = card.message?.backgroundOperation;
    return card.actionable === true && card.state === 'confirmation-required' && op?.state === 'confirmation-required' &&
      !card.replacedBy && !op.replacedBy && !op.answer && !op.disposition;
  }).map(card => card.key));
  const release = new Set((started.failedKeys || []).filter(key => retryable.has(key)));
  started.keys = started.keys.filter(key => !release.has(key));
  started.failedKeys = (started.failedKeys || []).filter(key => !release.has(key));
  if (!started.keys.length && confirmationBatchStarted.get(started.key) === started) confirmationBatchStarted.delete(started.key);
}
function confirmationBatchRole(op) {
  const batch = globalThis.nativeWorkspaceConfirmationBatch, cards = state?.backgroundConfirmations || [];
  if (!batch || !op) return null;
  const present = new Set(cards.map(card => card.key));
  for (const [key, started] of confirmationBatchStarted) {
    if (!started.keys.some(k => present.has(k))) confirmationBatchStarted.delete(key);
    else if (started.failedKeys?.length && cards !== started.observed && state.backgroundConfirmationsAvailable !== false) {
      reconcileConfirmationBatch(started, cards); started.observed = cards;
    }
  }
  const role = batch.find(batch.plan(cards, [...confirmationBatchStarted.values()]), [op.sessionId, op.nativeId, op.id].join(':'));
  return role && { ...role, open: !role.batch.started && confirmationBatchOpen.has(role.batch.key) };
}
function confirmationBatchTitle(op) {
  const role = confirmationBatchRole(op);
  return role && !role.open && role.anchor ? uiText('background.batch.title', { action: backgroundActionText(role.batch.cards[0].summary), count: role.batch.cards.length }) : '';
}
// The waiting list shows a merged batch once, on the card that draws it.
function confirmationCardHidden(card) {
  const role = confirmationBatchRole(card?.message?.backgroundOperation);
  return Boolean(role && !role.open && !role.anchor);
}
function confirmationBatchKey(role) {
  if (!role) return null;
  const { itemState } = globalThis.nativeWorkspaceConfirmationBatch;
  return [role.batch.key, role.anchor, role.open, role.batch.started, role.batch.submitting, role.batch.cards.map(c => [c.key, itemState(c), c.actionable, c.expiresAt, c.message?.backgroundOperation?.resultNotice, c.message?.backgroundOperation?.error, c.summary])];
}
// One answer per card, sent in the cards' order; main carries them out one at a time, each with its own checks.
async function answerConfirmationBatch(batch, cancel) {
  const key = JSON.stringify(batch.cards.map(card => card.key));
  if (confirmationBatchStarted.has(key)) return;
  const started = { key, keys: batch.cards.map(card => card.key), submitting: true };
  confirmationBatchStarted.set(key, started);
  render();
  const answers = batch.cards.map(card => Promise.resolve().then(() => {
    const options = card.message.backgroundOperation.confirmation.options, cancelId = options.cancelId ?? 0;
    const response = cancel ? cancelId : options.buttons.findIndex((_label, index) => index !== cancelId);
    return api.backgroundDecision(card.sessionId, card.nativeId, card.operationId, response);
  }));
  const results = await Promise.allSettled(answers);
  started.submitting = false;
  started.failedKeys = batch.cards.filter((_card, index) => results[index].status === 'rejected').map(card => card.key);
  started.observed = state?.backgroundConfirmations;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    toastError(failed.reason);
    try {
      const fresh = await api.initial();
      if (fresh.backgroundConfirmationsAvailable !== false && Array.isArray(fresh.backgroundConfirmations))
        reconcileConfirmationBatch(started, fresh.backgroundConfirmations);
    } catch { /* Keep uncertain submissions locked until an authoritative read arrives. */ }
  }
  render();
}
function renderConfirmationBatch(box, role) {
  const { itemState } = globalThis.nativeWorkspaceConfirmationBatch, cards = role.batch.cards, count = cards.length;
  const states = cards.map(itemState), tally = name => states.filter(s => s === name).length;
  const line = node('p', undefined, 'background-line'), state = node('span', undefined, 'background-state'), sentence = node('strong', undefined, 'background-sentence');
  ui.display.computed(sentence, 'text', () => uiText('background.batch.title', { action: backgroundActionText(cards[0].summary), count }));
  if (!role.batch.started) {
    ui.display.text(state, 'background.card.waiting');
    const soonest = Math.min(...cards.map(c => c.expiresAt).filter(Number.isSafeInteger));
    if (Number.isSafeInteger(soonest)) { state.dataset.expiresAt = String(soonest); backgroundRemaining(state); scheduleBackgroundExpiryClock(); }
  } else if (tally('waiting') && !tally('queued') && !tally('running')) {
    ui.display.text(state, role.batch.submitting ? 'background.batch.submitting' : 'background.batch.enqueueUnconfirmed');
  } else if (tally('queued') + tally('running') + tally('waiting')) {
    ui.display.text(state, 'background.batch.progress', { index: Math.min(count, tally('done') + tally('void') + tally('cancelled') + tally('unconfirmed') + 1), count });
  } else if (tally('cancelled') === count) ui.display.text(state, 'background.batch.cancelled', { count });
  else ui.display.text(state, tally('unconfirmed') ? 'background.batch.resultUnconfirmed' : 'background.batch.result', { done: tally('done'), void: tally('void') + tally('cancelled'), unconfirmed: tally('unconfirmed') });
  line.append(state, sentence); box.append(line);
  const list = node('ul', undefined, 'background-batch-list');
  cards.forEach((card, index) => {
    const item = node('li', undefined, 'background-batch-item'), target = node('span', undefined, 'background-batch-target');
    ui.display.computed(target, 'text', () => card.summary ? backgroundSummaryText(card.summary) : card.title);
    item.append(target);
    if (role.batch.started) {
      item.dataset.state = states[index];
      item.append(uiNode('span', 'background.batch.item.' + states[index], undefined, 'background-batch-state'));
      const op = card.message?.backgroundOperation, notice = op?.resultNotice;
      if (notice || op?.error) {
        const why = node('span', undefined, 'background-batch-why');
        if (notice) ui.display.text(why, notice.key, notice.params); else why.textContent = op.error;
        item.append(why);
      }
    }
    list.append(item);
  });
  box.append(list);
  if (role.batch.started || cards.some(card => card.actionable !== true)) return;
  const buttons = node('div', undefined, 'background-buttons');
  const cancel = node('button', '', 'small'), review = node('button', '', 'small'), all = node('button', '', 'small primary');
  ui.display.text(cancel, 'background.batch.cancelAll'); ui.display.attribute(cancel, 'aria-label', 'background.batch.cancelAllName', { count });
  ui.display.text(review, 'background.batch.review'); ui.display.text(all, 'background.batch.confirmAll', { count });
  for (const button of [cancel, review, all]) button.disabled = disconnected;
  cancel.addEventListener('click', () => answerConfirmationBatch(role.batch, true));
  all.addEventListener('click', () => answerConfirmationBatch(role.batch, false));
  review.addEventListener('click', () => { confirmationBatchOpen.add(role.batch.key); render(); });
  buttons.append(cancel, review, all); box.append(buttons);
}
function renderBackgroundControls(entry, message) {
  const op = message.backgroundOperation, question = op?.state === 'confirmation-required' && op.confirmation;
  const card = question?.kind === 'message' && Array.isArray(question.options?.buttons), summary = op?.summary;
  // Before the unchanged-record return: the reading list rewrites the row's class name on every pass.
  entry.item.classList.toggle('background-card', Boolean(card && !op.replacedBy && !op.disposition));
  entry.item.classList.toggle('background-void', Boolean(op?.disposition || card && op.replacedBy));
  const batchRole = confirmationBatchRole(op);
  const key = JSON.stringify(batchRole ? [op, disconnected, confirmationBatchKey(batchRole)] : [op, disconnected]);
  if (key === entry.backgroundKey) return;
  entry.backgroundKey = key;
  if (entry.backgroundControls) { for (const el of entry.backgroundControls.querySelectorAll('*')) ui.display.unbind(el); ui.display.unbind(entry.backgroundControls); entry.backgroundControls.remove(); }
  entry.backgroundControls = null;
  if (!op || !summary && !card && !op.resultNotice) return;
  const box = node('div', undefined, `background-operation${card ? ' background-controls' : ''}`);
  entry.backgroundControls = box; entry.actions.before(box);
  if (batchRole?.anchor && !batchRole.open) { box.classList.add('background-batch'); renderConfirmationBatch(box, batchRole); return; }
  const line = node('p', undefined, 'background-line'), state = node('span', undefined, 'background-state'), sentence = node('span', undefined, 'background-sentence');
  const answered = card && !op.replacedBy && !op.disposition && op.answer;
  const stateKey = op.stateUiMessage?.key || (op.replacedBy ? 'background.card.void' : answered ? (op.answer === 'queued' ? 'background.card.queued' : 'background.card.answerRunning')
    : card ? 'background.card.waiting' : backgroundStates.includes(op.state) ? 'background.state.' + op.state : '');
  if (stateKey) ui.display.text(state, stateKey); else state.textContent = op.state;
  if (card && !answered && !op.replacedBy && !op.disposition && Number.isSafeInteger(op.expiresAt)) { state.dataset.expiresAt = String(op.expiresAt); backgroundRemaining(state); scheduleBackgroundExpiryClock(); }
  if (summary) ui.display.computed(sentence, 'text', () => backgroundSummaryText(summary));
  else if (card) sentence.textContent = question.options.message || '';
  line.append(state, sentence);
  if (summary || card) box.append(line);
  if (summary?.risks?.length) {
    const risks = node('ul', undefined, 'background-risks');
    for (const risk of summary.risks) risks.append(uiNode('li', 'background.risk.' + risk, undefined, `background-risk${risk === 'deletesSharedHistory' ? ' background-risk-delete' : ''}`));
    box.append(risks);
  }
  if (op.error && !card) box.append(node('p', op.error, 'background-error'));
  if (op.replacedBy) {
    const reason = node('p', undefined, 'background-note');
    ui.display.computed(reason, 'text', () => uiText('background.card.replaced.' + op.replacedBy.state, { time: backgroundClock(op.replacedBy.time) }));
    box.append(reason);
  } else if (card && op.repeated) {
    const note = node('p', undefined, 'background-note is-warning');
    ui.display.computed(note, 'text', () => uiText('background.card.repeated', { time: backgroundClock(op.repeated.time) }));
    box.append(note);
  }
  if (op.resultNotice) { const notice = node('p'); ui.display.text(notice, op.resultNotice.key, op.resultNotice.params); box.append(notice); }
  const raw = card ? question.options.detail : op.arguments;
  if (raw) {
    const details = node('details', undefined, 'background-details'), label = uiNode('summary', 'background.card.details');
    details.append(label, node('pre', raw)); box.append(details);
  }
  const mergedAway = batchRole && !batchRole.open;
  if (mergedAway) {
    const merged = node('p', undefined, 'background-note');
    ui.display.text(merged, 'background.batch.merged', { count: batchRole.batch.cards.length }); box.append(merged);
  }
  if (!card || op.replacedBy || op.disposition || answered || mergedAway) return;
  const buttons = node('div', undefined, 'background-buttons'), keys = backgroundButtonKeys(question.options, summary);
  question.options.buttons.forEach((label, response) => {
    const cancel = response === (question.options.cancelId ?? 0);
    const button = node('button', keys ? '' : label, cancel ? 'small' : 'small primary'); button.disabled = disconnected;
    if (keys) ui.display.text(button, response === 1 ? 'background.card.confirm' : keys[response]);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await api.backgroundDecision(op.sessionId, op.nativeId, op.id, response); }
      catch (error) { toastError(error); }
      finally { button.disabled = disconnected; }
    });
    buttons.append(button);
  });
  if (batchRole?.open && batchRole.anchor) {
    const collapse = node('button', '', 'small'); ui.display.text(collapse, 'background.batch.collapse'); collapse.disabled = disconnected;
    collapse.addEventListener('click', () => { confirmationBatchOpen.delete(batchRole.batch.key); render(); });
    buttons.append(collapse);
  }
  box.append(buttons);
}
function renderOperatorControls(entry, message, context = {}) {
  const clearCancel = () => { entry.operatorCancelWarning?.remove(); entry.operatorCancelWarning = null; entry.operatorCancelKey = ''; };
  const op = message.operator;
  if (!op) { clearCancel(); entry.operatorControls?.remove(); entry.operatorControls = null; entry.operatorKey = ''; entry.item.classList.toggle('operator-attention', false); return; }
  entry.item.classList.toggle('operator-attention', Boolean(!op.old && op.actionable && op.attention));
  const initiatorId = op.initiatorId || op.recipientId;
  const initiator = state.sessions.find(s => s.id === initiatorId);
  const allowed = Boolean(!disconnected && initiator && !initiator.archived && (initiator.serviceCapabilities || state.capabilities || []).includes('operatorControl1a'));
  const cancelKey = allowed && op.requestId && !op.old && (op.actionable || op.creation) && op.state !== 'closed'
    ? JSON.stringify([initiatorId, initiator.nativeId, op.requestId, op.version, context.passive === true]) : '';
  if (entry.operatorCancelKey !== cancelKey) clearCancel();
  // B5: who holds the grant, and whether it is revoked, can change without this card's own record changing.
  const grant = state.operatorPolicy?.domains.find(d => d.id === op.actual?.domainId);
  const key = JSON.stringify([op, allowed, disconnected, context.passive === true, state.sessions.map(s => [s.id, s.nativeId, s.archived, s.name]), grant ? [grant.initiators.map(i => i.id), Boolean(grant.revokedAt)] : null]);
  if (key === entry.operatorKey) return;
  entry.operatorKey = key;
  const controls = entry.operatorControls || node('div', undefined, 'operator-controls');
  if (!entry.operatorControls) { entry.operatorControls = controls; entry.actions.before(controls); }
  controls.replaceChildren();
  const clock = node('time'); clock.dateTime = new Date(message.time).toISOString();
  ui.display.computed(clock, 'text', () => new Date(message.time).toLocaleString(ui.language.getSnapshot().active, { hourCycle: 'h23' })); controls.append(clock);
  const act = (action, value) => {
    const current = state.sessions.find(s => s.id === initiatorId);
    if (disconnected || !current || current.archived || current.nativeId !== initiator.nativeId) throw uiError('error.operator.stale');
    return api.operatorAction(initiatorId, action, value);
  };
  const add = (key, fn, disabled = false) => { const control = uiButton(key, fn, 'small'); control.disabled = !allowed || disabled; controls.append(control); return control; };
  if (op.reportId) {
    controls.append(uiNode('span', 'operator.saved'));
    if (op.old) controls.append(uiNode('span', 'operator.old', { version: op.reportVersion }));
    if (op.reportQuestion && (!op.actionable || op.old)) controls.append(node('p', op.reportQuestion, 'operator-question'));
    if (op.turnAbnormal) controls.append(uiNode('p', 'operator.abnormal'));
    if (op.unread) { controls.append(uiNode('span', 'operator.unread', undefined, 'operator-unread')); add('operator.read', () => act('read', op.requestId)); }
  }
  if (op.creation) {
    controls.append(uiNode('span', 'operator.action', { id: op.actual.actionId }));
    controls.append(uiNode('strong', op.creation === 'created' && op.state === 'closed' ? 'operator.createdVoided' : 'operator.' + op.creation));
    // Words inside a label are read when it is painted, not when the card is drawn, so they follow a language switch.
    controls.append(uiNode('p', 'operator.nativeDefault', () => ({ model: op.actual.model === 'unknown' ? uiText('operator.unknown') : op.actual.model })));
    controls.append(uiNode('p', 'operator.permission', () => ({ permission: uiText('operator.' + op.actual.permission) })));
    if (op.actual.message) controls.append(node('pre', op.actual.message));
    // B5: a grant may name the one space its new sessions join. Names are read when painted, so they follow the language.
    const spaceLabel = id => { const room = allSpaces().find(room => room.id === id); return !room ? uiText('operator.spaceGone') : room.archived ? uiText('operator.spaceArchived', { name: spaceName(room) }) : spaceName(room); };
    // What the desktop did with the new session, as the journal that owns this action saved it.
    if (op.actual.space && op.actual.placement) {
      const placed = node('p'), reason = op.actual.placementError;
      const reasons = { 'space-unavailable': 'Space', 'session-unavailable': 'Session', 'initiator-archived': 'Initiator', 'moved-elsewhere': 'Moved', 'join-refused': 'Refused', 'grant-ended': 'GrantEnded' };
      ui.display.text(placed, op.actual.placement === 'pending' ? 'operator.placementPending' : op.actual.placement !== 'joined' ? 'operator.placementNotPlaced' : reason ? 'operator.placementJoinedUnrecorded' : 'operator.placementJoined',
        () => ({ space: spaceLabel(op.actual.space), reason: uiText('operator.placementReason' + (Object.hasOwn(reasons, reason) ? reasons[reason] : 'Other')) }));
      controls.append(placed);
    }
    const domain = state.operatorPolicy?.domains.find(d => d.id === op.actual.domainId);
    if (domain) {
      const summary = node('p');
      ui.display.text(summary, domain.space ? 'operator.grantSummarySpace' : 'operator.grantSummary',
        () => ({ id: domain.id, daily: domain.daily, concurrent: domain.concurrent, expires: new Date(domain.expiresAt).toLocaleString(), ...(domain.space ? { space: spaceLabel(domain.space) } : {}) }));
      controls.append(summary);
      // B5: after NAW replaced the session that held this grant, the card says which session holds it now.
      if (domain.carried?.length) {
        const holder = node('p');
        ui.display.text(holder, 'operator.grantHolder', () => ({ name: domain.initiators.map(i => state.sessions.find(s => s.id === i.id)?.name || uiText('operator.holderGone')).join(' / ') }));
        controls.append(holder);
      }
      add('operator.revokeDomain', () => act('revoke', domain.id), Boolean(domain.revokedAt));
    }
  }
  if (op.requestId && !op.old && (op.actionable || op.creation)) {
    controls.append(uiNode('span', 'operator.request', { id: op.requestId, version: op.version }));
    const params = op.state === 'attention' ? () => ({ reason: uiText('operator.' + op.reportState) }) : op.state === 'closed' ? () => ({ reason: uiText('operator.' + op.closedReason) }) : undefined;
    controls.append(uiNode('strong', 'operator.' + op.state, params));
    if (op.question) controls.append(node('p', op.question, 'operator-question'));
    if (op.cannotUpdate && op.state !== 'closed') controls.append(uiNode('p', 'operator.cannotUpdate'));
    controls.append(uiNode('span', op.state === 'closed' ? 'operator.voided' : 'operator.pending'));
    if (op.state !== 'closed') {
      add('operator.accept', () => act('close', { requestId: op.requestId, reason: 'accepted' }), op.reportState !== 'ready');
      add('operator.cancel', () => {
        if (!allowed || entry.operatorCancelWarning) return;
        const warning = node('div', undefined, 'operator-cancel-warning'); warning.append(uiNode('p', 'operator.cancelWarning'));
        const confirm = uiButton('operator.confirmCancel', async () => {
          if (entry.operatorCancelWarning !== warning || entry.operatorCancelKey !== cancelKey) throw uiError('error.operator.stale');
          confirm.disabled = true; try { await act('close', { requestId: op.requestId, reason: 'cancelled' }); } catch (error) { confirm.disabled = false; throw error; }
        }, 'small');
        const keep = uiButton('operator.keep', clearCancel, 'small'); warning.append(confirm, keep);
        // Keep this deliberate human choice outside status-only control repainting.
        entry.operatorCancelWarning = warning; entry.operatorCancelKey = cancelKey; entry.actions.before(warning); confirm.focus({ preventScroll: true });
      });
    }
  }
  if (op.executorId) {
    const executor = state.sessions.find(s => s.id === op.executorId);
    add('operator.openExecutor', async () => {
      const current = state.sessions.find(s => s.id === op.executorId);
      if (!current || current.nativeId !== executor.nativeId || current.archived) throw uiError('error.operator.stale');
      await select(current.id, 'chat');
      // Selecting/focusing is a human action; no text is inserted or sent.
      $('message-input').focus({ preventScroll: true });
    }, !executor || executor.archived);
  }
  if (op.creation === 'pending-authorization') {
    const form = node('form', undefined, 'operator-grant');
    const field = (key, type) => { const label = node('label'), input = node('input'); input.type = type; input.required = true; label.append(uiNode('span', key), input); form.append(label); return input; };
    const daily = field('operator.daily', 'number'), concurrent = field('operator.concurrent', 'number'), expires = field('operator.expires', 'datetime-local');
    for (const input of [daily, concurrent]) { input.min = '1'; input.step = '1'; }
    const permissions = node('select');
    for (const mode of ['default', 'bypass']) { const option = uiNode('option', 'operator.' + mode); option.value = mode; permissions.append(option); }
    permissions.value = op.args.permission; ui.display.attribute(permissions, 'aria-label', 'operator.permission', { permission: '' }); form.append(permissions);
    // B5: the one space sessions created under this grant join, chosen here by the person and by nobody else.
    // "None" is what a grant has always been. The consent sentence names the space, and a different choice is a
    // different consent, so it clears the tick.
    const spaceField = node('label'), space = node('select'), none = uiNode('option', 'operator.spaceNone'); none.value = ''; space.append(none);
    for (const room of allSpaces().filter(room => !room.archived)) {
      const option = node('option'); option.value = room.id; ui.display.text(option, 'operator.spaceOption', () => ({ name: spaceName(room) })); space.append(option);
    }
    space.value = ''; spaceField.append(uiNode('span', 'operator.space'), space); form.append(spaceField);
    const chosen = () => allSpaces().find(room => room.id === space.value && !room.archived);
    const consentLabel = node('label'), consent = node('input'), consentText = node('span'); consent.type = 'checkbox'; consent.required = true;
    const paintConsent = () => ui.display.text(consentText, space.value ? 'operator.grantConsentSpace' : 'operator.grantConsent', () => ({ space: chosen() ? spaceName(chosen()) : uiText('operator.spaceGone') }));
    paintConsent(); space.addEventListener('change', () => { consent.checked = false; paintConsent(); });
    consentLabel.append(consent, consentText); form.append(consentLabel);
    const submit = uiNode('button', 'operator.authorize'); submit.type = 'submit'; submit.disabled = !allowed; form.append(submit);
    const problem = node('p'); problem.setAttribute('role', 'alert'); form.append(problem);
    form.addEventListener('submit', event => {
      event.preventDefault();
      attempt(async () => {
        const count = Number(daily.value), live = Number(concurrent.value), until = new Date(expires.value).getTime();
        if (!consent.checked || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(live) || live < 1 || !Number.isSafeInteger(until) || until <= Date.now()) { ui.display.text(problem, 'operator.formInvalid'); return; }
        // The space must still be there when the grant is saved; otherwise the person chooses again.
        if (space.value && !chosen()) { consent.checked = false; ui.display.text(problem, 'operator.spaceUnavailable'); return; }
        if (!allowed) throw uiError('error.operator.stale'); submit.disabled = true;
        try {
          const domainId = await act('grant', { providers: [op.args.provider], directories: [op.args.cwd], permission: permissions.value, daily: count, concurrent: live, expiresAt: until,
            ...(space.value ? { space: space.value } : {}) });
          await act('authorize', { key: op.actionKey, domainId });
        } catch (error) { problem.textContent = ui.errorText(error); submit.disabled = false; }
      });
    });
    controls.append(form);
    add('operator.dismiss', () => act('dismiss', { key: op.actionKey }));
  }
}
const roomMenuKey = (id = spaceId) => JSON.stringify([id, selectionRevision, disconnected, spaceRecord(id)?.name, spaceRecord(id)?.archived]);
function openRoomMenu(point, anchor, id = spaceId) {
  const room = spaceRecord(id); anchor ||= spaceRows.get(id)?.more || $('room-more');
  contentMenu?.close(); if (!room || room.archived || disconnected || anchor.disabled) return;
  if (!point && roomMenu?.anchor === anchor) { roomMenu(); return; }
  roomMenu?.(); sessionMenu?.close(); anchor.focus(); anchor.setAttribute('aria-expanded', 'true');
  const key = roomMenuKey(id);
  roomMenu = ui.menu({
    items: [{ type: 'label', id: 'space-id', text: uiText('menu.spaceIdLabel', { id: room.id.slice(0, 8) }), labelRead: () => uiText('menu.spaceIdLabel', { id: room.id.slice(0, 8) }) }, { type: 'separator', id: 'space-id-separator' }, { id: 'copy-id', label: uiText('menu.copySpaceId'), labelKey: 'menu.copySpaceId' }, { id: 'create', label: uiText('menu.newSpace'), labelKey: 'menu.newSpace' }, { id: 'merge', label: uiText('menu.mergeSpaces'), labelKey: 'menu.mergeSpaces', disabled: allSpaces().filter(room => !room.archived).length < 2 }, ...(room.merge ? [{ id: 'merge-record', label: uiText('menu.mergeDetails'), labelKey: 'menu.mergeDetails' }] : []), { id: 'rename', label: uiText('menu.rename'), labelKey: 'menu.rename' }, { id: 'notes', label: uiText('menu.notes'), labelKey: 'menu.notes' }, { id: 'files', label: uiText('menu.spaceFiles'), labelKey: 'menu.spaceFiles' }, { id: 'usage', label: uiText('header.usage'), labelKey: 'header.usage' }, { id: 'about', label: uiText('menu.collaborationAbout'), labelKey: 'menu.collaborationAbout' }, ...(state.wakePolicy ? [{ id: 'wake-global', label: uiText(state.wakePolicy.enabled ? 'menu.wakeDisableAll' : 'menu.wakeEnableAll'), labelKey: state.wakePolicy.enabled ? 'menu.wakeDisableAll' : 'menu.wakeEnableAll' }] : []), ...(state.operatorPolicy ? [{ id: 'operator-global', label: uiText(state.operatorPolicy.enabled ? 'operator.disableAll' : 'operator.enableAll'), labelKey: state.operatorPolicy.enabled ? 'operator.disableAll' : 'operator.enableAll' }] : []), { id: 'archive', label: uiText('menu.archiveWorkspace'), labelKey: 'menu.archiveWorkspace' }],
    getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect(),
    onClose: () => { roomMenu = null; anchor.setAttribute('aria-expanded', 'false'); if (key === roomMenuKey(id) && anchor.isConnected && anchor.getClientRects().length && !anchor.disabled) anchor.focus({ preventScroll: true }); },
    onSelect: action => {
      if (key !== roomMenuKey(id)) return;
      if (action === 'create') openSpaceCreate();
      else if (action === 'copy-id') attempt(async () => { await api.copy(id); toastMessage('toast.copied'); });
      else if (action === 'merge') openSpaceMerge(id);
      else if (action === 'merge-record') attempt(() => openMergeRecord(id));
      else if (action === 'wake-global') attempt(() => api.wakePolicy(null, !state.wakePolicy?.enabled));
      else if (action === 'operator-global') attempt(() => setOperatorEnabled(null, !state.operatorPolicy?.enabled));
      else if (action === 'rename') openRename('room', anchor, id);
      else if (action === 'notes') openNotes(id);
      else if (action === 'files') attempt(async () => { await selectSpace(id); openSpaceFiles(); });
      else if (action === 'usage') attempt(() => showTrust({ usageScope: { kind: 'room', roomId: id, name: room.name } }));
      else if (action === 'about') toastMessage("toast.collaborationAbout");
      else if (action === 'archive') attempt(async () => { if (await api.spaceAction(id, 'archive', []) !== false) toastMessage("toast.workspaceArchived"); });
    },
  });
  roomMenu.key = key; roomMenu.anchor = anchor; roomMenu.roomId = id;
}
// Facts refresh in place while the menu is open; a changed action list or order closes it, because
// onSelect acts on the neighbours and memberships captured when it opened.
function sessionChainTime(time) {
  return Number.isFinite(time) ? new Date(time).toLocaleString(ui.language.getSnapshot().active, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : uiText('time.unrecorded');
}
let sessionChainId = null;
function openSessionChain(id) {
  if (!sessionChainModel(id)) return;
  sessionChainId = id;
  $('session-chain-list').dataset.signature = '';
  renderSessionChain(); openTransientDialog('session-chain-dialog');
}
async function openSessionChainSegment(id) {
  if (!state.sessions.some(s => s.id === id)) return;
  $('session-chain-dialog').close();
  // Same read-only navigation as search: an archive is not restored or resumed.
  await select(id, 'chat');
}
function renderSessionChain() {
  if (!sessionChainId) return;
  const model = sessionChainModel(sessionChainId), list = $('session-chain-list');
  const signature = JSON.stringify(model && [model.currentIds, model.sessions.map(link => [link.id, link.name, link.startedAt, link.successors, link.continuedAt, link.record?.state, link.record?.archived])]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('[data-session-id]')?.dataset.sessionId : null;
  const rows = (model?.sessions || []).map(link => {
    const row = node('li', undefined, 'session-chain-row'); row.dataset.sessionId = link.id;
    const name = button('', () => openSessionChainSegment(link.id), 'session-chain-name'); name.disabled = !link.record;
    ui.display.computed(name, 'text', () => archivedName(link.record, link.name));
    if (model.currentIds.includes(link.id)) name.setAttribute('aria-current', 'true');
    const detail = node('small');
    ui.display.computed(detail, 'text', () => [
      uiText('chain.range', { start: sessionChainTime(link.startedAt), end: link.successors.length ? link.successors.map(edge => sessionChainTime(edge.time)).join(' / ') : uiText('chain.present') }),
      link.record ? [link.record.archived ? uiText('chain.archived') : '', stateText(link.record)].filter(Boolean).join(' · ') : uiText('state.unknown'),
      model.currentIds.includes(link.id) ? uiText('chain.current') : '',
      link.continuedAt === null ? '' : uiText('chain.continued', { time: sessionChainTime(link.continuedAt) }),
    ].filter(Boolean).join(' · '));
    row.append(name, detail); return row;
  });
  list.replaceChildren(...rows);
  if (focusedId) rows.find(row => row.dataset.sessionId === focusedId)?.querySelector('button')?.focus({ preventScroll: true });
}
function renderSessionHandoff(binding, s) {
  const model = s && sessionChainModel(s.id), link = model?.sessions.find(link => link.id === s.id);
  if (!link?.successors.length) { if (binding.chainNotice) binding.chainNotice.hidden = true; return; }
  if (!binding.chainNotice) {
    binding.chainNotice = node('div', undefined, 'session-chain-notice');
    binding.ui.form.prepend(binding.chainNotice);
  }
  const notice = binding.chainNotice; notice.hidden = false;
  const signature = JSON.stringify([link.continuedAt, link.successors, model.sessions.map(s => [s.id, s.name, Boolean(s.record), Boolean(s.record?.archived)])]);
  if (notice.dataset.signature === signature) return;
  notice.dataset.signature = signature;
  const text = node('span');
  const successor = id => { const next = model.sessions.find(s => s.id === id); return next ? archivedName(next.record, next.name) : id; };
  ui.display.computed(text, 'text', () => uiText('chain.handedTo', { name: link.successors.map(edge => successor(edge.id)).join(' / ') }) +
    (link.continuedAt === null ? '' : ' · ' + uiText('chain.continued', { time: sessionChainTime(link.continuedAt) })));
  const jumps = link.successors.map(edge => {
    const next = model.sessions.find(s => s.id === edge.id);
    const jump = uiButton('chain.openNext', () => openSessionChainSegment(edge.id), 'small', () => ({ name: successor(edge.id) }));
    jump.disabled = !next?.record; return jump;
  });
  const focused = notice.contains(document.activeElement) ? [...notice.children].indexOf(document.activeElement) : -1;
  notice.replaceChildren(text, ...jumps);
  if (focused > 0) notice.children[focused]?.focus({ preventScroll: true });
}
// 「接自「X」· 共 N 段」 beside a standalone session's title; the first segment has nothing before it and shows none.
function renderSessionChainChip(s) {
  const chip = $('session-chain-chip'), origin = s ? sessionChainOrigin(s.id) : null;
  chip.hidden = !origin; chip.dataset.sessionId = origin ? s.id : '';
  if (!origin) return;
  const names = () => origin.previous.map(link => archivedName(link.record, link.name)).join(' / ');
  ui.display.computed(chip, 'text', () => uiText('chain.from', { name: names(), count: origin.count }));
  ui.display.attribute(chip, 'title', 'chain.menu', { count: origin.count });
}
async function archiveChainSession(id) {
  const others = sessionChainModel(id)?.sessions.filter(link => link.id !== id) || [];
  await api.archiveSession(id);
  // Read the archived flags when the notice paints: the segments archived before this one carry the marker.
  if (others.length) toastMessage('chain.archiveNotice', () => ({ names: others.map(link => archivedName(state.sessions.find(s => s.id === link.id), link.name)).join(' / ') }));
  else toastMessage('toast.sessionArchived');
}
function sessionMenuModel(id, row) {
  const record = state.sessions.find(s => s.id === id), group = row.spaceId;
  const visible = group ? orderedMembers(group) : sidebarSessions(), index = visible.findIndex(s => s.id === id);
  const isSteward = state.steward?.sessionId === id;
  const roomItems = isSteward && !window.nativeWorkspaceSpaces.roomIds(record).length ? [] : allSpaces().filter(r => !r.archived).map(r => ({ id: `membership:${r.id}`, label: uiText(inSpace(record, r.id) ? 'menu.leaveSpace' : 'menu.joinSpace', { name: spaceName(r) }), labelKey: inSpace(record, r.id) ? 'menu.leaveSpace' : 'menu.joinSpace', labelParams: { name: spaceName(r) } }));
  // Right under the version fact that says this backend is older (T-131).
  const update = backendVersionNotice(record, state.appVersion)?.kind === 'old' && !record.archived ? [{ id: 'update-backend', label: uiText('menu.updateThisBackend'), labelKey: 'menu.updateThisBackend' }] : [];
  const chain = sessionChainModel(id);
  if (chain) update.push({ id: 'session-chain', label: uiText('chain.menu', { count: chain.sessions.length }), labelKey: 'chain.menu', labelParams: { count: chain.sessions.length } });
  const secretaryKey = state.queueSecretary?.sessionId === id ? 'menu.queueSecretaryRevoke' : 'menu.queueSecretarySet';
  const secretary = typeof api.queueSecretary === 'function' && (state.queueSecretary?.sessionId === id || record.nativeId && !record.archived)
    ? [{ id: state.queueSecretary?.sessionId === id ? 'queue-secretary-revoke' : 'queue-secretary-set', label: uiText(secretaryKey), labelKey: secretaryKey }] : [];
  const actions = [...update, ...stewardAction(record), ...secretary, ...integratorAction(record), { id: 'rename', label: uiText('menu.rename'), labelKey: 'menu.rename' }, ...(index > 0 ? [{ id: 'up', label: uiText('menu.moveUp'), labelKey: 'menu.moveUp' }] : []), ...(index >= 0 && index < visible.length - 1 ? [{ id: 'down', label: uiText('menu.moveDown'), labelKey: 'menu.moveDown' }] : []), { id: 'copy-id', label: uiText('menu.copyNawId'), labelKey: 'menu.copyNawId' }, ...(record.nativeId ? [{ id: 'copy-native-id', label: uiText('menu.copyNativeId'), labelKey: 'menu.copyNativeId' }] : []), ...roomItems, { id: 'window', label: uiText('menu.separateWindow'), labelKey: 'menu.separateWindow' }, ...((record.serviceCapabilities || state.capabilities || []).includes('agentWakeV1') ? [{ id: 'wake-session', label: uiText(record.wakeDisabled ? 'menu.wakeAllow' : 'menu.wakeDisallow'), labelKey: record.wakeDisabled ? 'menu.wakeAllow' : 'menu.wakeDisallow' }] : []), ...((record.serviceCapabilities || state.capabilities || []).includes('operatorControl1a') && record.provider === 'claude' ? [{ id: 'operator-session', label: uiText(record.operatorEnabled ? 'operator.disableSession' : 'operator.enableSession'), labelKey: record.operatorEnabled ? 'operator.disableSession' : 'operator.enableSession' }, { id: 'operator-revoke', label: uiText('operator.revokeGrants'), labelKey: 'operator.revokeGrants' }] : []), ...((record.serviceCapabilities || state.capabilities || []).includes('observe') ? [] : [{ id: 'continue', label: uiText('menu.refreshConnection'), labelKey: 'menu.refreshConnection' }]), { id: 'archive', label: uiText('menu.archiveSession'), labelKey: 'menu.archiveSession' }].map(item => ({ ...item, disabled: disconnected || item.disabled }));
  return { record, group, visible, index, actionsKey: JSON.stringify([actions.map(({ label, ...action }) => action.labelKey ? action : { ...action, label }), visible.map(s => s.id)]),
    items: [...sidebarDetails(record).map((text, index) => ({ type: 'label', id: 'session-fact-' + index, text, labelRead: () => sidebarDetails(record)[index] })), { type: 'separator', id: 'session-facts-actions' }, ...actions] };
}
async function chooseQueueSecretary(id) {
  await api.queueSecretary(id);
  updateState(await api.initial());
  render();
}
// The butler the person talks to is one session outside every space. Designating is offered where it can be done;
// changing and revoking are offered on the session that holds the designation, wherever it is now.
function stewardAction(record) {
  if (typeof api.steward !== 'function' || !record) return [];
  if (state.steward?.sessionId === record.id) return [...(typeof api.stewardRecord === 'function' && stewardSteps ? [{ id: 'steward-record', label: uiText('menu.stewardRecord'), labelKey: 'menu.stewardRecord' }] : []), { id: 'steward-change', label: uiText('menu.stewardChange'), labelKey: 'menu.stewardChange' }, { id: 'steward-revoke', label: uiText('menu.stewardRevoke'), labelKey: 'menu.stewardRevoke' }];
  if (!record.nativeId || record.archived || window.nativeWorkspaceSpaces.roomIds(record).length) return [];
  return [{ id: 'steward-set', label: uiText('menu.stewardSet'), labelKey: 'menu.stewardSet' }];
}
// Designating goes through the chooser, which shows the duty statement it sends; revoking is one step.
async function revokeSteward(id) {
  // A menu opened before the designation moved must not revoke somebody else's.
  if (state.steward?.sessionId !== id) return;
  await api.steward(null);
  updateState(await api.initial());
  render();
}
// Every unarchived session, the butler first, each with why it cannot be chosen when it cannot.
function stewardCandidates() {
  const butler = stewardRecord();
  return [...(butler ? [butler] : []), ...sidebarSessions()].map(record => {
    const space = window.nativeWorkspaceSpaces.roomIds(record).map(id => spaceRecord(id)).find(Boolean) || null;
    const reason = window.nativeWorkspaceSpaces.roomIds(record).length ? 'inSpace' : !record.nativeId || record.nativeContextPending || ['ended', 'background'].includes(record.state) ? 'unusable' : '';
    return { record, space, reason, current: record === butler };
  });
}
let stewardChoice = '';
function renderStewardChooser() {
  const list = $('steward-list'), candidates = stewardCandidates();
  if (!candidates.some(item => item.record.id === stewardChoice && !item.reason)) stewardChoice = '';
  const held = document.activeElement?.name === 'steward-choice' ? document.activeElement.value : '';
  list.replaceChildren(...candidates.map(({ record, space, reason, current }) => {
    const row = node('label', undefined, 'steward-pick' + (reason ? ' unavailable' : '')), radio = node('input'), text = node('span'), name = node('strong', record.name), note = node('small');
    radio.type = 'radio'; radio.name = 'steward-choice'; radio.value = record.id; radio.disabled = Boolean(reason) || disconnected; radio.checked = record.id === stewardChoice;
    radio.onchange = () => { stewardChoice = record.id; renderStewardChooser(); };
    if (reason === 'inSpace') ui.display.computed(note, 'text', () => uiText('steward.choose.inSpace', { space: space ? spaceName(space) : '' }));
    else if (reason) ui.display.text(note, 'steward.choose.unusable');
    else if (current) ui.display.text(note, 'steward.choose.current');
    else ui.display.computed(note, 'text', () => sidebarPresentation(record).compact);
    text.append(name, note); const mark = icon(record); mark.setAttribute('role', 'img');
    ui.display.computed(mark, 'title', () => makerLabel(record)); ui.display.computed(mark, 'aria-label', () => makerLabel(record)); row.append(radio, mark, text); return row;
  }));
  if (held) [...list.querySelectorAll('input')].find(input => input.value === held && !input.disabled)?.focus({ preventScroll: true });
  $('steward-none').hidden = candidates.some(item => !item.reason);
  // Nobody to choose, nothing to send.
  $('steward-duty').hidden = $('steward-duty-label').hidden = !$('steward-none').hidden;
  // Confirming the session that already is the butler sends it the duty statement again, and says so.
  $('steward-confirm').disabled = disconnected || !stewardChoice;
  ui.display.text($('steward-confirm'), stewardChoice && stewardChoice === state.steward?.sessionId ? 'steward.choose.resend' : 'steward.choose.confirm');
}
// From the entry or the butler's menu with the butler chosen; from a session's menu with that session chosen.
function openStewardChooser(chosen = null) {
  if (disconnected || typeof api.steward !== 'function' || $('steward-dialog').open) return;
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  stewardChoice = chosen || stewardRecord()?.id || ''; $('steward-error').hidden = true;
  // The text the person last chose, or the default of their language; their edits stay while the dialog is open.
  $('steward-duty').value = state.stewardDuty ?? uiText('steward.duty.default');
  renderStewardChooser(); openTransientDialog('steward-dialog');
  // From its first line, wherever the box was scrolled the last time the dialog was open.
  $('steward-duty').scrollTop = 0;
  ([...$('steward-list').querySelectorAll('input')].find(input => input.checked && !input.disabled) || $('steward-cancel')).focus({ preventScroll: true });
}
async function confirmSteward() {
  const id = stewardChoice, ticket = dialogTickets.get($('steward-dialog'));
  if (!id || disconnected) return;
  $('steward-confirm').disabled = true;
  // The default text unchanged is kept as "the default", so it follows the person's language.
  const text = $('steward-duty').value, duty = text === uiText('steward.duty.default') ? null : text;
  try {
    const result = await api.steward(id, duty);
    updateState(await api.initial());
    // Designated, but the duty statement did not go in: the dialog stays open and says why.
    // Dismissed meanwhile: said once in the toast instead.
    if (result?.duty?.state === 'not-sent') {
      const reason = result.duty.error || {}, params = () => ({ reason: ui.errorText(reason) });
      if (!currentDialogTicket(ticket)) { toastMessage('steward.duty.notSent', params); return; }
      ui.display.computed($('steward-error'), 'text', () => uiText('steward.duty.notSent', params()));
      $('steward-error').hidden = false; renderStewardChooser(); return;
    }
    // The person chose it from a list: show what they chose. Not if they have dismissed the chooser and moved on.
    if (currentDialogTicket(ticket)) { $('steward-dialog').close(); await select(id); }
  } catch (error) {
    if (!currentDialogTicket(ticket)) throw error;
    ui.showError($('steward-error'), error); $('steward-error').hidden = false; renderStewardChooser();
  }
}
// The integrator is one session outside every space (B6). Designating is offered only where it can
// be done; revoking is offered on the session that holds the designation, wherever it is now.
function integratorAction(record) {
  if (typeof api.integrator !== 'function' || !record) return [];
  const chosen = state.integrator?.sessionId === record.id;
  if (!chosen && (!record.nativeId || record.archived || window.nativeWorkspaceSpaces.roomIds(record).length)) return [];
  const labelKey = chosen ? 'menu.integratorRevoke' : 'menu.integratorSet';
  return [{ id: chosen ? 'integrator-revoke' : 'integrator-set', label: uiText(labelKey), labelKey }];
}
async function chooseIntegrator(id, revoke) {
  // A menu opened before the designation moved must not revoke somebody else's.
  if (revoke && state.integrator?.sessionId !== id) return;
  await api.integrator(revoke ? null : id);
  updateState(await api.initial());
  render();
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
    // Where ⋯ is not drawn (the collapsed rail, Shift+F10), the row's own button is the anchor instead of the window corner.
    getAnchorRect: () => { if (point) return { left: point.x, right: point.x, top: point.y, bottom: point.y }; let box = row.more.getBoundingClientRect(); if (!box.width && !box.height && row.link) box = row.link.getBoundingClientRect(); return { left: box.right, right: box.right, top: box.top, bottom: box.bottom, width: 0, height: box.height }; },
    onClose: () => { sessionMenu = null; row.more.setAttribute('aria-expanded', 'false'); if (row.more.isConnected && row.more.getClientRects().length) row.more.focus({ preventScroll: true }); else focusSessionAction(id); },
    onSelect: action => {
      if (disconnected || !state.sessions.some(s => s.id === id)) return;
      if (action.startsWith('membership:')) {
        const destination = action.slice(11), person = state.sessions.find(s => s.id === id);
        attempt(() => inSpace(person, destination) ? detach(id, destination) : addToSpace(id, destination));
      } else if (action === 'queue-secretary-set' || action === 'queue-secretary-revoke') attempt(() => chooseQueueSecretary(action === 'queue-secretary-revoke' ? null : id));
      else if (action === 'integrator-set' || action === 'integrator-revoke') attempt(() => chooseIntegrator(id, action === 'integrator-revoke'));
      else if (action === 'steward-set') openStewardChooser(id);
      else if (action === 'steward-revoke') attempt(() => revokeSteward(id));
      else if (action === 'steward-change') openStewardChooser();
      else if (action === 'steward-record') stewardSteps?.open();
      else if (action === 'wake-session') attempt(() => api.wakePolicy(id, Boolean(state.sessions.find(s => s.id === id)?.wakeDisabled)));
      else if (action === 'operator-session') attempt(() => setOperatorEnabled(id, !state.sessions.find(s => s.id === id)?.operatorEnabled));
      else if (action === 'operator-revoke') attempt(async () => { for (const domain of state.operatorPolicy?.domains || []) if (!domain.revokedAt && (domain.initiators.some(i => i.id === id) || domain.carried?.some(c => c.from.id === id))) await api.operatorAction(id, 'revoke', domain.id); toastMessage('operator.disabledNote'); });
      else if (action === 'update-backend') attempt(() => updateSessionBackend(id));
      else if (action === 'up' || action === 'down') attempt(() => group ? moveRoomMember(id, action === 'up' ? visible[index - 1]?.id : visible[index + 1]?.id, action === 'down', group) : moveSidebarSession(id, action === 'up' ? visible[index - 1]?.id : visible[index + 1]?.id, action === 'down'));
      else if (action === 'copy-id' || action === 'copy-native-id') attempt(() => api.copy(action === 'copy-id' ? id : state.sessions.find(s => s.id === id)?.nativeId));
      else if (action === 'rename') openRename(id, row.more);
      else if (action === 'continue') attempt(() => api.continueConnection(id));
      else if (action === 'window') attempt(() => api.newWindow(id));
      else if (action === 'session-chain') openSessionChain(id);
      else if (action === 'archive') attempt(() => archiveChainSession(id));
    },
  });
  sessionMenu = { id, rowKey, row, close, kind: 'session', factsKey: sidebarFactsKey(record), actionsKey: model.actionsKey };
}

function memberMenuKey(id) {
  const record = members().find(s => s.id === id);
  return selected === 'room' && !disconnected && !state.room.archived && record
    ? JSON.stringify([selectionRevision, roomSurface, roomSession, id, spaceId, pairRevision(record), record.nativeId, record.archived, state.queueSecretary]) : null;
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
      ...(typeof api.queueSecretary === 'function' && members().find(s => s.id === id)?.nativeId ? [{ id: state.queueSecretary?.sessionId === id ? 'queue-secretary-revoke' : 'queue-secretary-set', label: uiText(state.queueSecretary?.sessionId === id ? 'menu.queueSecretaryRevoke' : 'menu.queueSecretarySet'), labelKey: state.queueSecretary?.sessionId === id ? 'menu.queueSecretaryRevoke' : 'menu.queueSecretarySet' }] : []),
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
      else if (action === 'queue-secretary-set' || action === 'queue-secretary-revoke') attempt(() => chooseQueueSecretary(action === 'queue-secretary-revoke' ? null : id));
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
// A member is identified where its content is shown; menus below only choose spaces or independent sessions.
function spaceMemberLabel(record, people = orderedMembers()) {
  const prefix = typeof state.room?.name === 'string' ? state.room.name + ' · ' : '';
  const short = person => prefix && person.name.startsWith(prefix) && person.name.slice(prefix.length).trim() ? person.name.slice(prefix.length) : person.name;
  const name = short(record);
  return people.some(person => person.id !== record.id && short(person) === name) ? participantLabel(record, people) : name;
}
function independentNavigationSessions() {
  return sidebarSessions().filter(record => !allSpaces().some(room => !room.archived && inSpace(record, room.id)));
}
function openSpaceNavigation(kind, anchor) {
  if (spaceNavigationMenu) { spaceNavigationMenu(); return; }
  const rooms = () => allSpaces().filter(room => !room.archived);
  const rows = kind === 'spaces' ? rooms().map(room => ({ id: room.id, label: uiText('navigation.spaceItem', { name: spaceName(room), count: members(room.id).length }) }))
    : independentNavigationSessions().map(record => ({ id: record.id, label: participantLabel(record, state.sessions) + ' · ' + sidebarPresentation(record).full }));
  const items = rows.length ? rows : [{ id: 'empty', label: uiText(kind === 'spaces' ? 'sidebar.noSpaces' : 'navigation.noIndependent'), disabled: true }];
  anchor.setAttribute('aria-expanded', 'true');
  spaceNavigationMenu = ui.menu({ items, getAnchorRect: () => anchor.getBoundingClientRect(), onClose: () => {
    spaceNavigationMenu = null; anchor.setAttribute('aria-expanded', 'false');
    if (anchor.isConnected && anchor.getClientRects().length) anchor.focus({ preventScroll: true });
  }, onSelect: id => {
    if (kind === 'spaces' ? !rooms().some(room => room.id === id) : !independentNavigationSessions().some(record => record.id === id)) { toastMessage('navigation.changed'); return; }
    attempt(() => kind === 'spaces' ? selectSpace(id) : select(id));
  } });
}
function renderSpaceRail() {
  const active = selected === 'room', surface = $('sidebar-toggle').closest('.naw[data-native-surface="sidebar"]');
  $('space-rail-routes').hidden = !active;
  $('switch-space').hidden = !active || Boolean(focusedRoomMember());
  if (!surface) return;
  const collapsed = surface.dataset.collapsed === 'true';
  if (active && spaceRailBefore === null) { spaceRailBefore = collapsed; if (!collapsed) ui.toggleSidebar(); }
  else if (!active && spaceRailBefore !== null) { const before = spaceRailBefore; spaceRailBefore = null; if (before !== collapsed) ui.toggleSidebar(); }
}
// Every unarchived session but the butler the person talks to, which has its own place above the lists.
function sidebarSessions() {
  const ranks = new Map((state.sidebar?.order || []).map((id, index) => [id, index])), butler = state.steward?.sessionId;
  return state.sessions.filter(s => !s.archived && s.id !== butler).sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}
// The session the person designated as the butler they talk to, when it is one of the unarchived sessions.
function stewardRecord() {
  const id = state?.steward?.sessionId;
  return id ? state.sessions.find(s => s.id === id && !s.archived) || null : null;
}
// The entry's place when nobody is designated: it says so there, and opens the chooser. With a butler, its own row
// stands in the slot. Drawing it asks the main process nothing.
function renderStewardEntry(butler) {
  const empty = $('steward-empty');
  empty.hidden = Boolean(butler); empty.disabled = disconnected;
  if ($('steward-dialog').open) renderStewardChooser();
}
// U22: the listed sessions whose name another listed session also has. Their rows show the
// short id beside the name; a unique name stays without it. One session shown under two spaces
// in the grouped view is still one session.
function sameNameSessions(sessions) {
  const count = new Map();
  for (const session of sessions) count.set(session.name, (count.get(session.name) || 0) + 1);
  return new Set(sessions.filter(session => count.get(session.name) > 1).map(session => session.id));
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
  const result = { old: 0, oldEnded: 0, ended: 0, different: 0, unknown: 0, count: 0, label: '' };
  for (const record of unique.values()) {
    const notice = backendVersionNotice(record, applicationVersion);
    if (notice) {
      result[notice.kind]++; result.count++;
      if (record.state === 'ended') { result.ended++; if (notice.kind === 'old') result.oldEnded++; }
    }
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
  const goal = window.nativeWorkspaceFleet.goalStatus(record, !disconnected, uiText), goalSuffix = goal.text ? ' · ' + goal.text : '';
  const waiting = Boolean(record.approval || record.approvalOverflow || record.claudeQuestion || record.nativeApproval?.requests?.length || record.nativeInputRequired);
  const question = Boolean(record.claudeQuestion || record.approval?.method === 'item/tool/requestUserInput');
  const reported = record.state === 'idle' && (work.count > 0 || work.unconfirmed);
  let base = switchedAway(record) ? uiText('state.switched') : (facts.rootState || facts.state);
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
  const marker = tone === 'approval' || tone === 'disconnected' ? '!' : tone === 'working' || childTone === 'bg-work' ? '…' : childTone === 'goal-stopped' ? '!' : childTone === 'bg-unknown' ? '◌' : '○';
  return { compact: compact + goalSuffix, full: full + goalSuffix, tone, workTone: childTone, marker,
    detail: Boolean(goal.text || waiting || childrenActive || reported || recovery || !['idle', 'working', 'starting'].includes(record.state) || !live || record.nativeContextPending || record.nativeInputRequired) };
}
function sidebarDetails(record) {
  const memberships = allSpaces().filter(room => !room.archived && inSpace(record, room.id));
  const notice = backendVersionNotice(record, state.appVersion), provider = providerName(record.provider);
  return [record.name, provider, 'NAW ' + record.id, provider + ' ' + (record.nativeId || uiText('advanced.establishing')), sidebarPresentation(record).full,
    memberships.length ? uiText('sidebar.membershipFacts', { names: memberships.map(room => spaceName(room)).join('、') }) : uiText('sidebar.independent'), sessionTimes(record),
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
      items: [{ type: 'label', labelRead: () => backendMigrationSummary(settings) },
        { type: 'label', labelKey: 'version.migrationHelp' }, ...options.map((option, index) => ({ id: String(index), labelRead: () => backendOptionLabel(option) })),
        ...(interrupted ? [{ id: 'interrupted', labelRead: interrupted }] : []),
        { id: 'auto', label: uiText(settings.auto ? 'version.autoOn' : 'version.autoOff'), labelKey: settings.auto ? 'version.autoOn' : 'version.autoOff' },
        { id: 'migrate', label: uiText(settings.migrate ? 'version.migrateOn' : 'version.migrateOff'), labelKey: settings.migrate ? 'version.migrateOn' : 'version.migrateOff' }],
      getAnchorRect: () => control.getBoundingClientRect(),
      onClose: () => { backendVersionMenu = null; if (revision === selectionRevision && control.isConnected && !control.hidden) control.focus({ preventScroll: true }); },
      onSelect: key => {
        if (ticket !== backendVersionTicket) return;
        if (key === 'interrupted') return toastMessage('version.interruptedSessions', { names: settings.interrupted.join('、') });
        if (key === 'auto') return attempt(async () => { const next = await api.backendSwitchSettings(!settings.auto); toastMessage(next.auto ? 'toast.autoBackendOn' : 'toast.autoBackendOff'); });
        if (key === 'migrate') return attempt(async () => { const next = await api.backendSwitchSettings(undefined, !settings.migrate); toastMessage(next.migrate ? 'toast.migrateOn' : 'toast.migrateOff'); });
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
  return uiText('version.connectionOption', { version: option.version ? compactAppVersion(option.version) : uiText('version.kindUnknown'), action: uiText(option.ready ? 'version.updateAction' : option.switch?.ready ? 'version.endUpdateAction' : 'version.keepAction'), count: option.count, who, reason: backendOptionReason(option) });
}
function backendMigrationSummary(settings) {
  const summary = backendVersionSummary(state.sessions || [], state.appVersion);
  const status = uiText(settings.migrate === true ? 'version.migrationOn' : settings.migrate === false ? 'version.migrationOff' : 'version.migrationUnknown');
  return uiText('version.recordsSummary', { count: summary.count, ended: summary.ended, status });
}
function backendOptionReason(option) {
  const plan = option.switch?.reason && !option.switch.auto ? option.switch : option;
  const message = window.nativeWorkspaceLocale.displayMessage(plan.reasonUiMessage);
  const valid = message && ['zh', 'en'].some(language => window.nativeWorkspaceLocale.format(language, message.key, message.params) === plan.reason);
  const keys = {
    'error.planProcessMayRun': 'version.reasonProcess', 'error.planWorking': 'version.reasonWorking',
    'error.planBackgroundRunning': 'version.reasonWorking', 'error.planScheduledWork': 'version.reasonWorking',
    'error.planInputUnreported': 'version.reasonInput', 'error.planTerminalInput': 'version.reasonInput',
    'error.planCurrentChildren': 'version.reasonChildren', 'error.planEarlierChildren': 'version.reasonChildren',
    'error.planTeamUnconfirmed': 'version.reasonChildren', 'error.planOldBackend': 'version.reasonBackend',
    'error.planPendingApproval': 'version.reasonApproval', 'error.planPendingQuestion': 'version.reasonApproval',
    'error.planStorageWarning': 'version.reasonStorage',
  };
  const reasons = new Set();
  const visit = value => {
    if (value.cause) visit(value.cause);
    else if (value.parts) for (const part of value.parts) { if (part.uiMessage) visit(part.uiMessage); else reasons.add('version.reasonCheck'); }
    else reasons.add(keys[value.key] || 'version.reasonState');
  };
  if (valid) visit(message);
  else if (!option.ready) reasons.add('version.reasonCheck');
  return reasons.size ? ' · ' + [...reasons].map(key => uiText(key)).join(' / ') : '';
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
  const backend = result.backend ? { version: result.backend.version, names: result.backend.sessions.map(s => state.sessions?.find(record => record.id === s.id)?.name || s.name || s.id).join('、') } : null;
  if (result.error) return uiText(backend ? 'version.endedBackendFailed' : 'version.autoFailed', { ...backend, error: ui.displayText(result.error, result.errorUiMessage) });
  const left = Array.isArray(result.left) ? result.left.length : Number(result.left) || 0;
  const reconnect = result.reconnectFailed ? uiText('version.reconnectWindowFailed') : '';
  if (backend) return uiText('version.updatedEndedBackend', backend) + reconnect;
  return uiText(left ? 'version.updatedSomeLeft' : 'version.updatedAll', { count: left }) + reconnect;
}
$('backend-version-summary').onclick = () => attempt(openBackendVersions);
$('backend-version-summary').addEventListener('keydown', event => { if (event.key === 'Escape') { backendVersionTicket++; backendVersionMenu?.(); } });
function sessionShortId(id) {
  let length = Math.min(6, id.length);
  while (length < id.length && state.sessions.some(s => s.id !== id && s.id.startsWith(id.slice(0, length)))) length++;
  return id.slice(0, length);
}
// The program a session runs, as its short name in labels.
function providerName(provider) {
  if (provider === 'claude') return 'Claude';
  if (provider === 'dsh') return 'DSH';
  return 'Codex';
}
async function moveSidebarSession(id, target, after) {
  if (!target || id === target) return;
  await api.sidebar({ type: 'move', id, target, after });
}
function renderSidebarGroups() {
  const spaceView = selected === 'room', grouped = sidebarView === 'grouped', count = allSpaces().filter(r => !r.archived).length;
  $('sessions-group').hidden = spaceView;
  $('workspace-group').hidden = spaceView || grouped && renameTarget?.id !== 'room';
  document.querySelector('.session-view-switch').hidden = spaceView;
  $('workspace-group').dataset.groupedSessions = String(grouped);
  const createSlot = $(grouped ? 'sessions-create-slot' : 'workspace-create-slot');
  if ($('new-space').parentElement !== createSlot) createSlot.append($('new-space'));
  const discoveryGroup = $(grouped ? 'sessions-group' : 'workspace-group');
  if ($('space-discovery').parentElement !== discoveryGroup) discoveryGroup.insertBefore($('space-discovery'), discoveryGroup.querySelector('.sidebar-group-body'));
  $('space-discovery').hidden = Boolean(count) || Boolean(state.sidebar?.[grouped ? 'sessionsCollapsed' : 'workspaceCollapsed']);
  ui.display.text($('session-group-label'), grouped ? 'sidebar.spaces' : 'sidebar.sessions');
  const visible = state.sessions.filter(s => !s.archived && s.id !== state.steward?.sessionId);
  const working = visible.filter(s => s.state === 'working').length;
  ui.display.computed($('session-group-summary'), 'text', () => grouped ? String(count) : working ? uiText('sidebar.workingCount', { count: visible.length, working }) : String(visible.length));
  ui.display.computed($('workspace-group-summary'), 'text', () => state.room.archived ? '0' : uiText('sidebar.memberCount', { count: members().length }));
  // The drop hint counts toward the section's fixed height, so it is shown or hidden before the layout measures (T-136).
  document.querySelector('.drop-hint').hidden = spaceView || !allSpaces().some(r => !r.archived);
  for (const [section, control, body] of [['sessions', 'solo-drop', 'session-list'], ['workspace', 'workspace-toggle', 'workspace-group-body'], ['archive', 'archive-button', 'archive-group-body']]) {
    const collapsed = section === 'archive' ? state.sidebar?.archiveCollapsed !== false : Boolean(state.sidebar?.[section + 'Collapsed']), toggle = $(control);
    const name = () => uiText({ sessions: grouped ? 'sidebar.spaces' : 'sidebar.sessions', workspace: 'sidebar.spaces', archive: 'sidebar.archive' }[section]);
    ui.display.computed(toggle, 'aria-label', () => section === 'archive' ? uiText('sidebar.archiveAria', { count: state.sessions.filter(s => s.archived).length + Number(Boolean(state.room.archived)) }) : uiText('sidebar.groupAria', { name: name(), summary: section === 'sessions' ? grouped ? String(count) : working ? uiText('sidebar.workingCount', { count: visible.length, working }) : String(visible.length) : uiText('sidebar.spaceCount', { count: allSpaces().filter(room => !room.archived).length }) }));
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.querySelector('.group-chevron').textContent = collapsed ? '▸' : '▾';
    if (collapsed && $(body).contains(document.activeElement)) { sessionMenu?.close(); roomMenu?.(); toggle.focus(); }
    $(body).hidden = collapsed;
    ui.display.attribute(toggle, 'title', collapsed ? 'sidebar.expand' : 'sidebar.collapse', () => ({ name: section === 'sessions' && !grouped ? uiText('sidebar.sessionDrop') : name() }));
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
  const folderOf = typeof hierFolderContainers === 'function' ? hierFolderContainers(grouped ? null : visible, list) : null;
  $('sessions-flat').setAttribute('aria-pressed', String(!grouped)); $('sessions-grouped').setAttribute('aria-pressed', String(grouped));
  if (grouped) {
    const groups = allSpaces().filter(r => !r.archived).map(r => ({ id: r.id, room: r, people: orderedMembers(r.id).filter(s => visible.includes(s)) }));
    // Every listed session appears at least once: a session left only in an archived or unknown space counts as independent.
    const independent = visible.filter(s => !groups.some(group => inSpace(s, group.id)));
    groups.push({ id: '', room: null, people: independent });
    groups.forEach((group, index) => {
      // Read when painted, so a language switch repaints the default space's name without a re-render.
      const groupName = () => group.room ? spaceName(group.room) : uiText('sidebar.independent');
      let entry = sidebarGroups.get(group.id);
      if (!entry) {
        const element = node('section', undefined, 'session-space-group'), heading = node('h3'), body = node('div');
        const title = group.id ? button('', () => selectSpace(group.id)) : node('span');
        const toggle = button('', () => toggleSidebarGroup(group.id), 'session-space-toggle'), attention = node('span', undefined, 'session-space-attention');
        // A decorative, persistent SVG keeps disclosure distinct from entering
        // the space. The existing button owns its name, keyboard and fold state.
        toggle.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
        body.id = `session-space-members-${crypto.randomUUID()}`; attention.id = `${body.id}-attention`;
        toggle.setAttribute('aria-controls', body.id); heading.append(toggle, title, attention); element.append(heading, body); element.dataset.sessionGroup = group.id || 'independent';
        let more = null;
        if (group.id) {
          more = button('⋯', () => openRoomMenu(undefined, more, group.id), 'session-more space-group-more'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
          // As on the 协作空间 row: right-click or Shift+F10 on the space's name opens the same menu.
          title.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); if (!more.disabled) openRoomMenu({ x: event.clientX, y: event.clientY }, more, group.id); });
          title.addEventListener('keydown', event => { if ((event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') && !more.disabled) { event.preventDefault(); event.stopPropagation(); openRoomMenu(undefined, more, group.id); } });
          // T-145 V3: a visible 进入 beside the name, for the mouse; the name button itself stays the keyboard and screen-reader entry.
          const enter = node('span', undefined, 'session-space-enter'); enter.setAttribute('aria-hidden', 'true'); ui.display.text(enter, 'sidebar.enterSpace');
          enter.addEventListener('click', () => attempt(() => selectSpace(group.id))); heading.insertBefore(enter, attention);
          heading.append(more); bindSpaceHighlight(element, group.id); dropTarget(element, true, group.id);
        } else dropTarget(heading, false);
        entry = { element, title, body, toggle, attention, more }; sidebarGroups.set(group.id, entry);
      }
      entry.element.classList.toggle('empty-independent', !group.id && !group.people.length);
      // Group spaces are never archived (archived ones get no group), as on the 协作空间 row's ⋯.
      if (entry.more) {
        ui.display.attribute(entry.more, 'aria-label', 'sidebar.spaceActions', () => ({ name: groupName() })); ui.display.attribute(entry.more, 'title', 'sidebar.spaceActions', () => ({ name: groupName() }));
        entry.more.disabled = disconnected || renameTarget?.id === 'room' && renameTarget.roomId === group.id;
      }
      if (typeof renderSidebarSpaceCard === 'function') renderSidebarSpaceCard(entry, group);
      else ui.display.text(entry.title, 'sidebar.groupCount', () => ({ name: groupName(), count: group.people.length })); entry.title.className = group.id ? `session-space-heading ${roomTone(group.id)}` : 'session-space-heading';
      // The open space is marked on its heading, as on its 协作空间 row (hidden in this view).
      const open = Boolean(group.id) && selected === 'room' && spaceId === group.id;
      entry.title.classList.toggle('active', open); if (open) entry.title.setAttribute('aria-current', 'page'); else entry.title.removeAttribute('aria-current');
      if (group.id) ui.display.attribute(entry.title, 'aria-label', 'sidebar.openSpace', () => ({ name: groupName() }));
      // A folded group hides only its own rows; its name, count and any rows needing attention stay visible.
      const closed = sidebarCollapsedGroups.has(group.id || 'independent');
      // The narrow rail still lists a folded group's rows (T-132), so an open menu or focus there stays put.
      const rowsHidden = closed && list.closest('.naw')?.dataset.collapsed !== 'true';
      const menuRow = sessionMenu?.kind === 'session' && sessionRows.get(sessionMenu.rowKey);
      const closeMenu = rowsHidden && sessionMenu?.kind === 'session' && entry.body.contains(menuRow?.element || sessionMenu.anchor);
      const hiddenFocus = rowsHidden && (entry.body.contains(document.activeElement) || closeMenu);
      entry.body.hidden = closed; entry.toggle.setAttribute('aria-expanded', String(!closed));
      const groupLabel = () => ({ name: groupName() });
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
    for (const record of visible) occurrences.push({ record, key: record.id, group: null, container: folderOf?.get(record.id) || list });
  }
  const keys = new Set(occurrences.map(row => row.key));
  // The butler's own row: the same row any session has, in the entry's place above the lists.
  const butler = stewardRecord(); renderStewardEntry(butler);
  if (butler) { const key = `steward:${butler.id}`; occurrences.unshift({ record: butler, key, group: null, container: $('steward-slot'), steward: true }); keys.add(key); }
  if (sessionMenu && !sessionMenu.anchor && sessionMenu.rowKey && !keys.has(sessionMenu.rowKey)) sessionMenu.close();
  for (const [key, row] of sessionRows) if (!keys.has(key) && renameTarget?.row !== row.element) { row.element.remove(); sessionRows.delete(key); }
  const positions = new Map(), repeated = sameNameSessions(visible);
  for (const { record, key, group, container, steward = false } of occurrences) {
    let row = sessionRows.get(key);
    if (!row) {
      const element = node('div', undefined, 'session-row'); element.dataset.sessionRow = record.id; element.dataset.occurrence = key;
      const link = button('', () => select(record.id), 'session-link'); link.dataset.sessionId = record.id;
      // The butler's row is not reordered and not dragged into a space.
      if (steward) element.classList.add('steward-row'); else { draggableSession(link, record.id, true, group || ''); sidebarDropRow(element, record.id, group); }
      const label = node('span', undefined, 'label'), name = node('span', undefined, 'session-title'), shortId = node('span', undefined, 'session-short-id'), status = node('small'), badges = node('span', undefined, 'session-space-badges'), dot = node('span'), version = node('span', undefined, 'session-backend-version');
      const metadata = node('span', undefined, 'session-metadata'), time = node('time', undefined, 'session-time'), marker = node('span', undefined, 'sidebar-state-marker');
      version.setAttribute('aria-hidden', 'true'); dot.setAttribute('aria-hidden', 'true'); marker.setAttribute('aria-hidden', 'true');
      metadata.append(badges, status, time); label.append(name, version, shortId, metadata);
      // T-142: the status mark sits on the avatar's top-right corner, where a glance finds it.
      const avatar = icon(record, false); avatar.append(dot); link.append(avatar, label, marker);
      const more = button('⋯', () => openSessionMenu(record.id, undefined, key), 'session-more'); more.dataset.sessionMenu = record.id;
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('pointerdown', event => { if (sessionMenu?.rowKey === key) event.stopPropagation(); });
      element.addEventListener('contextmenu', event => { if (event.target.closest('#rename-editor')) return; event.preventDefault(); openSessionMenu(record.id, { x: event.clientX, y: event.clientY }, key); });
      element.addEventListener('keydown', event => { if (event.target.closest('#rename-editor')) return; if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openSessionMenu(record.id, undefined, key); } });
      element.append(link, more); row = { element, link, more, avatar, name, shortId, badges, status, dot, marker, time, version, sessionId: record.id, spaceId: group }; sessionRows.set(key, row);
    }
    const memberships = allSpaces().filter(r => !r.archived && inSpace(record, r.id)), membershipNames = () => memberships.map(r => spaceName(r)).join('、');
    const presentation = sidebarPresentation(record);
    paintVendorMark(row.avatar, record, steward ? '◆' : undefined);
    const plainLabel = () => `${record.name} · ${makerLabel(record)} · ${sessionShortId(record.id)} · ${sidebarPresentation(record).full}`;
    const label = () => steward ? uiText('steward.rowLabel', { details: plainLabel() }) : plainLabel();
    const association = () => memberships.length ? uiText('sidebar.memberships', { names: membershipNames() }) : uiText('sidebar.independent');
    const occurrence = () => grouped && memberships.length > 1 ? uiText('sidebar.sameIdentity') : '';
    const version = () => backendVersionNotice(record, state.appVersion);
    row.link.disabled = false; ui.display.computed(row.link, 'aria-label', () => `${label()} · ${association()}${occurrence()} · ${sessionTimes(record)}${version() ? ' · ' + version().title : ''}`);
    const badgeKey = JSON.stringify(memberships.map(r => [r.id, spaceName(r)]));
    row.badges.hidden = Boolean(grouped && group);
    if (row.badgeKey !== badgeKey) {
      // One badge plus a count keeps membership on its line; the badge shows the space's whole name and CSS
      // shortens it only by the width it has (T-144). The full list is in the hover card and the row's label.
      row.badges.replaceChildren(...memberships.slice(0, 1).map(r => { const badge = node('span', undefined, `space-badge ${roomTone(r.id)}`); ui.display.computed(badge, 'text', () => spaceName(r)); return badge; }));
      if (memberships.length > 1) { const more = node('span', `+${memberships.length - 1}`, 'space-badge space-badge-more'); row.badges.append(more); }
      row.badgeKey = badgeKey;
    }
    ui.display.computed(row.badges, 'aria-label', association);
    // Compact version marks keep the three cases apart: older alpha, different, unreported.
    const notice = version(), versionMark = notice ? { old: '↑', different: '≠', unknown: '?' }[notice.kind] : '';
    row.version.textContent = versionMark; row.version.dataset.marker = versionMark; ui.display.computed(row.version, 'title', () => version()?.title || ''); row.version.hidden = !notice;
    row.link.classList.toggle('active', record.id === selected); row.element.classList.toggle('active', record.id === selected);
    if (record.id === selected) row.link.setAttribute('aria-current', 'page'); else row.link.removeAttribute('aria-current');
    const moreParams = () => ({ name: record.name, id: sessionShortId(record.id), space: group ? ` · ${spaceName(spaceRecord(group))}` : '' }); ui.display.attribute(row.more, 'aria-label', 'sidebar.sessionActions', moreParams); ui.display.attribute(row.more, 'title', 'sidebar.sessionActions', moreParams); row.more.disabled = renameTarget?.id === record.id;
    ui.display.computed(row.more, 'aria-description', () => sidebarDetails(record).join(' · '));
    // The butler's row is named for what it is; which session it is stands on the line below, before its state.
    if (steward) { ui.display.text(row.name, 'butler.name'); if (row.shortId.textContent !== '') row.shortId.textContent = ''; ui.display.computed(row.status, 'text', () => uiText('steward.rowStatus', { name: record.name, status: sidebarPresentation(record).compact })); }
    else { if (row.name.textContent !== record.name) row.name.textContent = record.name; const shortId = sessionShortId(record.id); if (row.shortId.textContent !== shortId) row.shortId.textContent = shortId; ui.display.computed(row.status, 'text', () => sidebarPresentation(record).compact); }
    row.element.classList.toggle('same-name', repeated.has(record.id));
    const timeText = sessionActivityTime(record); if (row.time.textContent !== timeText) row.time.textContent = timeText;
    row.dot.className = `state-dot ${presentation.tone}${presentation.workTone ? ' ' + presentation.workTone : ''}`; row.dot.dataset.nativeState = record.state;
    row.marker.textContent = presentation.marker; row.element.classList.toggle('has-status-detail', presentation.detail);
    const index = positions.get(container) || 0, slot = container.children[index]; if (slot !== row.element) container.insertBefore(row.element, slot || null); positions.set(container, index + 1);
  }
  highlightSpace(hoverSpace);
  if (typeof decorateSidebarHierarchy === 'function') decorateSidebarHierarchy();
  if (typeof sidebarHoverCard !== 'undefined' && sidebarHoverCard) sidebarHoverCard.refresh();
}

function createReadiness() {
  if (!$('create-dialog').open) return;
  renderCreateSpaces();
  renderCreateProfiles();
  renderDshProvider();
  const historyProvider = chosenProvider();
  // Codex history continues a thread with its own vendor; it is not offered for a new DeepSeek member.
  // A DSH session has no history to continue here.
  $('open-native-history').hidden = deepseekChosen() || historyProvider === 'dsh' || !state.capabilities?.includes(historyProvider === 'codex' ? 'nativeHistory' : 'claudeFork');
  $('claude-history-id-option').hidden = historyProvider !== 'claude' || !state.capabilities?.includes('claudeHistory');
  $('open-claude-sessions').hidden = historyProvider !== 'claude' || !state.capabilities?.includes('claudeSessionList');
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
  $('open-native-history').disabled = creatingSession || Boolean(createTicket?.directoryDefaults) || gitSelected || (historyProvider === 'claude' && newDirectory);
  // A listed session brings its own folder, so the chosen one does not matter here.
  $('open-claude-sessions').disabled = creatingSession || Boolean(createTicket?.directoryDefaults) || gitSelected;
  if (historyProvider === 'claude' && newDirectory) ui.display.text($('open-native-history'), 'create.chooseOriginal');
  $('new-folder').hidden = !state.capabilities?.includes('newSessionDirectory');
  $('new-folder').disabled = $('choose-folder').disabled = creatingSession;
  $('cancel-create').disabled = false;
  // Only Codex starts differently: either this app or its TUI creates the native thread.
  // A Claude session opens in the last-used tab; both views stay available.
  $('initial-view').hidden = $('initial-view-label').hidden = historyProvider !== 'codex';
  // Only a service that applies the choice may offer it; an older one would silently ignore it.
  // DSH keeps its own approvals; the service refuses bypass for it.
  $('skip-permissions-option').hidden = !state.capabilities?.includes('createSkipPermissions') || historyProvider === 'dsh';
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
  const provider = chosenProvider();
  // DSH is ready when the service found its pinned runtime and a Node.js to run it.
  const programReady = provider === 'dsh' ? state.available?.dsh === true : state.preflight?.[provider];
  const ready = state.preflight?.python && programReady && (!deepseekChosen() || Boolean($('create-profile').value));
  $('confirm-create').disabled = creatingSession || Boolean(createTicket?.directoryDefaults) || !ready || Boolean(takeover && (newDirectory || gitSelected)) || (gitSelected && (newDirectory || !gitSupported || gitPreviewLoading || !gitWorktreePlan));
  const readinessKey = takeover && (newDirectory || gitSelected) ? 'create.takeoverDirectory' : ready ? null : 'create.missingPrograms';
  ui.display.computed($('create-readiness'), 'text', () => readinessKey ? uiText(readinessKey) : '');
  createSpaceReadiness(true);
}
// T-115: a space choice locks nothing until the session exists; then everything but 仅继续加入 and 关闭 is locked.
// A DeepSeek member runs in Codex from one of the person's Codex profiles naming DeepSeek
// (2026-11-13): offered only when the service lists such a profile and can start from it.
function deepseekProfiles() {
  return state.capabilities?.includes('createSettingsProfileV1') && Array.isArray(state.codexProfiles)
    ? state.codexProfiles.filter(profile => profile?.modelProvider === 'deepseek' && typeof profile.name === 'string' && typeof profile.model === 'string') : [];
}
function deepseekChosen() { return document.querySelector('input[name="provider"]:checked').value === 'deepseek'; }
// DSH (the DeepSeek Harness TUI) is offered only when the service reports its runtime.
function renderDshProvider() {
  const offered = state.available?.dsh === true;
  $('dsh-provider').hidden = !offered;
  const chosen = document.querySelector('input[name="provider"]:checked').value === 'dsh';
  if (!offered && chosen) document.querySelector('input[name="provider"][value="claude"]').checked = true;
}
function chosenProvider() { return deepseekChosen() ? 'codex' : document.querySelector('input[name="provider"]:checked').value; }
function renderCreateProfiles() {
  const profiles = deepseekProfiles(), select = $('create-profile');
  $('deepseek-provider').hidden = !profiles.length;
  if (!profiles.length) {
    if (deepseekChosen()) document.querySelector('input[name="provider"][value="claude"]').checked = true;
    select.hidden = $('create-profile-label').hidden = true;
    return;
  }
  const names = profiles.map(profile => profile.name);
  if ([...select.options].map(option => option.value).join('\n') !== names.join('\n')) {
    const kept = select.value;
    select.replaceChildren(...profiles.map(profile => { const option = document.createElement('option'); option.value = profile.name; option.textContent = profile.model; return option; }));
    // The person's default is pro (2026-11-13); flash stays a choice.
    select.value = names.includes(kept) ? kept : (profiles.find(profile => /-pro$/.test(profile.model)) || profiles[0]).name;
  }
  select.hidden = $('create-profile-label').hidden = !deepseekChosen();
}
function createSpaceReadiness(final = false) {
  const ticket = dialogTickets.get($('create-dialog')), creation = ticket?.creation, spaced = $('create-space-kind').value !== 'independent';
  const takeover = document.querySelector('input[name="provider"]:checked').value === 'claude' && $('claude-history-id').value.trim();
  const stopped = Boolean(creation || ticket?.created); // a session from this opening exists, or may (I159)
  for (const input of $('create-dialog').querySelectorAll('input[name="provider"], #session-name, #claude-history-id, #skip-permissions, #initial-view, #create-profile')) input.disabled = stopped;
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
function archiveRoomActivityAt(room) {
  let latest = -Infinity;
  for (const records of [room.messages, room.events]) {
    for (const record of Array.isArray(records) ? records : []) {
      if (Number.isFinite(record.time) && Math.abs(record.time) <= 8640000000000000) latest = Math.max(latest, record.time);
    }
  }
  return latest;
}
function renderArchives() {
  const records = state.sessions.filter(s => s.archived), archivedRooms = allSpaces().filter(r => r.archived), count = records.length + archivedRooms.length;
  const running = records.filter(s => ARCHIVE_RUNNING.includes(s.state)).length;
  ui.display.text($('archive-label'), 'archive.label', () => ({ count: count ? ` · ${count}` : '', running: running ? uiText('archive.pending', { count: running }) : '' }));
  ui.display.attribute($('archive-button'), 'title', 'archive.title', () => ({ count, running: running ? uiText('archive.runningHelp', { count: running }) : '' }));
  if ($('archive-group-body').hidden) return;
  const list = $('archive-list');
  if (!archiveDisclosure) {
    archiveDisclosure = window.nativeWorkspaceDisclosure.create({ document, say: (el, key, params) => ui.display.text(el, key, params), older: 'below',
      key: item => item.room ? `room:${item.room.id}` : `session:${item.session.id}`, fill: archiveLine });
    archiveDisclosure.box.className += ' archive-disclosure';
  }
  const rowsOf = () => [...archiveDisclosure.list.children];
  const origin = document.activeElement, oldRow = origin?.closest?.('.disclosure-item'), oldIndex = oldRow ? rowsOf().indexOf(oldRow) : -1;
  const part = origin?.matches?.('summary') ? 'summary' : '.disclosure-actions button';
  const items = archivedRooms.map(room => ({ room, at: archiveRoomActivityAt(room) })).concat(records.map(session => ({ session, at: sessionActivityAt(session) })));
  const signature = JSON.stringify([archivedRooms.map(r => [r.id, r.name, spaceName(r)]), records.map(s => [s.id, s.name, s.state, sessionTimes(s)]), state.sessions.map(s => [s.id, s.name]), state.rotationChains, items.map(item => item.at)]);
  if (list.dataset.signature === signature) return; list.dataset.signature = signature;
  if (!count) { list.replaceChildren(uiNode('p', 'archive.empty')); archiveDisclosure.update([]); }
  else {
    if (archiveDisclosure.box.parentElement !== list) list.replaceChildren(archiveDisclosure.box);
    archiveDisclosure.update(items.map((item, i) => ({ item, i })).sort((a, b) => b.item.at - a.item.at || a.i - b.i).map(x => x.item));
  }
  if (oldRow) {
    const rows = rowsOf(), same = rows.find(row => row.dataset.key === oldRow.dataset.key);
    focusAfterRemoval(origin, [same?.querySelector(part), rows[oldIndex]?.querySelector(part), rows[oldIndex - 1]?.querySelector(part), $('archive-button')]);
  }
}
const ARCHIVE_RUNNING = ['working', 'approval', 'starting', 'stopping', 'disconnected'];
// Spaces and sessions share one activity order. A session still running says so on its line.
let archiveDisclosure = null;
function archiveLine(item, { row, text, end, body, actions }) {
  if (item.room) {
    const room = item.room;
    row.dataset.archivedRoom = room.id;
    ui.display.computed(text, 'text', () => spaceName(room));
    body.append(uiNode('div', 'archive.roomInfo'));
    const restore = uiButton('archive.restore', () => restoreArchivedRoom(room.id), 'small');
    ui.display.attribute(restore, 'aria-label', 'archive.restoreRoomNamed', () => ({ name: spaceName(room) }));
    actions.append(restore);
    return;
  }
  const s = item.session;
  row.dataset.archivedSession = s.id;
  ui.display.computed(text, 'text', () => participantLabel(s, state.sessions));
  if (ARCHIVE_RUNNING.includes(s.state)) ui.display.computed(end, 'text', () => stateText(s));
  const info = node('div');
  ui.display.computed(info, 'text', () => `${providerName(s.provider)} · ${stateText(s)}${uiText(['ended', 'recoverable'].includes(s.state) ? 'archive.continueHistory' : 'archive.processRetained')} · ${sessionTimes(s)}`);
  body.append(info);
  if (sessionChainModel(s.id)) body.append(uiButton('chain.title', () => openSessionChain(s.id), 'small'));
  const restore = uiButton('archive.restore', () => restoreArchivedSession(s.id), 'small');
  ui.display.attribute(restore, 'aria-label', 'archive.restoreSessionNamed', () => ({ name: participantLabel(s, state.sessions) }));
  actions.append(restore);
}
async function restoreArchivedSession(id) {
  const origin = document.activeElement, surface = JSON.stringify([selected, roomSession, roomSurface, mode]);
  const result = await api.restoreSession(id); updateState(await api.initial()); render();
  if (surface === JSON.stringify([selected, roomSession, roomSurface, mode])) focusAfterRemoval(origin, [$('session-header-more'), $('archive-button')]);
  sessionNoticeMessage(result?.placement === 'unavailable' ? 'notice.room.sessionRestoreFallback' : 'toast.sessionRestored', undefined, id);
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
  $('refresh-setup').textContent = uiText('setup.recheck');
  $('close-setup').setAttribute('aria-label', `${uiText('common.close')} · ${uiText('common.settings')}`);
  $('close-setup').title = uiText('common.close');
  const entry = $('setup-button');
  entry.querySelector('.rail-label').textContent = uiText('common.settings');
  entry.setAttribute('aria-label', uiText('common.settings')); entry.title = uiText('common.settings');
  activityStream?.render();
  updateTaskBoard();
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
  const ticket = setupTicket = openSetupDialog();
  mobileSetup.open();
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
  return archivedName(session, people.filter(s => s.name === session.name).length > 1 ? `${session.name} · ${providerName(session.provider)} · ${sessionShortId(session.id)}` : session.name);
}
// An archived session keeps its stored name. Only what people read gets the
// marker, worked out from the archived flag, so restoring a session drops it.
function archivedName(record, name = record?.name) {
  return record?.archived ? uiText('session.archivedName', { name }) : name;
}
function sessionWindowTitle(s) { return `${s?.name ? archivedName(s) : 'Native Workspace'} — Native Agent Workspace`; }
function historicalParticipantLabel(name, id) {
  return `${name || uiText('identity.historicalMember')}${typeof id === 'string' && id ? ` · ${id.slice(0, 6)}` : uiText('identity.unrecorded')}`;
}
function roomMessageLabel(m) {
  const displayName = ui.displayText(m.name, m.uiNameMessage);
  if (m.agentControl || m.controlAudit?.actor) {
    const actor = m.agentControl || m.controlAudit.actor;
    const source = state.sessions.find(s => s.id === actor.id && s.nativeId === actor.nativeId);
    const sender = source ? participantLabel(source, state.sessions) : historicalParticipantLabel(actor.name, actor.id);
    const target = state.sessions.find(s => s.id === m.recipientId);
    return m.recipientId ? `${sender} → ${target ? participantLabel(target, state.sessions) : historicalParticipantLabel('', m.recipientId)}` : sender;
  }
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
  // Queue/monitor rows are NAW's notices about a member; sessionId identifies
  // their subject, not an assistant who spoke. Native streamed rows are separate.
  if (m.role === 'system' && ['queue', 'monitor'].includes(m.kind)) return uiText('identity.workspace');
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
function timelineParticipants(message) {
  return [...new Set([message.sessionId, message.recipientId, ...(message.deliveries || []).map(d => d.recipientId), message.wake?.senderId, message.wake?.recipientId, message.operator?.senderId, message.operator?.recipientId, message.peerMessage?.senderId, message.peerMessage?.recipientId].filter(id => typeof id === 'string' && id))];
}
function filteredTimeline() {
  const related = Boolean(roomRecordReturn || roomRecordScope), id = related ? roomRecordScope : $('room-filter').value;
  const query = related ? '' : $('room-search').value.trim().toLocaleLowerCase();
  return timeline().filter(m => (related || !roomThread || roomThreads.roots.get(m.id) === roomThread) && (!id || timelineParticipants(m).includes(id)) && (!query || m.text.toLocaleLowerCase().includes(query)));
}

function getActivityStream() {
  if (!window.nativeWorkspaceActivityStream) return null;
  return activityStream ||= window.nativeWorkspaceActivityStream.bind({
    document, state: () => state, rooms: allSpaces, roomName: spaceName,
    isMember: (session, id) => Boolean(session && inSpace(session, id)), inRoom: () => selected === 'room',
    text: uiText, displayText: (text, notice) => ui.displayText(text, notice), label: roomMessageLabel,
    language: () => ui.language.getSnapshot().active, connected: () => !disconnected, attempt,
    waitingChanged: count => taskBoard.setWaitingCount(count),
    selectSpace, confirmation: showBackgroundConfirmation, card: renderBackgroundControls, cardHidden: confirmationCardHidden, question: renderWaitingQuestion,
    cardTitle: message => confirmationBatchTitle(message.backgroundOperation) || (message.backgroundOperation?.summary ? backgroundSummaryText(message.backgroundOperation.summary, true) : ''),
    toggleChanged: () => requestAnimationFrame(refreshColumnTerminalHeights),
    original: async target => {
      const loading = ensureMessages([target.sessionId]); if (loading) await loading;
      const record = state.sessions.find(s => s.id === target.sessionId && (!target.nativeId || s.nativeId === target.nativeId));
      if (!record) { toastMessage('toast.originalRemoved'); return false; }
      await select(record.id, 'chat');
      if (!target.messageId || !pointToMessage($('messages'), record.id, target.messageId)) toastMessage('stream.openedSession');
      return true;
    },
  });
}
function showRoomRecords(related = false) {
  const stream = getActivityStream();
  if (stream) {
    if (related) stream.open(spaceId, current()?.id || ''); else stream.toggle(spaceId);
    return;
  }
  const record = related && focusedRoomMember() ? current() : null;
  if (related && !record) return;
  captureReadingViews(); rememberRoomMemberView(); suspendColumnInputs();
  const selection = document.getSelection();
  if (record && selection?.rangeCount && !selection.isCollapsed && $('messages').contains(selection.anchorNode)) roomRecordSelections.set(spaceId, selection.getRangeAt(0).cloneRange());
  const leaving = terminals.get(activeSessionId());
  if (leaving?.composing) leaving.term.blur();
  selectionRevision++;
  roomRecordScope = record?.id || ''; roomRecordReturn = record ? { id: record.id, nativeId: record.nativeId || '' } : null;
  roomSurface = 'records'; roomSession = ''; mode = 'chat'; activateSoloComposer('');
  lastRoomMessages = ''; render(); attempt(persistView);
  (record ? $('room-record-return') : $('room-record')).focus({ preventScroll: true });
}
function returnRoomRecordMember() {
  const target = roomRecordReturn, record = target && members().find(s => s.id === target.id && (s.nativeId || '') === target.nativeId);
  if (!record) return toastMessage('toast.originalRemoved');
  const range = roomRecordSelections.get(spaceId); roomRecordSelections.delete(spaceId);
  openRoomMember(record.id);
  if (range?.startContainer.isConnected && range.endContainer.isConnected) {
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
}
function clearRoomRecordFilter() {
  captureReadingViews();
  if (roomRecordReturn) { roomRecordScope = ''; lastRoomMessages = ''; render(); attempt(persistView); return; }
  const filter = $('room-filter').value || pendingRoomFilter, search = $('room-search').value;
  if (filter || search || roomThread) roomFilterHistory = { roomFilter: filter, roomSearch: search, roomThread };
  roomRecordScope = ''; roomRecordReturn = null;
  $('room-filter').value = ''; pendingRoomFilter = ''; $('room-search').value = ''; roomThread = '';
  lastRoomMessages = ''; render(); attempt(persistView);
}
function restoreRoomRecordFilter() {
  if (!roomFilterHistory) return;
  captureReadingViews(); roomRecordScope = ''; roomRecordReturn = null;
  pendingRoomFilter = roomFilterHistory.roomFilter; $('room-filter').value = pendingRoomFilter;
  $('room-search').value = roomFilterHistory.roomSearch; roomThread = roomFilterHistory.roomThread;
  lastRoomMessages = ''; render(); attempt(persistView);
}
function openThread(id) {
  const root = roomThreads.roots.get(id);
  if (!root) return toastMessage("toast.threadRemoved");
  captureReadingViews(); roomRecordScope = ''; roomRecordReturn = null; roomFilterHistory = null; roomThread = root; roomReplyTo = root;
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
    for (const id of timelineParticipants(m)) if (!candidates.has(id)) candidates.set(id, state.sessions.find(s => s.id === id)?.name || (m.sessionId === id ? m.name : m.deliveries?.find(d => d.recipientId === id)?.recipientName) || null);
  }
  const filter = $('room-filter'), chosen = filter.value || pendingRoomFilter; pendingRoomFilter = '';
  // Preserve an explicitly saved historical view even when its source is no
  // longer loaded. A person may clear it; opening records must not do so.
  if (chosen && !candidates.has(chosen)) candidates.set(chosen, null);
  const filterSignature = JSON.stringify([...candidates].map(([id, name]) => [id, name, members().some(s => s.id === id), Boolean(state.sessions.find(s => s.id === id)?.archived)]));
  if (filter.dataset.signature !== filterSignature) {
    filter.replaceChildren(uiNode('option', 'room.allMembers'));
    filter.firstChild.value = '';
    for (const [id, name] of candidates) { const option = node('option'); ui.display.computed(option, 'text', () => `${name ? archivedName(state.sessions.find(s => s.id === id), name) : uiText('identity.historicalMember')}${members().some(s => s.id === id) ? '' : uiText('room.detachedSuffix')} · ${id.slice(0, 6)}`); option.value = id; filter.append(option); }
    filter.dataset.signature = filterSignature;
  }
  filter.value = candidates.has(chosen) ? chosen : '';
  filter.disabled = Boolean(roomRecordReturn || roomRecordScope); $('room-search').disabled = filter.disabled;
  filter.hidden = $('room-search').hidden = filter.disabled;
  $('room-record-context').hidden = roomSurface !== 'records' || !(roomRecordReturn || roomRecordScope || chosen || $('room-search').value || roomThread || roomFilterHistory);
  ui.display.computed($('room-record-scope'), 'text', () => roomRecordScope ? uiText('room.relatedScope', { name: state.sessions.find(s => s.id === roomRecordScope)?.name || uiText('identity.historicalMember') }) : roomRecordReturn || roomRecentPreview() ? uiText('room.recentRecordView') : chosen || $('room-search').value || roomThread ? uiText('room.filteredScope') : '');
  $('room-record-return').hidden = !roomRecordReturn;
  const returning = roomRecordReturn && members().find(s => s.id === roomRecordReturn.id && (s.nativeId || '') === roomRecordReturn.nativeId);
  $('room-record-return').disabled = !returning;
  ui.display.text($('room-record-return'), 'room.returnMember', { name: returning?.name || uiText('identity.historicalMember') });
  $('room-record-clear').hidden = roomRecordReturn ? !roomRecordScope : !(roomRecordScope || chosen || $('room-search').value || roomThread);
  $('room-record-restore').hidden = !roomFilterHistory || Boolean(roomRecordReturn || roomRecordScope || chosen || $('room-search').value || roomThread);
  const messages = filteredTimeline();
  const signature = JSON.stringify([messages, state.sessions.map(s => [s.id, s.name, Boolean(s.archived)]), filter.value, $('room-search').value, roomThread, [...roomThreads.groups].map(([id, rows]) => [id, rows.length])]);
  if (signature !== lastRoomMessages) { messageList($('room-messages'), messages, true, roomReadingKey()); lastRoomMessages = signature; }
  const filtered = roomRecordScope || !roomRecordReturn && (filter.value || $('room-search').value || roomThread);
  ui.display.text($('timeline-count'), filtered ? 'room.filteredRecordCount' : 'room.recordCount', { count: messages.length, total: timeline().length }); $('copy-timeline').disabled = !messages.length;
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
    event.dataTransfer.setData('application/x-native-session', id); event.dataTransfer.effectAllowed = 'move';
    const record = state.sessions.find(s => s.id === id);
    if (record) event.dataTransfer.setData('application/x-native-placement', JSON.stringify([record.placementRevision || 0, record.connectionRevision || 0]));
    event.dataTransfer.setData('application/x-native-source-space', sourceSpace);
    if (reorder) event.dataTransfer.setData('application/x-native-session-order', id);
    document.querySelector('.sidebar').classList.add('dragging-session');
  });
  element.addEventListener('dragend', () => { document.querySelector('.sidebar').classList.remove('dragging-session'); document.querySelectorAll('.drag-over, .drop-before, .drop-after').forEach(el => el.classList.remove('drag-over', 'drop-before', 'drop-after')); });
}
function currentDrag(event, id) {
  const encoded = event.dataTransfer.getData('application/x-native-placement');
  if (!encoded) return; // Older drag sources still use the backend's current proof.
  const record = state.sessions.find(s => s.id === id);
  let proof; try { proof = JSON.parse(encoded); } catch { throw uiError('error.movePlacementChanged'); }
  if (!record || !Array.isArray(proof) || proof.length !== 2 || proof[0] !== (record.placementRevision || 0) || proof[1] !== (record.connectionRevision || 0)) throw uiError('error.movePlacementChanged');
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
    attempt(async () => {
      currentDrag(event, id);
      const record = state.sessions.find(s => s.id === id), homes = record && window.nativeWorkspaceSpaces.roomIds(record);
      if (group && !homes?.includes(group)) return addToSpace(id, group);
      if (group === '' && homes?.length) {
        if (homes.length !== 1) throw uiError('error.movePlacementAmbiguous');
        return detach(id, homes[0]);
      }
      return group ? moveRoomMember(id, target, after(event), group) : moveSidebarSession(id, target, after(event));
    });
  });
}
function dropTarget(element, join, destination = 'shared') {
  const active = () => !(element.id === 'solo-drop' && sidebarView === 'grouped');
  element.addEventListener('dragover', event => { if (active() && event.dataTransfer.types.includes('application/x-native-session')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('drag-over'); } });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over'); });
  element.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation(); element.classList.remove('drag-over');
    if (!active()) return;
    const id = event.dataTransfer.getData('application/x-native-session');
    try { currentDrag(event, id); } catch (error) { toastError(error); return; }
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
  $('room-notes-text').value = room.notes || ''; ui.display.text($('notes-heading'), 'notes.titleName', () => ({ name: spaceName(room) })); $('notes-error').hidden = true; $('save-notes').disabled = false;
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
  const ticket = dialogTickets.get($('context-dialog'));
  $('copy-context').disabled = unavailable;
  $('insert-context').disabled = unavailable || Boolean(currentDialogTicket(ticket) && ticket.contextInsert);
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
    label.append(check, document.createTextNode(spaceName(room) + (duplicate ? ' · ' + room.id : '')));
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
    const entry = button(`${s.name} · ${providerName(s.provider)} · ${sessionShortId(s.id)}`, () => chooseMention(s.id), 'mention-option');
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
const headerMenuKey = () => JSON.stringify([selectionRevision, selected, current()?.id, current()?.nativeId, spaceId, current() ? pairRevision(current()) : null, current()?.archived, current()?.owner, state.queueSecretary, state.integrator, state.steward, disconnected]);
function openHeaderMenu(anchor, terminal = false) {
  if (!current()) return;
  if (sessionMenu?.anchor === anchor) return sessionMenu.close();
  contentMenu?.close(); sessionMenu?.close(); roomMenu?.();
  const key = headerMenuKey(), h = headerControls;
  const actions = terminal ? [{ id: 'display', label: uiText('header.display'), labelKey: 'header.display', control: $('terminal-display') }]
    : [{ id: 'membership', label: h.membership.textContent, labelRead: () => h.membership.textContent, control: h.membership }, { id: 'share', label: uiText('header.share'), labelKey: 'header.share', control: h.selectedText }, { id: 'usage', label: uiText('header.usage'), labelKey: 'header.usage', control: h.usage }];
  // The same flag as the secretary item: kept on an archived session, and disabled while disconnected.
  if (!terminal) actions.push(...stewardAction(current()).map(item => ({ ...item, secretary: true })));
  const secretaryKey = state.queueSecretary?.sessionId === current().id ? 'menu.queueSecretaryRevoke' : 'menu.queueSecretarySet';
  if (typeof api.queueSecretary === 'function' && (state.queueSecretary?.sessionId === current().id || current().nativeId && !current().archived)) actions.push({
    id: state.queueSecretary?.sessionId === current().id ? 'queue-secretary-revoke' : 'queue-secretary-set', label: uiText(secretaryKey), labelKey: secretaryKey, secretary: true,
  });
  // The same flag as the secretary item: kept on an archived session, and disabled while disconnected.
  if (!terminal) actions.push(...integratorAction(current()).map(item => ({ ...item, secretary: true })));
  // The butler is not offered a space to join.
  const items = actions.filter(item => (terminal || !current().archived || item.id === 'usage' || item.secretary) && !(item.id === 'membership' && item.control.hidden));
  anchor.focus(); anchor.setAttribute('aria-expanded', 'true');
  const close = ui.menu({
    items: items.map(({ control, secretary, ...item }) => ({ ...item, disabled: Boolean(control?.disabled) || Boolean(secretary && disconnected) })),
    getAnchorRect: () => anchor.getBoundingClientRect(),
    onClose: () => {
      if (sessionMenu?.close === close) sessionMenu = null;
      anchor.setAttribute('aria-expanded', 'false');
      if (key === headerMenuKey() && anchor.isConnected) anchor.focus({ preventScroll: true });
    },
    onSelect: action => {
      if (key !== headerMenuKey()) return;
      if (action === 'queue-secretary-set' || action === 'queue-secretary-revoke') { if (!disconnected) attempt(() => chooseQueueSecretary(action === 'queue-secretary-revoke' ? null : current().id)); }
      else if (action === 'integrator-set' || action === 'integrator-revoke') { if (!disconnected) attempt(() => chooseIntegrator(current().id, action === 'integrator-revoke')); }
      else if (action === 'steward-set') openStewardChooser(current().id);
      else if (action === 'steward-revoke') { if (!disconnected) attempt(() => revokeSteward(current().id)); }
      else if (action === 'steward-change') openStewardChooser();
      else if (action === 'steward-record') stewardSteps?.open();
      else items.find(item => item.id === action)?.control.click();
    },
  });
  sessionMenu = { id: current().id, anchor, key, close };
}
// T-163: the second row of a space's header. Where a member tab cannot show three characters of its name (48px
// at its type size), the layout controls and the actions take a row of their own. A window less than 700px high
// keeps one row: the member columns under it have no height to give there, and what they show comes first.
const ROOM_TABS = { name: 48, height: 700 };
let roomTabsFit = '', roomTabsWindow = null;
// The choice is read from the one-row layout, and read again only when something the row's width or its fixed
// controls follow has changed: the window's size, the sidebar being open or closed, the controls' labels, which of
// them are shown, the members' names. Those are compared without laying the page out, so an ordinary render pays
// nothing. `measure` is for the two callers that know the width may have changed (a window resize, the row's own
// size observer). The choice never depends on what a member's column shows.
function fitRoomTabs(measure = false) {
  const header = $('header'), tabs = $('room-tabs');
  if (measure || !roomTabsWindow) roomTabsWindow = [innerWidth, innerHeight];
  if ($('room-member-tabs').hidden || !header.classList.contains('compact-room') || tabs.parentElement !== header) { header.classList.remove('room-tabs-two-rows'); roomTabsFit = ''; return; }
  const names = [...$('room-member-tabs').children].map(tab => tab.querySelector('.room-member-name')), tall = roomTabsWindow[1] >= ROOM_TABS.height;
  const controls = [...tabs.querySelectorAll(':scope > button, .collaboration-toolbar > *')].map(item => item.closest('[hidden]') ? '' : item.textContent);
  const key = [roomTabsWindow[0], tall, document.querySelector('.naw[data-native-surface="sidebar"]')?.dataset.collapsed, ...controls, '', ...names.map(name => name.textContent)].join('\n');
  if (key === roomTabsFit && !measure) return;
  roomTabsFit = key;
  // Reading the one-row layout lays the page out once without the second row. The columns' reading positions are
  // put back afterwards. They are not taken here: each column saves its own on every scroll, and on a window resize
  // this runs before the columns have caught up with the new size, so what it would take is not where they were.
  const was = header.classList.contains('room-tabs-two-rows');
  if (was) header.classList.remove('room-tabs-two-rows');
  const two = tall && names.some(name => name.scrollWidth > name.clientWidth + 1 && name.clientWidth < ROOM_TABS.name);
  if (two) header.classList.add('room-tabs-two-rows');
  if (two || was) restoreOverviewReading();
}
// Each pane owns its mode control; the hidden pane has an entry in the visible one.
function renderPaneSwitches(s, inRoom) {
  const paired = Boolean(s && !$('conversation-pane').hidden);
  for (const [id, value] of [['chat-tab', 'chat'], ['terminal-tab', 'terminal']]) {
    $(id).setAttribute('aria-pressed', String(mode === value));
  }
  $('chat-pane-tabs').hidden = $('native-pane-tabs').hidden = !paired;
  $('native-pane-title').hidden = paired && !inRoom;
  $('open-native-terminal').hidden = !paired || !$('native-pane').hidden;
  $('open-native-terminal').setAttribute('aria-expanded', String(!$('native-pane').hidden));
  $('return-to-chat').hidden = !paired || terminalLayout !== 'maximized';
}
function visibleModeControl(next) {
  const ids = next === 'chat' ? ['chat-tab', 'return-to-chat'] : ['terminal-tab', 'open-native-terminal'];
  return ids.map(id => $(id)).find(control => control && !control.disabled && control.getClientRects().length);
}
function renderHeaderLayout(s, inRoom) {
  const compact = Boolean(s && !inRoom), toolbar = $('session-toolbar');
  const focusedMember = Boolean(inRoom && s);
  const compactRoom = Boolean(inRoom && !s), header = $('header'), tabs = $('room-tabs'), band = $('run-status').parentElement;
  const moving = compactRoom !== header.classList.contains('compact-room') || roomOverview && (roomOverview.toolbar.parentElement === tabs) !== compactRoom;
  if (moving) { captureReadingViews(); restoreOverviewReading(); }
  header.classList.toggle('compact-room', compactRoom);
  header.classList.toggle('focused-member', focusedMember);
  $('room-view').classList.toggle('compact-room-surface', inRoom);
  $('room-view').classList.toggle('focused-member-surface', focusedMember);
  $('room-member-status').hidden = !focusedMember;
  if ($('room-member-status-dialog').open && roomMemberStatusContext?.key !== roomMemberStatusKey()) $('room-member-status-dialog').close();
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
  $('conversation-pane-toolbar').hidden = !s || $('conversation-pane').hidden;
  $('terminal-more').hidden = !compact;
  $('title').tabIndex = compact || compactRoom || focusedMember ? 0 : -1;
  ui.display.computed($('title'), 'title', () => compact || focusedMember ? archivedName(s) : compactRoom ? state.room.unavailable ? uiText('space.unavailable') : spaceName(state.room) : '');
  if (typeof renderSessionChainChip === 'function') renderSessionChainChip(compact ? s : null);
  if (typeof hierHeaderCrumb === 'function') hierHeaderCrumb(compact ? s : null);
  $('title').onfocus = () => { if (header.classList.contains('compact-room') || header.classList.contains('focused-member')) { captureReadingViews(); restoreOverviewReading(); header.classList.add('reveal-room-title'); } };
  $('title').onblur = () => { if (header.classList.contains('reveal-room-title')) { captureReadingViews(); restoreOverviewReading(); header.classList.remove('reveal-room-title'); } };
  if (!compactRoom && !focusedMember) header.classList.remove('reveal-room-title');
  $('subtitle').tabIndex = focusedMember ? 0 : -1;
  $('subtitle').onfocus = focusedMember ? $('title').onfocus : null;
  $('subtitle').onblur = focusedMember ? $('title').onblur : null;
  const settings = s?.nativeSettings?.nativeId === s?.nativeId ? [s?.nativeSettings?.mode === 'plan' ? 'Plan' : '', s?.nativeSettings?.effort].filter(Boolean) : [];
  const values = s ? [s.provider === 'claude' ? 'Claude Code' : providerName(s.provider), sessionShortId(s.id), s.model, ...settings, window.nativeWorkspaceSpaces.roomIds(s).length ? 'header.collaborating' : 'header.independent'] : [];
  const subtitle = $('subtitle'), signature = JSON.stringify([compact, compactRoom, inRoom, values, s?.modelUiMessage, compactRoom && members().length, focusedMember && spaceName(state.room)]);
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
    else ui.display.computed(subtitle, 'text', () => compactRoom ? uiText('header.members', { count: members().length }) : focusedMember ? uiText('room.memberContext', { name: spaceName(state.room) }) : s ? values.slice(0, -1).map((value, index) => index === 2 ? ui.displayText(value, s.modelUiMessage) : value).concat(uiText(values.at(-1))).join(' · ') : uiText(inRoom ? 'header.roomHelp' : 'header.welcomeHelp'));
    subtitle.dataset.identity = signature;
  }
  if (sessionMenu?.anchor && sessionMenu.key !== (sessionMenu.kind === 'member' ? memberMenuKey(sessionMenu.id) : headerMenuKey())) sessionMenu.close();
  if (roomMenu?.key && roomMenu.key !== roomMenuKey(roomMenu.roomId)) roomMenu();
  if (moving) restoreOverviewReading();
}
// Read the existing space ledger without changing the active conversation or drafts.
let spaceMessagePreview;
function spaceMessagePreviewRows(id) {
  if (!id) return [];
  return storedSpaces().filter(room => !room.unavailable).flatMap(room => (room.messages || [])
    .filter(message => typeof message.text === 'string' && (message.wake || message.peerMessage || message.agentControl) &&
      [...timelineParticipants(message), message.agentControl?.id].includes(id))
    .map(message => ({ room, message })))
    .sort((a, b) => (Number.isFinite(b.message.time) ? b.message.time : -Infinity) - (Number.isFinite(a.message.time) ? a.message.time : -Infinity))
    .slice(0, 20);
}
function spaceMessagePreviewStatus(message) {
  if (message.wake) return uiText(readingWakeStatus({ status: message.wakeStatus }));
  if (message.peerMessage) return uiText('spacePreview.recorded');
  const receipts = (Array.isArray(message.deliveries) ? message.deliveries : []).filter(delivery => delivery?.recipientId === message.recipientId);
  return uiText(receipts.length === 1 ? readingDeliveryStatusKey(message, receipts[0]) : 'delivery.unknown');
}
function spaceMessagePreviewText(message) {
  const text = ui.displayText(message.text, message.uiMessage), body = message.wake?.body;
  // Separate only an exact recorded suffix: a receipt/reason update must not
  // replace the selected original body. Unexpected legacy text stays intact.
  return typeof body === 'string' && body && text.endsWith(body)
    ? { body, notice: text.slice(0, text.length - body.length) } : { body: text, notice: '' };
}
function createSpaceMessagePreview() {
  const panel = node('section', undefined, 'space-message-preview');
  panel.id = 'space-message-preview'; panel.setAttribute('popover', 'auto'); panel.setAttribute('role', 'region');
  ui.display.attribute(panel, 'aria-label', 'spacePreview.open');
  const trigger = uiButton('spacePreview.open', () => {
    renderSpaceMessagePreview(current(), true);
    panel.togglePopover();
    if (panel.matches(':popover-open')) close.focus({ preventScroll: true });
  });
  trigger.id = 'space-message-preview-button'; trigger.setAttribute('aria-controls', panel.id); trigger.setAttribute('aria-expanded', 'false');
  const close = uiButton('common.close', () => { panel.hidePopover(); trigger.focus({ preventScroll: true }); }, 'small');
  const heading = node('div', undefined, 'space-message-preview-heading');
  heading.append(uiNode('strong', 'spacePreview.open'), close);
  const list = node('div'), empty = uiNode('p', 'spacePreview.empty');
  panel.append(heading, uiNode('p', 'spacePreview.limit', undefined, 'quiet'), empty, list);
  panel.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(panel.matches(':popover-open'))));
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); event.stopPropagation(); panel.hidePopover(); trigger.focus({ preventScroll: true });
  });
  return { panel, trigger, list, empty, rows: new Map(), key: '' };
}
function renderSpaceMessagePreview(record, force = false) {
  const view = spaceMessagePreview;
  if (!view) return;
  const key = record ? JSON.stringify([record.id, record.nativeId]) : '';
  view.trigger.hidden = !record;
  if (key !== view.key) {
    if (view.panel.matches(':popover-open')) view.panel.hidePopover();
    view.list.replaceChildren(); view.rows.clear(); view.key = key;
  }
  if (!record || !force && !view.panel.matches(':popover-open')) return;
  const rows = spaceMessagePreviewRows(record.id), keep = new Set();
  view.empty.hidden = rows.length > 0;
  rows.forEach(({ room, message }, index) => {
    const id = JSON.stringify([room.id, message.id]); keep.add(id);
    let entry = view.rows.get(id);
    if (!entry) {
      const item = node('details'), summary = node('summary'), who = node('strong'), status = node('span'), meta = node('small'), body = node('pre'), notice = node('p', undefined, 'space-message-preview-notice');
      summary.append(who, status, meta); item.append(summary, notice, body); item.open = index === 0;
      entry = { item, who, status, meta, body, notice }; view.rows.set(id, entry);
    }
    // Keep each row and its chosen fold/selection during unrelated output updates.
    ui.display.computed(entry.who, 'text', () => roomMessageLabel(message));
    ui.display.computed(entry.status, 'text', () => spaceMessagePreviewStatus(message));
    ui.display.computed(entry.meta, 'text', () => `${spaceName(room)} · ${Number.isFinite(message.time) && Math.abs(message.time) <= 8640000000000000 ? new Date(message.time).toLocaleString(ui.language.getSnapshot().active) : uiText('reading.unknownTime')}`);
    ui.display.computed(entry.body, 'text', () => spaceMessagePreviewText(message).body);
    ui.display.computed(entry.notice, 'text', () => spaceMessagePreviewText(message).notice);
    entry.notice.hidden = !spaceMessagePreviewText(message).notice;
    if (view.list.children[index] !== entry.item) view.list.insertBefore(entry.item, view.list.children[index] || null);
  });
  for (const [id, entry] of view.rows) if (!keep.has(id)) { entry.item.remove(); view.rows.delete(id); }
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
    const openSession = uiButton('collab.openSession', () => { const s = current(); if (s && selected === 'room') return api.newWindow(s.id); });
    openSession.id = 'member-open-session'; ui.display.attribute(openSession, 'title', 'collab.openSessionHelp');
    compactMore.id = 'session-header-more'; ui.display.attribute(compactMore, 'aria-label', 'header.sessionMenu'); compactMore.setAttribute('aria-haspopup', 'menu'); compactMore.setAttribute('aria-expanded', 'false');
    compactMore.onpointerdown = event => { if (sessionMenu?.anchor === compactMore) event.stopPropagation(); };
    for (const control of [membership, selectedText, usage]) control.classList.add('header-secondary');
    spaceMessagePreview = createSpaceMessagePreview();
    headerControls = { resume, membership, selectedText, restore, more, usage, compactMore, openSession };
    $('header-actions').append(openSession, resume, membership, selectedText, spaceMessagePreview.trigger, spaceMessagePreview.panel, usage, restore, more, compactMore);
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
  // The butler stays outside every space: no "join" on it. If it is somehow in one, leaving stays offered.
  const isButler = Boolean(s && !s.archived && state.steward?.sessionId === s.id);
  if (isButler && !inSpace(s)) h.membership.hidden = true;
  const badge = $('steward-badge'); if (badge) { badge.hidden = !isButler; if (isButler) ui.display.computed(badge, 'text', () => '◆ ' + uiText('butler.name')); }
  ui.display.text(h.membership, s && inSpace(s) ? 'header.leave' : 'header.join');
  // Keep the original control and eligibility for the menu; only its header placement changes.
  h.membership.classList.toggle('membership-menu-only', Boolean(s && inSpace(s)));
  h.openSession.hidden = !inRoom || !s;
  h.openSession.disabled = disconnected;
  if (s) ui.display.attribute(h.openSession, 'aria-label', 'collab.openSessionNamed', { name: participantLabel(s, state.sessions) });
  h.restore.hidden = !s?.archived;
  h.more.hidden = !inRoom || !!s;
  h.more.disabled = disconnected || state.room.archived || renameTarget?.id === 'room' && renameTarget.roomId === spaceId;
  h.compactMore.hidden = !s;
  renderSpaceMessagePreview(s);
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
  return { setDisabled(value) { disabled = value; for (const input of form.querySelectorAll('input')) input.disabled = value; update(); } };
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
// 「等你」 row for a Codex question that does not block its turn: the session view's form and answer path.
function renderWaitingQuestion(parent, item) {
  const s = state.sessions.find(x => x.id === item.sessionId), approval = (s?.approvals || []).find(a => a.requestId === item.requestId);
  const questions = approval && window.nativeWorkspaceApproval.nativeApprovalPolicy(approval).questions;
  if (!questions) return;
  const answerable = s.provider === 'codex' && (s.serviceCapabilities || state.capabilities || []).includes('nativeQuestionAnswer') && !questions.some(q => q.isSecret);
  const key = JSON.stringify([s.nativeId, item.requestId, questions, answerable]);
  const open = ['approval', 'working', 'idle'].includes(s.state);
  if (parent.waitingQuestion?.key === key) {
    parent.waitingQuestion.form?.setDisabled(s.owner !== owner || Boolean(approval.pending) || !open || Boolean(s.approvalOverflow) || disconnected);
    return;
  }
  while (parent.children.length > 1) parent.lastChild.remove();
  parent.waitingQuestion = { key };
  if (answerable) {
    parent.waitingQuestion.form = appendQuestionForm(parent, questions, s.owner !== owner || Boolean(approval.pending) || !open || Boolean(s.approvalOverflow) || disconnected, answers => api.answer(s.id, item.requestId, answers));
  } else appendNativeQuestions(parent, questions);
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
        // A question that does not block the turn stays answerable while the turn works or after it ended (Workspace.answer).
        const open = s.state === 'approval' || window.nativeWorkspaceApproval.nonBlockingQuestion(s.approval) && ['working', 'idle'].includes(s.state);
        appendQuestionForm(el, policy.questions, !own || Boolean(s.approval.pending) || !open || Boolean(s.approvalOverflow), answers => api.answer(s.id, requestId, answers));
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
    ui.display.computed($('native-phase'), 'text', () => `${s.name} · ${uiText(recovery.reason === 'routing' ? 'native.routingTimeout' : recovery.reason === 'forbidden' ? 'native.forbidden' : recovery.reason === 'connection' ? 'native.connectionFailed' : 'native.capacity')}${recovery.status === 'exhausted' ? uiText('native.capacityLimit') : ''}`);
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
// A reported status turns stale 5 s after its last observation, and the window shows that once: render
// reads nativeStatusFresh. It stays stale until a newer snapshot, which renders anyway. Redrawing the
// whole window every second meanwhile kept an idle page busy for as long as any session waited on a
// long tool or a permission (2026-11-15), so only a status that has just turned stale redraws it.
let staleStatusKeys = new Set();
function newlyStaleStatus(sessions) {
  const keys = new Set();
  for (const s of sessions) for (const [kind, value] of [['activity', s.sharedActivity], ['approval', s.nativeApproval]]) {
    if (value && !nativeStatusFresh(value)) keys.add(`${s.id}\n${kind}\n${value.observedAt}`);
  }
  const added = [...keys].some(key => !staleStatusKeys.has(key));
  staleStatusKeys = keys;
  return added;
}
const nativeActivityClock = setInterval(() => {
  if (!state) return;
  taskBoard.tick();
  renderNativeActivity(current());
  if (selected === 'room') { roomOverview?.refresh(); refreshRoomMemberTabs(); }
  if (selected === 'panorama') panorama?.refresh();
  if (newlyStaleStatus(state.sessions)) render();
}, 1000);
function render() {
  if (!state || rendering) return;
  // A saved full-page records view opens as the new sidebar beside the members.
  const restoreStream = selected === 'room' && roomSurface === 'records' && Boolean(window.nativeWorkspaceActivityStream);
  if (restoreStream) roomSurface = 'overview';
  // The entry is not part of the window state: the window asks for it once here, and again on its own events.
  butlerEntry.start();
  if ($('butler-row')?.hidden === true && $('butler-review-dialog')?.open) $('butler-review-dialog').close();
  // The read log is reached from the entry: without the entry on screen it does not stay open.
  if ($('butler-row')?.hidden === true && $('butler-reads-dialog')?.open) $('butler-reads-dialog').close();
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
    renderPaneSwitches(s, inRoom);
    $('session-files').hidden = inRoom && !memberFocus;
    $('member-related-records').hidden = !memberFocus;
    document.title = sessionWindowTitle(s);
    $('welcome').hidden = Boolean(s || inRoom || inPanorama); $('session-view').hidden = !s; $('room-view').hidden = !inRoom;
    $('panorama-view').hidden = !inPanorama;
    $('panorama-nav').classList.toggle('active', inPanorama);
    $('panorama-nav').setAttribute('aria-pressed', String(inPanorama));
    $('return-panorama').hidden = !panoramaView.returning || inPanorama;
    if (inRoom && state.room.unavailable) ui.display.text($('title'), 'space.unavailable');
    else if (inRoom && s) ui.display.computed($('title'), 'text', () => archivedName(s));
    else if (inRoom) ui.display.computed($('title'), 'text', () => spaceName(state.room));
    else if (s?.name) ui.display.computed($('title'), 'text', () => archivedName(s));
    else ui.display.text($('title'), 'header.workspace');
    const warningText = (raw, message) => message ? ui.displayText(raw, message) : raw;
    const warning = () => [disconnected ? uiText('error.serviceDisconnectedNotice') : [warningText(state.storageWarning, state.storageWarningUiMessage), warningText(state.sessionNameWarning, state.sessionNameWarningUiMessage), warningText(state.roomStorageWarning, state.roomStorageWarningUiMessage), warningText(state.programWarning, state.programWarningUiMessage)].filter(Boolean).join(' '), warningText(state.viewStorageWarning, state.viewStorageWarningUiMessage)].filter(Boolean).join(' ');
    $('alert').hidden = !warning(); ui.display.computed($('alert'), 'text', warning);
    $('reconnect-button').hidden = !disconnected;
    $('retry-save').hidden = !state.viewStorageWarning && (disconnected || !state.storageRetryable);
    renderSessions(); renderCreateSpaces();
    renderArchives(); renderSpaceNavigation(); renderSpaceRail(); renderSpaceFiles(); renderQueue(); noteHandoffState();
    updateTaskBoard();
    if ($('session-chain-dialog').open) renderSessionChain();
    if ($('share-dialog').open) { populateSelect($('share-recipient'), members()); updateSharingControls(); }
    if ($('invite-dialog').open) for (const entry of $('invite-list').children) {
      const record = state.sessions.find(s => s.id === entry.dataset.inviteSession);
      if (record) ui.display.text(entry, entry.getAttribute('aria-disabled') === 'true' ? 'invite.legacyBlocked' : 'invite.joinName', { name: participantLabel(record, state.sessions) });
    }
    if ($('space-merge-dialog').open && mergeDialog?.sourceInputs) updateMergePreview();
    renderHeader(s, inRoom);
    if (inPanorama || panoramaView.returning) renderPanorama();
    if (inPanorama) {
      ui.display.text($('title'), 'panorama.title'); $('subtitle').textContent = '';
      document.title = uiText('panorama.windowTitle');
    }
    if (!s) renderNativeActivity(null);
    if (s) {
      const own = s.owner === owner; const alive = nativeUsable(s);
      if (inRoom && !$('native-pane-tabs').hidden) ui.display.computed($('native-pane-title'), 'text', () => participantLabel(s, state.sessions));
      else ui.display.text($('native-pane-title'), inRoom ? 'terminal.named' : 'terminal.native', { name: participantLabel(s, state.sessions) });
      ui.display.attribute($('native-pane-title'), 'title', 'terminal.named', { name: participantLabel(s, state.sessions) });
      // A focused member's conversation tab also shows the chat alone, whatever the saved split.
      for (const [id, key] of [['terminal-maximize', terminalLayout === 'maximized' ? 'terminal.restoreSplit' : 'terminal.maximize'], ['chat-maximize', !terminalVisible ? 'terminal.restoreSplit' : 'terminal.maximizeChat']]) {
        ui.display.attribute($(id), 'aria-label', key); ui.display.attribute($(id), 'title', key);
      }
      // The graphic follows the same layout state as the accessible name.
      $('terminal-maximize').toggleAttribute('data-restore', terminalLayout === 'maximized'); $('chat-maximize').toggleAttribute('data-restore', !terminalVisible);
      ui.display.computed($('session-status'), 'text', () => `${s.archived ? uiText('native.archived') : ''}${sessionStatus(s)}${s.provider === 'codex' && s.nativeVersionStatus === 'unverified' && !disconnected ? uiText('native.codexUnverified', { version: s.nativeVersion || uiText('native.versionMissing') }) : ''}${claudePinText(s)}${s.activity ? ' · ' + (s.activityUiMessage ? ui.displayText(s.activity, s.activityUiMessage) : s.activity) : ''}${!own && s.owner && !s.ownerPageless ? uiText('native.otherWindow') : ''}`);
      ui.display.computed($('session-status'), 'title', () => nativeVersionText(s));
      $('take-control').hidden = !heldElsewhere(s) || !alive;
      $('chat-tab').classList.toggle('active', mode === 'chat'); $('terminal-tab').classList.toggle('active', mode === 'terminal');
      $('terminal-controls').hidden = !terminalVisible;
      $('terminal-paste').disabled = !terminalCanInput(s.id) || !alive;
      $('messages').hidden = false; $('terminal-area').hidden = !terminalVisible; $('composer-wrap').hidden = false;
      renderComposer(s); takeFreeSession(soloComposer, s); renderNativeActivity(s);
      $('interrupt').hidden = !own || !(['working', 'approval'].includes(s.state) || s.capacityRecovery?.status === 'scheduled');
      ui.display.text($('interrupt'), s.capacityRecovery?.status === 'scheduled' ? 'native.cancelContinue' : 'native.interrupt');
      $('interrupt').disabled = interruptPending(s);
      readLegacyProgress(s);
      const visibleMessages = sessionMessages(s);
      const signature = JSON.stringify([s.name, state.sessions.filter(x => x.archived).map(x => x.id), visibleMessages, !visibleMessages.length && [s.state, Boolean(s.nativeApproval)]]);
      const readingKey = focusedReadingKey(s.id);
      // select() waits for the messages; should they still be missing, the list is hidden, never "no messages".
      if (s.messagesOmitted) { $('messages').hidden = true; lastMessages = ''; }
      else if (signature !== lastMessages || messageViews.get($('messages'))?.key !== readingKey) { messageList($('messages'), visibleMessages, false, readingKey); lastMessages = signature; }
      renderAdvanced(s);
      for (const id of terminals.keys()) syncTerminalMount(id);
      $('terminal-empty').hidden = terminals.has(s.id);
      // Without a terminal in this window: not started yet, ended, or (status line says
      // which: archived, background, disconnected…) simply none here.
      ui.display.text($('terminal-empty'), alive ? 'terminal.notStarted' : s.state === 'ended' ? 'terminal.endedEmpty' : 'terminal.noScreen');
      if (terminalVisible && alive && (mode === 'terminal' || s.terminalState?.alive || s.activeTurnId || hasAssistantMessage(s))) {
        // Mounting the same native display is passive; input still requires its
        // own focus/control claim. Never steal focus when the snapshot arrives.
        renderTerminal(s.id);
      }
    }
    if (inRoom) {
      const run = state.room.run;
      const people = orderedMembers();
      renderRoomMemberTabs(people);
      $('room-record').setAttribute('aria-pressed', String(roomSurface === 'records'));
      const pendingRun = roomSubmitting?.automatic;
      const waiting = roomPendingRecipients.get($('recipient').value) || roomPendingRecipients.values().next().value;
      $('run-status').parentElement.hidden = !run && !roomSubmitting && !waiting;
      const active = people.filter(person => {
        const activity = person.sharedActivity;
        if (disconnected || person.transportDisconnected || !['working', 'approval'].includes(person.state) ||
          !activity || !nativeStatusFresh(activity) || activity.nativeId !== person.nativeId || activity.turnId !== person.activeTurnId) return false;
        return true;
      }).map(person => ({ name: participantLabel(person, people), label: person.sharedActivity.label }));
      const mergePending = state.room.merge && !['ready', 'undone'].includes(state.room.merge.stage);
      if (active.length || mergePending) $('run-status').parentElement.hidden = false;
      ui.display.computed($('run-status'), 'text', () => {
        const statusKey = run?.pausePending ? 'room.revoking' : run?.pauseUnconfirmed ? 'room.pauseUnconfirmed' : { running: 'room.running', paused: 'room.paused', completed: 'room.completed' }[run?.status] || 'room.runUnknown';
        let text = run ? uiText('room.replies', { status: uiText(statusKey), steps: run.steps, max: run.maxSteps, reason: run.reason ? ' · ' + ui.displayText(run.reason, run.reasonUiMessage) : '' }) : '';
        const next = state.sessions.find(member => member.id === run?.awaiting?.sessionId);
        if (run?.status === 'running' && next) text += uiText('room.awaiting', { name: next.name });
        if (pendingRun && roomSubmitting.cancelling) text = uiText('room.cancelling');
        else if (pendingRun && run?.status !== 'running') text = uiText('room.preparing');
        if (waiting && !pendingRun) text = uiText(waiting.queued ? waiting.midturn ? 'room.queuedMidturn' : 'room.queued' : 'room.sending', { name: waiting.recipientName });
        // The native side reports a state name (inProgress, commandExecution); show its text in the person's language,
        // as the session header does. A label with no entry is native text, such as a permission title, and stays as it is.
        if (active.length) text = [text, ...active.map(member => `${member.name} · ${Object.hasOwn(nativeActivityLabels, member.label) ? uiText(nativeActivityLabels[member.label]) : member.label}`)].filter(Boolean).join(' · ');
        if (mergePending) text = [text, uiText('room.mergePending')].filter(Boolean).join(' · ');
        return text;
      });
      $('pause-button').hidden = !run && !roomSubmitting;
      renderTimeline();
      renderRoomImageDraft();
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
      ui.display.text($('forward-button'), nativeRoute ? (nativeUsable(recipient) ? 'composer.terminal' : 'reading.viewSession') : interruptPending(recipient) ? 'composer.waitInterrupt' : recipient?.pendingQueue ? 'composer.waitNative' : roomQueueAvailable(recipient) ? recipient.midturnAvailable ? 'composer.queueMidturn' : 'composer.queue' : roomSteerAvailable(recipient) ? 'composer.steer' : 'composer.send');
      const recipientPending = roomPendingRecipients.has(recipient?.id);
      const mergeBlocked = roomMergeBlocked();
      const hasDraftImages = roomImageRefs().length > 0;
      const unavailable = mergeBlocked || roomSubmitting || recipientPending || disconnected || (!hasDraftImages && !nativeWorkspaceMentions.body(roomMention, $('shared-input').value).trim());
      const threadUnsupported = roomReplyTo && (!roomThreads.rows.has(roomReplyTo) || (recipient && !recipient.legacyShare && !recipient.serviceCapabilities?.includes('replyThreads')));
      const ready = roomRecipientReady;
      const manualErrorReady = roomManualErrorReady(recipient);
      $('forward-button').disabled = nativeRoute ? mergeBlocked || roomSubmitting || recipientPending || disconnected : unavailable || (!ready(recipient) && !manualErrorReady && !roomQueueAvailable(recipient) && !roomSteerAvailable(recipient)) || Boolean(threadUnsupported);
      const otherRun = allSpaces().find(r => r.id !== spaceId && r.run?.status === 'running');
      $('run-button').disabled = unavailable || roomPendingRecipients.size > 0 || !recipient || !ready(recipient) || run?.status === 'running' || run?.pausePending || run?.pauseUnconfirmed || !safeHandoffs || Boolean(threadUnsupported) || Boolean(otherRun);
      if (hasDraftImages) { $('forward-button').disabled ||= !roomImageForwardAvailable(recipient) || Boolean(roomViews[spaceId]?.roomImageSend); $('run-button').disabled = true; }
      if (roomViews[spaceId]?.roomImagesImporting) { $('forward-button').disabled = true; $('run-button').disabled = true; }
      ui.display.computed($('run-help'), 'text', () => {
        let text = recipient ? uiText('room.sendHint', { name: participantLabel(recipient) }) : uiText(roomMention?.active === false ? 'room.recipientChanged' : 'room.chooseRecipientHelp');
        if (roomQueueAvailable(recipient) || recipient?.pendingQueue) text += uiText('room.queueHelp');
        if (roomSteerAvailable(recipient)) text += uiText('room.steerHelp');
        if (manualErrorReady) text += uiText('room.failedHelp');
        if (recipient?.legacyShare && !recipient.legacySharedReply) text += uiText('room.legacyReplyHelp');
        if (nativeRoute) text = uiText(recipient?.nativeInputRequired ? 'room.nativeInputRequired' : 'room.nativeRouteHelp');
        if (interruptPending(recipient)) text = uiText('composer.interruptHint');
        if (threadUnsupported) text = uiText(roomThreads.rows.has(roomReplyTo) ? 'room.threadUnsupported' : 'room.threadMissingHelp');
        if (hasDraftImages) text = uiText(roomViews[spaceId]?.roomImageSend ? 'roomImages.unconfirmed' : roomImageForwardAvailable(recipient) ? 'roomImages.sendHint' : 'error.roomImages.deliveryUnavailable');
        if (roomViews[spaceId]?.roomImagesImporting) text = uiText('roomImages.importing');
        return text;
      });
      ui.display.computed($('run-button'), 'title', () => otherRun ? uiText('room.otherReview', { name: otherRun.name }) : safeHandoffs ? uiText('room.runPreviewHelp') : state.handoffNotice ? ui.displayText(state.handoffNotice, state.handoffNoticeUiMessage) : uiText('room.runUnsupported'));
      ui.display.text($('pause-button'), run?.pauseUnconfirmed ? 'room.recheckPause' : pendingRun && run?.status !== 'running' ? 'room.cancelWait' : 'room.pauseHandoffs');
      $('pause-button').disabled = Boolean(roomSubmitting?.cancelling) || Boolean(run?.pausePending) || (!pendingRun && run?.status !== 'running' && !run?.pauseUnconfirmed);
      if (!$('mention-list').hidden && mentionRoster !== mentionRosterKey()) showMentions();
      renderRoomOverview();
    }
    for (const [id, entry] of terminals) entry.term.options.disableStdin = !(terminalCanInput(id) || canFlushComposition(id));
    const approvalTarget = sharedSurface() ? (s?.nativeApproval || s?.approval || s?.state === 'approval' ? s : members().find(person => person.id === roomRecipient())) : s;
    const approvalParent = sharedSurface() ? $('room-record-view') : $('conversation-pane');
    if ($('approval').parentElement !== approvalParent) approvalParent.prepend($('approval'));
    renderApproval(approvalTarget, approvalTarget?.owner === owner);
    renderRename(); updateSelectedSharing();
    if (removedRoomFocus) focusRemainingMember(removedRoomFocus.origin, removedRoomFocus.index);
  } finally { restoreVisibleReading(); rendering = false; reportShown(); const stream = getActivityStream(); if (restoreStream) stream?.open(spaceId); else stream?.render(); }
}
async function switchMode(next, takeControl = false) {
  captureReadingViews();
  const s = current(); if (!s) return;
  if (next === 'terminal' && terminalLayout === 'hidden' || next === 'chat' && terminalLayout === 'maximized') terminalLayout = 'split';
  const revision = ++selectionRevision;
  const entry = terminals.get(s.id);
  if (entry?.composing) entry.term.blur();
  const ending = entry?.composition;
  const stillSelected = () => revision === selectionRevision && activeSessionId() === s.id;
  // A terminal this window controls takes keys at once (terminalCanInput); the view change below only follows it.
  if (next === 'terminal' && s.owner === owner && (ending || entry?.ready && currentTerminalDisplay(entry, s))) { mode = 'terminal'; render(); focusTerminal(s.id); }
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
    if ((takeControl || !heldElsewhere(s)) && !await claimView(s.id, next, revision, takeControl)) return;
    if (!stillSelected()) return;
    mode = next; preference = next; clearFailedTerminal(s.id); render(); await persistView();
    if (!stillSelected()) return;
    if (next === 'terminal') { await ensureTerminal(s.id, true); if (stillSelected()) focusTerminal(s.id); }
    else if (inputFocusAllowed()) chatInput().focus();
  } finally {
    if (pendingMode?.revision === revision) { pendingMode = undefined; render(); }
  }
}
// Repaints observe one pending mount per native connection. Adding a new async
// waiter in render() on every state update would retain that render's complete
// session history until a slow/blocked terminal snapshot finally arrives.
// Explicit user actions still await ensureTerminal directly.
function renderTerminal(id, column = false) {
  const { nativeId, connectionRevision = 0 } = state.sessions.find(s => s.id === id) || {};
  const pending = terminalRenderLoads.get(id);
  if (pending && pending.nativeId === nativeId && pending.generation === connectionRevision && pending.entry === terminals.get(id)) {
    pending.column ||= column;
    syncTerminalMount(id);
    return;
  }
  const load = { nativeId, generation: connectionRevision, column };
  terminalRenderLoads.set(id, load);
  const operation = ensureTerminal(id);
  load.entry = terminals.get(id);
  operation.catch(error => {
    if (terminalRenderLoads.get(id) === load && (load.column || mode === 'terminal')) toastError(error);
  }).finally(() => { if (terminalRenderLoads.get(id) === load) terminalRenderLoads.delete(id); });
}
async function ensureTerminal(id, explicit = false) {
  const record = state.sessions.find(s => s.id === id);
  // Recovery can announce its new generation before the runtime is installed.
  // Wait for its runtime, while preserving an already-live native display.
  if (record?.recovering && !record.terminalAvailable && !record.terminalState?.alive) return;
  const generation = record?.connectionRevision || 0;
  const old = terminals.get(id);
  if (old && (old.generation !== generation || old.nativeId !== record?.nativeId)) { old.term.dispose(); old.element.remove(); terminals.delete(id); }
  if (old?.waitingForFirstTurn && terminals.get(id) === old &&
      (record?.activeTurnId && record.activeTurnId !== old.firstTurnAttemptId || hasAssistantMessage(record) && !old.firstTurnHadOutput)) {
    // A first-message instruction never launched a display. Once that same
    // native thread has real output, the visible pane can attach without a seed.
    old.term.dispose(); old.element.remove(); terminals.delete(id);
  }
  // A repaint never restarts a native display. Only an explicit view action can
  // replace its cached screen, after the backend reports the display lifetime.
  if (explicit && old?.ready && terminals.get(id) === old && !currentTerminalDisplay(old, record)) {
    if (record.owner !== owner || record.backendUnavailable || record.transportDisconnected || disconnected) throw uiError("error.sessionControl");
    if (record.terminalState?.alive === false && !record.terminalState.exitConfirmed) throw uiError("error.oldTerminalPending");
    old.term.dispose(); old.element.remove(); terminals.delete(id);
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
  const textLinks = window.nawCmdLinks.bindTerminal(term, { api, onError: toastError });
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
    selection.shouldForceSelection = event => textLinks.shouldForceSelection(event) || !terminalCanInput(id) || mouse?.activeEncoding === 'DEFAULT' || nativeForce(event);
  }
  const intent = selectionRevision;
  const entry = { element, term, fit, generation, nativeId: record?.nativeId, ready: false, sequence: 0, queued: [], firstTurnAttemptId: record?.activeTurnId, firstTurnHadOutput: hasAssistantMessage(record) }; terminals.set(id, entry); syncTerminalMount(id);
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
  // A person reading a column keeps its position through passive native output.
  // Keyboard/IME input returns to the original cursor-follow behavior.
  surface.addEventListener('pointerdown', event => { if (event.button === 0) { if (columnTerminalBinding(id)) entry.columnReading = true; claimTerminalFocus(); } }, true);
  surface.addEventListener('focusin', claimTerminalFocus);
  surface.addEventListener('wheel', event => {
    if (columnTerminalBinding(id) && (event.deltaX || event.deltaY)) entry.columnReading = true;
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
    if (/^\x1b\[[?>]?[\d;]*[cRn]$/.test(data) || /^\x1b\[\??\d+;[0-4]\$y$/.test(data) || /^\x1b\[[IO]$/.test(data) || /^\x1b\]/.test(data)) return;
    const token = entry.composition;
    if (token?.cancelled) return;
    const finishing = canFlushComposition(id, token);
    if (terminals.get(id) !== entry || (!terminalCanInput(id) && !finishing)) return;
    // Also on this ordinary path: the next composition may have begun before xterm handed over these commits.
    const commits = takeCommits(data, finishing);
    for (const commit of commits) commit.consumed = true;
    const input = api.input(id, data);
    for (const commit of commits) commit.input = input;
    input.catch(error => { if (commits.length) preserveUnconfirmed(data, error); else toastError(error.message ? error : uiError('error.nativeInputUnconfirmed')); });
  });
  // Commits whose check after compositionend is still waiting, oldest first. A busy page handles the next keys before
  // its 0 ms timers, so xterm can hand over a commit after the next composition began, or several commits in one piece.
  // Data takes the commits whose text it holds, in order, through the newest. When no composition is open
  // (`finishing`), data that does not hold that text still takes the newest commit, as it always did. Any other
  // commit stays waiting, and its check says it was not sent: a paste or mouse report that arrives while the next
  // composition is open does not stand for the phrase before it.
  // Defined after the callback above, which only runs once input arrives.
  entry.commits = [];
  const takeCommits = (data, finishing) => {
    const newest = entry.composition, taken = [];
    let rest = data;
    for (const commit of entry.commits) {
      if (commit === newest || commit.consumed || commit.cancelled) continue;
      if (!commit.text || !rest.startsWith(commit.text)) break;
      taken.push(commit); rest = rest.slice(commit.text.length);
    }
    if (!newest || newest.consumed) return taken;
    if (newest.text && rest.startsWith(newest.text)) return [...taken, newest];
    return finishing ? [newest] : [];
  };
  let confirmingEnter = false, blurValue, compositionSequence = 0;
  element.addEventListener('compositionstart', () => { entry.columnReading = false; entry.composing = true; compositionSequence++; entry.compositionOrigin = { cancelled: false }; }, true);
  element.addEventListener('compositionend', event => {
    entry.composing = false;
    // Bubble after xterm's target listener: its textarea commit timer must run
    // before this barrier. Microtasks can run between native event listeners.
    const token = { sequence: compositionSequence, consumed: false, text: event.data, cancelled: Boolean(entry.compositionOrigin?.cancelled) };
    token.done = new Promise((resolve, reject) => setTimeout(async () => {
      try {
        if (!token.consumed && token.text) {
          const error = uiError("error.inputNotSentCheck");
          preserveUnconfirmed(token.text, error); throw error;
        }
        await token.input; resolve();
      } catch (error) { reject(error); }
      finally {
        const at = entry.commits.indexOf(token); if (at >= 0) entry.commits.splice(at, 1);
        if (entry.composition === token) { entry.composition = null; render(); if (entry.fitPending) { entry.fitPending = false; fitTerminal(id); } }
      }
    }, 0));
    token.done.catch(() => {}); // Navigation may not be awaiting this origin.
    entry.composition = token; entry.commits.push(token);
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
    if (event.type === 'keydown' && !event.metaKey && !event.isComposing && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key) && columnTerminalBinding(id)) entry.columnReading = false;
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
      validateTerminalFrame(snapshot);
      term.resize(snapshot.cols || 100, snapshot.rows || 30);
      if (snapshot.cursorModesVersion === 1) term.options.cursorBlink = false;
      await new Promise(resolve => term.write(snapshot.buffer, resolve));
      if (terminals.get(id) !== entry) return;
      live = state.sessions.find(s => s.id === id)?.terminalState;
      if (snapshot.epoch && live?.epoch && snapshot.epoch !== live.epoch) throw uiError("error.terminalViewChanged");
      restoreTerminalContinuation(term, snapshot);
      entry.keyboardFlags = snapshot.keyboardFlags || 0;
      if (terminals.get(id) !== entry) return;
      live = state.sessions.find(s => s.id === id)?.terminalState;
      if (snapshot.epoch && live?.epoch && snapshot.epoch !== live.epoch) throw uiError("error.terminalViewChanged");
      entry.observationIndex = Number.isSafeInteger(snapshot.observationIndex) && snapshot.observationIndex >= 0 && Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 0 && typeof snapshot.epoch === 'string' && snapshot.epoch ? snapshot.observationIndex : undefined;
      entry.sequence = snapshot.sequence; entry.ready = true;
      flushTerminalEvents(entry);
      loading.remove(); surface.hidden = false; surface.inert = false;
      render(); const column = columnTerminalBinding(id); if (!column) { fitTerminal(id); if (intent === selectionRevision) focusTerminal(id); } else { fitColumnTerminalWidth(column); revealTerminalCursor(entry); }
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
  if (!entry?.ready || entry.restoring) return;
  if (s?.owner !== owner) { entry.nativeSize = undefined; return; }
  const column = columnTerminalBinding(id);
  if (column && !currentTerminalDisplay(entry, s)) return;
  if (column ? !column.resizeAllowed : activeSessionId() !== id || terminalLayout === 'hidden') return;
  if (entry.composing || entry.composition) { entry.fitPending = true; return; }
  if (entry.fitScheduled) return;
  entry.fitScheduled = true;
  requestAnimationFrame(() => {
    entry.fitScheduled = false;
    const latest = state.sessions.find(s => s.id === id);
    const binding = columnTerminalBinding(id);
    if (terminals.get(id) !== entry || (column ? binding !== column || !column.resizeAllowed : activeSessionId() !== id || terminalLayout === 'hidden') || !entry.element.isConnected || !entry.element.checkVisibility() || latest?.owner !== owner) return;
    if (entry.restoring || column && (!currentTerminalDisplay(entry, latest) || entry.element.clientWidth <= 0 || entry.element.clientHeight <= 0)) return;
    if (entry.composing || entry.composition) { entry.fitPending = true; return; }
    const dimensions = entry.fit.proposeDimensions();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
    // Keep the display and native PTY on the same bounded grid. An undersized
    // pane reads that original grid through the surface's local overflow.
    if (column) column.resizeAllowed = false;
    entry.term.resize(Math.max(20, Math.min(400, dimensions.cols)), Math.max(5, Math.min(200, dimensions.rows)));
    if (column) entry.columnFit = JSON.stringify([entry.element.clientWidth, entry.term.cols, entry.term.rows]);
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
function restoreTerminalContinuation(term, frame) {
  if (frame.continuation == null) return;
  validateTerminalFrame(frame);
  try { window.nativeWorkspaceTerminalContinuation.restore(term, frame.continuation); }
  catch { throw uiError("error.legacy.nativeScreenInvalid"); }
}
function validateTerminalFrame(frame) {
  if (frame.continuation == null) return;
  try {
    const helper = window.nativeWorkspaceTerminalContinuation;
    if (helper.validate(frame.continuation) && helper.frameBytes({ buffer: frame.buffer, continuation: frame.continuation }) > helper.MAX_BYTES) throw Error();
  } catch { throw uiError("error.legacy.nativeScreenInvalid"); }
}
function flushTerminalEvents(entry) {
  const queued = entry.queued; entry.queued = [];
  for (const event of queued) { if (entry.failed) break; writeTerminal(entry, event); }
}
function writeTerminal(entry, event) {
  if (entry.failed) return;
  const indexed = Number.isSafeInteger(entry.observationIndex) && entry.observationIndex >= 0;
  // Native key encoding follows the newest accepted header, even while older
  // screen output waits for parsing. Replaying that output must not roll it back.
  const keyboardStamp = entry.keyboardStamp;
  if (event.kind !== 'resize' && typeof event.data === 'string' &&
      (!entry.epoch || event.epoch === entry.epoch) &&
      Number.isSafeInteger(event.sequence) && event.sequence > entry.sequence &&
      (!indexed || event.index === undefined || Number.isSafeInteger(event.index) && event.index > entry.observationIndex) &&
      (!keyboardStamp || keyboardStamp.epoch !== event.epoch || event.sequence > keyboardStamp.sequence)) {
    entry.keyboardFlags = event.keyboardFlags || 0;
    entry.keyboardStamp = { epoch: event.epoch, sequence: event.sequence };
  }
  if (entry.ready === false || entry.restoring) { entry.queued.push(event); return; }
  if (indexed) {
    if (event.epoch !== entry.epoch || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return;
    if (!(event.index === undefined && event.kind !== 'resize' && typeof event.data === 'string' && event.sequence > entry.sequence)) {
      if (!Number.isSafeInteger(event.index) || event.index <= entry.observationIndex) return;
      if (event.kind === 'resize') {
        if (event.sequence < entry.sequence || !Number.isInteger(event.cols) || event.cols < 20 || event.cols > 400 || !Number.isInteger(event.rows) || event.rows < 5 || event.rows > 200 || terminals.get(event.id) !== entry) return;
        entry.observationIndex = event.index;
        entry.term.write('', () => { if (terminals.get(event.id) === entry && event.epoch === entry.epoch) entry.term.resize(event.cols, event.rows); });
        return;
      }
      if (typeof event.data !== 'string' || event.sequence <= entry.sequence) return;
    }
  }
  if ((entry.epoch && event.epoch !== entry.epoch) || event.sequence <= entry.sequence) return;
  if (event.kind === 'snapshot' && event.continuation !== undefined) {
    if (terminals.get(event.id) !== entry || !Number.isInteger(event.cols) || event.cols < 20 || event.cols > 400 || !Number.isInteger(event.rows) || event.rows < 5 || event.rows > 200) return;
    try { validateTerminalFrame({ buffer: event.data, continuation: event.continuation }); }
    catch (error) { entry.failed = true; entry.ready = false; entry.queued = []; render(); toastError(error); return; }
    // Queue later output while restoring, without withdrawing already-owned
    // input. Initial loading and invalid native views still use ready=false.
    entry.restoring = true;
    entry.sequence = event.sequence;
    if (indexed) entry.observationIndex = event.index;
    entry.pending = new Promise((resolve, reject) => entry.term.write('', () => {
      if (terminals.get(event.id) !== entry || (entry.epoch && event.epoch !== entry.epoch)) {
        if (terminals.get(event.id) === entry) { entry.restoring = false; entry.ready = false; render(); }
        resolve(); return;
      }
      try {
        entry.term.resize(event.cols, event.rows);
        entry.term.write(event.data, () => {
          if (terminals.get(event.id) !== entry || (entry.epoch && event.epoch !== entry.epoch)) {
            if (terminals.get(event.id) === entry) { entry.restoring = false; entry.ready = false; render(); }
            resolve(); return;
          }
          try {
            restoreTerminalContinuation(entry.term, { buffer: event.data, continuation: event.continuation });
            entry.restoring = false; flushTerminalEvents(entry); render(); resolve();
          } catch (error) { reject(error); }
        });
      } catch (error) { reject(error); }
    })).catch(error => {
      if (terminals.get(event.id) !== entry) return;
      entry.failed = true; entry.ready = false; entry.restoring = false; entry.queued = [];
      render(); toastError(error);
    });
    return;
  }
  entry.term.write(event.data, () => {
    if (document.activeElement === entry.term.textarea && !entry.columnReading && (!entry.term.buffer?.active || entry.term.buffer.active.viewportY === entry.term.buffer.active.baseY)) revealTerminalCursor(entry);
  });
  entry.sequence = event.sequence;
  if (indexed) entry.observationIndex = event.index;
}
const disposers = [
  () => recordReminders?.dispose(),
  () => taskBoard.dispose(),
  () => discoveriesView?.dispose(),
  () => mobileSetup.dispose(),
  () => butlerEntry.dispose(),
  disposeButlerReview,
  () => butlerReads.dispose(),
  disposeToastKeyboard,
  api.onProgress(updateLegacyProgress),
  api.onTerminal(event => { const entry = terminals.get(event.id); if (!entry || entry.failed) return; if (!entry.ready) entry.queued.push(event); else writeTerminal(entry, event); }),
  // Waiters resume in a microtask, after this render has updated the buttons.
  api.onState(next => { updateState(next); stateArrived(); render(); }),
  api.onSessionName(({ id, name }) => {
    const record = state?.sessions.find(s => s.id === id);
    if (record) { record.name = name; render(); }
  }),
  api.onDisconnected((message, uiMessage) => { disconnected = true; for (const s of state?.sessions || []) freezeLegacyProgress(s); render(); toastError({ message, uiMessage }); }),
  api.onQuitStatus(key => { if (['os.butlerQuitWaiting', 'os.butlerQuitUnconfirmed'].includes(key)) toastMessage(key); }),
  api.onViewStorage((warning, uiMessage) => { latestViewStorage = warning; latestViewStorageUiMessage = uiMessage; if (state) { state.viewStorageWarning = warning; state.viewStorageWarningUiMessage = uiMessage; render(); } }),
  api.onReconnected(next => { for (const s of state?.sessions || []) freezeLegacyProgress(s); disconnected = false; updateState(next); render(); }),
  api.onBackendSwitched(notice => { toast(''); ui.display.computed($('toast-text'), 'text', () => backendSwitchedText(notice)); }),
  api.onNew(() => openCreate()),
  api.onSwitchMode(next => {
    if (!['chat', 'terminal'].includes(next) || document.querySelector('dialog:modal')) return;
    if (visibleModeControl(next)) attempt(() => switchMode(next));
  }),
  api.onRevealRecord(target => attempt(() => target?.sessionId ? showBackgroundConfirmation(target) : showRoomRecord(target?.roomId, target?.eventId))),
];
sidebarLayout = window.nativeWorkspaceSidebar.bind({ navigation: document.querySelector('.sidebar-navigation'), groups: ['sessions-group', 'workspace-group', 'archive-group'].map($), sashes: ['sidebar-session-sash', 'sidebar-workspace-sash'].map($), onCommit: weights => api.sidebar({ type: 'resize', weights }), displayTitle: (element, params) => ui.display.attribute(element, 'title', 'sidebar.resizeHelp', params), onError: toastError });
disposers.push(() => sidebarLayout.dispose());
// A drag resizes the native terminal once, on release, not on every move. The sidebar opening or closing changes
// the header row's width with no window resize: the row is fitted again on the next frame, not inside the observer.
const observer = new ResizeObserver(entries => { if (entries.some(e => e.target === $('terminal-area')) && activeSessionId() && !splitDragging) fitTerminal(activeSessionId()); if (entries.some(e => e.target === $('collaboration-overview'))) refreshColumnTerminalHeights(); if (entries.some(e => e.target === $('room-tabs'))) requestAnimationFrame(() => fitRoomTabs(true)); }); observer.observe($('terminal-area')); observer.observe($('collaboration-overview')); observer.observe($('room-tabs'));
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
$('choose-folder').onclick = () => attempt(async () => { const ticket = dialogTickets.get($('create-dialog')); if (ticket) delete ticket.directoryDefaults; const value = await api.chooseFolder(); if (value && currentDialogTicket(ticket)) { folder = value; newDirectory = false; invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder; if ($('git-worktree').checked) await refreshGitPreview(); else createReadiness(); } });
$('git-worktree').onchange = () => { invalidateGitPreview(true); $('git-worktree-relative').value = ''; $('chosen-folder').textContent = folder; if ($('git-worktree').checked) refreshGitPreview(); else createReadiness(); };
$('git-worktree-relative').oninput = scheduleGitPreview;
$('new-folder').onclick = () => { if (!creatingSession) { resetCreateDirectory(); createReadiness(); } };
$('create-form').onsubmit = event => { event.preventDefault();
  const ticket = dialogTickets.get($('create-dialog')), revision = selectionRevision;
  if (creatingSession || !currentDialogTicket(ticket) || ticket.directoryDefaults) return;
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
  try { const provider = chosenProvider();
    // A DSH session opens in its terminal (it has no conversation view yet) and leaves the remembered view alone.
    let view = preference;
    if (provider === 'codex') view = $('initial-view').value;
    if (provider === 'dsh') view = 'terminal';
    else preference = view;
    // DeepSeek at its highest effort (the person, 2026-11-13); DeepSeek refuses Codex's ultra.
    const settings = deepseekChosen() ? { profile: $('create-profile').value, effort: 'max' } : undefined;
    const id = createdId = await api.create({ provider, cwd: worktree?.source || folder, name: $('session-name').value, view, ...(worktree ? { gitWorktree: worktree } : newDirectory ? { newDirectory: true } : {}), skipPermissions: provider === 'dsh' ? undefined : $('skip-permissions').checked || undefined, ...(settings ? { settings } : {}) }); updateState(await api.initial()); render();
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
  draft.previewPending = true; $('preview-space-merge').disabled = true; mergeError('');
  try {
    const batch = await api.spaceMerge('preview', mergeSpec());
    if (!currentDialogTicket(ticket)) { api.spaceMerge('discard', { operationId: batch.operationId }).catch(() => {}); return; }
    draft.batch = batch; mergeButtons(true); renderMergeBatch(batch); $('confirm-space-merge').focus();
  } catch (error) { if (currentDialogTicket(ticket)) mergeError(error); else toastError(error); }
  finally { draft.previewPending = false; if (currentDialogTicket(ticket)) updateMergePreview(); }
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
  const submittedName = $('space-create-name').value;
  $('confirm-space-create').disabled = true; $('space-create-error').hidden = true;
  try {
    const id = await api.spaceCreate(submittedName); updateState(await api.initial()); render();
    if (currentDialogTicket(ticket) && $('space-create-name').value === submittedName) { $('space-create-dialog').close(); await selectSpace(id); }
    else toastMessage("toast.createdSpaceRetained");
  } catch (error) { if (currentDialogTicket(ticket)) { ui.showError($('space-create-error'), error); $('space-create-error').hidden = false; } else toastError(error); }
  finally { if (currentDialogTicket(ticket)) $('confirm-space-create').disabled = false; }
}); };
$('workspace-group').addEventListener('contextmenu', event => {
  if (event.defaultPrevented || event.target.closest('.room-row, #rename-editor')) return;
  event.preventDefault(); event.stopPropagation(); openSpaceRegionMenu({ x: event.clientX, y: event.clientY });
});
$('workspace-toggle').addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); event.stopPropagation(); openSpaceRegionMenu(undefined, $('workspace-toggle')); } });
for (const [id, view] of [['sessions-flat', 'flat'], ['sessions-grouped', 'grouped'], ['sessions-folders', 'folder']]) $(id).onclick = () => { sidebarView = view; sessionMenu?.close(); render(); attempt(persistView); $(id).focus(); };
$('room-nav').onclick = () => attempt(() => selectSpace('shared'));
$('panorama-nav').onclick = () => attempt(openPanorama);
$('create-first-space').onclick = openSpaceCreate;
$('return-panorama').onclick = () => attempt(returnToPanorama);
$('room-more').onclick = () => openRoomMenu(undefined, $('room-more'), 'shared');
$('room-more').onpointerdown = event => { if (roomMenu) event.stopPropagation(); };
$('room-nav').oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); openRoomMenu({ x: event.clientX, y: event.clientY }, $('room-more'), 'shared'); };
$('room-nav').onkeydown = event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openRoomMenu(undefined, $('room-more'), 'shared'); } };
$('room-overview').onclick = () => attempt(() => {
  if (focusedRoomMember()) { roomOverview.focus(''); return; }
  captureReadingViews(); rememberRoomMemberView(); roomRecordScope = ''; roomRecordReturn = null; roomSurface = 'overview'; return selectRoom('', true);
});
$('room-record').onclick = () => attempt(() => showRoomRecords());
$('room-tabs').addEventListener('keydown', roomNavigationKey);
$('member-related-records').onclick = () => attempt(() => showRoomRecords(true));
$('room-record-return').onclick = () => attempt(returnRoomRecordMember);
$('room-record-clear').onclick = () => attempt(clearRoomRecordFilter);
$('room-record-restore').onclick = () => attempt(restoreRoomRecordFilter);
$('manage-members').onclick = () => openInvite($('manage-members'));
$('room-member-status').onclick = openRoomMemberStatus;
$('close-room-member-status').onclick = () => $('room-member-status-dialog').close();
$('room-member-status-dialog').addEventListener('close', () => {
  if ($('room-member-status-dialog').open) return;
  const restoreFocus = roomMemberStatusContext?.key === roomMemberStatusKey();
  roomMemberStatusContext = null;
  $('room-member-status').setAttribute('aria-expanded', 'false');
  if (restoreFocus && $('room-member-status').getClientRects().length) $('room-member-status').focus({ preventScroll: true });
});
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
$('open-native-terminal').onclick = () => attempt(() => switchMode('terminal'));
$('return-to-chat').onclick = () => attempt(() => switchMode('chat'));
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
// The first 15 files in the order they were added; each press brings the next 15 below them.
let spaceFilesShown = 15, spaceFilesPager = null;
function openSpaceFiles() {
  filesSpace = spaceId; spaceFilesShown = 15; $('space-files-list').dataset.signature = ''; renderSpaceFiles(); openTransientDialog('space-files-dialog');
}
function renderSpaceFiles() {
  if (!filesSpace) return;
  const room = spaceRecord(filesSpace); if (!room) return;
  ui.display.text($('space-files-title'), 'files.titleName', () => ({ name: spaceName(room) }));
  $('add-space-files').disabled = disconnected || room.archived;
  const files = room.files || [], shown = files.slice(0, spaceFilesShown);
  const signature = JSON.stringify([files, spaceFilesShown]), list = $('space-files-list');
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.replaceChildren(...shown.map(file => {
      const row = node('div', undefined, 'space-file-row'), open = button(file.name, async () => { $('space-files-dialog').close(); if (spaceId !== filesSpace) await selectSpace(filesSpace); await openLocalFile(true, file.id); }); open.title = file.path;
      const remove = uiButton('files.remove', async () => { await api.spaceAction(filesSpace, 'removeFile', [file.id, remove.fileRevision]); updateState(await api.initial()); renderSpaceFiles(); });
      row.append(open, remove); return row;
    }));
    if (!list.children.length) list.append(uiNode('p', 'files.empty', undefined, 'quiet'));
  }
  for (const [index, file] of shown.entries()) {
    const remove = list.children[index].lastElementChild;
    remove.disabled = room.archived;
    remove.fileRevision = room.metadataRevision;
    ui.display.attribute(remove, 'aria-label', 'files.removeAction', () => ({ space: spaceName(room), file: file.name }));
  }
  if (!spaceFilesPager) {
    spaceFilesPager = window.nativeWorkspaceDisclosure.pager({ document, key: 'disclosure.more', say: (el, key, params) => ui.display.text(el, key, params), onMore: () => {
      const first = spaceFilesShown;
      spaceFilesShown += 15;
      renderSpaceFiles();
      $('space-files-list').children[first]?.firstElementChild?.focus();
    } });
    list.after(spaceFilesPager.button, spaceFilesPager.status);
  }
  spaceFilesPager.show({ count: Math.min(15, files.length - shown.length), total: files.length, shown: shown.length });
}
$('close-space-files').onclick = () => $('space-files-dialog').close();
$('add-space-files').onclick = () => attempt(async () => { const id = filesSpace; await api.spaceFiles(id); updateState(await api.initial()); if (filesSpace === id) renderSpaceFiles(); });
// Space task queue: the person adds items; NAW sends each idle member its next one.
let queueSpace = null;
const QUEUE_FINISHED_SHOWN = 10;
// Finished tasks shown before the latest ten, as the person goes back a page at a time; every one can be reached.
let queueEarlier = 0;
function openQueue(requested) {
  queueSpace = typeof requested === 'string' ? requested : spaceId;
  queueOrder = null; queueOrderFresh = false; queueOpens += 1; queueDropping = ''; queueEarlier = 0;
  queueHandoffError(null);
  $('queue-list').dataset.signature = '';
  renderQueue();
  openTransientDialog('queue-dialog');
  loadHandoff();
}
// B6: the integration handoff in the queue panel. The view is the person's own (the main process
// refuses an agent's call) and is read for the space on screen, only where the state says that
// handoffs are enabled; elsewhere nothing is asked and the panel stays as it was.
let handoffView = null, handoffReading = null, handoffAgain = false, handoffTimer = null, handoffKey = '', queueOrder = null, queueOrderFresh = false, queueOpens = 0;
// The delivery the person pressed "not needed" on and has not yet said yes or no about (asked in its row).
let queueDropping = '';
const handoffSpace = () => ($('queue-dialog').open && queueSpace ? queueSpace : spaceId);
// One read at a time; a call during a read asks for one more after it, and gets the read that is under way.
function loadHandoff() {
  if (state.handoffEnabled !== true || typeof api.handoff !== 'function' || disconnected) return Promise.resolve();
  if (handoffReading) { handoffAgain = true; return handoffReading; }
  handoffReading = readHandoff().finally(() => {
    handoffReading = null;
    if (handoffAgain) { handoffAgain = false; scheduleHandoff(); }
  });
  return handoffReading;
}
async function readHandoff() {
  const id = handoffSpace();
  // The rows' places are fixed by a view whose read began after the panel was opened, not by an older one.
  const opened = $('queue-dialog').open && id === queueSpace ? queueOpens : 0;
  try { handoffView = { roomId: id, view: await api.handoff('space', id) }; }
  catch { handoffView = { roomId: id, view: null, failed: true }; }
  if (opened && opened === queueOpens && $('queue-dialog').open) queueOrderFresh = true;
  renderQueue(); renderQueueNeed();
}
function scheduleHandoff() {
  if (handoffTimer) return;
  handoffTimer = setTimeout(() => { handoffTimer = null; loadHandoff(); }, 250);
}
// With every state: the view is read again when this space's record or the integrator changed, and each time while the panel is open.
function noteHandoffState() {
  if (state.handoffEnabled !== true) return;
  const id = handoffSpace();
  const key = JSON.stringify([id, spaceRecord(id)?.metadataRevision ?? null, state.integrator?.sessionId || null, disconnected]);
  if (key !== handoffKey || $('queue-dialog').open) { handoffKey = key; scheduleHandoff(); }
  renderQueueNeed();
}
function queueHandoffModel(id) {
  if (state.handoffEnabled !== true || !handoffView || handoffView.roomId !== id) return null;
  const members = [];
  for (const record of state.sessions) {
    if (inSpace(record, id) && !record.archived && record.state !== 'ended') members.push(record.id);
  }
  return window.nativeWorkspaceHandoffQueue.model({ view: handoffView.view, failed: handoffView.failed === true, queue: spaceRecord(id)?.queue || [], sessions: state.sessions.map(s => s.archived ? { ...s, name: archivedName(s) } : s), members,
    integrator: state.integrator || null, unnamed: uiText('identity.historicalMember'), generic: uiText('queue.handoff.theIntegrator'), dropping: queueDropping });
}
// The button that opens the panel says how many things in this space wait for the person.
function renderQueueNeed() {
  if (state.handoffEnabled !== true) return;
  const need = queueHandoffModel(spaceId)?.need || 0, opener = $('room-queue');
  if (opener.dataset.need === String(need)) return;
  opener.dataset.need = String(need);
  if (need) ui.display.text(opener, 'queue.titleNeed', { n: need });
  else ui.display.text(opener, 'queue.title');
}
// One of the person's own steps on a handoff; whatever comes of it, the panel shows the state afterwards.
async function queueHandoffAct(...args) {
  try { return await api.handoff(...args); }
  finally {
    // A refresh that fails does not hide what came of the step itself; the next state carries it.
    try { updateState(await api.initial()); } catch { /* Said by the connection's own notice. */ }
    // The view that shows the outcome is one read after the step: not a read that was already under way.
    if (handoffReading) await handoffReading.catch(() => {});
    await loadHandoff().catch(() => {});
  }
}
// A step that is refused says so inside the panel: a toast would lie behind it, where it can be neither read nor closed.
// The refusals that mean "this folder will not do": only they are headed by "choose another".
const QUEUE_FOLDER_REFUSALS = ['error.handoff.repositoryNotMain', 'error.handoff.repositoryUnsafe', 'error.handoff.repositoryNoMain'];
function queueHandoffError(error, headline) {
  const line = $('queue-handoff-error');
  ui.display.unbind(line); line.replaceChildren();
  line.hidden = !error;
  if (!error) return;
  if (!headline || !QUEUE_FOLDER_REFUSALS.includes(error?.uiMessage?.key)) { ui.showError(line, error); return; }
  // What it means for the person first; the cause, in smaller words, under it.
  const cause = node('div', undefined, 'quiet queue-handoff-small');
  ui.showError(cause, error);
  line.append(uiNode('div', headline, undefined, 'queue-handoff-refused'), cause);
}
function queueHandoffButton(key, params, kind, action, refused) {
  const control = node('button', undefined, 'small');
  control.type = 'button';
  ui.display.text(control, key, params);
  control.dataset.handoffAction = kind;
  control.disabled = disconnected;
  // One press at a time: the button waits for its own step.
  control.addEventListener('click', async () => {
    queueHandoffError(null);
    control.disabled = true;
    try { await action(); } catch (error) { queueHandoffError(error, refused); }
    control.disabled = disconnected;
  });
  return control;
}
// The state of a task's delivery on the task's own row: the status line, why it waits, and the person's step.
function queueHandoffRow(row, handoff) {
  if (!handoff) return;
  ui.display.text(row.querySelector('.queue-status'), handoff.status.key, handoff.status.params);
  row.dataset.handoff = handoff.where;
  if (handoff.why) row.append(uiNode('div', handoff.why.key, handoff.why.params, 'queue-outcome queue-handoff-why'));
  if (handoff.ask) row.append(uiNode('div', handoff.ask.key, handoff.ask.params, 'queue-outcome queue-handoff-why queue-handoff-ask'));
  const item = row.dataset.queueItem;
  // "Not needed" and "keep it" only change what the row offers; the row is drawn again, and the keyboard stays in it
  // (on "keep it" after the first press: the step that cannot be taken back is never the one a stray Enter hits).
  const turn = (key, focus) => () => {
    queueDropping = key;
    renderQueue();
    for (const drawn of $('queue-list').querySelectorAll('.queue-row')) if (drawn.dataset.queueItem === item) drawn.querySelector(`button[data-handoff-action="${focus}"]`)?.focus();
  };
  const step = act => act.kind === 'drop' ? turn(act.key, 'dropCancel') : act.kind === 'dropCancel' ? turn('', 'drop')
    : () => { queueDropping = ''; return queueHandoffAct({ send: 'retryDelivery', redo: 'redo', recheck: 'recheck', confirm: 'confirm', dropNow: 'drop' }[act.kind], act.key); };
  for (const act of [handoff.action, handoff.more]) {
    if (act) row.querySelector('.queue-actions').append(queueHandoffButton(act.label.key, act.label.params, act.kind, step(act)));
  }
  // "Not needed", or the two answers to its question, under the reason and apart from the row's own steps.
  if (handoff.aside.length) {
    const aside = node('div', undefined, 'queue-handoff-drop');
    for (const act of handoff.aside) aside.append(queueHandoffButton(act.label.key, act.label.params, act.kind, step(act)));
    row.append(aside);
  }
}
// A delivery that still waits for the person although the queue no longer lists its task.
function queueOrphanRow(orphan, handoff) {
  const row = node('div', undefined, 'queue-row');
  const body = node('div', undefined, 'queue-text');
  body.append(uiNode('div', 'queue.handoff.orphan', undefined, 'queue-creator quiet'), node('div', orphan.text));
  row.dataset.queueItem = orphan.itemId;
  row.dataset.status = 'done';
  row.append(node('span', undefined, 'queue-status'), body, node('span', undefined, 'queue-actions'));
  queueHandoffRow(row, handoff);
  return row;
}
// The block on top of the panel: who integrates, what stops the handoffs, and what the integrator waits for.
function renderQueueHandoff(block) {
  const host = $('queue-handoff');
  host.hidden = !block;
  if (!block) { host.replaceChildren(); return; }
  const head = node('div', undefined, 'queue-handoff-head'), side = node('span', undefined, 'quiet');
  block.head.forEach((part, index) => { if (index) side.append(' · '); side.append(uiNode('span', part.key, part.params)); });
  head.append(uiNode('h3', 'queue.handoff.title'), side);
  const parts = [head];
  for (const fault of block.faults) { const line = uiNode('p', fault.key, fault.params, 'queue-handoff-line'); line.dataset.handoff = 'fault'; parts.push(line); }
  if (block.none) {
    parts.push(uiNode('p', 'queue.handoff.none', undefined, 'queue-handoff-line'));
    if (block.none.count) parts.push(uiNode('p', 'queue.handoff.noneCount', { n: block.none.count }, 'quiet queue-handoff-small'));
  }
  for (const stop of block.stops) parts.push(uiNode('p', stop.key, stop.params, 'queue-handoff-line'));
  const repository = block.repository;
  if (repository) {
    // The words on the left, the button on the right: a long path wraps inside its own column.
    const line = node('div', undefined, repository.need ? 'queue-handoff-repository' : 'queue-handoff-repository quiet'), words = node('div');
    line.dataset.handoff = 'repository';
    if (repository.root) {
      const parts = repository.root.split('/').filter(Boolean);
      const path = uiNode('div', 'queue.handoff.repository', { root: parts.length > 2 ? '…/' + parts.slice(-2).join('/') : repository.root }, 'queue-handoff-path');
      path.title = repository.root;
      words.append(path);
    }
    if (repository.problem) words.append(uiNode('div', repository.problem));
    else if (!repository.root) words.append(uiNode('div', 'queue.handoff.repositoryNone', { who: repository.who }));
    line.append(words, queueHandoffButton(repository.root ? 'queue.handoff.repositoryChange' : 'queue.handoff.repositoryChoose', undefined, 'repository', () => queueHandoffAct('chooseRepository'), 'queue.handoff.repositoryRefused'));
    parts.push(line);
  }
  const ask = block.ask;
  if (ask) {
    const box = node('div', undefined, 'queue-handoff-ask'), words = ['asks', 'inSpace'].includes(ask.kind) ? ask.kind : 'other';
    box.dataset.handoff = 'ask';
    box.append(uiNode('div', 'queue.handoff.ask.' + ask.kind, { name: ask.name }, 'queue-status'));
    if (ask.question) box.append(node('div', ask.question, 'queue-handoff-question'));
    box.append(uiNode('div', 'queue.handoff.guide.' + words, { name: ask.name }, 'quiet queue-handoff-small'));
    if (ask.about.length) {
      box.append(uiNode('div', 'queue.handoff.about', () => ({ list: ask.about.map(item => (item.member ? uiText('queue.handoff.aboutItem', item) : item.text)).join(uiText('queue.handoff.aboutSeparator')) }), 'quiet queue-handoff-small'));
    }
    const buttons = node('div', undefined, 'queue-handoff-buttons');
    const open = queueHandoffButton('queue.handoff.open', { name: ask.name }, 'open', async () => { $('queue-dialog').close(); await select(ask.sessionId); });
    open.disabled = disconnected || !ask.known;
    buttons.append(open);
    // The other spaces whose deliveries the handoff is about, as far as their panels can be opened: each by its own name.
    const others = () => ask.elsewhere.map(id => spaceRecord(id)).filter(room => room && !room.archived && spaceName(room)).map(room => uiText('queue.handoff.spaceQuoted', { name: spaceName(room) }));
    const named = () => ({ spaces: others().join(uiText('queue.handoff.aboutSeparator')) });
    // The person's steps on a handoff are offered where its deliveries are shown; and here too when no such panel can be opened.
    if (ask.here || !others().length) {
      if (!ask.here) box.append(uiNode('div', 'queue.handoff.elsewhereGone', undefined, 'quiet queue-handoff-small'));
      else if (others().length) box.append(uiNode('div', 'queue.handoff.elsewhereToo', named, 'quiet queue-handoff-small'));
      buttons.append(queueHandoffButton('queue.handoff.again.' + words, undefined, 'again', () => queueHandoffAct('resolve', ask.handoffId, true)),
        queueHandoffButton('queue.handoff.keep', undefined, 'keep', () => queueHandoffAct('resolve', ask.handoffId, false)));
      box.append(buttons, uiNode('div', 'queue.handoff.after.' + words, { name: ask.name }, 'quiet queue-handoff-small'));
    } else {
      box.append(uiNode('div', 'queue.handoff.elsewhere', named, 'quiet queue-handoff-small'), buttons);
    }
    parts.push(box);
  }
  host.replaceChildren(...parts);
}
function queueMemberName(id) {
  const record = state.sessions.find(s => s.id === id);
  if (record) {
    return archivedName(record);
  }
  return sessionShortId(id);
}
// Why NAW stopped on an item. Unmapped reasons are internal slugs, so no line is drawn for them.
const QUEUE_REASONS = {
  'rotation-control-unresolved': 'queue.reason.rotationUnresolved',
  'waiting-provider': 'queue.reason.waitingProvider',
  'no-reply': 'queue.reason.noReply',
  'person-intervened': 'queue.reason.personIntervened',
  'record-missing': 'queue.reason.recordMissing',
  'send-unconfirmed': 'queue.reason.sendUnconfirmed',
  'member-missing': 'queue.reason.memberMissing',
  'send-failed': 'queue.reason.sendFailed',
};
function queueReasonKey(reason) {
  if (typeof reason !== 'string') {
    return '';
  }
  if (reason.startsWith('not-sent: ')) {
    return 'queue.reason.notSent';
  }
  return QUEUE_REASONS[reason] || '';
}
// What came back, or why it did not: the fact a settled row is read for.
function queueOutcomeNode(item) {
  const reasonKey = queueReasonKey(item.reason);
  if (reasonKey) {
    return uiNode('div', reasonKey, undefined, 'queue-outcome');
  }
  if (item.reply) {
    return node('div', item.reply, 'queue-outcome');
  }
  return null;
}
// `items`: what the panel lists on opening. `back`: the earlier finished tasks the person went back to, oldest first,
// and `hidden`: how many are earlier still.
function queueShownItems(room, keep = [], earlier = 0) {
  const open = [];
  const finished = [];
  for (const item of room.queue || []) {
    if (['queued', 'sent', 'waiting'].includes(item.status)) {
      open.push(item);
    } else {
      finished.push(item);
    }
  }
  const cut = Math.max(0, finished.length - QUEUE_FINISHED_SHOWN);
  // A finished task whose delivery still waits for the person stays in the list however old it is.
  const kept = finished.slice(0, cut).filter(item => keep.includes(item.id));
  const before = finished.slice(0, cut).filter(item => !keep.includes(item.id));
  const back = before.slice(Math.max(0, before.length - earlier));
  return { items: open.concat(kept, finished.slice(cut)), back, hidden: before.length - back.length };
}
function queueRow(item, memberIds) {
  const row = node('div', undefined, 'queue-row');
  let text = item.text;
  if (text.length > 300) {
    text = text.slice(0, 299) + '…';
  }
  const body = node('div', undefined, 'queue-text');
  const creator = item.creator;
  // The butler's own items say so (steward step 2, batch 4); the creator form stays what older builds read.
  const creatorKey = item.addedBy === 'steward' && creator?.kind === 'secretary' ? 'queue.creator.steward' : creator?.kind === 'secretary' ? 'queue.creator.secretary' : creator?.kind === 'person' ? 'queue.creator.person' : 'queue.creator.unknown';
  const creatorParams = creator?.kind === 'secretary' ? { name: creator.name, sessionId: creator.sessionId } : undefined;
  body.append(uiNode('div', creatorKey, creatorParams, 'queue-creator quiet'), text === item.text ? node('div', text) : queueWholeText(item, text));
  let name = '';
  const memberId = item.sentTo || item.assignee;
  if (memberId) {
    name = queueMemberName(memberId);
  }
  let statusKey = 'queue.status.' + item.status;
  // These two waiting kinds ask the person nothing: the item is left for them to look at (11-12). They are named
  // as in UNHELD_WAITING (queue-dispatch.cjs): a decision can still carry an earlier refusal's reason.
  if (item.status === 'waiting' && ['person-intervened', 'no-reply'].includes(item.reason)) {
    statusKey = 'queue.status.lookAt';
  }
  if (item.status === 'queued' && item.assignee && !memberIds.has(item.assignee)) {
    statusKey = 'queue.status.orphan';
  }
  if (item.finishedBy === 'steward' && item.status === 'cancelled') statusKey = 'queue.status.cancelledBySteward';
  if (item.finishedBy === 'steward' && item.status === 'done') statusKey = 'queue.status.doneBySteward';
  let statusParams;
  if (statusKey !== 'queue.status.orphan' && statusKey !== 'queue.status.queued' && statusKey !== 'queue.status.cancelled' && statusKey !== 'queue.status.cancelledBySteward') {
    // Read again when the language changes: an archived member's marker is in the person's language.
    statusParams = () => ({ name: memberId ? queueMemberName(memberId) : '' });
  }
  const dialogs = item.status === 'queued' ? state.sessions.filter(s => memberIds.has(s.id) && (!item.assignee || s.id === item.assignee) && s.nativeTerminalDialog) : [];
  if (dialogs.length) { statusKey = 'state.terminalDialog'; statusParams = () => ({ title: dialogs.map(s => s.name + ' · ' + s.nativeTerminalDialog.title).join('、') }); }
  const status = uiNode('span', statusKey, statusParams, 'queue-status');
  if (name) {
    status.title = name;
  }
  // A reason without a plain line (a native error message, say) is still there to read or report.
  if (item.reason && !queueReasonKey(item.reason)) {
    status.title = [name, item.reason].filter(Boolean).join(' · ');
  }
  const actions = node('span', undefined, 'queue-actions');
  if (item.status === 'waiting') {
    actions.append(uiButton('queue.resolve', async () => {
      await api.spaceAction(queueSpace, 'queueResolve', [item.id]);
      updateState(await api.initial());
      renderQueue();
    }, 'small'));
  }
  if (item.status === 'queued') {
    actions.append(uiButton('queue.cancel', async () => {
      await api.spaceAction(queueSpace, 'queueCancel', [item.id]);
      updateState(await api.initial());
      renderQueue();
    }, 'small'));
  }
  row.dataset.queueItem = item.id;
  row.dataset.status = item.status;
  row.append(status, body, actions);
  const outcome = queueOutcomeNode(item);
  if (outcome) {
    row.append(outcome);
  }
  const answer = queueAnswerNode(item, item.status === 'waiting' && statusKey !== 'queue.status.lookAt');
  if (answer) {
    row.append(answer);
  }
  return row;
}
// A long task lists its beginning and opens in place to all of it; it stays open while the panel redraws.
const queueOpenText = new Set();
function queueWholeText(item, start) {
  const whole = node('details', undefined, 'queue-text-whole');
  whole.append(node('summary', start), node('div', item.text));
  whole.open = queueOpenText.has(item.id);
  whole.addEventListener('toggle', () => {
    if (whole.open) queueOpenText.add(item.id);
    else queueOpenText.delete(item.id);
  });
  return whole;
}
function queueRotationRow(session) {
  const episode = session.rotationEpisode;
  const row = node('div', undefined, 'queue-row');
  row.dataset.rotationSession = session.id;
  row.append(node('div', queueMemberName(session.id), 'queue-text'),
    uiNode('div', QUEUE_REASONS[episode.state === 'waiting-provider' ? 'waiting-provider' : 'rotation-control-unresolved'], undefined, 'queue-outcome'),
    uiButton('queue.releaseRotation', async () => {
      await api.spaceAction(queueSpace, 'releaseRotation', [session.id, session.nativeId, episode.epoch, episode.tag, 'discard-unresolved-handoff']);
      updateState(await api.initial()); renderQueue();
    }, 'small', { name: queueMemberName(session.id) }));
  return row;
}
function renderQueue() {
  if (!queueSpace) return;
  const room = spaceRecord(queueSpace);
  if (!room) return;
  ui.display.text($('queue-title'), 'queue.titleName', () => ({ name: spaceName(room) }));
  if (!$('queue-dispatch-help')) {
    const help = uiNode('p', 'queue.dispatchHelp', undefined, 'quiet');
    help.id = 'queue-dispatch-help';
    $('queue-title').parentElement.insertBefore(help, $('queue-off'));
  }
  $('queue-off').hidden = state.wakePolicy?.enabled === true;
  $('add-queue').disabled = disconnected || room.archived;
  const members = [];
  const memberIds = new Set();
  const needUpdate = [];
  for (const record of state.sessions) {
    if (inSpace(record, queueSpace) && !record.archived) {
      members.push({ id: record.id, name: record.name, nativeTerminalDialog: record.nativeTerminalDialog || null });
      memberIds.add(record.id);
      if (!(record.serviceCapabilities || []).includes('queueDispatchV1')) {
        needUpdate.push(record.name);
      }
    }
  }
  const update = $('queue-update');
  update.hidden = needUpdate.length === 0;
  if (needUpdate.length) {
    ui.display.text(update, 'queue.needsUpdate', () => ({ names: needUpdate.join('、') }));
  }
  const select = $('queue-assignee');
  const memberSignature = JSON.stringify(members);
  if (select.dataset.signature !== memberSignature) {
    const chosen = select.value;
    const anyone = uiNode('option', 'queue.anyone');
    anyone.value = '';
    const options = [anyone];
    for (const member of members) {
      const option = node('option', member.name);
      option.value = member.id;
      options.push(option);
    }
    select.replaceChildren(...options);
    select.dataset.signature = memberSignature;
    let stillMember = false;
    for (const member of members) {
      if (member.id === chosen) {
        stillMember = true;
      }
    }
    if (stillMember) {
      select.value = chosen;
    }
  }
  renderRotationChains();
  const handoff = queueHandoffModel(queueSpace);
  // (Only a window that shows handoffs ever remembers a press; elsewhere this line does nothing.)
  if (queueDropping) queueDropping = handoff ? window.nativeWorkspaceHandoffQueue.pressed(handoff, queueDropping) : '';
  const shown = queueShownItems(room, handoff ? handoff.keep : [], queueEarlier);
  const items = shown.items;
  // What needs the person comes first when the panel opens; while it stays open nothing changes place.
  // The places are kept as soon as a view read after the opening is here, also when it shows nothing new.
  let placed = null;
  if (handoff) {
    const ids = [...items.map(item => item.id), ...handoff.orphans.map(orphan => orphan.itemId)];
    placed = window.nativeWorkspaceHandoffQueue.order(queueOrderFresh ? queueOrder : null, ids, new Set(ids.filter(id => handoff.rows[id]?.front)));
    // (Not from a view that could not be read: it lists no row that waits for the person.)
    if (queueOrderFresh && handoffView.failed !== true) queueOrder = placed;
  }
  const list = $('queue-list');
  const unresolved = state.sessions.filter(s => memberIds.has(s.id) && s.rotationEpisode?.nativeId === s.nativeId &&
    ['invalid', 'waiting-provider'].includes(s.rotationEpisode.state));
  const signature = JSON.stringify([items, shown.back, shown.hidden, memberSignature, needUpdate, handoff, disconnected, placed, unresolved.map(s => [s.id, s.nativeId, s.rotationEpisode])]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  renderQueueHandoff(handoff ? handoff.block : null);
  const answering = queueAnswerFocus();
  const rows = unresolved.map(queueRotationRow);
  for (const item of items) {
    const row = queueRow(item, memberIds);
    if (handoff) {
      queueHandoffRow(row, handoff.rows[item.id]);
    }
    rows.push(row);
  }
  if (placed) {
    for (const orphan of handoff.orphans) {
      rows.push(queueOrphanRow(orphan, handoff.rows[orphan.itemId]));
    }
    rows.sort((a, b) => placed.indexOf(a.dataset.queueItem) - placed.indexOf(b.dataset.queueItem));
  }
  if (shown.back.length || shown.hidden) queueEarlierRows(shown, rows, memberIds, handoff, (room.queue || []).length);
  else if (queuePager) queuePager.status.hidden = true;
  list.replaceChildren(...rows);
  restoreQueueAnswerFocus(answering);
  if (!rows.length) {
    list.append(uiNode('p', 'queue.empty', undefined, 'quiet'));
  }
}
// Earlier finished tasks go above the latest finished ones, under the button that brings the next ones; after a press
// keyboard and screen reader go on from the first task that appeared. One button and one count for the panel: the
// count stays in place outside the list, so a screen reader reads it out when it changes.
let queuePager = null;
let queueBackShown = new Set();
function queueEarlierRows(shown, rows, memberIds, handoff, total) {
  const back = shown.back.map(item => {
    const row = queueRow(item, memberIds);
    if (handoff) queueHandoffRow(row, handoff.rows[item.id]);
    row.setAttribute('tabindex', '-1');
    return row;
  });
  queueBackShown = new Set(shown.back.map(item => item.id));
  if (!queuePager) {
    queuePager = window.nativeWorkspaceDisclosure.pager({ document, say: (el, key, params) => ui.display.text(el, key, params), onMore: () => {
      const before = queueBackShown;
      queueEarlier += QUEUE_FINISHED_SHOWN;
      renderQueue();
      const first = [...$('queue-list').querySelectorAll('.queue-row')].find(row => row.hasAttribute('tabindex') && !before.has(row.dataset.queueItem));
      if (first) first.focus();
    } });
  }
  const list = $('queue-list');
  if (queuePager.status.parentElement !== list.parentElement) list.after(queuePager.status);
  queuePager.status.hidden = false;
  queuePager.show({ count: Math.min(QUEUE_FINISHED_SHOWN, shown.hidden), total, shown: shown.items.length + back.length });
  const latest = new Set(shown.items.slice(-QUEUE_FINISHED_SHOWN).map(item => item.id));
  const at = rows.findIndex(row => latest.has(row.dataset.queueItem) && !handoff?.rows[row.dataset.queueItem]?.front);
  rows.splice(at < 0 ? rows.length : at, 0, queuePager.button, ...back);
}
// The sessions behind one continuing conversation, oldest first, with their ids.
function renderRotationChains() {
  const host = $('queue-rotations');
  const list = $('queue-rotation-list');
  const chains = [];
  for (const chain of state.rotationChains || []) {
    if ((chain.spaces || []).includes(queueSpace)) {
      chains.push(chain);
    }
  }
  host.hidden = chains.length === 0;
  // Archiving or restoring a session in a chain changes its marker; the recorded chain itself does not change.
  const signature = JSON.stringify([chains, chains.map(chain => chain.sessions.map(link => Boolean(state.sessions.find(s => s.id === link.id)?.archived)))]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const blocks = [];
  for (const chain of chains) {
    const block = node('ol', undefined, 'rotation-chain');
    for (const link of chain.sessions) {
      const row = node('li');
      const id = link.id || '';
      const shortId = id ? sessionShortId(id) : '';
      const record = state.sessions.find(s => s.id === id);
      const name = link.name || (record ? record.name : sessionShortId(id));
      let native = '—';
      if (link.nativeId) {
        native = link.nativeId.slice(0, 8);
      }
      row.append(uiNode('span', 'queue.chainSession', () => ({ name: archivedName(record, name), id: shortId, native })));
      if (link.handedAt) {
        const time = new Date(link.handedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        let key = 'queue.chainHanded';
        if (link.outcome === 'kept') {
          key = 'queue.chainKept';
        }
        row.append(document.createTextNode(' · '), uiNode('span', key, { time }, 'quiet'));
      }
      // The short ids read at a glance; the full ones stay here for anyone who needs to paste them.
      row.title = [name, id, link.nativeId || ''].filter(Boolean).join(' · ');
      block.append(row);
    }
    blocks.push(block);
  }
  list.replaceChildren(...blocks);
}
$('room-queue').onclick = openQueue;
$('close-queue').onclick = () => $('queue-dialog').close();
$('queue-form').onsubmit = event => {
  event.preventDefault();
  attempt(async () => {
    const id = queueSpace;
    const text = $('queue-text').value;
    const assignee = $('queue-assignee').value || null;
    await api.spaceAction(id, 'queueAdd', [text, assignee]);
    $('queue-text').value = '';
    updateState(await api.initial());
    if (queueSpace === id) {
      renderQueue();
    }
  });
};
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
  const imageRefs = roomImageRefs(), imageVersion = roomViews[spaceId]?.roomImageVersion;
  if (imageRefs.length && (automatic || !roomImageForwardAvailable(members().find(s => s.id === roomRecipient())))) throw uiError('error.roomImages.deliveryUnavailable');
  if (imageRefs.length && roomViews[spaceId]?.roomImageSend) throw uiError('error.roomImages.alreadySent');
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
  const submission = { spaceId: sendingSpace, automatic: Boolean(automatic), recipientName: participantLabel(recipient), queued: !automatic && roomQueueAvailable(recipient), midturn: !automatic && roomQueueAvailable(recipient) && recipient.midturnAvailable === true, cancelling: false, cancelRequested: false };
  if (automatic) { roomSubmitting = submission; view.submitting = submission; }
  else roomPendingRecipients.set(first, submission);
  let queuedMark = submission.queued && { spaceId: sendingSpace, raw, address, revision, before: new Set(state.room.messages.map(m => m.id)) };
  if (queuedMark) queuedRoomInputs.set(first, queuedMark);
  // Text to one recipient picks again after a stale-state refusal, as a session composer does.
  const roomTextInput = async () => {
    const replyTo = roomReplyTo || undefined, pick = roomInputMethod(recipient);
    const roomText = choice => api.spaceAction(sendingSpace, choice.method, choice.method === 'steerShared' ? [first, text, recipient.nativeId, choice.turnId, replyTo] : [first, text, recipient.nativeId, replyTo]);
    let seen = stateArrivals;
    try { return await roomText(pick); }
    catch (error) {
      if (!staleMethodRefusals.has(error?.uiMessage?.key)) throw error;
      const until = Date.now() + STALE_METHOD_WAIT_MS;
      let now, next;
      for (;;) {
        await nextStateArrival(seen, until); seen = stateArrivals;
        now = members().find(s => s.id === first);
        const unchanged = now && roomPendingRecipients.get(first) === submission && !submission.cancelRequested && !roomSubmitting && !disconnected && !roomMergeBlocked() && spaceId === sendingSpace && roomRecipient() === first && !$('shared-input').readOnly && roomDraftRevision === revision && $('shared-input').value === raw && roomMention?.text === address?.text && roomMention?.memberRevision === address?.memberRevision && (roomReplyTo || undefined) === replyTo && !roomImageRefs().length;
        if (!unchanged || now.nativeId !== recipient.nativeId || now.nativeInputRequired || now.shareAvailable === false || now.chatAvailable === false || !nativeUsable(now) || interruptPending(now)) throw error;
        next = roomInputMethod(now);
        if (next.method !== pick.method || next.turnId !== pick.turnId) break;
        if (Date.now() >= until) throw error;
      }
      if (next.method === 'forward' && !roomRecipientReady(now) && !roomManualErrorReady(now)) throw error;
      if (queuedMark && !queuedMark.tag && queuedRoomInputs.get(first) === queuedMark) queuedRoomInputs.delete(first);
      submission.queued = next.method === 'queueShared'; submission.midturn = submission.queued && now.midturnAvailable === true;
      queuedMark = submission.queued && { spaceId: sendingSpace, raw, address, revision, before: new Set(state.room.messages.map(m => m.id)) };
      if (queuedMark) queuedRoomInputs.set(first, queuedMark);
      render();
      return await roomText(next);
    }
  };
  if (imageRefs.length) view.roomImageDispatching = true;
  render();
  try {
    if (imageRefs.length) {
      await persistView();
      view.roomImageSend = { version: imageVersion, recipientId: first, nativeId: recipient.nativeId };
    }
    const receipt = await (imageRefs.length ? api.spaceAction(sendingSpace, 'forward', [first, text, recipient.nativeId, roomReplyTo || undefined, { version: imageVersion }]) : automatic ? api.spaceAction(sendingSpace, 'run', [ids, text, automatic.limit, automatic.mode || 'replies', automatic.labels, automatic.contexts, roomReplyTo || undefined, automatic.identities]) : roomTextInput());
    if (submission.cancelRequested || receipt?.contextChanged) return;
    if (imageRefs.length) {
      if (!receipt?.imageDraft?.accepted) return;
      if (view.roomImageVersion === imageVersion) { view.roomImages = receipt.imageDraft.refs; view.roomImageVersion = receipt.imageDraft.version; delete view.roomImageSend; }
    }
    const original = sendingSpace === spaceId ? captureRoomView() : view;
    if (revision === original.draftRevision && original.sharedDraft === raw && original.roomRecipient === first && original.roomMention?.memberRevision === address?.memberRevision && original.roomMention?.text === address?.text) { original.sharedDraft = ''; original.roomMention = null; original.roomRecipient = ''; original.draftRevision++; writeRoomDraft(sendingSpace, original); }
  }
  catch (error) { if (!submission.cancelRequested) throw error; }
  finally {
    if (queuedMark && !queuedMark.tag && queuedRoomInputs.get(first) === queuedMark) queuedRoomInputs.delete(first);
    view.roomImageDispatching = false;
    submission.settled = true; if (view.submitting === submission && !submission.cancelling) view.submitting = null;
    if (roomSubmitting === submission && !submission.cancelling) roomSubmitting = null;
    if (roomPendingRecipients.get(first) === submission) roomPendingRecipients.delete(first);
    render();
  }
}
$('room-composer').onsubmit = event => { event.preventDefault(); attempt(() => submitRoom(false)); };
$('add-room-image').onclick = () => { roomImagePickerSpace = spaceId; $('room-image-files').click(); };
$('room-image-files').onchange = () => {
  const files = Array.from($('room-image-files').files || []), id = roomImagePickerSpace;
  $('room-image-files').value = ''; if (files.length) attempt(() => addRoomImages(files, id));
};
$('room-composer').addEventListener('paste', event => {
  const files = imageFiles(event.clipboardData); if (!files.length) return;
  event.preventDefault(); event.stopPropagation(); attempt(() => addRoomImages(files));
});
$('room-composer').addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
$('room-composer').addEventListener('drop', event => {
  const files = imageFiles(event.dataTransfer); if (!files.length) return;
  event.preventDefault(); event.stopPropagation(); attempt(() => addRoomImages(files));
});
$('forward-button').onclick = () => {
  if ($('forward-button').disabled || $('forward-button').type !== 'button') return;
  const recipient = members().find(s => s.id === $('recipient').value);
  if (!recipient) return;
  if (nativeUsable(recipient)) attempt(() => operateNative(recipient.id)); else select(recipient.id, 'chat');
};
function roomSteerAvailable(s) {
  return Boolean(!interruptPending(s) && s?.state === 'working' && s.steerAvailable && s.activeTurnId && !s.pendingSteer && !s.approval && (s.legacySharedSteer || s.serviceCapabilities?.includes('nativeSharedSteer')));
}
function roomRecipientReady(s) {
  return Boolean(s && !interruptPending(s) && s.state === 'idle' && !s.nativeInputRequired && !s.pendingTag && !s.pendingQueue && !s.approval && s.shareAvailable !== false && s.chatAvailable !== false);
}
function roomManualErrorReady(s) {
  return Boolean(!interruptPending(s) && s?.state === 'error' && s.failedTurnInputAvailable && !s.pendingTag && !s.pendingQueue && !s.approval);
}
function roomMergeBlocked() {
  return Boolean(state.room.merge && (!state.room.merge.imported || ['preparing', 'joining', 'failed', 'undoing'].includes(state.room.merge.stage)));
}
function roomInputMethod(s) {
  if (roomQueueAvailable(s)) return { method: 'queueShared' };
  if (roomSteerAvailable(s)) return { method: 'steerShared', turnId: s.activeTurnId };
  return { method: 'forward' };
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
    label.append(check, document.createTextNode(`${s.name} · ${providerName(s.provider)} · ${sessionShortId(s.id)}`));
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

$('room-search').oninput = $('room-filter').onchange = () => { roomFilterHistory = null; renderTimeline(); attempt(persistView); };
$('thread-back').onclick = () => { captureReadingViews(); roomThread = ''; if (!$('shared-input').value.trim() && !roomSubmitting) roomReplyTo = ''; render(); attempt(persistView); };
$('cancel-reply').onclick = () => { roomReplyTo = ''; roomThread = ''; roomDraftRevision++; render(); attempt(persistView); $('shared-input').focus(); };
$('copy-timeline').onclick = () => attempt(() => api.copy(filteredTimeline().map(m => `${Number.isFinite(m.time) ? new Date(m.time).toLocaleString(ui.language.getSnapshot().active) : uiText('reading.unknownTime')} · ${roomMessageLabel(m)}\n${m.text}`).join('\n\n')));
$('room-notes').onclick = () => openNotes(); $('cancel-notes').onclick = () => $('notes-dialog').close();
$('notes-form').onsubmit = async event => {
  event.preventDefault(); const ticket = dialogTickets.get($('notes-dialog'));
  if (!currentDialogTicket(ticket) || $('save-notes').disabled) return;
  const submitted = $('room-notes-text').value;
  $('save-notes').disabled = true; $('notes-error').hidden = true;
  try {
    await api.spaceAction(ticket.roomId, 'notes', [submitted, notesRevision]);
    if (!currentDialogTicket(ticket)) toastMessage("toast.notesSavedEarlier");
    else if ($('room-notes-text').value === submitted) $('notes-dialog').close();
    else {
      // The editor stays editable during Save. Keep newer input, and only
      // rebase its next explicit save if our submitted notes are still current.
      const snapshot = await api.initial();
      if (!currentDialogTicket(ticket)) return;
      const latest = (snapshot?.rooms || (snapshot?.room ? [snapshot.room] : [])).find(room => room.id === ticket.roomId);
      if (latest?.notes !== submitted || !Number.isSafeInteger(latest.metadataRevision) || latest.metadataRevision < 0) throw uiError('error.room.dataChangedElsewhere');
      notesRevision = latest.metadataRevision;
    }
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
  if (!currentDialogTicket(ticket) || ticket.contextInsert) return;
  const target = contextTarget, text = $('context-text').value;
  if (!contextSnapshot || !text.trim() || text.length > 12000 || !text.isWellFormed()) return contextProblem(uiError('error.contextCheckPreview'));
  if (!target?.room || target.roomId !== spaceId || selected !== 'room') return contextProblem(uiError('error.contextViewChanged'));
  const input = $('shared-input');
  const next = appendedDraft(input, text, true);
  if (next.length > 16000) { ui.display.text($('context-error'), 'context.tooLong'); $('context-error').hidden = false; return; }
  const insertion = {}; ticket.contextInsert = insertion;
  input.value = next;
  roomDraftRevision++; updateContextControls();
  try {
    await persistView();
    if (currentDialogTicket(ticket) && revision === selectionRevision && $('context-text').value === text) {
      $('context-dialog').close(); render(); input.focus();
    }
  } finally {
    if (ticket.contextInsert === insertion) {
      delete ticket.contextInsert;
      if (currentDialogTicket(ticket)) updateContextControls();
    }
  }
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
$('steward-empty').onclick = () => openStewardChooser();
$('steward-cancel').onclick = () => $('steward-dialog').close();
$('steward-confirm').onclick = () => attempt(confirmSteward);
$('steward-dialog').addEventListener('close', () => { if ($('steward-dialog').open) return; stewardChoice = ''; $('steward-list').replaceChildren(); $('steward-error').hidden = true; });
$('close-session-chain').onclick = () => $('session-chain-dialog').close();
$('session-chain-chip').onclick = () => { const id = $('session-chain-chip').dataset.sessionId; if (id) openSessionChain(id); };
// The sidebar's collapse button mirrors DSH's state (⌥⌘B, the narrow-window rail) and asks DSH to toggle it.
function syncSidebarToggle() {
  const toggle = $('sidebar-toggle'), surface = toggle.closest('.naw[data-native-surface="sidebar"]');
  if (surface && !syncSidebarToggle.watching) {
    syncSidebarToggle.watching = new MutationObserver(syncSidebarToggle);
    syncSidebarToggle.watching.observe(surface, { attributes: true, attributeFilter: ['data-collapsed'] });
  }
  const rail = surface?.dataset.collapsed === 'true', key = rail ? 'sidebar.showPanel' : 'sidebar.hidePanel';
  toggle.setAttribute('aria-expanded', String(!rail));
  ui.display.attribute(toggle, 'aria-label', key);
  ui.display.computed(toggle, 'title', () => uiText('sidebar.panelShortcut', { action: uiText(key) }));
}
$('sidebar-toggle').onclick = () => ui.toggleSidebar();
$('spaces-nav').onclick = () => openSpaceNavigation('spaces', $('spaces-nav'));
$('switch-space').onclick = () => openSpaceNavigation('spaces', $('switch-space'));
$('independent-nav').onclick = () => openSpaceNavigation('sessions', $('independent-nav'));
syncSidebarToggle();
// The selected card hierarchy is the only production sidebar look.
document.documentElement.dataset.sidebarLook = 'b';
$('session-chain-dialog').addEventListener('close', () => {
  if ($('session-chain-dialog').open) return;
  sessionChainId = null; $('session-chain-list').replaceChildren();
});
$('close-search').onclick = () => $('search-dialog').close();
$('search-preview-back').onclick = renderSearch;
$('search-dialog').addEventListener('close', finishSearch);
$('search-dialog').addEventListener('close', () => { if (!$('search-dialog').open) updateSearchSend(); });
$('search-input').oninput = event => { clearTimeout(searchTimer); if (!event.isComposing) { updateSearchSend(); searchTimer = setTimeout(() => { searchLimit = 60; renderSearch(); }, 100); } };
$('search-input').oncompositionend = () => { clearTimeout(searchTimer); updateSearchSend(); searchTimer = setTimeout(() => { searchLimit = 60; renderSearch(); }, 100); };
$('search-send').onclick = () => openSearchSend($('search-input').value.trim());
$('send-list').onchange = searchSendChoose;
$('send-text').oninput = () => renderSearchSend();
$('send-cancel').onclick = () => $('send-dialog').close();
$('send-confirm').onclick = () => attempt(confirmSearchSend);
$('send-dialog').addEventListener('close', finishSearchSend);
// 新开一个 waits for the create dialog (and anything opened over it) to close; a close event does not bubble.
document.addEventListener('close', () => { if (searchSendNew) setTimeout(resumeSearchSendNew, 0); }, true);
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
    if (dialog.id === 'space-create-dialog') {
      const opener = dialogTickets.get(dialog)?.spaceCreateOpener, fallback = $('workspace-toggle');
      if (opener && (!opener.isConnected || !opener.getClientRects().length) &&
          (document.activeElement === document.body || dialog.contains(document.activeElement)) && !document.querySelector('dialog[open]') &&
          fallback?.isConnected && fallback.getClientRects().length && !fallback.disabled) {
        fallback.focus({ preventScroll: true });
      }
    }
    dialogTickets.delete(dialog); dialog.scrollTop = 0;
    if (dialog.id === 'create-dialog') {
      for (const id of ['session-name', 'claude-history-id']) $(id).value = '';
      for (const id of ['chosen-folder', 'create-error', 'create-readiness', 'create-permission-note', 'create-space-help', 'git-worktree-source-help', 'git-worktree-preview']) { ui.display.unbind($(id)); $(id).textContent = ''; }
      $('skip-permissions').checked = false; folder = ''; newDirectory = false;
      $('initial-view').value = ''; $('create-profile').replaceChildren();
      for (const input of dialog.querySelectorAll('input[name="provider"]')) input.checked = false;
    } else if (dialog.id === 'setup-dialog') {
      $('header').closest('main').classList.remove('settings-panel-open');
      mobileSetup.close();
      if (inputFocusAllowed()) {
        const reply = current() ? chatInput() : spaceId ? $('shared-input') : null;
        if (reply?.getClientRects().length && !reply.disabled) reply.focus({ preventScroll: true });
      }
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
$('setup-dialog').addEventListener('keydown', event => {
  // Do not consume Escape from chat/the terminal, or an IME composition.
  if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && !$('setup-dialog').matches(':modal')) {
    event.preventDefault(); event.stopPropagation(); $('setup-dialog').close();
  }
});
sidebarHoverCard = (() => {
  const list = $('session-list'), surface = list?.closest('.naw') || list?.closest('.sidebar');
  return surface && window.nativeWorkspaceHoverCard ? window.nativeWorkspaceHoverCard.mount({ root: surface, surface, resolve: sidebarHoverItem, build: sidebarHoverBuild }) : null;
})();
disposers.push(() => sidebarHoverCard?.dispose(), ui.language.subscribe(() => sidebarHoverCard?.dismiss()));
$('ui-language').onchange = event => { void changeInterfaceLanguage(event.target.value); };
disposers.push(ui.language.subscribe(() => { renderInterfaceLanguage(); renderSetupPrograms(true); butlerReviewView.refresh(); if (selected === 'panorama') document.title = uiText('panorama.windowTitle'); else if (current()?.archived) document.title = sessionWindowTitle(current()); }));
disposers.push(api.onLocale(value => { if (!value || typeof value !== 'object') return; languageWarning = ['unavailable', 'migrationNotSaved'].includes(value.warning) ? value.warning : null; if (!languageWarning) notifiedLanguageWarning = undefined; renderInterfaceLanguage(); reportLanguageWarning(); }));
renderInterfaceLanguage();

for (const input of document.querySelectorAll('input[name="provider"]')) input.onchange = createReadiness;
$('claude-history-id').oninput = createReadiness;
$('create-profile').onchange = createReadiness;
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
  sidebarCollapsedFolders = new Set(state.viewState.sidebarCollapsedFolders || []);
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
  roomDraftRevision = savedRoomView.draftRevision || 0;
  $('room-search').value = savedRoomView.roomSearch || ''; pendingRoomFilter = savedRoomView.roomFilter || '';
  roomThread = savedRoomView.roomThread || ''; roomReplyTo = savedRoomView.roomReplyTo || '';
  roomRecordScope = savedRoomView.roomRecordScope || ''; roomRecordReturn = savedRoomView.roomRecordReturn || null; roomFilterHistory = savedRoomView.roomFilterHistory || null;
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
  // The first window of this start of the app lands on the butler's conversation when one is designated;
  // otherwise, and in every other window, where the window was.
  const landing = typeof api.landing === 'function' && await api.landing() ? stewardRecord() : null;
  await select(landing ? landing.id : state.viewState.selected || '', mode); await api.uiReady(); reportLanguageWarning();
});
const disposeContentMenus = bindContentMenus();
return () => { clearTimeout(backgroundExpiryClock); clearInterval(nativeActivityClock); roomOverview?.dispose(); document.removeEventListener('toggle', updateSelectedSharing, true); document.removeEventListener('selectionchange', documentSelectionChanged); document.removeEventListener('keydown', searchKey); clearTimeout(searchTimer); disposeReadingViews(); disposeContentMenus(); sessionMenu?.close(); roomMenu?.(); for (const dispose of disposers) dispose(); observer.disconnect(); clearTimeout(toastTimer); for (const entry of terminals.values()) entry.term.dispose(); };
