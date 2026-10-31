const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage, session, shell, screen, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureService, connect, connectService, continuationStatus, continueService } = require('./service-client.cjs');
const { startDsh, resetUiAuthentication } = require('./dsh-host.cjs');
const { startupMessage } = require('./ui-errors.cjs');
const { preflight, appBuildInfo } = require('./preflight.cjs');
const { setLocation } = require('./runtime-locations.cjs');
const { pathToFileURL } = require('node:url');
const { submissionState, assertNativeCreation, capabilitiesFor } = require('./submission-policy.cjs');
const { readPreview, saveCopy, extensions: textExtensions, openMessageFile } = require('./local-files.cjs');
const { ImagePreviews } = require('./native-images.cjs');
const { SessionLabels } = require('./session-labels.cjs');
const { RoomState } = require('./room-state.cjs');
const { readingState } = require('./reading-state.cjs');
const { ViewStore, validViews } = require('./view-store.cjs');
const { roomId: validRoomId } = require('./collaboration-spaces.cjs');
const { identity: roomPeerIdentity } = require('./peer-handoffs.cjs');
const { windowPlacement } = require('./window-placement.cjs');
const { backups, beginDraft, acknowledgeDraft, acceptSentDraft, forgetDraft, retainRecovery, discardRecovery } = require('./view-drafts.cjs');

app.setName('Native Agent Workspace');
process.env.NAW_APP_VERSION = app.getVersion();
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync']) app.commandLine.appendSwitch(flag);
const normalDataDir = app.getPath('userData');
if (process.env.NAW_DATA_DIR) app.setPath('userData', path.resolve(process.env.NAW_DATA_DIR));
// Headed test runs belong to their launcher, not to a forgotten background job.
// This is opt-in for the test command; normal desktop sessions have no parent lease.
const testParent = Number(process.env.NAW_TEST_PARENT_PID);
// Existing headed launchers supply both a real parent and a private profile.
// Set macOS activation policy before ready/window creation, not after firstWindow.
const testRequested = Object.hasOwn(process.env, 'NAW_TEST_PARENT_PID');
function canonicalNormalProfile(target) {
  try { return fs.realpathSync(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(canonicalNormalProfile(path.dirname(target)), path.basename(target));
  }
}
let backgroundTest = false;
if (testRequested) {
  try {
    const profile = process.env.NAW_DATA_DIR && fs.realpathSync(path.resolve(process.env.NAW_DATA_DIR));
    const info = profile && fs.statSync(profile);
    backgroundTest = /^\d+$/.test(process.env.NAW_TEST_PARENT_PID) && Number.isSafeInteger(testParent) && testParent > 1 && process.ppid === testParent && Boolean(profile) && profile !== canonicalNormalProfile(normalDataDir) && info.isDirectory() && typeof process.getuid === 'function' && info.uid === process.getuid() && (info.mode & 0o077) === 0;
  } catch { /* An unverifiable profile must never fall through to foreground. */ }
  if (!backgroundTest) { console.error('Invalid isolated headed-test parent/profile; no window opened.'); process.exit(1); }
}
// A normal background relaunch restores the user's real state without showing
// a window in their current Space. The user's later activation restores normal
// Dock behavior and reveals the restored window.
let backgroundLaunch = process.argv?.includes('--background') === true;
if ((backgroundTest || backgroundLaunch) && process.platform === 'darwin') app.setActivationPolicy('accessory');
if (testParent > 1) {
  const checkParent = () => { if (process.ppid !== testParent) app.quit(); };
  const lease = setInterval(checkParent, 1000); lease.unref();
  app.whenReady().then(checkParent);
}
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
const windows = new Map();
const toolWaitNotifications = new Map();
let entry, dsh;
const trusted = url => { try { const parsed = new URL(url); return parsed.origin === dsh.origin && parsed.pathname === '/'; } catch { return false; } };
let dataDir, sessionLabels, roomState, viewStore, viewStorageWarning = null, views = [], quitting = false;
let startupWindow, starting = false, wired = false;
let applicationBuild;
const startupFile = path.join(__dirname, 'startup.html');
function windowOptions(view = {}) { return { title: 'Native Agent Workspace', width: 1240, height: 850, ...view.bounds, show: !backgroundTest && !backgroundLaunch, focusable: !backgroundTest, minWidth: Math.min(850, view.bounds?.width || 850), minHeight: Math.min(600, view.bounds?.height || 600), backgroundColor: '#f8f8f5', webPreferences: { ...(backgroundTest ? { backgroundThrottling: false } : {}), preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } }; }
function createWindow(view) {
  const win = new BrowserWindow(windowOptions(view));
  return win;
}
function notifyToolWait(snapshot, win) {
  for (const s of snapshot.sessions || []) {
    const activity = s.nativeActivity, notice = activity?.waitNotice;
    if (s.state !== 'working' || s.transportDisconnected || s.nativeContextPending || s.approval || s.approvalOverflow || s.claudeQuestion ||
        !s.nativeId || !s.activeTurnId || activity?.phase === 'approval' ||
        notice?.kind !== 'tool-wait' || notice.nativeId !== s.nativeId || notice.turnId !== s.activeTurnId ||
        activity?.nativeId !== s.nativeId || activity.turnId !== s.activeTurnId || activity.stale === true ||
        notice.marker !== activity.toolWait?.marker || notice.progressAt !== activity.toolWait?.progressAt ||
        typeof s.id !== 'string' || !Number.isFinite(notice.createdAt)) continue;
    const key = `${s.nativeId}:${s.activeTurnId}`, prior = toolWaitNotifications.get(s.id);
    if (prior?.key === key || prior && notice.createdAt < prior.time) continue;
    const record = { key, time: notice.createdAt }; toolWaitNotifications.set(s.id, record);
    try {
      if (!Notification.isSupported()) continue;
      const notification = record.notification = new Notification({ title: 'NAW · 工具等待提醒', body: '原生工具较长时间未返回。请检查原生界面或系统权限提示；任务没有自动重发。' });
      // A notification is an observation of that past turn, never a session-only
      // interrupt action that could accidentally target its replacement.
      notification.once('click', () => { if (!win.isDestroyed()) win.show(); });
      notification.once('close', () => { if (record.notification === notification) delete record.notification; });
      notification.show();
    } catch { /* The existing in-app status remains available if OS delivery fails. */ }
  }
}
function bindClient(context) {
  const { win, client } = context;
  // Rechecked by the router after awaited pauses as well as at IPC entry.
  // A task already accepted natively is not retroactively cancelled.
  client.authorizeOperation = (method, args, roomId = 'shared') => {
    if (['send', 'queue', 'queueShared', 'steerShared', 'steer', 'forward', 'run', 'input', 'claim', 'terminal', 'approve', 'answer', 'draft', 'resume'].includes(method)) {
      for (const id of (method === 'run' && Array.isArray(args[0]) ? args[0] : [args[0]])) roomState.assertAvailable(id, ['forward', 'queueShared', 'steerShared', 'run'].includes(method), roomId);
    }
  };
  const send = (channel, data) => { if (context.client === client && !win.isDestroyed()) win.webContents.send(channel, data); };
  client.on('state', data => { if (context.client === client && !win.isDestroyed()) { send('workspace:state', displayState(data, context)); notifyToolWait(data, win); } });
  client.on('terminal', data => send('workspace:terminal', data));
  client.on('progress', data => send('workspace:progress', data));
  client.on('closed', () => { if (context.client === client) send('workspace:disconnected', '本地运行服务断开。输入不会自动重发，请保留当前草稿。'); });
}
function displayState(snapshot, context) {
  const roomId = context?.view?.spaceId || 'shared';
  const display = roomState.apply(sessionLabels.apply(submissionState(snapshot)), roomId);
  return { ...display, sessions: display.sessions.map(s => ({ ...s, peerIdentity: roomPeerIdentity(s, roomId), sharedActivity: s.sharedActivities?.[roomId] || (roomId === 'shared' ? s.sharedActivity : null) })), viewStorageWarning };
}
function reportViewStorage(warning) {
  if (viewStorageWarning === warning) return;
  viewStorageWarning = warning;
  for (const { win } of windows.values()) if (!win.isDestroyed()) win.webContents.send('workspace:view-storage', warning);
}
async function broadcastRoom() {
  await Promise.allSettled([...windows.values()].map(async context => {
    if (context.win.isDestroyed() || context.client.socket.destroyed) return;
    const snapshot = await context.client.call('initial');
    if (!context.win.isDestroyed()) context.win.webContents.send('workspace:state', displayState(snapshot, context));
  }));
}
function broadcastName(id, name) {
  for (const context of windows.values()) if (!context.win.isDestroyed()) context.win.webContents.send('workspace:session-name', { id, name });
}

let readingSaveTimer, readingSavePromise, finishReadingSave, failReadingSave;
function saveViews() {
  clearTimeout(readingSaveTimer);
  const resolve = finishReadingSave, reject = failReadingSave;
  readingSavePromise = finishReadingSave = failReadingSave = undefined;
  try {
    if (!viewStore) throw Error('界面记录尚未读取，未写入空白记录。');
    viewStore.save(views);
    reportViewStorage(null);
    resolve?.();
  } catch (error) {
    reportViewStorage('界面与草稿副本未能保存。窗口已保留；请检查磁盘空间或本机数据权限，再点“重试保存”。');
    reject?.(error); throw error;
  }
}
function saveReadingSoon() {
  if (!readingSavePromise) {
    readingSavePromise = new Promise((resolve, reject) => { finishReadingSave = resolve; failReadingSave = reject; });
    readingSaveTimer = setTimeout(() => { try { saveViews(); } catch { /* Returned through each awaiting IPC call. */ } }, 150);
  }
  return readingSavePromise;
}
async function openWindow(saved) {
  if (quitting) return;
  const view = saved || { owner: randomUUID(), selected: '', mode: 'terminal', preference: 'terminal', active: true };
  if (view.bounds) view.bounds = windowPlacement(view.bounds, screen);
  backups(view);
  if (!views.includes(view)) views.push(view);
  view.active = true; saveViews();
  const client = await connect(dataDir, view.owner);
  if (quitting) { client.close(); return; }
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : createWindow(view);
  startupWindow = null;
  if (view.bounds) {
    win.setMinimumSize(Math.min(850, view.bounds.width), Math.min(600, view.bounds.height));
    win.setBounds(view.bounds);
  }
  const context = { win, client, view, failed: false };
  windows.set(win.webContents.id, context); bindClient(context);
  const ready = new Promise((resolve, reject) => { context.ready = resolve; context.readyTimer = setTimeout(() => reject(new Error('UI did not become ready')), 25000); });
  ready.catch(() => {}); // loadURL may fail before the readiness timer fires.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('page-title-updated', event => { event.preventDefault(); win.setTitle('Native Agent Workspace'); });
  win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const id = win.webContents.id;
  win.on('close', event => {
    if (quitting || context.failed) return;
    view.bounds = win.getBounds(); const wasActive = view.active; view.active = false;
    try { saveViews(); }
    catch { view.active = wasActive; event.preventDefault(); }
  });
  win.on('closed', () => {
    // A renderer/webContents shutdown can bypass the cancellable close event.
    if (!quitting && !context.failed && view.active !== false) {
      view.active = false;
      try { saveViews(); } catch { view.active = true; }
    }
    windows.delete(id); context.imagePreviews?.close(); context.client.close();
  });
  try { await win.loadURL(entry); await ready; }
  catch (error) { if (quitting || win.isDestroyed()) return; throw new Error(startupMessage(error)); }
  finally { clearTimeout(context.readyTimer); }
  return win;
}
function hasSavedSpaceDraft(records, targetId) {
  return Boolean(targetId && records.some(view => view.roomViews?.[targetId]?.sharedDraft || view.spaceId === targetId && view.sharedDraft));
}
function connectionUpdateOptions(client, applicationVersion, profile) {
  const alpha = value => typeof value === 'string' && value.match(/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-alpha\.(0|[1-9]\d*)$/);
  const current = alpha(applicationVersion), seen = new Set(), options = [];
  const visibleIds = profile ? new Set(profile.apply(client.snapshot()).sessions.filter(record => !record.archived).map(record => record.id)) : null;
  for (const entry of client.entries) {
    if (seen.has(entry.key)) continue; seen.add(entry.key);
    const visible = entry.state.sessions.filter(record => visibleIds ? visibleIds.has(record.id) : !record.archived);
    if (!visible.length || entry.state.runtimeVersion === applicationVersion) continue;
    const record = visible.find(value => value.nativeId) || visible[0], version = entry.state.runtimeVersion, reported = alpha(version);
    const old = reported && current && reported[1] === current[1] && Number.isSafeInteger(Number(reported[2])) && Number.isSafeInteger(Number(current[2])) && Number(reported[2]) < Number(current[2]);
    const status = continuationStatus(entry.state, record.id);
    const unavailable = entry.closed || entry.closing || client.closing || client.control?.maintenance.has(entry.key);
    const effectiveActive = entry.state.sessions.some(value => (client.sessionState?.(value) || value.state) !== 'ended');
    options.push({ backendKey: entry.key, id: record.id, nativeId: record.nativeId || null, version: version || null,
      count: visible.length, ready: Boolean(old && status.ready && !unavailable && !effectiveActive),
      reason: unavailable ? '这个后台连接正在更新或已断开，原会话继续保留。' : !old ? '版本未知、较新或无法比较，不能把它当作旧后台自动更新。原连接保留。'
        : effectiveActive ? status.reason || '原生会话尚未确认结束；原连接保留，不会自动安排重启。' : status.reason || '' });
  }
  return options;
}
function register(name, handler) {
  ipcMain.handle(`workspace:${name}`, async (event, ...args) => {
    const context = windows.get(event.sender.id);
    if (!context || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Unexpected IPC source');
    try { return { ok: true, value: await handler(context, ...args) }; }
    catch (error) { return { ok: false, error: error.message || '操作未完成。' }; }
  });
}
async function boot() {
  dataDir = app.getPath('userData'); fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dataDir, 0o700);
  sessionLabels = new SessionLabels(dataDir);
  roomState = new RoomState(dataDir);
  viewStore = new ViewStore(dataDir);
  views = viewStore.load();
  process.env.NAW_RUNTIME_CONFIG = path.join(dataDir, 'runtime-locations.json');
  await ensureService(dataDir, process.execPath);
  if (quitting) return;
  dsh = await startDsh(dataDir); entry = dsh.url;
  if (quitting) { dsh.stop(); return; }
  // The fresh launch URL authenticates all restored windows after this cleanup.
  await resetUiAuthentication(session.defaultSession);
  for (const view of views) { try { view.readingPositions = readingState(view.readingPositions || {}); } catch { view.readingPositions = {}; } }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).host !== new URL(dsh.origin).host }));
  if (!wired) {
  wired = true;
  for (const name of ['prepareInput', 'observe', 'unobserve', 'claim', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'pause', 'approve', 'answer', 'wakePolicy']) register(name, (c, ...args) => {
    if (['prepareInput', 'claim', 'terminal', 'input', 'approve', 'answer'].includes(name)) roomState.assertAvailable(args[0]);
    return c.client.call(name, ...args);
  });
  register('retrySave', async c => {
    if (viewStorageWarning) saveViews();
    // The window record is independent of provider/service availability.
    if (!c.client.socket.destroyed && (await c.client.call('initial')).storageRetryable) await c.client.call('retrySave');
    return true;
  });
  register('join', async (c, id, join) => {
    try { await roomState.membership(c.client, id, join, sessionLabels.labels.get(id)); }
    finally { await broadcastRoom(); }
  });
  register('roomRename', async (_c, name) => { roomState.rename(name); await broadcastRoom(); });
  register('roomNotes', async (_c, text, revision) => { roomState.notes(text, revision); await broadcastRoom(); });
  register('roomMemberOrder', async (c, change) => {
    const snapshot = await c.client.call('initial');
    roomState.moveMember(change, snapshot.sessions); await broadcastRoom();
  });
  register('archiveSession', async (c, id) => { try { await roomState.archiveSession(c.client, id, sessionLabels.labels.get(id)); } finally { await broadcastRoom(); } });
  register('restoreSession', async (c, id) => {
    const state = await c.client.call('initial'); if (!state.sessions.some(s => s.id === id)) throw Error('原生会话记录不可用。');
    roomState.restoreSession(id); await broadcastRoom();
  });
  register('archiveRoom', async c => { try { await roomState.archiveRoom(c.client, sessionLabels.labels); } finally { await broadcastRoom(); } });
  register('restoreRoom', async c => { try { await roomState.restoreRoom(c.client, sessionLabels.labels); } finally { await broadcastRoom(); } });
  register('spaceCreate', async (_c, name) => { const id = roomState.create(name); await broadcastRoom(); return id; });
  register('spaceMerge', async (c, action, value) => {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('无效合并请求。');
    if (action === 'preview') return roomState.mergePreview(c.client, value);
    if (!validRoomId(value.operationId) || value.operationId === 'shared' || Object.keys(value).some(key => !['operationId', 'binding'].includes(key))) throw Error('合并记录无法核对。');
    if (action === 'discard') { roomState.discardMergePreview(value.operationId); return; }
    if (action === 'status') return roomState.mergeStatus(c.client, value.operationId);
    if (!['commit', 'recover', 'undo'].includes(action) || !/^[a-f0-9]{64}$/u.test(value.binding)) throw Error('无效合并确认。');
    try {
      const targetId = roomState.mergeRecord(value.operationId)?.id;
      const keepDraft = hasSavedSpaceDraft(views, targetId);
      return action === 'undo' ? await roomState.mergeUndo(c.client, value.operationId, value.binding, keepDraft)
        : await roomState.mergeCommit(c.client, value.operationId, value.binding, action === 'recover');
    } finally { await broadcastRoom(); }
  });
  register('spaceAction', async (c, roomId, action, args = []) => {
    if (!validRoomId(roomId) || !Array.isArray(args) || args.length > 8) throw Error('无效协作空间操作。');
    roomState.metadata(roomId); // Never reinterpret a missing space as shared.
    if (action === 'join') {
      try { return await roomState.membership(c.client, args[0], args[1], sessionLabels.labels.get(args[0]), roomId, args[2]); }
      finally { await broadcastRoom(); }
    }
    if (action === 'rename') roomState.rename(args[0], roomId);
    else if (action === 'notes') roomState.notes(args[0], args[1], roomId);
    else if (action === 'memberOrder') roomState.moveMember(args[0], (await c.client.call('initial')).sessions, roomId);
    else if (action === 'archive' || action === 'restore') {
      try { return await roomState[action === 'archive' ? 'archiveRoom' : 'restoreRoom'](c.client, sessionLabels.labels, roomId); }
      finally { await broadcastRoom(); }
    } else if (action === 'removeFile') roomState.removeFile(args[0], args[1], roomId);
    else if (['forward', 'queueShared', 'steerShared', 'run', 'pause', 'clearSharedHistory'].includes(action)) {
      if (action === 'clearSharedHistory') {
        roomState.writable(roomId);
        const value = roomState.metadata(roomId), revision = value.revision;
        const answer = await dialog.showMessageBox(c.win, { type: 'warning', message: `清除「${value.name}」的共享记录？`, detail: '仅清除这个空间的共享消息、成员时间线和笔记。文件引用和原生会话保留，已经收到的内容无法撤回。', buttons: ['取消', '清除共享记录'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return false;
        if (roomState.metadata(roomId).revision !== revision) throw Error('空间资料已变化，请重新核对后清除。');
        roomState.writable(roomId);
        await c.client.callSpace(roomId, action, []);
        try { roomState.clear(revision, roomId); } catch (error) { throw Error(`共享消息已清除，时间线和笔记已保留。${error.message}`); }
        await broadcastRoom(); return true;
      }
      if (action !== 'pause') for (const id of action === 'run' && Array.isArray(args[0]) ? args[0] : [args[0]]) roomState.assertAvailable(id, true, roomId);
      if (action === 'run' && Array.isArray(args[0])) {
        const snapshot = sessionLabels.apply(c.client.snapshot(roomId));
        if (args[4] && args[0].some(id => args[4][id] !== snapshot.sessions.find(s => s.id === id)?.name)) throw Error('参与者名称已变化，请重新预览任务。');
        args[4] = Object.fromEntries(args[0].filter(id => sessionLabels.labels.has(id)).map(id => [id, sessionLabels.labels.get(id)]));
      }
      return c.client.callSpace(roomId, action, args);
    } else throw Error('不支持的协作空间操作。');
    await broadcastRoom();
  });
  register('spaceFiles', async (c, roomId, fileId) => {
    if (!validRoomId(roomId)) throw Error('无效协作空间。');
    const value = roomState.metadata(roomId);
    if (fileId !== undefined) {
      const file = value.files.find(f => f.id === fileId); if (!file) throw Error('文件引用已变化，请重新打开。');
      const preview = await readPreview(file.path);
      if (c.win.isDestroyed() || !roomState.metadata(roomId).files.some(f => f.id === fileId && f.path === file.path)) throw Error('空间文件列表已变化，未打开。');
      c.filePreview = preview;
      return { token: preview.token, name: preview.name, text: preview.text, size: preview.bytes.length };
    }
    roomState.assertAvailable(null, true, roomId);
    if (c.fileChoosing) throw Error('文件选择窗口已经打开。');
    c.fileChoosing = true;
    try {
      const result = await dialog.showOpenDialog(c.win, { title: `添加到「${value.name}」的本机文件`, filters: [{ name: '文本材料', extensions: textExtensions }], properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
      if (result.canceled || c.win.isDestroyed()) return false;
      for (const file of result.filePaths) await readPreview(file);
      roomState.assertAvailable(null, true, roomId); roomState.addFiles(result.filePaths, roomId); await broadcastRoom(); return true;
    } finally { c.fileChoosing = false; }
  });
  register('gitWorktreePreview', async (c, selected, nonce, relative) => {
    if (selected !== c.worktreeSource) throw Error('请先选择要复制的仓库目录。');
    const revision = c.worktreePreviewRevision = (c.worktreePreviewRevision || 0) + 1;
    c.worktreePlan = null;
    const plan = await c.client.call('gitWorktreePreview', selected, nonce, relative);
    if (c.win.isDestroyed() || c.worktreeSource !== selected || c.worktreePreviewRevision !== revision) throw Error('仓库预览已变化，未准备工作副本。');
    c.worktreePlan = plan; return plan;
  });
  register('create', async (c, ...args) => {
    assertNativeCreation(await c.client.call('initial'));
    if (args[0]?.gitWorktree != null) {
      const requested = args[0].gitWorktree, plan = c.worktreePlan;
      if (!plan || Object.keys(requested).length !== Object.keys(plan).length || Object.keys(plan).some(key => requested[key] !== plan[key])) throw Error('Git 工作副本预览已失效，请重新选择；未启动会话。');
      c.worktreePlan = null;
    }
    return c.client.call('create', ...args);
  });
  register('nativeHistory', (c, options) => c.client.call('nativeHistory', options));
  register('importHistory', (c, nativeId, options) => c.client.call('importHistory', nativeId, options));
  register('rename', async (c, id, name) => {
    const snapshot = await c.client.call('initial');
    if (!snapshot.sessions.some(s => s.id === id)) throw new Error('找不到这个会话，名称未更改。');
    const saved = sessionLabels.set(id, name);
    broadcastName(id, saved);
    return saved;
  });
  register('sidebar', async (c, change) => {
    const snapshot = roomState.apply(await c.client.call('initial'));
    sessionLabels.updateSidebar(change, snapshot.sessions);
    await broadcastRoom();
  });
  // The workspace router registers human/run intent before its first await and
  // applies the same capability gates for one or several retained services.
  const submit = (c, method, ...args) => {
    for (const id of (method === 'run' ? args[0] : [args[0]])) roomState.assertAvailable(id, !['send', 'queue', 'steer'].includes(method));
    return c.client.call(method, ...args);
  };
  for (const method of ['run', 'forward', 'queueShared', 'steerShared']) register(method, (c, ...args) => {
    if (method === 'run' && Array.isArray(args[0])) {
      if (args[4]) {
        const snapshot = sessionLabels.apply(c.client.snapshot());
        if (args[0].some(id => args[4][id] !== snapshot.sessions.find(s => s.id === id)?.name)) throw Error('参与者名称已变化，请重新预览任务。');
      }
      args[4] = Object.fromEntries(args[0].filter(id => sessionLabels.labels.has(id)).map(id => [id, sessionLabels.labels.get(id)]));
    }
    return submit(c, method, ...args);
  });
  register('uiReady', c => c.ready?.());
  for (const method of ['send', 'queue', 'steer']) register(method, async (c, id, text, nativeId, turnId) => {
    const draft = backups(c.view)[id];
    const result = await submit(c, method, id, text, nativeId, ...(method === 'steer' ? [turnId] : []));
    // Every draft edit replaces this object, including retyping identical text.
    // A late acceptance must not clear a newer recovery copy.
    if (!result?.contextChanged && acceptSentDraft(c.view, id, draft, text)) {
      try { saveViews(); } catch { /* Native acceptance stands; the independent storage warning remains actionable. */ }
    }
    return result;
  });
  register('preflight', () => preflight());
  register('runtimeLocation', async (c, key, reset = false) => {
    if (!['claude', 'codex', 'python3'].includes(key) || typeof reset !== 'boolean') throw Error('未知程序设置。');
    if (reset) setLocation(process.env.NAW_RUNTIME_CONFIG, key, null);
    else {
      const result = await dialog.showOpenDialog(c.win, { title: '选择已安装的原生程序', buttonLabel: '使用这个程序', properties: ['openFile', 'showHiddenFiles'] });
      if (!result.canceled && result.filePaths.length === 1) setLocation(process.env.NAW_RUNTIME_CONFIG, key, result.filePaths[0]);
    }
    return preflight();
  });
  register('dataDirectory', () => shell.openPath(dataDir));
  register('quitService', async c => { await c.client.call('shutdown'); app.quit(); });
  register('clearSharedHistory', async c => {
    const state = await c.client.call('initial');
    if (state.room.run?.pausePending || state.room.run?.pauseUnconfirmed) throw Error('请先核对各后台已撤销后续交接授权，再清除共享记录。');
    const answer = await dialog.showMessageBox(c.win, { type: 'warning', message: '清除共同工作记录？', detail: '清除本应用里的共享消息、成员时间线和共享笔记，并停止尚未完成的分享回写。名称与各个原生会话保留，不能撤回其他 agent 已收到的内容。正在执行的原生任务不会因此取消。', buttons: ['取消', '清除共享记录'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) {
      const revision = roomState.value.revision;
      await c.client.call('clearSharedHistory');
      try { roomState.clear(revision); } catch (error) { throw Error(`共享消息已清除，时间线和笔记已保留。${error.message}`); }
      await broadcastRoom(); return true;
    }
  });
  register('draft', async (c, id, text) => {
    if (typeof text !== 'string' || text.length > 16000) throw new Error('草稿过长。');
    if (typeof id !== 'string' || id.length > 100) throw new Error('无效会话。');
    const draft = beginDraft(c.view, id, text); saveViews();
    try { roomState.assertAvailable(id); await c.client.call('draft', id, text); }
    catch (error) {
      if (backups(c.view)[id] === draft && text) { retainRecovery(c.view, id, text); saveViews(); }
      throw error;
    }
    if (acknowledgeDraft(c.view, id, draft)) saveViews();
  });
  for (const [name, operation] of [['retainDraftRecovery', retainRecovery], ['discardDraftRecovery', discardRecovery]]) register(name, (c, id, text) => {
    if (typeof id !== 'string' || id.length > 100 || typeof text !== 'string' || text.length > 16000) throw new Error('无效草稿副本。');
    const copies = operation(c.view, id, text); saveViews(); return copies;
  });
  register('reconnect', async c => {
    await ensureService(dataDir, process.execPath);
    const client = await connect(dataDir, c.view.owner), old = c.client;
    c.client = client; bindClient(c); old.close(); await c.win.reload();
  });
  register('connectionUpdates', async c => {
    await c.client.refresh();
    return connectionUpdateOptions(c.client, app.getVersion(), roomState);
  });
  register('continueConnection', async (c, id, expected) => {
    await c.client.refresh();
    const target = c.client.route(id), status = continuationStatus(target.state, id);
    const guard = c.client.operationGuard(target), nativeId = target.state.sessions.find(record => record.id === id)?.nativeId, version = target.state.runtimeVersion;
    const matches = value => value && value.backendKey === target.key && value.nativeId === nativeId && value.version === version;
    if (expected !== undefined && (!matches(expected) || !connectionUpdateOptions(c.client, app.getVersion(), roomState).some(option => option.id === id && option.ready && matches(option)))) throw Error('后台身份、版本或更新资格已变化；原连接保留，请重新核对。');
    if (!status.ready) {
      await dialog.showMessageBox(c.win, { type: 'info', message: '保留原会话，等待原生工作结束', detail: status.reason, buttons: ['知道了'] });
      return false;
    }
    const answer = await dialog.showMessageBox(c.win, {
      type: 'warning', message: '更新这个已结束会话的连接？',
      detail: '保留原会话身份、历史、草稿和协作关系。更新会关闭这个旧运行服务；原生后台或子任务若仍存在可能被中断，请先确认它们已结束。之后可点“继续原生会话”，不会重发旧任务，也不会重建活动团队。其他仍在工作的连接不受影响。',
      buttons: ['保留原连接', '已核对，更新连接'], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) return false;
    guard(); await c.client.refresh(); guard();
    const current = c.client.route(id), record = current.state.sessions.find(value => value.id === id), fresh = continuationStatus(current.state, id);
    if (current !== target || current.state.runtimeVersion !== version || record?.nativeId !== nativeId || !fresh.ready ||
        expected !== undefined && !connectionUpdateOptions(c.client, app.getVersion(), roomState).some(option => option.id === id && option.ready && matches(option))) throw Error('核对期间后台或原生工作已变化；原连接保留，没有更新。');
    const finishMaintenance = c.client.maintainService(target.key);
    try {
    const { key } = await continueService(dataDir, process.execPath, id);
    // Replace only the ended backend's sockets. Other live transports and every
    // renderer DOM/IME stay intact; reopening a window is unnecessary.
    const replacements = [];
    try {
      for (const context of windows.values()) if (!context.win.isDestroyed()) {
        const client = await connectService(path.join(dataDir, key), context.view.owner);
        const replacement = { context, client }; replacements.push(replacement);
        replacement.state = await client.call('initial');
      }
    } catch (error) { for (const replacement of replacements) replacement.client.close(); throw error; }
    for (const { context, client, state } of replacements) {
      context.client.replaceService(key, client, state);
      if (!context.client.socket.destroyed && !context.win.isDestroyed()) context.win.webContents.send('workspace:reconnected', displayState(await context.client.refresh(), context));
    }
    return true;
    } finally { finishMaintenance(); }
  });
  for (const action of ['resume', 'forget']) register(action, async (c, id) => {
    const snapshot = await c.client.call('initial');
    const record = snapshot.sessions.find(s => s.id === id);
    const resubscribe = action === 'resume' && (record?.state === 'disconnected' || record?.transportDisconnected);
    if (action === 'resume') assertNativeCreation(snapshot, id);
    if (resubscribe && !capabilitiesFor(snapshot, id).includes('resubscribe')) throw new Error('这个后台尚不支持重新连接；原生会话仍保留。');
    if (record?.transportDisconnected && !capabilitiesFor(snapshot, id).includes('transportReconnect')) throw new Error('这个后台尚不支持恢复图形连接；已有终端保持原样。');
    if (!capabilitiesFor(snapshot, id).includes(action)) throw new Error('这个会话的后台暂不支持此操作；原生会话已保留。');
    // The explicit resume action already expresses consent. The workspace
    // still verifies identity, ownership and liveness before native resume.
    if (action === 'resume') return c.client.call(action, id);
    const answer = await dialog.showMessageBox(c.win, {
      type: 'question', message: '移除此应用中的会话记录？',
      detail: '移除本应用的会话副本和草稿。原生服务中的历史与共同工作中已分享的内容仍保留。',
      buttons: ['取消', '移除记录'], defaultId: 0, cancelId: 0,
    });
    if (answer.response === 1) {
      await c.client.call(action, id);
      if (action === 'forget') {
        for (const view of views) { delete view.readingPositions?.[id]; forgetDraft(view, id); if (view.selected === id) view.selected = ''; }
        saveViews();
        try { sessionLabels.remove(id); } catch { throw new Error('会话记录已移除，但本地显示名未能清理。请检查本机数据权限与磁盘空间。'); }
      }
    }
  });
  register('stop', async (c, id) => {
    const record = (await c.client.call('initial')).sessions.find(s => s.id === id);
    if (!record) throw new Error('找不到这个会话。');
    const codex = record.provider === 'codex';
    const answer = await dialog.showMessageBox(c.win, {
      type: 'warning', message: codex ? '断开这个 Codex 会话？' : '结束这个原生会话？',
      detail: codex ? '关闭本应用终端连接，并请求中断已知的当前回合。原生线程及后台任务可能仍在运行或缓存，确认释放前不会标记已结束。原生历史保留。' : '这会停止本应用托管的原生主进程，并等待退出确认。原生后台团队的状态仍需在原生界面确认。只关闭窗口或脱出协作不会结束它。',
      buttons: ['保留会话', codex ? '断开连接' : '结束会话'], defaultId: 0, cancelId: 0,
    });
    if (answer.response === 1) return c.client.call('stop', id);
  });
  register('openExternal', (_c, href) => { const url = new URL(href); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接类型不支持。'); return shell.openExternal(url.href); });
  register('openMessageFile', (c, source, file, options) => openMessageFile({
    snapshot: async () => roomState.apply(await c.client.call('initial')),
    openPath: target => shell.openPath(target),
    isCurrent: () => !c.win.isDestroyed() && windows.get(c.win.webContents.id) === c,
  }, source, file, options));
  register('initial', async c => { const appBuild = await (applicationBuild ||= appBuildInfo(app, dataDir)); return { ...displayState(await c.client.call('initial'), c), viewState: c.view, appVersion: app.getVersion(), appBuild, preflight: preflight() }; });
  register('readingState', (c, positions) => { c.view.readingPositions = readingState(positions); return saveReadingSoon(); });
  register('viewState', (c, next) => {
    if (!next || typeof next.selected !== 'string' || next.selected.length > 100 || !['chat', 'terminal'].includes(next.mode)) throw new Error('无效界面状态。');
    if (next.terminalLayout !== undefined && !['hidden', 'split', 'maximized'].includes(next.terminalLayout)) throw new Error('无效终端布局。');
    if (next.terminalSplit !== undefined && !(Number.isFinite(next.terminalSplit) && next.terminalSplit >= 0.2 && next.terminalSplit <= 0.8)) throw new Error('无效分栏宽度。');
    if (next.roomSession !== undefined && (typeof next.roomSession !== 'string' || next.roomSession.length > 100)) throw new Error('无效协作视图。');
    if (next.roomRecipient !== undefined && (typeof next.roomRecipient !== 'string' || next.roomRecipient.length > 100)) throw new Error('无效协作接收方。');
    if (next.roomFilter !== undefined && (typeof next.roomFilter !== 'string' || next.roomFilter.length > 100)) throw new Error('无效成员筛选。');
    for (const key of ['roomThread', 'roomReplyTo']) if (next[key] !== undefined) require('./room-threads.js').replyReference(next[key]);
    if (next.roomSearch !== undefined && (typeof next.roomSearch !== 'string' || next.roomSearch.length > 1000)) throw new Error('搜索词过长。');
    if (next.sharedDraft !== undefined && (typeof next.sharedDraft !== 'string' || next.sharedDraft.length > 16000)) throw new Error('协作草稿过长。');
    if (next.roomMention !== undefined && next.roomMention !== null && !require('./room-mention.js').validView(next.roomMention, next.sharedDraft, next.roomRecipient)) throw new Error('无效协作提及。');
    if (next.terminalDisplay !== undefined && (!next.terminalDisplay || !Number.isInteger(next.terminalDisplay.fontSize) || next.terminalDisplay.fontSize < 10 || next.terminalDisplay.fontSize > 24 || !['dark', 'green'].includes(next.terminalDisplay.palette))) throw new Error('无效终端显示设置。');
    if (!validViews([{ ...c.view, ...next }])) throw Error('空间界面记录无效；草稿没有覆盖。');
    for (const key of ['spaceId', 'sidebarView', 'sidebarSpaceFilter', 'roomViews']) if (next[key] !== undefined) c.view[key] = structuredClone(next[key]);
    // Retained UI rollback must still see only the original shared draft.
    if (next.roomViews) for (const key of ['sharedDraft', 'roomSession', 'roomRecipient', 'roomMention', 'roomFilter', 'roomSearch', 'roomThread', 'roomReplyTo']) next[key] = next.roomViews.shared?.[key] ?? (key === 'roomMention' ? null : '');
    const positions = next.readingPositions === undefined ? undefined : readingState(next.readingPositions);
    Object.assign(c.view, { selected: next.selected, mode: next.mode, preference: ['chat', 'terminal'].includes(next.preference) ? next.preference : c.view.preference });
    if (next.terminalLayout !== undefined) c.view.terminalLayout = next.terminalLayout;
    if (next.terminalSplit !== undefined) c.view.terminalSplit = next.terminalSplit;
    if (positions !== undefined) c.view.readingPositions = positions;
    if (next.sharedDraft !== undefined) c.view.sharedDraft = next.sharedDraft;
    if (next.roomSession !== undefined) c.view.roomSession = next.roomSession;
    if (next.roomRecipient !== undefined) c.view.roomRecipient = next.roomRecipient;
    if (next.roomMention !== undefined) c.view.roomMention = next.roomMention;
    if (next.roomFilter !== undefined) c.view.roomFilter = next.roomFilter;
    if (next.roomSearch !== undefined) c.view.roomSearch = next.roomSearch;
    for (const key of ['roomThread', 'roomReplyTo']) if (next[key] !== undefined) c.view[key] = next[key];
    if (next.terminalDisplay !== undefined) c.view.terminalDisplay = { fontSize: next.terminalDisplay.fontSize, palette: next.terminalDisplay.palette };
    saveViews();
  });
  register('openLocalFile', async (c, sessionId) => {
    if (c.fileChoosing) throw Error('文件选择窗口已经打开。');
    c.fileChoosing = true;
    try {
      const snapshot = await c.client.call('initial');
      const record = snapshot.sessions.find(s => s.id === sessionId);
      if (sessionId && !record) throw Error('会话已变化，请重新打开文件。');
      const result = await dialog.showOpenDialog(c.win, { title: '查看材料或成果', defaultPath: record?.cwd || snapshot.defaultWorkspace,
        filters: [{ name: '文本材料', extensions: textExtensions }], properties: ['openFile', 'dontAddToRecent'] });
      if (result.canceled || c.win.isDestroyed()) return null;
      const preview = await readPreview(result.filePaths[0]);
      if (c.win.isDestroyed()) return null;
      c.filePreview = preview;
      return { token: preview.token, name: preview.name, text: preview.text, size: preview.bytes.length };
    } finally { c.fileChoosing = false; }
  });
  register('closeLocalFile', (c, token) => { if (c.filePreview?.token === token) c.filePreview = null; });
  register('saveLocalFile', async (c, token) => {
    const preview = c.filePreview;
    if (!preview || preview.token !== token || c.fileSaving) throw Error('文件预览已变化，请重新打开。');
    c.fileSaving = true;
    try {
      const ext = path.extname(preview.name);
      const result = await dialog.showSaveDialog(c.win, { title: '保存预览的副本（不覆盖已有文件）', defaultPath: `${path.basename(preview.name, ext)}-copy${ext}`, properties: ['dontAddToRecent'] });
      if (result.canceled || c.win.isDestroyed()) return false;
      if (c.filePreview !== preview) throw Error('文件预览已变化，未保存。');
      await saveCopy(preview, result.filePath); return true;
    } finally { c.fileSaving = false; }
  });
  register('chooseFolder', async c => {
    const result = await dialog.showOpenDialog(c.win, { title: '选择这个会话可以工作的目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || c.win.isDestroyed()) return null;
    c.worktreeSource = result.filePaths[0]; c.worktreePlan = null;
    c.worktreePreviewRevision = (c.worktreePreviewRevision || 0) + 1;
    return result.filePaths[0];
  });
  register('newWindow', async (c, id) => { const snapshot = await c.client.call('initial'); if (id && !snapshot.sessions.some(s => s.id === id)) throw new Error('找不到会话。'); await openWindow({ owner: randomUUID(), selected: id || '', mode: c.view.mode, preference: c.view.preference, active: true }); });
  register('copy', (_c, text) => { if (typeof text !== 'string' || text.length > 100000) throw new Error('复制内容无效。'); return clipboard.writeText(text); });
  // Read only when the person presses Paste; never watch or persist clipboard content.
  register('pasteText', async () => { const text = await clipboard.readText(); if (text.length > 65500) throw new Error('粘贴内容过长，请分段粘贴。'); return text; });
  const imageTarget = async (c, id, expectedNativeId) => {
    roomState.assertAvailable(id);
    const snapshot = await c.client.call('initial'), record = snapshot.sessions.find(s => s.id === id);
    if (!record || !['codex', 'claude'].includes(record.provider) || record.owner !== c.view.owner || record.nativeId !== expectedNativeId || record.nativeContextPending || !record.terminalState?.alive || !['idle', 'working'].includes(record.state)) throw Error('请先连接并接管原生终端；图片没有放入。');
    return record;
  };
  register('stageImages', async (c, id, nativeId, files) => {
    await imageTarget(c, id, nativeId);
    return require('./local-images.cjs').saveImages(dataDir, id, files, nativeImage);
  });
  register('pasteNativeContent', async (c, id, nativeId) => {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      await imageTarget(c, id, nativeId);
      return { images: require('./local-images.cjs').saveImages(dataDir, id, [image.toPNG()], nativeImage) };
    }
    // Text keeps the original paste path, including native permission/question
    // prompts. Only importing images requires the stricter idle/working gate.
    const text = clipboard.readText(); if (text.length > 65500) throw Error('粘贴内容过长，请分段粘贴。'); return { text };
  });
  const imagesFor = c => c.imagePreviews ||= new ImagePreviews({ nativeImage,
    snapshot: async () => roomState.apply(await c.client.call('initial')) });
  register('previewImage', (c, source) => imagesFor(c).preview(source));
  register('expandImage', (c, token) => imagesFor(c).expand(token));
  register('copyImage', (c, token) => imagesFor(c).copy(token, clipboard));
  register('releaseImage', (c, token) => c.imagePreviews?.release(token));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: '退出界面（会话继续运行）', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { label: '文件', submenu: [{ label: '新窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => openWindow() }, { label: '新会话', accelerator: 'CmdOrCtrl+N', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('workspace:new') }, { role: 'close' }] },
    { role: 'editMenu' }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
  ]));
  }
  const restore = views.filter(v => v.active);
  if (restore.length) for (const view of restore) await openWindow(view);
  else await openWindow(views.at(-1));
  if (quitting) return;

}
async function start() {
  if (starting || quitting) return; starting = true;
  if (!startupWindow || startupWindow.isDestroyed()) { startupWindow = createWindow(); await startupWindow.loadFile(startupFile); }
  startupWindow.webContents.send('workspace:startup', { title: '正在打开你的工作空间', detail: '连接本机服务，恢复上次的界面…', retry: false });
  try { await boot(); }
  catch (error) {
    dsh?.stop();
    for (const c of [...windows.values()]) { c.failed = true; c.client.close(); c.win.destroy(); }
    if (!quitting && (!startupWindow || startupWindow.isDestroyed())) {
      startupWindow = createWindow(); await startupWindow.loadFile(startupFile);
    }
    if (!quitting && startupWindow && !startupWindow.isDestroyed()) startupWindow.webContents.send('workspace:startup', { title: '暂时未能打开', detail: startupMessage(error), retry: true, data: error.code === 'NAW_VIEW_RECORD' });
  } finally { starting = false; }
}
ipcMain.handle('workspace:retry-startup', event => { if (startupWindow?.webContents === event.sender && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(startupFile).href) return start(); });
ipcMain.handle('workspace:startup-data', event => { if (startupWindow?.webContents === event.sender && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(startupFile).href && viewStore && !viewStore.loaded) return shell.openPath(dataDir); });
function focusOrOpen() {
  if (backgroundLaunch && !backgroundTest && process.platform === 'darwin') app.setActivationPolicy('regular');
  backgroundLaunch = false;
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : windows.values().next().value?.win;
  if (win) { if (!backgroundTest) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
  else if (!starting && !quitting) { if (dsh && wired) openWindow(views.at(-1)).catch(() => start()); else start(); }
}
app.on('activate', focusOrOpen);
app.on('second-instance', (_event, argv) => { if (!argv?.includes('--background')) focusOrOpen(); });
if (primary) app.whenReady().then(start);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  try {
    if (viewStore?.loaded) {
      for (const { win, view } of windows.values()) if (!win.isDestroyed()) view.bounds = win.getBounds();
      saveViews();
    }
  } catch { event.preventDefault(); return; }
  quitting = true; dsh?.stop();
});
// Deliberately no native shutdown here: GUI lifecycle is independent of sessions.
