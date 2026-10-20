const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureService, connect, connectService, continuationStatus, continueService } = require('./service-client.cjs');
const { startDsh } = require('./dsh-host.cjs');
const { startupMessage } = require('./ui-errors.cjs');
const { preflight } = require('./preflight.cjs');
const { setLocation } = require('./runtime-locations.cjs');
const { pathToFileURL } = require('node:url');
const { submissionState, assertNativeCreation, capabilitiesFor } = require('./submission-policy.cjs');
const { SessionLabels } = require('./session-labels.cjs');
const { RoomState } = require('./room-state.cjs');
const { readingState } = require('./reading-state.cjs');
const { ViewStore } = require('./view-store.cjs');
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
if (backgroundTest && process.platform === 'darwin') app.setActivationPolicy('accessory');
if (testParent > 1) {
  const checkParent = () => { if (process.ppid !== testParent) app.quit(); };
  const lease = setInterval(checkParent, 1000); lease.unref();
  app.whenReady().then(checkParent);
}
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
const windows = new Map();
let entry, dsh;
const trusted = url => { try { const parsed = new URL(url); return parsed.origin === dsh.origin && parsed.pathname === '/'; } catch { return false; } };
let dataDir, sessionLabels, roomState, viewStore, views = [], quitting = false;
let startupWindow, starting = false, wired = false;
const startupFile = path.join(__dirname, 'startup.html');
function windowOptions(view = {}) { return { title: 'Native Agent Workspace', width: 1240, height: 850, ...view.bounds, ...(backgroundTest ? { show: false, focusable: false } : {}), minWidth: 850, minHeight: 600, backgroundColor: '#f8f8f5', webPreferences: { ...(backgroundTest ? { backgroundThrottling: false } : {}), preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } }; }
function createWindow(view) {
  const win = new BrowserWindow(windowOptions(view));
  return win;
}
function bindClient(context) {
  const { win, client } = context;
  // Rechecked by the router after awaited pauses as well as at IPC entry.
  // A task already accepted natively is not retroactively cancelled.
  client.authorizeOperation = (method, args) => {
    if (['send', 'forward', 'run', 'input', 'claim', 'terminal', 'approve', 'draft', 'resume'].includes(method)) {
      for (const id of (method === 'run' && Array.isArray(args[0]) ? args[0] : [args[0]])) roomState.assertAvailable(id, ['forward', 'run'].includes(method));
    }
  };
  const send = (channel, data) => { if (context.client === client && !win.isDestroyed()) win.webContents.send(channel, data); };
  client.on('state', data => send('workspace:state', displayState(data, context)));
  client.on('terminal', data => send('workspace:terminal', data));
  client.on('progress', data => send('workspace:progress', data));
  client.on('closed', () => { if (context.client === client) send('workspace:disconnected', '本地运行服务断开。输入不会自动重发，请保留当前草稿。'); });
}
function displayState(snapshot, context) { return roomState.apply(sessionLabels.apply(submissionState(snapshot))); }
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
    resolve?.();
  } catch (error) { reject?.(error); throw error; }
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
  backups(view);
  if (!views.includes(view)) views.push(view);
  view.active = true; saveViews();
  const client = await connect(dataDir, view.owner);
  if (quitting) { client.close(); return; }
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : createWindow(view);
  startupWindow = null;
  if (view.bounds) win.setBounds(view.bounds);
  const context = { win, client, view, failed: false };
  windows.set(win.webContents.id, context); bindClient(context);
  const ready = new Promise((resolve, reject) => { context.ready = resolve; context.readyTimer = setTimeout(() => reject(new Error('UI did not become ready')), 25000); });
  ready.catch(() => {}); // loadURL may fail before the readiness timer fires.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('page-title-updated', event => { event.preventDefault(); win.setTitle('Native Agent Workspace'); });
  win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const id = win.webContents.id;
  win.on('close', () => { view.bounds = win.getBounds(); if (!quitting && !context.failed) view.active = false; saveViews(); });
  win.on('closed', () => {
    // A renderer/webContents shutdown can bypass the cancellable close event.
    if (!quitting && !context.failed) { view.active = false; saveViews(); }
    windows.delete(id); context.client.close();
  });
  try { await win.loadURL(entry); await ready; }
  catch (error) { if (quitting || win.isDestroyed()) return; throw new Error(startupMessage(error)); }
  finally { clearTimeout(context.readyTimer); }
  return win;
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
  for (const view of views) { try { view.readingPositions = readingState(view.readingPositions || {}); } catch { view.readingPositions = {}; } }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).host !== new URL(dsh.origin).host }));
  if (!wired) {
  wired = true;
  for (const name of ['prepareInput', 'observe', 'unobserve', 'claim', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'pause', 'approve', 'retrySave']) register(name, (c, ...args) => {
    if (['prepareInput', 'claim', 'terminal', 'input', 'approve'].includes(name)) roomState.assertAvailable(args[0]);
    return c.client.call(name, ...args);
  });
  register('join', async (c, id, join) => {
    try { await roomState.membership(c.client, id, join, sessionLabels.labels.get(id)); }
    finally { await broadcastRoom(); }
  });
  register('roomRename', async (_c, name) => { roomState.rename(name); await broadcastRoom(); });
  register('roomNotes', async (_c, text, revision) => { roomState.notes(text, revision); await broadcastRoom(); });
  register('archiveSession', async (c, id) => { try { await roomState.archiveSession(c.client, id, sessionLabels.labels.get(id)); } finally { await broadcastRoom(); } });
  register('restoreSession', async (c, id) => {
    const state = await c.client.call('initial'); if (!state.sessions.some(s => s.id === id)) throw Error('原生会话记录不可用。');
    roomState.restoreSession(id); await broadcastRoom();
  });
  register('archiveRoom', async c => { try { await roomState.archiveRoom(c.client, sessionLabels.labels); } finally { await broadcastRoom(); } });
  register('restoreRoom', async c => { try { await roomState.restoreRoom(c.client, sessionLabels.labels); } finally { await broadcastRoom(); } });
  register('create', async (c, ...args) => { assertNativeCreation(await c.client.call('initial')); return c.client.call('create', ...args); });
  register('rename', async (c, id, name) => {
    const snapshot = await c.client.call('initial');
    if (!snapshot.sessions.some(s => s.id === id)) throw new Error('找不到这个会话，名称未更改。');
    const saved = sessionLabels.set(id, name);
    broadcastName(id, saved);
    return saved;
  });
  // The workspace router registers human/run intent before its first await and
  // applies the same capability gates for one or several retained services.
  const submit = (c, method, ...args) => {
    for (const id of (method === 'run' ? args[0] : [args[0]])) roomState.assertAvailable(id, method !== 'send');
    return c.client.call(method, ...args);
  };
  for (const method of ['run', 'forward']) register(method, (c, ...args) => submit(c, method, ...args));
  register('uiReady', c => c.ready?.());
  register('send', async (c, id, text) => {
    const draft = backups(c.view)[id];
    const result = await submit(c, 'send', id, text);
    // Every draft edit replaces this object, including retyping identical text.
    // A late acceptance must not clear a newer recovery copy.
    if (acceptSentDraft(c.view, id, draft, text)) saveViews();
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
  register('continueConnection', async (c, id) => {
    await c.client.refresh();
    const target = c.client.route(id), status = continuationStatus(target.state, id);
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
    const answer = await dialog.showMessageBox(c.win, {
      type: 'question', message: action === 'resume' ? '继续这个原生会话？' : '移除此应用中的会话记录？',
      detail: action === 'resume' ? resubscribe ? '重新连接同一个原生线程并同步记录；保留原来的设置，不发送新任务，也不自动继续协作。原生仍可能有后台工作。' : '使用原生历史继续，不重发旧任务。活动中的原生团队不会自动重建；若已在其他应用打开该会话，请先结束那里的连接。' : '移除本应用的会话副本和草稿。原生服务中的历史与共同工作中已分享的内容仍保留。',
      buttons: ['取消', action === 'resume' ? '继续会话' : '移除记录'], defaultId: 0, cancelId: 0,
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
  register('initial', async c => ({ ...displayState(await c.client.call('initial'), c), viewState: c.view, appVersion: app.getVersion(), preflight: preflight() }));
  register('readingState', (c, positions) => { c.view.readingPositions = readingState(positions); return saveReadingSoon(); });
  register('viewState', (c, next) => {
    if (!next || typeof next.selected !== 'string' || next.selected.length > 100 || !['chat', 'terminal'].includes(next.mode)) throw new Error('无效界面状态。');
    if (next.roomSession !== undefined && (typeof next.roomSession !== 'string' || next.roomSession.length > 100)) throw new Error('无效协作视图。');
    if (next.roomRecipient !== undefined && (typeof next.roomRecipient !== 'string' || next.roomRecipient.length > 100)) throw new Error('无效协作接收方。');
    if (next.roomFilter !== undefined && (typeof next.roomFilter !== 'string' || next.roomFilter.length > 100)) throw new Error('无效成员筛选。');
    if (next.roomSearch !== undefined && (typeof next.roomSearch !== 'string' || next.roomSearch.length > 1000)) throw new Error('搜索词过长。');
    if (next.sharedDraft !== undefined && (typeof next.sharedDraft !== 'string' || next.sharedDraft.length > 16000)) throw new Error('协作草稿过长。');
    if (next.terminalDisplay !== undefined && (!next.terminalDisplay || !Number.isInteger(next.terminalDisplay.fontSize) || next.terminalDisplay.fontSize < 10 || next.terminalDisplay.fontSize > 24 || !['dark', 'green'].includes(next.terminalDisplay.palette))) throw new Error('无效终端显示设置。');
    const positions = next.readingPositions === undefined ? undefined : readingState(next.readingPositions);
    Object.assign(c.view, { selected: next.selected, mode: next.mode, preference: ['chat', 'terminal'].includes(next.preference) ? next.preference : c.view.preference });
    if (positions !== undefined) c.view.readingPositions = positions;
    if (next.sharedDraft !== undefined) c.view.sharedDraft = next.sharedDraft;
    if (next.roomSession !== undefined) c.view.roomSession = next.roomSession;
    if (next.roomRecipient !== undefined) c.view.roomRecipient = next.roomRecipient;
    if (next.roomFilter !== undefined) c.view.roomFilter = next.roomFilter;
    if (next.roomSearch !== undefined) c.view.roomSearch = next.roomSearch;
    if (next.terminalDisplay !== undefined) c.view.terminalDisplay = { fontSize: next.terminalDisplay.fontSize, palette: next.terminalDisplay.palette };
    saveViews();
  });
  register('chooseFolder', async c => { const result = await dialog.showOpenDialog(c.win, { title: '选择这个会话可以工作的目录', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  register('newWindow', async (c, id) => { const snapshot = await c.client.call('initial'); if (id && !snapshot.sessions.some(s => s.id === id)) throw new Error('找不到会话。'); await openWindow({ owner: randomUUID(), selected: id || '', mode: c.view.mode, preference: c.view.preference, active: true }); });
  register('copy', (_c, text) => { if (typeof text !== 'string' || text.length > 100000) throw new Error('复制内容无效。'); return clipboard.writeText(text); });
  // Read only when the person presses Paste; never watch or persist clipboard content.
  register('pasteText', async () => { const text = await clipboard.readText(); if (text.length > 65500) throw new Error('粘贴内容过长，请分段粘贴。'); return text; });
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
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : windows.values().next().value?.win;
  if (win) { if (!backgroundTest) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
  else if (!starting && !quitting) { if (dsh && wired) openWindow(views.at(-1)).catch(() => start()); else start(); }
}
app.on('activate', focusOrOpen);
app.on('second-instance', focusOrOpen);
if (primary) app.whenReady().then(start);
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; try { if (viewStore?.loaded) saveViews(); } finally { dsh?.stop(); } });
// Deliberately no native shutdown here: GUI lifecycle is independent of sessions.
