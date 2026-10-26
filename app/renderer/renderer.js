/* Views consume session capabilities; they never own native processes. */
const api = window.workspace;
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const button = (text, action, cls) => { const el = node('button', text, cls); el.type = 'button'; el.addEventListener('click', () => attempt(action)); return el; };
const states = { starting: '正在启动', idle: '就绪', working: '正在工作', approval: '等待确认', stopping: '等待原生退出确认', disconnected: '已断开 · 原生尚未释放', recoverable: '等待恢复', ended: '已结束', background: '已转到后台运行', error: '需要检查' };
// An unfollowed native /resume leaves the process running in another session.
const switchedAway = record => record.state === 'stopping' && record.nativeContextPending?.reason === 'resume';
const sessionStatus = record => window.nativeWorkspaceFleet.fleetStatus(record, switchedAway(record) ? '原生已切换会话' : states[record.state], !disconnected);
let state, owner, selected = '', mode = 'terminal', preference = 'terminal', folder = '', disconnected = false;
let latestViewStorage;
let roomSession = '', selectionRevision = 0, pendingMode;
let terminalLayout = 'split';
const chatInput = () => selected === 'room' ? $('shared-input') : $('message-input');
const nativeStatusFresh = value => value?.stale !== true && (!Number.isFinite(value?.observedAt) || Date.now() - value.observedAt <= 5000);
let roomSubmitting = null;
const roomPendingRecipients = new Map();
const pendingInterrupts = new Set();
const interruptPending = s => Boolean(s && (s.interruptPending || pendingInterrupts.has(s.id)));
const approvalViews = new Map();
let shareRevision = 0, sharePending = null;
let runPreview = null;
let renamingId = '', renaming = false;
let sessionMenu;
let roomMenu, mentionOptions = [], mentionIndex = 0, mentionRange = null, mentionRoster = '', roomMention = null, roomMentionEdit = null, notesRevision, contextTarget = null;
let roomDraftRevision = 0;
let pendingRoomFilter = '';
let roomThread = '', roomReplyTo = '';
let roomThreads = window.nativeWorkspaceThreads.threadIndex([]);
const roomReadingKey = () => roomThread ? `room:${roomThread}` : 'room';
const sessionRows = new Map();
const memberRows = new Map();
let headerControls, advancedControls;
let terminalDisplay = { fontSize: 14, palette: 'dark' };
const terminalThemes = {
  dark: { background: '#191b1e', foreground: '#e6e8eb', cursor: '#e6e8eb', selectionBackground: '#53677b88' },
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
  if (activeSessionId() === s.id && mode === 'chat') render();
}

const inputRecoveries = new Map();
const draftRevisions = new Map();
const pendingDrafts = new Map();
const draftRecoveries = new Map();
const draftRecoveryQueues = new Map();
const viewClaims = new Map();
const activeSessionId = () => selected === 'room' ? roomSession : selected;
const current = () => state?.sessions.find(s => s.id === activeSessionId());
const members = () => state?.room.archived ? [] : state?.sessions.filter(s => s.roomId === 'shared' && !s.archived) || [];
const nativeUsable = s => s && !s.archived && !s.backendUnavailable && (['starting', 'idle', 'working', 'approval'].includes(s.state) || ((s.state === 'error' || s.nativeContextPending) && s.terminalAvailable));
const canResume = s => s?.nativeId && !s.nativeContextPending && !s.backendUnavailable &&
  ((s.provider === 'codex' && s.transportDisconnected && ['error', 'disconnected'].includes(s.state) && (s.serviceCapabilities || state.capabilities || []).includes('transportReconnect')) ||
  (!s.terminalAvailable && (['ended', 'recoverable', 'error'].includes(s.state) || (s.provider === 'codex' && s.state === 'disconnected' && (s.serviceCapabilities || state.capabilities || []).includes('resubscribe'))))) &&
  ['resume', 'nativePermissionDefaults'].every(c => (s.serviceCapabilities || state.capabilities || []).includes(c));
const inputFocusAllowed = () => !sessionMenu && !roomMenu && !document.querySelector('dialog[open]');
function updateState(next) {
  const before = current(), id = activeSessionId();
  state = { ...state, ...next };
  for (const s of state.sessions || []) if (legacyProgressOffline(s)) freezeLegacyProgress(s);
  if (latestViewStorage !== undefined) state.viewStorageWarning = latestViewStorage;
  const after = current();
  if (before && after && (before.owner !== owner || after.owner !== owner)) {
    const pending = pendingDrafts.get(id);
    if (pending && pending.text !== after.liveDraft) rememberDraftRecovery(id, pending.text);
    // Observing/taking over a session reads its current draft. Do not rewrite
    // an owner's in-progress input on routine service broadcasts.
    $('message-input').value = after.liveDraft || '';
  }
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
function claimView(id, next, revision, takeControl = false) {
  const intent = state.sessions.find(s => s.id === id);
  const expectedOwner = intent?.owner, expectedControl = intent?.controlRevision;
  const pending = viewClaims.get(id);
  const isCurrent = () => selectionRevision === revision && activeSessionId() === id;
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
    if (!target || target.owner !== expectedOwner || (pending && target.controlRevision !== expectedControl) || (!takeControl && target.owner !== owner)) { render(); return false; }
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
function soloAction(s) {
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
  if (s.legacyReaderPending && s.state === 'idle') return { kind: 'send', label: '发送 ↑', hint: '输入已接通；实时过程尚待更新。在原生终端运行 /reload-plugins 后生效，无需重启。' };
  if (s.pendingQueue) return { kind: 'send', label: '等待原生接收', hint: '下一条正在等待原生开始；当前工作继续。不会自动重发，可先编辑后续草稿。' };
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
  const action = soloAction(s), send = $('send-button');
  const legacyDraft = (s?.legacyInputEligible || s?.nativeInputRequired) && s.owner === owner && !disconnected && !s.archived && ['connect', 'terminal'].includes(action.kind);
  $('message-input').readOnly = action.kind !== 'send' && !legacyDraft;
  $('message-input').disabled = false; // Saved drafts remain selectable/copyable.
  $('message-input').placeholder = action.kind === 'send' ? '直接说你想做什么…' : legacyDraft ? '可以继续编辑草稿。' : '草稿保留在这里；请使用下方操作继续。';
  send.textContent = action.label; send.type = action.kind === 'send' ? 'submit' : 'button';
  send.disabled = action.kind === 'none' || (action.kind === 'send' && (interruptPending(s) || s.pendingQueue || (s.state === 'working' && s.queueAvailable ? false : (s.state === 'working' && s.steerAvailable && s.activeTurnId ? s.pendingSteer : (s.state !== 'idle' && !(s.state === 'error' && s.failedTurnInputAvailable)) || s.pendingTag)) || s.approval || !$('message-input').value.trim() || pendingMode?.id === s.id || inputRecoveries.get(s.id)?.text.value));
  $('compose-hint').textContent = inputRecoveries.get(s?.id)?.text.value ? '上一段原生输入未确认。草稿可继续编辑；请在原生终端查看保留的文字。' : pendingMode?.id === s?.id ? '正在切换输入方式，可以先编辑草稿。' : action.hint;
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function attempt(action) { try { return await action(); } catch (error) { toast(error.message || '操作未完成。'); } }
function persistView() { normalizeRoomMention(); captureReadingViews(); return api.viewState({ readingPositions, selected, mode, preference, roomSession, terminalLayout, terminalDisplay, sharedDraft: $('shared-input').value, roomRecipient: roomRecipient(), roomMention, roomFilter: $('room-filter').value || pendingRoomFilter, roomSearch: $('room-search').value, roomThread, roomReplyTo }); }
function icon(provider) { return node('span', provider === 'claude' ? 'Cl' : 'Cx', `agent-icon ${provider}`); }
async function select(id, requestedMode, member = roomSession) {
  captureReadingViews();
  const revision = ++selectionRevision;
  const leaving = terminals.get(activeSessionId());
  cancelViewInput(leaving);
  if (leaving?.composing) leaving.term.blur();
  if (revision !== selectionRevision) return;
  if (id === 'room') roomSession = member;
  selected = id; const s = current();
  if (selected === 'room') mode = s ? 'terminal' : 'chat'; else if (requestedMode) mode = requestedMode; else if (s) mode = s.owner === owner ? s.view : preference;
  if (mode === 'terminal' && terminalLayout === 'hidden') terminalLayout = 'split';
  $('message-input').value = s?.liveDraft || '';
  clearFailedTerminal(s?.id);
  lastMessages = ''; lastRoomMessages = ''; render(); attempt(persistView);
  // Reveal only deliberate navigation (including search/restore/reopen).
  // Native state updates must not pull the person's sidebar scroll back.
  const entry = sessionRows.get(selected)?.element, list = $('session-list');
  if (entry) {
    const row = entry.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }
  if (mode === 'chat' && !chatInput().readOnly && inputFocusAllowed()) chatInput().focus();
  if (s && mode === 'terminal' && (switchedAway(s) || !['ended', 'background', 'stopping', 'disconnected', 'recoverable'].includes(s.state))) attempt(async () => { await ensureTerminal(s.id, true); focusTerminal(s.id); });
  if (selected === 'room' && s?.owner === owner && s.view !== 'terminal') attempt(async () => {
    const revision = selectionRevision;
    const stillSelected = () => revision === selectionRevision && selected === 'room' && roomSession === s.id && mode === 'terminal';
    if (!await claimView(s.id, 'terminal', revision) || !stillSelected()) return;
    render();
    await ensureTerminal(s.id, true);
    if (stillSelected()) focusTerminal(s.id);
  });
}
function selectRoom(id = '') { return select('room', undefined, id); }
async function operateNative(id) {
  if (activeSessionId() !== id) {
    const selection = selected === 'room' ? selectRoom(id) : select(id, 'terminal');
    const revision = selectionRevision;
    await selection;
    if (revision !== selectionRevision) return;
  }
  if (activeSessionId() === id) await switchMode('terminal');
}
async function detach(id) {
  const nextMode = current()?.id === id ? mode : 'terminal';
  const revision = selectionRevision;
  await api.join(id, false);
  // Membership arrives through the state stream. Do not overwrite newer state
  // or pull a person back after they have already selected another view.
  if (roomSession === id) roomSession = '';
  if (revision !== selectionRevision) { await persistView(); return; }
  await select(id, nextMode);
  const s = current(); if (s?.owner === owner && s.view !== nextMode) await claimView(id, nextMode, selectionRevision);
}
function focusTerminal(id = activeSessionId()) {
  if ((terminalCanInput(id) || canCaptureTerminal(id)) && inputFocusAllowed()) terminals.get(id).term.focus();
}
function terminalCanInput(id) {
  const entry = terminals.get(id), record = state?.sessions.find(s => s.id === id);
  return Boolean(entry?.ready && currentTerminalDisplay(entry, record) && id === activeSessionId() && mode === 'terminal' && nativeUsable(record) && record?.owner === owner && record?.view === 'terminal' && !state?.roomStorageWarning && !disconnected);
}
function currentTerminalDisplay(entry, record) {
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
function pasteTerminal(text) {
  const entry = terminals.get(activeSessionId());
  if (!terminalCanInput(activeSessionId())) throw new Error('请先连接并接管这个终端。');
  if (!text) return;
  if (text.length > 65500) throw new Error('粘贴内容过长，请分段粘贴。');
  if (/[\r\n]/.test(text) && !entry.term.modes.bracketedPasteMode) throw new Error('原生程序尚未启用多行粘贴保护，请先分行粘贴。');
  entry.term.paste(text); focusTerminal();
}
const imageFiles = transfer => Array.from(transfer?.files || []).filter(file => file.type.startsWith('image/'));
async function pasteImages(files, staged) {
  const s = current(), id = s?.id, nativeId = s?.nativeId, revision = selectionRevision;
  if (!s || !['codex', 'claude'].includes(s.provider) || s.owner !== owner || !s.terminalState?.alive || !['idle', 'working'].includes(s.state)) throw Error('请先连接并接管原生终端；图片没有放入。');
  if (!staged && (files.length > 4 || files.reduce((n, file) => n + file.size, 0) > 20 * 1024 * 1024)) throw Error('每次可放入 1–4 张图片，总大小不超过 20 MB。');
  const paths = staged || await api.stageImages(id, nativeId, await Promise.all(files.map(async file => new Uint8Array(await file.arrayBuffer()))));
  if (selectionRevision !== revision || current()?.id !== id || current()?.nativeId !== nativeId || current()?.owner !== owner) throw Error('会话或控制权已变化，图片没有放入终端。');
  const switching = switchMode('terminal'), terminalRevision = selectionRevision;
  await switching;
  if (selectionRevision !== terminalRevision || current()?.id !== id || current()?.nativeId !== nativeId || !terminalCanInput(id)) throw Error('原生输入已变化，图片没有放入终端。');
  for (const file of paths) pasteTerminal(JSON.stringify(file));
  toast('图片已放入原生输入框，确认后发送。对话草稿保留。');
}
function bindImageInput(element) {
  element.addEventListener('paste', event => {
    const files = imageFiles(event.clipboardData); if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); attempt(() => pasteImages(files));
  }, true);
  element.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  element.addEventListener('drop', event => {
    const files = imageFiles(event.dataTransfer); if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); attempt(() => pasteImages(files));
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
let trustScope = null, trustRevision = 0;
async function showTrust(options) {
  const dialog = $('privacy-dialog'), wasOpen = dialog.open, scroll = dialog.scrollTop, revision = selectionRevision, generation = ++trustRevision;
  const scope = options?.usageScope || (wasOpen ? trustScope : null);
  const snapshot = await api.initial();
  if (generation !== trustRevision || scope && revision !== selectionRevision) return;
  trustScope = scope; dialog.dataset.mode = scope ? 'usage' : 'privacy';
  dialog.querySelector('h2').textContent = scope ? `${scope.name} · 用量` : '隐私与用量';
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
    ? snapshot.sessions.filter(s => s.roomId === scope.roomId && !s.archived)
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
  if (!wasOpen) dialog.showModal(); else dialog.scrollTop = scroll;
}

function openCreate(provider = 'claude') {
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
  $('initial-view').value = preference; $('session-name').value = '';
  $('chosen-folder').textContent = folder; createReadiness(); $('create-dialog').showModal();
}
let historySearch = '', historyRows = [], historyCursor = null, historySelected = null, historyLoading = false, historyImporting = false, historyGeneration = 0;
function renderNativeHistory() {
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
  const row = historyRows.find(r => r.nativeId === historySelected), busy = historyLoading || historyImporting;
  $('confirm-native-history').disabled = busy || !row || row.existingIds?.length > 1;
  $('confirm-native-history').textContent = historyImporting ? '正在连接…' : row?.existingIds?.length ? '查看已有会话' : '继续所选会话';
  $('more-native-history').hidden = !historyCursor; $('more-native-history').disabled = busy;
  $('search-native-history').disabled = busy; $('native-history-search').disabled = busy;
  $('close-native-history').disabled = historyImporting;
}
async function loadNativeHistory(more = false) {
  if (historyLoading || historyImporting) return;
  const generation = ++historyGeneration; historyLoading = true;
  if (!more) { historySearch = $('native-history-search').value; historyRows = []; historySelected = null; historyCursor = null; }
  renderNativeHistory(); $('native-history-status').textContent = '正在读取本机原生索引…';
  try {
    const result = await api.nativeHistory({ search: historySearch, ...(more ? { cursor: historyCursor } : {}) });
    if (generation !== historyGeneration || !$('native-history-dialog').open) return;
    const seen = new Set(historyRows.map(r => r.nativeId)); historyRows.push(...result.data.filter(r => !seen.has(r.nativeId))); historyCursor = result.nextCursor;
    $('native-history-status').textContent = historyRows.length ? `已显示 ${historyRows.length} 个会话` : '没有找到会话。可修改名称重试；这里只读取原生索引，不修复或扫描历史文件。';
  } catch (error) { if (generation === historyGeneration) $('native-history-status').textContent = error.message; }
  finally { if (generation === historyGeneration) { historyLoading = false; renderNativeHistory(); } }
}
$('open-native-history').onclick = () => {
  // Claude has no history API: its own session picker opens in the new row's
  // terminal, and the chosen session is forked while the original stays as is.
  if (document.querySelector('input[name="provider"]:checked').value === 'claude') return attempt(async () => {
    const id = await api.create({ provider: 'claude', cwd: folder, name: $('session-name').value, view: 'terminal', fork: 'picker' });
    state = await api.initial(); $('create-dialog').close(); await select(id, 'terminal');
  });
  $('create-dialog').close(); historyRows = []; historySelected = null; historyCursor = null; historyLoading = false;
  $('native-history-search').value = ''; $('native-history-dialog').showModal(); loadNativeHistory();
};
$('native-history-search-form').onsubmit = event => { event.preventDefault(); loadNativeHistory(); };
$('more-native-history').onclick = () => loadNativeHistory(true);
$('close-native-history').onclick = () => $('native-history-dialog').close();
$('native-history-dialog').addEventListener('cancel', event => { if (historyImporting) event.preventDefault(); });
$('native-history-dialog').addEventListener('close', () => { historyGeneration++; historyLoading = false; });
$('confirm-native-history').onclick = async () => {
  if (historyImporting || historyLoading || !historyRows.some(r => r.nativeId === historySelected)) return;
  historyImporting = true; renderNativeHistory(); $('native-history-status').textContent = '正在连接所选原生历史；不会重发旧任务。';
  try {
    const id = await api.importHistory(historySelected); state = await api.initial();
    $('native-history-dialog').close(); await select(id, 'chat');
    if (state.sessions.find(s => s.id === id)?.archived) toast('这是已归档的原会话；可从“归档”恢复，没有创建副本。');
  } catch (error) { $('native-history-status').textContent = error.message; }
  finally { historyImporting = false; renderNativeHistory(); }
};
function openRename(id) {
  const record = id === 'room' ? { id, name: state.room.name } : state.sessions.find(s => s.id === id); if (!record) return;
  renamingId = record.id; $('rename-name').value = record.name;
  $('rename-heading').textContent = id === 'room' ? '重命名工作区' : '重命名会话';
  $('rename-error').hidden = true; $('rename-error').textContent = '';
  $('rename-dialog').showModal(); $('rename-name').focus(); $('rename-name').select();
}
function focusSessionAction(id) { if (id === 'room') $('room-more').focus(); else sessionRows.get(id)?.more.focus(); }
function openRoomMenu(point) {
  if (disconnected) return;
  if (!point && roomMenu) { roomMenu(); return; }
  roomMenu?.(); sessionMenu?.close(); $('room-more').focus(); $('room-more').setAttribute('aria-expanded', 'true');
  roomMenu = ui.menu({
    items: [{ id: 'rename', label: '重命名…' }, { id: 'notes', label: '共享笔记' }, { id: 'archive', label: '归档工作区' }],
    getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : $('room-more').getBoundingClientRect(),
    onClose: () => { roomMenu = null; $('room-more').setAttribute('aria-expanded', 'false'); $('room-more').focus(); },
    onSelect: action => { if (action === 'rename') openRename('room'); else if (action === 'notes') openNotes(); else attempt(async () => { await api.archiveRoom(); toast('工作区已归档。原生任务仍可能运行，可从归档列表恢复。'); }); },
  });
}
function openSessionMenu(id, point) {
  if (disconnected || !state.sessions.some(s => s.id === id)) return;
  if (!point && sessionMenu?.id === id) { sessionMenu.close(); return; }
  sessionMenu?.close(); roomMenu?.();
  const row = sessionRows.get(id); if (!row) return;
  row.more.focus(); row.more.setAttribute('aria-expanded', 'true');
  const close = ui.menu({
    items: [{ id: 'rename', label: '重命名…' }, { id: 'membership', label: state.sessions.find(s => s.id === id).roomId ? '脱出协作' : '加入协作' }, { id: 'window', label: '在独立窗口打开' }, ...((state.sessions.find(s => s.id === id).serviceCapabilities || state.capabilities || []).includes('observe') ? [] : [{ id: 'continue', label: '更新原会话连接' }]), { id: 'archive', label: '归档会话' }],
    getAnchorRect: () => point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : row.more.getBoundingClientRect(),
    onClose: () => { sessionMenu = null; row.more.setAttribute('aria-expanded', 'false'); focusSessionAction(id); },
    onSelect: action => { if (action === 'rename') openRename(id); else if (action === 'continue') attempt(() => api.continueConnection(id)); else if (action === 'window') attempt(() => api.newWindow(id)); else if (action === 'membership') attempt(() => state.sessions.find(s => s.id === id)?.roomId ? detach(id) : api.join(id, true)); else if (action === 'archive') attempt(async () => { await api.archiveSession(id); toast('会话已归档。原生任务仍可能运行，可从归档列表恢复。'); }); },
  });
  sessionMenu = { id, close };
}
function renderSessions() {
  const visible = state.sessions.filter(s => !s.archived);
  const ids = new Set(visible.map(s => s.id));
  if (sessionMenu && (!ids.has(sessionMenu.id) || disconnected)) sessionMenu.close();
  for (const [id, row] of sessionRows) if (!ids.has(id)) { row.element.remove(); sessionRows.delete(id); }
  visible.forEach((record, index) => {
    let row = sessionRows.get(record.id);
    if (!row) {
      const element = node('div', undefined, 'session-row'); element.dataset.sessionRow = record.id;
      const link = button('', () => select(record.id), 'session-link'); link.dataset.sessionId = record.id; link.draggable = true;
      draggableSession(link, record.id);
      const label = node('span', undefined, 'label'), name = node('span'), status = node('small'), dot = node('span');
      label.append(name, status); link.append(icon(record.provider), label, dot);
      const more = button('⋯', () => openSessionMenu(record.id), 'session-more'); more.dataset.sessionMenu = record.id;
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      // Treat the external trigger as part of DSH's menu: let its click toggle
      // the menu instead of outside-dismiss followed by an accidental reopen.
      more.addEventListener('pointerdown', event => { if (sessionMenu?.id === record.id) event.stopPropagation(); });
      element.addEventListener('contextmenu', event => { event.preventDefault(); openSessionMenu(record.id, { x: event.clientX, y: event.clientY }); });
      element.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openSessionMenu(record.id); } });
      element.append(link, more); row = { element, link, more, name, status, dot }; sessionRows.set(record.id, row);
    }
    const identity = participantLabel(record, state.sessions);
    const duplicate = identity !== record.name;
    const label = `${identity}${duplicate ? '' : record.provider === 'claude' ? ' · Claude' : ' · Codex'} · ${sessionStatus(record)}`;
    row.link.setAttribute('aria-label', label); row.link.title = label;
    row.link.classList.toggle('active', record.id === selected); row.element.classList.toggle('active', record.id === selected);
    row.more.setAttribute('aria-label', `会话操作：${identity}`); row.more.title = `会话操作：${identity}`; row.more.disabled = disconnected;
    row.name.textContent = record.name; row.status.textContent = `${sessionStatus(record)}${record.roomId ? ' · 协作中' : ''}${duplicate ? ` · ${record.id.slice(0, 6)}` : ''}`; row.dot.className = `state-dot ${record.state}`;
    // Keep existing DOM nodes: native state updates must not remove a focused
    // row or its open menu anchor every 35 ms.
    const slot = $('session-list').children[index]; if (slot !== row.element) $('session-list').insertBefore(row.element, slot || null);
  });
}
function createReadiness() {
  const historyProvider = document.querySelector('input[name="provider"]:checked').value;
  $('open-native-history').hidden = !state.capabilities?.includes(historyProvider === 'codex' ? 'nativeHistory' : 'claudeFork');
  $('open-native-history').textContent = historyProvider === 'codex' ? '继续已有 Codex 会话…' : '从已有 Claude 会话分支…';
  if (!state.capabilities?.includes('nativePermissionDefaults')) {
    $('confirm-create').disabled = true;
    $('create-readiness').textContent = '新版后台尚未连接，暂不能新建。请重新打开应用连接；已有原生会话会继续保留。';
    return;
  }
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const ready = state.preflight?.python && state.preflight?.[provider];
  $('confirm-create').disabled = !ready;
  $('create-readiness').textContent = ready ? '' : '还需要安装所选 agent 或 Python 3。点击“检查安装”查看入口。';
}
function renderArchives() {
  const records = state.sessions.filter(s => s.archived), count = records.length + Number(Boolean(state.room.archived));
  const running = records.filter(s => ['working', 'approval', 'starting', 'stopping', 'disconnected'].includes(s.state)).length;
  $('archive-label').textContent = `归档${count ? ` · ${count}` : ''}${running ? ` · ${running} 个待查看` : ''}`;
  $('archive-button').title = `归档 ${count} 项${running ? `，${running} 个原生会话仍需查看状态` : ''}`;
  if (!$('archive-dialog').open) return;
  const list = $('archive-list');
  const signature = JSON.stringify([state.room.archived, state.room.name, records.map(s => [s.id, s.name, s.state]), state.sessions.map(s => [s.id, s.name])]);
  if (list.dataset.signature === signature) return; list.dataset.signature = signature; list.replaceChildren();
  if (state.room.archived) {
    const row = node('div', undefined, 'archive-item'); row.append(node('strong', state.room.name), node('small', '工作区 · 记录与笔记已保留'), button('恢复工作区', async () => { await api.restoreRoom(); state = await api.initial(); $('archive-dialog').close(); selectRoom(); })); list.append(row);
  }
  for (const s of records) {
    const row = node('div', undefined, 'archive-item'); row.dataset.archivedSession = s.id;
    row.append(node('strong', participantLabel(s, state.sessions)), node('small', `${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${states[s.state]}${['ended', 'recoverable'].includes(s.state) ? ' · 需继续原生历史' : ' · 归档未结束原生进程'}`), button('恢复会话', () => restoreArchivedSession(s.id))); list.append(row);
  }
  if (!count) list.append(node('p', '还没有归档内容。使用会话或工作区旁的 ⋯ 菜单归档。'));
}
async function restoreArchivedSession(id) {
  await api.restoreSession(id); state = await api.initial();
  $('archive-dialog').close(); await select(id);
}
async function showSetup() {
  state.preflight = await api.preflight();
  const entries = [['claude', 'Claude Code', 'https://code.claude.com/docs/en/setup'], ['codex', 'Codex CLI', 'https://developers.openai.com/codex/cli/'], ['python', 'Python 3', 'https://www.python.org/downloads/macos/']];
  $('setup-status').replaceChildren(...entries.map(([key, label, url]) => {
    const setting = key === 'python' ? 'python3' : key;
    const row = node('div', undefined, 'setup-program');
    row.append(node('strong', `${label}：${state.preflight[key] ? '已找到' : '尚未找到'}`));
    const location = state.preflight.paths?.[key] || state.preflight.configured?.[setting];
    if (location) row.append(node('p', location, 'program-path'));
    const actions = node('div', undefined, 'actions');
    actions.append(button('安装说明', () => api.openExternal(url)), button('选择已有程序…', async () => { await api.runtimeLocation(setting); await showSetup(); }));
    if (state.preflight.configured?.[setting]) actions.append(button('自动查找', async () => { await api.runtimeLocation(setting, true); await showSetup(); }));
    row.append(actions); return row;
  }));
  if (state.preflight.error) $('setup-status').append(node('p', state.preflight.error));
  $('version-info').textContent = `应用 ${state.appVersion || '开发版'} · 后台 ${state.runtimeVersion || '旧版（会话保留中）'}。这里只检查程序文件，不代表已登录或版本兼容。已有会话保留原进程；Codex 后台已运行时，更换程序位置需先结束原会话并完全退出后台。`;
  createReadiness(); if (!$('setup-dialog').open) $('setup-dialog').showModal();
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
  return people.filter(s => s.name === session.name).length > 1 ? `${session.name} · ${session.provider === 'claude' ? 'Claude' : 'Codex'} · ${session.id.slice(0, 6)}` : session.name;
}
function historicalParticipantLabel(name, id) {
  return `${name || '历史成员'}${typeof id === 'string' && id ? ` · ${id.slice(0, 6)}` : ' · 身份未记录'}`;
}
function roomMessageLabel(m) {
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
  return [...state.room.messages, ...(state.room.events || [])].sort((a, b) => (a.time || 0) - (b.time || 0));
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
function draggableSession(element, id) {
  element.draggable = true;
  element.addEventListener('dragstart', event => {
    event.dataTransfer.setData('application/x-native-session', id); event.dataTransfer.effectAllowed = 'move';
    document.querySelector('.sidebar').classList.add('dragging-session');
  });
  element.addEventListener('dragend', () => { document.querySelector('.sidebar').classList.remove('dragging-session'); document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
}
function dropTarget(element, join) {
  element.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-native-session')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('drag-over'); } });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over'); });
  element.addEventListener('drop', event => {
    event.preventDefault(); element.classList.remove('drag-over');
    const id = event.dataTransfer.getData('application/x-native-session');
    if (state.sessions.some(s => s.id === id)) attempt(() => join ? api.join(id, true) : detach(id));
  });
}
function openNotes() {
  notesRevision = state.room.metadataRevision;
  $('room-notes-text').value = state.room.notes || ''; $('notes-error').hidden = true; $('notes-dialog').showModal();
}
function openContext() {
  const s = selected === 'room' ? null : current();
  contextTarget = s ? { id: s.id, mode } : { room: true };
  const roster = members().map(m => `${m.name} (${m.provider}, ${m.id.slice(0, 6)})`).join('、') || '暂无成员';
  $('context-text').value = `协作背景：${state.room.name}\n当前参与会话：${roster}\n${s ? (s.roomId ? `本会话仍参与该工作区。` : '本会话已独立使用，不再接收该工作区的新任务。') : '本条消息仅交给界面选定的接收者；其他成员不会自动收到。'}\n以真人当前指示为准，成员变化不代表新的执行指令。${state.room.notes ? `\n\n共享笔记：\n${state.room.notes}` : ''}`;
  // Solo drafts are owned by the native session's active window. Copying lets
  // the person paste into that window without racing a concurrent takeover.
  $('context-error').hidden = true; $('insert-context').hidden = Boolean(s);
  $('context-dialog').showModal();
}
function appendedDraft(input, text, room) {
  if (room && roomRecipient() && !nativeWorkspaceMentions.body(roomMention, input.value).trim()) return input.value + (/\s$/u.test(input.value) ? '' : ' ') + text;
  return [input.value, text].filter(Boolean).join('\n\n');
}
function mentionRosterKey() { return JSON.stringify(members().map(s => [s.id, s.name, s.provider, s.memberRevision])); }
function closeMentions() { mentionRoster = ''; mentionOptions = []; mentionRange = null; $('mention-list').hidden = true; $('shared-input').setAttribute('aria-expanded', 'false'); $('shared-input').removeAttribute('aria-activedescendant'); }
function showMentions(force = false) {
  const input = $('shared-input'), before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!force && !match) return closeMentions();
  mentionRoster = mentionRosterKey();
  mentionRange = match ? { start: before.lastIndexOf('@'), end: input.selectionStart } : null;
  const query = match ? match[1].toLocaleLowerCase() : '';
  mentionOptions = members().filter(s => `${s.name} ${s.provider}`.toLocaleLowerCase().includes(query)); mentionIndex = 0;
  $('mention-list').replaceChildren(...mentionOptions.map((s, i) => {
    const entry = button(`${s.name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${s.id.slice(0, 6)}`, () => chooseMention(s.id), 'mention-option');
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
  return person && roomMention.active === true && roomMention.memberRevision === (person.memberRevision || 0) && roomMention.text === '@' + participantLabel(person) && nativeWorkspaceMentions.valid(roomMention, $('shared-input').value) ? roomMention.id : '';
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
  input.focus(); input.setSelectionRange(0, input.value.length);
  // Chromium's native edit command keeps the textarea undo history; assigning
  // value or introducing a second editor would discard it. Routing is rebound
  // explicitly below, never by a later undo/redo text match.
  if (!document.execCommand('insertText', false, next)) input.value = next;
  roomMention = { id, active: true, memberRevision: person.memberRevision || 0, start: range.start, end: range.start + token.length, text: token };
  roomMentionEdit = null; roomDraftRevision++;
  input.setSelectionRange(roomMention.end + separator.length, roomMention.end + separator.length);
  closeMentions(); attempt(persistView); render(); input.focus();
}
function share(text) {
  if (!members().length) return toast('先把接收方加入共同工作，再分享选定内容。');
  shareRevision++;
  $('share-text').value = text; populateSelect($('share-recipient'), members()); updateSharingControls(); $('share-dialog').showModal();
}
function updateSharingControls() {
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
  const s = current(); if (!s || s.archived) return '';
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
function renderHeader(s, inRoom) {
  if (!headerControls) {
    const resume = button('继续原生会话', () => { const s = current(); if (s && canResume(s)) return api.resume(s.id); }, 'primary');
    const membership = button('', () => { const s = current(); if (s && !s.archived) return s.roomId ? detach(s.id) : api.join(s.id, true); });
    const selectedText = button('分享选中内容', () => {
      const s = current(); if (!s || s.archived) return;
      const text = selectedSharingText();
      text?.trim() ? share(text) : toast('先用鼠标选择需要分享的文字。');
    });
    const usage = button('用量', () => {
      const target = current();
      if (selected !== 'room' && !target) return;
      return showTrust({ usageScope: selected === 'room' ? { kind: 'room', roomId: state.room.id, name: state.room.name }
        : { kind: 'session', id: target.id, nativeId: target.nativeId, name: target.name } });
    });
    usage.id = 'usage-button'; usage.setAttribute('aria-label', '查看原生用量');
    const restore = button('恢复会话', () => { const s = current(); if (s?.archived) return restoreArchivedSession(s.id); }, 'primary');
    const more = button('⋯', () => openRoomMenu()); more.setAttribute('aria-label', '工作区菜单');
    headerControls = { resume, membership, selectedText, restore, more, usage };
    $('header-actions').append(resume, membership, selectedText, usage, restore, more);
  }
  const h = headerControls;
  const membershipAction = JSON.stringify([s?.id, !!s?.roomId, !!s?.archived]);
  // A peer can change membership while this control is focused. Preserve focus
  // for output updates, never for a newly opposite join/leave action.
  if (h.membership.dataset.action !== membershipAction && document.activeElement === h.membership) h.membership.blur();
  h.membership.dataset.action = membershipAction;
  h.usage.hidden = !s && !inRoom;
  h.resume.hidden = !s || !canResume(s) || mode !== 'terminal';
  h.membership.hidden = h.selectedText.hidden = !s || !!s.archived;
  h.membership.textContent = s?.roomId ? '脱出协作' : '加入协作';
  h.restore.hidden = !s?.archived;
  h.more.hidden = !inRoom || !!s;
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
function renderApproval(s, own) {
  const el = $('approval');
  const requests = s?.approvals?.length ? s.approvals : s?.approval ? [s.approval] : [];
  const requested = approvalViews.get(s?.id), chosen = requests.find(a => requested && a.requestId === requested);
  if (requested && !chosen) approvalViews.delete(s.id);
  if (chosen) s = { ...s, approval: chosen, approvalDecisions: chosen.decisions || s.approvalDecisions };
  el.hidden = !s || (s.state !== 'approval' && !s.nativeApproval && !s.approval);
  const stale = !nativeStatusFresh(s?.nativeApproval);
  const { observedAt, ...nativeApprovalContent } = s?.nativeApproval || {};
  const signature = JSON.stringify([s?.id, s?.state, own, s?.approval, requests, s?.approvalOverflow, s?.approvalNotice, s?.approvalResolved, s?.approvalDecisions, s?.nativeApproval ? nativeApprovalContent : null, stale]);
  if (el.dataset.signature === signature) return;
  el.dataset.signature = signature; el.replaceChildren();
  if (el.hidden) return;
  if (s.nativeApproval?.nativeOnly) {
    el.append(node('strong', s.name));
    if (stale) el.append(node('p', '原生状态待核验'));
    for (const request of s.nativeApproval.requests) {
      if (request.title) el.append(node('div', request.title));
      let questions;
      if (request.title === 'AskUserQuestion') { try { questions = JSON.parse(request.input).questions; } catch {} }
      if (!appendNativeQuestions(el, questions) && request.input) el.append(node('pre', request.input, 'approval-command'));
      if (request.incomplete) el.append(node('p', '请求内容未完整同步，请在原生终端核对。'));
    }
    el.append(button(`在 ${s.name} 的原生终端处理`, () => operateNative(s.id)));
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
      appendNativeQuestions(el, policy.questions);
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
  a.info.textContent = `原生 ID：${s.nativeId || '正在建立'}\n运行进程：${s.pid || '未连接'}${s.provider === 'codex' ? '\n' + nativeVersionText(s) : ''}\n后台版本：${s.runtimeVersion || state.runtimeVersion || '未报告'}\n工作目录：${s.cwd}${s.nativeContexts?.length ? '\n此前上下文（仅历史）：' + s.nativeContexts.map(c => c.nativeId).join('、') : ''}\n后台工作：${s.background ?? '原生未报告'} · 定时任务：${s.scheduled ?? '原生未报告'}`;
  a.usage.hidden = false; a.usage.textContent = window.nativeWorkspaceUsage.usageLines(s.provider, s.usage).join('\n');
  a.fleet.replaceChildren(...s.fleet.slice(-8).map(event => node('div', `${event.event}${event.kind ? ' / ' + event.kind : event.tool ? ' / ' + event.tool : ''} · ${event.name}${event.model ? ' · ' + event.model : ''}`)));
  a.stop.hidden = !switchedAway(s) && ['ended', 'background', 'stopping', 'recoverable'].includes(s.state);
  a.forget.hidden = !(['ended', 'background', 'recoverable', 'error'].includes(s.state) && !s.backendUnavailable && !s.terminalAvailable && (s.serviceCapabilities || state.capabilities)?.includes('forget'));
}
function renderMembers() {
  const people = members(), ids = new Set(people.map(s => s.id)), list = $('members');
  for (const [id, row] of memberRows) if (!ids.has(id)) {
    if (row.element.contains(document.activeElement)) $('close-members').focus();
    row.element.remove(); memberRows.delete(id);
  }
  people.forEach((record, index) => {
    let row = memberRows.get(record.id);
    if (!row) {
      const element = node('div', undefined, 'member-card'), heading = node('div', undefined, 'member-name');
      const name = node('strong'), status = node('p'), actions = node('div', undefined, 'actions');
      element.dataset.memberId = record.id; heading.append(icon(record.provider), name);
      actions.append(button('查看终端', () => { $('members-dialog').close(); selectRoom(record.id); }), button('脱出', async () => { await detach(record.id); $('members-dialog').close(); }));
      element.append(heading, status, actions); row = { element, name, status }; memberRows.set(record.id, row);
    }
    row.name.textContent = participantLabel(record, state.sessions); row.status.textContent = sessionStatus(record);
    const slot = list.children[index]; if (slot !== row.element) list.insertBefore(row.element, slot || null);
  });
}
function renderNativeActivity(s) {
  const el = $('native-activity');
  const question = s?.approval?.method === 'item/tool/requestUserInput';
  const waiting = s?.state === 'approval' || s?.nativeApproval || s?.approval && !(question && s.approval.params?.isBlocking === false);
  const live = s && !disconnected && !s.transportDisconnected && (waiting || ['working', 'approval'].includes(s.state) || s.nativeActivity && !nativeStatusFresh(s.nativeActivity));
  el.hidden = !live;
  if (!live) return;
  const status = s.nativeActivity;
  const matched = status && nativeStatusFresh(status) && status.nativeId === s.nativeId && status.turnId === s.activeTurnId;
  const seconds = matched && Number.isFinite(status.startedAt) && status.startedAt <= Date.now() ? Math.floor((Date.now() - status.startedAt) / 1000) : null;
  const label = status && !nativeStatusFresh(status) ? '原生状态待同步' : matched && status.label ? status.label : waiting ? question ? '等待回答' : '等待原生确认' : '正在处理';
  const text = (s.name || 'Codex') + ' · ' + label;
  if ($('native-phase').textContent !== text) $('native-phase').textContent = text;
  const elapsed = seconds === null ? '' : ' · 本轮已运行 ' + seconds + ' 秒';
  if ($('native-elapsed').textContent !== elapsed) $('native-elapsed').textContent = elapsed;
}
const nativeActivityClock = setInterval(() => {
  if (!state) return;
  renderNativeActivity(current());
  if (state.sessions.some(s => s.sharedActivity && !nativeStatusFresh(s.sharedActivity) || s.nativeApproval && !nativeStatusFresh(s.nativeApproval))) render();
}, 1000);
function render() {
  if (!state || rendering) return;
  captureReadingViews();
  rendering = true;
  try {
    if (selected === 'room' && state.room.archived) { selected = ''; roomSession = ''; attempt(persistView); }
    // A member may leave in another window. Keep its existing session in view.
    if (selected === 'room' && roomSession && !members().some(s => s.id === roomSession)) {
      selected = state.sessions.some(s => s.id === roomSession) ? roomSession : 'room';
      roomSession = ''; attempt(persistView);
    }
    const s = current(); const inRoom = selected === 'room';
    const slot = inRoom ? $('room-session') : $('solo-session');
    if ($('session-view').parentElement !== slot) slot.append($('session-view'));
    $('solo-session').hidden = inRoom || !s;
    $('room-session').hidden = !s;
    $('room-record-view').hidden = false;
    $('room-scope').hidden = !inRoom || !s;
    const terminalVisible = Boolean(s && terminalLayout !== 'hidden');
    $('native-pane').hidden = !terminalVisible;
    $('room-layout').classList.toggle('has-terminal', inRoom && terminalVisible);
    $('room-layout').classList.toggle('terminal-maximized', inRoom && terminalVisible && terminalLayout === 'maximized');
    $('session-layout').classList.toggle('has-terminal', !inRoom && terminalVisible);
    $('session-layout').classList.toggle('terminal-maximized', !inRoom && terminalVisible && terminalLayout === 'maximized');
    $('session-layout').classList.toggle('native-only', inRoom);
    $('conversation-pane').hidden = inRoom;
    $('chat-tab').parentElement.hidden = inRoom;
    $('session-files').hidden = inRoom;
    document.title = `${s?.name || 'Native Workspace'} — Native Agent Workspace`;
    $('welcome').hidden = Boolean(s || inRoom); $('session-view').hidden = !s; $('room-view').hidden = !inRoom;
    $('title').textContent = inRoom ? state.room.name : s?.name || '你的工作空间';
    $('subtitle').textContent = s ? `${s.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${s.model}${s.nativeSettings?.nativeId === s.nativeId ? [s.nativeSettings.mode === 'plan' ? 'Plan' : '', s.nativeSettings.effort].filter(Boolean).map(value => ' · ' + value).join('') : ''} · ${s.roomId ? '协作中，也可单独操作' : '独立会话'}` : inRoom ? '你决定谁参与、分享什么、什么时候停。' : '从一个会话开始，需要时再邀请另一个。';
    const warning = [disconnected ? '本地服务断开。草稿已保留，不会自动重发输入。' : [state.storageWarning, state.sessionNameWarning, state.roomStorageWarning].filter(Boolean).join(' '), state.viewStorageWarning].filter(Boolean).join(' ');
    $('alert').hidden = !warning; $('alert').textContent = warning || '';
    $('reconnect-button').hidden = !disconnected;
    $('retry-save').hidden = !state.viewStorageWarning && (disconnected || !state.storageRetryable);
    renderSessions();
    renderArchives(); $('room-nav').parentElement.hidden = Boolean(state.room.archived); document.querySelector('.drop-hint').hidden = Boolean(state.room.archived);
    $('workspace-empty').hidden = !state.room.archived;
    $('room-nav').classList.toggle('active', inRoom); $('member-count').textContent = members().length;
    $('room-nav-name').textContent = `◉ ${state.room.name}`; $('room-nav').title = state.room.name; $('room-nav').setAttribute('aria-label', state.room.name);
    if ($('share-dialog').open) { populateSelect($('share-recipient'), members()); updateSharingControls(); }
    if ($('invite-dialog').open) for (const entry of $('invite-list').children) {
      const record = state.sessions.find(s => s.id === entry.dataset.inviteSession);
      if (record) entry.textContent = `加入 ${participantLabel(record, state.sessions)}`;
    }
    renderHeader(s, inRoom);
    if (!s) renderNativeActivity(null);
    if (s) {
      const own = s.owner === owner; const alive = nativeUsable(s);
      $('native-pane-title').textContent = participantLabel(s, state.sessions) + ' · 原生终端';
      $('terminal-maximize').setAttribute('aria-label', terminalLayout === 'maximized' ? '恢复并排' : '放大终端');
      $('terminal-maximize').title = terminalLayout === 'maximized' ? '恢复并排' : '放大终端';
      $('session-status').textContent = `${s.archived ? '已归档 · ' : ''}${sessionStatus(s)}${s.provider === 'codex' && s.nativeVersionStatus === 'unverified' && !disconnected ? ` · Codex ${s.nativeVersion || '版本未确认'} 尚未验证` : ''}${s.activity ? ' · ' + s.activity : ''}${!own && s.owner ? ' · 另一个窗口控制' : ''}${terminals.get(s.id)?.viewInput ? ' · 输入暂存，尚未发送' : ''}`;
      $('session-status').title = nativeVersionText(s);
      $('take-control').hidden = own || !alive;
      $('chat-tab').classList.toggle('active', mode === 'chat'); $('terminal-tab').classList.toggle('active', mode === 'terminal');
      $('terminal-controls').hidden = !terminalVisible;
      $('terminal-paste').disabled = !terminalCanInput(s.id) || !alive;
      $('messages').hidden = false; $('terminal-area').hidden = !terminalVisible; $('composer-wrap').hidden = false;
      renderComposer(s); renderNativeActivity(s);
      $('interrupt').hidden = !own || !['working', 'approval'].includes(s.state);
      $('interrupt').disabled = interruptPending(s);
      readLegacyProgress(s);
      const visibleMessages = sessionMessages(s);
      const signature = JSON.stringify(visibleMessages);
      if (signature !== lastMessages || messageViews.get($('messages'))?.key !== s.id) { messageList($('messages'), visibleMessages, false, s.id); lastMessages = signature; }
      renderAdvanced(s);
      for (const [id, entry] of terminals) { entry.element.hidden = id !== s.id; entry.term.options.disableStdin = !(terminalCanInput(id) || canCaptureTerminal(id) || canFlushComposition(id)); }
      $('terminal-empty').hidden = terminals.has(s.id);
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
          const tab = button(participantLabel(m, people), () => selectRoom(m.id)); tab.dataset.roomSession = m.id; tab.title = `${participantLabel(m, people)} · 拖回左侧独立使用`; draggableSession(tab, m.id); return tab;
        }));
        tabs.dataset.signature = tabSignature;
      }
      $('room-record').setAttribute('aria-pressed', String(!roomSession));
      for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.roomSession === roomSession));
      for (const tab of tabs.children) {
        const member = people.find(m => m.id === tab.dataset.roomSession);
        const count = member.nativeApproval?.requests?.length || member.approvals?.length || (member.approval || member.approvalOverflow ? 1 : 0);
        const text = participantLabel(member, people) + (count ? ` · ${count} 待处理` : '');
        if (tab.textContent !== text) tab.textContent = text;
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
      if (waiting && !pendingRun) runText = `正在发给 ${waiting.recipientName}，等待原生接收确认。可以选择其他成员继续输入。`;
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
      if ($('run-status').textContent !== runText) $('run-status').textContent = runText;
      $('pause-button').hidden = !run && !roomSubmitting;
      renderTimeline();
      renderMembers();
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
      const unavailable = roomSubmitting || recipientPending || disconnected || !nativeWorkspaceMentions.body(roomMention, $('shared-input').value).trim();
      const threadUnsupported = roomReplyTo && (!roomThreads.rows.has(roomReplyTo) || (recipient && !recipient.legacyShare && !recipient.serviceCapabilities?.includes('replyThreads')));
      const ready = s => s && !interruptPending(s) && s.state === 'idle' && !s.nativeInputRequired && !s.pendingTag && !s.pendingQueue && !s.approval && s.shareAvailable !== false && s.chatAvailable !== false;
      const manualErrorReady = !interruptPending(recipient) && recipient?.state === 'error' && recipient.failedTurnInputAvailable && !recipient.pendingTag && !recipient.pendingQueue && !recipient.approval;
      $('forward-button').disabled = nativeRoute ? roomSubmitting || recipientPending || disconnected : unavailable || (!ready(recipient) && !manualErrorReady && !roomQueueAvailable(recipient) && !roomSteerAvailable(recipient)) || Boolean(threadUnsupported);
      $('run-button').disabled = unavailable || roomPendingRecipients.size > 0 || !recipient || !ready(recipient) || run?.status === 'running' || run?.pausePending || run?.pauseUnconfirmed || !safeHandoffs || Boolean(threadUnsupported);
      $('run-help').textContent = recipient ? `只发给 ${participantLabel(recipient)} · Enter 发送，Shift Enter 换行` : roomMention?.active === false ? '接收者已变化，重新 @ 选择。正文保留，不会发送给旧成员。' : '@ 选择接收者。加入或查看工作区不会自动发送私人历史。';
      if (roomQueueAvailable(recipient) || recipient?.pendingQueue) $('run-help').textContent += ' · 等原生下一轮接收；当前工作继续，先前私人内容不会加入共享记录。';
      if (roomSteerAvailable(recipient)) $('run-help').textContent += ' · 追加到当前原生回合；接收后的新消息块进入共享记录，先前内容不补发。';
      if (manualErrorReady) $('run-help').textContent += ' · 上次请求失败，不会自动重试或继续交接。';
      if (recipient?.legacyShare && !recipient.legacySharedReply) $('run-help').textContent += ' · 回复在成员视图查看，由你选择后再分享。';
      $('run-button').title = safeHandoffs ? '预览任务后授权有限的回复交接；不代表全部原生团队结束。' : state.handoffNotice || '现有后台暂不支持这项核查，原生会话继续保留。';
      if (nativeRoute) $('run-help').textContent = recipient?.nativeInputRequired ? 'Claude 已停止本轮，并暂停插件输入。请在原生终端输入一次后继续；共享草稿保留，不会自动发送。' : '这个会话暂不能从这里接收消息。草稿保留，查看会话不会自动粘贴或发送。';
      if (interruptPending(recipient)) $('run-help').textContent = '正在等待原生中断确认，可以继续编辑草稿；不会自动发送。';
      if (threadUnsupported) $('run-help').textContent = roomThreads.rows.has(roomReplyTo) ? '此连接尚不支持讨论回复。草稿保留；取消回复可作为新消息发送。' : '原讨论已移除。草稿保留，请先取消回复。';
      $('pause-button').textContent = run?.pauseUnconfirmed ? '重新核对暂停' : pendingRun && run?.status !== 'running' ? '取消等待' : '暂停交接';
      $('pause-button').disabled = Boolean(roomSubmitting?.cancelling) || Boolean(run?.pausePending) || (!pendingRun && run?.status !== 'running' && !run?.pauseUnconfirmed);
      if (!$('mention-list').hidden && mentionRoster !== mentionRosterKey()) showMentions();
    }
    for (const [id, entry] of terminals) entry.term.options.disableStdin = !(terminalCanInput(id) || canCaptureTerminal(id) || canFlushComposition(id));
    const approvalTarget = selected === 'room' ? (s?.nativeApproval || s?.approval || s?.state === 'approval' ? s : members().find(person => person.id === roomRecipient())) : s;
    const approvalParent = selected === 'room' ? $('room-record-view') : $('conversation-pane');
    if ($('approval').parentElement !== approvalParent) approvalParent.prepend($('approval'));
    renderApproval(approvalTarget, approvalTarget?.owner === owner);
    updateSelectedSharing();
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
  if (old && old.generation !== generation) { old.term.dispose(); old.element.remove(); terminals.delete(id); cancelViewInput(old, new Error('原生连接已变化；旧输入没有发送。')); }
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
  if (terminals.has(id)) { const existing = terminals.get(id); if (existing.ready) fitTerminal(id); return existing.pending; }
  const element = node('div', undefined, 'terminal-host'); element.dataset.terminalId = id; $('terminal-area').append(element);
  if (activeSessionId() === id) $('terminal-empty').hidden = true;
  const theme = terminalThemes[terminalDisplay.palette];
  $('terminal-area').style.backgroundColor = theme.background;
  const loading = node('p', '正在连接原生终端…', 'terminal-loading'); loading.setAttribute('role', 'status');
  const surface = node('div', undefined, 'terminal-surface'); surface.hidden = true; surface.inert = true; element.append(loading, surface);
  const term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: terminalDisplay.fontSize, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionClickForcesSelection: true, disableStdin: true, theme: { ...theme } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(surface);
  const intent = selectionRevision;
  const entry = { element, term, fit, generation, ready: false, sequence: 0, queued: [], firstTurnAttemptId: record?.activeTurnId, firstTurnHadOutput: record?.messages.some(message => message.role === 'assistant') }; terminals.set(id, entry);
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
    if (mode !== 'terminal' && activeSessionId() === id && state.sessions.find(s => s.id === id)?.owner === owner && inputFocusAllowed()) attempt(() => switchMode('terminal'));
  };
  surface.addEventListener('pointerdown', event => { if (event.button === 0) claimTerminalFocus(); }, true);
  surface.addEventListener('focusin', claimTerminalFocus);
  bindImageInput(surface);
  surface.addEventListener('paste', event => { if (imageFiles(event.clipboardData).length) return; event.preventDefault(); event.stopPropagation(); attempt(() => { if (activeSessionId() === id) pasteTerminal(event.clipboardData?.getData('text/plain') || ''); }); }, true);
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
  element.addEventListener('compositionstart', () => { entry.composing = true; compositionSequence++; entry.compositionIntent = entry.viewInput; }, true);
  element.addEventListener('compositionend', event => {
    entry.composing = false;
    // Bubble after xterm's target listener: its textarea commit timer must run
    // before this barrier. Microtasks can run between native event listeners.
    const token = { sequence: compositionSequence, consumed: false, text: event.data, cancelled: Boolean(entry.compositionIntent?.cancelled) };
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
    if (record.provider === 'codex' && !composing && (entry.keyboardFlags & 1) && !event.altKey && !event.metaKey) {
      if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey)) extendedKey = 13;
      else if (event.ctrlKey && event.key === '/') extendedKey = 47;
      else if (event.ctrlKey && event.shiftKey && /^[a-z]$/i.test(event.key)) extendedKey = event.key.toLowerCase().charCodeAt(0);
    }
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
      await new Promise(resolve => term.write(snapshot.buffer, resolve));
      entry.keyboardFlags = snapshot.keyboardFlags || 0;
      if (terminals.get(id) !== entry) return;
      entry.sequence = snapshot.sequence; entry.ready = true;
      for (const event of entry.queued) writeTerminal(entry, event);
      entry.queued = []; loading.remove(); surface.hidden = false; surface.inert = false;
      render(); fitTerminal(id); if (intent === selectionRevision) focusTerminal(id);
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
  if (activeSessionId() !== id || terminalLayout === 'hidden') return;
  if (entry.composing || entry.composition) { entry.fitPending = true; return; }
  if (entry.fitScheduled) return;
  entry.fitScheduled = true;
  requestAnimationFrame(() => {
    entry.fitScheduled = false;
    const latest = state.sessions.find(s => s.id === id);
    if (terminals.get(id) !== entry || activeSessionId() !== id || terminalLayout === 'hidden' || !entry.element.isConnected || !entry.element.checkVisibility() || latest?.owner !== owner) return;
    if (entry.composing || entry.composition) { entry.fitPending = true; return; }
    entry.fit.fit();
    const size = JSON.stringify([entry.term.cols, entry.term.rows]);
    if (entry.nativeSize === size) return;
    entry.nativeSize = size;
    attempt(async () => {
      try { await api.resize(id, entry.term.cols, entry.term.rows); }
      catch (error) { if (entry.nativeSize === size) entry.nativeSize = undefined; throw error; }
    });
  });
}
function writeTerminal(entry, event) { if ((!entry.epoch || event.epoch === entry.epoch) && event.sequence > entry.sequence) { entry.term.write(event.data); entry.keyboardFlags = event.keyboardFlags || 0; entry.sequence = event.sequence; } }
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
const observer = new ResizeObserver(() => { if (activeSessionId()) fitTerminal(activeSessionId()); }); observer.observe($('terminal-area'));
$('new-session').onclick = () => openCreate(); $('start-claude').onclick = () => openCreate('claude'); $('start-codex').onclick = () => openCreate('codex');
$('cancel-create').onclick = () => $('create-dialog').close();
$('cancel-rename').onclick = () => $('rename-dialog').close();
$('rename-dialog').oncancel = event => { if (renaming) event.preventDefault(); };
$('rename-dialog').onclose = () => { const id = renamingId; renamingId = ''; focusSessionAction(id); };
$('rename-name').onkeydown = event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault(); };
$('rename-form').onsubmit = async event => {
  event.preventDefault(); if (renaming) return;
  renaming = true; $('confirm-rename').disabled = true; $('cancel-rename').disabled = true;
  try { await (renamingId === 'room' ? api.roomRename($('rename-name').value) : api.rename(renamingId, $('rename-name').value)); $('rename-dialog').close(); toast('名称已保存。'); }
  catch (error) { $('rename-error').textContent = error.message || '名称未能保存，请重试。'; $('rename-error').hidden = false; $('rename-name').focus(); }
  finally { renaming = false; $('confirm-rename').disabled = false; $('cancel-rename').disabled = false; }
};
$('choose-folder').onclick = () => attempt(async () => { const value = await api.chooseFolder(); if (value) { folder = value; $('chosen-folder').textContent = folder; } });
$('create-form').onsubmit = event => { event.preventDefault(); attempt(async () => {
  $('confirm-create').disabled = true;
  try { const view = $('initial-view').value; preference = view; const id = await api.create({ provider: document.querySelector('input[name="provider"]:checked').value, cwd: folder, name: $('session-name').value, view }); state = await api.initial(); $('create-dialog').close(); await select(id, view); }
  finally { $('confirm-create').disabled = false; }
}); };
$('room-nav').onclick = () => attempt(() => select('room'));
$('archive-button').onclick = () => { $('archive-dialog').showModal(); renderArchives(); };
$('close-archive').onclick = () => $('archive-dialog').close();
$('room-more').onclick = () => openRoomMenu();
$('room-more').onpointerdown = event => { if (roomMenu) event.stopPropagation(); };
$('room-nav').oncontextmenu = event => { event.preventDefault(); openRoomMenu({ x: event.clientX, y: event.clientY }); };
$('room-nav').onkeydown = event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openRoomMenu(); } };
$('room-record').onclick = () => attempt(() => selectRoom());
$('manage-members').onclick = () => $('members-dialog').showModal();
$('close-members').onclick = () => { $('members-dialog').close(); focusTerminal(); };
dropTarget($('room-nav'), true); dropTarget($('solo-drop'), false); dropTarget($('session-list'), false);
$('chat-tab').onclick = () => attempt(() => switchMode('chat')); $('terminal-tab').onclick = () => attempt(() => switchMode('terminal'));
$('terminal-maximize').onclick = () => attempt(async () => { terminalLayout = terminalLayout === 'maximized' ? 'split' : 'maximized'; await switchMode('terminal'); });
$('close-native-terminal').onclick = () => attempt(async () => {
  if (selected === 'room') return selectRoom('');
  terminalLayout = 'hidden'; await switchMode('chat');
});
for (const input of [$('message-input'), $('shared-input')]) input.addEventListener('focus', () => {
  if (mode !== 'chat' && current() && inputFocusAllowed()) attempt(() => switchMode('chat'));
});
$('take-control').onclick = () => attempt(() => switchMode(mode, true));
$('terminal-copy').onclick = () => attempt(async () => { const text = terminals.get(activeSessionId())?.term.getSelection(); if (!text) return toast('先选择文字；原生程序占用鼠标时，按住 ⌥ Option 拖选，再点复制。'); await api.copy(text); focusTerminal(); });
$('terminal-paste').onclick = () => attempt(async () => {
  const s = current(), id = activeSessionId();
  const content = await api.pasteNativeContent(id, s.nativeId);
  if (activeSessionId() !== id || current()?.nativeId !== s.nativeId || mode !== 'terminal') return;
  if (content.images) await pasteImages([], content.images); else pasteTerminal(content.text);
});
$('terminal-display').onclick = () => { $('terminal-font-size').value = terminalDisplay.fontSize; $('terminal-palette').value = terminalDisplay.palette; $('terminal-display-dialog').showModal(); };
const saveTerminalDisplay = () => attempt(async () => {
  const fontSize = Number($('terminal-font-size').value);
  if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) throw new Error('字号请设为 10–24。');
  terminalDisplay = { fontSize, palette: $('terminal-palette').value }; applyTerminalDisplay(); await persistView();
});
$('terminal-font-size').onchange = $('terminal-palette').onchange = saveTerminalDisplay;
$('reset-terminal-display').onclick = () => { $('terminal-font-size').value = 14; $('terminal-palette').value = 'dark'; saveTerminalDisplay(); };
$('close-terminal-display').onclick = () => { $('terminal-display-dialog').close(); focusTerminal(); };
let filePreview = null, fileTarget = null, fileChoosing = false;
function fileTargetMatches() {
  return fileTarget && fileTarget.revision === selectionRevision && fileTarget.mode === mode &&
    (fileTarget.room ? selected === 'room' && fileTarget.id === roomRecipient() : selected !== 'room' && fileTarget.id === activeSessionId());
}
function fileDraftInput() { return fileTarget?.room ? $('shared-input') : $('message-input'); }
async function openLocalFile(room = false) {
  if (fileChoosing) return;
  fileChoosing = true;
  const target = { id: room ? roomRecipient() : activeSessionId(), room, mode, revision: selectionRevision };
  try {
    const preview = await api.openLocalFile(target.id || null);
    if (!preview) return;
    fileTarget = target;
    if (!fileTargetMatches()) { await api.closeLocalFile(preview.token); return; }
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
$('room-files').onclick = () => attempt(() => openLocalFile(true));
$('close-file').onclick = () => $('file-dialog').close();
$('file-dialog').addEventListener('close', () => {
  if (filePreview) attempt(() => api.closeLocalFile(filePreview.token));
  filePreview = null; fileTarget = null; $('file-content').textContent = '';
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
    else { input.oninput(); input.focus(); }
  } catch (error) {
    if ($('file-dialog').open) { $('file-error').textContent = error.message; $('file-error').hidden = false; }
    else toast(error.message);
  }
};
$('save-file').onclick = async () => {
  if (!filePreview) return;
  $('save-file').disabled = true;
  try { if (await api.saveLocalFile(filePreview.token)) toast('已保存预览副本。'); }
  catch (error) { $('file-error').textContent = error.message; $('file-error').hidden = false; }
  finally { $('save-file').disabled = false; }
};
$('message-input').oninput = () => {
  const s = current();
  if (s) {
    const revision = (draftRevisions.get(s.id) || 0) + 1;
    draftRevisions.set(s.id, revision);
    const pending = { text: $('message-input').value, revision };
    pendingDrafts.set(s.id, pending); s.liveDraft = pending.text;
    attempt(async () => {
      try { await api.draft(s.id, pending.text); }
      catch (error) {
        if (draftRevisions.get(s.id) === revision && pending.text) rememberDraftRecovery(s.id, pending.text);
        throw error;
      } finally {
        if (pendingDrafts.get(s.id) === pending) pendingDrafts.delete(s.id);
        if (activeSessionId() === s.id) renderDraftRecovery(s.id);
      }
    });
    renderComposer(s);
  }
};
bindImageInput($('message-input'));
$('message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !$('message-input').readOnly) { event.preventDefault(); if (!$('send-button').disabled) $('composer').requestSubmit(); } };
$('send-button').onclick = () => attempt(async () => {
  if ($('send-button').disabled) return;
  const s = current(), action = soloAction(s);
  if (action.kind === 'terminal') await switchMode('terminal');
  else if (action.kind === 'connect') {
    const revision = selectionRevision;
    await api.prepareInput(s.id);
    if (revision !== selectionRevision || current()?.id !== s.id) return;
    if (s.provider === 'codex') {
      const fresh = await api.initial();
      if (revision !== selectionRevision || current()?.id !== s.id) return;
      updateState(fresh); render();
      if (mode === 'chat' && inputFocusAllowed() && !$('message-input').readOnly) $('message-input').focus();
      return;
    }
    await switchMode('terminal');
    if (current()?.id === s.id && mode === 'terminal') toast('请在此会话运行 /reload-plugins；连接成功后即可切回对话输入。');
  }
  else if (action.kind === 'claim') await switchMode(s.chatAvailable === false && !s.legacyInputEligible ? 'terminal' : 'chat', true);
  else if (action.kind === 'resume') await api.resume(s.id);
});
$('composer').onsubmit = event => {
  event.preventDefault();
  if ($('send-button').disabled || soloAction(current()).kind !== 'send') return;
  // The clicked action can become disabled/hidden in the next state update.
  // Return to editing now, before any asynchronous reply can change selection.
  if (inputFocusAllowed()) $('message-input').focus();
  attempt(async () => {
    const id = activeSessionId(), nativeId = current()?.nativeId, text = $('message-input').value, revision = draftRevisions.get(id);
    const s = current();
    const receipt = s?.state === 'working' && s.queueAvailable
      ? await api.queue(id, text, nativeId) : s?.state === 'working' && s.steerAvailable && s.activeTurnId
      ? await api.steer(id, text, nativeId, s.activeTurnId) : await api.send(id, text, nativeId);
    if (!receipt?.contextChanged && current()?.nativeId === nativeId && !current()?.nativeContextPending && activeSessionId() === id && draftRevisions.get(id) === revision && $('message-input').value === text) $('message-input').value = '';
  });
};
$('interrupt').onclick = () => {
  const id = activeSessionId();
  if (mode === 'chat' && inputFocusAllowed() && !$('message-input').readOnly) $('message-input').focus();
  if (pendingInterrupts.has(id)) return;
  pendingInterrupts.add(id); render();
  attempt(async () => { try { await api.interrupt(id); } finally { pendingInterrupts.delete(id); render(); } });
};
$('shared-input').onbeforeinput = event => { const input = $('shared-input'); roomMentionEdit = { before: input.value, start: input.selectionStart, end: input.selectionEnd, type: event.inputType }; };
$('shared-input').oninput = event => {
  const edit = roomMentionEdit; roomMentionEdit = null;
  roomMention = edit ? nativeWorkspaceMentions.edited(roomMention, edit.before, $('shared-input').value, edit) : null;
  roomDraftRevision++; attempt(persistView); render(); if (event.inputType === 'insertText' && !event.isComposing) showMentions(); else closeMentions(); };
$('shared-input').oncompositionend = () => showMentions();
$('shared-input').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (!$('mention-list').hidden) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % (mentionOptions.length || 1); highlightMention(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMentions(); return; }
    if (event.key === 'Enter') { event.preventDefault(); if (mentionOptions[mentionIndex]) chooseMention(mentionOptions[mentionIndex].id); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !$('shared-input').readOnly) { event.preventDefault(); if (!$('forward-button').disabled) { if ($('forward-button').type === 'button') $('forward-button').click(); else $('room-composer').requestSubmit(); } }
};
$('shared-input').onblur = event => { if (!event.relatedTarget?.closest('#mention-list')) closeMentions(); };
async function submitRoom(automatic) {
  if (roomSubmitting || (automatic ? roomPendingRecipients.size > 0 : roomPendingRecipients.has($('recipient').value)) || $('shared-input').readOnly || $(automatic ? 'run-button' : 'forward-button').disabled) return;
  const first = roomRecipient(), raw = $('shared-input').value, text = nativeWorkspaceMentions.body(roomMention, raw), revision = roomDraftRevision, address = roomMention && { ...roomMention };
  const ids = automatic?.ids;
  const recipient = members().find(s => s.id === first);
  if (!recipient) throw Error('接收方已变化，请重新选择。');
  if (recipient.nativeInputRequired || recipient.shareAvailable === false || recipient.chatAvailable === false || !nativeUsable(recipient)) return;
  // Return focus before the clicked control becomes disabled. Never steal it
  // back asynchronously after the person has opened another view or dialog.
  $('shared-input').focus();
  const submission = { automatic: Boolean(automatic), recipientName: participantLabel(recipient), cancelling: false, cancelRequested: false };
  if (automatic) roomSubmitting = submission;
  else roomPendingRecipients.set(first, submission);
  render();
  try {
    const receipt = await (automatic ? api.run(ids, text, automatic.limit, automatic.mode || 'replies', automatic.labels, automatic.contexts, roomReplyTo || undefined, automatic.identities) : roomQueueAvailable(recipient) ? api.queueShared(first, text, recipient.nativeId, roomReplyTo || undefined) : roomSteerAvailable(recipient) ? api.steerShared(first, text, recipient.nativeId, recipient.activeTurnId, roomReplyTo || undefined) : api.forward(first, text, recipient.nativeId, roomReplyTo || undefined));
    if (submission.cancelRequested || receipt?.contextChanged) return;
    if (revision === roomDraftRevision && $('shared-input').value === raw && roomRecipient() === first && roomMention?.memberRevision === address?.memberRevision && roomMention?.text === address?.text) { $('shared-input').value = roomMention.text + ' '; roomMention = { ...roomMention, start: 0, end: roomMention.text.length }; roomDraftRevision++; await persistView(); }
  }
  catch (error) { if (!submission.cancelRequested) throw error; }
  finally {
    submission.settled = true;
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
  if (nativeUsable(recipient)) selectRoom(recipient.id); else select(recipient.id, 'chat');
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
    label.append(check, document.createTextNode(`${s.name} · ${s.provider === 'claude' ? 'Claude' : 'Codex'} · ${s.id.slice(0, 6)}`));
    check.onchange = () => {
      runPreview.ids = check.checked ? [...ids, s.id] : ids.filter(id => id !== s.id);
      $('run-consent').checked = false; renderRunChoices();
      document.querySelector(`[data-run-member="${s.id}"]`)?.focus();
    };
    row.append(label);
    const position = ids.indexOf(s.id);
    if (position > 1) {
      const up = button('↑', () => { [ids[position - 1], ids[position]] = [ids[position], ids[position - 1]]; $('run-consent').checked = false; renderRunChoices(); });
      up.setAttribute('aria-label', `提前 ${s.name} · ${s.id.slice(0, 6)}`); row.append(up);
    }
    $('run-participants').append(row);
  }
  for (const option of $('run-limit').options) option.disabled = Number(option.value) < ids.length;
  if (Number($('run-limit').value) < ids.length) $('run-limit').value = String(ids.length);
  const sequence = Array.from({ length: Number($('run-limit').value) }, (_, i) => {
    const s = members().find(s => s.id === ids[i % ids.length]);
    return s ? `${s.name} (${s.id.slice(0, 6)})` : '未选择';
  });
  $('run-order').textContent = directed ? `由第一位开始，在所选成员中明确选择下一位；上限 ${$('run-limit').value} 次回复，不广播私人历史。` : `转交顺序：${sequence.join(' → ')}。只转交任务与上一份回复，不附加私人历史。`;
  $('confirm-run').disabled = !$('run-consent').checked || ids.length < 2 || (directed && !capable);
}
$('run-button').onclick = () => {
  if ($('run-button').disabled) return;
  $('room-advanced').open = false;
  if (nativeWorkspaceMentions.body(roomMention, $('shared-input').value).length > 6000) { toast('一起核查的任务与材料合计最多 6000 字符。草稿保留；可缩短后核查，或定向发送。'); $('shared-input').focus(); return; }
  const recipient = roomRecipient(), candidates = handoffCandidates(recipient);
  runPreview = { text: nativeWorkspaceMentions.body(roomMention, $('shared-input').value), recipient, revision: roomDraftRevision, selectionRevision,
    members: members().map(s => [s.id, s.memberRevision, s.name, s.nativeId]), identities: Object.fromEntries(members().map(s => [s.id, s.peerIdentity])), ids: [recipient, candidates.find(s => s.id !== recipient)?.id].filter(Boolean) };
  $('run-preview').textContent = runPreview.text;
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
  const same = selected === 'room' && runPreview.selectionRevision === selectionRevision && runPreview.text === nativeWorkspaceMentions.body(roomMention, $('shared-input').value) && runPreview.recipient === $('recipient').value && runPreview.revision === roomDraftRevision && JSON.stringify(runPreview.members) === JSON.stringify(members().map(s => [s.id, s.memberRevision, s.name, s.nativeId]));
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
$('room-notes').onclick = openNotes; $('cancel-notes').onclick = () => $('notes-dialog').close();
$('notes-form').onsubmit = async event => {
  event.preventDefault(); $('save-notes').disabled = true;
  try { await api.roomNotes($('room-notes-text').value, notesRevision); $('notes-dialog').close(); }
  catch (error) { $('notes-error').textContent = error.message; $('notes-error').hidden = false; }
  finally { $('save-notes').disabled = false; }
};
$('attach-context').onclick = () => { $('room-advanced').open = false; openContext(); }; $('close-context').onclick = () => $('context-dialog').close();
$('copy-context').onclick = () => attempt(async () => { await api.copy($('context-text').value); toast('已复制，尚未发送给 agent。'); });
$('insert-context').onclick = () => attempt(async () => {
  const target = contextTarget, text = $('context-text').value;
  if (!target?.room || selected !== 'room') throw Error('当前视图已变化，请重新打开协作背景。');
  const input = $('shared-input');
  const next = appendedDraft(input, text, true);
  if (next.length > 16000) { $('context-error').textContent = '合并后的草稿超过 16000 字符，请先缩短。'; $('context-error').hidden = false; return; }
  input.value = next;
  roomDraftRevision++; await persistView();
  $('context-dialog').close(); render(); input.focus();
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
    await api.pause();
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
$('invite-button').onclick = () => { $('members-dialog').close(); $('invite-list').replaceChildren(...state.sessions.filter(s => !s.roomId && !s.archived && s.state !== 'ended').map(s => { const entry = button(`加入 ${participantLabel(s, state.sessions)}`, async () => { await api.join(s.id, true); $('invite-dialog').close(); }); entry.dataset.inviteSession = s.id; return entry; })); if (!$('invite-list').children.length) $('invite-list').append(node('p', '先创建一个独立会话。')); $('invite-dialog').showModal(); };
$('close-invite').onclick = () => $('invite-dialog').close();
$('cancel-share').onclick = () => $('share-dialog').close();
$('share-dialog').onclose = () => { shareRevision++; };
$('confirm-share').onclick = () => attempt(async () => {
  updateSharingControls();
  if ($('confirm-share').disabled) return;
  const request = { revision: shareRevision, recipient: $('share-recipient').value, text: $('share-text').value };
  sharePending = request; updateSharingControls();
  try {
    const nativeId = members().find(s => s.id === request.recipient)?.nativeId;
    const receipt = await api.forward(request.recipient, request.text, nativeId);
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
$('clear-shared-history').onclick = () => attempt(() => { if (!state.capabilities?.includes('clearSharedHistory')) throw new Error('后台仍在保留旧版会话；结束它们并重开应用后可使用此功能。'); return api.clearSharedHistory(); });
$('close-privacy').onclick = () => { trustRevision++; trustScope = null; $('privacy-dialog').close(); focusTerminal(); };
$('reconnect-button').onclick = () => attempt(async () => { $('reconnect-button').disabled = true; try { await api.reconnect(); } finally { $('reconnect-button').disabled = false; } });
$('retry-save').onclick = () => attempt(async () => {
  $('retry-save').disabled = true;
  try { await api.retrySave(); if (!disconnected) updateState(await api.initial()); render(); }
  finally { $('retry-save').disabled = false; }
});
$('search-button').onclick = () => openSearch();
$('close-search').onclick = () => $('search-dialog').close();
$('search-preview-back').onclick = renderSearch;
$('search-dialog').addEventListener('close', () => { clearTimeout(searchTimer); ui.clearMarkdown($('search-preview-body')); $('search-preview-body').textContent = ''; });
$('search-input').oninput = event => { clearTimeout(searchTimer); if (!event.isComposing) searchTimer = setTimeout(() => { searchLimit = 60; renderSearch(); }, 100); };
$('search-input').oncompositionend = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchLimit = 60; renderSearch(); }, 100); };
$('search-input').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('search-dialog').close(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); renderSearch(); $('search-results').querySelector('button')?.focus(); }
  if (event.key === 'Enter') { event.preventDefault(); renderSearch(); if ($('search-results').querySelectorAll('button').length === 1) $('search-results').querySelector('button').click(); else $('search-results').querySelector('button')?.focus(); }
};
$('search-scope').onchange = $('search-archived').onchange = () => { searchLimit = 60; renderSearch(); };
$('search-more').onclick = () => { searchLimit += 60; renderSearch(); };
$('return-reading').onclick = () => attempt(returnToReading);
document.addEventListener('keydown', searchKey);
$('setup-button').onclick = $('create-setup').onclick = $('refresh-setup').onclick = () => attempt(showSetup);
$('close-setup').onclick = () => $('setup-dialog').close();
for (const input of document.querySelectorAll('input[name="provider"]')) input.onchange = createReadiness;
attempt(async () => {
  state = await api.initial();
  if (latestViewStorage !== undefined) state.viewStorageWarning = latestViewStorage;
  owner = state.owner; folder = state.defaultWorkspace; preference = state.viewState.preference || 'terminal'; mode = state.viewState.mode || preference;
  terminalLayout = ['hidden', 'split', 'maximized'].includes(state.viewState.terminalLayout) ? state.viewState.terminalLayout : 'split';
  readingPositions = state.viewState.readingPositions || {};
  roomSession = typeof state.viewState.roomSession === 'string' ? state.viewState.roomSession : '';
  const display = state.viewState.terminalDisplay;
  if (display && Number.isInteger(display.fontSize) && display.fontSize >= 10 && display.fontSize <= 24 && terminalThemes[display.palette]) terminalDisplay = display;
  $('shared-input').value = typeof state.viewState.sharedDraft === 'string' ? state.viewState.sharedDraft : '';
  $('room-search').value = state.viewState.roomSearch || ''; pendingRoomFilter = state.viewState.roomFilter || '';
  roomThread = state.viewState.roomThread || ''; roomReplyTo = state.viewState.roomReplyTo || '';
  const savedRecipient = state.viewState.roomRecipient;
  const savedMention = state.viewState.roomMention;
  if (savedMention && nativeWorkspaceMentions.validView(savedMention, $('shared-input').value, savedRecipient)) roomMention = savedMention;
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
return () => { clearInterval(nativeActivityClock); document.removeEventListener('toggle', updateSelectedSharing, true); document.removeEventListener('selectionchange', documentSelectionChanged); document.removeEventListener('keydown', searchKey); clearTimeout(searchTimer); disposeReadingViews(); sessionMenu?.close(); roomMenu?.(); for (const dispose of disposers) dispose(); observer.disconnect(); clearTimeout(toastTimer); for (const entry of terminals.values()) entry.term.dispose(); };
