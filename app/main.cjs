const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureService, connect } = require('./service-client.cjs');
const { startDsh } = require('./dsh-host.cjs');
const { startupMessage } = require('./ui-errors.cjs');

app.setName('Native Agent Workspace');
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
let dataDir, views = [], quitting = false;

function saveViews() {
  const target = path.join(dataDir, 'views.json');
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(views), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
}
async function openWindow(saved) {
  if (quitting) return;
  const view = saved || { owner: randomUUID(), selected: '', mode: 'chat', preference: 'chat', active: true };
  if (!views.includes(view)) views.push(view);
  view.active = true; saveViews();
  const client = await connect(dataDir, view.owner);
  if (quitting) { client.close(); return; }
  const win = new BrowserWindow({ title: 'Native Agent Workspace', width: 1240, height: 850, ...view.bounds, minWidth: 850, minHeight: 600, backgroundColor: '#f8f8f5', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  const send = (channel, data) => { if (!win.isDestroyed()) win.webContents.send(channel, data); };
  windows.set(win.webContents.id, { win, client, view });
  client.on('state', data => send('workspace:state', data));
  client.on('terminal', data => send('workspace:terminal', data));
  client.on('closed', () => send('workspace:disconnected', '本地运行服务断开。输入不会自动重发，请保留当前草稿。'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('page-title-updated', event => { event.preventDefault(); win.setTitle('Native Agent Workspace'); });
  win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const id = win.webContents.id;
  win.on('close', () => { view.bounds = win.getBounds(); if (!quitting) view.active = false; saveViews(); });
  win.on('closed', () => {
    // A renderer/webContents shutdown can bypass the cancellable close event.
    if (!quitting) { view.active = false; saveViews(); }
    windows.delete(id); client.close();
  });
  try { await win.loadURL(entry); }
  catch (error) { if (quitting || win.isDestroyed()) return; throw new Error(startupMessage(error)); }
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
  await ensureService(dataDir, process.execPath);
  dsh = await startDsh(dataDir); entry = dsh.url;
  try { views = JSON.parse(fs.readFileSync(path.join(dataDir, 'views.json'), 'utf8')); if (!Array.isArray(views)) views = []; } catch { views = []; }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).host !== new URL(dsh.origin).host }));
  for (const name of ['create', 'join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'run', 'pause', 'forward', 'approve']) register(name, (c, ...args) => c.client.call(name, ...args));
  register('stop', async (c, id) => { const answer = await dialog.showMessageBox(c.win, { type: 'warning', message: '结束这个原生会话？', detail: '这会停止本应用托管的该会话。只关闭窗口或脱出协作不会结束它。原生后台团队的状态仍需在原生界面确认。', buttons: ['保留会话', '结束会话'], defaultId: 0, cancelId: 0 }); if (answer.response === 1) return c.client.call('stop', id); });
  register('openExternal', (_c, href) => { const url = new URL(href); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接类型不支持。'); return shell.openExternal(url.href); });
  register('initial', async c => ({ ...await c.client.call('initial'), viewState: c.view }));
  register('viewState', (c, next) => {
    if (!next || typeof next.selected !== 'string' || next.selected.length > 100 || !['chat', 'terminal'].includes(next.mode)) throw new Error('无效界面状态。');
    Object.assign(c.view, { selected: next.selected, mode: next.mode, preference: ['chat', 'terminal'].includes(next.preference) ? next.preference : c.view.preference }); saveViews();
  });
  register('chooseFolder', async c => { const result = await dialog.showOpenDialog(c.win, { title: '选择这个会话可以工作的目录', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  register('newWindow', async (c, id) => { const snapshot = await c.client.call('initial'); if (id && !snapshot.sessions.some(s => s.id === id)) throw new Error('找不到会话。'); await openWindow({ owner: randomUUID(), selected: id || '', mode: c.view.mode, preference: c.view.preference, active: true }); });
  register('copy', (_c, text) => { if (typeof text !== 'string' || text.length > 100000) throw new Error('复制内容无效。'); clipboard.writeText(text); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: '退出界面（会话继续运行）', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { label: '文件', submenu: [{ label: '新窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => openWindow() }, { label: '新会话', accelerator: 'CmdOrCtrl+N', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('workspace:new') }, { role: 'close' }] },
    { role: 'editMenu' }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
  ]));
  const restore = views.filter(v => v.active);
  if (restore.length) for (const view of restore) await openWindow(view);
  else await openWindow(views.at(-1));
  if (quitting) return;
  app.on('activate', () => { if (!windows.size) openWindow(views.at(-1)); });
  app.on('second-instance', () => { const c = windows.values().next().value; if (c) { c.win.show(); c.win.focus(); } else openWindow(views.at(-1)); });
}
if (primary) app.whenReady().then(boot).catch(error => { if (quitting) return; dsh?.stop(); dialog.showErrorBox('未能启动', startupMessage(error)); app.exit(1); });
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; try { if (dataDir) saveViews(); } finally { dsh?.stop(); } });
// Deliberately no native shutdown here: GUI lifecycle is independent of sessions.
