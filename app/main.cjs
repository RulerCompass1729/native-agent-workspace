const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureService, connect } = require('./service-client.cjs');
const { startDsh } = require('./dsh-host.cjs');
const { startupMessage } = require('./ui-errors.cjs');
const { preflight } = require('./preflight.cjs');
const { pathToFileURL } = require('node:url');
const { submissionState, assertNativeCreation, capabilitiesFor } = require('./submission-policy.cjs');
const { SessionLabels } = require('./session-labels.cjs');

app.setName('Native Agent Workspace');
process.env.NAW_APP_VERSION = app.getVersion();
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync']) app.commandLine.appendSwitch(flag);
if (process.env.NAW_DATA_DIR) app.setPath('userData', path.resolve(process.env.NAW_DATA_DIR));
// Headed test runs belong to their launcher, not to a forgotten background job.
// This is opt-in for the test command; normal desktop sessions have no parent lease.
const testParent = Number(process.env.NAW_TEST_PARENT_PID);
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
let dataDir, sessionLabels, views = [], quitting = false;
let startupWindow, starting = false, wired = false;
const startupFile = path.join(__dirname, 'startup.html');
function windowOptions(view = {}) { return { title: 'Native Agent Workspace', width: 1240, height: 850, ...view.bounds, minWidth: 850, minHeight: 600, backgroundColor: '#f8f8f5', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } }; }
function bindClient(context) {
  const { win, client } = context;
  const send = (channel, data) => { if (!win.isDestroyed()) win.webContents.send(channel, data); };
  client.on('state', data => send('workspace:state', displayState(data, context)));
  client.on('terminal', data => send('workspace:terminal', data));
  client.on('closed', () => { if (context.client === client) send('workspace:disconnected', '本地运行服务断开。输入不会自动重发，请保留当前草稿。'); });
}
function displayState(snapshot, context) { return sessionLabels.apply(submissionState(snapshot, context.structuredSubmit)); }
function broadcastName(id, name) {
  for (const context of windows.values()) if (!context.win.isDestroyed()) context.win.webContents.send('workspace:session-name', { id, name });
}

function saveViews() {
  const target = path.join(dataDir, 'views.json');
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(views), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
}
async function openWindow(saved) {
  if (quitting) return;
  const view = saved || { owner: randomUUID(), selected: '', mode: 'terminal', preference: 'terminal', active: true };
  if (!views.includes(view)) views.push(view);
  view.active = true; saveViews();
  const client = await connect(dataDir, view.owner);
  if (quitting) { client.close(); return; }
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : new BrowserWindow(windowOptions(view));
  startupWindow = null;
  if (view.bounds) win.setBounds(view.bounds);
  const context = { win, client, view, failed: false, structuredSubmit: (await client.call('initial')).capabilities?.includes('structuredClaudeSubmit') === true };
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
  await ensureService(dataDir, process.execPath);
  if (quitting) return;
  dsh = await startDsh(dataDir); entry = dsh.url;
  if (quitting) { dsh.stop(); return; }
  try { views = JSON.parse(fs.readFileSync(path.join(dataDir, 'views.json'), 'utf8')); if (!Array.isArray(views)) views = []; } catch { views = []; }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).host !== new URL(dsh.origin).host }));
  if (!wired) {
  wired = true;
  for (const name of ['join', 'claim', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'pause', 'approve']) register(name, (c, ...args) => c.client.call(name, ...args));
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
  const submit = (c, method, ...args) => c.client.call(method, ...args);
  for (const method of ['run', 'forward']) register(method, (c, ...args) => submit(c, method, ...args));
  register('uiReady', c => c.ready?.());
  register('send', async (c, id, text) => { const result = await submit(c, 'send', id, text); if (c.view.draft?.id === id && c.view.draft.text.trim() === text.trim()) { c.view.draft.text = ''; saveViews(); } return result; });
  register('preflight', () => preflight());
  register('dataDirectory', () => shell.openPath(dataDir));
  register('quitService', async c => { await c.client.call('shutdown'); app.quit(); });
  register('clearSharedHistory', async c => {
    const answer = await dialog.showMessageBox(c.win, { type: 'warning', message: '清除共同工作记录？', detail: '清除本应用里的共享记录，并停止尚未完成的分享回写。不会删除各个会话、原生历史或撤回其他 agent 已收到的内容。正在执行的原生任务不会因此取消。', buttons: ['取消', '清除共享记录'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) return c.client.call('clearSharedHistory');
  });
  register('draft', async (c, id, text) => {
    if (typeof text !== 'string' || text.length > 16000) throw new Error('草稿过长。');
    c.view.draft = { id, text }; saveViews();
    await c.client.call('draft', id, text);
  });
  register('reconnect', async c => {
    await ensureService(dataDir, process.execPath);
    const client = await connect(dataDir, c.view.owner), old = c.client;
    c.structuredSubmit = (await client.call('initial')).capabilities?.includes('structuredClaudeSubmit') === true;
    c.client = client; bindClient(c); old.close(); await c.win.reload();
  });
  for (const action of ['resume', 'forget']) register(action, async (c, id) => {
    const snapshot = await c.client.call('initial');
    if (action === 'resume') assertNativeCreation(snapshot, id);
    if (!capabilitiesFor(snapshot, id).includes(action)) throw new Error('这个会话的后台暂不支持此操作；原生会话已保留。');
    const answer = await dialog.showMessageBox(c.win, {
      type: 'question', message: action === 'resume' ? '继续这个原生会话？' : '移除此应用中的会话记录？',
      detail: action === 'resume' ? '使用原生历史继续，不重发旧任务。活动中的原生团队不会自动重建；若已在其他应用打开该会话，请先结束那里的连接。' : '移除本应用的会话副本和草稿。原生服务中的历史与共同工作中已分享的内容仍保留。',
      buttons: ['取消', action === 'resume' ? '继续会话' : '移除记录'], defaultId: 0, cancelId: 0,
    });
    if (answer.response === 1) {
      await c.client.call(action, id);
      if (action === 'forget') {
        for (const view of views) { if (view.draft?.id === id) delete view.draft; if (view.selected === id) view.selected = ''; }
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
  register('viewState', (c, next) => {
    if (!next || typeof next.selected !== 'string' || next.selected.length > 100 || !['chat', 'terminal'].includes(next.mode)) throw new Error('无效界面状态。');
    if (next.roomSession !== undefined && (typeof next.roomSession !== 'string' || next.roomSession.length > 100)) throw new Error('无效协作视图。');
    if (next.sharedDraft !== undefined && (typeof next.sharedDraft !== 'string' || next.sharedDraft.length > 16000)) throw new Error('协作草稿过长。');
    if (next.terminalDisplay !== undefined && (!next.terminalDisplay || !Number.isInteger(next.terminalDisplay.fontSize) || next.terminalDisplay.fontSize < 10 || next.terminalDisplay.fontSize > 24 || !['dark', 'green'].includes(next.terminalDisplay.palette))) throw new Error('无效终端显示设置。');
    Object.assign(c.view, { selected: next.selected, mode: next.mode, preference: ['chat', 'terminal'].includes(next.preference) ? next.preference : c.view.preference });
    if (next.sharedDraft !== undefined) c.view.sharedDraft = next.sharedDraft;
    if (next.roomSession !== undefined) c.view.roomSession = next.roomSession;
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
  if (!startupWindow || startupWindow.isDestroyed()) { startupWindow = new BrowserWindow(windowOptions()); await startupWindow.loadFile(startupFile); }
  startupWindow.webContents.send('workspace:startup', { title: '正在打开你的工作空间', detail: '连接本机服务，恢复上次的界面…', retry: false });
  try { await boot(); }
  catch (error) {
    dsh?.stop();
    for (const c of [...windows.values()]) { c.failed = true; c.client.close(); c.win.destroy(); }
    if (!quitting && (!startupWindow || startupWindow.isDestroyed())) {
      startupWindow = new BrowserWindow(windowOptions()); await startupWindow.loadFile(startupFile);
    }
    if (!quitting && startupWindow && !startupWindow.isDestroyed()) startupWindow.webContents.send('workspace:startup', { title: '暂时未能打开', detail: startupMessage(error), retry: true });
  } finally { starting = false; }
}
ipcMain.handle('workspace:retry-startup', event => { if (startupWindow?.webContents === event.sender && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(startupFile).href) return start(); });
function focusOrOpen() {
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : windows.values().next().value?.win;
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  else if (!starting && !quitting) { if (dsh && wired) openWindow(views.at(-1)).catch(() => start()); else start(); }
}
app.on('activate', focusOrOpen);
app.on('second-instance', focusOrOpen);
if (primary) app.whenReady().then(start);
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; try { if (dataDir) saveViews(); } finally { dsh?.stop(); } });
// Deliberately no native shutdown here: GUI lifecycle is independent of sessions.
